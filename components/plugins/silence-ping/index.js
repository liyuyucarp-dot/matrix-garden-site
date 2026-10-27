/**
 * silence-ping —— 主动私信（确定性型 / plugins/）
 *
 * v1.6.0（主宾锚定与防复读升级版 · 2026-10-27）
 *   · 根治「主宾不分 / 把对方的话当成自己说的 / 把自己的事安到对方头上」四大病灶：
 *     ① 引用头清洗与转译（cleanMessageForPrompt）：剥离 `[引用 某人：长文]` 协议头，
 *        转译为短注 `（回应「…」）`，杜绝 80 字截断后只剩被引用原话导致归属颠倒；
 *     ② 相邻同向轮次归并 + 双向箭头强锚定（groupRecentTurns）：将每条记录显式标为
 *        `【对方(昵称) → 对你说】` vs `【你(botName) → 对Ta说】`，消除正文内代词「我/你」碰撞；
 *     ③ 双方最后表态对账单（buildSpeakerLedger）：由纯 JS 提取「对方最后对你说的话」与
 *        「你最后对对方说的话」并列对账，显式锁死各自处境归属；
 *     ④ System / User 职责分离（buildSystemRolePrompt + buildPrompt）+ JSON 微推理顺序
 *        （`lastState` → `mind` → `say`）：在 thinkingMode:'off' 下让模型先输出 15 字主宾确认
 *        再生成 `say`，并新增 `isEchoOfRecent` 2-gram 复读硬闸拦截自我复读或鹦鹉学舌。
 * v1.5.1（社区发布版）
 *   · 修时间口径：给 AI 的对话记录原来只有"几点几分"、没有日期，于是跨天的间隔
 *     会被算错（把 3 天前当成 3 小时前，开口就是"三个多小时没动静 你睡了？"）。
 *     现在每条都带真实间隔（"3 天前"），今天的才只写时刻，并明确要求模型以它为准。
 * v1.5.0：社区发布版。简介与设置文案重写；设置页按六组重排
 *         （总开关 → 指定对象 → 叫醒节奏 → 勿扰时段 → 发送限制 → 省 token）。
 * v1.1.0：文案与默认值整理；新增「梁文峰时期」（上班时段一键禁发）；
 *         新增「指定 QQ 号并逐个检查」；新增「人设卡片截断」省 token 旋钮。
 *
 * ── 这个插件在干什么（一句话）────────────────────────────────────────────
 *   AI 自己不会主动发消息，得有个人替它做决定。本插件就是一个后台小程序，
 *   隔一阵子醒一次，判断"现在能不能发"，能发就把最近的私信记录丢给 AI 问
 *   "要不要主动说句话、说什么"，AI 说要就用一个能主动发私信的渠道发出去，
 *   然后把"几点发的、发了什么、对方回没回"记下来，继续睡。
 *   不想被打扰的时段（睡眠 + 上班时段）一声不吭。
 *
 * ── 循环的七步（与设计说明一一对应）──────────────────────────────────────
 *   1. 隔一会儿醒一次（间隔在 wakeRange 里随机，默认 15~30 分钟）
 *   2. 醒来先看现在能不能发：总开关 / 半夜 / 今天发太多 / 刚发过 / 你刚回过
 *   3. 能发就翻开最近的私信记录，再看"上次它主动说了啥、你回没回"
 *   4. 把这些丢给 AI，问它：现在要不要主动私信说句话？要说的话说什么？
 *   5. AI 说不发就啥也不干；AI 说发就把那句话发出去
 *   6. 发完记下来（时间 / 内容 / 你回没回），下次判断用
 *   7. 继续循环
 *
 * ── 为什么放 plugins/ 而不是 skills/ ─────────────────────────────────────
 *   见 src/skills/manifest.js 的 DIR_KIND："什么时候开口"是**机械调度**
 *   （定时器 + 本地规则），满足条件就一定执行，不需要模型先想起来；
 *   放 skills/ 只会注册成模型可选调用的工具，模型不调用就永远不发生。
 *
 * ── ⚠️ 只发私信，群聊一律不管 ────────────────────────────────────────────
 *   所有能读到会话的地方都只认 `private:<QQ号>`：群聊消息不读、不触发、
 *   不回复、不主动发。具体做法：
 *     · before-context 钩子里第一件事就是判断会话类型，群聊直接 return
 *     · 扫描时 isPrivate() 过滤，group:* 连读都不读
 *   群聊的"主动开话题"是核心自己的 proactive 循环（src/orchestrator.js）
 *   和别的插件（plugins/affinity-proactive）在管，与本插件无关。
 *
 * ── 存档 ─────────────────────────────────────────────────────────────────
 *   data/silence-ping.json（本插件私有，原子写）
 *   {
 *     version, lastCheckAt, dayKey, dayCount, lastSendAt,
 *     friends: {
 *       "private:<QQ号>": {
 *         lastMsgAt,            // 上次主动发出去的时间
 *         lastMsgText,          // 发了什么
 *         replied,              // 你回没回
 *         lastIncomingAt,       // 你最后一次说话的时间
 *         lastIncomingText,     // 你最后说的那句（留着判断"要不要接话"）
 *         lastCheckAt,          // 上次对它做过判断的时间
 *         sentCount             // 累计主动过几次
 *       }
 *     }
 *   }
 *
 * ── 踩坑备忘（都是实测踩过的）────────────────────────────────────────────
 *   · 消息存档（store）只能靠 before-context 钩子带进来：钩子只在**有会话被
 *     唤醒**时才跑，所以插件刚落地、还没人说话时，第一次扫描会打印"还没有
 *     捕获到消息存档"并跳过。之后（任意一条消息进来后）自动完全生效，不需要
 *     重启或手动开关 —— 定时器由 activate 与钩子两处保证一定会起来。
 *   · 热重载只会"加载"不会"激活"（app.js 的 reloadSkills 只对已注册条目调
 *     activate），所以钩子里也要拉起定时器（startLoop 是幂等的），
 *     否则插件在界面上显示"已启用"，却永远没有动静。
 *   · 判断"你回没回"必须用**存档里的消息时间**比，不能只靠钩子里记的标志位：
 *     你的回复往往不触发一次回复流程，钩子不会跑。
 *   · 只有第一轮的判断/生成调一次 AI，其余判断全是本地规则和随机数，省 token。
 *   · 发送优先走核心的发送队列能力（限频/去重/留档/界面刷新），拿不到就
 *     OneBot HTTP 直发 + 手动 appendSelf 兜底（范式同 plugins/reminder）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, personaForChat, DATA_DIR as DATA_DIR_FALLBACK } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';

/**
 * 数据目录：**自己算，别直接信 config.js 导出的 DATA_DIR**。
 *
 * ⚠️ 这是 2026-10-04 实测踩到的一个大坑，也是"消息发出去了、自己的聊天记录里却没有"
 *    的根因，必须说清楚：
 *
 *   · config.js 的 DATA_DIR 只认两样东西：环境变量 QQ_AGENT_DATA_DIR，
 *     或者 `path.join(ROOT, 'data')`（ROOT = resources/app）。
 *   · 也就是说，它的正确性**依赖 Electron 运行时把 QQ_AGENT_DATA_DIR 设上**。
 *   · 一旦这个变量没设（比如插件被单独调用、被别的宿主加载、或某次启动没带上），
 *     DATA_DIR 就会指向 `resources/app/data` —— 那是**另一个目录**，里面没有
 *     config.json、也没有 messages/。后果：
 *       - 读不到任何聊天记录 → 候选恒为 0（看起来像"没对象可发"）
 *       - 发出的消息写不进聊天记录 → 它下轮看不到自己说过什么，可能重复说同一件事
 *
 *   正确做法是像 plugins/icebreaker 那样**自己往上推**：
 *     `plugins/<id>/index.js` 往上 4 层正好是程序根（装着 data/ 的那一层），data 就在那儿。
 *   优先级：显式环境变量 > 自己的推导 > config.js 给的（最后的退路）。
 *   另外多实例场景：QQ_AGENT_PROFILE=2 时数据目录是 data-2/，这里也一并处理了。
 */
const DATA_DIR = (() => {
  const fromEnv = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));   // …/plugins/silence-ping
    // ① 程序根/data（打包后的标准布局）：插件目录往上 4 层
    const guess = path.resolve(here, '..', '..', '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess, 'config.json')) || fs.existsSync(path.join(guess, 'messages'))) return guess;
    // ② 有的部署把 app 直接放在程序根下（此时 data 与 plugins 同级的上两层）
    const guess2 = path.resolve(here, '..', '..', `data${suffix}`);
    if (fs.existsSync(path.join(guess2, 'config.json')) || fs.existsSync(path.join(guess2, 'messages'))) return guess2;
  } catch { /* 推导失败就往下走 */ }
  return DATA_DIR_FALLBACK;
})();

const BUILD_TAG = 'v1.6.0';
const STORE = path.join(DATA_DIR, 'silence-ping.json');
const BJ_OFFSET_MS = 8 * 3600 * 1000;

const DEFAULTS = {
  enabled: true,
  dryRun: false,
  targets: '',                    // 空 = 白名单里所有私聊；填了 = 只对这些 QQ，且逐个都检查
  targetIdleMinMinutes: 30,       // "他多久没说话才值得找他"（可用 "QQ:分钟" 单独覆盖）
  cooldownMinutes: 120,           // "同一个人两次之间最少隔多久"（两种模式都生效，可单独覆盖）
  wakeRange: '15-30',             // 醒来间隔（分钟）："最小-最大"，只写一个数=固定值
  quietRange: '00:00-07:00',      // 睡眠时间："开始-结束"，支持跨零点、精确到分钟
  maxPerDay: 20,
  replyGuardMinutes: 30,
  // 防重复发：同一会话这个时间内已有机器人发言（含别的插件发的），就不再开口。
  // 两道保险见 resendGuard()：① 插件存档 ② 聊天记录本身。纯本地，不花 token。
  resendGuardMinutes: 30,
  // ── 不重复找人（省 token）──
  // 打开时：对同一个人主动发过一次、对方还没回，就**不再发第二句**，
  // 把他标记为"等回复中"暂停；等他主动说话了自动解除。
  noRepeatWhenUnreplied: true,
  // 每轮醒来**最多发几个人**（随机区间，默认 1-1 = 只发一个）。
  targetSendRange: '1-1',
  sendGapSec: 20,                 // 一轮内两条之间的间隔（秒），避免 10 秒内连发十条
  personaMaxChars: 0,             // 0 = 人设发全文（默认）；调小可显著省 token
  // ── 梁文峰时期（工作时间一键禁发）──
  liangwenfengEnabled: true,      // 一键开关：关掉就完全不管这个时段限制
  lwfPeriods: '09:00-12:00, 14:00-18:00',
  lwfDays: '1,2,3,4,5',           // 1=周一 … 7=周日；默认工作日
  personaNote: ''
};

/**
/**
 * 判断/生成那一次调用的输出上限（**固定值，不再开放成设置项**）。
 *
 * 这只是个"防失控"的保险：正常情况下它只输出一行 JSON（"发/不发" + 一句话），
 * 几十个 token 就够。之所以不把它做成设置项，是因为它**很容易被误解成
 * "每轮消耗上限"** —— 实际整轮消耗的大头是**输入**（人设卡片 + 最近对话记录，
 * 每问一次就重发一遍），把这里调大调小几乎不影响账单。
 * 真要省 token 应该少发点上下文，而不是松输出限制。
 */
const OUT_MAX_TOKENS = 600;

/**
 * 每次判断发给 AI 的对话记录规模。
 * 这两个值就是**真正决定账单大小**的旋钮（输入侧），比输出上限重要得多：
 * 每轮判断都要把人设 + 这些记录重发一遍，所以"少发两条、每条短一点"
 * 比"把输出上限调小"省得多。默认 12 条 × 每条 80 字。
 */
const RECENT_LIMIT = 12;
const RECENT_CHARS = 80;

/**
 * 人设卡片发多少字给它（0 = 全文，默认）。
 *
 * 为什么这个才是"花费旋钮"：实测一轮判断的输入 = 人设卡片 + 对话记录 + 规则，
 * 其中**人设卡片占了 94%**（本机 17553 字）。每轮判断都要把它重发一遍，
 * 所以账单几乎完全由它决定。把它限制到 3000 字大约能把单轮输入压到 1/5。
 * 代价：说话风格会比全文版弱一些（人设是长篇角色卡时尤其明显）。
 */
const personaTextOf = (chatKey, maxChars) => {
  const p = personaForChat(chatKey) || {};
  const full = String(p.roleText || '').trim();
  const n = num(maxChars, 0, 0, 200000);
  if (n > 0 && full.length > n) return `${full.slice(0, n)}\n（……后略：为省 token 只发了人设前 ${n} 字）`;
  return full;
};

/** 超过这么久没动静的私聊就不打扰了（防"诈尸"）。 */
const GIVE_UP_MS = 14 * 24 * 3600 * 1000;

let api = null;
let fetchRef = null;
let timer = null;
let storeRef = null;                  // before-context 钩子带来的聊天存档
let warnedNoStore = false;
let warnedDryRun = false;
let lastCheckAt = 0;                  // 给状态面板看"上次醒来是什么时候"

let stateCache = { mtimeMs: -1, data: null };

/**
 * 排障：把关键步骤写进文件（默认关闭）。
 *
 * 为什么需要它：插件日志走 console，而程序自己的 data/logs/*.log **只记
 * logger.\* 的输出**，插件的判断与发送过程在日志文件里完全空白 —— 线上
 * "看着在跑却什么也没发生"时根本无从定位。这次就是靠它抓到
 * `originalFetch is not a function` 的。
 * 需要时把下面改成 !== '0'（或设 QQ_AGENT_DM_DEBUG=1 后重启）即可开启。
 */
const DEBUG = String(process.env.QQ_AGENT_DM_DEBUG ?? '0') === '1';
const DEBUG_FILE = path.join(DATA_DIR, 'silence-ping.debug.log');
function dbg(msg) {
  if (!DEBUG) return;
  try { fs.appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

/* ═══════════ 断线自愈：拿不到钩子存档时，直接读磁盘聊天存档 ═══════════
 *
 * 为什么需要这个兜底（2026-10-04 实测踩到）：
 *   插件原先只认 before-context 钩子递进来的 ChatStore 引用。而那个钩子只在
 *   **有会话被真正唤醒**时才跑，并且热重载会把插件换成全新实例、引用清零 ——
 *   表现就是"插件启用着、定时器也在跑，却每轮都在第一行跳过、什么都不做"，
 *   直到有人再发一条消息。用户完全无从知道要"喂"它一条消息。
 *   而聊天记录本来就以 JSON 存在 data/messages/private_<QQ>.json，格式固定，
 *   直接读文件简单彻底：插件从此**不依赖任何外部引用**，重启/热重载后立刻可用。
 *
 * 写操作只有一个：appendSelf（把机器人自己发的那条记进存档，让下一轮看得到）。
 * 核心写入用的是"临时文件 + rename"原子替换，两边并发写同一文件的风险很低
 * （核心只在收到/发出消息的那一刻写），可接受。
 */
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

let fileChatsCache = { at: 0, keys: [] };
function fileChats() {
  const now = Date.now();
  if (now - fileChatsCache.at < 10000 && fileChatsCache.keys.length) return fileChatsCache.keys;
  const keys = [];
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (m) keys.push(`${m[1]}:${m[2]}`);
    }
  } catch { /* 目录不存在 */ }
  fileChatsCache = { at: now, keys };
  return keys;
}

/**
 * 读一个会话的存档（只读）。失败返回 null，调用方跳过即可。
 *
 * ⚠️ 分隔符必须写成 `[:_]`：**会话键**是 `private:123`（冒号），而**文件名**是
 *    `private_123.json`（下划线）。第一版正则只认下划线，于是拿 `private:123`
 *    去匹配永远失败 → 每轮都"读不到记录"、静默什么都不做。这个坑和之前那次
 *    "只记被选中的人"是同一类：不报错，但功能整体失效。
 */
function loadChatFile(chatKey) {
  const m = /^(group|private)[:_](\d+)$/.exec(String(chatKey || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${m[1]}_${m[2]}.json`), 'utf8'));
    if (!j || !Array.isArray(j.messages)) return null;
    return j;
  } catch { return null; }
}

/** 把机器人自己发出的一条记进存档（与核心 appendSelf 同语义）。 */
function appendSelfToFile(chatKey, { text, ts = Date.now() } = {}) {
  const m = /^(group|private)[:_](\d+)$/.exec(String(chatKey || ''));
  if (!m) return false;
  const file = path.join(MESSAGES_DIR, `${m[1]}_${m[2]}.json`);
  const j = loadChatFile(chatKey);
  if (!j) return false;
  const id = Number(j.nextLocalId) || (j.messages.length + 1);
  j.nextLocalId = id + 1;
  j.messages.push({
    id, mid: null, ts, senderId: 'self', senderName: '我',
    text: String(text ?? ''), self: true, read: true, reply: null, media: []
  });
  const tmp = `${file}.${process.pid}.tmp`;
  // ⚠️ 原子替换要**重试**（2026-10-04 实测踩到 EPERM）：
  //    Windows 上 rename 覆盖已存在的文件时，如果目标正被杀软扫描 / 被别的进程
  //    短暂持有句柄，就会抛 `EPERM: operation not permitted, rename ...`。
  //    这通常是瞬时的，等一下重试就过；而"失败一次就放弃"的后果很真实：
  //    消息已经发到对方那里，机器人自己的存档里却没有这句 —— 它下一轮看不到
  //    自己说过什么，于是可能重复说同一件事（用户实际观察到过这个现象）。
  //    发送在这之前已经完成，所以这里失败不影响"发出去"，只影响"记下来"。
  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(j, null, 1), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      lastErr = e;
      // 同步退避 40ms（本函数是同步的，不能用 await）
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { /* 退避失败也无妨 */ }
    }
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉临时文件不影响结果 */ }
  api?.warn?.(`主动私信：写入消息存档失败（${chatKey}，已重试 4 次）：${lastErr?.message ?? lastErr}`);
  return false;
}

/** 与核心 ChatStore 同形状的只读视图（用它替代钩子引用）。 */
const fileStore = {
  listChats: () => fileChats(),
  recent: (chatKey, { limit = 10, includeSelf = true } = {}) => {
    const j = loadChatFile(chatKey);
    if (!j) return [];
    const all = includeSelf ? j.messages : j.messages.filter((x) => !x.self);
    return all.slice(-Math.max(1, Number(limit) || 1));
  },
  getChatMeta: (chatKey) => {
    const j = loadChatFile(chatKey);
    if (!j) return null;
    const last = j.messages[j.messages.length - 1] || null;
    return {
      chatKey,
      total: j.messages.length,
      unread: j.messages.filter((x) => !x.read && !x.self).length,
      lastTs: last?.ts ?? 0,
      lastText: last?.text ?? ''
    };
  },
  appendSelf: (chatKey, entry) => appendSelfToFile(chatKey, entry)
};

/** 聊天存档视图：优先用钩子递来的（实时、带未读状态），拿不到就直接读文件。 */
function chatData() {
  return storeRef || fileStore;
}

/**
 * 「同一轮/短时间内别重复发」的两道保险。**纯本地判断，不调用 AI**。
 *
 * ① 插件自己的存档：最近有没有主动发过（从磁盘重读，不信内存副本）
 * ② 聊天记录本身：这个会话最近有没有机器人发出的消息（完全独立于插件存档）
 *
 * 为什么两道都要（2026-10-04 实测）：
 *   插件被重载后是全新模块，内存里的 lastMsgAt 没了；只靠内存会出现
 *   "60 秒内对同一个人连发两条"。① 用磁盘上的存档兜住大多数情况；
 *   ② 连"存档也丢了/被重置"都能兜住，因为聊天记录不在插件手里。
 *
 * @returns {{blocked: boolean, reason: string}}
 */
function resendGuard(s, chatKey, cand, now, src) {
  const winMs = num(s.resendGuardMinutes, 30, 0, 24 * 60) * 60000;
  if (winMs <= 0) return { blocked: false, reason: '' };

  // 保险 ①：从磁盘重读插件存档（不是内存里的 state 副本）
  try {
    const disk = readState();
    const f = disk?.friends?.[chatKey];
    const last = Number(f?.lastMsgAt) || 0;
    if (last > 0 && now - last < winMs) {
      return { blocked: true, reason: `刚发过（${Math.round((now - last) / 60000)} 分钟前，保险①）` };
    }
  } catch { /* 读不到就靠保险 ② */ }

  // 保险 ②：直接看聊天记录里最后一条机器人消息是什么时候
  try {
    const recent = chatData().recent(chatKey, { limit: 30, includeSelf: true }) || [];
    const lastSelf = [...recent].reverse().find((m) => m.self && !m.recalled);
    const ts = Number(lastSelf?.ts) || 0;
    if (ts > 0 && now - ts < winMs) {
      return { blocked: true, reason: `聊天记录里刚有机器人发言（${Math.round((now - ts) / 60000)} 分钟前，保险②）` };
    }
  } catch { /* 查不到就放行，交给别的规则把关 */ }

  return { blocked: false, reason: '' };
}


/* ═══════════════════════════ 设置 ═══════════════════════════ */

function settings() {
  const raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  const s = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof DEFAULTS[k] === 'number' && typeof v === 'string') {
      const n = Number(v);
      s[k] = Number.isFinite(n) ? n : DEFAULTS[k];
      continue;
    }
    s[k] = v;
  }
  return s;
}

const num = (v, dflt, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
};

/* ═══════════════════════════ 小工具 ═══════════════════════════ */

const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
const cap = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

const dayKeyOf = (ts = Date.now()) => {
  const d = new Date(ts + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
const hourOf = (ts = Date.now()) => new Date(ts + BJ_OFFSET_MS).getUTCHours();
const hhmm = (ts) => new Date(Number(ts) + BJ_OFFSET_MS).toISOString().slice(11, 16);

/**
 * 给人看的"多久以前"，例如「3 天前」「5 小时前」「12 分钟前」。
 *
 * ⚠️ 为什么必须有它（2026-10-04 实测踩到）：
 *   原来给 AI 的对话记录**只有"几点几分"、没有日期**，而"现在"也只给时刻。
 *   于是模型看到「17:33」和「现在是 22:16」就得出"差三个多小时"——那条其实
 *   是**三天前**的。模型没算错，是喂给它的信息缺了日期。
 *   加上相对的"多久以前"之后，跨天/跨周的间隔一目了然。
 */
function agoLabel(ts, now = Date.now()) {
  const d = now - Number(ts || 0);
  if (!Number.isFinite(d) || d < 0) return '';
  const min = Math.floor(d / 60000);
  if (min < 2) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  return `${day} 天前`;
}

/** 带日期的时刻：今天的只给时刻，往前的带上月日，跨天的间隔一眼可见。 */
function stamp(ts, now = Date.now()) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS);
  const today = new Date(Number(now) + BJ_OFFSET_MS);
  const sameDay = d.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
  return sameDay
    ? d.toISOString().slice(11, 16)
    : d.toISOString().slice(5, 10).replace('T', ' ');
}

/* ═════════════ 合并后的两个"区间"设置（1.1.0 去重）═════════════ */
// 原来睡眠时间是「开始小时 + 结束小时」两个数字、醒来间隔是「下限 + 上限」两个数字，
// 一共 4 个旋钮管 2 件事。现在各合成一个字符串：少两个设置项，
// 而且睡眠时间顺带能精确到分钟了（原来只能填整点）。

const clock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * 解析「每轮最多发几个人」：'1-1'（默认，只发一个）、'2-5'、'10'、'1~10' 都认。
 * @returns {{min:number,max:number}} 人数；看不懂 → 默认 1-1
 */
function parseCountRange(str, dfltMin = 1, dfltMax = 1, hardMax = 20) {
  const text = String(str ?? '').trim().replace(/[~～—–至]/g, '-').replace(/\s+/g, '').replace(/-+/g, '-');
  if (!text) return { min: dfltMin, max: dfltMax };
  let m = /^(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) {
    let min = num(m[1], dfltMin, 1, hardMax);
    let max = num(m[2], dfltMax, 1, hardMax);
    if (max < min) [min, max] = [max, min];      // 写反自动纠正
    return { min: Math.round(min), max: Math.round(max) };
  }
  m = /^(\d{1,2})$/.exec(text);
  if (m) { const v = Math.round(num(m[1], dfltMin, 1, hardMax)); return { min: v, max: v }; }
  api?.warn?.(`主动私信：每轮人数写法看不懂 →「${str}」，已按 ${dfltMin}-${dfltMax} 人处理（正确写法：1-1 或 1-10）`);
  return { min: dfltMin, max: dfltMax };
}

/**
 * 解析「睡眠时间」：'00:00-07:00'、'23:00-次日07:00'、'1:00~7:00'、'0900-1200' 都认。
 *
 * ⚠️ 先把连接符统一成 '-'，再做别的处理。踩过的坑：'1:00~7:00' 里那个 '~'
 *    会被小时部分的 `\d{1,2}(?::\d{2})?` 之一吃掉（'7~7' 这种），导致整个
 *    区间解析失败、静默变成"不设睡眠时间"。先归一化就没这问题。
 *
 * @returns {{start:number,end:number,label:string}|null} 分钟数；看不懂或起止相同 → null（= 不设睡眠时间）
 */
function parseQuietRange(str) {
  const text = String(str ?? '')
    .replace(/[~～→—–至]|(?:到|至)/g, '-')
    .replace(/[：]/g, ':')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .trim();
  if (!text) return null;
  const m = /^(\d{3,4}|\d{1,2}(?::\d{1,2})?)(?:-)(?:次日)?(\d{3,4}|\d{1,2}(?::\d{1,2})?)$/.exec(text);
  if (!m) {
    api?.warn?.(`主动私信：睡眠时间写法看不懂 →「${str}」，已按"不设睡眠时间"处理（正确写法：00:00-07:00）`);
    return null;
  }
  const start = toMinutes(m[1]);
  const end = toMinutes(m[2]);
  if (start === null || end === null || start === end) return null;
  return { start, end, label: `${clock(start)}-${clock(end)}` };
}

/** 现在是不是睡眠时间。 */
function inQuietNow(s, now = Date.now()) {
  const r = parseQuietRange(s.quietRange);
  if (!r) return { active: false, reason: '' };
  const mins = hourOf(now) * 60 + new Date(now + BJ_OFFSET_MS).getUTCMinutes();
  const hit = r.start < r.end ? (mins >= r.start && mins < r.end) : (mins >= r.start || mins < r.end);
  return hit ? { active: true, reason: r.label } : { active: false, reason: '' };
}

/**
 * 解析「醒来间隔」：'15-30' → [15,30]；'20' → [20,20]。
 * 连接符宽松：15-30 / 15~30 / 15—30 / 15到30 都认。
 * @returns {{min:number,max:number}} 分钟；看不懂 → 默认 15~30
 */
function parseWakeRange(str) {
  const text = String(str ?? '')
    .replace(/[~～→—–至]|(?:到|至)/g, '-')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .trim();
  if (!text) return { min: 15, max: 30 };
  let m = /^(\d{1,4})-(\d{1,4})$/.exec(text);
  if (m) {
    let min = num(m[1], 15, 1, 24 * 60);
    let max = num(m[2], 30, 1, 24 * 60);
    if (max < min) [min, max] = [max, min];         // 写反了自动纠正，不弹错烦人
    return { min, max };
  }
  m = /^(\d{1,4})$/.exec(text);
  if (m) { const v = num(m[1], 20, 1, 24 * 60); return { min: v, max: v }; }
  api?.warn?.(`主动私信：醒来间隔写法看不懂 →「${str}」，已按 15-30 分钟处理（正确写法：15-30）`);
  return { min: 15, max: 30 };
}

/* ───────────────────── 梁文峰时期（工作时间禁发）───────────────────── */

/**
 * "9:00" / "09:00" / "0900" / "9" → 分钟数；看不懂返回 null。
 *
 * ⚠️ 紧凑写法必须**先**按 HHMM 切分再校验（'0900' = 09:00）。
 *    踩过的坑：原来直接用 `^(\d{3,4})$` 抓整体，'0900' 被当成"小时数 900"，
 *    再被 h > 23 判为非法 → 整个 '0900-1200' 静默变成"不设睡眠时间"。
 */
function toMinutes(str) {
  const t = String(str ?? '').trim();
  if (!t) return null;
  let h, mm;
  let m = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (m) {
    h = Number(m[1]);
    mm = Number(m[2]);
  } else if (/^\d{3,4}$/.test(t)) {
    h = Number(t.slice(0, t.length - 2));      // '0900' → 09，'1200' → 12
    mm = Number(t.slice(-2));                  // '0900' → 00
  } else if (/^\d{1,2}$/.test(t)) {
    h = Number(t);
    mm = 0;
  } else {
    return null;
  }
  if (!Number.isFinite(h) || !Number.isFinite(mm) || h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/**
 * 解析"梁文峰时期"的时段，支持中英文标点、半角/全角冒号、跨零点：
 *   "09:00-12:00, 14:00-18:00"   "9:00~12:00；14:00—18:00"   "22:00-次日2:00"
 * @returns {Array<{start:number,end:number,label:string}>}
 */
function parsePeriods(spec) {
  const out = [];
  const text = String(spec ?? '').replace(/[～→—–至]/g, '-').replace(/[：]/g, ':');
  for (const raw of text.split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}(?::\d{2})?|\d{3,4})\s*-\s*(?:次日)?\s*(\d{1,2}(?::\d{2})?|\d{3,4})$/.exec(raw);
    if (!m) {
      api?.warn?.(`主动私信：梁文峰时期的时段写法看不懂，已忽略 →「${raw}」（正确写法：09:00-12:00）`);
      continue;
    }
    const start = toMinutes(m[1]);
    const end = toMinutes(m[2]);
    if (start === null || end === null || start === end) {
      api?.warn?.(`主动私信：梁文峰时期的时段起点终点不合法或相等，已忽略 →「${raw}」`);
      continue;
    }
    out.push({ start, end, label: raw });
  }
  return out;
}

/** 解析生效的星期：1=周一 … 7=周日（也认 "一,二,三" 和 "mon,tue"）。 */
function parseDays(spec) {
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
  const EN = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  const set = new Set();
  for (const raw of String(spec ?? '').split(/[,，;；\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (/^[1-7]$/.test(raw)) { set.add(Number(raw)); continue; }
    if (CN[raw]) { set.add(CN[raw]); continue; }
    if (/^周[一二三四五六日天]$/.test(raw)) { set.add(CN[raw[1]]); continue; }
    if (/^星期[一二三四五六日天]$/.test(raw)) { set.add(CN[raw[2]]); continue; }
    const en = EN[raw.slice(0, 3)];
    if (en) { set.add(en); continue; }
    api?.warn?.(`主动私信：梁文峰时期的星期写法看不懂，已忽略 →「${raw}」（1~7 = 周一到周日）`);
  }
  return set.size ? [...set].sort() : [1, 2, 3, 4, 5];
}

/** 现在是周几（1=周一 … 7=周日，北京时间）。 */
const weekdayOf = (now = Date.now()) => {
  const d = new Date(now + BJ_OFFSET_MS).getUTCDay();   // 0=周日
  return d === 0 ? 7 : d;
};

/**
 * 现在是不是"梁文峰时期"（工作时段，一条都不发）。
 * @returns {{active:boolean, reason:string, at?:string}}
 */
function inLiangwenfengPeriod(s, now = Date.now()) {
  if (s.liangwenfengEnabled === false) return { active: false, reason: '' };
  const days = parseDays(s.lwfDays);
  if (!days.includes(weekdayOf(now))) return { active: false, reason: '' };   // 周末等非生效日
  const periods = parsePeriods(s.lwfPeriods);
  if (!periods.length) return { active: false, reason: '' };
  const mins = hourOf(now) * 60 + new Date(now + BJ_OFFSET_MS).getUTCMinutes();
  for (const p of periods) {
    const hit = p.start < p.end
      ? (mins >= p.start && mins < p.end)
      : (mins >= p.start || mins < p.end);            // 跨零点
    if (hit) {
      const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return { active: true, reason: `${hhmm(p.start)}~${hhmm(p.end)}`, at: p.label };
    }
  }
  return { active: false, reason: '' };
}

/** 只看私聊。群聊在整条链路上被这个判断挡住。 */
const isPrivate = (chatKey) => /^private:\d+$/.test(String(chatKey || ''));

/** 白名单口径：与设置页 test-send 完全一致（deny 优先 / allow 非空必须在名单内）。 */
function inWhitelist(chatKey, cfg) {
  const m = /^(group|private):(\d+)$/.exec(String(chatKey || ''));
  if (!m) return false;
  const [, kind, id] = m;
  const deny = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (deny.map(String).includes(id)) return false;
  const allow = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allow.length > 0) return allow.map(String).includes(id);
  return cfg.allowAllWhenEmpty === true;
}

/* ═══════════════════════════ 指定对象 ═══════════════════════════ */

/**
 * 解析"指定要主动的 QQ 号"设置。
 *
 * 两种写法（可混用，逗号/空格/换行/分号都能分隔）：
 *   10001           用「指定对象的冷场门槛 / 冷却时间」两个默认值
 *   10001:60        这个人单独设**冷场门槛** 60 分钟（他 60 分钟没说话才考虑）
 *   10001:60/180    冷场门槛 60 分钟 + **冷却** 180 分钟（两次主动之间至少隔 3 小时）
 *
 * @returns {{configured: boolean, list: Array<{qq: string, idleMinMinutes: number|null, cooldownMinMinutes: number|null}>}}
 *          configured=false 表示没填 → 沿用白名单里所有私聊（原来的行为）
 */
function parseTargets(s) {
  const parts = String(s.targets ?? '').split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
  const list = [];
  const seen = new Set();
  for (const p of parts) {
    const m = /^(\d{4,12})(?::(\d{1,5})(?:\/(\d{1,5}))?)?$/.exec(p);
    if (!m) {
      api?.warn?.(`主动私信：指定的 QQ 号写法看不懂，已忽略 →「${p}」（正确写法：1234567、1234567:60 或 1234567:60/180）`);
      continue;
    }
    const qq = m[1];
    if (seen.has(qq)) continue;
    seen.add(qq);
    list.push({
      qq,
      idleMinMinutes: m[2] === undefined ? null : num(m[2], null, 1, 24 * 60),
      cooldownMinMinutes: m[3] === undefined ? null : num(m[3], null, 1, 24 * 60)
    });
  }
  return { configured: list.length > 0, list };
}

/* ═══════════════════════════ 存档 ═══════════════════════════ */

const emptyState = () => ({
  version: 1,
  lastCheckAt: 0,
  dayKey: dayKeyOf(),
  dayCount: 0,
  lastSendAt: 0,
  friends: {}
});

function readState() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(STORE).mtimeMs; } catch { /* 还没写过 */ }
  if (stateCache.data && stateCache.mtimeMs === mtimeMs) return stateCache.data;
  let data = emptyState();
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object' && j.friends && typeof j.friends === 'object') {
      data = { ...emptyState(), ...j, friends: j.friends };
    }
  } catch (e) {
    // 坏了就备份重建，别让机器人因为一个坏存档永远静默
    if (e?.code !== 'ENOENT') {
      try { fs.renameSync(STORE, `${STORE}.broken-${Date.now()}`); } catch { /* ignore */ }
      api?.warn?.(`主动私信存档损坏，已备份重建：${e?.message ?? e}`);
    }
  }
  stateCache = { mtimeMs, data };
  return data;
}

function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STORE);
    stateCache = { mtimeMs: -1, data: null };
    return true;
  } catch (e) {
    api?.warn?.(`主动私信存档写入失败：${e?.message ?? e}`);
    return false;
  }
}

function friendOf(state, chatKey) {
  let f = state.friends[chatKey];
  if (!f || typeof f !== 'object') {
    f = state.friends[chatKey] = {
      lastMsgAt: 0, lastMsgText: '', replied: false,
      // ⚠️ 只有**主动发出**的那条才记在这里（lastMsgAt 会被别的东西更新，
      //    不能用来代表"我主动过"）。"他回了没"只针对这条判断——见下面 ① 段。
      lastProactiveAt: 0, lastProactiveText: '',
      // 省 token 的"不重复找人"：我主动发过、他还没回 → paused=true，
      // 本轮起不再对他开口，直到他主动说一句话（由 refreshReply 自动解除）。
      paused: false, pausedAt: 0,
      lastIncomingAt: 0, lastIncomingText: '',
      lastCheckAt: 0, sentCount: 0
    };
  }
  // 兼容旧存档：没有 lastProactiveAt 的，用 lastMsgAt 兜底迁移一次
  if (!Number(f.lastProactiveAt) && Number(f.lastMsgAt) > 0) {
    f.lastProactiveAt = Number(f.lastMsgAt);
    f.lastProactiveText = String(f.lastMsgText || '');
  }
  return f;
}

/* ═══════════════════════════ 叫醒节奏 ═══════════════════════════ */

/** 下一次醒来的间隔（毫秒）。每次重新随机，避免像打卡。 */
function nextDelayMs(s) {
  const { min, max } = parseWakeRange(s.wakeRange);
  return rand(min, max) * 60000;
}

/**
 * 后台循环：醒来 → 判断 → 让 AI 决定 → 发出 → 记录 → 继续睡。
 * 幂等（已经在跑就直接返回），所以 activate 和钩子都可以放心调。
 */
function startLoop() {
  if (timer) return false;
  const s = settings();
  if (s.enabled === false) return false;
  const wake = parseWakeRange(s.wakeRange);
  const first = Math.max(20, rand(0.7, 1.3) * Math.min(5, wake.min)) * 1000;
  const tick = async () => {
    try {
      await runCycle();
    } catch (e) {
      api?.warn?.(`主动私信这一轮出错（不影响下一轮）：${e?.message ?? e}`);
    }
    timer = setTimeout(tick, nextDelayMs(settings()));
    timer.unref?.();
  };
  timer = setTimeout(tick, first);
  timer.unref?.();
  const t = parseTargets(s);
  const quiet = parseQuietRange(s.quietRange);
  const quota = parseCountRange(s.targetSendRange, 1, 1, 20);
  api?.log?.(`主动私信已启动（${BUILD_TAG}）：每 ${wake.min}~${wake.max} 分钟醒一次，`
    + (t.configured
      ? `只检查指定的 ${t.list.length} 个 QQ（逐个都查）：${t.list.map((x) => x.qq
        + `(冷场${x.idleMinMinutes ?? num(s.targetIdleMinMinutes, 30, 1, 1440)}分/冷却${x.cooldownMinMinutes ?? num(s.cooldownMinutes, 120, 1, 1440)}分)`).join('、')}，`
      : '检查白名单里所有私聊（每轮挑最久没聊的），')
    + `每轮最多发 ${quota.min}-${quota.max} 人，`
    + `睡眠时间 ${quiet ? quiet.label : '未设置'}（不打扰），每天最多 ${num(s.maxPerDay, 5, 0, 100)} 条`
    + (s.liangwenfengEnabled === false
      ? '｜梁文峰时期：已关闭'
      : `｜梁文峰时期：周${parseDays(s.lwfDays).join('/')} ${parsePeriods(s.lwfPeriods).map((p) => p.label).join('、') || '(未设时段)'} 禁发`)
    + `${s.dryRun === true ? '｜演练模式：只记日志不真发' : ''}｜存档 ${STORE}`);
  return true;
}

function stopLoop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ═══════════════════════════ 第 2 步：现在能不能发 ═══════════════════════════ */

/**
 * 本地规则，全部不花 token。任何一条不满足就继续睡。
 * @returns {{ok: boolean, reason: string}}
 */
function canSendNow(state, s, now) {
  if (s.enabled === false) return { ok: false, reason: '总开关已关闭' };
  // 梁文峰时期：工作时段一键禁发（周末/非生效日不受影响）
  const lwf = inLiangwenfengPeriod(s, now);
  if (lwf.active) return { ok: false, reason: `梁文峰时期（${lwf.reason} 工作时段，禁发）` };
  const quiet = inQuietNow(s, now);
  if (quiet.active) return { ok: false, reason: `你的睡眠时间（${quiet.reason}，不打扰）` };
  if (state.dayKey !== dayKeyOf(now)) { state.dayKey = dayKeyOf(now); state.dayCount = 0; }
  if (Number(state.dayCount) >= num(s.maxPerDay, 5, 0, 100)) return { ok: false, reason: `今天已经主动发了 ${state.dayCount} 条（上限 ${num(s.maxPerDay, 5, 0, 100)}）` };
  // 注：这里**没有**"距上次发送的全局间隔"了。1.1.0 起同一轮允许连发多人
  // （targetSendRange），靠"每轮随机上限 + 个人冷却 + 每日上限"三道闸控制频率；
  // 一轮内两条之间的间隔由 sendGapSec 控制，不在这个函数里。
  return { ok: true, reason: '' };
}

/* ═══════════════════════════ 第 3 步：翻开最近的私信记录 ═══════════════════════════ */

/* ═══════════════════════════ 念想联动（02.md 5.1，2026-10-24）═══════════════════════════
 * mind-wish 插件把「她此刻惦记的事」以 mind.wishes 能力暴露出来（软依赖）。
 * 这里只做两件事，都守「机会闸门，不写内容」的口径：
 *   ① 把 Top 念想作为**可选话题**注入判断提示词（想提就提，不想提也不勉强）；
 *   ② 强 person 念想恰好对上这个人时，冷场门槛下调 20% —— 只让她"可以更早开口"，
 *      不构成"必须开口"。
 * mind-wish 没装/没启用时拿不到 → wishes 为空数组，一切行为与从前完全一致。 */

/** 读 Top 念想（每轮 runCycle 取一次，同步传给 pickFriend / buildPrompt）。 */
function wishContext() {
  try {
    const r = api?.capability?.('mind.wishes', { top: 3 });
    const list = Array.isArray(r) ? r : [];
    return list
      .filter((w) => w && String(w.text || '').trim())
      .map((w) => ({
        key: String(w.key || ''),
        text: String(w.text || '').trim(),
        kind: String(w.kind || 'thing'),
        at: Number(w.at) || 0,
        score: Number(w.score) || 0
      }));
  } catch { return []; }
}

/**
 * 念想拉力（纯函数，可测）：Top 里有没有「强到想找这个人说」的 person 类念想。
 * 判据：kind === 'person' 且 score > 0.65，且对方昵称（≥2 字）出现在念想文本里。
 * 昵称对不上就当作没拉力 —— 拿不准时往"不多打扰"的方向倒。
 */
export function wishPullFor(wishes, peerName) {
  const name = String(peerName || '').trim();
  if (!name || name.length < 2) return { pulled: false, wish: null };
  for (const w of Array.isArray(wishes) ? wishes : []) {
    if (!w || w.kind !== 'person') continue;
    if (!(Number(w.score) > 0.65)) continue;
    if (String(w.text || '').includes(name)) return { pulled: true, wish: w };
  }
  return { pulled: false, wish: null };
}

/** 拉力下的冷场门槛（纯函数，可测）：拉力成立且原门槛 > 0 → 下调 20%（最低 1 分钟）。
 *  原门槛为 0（非点名模式，本来就没有冷场闸）时原样返回 —— 不能把"无门槛"变成"1 分钟门槛"。 */
export function coldGateMin(baseMin, pulled) {
  const base = Math.round(Number(baseMin) || 0);
  if (!pulled || base <= 0) return base;
  return Math.max(1, Math.round(base * 0.8));
}

/**
 * 旅行近况一行（纯函数，可测）：从 travel-whale 存档拼「在哪、和谁、干什么」。
 * 两态：在旅途（trip 时间窗内）= 地点 + 同行 + 旅程主题；在家 = 庭院 + 正在做的事。
 * 拼不出任何有效信息 → ''（提示词里不出现这一段）。
 */
export function formatTravelLine(st, now = Date.now()) {
  if (!st || typeof st !== 'object') return '';
  const t = st.trip && typeof st.trip === 'object' ? st.trip : {};
  const departAt = Number(t.departAt) || 0;
  const returnAt = Number(t.returnAt) || 0;
  if (departAt > 0 && returnAt > 0 && now >= departAt && now <= returnAt) {
    const place = [t.country, t.city].filter(Boolean).join('·');
    const mate = String(t.companionName || '').trim();
    const phase = String(t?.phase?.name || '').trim();
    let s = place ? `你正在【${place}】旅行` : '你正在外面旅行';
    if (mate) s += `，和${mate}同行`;
    if (phase) s += `，这段旅程的主题是「${phase}」`;
    return s;
  }
  const act = st.homeAct && typeof st.homeAct === 'object' ? st.homeAct : {};
  const detail = String(act.detail || act.act || '').trim();
  const mate = String(act.mate || '').trim();
  if (!detail) return '';
  return `你在自家庭院：${cap(detail, 60)}${mate && mate !== detail ? `（和${cap(mate, 20)}一起）` : ''}`;
}

/** 读 travel-whale 的家会话存档，返回旅行近况一行（软依赖：没装/没配/读不到 → ''）。
 *  路径约定与 qqzone 读明信片同款：config.skills['travel-whale'].homeChatKey →
 *  <data>/skills/travel-whale/chats/<转义后的 homeKey>.json */
function travelNowLine(now = Date.now()) {
  try {
    const conf = getConfig() || {};
    const home = String(conf?.skills?.['travel-whale']?.homeChatKey || '').trim();
    if (!home) return '';
    const file = path.join(DATA_DIR_FALLBACK, 'skills', 'travel-whale', 'chats',
      `${home.replace(/[^a-z0-9_]/gi, '_')}.json`);
    return formatTravelLine(JSON.parse(fs.readFileSync(file, 'utf8')), now);
  } catch { return ''; }
}

/**
 * 浏览所有私聊会话：**每轮把每个人的最新情况都记一遍**，再挑一个最值得开口的。
 * 只在私聊里看；群聊连读都不读。
 *
 * ⚠️ "记所有人"这件事修过一次（实测踩到）：原来只记录被挑中的那一个，
 *    于是存档里除了被选中的会话，别人的"你最后说了什么"永远停留在很久以前 ——
 *    看起来像插件读不到消息，实际上是**只记了它当时想找的那个人**。
 *    现在每轮把全部私聊的最新发言刷新到存档（纯本地操作，不花 token）。
 *
 * @returns {{candidates: object[], refreshed: number, missing: string[], configured: boolean}}
 */
function pickFriend(state, s, now, src = null, wishes = []) {
  const cfg = getConfig() || {};
  const view = src || chatData();
  const targets = parseTargets(s);
  const defaultIdleMin = num(s.targetIdleMinMinutes, 30, 1, 24 * 60);
  const defaultCooldownMin = num(s.cooldownMinutes, 120, 1, 24 * 60);

  // 指定了 QQ 号 → 只认这几个；没指定 → 沿用白名单里所有私聊
  const wanted = targets.configured
    ? new Map(targets.list.map((t) => [`private:${t.qq}`, t]))
    : null;

  const present = new Set(view.listChats());
  const candidates = [];
  const pausedList = [];                 // 被他"没回"规则拦住的人（供日志/状态解释用）
  let refreshed = 0;

  for (const chatKey of view.listChats()) {
    // 逐条探针（只在 QQ_AGENT_DM_DEBUG=1 时输出）：排查"候选为什么是 0"
    const why = (r) => dbg(`${chatKey} 落选：${r}`);
    if (!isPrivate(chatKey)) { why('不是私聊'); continue; }   // ← 群聊一律不管
    if (!inWhitelist(chatKey, cfg)) { why('不在聊天白名单里'); continue; }
    const target = wanted ? wanted.get(chatKey) : undefined;
    if (wanted && target === undefined) { why('指定模式下没点名'); continue; }

    let recent = [];
    try {
      recent = (view.recent(chatKey, { limit: RECENT_LIMIT, includeSelf: true }) || []).filter((m) => !m.recalled);
    } catch { why('读会话记录失败'); continue; }
    const last = recent[recent.length - 1];
    if (!last) continue;                               // 从没说过话的会话不主动

    const lastIncoming = [...recent].reverse().find((m) => !m.self) || null;
    const f = friendOf(state, chatKey);
    const lastIn = Number(lastIncoming?.ts) || 0;

    // ① 每轮刷新"你最后说了什么"，并判断**我主动发的那条**有没有被你回复。
    //
    // ⚠️ 关键口径（2026-10-04 用户指出）：对话永远是 AI 垫底（你说话 → 机器人回），
    //    所以"机器人最后发言 + 你没再说话"这个状态在正常聊天后**永远成立**。
    //    如果拿它当"你没回"，就会把**刚才还在跟机器人聊天的人**误判成没回。
    //    正确做法：只认 lastProactiveAt（**插件主动发出**的那条）——它在
    //    rememberSend 里写入，机器人被动回复不会动它。
    const repliedToProactive = lastIn > 0 && lastIn > Number(f.lastProactiveAt || 0);
    if (lastIn > Number(f.lastIncomingAt)) {
      f.lastIncomingAt = lastIn;
      f.lastIncomingText = cap(String(lastIncoming?.text ?? ''), 200);
    }
    f.replied = repliedToProactive;            // 只表示"我主动那条被回了没"（供 UI 看）
    if (f.paused && repliedToProactive) {
      // 他回了我主动那条 → 解除暂停
      f.paused = false;
      f.pausedAt = 0;
      api?.log?.(`主动私信：${chatKey} 你回了我主动发的那条，"等回复中"已解除`);
    }
    f.lastCheckAt = now;
    refreshed += 1;

    // ①.5 省 token：我主动发过、你还没回 → 不再对你开口
    //      （注意判据是 lastProactiveAt，不是"机器人是否最后发言"）
    const waitingReply = Number(f.lastProactiveAt) > 0 && !repliedToProactive;
    if (s.noRepeatWhenUnreplied === false) {
      // 功能关掉时顺手清掉陈旧标记，避免"关了但存档里还写着等回复中"的自相矛盾
      if (f.paused) { f.paused = false; f.pausedAt = 0; }
    } else if (f.paused && waitingReply) {
      dbg(`${chatKey} 暂停中（我主动那条你还没回，等你先说话）`);
      pausedList.push({ chatKey, f });
      continue;
    } else if (f.paused) {
      f.paused = false;
      f.pausedAt = 0;
    }

    // ②.0 省 token 的硬规则（先于一切"能不能发"的判断）：
    //      我主动发过一次、你还没回 → 标记"等回复中"并**直接跳过**。
    //      为什么必须先判它：否则"冷却过了"的下一轮 AI 又会忍不住追第二句，
    //      token 就是这么烧掉的；而且被冷却挡住的人走不到发送分支，
    //      标记也不会被写上（状态面板就看不见"等回复中"）。
    if (s.noRepeatWhenUnreplied !== false && waitingReply) {
      if (!f.paused) {
        f.paused = true;
        f.pausedAt = f.lastProactiveAt;
        dbg(`${chatKey} 我主动那条你还没回 → 标记"等回复中"`);
      }
      pausedList.push({ chatKey, f });
      continue;
    }

    // ② 判断这个人现在能不能被主动
    const coldMs = lastIn > 0 ? now - lastIn : GIVE_UP_MS * 2;

    // ⚠️ 两个"分钟"是两件不同的事，别混（第一版就混了）：
    //   coldMin  = 他多久没说话才**值得**开口（冷场门槛）
    //   coolMs   = 上次主动之后至少隔多久才**允许**再开口（个人冷却）
    // 写成一个的话，"想让他 4 小时没说话才主动"会连带把冷却也变成 4 小时，
    // 语义互相打架。分开之后：「QQ:240」= 他 4 小时没说话才考虑，冷却不变。
    // 另外：冷场门槛只对"明确点名"的人生效（不点名时没有合理默认值可言）；
    // 个人冷却则**两种模式都生效**，这样它才真正替代了被删掉的全局间隔。
    const coldMin0 = wanted ? num(target?.idleMinMinutes ?? defaultIdleMin, defaultIdleMin, 1, 24 * 60) : 0;
    // ★ 念想拉力（02.md 5.1）：强 person 念想对上这个人 → 冷场门槛下调 20%。
    //   只调"多早**可以**开口"，不构成"必须开口"；对不上/没念想 → 原门槛。
    const pull = wishPullFor(wishes, String(lastIncoming?.senderName || ''));
    const coldMin = coldGateMin(coldMin0, pull.pulled);
    if (pull.pulled) {
      dbg(`${chatKey} 念想拉力：「${cap(pull.wish.text, 20)}」（score ${pull.wish.score}）→ 冷场门槛 ${coldMin0} → ${coldMin} 分钟`);
    }
    if (coldMin > 0 && coldMs < coldMin * 60000) {
      why(`还没冷场（他 ${Math.round(coldMs / 60000)} 分钟前说过话，门槛 ${coldMin} 分钟）`);
      continue;
    }

    const coolMs = num(target?.cooldownMinMinutes ?? defaultCooldownMin, defaultCooldownMin, 1, 24 * 60) * 60000;
    // 刚主动过、你还没回，也没过冷却 → 这次不打扰（"没回就不发第二句"开着的话，
    // 上面 ②.0 已经把它拦掉了，这里只是兜住"功能关闭"的情形）
    if (Number(f.lastMsgAt) > 0 && f.replied !== true && now - Number(f.lastMsgAt) < coolMs) {
      why(`个人冷却中（${Math.round((now - f.lastMsgAt) / 60000)} 分钟前主动过）`);
      continue;
    }
    if (coldMs > GIVE_UP_MS) { why('断太久（超过 14 天）'); continue; }   // 断太久，不诈尸

    const score = coldMs + (last.self ? 0 : 6 * 3600 * 1000);   // 最后一句是你说的 → 更值得接话
    candidates.push({ chatKey, recent, last, lastIncoming, coldMs, score, f, targeted: Boolean(wanted) });
  }

  // ③ 逐个检查时按"最久没聊"优先（冷的排前面），让 AI 先看最该关心的那个
  candidates.sort((a, b) => b.score - a.score);

  // ④ 指定了但从没跟机器人聊过（没有存档）→ 列出来，别让用户以为"填了没用"
  const missing = [];
  if (wanted) {
    for (const t of targets.list) {
      if (!present.has(`private:${t.qq}`)) missing.push(t.qq);
    }
  }
  return { candidates, refreshed, missing, configured: targets.configured, paused: pausedList };
}

/* ═══════════════════════════ 主宾防混与上下文清洗（v1.6.0 新增）═══════════════════════════
 *
 * 为什么 v1.5.1 改了 `我：` / `对方：` 之后大模型还是经常主宾颠倒？
 * 实测排查出四个叠加病灶：
 *   1. `[引用 小鲸鱼：我刚才去罗弗敦…] 对啊` 这类带引用头的消息，被 `cap(text, 80)`
 *      截断后只剩下被引用的机器人原话，行首却挂着 `对方：` → 模型当场把机器人的事当成对方的事。
 *   2. `对方（14:20）：我今天加班累死了，你在干嘛` 这一行里，行首是 `对方`，紧接着正文第一个字
 *      是 `我`（指对方）、后面又有 `你`（指机器人），与提示词里的 `你/我` 发生严重代词碰撞。
 *   3. 1.7 万字人设 + 对话记录全塞在单个 `role: 'system'` 里，且 JSON 让模型第一个字段就吐
 *      `"say"`（在 thinkingMode:'off' 下没有任何前置主宾确认步骤，张口就错）。
 *   4. 缺少发送前的自我复读/学舌拦截，偶发把刚问过对方的话换个标点又发一遍。
 *
 * 下面四个纯函数从结构上根治这四点，且零额外 API 调用开销。
 */

const QUOTE_HEAD_RE = /^\[引用\s*([^\]:：]+?)(?:\(QQ:\d+\))?\s*[：:]\s*([\s\S]*?)\]\s*/;
const CQ_TAG_RE = /\[CQ:[^\]]*\]/g;

/**
 * 清洗单条消息正文，剥离并转译 `[引用 某人：原文]` 协议头。
 *
 * 这样 `cap(..., RECENT_CHARS)` 截断的是**说话人自己真正说的话**，
 * 绝不会再把方括号里被引用的另一方长文留下来喧宾夺主。
 */
export function cleanMessageForPrompt(rawText, maxChars = RECENT_CHARS) {
  let t = String(rawText ?? '').replace(CQ_TAG_RE, '').trim();
  if (!t) return '（非文字消息）';

  let quoteNote = '';
  const m = t.match(QUOTE_HEAD_RE);
  if (m) {
    const qSnippet = String(m[2] || '').replace(/\s+/g, ' ').trim();
    if (qSnippet) {
      quoteNote = `（回应「${cap(qSnippet, 18)}」）`;
    }
    t = t.slice(m[0].length).trim();
  }
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return quoteNote ? `${quoteNote}（图片/表情）` : '（非文字消息）';
  return `${quoteNote}${cap(t, maxChars)}`;
}

/**
 * 将相邻同方向的连续短消息归并为「对话轮次（Turns）」，并用显式方向箭头锁死主客体：
 *   · 对方说的：`【对方(昵称) → 对你说】`
 *   · 机器人说的：`【你(botName) → 对Ta说】`
 */
export function groupRecentTurns(recent = [], { botName = '我', peerName = '对方', now = Date.now(), maxChars = RECENT_CHARS } = {}) {
  const list = Array.isArray(recent) ? recent.filter(Boolean) : [];
  if (!list.length) return [];

  const turns = [];
  for (const m of list) {
    const isSelf = Boolean(m.self);
    const ts = Number(m.ts) || 0;
    const cleaned = cleanMessageForPrompt(m.text, maxChars);
    const prev = turns[turns.length - 1];
    // 同一方向且间隔 ≤ 3 分钟的连续发言归并为一轮（最多合 3 句），还原真人连发语感
    if (prev && prev.self === isSelf && ts > 0 && prev.lastTs > 0 && (ts - prev.lastTs) <= 3 * 60_000 && prev.items.length < 3) {
      prev.items.push(cleaned);
      prev.lastTs = ts;
    } else {
      turns.push({
        self: isSelf,
        firstTs: ts,
        lastTs: ts,
        items: [cleaned]
      });
    }
  }

  return turns.map((turn, idx) => {
    const when = stamp(turn.lastTs, now);
    const ago = agoLabel(turn.lastTs, now);
    const timeTag = `${when}${ago ? `｜${ago}` : ''}`;
    const arrow = turn.self
      ? `【你(${botName}) → 对${peerName}说】`
      : `【对方(${peerName}) → 对你说】`;
    const body = turn.items.length === 1
      ? `「${turn.items[0]}」`
      : turn.items.map((x) => `「${x}」`).join(' ／ ');
    return {
      index: idx + 1,
      self: turn.self,
      ts: turn.lastTs,
      line: `[#${idx + 1}｜${timeTag}] ${arrow}：${body}`
    };
  });
}

/**
 * 构建《双方最后表态对账单》（Speaker Grounding Ledger）。
 * 用纯 JS 分别提取「对方最后对你说的话」与「你最后对对方说的话」并列展示，
 * 彻底杜绝模型把对方的处境当成自己的、或把自己刚问过的问题再问一遍。
 */
export function buildSpeakerLedger(pick, { botName = '我', peerName = '对方', now = Date.now() } = {}) {
  const recent = Array.isArray(pick?.recent) ? pick.recent : [];
  const lastPeerMsg = [...recent].reverse().find((m) => m && !m.self) || pick?.lastIncoming || null;
  const lastSelfMsg = [...recent].reverse().find((m) => m && m.self) || null;
  const lastOverall = pick?.last || recent[recent.length - 1] || null;
  const f = pick?.f || {};

  const lines = ['【双方最后表态对账单（发言前必核，严禁把两边经历或话语调换）】'];

  if (lastPeerMsg) {
    const peerAgo = agoLabel(lastPeerMsg.ts, now) || '刚刚';
    const peerClean = cleanMessageForPrompt(lastPeerMsg.text, 90);
    lines.push(
      `1. 👤 对方（${peerName}）最后对你说的话（${peerAgo}）：「${peerClean}」\n`
      + `   ↳ 归属锁死：这是【${peerName}】说的、是Ta那边的处境或问题，绝不是你（${botName}）说的！`
    );
  } else {
    lines.push(`1. 👤 对方（${peerName}）：近期无发言记录。`);
  }

  if (lastSelfMsg) {
    const selfAgo = agoLabel(lastSelfMsg.ts, now) || '刚刚';
    const selfClean = cleanMessageForPrompt(lastSelfMsg.text, 90);
    lines.push(
      `2. 🤖 你自己（${botName}）最后对${peerName}说的话（${selfAgo}）：「${selfClean}」\n`
      + `   ↳ 归属锁死：这是【你自己】已经发出去过的话，绝不要当成对方说的，也不要原样复读再问一遍！`
    );
  } else {
    lines.push(`2. 🤖 你自己（${botName}）：近期尚未回复过对方。`);
  }

  if (lastOverall) {
    const overallAgo = agoLabel(lastOverall.ts, now) || '刚刚';
    lines.push(
      `3. ⏸️ 当前停顿位置：整个对话停在 ${overallAgo}，最后一句是`
      + (lastOverall.self
        ? `【你自己】说的（你发完后对方还没接话，不要追问同一件事，要么换个轻松的新由头，要么选 say:null 安静待着）。`
        : `【对方（${peerName}）】说的（对方说完后你还没接，可以自然接Ta的话茬或开启新话题）。`)
    );
  }

  if (Number(f.lastProactiveAt || f.lastMsgAt) > 0) {
    const pAt = Number(f.lastProactiveAt || f.lastMsgAt);
    const pText = String(f.lastProactiveText || f.lastMsgText || '');
    lines.push(
      `4. 📌 上次主动私信记录：你在 ${agoLabel(pAt, now)} 主动发过「${cap(pText, 60)}」——`
      + (f.replied === true ? '对方已经回过了。' : '对方**一直没回**（严禁连着催问）。')
    );
  } else {
    lines.push('4. 📌 上次主动私信记录：你之前还没主动找过Ta。');
  }

  return lines.join('\n');
}

/**
 * 提取二元组（2-gram）用于本地复读检测：
 * 防止模型把自己的上一句话、或者对方的上一句话换个标点复读出来。
 */
function textGrams(s) {
  const clean = String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  if (!clean) return set;
  if (clean.length < 2) { set.add(clean); return set; }
  for (let i = 0; i < clean.length - 1; i += 1) {
    set.add(clean.slice(i, i + 2));
  }
  return set;
}

function gramOverlap(a, b) {
  const A = textGrams(a);
  const B = textGrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / Math.min(A.size, B.size);
}

/**
 * 检查候选发送文本是否复读了最近几条消息（含自己刚说的或对方刚说的）。
 * 返回 `{ echoed: boolean, reason: string }`。
 */
export function checkEchoGuard(candidateText, pick) {
  const cand = String(candidateText ?? '').trim();
  if (!cand || cand.length < 4) return { echoed: false, reason: '' };

  const recent = Array.isArray(pick?.recent) ? pick.recent.slice(-4) : [];
  for (const m of recent) {
    const ref = cleanMessageForPrompt(m?.text, 120).replace(/^（回应「[^」]*」\）/, '').trim();
    if (!ref || ref.length < 4) continue;
    const sim = gramOverlap(cand, ref);
    if (sim >= 0.78) {
      const whoLabel = m.self ? '自己上一句' : '对方原话';
      return { echoed: true, reason: `与${whoLabel}「${cap(ref, 24)}」高度重合(${Math.round(sim * 100)}%)` };
    }
  }
  const lastPro = String(pick?.f?.lastProactiveText || pick?.f?.lastMsgText || '').trim();
  if (lastPro.length >= 4 && gramOverlap(cand, lastPro) >= 0.75) {
    return { echoed: true, reason: `与上次主动私信「${cap(lastPro, 24)}」重复` };
  }
  return { echoed: false, reason: '' };
}

/**
 * 构建 `role: 'system'` 专属的稳定角色与输出协议提示词（与 user 上下文分离）。
 */
export function buildSystemRolePrompt(chatKey, s) {
  const p = personaForChat(chatKey) || {};
  const name = String(p.botName || '机器人').trim() || '机器人';
  const role = personaTextOf(chatKey, s.personaMaxChars);
  const parts = [
    `你是「${name}」。你现在处于 QQ 1对1 私聊的「主动想起对方」判断环节。`,
    '【核心视角铁律（最高优先级）】',
    `1. 你是「${name}」（记录中标为【你(${name}) → 对Ta说】的那一方）。`,
    '2. 聊天记录中标为【对方(昵称) → 对你说】的每一句话，都是**对方对你说的话**（里面的"我"指代对方自己，"你"指代你）。绝不能把对方说的话、对方做的事当成你自己的！',
    '3. 聊天记录中标为【你 → 对Ta说】的每一句话，都是**你之前已经对Ta说过的话**。绝不能把你自己说过的话当成对方说的，也绝不能把已经问过的问题原样再问一遍！'
  ];
  if (role) parts.push(`【你的人设（不能违背）】\n${role}`);
  if (String(p.customRules || '').trim()) parts.push(`【附加规则】\n${String(p.customRules).trim()}`);
  if (String(s.personaNote || '').trim()) parts.push(`【额外要求】\n${String(s.personaNote).trim()}`);
  return parts.join('\n\n');
}

/** 组装给 AI 的判断材料：最近聊了什么 + 双方最后表态对账单 + 念想/旅行近况。（保持向后兼容签名） */
function buildPrompt(pick, chatKey, s, now, wishes = [], travelLine = '') {
  const p = personaForChat(chatKey) || {};
  const name = String(p.botName || '机器人').trim() || '机器人';
  const peerName = String(pick.lastIncoming?.senderName || '对方').trim() || '对方';

  const turns = groupRecentTurns(pick.recent, {
    botName: name,
    peerName,
    now,
    maxChars: RECENT_CHARS
  });
  const lines = turns.map((t) => t.line).join('\n');

  const parts = [];
  parts.push(
    `【当前私聊对象】你（「${name}」）正在回想与私聊对象「${peerName}」的对话。\n`
    + `每条记录均已标明方向：【对方(${peerName}) → 对你说】是Ta发给你的消息；【你(${name}) → 对${peerName}说】是你发给Ta的消息。`
  );

  // 兼容直接单测调用 buildPrompt 的场景：若外层未拆 system，人设说明仍可被识别
  const role = personaTextOf(chatKey, s.personaMaxChars);
  if (role) parts.push(`【你的人设（不能违背）】\n${role}`);
  if (String(p.customRules || '').trim()) parts.push(`【附加规则】\n${String(p.customRules).trim()}`);
  if (String(s.personaNote || '').trim()) parts.push(`【额外要求】\n${String(s.personaNote).trim()}`);

  parts.push(
    '【最近的私信记录（按时间从早到晚排列，已合并连续短句并剥离引用干扰）】\n'
    + '（每条括号里的"多久以前"是真实间隔，请严格以它为准 —— '
    + '只写时刻的是今天，写了月-日或"N 天前"的不是今天）\n'
    + (lines || '（暂无历史记录）')
  );

  // ★ 核心升级：插入纯 JS 生成的《双方最后表态对账单》
  parts.push(buildSpeakerLedger(pick, { botName: name, peerName, now }));

  const lastLine = pick.last || pick.recent[pick.recent.length - 1] || null;
  const lastLineAgo = lastLine ? agoLabel(lastLine.ts, now) : '';

  parts.push(
    `现在是北京时间 ${new Date(Number(now) + BJ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')}`
    + `（星期${'日一二三四五六'[new Date(Number(now) + BJ_OFFSET_MS).getUTCDay()]}）。`
  );
  parts.push(
    '【关于时间，务必注意】\n'
    + '上面每条记录括号里的「多久以前」是准确值，**照着它说话**。\n'
    + '只写了时刻（如 17:33）的是今天；写了月-日（如 10-01 17:33）或写了「N 天前」的，就**不是今天**，别当成几小时前。\n'
    + '不要凭时刻差自己推算间隔 —— 跨天时那样一定会算错（例如把 3 天前误当成 3 小时前）。'
  );
  parts.push(
    '【你现在想起了这个人】\n'
    + `距离你们上一句已经过了 ${lastLineAgo || '一会儿'}。不用急着说话 —— 先对照上面的【双方最后表态对账单】在心里过一下：\n`
    + `· 刚才最后一句是谁说的？如果是【${peerName}】说的且还留着话头，你可以顺着回应Ta；\n`
    + `· 如果最后一句是【你自己】说的，说明你已经表过态或问过问题了，**千万不要把你自己的话当成Ta说的，也不要重复追问同一件事**；\n`
    + '· 如果上一轮已经收尾了（说过晚安、先忙、回头聊），可以像忽然想起对方一样，用下面的念想或近况开个轻松的新话头；\n'
    + '· 如果对方一直没回你上一条，除非真有新东西，否则别发 —— **想起来了但没话，选 say:null 是最自然的状态。**'
  );

  const wishLines = wishes.map((w, i) =>
    `${i + 1}. ${cap(w.text, 60)}${w.at ? `（${agoLabel(w.at, now)}想起的${w.score > 0.65 ? '，挺想说的' : ''}）` : ''}`);
  if (wishLines.length) {
    parts.push(
      '【你此刻心里惦记的事（可选话题）】\n'
      + '（这些是你自己的心事，不是任务清单。想提就提 —— 自然地当成"忽然想跟你说的事"；\n'
      + '　不想提、或跟这个人不相关，就当没看见。别报编号、别念清单、别一次全倒出来。）\n'
      + wishLines.join('\n')
    );
  }

  if (travelLine) {
    parts.push(
      '【没话找话的小由头（权重最低）】\n'
      + `旅行近况：${travelLine}\n`
      + '（这是你自己的生活背景，不是对方的。实在没话、又想搭句话时，才拿它当由头顺口分享一句。）'
    );
  }

  parts.push(
    '【你的话头从哪儿来】\n'
    + (wishLines.length || travelLine
      ? '· 从上面那段对话、或给你的话题里挑**真的想说的**那一件长出来。别编没发生过的情节、别把你自己的事说成对方的事。\n'
      : '· 只从上面那段对话里长出来。别编没发生过的情节、别把你自己的事说成对方的事。\n')
    + '· 拿不准对方的意思就直接问，别顺着自己的猜想去演。'
  );
  parts.push(
    '【怎么说】\n'
    + '· 只发**这一句话**，越短越好（一般 2~15 个字，最多一句）。\n'
    + '· 口语、像真人打字，不要客服腔、不要说教、不要解释、不要旁白、不要引号、不要 emoji 堆砌、不要 Markdown、不要换行。\n'
    + '· 不要查户口（不问工作、收入、住址、感情），不要连发问句，一句话最多一个问号。\n'
    + '· 不要提"系统/主动私信/好感度/等级"这类东西。'
  );
  // ★ 核心升级：调整 JSON 字段顺序为 lastState → mind → say，在关闭思考模式下强制先完成主宾对齐再吐出 say
  parts.push(
    '【输出格式】只输出一个 JSON，不要加别的东西（务必按顺序先写 lastState 和 mind，最后写 say）：\n'
    + '{"lastState":"用15字以内概括：刚才对方最后说了啥、我最后说了啥","mind":"你此刻心里在想什么（很短，不会发出去）","say":"你想对Ta说的那句话"'
    + (wishLines.length ? ',"saidWish":<编号：这次开口说的是「惦记的事」里的第几件；没提就是 null>' : '')
    + '}\n'
    + '或者 —— 想起来了但没什么要说：\n'
    + '{"lastState":"用15字以内概括双方停在哪","mind":"你此刻心里在想什么","say":null}'
  );
  return parts.join('\n\n');
}

/* ═══════════════════════════ 第 4 步：问 AI ═══════════════════════════ */

/** 从模型输出里抠出决定。兼容 `{lastState, mind, say}` 与旧版 `{say, mind}` / `{send, message}`。 */
function parseDecision(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { send: false, reason: '模型返回空', mind: '', lastState: '' };
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const lastState = String(obj.lastState ?? '').trim().slice(0, 80);
      const mind = String(obj.mind ?? obj.thought ?? '').trim().slice(0, 120);
      const hasSay = Object.prototype.hasOwnProperty.call(obj, 'say');
      if (hasSay) {
        const rawSay = obj.say;
        const sayText = (rawSay === null || rawSay === undefined) ? '' : String(rawSay).trim();
        const wishNo = Number(obj.saidWish);
        return {
          send: Boolean(sayText),
          message: sayText,
          reason: sayText ? '' : String(obj.mind || obj.reason || '想起来了，但没话').slice(0, 60),
          mind,
          lastState,
          wishIdx: Number.isFinite(wishNo) && wishNo >= 1 && wishNo <= 10 ? Math.round(wishNo) : 0
        };
      }
      const send = obj.send === true || String(obj.send).toLowerCase() === 'true' || obj.decision === 'send';
      const message = String(obj.message ?? obj.text ?? obj.content ?? '').trim();
      return { send: send && Boolean(message), message, reason: String(obj.reason ?? ''), mind, lastState, wishIdx: 0 };
    } catch { /* 落到下面按纯文本处理 */ }
  }
  if (/^(不发|不说|不主动|不用发|不发送|no|false|-)$/i.test(cleaned)) return { send: false, reason: '模型决定不发', mind: '', lastState: '' };
  const one = cleaned.split(/\n+/)[0].trim().replace(/^["“'']+|["”'']+$/g, '').trim();
  if (one) return { send: true, message: one, reason: '（非 JSON 输出，按正文发送）', mind: '', lastState: '' };
  return { send: false, reason: '模型没给出可用内容', mind: '', lastState: '' };
}

async function askAI(pick, chatKey, s, now, wishes = [], travelLine = '') {
  if (typeof internals.aiOverride === 'function') return internals.aiOverride(pick, chatKey, s, now);
  const llm = await import('../../src/llm.js');
  // ★ v1.6.0：将「角色身份与主宾铁律」放在 system，将「结构化私聊剧本与对账单」放在 user，
  //   避免所有文本糊在单个 system 消息里导致模型失去角色边界感。
  const sysContent = buildSystemRolePrompt(chatKey, s);
  const userContent = buildPrompt(pick, chatKey, s, now, wishes, travelLine);
  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: sysContent },
      { role: 'user', content: userContent }
    ],
    temperature: 0.85,
    maxTokens: OUT_MAX_TOKENS,
    skillContext: { thinkingMode: 'off' }
  });
  const raw = res?.message?.content;
  const text = Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
  const decision = parseDecision(text);

  // ★ v1.6.0 发送前复读/鹦鹉学舌硬闸：若生成的 say 只是把自己的上一句或对方的上一句复读了一遍，直接拦截
  if (decision.send && decision.message) {
    const echo = checkEchoGuard(decision.message, pick);
    if (echo.echoed) {
      dbg(`${chatKey} 触发复读拦截：${echo.reason}｜原拟发送：「${decision.message}」`);
      return {
        ...decision,
        send: false,
        message: '',
        reason: `本地防复读拦截（${echo.reason}）`
      };
    }
  }
  return decision;
}

/* ═══════════════════════════ 第 5 步：发出去 ═══════════════════════════ */

/** 发之前把不该出现在 QQ 消息里的东西清掉（含万一残留的箭头前缀）。 */
function cleanOutgoing(text) {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.split(/\n+/)[0];
  t = t.replace(/^["“'']+|["”'']+$/g, '').trim();
  t = t.replace(/^(?:【[^】]*】\s*[:：]?\s*)/, '').trim();
  t = t.replace(/^(?:回复|消息|我|对方)[:：]\s*/, '').trim();
  if (t.length > 120) t = t.slice(0, 120);
  return t;
}

/**
 * 发送用的 fetch。
 *
 * ⚠️ 这里**不用**技能 API 递来的那个 fetch（`api.fetch`）——实测踩到：
 *    它在本机是坏的，一调用就抛 `originalFetch is not a function`
 *    （核心的 fetch 被某个插件包了一层，包装函数里引用了不存在的 originalFetch）。
 *    表现极具迷惑性：AI 每次都正常判断"该发"，然后五个人全部发送失败、
 *    一条都发不出去。所以直接用全局 fetch（Node/Electron 自带，稳）。
 */
function doFetch(url, init) {
  const f = globalThis.fetch || fetchRef;
  if (typeof f !== 'function') throw new Error('运行环境没有可用的 fetch');
  return f.call(globalThis, url, init);
}

/**
 * 取 OneBot 的 HTTP 地址与访问令牌。
 *
 * ⚠️ 令牌**不能只信程序配置**（2026-10-04 实测踩到，是"发不出去"的另一半根因）：
 *   核心出于安全考虑，对插件暴露的配置里会把令牌抹掉（sanitizeConfig）。
 *   插件于是拿着空令牌去请求，OneBot 回 401 —— 表现极具迷惑性：AI 判断全正常，
 *   就是一条都发不出去。实测证据：插件发出的请求头只有 content-type，没有 authorization。
 *
 * 所以这里按"先尊重程序配置、不行再自己找"的顺序来：
 *   ① 程序配置里 base+token 齐全 → 直接信它
 *   ② base 有、token 空 → 去 SnowLuma 配置目录（onebot_<QQ>.json 的
 *      networks.httpServers[0]）把令牌补上
 *   ③ 两边都没有 → 读一份候选，逐个探活，挑真正能用的那份
 *
 * 参考了 plugins/friend-gate 的同款做法：只认 onebot_*.json，避免挑到无关配置。
 */
let snowCache = { at: 0, list: [] };

/** 收集 SnowLuma 配置里的 HTTP 接入点候选（带 30 秒缓存） */
function snowlumaCandidates() {
  if (Date.now() - snowCache.at < 30000) return snowCache.list;
  const list = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // plugins/<id>/ → app 根
    const appRoot = path.resolve(here, '..', '..');
    const dirs = [
      path.join(appRoot, 'snowluma', 'config'),
      path.join(appRoot, 'resources', 'snowluma', 'config'),
      path.join(appRoot, '..', 'snowluma', 'config')
    ];
    for (const dir of dirs) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!/^onebot_.*\.json$/i.test(f)) continue;
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const hs = (j?.networks?.httpServers) || [];
            const ws = (j?.networks?.wsServers) || [];
            const port = Number(hs[0]?.port || 3000);
            const tk = String(hs[0]?.accessToken || ws[0]?.accessToken || '');
            const qq = (f.match(/onebot_(\d+)/) || [])[1] || '';
            if (tk) list.push({ base: `http://${hs[0]?.host || '127.0.0.1'}:${port}`, token: tk, file: f, qq });
          } catch { /* 跳过坏文件 */ }
        }
        if (list.length) break;      // 找到一个有效目录就够了
      } catch { /* 试下一个目录 */ }
    }
  } catch { /* 忽略 */ }
  snowCache = { at: Date.now(), list };
  return list;
}

/** 候选里探活：哪个令牌真能用（get_status 需要认证，正好当探针） */
async function snowlumaPick() {
  const appCfg = getConfig()?.snowluma || {};
  const appBase = String(appCfg.httpUrl || '').replace(/\/+$/, '');
  const appToken = String(appCfg.httpAccessToken || appCfg.accessToken || '');

  const cands = snowlumaCandidates();
  // ① 程序配置里齐全 → 信它（但仍探一次，避免拿着失效令牌闷头发 401）
  const tries = [];
  if (appBase && appToken) tries.push({ base: appBase, token: appToken, from: '程序配置' });
  // ② 程序配置缺令牌，或上面那份探不通 → 用 SnowLuma 的
  for (const c of cands) {
    const base = appBase || c.base;
    if (tries.some((t) => t.token === c.token && t.base === base)) continue;
    tries.push({ base, token: c.token, from: `SnowLuma(${c.file})` });
  }
  if (!tries.length) tries.push({ base: appBase || 'http://127.0.0.1:3000', token: appToken, from: '默认' });

  for (const t of tries) {
    if (!t.token) continue;
    try {
      const res = await doFetch(`${t.base}/get_status`, {
        headers: { authorization: `Bearer ${t.token}` },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) { dbg(`令牌可用：${t.base}（来源 ${t.from}）`); return t; }
      dbg(`令牌探活失败 HTTP ${res.status}：${t.base}（来源 ${t.from}）`);
    } catch (e) {
      dbg(`令牌探活异常：${t.base}（来源 ${t.from}）：${e?.message ?? e}`);
    }
  }
  // 全都探不通 → 用程序配置里的（至少和以前行为一致），并说清原因
  const fallback = tries[0];
  dbg(`⚠️ 没有探到可用令牌，退回：${fallback.base}（来源 ${fallback.from}，令牌${fallback.token ? '有' : '为空'}）`);
  return fallback;
}

/** OneBot HTTP 直发（核心发送队列能力拿不到时的兜底，范式同 plugins/reminder）。 */
async function onebotSend(chatKey, text) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) throw new Error(`会话键不合法：${chatKey}`);
  const { base, token, from } = await snowlumaPick();
  const res = await doFetch(`${base}/${m[1] === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(m[1] === 'private'
      ? { user_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }
      : { group_id: Number(m[2]), message: [{ type: 'text', data: { text: escapeCqText(text) } }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    throw new Error(res.status === 401
      ? `OneBot HTTP 401（令牌没被接受，来源：${from}。程序配置里的令牌通常是被抹空的，插件会自己去 SnowLuma 配置里找）`
      : `OneBot HTTP ${res.status}`);
  }
}

/**
 * 把一句话作为私信发出去。**只允许私聊**（第二道闸门，防止上游传错）。
 * 优先走核心发送队列（限频/去重/留档/界面刷新），失败再走 HTTP + 手动留档。
 */
async function sendPrivate(chatKey, text) {
  if (!isPrivate(chatKey)) return { ok: false, reason: `拒绝发送：目标不是私聊（${chatKey}）` };

  // ⓪ 核心发送队列（2026-10-24，§3.1 收尾）：限频/去重/留档全在里面 —— 首选通道。
  //    services 未就绪时静默跳过，走下面的能力通道 → OneBot HTTP 兜底（降级红线）。
  try {
    const svc = api?.services?.();
    if (svc?.sendProactive) {
      const done = await svc.sendProactive(chatKey, text);
      dbg(`发送通道 services.sendProactive → ${JSON.stringify(done).slice(0, 80)}`);
      return { ok: true, via: 'core-sender' };
    }
  } catch (e) {
    dbg(`核心队列发送失败，降级：${e?.message ?? e}`);
  }

  for (const capName of ['affinity.send', 'chat.send']) {
    try {
      const r = api?.capability?.(capName, { chatKey, text });
      const done = r && typeof r.then === 'function' ? await r : r;
      dbg(`发送通道 ${capName} → ${done ? JSON.stringify(done).slice(0, 120) : 'undefined'}`);
      if (done && done.ok) return { ok: true, via: done.via || capName };
    } catch (e) {
      dbg(`发送通道 ${capName} 抛错：${e?.message ?? e}`);
    }
  }
  if (!fetchRef && typeof globalThis.fetch !== 'function') {
    return { ok: false, reason: '没有可用的发送通道（核心没提供发送能力，运行环境也没有 fetch）' };
  }
  const snow = getConfig()?.snowluma || {};
  dbg(`走 OneBot HTTP 直发：base=${snow.httpUrl}｜token=${(snow.httpAccessToken || snow.accessToken) ? '有' : '❌空'}`);
  try {
    await onebotSend(chatKey, text);
    dbg(`OneBot HTTP 发送成功：${chatKey}「${text}」`);
    // 手动留档：否则模型下一轮看不到自己说过这句
    try { chatData().appendSelf?.(chatKey, { text, ts: Date.now() }); } catch { /* 留档失败不致命 */ }
    return { ok: true, via: 'http' };
  } catch (e) {
    dbg(`OneBot HTTP 发送失败：${e?.message ?? e}`);
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/* ═══════════════════════════ 第 6 步：记下来 ═══════════════════════════ */

// "你回没回、你最后说了什么"的刷新已经合并进 pickFriend 了（每轮对所有私聊都刷），
// 这里只留发送后的记账。两个地方分开写会漏 —— 原来就是漏在"只刷被选中的那个"。

/**
 * 记下「她此刻在想什么」——念想的雏形。
 *
 * 2026-10-23 起，模型每次被唤醒都会给一句 `mind`（哪怕这次没说话）。
 * 它不发出去，只留着：① 让她下次醒来时知道"上次想起过这件事"；
 * ② 以后可以作为"该找谁说话"的依据（现在还只看时间）。
 *
 * ⚠️ 只留最近 6 条：这是短期心绪，不是长期档案（长期记忆归 mem-layered）。
 */
function rememberMind(state, chatKey, text, now) {
  const t = String(text || '').trim();
  if (!t) return;
  const f = friendOf(state, chatKey);
  const list = Array.isArray(f.minds) ? f.minds : [];
  const last = list[list.length - 1];
  // 同一句话不重复记（模型有时会连着几轮说同一件事）
  if (last && String(last.text || '') === t) return;
  list.push({ at: now, text: cap(t, 120) });
  f.minds = list.slice(-6);
  f.lastMindAt = now;
}

function rememberSend(state, pick, text, now) {
  const f = pick.f;
  f.lastMsgAt = now;
  f.lastMsgText = cap(text, 200);
  // 只有**主动发出**的那条才写这里。机器人被动回复不经过本函数，
  // 所以 lastProactiveAt 永远代表"我最后一次主动开口是什么时候"。
  f.lastProactiveAt = now;
  f.lastProactiveText = cap(text, 200);
  f.replied = false;                       // 等你回这条主动的；下次扫描时按存档校正
  f.paused = false;                        // 刚开口，暂停标记清掉（由"没回"规则到时候再置上）
  f.pausedAt = 0;
  f.lastCheckAt = now;
  f.sentCount = Number(f.sentCount || 0) + 1;
  state.lastSendAt = now;
  state.dayKey = dayKeyOf(now);
  state.dayCount = Number(state.dayCount || 0) + 1;
}

/* ═══════════════════════════ 一整轮 ═══════════════════════════ */

async function runCycle() {
  lastCheckAt = Date.now();
  const s = settings();
  const now = Date.now();
  dbg(`--- 醒来：存档来源=${storeRef ? '钩子' : '文件'}｜enabled=${s.enabled} dryRun=${s.dryRun} ---`);
  const state = readState();
  state.lastCheckAt = now;
  let changed = true;                      // 每轮都刷新 lastCheckAt，让状态面板有最新信息

  try {
    // ① 取聊天存档视图：优先钩子递来的（实时），拿不到就直接读磁盘文件。
    //    这样重启/热重载后立刻就能工作，不必等谁先发一条消息来"喂"它。
    const src = chatData();
    if (!src.listChats().length) {
      dbg('读不到任何聊天存档 → 跳过');
      if (!warnedNoStore) {
        api?.warn?.('主动私信：读不到任何聊天存档，这一轮先跳过（确认 data/messages 目录里有会话文件）');
        warnedNoStore = true;
      }
      return { skipped: 'no-chat-data' };
    }

    // ② 现在能不能发
    const gate = canSendNow(state, s, now);
    if (!gate.ok) { dbg(`闸门拦住：${gate.reason}`); return { skipped: gate.reason }; }
    dbg(`闸门放行；dayCount=${state.dayCount}/${num(s.maxPerDay, 5, 0, 100)}`);

    // ③ 浏览私聊：先把每个人的最新情况记进存档，再挑出这次要逐个检查的对象
    //    （念想联动：每轮取一次 Top 想法 + 旅行近况，都是软依赖 —— 没装/没数据就是空）
    const wishes = wishContext();
    if (wishes.length) dbg(`念想联动：拿到 ${wishes.length} 条惦记的事 [${wishes.map((w) => w.kind).join('/')}]`);
    const travelLine = travelNowLine(now);
    if (travelLine) dbg(`旅行近况话题：${travelLine}`);
    const { candidates, refreshed, missing, configured, paused: pausedList } = pickFriend(state, s, now, src, wishes);
    dbg(`候选 ${candidates.length} 个 [${candidates.map((c) => c.chatKey.replace('private:', '')).join(',')}]`
      + `｜等回复中 ${pausedList.length} 个 [${pausedList.map((p) => p.chatKey.replace('private:', '')).join(',')}]`);
    if (refreshed > 0) api?.log?.(`主动私信：已刷新 ${refreshed} 个私聊会话的最新记录`);
    if (missing.length) {
      api?.warn?.(`主动私信：指定的 QQ 号还没有私聊记录，检查不到 → ${missing.join(', ')}`
        + '（需要那个号先跟机器人说过一句话，插件才有记录可看）');
    }
    if (!candidates.length) {
      // 全是"等回复中"时给个明确结论，别让它看起来像没找到人
      if (pausedList.length) {
        return { skipped: `${pausedList.length} 人都在"等回复中"（上次主动后没回，等他们先说话）`, paused: pausedList.map((p) => p.chatKey) };
      }
      return {
        skipped: configured ? '指定的 QQ 号现在都不满足条件' : '没有合适的私聊对象',
        ...(missing.length ? { missing } : {})
      };
    }

    // ④ **逐个检查、可连发多人**：本轮先随机决定"最多发几个人"（默认 1-1 = 只发一个），
    //    然后按"最久没聊"排序挨个问 AI；同意就发，直到发满本轮人数上限、
    //    或名单走完、或当天额度用完。每条之间停 sendGapSec 秒，避免 10 秒内连发十条。
    const quota = parseCountRange(s.targetSendRange, 1, 1, 20);
    const targetCount = Math.max(1, Math.round(rand(quota.min, quota.max)));
    const gapMs = num(s.sendGapSec, 20, 0, 600) * 1000;
    dbg(`本轮计划最多发 ${targetCount} 人（设置 ${quota.min}-${quota.max}）｜条间隔 ${gapMs / 1000} 秒`);

    const checked = [];
    const sentList = [];
    for (const cand of candidates) {
      if (sentList.length >= targetCount) break;

      // ⚠️ 每发一条前都要**重新读一次真实存档**再查闸门。
      //    踩过的坑：原来查的是循环开始时的内存快照，而这个快照里的 dayCount
      //    在 rememberSend 里才自增 —— 于是"每天上限 3 条"在一轮连发时形同虚设
      //    （实测上限 3 却发出 7 条）。这里必须从磁盘重新读。
      const freshState = readState();
      const again = canSendNow(freshState, s, Date.now());
      if (!again.ok) {
        dbg(`额度/闸门中断连发：${again.reason}`);
        // 把刷新到的计数同步回要写盘的 state，避免最后写回时把新计数覆盖掉
        state.dayKey = freshState.dayKey;
        state.dayCount = freshState.dayCount;
        break;
      }
      state.dayKey = freshState.dayKey;
      state.dayCount = freshState.dayCount;

      const chatKey = cand.chatKey;

      // ⑤.0 两道"防重复"保险（**都在问 AI 之前**，所以不但不花 token，反而省 token）。
      //   背景（实测踩到）：插件被重载（热重载/重启/手动关开）后是全新模块，
      //   内存里的"我刚给他发过"就没了 —— 冷却与"没回就不再发"会短暂失效，
      //   结果 60 秒内对同一个人连发两条（20:49 与 20:50 实测发生）。
      //   所以不能只信内存：下面两条都从**磁盘上的事实**重新判断。
      const guard = resendGuard(s, chatKey, cand, now, src);
      if (guard.blocked) {
        dbg(`${chatKey} 跳过：${guard.reason}`);
        checked.push({ chatKey, result: guard.reason });
        continue;
      }

      // 你刚刚说过话 → 这会儿正在聊，不用它主动找话题
      // （记录已在第 ③ 步刷新过，这里只是"这次先不开口"）
      const guardMs = num(s.replyGuardMinutes, 30, 0, 24 * 60) * 60000;
      if (cand.lastIncoming && Date.now() - Number(cand.lastIncoming.ts) < guardMs) {
        dbg(`${chatKey} 跳过：你刚回过（${Math.round((Date.now() - cand.lastIncoming.ts) / 60000)} 分钟前）`);
        checked.push({ chatKey, result: '你刚回过' });
        continue;
      }

      let decision;
      try {
        decision = await askAI(cand, chatKey, s, Date.now(), wishes, travelLine);
      } catch (e) {
        dbg(`${chatKey} 问 AI 失败：${e?.message ?? e}`);
        api?.warn?.(`主动私信：问 AI 失败（${chatKey}）：${e?.message ?? e}`);
        checked.push({ chatKey, result: `问 AI 失败：${e?.message ?? e}` });
        continue;
      }

      // ★ 2026-10-23：先记念想，再决定发不发 —— "想起来了但没话" 本身就是要留下的信息
      try { rememberMind(state, chatKey, decision.mind, Date.now()); } catch { /* 记不下不影响主流程 */ }

      if (!decision.send) {
        dbg(`${chatKey} AI 说不发：${decision.reason || '(无理由)'}`);
        api?.log?.(`主动私信：AI 判断对 ${chatKey} 这次不用发${decision.reason ? ` — ${decision.reason}` : ''}`);
        checked.push({ chatKey, result: 'AI 说不发', reason: decision.reason || '' });
        continue;
      }
      dbg(`${chatKey} AI 说要发：「${decision.message}」`);

      const text = cleanOutgoing(decision.message);
      if (!text) {
        api?.log?.(`主动私信：AI 说要发，但内容不可用，已忽略（${chatKey}）`);
        checked.push({ chatKey, result: '内容为空' });
        continue;
      }

      // 演练模式：只记日志，不真发（逐个检查也逐个演练）
      if (s.dryRun === true) {
        api?.log?.(`主动私信［演练］本来要发给 ${chatKey}：「${text}」`);
        if (!warnedDryRun) {
          warnedDryRun = true;
          api?.warn?.('主动私信：当前是「演练模式」，只写日志不真发；想让它真的发，到插件设置里把「演练模式」关掉。');
        }
        checked.push({ chatKey, result: '演练（未真发）', text });
        sentList.push({ chatKey, text, via: 'dry-run' });
        // 演练也照样记账并立刻落盘：让"每天上限"在演练里也能体现出来
        rememberSend(state, cand, text, Date.now());
        writeState(state);
        continue;
      }

      // 一轮内两条之间停一下（第一条不用等）
      if (sentList.length > 0 && gapMs > 0) {
        dbg(`等 ${gapMs / 1000} 秒再发下一条…`);
        await new Promise((r) => setTimeout(r, gapMs));
        // 等待期间闸门可能变化（比如跨进了睡眠时间）
        const stillOk = canSendNow(readState(), s, Date.now());
        if (!stillOk.ok) { dbg(`等完发现闸门变了：${stillOk.reason}`); break; }
      }

      const sent = await sendPrivate(chatKey, text);
      if (!sent.ok) {
        dbg(`${chatKey} 发送失败：${sent.reason}`);
        api?.warn?.(`主动私信发送失败（${chatKey}）：${sent.reason}`);
        checked.push({ chatKey, result: `发送失败：${sent.reason}` });
        continue;                                  // 这一个人失败不影响继续发别人
      }

      // ⑤ 记下来：几点发的、发了什么、你回没回（下次判断用）
      rememberSend(state, cand, text, Date.now());
      writeState(state);   // 立刻落盘：下一条前的额度检查读的就是这份新计数
      // ★ 倾诉回调（02.md 5.1）：这条开口说的是「惦记的事」里的第几件 → 通知
      //   mind-wish 标记已倾诉（强度减半、自然退出 Top）—— 同一件事不会反复拿去找人聊。
      if (decision.wishIdx >= 1 && wishes[decision.wishIdx - 1]) {
        const vw = wishes[decision.wishIdx - 1];
        try {
          api?.capability?.('mind.wishes', { action: 'vent', key: vw.key });
          api?.log?.(`主动私信：这次开口倾诉了「${cap(vw.text, 20)}」（念想已标记倾诉）`);
        } catch { /* 回调失败不影响主流程 */ }
      }
      sentList.push({ chatKey, text, via: sent.via });
      dbg(`${chatKey} 已发出（${sent.via}）：「${text}」｜今天第 ${state.dayCount} 条｜本轮第 ${sentList.length}/${targetCount} 条`);
      api?.log?.(`主动私信已发出（${sent.via}）→ ${chatKey}：「${text}」｜今天第 ${state.dayCount} 条`);
    }

    // 本轮结束：发了就报 sent（附全部明细），一条没发则报 no-send
    if (sentList.length) {
      dbg(`本轮共发出 ${sentList.length} 条：${sentList.map((x) => x.chatKey.replace('private:', '')).join(', ')}`);
      return {
        decided: s.dryRun === true ? 'dry-run' : 'sent',
        sent: sentList,
        count: sentList.length,
        plannedCount: targetCount,
        chatKey: sentList[0].chatKey,
        text: sentList[0].text,
        via: sentList[0].via,
        checked
      };
    }
    dbg(`本轮结束：no-send（检查了 ${checked.length} 个｜等回复中 ${pausedList.length} 个）`);
    return { decided: 'no-send', checked, ...(missing.length ? { missing } : {}) };
  } finally {
    if (changed) writeState(state);
  }
}

/* ═══════════════════════════ 生命周期 ═══════════════════════════ */

export function setup(a) {
  api = a;
  fetchRef = a.fetch;                       // 清单里声明了 web_fetch
  a.log(`主动私信已加载（${BUILD_TAG}）｜只发私信，群聊不管｜存档 ${STORE}`);
}

export function available() {
  return settings().enabled !== false;
}

export function activate() {
  startLoop();
}

export function deactivate() {
  stopLoop();
}

export function dispose() {
  stopLoop();
}

/**
 * 钩子：拿起聊天存档。
 *
 * ⚠️ 群聊在这里就被挡住了 —— 不读、不记录、不触发。只有私聊会话会进本插件。
 * ⚠️ 顺便把定时器拉起来：热重载只"加载"不"激活"（app.js 的 reloadSkills 只对
 *    已注册条目调 activate），不这么做的话插件在界面上显示"已启用"却永远没动静。
 */
export const hooks = {
  'before-context'(ctx = {}) {
    if (ctx.store) storeRef = ctx.store;
    // 定时器：只要有会话被唤醒就确保它在跑（与群聊/私聊无关，纯属自愈）。
    // 不这么做的话，热重载加载进来的插件界面显示"已启用"却永远没动静。
    startLoop();
    // 但**本插件的业务**只看私聊 → 群聊到此为止：不读、不记录、不触发。
    if (!isPrivate(ctx.chatKey)) return;
  }
};

/** 状态面板：一眼看到它开着没、上次醒来是什么时候、今天发了几条、盯着哪些人。 */
export const providers = {
  'status.silence-ping': () => {
    const s = settings();
    const state = readState();
    const friends = Object.entries(state.friends || {});
    const targets = parseTargets(s);
    // 指定了但从没跟机器人聊过 → 检查不到（不列出来用户会以为功能失效）
    let missing = [];
    try {
      const present = new Set(chatData().listChats());
      missing = targets.configured ? targets.list.filter((t) => !present.has(`private:${t.qq}`)).map((t) => t.qq) : [];
    } catch { /* 拿不到会话列表就不显示这一项 */ }
    return {
      icon: '📩',
      title: '主动私信',
      priority: 56,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : (s.dryRun === true ? '演练中（只记日志，不真发）' : '运行中')],
        ['检查对象', targets.configured
          ? `指定 ${targets.list.length} 个 QQ（逐个都检查）：${targets.list.map((t) => `${t.qq}(冷场${t.idleMinMinutes ?? num(s.targetIdleMinMinutes, 30, 1, 1440)}分/冷却${t.cooldownMinMinutes ?? num(s.cooldownMinutes, 120, 1, 1440)}分)`).join('、')}`
          : '白名单里所有私聊（每轮挑最久没聊的那个）'],
        ...(missing.length ? [['⚠️ 检查不到', `${missing.join(', ')} 还没有私聊记录（要先跟机器人说过一句话）`]] : []),
        ['醒来节奏', (() => { const w = parseWakeRange(s.wakeRange); return `每 ${w.min}~${w.max} 分钟一次`; })()],
        ['上次醒来', state.lastCheckAt ? `${hhmm(state.lastCheckAt)}（${Math.round((Date.now() - state.lastCheckAt) / 60000)} 分钟前）` : '还没醒过'],
        ['今天已主动', `${Number(state.dayCount) || 0} / ${num(s.maxPerDay, 5, 0, 100)} 条`],
        ['每轮人数', (() => { const q = parseCountRange(s.targetSendRange, 1, 1, 20); return `${q.min}-${q.max} 人（随机），条间隔 ${num(s.sendGapSec, 20, 0, 600)} 秒`; })()],
        ['睡眠时间', (() => {
          const q = parseQuietRange(s.quietRange);
          if (!q) return '未设置（任何时间都可能发）';
          const active = inQuietNow(s, Date.now()).active;
          return `${q.label} 不发${active ? ' ← 现在正处于其中' : ''}`;
        })()],
        ['梁文峰时期', (() => {
          if (s.liangwenfengEnabled === false) return '已关闭（不限制工作时段）';
          const now = inLiangwenfengPeriod(s, Date.now());
          const days = parseDays(s.lwfDays);
          const dayName = ['', '一', '二', '三', '四', '五', '六', '日'];
          const periods = parsePeriods(s.lwfPeriods).map((p) => p.label).join('、') || '（没设时段）';
          return `周${days.map((d) => dayName[d]).join('/')} ${periods} 禁发${now.active ? ` ← 现在正处于其中（${now.reason}）` : ''}`;
        })()],
        ['等回复中', (() => {
          const paused = friends.filter(([, f]) => s.noRepeatWhenUnreplied !== false && f.paused);
          if (s.noRepeatWhenUnreplied === false) return '功能已关闭（不暂停任何人）';
          return paused.length ? `${paused.length} 人（${paused.map(([k]) => k.replace('private:', '')).join('、')}，等他们先说话）` : '无';
        })()],
        ['只发私信', '群聊消息不读、不触发、不回复、不主动发']
      ]
    };
  }
};

// 只给排障用的出口
export const internals = {
  runCycle, settings, canSendNow, pickFriend, parseTargets, parseDecision, cleanOutgoing,
  inLiangwenfengPeriod, parsePeriods, parseDays, parseQuietRange, parseWakeRange, parseCountRange,
  buildPrompt, buildSystemRolePrompt, cleanMessageForPrompt, groupRecentTurns, buildSpeakerLedger, checkEchoGuard,
  agoLabel, stamp,
  sendPrivate,                // 只给自检用：直接验证"真发"这条路径（不经过 AI 判断）
  appendSelfToFile, loadChatFile, fileStore,   // 只给自检用：验证"留档"这一步
  readState, writeState, STORE,
  aiOverride: null            // 测试替身开关：设成函数即绕过真实模型（生产不使用）
};
