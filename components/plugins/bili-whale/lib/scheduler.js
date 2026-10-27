// bili-whale / scheduler.js
//
// 插件自己拥有生物钟：每 60 秒看一眼今天该不该醒；评论收件箱按设置的间隔轮询；
// 直播间按独立开关轮询 gethistory。不依赖宿主 orchestrator、不 import 核心。
//
// 热重载防重复：定时器登记在 globalThis 上。新实例启动时先停掉旧实例；
// 旧实例的每个回调也会检查自己的 epoch 还是不是“当前代”，不是就自杀。

import { planTick, markPlan, runWake, runSkip, runCommentListen, runLiveListen } from './runtime.js';
import { getDb, markDirty, addEvent } from './store.js';
import { settings as readSettings, truncate } from './util.js';

const KEY = '__qqagent_bili_whale_scheduler__';
let current = null;

export function startScheduler(api, log) {
  const previous = globalThis[KEY];
  if (previous?.stop) {
    try { previous.stop('replaced'); } catch { /* ignore */ }
  }
  const epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const timers = [];
  let stopped = false;
  let ticking = false;
  let commenting = false;
  let living = false;
  const getSettings = () => readSettings(api);

  const alive = () => !stopped && globalThis[KEY]?.epoch === epoch;
  const safe = (fn, label) => {
    if (!alive()) return;
    Promise.resolve()
      .then(fn)
      .catch((error) => {
        try { log(`[bili-whale] ${label} 出错：${truncate(error?.message ?? error, 160)}`); } catch { /* ignore */ }
      });
  };

  async function tick() {
    if (!alive()) return;
    if (ticking) return;
    ticking = true;
    try {
      const s = getSettings();
      if (!s.enabled) return;
      const r = planTick(s);
      if (r.action === 'wake-now') {
        // 先记“已触发”，避免定时器在长流程里再触发一次；跑完记一次 woke。
        markPlan(r.plan, { fired: true, woke: false, done: false });
        addEvent('scheduler-wake', `到点：${r.plan.atText || ''}（${r.plan.window}）`);
        const out = await runWake(s, { trigger: 'clock' });
        markPlan({}, { fired: true, woke: true, done: true });
        const db = getDb();
        db.stats = db.stats || {};
        db.stats.lastWakeResult = { ...(db.stats.lastWakeResult || {}), ok: out.ok, reason: out.reason || '', at: Date.now() };
        markDirty();
        log(`[bili-whale] 醒来一轮结束：${out.ok ? '成功' : `失败 ${truncate(out.reason || '', 100)}`}`);
      } else if (r.action === 'skip-now') {
        markPlan(r.plan, { fired: true, woke: false, done: false });
        const out = await runSkip(s, { reason: r.plan.reason, trigger: 'clock' });
        markPlan({}, { fired: true, woke: false, done: true });
        log(`[bili-whale] 这次不看：${truncate(out.reason || '', 100)}`);
      }
    } finally {
      ticking = false;
    }
  }

  async function commentTick() {
    if (!alive() || commenting) return;
    commenting = true;
    try {
      const s = getSettings();
      if (!s.enabled || !s.listenComment) return;
      await runCommentListen(s);
    } finally {
      commenting = false;
    }
  }

  async function liveTick() {
    if (!alive() || living) return;
    living = true;
    try {
      const s = getSettings();
      if (!s.enabled || !s.liveEnabled || !s.liveRoom) return;
      await runLiveListen(s);
    } finally {
      living = false;
    }
  }

  const t1 = setInterval(() => safe(tick, '生物钟'), 60_000);
  const t2 = setInterval(() => safe(commentTick, '评论区监听'), 30_000);
  const t3 = setInterval(() => safe(liveTick, '直播监听'), 10_000);
  timers.push(t1, t2, t3);
  for (const t of timers) if (typeof t?.unref === 'function') t.unref();

  const s0 = setTimeout(() => safe(tick, '生物钟'), 8_000);
  const s1 = setTimeout(() => safe(commentTick, '评论区监听'), 20_000);
  const s2 = setTimeout(() => safe(liveTick, '直播监听'), 25_000);
  for (const t of [s0, s1, s2]) if (typeof t?.unref === 'function') t.unref();

  current = {
    epoch,
    stop(reason = '') {
      stopped = true;
      for (const t of timers) { try { clearInterval(t); } catch { /* ignore */ } }
      for (const t of [s0, s1, s2]) { try { clearTimeout(t); } catch { /* ignore */ } }
      if (globalThis[KEY] === current) {
        try { delete globalThis[KEY]; } catch { globalThis[KEY] = null; }
      }
      try { log(`[bili-whale] 定时器已停止${reason ? `（${reason}）` : ''}`); } catch { /* ignore */ }
    },
    tick,
    commentTick,
    liveTick
  };
  globalThis[KEY] = current;
  log('[bili-whale] 生物钟已启动：每 60 秒看计划，评论收件箱按设置的间隔轮询，直播间独立开关');
  return current;
}

export function stopScheduler(reason = '') {
  const cur = globalThis[KEY];
  if (cur?.stop) { try { cur.stop(reason); } catch { /* ignore */ } }
  current = null;
}
