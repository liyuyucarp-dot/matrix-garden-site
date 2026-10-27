// 思考分级 —— llm.request-params 提供者
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// 晴天现在 `api.thinkingMode = "auto"`，DeepSeek 默认开思考 ⇒ **每条消息都在想**。
// 而群里大量消息是"嗯"、"哈哈"、"在吗"、"收到"——这类本来不需要推理。
//
// 代价有三块，而省下的不止 token：
//   ① reasoning token：实测 DeepSeek 思考段常占总输出的 1/3~2/3；
//   ② 首字延迟：思考完才开始吐正文，群友等的是这段；
//   ③ ★ **2026-10-23 的真事故**：思考模式要求把上一轮 `reasoning_content` 原样回传，
//      宿主不回传 ⇒ `HTTP 400 The reasoning_content in the thinking mode must be passed back`
//      （10-21 有 282 次、10-22 有 261 次）。**短句免掉思考，就压根不会产生 reasoning_content。**
//
// ── 为什么不自己写字段，而是照抄方言表 ────────────────────────────────────
// 各家"关思考"的写法完全不同（见 `plugins/thinking-adapters/dialects.js`）：
//   deepseek / glm / anthropic → `thinking: { type: 'disabled' }`
//   qwen                       → `enable_thinking: false`
//   gemini                     → `extra_body.google.thinking_config.thinking_budget = 0`
//   openai-o / xai             → 没有干净的 off（o 系要靠 effort，跳过）
// 写错字段轻则无效、重则 400。所以这里只做**一张最小表**，并靠
// `model.thinking-detect` 拿到的 `supports.includes('off')` 决定**能不能动**。
// 拿不到方言（能力提供者不在 / 热载窗口）⇒ **一动不动**。
//
// ── 与「思考模式适配」(thinking-adapters) 的关系 ──────────────────────────
// 两者都挂 `llm.request-params`，核心按顺序串行调用、**后者覆盖前者**。
//   · `thinkingMode=auto`（当前配置）→ thinking-adapters **不动 body**（auto 不设参数）
//     ⇒ 本插件设的 disabled 会被保留。
//   · `thinkingMode=on`（用户显式要求思考）→ 本插件**主动让路**，不干预。
//   · `thinkingMode=off` → 它已经关了，本插件设不设都一样（幂等）。
// 所以不会打架，也不需要约定顺序。
//
// ── 安全底线 ──────────────────────────────────────────────────────────────
//   · 任何异常 ⇒ 原样返回 arg，本轮照常思考
//   · 判据拿不准 ⇒ 思考（见 lib/decide.js 的注释：想错的代价比省下的 token 大）
//   · 默认 enabled=true，但关掉后行为与"没装本插件"逐字节一致

import { decide, pickLatestText } from './lib/decide.js';

let apiRef = null;
let log = () => {};

/** 各方言的「关思考」写法。`omitTemperature` 那些厂商与 temperature 互斥（照 dialects.js 的口径）。 */
const OFF_PARAMS = {
  deepseek: { params: { thinking: { type: 'disabled' } }, omitTemperature: true },
  glm: { params: { thinking: { type: 'disabled' } }, omitTemperature: true },
  anthropic: { params: { thinking: { type: 'disabled' } }, omitTemperature: false },
  qwen: { params: { enable_thinking: false }, omitTemperature: false },
  gemini: { params: { extra_body: { google: { thinking_config: { thinking_budget: 0 } } } }, omitTemperature: false }
};

function cfg() {
  try {
    const raw = (apiRef && typeof apiRef.config === 'function' ? apiRef.config() : null) || {};
    return {
      enabled: raw.enabled !== false,
      maxChars: Number(raw.maxChars) > 0 ? Number(raw.maxChars) : 24,
      extraKeepWords: String(raw.extraKeepWords || ''),
      verbose: raw.verbose === true
    };
  } catch {
    return { enabled: true, maxChars: 24, extraKeepWords: '', verbose: false };
  }
}

/**
 * 取方言。优先问 `model.thinking-detect`（thinking-adapters 提供）；
 * 拿不到就返回 null ⇒ 调用方**一动不动**（宁可多思考，也不要发错参数）。
 * @returns {{dialect:string, supports:string[]}|null}
 */
function detect(arg) {
  try {
    const fn = apiRef && typeof apiRef.capability === 'function'
      ? apiRef.capability('model.thinking-detect') : null;
    if (typeof fn !== 'function') return null;
    const det = fn({ baseUrl: arg?.api?.baseUrl || '', model: arg?.api?.model || arg?.model || '' });
    if (!det || !det.dialect) return null;
    return { dialect: String(det.dialect), supports: Array.isArray(det.supports) ? det.supports : [] };
  } catch {
    return null;
  }
}

export function setup(api) {
  apiRef = api;
  log = (typeof api?.log === 'function') ? api.log.bind(api) : () => {};
  const c = cfg();
  try {
    log(`思考分级已加载（启用=${c.enabled ? '开' : '关'}，免思考上限=${c.maxChars} 字）`);
  } catch { /* 日志失败不影响主流程 */ }
}

export const providers = {
  // ⚠️ 核心传进来的是**包装对象** `{ body, api, model, messages, tools, temperature, context }`，
  //    不是裸 body（2026-10-19 那次踩过：直接当 body 用会一直空转）。
  'llm.request-params': (arg) => {
    try {
      const c = cfg();
      if (!c.enabled) return arg;
      const isWrapper = !!(arg && typeof arg === 'object' && arg.body && typeof arg.body === 'object');
      const body = isWrapper ? arg.body : arg;
      if (!body || typeof body !== 'object') return arg;

      // 用户显式要求思考（设置页 thinkingMode=on）⇒ 让路，不抢
      const userMode = String(arg?.api?.thinkingMode ?? '').trim().toLowerCase();
      if (userMode === 'on') {
        if (c.verbose) log('思考分级：跳过（设置页 thinkingMode=on）');
        return arg;
      }

      const det = detect(arg);
      if (!det) {
        if (c.verbose) log('思考分级：跳过（拿不到方言，不敢动思考参数）');
        return arg;
      }
      if (!det.supports.includes('off')) {
        if (c.verbose) log(`思考分级：跳过（方言 ${det.dialect} 不支持关闭思考）`);
        return arg;
      }
      const off = OFF_PARAMS[det.dialect];
      if (!off) {
        if (c.verbose) log(`思考分级：跳过（方言 ${det.dialect} 没有可靠的关闭写法）`);
        return arg;
      }

      const v = decide(body, c);
      if (c.verbose) log(`思考分级：${v.skip ? '免思考' : '照常思考'} —— ${v.why}`);
      if (!v.skip) return arg;

      const next = { ...body, ...off.params };
      return { body: next, omitTemperature: off.omitTemperature === true };
    } catch (error) {
      // 静默放行 —— 分级失败绝不能影响正常对话
      try { log(`思考分级出错（本次照常思考）：${error && error.message ? error.message : error}`); } catch { /* ignore */ }
    }
    return arg;
  }
};

/** 排障用：把内部函数暴露出来 */
export const internals = { pickLatestText, decide, OFF_PARAMS };
