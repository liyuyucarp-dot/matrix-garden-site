// 矩阵庭院（travel-whale）· 模块化组件：core/world-sync.js
// 职责：世界状态（Phases）轮换、地区可见性/解锁判定、庭院慢生活与 life-system 世界书同步

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig, updateConfig } from '../../../src/config.js';
import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as HM from '../home.js';
import { cfg, log } from './runtime-deps.js';
import {
  defaultBaseRegionId,
  expandParentWorldKeyedMap,
  getActiveTheme,
  onThemeChange
} from './theme-pack.js';
import { gardenLevel } from './companions-voice.js';
import { pushMoodEvent } from './mood-battle-events.js';
import { SKILLS, ownedCompanionIds, skillVisitedRegions } from './skills-appointments.js';

/**
 * ★★ 2026-10-18 v3.21「世界状态」（试点：只配了泰拉）
 *
 * 病：同一个地方去十次，看到的是同一座金墙 —— 世界是静态的。
 * 药：每个 `region|组` 有若干 phase（朝圣季 / 戒严 / 圣灰雨…），**每 7 天自动切下一档**，
 *   出发时把当时那一档写进 `trip.phase`，整趟沿用。它给三样东西：
 *     · `brief`  → 明信片里多一行「局势：…」；
 *     · `tone`   → **覆盖该趟的地区影调**（比地区固定影调更准）；
 *     · `avoid`  → 一起覆盖否定项。
 * ⚠️ `data/world-phases.json` 里**没写的地区 = 这套机制不存在**，行为与从前逐字一致。
 * ⚠️ 轮换状态存 `state.worlds[key] = {id, at}`；`at` 超过 7 天就切下一档（按 phases 顺序循环）。
 */
export const PHASE_ROTATE_MS = 7 * 24 * 3600 * 1000;
let worldPhasesCache = null;

export function loadWorldPhases() {
  if (worldPhasesCache) return worldPhasesCache;
  try {
    // 惰性拼路径：SELF_DIR 声明在本文件更后面（TDZ），模块顶层不能直接引用它
    const raw = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'data', 'world-phases.json'), 'utf8'));
    const base = raw && typeof raw.regions === 'object' ? raw.regions : {};
    worldPhasesCache = expandParentWorldKeyedMap(base, getActiveTheme()?.worldPhases);
  } catch (error) {
    log(`[travel-whale] 世界状态表读取失败（不启用）：${error?.message ?? error}`);
    worldPhasesCache = {};
  }
  return worldPhasesCache;
}

/** 当前这一组处于哪个 phase（会顺手推进轮换；改的是 state，落盘交给调用方）。 */
export function currentPhase(state, regionId, group, now = Date.now()) {
  const table = loadWorldPhases();
  const key = `${regionId}|${group}`;
  const entry = table[key] || table[`${regionId}|*`];
  if (!entry || !Array.isArray(entry.phases) || !entry.phases.length) return null;
  const list = entry.phases;
  if (!state.worlds || typeof state.worlds !== 'object') state.worlds = {};
  const cur = state.worlds[key];
  let idx = 0;
  if (cur && cur.id) {
    const at = list.findIndex((p) => p.id === cur.id);
    if (at >= 0) idx = (now - (Number(cur.at) || 0) > PHASE_ROTATE_MS) ? (at + 1) % list.length : at;
  }
  const p = list[idx];
  state.worlds[key] = { id: p.id, at: idx === (cur ? list.findIndex((x) => x.id === cur.id) : -1) ? (Number(cur?.at) || now) : now };
  return p;
}

export function restRange() {
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const c = cfg() || {};
  const out = {};
  const minH = num(c.restHoursMin);
  const maxH = num(c.restHoursMax);
  if (Number.isFinite(minH) && minH > 0) out.minMs = minH * 3600 * 1000;
  if (Number.isFinite(maxH) && maxH > 0) out.maxMs = maxH * 3600 * 1000;
  return out;
}

/**
 * 此刻在途的**闲置伙伴那几趟**（数组）。
 *
 * ★ 2026-10-14 多趟化：`state.sideTrip`（单对象）→ `state.sideTrips`（数组）。
 *   老存档的迁移在 `state.js` 的 `loadState()` 里做（搬进数组并删掉老键），
 *   所以这里只管读；兼容期也顺手认一下老字段，免得"新入口 + 旧 state.js"那段热载窗口里
 *   已经把伙伴派出去的那趟**凭空消失**。
 */
export function sideTripsOf(state) {
  const list = Array.isArray(state?.sideTrips) ? state.sideTrips : [];
  const legacy = (state?.sideTrip && typeof state.sideTrip === 'object' && !Array.isArray(state.sideTrip))
    ? [state.sideTrip] : [];
  return [...list, ...legacy].filter((t) => t && typeof t === 'object');
}

/**
 * ★★ 2026-10-15：某位旅伴此刻是不是正**自己跑出去玩**（在 `sideTrips` 里）。返回那趟或 `null`。
 * 纯函数、只读。
 *
 * ★ 与"她本人（鲸鱼少女）在不在家"是**两件事** —— 后者看 `state.trip`，别混用：
 *   本函数的用途是"**这一位**能不能马上陪她出门"。
 * 用在三处，都是出发/换人前的闸：
 *   · `appointCompanion` —— 要换的那位不在家 ⇒ 换不了，先记"说好了"（用户 10-15 口径）；
 *   · `tick()` 的**领头发车检查** —— 领头还没回家就先别出门（避免一个人同时在两趟旅行里）；
 *   · `whale_status` —— 如实注明"这位自己出去玩了、还没回来"。
 */
export function awaySideTripOf(state, id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return sideTripsOf(state).find((t) => (Array.isArray(t.partners) ? t.partners : [])
    .map(String).includes(want)) || null;
}

/**
 * 把老字段 `sideTrip`（单对象）**就地**搬进 `sideTrips[]`，并删掉老键。
 *
 * 为什么要有它：`loadState()` 已经做过一次迁移，但"新入口 + 旧 state.js"那段热载窗口里
 * 读到的存档仍可能是老形状。**所有写路径（出发 / 结算 / tick 推进）都要先过它** ——
 * 否则"从数组里删掉这一趟"会删了个寂寞（那趟还挂在 `state.sideTrip` 上，永远回不了家）。
 * @returns {object[]} 归一化后的数组（引用，可直接 push/splice）
 */
export function normalizeSideTrips(state) {
  if (!state || typeof state !== 'object') return [];
  if (!Array.isArray(state.sideTrips)) state.sideTrips = [];
  const legacy = state.sideTrip;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) state.sideTrips.push(legacy);
  if ('sideTrip' in state) delete state.sideTrip;
  return state.sideTrips;
}

/**
 * 此刻**已经在某趟旅行里**的伙伴 id 集合（鲸鱼那趟 + 闲置伙伴**每一趟**）。
 *
 * 为什么必须有它：`idleCompanions`（state.js）只排除"当前 live 的 companion"那一位。
 * 正常口径下 live == 鲸鱼这趟的同伴（见 `appointCompanion`），所以本来就对；
 * 但「闲置伙伴自己出去玩」各趟的 `partners`**不在它的视野里** —— 一旦谁在半路改了 live，
 * 就会出现"同一个人同时出现在两趟旅行里"。
 * ★ 多趟化之后这句更要紧：**每一趟都要收进来**，否则两趟会挑到同一个人。
 */
export function busyCompanionIds(state) {
  const out = new Set();
  const add = (x) => {
    const s = String((x && typeof x === 'object') ? (x.id ?? '') : (x ?? '')).trim();
    if (s) out.add(s);
  };
  // ★ 2026-10-15 修（设施 A 带出来的真 bug）：这里原来**只收 `trip.companion`（领头那一位）**。
  //   设施 A 之后一趟可能带 3~4 位同行 ⇒ 另外几位不在集合里 ⇒ 会被 `sideTrips` 再抽走，
  //   同一个人同时出现在两趟旅行里。`state.companions` 才是"这一趟同行的全部"。
  if (state?.trip) {
    add(state.trip.companion);
    for (const c of (Array.isArray(state?.companions) ? state.companions : [])) add(c);
  }
  for (const t of sideTripsOf(state)) {
    for (const id of (Array.isArray(t.partners) ? t.partners : [])) out.add(String(id));
  }
  // ★★ 2026-10-14 设施 B「数据标注车间」（**用户口径**）：**在车间上工的人也算"忙"** ——
  //   她们在上班，不会偷跑出去旅游。
  //   ★ 接在这里而不是去改 `pickSideParty` 的调用点：`idle`（3100 行）本来就是按这个集合
  //     过滤出来的 ⇒ **一处生效**，将来别处再按"谁有空"选人时也自动正确。
  //   ⚠️ `typeof` 包装：`state.js` 是**兄弟模块**，热载窗口里可能是"新 index + 旧 state"
  //     ⇒ 那时新函数不存在，退回旧行为（不裸调、不 TypeError）。
  if (typeof S.labelroomWorkers === 'function') {
    for (const w of S.labelroomWorkers(state)) {
      const id = String(w?.id || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * 这一趟是谁在途（`sendCard` / 结算都要按趟操作，不能再靠"全局只有一趟"）。
 * @param {'trip'} which 或直接传**趟对象**（多趟化后的常规用法）
 */
export function tripRefOf(state, which) {
  if (which && typeof which === 'object') return which;      // 常规用法：直接传趟对象
  if (which === 'side') return sideTripsOf(state)[0] || null; // 兼容旧的 'side'（原来只有一趟）
  return state?.trip || null;
}

/**
 * 目的地的**展示名**：有国家/星系就"国家·城市"，没有就只显示城市。
 *
 * ★ 2026-10-11 异世界：星球级目的地（「神圣泰拉」「亚空间」）**没有国家层**，
 *   `country` 是空字符串 —— 老的 `${country}·${city}` 拼法会渲染出
 *   「·神圣泰拉」这种带前导点的怪名字。所以**所有给人看的地方都走这里**。
 *   ⚠️ 别和 `state.js` 的 `cityKey()` 搞混：那个是**存档键**，这个是**给人看的**。
 */
export const placeLabel = (o) => [o?.country, o?.city].filter(Boolean).join('·') || String(o?.city || '');

/**
 * 这个地区**现在能不能去**。
 *
 * 两条任一成立即算解锁：
 *   ① `region.defaultUnlocked === true` —— 数据层声明"人人可去"
 *      （2026-10-11 用户要求：现实世界的 9 个地区全部默认解锁，不必逐个花 2000 亿 TOKEN 买）
 *   ② 存档 `whale.equipUnlocked` 里有它 —— 花 TOKEN 买过的
 *
 * ⚠️ **光改 regions.json 是没用的**：`equipUnlocked` 的初值硬编码在 state.js 的
 *    `emptyState()` 里（`['asia']`），而商店的「未解锁装备」和 `whale_equip` 的
 *    可选清单**全按它筛**。判定必须统一收到这一个函数里，否则会出现
 *    "商店说已经解锁、装备列表却找不到这件装备"的自相矛盾。
 */
export const isRegionUnlocked = (st, region) =>
  Boolean(region?.defaultUnlocked || region?.baseWorld) || (st?.whale?.equipUnlocked || []).includes(region?.id);

/**
 * ★★ 2026-10-15「探索解锁」——**一个地区"她已经知道"了吗**
 * （= 能不能出现在装备表 / 技能树 / 技能列表 / 衣柜里）。三条任一成立：
 *   ① **已解锁**（`isRegionUnlocked`：默认那 9 件 ∪ 买过的）—— 拥有的当然知道；
 *   ② **已发现**（`state.whale.equipBuyable`）—— 穿越时解锁的那 3 个
 *      （其中 2 个是**还没去过**的世界，属于"预告"，用户拍板要保留）；
 *   ③ **她本人去过**（`visitedCities` 的 region）。
 *
 * ⚠️⚠️ ③ **绝对不能漏**（2026-10-15 用户口径："技能和衣柜在初期应该直接不解锁，
 *   在**去过至少一个异世界**之后才解锁，而且**仅解锁能看到的世界**的那部分"）。
 *   因为**正常出行不走 `unlockEquipBuyables()`**（只有"穿越"才调它）⇒
 *   她自己挑着去的那个世界只存在于 ③ 里；少了 ③ 就会变成
 *   "她明明去过提瓦特、技能表却装作没有提瓦特"，而且**越正常玩越严重**。
 *
 * ⚠️ `isEquipBuyable` 是 `state.js` 的**新导出** ⇒ 必须 `typeof` 包装
 *   （热载窗口里旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致、不崩）。
 * ⚠️ 老档兼容（`loadState` 把 `equipBuyable` 补成"全部异世界"）⇒ 老玩家看到的**一件都不会少**。
 * ⚠️ 这张表只作**展示层**判据：能不能学/能不能买另有各自主线的门槛
 *   （`skillGate` 要求**真的去过那个世界**、服装要求**去过那个子区域**）
 *   —— 这里放宽**不会**让人凭空学会或买到任何东西。
 */
export const isRegionVisible = (st, region) => {
  if (!region) return false;
  if (isRegionUnlocked(st, region)) return true;
  if (typeof S.isEquipBuyable === 'function' && S.isEquipBuyable(st, region)) return true;
  return skillVisitedRegions(st).has(String(region.id));
};

/** 可见地区 id 名单（`helpDataFor` / 商店 / 技能表 / 衣柜共用）。读不到地区表 ⇒ `null` = 不设闸。 */
export function visibleRegionIds(st) {
  try { return T.loadRegions().filter((r) => isRegionVisible(st, r)).map((r) => r.id); }
  catch { return null; }
}

/**
 * 技能树里**她"知道有这回事"**的那些条（技能表 / `whale_skill` 列表都按它筛）。
 *
 * ★ SKILLS 的 30 条 region **全在 15 个异世界**里（每个世界 2 条，没有现实的技能）
 *   ⇒ 新档（`equipBuyable=[]`、没去过任何异世界）筛完就是**空数组** ⇒
 *   **技能树天然"未解锁"**，正好落在用户说的"初期直接不解锁"上，不需要再写一道总闸。
 * ⚠️ 读不到地区表 ⇒ 返回全量（与从前一致，别因为读表失败就把技能树清空）。
 */
export function visibleSkills(st) {
  const vis = visibleRegionIds(st);
  if (!vis) return SKILLS;
  const set = new Set(vis.map(String));
  return SKILLS.filter((sk) => set.has(String(sk.region)));
}

/**
 * ★★ 2026-10-19（用户口径）：**自动出门不再受装备限制** —— 在"已解锁"的地区里随机挑一个，
 * 想去哪去哪。装备从此只表示"买过这件 ⇒ 那个地区解锁了"，不再决定目的地。
 * ⚠️ 点名目的地仍然走 `regionOfEquipped()` 那条老路（群友说"去杭州"时由 city/country 决定）。
 */
/** 已解锁的地区列表（自动出门与"让她自己挑"共用同一口径）。导出只为探针能断言。 */
export function unlockedRegions(state) {
  const fbId = defaultBaseRegionId();
  try {
    const ids = new Set(Array.isArray(state?.whale?.equipUnlocked) ? state.whale.equipUnlocked.map(String) : []);
    const list = T.loadRegions().filter((r) => ids.has(String(r.id)) || r.defaultUnlocked === true);
    return list.length ? list : [T.regionById(fbId)].filter(Boolean);
  } catch (error) {
    log(`[travel-whale] 取已解锁地区失败，退回默认基础区（${fbId}）：${error?.message ?? error}`);
    return [T.regionById(fbId)].filter(Boolean);
  }
}

export function randomUnlockedRegion(state, rand = Math.random) {
  const list = unlockedRegions(state);
  if (!list.length) return T.regionById(defaultBaseRegionId());
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/** 用哪件装备决定的地区 → 对应大洲/大洋（或当前主题的基础大区）。没装备就退回当前主题默认基础区。 */
export function regionOfEquipped(state) {
  const eq = String(state?.whale?.equipped ?? '').trim();
  try {
    if (eq) {
      const hit = T.loadRegions().find((r) => (r.equipment && r.equipment === eq) || r.id === eq || r.name === eq);
      if (hit && isRegionUnlocked(state, hit)) return hit;
    }
    return T.regionById(defaultBaseRegionId());
  } catch (error) {
    log(`[travel-whale] 地区表读取失败：${error?.message ?? error}`);
    return null;
  }
}

// ── 与「世界与事件」(life-system) 的联动（2026-10-12 用户需求）─────────────
//
// 目标：让她**知道"自己旅行到的世界是什么样"** —— 不是往提示词里塞一套固定世界观，
//   而是「她人在哪，世界设定就是哪」；回到家就不再注入任何异世界设定。
//
// 为什么这么接（这条最关键）：
//   life-system 的 `promptSections()` **每轮现读** `cfg().worldbook`，而它的 cfg 就是
//   `skillManager.settingsOf('life-system')` → `config.skills['life-system']`（**内存对象**）。
//   所以这里只要改内存里那个键，**她下一句话就在新世界里** —— 不用重启、不用起 HTTP。
//   ⚠️ 直接改 `data/config.json` 文件是**没用的**（宿主内存里的旧对象一写盘就盖回去）。
//
// 节奏：在 tick 里**幂等**同步 —— 世界没变就什么都不做（避免每个 tick 都动全局配置）。
export const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORLD_BOOKS_FILE = path.join(SELF_DIR, 'data', 'worldbooks.json');
/** 目标技能 id（用清单里的 id，不是目录名）。 */
export const LIFE_SYSTEM_ID = 'life-system';
let worldBooksCache = null;
/** 上一次同步过去的 worldbook —— 内容相同就不重复写。 */
let lastWorldbook = null;

/** 读世界速写表（85 个异世界地点 → 一段速写），进程内缓存。 */
export function loadWorldBooks() {
  if (worldBooksCache) return worldBooksCache;
  try {
    const raw = JSON.parse(fs.readFileSync(WORLD_BOOKS_FILE, 'utf8'));
    const base = raw && typeof raw.worlds === 'object' ? raw.worlds : {};
    worldBooksCache = expandParentWorldKeyedMap(base, getActiveTheme()?.worldbooks);
  } catch (error) {
    log(`[travel-whale] 世界速写表读取失败（联动会静默跳过）：${error?.message ?? error}`);
    worldBooksCache = {};
  }
  return worldBooksCache;
}

/**
 * 由当前旅程算出该给她的世界设定文本；不在途（或查不到）返回空串。
 *
 * ⚠️ 键的拼法必须与 worldbooks.json 一致：`<regionId>|<组名>`。
 *   组名取 `country || city` —— 因为**异世界的目的地是"组名当 city、country 为空"**
 *   （trip.js 的 flatten 分支：星球级 / 大区级地点根本没有"国家"这一层）。
 */
export function worldbookForTrip(trip) {
  if (!trip) return '';
  const group = String(trip.country || trip.city || '').trim();
  if (!group) return '';
  const books = loadWorldBooks();
  let regionId = String(trip.regionId || '').trim();
  let book = regionId ? books[`${regionId}|${group}`] : '';
  // ★ 兜底：**升级前出发的老旅程没有 regionId**（这个字段 2026-10-12 才加），
  //   直接查不到就白联动了。按组名反查一次 —— 只有**唯一命中**才采用，
  //   因为组名会重（"谷地"同时出现在维斯特洛与费伦），歧义时宁可不动。
  if (!book) {
    const hits = Object.keys(books).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) {
      book = books[hits[0]];
      regionId = hits[0].slice(0, hits[0].indexOf('|'));
    }
  }
  if (!book) return '';
  let regionName = regionId;
  try { regionName = T.regionById(regionId)?.name || regionId; } catch { /* 取不到名字就用 id */ }
  return `她此刻人在【${regionName} · ${group}】旅行。${book}`;
}

/**
 * ★★ 2026-10-18「绘图的 GPT 不知道那是哪儿」（用户抓到的真问题）。
 *
 * `worldbooks.json` 是**叙事**（"信仰比空气更实在"），只喂给 life-system 让她说话；
 * 生图那边一条都没拿到，于是泰拉被画成"明亮的白色尖塔 + 云海"。
 * 这份 `visual-briefs.json` 是同一批地点的**纯视觉**改写（主色/材质/光线/天气/人群），
 * 专门拼进生图提示词的「世界」行。
 *
 * 取值优先级：`regionId|组名` → `regionId|*` → ''（取不到就不加这一行，绝不瞎补）。
 * ⚠️ 键的拼法与 `worldbooks.json` 完全一致，解析逻辑也照抄（含老旅程没有 regionId 的反查）。
 */
export const VISUAL_BRIEFS_FILE = path.join(SELF_DIR, 'data', 'visual-briefs.json');
let visualBriefsCache = null;
export function loadVisualBriefs() {
  if (visualBriefsCache) return visualBriefsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(VISUAL_BRIEFS_FILE, 'utf8'));
    const base = raw && typeof raw.briefs === 'object' ? raw.briefs : {};
    visualBriefsCache = expandParentWorldKeyedMap(base, getActiveTheme()?.visualBriefs);
  } catch (error) {
    log(`[travel-whale] 视觉速写表读取失败（配图会少一行世界基调）：${error?.message ?? error}`);
    visualBriefsCache = {};
  }
  return visualBriefsCache;
}

/**
 * ★★ 2026-10-18：影调（有多亮、光从哪来、有多脏）。取值与回退规则同 `visualBriefForTrip`。
 * 返回 `{ tone, avoid }`；查不到返回空串字段（调用方据此不加这一行）。
 */
export const TONES_FILE = path.join(SELF_DIR, 'data', 'tone-briefs.json');
let tonesCache = null;
export function loadTones() {
  if (tonesCache) return tonesCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TONES_FILE, 'utf8'));
    const base = raw && typeof raw.tones === 'object' ? raw.tones : {};
    tonesCache = expandParentWorldKeyedMap(base, getActiveTheme()?.tones);
  } catch (error) {
    log(`[travel-whale] 影调表读取失败（配图少一行明暗约束）：${error?.message ?? error}`);
    tonesCache = {};
  }
  return tonesCache;
}

onThemeChange(() => {
  worldPhasesCache = null;
  worldBooksCache = null;
  visualBriefsCache = null;
  tonesCache = null;
  lastWorldbook = null;
});

export function toneForTrip(trip) {
  const empty = { tone: '', toneAvoid: '' };  // 字段名与 composePostcard 对齐
  if (!trip) return empty;
  const group = String(trip.country || trip.city || '').trim();
  const tones = loadTones();
  let regionId = String(trip.regionId || '').trim();
  const pick = (k) => {
    const v = tones[k];
    return v && typeof v === 'object' ? { tone: String(v.tone || '').trim(), toneAvoid: String(v.avoid || '').trim() } : empty;
  };
  if (regionId && group) {
    const hit = pick(`${regionId}|${group}`);
    if (hit.tone) return hit;
  }
  if (!regionId && group) {
    const hits = Object.keys(tones).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) return pick(hits[0]);
  }
  if (regionId) return pick(`${regionId}|*`);
  return empty;
}

/** 由当前旅程算出该给**配图**用的纯视觉速写；不在途（或查不到）返回空串。 */
export function visualBriefForTrip(trip) {
  if (!trip) return '';
  const group = String(trip.country || trip.city || '').trim();
  if (!group) return '';
  const briefs = loadVisualBriefs();
  let regionId = String(trip.regionId || '').trim();
  let brief = regionId ? briefs[`${regionId}|${group}`] : '';
  if (!brief && !regionId) {
    // 老旅程没有 regionId：按组名反查（只有唯一命中才用 —— 组名会重，"谷地"两边都有）
    const hits = Object.keys(briefs).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) {
      brief = briefs[hits[0]];
      regionId = hits[0].slice(0, hits[0].indexOf('|'));
    }
  }
  if (!brief && regionId) brief = briefs[`${regionId}|*`] || '';
  if (!brief) {
    // 放到最后：regionId 对但组名对不上时，也退回该地区的兜底基调
    const hits = Object.keys(briefs).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) brief = briefs[hits[0]];
  }
  return String(brief || '').trim();
}

/**
 * ★★ 2026-10-13：她**在庭院里**时，院子里还有谁（＝邀请过的全部，减去没在家的）。
 *   有任一趟在外时不算（调用方已挡）。
 */
export function homeMateIds(state) {
  return ownedCompanionIds(state).map((id) => String(id));
}

/**
 * ★★ 2026-10-13：刷新"此刻她在庭院里做什么"（`state.homeAct`）。
 *
 * 为什么由**本技能**算、并**写进自己的存档**：它要同时喂两个集成系统 ——
 *   · sleep-mood（只读我们的存档，老契约不变）⇒ 面板 + 提示词；
 *   · life-system（世界与事件）⇒ 走 `syncWorldbook` 进 `worldbook`。
 * 若让两边各算一份，就会出现"面板说在烤火、世界书说在打牌"。**单一真源**。
 *
 * 幂等：同一挡（20 分钟）+ 同一批伙伴 ⇒ 什么都不做（不必每个 tick 都写盘）。
 * @returns {boolean} 有没有变化（调用方据此决定 dirty）
 */
/**
 * 「在家的瞬间」流水保留天数。
 * 素材只服务"写日记"（筛完的**回忆**才是长期资产，那本在 qqzone 那边）；
 * 所以留两周足够，别让存档无限涨。
 */
export const HOME_LOG_KEEP_DAYS = 14;

export function refreshHomeAct(state, now = Date.now()) {
  if (state.trip || sideTripsOf(state).length) return false;   // 有人在外面 ⇒ 不算"人在庭院"
  const mateIds = homeMateIds(state);
  const mateNames = mateIds.map((id) => (S.COMPANIONS || {})[id]?.name || id).filter(Boolean);
  // ★ 2026-10-14：**按旅伴绑定的庭院事件**（`mateId`）要靠 id 匹配 ⇒ 把 id+名字一起传下去。
  const mates = mateIds.map((id, i) => ({ id, name: mateNames[i] || id })).filter((m) => m.name);
  const bucket = (typeof HM.homeBucketOf === 'function') ? HM.homeBucketOf(now) : 0;
  // ★ 檐廊等级：必须**在幂等判定之前**取（下面那句会读它；`const` 有 TDZ，
  //   写在后面会直接抛 `Cannot access 'eaves' before initialization` —— 探针抓到过）。
  const eaves = gardenLevel(state, 'eaves');
  const cur = state.homeAct;
  if (cur && Number(cur.bucket) === bucket
    // ★ 键与下面写盘时**必须逐字一致**（这里是"变了没有"的判据，写歪了就会每 tick 都重抽）
    && String(cur.mateKey || '') === `${mateIds.join(',')}|eaves:${eaves}|farm:${state.farmUnlocked === true ? 1 : 0}`) {
    return false;                                              // 同一挡 + 同批人 + 同檐廊 + 同菜地 ⇒ 不变
  }
  const picked = (typeof HM.pickHomeAct === 'function')
    ? HM.pickHomeAct({
      chatKey: state.chatKey,
      homeSince: state.homeSince,
      mates,                                   // ★ 带 id（`mateId` 条目要用）
      mateNames,                               // 老口径留着（万一有别的调用方）
      homeName: HM.HOME_NAME,
      eaves,
      farm: state.farmUnlocked === true,       // ★ `needsFarm` 条目的门槛
      // ★★ 2026-10-15「半衰 ＋ 同组覆盖」（用户口径）：把"每条**上次被抽中**的时刻"递进去 ——
      //   刚做过的那条、以及它所属的那一组，会一起淡出候选池（治"连着三挡都在收拾东西"）。
      //   ⚠️ 老存档没有 `homeActSeen` ⇒ 传 undefined ⇒ pickHomeAct 跳过过滤（与从前逐字一致）。
      seen: state.homeActSeen
    }, now)
    : null;
  if (!picked) return false;
  // ★ 半衰的账本：记下"这一条什么时候做的"。键只会有池子里那些 id ⇒ 不会无限涨。
  if (!state.homeActSeen || typeof state.homeActSeen !== 'object') state.homeActSeen = {};
  state.homeActSeen[String(picked.id)] = now;
  state.homeAct = {
    id: picked.id, act: picked.act, detail: picked.detail, mate: picked.mate,
    // ★ 记下这条绑的是谁（没有绑人就是空串）—— 便于排查"面板说在和小月亮翻册子，可她在路上"
    mateId: picked.mateId || '',
    mateIds, mateNames,
    // ⚠️ 幂等键要用 **id 不用名字**：名字可以改，改了会让"同一档同批人"被判成变了。
    //   带上 `farm` 也一样（菜地一建起来，`needsFarm` 那两条才进池子 ⇒ 池子真的变了）。
    mateKey: `${mateIds.join(',')}|eaves:${eaves}|farm:${state.farmUnlocked === true ? 1 : 0}`,
    bucket: picked.bucket, at: now
  };
  // ★★ 2026-10-14「她的一天」流水 ②：**在家的瞬间**也要留档（给空间日记当素材）。
  //   原来 `state.homeAct` **只留最后一条** —— 每 20 分钟被下一挡覆盖 ⇒ 日记里
  //   "她在家那半天干了什么"完全查不到（存档里只剩此刻那一条）。
  //   ⚠️ 这里**天然按挡位去重**：上面的幂等判定已经在"同挡 + 同批人 + 同檐廊 + 同菜地"时
  //      `return false` 了，所以走到这儿就是"真的换了一挡"。
  const hlog = Array.isArray(state.homeLog) ? state.homeLog : (state.homeLog = []);
  hlog.push({
    at: now, bucket: Number(picked.bucket) || 0, id: String(picked.id || ''),
    act: String(picked.act || ''), detail: String(picked.detail || ''),
    mate: String(picked.mate || ''), mateId: String(picked.mateId || '')
  });
  const hcut = now - HOME_LOG_KEEP_DAYS * 86400000;
  while (hlog.length && Number(hlog[0].at) < hcut) hlog.shift();
  // ★★ 2026-10-15「庭院活动也影响心情」（用户口径）：新活动带心情标注 ⇒ 推一条
  //   `home-act` 事件，走现成的 moodEvents 通道让 sleep-mood 结算（delta 随事件自带）。
  //   ⚠️ `homeActMoodOf` 是 home.js（兄弟模块）的导出 ⇒ 热载窗口里可能是"新 index + 旧 home"
  //      ⇒ `typeof` 包装，旧模块没有就静默跳过（跟从前一致，不裸调）。
  //   ⚠️ 只在**真的换了活动**时走（上面幂等判定已经保证），同一挡调一百次也只推一条。
  const actMood = (typeof HM.homeActMoodOf === 'function') ? HM.homeActMoodOf(picked) : null;
  if (actMood && Object.keys(actMood).length) {
    pushMoodEvent(state, 'home-act', {
      where: HM.HOME_NAME, act: String(picked.act || ''),
      deltas: actMood            // ★ delta 随事件自带（sleep-mood 结算时优先用它）
    });
  }
  return true;
}

/**
 * ★★ 2026-10-13：她**在家**时的世界设定。
 *
 * 原来不在途就返回空串 ⇒ `syncWorldbook` 那边"回到家 → 清空"，
 * 于是世界观插件（life-system）的世界书里**既没有庭院、也不知道她此刻在做什么**。
 * 现在补上：庭院 + 院子里有谁 + 此刻在做什么（与 sleep-mood 看到的是同一条）。
 */
export function worldbookForHome(state) {
  const act = state?.homeAct;
  const names = (Array.isArray(act?.mateNames) ? act.mateNames : []).filter(Boolean);
  const who = names.length
    ? `院子里还住着${names.join('、')}`
    : '院子里今天只有她一个';
  const doing = act?.act
    ? `此刻她${act.act}${act.detail ? ` —— ${act.detail}` : ''}`
    : '这会儿她大概在檐廊下待着';
  // ⚠️ 条目的 `detail` 全部以「。」收尾 ⇒ 无条件再补一个句号会拼出"…笑出来。。"
  //   （这句是**直接进世界书、给模型看的**，双句号很显眼）。所以按结尾判断要不要补。
  const tail = /[。！？…]$/.test(doing) ? '' : '。';
  return `她此刻人在【${HM.HOME_NAME}】${who}。${doing}${tail}`;
}

/** 她出门时**留在院子里**的旅伴（邀请过的 − 跟着出门的 − 自己跑出去玩的）。读不到就返回空数组。 */
export function homeStayNames(state) {
  let away = new Set();
  try {
    // ⚠️ 热载窗口里可能是"新 index + 旧 state"⇒ typeof 兜底，别裸调（跟本文件其它跨模块调法一致）
    if (typeof S.awayMateIds === 'function') away = S.awayMateIds(state) || away;
  } catch { /* 读不到就当没人在外，最多少说一句"院子里留着谁" */ }
  return ownedCompanionIds(state)
    .map((id) => String(id))
    // `awayMateIds` 给的是字符串集合（跟出门的 + 自己出去玩的两类都算）
    .filter((id) => !away.has(id))
    .map((id) => (S.COMPANIONS || {})[id]?.name || '')
    .filter(Boolean);
}

/**
 * ★★ 2026-10-24「庭院常时生效」（用户报的 bug，**药在这儿**）：
 *
 * 病：`life-system` 的世界书只有**一格** —— 她一出发，`worldbookForTrip(...)` 就把
 *   `worldbookForHome(...)` **整段顶掉**。于是世界书里只剩"欧洲 · 挪威……"，
 *   一句"她是哪儿的人、从哪儿出的门"都没有；回来讲旅行就丢了参照
 *   （说不出"逛了一圈还是咱院子好"这种话）。
 * 药：旅行中写进去的是**两段** —— 来处（常时有效）＋ 当趟目的地，见 `syncWorldbook`。
 *
 * ⚠️ 为什么**不能**拿 `worldbookForHome` 当常时段：它讲的是"**此刻**她在庭院做什么"
 *   （读 `state.homeAct`）。人已经在路上，那句"此刻她借小白龙身上的光看地图"是**过期**的
 *   —— 她在外面，家里的事不该用"此刻"开头。所以这一段只讲**身份与来处**，不讲当下。
 * ⚠️ 与 `travel-whale-home-lore`（L0 静态段，priority 46）**不抢职责**：那段讲庭院长什么样
 *   （石板缝的蓝光、水镜、星空，还有"别把院子讲到目的地风景里"的消歧）；
 *   这段只回答**两件事**：她是从哪出发的、院子里留着谁。
 *
 * 常时段：她**住在哪儿、从哪儿出发**（不含"此刻在做什么"—— 见上面的 ⚠️）。
 * 纯函数（只读 `state`/`COMPANIONS`）⇒ 可离线单测。
 */
export function worldbookForRoot(state) {
  const names = homeStayNames(state);
  const stay = names.length ? `院子里留着${names.join('、')}。` : '';
  return `她住在【${HM.HOME_NAME}】—— 那是她的家、她的来处，一座不属于任何一个世界的院子；`
    + `她每回出门走的都是院子中央那方水镜，回程也从那儿回。${stay}`;
}

/**
 * 把「她在哪个世界」同步给 life-system 的 worldbook。幂等：内容没变就什么都不做。
 * 任何异常都只记日志 —— **联动失败绝不该影响旅行本身**。
 */
export function syncWorldbook(state) {
  try {
    const trip = state?.trip;
    // 老旅程没有 regionId → 用「当前装备决定的地区」补一次（近似，但比整趟不联动强）
    let regionId = String(trip?.regionId || '').trim();
    if (trip && !regionId) {
      try { regionId = regionOfEquipped(state)?.id || ''; } catch { /* 读不到就算了 */ }
    }
    // ★ 2026-10-13：**在家也要有世界设定** —— 原来不在途就返回空串 ⇒
    //   世界观插件那边"回到家 → 清空"，世界书里既没有庭院、也不知道她此刻在做什么。
    // ★★ 2026-10-24「庭院常时生效」：在途时**不能只写目的地**（那样"来处"就被顶掉了）——
    //   改成两段：`worldbookForRoot`（家/来处，常时）＋ `worldbookForTrip`（当趟）。
    //   ⚠️ 顺序固定"先家后目的地"：她读到的第一句永远是"我住在矩阵庭院"，
    //      不会以为自己是从挪威长出来的。也**别**调成先目的地 —— 那等于又顶一次。
    const want = trip
      ? [worldbookForRoot(state), worldbookForTrip({ ...trip, regionId })].filter(Boolean).join('\n')
      : worldbookForHome(state);
    if (want === lastWorldbook) return;              // 世界没变 → 不碰配置
    const skills = getConfig()?.skills || {};
    const current = skills[LIFE_SYSTEM_ID] && typeof skills[LIFE_SYSTEM_ID] === 'object'
      ? skills[LIFE_SYSTEM_ID]
      : {};
    // 浅合并该技能的配置段（与核心 setSkillConfig 同一写法：它也是先自己合并、再 updateConfig）
    updateConfig({ skills: { [LIFE_SYSTEM_ID]: { ...current, worldbook: want } } });
    lastWorldbook = want;
    log(`[travel-whale] 世界设定已同步：${want ? `「${String(want).slice(0, 24)}…」` : '（清空）'}`);
  } catch (error) {
    log(`[travel-whale] 同步世界设定失败：${error?.message ?? error}`);
  }
}

