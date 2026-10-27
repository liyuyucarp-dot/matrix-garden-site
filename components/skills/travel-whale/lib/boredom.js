// 无聊值（BOREDOM）—— 让「想不想出门」有一个可说出口的依据
//
// ── 为什么要有它 ────────────────────────────────────────────────────────────
// 原来自动出门是**纯时间闸**：`nextDepartAt = 回家 + rand(24~48h)`，
// 时间一到 → `shouldAutoDepart` 为真 → `depart()` 直接走。
// 她没有"想不想"这个中间层 —— 时间到了身体就自己走了。
//
// 现在改成：时间到 ⇒ **先问她一句**。而问的时候得有东西可说，
// 否则模型只能凭空编一个"我想出门了"。这个文件提供那个东西。
//
// ── 口径（用户 2026-10-23 定）──────────────────────────────────────────────
//   · **只升不降**：在家待着就一直涨，没有"降回去"的路径。
//   · **出门一次清空**：`depart` 成功 ⇒ `homeSince` 归零 ⇒ 值自动从 0 重新算。
//   · 不做随机、不做掷骰 —— 同样的时长永远得到同一个值（可测、可复现）。
//
// ── 实现取巧：不存"数值"，只存"到家时刻" ────────────────────────────────────
// 用 `state.homeSince`（`settleTrip` 里已经在写）算 `now - homeSince`。
// 这样"只升不降"是**结构保证**的，不需要每次 tick 累加、也不会因为 reload 丢增量。
//
// ⚠️ 老存档 `homeSince` 可能是 0（这个字段是 2026-10-13 才加的）。
//    那时用 `state.createdAt` 兜底；再没有就只能当"刚到家"（宁可少问，也别一上来就问）。

/** 默认阈值（全部可从设置覆盖；`!== false` / `> 0` 的容错写法见各调用点） */
export const BOREDOM_DEFAULTS = {
  perHour: 4,        // 每小时涨多少（0~100 刻度；4 ⇒ 25 小时满）
  max: 100,
  askAt: 55,         // 到这个值就算"很想出门"（≈ 14 小时）
  /** 拒绝后多久再问：值低 → 等久点（12h），值高 → 早点再问（3h） */
  askGapLowH: 12,
  askGapHighH: 3
};

/**
 * 她在家待了多久（小时）。没有 `homeSince` 时用 `createdAt` 兜底；都没有 ⇒ 0。
 * @returns {number} 小时（不会是负数）
 */
export function homeHoursOf(state, now = Date.now()) {
  const since = Number(state?.homeSince) || Number(state?.createdAt) || 0;
  if (!since) return 0;
  return Math.max(0, (now - since) / 3600000);
}

/**
 * 无聊值（0~100）。纯函数：同样的 state + now 永远同一个结果。
 * @param {object} state
 * @param {number} now
 * @param {object} [cfg] 可用 { perHour, max } 覆盖
 */
export function boredomOf(state, now = Date.now(), cfg = {}) {
  const perHour = Number(cfg.perHour) > 0 ? Number(cfg.perHour) : BOREDOM_DEFAULTS.perHour;
  const max = Number(cfg.max) > 0 ? Number(cfg.max) : BOREDOM_DEFAULTS.max;
  const v = homeHoursOf(state, now) * perHour;
  return Math.max(0, Math.min(max, Math.round(v)));
}

/**
 * 把数值翻成一句话 —— **给模型读的**，不是给玩家看的。
 *
 * ⚠️ 刻意不写"该出门了 / 建议出门"这类结论：那是替她做决定。
 *    这里只描述身体感受，像「腿有点锈」「院子里的活都干完了」这种。
 */
export function boredomFeel(v, homeHours) {
  const h = Math.round(homeHours);
  if (v >= 85) {
    return `在家待了 ${h} 小时，已经待得有点发闷 —— 屋子里的每样东西都看熟了，手上没什么新鲜事。`;
  }
  if (v >= 55) {
    return `在家待了 ${h} 小时，开始有点待不住 —— 不是难受，就是总觉得该动一动了。`;
  }
  if (v >= 30) {
    return `在家待了 ${h} 小时，还算舒服，但已经过了"刚回来什么都好"的那几天。`;
  }
  return `在家待了 ${h} 小时，刚回来不久，还处在放松的状态里。`;
}

/**
 * 拒绝之后隔多久再问（毫秒）。
 * 值低 ⇒ 12 小时；值高 ⇒ 3 小时。中间线性插值 —— 不掷骰子。
 */
export function askGapMsOf(boredom, cfg = {}) {
  const low = Number(cfg.askGapLowH) > 0 ? Number(cfg.askGapLowH) : BOREDOM_DEFAULTS.askGapLowH;
  const high = Number(cfg.askGapHighH) > 0 ? Number(cfg.askGapHighH) : BOREDOM_DEFAULTS.askGapHighH;
  const v = Math.max(0, Math.min(100, Number(boredom) || 0));
  // t=0（一点都不无聊）→ low 小时；t=1（满）→ high 小时
  const t = v / 100;
  const hours = low + (high - low) * t;
  return Math.max(1, Math.round(hours)) * 3600000;
}

/** 供探针断言默认值 / 纯函数性。 */
export const internals = { BOREDOM_DEFAULTS, homeHoursOf, boredomOf, boredomFeel, askGapMsOf };
