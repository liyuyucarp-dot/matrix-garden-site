// bili-whale / quota.js
//
// 对外发言的硬闸门。参考项目的核心原则：“限频写进代码，不写进自觉里”。
//   分享型（@主人）：每天合计 ≤ shareDaily · 同一视频 N 天一次 · 评分 ≥ 阈值 · 沉默衰减
//   回复型：同一个人 30 天只回一条（可选）
//   直播弹幕：单独由 live 流程控制，不进分享额度
//
// 账本存在插件自己的 storage 里；读不出来时 fail-closed（拒绝发言），
// 不会因为文件坏了一次就“额度从零开始”。

import { getDb, addQuota, markDirty } from './store.js';

const DAY = 86400_000;

export function dateKeyOf(ts, timeZone = '') {
  const d = new Date(Number(ts) || Date.now());
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch { /* 非法时区走本地 */ }
  }
  return d.toLocaleDateString('sv-SE');
}

export function todayKey(s) {
  return dateKeyOf(Date.now(), s?.timeZone);
}

export function quotaLog() {
  const db = getDb();
  return Array.isArray(db.quota) ? db.quota : [];
}

export function usedToday(s) {
  const day = todayKey(s);
  return quotaLog().filter((x) => dateKeyOf(x.at, s?.timeZone) === day);
}

/** 沉默天数与衰减后的有效分享上限。 */
export function silence(s) {
  const db = getDb();
  const log = quotaLog();
  const firstShare = log.find((x) => x.share);
  const base = Number(db.feedback?.last) || Number(firstShare?.at) || 0;
  const days = base ? Math.floor((Date.now() - base) / DAY) : 0;
  const after = Math.max(1, Number(s.silentAfterDays) || 3);
  const stopAt = Math.max(after + 1, Number(s.silentStopDays) || 7);
  const baseCap = Math.max(0, Number(s.shareDaily) || 0);
  let cap;
  if (days < after) cap = baseCap;
  else if (days >= stopAt) cap = 0;
  else cap = Math.max(1, Math.floor((baseCap * (stopAt - days)) / (stopAt - after)));
  return {
    days,
    last: base || 0,
    penalty: baseCap - cap,
    cap,
    baseCap,
    after,
    stopAt
  };
}

export function status(s) {
  const today = usedToday(s);
  const shares = today.filter((x) => x.share);
  const auto = today.filter((x) => x.auto && !x.share);
  const replies = today.filter((x) => x.type === 'reply');
  const sil = silence(s);
  const effCap = Math.min(Math.max(0, Number(s.shareDaily) || 0), sil.cap);
  return {
    date: todayKey(s),
    total: today.length,
    shares: shares.length,
    shareCap: effCap,
    shareDaily: Math.max(0, Number(s.shareDaily) || 0),
    auto: auto.length,
    replies: replies.length,
    remaining: Math.max(0, effCap - shares.length),
    silence: sil,
    recent: today.slice(-8)
  };
}

/**
 * 发言闸：返回 { ok, reason }。target 用 `BVxxxx`。
 * @param {{mode?: 'share'|'comment'}} [opts]
 *   ★ 2026-10-24「评论视频模式」：两种模式共用**同一本账**（shareDaily + 沉默衰减 +
 *     同视频 N 天一次），区别只有一处 ——
 *     `comment` 模式发的是**公开评论**，不需要 @ 主人，所以不再要求填主人昵称。
 *     （以前 `!ownerBiliName` 是硬拦；评论模式下它会把功能整个卡死。）
 */
export function canShare(s, target, { mode = 'share' } = {}) {
  const isComment = mode === 'comment';
  const word = isComment ? '评论' : '分享';
  if (!s.shareEnabled) return { ok: false, reason: `${word}开关关着（只看不说）` };
  const st = status(s);
  if (st.shareCap <= 0) {
    return { ok: false, reason: `沉默 ${st.silence.days} 天 → ${word}额度已降到 0（日记照写）` };
  }
  if (st.shares >= st.shareCap) {
    return { ok: false, reason: `今天的${word}额度用完了（${st.shares}/${st.shareCap}），留给明天` };
  }
  if (!isComment && !s.ownerBiliName) return { ok: false, reason: '没有配置主人的 B 站昵称，评论无法 @ 主人' };
  if (target) {
    const days = Math.max(1, Number(s.sameVideoDays) || 7);
    const dup = quotaLog().find((x) => x.share && String(x.target || '') === String(target) && Date.now() - Number(x.at || 0) < days * DAY);
    if (dup) return { ok: false, reason: `这个视频 ${days} 天内已经${word}过了（${new Date(dup.at).toLocaleString('zh-CN')}）` };
  }
  return { ok: true, reason: `额度内（${st.shares}/${st.shareCap}）` };
}

/** 回复判重：同一个人 30 天内只回一条。 */
export function canReplyToPerson(s, mid) {
  if (!s.oncePerPerson) return { ok: true, reason: '判重关着' };
  const id = String(mid || '');
  if (!id) return { ok: false, reason: '没查到对方 mid，判重状态未知 → 这次不回（fail-closed）' };
  const db = getDb();
  const list = Array.isArray(db.replied?.[id]) ? db.replied[id] : [];
  const recent = list.filter((x) => Date.now() - Number(x.at || 0) < 30 * DAY);
  if (recent.length) {
    return { ok: false, reason: `30 天内已经回过这个人了（${new Date(recent[0].at).toLocaleDateString('zh-CN')}）` };
  }
  return { ok: true, reason: '30 天内没回过' };
}

export function markReplied(mid, { target = '', rpid = '', name = '' } = {}) {
  const id = String(mid || '');
  if (!id) return;
  const db = getDb();
  if (!db.replied || typeof db.replied !== 'object') db.replied = {};
  const list = Array.isArray(db.replied[id]) ? db.replied[id] : [];
  list.push({ at: Date.now(), target: String(target || ''), rpid: String(rpid || ''), name: String(name || '') });
  db.replied[id] = list.filter((x) => Date.now() - Number(x.at || 0) < 30 * DAY).slice(-10);
  markDirty();
}

export function record({ type, target = '', note = '', share = false, auto = false, bvid = '' }) {
  addQuota({
    at: Date.now(),
    type: String(type || 'comment'),
    target: String(target || ''),
    bvid: String(bvid || ''),
    note: String(note || '').slice(0, 120),
    share: share === true,
    auto: auto === true
  });
  if (share) {
    const db = getDb();
    db.stats = db.stats || {};
    db.stats.totalShares = (Number(db.stats.totalShares) || 0) + 1;
    markDirty();
  }
}

/** 记一次“主人有表态”，把沉默清零并写进偏好校准。 */
export function markFeedback(s, note = '') {
  const db = getDb();
  if (!db.feedback || typeof db.feedback !== 'object') db.feedback = { last: 0, events: [] };
  db.feedback.last = Date.now();
  db.feedback.events = Array.isArray(db.feedback.events) ? db.feedback.events : [];
  db.feedback.events.push({ at: Date.now(), note: String(note || '主人有表态').slice(0, 160) });
  if (db.feedback.events.length > 100) db.feedback.events = db.feedback.events.slice(-100);
  markDirty();
}

export function isRiskError(error) {
  return Boolean(error?.risk) || /风控|验证码|请求过于频繁|412|-352|12015/i.test(String(error?.message || error));
}
