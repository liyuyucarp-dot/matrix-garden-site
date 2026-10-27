// 矩阵庭院 · 引擎（纯逻辑）
//
// 这里只回答"现在该发生什么"，**不发消息、不落盘、不联网**。
// 真正干活（组文案、发图、写存档）交给 index.js —— 这样时间相关的逻辑
// 可以脱离运行环境单测，也不用为了测一个"该不该寄明信片"去 mock 整个发送队列。

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** 夜间静默：0:00 ~ 7:00 不主动寄明信片（跟人设一致 —— 它夜里在睡）。 */
export const NIGHT_START_HOUR = 0;
export const NIGHT_END_HOUR = 7;

/**
 * ★★ 回家后休息多久再自动出发（2026-10-13 大更新 step3：给「家」存在感）。
 *
 * 用户口径：「现在的'家'存在感太弱了，只是一个落脚点，回来踩一脚，然后马上就走了，
 *   根本没有在家待的必要……**首先把两种【自动出门】的时间拉长到 24 小时以上**，
 *   避免出现'刚回家就想走'这种感觉。」
 *
 * 旧值 2~6 小时的问题：中份饭走 8~16 小时、回家只歇 2~6 小时就再走 ⇒
 * **在家的时间只占整个循环的 11%~43%**，家自然像"客栈"而不是"家"。
 * 新值 24~48 小时 ⇒ 在家时间占循环的 **50%~75%**，她真的会在家住下来。
 *
 * ⚠️ 这两个是**默认值**；实际取值可由技能设置 `restHoursMin` / `restHoursMax` 覆盖
 *   （见 `index.js` 的 `restRange()`）。两条自动出门 —— **她自己那趟**与
 *   **闲置伙伴自己那趟** —— 都走这一个函数，所以改这里等于两处一起改。
 */
// ★ 2026-10-18（用户口径）：默认 24~48h → **10h**。
//   原来 24~48 是为了"让家有存在感"（在家时间占循环一半以上）；
//   现在自动化铺开之后，在家这段时间本来就是她自理/买东西的窗口，
//   用户希望循环快一点，所以把默认压到 10 小时（最短＝最长 ⇒ 每次正好 10 小时）。
//   ⚠️ 真正的取值通常来自技能设置 `restHoursMin/Max`（skill.json 里也同步改了），
//      改这里只影响"没配过任何设置"的情况。
export const REST_MIN_MS = 10 * HOUR;
export const REST_MAX_MS = 10 * HOUR;

/** 现在是不是"夜里"。 */
export function isNight(now = Date.now()) {
  const h = new Date(now).getHours();
  return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
}

/** 本地日期串（连续旅行天数用）。 */
export function dayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 到点该寄哪几张明信片。
 * 夜里压住不寄（静默），攒到早上一起补 —— 所以这里只筛"到点且不在静默期"。
 * @returns {Array<{index:number, at:number}>} index 是这张在 cardTimes 里的序号
 */
export function dueCards(trip, now = Date.now()) {
  if (!trip || !Array.isArray(trip.cardTimes)) return [];
  if (isNight(now)) return [];
  const sent = Math.max(0, Number(trip.cardsSent) || 0);
  const out = [];
  for (let i = sent; i < trip.cardTimes.length; i++) {
    if (Number(trip.cardTimes[i]) <= now) out.push({ index: i, at: Number(trip.cardTimes[i]) });
  }
  return out;
}

/** 旅程是否已经结束（该回家了）。 */
export function isReturned(trip, now = Date.now()) {
  return Boolean(trip) && now >= Number(trip.returnAt || 0);
}

/**
 * 回家后下一次自动出发的时刻。
 * 夜里回家就顺延到早上 —— 否则会在半夜三点"我出门啦"。
 *
 * @param {number} returnAt 基准时刻（**播报真正发出的时刻**，不是到家时刻 ——
 *   见 index.js 里那段说明：按到家时刻排会排出"7 点说我回来啦、8 点又出门"的诡异时间线）
 * @param {() => number} rand
 * @param {{minMs?:number, maxMs?:number}} [range] 休息区间覆盖（来自技能设置）
 */
export function nextDepartAt(returnAt, rand = Math.random, range = {}) {
  // ⚠️ 别写 `Number(range.minMs) || REST_MIN_MS`：`Number(null) === 0` 会被当"没传" —— 这里
  //    用显式 > 0 判定（本机栽过五次的坑）。maxMs 必须 > minMs，否则退回默认上界。
  const minMs = Number(range?.minMs) > 0 ? Number(range.minMs) : REST_MIN_MS;
  const maxMs = Number(range?.maxMs) > minMs ? Number(range.maxMs) : Math.max(minMs, REST_MAX_MS);
  const rest = minMs + rand() * (maxMs - minMs);
  let t = Number(returnAt) + rest;
  if (isNight(t)) {
    const d = new Date(t);
    d.setHours(NIGHT_END_HOUR, 0, 0, 0);
    if (d.getTime() <= t) d.setDate(d.getDate() + 1);   // 已过 7 点 → 明天的 7 点
    t = d.getTime();
  }
  return Math.round(t);
}

/**
 * 更新"连续旅行天数"。同一天重复调用不会累加。
 * 断档（隔了一天以上）就重置为 1。
 */
export function updateStreak(state, now = Date.now()) {
  const today = dayKey(now);
  const st = state.tripStreak || (state.tripStreak = { lastDay: '', days: 0 });
  if (st.lastDay === today) return st;                 // 当天已经记过
  const yesterday = dayKey(now - DAY);
  st.days = st.lastDay === yesterday ? (Number(st.days) || 0) + 1 : 1;
  st.lastDay = today;
  return st;
}

/**
 * 旅程推进到某一时刻应做的动作清单（按发生顺序）。
 * 返回的是"待办"，执行与否由调用方决定 —— 纯函数，不改 state。
 */
export function planAdvance(state, now = Date.now()) {
  const trip = state?.trip;
  if (!trip) return { cards: [], returned: false, overdueCards: [] };
  const cards = dueCards(trip, now);
  const returned = isReturned(trip, now);
  return {
    cards,
    returned,
    // 回家时还没寄完的（比如整趟都在夜里）→ 让调用方决定补寄还是丢弃
    overdueCards: returned
      ? trip.cardTimes.slice(Number(trip.cardsSent) || 0).map((at, i) => ({ index: (Number(trip.cardsSent) || 0) + i, at }))
      : []
  };
}

/**
 * 该不该自动出发。
 * 三条件：① 没有进行中的旅程 ② 有口粮 ③ 到了 nextDepartAt 且不是在夜里。
 */
export function shouldAutoDepart(state, now = Date.now()) {
  if (state?.trip) return false;
  if (isNight(now)) return false;
  const hasFood = Object.values(state?.bag?.food || {}).some((n) => Number(n) > 0);
  if (!hasFood) return false;
  const next = Number(state?.nextDepartAt || 0);
  return next > 0 && now >= next;
}
