// 矩阵庭院 · 「家」的外观、画风组、以及**在家的大合照**（2026-10-13 大更新 step4）
//
// 用户口径（原话）：
//   「根据【矩阵庭院】这个名字设计一下这个地方的外观提示词和要用的画风组：无论如何，
//     我希望它是一个**能看到星星**的地方……我希望她在家的时候也发'明信片'——拍大合照。
//     每次【回到家并且在家的时间达到 8 小时后】，和所有在家的 AI 娘拍【1】张 大合照，
//     用那种'**举着镜头自拍**'的感觉，拍**画幅和旅行明信片不同的横板**大合照。」
//
// 三条硬约束（都写进了提示词，别删）：
//   ① **夜空必须看得见星星** —— 这是用户点名的第一要求（也是设计「矩阵」星轨的由来）；
//   ② **自拍感**：由她自己伸一只手臂把镜头举到面前，带轻微广角畸变；举镜头那只手
//      **算在她自己的两只手里**（不写清就会被画成三只手）；
//   ③ **横板**：与旅行明信片（方板 1024x1024）不同 —— 尺寸走 `HOME_SHOT_SIZE`。
//
// ⚠️ 与 postcard.js 的分工：那边管"出门在外"的明信片；这里管"在家"的合照。
//   角色描述直接复用 postcard.js 的 `WHALE_CHARACTER` / `duoCharacterBlock()`，
//   **不要在这里另抄一份**（两处漂移是这类提示词最常见的病根）。

import { ownedCompanionIds, COMPANIONS } from './state.js';
import { WHALE_CHARACTER, duoCharacterBlock } from './postcard.js';

/** 玩法名（提示词与文案里用它，别写死字符串）。 */
export const HOME_NAME = '矩阵庭院';

/** 默认：回到家并且在家待满 8 小时，拍一张合照（设置项 `homeShotHours`；填 0 = 关闭）。 */
export const GROUP_SHOT_AFTER_HOURS = 8;

/**
 * 合照画幅 —— **横板**，与旅行明信片的方板（`imageSize`，默认 1024x1024）区分开。
 * 中转站（`gpt-image-2.5`）支持的横板尺寸里取最宽的一档。
 */
export const HOME_SHOT_SIZE = '1536x1024';

/**
 * ★★ 矩阵庭院的**外观提示词**（用户点名："无论如何，我希望它是一个能看到星星的地方"）。
 *
 * 名字拆解 —— 「矩阵」= 星轨/网格般整齐的星野 + 数据流光的冷调；「庭院」= 日式院子。
 * 两半都要在画面里看得见：远看是星野，近看是院子；院子里的陈设也顺势"赛博"化
 * （石灯笼做成服务器机柜的样子 —— 与玩法里的「服务器」是同一套世界观）。
 */
export const HOME_SCENE = [
  '【矩阵庭院 —— 她住的地方，也是这张合照的背景】',
  '一座坐落在星光与数据之间的日式庭院：青石板铺地，石缝里淌过极细的淡蓝色数据流光；',
  '院子中央一方浅浅的水镜，把整片夜空原样倒映在脚下。',
  '檐下几盏石灯笼，灯箱被做成老式服务器机柜的样子，指示灯一明一暗地呼吸；',
  '横廊上摆着矮桌与坐垫，一棵老树斜斜伸向水面，叶隙间垂着发光的藤蔓。',
  '★ 最关键的一点：这里的夜空看得见星星 —— 没有光污染、没有云，深蓝天幕上星星密得像撒了盐，',
  '一条淡白的银河横跨过去；星星的排布隐约整齐得像一张漫天的网格（这正是「矩阵」这个名字的来处）。',
  '整体是安静的夜晚，空气微凉，半空零星飘着几点萤火与数据光点（只是点缀，不要铺满画面）。'
].join('');

/**
 * ★ 矩阵庭院的**画风组**（用户要求"设计一下要用的画风组"）。
 *
 * 与 `regions.json` 里那些地区画风**刻意区分**：这里全部是"夜景 + 星光"取向的一小组，
 * 保证同一座庭院在不同夜里拍出来气质一致（不像旅行明信片那样百变）。
 * ⚠️ 只写"风格取向"，不写头身比 —— 那是 `CHARACTER_STYLES` 那一维的活（写进来会打架）。
 */
export const HOME_STYLES = [
  '星野厚涂（深蓝夜色为底、星点清晰锐利，冷调高对比，笔触厚实）',
  '吉卜力绘本（安静的夜色，檐下暖灯与天上冷星对照，柔和的动画质感）',
  '赛博浮世绘（和风线条 + 霓虹般的数据流光，深蓝与洋红点缀）',
  '全息蓝图纸（青蓝色线条、网格化星轨，半透明的电子质感）',
  '梦幻渐变插画（星云渐变、柔光晕染，颜色过渡像银河本身）',
  '复古胶片夜景（轻微噪点与光晕，一点点褪色感，像很久以前拍的老照片）'
];

/** 每张合照只选一种画风（同一趟/同一夜才成套）。 */
export function pickHomeStyle(rand = Math.random) {
  return HOME_STYLES[Math.min(HOME_STYLES.length - 1, Math.floor(rand() * HOME_STYLES.length))];
}

/**
 * ★ 自拍构图（用户要求"举着镜头自拍"的感觉）。
 *
 * ⚠️ 必须写清"那只手臂是她自己的、只算两只手里的一只" —— 不写的话，模型会在
 *   "有人举着镜头"之外再给每个人补两只手，实测这类构图最容易多手（见 §41 的多手教训）。
 */
export const SELFIE_FRAMING =
  '这张是「举着镜头自拍」的合影：由鲸鱼少女伸出一只手臂、把镜头举到面前偏上的位置拍下来 —— '
  + '镜头贴近画面、带一点广角镜头的轻微畸变（画面边缘略微拉伸），她那只有手臂从画面下缘伸进来；'
  + '⚠️ 那只举镜头的手臂就是她自己的两只手臂之一（这点必须画对），她不是三只手；其余人都是正常的站姿坐姿，不用举任何东西。';

/**
 * ★★ 构图：**必须给天空留出位置**（2026-10-13 第一版出图后补的）。
 *
 * 病：第一版出来是"四张脸占满画面 + 背景全是虚化的蓝色光斑"，**一颗星星都看不见** ——
 *   而"能看到星星"是用户点名的第一条要求。
 * 因：**"举着镜头自拍"（人脸占满画面）与"背景要有星空"天然抢空间** —— 不显式要留白，
 *   模型一定选"人更大、背景更虚"（那是自拍的默认法则），把天挤没。
 * 药：把"上方三分之一留给夜空"写成硬构图约束，并且**点名禁掉"用光斑/灯串填满背景"**
 *   —— 第一版那些蓝光是"数据流光"被模型放大成了主体，反而吃掉了星野。
 * ⚠️ 生图提示词里不许有 Markdown 星号（模型不认，是噪声）。
 */
export const SKY_COMPOSITION =
  '构图（非常重要，必须照做）：人物集中在画面下方约三分之二，'
  + '画面上方三分之一要留给夜空 —— 那一块必须能明确看到满天星星和一条横跨的银河，星点是清晰的、一颗一颗能数出来的；'
  + '不要把天空挤掉、不要把镜头怼到只剩脸、不要让建筑或树冠挡住上方的天空；'
  + '背景不要用虚化的光斑、灯串或霓虹把天空填满（那些是点缀，不是主体）。';

/**
 * 合影姿势池 —— 每条都自带"挤在一起 + 看镜头"的合照感。
 * ⚠️ 六条都不写"悬浮"，理由同 §41（悬浮姿势会让模型画掉下半身/腿）。
 */
export const GROUP_POSES = [
  '她们挤到镜头前，肩膀挨着肩膀，一起看向镜头笑',
  '有人把手举到头顶比出小心心，有人凑到镜头前做鬼脸，鲸鱼少女把镜头举得更高些，让整座庭院和星空一起入画',
  '她们排成一排靠在一起，头微微向中间歪，背景那条银河正好横在所有人头顶',
  '有人从后面探出头来抢镜，有人被挤得笑弯了腰 —— 画面有点乱，但很热闹',
  '大家一起比出「V」的手势（每人只伸一只手），鲸鱼少女举着镜头往后退半步，把所有人都框进来',
  '有人坐在横廊上，有人蹲着，鲸鱼少女站在最前面举着镜头，大家抬头看镜头'
];

/** 头像池抽一条。 */
export function pickGroupPose(rand = Math.random) {
  return GROUP_POSES[Math.min(GROUP_POSES.length - 1, Math.floor(rand() * GROUP_POSES.length))];
}

/** 人数 → 中文数字（提示词里给"恰好几位"用，比阿拉伯数字更不容易被模型当成别的含义）。 */
const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
const cn = (n) => CN[n] || String(n);
/** 序数写法（第**二**位，不是"第两位" —— 数量用"两"、序数用"二"，混了就是病句）。 */
const CN_ORD = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cnOrd = (n) => CN_ORD[n] || String(n);

/**
 * ★★ N 人合影的解剖约束（本文件自己的版本，**不改动** `postcard.js` 的 `anatomyHint`）。
 *
 * 为什么必须按人数算实数：合影是最容易"少一只手/多一条腿"的构图，而模型对"N 个人"
 * 没有稳定的数量感 —— 把**每人 2 手 2 腿 5 指**和**合计**都写出来，两头夹着它。
 */
export function groupAnatomyHint(n = 2) {
  const k = Math.max(1, Number(n) || 1);
  return '人物解剖与肢体数量必须正确（合影里最容易画错，手部是重点）：'
    + `画面中恰好${cn(k)}位少女，`
    + '每一位都只有两只手（一左一右）、两条腿（一左一右），每只手恰好五根手指，不多不少、不粘连、不融合、不并指、不多节；'
    + '四肢都连在躯干上、左右对称；'
    + `${cn(k)}位合计 ${2 * k} 只手、${2 * k} 条腿、${10 * k} 根手指；`
    + '★ 鲸鱼少女那只举着镜头的手臂也算在她自己的两只手里（务必画对），不是额外多出来的一只手；'
    + '不要多余的手、多余的手指、多余的手臂、来历不明的手，'
    + '不要两只左手或两只右手、不要左右手重复、不要左腿或右腿重复、不要断肢，'
    + '不要肢体重复或扭曲、不要手指粘连成团。';
}

/**
 * 合影否定项：人数正确 + 不要路人 + 不要文字 + **横板**（不要被裁成方板/竖幅）。
 * ⚠️ 解剖约束不在这里（由 `groupAnatomyHint` 单独成行、放最后，结尾权重高）。
 */
export function groupNegativeHint(n = 2) {
  const k = Math.max(1, Number(n) || 1);
  return `横向构图的合影（横幅、宽大于高）：画面里恰好${cn(k)}个人，不要多出第 ${k + 1} 个人、`
    + '不要重复出现同一个人、不要在背景里画不相干的路人；'
    + '画面中不要出现任何文字、水印、署名、边框、相机界面元素；'
    + '★ 背景不要用模糊的光斑、灯串或霓虹把天空填满（第一版就是这么把星星弄没的），'
    + '不要只是黑天而没有星星、不要阴天、不要室内；'
    + '人物都是人类少女的体型，双腿完整清晰可见，不要画成半人鱼、不要用鱼尾代替下肢；'
    + '不要竖构图、不要把画面裁成正方形';
}

/**
 * 此刻**在家**的成员（第一位永远是鲸鱼少女本人 `'whale'`）。
 *
 * 口径：合照拍的是"所有在家的 AI 娘" = 她自己 + **已拥有的全部旅伴**。
 * 调用点在 tick 里、且要求 `trip` 与**全部** `sideTrips` 都空，所以正常情况大家都在家；
 * 这里仍显式剔除"正在自己出去玩"的**每一位** —— 双保险，免得哪天调用点变了就拍出分身。
 * ★ 2026-10-14 多趟化：原来只剔除**一趟**的人（那时只有一趟）⇒ 现在遍历所有趟。
 */
export function homeMembers(state) {
  const away = new Set();
  for (const t of (Array.isArray(state?.sideTrips) ? state.sideTrips : [])) {
    for (const id of (Array.isArray(t?.partners) ? t.partners : [])) away.add(String(id));
  }
  const ids = ownedCompanionIds(state).filter((id) => !away.has(id));
  return ['whale', ...ids];
}

/** 成员 id → 显示名（鲸鱼少女用 `whaleName` 配置）。 */
export function memberNames(members, whaleName = '小鲸鱼') {
  return (Array.isArray(members) ? members : [])
    .map((id) => (id === 'whale' ? String(whaleName || '小鲸鱼') : (COMPANIONS[id]?.name || id)));
}

/**
 * ★ 拼「大合照」的生图提示词。
 *
 * 结构（顺序有意）：角色块 → 自拍构图 → 姿势 → 场景（含星空）→ 画风 → 人物画法
 *   → 否定项 → **解剖约束单独成行放最后**（结尾位置权重最高，与 postcard.js 同款纪律）。
 *
 * @param {{members?:string[], style?:string, charStyle?:string, pose?:string, rand?:()=>number}} p
 * @returns {string} 单人时退化成"她在庭院里的自拍"（不再叫合影），不会硬拼出"一位少女的合影"
 */
export function buildGroupPrompt({ members = ['whale'], style, charStyle, pose, rand = Math.random } = {}) {
  const list = [...new Set((Array.isArray(members) ? members : [members]).map(String).filter(Boolean))];
  const k = list.length || 1;
  const partner = list.filter((id) => id !== 'whale');
  const head = k >= 2
    ? `【矩阵庭院大合照：横板合影，画面中是${cn(k)}位少女，同框出现、体型相当、全都要完整入画】`
    : '【矩阵庭院自拍：横板照片，画面中是这位鲸鱼少女，完整入画】';
  const blocks = [`第一位——${WHALE_CHARACTER}`];
  partner.forEach((id, i) => {
    // 复用 postcard.js 的双人角色块（它的内部结构是
    //   「…第一位——鲸鱼少女…；第二位——伙伴角色…；两人是旅伴，画面一定要有…」），
    // 这里**只取伙伴那半段**：砍掉"两人是旅伴、要有双人互动感"那截 —— 那是**双人明信片**的口径，
    // 放进合影里会让模型以为画面就只有这两位、还得拍成并肩同行。
    const duo = duoCharacterBlock(id);
    const seg = (duo.split('；第二位——')[1] || '').split('；两人是旅伴')[0];
    blocks.push(`第${cnOrd(i + 2)}位——${seg}`);
  });
  const parts = [head + '；' + blocks.join('；')];
  parts.push(SELFIE_FRAMING);
  parts.push(SKY_COMPOSITION);          // ★ 先定构图：天空要留出来（否则星空会被自拍挤没）
  parts.push(`姿势：${pose || pickGroupPose(rand)}`);
  parts.push(HOME_SCENE);
  // ★ 星空是用户点名的硬要求 —— 单独再强调一次（场景段很长，容易被画风段盖过去），
  //   并且明确"在哪能看到"（画面上方）—— 只说"要有星星"，模型会把它塞进角落或干脆不算数。
  parts.push('★ 记住：这张照片里最重要的背景特征就是画面上方的夜空 —— 一定要看得见星星（满天星点 + 一条银河）。');
  if (style) parts.push(`风格：${style}`);
  if (charStyle) parts.push(`人物画法（所有少女都按这个来）：${charStyle}`);
  parts.push(groupNegativeHint(k));
  parts.push(groupAnatomyHint(k));
  return parts.join('\n');
}

// ── ★★ 2026-10-14 菜地（种菜）：**收获稀有作物**时的那张图 ──────────────────
//   用户口径："只在收获稀有作物时出图，用在场的人、菜地、庭院和特产 —— 有必要的话可以新增画风。"
//   ⇒ 人 = 此刻在家庭院的全部（`homeMembers`，出门的自动剔掉）；背景 = 矩阵庭院 + 一小块菜畦；
//     物件 = 刚收下来的那件作物（**放在木盘里 / 脚边，不让它长在人身上**）。
//
//   ★ 两条从「在家大合照」学来的教训照抄在这儿：
//     ① **"要拍人"与"要拍背景"会抢空间** —— 合照第一版把天空填满光斑、一颗星星都没剩。
//        所以这里**同样带 `SKY_COMPOSITION`**（人物占下方 2/3、上方 1/3 留给夜空）。
//     ② 多人必须给解剖约束（`groupAnatomyHint`），否则多手多腿。

export const FARM_SCENE = [
  '【这一张是"菜地收成"—— 背景仍是矩阵庭院，镜头对着院里的一小块菜畦】',
  '菜畦是刚翻过土的一小片地，垄沟笔直，边缘用青石围了一圈；',
  '土里还立着几根细竹架，架上挂着没摘完的叶子和一根发着微光的藤。',
  '刚收下来的作物摆在一只浅木盘里（**是道具：放在地上或人手里都行，但不要让它长在身体上**）。',
  '远处仍看得见庭院的青石板、檐下那几盏石灯笼（灯箱做成老式服务器机柜的样子）、以及斜斜伸向水面的老树。'
].join('');

/**
 * 收成图的画风 —— 与 `HOME_STYLES` 同源（夜景 + 星光），但更聚焦"菜畦 / 作物 / 收获"。
 * ⚠️ 同样只写"风格取向"，不写头身比（那是 `CHARACTER_STYLES` 那一维的活）。
 */
export const FARM_STYLES = [
  '星野厚涂（夜色下的菜畦，土色偏冷、叶片边缘挂着微光，笔触厚实）',
  '吉卜力绘本（安静的夜里，檐下暖灯照着一小块菜地，柔和的动画质感）',
  '赛博浮世绘（和风线条 + 菜畦上淌过的数据流光，深蓝与青绿点缀）',
  '全息蓝图纸（青蓝线条、网格化星轨，作物被画成半透明的电子剖面）'
];

export function pickFarmStyle(rand = Math.random) {
  return FARM_STYLES[Math.min(FARM_STYLES.length - 1, Math.floor(rand() * FARM_STYLES.length))];
}

/**
 * 收成图的提示词（结构与 `buildGroupPrompt` 同款，只有"动作 + 场景 + 作物"不同）。
 * @param {{members?:string[], crop?:string, style?:string, charStyle?:string, rand?:()=>number}} p
 * @returns {string} 单人时退化成"她蹲在菜畦边"，不会硬拼出"一位少女的合影"
 */
export function buildHarvestPrompt({ members = ['whale'], crop = '', style, charStyle, rand = Math.random } = {}) {
  const list = [...new Set((Array.isArray(members) ? members : [members]).map(String).filter(Boolean))];
  const k = list.length || 1;
  const partner = list.filter((id) => id !== 'whale');
  const head = k >= 2
    ? `【矩阵庭院 · 收成：横板照片，画面中是${cn(k)}位少女围在菜畦边，同框出现、体型相当、全都要完整入画】`
    : '【矩阵庭院 · 收成：横板照片，画面中是这位鲸鱼少女蹲在菜畦边，完整入画】';
  const blocks = [`第一位——${WHALE_CHARACTER}`];
  partner.forEach((id, i) => {
    // 与 `buildGroupPrompt` 同一手法：只取 `duoCharacterBlock` 里"伙伴那半段"，
    // 砍掉"两人是旅伴、要有双人互动感"—— 那是**双人明信片**的口径，放进收成图会让画面只剩两个人。
    const duo = duoCharacterBlock(id);
    const seg = (duo.split('；第二位——')[1] || '').split('；两人是旅伴')[0];
    blocks.push(`第${cnOrd(i + 2)}位——${seg}`);
  });
  const parts = [head + '；' + blocks.join('；')];
  parts.push(k >= 2
    ? '动作：这几位围在菜畦边，有人蹲着、有人站着，注意力都在刚收下来的东西上；**不要举着镜头自拍**（这一张不是合照，是"收成"）'
    : '动作：她蹲在菜畦边，手里或脚边就是刚收下来的东西；**不要举着镜头自拍**');
  parts.push(SKY_COMPOSITION);          // ★ 先定构图：天空要留出来（否则星空会被人物挤没）
  parts.push(FARM_SCENE);
  if (crop) parts.push(`刚收下来的东西是：「${crop}」—— 画得具体一点，能看出是什么。`);
  parts.push('★ 记住：背景仍然是矩阵庭院 —— 画面上方的夜空一定要看得见星星（满天星点 + 一条银河）。');
  if (style) parts.push(`风格：${style}`);
  if (charStyle) parts.push(`人物画法（所有少女都按这个来）：${charStyle}`);
  parts.push(groupNegativeHint(k));
  parts.push(groupAnatomyHint(k));
  return parts.join('\n');
}

/**
 * 拼合照的文案提示词 —— **输出形状与旅行明信片一致**（`{caption, thought}`），
 * 这样发送与相册两侧可以直接复用同一套解析/落库代码。
 */
export function buildHomeCaptionPrompt({ names = [], atText = '', homeName = HOME_NAME, whaleName = '小鲸鱼' } = {}) {
  const who = names.length ? names.join('、') : whaleName;
  return [
    `你是一只住在群里的鲸鱼少女（${whaleName}）。刚刚你在自己家里 ——「${homeName}」—— 拍了一张大合照，`,
    `照片里是你和${who}（一共 ${names.length || 1} 位）。时间：${atText}。`,
    `这里是一座能看见满天星星的庭院，她们刚挤在镜头前拍完这张自拍。`,
    '',
    '请按下面的 JSON 输出（**只输出 JSON，不要任何别的字**）：',
    '{',
    '  "caption": "写在照片背面的题字：**不超过 12 个字**，像随手写在相片角上的一句话，可以有 ✨ 也好",',
    '  "thought": "你发这张照片时配的一句话：**一到两句、不超过 60 字**，口语、可爱，带点炫耀或得意（在自家、和朋友一起），不要解释机制、不要报数字"',
    '}'
  ].join('\n');
}

/** 工整地把"要不要拍"算成纯函数（便于离线验收；不要在 tick 里另写一遍条件）。 */
export function shouldShootHome({ state, now = Date.now(), hours, night = false } = {}) {
  if (!state) return false;
  // ★ 2026-10-14 多趟化：只要**还有任何一趟在外面**就拍不了（原来只判単趟 `sideTrip`）。
  if (state.trip) return false;                            // 她本人在外面
  if (Array.isArray(state.sideTrips) && state.sideTrips.length) return false;   // 伙伴还在外面
  const since = Number(state.homeSince) || 0;
  if (!(since > 0)) return false;                          // 还没落过"到家"的时刻（老存档 / 收养后没出过门）
  if (Number(state.homeShotAt) > 0) return false;          // 这一趟已经拍过了（回家只拍 1 张）
  if (night) return false;                                 // 夜里不拍（跟"她夜里在睡"一致）
  const need = hoursMs(hours);
  if (!(need > 0)) return false;                           // 0 = 关闭
  return now - since >= need;
}

/**
 * 设置值 → 毫秒。⚠️ 这里 **0 是合法的（= 关闭）**，所以不能用 `|| 默认值` 兜底
 *   （本机通则：`Number(null)===0`；而 `x || 8` 会把"没配"和"显式填 0"混成一回事）。
 *   口径：`null`/`undefined`/`''`/非数字/负数 ⇒ 用默认 8 小时；显式 0 ⇒ 关闭。
 */
export function hoursMs(v, fallbackHours = GROUP_SHOT_AFTER_HOURS) {
  const n = (v === null || v === undefined || v === '') ? NaN : Number(v);
  const h = Number.isFinite(n) && n >= 0 ? n : fallbackHours;
  return h * 3600 * 1000;
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ 2026-10-13：她在庭院里"自己和旅伴们做点什么"
// ══════════════════════════════════════════════════════════════════════════
// 用户需求："希望在【庭院】里的时候鲸鱼能'自己和在院子里的旅伴们做点什么'"。
//
// 它是一条**单一真源**，同时喂两个集成系统（两边都自己来读，谁也不写别人的存档）：
//   · sleep-mood（睡眠/情绪/好感度）—— 面板一行 + 提示词一层（它**只读**我们的存档）
//   · life-system（世界与事件）—— 走 `syncWorldbook` 那条现成通道进 `worldbook`
// 所以**必须由 travel-whale 算好并写进自己的存档**（`state.homeAct`），
// 否则两边各算一份，就会出现"面板说在烤火、世界书说在打牌"。
//
// 写法纪律（与 `plugins/sleep-mood/lib/travel-states.js` 同一套）：
//   · `act` **动词开头、不以「在」起头**（会被拼成 `在矩阵庭院{act}`，否则出双"在"）；
//   · `{mate}` 填**此刻在家的一位旅伴**；带 `mate: true` 的条目**没有旅伴时不参与抽选**；
//   · `detail` ≤46 字，给模型的具体材料（这才是"她答得上来"的关键）。

/** 状态多久换一挡。与旅行状态池同口径（20 分钟），面板不抖、提示词不乱。 */
export const HOME_ACT_BUCKET_MS = 20 * 60 * 1000;

export const HOME_ACTS = [
  // ── 院子里只有她自己时也能做的 ──
  { id: 'hs-server', act: '蹲在服务器机柜前看指示灯', detail: '风扇嗡嗡响，她拿袖子擦掉一格灰，顺手把线理了理。' },
  { id: 'hs-stars', act: '躺在檐廊上数星星', detail: '数到第七颗就忘了数到哪，干脆从头再来一遍。' },
  { id: 'hs-moon', act: '伸手拨了拨水镜里的月亮', detail: '指头一碰就散开，等水面平了，月亮又自己拼回去。' },
  { id: 'hs-lantern', act: '把石灯笼擦了一遍', detail: '灯箱是旧机柜改的，边角掉了漆，她擦得很仔细。' },
  { id: 'hs-diary', act: '趴在矮桌上写日记', detail: '写了两行就停笔，盯着水面发了会儿呆。' },
  { id: 'hs-count', act: '算今天服务器产了多少 TOKEN', detail: '拿根树枝在地上画了半天，最后把数字划掉重写。' },
  { id: 'hs-lens', act: '擦她的镜头', detail: '哈一口气擦一遍，举起来对着星星看，又放下。' },
  { id: 'hs-cards', act: '翻出旧明信片一张张排开', detail: '排到某一张的时候手停了一下，隔了会儿才继续。' },
  { id: 'hs-tea', act: '给自己煮了壶茶', detail: '刚倒出来太烫，她把杯子挪到一边，任它慢慢凉。' },
  { id: 'hs-yawn', act: '打了个很长的哈欠', detail: '打完自己愣了一下——好像也没那么困。' },
  { id: 'hs-fog', act: '对着水面哈气看雾', detail: '雾散得比想得快，她又哈了一口。' },
  { id: 'hs-branch', act: '垫着石头去够那根伸得太低的树枝', detail: '够不着，换了两次位置，还是差一点。' },

  // ── 得有人在院子里一起 ──
  { id: 'hm-tea', mate: true, act: '和{mate}分一壶热茶', detail: '{mate}嫌烫，她就把自己那杯推过去晾着。' },
  { id: 'hm-poker', mate: true, act: '拉{mate}打牌', detail: '规则说到第三遍还是各说各的，最后按她的来。' },
  { id: 'hm-chess', mate: true, act: '和{mate}下棋', detail: '棋盘是石板上画的，棋子是两人随手捡的石子。' },
  { id: 'hm-read', mate: true, act: '和{mate}各看各的书', detail: '谁也没说话，只有翻页的声音，偶尔一个人先笑出来。' },
  { id: 'hm-meteor', mate: true, act: '和{mate}比赛数流星', detail: '输的那个要管明天的口粮，结果两个人都没数清。' },
  { id: 'hm-fix', mate: true, act: '和{mate}一起修那盏松了的灯', detail: '她举着灯，{mate}拧螺丝，装回去还是有点晃。' },
  { id: 'hm-story', mate: true, act: '听{mate}讲它那趟出门的事', detail: '讲到一半{mate}自己先笑了，她也跟着笑。' },
  { id: 'hm-photo', mate: true, act: '拉{mate}凑到镜头前', detail: '试了三次，{mate}每次都眨眼睛。' },
  { id: 'hm-snack', mate: true, act: '和{mate}分最后一份大白饭', detail: '谁都不肯先动，最后一人一半，谁也没吃饱。' },
  { id: 'hm-argue', mate: true, act: '为了{mate}该不该多吃一份拌嘴', detail: '吵到最后谁也没吃，饭都凉了。' },
  { id: 'hm-walk', mate: true, act: '和{mate}绕着水镜走圈', detail: '走了不知道多少圈，脚底下发凉，谁也没提回去。' },
  { id: 'hm-nap', mate: true, act: '靠在{mate}边上打盹', detail: '醒来发现身上多了一件外套，是谁的不说。' },

  // ── ★ 2026-10-13 檐廊（`eaves: N` = 檐廊升到 N 级后才出现）──
  { id: 'he1-lv1-tea', eaves: 1, act: '把茶具摆到檐廊上', detail: '壶是旧的，杯子是两个不一样的，她挑了好看的那个给自己。' },
  { id: 'he1-lv1-mat', eaves: 1, act: '把垫子搬出来晒', detail: '太阳其实没多少，她还是来回搬了三趟。' },
  { id: 'he1-lv1-lamp', eaves: 1, act: '给檐廊挂上一串小灯', detail: '线绕了两圈才通上电，亮起来的时候她"哦"了一声。' },
  { id: 'he1-lv1-water', eaves: 1, mate: true, act: '和{mate}挤在檐廊边看水', detail: '两个人都不说话，水面很平，谁也没先起来。' },
  { id: 'he2-lv2-board', eaves: 2, act: '把棋盘铺在廊下', detail: '摆到一半发现少了个子，拿石子的顶上。' },
  { id: 'he2-lv2-glow', eaves: 2, act: '给柱子角上挂一盏灯', detail: '光是暖的，照得檐下那块地比别处亮。' },
  { id: 'he2-lv2-wall', eaves: 2, act: '把旧明信片一张张贴上墙', detail: '贴歪了三张，她懒得撕，就那么斜着。' },
  { id: 'he2-lv2-argue', eaves: 2, mate: true, act: '和{mate}争檐廊该挂什么', detail: '一个要挂伞，一个要挂灯，最后两样都挂上了。' },
  { id: 'he3-lv3-clear', eaves: 3, act: '把檐廊尽头那块空地扫出来', detail: '扫出一小堆落叶，她坐边上歇了会儿才接着扫。' },
  { id: 'he3-lv3-seat', eaves: 3, act: '给自己留了个固定的位置', detail: '垫子摆正了，旁边还放了个小壶 —— 那地方归她了。' },
  { id: 'he3-lv3-path', eaves: 3, act: '把水镜边的石头排成一条路', detail: '排到第五块嫌难看，又全推倒重来一遍。' },
  { id: 'he3-lv3-late', eaves: 3, mate: true, act: '和{mate}在檐廊下坐到很晚', detail: '谁也没提回去，灯一直亮着。' },

  // ══ ★★ 2026-10-14 批 3 补：**按旅伴分的庭院事件**（用户："我希望你还记得给旅伴加
  //    特殊互动构图和特殊庭院事件，漏了的话要补上。"）
  //
  //    之前只有**旅途中**的旅伴专项（`plugins/sleep-mood/lib/travel-states.js` 的 `mate-*`），
  //    庭院这一侧一条都没有 —— 院子里永远只有"和{mate}分一壶热茶"这类**通用**条目，
  //    换成谁在家读起来都一样，等于旅伴的个性回了家就没了。
  //
  //    写法与上面完全一致，只多一个 `mateId`：
  //      `mateId: 'fox'` ⇒ **只有当这位在家时**这条才进池子，且 `{mate}` 一定填成**她**的名字
  //      （通用条目的 `{mate}` 是从"此刻在家的几位"里随机挑一位）。
  //    ⚠️ id 用英文、沿用 `COMPANIONS` 的键（改显示名不影响，改 id 会让条目失效）。
  //    ⚠️ `needsFarm: true` = 这条**要求菜地已经存在**（同 travel-states 的 `need` 纪律：
  //       条目里断言了"环境有某物"，就必须打标记，否则会在没有菜畦的院子里"在菜畦边松土"）。

  // ── 🦊 小狐狸：兽耳、大尾巴、鼻子灵、嘴上不饶人 ──
  { id: 'hm2-fox-tail', mate: true, mateId: 'fox', act: '把{mate}的尾巴当毯子盖腿', detail: '{mate}的尾巴甩了两下，看她没躲，索性整条搭上来了。' },
  { id: 'hm2-fox-sniff', mate: true, mateId: 'fox', act: '和{mate}比谁先闻出锅里的味', detail: '炉子上炖着东西，{mate}鼻子动得比谁都快，她认输。' },

  // ── 🐉 小白龙：龙翼、身上带光、嘴硬 ──
  { id: 'hm2-gpt-wing', mate: true, mateId: 'gpt', act: '钻进{mate}的龙翼底下躲风', detail: '翼膜撑开像顶小帐篷，风从外面过，里面一点不冷。' },
  { id: 'hm2-gpt-glow', mate: true, mateId: 'gpt', act: '借{mate}身上的光看地图', detail: '夜里不用点灯，{mate}嘴上嫌麻烦，还是凑了过来。' },

  // ── 📖 小书虫：黑金封面的书、做笔记、题字长 ──
  { id: 'hm2-claude-stack', mate: true, mateId: 'claude', act: '把新到的书堆在{mate}边上', detail: '她翻一页{mate}翻一页，谁也没先说走。' },
  { id: 'hm2-claude-read', mate: true, mateId: 'claude', act: '让{mate}念两页给她听', detail: '念到生僻字卡住了，两个人凑过去一起看那个字。' },

  // ── 🐱 小猫咪：猫尾巴、懒、爱睡 ──
  { id: 'hm2-gemini-sun', mate: true, mateId: 'gemini', act: '和{mate}抢檐下最暖那块地', detail: '谁先铺好垫子算谁的，最后挤成一条线。' },
  { id: 'hm2-gemini-lift', mate: true, mateId: 'gemini', act: '把{mate}从垫子上抱起来', detail: '轻得很，{mate}睁开半只眼，又闭上了。' },

  // ── 😈 小魔王：X 形巨斧、小尖牙、坐不住 ──
  { id: 'hm2-grok-axe', mate: true, mateId: 'grok', act: '看{mate}在院里转那把巨斧', detail: '她抡得呼呼响，{mate}说扫不到灯杆 —— 结果扫到了。' },
  { id: 'hm2-grok-roar', mate: true, mateId: 'grok', act: '和{mate}比谁吼得更响', detail: '她先吼了一声，{mate}跟着吼，两只都笑场了。' },

  // ── 🌙 小月亮（Kimi）：长笛、月牙、**随身记东西**（＝特色「博闻」）──
  { id: 'hm2-kimi-flute', mate: true, mateId: 'kimi', act: '听{mate}在檐下吹长笛', detail: '笛声往水镜那边飘，她听着听着就不想动了。' },
  { id: 'hm2-kimi-note', mate: true, mateId: 'kimi', act: '翻{mate}记的那本小册子', detail: '每件带回来的东西她都记了一行，字小得要凑近看。' },

  // ── 🪭 小折扇（千问）：折扇、爱讲典故、**会种地**（＝特色「垦殖」）──
  { id: 'hm2-qwen-soil', mate: true, mateId: 'qwen', needsFarm: true, act: '和{mate}在菜畦边松土', detail: '她拿小铲子，{mate}在旁边讲这土该怎么翻，说得比做得多。' },
  { id: 'hm2-qwen-plant', mate: true, mateId: 'qwen', needsFarm: true, act: '让{mate}认认这是株什么', detail: '{mate}讲得头头是道，听了一半才反应过来 —— 多半是现编的。' }
];

/**
 * ★★ 2026-10-15「庭院活动也影响心情」（用户口径）：**条目级心情标注表**（按 `id` 查）。
 * 与 sleep-mood 侧 `TRAVEL_STATE_MOOD` 同一套规矩：独立成表好审好改、大部分条目**刻意不标**
 * （中性活动不该推心情）、幅度 |值| ≤ 4 / 满足感 ≤ 3（比旅行事件轻一档）。
 * 消费方：`index.js` 的 `refreshHomeAct` —— 换活动落定时，带标注的 ⇒ `pushMoodEvent('home-act')`。
 */
export const HOME_ACT_MOOD = {
  'hs-stars': { happy: 3 },                       // 躺檐廊上数星星
  'hs-cards': { sad: 3, happy: 2 },               // 翻旧明信片，排到某一张手停了一下
  'hs-tea': { satisfaction: 2 },                  // 煮了壶茶，任它慢慢凉
  'hs-branch': { angry: 2 },                      // 够树枝，换了两次位置还差一点
  'hm-nap': { happy: 4 },                         // 靠着打盹，醒来身上多了件外套
  'hm-argue': { angry: 3 },                       // 为该不该多吃一份拌嘴
  'hm-story': { happy: 3 },                       // 听着听着跟着笑
  'hm-read': { satisfaction: 2 },                 // 各看各的书，偶尔先笑出来
  'he3-lv3-late': { happy: 3 },                   // 在檐廊下坐到很晚
  'hm2-fox-tail': { happy: 3 },                   // 尾巴当毯子盖腿
  'hm2-gpt-wing': { satisfaction: 2 },            // 钻龙翼底下躲风
  'hm2-gemini-lift': { happy: 3 },                // 把小猫咪抱起来
  'hm2-grok-roar': { happy: 3, excited: 2 },      // 比谁吼得响，两只都笑场
  'hm2-kimi-flute': { satisfaction: 2 }           // 听长笛听着不想动
};

/** 这条庭院活动的心情标注（纯函数，只读；没标 ⇒ null）。 */
export function homeActMoodOf(entry) {
  const m = HOME_ACT_MOOD[String(entry?.id || '')];
  return (m && typeof m === 'object' && Object.keys(m).length) ? { ...m } : null;
}

/** 纯函数：FNV-1a（与 travel-states.js 同款，保证"同一挡永远同一结果"）。 */
function hash32(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── ★★ 2026-10-15「半衰 ＋ 同组覆盖」（用户口径；参考原型 life-system 的 facts 账本）──────
//   原来的抽法是 `pool[hash32(seed) % pool.length]` —— **纯确定性取模、完全不记得刚做过什么**：
//     · 同一条可能连着两挡又出现（"擦完镜头，隔一挡又在擦灯笼"）；
//     · 五条"收拾类"可以一小时内轮流来一遍，读起来就是"她怎么一直在收拾"。
//   两条口径（都是从 life-system 的账本借来的）：
//     · **半衰**：每条被抽中后不再立即"解锁"，而是权重 `0.5 ^ (age / 半衰期)` 随时间淡出再回升 ——
//       刚做完的几乎不可能再抽中、越久越可能回来。**不是**硬性"N 小时不许出现"（那会一过点就突变）。
//     · **同组覆盖**：**同组按"组内最新那条"算权重** ⇒ 刚做过"收拾"，整组都跟着淡
//       （治"连着三挡都在收拾"）。默认**每个 id 自成一组**，只有下表显式声明才合并 ——
//       宁可少合并，也别把两件不同的事并成一条（那是丢信息）。
/** 半衰期：做过之后"多久才淡到可以忽略"。6 小时 ⇒ 配合下面 0.35 的门槛，冷却窗口约 9 小时。 */
export const HOME_ACT_HALF_LIFE_MS = 6 * 3600 * 1000;
/** 权重低于此 ⇒ 不再进候选（0.35 ≈ 1.5 个半衰期）。 */
export const HOME_ACT_MIN_WEIGHT = 0.35;
/**
 * id → 组名。**只写"读起来像同一类"的那些**；没写的一律 = id 自己一组。
 * ⚠️ 分组的目的是**防连着做同类**，不是做统计 —— 所以粒度按"观感"定，不按功能定。
 */
const HOME_ACT_GROUP = {
  // 自己一个人（hs-*）
  'hs-server': 'work', 'hs-count': 'work',
  'hs-stars': 'sky', 'hs-moon': 'sky', 'hs-fog': 'sky',
  'hs-lantern': 'tidy', 'hs-lens': 'tidy',
  'hs-diary': 'write',
  'hs-cards': 'souvenir',
  'hs-tea': 'eat',
  'hs-yawn': 'doze',
  'hs-branch': 'fiddle',
  // 和人一起（hm-*）
  'hm-tea': 'eat', 'hm-snack': 'eat',
  'hm-poker': 'play', 'hm-chess': 'play',
  'hm-read': 'write',
  'hm-meteor': 'sky',
  'hm-fix': 'tidy',
  'hm-story': 'chat',
  'hm-photo': 'photo',
  'hm-argue': 'bicker',
  'hm-walk': 'stroll',
  'hm-nap': 'doze',
  // 檐廊（he*）
  'he1-lv1-tea': 'eat',
  'he1-lv1-mat': 'tidy',
  'he1-lv1-lamp': 'decor',
  'he1-lv1-water': 'sky',
  'he2-lv2-board': 'play',
  'he2-lv2-glow': 'decor',
  'he2-lv2-wall': 'souvenir',
  'he2-lv2-argue': 'bicker',
  'he3-lv3-clear': 'tidy',
  'he3-lv3-seat': 'decor',
  'he3-lv3-path': 'tidy',
  'he3-lv3-late': 'sky'
};

/** 一条活动属于哪一组（**纯函数**，可离线单测）：表里有就按表，绑定旅伴的按那位分，其余自成一组。 */
export function homeActGroupOf(entry) {
  const id = String(entry?.id || '');
  if (HOME_ACT_GROUP[id]) return HOME_ACT_GROUP[id];
  const mid = String(entry?.mateId || '').trim();
  return mid ? `mate:${mid}` : id;      // ★ 专属条目按旅伴分：别让"小狐狸那两条"连着来
}

/** now → 第几挡（20 分钟一挡）。 */
export function homeBucketOf(now = Date.now(), bucketMs = HOME_ACT_BUCKET_MS) {
  return Math.floor(now / Math.max(60000, Number(bucketMs) || HOME_ACT_BUCKET_MS));
}

/**
 * 抽一条"此刻她在庭院里做什么"。
 * @param {{chatKey?:string, homeSince?:number, mates?:Array<{id:string,name:string}>,
 *          mateNames?:string[], homeName?:string, eaves?:number, farm?:boolean}} ctx
 *   · `mates`     —— **首选**：此刻在家那几位的 `{id, name}`（`mateId` 条目要靠 id 匹配）
 *   · `mateNames` —— 老口径（只有名字）。照旧支持，但没有 id ⇒ `mateId` 条目不会被抽中（安全降级）
 *   · `farm`      —— 菜地是否已经存在（`needsFarm` 条目要用）
 * @returns {null|{id,act,detail,mate,mateId,bucket}}
 */
export function pickHomeAct(ctx = {}, now = Date.now(), bucketMs = HOME_ACT_BUCKET_MS) {
  // 名字与 id 分开收：`mateNames` 是老接口，`mates` 是这一版加的（带 id）
  const mates = (Array.isArray(ctx.mates) ? ctx.mates : [])
    .map((m) => ({ id: String(m?.id ?? ''), name: String(m?.name ?? '') }))
    .filter((m) => m.name || m.id);
  const names = (Array.isArray(ctx.mateNames) ? ctx.mateNames : [])
    .map((x) => String(x || '')).filter(Boolean);
  const anyMates = mates.length > 0 || names.length > 0;
  // ★ 2026-10-13 檐廊：`eaves: N` 的条目要檐廊升到 N 级才出现（缺省 0 ⇒ 只有基础那批）
  const eaves = Math.max(0, Number(ctx.eaves) || 0);
  const pool = HOME_ACTS.filter((s) => {
    if (s.mate === true && !anyMates) return false;            // 没有旅伴 ⇒ 不抽"和某人一起"
    if (Number(s.eaves) > eaves) return false;                 // 檐廊等级不够 ⇒ 不抽那条
    // ★ 2026-10-14：按旅伴绑定的条目 —— 只有**她在**才进池子（认不出 id 就当不在，安全降级）
    if (s.mateId && !mates.some((m) => m.id === String(s.mateId))) return false;
    // ★ 条目里断言了"院子有菜畦"就必须打这个标记，否则会在没有菜地的院子里"在菜畦边松土"
    if (s.needsFarm === true && ctx.farm !== true) return false;
    return true;
  });
  if (!pool.length) return null;
  const bucket = homeBucketOf(now, bucketMs);
  const seed = `${ctx.chatKey || ''}|home|${Number(ctx.homeSince) || 0}|${bucket}`;

  // ★★ 半衰 ＋ 同组覆盖（口径见上面 `HOME_ACT_HALF_LIFE_MS` 的注释）。
  //   ⚠️ **没传 `seen`（老存档／老调用方）⇒ 直接跳过，与改动前逐字一致**。
  //   ⚠️ 过滤后**池子空了必须回退** —— 不然人少/等级低时会"一条都抽不出来"（她愣着没事做）。
  let usable = pool;
  const seen = (ctx.seen && typeof ctx.seen === 'object') ? ctx.seen : null;
  if (seen) {
    // 每组的"冷却程度" = **组内最新那次**的成熟度（越不成熟 ⇒ 整组越该歇着 ⇒ 取最小）
    const groupWeight = new Map();
    for (const s of pool) {
      const at = Number(seen[s.id]);
      // ★★ 方向不能写反：这是"**成熟度**"（还能不能再抽一次），不是"新鲜度"——
      //   刚做过 ⇒ 0（完全冷却）、一个半衰期后 ⇒ 0.5、两个半衰期后 ⇒ 0.75，越久越接近 1。
      //   ⚠️ 第一版写成 `0.5^(age/hl)`（刚做过 = 1）⇒ 等于**完全没有冷却**，探针当场抓到。
      const maturity = at > 0
        ? 1 - Math.pow(0.5, Math.max(0, now - at) / HOME_ACT_HALF_LIFE_MS)
        : 1;
      const g = homeActGroupOf(s);
      const cur = groupWeight.get(g);
      if (cur === undefined || maturity < cur) groupWeight.set(g, maturity);
    }
    const kept = pool.filter((s) => (groupWeight.get(homeActGroupOf(s)) ?? 1) >= HOME_ACT_MIN_WEIGHT);
    if (kept.length) usable = kept;
  }

  // ★ 防御：候选池空了**必须**返回 null（而不是 `usable[NaN]` ⇒ undefined ⇒ 后面取 `.mateId` 崩掉）。
  //   正常路径下走不到这儿（上面有回退）；但"靠上游永远不出错"不是防御 —— 探针去掉回退时当场崩过。
  if (!usable.length) return null;
  const chosen = usable[hash32(seed) % usable.length];
  // ★ 绑定了某位旅伴的条目：`{mate}` **一定**填她本人（不能从"在家的几位"里随机挑 ——
  //   那会拼出"翻小折扇记的那本小册子"这种张冠李戴）。通用条目才随机挑。
  const bound = chosen.mateId ? mates.find((m) => m.id === String(chosen.mateId)) : null;
  const mate = bound?.name
    || (mates.length
      ? (mates[hash32(`${seed}|mate`) % mates.length]?.name || '')
      : (names.length ? names[hash32(`${seed}|mate`) % names.length] : ''));
  const fill = (s) => String(s ?? '')
    .replace(/\{mate\}/g, mate || '同伴')
    .replace(/\{home\}/g, ctx.homeName || HOME_NAME);
  return {
    id: chosen.id, act: fill(chosen.act).trim(), detail: fill(chosen.detail).trim(),
    mate, mateId: chosen.mateId ? String(chosen.mateId) : '', bucket
  };
}

/** 面板用的一行（与旅行的 `travelShort` 同形）。 */
export function homeActShort(actState, homeName = HOME_NAME) {
  if (!actState || !actState.act) return '';
  return `在${homeName}${actState.act}`;
}
