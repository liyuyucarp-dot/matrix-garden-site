// 矩阵庭院（travel-whale）· 模块化组件：core/side-trips.js
// 职责：庭院大合照拍摄、旅伴跨宿主出门申请（side-wish）与闲置伙伴自游出行/结算

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../../../src/config.js';
import * as S from '../state.js?v=realworld-1';
import * as E from '../engine.js';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as HM from '../home.js';
import { buildDeps, cfg, log } from './runtime-deps.js';
import { appendExtraCard, pushMoodEvent } from './mood-battle-events.js';
import { normalizeSideTrips, placeLabel, randomUnlockedRegion, restRange, sideTripsOf } from './world-sync.js';
import {
  buildCrossOverLine,
  consumeFood,
  discoveredLine,
  hasFood,
  pickCrossOverTarget,
  unlockBuyablesFromCrossing
} from './departure.js';
import { sayP, sayImageP } from './broadcast.js';
import {
  markAreaSeen,
  markCardDelivered,
  recordTripSouvenirs,
  sendReturnCard,
  sendSouvenirImages
} from './postcards-settle.js';
import { notesSouvenirs } from './pantry-farm.js';

//   ③ **相册记 `kind:'home'` 且不进旅行统计**（`countStat:false`）——「已寄明信片 N 张」数的是
//      旅行进度，把家拍混进去会让称号失真（它确实进相册，日记配图照样会挑到它）。
//
// ⚠️ 失败策略与明信片一致：**生图失败 / 文案失败都不抛**，能发的部分照发（图没有就纯文字），
//   而且**一定要把 homeShotAt 打上** —— 否则生图一挂，每个 tick 都会重试一次（刷屏）。
export async function shootHomeGroup(chatKey, state, deps) {
  const d = deps || buildDeps(chatKey, state);
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const members = HM.homeMembers(state);
  const names = HM.memberNames(members, cfg().whaleName);
  const style = HM.pickHomeStyle(rand);
  const charStyle = P.pickCharacterStyle(rand);
  const prompt = HM.buildGroupPrompt({ members, style, charStyle, rand });
  const size = String(cfg().homeShotSize || HM.HOME_SHOT_SIZE);

  let imagePath = '';
  let imageError = '';
  try {
    const res = await d.imageGen(prompt, { size });
    if (res?.ok && Array.isArray(res.images) && res.images.length) imagePath = await d.saveImage(res.images[0]);
    else imageError = String(res?.error ?? '生图未返回图片');
  } catch (error) { imageError = String(error?.message ?? error); }

  // 文案：解析形状与旅行明信片一致（只要 {caption, thought}），坏了就用兜底，保证一定有字
  let caption = '庭院大合照';
  let thought = `${names.join('、')}都在 —— 今晚的星星很清楚。`;
  if (typeof d.llm === 'function') {
    try {
      const raw = await d.llm(HM.buildHomeCaptionPrompt({
        names,
        whaleName: String(cfg().whaleName || '小鲸鱼'),
        atText: new Date().toLocaleString('zh-CN', { hour12: false })
      }));
      const m = String(raw ?? '').match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (parsed?.caption) caption = String(parsed.caption).trim().slice(0, 20);
      if (parsed?.thought) thought = String(parsed.thought).trim();
    } catch (error) {
      log('[travel-whale] 合照文案生成失败，用兜底：' + (error?.message ?? error));
    }
  }

  let imgSent = false;
  if (imagePath) imgSent = await sayImageP(chatKey, imagePath);
  await sayP(chatKey, caption + '\n' + thought);

  const added = S.addPostcard(state, {
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME, spot: '庭院大合照',
    style, charStyle, kind: 'home', members,
    caption, thought, image: imagePath
  }, { countStat: false });
  if (imgSent) markCardDelivered(state, added?.id);
  // ★★ 2026-10-13「随机事件影响心情」：拍大合照是**好事**（她本来就为这个玩法高兴）。
  pushMoodEvent(state, 'home-photo', { who: names.join('、') });
  state.homeShotAt = Date.now();     // ★ 无论图出没出都要打上（见函数头那条说明）
  log(`[travel-whale] ${chatKey} 拍了庭院大合照：${names.join('、')}（${names.length} 人，${size}）`
    + (imageError ? `｜图失败：${imageError}` : ''));
  return { ok: true, members, names, imagePath, imageError, style, prompt };
}

// ── ★★ 闲置伙伴「自己去玩」（2026-10-11 用户需求）──────────────────────────
//
// 与鲸鱼那趟的关系：**复用同一套挑城 / 搜索 / 抽取链路**，但出口口径是另一套：
//   · 只有**没被鲸鱼带着**的伙伴才会自己出门，而且必须**凑够两人一组**；
//   · 一次从背包里**拿走 2 份**同档米饭，去玩**该档口粮对应的时间**；
//   · ⚠️ **门槛：那一档必须已有 ≥ 6 份**才允许动 —— 留足给鲸鱼，别把存粮吃空；
//   · 途中明信片**按档固定**（小 0 / 中 0 / 大 1 张），到家**再** 1 张；
//   · 到家固定**只带 1 件特产**；
//   · 出门时**同样有概率穿越**（与鲸鱼共用 `crossOverChance`）；
//   · 城市/景点**不记进 `visitedCities`**（那是鲸鱼自己的足迹），但特产**进图鉴**。

/** 闲置伙伴出门用哪一档饭：从大份往下找**库存 ≥ foodFloor（默认 6）**的那一档。 */
export function sideTripTier(state) {
  const floor = Number(S.SIDE_TRIP?.foodFloor) || 6;
  for (const t of ['large', 'normal', 'small']) {
    if ((Number(state?.bag?.food?.[t]) || 0) >= floor) return t;
  }
  return null;
}

/** 从闲置伙伴里随机挑一组（默认两人）。 */
// ── [[side-wish]] 旅伴出门申请（2026-10-22）────────────────────────────────
// 有号的旅伴（星澄 / 小书虫）在另一个 QQ Agent 宿主里，把"我想出门"写成一份申请：
//   <DATA_DIR>/skills/travel-whale/side-wish.json  { id, at, partner, chatKey, expireAt }
// 本技能**只读**它，而且只用来「把申请人排进这一趟的名单」——
//   · 不改任何门槛（粮 / 人数 / 夜间 / 冷却一律照旧判）
//   · 不做"单人出门"（一趟仍是 partySize 位）
// 答复追加写进 side-wish-ack.jsonl，由对面读；处理完就删掉申请，免得重复消费。
// 设置项 `sideWishEnabled`（默认开）可整体关掉；没有这个文件时行为与关掉完全一致。
export const SIDE_WISH_FILE = 'side-wish.json';
export const SIDE_WISH_ACK = 'side-wish-ack.jsonl';

export function sideWishDir() { return path.join(DATA_DIR, 'skills', 'travel-whale'); }

/** 读申请：没有 / 坏了 / 不是这个群 / 过期 ⇒ null（一律当没申请）。 */
export function readSideWish(chatKey) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sideWishDir(), SIDE_WISH_FILE), 'utf8'));
    if (!j || !j.partner) return null;
    if (j.chatKey && String(j.chatKey) !== String(chatKey)) return null;
    if (Number(j.expireAt) && Date.now() > Number(j.expireAt)) return null;
    return j;
  } catch { return null; }
}

export function clearSideWish() {
  try { fs.rmSync(path.join(sideWishDir(), SIDE_WISH_FILE), { force: true }); } catch { /* ignore */ }
}

export function writeSideWishAck(row) {
  try {
    fs.mkdirSync(sideWishDir(), { recursive: true });
    fs.appendFileSync(path.join(sideWishDir(), SIDE_WISH_ACK),
      JSON.stringify({ at: Date.now(), ...row }) + '\n', 'utf8');
  } catch { /* 回执写不进去不能影响出门 */ }
}

/** 派出后回执：对面据此告诉她"家里答应了"。 */
export function ackSideWishDispatched(wish, plan) {
  if (!wish) return;
  writeSideWishAck({
    id: wish.id, result: 'dispatched',
    city: String(plan?.city || ''), country: String(plan?.country || ''),
    backAt: Number(plan?.returnAt) || 0
  });
  clearSideWish();
  log(`[travel-whale] 已按申请把「${wish.partner}」排进这趟（${wish.id}）`);
}

/** 驳回回执：理由直接抄 sideWait.why（"粮不够 / 凑不够人 / 夜里"都是它算出来的）。 */
export function ackSideWishRejected(wish, why) {
  if (!wish) return;
  writeSideWishAck({ id: wish.id, result: 'rejected', why: (why || []).slice(0, 3) });
  clearSideWish();
  log(`[travel-whale] 申请 ${wish.id} 被驳回：${(why || []).join('；')}`);
}

export function pickSideParty(idle, rand = Math.random) {
  const need = Number(S.SIDE_TRIP?.partySize) || 2;
  const pool = [...idle];
  const out = [];
  while (out.length < need && pool.length) {
    const i = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * 把 `planTrip` 产出的完整计划**剪成**伙伴出行口径（**纯函数**，便于离线单测）。
 *
 *   · 途中卡数**按档固定**（`SIDE_TRIP.midCards`：小 0 / 中 0 / 大 1）——
 *     重排 `cardTimes`，并把 `cardPlan` 收成「mid 条途中 + 最后那条到家卡」；
 *   · 特产截断到 `SIDE_TRIP.souvenirCount`（固定 1 件）。
 *
 * ⚠️ 两条不能省的细节：
 *   ① `cardPlan` 的最后一条是**到家那张**（`planCardContent` 的口径）—— 必须留着，
 *      否则 `sendReturnCard` 会拿不到东西可寄；
 *   ② 返回的是**新对象**，不动传进来的 plan（调用方可能还要拿原值兜底）。
 *
 * @param {object} plan `T.planTrip` 的返回值
 * @param {string} foodTier 口粮档位（决定途中张数）
 * @returns {object} 剪好的新计划
 */
export function trimSidePlan(plan, foodTier) {
  const p = { ...(plan || {}) };
  const mid = Math.max(0, Number(S.SIDE_TRIP?.midCards?.[foodTier] ?? 0));
  const durationMs = Math.max(0, Number(p.durationMs) || 0);
  const departAt = Number(p.departAt) || Date.now();
  const orig = Array.isArray(p.cardPlan) ? p.cardPlan : [];
  const returnEntry = orig[orig.length - 1] || { kind: 'spot', spot: '', scene: '' };
  p.cardPlan = [...orig.slice(0, mid), returnEntry];
  p.cardTimes = [];
  for (let i = 1; i <= mid; i++) {
    p.cardTimes.push(Math.round(departAt + (durationMs * i) / (mid + 1)));
  }
  p.cardCount = mid;
  p.souvenirs = (p.souvenirs || []).slice(0, Math.max(0, Number(S.SIDE_TRIP?.souvenirCount) || 1));
  return p;
}

/**
 * 让一组闲置伙伴自己出门玩。
 * @returns {Promise<{ok:boolean, plan?:object, reason?:string}>}
 */
export async function departSideTrip(chatKey, state, foodTier, partners, deps) {
  // ★ 同上：闲置伙伴自己出去玩，也是随机挑一个已解锁的地方
  const baseRegion = randomUnlockedRegion(state, (deps && deps.rand) || Math.random);
  if (!baseRegion) return { ok: false, reason: '地区表不可用' };
  if (!Array.isArray(partners) || partners.length < (Number(S.SIDE_TRIP?.partySize) || 2)) {
    return { ok: false, reason: '凑不够两个人' };
  }
  const need = Number(S.SIDE_TRIP?.foodNeed) || 2;
  if (!hasFood(state, foodTier, need)) return { ok: false, reason: '米饭不够两份' };
  const d = deps || buildDeps(chatKey, state);

  // 穿越判定 —— 与鲸鱼**同一个池子**（还没解锁的异世界），全解锁后自然永不触发
  const crossing = pickCrossOverTarget(state, baseRegion, d);

  for (let attempt = 0; attempt < 2; attempt++) {
    const region = (attempt === 0 && crossing) ? crossing.region : baseRegion;
    const picked = await T.pickCity(region, state, { llm: d.llm, log, rand: d.rand });
    if (!picked) continue;

    const plan = await T.planTrip({
      region, city: picked.city, country: picked.country, foodTier, state, deps: d,
      // ★★ v3.2：伙伴那趟**也算**（用户口径同「特色」："她自己的那趟算数"）——
      //   两位伙伴里只要有一位是"会记东西的"，这趟的特产就带批注。
      note: partners.some((c) => notesSouvenirs(c))
    });
    if (!plan) {
      log(`[travel-whale] 伙伴那趟：${placeLabel(picked)} 没玩头，重挑（第 ${attempt + 1} 次）`);
      continue;
    }

    // ① 剪成伙伴出行口径（途中张数按档固定 + 特产固定 1 件）
    const trimmed = trimSidePlan(plan, foodTier);

    // ② 标记这是"伙伴自己出去玩"那趟：记两位伙伴、**不带 companion**（鲸鱼没同行）
    trimmed.partners = partners.map((c) => c.id);
    trimmed.companion = '';
    // ★★ 2026-10-14 设施 B（用户口径）：**她自己跑出去玩 = 也算"出过门"** ——
    //   解封（之后能再上工），并把她从车间名册撤下。这也是硬约束给的**第二条**解锁路径。
    if (typeof S.releaseForTravel === 'function') S.releaseForTravel(state, trimmed.partners);
    trimmed.source = picked.source || 'pool';
    trimmed.charm = '';
    trimmed.side = true;

    // ★★ 2026-10-13 旅伴「特色」：**她自己的那趟也算数**（用户口径："grok自己那趟也触发"）。
    //   两位伙伴里只要有人有该特色就生效；战斗卡与普通额外卡分开判（可以同时成立）。
    if (partners.some((c) => c?.battleOnFiction)) appendExtraCard(trimmed, { rand: d.rand, battle: true });
    if (partners.some((c) => Number(c?.cardExtra) > 0)) appendExtraCard(trimmed, { rand: d.rand, battle: false });

      // ③ 穿越标记 + 即兴台词（把两位伙伴的名字并起来喂给台词生成）
      //   ★ 2026-10-13：必须传 `lead:'partners'` —— 这趟**她没有同行**，
      //     台词要是"她留守在家、转述两个小家伙跑丢了"的口吻（幸灾乐祸 + 让你们不带我）。
      if (attempt === 0 && crossing) {
        trimmed.crossedOver = true;
        trimmed.crossOverFrom = crossing.fromName;
        trimmed.crossOverTo = region.name;
        // ★★ 2026-10-15「探索解锁」：**旅伴自己穿越也算**（用户口径原话）。
        //   用的是同一份 `state`、同一个函数 —— 谁被丢出去，都算这个家"发现"了新世界。
        const foundNames = unlockBuyablesFromCrossing(state, region.id, d);
        trimmed.unlockedBuyables = foundNames;
        trimmed.crossOverLine = (await buildCrossOverLine({
          toName: region.name,
          fromName: crossing.fromName,
          companion: { name: partners.map((c) => c.name).join('和') },
          lead: 'partners',
          // ★ 2026-10-14 她本人可能也在外面（两趟互相独立）⇒ 台词不能一律说"她留守在家"
          whaleAway: Boolean(state.trip)
        }, d)) + discoveredLine(foundNames);
      } else {
      trimmed.crossedOver = false;
    }

    consumeFood(state, foodTier, need);
    // ★★ 2026-10-14 多趟化：**追加**一趟（原来这里是 `state.sideTrip = {...}` ⇒ 只能有一趟）。
    //   上限不写死：能派几趟 = `floor(闲置/partySize)`，每派一趟闲置就少两位 —— 由 tick 侧控制。
    normalizeSideTrips(state).push({ ...trimmed, cardsSent: 0 });
    return { ok: true, plan: trimmed };
  }
  return { ok: false, reason: '连着两次都没挑到能去的地方' };
}

/**
 * 伙伴那趟结束：特产入图鉴 → 到家寄 1 张 → 播报 → 排下次。
 * ⚠️ 与 `settleTrip` 的差别是**刻意**的：这趟是"两个人自己溜达" ——
 *    不记 `visitedCities`、不评称号、不发稀有奖励。图鉴照收，但不推动鲸鱼的进度。
 */
export async function settleSideTrip(chatKey, state, party, deps) {
  // ★★ 2026-10-14 多趟化：**这一趟**由调用方传进来（原来是从 `state.sideTrip` 取"唯一那趟"）。
  //   兼容旧的三参写法 `(chatKey, state, deps)`（旧调用点 / 旧探针）：第三个参数不像趟就当成 deps。
  const looksLikeTrip = Boolean(party && typeof party === 'object'
    && (Array.isArray(party.partners) || Array.isArray(party.cardTimes) || party.city));
  const trip = looksLikeTrip ? party : (sideTripsOf(state)[0] || null);
  if (!trip) return null;
  const d = (looksLikeTrip ? deps : party) || buildDeps(chatKey, state);

  const { parts, images: souvenirImages } = await recordTripSouvenirs(chatKey, state, trip, d);
  S.refreshStats(state);
  // ★ 2026-10-14 服装系统：**伙伴那趟也算**（用户口径："不要求她本人，旅伴去过也解锁服装"）
  markAreaSeen(state, trip);

  const names = (trip.partners || [])
    .map((id) => (S.COMPANIONS || {})[id]?.name || id).join('和') || '两位伙伴';
  const where = placeLabel(trip);
  const lines = [`🐾 ${names}自己跑出去玩回来了。这趟去了 ${where}。\n`
    + (parts.length ? `带回来的东西：${parts.join('、')}` : '这趟什么也没带回来')];

  // 留快照（夜里压住的到家明信片要等早上才生成，得靠它取到城市/景点/画风）
  const snapshot = { ...trip };
  // ★ 10-14 多趟化：只摘掉**这一趟**，其余趟照旧在路上（原来一句 `state.sideTrip = null`
  //   会把同时在外面的人一起清掉 ⇒ 他们的到家卡与特产全丢）。
  const arr = normalizeSideTrips(state);
  const at = arr.indexOf(trip);
  if (at >= 0) arr.splice(at, 1);

  const now = Date.now();
  if (E.isNight(now)) {
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    // ★ 2026-10-21：伙伴那趟的归家播报同样算 journey（`sayKind` 见 `pendingSayKind`）
    state.pending.push({ kind: 'side-return', sayKind: 'journey', snapshot, lines, images: souvenirImages, queuedAt: now });
    state.sideNextAt = 0;
    log(`[travel-whale] ${chatKey} 伙伴凌晨到家，明信片与播报压到 7 点后补发`);
  } else {
    try { await sendReturnCard(chatKey, state, snapshot, d); }
    catch (error) { log('[travel-whale] 伙伴到家明信片失败：' + (error?.message ?? error)); }
    // ★ 2026-10-21：归家播报 ＝ journey（这趟是"两位伙伴自己出去"，播报仍属"归家"）
    for (const line of lines) await sayP(chatKey, line, { kind: 'journey' });
    // ★ 2026-10-26：伙伴那趟的稀有特产图同样当场发（此前只存图鉴、从不展示）
    await sendSouvenirImages(chatKey, souvenirImages, 'journey');
    state.sideNextAt = E.nextDepartAt(now, Math.random, restRange());
  }
  log(`[travel-whale] ${chatKey} 伙伴那趟结束：${where}，特产 ${(trip.souvenirs || []).length} 件`);
  return { where, souvenirs: parts };
}

