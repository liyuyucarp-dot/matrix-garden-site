// 矩阵庭院（travel-whale）· 模块化组件：core/postcards-settle.js
// 职责：明信片送达账本、区域服装挑拣、途中/归家明信片寄送、稀有特产配图与归来结算（settleTrip）

import * as S from '../state.js?v=realworld-1';
import * as E from '../engine.js';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as TI from '../titles.js';
import * as RW from '../lib/real-world.js';
import * as OW from '../outfits.js';
import {
  REWARD_RARE_CARD,
  REWARD_RARE_SOUVENIR,
  buildDeps,
  cardDeps,
  cfg,
  isPrivateChat,
  log,
  titleCtx
} from './runtime-deps.js';
import { commentOnPostcard, gardenLevel } from './companions-voice.js';
import { pushMoodEvent } from './mood-battle-events.js';
import { companionHas, companionNoteFor, ownedCompanionIds, pickSkillFlavor, skillOwned } from './skills-appointments.js';
import {
  placeLabel,
  restRange,
  toneForTrip,
  tripRefOf,
  visibleRegionIds,
  visualBriefForTrip
} from './world-sync.js';
import { say, sayImage, sayP, sayImageP } from './broadcast.js';
import { autoHarvest } from './autonomy.js';
/** 衣柜名册（从 COMPANIONS 派生；拿不到就回退内置表）—— 2026-10-28 修「衣柜锁角色」 */
const girlsNowW = () => {
  try { return OW.wardrobeGirls({ companions: S.COMPANIONS }); }
  catch { return OW.WARDROBE_GIRLS; }
};



/**
 * 「这张明信片的图**真的投出去过**吗」的账本（key = album 条目的 id）。
 *
 * 为什么需要它：album 里的 `image` 只表示"图有本地文件"，**不表示图发出去过** ——
 * 生图成功但发送失败时两者会背离，而"补发"必须知道**到底欠哪几张**。
 * 2026-10-11 实录：补发那次模型只传了 `count: 2`（它自己 thinking 里写"风险是重复"），
 * 结果三张欠图里只补了两张 —— 因为它**没有任何依据判断欠几张**，只能猜。
 *
 * 为什么不写进 album 条目本身：`addPostcard` 是白名单赋值（state.js），改它要重启；
 * 而 `saveState` 落的是**整个对象** ⇒ 放 state 顶层同样持久，且只动本文件、热载即生效。
 */
export function markCardDelivered(state, cardId) {
  if (!state || !cardId) return;
  if (!state.cardDelivered || typeof state.cardDelivered !== 'object') state.cardDelivered = {};
  state.cardDelivered[String(cardId)] = Date.now();
}
export function deliveredMap(state) {
  const m = state?.cardDelivered;
  return m && typeof m === 'object' ? m : {};
}

/**
 * 「这张卡上**真发生过**什么」的标记本（key = album 条目 id）——★ 2026-10-13 晚新增，
 * 给相册那组称号用（"交手那张" / "被丢过去的那次"）。
 *
 * `state.cardFlags = { [cardId]: { battle, cross } }`。
 * 为什么不塞进 album 条目本身：`addPostcard` 是**白名单赋值**（state.js 是兄弟模块，
 * 改它要重启），而 `saveState` 落的是整个对象 ⇒ 放 state 顶层同样持久、且只动本文件
 * （同 `cardDelivered` 的做法，见它上面的说明）。
 * ⚠️ **旧卡没有这些标记** ⇒ 那两条称号只从这次之后算（跟"初次越界"同理）。
 */
/**
 * ★★ 2026-10-18 v3.20：这张卡属于**哪一趟**（key = album 条目 id，value = 那趟的 departAt）。
 * 为什么不写进 album 条目：`addPostcard` 是白名单赋值（state.js 是兄弟模块，改它要重启），
 * 而 `saveState` 落的是整个对象 ⇒ 放 state 顶层一样持久（同 `cardDelivered` / `cardFlags`）。
 * ⚠️ **老卡片没有这个映射** ⇒ `groupTrips()` 会退回"按时间间隔猜"，见那边的注释。
 */
export function noteCardTrip(state, cardId, tripKey) {
  if (!state || !cardId || !tripKey) return;
  if (!state.cardTrip || typeof state.cardTrip !== 'object') state.cardTrip = {};
  state.cardTrip[String(cardId)] = String(tripKey);
}

export function cardTripMap(state) {
  const m = state?.cardTrip;
  return m && typeof m === 'object' ? m : {};
}

export function noteCardFlags(state, cardId, flags = {}) {
  if (!state || !cardId) return;
  const battle = flags.battle === true;
  const cross = flags.cross === true;
  if (!battle && !cross) return;                 // 什么都没发生就不占地方
  if (!state.cardFlags || typeof state.cardFlags !== 'object') state.cardFlags = {};
  state.cardFlags[String(cardId)] = { battle, cross };
}

// ── 服装系统：去过哪些子区域 / 这一张谁穿什么（2026-10-14）─────────────────
//
//   ⚠️ 「去过」的口径是**两趟都算**（她自己那趟 + 闲置伙伴那趟）——
//     用户明确："解锁条件略微放宽：不要求她本人，旅伴去过也解锁服装"。
//     所以记录点分别落在 `settleTrip` 与 `settleSideTrip` 里（各一次）。
//   ⚠️ 键 = `地区id|子区域名`，子区域名与 `regions.json` 的 `countries[].name` **逐字一致**
//      —— `trip.country` 存的就是它（`trip.city` 是城市、比子区域更细，**别拿它当键**）。

/** 记一笔"到过这个子区域"（幂等：已记过就只保留首次时间）。 */
export function markAreaSeen(state, trip) {
  try {
    const rid = String(trip?.regionId || trip?.region || '').trim();
    const area = String(trip?.country || '').trim();
    if (!rid || !area) return false;
    if (!state.areasSeen || typeof state.areasSeen !== 'object') state.areasSeen = {};
    const k = `${rid}|${area}`;
    if (!state.areasSeen[k]) state.areasSeen[k] = Date.now();
    const pid = T.regionById(rid)?.parentWorldId;
    if (pid && !state.areasSeen[`${pid}|${area}`]) {
      state.areasSeen[`${pid}|${area}`] = Date.now();
    }
    return true;
  } catch { return false; }
}

/**
 * 这一张明信片上**谁穿什么** —— `{ 少女id: 服装id }`，交给 `composePostcard` 的 `outfits`。
 *   ⚠️ 只认**已拥有 + 确实绑给这一位**的（防手改存档把巫女服穿到小猫咪身上）；
 *     没指定 / 不合法的一律**不出现在这个对象里** ⇒ `postcard.js` 那边用默认着装。
 */
export function outfitsForCards(state) {
  const w = state?.wardrobe || {};
  const owned = (w.owned && typeof w.owned === 'object') ? w.owned : {};
  const worn = (w.worn && typeof w.worn === 'object') ? w.worn : {};
  const out = {};
  for (const [girl, id] of Object.entries(worn)) {
    const sid = String(id || '');
    // ★ 2026-10-17「借穿旅伴的默认那身」：不需要 owned（它不是商店货），也不受 who 限制；
    //   但要保证被借的那位**确实存在**、且不是她自己（借自己＝默认，没必要记）。
    if (sid.startsWith('default:')) {
      const whom = sid.slice(8);
      if (whom !== girl && girlsNowW().some((x) => x.id === whom)) out[girl] = sid;
      continue;
    }
    const o = OW.outfitOf(sid);
    // ★★ 2026-10-28（用户拍板）：服装改绑世界 —— **不再看 `o.who`**。
    //   这里原来有 `&& o.who === girl`，改绑之后它就变成"工具说换好了、照片还是默认着装"的元凶
    //   （换装对画面不生效，肉眼极难发现）。只校验"买过没有"。
    if (o && owned[o.id]) out[girl] = o.id;
  }
  // 头饰槽：图像那侧是 `composeCharacter(id, outfitId)` 的两参签名，头饰从这份状态里带进去
  // （见 postcard.js 的 setWardrobeHeadwear）。
  try { P.setWardrobeHeadwear(w.headwear); } catch { /* 老版本没有这个导出也无所谓 */ }
  try { P.setWardrobeHair(w.hair); } catch { /* 同上 */ }
  return out;
}

/** 「看衣柜」的正文（清单类 —— 走 `replyPanel` 直接发群，别回给模型让它压缩）。 */
export function wardrobeText(st) {
  const owned = (st?.wardrobe?.owned && typeof st.wardrobe.owned === 'object') ? st.wardrobe.owned : {};
  const worn = (st?.wardrobe?.worn && typeof st.wardrobe.worn === 'object') ? st.wardrobe.worn : {};
  const seen = (st?.areasSeen && typeof st.areasSeen === 'object') ? st.areasSeen : {};
  const has = (o) => owned[o.id] === true;
  // ⚠️ 解锁判据 = **去过那个子区域**（她自己或旅伴去都算，`areasSeen` 里两趟都记）
  const canBuy = (o) => Boolean(seen[`${o.region}|${o.area}`]);

  const mine = girlsNowW().map((g) => {
    const list = OW.outfitsOf(g.id).filter(has);
    const curId = String(worn[g.id] || '');
    const cur = curId ? OW.outfitOf(curId) : null;
    // 借穿旅伴的默认那身（default:<id>）—— outfitOf 查不到，单独显示
    const borrowed = !cur && curId.startsWith('default:') ? curId.slice(8) : '';
    const curLabel = cur ? `现在穿「${cur.name}」`
      : (borrowed ? `现在穿「${OW.girlName(borrowed)}的默认那身」` : '还穿默认那身');
    return `  ${g.emoji} ${g.name}：${curLabel}`
      + (list.length ? `（已有 ${list.length} 套：${list.map((o) => o.name).join('、')}）` : '（一套都没有）');
  });

  // ★★ 2026-10-15「探索解锁」（用户追加口径）：衣柜**只登"她已经知道的世界"那部分** ——
  //   初期（没去过任何异世界、也没穿越过）这里就是空的 ⇒ 衣柜天然"未解锁"，
  //   与装备网格 / 技能树**同一个口径**（都来自 `visibleRegionIds()`，别各写一套）。
  const visIds = visibleRegionIds(st);
  const visSet = visIds ? new Set(visIds.map(String)) : null;
  const pool = OW.OUTFITS.filter((o) => !visSet || visSet.has(String(o.region)));
  // ⚠️ `got` 按**全量**算：老档 / 手工改档可能存在"已拥有、但那个世界不在可见集里"的套
  //    —— 那种必须照旧算进"已解锁"，不能因为看不见就当没有（同技能树的"已会必须留住"）。
  const got = OW.OUTFITS.filter(has).length;
  const buyable = pool.filter((o) => !has(o) && canBuy(o));
  const locked = pool.filter((o) => !has(o) && !canBuy(o));

  // ★★ 2026-10-17（用户口径）：**衣柜这个功能的解锁条件 = 邀请过旅伴**，
  //   不再是"去过一趟异世界"。
  //   理由：衣柜是"给谁穿什么" —— 一个人都没邀请时它没有意义；
  //   邀请过之后至少能看各位的默认那身、并且**借来穿**（见下面"能借来穿的"）。
  //   ⚠️ 只改**门禁**；柜内每套衣服"能不能买"仍按原判据（去过 / 已拥有），
  //      别把两层混成一个（那正是 §「两套判据」踩过的坑）。
  const invited = ownedCompanionIds(st);            // 已邀请的旅伴 id（不含她自己）
  const borrowables = girlsNowW().filter((g) => g.id !== 'whale' && invited.includes(g.id));

  if (!invited.length && !got) {
    return [
      '👗 衣柜还没开 —— 先在商店里**邀请一位旅伴**（群友说"请一位伙伴"就是），',
      '有人一起出门，衣服才谈得上换。',
      '',
      ...mine,
      '',
      `💰 余额 ${Number(st?.wallet?.plankton) || 0} 亿 TOKEN`
    ].join('\n');
  }

  return [
    `👗 衣柜 —— 一共 ${pool.length} 套，已解锁 ${got} 套`
      + (borrowables.length ? `｜另有 ${borrowables.length} 位的默认那身能借穿` : ''),
    '',
    ...mine,
    '',
    borrowables.length
      ? `🎽 能**借来穿**的（已邀请的旅伴 · 不要钱）：\n`
        + borrowables.map((g) => `  · ${g.name}的默认那身 —— 说"穿${g.name}的默认"`).join('\n')
      : '',
    buyable.length
      ? `🛒 能买的（去过那儿了 · 每套 ${OW.OUTFIT_PRICE} 亿 TOKEN）：\n`
        + buyable.map((o) => `  · ${o.name} —— ${OW.OUTFIT_REGION_NAMES[o.region] || o.region}·${o.area}｜${OW.girlName(o.who)}穿`).join('\n')
      : '🛒 现在没有能买的 —— 先去没去过的地方走一趟（她自己或旅伴去都算）',
    locked.length
      ? `🔒 还没去过、买不了的 ${locked.length} 套：${locked.slice(0, 10).map((o) => o.name).join('、')}${locked.length > 10 ? ' …' : ''}`
      : '',
    '',
    `💰 余额 ${Number(st?.wallet?.plankton) || 0} 亿 TOKEN`
  ].filter((x) => x !== '').join('\n');
}

// ── 寄一张明信片 ──────────────────────────────────────────────────────────

/**
 * 处理"第 index 张明信片"。
 * 一条图 + 一条文字（题字+感想）—— 参考原版：明信片是图和手写话一起的。
 */
/**
 * 组并寄出一张明信片（**不记账** —— 序号与计数由调用方决定）。
 * @param {object} tripLike 需要 city/country/region(regionName)/style/spots
 */
export async function postOnce(chatKey, state, tripLike, plan, seq, total, deps, opts = {}) {
  const d = deps || buildDeps(chatKey, state);
  const entry = plan || {};
  // ★★ 2026-10-13 旅伴「特色」：**这张卡上都有谁** ⇒ 谁的特色生效。
  //   鲸鱼那趟看 `companion`，伙伴那趟看 `partners[]`（任一有即算）。
  //   ⚠️ 兼容「新入口 + 旧 state.js」：读不到字段 ⇒ 全为 false（等于没有特色，不报错）。
  const cardTraits = (() => {
    const ids = [tripLike.companion, ...(Array.isArray(tripLike.partners) ? tripLike.partners : [])]
      .map((x) => String(x || '')).filter(Boolean);
    const defs = ids.map((id) => (S.COMPANIONS || {})[id]).filter(Boolean);
    const rand = typeof d.rand === 'function' ? d.rand : Math.random;
    const flopChance = defs.reduce((m, x) => Math.max(m, Number(x.flopChance) || 0), 0);
    // ★ 2026-10-13 藏书阁：建了它 ⇒ 所有的明信片都走"话多"模式
    const longForm = defs.some((x) => x.longCaption === true) || gardenLevel(state, 'library') > 0;
    return {
      longForm,
      // ★★ 2026-10-13 旅伴养成「博览群书」：小书虫练出来之后题字上限 20 → 30 字。
      //   底数：平时 12 字；走"话多"模式 20 字；**她本人同行且练过**才到 30。
      // ★ v3.0：Kimi「誊录」（旅伴技能）⇒ 上限 20 → 28（她替你记下路过的每一句）。
      captionCap: (defs.some((x) => x.id === 'claude') && companionHas(state, 'well-read'))
        ? 30
        : ((defs.some((x) => x.id === 'kimi') && companionHas(state, 'transcribe'))
          ? 28 : (longForm ? 20 : 12)),
      flop: flopChance > 0 && rand() < flopChance
    };
  })();
  // ★★ 2026-10-13 技能树：这一张**发动哪一项风味**（每张只发一项；数值半不受影响）
  const skillFx = pickSkillFlavor(state, tripLike, { rand: (typeof d.rand === 'function' ? d.rand : Math.random) });
  // ★★ 2026-10-14「上下文窗口」：**途中卡轮换出镜** —— 这一张跟谁同框。
  //   · 到家卡（`opts.isReturn`）＝全体合照，不轮换；
  //   · 同行 <2 位（没建扩容）⇒ 就是领头那位 ⇒ 与从前**逐字节一致**；
  //   · 同行 ≥2 位 ⇒ 按 `seq` 轮换，保证每个人都露脸（否则"带了 3 位"却每张都是领头那位）。
  //   ⚠️ 只影响"这一张和谁同框"；**不碰 `cardTraits`**（那看的是整趟带了谁，是全局的）。
  const cardCompanion = (() => {
    const list = (Array.isArray(tripLike.party) ? tripLike.party : [])
      .map((x) => String(x || '')).filter(Boolean);
    if (list.length < 2 || (opts && opts.isReturn)) return tripLike.companion || '';
    return list[(Math.max(1, Number(seq) || 1) - 1) % list.length];
  })();
  const card = await P.composePostcard({
    city: tripLike.city,
    country: tripLike.country,
    region: tripLike.regionName,
    // ★ 2026-10-25 真实照片降级 / 坐标锚点要用的区域键（'europe'…；家/异世界不在真实区表）
    regionKey: String(tripLike.region || ''),
    spot: entry.spot || '',
    scene: entry.scene || '',
    // ★ v4.1：这一张是不是遭遇战、结果是什么（空 = 不是）
    battleOutcome: String(entry.battleOutcome || ''),
    // ★ v4.2：这一张的事件（锁构图 + 一句局势进场景）
    fusion: entry.event ? P.pickEventFusion((typeof d.rand === 'function' ? d.rand : Math.random), entry.event, ((Array.isArray(tripLike.party) && tripLike.party.length >= 2) ? '两位少女' : (tripLike.companion ? '两位少女' : '鲸鱼少女'))) : '',
    scene: [entry.scene || '', entry.event?.line || ''].filter(Boolean).join('；'),
    // ★★ 2026-10-18：这一趟所在世界的**纯视觉速写**（主色/材质/光线/人群）。
    //   拼进生图提示词的「世界」行 —— 在此之前景点卡完全没有地区/作品信息，
    //   模型只能按字面把"帝国皇宫"画成泛泛的白色奇幻城邦。
    world: visualBriefForTrip(tripLike),
    // ★★ 2026-10-18：影调（明度/光源/脏污）—— 没有这一行，世界观会被画成"富丽明亮"
    ...toneForTrip(tripLike),
    // ★ v3.21：这一趟的世界局势（有就用它压过地区影调）
    ...(tripLike?.phase ? {
      situation: String(tripLike.phase.brief || ''),
      ...(tripLike.phase.tone ? { tone: String(tripLike.phase.tone), toneAvoid: String(tripLike.phase.avoid || '') } : {})
    } : {}),
    // 计划里已经定好这张讲景点还是讲特产（见 trip.js 的 planCardContent）
    kind: entry.kind === 'souvenir' ? 'souvenir' : 'spot',
    souvenirs: entry.souvenirs || [],
    // ★ 2026-10-23：这一张**只讲**这几件特产（见 trip.js 的 souvenirFocusOf）。
    //   旧存档 / 热载窗口没有这个字段 ⇒ 空数组 ⇒ postcard 那边退回整批，行为与从前一致。
    souvenirFocus: Array.isArray(entry.souvenirFocus) ? entry.souvenirFocus : [],
    rarity: entry.rarity === 'rare' ? 'rare' : 'common',   // 出门前就抽定的
    style: tripLike.style,
    charStyle: tripLike.charStyle || '',
    // 本趟有没有同行伙伴（''=独自）——有就切到双人提示词
    // ★★ 2026-10-14「上下文窗口」：带多位时这里传的是**这一张轮换到的那位**（见上面的 `cardCompanion`）。
    companion: cardCompanion,
    // ★★ 2026-10-14「上下文窗口」：**到家那张**是"出门的所有人的合照" ⇒ 把这一趟的同行者
    //   （**不含她自己**；postcard.js 会拼成 `['whale', ...party]`）传下去。
    //   ⚠️ 判据用 `opts.isReturn` **而不是 `seq === total`** —— `total` 在途中那条链上
    //     数的是**途中卡张数**，最后一张途中卡也会 `seq === total`，会把它误判成回家卡。
    party: (opts && opts.isReturn) ? (Array.isArray(tripLike.party) ? tripLike.party : []) : [],
    // ★ 闲置伙伴自己去玩那趟：两位伙伴 id ⇒ 走"两位伙伴、**没有鲸鱼**"的提示词
    partners: Array.isArray(tripLike.partners) ? tripLike.partners : [],
    // ★★ 2026-10-14 同那趟的**文案**要"转述"（她在庭院里等，是它们自己去的）⇒
    //   这里把**名字**取好传过去：postcard.js 只有 `COMPANION_CHARACTER`（外观描述）、没有名字表。
    //   ⚠️ 取不到名字就传空数组 ⇒ 那边退回旧口径（不写错、只是不变），
    //     所以"新入口 + 旧 postcard.js"那段热载窗口是安全的。
    partnerNames: (Array.isArray(tripLike.partners) ? tripLike.partners : [])
      .map((id) => (S.COMPANIONS || {})[id]?.name || '').filter(Boolean),
    // ★★ 2026-10-14 她本人此刻在不在外面（两趟互相独立）——
    //   伙伴那趟的文案不能一律写"你留在庭院里等它们"。
    //   这一读是**准的**：同一次 tick 里鲸鱼那段 if 先跑（`state.trip` 已被 settleTrip 清空），
    //   所以"两人恰好同时到家"时这里读到 false = 她刚到家 —— 正是想要的。
    whaleAway: Boolean(state.trip),
    // ★ 该地该遇到的敌手（异世界专用）：非空 ⇒ 融合池里多出两条"战斗构图"
    foe: String(tripLike.foe || ''),
    // ★ 敌手的**外观锚**（异世界专用）：告诉生图模型这东西长什么样 ——
    //   它不联网查资料，只写"虫群/陆战队员"会被画成普通甲虫 / 现代特种兵。
    foeLook: String(tripLike.foeLook || ''),
    seq,
    total,
    // ★★ 2026-10-13 旅伴「特色」：某一张被**指定**了构图（小魔王的战斗明信片）—— 必须透传！
    //   ⚠️ 这里原来是**不传 fusion** 的：于是 composePostcard 只能按"全池随机"抽，
    //      战斗构图（池子里只有 2 条）几乎抽不中 —— 这正是那次老 bug 的形状（另见 postcard.js:803）。
    //   ⚠️ 优先级：`entry.fusion`（小魔王的战斗卡）**高于**技能构图 —— 那张卡是"必定惹事"的，
    //      不能被技能顶掉；技能构图只在没被指定时生效。
    fusion: String(entry.fusion || skillFx?.fusion || ''),
    // ★ 技能树：这一张发动的**感言**（只落感想；`postcard.js` 读它）
    skillNote: String(skillFx?.note || ''),
    // ★★ 2026-10-13 旅伴养成：题字上限（平时 12 / 话多 20 / 小书虫练过 30）
    captionCap: cardTraits.captionCap,
    // ★★ 旅伴养成「龙语」：同行的是小白龙、且她练出来了 ⇒ 战斗那张她会吼一句龙语。
    //   ⚠️ 由 `postcard.js` 判"这张是不是战斗卡"（battle 只有它知道），这里只把话递过去。
    companionNote: companionNoteFor(state, tripLike),
    // ★ 旅伴「特色」：小书虫「话多」（题字更长）+ 小猫咪「翻车」（约 10% 答非所问）
    longForm: cardTraits.longForm,
    flop: cardTraits.flop,
    whaleName: String(cfg().whaleName || '小鲸鱼'),
    timeText: new Date().toLocaleString('zh-CN', { hour12: false }),
    // ★ 2026-10-14 服装系统：这一张上**谁穿什么**（没换装 ⇒ 空对象 ⇒ 全部默认，与从前逐字一致）
    outfits: outfitsForCards(state)
  }, cardDeps(d));

  // ★★ 2026-10-13「随机事件影响心情」：把这张**真的发生了什么**记下来（sleep-mood 会取走结算）。
  //   ⚠️ `card.battle` 是新 postcard.js 才返回的字段 —— 旧模块下是 undefined ⇒ 不记（安全降级）。
  //   ★★ 2026-10-14：**事件必须标明是哪一趟的** ——「伙伴自己出去玩」那趟也走这条寄卡路径，
  //     而它的 `where` 是**伙伴们去的地方**。不标归属，日记素材会把伙伴的经历写成她的。
  //   ⚠️⚠️ 判据**绝不能用 `tripLike !== state.trip`** —— 卡片是**压着发的**：
  //     她夜里到家时 `settleTrip` 把播报塞进 `state.pending`，第二天早上（`!isNight`）才逐条发；
  //     那一刻 `state.trip` 早被清空（或已换成新的一趟）⇒ **她那趟的卡会被误判成"伙伴那趟"**
  //     （用户实测抓到：02:37 到家的那趟、07:01 才发的那张卡，被错标成了伙伴的）。
  //   ⇒ 用**对象自己身上的标记**：伙伴那趟在规划时就打了 `side: true`（见 trimSidePlan）。
  const evBy = (tripLike && tripLike.side === true) ? { by: 'mates' } : {};
  if (card.battle) {
    pushMoodEvent(state, 'battle-card', { where: placeLabel(tripLike), foe: String(tripLike.foe || ''), ...evBy });
  }
  if (card.rarity === 'rare') pushMoodEvent(state, 'rare-card', { where: placeLabel(tripLike), ...evBy });
  if (cardTraits.flop) pushMoodEvent(state, 'flop', { where: placeLabel(tripLike), ...evBy });

  // ★★ 2026-10-21「播报分类」：明信片（图 + 题词 + 感想）＝ `journey` ⇒ 按投递名单扇出。
  //   ⚠️ 用 `{ ...opts, kind }` 而不是直接写 `{ kind }`：`opts` 里还带着 `isReturn`
  //      （postcard.js 靠它认"到家卡"）和手工路径的 `broadcast:false`，都不能丢。
  const cardSayOpts = { ...opts, kind: 'journey' };
  // ★ 2026-10-25「明信片带经纬度」：目的地的现实坐标（3 位小数＝约100m，隐私纪律）。
  //   家/异世界/查不到 ⇒ null ⇒ 不带这行；区域中心兜底标"（约）"。缓存命中后零开销。
  const coordLine = await RW.coordsFor(
    { country: tripLike.country, city: tripLike.city, regionKey: tripLike.region },
    { allowNetwork: true }
  ).then((c) => (c ? `\n📍 ${c.lat}°N, ${c.lon}°E${c.estimated ? '（约）' : ''}` : '')).catch(() => '');
  let imgSent = false;
  if (card.imagePath) imgSent = await sayImageP(chatKey, card.imagePath, cardSayOpts);
  // 题字 + 感想合成一条；题字短、感想长，用换行分开
  // ⚔️ 前缀：让小魔王的"惹事"那张一眼可辨（与 ✨ 稀有标记同理，纯标记不改文案）
  // ★ 真实照片顶替时把署名行缀在最后（版权纪律：用真实图必带来源）
  const creditLine = card.imageCredit ? `\n${card.imageCredit}` : '';
  await sayP(chatKey, (entry.rage ? '⚔️ ' : '') + (card.captionOut || card.caption) + '\n' + card.thought + creditLine + coordLine, cardSayOpts);

  const added = S.addPostcard(state, {
    city: tripLike.city, country: tripLike.country, region: tripLike.region,
    spot: entry.spot || '', style: tripLike.style,
    kind: entry.kind === 'souvenir' ? 'souvenir' : 'spot',
    souvenirs: entry.souvenirs || [],
    souvenirFocus: Array.isArray(entry.souvenirFocus) ? entry.souvenirFocus : [],
    rarity: card.rarity === 'rare' ? 'rare' : 'common',
    charStyle: tripLike.charStyle || '',
    companion: tripLike.companion || '',
    imageError: String(card.imageError || ''),   // 非空 = 这张没配图的原因
    caption: card.caption, thought: card.thought, image: card.imagePath,
    credit: String(card.imageCredit || '')   // ★ 真实照片署名（生图 = 空）
  });
  // ★ v3.20：记下"这张属于哪一趟"（相册按趟分页要用）
  noteCardTrip(state, added?.id, String(tripLike.departAt || tripLike.returnAt || ''));
  // 图**真投出去了**才记账（生图成功 ≠ 发得出去，两件事必须分开）
  if (imgSent) markCardDelivered(state, added?.id);
  // ★ 2026-10-13 晚：把"这张卡上真发生了什么"记进 `state.cardFlags`（相册那组称号要）。
  //   `card.battle` 只有新 postcard.js 才返回、`tripLike.crossedOver` 一直都在 —— 取不到就是 false。
  noteCardFlags(state, added?.id, { battle: card.battle === true, cross: tripLike.crossedOver === true });
  // ★★ 2026-10-14「留守的旅伴来评论」（§115）：**卡已经发出去了**，才轮到评论。
  //   ★ 2026-10-21：评论跟着**这张卡**走 —— 所以传的是 `cardSayOpts`（kind=journey），
  //     否则投递名单里其它群会看到一张"没有评论"的卡，而「家」多一句，看起来像丢消息。
  //   ⚠️ 必须 try/catch 包住 —— 评论是锦上添花，模型抽风/发送失败都**不许**影响明信片本身
  //      （更不能让异常冒到 tick 里，那会打断整轮推进）。
  try {
    await commentOnPostcard(chatKey, state, tripLike, entry, card, cardSayOpts, d);
  } catch (e) {
    log(`[travel-whale] 明信片评论失败（不影响正片）：${e?.message ?? e}`);
  }
  return true;
}

/**
 * 途中第 index 张明信片。
 * @param {'trip'|object} [which] 哪一趟：默认鲸鱼那趟（`'trip'`），多趟化后传**趟对象**。
 */
export async function sendCard(chatKey, state, index, deps, which = 'trip') {
  const trip = tripRefOf(state, which);
  if (!trip) return false;
  const isSide = trip !== state.trip;                 // 判"是不是伙伴那趟"改看对象本身
  // 寄什么在出门前就定好了（cardPlan）；这里只按序号取，不再临时算
  const plan = Array.isArray(trip.cardPlan) ? trip.cardPlan : [];
  const entry = plan[index] || { kind: 'spot', spot: '', scene: '' };
  const total = trip.cardTimes.length;
  await postOnce(chatKey, state, trip, entry, index + 1, total, deps);
  trip.cardsSent = index + 1;
  log(`[travel-whale] ${chatKey} 寄出${isSide ? '伙伴' : ''}途中第 ${index + 1}/${total} 张（${trip.city}·${String(entry.spot || entry.kind)}）`);
  return true;
}

/**
 * 到家时**额外**寄一张。
 *
 * 需求是「到家之后反馈明信片和特产」，所以这张不计入 trip.cardTimes ——
 * 那是「途中」的张数，出行前就定死了（小份 1~2 / 中份 2~3 / 大份 2~4）。
 * 用旅程里最后一个景点，序号接在途中那些之后。
 */
export async function sendReturnCard(chatKey, state, tripLike, deps) {
  const plan = Array.isArray(tripLike.cardPlan) ? tripLike.cardPlan : [];
  const mid = Array.isArray(tripLike.cardTimes) ? tripLike.cardTimes.length : 0;
  // 到家那张在计划里是最后一条；景点不够时它已经被安排成「特产明信片」
  const entry = plan[plan.length - 1] || { kind: 'spot', spot: '', scene: '' };
  // ★ 2026-10-14「上下文窗口」：`isReturn` 是**唯一**能把这张认成"到家卡"的判据
  //   （`seq === total` 在途中那条链上会误判，见 postOnce 里的注释）。
  await postOnce(chatKey, state, tripLike, entry, mid + 1, mid + 1, deps, { isReturn: true });
  log('[travel-whale] ' + chatKey + ' 寄出到家明信片（' + tripLike.city + '·' + String(entry.spot || entry.kind) + '）');
  return true;
}

// ── 归来结算 ──────────────────────────────────────────────────────────────

/** 给稀有特产生成图鉴图（失败返回空字符串，图鉴仍记文字）。 */
export async function makeSouvenirImage(chatKey, trip, name, deps, { outfits = null, charStyle = '' } = {}) {
  try {
    // ★★ 2026-10-14 谁带回来的谁捧着（原来**写死鲸鱼**）。
    //   伙伴那趟与鲸鱼那趟**互相独立**（tick 里是两个并列的 if）⇒ 伙伴到家那一刻，
    //   她本人可能还在外面 —— "她捧着展示"于是经常是荒谬的。分流逻辑收在 postcard.js 的
    //   `buildSouvenirPrompt`（伙伴的外观描述表 `COMPANION_CHARACTER` 住在那儿）。
    //   ⚠️ 包装降级：postcard.js 是兄弟模块，热载期可能是"新 index + 旧 postcard" ⇒
    //     那时新函数不存在，退回与改动前**逐字等价**的旧拼法（不裸调，免 TypeError）。
    const prompt = (typeof P.buildSouvenirPrompt === 'function')
      ? P.buildSouvenirPrompt({
        name,
        partners: Array.isArray(trip.partners) ? trip.partners : [],
        scene: `${placeLabel(trip)} 的标志性背景`,
        style: trip.style,
        // ★ 2026-10-26：图鉴图与明信片**同一套人设** —— 谁穿什么、这一趟什么人物画法。
        //   原来这两维没传 ⇒ 同一趟里明信片是换装后的样子、特产图却是默认着装 + 默认笔触。
        outfits,
        charStyle,
        // ★ 2026-10-18：图鉴图也带世界基调（不然那件东西会飘在泛泛背景里）
        regionName: trip.regionName || '',
        world: visualBriefForTrip(trip),
        ...toneForTrip(trip),
        ...(trip?.phase ? {
          situation: String(trip.phase.brief || ''),
          ...(trip.phase.tone ? { tone: String(trip.phase.tone), toneAvoid: String(trip.phase.avoid || '') } : {})
        } : {})
      })
      : [
        P.WHALE_CHARACTER,
        ...(charStyle ? [`人物画法：${charStyle}`] : []),
        `动作：捧着「${name}」`,
        `场景：${placeLabel(trip)} 的标志性背景`,
        `风格：${trip.style}`,
        `构图：以「${name}」为主体，鲸鱼少女只拿这一样东西，居中特写，无文字水印`,
        ...(typeof P.anatomyHint === 'function' ? [P.anatomyHint()] : []),
        P.NEGATIVE_HINT
      ].join('\n');
    const res = await deps.imageGen(prompt);
    if (res?.ok && Array.isArray(res.images) && res.images.length) {
      return await P.makeImageSaver(chatKey, { subdir: 'souvenirs', log })(res.images[0]);
    }
  } catch (error) {
    log(`[travel-whale] 特产图生成失败：${error?.message ?? error}`);
  }
  return '';
}

/**
 * 这一趟的特产入图鉴 —— **鲸鱼那趟与伙伴那趟共用这一份**（原来两段复制粘贴）。
 *
 * ★★ 2026-10-26：稀有特产图**只在第一次拿到时画**。原来无条件画一张、
 *   再交给 `addSouvenir` —— 而它见到 `prev.image` 就**不覆盖** ⇒ 重复带回的稀有特产
 *   每次白花一次生图，落一地没有任何条目引用的图（线上实测 14 张里 4 张没人引用）。
 *   README 的规矩本来也是「重复获得只累加计数，不再出图」。
 *
 * @returns {Promise<{parts:string[], images:Array<{name:string,image:string}>}>}
 *   `images` = **这一趟新画出来的**（调用方负责在归家播报后发出去）
 */
export async function recordTripSouvenirs(chatKey, state, trip, deps) {
  const parts = [];
  const images = [];
  const outfits = outfitsForCards(state);
  const charStyle = String(trip.charStyle || '');
  for (const s of trip.souvenirs || []) {
    const key = String(s.name || '').trim();
    const prev = (key && state.souvenirs && typeof state.souvenirs === 'object')
      ? state.souvenirs[key] : null;
    let image = '';
    if (s.isRare && !prev?.image) {
      image = await makeSouvenirImage(chatKey, trip, s.name, deps, { outfits, charStyle });
      if (image) images.push({ name: key, image });
    }
    const r = S.addSouvenir(state, {
      name: s.name, city: trip.city, country: trip.country,
      rarity: s.isRare ? 'rare' : (s.label || 'common'),
      // ★ 2026-10-14：模型打标的分类（food/plant/relic）—— 决定它能不能吃、能不能种。
      kind: s.kind || '',
      // ★★ v3.2 特产批注（Kimi「博闻」）：抽特产时顺带要的那一行，进图鉴的 `desc`。
      //   `addSouvenir` **只在新建条目时写 desc**（重复带回会更新 count/stock，但不覆盖批注）
      //   ⇒ 一件特产的第一行批注 = 第一次带回来的那一趟，之后不再改。
      desc: s.note || '',
      image
    });
    // 三档各有各的标记：rare 明确标出、uncommon 带 ✦、common 什么都不加。
    const label = s.isRare ? 'rare' : String(s.label || 'common');
    const mark = s.isRare ? '（稀有！）' : (label === 'uncommon' ? '✦' : '');
    const cnt = (!s.isRare && !r.isNew) ? `×${r.entry?.count}` : '';
    parts.push(`${s.name}${mark}${cnt}`);
  }
  return { parts, images };
}

/** 把这一趟**新画出来**的稀有特产图发出去（失败不打断后面的播报）。 */
export async function sendSouvenirImages(chatKey, images, kind = 'journey') {
  for (const it of (Array.isArray(images) ? images : [])) {
    const file = String(it?.image || '');
    if (!file) continue;
    try { await sayImageP(chatKey, file, { kind }); }
    catch (error) { log(`[travel-whale] 稀有特产图发送失败：${error?.message ?? error}`); }
  }
}

/**
 * 旅程结束：记到访 → 特产入图鉴 → 称号 → 播报 → 归位。
 * 顺序有讲究：先落数据再播报，播报失败不影响数据。
 */
export async function settleTrip(chatKey, state, deps) {
  const trip = state.trip;
  if (!trip) return null;
  const d = deps || buildDeps(chatKey, state);

  // ★ v3.18 ①：到家也自动收一次 —— 顺带把余额刷新，归来播报里的数字才是新的
  const harvested = autoHarvest(state, '归来');

  // ① 到访（城市 + 景点两套）
  S.recordVisit(state, {
    city: trip.city, country: trip.country, region: trip.region,
    source: trip.source || 'pool',
    spots: (trip.spots || []).map((s) => s.name)
  });

  // ── ★★ v4.1 遭遇战结算（必须在特产入图鉴**之前**：吃亏要当场扣掉一件）──
  const battleLog = [];
  try {
    const sent = (Array.isArray(trip.cardPlan) ? trip.cardPlan : [])
      .slice(0, Number(trip.cardsSent) || 0);
    for (const c of sent) {
      const oc = String(c?.battleOutcome || '');
      if (!oc) continue;
      const where = placeLabel(trip);
      const foe = String(trip.foe || '');
      if (oc === 'win') {
        pushMoodEvent(state, 'battle-win', { where, foe });
        battleLog.push('压制');
        // 「符卡宣言」：压制时多带一件（复制这一趟第一件特产）
        if (skillOwned(state)['spell-declare'] && Array.isArray(trip.souvenirs) && trip.souvenirs.length) {
          const pick = trip.souvenirs[0];
          trip.souvenirs.push({ ...pick });
          battleLog.push('（符卡宣言：多带一件）');
        }
      } else if (oc === 'lose') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const i = list.findIndex((s) => !s.isRare);
        const cut = i >= 0 ? list.splice(i, 1)[0] : list.pop();
        if (cut) {
          battleLog.push(`吃亏（丢了「${cut.name}」）`);
        } else {
          state.wallet.plankton = Math.max(0, (Number(state.wallet?.plankton) || 0) - 100);
          battleLog.push('吃亏（没东西可丢，掉了 100 亿 TOKEN）');
        }
        pushMoodEvent(state, 'battle-lose', { where, foe });
      } else {
        pushMoodEvent(state, 'battle-card', { where, foe });
        battleLog.push('平手');
      }
    }
    if (battleLog.length) log(`[travel-whale] 遭遇结算：${battleLog.join('、')}`);
  } catch (error) {
    log(`[travel-whale] 遭遇结算失败：${error?.message ?? error}`);
  }

  // ── ★★ v4.2 事件结算（同样放在特产入图鉴之前）──
  try {
    const sentE = (Array.isArray(trip.cardPlan) ? trip.cardPlan : [])
      .slice(0, Number(trip.cardsSent) || 0);
    for (const c of sentE) {
      const ev = c?.event;
      if (!ev) continue;
      const where = placeLabel(trip);
      pushMoodEvent(state, ev.mood === 'good' ? 'event-good' : 'event-bad', { where, event: ev.name });
      const type = String(ev.effect?.type || 'none');
      if (type === 'bonus-souvenir') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const pick = list.find((s) => !s.isRare) || list[0];
        if (pick) { trip.souvenirs.push({ ...pick }); battleLog.push(`${ev.name}（多带一件）`); }
        else battleLog.push(ev.name);
      } else if (type === 'lose-souvenir') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const i = list.findIndex((s) => !s.isRare);
        const cut = i >= 0 ? list.splice(i, 1)[0] : list.pop();
        if (cut) battleLog.push(`${ev.name}（丢了「${cut.name}」）`);
        else {
          state.wallet.plankton = Math.max(0, (Number(state.wallet?.plankton) || 0) - 100);
          battleLog.push(`${ev.name}（没东西可丢，掉了 100 亿）`);
        }
      } else {
        battleLog.push(ev.name);
      }
    }
  } catch (error) {
    log(`[travel-whale] 事件结算失败：${error?.message ?? error}`);
  }

  // ② 特产入图鉴（稀有的才配图；重复带回的**不再重画**，见 recordTripSouvenirs）
  const { parts, images: souvenirImages } = await recordTripSouvenirs(chatKey, state, trip, d);

  // ③b ★★ 2026-10-13 旅伴养成：记下"这位伙伴陪她到过哪些异世界"（旅伴技能的门槛就数这个）。
  //   只在**真的到了**才记（这里 = 归来结算）；穿越到的地方也算 —— 那确实到过。
  //   ⚠️ 只认异世界（`regionFictional`），现实地区不算"走过一个世界"。
  if (trip.regionFictional === true && trip.companion) {
    const cid = String(trip.companion);
    const rid = String(trip.regionId || '');
    if (rid) {
      state.whale = state.whale || {};
      const all = (state.whale.companionWorlds && typeof state.whale.companionWorlds === 'object')
        ? state.whale.companionWorlds : (state.whale.companionWorlds = {});
      const cur = Array.isArray(all[cid]) ? all[cid].map(String) : [];
      if (!cur.includes(rid)) all[cid] = [...cur, rid];
    }
  }

  // ③c ★ 2026-10-26（主人口径）：**累计同行趟数** + **城市足迹**（面板「旅伴档案 / 同行足迹」用）。
  //   与 ③b 刻意分开，互不影响：
  //     · ③b `companionWorlds` 只记**带路的那位**、且按"去过几个不同异世界"去重 —— 旅伴技能门槛数它；
  //     · ③c 记**这一趟所有同行的人**（trip.mates），且**按趟累加**（同一世界去两次算两趟）。
  //   ⇒ 换口径不会动摇技能解锁；面板两栏各说各的（"带路去过 N 个异世界" / "一共同行 M 趟"）。
  //   只认异世界（regionFictional），与 ③b 一致；现实城市不计入"异世界同行"。
  if (trip.regionFictional === true) {
    const partyIds = (Array.isArray(trip.mates) && trip.mates.length
      ? trip.mates.map((m) => String(m?.id || m || ''))
      : [String(trip.companion || '')]).filter(Boolean);
    const rid = String(trip.regionId || '');
    const city = String(trip.city || '');
    if (partyIds.length) {
      state.whale = state.whale || {};
      const trips = (state.whale.compTrips && typeof state.whale.compTrips === 'object')
        ? state.whale.compTrips : (state.whale.compTrips = {});
      const foot = (state.whale.mateCities && typeof state.whale.mateCities === 'object')
        ? state.whale.mateCities : (state.whale.mateCities = {});
      for (const cid of partyIds) {
        trips[cid] = (Number(trips[cid]) || 0) + 1;
        if (!city) continue;
        const bucket = (foot[cid] && typeof foot[cid] === 'object') ? foot[cid] : (foot[cid] = {});
        const key = `${rid}|${city}`;
        const prev = bucket[key] || {};
        bucket[key] = {
          regionId: rid,
          city,
          country: String(trip.country || ''),
          n: (Number(prev.n) || 0) + 1,
          firstAt: Number(prev.firstAt) || Date.now(),
          lastAt: Date.now()
        };
      }
    }
  }

  // ③ 单趟特产数（"满载而归"）
  const n = (trip.souvenirs || []).length;
  state.stats.maxSouvenirsPerTrip = Math.max(Number(state.stats.maxSouvenirsPerTrip) || 0, n);

  // ④ 称号
  S.refreshStats(state);
  const newTitles = TI.evaluateTitles(state, titleCtx());
  TI.markTitles(state, newTitles);

  // ⑤ 组播报文案（先组好，发给谁/什么时候发由下面决定）
  const where = `${placeLabel(trip)}`;
  const souvText = parts.length ? `带回来的东西：${parts.join('、')}` : '这趟什么也没带回来';
  const harvestText = harvested > 0 ? `\n（顺手收了 ${harvested} 亿 TOKEN）` : '';
  const battleText = battleLog.length ? `\n⚔️ 路上：${battleLog.join('，')}` : '';
  const lines = [`🐋 我回来啦。这趟去了 ${where}。\n${souvText}${harvestText}${battleText}`];
  // ★★ 2026-10-21「播报分类」：`lines` 现在**只装归家播报本身**（journey ⇒ 按投递名单扇出）；
  //   稀有奖励 / 罕见特产注 / 称号解锁 落进 `sysLines`（system ⇒ 只发回「家」）。
  //   用户原话：「购买、邀请、成就等系统信息不再播报，避免刷屏」—— 称号就是"成就"那一类。
  //   ⚠️ 两段**顺序不变**（先归家播报、再奖励与称号），只是各自走各自的扇出规则。
  const sysLines = [];
  // ── 稀有收获奖励 ──
  // 明信片那边用 cardPlan 数（出门前就定死了稀有度），只算**真的寄出去**的：
  //   途中 = 前 cardsSent 张；到家那张固定是计划里的最后一条。
  const sentPlan = [
    ...(trip.cardPlan || []).slice(0, Number(trip.cardsSent) || 0),
    ...(trip.cardPlan || []).slice(-1)
  ];
  const rareSouvCount = (trip.souvenirs || []).filter((x) => x.isRare).length;
  const rareCardCount = sentPlan.filter((x) => x && x.rarity === 'rare').length;
  // ★ 维斯特洛「有债必偿」：奖励金额 ×3（+50/+20 → +150/+60）。
  //   读的是 `syncSkillNumbers` 落下的**纯数字**（老存档没有这个字段 ⇒ 退回 1 ⇒ 与从前一致）。
  const rewardMult = Math.max(1, Number(state?.whale?.rareRewardMult) || 1);
  const reward = (rareSouvCount * REWARD_RARE_SOUVENIR + rareCardCount * REWARD_RARE_CARD) * rewardMult;
  if (reward > 0) {
    S.grantPlankton(state, reward);
    const bits = [];
    if (rareSouvCount) bits.push('稀有特产 ×' + rareSouvCount);
    if (rareCardCount) bits.push('稀有明信片 ×' + rareCardCount);
    sysLines.push('✨ 这趟撞上' + bits.join('、') + '，额外捡到 ' + reward + ' 亿 TOKEN');
  }

  const uncommons = (trip.souvenirs || []).filter((x) => !x.isRare && x.label === 'uncommon');
  if (uncommons.length) sysLines.push('（✦ 是罕见特产 —— 比普通货色稀罕一点）');
  for (const t of newTitles) sysLines.push(`${t.icon} 解锁称号：${t.name}（+${t.points || 0} 成就值）—— ${t.desc}`);

  // ⑥ 留一份「旅程快照」——存档里的 trip 马上就要清掉，但夜里压住的那张
  //    到家明信片要等到早上才生成，得靠它才能取到城市/景点/画风。
  //
  // ★★ 2026-10-13 修（用户报障「早上到家那张明信片里狐狸不见了」）：
  //    原来这里是**手动挑字段**的白名单，只抄了 8 个字段、**漏掉 `companion`** ⇒
  //    到家那张明信片（**白天直接发**和**夜里压到早上补发**，两条路都用这份快照）
  //    在 `composePostcard` 里 `duo = Boolean(pt.companion)` 被判定成**单人** ⇒
  //    提示词走单人路径 ⇒ **一路同行的伙伴在画面里消失**。
  //    ⚠️ 同一文件里「闲置伙伴那趟」（sideTrip）的 snapshot 是 `{ ...trip }` **全量拷贝**，
  //       两者本该同构（下面补发段那句注释就是这么写的）—— 现在才真的同构。
  //    ⚠️ 漏掉的不止 companion：`charStyle`（人物画法）、`foe`/`foeLook`（异世界敌手）、
  //       `regionId`/`regionFictional`/`foeKind`/`missingTraits` 也全丢了 —— 全量拷贝一次修齐。
  //    ⚠️ 教训：**中间层只解构一部分字段 = 静默失效**（本项目的老坑，这是又一次）。
  const snapshot = {
    ...trip,
    spots: trip.spots || [], cardTimes: trip.cardTimes || [], cardPlan: trip.cardPlan || []
  };

  // ★★ 2026-10-13「随机事件影响心情」：这趟的结果记两笔
  //   （带回稀有特产 = 好事；平平安安到家 = 小确幸）。地点用她真去过的那里，why 才具体。
  {
    const where = placeLabel(trip);
    const rareN = (trip.souvenirs || []).filter((x) => x.isRare).length;
    if (rareN > 0) pushMoodEvent(state, 'rare-souvenir', { where, n: rareN });
    pushMoodEvent(state, 'trip-home', { where });
  }

  // ⑦ 归位（数据先落定，说话可以晚点再说）
  // ★ 2026-10-14 服装系统：她这趟到过的**子区域**记一笔（解锁服装要用；两趟都算）
  markAreaSeen(state, trip);
  state.whale.charm = '';          // 护身符单趟生效，回家即失效
  state.trip = null;
  // ★★ 2026-10-13 step4「在家的大合照」：记下**到家时刻**并清掉上一趟的拍摄标记。
  //    判据是「在家待满 N 小时（默认 8）且这一趟还没拍过」⇒ 每趟回家只拍 1 张，
  //    下一趟到家会自动重置。夜里那支（压到早上补发）也走这里 —— 所以"在家时间"
  //    从**真实到家时刻**起算，而不是从播报时刻起算（用户口径："在家的时间"）。
  state.homeSince = Date.now();
  state.homeShotAt = 0;

  // ⑧ 到家反馈 = **一张明信片 + 播报**。
  //    夜里到家不吵人：两样一起压到早上 7 点后补发。
  //    ⚠️ 顺带一个副作用是**刻意**的：下次自动出发的基准是「播报真正发出的时刻」
  //       + **休息区间**（默认 24~48 小时，见 `restRange()`），不是「到家时刻」。压住期间 nextDepartAt 置 0，
  //       shouldAutoDepart 会拦住它，不会偷偷溜走。
  const now = Date.now();
  if (E.isNight(now)) {
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    // ★ 2026-10-21：`kind:'return'` 是"待补发事项的种类"（老字段，别动）；
    //   `sayKind:'journey'` 才是"补发时按哪一类扇出"（新字段，见 `pendingSayKind`）。
    //   `sysLines` 只在老存档里缺失 ⇒ 消费端按"没有"处理，不会抛错。
    state.pending.push({ kind: 'return', sayKind: 'journey', snapshot, lines, sysLines, images: souvenirImages, queuedAt: now });
    state.nextDepartAt = 0;
    log('[travel-whale] ' + chatKey + ' 凌晨到家，明信片与播报压到 7 点后补发');
  } else {
    try { await sendReturnCard(chatKey, state, snapshot, d); }
    catch (error) { log('[travel-whale] 到家明信片失败：' + (error?.message ?? error)); }
    // ★ 2026-10-21：归家播报 ＝ journey（扇出到投递名单）；奖励与称号 ＝ system（只发回家）
    for (const line of lines) await sayP(chatKey, line, { kind: 'journey' });
    // ★★ 2026-10-26：稀有特产图**跟归家播报一起发**。此前它只被写进 `state.souvenirs[].image`，
    //   图鉴页也不显示、没有任何工具能调它 ⇒ 生成完就"消失"（用户报的就是这个）。
    await sendSouvenirImages(chatKey, souvenirImages, 'journey');
    for (const line of sysLines) await sayP(chatKey, line, { kind: 'system' });
    // 私聊永不自发出发，就不必排下次；群聊才排（播报时刻 + 休息区间）。
    // ★ 回家后的休息区间走 `restRange()`（默认 24~48 小时；可在技能设置里改）——
    //   这样"她在家的时间"不再是回家后的零头。两条自动出门共用 `E.nextDepartAt`。
    state.nextDepartAt = isPrivateChat(chatKey) ? 0 : E.nextDepartAt(now, Math.random, restRange());
  }

  log(`[travel-whale] ${chatKey} 旅程结束：${where}，特产 ${n} 件，新称号 ${newTitles.length} 个`);
  return { where, souvenirs: parts, newTitles };
}

// ── ★★ 在家的大合照（2026-10-13 大更新 step4）──────────────────────────────
//
// 用户口径（原话）：「我希望她在家的时候也发'明信片'——拍大合照。每次【回到家并且在家的
//   时间达到 8 小时后】，和所有在家的 AI 娘拍【1】张 大合照，用那种'举着镜头自拍'的感觉，
//   拍**画幅和旅行明信片不同的横板**大合照。」
//
// 与旅行明信片的关系：**共用发送链路（`sayImage` 扇出 + `say`）与相册**，只有三处不同 ——
//   ① **画幅**：横板（`H.HOME_SHOT_SIZE`，1536x1024），而旅行明信片是设置里的方板；
//   ② **提示词**：`home.js` 的 `buildGroupPrompt`（庭院外观 + 星空 + 自拍构图 + N 人解剖约束）；
