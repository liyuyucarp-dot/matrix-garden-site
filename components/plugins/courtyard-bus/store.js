// store.js —— 矩阵庭院状态原语（P1）
//
// 为什么要有它：组件侧现在有 51 处自己写 fs（21 处手写 tmp+rename、5 处 appendFileSync 完全不原子、
// 64 处每轮重复 readFileSync）。这层的职责只有四件事，**不接管数据归属**（各组件仍各写各的文件）：
//   ① 读走内存缓存（热路径不再反复读盘）
//   ② 写按「文件」排队（同一文件的并发读-改-写不再互相覆盖）
//   ③ write-temp-then-rename 原子落盘（崩在半夜不留半截 JSON）
//   ④ 防抖合并（N 秒内的多次修改只落一次盘）
//
// 刻意不做：
//   · 不做跨进程锁（宿主单进程；多开靠数据目录隔离）
//   · 不搬数据、不改格式（存档是用户资产，"存档不搬家"是硬约束）
//   · 不做数据库（最大文件 27KB，杀鸡用牛刀）
//
// 用法：
//   const store = api.capability('courtyard.store');        // 拿不到就自己降级
//   await store.update(file, (prev) => next);               // 读-改-写（锁内算）
//   await store.append(file, line);                          // jsonl 追加（内部也是读-改-写）
//   await store.flush(file);                                 // 关键操作前强制落盘
import fs from 'node:fs';
import path from 'node:path';

const JSONL = /\.jsonl?$|\.ndjson$/i;

function isJsonl(file) {
  return /\.(jsonl|ndjson)$/i.test(String(file || ''));
}

/** 原子写：同目录 tmp → fsync → rename。rename 在同卷内是原子的。 */
function writeAtomic(file, text, log) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持，忽略 */ }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  fs.renameSync(tmp, file);
}

/** 读文件 → 内部表示。json → 对象；jsonl → 行数组；其它 → 字符串 */
function parseFile(file, raw) {
  if (!isJsonl(file) && raw.trimStart().startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* 落到字符串 */ }
  }
  if (isJsonl(file)) return raw.split('\n').filter((x) => x.trim());
  return raw;
}

function stringifyDoc(file, doc) {
  if (Array.isArray(doc)) return doc.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + (doc.length ? '\n' : '');
  if (typeof doc === 'string') return doc;
  return JSON.stringify(doc, null, 1);
}

export function createStore({ log = () => {}, debounceMs = 3000, recheckMs = 60000 } = {}) {
  /** key（绝对路径）→ { doc, mtime, loadedAt, dirty, timer, chain, writing } */
  const entries = new Map();
  const stats = { hits: 0, misses: 0, reads: 0, writes: 0, coalesced: 0, flushes: 0, errors: 0 };

  function entry(file) {
    const key = path.resolve(String(file || ''));
    if (!key) throw new Error('store: 需要文件路径');
    let e = entries.get(key);
    if (!e) {
      e = { key, doc: undefined, mtime: 0, loadedAt: 0, dirty: false, timer: null, chain: Promise.resolve(), writing: null };
      entries.set(key, e);
    }
    return e;
  }

  /** 从盘读（或命中缓存）。返回 doc 的**副本语义**：调用方要改就改完写回，别长期持有引用。 */
  function load(e) {
    if (e.doc !== undefined && Date.now() - e.loadedAt < recheckMs) {
      stats.hits += 1;
      return e.doc;
    }
    let mtime = 0;
    try { mtime = fs.statSync(e.key).mtimeMs; } catch { mtime = 0; }
    if (e.doc !== undefined && mtime && mtime <= e.mtime) {
      // 外部没人动过：延长缓存
      e.loadedAt = Date.now();
      stats.hits += 1;
      return e.doc;
    }
    stats.misses += 1;
    let raw = '';
    try {
      raw = fs.readFileSync(e.key, 'utf8');
      stats.reads += 1;
    } catch (err) {
      if (err?.code !== 'ENOENT') { stats.errors += 1; log(`[store] 读失败 ${e.key}: ${err?.message ?? err}`); }
      raw = '';
    }
    e.doc = raw ? parseFile(e.key, raw) : (isJsonl(e.key) ? [] : {});
    e.mtime = mtime;
    e.loadedAt = Date.now();
    return e.doc;
  }

  async function diskWrite(e) {
    e.dirty = false;
    const text = stringifyDoc(e.key, e.doc);
    try {
      writeAtomic(e.key, text, log);
      stats.writes += 1;
      try { e.mtime = fs.statSync(e.key).mtimeMs; } catch { /* ignore */ }
      e.loadedAt = Date.now();
    } catch (err) {
      stats.errors += 1;
      e.dirty = true;
      log(`[store] 写失败 ${e.key}: ${err?.message ?? err}`);
      throw err;
    }
  }

  function schedule(e) {
    if (e.timer) { stats.coalesced += 1; return; }
    e.timer = setTimeout(() => {
      e.timer = null;
      if (!e.dirty) return;
      e.chain = e.chain.then(() => (e.dirty ? diskWrite(e) : null)).catch(() => {});
    }, Math.max(0, debounceMs));
    try { e.timer.unref?.(); } catch { /* ignore */ }
  }

  /** 同一个文件的修改串行执行，避免读-改-写互相覆盖。 */
  function enqueue(e, fn) {
    const run = () => fn();
    const next = e.chain.then(run, run);
    // chain 只用于串行；错误不吞到下一个任务之外
    e.chain = next.catch(() => {});
    return next;
  }

  return {
    /** 读（走缓存）。返回的是内部对象引用 —— 只读用；要改请走 update。 */
    read(file) { return load(entry(file)); },

    /** 同步窥视缓存（未加载过则 undefined）。 */
    peek(file) {
      const e = entries.get(path.resolve(String(file || '')));
      return e ? e.doc : undefined;
    },

    /**
     * 读-改-写。fn 在锁内执行，拿到的是当前最新值。
     * 返回 fn 的返回值。落盘走防抖（需要立刻落就 await flush）。
     */
    update(file, fn, { immediate = false } = {}) {
      const e = entry(file);
      return enqueue(e, () => {
        const cur = load(e);
        const next = fn(cur);
        if (next !== undefined) e.doc = next;
        e.dirty = true;
        if (immediate) return diskWrite(e);
        schedule(e);
        return e.doc;
      });
    },

    /** jsonl 追加一行（内部转读-改-写，因此是原子的）。 */
    append(file, line, opts = {}) {
      const text = typeof line === 'string' ? line : JSON.stringify(line);
      return this.update(file, (doc) => {
        const arr = Array.isArray(doc) ? doc : [];
        arr.push(text);
        return arr;
      }, opts);
    },

    /** 立刻落盘（关键操作前调：发消息、结算、退出）。 */
    async flush(file) {
      const e = entry(file);
      return enqueue(e, async () => {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        if (!e.dirty) return;
        await diskWrite(e);
        stats.flushes += 1;
      });
    },

    /** 全部落盘（热重载/退出前）。 */
    async flushAll() {
      const keys = [...entries.values()].filter((e) => e.dirty).map((e) => e.key);
      const out = [];
      for (const k of keys) out.push(await this.flush(k));
      return out.length;
    },

    /** 丢掉缓存（外部改了文件、或测试用）。 */
    invalidate(file) {
      const e = entries.get(path.resolve(String(file || '')));
      if (!e) return false;
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      e.doc = undefined; e.mtime = 0; e.loadedAt = 0; e.dirty = false;
      return true;
    },

    /** 清理历史残留 tmp（上次崩在中途留下的）。启动时调一次。 */
    sweepTmp(dir) {
      let n = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/^\..+\.\d+\.[0-9a-z]+\.tmp$/.test(f)) {
            try { fs.unlinkSync(path.join(dir, f)); n += 1; } catch { /* ignore */ }
          }
        }
      } catch { /* 目录不存在就算了 */ }
      return n;
    },

    stats() {
      return { ...stats, keys: entries.size, dirtyKeys: [...entries.values()].filter((e) => e.dirty).length };
    },

    /** 便于测试：现在的防抖窗口 */
    get debounceMs() { return debounceMs; }
  };
}

export const __test = { isJsonl, parseFile, stringifyDoc, writeAtomic, JSONL };
