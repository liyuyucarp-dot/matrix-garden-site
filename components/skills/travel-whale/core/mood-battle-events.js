// 矩阵庭院（travel-whale）· 模块化组件：core/mood-battle-events.js
// 职责：心情事件推送（含庭院总线广播）、异世界战斗掷骰与属地随机事件

import fs from 'node:fs';
import path from 'node:path';
import * as P from '../postcard.js?v=realworld-1';
import { capability, log } from './runtime-deps.js';
import { loadThemedRegions, onThemeChange } from './theme-pack.js';
import { skillOwned } from './skills-appointments.js';
import { SELF_DIR } from './world-sync.js';

// ── ★★ 2026-10-13「随机事件真正影响心情」──────────────────────────────────
// 用户口径："我希望那些随机事件能真正'影响'她的心情，而不是现在的'因为在旅行所以心情一直很好'
//   —— 太一刀切了 —— 遇到好事心情上升，遇到坏事心情下降。"
//
// 设计：**单向写、各自读**。本技能只把"这趟真发生了什么"记进**自己的存档** `state.moodEvents`；
//   sleep-mood（它本来就读我们的存档）轮询取走新事件、结算成心情，**游标存在它自己那边** ——
//   于是我们不必去写别人的心情存档（跨包写别人的文件 = 迟早互相覆盖，这是本项目的铁律）。
//
// ⚠️ 只记**真的发生了**的事（寄出稀有的那张、真打起来的那张、真穿越了）—— 不记"可能发生"的。
export const MOOD_EVENT_KINDS = {
  'rare-card': '寄回一张稀有的明信片',
  'battle-card': '在路上遭遇了敌手',           // 平手
  'battle-win': '在路上压退了敌手',             // 压制（v4.1）
  'battle-lose': '在路上吃了亏',               // 吃亏（v4.1）
  'event-good': '路上遇上了好事',               // v4.2 通用事件
  'event-bad': '路上遇上了麻烦事',               // v4.2 通用事件
  crossover: '被丢到了一个陌生的世界',
  'rare-souvenir': '带回了稀有特产',
  'trip-home': '平平安安回到了家',
  'home-photo': '在庭院里和大家拍了张大合照',
  flop: '这张明信片答非所问、翻了车',
  // ★★ 2026-10-14 特产出口（吃 / 送 / 种）—— 这是「特产不再是纯收藏品」的第一批事件。
  //   ⚠️ 加 kind **必须两边同时改**：这里 + sleep-mood 的 `lib/travel-sync.js` 的 `TRAVEL_EVENT_MOOD`。
  //     只改一边 = 事件写进了存档但**没人认**（sleep-mood 按表过滤，未知 kind 静默忽略）。
  'souvenir-eat': '把带回来的特产吃掉了',
  'souvenir-gift': '把带回来的特产送给了别人',
  'souvenir-plant': '把特产种进了菜地',
  'souvenir-harvest': '亲手种出了收成',
  // ★★ 2026-10-15「庭院活动也影响心情」：换活动落定时，带心情标注的条目推一条这个 kind
  //   （delta 随事件自带，见 refreshHomeAct）。⚠️ 加 kind 必须两边同时改（见上）。
  'home-act': '在庭院里做了一阵小事'
};

/** 这条事件是好事还是坏事（给日志/面板用；**真正的数值在 sleep-mood 那边**）。 */
export const MOOD_EVENT_TONE = {
  'rare-card': 'good', 'rare-souvenir': 'good', 'trip-home': 'good', 'home-photo': 'good',
  'battle-card': 'bad', 'battle-win': 'good', 'battle-lose': 'bad', crossover: 'bad', flop: 'bad',
  'event-good': 'good', 'event-bad': 'bad',
  'souvenir-eat': 'good', 'souvenir-gift': 'good', 'souvenir-plant': 'good', 'souvenir-harvest': 'good'
};

/**
 * 记一条"影响心情的事件"。
 * ⚠️ **同一毫秒内可能连推两条**（一张卡既稀有又是遭遇战）⇒ id = `时间戳 + 自增序号`，
 *    不能只用时间戳（sleep-mood 那边按 (at, id) 去重，只用时间戳会漏掉一条）。
 */
export function pushMoodEvent(state, kind, extra = {}) {
  const k = String(kind || '');
  if (!state || !k || !MOOD_EVENT_KINDS[k]) return null;
  const list = Array.isArray(state.moodEvents) ? state.moodEvents : (state.moodEvents = []);
  const now = Date.now();
  const seq = (Number(state.moodEventSeq) || 0) + 1;
  state.moodEventSeq = seq;
  const ev = { id: `me_${now.toString(36)}_${seq}`, at: now, kind: k, ...extra };
  list.push(ev);
  if (list.length > 60) list.splice(0, list.length - 60);   // 只留最近 60 条（存档别无限涨）

  // ★ 2026-10-25：入档的同时广播到 courtyard.bus。
  //   背景：plugins/sleep-mood 早就订阅了 'whale:trip.event' / 'whale:souvenir.eaten'
  //   （见它 index.js 的 bus.subscribe），但**此前没有任何发布方** —— 那条通道一直是死的，
  //   旅途事件得等 sleep-mood 下一轮 60s 心跳才结算成元气/心境。
  //
  //   ⚠️ 为什么要延到下一个宏任务：调用方是在 push 之后才 `S.saveState(state)`（同步写盘），
  //      而订阅方读的是**文件**。立刻 publish 会让它读到还没落盘的旧存档（白跑一趟）。
  //      setTimeout(0) 排在整个同步调用栈之后，正好落在 saveState 之后。
  //      万一某条路径是先 await 再存盘，订阅方也只会"这轮没看到"——它自己的 60s 轮询
  //      仍是兜底，事件不会丢（游标按 (at,id) 去重，重复交付无害）。
  try {
    const payload = {
      id: ev.id,
      at: ev.at,
      kind: k,
      tone: MOOD_EVENT_TONE[k] || '',
      where: String((extra && extra.where) || ''),
      foe: String((extra && extra.foe) || ''),
      n: Number((extra && extra.n) || 0),
      who: String((extra && extra.who) || '')
    };
    const topic = k === 'souvenir-eat' ? 'whale:souvenir.eaten' : 'whale:trip.event';
    setTimeout(() => {
      try { capability('courtyard.bus')?.publish?.(topic, payload); } catch { /* 总线不在就算了 */ }
    }, 0);
  } catch { /* 广播失败绝不能影响事件入档 */ }

  return ev;
}

/**
 * ★★ v4.1：这一趟**有没有遭遇**、以及**结果是什么**。
 *
 * 两次独立掷骰（用户特别问过这一点）：
 *   ① 有没有遇到：`ENCOUNTER_CHANCE`（异世界 0.55 / 现实 0）；
 *   ② 结果：基础 压制 0.40 / 平手 0.40 / 吃亏 0.20，再由**战斗技能**移动胜率。
 * 如果两次用同一个随机数，结果就会跟"抽到哪条构图"绑死 —— 那就成了"抽到必赢/必输"。
 *
 * 技能修正（只在事件里生效，面板上不显示"战力"）：
 *   · 浮游炮协同 `funnel`      +0.08 压制
 *   · 弹幕掉落 `danmaku-drop`  +0.05 压制
 *   · 数据护盾 `data-shield`   −0.08 吃亏
 *   · 幽灵特工 `ghost-agent`   −0.08 吃亏
 *   · 骨灰召唤 `ash-summon`    每趟一次：把"吃亏"改成"平手"
 * @returns {{outcome:'win'|'draw'|'lose', chance:number}|null}
 */
export function rollBattle(state, plan, rand = Math.random) {
  const foe = String(plan?.foe || '').trim();
  if (!foe) return null;                                   // 现实地区没有敌手
  if (rand() > 0.55) return null;                          // ① 有没有遇到
  const owned = skillOwned(state);
  let win = 0.40;
  let lose = 0.20;
  if (owned['funnel']) win += 0.08;
  if (owned['danmaku-drop']) win += 0.05;
  if (owned['data-shield']) lose -= 0.08;
  if (owned['ghost-agent']) lose -= 0.08;
  win = Math.min(0.75, Math.max(0.10, win));
  lose = Math.min(0.45, Math.max(0.05, lose));
  if (win + lose > 0.9) lose = Math.max(0.05, 0.9 - win);
  // ② 独立掷结果
  const r = rand();
  let outcome = r < win ? 'win' : (r < win + (1 - win - lose) ? 'draw' : 'lose');
  // 骨灰召唤：每趟挡掉一次吃亏
  if (outcome === 'lose' && owned['ash-summon']) outcome = 'draw';
  return { outcome, chance: Number(win.toFixed(2)) };
}

/**
 * ★★ 2026-10-18 v4.2「事件」：把 foe 那套抽象成通用事件 ——
 * **锁构图 / 告诉她发生了什么 / 影响心情 / 产生后果**。foe 只是其中一种（有对手的战斗），
 * 走自己的强度（0.55），事件默认整趟 0.28（约一半）。
 *
 * 与 foe 的差别（用户口径）：
 *   · foe：**一趟最多一次**，锁定一张卡；
 *   · 事件：**一趟可以多个** —— 每张途中卡独立掷，单卡概率 = `eventTripP / 途中卡数`，
 *     所以"出几个"会变，但"整趟至少出一个"的总概率稳定在 ~28%。
 * ⚠️ 已经有遭遇战的卡不再叠事件（一张卡只讲一件事）。
 */
export const EVENTS_FILE = () => path.join(SELF_DIR, 'data', 'events.json');
let _events = null;
export function loadEvents() {
  if (_events) return _events;
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_FILE(), 'utf8'));
    _events = Array.isArray(raw?.events) ? raw.events : [];
    _eventsP = Number(raw?.eventTripP) > 0 ? Number(raw.eventTripP) : 0.28;
  } catch (error) {
    log(`[travel-whale] 事件表读取失败（不启用）：${error?.message ?? error}`);
    _events = [];
  }
  return _events;
}
let _eventsP = 0.28;

// ── ★ 2026-10-19 v4.3「事件认属地」────────────────────────────────────────
// 症状：在【战锤40K·网道】这种走廊空间里抽到了「赶上节庆（街上挂满灯，摊子摆到路口）」。
// 原因：`eventsFor()` 只按 where(fiction/real) + phase 过滤，**完全不看这是个什么地方**。
// 解法：事件侧写 `places`（能发生在哪类地方），地区侧写 `placeTags`/`cityTags`（这是
//   哪类地方），两边**求交集**。词表只有 4 个词，故意做小：
//     settlement 聚居地/街道市集 · wild 野外自然 · corridor 通道/室内/封闭结构 · void 虚空/宇宙
// ★ 向后兼容是第一原则：
//   · 事件没有 `places`（旧数据）        ⇒ 任何地方都能抽；
//   · 国家没有 `placeTags`/`cityTags`（旧数据）⇒ **完全跳过属地过滤**，出事件概率一个不差；
//   · 地区/国家查不到（老旅程、脏数据）  ⇒ 同样跳过过滤，绝不抛错。
export const PLACE_TAGS = ['settlement', 'wild', 'corridor', 'void'];

/** 属地表：Map<regionId, Map<国家名, { placeTags: string[], cityTags: Map<城市名, string[]> }>>。 */
let _placeIndex = null;
let _placeIndexWarned = false;

/** 归一化查表键：吃掉空白/零宽（regions.json 里存在"廷根 周边"这类拼接痕迹）。 */
export function placeKeyOf(value) {
  return String(value ?? '').replace(/[\s\u200b\ufeff]/g, '');
}

/** 只保留 4 词表里的标签（写错的标签丢弃，不让它把事件池意外清空）。 */
export function cleanPlaceTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const tag = String(item ?? '').trim();
    if (tag && PLACE_TAGS.includes(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 从 `cities` 里取城市名（兼容 `"布鲁姆"` 与 `{ name: "布鲁姆" }` 两种写法）。 */
export function cityNameOf(city) {
  if (typeof city === 'string') return city;
  if (city && typeof city === 'object') return String(city.name ?? '');
  return '';
}

/**
 * 读 `regions.json` 的属地表（lazy + module 级缓存，73KB 表每趟都会用到，不能反复 parse）。
 *
 * ⚠️ **必须自己 `fs` 读盘，不能借用 `trip.js` 的 `loadRegions()`**（2026-10-21 实测踩过）：
 *   `trip.js:47` 的 `_regions` 是 **module 级缓存**，第一次读盘后再不刷新；
 *   而技能热重载只给**入口** `index.js` 加时间戳（`plugin-loader.js:849` 的 `import(entryUrl + '?t=')`），
 *   本文件里静态 `import ... from './trip.js'` 仍然命中 ESM 缓存里的**旧 trip.js 实例**
 *   ⇒ 它手里是"打补丁之前的 regions.json" ⇒ `placeTags` 永远读不到 ⇒ 过滤被静默跳过
 *   ⇒ 补丁等于没装（数据改了、代码改了、效果为零）。
 *   自己读盘就没事：`_placeIndex` 是**本模块**的缓存，模块随热重载整体重建，改表即生效，不用重启 App。
 *   ⚠️ 也不要"fs 失败再退 `T.loadRegions()`"——两个数据源混用会让"改了哪张表"变成谜，只留一条路。
 *
 * 读失败/解析失败：`log()` 一条（只报一次）并降级成空表（= 全部跳过属地过滤），绝不能让出发流程挂掉。
 */
export function loadPlaceIndex() {
  if (_placeIndex) return _placeIndex;
  const index = new Map();
  try {
    // 走 loadThemedRegions，使晋升后的主题大区（如 azeroth_ek）也具备完整 placeTags / cityTags
    const regions = loadThemedRegions();
    for (const region of Array.isArray(regions) ? regions : []) {
      const rid = String(region?.id ?? '');
      if (!rid) continue;
      const byName = new Map();
      for (const country of Array.isArray(region?.countries) ? region.countries : []) {
        const name = String(country?.name ?? '');
        if (!name) continue;
        const placeTags = cleanPlaceTags(country?.placeTags);
        const cityTags = new Map();
        const rawCityTags = country?.cityTags;
        if (rawCityTags && typeof rawCityTags === 'object' && !Array.isArray(rawCityTags)) {
          // 城市级覆盖：键盘上带空格/零宽的别名也收进来，查的时候两种键都试
          for (const cityName of Object.keys(rawCityTags)) {
            const tags = cleanPlaceTags(rawCityTags[cityName]);
            if (!tags.length) continue;
            cityTags.set(String(cityName), tags);
            cityTags.set(placeKeyOf(cityName), tags);
          }
          // 顺手把 `cities` 里同名的写法也登记上（"科摩罗" 与 " 科摩罗" 都能命中）
          for (const city of Array.isArray(country?.cities) ? country.cities : []) {
            const cityName = cityNameOf(city);
            const tags = cityTags.get(placeKeyOf(cityName));
            if (cityName && tags) cityTags.set(cityName, tags);
          }
        }
        if (!placeTags.length && !cityTags.size) continue;      // 没打标签 ⇒ 这个国家根本不参与属地过滤
        const entry = { placeTags, cityTags };
        byName.set(name, entry);
        byName.set(placeKeyOf(name), entry);
      }
      if (byName.size) index.set(rid, byName);
    }
  } catch (error) {
    if (!_placeIndexWarned) {
      _placeIndexWarned = true;
      log(`[travel-whale] 属地表读取失败（事件不按属地过滤）：${error?.message ?? error}`);
    }
    index.clear();                                            // 降级：空表 = 不过滤
  }
  _placeIndex = index;
  return _placeIndex;
}
onThemeChange(() => {
  _placeIndex = null;
});

/**
 * 这一趟的属地标签。返回 `[]` 表示**不按属地过滤**（旧数据/查不到/没打标签）。
 * `plan.city` 有 cityTags 覆盖时优先用城市级标签，否则退回国家级 `placeTags`。
 *
 * ★ 为什么要拿城市名当国家名再查一次：虚构地区允许**"条目自身就是目的地"**
 *   （`trip.js#allCitiesOf` → `{ city: '亚空间', country: '' }`，见那里的注释），
 *   这时 `plan.country` 是空串、`plan.city` 才是地区表里的那一条。
 *   不补这一层，「亚空间」这种没有下级地名的星球就永远查不到标签 ⇒ 属地过滤等于白装。
 */
export function placeTagsFor(plan) {
  try {
    const rid = String(plan?.region ?? '');
    if (!rid) return [];
    const byName = loadPlaceIndex().get(rid);
    if (!byName) return [];
    const countryName = cityNameOf(plan?.country);
    const cityName = cityNameOf(plan?.city);
    // ① 正常情况：按「国家/星球」查
    let entry = countryName ? (byName.get(countryName) || byName.get(placeKeyOf(countryName))) : null;
    // ② 兜底：没有国家这一层时，把城市名当国家名再查（星球/据点级目的地）
    if (!entry && cityName) entry = byName.get(cityName) || byName.get(placeKeyOf(cityName));
    if (!entry) return [];
    // ③ 城市级覆盖：`cityTags` 命中就用它，没命中退回国家级 placeTags
    if (cityName && entry.cityTags.size) {
      const hit = entry.cityTags.get(cityName) || entry.cityTags.get(placeKeyOf(cityName));
      if (Array.isArray(hit) && hit.length) return hit;
    }
    return entry.placeTags;
  } catch (error) {
    log(`[travel-whale] 属地标签查表失败（本趟不按属地过滤）：${error?.message ?? error}`);
    return [];
  }
}

/** 这一趟能触发哪些事件（地区类型 + 相位 + 属地）。 */
export function eventsFor(plan) {
  const list = loadEvents();
  if (!list.length) return [];
  const fic = plan?.regionFictional === true;
  const phaseName = String(plan?.phase?.name || '');
  // 属地标签：空数组 = 该国家没打标签（或查不到）⇒ 完全跳过属地过滤，老数据照旧
  const tags = placeTagsFor(plan);
  const pool = list.filter((e) => {
    if (e.where === 'fiction' && !fic) return false;
    if (e.where === 'real' && fic) return false;
    if (Array.isArray(e.phase) && e.phase.length && !e.phase.includes(phaseName)) return false;
    if (!tags.length) return true;                          // 没标签 ⇒ 通用，任何地方都能抽
    const places = Array.isArray(e.places) ? e.places : [];
    if (!places.length) return true;                        // 事件没写 places ⇒ 通用事件
    return places.some((p) => tags.includes(String(p)));
  });
  log(`[travel-whale] 事件池 ${pool.length}/${list.length} 条（place=${tags.join('+') || '不限'}）`);
  return pool;
}

/** 给每张途中卡独立掷一次（遭遇战那张不叠）。返回实际挂上去的事件数。 */
export function rollEvents(state, plan, rand = Math.random) {
  const pool = eventsFor(plan);
  const cards = Array.isArray(plan?.cardPlan) ? plan.cardPlan : [];
  const mid = Math.max(0, cards.length - 1);            // 末位是到家卡
  if (!pool.length || mid <= 0) return 0;
  const p = Math.max(0.02, Math.min(0.35, _eventsP / mid));
  let n = 0;
  for (let i = 0; i < mid; i += 1) {
    if (cards[i].battleOutcome) continue;               // 这张已经是遭遇战
    if (rand() > p) continue;
    const last = String(state?.lastEventId || '');
    const pickable = pool.length > 1 ? pool.filter((e) => e.id !== last) : pool;
    const ev = pickable[Math.floor(rand() * pickable.length)] || pool[0];
    cards[i].event = { id: ev.id, kind: ev.kind, name: ev.name, line: ev.line, fusion: ev.fusion, mood: ev.mood, effect: ev.effect };
    state.lastEventId = ev.id;
    n += 1;
  }
  return n;
}

export function appendExtraCard(plan, opts = {}) {
  if (!plan) return 0;
  const times = Array.isArray(plan.cardTimes) ? plan.cardTimes : (plan.cardTimes = []);
  const cards = Array.isArray(plan.cardPlan) ? plan.cardPlan : (plan.cardPlan = []);
  const returnAt = Number(plan.returnAt) || 0;
  if (!returnAt || !cards.length) return 0;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;

  // 战斗卡必须**显式指定**成战斗构图 —— 否则 composePostcard 按全池随机，根本抽不中
  let fusion = '';
  if (opts.battle !== false) {
    const foe = String(plan.foe || '').trim();
    if (!foe) return 0;                                   // 不是异世界 ⇒ 不惹事
    // 「新入口 + 旧 postcard.js」时没有这个导出 ⇒ 静默跳过（安全降级，不让整个出发挂掉）
    if (typeof P.pickBattleFusion !== 'function') return 0;
    // ⚠️ 小魔王一定是**有人陪同**出门（她要么陪鲸鱼、要么跟另一位伙伴），所以固定用"两位少女"
    fusion = P.pickBattleFusion(rand, foe, plan.regionName || plan.region || '', plan.foeLook || '', true);
    if (!fusion) return 0;
  }

  const spots = Array.isArray(plan.spots) ? plan.spots : [];
  const lastSpot = spots.length ? String(spots[spots.length - 1]?.name || '') : '';
  const lastT = times.length ? Number(times[times.length - 1]) : (Number(plan.departAt) || returnAt - 3600000);
  // 排在"最后一张途中卡"与"到家卡"之间（偏后一点），保证时间递增、且不越过到家时刻
  // ★ 2026-10-13 晚：同一次出发可能**连着加卡**（小魔王的「挑衅」= 两张战斗明信片）——
  //   第二次按同一个公式算出来的时刻会越过到家时刻 ⇒ 卡会排在"到家之后"（时间倒挂）。
  //   钳住它，并保证时间**严格递增**（插卡口径见 MEMORY-2 §66）。
  const rawAt = Math.round(lastT + Math.max(60000, (returnAt - lastT) * 0.6));
  const at = Math.max(lastT + 1000, Math.min(rawAt, Math.round(returnAt - 60000)));
  if (at >= returnAt) return 0;
  times.push(at);
  const entry = { at, kind: 'spot', spot: lastSpot, scene: '', isReturn: false, rarity: 'common' };
  if (fusion) { entry.fusion = fusion; entry.rage = true; }
  cards.splice(cards.length - 1, 0, entry);               // ★ 插在"到家卡"之前
  plan.cardCount = times.length;
  return at;
}

