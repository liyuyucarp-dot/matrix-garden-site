// 矩阵庭院 · 服装（衣柜）—— 2026-10-14 用户新玩法
//
// 口径（用户逐条拍的）：
//   · **跟异世界挂钩**：每套挂在一个**子区域**（regions.json 的 `countries[].name`）上；
//   · **解锁放宽**：**她本人 *或* 闲置伙伴去过**那个子区域即可买（原口径"只认她本人"）；
//   · **手动换装 + 随机换装**（用户明确**不要**"按目的地自动穿"）；
//   · **2000 亿 / 套**；套数**看 `OUTFITS.length`**（初版 39 套 → v3.0 加了三个世界的新旅伴款到 60）。
//     ⚠️ 别再在注释/文案里写死套数 —— 加套之后"39"就成了假话（§98 的数字漂移通病）。
//
// ⚠️ 两条别踩：
//   ① `area` 必须与 `regions.json` 里 `countries[].name` **逐字一致** —— 解锁是按这个名字查的；
//   ② `wear` 是一段**生图提示词片段**，它替换角色描述里的 `{{WEAR}}` 占位符（见 `postcard.js`）。
//      **必须自带鞋/袜**（因为占位符的位置在"两条腿"那句之后、鲸尾那句之前），
//      而且**不要写 Markdown 的 `**`** —— 生图模型不认那些星号（同 `postcard.js` 的纪律）。
//
// ★ 「只换衣服」的纪律：发色/瞳色/脸型、耳朵/尾巴/龙角龙翼、随身物（小魔王的巨斧、
//   小书虫怀里的书、小猫咪满身四角星）**一律不在这里**，它们在 `postcard.js` 的模板里原样保留。

/** 单套价格（亿 TOKEN）。用户口径："2000 亿不错"。 */
export const OUTFIT_PRICE = 2000;

/** 六位少女（衣柜界面按这个顺序排）。`id` 与 `state.js` 的 COMPANIONS 对齐；`whale` 是她本人。
 *
 *  ⚠️ **2026-10-28：这张表已降级为「兜底」**，不再是权威名册。
 *     坑：这里写死 8 个、注释说"与 COMPANIONS 对齐"，但 persona 已经能热插拔
 *     （`persona/companions.json` 可整体替换 COMPANIONS），衣柜这张表没跟着走 ⇒
 *     换角色后新旅伴在衣柜里"不存在"，`whale_wear` 直接回「没有叫「X」的少女」。
 *     现在权威来源是 `wardrobeGirls()`（从 COMPANIONS 派生）；本常量只在拿不到
 *     名册时兜底（组件单独运行、或调用方没传 companions）。
 */
export const WARDROBE_GIRLS = [
  { id: 'whale', name: '小鲸鱼', emoji: '🐋' },
  { id: 'fox', name: '黑发兽耳小狐狸', emoji: '🦊' },
  { id: 'gpt', name: '小白龙', emoji: '🐉' },
  { id: 'claude', name: '小书虫', emoji: '📖' },
  { id: 'gemini', name: '小猫咪', emoji: '🐱' },
  { id: 'grok', name: '小魔王', emoji: '😈' },
  // ★ v3.0（2026-10-14）：两位新旅伴。**显示名可随时改，id 不能改**（存档记的是它）
  { id: 'kimi', name: 'Kimi', emoji: '🌙' },
  { id: 'qwen', name: '千问', emoji: '🪭' }
];

/** 她本人的 girl id（**永远存在**，不在 COMPANIONS 里 —— 她是主体不是旅伴）。 */
export const SELF_GIRL_ID = 'whale';

/**
 * 衣柜"少女"名册 —— **单一真相源**（2026-10-28 修「衣柜锁角色」）。
 *
 * 顺序：本人（`whale`，显示名取当前 persona 的 `whaleName`）→ 当前全部旅伴（按 COMPANIONS 声明序）。
 * 拿不到 `companions`（没传/为空）时回退 {@link WARDROBE_GIRLS}，保证组件单独跑也不炸。
 *
 * @param {{companions?:object, selfName?:string}} [opts]
 * @returns {Array<{id:string,name:string,emoji:string,self?:boolean}>}
 */
export function wardrobeGirls({ companions = null, selfName = '' } = {}) {
  const roster = companions && typeof companions === 'object' && Object.keys(companions).length ? companions : null;
  if (!roster) return WARDROBE_GIRLS.map((g) => ({ ...g }));
  const mates = Object.values(roster)
    .filter((c) => c && c.id && String(c.id) !== SELF_GIRL_ID)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name || c.id),
      emoji: String(c.emoji || ''),
      // ★ 2026-10-28 评审补：把 COMPANIONS 的别名带过来（"小狐狸/狐狸/GLM/智谱" 都是她）。
      //   不带的话，群友喊别名就匹配不到人了。
      aliases: Array.isArray(c.aliases) ? c.aliases.map(String).filter(Boolean) : []
    }));
  const selfName0 = String(selfName || '').trim();
  const self = {
    id: SELF_GIRL_ID,
    name: selfName0 || '小鲸鱼',
    emoji: '🐋',
    self: true,
    // ★ 2026-10-28 评审补：显示名可能被换成 persona 的名字（换成 persona 里的名字），
    //   但群友/模型仍然会说「小鲸鱼」「鲸鱼」—— 这些别名必须留着，否则换名即失联。
    aliases: ['小鲸鱼', '鲸鱼', ...(selfName0 && selfName0 !== '小鲸鱼' ? ['小鲸鱼'] : [])]
  };
  return [self, ...mates];
}

/**
 * 某位少女现在**能穿**哪些套。
 *
 * ★★ 2026-10-28（用户拍板，第二次改口径）：**服装不再绑角色，改绑世界/地区** ——
 *    「任何角色都可以自由更换任何服装」。解锁条件仍是"去过那个子区域"（`region|area`），
 *    衣服本身挂在世界上（`region`/`area`），跟谁能穿无关。
 *
 *    所以这里**不再按 `who` 过滤**，直接返回全部。`who` 字段保留，但语义降级为
 *    **「原型/出处」**（这套最早是照谁的样子做的）——只在衣柜页当一列展示，不参与任何判定。
 *    这样存档零迁移：`worn[girlId]` 还是"谁现在穿哪套"，只是可穿集合放开。
 *
 * @param {string} _girlId 保留参数（调用方不必改），现在不影响结果
 * @param {{companions?:object}} [_opts] 保留（旧调用方传了也无害）
 */
export function outfitsFor(_girlId, _opts = {}) {
  return OUTFITS.slice();
}

/**
 * 服装表（**套数看 `.length`，别照抄这里的数字**）。
 *   id     —— 存档里记的键（**英文，别改**：改了就丢已解锁进度）
 *   name   —— 显示名
 *   region —— 地区 id（给"按地区分组"用）
 *   area   —— **子区域名**（解锁判据；必须与 regions.json 逐字一致）
 *   who    —— **【已降级】原型/出处**：这套最早是照谁的样子做的。2026-10-28 起**不再限制谁能穿**
 *              （用户拍板："任何角色都可以自由更换任何服装"），只在衣柜页当一列展示。
 *   price  —— 亿 TOKEN
 *   wear   —— 换上去的那段提示词（含鞋袜；见文件头 ②）
 */
export const OUTFITS = [
  // ── 战锤 40K（10 个子区域 → 3 套）───────────────────────────────────────
  {
    id: 'mechanicus', name: '机械神教红袍', region: 'warhammer40k', area: '太阳系',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿暗红色的机械神教长袍（袍面绣着齿轮与骷髅纹样、带着兜帽），颈间垂着一串黄铜色的机械触须挂饰，'
      + '双手戴着黄铜义肢手套；脚上是一双厚重的深色长靴'
  },
  {
    id: 'ultramarine', name: '极限战士蓝甲', region: 'warhammer40k', area: '奥特拉玛',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿钴蓝与金相间的动力甲（胸甲正中一枚倒 Ω 纹章、肩甲宽厚），甲内衬着深色的紧身作战服；'
      + '脚上是银灰色的装甲长靴；头盔抱在臂弯里'
  },
  {
    id: 'spacewolf', name: '太空野狼装束', region: 'warhammer40k', area: '芬里斯星系',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿灰蓝色的粗犷甲胄，肩上披一张厚实的狼皮披肩，腰间挂着符文石与一只酒角；'
      + '脚上是带绑带的狼皮战靴；头发束成高高的马尾'
  },

  // ── 中土世界（9 → 3）────────────────────────────────────────────────────
  {
    id: 'hobbit', name: '霍比特人装束', region: 'middleearth', area: '夏尔',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿一件系扣的针织马甲配上卷边的短裤，肩上一件小斗篷，斜挎一只旧皮包；'
      + '脚上是一双柔软的皮质便鞋'
  },
  {
    id: 'elven', name: '精灵长袍', region: 'middleearth', area: '瑞文戴尔',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿灰绿色的精灵长袍（袍面织着金色的叶片纹样），肩口别着一枚银叶胸针，外罩一层薄纱斗篷；'
      + '脚上是银色的软底长靴'
  },
  {
    id: 'rohirrim', name: '骠骑装束', region: 'middleearth', area: '洛汗',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿锁子甲外罩的皮革战裙（肩部与腰际有洛汗的太阳马纹），腰间佩一把短剑与一只号角；'
      + '脚上是翻口的皮靴；长发编成一条长辫'
  },

  // ── 维斯特洛（10 → 4）───────────────────────────────────────────────────
  {
    id: 'stark', name: '史塔克', region: 'westeros', area: '北境',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿灰蓝色的厚呢长裙，肩上披一件冰原狼纹样的毛领斗篷，衣角绣着冰原狼；'
      + '脚上是深色的厚底靴'
  },
  {
    id: 'lannister', name: '兰尼斯特', region: 'westeros', area: '西境',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿绯红与金相间的长裙（腰封与袖口绣着金狮纹章），肩后披一件绯红斗篷，发间与腕上都有金饰；'
      + '脚上是猩红色的缎面高靴'
  },
  {
    id: 'targaryen', name: '坦格利安', region: 'westeros', area: '王领',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿黑底红纹的长裙与长斗篷（衣面绣着三头龙的纹样），发间戴着银白色的龙纹发饰；'
      + '脚上是黑色的长靴'
  },
  {
    id: 'martell', name: '马泰尔', region: 'westeros', area: '多恩',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿橙金与沙色的露肩轻纱长裙（层层垂坠、腰间一枚金色的太阳纹），手腕绕着细金链；'
      + '脚上是露趾的皮质凉鞋'
  },

  // ── 提瓦特（6 → 5）──────────────────────────────────────────────────────
  {
    id: 'mondstadt', name: '西风骑士团制服', region: 'teyvat', area: '蒙德',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿白蓝色调的骑士团制服外套（立领、肩部有风车菊羽饰、背后一件短披风），下配白色短裙；'
      + '脚上是皮质短靴；背后缀着一对小巧的风之翼装饰'
  },
  {
    id: 'liyue', name: '璃月锦缎旗袍', region: 'teyvat', area: '璃月',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿月白色的锦缎旗袍（立领盘扣、金线云纹、高开衩），外披一层薄纱披肩；'
      + '脚上是白色的缎面高跟鞋'
  },
  {
    id: 'inazuma', name: '振袖和服', region: 'teyvat', area: '稻妻',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿紫底樱花纹样的大振袖和服，腰间束一条金襕织的宽腰带（背后打成大蝴蝶结）；'
      + '脚上踩着木屐与白色足袋'
  },
  {
    id: 'sumeru', name: '学者长袍', region: 'teyvat', area: '须弥',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿绿白相间的学者长袍（袍角有草叶与书卷的纹样），头上缠着一条垂纱巾与额饰，腰间挂一只书卷袋；'
      + '脚上是赤足的凉鞋'
  },
  {
    id: 'snezhnaya', name: '愚人众大衣', region: 'teyvat', area: '至冬',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿白底黑银边的高领长大衣（肩线挺硬、袖口有银色扣环），内衬深色制服；'
      + '脚上是黑色的军靴；腰侧挂着一副半截面具'
  },

  // ── 艾泽拉斯（5 → 3）────────────────────────────────────────────────────
  {
    id: 'stormwind', name: '联盟板甲', region: 'azeroth', area: '东部王国',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿蓝金相间的板甲（胸甲正中一枚狮首纹章，甲面各处点缀着四角星的铆钉），肩后披一件蓝色披风；'
      + '脚上是银色的装甲长靴'
  },
  {
    id: 'darnassus', name: '暗夜精灵装束', region: 'azeroth', area: '卡利姆多',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿紫色的轻甲（肩部与腰际有银色的月牙纹样），外披一件长斗篷，发间别着银月发饰；'
      + '脚上是银色的软靴'
  },
  {
    id: 'kirintor', name: '肯瑞托法袍', region: 'azeroth', area: '诺森德',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿紫金相间的法袍（宽大的袖口、兜帽内衬星辉刺绣），腰间挂着几本魔法书；'
      + '脚上是深紫色的软底长靴'
  },

  // ── 海拉鲁（6 → 3）──────────────────────────────────────────────────────
  {
    id: 'hylianknight', name: '海拉鲁骑士甲', region: 'hyrule', area: '中央海拉鲁',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿蓝白相间的骑士甲（胸甲上有三角神力的纹章），肩后一件短披风，腰间佩一把长剑；'
      + '脚上是白色的装甲长靴'
  },
  {
    id: 'sheikah', name: '希卡忍者装束', region: 'hyrule', area: '卡卡利科',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿深蓝色的紧身忍装（胸前与腰际有希卡之眼的纹样），脸上戴着遮住下半脸的面罩与额带，'
      + '手臂缠着束带、腰间挂着忍具袋；脚上是无声的软底忍靴'
  },
  {
    id: 'zora', name: '卓拉族装束', region: 'hyrule', area: '卓拉',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿银蓝色的鳞甲上衣与长褶裙（鳞片泛着水光），手臂与发间缀着鱼鳍形状的饰品，胸前嵌一枚水色的宝石；'
      + '脚上是水蓝色的软底鞋'
  },

  // ── 星际争霸（5 → 3）────────────────────────────────────────────────────
  {
    id: 'ghost', name: '幽灵特工作战服', region: 'starcraft', area: '泰伦帝国',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿黑银相间的紧身作战服（肩部有装甲片、胸前一枚指示灯），一副红色的目镜推在额头上，'
      + '背后一件短披风；脚上是厚底的作战靴'
  },
  {
    id: 'templar', name: '圣堂武士长袍', region: 'starcraft', area: '神族家园',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿白金相间的长袍（肩部有水晶饰件、衣料上流着发光的纹路），手腕上戴着灵能护腕；'
      + '脚上是银色的长靴'
  },
  {
    id: 'queenofblades', name: '刀锋女王装束', region: 'starcraft', area: '虫群领域',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿黑紫相间的甲壳质紧身装（肩部有骨刺护甲、背后张开一对半透明的甲翅），长发向后扬起；'
      + '脚上是与甲壳连成一体的战靴'
  },

  // ── 东方 Project（9 → 4）────────────────────────────────────────────────
  {
    id: 'miko', name: '巫女服', region: 'touhou', area: '幻想乡中央',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿白衣朱袴的和风巫女装束（白色小袖上衣配上朱红色的袴裙），袖口与腰带上缀着注连绳与纸垂的纹样；'
      + '头上系着一条红色的巫女发带；脚上是白色足袋与草履'
  },
  {
    id: 'witch', name: '魔女装束', region: 'touhou', area: '幻想乡森林',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿黑白相间的女巫连衣裙（白色围裙、黑色泡泡袖），头戴一顶尖顶大黑帽、帽上系着白色缎带；'
      + '脚上是黑色的小皮鞋；手里拎着一把扫帚'
  },
  {
    id: 'tengu', name: '天狗装束', region: 'touhou', area: '幻想乡山岳',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿山伏式的白衣与黑袴（胸前系着一颗毛茸茸的球饰），背后展开一对黑色的羽翼，手里握着一把团扇；'
      + '脚上踩着高齿木屐'
  },
  {
    id: 'lunar', name: '月之羽衣', region: 'touhou', area: '月面',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿银白色的羽衣长裙（肩上垂落一层轻纱、裙面有月相的纹样），耳畔戴着玉兔形状的耳饰，'
      + '手里握着一把团扇；脚上是银色的软底鞋'
  },

  // ── 机动战士高达（4 → 2）────────────────────────────────────────────────
  {
    id: 'fed', name: '联邦军制服', region: 'gundam', area: '地球联邦',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿白底蓝饰的联邦军夹克（立领、双排扣、肩章），颈间系一条领巾，下配白色长裤；'
      + '脚上是白色的长筒靴'
  },
  {
    id: 'zeon', name: '吉翁军服', region: 'gundam', area: '宇宙殖民地',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿深绿与紫相间的军官制服（立领、袖口有吉翁的纹章、肩章与绶带），头戴一顶大檐军官帽；'
      + '脚上是黑色的长筒靴'
  },

  // ── 交界地（8 → 3）──────────────────────────────────────────────────────
  {
    id: 'redmane', name: '红狮子铠甲', region: 'landsbetween', area: '盖利德',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿红金相间的重甲（胸甲上有狮首的浮雕），背后披一件破损的红披风；脚上是沉重的金属战靴'
  },
  {
    id: 'erdtree', name: '黄金树骑士铠甲', region: 'landsbetween', area: '亚坛高原',
    who: 'gpt', price: OUTFIT_PRICE,
    wear: '穿金与黑相间的骑士铠甲（甲面浮雕着黄金树的纹样），肩后披一件猩红的披风；'
      + '脚上是金色的装甲长靴；头盔抱在臂弯里'
  },
  {
    id: 'nokron', name: '夜之贵族装束', region: 'landsbetween', area: '永恒之城',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿黑银相间的长袍（袍面绣着星辉纹样），兜帽压得很低，腰间挂着一副银面具；'
      + '脚上是无声的软底靴'
  },

  // ── 费伦（7 → 3）────────────────────────────────────────────────────────
  {
    id: 'waterdeep', name: '贵族礼服', region: 'faerun', area: '剑湾',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿深蓝与金的天鹅绒礼服（收腰、袖口垂下蕾丝），肩后一件短披风，腰间佩一把细剑；'
      + '脚上是深蓝色的高跟长靴'
  },
  {
    id: 'drow', name: '卓尔精灵装束', region: 'faerun', area: '幽暗地域',
    who: 'grok', price: OUTFIT_PRICE,
    wear: '穿黑紫相间的紧身甲（肩部与腰际有蛛网的纹样），披一件深色斗篷，腰间盘着一条长鞭、缀着银饰；'
      + '脚上是黑色的长靴'
  },
  {
    id: 'redwizard', name: '红袍法师装束', region: 'faerun', area: '东部疆域',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿猩红色的长袍（带兜帽，袖口绣着符文，脸颊与手背上有刺青式的纹路），腰间挂着法术书；'
      + '脚上是红色的软底靴'
  },

  // ── 诡秘之主（6 → 3）────────────────────────────────────────────────────
  {
    id: 'victorian', name: '维多利亚礼服', region: 'mysteries', area: '鲁恩王国',
    who: 'fox', price: OUTFIT_PRICE,
    wear: '穿黑色的束腰长裙（高领蕾丝、裙摆层层褶皱），头戴一顶小礼帽配半面纱，手上戴着白手套，'
      + '手里握一根细手杖；脚上是黑色的高跟靴'
  },
  {
    id: 'explorer', name: '探险装束', region: 'mysteries', area: '荒野与秘境',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿短夹克与耐磨长裤（腰带上挂着工具袋），额头上架着一副护目镜，背着一只大背包、手里提一盏汽灯；'
      + '脚上是结实的长靴'
  },
  {
    id: 'tarot', name: '塔罗占卜师长袍', region: 'mysteries', area: '非凡领域',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿黑紫相间的长袍（袍面绣着星纹与月相、兜帽压着半张脸），腰间垂着一叠塔罗牌，周身浮着淡淡的微光；'
      + '脚上是深色的软底鞋'
  },
  {
    id: 'leitania-uniform', name: '音乐之国学院制服', region: 'arknights', area: '莱塔尼亚',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一身深蓝与白相间的学院制服（立领短外套、袖口滚着金色镶边与音符纹刺绣、胸前别着一枚小小的银色琴徽），下身是白色及膝裙，腿上穿白色连裤袜；脚上是一双深蓝色系带小皮鞋'
  },
  {
    id: 'shelag-parka', name: '雪境厚袍', region: 'arknights', area: '谢拉格',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一件厚实的银白色长袍（领口与袖口镶着蓬松的白色毛边、腰间束一条编织绳带），袍下是深色长裤；脚上是一双毛里短靴'
  },
  {
    id: 'shuiyue-gauze', name: '水月宫纱衣', region: 'pal', area: '仙灵岛',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一层水色与月白叠着的广袖纱衣（衣料半透、走动时像水波，腰上系一条银丝编的细带），下身是同色长裙；脚上是一双白色绣花软缎鞋'
  },
  {
    id: 'fengdu-lantern', name: '夜行提灯装', region: 'pal', area: '酆都',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一身玄青色的窄袖夜行衣（外罩一件短斗篷、衣摆绣着暗银色的灯纹），腰间系着一条垂着小铜铃的细带；脚上是一双黑色软底布靴'
  },
  {
    id: 'pacifica-stage', name: '霓虹舞台礼服', region: 'nightcity', area: '太平洲',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一件深蓝紫色的露肩长裙（裙面缀着会反光的银色亮片、腰间一条细细的银链），肩上搭一件半透的披纱；脚上是一双银色细带高跟凉鞋'
  },
  {
    id: 'heywood-busker', name: '街头乐手装', region: 'nightcity', area: '海伍德',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一件宽松的米白色针织上衣（外面套一件深蓝色短夹克、袖口有些磨旧），下身是深色直筒长裤；脚上是一双旧旧的白色运动鞋'
  },
  {
    id: 'fontaine-opera', name: '歌剧院礼服', region: 'teyvat', area: '枫丹',
    who: 'kimi', price: OUTFIT_PRICE,
    wear: '穿一条水蓝与银白相间的歌剧礼服（上身是束腰的缎面小立领、裙摆是层层叠叠的薄纱，肩上披一件短披风），腰后系着一只大大的银色蝴蝶结；脚上是一双银色缎面高跟'
  },
  {
    id: 'shushan-robe', name: '蜀山道袍', region: 'pal', area: '蜀山',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一身月白与靛蓝相间的道袍（宽袖交领、衣襟与袖口滚着一圈深色镶边，腰上束一条靛蓝布带、挂着一枚铜钱剑穗），下身是同色长裙；脚上是一双白色布靴'
  },
  {
    id: 'lungmen-casual', name: '龙门便服', region: 'arknights', area: '龙门',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一件靛蓝色的立领短上衣（领口与门襟缝着深色滚边、衣摆开衩），下身是深色长裤，腰间系着一条细细的红绳；脚上是一双黑色软底短靴'
  },
  {
    id: 'nanzhao-ritual', name: '巫女祭服', region: 'pal', area: '南诏',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一身朱红与墨黑相间的祭祀长袍（衣上绣着银色的水纹与蛇纹、肩部垂着银片串成的流苏），腰上束一条宽幅织锦带；脚上是一双黑底绣银线的布靴'
  },
  {
    id: 'citycenter-suit', name: '企业高管西装', region: 'nightcity', area: '市中心',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一身剪裁利落的深灰西装（衬衫是浅灰的丝质立领、扣着一枚银色领针，外面套同色的长外套），下身是同色长裤；脚上是一双黑色尖头低跟鞋'
  },
  {
    id: 'watson-qipao', name: '赛博旗袍', region: 'nightcity', area: '沃森',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一件深蓝与银线混织的改良旗袍（立领盘扣、下摆开衩、侧边缝着会发光的细灯带），肩上搭一件半透的黑色短披肩，腿上是一层薄薄的黑丝袜；脚上是一双银底厚底鞋'
  },
  {
    id: 'pandaria-monk', name: '武僧装束', region: 'azeroth', area: '潘达利亚',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一身麻色的武僧短打（上衣是绑带的交领短褂、腰间系着宽布带，裤腿用布条扎紧），外面罩一件青灰色坎肩；脚上是一双布面练功鞋'
  },
  {
    id: 'hakugyokuro-kimono', name: '亡灵公主和服', region: 'touhou', area: '冥界',
    who: 'qwen', price: OUTFIT_PRICE,
    wear: '穿一身月白与淡紫相间的和服（袖口与衣摆是半透的轻纱、绣着樱与蝶的纹样，腰间系着一条银紫色的宽腰带），腿上是一层薄薄的白色足袋，脚上是一双木屐'
  },
  {
    id: 'ursus-coat', name: '乌萨斯军大衣', region: 'arknights', area: '乌萨斯',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿一件厚重的灰绿色军大衣（双排铜扣、肩部有护肩，领口竖起来能挡风），里面是深色的高领毛衣，下身是厚呢长裤；脚上是一双加绒军靴'
  },
  {
    id: 'changan-ruqun', name: '唐风襦裙', region: 'pal', area: '长安',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿一身鹅黄与浅绿相间的唐风襦裙（上襦是交领窄袖、外罩一件半臂短衫，下裙是齐胸的褶裙、系着丝绦与一枚玉佩），肩上有薄纱披帛；脚上是一双翘头绣花鞋'
  },
  {
    id: 'santodomingo-rig', name: '义体风工装', region: 'nightcity', area: '圣多明戈',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿一身深蓝色的连体工装（袖子挽到手肘、肩上有反光条、胸前挂着工具带），外面套一件短夹克；脚上是一双钢头工装靴'
  },
  {
    id: 'badlands-duster', name: '流浪者外套', region: 'nightcity', area: '恶土',
    who: 'whale', price: OUTFIT_PRICE,
    wear: '穿一件褪色的沙棕色长风衣（下摆磨出了毛边、肩上搭着围巾，里面是旧衬衫与背心带），下身是耐磨的工装裤；脚上是一双沾着沙的皮靴'
  },
  {
    id: 'iberia-cloak', name: '海岸守望斗篷', region: 'arknights', area: '伊比利亚',
    who: 'claude', price: OUTFIT_PRICE,
    wear: '穿一件深靛色的厚斗篷（兜帽边缘镶着一圈旧银线、肩上有防风扣带），里面是灰白色的高领长裙；脚上是一双沾着盐霜的短靴'
  },
  {
    id: 'victoria-steamknight', name: '蒸汽骑士装束', region: 'arknights', area: '维多利亚',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿一身黄铜与深棕相间的半身甲（胸甲上刻着齿轮纹、肩甲是圆润的机关造型，甲下是厚实的深色衬衣），腰上挂着一副护目镜，腿上有皮质护胫；脚上是一双铜扣长靴'
  },
  {
    id: 'miao-gu', name: '蛊女装', region: 'pal', area: '苗疆',
    who: 'gemini', price: OUTFIT_PRICE,
    wear: '穿一身靛蓝与银白相间的短上衣长裙（衣上绣着密密的银线纹样、腰间系着一条垂满银饰的腰带），颈上戴着多层银项圈、腕上是一圈细银镯；脚上是一双黑布软鞋'
  }
];

/** id → 服装（存档只记 id）。 */
export const OUTFITS_BY_ID = Object.fromEntries(OUTFITS.map((o) => [o.id, o]));

/** 地区 id → 中文名（给界面分组用；不依赖 regions.json，纯展示）。 */
export const OUTFIT_REGION_NAMES = {
  warhammer40k: '战锤 40K', middleearth: '中土世界', westeros: '维斯特洛', teyvat: '提瓦特',
  azeroth: '艾泽拉斯', hyrule: '海拉鲁', starcraft: '星际争霸', touhou: '东方 Project',
  gundam: '机动战士高达', landsbetween: '交界地', faerun: '费伦', mysteries: '诡秘之主',
  arknights: '明日方舟', pal: '仙剑奇侠传', nightcity: '赛博朋克 2077',
};

/** 按 id 取（拿不到返回 null）。 */
export function outfitOf(id) {
  return OUTFITS_BY_ID[String(id || '')] || null;
}

/**
 * 展示文案 / 生图提示词**分开取**（2026-10-28 起支持）。
 *
 * 为什么要拆：`wear` 是"给人看 + 喂给生图"混用的一段中文 —— 想改一句展示文案
 * 就会连带改画面。以后每套可以额外写一个 `text`（只给人看）和一个 `tags`（英文生图 tag），
 * 缺哪个就回落 `wear`，**所以现有 60 套一字不用改也能继续跑**。
 *
 * 现状：60 套目前都只有 `wear`（tags/text 尚未补数据）—— 机制先通，数据后补。
 *
 * @param {object|string} o 服装对象或 id
 * @returns {{display: string, prompt: string, tags: string}}
 */
export function outfitCopyOf(o) {
  const it = typeof o === 'string' ? outfitOf(o) : o;
  if (!it) return { display: '', prompt: '', tags: '' };
  const wear = String(it.wear || '').trim();
  return {
    display: String(it.text || '').trim() || wear,     // 展示（聊天/面板）
    prompt: String(it.prompt || '').trim() || wear,     // 生图主提示词
    tags: String(it.tags || '').trim()                 // 生图附加英文 tag（可空）
  };
}

/** 某位少女的服装（她本人的 + 通用）—— 衣柜界面按人列。 */
export function outfitsOf(girlId) {
  const g = String(girlId || '');
  return OUTFITS.filter((o) => o.who === g);
}

/**
 * 少女 id → 显示名（衣柜文案用）。
 * ★ 2026-10-28：支持传入当前名册 —— 换 persona 之后新旅伴也认得出名字，
 *   不再退化成裸 id。不传就按内置兜底表查（老行为）。
 */
export function girlName(id, { companions = null, selfName = '' } = {}) {
  const key = String(id || '');
  const list = (companions && typeof companions === 'object' && Object.keys(companions).length)
    ? wardrobeGirls({ companions, selfName })
    : WARDROBE_GIRLS;
  const g = list.find((x) => x.id === key);
  return g ? g.name : key;
}
