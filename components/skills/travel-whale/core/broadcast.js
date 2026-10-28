// 矩阵庭院（travel-whale）· 模块化组件：core/broadcast.js
// 职责：「家」与明信片多群扇出投递（BROADCAST）、面板防刷屏与 UI 通知

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../../../src/config.js';
import { RT, cfg, log } from './runtime-deps.js';

// ── 发送 ──────────────────────────────────────────────────────────────────

// ── 「家」与明信片投递名单（BROADCAST，2026-10-10 用户需求）──────────────────
//
// 原设计：**每个会话各养一只鲸鱼**，各走各的（存档 `chats/<chatKey>.json`），
//         各寄各的明信片。用户要把它拆开：
//           "我希望「寄明信片」和「养鲸鱼」这两个功能可以分开 —— 明信片可以
//            同时寄给多个不同的群和个人，但鲸鱼在一个群养就好。"
//
// 所以现在：
//   · `homeChatKey` —— **唯一**养鲸鱼的会话（服务器/钱包/图鉴/称号都在它身上）。
//                      tick 只推进它；别处调养鲸鱼类工具只会得到一句"窝在哪儿"。
//   · `cardTargets` —— 这趟旅行寄出的明信片（含出发/到家播报）**投递到哪儿**。
//                      多个群、多个私聊都行；留空 = 只发回「家」（＝改造前的行为）。
//
// 实现上只在**发送层**做扇出（say / sayImage）—— 那一层正好是"旅行自己发的消息"，
// 而工具回执走的是另一条路（replyPanel，用 ctx.sender），所以不会被误广播。

/** 归一化一个会话标识：`123456789` / `群:123456789` / `group:123456789` 都收。 */
export function normChat(raw, defKind = 'group') {  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(群|group|g)\s*[:：]/, 'group:').replace(/^(私|好友|private|p)\s*[:：]/, 'private:');
  if (/^(group|private):/.test(s)) return s;
  return `${defKind}:${s}`;
}

/** 「家」= 养鲸鱼的那个会话。没配 → 返回 ''（退回"每个群各养一只"的老行为）。 */
export function homeKey() {
  return normChat(cfg()?.homeChatKey, 'group');
}

/** 明信片投递名单（一定含「家」，且去重）。 */
export function cardTargets() {
  const home = homeKey();
  const raw = cfg()?.cardTargets;
  const list = String(raw ?? '')
    .split(/[\r\n,，、;；|]+/).map((x) => normChat(x, 'group')).filter(Boolean);
  const out = [];
  for (const k of [home, ...list]) if (k && !out.includes(k)) out.push(k);
  return out;
}

/**
 * 播报分类（2026-10-21 用户需求：「仅出门、归家、明信片和题词播报到白名单；
 * 购买、邀请、成就等系统信息不再播报，避免刷屏」）。
 *
 * `opts.kind` 只有两个合法值：
 *   · `'journey'` —— 出门播报 / 归家播报 / 明信片（途中卡 + 到家卡）/ 题词（含留守旅伴的评论）
 *                   ⇒ 按 `cardTargets()` 白名单扇出（**含「家」**）；
 *   · `'system'`  —— 购买 / 邀请换旅伴 / 称号成就 / 每日津贴 / 庭院大合照 / 打工与收成 / 其它回执
 *                   ⇒ **只发 `chatKey` 本身**，不扇出。
 *
 * ⚠️⚠️ **默认必须是 `'system'`**：将来新加发送点忘了标，最坏结果是"少了一次群发"，
 *    而不是"又刷屏了"。所以只有那 4 类调用点**显式写** `{ kind: 'journey' }`。
 * ⚠️ 别把它和 `broadcast:false` 混起来：那个是"手动索要 ⇒ 连本会话之外都不发"，
 *    语义完全不同（见 `fanoutTargets` 里那段注释）；两者同时出现时 `broadcast:false` 优先。
 */
export const SAY_KINDS = ['journey', 'system'];

/** 从 `opts` 里取合法的 kind；取不到/脏值一律 `'system'`。 */
export function sayKindOf(opts) {
  const k = String(opts?.kind ?? '').trim();
  return SAY_KINDS.includes(k) ? k : 'system';
}

/**
 * `state.pending` 里一条压住的播报该按哪一类补发。
 *
 * ⚠️⚠️ **`pending` 里早就有一个 `kind` 了**（`'return'` / `'side-return'` / `'labelroom-off'`，
 *    表示"这是哪一种待补发事项"），所以广播分类**不能**也叫 `kind` —— 会直接打架。
 *    这里用 `sayKind` 这个名字（= 它最终喂给 `say(..., { kind })` 的那个值）。
 *
 * 老存档兼容：升级前入队的条目**没有 `sayKind`** ⇒
 *   · `return` / `side-return` ＝ 明信片 + 出发/到家播报 ⇒ 按 `'journey'`
 *     （不能因为升级把它们变成"只发回家"或者干脆不发）；
 *   · 其余（如 `labelroom-off` 车间下班）本来就不是明信片 ⇒ `'system'`。
 */
export function pendingSayKind(item) {
  const k = String(item?.sayKind ?? '').trim();
  if (SAY_KINDS.includes(k)) return k;
  const legacy = String(item?.kind ?? '').trim();
  return (legacy === 'return' || legacy === 'side-return') ? 'journey' : 'system';
}

/**
 * 这次发送实际要落到哪些会话。
 * 非「家」的发送只有它自己（保底：万一以后别处也能主动发，不会误广播）。
 *
 * @param {string} chatKey 发送源会话
 * @param {boolean} [broadcast=true] 手动索要时传 false（只发 chatKey）
 * @param {'journey'|'system'} [kind='system'] 见 `SAY_KINDS`；只有 journey 才走投递名单
 */
export function fanoutTargets(chatKey, broadcast = true, kind = 'system') {
  const key = String(chatKey || '');
  if (!key) return [];
  // ★★ 2026-10-14 「手动索要」不扇出（用户报的 bug）：
  //   投递＝分发（她自己旅行寄回来的，投递名单里大家都该看到），
  //   但**某个会话里有人开口要**（加急寄一张 / 补发那张）—— 那是**那个会话**要看，
  //   不是所有人都要看。所以由调用方显式传 `broadcast:false`。
  //   自动路径（她自己寄片 / 出发到家播报）一律保持默认扇出 —— 但**只有 journey 那几类**，
  //   2026-10-21 之前这里没有 kind 这道闸，所以大合照 / 每日津贴也一起群发了。
  if (broadcast === false) return [key];
  // ★★ 2026-10-21「播报分类」：单一出口，按 kind 决定目标 —— 别在每个调用点各写一遍分支。
  if (kind !== 'journey') return [key];
  const home = homeKey();
  if (!home || key !== home) return [key];
  return cardTargets();
}

/** 群名（读宿主的 data/group-names.json；查不到就退回裸号）。 */
export function groupLabel(chatKey) {
  const key = String(chatKey || '');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'group-names.json'), 'utf8'));
    const name = String(j?.[key] || '').trim();
    if (name) return name;
  } catch { /* 没这个文件就算了 */ }
  return key.replace(/^(group|private):/, '');
}

/**
 * 往会话里发一条文本（走核心发送队列：自带限频/去重/留档）。
 * ★ 2026-10-21：只有 `opts.kind === 'journey'` 才会在「家」扇出到投递名单，
 *   其余（含默认）只发 `chatKey` 本身 —— 见 `SAY_KINDS` 那段说明。
 */
/**
 * ★ 2026-10-28（P6）：全局主动消息限流。
 *
 * 拿不到 `courtyard.limit`（插件单独安装）→ **一律放行**，行为与加这层之前逐字一致。
 * 限流器自身抛错也放行 —— 基础设施只能更克制，不能让她该说话时说不出话。
 */
function proactiveGate(chatKey) {
  let rl = null;
  try { rl = globalThis.__courtyardInfra?.limiter || null; } catch { rl = null; }
  if (!rl || typeof rl.take !== 'function') return { ok: true, degraded: true };
  try {
    const r = rl.take({ chatKey: String(chatKey || 'travel-whale'), proactive: true });
    return r && r.allowed === false
      ? { ok: false, reason: r.reason || '主动消息额度已用完' }
      : { ok: true };
  } catch {
    return { ok: true, degraded: true };
  }
}

/** 后台自主播报（明信片 / 出发到家 / 旅伴自己说话）—— 走全局限流。工具回话请直接用 say。 */
export async function sayP(chatKey, text, opts = {}) {
  return say(chatKey, text, { ...opts, proactive: true });
}

/** 同上，发图版。 */
export async function sayImageP(chatKey, file, opts = {}) {
  return sayImage(chatKey, file, { ...opts, proactive: true });
}

export async function say(chatKey, text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (!RT.services?.sender?.sendTextBatch) {
    log('[travel-whale] 发送队列不可用，本条跳过');
    return false;
  }
  // ★ 2026-10-28（P6）：**自主**播报要先过全局主动限流。
  //   为什么按 opts.proactive 区分而不是全都限：say() 同时被"工具回话"（模型响应群友）
  //   和"后台自己说话"（明信片/出发到家播报）复用。限前者会让她该说话时闭嘴，
  //   所以只在后台调用点（sayP 包装）打这个标记。
  if (opts.proactive === true) {
    const verdict = proactiveGate(chatKey);
    if (!verdict.ok) { log(`[travel-whale] 全局限流拦住一条自主播报：${verdict.reason}`); return false; }
  }
  let any = false;
  const kind = sayKindOf(opts);
  let firstFan = true;
  for (const to of fanoutTargets(chatKey, opts.broadcast !== false, kind)) {
    // 多目标零间隔连发是明显的风控指纹 —— 首个目标之后逐条随机退避 2~4.5s
    if (!firstFan) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2500));
    firstFan = false;
    try { await RT.services.sender.sendTextBatch(to, [t]); any = true; }
    catch (error) { log(`[travel-whale] 发往 ${to} 失败：${error?.message ?? error}`); }
  }
  return any;
}

// ★★ 2026-10-14「同一轮最多一页面板」的记账（配套 replyPanel，见下方注释）。
//   只记"当前这次唤醒"，会话一换自动归零 ⇒ 不会跨轮误伤，也不会无限增长。
let panelTurnId = '';
let panelTurnSent = false;

/** 这次唤醒的"直发额度"是不是已经用掉了。 */
export function panelSlotUsed(ctx) {
  const sid = String(ctx?.session?.id || '');
  if (!sid) return false;                       // 拿不到会话 ⇒ 不限制
  if (sid !== panelTurnId) { panelTurnId = sid; panelTurnSent = false; }
  return panelTurnSent;
}

/** 真的发出去之后才记账。 */
export function markPanelSent(ctx) {
  const sid = String(ctx?.session?.id || '');
  if (!sid) return;
  if (sid !== panelTurnId) { panelTurnId = sid; }
  panelTurnSent = true;
}

/**
 * 把"列表 / 面板"型结果**直接发到群里**，而不是当作资料回给模型。
 *
 * ⚠️ 为什么必须这样：模型拿到工具结果后，会**用自己的语气重新措辞** —— 实测问
 *    「看一下商店」，它把整张价目表压缩成了 4 句短消息（人设是"1~10 字、像真人"），
 *    用户根本看不到货架和价格。凡是"用户要的就是这份清单"的场景，都得绕过模型直接发。
 *    发不出去时才退回给模型，宁可它转述也不能什么都不发。
 */
export async function replyPanel(ctx, text) {
  const t = String(text ?? '').trim();
  if (!t) return { content: '（没有内容可显示）' };
  // ★★ 2026-10-14「面板刷屏」确定性兜底：**同一次唤醒里最多直发一页**。
  //   事故现场（07:15:39 主群）：模型为了"查一下价格 + 查一下余额"，
  //   在**同一轮**里同时调了 whale_shop 和 whale_status —— 两个"直发面板"工具
  //   各甩一整页 ⇒ 群里连收两页长文本 = 刷屏。
  //   这里不去赌模型会不会守规矩：第 2 页起**不发**，改为把内容回给模型并说明原因，
  //   由它自己决定要不要挑重点转述。⇒ **最坏情况永远是"一页"**。
  //   ⚠️ 键用 `ctx.session.id`（一次唤醒 = 一个新会话，id 就是会话文件名那个）。
  //   ⚠️ 拿不到会话 id 时**不限制**（宁可照发，也不能因为宿主改字段就把面板全吞掉）。
  if (panelSlotUsed(ctx)) {
    return {
      content: '⚠️ 这次唤醒里**已经直发过一页面板**了，本条没有发到群里（防刷屏）。'
        + '它确实要紧的话，挑最关键的几句用 send_message 说，**不要整页复述**。\n\n（未发出的内容：）\n' + t
    };
  }
  if (ctx?.sender?.sendTextBatch) {
    try {
      await ctx.sender.sendTextBatch(ctx.chatKey, [t]);
      markPanelSent(ctx);          // ⚠️ 只有**真发出去**才记账（失败要退还额度）
      return { content: '内容已直接发到群里。不要再复述、总结或补充。' };
    } catch (error) {
      log(`[travel-whale] 面板发送失败，退回给模型：${error?.message ?? error}`);
    }
  }
  return { content: t };
}

/**
 * 告诉控制台「鲸鱼数据变了」，让「鲸鱼」页立刻刷新。
 * 走核心的 SSE 广播（app.js 的 emit → /api/events）。拿不到服务时静默跳过 ——
 * 这只是个刷新提示，绝不能因为它失败影响主流程。
 */
export function notifyUI(chatKey) {
  try { RT.services?.emit?.('whale-update', { chatKey: String(chatKey || ''), at: Date.now() }); }
  catch { /* 提示失败无所谓 */ }
}

/** 发一张图（失败不抛，返回是否成功）。`opts.kind` 规则与 `say` 完全一致 —— 图片只生成一次，多目标复用。 */
export async function sayImage(chatKey, filePath, opts = {}) {
  if (!filePath) return false;
  // 与 say() 对齐：没服务时也要留痕，否则"图一张都没发出去"是完全静默的。
  if (!RT.services?.sender?.sendImage) {
    log('[travel-whale] 发送队列不可用，本张图跳过');
    return false;
  }
  // ★ P6：自主发图同样受全局限流（见 say 里的说明）
  if (opts.proactive === true) {
    const verdict = proactiveGate(chatKey);
    if (!verdict.ok) { log(`[travel-whale] 全局限流拦住一条自主播报（图）：${verdict.reason}`); return false; }
  }
  let any = false;
  const kind = sayKindOf(opts);
  let firstFan = true;
  for (const to of fanoutTargets(chatKey, opts.broadcast !== false, kind)) {
    // 多目标零间隔连发是明显的风控指纹 —— 首个目标之后逐条随机退避 2~4.5s
    if (!firstFan) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2500));
    firstFan = false;
    try { await RT.services.sender.sendImage(to, { file: filePath }); any = true; }
    catch (error) { log(`[travel-whale] 发图到 ${to} 失败：${error?.message ?? error}`); }
  }
  return any;
}

