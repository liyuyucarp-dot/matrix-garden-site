// clock.js —— 中央心跳调度器（P1）
//
// 为什么要有：组件里有 11 处 setInterval 各起各的（bili-whale/scheduler 3 个、travel-whale ticker、
// autobiography、sleep-mood、mind-wish、qzone/diary、courtyard-map …）。问题不是"多"，
// 而是：① 都在启动瞬间同时开始 → 前 5 秒 IO 尖峰；② 没人统一降频；③ 各自注册各自的清理，热重载漏清就泄漏。
//
// 设计：**一个 1 秒主循环** + 到期队列（按下次时间排序的数组，量级 < 50 不需要堆）。
//   · 每个任务带 ±jitter 抖动 → 天然错峰
//   · 任务串行 await，单任务超时不阻塞后续
//   · 全部任务集中在一处注册，dispose 时一次清干净
//
// 用法：
//   const clock = api.capability('courtyard.clock');
//   const off = clock.every('travel-whale/tick', 60_000, async () => {...}, { jitter: 0.15 });
import { setInterval as nodeSetInterval } from 'node:timers';

export function createClock({ log = () => {}, tickMs = 1000, taskTimeoutMs = 30000 } = {}) {
  /** id → { id, everyMs, fn, nextAt, running, errors, lastRunAt, lastError } */
  const tasks = new Map();
  let timer = null;
  let stopped = false;
  const stats = { ticks: 0, runs: 0, errors: 0, timeouts: 0, skipped: 0 };

  function jitterOf(ms, ratio) {
    const r = Number.isFinite(ratio) ? Math.max(0, Math.min(0.5, ratio)) : 0;
    if (!r) return 0;
    return Math.round((Math.random() * 2 - 1) * ms * r);
  }

  function ensureTimer() {
    if (timer || stopped) return;
    timer = nodeSetInterval(tick, tickMs);
    try { timer.unref?.(); } catch { /* ignore */ }
  }

  function stopTimerIfIdle() {
    if (timer && tasks.size === 0) {
      try { clearInterval(timer); } catch { /* ignore */ }
      timer = null;
    }
  }

  async function runOne(t) {
    if (t.running) { stats.skipped += 1; return; }
    t.running = true;
    stats.runs += 1;
    const startedAt = Date.now();
    try {
      const p = Promise.resolve().then(() => t.fn({ id: t.id, everyMs: t.everyMs, now: startedAt }));
      let to = null;
      const guard = new Promise((_, rej) => {
        to = setTimeout(() => rej(new Error('timeout')), taskTimeoutMs);
        try { to.unref?.(); } catch { /* ignore */ }
      });
      await Promise.race([p, guard]);
      t.lastRunAt = startedAt;
      t.lastError = null;
      t.errors = 0;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg === 'timeout') stats.timeouts += 1;
      else stats.errors += 1;
      t.errors = (t.errors || 0) + 1;
      t.lastError = msg.slice(0, 120);
      // 连续失败 5 次 → 自动降频一倍（最多 8 倍），避免坏任务把日志刷爆
      if (t.errors >= 5) {
        t.everyMs = Math.min(t.everyMs * 2, (t.baseEveryMs || t.everyMs) * 8);
        t.errors = 0;
        log(`[clock] ${t.id} 连续失败，已降频至 ${t.everyMs}ms`);
      } else {
        log(`[clock] ${t.id} 执行出错：${msg.slice(0, 160)}`);
      }
    } finally {
      t.running = false;
      t.nextAt = Date.now() + t.everyMs + jitterOf(t.everyMs, t.jitter);
    }
  }

  function tick() {
    if (stopped) return;
    stats.ticks += 1;
    const now = Date.now();
    for (const t of tasks.values()) {
      if (t.nextAt <= now) runOne(t).catch(() => {});
    }
  }

  return {
    /**
     * 注册周期任务。
     * @param {string} id 唯一名（建议 `<组件>/<用途>`）
     * @param {number} everyMs 周期
     * @param {(ctx:{id:string,everyMs:number,now:number})=>any} fn
     * @param {{jitter?:number, runOnStart?:boolean}} opts jitter=0.15 表示 ±15%
     * @returns {() => void} 注销函数
     */
    every(id, everyMs, fn, opts = {}) {
      const key = String(id || '').trim();
      if (!key) throw new Error('clock.every 需要 id');
      if (typeof fn !== 'function') throw new Error('clock.every 需要函数');
      const ms = Math.max(tickMs, Math.round(Number(everyMs) || 0));
      if (!ms) throw new Error('clock.every 需要正整数周期');
      // 重复注册 → 替换（幂等，热重载友好）
      if (tasks.has(key)) tasks.delete(key);
      const jitter = opts.jitter === undefined ? 0.15 : Number(opts.jitter);
      const task = {
        id: key, everyMs: ms, baseEveryMs: ms, fn, jitter,
        nextAt: Date.now() + (opts.runOnStart ? 0 : ms + jitterOf(ms, jitter)),
        running: false, errors: 0, lastRunAt: 0, lastError: null
      };
      tasks.set(key, task);
      ensureTimer();
      return () => this.cancel(key);
    },

    /** 注销单个任务。 */
    cancel(id) {
      const ok = tasks.delete(String(id || ''));
      stopTimerIfIdle();
      return ok;
    },

    /** 手动触发一次（不等周期）。 */
    async trigger(id) {
      const t = tasks.get(String(id || ''));
      if (!t) return false;
      await runOne(t);
      return true;
    },

    /** ⏸ 全部暂停（夜里降频等场景）。 */
    pause() { stopped = true; if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; } },
    /** ▶ 恢复。 */
    resume() { stopped = false; if (tasks.size) ensureTimer(); },

    describe() {
      return [...tasks.values()].map((t) => ({
        id: t.id, everyMs: t.everyMs, nextInMs: Math.max(0, t.nextAt - Date.now()),
        running: t.running, lastError: t.lastError
      }));
    },

    stats() { return { ...stats, tasks: tasks.size }; },

    /** 退出/热重载：停表 + 清任务。 */
    dispose() {
      stopped = true;
      if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
      tasks.clear();
    }
  };
}
