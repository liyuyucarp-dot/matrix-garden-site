// bili-whale / diary.js
//
// 两本日记：给他看的「给他的信」，和只给自己的「写给自己」。
// 存进插件 storage，不写模块目录；保留天数由设置控制，最多 90 天。

import { getDb, addDiary, markDirty } from './store.js';
import { todayKey, truncate } from './util.js';

const DAY = 86400_000;

function prune(s) {
  const db = getDb();
  const days = Math.max(1, Number(s.diaryKeepDays) || 30);
  const since = Date.now() - days * DAY;
  for (const which of ['public', 'private']) {
    const list = Array.isArray(db.diaries[which]) ? db.diaries[which] : [];
    db.diaries[which] = list.filter((x) => Number(x.at || 0) >= since);
  }
  markDirty();
}

export function addEntries(s, { publicText = '', privateText = '', date = '', meta = {} } = {}) {
  if (!s.diaryEnabled) return { ok: false, reason: '日记总开关关着' };
  const day = date || todayKey(s.timeZone);
  const at = Date.now();
  let added = 0;
  if (String(publicText || '').trim()) {
    addDiary('public', { at, date: day, text: truncate(publicText, 6000), meta: { ...meta, kind: 'public' } });
    added += 1;
  }
  if (String(privateText || '').trim()) {
    addDiary('private', { at, date: day, text: truncate(privateText, 6000), meta: { ...meta, kind: 'private' } });
    added += 1;
  }
  prune(s);
  return { ok: added > 0, added };
}

export function listDiaries(s, { which = 'public', days = 7, limit = 20 } = {}) {
  const db = getDb();
  const key = which === 'private' ? 'private' : 'public';
  const list = Array.isArray(db.diaries[key]) ? db.diaries[key] : [];
  const since = Date.now() - Math.max(1, Number(days) || 7) * DAY;
  return list.filter((x) => Number(x.at || 0) >= since).slice(-Math.max(1, Number(limit) || 20));
}

export function formatDiary(s, { which = 'public', days = 1, limit = 5 } = {}) {
  const entries = listDiaries(s, { which, days, limit });
  if (!entries.length) return '（这段时间还没有日记）';
  return entries.map((e) => {
    const when = new Date(e.at).toLocaleString('zh-CN', { hour12: false });
    return `—— ${e.date || ''} ${when} ——\n${e.text}`;
  }).join('\n\n');
}

/** 给模型/面板看的今日摘要（短）。 */
export function todaySummary(s) {
  const day = todayKey(s.timeZone);
  const db = getDb();
  const pick = (which) => (Array.isArray(db.diaries[which]) ? db.diaries[which] : [])
    .filter((x) => String(x.date || '') === day).slice(-1)[0];
  const pub = pick('public');
  const pri = pick('private');
  return {
    date: day,
    public: pub ? truncate(pub.text, 500) : '',
    private: pri ? truncate(pri.text, 500) : '',
    has: Boolean(pub || pri)
  };
}

/** 最近几条“给他的信”的结尾，用于避免每次开头都一样。 */
export function recentOpenings(s, n = 3) {
  return listDiaries(s, { which: 'public', days: 30, limit: 20 })
    .slice(-Math.max(1, n)).map((x) => truncate(String(x.text || '').split('\n')[0], 80));
}
