// 念想 —— 她自己惦记着的事
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// 现在的她"每一轮都在全力执行人设"，但没有"自己的心事"。
// 人设卡能决定她怎么说话，决定不了"她此刻在想什么"。
//
// 念想就是那一层：从她真实经历过的事里，长出几条她惦记着的东西，附在上下文末尾。
//
// ── 三路来源（性质不同，权重不同）─────────────────────────────────────────
//   A 情绪   `data/mood.json` 的 moods[*].why   —— **天然低频**，而且已经带"为什么"
//   B B站    `bili-whale/storage.json` 的 diaries / quota —— 她自己写的感想
//   C 庭院   `sleep-mood-moments.json` 的 items  —— **20 分钟一条的活动时钟**，必须过筛
//
// ⚠️ C 是 44 条/天（实测：92 条 / 2.1 天），而念想上限 6 条。
//   不过筛 ⇒ 念想层退化成"最近 6 条活动日志"。所以 C 走 `filterMoments()`，
//   只留 情感转折 / 稀有 / 涉及具体人 的（实测约 13%）。
//
// ── 为什么不掷骰、不给结论 ────────────────────────────────────────────────
// 强度全部由数据算（lib/wish.js 是纯函数），排序可复现。
// 情绪只做**排序系数**，不做"现在该不该找她说话"——那是 silence-ping 的事。
// 这和「溟月的心」三条不变式里的第①条一致：**给事实、给选项，不替她选**。
//
// ── 安全底线 ──────────────────────────────────────────────────────────────
//   · 任何一路读不到 ⇒ 跳过那一路，其余照常（她家缺一个数据源不该念想全停）
//   · 吸收是**低频**动作（默认 10 分钟一次），注入是纯本地计算（不调模型）
//   · 模型写 text 失败 ⇒ 用原文兜底，**不编**
//   · 注入只加一段，不改任何既有消息，不破坏 tool_calls 配对

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import {
  SOURCE_BASE, decayed, scoreOf, pickTop, evict, filterMoments, moodFactorOf, dayKey, MIN_STRENGTH
} from './lib/wish.js';

let apiRef = null;
let log = () => {};
let timer = null;

const STORE_DIR = () => path.join(DATA_DIR, 'plugin-data', 'mind-wish');
const STORE_FILE = () => path.join(STORE_DIR(), 'wishes.json');

function cfg() {
  try {
    const raw = (apiRef && typeof apiRef.config === 'function' ? apiRef.config() : null) || {};
    const n = (v, d) => (Number(v) > 0 ? Number(v) : d);
    return {
      enabled: raw.enabled !== false,
      maxActive: n(raw.maxActive, 6),
      injectTop: n(raw.injectTop, 3),
      dailyAddLimit: Number(raw.dailyAddLimit) >= 0 ? Number(raw.dailyAddLimit) : 3,
      decayDays: n(raw.decayDays, 7),
      sourceMood: raw.sourceMood !== false,
      sourceBili: raw.sourceBili !== false,
      sourceMoments: raw.sourceMoments !== false,
      momentFilter: raw.momentFilter !== false,
      llmWrite: raw.llmWrite !== false,
      tickMinutes: n(raw.tickMinutes, 10),
      verbose: raw.verbose === true
    };
  } catch {
    return {
      enabled: true, maxActive: 6, injectTop: 3, dailyAddLimit: 3, decayDays: 7,
      sourceMood: true, sourceBili: true, sourceMoments: true, momentFilter: true,
      llmWrite: true, tickMinutes: 10, verbose: false
    };
  }
}

// ── 存档 ──────────────────────────────────────────────────────────────────

function readStore() {
  const empty = {
    version: 1, wishes: [], pending: [],
    cursors: { moodAt: 0, biliAt: 0, momentAt: 0 },
    counters: { day: dayKey(), added: 0 },
    updatedAt: 0
  };
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
    return {
      ...empty, ...j,
      wishes: Array.isArray(j?.wishes) ? j.wishes : [],
      pending: Array.isArray(j?.pending) ? j.pending : [],
      cursors: { ...empty.cursors, ...(j?.cursors || {}) },
      counters: { ...empty.counters, ...(j?.counters || {}) }
    };
  } catch {
    return empty;
  }
}

function writeStore(st) {
  try {
    fs.mkdirSync(STORE_DIR(), { recursive: true });
    const tmp = `${STORE_FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...st, updatedAt: Date.now() }, null, 1), 'utf8');
    fs.renameSync(tmp, STORE_FILE());
  } catch (error) {
    try { log(`念想：存档写入失败 ${error && error.message ? error.message : error}`); } catch { /* ignore */ }
  }
}

// ── 读三路来源（只读，读不到就跳过）──────────────────────────────────────

/** A · 情绪：moods[*].why 是新的话，就是一条念想的种子 */
function readMoodSeeds(sinceAt) {
  const out = [];
  try {
    const p = path.join(DATA_DIR, 'mood.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const moods = j && j.moods;
    if (!moods || typeof moods !== 'object') return { seeds: out, moodFactor: moodFactorOf(j) };
    for (const [k, v] of Object.entries(moods)) {
      const at = Number(v && v.at) || 0;
      const why = String((v && v.why) || '').trim();
      if (!at || at <= sinceAt || !why) continue;
      out.push({
        source: 'mood',
        raw: why,
        at,
        kind: /对|说|夸|骂|问|他|她/.test(why) ? 'person' : 'thing',
        // 从"开心（某人说的）"里取括号内的主体，用于去重
        key: `mood:${k}:${why}`
      });
    }
    return { seeds: out, moodFactor: moodFactorOf(j) };
  } catch {
    return { seeds: out, moodFactor: 1 };
  }
}

/** B · B站：日记与分享记录（都是她自己写的） */
function readBiliSeeds(sinceAt) {
  const out = [];
  try {
    const p = path.join(DATA_DIR, 'plugin-data', 'bili-whale', 'storage.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const db = (j && j.db) || {};
    // 分享记录：note 是她写的那句分享语
    for (const q of (Array.isArray(db.quota) ? db.quota : [])) {
      const at = Number(q && q.at) || 0;
      const note = String((q && q.note) || '').trim();
      if (!at || at <= sinceAt || !note) continue;
      out.push({
        source: 'bili', raw: note, at, kind: 'thing',
        key: `bili:quota:${q.bvid || ''}:${String(note).slice(0, 20)}`
      });
    }
    // 日记：按 date 取最近一篇，切出「看了什么」
    const diaries = db.diaries && typeof db.diaries === 'object' ? db.diaries : {};
    for (const list of Object.values(diaries)) {
      if (!Array.isArray(list)) continue;
      for (const d of list.slice(-2)) {
        const at = Number(d && d.at) || 0;
        const text = String((d && d.text) || '').trim();
        if (!at || at <= sinceAt || !text) continue;
        out.push({
          source: 'bili', raw: text.slice(0, 220), at, kind: 'thing',
          key: `bili:diary:${d.date || at}`
        });
      }
    }
    return out;
  } catch {
    return out;
  }
}

/** C · 庭院：活动时钟，必须过筛（见 lib/wish.js 的 filterMoments） */
function readMomentSeeds(sinceAt, useFilter) {
  try {
    const p = path.join(DATA_DIR, 'sleep-mood-moments.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const items = Array.isArray(j && j.items) ? j.items : [];
    if (!useFilter) {
      return items.filter((m) => (Number(m && m.at) || 0) > sinceAt).slice(-3).map((m) => ({
        source: 'moment', raw: String(m.detail || m.act || ''), at: Number(m.at) || 0,
        kind: 'thing', key: `moment:${m.id || m.at}`
      }));
    }
    return filterMoments(items, 3, sinceAt).map((m) => ({
      source: 'moment',
      raw: `${String(m.act || '').trim()}${m.detail ? `——${String(m.detail).trim()}` : ''}`,
      at: Number(m.at) || 0,
      kind: /对方|伴侣|旅伴/.test(String(m.detail || '')) ? 'person' : 'thing',
      key: `moment:${m.id || m.at}`
    }));
  } catch {
    return [];
  }
}

// ── 用模型写成一句话（失败就抄原文，不编）────────────────────────────────

function cleanOne(text) {
  return String(text || '')
    .replace(/^```[\s\S]*?\n/, '').replace(/```$/, '')
    .split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
    .replace(/^["'“「『]+|["'”」』]+$/g, '')
    .replace(/^[-·•*]\s*/, '')
    .trim()
    .slice(0, 40);
}

async function writeText(seed, c) {
  const fallback = cleanOne(seed.raw) || String(seed.raw || '').slice(0, 40);
  if (!c.llmWrite) return fallback;
  try {
    const llm = await import('../../src/llm.js');
    const prompt = [
      '这是你身上刚发生的一件事：',
      String(seed.raw).slice(0, 300),
      '',
      '用你自己的口气，把它写成一句「你心里惦记着的事」（不超过 20 个字）。',
      '要求：',
      '· 像脑子里忽然冒出来的一句，不是任务、不是日记、不是总结。',
      '· 不要写"我刚刚…"，也不要解释为什么。',
      '· 只输出这一句，不要引号、不要标点堆砌。',
      '· 如果这件事实在没什么好惦记的，就只输出：NONE'
    ].join('\n');
    const res = await llm.chatCompletion({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 140,
      temperature: 0.8,
      // ★ 必须关掉思考：这只是"写一句话"，开着思考的话预算会全被 reasoning 吃光，
      //   `message.content` 直接是空的，然后每条都走兜底抄原文（实测踩到——3 条念想全是原文）。
      //   这与今天 think-gate 那个专题是同一件事：短任务不该思考。
      skillContext: { thinkingMode: 'off' }
    });
    const txt = String(res?.message?.content ?? res?.content ?? '').trim();
    const one = cleanOne(txt);
    if (!one || /^NONE$/i.test(one)) return fallback;
    return one;
  } catch (error) {
    if (c.verbose) { try { log(`念想：写 text 失败，抄原文 —— ${error && error.message ? error.message : error}`); } catch { /* ignore */ } }
    return fallback;
  }
}

// ── 吸收（低频）───────────────────────────────────────────────────────────

async function absorb() {
  const c = cfg();
  if (!c.enabled) return;
  const st = readStore();
  const now = Date.now();

  // 日上限跨天重置
  const today = dayKey(now);
  if (st.counters.day !== today) st.counters = { day: today, added: 0 };

  const cur = st.cursors || {};
  const { seeds: moodSeeds, moodFactor } = c.sourceMood
    ? readMoodSeeds(Number(cur.moodAt) || 0) : { seeds: [], moodFactor: 1 };
  const biliSeeds = c.sourceBili ? readBiliSeeds(Number(cur.biliAt) || 0) : [];
  const momentSeeds = c.sourceMoments ? readMomentSeeds(Number(cur.momentAt) || 0, c.momentFilter) : [];

  const seeds = [...moodSeeds, ...biliSeeds, ...momentSeeds].sort((a, b) => a.at - b.at);
  if (!seeds.length) {
    writeStore(st);
    return;
  }

  // 游标推进到这一批最新（无论是否真的新增念想，避免重复处理）
  const maxAt = seeds.reduce((m, s) => Math.max(m, s.at), 0);
  const nextCursors = {
    moodAt: moodSeeds.length ? maxAt : (Number(cur.moodAt) || 0),
    biliAt: biliSeeds.length ? maxAt : (Number(cur.biliAt) || 0),
    momentAt: momentSeeds.length ? maxAt : (Number(cur.momentAt) || 0)
  };

  // 已有的（按 key 去重，同一件事不重复成为念想）
  const knownKeys = new Set(st.wishes.concat(st.pending).map((w) => w.key).filter(Boolean));

  let added = 0;
  const skipped = [];
  for (const seed of seeds) {
    if (knownKeys.has(seed.key)) { skipped.push(seed); continue; }
    // 日上限：超出了就进待定池，不丢
    if (c.dailyAddLimit > 0 && st.counters.added >= c.dailyAddLimit) {
      st.pending.push({ ...seed, strength: SOURCE_BASE[seed.source] || 0.4 });
      knownKeys.add(seed.key);
      continue;
    }
    const text = await writeText(seed, c);
    if (!text) continue;
    st.wishes.push({
      id: `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      key: seed.key,
      text,
      kind: seed.kind || 'thing',
      strength: SOURCE_BASE[seed.source] || 0.4,
      at: seed.at || now,
      touchedAt: seed.at || now,
      source: seed.source,
      hits: 1
    });
    knownKeys.add(seed.key);
    st.counters.added += 1;
    added += 1;
  }

  // 淘汰：超过上限按强度留前 maxActive
  const { keep, drop: dropped } = evict(st.wishes, c.maxActive, now, { decayDays: c.decayDays, moodFactor });
  st.wishes = keep;
  if (dropped.length) st.pending = st.pending.concat(dropped.slice(0, 20).map((w) => ({ ...w, droppedAt: now })));
  if (st.pending.length > 40) st.pending = st.pending.slice(-40);

  st.cursors = nextCursors;
  writeStore(st);

  if (c.verbose && (added || dropped.length)) {
    try {
      log(`念想：新增 ${added} 条（${seeds.map((s) => s.source).join('/')}），淘汰 ${dropped.length} 条，`
        + `现有 ${st.wishes.length} 条，今天已加 ${st.counters.added}/${c.dailyAddLimit}`);
    } catch { /* ignore */ }
  }
}

// ── 注入 ──────────────────────────────────────────────────────────────────

// mtime 读缓存：注入钩子**每条消息**都会读 mood.json —— stat 没变就直接用上次的
// 解析结果。写方 writeMoodChain 是 tmp+rename，内容一变 mtime 必变，不会读到旧的；
// 只给**纯读**场景用（moodFactorOf 不改入参），会改对象的调用方别走这里。
const _jsonCache = new Map();   // path -> { mtimeMs, data }
function readJsonCached(p) {
  const m = fs.statSync(p).mtimeMs;
  const hit = _jsonCache.get(p);
  if (hit && hit.mtimeMs === m) return hit.data;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  _jsonCache.set(p, { mtimeMs: m, data });
  return data;
}

function buildBlock(c) {
  const st = readStore();
  if (!st.wishes.length) return '';
  let moodFactor = 1;
  try {
    const p = path.join(DATA_DIR, 'mood.json');
    moodFactor = moodFactorOf(readJsonCached(p));
  } catch { /* 读不到就用 1 */ }

  const top = pickTop(st.wishes, c.injectTop, Date.now(), { decayDays: c.decayDays, moodFactor });
  if (!top.length) return '';

  const fmt = (w) => {
    const days = Math.max(0, Math.round((Date.now() - (Number(w.at) || Date.now())) / 86400000));
    // ★ 2026-10-25：语气改柔 —— 原来写「惦记了 3 天，想起过 5 次」，像在报台账；
    //   改成时间感的说法，不报次数（次数读起来像 KPI，会把心事变成任务）。
    const age = days >= 7 ? '有一阵子了' : days >= 1 ? '前几天忽然想到过' : '刚才一闪念';
    return `· ${w.text}（${age}）`;
  };

  return [
    '【心里偶尔浮起来的小事】',
    ...top.map(fmt),
    '（只是心里的余温，不是待办、也不是任务。想提就轻轻提一句，不想提就让它待着。）'
  ].join('\n');
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

// 定时器句柄挂 globalThis 单例槽：热重载出的新实例才能接管并清掉旧实例起的
// 定时器（旧实例的 deactivate 若没被调到，它闭包里的 timer 谁也够不着 ——
// 会变成每 tickMinutes 分钟多跑一份 absorb()，双实例竞争写 wishes.json）。
const TIMER_SLOT = '__qqAgentMindWishTimer';

function stopLoop() {
  const prev = globalThis[TIMER_SLOT];
  if (prev) { try { clearInterval(prev); } catch { /* ignore */ } globalThis[TIMER_SLOT] = null; }
  if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
}

function startLoop() {
  stopLoop();   // 先清旧槽 —— 旧实例留下的那份定时器也一并清掉
  const c = cfg();
  if (!c.enabled) return;
  timer = setInterval(() => { absorb().catch(() => {}); }, Math.max(1, c.tickMinutes) * 60000);
  if (timer.unref) timer.unref();
  globalThis[TIMER_SLOT] = timer;
  absorb().catch(() => {});   // 启动时先吸收一次
}

export function setup(api) {
  apiRef = api;
  log = (typeof api?.log === 'function') ? api.log.bind(api) : () => {};
  const c = cfg();
  try {
    log(`念想已加载（启用=${c.enabled ? '开' : '关'}，上限 ${c.maxActive} 条，注入 ${c.injectTop} 条，`
      + `每天最多新增 ${c.dailyAddLimit} 条，来源=${[c.sourceMood ? '情绪' : '', c.sourceBili ? 'B站' : '', c.sourceMoments ? '庭院' : ''].filter(Boolean).join('+') || '无'}）`);
  } catch { /* ignore */ }
  startLoop();
  // [[courtyard-bus]] 情绪位移事件（2026-10-24 试点）：总线在就**即时吸收**（去抖 30 秒，
  // absorb 自带游标与去重，重复触发无害）；总线不在/插件没装就退回 10 分钟轮询 —— 降级红线。
  try {
    const bus = apiRef?.capability?.('courtyard.bus');
    if (bus?.subscribe) {
      let busLast = 0;
      bus.subscribe('mood:state.shifted', () => {
        const t = Date.now();
        if (t - busLast < 30000) return;
        busLast = t;
        absorb().catch(() => {});
      });
      log('念想：已订阅庭院总线 mood:state.shifted（情绪位移即时吸收）');
    }
  } catch { /* 总线不在：轮询照旧 */ }
}

export function activate() {
  startLoop();
}

export function deactivate() {
  stopLoop();
}

export function dispose() {
  stopLoop();
}

export const hooks = {
  /**
   * 只做注入，不吸收（吸收在定时器里）。
   * ⚠️ 注入只**追加**一条 user 消息，不改既有消息 —— 不破坏 tool_calls 配对。
   */
  'before-llm-messages': ({ messages } = {}) => {
    try {
      const c = cfg();
      if (!c.enabled) return;
      if (!Array.isArray(messages) || !messages.length) return;
      const block = buildBlock(c);
      if (!block) return;
      messages.push({ role: 'user', content: block });
      if (c.verbose) { try { log('念想：已注入'); } catch { /* ignore */ } }
    } catch (error) {
      try { log(`念想：注入失败（本次跳过）${error && error.message ? error.message : error}`); } catch { /* ignore */ }
    }
  }
};

export const providers = {
  /**
   * 供别的插件读（silence-ping 拿它当主动私信的话题与门槛依据，02.md 5.1）。
   * · 不传参 / action:'read'：返回 Top N 念想数组（带 score，纯读不改档）。
   * · action:'vent' + key：标记「已倾诉」—— 强度减半并记 ventedAt/vents。
   *   倾诉过的念想分数自然下沉、退出 Top，同一件事不会反复被拿去找人聊。
   */
  'mind.wishes': ({ action = 'read', key = '', top = 0 } = {}) => {
    const c = cfg();
    const st = readStore();
    if (action === 'vent') {
      const list = Array.isArray(st.wishes) ? st.wishes : [];
      const w = list.find((x) => String(x?.key || '') === String(key || ''));
      if (!w) return { ok: false, reason: '没有这条念想' };
      w.strength = Math.max(0, (Number(w.strength) || 0) * 0.5);
      w.ventedAt = Date.now();
      w.vents = (Number(w.vents) || 0) + 1;
      writeStore(st);
      try { log(`念想已倾诉（第 ${w.vents} 次，强度减半）：${String(w.text || '').slice(0, 24)}`); } catch { /* ignore */ }
      return { ok: true, key: w.key, strength: w.strength, vents: w.vents };
    }
    const n = Number(top) > 0 ? Math.min(10, Math.round(Number(top))) : c.injectTop;
    return pickTop(st.wishes, n, Date.now(), { decayDays: c.decayDays });
  }
};

export const internals = { readStore, writeStore, absorb, buildBlock, readMoodSeeds, readBiliSeeds, readMomentSeeds };
