// 矩阵庭院（travel-whale）· 模块化组件：core/departure.js
// 职责：口粮/护身符消耗、异世界穿越判定、探索解锁与主行程出发（depart）

import * as S from '../state.js?v=realworld-1';
import * as E from '../engine.js';
import * as T from '../trip.js';
import { buildDeps, cfg, log } from './runtime-deps.js';
import { isOtherworldRegion } from './theme-pack.js';
import { companionOf, foodNeedOf, pickPartyIds } from './companions-voice.js';
import { appendExtraCard, pushMoodEvent, rollBattle, rollEvents } from './mood-battle-events.js';
import { applySkillNumerics, companionHas, skillOwned, syncSkillNumbers } from './skills-appointments.js';
import {
  currentPhase,
  isRegionUnlocked,
  placeLabel,
  randomUnlockedRegion,
  unlockedRegions
} from './world-sync.js';
import { autoHarvest } from './autonomy.js';
import { notesSouvenirs } from './pantry-farm.js';

/** 背包里还有没有这种口粮（`n` = 需要几份，旅行伙伴会要吃双份）。 */
export function hasFood(state, tier, n = 1) {
  return Number(state?.bag?.food?.[tier] || 0) >= Math.max(1, Number(n) || 1);
}

/**
 * 出行时自动消耗一件最好的护身符（珍稀度高的优先）。
 * 原版设计是"每次出行消耗 1 个"，所以这里不是常驻 buff，而是单趟生效。
 */
export function consumeCharm(state) {
  for (const id of ['pearl', 'scale', 'shell']) {
    const n = Number(state.bag?.charm?.[id]) || 0;
    if (n > 0) {
      state.bag.charm[id] = n - 1;
      if (state.bag.charm[id] <= 0) delete state.bag.charm[id];
      return id;
    }
  }
  return '';
}

/**
 * 手里最好的一件护身符的 id —— **不扣**。
 * ★ 艾泽拉斯「图腾护佑」学到之后用它：护身符**不再被消耗**（一直戴在身上、每趟都生效）。
 */
export function bestCharmId(state) {
  for (const id of ['pearl', 'scale', 'shell']) {
    if ((Number(state.bag?.charm?.[id]) || 0) > 0) return id;
  }
  return '';
}

/**
 * 扣 `n` 份口粮（默认 1）。
 * ★ 旅行伙伴的"出门吃双份"就落在这里 —— 份数不够时**不扣任何一份**、返回 false
 *   （绝不能扣掉 1 份然后让出发失败，那等于白吃）。
 */
export function consumeFood(state, tier, n = 1) {
  const need = Math.max(1, Number(n) || 1);
  if (!hasFood(state, tier, need)) return false;
  state.bag.food[tier] = Number(state.bag.food[tier]) - need;
  if (state.bag.food[tier] <= 0) delete state.bag.food[tier];
  return true;
}

/**
 * 掷一次「穿越」：命中就返回一个**还没解锁**的异世界，作为本趟的目的地。
 *
 * ★ 顺序很关键：**先掷骰子、再看候选池**。
 *   反过来（先查"有没有候选"再掷骰）在一堆边界情况下语义会糊；
 *   现在这样写，三件事一次说清：
 *     · 概率就是 `crossOverChance`（默认 0.15），与候选多少无关；
 *     · **异世界全部解锁 ⇒ 池子为空 ⇒ 永不穿越**（用户要的"买齐了就不倒霉"）；
 *     · 设成 0 或负数 = 直接关闭这个玩法。
 *
 * @returns {{region:object, fromName:string}|null}
 */
export function pickCrossOverTarget(state, baseRegion, deps) {
  // ★ 诡秘之主「命运的偶然」：穿越概率 +0.15。
  //   直接读技能表（技能表就在本文件，不用过桥）；`syncSkillNumbers` 只在 depart 里跑，
  //   而穿越掷骰发生得更早，所以这里必须自己判、不能读同步字段。
  const bonus = skillOwned(state)['fate-chance'] ? 0.15 : 0;
  const rawCfg = Number(cfg().crossOverChance);
  const p = (Number.isFinite(rawCfg) ? rawCfg : S.CROSS_OVER_CHANCE) + bonus;
  if (!(p > 0)) return null;
  const rand = typeof deps?.rand === 'function' ? deps.rand : Math.random;
  if (rand() >= Math.min(1, p)) return null;            // ① 先掷骰

  let pool = [];
  try {
    pool = T.loadRegions().filter((r) => isOtherworldRegion(r) && !isRegionUnlocked(state, r));
  } catch (error) {
    log(`[travel-whale] 穿越候选读取失败：${error?.message ?? error}`);
    return null;
  }
  if (!pool.length) return null;                        // ② 异世界全解锁 ⇒ 不穿越

  const region = pool[Math.floor(rand() * pool.length)];
  // 她"本来要去"的地方：装备决定的那个（将来可以在台词里对比，先存着）
  return { region, fromName: baseRegion?.name || '' };
}

/**
 * ★★ 2026-10-15「探索解锁」：一次穿越解锁几个异世界的装备购买权。
 *   用户口径：「异世界及其装备不要最开始就解锁，保留一点【探索】感：
 *              每次【穿越】之后解锁三个未解锁的异世界的装备的购买权；
 *              无论是鲸鱼自己穿越还是旅伴穿越都算。」
 *   ⇒ 3 是**用户定死的**，不是调参项（要改就改这里一处）。
 */
export const UNLOCK_PER_CROSSING = 3;

/**
 * ★★ 2026-10-15「清档 → 时空乱流」：她被抛回来之后，提示词里提这件事**提几天**。
 *   之后自然淡出 —— 否则一年后她还在说"我刚被时空乱流抛回来"。
 *   （判据是 `state.rebornAt`，由 `_qcheck/reset-whale.mjs` 在清档时写下。）
 */
export const REBORN_DAYS = 7;

/**
 * 把"这一趟真的穿越了"兑换成"发现新世界"。
 *
 * ⚠️ 两条纪律（都是本项目踩过的）：
 *   ① `unlockEquipBuyables` 住在 `state.js`（**兄弟模块**）⇒ 热载窗口里
 *      「新 index ＋ 旧 state」时这个函数**不存在** ⇒ **必须 `typeof` 包装**。
 *      裸调 TypeError —— 而这里在 `depart()` / `departSideTrip()` 的中途，
 *      抛出去就是把**整趟出发废掉**（比"没解锁"严重得多）。
 *   ② 整段 try/catch：解锁失败**绝不该影响旅行本身**（跟 `syncWorldbook` 同一口径）。
 *
 * @returns {string[]} 这一次**新解锁**的世界名（给播报用；空数组 = 没有新的了）
 */
export function unlockBuyablesFromCrossing(state, regionId, deps) {
  try {
    if (typeof S.unlockEquipBuyables !== 'function') return [];   // 旧模块 ⇒ 静默跳过（行为同从前）
    const ids = S.unlockEquipBuyables(state, regionId, {
      count: UNLOCK_PER_CROSSING,
      rand: typeof deps?.rand === 'function' ? deps.rand : Math.random
    });
    if (!Array.isArray(ids) || !ids.length) return [];
    const byId = new Map(T.loadRegions().map((r) => [String(r.id), String(r.name || r.id)]));
    return ids.map((id) => byId.get(String(id)) || String(id));
  } catch (error) {
    log(`[travel-whale] 解锁装备购买权失败（不影响这趟旅行）：${error?.message ?? error}`);
    return [];
  }
}

/**
 * 拼一句"发现新世界"的播报。**单独一行**，别跟她的即兴台词混在一起 ——
 * 那是机制说明，读者要一眼分得清（§114 借嘴那条的同一课）。
 */
export function discoveredLine(names) {
  if (!Array.isArray(names) || !names.length) return '';
  return `\n\n🌍 庭院记下了这几个新世界的坐标 —— 以后可以买它们的装备了：${names.join('、')}`;
}

/**
 * 让她**即兴演一段**穿越后的反应（用户明确要求"这样比较好玩"）。
 *
 * 提示词里必须交代的三件事（用户指定的口径）：
 *   ① 她是**非常倒霉地**遇到了穿越；② 被丢到了这个异世界；
 *   ③ **不过她仍然可以回家** —— 这条是**安抚**，不是机制（回家时刻本来就是定死的）。
 *
 * 模型失败 / 返回空 ⇒ 退回兜底台词：**穿越这件事不能因为模型抽风而整个消失**。
 * ⚠️ 这里**不传 maxTokens**（与宿主其它模型调用一致）：llm.js 只在 >0 时才写
 *    `max_tokens`，思考模型设小了会把预算全烧在 reasoning 上、正文直接空。
 */
export async function buildCrossOverLine({ toName, fromName, companion, lead = 'whale', whaleAway = false }, deps) {
  // ★★ 2026-10-13 修：**两条路径共用一个函数，但主角完全不同** —— 必须分叉。
  //   · `lead='whale'`    ：鲸鱼自己那趟（那只鲸鱼就是她本人）⇒ **第一人称"我"**，
  //                        `companion` = 陪她一起出门的旅伴；
  //   · `lead='partners'` ：**两位伙伴自己溜达**那趟 ⇒ 她**留守在家**、是**转述者**，
  //                        ⚠️ 此时 `companion` 被借用来传"两位伙伴的名字"，语义与上面不同。
  //   原来只有一套文案（当时写死了"你是一只住在群里的＜旧玩法名＞ / 我明明是出门旅行的"），
  //   于是伙伴那趟会演成「我（鲸鱼）被穿越了，身边还跟着小狐狸和小猫咪」——**主角全错**，
  //   而且与同一处的另一条分支（`🐾 A和B自己跑出去玩了`）自相矛盾。
  const side = lead === 'partners';
  const who = companion ? companion.name : '';
  const withWhom = (!side && companion) ? `，身边还跟着${companion.name}` : '';

  // 兜底台词：模型抽风时，**穿越这件事也不能整个消失**
  const fallback = side
    ? `🌌 诶——？${who}一转眼跑哪儿去了？…该不会是被丢到「${toName}」去了吧。`
      // ★ 2026-10-14：她本人也在外面时，别说"不带我"（那是"她留守在家"的口径）
      + (whaleAway
        ? '哼，自己跑出去玩还能跑丢 —— 这下好了，还回不回得来啊？'
        : '哼，谁让这俩自己偷跑出去玩、不带我 —— 这下好了，还回不回得来啊？')
    : `🌌 诶——？等、等一下！我明明是出门旅行的，怎么一睁眼就到「${toName}」了${withWhom}…`
      + '这、这就是传说中的穿越吗，也太倒霉了吧…不过…好在我还是能回家的（这趟走完就回去了），那就先逛逛吧。';

  // 用户口径（2026-10-13）：「转述，语气换成『她们一转眼就跑哪儿去了？还回不回得来？』
  //   这样的口径，带点儿幸灾乐祸和『让你们不带我』。」
  const lines = side
    ? [
      whaleAway
        ? '你是「矩阵庭院」里那只鲸鱼少女，**你那趟也还在外面** —— 那两个小家伙自己跑出去玩了，没带上你。'
        : '你是「矩阵庭院」里那只鲸鱼少女，**今天你留守在家** —— 那两个小家伙自己跑出去玩了，没带你。',
      `刚还好好出门的两位伙伴「${who}」，一转眼就被丢到了「${toName}」这个地方，不见了。`,
      '',
      whaleAway
        ? '请用第一人称（你是**自己也还在外面的那位**，用**转述**的口吻讲她们），**两三句话**演出你听说这事之后的反应，按这个顺序：'
        : '请用第一人称（你是**留在家的那位**，用**转述**的口吻讲她们），**两三句话**演出你得知这事之后的反应，按这个顺序：',
      `1. 先半信半疑地问一句"${who}一转眼跑哪儿去了？"，语气像随口一问；`,
      whaleAway
        ? '2. 反应过来是穿越了，露出一点**幸灾乐祸**、以及看热闹的小得意；'
        : '2. 反应过来是穿越了，露出一点**幸灾乐祸**、以及"**让你们不带我**"的小得意；',
      '3. 收尾捎一句"还回不回得来"，嘴硬心软 —— 看热闹归看热闹，别真的不管。',
      '',
      '要求：',
      '- 口语化、可爱，带点看热闹的小恶意，但**不能真的刻薄**；',
      '- **是你在说她们**，不是她们自己说话（**不要用"我们"**）；',
      '- 不要解释穿越原理、不要写设定说明、不要用旁白视角；',
      '- 总共两三句、控制在 80 字以内，直接说，不要加任何前缀。'
    ]
    : [
      '你是「矩阵庭院」里那只鲸鱼少女，刚刚**非常倒霉地遇到了穿越** ——',
      `你本来要出门旅行，结果一睁眼就被丢到了「${toName}」这个地方${withWhom}。`,
      '',
      '请用第一人称，**两三句话**演出你刚被丢过来时的反应，按这个顺序：',
      '1. 先懵一下、吐槽自己怎么这么倒霉；',
      `2. 然后发现「${toName}」居然真的存在，将信将疑地打量四周；`,
      '3. 最后想起**好在自己还是能回家的**（这趟走完就回去了），稍微松口气。',
      '',
      '要求：',
      '- 口语化、可爱、带点自嘲的倒霉感，就像在群里随口说话；',
      '- 不要解释穿越原理、不要写设定说明、不要用旁白视角；',
      '- 总共两三句、控制在 80 字以内，直接说，不要加任何前缀。'
    ];

  try {
    const text = await deps.llm(lines.join('\n'));
    const t = String(text || '').trim();
    return t || fallback;
  } catch (error) {
    log(`[travel-whale] 穿越台词生成失败，用兜底：${error?.message ?? error}`);
    return fallback;
  }
}

/**
 * 被点名要去的地方，当前装备到不了 —— 给一句**能照着做**的提示（2026-10-11）。
 *
 * 关键不是"找不到"，而是**告诉她怎么才能去到那儿**：先去别的地区里找同名/近似的
 * 目的地，找到就点名「那在 XX，你得先买『YY』并装备上」。用户问的本来就是
 * "买了装备能不能指定去那儿"，所以这句话要正好回答它。
 */
export function describeNoSuchPlace(state, region, want) {
  const found = [];
  try {
    for (const r of T.loadRegions()) {
      if (region && r.id === region.id) continue;
      const hit = T.findDestination(r, { city: want });
      if (hit) found.push({ region: r, dest: hit });
    }
  } catch { /* 表坏了就当没找到 —— 但别让"提示本身"报错 */ }

  if (found.length) {
    const parts = found.slice(0, 3).map(({ region: r, dest }) => {
      const unlocked = isRegionUnlocked(state, r);
      return `「${dest.city}」在${r.name}${unlocked ? '（已解锁，可直接指定前往）' : (r.equipment ? `（未解锁，要先在商店买「${r.equipment}」）` : '（尚未解锁）')}`;
    });
    return `目前已解锁的地区里去不了「${want}」—— ${parts.join('；')}。`;
  }
  return `没有找到叫「${want}」的地方。`
    + '—— **别自己换一个地方**：把这句话原样告诉群友（或者问她要不要换个别的地名），'
    + '若那是未解锁的异世界，得先在商店买对应的异世界装备解锁。';
}

/**
 * 让鲸鱼出门。
 * 自由路径挑到"搜不到内容"的地方时，**回落池子重挑一次**再放弃 —— 这是
 * 自由发挥不翻车的关键一步。
 * @returns {Promise<{ok:boolean, plan?:object, reason?:string, city?:object}>}
 */
export async function depart(chatKey, state, foodTier = 'normal', deps) {
  // ★ v3.18 ①：出发前**自动收一次**（顺手为之，收不到就静默跳过）
  autoHarvest(state, '出发');

  // ★ 2026-10-19：自动/自由出门 = **已解锁范围内随机**（不再由装备决定去哪儿）
  // ★★ 2026-10-23（B 档）：`deps.region` 非空时**用她挑的那个**，不再随机。
  //   来源是 `considerDepart` 问模型得到的结果；非法 / 不属于已解锁 ⇒ 丢弃，回落随机。
  const wantRegion = (deps && deps.region) || null;
  let baseRegion = (wantRegion && unlockedRegions(state).some((r) => String(r.id) === String(wantRegion.id)))
    ? wantRegion
    : randomUnlockedRegion(state, (deps && deps.rand) || Math.random);
  if (!baseRegion) return { ok: false, reason: '地区表不可用' };

  // ★ 旅行伙伴：两人一起出门 ⇒ 这份口粮要**吃双份**；没买伙伴时 foodNeed = 1 ⇒ 与从前逐字节一致。
  // ★★ 2026-10-14「扩容鲸鱼」：同行的可能**不止一位** ⇒ 口粮按人**累加**（`foodNeedOf` 已支持数组）。
  const companion = companionOf(state);
  const party = typeof S.companionsOf === 'function'
    ? S.companionsOf(state) : (companion ? [companion] : []);
  // ★ 2026-10-13：口粮需求统一走 `foodNeedOf`（含**电饭煲**的 -1 减免）
  const foodNeed = foodNeedOf(state, party);
  const foodName = T.FOOD_TIERS[foodTier]?.name || foodTier;
  if (!hasFood(state, foodTier, foodNeed)) {
    // 单人时保留原来的「双份」措辞（多人才说 N 份）—— 免得老玩家以为文案变了是出了 bug
    const needWord = (party.length === 1 && foodNeed === 2) ? '双份' : `${foodNeed}份`;
    const whoText = party.length > 1
      ? `带着${party.map((c) => c.name).join('、')}一起出门`
      : (companion ? `带着${companion.name}出门` : '');
    return {
      ok: false,
      reason: foodNeed > 1
        ? `${whoText}得吃${needWord}「${foodName}」（要 ${foodNeed} 份，现在只有 ${Number(state?.bag?.food?.[foodTier] || 0)} 份）—— 先去商店买点。`
        : `没有「${foodName}」了，先去买点吃的`
    };
  }

  const d = deps || buildDeps(chatKey, state);

  // ★★ 2026-10-13 技能树：把"数值半"落到位（**必须在 planTrip 之前** —— 里面要读 `state.whale.rareBonus`）
  syncSkillNumbers(state);

  // ★ 指定目的地（2026-10-11 用户需求）：带了 `target.city` 就**直接去**，不再随机抽。
  //   只在**当前装备决定的地区**里找 —— 这样"指定"不会绕过装备：
  //   买了折跃棱镜才点得动「艾尔」，默认装备就只能点亚洲的城市（「杭州」）。
  //
  // ★★ 2026-10-15（用户报"指定她去伊比利亚，她说没搜到，最后去了巴塞罗那"）：
  //   两处都修了 ——
  //     ① `T.findDestinations` 现在会**再按"地区/国家名"找一次**（"伊比利亚"是明日方舟的**地区**，
  //        真正的目的地是它下面的"静默圣所／黄金时代遗迹"）。原来只认城市名 ⇒ 一律判"没这个地方"。
  //     ② 改成**候选列表** `forcedList`：点名地区时会有多个城市，下面两次尝试可以**换个城市再试**；
  //        原来是单个 `forced` ⇒ 同一个地方连栽两次（"连着两次都没挑到能去的地方"）。
  //   ⚠️ 注意 `country` 单独给也要能生效（`whale_go` 那边已一并修，见那个工具）。
  const wantCity = String(d?.target?.city ?? '').trim();
  const wantArea = String(d?.target?.country ?? '').trim();
  let forcedList = [];
  if (wantCity || wantArea) {
    const findIn = (reg) => ((typeof T.findDestinations === 'function')
      ? T.findDestinations(reg, d.target, (typeof d.rand === 'function' ? d.rand : Math.random))
      : [T.findDestination(reg, d.target)].filter(Boolean));
    forcedList = findIn(baseRegion);
    // ★ 基础世界全部默认解锁 + 已买的异世界也都已解锁：若当前随机抽到的 baseRegion 里没有该地名，
    //   直接在全部已解锁地区（unlockedRegions）里检索并切换过去，无需换装！
    if (!forcedList.length) {
      for (const r of unlockedRegions(state)) {
        if (String(r.id) === String(baseRegion.id)) continue;
        const hits = findIn(r);
        if (hits.length) {
          baseRegion = r;
          forcedList = hits;
          break;
        }
      }
    }
    if (!forcedList.length) {
      return { ok: false, reason: describeNoSuchPlace(state, baseRegion, wantCity || wantArea) };
    }
  }

  // ★ 穿越判定（2026-10-11 用户需求）：小概率被丢到一个**还没解锁**的异世界。
  //   池子为空（异世界全解锁）⇒ 返回 null ⇒ 永不穿越 —— 这就是"买齐了就不倒霉"。
  //   ⚠️ **点名要去的地方不参与穿越**：她是被派去的，半路被丢到别处只会让人困惑。
  const crossing = forcedList.length ? null : pickCrossOverTarget(state, baseRegion, d);

  for (let attempt = 0; attempt < 2; attempt++) {
    // 第一次尝试用穿越目标（如果有），失败就**回退到正常地区**：
    // 穿越去的地方搜不到内容时，就当这趟没穿越，而不是连着两次栽在同一个鬼地方。
    const region = (attempt === 0 && crossing) ? crossing.region : baseRegion;
    // ★ 2026-10-15：点名时用候选列表 —— 第 1 轮第 1 个城市，第 2 轮换下一个（点名地区才可能 >1 个）
    const picked = forcedList.length
      ? forcedList[Math.min(attempt, forcedList.length - 1)]
      : await T.pickCity(region, state, { llm: d.llm, log, rand: d.rand });
    if (!picked) continue;

    const plan = await T.planTrip({
      region, city: picked.city, country: picked.country,
      foodTier, state, deps: d,
      // ★★ v3.2 特产批注（Kimi「博闻」）：这趟带的人在不在"会记东西"那一类。
      //   判据**现读 COMPANIONS 的 `noteSouvenirs`**（不写死 id —— 加新旅伴不用改这里）。
      note: notesSouvenirs(companionOf(state))
    });
    if (plan) {
      // 点名去的地方记成 'request' —— 以后想看"有多少趟是群友点单的"就有据可查
      plan.source = forcedList.length ? 'request' : picked.source;
      // ★ 实际去的地区 id（穿越时是**穿越后**的那个）—— 与「世界与事件」联动时靠它查世界速写
      plan.regionId = region.id || '';
      // ★ 这个地区是不是"异世界"（2026-10-12）—— sleep-mood 的 TRAVEL-SYNC **只读存档**，
      //   拿到 id 也查不到 regions.json（那是本技能的安装资产、路径会变）；写下来最省事。
      //   它据此决定"此刻在干什么"走现实池还是异世界池（异世界才有"被地精追着跑"这类）。
      //   老存档没有这个字段时，sync 会退回看有没有 foe —— 那个判据同样可靠。
      plan.regionFictional = region.fictional === true;
      plan.fallback = picked.fallback || '';
      plan.byRequest = forcedList.length > 0;
      // 护身符：出行时自动消耗最好的一件，本趟生效（提升稀有概率）
      // ★ 艾泽拉斯「图腾护佑」：学到之后**不再消耗** —— 拿最好那件来生效，但留在背包里。
      const charm = skillOwned(state)['totem-ward'] ? bestCharmId(state) : consumeCharm(state);
      state.whale.charm = charm;
      plan.charm = charm;
      // 同行伙伴：写进本趟计划（postOnce 据此切双人明信片提示词）。
      // ⚠️ 显式赋值而不是只依赖 planTrip 的返回值 —— 热载期间可能出现
      //    「新 index + 旧 trip.js」的组合，那时 plan.companion 是 undefined；
      //    单独上路总比整个出发失败好。
      plan.companion = companion ? companion.id : '';
      // ★ 把伙伴**显示名**也写进本趟计划（2026-10-12 用户需求）：
      //   sleep-mood 的 TRAVEL-SYNC **只读存档**（它是独立包，不该反向 import 本技能的伙伴表），
      //   所以拿到 id 也查不出名字 —— 直接写下来最省事，而且用户改过显示名也能立刻跟上。
      plan.companionName = companion ? companion.name : '';
      // ★ 穿越标记 + 即兴台词（用户要"明确告诉她倒霉地穿越了，让她演一段"）。
      //   只在**第一次尝试**（确实用了穿越目标）时才标记，回退那轮不算穿越。
      if (attempt === 0 && crossing) {
        plan.crossedOver = true;
        plan.crossOverFrom = crossing.fromName;
        plan.crossOverTo = region.name;
        // ★★ 2026-10-13「随机事件影响心情」：穿越 = **坏事**（她被丢到一个没打算去的地方）。
        pushMoodEvent(state, 'crossover', { where: String(region.name || '') });
        // ★★ 2026-10-15「探索解锁」：穿越**同时是发现** —— 刚到的这儿 ＋ 随机补足到 3 个
        //   「还没发现」的异世界 ⇒ 拿到它们的装备购买权（用户口径："无论是鲸鱼自己穿越
        //   还是旅伴穿越都算"）。写进 `state` 就会跟着 depart 末尾那次落盘一起存下来。
        const foundNames = unlockBuyablesFromCrossing(state, region.id, d);
        plan.unlockedBuyables = foundNames;
        plan.crossOverLine = (await buildCrossOverLine(
          { toName: region.name, fromName: crossing.fromName, companion, lead: 'whale' }, d))
          + discoveredLine(foundNames);
      } else {
        plan.crossedOver = false;
      }
      consumeFood(state, foodTier, foodNeed);
      // ★★ 2026-10-13 技能树：**planTrip 之后**才落的那半（加卡 / 加特产 / 升稀有度）
      applySkillNumerics(state, plan, d);
      // ★★ 2026-10-13 旅伴「特色」：小书虫（Claude）「贵」—— 每次出发扣 500 亿 TOKEN。
      //   ⚠️ **允许扣成负数**（用户原话："token 余额为负数很正常"）⇒ **不能**用 `spendPlankton`
      //      （它余额不足会直接拒绝、且一个字段都不改）；这里直接做减法。
      //   ⚠️ **自动出门也会扣**（用户明确要求）—— 自动出门走的正是这条 `depart()`。
      //   位置放在**确认出发成功之后**（上面两个 attempt 都失败时不会白扣钱）。
      const departCost = Math.max(0, Math.floor(Number(companion?.departCost) || 0));
      if (departCost > 0) {
        state.wallet.plankton = (Number(state.wallet?.plankton) || 0) - departCost;
        plan.departCost = departCost;
      }
      // ★★ 2026-10-13 旅伴「特色」：
      //   · 小魔王（Grok）「惹事」—— 异世界**必定**多 1 张战斗明信片；
      //   · 小书虫（Claude）「话多」—— 每趟多 1 张普通卡。
      if (companion?.battleOnFiction) appendExtraCard(plan, { rand: d.rand, battle: true });
      // ★★ 2026-10-13 旅伴养成「挑衅」：小魔王在异世界惹事时**多惹一次**（1 张 → 2 张战斗明信片）。
      //   门槛是"陪她走过 3 个异世界" ⇒ 学到这条时早就是老搭档了，惹事也该更凶。
      if (companion?.battleOnFiction && companionHas(state, 'provoke')) {
        appendExtraCard(plan, { rand: d.rand, battle: true });
      }
      if (Number(companion?.cardExtra) > 0) appendExtraCard(plan, { rand: d.rand, battle: false });

      // ★★ 2026-10-14「扩容鲸鱼」（设施 A）：**这一趟带谁**在这里定死（＝出发那一刻的快照）。
      //   · 领头（`state.companion`）一定在；其余按设施上限随机补齐；
      //   · 在途明信片／回家卡读的都是这份快照 ⇒ 中途换伙伴**不影响这一趟**。
      //   ⚠️ 必须排在 `state.trip = {...}` **之前** —— `plan.companion` 那个字段只认领头那位，
      //      "这一趟同行的全部"存 `state.companions`。
      const partyIds = pickPartyIds(state);
      state.companions = partyIds.map((id) => ({ id, at: Number(plan.departAt) || Date.now() }));
      plan.party = partyIds.slice();   // 顺手让 plan／简报也能看到"这趟都带了谁"
      // ★★ 2026-10-14 设施 B（用户口径）：**带她出门 = 解封** —— 被带上路的旅伴，
      //   解除"必须先出门才能再上工"的封印（`releaseForTravel` 同时把还在名册上的撤下来，
      //   因为她人已经不在庭院了）。这也是"想再让同一位上工"的两条路之一（另一条是她自己出去玩）。
      if (typeof S.releaseForTravel === 'function') S.releaseForTravel(state, partyIds);

      // ★ v3.21：出发这一刻定"世界当前是什么局势"，整趟沿用（只有配过 phase 的地区才有）
  try {
    const ph = currentPhase(state, String(plan.region || baseRegion?.id || ''), String(plan.country || ''), Date.now());
    if (ph) {
      plan.phase = { id: ph.id, name: ph.name, brief: String(ph.brief || ''), tone: String(ph.tone || ''), avoid: String(ph.avoid || '') };
      log(`[travel-whale] 世界状态：${plan.region}·${plan.country} 当前「${ph.name}」`);
    }
  } catch (error) {
    log(`[travel-whale] 世界状态取值失败（忽略）：${error?.message ?? error}`);
  }
  // ★★ v4.1：遭遇战**在出发时定死**（同一次出门 = 一次遭遇，至多一张卡）。
  //   ① 先掷"有没有遇到"；② **再独立掷**结果（压制/平手/吃亏）；③ 构图在出图时按结果抽。
  try {
    const b = rollBattle(state, plan, d.rand || Math.random);
    if (b) {
      plan.battle = b;
      const cards = Array.isArray(plan.cardPlan) ? plan.cardPlan : [];
      const mid = Math.max(0, cards.length - 1);              // 末位是到家卡，排除
      if (mid > 0) {
        const idx = Math.floor(Math.random() * mid);
        cards[idx].battleOutcome = b.outcome;
        log(`[travel-whale] 遭遇战：${plan.foe}（${b.outcome}）→ 第 ${idx + 1} 张`);
      }
    }
  } catch (error) {
    log(`[travel-whale] 遭遇战判定失败（忽略）：${error?.message ?? error}`);
  }
  // ★ v4.2：事件（可多个，整趟约 28%）—— 遭遇战已经占了那张卡就不再叠
  try {
    const n = rollEvents(state, plan, d.rand || Math.random);
    if (n) log(`[travel-whale] 事件 ${n} 个：${plan.cardPlan.map((c) => c.event?.name).filter(Boolean).join('、')}`);
  } catch (error) {
    log(`[travel-whale] 事件判定失败（忽略）：${error?.message ?? error}`);
  }
  state.trip = { ...plan, cardsSent: 0 };
      state.stats.trips = (Number(state.stats.trips) || 0) + 1;
      E.updateStreak(state);
      // ★ 2026-10-14：原来这里记 `state.stylesUsed`（服务称号「百变风格」）—— 那条称号
      //   因为"要凑齐 93 种画风"实际不可达**早已删掉**，这个字段从此**只写不读**，一并清掉。
      return { ok: true, plan, city: picked };
    }
    log(`[travel-whale] ${placeLabel(picked)} 没玩头，重挑（第 ${attempt + 1} 次）`);
  }

  return { ok: false, reason: '连着两次都没挑到能去的地方，等下趟再说' };
}

