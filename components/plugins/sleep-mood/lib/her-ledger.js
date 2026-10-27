// 近况账本（her-ledger，2026-10-22）
//
// ── 它治什么 ──────────────────────────────────────────────────────────────
// 她群里说"我吃过了"，转头私聊又说"还没吃"；一句"我困了"能挂一整晚。
// 不是记忆问题 —— 是**她自己宣称过的生活状态没有登记处**：
//   · lib/self-state.js 记的是引擎**推演**出来的活动（现在在睡/在忙），那是"她客观上在干什么"
//   · 长期记忆记的是**群友**说过什么、以及关于别人的事实
//   · 唯独"她自己嘴上说过什么"没人管，于是最容易自相矛盾
//
// ── 三条硬规则（都是踩出来的）─────────────────────────────────────────────
// 1. 判据必须第一人称或省略主语，且**整句不出现第二/第三人称** ——
//    否则「快去睡」「你跑去上学」会被记成她自己的状态（实测误记过三句）。
// 2. 同类只留最新 + 各有 TTL —— 吃完三小时就过期，不需要她一辈子记得"吃过饭"。
// 3. 可见性分向（结构上不靠自觉）：
//      群里说的 → 群里、私聊都能看见
//      私聊说的 → **只在私聊可见**，绝不往群里漏
//
// ── 它不做的事 ────────────────────────────────────────────────────────────
// · 不进长期记忆库（那是另一套）；只活几小时
// · 不调模型、不判断真假：她说什么就记什么（她真改口了，就记新的那条）
// · 不删原始消息（原始记录永远是唯一真相源）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = 'her-ledger.json';
const MAX_ENTRIES = 24;
const MAX_LINES = 3;
const MAX_CHARS = 90;

/**
 * 顺序有意义：先匹配更具体的（洗澡 → 吃饭 → 睡 → 困 → 忙 → 出门）。
 * ttl 是"这句话还值得硬拦多久"。
 */
const KINDS = [
  { kind: 'washed', label: '洗过澡了', ttl: 1.5 * 3600e3, re: /(我.{0,3}洗澡|冲个澡|洗完澡了|我洗完了)/ },
  { kind: 'ate', label: '吃过饭了', ttl: 3 * 3600e3, re: /(我.{0,4}吃(饭|过|饱|完)|我吃不下|吃饭去了|刚吃完|我不饿|我吃完)/ },
  { kind: 'sleep', label: '睡过了', ttl: 10 * 3600e3, re: /(我.{0,3}(睡|躺)|我先睡|我去睡|我要睡|真睡了|我睡着了)/ },
  { kind: 'tired', label: '有点困', ttl: 6 * 3600e3, re: /(我.{0,4}(困|累)|困死|累死|我没睡好|我熬夜)/ },
  { kind: 'busy', label: '在忙', ttl: 2 * 3600e3, re: /(我在忙|我在写|我在改|我在弄|我先忙|忙完再|我这边有事)/ },
  { kind: 'out', label: '出门了', ttl: 4 * 3600e3, re: /(我(要|得|先)?出门|我出去(一下|趟)|我在外面|我回家了|我在路上)/ },
];

/** 整句出现第二/第三人称 = 多半不是在说她自己的状态（"你快去睡"）。 */
const OTHER_PERSON = /(你|您|他|她|你们|他们|她们)/;
/** 疑问句不算宣称（"我吃了吗"）。 */
const QUESTION = /[?？]/;

function filePath() {
  try { return path.join(DATA_DIR, FILE); } catch { return ''; }
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(j?.entries) ? j.entries : [];
  } catch { return []; }
}

function writeAll(entries) {
  const p = filePath();
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
  } catch { /* 写不进去就当没记：绝不能让账本拖累对话 */ }
}

/** 去掉动作/标点后判"是不是同一句话"，用于防重复记。 */
function norm(text) {
  return String(text || '')
    .replace(/[（(][^）)]{0,30}[）)]/g, '')
    .replace(/[\s，。、！？,.'"“”‘’…—～~()（）:：;；]+/g, '')
    .trim();
}

function scopeOf(chatKey) {
  return String(chatKey || '').startsWith('group:') ? 'group' : 'private';
}

function agoLabel(ms) {
  const m = Math.round(ms / 60000);
  if (m <= 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  return `${h} 小时前`;
}

/**
 * 记一条"她自己说的生活状态"。没命中任何类就什么都不做。
 *
 * @param {string} text 她发出去的那句话
 * @param {{chatKey?: string}} ctx 这条话是发在哪个会话（决定可见性）
 * @returns {string} 记下的 kind（没记就返回空串）
 */
export function noteHerState(text, { chatKey = '' } = {}) {
  try {
    const s = String(text || '').trim();
    if (!s || s.length > 80) return '';
    if (QUESTION.test(s)) return '';
    if (OTHER_PERSON.test(s)) return '';
    const hit = KINDS.find((k) => k.re.test(s));
    if (!hit) return '';

    const now = Date.now();
    const all = readAll();
    // 同一句话刚记过就不重复写（她连发两条一样的，不该刷两条记录）
    const prev = all.find((e) => e && e.kind === hit.kind);
    if (prev && norm(prev.text) === norm(s)) return hit.kind;
    // 同类只留最新：先把同类和过期项清掉，再插新的
    const entries = all.filter((e) => e && e.kind !== hit.kind && (now - Number(e.at || 0)) < 24 * 3600e3);

    entries.unshift({
      kind: hit.kind,
      label: hit.label,
      at: now,
      scope: scopeOf(chatKey),
      text: s.slice(0, MAX_CHARS)
    });
    writeAll(entries.slice(0, MAX_ENTRIES));
    return hit.kind;
  } catch {
    return '';
  }
}

/**
 * 当前还"有效"的条目（按 TTL 过期，按可见性过滤）。
 *
 * @param {{isPrivate?: boolean, chatKey?: string}} ctx
 * @returns {Array<{kind:string,label:string,at:number,scope:string,text:string}>}
 */
export function liveStates({ isPrivate = false, chatKey = '' } = {}) {
  const priv = isPrivate || String(chatKey || '').startsWith('private:');
  const now = Date.now();
  const out = [];
  for (const e of readAll()) {
    if (!e || !e.kind || !e.at) continue;
    const k = KINDS.find((x) => x.kind === e.kind);
    if (!k) continue;
    if (now - Number(e.at) > k.ttl) continue;
    // 私聊说的只能进私聊；群里说的两边都能看见
    if (e.scope === 'private' && !priv) continue;
    out.push(e);
  }
  return out.sort((a, b) => Number(b.at) - Number(a.at));
}

/**
 * 生成要注入的**一行**（没有有效状态就返回空串）。
 *
 * 为什么只给事实、不给命令：她的反应由她自己定，这里只负责"别自相矛盾"。
 *
 * @param {{isPrivate?: boolean, chatKey?: string}} ctx
 * @returns {string}
 */
export function herStateLine(ctx = {}) {
  const live = liveStates(ctx);
  if (!live.length) return '';
  const now = Date.now();
  const items = live.slice(0, MAX_LINES).map((e) => `${agoLabel(now - Number(e.at))}说「${String(e.label || '')}」`);
  return `【你刚说过的生活状态】${items.join('；')}。`
    + '这轮别跟它打架：真改了就明说"其实还没/又饿了"，别装作没说过。';
}

/** 排查用：当前生效条目数（不含过滤）。 */
export function herStateCount() {
  try { return readAll().length; } catch { return 0; }
}
