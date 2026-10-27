// bili-whale / store.js
//
// 全部运行时状态只走宿主公开的 api.storage（落盘在 <DATA_DIR>/plugin-data/bili-whale/）。
// 不写插件目录、不 import fs —— 这是“热插拔、整目录分享”的前提。
//
// 容量策略：storage 单文件 1MB 硬上限，所以这里主动裁剪：
//   账本 300 条 / 事件 200 条 / 两本日记各 40 篇 / 草稿 50 条 / 看过的 800 个 BV。
//   每篇日记限制 6000 字，正常写一年也到不了上限。

const KEY = 'db';
const VERSION = 1;

export function emptyDb() {
  return {
    version: VERSION,
    plan: null,
    counters: { date: '', wakes: 0, used: {} },
    quota: [],
    feedback: { last: 0, events: [] },
    replied: {},
    diaries: { public: [], private: [] },
    drafts: [],
    seen: {},
    events: [],
    listen: { lastSeen: 0, at: 0 },
    live: { recentIds: [], lastAt: 0 },
    stats: { lastWakeAt: 0, lastWakeResult: null, login: null, totalWakes: 0, totalShares: 0 },
    notify: { date: '', count: 0, lastAt: 0 },
    outbox: [],
    meta: { installedAt: Date.now(), lastSaveAt: 0 }
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function mergeDb(base, raw) {
  const out = { ...base };
  for (const [k, v] of Object.entries(raw || {})) {
    if (isObj(v) && isObj(base[k])) out[k] = mergeDb(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let apiRef = null;
let db = emptyDb();
let timer = null;
let saving = false;
let lastError = '';

export function initStore(api, onError) {
  apiRef = api;
  let raw = null;
  try { raw = api?.storage?.get?.(KEY, null); } catch { raw = null; }
  db = isObj(raw) ? mergeDb(emptyDb(), raw) : emptyDb();
  normalize();
  if (typeof onError === 'function') reportError = onError;
  return db;
}

let reportError = () => {};

export function getDb() {
  return db;
}

export function getPath(key, fallback) {
  const parts = String(key || '').split('.').filter(Boolean);
  let cur = db;
  for (const p of parts) {
    if (!isObj(cur) && !Array.isArray(cur)) return fallback;
    cur = cur[p];
    if (cur === undefined) return fallback;
  }
  return cur ?? fallback;
}

/** 规范化：保证数组/对象字段类型正确，防止旧版本或手工改坏导致后续崩。 */
function normalize() {
  db.version = VERSION;
  if (!isObj(db.counters)) db.counters = { date: '', wakes: 0, used: {} };
  if (!isObj(db.counters.used)) db.counters.used = {};
  if (!Array.isArray(db.quota)) db.quota = [];
  if (!isObj(db.feedback)) db.feedback = { last: 0, events: [] };
  if (!Array.isArray(db.feedback.events)) db.feedback.events = [];
  if (!isObj(db.replied)) db.replied = {};
  if (!isObj(db.diaries)) db.diaries = { public: [], private: [] };
  if (!Array.isArray(db.diaries.public)) db.diaries.public = [];
  if (!Array.isArray(db.diaries.private)) db.diaries.private = [];
  if (!Array.isArray(db.drafts)) db.drafts = [];
  if (!isObj(db.seen)) db.seen = {};
  if (!Array.isArray(db.events)) db.events = [];
  if (!isObj(db.listen)) db.listen = { lastSeen: 0, at: 0 };
  if (!isObj(db.live)) db.live = { recentIds: [], lastAt: 0 };
  if (!Array.isArray(db.live.recentIds)) db.live.recentIds = [];
  if (!isObj(db.stats)) db.stats = { lastWakeAt: 0, lastWakeResult: null, login: null };
  if (!isObj(db.notify)) db.notify = { date: '', count: 0, lastAt: 0 };
  if (!Array.isArray(db.outbox)) db.outbox = [];
  if (!isObj(db.meta)) db.meta = {};
  trim();
}

/** 主动裁剪到安全体积。 */
export function trim() {
  if (db.quota.length > 300) db.quota = db.quota.slice(-300);
  if (db.events.length > 200) db.events = db.events.slice(-200);
  if (db.feedback.events.length > 100) db.feedback.events = db.feedback.events.slice(-100);
  if (db.drafts.length > 50) db.drafts = db.drafts.slice(-50);
  if (db.outbox.length > 20) db.outbox = db.outbox.slice(-20);
  for (const which of ['public', 'private']) {
    const list = db.diaries[which];
    if (list.length > 40) db.diaries[which] = list.slice(-40);
    for (const entry of db.diaries[which]) {
      if (String(entry.text || '').length > 6000) entry.text = String(entry.text).slice(0, 6000);
    }
  }
  const seenKeys = Object.keys(db.seen);
  if (seenKeys.length > 800) {
    const keep = seenKeys.sort((a, b) => (Number(db.seen[a]) || 0) - (Number(db.seen[b]) || 0)).slice(-800);
    const next = {};
    for (const k of keep) next[k] = db.seen[k];
    db.seen = next;
  }
}

export function markDirty() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 700);
  if (typeof timer?.unref === 'function') timer.unref();
}

/** 立刻整份落盘（失败时裁剪后重试一次，并留一条错误给面板）。 */
export function flush() {
  if (!apiRef?.storage?.set) return false;
  if (saving) return false;
  saving = true;
  try {
    trim();
    db.meta.lastSaveAt = Date.now();
    try {
      apiRef.storage.set(KEY, db);
    } catch (error) {
      // 多半是 1MB 上限：再狠一点，日记只留 10 篇、事件只留 50 条
      db.diaries.public = db.diaries.public.slice(-10);
      db.diaries.private = db.diaries.private.slice(-10);
      db.events = db.events.slice(-50);
      db.quota = db.quota.slice(-120);
      db.drafts = db.drafts.slice(-20);
      db.meta.lastSaveAt = Date.now();
      apiRef.storage.set(KEY, db);
      lastError = `存储接近上限，已自动裁剪（${String(error?.message ?? error).slice(0, 80)}）`;
      reportError(lastError);
    }
    lastError = '';
    return true;
  } catch (error) {
    lastError = String(error?.message ?? error).slice(0, 160);
    reportError(`存储写入失败：${lastError}`);
    return false;
  } finally {
    saving = false;
  }
}

export function storageError() {
  return lastError;
}

/** 记一条结构化事件（给面板与排障看）。 */
export function addEvent(kind, note = '', target = null) {
  db.events.push({ at: Date.now(), kind: String(kind || 'event').slice(0, 32), target: target ? String(target).slice(0, 80) : null, note: String(note || '').slice(0, 300) });
  markDirty();
}

/** 当前计划/计数跨天时重置。 */
export function ensureDay(dateKey) {
  if (!db.counters || db.counters.date !== dateKey) {
    db.counters = { date: dateKey, wakes: 0, used: {} };
  }
  if (db.plan && db.plan.date !== dateKey) db.plan = null;
  if (db.notify.date !== dateKey) db.notify = { date: dateKey, count: 0, lastAt: db.notify.lastAt || 0 };
  return db.counters;
}

export function addDiary(which, entry) {
  if (which !== 'public' && which !== 'private') return;
  db.diaries[which].push(entry);
  trim();
  markDirty();
}

export function addQuota(record) {
  db.quota.push(record);
  trim();
  markDirty();
}

export function addDraft(draft) {
  db.drafts.push(draft);
  trim();
  markDirty();
}

export function findDraft(id) {
  return db.drafts.find((d) => String(d.id) === String(id)) || null;
}

export function removeDraft(id) {
  const before = db.drafts.length;
  db.drafts = db.drafts.filter((d) => String(d.id) !== String(id));
  if (db.drafts.length !== before) { markDirty(); return true; }
  return false;
}

export function queueOutbox(text) {
  db.outbox.push({ at: Date.now(), text: String(text || '').slice(0, 4000) });
  trim();
  markDirty();
}

/**
 * 把“面板需要、但不含凭据”的设置快照写进 db.meta。
 * 面板是只读 iframe，读不到宿主配置，只能从这里看当前口径。
 */
export function setSettingsSnapshot(s) {
  if (!db.meta || typeof db.meta !== 'object') db.meta = {};
  const next = {
    enabled: s.enabled === true,
    dryRun: s.dryRun === true,
    ownerQQ: Array.isArray(s.ownerQQ) ? s.ownerQQ : [],
    ownerBiliName: String(s.ownerBiliName || ''),
    ownerBiliMid: String(s.ownerBiliMid || ''),
    notifyChat: String(s.notifyChat || ''),
    windows: String(s.windows || ''),
    likeKeywords: Array.isArray(s.likeKeywords) ? s.likeKeywords.join('\n') : String(s.likeKeywords || ''),
    dislikeKeywords: Array.isArray(s.dislikeKeywords) ? s.dislikeKeywords.join('\n') : String(s.dislikeKeywords || ''),
    personaExtra: String(s.personaExtra || ''),
    personaText: String(s.personaText || ''),
    maxWakesPerDay: Number(s.maxWakesPerDay) || 0,
    shareDaily: Number(s.shareDaily) || 0,
    shareMinScore: Number(s.shareMinScore) || 0,
    sameVideoDays: Number(s.sameVideoDays) || 7,
    silentAfterDays: Number(s.silentAfterDays) || 3,
    silentStopDays: Number(s.silentStopDays) || 7,
    listenComment: s.listenComment === true,
    liveEnabled: s.liveEnabled === true,
    liveRoom: String(s.liveRoom || ''),
    llmMode: String(s.llmMode || 'auto'),
    cookieSet: Boolean(s.sessdata && s.biliJct),
    updatedAt: Date.now()
  };
  const prev = db.meta.settings || null;
  if (prev) {
    const a = JSON.stringify({ ...prev, updatedAt: 0 });
    const b = JSON.stringify({ ...next, updatedAt: 0 });
    if (a === b) return; // 设置没变就别每 60 秒写一次盘
    // 作息口径变了：还没触发的旧计划作废，下一拍按新窗口重算（已触发的不动，避免重复醒）。
    const planChanged = ['windows', 'maxWakesPerDay'].some((k) => prev[k] !== next[k]);
    if (planChanged && db.plan && db.plan.fired !== true) db.plan = null;
  }
  db.meta.settings = next;
  markDirty();
}
