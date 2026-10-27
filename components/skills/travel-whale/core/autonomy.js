// 矩阵庭院（travel-whale）· 模块化组件：core/autonomy.js
// 职责：自主决策层：出门意愿自问（considerDepart）、无聊值、自动花销（autoSpend）、自动收菜补种（autoTend）与自动邀约

import fs from 'node:fs';
import path from 'node:path';
import * as BORED from '../lib/boredom.js';
import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as OW from '../outfits.js';
import * as SV from '../souvenir.js';
import { cfg, log } from './runtime-deps.js';
import { companionOf, foodNeedOf } from './companions-voice.js';
import { SELF_DIR, isRegionUnlocked, isRegionVisible, unlockedRegions } from './world-sync.js';
import { hasFood } from './departure.js';
import { EQUIP_PRICE } from './shop-album-menu.js';
import { farmCapNow } from './pantry-farm.js';
import { AUTO_TEND_AT, WHALE_LEGACY } from './tools-core.js';

// ── 后台推进 ──────────────────────────────────────────────────────────────

/** 背包里最好的一档口粮（自动出发时优先用大份，走得远）。 */
/**
 * 挑一档"背包里够用"的口粮（大份优先 —— 走得久、寄得多）。
 * ★ `need`：有旅行伙伴时要 2 份才够（两个人一起吃），否则会挑到"只剩 1 份"的档、
 *   然后 depart 才失败 —— 那属于把判定摊到两层去做，不如这里一次挑对。
 */
export function bestFoodTier(state, need = 1) {
  for (const t of ['large', 'normal', 'small']) if (hasFood(state, t, need)) return t;
  return null;
}

/** 一趟推进：对每个"养了鲸鱼"的会话，该寄的寄、该回的结算、该走的走。 */
/**
 * 上一轮 tick 还在跑吗。
 *
 * ⚠️ 必须有这个锁。tick 里有 **LLM 写文案 + 生图**，一轮跑几十秒很正常，
 *    而 setInterval 不会等上一轮结束 —— 两个 tick 会同时读到同一份存档、
 *    各自都以为「trip 还在」，于是**同一张明信片被寄两遍、同一次回家播报两遍**。
 *    实测日志里同一个请求指纹出现两次、30 秒内冒出三句「我回来啦」，就是这个原因。
 *
 * ★★ 这把锁必须挂在 **globalThis**（不是模块级 `let ticking`）：
 *    热重载后模块实例分叉 ⇒ 两个实例各持一把锁 ⇒ 等于没锁（见文件头 TICKER_SLOT 注释）。
 */


// ── ★★ 2026-10-18 v3.18「自动化」───────────────────────────────────────────
//
// 用户口径（原话）：
//   ① 每当她出发离开 / 旅行回到矩阵庭院时，**自动收取**未收取的 TOKEN；
//   ② token 足够的情况下，让模型**自主**决定怎么花手上的 token —— 真正做到"不用你管"。
//
// 两条都能在设置里关：`autoHarvest`（默认开）、`autoSpend`（默认开）。
// ⚠️ 自主花钱**只在白天**发生：夜里买完没法播报（必须压进 pending 队列，
//    而那套队列只认明信片那几种 kind），所以干脆留到下一次白天再说。

/**
 * ★ v3.18.2：周预算用「周一 0 点」当分界，跨周自动归零。
 * 为什么按自然周而不是"最近 7 天滚动"：玩家对"这周花了多少"有直觉，滚动窗口算不清。
 */
export function weekKey(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;              // 周一 = 0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const p = (n) => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`;
}

/** 本周已花（只算自主消费）。 */
export function spentThisWeek(state, now = Date.now()) {
  const b = (state?.autoSpendBook && typeof state.autoSpendBook === 'object') ? state.autoSpendBook : {};
  return String(b.week || '') === weekKey(now) ? (Number(b.spent) || 0) : 0;
}

/**
 * 记一笔自主消费：更新周账本 ＋ 追加到 `spendLog`（留最近 10 条）。
 * ⚠️ 只改 state，不落盘 —— 调用方用 `S.mutate` 包一层。
 */
export function noteAutoSpend(state, items, reason = '', now = Date.now()) {
  if (!Array.isArray(items) || !items.length) return;
  const total = items.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const wk = weekKey(now);
  const b = (state.autoSpendBook && typeof state.autoSpendBook === 'object') ? state.autoSpendBook : {};
  state.autoSpendBook = {
    week: wk,
    spent: (String(b.week || '') === wk ? (Number(b.spent) || 0) : 0) + total
  };
  const log = Array.isArray(state.spendLog) ? state.spendLog : [];
  log.push({
    at: now, total,
    // ★ 2026-10-23：把每件的 `why` 也存进账本（以前只存 name/price/kind，
    //   于是回头查"她为什么买这个"永远查不到）。
    items: items.map((x) => ({
      name: String(x.name || ''), price: Number(x.price) || 0, kind: String(x.kind || ''),
      ...(String(x.why || '').trim() ? { why: String(x.why).trim().slice(0, 60) } : {})
    })),
    reason: String(reason || '').slice(0, 80)
  });
  state.spendLog = log.slice(-10);
  // ★ v4.3：再写一份给控制台面板（它读不到技能存档，只能读静态 JSON）
  try {
    const root = path.resolve(SELF_DIR, '..', '..');
    const file = path.join(root, 'ui', 'travel-dashboard.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      at: now,
      balance: Number(state?.wallet?.plankton) || 0,
      week: state.autoSpendBook || null,
      log: state.spendLog
    }, null, 1));
  } catch (error) {
    log(`[travel-whale] 面板账本写入失败：${error?.message ?? error}`);
  }
}

/**
 * ① 自动收 TOKEN。失败（没得收 / 冷却中 / 服务器没产）一律静默 —— 这不是错误，
 * 是"顺手收一下"。返回实际收到的数（0 = 没收）。
 */
export function autoHarvest(state, tag) {
  try {
    const r = S.harvest(state, Date.now());
    const got = Number(r?.collected) || 0;
    if (r?.ok && got > 0) {
      log(`[travel-whale] 自动收取（${tag}）：+${got} 亿 TOKEN（余额 ${Number(state?.wallet?.plankton) || 0} 亿）`);
      return got;
    }
  } catch (error) {
    log(`[travel-whale] 自动收取失败（${tag}）：${error?.message ?? error}`);
  }
  return 0;
}

/**
 * ② 可买清单 —— **只列买得起的**，让模型没有"点了买不起"的机会。
 * 当前覆盖三类：庭院设施下一级、口粮、护身符。
 * 为什么先只做这三类：它们全在 `whale_buy` 里，且是"持续支出"的主干；
 * 技能 / 服装 / 装备各有前置条件（去过的世界、衣柜解锁），下一版再挂进来。
 */
export function spendMenu(state) {
  const wallet = Number(state?.wallet?.plankton) || 0;
  const out = [];
  for (const g of (S.GARDENS || [])) {
    const lv = Number((state?.garden || {})[g.id]) || 0;
    if (lv >= (Number(g.maxLevel) || 1)) continue;
    const price = Number((g.prices || [])[lv]);
    if (!Number.isFinite(price) || price <= 0) continue;   // 「服务器阵列」是成就值，不是 TOKEN
    if (price > wallet) continue;
    out.push({ name: g.name, price, kind: '设施', note: `从 ${lv} 级升到 ${lv + 1} 级：${g.effect || ''}` });
  }
  // ★ 2026-10-23：口粮**先看库存**。原来只看"钱够不够"，有饭也推荐买饭。
  //   判据复用 autoTend 那条：库存 >= max(2, 两趟的量) 就算够。
  const foodHave = ['small', 'normal', 'large']
    .reduce((n, k) => n + (Number(state?.bag?.food?.[k]) || 0), 0);
  const foodNeed = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
  if (foodHave < foodNeed) {
    const foods = [['small', '小份大白饭'], ['normal', '中份大白饭'], ['large', '大份大白饭']];
    for (const [k, nm] of foods) {
      const price = Number(S.PRICES?.food?.[k]);
      if (price > 0 && price <= wallet) out.push({ name: nm, price, kind: '口粮', note: `出门要吃的（现有 ${foodHave}/${foodNeed}）` });
    }
  }

  // ★ 2026-10-23：护身符是「戴一个」，不是可叠加商品 —— 原来不看当前戴的，
  //   于是同一顶护身符一天被买 6 次；甚至同一次里先买 +40% 再买 +25% 把贵的顶掉。
  //   规则：已戴的跳过；`luck <= 当前` 的也跳过（买了必然更差或持平 = 纯浪费）。
  const curCharm = String(state?.whale?.charm || '');
  const curLuck = (curCharm && S.CHARM_TYPES?.[curCharm]) ? Number(S.CHARM_TYPES[curCharm].luck) || 0 : -1;
  for (const [k, c] of Object.entries(S.CHARM_TYPES || {})) {
    if (k === curCharm) continue;                                   // 正戴着
    const luck = Number(c.luck) || 0;
    if (curCharm && luck <= curLuck) continue;                      // 不如现在这顶
    const price = Number(S.PRICES?.charm?.[k]);
    if (price > 0 && price <= wallet) {
      // ⚠️ 措辞要让模型一眼看懂这是「替换」而不是「叠加」——它读的是这句 note。
      const cmp = curCharm ? `现在戴的是${S.CHARM_TYPES[curCharm]?.name || curCharm}（+${Math.round(curLuck * 100)}%），换了就顶掉` : '';
      out.push({
        name: c.name, price, kind: '护身符',
        note: `稀有概率 +${Math.round(luck * 100)}%${cmp ? `；${cmp}` : ''}`
      });
    }
  }
  // ★ v3.18.1：装备（去过/发现过、但还没解锁的）—— 买它走 `whale_buy`
  for (const r of (T.loadRegions() || [])) {
    if (!r?.equipment) continue;
    if (isRegionUnlocked(state, r)) continue;
    if (!isRegionVisible(state, r)) continue;        // 没发现的地方不列，别剧透
    if (EQUIP_PRICE > wallet) continue;
    out.push({ name: r.equipment, price: EQUIP_PRICE, kind: '装备', note: '解锁这个世界的装备', tool: 'buy' });
  }
  // ★ v3.18.1：服装（去过那个区域、还没买下的）—— 买它走 `whale_wear`（衣柜里带买）
  const seen = (state?.areasSeen && typeof state.areasSeen === 'object') ? state.areasSeen : {};
  for (const o of (OW.OUTFITS || [])) {
    if (state?.wardrobe?.owned?.[o.id] === true) continue;
    if (!seen[`${o.region}|${o.area}`]) continue;
    const price = Number(o.price) || OW.OUTFIT_PRICE;
    if (price > wallet) continue;
    out.push({
      name: o.name, price, kind: '服装',
      note: `给${OW.girlName(o.who)}的一套（去过${OW.OUTFIT_REGION_NAMES?.[o.region] || o.region}·${o.area}）`,
      tool: 'wear'
    });
  }
  // ★ 2026-10-23（档 2）：墓碑 —— 买失败过的 3 天内不再列。
  //   为什么只记"买失败过的"：已拥有类（护身符已戴 / 装备已解锁 / 服装已拥有）状态本身就在
  //   charm / equipment / wardrobe 里，再记一份墓碑就是两套真相，早晚不一致。
  //   "买失败"才是有隐藏条件的那种（比如 world 没完全解锁），本地看不出来，只能靠试。
  const tomb = (state?.spendTomb && typeof state.spendTomb === 'object') ? state.spendTomb : {};
  const now = Date.now();
  return out.filter((it) => {
    const t = tomb[it.name];
    if (!t) return true;
    const until = Number(t.until) || 0;
    return until > 0 && until <= now;      // 到点解除；没写 until 的视为永久（当前不产生这种）
  });
}

// ── ★★ 2026-10-23：把"想不想出门"交还给她 ────────────────────────────────
// 原来 `shouldAutoDepart` 一旦为真就直接 `depart()` —— 时间到身体就自己走。
// 现在两道都过一遍：**时间到**（机制闸照旧）→ **问她一句**（她决定）。
//
// 口径（用户定）：
//   · 无聊值**只升不降**，出门一次清空 —— 用 `state.homeSince` 算（见 lib/boredom.js）
//   · 问法必须是 selfDecide：**给数值/感受，不给"你该出门了"**
//
// 安全底线：`deps.llm` 不可用、解析失败、给了不存在的地区 ⇒ **回落照旧出发**。
//   模型挂了不能把"旅行"这条主线卡死 —— 宁可她还按老样子出门，也不要她永远待在家。

/** 这一趟会带谁（与 depart 同口径，只用来算口粮）。 */
export function tripPartyOf(state) {
  const comp = companionOf(state);
  return typeof S.companionsOf === 'function' ? S.companionsOf(state) : (comp ? [comp] : []);
}

/**
 * 问她一句：现在想不想出门。
 * @returns {Promise<{go:boolean, region?:object, reason?:string, retryInMs?:number, boredom:number}>}
 */
export async function considerDepart(chatKey, state, deps, settings, foodTier = 'normal') {
  const cfg = settings || {};
  const now = Date.now();
  const perHour = Number(cfg.boredomPerHour) > 0 ? Number(cfg.boredomPerHour) : BOREDOM_DEFAULTS_PER_HOUR();
  const boredom = BORED.boredomOf(state, now, { perHour });
  const hours = BORED.homeHoursOf(state, now);
  const feel = BORED.boredomFeel(boredom, hours);

  // 后路：没有模型 / 解析失败 / 地区不合法 ⇒ 按老样子走
  const fallback = (why) => {
    log(`[travel-whale] ${chatKey} 出门自决不可用（${why}）⇒ 按老样子出发`);
    return { go: true, boredom };
  };
  if (typeof deps?.llm !== 'function') return fallback('没有可用的模型');
  if (cfg.boredomSelfDecide === false) return { go: true, boredom };   // 显式关掉 = 老行为

  const party = tripPartyOf(state);
  const foodNeed = foodNeedOf(state, party);
  const foodHave = Number(state?.bag?.food?.[foodTier]) || 0;
  const wallet = Number(state?.wallet?.plankton) || 0;
  const regions = unlockedRegions(state).map((r) => String(r.name || r.id)).filter(Boolean);
  const who = party.length ? party.map((c) => c.name).join('、') : '一个人';

  const prompt = [
    `你刚在矩阵庭院里。${feel}`,
    `手上 ${wallet} 亿 TOKEN；${T.FOOD_TIERS?.[foodTier]?.name || '中份大白饭'} 还有 ${foodHave} 份`
      + `（这趟出门要 ${foodNeed} 份，${who}）。`,
    regions.length > 1 ? `现在能去的地方：${regions.join('、')}。` : '',
    '',
    '要不要出门、去哪、带着谁 —— 都由你自己定。主人没有交代，也不用问。',
    '不想出门也完全可以：在家待着也是过日子。',
    '',
    '只输出 JSON，不要别的字：',
    '{"go":true,"region":"地方名","why":"一句话，为什么现在想去"}',
    '或 {"go":false,"reason":"一句话，为什么还想再待一会儿"}'
  ].filter(Boolean).join('\n');

  let plan = null;
  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    plan = m ? JSON.parse(m[0]) : null;
  } catch (error) {
    return fallback(`模型调用失败：${String(error?.message ?? error).slice(0, 60)}`);
  }
  if (!plan || typeof plan !== 'object') return fallback('模型没给出可用的 JSON');

  if (plan.go !== true) {
    const reason = String(plan.reason || plan.why || '').trim().slice(0, 80);
    log(`[travel-whale] ${chatKey} 到点了，她不想走（无聊 ${boredom}/100，在家 ${Math.round(hours)}h）`
      + `${reason ? `：${reason}` : ''}`);
    return { go: false, reason, boredom, retryInMs: BORED.askGapMsOf(boredom, cfg) };
  }

  // 选地区：名字 → region 对象；对不上就回落随机（不让一次错字把出行卡住）
  const want = String(plan.region || '').trim();
  const hit = want
    ? unlockedRegions(state).find((r) => String(r.name || '').includes(want) || want.includes(String(r.name || '')))
    : null;
  const why = String(plan.why || '').trim().slice(0, 80);
  log(`[travel-whale] ${chatKey} 她说想出门（无聊 ${boredom}/100${hit ? `，去${hit.name}` : '，地方随机'}）`
    + `${why ? `：${why}` : ''}`);
  return { go: true, boredom, region: hit || null, reason: why };
}

/** `boredomPerHour` 的默认值（从 boredom.js 取，避免两处各写一个数）。 */
export function BOREDOM_DEFAULTS_PER_HOUR() {
  try { return BORED.BOREDOM_DEFAULTS.perHour; } catch { return 4; }
}

/**
 * 伙伴来问能不能出去玩 —— 让不让由她定，理由用**她的原话**。
 *
 * 原来 `side-wish` 只能"把申请人排进这一趟"，驳回的 why 是**机制算的**
 * （"粮不够 / 凑不够人 / 夜里"）—— 那是程序在说话，不是她。
 *
 * 安全底线同 `considerDepart`：没有模型 ⇒ **放行**（不因为模型挂了就永远不让伙伴出门）。
 */
export async function judgeSideWish(chatKey, state, wish, deps, settings) {
  const cfg = settings || {};
  const who = String(wish?.partner || '有伙伴');
  if (typeof deps?.llm !== 'function' || cfg.sideWishSelfDecide === false) {
    return { allow: true, reason: '' };
  }
  const foodNeed = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
  const foodHave = Object.values(state?.bag?.food || {}).reduce((n, x) => n + (Number(x) || 0), 0);
  const selfAway = state?.trip ? `你自己这趟还在外面（${String(state.trip.city || '')}）。` : '你在家。';
  const prompt = [
    `${who}跑来问你：能不能自己出去玩一趟。`,
    `家里现在：${selfAway}米缸里一共 ${foodHave} 份口粮（这一趟要带走 ${foodNeed} 份）。`,
    '让不让它们去，你自己定 —— 想留它们在家陪我、想等某件事做完再说，都可以。',
    '不想让的话，把理由说清楚（别写"粮不够"这种账面上的话，说你自己的顾虑或打算）。',
    '',
    '只输出 JSON，不要别的字：',
    '{"allow":true,"reason":"一句话，答应了"}',
    '或 {"allow":false,"reason":"一句话，为什么先不让"}'
  ].join('\n');

  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : null;
    if (!o || typeof o !== 'object') return { allow: true, reason: '' };
    const reason = String(o.reason || '').trim().slice(0, 80);
    if (o.allow === false) {
      log(`[travel-whale] ${chatKey} 她没让「${who}」出门${reason ? `：${reason}` : ''}`);
      return { allow: false, reason };
    }
    log(`[travel-whale] ${chatKey} 她答应「${who}」出门${reason ? `：${reason}` : ''}`);
    return { allow: true, reason };
  } catch (error) {
    log(`[travel-whale] 伙伴请愿判定失败（放行）：${String(error?.message ?? error).slice(0, 60)}`);
    return { allow: true, reason: '' };
  }
}

/**
 * ② 自主花钱：让她自己看清单、自己决定买什么。
 *
 * 设计取舍：
 *   · **一次模型调用**（回来一趟一次），不额外开定时器；
 *   · 决策只输出"买什么"，**执行仍走 `whale_buy`** —— 它的定义被合并入口收在
 *     `WHALE_LEGACY`（键是短名 'buy'），取它的 `execute` 就是群友点按钮那条路，
 *     价格/库存/余额闸一行都不复制。
 *   · 硬约束在本地再做一遍：只能挑菜单里的、买完要留底、最多 N 件 ——
 *     **不信任模型输出的数字**（它没见过账单）。
 * @returns {string} 要发到群里的一句话；不买/不该买时返回空串
 */
export async function autoSpend(chatKey, state, deps, settings) {
  if (settings?.autoSpend === false) return '';
  if (typeof deps?.llm !== 'function') return '';
  // 频率闸：默认 3 小时最多决策一次（`autoSpendGapHours` 可调）
  // ★ 2026-10-23：时间戳改读**存档**（`state.autoSpendAt`），不再用模块级 Map ——
  //   后者每次热重载归零，实测导致"7 分钟买 4 次"。见文件头 `AUTO_SPEND_AT` 那段说明。
  const gapMs = Math.max(1, Number(settings?.autoSpendGapHours ?? 3)) * 3600 * 1000;
  const lastAt = Number(state?.autoSpendAt) || 0;
  if (Date.now() - lastAt < gapMs) return '';
  // ⚠️ 占位放在**确认 buy 存在之后**（见下面 `if (!buy) return ''`）：buy 取不到是环境问题，
  //   不该占用 3 小时的重试窗口 —— 否则插件装错时要等 3 小时才发现。
  void 0;
  const wallet = Number(state?.wallet?.plankton) || 0;
  const min = Number(settings?.autoSpendMin ?? 150);          // 低于这个数不谈花钱
  if (wallet < min) return '';
  const menu = spendMenu(state);
  if (!menu.length) return '';
  // 买完至少留这么多：**绝对下限 ＋ 余额比例**取大者。
  // 2026-10-18 实测教训：老口径只留固定 50 亿，她一次就把 1878 花到 78 —— 数字上没违规，
  // 但体感就是"把存款花光了"。比例兜底（默认 20%）让钱包始终留有余量。
  // 周预算：0 = 不限。跨周自动归零（`weekKey`）。
  const weeklyCap = Math.max(0, Number(settings?.autoSpendWeeklyCap ?? 0));
  const capLeft = weeklyCap > 0 ? Math.max(0, weeklyCap - spentThisWeek(state)) : Infinity;
  if (capLeft <= 0) {
    log(`[travel-whale] 自主花钱：本周预算 ${weeklyCap} 亿已用完，攒着`);
    return '';
  }
  const keepFloor = Math.max(0, Number(settings?.autoSpendKeep ?? 200));
  const keepPct = Math.max(0, Math.min(50, Number(settings?.autoSpendKeepPct ?? 20))) / 100;
  const keep = Math.max(keepFloor, Math.round(wallet * keepPct));
  const maxN = Math.max(1, Math.min(3, Number(settings?.autoSpendMax ?? 2)));
  const execOf = (key) => {
    const d = WHALE_LEGACY.get(key);
    return (d && typeof d.execute === 'function') ? d.execute : null;
  };
  const buy = execOf('buy');
  const wear = execOf('wear');
  if (!buy) {
    log('[travel-whale] 自主花钱：取不到 buy 工具（本次不决策，也不占频率闸）');
    return '';
  }

  // 先占位（落盘）：一次 tick 里只决策一次；**决策失败也算占位**，否则 tick 会每分钟重试。
  try { S.mutate(chatKey, (st) => { st.autoSpendAt = Date.now(); }); } catch (error) {
    log(`[travel-whale] 自主花钱：写频率闸失败（本次照常决策）：${error?.message ?? error}`);
  }

  const lines = menu.map((m) => `- ${m.name}｜${m.price} 亿｜${m.kind}｜${m.note}`);
  const prompt = [
    `你刚回到矩阵庭院，手上有 ${wallet} 亿 TOKEN。`,
    '要不要花、花在哪，由你自己决定 —— 主人没有交代，也不用问。',
    `规矩：一次最多买 ${maxN} 件；买完至少留 ${keep} 亿（别把钱花光）。`,
    '只能从下面清单里挑，item 必须写原名。',
    '清单：',
    ...lines,
    '',
    '只输出 JSON，不要别的字：',
    '{"buy":[{"item":"名字","why":"一句话理由"}],"reason":"如果一件都不买，在这里写为什么"}'
  ].join('\n');

  let plan = null;
  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    plan = m ? JSON.parse(m[0]) : null;
  } catch (error) {
    log(`[travel-whale] 自主花钱决策失败：${error?.message ?? error}`);
    return '';
  }
  const wants = Array.isArray(plan?.buy) ? plan.buy : [];
  if (!wants.length) {
    if (plan?.reason) log(`[travel-whale] 自主花钱：这次不买（${String(plan.reason).slice(0, 40)}）`);
    return '';
  }

  let left = Math.min(wallet - keep, capLeft);
  const picked = [];
  const seen = new Set();
  for (const w of wants) {
    const name = String(w?.item ?? '').trim();
    const hit = menu.find((m) => m.name === name);
    if (!hit || seen.has(name)) continue;
    if (hit.price > left) continue;
    // ★ 2026-10-23：模型给的 `why` 以前**一次都没被读过**（全文件只在提示词里出现）。
    //   所以在群里只看到收据，买 6 次同一顶护身符一句理由都没有 —— 那才是"蠢"的体感来源。
    picked.push({ ...hit, why: String(w?.why ?? '').trim().slice(0, 60) });
    seen.add(name);
    left -= hit.price;
    if (picked.length >= maxN) break;
  }
  if (!picked.length) {
    log('[travel-whale] 自主花钱：模型的选项都过不了本地校验，这次不买');
    return '';
  }

  const receipts = [];
  // ★ 2026-10-23（档 2）：买失败过的记墓碑，3 天内不再列进清单。
  //   这类"清单里有、但工具拒绝"的东西，本地看不出来（隐藏条件在 buy 的校验里），
  //   不改的话每次决策都会白试一遍 —— 也就是用户说的"反复 ping 已经卖完的东西"。
  const tombNew = {};
  const TOMB_DAYS = 3;
  for (const it of picked) {
    // 服装走衣柜那条路（它会自己判断"去过没 / 买没买 / 扣钱"，并顺手换上）；
    // 其余都走商店。两条都是群友手动点按钮时走的同一条。
    const fn = (it.tool === 'wear' && wear) ? wear : buy;
    try {
      const r = await fn({ chatKey }, { item: it.name, count: 1 });
      if (r?.isError) {
        const why = String(r?.content || '').slice(0, 60);
        log(`[travel-whale] 自主花钱：买「${it.name}」被拒（${why}）→ 记墓碑 ${TOMB_DAYS} 天`);
        tombNew[it.name] = { at: Date.now(), kind: it.kind, why, until: Date.now() + TOMB_DAYS * 86400000 };
        continue;
      }
      const line = String(r?.content || `${it.name} 买好了`).trim();
      // ★ 2026-10-23：把她给的理由带上（没有理由就只留收据，不编）
      receipts.push(it.why ? `${line}（${it.why}）` : line);
    } catch (error) {
      log(`[travel-whale] 自主花钱：买「${it.name}」出错：${error?.message ?? error}`);
    }
  }
  if (Object.keys(tombNew).length) {
    try {
      S.mutate(chatKey, (st) => {
        st.spendTomb = { ...(st.spendTomb && typeof st.spendTomb === 'object' ? st.spendTomb : {}), ...tombNew };
      });
    } catch (error) {
      log(`[travel-whale] 自主花钱：写墓碑失败：${error?.message ?? error}`);
    }
  }
  if (!receipts.length) return '';
  // 记账（周预算 + 最近记录）。单独 mutate：`whale_buy` 已经各自存过盘了。
  try {
    S.mutate(chatKey, (st) => noteAutoSpend(st, picked, plan?.reason || ''));
  } catch (error) {
    log(`[travel-whale] 记账失败：${error?.message ?? error}`);
  }
  log(`[travel-whale] 自主花钱：买了 ${picked.map((x) => x.name).join('、')}`);
  return `🛒 我自己做了点主：\n${receipts.map((x) => `· ${x}`).join('\n')}`;
}


/**
 * ★★ v3.18.2「自理」：她在家会自己收菜、补种、补口粮。
 *
 * 只做**不花钱或很少花钱**的事：
 *   · 收菜 —— 有熟的才动（收稀有的会触发一张收成图，和手动收一样）；
 *   · 补种 —— 地空着、图鉴里有能种的、库存够 ⇒ 自己种一株；
 *   · 补口粮 —— 口粮低于"两趟的量"就自己买，最多补 3 份（不超过钱包与周预算）。
 * ⚠️ "送特产"**没有做**：那需要一个具体收礼人，自动送等于替她乱发东西 ——
 *    留给人来说（说"送给他"），或者以后做成"有人讨要才送"。
 */
export async function autoTend(chatKey, state, deps, settings) {
  if (settings?.autoTend === false) return [];
  const gapMs = Math.max(5, Number(settings?.autoTendGapMin ?? 30)) * 60 * 1000;
  const last = Number(AUTO_TEND_AT.get(chatKey)) || 0;
  if (Date.now() - last < gapMs) return [];
  AUTO_TEND_AT.set(chatKey, Date.now());

  const did = [];
  const call = async (tool, args) => {
    const d = WHALE_LEGACY.get(tool);
    if (!d || typeof d.execute !== 'function') return null;
    try { return await d.execute({ chatKey }, args || {}); } catch (error) {
      log(`[travel-whale] 自理：${tool} 出错：${error?.message ?? error}`);
      return null;
    }
  };

  // ① 收菜
  const farm = Array.isArray(state.farm) ? state.farm : [];
  const lastStage = S.FARM.stageCount - 1;
  if (farm.some((p) => S.farmStageOf(p) >= lastStage)) {
    const r = await call('reap', {});
    if (r && !r.isError) did.push('收菜');
  }
  // ② 补种
  if (state.farmUnlocked) {
    const cap = farmCapNow(state);
    const plots = Array.isArray(state.farm) ? state.farm : [];
    if (plots.length < cap) {
      const seeds = Object.values(state.souvenirs || {})
        .filter((e) => e && SV.canPlant(e) && S.souvenirStock(e) >= 1)
        .sort((a, b) => String(b.count || 0) - String(a.count || 0));
      if (seeds.length) {
        const r = await call('plant', { item: seeds[0].name });
        if (r && !r.isError) did.push('补种');
      }
    }
  }
  // ③ 补口粮（按"两趟的量"备货，最多一次补 3 份）
  try {
    const tier = 'normal';
    const need = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
    const have = Number(state?.bag?.food?.[tier]) || 0;
    const price = Number(S.PRICES?.food?.[tier]) || 0;
    const wallet = Number(state?.wallet?.plankton) || 0;
    if (have < need && price > 0) {
      const want = Math.min(3, need - have);
      if (wallet >= price * want) {
        const r = await call('buy', { item: '中份大白饭', count: want });
        if (r && !r.isError) did.push('补口粮');
      }
    }
  } catch (error) {
    log(`[travel-whale] 自理：补口粮出错：${error?.message ?? error}`);
  }

  if (did.length) log(`[travel-whale] 自理：${did.join('、')}`);
  return did;
}

/**
 * ★★ v3.18.2「自己邀旅伴」：钱够、没同行者、隔够久，就自己请一位上路。
 * 播报用 `whale_buy` 的原话（含"见面礼"与余额），不做二次加工。
 */
export async function autoInvite(chatKey, state, settings) {
  if (settings?.autoInvite === false) return '';
  if (state?.trip) return '';
  // ★ 2026-10-18（用户口径）：**不再要求"手上没有同行者"**。
  //   理由：旅伴是买断制、请过就一直跟着，那条前置实际上让这个功能一辈子只触发一次。
  //   现在只靠"72 小时"这一道间隔 —— 也就是说，她会慢慢把旅伴请齐。
  const gap = Math.max(1, Number(settings?.autoInviteGapHours ?? 72)) * 3600 * 1000;
  const last = Number(state?.autoInviteAt) || 0;
  if (last && Date.now() - last < gap) return '';
  const wallet = Number(state?.wallet?.plankton) || 0;
  const keep = Math.max(200, Math.round(wallet * 0.2));
  const list = Object.values(S.COMPANIONS || {})
    .filter((c) => Number(c.price) > 0 && wallet - Number(c.price) >= keep);
  if (!list.length) return '';
  const pick = list[Math.floor(Math.random() * list.length)];
  const d = WHALE_LEGACY.get('buy');
  if (!d || typeof d.execute !== 'function') return '';
  try {
    const r = await d.execute({ chatKey }, { item: pick.name });
    if (!r || r.isError) return '';
    S.mutate(chatKey, (st) => { st.autoInviteAt = Date.now(); });
    log(`[travel-whale] 自理：自己请了「${pick.name}」`);
    return r.content;
  } catch (error) {
    log(`[travel-whale] 自己邀旅伴出错：${error?.message ?? error}`);
    return '';
  }
}

