// 矩阵庭院 · 专属说明图
//
// ── 为什么不用 /help ────────────────────────────────────────────────────
//   /help 是"全功能扫描图"，会把所有插件的指令都列进去，又长又杂。
//   鲸鱼有自己的世界观（TOKEN / 大白饭 / 装备 / 明信片），需要一张
//   **讲玩法而不是列指令**的图。
//
// ── 图怎么来的 ──────────────────────────────────────────────────────────
//   项目里没有任何图像库（sharp/canvas/jimp 都没装），但它是 Electron 应用：
//   开一个隐藏窗口把 HTML 渲染出来，再 capturePage() 截图成 PNG ——
//   中文、emoji、自动换行、圆角、渐变全都白拿。
//   这个思路与 help-board / text-image（长文排版图）一致 ——
//   ⚠️ 三者**同一条管线**（Electron 隐藏窗口 + capturePage），区别只在模板：
//   text-image 吃的是**纯文本**（自带分页），我们这张吃的是**卡片版式**的自绘 HTML。
//   拿不到 Electron（比如在纯 Node 脚本里跑）就抛错，由调用方降级成文字。
//
// ── 2026-10-13 大更新 ───────────────────────────────────────────────────
//   这一轮加了「庭院设施 / 消耗动作 / 技能树」，说明图必须跟上，否则群友看图
//   会以为这些东西不存在。所有数值**一律现读**（state.js / 由 index.js 传进来），
//   写死的数字只有两处「稀有奖励」，由 `token-wording-probe` 的漂移检查盯着。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR } from '../../src/config.js';
import { FOOD_TIERS, CHARM_TYPES, PRICES, COMPANIONS, GARDENS, FARM, pondStats } from './state.js';
// ★ 2026-10-14 服装系统：衣柜页要用到那张服装表（**现读 `outfits.js`，别在 help.js 里重抄一份**）。
//   ⚠️ 别再往注释里写死套数 —— 这里原来写"39 套"，v3.0 加到 60 之后就成了假话
//     （注释也是"信息"，用户会照着它判断代码新旧；见 §98 的"数字漂移"通病）。
import { OUTFITS, WARDROBE_GIRLS, OUTFIT_REGION_NAMES, OUTFIT_PRICE, outfitOf, girlName } from './outfits.js';
import { loadRegions, CARD_LUCK_FACTOR } from './trip.js';

/** 说明图存放目录（多实例安全：跟着 DATA_DIR 走）。 */
export const OUT_DIR = path.join(DATA_DIR, 'skills', 'travel-whale', 'help');

/**
 * 商店 / 装备的表格 —— **全部现读 state.js 与 regions.json**。
 *
 * ⚠️ 为什么不做成写死的文案：改了价格或时长，说明图就会和实际数值对不上，
 *    而且这种不一致极难发现（谁也不会去核对图上写的数字）。
 *    现读的代价只是每次生成图多读一次 JSON，完全可以接受。
 */
function tableRows(items) {
  return items.map((cells) =>
    `<tr>${cells.map((c, i) => `<td${i === 1 ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
}

/** 口粮表：名称 / 价格 / 走多久 / 途中寄几张 */
function foodTable() {
  const rows = Object.entries(FOOD_TIERS).map(([id, t]) => {
    const c = Array.isArray(t.cards) ? t.cards : [1, 2];
    return [t.name, `${PRICES.food[id]} 亿 TOKEN`, `${t.minH}~${t.maxH} 小时`, `途中 ${c[0]}~${c[1]} 张`];
  });
  return `<table class="tbl"><tr><th>口粮</th><th>价格</th><th>走多久</th><th>途中寄</th></tr>`
    + tableRows(rows) + `</table>`;
}

/** 护身符表：名称 / 价格 / 加成 */
function charmTable() {
  // ⚠️ 护身符的加成对**特产**和**明信片**不一样（后者要乘 CARD_LUCK_FACTOR），
  //    写成一个数会差一倍，所以两栏分开列。
  const rows = Object.entries(CHARM_TYPES).map(([id, t]) => {
    const full = Math.round(t.luck * 100);
    const half = Math.round(t.luck * CARD_LUCK_FACTOR * 100);
    return [t.name, `${PRICES.charm[id]} 亿 TOKEN`, `特产 +${full}% / 明信片 +${half}%`];
  });
  return `<table class="tbl"><tr><th>护身符</th><th>价格</th><th>加成</th></tr>${tableRows(rows)}</table>`;
}

/**
 * 旅行伙伴表：名称 / 价格 / 特色 / 代价与收益（2026-10-11 用户需求）。
 * ★ 同样是**现读 state.js**（不写死）—— 价格与倍率改了，说明图必须跟着变。
 * ★ 2026-10-13：名字后面打 ✅ 表示**她已经邀请过这位**（`ownedIds` 由 index.js 传进来）。
 *   为什么要在图上打勾：请过的伙伴可以免费换人，群友看图才知道"还能换谁"。
 */
function companionTable(ownedIds = []) {
  const has = (id) => ownedIds.map(String).includes(String(id));
  // ★ 2026-10-13：加一列「特色」—— 五个人的代价/收益不再一样了，光看倍率看不出区别。
  const traitOf = (c) => {
    const bits = [];
    if (c.trait) bits.push(`「${c.trait}」`);
    if (Number(c.dailyTokens) > 0) bits.push(`每天 +${Number(c.dailyTokens)} 亿 TOKEN`);
    if (Number(c.departCost) > 0) bits.push(`每次出发扣 ${Number(c.departCost)} 亿（可扣成负数）`);
    if (Number(c.cardExtra) > 0) bits.push(`每趟多 ${Number(c.cardExtra)} 张`);
    // ★★ v3.2 两位新旅伴改绑特产：新字段也要在图上印出来（现读表 ⇒ 改数值不用改文案）。
    //   ⚠️ 这三句**与 `index.js` 的 `companionTraitText()` 必须逐字一致**（那边是商店正文）——
    //     两个渲染模块各自独立（help.js 反向 import index.js 会成环），文案只能手工同步；
    //     `souvenir-probe` 有一条跨文件守卫盯着它们，改一边忘一边会被抓。
    if (c.noteSouvenirs) bits.push('新特产带她的批注');
    if (Number(c.harvestBonus) > 0) bits.push(`收成 +${Number(c.harvestBonus)} 份（她在庭院时）`);
    if (c.farmHelper) bits.push(`开菜地（永久 ${FARM.slots + FARM.helperSlots} 块；她在时种下的快 30%）`);
    if (c.longCaption) bits.push('题字更长');
    if (Number(c.flopChance) > 0) bits.push(`约 ${Math.round(Number(c.flopChance) * 100)}% 的明信片会翻车`);
    if (c.battleOnFiction) bits.push('异世界必惹事（多 1 张战斗明信片）');
    return bits.join(' ') || '—';
  };
  const rows = Object.entries(COMPANIONS || {}).map(([id, c]) => {
    const cardPct = Math.round(((Number(c.cardMult) || 1) - 1) * 100);
    return [`${c.emoji ? c.emoji + ' ' : ''}${c.name}${has(id) ? ' ✅' : ''}`, `${c.price} 亿 TOKEN`, traitOf(c),
      `出门吃 ${Number(c.foodCostMult) || 1} 份大白饭｜明信片 ${cardPct >= 0 ? '+' : ''}${cardPct}%｜稀有明信片 ×${Number(c.rareMult) || 1}`];
  });
  return `<table class="tbl"><tr><th>旅行伙伴</th><th>价格</th><th>特色</th><th>代价 / 收益</th></tr>${tableRows(rows)}</table>`;
}

/**
 * 装备表：装备 → 去哪个大区。
 * ★ 2026-10-13 修：✅ 原来只看 `region.defaultUnlocked`（**出厂默认**），
 *   于是"她买过、但不在默认九件里"的会被漏掉 —— 用户当场指出 **飞行扫帚（东方Project）
 *   已经解锁了却没打勾**（存档 `whale.equipUnlocked` 里确实有 `touhou`）。
 *   现在按**实际解锁状态**判：`unlocked` 由 `helpDataFor()` 用 `isRegionUnlocked()` 算好传进来
 *   （= 默认解锁 ∪ 她买过的）；没传就退回 `defaultUnlocked`（老调用方仍可用）。
 *
 * ★★ 2026-10-15「探索解锁」**漏斗补漏**（用户："help.js 里仍然能看到全部的异世界道具"）：
 *   商店（`shopText` / `shopPageData`）当时只筛了"已发现"，**这张网格漏了** ——
 *   它 `list.map()` 把 24 个地区**一件不落地铺出来**，于是"探索感"从侧门漏光：
 *   群友一打开说明图就能看到 15 个异世界的装备名 + 世界名。
 *   ⇒ 新增第 2 个参数 `visible`（可见地区 id 白名单，由 `helpDataFor()` 算好传进来）。
 *   ⚠️ 不传 `visible` ⇒ 保持**全量**（老调用方/老行为逐字不变）。
 *   ⚠️ 与 `unlocked` 是**两件事**，别合并：
 *      · `unlocked` = 已买/默认（决定打不打 ✅）；
 *      · `visible`  = **已发现**（决定**出不出现在表里**）。
 *      已买的一定已发现（买之前必须到过），所以 visible 恒 ⊇ unlocked。
 */
function equipGrid(unlocked = null, visible = null) {
  let list = [];
  try { list = loadRegions().filter((r) => r && !r.defaultUnlocked && !r.baseWorld && r.equipment); } catch { return '<p>（地区表读取失败）</p>'; }
  const known = Array.isArray(unlocked) ? new Set(unlocked.map(String)) : null;
  const vis = Array.isArray(visible) ? new Set(visible.map(String)) : null;
  // 还没发现的世界，连装备名都不出现（这就是用户要的"探索感"）
  const shown = vis ? list.filter((r) => vis.has(String(r.id))) : list;
  if (!shown.length) {
    return '<p class="note">（基础世界各地区已默认全部解锁，无需装备；异世界装备会在偶遇「穿越」发现新世界坐标后显示）</p>';
  }
  const isOn = (r) => (known ? known.has(String(r.id)) : Boolean(r.defaultUnlocked));
  const cells = shown.map((r) =>
    `<div class="eq"><span class="eqn">${esc(r.equipment)}${isOn(r) ? ' ✅' : ''}</span>`
    + `<span class="eqr">→ ${esc(r.name)}</span></div>`).join('');
  return `<div class="eqgrid">${cells}</div>`;
}

/**
 * 庭院设施表（2026-10-13 新玩法）：名称 / 价格 / 效果。
 * ★ 现读 `GARDENS`；`levels` 是存档里的 `state.garden`（{设施id: 等级}），用来标"已建"。
 */
function gardenTable(levels = {}, achievementTotal = 0) {
  const list = Array.isArray(GARDENS) ? GARDENS : [];
  if (!list.length) return '';
  const lv = (id) => Math.max(0, Number(levels?.[id]) || 0);
  const rows = list.map((g) => {
    const prices = Array.isArray(g.prices) ? g.prices : [];
    // ★ 2026-10-13 晚「服务器阵列」：唯一一件**不花 TOKEN** 的设施 —— 门槛是**成就值**。
    //   判别看 `pointCosts`（GARDENS 里刻意不复用 prices，两种币种混一起迟早算错）。
    const points = Array.isArray(g.pointCosts) ? g.pointCosts : [];
    const levels_ = Math.max(1, Number(g.maxLevel) || 1);
    const unit = points.length ? '台' : '级';
    // ★ 2026-10-14：末位支持哨兵 `'all'` —— 第四台 = **全部成就值**（随称号增加而自动提高）。
    let priceText = '';
    if (points.length) {
      const tail = points[points.length - 1];
      const tailText = tail === 'all'
        ? `${achievementTotal > 0 ? achievementTotal : '全部'}（全部）`
        : tail;
      priceText = `成就值 ${points[0]} → ${tailText} 点（${levels_} ${unit}）`;
    } else if (prices.length > 1) {
      priceText = `${prices[0]} → ${prices[prices.length - 1]} 亿 TOKEN（${levels_} 级）`;
    } else {
      priceText = `${prices[0] ?? 0} 亿 TOKEN`;
    }
    const mine = lv(g.id);
    const badge = mine > 0
      ? `<span class="badge">已建${Number(g.maxLevel) > 1 ? ` ${mine}/${levels_} ${unit}` : ''}</span>`
      : '';
    return [`${g.emoji || ''} ${g.name}${badge}`, priceText, g.effect || ''];
  });
  return `<table class="tbl"><tr><th>设施</th><th>价格 / 门槛</th><th>建好之后</th></tr>${tableRows(rows)}</table>`;
}

/** 门槛 → 一句人话。 */
const NEED_TEXT = {
  visit: '去过那个世界就行',
  souvenir: '去过 + 图鉴里有件那儿的特产',
  rare: '去过 + 有件那儿的★稀有特产'
};

/**
 * 技能树表（2026-10-13 新玩法）：名称 / 出自 / 门槛 / 价格 / 效果。
 * ★ `skills` 与 `learned` 由 index.js 传进来 —— 技能表住在 index.js（入口文件），
 *   help.js 是兄弟模块，**不能反向 import**（会成环），所以一律"谁有谁传"。
 * ★ 学过的打 ✅（`learned` = 存档里的 `state.whale.skills`）。
 */
function skillTable(skills = [], learned = {}, visited = null) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) return '';
  const seen = Array.isArray(visited) ? new Set(visited.map(String)) : null;
  let regionName = (id) => String(id);
  try {
    const regs = loadRegions();
    regionName = (id) => (regs.find((r) => String(r.id) === String(id))?.name) || String(id);
  } catch { /* 地区表读不到就用 id，不拦人 */ }
  const rows = list.map((sk) => {
    const got = Boolean(learned?.[sk.id]);
    // ★ `visited` 传进来才标"还没去过"（没传 = 不知道她的行程 ⇒ 不瞎标）
    const where = regionName(sk.region) + (seen && !seen.has(String(sk.region)) ? '（还没去过）' : '');
    return [
      `${sk.emoji || ''} ${sk.name}${got ? ' <span class="badge">已学</span>' : ''}`,
      where,
      NEED_TEXT[sk.needs] || sk.needs || '—',
      `${sk.price} 亿 TOKEN`,
      (sk.numeric ? '【数值】' : '') + (sk.effect || '')
    ];
  });
  return `<table class="tbl"><tr><th>技能</th><th>出自</th><th>门槛</th><th>价格</th><th>效果</th></tr>`
    + tableRows(rows) + `</table>`;
}

/**
 * 旅伴技能表（2026-10-13 旅伴养成）。
 * 口径与 `skillTable` 不同：门槛不是"去过"、也不看特产，而是「**陪你走过 N 个异世界**」。
 * @param {object} worlds  `{ 伙伴id: [regionId...] }`（她存档里的同行记录）
 * @param {object} names   `{ 伙伴id: 显示名 }`
 */
function companionSkillTable(skills = [], learned = {}, worlds = {}, names = {}) {
  const list = Array.isArray(skills) ? skills : [];
  if (!list.length) return '';
  const rows = list.map((sk) => {
    const got = Boolean(learned?.[sk.id]);
    const cid = String(sk.companion || '');
    const n = Array.isArray(worlds?.[cid]) ? worlds[cid].length : 0;
    const done = n >= Number(sk.needWorlds || 0);
    return [
      `${sk.emoji || ''} ${sk.name}${got ? ' <span class="badge">已学</span>' : ''}`,
      String(names[cid] || cid),
      `陪你走过 ${sk.needWorlds} 个异世界（${done ? '✅' : `现在 ${n} 个`}）`,
      `${sk.price} 亿 TOKEN`,
      (sk.numeric ? '【数值】' : '') + (sk.effect || '')
    ];
  });
  return `<table class="tbl"><tr><th>技能</th><th>所属</th><th>门槛</th><th>价格</th><th>效果</th></tr>`
    + tableRows(rows) + `</table>`;
}

/** 「照着说就行」速查表。 */
const CHEATS = [
  ['在群里养一只', '在这养一只鲸鱼'],
  ['看它在哪 / 多久回来', '鲸鱼去哪了'],
  ['收 TOKEN（钱）', '收一下 TOKEN'],
  ['看货架和价格', '看商店'],
  ['买口粮', '买一份中份大白饭'],
  ['买护身符', '买两个幸运海螺'],
  // ★ 2026-10-13：原来这里**写死**了伙伴名单 —— 加第五位（小魔王）时才发现。
  //   改成现读 `COMPANIONS`（上面已有 import），以后再加伙伴不用回来改这一行。
  //   `|| {}` 是防"新 index.js + 旧 state.js"那种热载组合（见 index.js 里那段说明）。
  //   ⚠️ 2026-10-13 修：这串名单**太长**，塞在速查表的一格里会把右列挤到重叠
  //   ⇒ 速查表只留一句短话，名单挪到表下面的注释（见 `companionRosterNote()`）。
  ['邀请旅行伙伴', '邀请小狐狸一起上路'],
  ['解锁异世界', '买风之翼 / 解锁罗德岛徽章'],
  ['指定目的地出门', '让她去杭州 / 让她去蒙德城'],
  ['让它出门', '让它去旅行'],
  ['看明信片', '看看它寄回来的照片'],
  ['看收集进度', '它有什么称号'],
  // ★ 2026-10-13 大更新补上的四条（帮助图原来完全没有这些玩法）
  ['建 / 升级庭院设施', '升级观星台'],
  ['看她会哪些技能', '学技能'],
  ['学一项技能', '学渡鸦信使'],
  ['刷新货架（立刻补满）', '刷新一下货架'],
  ['立刻寄一张明信片', '寄一张明信片来'],
  // ★ 2026-10-13 晚：设施/技能各自有一张菜单图 ⇒ 给两个入口
  ['看庭院设施清单', '看设施菜单'],
  ['看技能树清单', '看技能菜单'],
  ['看这张图', '鲸鱼帮助']
];

/**
 * 现有伙伴名单（现读 `COMPANIONS`）—— 给速查表下面那行注释用。
 * ⚠️ 不能塞进速查表的格子里：5 个名字 20+ 字，会把右边的列挤到重叠（改版时实测撞过）。
 */
function companionRosterNote() {
  const names = Object.values(COMPANIONS || {}).map((c) => c.name).join(' / ');
  return names ? `现有伙伴：${names}。请过的可以商量着换，不用再花见面礼。` : '';
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 生成说明图的 HTML（**主图**）。
 * 版式刻意做成"卡片流"：每张卡片一个玩法阶段，配一个 emoji 图标。
 *
 * ★ 2026-10-13 晚（用户："精简版式：技能树、庭院设施单独做菜单"）：
 *   主图**不再铺**设施表与技能表（那两张太占高度），只留一张**指路卡**；
 *   完整清单各自出一张 **菜单图**（见 `buildMenuHtml` / `renderMenuFile`）。
 *
 * 传入的都是**数据**（不是拼好的 HTML）—— 数值一律来自 state.js / 由 index.js 传入：
 * @param {string[]} ownedIds  邀请过哪些伙伴（名字后打 ✅）
 * @param {string[]} unlocked  已解锁的地区 id（装备那一栏的 ✅ 依据；不传则退回"出厂默认"）
 * @param {string[]} visibleEquip  **已发现**的地区 id（装备网格只列这些；不传 = 全量）。
 *   ★ 2026-10-15：与 `unlocked` 分开管两件事 —— 见 `equipGrid()` 的注释。
 * @param {object[]} skills    技能表（index.js 的 SKILLS）
 * @param {object}   learned   已学技能（存档 `state.whale.skills`）
 * @param {object}   garden    已建设施（存档 `state.garden`）
 * @param {string[]} visited   她本人去过的世界 id（菜单图里标"还没去过"；不传就不标）
 * @param {object}   spend     消耗动作的价格（index.js 传：{refresh, express, buyMax}）
 */
export function buildWhaleHelpHtml({
  width = 720, whaleName = '小鲸鱼', restockHours = 168,
  ownedIds = [], unlocked = null, skills = [], learned = {}, garden = {}, visited = null, spend = {},
  // ★ 2026-10-15「探索解锁」漏斗补漏：装备网格只列**已发现**的地区
  //   （`helpDataFor()` 算好传进来）。不传 = 全量，老调用方逐字不变。
  visibleEquip = null,
  // ★ 2026-10-14 批 3：称号总数**现读**（由 `helpDataFor()` 用 `summarizeTitles()` 算好传进来）。
  //   原来这行写死"25 个称号"—— 那是"旅行鲸鱼"时代的旧数（现在 57 条），
  //   典型的"改了表忘改文案"（§96 的坑）。拿不到就退化成不写数字。
  titlesTotal = 0
} = {}) {
  const W = Math.max(480, Number(width) || 720);
  // ★ 2026-10-13 晚「服务器阵列」：产量与储量**不再是常数** ⇒ 一律现读 `pondStats`，
  //   别再往模板里写死"125 亿""最多存 1000 亿"（阵列每台各多一份）。
  const ps = pondStats({ garden });
  const arrLine = ps.array > 0
    ? `已建 ${ps.array} 台<b>服务器阵列</b>（产出与储量各 ×${ps.mult}），`
    : '';
  const cheats = CHEATS.map(([what, how]) =>
    `<div class="cheat"><span class="what">${esc(what)}</span><code>${esc(how)}</code></div>`).join('');

  const refresh = Number(spend?.refresh) || 0;
  const express = Number(spend?.express) || 0;
  const buyMax = Number(spend?.buyMax) || 0;
  // ★ v3.2：旅伴人数**现读**（原来那句"五位全请到时能同时出去两趟"在 v3.0 加到 7 位后就不对了：
  //   7 位 ⇒ 闲置 6 ⇒ **三趟**）。趟数口径与 `SIDE_TRIP.partySize` 一致：floor(闲置 / 2)。
  const compN = Object.keys(COMPANIONS || {}).length || 1;
  // 指路卡上只报"有几件 / 已建几件"，完整清单在菜单图里
  const gardenCount = (Array.isArray(GARDENS) ? GARDENS : []).length;
  const gardenBuilt = Object.values(garden || {}).filter((v) => Number(v) > 0).length;
  const skillCount = (Array.isArray(skills) ? skills : []).length;
  const skillLearned = Object.keys(learned || {}).length;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${W}px; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    background: linear-gradient(160deg, #eaf4ff 0%, #f4f9ff 45%, #eef7f4 100%);
    color: #14324a; padding: 22px; -webkit-font-smoothing: antialiased;
  }
  .hero {
    background: linear-gradient(135deg, #1c6ea4 0%, #2b8fc7 55%, #47b5c8 100%);
    border-radius: 18px; padding: 20px 22px; color: #fff; margin-bottom: 16px;
    box-shadow: 0 6px 18px rgba(28,110,164,.28);
  }
  .hero h1 { font-size: 24px; letter-spacing: .5px; }
  .hero p { margin-top: 7px; font-size: 13px; opacity: .93; line-height: 1.6; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .card {
    background: #fff; border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 2px 8px rgba(20,50,74,.08); border: 1px solid #e2eef8;
  }
  .card.wide { grid-column: 1 / -1; }
  .card h2 { font-size: 15px; margin-bottom: 9px; display: flex; align-items: center; gap: 7px; }
  .card h2 .idx {
    background: #1c6ea4; color: #fff; font-size: 11px; border-radius: 6px;
    padding: 1px 6px; font-weight: 600;
  }
  .card p, .card li { font-size: 12.5px; line-height: 1.75; color: #34526b; }
  .card ul { padding-left: 15px; }
  .card li { margin-bottom: 2px; }
  code {
    background: #eaf4ff; color: #16608f; border-radius: 6px;
    padding: 2px 7px; font-size: 12px; font-family: Consolas, Monaco, monospace;
    border: 1px solid #d3e7f8; white-space: nowrap;
  }
  .cheats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
  /* ⚠️ min-width:0 + 允许 code 换行：格子里的字太长时（比如一长串伙伴名）
     原来会把右列挤到重叠（是 overflow，不是换行）—— 改版时实测撞过。 */
  .cheat { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; min-width: 0; }
  .cheat .what { color: #34526b; flex: 0 1 auto; }
  .cheat code { white-space: normal; overflow-wrap: anywhere; text-align: right; }
  .tip {
    margin-top: 14px; background: #fff8e8; border: 1px solid #f5e0ac;
    border-radius: 12px; padding: 12px 15px; font-size: 12.5px; line-height: 1.75; color: #7a5a12;
  }
  .tip b { color: #a97a0a; }
  /* ── 数据表（口粮/护身符/伙伴/设施/技能）── */
  .tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .tbl th { text-align: left; color: #7a97ad; font-weight: 600; font-size: 11.5px;
            padding: 3px 6px; border-bottom: 1px solid #e2eef8; }
  .tbl td { padding: 4px 6px; border-bottom: 1px solid #f0f6fc; color: #2d4a63; }
  .tbl td.num { text-align: right; color: #16608f; font-weight: 600; white-space: nowrap; }
  .tbl tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; background: #e8f7ee; border: 1px solid #bfe6d2;
           color: #1f7a4d; border-radius: 6px; padding: 0 5px; font-size: 11px; margin-left: 3px; }
  .twocol { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  /* ── 「设施 / 技能 各自一张菜单图」的指路卡 ── */
  .menus { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .menu { background: #f7fbff; border: 1px solid #e2eef8; border-radius: 10px; padding: 10px 12px; }
  .menu .mt { font-size: 12.5px; font-weight: 700; color: #16608f; margin-bottom: 5px; }
  .menu .md { font-size: 12px; line-height: 1.7; color: #4a6b85; margin-bottom: 5px; }
  .note { margin-top: 8px; font-size: 11.5px; color: #7a97ad; line-height: 1.65; }
  /* ── 装备网格 ── */
  .eqgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px 12px; }
  .eq { display: flex; align-items: baseline; gap: 5px; font-size: 12.5px; }
  .eqn { color: #16608f; font-weight: 600; white-space: nowrap; }
  .eqr { color: #7a97ad; font-size: 11.5px; }
  .foot { margin-top: 13px; text-align: center; font-size: 11.5px; color: #7a97ad; }
  /* 收尾那句"总能找到回来的路"—— 单独一行、比正文稍亮一点，像落款前的最后一句 */
  .lastword { margin-top: 13px; text-align: center; font-size: 12.5px; color: #2b6c96; line-height: 1.7; }
  </style></head><body>

  <div class="hero">
    <h1>🐋 小鲸鱼 · 「矩阵庭院」玩法说明</h1>
    <p>在群里养一只小鲸鱼。它会自己出门旅行、从各个世界寄明信片回来、带特产，<br>攒久了你还能解锁称号。<b>你可以建造庭院、邀请旅伴、培养技能 —— 但是先生，这可得花不少 TOKEN</b></p>
  </div>

  <div class="grid">
    <div class="card">
      <h2><span class="idx">1</span>先把它养起来</h2>
      <p>在群里说一句 <code>在这养一只鲸鱼</code> 就养上了，会送一份见面礼。</p>
    </div>

    <div class="card">
      <h2><span class="idx">2</span>🫧 收 TOKEN —— 这是唯一的钱</h2>
      <p>服务器 <b>${ps.fillHours} 小时产出满载</b>（${ps.perHour} 亿 TOKEN/小时，约 ${(3600 / ps.perHour).toFixed(1)} 秒攒 1 亿 TOKEN），${arrLine}最多存 <b>${ps.cap} 亿 TOKEN</b>。说 <code>收一下 TOKEN</code> 收进钱包，
      收取有 5 分钟冷却，偶尔能捞到 ✨发光 TOKEN。</p>
    </div>

    <div class="card wide">
      <h2><span class="idx">3</span>🛒 买口粮和护身符</h2>
      <div class="twocol">
        <div>
          <p class="note" style="margin:0 0 4px"><b>口粮</b>（出门必须带，每趟吃 1 份）</p>
          ${foodTable()}
        </div>
        <div>
          <p class="note" style="margin:0 0 4px"><b>护身符</b>（每趟自动消耗 1 件最好的（同时提升<b>明信片</b>和<b>特产</b>出稀有的概率））</p>
          ${charmTable()}
        </div>
      </div>
      <p class="note">货架每 ${esc(restockHours)} 小时补满一次；${buyMax ? `单次最多买 ${buyMax} 份（想多囤就多买几次，或者干脆<b>刷新货架</b>，见「钱攒多了能花在哪」那张）` : '被买空要等下次补货'}。</p>
    </div>

    <div class="card wide">
      <h2><span class="idx">4</span>🐾 旅行伙伴</h2>
      <p class="note" style="margin:0 0 6px">名字后面带 <b>✅</b> 的就是<b>已经邀请过</b>的（图上打勾是给你看的）。说一句"邀请她一起上路"即可；
      请过的<b>随时都能商量着换</b>，不用再花见面礼 —— 但她俩<b>还在路上时换不成</b>：这时只会先记下"说好了"，
      等这趟回来才真的换，回话也说成"<b>她同意啦</b>"。邀请之后她俩<b>一起出门</b> —— 代价是多吃一份口粮，
      换来更多明信片和更高的稀有率，而且从那以后的明信片里会<b>画着两个人</b>。      <b>留在家、没被带着的伙伴</b>，
      凑够两人一组、背包里某一档米饭 ≥6 份时，还会<b>自己跑出去玩</b>——拿走 2 份饭，回来固定带 1 件特产。
      家里留得下几个人，就<b>同时跑得开几趟</b>（${compN} 位全请到时能同时出去 ${Math.max(1, Math.floor((compN - 1) / 2))} 趟）；
      她们回来之前，庭院里就少那几位。</p>
      ${companionTable(ownedIds)}
    </div>

    <div class="card wide">
      <h2><span class="idx">5</span>🎒 异世界装备 —— 解锁新世界</h2>
      ${equipGrid(unlocked, visibleEquip)}
      <p class="note">基础世界的所有地区<b>默认全部解锁</b>，随时可直接前往，不需要装备。<br>
      异世界装备各 ${PRICES.equip} 亿 TOKEN，买下即<b>永久解锁</b>对应异世界（打 ✅ 的是已解锁的，没打勾的都能买）。<br>
      ★ 表里只列<b>她已经去过、或已经知道坐标</b>的异世界 —— 还没发现的世界，连装备长什么样都不显示。</p>
    </div>

    <div class="card wide">
      <h2><span class="idx">6</span>✈️ 让它出门</h2>
      <p>说 <code>让它去旅行</code> 手动出发（<b>随时都能喊，不受等待时间限制</b>）；<b>有口粮的话它自己也会走</b>（每次回家播报后在家歇 <b>24~48 小时</b>才再出门 —— 想让它多待在家 / 早点出门，改技能设置里的「在家」两项）。
      夜里 0~7 点它睡觉，不出门也不寄片。</p>
    </div>

    <div class="card">
      <h2><span class="idx">7</span>📮 旅途中寄明信片</h2>
      <p>张数由口粮决定（见上表），出行前就定好，<b>最晚 8 小时一定有第一张</b>；带图 + 题字 + 感想。<b>到家还会再寄一张</b>，跟特产一起。想看就说 <code>看看它寄回来的照片</code>。</p>
      <p>★ <b>在家也有"明信片"</b>：她回到家、<b>在家待满 8 小时</b>之后，会和<b>所有在家的伙伴</b>拍一张<b>横板大合照</b> —— 那种举着镜头自拍的感觉，背景就是能看见星星的「矩阵庭院」。每趟回家只拍一张，照样寄到同一个名单里。</p>
      <p>★ <b>👗 服装</b>：跟异世界挂钩 —— 去过某个<b>子区域</b>（她自己去的算，<b>旅伴自己去的也算</b>）
      就能在那儿<b>解锁对应的一套服装</b>（每套 <b>${OUTFIT_PRICE} 亿 TOKEN</b>）。<br>
      ★ 衣柜只登<b>她已经知道的世界</b>里的衣裳 —— 还没去过的地方，连衣服名都不会出现（说"看衣柜"能看全）。<br>
      买下之后可以<b>手动换装</b>，也可以说一句"随机换一身"让 ${WARDROBE_GIRLS.length} 位少女各自抽一套穿上。
      <b>换装只换衣服</b> —— 发色、耳朵、尾巴、以及她们随身的那些东西（小魔王的巨斧、小书虫怀里的书）都不变。
      <!-- ★ 2026-10-15：这里原来报的是"能看到全部 N 套"（现读 OUTFITS.length）——
           衣柜现在只登"她已经知道的世界"那部分，再报总套数就会自相矛盾
           （新档会说一个很大的总数、图上却一套都没有），而且那个总数本身也是剧透
           （等于告诉她"外面还有很多世界"）。
           ⚠️ HTML 注释照样进最终产物 ⇒ 里面**既别写会求值的表达式、也别写具体数字**，
              否则"图上没有总套数"这类**文本**断言会当场判红（本轮踩过两次）。 -->
      说 <code>看衣柜</code> 能看到她已经知道的世界里的衣裳、各自差哪儿没去过。</p>
    </div>

    <div class="card">
      <h2><span class="idx">8</span>🎁 回来会带东西</h2>
      <p>特产进<b>图鉴</b>，按稀罕程度分三档：<b>· 普通</b> ／ <b>✦ 罕见</b> ／ <b>💎 稀有</b>（稀有的会额外配一张图）。<br><b>撞上稀有才有归来奖励</b>：稀有特产 +50 亿 TOKEN / 稀有明信片 +20 亿 TOKEN，普通的一趟不给。<br>带回来的东西<b>不是只能收着</b>：<b>能吃的可以吃掉</b>、<b>能种的可以种进菜地</b>、<b>任何一件都能送给群友</b> ——
      说 <code>看图鉴</code> 能看到每一件能从哪儿带回来、能不能吃、能不能种、手上还剩几份。<br>去过的城市和景点会被记下来，${titlesTotal ? `解锁 <b>${titlesTotal} 个</b>称号` : '攒出一堆称号'}。</p>
    </div>

    <div class="card wide">
      <h2><span class="idx">9</span>💸 钱攒多了能花在哪</h2>
      <ul>
        ${refresh ? `<li><b>刷新货架</b> —— ${refresh} 亿 TOKEN，说 <code>刷新一下货架</code> 立刻补满（不用等一周的补货），不限次数。</li>` : ''}
        ${express ? `<li><b>加急明信片</b> —— ${express} 亿 TOKEN 一张，<b>商店每轮补货只上架 1 张</b>（买走就没了，想要第二张得<b>刷新货架</b>）。买下后说 <code>寄一张明信片来</code> 立刻寄：在路上 = 本趟多一张，在家 = 现拍一张庭院照。</li>` : ''}
        <li><b>建庭院设施</b>、<b>学技能</b> —— 这两件是真正吃钱的地方，各自的清单见下一张。</li>
      </ul>
    </div>

    <div class="card wide">
      <h2><span class="idx">10</span>📋 设施与技能：各自有一张「菜单图」</h2>
      <div class="menus">
        <div class="menu">
          <p class="mt"><b>🏡 庭院设施</b> —— 家可以慢慢建</p>
          <p class="md">${gardenCount ? `现有 <b>${gardenCount}</b> 件，她已建 <b>${gardenBuilt}</b> 件。` : ''}
          建好<b>永久生效</b>、不能拆，价格随等级递增；<b>不改产量</b>，改的是"她在家能做什么、写得多长、拍得多勤"。</p>
          <p class="md">想看清单就说 <code>看设施菜单</code></p>
        </div>
        <div class="menu">
          <p class="mt"><b>🧠 技能树</b> —— 去过哪个世界，就学得到那边的东西</p>
          <p class="md">${skillCount ? `现有 <b>${skillCount}</b> 条，她已学 <b>${skillLearned}</b> 条。` : ''}
          门槛是"<b>她本人去过</b>那个世界"（穿越也算），招牌技能还要一件那儿的 ★ 稀有特产。
          ⚠️ <b>学一次要消耗 1 件那儿的特产</b>（先花普通的、把稀有留到最后）——
          那个世界的特产用光了就暂时学不了，得再带一件回来、或者种一棵出来。
          <b>学了永久、不能退</b>；带【数值】的那半一直生效，另一半每张明信片<b>只发动一项</b>。</p>
          <p class="md">想看清单就说 <code>看技能菜单</code></p>
        </div>
      </div>
    </div>

    <div class="card wide">
      <h2><span class="idx">11</span>💬 照着说就行</h2>
      <div class="cheats">${cheats}</div>
      <p class="note">${esc(companionRosterNote())}</p>
    </div>
  </div>

  <div class="tip">
    <b>不用记死话术</b> —— 上面只是参考说法，你换个说法它也听得懂（"鲸鱼呢""收个菜""给我看看它拍的照"都行）。<br>
    <b>货架每 ${esc(restockHours)} 小时补满一次</b>，被买空要等下次补货（或者花 TOKEN 立刻<b>刷新</b>）。
  </div>

  <div class="lastword">别担心，无论她去了哪儿，都能找到回来的路。</div>

  <div class="foot">🐋 ${esc(whaleName)} · 矩阵庭院</div>
  </body></html>`;
}

// ── 菜单图（设施 / 技能各自一张）──────────────────────────────────────────
//
// ★ 2026-10-13 晚（用户口径）：**技能树与庭院设施从主图里拆出来、各自成一张"菜单"** ——
//   主图因此瘦回 2000px 上下，这两块要细看时单独发一张。
//   两张菜单都**现读数据**（设施来自 state.js 的 GARDENS、技能由 index.js 传进来），
//   所以价格/等级/效果永远不会和实际对不上。

/**
 * 菜单表：kind → 标题 / 副标题 / 末尾那句（主图/工具描述都引它，别另写一份）。
 *
 * ★ 2026-10-14：每个菜单多了一项 `closing` —— **页面末尾的那一句**（用户："帮助页末尾的'别担心'
 *   那句很受好评，我想给商店、衣柜、设施、技能页也加上类似的风格文本，不用多，就一句。"）。
 *   它跟主图那句 `.lastword` 用**同一套样式**；`buildMenuHtml` 里统一渲染一次。
 *   ⚠️ 它走 `esc()`（纯文本）⇒ 别写 HTML 标签、别写 Markdown 星号（QQ 不渲染）。
 */
/**
 * 相册页：一行放几张（**6 列 × 2 行 = 每页 12 张**，横向铺开、像相册摊开的一跨页）。
 * ★ 2026-10-14 用户："一页放 9 张不好看……**横向的更有相册感**，12 张吧。"
 *   ⇒ 从 3×2 改成 6×2（3×3 的方阵被否掉），画布同步加宽到 `ALBUM_WIDTH`。
 *   改这两个数就能换密度 —— 但要一起看 `ALBUM_WIDTH`（列多了画布不加宽，每格就挤成一条）。
 */
export const ALBUM_COLS = 6;
export const ALBUM_ROWS = 2;
/** ⚠️ 必须声明在 `MENUS` **之前**：`MENUS.album.subtitle` 直接引用了它，
 *  而 `const` 有 TDZ —— 写在后面会在模块求值时抛
 *  `Cannot access 'ALBUM_PER_PAGE' before initialization`（本轮踩过）。 */
export const ALBUM_PER_PAGE = ALBUM_COLS * ALBUM_ROWS;
/**
 * 相册页的画布宽度（px）—— **比其它菜单图（720）宽得多**：一页 12 张、6 列，
 * 每格 ≈ `(ALBUM_WIDTH - 内边距) / ALBUM_COLS ≈ 285px`。
 * ⚠️ `renderMenuFile()` 对 `kind === 'album'` **强制取 max(调用方宽度, 它)** ——
 *   因为 `whale_help(menu:'album')` 走的是通用的 720 宽，6 列排下来每格只剩 100px、糊成一团。
 */
export const ALBUM_WIDTH = 1800;
/**
 * 缩略图目标宽度（px）。原图 1536 宽 ≈2.8 MB；压到 480 宽 JPEG ≈60 KB。
 * ⚠️ 它必须 **≥ 格子的显示宽度**（现约 285px），否则图上会糊 —— 改 `ALBUM_COLS`/`ALBUM_WIDTH` 时要一起看。
 */
export const ALBUM_THUMB_W = 480;

export const MENUS = {
  garden: {
    kind: 'garden', emoji: '🏡', title: '庭院设施',
    // ⚠️ 这段会走 `esc()`（纯文本）⇒ 不能写 HTML 标签，也别写 Markdown 星号。
    // ★ 2026-10-13 晚：原文案是"它们不改产量" —— 服务器阵列加进来之后**不成立了**，改掉。
    subtitle: '家可以慢慢建 —— 建好永久生效、不能拆。多数设施改的是"她在家能做什么、写得多长、拍得多勤"；只有服务器阵列例外：它不收 TOKEN，门槛是成就值，每多一台就多一份产出与储量。',
    closing: '院子是一寸一寸垒起来的，急不来；她也不急 —— 反正她总会回家。'
  },
  skill: {
    kind: 'skill', emoji: '🧠', title: '技能树',
    subtitle: '去过哪个世界，就学得到那边的东西 —— 门槛是"她本人去过"（穿越也算）；学了永久、不能退。',
    closing: '学到手的本事不会忘 —— 就算哪天她记不清是在哪儿学的了。'
  },
  // ★ 2026-10-14 服装系统（用户："衣柜很大，单独做一个可展开的、包含解锁条件的页面"）
  wardrobe: {
    kind: 'wardrobe', emoji: '👗', title: '服装衣柜',
    subtitle: '跟异世界挂钩：去过哪个子区域，就能在那儿解锁对应的一套服装 —— 她自己去的算，旅伴自己去的也算。'
      + `每套 ${OUTFIT_PRICE} 亿 TOKEN；买下之后可以随时手动换，也能一句"随机换一身"让 ${WARDROBE_GIRLS.length} 位各自抽一套。`
      + '换装只换衣服：发色、耳朵、尾巴、以及她们随身的那些东西都不变。',
    closing: '她挑衣服有点慢 —— 因为每一套背后，都是一趟真去过的路。'
  },
  // ★ 2026-10-14（用户："把商店也做成菜单图吧，顺便把设施/技能/衣柜从商店里移出去，避免重复占用版面"）
  // ⚠️ title 必须与 `index.js` 的 `shopText()` 里那行**一致**（探针盯着这条）。
  shop: {
    kind: 'shop', emoji: '🛒', title: '豆包杂货铺',
    subtitle: '隔壁豆包开的杂货铺 —— 她出门要用的东西都在这儿：口粮、护身符、加急明信片，以及邀请旅伴的见面礼。'
      + '庭院设施、技能树、服装衣柜都各有自己的一张菜单图，这里不再重复列一遍。',
    closing: '钱花光了也不打紧 —— 豆包家的米，从没让她空着肚子出门过。'
  },
  // ★★ 2026-10-14 批 3（用户："特产管理（赠送/吃掉/种菜）"＋"反馈感要强"）——
  //   第 5 张菜单图。为什么图鉴非出图不可：在此之前特产**只有一处露面** ——
  //   相册里一行 `💎 名字（城市）`，只列前 12 件、还挤不下"从哪儿带的 / 能吃吗 / 用过几次"。
  //   ⚠️ 特产**没有固定清单**（模型每次现场编），所以这页**逐条现读存档**，
  //     分类标签也现算（`kindOf` / `canEat` / `canPlant`），一个字都不写死。
  pantry: {
    kind: 'pantry', emoji: '🎁', title: '特产图鉴',
    subtitle: '她每到一个地方背回来的东西都记在这儿 —— 每一件都写清「从哪儿带的、能不能吃、能不能种、手上还剩几份、用过几次」。'
      + '能吃能种的可以当场用掉：说「吃掉 某某」「把 某某 送给谁」「种下 某某」—— 用一次消耗 1 份，图鉴的条目不会被清掉。'
      + '★ 吃/喝完不是立刻就算了：接下来一小会儿她会带着那个味道说话 ——'
      + '普通 5 分钟 / 罕见 15 / 稀有 30（越稀罕劲儿越久）。'
      + '喝了酒会有点上头、话变多还嘴硬"我没醉"；吃了辣的一边吸气一边嘴硬；吃撑了犯懒不想动。',
    closing: '东西是带回来了，可她记得最牢的，从来不是那件东西 —— 是把它递出去的那一下。'
  },
  // ★★ 2026-10-14 相册页（第 6 张菜单图。用户："把明信片排列成 2×3 或者更大的块，
  //   这样可以保留缩略图，方便查看和翻找或者选择。"）
  //   **为什么非出图不可**：明信片原图平均 **2.8 MB** 一张 —— 一张张发出来既占版面、
  //   也没法"翻找"（想找上个月那张得往上翻很久）。网格页把 N 张压成缩略图、一页横向铺 12 张，
  //   带编号 / 地名 / 景点，**能看、能挑、能报号**。
  //   ⚠️ 缩略图由 `renderMenuFile()` 现场压（`albumThumb()`）——
  //      `albumPage()` 只渲染布局，所以它**离线也能出 HTML**（探针/预览用得上）。
  album: {
    kind: 'album', emoji: '📮', title: '明信片相册',
    subtitle: '她寄回来的照片 —— 一趟旅行一页（最新那趟在前），庭院合照单独成页。'
      + '每格左上角是编号（`#N`），说一句「看第 N 张」就能把那张调出来看大图。',
    closing: '照片一张一张攒起来，就成了她去过的地方。'
  }
};

/** 合法的菜单 kind 列表（工具参数校验用）。 */
export const MENU_KINDS = Object.keys(MENUS);

/**
 * ★ 2026-10-14 服装系统：**衣柜页**（用户："衣柜很大，单独做一个可展开的、包含解锁条件的页面"）。
 *
 * 三条设计：
 *   ① **按地区折叠**（`<details>`）—— 12 个异世界各一块，一眼能看出"哪个世界还有没拿的"；
 *   ② 每套**逐条写解锁条件**（"要先去 幻想乡中央"），别只在顶部说一句 ——
 *      用户要的就是"我到底差哪儿"；
 *   ③ ⚠️ 一律 `<details open>` —— 渲染成 PNG 时**必须是全展开的**（图点不动），
 *      而在预览面板里看 HTML 时用户仍可自己折叠。
 */
export function wardrobePage({ wardrobe = {}, areasSeen = {}, visibleRegions = null } = {}) {
  const owned = (wardrobe && typeof wardrobe.owned === 'object' && wardrobe.owned) || {};
  const worn = (wardrobe && typeof wardrobe.worn === 'object' && wardrobe.worn) || {};
  const seen = (areasSeen && typeof areasSeen === 'object') ? areasSeen : {};
  const has = (o) => owned[o.id] === true;
  // ⚠️ 解锁判据 = **去过那个子区域**（`index.js` 的 `markAreaSeen` 两趟都记）
  const canBuy = (o) => Boolean(seen[`${o.region}|${o.area}`]);
  // ★★ 2026-10-15「探索解锁」（用户追加口径）：衣柜**只登"她已经知道的世界"那部分** ——
  //   "在初期应该直接【不解锁】，在**去过至少一个异世界**之后才解锁，而且仅解锁能看到的世界的那部分"。
  //   `visibleRegions` 由 `helpDataFor()` 的 `visibleRegionIds()` 算好传进来
  //   ⇒ 与装备网格 / 技能树 / 商店**同一个口径**，别在这儿重写一遍规则（"漏盖"就是这么来的）。
  //   ⚠️ 不传 = 全量（老调用方逐字不变）。
  const vis = Array.isArray(visibleRegions) ? new Set(visibleRegions.map(String)) : null;
  const inVis = (rid) => (!vis || vis.has(String(rid)));
  // ⚠️ `got` 按**全量**算：已拥有的是她的资产，下面"现在各穿什么"那行也写着它 ——
  //   若这里按可见集算成 0，就会和那行当场自相矛盾（老档尤其明显）。
  const got = OUTFITS.filter(has).length;

  const now = WARDROBE_GIRLS.map((g) => {
    const cur = worn[g.id] ? outfitOf(worn[g.id]) : null;
    return `${g.emoji} ${g.name}${cur ? `：${cur.name}` : '：默认那身'}`;
  }).join('　｜　');

  const shownIds = Object.keys(OUTFIT_REGION_NAMES).filter(inVis);
  const visibleCount = OUTFITS.filter((o) => inVis(o.region)).length;

  // 初期：可见的世界里一套衣服都没有（`OUTFITS` 全挂在异世界）⇒ 直接出一张"还没解锁"的卡，
  // 别摆一张空表让群友以为坏了。口径与 `index.js` 的 `wardrobeText()` 逐字对齐。
  if (!visibleCount && !got) {
    return `<div class="card">
      <p class="note" style="margin:0 0 9px">
        <b>👗 衣柜还没到解锁的时候</b> —— 她得先出过一趟<b>异世界</b>的远门，
        在外边见过、穿过的那身，才会挂到这个柜子里来。<br>
        （在庭院里过日子的这段时间不算：这些衣裳都挂在别的世界上。）
      </p>
      <p class="note" style="margin:0 0 4px;background:#f4f8fc">现在各穿什么 —　${esc(now)}</p>
    </div>`;
  }

  const blocks = shownIds.map((rid) => {
    const list = OUTFITS.filter((o) => o.region === rid);
    if (!list.length) return '';
    const n = list.filter(has).length;
    const rows = list.map((o) => {
      const state = has(o)
        ? '<b style="color:#2f8f5b">✅ 已解锁</b>'
        : (canBuy(o)
          ? `<b style="color:#b5761f">🛒 可以买</b> · ${Number(o.price) || OUTFIT_PRICE} 亿`
          : `<span style="color:#8aa3ba">🔒 要先去「<b>${esc(o.area)}</b>」</span>`);
      return `<tr><td style="font-weight:600">${esc(o.name)}</td>`
        + `<td>${esc(o.area)}</td>`
        + `<td>${esc(girlName(o.who))}</td>`
        + `<td>${state}</td></tr>`;
    }).join('');
    return `<details open style="margin:9px 0 0">
      <summary style="cursor:pointer;font-weight:600;color:#1f4b70;padding:5px 0;font-size:13.5px">
        ${esc(OUTFIT_REGION_NAMES[rid])}
        <span style="color:#8aa3ba;font-weight:400">（${list.length} 套 · 已解锁 ${n}）</span>
      </summary>
      <table class="tbl"><tr><th style="width:32%">服装</th><th style="width:22%">要去过的子区域</th><th style="width:18%">谁穿</th><th>状态</th></tr>${rows}</table>
    </details>`;
  }).join('');

  return `<div class="card">
      <p class="note" style="margin:0 0 9px">
        <b>一共 ${visibleCount} 套，已解锁 ${got} 套</b> · 每套 <b>${OUTFIT_PRICE} 亿 TOKEN</b>。<br>
        <b>解锁条件 = 去过那个子区域</b>：她自己去的算，<b>旅伴自己去的也算</b>（以前去过的不会追认）。<br>
        ★ 这里只登<b>她已经知道的世界</b>里的衣服 —— 还没去过、也没发现的世界，连衣服名都不会出现。
      </p>
      <p class="note" style="margin:0 0 4px;background:#f4f8fc">现在各穿什么 —　${esc(now)}</p>
      ${blocks}
    </div>`;
}

/** 菜单页自己的样式（比主图简单：一张 hero + 一张表 + 注释）。 */
const MENU_CSS = (W) => `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${W}px; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
    background: linear-gradient(160deg, #eaf4ff 0%, #f4f9ff 45%, #eef7f4 100%);
    color: #14324a; padding: 22px; -webkit-font-smoothing: antialiased; }
  .hero { background: linear-gradient(135deg, #1c6ea4 0%, #2b8fc7 55%, #47b5c8 100%);
    border-radius: 18px; padding: 18px 20px; color: #fff; margin-bottom: 14px;
    box-shadow: 0 6px 18px rgba(28,110,164,.28); }
  .hero h1 { font-size: 22px; letter-spacing: .5px; }
  .hero p { margin-top: 6px; font-size: 12.5px; opacity: .94; line-height: 1.6; }
  .card { background: #fff; border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 2px 8px rgba(20,50,74,.08); border: 1px solid #e2eef8; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .tbl th { text-align: left; color: #7a97ad; font-weight: 600; font-size: 11.5px;
    padding: 4px 6px; border-bottom: 1px solid #e2eef8; }
  .tbl td { padding: 5px 6px; border-bottom: 1px solid #f0f6fc; color: #2d4a63; vertical-align: top; }
  .tbl td.num { text-align: right; color: #16608f; font-weight: 600; white-space: nowrap; }
  /* ⚠️ 第一列（技能名/设施名）必须 nowrap —— 否则 720 宽下"渡鸦信使"会被折成两行、
     表格看着很挤（实测过） */
  .tbl td:first-child, .tbl th:first-child { white-space: nowrap; }
  .tbl tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; background: #e8f7ee; border: 1px solid #bfe6d2;
    color: #1f7a4d; border-radius: 6px; padding: 0 5px; font-size: 11px; margin-left: 3px; }
  .note { margin-top: 9px; font-size: 11.5px; color: #7a97ad; line-height: 1.7; }
  .can { margin-top: 10px; background: #fff8e8; border: 1px solid #f5e0ac; border-radius: 10px;
    padding: 9px 12px; font-size: 12px; line-height: 1.7; color: #7a5a12; }
  /* ★ 2026-10-14：给四张菜单也加一句"落款"（用户："帮助页末尾的"别担心"那句很受好评，
     我想给商店、衣柜、设施、技能页也加上类似的风格文本，不用多，就一句。"）——
     样式与主图那句（help.js 的 .lastword）逐字相同，读起来才是同一个系列。
     ⚠️ 注释里也别写 Markdown 星号：它会原样落进 <style>，而探针按整份 HTML 扫星号。 */
  .lastword { margin-top: 13px; text-align: center; font-size: 12.5px; color: #2b6c96; line-height: 1.7; }
  .foot { margin-top: 12px; text-align: center; font-size: 11.5px; color: #7a97ad; }
`;

/**
 * ★ 2026-10-14 商店页（第 4 张菜单图）。
 *
 * 用户口径：「把商店也做成菜单图吧，顺便把设施/技能/衣柜从商店里移出去，避免重复占用版面」。
 * ⇒ 商店页**只讲"货架上有什么、多少钱、还剩多少"** + 邀请旅伴（见面礼也是花钱买）；
 *   设施 / 技能 / 旅伴技能 / 衣柜一律不在这儿（它们各有自己的菜单图），页尾只留一句指路。
 *
 * ⚠️ 数据全部由 `helpDataFor()` 算好传进来（本模块是纯渲染，不读存档 —— 同其它菜单页）。
 */
export function shopPage({ shop = null, ownedIds = [] } = {}) {
  const s = shop || {};
  const items = Array.isArray(s.items) ? s.items : [];
  const rows = items.map((it) => [
    it.name,
    `${it.price} 亿 TOKEN`,
    it.desc || '—',
    `${it.stockText || ''}｜已有 ${it.have ?? 0}`
  ]);
  const tbl = rows.length
    ? `<table class="tbl"><tr><th>商品</th><th>价格</th><th>说明</th><th>货架 / 已有</th></tr>${tableRows(rows)}</table>`
    : '<p class="note">（货架读取失败 —— 让她说一句"看商店"再试一次）</p>';

  const eqNames = (s.lockedEquip && Array.isArray(s.lockedEquip.names)) ? s.lockedEquip.names : [];
  const eq = eqNames.length
    ? `<p class="note">🎒 <b>还没解锁的装备</b>（每件 ${esc(String(s.lockedEquip.price))} 亿 TOKEN）：
      ${esc(eqNames.join('、'))}<br>
      装备是"一个地区一件"，走遍那个地区就解锁（说"看装备"能看到她已经有的）。</p>`
    : '';

  return `
    <div class="card">
      ${tbl}
      ${eq}
      <p class="note">📦 下次补货：<b>${esc(s.restockText || '—')}</b>
      ｜💰 她现在的余额：<b>${Number(s.balance) || 0} 亿 TOKEN</b>
      —— 说"刷新货架"可以立刻补货（要花 TOKEN）。</p>
    </div>
    <div class="card" style="margin-top:12px">
      <p class="note" style="margin:0 0 8px;color:#34526b;font-size:13px"><b>🐾 旅行伙伴</b>
      （见面礼也是一次性花的钱；邀请过就一直跟着出门。想换人说一声 —— <b>等她俩到家</b>才换得成）</p>
      ${companionTable(ownedIds) || '<p class="note">（伙伴表读取失败）</p>'}
    </div>
    <div class="can">🏡 庭院设施 · 🧠 技能树（含旅伴技能）· 👗 服装衣柜 · 🎁 特产图鉴 各有<b>自己的一张菜单图</b> ——
    说「看设施菜单」「看技能菜单」「看衣柜」「看图鉴」就能看，商店里不再重复列。</div>`;
}

/**
 * ★★ 2026-10-14 批 3：**特产图鉴页**（第 5 张菜单图）。
 *
 * 用户口径：「特产管理（赠送 / 吃掉 / 种菜）」＋「反馈感要强」。
 * 这一页要回答群友的三个问题（顺序就是表格的列序）：
 *   ① 她**带回过什么**（名字 + 从哪儿带回来的）；
 *   ② 这一件**现在能干什么**（能种 / 能吃 / 只能送人）；
 *   ③ **还剩几份、用过几次**（吃过送过种过 —— 这里的数字就是"反馈感"本身）。
 *
 * ⚠️ 数据由 `index.js` 的 `pantryPageData()` 算好传进来（**本模块是纯渲染，不读存档** ——
 *   同其它菜单页）。分类标签也**不在这一层判** —— 那是 `souvenir.js` 的事（一套判据只能有一处）。
 * ⚠️ 特产**没有固定清单**（模型每次旅行现场编），所以这页**不写任何一条具体特产名**。
 */
/**
 * ★★ 2026-10-14 相册页（第 6 张菜单图）。
 *
 * 用户口径："把明信片排列成 2×3 或者更大的块，这样可以保留缩略图，方便查看和翻找或者选择。"
 *
 * 三条设计：
 *   ① **网格**（**6 列 × 2 行 = 每页 12 张**，横向铺开）：每格 = 缩略图 + 编号 + 地名 + 景点；
 *      ⚠️ **题字与日期不进格子**（题字会长到撑爆版面；而明信片图上本来就印着它）；
 *   ② **编号 `#N` 是"整册里的第几张"**（正序、不随分页变）⇒ 说「看第 N 张」永远指同一张；
 *   ③ 图**不由这里生成**：`item.thumb` 由 `renderMenuFile()` 现压好塞进来
 *      （原图 2.8 MB、内联 12 张就是 34 MB 的 HTML）。没有 thumb 就画一块占位 ——
 *      **布局照样能离线渲染**，这也是探针跑得动的原因。
 */
export function albumPage({ album = null } = {}) {
  const a = album || {};
  const total = Number(a.total) || 0;
  const page = Number(a.page) || 1;
  const pages = Math.max(1, Number(a.pages) || 1);

  // ── 旅行目录（v4.4）：一张图列出每一趟，用来直接找到某一趟
  if (Array.isArray(a.catalog)) {
    const rows = a.catalog.map((c) => `<tr>
      <td class="ac-idx">第 ${c.index} 趟</td>
      <td class="ac-place">${esc(String(c.label || ''))}</td>
      <td class="ac-date">${esc(String(c.date || ''))}</td>
      <td class="ac-num">${c.count} 张</td>
    </tr>`).join('');
    return `<style>
      .ac-tb{width:100%;border-collapse:collapse;font-size:15px}
      .ac-tb td{padding:10px 12px;border-bottom:1px solid #e5eef7}
      .ac-idx{color:#1c6ea4;font-weight:700;white-space:nowrap;width:110px}
      .ac-place{color:#123; font-weight:600}
      .ac-date{color:#6b8598;white-space:nowrap;width:130px}
      .ac-num{color:#34526b;text-align:right;white-space:nowrap;width:90px}
    </style>
    <div class="card">
      <p class="note" style="margin:0 0 10px"><b>📇 旅行目录</b>　一共 ${a.catalog.length} 趟、${total} 张${a.homes ? `，另有庭院合照 ${a.homes} 张` : ''}。
      说「看第 N 趟」或「看某地相册」就能翻到那一趟。</p>
      <table class="ac-tb"><tbody>${rows}</tbody></table>
    </div>`;
  }

  // ── 正文：按趟分区（同页可放多趟；一趟超过一页才会被拆，标签会写 (1/2)）
  const sections = Array.isArray(a.sections) && a.sections.length
    ? a.sections
    : (Array.isArray(a.items) && a.items.length ? [{ label: '', note: '', items: a.items }] : []);
  const items = sections.flatMap((s) => (Array.isArray(s.items) ? s.items : []));

  if (!items.length) {
    return `<div class="card">
      <p class="note" style="margin:0">📮 <b>相册还是空的</b> —— 她出门回来就会寄照片。<br>
      第一张回来后说一句「看相册」，这儿就会长出第一格。</p>
    </div>`;
  }

  const MARK = { spot: '', souvenir: '🎁', home: '🐾', battle: '⚔️' };
  // ★ v4.4 自动列数（**按每一段算**）：少的时候别把三张摊成四格；
  //   张数除 4 余 1 时用 3 列，避免出现"4+1"这种孤零零的尾行（5 张 → 3+2）。
  const colsOf = (n) => {
    if (n <= 3) return Math.max(1, n);
    return (n % 4 === 1) ? 3 : 4;
  };

  const cell = (c) => {
    const rare = c.rarity === 'rare';
    const mark = MARK[c.kind] || '';
    const thumb = c.thumb
      ? `<img src="${c.thumb}" alt="" style="width:100%;display:block;border-radius:8px">`
      : `<div style="width:100%;aspect-ratio:3/2;border-radius:8px;background:#eef5fb;border:1px dashed #cfe0ee;
           display:flex;align-items:center;justify-content:center;color:#8aa3ba;font-size:12px">（缩略图未生成）</div>`;
    const place = c.place ? String(c.place).replace(/^·/, '') : '';
    return `<div style="border:1px solid ${rare ? '#f0d9a8' : '#e5eef7'};border-radius:10px;padding:8px;background:${rare ? '#fffdf6' : '#fff'}">
      ${thumb}
      <div style="margin-top:6px;font-size:13px;font-weight:700;color:#1c6ea4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
        #${c.no}${mark ? ' ' + mark : ''}${rare ? ' ✨' : ''}<span style="color:#6b8598;font-weight:400;font-size:11.5px">${place ? ' · ' + esc(place) : ''}</span>
      </div>
      <div style="font-size:12px;color:#34526b;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(String(c.spot || ''))}</div>
    </div>`;
  };

  const rareN = items.filter((c) => c.rarity === 'rare').length;
  const pager = pages > 1
    ? `第 <b>${page}</b> / ${pages} 页　·　说「看相册 ${page < pages ? page + 1 : 1}」${page < pages ? '翻下一页' : '回到第一页'}　·　「看相册目录」看全部趟次`
    : '说「看相册目录」看全部趟次';

  const body = sections.map((sec) => {
    const head = sec.label
      ? `<div style="font-size:17px;font-weight:800;color:#1c6ea4;margin:0 0 4px">${esc(String(sec.label))}</div>`
      : '';
    const note = sec.note ? `<div class="note" style="margin:0 0 8px">${esc(String(sec.note))}</div>` : '';
    const cols = colsOf(sec.items.length);
    const grid = `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;margin-top:6px">${sec.items.map(cell).join('')}</div>`;
    return `<div style="margin-bottom:18px">${head}${note}${grid}</div>`;
  }).join('');

  return `
    <div class="card">
      <p class="note" style="margin:0 0 4px"><b>📮 一共 ${total} 张</b>${rareN ? `（本页 ✨稀有 ${rareN} 张）` : ''}
      　·　编号是<b>整册里的第几张</b>，说「看第 N 张」就能调出那张大图。</p>
      ${body}
      <p class="note" style="margin:6px 0 0;text-align:center">${pager}</p>
    </div>`;
}

/**
 * 把本地大图压成小缩略图（`data:image/jpeg;base64,…`）。
 *
 * ⚠️ **必须压**：明信片原图平均 **2.8 MB**，而渲染走 `data:` URL ——
 *   一页 12 张原图内联就是 34 MB 的 HTML，Electron 会卡死或渲染超时。
 * ⚠️ 只能 **base64 内联**，不能引 `file://`：`data:` URL 的页面是 opaque origin，
 *   加载本地文件会被拦（为此去关 `webSecurity` 影响面太大，不值当）。
 * ⚠️ 拿不到 Electron / 图不存在 ⇒ 返回空串、由调用方画占位，**绝不许抛**。
 */
export function albumThumb(absPath, targetW = ALBUM_THUMB_W, quality = 82) {
  try {
    if (!absPath) return '';
    const req = createRequire(import.meta.url);
    const { nativeImage } = req('electron');
    if (!nativeImage) return '';
    const img = nativeImage.createFromPath(String(absPath));
    if (!img || img.isEmpty()) return '';
    const { width } = img.getSize();
    const out = (Number(width) > Number(targetW)) ? img.resize({ width: Number(targetW) }) : img;
    const jpg = out.toJPEG(Number(quality) || 82);
    return (jpg && jpg.length) ? `data:image/jpeg;base64,${jpg.toString('base64')}` : '';
  } catch { return ''; }
}

export function pantryPage({ pantry = null } = {}) {
  const p = pantry || {};
  const items = Array.isArray(p.items) ? p.items : [];

  if (!items.length) {
    return `<div class="card">
      <p class="note" style="margin:0">🎁 <b>图鉴还是空的</b> —— 她出门一趟就会带东西回来。<br>
      第一次旅行回来后说一句「看图鉴」，这儿就会长出第一件。</p>
    </div>`;
  }

  const total = items.reduce((n, e) => n + (Number(e.stock) || 0), 0);
  // ★★ 三档计数**必须与下面表格里的标签逐字同规则**（能种 > 能吃 > 只能送人）。
  //   第一版写成 `canEat` / `canPlant` 各数一次 ⇒ 既好吃又能种的那几件（神之麦、绝云椒椒…）
  //   **被数了两遍**：真档 15 件印出「能吃 8 · 能种 4 · 只能送人 6」＝ 18，跟表格对不上。
  //   现在是个**真划分**：4 + 5 + 6 = 15，读者照着表格数一遍就能对上。
  const plantN = items.filter((e) => e.canPlant).length;
  const eatN = items.filter((e) => e.canEat && !e.canPlant).length;
  const keepN = items.filter((e) => !e.canEat && !e.canPlant).length;
  const eatenAll = items.reduce((n, e) => n + (Number(e.eaten) || 0), 0);
  const giftedAll = items.reduce((n, e) => n + (Number(e.gifted) || 0), 0);

  // 三档分组（顺序 = 稀罕程度，稀有的放最前 —— 她就是先看那几件）
  const GROUPS = [
    ['rare', '💎 稀有', '#b5761f'],
    ['uncommon', '✦ 罕见', '#2b6c96'],
    ['common', '· 普通', '#5a6b7a']
  ];

  const blocks = GROUPS.map(([r, label, color]) => {
    const list = items.filter((e) => String(e.rarity || 'common') === r);
    if (!list.length) return '';
    const rows = list.map((e) => {
      const tag = e.canPlant ? '🌱 能种' : (e.canEat ? '🍽️ 能吃' : '📦 只能送人');
      const used = [];
      if (Number(e.eaten) > 0) used.push(`吃 ${e.eaten} 次`);
      if (Number(e.gifted) > 0) used.push(`送 ${e.gifted} 件`);
      if (Number(e.planted) > 0) used.push(`种 ${e.planted} 次`);
      // 批注（`desc`）—— 目前没有写入方，是**留给将来的钩子**：有就印、没有就不占地方
      const desc = String(e.desc || '').trim()
        ? `<div style="color:#8aa3ba;font-size:11px;line-height:1.5;margin-top:2px">${esc(e.desc)}</div>`
        : '';
      const home = [e.city, e.country].filter((x) => String(x || '').trim()).map(String).join('｜') || '？';
      const stock = Number(e.stock) || 0;
      const cnt = Number(e.count) || 0;
      return `<tr><td style="font-weight:600">${esc(e.name)}${desc}</td>`
        + `<td>${esc(home)}</td>`
        + `<td>${esc(tag)}</td>`
        + `<td class="num">×${stock}`
        + (cnt > 1 ? `<div style="font-weight:400;color:#8aa3ba;font-size:11px">带回 ${cnt} 次</div>` : '')
        + '</td>'
        + `<td>${esc(used.join(' · ') || '还没用过')}</td></tr>`;
    }).join('');
    return `<details open style="margin:9px 0 0">
      <summary style="cursor:pointer;font-weight:600;color:${color};padding:5px 0;font-size:13.5px">
        ${label}<span style="color:#8aa3ba;font-weight:400">（${list.length} 件）</span>
      </summary>
      <table class="tbl"><tr><th style="width:33%">特产</th><th style="width:20%">从哪儿带回来的</th>
      <th style="width:14%">能做什么</th><th style="text-align:right">手上</th><th>用过的次数</th></tr>${rows}</table>
    </details>`;
  }).join('');

  // 菜地一行 —— 图鉴与菜地是同一套东西的两面（种下去的正是这里的一件）
  const f = p.farm || {};
  const farmLine = f.unlocked
    ? (Number(f.count) > 0
      ? `🌱 菜地 <b>${Number(f.count)}/${Number(f.cap)} 块</b>${Number(f.ripe) > 0
        ? `　——　<b>有 ${Number(f.ripe)} 株熟了</b>，说「收菜」就能收`
        : '　——　都还在长，说「看菜地」看长了多少'}`
      : `🌱 菜地空着（<b>0/${Number(f.cap)} 块</b>）—— 说「种下 某某」就能种一株（要"能种"的那一类）`)
    : '🌱 还没有菜地 —— 请一次<b>千问（小折扇）</b>来庭院就会开出来，请过就永久有。';

  // ★★ 2026-10-26：稀有特产**图墙** —— 这些图一直生成了却从没露过脸（见 renderMenuFile 的注释）。
  //   只摆真压出缩略图的（`thumb` 由渲染层塞进来）；一张都没有 ⇒ 整段不出现，不占地方。
  //   配色跟着 MENU_CSS 的浅色主题走（白卡片 + 暖金边），不要用深色块。
  const picts = items.filter((e) => String(e.thumb || ''));
  const gallery = picts.length
    ? `<div style="margin:14px 0 2px">
        <div style="font-size:13.5px;font-weight:700;color:#b5761f;margin:0 0 7px">💎 稀有特产图（${picts.length} 张）</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          ${picts.map((e) => {
            const home = [e.city, e.country].filter((x) => String(x || '').trim()).map(String).join('｜') || '？';
            return `<div style="border:1px solid #f0d9a8;border-radius:10px;overflow:hidden;background:#fffdf6">
              <img src="${e.thumb}" alt="" style="width:100%;display:block">
              <div style="padding:7px 9px 8px">
                <div style="font-size:13px;font-weight:700;color:#8a5a12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.name)}</div>
                <div style="font-size:11.5px;color:#9a7a4a;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(home)}</div>
              </div>
            </div>`;
          }).join('')}
        </div>
        <p class="note" style="margin:7px 0 0">说「看图鉴里的 <b>某某</b>」就能把那一张原图发出来。</p>
      </div>`
    : '';

  return `<div class="card">
      <p class="note" style="margin:0 0 9px">
        <b>一共 ${items.length} 件，手上还有 ${total} 份</b> ——
        🌱 能种 <b>${plantN}</b> 件 · 🍽️ 能吃 <b>${eatN}</b> 件 · 📦 只能送人 <b>${keepN}</b> 件
        （按"能做什么"分，<b>合计就是 ${items.length} 件</b>：既好吃又能种的那几件只算在「能种」里）。<br>
        到现在为止：吃掉 <b>${eatenAll}</b> 份 · 送出 <b>${giftedAll}</b> 份。
        <b>用一次消耗 1 份存量，图鉴的条目不会被清掉</b>（"收集 N 件"看的是条目数，不是份数）。
      </p>
      ${gallery}
      ${blocks}
      <p class="note">「吃」和「送」会先犹豫一句（"诶，真的要吃吗"）—— 你再说一次才真动手；
      「种」不问，因为东西没消失：它会长出更多份。</p>
    </div>
    <div class="can">${farmLine}</div>`;
}

/**
 * 生成一张菜单图的 HTML。
 * @param {'garden'|'skill'|'wardrobe'|'shop'|'pantry'} kind
 * 其余参数与 `buildWhaleHelpHtml` 同（数据来自 `helpDataFor()`）。
 * @param {string[]} learnable 她**此刻**能学的技能名（index.js 用 `skillGate` 算好传进来）
 */
export function buildMenuHtml({
  kind = 'garden', width = 720, whaleName = '小鲸鱼',
  garden = {}, skills = [], learned = {}, visited = null, learnable = null,
  // ★ 2026-10-13 旅伴养成（只 skill 菜单用）
  companionSkills = [], companionLearned = {}, companionWorlds = {}, companionNames = {},
  learnableCompanion = null,
  // ★ 2026-10-14：称号总分 —— 第四台服务器阵列的门槛就是它（随称号增加而自动提高）
  achievementTotal = 0,
  // ★ 2026-10-14 服装系统：衣柜页要用（来自 `helpDataFor()`）
  wardrobe = {}, areasSeen = {},
  // ★ 2026-10-15「探索解锁」：衣柜只登"她已经知道的世界"那部分
  //   （来自 `helpDataFor()` 的 `visibleRegionIds()`；不传 = 全量）
  visibleRegions = null,
  // ★ 2026-10-14 商店页（第 4 张菜单图）：货架 / 未解锁装备 / 补货 / 余额（同样来自 `helpDataFor()`）
  shop = null,
  // ★ 2026-10-14 图鉴页（第 5 张菜单图）：逐条特产 + 分类 + 存量 + 用过几次 + 菜地一行
  //   （由 index.js 的 `pantryPageData()` 算好；这边只渲染）
  pantry = null,
  // ★ 2026-10-14 相册页（第 6 张菜单图）：本页明信片的缩略图网格
  //   （由 index.js 的 `albumPageData()` 切片；`thumb` 由 `renderMenuFile()` 现压）
  album = null,
  // 伙伴表要在图上打 ✅（已邀请），`ownedIds` 本来就在 helpDataFor 里
  ownedIds = []
} = {}) {
  const meta = MENUS[kind];
  if (!meta) throw new Error(`没有这种菜单：${kind}（可选：${MENU_KINDS.join(' / ')}）`);
  const W = Math.max(480, Number(width) || 720);

  let body = '';
  if (kind === 'garden') {
    const tbl = gardenTable(garden, achievementTotal);
    const built = Object.values(garden || {}).filter((v) => Number(v) > 0).length;
    // ★ 2026-10-14 门槛那行**现读 GARDENS**（末位哨兵 `'all'` = 全部成就值）——
    //   原来写死"10 / 50 / 100 / 200 分"，加了称号就对不上了。
    const arrayCostText = (((GARDENS.find((g) => g.id === 'array') || {}).pointCosts) || [])
      .map((x) => (x === 'all' ? (achievementTotal > 0 ? achievementTotal : '全部') : x))
      .join(' / ');
    body = `
      <div class="card">
        ${tbl || '<p class="note">（设施数据读取失败）</p>'}
        <p class="note">她<b>已经建了 ${built} 件</b>（表里带「已建」标签的就是）。建过的设施一直是生效的，
        不用维护、也不会因为出门而失效。要建/升级就在<b>商店</b>里说（"升级观星台""建服务器阵列"）。<br>
        <b>🗄️ 服务器阵列</b>是唯一的例外：它<b>一分 TOKEN 都不收</b>，门槛是<b>成就值</b>（看称号攒了多少分，
        ${arrayCostText} 分各建一台，一共四台；<b>最后一台 = 全部成就值</b>，以后每加一条称号它自己往上抬）
        —— 每建一台，服务器的产出与储量上限就各多一份。</p>
      </div>`;
  } else if (kind === 'wardrobe') {
    // ★ 2026-10-14 服装系统：衣柜页（按地区折叠 + 每套写清解锁条件）
    body = wardrobePage({ wardrobe, areasSeen, visibleRegions });
  } else if (kind === 'shop') {
    // ★ 2026-10-14 商店页（第 4 张菜单图，用户："把商店也做成菜单图吧"）
    body = shopPage({ shop, ownedIds });
  } else if (kind === 'pantry') {
    // ★ 2026-10-14 图鉴页（第 5 张菜单图，批 3）
    body = pantryPage({ pantry });
  } else if (kind === 'album') {
    // ★ 2026-10-14 相册页（第 6 张菜单图）
    body = albumPage({ album });
  } else {
    const tbl = skillTable(skills, learned, visited);
    const compTbl = companionSkillTable(companionSkills, companionLearned, companionWorlds, companionNames);
    const canList = Array.isArray(learnable) ? learnable : null;
    const canList2 = Array.isArray(learnableCompanion) ? learnableCompanion : null;
    const canText = canList === null
      ? ''
      : (canList.length
        ? `<b>她此刻能学的：${esc(canList.join('、'))}</b> —— 说"学渡鸦信使"这样的就行。`
        : '她此刻<b>一条也学不了</b> —— 要么钱不够（每条价格见表），要么还没去过那个世界。具体差什么，让她说"学技能"会逐条告诉你。');
    const canText2 = canList2 === null
      ? ''
      : (canList2.length
        ? `<b>旅伴此刻能学的：${esc(canList2.join('、'))}</b> —— 说"学龙语"这样的就行。`
        : '旅伴的技能<b>现在一条也练不出来</b> —— 门槛是"她陪你走过 N 个异世界"，多带她们去几趟异世界（或者钱还不够）。');
    body = `
      <div class="card">
        ${tbl || '<p class="note">（技能表读取失败）</p>'}
        <p class="note"><b>怎么解锁</b>：她<b>本人去过</b>那个世界就够（穿越也算）；多数技能还要"<b>手上还有</b>一件那儿的特产"，
        ★ 招牌技能要"那儿的<b>稀有</b>特产"。⚠️ <b>学一次要消耗 1 件该世界的特产＋一笔 TOKEN</b>
        （先花普通的、把稀有留到最后）。那个世界的特产用光之后就暂时学不了 ——
        得再带一件回来，或者种一棵出来。<br>
        <b>学了永久有效、不能退</b>。带【数值】的那半<b>一直生效</b>；另一半是"画面 / 话术"，
        <b>每张明信片只会发动其中一项</b>（所以学多了不打架）。</p>
      </div>
      ${canText ? `<div class="can">${canText}</div>` : ''}
      <div class="card" style="margin-top:12px">
        <p class="note" style="margin:0 0 8px;color:#34526b;font-size:13px"><b>🐾 旅伴技能</b>
        （跟着她出门的那几位，一人一条；门槛是「陪你走过 N 个异世界」，每个 4000 亿 TOKEN，<b>不看特产</b>）</p>
        ${compTbl || '<p class="note">（旅伴技能表读取失败）</p>'}
      </div>
      ${canText2 ? `<div class="can">${canText2}</div>` : ''}`;
  }

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${MENU_CSS(W)}</style></head><body>
  <div class="hero">
    <h1>${meta.emoji} ${esc(meta.title)} · 矩阵庭院菜单</h1>
    <p>${esc(meta.subtitle)}</p>
  </div>
  ${body}
  ${meta.closing ? `<div class="lastword">${esc(meta.closing)}</div>` : ''}
  <div class="foot">🐋 ${esc(whaleName)} · 矩阵庭院</div>
  </body></html>`;
}

/**
 * 渲染一张菜单图并落盘，返回文件路径。
 * @returns {Promise<string>}
 */
/**
 * 某张菜单图**实际用**的画布宽度。
 *
 * 为什么要有这一层：相册页 **6 列 × 每页 12 张**，得比别的菜单图宽得多才排得开；
 * 而 `whale_help(menu:'album')` 走的是通用的 `helpImageWidth`（默认 720）——
 * 直接按 720 排 6 列，每格只剩 ~100px、缩略图糊成一团。
 * ⇒ 相册页统一用 `max(调用方给的, ALBUM_WIDTH)`，其它 kind 原样返回。
 * 抽成纯函数是为了**让探针测得到**（`renderMenuFile()` 本体要 Electron，测不了）。
 */
export function menuWidthFor(kind, width) {
  const w = Number(width) || 720;
  return kind === 'album' ? Math.max(w, ALBUM_WIDTH) : w;
}

/**
 * 图鉴页：把稀有特产的本地大图压成缩略图（`renderMenuFile()` 专用）。
 * 抽成导出函数是为了**让探针测得到**：`renderMenuFile()` 本体要 Electron，Node 里跑不了；
 * 而这一步正是"图鉴页能不能显示图"的开关。
 */
export function withPantryThumbs(pantry = null) {
  if (!pantry || !Array.isArray(pantry.items)) return pantry;
  return {
    ...pantry,
    items: pantry.items.map((e) => (e.thumb || !e.image ? e : { ...e, thumb: albumThumb(e.image, 320) }))
  };
}

export async function renderMenuFile({ kind = 'garden', width = 720, log, ...rest } = {}) {
  // ★★ 2026-10-14 相册页专用：**渲染前**把每张明信片的本地大图压成缩略图。
  //   为什么放在这一层而不是 `albumPage()`：① `createRequire('electron')` 只有渲染时拿得到；
  //   ② 让 `albumPage()` 保持"纯布局" ⇒ 探针与离线预览都不依赖 Electron。
  if (kind === 'album' && rest.album && Array.isArray(rest.album.items)) {
    rest.album = {
      ...rest.album,
      items: rest.album.items.map((c) => (c.thumb ? c : { ...c, thumb: albumThumb(c.image) }))
    };
    const miss = rest.album.items.filter((c) => !c.thumb).length;
    if (miss) log?.(`[travel-whale] 相册页：${miss} 张缩略图没压出来（图不存在或渲染环境不对）`);
  }
  // ★★ 2026-10-26 图鉴页：稀有特产的图同样要**渲染前压成缩略图**。
  //   这些图此前只被写进存档（`state.souvenirs[].image`），图鉴页根本不读 ⇒ 生成了也永远看不见。
  //   与相册同一手法：`pantryPage()` 保持纯布局，压图只在能拿到 Electron 的这一层做。
  if (kind === 'pantry' && rest.pantry) {
    rest.pantry = withPantryThumbs(rest.pantry);
    const miss = Array.isArray(rest.pantry?.items)
      ? rest.pantry.items.filter((e) => e.image && !e.thumb).length : 0;
    if (miss) log?.(`[travel-whale] 图鉴页：${miss} 张稀有特产图没压出来（图不存在或渲染环境不对）`);
  }
  // ★ 相册页要**更宽**的画布（一页 12 张、6 列）—— 不管调用方给的是多少：
  //   `whale_help(menu:'album')` 走的是通用的 `helpImageWidth`（默认 720），
  //   直接排 6 列每格只剩 ~100px、糊成一团。宽度规则抽成 `menuWidthFor()`（探针可测）。
  const W = menuWidthFor(kind, width);
  const html = buildMenuHtml({ kind, width: W, ...rest });
  // ⚠️ 相册是**多页**的 ⇒ 文件名必须带页码，否则第 2 页会把第 1 页覆盖掉，
  //    而 `renderToFile` 的内容哈希缓存是**按文件名**存的（同名不同内容会互相踩）。
  const pageTag = (kind === 'album' && Number(rest.album?.page) > 0) ? `-p${Number(rest.album.page)}` : '';
  return renderToFile(html, W, path.join(OUT_DIR, `whale-menu-${kind}${pageTag}-${W}.png`), log, `${kind} 菜单图`);
}

/**
 * ★★ 2026-10-14 v3.2：**带内容缓存的渲染** —— 治"调用帮助图特别困难"的那一半。
 *
 * 实测（宿主日志 12:51）：从模型决定调到图发出去 **约 12 秒**，其中渲染本身 ~9 秒
 * （开隐藏窗口 → 等布局 → 量 scrollHeight → capturePage），产物 1 MB。
 * 而群友的典型行为是"没刷出来，再说一次""再看一眼" —— 同样内容被**白渲染 N 次**、
 * 每次都让群友干等十几秒。这看起来就像"这个功能很难用"。
 *
 * 缓存键 = **HTML 的内容哈希**（FNV-1a，够用且便宜）：
 *   · 数据一变（升级了设施、学了技能、买了衣服…）HTML 就变 ⇒ 哈希变 ⇒ 重渲染，**不会拿旧图糊弄**；
 *   · 内容没变 ⇒ 直接返回已有的 PNG，**0 秒**。
 * ⚠️ 缓存只放在**进程内存**里：重启后第一次仍会渲染一次（1 张图 ~9 秒，可接受），
 *   而且不需要处理"磁盘上的图是哪个版本"的问题（文件名里没有版本号）。
 * ⚠️ 同时校验文件还在（用户可能清过那个 help 目录），不在就重渲染。
 * ⚠️ 写注释时别在块注释里留出星号加斜杠那种组合 —— 它会**提前闭合注释**、
 *   后面的代码整段错位（这次就踩了：一句路径通配写成那样，直接编译报错）。
 */
const _renderCache = new Map();                    // file -> 内容哈希
const _inFlight = new Map();                       // file -> 在途渲染 Promise（singleflight）
let _renderMutex = Promise.resolve();              // 全局串行队列：进程内同时最多 1 个隐藏窗口
// ★ 内存水位保护（2026-10-26 修）：按**本机物理内存的比例**算上限，同时要求系统可用内存
//   留出 ≥256MB。2026-10-24 那版把阈值写死成绝对 RSS 1536MB —— 但宿主的正常基线随插件
//   数量涨到了 1.5~1.8GB，这条线就变成"永远超线"，所有菜单图一起退化成纯文字。
//   RSS 只能说明宿主自己占了多少；系统还剩多少，才是 OOM 的直接判据。
//   720px 隐藏窗口实测只多占 ~50MB（2026-10-26 迷你宿主实测，渲染 738ms）。
const MB = 1024 * 1024;
const RENDER_MEM_RSS_RATIO = 0.4;
const RENDER_MEM_RSS_MAX_MB = 6144;
const RENDER_MEM_RSS_MIN_MB = 1024;
const RENDER_MEM_MIN_FREE_MB = 256;

/** 纯函数：给定内存数字，判断这次能不能开隐藏窗口（便于单测，不依赖 Electron）。 */
export function renderMemoryGate({ rss, total, free } = {}) {
  const toMb = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n / MB : 0;
  };
  const rssMb = toMb(rss);
  const totalMb = toMb(total);
  const freeMb = toMb(free);
  const capMb = totalMb > 0
    ? Math.min(RENDER_MEM_RSS_MAX_MB, Math.max(RENDER_MEM_RSS_MIN_MB, totalMb * RENDER_MEM_RSS_RATIO))
    : RENDER_MEM_RSS_MAX_MB;
  const problems = [];
  if (rssMb > capMb) {
    problems.push(`宿主常驻内存 ${rssMb.toFixed(0)}MB，超过本机上限 ${capMb.toFixed(0)}MB`);
  }
  if (freeMb > 0 && freeMb < RENDER_MEM_MIN_FREE_MB) {
    problems.push(`系统可用内存 ${freeMb.toFixed(0)}MB，低于安全留白 ${RENDER_MEM_MIN_FREE_MB}MB`);
  }
  return { ok: problems.length === 0, rssMb, totalMb, freeMb, capMb, reason: problems.join('；') };
}

/** 便宜的 32 位 FNV-1a（不用加密强度，只要"内容变了就变"）。 */
function contentHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${str.length}`;
}

/** 渲染 HTML → PNG 落盘（同一份内容重复调用时走缓存）。返回文件路径。
 * ⚠️ 首次渲染要数秒，窗口期内的重复请求绝不能再开新 BrowserWindow：
 *    同文件复用在途 Promise，跨文件排全局串行队列（进程内并发渲染上限 1）。 */
async function renderToFile(html, width, file, log, label = '图') {
  const hash = contentHash(html);
  if (_renderCache.get(file) === hash && fs.existsSync(file)) {
    log?.(`[travel-whale] ${label}内容没变，命中缓存、跳过渲染：${file}`);
    return file;
  }
  if (_inFlight.has(file)) {
    log?.(`[travel-whale] ${label}正在渲染中，复用在途任务：${file}`);
    return _inFlight.get(file);
  }
  const task = (async () => {
    const prev = _renderMutex;
    let release;
    _renderMutex = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      // 排到队头时，同内容可能已被前一个请求渲染完 —— 再查一次缓存
      if (_renderCache.get(file) === hash && fs.existsSync(file)) return file;
      // 内存水位保护：只有「宿主自己太大」或「系统真的没余量」时才降级纯文字
      // （与"纯 Node 环境拿不到 Electron"同一条降级通道）。
      const mem = renderMemoryGate({
        rss: process.memoryUsage().rss,
        total: os.totalmem(),
        free: os.freemem()
      });
      if (!mem.ok) {
        const msg = `内存水位保护：${mem.reason}，跳过截图`;
        log?.(`[travel-whale] ${msg}（${label}将降级为纯文字）`);
        throw new Error(msg);
      }
      const buf = await renderPng(html, width);
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const tmp = `${file}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);    // 先写临时名再改名，读方不会拿到半张图
      _renderCache.set(file, hash);
      log?.(`[travel-whale] ${label}已生成：${file}（${buf.length} 字节，宿主 RSS ${(process.memoryUsage().rss / MB).toFixed(0)}MB）`);
      return file;
    } finally {
      release();
      _inFlight.delete(file);
    }
  })();
  _inFlight.set(file, task);
  return task;
}

// ── 截图（Electron 隐藏窗口）─────────────────────────────────────────────

/**
 * 把 HTML 渲染成 PNG Buffer。
 * 两种窗口配置各试一次 —— 不同 Electron 版本对"隐藏窗口能否截图"支持不一致
 * （有的版本要 offscreen 才画得出来，有的开了 offscreen 反而是白图）。
 * 拿不到 Electron（纯 Node 环境）直接抛错，由调用方降级为文字。
 *
 * ⚠️ 与 `skills/text-image`（长文排版图）**同一条管线**：都是 BrowserWindow + capturePage。
 *    差别只在模板：那边吃纯文本并**自动分页**（单页高度上限 3600），我们这张是自绘卡片、
 *    **一张出完**（高度上限 6000）。帮助图再长下去时，可以考虑学它做分页。
 */
export async function renderPng(html, width = 720) {
  const req = createRequire(import.meta.url);
  let electron = null;
  try {
    electron = req('electron');
  } catch (error) {
    throw new Error(`当前进程不是 Electron 主进程，无法渲染图片（${error?.message ?? error}）`);
  }
  const { BrowserWindow } = electron;
  if (!BrowserWindow) throw new Error('Electron 未提供 BrowserWindow');

  const w = Math.max(480, Number(width) || 720);
  const attempts = [{ offscreen: false }, { offscreen: true }];
  let lastError = null;

  for (const pref of attempts) {
    let win = null;
    try {
      win = new BrowserWindow({
        show: false, width: w, height: 600, backgroundColor: '#eaf4ff',
        webPreferences: { ...pref, backgroundThrottling: false }
      });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('渲染超时')), 15000));
      const buf = await Promise.race([
        (async () => {
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          const h = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
          win.setSize(w, Math.min(Math.max(Number(h) || 600, 200), 6000));
          await new Promise((r) => setTimeout(r, 150));   // 给重排留点时间
          const img = await win.webContents.capturePage();
          return img.toPNG();
        })(),
        timeout
      ]);
      // 过小的 PNG 基本都是空白图（隐藏窗口没画出来），换另一种配置重试
      if (buf && buf.length > 2000) return buf;
      lastError = new Error(`截图为空白（${buf?.length ?? 0} 字节）`);
    } catch (error) {
      lastError = error;
    } finally {
      try { win?.destroy(); } catch { /* 窗口已经没了 */ }
    }
  }
  throw lastError || new Error('渲染失败');
}

/**
 * 渲染说明图并落盘，返回文件路径。
 * 参数与 `buildWhaleHelpHtml` 完全一致（多一个 log）。
 * @returns {Promise<string>}
 */
export async function renderHelpFile({
  width = 720, whaleName = '小鲸鱼', restockHours = 168, log, ...rest
} = {}) {
  // ★★ 2026-10-14 v3.2 修（**这是个真 bug，而且刚好是"图上少了东西"的那一类**）：
  //   这里原来把参数**逐个列出来**再转手传给 `buildWhaleHelpHtml` ——
  //   于是 `helpDataFor()` 后来新增的字段（`titlesTotal` / `achievementTotal` /
  //   `companionSkills` / `wardrobe` / `areasSeen` …）**一个都进不了主图**，
  //   而且**不报错**：图照样出来，只是那几处悄悄退回默认值（实测"57 个称号"变成"攒出一堆称号"）。
  //   ⇒ 改成 `...rest` 全量透传。**新增字段时不用回来记得改这里**（这才是治本）。
  const html = buildWhaleHelpHtml({ width, whaleName, restockHours, ...rest });
  return renderToFile(html, width, path.join(OUT_DIR, `whale-help-${width}.png`), log, '说明图');
}

/** 降级用的纯文字版（Electron 不可用时）。 */
export function buildHelpText({ restockHours = 168 } = {}) {
  const lines = ['🐋 小鲸鱼 · 玩法说明', ''];
  for (const [what, how] of CHEATS) lines.push(`${what} → 「${how}」`);
  lines.push('', `货架每 ${restockHours} 小时补满一次。不用记死话术，换个说法它也听得懂。`);
  // ★ 2026-10-13 晚：这句收尾与图上的版本保持一致（降级成文字版时也该有）
  lines.push('', '别担心，无论她去了哪儿，都能找到回来的路。');
  return lines.join('\n');
}
