// 矩阵庭院 · 称号
//
// 27 个称号，分 7 组。判定全部是**纯函数**：只读 state，不写盘、不联网。
// 这样称号逻辑可以脱离运行环境单测，也不会和"播报"耦合在一起
// （谁负责播报、什么时候播报，交给 index.js 决定）。
//
// 为什么按 id 而不是按名字记已解锁：名字将来可能改（改文案/改译名），
// 用 id 才不会被文案改动"重置进度"。
//
// ★★ 2026-10-13 晚（用户口径）—— 这一轮把称号从"旅行鲸鱼"时代搬到矩阵庭院：
//   ① 「旅行次数 / 城市景点 / 稀有」三组**换名不换条件**（"成就要求不变"）：
//      去掉航海/海洋味，统一到本玩法的画风 —— 星野（她庭院上方那片星空）／
//      邮戳（她每到一个城市寄回的明信片）／图鉴（特产收集的既有概念）。
//   ② 「大洲大洋」→ **「世界版图」**，并**加入异世界**：原来那组只认现实的大洲大洋，
//      而现在 21 个地区里有 **12 个是异世界**，一条称号都没覆盖。
//   ③ 删两条：`chameleon`（百变风格 —— 画风已长到 93 种，"用遍所有画风"实际不可达）
//      与 `battle-ready`（全副武装 —— 判据要数 `equipUsed`，而那个字段**从来没被写过**，
//      计数恒为 0 ⇒ 永远拿不到。见 §78）。
//      ⚠️ 存档 `state.titles` 里若残留这两条的记录，**无害**：它们不在 `TITLES` 里就不会被遍历。
//   ④ `night-owl`（夜不归宿）改名 —— 现在她出门 24~48 小时、在家也是正经营生，
//      "不归宿"听着像在骂她；改成 **「日日有信」**（连续 7 天在路上 = 天天有明信片回来），
//      条件不变。
//
// ⚠️ 改名/增删都**不影响已解锁进度**（按 id 记）。异世界那四条**多要一个 ctx 字段**，
//    拿不到就恒不达成（安全降级，见 `fictionVisited`）。
//
// ★★ 2026-10-13 晚（第二批，用户："技能/旅伴/庭院/相册都需要一批称号，每个维度 3~5 个"）：
//   加了 **4 组 17 条** —— 技能(4) / 旅伴(4) / 庭院(4) / 相册(5)。总表 **44 个 / 11 组**。
//
// ★★ 2026-10-14（第四批，用户："喂过 N 次 / 送出 N 件 / 收获 N 次 / 首次种出稀有"）：
//   给「**特产**」这组补了 **7 条"出口面"** —— 吃(2) / 送(2) / 收成(3)。总表 **57 个 / 13 组**。
//   背景：特产到 3.1 才**第一次有出口**（此前只进不出、是纯收藏品）⇒ 称号也得跟上，
//   否则"全部称号"里一条都不奖励它们的**使用**，把 15 件全吃光也不会有一点回响。
//   不新开组：这七条本来就是"特产"这件事的另一面（收集面 vs 出口面）。
//   ⚠️ 加条**只增不改**：总数一变 `totalPoints` 跟着涨 ⇒ 服务器阵列第 4 台的门槛
//      （= 全部成就值）自动抬高，这是设计如此（见 index.js 的 GARDENS 末位哨兵 'all'）。
//   口径与前面一致：**只读 state**，拿不到的上下文一律"恒不达成"，绝不误解锁。
//   ⚠️ 这四组需要 5 个新 ctx 字段（原因见各 helper）：
//     · `skillTotal`     学齐全部技能要用（技能表住在 index.js ⇒ 注入）
//     · `skillRegionOf`  `{skillId: regionId}`（"一门精通"要按世界分组）
//     · `companionTotal` 邀请全部旅伴要用
//     · `gardenTotal`    五件设施全建要用
//     · `gardenMax`      `{设施id: 满级等级}`（各设施上限不同：观星台 5 / 檐廊 3 / 其余 1）
//   相册那组还用到 **`state.cardFlags`** —— 那是**入口侧**写的 `{cardId: {battle, cross}}`
//   （为什么不写进 album 条目：`addPostcard` 是白名单赋值，改它要重启，见 §78）。

/** 大洲 / 大洋的 id（与地区表一致）。 */
const CONTINENTS = ['asia', 'europe', 'africa', 'americas', 'oceania'];
const OCEANS = ['pacific', 'atlantic', 'indian', 'arctic'];
/**
 * 装备总数的**兜底值**（真实值由 `ctx.regionTotal` 传进来）。
 *
 * 为什么不写死一个"准确数字"：地区表是会长大的 —— 2026-10-11 从 9 个扩到 15 个，
 * 10-13 又长到 21 个（其中 12 个异世界）。写死就会重演"称号永远拿不到"：
 * 当时 `equipUnlocked` 里只有买过的，数不到 9。
 * ⚠️ 本模块刻意**不读文件**（纯函数，见文件头），所以总数只能靠 ctx 注入。
 */
const DEFAULT_EQUIP_TOTAL = 15;

/**
 * 旅伴总数的**兜底值**（真实值由 `ctx.companionTotal` 传进来，现在是 7）。
 * ⚠️ 与 `DEFAULT_EQUIP_TOTAL` 同一个道理：**只用在拿不到 ctx 的时候**。
 *   写死的数字会漂（v3.0 从 5 加到 7，`desc` 里那句"五位"就是这么变成假话的），
 *   所以判据一律现读 ctx，这里只保证"不崩"。
 */
const DEFAULT_COMPANION_TOTAL = 7;

// ── 取值助手（全部做防御性处理，旧存档缺字段也不炸）─────────────────────

const trips = (s) => Number(s?.stats?.trips) || 0;
const cityKeys = (s) => Object.keys(s?.visitedCities || {});
const spotKeys = (s) => Object.keys(s?.visitedSpots || {});
const souvenirList = (s) => Object.values(s?.souvenirs || {});
const rareList = (s) => souvenirList(s).filter((x) => x?.rarity === 'rare');
const regionIds = (s) => new Set(Object.values(s?.visitedCities || {}).map((v) => v?.region).filter(Boolean));

/** 某个大洲下去过几个不同城市。 */
const citiesIn = (s, regionId) => Object.values(s?.visitedCities || {}).filter((v) => v?.region === regionId).length;

/** 单个城市的最大到访次数（"故地重游"）。 */
const maxCityVisit = (s) => {
  const arr = Object.values(s?.visitedCities || {}).map((v) => Number(v?.count) || 0);
  return arr.length ? Math.max(...arr) : 0;
};

/** 是否集齐全部大洲 / 大洋。 */
const allRegionsVisited = (s, ids) => ids.every((id) => regionIds(s).has(id));

// ── 异世界（「世界版图」新增的四条要用）───────────────────────────────────

/**
 * 异世界 id 集合。
 *
 * ⚠️ 本模块**零 import**（见文件头），不能直接问 trip.js 要 ⇒ 只能像 `regionTotal`
 *    一样**靠 ctx 注入**：`index.js` 用 `T.isFictional()` 筛好、传进 `ctx.fictionalRegions`。
 *    拿不到（旧 index.js / 表损坏）就返回 null ⇒ 下面两条恒为 0 / false ⇒
 *    那四条称号**恒不达成**，但**不会误解锁、也不会抛错**。这就是安全降级。
 */
const fictionSet = (ctx) => (ctx?.fictionalRegions instanceof Set ? ctx.fictionalRegions : null);

/** 她本人去过几个不同的异世界。 */
const fictionVisited = (s, ctx) => {
  const set = fictionSet(ctx);
  if (!set || !set.size) return 0;
  const seen = regionIds(s);
  let n = 0;
  for (const id of set) if (seen.has(String(id))) n += 1;
  return n;
};

/** 异世界是不是全去过了（地区表里有几个就要求几个，**不写死数字**）。 */
const allFictionVisited = (s, ctx) => {
  const set = fictionSet(ctx);
  return Boolean(set && set.size > 0 && fictionVisited(s, ctx) >= set.size);
};

// ── 技能 / 旅伴 / 庭院 / 相册（第二批四组用）──────────────────────────────

const skillsLearned = (s) => Object.keys(s?.whale?.skills || {}).length;

/**
 * 点满了几支技能树。
 * 一个世界有两条技能（`SKILLS` 里同 `region` 的那些），**全学会**才算点满一支。
 * ⚠️ 技能表住在 `index.js`（入口），本模块零 import ⇒ 映射只能靠 `ctx.skillRegionOf`
 *    （`{skillId: regionId}`）注入。拿不到就返回 0 ⇒「一门精通」恒不达成（安全降级）。
 */
const masteredBranches = (s, ctx) => {
  const map = ctx?.skillRegionOf;
  if (!map || typeof map !== 'object') return 0;
  const owned = (s?.whale && typeof s.whale.skills === 'object' && s.whale.skills) || {};
  const acc = {};
  for (const [id, region] of Object.entries(map)) {
    const r = String(region || '');
    if (!r) continue;
    const b = acc[r] || (acc[r] = { n: 0, got: 0 });
    b.n += 1;
    if (owned[id]) b.got += 1;
  }
  return Object.values(acc).filter((b) => b.n > 0 && b.got >= b.n).length;
};

const companionsOwned = (s) => (Array.isArray(s?.companionOwned) ? s.companionOwned.length : 0);

/** 同一位旅伴走过的**最多**异世界数（`whale.companionWorlds[伙伴id] = [regionId…]`）。 */
const maxCompanionWorlds = (s) => {
  const m = s?.whale?.companionWorlds;
  if (!m || typeof m !== 'object') return 0;
  let best = 0;
  for (const v of Object.values(m)) if (Array.isArray(v) && v.length > best) best = v.length;
  return best;
};

const gardenLevelOf = (s, id) => Math.max(0, Number(s?.garden?.[id]) || 0);
const gardenBuilt = (s) => Object.values(s?.garden || {}).filter((v) => (Number(v) || 0) > 0).length;
const gardenLevelSum = (s) => Object.values(s?.garden || {}).reduce((a, v) => a + (Number(v) || 0), 0);
/** 有没有哪件设施已经升到**它自己的**满级（各设施上限不同，由 `ctx.gardenMax` 注入）。 */
const gardenMaxedAny = (s, ctx) => {
  const max = ctx?.gardenMax;
  if (!max || typeof max !== 'object') return false;
  for (const [id, lv] of Object.entries(max)) {
    if (gardenLevelOf(s, id) >= (Math.max(1, Number(lv) || 1))) return true;
  }
  return false;
};

const albumOf = (s) => (Array.isArray(s?.album) ? s.album : []);
const albumRareCount = (s) => albumOf(s).filter((c) => c?.rarity === 'rare').length;
const albumHomeCount = (s) => albumOf(s).filter((c) => c?.kind === 'home').length;
/**
 * 相册里带某个标记的卡有几张（`'battle'` / `'cross'`）。
 *
 * `state.cardFlags` 由**入口侧**写（`{ [cardId]: { battle, cross } }`）—— 为什么不塞进
 * album 条目本身：`addPostcard` 是白名单赋值（state.js 是兄弟模块），改它要重启，
 * 而放 state 顶层同样能落盘（同 `cardDelivered` 的做法）。
 * ⚠️ **旧卡没有这些标记** ⇒ 这两条称号只从这次之后算（跟"初次越界"同理）。
 */
const cardFlagCount = (s, key) => {
  const m = s?.cardFlags;
  if (!m || typeof m !== 'object') return 0;
  return Object.values(m).filter((f) => f && f[String(key)] === true).length;
};

// ── 特产出口（第四批：吃 / 送 / 种）────────────────────────────────────────
//
//   ★ 「喂过 N 次」「送出 N 件」**不需要任何新字段** —— 它们是长在特产条目上的累计值
//     （`eaten` / `giftedCount`），求和即可；而且**天然可追溯**：老档里以前吃/送过的
//     也算得出来（`loadState()` 会给老条目补 0）。
//   ★ 「收成 N 次」只能**记账**：收完那株就从 `farm` 里删掉了，事后无从推算
//     ⇒ 用 `stats.harvests` / `stats.rareHarvests`（收成的那一刻在 `reapSouvenir()` 里 +1）。
const sumBy = (s, key) => souvenirList(s).reduce((n, e) => n + (Number(e?.[key]) || 0), 0);
const eatenCount = (s) => sumBy(s, 'eaten');
const giftedCount = (s) => sumBy(s, 'giftedCount');
const harvestCount = (s) => Number(s?.stats?.harvests) || 0;
const rareHarvestCount = (s) => Number(s?.stats?.rareHarvests) || 0;

// ── TOKEN 经济（第三批）────────────────────────────────────────────────────

/** 余额（单位：亿 TOKEN）。 */
const balanceOf = (s) => Math.max(0, Number(s?.wallet?.plankton) || 0);

/**
 * 累计赚取（单位：亿 TOKEN）—— 流水，不是余额。
 *
 * ⚠️ 这本流水账（`stats.earned`）是**这一版才加的** ⇒ 老存档读出来是 0。
 *    而"她一共赚过多少"显然不是 0（她只是没记账）⇒ 退一步用**余额**兜底，
 *    至少不会把老档判成"从来没挣过钱"。新账本一到位，两者就自然分开走了。
 */
const earnedOf = (s) => {
  const e = Number(s?.stats?.earned);
  if (Number.isFinite(e) && e > 0) return e;
  return balanceOf(s);
};

// ── 称号本身（第三批：成就值那两条）────────────────────────────────────────

/**
 * 「称号」这一组自己的进度 —— **刻意跳过 `group === '称号'` 的条目**。
 *
 * 为什么必须跳过：`title-all`（集齐其他全部称号）如果把**它自己**也算进分母，
 * 就变成"要拿到它、得先拿到它" ⇒ **自引用死锁，永远不可能达成**。
 * 所以统计口径是"**除这两条以外的**全部称号"（现在是 55 条；第四批加 7 条后 48 → 55）。
 * ※ 顺带解释为什么 helper 写在 `TITLES` 之前也没事：函数体是**调用时**才求值的。
 */
const titleProgress = (s) => {
  const got = s?.titles || {};
  let n = 0;
  let total = 0;
  for (const t of TITLES) {
    if (t.group === '称号') continue;
    total += 1;
    if (got[t.id]) n += 1;
  }
  return { got: n, total };
};

// ── 称号表 ────────────────────────────────────────────────────────────────

export const TITLES = [
  // ── 旅行次数（星野系列：她庭院上方那片看得见星星的天）──
  { id: 'first-sail', group: '旅行次数', points: 1, name: '踏进星野', icon: '🌌', desc: '完成第 1 次旅行', check: (s) => trips(s) >= 1 },
  { id: 'old-sailor', group: '旅行次数', points: 3, name: '星野常行', icon: '✨', desc: '累计旅行 10 次', check: (s) => trips(s) >= 10 },
  { id: 'senior-traveler', group: '旅行次数', points: 5, name: '星野深处', icon: '🌠', desc: '累计旅行 50 次', check: (s) => trips(s) >= 50 },
  { id: 'legend', group: '旅行次数', points: 10, name: '星野无尽', icon: '🐋', desc: '累计旅行 100 次', check: (s) => trips(s) >= 100 },

  // ── 世界版图：现实 4 条（沿用）+ 异世界 4 条（★ 本轮新增）──
  { id: 'asia-master', group: '世界版图', points: 3, name: '亚洲通', icon: '🏮', desc: '在亚洲去过 3 个不同城市', check: (s) => citiesIn(s, 'asia') >= 3 },
  { id: 'five-continents', group: '世界版图', points: 5, name: '环游五洲', icon: '🗺️', desc: '5 个大洲各至少去过 1 次', check: (s) => allRegionsVisited(s, CONTINENTS) },
  { id: 'four-seas', group: '世界版图', points: 5, name: '四海为家', icon: '🌏', desc: '5 洲 + 4 洋全部去过至少 1 次', check: (s) => allRegionsVisited(s, [...CONTINENTS, ...OCEANS]) },
  { id: 'polar', group: '世界版图', points: 3, name: '极地探险家', icon: '❄️', desc: '去过北冰洋', check: (s) => regionIds(s).has('arctic') },
  // ★ 新增：异世界。口径与技能树一致 —— **只认她本人去过**（`visitedCities`），
  //   闲置伙伴"自己去玩"带回的特产不进 `visitedCities` ⇒ 不算她去过。
  { id: 'otherworld-first', group: '世界版图', points: 1, name: '初次越界', icon: '🌀', desc: '去过第 1 个异世界', check: (s, ctx) => fictionVisited(s, ctx) >= 1 },
  { id: 'otherworld-three', group: '世界版图', points: 3, name: '走过三界', icon: '🪐', desc: '去过 3 个不同的异世界', check: (s, ctx) => fictionVisited(s, ctx) >= 3 },
  { id: 'otherworld-six', group: '世界版图', points: 5, name: '半个星图', icon: '⭐', desc: '去过 6 个不同的异世界', check: (s, ctx) => fictionVisited(s, ctx) >= 6 },
  { id: 'otherworld-all', group: '世界版图', points: 10, name: '星图全亮', icon: '🌟', desc: '去过全部异世界', check: (s, ctx) => allFictionVisited(s, ctx) },

  // ── 城市景点（邮戳：她每到一个城市都寄一张回来；册：相册）──
  { id: 'checker-in', group: '城市景点', points: 3, name: '十城邮戳', icon: '📮', desc: '去过 10 个不同城市', check: (s) => cityKeys(s).length >= 10 },
  { id: 'city-hunter', group: '城市景点', points: 5, name: '三十城邮戳', icon: '🌆', desc: '去过 30 个不同城市', check: (s) => cityKeys(s).length >= 30 },
  { id: 'spot-collector', group: '城市景点', points: 3, name: '风景入册', icon: '🖼️', desc: '收集 20 个不同景点', check: (s) => spotKeys(s).length >= 20 },
  { id: 'heritage', group: '城市景点', points: 5, name: '半册风景', icon: '📚', desc: '收集 50 个不同景点', check: (s) => spotKeys(s).length >= 50 },

  // ── 特产（收集面 · 第四批加了"出口"面，见下面那一段）──
  { id: 'souvenir-fan', group: '特产', points: 3, name: '土特产爱好者', icon: '🎁', desc: '收集 10 件不同特产', check: (s) => souvenirList(s).length >= 10 },
  { id: 'souvenir-collector', group: '特产', points: 5, name: '特产收藏家', icon: '🧺', desc: '收集 30 件不同特产', check: (s) => souvenirList(s).length >= 30 },
  { id: 'big-haul', group: '特产', points: 1, name: '满载而归', icon: '🛍️', desc: '单趟带回 5 件以上特产', check: (s) => (Number(s?.stats?.maxSouvenirsPerTrip) || 0) >= 5 },

  // ── 特产（★ 第四批新增）—— 带回来的东西**终于有了出口**：吃 / 送 / 种 ──
  //   用户口径（2026-10-14）："喂过 N 次 / 送出 N 件 / 收获 N 次 / 首次种出稀有"。
  //   ★ 判据一律只读累计值，**不看存量** —— 吃光送光正是它们要奖励的事。
  //   ⚠️ 收成那三条靠 `stats.harvests`（唯一需要记账的，理由见上面那组 helper）。
  { id: 'feed-first', group: '特产', points: 1, name: '第一口', icon: '🥢', desc: '第一次让她吃掉带回来的东西', check: (s) => eatenCount(s) >= 1 },
  { id: 'feed-ten', group: '特产', points: 3, name: '喂熟了', icon: '🍚', desc: '累计吃掉 10 件特产', check: (s) => eatenCount(s) >= 10 },
  { id: 'gift-first', group: '特产', points: 1, name: '送出去的第一件', icon: '🎀', desc: '第一次把特产送出去', check: (s) => giftedCount(s) >= 1 },
  { id: 'gift-ten', group: '特产', points: 3, name: '有来有往', icon: '🤲', desc: '累计送出 10 件特产', check: (s) => giftedCount(s) >= 10 },
  { id: 'harvest-first', group: '特产', points: 1, name: '第一茬', icon: '🌱', desc: '第一次从菜地里收成', check: (s) => harvestCount(s) >= 1 },
  { id: 'harvest-ten', group: '特产', points: 3, name: '地里常青', icon: '🌾', desc: '累计收成 10 次', check: (s) => harvestCount(s) >= 10 },
  { id: 'harvest-rare', group: '特产', points: 5, name: '种出稀罕的', icon: '🪷', desc: '第一次种出稀有作物', check: (s) => rareHarvestCount(s) >= 1 },

  // ── 稀有（图鉴系列：图鉴条目数就是特产收集数，见 state.js）──
  { id: 'shell-picker', group: '稀有', points: 1, name: '图鉴第一件', icon: '📌', desc: '获得第 1 件稀有特产', check: (s) => rareList(s).length >= 1 },
  { id: 'rare-hunter', group: '稀有', points: 3, name: '图鉴渐满', icon: '💎', desc: '获得 5 件稀有特产', check: (s) => rareList(s).length >= 5 },
  { id: 'deep-treasure', group: '稀有', points: 5, name: '图鉴满册', icon: '👑', desc: '获得 15 件稀有特产', check: (s) => rareList(s).length >= 15 },

  // ── 装备（原两条，`battle-ready`「全副武装」已删 —— 判据字段从没被写过，见文件头）──
  // 阈值从 ctx.regionTotal 取，desc 不写死数字
  { id: 'fully-equipped', group: '装备', points: 10, name: '装备齐全', icon: '🎒', desc: '集齐全部装备', check: (s, ctx) => (s?.whale?.equipUnlocked || []).length >= (ctx?.regionTotal || DEFAULT_EQUIP_TOTAL) },

  // ── 趣味 ──
  { id: 'revisit', group: '趣味', points: 1, name: '故地重游', icon: '🔁', desc: '同一个城市去过 3 次', check: (s) => maxCityVisit(s) >= 3 },
  { id: 'regular', group: '趣味', points: 3, name: '常客', icon: '🏠', desc: '同一个城市去过 5 次', check: (s) => maxCityVisit(s) >= 5 },
  { id: 'postcard-tycoon', group: '趣味', points: 5, name: '明信片大户', icon: '💌', desc: '累计收到 100 张明信片', check: (s) => (Number(s?.stats?.cards) || 0) >= 100 },
  { id: 'night-owl', group: '趣味', points: 3, name: '日日有信', icon: '📆', desc: '连续 7 天都有旅行', check: (s) => (Number(s?.tripStreak?.days) || 0) >= 7 },

  // ── 技能（★ 第二批新增）—— 她在异世界学到的东西 ──
  { id: 'learn-first', group: '技能', points: 1, name: '第一次偷师', icon: '📘', desc: '学会第 1 条技能', check: (s) => skillsLearned(s) >= 1 },
  { id: 'learn-master', group: '技能', points: 5, name: '一门精通', icon: '🎓', desc: '把同一个世界的技能全学会', check: (s, ctx) => masteredBranches(s, ctx) >= 1 },
  { id: 'learn-six', group: '技能', points: 5, name: '六艺在身', icon: '🧠', desc: '学会 6 条技能', check: (s) => skillsLearned(s) >= 6 },
  { id: 'learn-all', group: '技能', points: 10, name: '学遍诸界', icon: '🌐', desc: '学会全部技能', check: (s, ctx) => { const n = skillsLearned(s); return n > 0 && n >= (Number(ctx?.skillTotal) || 24); } },

  // ── 旅伴（★ 第二批新增）—— 院子里的人 ──
  { id: 'mate-first', group: '旅伴', points: 1, name: '第一位旅伴', icon: '🤝', desc: '邀请第 1 位旅伴', check: (s) => companionsOwned(s) >= 1 },
  { id: 'mate-three', group: '旅伴', points: 3, name: '三位旅伴', icon: '👥', desc: '邀请 3 位旅伴', check: (s) => companionsOwned(s) >= 3 },
  // ★ v3.2 修：desc 原来写死"五位旅伴全部邀请到" —— v3.0 加到 7 位之后就成假话了。
  //   判据本来就是现读 `ctx.companionTotal`，只有**拿不到 ctx 时**才退回兜底值。
  { id: 'mate-all', group: '旅伴', points: 5, name: '满座', icon: '🫂', desc: '全部旅伴都邀请到', check: (s, ctx) => companionsOwned(s) >= (Number(ctx?.companionTotal) || DEFAULT_COMPANION_TOTAL) },
  { id: 'mate-partner', group: '旅伴', points: 5, name: '老搭档', icon: '🧭', desc: '同一位旅伴陪你走过 3 个异世界', check: (s) => maxCompanionWorlds(s) >= 3 },

  // ── 庭院（★ 第二批新增）—— 她在家门口盖起来的那些 ──
  { id: 'garden-first', group: '庭院', points: 1, name: '动土', icon: '🧱', desc: '建起第 1 件庭院设施', check: (s) => gardenBuilt(s) >= 1 },
  { id: 'garden-all', group: '庭院', points: 5, name: '庭院落成', icon: '🏡', desc: '把五件设施都建起来', check: (s, ctx) => gardenBuilt(s) >= (Number(ctx?.gardenTotal) || 5) },
  { id: 'garden-level5', group: '庭院', points: 3, name: '初具规模', icon: '🪴', desc: '设施总等级达到 5', check: (s) => gardenLevelSum(s) >= 5 },
  { id: 'garden-stargazer', group: '庭院', points: 5, name: '看得最清', icon: '🔭', desc: '观星台升到满级', check: (s, ctx) => { const lv = ctx?.gardenMax?.stargazer; return lv ? gardenLevelOf(s, 'stargazer') >= Number(lv) : gardenLevelOf(s, 'stargazer') >= 5; } },

  // ── 相册（★ 第二批新增）—— 她寄回来的那些画面 ──
  { id: 'photo-rare-first', group: '相册', points: 1, name: '第一张金边', icon: '🥇', desc: '收到第 1 张★稀有明信片', check: (s) => albumRareCount(s) >= 1 },
  { id: 'photo-battle-first', group: '相册', points: 3, name: '交手那张', icon: '⚔️', desc: '收到第 1 张战斗明信片', check: (s) => cardFlagCount(s, 'battle') >= 1 },
  { id: 'photo-cross-first', group: '相册', points: 3, name: '被丢过去的那次', icon: '🌪️', desc: '第 1 次被穿越丢到别处', check: (s) => cardFlagCount(s, 'cross') >= 1 },
  { id: 'photo-home-first', group: '相册', points: 3, name: '第一张全家福', icon: '📷', desc: '收到第 1 张庭院大合照', check: (s) => albumHomeCount(s) >= 1 },
  { id: 'photo-rare-five', group: '相册', points: 3, name: '五张金边', icon: '🏆', desc: '收到 5 张★稀有明信片', check: (s) => albumRareCount(s) >= 5 },

  // ── TOKEN 经济（★ 第三批）—— 单位一律是「亿 TOKEN」──
  // 用户口径：只做**余额**与**累计赚取**两类。余额是"手上有多少"，累计是"一共挣过多少"——
  // 后者不会被花掉抹平，所以是真正的长期目标（也正因此要单独记一笔流水，见 state.js 的 noteEarned）。
  { id: 'token-save', group: 'TOKEN', points: 1, name: '兜里有钱', icon: '💰', desc: '余额达到 1000 亿 TOKEN', check: (s) => balanceOf(s) >= 1000 },
  { id: 'token-earn', group: 'TOKEN', points: 3, name: '进账不停', icon: '📈', desc: '累计赚到 5000 亿 TOKEN', check: (s) => earnedOf(s) >= 5000 },
  { id: 'token-rich', group: 'TOKEN', points: 5, name: '万亿身家', icon: '🏦', desc: '余额达到 1 万亿 TOKEN', check: (s) => balanceOf(s) >= 10000 },
  { id: 'token-flood', group: 'TOKEN', points: 10, name: '流水成河', icon: '🌊', desc: '累计赚到 5 万亿 TOKEN', check: (s) => earnedOf(s) >= 50000 },

  // ── 称号本身（★ 第三批）—— 两条都按用户口径给 **10 点** ──
  // ⚠️ 判据走 `titleProgress()`，它**跳过本组**，否则"集齐全部"会自引用死锁（见那个 helper 的说明）。
  // 这两条也是「服务器阵列」最后一台（200 分）的关键分数来源 —— 总分 211，不给它们就没法到 200。
  { id: 'title-half', group: '称号', points: 10, name: '小有所成', icon: '🎖️', desc: '解锁全部称号的一半', check: (s) => { const p = titleProgress(s); return p.total > 0 && p.got * 2 >= p.total; } },
  { id: 'title-all', group: '称号', points: 10, name: '一个不落', icon: '💯', desc: '解锁全部称号', check: (s) => { const p = titleProgress(s); return p.total > 0 && p.got >= p.total; } }
];

// ── 判定 ──────────────────────────────────────────────────────────────────

/**
 * 算出这次有哪些称号**刚刚**达成。
 * @param {object} state
 * @param {object} [ctx] 全部字段都由 `index.js` 注入（本模块零 import，拿不到就"恒不达成"）：
 *   · `regionTotal`      —— 地区表条数（"装备齐全"用；拿不到退回 DEFAULT_EQUIP_TOTAL）
 *   · `fictionalRegions` —— 异世界 id 集合（"世界版图"那四条用）
 *   · `skillTotal` / `skillRegionOf` —— 技能总数 / `{skillId: regionId}`（"技能"那组用）
 *   · `companionTotal`   —— 旅伴总数（"满座"用）
 *   · `gardenTotal` / `gardenMax` —— 设施件数 / `{设施id: 满级}`（"庭院"那组用）
 *   · `allStyles`        —— 已废弃（"百变风格"删了），留着不碍事
 * @returns {Array<{id,group,name,icon,desc}>} 新达成的（已解锁的不会重复返回）
 */
export function evaluateTitles(state, ctx = {}) {
  const got = state?.titles || {};
  const out = [];
  for (const t of TITLES) {
    if (got[t.id]) continue;                 // 已解锁 → 跳过
    let ok = false;
    try { ok = t.check(state, ctx) === true; } catch { ok = false; }
    if (ok) out.push({ id: t.id, group: t.group, name: t.name, icon: t.icon, desc: t.desc, points: Math.max(0, Number(t.points) || 0) });
  }
  return out;
}

/** 把新达成的称号写进 state（不落盘，由调用方 save）。 */
export function markTitles(state, list) {
  const now = Date.now();
  for (const t of list) {
    if (!state.titles[t.id]) state.titles[t.id] = { at: now, count: 0 };
    state.titles[t.id].count = (Number(state.titles[t.id].count) || 0) + 1;
  }
  return state.titles;
}

/**
 * 进度概览。
 *
 * ★ 2026-10-13 晚：多返回 `points`（已拿到的成就值）与 `totalPoints`（总分）。
 *   **成就值目前没有用途**（用户："有什么用后面再说"）—— 这里先把数算出来、显示出来，
 *   以后要做"成就商店 / 解锁条件"之类的东西时直接取，不用再回头改一遍表。
 */
export function summarizeTitles(state, ctx = {}) {
  const got = state?.titles || {};
  let unlocked = 0;
  let points = 0;
  let totalPoints = 0;
  for (const t of TITLES) {
    const p = Math.max(0, Number(t.points) || 0);
    totalPoints += p;
    if (got[t.id]) { unlocked += 1; points += p; }
  }
  return {
    unlocked, total: TITLES.length, remain: TITLES.length - unlocked,
    points, totalPoints, pending: evaluateTitles(state, ctx)
  };
}
