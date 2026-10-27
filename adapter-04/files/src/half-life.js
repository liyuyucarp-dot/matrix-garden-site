// ══════════════════════════════════════════════════════════════════
// 半衰账本（half-life）—— 「世界与事件」(life-system) 插件的核心依赖
//
// ── 为什么有这个文件（2026-10-12 本机补写）────────────────────────
// `plugins/life-system/index.js` 顶层**静态 import** 了
//     import { noteEntry, decayInfo, ageLabel, FLOOR, DEAD } from '../../src/half-life.js';
// 而本机（洛版 v0.4.5）**原本没有这个文件** —— 静态 import 不会降级，
// 所以插件的状态是「一行都跑不起来（ERR_MODULE_NOT_FOUND）」。
// 本文件是**按该插件的实际调用点反推出来的等价实现**，只新增、不改动任何既有文件。
//
//   decayInfo(fact, now, hl) → { weight, ageMin, minsLeft, expired, hl }
//   noteEntry(facts, group, text, { halfLifeMin, now, capFactor, maxKeys, onEvict }) → entry
//   ageLabel(ageMin) → 「半小时左右」这类人话（**不带括号**，调用方自己包）
//   FLOOR / DEAD 两个阈值常量
//   （另有 weightOf / liveEntries / pruneEntries，上游说明文档里列了，一并补齐）
//
// ── 它解决什么问题 ────────────────────────────────────────────────
// 一条「近况」（刚吃过饭 / 在忙 / 困了）写进账本后**随时间变淡**，而不是到点
// 突然消失 —— 这样她不会「上一句说吃完了、下一句喊饿」，也不会永远念叨同一件事。
//
//     权重 = 0.5 ^ (经过的分钟 / 半衰期分钟)
//     刚记下 = 1.0 ｜ 一个半衰期 = 0.5 ｜ 两个 = 0.25 ｜ 四个 = 0.0625
//
// ⚠️ 上游刻意把换算关系定成 `hl = ttl / 2` —— 于是「权重掉到 0.25」正好等于
//    旧版那个硬到期时刻，插件里调好的数值一个都不用重调（见其 index.js 的注释）。
//    本文件的两个阈值就按这个口径定，且**必须 FLOOR > DEAD**：
//      先「不再给模型看」、再「从文件里清掉」，这两件事不能同时发生
//      （否则 liveFacts 刚过滤掉一条、prune 又立刻删掉它，FLOOR 形同虚设）。
// ══════════════════════════════════════════════════════════════════

const MIN = 60000;

/** 权重低于它就不再注入（但**仍留在账本里**维持一致性，被问到还答得上来）。 */
export const FLOOR = 0.1;
/** 权重低于它就可以从账本里删掉了（≈ 4 个半衰期，已经没有信息量）。 */
export const DEAD = 1 / 16;
/** 条目没写 hl 时的兜底半衰期（分钟），与插件的默认量级一致。 */
const DEFAULT_HL = 60;

/**
 * 取数字，拿不到就用默认值。
 *
 * ⚠️ **必须显式排除 null / undefined / ''** —— `Number(null) === 0` 且
 * `Number.isFinite(0)` 为 true，所以直接写 `Number.isFinite(Number(v)) ? Number(v) : d`
 * 会把"没传"当成"传了 0"（本文件第一版就栽在这：`decayInfo(entry, now)` 省略第三参数，
 * hl 被算成 0 → `Math.max(1, 0)` = 1，权重 `0.5^30` 直接塌成 0）。
 */
const numOr = (v, d) => {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * 一条记录的当前权重（0~1）。
 *
 * 宽容签名：第一个参数可以传 `at` 时间戳或整条记录，方便各处调用。
 */
export function weightOf(entry, now = Date.now(), halfLifeMin = DEFAULT_HL) {
  const at = entry && typeof entry === 'object' ? Number(entry.at) : Number(entry);
  const hl = Math.max(1, numOr(halfLifeMin, numOr(entry?.hl, DEFAULT_HL)));
  if (!Number.isFinite(at)) return 0;
  const ageMin = Math.max(0, (Number(now) - at) / MIN);
  return Math.pow(0.5, ageMin / hl);
}

/**
 * 算一条记录的衰减情况。
 *
 * @returns {{weight:number, ageMin:number, minsLeft:number, expired:boolean, hl:number}}
 *   weight   —— 当前权重（0~1）
 *   ageMin   —— 距今多少分钟
 *   minsLeft —— 还能"站着"多久（权重跌到 DEAD 为止；已经跌破则为 0）
 *   expired  —— 是否已经跌破 DEAD
 */
export function decayInfo(entry, now = Date.now(), halfLifeMin = null) {
  const hl = Math.max(1, numOr(halfLifeMin, numOr(entry?.hl, DEFAULT_HL)));
  const at = Number(entry?.at);
  if (!Number.isFinite(at)) {
    return { weight: 0, ageMin: Infinity, minsLeft: 0, expired: true, hl };
  }
  const ageMin = Math.max(0, (Number(now) - at) / MIN);
  const weight = Math.pow(0.5, ageMin / hl);
  // weight * 0.5^(t/hl) = DEAD  ⇒  t = hl * log2(weight / DEAD)
  const minsLeft = weight > DEAD ? Math.max(0, hl * Math.log2(weight / DEAD)) : 0;
  return { weight, ageMin, minsLeft, expired: weight < DEAD, hl };
}

/**
 * 记一条事实（**同组覆盖** —— 这是"一致性底线"的实现：每类状态任何时刻只有一个说法）。
 *
 * 同组同文本会被**续期**：`at` 往后推，但最多推到 `bornAt + capFactor × hl`
 * （对应上游"同文本总寿命 ≤ 1.5 × TTL"的老规则，见其 index.js 的推导）。
 * 组数超过 `maxKeys` 时，淘汰当前**最淡**的那一组，并回调 `onEvict(key, entry)`。
 *
 * ⚠️ **原地写进 `facts`** —— 调用方随后会 saveLedger，返回值只是方便再挂字段
 * （例如 `entry.source = 'speech'`）。
 *
 * @param {object} facts  账本里的分组表（会被原地修改）
 * @returns {object|null} 写入/续期后的条目；参数非法时返回 null
 */
export function noteEntry(facts, group, text, opts = {}) {
  if (!facts || typeof facts !== 'object') return null;
  const g = String(group || 'misc').toLowerCase();
  const t = String(text ?? '').trim();
  if (!t) return null;

  const now = numOr(opts.now, Date.now());
  const hl = Math.max(1, numOr(opts.halfLifeMin, DEFAULT_HL));
  const capFactor = numOr(opts.capFactor, 1);
  const maxKeys = Math.max(1, Math.trunc(numOr(opts.maxKeys, 8)));
  const onEvict = typeof opts.onEvict === 'function' ? opts.onEvict : null;

  const prev = facts[g];
  if (prev && typeof prev === 'object') {
    const bornAt = numOr(prev.bornAt, numOr(prev.at, now));
    if (String(prev.text) === t) {
      // 同文本续期：at 只往后推、不往前退，且受 capFactor 封顶
      const cap = bornAt + capFactor * hl * MIN;
      prev.at = Math.min(cap, Math.max(numOr(prev.at, now), now));
      prev.bornAt = bornAt;
      prev.hl = hl;
      return prev;
    }
  }

  // 新组且已满员 → 淘汰当前最淡的一组
  if (!prev && Object.keys(facts).length >= maxKeys) {
    let victim = null;
    let victimWeight = Infinity;
    for (const k of Object.keys(facts)) {
      const w = weightOf(facts[k], now, numOr(facts[k]?.hl, DEFAULT_HL));
      if (w < victimWeight) { victimWeight = w; victim = k; }
    }
    if (victim) {
      const evicted = facts[victim];
      delete facts[victim];
      try { if (onEvict) onEvict(victim, evicted); } catch { /* 回调失败不影响记账 */ }
    }
  }

  facts[g] = { text: t, at: now, bornAt: now, hl, shown: 0 };
  return facts[g];
}

/** 还"活着"的条目（权重 > floor），浓的在前。 */
export function liveEntries(facts, { now = Date.now(), floor = FLOOR } = {}) {
  return Object.entries(facts || {})
    .map(([key, e]) => ({
      key,
      ...e,
      weight: weightOf(e, now, numOr(e?.hl, DEFAULT_HL)),
      ageMin: Number.isFinite(Number(e?.at)) ? (Number(now) - Number(e.at)) / MIN : Infinity
    }))
    .filter((e) => String(e.text || '').trim() && e.weight > floor)
    .sort((a, b) => b.weight - a.weight);
}

/** 清掉淡到没意义的条目（权重 < dead），返回删掉的条数。原地修改 facts。 */
export function pruneEntries(facts, { now = Date.now(), dead = DEAD } = {}) {
  let removed = 0;
  for (const [key, e] of Object.entries(facts || {})) {
    if (weightOf(e, now, numOr(e?.hl, DEFAULT_HL)) < dead) {
      delete facts[key];
      removed += 1;
    }
  }
  return removed;
}

/**
 * 把"距今多少分钟"说成人话（**不带括号** —— 调用方自己包）。
 *
 * 用于「（近况）刚吃过东西（半小时左右）」这种注入，让模型知道那是多久以前的事，
 * 从而不会把"几小时前吃过饭"当成"刚吃完"。
 */
export function ageLabel(ageMin) {
  const m = Number(ageMin);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 2) return '刚刚';
  if (m < 20) return '几分钟前';
  if (m < 50) return '半小时左右';
  if (m < 80) return '一小时上下';
  if (m < 150) return '一两个小时前';
  if (m < 300) return '几小时前';
  if (m < 480) return '小半天前';
  if (m < 1080) return '大半天前';
  if (m < 1800) return '一天前';
  return '有一阵子了';
}
