// 庭院总线（courtyard-bus）—— 组件间实时事件总线（§2 试点，2026-10-24）。
//
// ── 它是什么 ──
// 一个极轻量的进程内 Pub/Sub：组件 A 调 publish(topic, payload)，组件 B 用
// api.capability('courtyard.bus') 拿到总线后 subscribe(topic, fn) 实时收到。
// 目标是替代"写自己的 JSON、定时去读别人的 JSON"的轮询延迟（v1 架构最长 10 分钟）。
//
// ── 降级红线（不能破）──
// 总线**只加速、不承载正确性**：订阅方必须保留原有的轮询/兜底路径，
// 总线不在、没订、回调抛错，都不允许影响任何组件的主流程。
// 本插件因此**零 fs / 零网络**：纯内存，重启即清空，也不需要可信插件登记。
//
// ── 事件词表（v1 试点只通一条）──
//   mood:state.shifted   发布方 sleep-mood   订阅方 mind-wish（即时吸收，去抖 30s）
//   后续按《03.md》§2.2 的词表逐条迁移，每条迁移都保留轮询降级。
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
export function setup(api) {
  apiRef = api;
  try { api?.log?.('庭院总线已加载（进程内事件 Pub/Sub 试点；零依赖、重启即清）'); } catch { /* ignore */ }
}
export function available() { return true; }
export const providers = { 'courtyard.bus': () => bus };
