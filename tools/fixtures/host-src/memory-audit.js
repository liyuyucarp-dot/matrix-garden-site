// 记忆审计出口：`data/memory/audit.jsonl`
//
// ── 为什么存在 ──────────────────────────────────────────────────────────────
// 插件（favor-core 的 lib/audit.js）需要一个"把一条记忆变更落盘"的出口。
// 审计是**旁路**：写不进去绝不能影响记账/聊天主流程 —— 所以本模块所有函数都不抛错，
// 失败只记一行 warn 并返回 null / 空数组。
//
// ── 行格式 ──────────────────────────────────────────────────────────────────
//   { at: <ms>, type: 'impression'|'favor'|'pending'|'judge_clean'|'judge_error'|…, source, userId, name, … }
//   `at` 由本模块补（调用方带了就以调用方的为准）；其余字段**原样保留**（与 memory-people 的
//   "不认识就留着"同一套口径，避免以后加字段被静默抹掉）。
//
// ── 轮转（详解 §10.3）───────────────────────────────────────────────────────
//   判定开着时每回合至少一条 judge_clean：一天约 400 KB，一年 ~146 MB。而读路径是
//   "整文件 readFileSync + split"，文件一大就卡。所以：
//     · 按大小轮转：单文件到 5 MB → 归档成 audit-<ISO>.jsonl，只留最近 5 个（总量 ~30 MB）；
//     · 读取由新到旧跨文件，凑够 limit 就停 —— 延迟与历史总量解耦。
//   阈值可用 QQ_AGENT_AUDIT_MAX_BYTES / QQ_AGENT_AUDIT_KEEP 覆盖（测试要小文件）。
//   轮转失败**绝不挡写入**。
//
// ── 读取口径（详解 §10.4）───────────────────────────────────────────────────
//   · **显式白名单优先**：传了 types 就不再套 excludeTypes（老版两者同时生效，
//     导致 types:['replace'] 永远返回空）；
//   · 被过滤掉的行**不占名额**；
//   · maxScan 是**跨文件总预算**，按"想拿多少条"动态放大。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const AUDIT_FILE = 'audit.jsonl';

/** 单文件轮转阈值（字节）。 */
function maxBytes() {
  const n = Number(process.env.QQ_AGENT_AUDIT_MAX_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.round(n) : 5 * 1024 * 1024;
}

/** 归档保留数量。 */
function keepArchives() {
  const n = Number(process.env.QQ_AGENT_AUDIT_KEEP);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 5;
}

export function auditPath() {
  return path.join(MEMORY_DIR, AUDIT_FILE);
}

function safeWarn(msg, detail) {
  try { logger?.warn?.(`[memory-audit] ${msg}${detail ? `：${detail}` : ''}`); } catch { /* 忽略 */ }
}

function isoStamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** 所有审计文件，**由新到旧**（当前文件在最前，归档按文件名倒序）。 */
export function listAuditFiles() {
  const out = [];
  try {
    const main = auditPath();
    if (fs.existsSync(main)) out.push(main);
    const ents = fs.readdirSync(MEMORY_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /^audit-.*\.jsonl$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const name of ents) out.push(path.join(MEMORY_DIR, name));
  } catch { /* 目录不存在 = 没有审计 */ }
  return out;
}

/** 超过阈值就归档（失败只 warn，不抛）。 */
export function rotateIfNeeded(now = Date.now()) {
  try {
    const main = auditPath();
    if (!fs.existsSync(main)) return null;
    const size = fs.statSync(main).size;
    if (size < maxBytes()) return null;
    const dest = path.join(MEMORY_DIR, `audit-${isoStamp(now)}.jsonl`);
    fs.renameSync(main, dest);
    // 清理多余归档（keep 个之外最旧的）
    const arch = fs.readdirSync(MEMORY_DIR)
      .filter((n) => /^audit-.*\.jsonl$/.test(n))
      .sort();
    const keep = keepArchives();
    for (const name of arch.slice(0, Math.max(0, arch.length - keep))) {
      try { fs.rmSync(path.join(MEMORY_DIR, name), { force: true }); } catch { /* 忽略 */ }
    }
    return dest;
  } catch (e) {
    safeWarn('轮转失败（不影响写入）', e?.message ?? String(e));
    return null;
  }
}

/**
 * 追加一行审计。
 * @param {object} entry 至少要有 type；其余字段原样保留
 * @returns {object|null} 写入的行；失败返回 null（**绝不抛错**）
 */
export function logMemoryChange(entry) {
  try {
    if (!entry || typeof entry !== 'object') return null;
    const type = String(entry.type || '').trim();
    if (!type) return null;
    const line = { at: Date.now(), ...entry, type };
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    rotateIfNeeded(line.at);
    fs.appendFileSync(auditPath(), JSON.stringify(line) + '\n', 'utf8');
    return line;
  } catch (e) {
    safeWarn('写入失败（已忽略）', e?.message ?? String(e));
    return null;
  }
}

function parseLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object') out.push(j);
    } catch { /* 半截行/坏行直接跳过（审计不该因为一行坏数据整体失败） */ }
  }
  return out;
}

/**
 * 读取审计（由新到旧，跨文件）。
 *
 * @param {{limit?:number, types?:string[]|null, excludeTypes?:string[]|null, since?:number, until?:number, maxScan?:number}} opts
 * @returns {object[]} 命中的行（新 → 旧）
 */
export function readMemoryAudit(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 100);
  const wantTypes = Array.isArray(opts.types) && opts.types.length ? new Set(opts.types.map(String)) : null;
  const excludeTypes = Array.isArray(opts.excludeTypes) && opts.excludeTypes.length ? new Set(opts.excludeTypes.map(String)) : null;
  // 显式白名单优先：传了 types 就不再套默认 excludeTypes
  const skipTypes = wantTypes ? null : excludeTypes;
  const since = Number(opts.since) || 0;
  const until = Number(opts.until) || 0;
  // 跨文件总扫描预算：想要多少条就放大多少（过滤掉的行不占名额）
  const maxScan = Math.max(200, Number(opts.maxScan) || limit * 10);

  const hits = [];
  let scanned = 0;
  for (const file of listAuditFiles()) {
    let lines = [];
    try { lines = parseLines(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (hits.length >= limit || scanned >= maxScan) break;
      scanned += 1;
      const j = lines[i];
      const type = String(j?.type || '');
      if (wantTypes && !wantTypes.has(type)) continue;
      if (skipTypes && skipTypes.has(type)) continue;
      const at = Number(j?.at) || 0;
      if (since && at < since) continue;
      if (until && at > until) continue;
      hits.push(j);
    }
    if (hits.length >= limit || scanned >= maxScan) break;
  }
  return hits;
}

/** 审计统计（控制台/排查用）。 */
export function auditStats() {
  const files = listAuditFiles();
  let bytes = 0;
  let lines = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
      lines += parseLines(fs.readFileSync(f, 'utf8')).length;
    } catch { /* 忽略 */ }
  }
  return { files: files.length, bytes, lines, path: auditPath(), maxBytes: maxBytes(), keep: keepArchives() };
}
