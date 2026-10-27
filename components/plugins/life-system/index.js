// 生活系统 v0.7 —— 世界观 + 日历 + 事件账本。不再模拟作息数值。
//
// 为什么推倒重来（2026-09-19 复盘）：
//   原先把作息算成饱腹/困倦/精力数值再喂给模型，两头都输：
//   · 注入里带「接下来 18:20 吃晚饭」这种绝对钟点 + 未来动作，模型一定念出口；
//   · 数值长期为负（按公式一天清醒时间近一半在扣分），规则又写着"困饿就少说话"，
//     于是接上生活系统反而把灵气压掉。
//   一致性也不该靠数值模拟 —— 真人不会自相矛盾，是因为他记得自己刚说过什么。
//
// 现在只做三件事，全部零额外 LLM 调用：
//   1) 世界观：一段用户自定义的静态文本进 system（逐字节不变 → 命中显式缓存）。
//   2) 日历：只有节假日/调休/假期前后补一行，普通日子什么都不注入。
//   3) 事件账本：它自己说过的话（"我吃饱了"）+ 按世界观抽的随机事件，
//      同分组只留最新 → 结构上不可能出现"上一句说吃完、下一句喊饿"。
//
// 时间感知本来就有：prompt.js 每轮注入【当前时间】2026-09-19 17:17:05（周六），这里绝不重复报时。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { noteEntry, decayInfo, ageLabel, FLOOR, DEAD } from '../../src/half-life.js';
import { dayInfo, dayModifiers } from './calendar.js';
import { parseScheduledEvents, activeScheduledEvents } from './schedule.js';
import { parsePoolItems } from './event-normalizer.js';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// 日历表是插件随附的静态资源，整合包只打包 plugins、不打包 data。
// 老安装仍可回退到 data/life-calendar.json；显式重定向 DATA_DIR 时也允许它覆盖内置表。
const CAL_FILE = path.join(PLUGIN_DIR, 'life-calendar.json');
const LEGACY_CAL_FILE = path.join(DATA_DIR, 'life-calendar.json');
const EVENTS_FILE = path.join(DATA_DIR, 'life-events.json');
const MIN = 60 * 1000;
const HOURMS = 60 * MIN;
// 世界 ≠ 人设。这段开场白就是要把它钉死，否则模型会把世界当性格演。
const WORLD_RULE = '【世界】下面是你所处世界的设定（城市、天气、规矩、周围会发生什么），**不是你的性格**：你是谁看【角色设定】。'
  + '只把它当背景板：被问到、或话题正好挨着的时候才体现，别主动播报，也别编这套设定里没有的细节。';

// [[static-world-only]] 2026-10-22：给「没有 travel-whale 的宿主」用的一道闸。
// 背景：世界书是**一格共享设置**，travel-whale 会往里写「她此刻人在【非洲·肯尼亚】旅行…」。
// 把 config 整份拷到另一台宿主时，那台没有 travel-whale，却会把这句当成自己的世界注入 ——
// 这比"没有世界设定"更糟（她会认真讲一个自己没去过的地方）。
// 判据刻意收窄：只认 travel-whale 的两个签名写法，普通静态世界设定（哪怕含"旅行"二字）照常放行。
// 默认 false = 行为不变（晴雨有 travel-whale，需要动态世界）。
const FOREIGN_WORLD_RE = /此刻人在|（背景速写|\(背景速写/;
let foreignWorldSkipped = false;

let cfg = () => ({});
let log = () => {};
let calCache = { file: '', mtime: 0, table: null, loaded: false, source: '' };
let smartCaptureChain = Promise.resolve();
const pendingToolCaptures = new Map();
let lastScheduleErrorKey = '';
let jevUnavailableLogged = false;
// Jev 只保留可选适配接口；插件本体不依赖具体实现。需要增强主语判断时可注入同形适配器。
let jevAdapter = null;
const EMPTY_JEV = {
  jevGate: null,
  localJevEnabled: () => false,
  cloudJevAllowsRole: () => false
};

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  jevAdapter = api?.lifeSystemJev && typeof api.lifeSystemJev === 'object' ? api.lifeSystemJev : null;
}

export function setJevAdapter(adapter) {
  jevAdapter = adapter && typeof adapter === 'object' ? adapter : null;
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 1) 日历 ────────────────────────────────────────────────────────────
function calendarCandidates() {
  const candidates = [];
  // QQ_AGENT_DATA_DIR 是显式的数据目录重定向（测试/便携/多实例场景），其中的表可作为用户覆盖。
  if (process.env.QQ_AGENT_DATA_DIR && fs.existsSync(LEGACY_CAL_FILE)) {
    candidates.push({ file: LEGACY_CAL_FILE, source: 'data-override' });
  }
  candidates.push({ file: CAL_FILE, source: 'plugin' });
  // 没有随插件附带日历表的旧安装继续可用。
  candidates.push({ file: LEGACY_CAL_FILE, source: 'legacy' });
  return candidates.filter((candidate, i, all) => all.findIndex((x) => x.file === candidate.file) === i);
}

function readCalendar() {
  for (const candidate of calendarCandidates()) {
    let st;
    try { st = fs.statSync(candidate.file); } catch { continue; }
    if (!st.isFile()) continue;
    if (calCache.loaded && calCache.file === candidate.file && calCache.mtime === st.mtimeMs) {
      return { table: calCache.table, file: candidate.file, source: candidate.source };
    }
    try {
      const table = JSON.parse(fs.readFileSync(candidate.file, 'utf8'));
      if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
      calCache = { file: candidate.file, mtime: st.mtimeMs, table, loaded: true, source: candidate.source };
      return { table, file: candidate.file, source: candidate.source };
    } catch { /* 文件损坏时继续尝试兼容回退文件 */ }
  }
  calCache = { file: '', mtime: 0, table: null, loaded: false, source: '' };
  return null;
}

function loadCalendar(force = false) {
  if (cfg().calendarEnabled === false) return null;
  if (force) calCache = { file: '', mtime: 0, table: null, loaded: false, source: '' };
  return readCalendar()?.table ?? null;
}

function calendarFileMeta() {
  const result = readCalendar();
  if (!result) return { exists: false, year: 0, holidays: 0, makeup: 0, expired: false, source: '' };
  const table = result.table;
  const source = result.source === 'plugin' ? '插件内置'
    : result.source === 'data-override' ? '自定义数据目录'
      : '旧版 data 回退';
  return {
    exists: true,
    year: Number(table.year) || 0,
    holidays: Object.keys(table.holidays || {}).length,
    makeup: Object.keys(table.makeupWorkdays || {}).length,
    expired: (Number(table.year) || 0) < new Date().getFullYear(),
    source
  };
}

/** 今天是什么日子。日历关掉或表不可读时返回 null。 */
export function today(date = new Date()) {
  if (cfg().calendarEnabled === false) return null;
  const table = loadCalendar();
  if (!table) return null;
  const info = dayInfo(date, table);
  return {
    dayKey: localDayKey(date),
    weekLabel: info.weekLabel,
    kind: info.kind,
    name: String(info.name || ''),
    // note 只在"不平凡"的日子有内容：假期第几天 / 调休上班 / 明天就放假 / 假期刚结束。
    // 普通工作日与普通周末是空串 —— 那正是要的省 token 行为。
    note: String(info.note || ''),
    expired: !!info.expired,
    holidays: Object.keys(table.holidays || {}).length,
    makeup: Object.keys(table.makeupWorkdays || {}).length,
    year: Number(table.year) || 0
  };
}

export function calendarLine(t = today()) {
  if (!t || !t.note) return '';
  return `（日历）${t.note}。被问到就说这个，别自己排日程。`;
}

// ── 3) 事件账本 ────────────────────────────────────────────────────────
// facts 按分组存、同组覆盖：这就是"一致性底线"的实现 —— 每类状态任何时刻只有一个说法。
// 分组 = 一致性作用的单位（同组覆盖）。世界类分组（sea/city/home/user）是"外面发生了什么"，
// 生理类（meal/rest）是"她身上发生了什么"，各自独立覆盖，互不干扰。
//
// ⚠️ 2026-09-21 改成**随时间半衰**（原来是 `until = at + ttl` 硬过期，到点整条消失）：
//   见 src/half-life.js 的说明。换算关系刻意选成 hl = ttl / 2 —— 这样"权重掉到 0.25"
//   正好等于原来那个到期时刻，下面这些调过的数值一个都不用重调，只是中间多了渐变：
//   刚说过时是满的、一个半衰期后剩一半、两个半衰期后不再主动提。
const GROUP_TTL_MIN = {
  meal: 150, rest: 240, work: 120, play: 180, social: 240,
  sea: 300, city: 360, home: 360, net: 120, misc: 300
};
const halfLifeOf = (group) => Math.max(5, (GROUP_TTL_MIN[group] ?? 180) / 2);

// 状态类（meal/rest）：她随时可以被问"吃了吗"，所以要留着 —— 但**不能每轮都塞**。
// 2026-09-21 实测（号A 私聊）：一条「还没吃，肚子空着」在 109 分钟里被注入 17 次、
// 「刚睡过一觉起来」121 分钟里被注入 37 次。后果是她会反复念叨同一件事（"我更饿了"…），
// 而且这句话又会被 SAY_RULES 抓回去续期，形成自我强化。
// 现在的规则：状态类只在**还够浓**（weight ≥ STATE_MIN_WEIGHT）时主动递、且最多递
// STATE_MAX_SHOWN 次；淡下去之后仍留在账本里维持一致性，只在**话题正好问到这件事时**才递。
const STATE_GROUPS = new Set(['meal', 'rest']);
const STATE_MIN_WEIGHT = 0.45;   // 主动递的浓度门槛（≈ 1.15 个半衰期）
const STATE_ASK_WEIGHT = 0.25;   // 被问到时还愿意答的浓度门槛（= 2 个半衰期，与旧的"到期"对齐）
const STATE_MAX_SHOWN = 3;       // 同一条状态最多主动递几次
// 素材类（随机事件/世界近况）：只在还没递过、且没淡太多时出现一次
const MATERIAL_MIN_WEIGHT = 0.35;
// "话题正好挨着"的判定：对方在问吃/睡，就把对应状态递过去（这样"吃了吗"永远答得上）
const STATE_TOPIC = {
  meal: /吃|饭|饿|外卖|食堂|宵夜|夜宵|奶茶|零食|喝点|点单|下厨|做饭/,
  rest: /睡|困|醒|熬夜|起床|歇|累|失眠|午觉|打盹/
};
const USED_KEEP = 80;           // 最近用过的素材文本，滚动保留

// 它自己发出去的话 → 事实。这是账本的主来源：说到过就算发生过。
// 事件池默认关闭后，这套正则是账本的主入口；宁可稍宽，也不要「说了吃了却没记上」。
// 同组只留最新；命中多条规则时按数组顺序，后写覆盖前写（更具体的放后面）。
const SAY_RULES = [
  // ── 吃 ──
  ['meal', /吃饭(?:了|啦|咯|完|中)?|吃(?:了)?(?:早|午|晚|宵夜|点心|零食)饭/, '刚吃过东西', 90],
  ['meal', /(?:刚|已经|才|早上|中午|晚上)?(?:吃了|吃完|吃过|吃过了|扒了|炫了|搓了|整了)(?:饭|面|粉|火锅|烧烤|外卖|食堂|早餐|午饭|晚饭|宵夜|点心|蛋糕|零食)?/, '刚吃过东西', 90],
  ['meal', /吃饱(?:了|啦|咯|嗝)|吃撑(?:了|啦)|肚子(?:饱|好饱)|干饭(?:完|了|中)/, '刚吃过东西', 90],
  ['meal', /下(?:午)?饭|点(?:了)?外卖|吃(?:了)?外卖|去(?:了)?食堂|开饭|干饭/, '正在吃 / 刚安排上吃的', 75],
  ['meal', /(?:好|超|快|要|有点)?饿(?:死|了|得不行|扁|晕)?|还没吃|没吃饭|没吃呢|肚子(?:叫|空|咕咕)|空着肚子/, '还没吃，肚子空着', 90],
  ['meal', /想(?:吃|喝)(?:点|些|什么|啥)?|吃点什么|喝点啥|晚饭吃啥|中午吃啥/, '在想吃什么', 60],

  // ── 睡 / 累 ──
  ['rest', /(?:去|先|准备)?睡(?:了|觉|会儿|一会儿)|先躺(?:了|会)|眯(?:一会儿|个|了)|刚醒|起床(?:了|啦)?|醒过来|睡醒/, '刚睡过一觉起来', 180],
  ['rest', /困(?:死|得|了|了不行)|想睡|犯困|眼皮(?:重|打架)|熬(?:夜|到|通宵)|没睡(?:好|够|着)|失眠|补觉/, '没睡好，犯困', 180],
  ['rest', /好累|累(?:死|了|成狗|瘫)|精疲力尽|瘫(?:了|在)/, '挺累的，想歇', 120],

  // ── 正事 ──
  ['work', /在忙|忙(?:着|完|死|晕)|加班|赶(?:稿|工|ddl|DDL|进度)|剪(?:片|视频)|开播|下播|上课|写(?:作业|代码|文档|报告)|搬砖|上班(?:了|中)?|打工/, '手上有事在忙', 120],
  ['work', /会(?:议|开完)|开会|对接|需求|改(?:稿|需求|bug|BUG)|debug|排(?:查|错)|写(?:周)?报/, '在弄工作上的事', 120],

  // ── 玩 ──
  ['play', /(?:打|开)(?:了)?(?:几把|一把|两把|游戏|排位|本|团)|上分|掉分|看(?:了)?(?:番|剧|完|视频)|刷(?:了)?(?:b站|B站|视频|手机|动态)|摸(?:了)?鱼|开黑/, '玩了一会儿没管别的', 150],
  ['play', /追(?:剧|番)|听(?:歌|音乐)|看(?:小说|漫画|直播)|刷(?:手机|视频)/, '在休闲摸鱼', 120],

  // ── 出门 / 社交 ──
  ['social', /(?:跟|和)(?:朋友|同学|同事|她|他|谁)(?:出去|吃饭|玩|连麦|逛街)|约(?:了|出去|饭|玩)|出门(?:了|一趟|办事)?|回来了|到家了|在外面/, '在外面跑了趟', 180],
  ['social', /逛街|超市|快递|拿外卖|下楼|散步|溜达/, '出门办了点小事', 150]
];
const SPEECH_GROUPS = new Set(['meal', 'rest', 'work', 'play', 'social']);

function emptyLedger() {
  return { version: 2, dayKey: '', facts: {}, rolled: 0, lastRollAt: 0, used: {} };
}

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyLedger();
    return {
      version: 2,
      dayKey: String(raw.dayKey || ''),
      facts: raw.facts && typeof raw.facts === 'object' ? raw.facts : {},
      rolled: Number(raw.rolled) || 0,
      lastRollAt: Number(raw.lastRollAt) || 0,
      used: raw.used && typeof raw.used === 'object' ? raw.used : {}
    };
  } catch {
    return emptyLedger();
  }
}

/** 记下"这条素材什么时候用过"，rollEvent 与注入都靠它避免重播。 */
function markUsed(l, text, now = Date.now()) {
  const t = String(text || '').trim();
  if (!t) return;
  l.used = { ...(l.used || {}), [t]: now };
  const keys = Object.keys(l.used);
  if (keys.length > USED_KEEP) {
    for (const k of keys.sort((a, b) => (Number(l.used[a]) || 0) - (Number(l.used[b]) || 0)).slice(0, keys.length - USED_KEEP)) {
      delete l.used[k];
    }
  }
}

function saveLedger(l) {
  const tmp = `${EVENTS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2), 'utf8');
    fs.renameSync(tmp, EVENTS_FILE);
    const written = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (!written || typeof written !== 'object' || !written.facts || typeof written.facts !== 'object') {
      throw new Error('事件账本写入后回读校验失败');
    }
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    log('life-system 写事件账本失败：', e?.message ?? e);
    return false;
  }
}

// 事件池只读取已规范化的指令事件。旧版 eventPool 文本保留兼容迁移入口，
// 但复杂原文没有确认摘要时不会进入随机池。
export function eventPool(c = cfg()) {
  return parsePoolItems(c.eventPoolItems, c.eventPool)
    .filter((item) => item.enabled !== false && item.status === 'ready' && item.summary)
    .map((item) => ({
      id: item.id,
      group: item.group,
      text: item.summary,
      weight: item.weight,
      cooldownH: item.cooldownH,
      timeRelation: item.timeRelation
    }));
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** 种子含当天与"第几条"，同一天抽到同一批事件，重启不跳戏。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 只留还够浓的事实（半衰），浓的在前。shown>0 表示这条已经当话题递给过模型。 */
function liveFacts(l, now = Date.now()) {
  return Object.entries(l.facts || {})
    .map(([g, f]) => {
      // 老数据只有 ttl/until（硬过期）：迁移成 hl = ttl/2，语义与原来完全对齐
      const hl = Number(f?.hl) || (Number(f?.ttl) ? Number(f.ttl) / 2 : halfLifeOf(g));
      const info = decayInfo({ ...f, hl }, now, hl);
      return {
        group: g,
        text: String(f?.text || ''),
        // v2 旧账本没有 source：生活状态分组按角色自述处理，其它旧分组按事件池素材迁移。
        source: String(f?.source || (SPEECH_GROUPS.has(g) ? 'speech' : 'pool')),
        at: Number(f?.at) || 0,
        shown: Number(f?.shown) || 0,
        ttl: Math.round(hl * 2),          // 兼容老字段（控制台在用）：等价半衰期对应的硬 TTL
        hl,
        weight: info.weight,
        ageMin: Math.round(info.ageMin || 0),
        // minsLeft 给控制台显示"这条还能站多久"，一致性的可见化
        minsLeft: info.minsLeft
      };
    })
    .filter((f) => f.text && f.weight > FLOOR)
    .sort((a, b) => b.weight - a.weight);
}

/** 顺手清理：淡到没意义的（≈4 个半衰期）没必要留在文件里。 */
function pruneFacts(l, now = Date.now()) {
  let removed = 0;
  for (const [g, f] of Object.entries(l.facts || {})) {
    const hl = Number(f?.hl) || (Number(f?.ttl) ? Number(f.ttl) / 2 : halfLifeOf(g));
    const ageMin = Number(f?.at) ? (now - Number(f.at)) / MIN : Infinity;
    if (ageMin === Infinity || Math.pow(0.5, ageMin / hl) < DEAD) { delete l.facts[g]; removed += 1; }
  }
  if (removed) saveLedger(l);
  return removed;
}

/** 记一条事实（同组覆盖 = 一致性）。被换掉的旧文本进 used，避免它过几小时又被抽回来。 */
export function noteFact(group, text, ttlMin, { now = Date.now(), source = 'speech' } = {}) {
  const g = String(group || 'misc').toLowerCase();
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return null;
  const l = loadLedger();
  // 半衰期 = 旧 TTL 的一半（这样"权重掉到 0.25"= 原来那个到期时刻）
  const hl = ttlMin == null ? halfLifeOf(g) : clamp(num(ttlMin, halfLifeOf(g) * 2) / 2, 3, 360);
  const prev = l.facts?.[g];
  const old = String(prev?.text || '');
  const entry = noteEntry(l.facts || (l.facts = {}), g, t, {
    halfLifeMin: hl,
    now,
    // 续期上限按**总寿命**对齐老规则：老代码把 until 夹在 bornAt+1.5×TTL，也就是
    // "同文本最多活 1.5×TTL"。换成半衰后总寿命 = (at 被推到的最晚点) + 2×hl，
    // 所以 at 最多推到 bornAt + 1.5×TTL − 2×hl = bornAt + 0.5×TTL = bornAt + hl → capFactor 1。
    capFactor: 1,
    maxKeys: 8,
    onEvict: (k, e) => markUsed(l, e?.text, now)
  });
  if (entry) entry.source = String(source || 'speech');
  if (old && old !== t && entry) markUsed(l, old, now);
  saveLedger(l);
  return entry;
}

/**
 * 这句话该不该记成"我自己的状态"？
 *
 * 实测漏网（2026-09-21）：她说「你这刚醒就问我吃啥 不先关心自己饿不饿」——
 * 那是**在说对方**，却被记成「还没吃，肚子空着」挂在自己头上两小时。
 * 注意只看整句里有没有"我"是不够的（这句里就有"问我"），得看**匹配到的那个词附近**的主语。
 *
 * 规则：
 *   ① 整句有第二/三人称、且完全没有第一人称 → 不是她的状态；
 *   ② 有第二/三人称时，匹配词前 8 个字里必须出现"我/咱"，否则算在说别人；
 *   ③ 疑问句（她在问别人）不算。
 */
function speaksAboutSelf(s, matchIndex = 0) {
  const t = String(s || '');
  const other = /你|您|你们|他|她|他们|她们|别人|大家|对方/.test(t);
  const firstAnywhere = /我|咱|本鲸|本鱼/.test(t);
  if (other && !firstAnywhere) return false;
  if (other) {
    const before = t.slice(Math.max(0, matchIndex - 8), matchIndex);
    if (!/我|咱/.test(before)) return false;
  }
  if (/[？?]\s*$/.test(t) || /(吗|呢|么)[。！!？?]?\s*$/.test(t)) return false;
  return true;
}

/** 扫它自己要发出去的文本：说到什么就记什么。 */
export function captureFromText(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  let hits = 0;
  for (const [group, re, fact, ttl] of SAY_RULES) {
    const m = re.exec(s);
    if (!m) continue;
    if (!speaksAboutSelf(s, m.index)) continue;   // 主语/语气不对：不记成自己的状态
    noteFact(group, fact, ttl, { now });
    hits += 1;
  }
  return hits;
}

/** 这句是不是"主语含糊"：既提到我、又提到你/他 —— 正则判不准，值得问一次 Jev。 */
export function isAmbiguousSubject(s) {
  const t = String(s || '');
  const mine = /我|咱|本鲸|本鱼/.test(t);
  const other = /你|您|你们|他|她|他们|她们|别人|大家|对方/.test(t);
  return mine && other;
}

function optionalJevAvailable() {
  try {
    const jevApi = jevAdapter || EMPTY_JEV;
    if (typeof jevApi.jevGate !== 'function') return false;
    const local = typeof jevApi.localJevEnabled === 'function' && jevApi.localJevEnabled();
    const cloud = typeof jevApi.cloudJevAllowsRole === 'function' && jevApi.cloudJevAllowsRole('selfStateGate');
    return local || cloud;
  } catch (error) {
    if (!jevUnavailableLogged) {
      jevUnavailableLogged = true;
      log('life-system Jev 增强不可用，使用本地正则：', error?.message ?? error);
    }
    return false;
  }
}

/**
 * 带 Jev 复核的捕获（钩子里用这个）。
 *
 * 为什么需要：正则只能看字面。实测 2026-09-21 漏网的那句
 * 「你这刚醒就问我吃啥 不先关心自己饿不饿」——里面有"我"（问我），正则以为是在说自己，
 * 于是把"还没吃"挂在她头上两小时。这种**主语含糊**的句子交给 Jev 判一次最省事：
 *   · 只在含糊句子上问（清晰句子直接走正则，零成本、零延迟）
 *   · Jev 弃权/不可用/超时 → 回退正则，行为不变
 *   · 判成 OTHER → 这一句不记任何状态
 */
async function captureFromTextSmartOnce(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  const matched = SAY_RULES.filter(([, re]) => re.test(s));
  if (!matched.length) return 0;

  let selfVerdict = null;   // null = 没问/问不出，回退正则
  if (isAmbiguousSubject(s) && optionalJevAvailable()) {
    try {
      // jevGate 自带：角色开关检查 + spec 提示词 + 弃权语义（on=true 表示"在说它自己"）
      const g = await (jevAdapter || EMPTY_JEV).jevGate('selfStateGate', s.slice(0, 160), { timeoutMs: 1200 });
      if (g && !g.error && !g.abstain) selfVerdict = !!g.on;
    } catch (error) { log('life-system 主语判定失败，回退正则：', error?.message ?? error); }
  }

  let hits = 0;
  for (const [group, re, fact, ttl] of matched) {
    const m = re.exec(s);
    const ok = selfVerdict === null ? speaksAboutSelf(s, m.index) : selfVerdict;
    if (!ok) continue;
    noteFact(group, fact, ttl, { now });
    hits += 1;
  }
  return hits;
}

/** 串行化带 Jev 等待的记账，避免多个异步捕获互相覆盖账本更新。 */
export function captureFromTextSmart(text, options = {}) {
  const run = smartCaptureChain.then(() => captureFromTextSmartOnce(text, options));
  smartCaptureChain = run.catch((error) => {
    log('life-system 串行记账失败：', error?.message ?? error);
    return 0;
  });
  return run;
}

/** 某条素材是否"最近用过"（同一条趣闻在 eventRepeatH 小时内不该再演一遍）。 */
function usedRecently(l, text, now, repeatMs) {
  if (!repeatMs) return false;
  const at = Number(l.used?.[String(text || '').trim()]) || 0;
  return !!at && now - at < repeatMs;
}

/** 按世界设定抽一条随机事件。跳过：池关 / 当天已够 / 间隔未到 / 同组已有活跃事实 / 近期用过。 */
function rollEvent({ now = Date.now(), force = false } = {}) {
  const c = cfg();
  if (!scheduleRollAllowed(c)) return false;
  // 开关关 = 只走台词正则；打开才从池子抽（手动「抽一条」可 force）
  if (!force && c.eventPoolEnabled !== true) return false;
  const poolOn = c.eventPoolEnabled === true || force;
  if (!poolOn) return false;
  const perDay = clamp(num(c.eventsPerDay, c.eventPoolEnabled === true ? 4 : 0), 0, 8);
  if (perDay <= 0) return false;
  const pool = eventPool(c);
  if (!pool.length) return false;
  const gap = clamp(num(c.eventGapMin, 75), 15, 720) * MIN;
  let l = loadLedger();
  const dk = localDayKey(new Date(now));
  const rolled = l.dayKey === dk ? num(l.rolled, 0) : 0;
  if (rolled >= perDay) return false;
  if (l.dayKey === dk && now - num(l.lastRollAt, 0) < gap) return false;
  const alive = new Set(liveFacts(l, now).map((f) => f.group));
  // 同组已有未过期事实就跳过：不然"刚说过吃过了"会被抽到的一条饿顶掉。
  // 再用"近期用过"过滤掉重复素材；两者都空时宁可这条不抽（宁缺勿重）。
  const fresh = pool.filter((e) => {
    const cooldownH = Number.isFinite(Number(e.cooldownH)) ? Number(e.cooldownH) : num(c.eventRepeatH, 72);
    const cooldownMs = clamp(cooldownH, 0, 720) * HOURMS;
    return !alive.has(e.group) && !usedRecently(l, e.text, now, cooldownMs);
  });
  if (!fresh.length) return false;
  const random = mulberry32(hashStr(`${dk}|${rolled}|${c.eventSeed || ''}`))();
  const totalWeight = fresh.reduce((sum, item) => sum + Math.max(1, Number(item.weight) || 1), 0);
  let cursor = random * totalWeight;
  const pick = fresh.find((item) => {
    cursor -= Math.max(1, Number(item.weight) || 1);
    return cursor < 0;
  });
  if (!pick) return false;
  l.dayKey = dk;
  l.rolled = rolled + 1;
  l.lastRollAt = now;
  markUsed(l, pick.text, now);
  saveLedger(l);
  noteFact(pick.group, pick.text, undefined, { now, source: 'pool' });
  return true;
}

/**
 * 注入用的一行近况（最多 2 条、过去/现在时、不含钟点）。
 *
 * 递法（2026-09-21 改半衰）：
 *   · 状态类（吃/睡）：还够浓（weight ≥ STATE_MIN_WEIGHT）时最多主动递 STATE_MAX_SHOWN 次；
 *     淡下去之后只在她**被问到这件事**（contextText 里出现吃/睡相关词）、且没淡透
 *     （weight ≥ STATE_ASK_WEIGHT）时才递。这样"吃了吗"永远答得上，又不会 2 小时念叨 37 次。
 *   · 素材类：只在还没被递过、且没淡太多时出现一次，之后留在账本里维持一致性但不再当话题。
 *   · 两种情况都带上**人话年龄**（"半小时左右"）—— 半衰的意义就在这儿：模型能看出这是
 *     "刚发生"还是"几小时前"，而不是被一条同等新鲜度的陈述骗着当现状说。
 */
export function factLine({ now = Date.now(), roll = true, contextText = '' } = {}) {
  // 自动补事件仅在事件池开启时；关着时只读账本（正则已写入的事实）
  if (roll) { try { rollEvent({ now }); } catch { /* 抽不到不影响本轮 */ } }
  const l = loadLedger();
  try { pruneFacts(l, now); } catch { /* 清理失败不影响注入 */ }
  const facts = liveFacts(l, now);
  const ctx = String(contextText || '');
  const pick = facts.filter((f) => {
    // 事件池素材走“当前背景”提示线，不能再被旧的 shown 规则截断或重复注入。
    if (f.source === 'pool') return false;
    if (!STATE_GROUPS.has(f.group)) return !f.shown && f.weight >= MATERIAL_MIN_WEIGHT;
    if (f.shown < STATE_MAX_SHOWN && f.weight >= STATE_MIN_WEIGHT) return true;
    const re = STATE_TOPIC[f.group];
    return !!re && re.test(ctx) && f.weight >= STATE_ASK_WEIGHT;
  }).slice(0, 2);
  if (!pick.length) return '';
  for (const f of pick) {
    if (l.facts[f.group]) l.facts[f.group].shown = (Number(l.facts[f.group].shown) || 0) + 1;
  }
  saveLedger(l);
  const body = pick.map((f) => {
    const age = ageLabel(f.ageMin);
    return age ? `${f.text}（${age}）` : f.text;
  }).join('；');
  return `（近况）${body}。这是你自己之前的状况，只在相关时顺口提一句，别主动播报、别说反、别拿它排接下来的日程。`;
}

/**
 * 统一的当前上下文事件提示。
 * 固定时段由时钟决定；随机素材在有效半衰期内每轮作为背景提示，
 * 但文案明确要求模型不要主动播报，避免“全注入”变成“每轮复读”。
 */
export function contextEventLine({ now = Date.now() } = {}) {
  const when = new Date(now);
  const schedule = activeScheduledEvents(cfg().scheduledEvents, when);
  if (!schedule.parsed.ok) {
    reportScheduleError(schedule.parsed);
  } else {
    lastScheduleErrorKey = '';
  }
  let l = loadLedger();
  try { pruneFacts(l, now); } catch (error) { log('life-system 清理事件账本失败：', error?.message ?? error); }

  // 固定时段生效时只暂停“新随机抽取”；已经存在且仍有效的随机背景继续可见。
  if (schedule.parsed.ok && !schedule.active.length) {
    try { rollEvent({ now }); } catch (error) { log('life-system 自动抽取事件失败：', error?.message ?? error); }
    // rollEvent 可能刚写入一条新素材；重新读取，保证本轮提示能看到它。
    l = loadLedger();
  }
  const poolFacts = liveFacts(l, now)
    .filter((f) => f.source === 'pool')
    .slice(0, 2);
  const lines = [];
  for (const e of schedule.active.slice(0, 1)) {
    if (e.type === 'chain' && e.state === 'countdown') {
      lines.push(`（事件链倒计时）“${e.text}”节点已结束，距离下一节点还有约 ${e.countdownRemainingMin} 分钟。不要主动播报倒计时，也不要把下一节点当成已经发生。`);
    } else if (e.type === 'chain') {
      lines.push(`（当前状态）你现在处于事件链第 ${e.nodeIndex + 1}/${e.nodeCount} 个节点：“${e.text}”。这是背景信息，不必主动强调或播报，除非用户问到或话题相关。`);
    } else {
      lines.push(`（当前状态）你现在处于“${e.text}”状态。这是背景信息，不必主动强调或播报，除非用户问到或话题相关。`);
    }
  }
  for (const f of poolFacts.slice(0, Math.max(0, 2 - lines.length))) {
    const age = ageLabel(f.ageMin);
    lines.push(`（当前背景）${f.text}${age ? `（${age}）` : ''}。这是最近发生的背景，不必主动提起，也不要凭空扩展细节。`);
  }
  return lines.join('\n');
}

function scheduleHealth() {
  const parsed = parseScheduledEvents(cfg().scheduledEvents);
  return {
    ok: parsed.ok,
    count: parsed.events.length,
    errors: parsed.errors
  };
}

function reportScheduleError(parsed) {
  const key = parsed.errors.join('|');
  if (key === lastScheduleErrorKey) return;
  lastScheduleErrorKey = key;
  log('life-system 固定时段配置无效，已暂停随机事件：', parsed.errors.join('；'));
}

function scheduleRollAllowed(c = cfg()) {
  const parsed = parseScheduledEvents(c?.scheduledEvents);
  if (parsed.ok) {
    lastScheduleErrorKey = '';
    return true;
  }
  reportScheduleError(parsed);
  return false;
}

// ── 注入 ───────────────────────────────────────────────────────────────
/** system 侧只放静态世界设定（跨运行逐字节不变，缓存友好）。 */
export function promptSections() {
  const out = [];
  const c0 = cfg();
  const book = String(c0.worldbook || '').trim();
  // [[static-world-only]] 只接受静态世界：拦掉"别处同步来的旅行状态"
  if (book && c0.staticWorldOnly === true && FOREIGN_WORLD_RE.test(book)) {
    if (!foreignWorldSkipped) {
      foreignWorldSkipped = true;
      log('life-system：世界设定看着像"别处同步来的旅行状态"，已跳过注入（staticWorldOnly 开着）——'
        + '要她有自己的世界，请在设置里写一段静态的世界设定。');
    }
    return out;
  }
  // ⚠️ priority 60 → 20（2026-10-12 本机调整）。
  //    这一段会**随旅行状态出现 / 消失**（出发时出现、回家时清空），而提示词缓存是
  //    "逐字节前缀比对，断一处后面全废" —— 放在 60 这种靠前位置，每趟出发/回家都会把
  //    它后面的段全部拖出缓存。压到 20（与 life-memory 的 12 同属末尾区）之后，
  //    它的变动只影响自己后面那一小截。**内容不变时仍完全命中缓存。**
  if (book) out.push({ id: 'life-worldbook', title: '世界设定', priority: 20, content: `${WORLD_RULE}\n${book}` });
  return out;
}

/** 取最后一条 user 消息的纯文本（判断"对方是不是在问吃/睡"用）。 */
function lastUserText(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content.slice(-2000);
  if (Array.isArray(last.content)) {
    return last.content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n').slice(-2000);
  }
  return '';
}

function appendToLastUser(messages, line) {  const arr = Array.isArray(messages) ? messages : [];
  const last = [...arr].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const seen = (s) => /（日历）|（近况）|（当前状态）|（当前背景）/.test(String(s || ''));
  if (Array.isArray(last.content)) {
    if (last.content.some((p) => p && typeof p === 'object' && seen(p.text))) return false;
    const texts = last.content.filter((p) => p && p.type === 'text');
    if (!texts.length) return false;
    const t = texts[texts.length - 1];
    t.text = `${t.text}\n${line}`;
    return true;
  }
  if (typeof last.content !== 'string' || seen(last.content)) return false;
  last.content = `${last.content}\n${line}`;
  return true;
}

/**
 * 最后一条 user 消息上是不是已经带上这两行了。
 *
 * ⚠️ 2026-09-23：同一轮里 `before-llm-messages` 会被调多次（多轮工具调用就是多个请求）。
 *   以前每次都照样调 `factLine()`，而它**在挑选时就把 `shown` 加了一次** ——
 *   于是"这一轮已经注入过、这次不注入了"的那次空跑，白扣一次「最多主动递几次」的配额。
 *   后果：`STATE_MAX_SHOWN = 3` 的额度被同一条消息里的重复调用吃光，
 *   之后很长一段时间里这条状态再也递不出去（表现成"近况突然不出现了"）。
 *   修法：已经带上了就直接返回，不去算、也不扣配额。
 */
function alreadyInjected(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const seen = (s) => /（日历）|（近况）|（当前状态）|（当前背景）/.test(String(s || ''));
  if (Array.isArray(last.content)) {
    return last.content.some((p) => p && typeof p === 'object' && seen(p.text));
  }
  return seen(last.content);
}

let lastVoice = '';

export const hooks = {
  // user 尾部追加动态上下文：日历、固定时段状态、随机背景、角色自述近况。
  'before-llm-messages': ({ messages } = {}) => {
    // 同一轮已经注入过 → 直接返回（别白扣配额，见 alreadyInjected 的说明）
    if (alreadyInjected(messages)) return;
    const bits = [];
    try {
      const cal = calendarLine();
      if (cal) bits.push(cal);
      const context = contextEventLine();
      if (context) bits.push(context);
      // contextEventLine 已统一负责固定时段闸门与随机抽取；这里只补充角色自述近况。
      const fact = factLine({ roll: false, contextText: lastUserText(messages) });
      if (fact) bits.push(fact);
    } catch (error) { log('life-system 动态事件注入失败：', error?.message ?? error); return; }
    if (bits.length) appendToLastUser(messages, bits.join('\n'));
  },

  // 心声也是发生过的事：她没发群里的内心独白（「（心声：刚吃完就开工）」）
  // 同样进账本，世界和她"想过的"保持一致，而不只和"说出口的"一致。零额外调用。
  'after-response': async ({ session } = {}) => {
    const v = String(session?.innerVoice || '').trim();
    if (session?.id) pendingToolCaptures.delete(String(session.id));
    if (!v || v === lastVoice) return;
    lastVoice = v;
    try { await captureFromTextSmart(v); }
    catch (error) { log('life-system 心声记账失败：', error?.message ?? error); }
  },

  // 它要发出去的话 = 事实来源。只读参数，不拦工具。
  // 主语含糊的句子会问一次本地 Jev（~100-500ms），判不出来就回退正则。
  'before-tool': async ({ toolName, argsRaw, session } = {}) => {
    if (String(toolName || '') !== 'send_message') return;
    try {
      const a = JSON.parse(String(argsRaw || '{}'));
      const list = Array.isArray(a?.messages) ? a.messages : [a?.messages ?? a?.text];
      const sessionId = String(session?.id || '');
      if (!sessionId) { log('life-system 无法暂存 send_message：缺少 session.id'); return; }
      const pending = pendingToolCaptures.get(sessionId) || [];
      const messages = list.filter(Boolean).map(String);
      pending.push({ argsRaw: String(argsRaw || '{}'), messages, text: messages.join('\n') });
      pendingToolCaptures.set(sessionId, pending);
    } catch (error) { log('life-system 暂存 send_message 失败：', error?.message ?? error); }
  },

  'after-tool': async ({ toolName, argsRaw, result, session } = {}) => {
    if (String(toolName || '') !== 'send_message') return;
    const sessionId = String(session?.id || '');
    const pending = pendingToolCaptures.get(sessionId) || [];
    const index = pending.findIndex((item) => item.argsRaw === String(argsRaw || '{}'));
    if (index < 0) { log('life-system 找不到 send_message 暂存记录，跳过记账'); return; }
    const item = pending.splice(index, 1)[0];
    if (pending.length) pendingToolCaptures.set(sessionId, pending);
    else pendingToolCaptures.delete(sessionId);
    if (result?.isError) return;
    let payload;
    try { payload = typeof result?.content === 'string' ? JSON.parse(result.content) : result?.content; }
    catch (error) { log('life-system 无法解析 send_message 成功结果，跳过记账：', error?.message ?? error); return; }
    const sent = Number(payload?.sent);
    const messageCount = Array.isArray(item.messages) ? item.messages.length : 0;
    if (!Number.isFinite(sent) || sent <= 0 || sent < messageCount) {
      log('life-system send_message 未完整发送，跳过记账：', `sent=${sent}, planned=${messageCount}`);
      return;
    }
    try { await captureFromTextSmart(item.text); }
    catch (error) { log('life-system 发送成功后记账失败：', error?.message ?? error); }
  }
};

// ── 能力（控制台读 + 核心拉取） ────────────────────────────────────────
/**
 * 精力目标修正：只在「日历日子类型 + 账本状态」上做轻量偏移，
 * 不再模拟饱腹/困倦数值，也不改「要不要开口」。
 * 核心 bot-state.hourEnergyTargets 会夹逼到 0~100。
 */
function energyTargets({ hour = new Date().getHours() } = {}) {
  try {
    if (cfg().energyFromWorld === false) return {};
    let physical = 0;
    let cognitive = 0;
    const table = loadCalendar();
    if (table) {
      const mod = dayModifiers(new Date(), table);
      physical += Number(mod.physical) || 0;
      cognitive += Number(mod.cognitive) || 0;
      // 工作日上午不额外压；周末/假期的修正已经够用
      if (hour >= 22 || hour < 6) {
        // 深夜：若账本说没睡好，再多压一点（有据可依时才压）
        const facts = liveFacts(loadLedger());
        if (facts.some((f) => f.group === 'rest' && /没睡好|犯困|熬夜|眼皮/.test(String(f.text || '')))) {
          physical -= 6;
          cognitive -= 8;
        }
      }
    }
    const facts = liveFacts(loadLedger());
    for (const f of facts) {
      const t = String(f.text || '');
      if (f.group === 'rest') {
        if (/没睡好|犯困|熬夜/.test(t)) { physical -= 8; cognitive -= 6; }
        else if (/刚睡过|起床|醒过来/.test(t)) { physical += 4; cognitive += 3; }
      } else if (f.group === 'meal' && /还没吃|肚子空|饿/.test(t)) {
        physical -= 5;
        cognitive -= 3;
      } else if (f.group === 'work' && /在忙|加班|赶/.test(t)) {
        cognitive -= 4;
      }
    }
    return { physical, cognitive };
  } catch {
    return {};
  }
}

export const providers = {
  'life.today': () => today(),
  'life.calendar-file': calendarFileMeta,
  'life.worldbook': () => String(cfg().worldbook || ''),
  'life.schedule-health': scheduleHealth,
  'life.active-scheduled-event': ({ now = Date.now() } = {}) => {
    const r = activeScheduledEvents(cfg().scheduledEvents, new Date(now));
    return { ok: r.parsed.ok, errors: r.parsed.errors, events: r.active };
  },
  'life.context-events': ({ now = Date.now() } = {}) => contextEventLine({ now }),
  'life.facts': () => {
    try { return liveFacts(loadLedger()); } catch { return []; }
  },
  // 控制台「抽一条」：立刻按当前世界与事件池产一条新近况（返回 rolled=false 表示被上限/冷却挡住了）
  'life.roll': ({ now = Date.now() } = {}) => {
    const on = cfg().eventPoolEnabled === true;
    if (!on) return { rolled: false, poolEnabled: false, facts: liveFacts(loadLedger(), now).slice(0, 3) };
    const ok = rollEvent({ now, force: true });
    return { rolled: !!ok, poolEnabled: true, facts: liveFacts(loadLedger(), now).slice(0, 3) };
  },
  // 控制台「清掉这一组」：调试时用，不影响世界设定
  'life.clear': (args = {}) => {
    const l = loadLedger();
    const g = String(args?.group || '');
    if (g && l.facts[g]) delete l.facts[g];
    else if (!g) l.facts = {};
    saveLedger(l);
    return { ok: true, facts: liveFacts(l) };
  },
  // 世界/日历 → 精力目标修正（核心 bot-state 拉取）
  'state.energy-targets': energyTargets
};

export function activate() { return { ok: true }; }
export function deactivate() { /* 无定时器 */ }
export function available() { return { ok: true }; }

export const internals = {
  today, calendarLine, factLine, contextEventLine, scheduleHealth, rollEvent, captureFromText, captureFromTextSmart, isAmbiguousSubject, optionalJevAvailable, setJevAdapter,
  speaksAboutSelfForTest: speaksAboutSelf,
  noteFact, eventPool, loadLedger, saveLedger, liveFacts, pruneFacts, SAY_RULES, GROUP_TTL_MIN,
  STATE_GROUPS, STATE_TOPIC, STATE_MAX_SHOWN, STATE_MIN_WEIGHT, STATE_ASK_WEIGHT, MATERIAL_MIN_WEIGHT,
  halfLifeOf, markUsed,
  energyTargets, parseScheduledEvents, activeScheduledEvents,
  WORLD_RULE, CAL_FILE, EVENTS_FILE
};

