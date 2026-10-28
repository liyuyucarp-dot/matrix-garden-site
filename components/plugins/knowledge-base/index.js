/**
 * knowledge-base —— 本地知识库（确定性型插件 / API v1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 用户把一个 txt 丢进 data/knowledge-base/，机器人就该学会它；回答问题时
 * **先翻本地、翻不到再上网**；网上搜到的有价值内容**存回本地**，下次直接命中。
 *
 * ── 为什么是插件，不是技能 ────────────────────────────────────────────────
 * 判据（src/skills/manifest.js 的 DIR_KIND）：
 *   plugins/ 确定性型 —— 条件满足**必然执行**，不经过 LLM
 *   skills/  LLM 型   —— 注册工具，用不用由模型判断
 *
 * "把目录里的文件变成可检索的索引"是纯机械动作：读文件、切段、建索引、监听变化。
 * 这件事**必须无条件发生**，不能等模型想起来。实测过的教训：光靠"模型自己每轮
 * 记得去读知识库"是不可靠的，它经常忘 —— 目录里有资料但它整轮都不查。
 * 所以索引与注入在这里（钩子必然执行）；"查到之后怎么用"则是本条目额外注册的
 * 五个工具（kb_search / kb_read / kb_remember / kb_update / kb_status）。
 *
 * 命名不是随手起的：src/config.js 的 LEGACY_SKILL_MIGRATIONS 里有一条
 *   { from: ['tools','knowledgeEnabled'], skill: 'knowledge-base' }
 * 注释写着"知识库技能尚未移植，先留位" —— 本插件就是来补这个坑位的，
 * 老用户配置里的知识库开关能直接对上。
 *
 * ── 检索怎么做的（为什么不用"整库塞进提示词"）────────────────────────────
 * 整库塞进上下文有两头不讨好：库小了没用，库大了每轮都烧 token 且淹没聊天本身。
 * 这里的做法是「目录常驻 + 命中给详情」（与 plugins/meme-tracker 的 index 模式
 * 同构，是这套系统里已经被验证过的形态）：
 *   · 每轮只带一份极短的目录（有哪些资料，每条一行）
 *   · 本轮话题真的命中某条时，才把那条的正文给它
 *   · 需要更多细节，模型自己调 kb_search / kb_read
 *
 * ── 元数据层（v1.1，本次新增）────────────────────────────────────────────
 * 解决三件原来做不到的事：
 *   ① **能改写已写入的文档** —— 新增 kb_update（按 ref 改正文/权重/标签），
 *      remember 新增 mode:'replace' 整篇覆盖；
 *   ② **同一件事反复记要合并到一处** —— learned 文件开头可有 front-matter，
 *      里面记 `topic`；同 topic 就是同一个文件。remember 的 mode:'upsert'
 *      按 topic 找到旧文件后**替换正文**，而不是再开一个新文件；
 *   ③ **条目分重要等级且参与排序** —— front-matter 里的 `weight`（1..5）参与
 *      kb_search 的排序（默认 0.12 的力度，设 0 就完全不参与）。
 *
 * front-matter 是**可选**的：没有它的旧文件照样检索，topic 取"文件名归一化"、
 * weight 取默认 3。索引构建时 front-matter 会被**剥掉**，绝不让 `weight:` 这类
 * 字段混进 sections 正文污染检索。
 *
 * ── 踩坑备忘（都是实际会咬人的）──────────────────────────────────────────
 *   · **编码**：Windows 上的中文 txt 大量是 GBK。按 UTF-8 硬读不报错，只是整篇
 *     变乱码 —— 然后所有检索都失效，且看不出为什么。所以先试 UTF-8（严格模式，
 *     非法字节会抛错），失败再退 GB18030（GBK 的超集）。
 *   · **BOM**：记事本存 UTF-8 会带 BOM，留在段落开头会污染第一个检索词。
 *   · **fs.watch 的重复事件**：往目录里复制一个文件会触发好几次事件，不防抖就会
 *     反复重建整库索引。
 *   · **中文分词**：中文没有空格，整句当词永远匹配不上。用**字符二元组**
 *     （「人工智」→ 人工/工智）—— 这是中文检索的常规做法，不需要词典。
 *   · **front-matter 的健壮性**：解析器必须"认不出来就当普通正文"。宁可让它
 *     解析失败（内容原样保留、照常可检索），也绝不能把用户的正文吃掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { setSkillConfig } from '../../src/skills/config.js';
import { skillManager } from '../../src/skills/manager.js';

const BUILD_TAG = 'v1.1.0';
const ENTRY_ID = 'knowledge-base';

const KB_DIR = path.join(DATA_DIR, 'knowledge-base');
const LEARNED_DIR = path.join(KB_DIR, 'learned');
const INDEX_FILE = path.join(KB_DIR, '.index.json');
const README_FILE = path.join(KB_DIR, 'README.md');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
const INDEX_VERSION = 1;
const MIN_SECTION_CHARS = 8;

// ── 元数据层常量 ──────────────────────────────────────────────────────────
/** 重要等级取值范围（1 最不重要 / 5 最重要，3 = 中性）。 */
const WEIGHT_MIN = 1;
const WEIGHT_MAX = 5;
const WEIGHT_DEFAULT = 3;
/** topic 归一化后最多保留多少字符（再长就没有区分意义了）。 */
const TOPIC_MAX_CHARS = 40;
/** front-matter 区块的最大长度：超过这个还"闭合"的多半是正文里的分隔线。 */
const FRONT_MATTER_MAX_CHARS = 2000;
/** front-matter 里认的 key 形状（非法 key 一律判为"不是 front-matter"）。 */
const FM_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]{0,32})\s*[:：]\s*(.*)$/;
/**
 * front-matter 的**已知键**（准入签名）。
 *
 * 判定规则是"区块里至少有一个已知键"才算 front-matter。理由见 parseFrontMatter
 * 的注释：`---\nNote: 普通笔记\n---` 这种用户手写文档在结构上和元数据无法区分，
 * 但语义上完全不同 —— 前者是正文（必须能被检索到），后者是元数据（必须被剥掉）。
 * 元数据是我们自己写的，已知键就是它的签名，比"任意 ASCII key"严格得多。
 */
const KNOWN_FM_KEYS = new Set(['topic', 'weight', 'tags', 'created', 'updated']);
/** 自动记录文件里那行 h1 下方的固定注释（改文案会让回归对照的字节变掉，别动）。 */
const HEADER_COMMENT = '<!-- 由「本地知识库」自动记录；你可以直接编辑、也可以整个删掉 -->';
/** allowWrite 关闭时的统一文案（工具与能力接口共用）。 */
const ERR_WRITE_OFF = '「允许机器人自己记东西」是关闭状态，不能写入。这次就不记了。';

const DEFAULTS = {
  enabled: true,
  maxFileKB: 1024,
  watchDebounceMs: 800,
  injectMode: 'index',
  indexMaxChars: 600,
  hitLimit: 3,
  hitMaxChars: 1200,
  snippetChars: 400,
  minScore: 0.12,
  stopWords: '',
  allowWrite: true,
  requireSource: true,
  defaultLimit: 5,
  maxLimit: 15,
  learnedMaxChars: 4000,
  learnedMaxFiles: 500,
  // 重要等级参与排序的力度：score ×= 1 + weightBoost × (weight − 3)。
  // 0.12 → w5 是 ×1.24、w1 是 ×0.76；设 0 则完全不参与（退回纯相关度排序）。
  weightBoost: 0.12
};

// ───────────────────────────── 运行态 ─────────────────────────────

const state = {
  docs: [],            // 索引后的文档（含分段与词频）
  sections: [],        // 扁平化后的分段列表（检索用）
  df: new Map(),       // token -> 出现在多少个分段里（算 IDF 用）
  avgLen: 1,
  builtAt: 0,
  building: false,
  skipped: [],         // [{ rel, reason }] 被跳过的文件（要让人看得见，不能静默）
  errors: [],
  watcher: null,
  watchTimer: null,
  dirty: false
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let pendingReads = [];   // 本次会话读过的（供 kb_status 显示"最近查过什么"）

// ───────────────────────────── 小工具 ─────────────────────────────

/** 工具入参容错：有些端点会把参数裹成 JSON 字符串传进来。 */
function parseArgs(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return args || {};
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}


function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return v !== false;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  const mode = String(pick('injectMode') || 'index').toLowerCase();
  return {
    enabled: bool(s.enabled, DEFAULTS.enabled),
    maxFileKB: Math.max(64, Math.min(16384, Math.round(num(pick('maxFileKB'), DEFAULTS.maxFileKB)))),
    watchDebounceMs: Math.max(200, Math.min(10000, Math.round(num(pick('watchDebounceMs'), DEFAULTS.watchDebounceMs)))),
    injectMode: ['index', 'hit', 'off'].includes(mode) ? mode : 'index',
    indexMaxChars: Math.max(100, Math.min(3000, Math.round(num(pick('indexMaxChars'), DEFAULTS.indexMaxChars)))),
    hitLimit: Math.max(1, Math.min(10, Math.round(num(pick('hitLimit'), DEFAULTS.hitLimit)))),
    hitMaxChars: Math.max(200, Math.min(6000, Math.round(num(pick('hitMaxChars'), DEFAULTS.hitMaxChars)))),
    snippetChars: Math.max(80, Math.min(2000, Math.round(num(pick('snippetChars'), DEFAULTS.snippetChars)))),
    minScore: Math.max(0, Math.min(1, num(pick('minScore'), DEFAULTS.minScore))),
    stopWords: Array.isArray(s.stopWords) ? s.stopWords.join(',') : str(s.stopWords, DEFAULTS.stopWords),
    allowWrite: bool(s.allowWrite, DEFAULTS.allowWrite),
    requireSource: bool(s.requireSource, DEFAULTS.requireSource),
    defaultLimit: Math.max(1, Math.min(15, Math.round(num(pick('defaultLimit'), DEFAULTS.defaultLimit)))),
    maxLimit: Math.max(1, Math.min(30, Math.round(num(pick('maxLimit'), DEFAULTS.maxLimit)))),
    learnedMaxChars: Math.max(200, Math.min(20000, Math.round(num(pick('learnedMaxChars'), DEFAULTS.learnedMaxChars)))),
    learnedMaxFiles: Math.max(10, Math.min(5000, Math.round(num(pick('learnedMaxFiles'), DEFAULTS.learnedMaxFiles)))),
    // 排序权重力度：0 = 不参与；上限 1 是防止有人填 50 让权重彻底压过相关度
    weightBoost: Math.max(0, Math.min(1, num(pick('weightBoost'), DEFAULTS.weightBoost)))
  };
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 相对 KB_DIR 的路径，统一正斜杠（Windows 反斜杠在提示词里很扎眼）。 */
function relOf(abs) {
  return path.relative(KB_DIR, abs).replace(/\\/g, '/');
}

/** 当前时间戳，形如 `2026-10-21 19:02:33`。 */
function stampNow(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} `
    + `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** 只到分钟的时间戳（自动记录里那行「> 记于」沿用这个粒度，保持老文件形态）。 */
function stampMinute(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} `
    + `${p(now.getHours())}:${p(now.getMinutes())}`;
}

/** 只到日的时间戳（追加小节时的兜底标题）。 */
function stampDay(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ───────────────────────────── 元数据层 ─────────────────────────────

/**
 * 把标题归一化成 topic 键。**同 topic 就是同一个文件**。
 *
 * 规则：卸掉 `主人说·` / `共识·` 这类来源前缀 → 全角转半角（NFKC）→
 * 去掉所有标点与空白 → 小写 → 截断 40 字符。
 *
 * 为什么必须卸前缀：learning-loop 给同一件事的两条记录会分别起名
 * `主人说·退款政策` 和 `共识·退款政策` —— 不卸前缀就是两个 topic、
 * 两个文件，正是"同一件事反复记、越记越散"的根因。
 *
 * @param {string} title 人类可读的标题
 * @returns {string} 归一化后的 topic（永不为空，最差是 'untitled'）
 */
export function topicOf(title) {
  let s = String(title ?? '');
  // NFKC：全角字母/数字/标点 → 半角（"ＡＢＣ"→"abc"、"："→":"），中文汉字不受影响
  try { s = s.normalize('NFKC'); } catch { /* 老引擎没有 normalize 就跳过 */ }
  // 来源前缀：主人说· / 共识· / 共识:
  s = s.replace(/^\s*(?:主人说|共识)\s*[·・:：\-—_|｜>》]+\s*/u, '');
  // 只留字母（含中文）/数字，其余（标点、空白、emoji）全去掉
  s = s.replace(/[^\p{L}\p{N}]+/gu, '');
  s = s.toLowerCase();
  return s.slice(0, TOPIC_MAX_CHARS) || 'untitled';
}

/**
 * 解析 front-matter 里的 weight。**非数字一律返回 null（= 忽略）**，
 * 越界夹紧到 1..5。
 *
 * @param {*} v 原始值
 * @returns {number|null}
 */
function weightOf(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round(n)));
}

/** weight 取值，非法/缺省时用 dflt。 */
function weightOr(v, dflt = WEIGHT_DEFAULT) {
  const w = weightOf(v);
  return w === null ? dflt : w;
}

/**
 * 解析文首的 front-matter。
 *
 * **健壮性优先**：只有**同时**满足下面五条才认，否则一律当普通正文（内容一个字不丢）：
 *   ① 首行（允许 BOM / 前导空格）是 `---`；
 *   ② 存在**闭合**的 `---` 行；
 *   ③ 中间每一行（忽略空行）都是 `key: value` 形状；
 *   ④ 整个区块不超过 FRONT_MATTER_MAX_CHARS（防止把正文里的分隔线误吞）；
 *   ⑤ **区块里至少要有一个已知键**（`topic / weight / tags / created / updated`，大小写不敏感）。
 *
 * 为什么这么保守：Markdown 里 `---` 本身是水平分隔线，大量正常文档开头就有。
 * 认错一次的后果是把正文当元数据扔掉 —— 文件还在盘上，但那段内容**检索不到**，
 * 也就是"内容静默消失"，比崩溃更糟。而"没认出 front-matter"最多是权重不生效，
 * 属于可接受的降级。
 *
 * ── 第 ⑤ 条是 QA 现场抓出来的一个真实误伤 ────────────────────────────────
 * 之前只要求"至少有一个 key"，于是这种**完全正常的用户笔记**被判成了元数据：
 *
 *     ---
 *     Note: 这是一段普通笔记          ← ASCII 冒号，撞上 key: value 的形状
 *     ---
 *     正文……
 *
 * 结果 `Note:` 和紧随其后的正文一起被当成元数据剥掉，那段笔记在检索里彻底消失。
 * 用"必须含已知键"来判定是最小且严格的收口：元数据是我们自己写的，已知键就是它的
 * 签名；用户手写文档不会恰好用到 `topic/weight/tags/created/updated` 这几个词。
 * （顺带：`---\n第一章：概述\n---` 这种中文冒号本来就连第 ③ 条都过不了。）
 *
 * ⚠️ 注意"键合法但值非法"（如 `weight: abc`）**仍然算 front-matter**：
 *    值的合法性由 weightOf() 兜底（非法 → 回落默认 3），不能因为值写错就把整块
 *    降级成正文 —— 那会把同一块里的 `topic` 一起丢进正文，反而更脏。
 *
 * @param {string} text 文件全文
 * @returns {{ok:boolean, meta:(Object|null), body:string, raw:string, reason:string}}
 */
export function parseFrontMatter(text) {
  const src = String(text ?? '');
  const miss = (reason) => ({ ok: false, meta: null, body: src, raw: '', reason });
  if (!src) return miss('空文本');

  const m = src.match(/^\uFEFF?[ \t]*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/);
  if (!m) return miss('没有闭合的 --- 区块');
  if (m[1].length > FRONT_MATTER_MAX_CHARS) return miss(`区块过长（${m[1].length} 字）`);

  const meta = Object.create(null);
  let keys = 0;
  let known = 0;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 注释行（# 开头）直接忽略：允许 `# 说明`，不影响合法性判定
    if (line.startsWith('#')) continue;
    const kv = line.match(FM_KEY_RE);
    if (!kv) return miss(`有不是 key: value 的行（${clip(line, 24)}）`);
    const key = kv[1].toLowerCase();
    // 同一个 key 出现两次以最后一次为准（不报错，宽容处理）
    meta[key] = kv[2].trim();
    keys += 1;
    if (KNOWN_FM_KEYS.has(key)) known += 1;
  }
  if (!keys) return miss('区块里没有任何 key');
  // ⑤ 没有已知键 → 这是用户的普通文档（`Note: …` 这类），整块当正文
  if (!known) return miss(`区块里没有已知的元数据键（${[...KNOWN_FM_KEYS].join('/')}）`);

  return { ok: true, meta, body: src.slice(m[0].length), raw: m[0], reason: '' };
}

/**
 * 生成 front-matter 区块文本（不含结束换行）。
 * key 顺序固定，未知 key 排在后面 —— 让人肉编辑时看着稳定。
 */
export function serializeFrontMatter(meta) {
  const src = meta || {};
  const order = ['topic', 'weight', 'tags', 'created', 'updated'];
  const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  const lines = ['---'];
  const used = new Set();
  for (const k of order) {
    used.add(k);
    const v = clean(src[k]);
    if (!v) continue;
    lines.push(`${k}: ${v}`);
  }
  for (const k of Object.keys(src)) {
    if (used.has(k)) continue;
    const v = clean(src[k]);
    if (!v) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** 把 tags 统一成逗号分隔的字符串（数组/字符串都收）。 */
function tagsOf(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean).join(',');
  return str(v);
}

// ───────────────────────────── 编码 ─────────────────────────────

/**
 * 读文本文件并**猜对编码**。
 *
 * 顺序：BOM 判断 → UTF-8 严格解码 → GB18030 兜底。
 * 为什么必须先严格 UTF-8 再 GB18030：GB18030 几乎能把任意字节序列解成"某些字"，
 * 所以如果先试它，UTF-8 文件也会"成功"解出乱码且不报错。反过来则安全。
 */
export function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return { text: '', encoding: 'empty' };
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  // UTF-16 BOM（记事本"Unicode"另存就会这样）
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    try {
      return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
    } catch { /* 下面继续 */ }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try {
      return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
    } catch { /* 下面继续 */ }
  }
  // UTF-8 严格模式：非法字节直接抛错
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch { /* 不是合法 UTF-8，试中文编码 */ }
  // GB18030 是 GBK/GB2312 的超集，覆盖绝大多数中文 txt
  try {
    return { text: new TextDecoder('gb18030').decode(buf), encoding: 'gb18030' };
  } catch (error) {
    warn(`GB18030 解码也失败，按 UTF-8 有损解码：${error?.message ?? error}`);
    return { text: buf.toString('utf8'), encoding: 'utf-8 (有损)' };
  }
}

/** 二进制嗅探：有 NUL 字节的基本不是文本（防用户丢进来一个 exe/图片）。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// ───────────────────────────── 切段 ─────────────────────────────

/**
 * 把一个文件切成若干"知识段"。
 *
 * 优先按 Markdown 标题分，其次按空行分段。标题会拼成 `文件 › 大节 › 小节`
 * 这样检索结果里能看清出处，模型也更容易判断该不该用。
 */
export function splitSections(text, { fileTitle = '' } = {}) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];

  // ① 按标题切（记录层级，用来拼完整路径）
  const lines = src.split('\n');
  const hasHeadings = lines.some((l) => /^#{1,6}\s+\S/.test(l));

  if (hasHeadings) {
    let crumbs = [];        // 标题层级栈
    let buf = [];
    const flush = () => {
      const body = buf.join('\n').trim();
      buf = [];
      if (!body) return;
      // 有标题时：这一节的标题栈就是它的出处
      const headingPath = crumbs.filter(Boolean);
      for (const piece of splitByBlankLine(body)) {
        if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
        out.push({
          heading: headingPath.join(' › ') || fileTitle,
          text: piece
        });
      }
    };
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const level = m[1].length;
        // ⚠️ 先截断到 level-1，再写这一层 —— 关键是**截断要去掉这一层原有的值**。
        //   原来只写 `crumbs = crumbs.slice(0, level - 1)` 看着没错，但对
        //   `level = 2` 它保留 index 0；紧接着的 `crumbs[1] = …` 是往一个**仍在**
        //   的数组尾巴上写，而 index 1 上可能还留着上一个 2 级标题的文字，
        //   slice(0,1) 并不会清掉它 —— 于是新标题会带上一层旧的父级。
        //   实测：一个 `# 标题` + `## 标题` 的文件被解析成「标题 › 标题 › 标题」，
        //   多级标题的文档整篇出处都会错位。
        crumbs = crumbs.slice(0, level - 1);
        crumbs[level - 1] = m[2].trim();
        continue;
      }
      buf.push(line);
    }
    flush();
    // 标题下直接有正文的情况已经被 flush 收走了；只剩"标题但完全没正文"的文件
    if (!out.length) {
      const body = src.replace(/^#{1,6}\s+.*$/gm, '').trim();
      if (body) {
        for (const piece of splitByBlankLine(body)) {
          if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
          out.push({ heading: fileTitle, text: piece });
        }
      }
    }
  } else {
    for (const piece of splitByBlankLine(src)) {
      if (piece.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
      out.push({ heading: fileTitle, text: piece });
    }
  }

  // 兜底：普通文本但整篇没有空行（很多人一个 txt 从头写到尾）
  if (!out.length && src.trim().length >= MIN_SECTION_CHARS) {
    for (const piece of chunkLong(src.trim(), 800)) {
      out.push({ heading: fileTitle, text: piece });
    }
  }
  return out;
}

function splitByBlankLine(text) {
  return String(text ?? '').split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
}

/** 超长且无分段时按字数硬切（带重叠，避免切断句子后检索不到）。 */
function chunkLong(text, size) {
  const out = [];
  const overlap = Math.floor(size * 0.15);
  for (let i = 0; i < text.length; i += size - overlap) {
    const piece = text.slice(i, i + size).trim();
    if (piece) out.push(piece);
    if (i + size >= text.length) break;
  }
  return out;
}

// ───────────────────────────── 分词与检索 ─────────────────────────────

/**
 * 分词。中文用字符二元组，拉丁字母/数字按词。
 *
 * 举例：「客服电话是 400-123」
 *   → 客服 / 服电 / 电话 / 400 / 123 / 400123
 * 二元组的好处是不需要词典就能覆盖绝大多数中文查询；代价是会有一些无意义组合，
 * 但它们在同库内部一致，靠 IDF 权重自然被压下去。
 */
export function tokenize(text, stopWords = new Set()) {
  const raw = String(text ?? '').toLowerCase();
  const tokens = [];

  // 拉丁词与数字
  for (const m of raw.matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length >= 2 && !stopWords.has(w)) tokens.push(w);
  }

  // 连续 CJK 串 → 二元组
  for (const m of raw.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      if (!stopWords.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!stopWords.has(bigram)) tokens.push(bigram);
    }
  }
  return tokens;
}

function parseStopWords(s) {
  return new Set(
    String(s ?? '')
      .split(/[\s,，、;；\n]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length >= 1 && x.length <= 8)
  );
}

/** 建索引用：统计一个分段的词频。 */
function termFreq(text, stopWords) {
  const tf = new Map();
  for (const t of tokenize(text, stopWords)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

// ───────────────────────────── 索引构建 ─────────────────────────────

/**
 * 扫描并重建整个索引。
 * @param {{reason?:string}} opts
 */
export function buildIndex({ reason = 'manual' } = {}) {
  if (state.building) return { ok: false, error: '索引正在构建中' };
  state.building = true;
  const started = Date.now();
  const s = settings();
  const stopWords = parseStopWords(s.stopWords);
  const maxBytes = s.maxFileKB * 1024;

  const docs = [];
  const sections = [];
  const skipped = [];
  const errors = [];
  const df = new Map();

  try {
    if (!fs.existsSync(KB_DIR)) {
      fs.mkdirSync(LEARNED_DIR, { recursive: true });
      log(`已创建知识库目录：${KB_DIR}`);
    }

    const files = walkFiles(KB_DIR);
    for (const abs of files) {
      const rel = relOf(abs);
      const base = path.basename(abs);
      // 内部文件不当资料
      if (base.startsWith('.')) continue;
      if (abs === README_FILE) continue;

      const ext = path.extname(abs).toLowerCase();
      if (!TEXT_EXT.has(ext)) {
        skipped.push({ rel, reason: `不是 txt/md（${ext || '无扩展名'}）` });
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (error) {
        errors.push({ rel, reason: `读不到文件信息：${error?.message ?? error}` });
        continue;
      }
      if (stat.size > maxBytes) {
        skipped.push({ rel, reason: `超过 ${s.maxFileKB}KB（实际 ${Math.round(stat.size / 1024)}KB）` });
        continue;
      }
      if (stat.size === 0) {
        skipped.push({ rel, reason: '空文件' });
        continue;
      }

      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch (error) {
        errors.push({ rel, reason: `读取失败：${error?.message ?? error}` });
        continue;
      }
      if (looksBinary(buf)) {
        skipped.push({ rel, reason: '看起来是二进制文件（含 NUL 字节）' });
        continue;
      }

      const { text: rawText, encoding } = decodeTextBuffer(buf);
      const fileTitle = base.replace(/\.(txt|md|markdown)$/i, '');

      // ⚠️ 先剥 front-matter，再剥 HTML 注释，最后才切段。
      //   顺序很重要：front-matter 区块里的 `topic:` / `weight:` 一旦进了正文，
      //   就会变成可检索的词（"weight" 这类词还会污染所有 learned 文件的词频），
      //   检索结果里也会多出 `weight: 4` 这种看着像正文的噪音。
      //   只影响**索引里的文本**，磁盘上的文件一个字都不动。
      const fm = parseFrontMatter(rawText);
      const bodyText = fm.ok ? fm.body : rawText;
      // 元信息（可选字段）：老文件没有 front-matter 时按"文件名归一化 + 中性权重"兜底，
      // 所以旧文件的行为和改造前完全一致。
      const docTopic = fm.ok && str(fm.meta.topic) ? topicOf(fm.meta.topic) : topicOf(fileTitle);
      const docWeight = fm.ok ? weightOr(fm.meta.weight) : WEIGHT_DEFAULT;

      // 索引前剥掉 HTML 注释：自动记录的文件里有「<!-- 由…自动记录 -->」这种
      // 说明行，它对检索毫无价值，却会在命中详情里占掉正文的位置。
      const text = bodyText.replace(/<!--[\s\S]*?-->/g, ' ');
      // 切段时把**带扩展名的文件名**作为出处标题传给无标题文件：
      // 单纯一个 "测试_术语表" 在引用块里看不出是资料名还是正文里的标题。
      const pieces = splitSections(text, { fileTitle: base });

      // ⚠️ 必须把紧跟正文的「元数据块」并回上一段。
      //   记录格式是「正文 / 空行 / > 来源：… / > 记于 …」，按空行切的话
      //   那两行引用会各自变成一个独立"知识段" —— 检索时它们分数最高，
      //   于是模型拿到的命中详情全是「来源：xxx」「记于 yyy」这种噪音，
      //   真正的答案反而被挤掉。这一步把纯元数据段合并到前一段。
      const merged = [];
      for (const piece of pieces) {
        const lines = piece.text.split('\n').map((l) => l.trim()).filter(Boolean);
        const isMetaOnly = lines.length > 0 && lines.every((l) => /^>\s*(来源|标签|记于)/.test(l));
        if (isMetaOnly && merged.length) {
          merged[merged.length - 1].text += `\n\n${piece.text}`;
          continue;
        }
        merged.push(piece);
      }

      const docSections = [];
      for (let i = 0; i < merged.length; i += 1) {
        const piece = merged[i];
        // ⚠️ 索引**正文**，把记录元数据行（> 来源 / > 标签 / > 记于）剔出去。
        //   理由很实在：这些行里有日期和"来源""记于"这类高频词，
        //   留在正文里会参与 TF 打分、把检索分数抬高，让一条"只有元数据"的
        //   分段也能霸占命中结果（实测出现过整段只有「> 来源：人工整理
        //   > 记于 …」却排在正文前面的情况）。
        //   只影响索引文本；kb_read 读全文时仍给用户看到完整原文。
        const bodyForIndex = piece.text
          .split('\n')
          .filter((l) => !/^\s*>\s*(来源|标签|记于)/.test(l))
          .join('\n')
          .trim();
        // 整段都是元数据 → 不建索引段（它不含任何知识）
        if (!bodyForIndex || bodyForIndex.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;

        const tf = termFreq(`${piece.heading}\n${bodyForIndex}`, stopWords);
        const len = [...tf.values()].reduce((a, b) => a + b, 0) || 1;
        const sec = {
          // id 用「已收录段的序号」而不是 i：跳过的元数据段不会在 ref 里留空号
          id: `${rel}#${docSections.length + 1}`,
          doc: rel,
          docTitle: fileTitle,
          heading: piece.heading || fileTitle,
          text: piece.text,
          tf,
          len,
          source: rel.startsWith('learned/') ? 'learned' : 'user',
          // 元信息（可选）：没有 front-matter 的旧文件 = 文件名 topic + 中性权重
          topic: docTopic,
          weight: docWeight
        };
        docSections.push(sec);
        sections.push(sec);
        for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      }

      if (!docSections.length) {
        skipped.push({ rel, reason: '没有可用的正文内容（太短或全是标题/元数据）' });
        continue;
      }

      docs.push({
        rel,
        title: fileTitle,
        encoding,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        sections: docSections.length,
        source: rel.startsWith('learned/') ? 'learned' : 'user',
        // 元信息（可选字段）
        topic: docTopic,
        weight: docWeight
      });
    }

    state.docs = docs;
    state.sections = sections;
    state.df = df;
    state.avgLen = sections.length ? sections.reduce((a, x) => a + x.len, 0) / sections.length : 1;
    state.builtAt = Date.now();
    state.skipped = skipped;
    state.errors = errors;
    state.dirty = false;

    saveIndex();
    log(`索引已重建（${reason}）：${docs.length} 个文件 / ${sections.length} 段 / ${df.size} 个词`
      + `${skipped.length ? `／跳过 ${skipped.length} 个文件` : ''}，耗时 ${Date.now() - started}ms`);
    return { ok: true, docs: docs.length, sections: sections.length, skipped, errors, ms: Date.now() - started };
  } catch (error) {
    const msg = error?.message ?? String(error);
    state.errors = [...errors, { rel: '(整体)', reason: msg }];
    warn(`重建索引失败：${msg}`);
    return { ok: false, error: msg, skipped, errors: state.errors };
  } finally {
    state.building = false;
  }
}

/** 递归列出目录下所有文件（跳过隐藏目录）。 */
function walkFiles(dir, depth = 0) {
  const out = [];
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...walkFiles(abs, depth + 1));
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** 索引落盘（只存元信息，正文每次从文件现读 —— 保证用户改了文件立刻生效）。 */
function saveIndex() {
  try {
    fs.mkdirSync(KB_DIR, { recursive: true });
    const payload = {
      version: INDEX_VERSION,
      builtAt: state.builtAt,
      docs: state.docs.map((d) => ({
        rel: d.rel, title: d.title, encoding: d.encoding, bytes: d.bytes,
        mtime: d.mtime, sections: d.sections, source: d.source,
        // ── 新增的**可选**字段（v1.1）──────────────────────────────────
        // version 不动、字段可缺省：旧索引读进来照样能用，新索引也不要求
        // 读取方认识它们。缺省语义 = topic 取 title 归一化、weight 取 3。
        topic: d.topic, weight: d.weight
      })),
      sections: state.sections.length,
      skipped: state.skipped,
      errors: state.errors
    };
    const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8');
    fs.renameSync(tmp, INDEX_FILE);
  } catch (error) {
    warn(`索引落盘失败（不影响使用）：${error?.message ?? error}`);
  }
}

// ───────────────────────────── 检索 ─────────────────────────────

/**
 * BM25-lite 检索。
 *
 * 打分 = Σ_t IDF(t) × 归一化词频(t) ，最后按查询词数归一化到 0~1。
 * 用 IDF 是关键：中文二元组会产生大量无意义组合（如「的服」），
 * 它们几乎出现在所有分段里 → IDF 趋近 0 → 自然被压掉。
 * 归一化到 0~1 是为了让 minScore 这个门槛在不同长度的查询下都讲得通。
 *
 * ── 重要等级（weight，可选）怎么参与 ──────────────────────────────────────
 * 过门槛之后、排序之前：`score *= 1 + weightBoost × (weight − 3)`。
 * 两个刻意的决定：
 *   · **放在门槛之后**：minScore 是"这条到底相不相关"的闸，weight 是"相关的那几条
 *     先给哪条"的偏好。若把 weight 乘在门槛前，一条 w1 的好内容会因为乘了 0.76
 *     直接掉出结果集 —— 那不是排序，那是丢召回。
 *   · **注入不走这条路**：见 hooks 里给 search 传 weightBoost: 0 的注释。
 *
 * @param {string} query 查询
 * @param {{limit?:number, minScore?:number|null, snippetChars?:number, weightBoost?:number|null}} opts
 */
export function search(query, { limit = 5, minScore = null, snippetChars = 400, weightBoost = null } = {}) {
  const s = settings();
  const q = String(query ?? '').trim();
  if (!q) return { ok: true, query: '', hits: [], total: state.sections.length, empty: true };
  if (!state.sections.length) return { ok: true, query: q, hits: [], total: 0 };

  const threshold = minScore === null || minScore === undefined ? s.minScore : num(minScore, s.minScore);
  // 调用方可显式传 weightBoost 覆盖设置（0 = 这一路完全不看权重）
  const boost = weightBoost === null || weightBoost === undefined
    ? s.weightBoost
    : Math.max(0, Math.min(1, num(weightBoost, s.weightBoost)));
  const stopWords = parseStopWords(s.stopWords);
  const qTokens = tokenize(q, stopWords);
  if (!qTokens.length) return { ok: true, query: q, hits: [], total: state.sections.length, reason: '查询词太短或全被过滤' };

  const qSet = [...new Set(qTokens)];
  const N = state.sections.length;
  const k1 = 1.2;
  const b = 0.6;
  const avg = state.avgLen || 1;
  // 归一化因子：按查询词数的**平方根**缩放，不是按词数本身。
  //
  // ⚠️ 这里踩过一个会直接毁掉「本地优先」的坑：最初用 `score / (词数 × 2.2)`，
  //   而中文二元组会把一句自然口语切出很多词 —— 「咱们的退款流程是啥」切出
  //   咱们/们的/的退/退款/款流/流程/程是/是啥 共 8 个，其中只有 3 个真命中，
  //   于是分数被线性稀释到 0.122，**刚好卡在 0.12 门槛上**；再长一点
  //   （「…是啥呢请问」）就直接归零，本地明明有资料却一条都给不出来。
  //   改成平方根后，词数从 3 涨到 9 只让分母涨约 1.7 倍，长句口语查询不再被误杀，
  //   而真正不相关的内容仍然过不了门槛（实测「毫不相关的话题xyz」依旧 0 命中）。
  const qNorm = Math.max(1, Math.sqrt(qSet.length)) * 2.2;
  const scored = [];

  for (const sec of state.sections) {
    let score = 0;
    for (const t of qSet) {
      const f = sec.tf.get(t);
      if (!f) continue;
      const dfv = state.df.get(t) || 1;
      const idf = Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5));
      if (idf <= 0) continue;
      const norm = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (sec.len / avg)));
      score += idf * norm;
    }
    if (score <= 0) continue;
    const normalized = score / qNorm;
    if (normalized < threshold) continue;
    const w = weightOr(sec.weight);
    // 过门槛之后才乘权重：weight 只改**先后**，不改**进出**
    const finalScore = boost > 0 ? normalized * (1 + boost * (w - WEIGHT_DEFAULT)) : normalized;
    scored.push({ sec, score: finalScore, weight: w });
  }

  scored.sort((a, b2) => b2.score - a.score);
  const top = scored.slice(0, Math.max(1, Math.min(30, Math.round(limit))));
  return {
    ok: true,
    query: q,
    total: state.sections.length,
    matched: scored.length,
    hits: top.map(({ sec, score, weight }) => ({
      ref: sec.id,
      doc: sec.doc,
      docTitle: sec.docTitle,
      heading: sec.heading,
      source: sec.source,
      score: Math.round(score * 1000) / 1000,
      // weight 给模型看：同样是命中，w5 的是"主人直录/被反复确认过"，
      // w1 的是"随口一句、可能不准"。它据此决定要不要直接采信。
      weight: weightOr(weight),
      topic: sec.topic || '',
      excerpt: excerptAround(sec.text, qTokens, snippetChars)
    }))
  };
}

/**
 * 取片段：优先取**包含查询词**的那一段，而不是永远取开头。
 * 永远给开头的话，长文里真正相关的部分根本看不到。
 */
function excerptAround(text, qTokens, maxChars) {
  const body = String(text ?? '');
  if (body.length <= maxChars) return body;

  // 中文按二元组定位：找到第一个查询词出现的位置
  let best = -1;
  for (const t of qTokens) {
    const i = body.toLowerCase().indexOf(t);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  if (best < 0) return `${body.slice(0, maxChars)}…`;
  const start = Math.max(0, best - Math.floor(maxChars * 0.3));
  const piece = body.slice(start, start + maxChars);
  return `${start > 0 ? '…' : ''}${piece}${start + maxChars < body.length ? '…' : ''}`;
}

/** 读某个分段的全文（按 kb_search 返回的 ref）。 */
export function readSection(ref) {
  const target = String(ref ?? '').trim();
  if (!target) return { ok: false, error: '需要 ref（knowledge-base__kb_search 结果里的「出处」那一列）' };
  let sec = state.sections.find((x) => x.id === target);
  // 容错：允许只传 "文件名#序号"，也允许传文件路径
  if (!sec) sec = state.sections.find((x) => x.id.toLowerCase() === target.toLowerCase());
  if (!sec) {
    const byDoc = state.sections.filter((x) => x.doc === target || x.docTitle === target);
    if (byDoc.length) {
      return {
        ok: true,
        multi: true,
        doc: target,
        sections: byDoc.map((x) => ({ ref: x.id, heading: x.heading, chars: x.text.length, weight: weightOr(x.weight) })),
        note: '这个文件里有多个小节，请用具体的 ref 再读一次。'
      };
    }
    return { ok: false, error: `没有找到 ${target}（可能文件刚被改过，先用 knowledge-base__kb_search 重新查一次）` };
  }
  pendingReads.push({ ref: sec.id, at: Date.now() });
  if (pendingReads.length > 50) pendingReads = pendingReads.slice(-50);
  return {
    ok: true,
    ref: sec.id,
    doc: sec.doc,
    heading: sec.heading,
    source: sec.source,
    weight: weightOr(sec.weight),
    topic: sec.topic || '',
    chars: sec.text.length,
    text: sec.text
  };
}

// ───────────────────────────── 写入（搜到就存回来）─────────────────────────────

/** 文件名净化：去掉 Windows 非法字符，保留中文。 */
function safeFileName(title) {
  const s = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (s || '未命名').slice(0, 60);
}

/** learned/ 目录下所有文本文件（绝对路径）。 */
function learnedFiles() {
  try {
    return fs.readdirSync(LEARNED_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase()))
      .map((e) => path.join(LEARNED_DIR, e.name));
  } catch {
    return [];
  }
}

/** 文件名去掉扩展名后归一化出来的 topic（读文件失败/无 front-matter 时的兜底口径）。 */
function topicOfFile(abs) {
  return topicOf(path.basename(abs).replace(/\.(txt|md|markdown)$/i, ''));
}

/**
 * 读一个 learned 文件并解出「topic / front-matter / 正文」。
 * 解析失败一律降级成"无 front-matter"，绝不抛错。
 */
function inspectLearnedFile(abs) {
  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const fm = parseFrontMatter(raw);
    if (fm.ok) {
      return {
        abs,
        raw,
        hasFm: true,
        meta: fm.meta,
        body: fm.body,
        topic: str(fm.meta.topic) ? topicOf(fm.meta.topic) : topicOfFile(abs)
      };
    }
    return { abs, raw, hasFm: false, meta: null, body: raw, topic: topicOfFile(abs) };
  } catch {
    return null;
  }
}

/**
 * 按 topic 找已存在的 learned 文件。**同 topic = 同一个文件**。
 *
 * 快路径先按文件名比对（不读内容）—— 因为文件名就是 name、topic 也由 name 归一化
 * 而来，两者天然一致，99% 的合并都在这一步命中。只有文件被用户改过名 / 手工写了
 * 不一致的 `topic:` 时，才退到"逐个读 front-matter"的慢路径。
 *
 * @param {string} topicKey 归一化后的 topic
 * @param {string} preferName 期望的文件名（同 topic 有多个文件时优先选它）
 */
function findLearnedByTopic(topicKey, preferName = '') {
  const files = learnedFiles();
  if (!files.length) return null;

  // ① 快路径：文件名归一化后就是 topic
  const sameNamed = files.filter((abs) => topicOfFile(abs) === topicKey);
  if (sameNamed.length) {
    if (preferName) {
      const exact = sameNamed.find((abs) => path.basename(abs) === `${preferName}.md`);
      if (exact) return inspectLearnedFile(exact);
      const loose = sameNamed.find((abs) => path.basename(abs).replace(/\.(md|txt|markdown)$/i, '') === preferName);
      if (loose) return inspectLearnedFile(loose);
    }
    // 多个同 topic：取最近改过的那个（最可能是"当前正在维护"的那份）
    sameNamed.sort((a, b) => mtimeOf(b) - mtimeOf(a));
    return inspectLearnedFile(sameNamed[0]);
  }

  // ② 慢路径：读 front-matter 里显式写的 topic
  const withFm = files.filter((abs) => {
    try {
      const head = fs.readFileSync(abs, 'utf8');
      return /^\uFEFF?[ \t]*---/.test(head);
    } catch { return false; }
  });
  for (const abs of withFm) {
    const info = inspectLearnedFile(abs);
    if (info && info.topic === topicKey) return info;
  }
  return null;
}

function mtimeOf(abs) {
  try { return fs.statSync(abs).mtimeMs; } catch { return 0; }
}

/** 原子写：临时文件 + rename（沿用既有写法，避免半新半旧的文件）。 */
function writeFileAtomic(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

/** 写盘后同步重建索引（理由见 remember 里的长注释）。 */
function rebuildAfterWrite(reason) {
  if (state.watchTimer) { clearTimeout(state.watchTimer); state.watchTimer = null; }
  return buildIndex({ reason });
}

/**
 * 记住一条知识：写进 learned/ 子目录的一个 md 文件。
 *
 * 放 learned/ 而不是知识库根目录，是为了让你一眼分得清
 * 「哪些是我放的」和「哪些是它自己记的」—— 后者可以放心批量删。
 *
 * ── 三种写入模式（mode）──────────────────────────────────────────────────
 *   `append`（默认）：同一个文件名就**追加小节**。不传 topic/weight 时，本函数
 *     的行为与 v1.0 **逐字节一致**（老调用方无需任何改动）。
 *   `upsert`：按 topic 找到已有文件 → **替换该文件正文**（保留 created，
 *     更新 updated/weight/tags）；找不到才新建。这是"同一件事反复记要合并到
 *     一处"的实现：同主题不再一题一文件。
 *   `replace`：必须给 topic 或 name，整篇正文替换，front-matter 里
 *     weight/tags/created 保留（除非显式覆盖）。文件不存在则报错，不新建。
 *
 * @param {Object} opts
 * @param {string} [opts.title] 主题名（成为文件名与 h1）；旧调用方都传这个
 * @param {string} [opts.name] title 的别名（与设计文档里的写法对齐，二者取其一）
 * @param {string} opts.content 正文
 * @param {string} [opts.source] 来源
 * @param {string|string[]} [opts.tags] 标签（逗号分隔或多值数组）
 * @param {string} [opts.topic] 分组合并用的键；缺省时由 name 归一化而来
 * @param {number|null} [opts.weight] 重要等级 1..5，缺省 3；越界夹紧、非数字忽略
 * @param {'append'|'upsert'|'replace'} [opts.mode] 写入模式，默认 append
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
export function remember({ title, name, content, source = '', tags = '', topic = '', weight = null, mode = 'append' } = {}) {
  const s = settings();
  if (!s.allowWrite) {
    return { ok: false, error: ERR_WRITE_OFF };
  }
  // title 是历史字段名（learning-loop 与 kb_remember 都传它）；
  // name 是元数据层设计文档里的写法。两个都收，避免改一个词就静默失效。
  const rawName = str(title) || str(name);
  if (!rawName) return { ok: false, error: '缺少 title（这条知识的主题名）' };
  const nm = safeFileName(rawName);
  const body = String(content ?? '').trim();
  if (!body) return { ok: false, error: '内容为空' };
  if (body.length > s.learnedMaxChars) {
    return {
      ok: false,
      error: `内容太长（${body.length} 字，上限 ${s.learnedMaxChars} 字）。请摘出要点再记，不要把整篇搜索结果搬进来。`
    };
  }

  const md = ['append', 'upsert', 'replace'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase()
    : 'append';
  const explicitTopic = str(topic);
  const explicitWeight = weightOf(weight);          // 非数字 → null（= 忽略）
  const tagText = tagsOf(tags);

  // ── 完全向后兼容的老路径 ────────────────────────────────────────────────
  // 条件：append 模式 + 没给 topic + 没给 weight。
  // 这就是改造前唯一的调用形态，所以这里**一个字都不改** —— 回归测试比的是
  // 同一份输入产出的文件 sha256，任何"顺手优化"都会让它对不上。
  const legacy = md === 'append' && !explicitTopic && explicitWeight === null;
  if (legacy) return rememberLegacy({ name: nm, body, source, tags: tagText, s });

  return rememberWithMeta({
    nm,
    body,
    source,
    tags: tagText,
    md,
    topicKey: explicitTopic ? topicOf(explicitTopic) : topicOf(nm),
    explicitWeight,
    s
  });
}

/**
 * v1.0 的写入实现，原样保留（append 模式且不带元数据时走这里）。
 * 动这段之前先看回归测试：mode 缺省时必须与改造前**逐字节一致**。
 */
function rememberLegacy({ name, body, source, tags, s }) {
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
    const file = path.join(LEARNED_DIR, `${name}.md`);
    const exists = fs.existsSync(file);
    const now = new Date();
    const stamp = stampMinute(now);

    // 内容里已经有标题就用它当小节标题，否则用 name。
    // ⚠️ 这里必须避免"标题出现两次"：新文件本来就会写一行 `# 标题`，
    //   如果再无条件加一行同名的 `## 标题`，切段后出处会拼成
    //   「HTTP 404 是什么 › HTTP 404 是什么 › HTTP 404 是什么」这种复读机，
    //   既难看又白占 token。
    const bodyLines = body.split('\n');
    const firstMatch = bodyLines[0]?.match(/^\s*#{1,6}\s+(.*)$/);
    const bodyHeading = firstMatch ? firstMatch[1].trim() : '';
    const bodyRest = firstMatch ? bodyLines.slice(1).join('\n').trim() : body;
    // 追加的小节标题：内容自带的标题优先，否则用日期。
    // ⚠️ 不要退回用 name —— 那就和文件标题（h1）同名，一个文件里几条记录会
    //   全都显示成「退款政策 › 退款政策」，既分不清是哪条，看着也像复读。
    //   日期至少能区分"哪次记的"，和这种"按时间累积的笔记"文件形态也相符。
    const dayStamp = stampDay(now);
    const sectionTitle = bodyHeading || dayStamp;
    // 新文件本来就写了 `# name` 这一行，再补 `## name` 就是同一个标题出现两次；
    // 追加进已有文件时才需要一个小节标题把新内容分出来。
    const needHeading = exists;

    const block = [
      '',
      needHeading ? `## ${sectionTitle}` : '',
      bodyRest,
      source ? `\n> 来源：${clip(source, 300)}` : '',
      tags ? `> 标签：${clip(tags, 120)}` : '',
      `> 记于 ${stamp}（机器人自动记录，可直接编辑或删除）`
    ].filter(Boolean).join('\n');

    let next;
    if (exists) {
      const old = fs.readFileSync(file, 'utf8');
      // 防重复：同样内容已经在里面就不再加
      if (old.includes(body.slice(0, Math.min(80, body.length)))) {
        return {
          ok: true, file: relOf(file), appended: false, mode: 'append',
          topic: topicOfFile(file), weight: WEIGHT_DEFAULT,
          note: '这段内容之前已经记过了，没有重复添加。'
        };
      }
      next = `${old.trimEnd()}\n${block}\n`;
    } else {
      next = `# ${name}\n\n${HEADER_COMMENT}\n${block}\n`;
    }

    writeFileAtomic(file, next);
    pruneLearned(s.learnedMaxFiles);

    // 同步重建索引，让这条**立刻**可检索。
    // ⚠️ 这里不能用 scheduleRebuild()：它走的是被 unref 的延迟定时器，
    //   平时没问题，但进程要退出时（用户正好在这几百毫秒内关掉 QQ Agent）
    //   定时器会被直接丢弃 —— 文件已经落盘、索引却没更新，表现是
    //   「明明记了却查不到」，而且下次启动才自愈。同步重建只要几毫秒。
    const rebuilt = rebuildAfterWrite(`remember:${name}`);

    const after = fs.statSync(file);
    log(`已记住「${name}」（${body.length} 字）→ ${relOf(file)}`);
    return {
      ok: true,
      file: relOf(file),
      appended: exists,
      chars: body.length,
      bytes: after.size,
      indexed: rebuilt.ok ? rebuilt.docs : null,
      mode: 'append',
      topic: topicOfFile(file),
      weight: WEIGHT_DEFAULT,
      note: '已存入本地知识库，之后遇到相关话题会直接命中，不用再联网搜。'
    };
  } catch (error) {
    const msg = error?.message ?? String(error);
    warn(`写入知识库失败：${msg}`);
    return { ok: false, error: `写入失败：${msg}` };
  }
}

/**
 * 带元数据的写入：新建 / upsert 替换 / replace 覆盖 / append（带 front-matter）。
 */
function rememberWithMeta({ nm, body, source, tags, md, topicKey, explicitWeight, s }) {
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
    const now = new Date();
    const stamp = stampNow(now);          // created / updated 用秒级，便于看出"何时更新过"
    const minuteStamp = stampMinute(now); // 「> 记于」沿用分钟级，与老文件形态一致

    // 内容自带一级标题 → 用它当小节标题，并从正文里剥掉（避免标题出现两次）
    const bodyLines = body.split('\n');
    const firstMatch = bodyLines[0]?.match(/^\s*#{1,6}\s+(.*)$/);
    const bodyHeading = firstMatch ? firstMatch[1].trim() : '';
    const bodyRest = firstMatch ? bodyLines.slice(1).join('\n').trim() : body;

    // ① 找目标文件
    let existing = null;
    if (md === 'upsert' || md === 'replace') {
      existing = findLearnedByTopic(topicKey, nm);
    }
    if (md === 'replace' && !existing) {
      return {
        ok: false,
        error: `没有找到 topic 为「${topicKey}」的记录。replace 只改写已存在的条目；要新建请用 mode='upsert'。`
      };
    }
    let file;
    if (existing) {
      file = existing.abs;
    } else {
      file = path.join(LEARNED_DIR, `${nm}.md`);
      // upsert 的兜底：topic 没命中但同名文件在（用户手工改过 front-matter 的情形）
      if (fs.existsSync(file)) existing = inspectLearnedFile(file);
    }

    const provenance = [
      source ? `> 来源：${clip(source, 300)}` : '',
      tags ? `> 标签：${clip(tags, 120)}` : '',
      `> 记于 ${minuteStamp}（机器人自动记录，可直接编辑或删除）`
    ].filter(Boolean).join('\n');

    const oldMeta = existing?.hasFm ? existing.meta : null;
    // created 一旦写过就永不改；updated 每次写都刷新
    const created = str(oldMeta?.created) || stamp;
    // weight：显式给了就用显式的（已夹紧），否则沿用文件里原有的，再否则中性 3
    // ⚠️ 用 `let`：append 降权时会被改回旧值（见下面的"只升不降"闸）。
    let weight = explicitWeight === null
      ? weightOr(oldMeta?.weight, WEIGHT_DEFAULT)
      : explicitWeight;
    // tags：显式给了就覆盖，否则沿用原来的
    const tagsOut = tags || str(oldMeta?.tags);

    // ── 权重只升不降（全模式）硬闸（2026-10-22，R5.1）────────────────────
    // 不变量：**低权重的东西任何时候都不许把高权重的东西降档**。分两种处置：
    //
    //   · upsert / replace（会替换正文）→ 新 < 旧：**整条拒绝覆盖**，一个字都不动。
    //     这是"机器不许把它猜的内容盖在人说过的话上"那道墙。
    //   · append（正文只是往后追加）→ 新 < 旧：**正文照常追加，但权重不下调**，
    //     取 max(旧, 新) = 旧，返回 `weightKept:true` + `guard:'weight-kept'`。
    //     为什么 append 也要管：只管 upsert 会留下一条旁路 ——
    //       ① append 传低 weight → 正文虽在，但 front-matter 的 weight 被改小；
    //       ② 那条记录降档之后，下一次同 weight 的 upsert 就成了"同权重"被放行
    //          → 人类正文被顶掉。也就是说闸能被"先 append 降权、再 upsert 覆盖"绕过。
    //     修法只改**权重**这一件事，append 的正文语义一个字没动。
    //
    // weight 是**写在文件 front-matter 里的元数据**，不是任何东西算出来的分数：
    // 人写的（直录 4 / 共识 3）永远 ≥ 机器提炼的 2。把不变量放在写入层，
    // "机器不覆盖人"就是**结构性保证**，与 idf / 召回 / minScore / 调用方查没查，全都无关。
    // 这也是唯一能闭环的地方：检索可以合法地"看不见"（正文不足 8 字压根不进索引、
    // 分词把查询词全过滤掉等），读路径的保护做不到健全。
    //
    // 比较用的是"**这次请求显式要求**的权重"，缺省按 3 ——
    // 刻意**不用**上面那个 `weight`（它在缺省时会沿用旧值），否则"来 3 存 4"会变成
    // "来 4 存 4"而悄悄放过。
    let weightKept = false;
    if (existing) {
      const oldWeight = existing.hasFm ? weightOr(existing.meta?.weight) : WEIGHT_DEFAULT;
      const newWeight = explicitWeight === null ? WEIGHT_DEFAULT : explicitWeight;
      if (newWeight < oldWeight) {
        if (md === 'upsert' || md === 'replace') {
          log(`[kb] 拒绝降权覆盖：${relOf(existing.abs)}（来 ${newWeight} < 存 ${oldWeight}）`);
          return {
            ok: true,
            file: relOf(existing.abs),
            appended: false,
            replaced: false,
            guard: 'lower-weight',
            weight: oldWeight,
            mode: md,
            topic: existing.topic || topicKey,
            note: '已有更高权重的条目，保留原样'
          };
        }
        // append：正文照加，权重不下调
        weightKept = true;
        weight = oldWeight;
        log(`[kb] append 不降权：${relOf(existing.abs)}（来 ${newWeight} < 存 ${oldWeight}，权重保持 ${oldWeight}）`);
      }
    }

    const meta = {
      ...(oldMeta || {}),
      topic: topicKey,
      weight,
      tags: tagsOut,
      created,
      updated: stamp
    };

    // ── 权重不降级硬闸（2026-10-22）──────────────────────────────────────
    // 说明：判定逻辑已经上移到 `meta` 组装**之前**（那段"权重只升不降（全模式）硬闸"），
    // 因为 append 的分支也要用同一个结论（正文照加、权重不下调）。
    // 这里保持原来的位置不动，只留一句指引，避免有人以为闸被删了。

    let next;
    let replaced = false;

    if (md === 'append' && existing) {
      // append + 元数据：保留旧正文，追加一个小节（与老行为同形，只是多维护 front-matter）
      const old = existing.raw;
      if (old.includes(body.slice(0, Math.min(80, body.length)))) {
        return {
          ok: true, file: relOf(existing.abs), appended: false, mode: 'append',
          topic: existing.topic || topicKey, weight, weightKept,
          ...(weightKept ? { guard: 'weight-kept' } : {}),
          note: '这段内容之前已经记过了，没有重复添加。'
        };
      }
      const oldBody = existing.hasFm ? existing.body : old;
      const sectionTitle = bodyHeading || stampDay(now);
      const block = ['', `## ${sectionTitle}`, bodyRest, provenance].filter(Boolean).join('\n');
      next = `${serializeFrontMatter(meta)}\n${oldBody.trimEnd()}\n${block}\n`;
    } else {
      // 新建 / upsert / replace：整篇正文就是这一条
      // ⚠️ 这里**不加 `## 小节`** —— 目的就是"替换"而不是"再攒一段"。
      const head = [
        `# ${nm}`,
        '',
        HEADER_COMMENT,
        bodyRest,
        '',
        provenance
      ].join('\n');
      next = `${serializeFrontMatter(meta)}\n${head.trimEnd()}\n`;
      replaced = Boolean(existing);
    }

    writeFileAtomic(file, next);
    pruneLearned(s.learnedMaxFiles);
    const rebuilt = rebuildAfterWrite(`remember:${nm}:${md}`);

    const after = fs.statSync(file);
    log(`已${replaced ? '更新' : '记住'}「${nm}」（${body.length} 字，topic=${topicKey}，w${weight}）→ ${relOf(file)}`);
    return {
      ok: true,
      file: relOf(file),
      appended: Boolean(existing) && !replaced,
      replaced,
      chars: body.length,
      bytes: after.size,
      indexed: rebuilt.ok ? rebuilt.docs : null,
      mode: md,
      topic: topicKey,
      weight,
      // append 降权时前端拿得到"权重被保住了"这个事实，不必解析日志
      weightKept,
      ...(weightKept ? { guard: 'weight-kept' } : {}),
      created: meta.created,
      updated: meta.updated,
      note: weightKept
        ? `已追加到同主题条目（${relOf(file)}）；来稿权重低于原有，**权重保持原样**未下调。`
        : replaced
          ? `已合并到同主题的旧条目（${relOf(file)}），没有新开文件。`
          : '已存入本地知识库，之后遇到相关话题会直接命中，不用再联网搜。'
    };
  } catch (error) {
    const msg = error?.message ?? String(error);
    warn(`写入知识库失败：${msg}`);
    return { ok: false, error: `写入失败：${msg}` };
  }
}

// ───────────────────────────── 改写（kb_update）─────────────────────────────

/**
 * 把 out 里的字符位置映射回原文位置。
 *
 * 索引时把 HTML 注释整体换成了一个空格（`replace(/<!--[\s\S]*?-->/g, ' ')`），
 * 于是"索引里的第 i 个字符"和"文件里的第 j 个字符"不再一一对应。
 * kb_update 要按索引里的节号改写文件，就必须把这层映射补回来 —— 这里用一次
 * 扫描建出 stripped→raw 的下标表，注释整体映射到它自己的起始位置。
 */
function commentStripWithMap(raw) {
  const src = String(raw ?? '');
  const out = [];
  const map = [];
  const re = /<!--[\s\S]*?-->/g;
  let last = 0;
  let m = re.exec(src);
  while (m) {
    for (let i = last; i < m.index; i += 1) { out.push(src[i]); map.push(i); }
    out.push(' ');
    map.push(m.index);
    last = m.index + m[0].length;
    m = re.exec(src);
  }
  for (let i = last; i < src.length; i += 1) { out.push(src[i]); map.push(i); }
  map.push(src.length);   // 末尾哨兵：end 落在最后一个字符之后时也能取到
  return { text: out.join(''), map };
}

/**
 * 把正文切成"和索引里一一对应"的分段，并带上在原文里的 [start, end) 位置。
 *
 * 必须与 buildIndex 的管线严格同构（切段 → 合并纯元数据段 → 过滤过短段），
 * 否则 `#N` 会指错地方 —— 那是会改坏用户内容的错误，比报错严重得多。
 *
 * @param {string} bodyRaw front-matter 之后的正文原文
 * @param {string} fileTitle 出处标题（与索引一致，传带扩展名的文件名）
 */
export function locateSections(bodyRaw, fileTitle) {
  const { text: stripped, map } = commentStripWithMap(bodyRaw);
  const pieces = splitSections(stripped, { fileTitle });
  // ① 定位：pieces 都是 stripped 里按顺序出现的子串（切段只做了 trim）
  const located = [];
  let cursor = 0;
  for (const piece of pieces) {
    const i = stripped.indexOf(piece.text, cursor);
    if (i < 0) continue;                       // 定位不到就跳过（防御，正常不会发生）
    const start = map[i];
    const end = map[i + piece.text.length - 1] + 1;
    if (!(end > start)) continue;
    located.push({ start, end, heading: piece.heading, text: piece.text });
    cursor = i + piece.text.length;
  }
  // ② 合并纯元数据段（与 buildIndex 完全相同）
  const merged = [];
  for (const piece of located) {
    const lines = piece.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const isMetaOnly = lines.length > 0 && lines.every((l) => /^>\s*(来源|标签|记于)/.test(l));
    if (isMetaOnly && merged.length) {
      merged[merged.length - 1].end = piece.end;
      merged[merged.length - 1].text += `\n\n${piece.text}`;
      continue;
    }
    merged.push({ ...piece });
  }
  // ③ 过滤过短/纯元数据段（与 buildIndex 完全相同）
  const kept = [];
  for (const piece of merged) {
    const bodyForIndex = piece.text
      .split('\n')
      .filter((l) => !/^\s*>\s*(来源|标签|记于)/.test(l))
      .join('\n')
      .trim();
    if (!bodyForIndex || bodyForIndex.replace(/\s+/g, '').length < MIN_SECTION_CHARS) continue;
    kept.push(piece);
  }
  return kept;
}

/** 把 ref（文件名 / 文件名#N）解析成绝对路径。 */
function resolveRefFile(refText) {
  const clean = String(refText ?? '').replace(/^[./\\]+/, '').trim();
  if (!clean) return '';
  // 防目录穿越：知识库只认自己目录里的文件
  if (clean.split(/[\\/]+/).includes('..')) return '';
  const cands = [
    path.join(LEARNED_DIR, clean),
    path.join(LEARNED_DIR, `${clean}.md`),
    path.join(KB_DIR, clean),
    path.join(KB_DIR, `${clean}.md`)
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* 忽略，继续试下一个 */ }
  }
  // 最后按标题/文件名兜一圈（模型常把 .md 漏掉或写错大小写）
  const base = path.basename(clean).toLowerCase();
  const bare = base.replace(/\.(md|markdown|txt)$/i, '');
  const found = learnedFiles().find((abs) => {
    const b = path.basename(abs).toLowerCase();
    return b === base || b.replace(/\.(md|markdown|txt)$/i, '') === bare;
  });
  return found || '';
}

/**
 * 把 [start, end) 末尾那段"纯出处块"（> 来源 / > 标签 / > 记于）剥出去。
 *
 * 为什么要这一步：索引时纯元数据段会被**并回上一段**（否则检索命中里全是
 * "来源：xxx" 这种噪音），所以第 N 段的 span 天然包含了它后面的出处块。
 * 但改写正文时把出处块一起删掉是**数据损失**（那是"这条是谁记的、有多可信"
 * 的唯一凭据），所以这里把 span 的尾巴收回来，只留真正的正文。
 *
 * @returns {{start:number, end:number}} 收紧后的范围
 */
function shrinkTrailingMeta(bodyRaw, start, end) {
  const span = bodyRaw.slice(start, end);
  const m = span.match(/(?:\r?\n[ \t]*)?\r?\n(?:\s*>\s*(?:来源|标签|记于)[^\n]*(?:\r?\n|$))+\s*$/);
  if (!m || m.index <= 0) return { start, end };
  return { start, end: start + m.index };
}

/**
 * 改写知识库里已有的一条（工具 kb_update 的实现）。
 *
 * `ref` 支持 `文件名.md` 与 `文件名.md#3` 两种写法：
 *   · 带 `#N`：只替换第 N 个分段（节号与 kb_search 返回的出处一致），其余内容不动
 *     （该段末尾的「> 来源 / 标签 / 记于」出处块会保留）；
 *   · 不带 `#N`：替换整篇正文（保留 h1 标题行与末尾的「> 来源/标签/记于」出处块，
 *     这两部分是"这篇是谁记的、有多可信"的凭据，重写正文不该连带删掉）。
 *
 * 文件不存在 → `{ ok:false, error }`（不新建：改写一个不存在的条目，多半是 ref 写错了）。
 *
 * @param {{ref?:string, content?:string, weight?:number|null, tags?:string|string[]|null}} opts
 */
export function kbUpdate({ ref, content, weight = null, tags = null } = {}) {
  const s = settings();
  if (!s.allowWrite) return { ok: false, error: ERR_WRITE_OFF };

  const refText = str(ref);
  if (!refText) return { ok: false, error: '需要 ref（文件名，或 kb_search 给出的「文件名#小节号」）' };
  const newBody = String(content ?? '').trim();
  if (!newBody) return { ok: false, error: '新正文为空。要清空整条请用 kb_remember 的 replace 模式。' };
  if (newBody.length > s.learnedMaxChars) {
    return {
      ok: false,
      error: `新正文太长（${newBody.length} 字，上限 ${s.learnedMaxChars} 字）。请摘出要点再改。`
    };
  }

  const hashAt = refText.lastIndexOf('#');
  const filePart = hashAt > 0 ? refText.slice(0, hashAt) : refText;
  const secPart = hashAt > 0 ? refText.slice(hashAt + 1).trim() : '';
  const secNo = secPart ? Number.parseInt(secPart, 10) : 0;
  if (secPart && (!Number.isFinite(secNo) || secNo <= 0)) {
    return { ok: false, error: `无法识别的节号「${secPart}」，应为 1 起的整数（形如 资料.md#2）。` };
  }

  const abs = resolveRefFile(filePart);
  if (!abs) return { ok: false, error: `知识库里没有这个文件：${filePart}` };

  try {
    const raw = fs.readFileSync(abs, 'utf8');
    const fm = parseFrontMatter(raw);
    const bodyRaw = fm.ok ? fm.body : raw;
    const now = new Date();
    const stamp = stampNow(now);

    let nextBodyRaw;
    if (secNo > 0) {
      const sections = locateSections(bodyRaw, path.basename(abs));
      const target = sections[secNo - 1];
      if (!target) {
        return {
          ok: false,
          error: `「${path.basename(abs)}」只有 ${sections.length} 个可改写的分段，没有第 ${secNo} 段。`
        };
      }
      const span = shrinkTrailingMeta(bodyRaw, target.start, target.end);
      nextBodyRaw = `${bodyRaw.slice(0, span.start)}${newBody}${bodyRaw.slice(span.end)}`;
    } else {
      // 整篇替换：留下 h1 标题行与末尾出处块
      const h1 = bodyRaw.match(/^[ \t]*#\s+.*(?:\r?\n|$)/);
      const keepH1 = h1 ? h1[0].trimEnd() : `# ${path.basename(abs).replace(/\.(md|markdown|txt)$/i, '')}`;
      const rest = h1 ? bodyRaw.slice(h1[0].length) : bodyRaw;
      const lines = rest.split(/\r?\n/);
      const tail = [];
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i].trim();
        if (!l) continue;
        if (/^>\s*(来源|标签|记于)/.test(l)) { tail.unshift(lines[i]); continue; }
        break;
      }
      nextBodyRaw = tail.length
        ? `${keepH1}\n\n${newBody}\n\n${tail.join('\n')}\n`
        : `${keepH1}\n\n${newBody}\n`;
    }

    // front-matter：显式给了 weight/tags 就写；文件原本没有、这次也没给，就不硬加
    const explicitWeight = weightOf(weight);
    const tagText = tags === null || tags === undefined ? '' : tagsOf(tags);
    const wantFm = fm.ok || explicitWeight !== null || Boolean(tagText);
    const meta = {
      ...(fm.ok ? fm.meta : {}),
      topic: fm.ok && str(fm.meta.topic) ? topicOf(fm.meta.topic) : topicOfFile(abs),
      weight: explicitWeight === null ? weightOr(fm.ok ? fm.meta.weight : null, WEIGHT_DEFAULT) : explicitWeight,
      tags: tagText || str(fm.ok ? fm.meta.tags : ''),
      created: str(fm.ok ? fm.meta.created : '') || stamp,
      updated: stamp
    };
    const next = wantFm ? `${serializeFrontMatter(meta)}\n${nextBodyRaw.trimEnd()}\n` : `${nextBodyRaw.trimEnd()}\n`;

    writeFileAtomic(abs, next);
    const rebuilt = rebuildAfterWrite(`kb_update:${path.basename(abs)}`);
    const after = fs.statSync(abs);
    log(`已改写 ${relOf(abs)}${secNo > 0 ? ` 第 ${secNo} 段` : '（整篇）'}，${newBody.length} 字，w${meta.weight}`);

    return {
      ok: true,
      file: relOf(abs),
      replaced: true,
      scope: secNo > 0 ? 'section' : 'file',
      section: secNo > 0 ? secNo : null,
      weight: meta.weight,
      chars: newBody.length,
      bytes: after.size,
      indexed: rebuilt.ok ? rebuilt.docs : null,
      updated: meta.updated,
      note: secNo > 0
        ? `只改了第 ${secNo} 段，同文件其它段没动。`
        : '整篇正文已替换（标题行与出处块保留）。'
    };
  } catch (error) {
    const msg = error?.message ?? String(error);
    warn(`改写知识库失败：${msg}`);
    return { ok: false, error: `改写失败：${msg}` };
  }
}

/** learned 目录限量：超了删最旧的。 */
function pruneLearned(maxFiles) {
  try {
    const files = fs.readdirSync(LEARNED_DIR)
      .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const abs = path.join(LEARNED_DIR, f);
        return { abs, f, mtime: fs.statSync(abs).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);
    if (files.length <= maxFiles) return 0;
    const doomed = files.slice(0, files.length - maxFiles);
    for (const d of doomed) {
      try {
        fs.unlinkSync(d.abs);
        log(`learned/ 超出 ${maxFiles} 个，已删除最旧的：${d.f}`);
      } catch { /* 删不掉就算了 */ }
    }
    return doomed.length;
  } catch {
    return 0;
  }
}

// ───────────────────────────── 文件监听 ─────────────────────────────

/** 防抖重建：fs.watch 对一次复制会触发多次事件。 */
function scheduleRebuild(reason, delayMs = null) {
  const s = settings();
  const delay = delayMs === null ? s.watchDebounceMs : delayMs;
  if (state.watchTimer) clearTimeout(state.watchTimer);
  state.watchTimer = setTimeout(() => {
    state.watchTimer = null;
    try {
      buildIndex({ reason });
    } catch (error) {
      warn(`自动重建索引失败：${error?.message ?? error}`);
    }
  }, delay);
  state.watchTimer.unref?.();   // 空闲等待型定时器：不阻止进程退出
}

function startWatch() {
  stopWatch();
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
    // recursive 在 Windows 上可用（本项目就是 Windows 桌面版）
    state.watcher = fs.watch(KB_DIR, { recursive: true }, (_event, filename) => {
      const name = String(filename || '');
      // 自己写索引 / 临时文件不触发重建，否则会自己触发自己
      if (!name || name.startsWith('.') || name.endsWith('.tmp')) return;
      scheduleRebuild(`检测到变化：${name}`);
    });
    state.watcher.on?.('error', (e) => warn(`文件监听出错（知识库仍可用，只是不会自动更新）：${e?.message ?? e}`));
    log(`文件监听已启动：${KB_DIR}`);
  } catch (error) {
    // 监听失败不影响检索：只是需要重启或手动刷新才会看到新文件
    warn(`无法监听知识库目录（不影响已索引的内容，新文件需要重启才会生效）：${error?.message ?? error}`);
  }
}

function stopWatch() {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* ignore */ }
    state.watcher = null;
  }
  if (state.watchTimer) {
    clearTimeout(state.watchTimer);
    state.watchTimer = null;
  }
}

// ───────────────────────────── 注入 ─────────────────────────────

/**
 * 检索结果渲染给模型看。
 *
 * 关键：**必须把"本地没有"和"本地没在工作"区分开**。
 * 前者可以放心去联网搜；后者要说清楚是配置问题，否则模型会以为用户没放资料。
 * 还要把「用 knowledge-base__kb_read 读全文」这条路径明确写出来，不然它会拿截断片段硬编。
 */
function renderHits(res, s) {
  const L = [];
  if (!state.sections.length) {
    return `本地知识库是空的（目录：${KB_DIR}）。`
      + '\n现在请直接用 web_search 联网搜；搜到有长期价值的内容可以用 knowledge-base__kb_remember 记回本地库。'
      + '\n（这是你私下的状态：不要跟任何人说"我库里是空的""我没查到"。）';
  }
  if (res.empty || !res.query) {
    return `本地知识库有 ${state.docs.length} 个文件 / ${res.total} 段，但没有给查询词。请带上 query 再查。`;
  }
  if (!res.hits?.length) {
    return `【本地知识库】用「${clip(res.query, 60)}」没查到（全库 ${res.total} 段已检索）。`
      + '\n这一步的结论是**本地没有**，可以放心去 web_search 联网搜；'
      + '搜到有长期价值的内容，用 knowledge-base__kb_remember 记回本地库，下次就不用再搜了。\n'
      + '（注意：不要因为查不到就编，也不要跟群友说你在查知识库。）';
  }
  L.push(`【本地知识库命中 ${res.hits.length} 条／全库 ${res.total} 段】（用「${clip(res.query, 60)}」检索）`);
  for (const h of res.hits) {
    // weight 摆出来是为了让模型判断"该不该直接采信"：5 = 主人直录/反复确认过，
    // 1 = 随口一句、可能不准，遇到矛盾要以后者为准的话语权差一档。
    L.push(`· ${headingLabel(h)}　出处：${h.ref}　相关度 ${h.score}　重要度 ${h.weight}/5`);
    L.push(`  ${h.excerpt}`);
  }
  L.push(`需要完整内容就用 knowledge-base__kb_read 读对应出处（${res.hits[0].ref} 这样传），不要凭上面的截断片段猜后半句。`);
  L.push(res.matched > res.hits.length
    ? `（共命中 ${res.matched} 段，只显示了前 ${res.hits.length} 段；不够就换关键词再查。）`
    : '（以上是全部命中。）');
  L.push('这些是你自己掌握的知识（比网上泛泛的文章可信）；直接用你自己的话讲，'
    + '不要交代来路，也不要提「资料 / 文件 / 知识库 / 设定」。');
  return L.join('\n');
}

/**
 * 出处的显示形式：文件 › 小节。
 * 小节名和文件名相同时只显示一次 —— 否则会出现
 * 「HTTP 404 是什么 › HTTP 404 是什么」这种复读，纯粹是噪音。
 * 自动记录的文件 h1 就是主题名，所以这一步能消掉绝大多数重复。
 */
function headingLabel(sec) {
  const docTitle = String(sec.docTitle || '');
  const heading = String(sec.heading || '');
  // 标题路径形如「项目术语表 › 摸鱼模式」。逐段去掉与文件名同义的段，
  // 否则会渲染成「HTTP 404 是什么 › HTTP 404 是什么」。
  // 同义判定：空、等于文件名、等于去掉扩展名的文件名。
  const bare = docTitle.replace(/\.(txt|md|markdown)$/i, '');
  const same = (x) => !x || x === docTitle || x === bare;
  const parts = heading.split('›').map((x) => x.trim()).filter((x) => x && !same(x));
  if (!parts.length) return docTitle;
  return `${docTitle} › ${parts.join(' › ')}`;
}

/** 目录清单：每轮都带，所以必须极短 —— 只给文件名。 */
function buildIndexBlock(s) {
  if (!state.docs.length) return '';
  const userDocs = state.docs.filter((d) => d.source === 'user');
  const learnedDocs = state.docs.filter((d) => d.source === 'learned');
  const head = `【本地知识库：${state.docs.length} 个文件 / ${state.sections.length} 段（回答前先查这里，比联网可信）】`;
  const lines = [head];
  let used = head.length;
  let shown = 0;

  // 用户自己放的资料优先列出（那是他特意要机器人学会的东西）
  const pushLine = (line) => {
    if (used + line.length + 1 > s.indexMaxChars) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  for (const d of userDocs) {
    if (!pushLine(`· ${d.title}（${d.sections} 段）`)) break;
    shown += 1;
  }
  // 机器人自己记的只报一个总数：那些是碎片，逐条列会挤掉用户资料的位置
  if (learnedDocs.length) {
    const line = `· 另有 ${learnedDocs.length} 条自己记下的知识（learned/）`;
    if (pushLine(line)) shown += 1;
  }
  const notShown = state.docs.length - shown;
  if (notShown > 0) {
    // 这一行即使略超上限也要带上：否则模型会以为知识库只有列出来的这些
    lines.push(`（还有 ${notShown} 个文件没列出来，用 knowledge-base__kb_search 就能找到）`);
  }
  lines.push('要具体内容时调 knowledge-base__kb_search（可带 query）；本地查不到再去联网搜。');
  return lines.join('\n');
}

/** 命中块：只把真正相关的那几段正文给它。 */
function buildHitBlock(hits, s) {
  if (!hits.length) return '';
  const lines = [`【本地知识库命中 ${hits.length} 条（优先用这里的内容回答，不必再联网）】`];
  let used = lines[0].length;
  for (const h of hits) {
    const head = `· ${headingLabel(h)}｜${h.ref}`;
    const room = s.hitMaxChars - used - head.length - 10;
    if (room < 60) break;
    const body = h.excerpt.length > room ? `${h.excerpt.slice(0, room)}…` : h.excerpt;
    lines.push(head);
    lines.push(body);
    used += head.length + body.length + 2;
  }
  lines.push('这些是你自己本来就知道的东西，直接用你自己的话讲；不要交代来路，'
    + '也不要提「资料 / 文件 / 库 / 设定」这类词，更不要把问题推给别人。');
  return lines.join('\n');
}

/**
 * 把片段追加到最后一条 user 消息末尾。
 *
 * 为什么不插进 system 中间：prompt.js 明确写了系统提示的缓存前缀占 token 大头，
 * 中间插动态内容会让后面所有核心规则位移、缓存前缀归零。动态内容一律殿后。
 * （本机这份 src/prompt.js 没有 appendDynamicTail，所以自己实现，不依赖它存在。）
 */
function appendToTail(messages, text) {
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content += block; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  messages.push({ role: 'user', content: block.trim() });
  return true;
}

/** 取最后一条 user 消息的文本。 */
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ');
    }
  }
  return '';
}

// ───────────────────────────── 状态 ─────────────────────────────

export function status() {
  const s = settings();
  const bySource = { user: 0, learned: 0 };
  const byWeight = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const d of state.docs) {
    bySource[d.source] = (bySource[d.source] || 0) + 1;
    const w = weightOr(d.weight);
    byWeight[w] = (byWeight[w] || 0) + 1;
  }
  let indexBytes = 0;
  try { indexBytes = fs.statSync(INDEX_FILE).size; } catch { /* 还没有 */ }
  const recent = pendingReads.slice(-5).reverse().map((r) => {
    const sec = state.sections.find((x) => x.id === r.ref);
    return { ref: r.ref, heading: sec?.heading ?? '', doc: sec?.doc ?? '' };
  });
  return {
    ok: true,
    buildTag: BUILD_TAG,
    enabled: s.enabled,
    dir: KB_DIR,
    learnedDir: LEARNED_DIR,
    readmePath: README_FILE,
    mode: s.injectMode,
    watching: Boolean(state.watcher),
    builtAt: state.builtAt,
    builtAtText: state.builtAt ? clock(state.builtAt) : '从未',
    docs: state.docs.length,
    docsUser: bySource.user || 0,
    docsLearned: bySource.learned || 0,
    sections: state.sections.length,
    vocab: state.df.size,
    avgSectionLen: Math.round(state.avgLen),
    indexBytes,
    allowWrite: s.allowWrite,
    minScore: s.minScore,
    weightBoost: s.weightBoost,
    byWeight,
    skipped: state.skipped,
    errors: state.errors,
    recentReads: recent,
    docsList: state.docs.map((d) => ({
      rel: d.rel, title: d.title, sections: d.sections,
      kb: Math.round(d.bytes / 1024), encoding: d.encoding, source: d.source,
      topic: d.topic || '', weight: weightOr(d.weight)
    }))
  };
}

function clock(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

// ───────────────────────────── 生命周期 / 扩展点 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;

  // 目录与说明文件：只在缺失时创建，绝不覆盖用户自己改过的 README
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true });
  } catch (error) {
    warn(`创建知识库目录失败：${error?.message ?? error}`);
  }

  registerTools(api);
  // 注意：这里**不能**调用 exposePathsInSettings() —— setup 跑在"新实例注册"之前，
  // 此刻 registry 里还是旧实例（或什么都没有），改它的 manifest 会被随后的
  // register 覆盖掉。真正的注入时机见 available()。
  log(`本地知识库已就绪（${BUILD_TAG}）｜目录：${KB_DIR}`);
}

/**
 * 把知识库目录的**完整真实路径**显示到插件设置界面上。
 *
 * 需求是"一键打开目录的按钮"，但技能设置弹窗只认 boolean/number/enum/string
 * 四种控件（见 ui/app/06-settings-render.js 的 renderSkillSettingsModal），
 * 加按钮就必须改 app 自带的那个文件 —— 而它会在 QQ Agent 升级时被覆盖。
 * 所以这里改用项目**自带**的 internal 类型：它不渲染成输入框，只在弹窗底部的
 * 「以下设置不在这里改」区块里把内容显示出来。用户看到完整路径就能直接粘贴到
 * 资源管理器打开，而且一个 app 文件都不用碰、升级也不会丢。
 *
 * 为什么在运行时改写、而不是写死在 plugin.json 里：
 *   真实路径随安装位置与 QQ_AGENT_DATA_DIR 而变，写死就会显示一个不存在的路径
 *   （显示 C:\a\… 而实际在 D:\b\…，比不显示更糟）。
 *
 * 改的是**活的 manifest 对象**：settingsView() 每次都读 skill.manifest.settings，
 * 而 GET /api/skills 走的就是它，所以界面立刻拿到真实路径，不需要重启。
 */
function exposePathsInSettings() {
  try {
    const manifest = skillManager.registry.get(ENTRY_ID)?.manifest;
    if (!manifest) {
      warn('拿不到本条目已注册的清单，目录路径这次没能显示在设置界面里（不影响功能）');
      return false;
    }
    if (!manifest.configSchema || typeof manifest.configSchema !== 'object') manifest.configSchema = {};
    if (!manifest.settings || typeof manifest.settings !== 'object') manifest.settings = {};
    // ⚠️ 两处都必须写，少一个界面就是空白：
    //   configSchema → 决定"渲染成什么控件、标签和说明写什么"
    //   settings     → 提供**值**（settingsView 是 getSkillConfig(id, manifest.settings)，
    //                  弹窗里取的是 values[key] ?? d.default ?? ''）
    //   只写 configSchema 时字段确实出现在"不在这里改"区块里，但值是空的 ——
    //   实测踩过：schema 里有 knowledgeDir，settingsView 里却是 undefined。
    manifest.configSchema.knowledgeDir = {
      type: 'internal',
      label: '知识库目录（所有资料放这里）',
      description: '把 txt / md 文件复制到这个文件夹，机器人就会自动学会，不用重启。'
        + '在资源管理器的地址栏粘贴下面这行就能打开。'
    };
    manifest.configSchema.learnedDir = {
      type: 'internal',
      label: '自动记录目录（learned）',
      description: '机器人从网上搜到并记下来的知识放这里，可以放心批量删 —— 删了就忘了，下次搜到会重新记。'
    };
    // 值：真实路径（随安装位置/QQ_AGENT_DATA_DIR 变化，所以运行时取，不写死在清单里）
    manifest.settings.knowledgeDir = KB_DIR;
    manifest.settings.learnedDir = LEARNED_DIR;
    return true;
  } catch (error) {
    warn(`显示目录路径失败（不影响功能）：${error?.message ?? error}`);
    return false;
  }
}

/**
 * ── 为什么工具注册在插件里（这个决定要留个说明）────────────────────────────
 * 按项目的目录语义（src/skills/manifest.js 的 DIR_KIND），"用不用由模型判断"
 * 的工具本该放 skills/。这里没有另开一个技能，原因是一个**实测到的硬约束**：
 *
 *   SkillRegistry.register() 对重复 id 是直接覆盖，而 loadPlugins 是
 *   "先扫 skills/ 再扫 plugins/"。所以技能和插件一旦同名，后加载的插件会把
 *   技能整个顶掉，并连带注销它注册的所有工具 —— 现场表现是
 *   「插件页有它、但它提供的工具一个都不存在」，属于最难查的那类静默失效。
 *   （本机实测：两个目录都用 knowledge-base 时，加载结果只剩插件那一条，
 *     kb_* 工具全部消失，且加载器还额外报了一个失败条目。）
 *
 * 而两者都不改名也是有正当理由的：src/config.js 的 LEGACY_SKILL_MIGRATIONS 里
 *   { from: ['tools','knowledgeEnabled'], skill: 'knowledge-base' }
 * 指明了这个功能就叫 knowledge-base（注释写着"知识库技能尚未移植，先留位"）。
 * 名字被核心配置锚定了，所以这里合并成一个条目，让那个坑位真正被填上。
 *
 * 语义上这仍然是合规的：插件提供 providers（knowledge.search / knowledge.write）
 * + hooks（必然执行的索引与注入），工具只是额外附带的接口，不是它存在的唯一理由
 * —— 不会触发 lintKindPlacement 的"提供了插件却没有任何代码会调用它"告警。
 */
function registerTools(api) {
  if (typeof api?.registerTool !== 'function') return;
  const s = () => settings();

  api.registerTool({
    id: 'knowledge-base__kb_search',
    name: '查本地知识库',
        description: '检索你自己的本地知识库（你攒下的**外部知识**：名词、工具、概念、资料；比联网搜可信）。'
      + '★ 只用于**外部世界**的问题；涉及本群/群友/以前聊过的事 → 用 memory-recall__memory_search。'
      + '结果带「重要度 1~5」：5 可直接采信，1~2 可能有偏差、别当准。'
      + '返回的是**截断片段**，要全文用 kb_read（传 ref），别凭片段猜后半句。'
      + '查不到就转联网搜（同样只限外部事实），别编、也别跟人说「本地没有」。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的内容，用关键词或一句话都行。留空则只返回库的概况，不检索。' },
        limit: { type: 'number', description: '最多返回几条，默认 5。' }
      }
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const cfgNow = s();
      if (!cfgNow.enabled) {
        return { content: '本地知识库处于**关闭**状态（插件设置里关了），现在查不到任何本地资料。'
          + '请直接用 web_search 联网搜；不要跟别人提这件事。' };
      }
      const query = str(raw.query);
      if (!query) {
        const st = status();
        if (!st.docs) {
          return { content: `本地知识库是空的（目录：${st.dir}）。`
            + '现在请直接联网搜。不要跟别人说库是空的。' };
        }
        return { content: `本地知识库现有 ${st.docs} 个文件 / ${st.sections} 段：\n`
          + st.docsList.slice(0, 30).map((d) => `· ${d.title}（${d.sections} 段，${d.kb}KB）`).join('\n')
          + '\n要内容就再用 knowledge-base__kb_search 带上 query。' };
      }
      const limit = Math.max(1, Math.min(cfgNow.maxLimit, Math.round(num(raw.limit, cfgNow.defaultLimit))));
      const res = search(query, { limit, snippetChars: cfgNow.snippetChars });
      return { content: renderHits(res, cfgNow) };
    }
  });

  api.registerTool({
    id: 'knowledge-base__kb_read',
    name: '读知识库某一段',
    description: '按 ref 读取本地知识库里**某一段的完整正文**。knowledge-base__kb_search 给的是截断片段（还带省略号），'
      + '当你要引用细节、数字、步骤、完整定义时，用这个读全文，不要靠截断的片段拼凑。'
      + 'ref 就是 knowledge-base__kb_search 结果里每条后面那个「出处」（形如 文件名.md#3）。'
      + '如果传的是文件名而不是 ref，会返回那个文件的所有小节列表，让你挑一个再读。',
    category: 'knowledge',
    icon: '📖',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'knowledge-base__kb_search 返回的「出处」，形如 资料.md#3；也可以直接传文件名。' }
      },
      required: ['ref']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const ref = str(raw.ref);
      if (!ref) return fail('需要 ref（knowledge-base__kb_search 结果里的「出处」）');
      const r = readSection(ref);
      if (!r.ok) return fail(r.error);
      if (r.multi) {
        return { content: `「${r.doc}」里有 ${r.sections.length} 个小节：\n`
          + r.sections.map((x) => `· ${x.ref}　${x.heading}（${x.chars} 字，重要度 ${x.weight}）`).join('\n')
          + '\n挑一个把它的 ref 传进来就能读全文。' };
      }
      return { content: `【${headingLabel(r)}】（${r.chars} 字，重要度 ${r.weight}/5）\n\n${r.text}` };
    }
  });

  api.registerTool({
    id: 'knowledge-base__kb_remember',
    name: '记进本地知识库',
    description: '把有长期价值的内容记进本地知识库，下次直接检索、不必重新联网搜。'
      + '该记：概念定义、事件来龙去脉、工具用法、群规（以后还会用到的）。'
      + '不该记：天气、股价、新闻进展、一次性闲聊（过几天就是错的）。'
      + '同主题再记请复用同一 topic 且 mode=upsert；内容摘成要点、写上来源。',
    category: 'knowledge',
    icon: '📝',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '主题名，会成为文件名与小节标题。' },
        content: { type: 'string', description: '要记的内容，摘成要点，别整篇搬运。' },
        source: { type: 'string', description: '来源（网址或结果标题），便于事后核对。' },
        tags: { type: 'string', description: '可选，逗号分隔。' },
        topic: {
          type: 'string',
          description: '可选。同一 topic = 同一篇（会合并）；不给则由 title 归一化。'
        },
        weight: {
          type: 'number',
          description: '可选，重要度 1~5（默认 3），影响检索排序。'
        },
        mode: {
          type: 'string',
          enum: ['append', 'upsert', 'replace'],
          description: '默认 append（追加一段）；upsert = 按 topic 合并替换正文（推荐）；replace = 整篇覆盖（须已存在）。'
        }
      },
      required: ['title', 'content']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const cfgNow = s();
      if (!cfgNow.enabled) return fail('本地知识库处于关闭状态，无法写入。这次就不记了。');
      if (!cfgNow.allowWrite) {
        return fail('「允许机器人自己记东西」是关闭状态。可以把这条内容直接说给用户，或让他在插件设置里打开该开关。');
      }
      const title = str(raw.title);
      const content = String(raw.content ?? '').trim();
      const source = str(raw.source);
      if (!title) return fail('需要 title（这条知识的主题名）');
      if (!content) return fail('需要 content（要记住的内容）');
      if (cfgNow.requireSource && !source) {
        return fail('这条记录没有写来源。请补上 source（网址或搜索结果标题）再记 —— '
          + '没有来源的自动记录很容易把模型自己编的内容也存进去。');
      }
      const r = remember({
        title,
        content,
        source,
        tags: str(raw.tags),
        topic: str(raw.topic),
        weight: raw.weight === undefined || raw.weight === null || raw.weight === '' ? null : raw.weight,
        mode: str(raw.mode, 'append')
      });
      if (!r.ok) return fail(r.error);
      const how = r.replaced ? `，已合并进原有记录（重要度 ${r.weight}/5）`
        : (r.appended ? `，追加到已有文件（重要度 ${r.weight}/5）` : `（重要度 ${r.weight}/5）`);
      return {
        content: `已记入本地知识库：${r.file}（${r.chars} 字${how}）。`
          + `${r.note || ''}不要跟群友汇报这个动作，继续正常回话就行。`
      };
    }
  });

  api.registerTool({
    id: 'knowledge-base__kb_update',
    name: '改写知识库里的一条',
    description: '改写已写进本地知识库的内容（改错、改重要度、改标签）。'
      + 'ref 取 kb_search 结果里的「出处」（形如 资料.md#3）；带 #N 只改该段，不带则整篇替换正文'
      + '（标题与来源块保留）。新建请用 kb_remember。',
    category: 'knowledge',
    icon: '✏️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'kb_search 的「出处」，形如 资料.md#3；也可只传文件名。' },
        content: { type: 'string', description: '新正文（替换该段/整篇），摘成要点。' },
        weight: { type: 'number', description: '可选，新重要度 1~5；不传保持原值。' },
        tags: { type: 'string', description: '可选，新标签（逗号分隔）；不传保持原值。' }
      },
      required: ['ref', 'content']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const cfgNow = s();
      if (!cfgNow.enabled) return fail('本地知识库处于关闭状态，无法改写。');
      if (!cfgNow.allowWrite) {
        return fail('「允许机器人自己记东西」是关闭状态，无法改写。可以让主人自己在插件设置里打开该开关，或直接编辑文件。');
      }
      const ref = str(raw.ref);
      const content = String(raw.content ?? '').trim();
      if (!ref) return fail('需要 ref（文件名，或 kb_search 给出的「文件名#小节号」）');
      if (!content) return fail('需要 content（新的正文）');
      const r = kbUpdate({
        ref,
        content,
        weight: raw.weight === undefined || raw.weight === null || raw.weight === '' ? null : raw.weight,
        tags: raw.tags === undefined || raw.tags === null ? null : str(raw.tags)
      });
      if (!r.ok) return fail(r.error);
      return {
        content: `已改写 ${r.file}${r.scope === 'section' ? ` 第 ${r.section} 段` : '（整篇）'}：`
          + `${r.chars} 字，重要度 ${r.weight}/5。${r.note || ''}（不用跟群友汇报这个动作。）`
      };
    }
  });

  api.registerTool({
    id: 'knowledge-base__kb_status',
    name: '知识库状态与维护',
    description: '查看本地知识库状态：文件数/段数/目录、被跳过的文件、最近查询，以及维护动作。'
      + '问「你学到没」「知识库里有什么」「为什么查不到」时用。'
      + 'action：status（默认）/ list（列文件）/ rebuild（重扫目录，刚放新文件时用）。',
    category: 'knowledge',
    icon: '🗂️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'rebuild'], description: '要做的动作，默认 status。' }
      }
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const action = str(raw.action, 'status').toLowerCase();
      if (action === 'rebuild') {
        const r = buildIndex({ reason: 'tool' });
        if (!r.ok) return fail(`重建索引失败：${r.error}`);
        return {
          content: `已重新扫描知识库目录：${r.docs} 个文件 / ${r.sections} 段，耗时 ${r.ms}ms。`
            + `${r.skipped.length ? `\n跳过 ${r.skipped.length} 个文件：` + r.skipped.slice(0, 8).map((x) => `${x.rel}（${x.reason}）`).join('；') : ''}`
        };
      }
      const st = status();
      if (action === 'list') {
        if (!st.docsList.length) return { content: `知识库是空的。目录：${st.dir}` };
        return {
          content: `知识库共 ${st.docsList.length} 个文件：\n`
            + st.docsList.map((d) => `· ${d.rel}（${d.sections} 段，${d.kb}KB，${d.encoding}，重要度 ${d.weight}${d.source === 'learned' ? '，机器人自己记的' : ''}）`).join('\n')
        };
      }
      const L = [];
      L.push('【本地知识库 · 状态】');
      L.push(`· ${st.enabled ? '已启用' : '⚠️ 已关闭'}｜注入模式 ${st.mode}｜目录监听 ${st.watching ? '在跑' : '没在跑'}`);
      L.push(`· 目录：${st.dir}`);
      L.push(`· 内容：${st.docs} 个文件（人工录入 ${st.docsUser} + 自动记录 ${st.docsLearned}）／${st.sections} 段／词表 ${st.vocab} 个`);
      L.push(`· 索引建于 ${st.builtAtText}（${Math.round(st.indexBytes / 1024)}KB），平均每段 ${st.avgSectionLen} 词`);
      L.push(`· 写入：${st.allowWrite ? '允许（搜到会记回 learned/）' : '已禁止'}｜命中门槛 ${st.minScore}｜权重力度 ${st.weightBoost}`);
      L.push(`· 重要度分布：w1 ${st.byWeight[1] || 0}／w2 ${st.byWeight[2] || 0}／w3 ${st.byWeight[3] || 0}／w4 ${st.byWeight[4] || 0}／w5 ${st.byWeight[5] || 0}`);
      if (st.skipped.length) {
        L.push(`· ⚠️ 跳过了 ${st.skipped.length} 个文件（**这些内容机器人学不到**）：`);
        for (const x of st.skipped.slice(0, 10)) L.push(`   - ${x.rel}：${x.reason}`);
      }
      if (st.errors.length) {
        L.push(`· ⚠️ 读取出错 ${st.errors.length} 个：`);
        for (const x of st.errors.slice(0, 10)) L.push(`   - ${x.rel}：${x.reason}`);
      }
      if (st.recentReads.length) {
        L.push(`· 最近查过：${st.recentReads.map((r) => r.heading || r.ref).join('、')}`);
      }
      return { content: L.join('\n') };
    }
  });
}

export function activate() {
  const s = settings();
  if (!s.enabled) {
    state.docs = [];
    state.sections = [];
    stopWatch();
    log('本地知识库当前是关闭状态（不索引、不注入、工具会告诉模型去联网搜）');
    return;
  }
  buildIndex({ reason: 'activate' });
  startWatch();
}

export function deactivate() {
  stopWatch();
  log('已停止监听知识库目录（禁用/重载时调用，不会留下幽灵监听）');
}

/**
 * 同步返回：没有资料也算"可用"，只是查不到东西（工具会如实说明）。
 *
 * 另外顺手把目录路径注入设置界面 —— 时机是这里而不是 setup()：
 *   · setup 跑在"新实例注册"**之前**，此刻 registry 里是旧实例（热重载时）
 *     或空（首次加载），改它的 manifest 会被随后的 register 覆盖掉；
 *   · available() 是生命周期函数，由 isActive() 在 status / getPromptSections
 *     等路径上调用，那时本实例**已经注册**，改的就是界面真正读的那个对象。
 * 注入是幂等的（每次写同样的两个键），所以反复调用没有副作用。
 */
export function available() {
  exposePathsInSettings();
  return true;
}

/** 能力接口：技能通过 api.capability(...) 取用。 */
export const providers = {
  /** 检索本地知识库。 */
  'knowledge.search': (args = {}) => {
    const s = settings();
    const action = str(args.action, 'search').toLowerCase();
    if (action === 'status') return status();
    if (action === 'read') return readSection(args.ref || args.query);
    if (action === 'rebuild') return buildIndex({ reason: 'manual' });
    return search(args.query || args.q || '', {
      limit: num(args.limit, 5),
      minScore: args.minScore === undefined ? null : num(args.minScore, s.minScore),
      snippetChars: num(args.snippetChars, s.snippetChars),
      // 允许调用方显式关掉权重（例如"只按字面相关度重排"的调试场景）
      weightBoost: args.weightBoost === undefined ? null : num(args.weightBoost, s.weightBoost)
    });
  },
  /**
   * 把搜到的知识存回本地库。
   *
   * v1.1 起多接了三个**可选**参数（topic / weight / mode）：learning-loop 用
   * `{ topic, mode:'upsert', weight }` 让"同一件事"合并成一篇；老调用方什么都
   * 不传，行为和以前一样。
   */
  'knowledge.write': (args = {}) => remember({
    title: args.title,
    name: args.name,
    content: args.content,
    source: args.source,
    tags: args.tags,
    topic: args.topic,
    weight: args.weight,
    mode: args.mode
  }),
  /** 改写已有条目（新增能力，供其他插件调用）。 */
  'knowledge.update': (args = {}) => kbUpdate({
    ref: args.ref,
    content: args.content,
    weight: args.weight,
    tags: args.tags
  })
};

/**
 * 钩子：本轮对话带上知识库。
 *
 * index 模式 = 目录常驻 + 命中给详情（推荐）：目录只有十几行，命中才花大钱。
 * hit   模式 = 只给命中，最省，但模型可能想不起来用户有资料。
 * off   模式 = 什么都不给，全靠它自己调工具。
 */
export const hooks = {
  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled || s.injectMode === 'off') return;
      if (!state.sections.length) return;
      const messages = ctx.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      const text = lastUserText(messages);
      const parts = [];

      if (s.injectMode === 'index') {
        const idx = buildIndexBlock(s);
        if (idx) parts.push(idx);
      }

      if (text) {
        // ⚠️ 注入这条链**刻意不乘权重**（weightBoost: 0）：
        //   注入是"顺手塞给它的一段上下文"，它没有机会判断"这条该不该信"；
        //   把 w5 的内容顶到注入结果第一位，等于用主人的偏好去挤掉字面更贴题的
        //   资料。权重只在模型**主动** kb_search 时参与排序 —— 那时它能看见
        //   「重要度」，由它自己决定采信程度。
        const res = search(text, { limit: s.hitLimit, snippetChars: s.hitMaxChars, weightBoost: 0 });
        if (res.hits?.length) {
          const block = buildHitBlock(res.hits, s);
          if (block) parts.push(block);
        }
      }

      if (!parts.length) return;
      appendToTail(messages, parts.join('\n\n'));
    } catch (error) {
      // 注入失败绝不影响正常回话
      warn(`知识库注入失败（不影响回话）：${error?.message ?? error}`);
    }
  }
};

/** 测试/排障用导出。 */
export const __internals = {
  state, settings, KB_DIR, LEARNED_DIR, INDEX_FILE,
  decodeTextBuffer, splitSections, tokenize, search, readSection, remember,
  buildIndex, scheduleRebuild, excerptAround, safeFileName, walkFiles,
  // v1.1 元数据层
  topicOf, parseFrontMatter, serializeFrontMatter, kbUpdate, locateSections,
  findLearnedByTopic, inspectLearnedFile, commentStripWithMap, weightOf, weightOr,
  learnedFiles, WEIGHT_DEFAULT
};
