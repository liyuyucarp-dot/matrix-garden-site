// bili-whale / notify.js
//
// 把“她做了什么”送回 QQ。三条通道，按可用性依次降级：
//   ① 从钩子/工具 ctx 捕获到的宿主 sender（限频、去重、留档全走核心原管道）；
//   ② 设置里的 OneBot HTTP 地址（进程刚起、还没收到任何 QQ 消息时的兜底）；
//   ③ 都不可用 → 写进 outbox，等下一次收到消息、接到 sender 时自动补发。
//
// 每天有推送上限（maxNotifyPerDay），避免变成刷屏机。所有正文都截断，绝不带 cookie。

import { getDb, markDirty, queueOutbox, addEvent } from './store.js';
import { todayKey, truncate, settings as readSettings } from './util.js';

let apiRef = null;
let logRef = () => {};
const channels = { sender: null, onebot: null, store: null };
let flushing = false;

export function initNotify(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
  // ⓪ services 通道（2026-10-24，§3.1 收尾）：进程刚起、还没收到任何 QQ 消息时，
  //    ctx 捕获拿不到 sender —— 但 services 里有。接到后 ② 的 OneBot HTTP 兜底
  //    就只作为 services 未就绪时的降级路径（范式与 silence-ping 一致）。
  try {
    const svc = api?.services?.();
    if (svc?.sender?.sendTextBatch && channels.sender !== svc.sender) { channels.sender = svc.sender; changedNote(); }
  } catch { /* services 未就绪：等 adoptChannels / 下次 initNotify */ }
  function changedNote() { try { flushOutbox().catch(() => {}); } catch { /* ignore */ } }
}

/** 从 onMessage / 工具 execute 的 ctx 里接住宿主发送能力。 */
export function adoptChannels(ctx) {
  try {
    if (!ctx || typeof ctx !== 'object') return false;
    let changed = false;
    if (ctx.sender?.sendTextBatch && channels.sender !== ctx.sender) { channels.sender = ctx.sender; changed = true; }
    if (ctx.onebot && (typeof ctx.onebot.sendSegments === 'function' || typeof ctx.onebot.call === 'function') && channels.onebot !== ctx.onebot) {
      channels.onebot = ctx.onebot; changed = true;
    }
    if (ctx.store && channels.store !== ctx.store) { channels.store = ctx.store; changed = true; }
    if (changed) flushOutbox().catch(() => {});
    return changed;
  } catch { return false; }
}

export function hasChannel() {
  return Boolean(channels.sender?.sendTextBatch);
}

/**
 * 把一段内容写进**她自己的**历史（只记账、不发送）。
 *
 * 2026-10-21 新增。用宿主的 store.appendSelf —— 它会给消息打 self:true/read:true，
 * 写进 data/messages/<chatKey>.json，于是下次组装 prompt 时这段就在她的上下文里，
 * 她能自然提起"我早上刷到…"，而不是只看见一条别人转述的报告。
 *
 * 依赖 channels.store（由 onMessage 的 ctx 捕获）。进程刚起、还没收到任何消息时
 * 拿不到 store，此时返回 false，调用方静默跳过即可。
 */
export function appendToHistory(s, text) {
  const st = channels.store;
  if (!st || typeof st.appendSelf !== 'function') return false;
  const chat = defaultChat(s);
  if (!chat) return false;
  const body = sanitize(text);
  if (!body) return false;
  try {
    st.appendSelf(chat, { text: body, ts: Date.now() });
    return true;
  } catch {
    return false;
  }
}

export function defaultChat(s) {
  const explicit = String(s?.notifyChat || '').trim();
  if (/^(private|group):\d{5,15}$/.test(explicit)) return explicit;
  const qq = Array.isArray(s?.ownerQQ) ? s.ownerQQ[0] : '';
  return qq ? `private:${qq}` : '';
}

export function parseChat(chatKey) {
  const m = String(chatKey || '').match(/^(private|group):(\d{5,15})$/);
  if (!m) return null;
  return { kind: m[1], id: m[2] };
}

function sanitize(text) {
  return truncate(String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim(), 3500);
}

async function sendViaHost(sender, chatKey, text) {
  const r = await sender.sendTextBatch(chatKey, [text]);
  const sent = Array.isArray(r?.sent) ? r.sent.length : (r?.ok === false ? 0 : 1);
  if (!sent) {
    const why = r?.failed ? JSON.stringify(r.failed).slice(0, 140) : '宿主发送队列没有返回成功';
    throw new Error(why);
  }
  return true;
}

async function sendViaHttp(s, chatKey, text) {
  const base = String(s?.onebotHttpUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('没有配置 OneBot HTTP 地址');
  const chat = parseChat(chatKey);
  if (!chat) throw new Error(`会话地址不合法：${chatKey}`);
  const action = chat.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const params = chat.kind === 'group'
    ? { group_id: Number(chat.id), message: text, auto_escape: true }
    : { user_id: Number(chat.id), message: text, auto_escape: true };
  const headers = { 'content-type': 'application/json' };
  if (s.onebotHttpToken) headers.authorization = `Bearer ${s.onebotHttpToken}`;
  const res = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 有些实现只回空 */ }
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}：${truncate(raw, 120)}`);
  if (data && data.status && data.status !== 'ok') throw new Error(`OneBot 返回 ${data.status}：${truncate(raw, 120)}`);
  return true;
}

/**
 * 发一条文本给指定会话。不经过每日上限（低层）。
 * @returns {Promise<{ok:boolean, via:string, error?:string}>}
 */
export async function sendText(s, text, { chatKey = '' } = {}) {
  const body = sanitize(text);
  if (!body) return { ok: false, via: 'none', error: '正文为空' };
  const target = String(chatKey || defaultChat(s));
  if (!target) return { ok: false, via: 'none', error: '没有可推送的会话（填 ownerQQ 或 notifyChat）' };

  if (channels.sender?.sendTextBatch) {
    try {
      await sendViaHost(channels.sender, target, body);
      return { ok: true, via: 'host' };
    } catch (error) {
      logRef(`宿主 sender 发送失败，尝试 OneBot HTTP：${truncate(error?.message ?? error, 120)}`);
    }
  }
  if (s.onebotHttpUrl) {
    try {
      await sendViaHttp(s, target, body);
      return { ok: true, via: 'http' };
    } catch (error) {
      queueOutbox(body);
      addEvent('notify-failed', `${truncate(error?.message ?? error, 160)}（已放 outbox）`);
      return { ok: false, via: 'http', error: String(error?.message ?? error) };
    }
  }
  queueOutbox(body);
  addEvent('notify-queued', `还没有发送通道（${target}），已放 outbox`);
  return { ok: false, via: 'queued', error: '还没有发送通道，已排队等首条消息到达后补发' };
}

/** 受每日上限约束的“主动推送”。 */
export async function notify(s, text, { kind = 'notice', force = false, chatKey = '' } = {}) {
  const body = sanitize(text);
  if (!body) return { ok: false, skipped: true, reason: '正文为空' };
  const db = getDb();
  const day = todayKey(s);
  if (!db.notify || typeof db.notify !== 'object') db.notify = { date: day, count: 0, lastAt: 0 };
  if (db.notify.date !== day) db.notify = { date: day, count: 0, lastAt: 0 };
  const max = Math.max(0, Number(s.maxNotifyPerDay) || 0);
  if (!force && db.notify.count >= max) {
    addEvent('notify-skipped', `今日推送已达上限 ${max}（${kind}）`);
    return { ok: false, skipped: true, reason: max === 0 ? '今日推送上限是 0（关掉了主动推送）' : `今日推送已达上限 ${max}` };
  }
  const r = await sendText(s, `【B站鲸鱼】\n${body}`, { chatKey });
  if (r.ok) {
    db.notify.count += 1;
    db.notify.lastAt = Date.now();
    markDirty();
    addEvent('notify', `${kind} · ${truncate(body, 80)}`);
  }
  return r;
}

/**
 * 发一张图（封面等）。走宿主的 sendMedia；失败静默，不影响正文。
 */
export async function sendImage(s, url, { chatKey = '' } = {}) {
  const target = String(chatKey || defaultChat(s));
  const src = String(url || '').trim();
  if (!target || !/^https?:\/\//i.test(src)) return { ok: false, error: '没有图片地址或会话' };
  if (channels.sender?.sendMedia) {
    try {
      await channels.sender.sendMedia(target, [{ type: 'image', data: { file: src } }], { label: '[B站封面]' });
      return { ok: true, via: 'host' };
    } catch (error) {
      logRef(`封面发送失败：${truncate(error?.message ?? error, 100)}`);
    }
  }
  if (s.onebotHttpUrl) {
    try {
      const chat = parseChat(target);
      if (!chat) throw new Error('会话地址不合法');
      const action = chat.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params = chat.kind === 'group'
        ? { group_id: Number(chat.id), message: [{ type: 'image', data: { file: src } }] }
        : { user_id: Number(chat.id), message: [{ type: 'image', data: { file: src } }] };
      const headers = { 'content-type': 'application/json' };
      if (s.onebotHttpToken) headers.authorization = `Bearer ${s.onebotHttpToken}`;
      const res = await fetch(`${s.onebotHttpUrl}/${action}`, { method: 'POST', headers, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, via: 'http' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
  return { ok: false, error: '没有发送通道' };
}

/** 接到宿主 sender 后，把之前排队的消息补发掉。 */
export async function flushOutbox() {
  if (flushing || !channels.sender?.sendTextBatch) return;
  const db = getDb();
  if (!Array.isArray(db.outbox) || !db.outbox.length) return;
  flushing = true;
  try {
    const items = db.outbox.slice();
    db.outbox = [];
    markDirty();
    const s = readSettings(apiRef);
    const target = defaultChat(s);
    for (const item of items) {
      try {
        await sendViaHost(channels.sender, target, sanitize(item.text));
        addEvent('notify-flushed', truncate(item.text, 70));
      } catch (error) {
        db.outbox.push(item);
        addEvent('notify-flush-failed', truncate(error?.message ?? error, 100));
      }
    }
    markDirty();
  } finally {
    flushing = false;
  }
}
