// bili-whale / llm.js
//
// 模型通道。两条路，按设置自动选：
//   ① 宿主能力 ai.ask（装了「指令前置 / jy-command-gateway」就有）—— 不用自己配 key；
//   ② 自己的 OpenAI 兼容接口（DeepSeek / Ollama / llama-server / 任意兼容网关）。
// 都没有 → 返回 { ok:false }，调用方退化为“字幕/弹幕/热评摘要”，不会崩。
//
// 这里只负责“问一次”，提示词与解析在 analyze.js。

import { withTimeout, truncate, settings as readSettings } from './util.js';

let apiRef = null;
let logRef = () => {};

export function initLlm(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
}

function normalizeResult(r) {
  if (!r) return null;
  if (typeof r === 'string') return { text: r };
  if (typeof r === 'object') {
    if (r.ok === false) return null;
    if (typeof r.text === 'string' && r.text.trim()) return { text: r.text, model: String(r.model || ''), usage: r.usage || null };
    if (typeof r.content === 'string' && r.content.trim()) return { text: r.content };
  }
  return null;
}

/**
 * 走宿主的 `ai.ask` 能力（「指令前置 / jy-command-gateway」提供）。
 *
 * ★★ 2026-10-24 修（**这是个真 bug，不是风格问题**）：
 *   以前这里传的是 `{ system, messages }` **两个字段**，而前置服务的实现是
 *   「有 messages 就只用 messages，**system 直接忽略**」
 *   （`plugins/command-gateway/services.js:49`）⇒ 只要调用方给了 messages（本插件**全都给了**），
 *   系统提示词就被**整段丢掉**：人设卡、`ANALYZE_SYSTEM` 的"只输出 JSON"、
 *   `COMMENT_VIDEO_SYSTEM` 的"不许 @"、防注入红线 —— 一条都没进模型。
 *   表现就是"评分老是解析失败退回启发式 / 评论写成广告腔 / 说人设卡不生效"。
 *   修法：把**已经拼好 system 的 list** 传进去（`ask()` 里本来就拼了），只传 `messages` 一个字段。
 */
async function askCapability({ messages, temperature, maxTokens }) {
  const call = apiRef?.capability;
  if (typeof call !== 'function') return null;
  try {
    const r = await withTimeout(
      Promise.resolve(call('ai.ask', { messages, temperature, maxTokens })),
      70_000, '宿主 ai.ask'
    );
    return normalizeResult(r);
  } catch (error) {
    logRef(`ai.ask 通道不可用：${String(error?.message ?? error).slice(0, 120)}`);
    return null;
  }
}

function endpointOf(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

async function askOwn(s, { messages, temperature, maxTokens }) {
  if (!s?.llmBaseUrl || !s?.llmModel) return null;
  const url = endpointOf(s.llmBaseUrl);
  const body = {
    model: s.llmModel,
    messages,
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : s.llmTemperature,
    max_tokens: Math.max(64, Number(maxTokens) || s.llmMaxTokens),
    stream: false
  };
  const headers = { 'content-type': 'application/json' };
  if (s.llmApiKey) headers.authorization = `Bearer ${s.llmApiKey}`;
  try {
    const res = await withTimeout(fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(65_000)
    }), 70_000, '模型接口');
    const text = await res.text();
    if (!res.ok) {
      logRef(`自带模型接口 HTTP ${res.status}：${truncate(text, 160)}`);
      return null;
    }
    let data = null;
    try { data = JSON.parse(text); } catch { return null; }
    const content = data?.choices?.[0]?.message?.content
      ?? data?.choices?.[0]?.text
      ?? data?.message?.content
      ?? '';
    if (!String(content).trim()) return null;
    return { text: String(content), model: String(data.model || s.llmModel), usage: data.usage || null };
  } catch (error) {
    logRef(`自带模型接口失败：${String(error?.message ?? error).slice(0, 140)}`);
    return null;
  }
}

/**
 * 问一次模型。
 * @returns {Promise<{ok:boolean, text:string, source:string, model?:string, error?:string}>}
 */
export async function ask(api, { system = '', messages = [], temperature, maxTokens } = {}) {
  if (api) apiRef = api;
  const s = readSettings(apiRef);
  if (s.llmMode === 'off') return { ok: false, text: '', source: 'off', error: '模型通道已关闭' };
  const list = Array.isArray(messages) && messages.length
    ? messages.map((m) => ({ role: String(m?.role || 'user'), content: String(m?.content ?? '') })).filter((m) => m.content)
    : [{ role: 'user', content: '' }];
  if (system) list.unshift({ role: 'system', content: String(system) });
  if (!list.length || !list[list.length - 1].content) {
    return { ok: false, text: '', source: 'none', error: '提示词为空' };
  }

  if (s.llmMode === 'auto' || s.llmMode === 'capability') {
    // ⚠️ 传 `list`（已含 system 那一条），**不是** `messages` + 单独的 system —— 见 askCapability 的注释
    const r = await askCapability({ messages: list, temperature, maxTokens });
    if (r?.text) return { ok: true, text: r.text, source: 'ai.ask', model: r.model || '', usage: r.usage || null };
    if (s.llmMode === 'capability') {
      return { ok: false, text: '', source: 'ai.ask', error: '宿主 ai.ask 不可用（确认「指令前置」已装并启用）' };
    }
  }

  if (s.llmMode === 'auto' || s.llmMode === 'own') {
    const r = await askOwn(s, { messages: list, temperature, maxTokens });
    if (r?.text) return { ok: true, text: r.text, source: 'own', model: r.model || '', usage: r.usage || null };
  }

  return { ok: false, text: '', source: 'none', error: '没有可用的模型通道（ai.ask 不可用，且未配置 OpenAI 兼容接口）' };
}
