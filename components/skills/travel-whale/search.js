// 矩阵庭院 · 搜索适配层
//
// 三级链路：百度搜索 → 智能搜索生成高性能版 → Bing
//
// ── 为什么要串行 + 限速 ──────────────────────────────────────────────────
//   千帆官方默认限流 1QPS（开通后付费 3QPS）。实测并发会直接返回
//   {"code":"RATE_LIMIT_SEARCH_QPS","message":"Exceeding QPS limit for Web Search"}。
//   所以所有请求都过**同一个串行队列**，间隔 ≥ minIntervalMs（默认 1100ms，
//   比 1QPS 留 100ms 余量）。队列即使某环抛错也保持不断，否则一次失败会把
//   后续所有请求一起卡死。
//
// ── 为什么要本地记配额 ──────────────────────────────────────────────────
//   百度搜索免费 50 次/日、高性能版免费 100 次/日。默认策略是「**不自动花钱**」，
//   所以必须在本地记账：用满免费额度就**降级到下一级**，而不是让账单悄悄上涨。
//   记账落盘、跨天自动清零；**请求失败不计入**（否则一次超时就把免费额度吃掉）。
//
// ── 三级返回结构统一 ────────────────────────────────────────────────────
//   · 百度搜索   → references[]（标题/URL/摘要）—— 最符合"要候选列表"的需求
//   · 高性能版   → choices[].message.content + references[]，**优先取 references**
//   · Bing       → 复用 src/web-search.js 的 bingSearch()（页面解析、免 Key）
//   统一归一化成 [{ title, url, snippet }]，上层完全不关心走了哪一级。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { bingSearch } from '../../src/web-search.js';

const BAIDU_SEARCH_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const BAIDU_SUMMARY_URL = 'https://qianfan.baidubce.com/v2/ai_search/web_summary';

/** 高性能版的 instruction 是**必填**（官方文档），所以给一个固定值。 */
const SUMMARY_INSTRUCTION =
  '你是一个旅行资料助手。请针对用户给出的地点，客观、简洁地列出该地的知名景点与特色物产，不要编造。';

/** 默认免费额度（官方文档口径：百度搜索 1500次/月≈50/天；高性能版 100/天）。 */
const DEFAULT_FREE_QUOTA = { baidu: 50, summary: 100 };

/** 默认最小请求间隔：比官方 1QPS 留一点余量。 */
const DEFAULT_MIN_INTERVAL_MS = 1100;

const DEFAULT_TOP_K = 8;
const DEFAULT_TIMEOUT_MS = 45000;

// ── 串行队列 + 限速 ──────────────────────────────────────────────────────

let _chain = Promise.resolve();
let _lastAt = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 所有出网请求都必须走这里：全局串行 + 间隔 ≥ minIntervalMs。
 * @param {() => Promise<any>} fn
 * @param {number} minIntervalMs
 */
export function enqueue(fn, minIntervalMs = DEFAULT_MIN_INTERVAL_MS) {
  const run = _chain.then(async () => {
    const wait = Math.max(0, Number(minIntervalMs) - (Date.now() - _lastAt));
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      _lastAt = Date.now();
    }
  });
  // 队列本身必须永远 resolve，否则一次失败会毒化后续所有请求
  _chain = run.then(() => undefined, () => undefined);
  return run;
}

// ── 配额记账（落盘 / 跨天清零 / 失败不计）──────────────────────────────────

const quotaFile = () => path.join(DATA_DIR, 'skills', 'travel-whale', 'search-quota.json');

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readQuotaFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(quotaFile(), 'utf8'));
    if (raw && raw.date === today() && raw.used && typeof raw.used === 'object') return raw;
  } catch {
    /* 首次运行 / 文件损坏：都从零开始，不该因此让搜索失败 */
  }
  return { date: today(), used: {} };
}

let _quota = null;

function quota() {
  if (!_quota || _quota.date !== today()) _quota = readQuotaFile();
  return _quota;
}

function usedCount(id) {
  return Math.max(0, Number(quota().used?.[id]) || 0);
}

function writeQuota() {
  const q = quota();
  try {
    fs.mkdirSync(path.dirname(quotaFile()), { recursive: true });
    const tmp = `${quotaFile()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(q, null, 1), 'utf8');
    fs.renameSync(tmp, quotaFile());
  } catch {
    /* 记账失败不阻断搜索：宁可多花一次免费额度，也不能让功能挂掉 */
  }
}

/** 记账 +1（只在**请求成功**后调用）。 */
function bumpQuota(id) {
  const q = quota();
  q.used[id] = usedCount(id) + 1;
  writeQuota();
}

/** 给排障 / UI 用的快照。 */
export function quotaSnapshot(freeQuota = DEFAULT_FREE_QUOTA) {
  const q = quota();
  return Object.keys(DEFAULT_FREE_QUOTA).map((id) => {
    const free = Math.max(0, Number(freeQuota?.[id] ?? DEFAULT_FREE_QUOTA[id]) || 0);
    const used = usedCount(id);
    return { id, date: q.date, used, free, remain: Math.max(0, free - used) };
  });
}

/** 测试 / 运维用：手动清空今日记账。 */
export function resetQuota() {
  _quota = { date: today(), used: {} };
  writeQuota();
  return quota();
}

// ── 结果归一化 ────────────────────────────────────────────────────────────

/** 把各家五花八门的字段压成同一个形状。 */
function normalizeRef(r) {
  if (!r || typeof r !== 'object') return null;
  const url = String(r.url ?? r.link ?? r.href ?? '').trim();
  const title = String(r.title ?? r.name ?? '').trim();
  const snippet = String(r.content ?? r.snippet ?? r.summary ?? r.digest ?? '').trim();
  if (!url && !title && !snippet) return null;
  return { title: title || '（无标题）', url, snippet };
}

function normalizeList(list, limit) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const n = normalizeRef(item);
    if (!n) continue;
    const key = n.url || n.title;
    if (seen.has(key)) continue;   // 同一 URL 只留一条（搜索接口常回重复）
    seen.add(key);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

// ── 三级实现 ──────────────────────────────────────────────────────────────

/** Key 优先级：技能自有 → 全局搜索配置 → 环境变量。 */
function resolveKey(options) {
  const own = String(options?.baiduApiKey ?? '').trim();
  if (own) return own;
  const global = String(getConfig()?.webSearch?.baidu?.apiKey ?? '').trim();
  if (global) return global;
  return String(process.env.BAIDU_SEARCH_API_KEY ?? '').trim();
}

async function postJson(url, key, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5000, timeoutMs))
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON：下面按 HTTP 状态报错 */ }
  if (!res.ok) {
    const code = data?.code || data?.error_code || '';
    const msg = data?.message || data?.error_msg || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}${code ? ` [${code}]` : ''}：${msg}`);
  }
  // 千帆额度 / RPS 类错误 HTTP 仍是 200，只在 body 里给 code
  if (data?.code && Number(data.code) !== 0) {
    throw new Error(`API [${data.code}]：${data.message || data.error_msg || '未知错误'}`);
  }
  return data ?? {};
}

/** ① 百度搜索（只搜不生成，返回结构化 references）。 */
async function baiduSearchTier(query, options) {
  const key = resolveKey(options);
  if (!key) throw new Error('未配置百度千帆 API Key');
  const topK = Math.min(20, Math.max(1, Number(options.topK) || DEFAULT_TOP_K));
  const data = await enqueue(() => postJson(BAIDU_SEARCH_URL, key, {
    messages: [{ role: 'user', content: query }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: topK }]
  }, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS), options.minIntervalMs);
  const results = normalizeList(data?.references, topK);
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return results;
}

/** ② 智能搜索生成高性能版（答案 + references，一口价、不另付模型费）。 */
async function baiduSummaryTier(query, options) {
  const key = resolveKey(options);
  if (!key) throw new Error('未配置百度千帆 API Key');
  const topK = Math.min(50, Math.max(1, Number(options.topK) || DEFAULT_TOP_K));
  const data = await enqueue(() => postJson(BAIDU_SUMMARY_URL, key, {
    instruction: SUMMARY_INSTRUCTION,
    messages: [{ role: 'user', content: query }],
    stream: false,
    resource_type_filter: [{ type: 'web', top_k: topK }]
  }, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS), options.minIntervalMs);
  // 优先结构化结果；拿不到才退化成"把生成答案当成一条结果"
  let results = normalizeList(data?.references, topK);
  if (!results.length) {
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (text) results = [{ title: '智能搜索生成', url: '', snippet: text }];
  }
  if (!results.length) throw new Error('高性能版没有返回有效内容');
  return results;
}

/** ③ Bing 网页解析（免 Key，永远可用）。 */
async function bingTier(query, options) {
  const r = await enqueue(() => bingSearch(query), options.minIntervalMs);
  const results = normalizeList(r?.results, Math.max(1, Number(options.topK) || DEFAULT_TOP_K));
  if (!results.length) throw new Error('Bing 没有返回有效结果');
  return results;
}

// ── 对外主入口 ────────────────────────────────────────────────────────────

/**
 * 按 百度搜索 → 高性能版 → Bing 的顺序取一次搜索结果。
 *
 * @param {string} query
 * @param {object} [options]
 * @param {string}  [options.baiduApiKey] 技能自有 Key（空则回退全局配置 / 环境变量）
 * @param {object}  [options.freeQuota]   { baidu, summary } 每日免费额度
 * @param {boolean} [options.allowPaid]   true 时用满免费额度也继续调用（会花钱）
 * @param {number}  [options.minIntervalMs]
 * @param {number}  [options.topK]
 * @param {(msg:string)=>void} [options.log]
 * @returns {Promise<{ok:boolean, provider:string, results:Array, errors:string[]}>}
 */
export async function searchWeb(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, provider: 'none', results: [], errors: ['查询词为空'] };

  const log = typeof options.log === 'function' ? options.log : () => {};
  const freeQuota = { ...DEFAULT_FREE_QUOTA, ...(options.freeQuota || {}) };
  const allowPaid = options.allowPaid === true;
  const errors = [];
  const hasKey = Boolean(resolveKey(options));

  const tiers = [
    { id: 'baidu', label: '百度搜索', needsKey: true, run: baiduSearchTier },
    { id: 'summary', label: '智能搜索生成高性能版', needsKey: true, run: baiduSummaryTier },
    { id: 'bing', label: 'Bing', needsKey: false, run: bingTier }
  ];

  for (const tier of tiers) {
    // ① 免费额度用满 → 默认直接降级（不自动花钱）
    if (tier.needsKey) {
      const free = Math.max(0, Number(freeQuota[tier.id] ?? DEFAULT_FREE_QUOTA[tier.id]) || 0);
      if (!allowPaid && usedCount(tier.id) >= free) {
        const why = `${tier.label} 今日免费额度已用满（${usedCount(tier.id)}/${free}），跳过`;
        log(`[travel-whale/search] ${why}`);
        errors.push(why);
        continue;
      }
      // ② 没有 Key 就别浪费一次降级
      if (!hasKey) {
        errors.push(`${tier.label} 未配置 API Key，跳过`);
        continue;
      }
    }
    // ③ 真正发起
    try {
      const results = await tier.run(q, options);
      // ⚠️ 只有成功才记账 —— 失败 / 超时不该吃掉免费额度
      if (tier.needsKey) bumpQuota(tier.id);
      log(`[travel-whale/search] "${q}" → ${tier.label}（${results.length} 条）`);
      return { ok: true, provider: tier.id, results, errors };
    } catch (error) {
      const why = `${tier.label} 失败：${error?.message ?? error}`;
      log(`[travel-whale/search] ${why}`);
      errors.push(why);
      // 落到下一级
    }
  }

  return { ok: false, provider: 'none', results: [], errors };
}
