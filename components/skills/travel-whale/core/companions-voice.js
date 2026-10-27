// 矩阵庭院（travel-whale）· 模块化组件：core/companions-voice.js
// 职责：旅伴队伍、庭院设施加成、借嘴说话与明信片留守评论

import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion, resolveApiKey } from '../../../src/llm.js';
import * as S from '../state.js?v=realworld-1';
import * as E from '../engine.js';
import { cfg, log } from './runtime-deps.js';
import { COMPANION_SKILLS, companionSkillOwned, ownedCompanionIds } from './skills-appointments.js';
import { SELF_DIR, placeLabel } from './world-sync.js';
import { say } from './broadcast.js';

/**
 * ★ 读当前会话的旅行伙伴（**兼容包装**，2026-10-11）。
 *
 * 为什么必须包一层：`companionOf` 住在**兄弟模块** state.js，而热重载只给*入*口文件加 `?t=`
 * （`src/plugin-loader.js:418`）⇒ 改完代码到重启之间，会出现「新 index.js + 缓存里的旧 state.js」，
 * 那时 `S.companionOf` 根本不存在。不包装的话 `whale_status` / `whale_shop` 一调就
 * `TypeError: S.companionOf is not a function` —— 那不是"新功能不生效"，是
 * **连看庭院都报错、整个技能的工具全挂**。
 * 包一层之后：热载期间 = 没有伙伴（新功能静默未生效），重启后自动生效。
 *
 * （同伴还要注意：`S.COMPANIONS` 在旧 state.js 里是 undefined，所以各处都写了 `|| {}` / `?.`。）
 */
export const companionOf = (st) => (typeof S.companionOf === 'function' ? S.companionOf(st) : null);

/**
 * ★ 伙伴名册文本（提示词 / 商店用）—— **现读 COMPANIONS**，加新伙伴不用改文案。
 *   写成"「黑发兽耳小狐狸」4000 亿 TOKEN、「小白龙」3000 亿 TOKEN"。
 */
export function companionRosterText() {
  const list = Object.values(S.COMPANIONS || {});
  if (!list.length) return '（暂无）';
  // ★ 2026-10-13：带上「特色」—— 五个人的代价/收益不再一样，光看名字与价格看不出区别。
  return list.map((c) => `「${c.name}」${c.price} 亿 TOKEN（特色：${c.trait || '增幅'}）`).join('、');
}

/**
 * ★★ 2026-10-24：**只列名字**，给「每轮都进系统提示词」的那处用。
 *
 * 为什么另开一个而不是改 companionRosterText：那个还兼着工具回执（whale_shop /
 * whale_buy 的回话里要报价），把价格删了群友就看不到价了。而系统提示词里那份
 * 价目表是**纯冗余** —— 她真去买的时候，whale_shop 会把价格再报一遍。
 * 七个伙伴 × 每条约 30 字 = 每轮白烧一百多字，还是压在长提示词的中段。
 */
export function companionNamesText() {
  const list = Object.values(S.COMPANIONS || {});
  if (!list.length) return '（暂无）';
  return list.map((c) => `「${c.name}」`).join('、');
}

/** 某个伙伴的图标（热载期间 COMPANIONS 可能是旧的 ⇒ 兜底 🐾）。 */
export const companionEmoji = (idOrDef) => {
  const def = typeof idOrDef === 'string' ? (S.COMPANIONS || {})[idOrDef] : idOrDef;
  return (def && def.emoji) || '🐾';
};

// ── ★★ 2026-10-13 庭院设施（GARDENS）─────────────────────────────────────
//   现读 state.js 的表（加一件设施不用改这里）；等级存在 `state.garden[id]`。

/** 某件设施的等级（缺省 = 0）。 */
export function gardenLevel(state, id) {
  return Math.max(0, Number(state?.garden?.[id]) || 0);
}

/** 设施定义表（热载期间旧 state.js 没有它 ⇒ 空表，功能静默不生效）。 */
export const gardenDefs = () => (Array.isArray(S.GARDENS) ? S.GARDENS : []);

/** 设施名单文本。★ **现读**，不再写死 —— 写死的版本已经漏改过两次
 *  （加了灯笼路没补进去、灯笼路撤销了却还留在文案里）。空表 ⇒ 空串（调用方负责省略那半句）。 */
export const gardenNameList = () => gardenDefs().map((g) => g.name).join('、');

/** 这趟要几份口粮：旅伴加成 **减** 电饭煲减免，最低 1。（原来三处各写一遍，这里收成一个） */
/**
 * 出门口粮需求。
 * ★★ 2026-10-14「扩容鲸鱼」：同行的**每一位都要吃** ⇒ 多人的口粮**累加**
 *    （这正好是扩容的代价 —— 与 §69「真正被消耗的是稀缺库存」同向）。
 * ⚠️ 电饭煲的 -1 减免**只减一次**（它语义是"家里能焖饭"，不是按人头各减一份）。
 * ⚠️ 兼容两种入参：单个伙伴定义（老调用点）/ 数组（同行全部）；单人时**逐字节等于从前**。
 */
export function foodNeedOf(state, compOrList) {
  const list = Array.isArray(compOrList)
    ? compOrList.filter(Boolean)
    : (compOrList ? [compOrList] : []);
  const base = list.length
    ? list.reduce((s, c) => s + Math.max(1, Number(c?.foodCostMult) || 1), 0)
    : 1;
  return Math.max(1, base - gardenLevel(state, 'stove'));
}

/**
 * ★★ 2026-10-14「扩容鲸鱼」（设施 A）：这一趟**带谁**出门。
 *
 * 规则：领头（`state.companion` —— 玩家在商店选定的那位）**必带**；其余从"已请过的"里
 *   **随机**补满到设施上限（`partyCapOf`）。
 *   ⚠️ 未建扩容设施时上限 = 1 ⇒ 只返回领头 ⇒ 与从前**逐字节一致**。
 *   ★ 为什么"其余随机"而不是按顺序：请了 7 位而上限只有 4，**按顺序会让后请的那几位
 *     永远排不上**；随机则人人都有机会（用户只定了"能带几位"、没定"带谁"，先按这个口径）。
 * ⚠️ 兄弟模块的函数一律**包装后调用**：热载时 `state.js` 可能还是旧版、新导出根本不存在，
 *    裸调 `S.partyCapOf(...)` 会 TypeError 把**整个技能的工具**全带崩。
 */
export function pickPartyIds(state) {
  const cap = Math.max(1, typeof S.partyCapOf === 'function' ? S.partyCapOf(state) : 1);
  const lead = String(state?.companion?.id || '').trim();
  if (!lead || !S.COMPANIONS?.[lead]) return [];
  const owned = typeof S.ownedCompanionIds === 'function' ? S.ownedCompanionIds(state) : [];
  const pool = owned.filter((id) => id !== lead && S.COMPANIONS?.[id]);
  // ★ **确定性取人**（按"请的顺序"取前 cap−1 位），刻意**不用随机**：
  //   `whale_go` / 自动出发都要在 `depart()` 之前**先算口粮**，随机的话根本算不出会带谁，
  //   只能按最坏情况多买（7 位全请时要囤十几份）。确定性 ⇒ 前后同一口径。
  //   ★ 想换人 ⇒ 换领头那位（`whale_companion`）。
  return [lead, ...pool.slice(0, Math.max(0, cap - 1))];
}

/** 这一趟同行的**伙伴定义**（＝ `pickPartyIds` 查表）—— 出门前后共用同一口径。 */
export function partyOf(state) {
  return pickPartyIds(state).map((id) => S.COMPANIONS?.[id]).filter(Boolean);
}

// ── ★★★ 2026-10-14「借一副嘴」（MEMORY-2 §113）─────────────────────────────
//   用途：邀请 / 更换旅伴时，把那句**第三人称转述**（"她答应了！"）换成**她本人说的一句话**。
//   原理：`chatCompletion({messages})` 的 messages 由调用方给 ⇒ 把人物卡当 `messages[0]`（system）
//     塞进去、用完即弃 —— **`persona.roleText` 一个字都不动**。
//   ⚠️ 三条纪律：① 绝不动全局人设；② 卡要短（只有"她是谁／怎么说话／小习惯"）；
//     ③ **任何失败都回落原来的转述**，绝不因为调模型失败就不回话。

let personaCardsCache = null;
let personaCardsMtime = 0;

/** 现读人物卡（`personas.json`）⇒ **改卡即时生效、不用重启**。读不到 → 空对象（调用方回落）。 */
export function personaCards() {
  try {
    const f = path.join(SELF_DIR, 'personas.json');
    const st = fs.statSync(f);
    if (!personaCardsCache || st.mtimeMs !== personaCardsMtime) {
      personaCardsCache = JSON.parse(fs.readFileSync(f, 'utf8'));
      personaCardsMtime = st.mtimeMs;
    }
    return personaCardsCache?.cards || {};
  } catch { return {}; }
}

/**
 * ★★ 2026-10-16（用户拍板"丙"）：七位**共用**的说话红线（`personas.json` 顶层 `commonRule`）。
 *
 * 为什么放顶层、不写进 7 张卡里：改一次只改一处（写 7 遍必然各漂各的），
 * 而且 `_qcheck/companion-cards-probe.mjs` 要求 `cards` 里不能有多余 id。
 * ⚠️ 读不到（老文件 / 解析失败）⇒ 返回空串，`speakAs` 只用卡本身，**行为与从前一致**。
 */
export function personaRule() {
  try {
    const f = path.join(SELF_DIR, 'personas.json');
    const st = fs.statSync(f);
    if (!personaCardsCache || st.mtimeMs !== personaCardsMtime) {
      personaCardsCache = JSON.parse(fs.readFileSync(f, 'utf8'));
      personaCardsMtime = st.mtimeMs;
    }
    return String(personaCardsCache?.commonRule || '').trim();
  } catch { return ''; }
}

/**
 * 「借一副嘴」：让某位旅伴就某件事说一句自己的话。
 * @returns {Promise<string>} 一句话；**任何失败都返回空串**（调用方据此回落原转述）
 */
export async function speakAs(companionId, scene) {
  try {
    const card = personaCards()[String(companionId || '').trim()];
    if (!card) return '';
    // ★★ 2026-10-16（用户拍板"丙"）：把七位**共用**的说话红线拼在卡后面 ——
    //   判据落在"模型真正收到的 system"上（卡 + 红线），而不是只写在文件里当注释。
    //   ⚠️ 读不到就只用卡本身，行为与从前一致（失败绝不因为她少了段禁则不回话）。
    const rule = personaRule();
    const system = rule ? `${card}\n\n${rule}` : card;
    const { chatCompletion } = await import('../../src/llm.js');
    const r = await chatCompletion({
      messages: [{ role: 'system', content: system }, { role: 'user', content: scene }],
      temperature: 0.9,
      // ⚠️ 预算不能给小：本机默认是**思考型**模型，给 200 会被 reasoning 吃光 ⇒ 返回空串
      //   （`refreshMemoryDigest` 与日记那边都有同一条教训）。
      maxTokens: 3000
    });
    let t = String(r?.message?.content || '').trim();
    t = t.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 120) : '';        // 一句话，超长截断
  } catch (e) {
    log(`[travel-whale] 借嘴失败（${companionId}）：${e?.message ?? e} —— 回落原回执`);
    return '';
  }
}

/**
 * 把"她的话 + 机制说明"拼成一条回执（`said` 为空 ⇒ 用原来的转述口径）。
 *
 * ★★ 2026-10-14「署名」（用户口径，见 §114）：**那句台词必须带着署名原样发出去** ——
 *   原因：宿主落盘时（`src/sender.js` 的 `appendSelf`）一律记成 `self:true`/「我」，
 *   她本人和下游三个消费者（历史上下文／长期记忆日块／她的一天）都**区分不出这是伙伴说的**。
 *   署名是目前**唯一能穿透到存档**的办法（在宿主层加字段 ＝ 改核心，本轮不做）。
 *   ⚠️ 所以回执里**必须显式要求"原样发"** —— 实证：主群 18687 条 self 消息里，
 *      带「名字」：署名的只有 16 条、且**全是面板** ⇒ 模型默认会改写台词、丢掉署名。
 *   ⚠️ 机制细节（`tail`）**不能让伙伴说** —— 那是鲸鱼少女该向群友交代的，所以单列一行。
 */
export function withLine(comp, said, fallbackLine, tail) {
  if (!said) return `${companionEmoji(comp)} ${fallbackLine} —— ${tail}`;
  const line = `${companionEmoji(comp)} 「${comp.name}」：${said}`;
  return `${line}\n\n`
    + `[上面这一行是「${comp.name}」**本人**说的话 —— 请把它**原样发出去**（连 ${companionEmoji(comp)} 和`
    + `「${comp.name}」：这个署名一起，一个字都别改），不要改写成"她答应了""她同意啦"这类转述，也不要替她往下接。]\n`
    + `[下面这些机制细节由**你自己**另起一条说，别塞进她的话里：${tail}]`;
}

// ── 留守的旅伴来评论（2026-10-14 用户口径，见 §115）─────────────────────────

/**
 * 明信片评论概率（配置 `commentChance`，默认 0.4；**0 ＝ 关**）。
 * ⚠️ 必须显式排除 `null`/`undefined`/`''` —— `Number(null) === 0` 会把它误判成"关闭"（§75 通则）。
 */
export function commentChanceOf(cfgObj = null) {
  const raw = (cfgObj || cfg())?.commentChance;
  if (raw === null || raw === undefined || raw === '') return 0.4;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.4;
}

/** 这一趟**出门在外**的旅伴 id（鲸鱼那趟看 `companion` + `party`，伙伴那趟看 `partners`）。 */
export function awayCompanionIds(tripLike) {
  const out = new Set();
  const push = (x) => { const s = String(x || '').trim(); if (s) out.add(s); };
  push(tripLike?.companion);
  for (const x of (Array.isArray(tripLike?.party) ? tripLike.party : [])) push(x);
  for (const x of (Array.isArray(tripLike?.partners) ? tripLike.partners : [])) push(x);
  return out;
}

/**
 * 随机挑一位**留守**的旅伴（已邀请 − 本趟同行）来评论这张明信片。
 * 没人留守 ⇒ `null`（例如只请了一位、而她正同行）。
 * 纯函数（只读 `state`/`tripLike`/`COMPANIONS`）⇒ 可离线单测。
 */
export function pickCommenter(state, tripLike, rand = Math.random, companions = null) {
  const table = companions || S.COMPANIONS || {};
  const away = awayCompanionIds(tripLike);
  const pool = ownedCompanionIds(state).filter((id) => !away.has(id) && table[id]);
  if (!pool.length) return null;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/**
 * 给评论模型看的"这张明信片长什么样"。
 * ★★ **只有文字** —— 本机默认是纯文本模型，**看不到图**，所以地点/景点/特产/题字/感想都要写进场景。
 */
export function buildCommentScene(state, tripLike, entry, card, opts) {
  const whale = String(cfg().whaleName || '小鲸鱼');
  const place = placeLabel(tripLike);
  const isSide = tripLike?.side === true;
  const names = [];
  if (!isSide) names.push(whale);
  for (const pid of (Array.isArray(tripLike?.partners) ? tripLike.partners : [])) {
    const n = (S.COMPANIONS || {})[pid]?.name;
    if (n) names.push(n);
  }
  if (!names.length) names.push('她们');
  const spot = String(entry?.spot || '').trim();
  const scene = String(entry?.scene || '').trim();
  const where = spot || scene || '当地的风景';
  const souv = (Array.isArray(entry?.souvenirs) ? entry.souvenirs : [])
    .map((x) => (typeof x === 'string' ? x : String(x?.name || ''))).filter(Boolean);
  const caption = String(card?.caption || '').trim();
  const thought = String(card?.thought || '').trim();
  const lines = [
    `你留在庭院里，收到 ${names.join('、')} 从 ${place} 寄回来的一张明信片（这一趟你没跟着去）。`,
    `照片拍的是：${where}${spot && scene && scene !== spot ? `（${scene}）` : ''}。`
  ];
  if (souv.length) lines.push(`这趟带回来的特产：${souv.join('、')}。`);
  if (card?.rarity === 'rare') lines.push('这是一张稀有明信片。');
  if (opts?.isReturn) lines.push('这是她们到家时补发的那一张。');
  if (caption) lines.push(`她在照片上题了一句：「${caption}」`);
  if (thought) lines.push(`她自己的感想：${thought}`);
  lines.push('请用**你自己的口气**给这张明信片留一句评论（像在空间里给朋友留言那样）：'
    + '一到两句，口语，短；别复述整张明信片、别念设定、别客套（"祝你们愉快"这类）、别谢场。');
  return lines.join('\n');
}

/**
 * ★★ 2026-10-14「留守的旅伴来评论」：明信片发出后，按概率随机挑一位**这趟没同行**的旅伴，
 *   用她自己的口吻给这张卡留一句评论，发到群里。
 *
 * 为什么由**技能自己发**（而不是像邀请那样给主模型一条回执）：
 *   这条路是**后台 tick** 走的 —— **主模型不在场**（没有对话、没有工具回执可给）⇒ 只能自己发。
 *   ★ 附带好处：署名是**拼好的文本**、一定进存档 ⇒ 比 §114 路 A（靠模型自觉）**更可控**。
 *   ★ 沿用同一条署名口径（`emoji 「名字」：…`）—— 她读历史时能认出这句不是自己说的。
 *   ⚠️ 评论是**锦上添花**：任何一步失败都只记日志，绝不许影响明信片本身。
 * @returns {Promise<string>} 发出去的那一行（没发 ⇒ 空串）
 */
export async function commentOnPostcard(chatKey, state, tripLike, entry, card, opts, deps) {
  const rand = (typeof deps?.rand === 'function') ? deps.rand : Math.random;
  // ★★ 2026-10-14 设施 B（用户口径）：**数据标注车间里有人上班 ⇒ 评论概率抬高**。
  //   原话是"闲在家里没事干就刷动态" —— 坐在工位上的人，看明信片的次数就是更多。
  //   口径：+15%/人（`S.LABELROOM.commentBonusPerWorker`）、**封顶 90%**（留一点"这次没被评"的余地）。
  const roomBonus = (typeof S.labelroomCommentBonus === 'function') ? S.labelroomCommentBonus(state) : 0;
  const capRaw = Number(S.LABELROOM?.commentChanceCap);
  const cap = Number.isFinite(capRaw) ? capRaw : 0.9;
  const chance = Math.min(cap, commentChanceOf() + roomBonus);
  if (!(chance > 0)) return '';                    // 0 ⇒ 关
  if (rand() >= chance) return '';                 // 概率闸（基础约四成；车间有人时更高）
  const id = pickCommenter(state, tripLike, rand);
  if (!id) return '';                              // 没人留守（都出门了）
  const def = (S.COMPANIONS || {})[id];
  if (!def) return '';
  const said = await speakAs(id, buildCommentScene(state, tripLike, entry, card, opts));
  if (!said) return '';                            // 模型失败/空串 ⇒ 这一张就不评（不回落成转述）
  const line = `${companionEmoji(def)} 「${def.name}」：${said}`;
  await say(chatKey, line, opts);
  log(`[travel-whale] ${chatKey} 明信片评论（留守）：「${def.name}」`);
  return line;
}

/** 照片墙：合照门槛 8h → 6h（⚠️ 0 = 关闭，必须保持 0）。 */
export function homeShotHoursOf(state, raw) {
  const v = Number(raw);
  if (!(v > 6)) return raw;                       // 0（关闭）/ 小于 6 / 非法值 ⇒ 原样
  return gardenLevel(state, 'photowall') > 0 ? 6 : raw;
}

/**
 * ★ 2026-10-13 旅伴「特色」的一段话（商店 / 帮助页共用）。
 *   **现读 COMPANIONS** ⇒ 改数值不用改文案。
 */
export function companionTraitText(def) {
  if (!def) return '';
  const bits = [];
  const food = Math.max(1, Number(def.foodCostMult) || 1);
  if (food > 1) bits.push(`吃 ${food} 份`);
  const cardPct = Math.round(((Number(def.cardMult) || 1) - 1) * 100);
  if (cardPct) bits.push(`明信片 ${cardPct > 0 ? '+' : ''}${cardPct}%`);
  const rare = Number(def.rareMult) || 1;
  if (rare !== 1) bits.push(`稀有 ×${rare}`);
  if (Number(def.dailyTokens) > 0) bits.push(`每天 +${Number(def.dailyTokens)} 亿 TOKEN`);
  if (Number(def.departCost) > 0) bits.push(`每次出发扣 ${Number(def.departCost)} 亿 TOKEN（可扣成负数）`);
  if (Number(def.cardExtra) > 0) bits.push(`每趟多 ${Number(def.cardExtra)} 张`);
  // ★★ v3.2 两位新旅伴改绑特产之后的三个新字段（现读表 ⇒ 改数值不用改文案）
  //   ⚠️ 这两行**必须短**：商店正文是一整页发进群的 `replyPanel`，
  //     `panel-flood-probe` 盯着"商店正文 < 1200 字"（第一次加它们就顶到 1223 被探针抓到）。
  //     完整说明在帮助图的旅伴表里（那边另有「代价 / 收益」一列，不缺地方）。
  //   ⚠️ 这三句**与 `help.js` 的 `traitOf()` 必须逐字一致**（那边是说明图的表）——
  //     两边是各自独立的渲染模块（help.js 不能反向 import index.js，会成环），
  //     文案只能手工同步；探针 `souvenir-probe` 有一条跨文件守卫盯着这三句。
  if (def.noteSouvenirs) bits.push('新特产带她的批注');
  if (Number(def.harvestBonus) > 0) bits.push(`收成 +${Number(def.harvestBonus)} 份（她在庭院时）`);
  if (def.farmHelper) bits.push(`开菜地（永久 ${S.FARM.slots + S.FARM.helperSlots} 块；她在时种下的快 30%）`);
  if (def.longCaption) bits.push('题字更长');
  if (Number(def.flopChance) > 0) bits.push(`约 ${Math.round(Number(def.flopChance) * 100)}% 的明信片会翻车`);
  if (def.battleOnFiction) bits.push('异世界必惹事（多 1 张战斗明信片）');
  return bits.join('｜');
}

/** 谁在发津贴（**邀请过即可**，不要求同行）。现读 COMPANIONS。 */
export function stipendPayers(state) {
  const skills = companionSkillOwned(state);
  return ownedCompanionIds(state)
    .map((id) => (S.COMPANIONS || {})[id])
    .filter(Boolean)
    .map((d) => {
      // ★★ 2026-10-13 旅伴养成「不请自来」：小狐狸练出来之后津贴 500 → 800（现读 COMPANIONS 的底数 + 加成）。
      //   返回的是**副本**，绝不改 `S.COMPANIONS` 本体（那是全进程共享的常量表）。
      const up = COMPANION_SKILLS.find((s) => s.id === 'gatecrash' && s.companion === d.id);
      const bonus = (up && skills[up.id]) ? Math.max(0, Math.floor(Number(up.bonusTokens) || 0)) : 0;
      return { ...d, dailyTokens: Math.max(0, Math.floor(Number(d.dailyTokens) || 0)) + bonus };
    })
    .filter((d) => d.dailyTokens > 0);
}

/**
 * ★★ 2026-10-13 旅伴「特色」：小狐狸的「免费鸡蛋」（每天一次，**在不在家都发**）。
 *
 * 为什么键是**本地日期串**而不是"距上次 24 小时"：用户说的是"每天发一份" ⇒ 按自然日算才符合直觉
 * （昨晚 23:50 领过、今早 00:10 就该再领一份）。
 * ⚠️ 读的是**兄弟模块** state.js 的字段 ⇒ 「新入口 + 旧 state.js」期间 `dailyTokens` 是 undefined
 *   ⇒ 返回 0、**静默不生效**（安全降级，不会报错、也不会重复发钱）。
 * @returns {number} 本次该发的 TOKEN（0 = 今天已发过 / 这位没有这个特色）
 */
export function dueStipend(state, now = Date.now()) {
  // ★ 2026-10-13 用户口径（第二轮）：**只要邀请过就发** —— 不要求她此刻是同行的那位。
  //   （第一版要求"她是当前同行伙伴"；用户改成"邀请过就发"。）
  const amount = stipendPayers(state)
    .reduce((sum, d) => sum + Math.max(0, Math.floor(Number(d.dailyTokens) || 0)), 0);
  if (!amount) return 0;
  const today = (typeof E.dayKey === 'function') ? E.dayKey(now) : '';
  if (!today) return 0;
  if (String(state.lastStipendDay || '') === today) return 0;
  state.lastStipendDay = today;
  state.stipendsPaid = (Number(state.stipendsPaid) || 0) + 1;
  return amount;
}

/**
 * ★★ 2026-10-13 旅伴「特色」：往一趟计划里**追加一张卡**。
 *   · `battle:true`（默认）⇒ 小魔王的**战斗明信片**（强制战斗构图）；
 *   · `battle:false`     ⇒ 小书虫「话多」的普通额外卡。
 *
 * ⚠️⚠️ **头号风险 —— 序号对齐**：`cardPlan` 前 `cardTimes.length` 条是"途中卡"、
 *   **最后一条是到家卡**（`planCardContent` 就是这么排的，`sendReturnCard` 也只读最后一条）。
 *   所以必须**成对、同位**插入：`cardTimes` 追加到末尾；`cardPlan` 插在"到家卡**之前**"。
 *   插错位置 ⇒ `sendCard(index)` 会取到别的文案，甚至把到家卡当途中卡寄出去。
 *
 * @param {object} plan **原地修改**（cardTimes / cardPlan / cardCount）
 * @param {{rand?:Function, battle?:boolean}} [opts]
 * @returns {number} 新卡的出发时刻（0 = 没插）
 */
