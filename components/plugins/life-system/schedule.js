// 时间事件解析与匹配：周周期、一次性未来预设、最多五节点事件链。

const DAY_SET = new Set([0, 1, 2, 3, 4, 5, 6]);
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const asText = (v) => String(v ?? '').trim();

export function timeToMinutes(value) {
  const s = asText(value);
  if (!TIME_RE.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function normalizeDays(value) {
  if (value == null || value === '') return [...ALL_DAYS];
  if (!Array.isArray(value) || !value.length) return null;
  const days = [...new Set(value.map(Number))].sort((a, b) => a - b);
  return days.every((d) => Number.isInteger(d) && DAY_SET.has(d)) ? days : null;
}

function parseRaw(raw) {
  if (Array.isArray(raw)) return raw;
  const text = asText(raw);
  if (!text) return [];
  const value = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error('时间事件必须是 JSON 数组');
  return value;
}

function validGroup(group) { return /^[a-z][a-z0-9_-]{0,31}$/.test(group); }
function validText(text) { return text && text.length <= 120; }
function parseDate(value) {
  const text = asText(value);
  if (!ISO_RE.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function overlap(a, b) {
  if (!a.days.some((d) => b.days.includes(d))) return false;
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function parseWeekly(item, prefix, errors) {
  const id = asText(item.id);
  const days = normalizeDays(item.days);
  const startMin = timeToMinutes(item.start);
  const endMin = timeToMinutes(item.end);
  const group = asText(item.group || 'misc').toLowerCase();
  const text = asText(item.summary || item.text);
  if (!days) errors.push(`${prefix} days 必须是 0~6 的非空数组（0=周日）`);
  if (startMin == null) errors.push(`${prefix} start 必须是 HH:MM`);
  if (endMin == null) errors.push(`${prefix} end 必须是 HH:MM`);
  if (startMin != null && endMin != null && endMin <= startMin) errors.push(`${prefix} 不支持跨午夜或零长度时段`);
  if (!validGroup(group)) errors.push(`${prefix} group 必须是英文分组名`);
  if (!validText(text)) errors.push(`${prefix} text 不能为空且最多 120 字`);
  if (!days || startMin == null || endMin == null || endMin <= startMin || !validGroup(group) || !validText(text)) return null;
  return { id, type: 'weekly', days, start: asText(item.start), end: asText(item.end), startMin, endMin, group, text, priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100 };
}

function parsePreset(item, prefix, errors) {
  const id = asText(item.id); const group = asText(item.group || 'misc').toLowerCase(); const text = asText(item.summary || item.text);
  const startMs = parseDate(item.startAt); const endMs = parseDate(item.endAt);
  if (startMs == null) errors.push(`${prefix} startAt 必须是带时区的 ISO 时间`);
  if (endMs == null) errors.push(`${prefix} endAt 必须是带时区的 ISO 时间`);
  if (startMs != null && endMs != null && endMs <= startMs) errors.push(`${prefix} endAt 必须晚于 startAt`);
  if (!validGroup(group)) errors.push(`${prefix} group 必须是英文分组名`);
  if (!validText(text)) errors.push(`${prefix} text 不能为空且最多 120 字`);
  if (startMs == null || endMs == null || endMs <= startMs || !validGroup(group) || !validText(text)) return null;
  return { id, type: 'preset', startAt: asText(item.startAt), endAt: asText(item.endAt), startMs, endMs, group, text, priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100 };
}

function parseChain(item, prefix, errors) {
  const id = asText(item.id); const group = asText(item.group || 'misc').toLowerCase(); const startMs = parseDate(item.startAt); const rawNodes = Array.isArray(item.nodes) ? item.nodes : [];
  if (startMs == null) errors.push(`${prefix} startAt 必须是带时区的 ISO 时间`);
  if (!rawNodes.length || rawNodes.length > 5) errors.push(`${prefix} 节点数量必须是 1~5`);
  if (!validGroup(group)) errors.push(`${prefix} group 必须是英文分组名`);
  const nodes = [];
  rawNodes.slice(0, 5).forEach((node, i) => {
    const text = asText(node?.summary || node?.text); const durationMin = Number(node?.durationMin); const countdownMin = Number(node?.countdownMin ?? 0);
    if (!validText(text)) errors.push(`${prefix} 第 ${i + 1} 个节点内容不能为空且最多 120 字`);
    if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > 10080) errors.push(`${prefix} 第 ${i + 1} 个节点持续时间必须是 1~10080 分钟`);
    if (!Number.isInteger(countdownMin) || countdownMin < 0 || countdownMin > 10080) errors.push(`${prefix} 第 ${i + 1} 个倒计时必须是 0~10080 分钟`);
    nodes.push({ text, durationMin, countdownMin });
  });
  if (startMs == null || !rawNodes.length || rawNodes.length > 5 || !validGroup(group) || nodes.some((n) => !validText(n.text) || !Number.isInteger(n.durationMin) || n.durationMin <= 0 || !Number.isInteger(n.countdownMin) || n.countdownMin < 0)) return null;
  const totalMin = nodes.reduce((sum, n) => sum + n.durationMin + n.countdownMin, 0) - nodes[nodes.length - 1].countdownMin;
  return { id, type: 'chain', startAt: asText(item.startAt), startMs, group, nodes, totalMin, endMs: startMs + totalMin * 60000, priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 100 };
}

export function parseScheduledEvents(raw) {
  const errors = []; let list;
  try { list = parseRaw(raw); } catch (error) { return { ok: false, events: [], errors: [error?.message || '时间事件 JSON 无法解析'] }; }
  const events = []; const ids = new Set(); const weekly = []; const timed = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]; const prefix = `第 ${i + 1} 条`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${prefix}必须是对象`); continue; }
    const id = asText(item.id); if (!ID_RE.test(id)) errors.push(`${prefix} id 不合法`); else if (ids.has(id)) errors.push(`${prefix} id 重复：${id}`); ids.add(id);
    const type = asText(item.type || 'weekly').toLowerCase();
    let parsed = type === 'preset' ? parsePreset(item, prefix, errors) : type === 'chain' ? parseChain(item, prefix, errors) : type === 'weekly' ? parseWeekly(item, prefix, errors) : (errors.push(`${prefix} type 只能是 weekly、preset 或 chain`), null);
    if (parsed) { events.push(parsed); if (parsed.type === 'weekly') weekly.push(parsed); else timed.push(parsed); }
  }
  for (let i = 0; i < weekly.length; i += 1) for (let j = i + 1; j < weekly.length; j += 1) if (overlap(weekly[i], weekly[j])) errors.push(`时段冲突：${weekly[i].id} ${weekly[i].start}-${weekly[i].end} 与 ${weekly[j].id} ${weekly[j].start}-${weekly[j].end}`);
  for (let i = 0; i < timed.length; i += 1) for (let j = i + 1; j < timed.length; j += 1) if (timed[i].startMs < timed[j].endMs && timed[j].startMs < timed[i].endMs) errors.push(`时段冲突：${timed[i].id} 与 ${timed[j].id}`);
  return { ok: errors.length === 0, events: errors.length ? [] : events, errors };
}

function chainAt(event, nowMs) {
  if (nowMs < event.startMs || nowMs >= event.endMs) return null;
  let cursor = event.startMs;
  for (let i = 0; i < event.nodes.length; i += 1) {
    const node = event.nodes[i]; const nodeEnd = cursor + node.durationMin * 60000;
    if (nowMs < nodeEnd) return { ...event, state: 'active', nodeIndex: i, nodeCount: event.nodes.length, text: node.text, node, startMs: cursor, endMs: nodeEnd };
    cursor = nodeEnd;
    if (i < event.nodes.length - 1) {
      const nextStart = cursor + node.countdownMin * 60000;
      if (nowMs < nextStart) return { ...event, state: 'countdown', nodeIndex: i, nodeCount: event.nodes.length, text: node.text, node, startMs: cursor, endMs: nextStart, nextStartMs: nextStart, countdownRemainingMin: Math.ceil((nextStart - nowMs) / 60000) };
      cursor = nextStart;
    }
  }
  return null;
}

export function activeScheduledEvents(raw, date = new Date()) {
  const parsed = parseScheduledEvents(raw); if (!parsed.ok) return { parsed, active: [] };
  const nowMs = date instanceof Date ? date.getTime() : Number(date);
  const day = new Date(nowMs).getDay(); const minute = new Date(nowMs).getHours() * 60 + new Date(nowMs).getMinutes(); const active = [];
  for (const event of parsed.events) {
    if (event.type === 'weekly' && event.days.includes(day) && minute >= event.startMin && minute < event.endMin) active.push({ ...event, state: 'active' });
    else if (event.type === 'preset' && nowMs >= event.startMs && nowMs < event.endMs) active.push({ ...event, state: 'active' });
    else if (event.type === 'chain') { const current = chainAt(event, nowMs); if (current) active.push(current); }
  }
  active.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { parsed, active };
}

export const __test = { normalizeDays, overlap, parseRaw, chainAt };

