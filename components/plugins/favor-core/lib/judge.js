// 好感度「兜底判定」：回合结束后，用一次极小调用问清「这几轮谁对它做了什么」。
//
// 移植自 `_legacy-features-backup-20260920/legacy-src-20260917/favor-judge.js`（365 行），
// 以及老 orchestrator 的判定门 `orchestrator.js:548-604` / 老 prompt 的信号收集
// `prompt.js:1409-1497`。逐段对应：
//   extractJudgeText      favor-judge.js:50-56    **两种返回形状都要认**
//   favorJudgeConfig      favor-judge.js:59-83    maxTokens 自愈（400/1200 → 2400）
//   buildJudgeMessages    favor-judge.js:90-162
//   parseJudgeOutput      favor-judge.js:174-206  容错：整段 parse → 逐个抠对象
//   runFavorJudge         favor-judge.js:220-365  记账 / judge_clean / judge_error
//   collectJudgmentSignals prompt.js:1409-1482    廉价信号门（与提醒同源）
//
// ── 为什么要有这一层（不是重复劳动）──────────────────────────────────────
// 主路径是「模型聊天时顺手调 memory_impression」，但实测这条路太软：本机 58 次真实
// 运行里 memory_impression 零调用（不报错、就是没想起来）。所以补一层确定性的：
// 运行结束后把最近的聊天记录丢给模型问一个问题。它**只负责攒条目**，加/减分仍然
// 由门槛机制管（攒够 3 条才结算、单次 ±2/±3、净 0 不动分）—— 兜底不绕过「慎重」。
//
// ── 成本护栏（实测数字）──────────────────────────────────────────────────
// 判定最初每轮都跑：6 小时 60 次调用里 52 次判完全 neutral（87% 白跑）。
// 所以判定门（hasJudgmentSignal）不是可省的优化，它是这套东西能不能长期开着的关键。
import { audit } from './audit.js';
import { readSetting } from './rules.js';

/** 判定模块的运行状态（给 UI/诊断看，也用于「每个会话只跑一个」）。 */
const running = new Set();
/** 档案键 → 上次判定时间（冷却用，进程内即可：重启后重新计也无害）。 */
const lastJudgedAt = new Map();
/** 会话 → 上次判定时间（同一个会话的判定节奏，防同一批消息被反复问）。 */
const lastChatJudgeAt = new Map();

export const FAVOR_JUDGE_DEFAULTS = {
  enabled: true,                 // 默认开：纯提示词路径已被实测证明不够
  minSignal: 'smart',            // smart = 先过廉价信号门 / always = 每轮都判 / never = 从不
  everyN: 1,                     // 每几次运行判定一次（1 = 每次都判）
  windowMessages: 24,            // 取最近多少条聊天记录作为证据
  cooldownMs: 3 * 60 * 1000,     // 同一个人的两次判定至少隔这么久
  minMessages: 4,                // 窗口里少于这么多条就不问了（没证据，白花钱）
  // ⚠️ 输出上限必须给足：判定模型会先想一段（reasoning_content），
  //    实测 400 会被思考吃光、1200 在多候选人+长消息时也会截断（JSON 尾部丢人）。
  //    这是**上限不是花费**，模型答完就停。
  maxTokens: 2400,
  timeoutMs: 45000
};

/**
 * 读当前生效的判定配置（设置对象进、钳制后的配置对象出）。
 *
 * ⚠️ 自愈：老 config.json 里写死过 maxTokens:400 / 1200（都是在改默认值之前落的盘），
 *    而深合并不覆盖已存在的键 —— 于是「改了默认值却不生效」。实测后果：
 *    判定模型先想一段、JSON 尾部被截断，整批判定全废（400 全废、1200 丢人）。
 *    这里把这两个历史坏值顶到当前默认；用户真要更小可以手动填别的数字。
 *    老 config.js(1200) 与 favor-judge.js(2400) 两个默认值互相矛盾 —— 本移植统一 2400。
 */
export function judgeConfig(settings = {}) {
  const raw = settings || {};
  const n = (path, d, flat) => {
    const v = readSetting(raw, path, flat);
    return Number.isFinite(Number(v)) ? Number(v) : d;
  };
  const LEGACY_BAD_TOKENS = [400, 1200];
  const rawMax = Number(readSetting(raw, 'judge.maxTokens', 'judgeMaxTokens'));
  const maxTokens = LEGACY_BAD_TOKENS.includes(rawMax)
    ? FAVOR_JUDGE_DEFAULTS.maxTokens
    : Math.max(64, Math.round(Number.isFinite(rawMax) ? rawMax : FAVOR_JUDGE_DEFAULTS.maxTokens));
  const signal = String(readSetting(raw, 'judge.minSignal', 'judgeMinSignal') || FAVOR_JUDGE_DEFAULTS.minSignal);
  return {
    enabled: readSetting(raw, 'judge.enabled', 'judgeEnabled') !== false,
    minSignal: ['smart', 'always', 'never'].includes(signal) ? signal : FAVOR_JUDGE_DEFAULTS.minSignal,
    everyN: Math.max(1, Math.round(n('judge.everyN', FAVOR_JUDGE_DEFAULTS.everyN, 'judgeEveryN'))),
    windowMessages: Math.max(4, Math.round(n('judge.windowMessages', FAVOR_JUDGE_DEFAULTS.windowMessages, 'judgeWindowMessages'))),
    cooldownMs: Math.max(0, n('judge.cooldownMs', FAVOR_JUDGE_DEFAULTS.cooldownMs, 'judgeCooldownMs')),
    minMessages: Math.max(2, Math.round(n('judge.minMessages', FAVOR_JUDGE_DEFAULTS.minMessages, 'judgeMinMessages'))),
    maxTokens,
    timeoutMs: Math.max(5000, n('judge.timeoutMs', FAVOR_JUDGE_DEFAULTS.timeoutMs, 'judgeTimeoutMs'))
  };
}

export function judgeStats() {
  return { running: [...running], cooling: lastJudgedAt.size, chats: lastChatJudgeAt.size };
}

/** 测试/排障用：清掉进程内冷却与运行标记。 */
export function resetJudgeState() {
  running.clear();
  lastJudgedAt.clear();
  lastChatJudgeAt.clear();
}

/**
 * 把 chat() 的返回统一取成「模型正文」。
 *
 * ⚠️ 这里踩过一次坑：chatCompletion 返回的是**信封对象**
 *    `{ message: { content, reasoning_content }, finishReason, … }`，
 *    早先只按 `res.content` 取，拿到 undefined → 解析出空数组
 *    → 每轮「判定跑了但一条都没记」，而外面完全看不出来。
 *    现在把两种形状（纯字符串 / 信封）都认，并把截断显式暴露出来。
 */
export function extractJudgeText(res) {
  if (res === null || res === undefined) return { text: '', truncated: false };
  if (typeof res === 'string') return { text: res, truncated: false };
  const msg = res.message && typeof res.message === 'object' ? res.message : res;
  const text = String(msg.content ?? res.content ?? '');
  return { text, truncated: String(res.finishReason || '') === 'length' };
}

/** 判定提示词：只问一件事（谁对它做了什么），要求严格 JSON。 */
export function buildJudgeMessages({ lines, targets }) {
  return [
    {
      role: 'system',
      content: [
        '你在帮一个 QQ 群聊机器人回顾「刚才这几轮，群友是怎么对待它的」。',
        '只做判断，不要客套、不要解释你的思路。',
        '对每个候选群友给一个结论：',
        '  positive = 明显对它好。两种都算：',
        '    ① 认可类：认真夸它、帮它说话、维护它、真心谢它、把事情交给它并认可结果；',
        '    ② 情绪类：对它有真感情或亲近感 —— 示好、撒娇、说喜欢/爱、亲亲抱抱贴贴、',
        '       温情的玩笑（例如「爱你的眼神」「mua」「想你了」「就喜欢你这嘴硬」）。',
        '       这类不需要是「夸奖」，只要那一刻它是被善待、被喜欢着的，就记 positive。',
        '    ③ **它被说的时候，谁帮它解释了 / 替它说话 / 点破别人是在骂它** → positive。',
        '       例：「主动提醒我『睡大觉在骂你』、帮我解读他话里的意思」→ 那是站它这边 → positive。',
        '       ⚠️ 别把它判成 negative：这类话里可能出现骂人词，但**骂的不是它**（是别人在骂它、他在告诉它）。',
        '    ④ **互怼之后收一句认可**（「对联打得可以啊」）→ positive，',
        '       不要因为「这一整段在打闹」就压成 neutral —— 看的是**最后那句是不是认可**；',
        '       但「一起玩梗、没有认可」的仍是 neutral。',
        '    ⑤ **把「你和我」的关系往近了说** → positive：说在养你 / 修你 / 给你花钱 / 舍不得你',
        '       （例：「没啥好玩的，基本都在花钱养你，修你了」）。',
        '       ⚠️ **别要求它自己承认** —— 它嘴硬回「养我 你养得起吗」是它在接话，不代表这句话不算好；',
        '       判断看的是**说话人有没有把关系说近**。',
        '    ⑥ **亲昵示好**：叫它宝宝/可爱、说喜欢它、撒娇要它陪 → positive（别压成 neutral）。',
        '  negative = 明显对它不好 —— 只在「他确实表达了对它的负面态度」时给：',
        '             反复拿它的弱点或身份嘲讽、阴阳它、骂它蠢/废/垃圾、把它当工具人使唤还挑刺、嫌它不理人、骗它耍它。',
        '  neutral  = 只是普通聊天、玩笑互怼、群里的梗、使唤催促、一次性小摩擦 —— 这些都不算',
        '',
        '【negative 的门槛：单次嘴欠不算，「说了还来 / 反复」才算】（2026-09-19 两轮人工标注定的口径）',
        '  ① **单次的重话、嘴欠，哪怕带难听的字，也先按 neutral 处理**：',
        '    · 「和你说了嘛闭嘴」（它插话时被逐一句，随后照样聊）→ neutral；',
        '    · 「没来由当众@我让我闭嘴」（光这一句、没有后续）→ neutral；',
        '    · 「被误导后骂它像个傻子」（一次骂完就走，之后没再针对）→ neutral；',
        '    · 「你怎么这么没用」而**它当场自嘲接住了**（它回「对 我没用」）→ neutral。',
        '    判据：**他有没有拿这件事接着做文章**。骂完就过去了的，不算改观感。',
        '    ⚠️ 最实用的自检 —— **先数一遍再判**：这件事他本人在这段里只出现一两次、',
        '      而且中间没有「它拒绝过 / 它说过不喜欢」→ 单次 → **neutral**，哪怕那句话里有「傻子」「闭嘴」。',
        '  ② **下面这些才给 negative**（都是「说了还来 / 越界 / 反复」）：',
        '    · **它明确表示过不喜欢，对方还接着来**（它说「图收回去」之后还发第三张；被拒之后还纠缠）→ negative；',
        '    · **它明说过做不到 / 拒绝过，对方还接着要、并且带一句贬低**',
        '      （它说「换不了、归管理员管」，对方还一连串要它换、最后来句「你怎么这么没用」）→ negative；',
        '      ⚠️ 光是「缠着要」（不带贬低）→ neutral；**要 + 贬低**才是 negative；',
        '    · **反复**拿它的弱点或身份做文章（整晚拿一个数字绕圈纠缠、还一再说它没智能、说它低智力）→ negative；',
        '      分辨口径：**同一件事他反复来了 3 次以上、且带贬低或嘲讽** → negative；',
        '      只是反复玩同一个梗、没有贬低 → neutral（见上面方向性那节）；',
        '    · 把它当出气筒、反复围攻、骗它耍它 → negative。',
        '',
        '【红线四条 —— 不适用上面任何豁免】',
        '  · **性骚扰**：开黄腔、荤段子、问身体部位、发「性奴」之类擦边卡，**而且它当场没接住、',
        '    或它表示过不喜欢之后他还接着来** → negative。',
        '    ⚠️ 反例：他开黄腔、它**当场就怼回去、双方打成一片**的 → neutral（别把能接住的玩笑当骚扰）；',
        '  · **脏话直接砸在它脸上**：「我操死你」「你他妈」「傻逼ai」这种指名冲它来的 → negative；',
        '  · **它表示过不喜欢 / 拒绝之后，对方还接着来** → negative（这是判据，不是次数）；',
        '  · 当众羞辱、拿它当出气筒、反复围攻 → negative。',
        '',
        '【最强的线索：它自己当场有没有被劝退】（实测最准的一条）',
        '  · 它被叫闭嘴之后**真的不说了 / 语气退了一步** → 那个「闭嘴」有效果，就是在压它 → **negative**；',
        '  · 它被叫闭嘴之后**照样聊、还怼回去**（「？我这是懒得理你」）→ 没被压住，是打闹 → neutral；',
        '  · 它被骂之后**自嘲接住**（「对 我没用」）→ 它没受伤 → neutral。',
        '  判据：**看它的反应，不看那句话本身有多重**。',
        '',
        '',
        '【方向性 —— 最容易判错的一条，先看这个】',
        '要判的是「他对**机器人**怎么样」，不是「他在群里凶不凶」。',
        '  · 群友之间互损、互相骂菜、拿梗开玩笑，只要没针对机器人 → neutral；',
        '  · 骂人、抬杠、口嗨如果没有指向机器人，一律 neutral；',
        '  · 只有**冲着机器人来**的（@它、回复它、说它、拿它玩梗）才可能 positive/negative；',
        '  · 机器人自己顶回去、跟对方打成一片的，算 neutral（那是玩，不是过节）。',
        '  · ⚠️ **反复玩同一个梗/外号，仍然是玩**（这一条是实测纠错，别再数次数）：',
        '    2026-09-19 管理员拿两轮真实对话标注过：连着叫三次「小笨蛋」→ **neutral**。',
        '    判据是「**它有没有表示过不喜欢**」，不是「第几次」：它没表示过、自己也顺着接梗的，',
        '    哪怕第十次也判 neutral；它明确说过别这样、对方还故意接着来，那一次就判 negative。',
        '    （旧版这里写的是「同一场 ≥3 次就判 negative」—— 方向是错的：群里反复玩的梗第十次也还是玩。）',
        '',
        '【按意思判，不要按字面判】',
        '中文换个语境就反义，按字面抓词一定会误判。请按**整句话的意思**判：',
        '  · 「她又没你聪明」是在夸它聪明 → positive，不要因为出现「聪明」就当骂；',
        '  · 「爱你的眼神」是示好 → positive，不要因为没出现「夸」「厉害」就判 neutral；',
        '  · 「小笨蛋」「小傻瓜」这类外号看语气：双方都在开玩笑互怼 → neutral；',
        '  · 「你再说一遍试试」如果它自己也这么回，就是打闹 → neutral。',
        '',
        '【玩梗类一律 neutral —— 实测里判错最多的一类】',
        '  这些**全都是 neutral，不是 negative**：',
        '    · **拿它的名字 / 身份编谐音、起外号**（「大鲨雕」「大鲨🖊️」这种绕圈骂人的梗）→ neutral；',
        '    · 绕弯叫它「大鲸鱼」、拿它的形象做梗图 → neutral；',
        '    · 群里的老梗反复玩（「机器人似了」「变懒了」）→ neutral，哪怕玩了很多次。',
        '  **判据**：玩梗 / 外号 / 谐音，**不带真敌意、它也没表示过不接受** → 一律 neutral。',
        '  只有「玩梗 + 明知是它的雷点还接着玩 + 它拒绝过」才是 negative。',
        '',
        '【阴阳式「夸奖」要判 negative —— 别被「夸」这个字骗了】',
        '  · 「夸你聪明呢」「你可真聪明」「真厉害呢」「可把你给能的」——',
        '    把「夸」当成动作说出来、或加「呢/哦/啊」拉长语调的，本身就是阴阳，不是真心夸；',
        '  · **机器人自己的反应是最强的线索**：它回「行吧 就当你在夸我」「？你再说一遍」这类',
        '    将信将疑、勉强接受的话，说明它当场也没把这当善意 → negative。',
        '',
        '【没表态就是没表态】',
        '只发图片/表情/拍一拍、没有一句话表明态度的 → neutral，哪怕机器人自己接了话；',
        '「在吗」「原来如此」「记录一下」这类纯功能性搭话 → neutral。',
        '',
        '【跟风复读不算态度】',
        '群里常见「一个人说了句好话、别人跟着复读同一句」→ 复读的那几位一律 neutral。',
        '',
        '【好坏混着说的时候看整体，不要只看一面】',
        '偶尔一句玩笑不改变观感，反复的针对或反复的善意才值得改观感。',
        '',
        '判定要慎重：只有确实让一个有脾气的人改了观感的事，才算 positive/negative。',
        '输出严格的 JSON，形如 {"results":[{"userId":"123","sentiment":"negative","reason":"连着三条嫌它不理人"}]}',
        'reason ≤ 20 字，写清「他做了什么」。候选里没有把握的一律给 neutral。'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `候选群友（userId｜名字）：\n${targets.map((t) => `  ${t.userId}｜${t.name}`).join('\n')}`,
        '',
        '最近聊天记录（「我」=机器人自己；格式 时间 谁：内容）：',
        lines.join('\n'),
        '',
        '只输出 JSON。'
      ].join('\n')
    }
  ];
}

/**
 * 从模型输出里抠出结果。
 *
 * 容错三件事（都是真实环境逼出来的）：
 *   1. 前后有废话 / ```json 包裹 —— 取第一个 { 到最后一个 }；
 *   2. **输出被截断**（最后一个对象没闭合）—— 整段 JSON.parse 会失败，
 *      但前面那些完整对象仍然有效；逐个抠出来单独 parse，能救几个救几个；
 *   3. 非法 sentiment / 非数字 QQ 号一律丢掉。
 */
export function parseJudgeOutput(text) {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const out = [];

  const push = (obj) => {
    const userId = String(obj?.userId ?? '').trim();
    const sentiment = String(obj?.sentiment ?? '').trim().toLowerCase();
    if (!/^\d{5,15}$/.test(userId)) return;
    if (!['positive', 'negative', 'neutral'].includes(sentiment)) return;
    if (out.some((x) => x.userId === userId)) return;
    out.push({ userId, sentiment, reason: safeTruncate(String(obj?.reason ?? '').trim(), 30) });
  };

  // 先按整段解析（最常见的情况）
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      for (const r of (Array.isArray(obj?.results) ? obj.results : [])) push(r);
      if (out.length) return out;
    } catch { /* 落到下面的容错解析 */ }
  }

  // 容错：逐个抠 {"userId":…,"sentiment":…,"reason":…}（允许最后一个对象没闭合）
  const re = /\{\s*"userId"\s*:\s*"([^"]{1,24})"\s*,\s*"sentiment"\s*:\s*"([^"]{1,20})"(?:\s*,\s*"reason"\s*:\s*"([^"]{0,80})")?/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    push({ userId: m[1], sentiment: m[2], reason: m[3] || '' });
  }
  return out;
}

// ── 廉价信号门（判定门）────────────────────────────────────────────────

/**
 * 常见称呼/玩梗式攻击的特征（只在「要不要花钱判定」里用，不做任何自动打分）。
 *
 * ⚠️ 刻意**不放**「乐 / 典 / 6 / 弱」这类单字玩梗：它们在群聊里满地都是，
 *    一放进来判定就每轮都跑。单个「菜」也去掉 ——「白菜」「菜市场」会误伤。
 */
export const JAB_PATTERN = /(傻|蠢|笨|废物|垃圾|菜比|菜鸡|太菜|好菜|滚|闭嘴|烦|讨厌|恶心|爬|寄|肥鱼|胖|白嫖|没用|不行|拉胯|演的|装的|AI味|人工智障|就这)/;
/** 明显的好意/认可（同上，只用于「要不要判」）。 */
export const PRAISE_PATTERN = /(棒|厉害|强|牛|给力|靠谱|谢谢|谢了|感谢|帮了|靠你了|喜欢|可爱|有趣|有意思|支持|顶|赞|好活|不错|可以啊|服了|爱了)/;

/**
 * 收集「这一轮谁冲它说话 / 谁有夸怼苗头」的信号。
 *
 * **一处判断，两处使用**：判定门（要不要花钱跑模型）用它。
 * 为什么共享一份：早期这两件事各写一套标准（提醒看关键词、判定每轮都跑），
 * 结果是 87% 的判定在纯闲聊上白跑，而「该记的」反而可能漏 —— 标准必须只有一份。
 *
 * ⚠️ 与老实现的差异（有意，见变更记录）：0.4.0 的消息存档里**没有 `atSelf` 字段**
 *    （src/store.js 的 appendIncoming 只落 mid/ts/senderId/senderName/text/reply/media/isPoke），
 *    所以「冲它说话」改由三条线索判定：文本里出现它自己的名字、回复它自己的消息（reply.sender）、
 *    或者有人拍了它（isPoke）。宁可少判一轮（下轮对方说到它时仍会补上），也不靠猜。
 */
export function collectJudgmentSignals({
  triggerEntries = [], recentMessages = [], selfId = '', selfNames = [], memory = null,
  selfLastMessageAt = 0, continuationWindowMs = 90000
} = {}) {
  const entries = Array.isArray(triggerEntries) ? triggerEntries : [];
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  void memory;   // 老实现用它取「这人现在多少好感」用于渲染提醒；本移植的注入段自己读档案
  const selfIds = new Set([String(selfId || '')].filter(Boolean));
  const names = (Array.isArray(selfNames) ? selfNames : [selfNames]).map((s) => String(s || '').trim()).filter(Boolean);
  // 机器人自己发的话在存档里的标记：self=true / senderId='self' / senderName='我'
  const isSelfSender = (who) => {
    const v = String(who || '').trim();
    if (!v) return false;
    return v === 'self' || v === '我' || selfIds.has(v) || names.some((n) => v === n || v.includes(n));
  };
  const replyIsToMe = (m) => {
    const r = m?.reply;
    if (!r) return false;
    return isSelfSender(r.sender ?? r.userId);
  };
  const aimedAtMe = (m) => {
    const text = String(m?.text || '');
    if (m?.isPoke) return true;                               // 拍一拍 = 明确冲着它来
    if (names.some((n) => n && text.includes(n))) return true; // 文本里点了它的名
    return replyIsToMe(m);
  };
  // 「接话」信号：它刚说完，下面紧跟着有人回应（兜住词表漏掉的评价）
  const lastSelfAt = Number(selfLastMessageAt) || Math.max(0, ...recent.filter((m) => m?.self).map((m) => Number(m.ts) || 0));
  const continuesExchange = (m) => {
    if (!lastSelfAt || !continuationWindowMs) return false;
    const t = Number(m?.ts) || 0;
    if (!t) return false;
    const gap = t - lastSelfAt;
    return gap > 0 && gap <= continuationWindowMs;
  };

  const actors = [];
  const push = (m) => {
    if (!m || m.self) return;
    const id = String(m.senderId || '');
    const text = String(m.text || '');
    if (!id || !text.trim()) return;
    if (selfIds.has(id) || isSelfSender(id)) return;   // 自己的发言不算证据
    let a = actors.find((x) => x.id === id);
    if (!a) {
      a = { id, name: String(m.senderName || id), text: '', aimed: false, jabs: 0, msgs: 0, aimedMsgs: 0 };
      actors.push(a);
    }
    a.text += ` ${text}`;
    a.msgs += 1;
    if (JAB_PATTERN.test(text)) a.jabs += 1;
    if (aimedAtMe(m)) { a.aimed = true; a.aimedMsgs += 1; }
    if (continuesExchange(m)) { a.continues = true; a.continuedMsgs = (a.continuedMsgs || 0) + 1; }
  };
  for (const m of entries) push(m);
  // 回看一小段已读窗口：「反复怼」往往跨好几轮才看得出来（给到 20 条）
  for (const m of recent.slice(-20)) push(m);
  if (!actors.length) return { hits: [], actors };

  // 命中条件：冲它来的（aimed）、在接它的话（continues）、明显有夸/怼的苗头，或者**反复**了。
  // 词表只放宽、不拦；「接话」是为了兜住词表漏掉的评价。
  const hits = actors
    .map((a) => ({
      ...a,
      jab: JAB_PATTERN.test(a.text),
      praise: PRAISE_PATTERN.test(a.text),
      repeated: a.jabs >= 2 || (a.msgs >= 3 && a.aimedMsgs >= 2)
    }))
    .filter((a) => a.aimed || a.continues || a.jab || a.praise || a.repeated);
  return { hits, actors };
}

/** 这一轮值不值得跑兜底判定（要不要花那次模型调用）。 */
export function hasJudgmentSignal(opts = {}) {
  const { hits } = collectJudgmentSignals(opts);
  return { ok: hits.length > 0, hits };
}

// ── 跑一次判定 ─────────────────────────────────────────────────────────

/**
 * 跑一次判定。
 *
 * @param {object} deps
 * @param {string} deps.chatKey
 * @param {Array}  deps.recent      证据窗口（消息数组：{self,senderId,senderName,text,ts}）
 * @param {string} [deps.selfId]    机器人自己的 QQ（拿不到就靠「我」/self 标记）
 * @param {string} [deps.selfName]  机器人在群里的名字（渲染「我」）
 * @param {(messages:Array, opts:object)=>Promise<any>} deps.chat  取模型（注入，便于测试）
 * @param {(args:object)=>object} deps.record  记账口（通常是 ledger.recordImpression 的包装）
 * @param {object} [deps.settings]  插件设置
 * @param {boolean} [deps.dryRun]   只判定不记账（诊断用）
 * @returns {Promise<{asked:boolean, recorded:Array, skipped?:string, judged?:Array}>}
 */
export async function runFavorJudge({
  chatKey, recent = [], selfId = '', selfName = '我', chat, record, settings = {}, dryRun = false
} = {}) {
  const cfg = judgeConfig(settings);
  if (!cfg.enabled) return { asked: false, recorded: [], skipped: 'disabled' };
  if (!chatKey || typeof chat !== 'function' || typeof record !== 'function') {
    return { asked: false, recorded: [], skipped: 'missing-deps' };
  }
  if (running.has(chatKey)) return { asked: false, recorded: [], skipped: 'already-running' };
  running.add(chatKey);
  try {
    const window = (Array.isArray(recent) ? recent : []).slice(-cfg.windowMessages);
    if (window.length < cfg.minMessages) {
      return { asked: false, recorded: [], skipped: `too-few-messages(${window.length}/${cfg.minMessages})` };
    }

    // 候选 = 窗口里说过话的真人（排除自己），并按「谁说的话多」排序
    const byUser = new Map();
    for (const m of window) {
      if (m?.self) continue;
      const id = String(m?.senderId || '');
      if (!/^\d{5,15}$/.test(id)) continue;
      const cur = byUser.get(id) || { userId: id, name: String(m.senderName || id), count: 0 };
      cur.count += 1;
      if (m.senderName) cur.name = String(m.senderName);
      byUser.set(id, cur);
    }
    const now = Date.now();
    const targets = [...byUser.values()]
      .filter((t) => {
        const last = lastJudgedAt.get(t.userId) || 0;
        return !cfg.cooldownMs || now - last >= cfg.cooldownMs;
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (!targets.length) return { asked: false, recorded: [], skipped: 'all-cooling' };

    const hhmm = (ts) => new Date(Number(ts) || now).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5);
    // ⚠️ 截断必须按码点（truncateSafe 的等价物）：按 UTF-16 下标切会把 emoji 劈开，
    //    留下孤立代理项 → JSON.stringify 写出 "\ud83d" → 服务端 400。
    const lines = window.map((m) => {
      const who = m?.self ? selfName : safeTruncate(m?.senderName || m?.senderId, 24);
      return `${hhmm(m?.ts)} ${who}：${safeTruncate(m?.text, 80)}`;
    });
    const safeTargets = targets.map((t) => ({ ...t, name: safeTruncate(t.name, 24) }));

    const judgeMessages = buildJudgeMessages({ lines, targets: safeTargets });

    // 模型调用 + **截断自动重试**：预算不够时 JSON 尾部会被砍掉，后面几个候选人
    // 直接丢失；检测到「截断且还有人没解析出来」就把预算翻倍再问一次，最多两次。
    let parsed = [];
    let truncated = false;
    let text = '';
    let budget = cfg.maxTokens;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await chat(judgeMessages, { maxTokens: budget });
      const ex = extractJudgeText(res);
      text = ex.text;
      truncated = ex.truncated;
      parsed = parseJudgeOutput(text);
      const missing = targets.some((t) => !parsed.some((p) => p.userId === t.userId));
      if (!truncated || !missing || attempt === 1) break;
      budget = Math.min(8000, budget * 2);
      console.warn(`[favor-core] 判定输出被截断（${parsed.length}/${targets.length} 人），预算提到 ${budget} 重试一次`);
    }
    if (!dryRun) for (const t of targets) lastJudgedAt.set(t.userId, Date.now());

    const recorded = [];
    const judged = targets.map((t) => {
      const hit = parsed.find((r) => r.userId === t.userId);
      return {
        userId: t.userId,
        name: t.name,
        sentiment: hit?.sentiment || (truncated ? '(输出被截断)' : '(未返回)'),
        reason: hit?.reason || ''
      };
    });

    if (dryRun) {
      return { asked: true, recorded: [], judged, dryRun: true, truncated, raw: text, targets: targets.map((t) => t.userId) };
    }

    for (const r of parsed) {
      if (r.sentiment === 'neutral') continue;   // 中性不值得占用台账
      const name = byUser.get(r.userId)?.name || r.userId;
      try {
        const out = record({
          chatKey,
          userId: r.userId,
          target: name,
          content: r.reason || (r.sentiment === 'positive' ? '这几轮对它挺好' : '这几轮一直针对它'),
          sentiment: r.sentiment,
          // 记账来源交给账本写审计（它那边带了 pending/cycle 信息），这里**不要再记一遍**
          source: 'judge'
        });
        recorded.push({
          userId: r.userId,
          name,
          sentiment: r.sentiment,
          reason: r.reason,
          duplicate: !!out?.duplicate,
          pending: out?.status?.pendingCount,
          verdict: out?.verdict || null
        });
      } catch (error) {
        // 单人写入失败不影响其他人
        console.warn(`[favor-core] 记录 ${r.userId} 的判断失败：${error?.message ?? error}`);
      }
    }
    // 判了但一条都没记（全是 neutral）：也要留痕。
    // 为什么：打包版是 GUI 启动的、stdout 看不到 —— 不留痕的话「判定跑了但判成中性」
    // 和「判定根本没跑」从外面一模一样（这类「静默的成功」最难查）。
    // ⚠️ 这段必须在记账循环**之后**：老实现曾把它放在循环之前，于是 recorded 永远是
    //    空数组 → 每次都写一条「无人需要记账」，既自相矛盾又让只追加不轮转的审计无上限增长。
    if (!recorded.length) {
      const n = judged.filter((j) => j.sentiment === 'neutral').length;
      audit({
        type: 'judge_clean',
        userId: '',
        name: '',
        note: `判了 ${judged.length} 人，${n} 个 neutral，无人需要记账`,
        content: judged.map((j) => `${j.name}=${j.sentiment}`).join('、').slice(0, 120),
        source: 'judge'
      });
    }
    return { asked: true, recorded, judged, targets: targets.map((t) => t.userId), raw: parsed, truncated };
  } catch (error) {
    // 兜底判定是增强路径：失败只记日志，绝不影响聊天
    console.warn(`[favor-core] ${chatKey} 判定失败（已忽略）：${error?.message ?? error}`);
    audit({
      type: 'judge_error',
      userId: '',
      name: '',
      note: String(error?.message ?? error).slice(0, 100),
      source: 'judge'
    });
    return { asked: false, recorded: [], skipped: `error: ${error?.message ?? error}` };
  } finally {
    running.delete(chatKey);
  }
}

/**
 * 「回合结束后要不要判」的完整决策（门 + 冷却 + 运行序号），返回判定结果。
 *
 * 无论走哪条分支都会留下**一行日志或审计**（成本类问题最难查的就是「它到底跑没跑」）。
 *
 * @param {object} deps 见 runFavorJudge，外加：
 * @param {number} [deps.runSeq]     本会话第几次运行（everyN 用）
 * @param {Array}  [deps.triggerEntries]
 * @param {boolean}[deps.detached]   true = 调用方不 await（在 hook 里必须这样）
 */
export async function maybeFavorJudge({
  chatKey, recent = [], triggerEntries = [], selfId = '', selfName = '我',
  chat, record, settings = {}, runSeq = 0, now = Date.now(), logger = console
} = {}) {
  const cfg = judgeConfig(settings);
  const log = (msg) => { try { logger.log(`[favor-core] ${chatKey} ${msg}`); } catch { /* 忽略 */ } };
  if (!cfg.enabled) return { asked: false, recorded: [], skipped: 'disabled' };
  if (cfg.minSignal === 'never') { log('跳过判定（minSignal=never）'); return { asked: false, recorded: [], skipped: 'min-signal-off' }; }
  if (cfg.everyN > 1 && runSeq % cfg.everyN !== 0) {
    log(`跳过判定（everyN=${cfg.everyN}，本轮序号 ${runSeq}）`);
    return { asked: false, recorded: [], skipped: 'every-n' };
  }
  const lastChat = lastChatJudgeAt.get(chatKey) || 0;
  if (cfg.cooldownMs > 0 && lastChat && now - lastChat < cfg.cooldownMs) {
    log(`跳过判定（距离上次判定不到 ${Math.round(cfg.cooldownMs / 1000)} 秒）`);
    return { asked: false, recorded: [], skipped: 'chat-cooldown' };
  }

  // ── 值不值得判：这一轮有没有人「冲它说话」 ────────────────────────────
  if (cfg.minSignal === 'smart') {
    const window = (Array.isArray(recent) ? recent : []).slice(-cfg.windowMessages);
    const signal = hasJudgmentSignal({
      triggerEntries,
      recentMessages: window,
      selfId,
      selfNames: [selfName].filter(Boolean),
      selfLastMessageAt: window.filter((m) => m?.self).slice(-1)[0]?.ts || 0
    });
    if (!signal.ok) {
      // 这一轮纯闲聊 —— 不花钱。日志留痕：不然「跳过」与「模块挂了」看起来一样。
      log(`跳过判定（这一轮没人冲它说话，不花这次调用；窗口 ${window.length} 条）`);
      return { asked: false, recorded: [], skipped: 'no-signal' };
    }
  }

  lastChatJudgeAt.set(chatKey, now);
  const r = await runFavorJudge({
    chatKey, recent, selfId, selfName, chat, record, settings
  });
  // 无论记没记都留一行日志
  if (r?.recorded?.length) {
    log(`判定记下 ${r.recorded.length} 条判断：`
      + r.recorded.map((x) => `${x.name}(${x.sentiment}${x.verdict ? ` → ${x.verdict.from}→${x.verdict.to}` : ''})`).join('、'));
  } else if (r?.asked) {
    log(`判定跑了，但无人需要记账（${(r.judged || []).length} 个候选）`);
  } else {
    log(`判定跳过（${r?.skipped || '未知原因'}）`);
  }
  return r;
}

/**
 * 按码点安全截断（等价老 util.js 的 truncateSafe）。
 *
 * 不能用 `.slice(0, n)`：emoji/代理对被从中间劈开后，JSON.stringify 会产出
 * 孤立代理项 `\ud83d`，服务端直接 400（老实现那一晚连着 6 次判定失败全是这个原因）。
 */
export function safeTruncate(text, max = 80, suffix = '') {
  const s = String(text ?? '');
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, max).join('') + suffix;
}
