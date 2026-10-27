// 跨群「人档案」：`data/memory/people/<档案键>.json`
//
// ── 为什么单独一层（详解 §4.1）─────────────────────────────────────────────
// 0.4.0 的印象是**按群**存的（`data/memory/group_<群号>/<QQ>.json`，见 `src/memory.js`）。
// 而"对某个人的态度"是**跨群**的：同一个人在三个群里说话，好感分不该有三份。
// 所以：印象按群（走 memory.js），**好感分 / 判断台账 / 结算历史跨群**（走本模块），
// 双读互不写。
//
// ── 档案键（详解 §4.2 末）──────────────────────────────────────────────────
//   · 有 QQ 号 → 纯数字串本身（`<QQ>.json`）；
//   · 只有名字 → `_n_<名字>.json`（插件侧 `rules.js` 的 `nameOnlyKey` 负责造键，
//     本模块只按传入的键找文件，不做语义判断）。
//
// ── 三条设计红线（详解 §4.3）───────────────────────────────────────────────
//   ① **不认识的字段一律原样保留**：读进来什么样、写回去还什么样。老实现会把
//      `intensity` / `hits` / `lastAt` 这类后加字段静默抹掉，这一层绝不再犯。
//   ② **坏档不当「没有」**：解析失败先改名 `.corrupt-<时间戳>` 留档，再返回 null；
//      留档本身失败（Windows 占用等）→ 抛错，宁可报错，也不覆盖可能只是半截写的档案。
//   ③ **原子写**：tmp + rename，断电不会留半截档案。
//
// 消费方：`plugins/favor-core/lib/ledger.js`（import 本模块的 6 个函数）、
// 以后控制台「群友」页的路由（`updatePerson` 作为插件缺席时的降级路径）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const PEOPLE_SUBDIR = path.join('memory', 'people');
const LEDGER_MAX = 40;        // 每人判断记录上限（插件侧 ledgerMax 默认 40，这里做兜底裁剪）
const CYCLES_MAX = 20;        // 结算历史上限（详解 §4.2）

export function peopleDir() {
  return path.join(DATA_DIR, PEOPLE_SUBDIR);
}

/** 纯 QQ 号（1~15 位数字）。 */
export function isQqNumber(v) {
  return /^\d{1,15}$/.test(String(v ?? '').trim());
}

/**
 * 档案键 → 安全文件名（防路径穿越 / Windows 非法字符 / 超长）。
 * 键本身是语义标识（QQ 号或 `_n_名字`），这里只做**文件系统层**的清洗。
 */
export function safeFileName(key) {
  const raw = String(key ?? '').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);
  return cleaned || '_unknown';
}

export function personFile(key) {
  return path.join(peopleDir(), `${safeFileName(key)}.json`);
}

/** 好感分 clamp 到 0~100 整数（非数字 → 50 中性）。 */
export function clampFavor(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const arr = (v) => (Array.isArray(v) ? v : []);

/** 一份空档案（favor 50 = 中性起点）。 */
export function blankPerson(key) {
  const k = String(key ?? '');
  return {
    userId: k,
    name: '',
    chats: [],
    impressions: [],
    favor: 50,
    ledger: [],
    pending: { count: 0, score: 0, since: 0, entries: [] },
    cycles: [],
    cycleCount: 0,
    pendingSince: 0,
    lastFavorChangeAt: 0,
    lastVerdictAt: 0,
    manuallyEditedAt: 0,
    updatedAt: 0,
    lastConsolidatedAt: 0
  };
}

/**
 * 规范化（**保留未知字段**）：只保证"我们自己认识的字段"形状正确，
 * 其余原样带回去 —— 这是与老实现最大的差别。
 */
export function normalizePerson(raw, key = '') {
  const base = blankPerson(key || raw?.userId || '');
  const out = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  out.userId = String(out.userId || key || '');
  out.name = String(out.name || '');
  out.chats = arr(out.chats).map(String).slice(-8);
  out.impressions = arr(out.impressions).filter((x) => x && typeof x === 'object');
  out.favor = clampFavor(out.favor);
  out.ledger = arr(out.ledger).filter((x) => x && typeof x === 'object').slice(-LEDGER_MAX);
  const p = out.pending && typeof out.pending === 'object' ? out.pending : {};
  const entries = arr(p.entries).map(String).filter(Boolean);
  out.pending = {
    ...p,
    count: entries.length,                    // 详解 §4.2：count 永远 == entries.length
    score: num(p.score, 0),
    since: num(p.since, 0),
    entries
  };
  out.cycles = arr(out.cycles).filter((x) => x && typeof x === 'object').slice(-CYCLES_MAX);
  out.cycleCount = Math.max(0, Math.round(num(out.cycleCount, 0)));
  out.pendingSince = num(out.pendingSince, 0);
  out.lastFavorChangeAt = num(out.lastFavorChangeAt, 0);
  out.lastVerdictAt = num(out.lastVerdictAt, 0);
  out.manuallyEditedAt = num(out.manuallyEditedAt, 0);
  out.updatedAt = num(out.updatedAt, 0);
  out.lastConsolidatedAt = num(out.lastConsolidatedAt, 0);
  return out;
}

/**
 * 读一份档案。
 * @returns {object|null} 不存在 → null；坏档 → 隔离留档后 null；隔离失败 → 抛错（有意为之）
 */
export function readPerson(key) {
  const file = personFile(key);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;                              // 没文件 = 没有这个人
  }
  try {
    const j = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('不是对象');
    return normalizePerson(j, key);
  } catch (e) {
    // 坏档：原样留档，绝不覆盖（详解 §4.3②）
    const dest = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, dest);                // 失败就抛给调用方（宁可报错）
    try { logger?.warn?.(`[memory-people] 档案损坏已隔离：${path.basename(file)} → ${path.basename(dest)}（${e?.message ?? e}）`); } catch { /* 忽略 */ }
    return null;
  }
}

/** 原子写一份档案（失败返回 false，不抛错 —— 写不进不能拖垮聊天）。 */
export function writePerson(person) {
  try {
    const key = String(person?.userId || '');
    if (!key) return false;
    const norm = normalizePerson({ ...person, updatedAt: Date.now() }, key);
    const dir = peopleDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = personFile(key);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(norm, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { logger?.warn?.(`[memory-people] 写入失败：${e?.message ?? e}`); } catch { /* 忽略 */ }
    return false;
  }
}

/** 取（没有就建一份空的并落盘）。 */
export function ensurePerson(key) {
  const k = String(key ?? '');
  const got = readPerson(k);
  if (got) return got;
  const made = blankPerson(k);
  writePerson(made);
  return made;
}

/** 列出全部档案（按 favor 升序，便于"最冷/最热"一眼看到）。 */
export function listPeople() {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(peopleDir()).filter((n) => n.endsWith('.json') && !n.includes('.corrupt-'));
  } catch {
    return out;                               // 目录不存在 = 空
  }
  for (const name of names) {
    const key = name.replace(/\.json$/, '');
    const p = readPerson(key);
    if (p) out.push(p);
  }
  out.sort((a, b) => Number(a.favor) - Number(b.favor));
  return out;
}

/**
 * 部分更新（管理页用；插件缺席时的降级路径也用它）。
 * 只覆盖传入的字段，其余保持原样；`reason` 会记进 `manuallyEditedAt` 语义。
 */
export function updatePerson(key, patch = {}, { reason = '' } = {}) {
  const cur = ensurePerson(key);
  const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
  if (patch && patch.favor !== undefined) next.favor = clampFavor(patch.favor);
  next.manuallyEditedAt = Date.now();
  if (reason) next.lastManualReason = String(reason).slice(0, 200);
  const okWrite = writePerson(next);
  return okWrite ? next : null;
}

/** 删除一份档案（管理页用）。 */
export function deletePerson(key) {
  try { fs.rmSync(personFile(key), { force: true }); return true; } catch { return false; }
}

/** 档案统计（控制台/排查用）。 */
export function peopleStats() {
  const all = listPeople();
  return {
    dir: peopleDir(),
    count: all.length,
    avgFavor: all.length ? Math.round(all.reduce((a, b) => a + Number(b.favor || 0), 0) / all.length) : 0,
    coldest: all[0] ? { userId: all[0].userId, favor: all[0].favor } : null,
    warmest: all.length ? { userId: all[all.length - 1].userId, favor: all[all.length - 1].favor } : null
  };
}
