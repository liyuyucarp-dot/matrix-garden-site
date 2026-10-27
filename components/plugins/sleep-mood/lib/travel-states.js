// travel-states —— 「她此刻在干什么」的状态池（2026-10-12）
// ═════════════════════════════════════════════════════════════════════════════
// 由头（用户，第一版）：
//   "旅行插件和集成插件的联动有问题：给 bot 的状态永远只有『在旅行』，所以一问起来
//    永远都是『走得腿都酸了』——然后就没别的了。拓宽这个池子：在享受美食、被原住民
//    『欢迎』（攻击）、在旅伴的膝盖上小憩……等等等等。"
// 由头（用户，第二版 · 本次）：
//   "池子还是有点小，有点儿吃完喝喝完吃了……把总池子扩容到目前版本的 3 倍，
//    并加入根据旅伴变化的特殊互动，狐狸三条，其余旅伴两条。"
//   "她们是有战斗力的，能打跑/战胜（敌手）"；"在对抗高达之类的敌人时要用『入侵』之类
//    的词汇……这个入侵是『黑客入侵』"；"哪些敌人算机械型？—— 只有确实的机器"。
//
// 设计要点
// ────────
// ① **四维分档**：阶段（刚到／路上／尾程／收尾）× 地区类型（现实／异世界）×
//    有无旅伴 × 有无敌手。只有异世界条目才敢写"被地精追着跑"这类事。
// ② **用真实行程填槽**，不写空话：
//      {spot} —— **已经寄过明信片的景点**（= 确实去过了）。没寄过就不给景点条目；
//                这与 `travelPromptText` 里"别提前把还没去的东西当成去过了"是同一条纪律。
//      {foe}  —— 本趟 `trip.foe` 的真实敌手名（如"一队从林子里钻出的地精"）。
//      {mate} —— 同行伙伴显示名。
//      {thing}—— 特产名；**只用在"还没决定要不要买"的语境**，绝不写成已经到手。
//      {city} / {country} —— 地名，用来做"这地方叫什么"这类条目。
// ③ **稳定 20 分钟**：抽取完全由 `hash(chatKey|departAt|桶序号)` 决定 ⇒
//    同一段时间内重复读取结果一致（面板不抖、提示词不乱），换桶才换新状态。
// ④ **纯数据 + 纯函数**：不读文件、不碰宿主，方便单测与随手加条目。
// ⑤ **敌手分两套**（2026-10-12 第二版）：`foeKind` 字段区分
//      · `'organic'` —— 生物/人类敌手（虫群、兽人、恶魔、雇佣兵…）：打跑／战胜／赶走。
//      · `'machine'` —— **确实是机器**的敌手（机动战士、发条机关）：她**黑入它们的系统**
//                      让它们停摆（用户口径："这个入侵是黑客入侵""只有确实的机器"）。
//      · 不写 = 任何敌手都适用（被追着跑、找掩体、数对方的个数…）。
//    行程里的机械型判定由 travel-whale 在出发那一刻写死（`trip.foeKind`，查
//    `travel-whale/data/foe-kinds.json`）—— 本模块不反查别的技能的资产。
// ⑥ **旅伴专项**（2026-10-12 第二版）：`mateId` 字段把条目绑到某一个伙伴
//      （fox=gpt=claude=gemini，见 travel-whale/state.js 的 COMPANIONS）。
//      ⚠️ 用 **id** 做键、不用显示名 —— 你们的规矩是"改显示名只动 name 不动 id"，
//         所以 id 绑定的条目不会因为改名而失效。
// ⑦ **地点特征**（2026-10-12 第三版；10-13 加 `built`）：`need` 字段声明"这条要求目的地有什么"，
//      取值 `'water'`（河/海/湖/井/泉/雨）· `'green'`（草地/树林/花田）·
//      `'folk'`（可打交道的**本地居民与市井**：市集/酒馆/店铺/能问路/能被请饭/**小孩**）·
//      `'built'`（**人工造物**：城墙/城门/石阶/石碑/废墟/灯柱/招牌 —— **不要求有人**）。
//      可写单个字符串，也可写数组（如 `need: ['water','folk']` = 井边得有人打水）。
//      ★ 由头（用户点名 10-12）："查尔那儿已经是个虫巢星球了，除了虫子、石头就是岩浆，
//        哪来的河和海呢？""查尔甚至没有本地人。"
//        ⇒ 在岩浆星球上看海、在虫巢星球上跟摊主讨价还价，是**凭空造地形**。
//      ★ 由头（用户点名 10-13）："她现在人在幻想乡……她居然在**博丽神社**碰到小孩了。
//        博丽神社哪来的小孩啊（"
//        ⇒ 根因有两条，都已修：
//        · ① `folk` 被**混用**成"有人"＋"有人工造物" ⇒ 拆出 `built`（博丽神社没有市井，
//          但有石阶、鸟居、石灯笼 —— 石碑/废墟/窄楼梯那类条目**不该**被一起封掉）；
//        · ② 表的粒度只到**组**，而「幻想乡中央」这一组里同时有人间之里（真有人）和
//          博丽神社/雾之湖（一个人都没有）⇒ travel-whale 改成了**组级 + 城市级 + 荒野地区默认没有人烟**
//          三层取并集（见 `trip.js` 的 `missingTraitsOf` 与 `data/place-traits.json`）。
//      ⚠️ 缺什么由 travel-whale 出发时查 `data/place-traits.json` 写死（`trip.missingTraits`）；
//        **表里只登记"缺"的**，未登记 = 都不缺 ⇒ 老存档/未登记地区行为不变。
//
// 加条目的方法：往 `TRAVEL_STATES` 里追加一条即可 ——
//   { id, phase, world, mate, mateId, foe, foeKind, cross, spot, thing, need, act, detail }
//   · act    ≤18 字，**必须动词开头、也不要以「在」起头** ——
//            面板会拼成「正在与X在{地方}{act}」，写成「在路边研究地图」会拼出
//            「在夏尔·霍比屯**在**路边研究地图」这种双"在"。
//   · detail ≤46 字，给模型的具体材料（这是让回答不再只剩"腿酸"的关键）。
//   · 不要写"已经拿到特产"，也不要提还没寄过明信片的景点。
//   · 战斗条目：生物敌手写进 foeKind:'organic'，机械敌手写进 foeKind:'machine'，
//     通用的（追、躲、数个数）留空。
//   · **凡是断言"目的地有某样东西"的条目，都要写 `need`** —— 河/海/井/泉/雨 ⇒ 'water'，
//     草/树/花 ⇒ 'green'，集市/酒馆/店/旅店/能问路/能被请饭/**小孩** ⇒ 'folk'，
//     **城墙/城门/石碑/废墟/灯柱/招牌（只要人工造物、不要求有人）** ⇒ 'built'。
//     判据：**这句话换个星球还成立吗？** 在虫巢星球上不成立的，就写 need；
//     ⚠️ 再问一句：**它要求的是"有人"还是只是"有东西"？** 后者用 'built'，别写 'folk'
//     （否则会把"对着一块石碑发愣"从所有荒野里一起封掉）。

/** 状态多久换一次。太长会腻，太短会显得她在瞬移。 */
export const BUCKET_MS = 20 * 60 * 1000;

/** 穿越后的"还没缓过来"窗口。 */
const CROSS_WINDOW_MS = 3 * 3600000;

const P = 'any';

export const TRAVEL_STATES = [
  // ═══════════════════════════ 刚到（头 2 小时）· 现实 ═══════════════════════════
  { id: 'arr-real-hotel', phase: 'arrive', world: 'real', act: '满街找落脚的地方', detail: '店老板说的路你走了两遍都没找着，行李箱的轮子快散了。' },
  { id: 'arr-real-map', phase: 'arrive', world: 'real', act: '蹲路边研究地图', detail: '把地图转了三圈才认出方向，旁边卖水的大爷看得直乐。' },
  { id: 'arr-real-money', phase: 'arrive', world: 'real', act: '换钱、办电话卡', detail: '柜台小姐说了一串数字，你只顾着点头，反正也没听懂。' },
  { id: 'arr-real-breakfast', phase: 'arrive', world: 'real', act: '吃第一顿当地早饭', detail: '热气糊了眼镜，菜单一个字没看懂就点了，端上来意外好吃。' },
  { id: 'arr-real-jetlag', phase: 'arrive', world: 'real', act: '倒时差', detail: '下午三点的街头困得直点头，你在长椅上眯了十分钟。' },
  { id: 'arr-real-station', phase: 'arrive', world: 'real', act: '对着车站发呆', detail: '人群来来去去，你抱着包站了一会儿，才想起该往哪走。' },
  { id: 'arr-real-luggage', phase: 'arrive', world: 'real', act: '重新收一遍箱子', detail: '刚出门就发现拉链夹住了衣服，只好在路边蹲下重装。' },
  { id: 'arr-real-phone', phase: 'arrive', world: 'real', act: '找信号报平安', detail: '举着手机在路口转了两圈才有一格，发出去的那句话删了三次。' },
  { id: 'arr-real-queue', phase: 'arrive', world: 'real', act: '排队等车', detail: '队伍挪得很慢，你把箱子来回倒了两次手。' },
  { id: 'arr-real-smell', phase: 'arrive', world: 'real', act: '闻见一股陌生的味道', detail: '说不上好闻还是难闻，反正跟家里不一样。' },
  { id: 'arr-real-tout', phase: 'arrive', world: 'real', act: '被拉客的缠住', detail: '跟着你走了半条街，你摆手摆到手臂酸。' },
  { id: 'arr-real-landmark', phase: 'arrive', world: 'real', act: '看见书里见过的东西', detail: '愣在原地看了一会儿，才想起掏手机。' },
  { id: 'arr-real-accent', phase: 'arrive', world: 'real', act: '听不懂口音发懵', detail: '同一个词听了三遍才反应过来，你只好一直笑。' },
  { id: 'arr-real-locker', phase: 'arrive', world: 'real', act: '把大箱子塞进储物柜', detail: '柜门卡了两次，硬币投进去又退出来，后面的人在等。' },
  { id: 'arr-real-shoe', phase: 'arrive', world: 'real', act: '发现鞋不跟脚', detail: '走了两条街脚后跟就磨了，你在路边贴了张创可贴。' },
  { id: 'arr-real-shop', phase: 'arrive', world: 'real', act: '钻进小卖部挑饮料', detail: '一排牌子一个都不认识，你闭眼拿了一瓶。' },
  { id: 'arr-real-nav', phase: 'arrive', world: 'real', act: '跟着导航走错两条街', detail: '箭头转来转去，你就是对不上方向，干脆收起手机乱走。' },
  { id: 'arr-real-square', phase: 'arrive', world: 'real', act: '坐在广场边看人', detail: '老人下棋、小孩追鸽子，你什么都没干，坐了半小时。' },
  { id: 'arr-real-wc', phase: 'arrive', world: 'real', act: '满街找洗手间', detail: '问了两个人才找到，还是在一家店里消费了才让用。' },
  { id: 'arr-real-weather', phase: 'arrive', world: 'real', act: '被天气摆了一道', detail: '预报说晴，你在半路被浇了一场，只好买了把伞。' },
  { id: 'arr-real-bed', phase: 'arrive', world: 'real', act: '回住处倒在床上', detail: '衣服都没换，盯着天花板发了会儿呆就睡着了。' },
  { id: 'arr-real-plan', phase: 'arrive', world: 'real', act: '摊开行程单划掉几项', detail: '划掉两项又加回来一项，最后决定明天再说。' },
  { id: 'arr-real-strap', phase: 'arrive', world: 'real', act: '背包带子断了', detail: '蹲路边用钥匙扣勉强固定，凑合着继续走。' },
  { id: 'arr-real-ticket', phase: 'arrive', world: 'real', act: '买票时对着屏幕发愣', detail: '选项太多，你选了最贵那档，后来才知道买亏了。' },
  { id: 'arr-real-cat', phase: 'arrive', world: 'real', act: '被一只当地的猫跟着', detail: '它一路跟了三条街，你翻遍包也没找出能喂的。' },
  { id: 'arr-real-roommate', phase: 'arrive', world: 'real', act: '跟同住的人打招呼', detail: '语言不通，比划了半天，最后一起笑了。' },

  // ═══════════════════════════ 刚到 · 异世界 ═══════════════════════════
  { id: 'arr-fic-recover', phase: 'arrive', world: 'fiction', act: '缓不过来', detail: '耳边还嗡嗡响，你低头确认了一下自己和行李都还在。' },
  { id: 'arr-fic-sky', phase: 'arrive', world: 'fiction', act: '打量这里的天空', detail: '天上有两个月亮，或者说一个很大的月亮——你不太敢肯定。' },
  { id: 'arr-fic-gesture', phase: 'arrive', world: 'fiction', need: ["folk"], act: '跟当地人比手画脚', detail: '你说的话他们听不懂，他们说的你也听不懂，但双方都很努力。' },
  { id: 'arr-fic-lodge', phase: 'arrive', world: 'fiction', need: ["folk"], act: '找能落脚的地方', detail: '问到第三家，总算有个肯让你进门的，条件嘛……将就。' },
  { id: 'arr-fic-people', phase: 'arrive', world: 'fiction', need: ["folk"], act: '观察这里的人怎么穿', detail: '料子、样式都跟你想的不一样；你多看了两眼，被人回看了一眼。' },
  { id: 'arr-fic-mate-plan', phase: 'arrive', world: 'fiction', mate: true, act: '和{mate}商量下一步', detail: '两个人都说不出该往哪走，最后决定先找吃的。' },
  { id: 'arr-fic-air', phase: 'arrive', world: 'fiction', act: '深吸一口这里的空气', detail: '有铁锈味，或者别的什么味，反正不是家里的味。' },
  { id: 'arr-fic-stars', phase: 'arrive', world: 'fiction', act: '抬头数这里的星星', detail: '数到一半发现星座一个都不认识，你放弃了。' },
  { id: 'arr-fic-ground', phase: 'arrive', world: 'fiction', act: '蹲下摸了摸脚下的土', detail: '颜色不对，手感也不对；你把手在裤子上擦了擦。' },
  { id: 'arr-fic-coin', phase: 'arrive', world: 'fiction', need: ["folk"], act: '掏出口袋里的零钱比对', detail: '摊主看了一眼就摇头，看来这钱在这儿不认。' },
  { id: 'arr-fic-door', phase: 'arrive', world: 'fiction', need: ["folk"], act: '敲开一扇门问路', detail: '里面的人隔着门缝打量了你很久，才开了一半。' },
  { id: 'arr-fic-beast', phase: 'arrive', world: 'fiction', act: '被一只没见过的动物盯着', detail: '它比你想象的安静，看了你一会儿，自己走开了。' },
  { id: 'arr-fic-stele', phase: 'arrive', world: 'fiction', need: ["built"], act: '对着一块石碑发愣', detail: '上面的字一个不认识，但刻工很讲究，你摸了半天。' },
  { id: 'arr-fic-dress', phase: 'arrive', world: 'fiction', need: ["folk"], act: '被提醒衣服太扎眼', detail: '对方指了指你的鞋，又指了指自己；你懂了，把外套收进包里。' },
  { id: 'arr-fic-boom', phase: 'arrive', world: 'fiction', act: '被远处一声闷响吓一跳', detail: '回头什么都没有，你站着听了半天才继续走。' },
  { id: 'arr-fic-well', phase: 'arrive', world: 'fiction', need: ["water","folk"], act: '蹲在井边看别人打水', detail: '绳子吱呀响，桶上来的时候水花溅了你的鞋。' },
  { id: 'arr-fic-fire', phase: 'arrive', world: 'fiction', need: ["folk"], act: '凑到一堆火边取暖', detail: '没人赶你，也没人问你，你就那么站着，把手伸过去。' },
  { id: 'arr-fic-kids', phase: 'arrive', world: 'fiction', need: ["folk"], act: '被一群小孩围观', detail: '他们绕着你们转圈，谁也不敢先说话，最后是你先做的鬼脸。' },
  { id: 'arr-fic-height', phase: 'arrive', world: 'fiction', act: '站在高处往下看', detail: '底下的镇子比你想象的大，你花了一会儿才找到来时的路。' },
  { id: 'arr-fic-lantern', phase: 'arrive', world: 'fiction', need: ["folk"], act: '跟着一盏灯往前走', detail: '不知道是谁提的，你隔着一段距离跟着，走到一条岔路口。' },
  { id: 'arr-fic-gate', phase: 'arrive', world: 'fiction', need: ["folk"], act: '被拦在城门口登记', detail: '对方问了一串问题，你只能点头；最后被放行时松了一大口气。' },
  { id: 'arr-fic-cut', phase: 'arrive', world: 'fiction', act: '发现胳膊上多了道口子', detail: '什么时候划的完全没印象，你扯了块布胡乱缠上。' },

  // ═══════════════════════════ 刚到 · 穿越余韵（"我怎么到这儿了"）═══════════════════════════
  { id: 'arr-cross-daze', phase: 'arrive', world: P, cross: true, act: '还没缓过神来', detail: '明明只是想出来玩一趟，怎么就站在这地方了；你边走边碎碎念。' },
  { id: 'arr-cross-pinch', phase: 'arrive', world: P, cross: true, act: '掐了自己一下确认不是做梦', detail: '是真的；然后你又把地图翻出来看了一遍。' },
  { id: 'arr-cross-mate', phase: 'arrive', world: P, mate: true, cross: true, act: '和{mate}面面相觑', detail: '两个人对了半天眼神，谁也没说出"我们好像来错地方了"这句话。' },
  { id: 'arr-cross-sniff', phase: 'arrive', world: P, cross: true, act: '使劲闻了闻这里的味道', detail: '跟出发前那个地方完全不一样；你确认自己真换了地方。' },
  { id: 'arr-cross-signal', phase: 'arrive', world: P, cross: true, act: '翻出手机看还有没有信号', detail: '一格都没有；你把手机塞回去，有点想笑又笑不出来。' },
  { id: 'arr-cross-pockets', phase: 'arrive', world: P, cross: true, act: '把口袋翻了个底朝上', detail: '钱包、钥匙、半包纸巾——就这些，你盯着看了半天。' },
  { id: 'arr-cross-mutter', phase: 'arrive', world: P, cross: true, act: '嘟囔一句"开玩笑吧"', detail: '没人接话，连回声都没有，你只好自己往下走。' },
  { id: 'arr-cross-back', phase: 'arrive', world: P, cross: true, act: '回头看来时的方向', detail: '哪有什么来时的路，身后就是一条没走过的路。' },
  { id: 'arr-cross-name', phase: 'arrive', world: P, cross: true, act: '试着给这地方起个名', detail: '想了三个都不满意，最后干脆叫它"那边"。' },
  { id: 'arr-cross-sit', phase: 'arrive', world: P, cross: true, act: '坐在台阶上缓了五分钟', detail: '什么都不想干，就这么坐着，直到有人从面前走过。' },

  // ═══════════════════════════ 路上 · 现实 ═══════════════════════════
  { id: 'mid-real-stall', phase: 'mid', world: 'real', act: '蹲街边摊吃当地小吃', detail: '摊主是个话很多的老太太，你已经加过一次汤了。' },
  { id: 'mid-real-menu', phase: 'mid', world: 'real', act: '研究小馆子的菜单', detail: '一个字不认识，最后指着邻桌点了同一份。' },
  { id: 'mid-real-drink', phase: 'mid', world: 'real', act: '捧着热饮慢慢走', detail: '杯子太烫，你两只手倒来倒去，走得比谁都慢。' },
  { id: 'mid-real-market', phase: 'mid', world: 'real', act: '逛集市上的摊子', detail: '两边的东西杂七杂八，你挨个拿起来看看又放下。' },
  { id: 'mid-real-things', phase: 'mid', world: 'real', thing: true, act: '盯着{thing}犹豫要不要买', detail: '拿起来又放下，摊主很有耐心地等着；你还没决定要不要带回去。' },
  // ★ 景点条目是 **world: P（不区分现实/异世界）** —— 景点两边都有，早年只写现实版
  //   时"异世界行程永远抽不到去过的地方"（探针抓到的，`spots` 白瞎了）。
  //   前提是 `{spot}` 只填**已寄过明信片**的景点 ⇒ 确实去过，不会提前穿帮。
  { id: 'mid-spot-photo', phase: 'mid', world: P, spot: true, act: '给{spot}拍了一堆照', detail: '回看发现糊了三张，只剩一张能用。' },
  { id: 'mid-spot-out', phase: 'mid', world: P, spot: true, act: '刚逛完{spot}', detail: '里面比想象中小，你在台阶上坐了一会儿，把鞋带重新系紧。' },
  { id: 'mid-spot-rest', phase: 'mid', world: P, spot: true, act: '坐在{spot}外面歇脚', detail: '出来腿就软了，你靠着墙坐了会儿，才想起来翻地图。' },
  { id: 'mid-spot-shot', phase: 'mid', world: P, spot: true, act: '站在{spot}前面拍照片', detail: '等人少了才按下快门，回看还是有人从边上走过去。' },
  { id: 'mid-fic-spot-daze', phase: 'mid', world: 'fiction', spot: true, act: '从{spot}里出来还没回神', detail: '里面的东西你从没见过，走了很远还在想。' },
  { id: 'mid-real-wander', phase: 'mid', world: 'real', act: '随便挑条巷子乱走', detail: '没有目的地，哪条巷子看着顺眼就往哪拐。' },
  { id: 'mid-real-lost', phase: 'mid', world: 'real', act: '又绕回同一个路口', detail: '明明按记忆走的，绕回来还是这家店，你开始怀疑自己的方向感。' },
  { id: 'mid-real-ask', phase: 'mid', world: 'real', act: '抓着路人问路', detail: '对方说得飞快，你只听懂了一个"那边"，然后顺着那边走了。' },
  { id: 'mid-real-queue', phase: 'mid', world: 'real', act: '排队等一家名店', detail: '队伍长得离谱，你一边排一边怀疑自己为什么要排。' },
  { id: 'mid-real-sun', phase: 'mid', world: 'real', act: '被晒得发蔫', detail: '找了个树荫蹲下来，把水喝掉半瓶，缓了半天才起来。' },
  { id: 'mid-real-bus', phase: 'mid', world: 'real', act: '抱着包赶一班车', detail: '在站台小跑，刚好在关门前挤了上去，气都没喘匀。' },
  { id: 'mid-real-boat', phase: 'mid', world: 'real', act: '坐船吹风', detail: '风把头发全吹到脸上，你懒得拨，就这么看水面。' },
  { id: 'mid-real-rain', phase: 'mid', world: 'real', act: '蹲屋檐下躲雨', detail: '底下挤了一排人，你贴墙站着，看雨点砸在水洼里。' },
  { id: 'mid-real-rest', phase: 'mid', world: 'real', act: '坐长椅上歇脚', detail: '腿是真的有点酸了，你把包垫在脚边，看鸽子抢东西吃。' },
  { id: 'mid-real-hill', phase: 'mid', world: 'real', act: '爬坡爬得直喘', detail: '坡比看上去陡，你已经停下来喘了两次。' },
  { id: 'mid-real-sunset', phase: 'mid', world: 'real', act: '看日落', detail: '太阳掉得很慢，你把手机举起来又放下了——拍不出来。' },
  { id: 'mid-real-night-mkt', phase: 'mid', world: 'real', act: '挤夜市', detail: '两边全是吃的，你走了十米就想停下来买一次。' },
  { id: 'mid-real-innkeeper', phase: 'mid', world: 'real', act: '跟旅店老板聊天', detail: '对方边擦杯子边讲本地的事，你听得半懂，但很爱听。' },
  { id: 'mid-real-money-count', phase: 'mid', world: 'real', act: '算今天花了多少', detail: '钱包瘪得比想象快，你心里默算还剩几天能这么花。' },
  { id: 'mid-real-postcard', phase: 'mid', world: 'real', act: '给家里挑明信片', detail: '挑了最花的一张，写完发现字是歪的，也不想重写。' },
  { id: 'mid-real-wall', phase: 'mid', world: 'real', act: '对着一面爬满藤的墙拍照', detail: '你怎么拍都觉得拍不出眼睛里看到的那样。' },
  { id: 'mid-real-cafe', phase: 'mid', world: 'real', act: '窝在小店里发呆', detail: '一杯东西喝了很久，窗外的人换了一拨又一拨。' },
  { id: 'mid-real-food-again', phase: 'mid', world: 'real', act: '回头再买一份刚才吃过的小吃', detail: '刚才那口没吃够，你绕回来又排了一次队。' },
  { id: 'mid-real-shoes', phase: 'mid', world: 'real', act: '蹲下重新系鞋带', detail: '鞋带松了两次，脚后跟也有点磨，你把袜子往下扯了扯。' },
  { id: 'mid-real-train', phase: 'mid', world: 'real', act: '靠着车窗打瞌睡', detail: '醒来发现坐过了两站，只好又坐回去。' },
  { id: 'mid-real-gate', phase: 'mid', world: 'real', act: '翻遍包找那张票', detail: '后面的人排着队，你越急越找不到，最后发现夹在书里。' },
  { id: 'mid-real-roadsign', phase: 'mid', world: 'real', act: '对着一块路牌分辨方向', detail: '三个地名一个都不认识，你拍了张照准备问人。' },
  { id: 'mid-real-bike', phase: 'mid', world: 'real', act: '租了辆车骑一段', detail: '车座太低，骑了两公里腿伸不直，只好下来推。' },
  { id: 'mid-real-steps', phase: 'mid', world: 'real', act: '爬一段很长的台阶', detail: '数到一百就不数了，抬头看还剩一半。' },
  { id: 'mid-real-bridge', phase: 'mid', world: 'real', act: '扶着栏杆看河水', detail: '水很浑，漂着树叶；你就那么看着，什么都没想。' },
  { id: 'mid-real-pigeon', phase: 'mid', world: 'real', act: '被一群鸽子惊到', detail: '哗啦一声全飞了，你被吓得退了半步。' },
  { id: 'mid-real-case', phase: 'mid', world: 'real', act: '盯着展柜里的东西看', detail: '看了很久，直到旁边的人换了两拨。' },
  { id: 'mid-real-oldhouse', phase: 'mid', world: 'real', act: '进了一座老房子', detail: '里面很凉，你放轻脚步，怕吵到什么。' },
  { id: 'mid-real-cloud', phase: 'mid', world: 'real', act: '躺草地上看云', detail: '云走得很快，你看着看着就出神了。' },
  { id: 'mid-real-laundry', phase: 'mid', world: 'real', act: '把脏衣服送去洗', detail: '老板比划着说后天来取，你才想起后天就走了。' },
  { id: 'mid-real-haircut', phase: 'mid', world: 'real', act: '被拉进一家理发店', detail: '说不清要什么样，最后剪得跟想象完全不一样。' },
  { id: 'mid-real-haggle', phase: 'mid', world: 'real', act: '为一件东西讨价还价', detail: '比划了半天，最后成交的价你也不知道是亏是赚。' },
  { id: 'mid-real-window', phase: 'mid', world: 'real', act: '盯着橱窗里的东西看', detail: '不打算买，就是觉得摆得好看，站了一小会儿。' },
  { id: 'mid-real-busker', phase: 'mid', world: 'real', act: '被街头唱歌的吸住', detail: '站到一首歌结束，往帽子里放了点零钱。' },
  { id: 'mid-real-parade', phase: 'mid', world: 'real', act: '被一个游行队伍堵住', detail: '两边都过不去，你干脆站定，把它从头看到尾。' },
  { id: 'mid-real-river', phase: 'mid', world: 'real', act: '沿着河边一直走', detail: '路灯一盏挨着一盏，你走到脚有点热才想起看时间。' },
  { id: 'mid-real-festival', phase: 'mid', world: 'real', act: '撞上一场本地节庆', detail: '满街挂着东西，鼓声吵得说话都费劲，你还挺高兴。' },
  { id: 'mid-real-hotspring', phase: 'mid', world: 'real', act: '泡了一次当地的汤池', detail: '水烫得你呲牙，隔壁的老太太看得直笑。' },
  { id: 'mid-real-bookstall', phase: 'mid', world: 'real', act: '蹲在旧书摊翻了一本', detail: '一个字看不懂，还是买了下来，就当留个念。' },
  { id: 'mid-real-craftsman', phase: 'mid', world: 'real', act: '看人现场做东西', detail: '手快得看不清，你看着看着就想买，忍住了。' },
  { id: 'mid-real-downpour', phase: 'mid', world: 'real', act: '淋了半场雨', detail: '伞在包里懒得拿，等想起来的时候已经湿透了。' },
  { id: 'mid-real-skewer', phase: 'mid', world: 'real', act: '买了串从没吃过的东西', detail: '咬下去才发现是甜的，跟你以为的完全反了。' },
  { id: 'mid-real-teahouse', phase: 'mid', world: 'real', act: '进茶馆坐了一下午', detail: '一壶水续了七八次，看了两拨客人来来去去。' },
  { id: 'mid-real-shootask', phase: 'mid', world: 'real', act: '请路人帮忙拍照', detail: '拍了五张，只有最后一张没闭眼。' },
  { id: 'mid-real-phonelost', phase: 'mid', world: 'real', act: '以为手机丢了', detail: '翻遍全身和包，最后在外套内袋里摸到，吓得手心出汗。' },
  { id: 'mid-real-invited', phase: 'mid', world: 'real', act: '被本地人请去坐坐', detail: '语言不怎么通，但对方还是给你倒了水，你坐了一会儿。' },
  { id: 'mid-real-quietspot', phase: 'mid', world: 'real', act: '找到一个没什么人的地方', detail: '坐下来才发现风景比景点还好，你多待了一阵。' },
  { id: 'mid-real-lineup', phase: 'mid', world: 'real', act: '跟着人群排队', detail: '其实不知道排的是什么，等到了才发现是家小吃店。' },
  { id: 'mid-real-busstop', phase: 'mid', world: 'real', act: '对着站牌算哪趟车', detail: '等了二十分钟才来，坐上去发现方向反了。' },
  { id: 'mid-real-tide', phase: 'mid', world: 'real', act: '赶在退潮时去海边', detail: '鞋里灌了沙，裤脚也湿了，你蹲下捡了块石头。' },
  { id: 'mid-real-darkwalk', phase: 'mid', world: 'real', act: '天黑了还不肯回住处', detail: '街上人少了，你慢慢往回走，路灯把影子拖得很长。' },
  { id: 'mid-real-pickgift', phase: 'mid', world: 'real', act: '对着两样东西挑礼物', detail: '来回跑了两趟，最后还是拿了第一次看上的那件。' },
  { id: 'mid-real-cityname', phase: 'mid', world: 'real', act: '把{city}这个名字念了两遍', detail: '舌头有点绕，念第二遍才顺，你觉得挺有意思。' },
  { id: 'mid-real-citysign', phase: 'mid', world: 'real', act: '对着写有{city}的路牌拍照', detail: '拍完自己看了看，觉得比拍风景有意思。' },
  { id: 'mid-real-fountain', phase: 'mid', world: 'real', act: '坐在喷泉边歇脚', detail: '水声一直响，你听着听着就不想动了。' },
  { id: 'mid-real-lantern', phase: 'mid', world: 'real', act: '跟着一盏灯笼往回走', detail: '提灯的人在前面，你隔着几步跟着，一直跟到了住处。' },

  // ═══════════════════════════ 路上 · 现实 · 有旅伴 ═══════════════════════════
  { id: 'mid-real-mate-split', phase: 'mid', world: 'real', mate: true, act: '和{mate}分一份点心', detail: '两个人都说"你吃吧"，最后一人一半，谁也没吃亏。' },
  { id: 'mid-real-mate-pull', phase: 'mid', world: 'real', mate: true, act: '被{mate}拉着往前走', detail: '你还在看橱窗，已经被拽出两米远，只好小跑跟上。' },
  { id: 'mid-real-mate-argue', phase: 'mid', world: 'real', mate: true, act: '和{mate}为走哪条路拌嘴', detail: '争了半天，最后听了{mate}的——然后真的绕远了。' },
  { id: 'mid-real-mate-rest', phase: 'mid', world: 'real', mate: true, act: '靠在{mate}旁边歇脚', detail: '你把头靠过去，{mate}没动，只是把包挪了挪给你垫着。' },
  { id: 'mid-real-mate-food', phase: 'mid', world: 'real', mate: true, act: '给{mate}买了份吃的', detail: '自己那份犹豫了一下没买，先把热的递给了{mate}。' },
  { id: 'mid-real-mate-selfie', phase: 'mid', world: 'real', mate: true, act: '和{mate}合影', detail: '举着手机找角度找了半天，{mate}已经不耐烦地把脸转开了。' },
  { id: 'mid-real-mate-umbrella', phase: 'mid', world: 'real', mate: true, act: '和{mate}挤一把伞', detail: '伞太小，两个人都湿了半边肩膀，谁也没说要换。' },
  { id: 'mid-real-mate-nav', phase: 'mid', world: 'real', mate: true, act: '和{mate}为导航吵架', detail: '一个说左一个说右，最后走了第三个方向。' },
  { id: 'mid-real-mate-bag', phase: 'mid', world: 'real', mate: true, act: '把包丢给{mate}背着', detail: '说是就一会儿，结果一背就是一下午。' },
  { id: 'mid-real-mate-photo', phase: 'mid', world: 'real', mate: true, act: '给{mate}拍了一堆照', detail: '百分之八十是糊的，{mate}看了想删，你护着不给。' },
  { id: 'mid-real-mate-stall', phase: 'mid', world: 'real', mate: true, act: '陪{mate}在摊前挑半天', detail: '你站在一边等到腿麻，最后{mate}什么都没买。' },
  { id: 'mid-real-mate-lost', phase: 'mid', world: 'real', mate: true, act: '和{mate}一起迷路', detail: '谁都不肯承认是自己带错的，绕了很久才出来。' },
  { id: 'mid-real-mate-taxi', phase: 'mid', world: 'real', mate: true, act: '为要不要打车和{mate}讨论', detail: '算了半天谁也没说服谁，最后走着去了。' },
  { id: 'mid-real-mate-shoulder', phase: 'mid', world: 'real', mate: true, act: '让{mate}靠着睡一会儿', detail: '你一动不敢动，肩膀麻了也没吭声。' },
  { id: 'mid-real-mate-cup', phase: 'mid', world: 'real', mate: true, act: '和{mate}分了同一杯饮料', detail: '吸管只有一根，两个人轮流吸，觉得挺好笑。' },
  { id: 'mid-real-mate-tease', phase: 'mid', world: 'real', mate: true, act: '拿{mate}的糗事开玩笑', detail: '被瞪了一眼，你赶紧说"下次不说了"，其实自己也没忍住笑。' },
  { id: 'mid-real-mate-wait', phase: 'mid', world: 'real', mate: true, act: '站在店门口等{mate}', detail: '店员都看了你好几眼，你假装在看别处。' },
  { id: 'mid-real-mate-route', phase: 'mid', world: 'real', mate: true, act: '和{mate}对着地图划路线', detail: '圈了好几个地方，最后只去了最顺路的那个。' },
  { id: 'mid-real-mate-bargain', phase: 'mid', world: 'real', mate: true, act: '替{mate}砍价', detail: '你比{mate}还急，最后价格是你先松口的。' },
  { id: 'mid-real-mate-lastbite', phase: 'mid', world: 'real', mate: true, act: '给{mate}留了最后一口', detail: '自己其实也想吃，还是推给了{mate}。' },
  { id: 'mid-real-mate-crowd', phase: 'mid', world: 'real', mate: true, act: '和{mate}挤在人群里', detail: '怕走散，两个人走得很近，谁也没说话。' },
  { id: 'mid-real-mate-skill', phase: 'mid', world: 'real', mate: true, act: '被{mate}说拍照技术差', detail: '你不服气，重新拍了二十张，还是被说差。' },
  { id: 'mid-real-mate-lodge', phase: 'mid', world: 'real', mate: true, act: '和{mate}商量晚上住哪', detail: '一个嫌贵一个嫌远，最后挑了个又贵又远的。' },
  { id: 'mid-real-mate-quiet', phase: 'mid', world: 'real', mate: true, act: '和{mate}并排坐着不说话', detail: '各看各的，风从两人中间穿过去，一点也不尴尬。' },

  // ═══════════════════════════ 路上 · 异世界 ═══════════════════════════
  { id: 'mid-fic-tavern', phase: 'mid', world: 'fiction', need: ["folk"], act: '泡酒馆打听消息', detail: '谁都在说话，你端着杯子听了半天：正事没听明白，八卦听了一耳朵。' },
  { id: 'mid-fic-taste', phase: 'mid', world: 'fiction', need: ["folk"], act: '试当地的吃食', detail: '看不出是什么做的，闻着还行；你咬了一小口，愣了三秒。' },
  { id: 'mid-fic-feast', phase: 'mid', world: 'fiction', need: ["folk"], act: '被请了一顿当地饭', detail: '一桌子叫不出名字的东西，主人一直往你碗里添，你不好意思剩。' },
  { id: 'mid-fic-drink', phase: 'mid', world: 'fiction', need: ["folk"], act: '喝一种说不清味道的饮料', detail: '第一口怪，第二口顺，第三口你已经开始主动续了。' },
  { id: 'mid-fic-weird', phase: 'mid', world: 'fiction', act: '盯着会自己亮的东西出神', detail: '它没有火也没有电，就那么亮着；你看了好一会儿才走。' },
  { id: 'mid-fic-market', phase: 'mid', world: 'fiction', need: ["folk"], act: '挨个看集市的摊子', detail: '上面的玩意儿一半不认识，摊主很有耐心地任你翻。' },
  { id: 'mid-fic-store', phase: 'mid', world: 'fiction', act: '翻包清点还剩什么', detail: '能吃的、能用的，数来数去就那么几样，你重新塞了回去。' },
  { id: 'mid-fic-water', phase: 'mid', world: 'fiction', need: ["water"], act: '到处找水', detail: '渴得厉害，问了两家才讨到一壶，喝之前还先闻了闻。' },
  { id: 'mid-fic-lost', phase: 'mid', world: 'fiction', act: '找回去的路', detail: '街景长得都很像，你开始怀疑刚才那条是不是走过。' },
  { id: 'mid-fic-home', phase: 'mid', world: 'fiction', need: ["folk"], act: '跟人打听怎么回去', detail: '问了三个人，给了三个说法，你越听越迷糊。' },
  { id: 'mid-fic-ration', phase: 'mid', world: 'fiction', act: '边走边啃干粮', detail: '味道一般，但是真饿，你三口就吃完了一份。' },
  { id: 'mid-fic-sky', phase: 'mid', world: 'fiction', act: '盯着天上那团不太对的颜色', detail: '看了半天没看懂，决定先找个能躲的地方待着。' },
  { id: 'mid-fic-lantern', phase: 'mid', world: 'fiction', need: ["built"], act: '靠着灯柱歇脚', detail: '光晕黄黄的，把影子拉得很长；你坐着没动，听远处有动静。' },
  { id: 'mid-fic-locals', phase: 'mid', world: 'fiction', need: ["folk"], act: '被一圈当地人围着看', detail: '他们不凶，就是很好奇；你被看得有点发毛，只好笑一笑。' },
  { id: 'mid-fic-gift', phase: 'mid', world: 'fiction', need: ["folk"], act: '被塞了一样说不上来的东西', detail: '对方塞完就走，你举着那玩意儿站在原地研究。' },
  { id: 'mid-fic-sign', phase: 'mid', world: 'fiction', need: ["built"], act: '研究路边牌子上的字', detail: '笔画认识一半，合起来一个词也不懂，只能靠图案猜。' },
  { id: 'mid-fic-ruin', phase: 'mid', world: 'fiction', need: ["built"], act: '钻进一片没人的废墟', detail: '墙塌了一半，地上全是碎石头，你走得很小心。' },
  { id: 'mid-fic-rune', phase: 'mid', world: 'fiction', need: ["built"], act: '对着一面刻满符号的墙', detail: '符号排得很整齐，你说不出是什么，但看得出不是随便刻的。' },
  { id: 'mid-fic-selflamp', phase: 'mid', world: 'fiction', act: '看灯自己亮起来', detail: '没人点火，它到了时间就亮；你看了两遍才信。' },
  { id: 'mid-fic-float', phase: 'mid', world: 'fiction', act: '盯着浮在半空的东西', detail: '它慢慢地转，你伸手够了一下，什么都没碰到。' },
  { id: 'mid-fic-tracks', phase: 'mid', world: 'fiction', act: '低头研究地上的脚印', detail: '比你的脚大两圈，还是新的；你换了条路走。' },
  { id: 'mid-fic-odrain', phase: 'mid', world: 'fiction', need: ["water"], act: '被一场怪雨拦下', detail: '雨点是温的，落在地上留下一圈圈怪印子。' },
  { id: 'mid-fic-nightsound', phase: 'mid', world: 'fiction', act: '夜里听见远处有动静', detail: '说不上是什么，一会儿有一会儿没，你不敢出去看。' },
  { id: 'mid-fic-barter', phase: 'mid', world: 'fiction', need: ["folk"], act: '拿自己的东西换东西', detail: '对方挑挑拣拣，最后换了两样你不太想要的东西。' },
  { id: 'mid-fic-ferry', phase: 'mid', world: 'fiction', need: ["water"], act: '坐一条没有桨的船', detail: '它自己会动，你抓着边，全程没敢站起来。' },
  { id: 'mid-fic-cliff', phase: 'mid', world: 'fiction', act: '手脚并用爬一段崖', detail: '上去之后腿都软了，回头看一眼，觉得刚才挺冒险。' },
  { id: 'mid-fic-handmap', phase: 'mid', world: 'fiction', need: ["folk"], act: '借来一张手绘的地图', detail: '画得乱七八糟，但标了几个"别去"的地方。' },
  { id: 'mid-fic-childguide', phase: 'mid', world: 'fiction', need: ["folk"], act: '被一个小孩领着走', detail: '他一路叽里呱啦，你一个字没懂，还是跟着到了。' },
  { id: 'mid-fic-ritual', phase: 'mid', world: 'fiction', need: ["folk"], act: '被邀去参加什么仪式', detail: '你站在最边上，跟着大家该点头点头，该低头低头。' },
  { id: 'mid-fic-repair', phase: 'mid', world: 'fiction', need: ["folk"], act: '帮人修了个小东西', detail: '其实你也不太会，摸索着弄好了，对方一直道谢。' },
  { id: 'mid-fic-clock', phase: 'mid', world: 'fiction', need: ["folk"], act: '看街上那座大钟', detail: '指针走的方向跟你想的相反，你盯着看了好一会儿。' },
  { id: 'mid-fic-pet', phase: 'mid', world: 'fiction', act: '摸了一只不认识的小兽', detail: '它先躲了一下，然后自己凑过来，你顺了顺它的毛。' },
  { id: 'mid-fic-dump', phase: 'mid', world: 'fiction', need: ["folk"], act: '把口袋里的东西全掏出来', detail: '摊在地上，围过来好几个看热闹的，谁也没说要买。' },
  { id: 'mid-fic-scratch', phase: 'mid', world: 'fiction', act: '被什么划了一下手腕', detail: '不深，但你不知道该不该找地方处理，先拿布缠上。' },
  { id: 'mid-fic-narrowstair', phase: 'mid', world: 'fiction', need: ["built"], act: '顺着一道窄楼梯往下走', detail: '越走越暗，你扶着墙，走了很久才见到底下的光亮。' },
  { id: 'mid-fic-chasestop', phase: 'mid', world: 'fiction', act: '跑了一阵发现没人追', detail: '回头看了三次，才慢慢停下，扶着膝盖喘气。' },
  { id: 'mid-fic-statue', phase: 'mid', world: 'fiction', need: ["built"], act: '看见一尊很高很大的像', detail: '眼睛像是跟着你转，你走快了两步，再没回头。' },
  { id: 'mid-fic-shrine', phase: 'mid', world: 'fiction', need: ["folk"], act: '跟着人去一处祭拜的地方', detail: '你也学样放了点东西，不知道管不管用，反正放了。' },
  { id: 'mid-fic-inviswall', phase: 'mid', world: 'fiction', act: '被一道看不见的墙挡住', detail: '往前走就到头了，伸手一推，什么都没有。' },
  { id: 'mid-fic-tune', phase: 'mid', world: 'fiction', need: ["folk"], act: '被一段没听过的调子吸引', detail: '顺着声音找到源头，是个人坐在地上吹着什么。' },
  { id: 'mid-fic-hideitem', phase: 'mid', world: 'fiction', act: '把一样东西藏进衣服里', detail: '不知道有没有用，就是觉得不该拿在手上。' },
  { id: 'mid-fic-wash', phase: 'mid', world: 'fiction', need: ["water"], act: '捧起水洗了把脸', detail: '凉得激灵一下，脑子倒是清楚了不少。' },
  { id: 'mid-fic-walkaway', phase: 'mid', world: 'fiction', act: '把一样东西放回去走了', detail: '价格谈不拢，你转身就走，走了两步其实有点后悔。' },
  { id: 'mid-fic-starnav', phase: 'mid', world: 'fiction', act: '照着星星辨方向', detail: '看不太懂，但总比没有强；你选定一个方向往前走。' },
  { id: 'mid-fic-things', phase: 'mid', world: 'fiction', thing: true, need: ["folk"], act: '拿起{thing}又放回去', detail: '来回两次，你还是没决定要不要买。' },
  { id: 'mid-fic-mistake', phase: 'mid', world: 'fiction', act: '拐进一条走不通的路', detail: '尽头是堵墙，你原路退回来，假装什么都没发生。' },
  // ── 异世界 · 荒芜/恶劣地貌也成立的条目（2026-10-12 加）──
  //   由头：查尔这类地方（虫巢＋岩浆）会被 `need` 筛掉一大批"河海/市集"条目，
  //   补几条**不依赖水、植被、人烟**的，免得那种地方只剩"被追着跑"。
  { id: 'mid-fic-ash', phase: 'mid', world: 'fiction', act: '踩着一地碎石往前走', detail: '脚下咔咔响，你尽量挑平的地方落脚。' },
  { id: 'mid-fic-heat', phase: 'mid', world: 'fiction', act: '被热气逼得绕路', detail: '那边烫得靠不近，你贴着阴影那边绕过去。' },
  { id: 'mid-fic-crack', phase: 'mid', world: 'fiction', act: '躲进一道岩缝避风', detail: '缝里比外面安静，你缩着等风小一点。' },
  { id: 'mid-fic-dust', phase: 'mid', world: 'fiction', act: '用布捂住了口鼻', detail: '空气里有股说不清的味道，你走一段就得换一次气。' },
  { id: 'mid-fic-glow', phase: 'mid', world: 'fiction', act: '盯着远处发红的地面', detail: '它在缓慢地动着，你决定不往那边走。' },
  { id: 'mid-fic-hollow', phase: 'mid', world: 'fiction', act: '钻进一个空壳里歇脚', detail: '里面比外头安静，你听着外面有没有动静。' },

  // ── 异世界 · 遭遇｜通用（任何敌手都适用：追、躲、对峙、数个数）──
  { id: 'mid-fic-foe-run', phase: 'mid', world: 'fiction', foe: true, act: '被{foe}追着跑', detail: '你跑得不慢，但对方显然也不打算放弃，鞋里全是土。' },
  { id: 'mid-fic-foe-out', phase: 'mid', world: 'fiction', foe: true, act: '刚甩掉{foe}', detail: '靠着墙喘气，手还在抖，回头确认没人跟上来。' },
  { id: 'mid-fic-foe-face', phase: 'mid', world: 'fiction', foe: true, act: '跟{foe}对峙', detail: '对方堵在路口，你一步一步往里挪，嘴上还在硬撑。' },
  { id: 'mid-fic-foe-hide', phase: 'mid', world: 'fiction', foe: true, act: '贴着墙根等动静过去', detail: '呼吸压得很轻，听见脚步从另一边走远了。' },
  { id: 'mid-fic-foe-bandage', phase: 'mid', world: 'fiction', foe: true, act: '给自己缠布条', detail: '不严重，但有点疼；你一边缠一边小声骂自己。' },
  { id: 'mid-fic-foe-watch', phase: 'mid', world: 'fiction', foe: true, act: '盯着{foe}的动静', detail: '隔着一段距离看，数了数对面的个数，心里有点没底。' },
  { id: 'mid-fic-foe-breath', phase: 'mid', world: 'fiction', foe: true, act: '靠着墙缓一缓', detail: '胸口起伏得厉害，你先数了三个数才敢继续走。' },
  { id: 'mid-fic-foe-mark', phase: 'mid', world: 'fiction', foe: true, act: '拿石头在墙上刻记号', detail: '记下自己是从哪边来的，免得绕回去又撞上。' },

  // ── 异世界 · 遭遇｜生物/人类敌手（打跑／赶走／战胜）──
  { id: 'mid-fic-foe-catch', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '挤开{foe}冲了出来', detail: '衣角被扯破了一道口子，你低头看了看，决定先不管。' },
  { id: 'mid-fic-foe-alley', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '被{foe}撵进小巷', detail: '巷子越走越窄，你一边跑一边在心里挑哪边能翻过去。' },
  { id: 'mid-fic-foe-bargain', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '跟{foe}僵着谈条件', detail: '你一边往后退一边比划，对方似乎也在掂量值不值得动手。' },
  { id: 'mid-fic-foe-throw', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '朝{foe}扔石头就跑', detail: '转身就跑，边跑边后悔刚才那一下是不是太多余。' },
  { id: 'mid-fic-foe-beat', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '把{foe}打散了', detail: '你比对方想的能打；收拾完手还在抖，不是怕，是累。' },
  { id: 'mid-fic-foe-drive', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '赶跑了{foe}', detail: '追出两条街，直到对方彻底没了影，你才扶着墙停下。' },
  { id: 'mid-fic-foe-win', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '把{foe}撂倒一地', detail: '你自己也挂了彩，但站着的那个是你。' },
  { id: 'mid-fic-foe-scare', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '把{foe}唬退了', detail: '你吼了一声，又抄起手边的东西；对方退了，你也没敢追。' },
  { id: 'mid-fic-foe-stand', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '站在{foe}面前没退', detail: '你没让路，对方先移开了目光；这一局算你的。' },
  { id: 'mid-fic-foe-clear', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '把{foe}赶出了这片', detail: '一直到看不见影子你才收手，回头看地上全是被踩烂的东西。' },
  { id: 'mid-fic-foe-lure', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '把{foe}往别处引', detail: '扔了东西出去，对方果然转头了；你转身就跑。' },
  { id: 'mid-fic-foe-tree', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', need: ["green"], act: '爬上树等{foe}走远', detail: '树皮扎手，你抱得死死的，等到腿都麻了。' },
  { id: 'mid-fic-foe-wade', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', need: ["water"], act: '趟着水甩掉{foe}', detail: '水到膝盖，走一步沉一下，好在对方没追过来。' },
  { id: 'mid-fic-foe-drop', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '扔下东西才脱身', detail: '包里的东西撒了一地，你只捡了最要紧的那件。' },
  { id: 'mid-fic-foe-help', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', need: ["folk"], act: '被陌生人拉开躲{foe}', detail: '对方一句没说，把你按进巷子里，等动静过去才松手。' },
  { id: 'mid-fic-foe-dawn', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '熬到天亮{foe}才散', detail: '天边发白的时候动静终于没了，你靠着墙差点睡着。' },
  { id: 'mid-fic-foe-after', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '等{foe}走后再收拾', detail: '东西被翻得乱七八糟，你蹲在地上一样样往包里塞。' },
  { id: 'mid-fic-foe-talk', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '试着跟{foe}搭话', detail: '你说了几句，对方好像听懂了，又好像没有。' },
  { id: 'mid-fic-foe-toll', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '拿东西换{foe}放行', detail: '对方翻了翻，点了点头；你走得比平时快多了。' },
  { id: 'mid-fic-foe-hurt', phase: 'mid', world: 'fiction', foe: true, foeKind: 'organic', act: '被{foe}蹭掉一层皮', detail: '胳膊上火辣辣的，你连看都没看，先跑远了再说。' },

  // ── 异世界 · 遭遇｜机械型敌手（**黑入系统**，用户口径："这个入侵是黑客入侵"）──
  { id: 'mid-fic-foe-hack', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '黑入{foe}的控制系统', detail: '手指在光屏上敲了半天，最大那台的动作慢了下来。' },
  { id: 'mid-fic-foe-stall', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '让{foe}卡在原地不动', detail: '它的关节停在半空，像个被按了暂停的东西。' },
  { id: 'mid-fic-foe-glitch', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '让{foe}的屏幕全花了', detail: '一排看不懂的字在闪；它们撞在了一起，谁也没让谁。' },
  { id: 'mid-fic-foe-overload', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '骗{foe}自己过载', detail: '你塞了个假指令进去，它把自己烧停了。' },
  { id: 'mid-fic-foe-turncoat', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '让{foe}自己打起来', detail: '改了一行的归属，它们真的照做了，你在旁边看着。' },
  { id: 'mid-fic-foe-drone', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '拆掉{foe}的动力', detail: '它跪了下去，机壳里还在嗡嗡响。' },
  { id: 'mid-fic-foe-scan', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '摸清{foe}的巡逻路线', detail: '你在一处高处蹲了很久，把它们来回的道记了个大概。' },
  { id: 'mid-fic-foe-shelter', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '缩在{foe}打不到的地方', detail: '光柱扫过你头顶，你贴着墙一动不敢动。' },
  { id: 'mid-fic-foe-signal', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '断掉{foe}之间的联络', detail: '屏幕一片雪花，它们开始各走各的，乱成一团。' },
  { id: 'mid-fic-foe-loot', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '翻{foe}留下的残骸', detail: '烫手，你翻了两下就缩回来，只拿了个小零件。' },
  { id: 'mid-fic-foe-hijack', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '抢下{foe}的控制权', detail: '座舱里全是灰，你坐进去，手不知道往哪放。' },
  { id: 'mid-fic-foe-bluff', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '假装自己能控制{foe}', detail: '你把手举高，它居然真的停了一下；你趁那一下跑了。' },
  { id: 'mid-fic-foe-shutdown', phase: 'mid', world: 'fiction', foe: true, foeKind: 'machine', act: '把{foe}全部关机', detail: '最后一声嗡响落下去，空地上一排东西全不亮了。' },

  // ── 异世界 · 有旅伴 ──
  { id: 'mid-fic-mate-back', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}背靠背歇着', detail: '两个人都没说话，风吹过来的时候凉快了一点。' },
  { id: 'mid-fic-mate-hide', phase: 'mid', world: 'fiction', mate: true, act: '被{mate}拽着躲进巷子', detail: '还没来得及问为什么，你已经被人按在墙上了。' },
  { id: 'mid-fic-mate-lap', phase: 'mid', world: 'fiction', mate: true, act: '趴在{mate}膝盖上打盹', detail: '说好只休息一刻钟，你迷迷糊糊睡了大半觉，{mate}一动没动。' },
  { id: 'mid-fic-mate-share', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}分最后一块吃的', detail: '两个人都说"你吃"，最后掰成两半，谁也没多要。' },
  { id: 'mid-fic-mate-code', phase: 'mid', world: 'fiction', mate: true, act: '跟{mate}对暗号', detail: '临时编了几句黑话，说完自己先笑场了。' },
  { id: 'mid-fic-mate-cover', phase: 'mid', world: 'fiction', mate: true, act: '护着{mate}往外撤', detail: '你走在前面，回头看了好几次，确认人还跟着。' },
  { id: 'mid-fic-mate-salve', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}互相上药', detail: '疼得龇牙，但两个人都下手很轻。' },
  { id: 'mid-fic-mate-worry', phase: 'mid', world: 'fiction', mate: true, act: '回头确认{mate}有没有跟上', detail: '走着走着就回头，第三次回头的时候被{mate}说了一句。' },
  { id: 'mid-fic-mate-teach', phase: 'mid', world: 'fiction', mate: true, act: '被{mate}上了一课', detail: '关于这地方的事{mate}知道得比你多，你听得半信半疑，最后还是照做了。' },
  { id: 'mid-fic-mate-guard', phase: 'mid', world: 'fiction', mate: true, act: '让{mate}先睡我守夜', detail: '一开始还挺精神，后半夜困得直点头。' },
  { id: 'mid-fic-mate-carry', phase: 'mid', world: 'fiction', mate: true, act: '背了{mate}一段路', detail: '嘴上说"就背一百步"，走完一百步又接着走。' },
  { id: 'mid-fic-mate-split', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}分工找路', detail: '一个问人一个看地图，最后两边都没结果。' },
  { id: 'mid-fic-mate-argue', phase: 'mid', world: 'fiction', mate: true, act: '为走哪条路跟{mate}争执', detail: '各说各的，最后谁也没让步，走了第三条。' },
  { id: 'mid-fic-mate-trust', phase: 'mid', world: 'fiction', mate: true, act: '把背包交给{mate}看着', detail: '你走开了一小会儿，回来时{mate}抱着包打盹。' },
  { id: 'mid-fic-mate-scared', phase: 'mid', world: 'fiction', mate: true, act: '被{mate}发现你在发抖', detail: '你嘴硬说风大，{mate}没拆穿，往你这边挪了挪。' },
  { id: 'mid-fic-mate-sign', phase: 'mid', world: 'fiction', mate: true, need: ["folk"], act: '替{mate}跟人比划', detail: '两个人一起比，比一个人还乱，对方看得直笑。' },
  { id: 'mid-fic-mate-joke', phase: 'mid', world: 'fiction', mate: true, act: '跟{mate}讲了个冷笑话', detail: '半天没人笑，你自己先憋不住，结果两个人一起笑。' },
  { id: 'mid-fic-mate-lap2', phase: 'mid', world: 'fiction', mate: true, act: '靠在{mate}肩上睡不着', detail: '闭着眼也清醒着，就听着{mate}的呼吸声。' },
  { id: 'mid-fic-mate-hair', phase: 'mid', world: 'fiction', mate: true, need: ["green"], act: '替{mate}把头发拨开', detail: '沾了草屑，你顺手拈掉，{mate}愣了一下没说谢谢。' },
  { id: 'mid-fic-mate-check', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}互相看有没有受伤', detail: '你转了圈，{mate}说你后背破了一小道，你自己没察觉。' },
  { id: 'mid-fic-mate-ration', phase: 'mid', world: 'fiction', mate: true, act: '只有一份干粮两个人分', detail: '都往对方那边多掰了点，最后剩了一小块谁也没吃。' },
  { id: 'mid-fic-mate-huddle', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}挤在一处避风', detail: '地方很小，两个人肩膀贴着肩膀，谁也没说要挪。' },
  { id: 'mid-fic-mate-thanks', phase: 'mid', world: 'fiction', mate: true, act: '被{mate}突然道谢', detail: '你愣了半天才反应过来，含糊应了句"没事"。' },
  { id: 'mid-fic-mate-lead', phase: 'mid', world: 'fiction', mate: true, act: '被{mate}拉着往前跑', detail: '你没问为什么，跟着就跑，跑出两条街才停下。' },
  { id: 'mid-fic-mate-quiet', phase: 'mid', world: 'fiction', mate: true, act: '和{mate}坐着谁也没说话', detail: '路过的风把两个人的影子吹得晃来晃去。' },
  { id: 'mid-fic-mate-light', phase: 'mid', world: 'fiction', mate: true, act: '让{mate}挑走轻的那份', detail: '{mate}不肯，你硬塞过去，转身背起重的就走。' },

  // ── 穿越余韵（crossedOver 且 3 小时内）──
  { id: 'cross-explain', phase: 'mid', world: P, cross: true, need: ["folk"], act: '跟人解释自己是怎么来的', detail: '话说到一半你自己也觉得离谱，干脆不说了。' },
  { id: 'cross-mutter', phase: 'mid', world: P, cross: true, act: '边走边碎碎念"我怎么就到这儿了"', detail: '念了一路，念到自己都嫌烦。' },
  { id: 'cross-mate-eye', phase: 'mid', world: P, mate: true, cross: true, act: '被{mate}白了好几眼', detail: '你说一句"这地方真离谱"，{mate}就看一次你，来回三次。' },
  { id: 'cross-plan', phase: 'mid', world: P, cross: true, act: '盘算怎么回得去', detail: '一边走一边把能想到的办法挨个过了一遍，没一个靠谱。' },
  { id: 'cross-nobody', phase: 'mid', world: P, cross: true, need: ["folk"], act: '跟人说这不是我来的地方', detail: '对方一脸茫然，你才想起说了也白说。' },
  { id: 'cross-watch', phase: 'mid', world: P, cross: true, act: '反复看那块停了的表', detail: '指针不走了，你也不知道是该修还是该扔。' },
  { id: 'cross-planb', phase: 'mid', world: P, cross: true, act: '给自己安排了个回去的办法', detail: '写下来又划掉，觉得每一条都不太靠谱。' },
  { id: 'cross-askstranger', phase: 'mid', world: P, cross: true, need: ["folk"], act: '问路人认不认识我来的地方', detail: '对方摇头；你说得越多，他越往后退。' },
  { id: 'cross-mapmark', phase: 'mid', world: P, cross: true, act: '翻出地图找出发的地方', detail: '怎么找都找不到，好像那地方本来就不该在这儿。' },
  { id: 'cross-blame', phase: 'mid', world: P, cross: true, mate: true, act: '被{mate}埋怨了一路', detail: '你想反驳，想了想好像确实是。' },
  { id: 'cross-familiar', phase: 'mid', world: P, cross: true, act: '觉得眼前的景象有点眼熟', detail: '像在哪儿见过，又完全对不上，你站了很久。' },
  { id: 'cross-accept', phase: 'mid', world: P, cross: true, act: '决定先不管了', detail: '既然回不去，先把这趟走完再说；你拍了拍包，继续走。' },

  // ═══════════════════════════ 尾程（剩不到 2 小时）═══════════════════════════
  { id: 'leave-pack', phase: 'leave', world: P, act: '收拾行李', detail: '东西比来时多了不少，箱子压了两次才合上。' },
  { id: 'leave-last', phase: 'leave', world: P, act: '最后再逛一圈', detail: '没打算买什么，就是想把走过的地方再走一遍。' },
  { id: 'leave-gift', phase: 'leave', world: P, need: ["folk"], act: '挑带给别人的东西', detail: '在一家摊前站了很久，总觉得挑的这份不够好。' },
  { id: 'leave-sit', phase: 'leave', world: P, act: '坐在行李箱上发呆', detail: '走不动了，就这么坐着看来来往往的人。' },
  { id: 'leave-lookback', phase: 'leave', world: P, act: '回头多看两眼', detail: '这地方大概不会再来第二次了，你多看了两眼才转身。' },
  { id: 'leave-mate-list', phase: 'leave', world: P, mate: true, act: '和{mate}核对清单', detail: '两个人把东西摊了一地，一遍一遍数。' },
  { id: 'leave-eat-last', phase: 'leave', world: P, need: ["folk"], act: '把想吃的那家再吃一次', detail: '排了第二次队，吃完觉得这趟值了。' },
  { id: 'leave-tired', phase: 'leave', world: P, act: '找个台阶坐下歇着', detail: '真的走不动了，脚底板发烫，你也不太想动。' },
  { id: 'leave-photo', phase: 'leave', world: P, act: '补拍一张像样的照片', detail: '这趟手机里全是糊的，你非要再拍一张才肯走。' },
  { id: 'leave-window', phase: 'leave', world: P, act: '站在窗边看最后一眼', detail: '什么都没做，就想把这片景象记牢一点。' },
  { id: 'leave-cash', phase: 'leave', world: P, act: '把剩下的钱算了一遍', detail: '花不完也不换了，剩下的塞进包里当纪念。' },
  { id: 'leave-ticket', phase: 'leave', world: P, act: '确认返程的车次', detail: '对着票看了两遍，怕自己记错了日子。' },
  { id: 'leave-write', phase: 'leave', world: P, act: '给谁写了张明信片', detail: '写到一半不知道该怎么结尾，最后只写了"我挺好"。' },
  { id: 'leave-souvenir', phase: 'leave', world: P, need: ["folk"], act: '为带回去的东西挑半天', detail: '挑来挑去都觉得不够，最后买了两份一样的。' },
  { id: 'leave-sand', phase: 'leave', world: P, act: '脱下鞋抖沙子', detail: '抖出来一小堆，你对着它有点感慨。' },
  { id: 'leave-charge', phase: 'leave', world: P, need: ["folk"], act: '到处找插座充电', detail: '店里让充，你守着手机看它一格一格往上爬。' },
  { id: 'leave-return', phase: 'leave', world: P, need: ["folk"], act: '把借来的东西还回去', detail: '对方挥挥手说不必，你还是放在了门口。' },
  { id: 'leave-revisit', phase: 'leave', world: P, act: '绕回去又看了一次', detail: '明知道看过，还是想再看一眼才走。' },
  { id: 'leave-square', phase: 'leave', world: P, need: ["folk"], act: '坐在广场边发呆', detail: '鸽子在脚边转，你什么都不想干。' },
  { id: 'leave-shoot', phase: 'leave', world: P, need: ["folk"], act: '请人拍了张合影', detail: '第一张闭眼，第二张有人入镜，第三张勉强能用。' },
  { id: 'leave-throw', phase: 'leave', world: P, act: '嫌东西太多开始扔', detail: '扔了两样又捡回来一样，最后还是全带上了。' },
  { id: 'leave-goodbye', phase: 'leave', world: P, need: ["folk"], act: '跟认识的人打招呼告别', detail: '说了句"下次还来"，其实自己也知道多半不会。' },
  { id: 'leave-guestbook', phase: 'leave', world: P, need: ["folk"], act: '拿起笔在留言簿写几句', detail: '想写得漂亮点，最后只是简单签了个名。' },
  { id: 'leave-feet', phase: 'leave', world: P, need: ["water"], act: '泡了泡走了一天的脚', detail: '水是凉的也舒服，你就那么坐着不想起来。' },
  { id: 'leave-schedule', phase: 'leave', world: P, act: '反复看回家的时间', detail: '还有几个小时，你开始把东西一件件归拢。' },
  { id: 'leave-wind', phase: 'leave', world: P, act: '站门口吹了会儿风', detail: '上来下去的脚步声都听了一遍，才回去睡。' },
  { id: 'leave-snack', phase: 'leave', world: P, need: ["folk"], act: '买了点带在路上吃的东西', detail: '不知道好不好吃，反正路上要嚼点什么。' },
  { id: 'leave-thanks', phase: 'leave', world: P, need: ["folk"], act: '跟帮过自己的人道谢', detail: '对方一直摆手，你还是把话说完才走。' },
  { id: 'leave-things', phase: 'leave', world: P, thing: true, act: '还没决定要不要带{thing}', detail: '两样都想要，掂了半天分量，包实在塞不下。' },

  // ═══════════════════════════ 收尾（剩不到 40 分钟）═══════════════════════════
  { id: 'final-pack', phase: 'final', world: P, act: '收拾行李，准备回家', detail: '时间快到了，你手忙脚乱地往箱子里塞东西。' },
  { id: 'final-wait', phase: 'final', world: P, act: '蹲门口等回家的车', detail: '包放在脚边，你站一会儿坐一会儿，反复看时间。' },
  { id: 'final-check', phase: 'final', world: P, act: '最后检查有没有落下东西', detail: '桌角、床底都看过了，还是不放心地又看了一遍。' },
  { id: 'final-home', phase: 'final', world: P, act: '想家里那张床', detail: '人还没走，心已经回去了。' },
  { id: 'final-mate-go', phase: 'final', world: P, mate: true, act: '和{mate}一起往回走', detail: '两个人都没怎么说话，走得不快也不慢。' },
  { id: 'final-door', phase: 'final', world: P, act: '最后确认门锁上了', detail: '检查了两遍，走到楼下又回头看了一眼。' },
  { id: 'final-charge', phase: 'final', world: P, need: ["folk"], act: '把手机插上最后充一会儿', detail: '明知道充不满，还是插上了。' },
  { id: 'final-keys', phase: 'final', world: P, act: '伸手在口袋里摸钥匙', detail: '明明家里也有，还是习惯性摸了一下。' },
  { id: 'final-water', phase: 'final', world: P, act: '把剩下半瓶水灌下去', detail: '不想带着走，站着仰头喝完，打了个嗝。' },
  { id: 'final-look', phase: 'final', world: P, act: '出门前回头看了一圈', detail: '确认没落下什么，也像是跟这地方告了个别。' },
  { id: 'final-mate-hurry', phase: 'final', world: P, mate: true, act: '催{mate}快点', detail: '喊了三遍，{mate}还在那儿慢慢收东西。' },
  { id: 'final-mate-count', phase: 'final', world: P, mate: true, act: '和{mate}对了一遍行李', detail: '两个人数出来一模一样的东西，还是不敢走。' },
  { id: 'final-mate-bill', phase: 'final', world: P, mate: true, need: ["folk"], act: '和{mate}把账结了', detail: '算得有点乱，最后谁多出一点也就那样了。' },
  { id: 'final-msg', phase: 'final', world: P, act: '给家里回了句"快到了"', detail: '其实还有一会儿，但你想先让人安心。' },
  { id: 'final-seat', phase: 'final', world: P, act: '找个地方坐下等', detail: '箱子挡着脚，你换了好几个姿势都不舒服。' },
  { id: 'final-leftover', phase: 'final', world: P, act: '把没吃完的东西吃完', detail: '不太想吃了，扔了又可惜，还是嚼完了。' },
  { id: 'final-quiet', phase: 'final', world: P, act: '把该关的都关了', detail: '灯、窗、水，一个一个过，屋里安静得有点空。' },

  // ═══════════════════════════ 一个人出门时 ═══════════════════════════
  { id: 'solo-walk', phase: P, world: P, mate: false, act: '一个人慢慢地走', detail: '没人催，走几步停一停，觉得这样也挺好。' },
  { id: 'solo-sit', phase: P, world: P, mate: false, act: '一个人坐了很久', detail: '没人说话，你听着周围的动静，忽然觉得一个人出来也不错。' },
  { id: 'solo-talk', phase: P, world: P, mate: false, act: '心里跟自己说话', detail: '没人搭腔，你自己把话接了下去，接得还挺顺。' },
  { id: 'solo-photo', phase: P, world: P, mate: false, act: '举着手机自己拍', detail: '伸长手臂拍了几张，都是同一个角度，就这样吧。' },
  { id: 'solo-meal', phase: P, world: P, mate: false, need: ["folk"], act: '一个人吃完整桌', detail: '点了两样没吃完，剩下的打包带走。' },
  { id: 'solo-time', phase: P, world: P, mate: false, act: '看时间看了好几遍', detail: '没人催，反倒不知道该怎么安排。' },
  { id: 'solo-cross', phase: P, world: P, mate: false, act: '站在路口想了很久', detail: '哪边都行，又哪边都不想动，就这么站着。' },
  { id: 'solo-music', phase: P, world: P, mate: false, act: '塞上耳机继续走', detail: '不放歌，就戴着；外面安静一点。' },
  { id: 'solo-note', phase: P, world: P, mate: false, act: '坐在长椅上写了会儿东西', detail: '没写什么正经的，就是想到哪儿记到哪儿。' },
  { id: 'solo-small', phase: P, world: P, mate: false, need: ["folk"], act: '一个人进小馆子', detail: '坐在角落里，老板问了几个人，你说一位。' },
  { id: 'solo-shoot', phase: P, world: P, mate: false, need: ["folk"], act: '让人帮忙拍了张单人照', detail: '拍完道了谢，看照片的时候觉得自己有点孤单。' },
  { id: 'solo-msg', phase: P, world: P, mate: false, act: '给谁发了条消息没回', detail: '字打了一半又删了，最后什么都没发出去。' },

  // ═══════════════════════════ 旅伴专项（按 mateId 分）═══════════════════════════
  // ★ 用户 2026-10-12："加入根据旅伴变化的特殊互动，狐狸三条，其余旅伴两条。"
  //   键用 **id**（fox / gpt / claude / gemini）—— 改显示名不影响；
  //   `{mate}` 仍会被填成当前的显示名。这几条不带 phase/world 限制（路上聊到就有）。
  { id: 'mate-fox-tail', phase: P, world: P, mate: true, mateId: 'fox', act: '被{mate}的尾巴扫到脸', detail: '毛茸茸的，你打了个喷嚏，{mate}赶紧把尾巴收了回去。' },
  { id: 'mate-fox-nose', phase: P, world: P, mate: true, mateId: 'fox', act: '让{mate}帮忙闻味道', detail: '{mate}皱着眉闻了半天，说"别吃这个"，你听话地放下了。' },
  { id: 'mate-fox-shade', phase: P, world: P, mate: true, mateId: 'fox', act: '把{mate}的耳朵当遮阳板', detail: '被嫌弃地推开了，过一会儿{mate}又自己凑了回来。' },
  { id: 'mate-gpt-shade', phase: P, world: P, mate: true, mateId: 'gpt', act: '躲在{mate}的影子下乘凉', detail: '太阳毒，那片影子凉快得很，你赖着不肯走。' },
  { id: 'mate-gpt-glow', phase: P, world: P, mate: true, mateId: 'gpt', act: '看{mate}身上泛着光', detail: '在暗地方特别明显，你说好看，{mate}装作没听见。' },
  { id: 'mate-claude-read', phase: P, world: P, mate: true, mateId: 'claude', need: ["built"], act: '让{mate}念碑上的字', detail: '{mate}念得很慢，念到一半自己也糊涂了，干脆跳过。' },
  { id: 'mate-claude-note', phase: P, world: P, mate: true, mateId: 'claude', act: '看{mate}掏出本子记东西', detail: '写得密密麻麻，你凑过去看，被按住了本子。' },
  { id: 'mate-gemini-nap', phase: P, world: P, mate: true, mateId: 'gemini', act: '把{mate}从睡的地方抱起来', detail: '轻得离谱，{mate}睁开半只眼，又闭上了。' },
  { id: 'mate-gemini-sun', phase: P, world: P, mate: true, mateId: 'gemini', act: '和{mate}一起躺在太阳底下', detail: '{mate}懒得说话，你也懒得动，就这么晒了半天。' },
  // ★ 2026-10-13 加 grok（显示名「小魔王」）：绑她那把 X 形双刃巨斧和小獠牙。
  { id: 'mate-grok-axe', phase: P, world: P, mate: true, mateId: 'grok', act: '看{mate}单手转那把巨斧', detail: '斧子比她整个人还高，抡得呼呼响。你默默往后退了半步，她笑你怂。' },
  { id: 'mate-grok-fang', phase: P, world: P, mate: true, mateId: 'grok', act: '被{mate}龇牙凶了一下', detail: '露出两颗小尖牙，凶巴巴的，其实一点都不吓人——你没忍住笑了，她更气了。' },
  // ★ v3.0 加 kimi（显示名「小月亮」）：绑她那支长笛和身侧那轮月牙。
  { id: 'mate-kimi-flute', phase: P, world: P, mate: true, mateId: 'kimi', act: '听{mate}吹一段长笛', detail: '走得累了就在路边坐下，{mate}横过笛子吹了一小段；风把声音往远处带，你听着听着就不想动了。' },
  { id: 'mate-kimi-moon', phase: P, world: P, mate: true, mateId: 'kimi', act: '和{mate}一起看看月亮', detail: '{mate}说她那边也有一轮月牙；你顺着看过去——天上有，她头侧也挂着一枚。' },
  // ★ v3.0 加 qwen（显示名「小折扇」）：绑她那柄折扇和"什么都讲得出来"的毛病。
  { id: 'mate-qwen-fan', phase: P, world: P, mate: true, mateId: 'qwen', act: '借{mate}的扇子扇风', detail: '扇面上画着一丛花，扇起来有股纸墨味；{mate}看你热得厉害，干脆把扇子塞给你了。' },
  { id: 'mate-qwen-story', phase: P, world: P, mate: true, mateId: 'qwen', act: '听{mate}讲这地方的典故', detail: '她讲得头头是道，你听了一半才反应过来——这些多半是她现编的。' }
];

/**
 * ★★ 2026-10-15「旅途瞬间也影响心情」（用户口径："接集成系统的随机事件池也应该分类并
 *   一定程度地影响心情"）—— **条目级心情标注表**（按 `id` 查）。
 *
 * 刻意做成**独立的表**而不是往 352 条里逐条塞字段：好审、好改、加新条目时忘了标也只是
 * "这条不影响心情"，不会写错形状。绝大部分条目**刻意不标** —— 赶路、找路、排队这类
 * 中性瞬间不该推心情（"一定程度"的含义就在这儿）。
 *
 * 值 = 五维增量（happy / excited / sad / angry / jealous），可带 `satisfaction`；
 * 幅度纪律：|值| ≤ 4、满足感 ≤ 3 —— 比 `TRAVEL_EVENT_MOOD`（旅行事件 +5~14）**轻一档**，
 * 因为瞬间是"状态"不是"事件"，一天最多 20 多挡。
 */
export const TRAVEL_STATE_MOOD = {
  // ── 刚到 · 现实 ──
  'arr-real-breakfast': { happy: 3 },          // 端上来意外好吃
  'arr-real-landmark': { excited: 3 },         // 看见书里见过的东西
  'arr-real-tout': { angry: 2 },               // 被拉客的缠住
  'arr-real-weather': { sad: 2 },              // 被天气摆了一道
  'arr-real-cat': { happy: 3 },                // 被一只当地的猫跟着
  'arr-real-roommate': { happy: 2 },           // 最后一起笑了
  // ── 刚到 · 异世界 ──
  'arr-fic-sky': { excited: 3 },               // 打量这里的天空
  'arr-fic-kids': { happy: 3 },                // 被小孩围观，先做鬼脸
  'arr-fic-cut': { sad: 2 },                   // 胳膊上多了道口子
  'arr-fic-fire': { satisfaction: 2 },         // 凑到火边取暖
  'arr-fic-boom': { excited: 2 },              // 被闷响吓一跳
  // ── 路上 · 现实 ──
  'mid-real-stall': { happy: 2 },              // 蹲街边摊吃小吃
  'mid-real-sunset': { happy: 3, satisfaction: 2 },   // 看日落
  'mid-real-festival': { happy: 4, excited: 3 },      // 撞上本地节庆
  'mid-real-downpour': { angry: 2 },           // 淋了半场雨
  'mid-real-quietspot': { happy: 3, satisfaction: 2 },// 找到没人的地方（多待了一阵）
  'mid-real-invited': { happy: 3 },            // 被本地人请去坐坐
  'mid-real-busker': { happy: 2 },             // 被街头唱歌的吸住
  'mid-real-hotspring': { satisfaction: 3 },   // 泡了一次汤
  'mid-real-haircut': { sad: 2 },              // 剪得跟想象完全不一样
  'mid-real-bookstall': { happy: 2 },          // 旧书摊买一本当念想
  'mid-real-money-count': { sad: 2 },          // 算今天花了多少
  // ── 路上 · 现实 · 有旅伴 ──
  'mid-real-mate-rest': { happy: 3 },          // 把包挪给你垫着
  'mid-real-mate-argue': { angry: 3 },         // 为走哪条路拌嘴
  'mid-real-mate-nav': { angry: 3 },           // 为导航吵架
  'mid-real-mate-umbrella': { happy: 3 },      // 挤一把伞都湿了半边
  'mid-real-mate-shoulder': { happy: 3 },      // 让{mate}靠着睡
  'mid-real-mate-tease': { happy: 2 },         // 拿糗事开玩笑
  'mid-real-mate-skill': { angry: 2 },         // 被说拍照技术差
  'mid-real-mate-lastbite': { happy: 2 },      // 留了最后一口
  // ── 路上 · 异世界 ──
  'mid-fic-feast': { happy: 3 },               // 被请了一顿当地饭
  'mid-fic-gift': { excited: 2 },              // 被塞了样说不上来的东西
  'mid-fic-pet': { happy: 3 },                 // 摸了一只不认识的小兽
  'mid-fic-cliff': { excited: 2 },             // 手脚并用爬一段崖
  'mid-fic-water': { sad: 2 },                 // 渴得厉害才讨到水
  'mid-fic-locals': { sad: 2 },                // 被一圈人围着看
  // ── 路上 · 异世界 · 有旅伴 ──
  'mid-fic-mate-lap': { satisfaction: 2 },     // 趴在膝盖上打盹
  'mid-fic-mate-joke': { happy: 3 },           // 冷笑话一起笑场
  'mid-fic-mate-scared': { happy: 3 },         // 发抖被发现了，往这边挪了挪
  'mid-fic-mate-salve': { happy: 2 },          // 互相上药，下手都很轻
  // ── 尾程 ──
  'leave-last': { sad: 2 },                    // 最后再逛一圈
  'leave-eat-last': { happy: 3 },              // 吃完觉得这趟值了
  'leave-lookback': { sad: 2 },                // 回头多看两眼
  'leave-sand': { sad: 2 },                    // 对着抖出来的沙有点感慨
  'leave-write': { sad: 2 },                   // 明信片只写了"我挺好"
  'leave-feet': { satisfaction: 2 },           // 泡了泡走了一天的脚
  'leave-goodbye': { sad: 2 },                 // 说了句"下次还来"
  // ── 收尾 ──
  'final-home': { happy: 2 },                  // 想家里那张床
  'final-quiet': { sad: 2 },                   // 屋里安静得有点空
  // ── 一个人出门 ──
  'solo-sit': { happy: 2 },                    // 一个人出来也不错
  'solo-shoot': { sad: 3 },                    // 看照片觉得有点孤单
  'solo-msg': { sad: 2 },                      // 打了一半又删掉的消息
  // ── 旅伴专项 ──
  'mate-fox-shade': { happy: 3 },              // 耳朵当遮阳板，又自己凑回来
  'mate-gemini-nap': { happy: 3 },             // 把小猫咪抱起来
  'mate-grok-fang': { happy: 3 },              // 龇牙凶人，没忍住笑了
  'mate-kimi-flute': { satisfaction: 3 },      // 听长笛，不想动了
  'mate-kimi-moon': { happy: 3, excited: 2 }   // 头侧也挂着一枚月牙
};

/**
 * 这条旅途瞬间该不该动心情？（纯函数，只读。）
 * 来源只有两个：① 上表的条目级标注；② 两处**轻量推导**（`phase:'leave'`／异世界刚到——
 * 这两类是"状态惯性感"，旅行事件表没覆盖）。
 *
 * ★★ **刻意不按 `foe` / `cross` / `final` 推导**（研判时定下的）：这三个强信号**已经有旅行
 *   事件在结算**（`battle-card` ／ `crossover` ／ `trip-home`）—— 再按字段推一遍＝
 *   **同一场遭遇算两遍**。所以撞敌手的心情走明信片事件，不走在路上被追的每一挡。
 * @returns {object|null} 五维增量（可含 `satisfaction`），null = 这条不影响心情
 */
export function stateMoodOf(s) {
  const tagged = TRAVEL_STATE_MOOD[String(s?.id || '')];
  if (tagged && typeof tagged === 'object' && Object.keys(tagged).length) return { ...tagged };
  if (s?.phase === 'leave') return { happy: 2 };                                        // 踏上归途
  if (s?.phase === 'arrive' && s?.world === 'fiction' && !s?.cross) return { excited: 2 };  // 异世界初到
  return null;
}

/** 纯函数：FNV-1a，取一个稳定的 32 位哈希（同一 seed 永远同一结果）。 */
function hash32(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 旅程阶段。`final` = 剩不到 40 分钟（沿用原实现的"准备回家"口径）。 */
export function phaseOf(trip) {
  if (!trip) return 'mid';
  if (trip.leftMs <= 40 * 60000) return 'final';
  if (trip.leftMs <= 2 * 3600000) return 'leave';
  if (trip.elapsedMs < 2 * 3600000) return 'arrive';
  return 'mid';
}

/**
 * 地区类型。
 * 优先用 travel-whale 写进行程的 `regionFictional`（2026-10-12 起会写）；
 * 老存档没有该字段时**退回看有没有 `foe`** —— 现实地区从来不带敌手、异世界一定带，
 * 所以这个推断可靠（也比去读另一个技能的 `regions.json` 稳：那是安装路径，会变）。
 */
export function worldOf(trip) {
  if (!trip) return 'real';
  if (trip.fictional === true) return 'fiction';
  if (trip.fictional === false) return 'real';
  return trip.foe ? 'fiction' : 'real';
}

/** **已寄过明信片的**景点 = 确实去过的（`spots[i]` 与 `cardPlan[i]` 同序）。
 *  travel-sync 会在 `tripOf()` 里算好并带上 `visitedSpots`（它能看到完整的 spots 数组）；
 *  没带就自己从 spots + cardsSent 推（单测会直接喂裸 trip）。 */
export function visitedSpotsOf(trip) {
  if (Array.isArray(trip?.visitedSpots)) {
    return trip.visitedSpots.map((x) => String(x || '')).filter(Boolean);
  }
  const spots = Array.isArray(trip?.spots) ? trip.spots : [];
  const sent = Math.max(0, Number(trip?.cardsSent) || 0);
  return spots.slice(0, Math.min(sent, spots.length)).map((s) => String((s && s.name) || '')).filter(Boolean);
}

/** 本趟敌手是不是**机械型**（机动战士/发条机关 ⇒ 走"黑入系统"那套）。
 *  由 travel-whale 出发时查表写死（`trip.foeKind === 'machine'`）；老存档没有 ⇒ false。 */
export function foeIsMachine(trip) {
  return String(trip?.foeKind || '') === 'machine';
}

/**
 * 允许的地点特征名（与 travel-whale/data/place-traits.json 的 vocabulary 一致）。
 * ★ 2026-10-13 加 `built`：原先 `folk` 被**当成了两种意思用** ——
 *   ① "有人可打交道"（小孩/集市/当地人/酒馆/城门登记）；② "有人工造物"（石碑/废墟/窄楼梯/灯柱/招牌）。
 *   这俩不是一回事：**幻想乡的博丽神社没有市井，但有石阶、鸟居、石灯笼** ——
 *   把 ② 也挂在 `folk` 上，等于把"对着一块石碑发愣"这类**荒野里完全成立**的条目一起封掉了。
 */
export const TRAIT_IDS = ['water', 'green', 'folk', 'built'];

/**
 * 本趟**缺**哪些特征（`trip.missingTraits`，由 travel-whale 查表写死）。
 * 老存档没有该字段 ⇒ 空集 ⇒ 全部条目都放行（行为与加这个字段之前一致）。
 */
export function missingSetOf(trip) {
  const raw = Array.isArray(trip?.missingTraits) ? trip.missingTraits : [];
  return new Set(raw.map((x) => String(x)).filter((x) => TRAIT_IDS.includes(x)));
}

/** 一条条目要求哪些特征（`need` 可写单个字符串，也可写数组）；没写就是"什么都不要求"。 */
function needsOf(s) {
  const raw = s && s.need;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((x) => String(x));
}

function eligible(s, ctx) {
  if (s.phase !== P && s.phase !== ctx.phase) {
    // 收尾档（final）允许用尾程（leave）的条目兜底
    if (!(ctx.phase === 'final' && s.phase === 'leave')) return false;
  }
  if (s.world !== P && s.world !== ctx.world) return false;
  if (s.mate === true && !ctx.mate) return false;
  if (s.mate === false && ctx.mate) return false;
  // 旅伴专项：绑了 mateId 的条目只对该伙伴开放（用 id，不受改显示名影响）
  if (s.mateId && s.mateId !== ctx.mateId) return false;
  if (s.foe === true && !ctx.hasFoe) return false;
  // 敌手两套：'machine' 只给机械型；'organic' 只给非机械 —— 留空则两者都吃
  if (s.foeKind === 'machine' && !ctx.foeMachine) return false;
  if (s.foeKind === 'organic' && ctx.foeMachine) return false;
  if (s.cross === true && !ctx.cross) return false;
  if (s.spot === true && !ctx.visited.length) return false;
  if (s.thing === true && !ctx.things.length) return false;
  // ★ 地点特征（2026-10-12）：条目**要求**的东西，这地方得真有。
  //   查尔（虫巢星球）没有河海、没有植被、也没有本地人 ⇒ 所有带 need 的条目一律不进候选。
  for (const n of needsOf(s)) {
    if (ctx.missing.has(n)) return false;
  }
  return true;
}

function fill(text, ctx, rnd) {
  return String(text ?? '')
    .replace(/\{mate\}/g, ctx.mate || '同伴')
    .replace(/\{foe\}/g, ctx.foe || '那东西')
    .replace(/\{spot\}/g, ctx.visited.length ? ctx.visited[rnd % ctx.visited.length] : '')
    .replace(/\{thing\}/g, ctx.things.length ? ctx.things[rnd % ctx.things.length] : '沿途的东西')
    .replace(/\{city\}/g, ctx.city || '这里')
    .replace(/\{country\}/g, ctx.country || '这里');
}

/**
 * 抽一条"此刻"状态。
 *
 * @param {object} trip travel-sync.tripOf() 的返回值
 * @param {number} [now]
 * @param {number} [bucketMs] 覆盖换挡间隔（测试用）
 * @returns {null | {id, act, detail, phase, world, place, bucket}}
 */
export function pickState(trip, now = Date.now(), bucketMs = BUCKET_MS) {
  if (!trip) return null;
  const phase = phaseOf(trip);
  const world = worldOf(trip);
  const ctx = {
    phase,
    world,
    mate: String(trip.companionName || '').trim(),
    // 伙伴 id（旅伴专项用）；老存档没写 companionName 时照样能靠 id 抽到专属于它的条目
    mateId: String(trip.companion || '').trim(),
    hasFoe: Boolean(String(trip.foe || '').trim()),
    foe: String(trip.foe || '').trim(),
    foeMachine: foeIsMachine(trip),
    // ★ 地点特征（2026-10-12）：本趟缺哪些（water/green/folk）—— 带 need 的条目会被筛掉
    missing: missingSetOf(trip),
    visited: visitedSpotsOf(trip),
    things: (Array.isArray(trip.souvenirs) ? trip.souvenirs : [])
      .map((s) => String((s && s.name) || '').trim()).filter(Boolean),
    city: String(trip.city || ''),
    country: String(trip.country || ''),
    cross: Boolean(trip.crossedOver) && Number(trip.elapsedMs || 0) < CROSS_WINDOW_MS
  };

  let pool = TRAVEL_STATES.filter((s) => eligible(s, ctx));
  // 兜底：一条都不匹配（例如老存档既没 foe 又没景点，或目的地穷山恶水）→ 退回最不挑条件的通用条目
  //   ⚠️ 兜底池也必须排除 `need` 条目，否则"查尔"会在没得选时又说出河海。
  if (!pool.length) {
    pool = TRAVEL_STATES.filter((s) => s.phase === P && s.world === P
      && !s.mate && !s.mateId && !s.foe && !s.cross && !s.spot && !s.thing && !s.need);
  }
  if (!pool.length) return null;

  // ★ 稳定抽取：同一 (会话, 出发时刻, 换挡序号) 永远同一结果 —— 面板不抖、提示词不乱。
  const bucket = Math.floor(now / Math.max(60000, Number(bucketMs) || BUCKET_MS));
  const seed = `${trip.chatKey || ''}|${trip.departAt || 0}|${bucket}|${phase}|${world}`;
  const h = hash32(seed);
  const chosen = pool[h % pool.length];
  const h2 = hash32(`${seed}|slots`);
  return {
    id: chosen.id,
    act: fill(chosen.act, ctx, h2).trim(),
    detail: fill(chosen.detail, ctx, h2).trim(),
    phase,
    world,
    place: [trip.country, trip.city].filter(Boolean).join('·'),
    bucket
  };
}

/** 池子规模（自检/UI 用）。 */
export function poolSize() {
  return TRAVEL_STATES.length;
}

/** 旅伴专项条目数（自检用）：按 mateId 分组。 */
export function companionStateCounts() {
  const out = {};
  for (const s of TRAVEL_STATES) {
    if (!s.mateId) continue;
    out[s.mateId] = (out[s.mateId] || 0) + 1;
  }
  return out;
}
