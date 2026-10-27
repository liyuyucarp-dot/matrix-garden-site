// 日历模块 —— 只做"今天是什么日子 / 现在算不算上班"的判定，不做表达。
// 输出喂给生活系统的作息变体、精力/心情修正、以及彩蛋池放行。
//
// 守 R5：日历表 year < 当前年 → 判定过期，节日/调休 note 与池一律停用，
// 只按周几给作息（宁可退化成"不认识节假日"，也不要在过期表上断言"今天放假"）。

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDayKey(dayKey, delta) {
  const [y, m, dd] = String(dayKey).split('-').map(Number);
  const d = new Date(y, (m || 1) - 1, dd || 1);
  d.setDate(d.getDate() + delta);
  return localDayKey(d);
}
function hourFloat(d = new Date()) {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 今天是什么日子。
 * @param {Date} date
 * @param {{year:number,holidays?:object,makeupWorkdays?:object}} table
 */
export function dayInfo(date = new Date(), table = {}) {
  const dayKey = localDayKey(date);
  const dow = date.getDay();
  const year = num(table?.year, 0);
  const expired = !table || !table.holidays || year < date.getFullYear();

  const makeup = expired ? '' : String(table.makeupWorkdays?.[dayKey] || '');
  const holiday = expired ? null : (table.holidays?.[dayKey] || null);

  let kind, name = '', isRest, moodNudge = 0;
  if (makeup) { kind = 'makeup'; name = makeup; isRest = false; moodNudge = -3; }
  else if (holiday) { kind = 'holiday'; name = String(holiday.name || '假期'); isRest = true; }
  else if (dow === 0 || dow === 6) { kind = 'weekend'; name = '周末'; isRest = true; }
  else { kind = 'workday'; name = WEEKDAY[dow]; isRest = false; }
  const work = !isRest;

  let note = '';
  if (!expired) {
    const tomorrow = shiftDayKey(dayKey, 1);
    const yesterday = shiftDayKey(dayKey, -1);
    if (work && table.holidays?.[tomorrow]) moodNudge -= 2;   // 明天放假，心飞了
    if (work && table.holidays?.[yesterday]) moodNudge -= 2;   // 假期刚结束
  }
  // 注入行用的"非平凡"描述：普通工作日 / 普通周末返回空串（省 token）
  if (holiday) note = num(holiday.of, 1) > 1 ? `${name}假期第 ${num(holiday.day, 1)} 天` : name;
  else if (makeup) note = '今天调休上班';
  else if (!expired) {
    const tomorrow = shiftDayKey(dayKey, 1);
    const yesterday = shiftDayKey(dayKey, -1);
    if (work && table.holidays?.[tomorrow]) note = '明天就放假了';
    else if (work && table.holidays?.[yesterday]) note = '假期刚结束';
  }

  return { dayKey, dow, weekLabel: WEEKDAY[dow], kind, name, isRest, work, moodNudge, note, expired };
}

/** 日子类型 → 精力/心情修正块（相对钟点表的增量；调用方负责夹逼与下限）。 */
export function dayModifiers(date = new Date(), table = {}) {
  const info = dayInfo(date, table);
  let physical = 0, cognitive = 0;
  const moodNudge = num(info.moodNudge, 0);
  switch (info.kind) {
    case 'weekend': physical = -10; cognitive = -12; break;   // 周末慢启动
    case 'holiday': physical = -6; cognitive = -5; break;      // 假期松，但心情好
    case 'makeup': physical = -8; cognitive = -8; break;       // 调休上班，不情愿
    default: break;
  }
  return { physical, cognitive, moodNudge, kind: info.kind, expired: info.expired };
}

/** 上班时段内的子状态分段（deep/normal/meeting），种子=dayKey+job → 当天可复现。 */
export function workSegments(date = new Date(), cfg = {}) {
  const job = String(cfg.job || 'programmer');
  if (job === 'none') return [];
  const start = num(cfg.workStart, 9);
  const end = num(cfg.workEnd, 18.5);
  if (end <= start) return [];
  const rnd = mulberry32(hashStr(`${localDayKey(date)}|ws|${job}`));
  const meetingW = job === 'ops' ? 0.08
    : job === 'programmer' ? 0.15
      : job === 'designer' ? 0.16
        : job === 'streamer' ? 0.05
          : job === 'student' ? 0.12 : 0.1;
  const segs = [];
  let h = start;
  while (h < end) {
    const len = Math.min(0.5 + rnd() * 0.9, end - h);
    const r = rnd();
    let state;
    if (r < meetingW) state = 'meeting';
    else if (r < meetingW + 0.42) state = 'deep';
    else state = 'normal';
    segs.push({ from: Math.round(h * 100) / 100, to: Math.round((h + len) * 100) / 100, state });
    h += len;
  }
  return segs;
}

/** 此刻的工作子状态：off / deep / normal / meeting。非上班时段或无工作 → off。 */
export function workState(date = new Date(), segs = [], cfg = {}) {
  const job = String(cfg.job || 'programmer');
  if (job === 'none') return 'off';
  const start = num(cfg.workStart, 9);
  const end = num(cfg.workEnd, 18.5);
  const m = hourFloat(date);
  if (m < start || m >= end) return 'off';
  const seg = (segs || []).find((s) => m >= s.from && m < s.to);
  return seg ? seg.state : 'normal';
}

export const __test = { localDayKey, shiftDayKey, hourFloat, dayInfo };
