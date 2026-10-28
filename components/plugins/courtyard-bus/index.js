// 庭院总线（courtyard-bus）—— 组件间实时事件总线 + 状态原语（§2 试点，2026-10-24 / 2026-10-28 扩）
//
// ── 它是什么 ──
// 一个极轻量的进程内 Pub/Sub：组件 A 调 publish(topic, payload)，组件 B 用
// api.capability('courtyard.bus') 拿到总线后 subscribe(topic, fn) 实时收到。
// 目标是替代"写自己的 JSON、定时去读别人的 JSON"的轮询延迟（v1 架构最长 10 分钟）。
//
// ── 降级红线（不能破）──
// 总线**只加速、不承载正确性**：订阅方必须保留原有的轮询/兜底路径，
// 总线不在、没订、回调抛错，都不允许影响任何组件的主流程。
// 总线本体**零 fs / 零网络**：纯内存，重启即清空，也不需要可信插件登记。
//
// ── 2026-10-28 扩展：三个同级 provider（仍是可选、可降级）──
//   courtyard.store   统一状态原语：读缓存 + 按文件排队 + write-temp-rename 原子写 + 防抖落盘
//   courtyard.clock   中央心跳：一个 1s 主循环收拢各组件散落的 setInterval（带抖动错峰、单任务超时）
//   courtyard.limit   全局发送限流：令牌桶（全局 / 单会话 / 主动消息），只给建议、不接管发送
//   它们都放在同插件下，但**与总线本身解耦**：拿不到 capability 的组件必须保持原有直读直写路径。
//
// ── 事件词表（v1 试点只通一条）──
//   mood:state.shifted   发布方 sleep-mood   订阅方 mind-wish（即时吸收，去抖 30s）
//   后续按《03.md》§2.2 的词表逐条迁移，每条迁移都保留轮询降级。
import { createStore } from './store.js';
import { createClock } from './clock.js';
import { createLimiter } from './limiter.js';



const listeners = new Map();   // topic → Set<fn>
const stats = { published: 0, delivered: 0, errors: 0 };

const bus = {
  publish(topic, payload) {
    const t = String(topic || '');
    if (!t) return { ok: false, error: 'topic 必须是非空字符串' };
    const set = listeners.get(t);
    stats.published += 1;
    let delivered = 0;
    if (set) for (const fn of set) {
      try { fn(payload); delivered += 1; } catch { stats.errors += 1; }
    }
    stats.delivered += delivered;
    return { ok: true, delivered };
  },
  subscribe(topic, fn) {
    const t = String(topic || '');
    if (!t || typeof fn !== 'function') return () => {};
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t).add(fn);
    return () => { const set = listeners.get(t); if (set) set.delete(fn); };
  },
  /** 观测用：当前话题与订阅者数（控制台/体检可读） */
  describe() {
    return { topics: [...listeners.entries()].map(([topic, set]) => ({ topic, subscribers: set.size })), ...stats };
  }
};

let apiRef = null;
let store = null;
let clock = null;
let limiter = null;

export function setup(api) {
  apiRef = api;
  const log = (m) => { try { api?.log?.(m); } catch { /* ignore */ } };
  try {
    store = createStore({ log, debounceMs: 3000 });
    clock = createClock({ log });
    limiter = createLimiter({ log });
    // ★ 2026-10-28（P2）：把三个基础设施挂到 globalThis —— 组件不需要 api 也能拿到，
    //   而且跨模块实例唯一（热重载后旧实例仍指向同一份，这正是 travel-whale 用 G[TICKER_SLOT] 的理由）。
    try { globalThis.__courtyardInfra = { store, clock, limiter, bus }; } catch { /* ignore */ }
    log('庭院总线已加载（Pub/Sub + 状态原语 store/clock/limit；**均可选**，拿不到请自行降级）');
  } catch (err) {
    // 任何一项起不来都不影响总线本身
    log(`庭院总线：状态原语初始化失败（总线仍可用）：${err?.message ?? err}`);
  }
}

export function available() { return true; }

/** 热重载/退出：先把没落盘的写完，再停表。失败也只记日志。 */
export async function dispose() {
  try { if (store) await store.flushAll(); } catch { /* ignore */ }
  try { if (clock) clock.dispose(); } catch { /* ignore */ }
  try { if (limiter) limiter.reset(); } catch { /* ignore */ }
  try { if (globalThis.__courtyardInfra?.clock === clock) delete globalThis.__courtyardInfra; } catch { /* ignore */ }
}

export function deactivate() { return dispose(); }

export const providers = {
  'courtyard.bus': () => bus,
  'courtyard.store': () => store,
  'courtyard.clock': () => clock,
  'courtyard.limit': () => limiter
};

/** 观测（体检/控制台）：一次拿到四个部件的运行态。 */
export function describe() {
  return {
    bus: bus.describe(),
    store: store ? store.stats() : null,
    clock: clock ? { ...clock.stats(), tasks: clock.describe() } : null,
    limiter: limiter ? limiter.stats() : null
  };
}

export const internals = { bus, get store() { return store; }, get clock() { return clock; }, get limiter() { return limiter; } };
