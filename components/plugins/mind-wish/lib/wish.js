// 念想的纯逻辑（无 IO、无随机、无时间依赖）—— 可离线单测
//
// 一个念想长这样：
//   { id, text, kind:'person'|'thing'|'place', who, strength, at, touchedAt, source, hits }
//
// 三个必须守住的口径：
//   ① **强度只由数据算出来**，不掷骰 —— 同样输入永远同样排序，才能写回归用例；
//   ② **衰减是乘性的**，不是线性的：一件事过 7 天还在，过 30 天就该想不起来；
//   ③ **淘汰只看强度**，不按"谁新" —— 否则念想永远等于"最近 3 天"，攒不出东西。

/** 强度下限：低于这个就掉出活跃列表（不是删，还留着看） */
export const MIN_STRENGTH = 0.08;

/** 各来源的基础强度（"她跟这件事的关系"决定起点） */
export const SOURCE_BASE = {
  mood: 0.72,      // 情绪变化：已经有"为什么"，天然筛选过
  bili: 0.55,      // B站见闻：她真看了，但是外部世界
  moment: 0.42,    // 庭院经历：她做过的，但大部分是日常
  mind: 0.6        // silence-ping 里想起过的人
};

/**
 * 衰减：exp(-Δt / (decayDays × stability))。
 * @param {number} strength 初始强度
 * @param {number} dtMs 距上次被"想起"过了多久
 * @param {number} decayDays 半衰参数（天）
 * @param {number} stability 稳定度（默认 1；同一件事被反复想起时可以提高）
 */
export function decayed(strength, dtMs, decayDays = 7, stability = 1) {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  const d = Math.max(0, Number(dtMs) || 0) / 86400000;
  const tau = Math.max(0.5, (Number(decayDays) || 7) * Math.max(0.2, Number(stability) || 1));
  return s * Math.exp(-d / tau);
}

/**
 * 排序分。
 * @param {object} wish
 * @param {number} now
 * @param {object} opts { decayDays, moodFactor }
 *   moodFactor：情绪系数（低落 >1 / 平稳 1 / 高涨 <1）—— **只影响排序，不影响"要不要说"**
 */
export function scoreOf(wish, now = Date.now(), opts = {}) {
  if (!wish) return 0;
  const decayDays = Number(opts.decayDays) > 0 ? Number(opts.decayDays) : 7;
  const stability = 1 + Math.min(5, Math.max(0, (Number(wish.hits) || 1) - 1)) * 0.4;
  const base = decayed(wish.strength, now - (Number(wish.touchedAt) || Number(wish.at) || now), decayDays, stability);
  const mf = Number(opts.moodFactor);
  return base * (Number.isFinite(mf) && mf > 0 ? mf : 1);
}

/** 按强度排序，取前 n（返回新数组，不改原数组） */
export function pickTop(wishes, n = 3, now = Date.now(), opts = {}) {
  const list = Array.isArray(wishes) ? wishes : [];
  return list
    .map((w) => ({ w, s: scoreOf(w, now, opts) }))
    .filter((x) => x.s >= MIN_STRENGTH)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, n))
    .map((x) => ({ ...x.w, score: Math.round(x.s * 1000) / 1000 }));
}

/** 淘汰：按强度留下前 maxActive 条（超过的进 pending 由调用方决定） */
export function evict(wishes, maxActive = 6, now = Date.now(), opts = {}) {
  const list = Array.isArray(wishes) ? wishes : [];
  const scored = list
    .map((w) => ({ w, s: scoreOf(w, now, opts) }))
    .filter((x) => x.s >= MIN_STRENGTH)
    .sort((a, b) => b.s - a.s);
  const keep = scored.slice(0, Math.max(1, maxActive)).map((x) => x.w);
  const drop = scored.slice(Math.max(1, maxActive)).map((x) => ({ ...x.w, _score: x.s }));
  const dead = list.filter((w) => scoreOf(w, now, opts) < MIN_STRENGTH);
  return { keep, drop: [...drop, ...dead.map((w) => ({ ...w, _score: 0 }))] };
}

// ── 庭院经历的筛子 ────────────────────────────────────────────────────────
//
// `sleep-mood-moments.json` 是**活动时钟**：20 分钟一条、约 44 条/天，
// 内容像「找个台阶坐下歇着」「把剩下的钱算了一遍」。这些是"背景音"，不是"经历"。
// 不过筛的话念想层会退化成"最近 6 条活动日志"（实测 44 条/天 vs 上限 6 条）。

/**
 * 情感转折：有这些词说明这件事有起伏，不只是做了个动作。
 * 除了转折词，还收了几类**具体的"不顺"**——"走了两遍都没找着"这种，
 * 事情本身不稀奇，但对当事人是有重量的（实测里这类占多数）。
 */
const EMO_RE = /还是|却没|原来|第一次|头一回|没想到|竟然|居然|差点|舍不得|后悔|愣|心里|忍不住|没找着|没找成|走冤枉路|白跑|散架|折腾|算了|不换了|罢了/;

/** 稀有 / 事件类 id（不是日常动作） */
const RARE_RE = /rare|battle|meet|gift|event|lost|leave|return/i;

/** 提到具体的人（对方 / 旅伴 / 她们） */
const WHO_RE = /对方|伴侣|旅伴|他们|她们|她|他/;

/**
 * 这条庭院经历配不配成为念想。
 * @param {object} m { id, act, detail, phase, place }
 * @returns {{ok:boolean, why:string}}
 */
export function qualifiesMoment(m) {
  if (!m) return { ok: false, why: '空' };
  const id = String(m.id || '');
  const detail = String(m.detail || '');
  const act = String(m.act || '');
  if (RARE_RE.test(id)) return { ok: true, why: '稀有/事件类' };
  if (EMO_RE.test(detail)) return { ok: true, why: '有情感转折' };
  if (WHO_RE.test(detail) && detail.length >= 12) return { ok: true, why: '涉及具体的人' };
  if (act && act.length >= 14) return { ok: true, why: '动作描述足够具体' };
  return { ok: false, why: '日常动作' };
}

/**
 * 从一批 moment 里挑出配得上的，并按时间倒序。
 * @returns {Array} 最多 limit 条
 */
export function filterMoments(items, limit = 5, sinceAt = 0) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  for (const m of list) {
    const at = Number(m && m.at) || 0;
    if (at <= sinceAt) continue;
    if (qualifiesMoment(m).ok) out.push(m);
  }
  out.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return out.slice(0, Math.max(0, limit));
}

/**
 * 情绪 → 系数。只影响排序，不影响"要不要说"。
 * 低落时同一件事更容易浮上来（×1.3），高涨时相对不那么惦记（×0.85）。
 * @param {object} mood mood.json 的内容
 */
export function moodFactorOf(mood) {
  try {
    if (!mood || typeof mood !== 'object') return 1;
    // ⚠️ 必须先判对象存在再取 value：`Number(null)` 是 **0**（不是 NaN），
    //    直接把缺失的字段读成"情绪值 0 = 极度低落"，系数会莫名变成 1.1。
    const val = (o) => {
      const v = (o && typeof o === 'object') ? Number(o.value) : NaN;
      return Number.isFinite(v) ? v : NaN;
    };
    const mv = val(mood.mood);
    const dp = val(mood.depress);
    const sat = val(mood.satisfaction);
    let f = 1;
    if (Number.isFinite(dp) && dp >= 50) f += 0.3;
    else if (Number.isFinite(dp) && dp >= 20) f += 0.15;
    if (Number.isFinite(sat) && sat >= 80) f -= 0.15;
    if (Number.isFinite(mv) && mv <= 25) f += 0.1;
    return Math.max(0.7, Math.min(1.4, f));
  } catch {
    return 1;
  }
}

/** 每天新增上限的日键（北京时间） */
export function dayKey(now = Date.now()) {
  const d = new Date(Number(now) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

export const internals = {
  MIN_STRENGTH, SOURCE_BASE, decayed, scoreOf, pickTop, evict,
  qualifiesMoment, filterMoments, moodFactorOf, dayKey
};
