// sleep-mood/index.js —— 「睡眠 · 元气 · 具身情境心境 · 旅行融合系统」主入口 (v2.0 重构版)
// ═════════════════════════════════════════════════════════════════════════════
// 重构总结（方案一 + 方案二定制落地版）：
//   1. 【双轴模型替代 11 维碎数值】：
//      · 彻底剥离 `hp-system.js`（生命值扣血/零血失忆/压力池 A·B·C）与 `favor-link.js`（35 项概率骰子）。
//      · 身体轴收敛为单一「元气值 Vitality (0~100)」，且**日常清醒与聊天绝不自然消耗元气**。
//      · 心境轴收敛为最多 2 个「具身情境 Tag（带具体事件 `why` 与过期时间）」。
//   2. 【单时钟彻底贴合旅行与庭院】：
//      · 移除 `self-state.js` 独立的室内随机日程表（SCHEDULE）与恢复掷骰子（RECOVERY-PICK）。
//      · 清醒时的当下状态 100% 由 `travel-whale` 的「在途旅行 (trip)」、「在家庭院 (homeAct)」、
//        「刚吃完特产余味 (foodAfter)」驱动，并保留 B 站刷视频分心门（`bili-watch.js`）与自我宣告账本（`her-ledger.js`）。
//      · 按定制要求：不设归途体力强制睡眠结算与出发元气门槛拦截。
//   3. 【100% 向下游兼容】：
//      · `data/mood.json`、`data/sleep-mood-moments.json`、`mood:state.shifted` 总线事件、
//        `message.inbound-gate` 与 `mood.dashboard` 契约完全保持兼容。
// ═════════════════════════════════════════════════════════════════════════════

import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { DATA_DIR, ROOT } from './lib/config.js';
import * as M from './lib/mood-chain.js';
import * as S from './lib/self-state.js';
import * as T from './lib/travel-sync.js';
import * as TS from './lib/travel-states.js';
import * as BW from './lib/bili-watch.js';
import * as TL from './lib/tone-link.js';
import { noteHerState, herStateLine } from './lib/her-ledger.js';
import { logger as coreLogger } from '../../src/logger.js';

let api = null;
let timer = null;
let ticking = false;
const TIMER_SLOT = '__qqAgentSleepMoodTimer';
const BUS_UNSUB_SLOT = '__qqAgentSleepMoodBusUnsubs';

function stopHeartbeat() {
  const prev = globalThis[TIMER_SLOT];
  if (prev) {
    try { clearInterval(prev); } catch { /* ignore */ }
    globalThis[TIMER_SLOT] = null;
  }
  if (timer) {
    try { clearInterval(timer); } catch { /* ignore */ }
    timer = null;
  }
  const unsubs = globalThis[BUS_UNSUB_SLOT];
  if (Array.isArray(unsubs)) {
    for (const fn of unsubs) {
      try { if (typeof fn === 'function') fn(); } catch { /* ignore */ }
    }
    globalThis[BUS_UNSUB_SLOT] = [];
  }
}

function wrapApiLogging(a) {
  if (!a) return a;
  return new Proxy(a, {
    get(target, prop, receiver) {
      if (prop === 'log') {
        return (...args) => {
          try { coreLogger.info('sleep-mood', ...args); } catch { try { a.log?.(...args); } catch { /* ignore */ } }
        };
      }
      if (prop === 'warn') {
        return (...args) => {
          try { coreLogger.warn('sleep-mood', ...args); } catch { try { a.warn?.(...args); } catch { /* ignore */ } }
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}

// ── 晚安回礼防误判与入睡发言守卫 ────────────────────────────────────────────
const GOODNIGHT_SIGNAL_RE = /(晚安|好梦|good\s*night|安安|去睡了|先睡了|睡啦)/i;
const GOODNIGHT_ECHO_RE = /^(?:晚安啦?|安安啦?|好梦呀?|好梦|good\s*night)/i;
const STRIP_EDGE_PUNCT_RE = /^[\s,，。！？!?~～、…]+|[\s,，。！？!?~～、…]+$/g;
const GOODNIGHT_ECHO_WINDOW_MS = 90 * 1000;
let goodnightEchoUntil = 0;

function sleepVerdictSuspect(text) {
  const t = String(text || '').trim();
  if (!t) return '空文本';
  if (/^(?:你也|快去|赶紧去|早点|乖乖)?(?:去睡吧|睡吧|休息吧|早点睡)/.test(t)) return '劝对方睡';
  if (/(?:不睡|还不困|才不睡|不想睡|别睡)/.test(t)) return '否定入睡';
  return '';
}

function detectGoodnightEcho(entries = [], { selfId = '', botName = '', selfNickname = '' } = {}) {
  for (const e of entries) {
    if (!e || e.self || e.isPoke) continue;
    const text = String(e.text || '');
    if (!text || !GOODNIGHT_SIGNAL_RE.test(text)) continue;
    try {
      if (atBot(text, { botName, selfNickname, selfId })) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ── 运行期轻量状态（命令睡眠 + 被吵醒陪闹窗口）──────────────────────────────
let commandSleep = false;
let turnSenders = [];
let turnOwnerSpeaks = false;
let lastSender = null;
let lastChatKey = '';
let lastOrchestrator = null;
let lastDiag = {};
const gateByChat = new Map();

// 轻量内联「被吵醒概率 & 陪闹窗口」（原 hp-system 中唯一有用的睡眠互动体验，无扣血副作用）
let wakePlayWindow = { active: false, left: 0, until: 0, chatKey: '', attempts: 0, windowAt: 0 };

function playActive(now = Date.now()) {
  if (!wakePlayWindow.active) return null;
  if (now >= wakePlayWindow.until || wakePlayWindow.left <= 0) {
    wakePlayWindow.active = false;
    return null;
  }
  return wakePlayWindow;
}

function rollWakeAttempt(s = {}, now = Date.now()) {
  if (now - wakePlayWindow.windowAt > 30 * 60_000) {
    wakePlayWindow.windowAt = now;
    wakePlayWindow.attempts = 0;
  }
  wakePlayWindow.attempts += 1;
  const baseChance = Math.max(10, Math.min(100, Number(s.wakeChancePercent ?? 50)));
  // 同一半小时内连续被吵醒，醒来概率递减
  const chance = Math.max(10, Math.round(baseChance * Math.pow(0.75, wakePlayWindow.attempts - 1)));
  const allow = Math.random() * 100 < chance;
  return { allow, chance, count: wakePlayWindow.attempts };
}

const on = (v) => v !== false;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function settings() {
  try { return (api && typeof api.config === 'function' ? api.config() : null) || {}; } catch { return {}; }
}

function engineCfg() {
  const s = settings();
  if (!on(s.enabled)) return { moodChain: { enabled: false }, selfState: { enabled: false } };
  return {
    moodChain: {
      enabled: true,
      vitality: {
        sleepRecoverPerHour: num(s.sleepRecoverPerHour, 22),
        lowHintThreshold: num(s.vitalityLowThreshold, 45),
        sleepyThreshold: num(s.vitalitySleepyThreshold, 20)
      }
    },
    selfState: { enabled: on(s.selfState) }
  };
}

// ── 旅行 / 庭院 / 特产余味 / 旅途瞬间只读同步 ────────────────────────────────

function travelActive(now = Date.now()) {
  try {
    const s = settings();
    if (s.travelSync === false) return null;
    return T.activeTrip(s.travelGroups, now);
  } catch { return null; }
}

function homeActive(now = Date.now()) {
  try {
    const s = settings();
    if (s.travelSync === false) return null;
    const raw = s.travelGroups;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\r\n,，、;；|]+/))
      .map((x) => T.normalizeChatKey(x)).filter(Boolean);
    for (const k of list) {
      const h = T.homeOf(k, now);
      if (h) return h;
    }
    return null;
  } catch { return null; }
}

function foodAfterActive(now = Date.now()) {
  try {
    const s = settings();
    if (s.travelSync === false) return null;
    const raw = s.travelGroups;
    const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\r\n,，、;；|]+/))
      .map((x) => T.normalizeChatKey(x)).filter(Boolean);
    let best = null;
    for (const k of list) {
      const fa = T.foodAfterOf(k, now);
      if (fa && (!best || Number(fa.at) > Number(best.at))) best = fa;
    }
    return best;
  } catch { return null; }
}

const MOMENTS_FILE = 'sleep-mood-moments.json';
const MOMENT_KEEP_DAYS = 14;
let momentsCache = null;

function momentsState() {
  if (momentsCache) return momentsCache;
  try {
    const j = JSON.parse(nodeFs.readFileSync(nodePath.join(DATA_DIR, MOMENTS_FILE), 'utf8'));
    momentsCache = (j && Array.isArray(j.items)) ? j : { version: 1, items: [] };
  } catch {
    momentsCache = { version: 1, items: [] };
  }
  return momentsCache;
}

function saveMoments(m) {
  try {
    const file = nodePath.join(DATA_DIR, MOMENTS_FILE);
    const tmp = `${file}.tmp.${process.pid}`;
    nodeFs.writeFileSync(tmp, JSON.stringify(m));
    nodeFs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function travelKeys() {
  const raw = settings().travelGroups;
  const list = (Array.isArray(raw) ? raw : String(raw || '').split(/[\r\n,，、;；|]+/))
    .map((x) => T.normalizeChatKey(x)).filter(Boolean);
  if (list.length) return list;
  try {
    return nodeFs.readdirSync(T.chatsDir())
      .filter((f) => /^group_?\d/.test(f))
      .map((f) => `group:${f.replace(/^group_?/, '').replace(/\.json$/, '')}`);
  } catch { return []; }
}

/**
 * 每 20 分钟一挡记录旅途瞬间（供 `mind-wish` 与 `qqzone` 写日记使用），
 * 若该瞬间带情绪色彩，同步挂载轻量具身情境 Tag。
 */
export function recordTravelMoments(now = Date.now()) {
  if (settings().travelSync === false) return 0;
  const keys = travelKeys();
  if (!keys.length) return 0;
  const m = momentsState();
  const added = [];
  const moodHits = [];

  for (const key of keys) {
    let trip = null;
    let st = null;
    try {
      trip = T.tripOf(key, now);
      if (!trip) continue;
      st = TS.pickState(trip, now);
    } catch { st = null; }
    if (!st) continue;
    const mine = [...m.items].reverse().find((x) => x.key === key);
    if (mine && Number(mine.bucket) === Number(st.bucket)) continue;
    m.items.push({
      at: now,
      key,
      bucket: Number(st.bucket) || 0,
      id: String(st.id || ''),
      act: String(st.act || ''),
      detail: String(st.detail || ''),
      phase: String(st.phase || ''),
      world: String(st.world || ''),
      place: String(st.place || ''),
      mate: String(trip.companionName || '')
    });
    added.push(String(st.act || st.id || '?'));
    try {
      const mood = (typeof TS.stateMoodOf === 'function') ? TS.stateMoodOf(st) : null;
      if (mood && Object.keys(mood).length) {
        moodHits.push({ mood, act: String(st.act || st.id || '?'), place: String(st.place || '') });
      }
    } catch { /* ignore */ }
  }
  if (!added.length) return 0;
  const cut = now - MOMENT_KEEP_DAYS * 86400000;
  m.items = m.items.filter((x) => Number(x.at) >= cut);
  saveMoments(m);

  for (const { mood, act, place } of moodHits) {
    try {
      const why = `旅途瞬间：在${place || '路上'}${act}`;
      M.stepMood(mood, { happy: why, excited: why, sad: why, angry: why }, engineCfg(), now);
    } catch { /* ignore */ }
  }
  return added.length;
}

/**
 * 结算 `travel-whale` 产生的真实事件（明信片、特产、战斗、穿越、庭院小事）：
 * 直接驱动【元气值 Vitality】与【具身情境 Tag】，并向 `courtyard.bus` 广播 `mood:state.shifted`。
 */
function applyTravelEventMood(now = Date.now()) {
  if (!on(settings().travelEventMood)) return 0;
  const r = T.newTravelEvents(settings().travelGroups, T.readMoodCursor(), now);
  if (!r.events.length) return 0;
  let n = 0;
  for (const ev of r.events) {
    const def = T.TRAVEL_EVENT_MOOD[ev.kind];
    if (!def) continue;
    const why = T.eventWhy(ev);
    try {
      // ① 元气值变化（由具体旅途/庭院事件驱动）
      let vitDelta = num(def.vitalityDelta, 0);
      if (ev.kind === 'home-act' && ev.deltas) {
        const fDelta = num(ev.deltas.fatigue, 0);
        if (fDelta !== 0) vitDelta = -fDelta;
      }
      if (vitDelta !== 0) {
        M.stepVitality(vitDelta, why, now);
      }

      // ② 具身情境 Tag 挂载
      if (ev.kind === 'home-act') {
        if (ev.deltas && Object.keys(ev.deltas).length) {
          M.stepMood(ev.deltas, why, engineCfg(), now);
        }
      } else if (def.tag) {
        M.pushMoodTag({
          tag: def.tag,
          tone: def.tone || 'good',
          category: def.category || 'happy',
          level: def.tone === 'bad' ? 68 : 74,
          why,
          source: 'travel',
          ttlMs: num(def.ttlMin, 180) * 60_000,
          now
        });
      }

      try {
        api?.capability?.('courtyard.bus')?.publish?.('mood:state.shifted', {
          kind: ev.kind,
          tag: def.tag || '庭院闲适',
          vitalityDelta: vitDelta,
          why,
          at: now
        });
      } catch { /* ignore */ }
      n += 1;
    } catch (e) {
      try { api?.warn?.('旅行事件结算失败', e?.message ?? e); } catch { /* ignore */ }
    }
  }
  T.writeMoodCursor(r.cursor);
  if (n) {
    try { api?.log?.(`旅行与庭院事件已结算 ${n} 条 → 更新元气与情境心境`); } catch { /* ignore */ }
  }
  return n;
}

// ── 睡眠与唤醒公共出口 ──────────────────────────────────────────────────────

function currentSleep(now = Date.now()) {
  if (commandSleep) {
    return { sleeping: true, kind: 'command', status: 'sleeping', what: '', reason: '命令睡眠（/睡觉）' };
  }
  let st = { status: 'awake', what: '' };
  try { st = S.readSelfState(now) || st; } catch { /* ignore */ }
  if (st.status === 'sleeping') {
    return { sleeping: true, kind: 'natural', status: 'sleeping', what: String(st.what || ''), reason: '自然睡眠（她自己困了）' };
  }
  return { sleeping: false, kind: 'none', status: 'awake', what: String(st.what || ''), reason: '' };
}

// ── 睡眠状态广播（2026-10-25）──────────────────────────────────────────────
// 为什么要它：订阅方（plugins/autobiography）原先只能每 60 秒轮询 dashboard / self-state
// 才知道"她睡了"，命令睡眠尤其要多等一个心跳。这里把状态变化**推**出去，收到即处理。
// 幂等：只在三态（awake / command / natural）真的变化时发一次，不会每次 tick 都刷。
// 降级红线：总线不在 / 订阅方抛错都不影响睡眠本身（publish 内部逐订阅者 catch）。
const SLEEP_STATES = { awake: 'awake', command: 'command', natural: 'natural' };
let lastSleepState = null;
function publishSleepState(now = Date.now()) {
  try {
    const sl = currentSleep(now);
    const cur = sl.sleeping ? (sl.kind === 'command' ? SLEEP_STATES.command : SLEEP_STATES.natural) : SLEEP_STATES.awake;
    if (cur === lastSleepState) return;
    lastSleepState = cur;
    api?.capability?.('courtyard.bus')?.publish?.('sleep:state.changed', {
      state: cur,
      sleeping: !!sl.sleeping,
      kind: sl.kind || 'none',
      what: sl.what || '',
      at: now
    });
  } catch { /* 总线没装/没开就当无事发生 */ }
}

function resolveOwnerQq() {  const explicit = String(settings().ownerQq || '').trim();
  if (/^\d{5,12}$/.test(explicit)) return explicit;
  try {
    const r = api.capability('message.owner-check', {});
    if (r && Array.isArray(r.owners) && r.owners.length) return String(r.owners[0]);
    if (r && r.ownerId) return String(r.ownerId);
  } catch { /* ignore */ }
  return '';
}

export function parseWakeWords(raw) {
  return String(raw || '')
    .split(/[\s,，、;；\n\r]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

export function parseKeywords(raw) {
  return parseWakeWords(raw);
}

export function keywordHit(text, words) {
  const t = String(text || '');
  if (!t || !Array.isArray(words) || !words.length) return '';
  for (const w of words) {
    if (w && t.includes(w)) return w;
  }
  return '';
}

export function stripQuote(text) {
  return M.stripQuoteForMatch(text);
}

function keywordsOf(rawList, legacyCmd, fallback) {
  const parsed = parseKeywords(rawList);
  if (parsed.length) return parsed;
  const legacy = String(legacyCmd || '').trim();
  if (legacy) return [legacy];
  return fallback ? [fallback] : [];
}

export function ownerWakeHit(entries, ownerQq, words) {
  const owner = String(ownerQq || '').trim();
  if (!owner || !Array.isArray(words) || !words.length) return null;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    if (String(e.senderId || '') !== owner) continue;
    const text = String(e.text ?? '');
    if (!text) continue;
    const hit = words.find((w) => text.includes(w));
    if (hit) return { hit, text };
  }
  return null;
}

function atBot(text, { botName = '', selfNickname = '', selfId = '' } = {}) {
  const src = String(text ?? '');
  if (!src) return false;
  if (selfNickname && src.includes(`@${selfNickname}`)) return true;
  if (botName && src.includes(`@${botName}`)) return true;
  if (selfId) {
    const esc = String(selfId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[CQ:at(?:,[^\\]]*?)?qq=${esc}[^\\]]*\\]`);
    if (re.test(src)) return true;
  }
  return false;
}

function wakeUp({ reason = '' } = {}) {
  const before = currentSleep();
  const wasCommand = commandSleep;
  let wasNatural = false;
  commandSleep = false;
  wakePlayWindow.active = false;

  try {
    const st = S.readSelfState();
    if (st.status === 'sleeping') {
      wasNatural = true;
      S.writeSelfState({ status: 'awake', what: '', at: st.at, wakeAt: Date.now() });
    }
    M.markFatigueSleep(false, Date.now());
  } catch { /* ignore */ }

  gateByChat.clear();
  publishSleepState();   // 醒来也要广播（订阅方据此解除"睡前"语境）
  return { woke: wasCommand || wasNatural, wasCommand, wasNatural, before, reason };
}

// ★ 分发包**不带任何预置昵称**：这里的默认值必须是空的。
//   出厂默认里塞一批具体叫法，等于把某一个群的称呼习惯带给所有买家（而且很容易误伤）。
//   ⇒ 留空时只用「她的群名片 + botName」；想加自己的叫法，请买家在设置 `addressNames` 里填。
//   ⚠️ 也别填单字或"妹妹/姐姐"这类泛称 —— 命中率太高，会把别人的话误当成在叫她。
const DEFAULT_ADDRESS_NAMES = '';

function selfNamesOf(ctx) {
  const base = [ctx && ctx.selfNickname, ctx && ctx.botName]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const raw = settings().addressNames;
  const extra = parseWakeWords(raw === undefined || raw === null ? DEFAULT_ADDRESS_NAMES : raw);
  return [...new Set([...base, ...extra])];
}

function block(out, fn, ...args) {
  try {
    const t = fn(...args);
    if (t && String(t).trim()) out.push(String(t).trim());
  } catch { /* ignore */ }
}

// ── 面板快照与后台心跳 ──────────────────────────────────────────────────────

function dashboardFile() {
  return nodePath.join(ROOT, 'ui', 'mood-dashboard.json');
}

export function dashboardSnapshot() {
  const now = Date.now();
  const cfg = engineCfg();
  const snap = M.moodSnapshot(cfg, now);
  let self = { status: 'awake', what: '', at: 0 };
  try { self = S.readSelfState(now) || self; } catch { /* ignore */ }
  const selfOut = { status: String(self.status || 'awake'), what: String(self.what || ''), at: Number(self.at) || 0 };
  try {
    const tv = travelActive(now);
    if (tv) {
      selfOut.whatBase = selfOut.what;
      selfOut.what = T.travelShort(tv, now);
      selfOut.travel = T.travelPublic(tv, now);
    } else {
      const hv = homeActive(now);
      if (hv) {
        selfOut.whatBase = selfOut.what;
        selfOut.what = T.homeShort(hv);
        selfOut.home = T.homePublic(hv, now);
      }
    }
  } catch { /* ignore */ }

  const sleep = currentSleep(now);
  const vitality = snap.vitality;
  const fatigue = snap.fatigue;
  const moods = snap.moods || {};
  const tags = snap.activeTags || [];

  return {
    ok: true,
    version: '2.0.1-travel-vitality',
    at: now,
    enabled: !!api && on(settings().enabled),
    commandSleep,
    sleep,
    self: selfOut,
    vitality,
    activeTags: tags,
    dominant: snap.dominant
      ? { emotion: snap.dominant.emotion, word: snap.dominant.word, level: snap.dominant.level, why: snap.dominant.why }
      : { emotion: 'calm', word: '平静', level: 0, why: '' },
    moods,
    meters: { vitality, fatigue, spunk: 0, depress: 0, satisfaction: snap.satisfaction },
    // ★ 兼容补丁（2026-10-25）：宿主面板（ui/app/14-integrated.js 与 settings-ui.js）
    //   仍在直接读 d.hp / d.favor。本版已经没有生命值与好感联动，若不补这两个键，
    //   面板会显示「❤️ 生命值 0/0」——看起来像她血空了，极易被误判成故障。
    //   这里补的是**展示用兼容形状**：hp 用元气折算（removed 标记它已不是独立系统），
    //   favor 恒为关闭。两个前端也已同步改成优先读 vitality / activeTags。
    hp: {
      value: vitality,
      max: 100,
      critical: false,
      weak: vitality <= num(settings().vitalitySleepyThreshold, 20),
      stress: 0,
      load: 0,
      playing: false,
      removed: true
    },
    favor: { enabled: false, hpBonus: false, removed: true },
    systems: {
      sleep: { sleeping: !!sleep.sleeping, kind: sleep.kind || 'none', what: sleep.what || '' },
      mood: { vitality, activeTags: tags, dominant: snap.dominant || null, moods, meters: { vitality, fatigue, satisfaction: snap.satisfaction } }
    }
  };
}

function publishDashboard(extra = {}) {
  try {
    const payload = { ...dashboardSnapshot(), ...extra, publishedAt: Date.now() };
    const file = dashboardFile();
    const tmp = `${file}.tmp.${process.pid}`;
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    nodeFs.renameSync(tmp, file);
  } catch { /* ignore */ }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!on(settings().enabled)) return;
    const now = Date.now();
    const cfg = engineCfg();
    const sleep = currentSleep(now);
    publishSleepState(now);   // 状态变了就广播（订阅方：autobiography 睡前沉淀等）

    // ① 睡眠期间恢复元气（清醒期间 stepFatigue 不扣任何元气）
    try { M.stepFatigue({ sleeping: sleep.sleeping, cfg, now }); } catch { /* ignore */ }
    // ② 轮询结算 travel-whale 的新事件（明信片/特产/战斗/庭院小事）
    try { applyTravelEventMood(now); } catch { /* ignore */ }
    // ③ 记录 20 分钟一挡的旅途瞬间
    try { recordTravelMoments(now); } catch { /* ignore */ }

    publishDashboard();
  } finally {
    ticking = false;
  }
}

function resumeOrchestrator() {
  try {
    return lastOrchestrator?.resumeAll?.({ limit: Math.max(1, Number(settings().resumeCount) || 20) }) ?? 0;
  } catch { return 0; }
}

// ── 自然口吻入睡/唤醒确认句生成 ──────────────────────────────────────────────

function sanitizeSleepLine(raw, maxLen = 60) {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^["'“”‘’「『【]+/, '').replace(/["'“”‘’」』】]+$/, '').trim();
  if (!t) return '';
  if (/(存档|不回复|零 ?token|提示词|系统|指令|机制|代码|插件|模型|会话|积压|线程|条数)/.test(t)) return '';
  if (t.length > maxLen) return '';
  return t;
}

let llmModuleLoader = () => import('../../src/llm.js');

async function callModel({ system = '', prompt = '', temperature = null, maxTokens = 512 } = {}) {
  try {
    const r = await api?.capability?.('ai.ask', { system, prompt, temperature, maxTokens });
    const text = String(r?.text ?? '').trim();
    if (text) return { text, via: 'ai.ask' };
  } catch { /* fallback to llm.js */ }
  try {
    const { chatCompletionWithRetry } = await llmModuleLoader();
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt }
    ];
    const r = await chatCompletionWithRetry({ messages, temperature, maxTokens });
    let text = String(r?.message?.content ?? '').trim();
    // ★ 思考预算补丁（2026-10-25，从 v1 index.js:1561-1572 搬回）：
    //   本机主模型是**思考模型**，reasoning_content 先吃 token 预算 —— 实测 maxTokens=120 时
    //   `completion_tokens=120 / reasoning_tokens=120 / finishReason='length' / content 全空`
    //   ⇒ 入睡/起床应答每次都退回固定模板。命中"被推理吃光"就放大预算重试一次，
    //   仍然空才算真失败。v2 精简时把这段丢了，会偶发"像系统通知"的模板句。
    if (!text && String(r?.finishReason ?? '').toLowerCase().startsWith('len')) {
      const bigger = Math.max(2048, (Number(maxTokens) || 0) * 4);
      const r2 = await chatCompletionWithRetry({ messages, temperature, maxTokens: bigger });
      const t2 = String(r2?.message?.content ?? '').trim();
      if (t2) {
        try { api?.log?.(`应答文案：首次被推理吃光预算（maxTokens=${maxTokens}）→ 用 ${bigger} 重试成功`); } catch { /* 忽略 */ }
        return { text: t2, via: 'llm.js' };
      }
      return { text: '', via: 'llm.js', error: '模型返回空（放大预算重试后仍空）' };
    }
    return text ? { text, via: 'llm.js' } : { text, via: 'llm.js', error: '模型返回空' };
  } catch (e) {
    return { text: '', via: 'none', error: String(e?.message ?? e) };
  }
}

async function makeSleepLine({ triggerText = '', fallback = '' } = {}) {
  const s = settings();
  if (s.naturalConfirm === false) return fallback;
  const brief = String(s.sleepLineBrief || '').trim();
  if (!brief) return fallback;
  try {
    // ★ 2026-10-25：不再把 sleepLineExamples 拼进 system —— 台词示例是"替她写口吻"的残留物。
    //   brief 里已经说清了"一句话、口语、25 字内"，剩下的语气由她自己拿。
    //   （配置项保留：老配置不报错，只是不再被读。）
    const r = await callModel({
      system: brief,
      prompt: `对方刚对你说：${triggerText || '（去睡吧）'}\n只输出你要发出去的那一句话本身，不要引号或解释。`,
      temperature: 1,
      maxTokens: 512
    });
    return sanitizeSleepLine(r.text) || fallback;
  } catch {
    return fallback;
  }
}

async function makeWakeLine({ triggerText = '', touched = 0, fallback = '' } = {}) {
  const s = settings();
  if (s.naturalConfirm === false) return fallback;
  const brief = String(s.wakeLineBrief || '').trim();
  if (!brief) return fallback;
  try {
    // ★ 2026-10-25：同上，不再拼 wakeLineExamples。
    const hint = touched > 0
      ? '你睡着这段时间有人找过你。可以顺口带一句“好像有人找我”，但绝不要报数字。'
      : '你睡着这段时间没人找你。';
    const r = await callModel({
      system: brief,
      prompt: `对方刚把你叫醒，说的是：${triggerText || '（起床）'}\n${hint}\n只输出你要发出去的那一句话本身，不要引号或解释。`,
      temperature: 1,
      maxTokens: 512
    });
    return sanitizeSleepLine(r.text, 40) || fallback;
  } catch {
    return fallback;
  }
}

function confirmText(sender, chatKey, text) {
  if (!chatKey || !sender || !text) return;
  Promise.resolve()
    .then(() => sender.sendTextBatch(chatKey, [text]))
    .catch(() => {});
}

// ── 生命周期与事件总线订阅 ──────────────────────────────────────────────────

export function setup(a) {
  api = wrapApiLogging(a);
  try { M.migrateStateOnce(); } catch { /* ignore */ }
  registerMoodTools(a);
}

export function available() {
  if (!on(settings().enabled)) return { ok: false, reason: '插件已关闭' };
  return { ok: true };
}

export function activate() {
  stopHeartbeat();
  const s = settings();
  if (!on(s.enabled)) return;
  const everySec = Math.min(600, Math.max(15, Number(s.tickSeconds) || 60));
  timer = setInterval(() => { tick().catch(() => {}); }, everySec * 1000);
  timer.unref?.();
  globalThis[TIMER_SLOT] = timer;

  // 若装了 courtyard-bus，实时订阅旅途事件立即刷新心境与元气
  try {
    const bus = api?.capability?.('courtyard.bus');
    if (bus && typeof bus.subscribe === 'function') {
      const u1 = bus.subscribe('whale:trip.event', () => { try { applyTravelEventMood(Date.now()); } catch {} });
      const u2 = bus.subscribe('whale:souvenir.eaten', () => { try { applyTravelEventMood(Date.now()); } catch {} });
      globalThis[BUS_UNSUB_SLOT] = [u1, u2].filter(Boolean);
    }
  } catch { /* ignore */ }

  const snap = M.moodSnapshot(engineCfg(), Date.now());
  api.log(`睡眠·元气·旅行心境系统 v2.0 已启用：元气 ${snap.vitality}/100 · 活跃心境 ${snap.activeTags.length} 个`);
  publishDashboard();
}

export function deactivate() {
  try { publishDashboard({ enabled: false }); } catch { /* ignore */ }
  stopHeartbeat();
  if (commandSleep) {
    try { resumeOrchestrator(); } catch { /* ignore */ }
  }
  commandSleep = false;
  gateByChat.clear();
}

export function dispose() {
  deactivate();
}

export function debugGates() {
  const sleep = currentSleep();
  return {
    apiSet: !!api,
    settings: settings(),
    sleep: { ...sleep, commandSleep, cachedGates: gateByChat.size },
    gates: [...gateByChat.entries()].map(([chatKey, g]) => ({ chatKey, ...(g || {}) })),
    lastContext: lastDiag
  };
}

// ── Providers (message.inbound-gate & mood.dashboard) ───────────────────────

export const providers = {
  'message.inbound-gate': ({
    kind, chatKey, text = '', senderId = '', store, orchestrator, sender, onebot, botName = ''
  } = {}) => {
    if (sender) lastSender = sender;
    if (chatKey) lastChatKey = chatKey;
    if (orchestrator) lastOrchestrator = orchestrator;

    const c = settings();
    const resumeCount = Math.max(1, Number(c.resumeCount) || 20);
    const confirm = c.confirm !== false;
    const hard = c.commandSleepHard !== false;
    const selfNickname = onebot?.selfNickname || '';
    const selfId = onebot?.selfId || '';
    const matchText = stripQuote(text);

    const sleepWords = keywordsOf(c.sleepKeywords, c.sleepCommand, '/睡觉');
    const wakeWords = keywordsOf(c.wakeKeywords, c.wakeCommand, '/起床');
    const atMe = atBot(text, { botName, selfNickname, selfId });
    const ownerQq = resolveOwnerQq();
    const isOwner = !!ownerQq && String(senderId) === ownerQq;

    // 陪闹窗口激活期间放行
    const play = playActive(Date.now());
    if (play && !commandSleep && (!play.chatKey || String(play.chatKey) === String(chatKey))) {
      return { blocked: false };
    }

    // ① 命令睡眠中
    if (commandSleep) {
      const wakeHit = kind === 'group' && atMe ? keywordHit(matchText, wakeWords) : '';
      const ownerLocked = c.lockWakeToOwner === true;
      if (wakeHit && (!ownerLocked || isOwner)) {
        wakeUp({ reason: '命令唤醒关键词' });
        let touched = 0;
        try { touched = orchestrator?.resumeAll?.({ limit: resumeCount }) ?? 0; } catch { /* ignore */ }
        if (confirm) {
          makeWakeLine({ triggerText: text, touched, fallback: '唔…我醒啦～' })
            .then((line) => confirmText(sender, chatKey, line))
            .catch(() => {});
        }
        return { blocked: false };
      }

      if (kind === 'group' || kind === 'private') {
        const w = ownerWakeHit([{ senderId, text, self: false }], ownerQq, parseWakeWords(c.wakeWords));
        if (w) {
          wakeUp({ reason: '主人起床口令' });
          try { orchestrator?.resumeAll?.({ limit: resumeCount }); } catch { /* ignore */ }
          return { blocked: false };
        }
      }

      if (!hard && kind === 'group' && atMe) {
        if (S.isWakeCall([{ senderId, text, isAtMe: true }], { selfNickname, botName, selfId, isPrivate: kind === 'private' })) {
          return { blocked: false };
        }
      }
      return { blocked: true };
    }

    // ② 命令睡眠未开：检查是否触发命令睡眠
    const sleepHit = kind === 'group' && atMe ? keywordHit(matchText, sleepWords) : '';
    const sleepLocked = c.lockSleepToOwner !== false;
    if (sleepHit && (!sleepLocked || isOwner)) {
      let ok = false;
      try { ok = orchestrator?.suspendAll?.() === true; } catch { /* ignore */ }
      commandSleep = true;
      try { M.markFatigueSleep(true, Date.now()); } catch { /* ignore */ }
      gateByChat.clear();
      publishSleepState();   // 立即广播：不必等下一次 60s 心跳
      if (confirm) {
        makeSleepLine({ triggerText: text, fallback: '好困…那我先去睡一会儿～' })
          .then((line) => confirmText(sender, chatKey, line))
          .catch(() => {});
      }
      return { blocked: true };
    }

    // ③ 自然睡眠中：未喊醒直接底层拦截（零 Token）
    const sleep = currentSleep();
    if (sleep.sleeping && sleep.kind === 'natural' && c.ignoreWhileSleeping !== false) {
      const wHit = kind === 'group' && atMe ? keywordHit(text, wakeWords) : '';
      if (wHit && (c.lockWakeToOwner !== true || isOwner)) {
        wakeUp({ reason: '自然睡眠唤醒关键词' });
        return { blocked: false };
      }

      const words = parseWakeWords(c.wakeWords);
      if (words.length && ownerWakeHit([{ senderId, text, self: false }], ownerQq, words)) {
        wakeUp({ reason: '自然睡眠主人口令' });
        return { blocked: false };
      }

      let woken = false;
      try {
        woken = S.isWakeCall([{ senderId, text, isAtMe: atMe }], { selfNickname, botName, selfId, isPrivate: kind === 'private' });
      } catch { woken = false; }

      if (woken) {
        const nowW = Date.now();
        const att = rollWakeAttempt(c, nowW);
        // 被强行吵醒消耗一点元气
        M.stepVitality(-6, att.allow ? '睡觉被吵醒' : '睡梦中被打扰', nowW);
        if (!att.allow) {
          M.pushMoodTag({
            tag: '起床气咕哝',
            tone: 'bad',
            category: 'angry',
            level: 60,
            why: '睡得正香被吵到',
            source: 'sleep',
            ttlMs: 45 * 60_000,
            now: nowW
          });
          if (on(c.wakeFailReplyEnabled)) {
            confirmText(sender, chatKey, '唔…让我再睡五分钟…（把被子拉上来蒙住头）');
          }
          return { blocked: true };
        }
        // 成功吵醒：若开启陪闹，给 3 条回复窗口，之后自动回睡
        const maxReplies = Math.max(0, Math.round(num(c.playAlongMaxReplies, 3)));
        if (on(c.playAlongEnabled) && maxReplies > 0) {
          wakePlayWindow = {
            active: true,
            left: maxReplies,
            until: nowW + 15 * 60_000,
            chatKey,
            attempts: att.count,
            windowAt: wakePlayWindow.windowAt || nowW
          };
        }
        return { blocked: false };
      }

      let backlog = 0;
      try { backlog = Number(store?.unreadCount?.(chatKey)) || 0; } catch { /* ignore */ }
      try { api?.log?.(`自然睡眠静默拦截：${chatKey}（未读积压 ${backlog} 条）`); } catch { /* ignore */ }
      return { blocked: true };
    }

    return { blocked: false };
  },

  'mood.dashboard': () => dashboardSnapshot()
};

export const internals = {
  publishStatus: () => { try { publishDashboard(); return true; } catch { return false; } },
  snapshot: () => { try { return dashboardSnapshot(); } catch { return null; } },
  sleepLine: { generate: (o) => makeSleepLine(o), sanitize: (t) => sanitizeSleepLine(t) },
  wakeLine: { generate: (o) => makeWakeLine(o), sanitize: (t, n) => sanitizeSleepLine(t, n) },
  setLlmLoader: (fn) => { llmModuleLoader = typeof fn === 'function' ? fn : (() => import('../../src/llm.js')); },
  addressNames: (ctx = {}) => { try { return selfNamesOf(ctx); } catch { return []; } },
  detectGoodnightEcho: (entries, opts) => detectGoodnightEcho(entries, opts),
  debug: () => { try { return debugGates(); } catch { return null; } }
};

// ── Hooks (before-context / before-llm-messages / before-tool / after-tool) ──

export const hooks = {
  'before-context'(ctx = {}) {
    const s0 = settings();
    lastDiag = {
      apiSet: !!api,
      enabled: s0.enabled,
      chatKey: ctx.chatKey,
      kind: ctx.kind,
      commandSleep
    };
    turnSenders = (Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [])
      .filter((e) => e && !e.self)
      .map((e) => String(e.senderId || ''));
    turnOwnerSpeaks = false;
    if (!on(s0.enabled)) return;

    const cfg = engineCfg();
    const chatKey = String(ctx.chatKey || '');
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    const selfNames = selfNamesOf(ctx);
    const selfId = String(ctx.selfId || '');
    const ownerQq = resolveOwnerQq();
    turnOwnerSpeaks = !!ownerQq && turnSenders.includes(ownerQq);

    try {
      if (detectGoodnightEcho(entries, {
        selfId,
        botName: String(ctx.botName || ''),
        selfNickname: String(ctx.selfNickname || selfNames[0] || '')
      })) {
        goodnightEchoUntil = Date.now() + GOODNIGHT_ECHO_WINDOW_MS;
      }
    } catch { /* ignore */ }

    // ① 观察对话互动（挂载被夸奖/被惹毛/吃醋等具身 Tag）
    try {
      M.observeTrigger(entries, { chatKey, cfg, ownerQq, selfNames, selfId, now: Date.now() });
    } catch { /* ignore */ }

    // ② 主人起床口令检查
    try {
      const words = parseWakeWords(s0.wakeWords);
      if (words.length && ownerWakeHit(entries, ownerQq, words)) {
        const before = currentSleep();
        if (before.sleeping) {
          const r = wakeUp({ reason: '主人起床口令' });
          if (r.wasCommand) resumeOrchestrator();
        }
      }
    } catch { /* ignore */ }

    // ③ 睡眠内层闸 + B站刷视频分心门
    if (on(s0.blockWhileSleeping) && !commandSleep) {
      try {
        const g = S.sleepGate({
          entries,
          selfNickname: String(ctx.selfNickname || ''),
          botName: String(ctx.botName || ''),
          selfId,
          cfg,
          isPrivate: ctx.kind === 'private'
        });
        gateByChat.set(chatKey, g);
        if (playActive(Date.now())) gateByChat.delete(chatKey);
      } catch {
        gateByChat.delete(chatKey);
      }
    } else {
      gateByChat.delete(chatKey);
    }

    if (on(s0.phoneGate) && !commandSleep) {
      const cur = gateByChat.get(chatKey);
      if (!cur?.block && !playActive(Date.now())) {
        try {
          const pg = BW.phoneGate({
            chatKey,
            entries,
            selfNickname: String(ctx.selfNickname || ''),
            botName: String(ctx.botName || ''),
            isPrivate: chatKey.startsWith('private:'),
            baseChance: Number(s0.phoneIgnoreChance),
            selfDecide: s0.phoneSelfDecide !== false
          });
          if (pg?.block) gateByChat.set(chatKey, pg);
          else if (cur) gateByChat.delete(chatKey);
        } catch { /* ignore */ }
      }
    }

    publishDashboard();
  },

  'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (!on(s.enabled) || !on(s.inject)) return;
    const messages = ctx.messages;
    if (!Array.isArray(messages) || !messages.length) return;

    const now = Date.now();
    const cfg = engineCfg();
    const out = [];

    // ① 具身情境心境 Tag + 元气状态 + 醋意微澜
    block(out, M.moodChainBlock, cfg, now);
    block(out, M.fatigueBlock, cfg, now);
    block(out, M.jealousyTierBlock, cfg, now);

    // ② 她自己刚说出口的近况账本（her-ledger）
    try {
      const ctxChatKey = String(ctx.chatKey || '');
      if (ctxChatKey) lastChatKey = ctxChatKey;
      const ledgerLine = herStateLine({ isPrivate: ctx.kind === 'private', chatKey: ctxChatKey });
      if (ledgerLine) out.push(ledgerLine);
    } catch { /* ignore */ }

    // ③ 陪闹窗口提醒（只陈述状态：本来在睡、被叫醒、答应陪几句、还剩几条）
    //    ★ 2026-10-25 改：原来还写着"语气带着困意和宠溺，别越聊越亢奋" —— 那是在
    //    替她决定语气。现在只给事实，怎么说话她自己定。
    const play = playActive(now);
    if (play) {
      out.push(`【状态】本来在睡觉，被叫醒后答应陪对方聊几句（还剩 ${play.left} 条就回去睡）。`);
    }

    // ④ 单时钟空间与活动状态：刚被叫醒优先级最高，其次【在路上 (travel)】 vs 【在庭院 (home)】，叠加【刚吃完 (foodAfter)】与【手上刷B站】
    if (on(s.selfState)) {
      let selfLine = '';
      try { selfLine = S.selfStateBlock(cfg, now); } catch { selfLine = ''; }
      const isWake = !!selfLine && /刚被叫醒|睡眠中被惊动/.test(selfLine);

      let travelLine = null;
      let travelFact = '';
      try {
        const tv = travelActive(now);
        if (tv) {
          if (isWake) travelFact = T.travelFactLine(tv);
          else travelLine = T.travelPromptText(tv, now);
        }
      } catch { /* ignore */ }

      if (travelLine) {
        out.push(travelLine);
      } else {
        if (selfLine) out.push(selfLine);
        if (travelFact) out.push(travelFact);
        if (!isWake) {
          try {
            const hv = homeActive(now);
            if (hv) {
              const hl = T.homePromptText(hv, now);
              if (hl) out.push(hl);
            }
          } catch { /* ignore */ }
        }
      }

      // 叠加「刚吃完」特产余味
      try {
        const fa = foodAfterActive(now);
        if (fa) {
          const faLine = T.foodAfterPromptText(fa, now);
          if (faLine) out.push(faLine);
        }
      } catch { /* ignore */ }

      // 叠加「手上在刷 B 站」
      try {
        const bwLine = BW.biliWatchPromptText(now);
        if (bwLine) {
          const st = S.readSelfState(now);
          if (!st || st.status !== 'sleeping') out.push(bwLine);
        }
      } catch { /* ignore */ }
    }

    // ⑤ 关系 × 语气（傲娇分寸）放在最末尾近因位置
    try {
      const partnerId = turnSenders.length ? turnSenders[turnSenders.length - 1] : '';
      const tone = TL.affectionToneBlock({ api, settings: s, partnerId, isPrivate: ctx.kind === 'private', now });
      if (tone) out.push(tone);
    } catch { /* ignore */ }

    if (!out.length) return;
    // ★ 2026-10-25 改：抬头原来是「请将以下情境自然融入语气与动作」——
    //   那是一句**语气指令**，等于让系统替她决定怎么说。现在只声明这是客观状态。
    const text = [
      '【当下状态】（以下是客观事实，不是说话要求；不要报出数值或标签名，也不必据此改变语气）',
      ...out
    ].join('\n\n');

    try {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') {
          m.content = `${m.content}\n\n${text}`;
          return;
        }
        if (Array.isArray(m.content)) {
          m.content.push({ type: 'text', text });
          return;
        }
      }
      messages.push({ role: 'user', content: text });
    } catch { /* ignore */ }
  },

  'before-tool'({ toolName } = {}) {
    const s = settings();
    if (!on(s.enabled) || !on(s.blockWhileSleeping)) return;
    const bare = String(toolName || '').split('__').pop();
    if (!['send_message', 'send_sticker', 'send_poke', 'send_image'].includes(bare)) return;

    for (const g of gateByChat.values()) {
      if (g && g.block) {
        if (g.kind === 'phone') {
          return { block: true, reason: '她这会儿低着头在看视频，没抬头回这条。先安静着，不要调别的工具绕过去。' };
        }
        return { block: true, reason: '她睡着了（没被喊醒）。安静是正常的，不要改用别的工具绕过去。' };
      }
    }
  },

  'after-tool'({ toolName, argsRaw, result } = {}) {
    if (!on(settings().enabled)) return;
    const bare = String(toolName || '').split('__').pop();
    if (bare !== 'send_message') return;
    if (result && result.isError) return;

    const text = extractSentText(argsRaw);
    if (!text) return;

    try { noteHerState(text, { chatKey: lastChatKey }); } catch { /* ignore */ }
    const cfg = engineCfg();
    const now = Date.now();

    // ① 她自己在发言中说“我去睡了” → 写入自然睡眠
    try {
      const prev = S.readSelfState(now);
      const judged = now < goodnightEchoUntil
        ? text.replace(GOODNIGHT_ECHO_RE, '').replace(STRIP_EDGE_PUNCT_RE, '')
        : text;
      const suspect = judged ? sleepVerdictSuspect(judged) : '';
      const next = (judged && !suspect) ? S.stateFromSelfText(judged, now, cfg) : null;
      if (next) {
        S.writeSelfState(next);
        if (next.status === 'sleeping' && prev.status !== 'sleeping') {
          M.markFatigueSleep(true, now);
        }
      }
    } catch { /* ignore */ }

    // ② 泡澡识别与元气恢复
    try {
      if (S.bathStartFromSelfText(text)) S.writeBathState({ now });
      else if (S.bathDoneFromSelfText(text)) S.settleBath(now);
    } catch { /* ignore */ }

    // ③ 陪闹额度结算：回满条数后发一句困倦收尾并回睡
    const play = playActive(now);
    if (play) {
      play.left -= 1;
      if (play.left <= 0) {
        play.active = false;
        S.writeSelfState({ status: 'sleeping', what: '陪闹完困得睡回去了', at: now });
        M.markFatigueSleep(true, now);
        confirmText(lastSender, play.chatKey || lastChatKey, '唔…真的困得睁不开眼啦，不陪你闹了，我先睡回去了…');
      }
    }
    publishDashboard();
  }
};

function extractSentText(argsRaw) {
  let args = argsRaw;
  if (typeof args === 'string') {
    try { args = JSON.parse(argsRaw); } catch { return String(argsRaw || '').trim(); }
  }
  if (!args || typeof args !== 'object') return '';
  const m = args.messages ?? args.message;
  if (Array.isArray(m)) return m.map((x) => String(x ?? '')).filter(Boolean).join('\n').trim();
  return String(m ?? '').trim();
}

// ── 工具注册（精简为 4 个直观工具）──────────────────────────────────────────

function registerMoodTools(a) {
  a.registerTool({
    id: 'mood_status',
    name: '查看元气与心境状态',
    description: '读取她当前的元气值（0~100）、身上挂载的具身情境心境 Tag（含原因与剩余时间）、睡眠状态以及当下所在的旅行/庭院位置。',
    category: 'query',
    icon: '🌡️',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const now = Date.now();
        const dash = dashboardSnapshot();
        const lines = [
          `元气值：${dash.vitality}/100（对应旧版疲劳度 ${dash.meters.fatigue}/100）`,
          `当下所在：${dash.self?.what || '在庭院闲适待着'}`
        ];
        if (dash.activeTags?.length) {
          lines.push('当前情境心境 Tag：');
          for (const t of dash.activeTags) {
            const leftMin = Math.max(1, Math.round((t.expiresAt - now) / 60_000));
            lines.push(`  · 【${t.tag}】（${t.tone}，剩余约 ${leftMin} 分钟）—— 原因：${t.why}`);
          }
        } else {
          lines.push('当前情境心境：平静舒展（无特殊挂件）');
        }
        lines.push(`睡眠状态：${dash.sleep?.sleeping ? `睡着（${dash.sleep.reason}）` : '清醒'}`);
        return { content: lines.join('\n') };
      } catch (e) {
        return { content: `读取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'mood_adjust',
    name: '调整元气或挂载心境标签',
    description: '当这一轮互动明显改变了她的心情或元气，或者主人要求调整时使用。可以直接调整元气值（vitality），或者挂载一个新的具身情境标签（如“被哄开心”“鼓腮帮子赌气”）。',
    category: 'system',
    icon: '🎚️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        mod: {
          type: 'string',
          description: '调整项：vitality（元气值 0~100）或 happy / excited / angry / jealous / sad / fatigue'
        },
        value: {
          type: 'number',
          description: '目标数值（0~100）'
        },
        tag: {
          type: 'string',
          description: '可选：自定义情境心境标签名（例如“吃到甜点的满足”“被顺毛的得意”）'
        },
        reason: {
          type: 'string',
          description: '触发该心情或元气变化的具体原因（必填，会供心愿和自传模块读取）'
        }
      },
      required: ['mod', 'value']
    },
    async execute(_ctx, args) {
      try {
        const now = Date.now();
        const key = String(args?.mod || '').trim();
        const val = Math.max(0, Math.min(100, Math.round(num(args?.value, 70))));
        const reason = String(args?.reason || '对话互动变化').trim();

        if (key === 'vitality' || key === 'fatigue') {
          const targetVit = key === 'fatigue' ? (100 - val) : val;
          const st = M.readMoodChain(now);
          st.vitality.value = targetVit;
          st.vitality.at = now;
          st.vitality.why = reason;
          M.writeMoodChain(st, now);
          publishDashboard();
          return { content: `已将元气值调整为 ${targetVit}/100（${reason}）。请自然接话，不要播报数值。` };
        }

        if (M.EMOTIONS[key]) {
          const def = M.EMOTIONS[key];
          const tagName = String(args?.tag || '').trim() || def.defaultTag;
          M.pushMoodTag({
            tag: tagName,
            tone: def.tone,
            category: key,
            level: val,
            why: reason,
            source: 'manual',
            now
          });
          publishDashboard();
          // ★ v2.2.1：对话里手动挂的强心境也要广播。
          //   此前只有 applyTravelEventMood() 会 publish('mood:state.shifted')，
          //   于是"旅途事件"是即时生效、"模型在对话里把她惹毛"却要等 mind-wish 的
          //   10 分钟轮询才被吸收 —— 同一个状态变化，两条路径的口子不一致。
          try {
            api?.capability?.('courtyard.bus')?.publish?.('mood:state.shifted', {
              kind: 'manual-adjust',
              tag: tagName,
              vitalityDelta: 0,
              why: reason,
              at: now
            });
          } catch { /* 总线没装/没开就当无事发生 */ }
          return { content: `已挂载情境心境【${tagName}】（原因：${reason}）。请自然融入语气回应。` };
        }

        return { content: `不支持的调整项 ${key}，可用：vitality / happy / excited / angry / jealous / sad`, isError: true };
      } catch (e) {
        return { content: `调整失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'mood_reset',
    name: '重置心境与元气到平和状态',
    description: '清空所有负面心境标签、将元气恢复至充沛状态（85/100），并解除睡眠闸门。当主人要求重置心情或恢复初始状态时使用。',
    category: 'system',
    icon: '↩️',
    defaultEnabled: true,
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const now = Date.now();
        M.writeMoodChain({ vitality: { value: 85, at: now, sleptAt: 0, why: '重置恢复' }, activeTags: [] }, now);
        S.writeSelfState({ status: 'awake', what: '', at: now, wakeAt: 0 });
        if (commandSleep) {
          resumeOrchestrator();
          commandSleep = false;
        }
        gateByChat.clear();
        publishDashboard();
        return { content: '已恢复为元气充沛、心境平和的清醒状态。' };
      } catch (e) {
        return { content: `重置失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'sleep_control',
    name: '控制命令睡眠',
    description: '开关【命令睡眠】（开启后消息只存档不调模型，零 token）。仅主人可用。',
    category: 'system',
    icon: '😴',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sleep', 'wake', 'status'], description: 'sleep / wake / status' }
      },
      required: ['action']
    },
    async execute(_ctx, args) {
      const action = String(args?.action || '').trim();
      if (action === 'status') {
        return { content: `命令睡眠：${commandSleep ? '开启' : '关闭'}；自然睡眠：${currentSleep().status}` };
      }
      if (action === 'sleep') {
        if (settings().lockSleepToOwner !== false && !turnOwnerSpeaks) {
          return { content: '命令睡眠仅限主人开启。', isError: true };
        }
        commandSleep = true;
        try { lastOrchestrator?.suspendAll?.(); } catch { /* ignore */ }
        M.markFatigueSleep(true, Date.now());
        gateByChat.clear();
        publishSleepState();   // 工具入睡同样立即广播
        publishDashboard();
        return { content: '已进入命令睡眠。' };
      }
      if (action === 'wake') {
        wakeUp({ reason: '工具唤醒' });
        const touched = resumeOrchestrator();
        publishDashboard();
        return { content: `已解除睡眠状态${touched ? `，补看 ${touched} 个会话` : ''}。` };
      }
      return { content: '未知操作', isError: true };
    }
  });
}
