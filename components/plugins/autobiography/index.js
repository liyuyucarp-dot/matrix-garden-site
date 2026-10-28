// 自传体记忆（autobiography）—— L3 长期记忆 · v0.2.0（2026-10-25 按主人要求重构）
//
// ── 这一版改了什么（四条）─────────────────────────────────────────────────
//   ① 沉淀去向改为 knowledge-base：巩固出来的回忆直接写进
//      `data/knowledge-base/learned/`，可检索（kb_search 命中）、可改（kb_update）、
//      可被 learning-loop 再巩固 —— 不再只是自己一个 nodes.json 里的死档。
//   ② 触发时机从「固定钟点」改成「睡前」：**命令睡眠（/睡觉）随时算**，
//      自然睡眠**只在晚上**（nightStartHour~nightEndHour，默认 21:00–06:00）算。
//      每 checkSeconds 看一次睡眠状态，睡着且今天还没总结就总结一次。
//      宿主那天没在 23:30 开着、或者半夜重启，都不再丢一整天的素材；
//      下午的小憩/午睡也不会被当成"睡前"沉淀出半截日子。
//   ③ 空素材不落节点、不调模型：以前素材 0 条也照样问模型，模型只能凭空编
//      （历史遗留的那条"我游过十月末的海"就是这么来的）。
//   ④ 不再进提示词（删掉 promptSections）：回忆走知识库检索，不再让每天变化的
//      长段落去扰动前缀缓存。想让她想起来，靠知识库的命中注入 + kb_search。
//
// ── 数据来源（全部只读）──
//   · travel-whale 家存档：homeLog（庭院活动）、album（明信片）、trip（在途状态）
//   · bili-whale：storage.json 的日记与分享
//   · sleep-mood：mood.json 的情绪波动（带 why 的才收）
//   · favor-core：memory\people\*.json 的好感变化
//   · 睡眠状态：sleep-mood 的 ui/mood-dashboard.json（能看到"命令睡眠"）→
//              回退 data/self-state.json（自然睡眠）
//
// ── 纪律 ──
//   · 只读其它组件的数据，不写不拦（同 mind-wish 纪律）；
//   · 凭据一律不入库；群号不出现在节点里（人名/地点是叙事的一部分，保留）；
//   · LLM 提炼失败 → 模板兜底；写知识库失败 → 只记日志，**绝不影响巩固本身**；
//   · 一天最多一条：内存标记 + nodes.json 按日期去重，双保险。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, getConfig } from '../../src/config.js';

// ── 2026-10-28（P2）：定时器统一交给中央心跳 ────────────────────────────────
// 有 courtyard.clock 就挂到它那**一个 1s 主循环**上（±10% 抖动错峰、单任务超时、一处注销）；
// 拿不到就退回本地 setInterval —— 组件可能被单独安装，必须能独立跑。
function infraClock() {
  try { return globalThis.__courtyardInfra?.clock || null; } catch { return null; }
}
function everyTimer(id, ms, fn) {
  const clk = infraClock();
  if (clk) { try { return clk.every(id, ms, fn, { jitter: 0.1 }); } catch { /* 落到本地 */ } }
  const t = setInterval(fn, ms);
  try { t.unref?.(); } catch { /* ignore */ }
  return t;
}
function stopTimer(h) {
  if (!h) return;
  if (typeof h === 'function') { try { h(); } catch { /* ignore */ } return; }
  try { clearInterval(h); } catch { /* ignore */ }
}


let apiRef = null;
let log = () => {};
let timer = null;

const STORE_DIR = () => path.join(DATA_DIR, 'autobiography');
const STORE_FILE = () => path.join(STORE_DIR(), 'nodes.json');
const SELF_STATE_FILE = () => path.join(DATA_DIR, 'self-state.json');
const DASHBOARD_FILE = () => path.join(ROOT, 'ui', 'mood-dashboard.json');
const NODE_CAP = 400;

/** dashboard 快照超过这个时长就当过期（宿主崩溃/停摆时别拿旧状态当"她还在睡"） */
const DASH_STALE_MS = 10 * 60 * 1000;
/** 空素材 / 失败后的重试间隔：小憩时没素材不该把整晚的总结机会吃掉；
 *  另外**醒来就把节流清零**（见 tick）—— 每次入睡会话都重新给一次机会。 */
const RETRY_MS = 20 * 60 * 1000;

function cfg() {
  // ⚠️ 宿主把插件/技能的设置统一挂在 config.skills[id] 下（没有 config.plugins.* 这层）
  const c = (getConfig()?.skills?.autobiography) || {};
  const hr = (v, d) => (Number.isFinite(Number(v)) ? Math.min(23, Math.max(0, Math.round(Number(v)))) : d);
  return {
    enabled: c.enabled !== false,
    llmWrite: c.llmWrite !== false,
    checkSeconds: Number.isFinite(Number(c.checkSeconds))
      ? Math.min(300, Math.max(20, Math.round(Number(c.checkSeconds))))
      : 60,
    kbTitle: String(c.kbTitle || '她的回忆').trim() || '她的回忆',
    nightStartHour: hr(c.nightStartHour, 21),
    nightEndHour: hr(c.nightEndHour, 6)
  };
}

/**
 * 现在是"晚上"吗？—— 只有晚上的**自然睡眠**才算睡前。
 *
 * 为什么需要这个：她下午眯一会儿（小憩/午睡）也是自然睡眠，但那时候一天还没过完，
 * 沉淀出来的是半截日子。所以自然睡眠要加时段门槛；**命令睡眠（/睡觉）不看时段**，
 * 主人让她睡就是想收工了。
 *
 * 跨零点用「或」处理：21:00–23:59 与 00:00–05:59 都算夜里（[start,24) ∪ [0,end)）。
 */
export function isNight(now = Date.now(), c = null) {
  const conf = c || cfg();
  const h = new Date(now).getHours();
  const start = conf.nightStartHour;
  const end = conf.nightEndHour;
  if (start === end) return true;                       // 同一个小时 = 不设门槛
  return start < end
    ? (h >= start && h < end)                            // 不跨零点（如 21→23）
    : (h >= start || h < end);                           // 跨零点（如 21→6）
}

function homeChatKey() {
  try { return String(getConfig()?.skills?.['travel-whale']?.homeChatKey || ''); } catch { return ''; }
}
function homeStateFile() {
  const key = homeChatKey().replace(/[^a-z0-9_]/gi, '_');
  if (!key) return '';
  return path.join(DATA_DIR, 'skills', 'travel-whale', 'chats', `${key}.json`);
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** "今天"以传入的基准时间为准（巩固跨零点时不会把昨天的素材算进今天） */
const isToday = (t, now = Date.now()) => dayKey(Number(t) || 0) === dayKey(now);

function readNodes() {
  const j = readJson(STORE_FILE());
  return Array.isArray(j) ? j : [];
}
function writeNodes(nodes) {
  fs.mkdirSync(STORE_DIR(), { recursive: true });
  fs.writeFileSync(STORE_FILE(), JSON.stringify(nodes.slice(-NODE_CAP), null, 2), 'utf8');
}
function hasNode(date) {
  return readNodes().some((n) => n && n.date === date);
}

// ── 睡眠状态（"睡前触发"的唯一判据）────────────────────────────────────────
/**
 * 她此刻睡着了吗？
 *
 * 为什么先看 dashboard：**命令睡眠（/睡觉）只存在 sleep-mood 的内存变量里**，
 * 不写 self-state.json，所以光看文件永远看不到它。sleep-mood 每次心跳（默认 60s）
 * 会把当前状态发布到 `ui/mood-dashboard.json`，那里同时有 sleep.sleeping 与 kind
 * （'command' / 'natural'）—— 这是零改造就能拿到两种睡眠的唯一途径。
 *
 * self-state.json 作为回退：dashboard 过期（宿主刚起、还没跑第一次心跳）时，
 * 至少还能认出"自然睡眠"（她自己说困了去睡）。
 */
export function sleepState(now = Date.now()) {
  try {
    const j = readJson(DASHBOARD_FILE());
    const at = Number(j?.publishedAt || j?.at || 0);
    if (j && at && now - at <= DASH_STALE_MS) {
      const sl = j.sleep || {};
      if (sl.sleeping === true) return { sleeping: true, kind: String(sl.kind || 'unknown'), via: 'dashboard' };
    }
  } catch { /* ignore */ }

  try {
    const j = readJson(SELF_STATE_FILE()) || {};
    const s = (j && typeof j.self === 'object' && j.self) ? j.self : j;   // 兼容 v1 的嵌套结构
    if (String(s?.status || '') === 'sleeping') {
      return { sleeping: true, kind: 'natural', via: 'self-state' };
    }
  } catch { /* ignore */ }

  return { sleeping: false, kind: 'awake', via: 'none' };
}

// ── 当天素材收集（全部只读）────────────────────────────────────────────────
function collectToday(now = Date.now()) {
  const facts = [];
  const people = new Set();
  let place = '矩阵庭院';

  // ① 旅行状态与庭院活动
  const st = readJson(homeStateFile());
  if (st) {
    const t = st.trip || {};
    const away = Number(t.departAt) > 0 && Number(t.returnAt) > 0 && now >= Number(t.departAt) && now <= Number(t.returnAt);
    place = away ? `旅途·${t.country || ''}·${t.city || ''}`.replace(/·$/, '') : '矩阵庭院';
    for (const e of (Array.isArray(st.homeLog) ? st.homeLog : [])) {
      if (!isToday(e?.at, now)) continue;
      facts.push(`庭院：${String(e.act || '').slice(0, 60)}${e.mate ? `（和${e.mate}）` : ''}`);
      if (e.mate) people.add(String(e.mate));
    }
    if (away) facts.push(`在途：${t.city || ''}（${t.phase?.name || ''}）`);
  }

  // ② 明信片（今天寄的）
  if (st && Array.isArray(st.album)) {
    for (const a of st.album.slice(-6)) {
      const at = Number(a?.at) || 0;
      if (at && isToday(at, now)) facts.push(`明信片：${String(a.spot || a.city || '').slice(0, 40)}${a.caption ? `——${String(a.caption).slice(0, 50)}` : ''}`);
    }
  }

  // ③ B站日记/分享（今天的）
  try {
    const db = (readJson(path.join(DATA_DIR, 'plugin-data', 'bili-whale', 'storage.json')) || {}).db || {};
    for (const list of Object.values(db.diaries && typeof db.diaries === 'object' ? db.diaries : {})) {
      for (const d of (Array.isArray(list) ? list : []).slice(-2)) {
        if (!isToday(d?.at, now) || !String(d?.text || '').trim()) continue;
        facts.push(`B站日记：${String(d.text).slice(0, 80)}`);
      }
    }
    for (const q of (Array.isArray(db.quota) ? db.quota : []).slice(-6)) {
      if (!isToday(q?.at, now) || !String(q?.note || '').trim()) continue;
      facts.push(`B站分享：${String(q.note).slice(0, 60)}`);
    }
  } catch { /* bili-whale 不在就少一块 */ }

  // ④ 情绪波动（带 why 的才收——那是"为什么"）
  // ★ v2.2.1：sleep-mood v2 的 normalizeAndProject() 会把一个 tone:'good' 的心境 Tag
  //   **同时投影进 excited 和 happy 两个维度**（同一个 why、同一个 at）；这里若不去重，
  //   同一条原因会在当天素材里出现两次，回忆就会重复念叨同一件事。
  //   做法：两个来源都收（moods 覆盖"已结束"的，activeTags 覆盖"正挂着"的），按 why 去重。
  try {
    const mood = readJson(path.join(DATA_DIR, 'mood.json')) || {};
    const seen = new Set();
    const addWhy = (why, at) => {
      const w = String(why || '').trim().slice(0, 60);
      if (!w || !isToday(at, now) || seen.has(w)) return;
      seen.add(w);
      facts.push(`心情波动：${w}`);
    };
    for (const v of Object.values(mood.moods && typeof mood.moods === 'object' ? mood.moods : {})) {
      addWhy(v?.why, v?.at);
    }
    for (const t of (Array.isArray(mood.activeTags) ? mood.activeTags : [])) {
      addWhy(t?.why || t?.tag, t?.at);
    }
  } catch { /* ignore */ }

  // ⑤ 好感变化（今天动过的档案）
  try {
    const dir = path.join(DATA_DIR, 'memory', 'people');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const j = readJson(path.join(dir, f));
        if (!j || !isToday(j.lastFavorChangeAt, now)) continue;
        if (j.name) people.add(String(j.name));
        facts.push(`好感：与${j.name || f} 的关系有更新（当前 ${Number(j.favor) || 0}）`);
      }
    }
  } catch { /* ignore */ }

  return { facts: facts.slice(0, 14), people: [...people], place };
}

// ── LLM 提炼（失败走模板兜底）────────────────────────────────────────────
async function consolidateOne(node, c) {
  if (!c.llmWrite) return templateLines(node);
  try {
    const llm = await import('../../src/llm.js');
    const res = await llm.chatCompletion({
      messages: [{
        role: 'user',
        content: [
          `这是「她」（一只会旅行的鲸鱼）${node.date} 这一天的流水账：`,
          ...node.facts,
          '',
          '把这一天提炼成 1~2 句"她自己的回忆"（第一人称，带画面，不超过 60 字）。',
          '只输出回忆本身，不要引号、不要编号、不要解释。'
        ].join('\n')
      }],
      maxTokens: 200,
      temperature: 0.8,
      skillContext: { thinkingMode: 'off' }
    });
    const txt = String(res?.message?.content ?? res?.content ?? '').trim()
      .replace(/^["'“「『]+|["'”」』]+$/g, '').slice(0, 120);
    return txt || templateLines(node);
  } catch { return templateLines(node); }
}

function templateLines(node) {
  return node.facts.slice(0, 2).join('；').slice(0, 120) || '';
}

// ── 沉淀：写 knowledge-base（软依赖，失败不影响巩固）───────────────────────
/**
 * 为什么走 legacy 形态（只传 title/content/source/tags，不传 topic/weight/mode）：
 * knowledge-base 的 append 路径会把同一天的回忆**追加到同一个文件**、
 * 用日期当小节标题、并且自带"前 80 字已在文件里就不重复添加"的防重 ——
 * 正是"一本按天记的回忆册"该有的样子；传 topic/weight 会走另一套按主题合并的语义，
 * 反而把每天的日期小节打散。
 */
function writeToKnowledgeBase(node, c) {
  try {
    if (!apiRef || typeof apiRef.capability !== 'function') return { ok: false, error: '宿主没有 capability 接口' };
    const r = apiRef.capability('knowledge.write', {
      title: c.kbTitle,
      content: String(node.text || '').trim(),
      source: `autobiography · ${node.date} · ${node.place}`,
      tags: '自传 回忆'
    });
    if (!r || r.ok !== true) {
      return { ok: false, error: String(r?.error || 'knowledge-base 未返回 ok（可能未启用或禁止写入）') };
    }
    return { ok: true, file: String(r.file || ''), appended: !!r.appended };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── 一天一次（幂等）───────────────────────────────────────────────────────
let doneDate = '';        // 内存标记：当天已沉淀（宿主重启后由 nodes.json 兜住）
let lastTryAt = 0;        // 上次实际尝试的时间（空素材/失败时节流）

/**
 * 睡前巩固。可被睡眠轮询、也可被 `autobiography.consolidate` 能力手动触发。
 * 永远不抛：任何一步失败都只记日志。
 */
export async function consolidate(now = Date.now(), { reason = 'sleep' } = {}) {
  const c = cfg();
  if (!c.enabled) return { ok: false, skipped: '未启用' };

  const date = dayKey(now);
  if (doneDate === date) return { ok: true, skipped: '今日已沉淀' };
  if (hasNode(date)) { doneDate = date; return { ok: true, skipped: '今日已沉淀' }; }
  if (lastTryAt && now - lastTryAt < RETRY_MS) {
    return { ok: false, skipped: `距上次尝试不足 ${Math.round(RETRY_MS / 60000)} 分钟` };
  }
  lastTryAt = now;

  // ③ 空素材：不落节点、不调模型
  const { facts, people, place } = collectToday(now);
  if (!facts.length) {
    try { log(`自传体记忆：${date} 没有可沉淀的素材，跳过（不落节点、不调模型）`); } catch { /* ignore */ }
    return { ok: false, skipped: '今日无素材' };
  }

  const node = { date, at: now, place, people, facts, text: '', kind: 'day', trigger: reason };
  node.text = await consolidateOne(node, c);

  // ④ 沉淀进知识库（可检索）。失败只记日志，nodes.json 仍留档。
  const kb = writeToKnowledgeBase(node, c);
  node.kb = kb;

  const nodes = readNodes().filter((n) => n && n.date !== date);
  nodes.push(node);
  writeNodes(nodes);
  doneDate = date;

  try {
    log(kb.ok
      ? `自传体记忆：${date} 已沉淀（素材 ${facts.length} 条、人物 ${people.length} 位）→ 知识库「${c.kbTitle}」${kb.appended ? '（追加）' : '（新建）'}`
      : `自传体记忆：${date} 已生成回忆，但写知识库失败：${kb.error}（已存 nodes.json）`);
  } catch { /* ignore */ }
  return { ok: true, date, node, kb };
}

/** 手动/能力入口：跳过"睡着"这个前置条件，直接巩固今天（排障用） */
export function consolidateNow(now = Date.now()) {
  lastTryAt = 0;
  return consolidate(now, { reason: 'manual' });
}

/** 召回：最近 N 条（不注入提示词，供别的组件按需取用 / 排障） */
export function recent(limit = 3) {
  const nodes = readNodes();
  return nodes.slice(-Math.max(1, Math.min(20, Number(limit) || 3)));
}

// ── 睡眠轮询（"睡前触发"；不依赖任何固定钟点）─────────────────────────────
const TIMER_SLOT = '__qqAgentAutobiographyTimer';
let running = false;
let busUnsubs = [];

/**
 * 订阅 `sleep:state.changed`（由 sleep-mood 在她进入/退出睡眠时广播）。
 *
 * 为什么要订阅：轮询是 60 秒一跳，命令睡眠（`/睡觉`）之后最多要等一个完整心跳才会沉淀。
 * 有了这条线就是"说完就写"。**轮询保留** —— 总线不在（没装/没开/回调没订上）时行为与以前一致，
 * 这是 courtyard-bus 的降级红线，不能反过来依赖总线保证正确性。
 */
function subscribeSleep() {
  try {
    const bus = apiRef?.capability?.('courtyard.bus');
    if (!bus || typeof bus.subscribe !== 'function') return;
    const un = bus.subscribe('sleep:state.changed', (p) => {
      try {
        const state = String((p && p.state) || '');
        if (!state || state === 'awake') return;                       // 醒来不用做事（轮询会清节流）
        if (state !== 'command' && !isNight(Date.now(), cfg())) return;  // 小憩不算，与轮询同一判据
        // 推迟到下一个宏任务：publish 是在 sleep-mood 的入站闸/心跳里同步调用的，
        // 而本函数要同步读 nodes.json 与各组件存档 —— 别占着别人的热路径。
        setTimeout(() => {
          consolidate(Date.now(), { reason: state === 'command' ? 'command-sleep' : 'night-sleep' })
            .catch(() => {});
        }, 0);
      } catch { /* ignore */ }
    });
    if (typeof un === 'function') busUnsubs.push(un);
  } catch { /* 总线不在就只靠轮询 */ }
}

function stopLoop() {
  const prev = globalThis[TIMER_SLOT];
  if (prev) { stopTimer(prev); globalThis[TIMER_SLOT] = null; }
  timer = null;
  running = false;
  for (const un of busUnsubs) { try { un(); } catch { /* ignore */ } }
  busUnsubs = [];
}

async function tick(nowOverride) {
  if (running) return;
  running = true;
  try {
    const now = Number(nowOverride) || Date.now();
    const c = cfg();
    const s = sleepState(now);
    if (!s.sleeping) {
      // 醒来即解除节流：小憩时没素材跳过了，晚上长睡时还能再试一次
      lastTryAt = 0;
      return;
    }
    // ② 只有「命令睡眠」或「晚上的自然睡眠」才算睡前。
    //    下午的小憩/午睡照样是 natural，但一天还没过完 —— 不沉淀，也不占当天的机会。
    if (s.kind !== 'command' && !isNight(now, c)) {
      lastTryAt = 0;
      return;
    }
    await consolidate(now, { reason: s.kind === 'command' ? 'command-sleep' : 'night-sleep' });
  } catch (e) {
    try { log(`自传体记忆检查失败（不影响睡眠）：${e?.message ?? e}`); } catch { /* ignore */ }
  } finally {
    running = false;
  }
}

function startLoop() {
  stopLoop();
  const c = cfg();
  if (!c.enabled) return;
  timer = everyTimer('autobiography/tick', c.checkSeconds * 1000, tick);
  if (timer.unref) timer.unref();
  globalThis[TIMER_SLOT] = timer;
  subscribeSleep();   // 总线即时触发（没有总线就只靠上面的轮询）
}

export function setup(api) {
  apiRef = api;
  log = (typeof api?.log === 'function') ? api.log.bind(api) : () => {};
  const c = cfg();
  try {
    log(`自传体记忆已加载（睡前触发：命令睡眠随时 / 自然睡眠限 ${c.nightStartHour}:00–${c.nightEndHour}:00 · 每 ${c.checkSeconds}s 观察一次 · 沉淀进知识库「${c.kbTitle}」 · LLM=${c.llmWrite ? '开' : '关'}）`);
  } catch { /* ignore */ }
  startLoop();
}
export function available() { return true; }
export function activate() { startLoop(); }
export function deactivate() { stopLoop(); }
export function dispose() { stopLoop(); }

export const providers = {
  // 注意：**刻意不提供 promptSections** —— 回忆走知识库检索，不再每日注入提示词。
  'autobiography.recent': (args) => recent(args?.limit),
  'autobiography.consolidate': (args) => consolidateNow(Number(args?.now) || Date.now())
};

/** 排障/自测用。 */
export const __internals = {
  STORE_FILE, SELF_STATE_FILE, DASHBOARD_FILE,
  cfg, dayKey, isToday, isNight, readNodes, writeNodes, hasNode,
  sleepState, collectToday, consolidate, consolidateNow, recent, writeToKnowledgeBase,
  tick   // 睡眠轮询体：自测里直接驱动（可传时间），不用等 60s 定时器
};
