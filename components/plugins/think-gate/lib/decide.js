// 思考分级的判据表（纯函数，无副作用、无随机）—— 可离线单测
//
// ── 它决定什么 ────────────────────────────────────────────────────────────
// 「这一轮要不要让模型思考」。判据**只往保守方向错**：任何一条不满足就照常思考。
// 理由是思考在这里的收益与代价不对等：
//   · 想对了 —— 一句"嗯"、"哈哈"、"在吗"本来也不需要推理；
//   · 想错了（该想的时候没想）—— 判断、任务、冲突类消息会被答得很浅，那种损失比省下的 token 大得多。
//
// ── 为什么不掷骰子 ────────────────────────────────────────────────────────
// 同样的消息必须永远得到同样的判定，否则"今天这条回得好、明天同样的问法回得敷衍"
// 完全无法复现，也没法写回归用例。
//
// ── v1.1.0 修复（2026-10-27）：适配 buildUserPrompt 与多插件尾部追加 ─────
//   旧版 pickLatestText 直接取最后一条 user 消息的最后一行（lines[lines.length - 1]），
//   而真实运行中：
//     1) prompt.js 的 buildUserPrompt 拼装顺序是：
//        【过去状态】→【本次唤醒】→【此刻状态】→【当前时间】2026-10-27 16:20
//        最后一行永远是【当前时间】（必含数字）或插件追加的【当下状态】/【好感】等；
//     2) mind-wish 插件会往 messages 末尾 push 一条独立的 `{ role: 'user', content: '【心里偶尔浮起来的小事】…' }`；
//     3) buildTriggerBlock 会给每条唤醒行末尾挂上 `（@我/提到我/提问）` 标签，
//        展平的 @ 会带 `@昵称(QQ:123456)`；
//     4) 【引导说明】正文里也出现了「扫一眼【过去状态】和【本次唤醒】」字样，
//        因此定位【本次唤醒】段落时必须匹配**独立成行的段落头** `^【本次唤醒】\r?\n`。
//   结果：旧版在真实环境下近乎 100% 拿到【当前时间】或【心里偶尔浮起来的小事】，
//   因含数字或超长而恒定判为 skip: false（整件插件形同空转）。
//   新版修复：
//     · 逆序扫描所有 user 消息，用行首锚点定位真正的 `\n【本次唤醒】\n` 段落；
//     · 若某条 user 消息是插件单独 push 的状态块（无 `【本次唤醒】` 且以 `【` 开头），继续往前找真正的唤醒消息；
//     · 剥除行首 `[MM-DD HH:mm] #消息id 昵称(QQ:123456)：`、剥除行内 `@昵称(QQ:123456)`、
//       剥除行尾系统追加的 `（@我/提到我/提问/拍我/引用…）` 触发标签；
//     · 多条触发消息合并判定，确保没有任何一条包含疑问/任务/冲突/数字时才免思考。

/** 疑问标记：出现任一就照常思考 */
export const QUESTION_RE = /[?？]|吗|呢|是不是|能不能|可不可以|有没有|要不要|该不该|值不值|怎么|为什么|为啥|如何|哪|谁|多少|几点|多久/;

/** 任务词：要动手的事，照常思考 */
export const TASK_RE = /帮|查|算|翻译|写|总结|对比|分析|计划|做个|生成|整理|列出|找一下|改|发我|发一版|准备|安排|联系|问问|建|装|修/;

/** 判断词：要给观点，照常思考 */
export const JUDGE_RE = /你觉得|你认为|你的看法|建议|怎么办|行不行|好不好|对不对|靠谱吗|值得吗|你会选/;

/** 异议/冲突：气氛可能紧张，最需要判断力，一律照常思考 */
export const CONFLICT_RE = /不同意|反对|不对吧|你说什么|再说一遍|过分|吵|生气|翻脸|别这样|怎么回事|凭什么/;

/** 媒体与引用消息：要看内容或判断情绪/上下文，照常思考（表情包也算——那是情绪反应） */
export const MEDIA_RE = /\[图片\]|\[视频\]|\[文件\]|\[语音\]|\[动画表情\]|\[表情\]|\[回复\]|\[引用[\s\S]*?\]/;

/** 圈号 / 编号：可能是列表项或选项，照常思考 */
const CIRCLED_RE = /[\u2460-\u24FF\u3251-\u325F\u32B1-\u32BF]/;

/**
 * buildTriggerBlock 在行尾附加的触发标签（见 src/prompt.js triggerLabels）：
 * 如 `（@我）`、`（@我/提到我/提问）`、`（提到我（备注名）/提问）`、`（拍我）`。
 */
const TRIGGER_LABEL_TAIL_RE = /（(?:@我|提到我（备注名）|提到我|提问|引用|拍我|拍一拍)(?:\/(?:@我|提到我（备注名）|提到我|提问|引用|拍我|拍一拍))*）\s*$/;

/**
 * 清洗单行聊天记录，还原群友实际打出的那句话。
 *
 * 输入示例：
 *   `[10-23 13:52] #1042 某位群友(QQ:123456789)：@小鲸鱼(QQ:987654321) 在吗（@我/提到我/提问）`
 *   `[+2m] 群友A：哈哈（提到我）`
 * 还原结果：
 *   `在吗` / `哈哈`
 *
 * @param {string} rawLine
 * @returns {string}
 */
export function cleanTriggerLine(rawLine) {
  let line = String(rawLine || '').trim();
  if (!line) return '';

  // 1. 剥除行首时间戳 `[10-23 13:52]` 或相对时间 `[+6m]`、`[+0]`
  if (/^\[[^\]]{1,24}\]\s*/.test(line)) {
    line = line.replace(/^\[[^\]]{1,24}\]\s*/, '');
    // 2. 剥除可选的 `#消息id `
    line = line.replace(/^#\S+\s+/, '');
    // 3. 剥除发言人前缀 `昵称(QQ:123456)：`（昵称本身可能含冒号，但绝不含 `(QQ:`）或短发言人 `昵称：`
    const qqSpeakerMatch = line.match(/^(?:(?!\(QQ:\d+\))[^\n]){1,60}\(QQ:\d+\)\s*[：:]\s*/);
    if (qqSpeakerMatch) {
      line = line.slice(qqSpeakerMatch[0].length);
    } else {
      const colonIdx = line.search(/[：:]/);
      if (colonIdx >= 0 && colonIdx <= 60) {
        line = line.slice(colonIdx + 1).trimStart();
      }
    }
  } else {
    // 兼容离线单测格式（未带行首 [时间戳]，但带 `昵称(QQ:123)：正文` 或 `昵称：正文`）
    const qqSpeakerMatch = line.match(/^(?:(?!\(QQ:\d+\))[^\n]){1,60}\(QQ:\d+\)\s*[：:]\s*/);
    if (qqSpeakerMatch) {
      line = line.slice(qqSpeakerMatch[0].length);
    } else {
      const cut = Math.max(line.lastIndexOf('：'), line.lastIndexOf(':'));
      if (cut >= 0 && cut < line.length - 1 && cut <= 60) {
        line = line.slice(cut + 1).trimStart();
      }
    }
  }

  // 4. 剥除 buildTriggerBlock 追加在行尾的触发标签 `（@我/提到我…）`
  line = line.replace(TRIGGER_LABEL_TAIL_RE, '').trim();

  // 5. 剥除消息体内的艾特标记（避免 `@昵称(QQ:123456)` 或 `[CQ:at,qq=123]` 的数字污染数字判据）
  //    注意：保留 `[引用 …]` 与 `[图片]` 等方括号标记，让后续 MEDIA_RE 正常拦截！
  line = line
    .replace(/\[CQ:at,[^\]]*\]/g, ' ')
    .replace(/@[^\s@]{1,40}\(QQ:\d+\)/g, ' ')
    .replace(/^@\S+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return line;
}

/**
 * 从单条 user 消息文本中提取独立段落 `【本次唤醒】` 的触发文本。
 * 若该消息不含独立成行的 `【本次唤醒】` 段落头，返回 null。
 *
 * @param {string} fullText
 * @returns {string|null}
 */
export function extractWakeBlock(fullText) {
  const s = String(fullText || '');
  // 必须匹配独立成行的 `【本次唤醒】`（避免误中【引导说明】里的「扫一眼【过去状态】和【本次唤醒】」）
  const headerMatch = s.match(/(?:^|\r?\n)【本次唤醒】[ \t]*\r?\n/);
  if (!headerMatch) return null;

  const afterMarker = s.slice(headerMatch.index + headerMatch[0].length);
  // 下一个顶层段落总是以换行后的 `【` 开头（如【此刻状态】【活跃模式】【当前时间】【当下状态】）
  const nextSecMatch = afterMarker.match(/\r?\n[ \t]*【/);
  const wakeRaw = nextSecMatch
    ? afterMarker.slice(0, nextSecMatch.index)
    : afterMarker;

  const cleanedLines = wakeRaw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('【'))
    .map(cleanTriggerLine)
    .filter(Boolean);

  return cleanedLines.join('\n').trim();
}

/**
 * 从 messages 里取"这一轮真正要看的那句话"。
 *
 * 查找优先级：
 *   ① 逆序遍历所有 `role === 'user'` 消息，找包含 `【本次唤醒】` 的那条（跳过 mind-wish 等插件
 *      单独 push 在末尾的 `【心里偶尔浮起来的小事】` 消息），提取并清洗 `【本次唤醒】` 段内所有触发行；
 *   ② 若整组 messages 都不含 `【本次唤醒】`（如离线单元测试、或裸消息调用），
 *      回退取最后一条非插件注入块（不以 `【` 开头）的 user 消息最后一行并做同等清洗。
 *
 * @param {Array} messages
 * @returns {string}
 */
export function pickLatestText(messages) {
  if (!Array.isArray(messages)) return '';

  const userTexts = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      text = c.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join('\n');
    }
    if (text && text.trim()) userTexts.push(text.trim());
  }

  if (!userTexts.length) return '';

  // ① 标准路径：从含【本次唤醒】的 user 消息里精确提取
  for (const t of userTexts) {
    const wake = extractWakeBlock(t);
    if (wake !== null) return wake;
  }

  // ② 兜底路径（离线单测或未走 buildUserPrompt 的裸消息）：
  //    跳过纯系统状态注入块（整段以 `【xxx】` 开头且无聊天行），取最后一行清洗
  for (const t of userTexts) {
    const lines = t
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('【') && !s.startsWith('· ') && !s.startsWith('（'));
    if (!lines.length) continue;
    return cleanTriggerLine(lines[lines.length - 1]);
  }

  return '';
}

/**
 * 判定：这一轮要不要免思考。
 * @param {object} body 请求体（读 .messages）
 * @param {object} cfg  { maxChars, extraKeepWords }
 * @returns {{skip:boolean, why:string, text:string}}
 */
export function decide(body, cfg = {}) {
  const text = pickLatestText(body && body.messages);
  if (!text) return { skip: false, why: '取不到消息正文', text: '' };

  const maxChars = Number(cfg.maxChars) > 0 ? Number(cfg.maxChars) : 24;
  const keepWords = String(cfg.extraKeepWords || '')
    .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

  if (MEDIA_RE.test(text)) return { skip: false, why: '含媒体或引用（要看内容/判断情绪）', text };
  if (text.length > maxChars) return { skip: false, why: `太长(${text.length}>${maxChars})`, text };
  if (QUESTION_RE.test(text)) return { skip: false, why: '有疑问标记', text };
  if (TASK_RE.test(text)) return { skip: false, why: '有任务词', text };
  if (JUDGE_RE.test(text)) return { skip: false, why: '有判断词', text };
  if (CONFLICT_RE.test(text)) return { skip: false, why: '有异议/冲突词', text };
  if (/[0-9０-９]/.test(text)) return { skip: false, why: '含数字', text };
  if (CIRCLED_RE.test(text)) return { skip: false, why: '含编号', text };
  if (keepWords.some((w) => text.includes(w))) return { skip: false, why: '命中额外必须思考的词', text };
  // 纯符号/纯表情：没有实义，思不思考都一样 —— 但**免思考**也没意义（不会有输出差异），
  // 所以照常思考，避免"表情包回得更敷衍"这种体感变化
  if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) return { skip: false, why: '无文字内容', text };

  return { skip: true, why: `短句、无提问、无任务(${text.length}字)`, text };
}

/** 供探针使用 */
export const internals = { pickLatestText, cleanTriggerLine, extractWakeBlock, decide };
