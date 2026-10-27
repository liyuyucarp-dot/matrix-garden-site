// 矩阵庭院（travel-whale）· 模块化组件：core/shop-album-menu.js
// 职责：商店货架表、加急明信片、相册按趟分组、菜单图（商店/图鉴/相册）数据装配

import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as H from '../help.js';
import * as HM from '../home.js';
import * as SV from '../souvenir.js';
import { buildDeps, cardDeps, cfg, log } from './runtime-deps.js';
import { companionEmoji } from './companions-voice.js';
import { helpDataFor, skillOwned } from './skills-appointments.js';
import { isRegionUnlocked, isRegionVisible, placeLabel } from './world-sync.js';
import { say, sayImage } from './broadcast.js';
import { cardTripMap, outfitsForCards, postOnce } from './postcards-settle.js';
import { farmCapNow } from './pantry-farm.js';

// ── 商店 ──────────────────────────────────────────────────────────────────
//   价格不高、不限购，但**货架有库存**（会补货）—— 保留一点"抢"的感觉。

// 名称/价格/时长全部从 state.js 读，这里不写字面量 ——
// 免得改了数值只改了商店、说明图和提示词还是旧的。
//
// ⚠️ 为什么做成**惰性**（而不是在模块顶层直接建表）：
//    热重载只给**入口文件**加 ?t= 时间戳，子模块（state.js 等）会被 ESM
//    缓存永久锁住。于是会出现"新 index.js + 旧 state.js"的组合 ——
//    如果顶层就 `S.PRICES.food[...]`，这种组合会让**整个技能加载失败**，
//    而且加载器对"热重载失败"是**静默**的（只记进内存，不写日志），
//    表现为"改了代码毫无反应"，极难排查（这个坑真踩过）。
//    改成惰性后，即使字段对不上也只是商店功能报错，其余 9 个工具照常。
/**
 * ★★ 2026-10-13（用户口径）：「刷新货架」的价格。
 *   它不是**商品**而是**消耗动作** —— 不进背包、不限量、不受货架库存约束，
 *   所以放在 `whale_buy` 里当独立分支处理，而不是塞进 `shopTable()`。
 *   为什么要有它：**这游戏的真约束是货架库存（7 天才补一次），不是钱**
 *   ⇒ 花钱买"立刻补满"是唯一能持续吸走过剩 TOKEN 的口子（分析见 `_qcheck` 的消耗口文档）。
 */
export const REFRESH_PRICE = 1000;

/** ★★ 2026-10-13（用户口径）：「加急明信片」道具的价格。买下后可以用它**立刻**寄一张。 */
export const EXPRESS_PRICE = 1000;

/**
 * ★ 2026-10-13（用户口径）：**单次进货量**的上限（原来是 20，减半成 10）。
 *   抽成常量是因为**帮助图要写它**（"单次最多买 N 份"）——
 *   写死两处必然漂移（这项目已经栽过两次"列举性文案写死名单"）。
 */
export const BUY_MAX_PER_ORDER = 10;

/**
 * ★★ 2026-10-13：**技能树的两个"商店侧"数值** —— 都在入口文件里，所以直接读技能表、不用过桥。
 *   · 交界地「赐福点」：刷新货架 1000 → 500 亿 TOKEN；
 *   · 高达「补给舰」：单次进货上限 10 → 20。
 *   ⚠️ 这两个**不能**像 `rareBonus` 那样靠 `syncSkillNumbers` 落进存档 ——
 *     那个函数只在 `depart()` 里跑，而买/刷新是**另一次工具调用**，不同步。
 */
export function refreshPriceOf(st) {
  return skillOwned(st)['grace-site'] ? Math.round(REFRESH_PRICE / 2) : REFRESH_PRICE;
}

export function buyCapOf(st) {
  return skillOwned(st)['supply-ship'] ? BUY_MAX_PER_ORDER * 2 : BUY_MAX_PER_ORDER;
}

let _shopCache = null;
export function shopTable() {
  if (_shopCache) return _shopCache;
  const P = S.PRICES || {};
  const fp = P.food || {};
  const cp = P.charm || {};
  const foodRow = (id, stock) => {
    const t = S.FOOD_TIERS[id] || {};
    return { kind: 'food', id, name: t.name || id, price: fp[id] || 0, stock,
             desc: '走 ' + (t.minH ?? '?') + '~' + (t.maxH ?? '?') + ' 小时' };
  };
  const charmRow = (id, stock) => {
    const t = S.CHARM_TYPES[id] || {};
    return { kind: 'charm', id, name: t.name || id, price: cp[id] || 0, stock,
             // ⚠️ 不能只写「稀有概率 +X%」：luck 对**特产**是全额、对**明信片**要乘
             //    CARD_LUCK_FACTOR(0.5)，写成一个数就是在骗人（实测差一倍）。
             desc: '特产稀有 +' + Math.round((Number(t.luck) || 0) * 100) + '%'
               + ' / 明信片 +' + Math.round((Number(t.luck) || 0) * T.CARD_LUCK_FACTOR * 100) + '%' };
  };
  _shopCache = {
    'food:small': foodRow('small', 20),
    'food:normal': foodRow('normal', 20),
    'food:large': foodRow('large', 20),
    'charm:shell': charmRow('shell', 6),
    'charm:scale': charmRow('scale', 4),
    'charm:pearl': charmRow('pearl', 2),
    // ★★ 2026-10-13（用户口径，**当天晚些修正过一次**）：**加急明信片**（道具）。
    //   · 原实现是 `unlimited: true`（不设库存）+ `maxPerBuy: 1`，文案也写了"不限量"
    //     ⇒ 用户指出这会带来误解，**真实意图是"每轮补货只上架一张"**：
    //       买走这一张之后货架上就是 0，想要第二张只能**刷新货架**（1000 亿 TOKEN）
    //       或等下一次自动补货。
    //   · 所以改成 `stock: 1`（**正常货架商品**：补货时 stock 映射被清空 ⇒ 逐项回退到这里的 1）。
    //   · `maxPerBuy: 1` 保留 —— 库存已经是 1，它只是把"一次只进一张"写明。
    'item:express': {
      kind: 'item', id: 'express', name: '加急明信片', emoji: '✉️',
      price: EXPRESS_PRICE, stock: 1, maxPerBuy: 1,
      // ⚠️ 2026-10-14：这里原来写着 Markdown 星号（`**立刻**` / `**每轮补货…**`）——
      //   而 `desc` 会被**原样**印进商店正文（QQ 不渲染 Markdown）**和**那张商店菜单图
      //   ⇒ 群里/图上都会看到字面的 `**`。全部去掉（§41 那条纪律对"进图的文案"一样成立）。
      desc: '买下后可以立刻寄一张（在途 = 本趟额外多一张；在家 = 现拍一张庭院照）。每轮补货只上架 1 张，想要更多就刷新货架'
    }
  };
  return _shopCache;
}

/** 兼容旧引用（内部一律改用 shopTable()）。 */
export const SHOP = new Proxy({}, {
  get: (_, k) => shopTable()[k],
  ownKeys: () => Reflect.ownKeys(shopTable()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
});

/** 装备定价（永久解锁，稍贵）。 */
export const EQUIP_PRICE = S.PRICES.equip;

/**
 * ★★ 2026-10-13（用户需求）：**立刻寄一张明信片**（消耗「加急明信片」道具）。
 *
 * 两条分支，由"她此刻在哪儿"决定寄什么：
 *   · **在途** ⇒ 本趟**额外**多寄一张（用最后一个景点）。
 *     ⚠️ **不动 `cardTimes` / `cardsSent`** —— 所以不会打乱"第几张"的序号，
 *     也不会让 `sendCard` 之后取错内容（那条序号口径踩过坑，见 `appendExtraCard`）。
 *   · **在家** ⇒ 现拍一张**庭院照**：拿 `state.homeAct`（她此刻在院子里做什么）当题材，
 *     进相册时记 `kind:'home'` 且**不计入"已寄明信片 N 张"**（与庭院大合照同一口径）。
 *
 * ⚠️ **无视夜间静默**（0~7 点照寄）—— 这是花 TOKEN 买来的"立刻"，
 *   与"到点自动寄"是两回事；不这么做的话，半夜花了钱却要等到早上，很别扭。
 *
 * @returns {Promise<{ok:boolean, kind?:'trip'|'home', reason?:string}>}
 */
/**
 * ★★ 2026-10-14 「手动索要」的发送选项 —— **不扇出**，只发"要它的那个会话"。
 *
 * 用户口径（报的 bug）：「投递明信片是分发，但某个会话里有人要，那就是**特定的某个会话**
 * 要看，而不是所有人都要看。」所以 `whale_express`（加急寄一张）与 `whale_card`（补发）
 * 走这个开关；而**她自己旅行寄的**、出发/到家播报按 `cardTargets()` 扇出
 * （那些才是"投递"）。
 * ★ 2026-10-21：扇出**不再只看这个开关** —— 还要 `kind === 'journey'` 才扇出
 *   （见 `SAY_KINDS`）。所以庭院大合照 / 每日津贴 / 称号那些现在**不扇出**了，
 *   这里"一律保持默认扇出"那句已经过时。
 */
export const LOCAL_ONLY = { broadcast: false };

export async function sendExpressCard(chatKey, state, deps) {
  const d = deps || buildDeps(chatKey, state);
  const target = String(state.realChatKey || chatKey);

  if (state.trip) {
    const trip = state.trip;
    const spots = Array.isArray(trip.spots) ? trip.spots : [];
    const last = spots[spots.length - 1] || {};
    const entry = {
      at: Date.now(), kind: 'spot',
      spot: String(last.name || ''), scene: String(last.scene || ''),
      isReturn: false, rarity: 'common'
    };
    const total = Math.max(1, Number(trip.cardTimes?.length) || 1);
    const seq = Math.min(total, (Number(trip.cardsSent) || 0) + 1);
    await postOnce(target, state, trip, entry, seq, total, d, LOCAL_ONLY);
    return { ok: true, kind: 'trip' };
  }

  // 在家：用"她此刻在院子里的活动"当题材，现拍一张
  const act = state.homeAct || {};
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const style = (typeof HM.pickHomeStyle === 'function') ? HM.pickHomeStyle(rand) : '';
  const charStyle = (typeof P.pickCharacterStyle === 'function') ? P.pickCharacterStyle(rand) : '';
  const card = await P.composePostcard({
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME,
    spot: String(act.act || '待在院子里'), scene: String(act.detail || ''),
    style, charStyle, companion: '', seq: 1, total: 1,
    whaleName: String(cfg().whaleName || '小鲸鱼'),
    timeText: new Date().toLocaleString('zh-CN', { hour12: false }),
    // ★ 2026-10-14 服装系统：这一张上**谁穿什么**（没换装 ⇒ 空对象 ⇒ 全部默认，与从前逐字一致）
    outfits: outfitsForCards(state)
  }, cardDeps(d));
  // ★ 手动索要 ⇒ 只发要它的那个会话（不扇出到投递名单）
  //   ★ 2026-10-21：`broadcast:false` 与 `kind` 是两件事，同时给也不冲突
  //     （`fanoutTargets` 里 `broadcast === false` 先返回 ⇒ kind 只影响不到发几处）。
  if (card.imagePath) await sayImage(target, card.imagePath, { ...LOCAL_ONLY, kind: 'journey' });
  await say(target, `✉️ ${card.captionOut || card.caption}\n${card.thought}`, { ...LOCAL_ONLY, kind: 'journey' });
  S.addPostcard(state, {
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME,
    spot: String(act.act || ''), style, charStyle,
    kind: 'home',
    caption: card.caption, thought: card.thought,
    image: card.imagePath, imageError: String(card.imageError || '')
  }, { countStat: false });
  return { ok: true, kind: 'home' };
}

// ★ 2026-10-14：这里原来有个 `gardenUpgradeText()`（在商店正文里给设施写"下一级要多少"）。
//   用户把设施整块移出商店之后它就没有调用点了 ⇒ 删掉，别留死代码。
//   ⚠️ 那条经验仍然有效：**服务器阵列的门槛是成就值、它根本没有 `prices`** ——
//   谁以后要在别处再写"设施的下一级要多少"，必须按 `pointCosts` 分叉（`'all'` = 当前称号总分），
//   否则会印出 `升到 2 级要 undefined 亿 TOKEN`（`help.js` 的 `gardenTable` 已经这么做了）。

/**
 * ★ 2026-10-14 商店页（第 4 张菜单图）要的数据 —— **算好交给 `help.js`**（它是纯渲染，不读存档）。
 *
 * ★★ 用户口径：「把商店也做成菜单图吧，顺便把**设施/技能/衣柜**从商店里移出去，避免重复占用版面」。
 *   ⇒ 商店页只讲"货架上有什么、多少钱、还剩多少" + 邀请旅伴（见面礼也是花钱买）；
 *     设施 / 技能树 / 旅伴技能 / 衣柜**一律不在这儿**（各自已有菜单图），页尾只留一句指路。
 */
export function shopPageData(state) {
  S.restockIfDue(state);            // 与 `shopText` 同口径：打开商店顺手结算一次
  const items = Object.entries(shopTable()).map(([key, it]) => {
    const left = Number(state.shop?.stock?.[key]);
    return {
      name: it.name,
      price: it.price,
      desc: it.desc || '',
      // `unlimited` 的道具不显示"货架 N"（它压根不占货架）—— 与 shopText 完全同一口径
      stockText: it.unlimited ? '不限量' : `货架 ${Number.isFinite(left) ? left : it.stock}`,
      have: Number(state.bag?.[it.kind]?.[it.id]) || 0
    };
  });
  // ★★ 2026-10-15「探索解锁」：**只列"已发现"的** —— 还没发现的世界连名字都不出现
  //   （这就是用户要的"探索感"）。于是这一行同时排掉两类：
  //     · 已买（`isRegionUnlocked`）⇒ 没必要再列；
  //     · 还没发现（`!isEquipBuyable`）⇒ 剧透了就不好玩了。
  //   ⚠️ `isEquipBuyable` 是 state.js 的**新导出** ⇒ 热载期必须 `typeof` 包装
  //      （旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致）。
  //   ⚠️ 老档兼容在 `loadState` 里把 `equipBuyable` 补成"全部异世界" ⇒ 老玩家看到的
  //      列表与从前**完全一样**，不会突然少几行。
  const locked = T.loadRegions().filter((r) => Boolean(r?.equipment) && !isRegionUnlocked(state, r) && isRegionVisible(state, r));
  const remain = S.restockRemainMs(state);
  return {
    items,
    lockedEquip: { price: EQUIP_PRICE, names: locked.map((r) => r.equipment) },
    restockText: remain > 0 ? `约 ${(remain / 3600000).toFixed(1)} 小时后` : '货架刚补满',
    balance: Number(state.wallet?.plankton) || 0
  };
}

/**
 * ★★ 2026-10-14 相册页的数据装配（第 6 张菜单图用）。
 *
 * 用户口径："把明信片排列成 2×3 或者更大的块，这样可以保留缩略图，方便查看和翻找或者选择。"
 *
 * · **倒序分页**：第 1 页 = **最新的 `ALBUM_PER_PAGE` 张**（"刚寄回来的"最先看到），往后翻是更早的旅途；
 * · **`no` 是整册的"正序"编号**（最早那张 = #1）—— 它**不随分页变**，
 *   所以"看第 N 张"永远指同一张（分页会变、编号不能变）；
 * · 纯读存档，**不碰 state**；`image` 只传本地路径，缩略图由 `help.js` 的渲染层现压
 *   （`createRequire('electron')` 只有渲染时拿得到）。
 */
/**
 * ★★ 2026-10-18 v3.20：相册从"时间倒序、每页 N 张"改成 **一趟一页**。
 *
 * 用户口径：「把相册从现在的检索方式改成按"趟"检索，每趟一页」＋
 *          「庭院合照单独存放，不算任何一趟」。
 *
 * 分页规则：
 *   · 第 1..M 页 = 一趟一次旅行（最新那趟在第 1 页），每页是该趟的全部卡；
 *   · 之后是 **庭院合照**（kind='home'）单独成页，绝不混进任何一趟；
 *   · 编号仍是**整册正序**（#1 最早），「看第 N 张」的口径不变。
 *
 * 一趟怎么认出来：
 *   · 新卡片有 `state.cardTrip[id]`（这张属于哪趟）—— 准；
 *   · **老卡片没有** ⇒ 退回"相邻两张间隔超过 9 小时就算新的一趟"。
 *     为什么是 9 小时：旅途内的卡是行程排出来的、间隔通常 1~8 小时；
 *     两趟之间隔着"在家休息 10 小时 + 下一趟开局"，真实间隔 ≥ 10 小时。
 *     ⚠️ 这只是**回溯老数据**的近似，新数据一律认 `cardTrip`。
 */
export const TRIP_GAP_MS = 12 * 3600 * 1000;

export function groupTrips(state) {
  const all = (Array.isArray(state?.album) ? state.album : [])
    .filter((c) => String(c?.kind || 'spot') !== 'home');
  const map = cardTripMap(state);
  const groups = [];
  let cur = null;
  for (const c of all) {
    const tk = String(map[String(c?.id || '')] || '');
    const at = Number(c?.at) || 0;
    const place = placeLabel(c).replace(/^·/, '');
    let same;
    if (!cur) {
      same = false;
    } else if (tk && cur.tk) {
      same = (tk === cur.tk);                    // 新数据：只认"哪一趟"
    } else {
      // 老数据没有 cardTrip：**地点变了就一定是新的一趟**（一趟只会去一个城市），
      // 同城则以间隔判（>12h 视为新一趟：在家休息 ≥10h ＋ 下一趟开局）。
      const moved = place && cur.place && place !== cur.place;
      same = !moved && (at - cur.lastAt <= TRIP_GAP_MS);
    }
    if (!same) {
      cur = { tk, cards: [], lastAt: at, firstAt: at, place };
      groups.push(cur);
    }
    cur.cards.push(c);
    cur.lastAt = at;
    if (!cur.place && place) cur.place = place;
    if (!cur.tk && tk) cur.tk = tk;
  }
  // 编趟号：正序（第 1 趟是最早的），页面上倒过来显示
  groups.forEach((g, i) => { g.index = i + 1; });
  return groups;
}

/** 一趟的"旅行笔记"：日期 + 地名 + 几张 + 带回什么 + 最好的一句题字。 */
export function tripNoteOf(g) {
  const cards = Array.isArray(g?.cards) ? g.cards : [];
  if (!cards.length) return { label: '', note: '' };
  const first = cards[0];
  const place = placeLabel(first).replace(/^·/, '');
  const caps = cards.map((c) => String(c?.caption || '').trim()).filter(Boolean);
  const best = caps.sort((a, b) => b.length - a.length)[0] || '';
  const souvs = [...new Set(cards.flatMap((c) => (Array.isArray(c?.souvenirs) ? c.souvenirs : [])))].slice(0, 3);
  const bits = [`${cards.length} 张`];
  if (souvs.length) bits.push(`带回 ${souvs.join('、')}`);
  const date = albumDateOf(first);
  return {
    label: `第 ${g.index} 趟 · ${place}${date ? ' · ' + date : ''}`,
    note: (best ? `「${best}」　` : '') + bits.join('，')
  };
}

export function albumItemOf(c, no) {
  return {
    no,
    at: Number(c?.at) || 0,
    date: albumDateOf(c),
    kind: String(c?.kind || 'spot'),
    rarity: String(c?.rarity || 'common'),
    place: placeLabel(c),
    spot: String(c?.spot || ''),
    caption: String(c?.caption || ''),
    image: String(c?.image || '')
  };
}

export function albumPageData(state, page = 1, opts = {}) {
  const all = Array.isArray(state?.album) ? state.album : [];
  const total = all.length;
  const per = Number(H.ALBUM_PER_PAGE) || 12;
  const noOf = new Map(all.map((c, i) => [String(c?.id || ''), i + 1]));
  const trips = [...groupTrips(state)].reverse();          // 最新那趟在前
  const homes = all.filter((c) => String(c?.kind || '') === 'home');

  // ── 目录页：一张图列出每一趟（趟次 / 目的地 / 日期 / 张数），方便直接找到某一趟
  if (opts.catalog) {
    return {
      catalog: trips.map((g) => {
        const meta = tripNoteOf(g);
        const first = g.cards[0] || {};
        const place = placeLabel(first).replace(/^·/, '');
        return { index: g.index, label: place, date: albumDateOf(first), count: g.cards.length };
      }),
      homes: homes.length,
      total
    };
  }

  // ── 切片：一趟若超过一页**才**拆（此时标 (1/2)）；否则整趟作为一个不可拆的块
  const chunks = [];
  for (const g of trips) {
    const n = g.cards.length;
    const parts = Math.max(1, Math.ceil(n / per));
    for (let k = 0; k < parts; k += 1) {
      chunks.push({ g, cards: g.cards.slice(k * per, k * per + per), part: k + 1, parts });
    }
  }

  // ── 装页：按顺序往一页里塞，**塞不下就换页，绝不把一趟切成两页**（用户口径）
  const pageArr = [];
  let cur = [];
  let count = 0;
  for (const ch of chunks) {
    if (count + ch.cards.length > per && cur.length) {
      pageArr.push(cur);
      cur = [];
      count = 0;
    }
    cur.push(ch);
    count += ch.cards.length;
  }
  if (cur.length) pageArr.push(cur);

  const homePages = Math.max(0, Math.ceil(homes.length / per));
  const pages = Math.max(1, pageArr.length + homePages);
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);

  if (p <= pageArr.length) {
    const sections = pageArr[p - 1].map((ch) => {
      const meta = tripNoteOf(ch.g);
      return {
        label: meta.label + (ch.parts > 1 ? `（${ch.part}/${ch.parts}）` : ''),
        note: meta.note,
        tripIndex: ch.g.index,
        items: ch.cards.map((c) => albumItemOf(c, noOf.get(String(c?.id || '')) || 0))
      };
    });
    return {
      page: p, pages, total, perPage: per, isHome: false,
      sections,
      tripLabel: sections.length === 1 ? sections[0].label : `最近 ${sections.length} 趟`,
      note: sections.length === 1 ? sections[0].note : ''
    };
  }

  // 合照页
  const idx = p - pageArr.length;
  const slice = homes.slice((idx - 1) * per, (idx - 1) * per + per);
  return {
    page: p, pages, total, perPage: per, isHome: true,
    sections: [{
      label: `庭院合照 · 第 ${idx} 页 / 共 ${homePages} 页`,
      note: `一共 ${homes.length} 张（在庭院里和所有在家的旅伴合影，不属于任何一趟旅行）`,
      items: slice.map((c) => albumItemOf(c, noOf.get(String(c?.id || '')) || 0))
    }],
    tripLabel: `庭院合照 · 第 ${idx} 页 / 共 ${homePages} 页`,
    note: '在庭院里和所有在家的旅伴合影，不属于任何一趟旅行'
  };
}

/** 按地名 / 趟次找到它所在的页（"看庐山相册"用）。找不到返回 0。 */
export function albumPageOfTrip(state, { place = '', trip = 0 } = {}) {
  const per = Number(H.ALBUM_PER_PAGE) || 12;
  const trips = [...groupTrips(state)].reverse();
  const want = String(place || '').trim();
  let hit = null;
  if (Number(trip) > 0) hit = trips.find((g) => Number(g.index) === Number(trip)) || null;
  else if (want) hit = trips.find((g) => g.cards.some((c) => placeLabel(c).includes(want) || String(c?.spot || '').includes(want))) || null;
  else return 0;
  if (!hit) return 0;
  // 它前面那些趟一共占几页（整趟不拆的同一套算法）
  let count = 0;
  let page = 1;
  const chunks = [];
  for (const g of trips) {
    const parts = Math.max(1, Math.ceil(g.cards.length / per));
    for (let k = 0; k < parts; k += 1) chunks.push({ g, n: g.cards.slice(k * per, k * per + per).length });
  }
  for (const ch of chunks) {
    if (count + ch.n > per) { page += 1; count = 0; }
    if (ch.g === hit) return page;
    count += ch.n;
  }
  return 0;
}

/** 相册格子右上角那个日期（`M月D日`）。没时间戳就留空 —— 别硬编一个。 */
export function albumDateOf(c) {
  const t = Number(c?.at) || 0;
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 相册的**文字版** —— 只在出图失败时兜底（口径与旧版一致：最近 8 张 + 特产一段）。
 * 抽成函数是为了让 `whale_album` 的两条路（出图 / 文字）能并列写、不互相盖住。
 */
export function albumText(state) {
  // ★ v3.20：按趟列（最新 5 趟），合照单独一行 —— 和图片版同一套口径
  try {
    const trips = [...groupTrips(state)].reverse().slice(0, 5);
    if (trips.length) {
      const out = [`📮 相册：${groupTrips(state).length} 趟旅行（一趟一页，说「看相册 第几页」）`];
      for (const g of trips) {
        const meta = tripNoteOf(g);
        out.push(`  ${meta.label}`);
        out.push(`    ${meta.note}`);
      }
      const homes = (state.album || []).filter((c) => String(c?.kind || '') === 'home').length;
      if (homes) out.push(`  🐾 庭院合照 ${homes} 张（单独存放，不算任何一趟）`);
      return out.join('\n');
    }
  } catch (error) {
    log(`[travel-whale] 相册按趟汇总失败，退回旧版：${error?.message ?? error}`);
  }
  const cards = (state.album || []).slice(-8).reverse();
  const souvs = Object.values(state.souvenirs || {});
  const out = [];
  const rareCards = (state.album || []).filter((c) => c.rarity === 'rare').length;
  out.push('📮 明信片 ' + (state.album?.length || 0) + ' 张'
    + (rareCards ? '（其中 ✨稀有 ' + rareCards + ' 张）' : '')
    + (cards.length ? '：' : ''));
  for (const c of cards) {
    out.push('  ' + (c.rarity === 'rare' ? '✨' : '·')
      + (c.companion ? companionEmoji(c.companion) : '') + ' '
      + placeLabel(c) + '「' + c.spot + '」' + (c.caption ? ' — ' + c.caption : ''));
  }
  out.push(`🎁 特产图鉴 ${souvs.length} 件${souvs.length ? '：' : ''}`);
  const MARK = { rare: '💎', uncommon: '✦', common: '·' };
  const shownSouvs = souvs.slice(0, 20);
  for (const s of shownSouvs) {
    out.push(`  ${MARK[s.rarity] || '·'} ${s.name}（${s.city}）${s.count > 1 ? ` ×${s.count}` : ''}`);
  }
  if (souvs.length > shownSouvs.length) out.push(`  …还有 ${souvs.length - shownSouvs.length} 件，说「看图鉴」看全部`);
  const uncommKinds = souvs.filter((s) => s.rarity === 'uncommon').length;
  if (uncommKinds) out.push(`✦ 罕见 ${uncommKinds} 件`);
  const rares = souvs.filter((s) => s.rarity === 'rare' && s.image);
  if (rares.length) out.push('', `💎 稀有特产图已保存 ${rares.length} 张 —— 说「看图鉴里的 某某」就能发那一张的原图。`);
  return out.join('\n');
}

/**
 * ★★ 2026-10-14 批 3：**图鉴页的数据装配**（第 5 张菜单图用）。
 *
 * 为什么要在入口侧算、而不是让 `help.js` 自己读存档：
 *   ① 「能吃 / 能种」的判据住在 `souvenir.js`（`canEat` / `canPlant` / `kindOf`），
 *      一套判据只能有一处 —— 图鉴页/吃/送/种四条路必须用同一个答案；
 *   ② 「手上的存量」要读 `state.js` 的 `souvenirStock()`（有 `stock` 用 `stock`、
 *      老档退回 `count`）—— 这层兜底也只有那里有一份；
 *   ③ `help.js` 是纯渲染模块（同 wardrobe / shop 两张图的做法）。
 * ⚠️ 产量/稀有度**一律现算**，一个字不写死（特产没有固定清单，是模型现场编的）。
 */
export function pantryPageData(state) {
  const list = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  const now = Date.now();
  const items = list.map((e) => ({
    name: String(e.name),
    rarity: String(e.rarity || 'common'),
    city: String(e.city || ''),
    country: String(e.country || ''),
    kind: SV.kindOf(e),
    kindName: SV.KIND_NAMES[SV.kindOf(e)] || '',
    canEat: SV.canEat(e),
    canPlant: SV.canPlant(e),
    stock: S.souvenirStock(e),                       // 可支配存量（吃/送/种扣的就是它）
    count: Math.max(0, Number(e.count) || 0),        // 累计带回次数（只增）
    eaten: Math.max(0, Number(e.eaten) || 0),
    gifted: Math.max(0, Number(e.giftedCount) || 0),
    planted: Math.max(0, Number(e.planted) || 0),
    // ★ 2026-10-26：稀有特产的图鉴图路径 —— 图鉴页要拿它压缩略图、`whale_pantry(item)` 要发原图。
    //   此前这条数据**没出过存档**（`e.image` 只被写、没人读）⇒ 图生成了也永远看不见。
    image: String(e.image || ''),
    // `desc` = 条目的批注（目前**没有写入方**，是留给将来的钩子）—— 有就印
    desc: String(e.desc || '')
  }));
  const farm = Array.isArray(state?.farm) ? state.farm : [];
  const last = S.FARM.stageCount - 1;
  return {
    items,
    farm: {
      unlocked: state?.farmUnlocked === true,
      cap: farmCapNow(state),
      count: farm.length,
      ripe: farm.filter((p) => S.farmStageOf(p, now) >= last).length
    }
  };
}

/**
 * 菜单图的数据装配：在 `helpDataFor()` 的基础上，**按 kind 补上只有那张图才需要的块**。
 * ⚠️ 为什么不直接塞进 `helpDataFor`：那个函数是"纯读存档"，而商店数据要顺手 `restockIfDue`
 *   （会改 state）。渲染一张无关的图不该带来副作用 ⇒ 只在真要出商店图时才拼进去。
 */
export function menuDataFor(state, kind) {
  const data = helpDataFor(state);
  if (kind === 'shop') data.shop = shopPageData(state);
  // ★ 2026-10-14 批 3：图鉴页（第 5 张菜单图）
  if (kind === 'pantry') data.pantry = pantryPageData(state);
  // ★ 2026-10-14 相册页（第 6 张菜单图）：从这条路进来时固定第 1 页
  //   （翻页要走 `whale_album` 的 page 参数 —— 那儿才拿得到页码）。
  if (kind === 'album') data.album = albumPageData(state, 1);
  return data;
}

/**
 * 一张菜单图的渲染参数 —— **唯一处**（宽度 / 鲸鱼名从哪儿读，只在这儿写一次）。
 *
 * ★★ 为什么要单独抽出来（2026-10-14 血的教训）：
 *   原来三处各自写 `width: Number(settings().helpImageWidth) || 720` —— 而**全项目没有
 *   `settings` 这个函数**（唯一的 `const settings = cfg()` 是 `tick()` 里的**局部对象**）。
 *   于是「看商店」「看衣柜」一调就抛 `ReferenceError: settings is not defined`，
 *   被外层 catch 接住 ⇒ **静默降级成文字**，看起来像"功能没做"，实际是名字写错。
 *   抽出来之后：① 只写一次，不会再分叉；② 它是纯函数，**离线探针可以直接调**
 *   （见 `panel-flood-probe.mjs` 的 ⑥ 段）—— 这类错误再也不会等到线上才发现。
 */
export function menuRenderArgs(kind, data = {}) {
  const c = cfg();
  return {
    kind,
    width: Number(c.helpImageWidth) || 720,
    whaleName: String(c.whaleName || '小鲸鱼'),
    log,
    ...data
  };
}

