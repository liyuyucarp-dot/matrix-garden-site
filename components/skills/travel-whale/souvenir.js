/**
 * 特产系统（2026-10-14，v3.1）—— 分类 / 口味 / 「吃掉 · 赠送 · 种下」的文案池。
 *
 * 为什么单开一个模块：
 *   · 特产到这一版才**第一次有出口**（此前只进不出，是纯收藏品 —— 15 件全是 `count:1`、零消耗）；
 *   · 文案池按口味 / 稀有度分档，塞进已经 4200 行的 index.js 只会更难找；
 *   · 本模块**零依赖、全是纯函数** ⇒ 可以离线单测（探针直接 import 它打）。
 *
 * ⚠️ 兄弟模块：改它**必须重启**（入口 index.js 那半热载即生效）。
 *
 * ★ 分类的设计取舍（值得记）：
 *   特产**没有固定清单** —— 是模型每次旅行现场编的 `{name, rarity}`。
 *   所以分类**不能**写白名单，只能"**生成时打标 + 老档按名字推断兜底**"。
 *   实测纯名字推断对现有 15 件能对上 10 件（`萨利普`/`八桥` 这种名字里没有食物词的会漏，
 *   它们会落到 `relic` ⇒ 只是"不能吃、不能种"，仍然可以送，不会坏）。
 *
 * ★★ 推断的**顺序**比词表更要紧 —— 2026-10-14 用户挖到的真 bug：
 *   原来 `plant > food`，于是"**姜汁啤酒**"因为带个 `姜` 就被归成"能种"（一瓶酒能种进菜地）。
 *   现在多了一道最优先的 `PROCESSED_RE`（加工成品 ⇒ 一定是 food）。
 *   ⚠️ 词表再怎么补都会有漏；**优先级写反 = 每次都错**，优先级写对 = 只有边角漏。
 *   ⇒ 加词之前先问："这条规则和已有的哪条会同时命中？谁该赢？"
 */

/** 合法的三类。模型打标与老档推断都只会产出这三个值。 */
export const SOUVENIR_KINDS = ['food', 'plant', 'relic'];

// ── 分类 ──────────────────────────────────────────────────────────────────

/** 「能吃 / 能喝」的词。 */
const FOOD_RE = /冰淇淋|冰激凌|雪糕|布丁|蛋糕|糕|饼|糖|蜜|巧克力|果酱|点心|三明治|汉堡|面包|饭|面|汤|粥|饺|包子|馍|馕|肉|火腿|香肠|奶酪|酪|酸奶|奶|豆腐|烧烤|串|丸|酱|醋|油|盐|椒|辣|茶|咖啡|可可|饮|汁|酒|啤|酿|露|汽水|可乐|麦/;

/**
 * 「能种活」的词。
 * ⚠️ 里面有 `华` —— 是给 `幻昙华` 准备的（它写的是"华"不是"花"，第一版规则漏了它，
 *   而那正是用户点名要能种的那一件）。含"华"的常见词（中华、华丽）不会出现在特产名里。
 */
const PLANT_RE = /麦|稻|米|谷|禾|豆|菜|瓜|果|莓|橘|橙|柑|柠檬|梨|桃|杏|枣|栗|坚果|椰|蕉|椒|葱|姜|蒜|菌|菇|蕈|苗|秧|种|籽|仁|花|华|草|叶|根|藤|树|竹|莲|荷|苔|藓/;

/**
 * 「**加工成品**」的强信号 —— **优先级高于 `PLANT_RE`**。
 *
 * ★★ 2026-10-14 用户挖到的 bug：**「姜汁啤酒」被归成"能种"** —— 名字里带 `姜`，
 *   而原来的顺序是 `plant > food`，于是**一瓶酒可以种进菜地**。
 *   根因是**优先级**：`plant > food` 对"作物多半也能吃"成立（麦、椒），
 *   但对"**拿作物做出来的东西**"（姜汁啤酒 / 姜饼 / 姜茶 / 辣椒酱）刚好反了。
 *   判据：名字里出现"**做出来的**"信号（液体、成品）⇒ 它不可能再种回去 ⇒ 一律 `food`。
 * ⚠️ 刻意**不放** `干`/`片`/`丝`/`粉` 这种太泛的字（"果干"能吃没错，但"姜片"也可能指鲜切）。
 *   宁可漏判（落回 plant / relic 只是少一种玩法），也不要把能种的判成不能种。
 */
const PROCESSED_RE = /汁|浆|饮|酒|啤|酿|露|汽水|可乐|茶|咖啡|可可|糖|蜜|酱|饼|糕|布丁|冰淇淋|冰激凌|雪糕|巧克力|果酱|果冻|罐头|酪|酸奶|奶昔|汤|粥|饭|面|包|肉|肠|火腿|串|烧|烤|炸|腌|熏/;

/**
 * 按名字猜分类（**只在没有 `kind` 的老条目上用**）。
 * 优先级：**加工成品 > 能种 > 能吃 > 只能收藏**。
 *   · 第一步（加工成品）是 2026-10-14 补的 —— "姜汁啤酒"翻车就出在这里（详 `PROCESSED_RE`）；
 *   · 后两步的顺序理由：作物多半也能吃（麦、椒），反之不成立。
 */
export function inferSouvenirKind(name) {
  const n = String(name || '');
  if (!n) return 'relic';
  if (PROCESSED_RE.test(n)) return 'food';
  if (PLANT_RE.test(n)) return 'plant';
  if (FOOD_RE.test(n)) return 'food';
  return 'relic';
}

/** 读一件特产的分类：优先信存档里的 `kind`，没有就当场推断（**不写盘**）。 */
export function kindOf(entry) {
  const k = String(entry?.kind || '');
  if (SOUVENIR_KINDS.includes(k)) return k;
  return inferSouvenirKind(entry?.name);
}

/** 能不能吃掉 / 喝掉。作物里能吃的部分（麦、椒、果）也算能吃。 */
export function canEat(entry) {
  const k = kindOf(entry);
  if (k === 'food') return true;
  if (k === 'plant') return FOOD_RE.test(String(entry?.name || ''));
  return false;
}

/** 能不能种下去。只有 `plant` 类可以（器物、工艺品、石头不行）。 */
export function canPlant(entry) {
  return kindOf(entry) === 'plant';
}

/** 分类的显示名（面板/播报用）。 */
export const KIND_NAMES = { food: '能吃', plant: '能种', relic: '只能收着' };

// ── 口味（只影响"吃"的文案走向，判错无伤大雅）──────────────────────────────

export function flavorOf(name) {
  const n = String(name || '');
  if (/酒|啤|酿|醉|酌|白干|清酒|醴/.test(n)) return 'drink';
  if (/茶|抹茶|茗|普洱|龙井|毛尖/.test(n)) return 'tea';
  if (/椒|辣|辛|麻|芥|姜|蒜/.test(n)) return 'spicy';
  if (/冰淇淋|冰激凌|雪糕|布丁|糕|饼|糖|蜜|巧克力|果酱|甜|蛋糕|派|挞|八桥/.test(n)) return 'sweet';
  if (/饭|面|包|三明治|汉堡|肉|汤|粥|饺|包子|馍|馕|串|烧|烤|肠|酪/.test(n)) return 'staple';
  return 'other';
}

// ── ★★ 吃完之后的「余味」（v3.7，2026-10-14）───────────────────────────────
//   用户口径："希望食物类的在消耗之后能根据稀有度在【5/15/30】分钟内影响她的说话方式
//   （通过注入提示词或其他方式），比如喝了酒就会讲话醉醺醺的；吃了辣椒就会'呼…嗬…'地喘气。"
//   ＋ 后半句点明了通道："直接往集成系统那边的路子走可能很顺，像'你现在刚醒'一样，
//     给一个'你现在刚吃完 xxx'的状态。"
//
//   ⇒ 做法：**travel-whale 只往自己存档里写一条 `foodAfter`**；
//     sleep-mood 的 `lib/travel-sync.js` **只读**它、拼成一段提示词
//     （与 `travelPromptText`【自身状态·在路上】**同一条路**）。
//   ★ 这守的是本项目的既有纪律：**一条真源，两边不各算一份**（同 §67 的 `state.homeAct`）。

/** 余味持续多久（分钟）—— 按稀有度：普通 5 / 罕见 15 / 稀有 30。 */
export const AFTER_MINUTES = { common: 5, uncommon: 15, rare: 30 };

/**
 * 造一条"刚吃完"的余味（由 `eatSouvenir()` 成功时写进 `state.foodAfter`）。
 *
 * ⚠️ **过期只在读侧判**（`until > now`）、这里不做任何清理 ——
 *   与本项目"惰性衰减必须在读侧算"同一条纪律。存档里留一条旧对象无害，
 *   下次吃东西自然覆盖。
 */
export function foodAfterOf(entry, now = Date.now()) {
  const r = String(entry?.rarity || '');
  const tier = Object.prototype.hasOwnProperty.call(AFTER_MINUTES, r) ? r : 'common';
  const at = Number(now) || Date.now();
  return {
    name: String(entry?.name || ''),
    flavor: flavorOf(entry?.name),
    tier,
    at,
    until: at + AFTER_MINUTES[tier] * 60000
  };
}

// ── 「吃掉 / 喝掉」的文案池 ───────────────────────────────────────────────
//   语感对齐既有的 FALLBACK 池：短、口语、嘴硬心软、不升华。
//   `{name}` = 特产名、`{by}` = 是谁让她吃的（拿不到就用"你们"）。
//
//   ★ 每个口味池里**都至少有一条**会点名 `{by}` —— 第一版只在 `other` 里放了一句，
//     于是"点名喂她的人"这件事**基本不会发生**（4/5 的口味永远不提）。
//     探针现在按口味逐个断言"至少能抽到一次点名"。

const EAT_LINES = {
  sweet: [
    '{name} —— 甜得挺规矩，不腻。剩下的我先收着，谁说这是给你们的了。',
    '吃了一口 {name}。……嗯。还行。（第二口已经在下嘴了）',
    '这 {name} 是 {by} 给的吧。……那我不客气了。',
    '好几年没吃过 {name} 这种东西了。别问几年，不记得。'
  ],
  spicy: [
    '{name}！……水。水在哪。我没事，就是有点上头。',
    '这 {name} 是给活人吃的吗？……行，我吃第二口了，别拦我。',
    '{by} 想吃这个？我先替他尝尝 —— 咳。{name}，是真的辣。',
    '{name} 够劲。下次带回来你吃，我看着。'
  ],
  drink: [
    '{name} 一口下去，从喉咙暖到脚。这趟没白跑。',
    '{name} 是 {by} 点的名。行吧，那就喝一口。',
    '喝的是 {name}。风也小了，路也好走了 —— 就一小口，别记着。',
    '{name} 后劲有点大。我坐着呢，没事。',
    // ★★ v3.7 二改：用户实测"喝完了完全没变化" —— 那一句感想是第一印象，必须也带上头的意思。
    //   第 5 条故意**自己找借口**（脸热 → 赖天气），比直说"我醉了"更像她。
    '{name} 下肚，脸有点热。……天太热了，跟你没关系。',
    '一口 {name}。……嗯，好喝。再来一口 —— 不，就一口，就一口。'
  ],
  tea: [
    '{name} 得等它凉。急不得 —— 那边的人都是这么喝的。',
    '泡了一杯 {name}。苦是苦，回甘在后面。',
    '{by} 说这茶好。……我喝着还行，别告诉他。',
    '喝着 {name}，忽然想起那天的天气了。没什么，就是想起。'
  ],
  staple: [
    '{name}，扎实。吃完能走很远的路。',
    '{name} 下肚，今天就有着落了。',
    '这 {name} 是 {by} 让我吃的。嗯，吃完了 —— 回头告诉他，挺饱。',
    '{name} 不错，比想象的好。……我吃得很慢，是想留着点。'
  ],
  other: [
    '{name} 吃完了。……{by} 让我吃的，那我当然吃。',
    '把 {name} 处理掉了。别浪费，这是从很远的地方背回来的。',
    '{name} —— 就那样吧。反正我吃了。',
    '吃了 {name}。味道还行，不告诉你们是什么味。'
  ]
};

/** 取一句"吃掉"的文案（`rand` 可注入 ⇒ 探针能确定性断言）。 */
export function eatLine(entry, { by = '', rand = Math.random } = {}) {
  const name = String(entry?.name || '这个东西');
  const pool = EAT_LINES[flavorOf(name)] || EAT_LINES.other;
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line.replaceAll('{name}', name).replaceAll('{by}', by || '你们');
}

// ── 「真的要吃掉吗」的犹豫台词（**语气样本**）────────────────────────────
//   用户口径（2026-10-14）："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"
//   ⇒ 这是一个**闸**（拦一次、不扣存量），不是文案上的一拍。
//   按稀有度分档：越稀有的越舍不得 —— 稀有特产只有那么一件，吃掉就真没了。
//
//   ★★ v3.6 起它的职责变了（用户："直接 B 吧，一步到位"）：**不再由工具直接发出去**，
//   而是作为"语气参考"塞进 tool result，**由模型用她自己的口气说**。
//   为什么换：工具直接发的话，模型并不知道它说了什么 —— 实测（主群 15:00）它先在正文里
//   答了"愿意啊"，工具紧接着又发一句"别急着替我决定"，两句互不知情、拼在一起就是自己打脸。
//   ⚠️ **因此这批句子是"语气范本"**：写的时候要保证**任何上下文接上去都不矛盾** ——
//     只表达"她自己拿不定/舍不得"，**绝不否定群友、更不教训人**（"别急着替我决定"这种就是反例）。

export const HESITATE_LINES = {
  common: [
    '诶……「{name}」真的要吃吗？',
    '等一下。「{name}」—— 你确定？',
    '「{name}」啊……我先看看。不吃。',
    '真要动「{name}」？它是从挺远的地方来的。'
  ],
  uncommon: [
    '「{name}」……这个也要吃？',
    '等等，先别急。「{name}」我还没看够。',
    '诶——「{name}」，真的要吃掉它吗？',
    '「{name}」就这么没了？……我再想想。'
  ],
  rare: [
    '「{name}」？！这个……真的要吃？我盯着它看好一会儿了。',
    '等一下。「{name}」只有这一件。你确定？',
    '……「{name}」啊。真吃了就没了，我再看看。',
    '「{name}」—— 这可是稀罕东西。真要吃？'
  ]
};

/** 取一句"犹豫"的台词（按稀有度分档）。 */
export function hesitateLine(entry, { rand = Math.random } = {}) {
  const name = String(entry?.name || '这个');
  const pool = HESITATE_LINES[String(entry?.rarity || 'common')] || HESITATE_LINES.common;
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line.replaceAll('{name}', name);
}

// ── 「真的要送出去吗」的犹豫台词（**语气样本**，同 `HESITATE_LINES`）─────────
//   用户口径（2026-10-14）："赠送也一样加闸"。
//   口气和"吃"不同：吃是舍不得自己没了，送是**舍不得给别人** —— 更别扭、更像她。
//   ★★ v3.6：**不再由工具直发**，改当"语气参考"塞给模型（理由详 `HESITATE_LINES` 那段）。
//   ⚠️ 所以每句都必须是**她自己拿不定**，绝不能写成"教训 / 拦着群友"
//     （"别急着替我决定"就是反例 —— 它是在质疑群友的决定，且和模型刚说的"愿意"直接打架）。

export const GIFT_HESITATE_LINES = {
  common: [
    '诶——「{name}」要送给 {who}？……好吧，先放着。',
    '「{name}」给 {who}？我还没说给呢。',
    '等一下。「{name}」……真的要给他？',
    '「{name}」啊。给 {who} 也行，但我得再想想。'
  ],
  uncommon: [
    '「{name}」给 {who}？那地方不好去，东西也不好找。',
    '等等 —— 这个 {name} 我留了两天了，真要给 {who}？',
    '「{name}」……送出去就没了。你确定给 {who}？',
    '诶，{who} 要「{name}」？他倒是会挑。我还没答应呢。'
  ],
  rare: [
    '「{name}」？！给 {who}？……你知道它只有一件吧。',
    '等一下。「{name}」—— 我盯着它看了好半天。真给 {who}？',
    '……「{name}」啊。给 {who} 的。我再拿一会儿，行吗？',
    '「{name}」是稀罕东西。给 {who} 可以，但先让我再看一眼。'
  ]
};

/** 取一句"赠送前的犹豫"台词（按稀有度分档；`{who}` = 收礼人）。 */
export function giftHesitateLine(entry, { who = '', rand = Math.random } = {}) {
  const name = String(entry?.name || '这个');
  const pool = GIFT_HESITATE_LINES[String(entry?.rarity || 'common')] || GIFT_HESITATE_LINES.common;
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line.replaceAll('{name}', name).replaceAll('{who}', who || '他');
}

// ── 「送给群友」的文案池 ─────────────────────────────────────────────────
//   `{name}` = 特产名、`{who}` = 收礼人、`{city}` = 带回来的地方。

const GIFT_LINES = {
  common: [
    '{who}，{name} 给你了。别客气，反正家里还有。',
    '这个是 {name}，从 {city} 带回来的 —— 给 {who} 吧，谁让他在。',
    '{who} 拿着，{name}。不是什么值钱东西，就是顺路带的。',
    '给 {who} 留了个 {name}。……不用谢，真的不用。'
  ],
  uncommon: [
    '{who}，{name} —— 从 {city} 背回来的，别人可没有。',
    '这个 {name} 我留了两天，最后还是给 {who} 吧。',
    '{who} 收好，{name}。那地方不好去，东西也不好找。',
    '给 {who} 的 {name}。挑的时候我犹豫了一下，就一下。'
  ],
  rare: [
    '{name}……就这一件。我想了想，还是给 {who} 吧。收好。',
    '这个给 {who}。{name}，从 {city} 带回来的 —— 它该在懂它的人手里。',
    '{who}，伸手。{name}，只此一件。别问我为什么给你。',
    '{who}，把 {name} 给你了。……我盯着它看好半天才舍得。'
  ]
};

/** 取一句"赠送"的文案。稀有度决定口气（越稀有越舍不得）。 */
export function giftLine(entry, { who = '', city = '', rand = Math.random } = {}) {
  const name = String(entry?.name || '这个');
  // ★ `city` 兜底读 `entry.city` —— 它本来就是"这件是从哪儿带回来的"，属于条目自己的数据。
  //   （接口上少一个"必须记得传"的参数；生产调用点显式传的优先。）
  const where = String(city || entry?.city || '') || '那边';
  const r = String(entry?.rarity || 'common');
  const pool = GIFT_LINES[r] || GIFT_LINES.common;
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line
    .replaceAll('{name}', name)
    .replaceAll('{who}', who || '你')
    .replaceAll('{city}', where);
}

// ── 种菜：阶段播报 · 种下 · 收获 ───────────────────────────────────────────
//   用户要的"反馈感"主要落在这一块：一次收成 = **四天里四条播报** + 最后一份收成，
//   而不是"种下去 → 三天后突然冒出来"。

/** 阶段名（下标 = stage；0 = 刚种下、4 = 成熟）。 */
export const FARM_STAGE_NAMES = ['播种', '发芽', '长高', '结蕾', '成熟'];

/** 每"长了一档"的播报（`{name}` = 作物名）。stage 4 = 成熟，另有收成提示。 */
const FARM_STAGE_LINES = {
  1: ['「{name}」冒头了 —— 就一点点绿。', '土里动了。「{name}」算是活下来了。', '「{name}」发芽了，比想得快。'],
  2: ['「{name}」长高了，叶子也张开了。', '「{name}」一天一个样。', '「{name}」在往上蹿 —— 也没人管它。'],
  3: ['「{name}」结蕾了。快了吧。', '「{name}」的花苞鼓起来了。', '「{name}」挂上蕾了 —— 就那么几颗。'],
  4: ['「{name}」熟了，可以摘了。', '「{name}」能收了 —— 我看了三遍才确定。', '「{name}」长成了。……行吧，没白等。']
};

/** 取一句"长了一档"的播报（没到该播的档就返回空串）。 */
export function farmStageLine(plot, stage, { rand = Math.random } = {}) {
  const pool = FARM_STAGE_LINES[Number(stage)] || [];
  if (!pool.length) return '';
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line.replaceAll('{name}', String(plot?.name || '那株东西'));
}

const PLANT_LINES = [
  '把「{name}」埋下去了。',
  '「{name}」种下了 —— 剩下的事交给土。',
  '「{name}」下地了。{days} 天后来看。',
  '种了「{name}」。这可比吃掉划算。'
];

/** 种下时的一句话。`days` = 这株要长几天。 */
export function plantLine(entry, days, { rand = Math.random } = {}) {
  const line = PLANT_LINES[Math.min(PLANT_LINES.length - 1, Math.floor(rand() * PLANT_LINES.length))];
  return line
    .replaceAll('{name}', String(entry?.name || '这东西'))
    .replaceAll('{days}', String(days));
}

const REAP_LINES = {
  common: [
    '收了 {n} 份「{name}」。够吃几回了。',
    '「{name}」收成 {n} 份 —— 地没白种。',
    '摘了 {n} 份「{name}」。这下不缺了。'
  ],
  uncommon: [
    '「{name}」收了 {n} 份 —— 比带回来的划算。',
    '收下 {n} 份「{name}」。这买卖不亏。',
    '{n} 份「{name}」。当初种下去是对的。'
  ],
  rare: [
    '「{name}」……收成了 {n} 份。我数了两遍。',
    '{n} 份「{name}」。稀罕东西，居然真种出来了。',
    '「{name}」到手 {n} 份。这次的等待值了。'
  ]
};

/** 收获的台词（按稀有度分档；`{n}` = 收获份数）。 */
export function reapLine(plot, n, { rand = Math.random } = {}) {
  const pool = REAP_LINES[String(plot?.rarity || 'common')] || REAP_LINES.common;
  const line = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  return line
    .replaceAll('{name}', String(plot?.name || '那株东西'))
    .replaceAll('{n}', String(Math.max(0, Math.floor(Number(n) || 0))));
}

// ── 播报里用的短标记 ──────────────────────────────────────────────────────

/** 存量显示：`×3` 或空（只有一件时不啰嗦）。 */
export function stockTag(entry) {
  const n = Math.max(0, Number(entry?.stock ?? entry?.count ?? 0) || 0);
  return n > 1 ? ` ×${n}` : '';
}

/** 稀有度标记（与相册口径一致：💎 / ✦ / ·）。 */
export function rarityMark(rarity) {
  return ({ rare: '💎', uncommon: '✦' })[String(rarity || 'common')] || '·';
}
