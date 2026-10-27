// 矩阵庭院（travel-whale）· 模块化组件：core/skills-appointments.js
// 职责：世界技能树、旅伴专属技能、帮助图数据装配与回家换人预约

import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as TI from '../titles.js';
import { titleCtx } from './runtime-deps.js';
import { companionOf } from './companions-voice.js';
import { appendExtraCard } from './mood-battle-events.js';
import { awaySideTripOf, isRegionUnlocked, visibleRegionIds, visibleSkills } from './world-sync.js';
import { BUY_MAX_PER_ORDER, EXPRESS_PRICE, REFRESH_PRICE } from './shop-album-menu.js';
import { isFarmHelper } from './pantry-farm.js';

// ══════════════════════════════════════════════════════════════════════════
// ★★ 技能树（2026-10-13 试点：4 支 / 8 条）
//
// 用户定的结构：**每个世界 = 1 条「带数值」的技能 + 1 条「纯风味」技能**。
//   · 数值半：学了就常驻，**不参与发动竞争**（保底 —— 纯风味"没触发就等于没有"）
//   · 风味半：构图 或 感言，**每张明信片全局只发动 1 项**（用户："实际发动的只能有一项"）
//   一条技能**可以同时**有数值半和风味半（用户："可以【数值+构图】这种"）。
//
// 门槛：`visit` = 她本人去过该世界；`souvenir` 再加"**手上还有**该世界任意特产"；
//       `rare` 再加"**手上还有**该世界的★稀有特产"。
// ★★ 2026-10-14（用户口径修正）：原来是"图鉴里有就行、**不被消耗**"，用户判定那是 bug ——
//   现在**按存量判定、并且每学一次真的扣掉 1 件**（扣哪一件见 `souvenirWorlds()` 的 `pick`）。
//   ⚠️ 连带后果是真实的：把某个世界的特产全吃光/送光之后，**那个世界的技能就暂时学不了**，
//      要再带一件回来、或者种一棵出来（`skillGate()` 的失败提示会这么讲）。
// ⚠️ 特产条目**没有 regionId** ⇒ 用 `visitedCities[cityKey(country, city)].region` 反查归属。
//    闲置伙伴"自己去玩"带回的特产**不进 visitedCities** ⇒ 反查不到 ⇒ **不算她去过**
//    （与"在庭院＝她本人没出远门"同一条口径，**刻意如此**）。
// ══════════════════════════════════════════════════════════════════════════
export const SKILLS = [
  { id: 'raven-post', region: 'middleearth', name: '渡鸦信使', emoji: '🪶', needs: 'souvenir', price: 8000,
    numeric: true, effect: '这趟多寄 1 张明信片',
    desc: '跟渡鸦打好交道 —— 多出来的那一张也会被捎出去' },
  { id: 'elf-sight', region: 'middleearth', name: '精灵视界', emoji: '🍃', needs: 'visit', price: 3000,
    effect: '她学会了精灵的眼力 —— 站得越久，越看得见从前',
    desc: '精灵的眼睛记得古老的事 —— 她会写出这地方三百年前是什么样',
    note: '你看得见"时间" —— 写景时带出这地方**从前**的样子（例："这堵墙看着是新砌的，可在精灵的歌里它已经站了三千年"）。' },
  { id: 'data-shield', region: 'warhammer40k', name: '数据护盾', emoji: '🛡️', needs: 'rare', price: 15000,
    numeric: true, battle: true, fusion: 'shield',
    effect: '战斗那张浮起六边形数据光盾；异世界那些趟的明信片稀有率 +0.05',
    desc: '从机械神教那儿学来的 —— 一层数据凝成的光盾，挡得住，也捡得到',
    note: '你身上罩着一层数据护盾 —— 感想里可以提一句它挡下了什么（例："那玩意儿砸上来的时候，盾面碎成一片像素"）。' },
  { id: 'machine-prayer', region: 'warhammer40k', name: '机魂祝祷', emoji: '⚙️', needs: 'visit', price: 3000,
    effect: '她受了机械神教的涂油礼 —— 会跟那些铁疙瘩打招呼了',
    desc: '她开始对着相机、装备和服务器说话 —— 据说机魂听得见',
    note: '你学会了跟机械说话 —— 感想里对着相机、装备或服务器嘟囔一两句（像跟老朋友讲话，别写成诗）。' },
  { id: 'danmaku-drop', region: 'touhou', name: '弹幕掉落', emoji: '🎴', needs: 'rare', price: 15000,
    numeric: true, battle: true, fusion: 'danmaku',
    effect: '战斗那张背景是满屏弹幕；这趟更容易带回稀有特产',
    desc: '弹幕散去之后，地上总会掉点好东西',
    note: '你打起来是满屏弹幕的架势 —— 感想里可以提一句弹幕散去之后地上掉了什么。' },
  { id: 'spell-declare', region: 'touhou', name: '符卡宣言', emoji: '✨', needs: 'visit', price: 3000,
    effect: '她学会了幻想乡的规矩 —— 打之前先给自己这一招起个名字',
    desc: '从幻想乡学来的规矩 —— 动手之前先报招式名',
    note: '你会先报招式名再动手 —— 感想里给刚才这一下起一个**符卡名**并报出来（例：「鲸符『一头撞进去』」），把这张明信片说成打完一局掉下来的符卡。' },
  { id: 'bag-of-holding', region: 'faerun', name: '空间袋', emoji: '🎒', needs: 'souvenir', price: 8000,
    numeric: true, effect: '这趟多带 1 件特产',
    desc: '看着是个小布包，装得下一整趟的收获' },
  { id: 'counter-spell', region: 'faerun', name: '法术反制', emoji: '📜', needs: 'visit', price: 3000,
    effect: '她学会了掐咒 —— 敌手法术还没成型，就散了',
    desc: '对方抬手的那一瞬间，她已经把咒语掐掉了',
    note: '你对付法术型的敌手有自己的一套 —— 感想里写你怎么在对方抬手的那一瞬间把咒语掐掉（就写这一句，别开技能讲座）。' },

  // ══════════════════════════════════════════════════════════════════════
  // ★★ 2026-10-13 晚（用户："把剩下那批技能做完再重启"）：按定稿表把**剩下 8 个世界**补齐。
  //   结构口径不变：**每个世界 = 1 条带数值的 + 1 条纯风味**（风味"没触发就等于没有"，
  //   所以每个世界必须有一条常驻的数值半，见 MEMORY-2 §69⑧）。
  //   价格台阶沿用试点：访问门槛 3000 / 带特产门槛 8000 / ★稀有门槛 15000。
  // ══════════════════════════════════════════════════════════════════════
  { id: 'iron-debt', region: 'westeros', name: '有债必偿', emoji: '⚖️', needs: 'rare', price: 15000,
    numeric: true, effect: '稀有收获的 TOKEN 奖励 ×3（+50/+20 → +150/+60）',
    desc: '兰尼斯特家的规矩 —— 该给的一分不少，给起来也格外多' },
  { id: 'night-watch', region: 'westeros', name: '长夜守望', emoji: '🕯️', needs: 'visit', price: 3000,
    effect: '她受过守夜人的夜哨训练 —— 夜里睡得浅、耳朵灵',
    desc: '守过夜的人才有的习惯 —— 睡前总要看一眼门外',
    note: '你在长夜里守过 —— 感想里可以带一句"夜里没敢睡太沉""留心着外头的动静"（落点别写成恐怖，就是个习惯）。' },
  { id: 'wind-glider', region: 'teyvat', name: '风之翼', emoji: '🪂', needs: 'souvenir', price: 8000,
    numeric: true, effect: '这趟多逛 1 个景点（2 → 3）',
    desc: '借风滑一段 —— 落脚的地方多了，能逛的地方自然也多了' },
  { id: 'element-sight', region: 'teyvat', name: '元素视野', emoji: '👁️', needs: 'visit', price: 3000,
    effect: '她学会了元素视野 —— 地上留过什么，她一眼就看得见',
    desc: '开启元素视野 —— 痕迹会亮起来，告诉你刚才有谁经过',
    note: '你能看见"痕迹" —— 感想里写一处痕迹、并推出刚才发生过什么（例："草叶全倒向一边，一刻钟前有人从这儿跑过去"）。**只写刚发生的事**，别写成"这里从前怎样"（那是精灵视界那条）。' },
  { id: 'totem-ward', region: 'azeroth', name: '图腾护佑', emoji: '🗿', needs: 'rare', price: 15000,
    numeric: true, fusion: 'totem',
    effect: '她路上立起一根小图腾；护身符不再被消耗（一直有效）',
    desc: '插下一根图腾 —— 它替你挡着，护身符就能一直戴在身上',
    note: '你路上立了根图腾 —— 感想里可以提一句它插在哪儿、替你挡了什么。' },
  { id: 'ancestor-whisper', region: 'azeroth', name: '先祖低语', emoji: '🌫️', needs: 'visit', price: 3000,
    effect: '她跟萨满学了几天 —— 偶尔对着风、土、火说两句',
    desc: '元素与祖先会在耳边说话 —— 她开始学着回两句',
    note: '你偶尔会冒出萨满式的说法（对元素、对祖先说一两句），**一两句就够**，别整段念咒。' },
  { id: 'sheikah-nav', region: 'hyrule', name: '希卡导航', emoji: '📷', needs: 'souvenir', price: 8000,
    numeric: true, fusion: 'sheikah',
    effect: '照片带希卡石板质感；第一张明信片来得更早（8 小时 → 4 小时）',
    desc: '石板的取景框一亮 —— 拍下来，顺手也把路记下来了' },
  { id: 'paraglide', region: 'hyrule', name: '滑翔伞', emoji: '🪁', needs: 'visit', price: 3000,
    effect: '她学会了滑翔伞 —— 风托着往下滑，比走路痛快',
    desc: '背上滑翔伞 —— 下山不必再绕路',
    note: '你带着滑翔伞 —— 感想里可以写"从高处滑下来""借着风往下飘了一段"。' },
  { id: 'warp-trail', region: 'starcraft', name: '折跃残影', emoji: '💠', needs: 'rare', price: 15000,
    numeric: true, fusion: 'warp',
    effect: '身边留一圈折跃光；这趟旅程缩短 20%（更常回家）',
    desc: '折跃的余波还挂在空气里 —— 路也就短了一截' },
  { id: 'ghost-agent', region: 'starcraft', name: '幽灵特工', emoji: '🎯', needs: 'visit', price: 3000,
    effect: '她进行了幽灵特工特训 —— 动手之前先想怎么绕过去',
    desc: '从幽灵特工那儿学的 —— 能不动手就不动手',
    note: '你不写硬碰硬 —— 感想里写你怎么绕过去、怎么把痕迹抹掉（像特工那样悄悄过去）。' },
  { id: 'supply-ship', region: 'gundam', name: '补给舰', emoji: '🚀', needs: 'souvenir', price: 8000,
    numeric: true, effect: '单次进货上限 10 → 20',
    desc: '有补给舰跟着 —— 一次能多搬一倍的饭' },
  { id: 'funnel', region: 'gundam', name: '浮游炮协同', emoji: '🛰️', needs: 'visit', price: 3000,
    fusion: 'funnel',
    effect: '她学会了操控浮游炮 —— 她指哪儿，它们打哪儿',
    desc: '几枚小浮游炮跟着她 —— 像随身带了一小队护卫' },
  { id: 'grace-site', region: 'landsbetween', name: '赐福点', emoji: '✨', needs: 'souvenir', price: 8000,
    numeric: true, effect: '刷新货架的价格 1000 → 500 亿 TOKEN',
    desc: '在赐福点歇一下 —— 补货的手续费也跟着便宜了一半' },
  { id: 'ash-summon', region: 'landsbetween', name: '骨灰召唤', emoji: '⚱️', needs: 'visit', price: 3000,
    effect: '她学会了骨灰召唤 —— 打不过的时候，有人替她上',
    desc: '骨灰里还留着旧日的战力 —— 忙不过来时叫一下',
    note: '打完之后你想起刚才召来了一个帮手 —— 感想里提一句它是谁、帮了什么忙（别喧宾夺主）。' },
  { id: 'fate-chance', region: 'mysteries', name: '命运的偶然', emoji: '🎲', needs: 'rare', price: 15000,
    numeric: true,
    effect: '更容易"穿越"到还没解锁的世界（也更容易解锁新技能树）',
    desc: '命运不属于你 —— 但你能听见它的脚步声，提前站到路口' },
  { id: 'role-play', region: 'mysteries', name: '扮演法', emoji: '🎭', needs: 'visit', price: 3000,
    effect: '她掌握了扮演法的精髓 —— 说出口之前，先成为那个人',
    desc: '消化魔药的办法 —— 先成为那个人，再开口说话',
    note: '你用"扮演法"写这张明信片 —— 先点明你在扮演谁（例："这会儿我是那个守着渡口的老人"），再按那个身份的口吻写感想。' },
  // ══ v3.0（2026-10-14）：明日方舟 / 仙剑奇侠传 / 赛博朋克 2077 —— 每个世界仍是"1 数值 + 1 风味" ══
  { id: 'originium-haste', region: 'arknights', name: '源石技艺·急行', emoji: '🪨', needs: 'souvenir', price: 8000,
    numeric: true,
    effect: '单趟旅程缩短 10%（与其它"缩短旅程"的技能叠加）',
    desc: '源石技艺里最不体面的一种 —— 把术式全用在自己腿上',
    note: '赶路时腿上浮着一层淡淡的源石微光 —— 感想里可以提一句"今天走得比平常快"（别写成瞬移、也别写成飞）。' },
  { id: 'tactical-command', region: 'arknights', name: '战术指挥', emoji: '📐', needs: 'visit', price: 3000,
    effect: '她学会了摆阵型 —— 动手之前先把人和位置都想好了',
    desc: '从罗德岛的作战简报里学来的 —— 先摆阵，再动手',
    note: '你出手像在做战术部署 —— 感想里点一下"谁站哪儿、从哪边包过去"，但别写成战报、别喊口号。' },
  { id: 'sword-flight', region: 'pal', name: '御剑术', emoji: '🗡️', needs: 'souvenir', price: 8000,
    numeric: true,
    effect: '单趟旅程缩短 10%（与其它"缩短旅程"的技能叠加）',
    desc: '蜀山最基础的一课 —— 剑在脚下，路就成了直线',
    note: '你会御剑赶路 —— 感想里提一句"踩在剑上飞了一段"，写得轻快些，别写成打斗。' },
  { id: 'five-elements', region: 'pal', name: '五灵法术', emoji: '🌀', needs: 'visit', price: 3000,
    effect: '她学过五灵法术 —— 抬手就是一记水火雷风土',
    desc: '水、火、雷、风、土 —— 五样都记住了一点点',
    note: '你学过五灵法术 —— 感想里可以按场合点一样出来用（水 / 火 / 雷 / 风 / 土），**一次只写一样**，别报菜名。' },
  { id: 'cyberware', region: 'nightcity', name: '义体强化', emoji: '🦾', needs: 'rare', price: 15000,
    numeric: true,
    effect: '这趟多寄 1 张明信片（与渡鸦信使可叠加）',
    desc: '换了一身不显眼的义体 —— 手稳、眼快，照片也多拍两张',
    note: '你的手臂和眼睛换成了义体 —— 感想里可以提一句"手不抖了""夜视看得清"，但别写成机械改造清单。' },
  { id: 'overclock', region: 'nightcity', name: '超频', emoji: '⚡', needs: 'visit', price: 3000,
    effect: '她学会了超频 —— 反应比刚才快那么一点',
    desc: '把心跳借给机器用一会儿 —— 之后要还的',
    note: '你学会了超频 —— 感想里写"一下子什么都变慢了"的那种感觉，收尾记得提一句过后有点累。' }
];

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-10-13 旅伴养成（设计稿 §4）：每位旅伴 1 条技能
//
// 结构口径与鲸鱼那条一致：**每人都有一条"实底"**；小白龙是唯一例外（纯风味）——
//   因为她自己的特色（张数 +100%、稀有 ×3）本身就是一份很强的数值（设计稿里写明了）。
// 门槛 = **陪你走过 N 个异世界**（记在 `state.whale.companionWorlds[伙伴id]`，到达时记）。
// 定价 = 4000 亿 TOKEN，**不设特产门槛**（特产留给鲸鱼那条主线）。
//
// ⚠️ 没学过 ⇒ 每一条分支都不生效 ⇒ **逐字节等于从前**（不是"近似"）。
// ══════════════════════════════════════════════════════════════════════════
export const COMPANION_SKILLS = [
  { id: 'gatecrash', companion: 'fox', name: '不请自来', emoji: '🦊', needWorlds: 2, price: 4000,
    bonusTokens: 300,
    effect: '「免费鸡蛋」从每天 500 亿 TOKEN 涨到 800 亿 TOKEN',
    desc: '她本来就不请自来 —— 蹭饭蹭惯了，顺手把额度也蹭上去了' },
  { id: 'dragon-tongue', companion: 'gpt', name: '龙语', emoji: '🐉', needWorlds: 3, price: 4000,
    flavor: true,
    effect: '她学会了龙语 —— 生气时会吼一句，不给你翻译',
    desc: '生气时她会换一种语言说话 —— 听不懂，但很帅',
    note: '你同行的那位在交手的那一刻低低吼了一句**龙语**（你一个字也听不懂，只觉得后颈发麻）—— 把这一下写进感想里，别翻译它。' },
  { id: 'well-read', companion: 'claude', name: '博览群书', emoji: '📖', needWorlds: 2, price: 4000,
    effect: '题字上限 20 → 30 字（她更啰嗦了）',
    desc: '书读得多了，题字也想多写两行 —— 拦不住' },
  { id: 'cat-step', companion: 'gemini', name: '猫步', emoji: '🐱', needWorlds: 2, price: 4000,
    effect: '「量大管饱」的稀有惩罚减半（×0.5 → ×0.75）',
    desc: '踩得够轻，就不会把稀罕东西吓跑' },
  // ★★ v3.0（2026-10-14）两位新旅伴的养成
  { id: 'transcribe', companion: 'kimi', name: '誊录', emoji: '🎼', needWorlds: 2, price: 4000,
    effect: '题字上限 20 → 28 字（她替你把路过的每一句都记下来了）',
    desc: '她一路都在记 —— 记着记着，你的题字也想多写两行了' },
  { id: 'quote-classics', companion: 'qwen', name: '引经', emoji: '📜', needWorlds: 3, price: 4000,
    effect: '这趟多逛 1 个景点（2 → 3，与提瓦特「风之翼」可叠加）',
    desc: '她认得路，也认得这地方该看什么 —— 跟着她走，总多瞧见一处' },
  { id: 'provoke', companion: 'grok', name: '挑衅', emoji: '😈', needWorlds: 3, price: 4000,
    effect: '异世界惹事时，战斗明信片 1 张 → 2 张',
    desc: '她惹事从来不止一次 —— 反正你也没指望她消停' }
];

/** 「弹幕掉落」让这趟更容易带回稀有特产的概率（仍遵守既有的"一趟最多 1 件稀有"）。 */
export const SKILL_SOUVENIR_RARE_CHANCE = 0.5;

export const skillOwned = (st) => (st?.whale?.skills && typeof st.whale.skills === 'object' ? st.whale.skills : {});

/** 她本人去过哪些世界（`visitedCities` 的 region 去重；若为晋升后的子大区如 azeroth_ek，同步映射回父世界 azeroth）。 */
export const skillVisitedRegions = (st) => {
  const out = new Set();
  for (const v of Object.values(st?.visitedCities || {})) {
    const rid = String(v?.region || '').trim();
    if (!rid) continue;
    out.add(rid);
    try {
      const pid = T.regionById(rid)?.parentWorldId;
      if (pid) out.add(String(pid));
    } catch { /* ignore */ }
  }
  return out;
};

/**
 * regionId -> { any, rare, pick }：这个世界的特产**她手上还剩几件**（靠 visitedCities 反查归属）。
 *
 * ★★ 2026-10-14（用户口径修正）：原来这里只看"**图鉴里有没有条目**"，于是
 *   **吃光 / 送光 / 种下去之后照样能学技能** —— 用户判定这是 bug（"判定【有】特产即可"）。
 *   现在一律要求 **存量 ≥ 1**（`S.souvenirStock`），并且顺手把"真学的时候会扣掉哪一件"
 *   一并算出来（`pick`）—— 让 `skillGate()` 与 `learnSkill()` 共用**同一处**挑件口径，不会分叉。
 *
 * 挑哪一件（`pick`）：**先花不稀有的**（common → uncommon → rare），同档取**存量最多**的那件。
 *   这是玩家的直觉：学技能先消耗普通货，把稀有留到最后 ——
 *   稀有只会被 `needs: 'rare'` 的技能花掉（那种技能本来就是要它的）。
 *
 * ⚠️ 语义：`any` = "该世界**任意**一件特产（**稀有也算**）"；`rare` = "其中至少一件是稀有的"。
 *   两条彼此独立：**普通货用光、稀有还在 ⇒ 两条都仍成立**（探针里断言过这条，
 *   第一版我把它理解窄了、以为 any 会跟着 false）。
 */
export function souvenirWorlds(st) {
  const vc = st?.visitedCities || {};
  const key = (typeof S.cityKey === 'function') ? S.cityKey
    : ((country, city) => (String(country || '').trim()
      ? `${String(country).trim()}·${String(city || '').trim()}` : String(city || '').trim()));
  const RANK = { common: 0, uncommon: 1, rare: 2 };
  const rankOf = (e) => RANK[String(e?.rarity || 'common')] ?? 0;
  const out = {};
  for (const s of Object.values(st?.souvenirs || {})) {
    const reg = String(vc[key(s?.country, s?.city)]?.region || '');
    if (!reg) continue;
    if (S.souvenirStock(s) < 1) continue;          // ★ 手上没有 ⇒ 不算数（这次修正的正是这里）
    const regs = [reg];
    try {
      const pid = T.regionById(reg)?.parentWorldId;
      if (pid && !regs.includes(String(pid))) regs.push(String(pid));
    } catch { /* ignore */ }
    for (const rKey of regs) {
      const o = out[rKey] || (out[rKey] = { any: false, rare: false, pick: null });
      o.any = true;
      if (String(s?.rarity || '') === 'rare') o.rare = true;
      const cur = o.pick;
      if (!cur
        || rankOf(s) < rankOf(cur)
        || (rankOf(s) === rankOf(cur) && S.souvenirStock(s) > S.souvenirStock(cur))) {
        o.pick = s;
      }
    }
  }
  return out;
}

export const regionNameOf = (id) => { try { return T.regionById(String(id))?.name || String(id); } catch { return String(id); } };

/** 能不能学 ⇒ {ok, reason}。 */
export function skillGate(st, sk) {
  if (!sk) return { ok: false, reason: '没有这个技能' };
  if (skillOwned(st)[sk.id]) return { ok: false, reason: `「${sk.name}」她已经会了` };
  const rname = regionNameOf(sk.region);
  if (!skillVisitedRegions(st).has(sk.region)) {
    return { ok: false, reason: `她还没去过【${rname}】—— 技能得在那边学过才拿得到（去过一次就行）` };
  }
  const w = souvenirWorlds(st)[sk.region] || { any: false, rare: false };
  if (sk.needs === 'souvenir' && !w.any) {
    return { ok: false, reason: `还差点东西：【${rname}】的特产她手上一件都没有了`
      + `（学一次要**消耗 1 件**）—— 得再带一件回来，或者种一棵出来` };
  }
  if (sk.needs === 'rare' && !w.rare) {
    return { ok: false, reason: `还差点东西：【${rname}】的**稀有**特产她手上没有了`
      + `（学一次要**消耗 1 件**）—— 得再带一件回来` };
  }
  const money = Number(st?.wallet?.plankton) || 0;
  if (money < sk.price) {
    return { ok: false, reason: `TOKEN 不够：学「${sk.name}」要 ${sk.price} 亿，现在有 ${money} 亿` };
  }
  return { ok: true };
}

/**
 * 学一条技能：**扣 TOKEN ＋ 消耗 1 件该世界的特产**。调用方负责 saveState。
 *
 * ★★ 2026-10-14（用户口径修正）：原来是"只扣 TOKEN、特产只当门槛"，用户判定那是 bug。
 *   要扣哪一件由 `souvenirWorlds()` 现算（`pick`：先花不稀有的、同档取存量最多的），
 *   ⇒ 挑件口径只有一处，不会和 `skillGate()` 分叉。这里只负责扣。
 *   扣掉的名字放在返回值 `used` 里，供调用方在播报里写清楚（"用掉了 1 件「宇治抹茶制品」"）。
 */
export function learnSkill(st, sk) {
  const g = skillGate(st, sk);
  if (!g.ok) return g;
  const pick = souvenirWorlds(st)[sk.region]?.pick || null;
  let used = '';
  if (pick) {
    const c = S.consumeSouvenir(st, pick.name, 1);
    if (c.ok) used = pick.name;
  }
  st.wallet.plankton = (Number(st.wallet?.plankton) || 0) - sk.price;
  st.whale = st.whale || {};
  st.whale.skills = { ...skillOwned(st), [sk.id]: { at: Date.now() } };
  return { ok: true, reason: `学会了「${sk.name}」`, used };
}

// ── ★★ 2026-10-13 旅伴养成：读法 / 门槛 / 学习 ─────────────────────────────
//   ⚠️ 全部**防御式读取**：`state.whale.companionWorlds` 是这一版才有的字段，
//      老存档没有 ⇒ 空对象（= 一个异世界都没陪过），不会报错。

/** 旅伴技能学会了哪些（id -> {at}）。 */
export const companionSkillOwned = (st) => (st?.whale?.companionSkills
  && typeof st.whale.companionSkills === 'object' ? st.whale.companionSkills : {});

/** 这位旅伴**陪她去过**的异世界（regionId 数组；没有 ⇒ 空数组）。 */
export const companionWorldsOf = (st, id) => {
  const all = st?.whale?.companionWorlds;
  const list = all && typeof all === 'object' ? all[String(id)] : null;
  return Array.isArray(list) ? list.map(String) : [];
};

/** 这个技能学会了没有（id 或 skill 对象都能传；**热载安全**）。 */
export const companionHas = (st, idOrSkill) => {
  const id = String((idOrSkill && typeof idOrSkill === 'object') ? idOrSkill.id : idOrSkill || '');
  return Boolean(id) && Boolean(companionSkillOwned(st)[id]);
};

/** 能不能学这位旅伴的技能 ⇒ {ok, reason}。 */
export function companionSkillGate(st, sk) {
  if (!sk) return { ok: false, reason: '没有这个技能' };
  const cid = String(sk.companion || '');
  const cname = String(((S.COMPANIONS || {})[cid] || {}).name || cid);
  if (companionHas(st, sk.id)) return { ok: false, reason: `「${sk.name}」已经会了` };
  if (!ownedCompanionIds(st).includes(cid)) {
    return { ok: false, reason: `还没邀请过「${cname}」—— 先去商店请一位（说过一起来的那份见面礼）` };
  }
  const n = companionWorldsOf(st, cid).length;
  if (n < sk.needWorlds) {
    return { ok: false, reason: `还差点火候：得让「${cname}」陪你走过 ${sk.needWorlds} 个异世界才练得出来（现在 ${n} 个）` };
  }
  const money = Number(st?.wallet?.plankton) || 0;
  if (money < sk.price) {
    return { ok: false, reason: `TOKEN 不够：学「${sk.name}」要 ${sk.price} 亿，现在有 ${money} 亿` };
  }
  return { ok: true };
}

export function learnCompanionSkill(st, sk) {
  const g = companionSkillGate(st, sk);
  if (!g.ok) return g;
  st.wallet.plankton = (Number(st.wallet?.plankton) || 0) - sk.price;
  st.whale = st.whale || {};
  st.whale.companionSkills = { ...companionSkillOwned(st), [sk.id]: { at: Date.now() } };
  return { ok: true, reason: `学会了「${sk.name}」` };
}

/** 同行伙伴的"感言"（目前只有小白龙的「龙语」）。不是她那趟 ⇒ ''（旧 postcard.js 会忽略这个字段）。 */
export function companionNoteFor(state, tripLike) {
  if (String(tripLike?.companion || '') !== 'gpt') return '';       // 只认鲸鱼那趟的同行者
  if (!companionHas(state, 'dragon-tongue')) return '';
  const sk = COMPANION_SKILLS.find((s) => s.id === 'dragon-tongue');
  return String(sk?.note || '');
}

/**
 * 构图型技能的"额外画面特征"—— 追加在 `postcard.js` 抽到的基础构图后面。
 * ⚠️ 这些字**进的是生图提示词** ⇒ 绝对不能有 Markdown 星号（§41 的卫生纪律；
 *   试点那版写了 `**六边形数据光盾**`，是**真的漏进提示词里了**，这里一并清掉）。
 */
export const FUSION_EXTRA = {
  shield: '；她身前浮起一层六边形数据光盾（数据流凝成、边沿泛蓝光），稳稳挡住迎面那一下',
  danmaku: '；两人之间炸开满屏弹幕（成片的符卡与光弹铺满背景，人物不被遮住）',
  totem: '；画面一侧立着一根发光的小图腾柱（木雕纹样、顶端一小簇幽蓝火苗），像刚插进地里的路标',
  sheikah: '；整张照片带希卡石板的质感（深褐与暗金、隐约的方形纹路与淡蓝光边），像从石板里抓拍下来的一帧',
  warp: '；她身边的空气里残留着一圈淡蓝色折跃光（细碎的六边形光斑正在散去）',
  funnel: '；她身边悬停着几枚小型浮游炮（小巧的锥形、尾端亮着蓝光，排成一列跟着她）'
};

/**
 * 这趟的"构图半"。两种来源：
 *   · `battle: true` 的（数据护盾 / 弹幕掉落）**只在有敌手的世界**发 ——
 *     否则会出现"在杭州街头立起数据护盾"这种画面；
 *   · 其余（图腾 / 希卡 / 折跃 / 浮游炮）**哪儿都能发**，只是有敌手时基础构图会取战斗池。
 * 基础构图一律交给 `postcard.js` 的 `pickBattleFusion` / `pickFusion` 抽（那两句"世界观锚 +
 * 敌方外观"不能省 —— 少了它生图模型会把混沌信徒画成现代特种兵），我们**只追加**自己的特征。
 * ⇒ 这样**构图也能热载**（不用改 postcard.js）。
 */
export function skillFusionText(sk, tripLike, rand) {
  const foe = String(tripLike?.foe || '').trim();
  if (sk.battle && !foe) return '';
  const duo = Boolean(tripLike?.companion || (Array.isArray(tripLike?.partners) && tripLike.partners.length));
  const work = tripLike?.regionName || tripLike?.region || '';
  const look = tripLike?.foeLook || '';
  let base = '';
  try {
    if (foe && typeof P.pickBattleFusion === 'function') base = P.pickBattleFusion(rand, foe, work, look, duo);
    else if (typeof P.pickFusion === 'function') base = P.pickFusion(rand, foe, work, look);
  } catch { base = ''; }
  if (!base) return '';
  return base + (FUSION_EXTRA[sk.fusion] || '');
}

/**
 * ★★ 发动选择器（用户定的规则）：
 *   ① 只有**带风味半**的技能参与；② **每张明信片必发动、且全局只发动 1 项**；
 *   ③ 有敌手的异世界 ⇒ **战斗向**风味加权（否则「数据护盾」这类招牌几乎永不出现）；
 *   ④ 优先**与这趟世界同源**；⑤ 都没有 ⇒ null（维持现状）。
 * 构图类**只在有敌手时可参与** —— 否则会出现"在杭州街头立起数据护盾"这种画面。
 * @returns {null|{skill, fusion, note}}
 */
export function pickSkillFlavor(st, tripLike, { rand = Math.random } = {}) {
  const owned = skillOwned(st);
  const foe = String(tripLike?.foe || '').trim();
  const all = SKILLS.filter((s) => owned[s.id] && (s.note || s.fusion));
  if (!all.length) return null;
  // ★ 2026-10-13 晚：原来是"**有 fusion 就要求有敌手**"（因为构图全是战斗向的）。
  //   现在图腾 / 希卡 / 折跃 / 浮游炮这些都是**非战斗构图**，哪儿都能发 ⇒ 改成只看 `battle` 标记。
  const pool = all.filter((s) => !(s.battle && !foe));
  if (!pool.length) return null;
  const same = pool.filter((s) => s.region === String(tripLike?.regionId || tripLike?.region || ''));
  const cands = same.length ? same : pool;
  const weighted = cands.flatMap((s) => (s.battle && foe ? [s, s] : [s]));
  const sk = weighted[Math.min(weighted.length - 1, Math.floor(rand() * weighted.length))];
  if (!sk) return null;
  return { skill: sk, fusion: sk.fusion ? skillFusionText(sk, tripLike, rand) : '', note: String(sk.note || '') };
}

/**
 * 出门那一刻的"数值半"—— 分两处：
 *   `syncSkillNumbers` 必须在 **planTrip 之前**（trip.js 掷卡片稀有度要用到这个数）；
 *   `applySkillNumerics` 在 **planTrip 之后**（要往计划里加卡 / 加特产 / 升稀有度）。
 */
export function syncSkillNumbers(state) {
  state.whale = state.whale || {};
  const owned = skillOwned(state);
  // 战锤「数据护盾」：异世界那些趟的明信片稀有率**加法** +0.05。
  //   ⚠️ **加法**，绝不是新增 rareMult 乘数 —— 现行稀有率上限已经 66%（见 MEMORY-2 §69）。
  //   `trip.js` 只读这个数字，**不认识技能 id**（技能表只住在本文件）。
  state.whale.rareBonus = owned['data-shield'] ? 0.05 : 0;
  // ── ★★ 2026-10-13 晚（补齐剩下 8 个世界）：下面几个都是"**给兄弟模块读的纯数字**"——
  //    同一个规矩：`trip.js` / `postcard.js` 只认这些通用字段，**永远不认识技能 id**。
  //    （"派生数字过桥"的另一种选择是改兄弟模块的算法，那会变成"谁都得知道有哪些技能"。）
  // ★ v3.0：再叠加千问「引经」（旅伴技能，需她同行 + 练成）—— 景点 2→3→4。
  //   ⚠️ 仍然是**纯数字过桥**：`trip.js` 只读这个数，不认识技能 id、也不认识旅伴 id。
  state.whale.spotBonus = (owned['wind-glider'] ? 1 : 0)
    + ((companionOf(state)?.id === 'qwen' && companionHas(state, 'quote-classics')) ? 1 : 0);
  // ★★ 2026-10-14 v3.0：改成**累乘** —— 原来写死"学了折跃残影就 0.8"，
  //   而新加的两个世界各有一条"旅程 −10%"（明日方舟「源石技艺·急行」/ 仙剑「御剑术」）
  //   ⇒ 单值赋值会让后写的那条互相覆盖（谁学得多谁反而没效果）。
  //   现值：0.8 × 0.9 × 0.9 ＝ 0.648（三条全学 ≈ −35%）。
  //   ⚠️ 仍然是**纯数字过桥**：`trip.js` 只读这个数，**不认识技能 id**。
  state.whale.tripDurationMult = [['warp-trail', 0.8], ['originium-haste', 0.9], ['sword-flight', 0.9]]
    .filter(([id]) => owned[id])
    .reduce((m, [, f]) => m * f, 1);
  state.whale.firstCardDeadlineMs = owned['sheikah-nav'] ? 4 * 3600 * 1000 : 0; // 海拉鲁「希卡导航」：首张更早
  state.whale.rareRewardMult = owned['iron-debt'] ? 3 : 1;                 // 维斯特洛「有债必偿」：奖励 ×3
  // ★★ 2026-10-13 旅伴养成「猫步」：小猫咪的稀有惩罚 ×0.5 → ×0.75（**惩罚减半**）。
  //   依旧是"纯数字过桥"：`trip.js` 只读这个数、**不认识技能 id**。
  //   ⚠️ 两个条件都要满足：技能学会了 **且** 她此刻同行的那位就是小猫咪
  //      （技能是给那位伙伴练的，不是给鲸鱼的）。不满足 ⇒ 0 ⇒ `trip.js` 退回 `COMPANIONS` 里的原值。
  state.whale.companionRareMult = (() => {
    if (!companionHas(state, 'cat-step')) return 0;
    const c = companionOf(state);
    if (!c || String(c.id) !== 'gemini') return 0;
    const base = Number(c.rareMult);
    if (!(base > 0) || base >= 1) return 0;                  // 本来就没惩罚 ⇒ 不动
    return Math.round((1 - (1 - base) / 2) * 100) / 100;     // 0.5 → 0.75
  })();
}

export function applySkillNumerics(state, plan, d) {
  if (!plan) return plan;
  const owned = skillOwned(state);
  const rand = typeof d?.rand === 'function' ? d.rand : Math.random;
  // ── 中土「渡鸦信使」：这趟多 1 张（走既有的 appendExtraCard，序号口径它已处理好）──
  if (owned['raven-post']) appendExtraCard(plan, { rand, battle: false });
  // ── v3.0 夜之城「义体强化」：同样多 1 张（与渡鸦信使**可叠加** ⇒ 两张额外卡）──
  if (owned['cyberware']) appendExtraCard(plan, { rand, battle: false });
  // ── 费伦「空间袋」：多带 1 件特产（照第一件再装一份；**不**升稀有，免得白送稀有奖励）──
  if (owned['bag-of-holding'] && Array.isArray(plan.souvenirs) && plan.souvenirs.length) {
    const src = plan.souvenirs[0] || {};
    plan.souvenirs = [...plan.souvenirs, {
      name: String(src.name || ''), label: String(src.label || 'common'), isRare: false,
      kind: String(src.kind || '')          // ★ 照抄分类，否则这多带的一件会变成"不能吃不能种"
    }];
  }
  // ── 东方「弹幕掉落」：这趟更容易带回稀有特产 ──
  //   ⚠️ 必须**尊重既有的"一趟最多 1 件稀有"**（judgeSouvenirs 的规则）⇒ 已经有就不动。
  if (owned['danmaku-drop'] && Array.isArray(plan.souvenirs) && plan.souvenirs.length
      && !plan.souvenirs.some((s) => s.isRare === true)
      && rand() < SKILL_SOUVENIR_RARE_CHANCE) {
    const t = plan.souvenirs[Math.min(plan.souvenirs.length - 1, Math.floor(rand() * plan.souvenirs.length))];
    if (t) { t.isRare = true; t.label = 'rare'; }
  }
  return plan;
}

/** 这个会话已经买过哪些伙伴（热载期退回"只有当前那一个"，不报错）。 */
export const ownedCompanionIds = (st) => (typeof S.ownedCompanionIds === 'function'
  ? S.ownedCompanionIds(st)
  : (companionOf(st) ? [companionOf(st).id] : []));

/**
 * ★★ 2026-10-13：**帮助图的装配函数** —— 把"图上要显示的数据"从各处收拢到一处。
 *
 * 为什么要有它（而不是让 help.js 自己找数据）：
 *   ① **技能表住在 index.js**，而 help.js 是兄弟模块、反向 import 会成环 ⇒ "谁有谁传"；
 *   ② 消耗动作的价格（`REFRESH_PRICE` / `EXPRESS_PRICE` / `BUY_MAX_PER_ORDER`）也住在这儿；
 *   ③ 线上（`whale_help`）与离线预览（`_qcheck/help-preview.mjs`）**共用这一个函数**
 *      ⇒ 预览画出来的东西和真发出去的是同一份数据，不会"预览好看、线上是旧的"。
 *
 * 全部字段都做了兜底：老存档（没有 `whale.skills` / `garden`）也照常出图。
 */
export function helpDataFor(st) {
  const state = st || {};
  return {
    ownedIds: ownedCompanionIds(state),
    // ★ 2026-10-13 晚（用户："飞行扫帚已经解锁了，但没打勾"）：装备 ✅ 原来只看**出厂默认**，
    //   于是"她买过、但不在默认九件里"的会被漏掉。这里用 `isRegionUnlocked`（=默认 ∪ 买过的）算好传进去。
    unlocked: T.loadRegions().filter((r) => isRegionUnlocked(state, r)).map((r) => r.id),
    // ★★ 2026-10-15「探索解锁」**漏斗补漏**（用户："help.js 里仍然能看到全部的异世界道具，这个忘盖了"）：
    //   说明图第 5 节那张装备网格原来 `list.map()` 把 **24 个地区一件不落地铺出来** ⇒
    //   群友一打开说明图就看见 15 个异世界的**装备名 + 世界名** —— 探索感从侧门漏光。
    //   （当时只筛了 `shopText` / `shopPageData` 这两处，网格漏了。）
    //   ⇒ 这里算好"**可见**名单"传给 help.js 的 `equipGrid(unlocked, visibleEquip)`。
    //   ⚠️ 与 `unlocked` 是**两件事**，别合并：`unlocked` 决定打不打 ✅（已买/默认），
    //      `visibleEquip` 决定**出不出现在表里**（她已经知道的地方）。已拥有的必然知道 ⇒ visible ⊇ unlocked。
    //   ★ 判据统一收在 `isRegionVisible()` / `visibleRegionIds()`（就写在 `isRegionUnlocked()` 旁边），
    //     装备网格 / 技能表 / 技能列表 / 衣柜页 / 商店**共用同一个函数** ——
    //     "漏盖"的病根就是同一个口径在五处各写一遍（这次先是商店漏、后是 help 的网格漏）。
    visibleEquip: visibleRegionIds(state),
    // ★★ 2026-10-15 晚（用户追加口径）：**技能树与衣柜也只解锁"能看到的世界"那部分** ——
    //   "在初期应该直接【不解锁】，在**去过至少一个异世界**之后才解锁"。
    //   ⚠️ 这里**不另写总闸**：`visibleSkills()` 筛完，新档天然是空数组
    //      （SKILLS 那 30 条的 region 全在 15 个异世界里，没有现实技能）
    //      ⇒ "初期不解锁"是**筛出来的结果**，不是另一条分支 —— 少一处判据就少一处对不上。
    visibleRegions: visibleRegionIds(state),
    visited: [...skillVisitedRegions(state)].map(String),
    // ★★ `skills` 先按"可见世界"筛过再传进 help.js ⇒ 主图上的技能统计（"N 条"）与技能表
    //   **自动跟着对**，help.js 一行都不用改（它是纯渲染、数据谁有谁传）。
    skills: visibleSkills(state),
    learned: skillOwned(state),
    garden: (state.garden && typeof state.garden === 'object') ? state.garden : {},
    // 菜单图上要写"她此刻能学什么" —— 用现成的 skillGate 判，别在 help.js 里重写一遍规则
    learnable: visibleSkills(state).filter((sk) => skillGate(state, sk).ok).map((sk) => sk.name),
    // ★★ 2026-10-13 旅伴养成：菜单图上也要有（否则看图会以为只有鲸鱼能学）
    companionSkills: COMPANION_SKILLS,
    companionLearned: companionSkillOwned(state),
    companionWorlds: (state.whale && typeof state.whale.companionWorlds === 'object')
      ? state.whale.companionWorlds : {},
    learnableCompanion: COMPANION_SKILLS.filter((sk) => companionSkillGate(state, sk).ok).map((sk) => sk.name),
    companionNames: Object.fromEntries(Object.values(S.COMPANIONS || {}).map((c) => [c.id, c.name])),
    spend: { refresh: REFRESH_PRICE, express: EXPRESS_PRICE, buyMax: BUY_MAX_PER_ORDER },
    // ★ 2026-10-14：第四台服务器阵列的门槛 = **全部成就值**（随称号增加而自动提高）——
    //   菜单图要把它印成具体数字，所以在这里算好传下去（别在 help.js 里重算一遍）。
    // ★ 2026-10-14 批 3：顺带把**称号条数**也传下去 —— 主图上那句原来是写死的"25 个称号"
    //   （"旅行鲸鱼"时代的旧数，现在 57 条）。**写死的数字一定会漂**，能现读就现读。
    ...(() => {
      const sum = TI.summarizeTitles(state, titleCtx());
      return { achievementTotal: sum.totalPoints, titlesTotal: sum.total };
    })(),
    // ★ 2026-10-14 服装系统：衣柜（帮助图要写"已解锁 N / 全部套数"—— 套数由 help.js 现读 OUTFITS）
    wardrobe: (state.wardrobe && typeof state.wardrobe === 'object') ? state.wardrobe : {},
    areasSeen: (state.areasSeen && typeof state.areasSeen === 'object') ? state.areasSeen : {}
  };
}

/**
 * ★★ 「换旅伴」的**唯一写入口**（2026-10-13 用户口径）。
 *
 * 口径原话：「**等都回家之后立刻换成对应的伙伴**」。两种落法——
 * ★★ 2026-10-15（**分两步收窄，第二步是用户当场纠正的**）：
 *   · **她本人**在途（`st.trip`）⇒ 只记一笔 `pendingCompanion`，**不动 `state.companion`**
 *     （在途快照与 live 打架，见下）；
 *   · **要换的那位**自己跑出去玩了（在 `sideTrips` 里）⇒ 同样只记一笔 ——
 *     「陪她出门」这件事当下就要求**她在家里**（用户原话："不可能换，因为小折扇刚跑出去了"）；
 *   · 两个都不是 ⇒ **当场**换。
 *   ⚠️ **中间踩过的坑（两个用户症状同一个根因）**：第一版判的是
 *     `sideTripsOf(st).length`（"**任何**一趟在外面"）⇒
 *     ① 家里只要有人出去玩就永远换不成（实测卡 22 小时）；
 *     ② 回执写"她俩还在路上"被读成**她本人没到家**（用户报："你不是到家了吗" ⇒ 她答
 *        "没呢，还在外面飘着"）。
 *   ⇒ 通则：这类闸门**必须落到"具体的人"头上**，不能用"有没有人不在家"这种集合判据。
 *
 * 为什么在途时**必须**延后写，而不是"写了但只对下一趟生效"：
 *   `state.companion` 是**唯一真相源** —— 在途明信片读的是出发时的快照
 *   （`trip.companion`）、travel-sync / qqzone / 集成的状态注入读的是快照、
 *   而 `whale_status` / 商店读的是 live。一旦中途改 live，两套说法当场打架；
 *   更糟的是 `idleCompanions` 只排除 live 那一位 ⇒ 被换下来的伙伴**当场变闲置**、
 *   会被派去"自己出去玩" ⇒ **同一个人同时出现在两趟旅行里**（实测可达，见存档
 *   `group_123456789.json`：companion=claude、sideTrip.partners=[gpt,fox]）。
 *   延后写把这类矛盾一次性消掉：live 永远等于"此刻真的跟着她的那位（或下一位）"。
 *   ★ 2026-10-15 补：上面这条"被换下来的伙伴当场变闲置"的隐患，已由
 *     `busyCompanionIds()`（含 `trip.companion` ＋ `companions[]`）堵住；
 *     现在剩下的**唯一**理由就是"她在途时 live 与快照会打架"，所以闸门只判 `st.trip`。
 *
 * @param {object} st 存档（调用方须在 `S.mutate` 里）
 * @param {object} comp `COMPANIONS` 里的定义
 * @returns {{applied:boolean, name:string, why?:string}}（`why='whale-away'` ⇒ 她在旅途中等回来）
 */
export function appointCompanion(st, comp, now = Date.now()) {
  if (!st || !comp) return { applied: false, name: '' };
  st.companionOwned = [...new Set([...(Array.isArray(st.companionOwned) ? st.companionOwned : []), comp.id])];
  // ★★ 2026-10-14 种菜：请过"开地的那位"（现在是千问）⇒ **永久解锁菜地**。
  //   ⚠️ 放在这里、而不是"切换成功之后"：`applied:false`（**她在旅途**、只能先答应）**也算请到了**，
  //     用户口径是"请过千问就永久解锁"，与她此刻在不在家无关。
  //   ★ v3.2：判据从写死的 `id === 'qwen'` 改成**现读表上的 `farmHelper`**（换人只改表）。
  if (isFarmHelper(comp)) st.farmUnlocked = true;
  // ★★ 2026-10-15 修（用户报"她明明到家了却说没到家，还换不了旅伴"）：
  //   **闸门原来写的是 `st.trip || sideTripsOf(st).length`** —— 把"**别人**自己跑出去玩"
  //   也当成了"她俩在路上"。可 `sideTrips` 是**别的旅伴**出门，鲸鱼少女本人是**在家**的。
  //   后果有两层，而用户的两个症状是**同一个根因**：
  //     ① **换不了人**：只要家里有任何一趟在外面，换人就一直延后（实测：卡到次日 11:29）；
  //     ② **说错话**：回执写"她俩还在路上" ⇒ 模型（和群友）都读成**她本人**没到家
  //        ⇒ 群友问"你不是已经到家了吗"，她答"没呢，还在外面飘着"。
  //   ⇒ 正确的闸门只有一条：**她本人是否在途**（`st.trip`）。
  //     - 她在家时写 live **不会打架**：在途明信片/注入读的都是 `trip.companion` 快照；
  //     - 被换的那位此刻在外面玩也**不影响** —— 这个字段的语义是
  //       "**下一趟**陪她出门的那位"；"她出发时那位还没回家"另有闸
  //       （见 `tick()` 里的**领头发车检查**，那里顺延出发而不是改 live）。
  if (st.trip) {
    st.pendingCompanion = { id: comp.id, at: now };
    return { applied: false, name: comp.name, why: 'whale-away' };
  }
  // ★★ 2026-10-15（**用户口径**）：要换的**那一位**自己跑出去玩了 ⇒ 也换不了。
  //   理由很直白：「陪她出门」这件事当下就要求**她在家里**（她人在梦幻馆，怎么陪）。
  //   ⇒ 先记一笔"说好了"，等她回来再落定（落定判据见 `tick()`，只等她**这一位**，
  //     不是等所有趟 —— 那一版曾经把"别人出去玩"也算进来，是 bug）。
  //   ⚠️ 与上一版的**区别就在这里**：上一版判的是 `sideTripsOf(st).length`（**任何**一趟），
  //     这一版只判**目标本人**（`why='target-away'`），文案也会说清是**她（目标）**不在家。
  if (awaySideTripOf(st, comp.id)) {
    st.pendingCompanion = { id: comp.id, at: now };
    return { applied: false, name: comp.name, why: 'target-away' };
  }
  st.companion = { id: comp.id, at: now };
  st.pendingCompanion = null;
  return { applied: true, name: comp.name };
}

/** 说好但还没落定的那位（没有 ⇒ null）。 */
export const pendingCompanionOf = (st) => {
  const id = String(st?.pendingCompanion?.id ?? '').trim();
  return id ? ((S.COMPANIONS || {})[id] || null) : null;
};

/**
 * ★★ 「换人没能当场生效」时的说法（2026-10-15）。
 *
 * 为什么必须单独抽出来：原来的措辞是**"她俩还在路上"** —— 那句话被群友和模型
 * 一起读成了"**她本人**没到家"：群友问"你不是已经到家了吗" ⇒ 她答"没呢，还在外面飘着"。
 * ⚠️ 主语必须**落到具体的人**：
 *   · `whale-away` ⇒ 是小鲸鱼本人在旅途（"小鲸鱼"三个字写死，不会有歧义）；
 *   · `target-away` ⇒ 是**要换的那位**自己跑出去玩了 ⇒ **必须点她的名字**（`r.name`）。
 *     ★ 这里踩过一次：第一版写"不过**她**这会儿自己跑出去玩了" —— "她"照样会被读成
 *     **鲸鱼少女本人**（跟"她俩还在路上"是同一个坑），所以改成 `「小折扇」`。
 * 三处回执（whale_buy 两条分支 ＋ whale_companion）**共用这一份**，不许各写一份。
 */
export const appointWaitTail = (r) => (r?.why === 'target-away'
  ? `不过「${r.name || '她'}」这会儿自己跑出去玩了，得等她回来才能换。`
  : '不过小鲸鱼这会儿还在外面旅行，得等这趟回来才能换人。');

/**
 * ★ 面板里那行"说好了但还没生效"的**人话版**（商店 / 看庭院 / 换伙伴 三处共用）。
 * 与 `appointWaitTail` 同源同判据，只是面板上不用对话口吻、要说清"等谁"。
 */
export function pendingReasonText(st) {
  const pc = pendingCompanionOf(st);
  if (!pc) return '';
  if (st?.trip) return `等小鲸鱼这趟旅行回来，就换成「${pc.name}」陪它出门`;
  if (awaySideTripOf(st, pc.id)) return `等「${pc.name}」自己那趟玩回来，就换成她陪它出门`;
  return `等下一轮就换成「${pc.name}」陪它出门`;
}

/**
 * ★★ 回家后休息多久再自动出发 —— 从技能设置读（2026-10-13 大更新 step3：给「家」存在感）。
 *
 * 为什么要做成设置：用户口径是「让'家'有存在感」，而"在家待多久"这个手感**一定还会反复调**
 *   ⇒ 放成设置后改配置即可生效，**不用重启**；默认值住在 `engine.js`
 *   （`REST_MIN_MS` / `REST_MAX_MS` = 24h / 48h，改默认值才要重启）。
 *
 * ⚠️ 本机通则（栽过五次的坑）：`Number(null) === 0` 且 `Number('') === 0`
 *   ⇒ 判"到底配没配"必须**显式排除** `null`/`undefined`/`''`；否则"没配"会被读成
 *   "配了 0 小时" ⇒ **刚回家就出门**（正好是要修的那个现象）。
 *   另外 `maxMs <= minMs` 由 `engine.nextDepartAt()` 自己兜底成默认上界，这里不必重复防。
 */
