// limiter.js —— 全局主动消息限流（P1）
//
// 为什么要有：现在"要不要主动说话"散在 silence-ping / travel-whale 明信片 / qzone 主动评论里，
// 各判各的，没有全局视角。极端情况下同一分钟她可能在 3 个群各说一条 + 私聊 1 条 + 空间 1 条。
//
// 边界（重要）：
//   · **只给"发不发"的建议，不接管发送**。真发仍走 send_message（宿主有去重/分条/CQ 转义）。
//   · **只拦主动消息**（没人跟她说话时她自己开口）；回应用户不占桶，避免"她该说话时不说话"。
//   · 拒绝时返回原因字符串，调用方记日志后静默跳过，绝不抛错打断会话。
//
// 用法：
//   const rl = api.capability('courtyard.limit');
//   const r = rl.take({ chatKey, proactive: true });
//   if (!r.allowed) return { skip: true, reason: r.reason };
const DEFAULT_RULES = {
  global: { cap: 30, refillMs: 10 * 60 * 1000 },     // 全局：10 分钟内 30 条
  perChat: { cap: 8, refillMs: 10 * 60 * 1000 },    // 单会话：10 分钟内 8 条
  proactive: { cap: 3, refillMs: 60 * 60 * 1000 }   // 主动消息：单会话 1 小时 3 条
};

export function createLimiter({ log = () => {}, rules = {} } = {}) {
  const R = {
    global: { ...DEFAULT_RULES.global, ...(rules.global || {}) },
    perChat: { ...DEFAULT_RULES.perChat, ...(rules.perChat || {}) },
    proactive: { ...DEFAULT_RULES.proactive, ...(rules.proactive || {}) }
  };
  /** key → { tokens, at } */
  const buckets = new Map();
  const stats = { allowed: 0, denied: 0 };

  /** 令牌桶：按经过时间补，cap 封顶。 */
  function takeToken(key, rule, cost = 1) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: rule.cap, at: now }; buckets.set(key, b); }
    const elapsed = now - b.at;
    if (elapsed > 0) {
      const refill = (elapsed / rule.refillMs) * rule.cap;
      if (refill > 0) {
        b.tokens = Math.min(rule.cap, b.tokens + refill);
        b.at = now;
      }
    }
    if (b.tokens >= cost) { b.tokens -= cost; return 0; }
    const need = cost - b.tokens;
    const waitMs = Math.ceil((need / rule.cap) * rule.refillMs);
    return waitMs;
  }

  function peekToken(key, rule) {
    const b = buckets.get(key);
    if (!b) return rule.cap;
    const elapsed = Date.now() - b.at;
    return Math.min(rule.cap, b.tokens + (elapsed > 0 ? (elapsed / rule.refillMs) * rule.cap : 0));
  }

  return {
    /**
     * 申请一次发送额度。
     * @param {{chatKey?:string, proactive?:boolean, cost?:number}} opts
     * @returns {{allowed:boolean, reason?:string, retryInMs?:number}}
     */
    take(opts = {}) {
      const chatKey = String(opts.chatKey || 'global');
      const cost = Math.max(1, Math.round(Number(opts.cost) || 1));
      const proactive = opts.proactive === true;

      // 回应用户：不占主动桶，只受全局/单会话约束
      const waits = [];
      const g = takeToken('__global__', R.global, cost);
      if (g) { buckets.get('__global__').tokens += cost; waits.push(['全局', g]); }
      const c = takeToken(`chat:${chatKey}`, R.perChat, cost);
      if (c) { buckets.get(`chat:${chatKey}`).tokens += cost; waits.push(['本会话', c]); }
      if (proactive) {
        const p = takeToken(`pro:${chatKey}`, R.proactive, cost);
        if (p) { buckets.get(`pro:${chatKey}`).tokens += cost; waits.push(['主动消息', p]); }
      }
      if (!waits.length) { stats.allowed += 1; return { allowed: true }; }

      // 失败即回滚（本次不占额度）
      const [which, ms] = waits[0];
      stats.denied += 1;
      const reason = `${which}额度已用完，约 ${Math.max(1, Math.round(ms / 60000))} 分钟后才有空档`;
      if (stats.denied % 20 === 1) log(`[limit] 拦截一次主动发送（${chatKey}）：${reason}`);
      return { allowed: false, reason, retryInMs: ms };
    },

    /** 只查不扣（给"现在能不能说"的预判用）。 */
    peek(opts = {}) {
      const chatKey = String(opts.chatKey || 'global');
      const proactive = opts.proactive === true;
      const g = peekToken('__global__', R.global);
      const c = peekToken(`chat:${chatKey}`, R.perChat);
      const p = proactive ? peekToken(`pro:${chatKey}`, R.proactive) : Infinity;
      return { ok: g >= 1 && c >= 1 && p >= 1, global: g, chat: c, proactive: p };
    },

    /** 配置/状态（面板与体检用）。 */
    describe() {
      return {
        rules: R,
        buckets: [...buckets.entries()].map(([k, b]) => ({ key: k, tokens: Math.round(b.tokens * 10) / 10 })),
        stats: { ...stats }
      };
    },

    /** 测试/运维：清空所有桶。 */
    reset() { buckets.clear(); return true; },

    stats() { return { ...stats, buckets: buckets.size }; }
  };
}

export const __test = { DEFAULT_RULES };
