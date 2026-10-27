// 矩阵庭院 · 旅程编排
//
// 本模块只做"决策与编排"，不碰网络、不碰存档：
//   搜索、LLM、生图都由调用方以回调注入。这样它**可以脱离运行环境单测**，
//   也避免技能内部出现"谁调用谁"的循环依赖。
//
// ── 选城市：池子 80% / 自由 20% ─────────────────────────────────────────
//   池子路径：从内置地区表里挑（2026-10-11 起：15 地区 / 143 组 / 984 个目的地 ——
//     其中 6 个是**异世界**，靠 regions.json 上的 `fictional: true` 标记走放宽分支）。
//     真实、有名、分布均匀，不会跑到搜不到内容的地方。
//   自由路径：让 LLM 在该地区内自由发挥，去池子外的城市 —— 保留惊喜感。
//     但必须过两道闸：① 大洲归属校验 ② 后续搜不到内容就回落池子。
//
// ── "尽量不重复"用的是**加权**，不是硬排除 ──────────────────────────────
//   同一个城市重复去是合理的（"故地重游"本身就是个称号），所以去得越多
//   权重越低，但**永远不为 0**。好处：池子永远不会"用完"，
//   也就不需要写"池子跑完怎么办"这种特例。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FOOD_TIERS, companionOf, companionsOf, partyCardMultOf, partyRareMultOf, cityKey
} from './state.js';
import { pickCharacterStyle } from './postcard.js';

// 口粮档位定义在 state.js（单一来源），这里原样转出，调用方只认 trip.js 一个入口
export { FOOD_TIERS };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 池子概率（其余走自由发挥）。 */
export const POOL_RATIO = 0.8;

/** 去过次数 → 抽中权重。去得越多越难再抽中，但永不为 0。 */
export function visitWeight(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return 10;
  if (n === 1) return 3;
  if (n === 2) return 1;
  return 0.5;
}

// ── 地区表加载 ────────────────────────────────────────────────────────────

const regionsFile = () => path.join(HERE, 'data', 'regions.json');
let _regions = null;

/** 读地区表（带缓存）。文件损坏时抛错，由调用方决定降级策略。 */
export function loadRegions(file = regionsFile()) {
  if (_regions && file === regionsFile()) return _regions;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed?.regions) ? parsed.regions : [];
  if (!list.length) throw new Error('地区表为空');
  if (file === regionsFile()) _regions = list;
  return list;
}

export function regionById(id) {
  return loadRegions().find((r) => r.id === id) || null;
}

// ── 敌手类型表（只有"机械型"才登记）────────────────────────────────────────
const foeKindsFile = () => path.join(HERE, 'data', 'foe-kinds.json');
let _foeKinds = null;

/**
 * 取这一组敌手的**类型**：`'machine'`（机械型，机动战士/发条机关这类）
 * 或 `''`（常规 —— 生物或人类，含虫群、兽人、恶魔、雇佣兵）。
 *
 * ★ 口径（用户 2026-10-12）：**只有"确实是机器"的敌手**才特殊处理。
 *   理由：机械不能按生物的打法叙述 —— 模型会写出"朝扎古扔石头""跟扎古谈条件"这种荒唐句。
 *   她对付这类东西的正确玩法是**黑入它们的系统**。虫群/兽人/恶魔一律照常"打跑/战胜"。
 *
 * ⚠️ 表里**只登记机械型**（见 data/foe-kinds.json），未登记的组一律当常规 ——
 *   所以表丢了/读坏了也不会让任何地区的战斗叙述变样（就是退回常规那套）。
 */
export function foeKindOf(regionId, country) {
  if (_foeKinds === null) {
    try {
      const parsed = JSON.parse(fs.readFileSync(foeKindsFile(), 'utf8'));
      _foeKinds = (parsed && parsed.kinds) || {};
    } catch { _foeKinds = {}; }
  }
  return String(_foeKinds[`${regionId}|${country}`] || '') === 'machine' ? 'machine' : '';
}

// ── 地点特征表（只登记"缺什么"）──────────────────────────────────────────────
const placeTraitsFile = () => path.join(HERE, 'data', 'place-traits.json');
let _missingTraits = null;

/** 允许的特征名（与 data/place-traits.json 的 vocabulary 一致）。
 *  ★ 10-13 加 `built`：人工造物（城墙/石碑/废墟/灯柱/招牌），**不要求有人** ——
 *    原先这类要求被混在 `folk` 里，会把"对着一块石碑发愣"从所有荒野一起封掉。 */
const TRAIT_IDS = new Set(['water', 'green', 'folk', 'built']);

/**
 * 取这一趟**缺**哪些特征：`['water','green','folk']` 的子集；不缺就返回 `[]`。
 *
 * ★ 由头（用户 2026-10-12）：状态池里有一批条目会**断言**目的地有某样东西
 *   ——"扶着栏杆看河水"、"赶在退潮时去海边"、"被一圈当地人围着看"、"泡酒馆打听消息"。
 *   可有些地方根本没有：**查尔是虫巢星球，除了虫子、石头就是岩浆，没有河海、没有植被、
 *   也没有本地人**。在那里看海 / 跟摊主讨价还价 = **凭空造地形**。
 *
 * ★★ 2026-10-13 加**城市级**（用户点名：她在幻想乡的「博丽神社」碰到了小孩）。
 *   ⚠️ 原先只有**组级**（`<regionId>|<组名>`），而组太粗了 ——
 *   「幻想乡中央」这一组里**同时**有「人间之里」（真有人）和「博丽神社」「雾之湖」
 *   （一个人都没有）；`considered_allowed` 里写着"有住民可交涉"就把它整组放过了。
 *   所以现在**三层取并集**：
 *     ① `missing`            —— 组级（原样保留）
 *     ② `missingCity`        —— 城市级（键 `<regionId>|<城市名>`）
 *     ③ `folkAbsentRegions`  —— **以荒野为主的异世界默认"没有人烟"**，
 *        除非该城市在 `folkPresentCities` 白名单里（人间之里、神圣泰拉…）。
 *
 * ⚠️ 全部**只登记"缺"**、未登记一律当"有" —— 所以表丢了/读坏了只是行为退回从前（可能说错），
 *   不会让所有地区的描述变样。③ 的白名单同理：漏了谁，只是那个地方少提几次市集。
 */
export function missingTraitsOf(regionId, country, city) {
  if (_missingTraits === null) {
    try {
      const parsed = JSON.parse(fs.readFileSync(placeTraitsFile(), 'utf8')) || {};
      _missingTraits = {
        group: parsed.missing || {},
        city: parsed.missingCity || {},
        absent: new Set(Array.isArray(parsed.folkAbsentRegions) ? parsed.folkAbsentRegions.map(String) : []),
        present: new Set(Array.isArray(parsed.folkPresentCities) ? parsed.folkPresentCities.map(String) : [])
      };
    } catch {
      _missingTraits = { group: {}, city: {}, absent: new Set(), present: new Set() };
    }
  }
  const out = new Set();
  const put = (raw) => {
    if (!Array.isArray(raw)) return;
    for (const x of raw) {
      const s = String(x);
      if (TRAIT_IDS.has(s)) out.add(s);
    }
  };
  put(_missingTraits.group[`${regionId}|${country}`]);
  if (city) {
    put(_missingTraits.city[`${regionId}|${city}`]);
    if (_missingTraits.absent.has(String(regionId)) && !_missingTraits.present.has(`${regionId}|${city}`)) {
      out.add('folk');
    }
  }
  return [...out];
}

/** 把一个国家的城市摊平（兼容 divisions（中国）与 cities（其他国家）两种写法）。 */
export function citiesOf(country) {
  const out = Array.isArray(country?.cities) ? [...country.cities] : [];
  for (const arr of Object.values(country?.divisions || {})) {
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out.filter(Boolean);
}

/**
 * 这个地区是不是**虚构世界**（异世界）。
 *
 * 判据：`region.fictional === true`，兼容 `kind === 'fictional'`（双保险，
 * 只读一个字段的话，数据里漏写另一个就静默失效）。
 *
 * 为什么必须有这个标记 —— 虚构地区在两件事和真实地区不同：
 *   ① 目的地粒度可以是**星球**：没有"国家"这一层 ⇒ `country` 允许为空；
 *   ② 搜索时要用**作品名**做消歧前缀，而不是国名：
 *      「神圣泰拉」单搜会撞现实地球，加「战锤40K」才准
 *      —— 和当初「庆州 → 庆阳」是同一个坑，只是换了个成因。
 */
export function isFictional(region) {
  return Boolean(region && (region.fictional === true || region.kind === 'fictional'));
}

/**
 * 把整个地区摊平成 [{ city, country }]。
 *
 * ★ 2026-10-11 异世界：条目**可以没有下级地名** —— 那时它自身就是目的地
 *   （`{name:'亚空间'}` → `{city:'亚空间', country:''}`），用来支持
 *   "以星球/据点为单位描绘"的作品。
 *   真实地区的条目都有 cities/divisions ⇒ 这个分支**永远不触发**，
 *   既有 9 个**真实**地区的行为与从前逐字节一致（`isFictional` 也拦了一道）。
 */
export function allCitiesOf(region) {
  const out = [];
  for (const c of region?.countries || []) {
    const cities = citiesOf(c);
    if (!cities.length) {
      if (isFictional(region) && c?.name) out.push({ city: c.name, country: '' });
      continue;
    }
    for (const city of cities) out.push({ city, country: c.name });
  }
  return out;
}

/**
 * 在**一个地区内**按名字找目的地 —— 给「指定去某地」用（2026-10-11 用户需求）。
 *
 * 匹配优先级（从严到宽，取第一个命中的）：
 *   ① 全名完全相等（忽略大小写/空格）—— 最可靠
 *   ② 目的地名**包含**输入（"杭州市" → "杭州"）
 *   ③ 输入**包含**目的地名（"艾尔星" → "艾尔"）
 *   ③ 放最后是因为它最松，容易撞（"上海" vs "上海南站"这种）。
 *
 * `country` 是可选的**消歧限定**：只在指定的那一组里找（"浙江" / "泰伦帝国"）。
 * 指定的组名不存在时**不报错**，退回全区搜 —— 宁可多找也不让"限定词写错"变成找不到。
 *
 * ★★ 2026-10-15（用户报"指定她去伊比利亚却去了巴塞罗那"）：原来**只认城市名**，
 *   点名一个**地区/国家**（"伊比利亚""西班牙""浙江"）一律判"没这个地方" ⇒ 返回 null。
 *   现在多一层：城市名都不中时，把输入当**地区/国家名**再找一次（见 `destinationsOfArea`）。
 *   兼容性：城市名命中时**行为逐字节不变**（仍返回那一个）。
 *
 * @returns {{city:string, country:string}|null}
 */
export function findDestination(region, opts = {}, rand = Math.random) {
  return findDestinations(region, opts, rand)[0] ?? null;
}

/**
 * 按「地区/国家名」取一组目的地（双向包含，与 `findDestination` 的松紧度一致）。
 * 纯函数、只读。空名 ⇒ `[]`。
 *
 * ★ 为什么需要它：真实地区与国家**不重名**（"浙江"是组名、"杭州"是城里），而异世界的
 *   "地区"往往就是玩家嘴里那个名字（"伊比利亚"是地区，真正的目的地是"静默圣所"）。
 *   ⇒ 只按城市名找，"伊比利亚"永远找不到。
 */
export function destinationsOfArea(region, areaName) {
  const w = String(areaName ?? '').trim().toLowerCase();
  if (!w) return [];
  return allCitiesOf(region).filter((x) => {
    const c = String(x.country || '').trim().toLowerCase();
    return Boolean(c) && (c === w || c.includes(w) || w.includes(c));
  });
}

/** Fisher–Yates，随机源可注入（探针要确定性）。 */
function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const r = Number(rand());
    const j = Math.floor((Number.isFinite(r) ? r : 0) * (i + 1)) % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/** 中文行政区后缀白名单 —— 反向匹配时"多写了后缀"只认这些。
 *  ⚠️ **故意不含 `道` / `府` / `都`** —— 那正是 `北海道 → 北海` 的入口（见 `isCityPlusSuffix`），
 *  而 regions.json 里日本的地名本来就是裸名（大阪 / 东京），不需要靠后缀去凑。 */
const ADMIN_SUFFIXES = ['省', '市', '区', '县', '州', '盟', '旗', '镇', '乡', '村'];

/**
 * ★★ 2026-10-16 修（用户报"让她去北海道，落脚却是北海"）：**反向子串匹配必须收窄**。
 *
 * 原来第三级是裸的 `w.includes(city)`：用户点一个**不存在**的地名时，只要它**包含**某个
 * 更短的真实城市名，就会被当成"点名成功"、**静默去错地方** ——
 * 「北海道」里含「北海」⇒ 去了中国·北海（她自己在群里都说"我报的北海道，落脚又是北海"）。
 * 这类失败最坏的地方是**看起来成功了**：群友以为去成了，实际去了另一座城市。
 *
 * 现在只认两种"多写了"的情形，其余一律不认（交给 `depart()` 老实回"没这个地方"）：
 *   ① **城市名 + 一个行政区后缀**：`杭州市` ← `杭州`；
 *   ② **组名/国家名 + 城市名**：`中国北海` ← 北海（头一段正好是这一组里的组名）。
 *
 * @param {string} w 用户点名的名字（已小写）
 * @param {{city:string,country:string}} x 池子里的候选
 * @param {Array} pool 当前候选池（判"头一段是不是组名"用）
 */
function isCityPlusSuffix(w, x, pool) {
  const c = String(x.city ?? '').trim().toLowerCase();
  if (!c) return false;
  const i = w.indexOf(c);
  if (i < 0) return false;
  const head = w.slice(0, i);
  const tail = w.slice(i + c.length);
  if (ADMIN_SUFFIXES.includes(tail)) return true;
  if (head && pool.some((y) => String(y.country ?? '').trim().toLowerCase() === head)) return true;
  return false;
}

/**
 * ★★ 2026-10-15：`findDestination` 的**候选列表**版 —— 给 `depart()` 的两轮尝试用。
 *
 * 为什么是"列表"而不是"一个"：点名**地区/国家**时下面有好几个城市（伊比利亚 →
 * 静默圣所／黄金时代遗迹），第一个搜不到内容时应该**换个城市再试**，
 * 而不是拿着同一个地方连栽两次（`depart` 的两次尝试就是为这个存在的）。
 *
 * 返回顺序：
 *   · **城市名命中** ⇒ `[那一个]`（行为与从前一致）；
 *   · **地区/国家名命中** ⇒ 那个组下的城市，**打乱**（她自己在地区里挑一个，rand 可注入）；
 *   · 都不中 ⇒ `[]`。
 *
 * @returns {Array<{city:string, country:string}>}
 */
export function findDestinations(region, { city, country } = {}, rand = Math.random) {
  const want = String(city ?? '').trim();
  const wantCountry = String(country ?? '').trim();
  const all = allCitiesOf(region);
  if (!all.length) return [];

  // 消歧限定（原样保留：只在指定的那一组里找；组名不存在时不报错、退回全区）
  let pool = all;
  if (wantCountry) {
    const inGroup = all.filter((x) => x.country === wantCountry
      || x.country.includes(wantCountry) || wantCountry.includes(x.country));
    if (inGroup.length) pool = inGroup;
  }

  const low = (s) => String(s ?? '').trim().toLowerCase();
  if (want) {
    const w = low(want);
    const hit = pool.find((x) => low(x.city) === w)
      || pool.find((x) => low(x.city).includes(w))
      || pool.find((x) => isCityPlusSuffix(w, x, pool));
    if (hit) return [hit];
    // ★ 城市名都不中 ⇒ 再当"地区/国家名"找一次（这一步是本次修的那条）
    const area = destinationsOfArea(region, want);
    if (area.length) return shuffled(area, rand);
  }
  // ★ 只给了 `country`（没给 city）⇒ 也当"点名地区"处理
  //   （`whale_go` 那边已在 2026-10-15 改成"只给 country 也会传下来"，见 index.js）
  if (!want && wantCountry) {
    const area = destinationsOfArea(region, wantCountry);
    if (area.length) return shuffled(area, rand);
  }
  return [];
}

// ── 加权随机 ──────────────────────────────────────────────────────────────

/**
 * 按权重抽一个。
 * @param {Array<{w:number}>} items
 * @param {() => number} rand 注入随机源，便于单测
 */
export function weightedPick(items, rand = Math.random) {
  const list = Array.isArray(items) ? items.filter((i) => Number(i.w) > 0) : [];
  if (!list.length) return items?.[0] ?? null;
  const total = list.reduce((s, i) => s + Number(i.w), 0);
  let r = rand() * total;
  for (const it of list) {
    r -= Number(it.w);
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}

// ── 池子路径 ──────────────────────────────────────────────────────────────

/**
 * 从地区表里加权抽一个城市。
 * @param {object} region
 * @param {object} state 用于查"去过几次"
 * @param {() => number} rand
 * @returns {{city:string, country:string, source:'pool'}}
 */
export function pickFromPool(region, state, rand = Math.random) {
  const pool = allCitiesOf(region);
  if (!pool.length) return null;
  const items = pool.map((x) => {
    // 键一律走 state.js 的 cityKey（**单一来源**）—— 它已经把"country 为空"
    // （异世界的星球级目的地）算进去了，别再手拼 `${country}·${city}`。
    const rec = state?.visitedCities?.[cityKey(x.country, x.city)];
    return { ...x, source: 'pool', w: visitWeight(rec?.count) };
  });
  return weightedPick(items, rand) || null;
}

// ── 自由路径 ──────────────────────────────────────────────────────────────

/** 从 LLM 回复里抠出 JSON（容忍 ```json 包裹 / 前后废话）。 */
export function extractJson(text) {
  const s = String(text ?? '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * 给自由路径用的提示词。要求模型只输出 JSON，并明确"不许编造"。
 *
 * ★ 2026-10-11 异世界：虚构地区走**另一套措辞** ——
 *   · 要求的是"**这部作品里确实存在**的地点"，而不是"真实城市"；
 *   · 明确允许 country 为空（有些作品只以星球/据点为单位，没有国家层）；
 *   · 明确允许 region 留空（作品内的地理归属模型未必清楚，**宁可让它别猜**）。
 */
export function buildFreeCityPrompt(region, visitedInRegion) {
  const countries = (region?.countries || []).map((c) => c.name).join('、');
  const avoid = visitedInRegion.length
    ? `\n【已经去过的，必须避开】${visitedInRegion.join('、')}`
    : '';

  if (isFictional(region)) {
    return [
      `你是旅行策划。请在虚构作品《${region.name}》的世界里，挑一个**地标级的目的地**让旅行者去看看。`,
      `这个作品里已知的大区域：${countries}。`,
      '可以挑上面区域里的其它地点，也可以挑这部作品里其它有名的地方 —— 星球、城市、要塞、遗迹、空间站都行。',
      avoid,
      '',
      '硬性要求：',
      '1. 必须是**这部作品里确实存在**的地点，不允许自己编名字；',
      '2. 要挑资料多、有辨识度的地方（能查到景点与特产的那种），不要挑只被提过一次的小地名；',
      '3. 这个世界**没有"国家"这一层也可以** —— 如果目的地本身就是一颗星球或一个据点，country 直接留空字符串；',
      '4. 不确定它属于哪个大区域时，region 也留空字符串，**不要猜**；',
      '5. 只输出一个 JSON 对象，不要任何解释、不要代码块之外的文字。',
      '',
      '输出格式：{"country":"所属国家或星系（可为空）","city":"目的地名","region":"大区域名（可为空）"}'
    ].join('\n');
  }

  return [
    `你是旅行策划。请为"${region.name}"选一个**真实存在、有知名度、能查到景点与特产**的城市。`,
    `这个地区已有的国家：${countries}。`,
    '优先挑上面国家的**其他城市**，也可以挑该地区内其它国家，但必须确实属于该地区。',
    avoid,
    '',
    '硬性要求：',
    '1. 必须是真实城市，不允许编造；',
    `2. 必须属于「${region.name}」，不能跨地区；`,
    '3. 要选有辨识度、值得旅行的地方，不要选冷门到查不到内容的小地方；',
    '4. 只输出一个 JSON 对象，不要任何解释、不要代码块之外的文字。',
    '',
    '输出格式：{"country":"国家名","city":"城市名","region":"该地区名"}'
  ].join('\n');
}

/**
 * 自由路径：让 LLM 挑一个地区内、池子外的城市。
 * 任何一步不达标（没注入 llm / 解析失败 / 跨地区 / 撞已去过）都返回 null，
 * 由调用方回落到池子路径 —— 绝不让"自由发挥"把旅程带沟里。
 */
export async function pickFreeCity(region, state, { llm, log, rand = Math.random } = {}) {
  if (typeof llm !== 'function') return null;
  const visitedInRegion = Object.values(state?.visitedCities || {})
    .filter((v) => v?.region === region.id)
    .map((v) => cityKey(v.country, v.city));   // 走单一来源：country 为空只给城市名

  let raw = '';
  try {
    raw = await llm(buildFreeCityPrompt(region, visitedInRegion));
  } catch (error) {
    log?.(`[travel-whale/trip] 自由路径 LLM 失败：${error?.message ?? error}`);
    return null;
  }

  const parsed = extractJson(raw);
  const city = String(parsed?.city ?? '').trim();
  const country = String(parsed?.country ?? '').trim();
  const claimedRegion = String(parsed?.region ?? '').trim();
  // ★ 异世界放宽：country 允许为空（作品只以星球/据点为单位时就该是空的）。
  //   真实地区维持原样 —— 两段都必须有。
  const fiction = isFictional(region);
  if (!city) return null;
  if (!country && !fiction) return null;

  // 闸门①：归属校验（模型自称的地区必须对得上）
  //   虚构地区**跳过**这一道：作品内的地理划分模型经常说不准，
  //   逼它填只会把正确答案误杀。跑题由 `depart()` 里
  //   "planTrip 返回 null 就重挑 / 回落池子"兜底，不会把旅程带沟里。
  if (!fiction && claimedRegion
      && !claimedRegion.includes(region.name) && !region.name.includes(claimedRegion)) {
    log?.(`[travel-whale/trip] 自由路径跨地区（声称 ${claimedRegion}，应为 ${region.name}），丢弃`);
    return null;
  }
  // 闸门②：别撞已经去过的
  const goKey = cityKey(country, city);
  if (visitedInRegion.includes(goKey)) {
    log?.(`[travel-whale/trip] 自由路径撞上已去过的 ${goKey}，丢弃`);
    return null;
  }
  return { city, country, source: 'free' };
}

// ── 主入口：80 / 20 ───────────────────────────────────────────────────────

/**
 * 选这趟去哪。
 * 池子 80% / 自由 20%；自由路径任何一处不达标 → 回落池子。
 * @returns {{city:string, country:string, source:'pool'|'free', fallback?:string}}
 */
export async function pickCity(region, state, opts = {}) {
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const log = opts.log;

  if (rand() < POOL_RATIO) {
    const picked = pickFromPool(region, state, rand);
    return picked ? { ...picked } : null;
  }

  const free = await pickFreeCity(region, state, { ...opts, rand });
  if (free) return free;

  // 自由路径没成 → 回落池子（这是它"不翻车"的保证）
  const back = pickFromPool(region, state, rand);
  return back ? { ...back, fallback: '自由路径未通过校验，已回落池子' } : null;
}

// ── 行程参数（纯逻辑、可单测）────────────────────────────────────────────

const HOUR = 3600 * 1000;

/** 口粮档位 → 本趟时长（毫秒）。档位非法时退回"中份"。 */
export function tripDuration(foodTier, rand = Math.random) {
  const t = FOOD_TIERS[foodTier] || FOOD_TIERS.normal;
  const h = t.minH + rand() * (t.maxH - t.minH);
  return Math.round(h * HOUR);
}

// 口粮档位定义在 state.js（单一来源），这里直接复用。

/**
 * 第一张明信片的**硬时限**：出发后 8 小时内一定要有一张。
 * 这是防「出门半天群里一点动静都没有」的保底 —— 玩家会以为功能坏了。
 */
export const FIRST_CARD_DEADLINE_MS = 8 * HOUR;

/** 单张明信片距出发的最小间隔（防止极短旅程把片全挤在出门那一刻）。 */
const CARD_MIN_OFFSET_MS = 60 * 1000;

/**
 * 按口粮档位抽本趟途中要寄几张明信片。
 *
 * 区间来自 FOOD_TIERS[x].cards：小份 1~2 / 中份 2~3 / 大份 2~4。
 * 出行前就抽定并写进 trip.cardTimes，之后不再重算 ——
 * 「我会收到几张」在出发那一刻就确定了。
 *
 * ★ 2026-10-11 加 `mult`：旅行伙伴的「明信片总量 +50%」。
 *   在**抽完之后**乘、再四舍五入并保底 1 —— 而不是去改 FOOD_TIERS 的区间。
 *   理由：区间是**档位定义**（"小份 1~2 张"这句话本身没说错），倍率是**本趟的加成**，
 *   两件事混在一起，以后再加别的加成就要互相打架。跟着吃双份饭的是加成，不是档位。
 * @param {number} mult 张数倍率（默认 1 = 无伙伴）
 */
export function pickCardCount(foodTier, rand = Math.random, mult = 1) {
  const t = FOOD_TIERS[foodTier] || FOOD_TIERS.normal;
  const range = Array.isArray(t.cards) ? t.cards : [1, 2];
  const lo = Math.max(1, Number(range[0]) || 1);
  const hi = Math.max(lo, Number(range[1]) || lo);
  const base = lo + Math.floor(rand() * (hi - lo + 1));
  const m = Number(mult) > 0 ? Number(mult) : 1;
  return Math.max(1, Math.round(base * m));
}

/**
 * 把 N 张明信片铺进这趟旅程。
 *
 * 做法：把旅程等分成 N+1 段，每张落在段中心，再加不超过 12.5% 的抖动
 * （避免每次都在同一时刻）。
 * 硬约束两条：① 第一张不晚于 firstDeadlineMs（默认 FIRST_CARD_DEADLINE_MS）；
 * ② 所有片都在到家之前。
 *
 * ★ 2026-10-13 晚：把"第一张的时限"做成参数 —— 海拉鲁「希卡导航」要把它从 8 小时压到 4 小时。
 *   （由 `planTrip` 从存档里的 `state.whale.firstCardDeadlineMs` 读出来传进来。）
 *
 * @returns {number[]} 升序时间戳
 */
export function planCardTimes(departAt, durationMs, count, rand = Math.random,
  firstDeadlineMs = FIRST_CARD_DEADLINE_MS) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const span = Math.max(CARD_MIN_OFFSET_MS * 2, Number(durationMs) || 0);
  // 时限至少 30 分钟（免得被传进 0 / 负数时第一张卡贴到出发那一刻）
  const deadline = Math.max(30 * 60 * 1000, Number(firstDeadlineMs) || FIRST_CARD_DEADLINE_MS);
  // ★★ 2026-10-14 修「相邻两张只隔 13 分钟」（用户报的观感问题）。
  //
  //   旧写法对**绝对时刻**加抖动：`t = 均匀位置; t += (rand()-0.5)*t*0.25`。
  //   抖动幅度是 `t` 的 ±12.5%，而相邻两张的差是 `step ≈ span/(n+1)` ——
  //   于是当 i 变大时，**下界差 = step*(0.625 - 0.25*i)** 会趋近 0、甚至变负
  //   （靠最后那句 `sort()` 硬掰回来 ⇒ 表现为"两张挤在一起"）。
  //   实测一趟 60 小时 / 6 张就能出现 13 分钟的两张。
  //
  //   现在改成**按权重分配"间隔"**：先掷 n 个 0.75~1.25 的权重，再按占比切分总跨度。
  //   ⇒ 相邻间隔天然 ≥ `0.75/sumW × span × ARRIVE_FRAC`（一趟 60 小时 ⇒ 至少 ~5 小时），
  //     且**总和恒为 `span × ARRIVE_FRAC`**（不会溢出到返程之后）。
  const ARRIVE_FRAC = 0.9;                 // 最后一张落在整趟的 90% 处，留 10% 给她往家走
  const total = span * ARRIVE_FRAC;
  const out = [];
  if (n === 1) {
    let t = Math.max(CARD_MIN_OFFSET_MS, Math.min(total, deadline));
    return [Math.round(departAt + t)];
  }
  const weights = [];
  for (let i = 0; i < n; i += 1) weights.push(0.75 + rand() * 0.5);
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    t += (weights[i] / sumW) * total;
    let at = Math.max(CARD_MIN_OFFSET_MS, t);
    // 第一张仍受"出发后 N 小时内必须寄出"的时限约束（口径与从前一致）
    if (i === 0) at = Math.min(at, Math.max(CARD_MIN_OFFSET_MS, deadline));
    out.push(Math.round(departAt + at));
  }
  return out.sort((a, b) => a - b);
}

// ── 稀有度判定 ────────────────────────────────────────────────────────────

/** 标签优先级：判「每趟 1 件稀有」名额时，rare 标签排最前。 */
const ORDER = { rare: 0, uncommon: 1, common: 2 };

/** 稀有度基础概率（LLM 打的标签 → 起步概率）。 */
export const RARITY_BASE = { common: 0.05, uncommon: 0.35, rare: 1 };
/** 图鉴里从没得过 → 新鲜感加成。 */
export const NEW_BONUS = 0.15;

/**
 * 判定一件特产是否会以"稀有"形式出现。
 *
 * 三层：① LLM 标签定基础概率 ② 护身符加成 ③ 首次获得加成。
 * 注意"每趟最多 1 件稀有"由调用方在**本函数之外**兜底 —— 那是行程级规则，
 * 混进单件判定会让函数不再纯粹、也没法单测。
 * @returns {boolean}
 */
export function isRare(label, { luck = 0, isNew = false, rand = Math.random } = {}) {
  const base = RARITY_BASE[label] ?? RARITY_BASE.common;
  const p = Math.min(1, base + Math.max(0, Number(luck) || 0) + (isNew ? NEW_BONUS : 0));
  return rand() < p;
}

/**
 * 给一整趟的候选特产判稀有度，并强制**最多 1 件稀有**。
 * @param {Array<{name:string, rarity?:string, kind?:string}>} candidates  入参的标签字段叫 `rarity`（LLM 打的）
 * @returns {Array<{name:string, label:string, isRare:boolean, kind:string}>}
 *   ⚠️ 出参改叫 **`label`** —— 别再按老注释去读 `.rarity`，实现里根本没有那个字段
 *   （2026-10-11 踩到：验证脚本照注释打印 `.rarity`，稀有度全成了 `undefined`，
 *   看着像"稀有度没判"，其实是字段名读错。**注释与实现冲突时以实现为准**。）
 *   ★ 2026-10-14：出参多带一个 `kind`（food/plant/relic，来自模型打标）。**这一层原本会把它丢掉**
 *   —— 抽取出 `{name, rarity, kind}`，到这里只剩 `{name, label, isRare}`，
 *   而存档只认这条链 ⇒ 不补的话 `kind` 永远到不了图鉴，"能吃/能种"全废。
 */
export function judgeSouvenirs(candidates, { luck = 0, owned = new Set(), rand = Math.random } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c, i) => ({ c, i }))
    // ⚠️ 按**标签稀有度**排序后再判，让 rare 标签优先占用「每趟 1 件」的名额。
    //    不排的话硬上限就是「先到先得」：一件 common 掷中了，会把后面标着 rare、
    //    本该 100% 必出的那件挤成普通（实测被挤掉的概率 80%~96%），
    //    LLM 打的 rare 标签也就形同虚设了。
    .sort((a, b) => {
      const oa = ORDER[String(a.c?.rarity ?? 'common').toLowerCase()] ?? 2;
      const ob = ORDER[String(b.c?.rarity ?? 'common').toLowerCase()] ?? 2;
      return oa - ob || a.i - b.i;   // 同档保持原顺序（稳定）
    });

  const out = new Array(list.length);
  let rareUsed = false;
  for (const { c, i } of list) {
    const name = String(c?.name ?? '').trim();
    if (!name) { out[i] = null; continue; }
    const label = String(c?.rarity ?? 'common').toLowerCase();
    const kind = String(c?.kind ?? '').toLowerCase();
    const isNew = !owned.has(name);
    let rare = isRare(label, { luck, isNew, rand });
    if (rare && rareUsed) rare = false;      // 一趟只允许一件稀有
    if (rare) rareUsed = true;
    // 落回原位置，播报顺序不变。★ `kind` 只采信合法值（无效 ⇒ 空串，由读侧推断）。
    // ★★ v3.2：`note`（她的批注）也**必须在这一层原样带出去** ——
    //   和 `kind` 同一个坑：这一层是"白名单式重建"，字段漏了就等于整条链白做
    //   （3.1 的 `kind` 就是在这里被丢过一次，见文件头与 §96）。
    const note = String(c?.note ?? '').trim();
    out[i] = {
      name, label, isRare: rare, kind: VALID_KIND.has(kind) ? kind : '',
      ...(note ? { note } : {})
    };
  }
  return out.filter(Boolean);
}

// ── 候选挑选 ──────────────────────────────────────────────────────────────

/** 从候选里抽 n 个不重复项（洗牌后截取）。 */
export function pickDistinct(list, n, rand = Math.random) {
  const arr = (Array.isArray(list) ? list : []).filter(Boolean);
  const out = [];
  const pool = [...arr];
  const want = Math.max(0, Math.min(Number(n) || 0, pool.length));
  for (let i = 0; i < want; i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

// ── 从搜索结果里抽取景点 / 特产 ────────────────────────────────────────────
//
// 为什么要过一道 LLM 抽取，而不是直接拿搜索摘要：
//   搜索返回的是**网页摘要**（标题+片段），形状五花八门。要变成"景点名 + 画面描述"
//   和"特产名 + 稀有度"，中间必须有一步结构化。
//
// 为什么强调"只能从资料里提取"：
//   模型最爱干的事就是"顺手编一个有名的景点"。这里把资料全文给它，并要求
//   只许摘不许编 —— 这是**防幻觉的第一道闸**；第二道闸是下面只保留
//   能在资料里找到依据的条目（见 hasGrounding）。

/** 把搜索结果拼成一段可读资料（标题 + 摘要）。 */
/**
 * 把两组结果**交叉**合并：A1 B1 A2 B2 …
 *
 * ⚠️ 不要图省事写 [...a, ...b] 再截断 —— 那样前一组会把名额吃光。
 *    踩过的坑：`searchTextOf([...spotResults, ...souvResults])` 用的是默认上限 8，
 *    而「景点」那组恰好搜到 8 条，于是「特产」8 条**整组被切掉**，
 *    LLM 从头到尾只看到景点资料 → 抽出来的特产一个都过不了出处校验，
 *    最终 0 件特产（庆州那趟就是这样，搜到 8 条特产资料却一件没抽出来）。
 */
function interleave(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i]) out.push(x[i]);
    if (y[i]) out.push(y[i]);
  }
  return out;
}

export function searchTextOf(results, max = 8) {
  return (Array.isArray(results) ? results : [])
    .slice(0, max)
    .map((r, i) => `[${i + 1}] ${r?.title || ''}\n${r?.snippet || ''}`)
    .filter((s) => s.trim())
    .join('\n\n');
}

/**
 * 有搜索资料时的提示词（强约束：只许摘不许编）。
 *
 * ★ 2026-10-11 两条新增，都是实测逼出来的：
 *   ① **防串味**：搜虚构地名会混进大量**现实世界**内容 ——
 *      搜「夏尔」8 条里 6 条是新西兰霍比屯，搜「神圣泰拉」会混进现实地球。
 *      不显式排除，就会产出"夏尔的特产：新西兰奶制品"这种荒谬组合。
 *   ② **虚构地区的特产口径**：作品里的"特产"往往是**材料/器物/饮品**
 *      （矿石、灵药、烈酒），不是现实意义的土产；不点破，模型会硬凑。
 */
/**
 * ★★ 2026-10-14（v3.2）「特产批注」的两段共用文本 —— **只有同行旅伴带 `noteSouvenirs` 时才加**。
 *
 * 为什么塞进提示词、而不是等回来之后再调一次模型写：
 *   抽特产这一步**本来就要模型读一遍资料**（`buildExtractPrompt` 的资料 / 兜底的景点），
 *   顺手要一行批注 = **零额外调用、零额外延迟**；而且批注能贴着资料写。
 *   事后凭一个名字编，最容易写出"这件东西很特别"这种空话。
 * ⚠️ 长度卡在 16 字：它要进**图鉴页表格的第二行**（720 宽，第一列只占 33%）——
 *   长了会把行撑高、整页变丑。`normalizeExtraction` 还会再兜一次底（截断）。
 */
const NOTE_SPEC = (on) => (on ? [
  '   ★ 每件再给一个 note：**一行、不超过 16 字**的批注 —— 像**随行的人**随手记在笔记本上的那一句',
  '     （例："比想象的沉"/"闻着像雨后"/"老板说是最后一件"）。要具体、有画面；',
  '     ⚠️ 不要写"很有特色""值得收藏"这种空话，也不要写成广告词。'
] : []);
/** 输出格式里的 souvenirs 形状（要不要 note 字段由它决定 —— 两个提示词共用，避免手抄两份）。 */
const EXTRACT_SHAPE = (on) => (on
  ? '{"spots":[{"name":"","scene":""}],"souvenirs":[{"name":"","rarity":"","kind":"","note":""}]}'
  : '{"spots":[{"name":"","scene":""}],"souvenirs":[{"name":"","rarity":"","kind":""}]}');

export function buildExtractPrompt({ city, country, searchText, fictional = false, withNote = false }) {
  return [
    `下面是从网上搜到的关于「${[country, city].filter(Boolean).join('·')}」的资料。`,
    '请从中提取两类信息：',
    '',
    '1. **spots**：最著名的 1~2 个景点。每个给 {name, scene}。',
    '   scene 是**画面描述**（具体视觉元素，供绘画使用），例如"黄河铁桥、白塔山、夕阳下的河面"，**不要只写地名**。',
    '2. **souvenirs**：2~4 件当地特产。每件给 {name, rarity, kind}。',
    '   rarity 只能是 common / uncommon / rare。判据：',
    '   - common：日常食物、可量产的纪念品（如牛肉面、冰箱贴）',
    '   - uncommon：有地方性但容易买到（如本地茶叶、精油）',
    '   - rare：非遗手作、地理独有、限量、有故事（如奇石、手工刻品）',
    '   kind 只能填 food / plant / relic 之一，判据：',
    '   - food：**能吃能喝的**（菜肴、点心、饮品、酒、茶）',
    '   - plant：**能种活的**（种子、秧苗、花草、稻麦、树木、菌菇、果蔬）',
    '   - relic：**既不能吃也不能种的**（器物、工艺品、织物、石头、护符、摆件）',
    '   ⚠️ 一样东西如果**既能吃又能种**（辣椒、麦子、果树）一律填 plant。',
    '   ⚠️ 拿不准就填 relic —— 填错的代价只是不能吃/不能种，它仍然能收藏、能送人。',
    ...NOTE_SPEC(withNote),
    ...(fictional ? [
      '   ★ 这里是**虚构作品里的地点**：特产可以是作品里特有的**材料、器物、食物、饮品**',
      '     （如矿石、灵药、烈酒、法器），不必是现实意义的土产；rarity 依旧按"多常见 / 多难得"判。'
    ] : []),
    '',
    '硬性要求：',
    '- **只能从下面的资料里提取**，绝不允许编造资料里没有的景点或特产；',
    '- 资料里混进来的**现实世界内容一律忽略**：拍摄取景地、现实原型考据、电影/联动活动、周边商品、演员与制作组 —— 它们不是这个地点的景点或特产；',
    '- 资料里信息不够就少给几个，**宁缺毋滥**；',
    '- 只输出一个 JSON 对象，不要解释、不要代码块之外的文字。',
    '',
    `输出格式：${EXTRACT_SHAPE(withNote)}`,
    '',
    '=== 资料开始 ===',
    searchText,
    '=== 资料结束 ==='
  ].join('\n');
}

/** 没有搜索资料时的兜底提示词（靠模型自身知识，明确标注可信度更低）。 */
export function buildKnowledgePrompt({ city, country, fictional = false, withNote = false }) {
  return [
    `请凭你的知识，列出「${[country, city].filter(Boolean).join('·')}」的：`,
    '1. **spots**：最著名的 1~2 个景点，每个 {name, scene}（scene 写具体画面元素，不要只写地名）；',
    `2. **souvenirs**：2~3 件当地特产，每件 {name, rarity, kind${withNote ? ', note' : ''}}`
      + `（common/uncommon/rare；kind 为 food/plant/relic${withNote ? '；note 见下' : ''}）。`,
    // ⚠️ 关掉时**必须一行都不加**（空字符串也不行）—— 否则"没请 Kimi"的提示词与从前不等长，
    //   本项目对"关掉 ⇒ 逐字节等于从前"是有纪律的（见 index.js 里技能那几段的注释）。
    ...(withNote ? ['', ...NOTE_SPEC(true)] : []),
    '要求：**只写你确实有把握的**，不确定的宁可不写；不要编造地名或特产。',
    ...(fictional ? [
      '★ 这是**虚构作品里的地点**：特产写成作品里特有的材料、器物、食物、饮品即可，不必是现实意义的土产。',
      '★ 不要把**现实世界的对应物**混进来（拍摄取景地、现实原型考据、电影与联动活动）—— 只写作品设定里的东西。'
    ] : []),
    '只输出 JSON：{"spots":[{"name":"","scene":""}],"souvenirs":[{"name":"","rarity":"","kind":""}]}'
  ].join('\n');
}

/**
 * **特产兜底**提示词 —— 资料里一件特产都搜不到时的最后一招（2026-10-11 用户需求）。
 *
 * ⚠️ 这一段**明确是"编"**，和本项目其它提示词"只许摘不许编"的原则相反。
 *    所以有两条纪律：
 *      ① 调用方必须保证**确实一件都没有**（`souvenirs.length === 0`）才用 —— 它是兜底，不是常规路径；
 *      ② 编也得**有据可依**：把已经抽到的景点和画面描述喂进去，让它顺着环境/势力/文化推，
 *         而不是凭空发明一个和这地方毫不相干的东西。
 *    （实测背景：军事基地「贾布罗」搜"特产"真的 0 条 —— 那趟就白跑了、图鉴也不动，
 *      体验上像功能坏了。有了这个兜底至少能带回军粮徽章之类。）
 */
export function buildMakeUpSouvenirPrompt({ city, country, spots, fictional = false, withNote = false }) {
  const where = [country, city].filter(Boolean).join('·');
  const known = (Array.isArray(spots) ? spots : [])
    .map((s) => `- ${String(s?.name || '').trim()}：${String(s?.scene || '').trim().slice(0, 90)}`)
    .filter((x) => x !== '- ：')
    .join('\n') || '（暂时也没抽到景点）';

  return [
    `「${where}」这个地方，翻遍资料也**没有找到任何当地特产**。`,
    '但旅行一趟总得带点东西回来。请根据下面已知的景点，**合理地拟** 2~3 件旅行者会带回来的东西。',
    '',
    '已知的景点：',
    known,
    '',
    '要求：',
    '- 必须和这个地方的**环境 / 势力 / 文化**对得上：军事基地就出军粮、徽章、制服配件；',
    '  港口就出海产、贝壳、绳结；废墟就出残片、旧书、遗物 —— 别写和这里毫不相干的通用纪念品；',
    '- 名字要**具体、能想象出样子**，不要写"某纪念品""特色小物"这种空话；',
    ...(fictional ? ['- 这是虚构作品里的地点：可以是作品设定中的材料、器物、食物、饮品。'] : []),
    '- 每件给 rarity：common（到处都是）/ uncommon（要花点工夫）/ rare（难得一见）；2~3 件里**最多 1 件 rare**；',
    '- 每件给 kind：food（能吃能喝）/ plant（能种活）/ relic（既不能吃也不能种：器物、残片、遗物）；',
    ...NOTE_SPEC(withNote),
    `- 只输出 JSON，不要任何解释：${withNote
      ? '{"souvenirs":[{"name":"","rarity":"","kind":"","note":""}]}'
      : '{"souvenirs":[{"name":"","rarity":"","kind":""}]}'}`
  ].join('\n');
}

/**
 * 通用词黑名单。
 *
 * ⚠️ 这里踩过一个真实的坑：片段匹配原本从 **2 字**起，结果"莫须有特产"
 * 因为含"特产"二字而通过了校验 —— 而搜索结果的**标题**里几乎必然出现
 * "XX特产大全"。于是编造的名字只要沾上通用词就能蒙混过关，防幻觉形同虚设。
 * 现在：① 片段匹配最短 3 字；② 通用词直接排除。
 */
const GROUNDING_STOPWORDS = new Set([
  '特产', '景点', '名胜', '美景', '美食', '小吃', '零食', '土产', '纪念品', '伴手礼', '手信',
  '旅游', '旅行', '风景', '特色', '当地', '著名', '知名', '推荐', '攻略', '打卡', '必去'
]);

/**
 * 资料里是否找得到这个词的依据（防幻觉第二道闸）。
 * 无资料模式（纯模型知识）直接放行 —— 那时本来就没有可对照的文本。
 */
export function hasGrounding(name, searchText) {
  const n = String(name ?? '').trim();
  if (!n || n.length < 2) return false;
  const t = String(searchText ?? '');
  if (!t) return true;                       // 无资料模式不校验
  if (t.includes(n)) return true;            // 全名直接命中，最可靠
  // 容忍"兰州牛肉面"(模型给的) vs "牛肉面"(资料里的)：取 3~4 字片段回查
  for (let len = Math.min(4, n.length); len >= 3; len--) {
    for (let i = 0; i + len <= n.length; i++) {
      const frag = n.slice(i, i + len);
      if (GROUNDING_STOPWORDS.has(frag)) continue;
      if (t.includes(frag)) return true;
    }
  }
  return false;
}

const VALID_RARITY = new Set(['common', 'uncommon', 'rare']);
/** ★ 2026-10-14 特产分类（模型打标）。三个值之外的都当"没给"，交给读侧推断。 */
const VALID_KIND = new Set(['food', 'plant', 'relic']);
/**
 * ★★ v3.2 特产批注的**硬上限**（字符）。
 * 提示词里要的是"一行不超过 16 字"，这里放到 40 只是**兜住跑飞的情况** ——
 * 它要进图鉴页表格的第一列（720 宽下占 33%），太长会把行撑爆。
 */
const NOTE_MAX = 40;

/**
 * 把 LLM 的抽取结果规范化。
 * @param {any} parsed
 * @param {{searchText?:string, spotLimit?:number, souvenirLimit?:number}} opts
 */
export function normalizeExtraction(parsed, opts = {}) {
  const spotLimit = Math.max(1, Number(opts.spotLimit) || 2);
  const souvenirLimit = Math.max(1, Number(opts.souvenirLimit) || 4);
  const searchText = opts.searchText || '';

  const spots = [];
  for (const s of Array.isArray(parsed?.spots) ? parsed.spots : []) {
    const name = String(s?.name ?? '').trim();
    const scene = String(s?.scene ?? '').trim();
    if (!name) continue;
    if (!hasGrounding(name, searchText)) continue;   // 编造的丢掉
    spots.push({ name, scene: scene || name });
    if (spots.length >= spotLimit) break;
  }

  const souvenirs = [];
  for (const x of Array.isArray(parsed?.souvenirs) ? parsed.souvenirs : []) {
    const name = String(x?.name ?? '').trim();
    if (!name) continue;
    if (!hasGrounding(name, searchText)) continue;
    const rarity = String(x?.rarity ?? 'common').toLowerCase();
    const kind = String(x?.kind ?? '').toLowerCase();
    // ★ 2026-10-14：分类只**采信模型给的合法值**，无效就留空字符串。
    //   ⚠️ 这里刻意**不做名字推断兜底** —— 推断属于"读侧"（`souvenir.js` 的 `kindOf()`），
    //   因为老存档的条目也要能推断，写在这里只覆盖"新抽到的这一趟"。
    // ★★ v3.2 特产批注（Kimi「博闻」）：**只在她同行时才收**（`opts.withNote`）。
    //   为什么这么严：note 会**印在图鉴页上**，乱收一句"这个很有名"比没有更糟；
    //   而且"没请她 ⇒ 提示词里根本没要这个字段"，真收到只可能是模型的幻觉。
    const note = opts.withNote ? String(x?.note ?? '').trim().slice(0, NOTE_MAX) : '';
    souvenirs.push({
      name,
      rarity: VALID_RARITY.has(rarity) ? rarity : 'common',
      kind: VALID_KIND.has(kind) ? kind : '',
      ...(note ? { note } : {})
    });
    if (souvenirs.length >= souvenirLimit) break;
  }

  return { spots, souvenirs };
}

// ── 稀有明信片 ──────────────────────────────────────────────────────────
//
// ⚠️ 这是**后补的**：原设计写着「护身符提升稀有明信片 / 稀有特产的概率」，
//    但实现时只做了特产那一半 —— 护身符的 luck 全程只喂给 judgeSouvenirs。
//    所以在此之前「稀有明信片」只是个说法，代码里不存在。
//
// 与特产稀有度的区别：
//   · 特产的概率由 **LLM 打的标签**起步（common 5% / uncommon 35% / rare 100%）
//   · 明信片没有标签，只能给一个**固定基础概率**，靠护身符和"首次到访"往上抬

/** 明信片出稀有的基础概率。 */
export const CARD_RARE_BASE = 0.10;
/** 第一次来这座城市时的加成（新鲜感）。 */
export const CARD_RARE_FIRST_BONUS = 0.10;
/**
 * 护身符 luck 用在明信片上的系数。
 *
 * 为什么是 0.5 而不是 1：luck 是为**特产**调的（0.12/0.25/0.40），
 * 直接套到只有 10% 基础的明信片上，戴深海珍珠就能到 50%，稀有就不再稀有。
 * 砍半后：海螺 +6% / 护符 +12.5% / 珍珠 +20%，最高 40%，还算克制。
 */
export const CARD_LUCK_FACTOR = 0.5;

/**
 * 抽一张明信片是不是稀有。
 *
 * ★ 2026-10-11 加 `rareMult`：旅行伙伴的「稀有概率 ×2」。
 *   乘法加在**基础概率 + 护身符 + 首访**那一整坨之后、clamp 之前 ——
 *   也就是"最终概率整体翻倍"，而不是只翻基础那 10%。护身符与伙伴**可叠加**
 *   （戴深海珍珠 + 带狐狸：0.10+0.20+0.10 = 0.40 → 0.80）。
 * @returns {'rare'|'common'}
 */
export function rollCardRarity({ luck = 0, isFirstVisit = false, rand = Math.random, rareMult = 1, bonus = 0 } = {}) {
  const m = Number(rareMult) > 0 ? Number(rareMult) : 1;
  // ★ 2026-10-13 技能「数据护盾」：一个**加法**项。
  //   ⚠️ 绝不新增 rareMult 乘数 —— 现行稀有率上限已到 66%（见 MEMORY-2 §69 的算式）。
  const bn = Math.max(0, Number(bonus) || 0);
  const p = Math.min(1, (CARD_RARE_BASE
    + Math.max(0, Number(luck) || 0) * CARD_LUCK_FACTOR
    + (isFirstVisit ? CARD_RARE_FIRST_BONUS : 0)
    + bn) * m);
  return rand() < p ? 'rare' : 'common';
}

/**
 * 出行前把**每张明信片寄什么**也定下来。
 *
 * 规则：按顺序给每张分配一个**没被用过**的景点；景点用完了，剩下的那张就改做
 * **「特产明信片」**（主题是这趟带回来的东西，不是又一个打卡点）。
 *
 * 为什么要有这条：景点只搜到 1~2 个，而明信片一共 3 张（2 途中 + 1 到家）。
 * 按老逻辑硬铺，必然出现"同一个景点连寄两张"，读起来像卡带。
 * 改成让多出来的那张讲特产，既避免了重复，也让"回来带了什么"这条线有地方交代。
 *
/**
 * 这一张特产卡**只讲哪几件**。
 *
 * ★ 2026-10-23（用户报「明信片文风有点怪」的实证根因）：
 *   一趟 17 小时的行程有 7 张卡，而景点常常只有 2 个 ⇒ 剩下 5 张全走 souvenir 分支，
 *   而每一张都把**同一批 3~4 件特产**整包塞进提示词。
 *   于是弗兰格尔岛连出 3 张、蒙巴萨连出 2 张，写出来全是
 *   「行李箱塞得满满当当 / 拉链差点撑裂 / 嫌弃但还是带回去」——
 *   **不是模型不会写，是素材一模一样，它只能换着说同一件事。**
 *   现在按张次切片：3 件特产配 5 张卡 ⇒ 每张讲 1 件，轮着来（0,1,2,0,1）。
 *   ⚠️ 只影响**文案**；画面仍按整批摆（`composePostcard` 用 `p.souvenirs`）。
 *
 * @param {string[]} bag 这一趟的全部特产名
 * @param {number} idx 这是第几张特产卡（从 0 起）
 * @param {number} cardCount 这一趟总共会有几张特产卡
 * @returns {string[]} 这一张要讲的特产（空 = 调用方退回整批）
 */
function souvenirFocusOf(bag, idx, cardCount) {
  const n = Array.isArray(bag) ? bag.length : 0;
  if (!n) return [];
  // 每张讲几件：件少卡多 ⇒ 1 件；件多卡少 ⇒ 最多 2 件（再多就又是一堆）
  const k = Math.max(1, Math.min(2, Math.ceil(n / Math.max(1, cardCount))));
  const start = (Math.max(0, Number(idx) || 0) * k) % n;
  const out = [];
  for (let i = 0; i < k; i += 1) out.push(bag[(start + i) % n]);
  return Array.from(new Set(out)).filter(Boolean);
}

/**
 * @param {{spots:Array, souvenirs:Array, cardTimes:number[], returnAt:number}} p
 * @returns {Array<{at:number, kind:'spot'|'souvenir', spot:string, scene:string, isReturn:boolean, souvenirs?:string[], souvenirFocus?:string[]}>}
 */
export function planCardContent({ spots, souvenirs, cardTimes, returnAt, luck = 0, isFirstVisit = false, rand = Math.random, rareMult = 1, rareBonus = 0 }) {
  const list = (Array.isArray(spots) && spots.length) ? spots : [{ name: '', scene: '' }];
  const times = Array.isArray(cardTimes) ? cardTimes : [];
  const total = times.length + 1;          // +1 = 到家那张
  const bag = (Array.isArray(souvenirs) ? souvenirs : []).map((x) => x?.name).filter(Boolean);
  const out = [];
  let cursor = 0;
  // 会有几张特产卡 = 卡位总数 − 景点数（景点用完的那些卡位）。用来给 focus 切片。
  const souvCount = Math.max(0, total - Math.min(list.length, total));
  let souvSeq = 0;

  for (let k = 0; k < total; k += 1) {
    const isReturn = k === total - 1;
    const at = isReturn ? Number(returnAt) : times[k];
    if (cursor < list.length) {
      const s = list[cursor];
      out.push({ at, kind: 'spot', spot: s.name || '', scene: s.scene || '', isReturn,
        rarity: rollCardRarity({ luck, isFirstVisit, rand, rareMult, bonus: rareBonus }) });
      cursor += 1;
    } else {
      // 景点用完了。
      //
      // ⚠️ 但**只有真的有特产可讲**时才改做特产明信片 —— 否则会造出一张
      //    「捧着的特产：」后面空着的卡（真踩过：庆州那趟搜到 8 条特产资料却
      //    一件都没抽出来，第 3 张照样被标成特产主题，提示词直接成了残废）。
      //    没特产就**循环复用景点**，至少不空。
      if (bag.length) {
        const last = list[list.length - 1] || { name: '', scene: '' };
        // ★ 这一张只讲其中一两件（见 souvenirFocusOf）—— 否则同批特产会连写 5 张同义句
        const focus = souvenirFocusOf(bag, souvSeq, souvCount);
        souvSeq += 1;
        out.push({
          at, kind: 'souvenir', spot: last.name || '', scene: last.scene || '',
          isReturn, souvenirs: bag, souvenirFocus: focus,
          rarity: rollCardRarity({ luck, isFirstVisit, rand, rareMult, bonus: rareBonus })
        });
      } else {
        const cyc = list[cursor % list.length] || { name: '', scene: '' };
        out.push({
          at, kind: 'spot', spot: cyc.name || '', scene: cyc.scene || '',
          isReturn, rarity: rollCardRarity({ luck, isFirstVisit, rand, rareMult, bonus: rareBonus })
        });
        cursor += 1;
      }
    }
  }
  return out;
}

// ── 行程编排 ──────────────────────────────────────────────────────────────

/** 每趟只选一种画风（同一趟的明信片才成套）。 */
/**
 * ★★ 2026-10-18（方案三）：画风按**契合度**加权抽，不再等概率。
 *
 * 病：6 个画风同权 ⇒ 40K 有 1/6 概率抽到「机械蓝图画稿」（工程图，画人物必崩），
 *   也有相当概率抽到偏亮的那一个 ⇒ 同一趟里"世界观对、明度不对"。
 * 药：`data/style-tiers.json` 给每个地区每个画风标 1/2/3 ——
 *   1＝贴合（3 份权重）、2＝中性（1 份）、3＝冲突（不进池）。
 *   全部被打成 3 的极端情况退回全池等概率（绝不返回 undefined）。
 */
const TIERS_FILE = path.join(HERE, 'data', 'style-tiers.json');
let styleTiersCache = null;
function loadStyleTiers() {
  if (styleTiersCache) return styleTiersCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8'));
    styleTiersCache = raw && typeof raw.tiers === 'object' ? raw.tiers : {};
  } catch (error) {
    console.warn('[travel-whale] 画风契合度表读取失败（退回等概率）：' + (error?.message ?? error));
    styleTiersCache = {};
  }
  return styleTiersCache;
}

/** 1 → 3 份，2 → 1 份，3 → 0 份（不进池）。 */
function styleWeight(row, name) {
  const t = Number(row?.[name]);
  if (t === 1) return 3;
  if (t === 3) return 0;
  return 1;
}

export function pickStyle(region, rand = Math.random) {
  const list = Array.isArray(region?.styles) ? region.styles : [];
  if (!list.length) return '水彩绘本';
  const row = loadStyleTiers()[region?.id] || {};
  const pool = list.filter((s) => styleWeight(row, s) > 0);
  const use = pool.length ? pool : list;                 // 全冲突 ⇒ 退回全池
  const weightOf = pool.length ? ((s) => styleWeight(row, s)) : (() => 1);
  const total = use.reduce((sum, s) => sum + weightOf(s), 0);
  let r = rand() * total;
  for (const s of use) {
    r -= weightOf(s);
    if (r <= 0) return s;
  }
  return use[use.length - 1];
}

/**
 * 规划一趟完整旅程：搜景点 + 搜特产 → 抽取 → 排期。
 *
 * 降级链：搜索失败或抽取为空 → 退回"模型自带知识"（不校验出处）→ 仍为空则返回 null，
 * 由调用方判定"这地方没玩头"（比如自由路径挑到了搜不到的小地方），回退重挑。
 *
 * @param {{region, city, country, foodTier, state, deps}} p
 * @returns {Promise<object|null>}
 */
export async function planTrip({ region, city, country, foodTier = 'normal', state, deps = {}, note = false }) {
  // ★★ v3.2 特产批注：`note` = **这一趟有没有带"会记东西的人"**（由调用方现读 `COMPANIONS`
  //   的 `noteSouvenirs` 决定 —— 本文件**不认识旅伴 id**，同"纯数字过桥"的既有做法）。
  //   ⚠️ 三条提示词 + `normalizeExtraction` **必须用同一个值**：少传一处 = 那一条路径静默没批注
  //     （抽特产有"有资料 / 模型知识兜底 / 特产兜底编"三条独立路径，只改一条是经典假绿）。
  const withNote = note === true;
  const { search, llm, log } = deps;
  const rand = typeof deps.rand === 'function' ? deps.rand : Math.random;
  const where = [country, city].filter(Boolean).join('·');
  // ★ 消歧前缀：真实地区用**国名**（"庆州"必须带上韩国才有用 —— 踩过的坑），
  //   虚构地区用**作品名**（"神圣泰拉"单搜会撞现实地球，加"战锤40K"才准）。
  //   两者都是"给搜索引擎一个能落地的锚"，只是锚点不同。
  // ★ 虚构地区用**作品名**做前缀；若地区自带 `searchPrefix` 就优先用它。
  //   为什么需要这个字段（2026-10-11 加高达时想通的）：
  //   `name` 是**给玩家看的展示名**，而搜索要的是**能消歧的检索词**，两者不总相等 ——
  //     · 「机动战士高达」直接搜会撞 SEED/00/铁血/水星魔女等一大堆别的世界观
  //       ⇒ searchPrefix 写「机动战士高达 宇宙世纪 UC」才收得住；
  //     · 「交界地」单搜会跑到别的奇幻作品去 ⇒ 得带上「艾尔登法环」。
  const prefix = isFictional(region)
    ? (String(region.searchPrefix || '').trim() || region.name)
    : country;
  const whereQ = [prefix, city].filter(Boolean).join(' ');
  const searchLog = [];

  // ── 1. 搜索（两条查询：景点 + 特产）──
  let spotResults = [];
  let souvResults = [];
  if (typeof search === 'function') {
    try {
      // ⚠️ 查询里必须带**国名**。踩过的坑：搜「庆州 有什么特产」，
      //    百度返回的是**甘肃庆阳**（庆城县/华池县/庆阳香包…）—— 地名撞车，
      //    而跑题校验只看『结果里有没有出现城市名』，第一条标题就叫「庆州」，
      //    于是照样通过。加国名后立刻回到韩国庆州（庆州佛国寺五味子茶…）。
      const r1 = await search(`${whereQ} 最著名的景点 名胜`);
      spotResults = r1?.results || [];
      searchLog.push({ q: `${city} 景点`, provider: r1?.provider, n: spotResults.length });
    } catch (error) { log?.(`[travel-whale/trip] 搜景点失败：${error?.message ?? error}`); }
    try {
      const r2 = await search(`${whereQ} 有什么特产 特色`);   // 同上：前缀必须带（真实地=国名 / 虚构地=作品名）
      souvResults = r2?.results || [];
      searchLog.push({ q: `${city} 特产`, provider: r2?.provider, n: souvResults.length });
    } catch (error) { log?.(`[travel-whale/trip] 搜特产失败：${error?.message ?? error}`); }
  }

  // 交叉合并 + 上限 12（两边各 6 条），保证「景点」和「特产」都有资料进提示词
  const searchText = searchTextOf(interleave(spotResults, souvResults), 12);

  // ── 跑题校验：搜索结果是不可信输入，可能返回跟目标城市无关的页面。
  //    如果所有结果的标题+摘要里**一次都没提到城市名**，就当作没搜到，
  //    走"模型知识兜底"而不是硬把别人的景点安到这座城市头上。
  const offTopic = searchText.length > 0 && !searchText.includes(city);
  if (offTopic) {
    log?.(`[travel-whale/trip] 搜索结果里没有出现「${city}」，判定跑题，改用模型知识`);
    searchLog.push({ q: `${city} 搜索跑题`, provider: 'off-topic', n: 0 });
  }

  // ── 2. 抽取（有资料就强约束"只许摘不许编"）──
  let extraction = { spots: [], souvenirs: [] };
  if (typeof llm === 'function') {
    try {
      const fiction = isFictional(region);
      const raw = await llm((searchText && !offTopic)
        ? buildExtractPrompt({ city, country, searchText, fictional: fiction, withNote })
        : buildKnowledgePrompt({ city, country, fictional: fiction, withNote }));
      const parsed = extractJson(raw);
      // 把「模型返回了什么」和「过筛后剩多少」都记下来 ——
      // 之前只记「搜到几条」，碰上 0 特产这种问题完全无从下手（真踩过）。
      const rawS = Array.isArray(parsed?.spots) ? parsed.spots.length : 0;
      const rawV = Array.isArray(parsed?.souvenirs) ? parsed.souvenirs.length : 0;
      extraction = normalizeExtraction(parsed, {
        searchText: offTopic ? '' : searchText,   // 跑题时不做出处校验（本来就没资料）
        // ★ 2026-10-13 晚：提瓦特「风之翼」让这趟多逛 1 个景点（2 → 3）。
        //   依旧是**纯数字过桥**：这里只读 `state.whale.spotBonus`，不认识技能 id。
        spotLimit: 2 + Math.max(0, Number(state?.whale?.spotBonus) || 0),
        souvenirLimit: 4,
        withNote                                   // ★ v3.2：她也同行时才收 note
      });
      log?.('[travel-whale/trip] ' + city + ' 抽取：模型给 景点' + rawS + '/特产' + rawV
        + ' → 过筛后 景点' + extraction.spots.length + '/特产' + extraction.souvenirs.length
        + '（资料 景点' + spotResults.length + '+特产' + souvResults.length + ' 条' + (offTopic ? '，已判跑题' : '') + '）');
    } catch (error) {
      log?.(`[travel-whale/trip] 抽取失败：${error?.message ?? error}`);
    }

    // ── 3. 兜底：搜到东西但一条都没抽出（或压根没搜到）→ 退回模型知识 ──
    if (!extraction.spots.length) {
      try {
        const raw2 = await llm(buildKnowledgePrompt({ city, country, fictional: isFictional(region), withNote }));
        const kb = normalizeExtraction(extractJson(raw2), { searchText: '', spotLimit: 2, souvenirLimit: 3, withNote });
        if (kb.spots.length) {
          extraction = { spots: kb.spots, souvenirs: kb.souvenirs.length ? kb.souvenirs : extraction.souvenirs };
          searchLog.push({ q: `${city}（模型知识兜底）`, provider: 'llm-knowledge', n: kb.spots.length });
        }
      } catch { /* 兜底也失败就算了 */ }
    }
  }

  // ── 4. 一个景点都拿不到 → 判定"这地方没玩头" ──
  if (!extraction.spots.length) {
    log?.(`[travel-whale/trip] ${where} 没抽出任何景点，放弃这趟`);
    return null;
  }

  // ── 4.5 特产兜底（2026-10-11 用户需求）：**当且仅当一件都没搜到**时，让模型"拟"几件 ──
  //   为什么需要：军事基地 / 要塞这类地方天生没有"土特产"（实测贾布罗 = 0 件），
  //   那这趟就白跑了、图鉴也不动，体验上像功能坏了。
  //   ⚠️ 编出来的东西当然不在搜索结果里，所以这里显式传 `searchText: ''` ——
  //      `normalizeExtraction` 对空资料是**直接放行**的（hasGrounding 不校验）。
  //   ⚠️ 触发条件刻意写成 `!length`（**一件都没有**），不是"少于几件"：
  //      搜到了就该用搜到的，哪怕只有一件。
  if (typeof llm === 'function' && !extraction.souvenirs.length) {
    try {
      const rawMade = await llm(buildMakeUpSouvenirPrompt({
        city, country, spots: extraction.spots, fictional: isFictional(region), withNote
      }));
      const made = normalizeExtraction(extractJson(rawMade), { searchText: '', souvenirLimit: 3, withNote });
      if (made.souvenirs.length) {
        extraction.souvenirs = made.souvenirs;
        log?.(`[travel-whale/trip] ${city} 资料里没有特产 ⇒ 兜底拟了 ${made.souvenirs.length} 件：`
          + made.souvenirs.map((s) => s.name).join('、'));
      } else {
        log?.(`[travel-whale/trip] ${city} 特产兜底也没拟出来，这趟就不带特产了`);
      }
    } catch (error) {
      // ★ 兜底失败**绝不能影响成行**：大不了这趟没特产，比整个出发挂掉好得多
      log?.(`[travel-whale/trip] ${city} 特产兜底失败（这趟不带特产）：${error?.message ?? error}`);
    }
  }

  // ── 5. 特产判稀有度（一趟最多 1 件稀有）──
  const owned = new Set(Object.keys(state?.souvenirs || {}));
  const luck = Number(deps.luck) || 0;
  const souvenirs = judgeSouvenirs(extraction.souvenirs, { luck, owned, rand });

  // ── 6. 排期 ──
  const departAt = Number(deps.departAt) || Date.now();
  // ★ 旅行伙伴（2026-10-11）：本趟明信片总量 +50%、明信片稀有概率 ×2。
  //   没买伙伴时 cardMult / rareMult 都是 1 ⇒ **行为与从前完全一致**（不是"近似"，是同一个数）。
  // ★★ 2026-10-14「扩容鲸鱼」：同行的可能不止一位 ⇒ 换**聚合**口径（函数都在 state.js 里）。
  //   · 张数：**加算** `1 + Σ(cardMult−1)`，**封顶 3 倍**
  //   · 稀有：**取平均**（保住小猫咪 ×0.5 那个惩罚项）
  //   ⚠️ 单人时两者都**恒等于**原来那个数 ⇒ 与从前逐字节一致（不是"近似"）。
  const companion = companionOf(state);   // 领头／出镜那一位（后面快照仍用它的 id）
  const party = companionsOf(state);      // 这一趟同行的全部
  const cardMult = partyCardMultOf(party);
  // ★ 2026-10-13 庭院设施「观星台」：**没建它时乘 1 ⇒ 逐字节等于从前**（不是"近似"）。
  const stargazer = 1 + 0.02 * Math.max(0, Number(state?.garden?.stargazer) || 0);
  // ★★ 2026-10-13 旅伴养成「猫步」：小猫咪的稀有惩罚 ×0.5 → ×0.75。
  //   依旧是**纯数字过桥**（`state.whale.companionRareMult`）—— 本文件不认识技能 id。
  //   ⚠️ 这个覆盖值是**为"单人同行"设计的**（它只可能对应同行的那一位），所以：
  //     · 单人 ⇒ 照旧生效（逐字节等于从前）；
  //     · 多人 ⇒ 改用聚合平均值，**不叠加**这个覆盖 —— 否则"猫步"会把全队拉高，
  //       而那本是**另一位伙伴**的功劳，语义不对。
  const compRareOverride = Number(state?.whale?.companionRareMult);
  const compRareBase = Number(companion?.rareMult) > 0 ? Number(companion.rareMult) : 1;
  const rareBase = (party.length > 1)
    ? partyRareMultOf(party)
    : ((Number.isFinite(compRareOverride) && compRareOverride > 0) ? compRareOverride : compRareBase);
  const rareMult = rareBase * stargazer;
  // ★ 2026-10-13 技能「数据护盾」：**只对"有敌手"的世界**生效 —— 那里才叫她吃得住。
  //   只读一个通用数字，**不认识技能 id**（技能表住在 index.js）。
  const groupFoe = String((region.countries || []).find((c) => c.name === country)?.foe || '').trim();
  const rareBonus = groupFoe ? Math.max(0, Number(state?.whale?.rareBonus) || 0) : 0;
  // 允许调用方覆盖时长 / 张数（快速测试要精确 10 分钟、只寄 1 张）
  // ★ 2026-10-13 晚：星际「折跃残影」把这趟旅程缩短 20% —— 依旧是**纯数字过桥**
  //   （`state.whale.tripDurationMult`，不认识技能 id）；没学 ⇒ 1 ⇒ 逐字节等于从前。
  const durMultRaw = Number(state?.whale?.tripDurationMult);
  const durMult = (Number.isFinite(durMultRaw) && durMultRaw > 0) ? durMultRaw : 1;
  const durationMs = Number(deps.durationMs) || Math.round(tripDuration(foodTier, rand) * durMult);
  const cardCount = Number(deps.cardCount) || pickCardCount(foodTier, rand, cardMult);
  const returnAt = departAt + durationMs;
  // ★ 海拉鲁「希卡导航」：第一张明信片来得更早（4 小时）。
  const firstDeadline = Number(state?.whale?.firstCardDeadlineMs) > 0
    ? Number(state.whale.firstCardDeadlineMs) : FIRST_CARD_DEADLINE_MS;
  const cardTimes = planCardTimes(departAt, durationMs, cardCount, rand, firstDeadline);
  // 每张寄什么，也在出门前定死（含到家那张）
  const firstVisit = !state?.visitedCities?.[cityKey(country, city)];
  const cardPlan = planCardContent({
    spots: extraction.spots, souvenirs, cardTimes, returnAt,
    luck, isFirstVisit: firstVisit, rand, rareMult, rareBonus
  });

  // ★ 2026-10-18：先定画风，再按画风族过滤人物画法（两者有先后依赖，
  //   写进同一个对象字面量里拿不到前者）。
  const style = pickStyle(region, rand);

  return {
    region: region.id,
    regionName: region.name,
    // ★ 这一组的「敌手」（2026-10-11 用户需求）：只有异世界的 `countries[]` 带 `foe`，
    //   现实地区没有 ⇒ 空串 ⇒ 明信片那边不会多出"战斗构图"。
    //   ⚠️ 必须按 **组**（星球/大区）取、不是按大地区 —— 否则"在艾尔打虫族"这类错配会回来。
    foe: String((region.countries || []).find((c) => c.name === country)?.foe || '').trim(),
    // ★ 同一组的「外观锚」（2026-10-11 用户需求）：这句话告诉生图模型**这东西长什么样**。
    //   必要性：生图模型**不联网查资料** —— 只给"虫群""陆战队员"它按字面画成
    //   普通甲虫 / 现代特种兵（用户实测点出来的）。作品名（WORLD_ANCHOR）只能让它去调 IP 记忆，
    //   外观写出来才是双保险。缺 `foeLook` 的地区行为不变（空串 ⇒ 明信片那边不加这行）。
    foeLook: String((region.countries || []).find((c) => c.name === country)?.foeLook || '').trim(),
    // ★ 同一组敌手的**类型**（2026-10-12）：'machine' = 机械型（机动战士/发条机关），
    //   '' = 常规（生物或人类）。sleep-mood 的 TRAVEL-SYNC 只读存档，拿到 foe 字符串也没法
    //   可靠判断这是不是机器（关键词匹配太脆）——所以在出门这一刻就查表写死，最省事。
    //   它据此把战斗条目切成两套：机械型走"黑入系统让它停摆"，常规走"打跑/战胜"。
    foeKind: foeKindOf(region.id, country),
    // ★ 这一组**缺**哪些地貌/人烟特征（2026-10-12）：`['water','green','folk']` 的子集。
    //   用户点名："查尔那儿已经是个虫巢星球了，除了虫子、石头就是岩浆，哪来的河和海呢？"
    //   sleep-mood 的状态池据此把"看河水/去海边/被当地人围看/泡酒馆"这类条目筛掉，
    //   免得**凭空造地形**。同样在出门这一刻查表写死（sync 只读存档）。
    missingTraits: missingTraitsOf(region.id, country, city),
    city, country,
    foodTier,
    style,
    // 人物画法：和地区画风正交的一维，同样一趟只定一种（见 postcard.js 的 CHARACTER_STYLES）
    // ⚠️ 传 style 进去：写实/版画/制图类画风不配 Q 版二头身（方案三的兼容表）
    charStyle: pickCharacterStyle(rand, style),
    // 同行伙伴（''=独自上路）。postOnce 据此切到**双人明信片**提示词。
    companion: companion ? companion.id : '',
    departAt, returnAt, durationMs,
    cardTimes,
    cardPlan,
    cardCount,
    spots: extraction.spots,
    souvenirs,
    searchLog
  };
}
