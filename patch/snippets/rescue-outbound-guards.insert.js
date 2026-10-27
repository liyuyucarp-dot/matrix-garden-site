const outboundGuards = [];

/**
 * 出站守卫管道（2026-10-24，§3.3）：插件可注册自定义的出站内容审查器。
 *
 * 在救援网产出最终 messages 之后、合成 tool_call 之前逐个执行：
 *   · 返回 null                    → 否决，整段放弃（本轮不发）
 *   · 返回 { messages: [...] }     → 收窄/替换最终 messages（只能变少，注入会被 asMessages 过滤）
 *   · 返回 undefined / 抛错        → 不影响链路（守卫自身故障绝不拦死正常发言）
 *
 * 注册途径：api.services().registerOutboundGuard(fn)（fn 收到 { text, trigger, messages }）。
 * 返回注销函数。重复注册与注销都由调用方管理，本模块不做 owner 归并。
 */
export function registerOutboundGuard(fn) {
  if (typeof fn !== 'function') return () => {};
  outboundGuards.push(fn);
  return () => {
    const i = outboundGuards.indexOf(fn);
    if (i >= 0) outboundGuards.splice(i, 1);
  };
}

async function runOutboundGuards(context, log) {
  // ⚠️ 防御式默认：调用方漏传 messages / 注册表为空时返回 []（不发），
  //    绝不能把 undefined 漏给调用方的 .length —— 2026-10-25 审计 BUG-01。
  if (!outboundGuards.length) return Array.isArray(context.messages) ? context.messages : [];
  let messages = Array.isArray(context.messages) ? [...context.messages] : [];
  for (const guard of outboundGuards) {
    try {
      const r = await guard({ ...context, messages: [...messages] });
      if (r === null) { log('rescue: 出站守卫否决，已放弃'); return []; }
      if (r && Array.isArray(r.messages)) messages = r.messages.filter((m) => typeof m === 'string' && String(m).trim());
      if (!messages.length) { log('rescue: 出站守卫清空了 messages，已放弃'); return []; }
    } catch (e) { log(`rescue: 出站守卫自身出错（不拦截）：${e?.message ?? e}`); }
  }
  return messages;
}

