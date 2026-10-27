// 矩阵庭院（travel-whale）· 模块化组件：core/pantry-farm.js
// 职责：特产图鉴查找、吃/送犹豫闸门、菜地种植/收获/收成配图与商店/菜地文本渲染

import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as HM from '../home.js';
import * as SV from '../souvenir.js';
import { REWARD_RARE_SOUVENIR, buildDeps, cfg, log } from './runtime-deps.js';
import { companionEmoji, companionOf, companionTraitText } from './companions-voice.js';
import { pushMoodEvent } from './mood-battle-events.js';
import { ownedCompanionIds, pendingCompanionOf, pendingReasonText } from './skills-appointments.js';
import { isRegionUnlocked, isRegionVisible, sideTripsOf } from './world-sync.js';
import { sayImage } from './broadcast.js';
import { EQUIP_PRICE, LOCAL_ONLY, shopTable } from './shop-album-menu.js';

/**
 * 按名字找一件特产（**精确优先，其次包含**）。
 * 为什么允许包含：群友说"把那个冰淇淋吃了"多半不会报全名。
 * 多个命中时取**存量最多**的那件（至少"能吃到"），并把候选带出去让调用方提示一句。
 * ⚠️ 自造名（图鉴里没有的）一律找不到 ⇒ 调用方会回"图鉴里没有"，不会静默成功。
 */
export function findSouvenir(state, query) {
  const q = String(query || '').trim();
  const all = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  if (!q) return { entry: null, ambiguous: [] };
  const exact = all.find((e) => String(e.name) === q);
  if (exact) return { entry: exact, ambiguous: [] };
  const hits = all.filter((e) => String(e.name).includes(q) || q.includes(String(e.name)));
  if (!hits.length) return { entry: null, ambiguous: [] };
  if (hits.length === 1) return { entry: hits[0], ambiguous: [] };
  hits.sort((a, b) => S.souvenirStock(b) - S.souvenirStock(a));
  return { entry: hits[0], ambiguous: hits };
}

/**
 * 特产图鉴正文（「看图鉴」用；离线探针也直接打它）。
 * ★ 这一页是"特产第一次有出口"之后才存在的 —— 在此之前，特产只挤在「看相册」里的一行
 *   （而且**只列前 12 件**，超过就静默截断 —— 现在 15 件，已经有一部分看不见了）。
 */
export function pantryText(state) {
  const list = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  if (!list.length) return '🎁 特产图鉴还是空的 —— 她出门一趟就会带东西回来。';
  const ORDER = { rare: 0, uncommon: 1, common: 2 };
  const sorted = [...list].sort((a, b) => (ORDER[a.rarity] ?? 2) - (ORDER[b.rarity] ?? 2)
    || String(a.name).localeCompare(String(b.name), 'zh'));
  const total = list.reduce((n, e) => n + S.souvenirStock(e), 0);
  const out = [`🎁 特产图鉴 ${list.length} 件（手上还有 ${total} 份）`];
  for (const e of sorted) {
    const tag = SV.canPlant(e) ? '🌱能种' : (SV.canEat(e) ? '🍽️能吃' : '📦收着');
    const hist = [];
    if (Number(e.eaten) > 0) hist.push(`吃过${e.eaten}`);
    if (Number(e.giftedCount) > 0) hist.push(`送过${e.giftedCount}`);
    if (Number(e.planted) > 0) hist.push(`种过${e.planted}`);
    out.push(`  ${SV.rarityMark(e.rarity)} ${e.name}［${e.city || e.country || '？'}］${tag}`
      + `${SV.stockTag(e)}${hist.length ? `　${hist.join('·')}` : ''}`);
  }
  // ★★ 三档**必须是真划分**（能种 > 能吃 > 只能收着），与每条行首的标签逐字同规则。
  //   第一版 `canEat` / `canPlant` 各数一次 ⇒ 既好吃又能种的（神之麦、绝云椒椒…）**数了两遍**，
  //   真档 15 件会印成"能吃 8 · 能种 4 · 只能收着 6"= 18 —— 跟上面列的 15 行对不上。
  const plantN = list.filter((e) => SV.canPlant(e)).length;
  const eatN = list.filter((e) => SV.canEat(e) && !SV.canPlant(e)).length;
  const keepN = list.filter((e) => !SV.canEat(e) && !SV.canPlant(e)).length;
  out.push(`🧺 能种 ${plantN} 件 · 能吃 ${eatN} 件 · 只能收着 ${keepN} 件`
    + `（按"能做什么"分，合计 ${list.length} 件：既好吃又能种的只算「能种」）`);
  // ★ 2026-10-26：稀有特产**存着图**这件事必须让人知道，否则图还是等于不存在
  const pictured = list.filter((e) => e.rarity === 'rare' && e.image).length;
  if (pictured) out.push(`🖼️ 其中 ${pictured} 件稀有特产存着图 —— 说「看图鉴里的 某某」就能发那一张原图。`);
  out.push('', '说「吃掉 XX」「把 XX 送给谁」「种下 XX」都行 —— 每用一次消耗 1 份，图鉴不会因此被清掉。');
  return out.join('\n');
}

/**
 * 「犹豫闸」的有效期 —— 超过这么久没再提，就当没说过（下次会重新犹豫一次）。
 * 10 分钟：够群里接一句话，又不至于"隔天说一次"被当成确认。
 */
export const HESITATE_MS = 10 * 60 * 1000;

/**
 * 消耗前的「犹豫闸」—— **吃 / 送共用这一处**
 * （用户："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"＋"赠送也一样加闸"）。
 *
 * 返回 `{ pass: true }` = 放行（顺手清掉待确认）；否则**写下来**，由调用方回一句各自的犹豫台词。
 * 三个条件同时满足才算"确认"：**同一件事（`key`）＋ 在窗口内 ＋ 不是同一个唤醒会话（`sid`）**。
 * ⚠️ 最后那条是关键：否则模型能在**同一轮里连调两次**、自己把自己确认掉，闸就白装了。
 *   `sid` 拿不到时退回"只看 key + 窗口"（安全降级：最坏情况是模型同轮连调也能执行）。
 *
 * @param {string} kind 'eat' | 'gift'
 * @param {string} key  判定"是不是同一件事"：吃 = 件名；送 = 件名 + 收礼人
 */
export function hesitateGate(state, kind, key, { sid = '', now = Date.now() } = {}) {
  const h = state.useHesitate;
  const same = Boolean(h) && String(h.kind) === kind && String(h.key) === key;
  const inWindow = same && (Number(now) - Number(h.at || 0)) < HESITATE_MS;
  const otherTurn = same && (!sid || !h.sid || String(h.sid) !== String(sid));
  if (inWindow && otherTurn) {
    state.useHesitate = null;                  // 这次确认用掉了
    return { pass: true };
  }
  state.useHesitate = { kind, key, at: Number(now), sid: String(sid || '') };
  return { pass: false };
}

/**
 * 吃掉一件特产（**就地改 state**）。
 *
 * ★★ 2026-10-14「犹豫闸」（用户："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"）：
 *   **第一次调用不扣存量**，只记下 `state.eatHesitate` 并回一句犹豫；**换一轮再说一次**才真吃。
 *   · 确认条件 = 同名 ＋ 在窗口内 ＋ **不是同一个唤醒会话**（`sid`）。
 *     最后那条是关键：否则模型能在**同一轮里连调两次**、自己把自己确认掉，闸就白装了。
 *   · `sid` 拿不到时退回"只看同名 + 窗口"（安全降级：最坏情况是模型同轮连调也能吃掉）。
 *   · 犹豫**不推心情事件** —— 还没吃，不该有"吃到东西"的那点满足。
 *
 * 为什么逻辑抽在这里、而不是写在工具里：工具体要 `ctx` 与注册表，离线探针造不出来；
 * 抽成纯函数之后，探针可以直接打"犹豫 → 确认 → 扣存量 → 记次数 → 推心情"这一整串。
 * @returns {{ok:boolean, hesitate?:boolean, reason?:string, line?:string, left?:number, entry?:object}}
 */
export function eatSouvenir(state, name, { by = '', sid = '', now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  if (!SV.canEat(entry)) {
    return { ok: false, reason: `「${entry.name}」不能吃 —— 它是${SV.KIND_NAMES[SV.kindOf(entry)]}的那一类。` };
  }
  // ⚠️ 存量检查要放在**犹豫闸之前**：都没得吃了还让她"诶，真要吃吗"很怪。
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」已经吃完了 —— 等她下次再带一份回来，或者种一棵出来。` };
  }
  // ── 犹豫闸：先让她舍不得一下（吃 / 送共用 `hesitateGate`）──
  if (!hesitateGate(state, 'eat', String(entry.name), { sid, now }).pass) {
    return { ok: false, hesitate: true, line: SV.hesitateLine(entry), entry };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」已经吃完了 —— 等她下次再带一份回来，或者种一棵出来。` };
  S.recordEat(state, entry.name);
  // ★★ v3.7「刚吃完」的余味：写一条 `state.foodAfter`，由 sleep-mood **只读**它拼提示词
  //   （用户："像'你现在刚醒'一样，给一个'你现在刚吃完 xxx'的状态"）。
  //   时长按稀有度 5 / 15 / 30 分钟；**过期只在读侧判**，这里不清理。
  state.foodAfter = SV.foodAfterOf(entry, now);
  pushMoodEvent(state, 'souvenir-eat', { where: String(entry.city || '') });
  return { ok: true, line: SV.eatLine(entry, { by }), left: c.left, entry };
}

/** 送出一件特产（**就地改 state**）。说明见 `eatSouvenir`。 */
export function giftSouvenir(state, name, { to = '', sid = '', now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  const who = String(to || '').trim();
  if (!who) return { ok: false, reason: '得说要送给谁。' };
  // ⚠️ 存量检查放在闸之前 —— 已经送光的东西不该还问一句"真要送吗"。
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」已经送光了 —— 等她下次再带一份回来，或者种一棵出来。` };
  }
  // ── 犹豫闸（用户："赠送也一样加闸"）。
  //   ★ key **只用件名**、不带收礼人 —— 她犹豫的是"要不要把东西给出去"，不是"给谁"。
  //     带收礼人会出真问题：待确认只存得下一条，群里改口换个收礼人就会把它覆盖掉、
  //     于是"改口"反而绕过了闸（第一版就是这么写的，探针当场抓到）。
  if (!hesitateGate(state, 'gift', String(entry.name), { sid, now }).pass) {
    return { ok: false, hesitate: true, line: SV.giftHesitateLine(entry, { who }), entry, who };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」已经送光了 —— 等她下次再带一份回来，或者种一棵出来。` };
  S.recordGift(state, { name: entry.name, userId: who, userName: who });
  pushMoodEvent(state, 'souvenir-gift', { where: String(entry.city || '') });
  return { ok: true, line: SV.giftLine(entry, { who, city: String(entry.city || '') }), left: c.left, entry };
}

// ── ★★ 2026-10-14 菜地（种菜）────────────────────────────────────────────
//   用户口径：请过千问 ⇒ **永久解锁**；默认 3 块地；普通/非普通 3 天、稀有 5 天；
//   **稀有也能种**（产出更少）；收获时**只有稀有作物给 TOKEN**
//   —— 对齐现状"只有稀有特产带回来给 50 亿/件"，普通作物带回来本来也不给钱。
//
//   ★ 反馈感的关键落在 `farmTick()`：一次收成 = **四天里四条播报 + 最后一份实收**，
//     而不是"种下去、三天后突然冒出来"。

// ── ★★ v3.2：旅伴「特色」的**字段判据**（一处一处都改成现读表，不写死 id）─────────
//   为什么必须改成字段：`qwenAtHome()` 原来直接比 `id === 'qwen'`，`appointCompanion()` 里
//   也是 `comp.id === 'qwen'` —— 加一位新旅伴、或者想把这套能力换给别人，就得满文件找 id。
//   现在的口径：**能力写在 `COMPANIONS` 的定义上**（`farmHelper` / `noteSouvenirs` / `harvestBonus`），
//   判据只认字段。⇒ 换人只改表一行。
//   ⚠️ 热载期间 `S.COMPANIONS` 可能是旧表（没有这些字段）⇒ 一律 `Boolean(undefined) === false`，
//     即"新特性静默未生效"，不会抛错（本项目对热载窗口的一贯做法）。

/** 这位旅伴的定义上有没有某个布尔特性。 */
export const compFlag = (def, key) => Boolean(def && def[key] === true);

/** 她的定义里有没有「开地/种菜」那套加成（现在是千问）。 */
export const isFarmHelper = (def) => compFlag(def, 'farmHelper');

/** 她的定义里有没有「给特产写批注」（现在是小月亮）。 */
export const notesSouvenirs = (def) => compFlag(def, 'noteSouvenirs');

/**
 * 同行的那位此刻是不是**在庭院里**（她在家 ⇒ 她那套庭院加成生效）。
 * @param {object} state
 * @param {(def:object)=>boolean} pred 判"这位是不是我们要找的人"
 */
export function companionAtHome(state, pred) {
  const def = (S.COMPANIONS || {})[String(state?.companion?.id || '')];
  if (!def || !pred(def)) return null;
  if (state?.trip) return null;                                    // 鲸鱼在路上 ⇒ 旅伴也跟着出门了
  const away = new Set(sideTripsOf(state).flatMap((t) => (t.partners || []).map(String)));
  return away.has(String(def.id)) ? null : def;
}

/** 「开地的那位」此刻在不在庭院（⇒ 多一块地、长得快一点）。 */
export function qwenAtHome(state) {
  return Boolean(companionAtHome(state, isFarmHelper));
}

/**
 * 此刻的**收成加成份数**（Kimi「博闻」：她记得哪一株长得最好，掐的时间准）。
 * ⚠️ 口径与开地一致：**只有她在庭院时才算**（她跟着出门了就没有这条加成）。
 */
export function harvestBonusNow(state) {
  const def = companionAtHome(state, (d) => Number(d?.harvestBonus) > 0);
  return def ? Math.max(0, Number(def.harvestBonus) || 0) : 0;
}

/**
 * 这块地现在能种几株。
 * ★★ 2026-10-14 改：**不再看"她在不在家"** —— 上限只由 `state.farmUnlocked` 决定
 *   （请过"开地那位" ⇒ 永久 4 块）。原来把它做成"她在庭院时才 +1"，
 *   于是她一出门上限就掉回 3 ⇒ 面板显示"4/3 块"，那块地上的东西既没消失、又不让再种
 *   （用户原话："她要是出门了那块地就凭空消失吗，上面的特产呢？"）。
 * ⚠️ 仍然保留 `Math.max(..., 已种株数)` 这层兜底：老存档里可能已经种了 4 株，
 *   任何情况下都不该显示出"4/3"（显示口径要么并上去、要么说清楚）。
 */
export function farmCapNow(state) {
  const cap = (typeof S.farmCapOf === 'function') ? S.farmCapOf(state) : 3;
  const planted = Array.isArray(state?.farm) ? state.farm.length : 0;
  return Math.max(1, cap, planted);
}

/**
 * 把一件可种植的特产**种下去**（就地改 state）。
 *
 * ⚠️ **种下不走犹豫闸** —— 它和"吃 / 送"不一样：东西没有消失，是变成了一株会长出更多份的作物。
 *   那是投资，不是消费；让她在投资前也"舍不得"会显得没道理。
 *
 * @returns {{ok:boolean, reason?:string, line?:string, plot?:object, slots?:number, cap?:number}}
 */
export function plantSouvenir(state, name, { now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  if (!state.farmUnlocked) {
    return { ok: false, reason: '还没有菜地 —— 得先请千问（小折扇）来庭院，地是她开出来的。' };
  }
  if (!SV.canPlant(entry)) {
    return { ok: false, reason: `「${entry.name}」种不活 —— 它是${SV.KIND_NAMES[SV.kindOf(entry)]}的那一类。` };
  }
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」手上一份都没有了 —— 得等她再带一件回来。` };
  }
  const cap = farmCapNow(state);
  const list = Array.isArray(state.farm) ? state.farm : [];
  if (list.length >= cap) {
    return { ok: false, reason: `地里已经种满 ${cap} 株了 —— 先收一茬再说。` };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」没有存量了。` };
  entry.planted = (Number(entry.planted) || 0) + 1;
  const days = String(entry.rarity || '') === 'rare' ? S.FARM.daysRare : S.FARM.daysCommon;
  const plot = {
    id: `pl_${Number(now).toString(36)}_${list.length}`,
    name: entry.name,
    rarity: String(entry.rarity || 'common'),
    kind: SV.kindOf(entry),
    city: String(entry.city || ''),
    country: String(entry.country || ''),
    plantedAt: Number(now),
    stage: 0,
    // ⚠️ "开地那位"在不在庭院，**在种下那一刻定死**：之后她出门也不改倍率 ——
    //   否则"菜长到一半突然变慢"，玩家看到的是莫名其妙的倒退。
    //   ★ 2026-10-14：**地块上限**那半已经改成永久（见 `farmCapNow`）——
    //     浮动只保留在"种下这一刻的周期"上，它不会凭空多出/少掉任何东西。
    speed: qwenAtHome(state) ? S.FARM.helperSpeed : 1
  };
  state.farm = [...list, plot];
  pushMoodEvent(state, 'souvenir-plant', { where: String(entry.city || '') });
  return { ok: true, line: SV.plantLine(entry, days), plot, slots: state.farm.length, cap };
}

/** 找地里的某一株（按 id / 全名 / 关键词）。 */
export function findPlot(state, query) {
  const q = String(query || '').trim();
  const list = Array.isArray(state?.farm) ? state.farm : [];
  if (!q) return list[0] || null;
  return list.find((p) => String(p.id) === q)
    || list.find((p) => String(p.name) === q)
    || list.find((p) => String(p.name).includes(q))
    || null;
}

/**
 * 收一株（就地改 state）。
 * ★ **只有稀有作物给 TOKEN**（普通作物只多几份实物 —— 它们带回来本来也不给钱）。
 */
export function reapSouvenir(state, query, { now = Date.now() } = {}) {
  const plot = findPlot(state, query);
  if (!plot) return { ok: false, reason: '地里是空的 —— 先用「种下 某某」种一株。' };
  const last = S.FARM.stageCount - 1;
  const stage = S.farmStageOf(plot, now);
  if (stage < last) {
    const leftH = Math.max(1, Math.ceil(S.farmLeftMs(plot, now) / 3600000));
    return { ok: false, stage, reason: `「${plot.name}」还没熟（现在是「${SV.FARM_STAGE_NAMES[stage]}」，大约还要 ${leftH} 小时）。` };
  }
  // ★★ v3.2 旅伴「博闻」（Kimi）：她记得哪一株长得最好 ⇒ **她在庭院时收成 +1 份**。
  //   读的是表上的 `harvestBonus`（不写死 id）；她跟出门了就算 0。
  const bonus = harvestBonusNow(state);
  const base = Math.max(1, Number(S.FARM.yieldOf[plot.rarity]) || 1);
  const n = base + bonus;
  const got = S.grantSouvenirStock(state, plot.name, n);
  const rare = String(plot.rarity) === 'rare';
  // ★★ 2026-10-14 批 3：**收成计数必须记账** —— 收完这一株就从 `state.farm` 里删掉了
  //   （下一行就是），事后无从推算。故 "第一茬 / 地里常青 / 种出稀罕的" 三条称号全靠它
  //   （判据见 titles.js 的「特产」组；对比之下"吃过/送过"长在条目上，求和即可、还能追溯老档）。
  state.stats = (state.stats && typeof state.stats === 'object') ? state.stats : {};
  state.stats.harvests = (Number(state.stats.harvests) || 0) + 1;
  if (rare) state.stats.rareHarvests = (Number(state.stats.rareHarvests) || 0) + 1;
  const mult = Math.max(1, Number(state?.whale?.rareRewardMult) || 1);
  const token = rare ? n * REWARD_RARE_SOUVENIR * mult : 0;
  if (token > 0) S.grantPlankton(state, token);
  state.farm = (state.farm || []).filter((p) => p !== plot);
  pushMoodEvent(state, 'souvenir-harvest', { where: String(plot.city || '') });
  return { ok: true, line: SV.reapLine(plot, n), got, token, rare, plot };
}

/**
 * 收成图 —— **只在收获到稀有作物时**拍（用户口径："只在收获稀有作物时出图，
 * 用在场的人、菜地、庭院和特产"）。
 *
 * 人 = 此刻在家庭院的全部（`HM.homeMembers`，出门的自动剔掉）；背景 = 矩阵庭院 + 一小块菜畦。
 *
 * ⚠️ 失败策略与明信片 / 大合照一致：**生图失败也照发**（收成是既成事实，不能因为没图就不说）。
 *   而且这里**不需要"重试闸"** —— 收成是一次性动作，不像大合照那样每轮 tick 都可能重拍，
 *   失败就是这一次没图，不会刷屏。
 * ⚠️ `home.js` 是兄弟模块：`buildHarvestPrompt` 是这一版才加的 ⇒ 用 `typeof` 守卫，
 *   在"新入口 + 旧 home.js"的热载窗口里安静跳过（而不是抛错把整个收菜搞挂）。
 */
export async function shootHarvest(chatKey, state, crop, deps) {
  if (typeof HM.buildHarvestPrompt !== 'function' || typeof HM.homeMembers !== 'function') return false;
  const d = deps || buildDeps(chatKey, state);
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const members = HM.homeMembers(state);
  const style = (typeof HM.pickFarmStyle === 'function') ? HM.pickFarmStyle(rand) : '';
  const charStyle = (typeof P.pickCharacterStyle === 'function') ? P.pickCharacterStyle(rand) : '';
  const prompt = HM.buildHarvestPrompt({ members, crop, style, charStyle, rand });
  const size = String(cfg().homeShotSize || HM.HOME_SHOT_SIZE);
  try {
    const res = await d.imageGen(prompt, { size });
    if (res?.ok && Array.isArray(res.images) && res.images.length) {
      const file = await d.saveImage(res.images[0]);
      if (file) return await sayImage(chatKey, file, LOCAL_ONLY);
    }
  } catch (error) { log(`[travel-whale] 收成图生成失败（不影响收成本身）：${error?.message ?? error}`); }
  return false;
}

/**
 * 菜地的推进：**只负责"长了一档"和该播的那句话**（真正发消息由调用方做）。
 * 阶段纯靠时间差算 ⇒ 漏跑一天也不会丢档；`plot.stage` 记的是"上次播报到第几档"。
 * @returns {Array<{plot:object, stage:number, line:string}>}
 */
export function farmTick(state, now = Date.now()) {
  const out = [];
  for (const plot of Array.isArray(state?.farm) ? state.farm : []) {
    if (!plot || typeof plot !== 'object') continue;
    const stage = S.farmStageOf(plot, now);
    if (stage <= (Number(plot.stage) || 0)) continue;    // 这一档已经播过了
    plot.stage = stage;
    const line = SV.farmStageLine(plot, stage);
    if (line) out.push({ plot, stage, line });
  }
  return out;
}

/** 菜地面板（「看菜地」用；离线探针也直接打它）。 */
export function farmText(state) {
  const list = Array.isArray(state?.farm) ? state.farm : [];
  const cap = farmCapNow(state);
  if (!state?.farmUnlocked) {
    return '🌱 还没有菜地 —— 得先请**千问（小折扇）**来庭院：地是她开出来的，请过一次就永久有。';
  }
  if (!list.length) {
    return `🌱 菜地空着（0/${cap} 块）—— 说「种下 某某」就能种一株。`
      + '\n能种的条件：图鉴里那件被标成「能种」（说「看图鉴」看得到），且手上还剩至少 1 份。';
  }
  const now = Date.now();
  const last = S.FARM.stageCount - 1;
  const out = [`🌱 菜地 ${list.length}/${cap} 块`];
  for (const p of list) {
    const st = S.farmStageOf(p, now);
    const ripe = st >= last;
    const left = ripe ? '' : `（还要约 ${Math.max(1, Math.ceil(S.farmLeftMs(p, now) / 3600000))} 小时）`;
    out.push(`  ${ripe ? '✅ 可收' : '🌿'} ${p.name}［${SV.rarityMark(p.rarity)}${String(p.rarity)}］`
      + ` —— ${SV.FARM_STAGE_NAMES[st]}${left}`);
  }
  const ready = list.filter((p) => S.farmStageOf(p, now) >= last).length;
  out.push('', ready ? `有 ${ready} 株熟了 —— 说「收菜」。` : '都还没熟，等它长。');
  return out.join('\n');
}

/** 商店列表文本。 */
export function shopText(state) {
  S.restockIfDue(state);            // 打开商店时顺手结算一次，保证看到的是最新货架
  // ⚠️ 店名必须与 `help.js` 的 `MENUS.shop.title` **一致**（探针 `panel-flood-probe` 盯着这条）。
  const lines = ['🛒 豆包杂货铺', ''];
  for (const [key, it] of Object.entries(shopTable())) {
    const left = Number(state.shop?.stock?.[key]);
    const have = Number(state.bag?.[it.kind]?.[it.id]) || 0;
    // ★ 2026-10-13：`unlimited` 的道具不显示"货架 N"（它压根不占货架）。
    //   ⚠️ 加急明信片**已不再是 unlimited**（改成正常库存 `stock: 1`，见 `shopTable()`）——
    //   所以商店里它会正常显示「货架 1 / 货架 0」，这正是用户要的口径。
    const stockText = it.unlimited ? '不限量' : `货架 ${Number.isFinite(left) ? left : it.stock}`;
    lines.push(`${it.name}（${it.price} 亿 TOKEN）— ${it.desc}｜${stockText}｜你已有 ${have}`);
  }
  // ★★ 2026-10-15「探索解锁」：**只列"已发现"的** —— 还没发现的世界连名字都不出现
  //   （这就是用户要的"探索感"）。于是这一行同时排掉两类：
  //     · 已买（`isRegionUnlocked`）⇒ 没必要再列；
  //     · 还没发现（`!isEquipBuyable`）⇒ 剧透了就不好玩了。
  //   ⚠️ `isEquipBuyable` 是 state.js 的**新导出** ⇒ 热载期必须 `typeof` 包装
  //      （旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致）。
  //   ⚠️ 老档兼容在 `loadState` 里把 `equipBuyable` 补成"全部异世界" ⇒ 老玩家看到的
  //      列表与从前**完全一样**，不会突然少几行。
  const locked = T.loadRegions().filter((r) => Boolean(r?.equipment) && !isRegionUnlocked(state, r) && isRegionVisible(state, r));
  if (locked.length) {
    lines.push('', `🎒 未解锁装备（各 ${EQUIP_PRICE} 亿 TOKEN）：` + locked.map((r) => r.equipment).join('、'));
  }
  // ★★ 2026-10-14（用户："把设施/技能/衣柜从商店里移出去，避免重复占用版面"）——
  //   庭院设施 / 技能树 / 旅伴技能 / 衣柜 **各有一张菜单图**，商店里只留一句指路。
  //   （它们的内容一页比一页长，堆在商店里既重复、又把商店正文撑到 1700+ 字 —— 见 MEMORY-2 §89。）
  // ⚠️ 这一行**受字数约束**（`panel-flood-probe` 盯着商店正文 < 1200 字）——
  //   加「🎁 特产图鉴」时就是它把总数顶到了 1206 ⇒ 顺手把「旅伴技能」收进
  //   「技能树（含旅伴技能）」（它本来就长在技能那张菜单里），一行更短也更准。
  lines.push('', '🏡 庭院设施 · 🧠 技能树（含旅伴技能）· 👗 服装衣柜 · 🎁 特产图鉴 各有菜单图：'
    + '说「看设施菜单」「看技能菜单」「看衣柜」「看图鉴」。');

  // 🐾 旅行伙伴 —— **单开一栏**（用户 2026-10-11 需求）。
  //    它是"邀请制"（**邀请过的可商量着换** —— 但在途时换不成，见 `appointCompanion`；同一个不用重复请），不占货架库存、也不进背包计数，
  //    所以走独立一段，而不是塞进上面的循环（那边每一项都按"库存 + 已有数量"显示）。
  const comps = Object.values(S.COMPANIONS || {});
  if (comps.length) {
    const owned = companionOf(state);
    const ownedIds = ownedCompanionIds(state);
    // ★ 2026-10-13：说好但还没到家（在途）的那位 —— 单独标一格，别显示成"已在队伍里"
    const pend = pendingCompanionOf(state);
    // ⚠️ 不许写 Markdown 星号 —— 这一行会**原样发到 QQ**（不渲染 Markdown）⇒ 群友看到的就是 `**`。
    // ★ 2026-10-14：把「见面礼」提到**栏头说一次** —— 原来七行每行都带一遍
    //   （`（见面礼 N 亿 TOKEN）`），白占 28 字；而商店正文有 < 1200 字的硬额度
    //   （`panel-flood-probe` 盯着）—— 这正是"同一件事说 N 遍"的典型浪费。
    // ⚠️ 措辞纪律（`whale-companion-check` 直接扫源码，**注释也算**）：
    //   不许把人当商品 —— 那几个"交易口吻"的词一个都不能出现在这个文件里。
    lines.push('', '🐾 旅行伙伴（见面礼只给一次，邀请过就一直跟着出门；想换就说一声，她自己旅行途中换不成）：');
    for (const c of comps) {
      const on = owned && owned.id === c.id;
      const has = ownedIds.includes(c.id);
      const wait = pend && pend.id === c.id;
      // ⚠️ 「见面礼」三个字**只在栏头说一次**（见上一行）——
      //   七行各带一遍要多占 28 字，而商店正文有 < 1200 字的硬额度。
      // ⚠️ 状态那半**尽量短**：七行累计起来是几百字，而这一整页有 < 1200 字的额度
      //   （`panel-flood-probe` 盯着，v3.4 加两位旅伴的新特色后一度顶到 1199，只剩 1 字余量）。
      //   "能不能换人"已经写在栏头了（"想换就说一声"），这里不必每行重说一遍。
      lines.push(`  ${companionEmoji(c)} ${c.name}（${c.price} 亿 TOKEN）— 特色「${c.trait || '增幅'}」：${companionTraitText(c)}｜${on ? '✅ 正在同行' : wait ? '🕐 已说好，回来就换' : has ? '已在队伍' : '还没邀请'}`);
    }
    // ★ 2026-10-15：按**真实原因**说清"等谁"（她自己 / 目标那位），别只说"等回来"——
    //   那会跟上一行的"在家待着"读起来自相矛盾（用户报的 bug）。
    if (pend) lines.push(`  （已说好：${pendingReasonText(state)}）`);
  }
  const remain = S.restockRemainMs(state);
  lines.push('', remain > 0
    ? `📦 下次补货：约 ${(remain / 3600000).toFixed(1)} 小时后`
    : '📦 货架刚补满');
  lines.push(`💰 TOKEN 余额：${Number(state.wallet?.plankton) || 0} 亿 TOKEN`);
  return lines.join('\n');
}

