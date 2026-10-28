// 矩阵庭院（travel-whale）· 模块化组件：core/tools-core.js
// 职责：HOME-ONLY 守卫与第一批工具注册（状态、去旅行、相册、商店、购买、背包、装备、换旅伴、建亭子、学技能、数据车间）

import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as TI from '../titles.js';
import * as H from '../help.js';
import { buildDeps, cfg, log, titleCtx } from './runtime-deps.js';
import {
  companionEmoji,
  companionOf,
  companionRosterText,
  companionTraitText,
  gardenDefs,
  gardenLevel,
  gardenNameList,
  speakAs,
  withLine
} from './companions-voice.js';
import {
  COMPANION_SKILLS,
  SKILLS,
  appointCompanion,
  appointWaitTail,
  companionSkillGate,
  companionSkillOwned,
  companionWorldsOf,
  learnCompanionSkill,
  learnSkill,
  ownedCompanionIds,
  pendingCompanionOf,
  pendingReasonText,
  regionNameOf,
  skillGate,
  skillOwned
} from './skills-appointments.js';
import {
  awaySideTripOf,
  isRegionUnlocked,
  isRegionVisible,
  placeLabel,
  sideTripsOf,
  visibleSkills
} from './world-sync.js';
import { groupLabel, homeKey, replyPanel, sayImage } from './broadcast.js';
import {
  EQUIP_PRICE,
  EXPRESS_PRICE,
  LOCAL_ONLY,
  buyCapOf,
  menuDataFor,
  menuRenderArgs,
  refreshPriceOf,
  sendExpressCard,
  shopTable
} from './shop-album-menu.js';
import { shopText } from './pantry-farm.js';

// ── 工具 ──────────────────────────────────────────────────────────────────

/**
 * ★ HOME-ONLY 守卫（BROADCAST）：鲸鱼只养在「家」那一个会话。
 *   在别处（其它群 / 私聊）调任何养鲸鱼的工具，都只回一句"窝在哪儿"，**不改任何数据** ——
 *   否则会长出第二只鲸鱼、两台服务器两份图鉴，而明信片却是从「家」那一只发出去的，直接乱套。
 *
 * ⚠️ 必须做成**模块级**函数、并**分别**包进两个注册入口（registerTools / registerMoreTools）：
 *    工具是分两批注册的（①–④ 在前者、⑤–⑨ 在后者）。只在其中一处包代理，另一处会整批漏掉
 *    —— 实测就漏了后 7 个（whale_go / whale_album / whale_titles / whale_equip / whale_help /
 *      whale_quick_test / whale_adopt 全部裸奔，在私聊里照样能养出第二只鲸鱼）。
 */
export function guardHomeOnly(def) {
  const inner = def?.execute;
  if (typeof inner !== 'function') return def;
  return {
    ...def,
    async execute(ctx, ...rest) {
      const home = homeKey();
      if (home && String(ctx?.chatKey || '') !== home) {
        return { content: `🐋 小鲸鱼的窝在「${groupLabel(home)}」—— 那边才是它的家，这边只收它旅行寄回来的明信片～` };
      }
      return inner.call(this, ctx, ...rest);
    }
  };
}

// ★ 2026-10-16 工具合并：23 个 whale_* 的**旧定义**收集在这里（action → def），
//   注册表里不再有它们；由 merged-tools.js 的 5 个分发工具按 action 转交。
//   为什么要合并：它们光"名字+说明"就 5,374 字符，每次调用都要带（见 2026-10-16.md §5.14）。
export const WHALE_LEGACY = new Map();   // 导出只为探针能注入假的 buy

// ★ v3.18：自主花钱的**频率闸**。
//   ⚠️ 没有它会非常糟：tick 是每轮都跑的（分钟级），余额够就会**每轮调一次模型**。
//
// ★★ 2026-10-23 修：原来放在模块作用域（`const AUTO_SPEND_AT = new Map()`），注释理由是
//   「重启后最多重算一次，代价可接受」—— **这个前提不成立**：插件热重载比重启频繁得多，
//   而热重载会新建模块实例 ⇒ 这个 Map 归零 ⇒ **闸等于没有**。
//   实测（10-22 10:00~10:07，只有一个庭院存档）：4 次 `加载成功` 紧跟 4 次"自主花钱"，
//   相隔 12s / 13s / 25s / 24s —— 而闸设的是 3 小时。7 分钟决策 4 次。
//   现在时间戳存在**存档里**（`state.autoSpendAt`），跨 reload / 跨重启都有效。
//   ⚠️ `AUTO_TEND_AT`（自理：收菜/补种/补口粮）暂留进程内 —— 它是"每 30 分钟一次"的低频动作，
//     重算代价是多收一次菜（幂等），不像购物那样真花钱。真要统一再改。
export const AUTO_TEND_AT = new Map();    // chatKey -> 上次自理检查（收菜/补种/补口粮）

export function registerTools(realApi) {
  const ok = (content) => ({ content: String(content) });
  const err = (content) => ({ content: String(content), isError: true });

  // ★ 2026-10-16 合并入口：把 `whale_*` 定义**收集下来、不注册**（注册表里只留 5 个分发工具）。
  //   收集器拦在 guardHomeOnly 之前；非 whale_ 的工具照旧注册。
  const api = {
    registerTool: (def) => {
      const m = /^travel-whale__whale_([a-z_]+)$/.exec(String(def?.id ?? ''));
      // ★ 逃生阀（2026-10-16）：`WHALE_KEEP_LEGACY_TOOLS=1` 时照旧注册 23 个旧工具。
      //   给 `_qcheck` 里的旧测试脚本用（它们按旧工具名取用）；生产不设这个变量 ⇒ 走合并后的 5 个。
      if (m && process.env.WHALE_KEEP_LEGACY_TOOLS !== '1') { WHALE_LEGACY.set(m[1], def); return def.id; }
      return realApi.registerTool(guardHomeOnly(def));
    }
  };

  // ① 状态
  api.registerTool({
    id: 'travel-whale__whale_status', name: '看庭院', category: 'query', icon: '🐋',
    description: '查看小鲸鱼现在在哪、还有多久回来、有多少 TOKEN、背包里有什么。群友问"鲸鱼去哪了""啥时候回来""还有几只"时用。'
      + '⚠️ 这是**一整页面板**，调用后整页会直接发到群里 —— 千万别为了"顺便看一眼余额"而调它；'
      + '（同一次唤醒里最多只会直发一页：若本轮已经发过别的面板，这条会被扣下不发。）',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        if (!S.stateExists(ctx.chatKey)) {
          return await replyPanel(ctx, '这个群还没养鲸鱼。说一句「在这养一只鲸鱼」就能养上，还会送一份见面礼。');
        }
        const st = S.loadState(ctx.chatKey);
        const now = Date.now();
        const ready = S.pondReady(st, now);
        const out = [
          `🐋 TOKEN 余额：${Number(st.wallet?.plankton) || 0} 亿 TOKEN（服务器里还有 ${ready} 亿 TOKEN 可收）`,
          `🎒 背包：` + (Object.keys(st.bag?.food || {}).length
            ? Object.entries(st.bag.food).map(([k, v]) => `${T.FOOD_TIERS[k]?.name || k}×${v}`).join('、')
            : '没有口粮了'),
          // 有旅行伙伴时多一行（它跟背包不在一处，容易忘）
          // ⚠️ 读 live 是**对的**（2026-10-13）：在途期间不写 live ⇒ 这里显示的就是
          //    "此刻真的跟着她的那位"，与途中明信片、travel-sync 的注入完全一致。
          // ★ 2026-10-15：领头那位若正**自己出去玩了**，如实注一句 —— 否则"她（鲸鱼少女）在家、
          //   伙伴却不在家"读起来自相矛盾，群友会以为面板坏了。
          ...(companionOf(st) ? [`${companionEmoji(companionOf(st))} 同行伙伴：${companionOf(st).name}（特色「${companionOf(st).trait || '增幅'}」：${companionTraitText(companionOf(st))}）`
            + (awaySideTripOf(st, companionOf(st)?.id) ? ` ← 这位自己跑出去玩了（${String(awaySideTripOf(st, companionOf(st)?.id).city || '在外面')}），还没回来` : '')] : []),
          // 说好但还没落定的那位：说清楚"**等的是谁**"（她自己 / 那位旅伴），免得群友
          //   ① 以为已经换好了；② 读到"等这趟回来"＋上一行"🏠 在家待着"觉得面板自相矛盾。
          ...(pendingCompanionOf(st) ? [`🕐 已经说好了：${pendingReasonText(st)}`] : []),
          // ★ 闲置伙伴自己出去玩那趟（2026-10-11）：在途时报一句，免得群友以为人丢了
          // ★ 10-14 多趟化：**逐趟**列（可能两拨人同时在外面）
          ...sideTripsOf(st).map((p) => `🐾 ${(p.partners || []).map((id) => (S.COMPANIONS || {})[id]?.name || id).join('和')}自己跑出去玩了（还有约 ${Math.max(0, Math.round((Number(p.returnAt) - now) / 3600000))} 小时回来）`),
          // ★ 2026-10-13 庭院设施（只列建过的）+ 加急明信片存量 —— 都在"家"这一侧，容易被忘
          ...(Object.keys(st.garden || {}).some((k) => Number(st.garden[k]) > 0)
            ? [`🏡 庭院设施：` + gardenDefs().filter((g) => gardenLevel(st, g.id) > 0)
              .map((g) => `${g.emoji}${g.name}${gardenLevel(st, g.id) >= g.maxLevel ? '（满级）' : ` ${gardenLevel(st, g.id)} 级`}`)
              .join('、')]
            : []),
          ...(Number(st.bag?.item?.express) > 0
            ? [`✉️ 加急明信片 ×${Number(st.bag.item.express)}（说"寄一张"就立刻用掉一张）`]
            : []),
          ...(() => {
            const ids = Object.keys(skillOwned(st));
            if (!ids.length) return [];
            const names = SKILLS.filter((k) => ids.includes(k.id)).map((k) => `${k.emoji}${k.name}`);
            return [`🧠 技能：${names.join('、')}（共 ${ids.length} 项）`];
          })(),
          // ★★ 2026-10-13 旅伴养成：旅伴的技能单列一行（顺便显示"陪你走过几个异世界"的进度）
          ...(() => {
            const cIds = Object.keys(companionSkillOwned(st));
            const progress = COMPANION_SKILLS.map((sk) => {
              const cName = String(((S.COMPANIONS || {})[sk.companion] || {}).name || sk.companion);
              return `${cName} ${companionWorldsOf(st, sk.companion).length}/${sk.needWorlds}`;
            }).join('、');
            const learned = COMPANION_SKILLS.filter((k) => cIds.includes(k.id)).map((k) => `${k.emoji}${k.name}`);
            return [learned.length
              ? `🐾 旅伴技能：${learned.join('、')}（共 ${learned.length} 项）｜异世界进度 ${progress}`
              : `🐾 旅伴成长进度（陪她走过几个异世界）：${progress}`];
          })(),
          `📮 已寄明信片 ${st.stats?.cards || 0} 张｜去过 ${Object.keys(st.visitedCities || {}).length} 个城市`
        ];
        if (st.trip) {
          const left = Math.max(0, Number(st.trip.returnAt) - now);
          out.unshift(`${st.trip.crossedOver ? '🌌 倒霉地穿越到了' : '✈️ 正在旅行：'}${placeLabel(st.trip)}（还有约 ${Math.round(left / 3600000)} 小时回来）`);
        } else {
          out.unshift('🏠 在家待着');
        }
        const titles = TI.summarizeTitles(st, titleCtx());
        out.push(`🏅 称号 ${titles.unlocked}/${titles.total}（成就值 ${titles.points}）`);
        const lastSpend = (Array.isArray(st.spendLog) && st.spendLog.length) ? st.spendLog[st.spendLog.length - 1] : null;
        if (lastSpend) {
          out.push(`🧾 最近一次自己花钱：${lastSpend.items.map((x) => `${x.name} ${x.price} 亿`).join('、')}`
            + `（共 ${lastSpend.total} 亿）`);
        }
        return await replyPanel(ctx, out.join('\n'));
      } catch (error) { return err(`查看失败：${error?.message ?? error}`); }
    }
  });

  // ② 收取
  api.registerTool({
    id: 'travel-whale__whale_harvest', name: '收 TOKEN', category: 'utility', icon: '🫧',
    description: '把服务器里产好的 TOKEN 收进钱包。群友说"收草""捞 TOKEN""收一下"时用。有 5 分钟冷却。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        return ok(S.mutate(ctx.chatKey, (st) => {
          const r = S.harvest(st);
          if (!r.ok) return `还没得收：${r.reason}`;
          // ★★ 2026-10-14 设施 B：车间的打工产出和服务器产出**分开报** ——
          //   否则群友看不出"车间里那几位到底挣没挣钱"（看不见＝等于没有）。
          const roomPart = Number(r.fromRoom) > 0
            ? `（其中 ${r.fromRoom} 亿是数据标注车间里她们挣的）` : '';
          return `收到 ${r.collected} 亿 TOKEN！${roomPart}`
            + `${r.glow ? '✨ 还捞到一只发光 TOKEN（稀有）！' : ''}当前共有 ${st.wallet.plankton} 亿 TOKEN。`;
        }).toString());
      } catch (error) { return err(`收取失败：${error?.message ?? error}`); }
    }
  });

  // ③ 商店
  api.registerTool({
    id: 'travel-whale__whale_shop', name: '看商店', category: 'query', icon: '🛒',
    description: '看**商店菜单图**：货架上有什么、多少钱、还有多少库存，以及邀请旅伴的见面礼。'
      + '群友问"能买什么""商店有什么""商店页面"时用。'
      + '⚠️ 庭院设施 / 技能树 / 服装衣柜**不在这张图上** —— 它们各自有自己的菜单图'
      + '（说「看设施菜单」「看技能菜单」「看衣柜」）。'
      + '⚠️ 调用就会往群里发一张图；**只是想知道某样东西多少钱、或者能不能建**时**不要调它** ——'
      + '直接 travel-whale__whale_buy 去买/去建，钱不够或条件不足它会用一句话告诉你差多少。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const st = S.loadState(ctx.chatKey);
        // ★ 2026-10-14（用户："把商店也做成菜单图吧"）：整页**长文本**改成**一张菜单图** ——
        //   和设施/技能/衣柜完全一致，也不再占聊天版面。
        //   ⚠️ 出图失败（例如不在 Electron 主进程里跑）就退回文字版，别什么都不发。
        try {
          // 出图参数走**唯一处** `menuRenderArgs()`（宽度/鲸鱼名只在那儿读一次）——
          // 抽它就是因为这里原来写错了名字（`settings()` 不存在）⇒ 静默降级成文字。
          const file = await H.renderMenuFile(menuRenderArgs('shop', menuDataFor(st, 'shop')));
          const sent = await sayImage(ctx.chatKey, file, LOCAL_ONLY);
          if (sent) {
            return ok('🛒 商店菜单图已经发出去了 —— 货架、库存、余额和旅伴见面礼都在图上。'
              + '**不要再把内容复述一遍**，顺口提一句就行。');
          }
        } catch (error) {
          log(`[travel-whale] 商店图生成失败，降级为文字：${error?.message ?? error}`);
        }
        return await replyPanel(ctx, shopText(st));
      } catch (error) { return err(`打开商店失败：${error?.message ?? error}`); }
    }
  });

  // ④ 购买
  api.registerTool({
    id: 'travel-whale__whale_buy', name: '买东西', category: 'utility', icon: '💰',
        description: '花 TOKEN 买东西：口粮（大白饭）、护身符、**加急明信片**（每轮补货只上架 1 张）、'
      + '解锁装备、**建/升级庭院设施**'
      + (gardenNameList() ? `（${gardenNameList()}）` : '')
      + '，或邀请一位旅伴一起上路（'
      + companionRosterText() + '）。还能花 1000 亿 TOKEN 刷新货架。'
      + '群友说「买点吃的」「买个护身符」「买装备」「请小狐狸一起上路」时用；换旅伴用 whale_companion。'
      + '⚠️ 小鲸鱼在旅途中、或要换的那位自己出去玩了，都只能先记下「说好了」，等人回来才真的换。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要买的东西（或要邀请的旅行伙伴）：小份/中份/大份大白饭、幸运海螺/鲸鳞护符/深海珍珠、异世界解锁装备名（如"风之翼""罗德岛徽章"），或某位旅行伙伴（' + Object.values(S.COMPANIONS || {}).map((c) => c.name).join(' / ') + '）' },
        count: { type: 'number', description: '数量，默认 1' }
      },
      required: ['item']
    },
    async execute(ctx, args) {
      try {
        const want = String(args?.item ?? '').trim();
        // ★ 2026-10-13 用户口径：**单次进货量减半**（原来是 20）。
        //   这让"货架库存"这个真约束更紧 ⇒ 「刷新货架」这个消耗动作才有存在感。
        //   ★ 上限**在拿到存档之后才夹**（`buyCapOf(st)`）—— 高达「补给舰」会把它抬到 20。
        const asked = Number(args?.count) || 1;
        if (!want) return err('得说要买什么');
        // ★★ 2026-10-14「借一副嘴」：**必须在 mutate 之前借嘴** ——
        //   `S.mutate(chatKey, fn)` 的回调是**同步**的（读-改-写），里面 `await` 会直接
        //   `SyntaxError: Unexpected reserved word`（第一版就栽在这儿）。
        //   用 `matchCompanion(want)` 提前算出是哪位（**纯函数，不需要存档**），
        //   把她那句话先生成好；mutate 回调里直接取闭包变量拼回执即可。
        //   ⚠️ 代价：万一 want 匹配到某位旅伴、却没走邀请/更换那两条分支，会白调一次模型
        //      （商店这个工具本来就是低频动作，可接受）。
        //   ⚠️ 场景文本**刻意不区分"邀请/更换"** —— 因为 `applied`（在途与否）要等 mutate
        //      才知道，而在这里还看不到；她本来也不该知道"这次花没花钱"。
        const preComp = (typeof S.matchCompanion === 'function') ? S.matchCompanion(want) : null;
        const preSaid = preComp
          ? await speakAs(preComp.id,
            '群友请你一起出门旅行 —— 以后你和那位鲸鱼少女结伴上路。'
            + '用你自己的口气应一声，一到两句，口语，别念设定、别谢场。')
          : '';
        return ok(S.mutate(ctx.chatKey, (st) => {
          S.restockIfDue(st);         // 先补货再卖，避免按过期库存结算
          // ★ 单次进货上限在这里夹（含高达「补给舰」的 +10）；`asked` 是模型给的原值。
          const count = Math.max(1, Math.min(buyCapOf(st), asked));
          // 异世界装备：按装备名或地区名匹配（基础世界默认全部解锁，无需购买装备）
          const region = T.loadRegions().find((r) => (r.equipment && r.equipment === want) || r.name === want);
          if (region) {
            if (region.defaultUnlocked || region.baseWorld) {
              return `${region.name}属于默认全部解锁的基础世界，不需要买解锁装备，随时都能直接去。`;
            }
            if (isRegionUnlocked(st, region)) return `${region.equipment || region.name} 已经解锁过了。`;
            // ★★ 2026-10-15「探索解锁」：**买之前先问"她知不知道这个地方"** ——
            //   判据与装备网格 / 技能树 / 衣柜 / 商店列装备**完全同一个** `isRegionVisible()`
            //   （= 已解锁 ∪ 已发现 ∪ **她本人去过**）。
            //   ⚠️⚠️ 这里原来直接调 `S.isEquipBuyable()` —— 那只是**"穿越发现"那一半** ⇒
            //      会出现"她自己去过提瓦特 ⇒ 网格里看得见那件装备、点买却说没发现坐标"的
            //      自相矛盾（与 §116 那个"说的和做的不是一套判据"同一个病）。
            //      能看见就必须买得动：展示层与购买闸**只能共用一个判据**。
            //   ⚠️ 文案**不许点名那个世界** —— 玩家没见过的地方，一报名字就剧透了，
            //      探索感当场归零（所以这里只说"那个世界"，不说 ${region.name}）。
            if (!isRegionVisible(st, region)) {
              return '🧭 还没发现那个世界的坐标呢 —— 这件装备暂时买不到。'
                + '（**去过**那儿、或者**穿越**落过一次，才会把那儿的坐标记下来。）';
            }
            if (!S.spendPlankton(st, EQUIP_PRICE)) return `TOKEN 不够：${region.equipment} 要 ${EQUIP_PRICE} 亿 TOKEN，你有 ${st.wallet.plankton} 亿 TOKEN。`;
            st.whale.equipUnlocked.push(region.id);
            return `🎒 解锁了「${region.equipment}」！以后可以让它带这件装备去${region.name}。`;
          }
          // 🐾 旅行伙伴（邀请制、**可切换** —— 不能走下面 shopTable 的库存/背包计数那一套）
          //   ★ 2026-10-11 改：原来买了就锁死"只能有一个"。现在买过的一律记进
          //     `companionOwned`，**之后再换不用花钱**；只有没买过的才收费。
          //   ★★ 2026-10-13 再改：**写存档一律走 `appointCompanion`** —— 她是"人"不是"装备"，
          //     而且她俩在路上时换不成（只记 `pendingCompanion`）。见那个函数的注释。
          const comp = (typeof S.matchCompanion === 'function')
            ? S.matchCompanion(want)
            : Object.values(S.COMPANIONS || {}).find((c) => c.name === want || c.id === want);
          if (comp) {
            const cur = companionOf(st);
            if (cur && cur.id === comp.id) return `${companionEmoji(comp)} ${comp.name} 正跟着出门呢，不用再问一次。`;
            // ★ 2026-10-13 改口径（用户）：这一栏是**找人**不是**换装备** ——
            //   原来的回话把"换伙伴"说得像在换零件；改成"她同意啦"，并且**在途时只记一笔**
            //   （见 `appointCompanion` 的注释：为什么不能在途改 live）。
            if (ownedCompanionIds(st).includes(comp.id)) {
              const r = appointCompanion(st, comp);
              return withLine(comp, preSaid, `「${comp.name}」同意啦`,
                r.applied
                  ? '从下一趟起由她陪小鲸鱼一起出门（路上吃双份大白饭，明信片 +50%、稀有概率翻倍）。'
                  : appointWaitTail(r));
            }
            if (!S.spendPlankton(st, comp.price)) {
              return `TOKEN 不够：想请动${comp.name}，见面礼得凑够 ${comp.price} 亿 TOKEN，你手头有 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`;
            }
            const r = appointCompanion(st, comp);
            return withLine(comp, preSaid, `「${comp.name}」答应一起上路啦！以后她俩结伴出门`,
              '路上要吃双份大白饭，换来明信片总量 +50%、稀有明信片概率翻倍。'
              + `还剩 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`
              + (r.applied ? '' : `（${appointWaitTail(r)}）`)
              + '（邀请过的伙伴，之后想换谁都只要对方点个头。）');
          }
          // ★★ 2026-10-13（用户口径）：**立刻刷新货架** —— 1000 亿 TOKEN。
          //   这是"消耗动作"而不是商品：不限量、不进背包、不占货架，
          //   所以必须在"商店物品"之前匹配（它不是 shopTable 里的条目）。
          if (/刷新|补货/.test(want)) {
            const price = refreshPriceOf(st);      // ★ 交界地「赐福点」⇒ 500
            if (!S.spendPlankton(st, price)) {
              return `TOKEN 不够：刷新货架要 ${price} 亿 TOKEN，你有 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`;
            }
            const hours = Math.max(0, Number((cfg() || {}).restockHours ?? 168));
            st.shop = st.shop || { stock: {}, restockAt: 0 };
            st.shop.stock = {};                       // 清空 = 满货（读取时逐项回退到各项初始库存）
            st.shop.restockAt = Date.now() + hours * 3600 * 1000;
            return `🛒 货架已经补满了（花了 ${price} 亿 TOKEN）。`
              + `下次自动补货在约 ${hours} 小时后。还剩 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`;
          }
          // ★★ 2026-10-13：**庭院设施**（可升级）。放在"商店物品"之前匹配 ——
          //   它不是货架上的消耗品，而是**没有库存上限**的长期成长线。
          const fac = gardenDefs().find((g) => g.name === want || g.id === want);
          if (fac) {
            const lv = gardenLevel(st, fac.id);
            const unit = Array.isArray(fac.pointCosts) ? '台' : '级';
            if (lv >= fac.maxLevel) return `${fac.emoji} ${fac.name} 已经满级了（${fac.maxLevel} ${unit}）。`;
            // ★★ 2026-10-13 晚「服务器阵列」：**不花 TOKEN，门槛是成就值**。
            //   分叉必须放在"扣钱"之前 —— 这类设施一分钱都不收，走错了会白扣她的钱。
            // ★★ 2026-10-14（用户口径）：门槛支持哨兵值 `'all'` —— 第四台 = **真正的「全成就奖励」**，
            //   门槛 = **当前称号总分**（不是写死的数字）⇒ 以后每加一条称号，门槛自己往上抬。
            //   所以这里要先算一次 `summarizeTitles`，再解析门槛。
            const rawCost = fac.pointCosts?.[lv];
            if (rawCost !== undefined) {
              const sum = TI.summarizeTitles(st, titleCtx());
              const pointCost = rawCost === 'all' ? sum.totalPoints : (Number(rawCost) || 0);
              if (sum.points < pointCost) {
                return `${fac.emoji} ${fac.name}不花 TOKEN —— 它要的是**成就值**：`
                  + `第 ${lv + 1} 台要 ${pointCost} 点`
                  + (rawCost === 'all' ? '（也就是**全部称号都拿到**）' : '')
                  + `，你现在 ${sum.points} 点（还差 ${pointCost - sum.points} 点）。`;
              }
              st.garden = st.garden || {};
              st.garden[fac.id] = lv + 1;
              return `${fac.emoji} ${fac.name}建起第 **${lv + 1}** 台！${fac.effect}。`
                + `（成就值 ${sum.points}／${sum.totalPoints}）`;
            }
            const price = Number(fac.prices?.[lv]) || 0;
            if (!S.spendPlankton(st, price)) {
              return `TOKEN 不够：把${fac.name}升到 ${lv + 1} 级要 ${price} 亿 TOKEN，`
                + `你有 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`;
            }
            st.garden = st.garden || {};
            st.garden[fac.id] = lv + 1;
            return `${fac.emoji} ${fac.name} 升到 **${lv + 1} 级**了！${fac.effect}。`
              + `还剩 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN。`;
          }
          // 商店物品
          const hit = Object.entries(shopTable()).find(([, it]) => it.name === want || it.id === want);
          if (!hit) return `商店里没有「${want}」。可说「看商店」看看有什么。`;
          const [key, it] = hit;
          // ★ 2026-10-13：`maxPerBuy` —— 有的道具**一次只让进一张**（加急明信片就是）；
          //   `unlimited` —— 历史上给"消耗动作型道具"用过（现在**已不用**：加急明信片改成
          //   正常库存 `stock: 1`，见 `shopTable()` 里的说明）。字段保留，别的道具若需要仍可用。
          const buyCount = Number(it.maxPerBuy) > 0
            ? Math.max(1, Math.min(count, Number(it.maxPerBuy)))
            : count;
          const stock = Number(st.shop?.stock?.[key]);
          const left = Number.isFinite(stock) ? stock : it.stock;
          if (!it.unlimited && left < buyCount) {
            // 卖光时给一句**能走下去的话**（加急明信片正是这种"卖光就得刷新"的道具）
            if (left <= 0) {
              const hoursLeft = Math.max(0, Math.round(S.restockRemainMs(st) / 3600000));
              return `${it.name} 这一轮已经卖完了 —— 想立刻再要一份就说「刷新货架」（`
                + `${refreshPriceOf(st)} 亿 TOKEN），或者等约 ${hoursLeft} 小时后的自动补货。`;
            }
            return `${it.name} 货架上只剩 ${left} 个了。`;
          }
          const cost = it.price * buyCount;
          if (!S.spendPlankton(st, cost)) return `TOKEN 不够：要 ${cost} 亿 TOKEN，你有 ${st.wallet.plankton} 亿 TOKEN。`;
          if (!it.unlimited) {
            st.shop = st.shop || { stock: {}, restockAt: 0 };
            st.shop.stock[key] = left - buyCount;
          }
          st.bag[it.kind] = st.bag[it.kind] || {};
          st.bag[it.kind][it.id] = (Number(st.bag[it.kind][it.id]) || 0) + buyCount;
          return `买好了：${it.name}×${buyCount}，花了 ${cost} 亿 TOKEN。还剩 ${st.wallet.plankton} 亿 TOKEN。`;
        }).toString());
      } catch (error) { return err(`购买失败：${error?.message ?? error}`); }
    }
  });

  // ④c ★ 2026-10-13（用户需求）：**立刻寄一张**（消耗「加急明信片」道具）
  api.registerTool({
    id: 'travel-whale__whale_express', name: '寄一张明信片', category: 'utility', icon: '✉️',
    description: '用掉一张「加急明信片」，让小鲸鱼**立刻**寄一张回来。'
      + '群友说"寄张明信片来""现在拍一张""加急寄一张""让她马上寄一张"时用。'
      + '在途 = 本趟额外多一张；在家 = 现拍一张庭院照。'
      + `⚠️ 需要先在商店买「加急明信片」（${EXPRESS_PRICE} 亿 TOKEN 一张；**商店每轮补货只上架 1 张**，`
      + '卖完就得刷新货架才有下一张）；没有道具时会提示先去买。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const st = S.loadState(ctx.chatKey);
        const have = Number(st.bag?.item?.express) || 0;
        if (have <= 0) {
          return err(`没有「加急明信片」了 —— 先在商店买一张（${EXPRESS_PRICE} 亿 TOKEN；`
            + '每轮补货只上架 1 张，卖完要刷新货架），再说"寄一张"。');
        }
        st.bag.item.express = have - 1;
        const d = buildDeps(ctx.chatKey, st);
        const r = await sendExpressCard(ctx.chatKey, st, d);
        if (!r.ok) return err(r.reason || '寄出失败');
        S.saveState(st);
        return ok(r.kind === 'home'
          ? '✉️ 用掉一张加急明信片 —— 已经现拍一张庭院照寄过来了（就是上面那条消息）。**不用复述**。'
          : '✉️ 用掉一张加急明信片 —— 本趟额外多寄了一张（就是上面那条消息）。**不用复述**。');
      } catch (error) { return err(`寄明信片失败：${error?.message ?? error}`); }
    }
  });

  // ④c 技能树（2026-10-13 试点）—— 学技能：**扣 TOKEN ＋ 消耗 1 件该世界的特产**。
  //   ★ 2026-10-14 修正：原来写的是"特产只当门槛、不被消耗"，用户判定那是 bug。
  api.registerTool({
    id: 'travel-whale__whale_skill', name: '学技能', category: 'utility', icon: '🧠',
        description: '查看或学习小鲸鱼（含旅伴）的技能。群友问「她会什么」「学个技能」「技能树」时用。'
      + '· 小鲸鱼：**去过那个世界**才能学；带数值的还要**手里有那个世界的特产**（招牌要稀有特产）。'
      + '· 旅伴技能：门槛是**她陪你走过 N 个异世界**（每位 4000 亿 TOKEN，不看特产）。'
      + '⚠️ 学一次消耗 1 件该世界特产（先花普通的、稀有留最后），学会永久有效、不能退；'
      + '该世界特产吃光送光后暂时学不了，得再带一件回来。',
    parameters: {
      type: 'object',
      // ★★ 2026-10-15「探索解锁」：这里原来把 30 条 `SKILLS` 的**名字全列出来当例子** ——
      //   而**工具描述是模型看的第一手信息**，等于把 15 个异世界的技能名直接喂给了她
      //   （她随口一念就剧透了，比帮助图更隐蔽）。现在只留旅伴技能（不挂世界、不会漏）。
      properties: { name: { type: 'string', description: '要学的技能名（旅伴：' + COMPANION_SKILLS.map((s) => s.name).join(' / ')
        + '）。留空 = 列出她**已经知道的世界**里的技能与各自能不能学 —— '
        + '还没去过、也没发现的世界，连技能名都不会出现' } }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        const owned = skillOwned(st);
        const want = String(args?.name ?? '').trim();
        if (!want) {
          // ★★ 2026-10-15「探索解锁」：技能列表只列**她已经知道**的世界的技能 ——
          //   还没发现的世界，**连技能名都不出现**（否则"探索感"从这条回执里漏光）。
          //   ⚠️ **已会的必须留着**：老档 / 手工改档都可能存在"技能在、那个世界却不在可见集里"
          //      —— 少了这一条，她"会什么"会当场看不见。
          const known = new Set(visibleSkills(st).map((s) => s.id));
          const shown = SKILLS.filter((sk) => known.has(sk.id) || owned[sk.id]);
          const cOwned = companionSkillOwned(st);
          // 新档（没去过任何异世界）筛完就是空的 ⇒ 直接回"还没解锁"，与帮助图 / 装备网格
          // **同一个口径**（都来自 `visibleRegionIds()`）。★ 旅伴技能已会的话不能提前返回。
          if (!shown.length && !Object.keys(cOwned).length) {
            return await replyPanel(ctx, '🧠 技能树还没到解锁的时候 —— 她得先出过一趟**异世界**的远门，'
              + '那边沾上的本事才会长到这棵树上。\n（在庭院里过日子的这段时间不算：这门功夫不属于任何一个世界。）');
          }
          const lines = ['🧠 技能树（去过的世界才能学；学了永久、不能退）：'];
          for (const sk of shown) {
            const has = Boolean(owned[sk.id]);
            const g = skillGate(st, sk);
            lines.push(`  ${sk.emoji} ${sk.name}［${regionNameOf(sk.region)}］`
              + `${has ? '✅ 已会' : ` ${sk.price} 亿 TOKEN`} — ${sk.effect}`
              + `｜${has ? '（永久）' : g.ok ? '✅ 可学' : `🔒 ${g.reason}`}`);
          }
          lines.push('', `已会 ${Object.keys(owned).length} 项。⚠️ **学一次要消耗 1 件该世界的特产**`
            + `（先花普通的、把稀有留到最后）＋ 一笔 TOKEN。`);
          // ★★ 2026-10-13 旅伴养成：旅伴技能**单开一段**（门槛口径完全不同，混在一起会看不懂）
          //   ⚠️ `cOwned` 在上面就算过了（那里要拿它决定"要不要提前返回"），**别在这儿再声明一次**。
          lines.push('', '🐾 旅伴技能（门槛：让**她陪你走过 N 个异世界**；每个 4000 亿 TOKEN）：');
          for (const sk of COMPANION_SKILLS) {
            const cName = String(((S.COMPANIONS || {})[sk.companion] || {}).name || sk.companion);
            const has = Boolean(cOwned[sk.id]);
            const g = companionSkillGate(st, sk);
            lines.push(`  ${sk.emoji} ${sk.name}［${cName}］`
              + `${has ? '✅ 已会' : ` ${sk.price} 亿 TOKEN`} — ${sk.effect}`
              + `｜${has ? '（永久）' : g.ok ? '✅ 可学' : `🔒 ${g.reason}`}`);
          }
          lines.push('', `旅伴技能已会 ${Object.keys(cOwned).length} 项。`);
          return await replyPanel(ctx, lines.join('\n'));
        }
        const sk = SKILLS.find((s) => s.name === want || s.id === want)
          || COMPANION_SKILLS.find((s) => s.name === want || s.id === want);
        if (!sk) {
          // ★ 2026-10-15「探索解锁」：报名字也只用**她已经知道**的那些 ——
          //   报全量等于把 15 个异世界的技能名一次性抖出来（同一条"探索感"纪律）。
          const names = [...visibleSkills(st), ...COMPANION_SKILLS].map((s) => s.name);
          return err(names.length
            ? `没有叫「${want}」的技能。现在她知道的是：${names.join('、')}`
            : '她现在还一个技能都没有 —— 得先出过一趟异世界的远门，那边的东西才会亮出来。');
        }
        const isComp = Boolean(sk.companion);
        const g = isComp ? companionSkillGate(st, sk) : skillGate(st, sk);
        if (!g.ok) return err(g.reason);
        return ok(S.mutate(ctx.chatKey, (s) => {
          const r = isComp ? learnCompanionSkill(s, sk) : learnSkill(s, sk);
          return r.ok
            ? `${sk.emoji} 学会「${sk.name}」了 —— ${sk.effect}。`
              + `${r.used ? `（用掉了 1 件「${r.used}」）` : ''}`
              + `还剩 ${Number(s.wallet?.plankton) || 0} 亿 TOKEN。`
            : r.reason;
        }).toString());
      } catch (error) { return err(`技能树读取失败：${error?.message ?? error}`); }
    }
  });

  // ④b 换旅行伙伴（2026-10-11）—— 伙伴邀请过之后**可切换**，这里是对外的切换入口。
  api.registerTool({
    id: 'travel-whale__whale_companion', name: '换旅行伙伴', category: 'utility', icon: '🐾',
    // ★ 2026-10-13：这两处原来**写死了四个伙伴名当例子**（加「小魔王」时就显得像"完整名单"）。
    //   改成现读 COMPANIONS —— 以后再加伙伴不用回来改（与 help.js 的 CHEATS 同一类坑）。
        description: '查看或切换小鲸鱼的旅行伙伴。群友说「换旅伴」「让小白龙陪她」「换成长小猫」「现在谁陪她出门」时用。'
      + '只能切到**已经邀请过**的伙伴（本机现有：'
      + Object.values(S.COMPANIONS || {}).map((c) => c.name).join(' / ') + '）；还没邀请的要先去商店请一位。'
      + '⚠️ 换不了只有两种：① **小鲸鱼本人在旅途中**；② **要换的那位自己跑出去玩**。'
      + '这两种都只先记「说好了」，等人回来才真的换。家里别的旅伴自己出门玩**不影响**换人。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '要切换到的伙伴名（' + Object.values(S.COMPANIONS || {}).map((c) => c.name).join(' / ') + '），留空则列出所有伙伴与当前状态' } }
    },
    async execute(ctx, args) {
      try {
        const all = Object.values(S.COMPANIONS || {});
        if (!all.length) return err('这个版本还没有旅行伙伴。');
        const st = S.loadState(ctx.chatKey);
        const cur = companionOf(st);
        const ownedIds = ownedCompanionIds(st);
        const want = String(args?.name ?? '').trim();
        if (!want) {
          const pend = pendingCompanionOf(st);
          // ★ 2026-10-15：判"在不在家"一律**落到具体的人**（通则：别用"有没有人不在家"这种集合判据）。
          //   原来这里写的是 `st.trip || sideTripsOf(st).length` ⇒ 家里只要有人出去玩就报
          //   "她俩还在路上" ⇒ 群友/模型都读成**她本人**没到家（用户报的那个 bug）。
          //   她自己 = `st.trip`；领头那位 = `awaySideTripOf(st, cur?.id)`。
          // 领头那位若正自己出去玩了，如实注一句（别让群友以为她人丢了 —— 她只是不在家）
          const leadSide = awaySideTripOf(st, cur?.id);
          const lines = ['🐾 旅行伙伴（邀请过就一直跟着出门；想换人只要她点个头）：'];
          for (const c of all) {
            const on = cur && cur.id === c.id;
            const has = ownedIds.includes(c.id);
            const wait = pend && pend.id === c.id;
            lines.push(`  ${companionEmoji(c)} ${c.name}（见面礼 ${c.price} 亿 TOKEN）｜${on ? '✅ 正在同行' : wait ? '🕐 已说好，回来就换' : has ? '已在队伍里，可商量' : '还没邀请'}`);
          }
          lines.push('', cur
            ? `现在跟着出门的是「${cur.name}」。${leadSide ? `（这位这会儿自己跑出去玩了 —— 在 ${String(leadSide.city || '外面')}，还没回来）` : ''}`
            : '现在还没有伙伴，它一直是一个人出门。');
          if (pend) {
            // ★ 2026-10-15：挡住换人的可能是**她自己**在旅途，也可能是**目标那位**自己跑出去玩 ⇒
            //   按真实原因说（`pendingReasonText`），只有两个都不是才叫"马上生效"。
            const blocked = Boolean(st.trip) || Boolean(awaySideTripOf(st, pend.id));
            lines.push(blocked
              ? `🕐 说好了：${pendingReasonText(st)}（现在换不成）。`
              : `🕐 说好了换成「${pend.name}」，马上生效。`);
          }
          return await replyPanel(ctx, lines.join('\n'));
        }
        const comp = (typeof S.matchCompanion === 'function')
          ? S.matchCompanion(want)
          : all.find((c) => c.name === want || c.id === want);
        if (!comp) return err(`没有叫「${want}」的旅行伙伴。现有的是：` + all.map((c) => c.name).join('、'));
        if (cur && cur.id === comp.id) return ok(`${companionEmoji(comp)} 「${comp.name}」已经在跟着出门啦。`);
        if (!ownedIds.includes(comp.id)) {
          return err(`还没邀请过「${comp.name}」—— 先去商店备一份 ${comp.price} 亿 TOKEN 的见面礼请她上路（说"请${comp.name}一起上路"），之后想换谁都只要对方点个头。`);
        }
        // ★★ 2026-10-14「署名」（§114）：与 `whale_buy` **同口径** —— 换伙伴也必须**由她本人应一声**，
        //   不能是"「小白龙」同意啦"这种第三人称转述。
        //   ⚠️ 借嘴**必须在 `mutate` 之前**：`S.mutate` 的回调是**同步**的（读-改-写），
        //      里面 `await` ⇒ `SyntaxError: Unexpected reserved word`（whale_buy 第一版就这么栽的）。
        //   ⚠️ 场景文本**刻意不区分"在途/立刻"** —— `applied` 要等 mutate 才知道，这里还看不到。
        const said = await speakAs(comp.id,
          '群友把你换成了陪那位鲸鱼少女一起出门的那位 —— '
          + '用你自己的口气应一声，一到两句，口语，别念设定、别谢场。');
        return ok(S.mutate(ctx.chatKey, (s) => {
          // ★ 唯一写入口（2026-10-13）：**她在途**时只记 pendingCompanion，回家才落定。
          const r = appointCompanion(s, comp);
          return withLine(comp, said, `「${comp.name}」同意啦`,
            r.applied
              ? '从下一趟起由她陪小鲸鱼一起出门（路上吃双份大白饭，明信片 +50%、稀有概率翻倍）。'
              : appointWaitTail(r));
        }).toString());
      } catch (error) { return err(`切换旅行伙伴失败：${error?.message ?? error}`); }
    }
  });

  // ⑤c ★★ 2026-10-14 设施 B（用户口径）：**数据标注车间** —— 让留守旅伴上工 / 下班 / 查看。
  api.registerTool({
    id: 'travel-whale__whale_work', name: '数据标注车间', category: 'utility', icon: '🏭',
    description: '安排小鲸鱼家的旅伴去「数据标注车间」打工。'
      + '她们在工位上每小时给一笔 TOKEN，而且**更爱刷动态** —— 路上的明信片更容易被她们评论。'
      + '群友说"让她去车间上班""让小猫咪去打工""让她下班""车间里都有谁在上工"时用。'
      + '⚠️ 只能安排**在家**的旅伴（跟着出门的、自己跑出去玩的不行）；'
      + '⚠️ 一位**最多连着干 24 小时**，到点她会自己撂挑子下班 —— '
      + '**想再让同一位上工，必须先带她出趟门**（带她旅行，或者放她自己出去玩）。',
    parameters: {
      type: 'object',
      properties: {
        mate: { type: 'string', description: '安排哪位旅伴（名字即可）。留空 ⇒ 只看车间现在的状态（谁在上工、还能安排谁）' },
        action: { type: 'string', description: 'start = 让她上工；stop = 让她下班。留空默认按"上工"处理' }
      }
    },
    async execute(ctx, args) {
      try {
        // ★★ 2026-10-21 修（玩家报：车间建好了、明明有空闲旅伴，却怎么都派不上工）
        //   `whale_work` 现在由 `whale_life` 的 action=work 分发进来（2026-10-16 合并）。
        //   旧参名是 `mate`，而合并层的 SHARED_PARAMS 里没有它 ⇒ 模型传的
        //   name / girl / item 一个都不被这里读到 ⇒ `want` 恒空 ⇒ 每次都落进
        //   下面的"只查看"分支，回一句「（现在没人上工）」。
        //   两道兜底，任一条失效都不至于再哑火：
        //     ① schema 里加了 `mate`（模型现在能照名字传）；
        //     ② 这里再认 name / girl / item（模型自创字段也能救回来）。
        const want = String(args?.mate ?? args?.name ?? args?.girl ?? args?.item ?? '').trim();
        // `op` 是合并层交还回来的子动作（start / stop）。
        const act = String(args?.action ?? args?.op ?? '').trim().toLowerCase();
        return ok(S.mutate(ctx.chatKey, (st) => {
          const slots = Number((typeof S.labelroomSlots === 'function') ? S.labelroomSlots(st) : 0) || 0;
          const workers = (typeof S.labelroomWorkers === 'function') ? S.labelroomWorkers(st) : [];
          const mustGo = (typeof S.labelroomMustTravel === 'function') ? S.labelroomMustTravel(st) : {};
          const nameOf = (id) => (S.COMPANIONS || {})[id]?.name || String(id);

          // ── 只查看 ──────────────────────────────────────────────────────
          if (!want) {
            if (slots <= 0) return '🏭 还没建「数据标注车间」—— 去商店买下这个设施，建好才有工位。';
            const lines = [`🏭 数据标注车间（工位 ${workers.length}/${slots}）：`];
            if (workers.length) {
              for (const w of workers) {
                const d = (S.COMPANIONS || {})[String(w.id)] || {};
                const h = Math.max(0, (Date.now() - (Number(w.since) || Date.now())) / 3600000);
                lines.push(`  ${companionEmoji(d)} ${d.name || w.id} —— 已连续 ${h.toFixed(1)} 小时（满 24 小时自动下班）`);
              }
            } else {
              lines.push('  （现在没人上工）');
            }
            const free = (typeof S.labelroomEligible === 'function') ? S.labelroomEligible(st) : [];
            lines.push('', free.length
              ? `可以安排：${free.map(nameOf).join('、')}（说"让谁去车间上班"）`
              : '现在没有能安排的旅伴（都在外面，或者刚下过班得先出门）。');
            const tired = Object.keys(mustGo).map(nameOf);
            if (tired.length) lines.push(`⚠️ 刚下过班、要先出门才能再上岗：${tired.join('、')}`);
            return lines.join('\n');
          }

          const comp = (typeof S.matchCompanion === 'function') ? S.matchCompanion(want) : null;
          if (!comp) return `没有叫「${want}」的旅伴。`;

          // ── 下班 ────────────────────────────────────────────────────────
          if (act === 'stop') {
            const r = (typeof S.endWork === 'function') ? S.endWork(st, comp.id, Date.now()) : { ok: false };
            return r.ok
              ? `${companionEmoji(comp)} 「${comp.name}」下班了 —— 说好了：先让她出去走走，才能再上工。`
              : `${companionEmoji(comp)} 「${comp.name}」这会儿没在车间里上工。`;
          }

          // ── 上工（默认） ────────────────────────────────────────────────
          const r = (typeof S.startWork === 'function')
            ? S.startWork(st, comp.id, Date.now())
            : { ok: false, reason: 'unsupported' };
          if (r.ok) {
            return `${companionEmoji(comp)} 「${comp.name}」进数据标注车间上班了 —— `
              + `每小时挣 ${Number(S.LABELROOM?.perWorkerPerHour) || 15} 亿 TOKEN；`
              + '人在工位上的时候也更爱刷动态（明信片更容易被她评论）。';
          }
          const why = {
            'no-room': '还没建「数据标注车间」（或者等级不够、没有空工位）—— 先去商店把车间建起来。',
            'not-owned': `还没邀请过「${comp.name}」—— 得先请她上路。`,
            'away': `「${comp.name}」这会儿不在家（跟着出门了，或者自己跑出去玩了），等她回来再说。`,
            'must-travel': `「${comp.name}」刚下过班 —— **得先带她出趟门**（带她旅行，或者放她自己出去玩）才能再上工。`,
            'already': `「${comp.name}」已经在车间里上工了。`,
            'full': '车间工位满了 —— 先让一位下班，或者把车间升一级。'
          }[r.reason] || '这会儿安排不了她。';
          return `${companionEmoji(comp)} ${why}`;
        }).toString());
      } catch (error) { return err(`数据标注车间操作失败：${error?.message ?? error}`); }
    }
  });
}

