// learning-loop —— 常态化自主学习 + 反馈闭环
//
// ── 定位 ─────────────────────────────────────────────────────────────────
// 宿主已经把「记忆」这件事做得很好：conversation-memory 把群聊压成小时块、
// 自动巩固/遗忘/整理，memory-star 给它一张能看能改的图，knowledge-base 有
// learned/ 自学通道。**缺的不是存储，是驱动与纠偏**：
//   · 常态化的「该学什么」没人管 —— 只有模型偶尔想起来才 kb_remember 一次；
//   · 「学错了/记错了」没人管 —— 用户当场纠正完，无处可去，下次照错。
//
// ── 第一期（采集管道，已上线）────────────────────────────────────────────
//   ① 反馈采集（before-context）：识别 纠正 / 确认 / 显式要求 三类信号；
//   ② 缺口采集（after-tool）：知识库、长期记忆检索「明确无命中」时记下那次查询。
//   产出 = data/learning/ledger.jsonl（台账）+ state.json（聚合）。
//
// ── 第二期（共识入库，本次新增）──────────────────────────────────────────
// 把「值得记的消息」变成真知识，规则由主人定（2026-10-07）：
//   ★ 规则 A【共识】同一条内容被 **≥ minSources 个不同信源** 说过 → 记进知识库；
//   ★ 规则 A'【跨日共识】同一条内容被 **同一个人** 在 **≥ minDays 个不同日期** 说过
//     → 也算共识（2026-10-21 新增）。理由：一件事被人隔天又提一遍，比"两个人顺嘴
//     提一次"更像真知识 —— 前者说明这事一直在对方脑子里，后者可能只是同时被打了一行字。
//     ⚠️ 「不同日期」按 **dayTZ**（默认 Asia/Shanghai＝北京时间）切，既不是 UTC 日期、
//     也不是宿主进程时区：`t` 存的是 UTC 字符串，直接 slice(0,10) 会把北京时间
//     10-21 00:30 算成 10-20；而用 `new Date()` 的本地 getter 又会让"哪一天"随
//     机器时区漂移。两种都不行，必须显式指定时区（见 `localDay()`）。
//   ★ 规则 B【直录】**主人明确要求记**（「记住…」「记一下…」）→ 直接记，不过门槛。
//   三条规则是**并集**：任一条满足即入库；`crossDayConsensus` 可单独关掉规则 A'。
//   规则 A' 还要求"**措辞有别**"：相似度要 ≥ simThreshold+0.10，且不能是逐字复读
//   （即相似度必须 < 0.998）。同一个人把同一句话隔天原样再说一遍是口头禅/模板，
//   不算"又提起这件事"；真重要的逐字重复会有第二个人跟着说，走规则 A（senders）不受影响。
//   证据强度分档：主人直录 4 > 不同信源共识 3 > 同一人跨日重复 2（一个人自己念叨
//   两遍，本来就不如两个不同的人说话硬）。
// 流程（两段式，为的是避开钩子 5 秒硬超时）：
//   钩子内：清洗 → 归一化 → 质量闸门 → 去重 → **只 append** 候选池（O(1)）
//   批处理：候选池 → 2-gram Jaccard 贪心聚类 → 数信源 / 数本地日期 → 达标者 knowledge.write 入库
//   → 未达标的留在池里等第二个信源 / 第二个日期；已入库的记入 ingested.jsonl 防重复入库。
//
// ── 第三期（同主题合并，2026-10-21 起）──────────────────────────────────
// **同一件事换个说法就会新开一个文件** —— 这是原来最伤的漏，现在修掉了：
//   · 入库时把 title 归一化成 `topic`（卸掉「主人说·」「共识·」「自动·」前缀、去标点空白、
//     全角转半角、小写、截 40 字），同一个 topic = 知识库里的同一篇；
//   · 写入时带 `mode:'upsert'`，knowledge-base 会**替换**那一篇的正文
//     （保留 created、刷新 updated），而不是再攒一段、更不是再开一个文件；
//   · 同时带 `weight`：主人直录 = 4，群共识 = 3。权重参与 kb_search 的排序，
//     主人交代的事在检索时天然靠前。
//   · 第五期接上之后，「自动·」也归一到同一个 topic —— 机器提炼的那条和后来人类
//     共识的那条会落到**同一篇**（后者 upsert 覆盖前者），不会一个主题两篇记录。
// ⚠️ 本插件自己的 simThreshold（0.62）去重**保持不动**：那是"这件事值不值得记"
//    的闸，和"记到哪一篇"是两个正交的问题，混在一起就两头都不准。
//
// ── 第四期（记忆自检提醒，2026-10-21 起）──────────────────────────────────
// 前三期全是「采集 + 判定」，判定靠**统计共识**（≥2 信源 / 同一人跨日重复）。
// 实测这份数据上，共识几乎永不触发（887 条候选聚成 873 簇、860 簇只有 1 条），
// 所以补一条**不依赖统计**的路：让模型自己判断"刚才这段值不值得长期记住"。
//   · 触发：每 remindEveryMsgs 条用户消息（当时默认 15，0 = 关）在**内存**里累计一次；
//   · 注入：往本轮**最后一条 user 消息的尾部**追加一句提醒（REMIND_TEXT），
//     模型看到了就自己决定要不要调 knowledge-base__kb_remember；
//   · 只提醒，不判定 —— flushPool / clusterItems / topicOf / 共识逻辑一行没动。
// ⚠️ 计数器**刻意只放内存、不落盘**：进程重启归零，最坏结果只是"少提醒一次"，
//    它不值得为了一次提醒去开文件、去扛并发的读写竞态。
// ☠️ **2026-10-22 结案：这条路走不通。** 日志证明提醒注入了 5 次（`记忆自检到点`），
//    主模型一次都没照做 —— 20:36 之后的 4 条新知识全部来自共识/直录，没有一条来自它。
//    所以 `remindEveryMsgs` 的默认值已改为 **0**，代码整体保留但默认不跑
//    （想复核"主模型到底听不听话"时还能打开做对照组）。替代方案见下面第五期。
//
// ── 第五期（定时提炼，2026-10-22 起）──────────────────────────────────────
// 第四期失败了，失败得很干净：**提醒确实注入了，模型一次都没照做**。
// 实测 5 次注入（10-21 22:52/23:06/23:11/23:26、10-22 09:53，日志「记忆自检到点」），
// 20:36 之后新增的 4 条知识库条目，front-matter 全是 `共识(2信源)` / `主人直录`，
// **没有一条来自模型主动调用 kb_remember**。
// ⇒ 结论：**不能依赖主模型的遵从度**。提炼要由插件自己发起一次**独立调用**，
//   结果由插件**直接写库** —— 主模型连"要不要记"都不用表态。
//   · 缓冲：每个 chatKey 一个内存环形队列（user / assistant 两类行）；
//   · 触发：after-response 里，非 self 的用户消息累计 ≥ distillEveryMsgs 就看一眼；
//   · 执行：fire-and-forget 起一次 `chatCompletion({tag:'distill'})`，让它挑 0~3 条，
//     插件自己查重 + 写库（weight 固定 2，比人类共识低一档）；
//   · 纪律：**after-response 里绝不 await**（宿主 L1516 是 `await runHook`，
//     一旦 await 就把"实验室"挂在了用户回复的发送路径上）。
// ⚠️ 一次独立调用 = 一次真实的 API 计费。所以默认 15 条一次、最多 3 条、
//    总输入 ≤ 3000 字，是刻意压过的；`distillMaxItems=0` 可以只判不写先观察。
//
// ── 三条纪律（很重要，别破坏）────────────────────────────────────────────
// 1. ★ **零提示词前缀开销**：本插件不导出 promptSections；唯一碰 messages 的地方
//    是第四期的自检提醒，且**只往最后一条 user 消息的尾部追加**（append-only）。
//    绝不在开头/中间插入、绝不动 system —— 那会击穿宿主的前缀缓存
//    （见 MEMORY.md「缓存前缀纪律」与宿主的 stablePrefixViolation 告警）。
//    user 消息按定义在本轮提示词最末，追加它不改变任何历史 token 的前缀。
// 2. ★ **钩子内绝不做重活**：before-context 有 5 秒硬超时，且抛错会记进宿主
//    错误表。所以钩子体一律：纯同步正则 + 一次 appendFileSync，**绝不**调用
//    knowledge.write（它内部同步重建知识库索引，可能很慢）。
// 3. ★ **绝不抛**：所有钩子体、所有定时器体一律 try/catch 兜住。
//
// ── 隐私 ─────────────────────────────────────────────────────────────────
// 台账/候选池**只留触发消息的前 textMaxChars 字**，不留完整聊天记录；
// 不落 apiKey、不落模型的完整回复。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';

const DIR = path.join(DATA_DIR, 'learning');
const LEDGER = path.join(DIR, 'ledger.jsonl');
const STATE = path.join(DIR, 'state.json');
const POOL = path.join(DIR, 'candidates.jsonl');
const INGESTED = path.join(DIR, 'ingested.jsonl');
const SETUP_LOG = path.join(DIR, 'setup.log');
const RECENT_KEEP = 50;
const INGESTED_KEEP = 800;
/** 每个簇最多保留几个"原型"用于相似比对（保留首个 + 最近若干个）。 */
const PROTO_MAX = 5;
/** 簇间合并的比较次数上限，防止候选池很大时卡住事件循环。 */
const MERGE_BUDGET = 20000;

const DEFAULTS = {
  // ── 第一期 ──
  enabled: true,
  captureFeedback: true,
  captureGaps: true,
  ledgerMaxLines: 5000,
  textMaxChars: 200,
  // ── 第二期：共识入库 ──
  consensusEnabled: true,   // 总开关
  ownerDirect: true,        // 主人明确要求记 → 直录
  minSources: 2,            // 规则 A 的信源门槛
  crossDayConsensus: true,  // 规则 A'：同一人跨日期重复也算共识（默认开）
  minDays: 2,               // 规则 A' 的日期门槛（最小 2，上限 30）
  dayTZ: 'Asia/Shanghai',   // 规则 A' 按哪个时区切日（默认北京时间，不跟随机器时区）
  minChars: 8,              // 候选最小长度（归一化后）
  simThreshold: 0.62,       // 「同一件事」的 2-gram Jaccard 阈值
  scanRecent: 20,           // 每轮额外扫 store 最近多少条（0 = 只认 triggerEntries）
  poolMaxLines: 3000,       // 候选池上限
  maxWritesPerFlush: 3,     // 单次批处理最多入库几条（每条都要重建索引）
  autoFlushSec: 60,         // 批处理间隔（秒）
  autoFlush: true,
  // ── 第四期：记忆自检提醒（已被第五期取代，默认关闭）──
  // 每 N 条用户消息，往最后一条 user 消息尾部追加一句"自检"提示；
  // 0 = 完全关闭（两个提醒钩子都零行为）。详见文件末尾 REMIND_TEXT 附近注释。
  // ⚠️ 2026-10-22 起默认 0：实测注入 5 次、模型 0 次照做（见文件头第五期说明）。
  //    保留这个开关只是为了"对照组"——想看主模型到底听不听话时再打开。
  remindEveryMsgs: 0,
  // ── 第五期：定时提炼（插件自己起一次独立调用，自己写库）──
  distillEnabled: true,     // 总开关
  distillEveryMsgs: 15,     // 每多少条**非 self 的用户消息**提炼一次（3~200）
  distillMaxItems: 3,       // 单次最多入库几条（0~5；0 = 只判不写，用来看效果）
  distillModel: ''          // 提炼用哪个模型；空 = 跟随主模型
};

/**
 * 规则 A' 的相似度加严量：同一个人跨日重复，要**更像**才算同一件事。
 * 两个不同的人复述同一件事天然有措辞差异（0.62 就够）；
 * 一个人自己念叨，宽松阈值会把「晚安的几种变体」也凑成一簇。
 */
const DAYS_STRICT_BONUS = 0.10;

/**
 * 只在「本地知识 / 长期记忆」这两个**内部**渠道上判定缺口。
 *
 * 刻意不含 web_search：联网无命中往往是"网上一时搜不到"，噪声远大于信号；
 * 而知识库/记忆里查不到，才是"这本该有、但我们没学过"的真缺口。
 */
const GAP_TOOLS = new Set(['knowledge-base__kb_search', 'memory-recall__memory_search']);

/** 判定「检索无命中」的词面标记（对齐 memory-recall / knowledge-base 的返回文案）。 */
const EMPTY_MARKERS = ['没有命中', '没命中', '未命中', '没有找到', '没找到', '没有相关',
  '暂无', '想不起来', '没有收录', '没有记录', '没收录'];
const EMPTY_JSON = /"hits"\s*:\s*\[\s*\]/;

/**
 * 反馈识别规则表。
 *
 * 设计取舍：**宁可漏记，不可乱记**。中文口语里高频词极易误伤，所以：
 *   · 「对了」加了负向先行断言 —— 排除"对了，顺便问一下"这种话题转折；
 *   · 「不是/对的/正确」要求两侧是分隔符或边界 —— 排除"不是吧你"以外的粘连用法；
 *   · 靠前规则优先级更高（neg > learn > pos），同一句既否定又肯定时判否定。
 */
const RULES = [
  { p: 'neg', l: '不对', re: /(不对|不是这样|不是这么|不是这个|错了|搞错|弄错|记错|胡说|胡扯|瞎说|乱说|乱讲|哪里有|哪儿有|没这回事|没有的事|我没说|我没讲|别编|你编的|不准确|有误|说反了)/ },
  { p: 'neg', l: '不是', re: /(^|[\s，,。！!？?、…])(不是|并非)([\s，,。！!？?、…]|$)/ },
  { p: 'learn', l: '记一下', re: /(记一下|记下来|记住|记好|备忘|存一下)/ },
  { p: 'pos', l: '没错', re: /(没错|就是这样|你说得对|记得没错|没记错|正解|答对了|回答正确)/ },
  { p: 'pos', l: '对了', re: /对了(?![\s，,。！!？?、…])/ },
  { p: 'pos', l: '对的', re: /(^|[\s，,。！!？?、…])(对的|正确|靠谱|准确)([\s，,。！!？?、…]|$)/ }
];

const POLARITY_RANK = { neg: 3, learn: 2, pos: 1 };

/** 主人显式要求记录的说法（规则 B 的触发词）。 */
const OWNER_ASK_RE = /(?:请|帮我|麻烦|给我)?\s*(?:记住|记一下|记下来|记好|记着|记下|备忘一下|备忘|存一下|收藏一下)[:：,，。.!\s]*/;
/** 主人要求记录时，把触发词剥掉后至少要有这么多字才算一条有效内容（防「记住了吗」误判）。 */
const OWNER_ASK_MIN_CONTENT = 4;

/** 纯语气 / 纯表情 / 纯应答 —— 不构成候选。 */
const NOISE_ONLY = /^[哈呵嘿嘻嗝嗯哦啊呃诶欸咦哟喔噢额唔呜呼呀哪嘛吧啦了呢的吗哎唉唉草操靠6牛顶赞妙绝了好行可以中收了]*(?:[，。！？、~～…！?!.\s]|233|666|em+|hhh+|www+)*$/i;

/** 地址 / CQ 码 / @ / 表情图 等的清洗。 */
const CQ_RE = /\[CQ:[^\]]*\]/g;
const URL_RE = /(https?:\/\/|www\.)[^\s]+/gi;
const AT_RE = /@[^\s@]{1,24}/g;
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
const PUNCT_RE = /[\s\u3000，,。.！!？?；;：:、（）()【】\[\]{}《》<>""''`~～…—\-_/\\|*#￥$%^&+=@]/g;

/**
 * 宿主渲染的协议标记 —— 不是用户说的话，必须先剥掉。
 *
 * ⚠️ 最要命的是 `[引用 某人(QQ:x)：旧话]我的回复`：方括号里的**旧话是被引用者说的**，
 *    不是本条消息的内容。若不剥离，两个人各自引用同一条消息，就会被判成
 *    「同一件事被 2 个信源说过」，直接把**别人的话**记成共识入库。
 */
const QUOTE_RE = /\[引用(?:[^[\]]|\[[^\]]*\])*\]/g;
const POKE_RE = /^\s*\[拍一拍\]/;
const MEDIA_TAG_RE = /\[(图片|image|表情|动画表情|语音|视频|文件|音乐|卡片|合并转发|位置|链接|红包|转账|礼物)[^\]]*\]/gi;
/** 纯口水 / 纯互动词 —— 去掉它们后什么都不剩的，不是知识。 */
const CHITCHAT_RE = /(爱你|晚安|早安|午安|抱抱|亲亲|贴贴|摸摸|舔舔|kiss|么么|可爱|嘻嘻|哈哈|嘿嘿|捏捏|rua|蹭蹭|撸|捏)/gi;
/** 整条被圆括号包住 = 跑团场外发言（OOC），不算知识（右括号常被口语省略）。 */
const OOC_RE = /^\s*[（(][\s\S]*[）)]?\s*$/;

/**
 * 剥掉宿主渲染的协议标记，只留「这个人自己说的话」。
 * 返回 '' 表示这条消息本身没有内容（拍一拍、纯图片等）。
 */
export function stripHostMarks(s) {
  let t = String(s ?? '');
  if (!t.trim()) return '';
  if (POKE_RE.test(t)) return '';          // 拍一拍事件：整条都不是内容
  t = t.replace(CQ_RE, ' ');
  t = t.replace(QUOTE_RE, ' ');            // 引用段（含被引用者的原话）整块去掉
  t = t.replace(MEDIA_TAG_RE, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

let apiRef = null;
let log = () => {};
let warn = () => {};
let lineCount = -1;
let poolKeys = null;      // 内存去重表（chatKey|senderId|norm）
let poolSig = '';         // 候选池文件的指纹（size:mtime），外部改动后自动重扫
let poolCount = 0;
let flushTimer = null;
let flushing = false;

// ── 基础工具 ─────────────────────────────────────────────────────────────

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 权限/磁盘问题留给写时报错 */ }
}

function clip(s, n) {
  const t = String(s ?? '');
  const max = Math.max(20, Math.min(2000, Number(n) || 200));
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 当前设置：插件默认值 ← 用户在设置页改过的值（每轮实时读，改完不必重启）。 */
function settings() {
  let raw = {};
  try { raw = (apiRef && typeof apiRef.config === 'function' ? apiRef.config() : null) || {}; } catch { /* 读不到就走默认 */ }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function appendSetup(step, data = {}) {
  try {
    ensureDir();
    fs.appendFileSync(SETUP_LOG, `[${new Date().toISOString()}] ${step} ${JSON.stringify(data)}\n`, 'utf8');
  } catch { /* 诊断失败无所谓 */ }
}

function nowIso() { return new Date().toISOString(); }

// ── 日期换算（时区显式化，2026-10-21）──────────────────────────────────
// 候选池里 `t` 是 UTC 串，而「算哪一天」是跨日判定的**核心输入** ——
// 不能交给宿主进程/机器的时区去决定（同一批数据换个环境跑，结果就变了）。
// 所以用 dayTZ（IANA 名字，默认 Asia/Shanghai＝北京时间）显式换算。

const FMT_CACHE = new Map();   // tz → Intl.DateTimeFormat（构造一次，反复用）
const BAD_TZ = new Set();      // 构造失败的 tz，别再每次都抛一遍异常
let warnedTZ = '';             // 限频：同一个坏 tz 只 warn 一次

/** 当前生效的日期时区：配置为空/全空白 → 默认值。 */
function dayTZ() {
  const tz = String(settings().dayTZ ?? '').trim();
  return tz || DEFAULTS.dayTZ;
}

/** 回落用：系统本地时区（就是改时区之前的老实现）。 */
function systemLocalDay(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 取（并缓存）某个时区的日期 formatter。
 * 时区名非法 / Intl 不可用时返回 null，并**限频 warn 一次** ——
 * 配置写错只该在日志里喊一声，不该让整条规则静默失效（更不该每分钟刷屏）。
 */
function fmtFor(tz) {
  if (FMT_CACHE.has(tz)) return FMT_CACHE.get(tz);
  if (BAD_TZ.has(tz)) return null;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    FMT_CACHE.set(tz, f);
    return f;
  } catch (e) {
    BAD_TZ.add(tz);
    if (warnedTZ !== tz) {
      warnedTZ = tz;
      warn(`[learning] dayTZ「${tz}」不是合法时区（${e?.message ?? e}），回落到系统本地时区 `
        + `（今天算 ${systemLocalDay(new Date())}）。请在设置里填 IANA 名字，如 Asia/Shanghai。`);
    }
    return null;
  }
}

/**
 * 把一条 ISO **UTC** 时间戳换成指定时区的日期串 `YYYY-MM-DD`。
 *
 * ⚠️ 绝对不要用 `String(t).slice(0, 10)` / `toISOString().slice(0, 10)` 代替 ——
 *    候选池里存的是 UTC（结尾带 Z），北京时间下 10-21 00:30 的 UTC 是 10-20T16:30Z，
 *    slice 出来就成了「10-20」，隔天说的事会被算成同一天，跨日共识直接失效
 *    （反过来也会把同一天算成两天）。
 *
 * ⚠️ 也**不要**用 `getFullYear()/getMonth()/getDate()` 代替 —— 那是宿主进程时区，
 *    机器设成 UTC、或主人出差改了系统时区，"哪一天"就整体漂移。必须走 dayTZ。
 *
 * 无效 / 缺失的时间戳返回 ''，**由调用方跳过**（一条坏记录不该把天数凑够）。
 *
 * @param {string|number|Date} iso ISO 时间串（或时间戳 / Date）
 * @param {string} [tz] 时区（IANA 名字）；留空则取当前设置的 dayTZ
 * @returns {string} 该时区下的日期 `YYYY-MM-DD`；解析失败返回 ''
 */
export function localDay(iso, tz = '') {
  if (iso === null || iso === undefined || iso === '') return '';
  let d;
  try {
    d = iso instanceof Date ? iso : new Date(iso);
  } catch { return ''; }
  if (!d || Number.isNaN(d.getTime())) return '';
  const zone = String(tz ?? '').trim() || dayTZ();
  const f = fmtFor(zone);
  if (!f) return systemLocalDay(d);          // 坏配置 → 回落系统本地时区，不抛错
  // 用 formatToParts 自己拼，不依赖某个 locale 的字段排列顺序
  const parts = f.formatToParts(d);
  const pick = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  const y = pick('year');
  const mo = pick('month');
  const da = pick('day');
  return y && mo && da ? `${y}-${mo}-${da}` : systemLocalDay(d);
}

/** 日期门槛：正整数，最小 2（1 个日期等于没门槛），上限 30，坏值退回默认。 */
function clampMinDays(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULTS.minDays;
  return Math.max(2, Math.min(30, n));
}

/** 簇内「不同 senderId」集合（规则 A 的计数口径）。 */
function senderSetOf(items) {
  return new Set((items || []).map((x) => x?.senderId).filter(Boolean));
}

/**
 * 簇内「不同日期」集合（规则 A' 的计数口径），按 tz（默认 dayTZ）切日。
 * 无效时间戳（localDay 返回 ''）不计入 —— 不能让一条坏数据把天数凑够。
 */
function daySetOf(items, tz = '') {
  const days = new Set();
  const zone = String(tz ?? '').trim() || dayTZ();
  for (const x of items || []) {
    const d = localDay(x?.t, zone);
    if (d) days.add(d);
  }
  return days;
}

// ── 台账读写（第一期）────────────────────────────────────────────────────

function countLines() {
  try { return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}

/** 超过上限时保留最新的 80%（先进先出裁旧），防止无限增长。 */
function trimIfNeeded() {
  const max = Math.max(200, Math.round(Number(settings().ledgerMaxLines) || DEFAULTS.ledgerMaxLines));
  if (lineCount < 0) lineCount = countLines();
  if (lineCount <= max) return;
  try {
    const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length * 0.2));
    fs.writeFileSync(LEDGER, keep.join('\n') + '\n', 'utf8');
    log(`[learning] 台账超过 ${max} 行，已裁掉最旧的 ${lines.length - keep.length} 条`);
    lineCount = keep.length;
  } catch (e) { warn('[learning] 台账裁剪失败：' + (e?.message ?? e)); }
}

function appendLedger(ev) {
  ensureDir();
  fs.appendFileSync(LEDGER, JSON.stringify(ev) + '\n', 'utf8');
  lineCount = lineCount < 0 ? countLines() : lineCount + 1;
  trimIfNeeded();
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; }
}

function saveState(st) {
  ensureDir();
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1), 'utf8');
  fs.renameSync(tmp, STATE);
}

function bumpState(ev) {
  const st = loadState();
  st.updatedAt = ev.t;
  st.total = (Number(st.total) || 0) + 1;
  st.counts = st.counts || {};
  const key = ev.type === 'gap' ? 'gap' : (ev.polarity || 'other');
  st.counts[key] = (Number(st.counts[key]) || 0) + 1;
  const ck = ev.chatKey || '(未知)';
  st.byChat = st.byChat || {};
  const bc = st.byChat[ck] || { neg: 0, pos: 0, learn: 0, gap: 0, lastAt: '' };
  bc[key] = (Number(bc[key]) || 0) + 1;
  bc.lastAt = ev.t;
  st.byChat[ck] = bc;
  st.recent = Array.isArray(st.recent) ? st.recent : [];
  st.recent.push({
    t: ev.t, type: ev.type, polarity: ev.polarity || '', chatKey: ck,
    who: ev.senderName || ev.senderId || '', text: ev.text || ev.query || '', tool: ev.tool || ''
  });
  if (st.recent.length > RECENT_KEEP) st.recent = st.recent.slice(-RECENT_KEEP);
  try { saveState(st); } catch (e) { warn('[learning] 状态写入失败：' + (e?.message ?? e)); }
}

// ── 识别 ─────────────────────────────────────────────────────────────────

/**
 * 给一句话打反馈标签。返回 `{polarity, labels}`；没命中时 polarity 为 ''。
 * 导出是为了能离线单测（不开宿主也能跑）。
 */
export function classify(text) {
  const t = String(text ?? '');
  if (!t.trim()) return { polarity: '', labels: [] };
  const hits = [];
  let best = '';
  for (const r of RULES) {
    if (r.re.test(t)) {
      hits.push(r.l);
      if (!best || POLARITY_RANK[r.p] > POLARITY_RANK[best]) best = r.p;
    }
  }
  return { polarity: best, labels: hits };
}

/** 工具返回结果 → 纯文本（兼容字符串 / parts 数组 / {content} 包装）。 */
function resultText(result) {
  try {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) {
      return result.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('\n');
    }
    if (typeof result === 'object') {
      if (result.content != null) return resultText(result.content);
      return JSON.stringify(result);
    }
    return String(result);
  } catch { return ''; }
}

function looksEmpty(text) {
  if (!text) return false;
  if (EMPTY_JSON.test(text)) return true;
  return EMPTY_MARKERS.some((m) => text.includes(m));
}

// ── 归一化 / 相似度（第二期核心）─────────────────────────────────────────

/**
 * 把一句话压成"比对面孔"：去 CQ 码 / 链接 / @ / 表情，全角转半角，去标点空白，小写。
 * 目的只有一个 —— 让「对，下周六聚会」和「下周六聚会吧」能被判成同一件事。
 */
export function normalize(s) {
  let t = String(s ?? '');
  t = t.replace(CQ_RE, ' ').replace(URL_RE, ' ').replace(AT_RE, ' ').replace(EMOJI_RE, ' ');
  // 全角 → 半角（ASCII 区）
  t = t.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/\u3000/g, ' ');
  t = t.toLowerCase().replace(PUNCT_RE, '');
  return t.trim();
}

/** 2-gram 集合（长度 1 的串退回自身）。 */
export function grams(norm) {
  const s = String(norm ?? '');
  const out = new Set();
  if (!s) return out;
  if (s.length < 2) { out.add(s); return out; }
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度（传 Set 或字符串都行）。 */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : grams(a);
  const B = b instanceof Set ? b : grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (big.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 质量闸门：够不够格进候选池。
 * 宁可漏，不可滥 —— 池里每多一条噪声，就多一次误入库的机会。
 */
export function isCandidateText(text, norm, minChars = DEFAULTS.minChars) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (OOC_RE.test(raw)) return false;                     // 跑团场外发言
  const min = Math.max(4, Number(minChars) || DEFAULTS.minChars);
  const n = String(norm ?? '');
  if (n.length < min) return false;
  // 纯语气 / 纯表情 / 纯应答
  if (NOISE_ONLY.test(raw)) return false;
  // 抹掉口水词后还剩多少实义内容（「kiss kiss」「爱你，晚安，kiss」就此出局）
  if (n.replace(CHITCHAT_RE, '').length < min) return false;
  const stripped = raw.replace(PUNCT_RE, '');
  if (stripped.length < 3) return false;
  // 单字符占比过高（「哈哈哈哈哈哈哈哈」这类）
  const uniq = new Set([...stripped]).size;
  if (uniq / stripped.length < 0.25) return false;
  return true;
}

// ── 主人判定 ─────────────────────────────────────────────────────────────

/**
 * 主人 QQ 列表。
 *
 * ⚠️ 刻意**不**用 `api.capability('message.owner-check', ctx)` 取：那个能力的实现里
 *    只要入参带了 `triggerEntries` 或 `kind`（我们的钩子 ctx 恰好两者都有），就会走
 *    「人设」分支，返回里**根本没有 isOwner** —— 传错一次就永远判不出主人。
 *    这里直接读 owner-identity 的配置，语义单一、零歧义。
 */
export function ownerIds() {
  try {
    const cfg = getConfig() || {};
    const sk = (cfg.skills || {})['owner-identity'] || {};
    if (sk.enabled === false) return [];
    return String(sk.ids || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function isOwner(senderId, ids = null) {
  const id = String(senderId || '').trim();
  if (!id || id === 'self') return false;
  const list = ids || ownerIds();
  return list.includes(id);
}

/**
 * 规则 B：主人「明确要求记」时，剥出要记的内容。
 * 返回 '' 表示这句话不是在要求记录（或要求了但没说内容）。
 */
export function ownerAskContent(text) {
  const t = stripHostMarks(text).replace(AT_RE, ' ').trim();
  if (!OWNER_ASK_RE.test(t)) return '';
  const m = t.match(OWNER_ASK_RE);
  if (m) {
    const rest = t.slice(m.index + m[0].length).trim().replace(/^[:：,，。.!\s]+/, '');
    if (rest.length >= OWNER_ASK_MIN_CONTENT) return rest;
  }
  // 触发词在句尾（「这件事记一下」）：取触发词之前的部分（顺手剥掉尾随标点）
  const head = t.split(OWNER_ASK_RE)[0].trim().replace(/[:：,，。.!\s]+$/, '');
  if (head.length >= OWNER_ASK_MIN_CONTENT) return head;
  return '';
}

// ── 候选池 ───────────────────────────────────────────────────────────────

function poolKeyOf(x) { return `${x.chatKey}|${x.senderId}|${x.norm}`; }

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function writeJsonl(file, items) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
}

export function readPool() { return readJsonl(POOL); }

function fileSig(file) {
  try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return 'none'; }
}

/**
 * 去重表。带**文件指纹检查** —— 候选池可能被外部改动（用户手工清、脚本裁剪），
 * 只靠内存 Set 会变成"文件里没有、内存里却有"，那条内容就再也写不进去了。
 */
function ensurePoolKeys() {
  const sig = fileSig(POOL);
  if (!poolKeys || poolSig !== sig) {
    const items = readPool();
    poolKeys = new Set(items.map(poolKeyOf));
    poolCount = items.length;
    poolSig = sig;
  }
  return poolKeys;
}

/** 追加一条候选（已存在同 (会话,说话人,归一化文本) 则跳过）。返回是否真的写入。 */
function appendPool(ev) {
  ensureDir();
  const keys = ensurePoolKeys();
  const k = poolKeyOf(ev);
  if (keys.has(k)) return false;
  try { fs.appendFileSync(POOL, JSON.stringify(ev) + '\n', 'utf8'); } catch { return false; }
  keys.add(k);
  poolCount += 1;
  poolSig = fileSig(POOL);
  // 上限：超了从最旧的裁掉 20%
  const max = Math.max(200, Math.round(Number(settings().poolMaxLines) || DEFAULTS.poolMaxLines));
  if (poolCount > max) {
    try {
      const all = readPool();
      const keep = all.slice(Math.floor(all.length * 0.2));
      writeJsonl(POOL, keep);
      poolKeys = new Set(keep.map(poolKeyOf));
      poolCount = keep.length;
      poolSig = fileSig(POOL);
      log(`[learning] 候选池超过 ${max} 条，已裁掉最旧的 ${all.length - keep.length} 条`);
    } catch { /* 裁剪失败不影响本次写入 */ }
  }
  return true;
}

// ── 已入库指纹（防重复入库）──────────────────────────────────────────────

function readIngested() { return readJsonl(INGESTED); }

function rememberIngested(rec) {
  try {
    ensureDir();
    fs.appendFileSync(INGESTED, JSON.stringify(rec) + '\n', 'utf8');
    const all = readJsonl(INGESTED);
    if (all.length > INGESTED_KEEP) writeJsonl(INGESTED, all.slice(-INGESTED_KEEP));
  } catch { /* 记不住就下次再说 */ }
}

/**
 * 这条内容是不是已经入过库了？
 *
 * ⚠️ 必须比对**该簇所有成员**的文本，不能只留"代表"那一条 ——
 *    同一件事换个说法（「狼人有镀银免疫」/「对，狼人有镀银免疫」/「兽化人有镀银免疫」）
 *    字面相似度可能刚好落在阈值两侧，只记代表就会把同一件事反复入库。
 */
function alreadyIngested(norm, threshold) {
  try {
    for (const r of readIngested()) {
      const list = Array.isArray(r?.norms) ? r.norms : (r?.norm ? [r.norm] : []);
      for (const n of list) if (n && jaccard(norm, n) >= threshold) return true;
    }
  } catch { /* 校验失败就当没入过 */ }
  return false;
}

// ── 采集合集 ─────────────────────────────────────────────────────────────

/** ① 反馈采集：扫描本轮触发消息。 */
function collectFeedback(ctx) {
  const s = settings();
  if (s.enabled === false || s.captureFeedback === false) return;
  const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries.slice(0, 8) : [];
  if (!entries.length) return;
  const chatKey = String(ctx?.chatKey || '');
  for (const e of entries) {
    const text = String(e?.text ?? '').trim();
    if (!text) continue;
    const hit = classify(text);
    if (!hit.polarity) continue;
    const ev = {
      t: nowIso(), type: 'feedback', polarity: hit.polarity, labels: hit.labels,
      chatKey, senderId: String(e?.senderId ?? ''), senderName: String(e?.senderName ?? ''),
      text: clip(text, s.textMaxChars),
      model: String(ctx?.model || ''), sessionId: String(ctx?.sessionId || '')
    };
    appendLedger(ev);
    bumpState(ev);
  }
}

/** ② 缺口采集：内部检索渠道明确返回「没命中」时记账。 */
function collectGap(ctx) {
  const s = settings();
  if (s.enabled === false || s.captureGaps === false) return;
  const tool = String(ctx?.toolName || '');
  if (!GAP_TOOLS.has(tool)) return;
  const text = resultText(ctx?.result);
  if (!looksEmpty(text)) return;
  const a = (ctx?.argsRaw && typeof ctx.argsRaw === 'object') ? ctx.argsRaw : {};
  const query = String(a.query ?? a.q ?? a.keyword ?? '').trim();
  const ev = {
    t: nowIso(), type: 'gap', tool,
    query: clip(query, s.textMaxChars),
    scope: clip(a.chatKey || '', 60),
    chatKey: String(ctx?.chatKey || ''),
    senderId: '', senderName: '',
    sessionId: String(ctx?.sessionId || '')
  };
  appendLedger(ev);
  bumpState(ev);
}

/**
 * ③ 候选采集（规则 A/B 的入口）。
 *
 * 消息来源两路：
 *   a. `ctx.triggerEntries` —— 本轮真正把机器人叫起来的那几条（必有）
 *   b. `ctx.store.recent(chatKey)` —— 该会话最近的 N 条（可选，补足"没被叫到时说的话"）
 * 排除 bot 自己（`self === true`）—— 否则她复述一遍就凑够 2 个信源了。
 */
function collectCandidates(ctx) {
  const s = settings();
  if (s.enabled === false || s.consensusEnabled === false) return;
  const chatKey = String(ctx?.chatKey || '');
  if (!chatKey) return;
  const ids = ownerIds();

  const bucket = [];
  const push = (senderId, senderName, text) => {
    const id = String(senderId || '');
    const raw = stripHostMarks(text);        // 先剥宿主标记，只留这个人自己说的话
    if (!raw) return;
    const norm = normalize(raw);
    if (!isCandidateText(raw, norm, s.minChars)) return;
    const ask = s.ownerDirect !== false && isOwner(id, ids) ? ownerAskContent(raw) : '';
    bucket.push({
      t: nowIso(), chatKey,
      senderId: id, senderName: String(senderName || '').slice(0, 40),
      text: clip(ask || raw, s.textMaxChars),
      norm: clip(normalize(ask || raw), 160),
      direct: Boolean(ask)
    });
  };

  for (const e of (Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries.slice(0, 8) : [])) {
    push(e?.senderId, e?.senderName, e?.text);
  }

  const scan = Math.max(0, Math.min(60, Math.round(Number(s.scanRecent) || 0)));
  if (scan) {
    try {
      const st = ctx?.store;
      if (st && typeof st.recent === 'function') {
        for (const m of st.recent(chatKey, { limit: scan, includeSelf: false }) || []) {
          if (!m || m.self) continue;
          push(m.senderId, m.senderName, m.text);
        }
      }
    } catch { /* store 接口变了就退化成只认 triggerEntries */ }
  }

  let added = 0;
  for (const ev of bucket) if (appendPool(ev)) added++;
  if (added) log(`[learning] 候选池 +${added}（${chatKey}）`);
}

// ── 聚类 & 入库（第二期）─────────────────────────────────────────────────

/**
 * 贪心聚类 + 一轮簇间合并。
 *
 * ① 贪心：每条与已有簇的**任一原型**比对，够像就并入，否则自立一簇。
 *    用"原型列表"而不是"单一代表"，是因为单一代表会让顺序决定结果 ——
 *    同一个事实，先来的那条因为和代表差一点而自成一簇，后来的那条却与代表更像。
 * ② 合并：把①里被拆开的簇收拢（原型对原型取最大相似度）。
 *
 * 代价：①每簇最多 PROTO_MAX 次比对；②有 MERGE_BUDGET 硬上限，池子再大也不会卡死。
 */
export function clusterItems(items, threshold = DEFAULTS.simThreshold) {
  const th = Math.max(0.3, Math.min(0.95, Number(threshold) || DEFAULTS.simThreshold));
  const clusters = [];
  const addProto = (c, g) => {
    if (c.protos.length < PROTO_MAX) c.protos.push(g);
    else { c.protos.splice(1, 1); c.protos.push(g); }  // 保留首个代表 + 最近几条
  };
  for (const it of items) {
    const g = grams(it.norm);
    let hit = null;
    for (const c of clusters) {
      if (c.protos.some((p) => jaccard(g, p) >= th)) { hit = c; break; }
    }
    if (hit) { hit.items.push(it); addProto(hit, g); }
    else clusters.push({ protos: [g], rep: it.norm, items: [it] });
  }
  let budget = MERGE_BUDGET;
  for (let i = 0; i < clusters.length; i++) {
    if (!clusters[i]) continue;
    for (let j = i + 1; j < clusters.length && budget > 0; j++) {
      if (!clusters[j]) continue;
      budget--;
      const a = clusters[i], b = clusters[j];
      const like = a.protos.some((ga) => b.protos.some((gb) => jaccard(ga, gb) >= th));
      if (!like) continue;
      a.items.push(...b.items);
      for (const g of b.protos) addProto(a, g);
      clusters[j] = null;
    }
  }
  return clusters.filter(Boolean);
}

function shortChat(chatKey) {
  const m = String(chatKey || '').match(/^(group|private)[:_](\d+)$/);
  return m ? `${m[1] === 'group' ? '群' : '私聊'}${m[2]}` : String(chatKey || '').slice(0, 24);
}

function titleOf(text) {
  const t = String(text || '').replace(PUNCT_RE, '').replace(/\s+/g, '');
  return (t.slice(0, 20) || '未命名').trim();
}

/**
 * 把标题归一化成 topic 键 —— **同 topic = 知识库里的同一篇记录**。
 *
 * 为什么要在本插件里再写一份（而不是 import knowledge-base 的）：
 * 插件之间**不能互相 import**，只能经 api.capability 通信。少一个耦合点，
 * 就少一种"对方改个导出名、这边整轮不工作"的静默失效。
 *
 * 归一化规则：卸「主人说·」「共识·」「**自动·**」前缀 → NFKC（全角转半角）→
 * 只留字母/数字（中文汉字属字母）→ 小写 → 截 40 字。
 *
 * ── 「自动」这个前缀为什么必须一起卸（2026-10-22 补）────────────────────
 * 第五期定时提炼写库时标题是 `自动·退款政策`。如果这里只卸 `主人说`/`共识`，
 * 它会算出 `自动退款政策` —— 而人类共识那条 `共识·退款政策` 算出 `退款政策`。
 * 两个 topic → 知识库里**两篇**记录，正好把上一轮做 topic 的初衷（一件事一篇）废掉。
 * 加上 `自动` 之后：`自动·退款政策` / `共识·退款政策` / `退款政策` 三者**同一个 topic**，
 * 后来者以 `mode:'upsert'` 覆盖同一篇（h1 会更新成最后写入者的标题）。
 *
 * ⚠️ 和 knowledge-base/index.js 那份 topicOf 的**唯一差异**就是多了 `自动`。
 *    这不会造成两边算出不同的 topic，理由是本插件写库时**总是显式传 topic**
 *    （`distillWrite()` / `ingestCluster()` 都传），而 knowledge-base 那边是
 *    `topicKey = explicitTopic ? topicOf(explicitTopic) : topicOf(nm)` ——
 *    它对**已经是归一化结果**的字符串是**幂等**的：
 *      · 只保留 `\p{L}\p{N}`、已小写、已截 40 字 → 后三步是恒等；
 *      · 它的前缀剥离要求前缀后**紧跟分隔符**（`[·・:：\-—_|｜>》]+`），
 *        而本函数产出的 topic 里一个分隔符都不剩 → 那一步也是恒等。
 *    换句话说：它卸不卸 `自动` 都不影响我们这条路径 —— 我们传过去的是**结果**，不是标题。
 *    （反向依赖仍然存在：若 knowledge-base 将来改了自己的前缀表/词表，这里要跟。
 *      测试 T12 把这条耦合钉住了。）
 *
 * @param {string} title 人类可读的标题，如 `主人说·退款政策`
 * @returns {string} 归一化后的 topic，如 `退款政策`
 */
export function topicOf(title) {
  let s = String(title ?? '');
  try { s = s.normalize('NFKC'); } catch { /* 老引擎没有 normalize 就跳过 */ }
  // 来源前缀：主人说· / 共识· / 自动·（第五期定时提炼）
  // 注意：必须有分隔符才算前缀 —— 所以标题「自动售货机价格」不会被误卸成「售货机价格」。
  s = s.replace(/^\s*(?:主人说|共识|自动)\s*[·・:：\-—_|｜>》]+\s*/u, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, '');
  s = s.toLowerCase();
  return s.slice(0, 40) || 'untitled';
}

/**
 * 把一个达标的簇写进知识库。返回 {ok, title, reason}。
 *
 * @param {object} c 簇（`{items, protos, rep}`）
 * @param {number} threshold 相似阈值（判断"是不是已经入过库"用）
 * @param {'direct'|'senders'|'days'} basis 靠哪条规则达标的 —— 决定落盘文案与 tags。
 *        `direct`  → `主人直录`（规则 B）
 *        `senders` → `共识（N 个信源）`（规则 A）
 *        `days`    → `共识（同一人 N 个日期重复）`（规则 A'）
 */
// ── 陈述性判据（共识路径的第二道闸，2026-10-22）══════════════════════════
// 治什么：共识规则原本只看"重复 + 多信源"，于是**同一句废话被三个人说过就被
//   当成事实入库**。实测扫库：77 条里 61 条共识，其中 59 条是聊天噪音
//   （「token来！token来！」「@某人 生成一段零到两千的数组」「【防撤回】…撤回了一条消息」）。
//   这些一旦入库，以后每次相关话题都会被检索出来当结论复述 —— 比漏记严重得多。
//
// 为什么判据是"陈述性"而不是"字数"：
//   陈述性事实可以很短（「主人怕辣」4 个字就该记），聊天噪音可以很长
//   （「好崩溃，在推特刷到你了，你为什么不穿衣服…」76 个字全是废话）。长度和
//   "值不值得长期记"没有单调关系，所以不看字数，只看**有没有可长期成立的陈述**。
//
// 判定用「白名单通道 + 默认拒绝」：命中任一陈述通道才算候选，否则不记。
//   通道：定义/属性、等式、冒号列表、规范（要看/必须/不能）、命名规则、偏好、约定。
//   反向排除：系统文本、表情/空括号、纯疑问、@某人（在跟人说话）、祈使索取、复读拟声、
//   第一/第二人称主语（"我才是区王""你是耻辱"是聊天，不是定义）。
//   在 77 条人工标注上一致率 94.9%（74/78）—— 剩余误差是"以我开头的约定句"这类边界。
//
// 代价：会漏记（真实但表达不像陈述的共识）。这个方向是有意选的：
//   漏记还能靠第五期定时提炼补上，记脏了要人工一条条清。
const RE_TEXT_SYSTEM = /【防撤回】|撤回了一条消息|\[合并转发|\[图片\]/;
const RE_TEXT_MENTION = /@[^\s@]*(\(\d+\)|（[^）]*）)|\(\d{5,}\)/;
const RE_TEXT_ASK = /^(帮我|给我|请|生成|总结|算一?下|收一下|送你|那你给|让|问吧|发|来|把|你把你|你这只|你有意见|速速)/;
const RE_TEXT_DEFINE = /^(?!(也许|好像|明明|大概|可能|难道|其实|不过|所以|但是|而且|就这样))[\s\S]{2,30}(是|指的是|意思是|得名于|属于|分为|包含|是一款|是一种|是一个|叫做|名叫)/;
const RE_TEXT_DEFINE2 = /(指的是|意思是|得名于|全称是|是一种|是一款|是一个|被称为|统称为)/;
const RE_TEXT_EQUATION = /[^\s]{1,12}\s*[≈=]\s*[^\s]{1,12}/;   // 「福≈B≈鲍鱼」「A = B」这类等式/谐音解释
const RE_TEXT_COLON = /^[\u4e00-\u9fa5]{2,8}：[^\s]{4,}/;
const RE_TEXT_NORM = /^[^我你他她它这那][^。？]{2,20}(要看|应该|必须|不能|别弄错|别混|不要)[^。？]{2,30}/;
const RE_TEXT_NAMING = /(大名|昵称|称呼|名字)[^。？]{0,12}(是|叫)|(是|叫)[^。？]{0,6}(大名|昵称|称呼)/;
const RE_TEXT_PREF = /(主人|他|她|.{1,6}同学|.{1,6}哥|.{1,6}姐|.{1,6}鱼)(怕|喜欢|讨厌|不吃|爱吃|受不了|不爱)[^。？]{1,20}/;
const RE_TEXT_AGREE = /(约定|说好|答应|每周|每天|每周[一二三四五六日天]|固定)[^。？]{1,30}/;
// 澄清句：「那天自称妖精是在玩影之诗时的调侃，不是真的」——开头是时间副词，但内容是事实纠正
const RE_TEXT_CLARIFY = /^(那天|昨天|上次|刚才|之前|其实)[^。？]{2,40}(是|不是)[^。？]{2,30}/;

/** 这条文本像不像"可长期成立的陈述"？共识路径只有通过它才允许入库。 */
export function looksDeclarative(raw) {
  const text = String(raw ?? '');
  const t = text
    .replace(/@[^\s@（(]+(（[^）]*）)?(\(\d+\))?/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[“”"'「」『』·—\-~\s]+/, '')   // 去掉开头的引号/破折号，否则"蓝的盆"这类定义句开头就匹配不上
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length < 3) return false;
  if (RE_TEXT_SYSTEM.test(text)) return false;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|（\s*）|\(\)/u.test(t)) return false;

  const naming = RE_TEXT_NAMING.test(t);
  const pref = RE_TEXT_PREF.test(t);
  const agree = RE_TEXT_AGREE.test(t);
  const clarify = RE_TEXT_CLARIFY.test(t);
  // 命名规则先于疑问句判：「我叫你大名是有正事…明白吗？」结尾是问句但内容是规则
  if (/[？?]\s*$/.test(t) && !(naming && /(别弄错|别混|别捣乱|不要|必须)/.test(t))) return false;

  const hit = RE_TEXT_DEFINE.test(t) || RE_TEXT_DEFINE2.test(t) || RE_TEXT_EQUATION.test(t)
    || RE_TEXT_COLON.test(t) || RE_TEXT_NORM.test(t) || naming
    || pref || agree || clarify;
  if (!hit) return false;

  if (RE_TEXT_MENTION.test(text)) return false;      // 在对着某人说话
  if (RE_TEXT_ASK.test(t)) return false;             // 开口要东西
  // 复读/拟声：只在**短句**上判（中文长段落字重复率天然低，按比例判会误杀正常长文本）
  const uniq = new Set([...t.replace(/\s/g, '')]).size;
  if (t.length >= 8 && t.length <= 40 && uniq / t.length < 0.5) return false;
  // 人称主语 = 聊天，不是定义。但"她不吃香菜""周五固定打本"这类偏好/约定句
  // 天然以人称或时间开头，属于要保留的短陈述，所以对 pref/agree/clarify 放行。
  if (!naming && !pref && !agree && !clarify && /^(我|你|他|她|它|这|那|咱|大家)/.test(t)) return false;
  return true;
}

function ingestCluster(c, threshold, basis = '') {
  const rep = c.items.find((x) => x.direct)
    || c.items.slice().sort((a, b) => String(b.text || '').length - String(a.text || '').length)[0];
  if (!rep) return { ok: false, reason: '空簇' };
  if (alreadyIngested(rep.norm, threshold)) return { ok: false, reason: 'duplicate' };

  const sources = [...senderSetOf(c.items)];
  const tz = dayTZ();
  const days = [...daySetOf(c.items, tz)].sort();
  const who = [...new Set(c.items.map((x) => `${x.senderName || x.senderId || '?'}@${shortChat(x.chatKey)}`))];
  // basis 没传（直接调用）时按 direct > senders > days 就地归因，保证文案永不空着
  const s = settings();
  const minSources = Math.max(1, Math.round(Number(s.minSources) || DEFAULTS.minSources));
  const minDays = clampMinDays(s.minDays);
  const crossDay = s.crossDayConsensus !== false;
  const why = ['direct', 'senders', 'days'].includes(basis)
    ? basis
    : (rep.direct ? 'direct' : sources.length >= minSources ? 'senders'
      : (crossDay && days.length >= minDays ? 'days' : ''));
  const isDirect = why === 'direct';
  // ── 第二道闸：共识必须是"陈述"，不是聊天 ═════════════════════════════════
  // 只拦共识（senders / days 两条规则）；主人直录（direct）是人工决定要记的，不拦。
  // 理由见 looksDeclarative 上方那段注释：重复出现 ≠ 事实。
  if (!isDirect && !looksDeclarative(rep.text)) {
    try {
      log(`[learning] 共识跳过（非陈述）：${titleOf(rep.text)}`);
    } catch { /* 日志失败不影响判定 */ }
    return { ok: false, reason: 'not-declarative' };
  }
  const byDays = why === 'days';
  const title = (isDirect ? '主人说·' : '共识·') + titleOf(rep.text);
  const source = (isDirect ? '主人直录'
    : byDays ? `共识（同一人 ${days.length} 个日期重复）`
      : `共识（${sources.length} 个信源）`) + '：' + who.join('；');
  const tags = isDirect ? '主人直录'
    : byDays ? `共识(${days.length}日期)`
      : `共识(${sources.length}信源)`;
  // ── 元数据层（2026-10-21）──────────────────────────────────────────────
  // topic：同一个主题键 = 知识库里的同一篇。同名不同说法的两条记录会落到
  //        同一个 topic 上（`主人说·退款政策` 与 `共识·退款政策` 都是 `退款政策`），
  //        配合 mode:'upsert' 就实现了"合并到一处"，不再一题一文件。
  // weight：主人直录 4 / 群共识（不同人）3 / 同一人跨日重复 2。
  //         为什么 days 是 2：一个人自己念叨两遍，证据强度本来就弱于两个不同的人，
  //         降到 2 后它在 kb_search 里（1 + 0.12×(weight−3)）天然排在真共识之后，
  //         而不是与多信源共识同档。没到 5 是留给"被多个信源反复印证过"再往上调。
  const topic = topicOf(title);
  const weight = isDirect ? 4 : byDays ? 2 : 3;

  let r;
  try {
    r = apiRef?.capability?.('knowledge.write', {
      title, content: rep.text, source, tags, topic, weight, mode: 'upsert'
    });
  } catch (e) { return { ok: false, reason: 'capability 抛错：' + (e?.message ?? e) }; }
  if (!r) return { ok: false, reason: 'knowledge.write 不可用（knowledge-base 没装或没启用）' };
  if (r.ok === false) return { ok: false, reason: String(r.error || '写入被拒') };

  rememberIngested({
    t: nowIso(),
    // 记该簇**所有**成员的归一化文本（不只代表），见 alreadyIngested 的注释
    norms: [...new Set(c.items.map((x) => x.norm).filter(Boolean))].slice(0, 12),
    title, sources: sources.length, direct: isDirect,
    basis: why, days: days.length, weight
  });
  // replaced = 合并进了已有条目（不是新开文件）；写进返回值便于台账/工具显示
  return {
    ok: true, title, topic, weight, file: r.file || '',
    replaced: Boolean(r.replaced), sources: sources.length, direct: isDirect,
    basis: why, days: days.length,
    // label：给工具/日志直接用的一句"靠什么达标的"
    label: isDirect ? '主人直录' : byDays ? `同一人 ${days.length} 个日期重复` : `${sources.length} 个信源`
  };
}

/**
 * 「逐字复读」判定线：子簇里任意一对的相似度**达到**这个值就算复读。
 * 取 0.998 而不是 1.0，是给量化/标点/全半角之类的小差异留一点余量；
 * 于是规则 A' 的相似度窗口是 `min(strict) ≤ sim < 0.998`。
 */
const VERBATIM_SIM = 0.998;

/**
 * 子簇内是否出现「逐字复读」的一对（任意一对相似度 ≥ VERBATIM_SIM）。
 *
 * 为什么复读不算共识：同一个人隔天把**一模一样的话**再说一遍，绝大多数是
 * 口头禅 / 晚安 / 复读 / 群公告模板，不是"又提起了这件事"；而"同一件事隔天
 * 再提一遍"在自然语言里几乎必然换了措辞 —— 换措辞才是我们要的信号。
 * 真重要的逐字重复通常会有第二个人跟着说，那条走 senders 分支，不受影响。
 */
function hasVerbatimPair(items) {
  const gs = (items || []).map((x) => grams(x?.norm));
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      if (jaccard(gs[i], gs[j]) >= VERBATIM_SIM) return true;
    }
  }
  return false;
}

/**
 * 跨日分支的「更严相似度」门。
 *
 * 在宽松阈值（simThreshold）下能凑成一簇，**不代表真的是同一件事**：
 * 一个人隔天复读「晚安喵喵」的几种变体，字面相似度就够 0.62，能凑出两个日期。
 * 所以规则 A' 要求同时满足两条：
 *   ① 按 simThreshold + 0.10 重新聚一遍后，仍存在一个**自己就跨 ≥ minDays 天**的子簇
 *      （散开了说明"重复"只是巧合）；
 *   ② 该子簇内**没有逐字复读**的一对（任意一对相似度 < 0.998）——
 *      一模一样的话再说一遍是模板，不是"又提起这件事"。
 * 合起来就是规则 A' 的相似度窗口：`[simThreshold + 0.10, 0.998)`。
 *
 * @param {object[]} items 簇内条目
 * @param {number} minDays 日期门槛
 * @param {number} strictSim 加严后的相似度阈值
 * @param {string} tz 切日时区
 * @returns {boolean} 是否真的够格按「同一人跨日期重复」入库
 */
function daysBasisOk(items, minDays, strictSim, tz) {
  if (daySetOf(items, tz).size < minDays) return false;   // 前提：宽松阈值下已跨够天数
  const tight = clusterItems(items, strictSim);
  for (const g of tight) {
    if (daySetOf(g.items, tz).size < minDays) continue;   // 这个子簇自己没跨够天
    if (hasVerbatimPair(g.items)) continue;               // 逐字复读 → 不算
    return true;
  }
  return false;
}

/**
 * 批处理：候选池 → 聚类 → 达标的入库。
 *
 * 达标条件（规则 A / A' / B，**并集**，任一条满足即入库）：
 *   · 簇内**不同 senderId 数** ≥ minSources           → 规则 A 共识
 *   · 簇内**不同日期数** ≥ minDays（开关开着 + 相似度加严 + 排除逐字复读）→ 规则 A' 跨日共识
 *   · 簇内**含主人直录条目**                          → 规则 B 直录
 * 「日期」按 dayTZ 切（默认 Asia/Shanghai），不是 UTC、也不是宿主进程时区。
 * 归因优先级 direct > senders > days（同时满足时文案说更硬的那条）。
 * 未达标的**留在池里**等第二个信源 / 第二个日期。
 */
export function flushPool({ maxWrites = null } = {}) {
  if (flushing) return { ok: false, reason: 'busy' };
  flushing = true;
  try {
    const s = settings();
    if (s.enabled === false || s.consensusEnabled === false) return { ok: true, skipped: 'disabled' };
    const items = readPool();
    if (!items.length) { poolKeys = null; poolSig = ''; poolCount = 0; return { ok: true, total: 0, written: 0, kept: 0 }; }

    const clusters = clusterItems(items, s.simThreshold);
    const cap = Math.max(1, Math.min(20, Math.round(Number(maxWrites ?? s.maxWritesPerFlush) || DEFAULTS.maxWritesPerFlush)));
    const minSources = Math.max(1, Math.round(Number(s.minSources) || DEFAULTS.minSources));
    const crossDay = s.crossDayConsensus !== false;
    const minDays = clampMinDays(s.minDays);
    const tz = dayTZ();
    const sim = Math.max(0.3, Math.min(0.95, Number(s.simThreshold) || DEFAULTS.simThreshold));
    const strictSim = Math.min(0.95, sim + DAYS_STRICT_BONUS);   // days 分支要更像

    const done = new Set();
    const written = [];
    for (const c of clusters) {
      // ── 判定：三条规则的并集（direct / 不同人 / 不同日期）──
      const senders = senderSetOf(c.items);
      const days = daySetOf(c.items, tz);
      const direct = c.items.some((x) => x.direct);
      const enoughSenders = senders.size >= minSources;
      const enoughDays = crossDay && days.size >= minDays;
      let basis = '';
      if (direct) basis = 'direct';
      else if (enoughSenders) basis = 'senders';
      else if (enoughDays && daysBasisOk(c.items, minDays, strictSim, tz)) basis = 'days';
      if (!basis) continue;
      if (written.length >= cap) break;
      const r = ingestCluster(c, sim, basis);
      if (r.ok) {
        written.push(r);
        for (const x of c.items) done.add(poolKeyOf(x));
      }
    }

    const kept = items.filter((x) => !done.has(poolKeyOf(x)));
    if (done.size) {
      writeJsonl(POOL, kept);
      poolKeys = new Set(kept.map(poolKeyOf));
      poolCount = kept.length;
      poolSig = fileSig(POOL);
    }

    if (written.length) log(`[learning] 入库 ${written.length} 条：` + written.map((w) => w.title).join('｜'));
    return { ok: true, total: items.length, clusters: clusters.length, written: written.length, kept: kept.length, items: written };
  } catch (e) {
    warn('[learning] 批处理失败：' + (e?.message ?? e));
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    flushing = false;
  }
}

// ── 定时器 ───────────────────────────────────────────────────────────────

function stopTimer() {
  if (flushTimer) { try { clearInterval(flushTimer); } catch { /* 忽略 */ } flushTimer = null; }
}

function startTimer() {
  stopTimer();
  const s = settings();
  if (s.enabled === false || s.consensusEnabled === false || s.autoFlush === false) return;
  const sec = Math.max(15, Math.min(3600, Math.round(Number(s.autoFlushSec) || DEFAULTS.autoFlushSec)));
  flushTimer = setInterval(() => {
    try { flushPool(); } catch (e) { warn('[learning] 定时批处理失败：' + (e?.message ?? e)); }
  }, sec * 1000);
  try { flushTimer.unref?.(); } catch { /* 无 unref 也无所谓 */ }
}

// ── 对外的汇总 ───────────────────────────────────────────────────────────

export function summarize() {
  const st = loadState();
  const counts = st.counts || {};
  const byChat = st.byChat || {};
  const rows = Object.entries(byChat)
    .sort((a, b) => String(b[1].lastAt).localeCompare(String(a[1].lastAt)))
    .slice(0, 10)
    .map(([ck, v]) => `${ck}｜纠正${v.neg || 0} 确认${v.pos || 0} 记一下${v.learn || 0} 缺口${v.gap || 0}`);
  const pool = readPool();
  return {
    ok: true,
    ledgerLines: countLines(),
    updatedAt: st.updatedAt || '',
    total: Number(st.total) || 0,
    counts: {
      neg: counts.neg || 0, pos: counts.pos || 0, learn: counts.learn || 0, gap: counts.gap || 0
    },
    chats: Object.keys(byChat).length,
    byChatTop: rows,
    poolLines: pool.length,
    poolDirect: pool.filter((x) => x.direct).length,
    ingestedLines: readIngested().length,
    recent: (st.recent || []).slice(-10)
  };
}

function noteText(args = {}) {
  const kind = ['correction', 'preference', 'fact', 'other'].includes(String(args.kind)) ? String(args.kind) : 'other';
  const text = String(args.text ?? '').trim();
  if (!text) return { content: '需要给出 text。', isError: true };
  const ev = {
    t: nowIso(), type: 'feedback', polarity: kind === 'correction' ? 'neg' : 'learn',
    labels: ['manual:' + kind], chatKey: String(args.chatKey || ''),
    senderId: '', senderName: '手动记录', text: clip(text, settings().textMaxChars),
    note: clip(args.note || '', 200), manual: true
  };
  appendLedger(ev);
  bumpState(ev);
  return { content: `已记入学习台账（${kind}）：${clip(text, 120)}` };
}

// ── 宿主接线 ─────────────────────────────────────────────────────────────

export function setup(api) {
  apiRef = api;
  log = api.log || log;
  warn = api.warn || warn;

  let shape = {};
  try {
    const c = settings();
    shape = {
      enabled: c.enabled !== false, captureFeedback: c.captureFeedback !== false,
      captureGaps: c.captureGaps !== false, ledgerMaxLines: c.ledgerMaxLines,
      consensusEnabled: c.consensusEnabled !== false, minSources: c.minSources,
      crossDayConsensus: c.crossDayConsensus !== false, minDays: clampMinDays(c.minDays),
      dayTZ: dayTZ(),
      ownerDirect: c.ownerDirect !== false, autoFlush: c.autoFlush !== false,
      // 第五期：定时提炼（写进 setup.log 便于事后核对"它到底有没有在跑"）
      distillEnabled: c.distillEnabled !== false, distillEveryMsgs: distillEvery(),
      distillMaxItems: distillMax(), distillModel: distillModelName() || '(主模型)',
      remindEveryMsgs: c.remindEveryMsgs
    };
  } catch (e) { shape = { cfgError: String(e?.message ?? e) }; }
  appendSetup('setup', {
    shape, dataDir: DIR, ledgerLines: countLines(), poolLines: readPool().length,
    owners: ownerIds().length
  });

  poolKeys = null;   // 重扫池
  startTimer();

  if (typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'learning-loop__learning_status',
      name: '查看学习台账',
      description:
        '查看「学习与反馈闭环」的台账统计：累计收到多少次纠正/确认/「记一下」、内部检索（知识库、长期记忆）有多少次是空手而归（= 待学缺口），候选池里积了多少条、已经入库几条，以及最近几条。'
        + '只读，不改任何东西。想知道"最近大家都纠正过我什么""有没有该学但没学的"时用它。',
      category: 'knowledge',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const s = summarize();
        const L = [];
        L.push(`台账 ${s.ledgerLines} 行｜累计 ${s.total} 条｜涉及 ${s.chats} 个会话`);
        L.push(`纠正 ${s.counts.neg}｜确认 ${s.counts.pos}｜记一下 ${s.counts.learn}｜待学缺口 ${s.counts.gap}`);
        L.push(`候选池 ${s.poolLines} 条（其中主人直录 ${s.poolDirect}）｜已入库 ${s.ingestedLines} 条`);
        if (s.byChatTop.length) { L.push('按会话（前 10）：'); for (const r of s.byChatTop) L.push('· ' + r); }
        if (s.recent.length) {
          L.push('最近：');
          for (const r of s.recent.slice(-6)) {
            L.push(`· [${r.type}${r.polarity ? '/' + r.polarity : ''}] ${r.who || ''} ${String(r.text || '').slice(0, 60)}`.trim());
          }
        }
        if (!s.total && !s.poolLines) L.push('（还没有任何记录——要么还没触发，要么两个采集开关都关了。）');
        return { content: L.join('\n') };
      }
    });

    api.registerTool({
      id: 'learning-loop__learning_note',
      name: '记一条学习台账',
      description:
        '把一条值得长期留意的信息写进学习台账（不是知识库）。适用：主人当面纠正你某个说法、明确表达了偏好，或让你"记一下"某件事。'
        + 'kind 选 correction（纠正）/ preference（偏好）/ fact（事实）/ other。要变成可检索的知识请用 knowledge-base__kb_remember，别用这个。',
      category: 'knowledge',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记的内容，一句话说清。' },
          kind: { type: 'string', enum: ['correction', 'preference', 'fact', 'other'], description: '类别，默认 other。' },
          note: { type: 'string', description: '可选补充说明（比如"谁说的""为什么"）。' },
          chatKey: { type: 'string', description: '可选，关联会话，如 group:123456。' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        return noteText({ ...(args || {}), chatKey: args?.chatKey || ctx?.chatKey || '' });
      }
    });

    api.registerTool({
      id: 'learning-loop__learning_candidates',
      name: '查看待学候选',
      description:
        '看候选池里积了哪些"还没够格入库"的内容 —— 按信源数排序，差 1 个信源就能入知识库的排在最前。'
        + '只读。想知道"我最近听过哪些可能有用的东西、还差谁来印证"时用它。',
      category: 'knowledge',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = readPool();
        if (!items.length) return { content: '候选池是空的。' };
        const s = settings();
        const clusters = clusterItems(items, s.simThreshold);
        const tz = dayTZ();
        const rows = clusters.map((c) => {
          const src = new Set(c.items.map((x) => x.senderId).filter(Boolean));
          const days = new Set(c.items.map((x) => localDay(x.t, tz)).filter(Boolean));
          const rep = c.items.find((x) => x.direct) || c.items[0];
          return {
            n: src.size, d: days.size, direct: c.items.some((x) => x.direct),
            who: [...new Set(c.items.map((x) => x.senderName || x.senderId))].join('/'),
            text: String(rep.text || '').slice(0, 70)
          };
        }).sort((a, b) => (b.direct ? 99 : b.n) - (a.direct ? 99 : a.n));

        const crossDay = s.crossDayConsensus !== false;
        const minDays = clampMinDays(s.minDays);
        const gate = crossDay ? `门槛 ${s.minSources} 个信源 / ${minDays} 个日期（${tz}）` : `门槛 ${s.minSources} 个信源`;
        const L = [`候选池 ${items.length} 条，归为 ${clusters.length} 簇（${gate}）：`];
        for (const r of rows.slice(0, 15)) {
          const tag = r.direct ? '主人直录'
            : `${r.n} 信源${crossDay && r.d > 1 ? ` / ${r.d} 日期` : ''}`;
          L.push(`· [${tag}] ${r.text}  ← ${r.who}`);
        }
        L.push('（达标的下一次批处理会自动写进本地知识库；未达标的继续等第二个信源或第二个日期。）');
        return { content: L.join('\n') };
      }
    });

    api.registerTool({
      id: 'learning-loop__learning_flush',
      name: '立刻结算候选池',
      description:
        '立刻跑一次批处理：把候选池里已经满足条件的写进本地知识库 —— 条件是「≥2 个不同信源说过」，或「同一个人在 ≥2 个不同日期重复说过」（按本地日期算），或主人明确要求记的。'
        + '平时由后台定时自动跑（默认 60 秒一次），只有想马上看到结果时才需要它。',
      category: 'knowledge',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const r = flushPool();
        if (r.ok === false) return { content: '没跑成：' + (r.reason || r.error || '未知原因'), isError: true };
        if (r.skipped) return { content: '共识入库开关是关的，没有处理。' };
        if (!r.total) return { content: '候选池是空的，没什么可结算的。' };
        if (!r.written) return { content: `候选池 ${r.total} 条 / ${r.clusters} 簇，暂时没有达标的（还在等更多信源或更多日期）。` };
        return {
          content: `已入库 ${r.written} 条：\n` + r.items.map((x) => `· ${x.title}（${x.label || (x.direct ? '主人直录' : x.sources + ' 信源')}）`).join('\n')
            + `\n候选池还剩 ${r.kept} 条。`
        };
      }
    });
  }

  log(`[learning] 学习台账已就绪：台账 ${countLines()} 行，候选池 ${readPool().length} 条，目录 ${DIR}`);
}

/**
 * 热重载 / 停用时清理定时器与内存缓冲。
 *
 * 缓冲**没有**任何落盘，所以这里清掉就是"真的不要了" —— 热重载后重新攒，
 * 最坏结果是少提炼一次，代价可以忽略；但不清就会在旧实例上挂着几十 KB 原始对话。
 */
function resetDistillState() {
  try { distillBuf.clear(); } catch { /* 清不掉就算了 */ }
  try { distillCount.clear(); } catch { /* 同上 */ }
  try { distilling.clear(); } catch { /* 同上 */ }
  try { warnAt.clear(); } catch { /* 同上 */ }
}

/** 热重载 / 停用时清理定时器，避免旧实例的定时器继续跑。 */
export function deactivate() { stopTimer(); resetDistillState(); }
export function dispose() { stopTimer(); resetDistillState(); }

/** 供别的插件/技能查询。 */
export const providers = {
  'learning.status': () => summarize(),
  'learning.note': (args = {}) => {
    try { return noteText(args || {}); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  },
  'learning.report': () => {
    const s = summarize();
    return { ok: true, counts: s.counts, total: s.total, ledgerLines: s.ledgerLines, updatedAt: s.updatedAt };
  },
  'learning.flush': (args = {}) => {
    try { return flushPool(args || {}); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }
};

// ── 第四期：记忆自检提醒 ─────────────────────────────────────────────────
//
// 为什么要它：前几期的入库判定全靠**统计共识** —— 同一件事被 ≥2 个不同信源说过、
// 或同一个人在 ≥2 个不同日期换措辞重复说过。这在真实群聊里几乎永不成立
// （实测 887 条候选聚成 873 簇，其中 860 簇只有 1 条）。于是换一条**不依赖统计**
// 的路：隔一阵子提醒模型「你自己看看，这段值不值得记」，由模型自己判断。
//
// 分工（很关键，别混）：
//   · 本文件只负责**提醒**（这条提示什么时候出现）；
//   · **判定**仍然在前三期那套共识逻辑里，一行没动 —— 提醒只是多给模型一次机会，
//     不改变任何"什么够格入库"的规则。

/**
 * 自检提示文案（写死常量，不读配置）。
 *
 * 三条自我约束：① 不超 120 字（一句话的量级，别把提示词撑胖）；
 * ② 明确给出工具名，否则模型会"在脑子里记一下"然后就没了；
 * ③ 末尾那句"没有就别记，也别提这件事"是必需品 —— 不然它会每轮都汇报
 *    "我刚检查了记忆，没有需要记的"，纯噪声。
 */
const REMIND_TEXT = '（自检：刚才这段里有没有值得长期记住的——主人的偏好/禁忌/约定、群里长期成立的事实、你答应过的事？有就调 knowledge-base__kb_remember 记一条，一句话；没有就别记，也别提这件事。）';

/**
 * chatKey → 已经累计、但还没提醒过的用户消息条数。
 *
 * ⚠️ **只放内存，不落盘**（刻意的）：进程重启就归零，最坏后果是"这一轮少提醒一次"。
 * 为了一次提醒去开文件、去扛多进程/热重载下的读写竞态，完全不值。
 */
const remindCount = new Map();

/** 已经攒够、等着找机会送达的 chatKey。 */
const remindDue = new Set();

/**
 * 内存表最多同时记多少个会话。
 * 群多 + 长跑进程时，Map 只增不减就是慢性泄漏；超了就从**最旧**的开始丢。
 */
const REMIND_MAX_CHATS = 500;

/**
 * 当前生效的提醒间隔（条）。
 *
 * 0 = 关闭（两个提醒钩子都零行为）。范围钳到 0~200，坏值退回 `DEFAULTS.remindEveryMsgs`
 * —— 2026-10-22 起那个默认值是 **0**（本机制已被定时提炼取代），所以坏配置的正确行为
 * 是"不提醒"，不是"退回 15"。和 minDays/dayTZ 一样：配置写坏只该退回默认，
 * 不该让功能炸掉或静默变行为。
 *
 * @returns {number} 0~200 的整数
 */
function remindEvery() {
  const raw = settings().remindEveryMsgs;
  // 布尔值不算数（Number(true)===1 会让"每 1 条提醒一次"，这是个坑）
  const n = (typeof raw === 'boolean') ? NaN : Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULTS.remindEveryMsgs;
  return Math.max(0, Math.min(200, n));
}

/**
 * 提醒的计数键：**优先 chatKey**，没有才退到 sessionId。
 *
 * 两个钩子拿到的 chatKey 是同一个（宿主的 skillContext 里带的），所以
 * before-context 记的数、before-llm-messages 一定读得到。
 * 退到 sessionId 只是兜底：会话重建后 sessionId 会变，那个会话就得重新攒 ——
 * 宁可多提醒一次，也不要跨会话串味（把 A 群的提醒发到 B 群）。
 *
 * @param {{chatKey?: string, sessionId?: string}} ctx 钩子上下文
 * @returns {string} 计数键；两者都没有时返回 ''
 */
function remindKey(ctx) {
  return String(ctx?.chatKey || ctx?.sessionId || '');
}

/** 内存表超上限时从最旧的开始丢（Map/Set 都保持插入顺序）。 */
function pruneRemind() {
  try {
    while (remindCount.size > REMIND_MAX_CHATS) {
      const k = remindCount.keys().next().value;
      if (k === undefined) break;
      remindCount.delete(k);
    }
    while (remindDue.size > REMIND_MAX_CHATS) {
      const k = remindDue.keys().next().value;
      if (k === undefined) break;
      remindDue.delete(k);
    }
  } catch { /* 清理失败不影响功能，下轮还会再试 */ }
}

/**
 * ① 计数（before-context）。
 *
 * 只数**本轮非 self 的触发消息**（`triggerEntries` 里 `self !== true` 的那些）：
 *   · 不数机器人自己的话 —— 否则她自问自答几个来回就把"15 条"刷满了；
 *   · 不用 `store.recent()` 回扫 —— 那是候选采集的口径，会把同一批消息数很多遍。
 *
 * 一条消息里 `triggerEntries` 可能有好几条（群里同时有人说话），所以是 **+N**
 * 而不是 +1。
 *
 * @param {object} ctx before-context 上下文
 * @returns {void}
 */
function bumpRemind(ctx) {
  const every = remindEvery();
  if (every <= 0) return;                          // 0 = 关闭，零行为
  if (settings().enabled === false) return;        // 总开关关了，提醒也不该冒出来
  const key = remindKey(ctx);
  if (!key) return;

  const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
  let n = 0;
  for (const e of entries) if (!e?.self) n++;      // 只数别人说的话
  if (n <= 0) return;

  const total = (remindCount.get(key) || 0) + n;
  remindCount.set(key, total);
  if (total >= every && !remindDue.has(key)) {
    remindDue.add(key);
    try { log(`[learning] 记忆自检到点（${key} 累计 ${total} 条 ≥ ${every}），本轮注入提醒`); } catch { /* 日志失败无所谓 */ }
  }
  pruneRemind();
}

/**
 * 把文本**追加到最后一条 user 消息的尾部**。
 *
 * 为什么必须是"最后一条 + 尾部"：提示词前缀缓存按 token 前缀命中，
 * 只有追加在**最末尾**才不动任何历史前缀（宿主的 stablePrefixViolation 告警专门盯这个）。
 *
 * ⚠️ `content` 不是字符串时**返回 false、什么都不改** —— 多模态消息的 content 是
 *    数组（`[{type:'image_url'},...]`），往里塞字符串会拼出非法结构。此时宁可本轮
 *    不提醒（调用方会把 due 保留到下轮），也不要弄坏一条消息。
 *
 * @param {Array<object>} messages 待发给模型的消息数组（原地修改）
 * @param {string} text 要追加的文本（调用方自带前导分隔符）
 * @returns {boolean} 是否真的送达（改到了某条消息）
 */
export function appendToLastUser(messages, text) {
  if (!Array.isArray(messages) || typeof text !== 'string' || !text) return false;
  let target = null;
  for (const m of messages) if (m && m.role === 'user') target = m;
  if (!target) return false;                       // 本轮没有 user 消息（纯系统/主动唤醒）
  if (typeof target.content !== 'string') return false;  // 多模态数组等：跳过，别拼坏
  target.content += text;
  return true;
}

/**
 * ② 注入（before-llm-messages）。
 *
 * 为什么不在 before-context 里 return 一段文本：宿主
 * `src/skills/manager.js runHook()` 会把每个插件的返回值收进 results[]，而
 * `src/orchestrator.js` 调 `runHook('before-context', ...)` 时**直接丢掉返回值** ——
 * 想改提示词只有 before-llm-messages 一条路（它给的是 messages 数组本体，可原地改）。
 *
 * **送达成功才清零**：找不到 user 消息（比如纯主动唤醒、或本轮被别的钩子拦了）
 * 就把 due 留着，等下一轮补上 —— 否则这一轮提醒就被白吃了，
 * 又得再等 15 条才轮到下一次。
 *
 * @param {object} ctx before-llm-messages 上下文
 * @returns {void}
 */
function injectRemind(ctx) {
  const every = remindEvery();
  if (every <= 0) return;                          // 0 = 关闭，零行为
  if (settings().enabled === false) return;
  const key = remindKey(ctx);
  if (!key || !remindDue.has(key)) return;

  const delivered = appendToLastUser(ctx?.messages, '\n\n' + REMIND_TEXT);
  if (!delivered) return;                          // 没送达：due 与计数原样保留，下轮再试
  remindDue.delete(key);
  remindCount.set(key, 0);
}

// ── 第五期：定时提炼 ─────────────────────────────────────────────────────
//
// 分工（和第四期最重要的区别）：
//   · 第四期 = 提醒主模型去调工具 → 依赖模型遵从度 → **实测 0/5，不可用**；
//   · 第五期 = 插件自己发起一次独立 LLM 调用 → 结果由插件解析 + 写库。
//     主模型完全不知情，也不需要表态。
//
// 三个"必须"：
//   ① after-response 里**必须**零 await —— 宿主 `src/orchestrator.js:1516` 是
//      `await skillManager.runHook('after-response', ...)`，跑在"回复已生成、尚未发出"
//      这段路上。这里 await 一次 300ms 的提炼，用户就少收 300ms。
//   ② 提炼**必须**可失败：拿不到 chatCompletion / 网络错 / JSON 脏 / 查重挂掉，
//      一律静默放弃本轮，等下个周期再攒 —— 它只是"锦上添花"，不配拖垮主流程。
//   ③ 缓冲**必须**只在内存：不落盘（一个畸形 JSON 文件不该让整个插件起不来），
//      也不进提示词（那会击穿前缀缓存 —— 见文件头纪律 1）。

/**
 * 提炼的 system prompt 模板。
 *
 * 刻意写死成常量而不是设置项：这段文字的每一个字都在约束模型的输出格式，
 * 让用户能改它等于允许"把 JSON 格式改坏"，那下游的解析就全废了。
 * 唯一随配置变化的是条数上限 `{N}`。
 *
 * @param {number} n 最多挑几条
 * @returns {string} 拼好的 system prompt
 */
function distillSystemPrompt(n) {
  return [
    '你是记忆整理员。从下面这段群聊/私聊记录里，挑出**值得长期记住**的内容，最多 ' + n + ' 条，没有就返回空数组。',
    '',
    '值得记的：主人的偏好/禁忌/称呼/约定；长期成立的事实（谁是谁、谁明确说过的偏好与雷区、固定活动）；她自己答应过的事。',
    // 「不要记」这段是 2026-10-22 真机第一位样本之后收紧的：模型当时挑了「她不擅长辩论」——
    // 对真人的能力判断。原来的"隐私八卦"太窄，模型显然没把它理解成"别给人贴标签"。
    // 这类内容一旦入库，**以后每次相关话题都会被检索注入、当事实用**，一句群聊里的随口评价
    // 会变成机器人的长期信念 —— 危害远大于"记错一条琐事"。所以显式点名，并堵掉两个常见借口：
    // "听起来像事实"（能力判断常常听起来像事实）与"说话的人很确定"（确定不等于该记）。
    '不要记：一时情绪、玩笑、当天琐事、隐私八卦、能从上下文重建的东西；',
    '尤其不要记对任何人（群友、其他 AI、主人）的能力、性格、外貌、私生活的评价与推断，'
      + '哪怕它听起来像事实、哪怕说话的人很确定。',
    '',
    '严格只输出 JSON 数组，不要解释、不要 markdown：',
    // [[learning:quote-check]] 2026-10-22 起要求每条带 quote（原话）。
    // 为什么：下一步会拿 quote 回查输入记录，找不到的就是模型自己编/合并出来的 —— 丢。
    // quote 必须**逐字照抄**，不许改写；这也是它对"我记得他这么说过"最便宜的自我约束。
    '[{"title":"不超过 20 字的标题","text":"一句话说清，不超过 80 字","quote":"这段记录里的一句原话，10~40 字，必须逐字照抄不许改写"}]'
  ].join('\n');
}

// ── 缓冲参数 ─────────────────────────────────────────────────────────────

/** 每个会话最多缓冲多少行（user + assistant 合计）。40 行足够覆盖 15~20 条触发量。 */
const DISTILL_LINE_MAX = 40;
/** 最多同时缓冲多少个会话；超了丢最旧的，防长跑进程里 Map 只增不减（慢性泄漏）。 */
const DISTILL_CHAT_MAX = 200;
/** 喂给提炼模型时，**单条**消息最多留多少字。 */
const DISTILL_ITEM_CHARS = 200;
/** 喂给提炼模型时，**整段**最多多少字（超了从最早的开始丢，保住最近的上下文）。 */
const DISTILL_TEXT_MAX = 3000;
/** 模型回复存进缓冲时截断到多少字 —— 我们只要"她答应了什么"，不要整篇小作文。 */
const DISTILL_ASSISTANT_CHARS = 300;
/** 查重线：知识库检索最高分 ≥ 这个值就认为"已经有了"，跳过不写。 */
const DISTILL_DUP_SCORE = 0.55;
/**
 * 人类优先闸的分数线（比查重线低）。
 *
 * 为什么比 0.55 低：人类那条的标题是 `titleOf(消息正文)` 取前 20 字，和模型自己起的
 * 标题措辞天然差很多，检索分数也就天然偏低。宁可少写一条，也不要盖掉人说过的话。
 */
const DISTILL_HUMAN_SCORE = 0.35;
/** "人类证据"的 weight 下限：共识 3 / 直录 4 都算；w2 是自动提炼自己的同类，不拦。 */
const DISTILL_HUMAN_WEIGHT = 3;
/** weight 读不出来时按这个算 —— 知识库对无 front-matter 的旧文件默认就是 3（人）。 */
const DISTILL_DEFAULT_WEIGHT = 3;
/**
 * 探针 B（按 topic 找同一篇）一次最多看多少条命中。
 *
 * `knowledge.search` 自己把 `limit` 夹在 1~30，所以这里直接取满 30：
 * 用 topic 当查询词时同 topic 那条几乎总在最前，但多留些余量以防语料里同词文档很多。
 */
const DISTILL_TOPIC_PROBE_LIMIT = 30;

/**
 * chatKey → 环形缓冲（`Array<{role:'user'|'assistant', text:string}>`）。
 *
 * ⚠️ 只放内存、不落盘：理由是**隐私**（这是原始对话文本，台账那套只留片段）
 * 和**健壮性**（进程重启归零，最坏只是少提炼一次）。
 */
const distillBuf = new Map();

/**
 * chatKey → 已累计、还没拿去提炼的**非 self 用户消息**条数。
 *
 * 和第四期的 remindCount 是同一个口径（只数 triggerEntries 里 `self !== true` 的），
 * 但**互不复用**：第四期已经关掉了，两个计数器绑在一起会让"关掉提醒"顺手关掉提炼。
 */
const distillCount = new Map();

/** 正在提炼中的 chatKey —— 挡第二层重入（第一层是 runDistill 开头的计数归零）。 */
const distilling = new Set();

/** 每次判定要喂多少行：比触发阈值多 5 行，给模型一点"上文"垫底。 */
const DISTILL_CONTEXT_PAD = 5;

/**
 * 当前生效的提炼间隔（条）。
 *
 * 坏值 / 布尔值一律退回默认 15（`Number(true) === 1` 会让"每 1 条提炼一次"，
 * 那等于每轮都打一次 API，必须挡掉）。范围钳到 3~200。
 *
 * @returns {number} 3~200 的整数
 */
function distillEvery() {
  const raw = settings().distillEveryMsgs;
  const n = (typeof raw === 'boolean') ? NaN : Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULTS.distillEveryMsgs;
  return Math.max(3, Math.min(200, n));
}

/**
 * 单次最多入库几条（0~5）。
 *
 * 0 是**观察档**：照常调模型、照常解析、照常打日志，但一条都不写 ——
 * 想先看看"它到底会挑什么"再决定要不要让它写的时候用。
 *
 * @returns {number} 0~5 的整数
 */
function distillMax() {
  const raw = settings().distillMaxItems;
  const n = (typeof raw === 'boolean') ? NaN : Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULTS.distillMaxItems;
  return Math.max(0, Math.min(5, n));
}

/** 提炼专用模型名；空串 = 跟随主模型。 */
function distillModelName() {
  try { return String(settings().distillModel ?? '').trim(); } catch { return ''; }
}

/**
 * 提炼功能当前是否该工作（全局开关 + 自己的开关，两个都要开）。
 *
 * @returns {boolean}
 */
function distillOn() {
  try {
    const s = settings();
    return s.enabled !== false && s.distillEnabled !== false;
  } catch { return false; }
}

/** 提炼的计数键：优先 chatKey，没有才退到 sessionId（同 remindKey 的口径）。 */
function distillKey(ctx) {
  return String(ctx?.chatKey || ctx?.sessionId || '');
}

/**
 * 日志限频：同一个 tag 的错误 10 分钟只 warn 一次。
 *
 * 为什么需要：这段代码跑在 fire-and-forget 里，出错时**没人接**。
 * 如果每次都 warn，一个坏掉的端点会以"每 15 条一次"的频率往日志里刷同样的堆栈，
 * 把真正有用的日志淹掉 —— 那比不报还糟。
 *
 * @param {string} tag 错误分类（同一个 tag 共用一个 10 分钟窗口）
 * @param {string} msg 日志正文
 * @returns {void}
 */
const WARN_GAP_MS = 10 * 60 * 1000;
const warnAt = new Map();
function warnThrottled(tag, msg) {
  try {
    const now = Date.now();
    const last = warnAt.get(tag) || 0;
    if (now - last < WARN_GAP_MS) return;
    warnAt.set(tag, now);
    if (warnAt.size > 64) warnAt.clear();   // 键是有限枚举，清空只是保险
    warn(String(msg).slice(0, 400));
  } catch { /* 连日志都失败就真的算了 */ }
}

/**
 * 缓冲表超上限时丢最旧的会话（Map 保持插入顺序）。
 *
 * ⚠️ `protect` 是刚写入的那个 chatKey —— 如果它恰好是最旧的一个，
 *    无脑 `keys().next()` 会**当场把它自己的缓冲删掉**（新会话攒到 201 个时必现）。
 *
 * @param {string} [protect] 不许被丢掉的 chatKey
 * @returns {void}
 */
function pruneDistill(protect = '') {
  try {
    while (distillBuf.size > DISTILL_CHAT_MAX) {
      let victim = '';
      for (const k of distillBuf.keys()) { if (k !== protect) { victim = k; break; } }
      if (!victim) break;
      distillBuf.delete(victim);
      distillCount.delete(victim);
    }
    while (distillCount.size > DISTILL_CHAT_MAX) {
      let victim = '';
      for (const k of distillCount.keys()) { if (k !== protect) { victim = k; break; } }
      if (!victim) break;
      distillCount.delete(victim);
    }
  } catch { /* 清理失败不影响功能，下轮还会再试 */ }
}

/**
 * 往某个会话的环形缓冲里追加一行。
 *
 * @param {string} key chatKey
 * @param {'user'|'assistant'} role 角色
 * @param {string} text 正文
 * @returns {boolean} 是否真的加进去了（空文本不加）
 */
function distillPush(key, role, text) {
  if (!key) return false;
  const t = String(text ?? '').trim();
  if (!t) return false;
  let arr = distillBuf.get(key);
  if (!arr) { arr = []; distillBuf.set(key, arr); }
  arr.push({ role: role === 'assistant' ? 'assistant' : 'user', text: t });
  if (arr.length > DISTILL_LINE_MAX) arr.splice(0, arr.length - DISTILL_LINE_MAX);
  pruneDistill(key);
  return true;
}

/**
 * 从响应体里取"模型说的话"。
 *
 * 三种形态都要接住：字符串 / 多模态数组（`[{type:'text',text}]`）/ 只有 tool_calls
 * （`content === null`，此时没有正文，返回 ''）。
 *
 * @param {object} resp chatCompletion 的返回值
 * @returns {string} 纯文本正文，取不到返回 ''
 */
function distillResponseText(resp) {
  try {
    const c = resp?.message?.content;
    if (typeof c === 'string') return c.trim();
    if (Array.isArray(c)) {
      const parts = [];
      for (const p of c) {
        if (p && typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim());
      }
      return parts.join(' ').trim();
    }
  } catch { /* 结构不对就当作没有正文 */ }
  return '';
}

/**
 * ① 缓冲用户消息（before-context）。
 *
 * 口径与第四期 bumpRemind 完全一致：只认 `ctx.triggerEntries` 里**非 self** 的条目，
 * 一条消息里可能有好几条（群里同时有人说话）→ 是 **+N** 不是 +1。
 *
 * 顺带 `stripHostMarks`：把 `[引用 某人：旧话]`、`[图片]`、CQ 码剥掉，
 * 只留这个人自己说的话 —— 否则提炼模型会把**被引用者的旧话**当成新信息再记一遍。
 *
 * @param {object} ctx before-context 上下文
 * @returns {void}
 */
function distillRecordUser(ctx) {
  if (!distillOn()) return;
  const key = distillKey(ctx);
  if (!key) return;
  const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
  let n = 0;
  for (const e of entries) {
    if (!e || e.self) continue;                       // 机器人自己的话不缓冲、不计数
    const raw = stripHostMarks(e.text);
    if (!raw) continue;                               // 拍一拍/纯图片：没有内容
    if (distillPush(key, 'user', clip(raw, DISTILL_ITEM_CHARS))) n++;
  }
  if (n > 0) distillCount.set(key, (distillCount.get(key) || 0) + n);
}

/**
 * ② 缓冲模型回复（after-response）。
 *
 * ⚠️ **不累加 distillCount**：触发阈值数的是"用户说了多少条"，
 *    把机器人自己的话也算进去，她自问自答几个来回就把 15 条刷满了。
 *
 * @param {object} ctx after-response 上下文（`{...skillContext, response, session}`）
 * @returns {void}
 */
function distillRecordAssistant(ctx) {
  if (!distillOn()) return;
  const key = distillKey(ctx);
  if (!key) return;
  const text = distillResponseText(ctx?.response);
  if (!text) return;                                  // 纯工具调用轮：没有正文
  distillPush(key, 'assistant', clip(text, DISTILL_ASSISTANT_CHARS));
}

/**
 * 把某个会话最近若干行拼成"给提炼模型看的那一段"。
 *
 * 规格：每条 `角色：内容`、单条截断 200 字、**总长 ≤ 3000 字**。
 * 超预算时**从最早的开始丢**（不是从最新的）—— 判断"这段值不值得记"，
 * 离现在最近的几句权重最高，砍掉开头比砍掉结尾合理。
 *
 * @param {string} key chatKey
 * @param {number} want 最多取多少行
 * @returns {string} 拼好的正文；没有内容时返回 ''
 */
function distillTranscript(key, want) {
  const arr = distillBuf.get(key);
  if (!Array.isArray(arr) || !arr.length) return '';
  const n = Math.max(1, Math.round(Number(want) || 0));
  const tail = arr.slice(-n);
  const lines = [];
  let total = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const it = tail[i];
    const who = it.role === 'assistant' ? '她' : '对方';
    const line = `${who}：${String(it.text || '').slice(0, DISTILL_ITEM_CHARS)}`;
    if (total + line.length + 1 > DISTILL_TEXT_MAX) break;
    lines.push(line);
    total += line.length + 1;
  }
  lines.reverse();
  return lines.join('\n');
}

/**
 * 惰性拿宿主的 `chatCompletion`。
 *
 * 为什么**不用静态 import**：静态 import 一旦解析失败（宿主升级改名、打包路径变化），
 * 整个插件在 `setup()` 之前就崩了 —— 那会把第一~三期的采集能力一起带走。
 * 而这段代码的契约是「拿不到就本轮放弃」，所以必须是**运行时可失败**的。
 *
 * 成功一次就缓存（模块命名空间对象），失败只限频 warn，下个周期自动重试。
 *
 * @returns {Promise<object|null>} 成功返回模块命名空间，失败返回 null
 */
let llmMod = null;
async function loadLlm() {
  if (llmMod) return llmMod;
  try {
    const m = await import('../../src/llm.js');
    if (m && typeof m.chatCompletion === 'function') { llmMod = m; return m; }
    warnThrottled('llm-shape', '[learning] 定时提炼：src/llm.js 里没有 chatCompletion，放弃提炼');
    return null;
  } catch (e) {
    warnThrottled('llm-load', '[learning] 定时提炼：加载 src/llm.js 失败，放弃本轮：' + (e?.message ?? e));
    return null;
  }
}

/**
 * 给 chatCompletion 准备 `overrides`。
 *
 * ⚠️ 这是本文件最容易踩的坑：`src/llm.js:655` 是 `const baseApi = overrides || effectiveApi()`
 *    —— overrides 是**整体替换**，不是浅浅合并。只传 `{ model }` 会让 baseUrl/apiKey
 *    变成 undefined，请求必失败（而且报错还像"模型不存在"，很难查）。
 *    所以必须把主链路的整套配置带上，只把 model 换掉。
 *
 * @param {string} model 目标模型名
 * @param {object} mod llm.js 的模块命名空间（用来取 resolveApiKey）
 * @returns {object} 可直接交给 chatCompletion 的 overrides
 */
function distillOverrides(model, mod) {
  let cfg = {};
  try { cfg = getConfig() || {}; } catch { cfg = {}; }
  const main = (cfg.api && typeof cfg.api === 'object') ? cfg.api : {};
  const out = { ...main, model };
  try {
    if (mod && typeof mod.resolveApiKey === 'function') {
      const k = String(mod.resolveApiKey(cfg) || '').trim();
      if (k) out.apiKey = k;                  // 多提供商场景下真 key 在 providers/dshProviderKeys 里
    }
  } catch { /* 取不到就沿用 cfg.api.apiKey */ }
  return out;
}

/**
 * 解析时最多收多少条 —— 防模型抽风返 200 条把写库拖爆。
 * 注意它只是**上限保护**，不是配置项：真正决定写几条的是 `distillMaxItems`。
 */
const DISTILL_PARSE_MAX = 20;

/**
 * ② 解析模型输出（脏输入是常态，必须全程不抛）。
 *
 * 处理链：剥 ```json 围栏 → 取第一个 `[` 到最后一个 `]` → JSON.parse → 逐项校验。
 * 任何一步失败都返回 `[]`（= 本轮没挑出东西），**不抛**：
 * 抛出去只会变成一条 fire-and-forget 里的 unhandled rejection。
 *
 * 校验规则：
 *   · 必须是数组（`JSON.parse('{"a":1}')` 能过，要挡）；
 *   · 每项 `title` / `text` 都得是**非空字符串**（模型爱返 `null` 或数字）；
 *   · `title` 截 24 字、`text` 截 120 字（超了不丢，只截 —— 内容还是好的）；
 *   · 最多收 `DISTILL_PARSE_MAX` 条。
 *
 * @param {string} raw 模型原始输出
 * @returns {Array<{title: string, text: string}>} 合法条目（可能为空）
 */
function parseDistillItems(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let body = text;
  // 剥 markdown 围栏（```json ... ``` / ``` ... ```）；只剥**首尾**，不动正文
  body = body.replace(/^```[A-Za-z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  const a = body.indexOf('[');
  const b = body.lastIndexOf(']');
  if (a < 0 || b <= a) return [];                     // 前后带解释文字也能救回来；纯粹没有数组就放弃
  body = body.slice(a, b + 1);
  let arr = null;
  try { arr = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const title = typeof x.title === 'string' ? x.title.trim() : '';
    const txt = typeof x.text === 'string' ? x.text.trim() : '';
    if (!title || !txt) continue;
    // [[learning:quote-check]] quote 是"它引用的原话"，下一步逐条回查输入记录。
    // 缺失时留空（而不是丢），由调用方决定怎么处理 —— 见 verifyQuotes()
    // hasQuoteField：模型到底有没有输出 quote 这个字段。这是区分"契约没生效
    // （换了模型/没读提示）"和"它偷懒没写"的唯一依据 —— 两者处理方式相反。
    const hasQuoteField = typeof x.quote === 'string';
    const quote = hasQuoteField ? x.quote.trim().slice(0, 80) : '';
    out.push({ title: title.slice(0, 24), text: txt.slice(0, 120), quote, hasQuoteField });
    if (out.length >= DISTILL_PARSE_MAX) break;
  }
  return out;
}

// ── [[learning:quote-check]] 原文回查（2026-10-22，借「事件记忆」的 A 招）────────
// 治什么：提炼是**模型写的**，它会把两句合成一句、把"听起来像事实"的东西写成肯定句。
// 一旦入库，以后每次相关话题都会被检索当事实用 —— 编一条比漏十条严重。
// 做法：要求它给 quote（原话），然后把 quote 拿去**刚喂进去的那段记录**里逐字找。
//   归一化只做"去空白 + 去标点 + 全角半角"，不改字、不做模糊匹配 —— 模糊匹配等于没查。
// 契约没生效时（模型一条 quote 都不给）**不拦**，只告警：否则一次不听话就停摆。

/** 归一化：去空白、去标点、全角转半角。只用来比对，不改变落库内容。 */
function normForQuote(s) {
  let out = String(s ?? '');
  try { out = out.normalize('NFKC'); } catch { /* 老引擎没有 normalize 就用原串 */ }
  return out
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]+/gu, '')
    .toLowerCase();
}

/** quote 至少这么长（归一化后）才算证据 —— 太短的片段到处都能命中，等于没查。 */
const QUOTE_MIN_CHARS = 6;

/**
 * 逐条回查：quote 必须出现在 transcript 里。
 * @param {Array<{title:string,text:string,quote:string}>} items
 * @param {string} transcript 喂给模型的那段记录
 * @returns {{kept: Array, dropped: Array, contractOff: boolean}}
 */
export function verifyQuotes(items, transcript) {
  const hay = normForQuote(transcript);
  const kept = [];
  const dropped = [];
  let withQuote = 0;
  for (const it of items) {
    const q = normForQuote(it.quote);
    if (q.length >= QUOTE_MIN_CHARS) {
      withQuote += 1;
      if (hay.includes(q)) { kept.push(it); continue; }
      dropped.push({ title: it.title, reason: 'quote 在原文里找不到', quote: String(it.quote || '').slice(0, 40) });
      continue;
    }
    dropped.push({ title: it.title, reason: it.quote ? 'quote 太短，不能当证据' : '没给 quote' });
  }
  // 一条 quote 字段都没有 = 新契约没生效（换模型/模型没读提示）：放行但明确告警，
  // 不用"静默全丢"来惩罚一次格式波动。
  // ⚠️ 判据必须是"有没有这个字段"，不是"有没有值" —— 否则模型只要每条都给空 quote，
  //    就会被误判成"契约没生效"，整个检查形同虚设（2026-10-22 自测抓到这条）。
  const anyField = items.some((it) => it && it.hasQuoteField !== false);
  const contractOff = !anyField && items.length > 0;
  if (contractOff) {
    warnThrottled('quote', '[learning] 定时提炼没有返回 quote（新契约未生效），本次跳过原文回查');
    return { kept: items.slice(), dropped: [], contractOff: true };
  }
  // 契约生效时，"没给 quote / quote 太短"的条目在上面已经进了 dropped ——
  // 否则它只要故意不写 quote 就能绕过检查。
  return { kept, dropped, contractOff };
}

/**
 * 写前判定：① 查重 ＋ ② 人类优先闸（**双探针**）＋ ③ 无法判定时不写。
 *
 * （函数名沿用 `distillDuplicate`，免得已有行号索引全乱；它现在做的是三道判定。）
 *
 * ── ① 查重：探针 A 的最高分 ≥ 0.55 就跳过 ────────────────────────────────
 * 用 `knowledge.search` 的**最高分**判断"这件事是不是已经记过了"，
 * 不打模型、零额外成本。阈值 0.55 刻意偏"松"：宁可漏判一次重复（多一条近似条目），
 * 也不要把新事实误判成旧的丢掉 —— 知识库能容错，记忆丢了就没了。
 *
 * ── ② 人类优先闸：库里那篇是"人"的，机器就不写 ──────────────────────────
 * 背景（2026-10-22 两次事故）：topic 归一之后 `自动·X` 与 `共识·X` 落到同一篇、
 * 走 `mode:'upsert'`。实测自动提炼写进来时 `replaced:true`、同一个文件、
 * **weight 从 3 掉到 2、人类正文被机器短句顶掉**。方向反了 ——
 * 机器猜的东西凭什么覆盖两个人说过的话？
 *
 * ⚠️ **只靠分数判会漏（R4 修的正是这个）**：`knowledge.search` 是 BM25 系，
 *    它在返回前先用 knowledge-base 自己的 `minScore`（默认 0.12）把低分条目滤掉
 *    （`knowledge-base/index.js:870`）。而 BM25 的 `idf = log(1 + (N−df+0.5)/(df+0.5))`
 *    会**随语料里提到同一批词的文档变多而塌缩**：实测灌 25 条"也提这些词但说别的事"的
 *    文档后，人类那条从 0.371 掉到 **0.027**，直接掉出 `hits` → ①②**同时**失效
 *    → 照写 → upsert 覆盖人类那条（就是上面那个事故原样复现）。
 *    把阈值调低或给 search 传 `minScore:0` 都救不了：原始分只有 0.027，离 0.35 差一个数量级。
 *
 * 所以身份判定改走**结构性等价**，不看分数：
 *
 *   自动路径**唯一能破坏人类内容的方式**就是 `findLearnedByTopic(topicKey)` 命中 ——
 *   只有 topic 相等才会 upsert 覆盖同一篇；topic 不同只会新开一篇（无害的重复）。
 *   所以真正要回答的问题是「**库里有没有同 topic 且 weight ≥ 3 的条目**」，
 *   而不是「分数够不够高」。于是加**探针 B**：
 *
 *     ① 探针 A：`query = 标题 + 正文`（limit 3，用 kb 自己的门槛）→ 查重 + 分数式人类证据
 *     ② 探针 B：`query = topic 本身`，`minScore:0`、`weightBoost:0`、`limit:30`
 *        → 拿回所有"字面相关"的条目，再按 **`hit.topic === topic`** 判身份。
 *        用 topic 当查询词，同 topic 那条的 token 重叠最强、天然排在前面；
 *        `minScore:0` 绕开 kb 的门槛，IDF 塌缩也不会把它滤掉。
 *        （`hit.topic` 是 kb 自己算好的归一化 topic，和我们要写的完全可比；
 *          拿不到时用 `topicOf(hit.docTitle)` 兜底。）
 *
 * ── ③ fail-closed：判不了就不写 ──────────────────────────────────────────
 * 探针 A/B 任一**抛错 / 返回 `ok:false` / 返回 null** → `unverified:true` → **不写**。
 * R3 把"查不到"当成了"当作没重复"，方向反了；一次没验成的人可能是下一次覆盖的元凶。
 * 取舍：漏记一条还能补，覆掉人说过的话就找不回来了。
 *
 * `weight` 口径：`≥3` 是人类（共识 3 / 直录 4 / 旧文件默认 3）；`==2` 是我们自动的同类，
 * 交给 ① 管；**缺失或非数字一律按 3**（知识库对无 front-matter 的旧文件默认就是 3，
 * 看不到时只能保守）。
 *
 * ⚠️ 这道闸**只作用于自动提炼路径**。`flushPool` / `ingestCluster`（人类路径）
 *    一行没动 —— 人类覆盖机器是应该的，反过来的方向才需要挡。
 *
 * @param {{title: string, text: string}} item 待写条目
 * @param {string} topic 即将写入的 topic（= `topicOf('自动·' + item.title)`）
 * @returns {{dup: boolean, best: number, human: (object|null), unverified: boolean, reason: string}}
 */
function distillDuplicate(item, topic) {
  // ── 探针 A：标题 + 正文（查重 / 分数式人类证据）──
  let a = null;
  try {
    a = apiRef?.capability?.('knowledge.search', {
      query: `${item.title} ${item.text}`.slice(0, 200), limit: 3
    });
  } catch (e) {
    warnThrottled('probe-a', '[learning] 定时提炼探针A抛错（本轮不写）：' + (e?.message ?? e));
    return { dup: false, best: 0, human: null, unverified: true, reason: '探针A抛错' };
  }
  if (!a || a.ok === false) {
    warnThrottled('probe-a-off', '[learning] 定时提炼探针A不可用（本轮不写）：knowledge.search 没返回有效结果');
    return { dup: false, best: 0, human: null, unverified: true, reason: '探针A不可用' };
  }

  // ── 探针 B：topic 本身（结构性身份；minScore:0 绕开 kb 的门槛）──
  let b = null;
  try {
    b = apiRef?.capability?.('knowledge.search', {
      query: String(topic || '').slice(0, 80),
      limit: DISTILL_TOPIC_PROBE_LIMIT,
      minScore: 0,        // 关键：不关这个，IDF 塌缩的条目根本不会出现在 hits 里
      weightBoost: 0      // 别让权重改排名，我们要的是"能召回"，不是"排序好看"
    });
  } catch (e) {
    warnThrottled('probe-b', '[learning] 定时提炼探针B抛错（本轮不写）：' + (e?.message ?? e));
    return { dup: false, best: 0, human: null, unverified: true, reason: '探针B抛错' };
  }
  if (!b || b.ok === false) {
    warnThrottled('probe-b-off', '[learning] 定时提炼探针B不可用（本轮不写）：knowledge.search 没返回有效结果');
    return { dup: false, best: 0, human: null, unverified: true, reason: '探针B不可用' };
  }

  // fail-closed：`hits` 不是数组也算"判不了"。四种情况一律不写（主理人 2026-10-22 确认）：
  //   抛错 / ok:false / null / hits 不是数组。
  if (!Array.isArray(a.hits) || !Array.isArray(b.hits)) {
    warnThrottled('probe-shape', '[learning] 定时提炼探针返回的 hits 不是数组（本轮不写）');
    return { dup: false, best: 0, human: null, unverified: true, reason: 'hits 不是数组' };
  }
  const hitsA = a.hits;
  const hitsB = b.hits;

  // 探针 B 若明确说"查询词太短或全被过滤"（hits 空 + reason 非空），那是**查不成**，不是"库里没有"。
  // QA 实测：topic 被分词吃光（如 topic='1' / 'a' / '好'）时 search 返回
  //   { ok:true, hits:[], reason:'查询词太短或全被过滤' }
  // 返回结构是"干净的空"，靠 ok / 数组类型**判不出来** —— 只能看 reason。
  // 不判这一下，闸会以为"库里没有同 topic 的条目"而放行，直接覆盖人类条目。
  if (hitsB.length === 0 && String(b.reason || '').trim()) {
    warnThrottled('probe-b-void', '[learning] 定时提炼探针B 查询无效（' + b.reason + '），本轮不写');
    return { dup: false, best: 0, human: null, unverified: true, reason: '探针B 查询无效' };
  }

  // ① 查重（分数式，只看探针 A）
  let best = 0;
  for (const h of hitsA) {
    const sc = Number(h?.score);
    if (Number.isFinite(sc) && sc > best) best = sc;
  }

  // ② 结构性人类证据：探针 B 里 topic 相等的那些
  const want = String(topic || '');
  let human = null;
  if (want) {
    for (const h of hitsB) {
      const t = distillHitTopic(h);
      // 取不到身份 → 我们无法排除"这条就是同一篇"，按 fail-closed 不写。
      if (!t) {
        warnThrottled('probe-topic', '[learning] 定时提炼探针B 命中但取不到 topic（本轮不写）');
        return { dup: false, best: 0, human: null, unverified: true, reason: '命中取不到 topic' };
      }
      if (t !== want) continue;
      const w = distillHitWeight(h);
      if (w < DISTILL_HUMAN_WEIGHT) continue;          // 同 topic 的 w2 = 我们自己写的，放行（交给 ① 去重）
      human = { score: Number(h?.score) || 0, weight: w, via: 'topic' };
      break;                                            // 同 topic 只可能有一篇，命中即可
    }
  }

  // ②′ 分数式人类证据（第二道网，覆盖"topic 没对上但内容确实是同一件事"的老数据）
  if (!human) {
    for (const h of hitsA) {
      const sc = Number(h?.score);
      if (!Number.isFinite(sc) || sc < DISTILL_HUMAN_SCORE) continue;
      const w = distillHitWeight(h);
      if (w < DISTILL_HUMAN_WEIGHT) continue;
      if (!human || sc > human.score) human = { score: sc, weight: w, via: 'score' };
    }
  }

  return { dup: best >= DISTILL_DUP_SCORE, best, human, unverified: false, reason: '' };
}

/**
 * 取一条检索命中的 **topic 身份**（双路取，取不到返回 ''）。
 *
 * 为什么不只看 `hit.topic`：`hit.topic` 是 knowledge-base 算好的归一化 topic，正常都在；
 * 但旧文件没有 front-matter、或将来 kb 改了返回字段时它可能缺。所以再退一路用标题现算：
 * `hit.topic || topicOf(hit.docTitle || hit.title)`。
 *
 * ⚠️ 三处原文全空 → 返回 `''`，调用方**必须按 fail-closed 处理（不写）**。
 *    这不是"当它没命中"，而是"我们无法排除它就是同一篇"。
 *
 * @param {object} hit `knowledge.search` 的一条命中
 * @returns {string} 归一化 topic；取不到时 ''
 */
function distillHitTopic(hit) {
  const rawTopic = String(hit?.topic || '').trim();
  if (rawTopic) return topicOf(rawTopic);                 // kb 给的已归一化，topicOf 幂等
  const rawTitle = String(hit?.docTitle || hit?.title || '').trim();
  if (rawTitle) return topicOf(rawTitle);
  return '';
}

/**
 * 取一个检索命中的 weight；**缺失或非数字一律按 3（人）**。
 *
 * 为什么不能默认成 0：知识库对没有 front-matter 的旧文件默认 weight 就是 3，
 * 我们看不到 weight 时只能按"这是人写的"保守处理 —— 少记一条的代价，
 * 远小于抹掉人说过的话。
 *
 * @param {object} hit `knowledge.search` 的一条命中
 * @returns {number} 归一后的整数 weight
 */
function distillHitWeight(hit) {
  const raw = hit?.weight;
  if (raw === undefined || raw === null) return DISTILL_DEFAULT_WEIGHT;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : DISTILL_DEFAULT_WEIGHT;
}

/**
 * 写库。
 *
 * `weight` 固定 **2**，是这套设计里最值得解释的一个数字：
 *   · 主人直录 = 4（人亲口说的）
 *   · 群共识   = 3（两个以上的人都说过）
 *   · 自动提炼 = 2（**机器猜的**）
 * kb_search 的排序是 `1 + 0.12 × (weight − 3)`，所以 weight 2 会排在人类共识之后 ——
 * 这是对的：它是猜的，凭什么压过两个真人？
 * 同 weight 2 的还有"同一人跨日重复"。两者证据强度本来就同级：
 * 一个反复念叨的人，和一个认真读过上下文的模型，谁更可信？不好说。
 *
 * `topic` 让同一件事反复提炼时落到同一篇（`mode:'upsert'` 覆盖而不是新开文件）。
 * 因为 `topicOf` 把 `自动·` 也当来源前缀卸掉，这个 topic 会和**人类共识**产出的
 * topic 完全相同 —— 所以"机器先猜了一条、后来两个人也说了"时，后者会 upsert 覆盖
 * 同一篇（weight 从 2 升到 3，h1 换成 `共识·…`），而不是在旁边再开一篇。
 * **反方向（机器覆盖人类）不成立**：写之前 `distillDuplicate()` 的人类优先闸会拦下来，
 * 见那里的注释 —— 人说的不该被机器猜的顶掉。
 *
 * @param {string} title 已带 `自动·` 前缀的标题
 * @param {string} text 正文
 * @param {number} every 提炼间隔（写进 source 供人回溯）
 * @param {string} model 提炼模型名（空 = 主模型）
 * @param {string} [topicIn] 已算好的 topic。**必须**由调用方把人类优先闸用的那一个透传进来 ——
 *        否则闸判的是 A、写的是 B，一旦两处算法漂移就会闸门失守（那种 bug 极难发现）。
 * @returns {{ok?: boolean, error?: string}|null} knowledge.write 的返回值
 */
function distillWrite(title, text, every, model, topicIn = '') {
  try {
    return apiRef?.capability?.('knowledge.write', {
      title,
      content: text,
      tags: '自动提炼',
      weight: 2,
      topic: topicIn || topicOf(title),
      mode: 'upsert',
      source: `自动提炼（每 ${every} 条 · ${model || '主模型'}）`
    }) || { ok: false, error: 'knowledge.write 不可用（knowledge-base 没装或没启用）' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 跑一次提炼。**只从 maybeDistill 的 fire-and-forget 里进来**，绝不 await 在钩子体里。
 *
 * 流程：取最近 N+PAD 行 → 一次独立调用 → 解析 → 逐条查重 → 逐条写库。
 *
 * @param {string} key chatKey
 * @returns {Promise<void>} 永不 reject（内部全包）
 */
async function runDistill(key) {
  const every = distillEvery();
  const maxItems = distillMax();
  const model = distillModelName();

  const transcript = distillTranscript(key, every + DISTILL_CONTEXT_PAD);
  if (!transcript) return;

  const mod = await loadLlm();
  if (!mod) return;                                   // 拿不到 LLM：本轮放弃，下个周期再来

  // 观察档（maxItems === 0）也要问出条数，否则日志里永远是"识别 0 条"，
  // 就失去了"先看看它会挑什么"的意义。写库那一步再按 0 条拦掉。
  const ask = maxItems > 0 ? maxItems : DEFAULTS.distillMaxItems;

  let resp = null;
  try {
    resp = await mod.chatCompletion({
      messages: [
        { role: 'system', content: distillSystemPrompt(ask) },
        { role: 'user', content: transcript }
      ],
      tools: null,
      temperature: 0.2,
      maxTokens: 400,
      tag: 'distill',
      overrides: model ? distillOverrides(model, mod) : null
    });
  } catch (e) {
    warnThrottled('call', '[learning] 定时提炼调用失败（本轮放弃）：' + (e?.message ?? e));
    return;
  }

  const items = parseDistillItems(distillResponseText(resp));
  if (!items.length) {
    try { log(`[learning] 定时提炼：这段没有值得长期记的内容（${key}）`); } catch { /* 日志失败无所谓 */ }
    return;
  }

  // [[learning:quote-check]] 原文回查：拿它自己给的 quote 回查刚喂进去的记录。
  // 找不到 = 这句话是它编的/合并出来的 → 不进库（并留一条日志，便于回头对账）。
  const vq = verifyQuotes(items, transcript);
  if (vq.dropped.length) {
    try {
      log(`[learning] 定时提炼 丢弃 ${vq.dropped.length} 条（原文回查未过）：`
        + vq.dropped.map((d) => `${d.title}〔${d.reason}〕`).join('；'));
    } catch { /* 同上 */ }
  }
  const verified = vq.kept;
  if (!verified.length) {
    try { log(`[learning] 定时提炼：${items.length} 条候选全部没过原文回查，本次不写库`); } catch { /* 同上 */ }
    return;
  }

  // 观察档：只判不写
  if (maxItems <= 0) {
    try {
      log(`[learning] 定时提炼（只判不写）：本会记 ${verified.length} 条 → ${verified.map((x) => x.title).join('、')}`);
    } catch { /* 同上 */ }
    return;
  }

  const picked = verified.slice(0, maxItems);
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const it of picked) {
    const title = '自动·' + it.title;
    const topic = topicOf(title);
    const gate = distillDuplicate(it, topic);

    // ① 判不了就不写。R3 曾经把"查不到"当成"没重复"，方向反了：
    //    一次没验成的人，很可能就是下一次被覆盖的元凶。
    if (gate.unverified) {
      skipped++;
      try {
        log(`[learning] 定时提炼 skip-unverified（${gate.reason}）：${title}`);
      } catch { /* 同上 */ }
      continue;
    }
    // ② 查重：已经有一篇高度相似的了
    if (gate.dup) {
      skipped++;
      try { log(`[learning] 定时提炼 skip-dup（${gate.best.toFixed(2)}）：${title}`); } catch { /* 同上 */ }
      continue;
    }
    // ③ 人类优先闸：库里那篇是"人"的（共识 3 / 直录 4 / 旧文件默认 3）→ 机器不写。
    //    topic 合并之后自动路径会 upsert 到同一篇，不挡就会出现"机器短句顶掉人类长文、
    //    顺手把 weight 从 3 降到 2"—— 方向反了。
    //    `via=topic` 是结构性判定（免疫 BM25 的 IDF 塌缩）；`via=score` 是分数式第二道网。
    if (gate.human) {
      skipped++;
      const via = gate.human.via === 'topic' ? '/topic' : '';
      try {
        log(`[learning] 定时提炼 skip-human（${gate.human.score.toFixed(2)}/w${gate.human.weight}${via}）：${title}`);
      } catch { /* 同上 */ }
      continue;
    }
    const r = distillWrite(title, it.text, every, model, topic);
    if (r && r.ok !== false) written++;
    else {
      failed++;
      warnThrottled('write', '[learning] 定时提炼写库失败：' + String(r?.error || '写入被拒'));
    }
  }
  try {
    log(`[learning] 定时提炼完成（${key}）：写入 ${written} 条 / 查重跳过 ${skipped} 条 / 失败 ${failed} 条`);
  } catch { /* 同上 */ }
}

/**
 * ③ 到点了吗？到点就**扔出去**，不等。
 *
 * `void (async () => {...})()` 是刻意的：宿主在 `orchestrator.js:1516` 用
 * `await runHook('after-response', ...)` 调我们，跑在"回复已生成、还没发出去"这一段。
 * 这里只要有一个 await，用户就多等一次 API 的时间。
 *
 * 两层防重入：
 *   ① 计数**立刻**归零（同步，抛异步之前）—— 同一轮里 after-response 可能被调用多次
 *      （工具循环），第二次进来时计数已经是 0，不会再触发；
 *   ② `distilling` Set —— 上一轮提炼还没跑完（网络慢），这一轮攒够了也不许并发。
 *
 * @param {object} ctx after-response 上下文
 * @returns {void}
 */
function maybeDistill(ctx) {
  if (!distillOn()) return;
  const key = distillKey(ctx);
  if (!key) return;
  const every = distillEvery();
  const have = distillCount.get(key) || 0;
  if (have < every) return;
  if (distilling.has(key)) return;                     // 上一次还没跑完
  distillCount.set(key, 0);                            // ① 立刻归零：不重复、不漏
  distilling.add(key);                                 // ② 同步占位，挡住并发
  try {
    log(`[learning] 定时提炼到点（${key} 累计 ${have} 条 ≥ ${every}），后台起一次独立调用`);
  } catch { /* 日志失败无所谓 */ }
  void (async () => {
    try { await runDistill(key); }
    catch (e) { warnThrottled('run', '[learning] 定时提炼异常：' + (e?.message ?? e)); }
    finally { distilling.delete(key); }
  })();
}

export const hooks = {
  /** ① 采集反馈信号 + ③ 采集共识候选 + ④ 记忆自检计数 + ⑤ 提炼缓冲（纯同步，绝不抛）。 */
  'before-context'(ctx = {}) {
    try { collectFeedback(ctx); } catch (e) { try { warn('[learning] 反馈采集失败：' + (e?.message ?? e)); } catch { /* 连日志都失败就算了 */ } }
    try { collectCandidates(ctx); } catch (e) { try { warn('[learning] 候选采集失败：' + (e?.message ?? e)); } catch { /* 同上 */ } }
    try { bumpRemind(ctx); } catch (e) { try { warn('[learning] 自检计数失败：' + (e?.message ?? e)); } catch { /* 同上 */ } }
    try { distillRecordUser(ctx); } catch (e) { warnThrottled('buf-user', '[learning] 提炼缓冲（用户）失败：' + (e?.message ?? e)); }
  },
  /** ② 采集知识缺口（纯同步，绝不抛）。 */
  'after-tool'(ctx = {}) {
    try { collectGap(ctx); } catch (e) { try { warn('[learning] 缺口采集失败：' + (e?.message ?? e)); } catch { /* 同上 */ } }
  },
  /** ④ 记忆自检提醒：只追加到最后一条 user 消息尾部（纯同步，绝不抛）。 */
  'before-llm-messages'(ctx = {}) {
    try { injectRemind(ctx); } catch (e) { try { warn('[learning] 自检提醒注入失败：' + (e?.message ?? e)); } catch { /* 同上 */ } }
  },
  /**
   * ⑤ 提炼缓冲 + 触发。
   *
   * ⚠️ 本钩子**必须是同步的、必须零 await**：宿主 `orchestrator.js:1516` 是
   *    `await skillManager.runHook('after-response', ...)`，它跑在
   *    "模型回复已经生成、但还没推给用户"这段路上。这里 await 一次 300ms 的提炼，
   *    用户就实实在在少收 300ms —— 所以真正的调用扔进 fire-and-forget（见 maybeDistill）。
   */
  'after-response'(ctx = {}) {
    try { distillRecordAssistant(ctx); } catch (e) { warnThrottled('buf-assistant', '[learning] 提炼缓冲（回复）失败：' + (e?.message ?? e)); }
    try { maybeDistill(ctx); } catch (e) { warnThrottled('trigger', '[learning] 提炼触发失败：' + (e?.message ?? e)); }
  }
};

export function available() { return true; }
