// 事件输入规范化：只做本地、可重复的整理，不在每轮对话中调用模型。
// 复杂内容不会被擅自截断，而是标记为 pending，等待用户确认摘要。

export const MAX_RAW_LENGTH = 2000;
export const MAX_SUMMARY_LENGTH = 80;

const DIALOGUE_RE = /[“”"「」『』]|(?:^|\n)\s*(?:我|你|他|她|角色|旁白)\s*[：:]/;
const STORY_RE = /(?:后来|然后|接着|第二天|第二天|过了一会儿|与此同时|最后|于是)/;
const FUTURE_RE = /(?:将要|准备|打算|计划|下周|明天|以后|稍后|待会)/;
const CURRENT_RE = /(?:正在|目前|现在|此刻|今天|当下)/;

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sentenceParts(text) {
  return text.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
}

function compactSummary(text) {
  const parts = sentenceParts(text);
  const first = parts[0] || text;
  return cleanText(first).slice(0, MAX_SUMMARY_LENGTH);
}

export function classifyEventText(raw) {
  const text = cleanText(raw);
  if (!text) return { kind: 'empty', complex: false };
  const complex = text.length > 120 || DIALOGUE_RE.test(text) || STORY_RE.test(text) || partsCount(text) > 2;
  const timeRelation = FUTURE_RE.test(text) ? 'future' : CURRENT_RE.test(text) ? 'current' : 'past';
  return { kind: complex ? 'story' : 'state', complex, timeRelation };
}

function partsCount(text) {
  return sentenceParts(text).length;
}

/**
 * 生成事件的本地规范结果。
 * 短状态自动 ready；长对话/故事只保留原文并 pending，避免错误截断。
 */
export function normalizeEventInput(input = {}) {
  const raw = cleanText(input.raw ?? input.text);
  const group = cleanText(input.group || 'misc').toLowerCase() || 'misc';
  const base = {
    id: cleanText(input.id),
    group,
    raw: raw.slice(0, MAX_RAW_LENGTH),
    summary: cleanText(input.summary).slice(0, MAX_SUMMARY_LENGTH),
    timeRelation: cleanText(input.timeRelation),
    weight: Number.isFinite(Number(input.weight)) ? Math.max(1, Math.min(10, Number(input.weight))) : 1,
    cooldownH: Number.isFinite(Number(input.cooldownH)) ? Math.max(0, Math.min(720, Number(input.cooldownH))) : 72,
    enabled: input.enabled !== false,
    status: 'pending'
  };
  if (!raw) return { ...base, status: 'invalid', errors: ['事件原文不能为空'] };
  if (raw.length > MAX_RAW_LENGTH) return { ...base, status: 'invalid', errors: [`事件原文最多 ${MAX_RAW_LENGTH} 字`] };
  const kind = classifyEventText(raw);
  if (base.summary) {
    return { ...base, summary: base.summary, timeRelation: base.timeRelation || kind.timeRelation, status: 'ready', errors: [] };
  }
  if (!kind.complex && raw.length <= MAX_SUMMARY_LENGTH) {
    return { ...base, summary: raw, timeRelation: kind.timeRelation, status: 'ready', errors: [] };
  }
  return { ...base, summary: '', timeRelation: kind.timeRelation, status: 'pending', errors: ['内容较长或包含故事/对白，请确认一条短状态摘要'] };
}

export function legacyPoolItems(value) {
  return String(value || '').split('\n').map((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return null;
    const match = /^([a-z][a-z0-9_-]{0,31})\s*[:：|]\s*(.+)$/i.exec(text);
    const group = match ? match[1].toLowerCase() : 'misc';
    const raw = (match ? match[2] : text).trim();
    return normalizeEventInput({ id: `legacy-${index + 1}`, group, raw, weight: 1, cooldownH: 72 });
  }).filter(Boolean);
}

export function parsePoolItemsDetailed(value, legacy = '') {
  let list = [];
  const errors = [];
  const hasStructured = Array.isArray(value) || (value != null && String(value).trim() !== '');
  try {
    const raw = Array.isArray(value) ? value : JSON.parse(String(value || '[]'));
    if (!Array.isArray(raw)) errors.push('规范化随机事件必须是 JSON 数组');
    else list = raw.map((item) => normalizeEventInput(item));
  } catch (error) {
    errors.push(`规范化随机事件 JSON 解析失败：${error?.message || error}`);
  }
  if (list.length) return { items: list, errors };
  if (hasStructured && errors.length) return { items: [], errors };
  return { items: legacyPoolItems(legacy), errors };
}

export function parsePoolItems(value, legacy = '') {
  return parsePoolItemsDetailed(value, legacy).items;
}

export const __test = { cleanText, sentenceParts, compactSummary };
