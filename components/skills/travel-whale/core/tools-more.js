// 矩阵庭院（travel-whale）· 模块化组件：core/tools-more.js
// 职责：第二批工具注册（特产图鉴、吃/送、种菜/收菜、衣柜、成就、补发明信片、帮助说明图、快速测试、收养）

import fs from 'node:fs';
import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as TI from '../titles.js';
import * as H from '../help.js';
import * as OW from '../outfits.js';
import * as SV from '../souvenir.js';
import {
  GIFT_FOOD,
  GIFT_PLANKTON,
  QUICK_TEST_KEY_SUFFIX,
  QUICK_TEST_MS,
  QUICK_TEST_PLACES,
  buildDeps,
  cfg,
  log,
  senderOf,
  titleCtx
} from './runtime-deps.js';
import { companionOf, foodNeedOf, partyOf } from './companions-voice.js';
import { helpDataFor, ownedCompanionIds } from './skills-appointments.js';
import { isRegionUnlocked, placeLabel } from './world-sync.js';
import { depart } from './departure.js';
import { notifyUI, replyPanel, say, sayImage } from './broadcast.js';
import { deliveredMap, markCardDelivered } from './postcards-settle.js';
import { bestFoodTier } from './autonomy.js';
import { startTicker } from './ticker.js';
import {
  LOCAL_ONLY,
  albumPageData,
  albumPageOfTrip,
  albumText,
  menuDataFor,
  menuRenderArgs
} from './shop-album-menu.js';
import {
  eatSouvenir,
  farmText,
  findPlot,
  findSouvenir,
  giftSouvenir,
  pantryText,
  plantSouvenir,
  reapSouvenir,
  shootHarvest
} from './pantry-farm.js';
import { WHALE_LEGACY, guardHomeOnly } from './tools-core.js';

export function registerMoreTools(realApi) {
  const ok = (c) => ({ content: String(c) });
  const err = (c) => ({ content: String(c), isError: true });

  // 同样包一层 HOME-ONLY 守卫 —— 这一批是 ⑤–⑨，别漏（见 guardHomeOnly 的注释）。
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

  // ⑤ 出发
  api.registerTool({
    id: 'travel-whale__whale_go', name: '让它出门', category: 'utility', icon: '✈️',
    description: '让小鲸鱼出去旅行。群里攒够了 TOKEN、买了口粮以后，群友说"让它去旅行""出门吧""去玩吧"时用。没口粮会提示先买。'
      // ★★ 2026-10-16（用户报"穿越概率调成 1 也不穿越"）：**必须写清"什么时候别填"** ——
      //   原来只写了"点名时填"，模型在"你想去哪就去哪"这种自由出门时也**主动补一座城**，
      //   于是命中"点名不参与穿越"的设计 ⇒ **手动出门那条路永远不会穿越**
      //   （实查会话记录：模型自己填了 {"city":"北海道"}，思考里写着"主人说想去哪就去哪…选北海道吧"）。
      + '★★ **`city` / `country` 只在「群友原话里明确点了地名」时才填**；'
      + '群友只说"出门吧""去玩吧""你想去哪就去哪""带她散散心"这类**没点地名**的话时，'
      + '**两个字段都留空** —— 留空才是"她自己挑个地方"，也才**有可能在路上穿越**'
      + '（穿越只会发生在没有点名的那趟）。⚠️ **别替她定目的地**：你随手填一座城，'
      + '既剥夺了她自己挑地方，也让这趟**永远不会穿越** —— 群友会以为穿越坏了。'
      + '★ 群友**点名要去某个地方**时把它填进 `city` —— **城市名**（"杭州""艾尔""蒙德城"）和'
      + '**地区/国家名**（"伊比利亚""西班牙""浙江"）都认：点名地区时她会在那个地区里自己挑一座城。'
      + '但只能去**当前装备对应的那个地区**，填了别处会提示需要哪件装备。'
      + '⚠️ 点名了却去不成时，把原因告诉群友，**不许自己换一个地方**（"她出发了，去巴塞罗那"这种是错的）。',
    parameters: {
      type: 'object',
      properties: {
        food: { type: 'string', description: '用哪档口粮：small/normal/large，不填就挑最好的一档' },
        city: { type: 'string', description: '【可选】**只在「群友原话里明确点了地名」时才填**（群友说"你想去哪就去哪""出门吧"时**留空** —— 留空她自己挑，也才可能在路上穿越）。填的时候：**城市名**（"杭州""艾尔""蒙德城"）或**地区/国家名**（"伊比利亚""西班牙""浙江"）都行（两边用同一个字段，代码会自己判断）。填了就一定去那儿（不随机、也不会穿越）；点名一个**地区**时她会在该地区里自己挑一座城。不在当前装备的地区里时会返回提示。' },
        country: { type: 'string', description: '【可选】同样**只在群友原话里点了地名时才填**（没点名就留空 —— 留空才可能穿越）。也可以**只填它**（不填 city）：群友点的是"地区/国家"时用，如"伊比利亚""西班牙""中国""泰伦帝国"（⚠️ 用数据里真实存在的组名，例如亚洲下是"中国/日本/韩国"，不是"浙江"）。两个都填时它是消歧限定（"中国"＋"杭州"）。' }
      }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        if (st.trip) return err(`它已经在外头了（${placeLabel(st.trip)}），等它回来吧。`);
        // 有旅行伙伴 ⇒ 出门要吃**双份**口粮，挑档位时就得按 2 份来挑
        const comp = companionOf(st);
        // ★ 2026-10-14 扩容后同行可能不止一位 ⇒ 按**这趟实际会带的人**算（与 depart 同一口径）
        const foodNeed = foodNeedOf(st, partyOf(st));      // ★ 含电饭煲减免
        const tier = ['small', 'normal', 'large'].includes(String(args?.food))
          ? String(args.food) : bestFoodTier(st, foodNeed);
        if (!tier) {
          return err(foodNeed > 1
            ? `没有够吃的口粮了 —— 带着${comp.name}出门要 ${foodNeed} 份大白饭，先去商店买点。`
            : '没有口粮了，先去商店买点大白饭。');
        }
        // 指名要去的地方（可选）：群友说"让她去杭州""去艾尔"时，模型会把地名填进 city。
        // ★★ 2026-10-15 修（用户报"指定去伊比利亚却去了巴塞罗那"）：原来写的是
        //   `if (wantCity)` —— **只填 `country` 时目标会被整个丢掉 ⇒ 静默随机**，
        //   而这正是最坏的失败方式（群友点名了，系统当没听见、还回一句"她出发了"）。
        //   现在两个字段任意一个非空都算"点名"，一起传下去。
        //   ⚠️ 两个都空 = 真的没点名 ⇒ 保持随机（老行为）。
        const dep = buildDeps(ctx.chatKey, st);
        const wantCity = String(args?.city ?? '').trim();
        const wantCountry = String(args?.country ?? '').trim();
        if (wantCity || wantCountry) dep.target = { city: wantCity, country: wantCountry };
        const r = await depart(ctx.chatKey, st, tier, dep);
        if (!r.ok) return err(r.reason || '出发失败');
        S.saveState(st);
        // ★ 2026-10-21：手动喊「出发」产生的**也是出门播报** ⇒ journey（与自动出发同一类别；
        //   要不要只发本群由 `broadcast:false` 那条老机制决定，跟 kind 是两件事）。
        await say(ctx.chatKey, (r.plan.crossedOver
          ? r.plan.crossOverLine
          : (comp
            ? `🐋 我和${comp.name}一起出门啦 —— 这趟去 ${placeLabel(r.plan)}`
            : `🐋 我出门啦 —— 这趟去 ${placeLabel(r.plan)}`))
          + (Number(r.plan.departCost) > 0
            ? `\n💸 ${comp?.name || '小书虫'}说这趟得先付 ${Number(r.plan.departCost)} 亿 TOKEN`
              + `（余额 ${Number(st.wallet?.plankton) || 0} 亿）`
            : ''), { kind: 'journey' });
        const head = r.plan.crossedOver
          ? `⚠️ 它倒了大霉 —— 遇到了穿越，被丢到 ${placeLabel(r.plan)}（本来是要去${r.plan.crossOverFrom || '原定目的地'}的）`
          : `它出发了，去 ${placeLabel(r.plan)}`;
        return ok(`${head}（${T.FOOD_TIERS[tier]?.name}`
          + `${comp ? `×${foodNeed}，${comp.name}同行` : ''}，约 ${Math.round(r.plan.durationMs / 3600000)} 小时回来）。`
          + `这趟会寄 ${(Number(r.plan.cardCount) || 0) + 1} 张明信片。`
          + (r.plan.crossedOver
            ? '穿越的反应已经替它演过了（就是上面那条消息），**不用再复述一遍**。'
            : '不用再复述一遍。'));
      } catch (error) { return err(`出发失败：${error?.message ?? error}`); }
    }
  });

  // ⑥ 相册
  api.registerTool({
    id: 'travel-whale__whale_album', name: '看相册', category: 'query', icon: '🖼️',
    description: '看**明信片相册**：**多趟可以同在一页**（按趟分区、各自带标题，整页放满约 12 张才翻页，'
      + '**一趟不会被拆到两页**）；最后是**庭院合照**单独成页。'
      + '每格只写**编号 · 地名 · 景点**（题字不重复进格子 —— 明信片图上本来就印着那句）。'
      + '群友说"看相册""看看它寄的照片""带回过什么""相册第 2 页"时用。'
      + '★ 「看第 N 张」= 传 `no`（N 就是格子左上角的编号，整册固定不变）—— 会直接发那一张的大图。'
      + '⚠️ 不带 `no` 时是**一整页**，调用就会往群里发一张图（出不了图时自动降级成文字）。',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'integer', description: '看第几页（默认 1；整页放满约 12 张就翻页，**一趟不会被拆到两页**）' },
        no: { type: 'integer', description: '只看第 N 张：传了它就发那一张的大图、不出网格页（N = 缩略图左上角的编号）' },
        place: { type: 'string', description: '按地名直达："看庐山相册""看泰拉那趟" —— 传地名/景点关键词，直接翻到那一趟所在的页' },
        trip: { type: 'integer', description: '按趟次直达：第几趟（需要知道编号时用）' },
        index: { type: ['boolean', 'string'], description: '传 true = 出**旅行目录**（一张图列出每趟的目的地/日期/张数），用来一眼找到某一趟' }
      }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        // ★ 2026-10-14「看第 N 张」：直接发那**一张原图**。
        //   `sayImage` 本来就吃本地路径 ⇒ 这条零额外成本（不用渲染、不用压缩）。
        const wantNo = Math.floor(Number(args?.no) || 0);
        const wantIndex = args?.index === true || String(args?.index || '') === 'true';
        // ★ v4.4：旅行目录 / 按地名直达
        if (wantIndex) {
          try {
            const cat = albumPageData(st, 1, { catalog: true });
            const file = await H.renderMenuFile({ ...menuRenderArgs('album', { album: cat }) });
            const sent = await sayImage(ctx.chatKey, file, LOCAL_ONLY);
            if (sent) return ok(`📇 旅行目录已经发出去了（${cat.catalog.length} 趟 + 合照 ${cat.homes} 张）。**不要复述整张表** —— 顺口说一句就行。`);
          } catch (error) { log(`[travel-whale] 相册目录出图失败：${error?.message ?? error}`); }
        }
        if (wantNo > 0) {
          const all = Array.isArray(st.album) ? st.album : [];
          const c = all[wantNo - 1];                     // #1 = 最早那张（编号是正序的）
          if (!c) return err(`相册里没有第 ${wantNo} 张 —— 一共 ${all.length} 张。`);
          if (c.image) {
            const sent = await sayImage(ctx.chatKey, c.image, LOCAL_ONLY);
            if (sent) return ok(`📮 第 ${wantNo} 张已经发出去了（${placeLabel(c)}「${c.spot}」）。**不要再复述一遍**，顺口提一句就行。`);
          }
          return err(`第 ${wantNo} 张的图打不开了（文件可能被清过）—— 说「看相册」看缩略图吧。`);
        }
        let page = Math.max(1, Math.floor(Number(args?.page) || 1));
        // ★ v4.4：没给 page 但给了地名/趟次 ⇒ 直接定位到那一页
        if (!args?.page && (args?.place || args?.trip)) {
          const hit = albumPageOfTrip(st, { place: args?.place || '', trip: Math.floor(Number(args?.trip) || 0) });
          if (hit > 0) page = hit;
          else if (args?.place) return err(`相册里没找到「${args.place}」那趟 —— 说「看相册目录」可以看到全部趟次。`);
        }
        // ★★ 2026-10-14：相册**出图**（用户："把明信片排列成 2×3 或者更大的块，
        //   这样可以保留缩略图，方便查看和翻找或者选择。"）。
        //   原图平均 2.8 MB 一张 ⇒ 一页 12 张必须**现压缩略图**（渲染层做，见 help.js 的 albumThumb）。
        //   ⚠️ 出不了图（非 Electron 主进程 / 渲染异常）⇒ **降级成文字面板**，功能不丢
        //     （与 whale_help / whale_pantry 同款兜底）。
        //   ★ 画布宽度**不在这一层传**：相册页多宽是"这一页怎么排"的一部分，住 `help.js` 的
        //     `ALBUM_WIDTH`（1800，6 列每格才够看清缩略图）；`renderMenuFile` 会为 album 自动兜底。
        //     这样 `whale_help(menu:'album')` 走通用的 720 宽时也不会挤成一团。
        try {
          const album = albumPageData(st, page);
          const pics = (album.sections || []).reduce((n, s) => n + (s.items?.length || 0), 0);
          if (pics) {
            const file = await H.renderMenuFile({ ...menuRenderArgs('album', { album }) });
            const sent = await sayImage(ctx.chatKey, file, LOCAL_ONLY);
            if (sent) {
              return ok(`📮 相册第 ${album.page}/${album.pages} 页已经发出去了（整册 ${album.total} 张，本页 ${pics} 张缩略图，${(album.sections || []).length} 趟）。`
                + '**不要把内容复述一遍** —— 顺口提一句就行；群友想细看哪张，说「看第 N 张」即可。');
            }
          }
        } catch (error) { log(`[travel-whale] 相册图生成失败，降级为文字：${error?.message ?? error}`); }
        return await replyPanel(ctx, albumText(st));
      } catch (error) { return err(`看相册失败：${error?.message ?? error}`); }
    }
  });

  // ── ★★ 2026-10-14 特产出口：看图鉴 / 吃掉 / 赠送 ──────────────────────────
  //
  // 背景（用户："特产只在带回来那一刻有意义，之后就成了纯收藏品"）：
  //   改造前特产**只有一条用途** —— 当技能门槛，而且是"图鉴里有就行、不消耗"。
  //   ⇒ 15 件特产全是 `count:1`、零出口、零反馈。这三个工具是它们**第一次能出去**。
  //
  // 三条纪律：
  //   ① 消耗走 `S.consumeSouvenir()`（唯一的扣减点）—— 扣的是 `stock`，**不动 `count`**
  //      （count = 累计带回次数，扣它会把历史统计抹平，§69/§95）；
  //   ② 播报一律 `LOCAL_ONLY`（有人在某个群让她吃 / 送 ⇒ 只发那个群，§84 的判据）；
  //   ③ 心情走 `pushMoodEvent`（sleep-mood 只读我们存档，不跨包写它的文件）。

  // ⑨ 看图鉴（★ 2026-10-14 批 3：从"一整页文字"改成**一张菜单图**）
  api.registerTool({
    id: 'travel-whale__whale_pantry', name: '看图鉴', category: 'query', icon: '🎁',
    description: '看**特产图鉴**：她带回过哪些特产、每件从哪儿带的、还剩几份、'
      + '哪些能吃、哪些能种、吃过送过种过几次（图上按稀有度分了组，稀有特产还带图）。'
      + '群友说"看图鉴""有什么特产""带回来什么了""还有吃的吗""能种什么"时用。'
      + '★ 群友点名要看**某一件稀有特产的图**（"看图鉴里那个 XX""把 XX 的图发出来"）时，'
      + '给 `item` 填那件的名字 —— 会直接发那一张原图，不必发整页。'
      + '⚠️ 不填 `item` 就是**一整页**，调用就会往群里发一张图（出不了图时自动降级成文字）；'
      + '只想确认某一件在不在，直接看下面的说明即可。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '可选：只看某一件稀有特产的原图（写名字或关键词）。不填＝整页图鉴' }
      }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        // ★ 2026-10-26：点名看某一件的图。此前 `e.image` 写进存档后**没有任何读的出口** ——
        //   图鉴页不渲染、工具也不发，群友即使知道"有图"也永远看不到。
        const want = String(args?.item ?? '').trim();
        if (want) {
          const { entry, ambiguous } = findSouvenir(st, want);
          if (!entry) return err(`图鉴里没有「${want}」这样东西 —— 说「看图鉴」看看她带回过什么。`);
          if (!entry.image) return err(`「${entry.name}」没有存图（只有稀有特会产生图鉴图）—— 说「看图鉴」看整页。`);
          if (!fs.existsSync(String(entry.image))) {
            return err(`「${entry.name}」的图在存档里记着，但本地文件已经不在了（可能被清理过）。说「看图鉴」看其它条目。`);
          }
          const sent = await sayImage(ctx.chatKey, entry.image, LOCAL_ONLY);
          if (!sent) return err(`「${entry.name}」的图找到了，但发送失败（发送队列不可用）。`);
          return ok(`🖼️ 「${entry.name}」的图已经发出去了。**不要再复述图里的内容**，顺口提一句就行。`
            + (ambiguous?.length > 1 ? `（同名的还有 ${ambiguous.length - 1} 件，下次说全名更准。）` : ''));
        }
        // ★ 2026-10-14 批 3：图鉴页**出图**（用户要的"反馈感"）——
        //   15 件特产挤在相册那一行里只能看见 12 件，图上按稀有度分组、每件写全。
        //   ⚠️ 出不了图（非 Electron 主进程 / 渲染异常）⇒ **降级成原来的文字面板**，
        //     功能不丢（`whale_help` 也是这么兜的）。
        try {
          const file = await H.renderMenuFile(menuRenderArgs('pantry', menuDataFor(st, 'pantry')));
          const sent = await sayImage(ctx.chatKey, file, LOCAL_ONLY);
          if (sent) {
            return ok('🎁 图鉴图已经发出去了 —— 图上按稀有度分了组，每件都写着"从哪儿带的、能不能吃、能不能种、还剩几份、用过几次"，'
              + '有图的稀有特产也在下面排成了图墙（点名单件可以说"看图鉴里的 某某"）。'
              + '**不要再把内容复述一遍**，顺口提一句就行。');
          }
        } catch (error) { log(`[travel-whale] 图鉴图生成失败，降级为文字：${error?.message ?? error}`); }
        return await replyPanel(ctx, pantryText(st));
      } catch (error) { return err(`看图鉴失败：${error?.message ?? error}`); }
    }
  });

  // ⑩ 吃掉 / 喝掉
  api.registerTool({
    id: 'travel-whale__whale_eat', name: '吃掉特产', category: 'utility', icon: '🍽️',
    description: '把带回来的**能吃能喝**的特产吃掉或喝掉。群友说"吃掉那个""喝掉它""让她尝尝""尝尝那个冰淇淋"时用。'
      + '★ **第一次调它不会真吃**（不消耗任何东西）：工具会拦下，然后**由你自己**用她的口气说一句'
      + '"舍不得/再放一会儿"的话（工具会给你一句语气参考 —— 照那个**意思**说，别照抄、别把指令发出去）。'
      + '⚠️ **调它之前不要先替她表态**（别先答"好啊""吃吧"）—— 先表态再犹豫会自相矛盾。'
      + '说完就停在那里等群友回话；等群里真的又说了"吃吧""吃掉吧"之类的话，**再调一次**才会真的吃掉。'
      + '吃掉后消耗 1 份存量、她说一句感想、心情会好一点。'
      + '⚠️ 只有食物/饮品能吃 —— 器物、工艺品不能吃，可以改成送人。'
      + '⚠️ 吃**不给 TOKEN**（想赚钱不要靠这个）。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '特产名（可以只写关键词，例如"冰淇淋""抹茶"）' },
        by: { type: 'string', description: '可选：是谁让她吃的。填上那个人的昵称，她会在感想里点名' }
      },
      required: ['item']
    },
    async execute(ctx, args) {
      try {
        const item = String(args?.item ?? '').trim();
        const by = String(args?.by ?? '').trim();
        if (!item) return err('得说要吃哪一样');
        const now = S.loadState(ctx.chatKey);
        const { entry, ambiguous } = findSouvenir(now, item);
        if (!entry) return err(`图鉴里没有「${item}」这样东西 —— 说「看图鉴」看看她带回过什么。`);
        // ⚠️ 校验（是不是能吃 / 有没有存量）与扣减**全在 `eatSouvenir` 里** —— 抽出去是为了
        //   离线探针能直接打整串逻辑，不必伪造 ctx 与工具注册表。工具只负责翻译成群里的话。
        const r = S.mutate(ctx.chatKey, (st) => eatSouvenir(st, entry.name, {
          by, sid: String(ctx?.session?.id || '')
        }));
        if (r?.hesitate) {
          // ★★ v3.6（用户："直接 B 吧，一步到位"）：犹豫那句**改由模型自己说**。
          //   旧做法 = 工具直接 `say(r.line)` —— 实测翻车（主群 15:00 那一次）：
          //   模型先在正文里自由答了"愿意啊""不是舍不得"，工具紧接着又发一句
          //   "别急着替我决定" ⇒ 两句是**两条互不知情的通道**，拼在一起就是自己打自己脸。
          //   现在工具只负责**拦下这一次**（东西一点没动），把"说什么"交回模型 ——
          //   它在下一步拿到 tool result 时**知道自己刚说了什么**，能顺着接，不会矛盾。
          //   `r.line` 降级成**语气样本**（照意思自己说，不许照抄）。
          return ok('**拦下了这一次** —— 东西还在，什么都没消耗。\n'
            + '（下面是给你的指令，**不要照抄、也不要发到群里**）\n'
            + '现在用**她自己的口气**说一句"舍不得"的话：一两句就够，可以顺着刚才那句话说，'
            + '**千万别跟前面矛盾**。\n'
            + `语气参考：「${r.line}」\n`
            + '要点：是**她自己拿不定**（舍不得、想再放一会儿），**不是**否定群友、更不是教训人。\n'
            + '⚠️ 不要替她答应 —— 说完就停在那里等群友回话；'
            + '真的又有人说"吃吧""吃掉吧"之类的话，**再调一次**才会吃掉。');
        }
        if (!r?.ok) return err(r?.reason || '没能吃掉');
        await say(ctx.chatKey, `🍽️ ${r.line}`, LOCAL_ONLY);
        return ok(`已经吃掉了（还剩 ${r.left} 份「${entry.name}」）。`
          + (ambiguous?.length > 1 ? `同名的还有 ${ambiguous.length - 1} 件，下次说全名更准。` : '')
          + '不要再复述那句感想。');
      } catch (error) { return err(`吃特产失败：${error?.message ?? error}`); }
    }
  });

  // ⑪ 送给群友
  api.registerTool({
    id: 'travel-whale__whale_gift', name: '送特产给群友', category: 'utility', icon: '🎀',
    description: '让她把一件特产**送给群里的某个人**（群友说"送给他吧""把那件送给我""给你了"时用）。'
      + '★ **第一次调它不会真的送**（不消耗任何东西）：工具会拦下，然后**由你自己**用她的口气说一句'
      + '"舍不得/再拿一会儿"的话（工具会给你一句语气参考 —— 照那个**意思**说，别照抄、别把指令发出去）。'
      + '⚠️ **调它之前不要先替她表态**（别先答"愿意啊""送吧"）—— 先表态再犹豫会自相矛盾。'
      + '说完就停在那里等群友回话；等群里真的又说了"送吧""给他吧"之类的话，**再调一次**才会送出去。'
      + '送出去会消耗 1 份存量、她当着群说一句（越稀有越舍不得），并且**永久记在收礼人名下**'
      + '（以后能被问起"她送过我什么"）。'
      + '⚠️ 任何特产都能送（包括不能吃不能种的器物）。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '特产名（可以只写关键词）' },
        to: { type: 'string', description: '收礼人 —— 用群里那个人的昵称（或 QQ 号）' }
      },
      required: ['item', 'to']
    },
    async execute(ctx, args) {
      try {
        const item = String(args?.item ?? '').trim();
        const to = String(args?.to ?? '').replace(/^@/, '').trim();
        if (!item) return err('得说要送哪一样');
        if (!to) return err('得说要送给谁');
        const now = S.loadState(ctx.chatKey);
        const { entry } = findSouvenir(now, item);
        if (!entry) return err(`图鉴里没有「${item}」—— 说「看图鉴」看看有什么。`);
        // ⚠️ 校验与扣减全在 `giftSouvenir` 里（同 `eatSouvenir`，为了可离线单测）。
        const r = S.mutate(ctx.chatKey, (st) => giftSouvenir(st, entry.name, {
          to, sid: String(ctx?.session?.id || '')
        }));
        if (r?.hesitate) {
          // ★★ v3.6：与 `whale_eat` 同一处口径 —— 犹豫那句**由模型自己说**（工具不再硬发）。
          //   理由详 `whale_eat` 那段的注释（主群 15:00 的"先答愿意、再被工具塞一句别急着替我决定"）。
          return ok('**拦下了这一次** —— 东西还在，什么都没消耗。\n'
            + '（下面是给你的指令，**不要照抄、也不要发到群里**）\n'
            + '现在用**她自己的口气**说一句"舍不得"的话：一两句就够，可以顺着刚才那句话说，'
            + '**千万别跟前面矛盾**。\n'
            + `语气参考：「${r.line}」\n`
            + '要点：是**她自己拿不定**（舍不得、想再拿一会儿），**不是**否定群友、更不是教训人。\n'
            + '⚠️ 不要替她答应 —— 说完就停在那里等群友回话；'
            + '真的又有人说"送吧""给他吧"之类的话，**再调一次**才会送出去。');
        }
        if (!r?.ok) return err(r?.reason || '没能送出去');
        await say(ctx.chatKey, `🎀 ${r.line}`, LOCAL_ONLY);
        return ok(`已经送出去并播报了（这件还剩 ${r.left} 份）。不要再复述那句话。`);
      } catch (error) { return err(`送特产失败：${error?.message ?? error}`); }
    }
  });

  // ⑫ 种下（菜地）
  api.registerTool({
    id: 'travel-whale__whale_plant', name: '种特产', category: 'utility', icon: '🌱',
    description: '把一件**能种活**的特产种进菜地（群友说"种下去""把神之麦种了""种菜""菜地"时用）；'
      + '不带 item 则只看菜地现在种着什么、长到哪一步。'
      + '⚠️ 菜地要先**请千问（小折扇）**来庭院才会开出来，请过一次就永久有；默认 3 块地。'
      + '种下去消耗 1 份存量；普通/非普通 3 天成熟、稀有 5 天；成熟后能收 4 / 3 / 2 份。'
      + '⚠️ 种下**不需要**群友二次确认（它不是"消耗掉"，是会长出更多）。',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string', description: '要种的特产名（可只写关键词）；留空 = 只看菜地' } }
    },
    async execute(ctx, args) {
      try {
        const want = String(args?.item ?? '').trim();
        if (!want) {
          return await replyPanel(ctx, farmText(S.loadState(ctx.chatKey)));
        }
        const now = S.loadState(ctx.chatKey);
        const { entry } = findSouvenir(now, want);
        if (!entry) return err(`图鉴里没有「${want}」这样东西 —— 说「看图鉴」看看有什么。`);
        const r = S.mutate(ctx.chatKey, (st) => plantSouvenir(st, entry.name));
        if (!r?.ok) return err(r.reason || '没能种下去');
        await say(ctx.chatKey, `🌱 ${r.line}`, LOCAL_ONLY);
        return ok(`种下去了（地里 ${r.slots}/${r.cap} 株）。不要再复述那句话。`
          + '它会自己一天天长大，长一档就播一条；熟透了说「收菜」就能收。');
      } catch (error) { return err(`种特产失败：${error?.message ?? error}`); }
    }
  });

  // ⑬ 收菜
  api.registerTool({
    id: 'travel-whale__whale_reap', name: '收菜', category: 'utility', icon: '🧺',
    description: '收已经**长熟**的作物（群友说"收菜""收一下菜地""那株熟了吧"时用）。'
      + '不带 item = 收掉所有熟的；对没熟的会告诉你还差多久。'
      + '成熟后：普通/非普通收 4 / 3 份，**稀有收 2 份并且额外给一笔 TOKEN**。',
    parameters: {
      type: 'object',
      properties: { item: { type: 'string', description: '哪一株（名称关键词或株的 id）；留空 = 收所有熟的' } }
    },
    async execute(ctx, args) {
      try {
        const want = String(args?.item ?? '').trim();
        const r = S.mutate(ctx.chatKey, (st) => {
          const list = Array.isArray(st.farm) ? st.farm : [];
          if (!list.length) return { texts: [], note: '地里还没种东西 —— 说「种下 某某」。' };
          const last = S.FARM.stageCount - 1;
          const targets = want
            ? [findPlot(st, want)].filter(Boolean)
            : list.filter((p) => S.farmStageOf(p) >= last);
          if (!targets.length) {
            const pending = list.map((p) => `${p.name}（${SV.FARM_STAGE_NAMES[S.farmStageOf(p)]}）`).join('、');
            return { texts: [], note: `还没熟的：${pending || '（地里是空的）'}` };
          }
          const texts = [];
          const rareCrops = [];
          let token = 0;
          for (const p of targets) {
            const rr = reapSouvenir(st, p.id);
            if (!rr.ok) continue;
            texts.push(`🧺 ${rr.line}`);
            if (rr.rare) rareCrops.push(rr.plot.name);
            if (rr.token > 0) {
              token += rr.token;
              texts.push(`✨ 稀有的收成，额外进账 ${rr.token} 亿 TOKEN`);
            }
          }
          if (token > 0) texts.push(`（钱包现在 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN）`);
          return { texts, note: '', rareCrops };
        });
        if (!r?.texts?.length) return ok(r?.note || '现在没什么可收的。');
        for (const t of r.texts) await say(ctx.chatKey, t, LOCAL_ONLY);
        // ★ 收获到稀有作物 ⇒ 拍一张收成图（用户口径："只在收获稀有作物时出图"）
        if (r.rareCrops?.length) {
          const snap = S.loadState(ctx.chatKey);
          await shootHarvest(ctx.chatKey, snap, r.rareCrops[0], buildDeps(ctx.chatKey, snap));
        }
        return ok('已经收好并发到群里了。不要再复述这些句子。');
      } catch (error) { return err(`收菜失败：${error?.message ?? error}`); }
    }
  });

  // ⑥b 补发明信片（2026-10-11 加）
  //
  // 起因：中转站生图整体挂掉那天，途中两张 + 到家一张全退化成纯文字；图后来补上了
  // （写进 album[].image），但**没有任何工具能"把已经存下来的那张再发出来"** ——
  // 相册工具（whale_album）只返回文字、宿主那个发图工具只吃 URL、sender 只认本机路径
  // 而模型拿不到。于是"图呢"这件事在群里无解、只能靠她自己编话圆过去。
  // 补这一个口子：让「再发一次那张图」由她自己完成（图走 sayImage，会按投递名单扇出）。
  api.registerTool({
    id: 'travel-whale__whale_card', name: '补发明信片', category: 'utility', icon: '📮',
    description: '把已经存下来的明信片**重新发出来**（补发图片）。群友说"把明信片补发一下""那张照片呢""图呢""再发一次"时用。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要补发几张（可选）。**留空 = 把还没发出去过的全部补上（推荐）**；只有明确"只要最近某几张"时才传数字，最多 4。' }
      }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        const withImg = (st.album || []).filter((c) => c.image);
        if (!withImg.length) return ok('相册里还没有带图的明信片，没法补发。');
        const done = deliveredMap(st);
        const pending = withImg.filter((c) => !done[c.id]);   // 有图但从没投出去过的
        const asked = Math.round(Number(args?.count));
        // ★ 默认口径 = **把欠的全补上**。有账本可依，就不用猜"欠几张"了
        //   （2026-10-11：就是因为只能猜，模型自己传了 count:2，三张欠图只补了两张）。
        const pick = (Number.isFinite(asked) && asked > 0)
          ? withImg.slice(-Math.max(1, Math.min(4, asked)))
          : (pending.length ? pending : withImg.slice(-1));
        let sent = 0;
        const failed = [];
        for (const c of pick) {
          // ★ 2026-10-14 补发也是"手动索要" ⇒ 只发本会话，不扇出到投递名单
          if (await sayImage(ctx.chatKey, c.image, LOCAL_ONLY)) {
            sent += 1;
            markCardDelivered(st, c.id);        // 真投出去了才记账
          } else {
            failed.push(c.spot || c.id);
          }
          await new Promise((r) => setTimeout(r, 900));   // 别挤进同一个限频窗口
        }
        S.saveState(st);
        if (!sent) return err('补发失败：发送通道没成功。');
        return ok(`已把 ${sent} 张明信片重新发出去（${pick.slice(0, sent).map((c) => c.spot).join('、')}）。`
          + (failed.length ? `另有 ${failed.length} 张没发出去。` : '')
          + (pending.length > sent ? `相册里还有 ${pending.length - sent} 张欠着，要补再说一声。` : '')
          + '图片会自己发出去，**不要再复述画面细节、也不要再调发图工具**；'
          + '之前没发出来这件事，用你自己的话提一句就行，别报错代码。');
      } catch (error) { return err(`补发明信片失败：${error?.message ?? error}`); }
    }
  });

  // ⑧b 服装系统（2026-10-14）：看衣柜
  api.registerTool({
    id: 'travel-whale__whale_wardrobe', name: '看衣柜', category: 'query', icon: '👗',
    // ⚠️ 数字与人数**一律现读**：这里原来写死过"一共 39 套""六位少女"，
    //    v3.0 加到 60 套 / 8 位时就成了假话（工具描述是模型看的第一手信息）。
    // ★★ 2026-10-15「探索解锁」：**别报总套数**了 —— 衣柜现在只登"她已经知道的世界"那部分，
    //   说"一共 60 套"而实际只列 0 套会当场自相矛盾（而且"有 60 套"本身也是剧透）。
    description: '看**服装衣柜**：哪些已解锁、哪些能买（得先去那个地方）、'
      + `${OW.WARDROBE_GIRLS.length} 位少女现在各穿着什么、以及还差哪些没去过。`
      + '⚠️ 衣柜只登**她已经知道的世界**里的衣服 —— 还没去过、也没发现的世界，连衣服名都不出现。'
      + '群友说"看衣柜""有什么衣服""她能穿什么""衣服"时用。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const st = S.loadState(ctx.chatKey);
        // ★ 2026-10-14 用户口径："衣柜很大，单独做一个可展开的、包含解锁条件的页面。"
        //   ⇒ 出一张**独立菜单图**（按 12 个世界折叠 + 每套写清"还差去哪个子区域"）。
        //   ⚠️ 这是"某个会话里有人要看"⇒ 走 `LOCAL_ONLY`，**不扇出**到投递名单（同 §84 的口径）。
        // ⚠️ 出图参数走 `menuRenderArgs()` —— 这里原来写着 `settings().helpImageWidth`，
        //   而 `settings` 只是 `tick()` 的局部对象 ⇒ **「看衣柜」从加进来那天起就没出过图**
        //   （每次都抛 ReferenceError、被外层 catch 接住，回一句"看衣柜失败：settings is not defined"）。
        const file = await H.renderMenuFile(menuRenderArgs('wardrobe', helpDataFor(st)));
        const sent = await sayImage(ctx.chatKey, file, LOCAL_ONLY);
        if (!sent) return err('衣柜图生成好了，但没发出去（发送通道不可用）。');
        return ok('👗 衣柜图已经发出去了 —— 图上按世界分了组，每一套都写清了"还差去哪个子区域"。'
          + '**不要再把内容复述一遍**，顺口提一句就行。');
      } catch (error) { return err(`看衣柜失败：${error?.message ?? error}`); }
    }
  });

  // ⑧c 服装系统：买 + 换装 + 随机换装
  api.registerTool({
    id: 'travel-whale__whale_wear', name: '穿衣服', category: 'utility', icon: '👚',
    description: '给某位少女**买下并换上**一套服装，或者**随机换装**。'
      + `⚠️ 得先去过那个地方（她本人去或旅伴去都算），每套 ${OW.OUTFIT_PRICE} 亿 TOKEN；`
      + '已经买过的不再收钱，可以随时换来换去。'
      + '群友说"给狐狸穿巫女服""买那套""换身衣服""随机换一身""随便穿点别的"时用。'
      + '⚠️ 每套只绑一位少女，想让它穿别的要说她自己的那几套（先"看衣柜"）。'
      + '★ 想**换回原来那身**（默认着装）时 `outfit` 传「默认」—— 默认那身不在衣柜里，只有这条路能回去。',
    parameters: {
      type: 'object',
      properties: {
        girl: { type: 'string', description: '给谁穿：小狐狸 / 小白龙 / 小书虫 / 小猫咪 / 小魔王 / 小鲸鱼（她自己）。留空 = 这套绑的那位。' },
        outfit: { type: 'string', description: '服装名或关键词（比如"巫女服"）。配合 random=true 时可留空。' },
        random: { type: 'boolean', description: 'true = 随机换装：每位少女各自从**已解锁**的里随机抽一套穿上。' }
      }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        st.wardrobe = (st.wardrobe && typeof st.wardrobe === 'object') ? st.wardrobe : { owned: {}, worn: {} };
        st.wardrobe.owned = st.wardrobe.owned || {};
        st.wardrobe.worn = st.wardrobe.worn || {};

        // ① 随机换装 —— 每位各抽一套（没得抽的保持默认）
        if (args?.random === true) {
          const lines = [];
          for (const g of OW.WARDROBE_GIRLS) {
            const pool = OW.outfitsOf(g.id).filter((o) => st.wardrobe.owned[o.id] === true);
            if (!pool.length) {
              delete st.wardrobe.worn[g.id];
              lines.push(`  ${g.emoji} ${g.name}：还没有能换的，保持默认`);
              continue;
            }
            const picked = pool[Math.floor(Math.random() * pool.length)];
            st.wardrobe.worn[g.id] = picked.id;
            lines.push(`  ${g.emoji} ${g.name}：${picked.name}`);
          }
          S.saveState(st);
          return ok('🎲 随机换装 —— 各位现在穿：\n' + lines.join('\n')
            + '\n（下一次拍照就是这身，**不用复述衣服的样子**）');
        }

        // ② 指定换装（没有就先买）
        const want = String(args?.outfit || '').trim();
        if (!want) return err('要换哪一套？说个名字（比如"巫女服"），或者说一句"随机换一身"。');
        // ★★ 2026-10-17「换成**旅伴的**默认衣服」（借穿）。
        //   ⚠️ **必须在"自己的默认"之前判**：`小狐狸的默认` 里也含"默认"两个字，
        //      如果先走下面那个 `/默认/` 分支，会被当成"脱掉自己的"。
        //   两种写法都收：自然语言「小狐狸的默认那身」/ 程序化 `default:fox`
        const borrowM = want.match(/^(.+?)的默认/) || want.match(/^default:(\w+)$/i);
        if (borrowM) {
          const wantWho = String(borrowM[1] || '').trim();
          const src = OW.WARDROBE_GIRLS.find((x) => x.name === wantWho || x.id === wantWho)
            || OW.WARDROBE_GIRLS.find((x) => x.name.includes(wantWho) || wantWho.includes(x.name));
          if (!src) {
            return err(`没有叫「${wantWho}」的少女。可选：${OW.WARDROBE_GIRLS.map((x) => x.name).join('、')}`);
          }
          const girlRaw = String(args?.girl || '').trim();
          let gid = 'whale';                       // 没说给谁 ⇒ 穿给她自己
          if (girlRaw) {
            const g = OW.WARDROBE_GIRLS.find((x) => x.name === girlRaw || x.id === girlRaw)
              || OW.WARDROBE_GIRLS.find((x) => x.name.includes(girlRaw) || girlRaw.includes(x.name));
            if (!g) return err(`没有叫「${girlRaw}」的少女。可选：${OW.WARDROBE_GIRLS.map((x) => x.name).join('、')}`);
            gid = g.id;
          }
          // ★ 2026-10-17（用户口径）：**借穿要先邀请过那位** —— 没请过的人，
          //   她身上那套你不能拿（否则"邀请旅伴"这个门槛等于没有）。
          if (!ownedCompanionIds(st).includes(src.id)) {
            return err(`还没邀请过「${src.name}」—— 先在商店请一位（"请一位伙伴"，见面礼 ${S.COMPANIONS[src.id]?.price ?? '?'} 亿 TOKEN）；`
              + '她答应了，她那身才有得借。');
          }
          const who = OW.girlName(gid);
          if (src.id === gid) {
            // 借自己 ⇒ 等同于换回默认
            delete st.wardrobe.worn[gid];
            S.saveState(st);
            return ok(`👕 ${who}换回自己的默认那身了。`);
          }
          st.wardrobe.worn[gid] = 'default:' + src.id;
          S.saveState(st);
          return ok(`👕 ${who}现在穿「${src.name}的默认那身」`
            + '\n（默认那身不在衣柜里、也不要钱，随时能换回来）');
        }
        // ★★ 2026-10-17 新增：**换回默认那身**（脱掉）
        //   为什么需要它：默认着装是 `CHAR_DEFAULT_WEAR` 常量、**不在 OUTFITS 表里**，
        //   所以换上任何一套之后，玩家就**没有回到原装的路**（只能再换另一套，或手改存档）。
        //   这里把"脱掉"做成一等公民：清掉 `worn[girl]` ⇒ `composeCharacter` 自然回落到默认着装。
        if (/默认|原装|脱掉|脱下来|换回来|换回原来|^default$|^none$|^off$/i.test(want)) {
          const girlRaw = String(args?.girl || '').trim();
          let targets;
          if (girlRaw) {
            const g = OW.WARDROBE_GIRLS.find((x) => x.name === girlRaw || x.id === girlRaw)
              || OW.WARDROBE_GIRLS.find((x) => x.name.includes(girlRaw) || girlRaw.includes(x.name));
            if (!g) return err(`没有叫「${girlRaw}」的少女。可选：${OW.WARDROBE_GIRLS.map((x) => x.name).join('、')}`);
            targets = [g];
          } else {
            targets = OW.WARDROBE_GIRLS;          // 没说谁 ⇒ 全部换回默认
          }
          const lines = [];
          for (const g of targets) {
            const had = st.wardrobe.worn[g.id];
            delete st.wardrobe.worn[g.id];
            const hadName = had ? (OW.outfitOf(had)?.name || String(had)) : '';
            lines.push(`  ${g.emoji} ${g.name}：${hadName ? `脱下「${hadName}」，` : ''}换回默认那身`);
          }
          S.saveState(st);
          return ok('👕 换回默认：\n' + lines.join('\n') + '\n（下一次拍照就是原装那身）');
        }
        const o = OW.OUTFITS.find((x) => x.name === want || x.id === want)
          || OW.OUTFITS.find((x) => x.name.includes(want) || want.includes(x.name));
        if (!o) return err(`衣柜里没有「${want}」—— 说一句"看衣柜"能看全部 ${OW.OUTFITS.length} 套。`);

        // 谁穿：给了 girl 就以她为准（并校验这套是否绑给她）
        const girl = String(args?.girl || '').trim();
        let gid = o.who;
        if (girl) {
          const g = OW.WARDROBE_GIRLS.find((x) => x.name === girl || x.id === girl)
            || OW.WARDROBE_GIRLS.find((x) => x.name.includes(girl) || girl.includes(x.name));
          if (!g) return err(`没有叫「${girl}」的少女。可选：${OW.WARDROBE_GIRLS.map((x) => x.name).join('、')}`);
          gid = g.id;
        }
        if (gid !== o.who) {
          return err(`「${o.name}」是**给${OW.girlName(o.who)}的**（每套只绑一位）—— `
            + `${OW.girlName(gid)}自己的那几套，说"看衣柜"能看到。`);
        }

        // 还没买 ⇒ 先查"去过没"，再扣钱
        if (st.wardrobe.owned[o.id] !== true) {
          const seen = (st.areasSeen && typeof st.areasSeen === 'object') ? st.areasSeen : {};
          const areaLabel = `${OW.OUTFIT_REGION_NAMES[o.region] || o.region}·${o.area}`;
          if (!seen[`${o.region}|${o.area}`]) {
            return err(`还没去过「${areaLabel}」—— 去那儿走一趟（她自己或旅伴去都算）才能解锁「${o.name}」。`);
          }
          const price = Number(o.price) || OW.OUTFIT_PRICE;
          if (!S.spendPlankton(st, price)) {
            return err(`TOKEN 不够：「${o.name}」要 ${price} 亿 TOKEN，`
              + `你现在 ${Number(st.wallet?.plankton) || 0} 亿。`);
          }
          st.wardrobe.owned[o.id] = true;
          st.wardrobe.worn[gid] = o.id;
          S.saveState(st);
          return ok(`👗 买下「${o.name}」并给${OW.girlName(gid)}换上了`
            + `（花 ${price} 亿 TOKEN，余额 ${Number(st.wallet?.plankton) || 0} 亿 TOKEN）。`
            + '下一次拍照就是这身 —— **不用复述衣服的样子**。');
        }

        st.wardrobe.worn[gid] = o.id;
        S.saveState(st);
        return ok(`👗 ${OW.girlName(gid)}换上「${o.name}」了 —— 下一次拍照就是这身，`
          + '**不用复述衣服的样子**。');
      } catch (error) { return err(`换装失败：${error?.message ?? error}`); }
    }
  });

  // ⑦ 称号
  api.registerTool({
    id: 'travel-whale__whale_titles', name: '看称号', category: 'query', icon: '🏅',
    description: '看小鲸鱼拿到了哪些称号、还差什么。群友问"它有什么称号""成就"时用。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const st = S.loadState(ctx.chatKey);
        const sum = TI.summarizeTitles(st, titleCtx());
        const got = TI.TITLES.filter((t) => st.titles?.[t.id]);
        const lines = [`🏅 已解锁 ${sum.unlocked}/${sum.total}（成就值 ${sum.points}/${sum.totalPoints}）`];
        for (const t of got) lines.push(`  ${t.icon} ${t.name}（${t.points || 0} 点）—— ${t.desc}`);
        if (sum.pending.length) lines.push('', '差一点就能拿到：' + sum.pending.map((t) => `${t.icon}${t.name}`).join('、'));
        return await replyPanel(ctx, lines.join('\n'));
      } catch (error) { return err(`看称号失败：${error?.message ?? error}`); }
    }
  });

  // ⑧ 查看/切换异世界装备（基础世界已默认全部解锁，无需装备）
  api.registerTool({
    id: 'travel-whale__whale_equip', name: '异世界装备', category: 'utility', icon: '🎒',
    description: '查看或携带已解锁的异世界装备（如"风之翼""罗德岛徽章"）。基础世界各地区默认全部解锁，无需装备即可直接前往。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '异世界装备名（如"风之翼""罗德岛徽章"），留空则列出已解锁的异世界装备' } }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        const baseNames = T.loadRegions().filter((r) => r.defaultUnlocked || r.baseWorld).map((r) => r.name);
        const owned = T.loadRegions().filter((r) => Boolean(r.equipment) && isRegionUnlocked(st, r));
        const want = String(args?.name ?? '').trim();
        if (!want) {
          const equipStr = owned.length
            ? owned.map((r) => `${r.equipment}（→${r.name}）`).join('、')
            : '（暂未解锁任何异世界装备）';
          return ok(`🌍 基础世界默认全解锁（无需装备）：${baseNames.join('、')}
🎒 已解锁的异世界装备：${equipStr}`);
        }
        const baseHit = T.loadRegions().find((r) => (r.defaultUnlocked || r.baseWorld) && (r.name === want || r.id === want));
        if (baseHit) {
          st.whale.equipped = '';
          S.saveState(st);
          return ok(`${baseHit.name}属于默认全部解锁的基础世界，不需要装备，出门时直接指定去那儿（或让她自己挑）就行！`);
        }
        const hit = owned.find((r) => r.equipment === want || r.name === want || r.id === want);
        if (!hit) {
          return err(`还没解锁「${want}」。` + (owned.length ? '已解锁的异世界装备有：' + owned.map((r) => r.equipment).join('、') : '目前还没有已解锁的异世界装备。'));
        }
        st.whale.equipped = hit.equipment;
        S.saveState(st);
        return ok(`换好了：带着「${hit.equipment}」（已解锁 ${hit.name}）。`);
      } catch (error) { return err(`操作装备失败：${error?.message ?? error}`); }
    }
  });

  // ⑨ 玩法说明图（专属指令，跟 /help 区分开）
  api.registerTool({
    id: 'travel-whale__whale_help', name: '矩阵庭院玩法说明', category: 'system', icon: '📖',
    // ★★ 2026-10-14 v3.2 重写触发词（用户："调用 help.js 特别困难"，详见 §98）。
    //   病根：原来把触发词写成**带"鲸鱼"前缀的五个短语**，而同时
    //   `help_board`（指令一览）自称"输入 /help、**帮助**、菜单或问你能做什么时调用"、
    //   `text_image`（长文排版图）自称"一段说明 / 步骤 / 清单时调用" ——
    //   三个工具的"帮助"语义**互相压**，那两位的措辞更通用 ⇒ 群友只要不说"鲸鱼"二字，
    //   这个工具基本选不上（实测今天一整天只被调到 1 次）。
    //   ⇒ 现在**先讲清三方分工，再把话铺开**（明确说"不一定带鲸鱼两个字"）。
    description: '发一张**小鲸鱼（矩阵庭院）**的玩法说明图到群里。'
      + '★ **只要话题是这只鲸鱼 / 这个玩法**，群友说「帮助」「怎么玩」「玩法」「说明」「规则」「怎么养」'
      + '「能干嘛」（**不一定带"鲸鱼"两个字**）就都用这个 —— 上面那些只是示例，别死抠字面。'
      + '⚠️ 三个"帮助类"工具的分工（**别选错**）：群友要**所有插件的全局指令一览** ⇒ 用「指令一览」；'
      + '要把**一段长文字**排成图 ⇒ 用「长文排版图」；**这个只讲小鲸鱼这一套玩法**'
      + '（口粮 / 装备 / 明信片 / 特产图鉴 / 庭院 / 技能 / 旅伴 / 称号）。'
      + '★ 想单独看「庭院设施」或「技能树」的完整清单时，用 menu 参数（会另发一张对应的小菜单图）—— '
      + '群友说「看设施菜单」「庭院设施都有什么」「看技能菜单」「技能树有什么」时用它。'
      + '（★ 服装衣柜 / 商店 / 特产图鉴 / 明信片相册**各有专门的工具**：「看衣柜」「看商店」「看图鉴」「看相册」—— 别用这里的 menu。）',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'boolean', description: 'true 时只发文字版（不发图），默认 false' },
        menu: {
          type: 'string',
          description: '要单独发的菜单：`garden` = 庭院设施清单，`skill` = 技能树清单。留空 = 发整张玩法说明图。'
        }
      }
    },
    async execute(ctx, args) {
      const c = cfg();
      const restockHours = Number(c.restockHours || 168);
      const whaleName = String(c.whaleName || '小鲸鱼');
      const width = Number(c.helpImageWidth || 720);
      const wantMenu = String(args?.menu ?? '').trim().toLowerCase();
      const isMenu = Boolean(wantMenu) && H.MENU_KINDS.includes(wantMenu);
      // ① 明确要文字 → 直接文字
      // ★★ 2026-10-18 修 bug（用户：「想查技能目录，结果退化成文本了」）：
      //   这一条原来**在菜单判断之前** —— 模型只要顺手带了 text:true，
      //   哪怕同时传了 menu:'skill'，也会直接吐一串纯文本、跳过出图。
      //   现在 **menu 优先**：明确点了某张菜单就一定出图；
      //   只有「没点菜单 + 要文字」才走文字版。
      if (args?.text === true && !isMenu) return ok(H.buildHelpText({ restockHours }));
      // ② 出图（主图，或某一张菜单图）
      try {
        // ★ 2026-10-13：把"图上要显示的动态数据"一起传进去 ——
        //   伙伴 ✅（已邀请）、装备 ✅（实际解锁）、技能表与已学、已建设施、
        //   她去过哪些世界、此刻能学什么、消耗动作的价格。
        //   `stateExists` 不成立时 loadState 给的是空档 ⇒ 图照样出，只是没有 ✅。
        const snapshot = S.loadState(ctx.chatKey);
        // ★ 2026-10-14：菜单图的数据**按 kind 拼** —— 商店那张要额外带上货架/库存/余额
        //   （见 `menuDataFor`）。主图仍然只走 `helpDataFor`（纯读，不带副作用）。
        const data = isMenu ? menuDataFor(snapshot, wantMenu) : helpDataFor(snapshot);
        const file = isMenu
          ? await H.renderMenuFile(menuRenderArgs(wantMenu, data))
          : await H.renderHelpFile({ width, whaleName, restockHours, log, ...data });
        // 图片发送要重试：QQ 侧上传通道偶发抖动（实测约 1/17），文件本身没问题
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (!ctx.sender?.sendImage) throw new Error('发送队列不可用');
            await ctx.sender.sendImage(ctx.chatKey, { file });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            log(`[travel-whale] 说明图发送失败（第 ${attempt}/3 次）：${error?.message ?? error}`);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt));
          }
        }
        if (lastError) throw lastError;
        return ok(isMenu
          ? `${H.MENUS[wantMenu].title}的菜单图已发出。不要再复述一遍图上写的东西。`
          : '玩法说明图已发出。不要再复述一遍图上写的东西。');
      } catch (error) {
        // ③ 出图失败（例如不是 Electron 主进程）→ 降级文字
        log(`[travel-whale] 说明图生成失败，降级为文字：${error?.message ?? error}`);
        return ok(H.buildHelpText({ restockHours }));
      }
    }
  });

  // ⑨ 快速测试（仅主人可用）
  api.registerTool({
    id: 'travel-whale__whale_quick_test', name: '矩阵庭院快速测试', category: 'system', icon: '🧪',
    description: '【仅主人】当指定 QQ 号发送「矩阵庭院快速测试」时调用：立刻安排一趟 10 分钟的测试旅行 —— 第 5 分钟寄一张明信片，第 10 分钟回家并反馈明信片和特产。不消耗口粮，也不花钱。只在设置里放行的 QQ 号可用。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const allowed = String(cfg().testQq || '')
          .split(',').map((x) => x.trim()).filter(Boolean);
        const from = senderOf(ctx);
        if (!from) return err('拿不到发送者身份，测试无法执行。');
        if (!allowed.includes(from)) return err('「矩阵庭院快速测试」只有主人能用。');

        // ★ 走**独立存档**：测试要完整跑一遍寄片/带特产/解锁称号，
        //   若写进真身，跑几次真身的相册和图鉴就被测试数据污染了。
        const testKey = ctx.chatKey + QUICK_TEST_KEY_SUFFIX;
        const st = S.loadState(testKey);
        st.test = true;                       // 标记测试态：tick 不会让它自动出发
        st.realChatKey = ctx.chatKey;         // ★ 消息要发回真实会话，不是这个测试键
        if (st.trip) {
          return err('上一轮测试还在跑（' + placeLabel(st.trip) + '），等它结束再测。');
        }

        const d = buildDeps(testKey, st);

        // 固定目的地：不搜不抽，秒开、不花配额、搜索挂了也能测
        const place = QUICK_TEST_PLACES[Math.floor(Math.random() * QUICK_TEST_PLACES.length)];
        const now = Date.now();
        // 途中 1 张，落在第 5 分钟；到家那张由 settleTrip 额外发
        const quickCardTimes = [now + QUICK_TEST_MS / 2];
        const quickSouvenirs = (place.souvenirs || []).map((x) => ({ ...x, isRare: false }));
        const plan = {
          ...place,
          foodTier: 'normal',
          departAt: now,
          returnAt: now + QUICK_TEST_MS,
          cardTimes: quickCardTimes,
          cardCount: 1,
          souvenirs: quickSouvenirs,
          // ⚠️ 快速测试也要走同一套计划构造 —— 否则 cardPlan / charStyle 是空的，
          //    明信片会退化成「没有景点、没有人物画法」的裸提示词（真踩过）。
          cardPlan: T.planCardContent({
            spots: place.spots, souvenirs: quickSouvenirs,
            cardTimes: quickCardTimes, returnAt: now + QUICK_TEST_MS, rand: Math.random
          }),
          charStyle: P.pickCharacterStyle(),
          searchLog: [],
          source: 'quick-test',
          quickTest: true
        };

        st.trip = { ...plan, cardsSent: 0 };
        S.saveState(st);
        startTicker();
        notifyUI(testKey);

        await say(ctx.chatKey, '🧪 快速测试开始 —— 10 分钟的迷你旅行，第 5 分钟会寄一张明信片回来。');
        return ok('测试旅行已开始：' + placeLabel(plan)
          + '。5 分钟后寄明信片，10 分钟后回家带特产。不用再复述。');
      } catch (error) {
        return err('快速测试失败：' + (error?.message ?? error));
      }
    }
  });

  // ⑨ 收养（主人口令）
  api.registerTool({
    id: 'travel-whale__whale_adopt', name: '养一只鲸鱼', category: 'system', icon: '🐋',
    description: '在本群/本私聊养一只小鲸鱼。群主或主人说"在这养一只鲸鱼""养一只"时用。养过就不用再养。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        // ⚠️ 判据是「见面礼发过没有」，不是「存档在不在」，也不是白名单：
        //    · 用白名单 → 一配就永远回「早就养着一只啦」，存档根本不建；
        //    · 用「存档在不在」→ 用过「矩阵庭院快速测试」的会话已建了存档，
        //      再正式收养就领不到见面礼（真踩过，反馈「没给初始 TOKEN」）。
        //    所以用 giftAt 记账：发过就不再发，没发过就补。
        const st = S.loadState(ctx.chatKey);
        if (st.giftAt) return ok('这儿已经养着一只啦。');
        st.giftAt = Date.now();
        st.wallet = st.wallet || { plankton: 0, glow: 0 };
        // ★ 2026-10-13 晚：走 `grantPlankton` 而不是直接改 wallet —— 它顺带记"累计赚取"。
        S.grantPlankton(st, GIFT_PLANKTON);
        st.bag = st.bag || { food: {}, equip: {}, charm: {} };
        st.bag.food = st.bag.food || {};
        st.bag.food.normal = (Number(st.bag.food.normal) || 0) + GIFT_FOOD;
        S.saveState(st);
        startTicker();
        return ok('🐋 好嘞，从今天起这只小鲸鱼就养在咱们这儿了。'
          + '\n先给你留了点见面礼：' + GIFT_PLANKTON + ' 亿 TOKEN + '
          + GIFT_FOOD + ' 份' + (S.FOOD_TIERS.normal?.name || '中份大白饭') + '，够它出门一趟。'
          + '\n平时它会自己出门、寄明信片回来；想让它现在就走，说「让它去旅行」就行。');
      } catch (error) { return err(`收养失败：${error?.message ?? error}`); }
    }
  });
}

