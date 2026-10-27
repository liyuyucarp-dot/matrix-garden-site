// 矩阵庭院（travel-whale）· 模块化组件：index.js
// 职责：技能入口（Facade）：生命周期（setup/activate/deactivate/dispose）、提示词段（promptSections）与全量向后兼容导出

import * as S from './state.js?v=realworld-1';
import { registerMergedTools } from './merged-tools.js';
import * as HM from './home.js';
import {
  GIFT_FOOD,
  GIFT_PLANKTON,
  RT,
  activeChats,
  allStyles,
  buildDeps,
  capability,
  captionModelOf,
  captionOverrides,
  cardDeps,
  cfg,
  isEnabled,
  isPrivateChat,
  killTicker,
  log,
  setCapability,
  setCfg,
  setLog,
  setServices
} from './core/runtime-deps.js';
import {
  awayCompanionIds,
  buildCommentScene,
  commentChanceOf,
  commentOnPostcard,
  companionEmoji,
  companionNamesText,
  companionOf,
  companionTraitText,
  dueStipend,
  foodNeedOf,
  gardenLevel,
  homeShotHoursOf,
  pickCommenter,
  stipendPayers
} from './core/companions-voice.js';
import {
  MOOD_EVENT_KINDS,
  MOOD_EVENT_TONE,
  appendExtraCard,
  pushMoodEvent,
  rollBattle,
  placeTagsFor,
  rollEvents
} from './core/mood-battle-events.js';
import {
  COMPANION_SKILLS,
  SKILLS,
  SKILL_SOUVENIR_RARE_CHANCE,
  applySkillNumerics,
  appointCompanion,
  appointWaitTail,
  companionHas,
  companionNoteFor,
  companionSkillGate,
  companionSkillOwned,
  companionWorldsOf,
  helpDataFor,
  learnCompanionSkill,
  learnSkill,
  ownedCompanionIds,
  pendingCompanionOf,
  pendingReasonText,
  pickSkillFlavor,
  regionNameOf,
  skillGate,
  skillOwned,
  skillVisitedRegions,
  souvenirWorlds,
  syncSkillNumbers
} from './core/skills-appointments.js';
import {
  awaySideTripOf,
  busyCompanionIds,
  currentPhase,
  homeMateIds,
  homeStayNames,
  isRegionUnlocked,
  isRegionVisible,
  normalizeSideTrips,
  refreshHomeAct,
  regionOfEquipped,
  restRange,
  sideTripsOf,
  syncWorldbook,
  toneForTrip,
  unlockedRegions,
  visibleRegionIds,
  visibleSkills,
  visualBriefForTrip,
  worldbookForHome,
  worldbookForRoot,
  worldbookForTrip
} from './core/world-sync.js';
export {
  activeThemeId,
  defaultBaseRegionId,
  defaultUnlockedIdsOfTheme,
  getActiveTheme,
  getMapTheme,
  isDefaultTheme,
  isOtherworldRegion,
  listWorldThemes,
  loadRawRegions,
  loadThemedRegions,
  otherworldIdsOfTheme,
  setWorldTheme
} from './core/theme-pack.js';
import {
  REBORN_DAYS,
  UNLOCK_PER_CROSSING,
  buildCrossOverLine,
  depart,
  describeNoSuchPlace,
  discoveredLine,
  pickCrossOverTarget,
  unlockBuyablesFromCrossing
} from './core/departure.js';
import {
  SAY_KINDS,
  cardTargets,
  fanoutTargets,
  groupLabel,
  homeKey,
  normChat,
  pendingSayKind,
  replyPanel,
  say,
  sayImage,
  sayKindOf
} from './core/broadcast.js';
import {
  makeSouvenirImage,
  markAreaSeen,
  outfitsForCards,
  postOnce,
  recordTripSouvenirs,
  sendCard,
  sendReturnCard,
  sendSouvenirImages,
  settleTrip,
  wardrobeText
} from './core/postcards-settle.js';
import {
  departSideTrip,
  pickSideParty,
  settleSideTrip,
  shootHomeGroup,
  sideTripTier,
  trimSidePlan
} from './core/side-trips.js';
import {
  autoHarvest,
  autoInvite,
  autoSpend,
  autoTend,
  bestFoodTier,
  considerDepart,
  spendMenu
} from './core/autonomy.js';
import { startTicker, tick } from './core/ticker.js';
import {
  BUY_MAX_PER_ORDER,
  EQUIP_PRICE,
  EXPRESS_PRICE,
  REFRESH_PRICE,
  SHOP,
  albumPageData,
  albumPageOfTrip,
  albumText,
  groupTrips,
  menuDataFor,
  menuRenderArgs,
  pantryPageData,
  sendExpressCard,
  shopPageData,
  tripNoteOf
} from './core/shop-album-menu.js';
import {
  companionAtHome,
  eatSouvenir,
  farmCapNow,
  farmText,
  farmTick,
  findPlot,
  findSouvenir,
  giftSouvenir,
  harvestBonusNow,
  hesitateGate,
  isFarmHelper,
  notesSouvenirs,
  pantryText,
  plantSouvenir,
  qwenAtHome,
  reapSouvenir,
  shootHarvest,
  shopText
} from './core/pantry-farm.js';
import { WHALE_LEGACY, guardHomeOnly, registerTools } from './core/tools-core.js';
import { registerMoreTools } from './core/tools-more.js';
import {
  activeThemeId,
  defaultBaseRegionId,
  defaultUnlockedIdsOfTheme,
  getActiveTheme,
  getMapTheme,
  isDefaultTheme,
  isOtherworldRegion,
  listWorldThemes,
  loadRawRegions,
  loadThemedRegions,
  otherworldIdsOfTheme,
  setWorldTheme
} from './core/theme-pack.js';

// ── 向后兼容：原 index.js 顶层命名导出全量保留（探针/外部模块直接 import index.js 零感知）──
export {
  commentChanceOf,
  awayCompanionIds,
  pickCommenter,
  buildCommentScene,
  commentOnPostcard,
  rollBattle,
  rollEvents,
  currentPhase,
  unlockedRegions,
  worldbookForTrip,
  toneForTrip,
  visualBriefForTrip,
  worldbookForHome,
  worldbookForRoot,
  syncWorldbook,
  buildCrossOverLine,
  depart,
  settleTrip,
  trimSidePlan,
  autoHarvest,
  spendMenu,
  considerDepart,
  autoSpend,
  autoTend,
  autoInvite,
  SHOP,
  EQUIP_PRICE,
  groupTrips,
  tripNoteOf,
  albumPageData,
  albumPageOfTrip,
  WHALE_LEGACY
};

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  setCfg(api.config);
  // 日志优先走**核心 logger**（会写进 data/logs/*.log）；拿不到服务时退回 api.log。
  // 踩过的坑：技能一直用 api.log → 生图失败/发送失败**只有 console 有**，
  // 事后翻日志文件一片空白，排查全靠猜。
  setLog((...args) => {
    try { if (RT.services?.log) return RT.services.log(...args); } catch { /* 落回 console */ }
    return api.log(...args);
  });
  setCapability(api.capability);

  // ── 核心服务桥（CORE-PATCH.md）────────────────────────────────────────────
  // 后台 ticker 要寄明信片/回家/自动出发，这些**不经过工具调用** ⇒ 拿不到 ctx 里的 sender，
  // 只能靠核心把服务主动送过来。两条路都试：
  //   ① api.onServices(fn) —— 打过核心补丁的宿主（服务已就绪会**立即**回调一次）
  //   ② api.services()     —— 只有 getter 的口径（可能还是 null）
  // ⚠️ **两条都没有时绝不能抛错**：setup 抛错 = 整个技能加载失败（宿主只记一行 ❌）。
  //    这里降级成"只推进状态、不发消息"，并打一条明确告警，方便对症下药。
  RT.apiRef = api;
  if (typeof api.onServices === 'function') {
    // ★ 必须**存下取消函数**：宿主的 `serviceListeners` 是个**全局 Set**，不注销的话
    //   旧实例的闭包会一直留在里面 —— 之后每次 setServices() 都把历史实例全唤醒一遍
    //   （各自再起一个 ticker）。注销动作放在 deactivate（见文件末尾）。
    RT.cancelServices = api.onServices((svc) => {
      setServices(svc);
      startTicker();
    });
  } else {
    try {
      const svc = typeof api.services === 'function' ? api.services() : null;
      if (svc) setServices(svc);
    } catch { /* 拿不到就算了，下面统一告警 */ }
    log('[travel-whale] ⚠️ 宿主没有 api.onServices —— 鲸鱼只会推进状态，**一条消息都发不出去**。'
      + '需要给核心打补丁（见 CORE-PATCH.md / core-patch/apply-core-patch.py）。');
  }

  registerTools(api);
  registerMoreTools(api);
  // ★ 2026-10-16：上面两轮把 whale_* 收进 WHALE_LEGACY（未注册），这里注册 5 个分发工具。
  //   注册完自检一次：23 个 action 少一个就明确报错（别静默丢功能）。
  try {
    if (process.env.WHALE_KEEP_LEGACY_TOOLS === '1') {
      log('[travel-whale] 逃生阀生效：按旧口径注册了 23 个 whale_* 工具（未合并）');
    } else {
      const r = registerMergedTools({ realApi: api, legacy: WHALE_LEGACY, guard: guardHomeOnly });
      log(`[travel-whale] 工具已合并：${r.actions} 个 action → ${r.merged} 个工具`
        + (r.missing.length ? `；⚠️ 未接上的 action：${r.missing.join(', ')}` : '，全部接上'));
    }
  } catch (e) {
    log(`[travel-whale] ⚠️ 合并工具注册失败（旧工具已收集但未注册，功能会缺失！）：${e?.message ?? e}`);
  }

  // 兜底：即使服务尚未注入也先把轮询起起来（tick 内部会判断 sender 在不在，
  // 不在就只推进状态、不发消息 —— 不会因为"没服务"整晚不跑）
  startTicker();
}

export function activate() {
  // 重载失败被"救活"时，监听器可能已在 deactivate 里注销过了 —— 服务已就绪就补挂回来
  // （正常路径下 services 非 null，这里什么都不做）。
  if (!RT.cancelServices && !RT.services && typeof RT.apiRef?.onServices === 'function') {
    RT.cancelServices = RT.apiRef.onServices((svc) => { setServices(svc); startTicker(); });
  }
  startTicker();
}

export function deactivate() {
  killTicker();                 // ★ 走**全局句柄** —— 清得掉"任意实例"起的 ticker
  if (typeof RT.cancelServices === 'function') {
    try { RT.cancelServices(); } catch { /* 宿主已收摊 */ }
    RT.cancelServices = null;
  }
}

export function dispose() {
  deactivate();
}

/** 同步函数（可用性判定走同步调用链）。 */
export function available() { return true; }

// ── 提示词 ────────────────────────────────────────────────────────────────
//   只在本会话"养了鲸鱼"时才注入 —— 没养的群不该被这段规则占 token。

export function promptSections(ctx) {
  try {
    if (!ctx?.chatKey) return [];

    // ★ 不在「家」的会话（BROADCAST 之后，鲸鱼只在 home 养）：本群/本私聊**只收明信片**。
    //   默认**完全静默** —— 那边不能用任何鲸鱼工具（守卫会拦），没必要为它占 token。
    //   只有**显式**写进 whitelist 的会话才说一句：那是"这个群也要参与"的信号，
    //   提示她"鲸鱼养在别处、别调用任何鲸鱼工具"，免得她张口就答应"好呀这就给你养一只"。
    //   （不用 isEnabled 判：它的第三条"本地有存档就算启用"会把改造前留下的旧存档也算进来。）
    const home = homeKey();
    const here = String(ctx.chatKey || '');
    if (home && here !== home) {
      const wl = String(cfg()?.whitelist ?? '')
        .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!wl.includes(here) && !wl.includes(here.replace(/^(group|private):/, ''))) return [];
      return [{
        id: 'travel-whale-away',
        title: '矩阵庭院（不在本群）',
        priority: 44,
        content: `小鲸鱼养在「${groupLabel(home)}」，**不在本群** —— 本群/本私聊只会收到它在路上寄回来的明信片。`
          + '群友要是说「在这养一只鲸鱼」「喂它」「看看它怎么样了」，就说明它养在别处，**不要调用任何鲸鱼工具**。'
      }];
    }

    if (!isEnabled(ctx.chatKey, cfg())) return [];

    // ── 分两档：还没养 / 已经养了 ──────────────────────────────────────────
    // ⚠️ 为什么必须分开：whale_status 对"不存在的鲸鱼"也会正常返回（一只空鲸鱼：
    //    「🏠 在家待着 / TOKEN 余额：0 亿 TOKEN」）。模型看到有状态，就以为**已经养上了** ——
    //    实测群友连说三次「在这养一只鲸鱼」，它一次都没调 whale_adopt
    //    （第 2 次只调了 finish，第 3 次调了 whale_status）。
    //    所以"还没养"这一档**只讲收养**，不给其它工具的存在感。
    if (!S.stateExists(ctx.chatKey)) {
      return [{
        id: 'travel-whale-adopt',
        title: '矩阵庭院（本群还没养）',
        priority: 44,
        content: '本群**还没有**养鲸鱼（已在允许名单里，但还没人收养）。'
          + '群友说「养一只鲸鱼」「在这养一只鲸鱼」「养个鲸鱼」时，**必须调用 travel-whale__whale_adopt**。'
          + '收养会建好存档，并送一份新手礼包（' + GIFT_PLANKTON + ' 亿 TOKEN + '
          + GIFT_FOOD + ' 份' + (S.FOOD_TIERS.normal?.name || '中份大白饭') + '）。'
          + '⚠️ 不要用 travel-whale__whale_status 或其它鲸鱼工具代替收养 —— 它们会显示一只**空的**鲸鱼，'
          + '存档并不会建立，群友会以为已经养上了。'
          + '在 travel-whale__whale_adopt 成功之前，不要调用任何其它鲸鱼工具。'
      }];
    }

    // 私聊与群聊的**出行规则不同**，提示词必须分开说，
    // 否则模型会承诺「它会自己出门」，而私聊里它根本不会动。
    const inPrivate = String(ctx.kind || '') === 'private' || isPrivateChat(ctx.chatKey);
    // 明信片可能同时投递到多个地方（设置 cardTargets）—— 提一句，免得她以为"只寄给本群"。
    const multiTgt = cardTargets().length > 1
      ? '（这趟旅行的明信片除了本群，还会同时寄到另外几个群/私聊。）' : '';
    const travelRule = inPrivate
      ? '这是私聊：它**不会自己出门**，只有你明确说「让它去旅行」「出门吧」时才会走（用 travel-whale__whale_go）。没有你的命令它会一直待着。'
      : '本群养着一只小鲸鱼，它会自己出门旅行、往群里寄明信片。' + multiTgt;

    const sections = [{
      id: 'travel-whale-rule',
      title: '矩阵庭院',
      priority: 44,
      content: travelRule
        + (inPrivate ? '你' : '群友') + '提到"鲸鱼去哪了 / 什么时候回来 / 还有多少 TOKEN / 收一下草 / 商店 / 买点吃的 / 让它去旅行 / 看看它寄的照片 / 有什么称号 / 旅行伙伴 / 换伙伴 / 数据标注车间 / 让谁去上班"时，'
        + '分别用 travel-whale__whale_status / travel-whale__whale_harvest / travel-whale__whale_shop / travel-whale__whale_buy / travel-whale__whale_go / travel-whale__whale_album / travel-whale__whale_titles / travel-whale__whale_companion / travel-whale__whale_work 这些工具，'
        + '不要自己编造它的状态、位置或带回的东西。'
        + '（商店里单有一栏「🐾 旅行伙伴」：' + companionNamesText() + '（各人的价格与特色看 travel-whale__whale_shop 的返回值），说"邀请/请她一起上路"就行 —— '
        + '**别用"买"这种把人当商品的说法**。'
        + '邀请之后她俩**一起出门** —— 每趟要多吃一份大白饭（双份），换来的好处是'
        + '明信片总量 +50%、稀有明信片概率翻倍，而且从那以后的明信片里会**画着两个人**。'
        + '★ **留在家、没被带着的伙伴**，只要凑够两人一组、背包里某一档米饭 ≥6 份，'
        + '也会**自己跑出去玩**（拿走 2 份饭、回来带 1 件特产，也可能穿越）。'
        + '邀请过的伙伴可以**随时商量着换**（用 travel-whale__whale_companion，或直接理解"换成小猫咪 / 让小白龙陪它"这类说法）——'
        + '不用再花见面礼；**但两种情况下换不成 —— 小鲸鱼本人在旅途中，或要换的那位自己跑出去玩了**'
        + '（这时只会先记下"说好了"，等人回来才真的换）'
        + '—— ⚠️ **家里别的旅伴自己跑出去玩不算**，别把那种情况说成"她还没到家"。'
        + '（回话口径是"**她同意啦**"，不是"换好了" —— 伙伴是人、不是装备。）。'
        + '群友问"请只狐狸""换个伙伴陪它""旅行伙伴是什么/有什么用"时，用 travel-whale__whale_shop 看栏位、travel-whale__whale_buy 邀请、travel-whale__whale_companion 切换。）'
        + '★ **数据标注车间**（庭院设施）：建好之后可以把**在家的旅伴**安排去打工（用 travel-whale__whale_work）——'
        + '她们在工位上每小时给一笔 TOKEN，而且**人在工位上的时候更爱刷动态**（路上的明信片更容易被她们评论）。'
        + '⚠️ 只能安排**在家**的（跟着出门的、自己跑出去玩的不行）；一位**最多连着干 24 小时**，'
        + '到点她会自己撂挑子下班，**想再让同一位上工必须先带她出趟门**。'
        + (() => {
          try {
            const stSec = S.loadState(ctx.chatKey);
            const ids = Object.keys(skillOwned(stSec));
            if (!ids.length) return '';
            return '她已经从旅行里学会：'
              + SKILLS.filter((k) => ids.includes(k.id)).map((k) => k.name).join('、')
              + '（"技能"是她在路上学到的东西，可以顺口提到，但别硬塞）。';
          } catch { return ''; }
        })()
        + (inPrivate
          ? '它寄明信片和回家都是自己完成的，不需要你催。'
          : '如果它正在旅行中，群友要它出门就直接说明它还没回来，不要重复调用 travel-whale__whale_go。它寄明信片和回家都是自己完成的，不需要群友催。')
        // ★★ 2026-10-15（用户报"指定去伊比利亚，她说没搜到，最后去了巴塞罗那"）：
        //   点名地点**去不成**时，最坏的失败是**自己换一个地方**还回一句"她出发了" ——
        //   群友会以为点的那里真去了。必须在提示词这一层也堵住（工具回执那句只是兜底）。
        + '★ 群友**点名要去某个地方**时（"让她去杭州""去伊比利亚""去西班牙"），把地名填进 travel-whale__whale_go 的 city —— '
        + '**城市名和地区/国家名都认**（点名地区时她会在那个地区里自己挑一座城）。'
        + '⚠️ 万一工具回话说"那儿去不了"（不在当前装备的地区里），**必须如实转告群友、并说明要买哪件装备** —— '
        + '**绝不许自己换一个地方**（"她说没搜到，然后就去了巴塞罗那"这种是错的）。'
        // ★★ 2026-10-15「探索解锁」：这段**每轮注入** ⇒ 写短一点（多一行 = 每轮多烧一点）。
        + '★ **异世界的装备要先"发现"才买得动**：她**穿越**落过一次的地方，会顺带把一批新世界的'
        + '坐标记下来（每次 3 个）；**还没发现的世界，商店里连名字都不出现**。'
        + '群友问起某个还没发现的世界时，如实说"还没找到那儿的坐标"，'
        + '**别自己编解锁条件、也别把没发现的世界名字报出来**（那正是要留着的探索感）。'
    }];

    // ★★ 2026-10-15「庭院是什么」（设定集 L0 常驻，用户拍板接线）：她得**一直**知道自己的家什么样 ——
    //   不只是在家的时候。从前她只有 L1（`life-system` 的世界书：她**此刻**在哪个世界）
    //   ⇒ 在外旅行时，prompt 里全是目的地的味道，一句都没有"她是从哪儿出来的"，
    //   回来讲旅行时就丢了参照（说不出"逛了一圈还是咱院子好"这种话）。
    //   ⚠️ 三条纪律：
    //     ① **整段必须是纯静态字符串** —— 一个变量都不许有。它每轮进系统提示词，
    //        掺一个随会话/时间变化的值，就把**它后面所有段**的字节位置推来推去，
    //        prompt 缓存前缀（token 大头）直接归零（`src/prompt.js` 的注释里有原话）。
    //     ② 只在**养了鲸鱼**的会话注入（本函数在 `isEnabled` 之后）—— 别的群不占 token。
    //     ③ 她在外旅行时 L1 与这段**同时在**，所以必须写一句消歧：**这是家，不是此刻所在地**。
    //        不写的话模型容易把"石板缝的蓝光""水镜"讲到目的地风景里去（两段串台）。
    //   ⚠️ 别写进 `persona.roleText` —— 那是全局态、会串台（§113 纪律）；
    //      挂在这里 ⇒ 只在养了鲸鱼的会话生效、禁用技能即消失。
    sections.push({
      id: 'travel-whale-home-lore',
      title: '矩阵庭院（她住的地方）',
      priority: 46,
      content: '她住在「矩阵庭院」—— 一座**不属于任何一个世界**的院子，是她自己占着的一格：'
        + '石板缝里淌着细淡的蓝光（那是数据在走线），头顶那片星空**是渲染出来的**'
        + '（星点排布整齐得像一张漫天的网格，“矩阵”这名字从这儿来）。'
        + '院子中央那方**水镜**是她的门 —— 她用它出门，也用它回家。'
        + '她不出门的日子就在院子里过；七位旅行伙伴也住在这儿，各自有各自的口吻。'
        + '★ 这段讲的是**她的家、她的来处**，不是她此刻所在的地方 —— 她此刻在哪儿，以别处给的说明为准。'
        + '她在外旅行时，**别把院子里的东西（水镜、石板缝的光、那片星空）讲到目的地的风景里去**。'
        + '★ 别把庭院说成某个世界的一部分，也别解释成结界、副本或任务空间 —— 它就是她的家。'
        + '★ 别把“门 / 水镜”讲成魔法，她自己也只当它是门口那道水。'
        + '★ 时间：**她那边就是这台机器的时间** —— 你几点，她几点。'
        // ★★ 2026-10-15（用户口径）：群友会拿"时差"来质疑（"你去欧洲怎么不倒时差""你那边怎么是白天"）。
        //   她必须答得出来 —— 因为**她去的那 9 片地不是群友身处的那个现实**：
        //   那是水镜里的那个现实（同名的、最大的那个世界），由**这台机器的钟**驱动 ⇒ 没有时差这回事。
        //   这句必须留在 L0（每轮注入）里，否则她在群聊里答不上来。
        + '群友问“你去欧洲怎么不倒时差 / 你那边怎么是白天”这类问题时，她的回答是：**“我去的不是你们那个现实。”** —— '
        + '她去的那 9 片地（亚洲、欧洲…）是**水镜里的那个现实**，由这台机器的钟驱动，'
        + '和群友身处的现实**不是同一个**，所以没有时差、也没有“当地时间”。'
    });

    // ★★★ 2026-10-15「清档 → 时空乱流」（用户口径原话）：
    //   「清档的时候告诉模型一声：你是【被时空乱流抛回来了，还带着小狐狸】。」
    //
    //   为什么必须让她**自己知道**：清档是**外力**，不是游戏内事件 ——
    //   她那趟没走完的旅行被直接抹掉（`trip` 清空，明信片/特产/图鉴/称号全没）。
    //   不说的话她会两头崩：① 以为自己还在那趟路上；② 群里问"明信片呢"只能瞎编。
    //   ⚠️ 三条纪律：
    //     ① 措辞里**不许出现**"存档/清档/重置/数据" —— 那是后台的事，她只会说"乱流"；
    //     ② **有时效**：只在她被抛回来后的 `REBORN_DAYS` 天里注入（否则一年后还在说"我刚被抛回来"）；
    //     ③ 这段含一个天数 ⇒ **每天会变一次**，所以给它**最低的 priority**（排在静态段之后），
    //        别塞进核心静态段中间 —— 否则天天把后面所有段的字节推来推去、缓存前缀白掉。
    try {
      const rst = S.loadState(ctx.chatKey);
      const rebornAt = Number(rst?.rebornAt) || 0;
      const days = rebornAt > 0 ? (Date.now() - rebornAt) / 86400000 : -1;
      if (rebornAt > 0 && days >= 0 && days <= REBORN_DAYS) {
        const ago = days < 1 ? '就在这几个小时里' : `大约 ${Math.floor(days)} 天前`;
        // 她身边带着谁 —— 只点名那位"跟着她一起被抛回来"的（＝当前旅伴）
        const mate = companionOf(rst);
        const mateText = mate ? `—— **身边还带着${mate.name}**（这是唯一没被冲走的东西）` : '';
        sections.push({
          id: 'travel-whale-reborn',
          title: '矩阵庭院（她刚经历的事：时空乱流）',
          priority: 30,
          content: `她**${ago}被一场时空乱流抛了回来**${mateText}。那趟旅行走到一半就被卷走了，`
            + '明信片、特产、一路攒下的图鉴与称号**全被冲散**，什么都没能带回来。'
            + '★ 这件事她自己心里有数，被问起可以照实说（"被时空乱流抛回来了"）；'
            + '★ 但**别提"存档 / 清档 / 重置 / 数据"**这类词 —— 那是后台的事，她只会说"乱流"。'
            + '★ 也别把"被抛回来"说成"我早就回来了" —— 那趟是真的没走完。'
        });
      }
    } catch { /* 读不到存档就跳过，绝不影响别段 */ }

    // ★★ 2026-10-14「借嘴署名」（§114，用户口径）：伙伴借她的嘴说话时，**她得知道那不是自己说的**。
    //   为什么必须补这一条：宿主落盘一律记 `self:true`/「我」⇒ 她读历史、写日记、回想时
    //   都会把那句当成自己说过的话。署名（写进消息文本）是目前唯一能穿透到存档的办法。
    //   ⚠️ **不能写进 `persona.roleText`** —— 那是全局态、会串台（§113 纪律）；
    //      挂在技能自己的 promptSections 上 ⇒ **只在养了鲸鱼的会话生效、禁用技能即消失**。
    sections.push({
      id: 'travel-whale-borrowed-voice',
      title: '矩阵庭院（伙伴借你的嘴说话）',
      priority: 45,
      content: '旅行伙伴偶尔会**"借你的嘴"**应一声 —— 那种回执会给你一整行**带署名的台词**'
        + '（形如 `「小狐狸」：去去去——……`，前面还带个图标）。'
        + '★ **带署名的那一行不是你（鲸鱼少女）说的话**，是那位伙伴自己的话。'
        + '发的时候**原样保留署名**（图标和 `「名字」：` 都不能省），不要改写成"她答应了"这类转述；'
        + '也不要把它当成你自己的口头禅 —— 之后聊天、写空间日记、回想今天发生了什么时，'
        + '都要记得那句是 TA 说的，**不是你说过的**。（你自己想说什么，另起一句说。）'
    });
    return sections;
  } catch { return []; }
}

export const internals = {
  SHOP, EQUIP_PRICE, depart, settleTrip, sendCard, sendReturnCard, postOnce, tick, activeChats, isEnabled,
  buildDeps, regionOfEquipped, bestFoodTier, allStyles,
  // 穿越（2026-10-11）：暴露给离线单测 —— 否则为了验证概率还得 mock 整个 depart
  pickCrossOverTarget, buildCrossOverLine,
  // ★★ 2026-10-15「探索解锁」：一次穿越 ⇒ 解锁 3 个异世界的装备购买权（离线单测要用）
  unlockBuyablesFromCrossing, discoveredLine, UNLOCK_PER_CROSSING,
  // ★★ 2026-10-15（当晚追加）：**同一个口径**供装备网格 / 技能树 / 技能列表 / 衣柜 / 商店共用 ——
  //   `isRegionVisible`（单个地区"她知不知道"）、`visibleRegionIds`（可见名单）、
  //   `visibleSkills`（可见世界的技能）。离线单测直接打这三个，别去摸 help.js 的内部函数。
  isRegionUnlocked, isRegionVisible, visibleRegionIds, visibleSkills,
  // 旅行伙伴（2026-10-11）：暴露给离线单测，免得测试还要额外 import 一次 state.js
  // ⚠️ 这里给的是**包装版**（热载期间返回 null），不是 S.companionOf 本体
  COMPANIONS: S.COMPANIONS, companionOf,
  // 伙伴可切换（2026-10-11）：宽松匹配 / 已拥有清单 / 图标 —— 给单测直接用
  matchCompanion: S.matchCompanion, ownedCompanionIds, companionEmoji, idleCompanions: S.idleCompanions,
  // ★ 2026-10-13「在途不换人、回家再换」的两个纯函数（离线单测用）
  appointCompanion, pendingCompanionOf, busyCompanionIds,
  // ★ 2026-10-15 换人闸门收窄（用户报"到家了却说没到家 + 换不了旅伴"）：
  //   `awaySideTripOf`（某位是否自己在外面玩）＋ `appointWaitTail`（延后时的说法）
  awaySideTripOf, appointWaitTail, pendingReasonText, sideTripsOf,
  // ★ 2026-10-15「点名去某地」：把"去不成时该说什么"也挂出来（离线验文案用）
  describeNoSuchPlace,
  // ★ 闲置伙伴「自己去玩」（2026-10-11）：常量 + 出行/结算 + 两个选择器，都给离线单测
  SIDE_TRIP: S.SIDE_TRIP, departSideTrip, settleSideTrip, sideTripTier, pickSideParty, trimSidePlan,
  // ★★ 2026-10-14 多趟化：趟数组的读取 / 归一化助手（离线单测要断言"两拨人同时在外"）
  sideTripsOf, normalizeSideTrips,
  // ★ BROADCAST（2026-10-10）：家 / 投递名单 / 扇出。setCfg/setServices 只给离线测试用
  //   （真实运行时 cfg 由 setup 里的 api.config 赋值、services 由 api.onServices 注入）。
  homeKey, cardTargets, fanoutTargets, normChat, groupLabel, say, sayImage,
  // ★★ 2026-10-21「播报分类」+「题词单独选模型」：四个纯函数给离线验
  //   （`sayKindOf` 验"默认 system"、`pendingSayKind` 验"老存档兼容"、
  //    `captionModelOf`/`captionOverrides` 验"空值不动、非空才切模型"）。
  sayKindOf, pendingSayKind, SAY_KINDS, captionModelOf, captionOverrides, cardDeps,
  // ★ 2026-10-13 step3：休息区间（给「家」存在感）—— 离线单测要看设置有没有被正确读到
  restRange,
  // ★★ 2026-10-13 step5 旅伴「特色」：每日津贴 / 追加额外卡（战斗卡与"话多"卡）/ 特色文本
  dueStipend, appendExtraCard, companionTraitText, stipendPayers,
  // ★★ 2026-10-13 庭院活动（联动 sleep-mood / life-system）：纯函数 + 世界书拼装
  refreshHomeAct, worldbookForHome, homeStayNames, worldbookForRoot, homeMateIds,
  // ★ 2026-10-24「庭院常时生效」：暴露同步本体 —— 离线单测要断言"在途时写进去的是**两段**"
  //   （只测 worldbookForRoot 验不到 `syncWorldbook` 里的拼装顺序）。
  syncWorldbook,
  // ★★ 2026-10-13「消耗动作」：立刻寄一张 / 两个价格
  sendExpressCard, REFRESH_PRICE, EXPRESS_PRICE,
  // ★★ 2026-10-13 庭院设施：定义表 + 等级读法 + 口粮/合照门槛两个收口
  GARDENS: S.GARDENS, gardenLevel, foodNeedOf, homeShotHoursOf,
  // ★★ 2026-10-13 技能树（试点）：表 + 门槛 + 学习 + 发动选择器 + 两个数值收口（全是纯函数）
  SKILLS, skillOwned, skillVisitedRegions, souvenirWorlds, skillGate, learnSkill,
  pickSkillFlavor, syncSkillNumbers, applySkillNumerics, regionNameOf,
  // ★★ 2026-10-13 旅伴养成：表 + 门槛 + 学习 + 三个读法（离线单测用）
  COMPANION_SKILLS, companionSkillOwned, companionWorldsOf, companionHas,
  companionSkillGate, learnCompanionSkill, companionNoteFor,
  // ★★ 2026-10-13「随机事件影响心情」：事件表 + 记账函数（离线单测用）
  pushMoodEvent, MOOD_EVENT_KINDS, MOOD_EVENT_TONE,
  SKILL_SOUVENIR_RARE_CHANCE,
  // ★ 2026-10-13：帮助图的装配函数 —— 线上与离线预览共用同一份数据（见它的注释）
  helpDataFor, BUY_MAX_PER_ORDER, REFRESH_PRICE, EXPRESS_PRICE,
  // ★ 2026-10-14 服装系统：去过哪些子区域 / 这一张谁穿什么 / 衣柜正文（离线单测用）
  markAreaSeen, outfitsForCards, wardrobeText,
  // ★★ 2026-10-14 特产出口（吃 / 送）：业务逻辑 + 查找 + 图鉴正文
  //   （刻意抽成纯函数：工具体要 ctx 与注册表，探针造不出来）
  eatSouvenir, giftSouvenir, findSouvenir, pantryText, hesitateGate,
  // ★★ 2026-10-14 菜地（种菜）：种下 / 收成 / 推进 / 找株 / 面板 / 千问在不在家
  plantSouvenir, reapSouvenir, farmTick, findPlot, farmText, qwenAtHome, farmCapNow,
  // ★★ 2026-10-14 v3.2 旅伴「特色」改成**字段判据**（现读 COMPANIONS）：批注 / 开地 / 收成加成
  notesSouvenirs, isFarmHelper, companionAtHome, harvestBonusNow,
  // ★ 收成图（**只在收获稀有作物时**拍；`home.js` 那半是 FARM_SCENE / buildHarvestPrompt）
  shootHarvest,
  // ★★ 2026-10-14 面板刷屏防治：直发入口（"每轮最多一页"就在它里面）+ 商店正文（离线量长度用）
  replyPanel, shopText,
  // ★★ 2026-10-14 第 4 张菜单图（商店）：菜单数据装配（离线预览/探针要用它拼 shop 那半）
  menuDataFor, shopPageData,
  // ★★ 2026-10-14 批 3 第 5 张菜单图（特产图鉴）：数据装配（离线预览/探针直接打它）
  pantryPageData,
  // ★★ 2026-10-26：稀有特产的入图鉴 / 配图 / 发送三件事 —— 探针要断言
  //   「第一次才画、重复带回不重画、新画的会真的发出去」。
  recordTripSouvenirs, sendSouvenirImages, makeSouvenirImage,
  // ★ 2026-10-14 相册页（第 6 张菜单图）：数据装配 + 文字兜底（探针 / 离线预览要用）
  albumPageData, albumText,
  // ★★ 2026-10-14 出图参数的唯一处 —— 探针直接调它，专门盯"名字写错 ⇒ 静默降级"这类 bug
  menuRenderArgs,
  HOME_ACTS: HM.HOME_ACTS, pickHomeAct: HM.pickHomeAct, homeActShort: HM.homeActShort,
  homeBucketOf: HM.homeBucketOf, HOME_ACT_BUCKET_MS: HM.HOME_ACT_BUCKET_MS,
  // ★ 2026-10-13 step4：在家的大合照 —— 提示词拼装 / 成员口径 / 触发判据（全是纯函数，验它不用出网）
  shootHomeGroup, homeMembers: HM.homeMembers, buildGroupPrompt: HM.buildGroupPrompt,
  shouldShootHome: HM.shouldShootHome, HOME_SCENE: HM.HOME_SCENE, HOME_STYLES: HM.HOME_STYLES,
  HOME_SHOT_SIZE: HM.HOME_SHOT_SIZE,
  setCfg: (fn) => { setCfg(fn); },
  setServices: (svc) => { setServices(svc); },
  // ── ★ v2.4.0 可切换世界锚点 / 主题包接口（供 courtyard-map 与外部探针联动）──
  activeThemeId,
  defaultBaseRegionId,
  defaultUnlockedIdsOfTheme,
  getActiveTheme,
  getMapTheme,
  isDefaultTheme,
  isOtherworldRegion,
  listWorldThemes,
  loadRawRegions,
  loadThemedRegions,
  otherworldIdsOfTheme,
  setWorldTheme,
  loadRegions: loadThemedRegions,
  visualBriefForTrip,
  toneForTrip,
  placeTagsFor
};

