// 矩阵庭院 · 状态层
//
// 每个会话（群 / 私聊）一只鲸鱼，各自一份 JSON。文件名沿用核心 store 的
// 约定（`group:123` → `group_123.json`），避免出现 `:` 这类在 Windows 上
// 非法或易出问题的字符。
//
// ── 设计原则：能用时间算的，就别存计数 ──────────────────────────────────
//   TOKEN**不存"现在有多少"**，只存"上次结算是什么时候"，
//   需要时按时间差算。这样进程重启、关机三天、多实例，状态**自动正确**，
//   一行补偿逻辑都不用写 —— 与项目"无状态会话"的哲学一致。
//
// ── 落盘 ────────────────────────────────────────────────────────────────
//   原子写（先写 .tmp 再 rename），避免写到一半进程退出留下损坏的 JSON。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../src/config.js';
import { SOUVENIR_KINDS } from './souvenir.js';
import {
  defaultBaseRegionId,
  defaultUnlockedIdsOfTheme,
  otherworldIdsOfTheme,
  isOtherworldRegion,
  loadThemedRegions,
  onThemeChange
} from './core/theme-pack.js';

// ── 2026-10-28（P5）：统一状态原语（读缓存 + 原子写）────────────────────────
// 之前这里各写各的：有的 tmp+rename、有的裸 writeFileSync（崩在半行就是半截 JSON）、
// 有的每次 readFileSync + JSON.parse（热路径反复读盘）。
// 现在统一走 courtyard.store；**拿不到就逐字退回原来的 fs 写法**（组件可能被单独安装）。
function infraStore() {
  try { return globalThis.__courtyardInfra?.store || null; } catch { return null; }
}
function readTextCached(file) {
  const st = infraStore();
  if (st && typeof st.readText === 'function') { try { return st.readText(file); } catch { /* 落到 fs */ } }
  return fs.readFileSync(file, 'utf8');
}
function writeTextCached(file, text) {
  const st = infraStore();
  if (st && typeof st.writeText === 'function') { try { return st.writeText(file, text); } catch { /* 落到 fs */ } }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}


// ── 常量 ──────────────────────────────────────────────────────────────────

/**
 * ★ 服务器**产出满载**需要多久（小时）—— 改产出速度就改这一个数。
 *
 * 2026-10-10 用户反馈："菜长得有点慢" ⇒ 8 → **8 小时满载**（先说 4 小时，随即更正为 8）。
 * 原来写法是 `8 * 60 * 1000`（8 分钟 1 亿 TOKEN），配上 1000 的上限，
 * **满载要 133 小时（5.6 天）**，群友想让她出门基本得等好几天。
 * 现在 8 小时满载 ⇒ 约每 28.8 秒 1 亿 TOKEN、125 亿 TOKEN/小时、一天 3000 亿 TOKEN。
 * ⚠️ 以后别再去手写"X 分钟 1 亿 TOKEN"：速率是由「上限 ÷ 满载时间」推出来的，
 *    改一个数就行，省得两处打架。
 */
export const POND_FILL_HOURS = 8;
/** 服务器存量上限（够存一整套装备）。上限高，所以长得快也不怕溢出。 */
export const PLANKTON_CAP = 1000;
/** 产出速率 = 上限 ÷ 满载时间。 */
export const PLANKTON_GROW_MS = (POND_FILL_HOURS * 3600 * 1000) / PLANKTON_CAP;

/**
 * ★★ 2026-10-13 晚「服务器阵列」（用户口径）：庭院里最多能建 **4 台**服务器阵列 ——
 *   **一点都不花 TOKEN**，门槛是**成就值**（10 / 50 / 100 / 200 分，见 `GARDENS` 的 `pointCosts`）。
 *   每建一台，就多一份**基础产出与储量上限**（基础 = `PLANKTON_CAP` 亿 ÷ `POND_FILL_HOURS` 小时）：
 *     0 台 125 亿/h · 上限 1000　→　1 台 250 亿/h · 上限 2000　→　2 台 375 · 3000
 *     →　3 台 500 · 4000　→　**4 台 625 亿/h · 上限 5000**
 *
 * ⚠️ 台数存在 `state.garden.array`（与别的设施同一套存法）⇒ 它天然进「庭院」那组称号的统计。
 * ⚠️ 倍率只在这里定义一次：产出（`growPond`）与储量（`pondReady`）两处都读 `arrayMult()`，
 *    显示要的"现在多少亿/h、上限多少"统一走 `pondStats()` —— **别再手写 125 亿**。
 */
export const ARRAY_MAX = 4;

/**
 * ★★ 2026-10-14（用户口径）**设施 B「标注车间」的等级上限**（= 最多几个工位）。
 *   1 级 1 个工位 / 2 级 2 个 / 3 级 3 个。
 */
export const LABELROOM_MAX = 3;

/**
 * ★★「标注车间」的三个数值口径 —— **只在这里定义一次**。
 *   ⚠️ 产出与评论加成**别在 index.js 里手写第二份**（改一个数要改两处 = 迟早漂移）。
 */
export const LABELROOM = {
  /** 每位上工者每小时产出多少亿 TOKEN（用户口径 15）。 */
  perWorkerPerHour: 15,
  /** ★★ **连续上工上限**：24 小时。到点自动下班 —— 这是用户要的**硬约束**。 */
  maxShiftMs: 24 * 60 * 60 * 1000,
  /** 每位上工者给「明信片评论」概率的加成（用户口径 +15%/人）。 */
  commentBonusPerWorker: 0.15,
  /** 评论概率封顶（用户口径 90%）—— 留一点"没被评论"的余地。 */
  commentChanceCap: 0.9
};

/** 服务器阵列带来的倍率（1 + 台数）。旧存档没有 `garden.array` ⇒ 1（等于没建）。 */
function arrayMult(state) {
  const lv = Math.max(0, Math.min(ARRAY_MAX, Math.floor(Number(state?.garden?.array) || 0)));
  return 1 + lv;
}

/** 当前的产出与储量（工具 / 面板显示用）。 */
export function pondStats(state) {
  const mult = arrayMult(state);
  return {
    array: mult - 1,
    mult,
    cap: PLANKTON_CAP * mult,
    perHour: (PLANKTON_CAP / POND_FILL_HOURS) * mult,
    fillHours: POND_FILL_HOURS
  };
}

// ── 设施 B「数据标注车间」（2026-10-14 用户口径）────────────────────────────
//   为什么全是**纯函数**且放在 state.js：产出、上工、下班、24 小时闸、出门解封，
//   全都是**存档状态的确定性变换** —— 写成纯函数才测得到（这个功能最容易错的两处就是
//   "24 小时到点"和"必须先出门才能再上工"，恰恰都只靠状态+时间来判定）。

/** 工位数 = 车间等级（0 = 还没建）。只读。 */
export function labelroomSlots(state) {
  return Math.max(0, Math.min(LABELROOM_MAX, Math.floor(Number(state?.garden?.labelroom) || 0)));
}

/** 只读：上工名册（缺字段 ⇒ 空数组）。★ 查询**不初始化**存档。 */
export function labelroomWorkers(state) {
  return Array.isArray(state?.labelroom?.workers) ? state.labelroom.workers : [];
}

/** 只读：下过班、**必须先出趟门**才能再上工的名单。 */
export function labelroomMustTravel(state) {
  const m = state?.labelroom?.mustTravel;
  return (m && typeof m === 'object') ? m : {};
}

/** 只读：还没收的打工产出（亿 TOKEN，浮点）。 */
export function labelroomPending(state) {
  return Math.max(0, Number(state?.labelroom?.pending) || 0);
}

/** 写路径用：把 `state.labelroom` 补成完整结构（老存档 / 手改过的存档都吃）。 */
export function labelroomOf(state) {
  if (!state.labelroom || typeof state.labelroom !== 'object') state.labelroom = {};
  const lr = state.labelroom;
  if (!Array.isArray(lr.workers)) lr.workers = [];
  if (!lr.mustTravel || typeof lr.mustTravel !== 'object') lr.mustTravel = {};
  if (!Number.isFinite(Number(lr.pending))) lr.pending = 0;
  if (!Number.isFinite(Number(lr.lastPayAt))) lr.lastPayAt = Date.now();
  return lr;
}

/**
 * 此刻**不在庭院**的旅伴 id（跟着鲸鱼出门的 ＋ 自己跑出去玩的）。纯函数。
 * ★ 两处都要数：鲸鱼那趟看 `companions`（设施 A 的多位也在这），伙伴那趟看 `sideTrips[].partners`。
 */
export function awayMateIds(state) {
  const out = new Set();
  const add = (x) => {
    // ⚠️ `companionsOf` 返回的是 **COMPANIONS 定义对象**（`{id, name, cardMult…}`），
    //    不是 id 字符串 —— 直接 `add(对象)` 会得到 `[object Object]`（探针抓到过）。
    const s = String((x && typeof x === 'object') ? (x.id ?? '') : (x ?? '')).trim();
    if (s) out.add(s);
  };
  if (state?.trip) for (const c of companionsOf(state)) add(c);
  for (const t of (Array.isArray(state?.sideTrips) ? state.sideTrips : [])) {
    for (const id of (Array.isArray(t?.partners) ? t.partners : [])) add(id);
  }
  return out;
}

/**
 * 此刻**能去车间上工**的人：已邀请 − 不在家 − 已在册 − **刚下过班还没出门的**。
 * ★ 最后一条不能少：这个函数就是工具里"可以安排：A、B"那句话的数据源，
 *   漏了它会出现"回执说可以安排、真去安排却被拒"（探针抓到）。
 */
export function labelroomEligible(state) {
  const away = awayMateIds(state);
  const working = new Set(labelroomWorkers(state).map((w) => String(w.id)));
  const must = labelroomMustTravel(state);
  return ownedCompanionIds(state)
    .filter((id) => !away.has(id) && !working.has(id) && !must[id]);
}

/**
 * ★★ **产出累加**（幂等：按 `lastPayAt → now` 的**时长**算，重复调用不会多给）。
 *   ★ 顺序纪律：`startWork`／`endWork` 都**先结算、再改人数** —— 否则"刚上工就白拿上一段"、
 *     或"刚下班还被算一份"。
 */
export function accrueLabelroom(state, now = Date.now()) {
  const lr = labelroomOf(state);
  const last = Number(lr.lastPayAt) || now;
  const elapsed = Math.max(0, now - last);
  lr.lastPayAt = now;
  const n = lr.workers.length;
  if (!elapsed || !n) return 0;
  const gained = (elapsed / 3600000) * LABELROOM.perWorkerPerHour * n;
  lr.pending = (Number(lr.pending) || 0) + gained;
  return gained;
}

/** 上工人数给「明信片评论」概率的加成（**未封顶**；封顶由调用方按 `LABELROOM.commentChanceCap` 做）。 */
export function labelroomCommentBonus(state) {
  return labelroomWorkers(state).length * LABELROOM.commentBonusPerWorker;
}

/** ★★ 连续上工**已满 24 小时**、该自动下班的那些。返回 `[{id, since, workedMs}]`。 */
export function labelroomDueWorkers(state, now = Date.now()) {
  return labelroomWorkers(state)
    .map((w) => {
      const since = Number(w.since) || now;
      return { id: String(w.id), since, workedMs: Math.max(0, now - since) };
    })
    .filter((w) => w.workedMs >= LABELROOM.maxShiftMs);
}

/**
 * 让某位旅伴**下班**（用户主动叫，或 24 小时到点自动）。
 * ★★ 下工即**封印**：她必须先**出一次门**（带她旅行 / 放她自己出去玩）才能再上工 —— 用户要的硬约束。
 */
export function endWork(state, id, now = Date.now()) {
  const lr = labelroomOf(state);
  const mid = String(id || '').trim();
  const i = lr.workers.findIndex((w) => String(w.id) === mid);
  if (i < 0) return { ok: false, reason: 'not-working' };
  accrueLabelroom(state, now);                      // ★ 先按**旧人数**结算到此刻
  const [w] = lr.workers.splice(i, 1);
  lr.mustTravel[mid] = true;
  return { ok: true, worker: w };
}

/** 让某位旅伴**上工**。`{ok, reason}`；成功时 `worker` 是刚建的名册项。 */
export function startWork(state, id, now = Date.now()) {
  const lr = labelroomOf(state);
  const mid = String(id || '').trim();
  if (!mid || !COMPANIONS[mid]) return { ok: false, reason: 'no-such-mate' };
  if (labelroomSlots(state) <= 0) return { ok: false, reason: 'no-room' };
  if (!ownedCompanionIds(state).includes(mid)) return { ok: false, reason: 'not-owned' };
  if (awayMateIds(state).has(mid)) return { ok: false, reason: 'away' };
  if (lr.mustTravel[mid]) return { ok: false, reason: 'must-travel' };   // ★ 得先出趟门
  if (lr.workers.some((w) => String(w.id) === mid)) return { ok: false, reason: 'already' };
  if (lr.workers.length >= labelroomSlots(state)) return { ok: false, reason: 'full' };
  accrueLabelroom(state, now);                      // ★ 先按**旧人数**结算到此刻
  lr.workers.push({ id: mid, since: now });
  return { ok: true, worker: lr.workers[lr.workers.length - 1] };
}

/**
 * ★★ 她们**出过门了** ⇒ 解封（又能上工了），并顺手把还在册的撤下来（人都不在庭院了）。
 *   调用点只有两处：`depart`（带她一起走）与 `departSideTrip`（她自己出去玩）。
 *   ★ 这里**刻意不置** `mustTravel` —— 因为她**正是**"出门了"的人。
 * @returns {boolean} 有没有变化（调用方据此决定 dirty）
 */
export function releaseForTravel(state, ids, now = Date.now()) {
  const lr = labelroomOf(state);
  let changed = false;
  for (const x of (Array.isArray(ids) ? ids : [ids])) {
    const id = String(x || '').trim();
    if (!id) continue;
    if (lr.mustTravel[id]) { delete lr.mustTravel[id]; changed = true; }
    const i = lr.workers.findIndex((w) => String(w.id) === id);
    if (i >= 0) {
      accrueLabelroom(state, now);                    // ★ 先按旧人数结算
      lr.workers.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

/** 收款：把车间攒下的产出取出来（`harvest` 用）。返回**亿 TOKEN**（小数留在账上，下次再收）。 */
export function collectLabelroom(state) {
  const lr = labelroomOf(state);
  const got = Math.floor(Number(lr.pending) || 0);
  if (got > 0) lr.pending = (Number(lr.pending) || 0) - got;
  return got;
}

/** 车间里有没有人上班（评论加成 / 面板显示用）。只读。 */
export function labelroomBusy(state) {
  return labelroomWorkers(state).length > 0;
}
/** 收取冷却。 */
export const HARVEST_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * 货架补货间隔。默认 168 小时（7 天）。
 * 货架是**只减不补会断供**的 —— 小份大白饭被买空后，新群友就买不到口粮、
 * 也就没法让鲸鱼出门。所以要有周期性补满兜底。
 */
export const RESTOCK_INTERVAL_MS = 168 * 3600 * 1000;
/** 稀有掉落率（发光 TOKEN）。 */
export const GLOW_CHANCE = 0.02;

/** 口粮（大白饭）三档 → 旅行时长区间（毫秒）。 */
export const FOOD_TIERS = {
  small: { name: '小份大白饭', minH: 4, maxH: 8, cards: [1, 2] },
  normal: { name: '中份大白饭', minH: 8, maxH: 16, cards: [2, 3] },
  large: { name: '大份大白饭', minH: 16, maxH: 24, cards: [2, 4] }
};

/**
 * ★ 穿越概率（2026-10-11 用户需求）—— 每次出发时有这么大概率**被丢到一个
 * **还没解锁**的异世界里去一趟（目的地不由装备决定，而是随机挑一个没买过的虚构地区）。
 *
 * 语义要点（用户明确要求）：
 *   · 候选池 = `fictional: true` **且当前未解锁**的地区 ⇒ **把异世界全部解锁后，
 *     候选为空、永远不再触发穿越**（这是"买齐全就不会倒霉"的实现方式，不是另加开关）。
 *   · 穿越只是"这趟去了别处"，**回家机制完全不变**（returnAt 照常），
 *     而且**不会顺手把那个异世界解锁**（否则穿一次就白嫖了）。
 *   · 概率可以在技能设置里改（`crossOverChance`，填 0 = 关闭）。
 */
export const CROSS_OVER_CHANCE = 0.15;

/**
 * 商店定价 —— **单一来源**。
 * 商店、说明图（help.js）、提示词都读这里，避免改了价却漏改某处文案。
 */
export const PRICES = {
  food: { small: 20, normal: 50, large: 100 },
  charm: { shell: 300, scale: 600, pearl: 1200 },
  equip: 2000
};

/** 护身符：提升稀有明信片 / 稀有特产的概率。 */
export const CHARM_TYPES = {
  shell: { name: '幸运海螺', luck: 0.12 },
  scale: { name: '鲸鳞护符', luck: 0.25 },
  pearl: { name: '深海珍珠', luck: 0.40 }
};

/**
 * ★ 旅行伙伴（2026-10-11 用户需求）—— 商店里单开一栏的「一次性买断、永久同行」商品。
 *
 * 与口粮/护身符的区别（决定了它**不能**塞进 shopTable）：
 *   · 口粮/护身符是**可堆叠消耗品**（`bag[kind][id]` 计数 + 货架库存），
 *   · 伙伴是**唯一性状态**（`state.companion = { id, at }`），买了就是买了，
 *     没有库存、没有数量、也不能重复买 ⇒ 走独立分支，不进 shopTable 的 stock/bag 体系。
 *
 * 代价与收益是**成对**的（用户明确要求）：
 *   · 出门吃**双份**大白饭（`foodCostMult`）—— 两个人一起出门；
 *   · 明信片总量 **+50%**（`cardMult`）；
 *   · 稀有明信片概率 **×2**（`rareMult`）。
 * ⚠️ `rareMult` 只作用于**明信片**稀有度（`trip.js:rollCardRarity`）。
 *    特产稀有度不放大 —— 那条由 LLM 打标签起步、再受护身符影响，口径不同。
 */
/**
 * ★★ 2026-10-13（用户需求）：**庭院设施** —— 让"家"从落脚点变成可以慢慢建的地方。
 *
 * 为什么这样设计（见 `_qcheck` 里那份消耗口分析）：
 *   钱过剩的根因是**持续性支出有天花板**（货架库存 7 天才补一次）。
 *   所以设施必须**没有库存上限**、且**升级价格递增**（越升越贵，是一条长曲线）。
 *
 * 六件都挂**单一钩子**，互不重叠；⚠️ 一律**不动产量**（用户口径：产量是对的）。
 * `prices[i]` = 从 i 级升到 i+1 级的价格；`maxLevel` = 满级。
 */
export const GARDENS = [
  {
    id: 'stargazer', name: '观星台', emoji: '🔭', maxLevel: 5,
    prices: [1000, 2000, 4000, 8000, 16000],
    effect: '明信片稀有率 +2%/级',
    desc: '把水镜边那块地收拾出来架台望远镜 —— 看得越清，越容易撞上稀有的那张'
  },
  {
    id: 'eaves', name: '檐廊', emoji: '🏮', maxLevel: 3,
    prices: [1500, 3000, 6000],
    effect: '庭院活动池 +4 条/级',
    desc: '把檐下那块地方布置起来 —— 她在院子里能做的事会更多'
  },
  {
    id: 'stove', name: '电饭煲', emoji: '🍚', maxLevel: 1,
    prices: [8000],
    effect: '出门口粮需求 -1（最低 1 份）',
    desc: '置一台电饭煲 —— 自己焖饭，出门带的口粮就能少一份（对吃三份的那位是大福利）'
  },
  {
    id: 'library', name: '藏书阁', emoji: '📚', maxLevel: 1,
    prices: [5000],
    effect: '她写的题字与感想更长',
    desc: '给她一间放书的屋子 —— 话多的人有了地方，明信片背面会写满'
  },
  {
    id: 'photowall', name: '照片墙', emoji: '🖼️', maxLevel: 1,
    prices: [3000],
    effect: '大合照门槛 8 小时 → 6 小时',
    desc: '钉一整面墙挂照片 —— 她更早就想拉人合影了'
  },
  {
    // ★★ 2026-10-13 晚（用户口径）：**唯一一件不花 TOKEN 的设施** —— 门槛是**成就值**。
    //   为什么不复用一个"价格"字段：两者**币种根本不同**（TOKEN 是她挣的钱，
    //   成就值是主人/她的收集进度），混在一起迟早算错。
    //   ⚠️ `prices: []` 是刻意的（没有 TOKEN 价）—— help.js 的设施表据此改显示"成就值 N 起"。
    id: 'array', name: '服务器阵列', emoji: '🗄️', maxLevel: ARRAY_MAX,
    prices: [],
    // ★★ 2026-10-14（用户口径）：第四台 = **真正的「全成就奖励」** —— 门槛不是写死的 200，
    //   而是**当前的称号总分**（`'all'` 哨兵值，由 index.js 的 `pointCostOf()` 解析）
    //   ⇒ 以后每加一条称号，这道门槛自己往上抬。
    pointCosts: [10, 50, 100, 'all'],
    effect: '每台 +1 份基础产出与储量上限',
    desc: '再摆一排机柜 —— 它不吃 TOKEN，只认你攒下来的成就；每多一台，产出与容量就再翻一份'
  },
  {
    // ★★ 2026-10-14（用户口径）**设施 A「扩容鲸鱼」**：把出门能带的人数放宽。
    //   两级制：**1 级 +1 位、2 级 +2 位**（`1` 是本来就有的那 1 位基础同行者）
    //   ⇒ 满级时 **鲸鱼少女 ＋ 3 位旅伴 ＝ 一共 4 个人一起出门**。
    //   ⚠️ 只动"能带几位"，**不动** `COMPANIONS` 里那四个数值字段 ——
    //      多人的加成怎么算由 `trip.js` 按【加算、封顶 3 倍；稀有取平均】聚合。
    id: 'whalehold', name: '上下文窗口', emoji: '🪟', maxLevel: 2,
    prices: [12000, 24000],
    effect: '同行者 +1 位/级（满级 4 人同行）',
    desc: '把她的「上下文窗口」开大 —— 一次装得下的同行者就多一位。'
      + '（每张途中的明信片仍然只画两个人：她和轮换到的那一位；**到家那张是全体合照**）'
  },
  {
    // ★★ 2026-10-14（用户口径）**设施 B「标注车间」**：让**留守的旅伴**进车间打工。
    //   三条口径（数值只在 `LABELROOM` 定义一次，别在别处手写第二份）：
    //     ① 每位上工者 **+15 亿 TOKEN/小时**（进 `labelroom.pending`，与 server 一起走"收 TOKEN"）；
    //     ② 上工者把「明信片评论」概率 **+15%/人、封顶 90%**（她的原话：闲在家里没事干就刷动态）；
    //     ③ ★★ **硬约束：连续上工最长 24 小时** —— 到点自动下班，并用她自己的口吻播报
    //        "可恶的家伙居然想压榨我"；**想再让同一位上工，必须先让她出一次门**
    //        （带她旅行 or 她自己出去玩）—— 见 `startWork`／`endWork`／`releaseForTravel`。
    id: 'labelroom', name: '数据标注车间', emoji: '🏭', maxLevel: LABELROOM_MAX,
    prices: [4000, 10000, 20000],
    effect: '工位 +1/级（最多 3 位同时上工）',
    desc: '支起一排工位 —— 留在家的旅伴可以来"打工"：每人每小时给一笔 TOKEN，'
      + '人在工位上的时候还更爱刷动态（明信片更容易被她们评论）。'
      + '⚠️ 上了工就**不会偷跑出去玩**（她在上班）。也别太贪：一位**最多连着干 24 小时**，'
      + '到点她会自己撂挑子下班 —— 想再让她上工，得先带她出趟门（或者放她自己出去玩）。'
  }
];

// [[persona-pack]] 旅伴名册（2026-10-24，§6.1 一阶段）：`persona\companions.json` 可整体替换
// 默认名册——文件缺失/损坏/校验不过时回退内置（行为与 v2.0.0 逐字节一致）。
// 校验口径：每项必须有 id/name/emoji（字符串）与 price（数字，商店/花销的根，宁缺勿滥）；
// 倍率缺省 1；无效项跳过。文件就是默认名册的原样导出——改字段/增删旅伴都在 JSON 里完成。
const BUILTIN_COMPANIONS = {
  fox: {
    id: 'fox',
    name: '黑发兽耳小狐狸',
    // 🦊 商店 / 状态 / 相册里的图标（按伙伴区分，别再写死）
    emoji: '🦊',
    // 宽松匹配用的别名（群友说话很随意："买只狐狸""换成小狐狸"）
    aliases: ['小狐狸', '狐狸', '黑发兽耳小狐狸', '兽耳狐狸', 'GLM', '智谱'],
    // ★ 2026-10-11 用户要求：**本机**（自家群这边）把小狐狸提价（现为 +1000）。
    //   ⚠️ 这是**本机口径**、不是通用定价 —— 给朋友的分发包按 3000 打包。
    //   想改回来只需把 4000 改成 3000。
    price: 4000,
    foodCostMult: 2,      // 出门吃双份大白饭
    cardMult: 1.5,        // 每趟明信片张数 +50%
    rareMult: 2,          // 稀有明信片概率翻倍
    // ★★ 2026-10-13 旅伴「特色」（用户口径）：智谱的「免费鸡蛋」—— 每天固定发一笔 TOKEN，
    //   **不看她在不在家**（用户原话："在不在家都发"）。额度由用户定为 500 亿 TOKEN/天。
    //   触发在 index.js 的 `dueStipend()`（挂在 tick 上，一天一次，键是本地日期）。
    trait: '免费鸡蛋',
    dailyTokens: 500,
    desc: '陪她一起上路：出门吃双份大白饭，但明信片 +50%、稀有明信片概率 ×2；'
      + '★ 特色「免费鸡蛋」—— 每天往钱包里发 500 亿 TOKEN（在不在家都发）'
  },
  // ★ 2026-10-11 用户需求：把「GPT / OpenAI」做成第二个伙伴（人设 §十四 那位白发龙娘）。
  //   机制与 fox **完全一致**（成本/收益成对），只是换了个人同行、明信片换成她。
  //   ⚠️ `id` 保持 `gpt` 不动、**只改显示名**（用户 10-11 改名「小白龙」）——
  //      旧存档里存的是 `companion.id`，动 id 会让已经买到手的伙伴变回"没买过"。
  gpt: {
    id: 'gpt',
    name: '小白龙',
    emoji: '🐉',
    aliases: ['小白龙', 'GPT', 'GPT娘', 'OpenAI', '龙娘', '白发龙娘', 'GPT龙娘', '大龙娘', '大白龙'],
    // ★ 2026-10-13 价格差异化（用户口径）：她是全队最强、也是最贵的那位（"OpenAI 就是贵"）。
    price: 5000,
    // ★★ 2026-10-13 旅伴「特色」（用户口径）：**吃白饭的大肥龙** —— 出发吃三份（不扣钱），
    //   换明信片 +100%、稀有 ×3（全队最高）。
    //   ⚠️ 注意 `bestFoodTier()` 是**从 large 起挑**的 ⇒ 有大份时每趟吃 3 大份 = 300 亿 TOKEN，
    //      而大份货架库存 20 份/7 天 ⇒ 只够走 **6 趟**（原口径吃 2 份 = 10 趟）。
    //      真正被消耗的是**稀缺库存**，不是数字 —— 这就是她的代价。
    foodCostMult: 3,
    cardMult: 2,
    rareMult: 3,
    trait: '大肥龙',
    desc: '陪她一起上路：★ 特色「大肥龙」—— 出发要吃**三份**大白饭（大份优先），'
      + '换明信片 +100%、稀有明信片概率 ×3（全队最高）。也是全队最贵的那位。'
  },
  // ★ 2026-10-11 用户需求（第三、四位伙伴，与 GPT 同批交代）。机制与上面完全一致。
  claude: {
    id: 'claude',
    name: '小书虫',
    emoji: '📖',
    aliases: ['小书虫', 'Claude', '克劳德', '书虫', '抱书的那位'],
    price: 3000,
    foodCostMult: 2,
    cardMult: 1.5,
    rareMult: 2,
    // ★★ 2026-10-13 旅伴「特色」（用户口径）：Claude 就是**贵** —— 每次出发先扣 500 亿 TOKEN。
    //   ⚠️ **允许扣成负数**（用户原话："token 余额为负数很正常"）⇒ **不能**走 `spendPlankton`
    //      （它余额不足会直接拒绝、且不改状态）。落点在 index.js 的 `depart()`。
    //   ⚠️ **自动出门也会扣**（用户明确要求）—— 自动出门走的正是 `depart()`。
    //   另一半收益是「话多」：题字更长（postcard.js 的 `longCaption` 分支）+ 每趟多 1 张。
    trait: '很贵',
    departCost: 500,
    longCaption: true,
    cardExtra: 1,
    desc: '陪她一起上路：出门吃双份大白饭，明信片 +50%、稀有 ×2；'
      + '★ 特色「很贵」—— 每次出发先扣 500 亿 TOKEN（**可以扣成负数**），但题字更长、每趟多寄 1 张'
  },
  gemini: {
    id: 'gemini',
    name: '小猫咪',
    emoji: '🐱',
    aliases: ['小猫咪', 'Gemini', '双子星', '猫娘', '猫咪', '猫猫'],
    // ★ 2026-10-13 价格差异化：收益打了折（稀有率砍半）⇒ 她是最便宜的一位。
    price: 2500,
    foodCostMult: 2,
    // ★★ 2026-10-13 旅伴「特色」（用户口径）：**量大管饱但水** —— 张数 +100%（Google 靠量取胜），
    //   代价是稀有率 ×0.5，且约 10% 的明信片会"翻车"（文案答非所问 / 客服腔）。
    //   用户定：**默认开**。落点：index.js 的 postOnce 掷骰 + postcard.js 的翻车文案池。
    cardMult: 2,
    rareMult: 0.5,
    trait: '量大管饱',
    flopChance: 0.1,
    desc: '陪她一起上路：出门吃双份大白饭；'
      + '★ 特色「量大管饱」—— 明信片张数 +100%，但稀有明信片概率 ×0.5、'
      + '且有约 10% 的明信片会"翻车"（文案答非所问）'
  },
  // ★ 2026-10-13 用户需求：把「Grok / xAI」做成第五个伙伴（人设 §十二 那位金发双马尾、
  //   扛 X 形双刃巨斧的少女）。机制与上面三位**完全一致**（成本/收益成对）。
  //   显示名由用户从备选里敲定 = 「小魔王」（备选还有 小恶魔 / 小霸王 / 小战斧）。
  //   ⚠️ 与 fox/gpt 同款约束：**id 一旦发布就别改**（旧存档里存的是 `companion.id`）。
  grok: {
    id: 'grok',
    name: '小魔王',
    emoji: '😈',
    aliases: ['小魔王', 'Grok', 'grok', 'Grok娘', 'xAI', 'Xai', '魔王', '巨斧娘'],
    // ★ 2026-10-13 价格差异化：纯增益、但只在异世界生效 ⇒ 略贵一点。
    price: 3500,
    foodCostMult: 2,
    cardMult: 1.5,
    rareMult: 2,
    // ★★ 2026-10-13 旅伴「特色」（用户口径）：嘴毒 + **在异世界必定"惹事"** ——
    //   额外触发并寄出 1 张**战斗明信片**（强制走战斗构图，见 index.js 的 `appendExtraCard`）。
    //   ⚠️ "异世界"的判据用 `plan.foe` 非空（`foe` 只有异世界的国家组才带，85 组）。
    //   ⚠️ **她自己的那趟也算数**（用户口径："grok自己那趟也触发"）。
    trait: '惹事',
    battleOnFiction: true,
    desc: '陪她一起上路：出门吃双份大白饭，明信片 +50%、稀有 ×2；'
      + '★ 特色「惹事」—— 感想带吐槽，且在异世界**必定**多寄 1 张战斗明信片'
  },
  // ★★ v3.0（2026-10-14）：第六、七位旅伴 —— 与上面几位**同一套机制**（成本/收益成对）。
  //   ⚠️ 与 fox/gpt 同款约束：**id 一旦发布别改**（旧存档存的是 `companion.id`）；显示名可以随便改。
  // ★★ 2026-10-14（v3.2，用户拍板）：两位新旅伴**都改绑特产** —— 原来她俩的特色
  //   （「随记」多 1 张 / 「说书」张数 +100%）都是"明信片向"的，跟特产没关系；
  //   而特产这一版刚做完吃/送/种三条出口、正缺"人"的呼应。用户原话："把 kimi 和千问都做成特产相关效果"。
  //   ★ 铁律复述（§95 栽过两次）：**给旅伴分配特色前先 grep 现有口子** ——
  //     `cardExtra` 是小书虫的（"多 1 张"撞车）、"多带 1 件特产"是费伦「空间袋」的 ⇒
  //     所以 Kimi 走**新的两个字段**（`noteSouvenirs` / `harvestBonus`），一个都不与别人重叠。
  kimi: {
    id: 'kimi',
    name: '小月亮',
    emoji: '🌙',
    aliases: ['小月亮', 'Kimi', 'kimi', '月之暗面', '月亮', '小月牙', '长笛娘'],
    // ⚠️ 用户口径（2026-10-14 13:07）："最贵最强是**国模**范畴，**不要比 gpt 还贵**" ——
    //   所以是**国模里最贵**（4500 > 千问 3500），但**低小白龙一档**（< gpt 5000）。
    //   全队价格梯度：小猫咪 2500 < 小书虫 3000 < 小魔王/小折扇 3500 < 狐狸 4000
    //                < 小月亮 4500 < 小白龙 5000。
    price: 4500,
    foodCostMult: 2,
    cardMult: 1.5,
    rareMult: 2,
    // ★ 特色「博闻」：她一路都在记 —— ① 带回来的**新**特产会带一行**她的批注**（进图鉴、看得见）；
    //   ② 她同行时**收成多 1 份**（她记得哪一株长得最好，掐的时间准）。
    //   ⚠️ 批注写的是特产条目的 `desc` 字段（3.1 就留好的钩子、图鉴页已经会印）。
    trait: '博闻',
    noteSouvenirs: true,      // ⇒ 抽特产时顺带要一行 note（`trip.js` 的提示词里加，**零额外调用**）
    harvestBonus: 1,          // ⇒ 收成份数 +1（`FARM.yieldOf` 之上，只在她在庭院时算）
    desc: '陪她一起上路：出门吃双份大白饭，明信片 +50%、稀有 ×2；'
      + '★ 特色「博闻」—— 她一路都在记：带回来的新特产会带一行她的批注，收成也多 1 份'
  },
  qwen: {
    id: 'qwen',
    name: '小折扇',
    emoji: '🪭',
    aliases: ['小折扇', '千问', '通义', '通义千问', 'Qwen', 'qwen', '折扇', '扇子'],
    price: 3500,          // 用户拍板：4500 → 3500（她的收益不再"比小猫咪高一档"）
    foodCostMult: 2,
    // ★ 「说书」已按用户口径**去掉**：张数 +100% → **1.5（普通水准）**。
    cardMult: 1.5,
    rareMult: 2,
    // ★ 特色「垦殖」：她是个"会种地的" —— 请过她 ⇒ **永久解锁菜地**（`appointCompanion`）
    //   ＋**永久多 1 块地**（4 块，`FARM.helperSlots`）；她在庭院时**种下**的那株周期 ×0.7
    //   （`FARM.helperSpeed`，冻在株上）。
    //   ⚠️ 地那半**必须是永久的** —— 曾经写成"她在庭院时才 +1"，于是她一出门上限就掉回 3、
    //     出现了"4/3 块"这种自相矛盾的显示（用户："那块地就凭空消失吗，上面的特产呢？"）。
    trait: '垦殖',
    farmHelper: true,         // ★ 新增字段：判据不再写死 `=== 'qwen'`（加新旅伴时不用改判据）
    desc: '陪她一起上路：出门吃双份大白饭，明信片 +50%、稀有 ×2；'
      + '★ 特色「垦殖」—— 请过她就永久有菜地，她在庭院时多 1 块地、长得快 30%'
  }
};

// [[persona-pack]] 名册装载：persona\companions.json 存在且有效 → 用它；否则回退内置。
function loadPersonaCompanions() {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'persona', 'companions.json');
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const comps = doc && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc.companions && typeof doc.companions === 'object' ? doc.companions : doc)
      : null;
    if (!comps || typeof comps !== 'object') throw new Error('名册必须是 {companions:{...}} 或直接的对象');
    const out = {};
    for (const [key, def] of Object.entries(comps)) {
      if (!def || typeof def !== 'object') continue;
      const id = String(def.id || key).trim();
      const name = String(def.name || '').trim();
      const price = Number(def.price);
      if (!id || !name || !Number.isFinite(price) || price < 0) continue;   // 价格是花销的根，宁缺勿滥
      out[id] = {
        ...def, id, name, emoji: String(def.emoji || '🔹'), price,
        foodCostMult: Number.isFinite(Number(def.foodCostMult)) ? Number(def.foodCostMult) : 1,
        cardMult: Number.isFinite(Number(def.cardMult)) ? Number(def.cardMult) : 1,
        rareMult: Number.isFinite(Number(def.rareMult)) ? Number(def.rareMult) : 1,
        aliases: Array.isArray(def.aliases) ? def.aliases.map(String) : [],
      };
    }
    if (!Object.keys(out).length) throw new Error('名册没有任何有效旅伴');
    return out;
  } catch { return null; }   // 文件缺失/损坏 → 内置名册（与 v2.0.0 行为一致）
}
const personaCompanions = loadPersonaCompanions();
export const COMPANIONS = personaCompanions || BUILTIN_COMPANIONS;

/** 取当前会话的伙伴定义（没买过 → null）。 */
export function companionOf(state) {
  const id = String(state?.companion?.id ?? '').trim();
  return id ? (COMPANIONS[id] || null) : null;
}

/** 同行的明信片张数倍率**上限**（用户 10-14 口径："封顶 3 倍"）。 */
export const PARTY_CARD_MULT_CAP = 3;

/** 基础同行位：**从来就有 1 位** —— 没请伙伴时她自己一个人出门。 */
const BASE_PARTY_SIZE = 1;

/** 「扩容鲸鱼」能给到的同行者上限 ＝ 基础 1 位 ＋ 设施等级（1 级 +1、2 级 +2 ⇒ 满级 4 人同行）。 */
export function partyCapOf(state) {
  const lv = Math.max(0, Math.min(2, Number(state?.garden?.whalehold) || 0));
  return BASE_PARTY_SIZE + lv;
}

/**
 * ★★ 2026-10-14「扩容鲸鱼」（设施 A）：**这一趟同行的全部旅伴定义**（数组，可能为空或只有一项）。
 *
 * 读取顺序：`state.companions` 优先 → 为空则回落 `[state.companion]`（老存档／单人）。
 * ⚠️ 一律用这个函数拿"带了谁"；**别直接读 `state.companion`** —— 那个字段是
 *    「领头／出镜」那一位，带多人时**不完整**（但单人的 20+ 处老调用点仍然靠它，不用改）。
 * ⚠️ 老存档 / 未建设施时 `companions` 为空 ⇒ 自动回落成 1 项 ⇒ 与从前**逐字节一致**。
 */
export function companionsOf(state) {
  const list = Array.isArray(state?.companions) ? state.companions : [];
  const out = list.map((c) => COMPANIONS[String(c?.id ?? '').trim()]).filter(Boolean);
  if (out.length) return out;
  const one = companionOf(state);
  return one ? [one] : [];
}

/**
 * 同行的**明信片张数倍率**：`1 + Σ(cardMult − 1)`，**封顶 `PARTY_CARD_MULT_CAP`**（用户 10-14 口径）。
 *
 * 为什么是加算而不是连乘：带多人时连乘会**指数级爆炸** —— 7 位全带 ≈ 30 倍，
 * 正是用户说的"叠出 10000% 明信片"。加算 ＋ 封顶把上限钉死在 3 倍。
 * ⚠️ 单人时 `1 + (cardMult−1)` 恒等于 `cardMult` ⇒ 与从前**逐字节一致**（不是"近似"）。
 */
export function partyCardMultOf(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return 1;
  const extra = arr.reduce((s, c) => s + (Math.max(1, Number(c?.cardMult) || 1) - 1), 0);
  return Math.min(PARTY_CARD_MULT_CAP, 1 + extra);
}

/**
 * 同行的**稀有倍率**：**取平均**（用户 10-14 口径）。
 *
 * 为什么取平均而不是取最高：小猫咪的 `rareMult` 是 **0.5** —— 全队唯一的**惩罚项**；
 * 取最高会把她的代价整个抹掉。取平均则"带她整体拉低、带小白龙整体拉高"，
 * **每个伙伴的数值都真的算数**（也与 §69「不新增乘数、只做加法」的红线同向）。
 * ⚠️ 单人时平均就是她自己 ⇒ 与从前一致。
 */
export function partyRareMultOf(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return 1;
  const sum = arr.reduce((s, c) => s + Math.max(0.01, Number(c?.rareMult) || 1), 0);
  return sum / arr.length;
}

/**
 * ★ 已拥有的伙伴 id 列表（2026-10-11 用户需求：伙伴要**可切换**）。
 *
 * 背景：原来 `state.companion` 只存"当前跟着的那一个"，买第二只直接被
 * `if (owned) return '只能有一个'` 挡住。要支持切换，就得记住"买过哪些"：
 *   · 买过的伙伴 ⇒ 随时免费切换（跟装备一样，买断后随意换）；
 *   · 没买过的伙伴 ⇒ 仍要花钱。
 *
 * ⚠️ **老存档兼容**：老档里只有 `state.companion = {id}`、没有 `companionOwned`，
 *    所以这里把"当前启用的那个"也算作已拥有 —— 否则老用户已经花 1200 买的狐狸
 *    会变成"没买过"，切走再切回来还要再收一次钱。
 */
export function ownedCompanionIds(state) {
  const list = Array.isArray(state?.companionOwned) ? state.companionOwned : [];
  const out = list.map((x) => String(x)).filter((id) => COMPANIONS[id]);
  const cur = String(state?.companion?.id ?? '').trim();
  if (cur && COMPANIONS[cur] && !out.includes(cur)) out.push(cur);
  return out;
}

/** 某个伙伴是否已拥有（id 或名字都认）。 */
export function hasCompanion(state, idOrName) {
  const c = matchCompanion(idOrName);
  if (!c) return false;
  return ownedCompanionIds(state).includes(c.id);
}

/**
 * 宽松匹配一个伙伴：先精确（id / name / 别名，忽略大小写与首尾空格），
 * 再退一步做"包含匹配"（"买只狐狸""换成 GPT 娘吧"）。
 * 匹配不到返回 null。
 */
export function matchCompanion(want) {
  const q = String(want ?? '').trim().toLowerCase();
  if (!q) return null;
  const all = Object.values(COMPANIONS);
  const exact = all.find((c) =>
    String(c.id).toLowerCase() === q
    || String(c.name).toLowerCase() === q
    || (c.aliases || []).some((a) => String(a).toLowerCase() === q));
  if (exact) return exact;
  return all.find((c) =>
    String(c.name).toLowerCase().includes(q)
    || (c.aliases || []).some((a) => String(a).toLowerCase().includes(q))) || null;
}

/**
 * ★★ 闲置伙伴「自己去玩」（2026-10-11 用户需求）。
 *
 * 语义（用户逐条给的口径，别自己发挥）：
 *   · 只有**没被鲸鱼带着**的伙伴（已拥有、但不是当前 `companion`）才会自己出门；
 *   · 而且必须**凑够两个人一组**才走（一个落单的不出门）；
 *   · 走之前从背包里**拿走 2 份**同档米饭，去玩**该档口粮对应的时间**；
 *   · ⚠️ **门槛：那一档米饭必须 ≥ 6 份**才允许 —— 留足给鲸鱼，别把存粮吃空；
 *   · 途中明信片**按档位固定**（不是随机区间）：小 0 / 中 0 / 大 1 张；
 *     到家**再**带 1 张（所以小、中各 1 张，大份 2 张）；
 *   · 到家固定**带 1 件特产**；
 *   · 出门时**同样有概率触发穿越**（与鲸鱼共用 `crossOverChance`）。
 *
 * ⚠️ 「0/0/1」用户 2026-10-11 明确过：**是按口粮档位分档**（小/中/大），
 *    不是"三张卡的位置"。改这张表就能改节奏。
 */
export const SIDE_TRIP = {
  partySize: 2,                                  // 两人一组
  foodNeed: 2,                                   // 每次拿走 2 份
  foodFloor: 6,                                  // 该档米饭 ≥6 才动（留足给鲸鱼）
  midCards: { small: 0, normal: 0, large: 1 },   // 途中张数：按档固定
  souvenirCount: 1,                              // 固定带 1 件特产
  // ★ 2026-10-14 多趟化：两趟之间的**最小间隔**（派完一趟后把 `sideNextAt` 推后这么久）。
  //   原来一趟出门后"另一趟"已经不存在；现在 5 位全请到就能同时跑两趟 ——
  //   若不留这个间隔，两趟会落在**同一分钟**出发、两条播报连发，观感像刷屏。
  partyGapMs: 30 * 60 * 1000,                    // 半小时
  firstDelayMs: 24 * 60 * 60 * 1000               // 还没排过期时，先隔 24 小时再看
                                                  // ★ 2026-10-13：原来 1 小时 ⇒ 新档养上不到一小时
                                                  //   就"自己跑出去玩"，与「家要有存在感」相反。
                                                  //   ⚠️ 实际取值以设置的 `restHoursMin` 为准，这里只是兜底。
};

/**
 * 闲置伙伴：**已拥有、但没被鲸鱼带着**的那几位（返回伙伴定义数组）。
 * 没买过任何伙伴 ⇒ 空数组；只有一位且正被带着 ⇒ 也空数组。
 */
export function idleCompanions(state) {
  const cur = String(state?.companion?.id ?? '').trim();
  return ownedCompanionIds(state)
    .filter((id) => id !== cur)
    .map((id) => COMPANIONS[id])
    .filter(Boolean);
}

// ── ★★ 2026-10-14 菜地（种菜）──────────────────────────────────────────────
//   用户口径：**请过千问 ⇒ 永久解锁**（她"开垦"了这块地，之后她在不在家都能种）；
//   默认 **3 块地**；普通/非普通 **3 天**、**稀有 5 天**；**稀有也能种**（产出更少）；
//   收获时**只有稀有作物给 TOKEN** —— 对齐现状"只有稀有特产带回来才给 50 亿"。
//
//   ★ 周期一律用**时间差**算（`plantedAt` + `now`），不存"还剩几天"：
//     漏跑一天不会丢阶段、进程重启也不会算错（与"TOKEN 只存时间不存数量"同一条哲学）。
export const FARM = {
  slots: 3,
  stageCount: 5,                                   // 播种 → 发芽 → 长高 → 结蕾 → 成熟
  daysCommon: 3,
  daysRare: 5,
  yieldOf: { common: 4, uncommon: 3, rare: 2 },    // 收获份数（净 +3 / +2 / +1）
  // ★★ 2026-10-14 修（用户："多一块地这种事很荒诞啊：她要是出门了那块地就凭空消失吗，上面的特产呢？"）：
  //   这两项原叫 `qwenSlots` / `qwenSpeed`、口径是"**她在庭院时**才 +1 块 / 才快 30%"。
  //   地那半是**真荒诞**：她在家时种下第 4 株、她一出远门上限掉回 3 ⇒
  //   面板显示"4/3 块"，那块地上的东西**既不消失、又不让再种** —— 自相矛盾，
  //   而且玩家第一反应必然是"我的地呢？"。
  //   ⇒ 现在拆开：
  //     · `helperSlots` —— **永久**加块（菜地存在＝请过她，那上限就一直是 4）；
  //     · `helperSpeed` —— 只影响"**她在庭院时种下**"的那一株的周期（`plantSouvenir` 把它冻在株上）
  //       ⇒ **不会凭空多出/少掉任何东西**，也不会"长到一半突然变慢"。
  helperSlots: 1,                                  // 「开地那位」给的**永久**加块（现在＝小折扇/千问）
  helperSpeed: 0.7,                                // 「开地那位」在庭院时**种下**的：周期 ×0.7（冻在株上）
  dayMs: 24 * 60 * 60 * 1000
};

// ── 读写 ──────────────────────────────────────────────────────────────────

const dirOf = () => path.join(DATA_DIR, 'skills', 'travel-whale', 'chats');
const safeKey = (chatKey) => String(chatKey).replace(/[^a-z0-9_]/gi, '_');
const fileOf = (chatKey) => path.join(dirOf(), `${safeKey(chatKey)}.json`);

export function emptyState(chatKey) {
  const now = Date.now();
  return {
    version: 1,
    chatKey: String(chatKey),
    createdAt: now,
    // ★★ 2026-10-15「清档 → 时空乱流」：她被**抛回来**的时刻（0 = 没这回事，正常档）。
    //
    //   为什么要在存档里记这一笔：清档是**外力**干的（不是游戏内事件），可她得**自己知道**
    //   —— 否则会出现两种崩：① 她还以为自己在那趟没走完的旅行里；② 群里问"明信片呢/特产呢"，
    //   她只能瞎编。用户给的口径就是一句话：**「你是被时空乱流抛回来了，还带着小狐狸。」**
    //   ⇒ `index.js` 的 `promptSections` 读这个字段，在抛回来后的头几天注入一段说明。
    //   ⚠️ 措辞里**不许出现**"存档/清档/重置/数据"这类后台词（她只会说"乱流"）。
    rebornAt: 0,
    // 鲸鱼本体
    //   equipUnlocked 起步 = **所有 defaultUnlocked 的地区**（现在＝现实世界的 9 个）。
    //   不写死 `['asia']`：那样每把一个新地区改成默认解锁，新存档还是去不了，
    //   而且「装备齐全」称号（数这个数组）就永远差几个。
    whale: {
      equipUnlocked: [...defaultUnlockedRegionIds()],
      // ★★ 2026-10-15「探索解锁」（用户口径）：**异世界的装备不是一开始就能买的**。
      //   这一层夹在「去过没去过」和「买没买」之间 —— 它答的是"**能不能买**"：
      //     · `equipBuyable`  = **已发现**（穿越到过／被那次穿越顺带解锁）⇒ 商店里列出来、可以花钱买；
      //     · `equipUnlocked` = **已买**（上面那个数组）⇒ 能主动去、且不再是穿越候选；
      //     · 两个都没有 = **还没发现** ⇒ 商店里连名字都不出现（这就是"探索感"）。
      //   新档起步为**空数组**（一个都还没发现），只靠**穿越**一点点开
      //   （每次穿越解锁 3 个，见 `unlockEquipBuyables`）。
      //   ⚠️ 「空数组」是新档的**合法初值**，不是"缺字段" —— 老档兼容因此必须看
      //      `raw.whale.equipBuyable` 是否存在，不能在 merged 上判空（见 loadState）。
      equipBuyable: [],
      equipped: '',
      // ★★ 2026-10-13 旅伴养成：每位旅伴**陪她去过**的异世界（regionId 数组）——
      //    旅伴技能的门槛就是数这个（见 index.js 的 COMPANION_SKILLS）。
      //    只在**到达**时记（settleTrip），穿越到的地方也算（因为确实到过）。
      companionWorlds: {},
      // 旅伴技能：id -> { at }。**与 `skills` 分开存** —— 那条口径是"每个世界恰好一条带数值"，
      // 混在一起会让它失效（见 MEMORY-2 §69⑧）。
      companionSkills: {}
    },
    // 旅行伙伴（商店单开一栏买断；买了就一直跟着出门）。null = 还没买
    // 结构 { id:'fox', at:时间戳 } —— 走 COMPANIONS 查定义。
    companion: null,
    // ★★ 2026-10-14「扩容鲸鱼」（设施 A）：**这一趟同行的全部旅伴**（含领头那位）。
    //   为什么 `companion` 原样保留：它是**唯一真相源**、有 20+ 处调用点（换伙伴／状态卡／
    //   商店／在途快照…）。这里新增一个数组、把 `companion` 当作它的「领头／出镜」那一位，
    //   那些调用点**一处都不用改**；只有真正"需要多位"的地方（张数／稀有／口粮）才读这个数组。
    //   ⚠️ 未建设施时它恰好只有 1 项 ⇒ 行为与从前**逐字节一致**。
    companions: [],
    // 买过的伙伴 id（可切换）：买断的都在这里，切来切去不再重复收费。
    companionOwned: [],
    // ★★ 闲置伙伴「自己去玩」（2026-10-11；**10-14 多趟化**）：在途的**那几趟** + 下次可出发时刻。
    //   `sideTrips` 是**数组**，每项结构同 trip、额外带 `partners:[id,id]`。
    //   能同时有几趟 = `floor(此刻闲置人数 / SIDE_TRIP.partySize)` —— 每派一趟就少两位闲置，
    //   所以 5 位全请到时（live 1 + 闲置 4）自然跑到满两趟，不必写死趟数（用户口径）。
    //   `sideNextAt` 是**"派下一趟"的闸**（全局一个，不是每趟一个）：0 = 还没排过。
    //   ⚠️ 老存档里是**单个对象** `sideTrip` —— `loadState()` 会把它搬进数组，不需要迁移脚本。
    sideTrips: [],
    sideNextAt: 0,
    // 服务器（TOKEN 在这里产出）
    pond: { ready: 0, glow: 0, lastGrowAt: now, lastHarvestAt: 0 },
    // 钱包（收取后入账）
    wallet: { plankton: 0, glow: 0 },
    // 背包
    bag: { food: {}, equip: {}, charm: {} },
    // 商店货架库存（可补货）
    shop: { stock: {}, restockAt: 0 },
    // 进行中的旅程
    trip: null,
    // ★ 2026-10-13 大更新 step4「在家的大合照」：
    //   homeSince  = 这一趟**到家**的时刻（settleTrip 写）；homeShotAt = 这一趟**已经拍过合照**的时刻。
    //   判据"在家待满 N 小时且这一趟还没拍过" ⇒ 回家只拍 1 张；下次到家会重置。
    homeSince: 0,
    homeShotAt: 0,
    // ★ 2026-10-13 庭院设施等级：id -> 等级（缺省/0 = 还没建）。见上面的 GARDENS。
    garden: {},
    // ★★ 2026-10-14 设施 B「标注车间」的上工名册（老存档没有 ⇒ `labelroomOf()` 会补）。
    //   workers: [{ id, since }]  —— `since` 是**这一轮上工**的起点（24 小时硬闸按它算）；
    //   mustTravel: { [id]: true } —— 下过班的旅伴，**必须先出一次门**才能再上工；
    //   pending:   还没收的打工产出（亿 TOKEN，浮点；与 pond 分开算 ⇒ 不受 pond 上限束缚）；
    //   lastPayAt: 产出结算的基准时刻（每轮 tick 按 elapsed 累加 ⇒ 天然幂等）。
    labelroom: { workers: [], mustTravel: {}, pending: 0, lastPayAt: now },
    // 待补事件（进程重启/发送失败时兜底）
    pending: [],
    // ★★ 2026-10-13「随机事件影响心情」：旅行里发生的好事/坏事记在这儿。
    //   sleep-mood 轮询取走、结算成心情 —— 它**只读我们的存档**，游标存在它自己那边
    //   （见 plugins/sleep-mood/lib/travel-sync.js 的 newTravelEvents）。
    moodEvents: [],
    // 事件自增序号：**同一毫秒内可能连推两条**（一张卡既稀有又遭遇战）⇒ id 不能只用时间戳。
    moodEventSeq: 0,
    // 明信片相册
    album: [],
    // 特产图鉴：name -> { name, city, country, rarity, kind, count, stock, eaten,
    //                      giftedCount, planted, desc, image, firstAt, lastAt }
    //   ★ 2026-10-14 特产有了出口（吃 / 送 / 种）之后，`count` 与 `stock` 必须分开：
    //     `count` = **累计带回次数**（只增，是历史统计）；`stock` = **可支配存量**（扣它）。
    //     图鉴的"收集 N 件"与称号判定看的都是**条目数**，所以消耗不影响它们（§69、§95）。
    souvenirs: {},
    // 送出去的东西：userId -> { name, count, items: { 特产名: 次数 }, lastAt }
    //   这是"赠送"唯一的**永久留痕**（刻意不动好感度 —— 那是"她对他"的印象，语义会反）。
    gifted: {},
    // ★ 2026-10-14 消耗前的"犹豫闸"：`{ kind, key, at, sid }`（**吃 / 送共用一套**）。
    //   用户口径："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"＋"赠送也一样加闸"。
    //   ⇒ 第一次调只会**写下这条并回一句犹豫**（**不扣任何东西**）；群里再开口一次才真执行。
    //   `kind` = 'eat' | 'gift'；`key` = 判定"是不是同一件事"的串（吃 = 件名；送 = 件名 + 收礼人）。
    //   `sid` 是唤醒会话 id：**同一轮内连调两次也不放行**（否则模型自己就把自己确认了）。
    useHesitate: null,
    // ★★ 2026-10-14 菜地（种菜）—— 见文件上方 `FARM` 常量。
    //   `farm` = 一株一格：`{ id, name, rarity, kind, city, country, plantedAt, stage, speed }`
    //     · `speed` 在**种下那一刻**定死（千问当时在不在庭院）—— 之后她出门了也不改，
    //       免得"菜长到一半突然变慢"（用户看到的会是莫名倒退）。
    //     · `stage` = **上一次播报到第几档**，用来判断这一轮该不该播报（不是"当前阶段"，
    //       当前阶段随时能从 `plantedAt` 算出来）。
    farm: [],
    // 请过千问 ⇒ 永久 true（她是"开垦的人"，之后她在不在家都能种）。
    farmUnlocked: false,
    // 去过几次：两套计数（城市 + 景点）
    visitedCities: {},
    visitedSpots: {},
    // 称号：id -> { at, count }
    titles: {},
    // ★★ 2026-10-14 清掉「用过的画风 / 装备」两个字段（用户："清掉字段"）：
    //   两者唯一的消费者是称号「百变风格」与「全副武装」，而那**两条称号早已删掉**
    //   （前者要凑齐 93 种画风＝实际不可达；后者判据字段**从来没被写过**）。
    //   两个写入点（出行记画风 / 换装备）也一并去掉 ⇒ 不再往存档里塞没人读的数据。
    //   ⚠️ 老存档里残留的键**无人读**，不用迁移、不会报错。

    // ★★ 2026-10-14 **服装系统**（新玩法，`skills/travel-whale/outfits.js` 是那张服装表）：
    //   · `areasSeen`   —— 去过的**子区域**，键是 `地区id|子区域名`（与 regions.json 的
    //                       `countries[].name` 逐字一致），值是首次到达时间。
    //      ★ 她自己那趟**和**闲置伙伴那趟**都记**（用户口径：解锁服装不要求她本人去过）。
    //   · `wardrobe.owned` —— 已买下的服装 id（`{ miko: true }`）。
    //   · `wardrobe.worn`  —— 每位少女**手动指定的当前着装**（`{ fox: 'miko' }`）；没指定就穿默认。
    //   ⚠️ 三个都是"加法"，老存档里没有 ⇒ 读的一律 `|| {}`，不存在也不报错、行为与从前一致。
    areasSeen: {},
    wardrobe: { owned: {}, worn: {} },
    // 连续旅行天数：{ lastDay:'YYYY-MM-DD', days:N }
    tripStreak: { lastDay: '', days: 0 },
    // 统计
    stats: {
      trips: 0, cards: 0,
      souvenirKinds: 0, rareKinds: 0, rareCards: 0,
      maxSouvenirsPerTrip: 0,     // "满载而归"用
      // ★ 2026-10-13 晚：**累计赚取**（流水，不是余额）—— TOKEN 经济那组称号要用。
      //   只加不减：收 TOKEN / 归来奖励 / 每日津贴 / 新手礼包都会记账，花掉不扣。
      earned: 0,
      // ★★ 2026-10-14 批 3（图鉴页 + 称号）：**收成计数** —— 「第一茬 / 地里常青 / 种出稀罕的」
      //   三条称号要用（见 titles.js 的「特产」组）。
      //   ★ 为什么"吃过/送过"不需要新字段、而"收成"必须记账：
      //     `eaten` / `giftedCount` 就长在特产条目上、本身是累计值（求和即可，**还能追溯老档**）；
      //     而收成收完那株就**从 `farm` 里删掉了** ⇒ 事后无从推算，只能在收的那一刻记一笔。
      //   ⚠️ 老档补默认值不用写迁移：`loadState()` 对 `stats` 做了一层浅合并
      //     （`{ ...base.stats, ...raw.stats }`）⇒ 缺这两个键自然读成 0。
      harvests: 0,          // 收成总次数（不论稀有度）
      rareHarvests: 0,      // 其中**稀有作物**收成次数（"种出稀罕的"用）
      savedAt: 0
    }
  };
}

/**
 * 「默认解锁」的地区 id（读 regions.json，带缓存）。
 *
 * ⚠️ 这里**只读文件、不 import trip.js** —— state.js 是最底层，被 trip.js import，
 *    反过来 import 会成环。所以自己读一次 JSON（`fs.readFileSync` 直接吃 URL，不必转路径）。
 * 读不到就退回老行为（只有 asia）：**绝不让"读文件失败"把整个状态层带崩**。
 */
let _defaultUnlocked = null;
function defaultUnlockedRegionIds() {
  if (_defaultUnlocked) return _defaultUnlocked;
  try {
    const ids = defaultUnlockedIdsOfTheme();
    _defaultUnlocked = ids.length ? ids : [defaultBaseRegionId()];
  } catch {
    _defaultUnlocked = ['asia'];
  }
  return _defaultUnlocked;
}

// ── 「探索解锁」：异世界装备的购买权（2026-10-15）────────────────────────────
//
// 用户原话：「异世界及其装备不要最开始就解锁，保留一点【探索】感：
//            每次【穿越】之后解锁三个未解锁的异世界的装备的购买权；
//            无论是鲸鱼自己穿越还是旅伴穿越都算。」
//
// 三层关系（**别混**，它们是递进的）：
//   ① `equipUnlocked`（**已买**）—— 能**主动去**那个地区，且它不再是穿越候选；
//   ② `equipBuyable` （**已发现**）—— 商店里**看得到、也买得动**；
//   ③ 都没有（**还没发现**）—— 商店里**连名字都不出现**（这就是"探索感"）。
//   ③→② 的唯一入口是**穿越**；②→① 的唯一入口是**花钱买**。
//
// ⚠️ state.js 不能 import trip.js（会成环 —— trip.js 反过来 import 本文件），
//    所以这里像 `defaultUnlockedRegionIds` 一样**自己读一次 regions.json**。
//    读失败 ⇒ 返回空数组 ⇒ `isEquipBuyable` 对异世界判 false… 那会把商店卡死，
//    所以下面 `equipBuyableOf` 特意在"读不到异世界表"时**放行**（见那里的注释）。

let _fictionalIds = null;
onThemeChange(() => {
  _defaultUnlocked = null;
  _fictionalIds = null;
});
/** 全部异世界的 regionId（经过当前主题变换后的非默认解锁世界，带缓存）。 */
export function fictionalRegionIds() {
  if (_fictionalIds) return _fictionalIds;
  try {
    _fictionalIds = otherworldIdsOfTheme();
  } catch {
    _fictionalIds = [];
  }
  return _fictionalIds;
}

/**
 * 已"发现"的异世界 id（＝能买的那些）。
 * ★ 把 `equipUnlocked`（已买）并进来：买过当然等于发现过 —— 否则老玩家会看到
 *   "已解锁的地区在商店里显示成没发现"这种自相矛盾。
 * ★ 过滤：只留**真实存在的异世界 id**（防脏数据把商店撑出幽灵条目）。
 */
export function equipBuyableOf(state) {
  const listed = Array.isArray(state?.whale?.equipBuyable) ? state.whale.equipBuyable : [];
  const bought = Array.isArray(state?.whale?.equipUnlocked) ? state.whale.equipUnlocked : [];
  const valid = new Set(fictionalRegionIds());
  return [...new Set([...listed, ...bought].map((x) => String(x)).filter((id) => valid.has(id)))];
}

/**
 * 这个地区的装备**现在能不能买**（商店的闸）。
 * ★ 只夹**异世界**：现实地区（`defaultUnlocked`）与已买的一律放行。
 * @returns {boolean}
 */
export function isEquipBuyable(state, region) {
  if (!region) return false;
  if (region.defaultUnlocked === true) return true;                 // 基础世界默认解锁区：本来就能去
  const id = String(region.id || '');
  if (!id) return false;
  if (Array.isArray(state?.whale?.equipUnlocked) && state.whale.equipUnlocked.includes(id)) return true;
  const isFic = isOtherworldRegion(region);
  if (!isFic) return true;                                          // 非异世界：不设闸
  // ★ 读不到异世界表（文件坏了）⇒ 别把商店卡死：退回放行
  if (!fictionalRegionIds().length) return true;
  return equipBuyableOf(state).includes(id);
}

/**
 * 一次穿越 ⇒ 解锁若干个"还没发现"的异世界装备购买权。
 *
 * 规则（用户口径，**一次 3 个**）：
 *   · **刚穿越到的那个必定在里面** —— "我都到过那儿了，总该买得到那儿的装备"
 *     （否则会出现"去过却买不了"的怪事）；
 *   · 剩余的从"还没发现"的池子里**随机**补足；
 *   · 池子不够就少给几个（不报错、不补别的世界）。
 *
 * ⚠️ 只写 `whale.equipBuyable` 一个键，不动别处；**幂等**（重复调用不会重复给）。
 * @param {object} state
 * @param {string} arrivedId 这次穿越到的 regionId（可以为空：那样就纯随机）
 * @param {{count?:number, rand?:() => number}} [opts] rand 可注入 ⇒ 离线探针可确定性验证
 * @returns {string[]} **这一次新解锁的** regionId（空数组 = 没有新的了）
 */
export function unlockEquipBuyables(state, arrivedId, { count = 3, rand = Math.random } = {}) {
  if (!state || !state.whale) return [];
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return [];
  const already = new Set(equipBuyableOf(state));
  const pool = fictionalRegionIds().filter((id) => !already.has(id));
  if (!pool.length) return [];                                      // 全发现过了 ⇒ 没有新的
  const picked = [];
  const arrived = String(arrivedId || '');
  if (arrived && pool.includes(arrived)) {
    picked.push(arrived);
    pool.splice(pool.indexOf(arrived), 1);
  }
  const rnd = typeof rand === 'function' ? rand : Math.random;
  while (picked.length < n && pool.length) {
    const r = Number(rnd());
    const i = Math.floor((Number.isFinite(r) ? r : 0) * pool.length) % pool.length;
    picked.push(pool.splice(i, 1)[0]);
  }
  if (!picked.length) return [];
  state.whale.equipBuyable = [
    ...new Set([...(Array.isArray(state.whale.equipBuyable) ? state.whale.equipBuyable : []), ...picked])
  ];
  return picked;
}

/** 读状态；不存在/损坏都从空状态开始（损坏不该让功能挂掉）。 */
export function loadState(chatKey) {
  try {
    // P5：只加读缓存（stat 比对 mtime，没变就不读盘不解析）；**写入路径一律不动**
    const raw = JSON.parse(readTextCached(fileOf(chatKey)));
    if (raw && typeof raw === 'object' && raw.version) {
      // 深合并一层：将来给嵌套对象（如 pond.glow）加字段时，旧存档缺字段也能补上；
      // 只做一层是因为本结构最多两层，再深了就说明设计该拆了。
      const base = emptyState(chatKey);
      const merged = { ...base, ...raw };
      for (const k of Object.keys(base)) {
        const b = base[k];
        const r = raw[k];
        if (b && typeof b === 'object' && !Array.isArray(b)
            && r && typeof r === 'object' && !Array.isArray(r)) {
          merged[k] = { ...b, ...r };
        }
      }
      // ★ 2026-10-11：把「默认解锁」的地区**补齐**进 equipUnlocked。
      //   背景：现实世界 9 个地区在 regions.json 里标了 `defaultUnlocked: true`，
      //   但旧存档的 equipUnlocked 只有硬编码的 `['asia']` —— 不补齐的话会出现
      //   "商店说已解锁、whale_equip 的装备列表却空着"的自相矛盾，而且
      //   titles.js 的「装备齐全」称号会**永远拿不到**（它的判据就是数这个数组）。
      //   用 Set 去重：老存档里已有的 id 不会重复。
      merged.whale = merged.whale || {};
      const validRegionIds = (() => {
        try { return new Set(loadThemedRegions().map((r) => String(r?.id || '')).filter(Boolean)); }
        catch { return null; }
      })();
      const keptUnlocked = (Array.isArray(merged.whale.equipUnlocked) ? merged.whale.equipUnlocked : [])
        .map(String)
        .filter((id) => !validRegionIds || validRegionIds.has(id));
      merged.whale.equipUnlocked = [
        ...new Set([...keptUnlocked, ...defaultUnlockedRegionIds()])
      ];
      // ★★ 2026-10-15「探索解锁」老档兼容：
      //   这个键**在 10-15 之前根本不存在** —— 那时异世界装备是**随便买**的。
      //   所以老档补成「全部异世界」＝行为与从前**逐字一致**（老玩家不会突然买不了）。
      //   ⚠️⚠️ 判据必须落在 **`raw`**（磁盘上那份），**不能**判 `merged`：
      //     `emptyState()` 会给新档塞一个合法的**空数组** `[]`，而 `merged = {...base, ...raw}`
      //     ⇒ merged 上这个键**永远存在**。若在这里写"空就把全部补上"，
      //     新档的探索感会被**当场抹掉**（一个 bug 直接抵消整个玩法）。
      if (!Array.isArray(raw?.whale?.equipBuyable)) {
        merged.whale.equipBuyable = [...fictionalRegionIds()];
      }
      // ★ 2026-10-11：把"当前启用的伙伴"补进 companionOwned（老存档兼容）。
      //   老档只有 state.companion、没有 companionOwned ⇒ 不补齐的话，已经花 1200
      //   买过的伙伴会被当成"没买过"，切走再切回来要**再收一次钱**。
      //   顺带把数组里已失效的 id（伙伴被删掉）清掉。
      merged.companionOwned = ownedCompanionIds(merged);
      // ★★ 2026-10-14「扩容鲸鱼」（设施 A）：老存档只有 `companion`（单值）、没有 `companions`（数组）。
      //   不补齐的话 `companionsOf()` 虽然会回落到 `companion`（功能仍可用），
      //   但**状态卡／说明图**会一时说"带了 0 位" —— 形态与事实对不上。
      //   这里一次性补成"一元数组"（＝没建扩容设施时的正常形态），之后只由 `depart()` 覆写。
      //   幂等：已经有非空 `companions` 的一律不动（反复加载不会越补越多）。
      if (!Array.isArray(merged.companions) || !merged.companions.length) {
        merged.companions = (merged.companion && merged.companion.id) ? [merged.companion] : [];
      }
      // ★★ 2026-10-14 多趟化迁移：老存档里"闲置伙伴那趟"是**单个对象** `sideTrip`，
      //   新结构是数组 `sideTrips`。老档在途那趟**不能被丢掉**（丢了 = 两位伙伴凭空消失、
      //   特产和到家明信片全没了），所以原样搬进数组的第 0 项。
      //   ⚠️ 只在老字段**确实是对象**时搬（老档也可能是 null / 缺失）；搬完把老键删掉，
      //     免得 `saveState` 又把它写回去、下次加载重复搬（数组里出现两个同一趟）。
      if (merged.sideTrip && typeof merged.sideTrip === 'object' && !Array.isArray(merged.sideTrip)) {
        merged.sideTrips = [
          ...(Array.isArray(merged.sideTrips) ? merged.sideTrips : []),
          merged.sideTrip
        ];
      }
      delete merged.sideTrip;
      if (!Array.isArray(merged.sideTrips)) merged.sideTrips = [];
      // ★ 2026-10-14 特产迁移：老档只有 `count`（= 累计带回次数）、没有 `stock`。
      //   不显式对齐的话，`souvenirStock()` 虽然会退回 count（功能仍可用），
      //   但**第一次消耗**就会写出 `stock: 0` —— 而 `count` 还留着，两者从此分叉、
      //   以后再没人能说清"到底还剩几件"。所以这里一次性补齐。
      //   幂等：已经有 stock 的条目一律不动（所以反复加载不会越补越多）。
      merged.souvenirs = (merged.souvenirs && typeof merged.souvenirs === 'object') ? merged.souvenirs : {};
      for (const s of Object.values(merged.souvenirs)) {
        if (!s || typeof s !== 'object') continue;
        if (!Number.isFinite(Number(s.stock))) s.stock = Math.max(0, Number(s.count) || 1);
        if (!Number.isFinite(Number(s.eaten))) s.eaten = 0;
        if (!Number.isFinite(Number(s.giftedCount))) s.giftedCount = 0;
        if (!Number.isFinite(Number(s.planted))) s.planted = 0;
      }
      merged.gifted = (merged.gifted && typeof merged.gifted === 'object') ? merged.gifted : {};
      // 消耗前的"犹豫闸"：老档没有这个键 ⇒ null（= 没有待确认的事）。脏数据也一律清成 null。
      merged.useHesitate = (merged.useHesitate && typeof merged.useHesitate === 'object')
        ? merged.useHesitate : null;
      // 菜地：老档没有这两个键 ⇒ 空数组 / 未解锁（请过千问才会 true）。
      merged.farm = Array.isArray(merged.farm) ? merged.farm.filter((p) => p && typeof p === 'object') : [];
      merged.farmUnlocked = merged.farmUnlocked === true;
      return merged;
    }
  } catch { /* 首次运行很正常 */ }
  return emptyState(chatKey);
}

/**
 * 这个会话到底养没养鲸鱼。
 * ⚠️ 不能用"白名单命中"代替 —— 白名单是**允许**养的地方，不等于**已经**养了。
 *    踩过的坑：收养工具拿 isEnabled 当判据，白名单一配就永远回"早就养着一只啦"，
 *    存档根本没建。
 */
export function stateExists(chatKey) {
  try { return fs.existsSync(fileOf(chatKey)); } catch { return false; }
}

/** 原子写：先 .tmp 再 rename。 */
export function saveState(state) {
  if (!state?.chatKey) return false;
  try {
    fs.mkdirSync(dirOf(), { recursive: true });
    const file = fileOf(state.chatKey);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 → 改 → 写。回调里直接改 state，返回后自动落盘。
 * @returns 回调的返回值；回调抛错则不落盘并把错误抛出去。
 */
export function mutate(chatKey, fn) {
  const state = loadState(chatKey);
  const out = fn(state);
  saveState(state);
  return out;
}

// ── 服务器：TOKEN（懒计算）────────────────────────────────────────────────

/**
 * 把服务器按时间推进到 now。**幂等**：同一个 now 调多次结果一致。
 * @returns {number} 本次新增的 TOKEN 数（可能是小数）
 */
export function growPond(state, now = Date.now()) {
  const pond = state.pond;
  const last = Number(pond.lastGrowAt) || now;
  const elapsed = Math.max(0, now - last);
  if (!elapsed) return 0;
  const mult = arrayMult(state);                 // ★ 服务器阵列：每台多一份基础产出
  const before = Number(pond.ready) || 0;
  const after = Math.min(PLANKTON_CAP * mult, before + (elapsed / PLANKTON_GROW_MS) * mult);
  pond.ready = after;
  pond.lastGrowAt = now;
  return Math.max(0, after - before);
}

/** 当前可收取数量（取整，不改变状态）。 */
export function pondReady(state, now = Date.now()) {
  const pond = state.pond;
  const last = Number(pond.lastGrowAt) || now;
  const elapsed = Math.max(0, now - last);
  const mult = arrayMult(state);                 // ★ 同上
  const raw = Math.min(PLANKTON_CAP * mult, (Number(pond.ready) || 0) + (elapsed / PLANKTON_GROW_MS) * mult);
  return Math.floor(raw);
}

/**
 * 收取。冷却未到 / 没有可收的 → 明确告诉调用方原因，而不是静默失败。
 * @returns {{ok:boolean, collected?:number, glow?:number, remainCoolMs?:number, reason?:string}}
 */
export function harvest(state, now = Date.now()) {
  growPond(state, now);
  // ★★ 2026-10-14 设施 B：顺带把**数据标注车间**的打工产出结算进来（没建/没人上班 ⇒ 0，逐字节不变）。
  //   放在冷却判定**之前**是刻意的：即使这会儿不让收，产出也照常累积（只是暂时收不到）。
  accrueLabelroom(state, now);

  const lastHarvest = Number(state.pond.lastHarvestAt) || 0;
  const coolLeft = HARVEST_COOLDOWN_MS - (now - lastHarvest);
  if (lastHarvest && coolLeft > 0) {
    return { ok: false, remainCoolMs: coolLeft, reason: `刚收过，再等 ${Math.ceil(coolLeft / 1000)} 秒` };
  }

  const fromPond = Math.floor(Number(state.pond.ready) || 0);
  // ★ 车间那份**独立结算**（不受 pond 上限束缚）；`collectLabelroom` 只在真的取到数时才扣账，
  //   所以下面那句 `collected <= 0` 的早退不会"白扣"。
  const fromRoom = collectLabelroom(state);
  const collected = fromPond + fromRoom;
  if (collected <= 0) {
    return { ok: false, reason: '服务器里还没产出 TOKEN' };
  }

  state.pond.ready = (Number(state.pond.ready) || 0) - fromPond;
  state.pond.lastHarvestAt = now;
  state.wallet.plankton = (Number(state.wallet.plankton) || 0) + collected;
  noteEarned(state, collected);            // ★ 累计赚取（余额 ≠ 流水）

  // 稀有掉落：发光 TOKEN
  let glow = 0;
  if (Math.random() < GLOW_CHANCE) {
    glow = 1;
    state.wallet.glow = (Number(state.wallet.glow) || 0) + 1;
  }
  // ★ 分开报（`fromPond` / `fromRoom`）—— 回执才能说清"其中 N 亿是车间挣的"。
  return { ok: true, collected, glow, fromPond, fromRoom };
}

/**
 * 到点就把货架补满。**清空 stock 映射即视为满货** —— 读取时缺字段会回退到
 * 商品自身的 stock 初始值，所以不需要在这里逐项写回。
 * @returns {boolean} 本次是否真的补过（调用方据此决定要不要落盘）
 */
export function restockIfDue(state, now = Date.now(), intervalMs = RESTOCK_INTERVAL_MS) {
  const shop = state.shop || (state.shop = { stock: {}, restockAt: 0 });
  const next = Number(shop.restockAt) || 0;
  if (next > now) return false;
  shop.stock = {};
  shop.restockAt = now + Math.max(0, Number(intervalMs) || RESTOCK_INTERVAL_MS);
  return true;
}

/** 距离下次补货还有多久（毫秒，已到点则为 0）。 */
export function restockRemainMs(state, now = Date.now()) {
  return Math.max(0, (Number(state?.shop?.restockAt) || 0) - now);
}

/**
 * 记一笔**累计赚取**（"成就值"里那组 TOKEN 称号要用）。
 *
 * 为什么要单独记：`wallet.plankton` 是**余额**（花掉就没了），而"累计赚取"要的是**流水**
 * ——她一共从这世界上挣到过多少 TOKEN。两者会越差越远。
 * ⚠️ 只记**加钱**（收 TOKEN / 归来奖励 / 每日津贴 / 新手礼包），扣费一律不算。
 * ⚠️ **直接改 `state.wallet.plankton` 的地方不会进这本账** —— 以后加钱请一律走
 *    `grantPlankton()`（它自己会记账）。
 */
function noteEarned(state, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (!n) return 0;
  state.stats = state.stats || {};
  state.stats.earned = (Number(state.stats.earned) || 0) + n;
  return n;
}

/** 直接发放 TOKEN（归来奖励等）。 */
export function grantPlankton(state, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  state.wallet.plankton = (Number(state.wallet.plankton) || 0) + n;
  noteEarned(state, n);                    // ★ 累计赚取
  return n;
}

/** 扣费。余额不足返回 false，不做任何修改。 */
export function spendPlankton(state, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  const have = Number(state.wallet.plankton) || 0;
  if (have < n) return false;
  state.wallet.plankton = have - n;
  return true;
}

// ── 去过几次：城市 + 景点**两套都记** ───────────────────────────────────────
//   两套都记的原因：称号要分别判定（"城市猎人"看城市数，"名胜收集者"看景点数），
//   而"故地重游"看的是同一城市的重复次数。

/**
 * 统一的城市键：`国家·城市`（避免不同国家重名城市互相覆盖）。
 *
 * ★ 2026-10-11 异世界支持（planet 粒度）：**国家层可以为空**。
 *   有些虚构作品是以星球/据点为单位描绘的（没有"国家"这一层），
 *   那时键退化成**只有城市名**，不再留下前导的 `·` —— 否则会出现
 *   「·神圣泰拉」这种既难看、又和别的地名容易撞的键。
 *   真实地区 country 永远非空 ⇒ **既有存档的键逐字节不变**（向后兼容）。
 */
export function cityKey(country, city) {
  const c = String(country || '').trim();
  const t = String(city || '').trim();
  return c ? `${c}·${t}` : t;
}

/**
 * 记一次到访。
 * @param {{city:string,country:string,region:string,source:'pool'|'free'}} v
 */
export function recordVisit(state, v) {
  const now = Date.now();
  const ck = cityKey(v.country, v.city);
  const prev = state.visitedCities[ck] || {};
  state.visitedCities[ck] = {
    city: v.city,
    country: v.country,
    region: v.region,
    source: v.source || prev.source || 'pool',
    count: (Number(prev.count) || 0) + 1,
    lastAt: now
  };

  for (const spot of Array.isArray(v.spots) ? v.spots : []) {
    const name = String(spot || '').trim();
    if (!name) continue;
    const sp = state.visitedSpots[name] || {};
    state.visitedSpots[name] = {
      name,
      city: v.city,
      country: v.country,
      count: (Number(sp.count) || 0) + 1,
      lastAt: now
    };
  }
}

/** 已去过的城市集合（用于"尽量不重复"）。 */
export function visitedCitySet(state) {
  return new Set(Object.keys(state.visitedCities || {}));
}

/** 某城市的到访次数。 */
export function visitCount(state, country, city) {
  return Number(state.visitedCities?.[cityKey(country, city)]?.count) || 0;
}

// ── 特产图鉴 ──────────────────────────────────────────────────────────────

/**
 * 记一件特产。已收集过 → 累加次数 + **补一份存量**（**不再出图**，省成本也保住稀有度）。
 *
 * ★ 2026-10-14：`stock`（可支配存量，吃/送/种扣它）与 `count`（累计带回次数）分开。
 *   重复带回同一件 ⇒ 存量 +1 ⇒ 又有了可以吃/送/种的份 —— 这是"种菜之外"的第二个供给来源。
 *
 * @param {{kind?:string}} 分类由模型在生成时打标（`food|plant|relic`）；
 *   老档 / 模型没给时留空字符串，由 `souvenir.js` 的 `kindOf()` 在**读侧**推断（不写盘）。
 * @returns {{isNew:boolean, entry:object}}
 */
export function addSouvenir(state, { name, city, country, rarity = 'common', image = '', desc = '', kind = '' }) {
  const key = String(name || '').trim();
  if (!key) return { isNew: false, entry: null };
  if (!state.souvenirs || typeof state.souvenirs !== 'object') state.souvenirs = {};
  const prev = state.souvenirs[key];
  const now = Date.now();
  const k = SOUVENIR_KINDS.includes(String(kind)) ? String(kind) : '';

  if (prev) {
    prev.count = (Number(prev.count) || 0) + 1;
    // ⚠️ 老档没有 `stock` ⇒ 用 `count` 兜底起算（补一份这次的），别让它变成 0 或 NaN。
    const base = Number.isFinite(Number(prev.stock)) ? Number(prev.stock) : Math.max(0, (Number(prev.count) || 1) - 1);
    prev.stock = base + 1;
    prev.lastAt = now;
    if (!prev.kind && k) prev.kind = k;             // 老条目趁这次补上分类
    if (image && !prev.image) prev.image = image;   // 之前没图、这次有了就补上
    return { isNew: false, entry: prev };
  }

  const entry = {
    name: key,
    city: String(city || ''),
    country: String(country || ''),
    rarity: rarity === 'rare' ? 'rare' : (rarity === 'uncommon' ? 'uncommon' : 'common'),
    kind: k,
    desc: String(desc || ''),
    image: String(image || ''),
    count: 1,
    stock: 1,
    eaten: 0,
    giftedCount: 0,
    planted: 0,
    firstAt: now,
    lastAt: now
  };
  state.souvenirs[key] = entry;
  return { isNew: true, entry };
}

/** 一件特产的**可支配存量**（老档没有 `stock` 时退回 `count`）。 */
export function souvenirStock(entry) {
  if (!entry) return 0;
  const raw = Number.isFinite(Number(entry.stock)) ? Number(entry.stock) : Number(entry.count);
  return Math.max(0, Number(raw) || 0);
}

/**
 * 消耗存量 —— **吃 / 送 / 种三条路都走这里**（唯一的扣减点）。
 * @returns {{ok:boolean, left:number, entry:object|null}}
 */
export function consumeSouvenir(state, name, n = 1) {
  const key = String(name || '').trim();
  const entry = state?.souvenirs?.[key];
  if (!entry) return { ok: false, left: 0, entry: null };
  const have = souvenirStock(entry);
  const need = Math.max(1, Math.floor(Number(n) || 1));
  if (have < need) return { ok: false, left: have, entry };
  entry.stock = have - need;
  entry.lastUseAt = Date.now();
  return { ok: true, left: entry.stock, entry };
}

/** 记一次"吃掉"（只累计次数，扣减由 `consumeSouvenir` 负责）。 */
export function recordEat(state, name) {
  const e = state?.souvenirs?.[String(name || '').trim()];
  if (!e) return 0;
  e.eaten = (Number(e.eaten) || 0) + 1;
  return e.eaten;
}

/**
 * 记一次"送出去"：条目计数 + **收礼人永久记名**。
 * @param {{name:string, userId?:string, userName?:string}} o
 */
export function recordGift(state, { name, userId = '', userName = '' } = {}) {
  const key = String(name || '').trim();
  const e = state?.souvenirs?.[key];
  if (!e) return null;
  e.giftedCount = (Number(e.giftedCount) || 0) + 1;
  const uid = String(userId || '').trim();
  if (!uid) return e;
  if (!state.gifted || typeof state.gifted !== 'object') state.gifted = {};
  const rec = state.gifted[uid] && typeof state.gifted[uid] === 'object'
    ? state.gifted[uid] : { name: '', count: 0, items: {}, lastAt: 0 };
  rec.count = (Number(rec.count) || 0) + 1;
  if (userName) rec.name = String(userName);
  if (!rec.items || typeof rec.items !== 'object') rec.items = {};
  rec.items[key] = (Number(rec.items[key]) || 0) + 1;
  rec.lastAt = Date.now();
  state.gifted[uid] = rec;
  return e;
}

/**
 * **只加存量**（种菜的收成用）。
 *
 * ⚠️ 与 `addSouvenir` 的关键区别：它**不会让 `count`（累计带回次数）+1** ——
 *   收成是"地里长出来的"，不是"旅行带回来的"。混进 `count` 会把历史统计说成谎话
 *   （而且 `count` 只增不减，本身就是"都带回来过几次"的记录）。
 */
export function grantSouvenirStock(state, name, n = 1) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return 0;
  const add = Math.max(0, Math.floor(Number(n) || 0));
  if (!add) return 0;
  entry.stock = souvenirStock(entry) + add;
  entry.lastGainAt = Date.now();
  return add;
}

/** 一株的**总周期**（毫秒）：稀有 5 天、其余 3 天；再乘"种下那一刻定死的"倍率。 */
export function farmCycleMs(plot) {
  const days = String(plot?.rarity || '') === 'rare' ? FARM.daysRare : FARM.daysCommon;
  const speed = Number(plot?.speed) > 0 ? Number(plot.speed) : 1;
  return Math.max(60 * 1000, days * FARM.dayMs * speed);
}

/**
 * 这一株现在长到第几档（0 = 刚播种，`stageCount - 1` = 成熟）。
 * ★ **纯函数**：只由 `plantedAt` 和 `now` 决定 ⇒ 漏跑一天、进程重启都不会算错。
 *
 * ⚠️⚠️ **不能写成 `Number(plot.plantedAt) || now`** —— `plantedAt === 0` 是**合法值**
 *   （离线探针就常用 0 当起点），而 `0 || now` 会把它当成"没设置"，算出 `elapsed = 0`
 *   ⇒ 这一株**永远"还没熟"**。（`x || 默认值` 吞掉 `0`：本项目栽过多次的老坑，见 MEMORY 的通则。）
 */
export function farmStageOf(plot, now = Date.now()) {
  const cycle = farmCycleMs(plot);
  const t0 = Number(plot?.plantedAt);
  const planted = Number.isFinite(t0) ? t0 : Number(now);
  const elapsed = Math.max(0, Number(now) - planted);
  const per = cycle / (FARM.stageCount - 1);       // 4 个间隔 ⇒ 5 档
  return Math.max(0, Math.min(FARM.stageCount - 1, Math.floor(elapsed / per)));
}

/**
 * 距离成熟还有多久（毫秒；已经熟了 = 0）。
 * ★ 收成处**只此一处**算这个差值 —— 免得 `|| now` 那个坑在第二个地方再出现一次。
 */
export function farmLeftMs(plot, now = Date.now()) {
  const t0 = Number(plot?.plantedAt);
  const planted = Number.isFinite(t0) ? t0 : Number(now);
  return Math.max(0, farmCycleMs(plot) - (Number(now) - planted));
}

/**
 * 地里最多能种几株（含「开地那位」给的那一块）。
 *
 * ★★ 2026-10-14 改：**只看存档、不看她在不在家**。
 *   原来的签名是 `(state, qwenHere)`，上限会随她的去留从 4 掉回 3 ⇒
 *   界面上会出现"4/3 块"这种自相矛盾（地没消失、却不让再种）。见 `FARM.helperSlots` 的长注释。
 *   ⇒ 现在读 `state.farmUnlocked`（＝请过她）就够了：**请过就一直是 4 块**。
 *   ⚠️ 参数从两个收成一个 —— 调用方（`index.js` 的 `farmCapNow`）必须一起改，
 *     否则老的 `(state, true)` 调用会静默退回 3 块。
 */
export function farmCapOf(state) {
  const unlocked = state?.farmUnlocked === true;
  return Math.max(1, FARM.slots + (unlocked ? FARM.helperSlots : 0));
}

// ── 相册 ──────────────────────────────────────────────────────────────────

/** 存一张明信片。image 为空表示"生图失败、只有文字"。 */
export function addPostcard(state, card, { countStat = true } = {}) {
  const entry = {
    id: `pc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    city: String(card.city || ''),
    country: String(card.country || ''),
    region: String(card.region || ''),
    spot: String(card.spot || ''),
    style: String(card.style || ''),
    charStyle: String(card.charStyle || ''),   // 人物画法（与 style 正交）
    // 同行伙伴 id（'' = 独自拍的）。双人片在相册里据此加个 🦊 标记
    companion: String(card.companion || ''),
    // 'spot' = 讲景点 / 'souvenir' = 讲带回来的特产（景点不够铺满时才出现）
    // ★ 2026-10-13 大更新 step4：新增 'home' = **在家拍的庭院大合照**（旅行卡片之外的第三种）。
    kind: card.kind === 'home' ? 'home' : (card.kind === 'souvenir' ? 'souvenir' : 'spot'),
    // 'rare' = 稀有明信片（画面加了电影级光影 + 边缘金色光晕）
    rarity: card.rarity === 'rare' ? 'rare' : 'common',
    souvenirs: (Array.isArray(card.souvenirs) ? card.souvenirs : []).map(String),
    // ★ 合影成员 id（['whale', 'fox', …]）—— 只有 kind:'home' 会有；相册/日记可据此标"合影"
    members: (Array.isArray(card.members) ? card.members : []).map(String),
    caption: String(card.caption || ''),
    thought: String(card.thought || ''),
    image: String(card.image || ''),
    // ★ 2026-10-25 真实照片降级的署名（版权纪律：用真实图必带；生图 = 空）
    credit: String(card.credit || ''),
    at: Date.now()
  };
  state.album.push(entry);
  // ⚠️ `countStat:false` 用于**在家的大合照**：它确实进了相册，但不该算进
  //   「已寄明信片 N 张」与稀有统计 —— 那是**旅行**的进度，混进来会污染称号。
  if (countStat) {
    state.stats.cards = (Number(state.stats.cards) || 0) + 1;
    if (entry.rarity === 'rare') state.stats.rareCards = (Number(state.stats.rareCards) || 0) + 1;
  }
  return entry;
}

// ── 统计（称号判定读这里）─────────────────────────────────────────────────

export function refreshStats(state) {
  const souvenirs = Object.values(state.souvenirs || {});
  state.stats.souvenirKinds = souvenirs.length;
  state.stats.rareKinds = souvenirs.filter((s) => s.rarity === 'rare').length;
  state.stats.rareCards = (state.album || []).filter((c) => c.rarity === 'rare').length;
  state.stats.savedAt = Date.now();
  return state.stats;
}
