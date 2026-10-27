// 矩阵庭院 —— 每个群养一只小鲸鱼，它会从世界各地寄回明信片。
//
// ── 模块划分 ────────────────────────────────────────────────────────────
//   state.js    状态 / 服务器 / 图鉴 / 相册
//   search.js   三级搜索（百度 → 高性能版 → Bing）+ 串行限速 + 配额
//   trip.js     选城市（池子 80% / 自由 20%）、行程参数、防幻觉抽取
//   postcard.js 明信片文案 + 配图 + 失败降级
//   titles.js   50 个称号（带成就值 1/3/5/10）
//   engine.js   时间推进的纯逻辑（该不该寄、该不该回、该不该出发）
//   本文件       把它们接起来：工具（模型入口）+ 后台 ticker（自主行为）
//
// ── 为什么必须有后台 ticker ─────────────────────────────────────────────
//   群友不会一直调工具，但鲸鱼要"自己"寄明信片、自己回家。这些动作发生在
//   没有工具调用的时刻，所以需要 ticker + 核心服务（sender）。
//   拿服务的方式见 plugin-loader 的 api.onServices —— 这就是那次"小改核心"
//   要解决的硬约束。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// ★ 2026-10-23：无聊值（在家越久越高，出门一次清空）—— 纯函数，见 lib/boredom.js
import * as BORED from './lib/boredom.js';
import { DATA_DIR, getConfig, updateConfig } from '../../src/config.js';
// ★ 2026-10-21：`resolveApiKey` 是"单次指定模型"那条路的必需品 —— 宿主的
//   `chatCompletion({ overrides })` 一旦给了 overrides 就**丢掉主模型那套 baseUrl/apiKey**
//   （见 src/llm.js:655 `const baseApi = overrides || effectiveApi()`），
//   自己凑端点时必须按同一套规则解析钥匙，否则会拿"手动模式遗留的空 key"去请求。
import { chatCompletion, resolveApiKey } from '../../src/llm.js';

import * as S from './state.js?v=realworld-1';
import * as E from './engine.js';
import * as T from './trip.js';
import * as P from './postcard.js?v=realworld-1';
import * as TI from './titles.js';
import * as H from './help.js';
// ★ 2026-10-16：工具合并入口 —— 23 个 whale_* 收成 5 个带 action 的分发工具（只改"喊法"，不改玩法）
import { registerMergedTools } from './merged-tools.js';
// ★ 2026-10-13 step4：`home.js` = 矩阵庭院的外观/画风组/在家大合照。
//   ⚠️ 别名用 `HM` —— `H` 已经被 help.js 占着了（别改成 H，会静默换错模块）。
import * as HM from './home.js';
import * as RW from './lib/real-world.js';
// ★ 2026-10-14 服装系统：服装表 + 单价（`OW` 这个别名挑过 —— O/OH 太容易撞）。
//   ⚠️ 套数**现读 `OW.OUTFITS.length`**，注释里也别写死（写"39 套"在 v3.0 加套后就成了假话）。
import * as OW from './outfits.js';
// ★ 2026-10-14 特产出口：分类 / 口味 / 「吃 · 送」的文案池（纯函数、零依赖，可离线单测）。
//   ⚠️ 别名用 `SV` —— S 是 state、SP 容易被看成 shop。
import * as SV from './souvenir.js';

import { searchWeb, quotaSnapshot } from './search.js';

let cfg = () => ({});
let log = () => {};
let services = null;          // { sender, store, ... }，由 api.onServices 注入
let timer = null;             // ⚠️ 仅作兼容保留；**权威句柄在 G[TICKER_SLOT]**（见下）
let apiRef = null;            // setup 时存下来，供 activate() 补挂 onServices 监听器
let cancelServices = null;    // api.onServices 返回的取消函数（deactivate 时必须调用）

/* ── 进程级单例闩：防「幽灵 ticker」（2026-10-12，MEMORY-2 §56）─────────────────
 * 热重载会**重新 import 出新的模块实例**，于是模块级变量会分叉：
 *   · 新实例看到的 `timer` 是 undefined ⇒ `if (timer) return` 守卫形同虚设；
 *   · `deactivate()` 也只清得掉"自己那份" ⇒ 旧实例的 setInterval 变成没人拿得到句柄的孤儿。
 * 实测后果：宿主一次文件变化触发 2 轮重扫（app.js 的 onReload 重复扫描，同日已修），
 * 又叠加并发窗口 ⇒ 攒出 4 个 ticker ⇒ **同一张明信片被连发 4 遍**。
 * 对策：这两个句柄必须挂在 globalThis **跨模块实例唯一**：
 *   · TICKER_SLOT  —— 当前活着的 ticker；startTicker 总以"最后一个 setup 的实例"接管；
 *   · TICK_RUNNING  —— tick 互斥；跨实例生效后，"并发读到同一份存档、各寄一遍"从根上消失。
 */
const G = globalThis;
const TICKER_SLOT = '__qqAgentTravelWhaleTicker';    // { interval, first }
const TICK_RUNNING = '__qqAgentTravelWhaleTicking';  // true = 有 tick 在跑

/** 踢掉当前活着的 ticker（**无论它属于哪个模块实例**），并清空句柄。 */
function killTicker() {
  const h = G[TICKER_SLOT];
  timer = null;
  if (!h) return false;
  try { clearInterval(h.interval); } catch { /* 已失效 */ }
  try { clearTimeout(h.first); } catch { /* 已失效 */ }
  G[TICKER_SLOT] = null;
  return true;
}

/**
 * 快速测试用的**固定目的地**。
 *
 * 为什么不走搜索 + 抽取那条正常链路：
 *   ① 要几秒到几十秒，测起来不爽；
 *   ② 会花搜索配额；
 *   ③ **最关键** —— 搜索或模型一出问题，测试工具自己也跑不起来，
 *      而"东西坏了要排查"的时候恰恰最需要它。
 * 所以这里用内置数据，保证「矩阵庭院快速测试」永远能跑通。
 * 想验证搜索链路，请用正常出行，那条路仍然走搜索。
 */
const QUICK_TEST_PLACES = [
  {
    city: '会安', country: '越南', region: 'asia', regionName: '亚洲', style: '水彩绘本',
    spots: [
      { name: '会安古城', scene: '挂满彩色灯笼的老街、河上漂着小船' },
      { name: '日本廊桥', scene: '木廊桥、桥下的流水与倒影' }
    ],
    souvenirs: [{ name: '会安灯笼', label: 'common' }, { name: '会安丝绸', label: 'common' }]
  },
  {
    city: '特罗姆瑟', country: '挪威', region: 'arctic', regionName: '北冰洋', style: '极光渐变',
    spots: [
      { name: '北极教堂', scene: '三角形白色教堂、背后是覆雪的群山' },
      { name: '峡湾观景台', scene: '俯瞰峡湾、天上挂着绿色极光' }
    ],
    souvenirs: [{ name: '羊毛围巾', label: 'common' }, { name: '极光玻璃摆件', label: 'uncommon' }]
  },
  {
    city: '圣托里尼', country: '希腊', region: 'europe', regionName: '欧洲', style: '油画厚涂',
    spots: [
      { name: '伊亚小镇', scene: '白墙蓝顶的小屋、悬崖上的石阶' },
      { name: '红沙滩', scene: '赤红岩壁与深蓝海面' }
    ],
    souvenirs: [{ name: '橄榄油手工皂', label: 'common' }, { name: '手绘陶罐', label: 'common' }]
  }
];

/** 快速测试的旅程时长：10 分钟（第 5 分钟寄片，第 10 分钟回家）。 */
const QUICK_TEST_MS = 10 * 60 * 1000;

/**
 * 快速测试用的**独立存档键后缀**。
 *
 * 为什么不让测试往真身写：测试会走完"寄明信片 → 回家带特产 → 解锁称号"整条链路，
 * 全都会落进相册/图鉴/统计里。跑几次测试，真身的记录就被测试数据污染了。
 * 所以测试读写 `${chatKey}_test` 这份独立存档 —— 真身一个字节都不动。
 * （下划线在 safeKey 的白名单里，来回映射不会变形。）
 */
const QUICK_TEST_KEY_SUFFIX = '_test';

/** 收养见面礼（只发一次，靠 state.giftAt 记账）。 */
const GIFT_PLANKTON = 200;
/**
 * 归来奖励 —— **只认稀有**。
 *
 * 原来设计写的是「归来给一小笔 TOKEN」，但那等于每趟都发，出门变成净赚，
 * 口粮就不再是成本了。改成只在**撞上稀有**时才给：普通的一趟颗粒无收，
 * 撞到稀有的那趟才有惊喜 —— 这也让「冲稀有」这件事有了实际收益。
 */
const REWARD_RARE_SOUVENIR = 50;   // 每件稀有特产
const REWARD_RARE_CARD = 20;       // 每张稀有明信片
const GIFT_FOOD = 1;

const chatsDir = () => path.join(DATA_DIR, 'skills', 'travel-whale', 'chats');
const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');

/** 所有"养了鲸鱼"的会话（有存档文件即算）。 */
function activeChats() {
  try {
    return fs.readdirSync(chatsDir())
      .filter((f) => /^(group|private)_.+\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, '').replace(/^group_/, 'group:').replace(/^private_/, 'private:'));
  } catch { return []; }
}

/**
 * 白名单：配置里显式列出，或本地已经有存档（＝有人在这群养过）。
 * 二选一命中即启用 —— 这样"主人说一句就能养"不需要改配置。
 */
function isEnabled(chatKey, settings) {
  const list = String(settings?.whitelist ?? '')
    .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  if (list.includes(chatKey)) return true;
  if (list.includes(chatKey.replace(/^(group|private):/, ''))) return true;
  return fs.existsSync(path.join(chatsDir(), `${safeKey(chatKey)}.json`));
}

/** 全部画风（"百变风格"称号要用）。 */
/**
 * 取这条消息是谁发的（QQ 号）。
 *
 * 工具 ctx 里**没有**发送者字段，身份要从 session.trigger 里捞 ——
 * 那是入站时写下来的原始触发条目，带 senderId。
 */
/** 这个会话是私聊吗（chatKey 形如 private:12345）。 */
function isPrivateChat(chatKey) {
  return String(chatKey || '').startsWith('private:');
}

function senderOf(ctx) {
  const list = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const id = String(list[i]?.senderId ?? '').trim();
    if (id) return id;
  }
  return '';
}

function allStyles() {
  const set = new Set();
  try { for (const r of T.loadRegions()) for (const s of r.styles || []) set.add(s); } catch { /* 表损坏就算了 */ }
  return set;
}

/**
 * 地区总数（称号阈值用）。
 * 表损坏就返回 0 —— titles.js 那边写的是 `ctx?.regionTotal || DEFAULT`，
 * 0 是 falsy，会自动退回兜底值，不会把称号判成"已集齐"。
 */
function regionCount() {
  try { return T.loadRegions().length; } catch { return 0; }
}

/**
 * 异世界 id 集合（「世界版图」那一组新加的异世界称号要用）。
 *
 * ⚠️ titles.js 是**零 import 的纯函数模块**（刻意的，为了能离线单测），
 *    所以它不能自己问 trip.js 要 —— 只能像 `regionTotal` 一样**由这里注入**。
 * 表坏了就返回空集 ⇒ titles.js 那边当做"没有异世界" ⇒ 那四条恒不达成
 * （**安全降级**：不会误解锁、也不抛错）。
 */
function fictionalRegionIds() {
  const set = new Set();
  try {
    for (const r of T.loadRegions()) if (T.isFictional(r)) set.add(String(r.id));
  } catch { /* 表坏了就当没有异世界 */ }
  return set;
}

/**
 * 称号判定要的那套"全局表"——**三处判定共用这一份**，别再各写各的。
 *
 * 为什么这些数据不能由 titles.js 自己读：它是**零 import 的纯函数模块**（为了能离线单测），
 * 而技能表住在**本文件**、地区表要通过 trip.js 读 ⇒ 只能由这里注入。
 * ⚠️ 任何一项拿不到，titles.js 都当作"没有"⇒ 对应那几条称号**恒不达成**（安全降级）。
 * ★ 2026-10-13 晚（第二批四组）：新增 `skillTotal` / `skillRegionOf` / `companionTotal` /
 *   `gardenTotal` / `gardenMax`。
 */
function titleCtx() {
  const gardenMax = {};
  try {
    for (const g of (S.GARDENS || [])) gardenMax[String(g.id)] = Math.max(1, Number(g.maxLevel) || 1);
  } catch { /* 表坏了就不给上限（"看得最清"会退回 5 级判定） */ }
  return {
    allStyles: allStyles(),
    regionTotal: regionCount(),
    fictionalRegions: fictionalRegionIds(),
    skillTotal: SKILLS.length,
    skillRegionOf: Object.fromEntries(SKILLS.map((k) => [String(k.id), String(k.region || '')])),
    companionTotal: Object.keys(S.COMPANIONS || {}).length,
    gardenTotal: (S.GARDENS || []).length,
    gardenMax
  };
}

// ── 依赖装配：把"网络/模型"注入给纯逻辑模块 ──────────────────────────────
//   子模块（trip/postcard）刻意不 import 网络与模型，全靠这里注入，
//   所以它们能脱离运行环境单测。

let capability = () => undefined;   // api.capability，setup 时赋值

/**
 * ★ 真实照片降级（2026-10-25，参照《大世界》）：生图**真失败**后给明信片找一张
 * 目的地的真实风景照（Wikimedia 优先带署名）。返回 {path, credit} 或 null。
 * 纪律：只在真实区域（REGION_CENTER 有键）启用——家/异世界没有"真实照片"这回事；
 * 落盘进 real-photos/<chatKey>/（相册要长期引用，URL 会失效）。
 */
function makeRealPhotoSaver(chatKey, { log: logFn } = {}) {
  return async function realPhoto({ spot = '', city = '', country = '', regionKey = '' } = {}) {
    if (!RW.REGION_CENTER[String(regionKey)]) return null;
    const query = [String(spot || ''), String(city || ''), '风景'].filter(Boolean).join(' ');
    const photos = await RW.photosFor(query, { count: 2 });
    if (!photos.length) return null;
    const photo = photos[0];
    const dir = path.join(DATA_DIR, 'skills', 'travel-whale', 'real-photos',
      String(chatKey).replace(/[^a-z0-9_]/gi, '_'));
    const base = `real-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      const localPath = await RW.downloadPhoto(photo.url, dir, base);
      return { path: localPath, credit: RW.creditOf(photo) };
    } catch (e) {
      try { logFn?.(`[travel-whale] 真实照片下载失败（放弃降级）：${e?.message ?? e}`); } catch { /* ignore */ }
      return null;
    }
  };
}

function buildDeps(chatKey, state) {
  const c = cfg();
  return {
    log,
    // 文案/抽取都用 bot 的主模型（用户在设置页配的那个）
    llm: async (prompt) => {
      const r = await chatCompletion({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.85
      });
      return String(r?.message?.content ?? '').trim();
    },
    search: (q) => searchWeb(q, {
      baiduApiKey: String(c.baiduApiKey ?? '').trim(),
      freeQuota: { baidu: c.baiduFreePerDay, summary: c.webSummaryFreePerDay },
      allowPaid: c.allowPaid === true,
      minIntervalMs: c.minIntervalMs,
      topK: c.searchTopK,
      log
    }),
    // 软依赖 image-generate：没开这个技能就返回失败 → 明信片自动退化成纯文字。
    //
    // ⚠️ api.capability(name, args) 的语义是**调用并返回结果**，不是"取一个函数回来"。
    //    踩过的坑：原写成 `const fn = capability('image.generate')` 再 `fn({...})`，
    //    而 fn 实际是个 Promise —— `typeof fn !== 'function'` 恒成立，
    //    于是**每一次配图都"未启用文生图技能"**：明信片永远纯文字、稀有特产永远没图，
    //    日志里还只有一句误导性的"未启用"，看起来像没装技能。
    imageGen: async (prompt, opts = {}) => {
      const res = capability('image.generate', {
        prompt,
        // ★ 2026-10-13 step4：允许单次覆盖尺寸 —— 在家的大合照要**横板**（1536x1024），
        //   而旅行明信片是配置里的方板（imageSize，默认 1024x1024）。
        //   ⚠️ 用 `||` 兜底而不是直接取 opts.size：老调用点不传 opts，也不能变成 undefined。
        size: String(opts?.size || c.imageSize || '1024x1024'),
        count: 1,
        // ★★ 2026-10-15「定妆参考图」（图生图）：明信片按**这一张出场的少女**传一组定妆照
        //   绝对路径；image-generate 读成 dataURL 塞进请求体（宿主发不了 multipart，
        //   走 JSON 的 `image` 字段 —— 那条路实测通）。**空数组一律不传** ⇒ 请求体里
        //   连字段都没有 ⇒ 纯文生图，与从前**逐字节一致**。
        //   ⚠️ 只有**明信片**接了这条路。另外三处生图点**故意没接**：
        //      · `makeSouvenirImage`（特产图，主体是物件，人物只是陪衬）；
        //      · `shootHomeGroup`（在家合照）与 `shootHarvest`（收菜）——横板 1536x1024
        //        且人多，参考图的比例（竖版三视图）与体积都对不上。
        //      要接的话得另做一套横板定妆，不是这里加一行的事。
        ...(Array.isArray(opts?.refs) && opts.refs.length ? { refs: opts.refs } : {})
      });
      // 没有 provider（技能没开）时 capability 返回 undefined
      return res || { ok: false, error: '未启用文生图技能' };
    },
    saveImage: P.makeImageSaver(chatKey, { log }),
    // ★ 真实照片降级位（postcard.js 在生图真失败后调用；未注入 ⇒ 旧行为逐字一致）
    realPhoto: makeRealPhotoSaver(chatKey, { log }),
    luck: Number(charmLuck(state)?.luck) || 0
  };
}

/**
 * ★★ 2026-10-21「明信片题词单独选模型」（用户需求）────────────────────────────
 *
 * 配置项 `skills.travel-whale.captionModel`：
 *   · **空（默认）** ⇒ 完全走原来那条路（`cardDeps` 原样返回 `d`，`d.llm` 一个字都不改）；
 *   · **非空**     ⇒ 明信片的 `caption`（题词）与 `thought`（感想）**都**用这个模型生成。
 *     画风提示词、出图模型**都不换**（`imageGen` 完全不经过这里）。
 *
 * ⚠️ 为什么用宿主的 `chatCompletion({ overrides })` 而不是自己发 HTTP：
 *   overrides 就是宿主**官方**的"单次指定模型"入口（`orchestrator.js` 的
 *   「记忆整理专用模型」也走它）—— 超时 / abort / 重试 / 计费 / 日志 / 协议转换
 *   全都留在 `src/llm.js` 里。自己发 HTTP 会绕过计费与重试，还会在宿主更新时被悄悄改坏。
 */
function captionModelOf() {
  const raw = cfg()?.captionModel;
  // ★ **只认字符串**：数字 / 对象 / 数组 / null 一律当"没配"。
  //   为什么不用 `String(raw)`：`123` 会变成模型名叫 "123"，请求必然失败 ⇒
  //   题词静默退化成兜底话术 —— 那是"脏值改变了现有行为"，正是要避免的。
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * 把"用哪个模型"翻成 `chatCompletion` 的 overrides。
 *
 * ⚠️ 关键事实（宿主 `src/llm.js:655`）：`const baseApi = overrides || effectiveApi()`
 *    ⇒ **给了 overrides 就等于丢掉主模型那套 baseUrl/apiKey**，
 *    所以这里必须自己把端点凑齐（不能只传 `{ model }`，否则请求发不出去）。
 *    凑法照抄 `effectiveApi()`：`{ ...cfg.api, apiKey: resolveApiKey(cfg) }`。
 *
 * ⚠️ 模型可能属于**另一个提供商**（典型：主模型 deepseek，题词想用别家的 claude）——
 *    只改 `model` 会把"B 家的模型名"发到"A 家的地址"，网关只会回"模型不存在 / 401"。
 *    归属判断照抄 `llm.js` 的 `providerOfModel`（那个函数没导出，逻辑只有十来行 ⇒ 这里重写一份）。
 *    协议**不用自己算**：`chatCompletion` 里是 `api.protocol || protocolForProvider(cfg, api.provider)`
 *    ⇒ 只要 `provider` 带对了，Anthropic 那套 Messages API 会自己生效。
 *
 * @param {string} model 配置里的模型名（空 ⇒ 返回 null，调用方走主模型）
 * @returns {object|null} 可直接传给 `chatCompletion` 的 overrides；凑不齐端点时返回 null
 */
function captionOverrides(model) {
  const want = String(model ?? '').trim();
  if (!want) return null;
  let c = null;
  try { c = getConfig(); } catch { c = null; }   // 读不到配置 ⇒ null（调用方退回主模型，不猜端点）
  if (!c || typeof c !== 'object') return null;
  const api = { ...(c.api || {}), apiKey: resolveApiKey(c) };
  const mainPid = String(c.api?.provider ?? '').trim();
  const wantLc = want.toLowerCase();
  for (const p of (Array.isArray(c.providers) ? c.providers : [])) {
    const list = Array.isArray(p?.models) ? p.models : (p?.model ? [p.model] : []);
    if (!list.some((x) => String(x ?? '').trim().toLowerCase() === wantLc)) continue;
    const pid = String(p?.id || '');
    const base = String(p?.baseURL ?? '').trim();
    if (pid && pid !== mainPid && base) {
      const key = String(c.dshProviderKeys?.[pid] ?? p?.apiKey ?? '').trim();
      return {
        ...api,
        baseUrl: base,
        apiKey: key === '******' ? '' : key,
        provider: pid,
        ...(String(p?.apiProtocol ?? '').trim() ? { protocol: p.apiProtocol } : {}),
        model: want
      };
    }
    break;                                    // 这个模型名归第一个登记它的提供商
  }
  return { ...api, model: want };             // 主提供商自己就有 ⇒ 只换 model 名
}

/**
 * 明信片专用 deps（只给 `P.composePostcard` 用）。
 *
 * ★ 回归红线：`captionModel` 为空时**原样返回传入的 `d`**（连对象都不新建）——
 *   调用方拿到的还是同一个对象、同一个 `llm` 闭包 ⇒ 与改造前**逐字节同一条路径**。
 */
function cardDeps(d) {
  const model = captionModelOf();
  if (!model) return d;
  const mainLlm = d?.llm;
  if (typeof mainLlm !== 'function') return d;  // 连主模型都没有 ⇒ 别造一个假的出来
  return {
    ...d,
    llm: async (prompt) => {
      const overrides = captionOverrides(model);
      // 端点凑不齐 ⇒ 退回主模型：宁可用错模型，也不能因为这条配置把明信片打没
      if (!overrides) return mainLlm(prompt);
      try {
        const r = await chatCompletion({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.85,                     // ★ 与 `buildDeps` 里那条**同一个温度**
          overrides
        });
        const txt = String(r?.message?.content ?? '').trim();
        if (txt) return txt;
        throw new Error('题词模型返回空内容');
      } catch (error) {
        // ★★ 2026-10-21 修（用户报"明信片文风很有 deepseek 味"）：
        //   原来这里**没有 catch** —— 题词模型一失败（那晚 a6api 整家 503），
        //   异常直接冒到 `postcard.js` 的 catch，caption/thought 落空 ⇒
        //   下一行 `pickFallback()` 用**硬编码短句池**（"它俩说挺好"这种）。
        //   那条路既不是 gemini 也不是 deepseek，文风会和平时完全脱节。
        //   现在：题词模型失败 ⇒ **先用主模型重试一次**，主模型也失败才轮到模板。
        //   代价是慢了那一次失败请求的耗时（503 约 3 秒），换来文风不突变。
        try {
          log(`[travel-whale/postcard] 题词模型 ${model} 失败（${String(error?.message ?? error).slice(0, 120)}），改用主模型重试`);
        } catch { /* 日志失败不影响主流程 */ }
        return mainLlm(prompt);
      }
    }
  };
}

/** 当前带的护身符带来的幸运加成（提升稀有明信片 / 稀有特产概率）。 */
function charmLuck(state) {
  const id = String(state?.whale?.charm ?? '').trim();
  const def = S.CHARM_TYPES[id];
  return { luck: def ? Number(def.luck) || 0 : 0 };
}

/**
 * ★ 读当前会话的旅行伙伴（**兼容包装**，2026-10-11）。
 *
 * 为什么必须包一层：`companionOf` 住在**兄弟模块** state.js，而热重载只给*入*口文件加 `?t=`
 * （`src/plugin-loader.js:418`）⇒ 改完代码到重启之间，会出现「新 index.js + 缓存里的旧 state.js」，
 * 那时 `S.companionOf` 根本不存在。不包装的话 `whale_status` / `whale_shop` 一调就
 * `TypeError: S.companionOf is not a function` —— 那不是"新功能不生效"，是
 * **连看庭院都报错、整个技能的工具全挂**。
 * 包一层之后：热载期间 = 没有伙伴（新功能静默未生效），重启后自动生效。
 *
 * （同伴还要注意：`S.COMPANIONS` 在旧 state.js 里是 undefined，所以各处都写了 `|| {}` / `?.`。）
 */
const companionOf = (st) => (typeof S.companionOf === 'function' ? S.companionOf(st) : null);

/**
 * ★ 伙伴名册文本（提示词 / 商店用）—— **现读 COMPANIONS**，加新伙伴不用改文案。
 *   写成"「黑发兽耳小狐狸」4000 亿 TOKEN、「小白龙」3000 亿 TOKEN"。
 */
function companionRosterText() {
  const list = Object.values(S.COMPANIONS || {});
  if (!list.length) return '（暂无）';
  // ★ 2026-10-13：带上「特色」—— 五个人的代价/收益不再一样，光看名字与价格看不出区别。
  return list.map((c) => `「${c.name}」${c.price} 亿 TOKEN（特色：${c.trait || '增幅'}）`).join('、');
}

/**
 * ★★ 2026-10-24：**只列名字**，给「每轮都进系统提示词」的那处用。
 *
 * 为什么另开一个而不是改 companionRosterText：那个还兼着工具回执（whale_shop /
 * whale_buy 的回话里要报价），把价格删了群友就看不到价了。而系统提示词里那份
 * 价目表是**纯冗余** —— 她真去买的时候，whale_shop 会把价格再报一遍。
 * 七个伙伴 × 每条约 30 字 = 每轮白烧一百多字，还是压在长提示词的中段。
 */
function companionNamesText() {
  const list = Object.values(S.COMPANIONS || {});
  if (!list.length) return '（暂无）';
  return list.map((c) => `「${c.name}」`).join('、');
}

/** 某个伙伴的图标（热载期间 COMPANIONS 可能是旧的 ⇒ 兜底 🐾）。 */
const companionEmoji = (idOrDef) => {
  const def = typeof idOrDef === 'string' ? (S.COMPANIONS || {})[idOrDef] : idOrDef;
  return (def && def.emoji) || '🐾';
};

// ── ★★ 2026-10-13 庭院设施（GARDENS）─────────────────────────────────────
//   现读 state.js 的表（加一件设施不用改这里）；等级存在 `state.garden[id]`。

/** 某件设施的等级（缺省 = 0）。 */
function gardenLevel(state, id) {
  return Math.max(0, Number(state?.garden?.[id]) || 0);
}

/** 设施定义表（热载期间旧 state.js 没有它 ⇒ 空表，功能静默不生效）。 */
const gardenDefs = () => (Array.isArray(S.GARDENS) ? S.GARDENS : []);

/** 设施名单文本。★ **现读**，不再写死 —— 写死的版本已经漏改过两次
 *  （加了灯笼路没补进去、灯笼路撤销了却还留在文案里）。空表 ⇒ 空串（调用方负责省略那半句）。 */
const gardenNameList = () => gardenDefs().map((g) => g.name).join('、');

/** 这趟要几份口粮：旅伴加成 **减** 电饭煲减免，最低 1。（原来三处各写一遍，这里收成一个） */
/**
 * 出门口粮需求。
 * ★★ 2026-10-14「扩容鲸鱼」：同行的**每一位都要吃** ⇒ 多人的口粮**累加**
 *    （这正好是扩容的代价 —— 与 §69「真正被消耗的是稀缺库存」同向）。
 * ⚠️ 电饭煲的 -1 减免**只减一次**（它语义是"家里能焖饭"，不是按人头各减一份）。
 * ⚠️ 兼容两种入参：单个伙伴定义（老调用点）/ 数组（同行全部）；单人时**逐字节等于从前**。
 */
function foodNeedOf(state, compOrList) {
  const list = Array.isArray(compOrList)
    ? compOrList.filter(Boolean)
    : (compOrList ? [compOrList] : []);
  const base = list.length
    ? list.reduce((s, c) => s + Math.max(1, Number(c?.foodCostMult) || 1), 0)
    : 1;
  return Math.max(1, base - gardenLevel(state, 'stove'));
}

/**
 * ★★ 2026-10-14「扩容鲸鱼」（设施 A）：这一趟**带谁**出门。
 *
 * 规则：领头（`state.companion` —— 玩家在商店选定的那位）**必带**；其余从"已请过的"里
 *   **随机**补满到设施上限（`partyCapOf`）。
 *   ⚠️ 未建扩容设施时上限 = 1 ⇒ 只返回领头 ⇒ 与从前**逐字节一致**。
 *   ★ 为什么"其余随机"而不是按顺序：请了 7 位而上限只有 4，**按顺序会让后请的那几位
 *     永远排不上**；随机则人人都有机会（用户只定了"能带几位"、没定"带谁"，先按这个口径）。
 * ⚠️ 兄弟模块的函数一律**包装后调用**：热载时 `state.js` 可能还是旧版、新导出根本不存在，
 *    裸调 `S.partyCapOf(...)` 会 TypeError 把**整个技能的工具**全带崩。
 */
function pickPartyIds(state) {
  const cap = Math.max(1, typeof S.partyCapOf === 'function' ? S.partyCapOf(state) : 1);
  const lead = String(state?.companion?.id || '').trim();
  if (!lead || !S.COMPANIONS?.[lead]) return [];
  const owned = typeof S.ownedCompanionIds === 'function' ? S.ownedCompanionIds(state) : [];
  const pool = owned.filter((id) => id !== lead && S.COMPANIONS?.[id]);
  // ★ **确定性取人**（按"请的顺序"取前 cap−1 位），刻意**不用随机**：
  //   `whale_go` / 自动出发都要在 `depart()` 之前**先算口粮**，随机的话根本算不出会带谁，
  //   只能按最坏情况多买（7 位全请时要囤十几份）。确定性 ⇒ 前后同一口径。
  //   ★ 想换人 ⇒ 换领头那位（`whale_companion`）。
  return [lead, ...pool.slice(0, Math.max(0, cap - 1))];
}

/** 这一趟同行的**伙伴定义**（＝ `pickPartyIds` 查表）—— 出门前后共用同一口径。 */
function partyOf(state) {
  return pickPartyIds(state).map((id) => S.COMPANIONS?.[id]).filter(Boolean);
}

// ── ★★★ 2026-10-14「借一副嘴」（MEMORY-2 §113）─────────────────────────────
//   用途：邀请 / 更换旅伴时，把那句**第三人称转述**（"她答应了！"）换成**她本人说的一句话**。
//   原理：`chatCompletion({messages})` 的 messages 由调用方给 ⇒ 把人物卡当 `messages[0]`（system）
//     塞进去、用完即弃 —— **`persona.roleText` 一个字都不动**。
//   ⚠️ 三条纪律：① 绝不动全局人设；② 卡要短（只有"她是谁／怎么说话／小习惯"）；
//     ③ **任何失败都回落原来的转述**，绝不因为调模型失败就不回话。

let personaCardsCache = null;
let personaCardsMtime = 0;

/** 现读人物卡（`personas.json`）⇒ **改卡即时生效、不用重启**。读不到 → 空对象（调用方回落）。 */
function personaCards() {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'personas.json');
    const st = fs.statSync(f);
    if (!personaCardsCache || st.mtimeMs !== personaCardsMtime) {
      personaCardsCache = JSON.parse(fs.readFileSync(f, 'utf8'));
      personaCardsMtime = st.mtimeMs;
    }
    return personaCardsCache?.cards || {};
  } catch { return {}; }
}

/**
 * ★★ 2026-10-16（用户拍板"丙"）：七位**共用**的说话红线（`personas.json` 顶层 `commonRule`）。
 *
 * 为什么放顶层、不写进 7 张卡里：改一次只改一处（写 7 遍必然各漂各的），
 * 而且 `_qcheck/companion-cards-probe.mjs` 要求 `cards` 里不能有多余 id。
 * ⚠️ 读不到（老文件 / 解析失败）⇒ 返回空串，`speakAs` 只用卡本身，**行为与从前一致**。
 */
function personaRule() {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'personas.json');
    const st = fs.statSync(f);
    if (!personaCardsCache || st.mtimeMs !== personaCardsMtime) {
      personaCardsCache = JSON.parse(fs.readFileSync(f, 'utf8'));
      personaCardsMtime = st.mtimeMs;
    }
    return String(personaCardsCache?.commonRule || '').trim();
  } catch { return ''; }
}

/**
 * 「借一副嘴」：让某位旅伴就某件事说一句自己的话。
 * @returns {Promise<string>} 一句话；**任何失败都返回空串**（调用方据此回落原转述）
 */
async function speakAs(companionId, scene) {
  try {
    const card = personaCards()[String(companionId || '').trim()];
    if (!card) return '';
    // ★★ 2026-10-16（用户拍板"丙"）：把七位**共用**的说话红线拼在卡后面 ——
    //   判据落在"模型真正收到的 system"上（卡 + 红线），而不是只写在文件里当注释。
    //   ⚠️ 读不到就只用卡本身，行为与从前一致（失败绝不因为她少了段禁则不回话）。
    const rule = personaRule();
    const system = rule ? `${card}\n\n${rule}` : card;
    const { chatCompletion } = await import('../../src/llm.js');
    const r = await chatCompletion({
      messages: [{ role: 'system', content: system }, { role: 'user', content: scene }],
      temperature: 0.9,
      // ⚠️ 预算不能给小：本机默认是**思考型**模型，给 200 会被 reasoning 吃光 ⇒ 返回空串
      //   （`refreshMemoryDigest` 与日记那边都有同一条教训）。
      maxTokens: 3000
    });
    let t = String(r?.message?.content || '').trim();
    t = t.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, 120) : '';        // 一句话，超长截断
  } catch (e) {
    log(`[travel-whale] 借嘴失败（${companionId}）：${e?.message ?? e} —— 回落原回执`);
    return '';
  }
}

/**
 * 把"她的话 + 机制说明"拼成一条回执（`said` 为空 ⇒ 用原来的转述口径）。
 *
 * ★★ 2026-10-14「署名」（用户口径，见 §114）：**那句台词必须带着署名原样发出去** ——
 *   原因：宿主落盘时（`src/sender.js` 的 `appendSelf`）一律记成 `self:true`/「我」，
 *   她本人和下游三个消费者（历史上下文／长期记忆日块／她的一天）都**区分不出这是伙伴说的**。
 *   署名是目前**唯一能穿透到存档**的办法（在宿主层加字段 ＝ 改核心，本轮不做）。
 *   ⚠️ 所以回执里**必须显式要求"原样发"** —— 实证：主群 18687 条 self 消息里，
 *      带「名字」：署名的只有 16 条、且**全是面板** ⇒ 模型默认会改写台词、丢掉署名。
 *   ⚠️ 机制细节（`tail`）**不能让伙伴说** —— 那是鲸鱼少女该向群友交代的，所以单列一行。
 */
function withLine(comp, said, fallbackLine, tail) {
  if (!said) return `${companionEmoji(comp)} ${fallbackLine} —— ${tail}`;
  const line = `${companionEmoji(comp)} 「${comp.name}」：${said}`;
  return `${line}\n\n`
    + `[上面这一行是「${comp.name}」**本人**说的话 —— 请把它**原样发出去**（连 ${companionEmoji(comp)} 和`
    + `「${comp.name}」：这个署名一起，一个字都别改），不要改写成"她答应了""她同意啦"这类转述，也不要替她往下接。]\n`
    + `[下面这些机制细节由**你自己**另起一条说，别塞进她的话里：${tail}]`;
}

// ── 留守的旅伴来评论（2026-10-14 用户口径，见 §115）─────────────────────────

/**
 * 明信片评论概率（配置 `commentChance`，默认 0.4；**0 ＝ 关**）。
 * ⚠️ 必须显式排除 `null`/`undefined`/`''` —— `Number(null) === 0` 会把它误判成"关闭"（§75 通则）。
 */
export function commentChanceOf(cfgObj = null) {
  const raw = (cfgObj || cfg())?.commentChance;
  if (raw === null || raw === undefined || raw === '') return 0.4;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.4;
}

/** 这一趟**出门在外**的旅伴 id（鲸鱼那趟看 `companion` + `party`，伙伴那趟看 `partners`）。 */
export function awayCompanionIds(tripLike) {
  const out = new Set();
  const push = (x) => { const s = String(x || '').trim(); if (s) out.add(s); };
  push(tripLike?.companion);
  for (const x of (Array.isArray(tripLike?.party) ? tripLike.party : [])) push(x);
  for (const x of (Array.isArray(tripLike?.partners) ? tripLike.partners : [])) push(x);
  return out;
}

/**
 * 随机挑一位**留守**的旅伴（已邀请 − 本趟同行）来评论这张明信片。
 * 没人留守 ⇒ `null`（例如只请了一位、而她正同行）。
 * 纯函数（只读 `state`/`tripLike`/`COMPANIONS`）⇒ 可离线单测。
 */
export function pickCommenter(state, tripLike, rand = Math.random, companions = null) {
  const table = companions || S.COMPANIONS || {};
  const away = awayCompanionIds(tripLike);
  const pool = ownedCompanionIds(state).filter((id) => !away.has(id) && table[id]);
  if (!pool.length) return null;
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/**
 * 给评论模型看的"这张明信片长什么样"。
 * ★★ **只有文字** —— 本机默认是纯文本模型，**看不到图**，所以地点/景点/特产/题字/感想都要写进场景。
 */
export function buildCommentScene(state, tripLike, entry, card, opts) {
  const whale = String(cfg().whaleName || '小鲸鱼');
  const place = placeLabel(tripLike);
  const isSide = tripLike?.side === true;
  const names = [];
  if (!isSide) names.push(whale);
  for (const pid of (Array.isArray(tripLike?.partners) ? tripLike.partners : [])) {
    const n = (S.COMPANIONS || {})[pid]?.name;
    if (n) names.push(n);
  }
  if (!names.length) names.push('她们');
  const spot = String(entry?.spot || '').trim();
  const scene = String(entry?.scene || '').trim();
  const where = spot || scene || '当地的风景';
  const souv = (Array.isArray(entry?.souvenirs) ? entry.souvenirs : [])
    .map((x) => (typeof x === 'string' ? x : String(x?.name || ''))).filter(Boolean);
  const caption = String(card?.caption || '').trim();
  const thought = String(card?.thought || '').trim();
  const lines = [
    `你留在庭院里，收到 ${names.join('、')} 从 ${place} 寄回来的一张明信片（这一趟你没跟着去）。`,
    `照片拍的是：${where}${spot && scene && scene !== spot ? `（${scene}）` : ''}。`
  ];
  if (souv.length) lines.push(`这趟带回来的特产：${souv.join('、')}。`);
  if (card?.rarity === 'rare') lines.push('这是一张稀有明信片。');
  if (opts?.isReturn) lines.push('这是她们到家时补发的那一张。');
  if (caption) lines.push(`她在照片上题了一句：「${caption}」`);
  if (thought) lines.push(`她自己的感想：${thought}`);
  lines.push('请用**你自己的口气**给这张明信片留一句评论（像在空间里给朋友留言那样）：'
    + '一到两句，口语，短；别复述整张明信片、别念设定、别客套（"祝你们愉快"这类）、别谢场。');
  return lines.join('\n');
}

/**
 * ★★ 2026-10-14「留守的旅伴来评论」：明信片发出后，按概率随机挑一位**这趟没同行**的旅伴，
 *   用她自己的口吻给这张卡留一句评论，发到群里。
 *
 * 为什么由**技能自己发**（而不是像邀请那样给主模型一条回执）：
 *   这条路是**后台 tick** 走的 —— **主模型不在场**（没有对话、没有工具回执可给）⇒ 只能自己发。
 *   ★ 附带好处：署名是**拼好的文本**、一定进存档 ⇒ 比 §114 路 A（靠模型自觉）**更可控**。
 *   ★ 沿用同一条署名口径（`emoji 「名字」：…`）—— 她读历史时能认出这句不是自己说的。
 *   ⚠️ 评论是**锦上添花**：任何一步失败都只记日志，绝不许影响明信片本身。
 * @returns {Promise<string>} 发出去的那一行（没发 ⇒ 空串）
 */
export async function commentOnPostcard(chatKey, state, tripLike, entry, card, opts, deps) {
  const rand = (typeof deps?.rand === 'function') ? deps.rand : Math.random;
  // ★★ 2026-10-14 设施 B（用户口径）：**数据标注车间里有人上班 ⇒ 评论概率抬高**。
  //   原话是"闲在家里没事干就刷动态" —— 坐在工位上的人，看明信片的次数就是更多。
  //   口径：+15%/人（`S.LABELROOM.commentBonusPerWorker`）、**封顶 90%**（留一点"这次没被评"的余地）。
  const roomBonus = (typeof S.labelroomCommentBonus === 'function') ? S.labelroomCommentBonus(state) : 0;
  const capRaw = Number(S.LABELROOM?.commentChanceCap);
  const cap = Number.isFinite(capRaw) ? capRaw : 0.9;
  const chance = Math.min(cap, commentChanceOf() + roomBonus);
  if (!(chance > 0)) return '';                    // 0 ⇒ 关
  if (rand() >= chance) return '';                 // 概率闸（基础约四成；车间有人时更高）
  const id = pickCommenter(state, tripLike, rand);
  if (!id) return '';                              // 没人留守（都出门了）
  const def = (S.COMPANIONS || {})[id];
  if (!def) return '';
  const said = await speakAs(id, buildCommentScene(state, tripLike, entry, card, opts));
  if (!said) return '';                            // 模型失败/空串 ⇒ 这一张就不评（不回落成转述）
  const line = `${companionEmoji(def)} 「${def.name}」：${said}`;
  await say(chatKey, line, opts);
  log(`[travel-whale] ${chatKey} 明信片评论（留守）：「${def.name}」`);
  return line;
}

/** 照片墙：合照门槛 8h → 6h（⚠️ 0 = 关闭，必须保持 0）。 */
function homeShotHoursOf(state, raw) {
  const v = Number(raw);
  if (!(v > 6)) return raw;                       // 0（关闭）/ 小于 6 / 非法值 ⇒ 原样
  return gardenLevel(state, 'photowall') > 0 ? 6 : raw;
}

/**
 * ★ 2026-10-13 旅伴「特色」的一段话（商店 / 帮助页共用）。
 *   **现读 COMPANIONS** ⇒ 改数值不用改文案。
 */
function companionTraitText(def) {
  if (!def) return '';
  const bits = [];
  const food = Math.max(1, Number(def.foodCostMult) || 1);
  if (food > 1) bits.push(`吃 ${food} 份`);
  const cardPct = Math.round(((Number(def.cardMult) || 1) - 1) * 100);
  if (cardPct) bits.push(`明信片 ${cardPct > 0 ? '+' : ''}${cardPct}%`);
  const rare = Number(def.rareMult) || 1;
  if (rare !== 1) bits.push(`稀有 ×${rare}`);
  if (Number(def.dailyTokens) > 0) bits.push(`每天 +${Number(def.dailyTokens)} 亿 TOKEN`);
  if (Number(def.departCost) > 0) bits.push(`每次出发扣 ${Number(def.departCost)} 亿 TOKEN（可扣成负数）`);
  if (Number(def.cardExtra) > 0) bits.push(`每趟多 ${Number(def.cardExtra)} 张`);
  // ★★ v3.2 两位新旅伴改绑特产之后的三个新字段（现读表 ⇒ 改数值不用改文案）
  //   ⚠️ 这两行**必须短**：商店正文是一整页发进群的 `replyPanel`，
  //     `panel-flood-probe` 盯着"商店正文 < 1200 字"（第一次加它们就顶到 1223 被探针抓到）。
  //     完整说明在帮助图的旅伴表里（那边另有「代价 / 收益」一列，不缺地方）。
  //   ⚠️ 这三句**与 `help.js` 的 `traitOf()` 必须逐字一致**（那边是说明图的表）——
  //     两边是各自独立的渲染模块（help.js 不能反向 import index.js，会成环），
  //     文案只能手工同步；探针 `souvenir-probe` 有一条跨文件守卫盯着这三句。
  if (def.noteSouvenirs) bits.push('新特产带她的批注');
  if (Number(def.harvestBonus) > 0) bits.push(`收成 +${Number(def.harvestBonus)} 份（她在庭院时）`);
  if (def.farmHelper) bits.push(`开菜地（永久 ${S.FARM.slots + S.FARM.helperSlots} 块；她在时种下的快 30%）`);
  if (def.longCaption) bits.push('题字更长');
  if (Number(def.flopChance) > 0) bits.push(`约 ${Math.round(Number(def.flopChance) * 100)}% 的明信片会翻车`);
  if (def.battleOnFiction) bits.push('异世界必惹事（多 1 张战斗明信片）');
  return bits.join('｜');
}

/** 谁在发津贴（**邀请过即可**，不要求同行）。现读 COMPANIONS。 */
function stipendPayers(state) {
  const skills = companionSkillOwned(state);
  return ownedCompanionIds(state)
    .map((id) => (S.COMPANIONS || {})[id])
    .filter(Boolean)
    .map((d) => {
      // ★★ 2026-10-13 旅伴养成「不请自来」：小狐狸练出来之后津贴 500 → 800（现读 COMPANIONS 的底数 + 加成）。
      //   返回的是**副本**，绝不改 `S.COMPANIONS` 本体（那是全进程共享的常量表）。
      const up = COMPANION_SKILLS.find((s) => s.id === 'gatecrash' && s.companion === d.id);
      const bonus = (up && skills[up.id]) ? Math.max(0, Math.floor(Number(up.bonusTokens) || 0)) : 0;
      return { ...d, dailyTokens: Math.max(0, Math.floor(Number(d.dailyTokens) || 0)) + bonus };
    })
    .filter((d) => d.dailyTokens > 0);
}

/**
 * ★★ 2026-10-13 旅伴「特色」：小狐狸的「免费鸡蛋」（每天一次，**在不在家都发**）。
 *
 * 为什么键是**本地日期串**而不是"距上次 24 小时"：用户说的是"每天发一份" ⇒ 按自然日算才符合直觉
 * （昨晚 23:50 领过、今早 00:10 就该再领一份）。
 * ⚠️ 读的是**兄弟模块** state.js 的字段 ⇒ 「新入口 + 旧 state.js」期间 `dailyTokens` 是 undefined
 *   ⇒ 返回 0、**静默不生效**（安全降级，不会报错、也不会重复发钱）。
 * @returns {number} 本次该发的 TOKEN（0 = 今天已发过 / 这位没有这个特色）
 */
function dueStipend(state, now = Date.now()) {
  // ★ 2026-10-13 用户口径（第二轮）：**只要邀请过就发** —— 不要求她此刻是同行的那位。
  //   （第一版要求"她是当前同行伙伴"；用户改成"邀请过就发"。）
  const amount = stipendPayers(state)
    .reduce((sum, d) => sum + Math.max(0, Math.floor(Number(d.dailyTokens) || 0)), 0);
  if (!amount) return 0;
  const today = (typeof E.dayKey === 'function') ? E.dayKey(now) : '';
  if (!today) return 0;
  if (String(state.lastStipendDay || '') === today) return 0;
  state.lastStipendDay = today;
  state.stipendsPaid = (Number(state.stipendsPaid) || 0) + 1;
  return amount;
}

/**
 * ★★ 2026-10-13 旅伴「特色」：往一趟计划里**追加一张卡**。
 *   · `battle:true`（默认）⇒ 小魔王的**战斗明信片**（强制战斗构图）；
 *   · `battle:false`     ⇒ 小书虫「话多」的普通额外卡。
 *
 * ⚠️⚠️ **头号风险 —— 序号对齐**：`cardPlan` 前 `cardTimes.length` 条是"途中卡"、
 *   **最后一条是到家卡**（`planCardContent` 就是这么排的，`sendReturnCard` 也只读最后一条）。
 *   所以必须**成对、同位**插入：`cardTimes` 追加到末尾；`cardPlan` 插在"到家卡**之前**"。
 *   插错位置 ⇒ `sendCard(index)` 会取到别的文案，甚至把到家卡当途中卡寄出去。
 *
 * @param {object} plan **原地修改**（cardTimes / cardPlan / cardCount）
 * @param {{rand?:Function, battle?:boolean}} [opts]
 * @returns {number} 新卡的出发时刻（0 = 没插）
 */
// ── ★★ 2026-10-13「随机事件真正影响心情」──────────────────────────────────
// 用户口径："我希望那些随机事件能真正'影响'她的心情，而不是现在的'因为在旅行所以心情一直很好'
//   —— 太一刀切了 —— 遇到好事心情上升，遇到坏事心情下降。"
//
// 设计：**单向写、各自读**。本技能只把"这趟真发生了什么"记进**自己的存档** `state.moodEvents`；
//   sleep-mood（它本来就读我们的存档）轮询取走新事件、结算成心情，**游标存在它自己那边** ——
//   于是我们不必去写别人的心情存档（跨包写别人的文件 = 迟早互相覆盖，这是本项目的铁律）。
//
// ⚠️ 只记**真的发生了**的事（寄出稀有的那张、真打起来的那张、真穿越了）—— 不记"可能发生"的。
const MOOD_EVENT_KINDS = {
  'rare-card': '寄回一张稀有的明信片',
  'battle-card': '在路上遭遇了敌手',           // 平手
  'battle-win': '在路上压退了敌手',             // 压制（v4.1）
  'battle-lose': '在路上吃了亏',               // 吃亏（v4.1）
  'event-good': '路上遇上了好事',               // v4.2 通用事件
  'event-bad': '路上遇上了麻烦事',               // v4.2 通用事件
  crossover: '被丢到了一个陌生的世界',
  'rare-souvenir': '带回了稀有特产',
  'trip-home': '平平安安回到了家',
  'home-photo': '在庭院里和大家拍了张大合照',
  flop: '这张明信片答非所问、翻了车',
  // ★★ 2026-10-14 特产出口（吃 / 送 / 种）—— 这是「特产不再是纯收藏品」的第一批事件。
  //   ⚠️ 加 kind **必须两边同时改**：这里 + sleep-mood 的 `lib/travel-sync.js` 的 `TRAVEL_EVENT_MOOD`。
  //     只改一边 = 事件写进了存档但**没人认**（sleep-mood 按表过滤，未知 kind 静默忽略）。
  'souvenir-eat': '把带回来的特产吃掉了',
  'souvenir-gift': '把带回来的特产送给了别人',
  'souvenir-plant': '把特产种进了菜地',
  'souvenir-harvest': '亲手种出了收成',
  // ★★ 2026-10-15「庭院活动也影响心情」：换活动落定时，带心情标注的条目推一条这个 kind
  //   （delta 随事件自带，见 refreshHomeAct）。⚠️ 加 kind 必须两边同时改（见上）。
  'home-act': '在庭院里做了一阵小事'
};

/** 这条事件是好事还是坏事（给日志/面板用；**真正的数值在 sleep-mood 那边**）。 */
const MOOD_EVENT_TONE = {
  'rare-card': 'good', 'rare-souvenir': 'good', 'trip-home': 'good', 'home-photo': 'good',
  'battle-card': 'bad', 'battle-win': 'good', 'battle-lose': 'bad', crossover: 'bad', flop: 'bad',
  'event-good': 'good', 'event-bad': 'bad',
  'souvenir-eat': 'good', 'souvenir-gift': 'good', 'souvenir-plant': 'good', 'souvenir-harvest': 'good'
};

/**
 * 记一条"影响心情的事件"。
 * ⚠️ **同一毫秒内可能连推两条**（一张卡既稀有又是遭遇战）⇒ id = `时间戳 + 自增序号`，
 *    不能只用时间戳（sleep-mood 那边按 (at, id) 去重，只用时间戳会漏掉一条）。
 */
function pushMoodEvent(state, kind, extra = {}) {
  const k = String(kind || '');
  if (!state || !k || !MOOD_EVENT_KINDS[k]) return null;
  const list = Array.isArray(state.moodEvents) ? state.moodEvents : (state.moodEvents = []);
  const now = Date.now();
  const seq = (Number(state.moodEventSeq) || 0) + 1;
  state.moodEventSeq = seq;
  const ev = { id: `me_${now.toString(36)}_${seq}`, at: now, kind: k, ...extra };
  list.push(ev);
  if (list.length > 60) list.splice(0, list.length - 60);   // 只留最近 60 条（存档别无限涨）

  // ★ 2026-10-25：入档的同时广播到 courtyard.bus。
  //   背景：plugins/sleep-mood 早就订阅了 'whale:trip.event' / 'whale:souvenir.eaten'
  //   （见它 index.js 的 bus.subscribe），但**此前没有任何发布方** —— 那条通道一直是死的，
  //   旅途事件得等 sleep-mood 下一轮 60s 心跳才结算成元气/心境。
  //
  //   ⚠️ 为什么要延到下一个宏任务：调用方是在 push 之后才 `S.saveState(state)`（同步写盘），
  //      而订阅方读的是**文件**。立刻 publish 会让它读到还没落盘的旧存档（白跑一趟）。
  //      setTimeout(0) 排在整个同步调用栈之后，正好落在 saveState 之后。
  //      万一某条路径是先 await 再存盘，订阅方也只会"这轮没看到"——它自己的 60s 轮询
  //      仍是兜底，事件不会丢（游标按 (at,id) 去重，重复交付无害）。
  try {
    const payload = {
      id: ev.id,
      at: ev.at,
      kind: k,
      tone: MOOD_EVENT_TONE[k] || '',
      where: String((extra && extra.where) || ''),
      foe: String((extra && extra.foe) || ''),
      n: Number((extra && extra.n) || 0),
      who: String((extra && extra.who) || '')
    };
    const topic = k === 'souvenir-eat' ? 'whale:souvenir.eaten' : 'whale:trip.event';
    setTimeout(() => {
      try { capability('courtyard.bus')?.publish?.(topic, payload); } catch { /* 总线不在就算了 */ }
    }, 0);
  } catch { /* 广播失败绝不能影响事件入档 */ }

  return ev;
}

/**
 * ★★ v4.1：这一趟**有没有遭遇**、以及**结果是什么**。
 *
 * 两次独立掷骰（用户特别问过这一点）：
 *   ① 有没有遇到：`ENCOUNTER_CHANCE`（异世界 0.55 / 现实 0）；
 *   ② 结果：基础 压制 0.40 / 平手 0.40 / 吃亏 0.20，再由**战斗技能**移动胜率。
 * 如果两次用同一个随机数，结果就会跟"抽到哪条构图"绑死 —— 那就成了"抽到必赢/必输"。
 *
 * 技能修正（只在事件里生效，面板上不显示"战力"）：
 *   · 浮游炮协同 `funnel`      +0.08 压制
 *   · 弹幕掉落 `danmaku-drop`  +0.05 压制
 *   · 数据护盾 `data-shield`   −0.08 吃亏
 *   · 幽灵特工 `ghost-agent`   −0.08 吃亏
 *   · 骨灰召唤 `ash-summon`    每趟一次：把"吃亏"改成"平手"
 * @returns {{outcome:'win'|'draw'|'lose', chance:number}|null}
 */
export function rollBattle(state, plan, rand = Math.random) {
  const foe = String(plan?.foe || '').trim();
  if (!foe) return null;                                   // 现实地区没有敌手
  if (rand() > 0.55) return null;                          // ① 有没有遇到
  const owned = skillOwned(state);
  let win = 0.40;
  let lose = 0.20;
  if (owned['funnel']) win += 0.08;
  if (owned['danmaku-drop']) win += 0.05;
  if (owned['data-shield']) lose -= 0.08;
  if (owned['ghost-agent']) lose -= 0.08;
  win = Math.min(0.75, Math.max(0.10, win));
  lose = Math.min(0.45, Math.max(0.05, lose));
  if (win + lose > 0.9) lose = Math.max(0.05, 0.9 - win);
  // ② 独立掷结果
  const r = rand();
  let outcome = r < win ? 'win' : (r < win + (1 - win - lose) ? 'draw' : 'lose');
  // 骨灰召唤：每趟挡掉一次吃亏
  if (outcome === 'lose' && owned['ash-summon']) outcome = 'draw';
  return { outcome, chance: Number(win.toFixed(2)) };
}

/**
 * ★★ 2026-10-18 v4.2「事件」：把 foe 那套抽象成通用事件 ——
 * **锁构图 / 告诉她发生了什么 / 影响心情 / 产生后果**。foe 只是其中一种（有对手的战斗），
 * 走自己的强度（0.55），事件默认整趟 0.28（约一半）。
 *
 * 与 foe 的差别（用户口径）：
 *   · foe：**一趟最多一次**，锁定一张卡；
 *   · 事件：**一趟可以多个** —— 每张途中卡独立掷，单卡概率 = `eventTripP / 途中卡数`，
 *     所以"出几个"会变，但"整趟至少出一个"的总概率稳定在 ~28%。
 * ⚠️ 已经有遭遇战的卡不再叠事件（一张卡只讲一件事）。
 */
const EVENTS_FILE = () => path.join(SELF_DIR, 'data', 'events.json');
let _events = null;
function loadEvents() {
  if (_events) return _events;
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_FILE(), 'utf8'));
    _events = Array.isArray(raw?.events) ? raw.events : [];
    _eventsP = Number(raw?.eventTripP) > 0 ? Number(raw.eventTripP) : 0.28;
  } catch (error) {
    log(`[travel-whale] 事件表读取失败（不启用）：${error?.message ?? error}`);
    _events = [];
  }
  return _events;
}
let _eventsP = 0.28;

// ── ★ 2026-10-19 v4.3「事件认属地」────────────────────────────────────────
// 症状：在【战锤40K·网道】这种走廊空间里抽到了「赶上节庆（街上挂满灯，摊子摆到路口）」。
// 原因：`eventsFor()` 只按 where(fiction/real) + phase 过滤，**完全不看这是个什么地方**。
// 解法：事件侧写 `places`（能发生在哪类地方），地区侧写 `placeTags`/`cityTags`（这是
//   哪类地方），两边**求交集**。词表只有 4 个词，故意做小：
//     settlement 聚居地/街道市集 · wild 野外自然 · corridor 通道/室内/封闭结构 · void 虚空/宇宙
// ★ 向后兼容是第一原则：
//   · 事件没有 `places`（旧数据）        ⇒ 任何地方都能抽；
//   · 国家没有 `placeTags`/`cityTags`（旧数据）⇒ **完全跳过属地过滤**，出事件概率一个不差；
//   · 地区/国家查不到（老旅程、脏数据）  ⇒ 同样跳过过滤，绝不抛错。
const PLACE_TAGS = ['settlement', 'wild', 'corridor', 'void'];

/** 属地表：Map<regionId, Map<国家名, { placeTags: string[], cityTags: Map<城市名, string[]> }>>。 */
let _placeIndex = null;
let _placeIndexWarned = false;

/** 归一化查表键：吃掉空白/零宽（regions.json 里存在"廷根 周边"这类拼接痕迹）。 */
function placeKeyOf(value) {
  return String(value ?? '').replace(/[\s\u200b\ufeff]/g, '');
}

/** 只保留 4 词表里的标签（写错的标签丢弃，不让它把事件池意外清空）。 */
function cleanPlaceTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const tag = String(item ?? '').trim();
    if (tag && PLACE_TAGS.includes(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 从 `cities` 里取城市名（兼容 `"布鲁姆"` 与 `{ name: "布鲁姆" }` 两种写法）。 */
function cityNameOf(city) {
  if (typeof city === 'string') return city;
  if (city && typeof city === 'object') return String(city.name ?? '');
  return '';
}

/**
 * 读 `regions.json` 的属地表（lazy + module 级缓存，73KB 表每趟都会用到，不能反复 parse）。
 *
 * ⚠️ **必须自己 `fs` 读盘，不能借用 `trip.js` 的 `loadRegions()`**（2026-10-21 实测踩过）：
 *   `trip.js:47` 的 `_regions` 是 **module 级缓存**，第一次读盘后再不刷新；
 *   而技能热重载只给**入口** `index.js` 加时间戳（`plugin-loader.js:849` 的 `import(entryUrl + '?t=')`），
 *   本文件里静态 `import ... from './trip.js'` 仍然命中 ESM 缓存里的**旧 trip.js 实例**
 *   ⇒ 它手里是"打补丁之前的 regions.json" ⇒ `placeTags` 永远读不到 ⇒ 过滤被静默跳过
 *   ⇒ 补丁等于没装（数据改了、代码改了、效果为零）。
 *   自己读盘就没事：`_placeIndex` 是**本模块**的缓存，模块随热重载整体重建，改表即生效，不用重启 App。
 *   ⚠️ 也不要"fs 失败再退 `T.loadRegions()`"——两个数据源混用会让"改了哪张表"变成谜，只留一条路。
 *
 * 读失败/解析失败：`log()` 一条（只报一次）并降级成空表（= 全部跳过属地过滤），绝不能让出发流程挂掉。
 */
function loadPlaceIndex() {
  if (_placeIndex) return _placeIndex;
  const index = new Map();
  try {
    // 惰性拼路径：SELF_DIR 声明在本文件更后面（TDZ），模块顶层不能直接引用它
    const parsed = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'data', 'regions.json'), 'utf8'));
    const regions = Array.isArray(parsed?.regions) ? parsed.regions : [];
    for (const region of Array.isArray(regions) ? regions : []) {
      const rid = String(region?.id ?? '');
      if (!rid) continue;
      const byName = new Map();
      for (const country of Array.isArray(region?.countries) ? region.countries : []) {
        const name = String(country?.name ?? '');
        if (!name) continue;
        const placeTags = cleanPlaceTags(country?.placeTags);
        const cityTags = new Map();
        const rawCityTags = country?.cityTags;
        if (rawCityTags && typeof rawCityTags === 'object' && !Array.isArray(rawCityTags)) {
          // 城市级覆盖：键盘上带空格/零宽的别名也收进来，查的时候两种键都试
          for (const cityName of Object.keys(rawCityTags)) {
            const tags = cleanPlaceTags(rawCityTags[cityName]);
            if (!tags.length) continue;
            cityTags.set(String(cityName), tags);
            cityTags.set(placeKeyOf(cityName), tags);
          }
          // 顺手把 `cities` 里同名的写法也登记上（"科摩罗" 与 " 科摩罗" 都能命中）
          for (const city of Array.isArray(country?.cities) ? country.cities : []) {
            const cityName = cityNameOf(city);
            const tags = cityTags.get(placeKeyOf(cityName));
            if (cityName && tags) cityTags.set(cityName, tags);
          }
        }
        if (!placeTags.length && !cityTags.size) continue;      // 没打标签 ⇒ 这个国家根本不参与属地过滤
        const entry = { placeTags, cityTags };
        byName.set(name, entry);
        byName.set(placeKeyOf(name), entry);
      }
      if (byName.size) index.set(rid, byName);
    }
  } catch (error) {
    if (!_placeIndexWarned) {
      _placeIndexWarned = true;
      log(`[travel-whale] 属地表读取失败（事件不按属地过滤）：${error?.message ?? error}`);
    }
    index.clear();                                            // 降级：空表 = 不过滤
  }
  _placeIndex = index;
  return _placeIndex;
}

/**
 * 这一趟的属地标签。返回 `[]` 表示**不按属地过滤**（旧数据/查不到/没打标签）。
 * `plan.city` 有 cityTags 覆盖时优先用城市级标签，否则退回国家级 `placeTags`。
 *
 * ★ 为什么要拿城市名当国家名再查一次：虚构地区允许**"条目自身就是目的地"**
 *   （`trip.js#allCitiesOf` → `{ city: '亚空间', country: '' }`，见那里的注释），
 *   这时 `plan.country` 是空串、`plan.city` 才是地区表里的那一条。
 *   不补这一层，「亚空间」这种没有下级地名的星球就永远查不到标签 ⇒ 属地过滤等于白装。
 */
function placeTagsFor(plan) {
  try {
    const rid = String(plan?.region ?? '');
    if (!rid) return [];
    const byName = loadPlaceIndex().get(rid);
    if (!byName) return [];
    const countryName = cityNameOf(plan?.country);
    const cityName = cityNameOf(plan?.city);
    // ① 正常情况：按「国家/星球」查
    let entry = countryName ? (byName.get(countryName) || byName.get(placeKeyOf(countryName))) : null;
    // ② 兜底：没有国家这一层时，把城市名当国家名再查（星球/据点级目的地）
    if (!entry && cityName) entry = byName.get(cityName) || byName.get(placeKeyOf(cityName));
    if (!entry) return [];
    // ③ 城市级覆盖：`cityTags` 命中就用它，没命中退回国家级 placeTags
    if (cityName && entry.cityTags.size) {
      const hit = entry.cityTags.get(cityName) || entry.cityTags.get(placeKeyOf(cityName));
      if (Array.isArray(hit) && hit.length) return hit;
    }
    return entry.placeTags;
  } catch (error) {
    log(`[travel-whale] 属地标签查表失败（本趟不按属地过滤）：${error?.message ?? error}`);
    return [];
  }
}

/** 这一趟能触发哪些事件（地区类型 + 相位 + 属地）。 */
function eventsFor(plan) {
  const list = loadEvents();
  if (!list.length) return [];
  const fic = plan?.regionFictional === true;
  const phaseName = String(plan?.phase?.name || '');
  // 属地标签：空数组 = 该国家没打标签（或查不到）⇒ 完全跳过属地过滤，老数据照旧
  const tags = placeTagsFor(plan);
  const pool = list.filter((e) => {
    if (e.where === 'fiction' && !fic) return false;
    if (e.where === 'real' && fic) return false;
    if (Array.isArray(e.phase) && e.phase.length && !e.phase.includes(phaseName)) return false;
    if (!tags.length) return true;                          // 没标签 ⇒ 通用，任何地方都能抽
    const places = Array.isArray(e.places) ? e.places : [];
    if (!places.length) return true;                        // 事件没写 places ⇒ 通用事件
    return places.some((p) => tags.includes(String(p)));
  });
  log(`[travel-whale] 事件池 ${pool.length}/${list.length} 条（place=${tags.join('+') || '不限'}）`);
  return pool;
}

/** 给每张途中卡独立掷一次（遭遇战那张不叠）。返回实际挂上去的事件数。 */
export function rollEvents(state, plan, rand = Math.random) {
  const pool = eventsFor(plan);
  const cards = Array.isArray(plan?.cardPlan) ? plan.cardPlan : [];
  const mid = Math.max(0, cards.length - 1);            // 末位是到家卡
  if (!pool.length || mid <= 0) return 0;
  const p = Math.max(0.02, Math.min(0.35, _eventsP / mid));
  let n = 0;
  for (let i = 0; i < mid; i += 1) {
    if (cards[i].battleOutcome) continue;               // 这张已经是遭遇战
    if (rand() > p) continue;
    const last = String(state?.lastEventId || '');
    const pickable = pool.length > 1 ? pool.filter((e) => e.id !== last) : pool;
    const ev = pickable[Math.floor(rand() * pickable.length)] || pool[0];
    cards[i].event = { id: ev.id, kind: ev.kind, name: ev.name, line: ev.line, fusion: ev.fusion, mood: ev.mood, effect: ev.effect };
    state.lastEventId = ev.id;
    n += 1;
  }
  return n;
}

function appendExtraCard(plan, opts = {}) {
  if (!plan) return 0;
  const times = Array.isArray(plan.cardTimes) ? plan.cardTimes : (plan.cardTimes = []);
  const cards = Array.isArray(plan.cardPlan) ? plan.cardPlan : (plan.cardPlan = []);
  const returnAt = Number(plan.returnAt) || 0;
  if (!returnAt || !cards.length) return 0;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;

  // 战斗卡必须**显式指定**成战斗构图 —— 否则 composePostcard 按全池随机，根本抽不中
  let fusion = '';
  if (opts.battle !== false) {
    const foe = String(plan.foe || '').trim();
    if (!foe) return 0;                                   // 不是异世界 ⇒ 不惹事
    // 「新入口 + 旧 postcard.js」时没有这个导出 ⇒ 静默跳过（安全降级，不让整个出发挂掉）
    if (typeof P.pickBattleFusion !== 'function') return 0;
    // ⚠️ 小魔王一定是**有人陪同**出门（她要么陪鲸鱼、要么跟另一位伙伴），所以固定用"两位少女"
    fusion = P.pickBattleFusion(rand, foe, plan.regionName || plan.region || '', plan.foeLook || '', true);
    if (!fusion) return 0;
  }

  const spots = Array.isArray(plan.spots) ? plan.spots : [];
  const lastSpot = spots.length ? String(spots[spots.length - 1]?.name || '') : '';
  const lastT = times.length ? Number(times[times.length - 1]) : (Number(plan.departAt) || returnAt - 3600000);
  // 排在"最后一张途中卡"与"到家卡"之间（偏后一点），保证时间递增、且不越过到家时刻
  // ★ 2026-10-13 晚：同一次出发可能**连着加卡**（小魔王的「挑衅」= 两张战斗明信片）——
  //   第二次按同一个公式算出来的时刻会越过到家时刻 ⇒ 卡会排在"到家之后"（时间倒挂）。
  //   钳住它，并保证时间**严格递增**（插卡口径见 MEMORY-2 §66）。
  const rawAt = Math.round(lastT + Math.max(60000, (returnAt - lastT) * 0.6));
  const at = Math.max(lastT + 1000, Math.min(rawAt, Math.round(returnAt - 60000)));
  if (at >= returnAt) return 0;
  times.push(at);
  const entry = { at, kind: 'spot', spot: lastSpot, scene: '', isReturn: false, rarity: 'common' };
  if (fusion) { entry.fusion = fusion; entry.rage = true; }
  cards.splice(cards.length - 1, 0, entry);               // ★ 插在"到家卡"之前
  plan.cardCount = times.length;
  return at;
}

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
const SKILLS = [
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
const COMPANION_SKILLS = [
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
const SKILL_SOUVENIR_RARE_CHANCE = 0.5;

const skillOwned = (st) => (st?.whale?.skills && typeof st.whale.skills === 'object' ? st.whale.skills : {});

/** 她本人去过哪些世界（`visitedCities` 的 region 去重）。 */
const skillVisitedRegions = (st) => new Set(Object.values(st?.visitedCities || {})
  .map((v) => String(v?.region || '')).filter(Boolean));

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
function souvenirWorlds(st) {
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
    const o = out[reg] || (out[reg] = { any: false, rare: false, pick: null });
    o.any = true;
    if (String(s?.rarity || '') === 'rare') o.rare = true;
    const cur = o.pick;
    if (!cur
      || rankOf(s) < rankOf(cur)
      || (rankOf(s) === rankOf(cur) && S.souvenirStock(s) > S.souvenirStock(cur))) {
      o.pick = s;
    }
  }
  return out;
}

const regionNameOf = (id) => { try { return T.regionById(String(id))?.name || String(id); } catch { return String(id); } };

/** 能不能学 ⇒ {ok, reason}。 */
function skillGate(st, sk) {
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
function learnSkill(st, sk) {
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
const companionSkillOwned = (st) => (st?.whale?.companionSkills
  && typeof st.whale.companionSkills === 'object' ? st.whale.companionSkills : {});

/** 这位旅伴**陪她去过**的异世界（regionId 数组；没有 ⇒ 空数组）。 */
const companionWorldsOf = (st, id) => {
  const all = st?.whale?.companionWorlds;
  const list = all && typeof all === 'object' ? all[String(id)] : null;
  return Array.isArray(list) ? list.map(String) : [];
};

/** 这个技能学会了没有（id 或 skill 对象都能传；**热载安全**）。 */
const companionHas = (st, idOrSkill) => {
  const id = String((idOrSkill && typeof idOrSkill === 'object') ? idOrSkill.id : idOrSkill || '');
  return Boolean(id) && Boolean(companionSkillOwned(st)[id]);
};

/** 能不能学这位旅伴的技能 ⇒ {ok, reason}。 */
function companionSkillGate(st, sk) {
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

function learnCompanionSkill(st, sk) {
  const g = companionSkillGate(st, sk);
  if (!g.ok) return g;
  st.wallet.plankton = (Number(st.wallet?.plankton) || 0) - sk.price;
  st.whale = st.whale || {};
  st.whale.companionSkills = { ...companionSkillOwned(st), [sk.id]: { at: Date.now() } };
  return { ok: true, reason: `学会了「${sk.name}」` };
}

/** 同行伙伴的"感言"（目前只有小白龙的「龙语」）。不是她那趟 ⇒ ''（旧 postcard.js 会忽略这个字段）。 */
function companionNoteFor(state, tripLike) {
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
const FUSION_EXTRA = {
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
function skillFusionText(sk, tripLike, rand) {
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
function pickSkillFlavor(st, tripLike, { rand = Math.random } = {}) {
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
function syncSkillNumbers(state) {
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

function applySkillNumerics(state, plan, d) {
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
const ownedCompanionIds = (st) => (typeof S.ownedCompanionIds === 'function'
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
function helpDataFor(st) {
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
function appointCompanion(st, comp, now = Date.now()) {
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
const pendingCompanionOf = (st) => {
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
const appointWaitTail = (r) => (r?.why === 'target-away'
  ? `不过「${r.name || '她'}」这会儿自己跑出去玩了，得等她回来才能换。`
  : '不过小鲸鱼这会儿还在外面旅行，得等这趟回来才能换人。');

/**
 * ★ 面板里那行"说好了但还没生效"的**人话版**（商店 / 看庭院 / 换伙伴 三处共用）。
 * 与 `appointWaitTail` 同源同判据，只是面板上不用对话口吻、要说清"等谁"。
 */
function pendingReasonText(st) {
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
/**
 * ★★ 2026-10-18 v3.21「世界状态」（试点：只配了泰拉）
 *
 * 病：同一个地方去十次，看到的是同一座金墙 —— 世界是静态的。
 * 药：每个 `region|组` 有若干 phase（朝圣季 / 戒严 / 圣灰雨…），**每 7 天自动切下一档**，
 *   出发时把当时那一档写进 `trip.phase`，整趟沿用。它给三样东西：
 *     · `brief`  → 明信片里多一行「局势：…」；
 *     · `tone`   → **覆盖该趟的地区影调**（比地区固定影调更准）；
 *     · `avoid`  → 一起覆盖否定项。
 * ⚠️ `data/world-phases.json` 里**没写的地区 = 这套机制不存在**，行为与从前逐字一致。
 * ⚠️ 轮换状态存 `state.worlds[key] = {id, at}`；`at` 超过 7 天就切下一档（按 phases 顺序循环）。
 */
const PHASE_ROTATE_MS = 7 * 24 * 3600 * 1000;
let worldPhasesCache = null;

function loadWorldPhases() {
  if (worldPhasesCache) return worldPhasesCache;
  try {
    // 惰性拼路径：SELF_DIR 声明在本文件更后面（TDZ），模块顶层不能直接引用它
    const raw = JSON.parse(fs.readFileSync(path.join(SELF_DIR, 'data', 'world-phases.json'), 'utf8'));
    worldPhasesCache = raw && typeof raw.regions === 'object' ? raw.regions : {};
  } catch (error) {
    log(`[travel-whale] 世界状态表读取失败（不启用）：${error?.message ?? error}`);
    worldPhasesCache = {};
  }
  return worldPhasesCache;
}

/** 当前这一组处于哪个 phase（会顺手推进轮换；改的是 state，落盘交给调用方）。 */
export function currentPhase(state, regionId, group, now = Date.now()) {
  const table = loadWorldPhases();
  const key = `${regionId}|${group}`;
  const entry = table[key] || table[`${regionId}|*`];
  if (!entry || !Array.isArray(entry.phases) || !entry.phases.length) return null;
  const list = entry.phases;
  if (!state.worlds || typeof state.worlds !== 'object') state.worlds = {};
  const cur = state.worlds[key];
  let idx = 0;
  if (cur && cur.id) {
    const at = list.findIndex((p) => p.id === cur.id);
    if (at >= 0) idx = (now - (Number(cur.at) || 0) > PHASE_ROTATE_MS) ? (at + 1) % list.length : at;
  }
  const p = list[idx];
  state.worlds[key] = { id: p.id, at: idx === (cur ? list.findIndex((x) => x.id === cur.id) : -1) ? (Number(cur?.at) || now) : now };
  return p;
}

function restRange() {
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const c = cfg() || {};
  const out = {};
  const minH = num(c.restHoursMin);
  const maxH = num(c.restHoursMax);
  if (Number.isFinite(minH) && minH > 0) out.minMs = minH * 3600 * 1000;
  if (Number.isFinite(maxH) && maxH > 0) out.maxMs = maxH * 3600 * 1000;
  return out;
}

/**
 * 此刻在途的**闲置伙伴那几趟**（数组）。
 *
 * ★ 2026-10-14 多趟化：`state.sideTrip`（单对象）→ `state.sideTrips`（数组）。
 *   老存档的迁移在 `state.js` 的 `loadState()` 里做（搬进数组并删掉老键），
 *   所以这里只管读；兼容期也顺手认一下老字段，免得"新入口 + 旧 state.js"那段热载窗口里
 *   已经把伙伴派出去的那趟**凭空消失**。
 */
function sideTripsOf(state) {
  const list = Array.isArray(state?.sideTrips) ? state.sideTrips : [];
  const legacy = (state?.sideTrip && typeof state.sideTrip === 'object' && !Array.isArray(state.sideTrip))
    ? [state.sideTrip] : [];
  return [...list, ...legacy].filter((t) => t && typeof t === 'object');
}

/**
 * ★★ 2026-10-15：某位旅伴此刻是不是正**自己跑出去玩**（在 `sideTrips` 里）。返回那趟或 `null`。
 * 纯函数、只读。
 *
 * ★ 与"她本人（鲸鱼少女）在不在家"是**两件事** —— 后者看 `state.trip`，别混用：
 *   本函数的用途是"**这一位**能不能马上陪她出门"。
 * 用在三处，都是出发/换人前的闸：
 *   · `appointCompanion` —— 要换的那位不在家 ⇒ 换不了，先记"说好了"（用户 10-15 口径）；
 *   · `tick()` 的**领头发车检查** —— 领头还没回家就先别出门（避免一个人同时在两趟旅行里）；
 *   · `whale_status` —— 如实注明"这位自己出去玩了、还没回来"。
 */
function awaySideTripOf(state, id) {
  const want = String(id || '').trim();
  if (!want) return null;
  return sideTripsOf(state).find((t) => (Array.isArray(t.partners) ? t.partners : [])
    .map(String).includes(want)) || null;
}

/**
 * 把老字段 `sideTrip`（单对象）**就地**搬进 `sideTrips[]`，并删掉老键。
 *
 * 为什么要有它：`loadState()` 已经做过一次迁移，但"新入口 + 旧 state.js"那段热载窗口里
 * 读到的存档仍可能是老形状。**所有写路径（出发 / 结算 / tick 推进）都要先过它** ——
 * 否则"从数组里删掉这一趟"会删了个寂寞（那趟还挂在 `state.sideTrip` 上，永远回不了家）。
 * @returns {object[]} 归一化后的数组（引用，可直接 push/splice）
 */
function normalizeSideTrips(state) {
  if (!state || typeof state !== 'object') return [];
  if (!Array.isArray(state.sideTrips)) state.sideTrips = [];
  const legacy = state.sideTrip;
  if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) state.sideTrips.push(legacy);
  if ('sideTrip' in state) delete state.sideTrip;
  return state.sideTrips;
}

/**
 * 此刻**已经在某趟旅行里**的伙伴 id 集合（鲸鱼那趟 + 闲置伙伴**每一趟**）。
 *
 * 为什么必须有它：`idleCompanions`（state.js）只排除"当前 live 的 companion"那一位。
 * 正常口径下 live == 鲸鱼这趟的同伴（见 `appointCompanion`），所以本来就对；
 * 但「闲置伙伴自己出去玩」各趟的 `partners`**不在它的视野里** —— 一旦谁在半路改了 live，
 * 就会出现"同一个人同时出现在两趟旅行里"。
 * ★ 多趟化之后这句更要紧：**每一趟都要收进来**，否则两趟会挑到同一个人。
 */
function busyCompanionIds(state) {
  const out = new Set();
  const add = (x) => {
    const s = String((x && typeof x === 'object') ? (x.id ?? '') : (x ?? '')).trim();
    if (s) out.add(s);
  };
  // ★ 2026-10-15 修（设施 A 带出来的真 bug）：这里原来**只收 `trip.companion`（领头那一位）**。
  //   设施 A 之后一趟可能带 3~4 位同行 ⇒ 另外几位不在集合里 ⇒ 会被 `sideTrips` 再抽走，
  //   同一个人同时出现在两趟旅行里。`state.companions` 才是"这一趟同行的全部"。
  if (state?.trip) {
    add(state.trip.companion);
    for (const c of (Array.isArray(state?.companions) ? state.companions : [])) add(c);
  }
  for (const t of sideTripsOf(state)) {
    for (const id of (Array.isArray(t.partners) ? t.partners : [])) out.add(String(id));
  }
  // ★★ 2026-10-14 设施 B「数据标注车间」（**用户口径**）：**在车间上工的人也算"忙"** ——
  //   她们在上班，不会偷跑出去旅游。
  //   ★ 接在这里而不是去改 `pickSideParty` 的调用点：`idle`（3100 行）本来就是按这个集合
  //     过滤出来的 ⇒ **一处生效**，将来别处再按"谁有空"选人时也自动正确。
  //   ⚠️ `typeof` 包装：`state.js` 是**兄弟模块**，热载窗口里可能是"新 index + 旧 state"
  //     ⇒ 那时新函数不存在，退回旧行为（不裸调、不 TypeError）。
  if (typeof S.labelroomWorkers === 'function') {
    for (const w of S.labelroomWorkers(state)) {
      const id = String(w?.id || '').trim();
      if (id) out.add(id);
    }
  }
  return out;
}

/**
 * 这一趟是谁在途（`sendCard` / 结算都要按趟操作，不能再靠"全局只有一趟"）。
 * @param {'trip'} which 或直接传**趟对象**（多趟化后的常规用法）
 */
function tripRefOf(state, which) {
  if (which && typeof which === 'object') return which;      // 常规用法：直接传趟对象
  if (which === 'side') return sideTripsOf(state)[0] || null; // 兼容旧的 'side'（原来只有一趟）
  return state?.trip || null;
}

/**
 * 目的地的**展示名**：有国家/星系就"国家·城市"，没有就只显示城市。
 *
 * ★ 2026-10-11 异世界：星球级目的地（「神圣泰拉」「亚空间」）**没有国家层**，
 *   `country` 是空字符串 —— 老的 `${country}·${city}` 拼法会渲染出
 *   「·神圣泰拉」这种带前导点的怪名字。所以**所有给人看的地方都走这里**。
 *   ⚠️ 别和 `state.js` 的 `cityKey()` 搞混：那个是**存档键**，这个是**给人看的**。
 */
const placeLabel = (o) => [o?.country, o?.city].filter(Boolean).join('·') || String(o?.city || '');

/**
 * 这个地区**现在能不能去**。
 *
 * 两条任一成立即算解锁：
 *   ① `region.defaultUnlocked === true` —— 数据层声明"人人可去"
 *      （2026-10-11 用户要求：现实世界的 9 个地区全部默认解锁，不必逐个花 2000 亿 TOKEN 买）
 *   ② 存档 `whale.equipUnlocked` 里有它 —— 花 TOKEN 买过的
 *
 * ⚠️ **光改 regions.json 是没用的**：`equipUnlocked` 的初值硬编码在 state.js 的
 *    `emptyState()` 里（`['asia']`），而商店的「未解锁装备」和 `whale_equip` 的
 *    可选清单**全按它筛**。判定必须统一收到这一个函数里，否则会出现
 *    "商店说已经解锁、装备列表却找不到这件装备"的自相矛盾。
 */
const isRegionUnlocked = (st, region) =>
  Boolean(region?.defaultUnlocked) || (st?.whale?.equipUnlocked || []).includes(region?.id);

/**
 * ★★ 2026-10-15「探索解锁」——**一个地区"她已经知道"了吗**
 * （= 能不能出现在装备表 / 技能树 / 技能列表 / 衣柜里）。三条任一成立：
 *   ① **已解锁**（`isRegionUnlocked`：默认那 9 件 ∪ 买过的）—— 拥有的当然知道；
 *   ② **已发现**（`state.whale.equipBuyable`）—— 穿越时解锁的那 3 个
 *      （其中 2 个是**还没去过**的世界，属于"预告"，用户拍板要保留）；
 *   ③ **她本人去过**（`visitedCities` 的 region）。
 *
 * ⚠️⚠️ ③ **绝对不能漏**（2026-10-15 用户口径："技能和衣柜在初期应该直接不解锁，
 *   在**去过至少一个异世界**之后才解锁，而且**仅解锁能看到的世界**的那部分"）。
 *   因为**正常出行不走 `unlockEquipBuyables()`**（只有"穿越"才调它）⇒
 *   她自己挑着去的那个世界只存在于 ③ 里；少了 ③ 就会变成
 *   "她明明去过提瓦特、技能表却装作没有提瓦特"，而且**越正常玩越严重**。
 *
 * ⚠️ `isEquipBuyable` 是 `state.js` 的**新导出** ⇒ 必须 `typeof` 包装
 *   （热载窗口里旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致、不崩）。
 * ⚠️ 老档兼容（`loadState` 把 `equipBuyable` 补成"全部异世界"）⇒ 老玩家看到的**一件都不会少**。
 * ⚠️ 这张表只作**展示层**判据：能不能学/能不能买另有各自主线的门槛
 *   （`skillGate` 要求**真的去过那个世界**、服装要求**去过那个子区域**）
 *   —— 这里放宽**不会**让人凭空学会或买到任何东西。
 */
const isRegionVisible = (st, region) => {
  if (!region) return false;
  if (isRegionUnlocked(st, region)) return true;
  if (typeof S.isEquipBuyable === 'function' && S.isEquipBuyable(st, region)) return true;
  return skillVisitedRegions(st).has(String(region.id));
};

/** 可见地区 id 名单（`helpDataFor` / 商店 / 技能表 / 衣柜共用）。读不到地区表 ⇒ `null` = 不设闸。 */
function visibleRegionIds(st) {
  try { return T.loadRegions().filter((r) => isRegionVisible(st, r)).map((r) => r.id); }
  catch { return null; }
}

/**
 * 技能树里**她"知道有这回事"**的那些条（技能表 / `whale_skill` 列表都按它筛）。
 *
 * ★ SKILLS 的 30 条 region **全在 15 个异世界**里（每个世界 2 条，没有现实的技能）
 *   ⇒ 新档（`equipBuyable=[]`、没去过任何异世界）筛完就是**空数组** ⇒
 *   **技能树天然"未解锁"**，正好落在用户说的"初期直接不解锁"上，不需要再写一道总闸。
 * ⚠️ 读不到地区表 ⇒ 返回全量（与从前一致，别因为读表失败就把技能树清空）。
 */
function visibleSkills(st) {
  const vis = visibleRegionIds(st);
  if (!vis) return SKILLS;
  const set = new Set(vis.map(String));
  return SKILLS.filter((sk) => set.has(String(sk.region)));
}

/**
 * ★★ 2026-10-19（用户口径）：**自动出门不再受装备限制** —— 在"已解锁"的地区里随机挑一个，
 * 想去哪去哪。装备从此只表示"买过这件 ⇒ 那个地区解锁了"，不再决定目的地。
 * ⚠️ 点名目的地仍然走 `regionOfEquipped()` 那条老路（群友说"去杭州"时由 city/country 决定）。
 */
/** 已解锁的地区列表（自动出门与"让她自己挑"共用同一口径）。导出只为探针能断言。 */
export function unlockedRegions(state) {
  try {
    const ids = new Set(Array.isArray(state?.whale?.equipUnlocked) ? state.whale.equipUnlocked.map(String) : []);
    const list = T.loadRegions().filter((r) => ids.has(String(r.id)) || r.defaultUnlocked === true);
    return list.length ? list : [T.regionById('asia')].filter(Boolean);
  } catch (error) {
    log(`[travel-whale] 取已解锁地区失败，退回亚洲：${error?.message ?? error}`);
    return [T.regionById('asia')].filter(Boolean);
  }
}

function randomUnlockedRegion(state, rand = Math.random) {
  const list = unlockedRegions(state);
  if (!list.length) return T.regionById('asia');
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

/** 用哪件装备决定的地区 → 对应大洲/大洋。没装备就退回亚洲（默认解锁）。 */
function regionOfEquipped(state) {
  const eq = String(state?.whale?.equipped ?? '').trim();
  try {
    if (eq) {
      const hit = T.loadRegions().find((r) => r.equipment === eq);
      if (hit) return hit;
    }
    return T.regionById('asia');
  } catch (error) {
    log(`[travel-whale] 地区表读取失败：${error?.message ?? error}`);
    return null;
  }
}

// ── 与「世界与事件」(life-system) 的联动（2026-10-12 用户需求）─────────────
//
// 目标：让她**知道"自己旅行到的世界是什么样"** —— 不是往提示词里塞一套固定世界观，
//   而是「她人在哪，世界设定就是哪」；回到家就不再注入任何异世界设定。
//
// 为什么这么接（这条最关键）：
//   life-system 的 `promptSections()` **每轮现读** `cfg().worldbook`，而它的 cfg 就是
//   `skillManager.settingsOf('life-system')` → `config.skills['life-system']`（**内存对象**）。
//   所以这里只要改内存里那个键，**她下一句话就在新世界里** —— 不用重启、不用起 HTTP。
//   ⚠️ 直接改 `data/config.json` 文件是**没用的**（宿主内存里的旧对象一写盘就盖回去）。
//
// 节奏：在 tick 里**幂等**同步 —— 世界没变就什么都不做（避免每个 tick 都动全局配置）。
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORLD_BOOKS_FILE = path.join(SELF_DIR, 'data', 'worldbooks.json');
/** 目标技能 id（用清单里的 id，不是目录名）。 */
const LIFE_SYSTEM_ID = 'life-system';
let worldBooksCache = null;
/** 上一次同步过去的 worldbook —— 内容相同就不重复写。 */
let lastWorldbook = null;

/** 读世界速写表（85 个异世界地点 → 一段速写），进程内缓存。 */
function loadWorldBooks() {
  if (worldBooksCache) return worldBooksCache;
  try {
    const raw = JSON.parse(fs.readFileSync(WORLD_BOOKS_FILE, 'utf8'));
    worldBooksCache = raw && typeof raw.worlds === 'object' ? raw.worlds : {};
  } catch (error) {
    log(`[travel-whale] 世界速写表读取失败（联动会静默跳过）：${error?.message ?? error}`);
    worldBooksCache = {};
  }
  return worldBooksCache;
}

/**
 * 由当前旅程算出该给她的世界设定文本；不在途（或查不到）返回空串。
 *
 * ⚠️ 键的拼法必须与 worldbooks.json 一致：`<regionId>|<组名>`。
 *   组名取 `country || city` —— 因为**异世界的目的地是"组名当 city、country 为空"**
 *   （trip.js 的 flatten 分支：星球级 / 大区级地点根本没有"国家"这一层）。
 */
export function worldbookForTrip(trip) {
  if (!trip) return '';
  const group = String(trip.country || trip.city || '').trim();
  if (!group) return '';
  const books = loadWorldBooks();
  let regionId = String(trip.regionId || '').trim();
  let book = regionId ? books[`${regionId}|${group}`] : '';
  // ★ 兜底：**升级前出发的老旅程没有 regionId**（这个字段 2026-10-12 才加），
  //   直接查不到就白联动了。按组名反查一次 —— 只有**唯一命中**才采用，
  //   因为组名会重（"谷地"同时出现在维斯特洛与费伦），歧义时宁可不动。
  if (!book) {
    const hits = Object.keys(books).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) {
      book = books[hits[0]];
      regionId = hits[0].slice(0, hits[0].indexOf('|'));
    }
  }
  if (!book) return '';
  let regionName = regionId;
  try { regionName = T.regionById(regionId)?.name || regionId; } catch { /* 取不到名字就用 id */ }
  return `她此刻人在【${regionName} · ${group}】旅行。${book}`;
}

/**
 * ★★ 2026-10-18「绘图的 GPT 不知道那是哪儿」（用户抓到的真问题）。
 *
 * `worldbooks.json` 是**叙事**（"信仰比空气更实在"），只喂给 life-system 让她说话；
 * 生图那边一条都没拿到，于是泰拉被画成"明亮的白色尖塔 + 云海"。
 * 这份 `visual-briefs.json` 是同一批地点的**纯视觉**改写（主色/材质/光线/天气/人群），
 * 专门拼进生图提示词的「世界」行。
 *
 * 取值优先级：`regionId|组名` → `regionId|*` → ''（取不到就不加这一行，绝不瞎补）。
 * ⚠️ 键的拼法与 `worldbooks.json` 完全一致，解析逻辑也照抄（含老旅程没有 regionId 的反查）。
 */
const VISUAL_BRIEFS_FILE = path.join(SELF_DIR, 'data', 'visual-briefs.json');
let visualBriefsCache = null;
function loadVisualBriefs() {
  if (visualBriefsCache) return visualBriefsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(VISUAL_BRIEFS_FILE, 'utf8'));
    visualBriefsCache = raw && typeof raw.briefs === 'object' ? raw.briefs : {};
  } catch (error) {
    log(`[travel-whale] 视觉速写表读取失败（配图会少一行世界基调）：${error?.message ?? error}`);
    visualBriefsCache = {};
  }
  return visualBriefsCache;
}

/**
 * ★★ 2026-10-18：影调（有多亮、光从哪来、有多脏）。取值与回退规则同 `visualBriefForTrip`。
 * 返回 `{ tone, avoid }`；查不到返回空串字段（调用方据此不加这一行）。
 */
const TONES_FILE = path.join(SELF_DIR, 'data', 'tone-briefs.json');
let tonesCache = null;
function loadTones() {
  if (tonesCache) return tonesCache;
  try {
    const raw = JSON.parse(fs.readFileSync(TONES_FILE, 'utf8'));
    tonesCache = raw && typeof raw.tones === 'object' ? raw.tones : {};
  } catch (error) {
    log(`[travel-whale] 影调表读取失败（配图少一行明暗约束）：${error?.message ?? error}`);
    tonesCache = {};
  }
  return tonesCache;
}

export function toneForTrip(trip) {
  const empty = { tone: '', toneAvoid: '' };  // 字段名与 composePostcard 对齐
  if (!trip) return empty;
  const group = String(trip.country || trip.city || '').trim();
  const tones = loadTones();
  let regionId = String(trip.regionId || '').trim();
  const pick = (k) => {
    const v = tones[k];
    return v && typeof v === 'object' ? { tone: String(v.tone || '').trim(), toneAvoid: String(v.avoid || '').trim() } : empty;
  };
  if (regionId && group) {
    const hit = pick(`${regionId}|${group}`);
    if (hit.tone) return hit;
  }
  if (!regionId && group) {
    const hits = Object.keys(tones).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) return pick(hits[0]);
  }
  if (regionId) return pick(`${regionId}|*`);
  return empty;
}

/** 由当前旅程算出该给**配图**用的纯视觉速写；不在途（或查不到）返回空串。 */
export function visualBriefForTrip(trip) {
  if (!trip) return '';
  const group = String(trip.country || trip.city || '').trim();
  if (!group) return '';
  const briefs = loadVisualBriefs();
  let regionId = String(trip.regionId || '').trim();
  let brief = regionId ? briefs[`${regionId}|${group}`] : '';
  if (!brief && !regionId) {
    // 老旅程没有 regionId：按组名反查（只有唯一命中才用 —— 组名会重，"谷地"两边都有）
    const hits = Object.keys(briefs).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) {
      brief = briefs[hits[0]];
      regionId = hits[0].slice(0, hits[0].indexOf('|'));
    }
  }
  if (!brief && regionId) brief = briefs[`${regionId}|*`] || '';
  if (!brief) {
    // 放到最后：regionId 对但组名对不上时，也退回该地区的兜底基调
    const hits = Object.keys(briefs).filter((k) => k.slice(k.indexOf('|') + 1) === group);
    if (hits.length === 1) brief = briefs[hits[0]];
  }
  return String(brief || '').trim();
}

/**
 * ★★ 2026-10-13：她**在庭院里**时，院子里还有谁（＝邀请过的全部，减去没在家的）。
 *   有任一趟在外时不算（调用方已挡）。
 */
function homeMateIds(state) {
  return ownedCompanionIds(state).map((id) => String(id));
}

/**
 * ★★ 2026-10-13：刷新"此刻她在庭院里做什么"（`state.homeAct`）。
 *
 * 为什么由**本技能**算、并**写进自己的存档**：它要同时喂两个集成系统 ——
 *   · sleep-mood（只读我们的存档，老契约不变）⇒ 面板 + 提示词；
 *   · life-system（世界与事件）⇒ 走 `syncWorldbook` 进 `worldbook`。
 * 若让两边各算一份，就会出现"面板说在烤火、世界书说在打牌"。**单一真源**。
 *
 * 幂等：同一挡（20 分钟）+ 同一批伙伴 ⇒ 什么都不做（不必每个 tick 都写盘）。
 * @returns {boolean} 有没有变化（调用方据此决定 dirty）
 */
/**
 * 「在家的瞬间」流水保留天数。
 * 素材只服务"写日记"（筛完的**回忆**才是长期资产，那本在 qqzone 那边）；
 * 所以留两周足够，别让存档无限涨。
 */
const HOME_LOG_KEEP_DAYS = 14;

function refreshHomeAct(state, now = Date.now()) {
  if (state.trip || sideTripsOf(state).length) return false;   // 有人在外面 ⇒ 不算"人在庭院"
  const mateIds = homeMateIds(state);
  const mateNames = mateIds.map((id) => (S.COMPANIONS || {})[id]?.name || id).filter(Boolean);
  // ★ 2026-10-14：**按旅伴绑定的庭院事件**（`mateId`）要靠 id 匹配 ⇒ 把 id+名字一起传下去。
  const mates = mateIds.map((id, i) => ({ id, name: mateNames[i] || id })).filter((m) => m.name);
  const bucket = (typeof HM.homeBucketOf === 'function') ? HM.homeBucketOf(now) : 0;
  // ★ 檐廊等级：必须**在幂等判定之前**取（下面那句会读它；`const` 有 TDZ，
  //   写在后面会直接抛 `Cannot access 'eaves' before initialization` —— 探针抓到过）。
  const eaves = gardenLevel(state, 'eaves');
  const cur = state.homeAct;
  if (cur && Number(cur.bucket) === bucket
    // ★ 键与下面写盘时**必须逐字一致**（这里是"变了没有"的判据，写歪了就会每 tick 都重抽）
    && String(cur.mateKey || '') === `${mateIds.join(',')}|eaves:${eaves}|farm:${state.farmUnlocked === true ? 1 : 0}`) {
    return false;                                              // 同一挡 + 同批人 + 同檐廊 + 同菜地 ⇒ 不变
  }
  const picked = (typeof HM.pickHomeAct === 'function')
    ? HM.pickHomeAct({
      chatKey: state.chatKey,
      homeSince: state.homeSince,
      mates,                                   // ★ 带 id（`mateId` 条目要用）
      mateNames,                               // 老口径留着（万一有别的调用方）
      homeName: HM.HOME_NAME,
      eaves,
      farm: state.farmUnlocked === true,       // ★ `needsFarm` 条目的门槛
      // ★★ 2026-10-15「半衰 ＋ 同组覆盖」（用户口径）：把"每条**上次被抽中**的时刻"递进去 ——
      //   刚做过的那条、以及它所属的那一组，会一起淡出候选池（治"连着三挡都在收拾东西"）。
      //   ⚠️ 老存档没有 `homeActSeen` ⇒ 传 undefined ⇒ pickHomeAct 跳过过滤（与从前逐字一致）。
      seen: state.homeActSeen
    }, now)
    : null;
  if (!picked) return false;
  // ★ 半衰的账本：记下"这一条什么时候做的"。键只会有池子里那些 id ⇒ 不会无限涨。
  if (!state.homeActSeen || typeof state.homeActSeen !== 'object') state.homeActSeen = {};
  state.homeActSeen[String(picked.id)] = now;
  state.homeAct = {
    id: picked.id, act: picked.act, detail: picked.detail, mate: picked.mate,
    // ★ 记下这条绑的是谁（没有绑人就是空串）—— 便于排查"面板说在和小月亮翻册子，可她在路上"
    mateId: picked.mateId || '',
    mateIds, mateNames,
    // ⚠️ 幂等键要用 **id 不用名字**：名字可以改，改了会让"同一档同批人"被判成变了。
    //   带上 `farm` 也一样（菜地一建起来，`needsFarm` 那两条才进池子 ⇒ 池子真的变了）。
    mateKey: `${mateIds.join(',')}|eaves:${eaves}|farm:${state.farmUnlocked === true ? 1 : 0}`,
    bucket: picked.bucket, at: now
  };
  // ★★ 2026-10-14「她的一天」流水 ②：**在家的瞬间**也要留档（给空间日记当素材）。
  //   原来 `state.homeAct` **只留最后一条** —— 每 20 分钟被下一挡覆盖 ⇒ 日记里
  //   "她在家那半天干了什么"完全查不到（存档里只剩此刻那一条）。
  //   ⚠️ 这里**天然按挡位去重**：上面的幂等判定已经在"同挡 + 同批人 + 同檐廊 + 同菜地"时
  //      `return false` 了，所以走到这儿就是"真的换了一挡"。
  const hlog = Array.isArray(state.homeLog) ? state.homeLog : (state.homeLog = []);
  hlog.push({
    at: now, bucket: Number(picked.bucket) || 0, id: String(picked.id || ''),
    act: String(picked.act || ''), detail: String(picked.detail || ''),
    mate: String(picked.mate || ''), mateId: String(picked.mateId || '')
  });
  const hcut = now - HOME_LOG_KEEP_DAYS * 86400000;
  while (hlog.length && Number(hlog[0].at) < hcut) hlog.shift();
  // ★★ 2026-10-15「庭院活动也影响心情」（用户口径）：新活动带心情标注 ⇒ 推一条
  //   `home-act` 事件，走现成的 moodEvents 通道让 sleep-mood 结算（delta 随事件自带）。
  //   ⚠️ `homeActMoodOf` 是 home.js（兄弟模块）的导出 ⇒ 热载窗口里可能是"新 index + 旧 home"
  //      ⇒ `typeof` 包装，旧模块没有就静默跳过（跟从前一致，不裸调）。
  //   ⚠️ 只在**真的换了活动**时走（上面幂等判定已经保证），同一挡调一百次也只推一条。
  const actMood = (typeof HM.homeActMoodOf === 'function') ? HM.homeActMoodOf(picked) : null;
  if (actMood && Object.keys(actMood).length) {
    pushMoodEvent(state, 'home-act', {
      where: HM.HOME_NAME, act: String(picked.act || ''),
      deltas: actMood            // ★ delta 随事件自带（sleep-mood 结算时优先用它）
    });
  }
  return true;
}

/**
 * ★★ 2026-10-13：她**在家**时的世界设定。
 *
 * 原来不在途就返回空串 ⇒ `syncWorldbook` 那边"回到家 → 清空"，
 * 于是世界观插件（life-system）的世界书里**既没有庭院、也不知道她此刻在做什么**。
 * 现在补上：庭院 + 院子里有谁 + 此刻在做什么（与 sleep-mood 看到的是同一条）。
 */
export function worldbookForHome(state) {
  const act = state?.homeAct;
  const names = (Array.isArray(act?.mateNames) ? act.mateNames : []).filter(Boolean);
  const who = names.length
    ? `院子里还住着${names.join('、')}`
    : '院子里今天只有她一个';
  const doing = act?.act
    ? `此刻她${act.act}${act.detail ? ` —— ${act.detail}` : ''}`
    : '这会儿她大概在檐廊下待着';
  // ⚠️ 条目的 `detail` 全部以「。」收尾 ⇒ 无条件再补一个句号会拼出"…笑出来。。"
  //   （这句是**直接进世界书、给模型看的**，双句号很显眼）。所以按结尾判断要不要补。
  const tail = /[。！？…]$/.test(doing) ? '' : '。';
  return `她此刻人在【${HM.HOME_NAME}】${who}。${doing}${tail}`;
}

/** 她出门时**留在院子里**的旅伴（邀请过的 − 跟着出门的 − 自己跑出去玩的）。读不到就返回空数组。 */
function homeStayNames(state) {
  let away = new Set();
  try {
    // ⚠️ 热载窗口里可能是"新 index + 旧 state"⇒ typeof 兜底，别裸调（跟本文件其它跨模块调法一致）
    if (typeof S.awayMateIds === 'function') away = S.awayMateIds(state) || away;
  } catch { /* 读不到就当没人在外，最多少说一句"院子里留着谁" */ }
  return ownedCompanionIds(state)
    .map((id) => String(id))
    // `awayMateIds` 给的是字符串集合（跟出门的 + 自己出去玩的两类都算）
    .filter((id) => !away.has(id))
    .map((id) => (S.COMPANIONS || {})[id]?.name || '')
    .filter(Boolean);
}

/**
 * ★★ 2026-10-24「庭院常时生效」（用户报的 bug，**药在这儿**）：
 *
 * 病：`life-system` 的世界书只有**一格** —— 她一出发，`worldbookForTrip(...)` 就把
 *   `worldbookForHome(...)` **整段顶掉**。于是世界书里只剩"欧洲 · 挪威……"，
 *   一句"她是哪儿的人、从哪儿出的门"都没有；回来讲旅行就丢了参照
 *   （说不出"逛了一圈还是咱院子好"这种话）。
 * 药：旅行中写进去的是**两段** —— 来处（常时有效）＋ 当趟目的地，见 `syncWorldbook`。
 *
 * ⚠️ 为什么**不能**拿 `worldbookForHome` 当常时段：它讲的是"**此刻**她在庭院做什么"
 *   （读 `state.homeAct`）。人已经在路上，那句"此刻她借小白龙身上的光看地图"是**过期**的
 *   —— 她在外面，家里的事不该用"此刻"开头。所以这一段只讲**身份与来处**，不讲当下。
 * ⚠️ 与 `travel-whale-home-lore`（L0 静态段，priority 46）**不抢职责**：那段讲庭院长什么样
 *   （石板缝的蓝光、水镜、星空，还有"别把院子讲到目的地风景里"的消歧）；
 *   这段只回答**两件事**：她是从哪出发的、院子里留着谁。
 *
 * 常时段：她**住在哪儿、从哪儿出发**（不含"此刻在做什么"—— 见上面的 ⚠️）。
 * 纯函数（只读 `state`/`COMPANIONS`）⇒ 可离线单测。
 */
export function worldbookForRoot(state) {
  const names = homeStayNames(state);
  const stay = names.length ? `院子里留着${names.join('、')}。` : '';
  return `她住在【${HM.HOME_NAME}】—— 那是她的家、她的来处，一座不属于任何一个世界的院子；`
    + `她每回出门走的都是院子中央那方水镜，回程也从那儿回。${stay}`;
}

/**
 * 把「她在哪个世界」同步给 life-system 的 worldbook。幂等：内容没变就什么都不做。
 * 任何异常都只记日志 —— **联动失败绝不该影响旅行本身**。
 */
export function syncWorldbook(state) {
  try {
    const trip = state?.trip;
    // 老旅程没有 regionId → 用「当前装备决定的地区」补一次（近似，但比整趟不联动强）
    let regionId = String(trip?.regionId || '').trim();
    if (trip && !regionId) {
      try { regionId = regionOfEquipped(state)?.id || ''; } catch { /* 读不到就算了 */ }
    }
    // ★ 2026-10-13：**在家也要有世界设定** —— 原来不在途就返回空串 ⇒
    //   世界观插件那边"回到家 → 清空"，世界书里既没有庭院、也不知道她此刻在做什么。
    // ★★ 2026-10-24「庭院常时生效」：在途时**不能只写目的地**（那样"来处"就被顶掉了）——
    //   改成两段：`worldbookForRoot`（家/来处，常时）＋ `worldbookForTrip`（当趟）。
    //   ⚠️ 顺序固定"先家后目的地"：她读到的第一句永远是"我住在矩阵庭院"，
    //      不会以为自己是从挪威长出来的。也**别**调成先目的地 —— 那等于又顶一次。
    const want = trip
      ? [worldbookForRoot(state), worldbookForTrip({ ...trip, regionId })].filter(Boolean).join('\n')
      : worldbookForHome(state);
    if (want === lastWorldbook) return;              // 世界没变 → 不碰配置
    const skills = getConfig()?.skills || {};
    const current = skills[LIFE_SYSTEM_ID] && typeof skills[LIFE_SYSTEM_ID] === 'object'
      ? skills[LIFE_SYSTEM_ID]
      : {};
    // 浅合并该技能的配置段（与核心 setSkillConfig 同一写法：它也是先自己合并、再 updateConfig）
    updateConfig({ skills: { [LIFE_SYSTEM_ID]: { ...current, worldbook: want } } });
    lastWorldbook = want;
    log(`[travel-whale] 世界设定已同步：${want ? `「${String(want).slice(0, 24)}…」` : '（清空）'}`);
  } catch (error) {
    log(`[travel-whale] 同步世界设定失败：${error?.message ?? error}`);
  }
}

/** 背包里还有没有这种口粮（`n` = 需要几份，旅行伙伴会要吃双份）。 */
function hasFood(state, tier, n = 1) {
  return Number(state?.bag?.food?.[tier] || 0) >= Math.max(1, Number(n) || 1);
}

/**
 * 出行时自动消耗一件最好的护身符（珍稀度高的优先）。
 * 原版设计是"每次出行消耗 1 个"，所以这里不是常驻 buff，而是单趟生效。
 */
function consumeCharm(state) {
  for (const id of ['pearl', 'scale', 'shell']) {
    const n = Number(state.bag?.charm?.[id]) || 0;
    if (n > 0) {
      state.bag.charm[id] = n - 1;
      if (state.bag.charm[id] <= 0) delete state.bag.charm[id];
      return id;
    }
  }
  return '';
}

/**
 * 手里最好的一件护身符的 id —— **不扣**。
 * ★ 艾泽拉斯「图腾护佑」学到之后用它：护身符**不再被消耗**（一直戴在身上、每趟都生效）。
 */
function bestCharmId(state) {
  for (const id of ['pearl', 'scale', 'shell']) {
    if ((Number(state.bag?.charm?.[id]) || 0) > 0) return id;
  }
  return '';
}

/**
 * 扣 `n` 份口粮（默认 1）。
 * ★ 旅行伙伴的"出门吃双份"就落在这里 —— 份数不够时**不扣任何一份**、返回 false
 *   （绝不能扣掉 1 份然后让出发失败，那等于白吃）。
 */
function consumeFood(state, tier, n = 1) {
  const need = Math.max(1, Number(n) || 1);
  if (!hasFood(state, tier, need)) return false;
  state.bag.food[tier] = Number(state.bag.food[tier]) - need;
  if (state.bag.food[tier] <= 0) delete state.bag.food[tier];
  return true;
}

/**
 * 掷一次「穿越」：命中就返回一个**还没解锁**的异世界，作为本趟的目的地。
 *
 * ★ 顺序很关键：**先掷骰子、再看候选池**。
 *   反过来（先查"有没有候选"再掷骰）在一堆边界情况下语义会糊；
 *   现在这样写，三件事一次说清：
 *     · 概率就是 `crossOverChance`（默认 0.15），与候选多少无关；
 *     · **异世界全部解锁 ⇒ 池子为空 ⇒ 永不穿越**（用户要的"买齐了就不倒霉"）；
 *     · 设成 0 或负数 = 直接关闭这个玩法。
 *
 * @returns {{region:object, fromName:string}|null}
 */
function pickCrossOverTarget(state, baseRegion, deps) {
  // ★ 诡秘之主「命运的偶然」：穿越概率 +0.15。
  //   直接读技能表（技能表就在本文件，不用过桥）；`syncSkillNumbers` 只在 depart 里跑，
  //   而穿越掷骰发生得更早，所以这里必须自己判、不能读同步字段。
  const bonus = skillOwned(state)['fate-chance'] ? 0.15 : 0;
  const rawCfg = Number(cfg().crossOverChance);
  const p = (Number.isFinite(rawCfg) ? rawCfg : S.CROSS_OVER_CHANCE) + bonus;
  if (!(p > 0)) return null;
  const rand = typeof deps?.rand === 'function' ? deps.rand : Math.random;
  if (rand() >= Math.min(1, p)) return null;            // ① 先掷骰

  let pool = [];
  try {
    pool = T.loadRegions().filter((r) => T.isFictional(r) && !isRegionUnlocked(state, r));
  } catch (error) {
    log(`[travel-whale] 穿越候选读取失败：${error?.message ?? error}`);
    return null;
  }
  if (!pool.length) return null;                        // ② 异世界全解锁 ⇒ 不穿越

  const region = pool[Math.floor(rand() * pool.length)];
  // 她"本来要去"的地方：装备决定的那个（将来可以在台词里对比，先存着）
  return { region, fromName: baseRegion?.name || '' };
}

/**
 * ★★ 2026-10-15「探索解锁」：一次穿越解锁几个异世界的装备购买权。
 *   用户口径：「异世界及其装备不要最开始就解锁，保留一点【探索】感：
 *              每次【穿越】之后解锁三个未解锁的异世界的装备的购买权；
 *              无论是鲸鱼自己穿越还是旅伴穿越都算。」
 *   ⇒ 3 是**用户定死的**，不是调参项（要改就改这里一处）。
 */
const UNLOCK_PER_CROSSING = 3;

/**
 * ★★ 2026-10-15「清档 → 时空乱流」：她被抛回来之后，提示词里提这件事**提几天**。
 *   之后自然淡出 —— 否则一年后她还在说"我刚被时空乱流抛回来"。
 *   （判据是 `state.rebornAt`，由 `_qcheck/reset-whale.mjs` 在清档时写下。）
 */
const REBORN_DAYS = 7;

/**
 * 把"这一趟真的穿越了"兑换成"发现新世界"。
 *
 * ⚠️ 两条纪律（都是本项目踩过的）：
 *   ① `unlockEquipBuyables` 住在 `state.js`（**兄弟模块**）⇒ 热载窗口里
 *      「新 index ＋ 旧 state」时这个函数**不存在** ⇒ **必须 `typeof` 包装**。
 *      裸调 TypeError —— 而这里在 `depart()` / `departSideTrip()` 的中途，
 *      抛出去就是把**整趟出发废掉**（比"没解锁"严重得多）。
 *   ② 整段 try/catch：解锁失败**绝不该影响旅行本身**（跟 `syncWorldbook` 同一口径）。
 *
 * @returns {string[]} 这一次**新解锁**的世界名（给播报用；空数组 = 没有新的了）
 */
function unlockBuyablesFromCrossing(state, regionId, deps) {
  try {
    if (typeof S.unlockEquipBuyables !== 'function') return [];   // 旧模块 ⇒ 静默跳过（行为同从前）
    const ids = S.unlockEquipBuyables(state, regionId, {
      count: UNLOCK_PER_CROSSING,
      rand: typeof deps?.rand === 'function' ? deps.rand : Math.random
    });
    if (!Array.isArray(ids) || !ids.length) return [];
    const byId = new Map(T.loadRegions().map((r) => [String(r.id), String(r.name || r.id)]));
    return ids.map((id) => byId.get(String(id)) || String(id));
  } catch (error) {
    log(`[travel-whale] 解锁装备购买权失败（不影响这趟旅行）：${error?.message ?? error}`);
    return [];
  }
}

/**
 * 拼一句"发现新世界"的播报。**单独一行**，别跟她的即兴台词混在一起 ——
 * 那是机制说明，读者要一眼分得清（§114 借嘴那条的同一课）。
 */
function discoveredLine(names) {
  if (!Array.isArray(names) || !names.length) return '';
  return `\n\n🌍 庭院记下了这几个新世界的坐标 —— 以后可以买它们的装备了：${names.join('、')}`;
}

/**
 * 让她**即兴演一段**穿越后的反应（用户明确要求"这样比较好玩"）。
 *
 * 提示词里必须交代的三件事（用户指定的口径）：
 *   ① 她是**非常倒霉地**遇到了穿越；② 被丢到了这个异世界；
 *   ③ **不过她仍然可以回家** —— 这条是**安抚**，不是机制（回家时刻本来就是定死的）。
 *
 * 模型失败 / 返回空 ⇒ 退回兜底台词：**穿越这件事不能因为模型抽风而整个消失**。
 * ⚠️ 这里**不传 maxTokens**（与宿主其它模型调用一致）：llm.js 只在 >0 时才写
 *    `max_tokens`，思考模型设小了会把预算全烧在 reasoning 上、正文直接空。
 */
export async function buildCrossOverLine({ toName, fromName, companion, lead = 'whale', whaleAway = false }, deps) {
  // ★★ 2026-10-13 修：**两条路径共用一个函数，但主角完全不同** —— 必须分叉。
  //   · `lead='whale'`    ：鲸鱼自己那趟（那只鲸鱼就是她本人）⇒ **第一人称"我"**，
  //                        `companion` = 陪她一起出门的旅伴；
  //   · `lead='partners'` ：**两位伙伴自己溜达**那趟 ⇒ 她**留守在家**、是**转述者**，
  //                        ⚠️ 此时 `companion` 被借用来传"两位伙伴的名字"，语义与上面不同。
  //   原来只有一套文案（当时写死了"你是一只住在群里的＜旧玩法名＞ / 我明明是出门旅行的"），
  //   于是伙伴那趟会演成「我（鲸鱼）被穿越了，身边还跟着小狐狸和小猫咪」——**主角全错**，
  //   而且与同一处的另一条分支（`🐾 A和B自己跑出去玩了`）自相矛盾。
  const side = lead === 'partners';
  const who = companion ? companion.name : '';
  const withWhom = (!side && companion) ? `，身边还跟着${companion.name}` : '';

  // 兜底台词：模型抽风时，**穿越这件事也不能整个消失**
  const fallback = side
    ? `🌌 诶——？${who}一转眼跑哪儿去了？…该不会是被丢到「${toName}」去了吧。`
      // ★ 2026-10-14：她本人也在外面时，别说"不带我"（那是"她留守在家"的口径）
      + (whaleAway
        ? '哼，自己跑出去玩还能跑丢 —— 这下好了，还回不回得来啊？'
        : '哼，谁让这俩自己偷跑出去玩、不带我 —— 这下好了，还回不回得来啊？')
    : `🌌 诶——？等、等一下！我明明是出门旅行的，怎么一睁眼就到「${toName}」了${withWhom}…`
      + '这、这就是传说中的穿越吗，也太倒霉了吧…不过…好在我还是能回家的（这趟走完就回去了），那就先逛逛吧。';

  // 用户口径（2026-10-13）：「转述，语气换成『她们一转眼就跑哪儿去了？还回不回得来？』
  //   这样的口径，带点儿幸灾乐祸和『让你们不带我』。」
  const lines = side
    ? [
      whaleAway
        ? '你是「矩阵庭院」里那只鲸鱼少女，**你那趟也还在外面** —— 那两个小家伙自己跑出去玩了，没带上你。'
        : '你是「矩阵庭院」里那只鲸鱼少女，**今天你留守在家** —— 那两个小家伙自己跑出去玩了，没带你。',
      `刚还好好出门的两位伙伴「${who}」，一转眼就被丢到了「${toName}」这个地方，不见了。`,
      '',
      whaleAway
        ? '请用第一人称（你是**自己也还在外面的那位**，用**转述**的口吻讲她们），**两三句话**演出你听说这事之后的反应，按这个顺序：'
        : '请用第一人称（你是**留在家的那位**，用**转述**的口吻讲她们），**两三句话**演出你得知这事之后的反应，按这个顺序：',
      `1. 先半信半疑地问一句"${who}一转眼跑哪儿去了？"，语气像随口一问；`,
      whaleAway
        ? '2. 反应过来是穿越了，露出一点**幸灾乐祸**、以及看热闹的小得意；'
        : '2. 反应过来是穿越了，露出一点**幸灾乐祸**、以及"**让你们不带我**"的小得意；',
      '3. 收尾捎一句"还回不回得来"，嘴硬心软 —— 看热闹归看热闹，别真的不管。',
      '',
      '要求：',
      '- 口语化、可爱，带点看热闹的小恶意，但**不能真的刻薄**；',
      '- **是你在说她们**，不是她们自己说话（**不要用"我们"**）；',
      '- 不要解释穿越原理、不要写设定说明、不要用旁白视角；',
      '- 总共两三句、控制在 80 字以内，直接说，不要加任何前缀。'
    ]
    : [
      '你是「矩阵庭院」里那只鲸鱼少女，刚刚**非常倒霉地遇到了穿越** ——',
      `你本来要出门旅行，结果一睁眼就被丢到了「${toName}」这个地方${withWhom}。`,
      '',
      '请用第一人称，**两三句话**演出你刚被丢过来时的反应，按这个顺序：',
      '1. 先懵一下、吐槽自己怎么这么倒霉；',
      `2. 然后发现「${toName}」居然真的存在，将信将疑地打量四周；`,
      '3. 最后想起**好在自己还是能回家的**（这趟走完就回去了），稍微松口气。',
      '',
      '要求：',
      '- 口语化、可爱、带点自嘲的倒霉感，就像在群里随口说话；',
      '- 不要解释穿越原理、不要写设定说明、不要用旁白视角；',
      '- 总共两三句、控制在 80 字以内，直接说，不要加任何前缀。'
    ];

  try {
    const text = await deps.llm(lines.join('\n'));
    const t = String(text || '').trim();
    return t || fallback;
  } catch (error) {
    log(`[travel-whale] 穿越台词生成失败，用兜底：${error?.message ?? error}`);
    return fallback;
  }
}

/**
 * 被点名要去的地方，当前装备到不了 —— 给一句**能照着做**的提示（2026-10-11）。
 *
 * 关键不是"找不到"，而是**告诉她怎么才能去到那儿**：先去别的地区里找同名/近似的
 * 目的地，找到就点名「那在 XX，你得先买『YY』并装备上」。用户问的本来就是
 * "买了装备能不能指定去那儿"，所以这句话要正好回答它。
 */
function describeNoSuchPlace(state, region, want) {
  const found = [];
  try {
    for (const r of T.loadRegions()) {
      if (r.id === region.id) continue;
      const hit = T.findDestination(r, { city: want });
      if (hit) found.push({ region: r, dest: hit });
    }
  } catch { /* 表坏了就当没找到 —— 但别让"提示本身"报错 */ }

  if (found.length) {
    const parts = found.slice(0, 3).map(({ region: r, dest }) => {
      const unlocked = isRegionUnlocked(state, r);
      return `「${dest.city}」在${r.name}${unlocked ? '（已经解锁了，把装备换上就能去）' : `（要先买「${r.equipment}」）`}`;
    });
    return `现在的装备只能去${region.name}，那边没有「${want}」—— ${parts.join('；')}。`;
  }
  // ★★ 2026-10-15：这句要**明确挡住"随便换个地方"**。原来收尾是"换个说法试试"，
  //   实测会让模型自己改口（用户报："指定她去伊比利亚，她说没搜到，最后去了巴塞罗那"）。
  //   点名了却去不成时，正确行为是**如实回复 + 告诉群友怎么解锁**。
  return `${region.name}里没有叫「${want}」的地方。`
    + '—— **别自己换一个地方**：把这句话原样告诉群友（或者问她要不要换个别的地名），'
    + `要解锁其它地区得先在商店买对应的装备（现装备是「${region.equipment}」）。`;
}

/**
 * 让鲸鱼出门。
 * 自由路径挑到"搜不到内容"的地方时，**回落池子重挑一次**再放弃 —— 这是
 * 自由发挥不翻车的关键一步。
 * @returns {Promise<{ok:boolean, plan?:object, reason?:string, city?:object}>}
 */
export async function depart(chatKey, state, foodTier = 'normal', deps) {
  // ★ v3.18 ①：出发前**自动收一次**（顺手为之，收不到就静默跳过）
  autoHarvest(state, '出发');

  // ★ 2026-10-19：自动/自由出门 = **已解锁范围内随机**（不再由装备决定去哪儿）
  // ★★ 2026-10-23（B 档）：`deps.region` 非空时**用她挑的那个**，不再随机。
  //   来源是 `considerDepart` 问模型得到的结果；非法 / 不属于已解锁 ⇒ 丢弃，回落随机。
  const wantRegion = (deps && deps.region) || null;
  const baseRegion = (wantRegion && unlockedRegions(state).some((r) => String(r.id) === String(wantRegion.id)))
    ? wantRegion
    : randomUnlockedRegion(state, (deps && deps.rand) || Math.random);
  if (!baseRegion) return { ok: false, reason: '地区表不可用' };

  // ★ 旅行伙伴：两人一起出门 ⇒ 这份口粮要**吃双份**；没买伙伴时 foodNeed = 1 ⇒ 与从前逐字节一致。
  // ★★ 2026-10-14「扩容鲸鱼」：同行的可能**不止一位** ⇒ 口粮按人**累加**（`foodNeedOf` 已支持数组）。
  const companion = companionOf(state);
  const party = typeof S.companionsOf === 'function'
    ? S.companionsOf(state) : (companion ? [companion] : []);
  // ★ 2026-10-13：口粮需求统一走 `foodNeedOf`（含**电饭煲**的 -1 减免）
  const foodNeed = foodNeedOf(state, party);
  const foodName = T.FOOD_TIERS[foodTier]?.name || foodTier;
  if (!hasFood(state, foodTier, foodNeed)) {
    // 单人时保留原来的「双份」措辞（多人才说 N 份）—— 免得老玩家以为文案变了是出了 bug
    const needWord = (party.length === 1 && foodNeed === 2) ? '双份' : `${foodNeed}份`;
    const whoText = party.length > 1
      ? `带着${party.map((c) => c.name).join('、')}一起出门`
      : (companion ? `带着${companion.name}出门` : '');
    return {
      ok: false,
      reason: foodNeed > 1
        ? `${whoText}得吃${needWord}「${foodName}」（要 ${foodNeed} 份，现在只有 ${Number(state?.bag?.food?.[foodTier] || 0)} 份）—— 先去商店买点。`
        : `没有「${foodName}」了，先去买点吃的`
    };
  }

  const d = deps || buildDeps(chatKey, state);

  // ★★ 2026-10-13 技能树：把"数值半"落到位（**必须在 planTrip 之前** —— 里面要读 `state.whale.rareBonus`）
  syncSkillNumbers(state);

  // ★ 指定目的地（2026-10-11 用户需求）：带了 `target.city` 就**直接去**，不再随机抽。
  //   只在**当前装备决定的地区**里找 —— 这样"指定"不会绕过装备：
  //   买了折跃棱镜才点得动「艾尔」，默认装备就只能点亚洲的城市（「杭州」）。
  //
  // ★★ 2026-10-15（用户报"指定她去伊比利亚，她说没搜到，最后去了巴塞罗那"）：
  //   两处都修了 ——
  //     ① `T.findDestinations` 现在会**再按"地区/国家名"找一次**（"伊比利亚"是明日方舟的**地区**，
  //        真正的目的地是它下面的"静默圣所／黄金时代遗迹"）。原来只认城市名 ⇒ 一律判"没这个地方"。
  //     ② 改成**候选列表** `forcedList`：点名地区时会有多个城市，下面两次尝试可以**换个城市再试**；
  //        原来是单个 `forced` ⇒ 同一个地方连栽两次（"连着两次都没挑到能去的地方"）。
  //   ⚠️ 注意 `country` 单独给也要能生效（`whale_go` 那边已一并修，见那个工具）。
  const wantCity = String(d?.target?.city ?? '').trim();
  const wantArea = String(d?.target?.country ?? '').trim();
  let forcedList = [];
  if (wantCity || wantArea) {
    // ★★ 热载窗口防护（项目通则，栽过）：`trip.js` 是**非入口**模块 —— 热载后是
    //   "新 index ＋ 旧 trip"，那时 `findDestinations` **不存在**。裸调 ⇒ TypeError ⇒
    //   **整个 whale_go 工具全挂**。所以必须 `typeof` 包装，旧模块时回落到老函数（单个候选）。
    forcedList = (typeof T.findDestinations === 'function')
      ? T.findDestinations(baseRegion, d.target, (typeof d.rand === 'function' ? d.rand : Math.random))
      : [T.findDestination(baseRegion, d.target)].filter(Boolean);
    if (!forcedList.length) {
      return { ok: false, reason: describeNoSuchPlace(state, baseRegion, wantCity || wantArea) };
    }
  }

  // ★ 穿越判定（2026-10-11 用户需求）：小概率被丢到一个**还没解锁**的异世界。
  //   池子为空（异世界全解锁）⇒ 返回 null ⇒ 永不穿越 —— 这就是"买齐了就不倒霉"。
  //   ⚠️ **点名要去的地方不参与穿越**：她是被派去的，半路被丢到别处只会让人困惑。
  const crossing = forcedList.length ? null : pickCrossOverTarget(state, baseRegion, d);

  for (let attempt = 0; attempt < 2; attempt++) {
    // 第一次尝试用穿越目标（如果有），失败就**回退到正常地区**：
    // 穿越去的地方搜不到内容时，就当这趟没穿越，而不是连着两次栽在同一个鬼地方。
    const region = (attempt === 0 && crossing) ? crossing.region : baseRegion;
    // ★ 2026-10-15：点名时用候选列表 —— 第 1 轮第 1 个城市，第 2 轮换下一个（点名地区才可能 >1 个）
    const picked = forcedList.length
      ? forcedList[Math.min(attempt, forcedList.length - 1)]
      : await T.pickCity(region, state, { llm: d.llm, log, rand: d.rand });
    if (!picked) continue;

    const plan = await T.planTrip({
      region, city: picked.city, country: picked.country,
      foodTier, state, deps: d,
      // ★★ v3.2 特产批注（Kimi「博闻」）：这趟带的人在不在"会记东西"那一类。
      //   判据**现读 COMPANIONS 的 `noteSouvenirs`**（不写死 id —— 加新旅伴不用改这里）。
      note: notesSouvenirs(companionOf(state))
    });
    if (plan) {
      // 点名去的地方记成 'request' —— 以后想看"有多少趟是群友点单的"就有据可查
      plan.source = forcedList.length ? 'request' : picked.source;
      // ★ 实际去的地区 id（穿越时是**穿越后**的那个）—— 与「世界与事件」联动时靠它查世界速写
      plan.regionId = region.id || '';
      // ★ 这个地区是不是"异世界"（2026-10-12）—— sleep-mood 的 TRAVEL-SYNC **只读存档**，
      //   拿到 id 也查不到 regions.json（那是本技能的安装资产、路径会变）；写下来最省事。
      //   它据此决定"此刻在干什么"走现实池还是异世界池（异世界才有"被地精追着跑"这类）。
      //   老存档没有这个字段时，sync 会退回看有没有 foe —— 那个判据同样可靠。
      plan.regionFictional = region.fictional === true;
      plan.fallback = picked.fallback || '';
      plan.byRequest = forcedList.length > 0;
      // 护身符：出行时自动消耗最好的一件，本趟生效（提升稀有概率）
      // ★ 艾泽拉斯「图腾护佑」：学到之后**不再消耗** —— 拿最好那件来生效，但留在背包里。
      const charm = skillOwned(state)['totem-ward'] ? bestCharmId(state) : consumeCharm(state);
      state.whale.charm = charm;
      plan.charm = charm;
      // 同行伙伴：写进本趟计划（postOnce 据此切双人明信片提示词）。
      // ⚠️ 显式赋值而不是只依赖 planTrip 的返回值 —— 热载期间可能出现
      //    「新 index + 旧 trip.js」的组合，那时 plan.companion 是 undefined；
      //    单独上路总比整个出发失败好。
      plan.companion = companion ? companion.id : '';
      // ★ 把伙伴**显示名**也写进本趟计划（2026-10-12 用户需求）：
      //   sleep-mood 的 TRAVEL-SYNC **只读存档**（它是独立包，不该反向 import 本技能的伙伴表），
      //   所以拿到 id 也查不出名字 —— 直接写下来最省事，而且用户改过显示名也能立刻跟上。
      plan.companionName = companion ? companion.name : '';
      // ★ 穿越标记 + 即兴台词（用户要"明确告诉她倒霉地穿越了，让她演一段"）。
      //   只在**第一次尝试**（确实用了穿越目标）时才标记，回退那轮不算穿越。
      if (attempt === 0 && crossing) {
        plan.crossedOver = true;
        plan.crossOverFrom = crossing.fromName;
        plan.crossOverTo = region.name;
        // ★★ 2026-10-13「随机事件影响心情」：穿越 = **坏事**（她被丢到一个没打算去的地方）。
        pushMoodEvent(state, 'crossover', { where: String(region.name || '') });
        // ★★ 2026-10-15「探索解锁」：穿越**同时是发现** —— 刚到的这儿 ＋ 随机补足到 3 个
        //   「还没发现」的异世界 ⇒ 拿到它们的装备购买权（用户口径："无论是鲸鱼自己穿越
        //   还是旅伴穿越都算"）。写进 `state` 就会跟着 depart 末尾那次落盘一起存下来。
        const foundNames = unlockBuyablesFromCrossing(state, region.id, d);
        plan.unlockedBuyables = foundNames;
        plan.crossOverLine = (await buildCrossOverLine(
          { toName: region.name, fromName: crossing.fromName, companion, lead: 'whale' }, d))
          + discoveredLine(foundNames);
      } else {
        plan.crossedOver = false;
      }
      consumeFood(state, foodTier, foodNeed);
      // ★★ 2026-10-13 技能树：**planTrip 之后**才落的那半（加卡 / 加特产 / 升稀有度）
      applySkillNumerics(state, plan, d);
      // ★★ 2026-10-13 旅伴「特色」：小书虫（Claude）「贵」—— 每次出发扣 500 亿 TOKEN。
      //   ⚠️ **允许扣成负数**（用户原话："token 余额为负数很正常"）⇒ **不能**用 `spendPlankton`
      //      （它余额不足会直接拒绝、且一个字段都不改）；这里直接做减法。
      //   ⚠️ **自动出门也会扣**（用户明确要求）—— 自动出门走的正是这条 `depart()`。
      //   位置放在**确认出发成功之后**（上面两个 attempt 都失败时不会白扣钱）。
      const departCost = Math.max(0, Math.floor(Number(companion?.departCost) || 0));
      if (departCost > 0) {
        state.wallet.plankton = (Number(state.wallet?.plankton) || 0) - departCost;
        plan.departCost = departCost;
      }
      // ★★ 2026-10-13 旅伴「特色」：
      //   · 小魔王（Grok）「惹事」—— 异世界**必定**多 1 张战斗明信片；
      //   · 小书虫（Claude）「话多」—— 每趟多 1 张普通卡。
      if (companion?.battleOnFiction) appendExtraCard(plan, { rand: d.rand, battle: true });
      // ★★ 2026-10-13 旅伴养成「挑衅」：小魔王在异世界惹事时**多惹一次**（1 张 → 2 张战斗明信片）。
      //   门槛是"陪她走过 3 个异世界" ⇒ 学到这条时早就是老搭档了，惹事也该更凶。
      if (companion?.battleOnFiction && companionHas(state, 'provoke')) {
        appendExtraCard(plan, { rand: d.rand, battle: true });
      }
      if (Number(companion?.cardExtra) > 0) appendExtraCard(plan, { rand: d.rand, battle: false });

      // ★★ 2026-10-14「扩容鲸鱼」（设施 A）：**这一趟带谁**在这里定死（＝出发那一刻的快照）。
      //   · 领头（`state.companion`）一定在；其余按设施上限随机补齐；
      //   · 在途明信片／回家卡读的都是这份快照 ⇒ 中途换伙伴**不影响这一趟**。
      //   ⚠️ 必须排在 `state.trip = {...}` **之前** —— `plan.companion` 那个字段只认领头那位，
      //      "这一趟同行的全部"存 `state.companions`。
      const partyIds = pickPartyIds(state);
      state.companions = partyIds.map((id) => ({ id, at: Number(plan.departAt) || Date.now() }));
      plan.party = partyIds.slice();   // 顺手让 plan／简报也能看到"这趟都带了谁"
      // ★★ 2026-10-14 设施 B（用户口径）：**带她出门 = 解封** —— 被带上路的旅伴，
      //   解除"必须先出门才能再上工"的封印（`releaseForTravel` 同时把还在名册上的撤下来，
      //   因为她人已经不在庭院了）。这也是"想再让同一位上工"的两条路之一（另一条是她自己出去玩）。
      if (typeof S.releaseForTravel === 'function') S.releaseForTravel(state, partyIds);

      // ★ v3.21：出发这一刻定"世界当前是什么局势"，整趟沿用（只有配过 phase 的地区才有）
  try {
    const ph = currentPhase(state, String(plan.region || baseRegion?.id || ''), String(plan.country || ''), Date.now());
    if (ph) {
      plan.phase = { id: ph.id, name: ph.name, brief: String(ph.brief || ''), tone: String(ph.tone || ''), avoid: String(ph.avoid || '') };
      log(`[travel-whale] 世界状态：${plan.region}·${plan.country} 当前「${ph.name}」`);
    }
  } catch (error) {
    log(`[travel-whale] 世界状态取值失败（忽略）：${error?.message ?? error}`);
  }
  // ★★ v4.1：遭遇战**在出发时定死**（同一次出门 = 一次遭遇，至多一张卡）。
  //   ① 先掷"有没有遇到"；② **再独立掷**结果（压制/平手/吃亏）；③ 构图在出图时按结果抽。
  try {
    const b = rollBattle(state, plan, d.rand || Math.random);
    if (b) {
      plan.battle = b;
      const cards = Array.isArray(plan.cardPlan) ? plan.cardPlan : [];
      const mid = Math.max(0, cards.length - 1);              // 末位是到家卡，排除
      if (mid > 0) {
        const idx = Math.floor(Math.random() * mid);
        cards[idx].battleOutcome = b.outcome;
        log(`[travel-whale] 遭遇战：${plan.foe}（${b.outcome}）→ 第 ${idx + 1} 张`);
      }
    }
  } catch (error) {
    log(`[travel-whale] 遭遇战判定失败（忽略）：${error?.message ?? error}`);
  }
  // ★ v4.2：事件（可多个，整趟约 28%）—— 遭遇战已经占了那张卡就不再叠
  try {
    const n = rollEvents(state, plan, d.rand || Math.random);
    if (n) log(`[travel-whale] 事件 ${n} 个：${plan.cardPlan.map((c) => c.event?.name).filter(Boolean).join('、')}`);
  } catch (error) {
    log(`[travel-whale] 事件判定失败（忽略）：${error?.message ?? error}`);
  }
  state.trip = { ...plan, cardsSent: 0 };
      state.stats.trips = (Number(state.stats.trips) || 0) + 1;
      E.updateStreak(state);
      // ★ 2026-10-14：原来这里记 `state.stylesUsed`（服务称号「百变风格」）—— 那条称号
      //   因为"要凑齐 93 种画风"实际不可达**早已删掉**，这个字段从此**只写不读**，一并清掉。
      return { ok: true, plan, city: picked };
    }
    log(`[travel-whale] ${placeLabel(picked)} 没玩头，重挑（第 ${attempt + 1} 次）`);
  }

  return { ok: false, reason: '连着两次都没挑到能去的地方，等下趟再说' };
}

// ── 发送 ──────────────────────────────────────────────────────────────────

// ── 「家」与明信片投递名单（BROADCAST，2026-10-10 用户需求）──────────────────
//
// 原设计：**每个会话各养一只鲸鱼**，各走各的（存档 `chats/<chatKey>.json`），
//         各寄各的明信片。用户要把它拆开：
//           "我希望「寄明信片」和「养鲸鱼」这两个功能可以分开 —— 明信片可以
//            同时寄给多个不同的群和个人，但鲸鱼在一个群养就好。"
//
// 所以现在：
//   · `homeChatKey` —— **唯一**养鲸鱼的会话（服务器/钱包/图鉴/称号都在它身上）。
//                      tick 只推进它；别处调养鲸鱼类工具只会得到一句"窝在哪儿"。
//   · `cardTargets` —— 这趟旅行寄出的明信片（含出发/到家播报）**投递到哪儿**。
//                      多个群、多个私聊都行；留空 = 只发回「家」（＝改造前的行为）。
//
// 实现上只在**发送层**做扇出（say / sayImage）—— 那一层正好是"旅行自己发的消息"，
// 而工具回执走的是另一条路（replyPanel，用 ctx.sender），所以不会被误广播。

/** 归一化一个会话标识：`123456789` / `群:123456789` / `group:123456789` 都收。 */
function normChat(raw, defKind = 'group') {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(群|group|g)\s*[:：]/, 'group:').replace(/^(私|好友|private|p)\s*[:：]/, 'private:');
  if (/^(group|private):/.test(s)) return s;
  return `${defKind}:${s}`;
}

/** 「家」= 养鲸鱼的那个会话。没配 → 返回 ''（退回"每个群各养一只"的老行为）。 */
function homeKey() {
  return normChat(cfg()?.homeChatKey, 'group');
}

/** 明信片投递名单（一定含「家」，且去重）。 */
function cardTargets() {
  const home = homeKey();
  const raw = cfg()?.cardTargets;
  const list = String(raw ?? '')
    .split(/[\r\n,，、;；|]+/).map((x) => normChat(x, 'group')).filter(Boolean);
  const out = [];
  for (const k of [home, ...list]) if (k && !out.includes(k)) out.push(k);
  return out;
}

/**
 * 播报分类（2026-10-21 用户需求：「仅出门、归家、明信片和题词播报到白名单；
 * 购买、邀请、成就等系统信息不再播报，避免刷屏」）。
 *
 * `opts.kind` 只有两个合法值：
 *   · `'journey'` —— 出门播报 / 归家播报 / 明信片（途中卡 + 到家卡）/ 题词（含留守旅伴的评论）
 *                   ⇒ 按 `cardTargets()` 白名单扇出（**含「家」**）；
 *   · `'system'`  —— 购买 / 邀请换旅伴 / 称号成就 / 每日津贴 / 庭院大合照 / 打工与收成 / 其它回执
 *                   ⇒ **只发 `chatKey` 本身**，不扇出。
 *
 * ⚠️⚠️ **默认必须是 `'system'`**：将来新加发送点忘了标，最坏结果是"少了一次群发"，
 *    而不是"又刷屏了"。所以只有那 4 类调用点**显式写** `{ kind: 'journey' }`。
 * ⚠️ 别把它和 `broadcast:false` 混起来：那个是"手动索要 ⇒ 连本会话之外都不发"，
 *    语义完全不同（见 `fanoutTargets` 里那段注释）；两者同时出现时 `broadcast:false` 优先。
 */
const SAY_KINDS = ['journey', 'system'];

/** 从 `opts` 里取合法的 kind；取不到/脏值一律 `'system'`。 */
function sayKindOf(opts) {
  const k = String(opts?.kind ?? '').trim();
  return SAY_KINDS.includes(k) ? k : 'system';
}

/**
 * `state.pending` 里一条压住的播报该按哪一类补发。
 *
 * ⚠️⚠️ **`pending` 里早就有一个 `kind` 了**（`'return'` / `'side-return'` / `'labelroom-off'`，
 *    表示"这是哪一种待补发事项"），所以广播分类**不能**也叫 `kind` —— 会直接打架。
 *    这里用 `sayKind` 这个名字（= 它最终喂给 `say(..., { kind })` 的那个值）。
 *
 * 老存档兼容：升级前入队的条目**没有 `sayKind`** ⇒
 *   · `return` / `side-return` ＝ 明信片 + 出发/到家播报 ⇒ 按 `'journey'`
 *     （不能因为升级把它们变成"只发回家"或者干脆不发）；
 *   · 其余（如 `labelroom-off` 车间下班）本来就不是明信片 ⇒ `'system'`。
 */
function pendingSayKind(item) {
  const k = String(item?.sayKind ?? '').trim();
  if (SAY_KINDS.includes(k)) return k;
  const legacy = String(item?.kind ?? '').trim();
  return (legacy === 'return' || legacy === 'side-return') ? 'journey' : 'system';
}

/**
 * 这次发送实际要落到哪些会话。
 * 非「家」的发送只有它自己（保底：万一以后别处也能主动发，不会误广播）。
 *
 * @param {string} chatKey 发送源会话
 * @param {boolean} [broadcast=true] 手动索要时传 false（只发 chatKey）
 * @param {'journey'|'system'} [kind='system'] 见 `SAY_KINDS`；只有 journey 才走投递名单
 */
function fanoutTargets(chatKey, broadcast = true, kind = 'system') {
  const key = String(chatKey || '');
  if (!key) return [];
  // ★★ 2026-10-14 「手动索要」不扇出（用户报的 bug）：
  //   投递＝分发（她自己旅行寄回来的，投递名单里大家都该看到），
  //   但**某个会话里有人开口要**（加急寄一张 / 补发那张）—— 那是**那个会话**要看，
  //   不是所有人都要看。所以由调用方显式传 `broadcast:false`。
  //   自动路径（她自己寄片 / 出发到家播报）一律保持默认扇出 —— 但**只有 journey 那几类**，
  //   2026-10-21 之前这里没有 kind 这道闸，所以大合照 / 每日津贴也一起群发了。
  if (broadcast === false) return [key];
  // ★★ 2026-10-21「播报分类」：单一出口，按 kind 决定目标 —— 别在每个调用点各写一遍分支。
  if (kind !== 'journey') return [key];
  const home = homeKey();
  if (!home || key !== home) return [key];
  return cardTargets();
}

/** 群名（读宿主的 data/group-names.json；查不到就退回裸号）。 */
function groupLabel(chatKey) {
  const key = String(chatKey || '');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'group-names.json'), 'utf8'));
    const name = String(j?.[key] || '').trim();
    if (name) return name;
  } catch { /* 没这个文件就算了 */ }
  return key.replace(/^(group|private):/, '');
}

/**
 * 往会话里发一条文本（走核心发送队列：自带限频/去重/留档）。
 * ★ 2026-10-21：只有 `opts.kind === 'journey'` 才会在「家」扇出到投递名单，
 *   其余（含默认）只发 `chatKey` 本身 —— 见 `SAY_KINDS` 那段说明。
 */
async function say(chatKey, text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (!services?.sender?.sendTextBatch) {
    log('[travel-whale] 发送队列不可用，本条跳过');
    return false;
  }
  let any = false;
  const kind = sayKindOf(opts);
  let firstFan = true;
  for (const to of fanoutTargets(chatKey, opts.broadcast !== false, kind)) {
    // 多目标零间隔连发是明显的风控指纹 —— 首个目标之后逐条随机退避 2~4.5s
    if (!firstFan) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2500));
    firstFan = false;
    try { await services.sender.sendTextBatch(to, [t]); any = true; }
    catch (error) { log(`[travel-whale] 发往 ${to} 失败：${error?.message ?? error}`); }
  }
  return any;
}

// ★★ 2026-10-14「同一轮最多一页面板」的记账（配套 replyPanel，见下方注释）。
//   只记"当前这次唤醒"，会话一换自动归零 ⇒ 不会跨轮误伤，也不会无限增长。
let panelTurnId = '';
let panelTurnSent = false;

/** 这次唤醒的"直发额度"是不是已经用掉了。 */
function panelSlotUsed(ctx) {
  const sid = String(ctx?.session?.id || '');
  if (!sid) return false;                       // 拿不到会话 ⇒ 不限制
  if (sid !== panelTurnId) { panelTurnId = sid; panelTurnSent = false; }
  return panelTurnSent;
}

/** 真的发出去之后才记账。 */
function markPanelSent(ctx) {
  const sid = String(ctx?.session?.id || '');
  if (!sid) return;
  if (sid !== panelTurnId) { panelTurnId = sid; }
  panelTurnSent = true;
}

/**
 * 把"列表 / 面板"型结果**直接发到群里**，而不是当作资料回给模型。
 *
 * ⚠️ 为什么必须这样：模型拿到工具结果后，会**用自己的语气重新措辞** —— 实测问
 *    「看一下商店」，它把整张价目表压缩成了 4 句短消息（人设是"1~10 字、像真人"），
 *    用户根本看不到货架和价格。凡是"用户要的就是这份清单"的场景，都得绕过模型直接发。
 *    发不出去时才退回给模型，宁可它转述也不能什么都不发。
 */
async function replyPanel(ctx, text) {
  const t = String(text ?? '').trim();
  if (!t) return { content: '（没有内容可显示）' };
  // ★★ 2026-10-14「面板刷屏」确定性兜底：**同一次唤醒里最多直发一页**。
  //   事故现场（07:15:39 主群）：模型为了"查一下价格 + 查一下余额"，
  //   在**同一轮**里同时调了 whale_shop 和 whale_status —— 两个"直发面板"工具
  //   各甩一整页 ⇒ 群里连收两页长文本 = 刷屏。
  //   这里不去赌模型会不会守规矩：第 2 页起**不发**，改为把内容回给模型并说明原因，
  //   由它自己决定要不要挑重点转述。⇒ **最坏情况永远是"一页"**。
  //   ⚠️ 键用 `ctx.session.id`（一次唤醒 = 一个新会话，id 就是会话文件名那个）。
  //   ⚠️ 拿不到会话 id 时**不限制**（宁可照发，也不能因为宿主改字段就把面板全吞掉）。
  if (panelSlotUsed(ctx)) {
    return {
      content: '⚠️ 这次唤醒里**已经直发过一页面板**了，本条没有发到群里（防刷屏）。'
        + '它确实要紧的话，挑最关键的几句用 send_message 说，**不要整页复述**。\n\n（未发出的内容：）\n' + t
    };
  }
  if (ctx?.sender?.sendTextBatch) {
    try {
      await ctx.sender.sendTextBatch(ctx.chatKey, [t]);
      markPanelSent(ctx);          // ⚠️ 只有**真发出去**才记账（失败要退还额度）
      return { content: '内容已直接发到群里。不要再复述、总结或补充。' };
    } catch (error) {
      log(`[travel-whale] 面板发送失败，退回给模型：${error?.message ?? error}`);
    }
  }
  return { content: t };
}

/**
 * 告诉控制台「鲸鱼数据变了」，让「鲸鱼」页立刻刷新。
 * 走核心的 SSE 广播（app.js 的 emit → /api/events）。拿不到服务时静默跳过 ——
 * 这只是个刷新提示，绝不能因为它失败影响主流程。
 */
function notifyUI(chatKey) {
  try { services?.emit?.('whale-update', { chatKey: String(chatKey || ''), at: Date.now() }); }
  catch { /* 提示失败无所谓 */ }
}

/** 发一张图（失败不抛，返回是否成功）。`opts.kind` 规则与 `say` 完全一致 —— 图片只生成一次，多目标复用。 */
async function sayImage(chatKey, filePath, opts = {}) {
  if (!filePath) return false;
  // 与 say() 对齐：没服务时也要留痕，否则"图一张都没发出去"是完全静默的。
  if (!services?.sender?.sendImage) {
    log('[travel-whale] 发送队列不可用，本张图跳过');
    return false;
  }
  let any = false;
  const kind = sayKindOf(opts);
  let firstFan = true;
  for (const to of fanoutTargets(chatKey, opts.broadcast !== false, kind)) {
    // 多目标零间隔连发是明显的风控指纹 —— 首个目标之后逐条随机退避 2~4.5s
    if (!firstFan) await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2500));
    firstFan = false;
    try { await services.sender.sendImage(to, { file: filePath }); any = true; }
    catch (error) { log(`[travel-whale] 发图到 ${to} 失败：${error?.message ?? error}`); }
  }
  return any;
}

/**
 * 「这张明信片的图**真的投出去过**吗」的账本（key = album 条目的 id）。
 *
 * 为什么需要它：album 里的 `image` 只表示"图有本地文件"，**不表示图发出去过** ——
 * 生图成功但发送失败时两者会背离，而"补发"必须知道**到底欠哪几张**。
 * 2026-10-11 实录：补发那次模型只传了 `count: 2`（它自己 thinking 里写"风险是重复"），
 * 结果三张欠图里只补了两张 —— 因为它**没有任何依据判断欠几张**，只能猜。
 *
 * 为什么不写进 album 条目本身：`addPostcard` 是白名单赋值（state.js），改它要重启；
 * 而 `saveState` 落的是**整个对象** ⇒ 放 state 顶层同样持久，且只动本文件、热载即生效。
 */
function markCardDelivered(state, cardId) {
  if (!state || !cardId) return;
  if (!state.cardDelivered || typeof state.cardDelivered !== 'object') state.cardDelivered = {};
  state.cardDelivered[String(cardId)] = Date.now();
}
function deliveredMap(state) {
  const m = state?.cardDelivered;
  return m && typeof m === 'object' ? m : {};
}

/**
 * 「这张卡上**真发生过**什么」的标记本（key = album 条目 id）——★ 2026-10-13 晚新增，
 * 给相册那组称号用（"交手那张" / "被丢过去的那次"）。
 *
 * `state.cardFlags = { [cardId]: { battle, cross } }`。
 * 为什么不塞进 album 条目本身：`addPostcard` 是**白名单赋值**（state.js 是兄弟模块，
 * 改它要重启），而 `saveState` 落的是整个对象 ⇒ 放 state 顶层同样持久、且只动本文件
 * （同 `cardDelivered` 的做法，见它上面的说明）。
 * ⚠️ **旧卡没有这些标记** ⇒ 那两条称号只从这次之后算（跟"初次越界"同理）。
 */
/**
 * ★★ 2026-10-18 v3.20：这张卡属于**哪一趟**（key = album 条目 id，value = 那趟的 departAt）。
 * 为什么不写进 album 条目：`addPostcard` 是白名单赋值（state.js 是兄弟模块，改它要重启），
 * 而 `saveState` 落的是整个对象 ⇒ 放 state 顶层一样持久（同 `cardDelivered` / `cardFlags`）。
 * ⚠️ **老卡片没有这个映射** ⇒ `groupTrips()` 会退回"按时间间隔猜"，见那边的注释。
 */
function noteCardTrip(state, cardId, tripKey) {
  if (!state || !cardId || !tripKey) return;
  if (!state.cardTrip || typeof state.cardTrip !== 'object') state.cardTrip = {};
  state.cardTrip[String(cardId)] = String(tripKey);
}

function cardTripMap(state) {
  const m = state?.cardTrip;
  return m && typeof m === 'object' ? m : {};
}

function noteCardFlags(state, cardId, flags = {}) {
  if (!state || !cardId) return;
  const battle = flags.battle === true;
  const cross = flags.cross === true;
  if (!battle && !cross) return;                 // 什么都没发生就不占地方
  if (!state.cardFlags || typeof state.cardFlags !== 'object') state.cardFlags = {};
  state.cardFlags[String(cardId)] = { battle, cross };
}

// ── 服装系统：去过哪些子区域 / 这一张谁穿什么（2026-10-14）─────────────────
//
//   ⚠️ 「去过」的口径是**两趟都算**（她自己那趟 + 闲置伙伴那趟）——
//     用户明确："解锁条件略微放宽：不要求她本人，旅伴去过也解锁服装"。
//     所以记录点分别落在 `settleTrip` 与 `settleSideTrip` 里（各一次）。
//   ⚠️ 键 = `地区id|子区域名`，子区域名与 `regions.json` 的 `countries[].name` **逐字一致**
//      —— `trip.country` 存的就是它（`trip.city` 是城市、比子区域更细，**别拿它当键**）。

/** 记一笔"到过这个子区域"（幂等：已记过就只保留首次时间）。 */
function markAreaSeen(state, trip) {
  try {
    const rid = String(trip?.regionId || trip?.region || '').trim();
    const area = String(trip?.country || '').trim();
    if (!rid || !area) return false;
    if (!state.areasSeen || typeof state.areasSeen !== 'object') state.areasSeen = {};
    const k = `${rid}|${area}`;
    if (!state.areasSeen[k]) state.areasSeen[k] = Date.now();
    return true;
  } catch { return false; }
}

/**
 * 这一张明信片上**谁穿什么** —— `{ 少女id: 服装id }`，交给 `composePostcard` 的 `outfits`。
 *   ⚠️ 只认**已拥有 + 确实绑给这一位**的（防手改存档把巫女服穿到小猫咪身上）；
 *     没指定 / 不合法的一律**不出现在这个对象里** ⇒ `postcard.js` 那边用默认着装。
 */
function outfitsForCards(state) {
  const w = state?.wardrobe || {};
  const owned = (w.owned && typeof w.owned === 'object') ? w.owned : {};
  const worn = (w.worn && typeof w.worn === 'object') ? w.worn : {};
  const out = {};
  for (const [girl, id] of Object.entries(worn)) {
    const sid = String(id || '');
    // ★ 2026-10-17「借穿旅伴的默认那身」：不需要 owned（它不是商店货），也不受 who 限制；
    //   但要保证被借的那位**确实存在**、且不是她自己（借自己＝默认，没必要记）。
    if (sid.startsWith('default:')) {
      const whom = sid.slice(8);
      if (whom !== girl && OW.WARDROBE_GIRLS.some((x) => x.id === whom)) out[girl] = sid;
      continue;
    }
    const o = OW.outfitOf(sid);
    if (o && owned[o.id] && o.who === girl) out[girl] = o.id;
  }
  return out;
}

/** 「看衣柜」的正文（清单类 —— 走 `replyPanel` 直接发群，别回给模型让它压缩）。 */
function wardrobeText(st) {
  const owned = (st?.wardrobe?.owned && typeof st.wardrobe.owned === 'object') ? st.wardrobe.owned : {};
  const worn = (st?.wardrobe?.worn && typeof st.wardrobe.worn === 'object') ? st.wardrobe.worn : {};
  const seen = (st?.areasSeen && typeof st.areasSeen === 'object') ? st.areasSeen : {};
  const has = (o) => owned[o.id] === true;
  // ⚠️ 解锁判据 = **去过那个子区域**（她自己或旅伴去都算，`areasSeen` 里两趟都记）
  const canBuy = (o) => Boolean(seen[`${o.region}|${o.area}`]);

  const mine = OW.WARDROBE_GIRLS.map((g) => {
    const list = OW.outfitsOf(g.id).filter(has);
    const curId = String(worn[g.id] || '');
    const cur = curId ? OW.outfitOf(curId) : null;
    // 借穿旅伴的默认那身（default:<id>）—— outfitOf 查不到，单独显示
    const borrowed = !cur && curId.startsWith('default:') ? curId.slice(8) : '';
    const curLabel = cur ? `现在穿「${cur.name}」`
      : (borrowed ? `现在穿「${OW.girlName(borrowed)}的默认那身」` : '还穿默认那身');
    return `  ${g.emoji} ${g.name}：${curLabel}`
      + (list.length ? `（已有 ${list.length} 套：${list.map((o) => o.name).join('、')}）` : '（一套都没有）');
  });

  // ★★ 2026-10-15「探索解锁」（用户追加口径）：衣柜**只登"她已经知道的世界"那部分** ——
  //   初期（没去过任何异世界、也没穿越过）这里就是空的 ⇒ 衣柜天然"未解锁"，
  //   与装备网格 / 技能树**同一个口径**（都来自 `visibleRegionIds()`，别各写一套）。
  const visIds = visibleRegionIds(st);
  const visSet = visIds ? new Set(visIds.map(String)) : null;
  const pool = OW.OUTFITS.filter((o) => !visSet || visSet.has(String(o.region)));
  // ⚠️ `got` 按**全量**算：老档 / 手工改档可能存在"已拥有、但那个世界不在可见集里"的套
  //    —— 那种必须照旧算进"已解锁"，不能因为看不见就当没有（同技能树的"已会必须留住"）。
  const got = OW.OUTFITS.filter(has).length;
  const buyable = pool.filter((o) => !has(o) && canBuy(o));
  const locked = pool.filter((o) => !has(o) && !canBuy(o));

  // ★★ 2026-10-17（用户口径）：**衣柜这个功能的解锁条件 = 邀请过旅伴**，
  //   不再是"去过一趟异世界"。
  //   理由：衣柜是"给谁穿什么" —— 一个人都没邀请时它没有意义；
  //   邀请过之后至少能看各位的默认那身、并且**借来穿**（见下面"能借来穿的"）。
  //   ⚠️ 只改**门禁**；柜内每套衣服"能不能买"仍按原判据（去过 / 已拥有），
  //      别把两层混成一个（那正是 §「两套判据」踩过的坑）。
  const invited = ownedCompanionIds(st);            // 已邀请的旅伴 id（不含她自己）
  const borrowables = OW.WARDROBE_GIRLS.filter((g) => g.id !== 'whale' && invited.includes(g.id));

  if (!invited.length && !got) {
    return [
      '👗 衣柜还没开 —— 先在商店里**邀请一位旅伴**（群友说"请一位伙伴"就是），',
      '有人一起出门，衣服才谈得上换。',
      '',
      ...mine,
      '',
      `💰 余额 ${Number(st?.wallet?.plankton) || 0} 亿 TOKEN`
    ].join('\n');
  }

  return [
    `👗 衣柜 —— 一共 ${pool.length} 套，已解锁 ${got} 套`
      + (borrowables.length ? `｜另有 ${borrowables.length} 位的默认那身能借穿` : ''),
    '',
    ...mine,
    '',
    borrowables.length
      ? `🎽 能**借来穿**的（已邀请的旅伴 · 不要钱）：\n`
        + borrowables.map((g) => `  · ${g.name}的默认那身 —— 说"穿${g.name}的默认"`).join('\n')
      : '',
    buyable.length
      ? `🛒 能买的（去过那儿了 · 每套 ${OW.OUTFIT_PRICE} 亿 TOKEN）：\n`
        + buyable.map((o) => `  · ${o.name} —— ${OW.OUTFIT_REGION_NAMES[o.region] || o.region}·${o.area}｜${OW.girlName(o.who)}穿`).join('\n')
      : '🛒 现在没有能买的 —— 先去没去过的地方走一趟（她自己或旅伴去都算）',
    locked.length
      ? `🔒 还没去过、买不了的 ${locked.length} 套：${locked.slice(0, 10).map((o) => o.name).join('、')}${locked.length > 10 ? ' …' : ''}`
      : '',
    '',
    `💰 余额 ${Number(st?.wallet?.plankton) || 0} 亿 TOKEN`
  ].filter((x) => x !== '').join('\n');
}

// ── 寄一张明信片 ──────────────────────────────────────────────────────────

/**
 * 处理"第 index 张明信片"。
 * 一条图 + 一条文字（题字+感想）—— 参考原版：明信片是图和手写话一起的。
 */
/**
 * 组并寄出一张明信片（**不记账** —— 序号与计数由调用方决定）。
 * @param {object} tripLike 需要 city/country/region(regionName)/style/spots
 */
async function postOnce(chatKey, state, tripLike, plan, seq, total, deps, opts = {}) {
  const d = deps || buildDeps(chatKey, state);
  const entry = plan || {};
  // ★★ 2026-10-13 旅伴「特色」：**这张卡上都有谁** ⇒ 谁的特色生效。
  //   鲸鱼那趟看 `companion`，伙伴那趟看 `partners[]`（任一有即算）。
  //   ⚠️ 兼容「新入口 + 旧 state.js」：读不到字段 ⇒ 全为 false（等于没有特色，不报错）。
  const cardTraits = (() => {
    const ids = [tripLike.companion, ...(Array.isArray(tripLike.partners) ? tripLike.partners : [])]
      .map((x) => String(x || '')).filter(Boolean);
    const defs = ids.map((id) => (S.COMPANIONS || {})[id]).filter(Boolean);
    const rand = typeof d.rand === 'function' ? d.rand : Math.random;
    const flopChance = defs.reduce((m, x) => Math.max(m, Number(x.flopChance) || 0), 0);
    // ★ 2026-10-13 藏书阁：建了它 ⇒ 所有的明信片都走"话多"模式
    const longForm = defs.some((x) => x.longCaption === true) || gardenLevel(state, 'library') > 0;
    return {
      longForm,
      // ★★ 2026-10-13 旅伴养成「博览群书」：小书虫练出来之后题字上限 20 → 30 字。
      //   底数：平时 12 字；走"话多"模式 20 字；**她本人同行且练过**才到 30。
      // ★ v3.0：Kimi「誊录」（旅伴技能）⇒ 上限 20 → 28（她替你记下路过的每一句）。
      captionCap: (defs.some((x) => x.id === 'claude') && companionHas(state, 'well-read'))
        ? 30
        : ((defs.some((x) => x.id === 'kimi') && companionHas(state, 'transcribe'))
          ? 28 : (longForm ? 20 : 12)),
      flop: flopChance > 0 && rand() < flopChance
    };
  })();
  // ★★ 2026-10-13 技能树：这一张**发动哪一项风味**（每张只发一项；数值半不受影响）
  const skillFx = pickSkillFlavor(state, tripLike, { rand: (typeof d.rand === 'function' ? d.rand : Math.random) });
  // ★★ 2026-10-14「上下文窗口」：**途中卡轮换出镜** —— 这一张跟谁同框。
  //   · 到家卡（`opts.isReturn`）＝全体合照，不轮换；
  //   · 同行 <2 位（没建扩容）⇒ 就是领头那位 ⇒ 与从前**逐字节一致**；
  //   · 同行 ≥2 位 ⇒ 按 `seq` 轮换，保证每个人都露脸（否则"带了 3 位"却每张都是领头那位）。
  //   ⚠️ 只影响"这一张和谁同框"；**不碰 `cardTraits`**（那看的是整趟带了谁，是全局的）。
  const cardCompanion = (() => {
    const list = (Array.isArray(tripLike.party) ? tripLike.party : [])
      .map((x) => String(x || '')).filter(Boolean);
    if (list.length < 2 || (opts && opts.isReturn)) return tripLike.companion || '';
    return list[(Math.max(1, Number(seq) || 1) - 1) % list.length];
  })();
  const card = await P.composePostcard({
    city: tripLike.city,
    country: tripLike.country,
    region: tripLike.regionName,
    // ★ 2026-10-25 真实照片降级 / 坐标锚点要用的区域键（'europe'…；家/异世界不在真实区表）
    regionKey: String(tripLike.region || ''),
    spot: entry.spot || '',
    scene: entry.scene || '',
    // ★ v4.1：这一张是不是遭遇战、结果是什么（空 = 不是）
    battleOutcome: String(entry.battleOutcome || ''),
    // ★ v4.2：这一张的事件（锁构图 + 一句局势进场景）
    fusion: entry.event ? P.pickEventFusion((typeof d.rand === 'function' ? d.rand : Math.random), entry.event, ((Array.isArray(tripLike.party) && tripLike.party.length >= 2) ? '两位少女' : (tripLike.companion ? '两位少女' : '鲸鱼少女'))) : '',
    scene: [entry.scene || '', entry.event?.line || ''].filter(Boolean).join('；'),
    // ★★ 2026-10-18：这一趟所在世界的**纯视觉速写**（主色/材质/光线/人群）。
    //   拼进生图提示词的「世界」行 —— 在此之前景点卡完全没有地区/作品信息，
    //   模型只能按字面把"帝国皇宫"画成泛泛的白色奇幻城邦。
    world: visualBriefForTrip(tripLike),
    // ★★ 2026-10-18：影调（明度/光源/脏污）—— 没有这一行，世界观会被画成"富丽明亮"
    ...toneForTrip(tripLike),
    // ★ v3.21：这一趟的世界局势（有就用它压过地区影调）
    ...(tripLike?.phase ? {
      situation: String(tripLike.phase.brief || ''),
      ...(tripLike.phase.tone ? { tone: String(tripLike.phase.tone), toneAvoid: String(tripLike.phase.avoid || '') } : {})
    } : {}),
    // 计划里已经定好这张讲景点还是讲特产（见 trip.js 的 planCardContent）
    kind: entry.kind === 'souvenir' ? 'souvenir' : 'spot',
    souvenirs: entry.souvenirs || [],
    // ★ 2026-10-23：这一张**只讲**这几件特产（见 trip.js 的 souvenirFocusOf）。
    //   旧存档 / 热载窗口没有这个字段 ⇒ 空数组 ⇒ postcard 那边退回整批，行为与从前一致。
    souvenirFocus: Array.isArray(entry.souvenirFocus) ? entry.souvenirFocus : [],
    rarity: entry.rarity === 'rare' ? 'rare' : 'common',   // 出门前就抽定的
    style: tripLike.style,
    charStyle: tripLike.charStyle || '',
    // 本趟有没有同行伙伴（''=独自）——有就切到双人提示词
    // ★★ 2026-10-14「上下文窗口」：带多位时这里传的是**这一张轮换到的那位**（见上面的 `cardCompanion`）。
    companion: cardCompanion,
    // ★★ 2026-10-14「上下文窗口」：**到家那张**是"出门的所有人的合照" ⇒ 把这一趟的同行者
    //   （**不含她自己**；postcard.js 会拼成 `['whale', ...party]`）传下去。
    //   ⚠️ 判据用 `opts.isReturn` **而不是 `seq === total`** —— `total` 在途中那条链上
    //     数的是**途中卡张数**，最后一张途中卡也会 `seq === total`，会把它误判成回家卡。
    party: (opts && opts.isReturn) ? (Array.isArray(tripLike.party) ? tripLike.party : []) : [],
    // ★ 闲置伙伴自己去玩那趟：两位伙伴 id ⇒ 走"两位伙伴、**没有鲸鱼**"的提示词
    partners: Array.isArray(tripLike.partners) ? tripLike.partners : [],
    // ★★ 2026-10-14 同那趟的**文案**要"转述"（她在庭院里等，是它们自己去的）⇒
    //   这里把**名字**取好传过去：postcard.js 只有 `COMPANION_CHARACTER`（外观描述）、没有名字表。
    //   ⚠️ 取不到名字就传空数组 ⇒ 那边退回旧口径（不写错、只是不变），
    //     所以"新入口 + 旧 postcard.js"那段热载窗口是安全的。
    partnerNames: (Array.isArray(tripLike.partners) ? tripLike.partners : [])
      .map((id) => (S.COMPANIONS || {})[id]?.name || '').filter(Boolean),
    // ★★ 2026-10-14 她本人此刻在不在外面（两趟互相独立）——
    //   伙伴那趟的文案不能一律写"你留在庭院里等它们"。
    //   这一读是**准的**：同一次 tick 里鲸鱼那段 if 先跑（`state.trip` 已被 settleTrip 清空），
    //   所以"两人恰好同时到家"时这里读到 false = 她刚到家 —— 正是想要的。
    whaleAway: Boolean(state.trip),
    // ★ 该地该遇到的敌手（异世界专用）：非空 ⇒ 融合池里多出两条"战斗构图"
    foe: String(tripLike.foe || ''),
    // ★ 敌手的**外观锚**（异世界专用）：告诉生图模型这东西长什么样 ——
    //   它不联网查资料，只写"虫群/陆战队员"会被画成普通甲虫 / 现代特种兵。
    foeLook: String(tripLike.foeLook || ''),
    seq,
    total,
    // ★★ 2026-10-13 旅伴「特色」：某一张被**指定**了构图（小魔王的战斗明信片）—— 必须透传！
    //   ⚠️ 这里原来是**不传 fusion** 的：于是 composePostcard 只能按"全池随机"抽，
    //      战斗构图（池子里只有 2 条）几乎抽不中 —— 这正是那次老 bug 的形状（另见 postcard.js:803）。
    //   ⚠️ 优先级：`entry.fusion`（小魔王的战斗卡）**高于**技能构图 —— 那张卡是"必定惹事"的，
    //      不能被技能顶掉；技能构图只在没被指定时生效。
    fusion: String(entry.fusion || skillFx?.fusion || ''),
    // ★ 技能树：这一张发动的**感言**（只落感想；`postcard.js` 读它）
    skillNote: String(skillFx?.note || ''),
    // ★★ 2026-10-13 旅伴养成：题字上限（平时 12 / 话多 20 / 小书虫练过 30）
    captionCap: cardTraits.captionCap,
    // ★★ 旅伴养成「龙语」：同行的是小白龙、且她练出来了 ⇒ 战斗那张她会吼一句龙语。
    //   ⚠️ 由 `postcard.js` 判"这张是不是战斗卡"（battle 只有它知道），这里只把话递过去。
    companionNote: companionNoteFor(state, tripLike),
    // ★ 旅伴「特色」：小书虫「话多」（题字更长）+ 小猫咪「翻车」（约 10% 答非所问）
    longForm: cardTraits.longForm,
    flop: cardTraits.flop,
    whaleName: String(cfg().whaleName || '小鲸鱼'),
    timeText: new Date().toLocaleString('zh-CN', { hour12: false }),
    // ★ 2026-10-14 服装系统：这一张上**谁穿什么**（没换装 ⇒ 空对象 ⇒ 全部默认，与从前逐字一致）
    outfits: outfitsForCards(state)
  }, cardDeps(d));

  // ★★ 2026-10-13「随机事件影响心情」：把这张**真的发生了什么**记下来（sleep-mood 会取走结算）。
  //   ⚠️ `card.battle` 是新 postcard.js 才返回的字段 —— 旧模块下是 undefined ⇒ 不记（安全降级）。
  //   ★★ 2026-10-14：**事件必须标明是哪一趟的** ——「伙伴自己出去玩」那趟也走这条寄卡路径，
  //     而它的 `where` 是**伙伴们去的地方**。不标归属，日记素材会把伙伴的经历写成她的。
  //   ⚠️⚠️ 判据**绝不能用 `tripLike !== state.trip`** —— 卡片是**压着发的**：
  //     她夜里到家时 `settleTrip` 把播报塞进 `state.pending`，第二天早上（`!isNight`）才逐条发；
  //     那一刻 `state.trip` 早被清空（或已换成新的一趟）⇒ **她那趟的卡会被误判成"伙伴那趟"**
  //     （用户实测抓到：02:37 到家的那趟、07:01 才发的那张卡，被错标成了伙伴的）。
  //   ⇒ 用**对象自己身上的标记**：伙伴那趟在规划时就打了 `side: true`（见 trimSidePlan）。
  const evBy = (tripLike && tripLike.side === true) ? { by: 'mates' } : {};
  if (card.battle) {
    pushMoodEvent(state, 'battle-card', { where: placeLabel(tripLike), foe: String(tripLike.foe || ''), ...evBy });
  }
  if (card.rarity === 'rare') pushMoodEvent(state, 'rare-card', { where: placeLabel(tripLike), ...evBy });
  if (cardTraits.flop) pushMoodEvent(state, 'flop', { where: placeLabel(tripLike), ...evBy });

  // ★★ 2026-10-21「播报分类」：明信片（图 + 题词 + 感想）＝ `journey` ⇒ 按投递名单扇出。
  //   ⚠️ 用 `{ ...opts, kind }` 而不是直接写 `{ kind }`：`opts` 里还带着 `isReturn`
  //      （postcard.js 靠它认"到家卡"）和手工路径的 `broadcast:false`，都不能丢。
  const cardSayOpts = { ...opts, kind: 'journey' };
  // ★ 2026-10-25「明信片带经纬度」：目的地的现实坐标（3 位小数＝约100m，隐私纪律）。
  //   家/异世界/查不到 ⇒ null ⇒ 不带这行；区域中心兜底标"（约）"。缓存命中后零开销。
  const coordLine = await RW.coordsFor(
    { country: tripLike.country, city: tripLike.city, regionKey: tripLike.region },
    { allowNetwork: true }
  ).then((c) => (c ? `\n📍 ${c.lat}°N, ${c.lon}°E${c.estimated ? '（约）' : ''}` : '')).catch(() => '');
  let imgSent = false;
  if (card.imagePath) imgSent = await sayImage(chatKey, card.imagePath, cardSayOpts);
  // 题字 + 感想合成一条；题字短、感想长，用换行分开
  // ⚔️ 前缀：让小魔王的"惹事"那张一眼可辨（与 ✨ 稀有标记同理，纯标记不改文案）
  // ★ 真实照片顶替时把署名行缀在最后（版权纪律：用真实图必带来源）
  const creditLine = card.imageCredit ? `\n${card.imageCredit}` : '';
  await say(chatKey, (entry.rage ? '⚔️ ' : '') + (card.captionOut || card.caption) + '\n' + card.thought + creditLine + coordLine, cardSayOpts);

  const added = S.addPostcard(state, {
    city: tripLike.city, country: tripLike.country, region: tripLike.region,
    spot: entry.spot || '', style: tripLike.style,
    kind: entry.kind === 'souvenir' ? 'souvenir' : 'spot',
    souvenirs: entry.souvenirs || [],
    souvenirFocus: Array.isArray(entry.souvenirFocus) ? entry.souvenirFocus : [],
    rarity: card.rarity === 'rare' ? 'rare' : 'common',
    charStyle: tripLike.charStyle || '',
    companion: tripLike.companion || '',
    imageError: String(card.imageError || ''),   // 非空 = 这张没配图的原因
    caption: card.caption, thought: card.thought, image: card.imagePath,
    credit: String(card.imageCredit || '')   // ★ 真实照片署名（生图 = 空）
  });
  // ★ v3.20：记下"这张属于哪一趟"（相册按趟分页要用）
  noteCardTrip(state, added?.id, String(tripLike.departAt || tripLike.returnAt || ''));
  // 图**真投出去了**才记账（生图成功 ≠ 发得出去，两件事必须分开）
  if (imgSent) markCardDelivered(state, added?.id);
  // ★ 2026-10-13 晚：把"这张卡上真发生了什么"记进 `state.cardFlags`（相册那组称号要）。
  //   `card.battle` 只有新 postcard.js 才返回、`tripLike.crossedOver` 一直都在 —— 取不到就是 false。
  noteCardFlags(state, added?.id, { battle: card.battle === true, cross: tripLike.crossedOver === true });
  // ★★ 2026-10-14「留守的旅伴来评论」（§115）：**卡已经发出去了**，才轮到评论。
  //   ★ 2026-10-21：评论跟着**这张卡**走 —— 所以传的是 `cardSayOpts`（kind=journey），
  //     否则投递名单里其它群会看到一张"没有评论"的卡，而「家」多一句，看起来像丢消息。
  //   ⚠️ 必须 try/catch 包住 —— 评论是锦上添花，模型抽风/发送失败都**不许**影响明信片本身
  //      （更不能让异常冒到 tick 里，那会打断整轮推进）。
  try {
    await commentOnPostcard(chatKey, state, tripLike, entry, card, cardSayOpts, d);
  } catch (e) {
    log(`[travel-whale] 明信片评论失败（不影响正片）：${e?.message ?? e}`);
  }
  return true;
}

/**
 * 途中第 index 张明信片。
 * @param {'trip'|object} [which] 哪一趟：默认鲸鱼那趟（`'trip'`），多趟化后传**趟对象**。
 */
async function sendCard(chatKey, state, index, deps, which = 'trip') {
  const trip = tripRefOf(state, which);
  if (!trip) return false;
  const isSide = trip !== state.trip;                 // 判"是不是伙伴那趟"改看对象本身
  // 寄什么在出门前就定好了（cardPlan）；这里只按序号取，不再临时算
  const plan = Array.isArray(trip.cardPlan) ? trip.cardPlan : [];
  const entry = plan[index] || { kind: 'spot', spot: '', scene: '' };
  const total = trip.cardTimes.length;
  await postOnce(chatKey, state, trip, entry, index + 1, total, deps);
  trip.cardsSent = index + 1;
  log(`[travel-whale] ${chatKey} 寄出${isSide ? '伙伴' : ''}途中第 ${index + 1}/${total} 张（${trip.city}·${String(entry.spot || entry.kind)}）`);
  return true;
}

/**
 * 到家时**额外**寄一张。
 *
 * 需求是「到家之后反馈明信片和特产」，所以这张不计入 trip.cardTimes ——
 * 那是「途中」的张数，出行前就定死了（小份 1~2 / 中份 2~3 / 大份 2~4）。
 * 用旅程里最后一个景点，序号接在途中那些之后。
 */
async function sendReturnCard(chatKey, state, tripLike, deps) {
  const plan = Array.isArray(tripLike.cardPlan) ? tripLike.cardPlan : [];
  const mid = Array.isArray(tripLike.cardTimes) ? tripLike.cardTimes.length : 0;
  // 到家那张在计划里是最后一条；景点不够时它已经被安排成「特产明信片」
  const entry = plan[plan.length - 1] || { kind: 'spot', spot: '', scene: '' };
  // ★ 2026-10-14「上下文窗口」：`isReturn` 是**唯一**能把这张认成"到家卡"的判据
  //   （`seq === total` 在途中那条链上会误判，见 postOnce 里的注释）。
  await postOnce(chatKey, state, tripLike, entry, mid + 1, mid + 1, deps, { isReturn: true });
  log('[travel-whale] ' + chatKey + ' 寄出到家明信片（' + tripLike.city + '·' + String(entry.spot || entry.kind) + '）');
  return true;
}

// ── 归来结算 ──────────────────────────────────────────────────────────────

/** 给稀有特产生成图鉴图（失败返回空字符串，图鉴仍记文字）。 */
async function makeSouvenirImage(chatKey, trip, name, deps, { outfits = null, charStyle = '' } = {}) {
  try {
    // ★★ 2026-10-14 谁带回来的谁捧着（原来**写死鲸鱼**）。
    //   伙伴那趟与鲸鱼那趟**互相独立**（tick 里是两个并列的 if）⇒ 伙伴到家那一刻，
    //   她本人可能还在外面 —— "她捧着展示"于是经常是荒谬的。分流逻辑收在 postcard.js 的
    //   `buildSouvenirPrompt`（伙伴的外观描述表 `COMPANION_CHARACTER` 住在那儿）。
    //   ⚠️ 包装降级：postcard.js 是兄弟模块，热载期可能是"新 index + 旧 postcard" ⇒
    //     那时新函数不存在，退回与改动前**逐字等价**的旧拼法（不裸调，免 TypeError）。
    const prompt = (typeof P.buildSouvenirPrompt === 'function')
      ? P.buildSouvenirPrompt({
        name,
        partners: Array.isArray(trip.partners) ? trip.partners : [],
        scene: `${placeLabel(trip)} 的标志性背景`,
        style: trip.style,
        // ★ 2026-10-26：图鉴图与明信片**同一套人设** —— 谁穿什么、这一趟什么人物画法。
        //   原来这两维没传 ⇒ 同一趟里明信片是换装后的样子、特产图却是默认着装 + 默认笔触。
        outfits,
        charStyle,
        // ★ 2026-10-18：图鉴图也带世界基调（不然那件东西会飘在泛泛背景里）
        regionName: trip.regionName || '',
        world: visualBriefForTrip(trip),
        ...toneForTrip(trip),
        ...(trip?.phase ? {
          situation: String(trip.phase.brief || ''),
          ...(trip.phase.tone ? { tone: String(trip.phase.tone), toneAvoid: String(trip.phase.avoid || '') } : {})
        } : {})
      })
      : [
        P.WHALE_CHARACTER,
        ...(charStyle ? [`人物画法：${charStyle}`] : []),
        `动作：捧着「${name}」`,
        `场景：${placeLabel(trip)} 的标志性背景`,
        `风格：${trip.style}`,
        `构图：以「${name}」为主体，鲸鱼少女只拿这一样东西，居中特写，无文字水印`,
        ...(typeof P.anatomyHint === 'function' ? [P.anatomyHint()] : []),
        P.NEGATIVE_HINT
      ].join('\n');
    const res = await deps.imageGen(prompt);
    if (res?.ok && Array.isArray(res.images) && res.images.length) {
      return await P.makeImageSaver(chatKey, { subdir: 'souvenirs', log })(res.images[0]);
    }
  } catch (error) {
    log(`[travel-whale] 特产图生成失败：${error?.message ?? error}`);
  }
  return '';
}

/**
 * 这一趟的特产入图鉴 —— **鲸鱼那趟与伙伴那趟共用这一份**（原来两段复制粘贴）。
 *
 * ★★ 2026-10-26：稀有特产图**只在第一次拿到时画**。原来无条件画一张、
 *   再交给 `addSouvenir` —— 而它见到 `prev.image` 就**不覆盖** ⇒ 重复带回的稀有特产
 *   每次白花一次生图，落一地没有任何条目引用的图（线上实测 14 张里 4 张没人引用）。
 *   README 的规矩本来也是「重复获得只累加计数，不再出图」。
 *
 * @returns {Promise<{parts:string[], images:Array<{name:string,image:string}>}>}
 *   `images` = **这一趟新画出来的**（调用方负责在归家播报后发出去）
 */
async function recordTripSouvenirs(chatKey, state, trip, deps) {
  const parts = [];
  const images = [];
  const outfits = outfitsForCards(state);
  const charStyle = String(trip.charStyle || '');
  for (const s of trip.souvenirs || []) {
    const key = String(s.name || '').trim();
    const prev = (key && state.souvenirs && typeof state.souvenirs === 'object')
      ? state.souvenirs[key] : null;
    let image = '';
    if (s.isRare && !prev?.image) {
      image = await makeSouvenirImage(chatKey, trip, s.name, deps, { outfits, charStyle });
      if (image) images.push({ name: key, image });
    }
    const r = S.addSouvenir(state, {
      name: s.name, city: trip.city, country: trip.country,
      rarity: s.isRare ? 'rare' : (s.label || 'common'),
      // ★ 2026-10-14：模型打标的分类（food/plant/relic）—— 决定它能不能吃、能不能种。
      kind: s.kind || '',
      // ★★ v3.2 特产批注（Kimi「博闻」）：抽特产时顺带要的那一行，进图鉴的 `desc`。
      //   `addSouvenir` **只在新建条目时写 desc**（重复带回会更新 count/stock，但不覆盖批注）
      //   ⇒ 一件特产的第一行批注 = 第一次带回来的那一趟，之后不再改。
      desc: s.note || '',
      image
    });
    // 三档各有各的标记：rare 明确标出、uncommon 带 ✦、common 什么都不加。
    const label = s.isRare ? 'rare' : String(s.label || 'common');
    const mark = s.isRare ? '（稀有！）' : (label === 'uncommon' ? '✦' : '');
    const cnt = (!s.isRare && !r.isNew) ? `×${r.entry?.count}` : '';
    parts.push(`${s.name}${mark}${cnt}`);
  }
  return { parts, images };
}

/** 把这一趟**新画出来**的稀有特产图发出去（失败不打断后面的播报）。 */
async function sendSouvenirImages(chatKey, images, kind = 'journey') {
  for (const it of (Array.isArray(images) ? images : [])) {
    const file = String(it?.image || '');
    if (!file) continue;
    try { await sayImage(chatKey, file, { kind }); }
    catch (error) { log(`[travel-whale] 稀有特产图发送失败：${error?.message ?? error}`); }
  }
}

/**
 * 旅程结束：记到访 → 特产入图鉴 → 称号 → 播报 → 归位。
 * 顺序有讲究：先落数据再播报，播报失败不影响数据。
 */
export async function settleTrip(chatKey, state, deps) {
  const trip = state.trip;
  if (!trip) return null;
  const d = deps || buildDeps(chatKey, state);

  // ★ v3.18 ①：到家也自动收一次 —— 顺带把余额刷新，归来播报里的数字才是新的
  const harvested = autoHarvest(state, '归来');

  // ① 到访（城市 + 景点两套）
  S.recordVisit(state, {
    city: trip.city, country: trip.country, region: trip.region,
    source: trip.source || 'pool',
    spots: (trip.spots || []).map((s) => s.name)
  });

  // ── ★★ v4.1 遭遇战结算（必须在特产入图鉴**之前**：吃亏要当场扣掉一件）──
  const battleLog = [];
  try {
    const sent = (Array.isArray(trip.cardPlan) ? trip.cardPlan : [])
      .slice(0, Number(trip.cardsSent) || 0);
    for (const c of sent) {
      const oc = String(c?.battleOutcome || '');
      if (!oc) continue;
      const where = placeLabel(trip);
      const foe = String(trip.foe || '');
      if (oc === 'win') {
        pushMoodEvent(state, 'battle-win', { where, foe });
        battleLog.push('压制');
        // 「符卡宣言」：压制时多带一件（复制这一趟第一件特产）
        if (skillOwned(state)['spell-declare'] && Array.isArray(trip.souvenirs) && trip.souvenirs.length) {
          const pick = trip.souvenirs[0];
          trip.souvenirs.push({ ...pick });
          battleLog.push('（符卡宣言：多带一件）');
        }
      } else if (oc === 'lose') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const i = list.findIndex((s) => !s.isRare);
        const cut = i >= 0 ? list.splice(i, 1)[0] : list.pop();
        if (cut) {
          battleLog.push(`吃亏（丢了「${cut.name}」）`);
        } else {
          state.wallet.plankton = Math.max(0, (Number(state.wallet?.plankton) || 0) - 100);
          battleLog.push('吃亏（没东西可丢，掉了 100 亿 TOKEN）');
        }
        pushMoodEvent(state, 'battle-lose', { where, foe });
      } else {
        pushMoodEvent(state, 'battle-card', { where, foe });
        battleLog.push('平手');
      }
    }
    if (battleLog.length) log(`[travel-whale] 遭遇结算：${battleLog.join('、')}`);
  } catch (error) {
    log(`[travel-whale] 遭遇结算失败：${error?.message ?? error}`);
  }

  // ── ★★ v4.2 事件结算（同样放在特产入图鉴之前）──
  try {
    const sentE = (Array.isArray(trip.cardPlan) ? trip.cardPlan : [])
      .slice(0, Number(trip.cardsSent) || 0);
    for (const c of sentE) {
      const ev = c?.event;
      if (!ev) continue;
      const where = placeLabel(trip);
      pushMoodEvent(state, ev.mood === 'good' ? 'event-good' : 'event-bad', { where, event: ev.name });
      const type = String(ev.effect?.type || 'none');
      if (type === 'bonus-souvenir') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const pick = list.find((s) => !s.isRare) || list[0];
        if (pick) { trip.souvenirs.push({ ...pick }); battleLog.push(`${ev.name}（多带一件）`); }
        else battleLog.push(ev.name);
      } else if (type === 'lose-souvenir') {
        const list = Array.isArray(trip.souvenirs) ? trip.souvenirs : [];
        const i = list.findIndex((s) => !s.isRare);
        const cut = i >= 0 ? list.splice(i, 1)[0] : list.pop();
        if (cut) battleLog.push(`${ev.name}（丢了「${cut.name}」）`);
        else {
          state.wallet.plankton = Math.max(0, (Number(state.wallet?.plankton) || 0) - 100);
          battleLog.push(`${ev.name}（没东西可丢，掉了 100 亿）`);
        }
      } else {
        battleLog.push(ev.name);
      }
    }
  } catch (error) {
    log(`[travel-whale] 事件结算失败：${error?.message ?? error}`);
  }

  // ② 特产入图鉴（稀有的才配图；重复带回的**不再重画**，见 recordTripSouvenirs）
  const { parts, images: souvenirImages } = await recordTripSouvenirs(chatKey, state, trip, d);

  // ③b ★★ 2026-10-13 旅伴养成：记下"这位伙伴陪她到过哪些异世界"（旅伴技能的门槛就数这个）。
  //   只在**真的到了**才记（这里 = 归来结算）；穿越到的地方也算 —— 那确实到过。
  //   ⚠️ 只认异世界（`regionFictional`），现实地区不算"走过一个世界"。
  if (trip.regionFictional === true && trip.companion) {
    const cid = String(trip.companion);
    const rid = String(trip.regionId || '');
    if (rid) {
      state.whale = state.whale || {};
      const all = (state.whale.companionWorlds && typeof state.whale.companionWorlds === 'object')
        ? state.whale.companionWorlds : (state.whale.companionWorlds = {});
      const cur = Array.isArray(all[cid]) ? all[cid].map(String) : [];
      if (!cur.includes(rid)) all[cid] = [...cur, rid];
    }
  }

  // ③c ★ 2026-10-26（主人口径）：**累计同行趟数** + **城市足迹**（面板「旅伴档案 / 同行足迹」用）。
  //   与 ③b 刻意分开，互不影响：
  //     · ③b `companionWorlds` 只记**带路的那位**、且按"去过几个不同异世界"去重 —— 旅伴技能门槛数它；
  //     · ③c 记**这一趟所有同行的人**（trip.mates），且**按趟累加**（同一世界去两次算两趟）。
  //   ⇒ 换口径不会动摇技能解锁；面板两栏各说各的（"带路去过 N 个异世界" / "一共同行 M 趟"）。
  //   只认异世界（regionFictional），与 ③b 一致；现实城市不计入"异世界同行"。
  if (trip.regionFictional === true) {
    const partyIds = (Array.isArray(trip.mates) && trip.mates.length
      ? trip.mates.map((m) => String(m?.id || m || ''))
      : [String(trip.companion || '')]).filter(Boolean);
    const rid = String(trip.regionId || '');
    const city = String(trip.city || '');
    if (partyIds.length) {
      state.whale = state.whale || {};
      const trips = (state.whale.compTrips && typeof state.whale.compTrips === 'object')
        ? state.whale.compTrips : (state.whale.compTrips = {});
      const foot = (state.whale.mateCities && typeof state.whale.mateCities === 'object')
        ? state.whale.mateCities : (state.whale.mateCities = {});
      for (const cid of partyIds) {
        trips[cid] = (Number(trips[cid]) || 0) + 1;
        if (!city) continue;
        const bucket = (foot[cid] && typeof foot[cid] === 'object') ? foot[cid] : (foot[cid] = {});
        const key = `${rid}|${city}`;
        const prev = bucket[key] || {};
        bucket[key] = {
          regionId: rid,
          city,
          country: String(trip.country || ''),
          n: (Number(prev.n) || 0) + 1,
          firstAt: Number(prev.firstAt) || Date.now(),
          lastAt: Date.now()
        };
      }
    }
  }

  // ③ 单趟特产数（"满载而归"）
  const n = (trip.souvenirs || []).length;
  state.stats.maxSouvenirsPerTrip = Math.max(Number(state.stats.maxSouvenirsPerTrip) || 0, n);

  // ④ 称号
  S.refreshStats(state);
  const newTitles = TI.evaluateTitles(state, titleCtx());
  TI.markTitles(state, newTitles);

  // ⑤ 组播报文案（先组好，发给谁/什么时候发由下面决定）
  const where = `${placeLabel(trip)}`;
  const souvText = parts.length ? `带回来的东西：${parts.join('、')}` : '这趟什么也没带回来';
  const harvestText = harvested > 0 ? `\n（顺手收了 ${harvested} 亿 TOKEN）` : '';
  const battleText = battleLog.length ? `\n⚔️ 路上：${battleLog.join('，')}` : '';
  const lines = [`🐋 我回来啦。这趟去了 ${where}。\n${souvText}${harvestText}${battleText}`];
  // ★★ 2026-10-21「播报分类」：`lines` 现在**只装归家播报本身**（journey ⇒ 按投递名单扇出）；
  //   稀有奖励 / 罕见特产注 / 称号解锁 落进 `sysLines`（system ⇒ 只发回「家」）。
  //   用户原话：「购买、邀请、成就等系统信息不再播报，避免刷屏」—— 称号就是"成就"那一类。
  //   ⚠️ 两段**顺序不变**（先归家播报、再奖励与称号），只是各自走各自的扇出规则。
  const sysLines = [];
  // ── 稀有收获奖励 ──
  // 明信片那边用 cardPlan 数（出门前就定死了稀有度），只算**真的寄出去**的：
  //   途中 = 前 cardsSent 张；到家那张固定是计划里的最后一条。
  const sentPlan = [
    ...(trip.cardPlan || []).slice(0, Number(trip.cardsSent) || 0),
    ...(trip.cardPlan || []).slice(-1)
  ];
  const rareSouvCount = (trip.souvenirs || []).filter((x) => x.isRare).length;
  const rareCardCount = sentPlan.filter((x) => x && x.rarity === 'rare').length;
  // ★ 维斯特洛「有债必偿」：奖励金额 ×3（+50/+20 → +150/+60）。
  //   读的是 `syncSkillNumbers` 落下的**纯数字**（老存档没有这个字段 ⇒ 退回 1 ⇒ 与从前一致）。
  const rewardMult = Math.max(1, Number(state?.whale?.rareRewardMult) || 1);
  const reward = (rareSouvCount * REWARD_RARE_SOUVENIR + rareCardCount * REWARD_RARE_CARD) * rewardMult;
  if (reward > 0) {
    S.grantPlankton(state, reward);
    const bits = [];
    if (rareSouvCount) bits.push('稀有特产 ×' + rareSouvCount);
    if (rareCardCount) bits.push('稀有明信片 ×' + rareCardCount);
    sysLines.push('✨ 这趟撞上' + bits.join('、') + '，额外捡到 ' + reward + ' 亿 TOKEN');
  }

  const uncommons = (trip.souvenirs || []).filter((x) => !x.isRare && x.label === 'uncommon');
  if (uncommons.length) sysLines.push('（✦ 是罕见特产 —— 比普通货色稀罕一点）');
  for (const t of newTitles) sysLines.push(`${t.icon} 解锁称号：${t.name}（+${t.points || 0} 成就值）—— ${t.desc}`);

  // ⑥ 留一份「旅程快照」——存档里的 trip 马上就要清掉，但夜里压住的那张
  //    到家明信片要等到早上才生成，得靠它才能取到城市/景点/画风。
  //
  // ★★ 2026-10-13 修（用户报障「早上到家那张明信片里狐狸不见了」）：
  //    原来这里是**手动挑字段**的白名单，只抄了 8 个字段、**漏掉 `companion`** ⇒
  //    到家那张明信片（**白天直接发**和**夜里压到早上补发**，两条路都用这份快照）
  //    在 `composePostcard` 里 `duo = Boolean(pt.companion)` 被判定成**单人** ⇒
  //    提示词走单人路径 ⇒ **一路同行的伙伴在画面里消失**。
  //    ⚠️ 同一文件里「闲置伙伴那趟」（sideTrip）的 snapshot 是 `{ ...trip }` **全量拷贝**，
  //       两者本该同构（下面补发段那句注释就是这么写的）—— 现在才真的同构。
  //    ⚠️ 漏掉的不止 companion：`charStyle`（人物画法）、`foe`/`foeLook`（异世界敌手）、
  //       `regionId`/`regionFictional`/`foeKind`/`missingTraits` 也全丢了 —— 全量拷贝一次修齐。
  //    ⚠️ 教训：**中间层只解构一部分字段 = 静默失效**（本项目的老坑，这是又一次）。
  const snapshot = {
    ...trip,
    spots: trip.spots || [], cardTimes: trip.cardTimes || [], cardPlan: trip.cardPlan || []
  };

  // ★★ 2026-10-13「随机事件影响心情」：这趟的结果记两笔
  //   （带回稀有特产 = 好事；平平安安到家 = 小确幸）。地点用她真去过的那里，why 才具体。
  {
    const where = placeLabel(trip);
    const rareN = (trip.souvenirs || []).filter((x) => x.isRare).length;
    if (rareN > 0) pushMoodEvent(state, 'rare-souvenir', { where, n: rareN });
    pushMoodEvent(state, 'trip-home', { where });
  }

  // ⑦ 归位（数据先落定，说话可以晚点再说）
  // ★ 2026-10-14 服装系统：她这趟到过的**子区域**记一笔（解锁服装要用；两趟都算）
  markAreaSeen(state, trip);
  state.whale.charm = '';          // 护身符单趟生效，回家即失效
  state.trip = null;
  // ★★ 2026-10-13 step4「在家的大合照」：记下**到家时刻**并清掉上一趟的拍摄标记。
  //    判据是「在家待满 N 小时（默认 8）且这一趟还没拍过」⇒ 每趟回家只拍 1 张，
  //    下一趟到家会自动重置。夜里那支（压到早上补发）也走这里 —— 所以"在家时间"
  //    从**真实到家时刻**起算，而不是从播报时刻起算（用户口径："在家的时间"）。
  state.homeSince = Date.now();
  state.homeShotAt = 0;

  // ⑧ 到家反馈 = **一张明信片 + 播报**。
  //    夜里到家不吵人：两样一起压到早上 7 点后补发。
  //    ⚠️ 顺带一个副作用是**刻意**的：下次自动出发的基准是「播报真正发出的时刻」
  //       + **休息区间**（默认 24~48 小时，见 `restRange()`），不是「到家时刻」。压住期间 nextDepartAt 置 0，
  //       shouldAutoDepart 会拦住它，不会偷偷溜走。
  const now = Date.now();
  if (E.isNight(now)) {
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    // ★ 2026-10-21：`kind:'return'` 是"待补发事项的种类"（老字段，别动）；
    //   `sayKind:'journey'` 才是"补发时按哪一类扇出"（新字段，见 `pendingSayKind`）。
    //   `sysLines` 只在老存档里缺失 ⇒ 消费端按"没有"处理，不会抛错。
    state.pending.push({ kind: 'return', sayKind: 'journey', snapshot, lines, sysLines, images: souvenirImages, queuedAt: now });
    state.nextDepartAt = 0;
    log('[travel-whale] ' + chatKey + ' 凌晨到家，明信片与播报压到 7 点后补发');
  } else {
    try { await sendReturnCard(chatKey, state, snapshot, d); }
    catch (error) { log('[travel-whale] 到家明信片失败：' + (error?.message ?? error)); }
    // ★ 2026-10-21：归家播报 ＝ journey（扇出到投递名单）；奖励与称号 ＝ system（只发回家）
    for (const line of lines) await say(chatKey, line, { kind: 'journey' });
    // ★★ 2026-10-26：稀有特产图**跟归家播报一起发**。此前它只被写进 `state.souvenirs[].image`，
    //   图鉴页也不显示、没有任何工具能调它 ⇒ 生成完就"消失"（用户报的就是这个）。
    await sendSouvenirImages(chatKey, souvenirImages, 'journey');
    for (const line of sysLines) await say(chatKey, line, { kind: 'system' });
    // 私聊永不自发出发，就不必排下次；群聊才排（播报时刻 + 休息区间）。
    // ★ 回家后的休息区间走 `restRange()`（默认 24~48 小时；可在技能设置里改）——
    //   这样"她在家的时间"不再是回家后的零头。两条自动出门共用 `E.nextDepartAt`。
    state.nextDepartAt = isPrivateChat(chatKey) ? 0 : E.nextDepartAt(now, Math.random, restRange());
  }

  log(`[travel-whale] ${chatKey} 旅程结束：${where}，特产 ${n} 件，新称号 ${newTitles.length} 个`);
  return { where, souvenirs: parts, newTitles };
}

// ── ★★ 在家的大合照（2026-10-13 大更新 step4）──────────────────────────────
//
// 用户口径（原话）：「我希望她在家的时候也发'明信片'——拍大合照。每次【回到家并且在家的
//   时间达到 8 小时后】，和所有在家的 AI 娘拍【1】张 大合照，用那种'举着镜头自拍'的感觉，
//   拍**画幅和旅行明信片不同的横板**大合照。」
//
// 与旅行明信片的关系：**共用发送链路（`sayImage` 扇出 + `say`）与相册**，只有三处不同 ——
//   ① **画幅**：横板（`H.HOME_SHOT_SIZE`，1536x1024），而旅行明信片是设置里的方板；
//   ② **提示词**：`home.js` 的 `buildGroupPrompt`（庭院外观 + 星空 + 自拍构图 + N 人解剖约束）；
//   ③ **相册记 `kind:'home'` 且不进旅行统计**（`countStat:false`）——「已寄明信片 N 张」数的是
//      旅行进度，把家拍混进去会让称号失真（它确实进相册，日记配图照样会挑到它）。
//
// ⚠️ 失败策略与明信片一致：**生图失败 / 文案失败都不抛**，能发的部分照发（图没有就纯文字），
//   而且**一定要把 homeShotAt 打上** —— 否则生图一挂，每个 tick 都会重试一次（刷屏）。
async function shootHomeGroup(chatKey, state, deps) {
  const d = deps || buildDeps(chatKey, state);
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const members = HM.homeMembers(state);
  const names = HM.memberNames(members, cfg().whaleName);
  const style = HM.pickHomeStyle(rand);
  const charStyle = P.pickCharacterStyle(rand);
  const prompt = HM.buildGroupPrompt({ members, style, charStyle, rand });
  const size = String(cfg().homeShotSize || HM.HOME_SHOT_SIZE);

  let imagePath = '';
  let imageError = '';
  try {
    const res = await d.imageGen(prompt, { size });
    if (res?.ok && Array.isArray(res.images) && res.images.length) imagePath = await d.saveImage(res.images[0]);
    else imageError = String(res?.error ?? '生图未返回图片');
  } catch (error) { imageError = String(error?.message ?? error); }

  // 文案：解析形状与旅行明信片一致（只要 {caption, thought}），坏了就用兜底，保证一定有字
  let caption = '庭院大合照';
  let thought = `${names.join('、')}都在 —— 今晚的星星很清楚。`;
  if (typeof d.llm === 'function') {
    try {
      const raw = await d.llm(HM.buildHomeCaptionPrompt({
        names,
        whaleName: String(cfg().whaleName || '小鲸鱼'),
        atText: new Date().toLocaleString('zh-CN', { hour12: false })
      }));
      const m = String(raw ?? '').match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : null;
      if (parsed?.caption) caption = String(parsed.caption).trim().slice(0, 20);
      if (parsed?.thought) thought = String(parsed.thought).trim();
    } catch (error) {
      log('[travel-whale] 合照文案生成失败，用兜底：' + (error?.message ?? error));
    }
  }

  let imgSent = false;
  if (imagePath) imgSent = await sayImage(chatKey, imagePath);
  await say(chatKey, caption + '\n' + thought);

  const added = S.addPostcard(state, {
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME, spot: '庭院大合照',
    style, charStyle, kind: 'home', members,
    caption, thought, image: imagePath
  }, { countStat: false });
  if (imgSent) markCardDelivered(state, added?.id);
  // ★★ 2026-10-13「随机事件影响心情」：拍大合照是**好事**（她本来就为这个玩法高兴）。
  pushMoodEvent(state, 'home-photo', { who: names.join('、') });
  state.homeShotAt = Date.now();     // ★ 无论图出没出都要打上（见函数头那条说明）
  log(`[travel-whale] ${chatKey} 拍了庭院大合照：${names.join('、')}（${names.length} 人，${size}）`
    + (imageError ? `｜图失败：${imageError}` : ''));
  return { ok: true, members, names, imagePath, imageError, style, prompt };
}

// ── ★★ 闲置伙伴「自己去玩」（2026-10-11 用户需求）──────────────────────────
//
// 与鲸鱼那趟的关系：**复用同一套挑城 / 搜索 / 抽取链路**，但出口口径是另一套：
//   · 只有**没被鲸鱼带着**的伙伴才会自己出门，而且必须**凑够两人一组**；
//   · 一次从背包里**拿走 2 份**同档米饭，去玩**该档口粮对应的时间**；
//   · ⚠️ **门槛：那一档必须已有 ≥ 6 份**才允许动 —— 留足给鲸鱼，别把存粮吃空；
//   · 途中明信片**按档固定**（小 0 / 中 0 / 大 1 张），到家**再** 1 张；
//   · 到家固定**只带 1 件特产**；
//   · 出门时**同样有概率穿越**（与鲸鱼共用 `crossOverChance`）；
//   · 城市/景点**不记进 `visitedCities`**（那是鲸鱼自己的足迹），但特产**进图鉴**。

/** 闲置伙伴出门用哪一档饭：从大份往下找**库存 ≥ foodFloor（默认 6）**的那一档。 */
function sideTripTier(state) {
  const floor = Number(S.SIDE_TRIP?.foodFloor) || 6;
  for (const t of ['large', 'normal', 'small']) {
    if ((Number(state?.bag?.food?.[t]) || 0) >= floor) return t;
  }
  return null;
}

/** 从闲置伙伴里随机挑一组（默认两人）。 */
// ── [[side-wish]] 旅伴出门申请（2026-10-22）────────────────────────────────
// 有号的旅伴（星澄 / 小书虫）在另一个 QQ Agent 宿主里，把"我想出门"写成一份申请：
//   <DATA_DIR>/skills/travel-whale/side-wish.json  { id, at, partner, chatKey, expireAt }
// 本技能**只读**它，而且只用来「把申请人排进这一趟的名单」——
//   · 不改任何门槛（粮 / 人数 / 夜间 / 冷却一律照旧判）
//   · 不做"单人出门"（一趟仍是 partySize 位）
// 答复追加写进 side-wish-ack.jsonl，由对面读；处理完就删掉申请，免得重复消费。
// 设置项 `sideWishEnabled`（默认开）可整体关掉；没有这个文件时行为与关掉完全一致。
const SIDE_WISH_FILE = 'side-wish.json';
const SIDE_WISH_ACK = 'side-wish-ack.jsonl';

function sideWishDir() { return path.join(DATA_DIR, 'skills', 'travel-whale'); }

/** 读申请：没有 / 坏了 / 不是这个群 / 过期 ⇒ null（一律当没申请）。 */
function readSideWish(chatKey) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sideWishDir(), SIDE_WISH_FILE), 'utf8'));
    if (!j || !j.partner) return null;
    if (j.chatKey && String(j.chatKey) !== String(chatKey)) return null;
    if (Number(j.expireAt) && Date.now() > Number(j.expireAt)) return null;
    return j;
  } catch { return null; }
}

function clearSideWish() {
  try { fs.rmSync(path.join(sideWishDir(), SIDE_WISH_FILE), { force: true }); } catch { /* ignore */ }
}

function writeSideWishAck(row) {
  try {
    fs.mkdirSync(sideWishDir(), { recursive: true });
    fs.appendFileSync(path.join(sideWishDir(), SIDE_WISH_ACK),
      JSON.stringify({ at: Date.now(), ...row }) + '\n', 'utf8');
  } catch { /* 回执写不进去不能影响出门 */ }
}

/** 派出后回执：对面据此告诉她"家里答应了"。 */
function ackSideWishDispatched(wish, plan) {
  if (!wish) return;
  writeSideWishAck({
    id: wish.id, result: 'dispatched',
    city: String(plan?.city || ''), country: String(plan?.country || ''),
    backAt: Number(plan?.returnAt) || 0
  });
  clearSideWish();
  log(`[travel-whale] 已按申请把「${wish.partner}」排进这趟（${wish.id}）`);
}

/** 驳回回执：理由直接抄 sideWait.why（"粮不够 / 凑不够人 / 夜里"都是它算出来的）。 */
function ackSideWishRejected(wish, why) {
  if (!wish) return;
  writeSideWishAck({ id: wish.id, result: 'rejected', why: (why || []).slice(0, 3) });
  clearSideWish();
  log(`[travel-whale] 申请 ${wish.id} 被驳回：${(why || []).join('；')}`);
}

function pickSideParty(idle, rand = Math.random) {
  const need = Number(S.SIDE_TRIP?.partySize) || 2;
  const pool = [...idle];
  const out = [];
  while (out.length < need && pool.length) {
    const i = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/**
 * 把 `planTrip` 产出的完整计划**剪成**伙伴出行口径（**纯函数**，便于离线单测）。
 *
 *   · 途中卡数**按档固定**（`SIDE_TRIP.midCards`：小 0 / 中 0 / 大 1）——
 *     重排 `cardTimes`，并把 `cardPlan` 收成「mid 条途中 + 最后那条到家卡」；
 *   · 特产截断到 `SIDE_TRIP.souvenirCount`（固定 1 件）。
 *
 * ⚠️ 两条不能省的细节：
 *   ① `cardPlan` 的最后一条是**到家那张**（`planCardContent` 的口径）—— 必须留着，
 *      否则 `sendReturnCard` 会拿不到东西可寄；
 *   ② 返回的是**新对象**，不动传进来的 plan（调用方可能还要拿原值兜底）。
 *
 * @param {object} plan `T.planTrip` 的返回值
 * @param {string} foodTier 口粮档位（决定途中张数）
 * @returns {object} 剪好的新计划
 */
export function trimSidePlan(plan, foodTier) {
  const p = { ...(plan || {}) };
  const mid = Math.max(0, Number(S.SIDE_TRIP?.midCards?.[foodTier] ?? 0));
  const durationMs = Math.max(0, Number(p.durationMs) || 0);
  const departAt = Number(p.departAt) || Date.now();
  const orig = Array.isArray(p.cardPlan) ? p.cardPlan : [];
  const returnEntry = orig[orig.length - 1] || { kind: 'spot', spot: '', scene: '' };
  p.cardPlan = [...orig.slice(0, mid), returnEntry];
  p.cardTimes = [];
  for (let i = 1; i <= mid; i++) {
    p.cardTimes.push(Math.round(departAt + (durationMs * i) / (mid + 1)));
  }
  p.cardCount = mid;
  p.souvenirs = (p.souvenirs || []).slice(0, Math.max(0, Number(S.SIDE_TRIP?.souvenirCount) || 1));
  return p;
}

/**
 * 让一组闲置伙伴自己出门玩。
 * @returns {Promise<{ok:boolean, plan?:object, reason?:string}>}
 */
async function departSideTrip(chatKey, state, foodTier, partners, deps) {
  // ★ 同上：闲置伙伴自己出去玩，也是随机挑一个已解锁的地方
  const baseRegion = randomUnlockedRegion(state, (deps && deps.rand) || Math.random);
  if (!baseRegion) return { ok: false, reason: '地区表不可用' };
  if (!Array.isArray(partners) || partners.length < (Number(S.SIDE_TRIP?.partySize) || 2)) {
    return { ok: false, reason: '凑不够两个人' };
  }
  const need = Number(S.SIDE_TRIP?.foodNeed) || 2;
  if (!hasFood(state, foodTier, need)) return { ok: false, reason: '米饭不够两份' };
  const d = deps || buildDeps(chatKey, state);

  // 穿越判定 —— 与鲸鱼**同一个池子**（还没解锁的异世界），全解锁后自然永不触发
  const crossing = pickCrossOverTarget(state, baseRegion, d);

  for (let attempt = 0; attempt < 2; attempt++) {
    const region = (attempt === 0 && crossing) ? crossing.region : baseRegion;
    const picked = await T.pickCity(region, state, { llm: d.llm, log, rand: d.rand });
    if (!picked) continue;

    const plan = await T.planTrip({
      region, city: picked.city, country: picked.country, foodTier, state, deps: d,
      // ★★ v3.2：伙伴那趟**也算**（用户口径同「特色」："她自己的那趟算数"）——
      //   两位伙伴里只要有一位是"会记东西的"，这趟的特产就带批注。
      note: partners.some((c) => notesSouvenirs(c))
    });
    if (!plan) {
      log(`[travel-whale] 伙伴那趟：${placeLabel(picked)} 没玩头，重挑（第 ${attempt + 1} 次）`);
      continue;
    }

    // ① 剪成伙伴出行口径（途中张数按档固定 + 特产固定 1 件）
    const trimmed = trimSidePlan(plan, foodTier);

    // ② 标记这是"伙伴自己出去玩"那趟：记两位伙伴、**不带 companion**（鲸鱼没同行）
    trimmed.partners = partners.map((c) => c.id);
    trimmed.companion = '';
    // ★★ 2026-10-14 设施 B（用户口径）：**她自己跑出去玩 = 也算"出过门"** ——
    //   解封（之后能再上工），并把她从车间名册撤下。这也是硬约束给的**第二条**解锁路径。
    if (typeof S.releaseForTravel === 'function') S.releaseForTravel(state, trimmed.partners);
    trimmed.source = picked.source || 'pool';
    trimmed.charm = '';
    trimmed.side = true;

    // ★★ 2026-10-13 旅伴「特色」：**她自己的那趟也算数**（用户口径："grok自己那趟也触发"）。
    //   两位伙伴里只要有人有该特色就生效；战斗卡与普通额外卡分开判（可以同时成立）。
    if (partners.some((c) => c?.battleOnFiction)) appendExtraCard(trimmed, { rand: d.rand, battle: true });
    if (partners.some((c) => Number(c?.cardExtra) > 0)) appendExtraCard(trimmed, { rand: d.rand, battle: false });

      // ③ 穿越标记 + 即兴台词（把两位伙伴的名字并起来喂给台词生成）
      //   ★ 2026-10-13：必须传 `lead:'partners'` —— 这趟**她没有同行**，
      //     台词要是"她留守在家、转述两个小家伙跑丢了"的口吻（幸灾乐祸 + 让你们不带我）。
      if (attempt === 0 && crossing) {
        trimmed.crossedOver = true;
        trimmed.crossOverFrom = crossing.fromName;
        trimmed.crossOverTo = region.name;
        // ★★ 2026-10-15「探索解锁」：**旅伴自己穿越也算**（用户口径原话）。
        //   用的是同一份 `state`、同一个函数 —— 谁被丢出去，都算这个家"发现"了新世界。
        const foundNames = unlockBuyablesFromCrossing(state, region.id, d);
        trimmed.unlockedBuyables = foundNames;
        trimmed.crossOverLine = (await buildCrossOverLine({
          toName: region.name,
          fromName: crossing.fromName,
          companion: { name: partners.map((c) => c.name).join('和') },
          lead: 'partners',
          // ★ 2026-10-14 她本人可能也在外面（两趟互相独立）⇒ 台词不能一律说"她留守在家"
          whaleAway: Boolean(state.trip)
        }, d)) + discoveredLine(foundNames);
      } else {
      trimmed.crossedOver = false;
    }

    consumeFood(state, foodTier, need);
    // ★★ 2026-10-14 多趟化：**追加**一趟（原来这里是 `state.sideTrip = {...}` ⇒ 只能有一趟）。
    //   上限不写死：能派几趟 = `floor(闲置/partySize)`，每派一趟闲置就少两位 —— 由 tick 侧控制。
    normalizeSideTrips(state).push({ ...trimmed, cardsSent: 0 });
    return { ok: true, plan: trimmed };
  }
  return { ok: false, reason: '连着两次都没挑到能去的地方' };
}

/**
 * 伙伴那趟结束：特产入图鉴 → 到家寄 1 张 → 播报 → 排下次。
 * ⚠️ 与 `settleTrip` 的差别是**刻意**的：这趟是"两个人自己溜达" ——
 *    不记 `visitedCities`、不评称号、不发稀有奖励。图鉴照收，但不推动鲸鱼的进度。
 */
async function settleSideTrip(chatKey, state, party, deps) {
  // ★★ 2026-10-14 多趟化：**这一趟**由调用方传进来（原来是从 `state.sideTrip` 取"唯一那趟"）。
  //   兼容旧的三参写法 `(chatKey, state, deps)`（旧调用点 / 旧探针）：第三个参数不像趟就当成 deps。
  const looksLikeTrip = Boolean(party && typeof party === 'object'
    && (Array.isArray(party.partners) || Array.isArray(party.cardTimes) || party.city));
  const trip = looksLikeTrip ? party : (sideTripsOf(state)[0] || null);
  if (!trip) return null;
  const d = (looksLikeTrip ? deps : party) || buildDeps(chatKey, state);

  const { parts, images: souvenirImages } = await recordTripSouvenirs(chatKey, state, trip, d);
  S.refreshStats(state);
  // ★ 2026-10-14 服装系统：**伙伴那趟也算**（用户口径："不要求她本人，旅伴去过也解锁服装"）
  markAreaSeen(state, trip);

  const names = (trip.partners || [])
    .map((id) => (S.COMPANIONS || {})[id]?.name || id).join('和') || '两位伙伴';
  const where = placeLabel(trip);
  const lines = [`🐾 ${names}自己跑出去玩回来了。这趟去了 ${where}。\n`
    + (parts.length ? `带回来的东西：${parts.join('、')}` : '这趟什么也没带回来')];

  // 留快照（夜里压住的到家明信片要等早上才生成，得靠它取到城市/景点/画风）
  const snapshot = { ...trip };
  // ★ 10-14 多趟化：只摘掉**这一趟**，其余趟照旧在路上（原来一句 `state.sideTrip = null`
  //   会把同时在外面的人一起清掉 ⇒ 他们的到家卡与特产全丢）。
  const arr = normalizeSideTrips(state);
  const at = arr.indexOf(trip);
  if (at >= 0) arr.splice(at, 1);

  const now = Date.now();
  if (E.isNight(now)) {
    state.pending = Array.isArray(state.pending) ? state.pending : [];
    // ★ 2026-10-21：伙伴那趟的归家播报同样算 journey（`sayKind` 见 `pendingSayKind`）
    state.pending.push({ kind: 'side-return', sayKind: 'journey', snapshot, lines, images: souvenirImages, queuedAt: now });
    state.sideNextAt = 0;
    log(`[travel-whale] ${chatKey} 伙伴凌晨到家，明信片与播报压到 7 点后补发`);
  } else {
    try { await sendReturnCard(chatKey, state, snapshot, d); }
    catch (error) { log('[travel-whale] 伙伴到家明信片失败：' + (error?.message ?? error)); }
    // ★ 2026-10-21：归家播报 ＝ journey（这趟是"两位伙伴自己出去"，播报仍属"归家"）
    for (const line of lines) await say(chatKey, line, { kind: 'journey' });
    // ★ 2026-10-26：伙伴那趟的稀有特产图同样当场发（此前只存图鉴、从不展示）
    await sendSouvenirImages(chatKey, souvenirImages, 'journey');
    state.sideNextAt = E.nextDepartAt(now, Math.random, restRange());
  }
  log(`[travel-whale] ${chatKey} 伙伴那趟结束：${where}，特产 ${(trip.souvenirs || []).length} 件`);
  return { where, souvenirs: parts };
}

// ── 后台推进 ──────────────────────────────────────────────────────────────

/** 背包里最好的一档口粮（自动出发时优先用大份，走得远）。 */
/**
 * 挑一档"背包里够用"的口粮（大份优先 —— 走得久、寄得多）。
 * ★ `need`：有旅行伙伴时要 2 份才够（两个人一起吃），否则会挑到"只剩 1 份"的档、
 *   然后 depart 才失败 —— 那属于把判定摊到两层去做，不如这里一次挑对。
 */
function bestFoodTier(state, need = 1) {
  for (const t of ['large', 'normal', 'small']) if (hasFood(state, t, need)) return t;
  return null;
}

/** 一趟推进：对每个"养了鲸鱼"的会话，该寄的寄、该回的结算、该走的走。 */
/**
 * 上一轮 tick 还在跑吗。
 *
 * ⚠️ 必须有这个锁。tick 里有 **LLM 写文案 + 生图**，一轮跑几十秒很正常，
 *    而 setInterval 不会等上一轮结束 —— 两个 tick 会同时读到同一份存档、
 *    各自都以为「trip 还在」，于是**同一张明信片被寄两遍、同一次回家播报两遍**。
 *    实测日志里同一个请求指纹出现两次、30 秒内冒出三句「我回来啦」，就是这个原因。
 *
 * ★★ 这把锁必须挂在 **globalThis**（不是模块级 `let ticking`）：
 *    热重载后模块实例分叉 ⇒ 两个实例各持一把锁 ⇒ 等于没锁（见文件头 TICKER_SLOT 注释）。
 */


// ── ★★ 2026-10-18 v3.18「自动化」───────────────────────────────────────────
//
// 用户口径（原话）：
//   ① 每当她出发离开 / 旅行回到矩阵庭院时，**自动收取**未收取的 TOKEN；
//   ② token 足够的情况下，让模型**自主**决定怎么花手上的 token —— 真正做到"不用你管"。
//
// 两条都能在设置里关：`autoHarvest`（默认开）、`autoSpend`（默认开）。
// ⚠️ 自主花钱**只在白天**发生：夜里买完没法播报（必须压进 pending 队列，
//    而那套队列只认明信片那几种 kind），所以干脆留到下一次白天再说。

/**
 * ★ v3.18.2：周预算用「周一 0 点」当分界，跨周自动归零。
 * 为什么按自然周而不是"最近 7 天滚动"：玩家对"这周花了多少"有直觉，滚动窗口算不清。
 */
function weekKey(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;              // 周一 = 0
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  const p = (n) => String(n).padStart(2, '0');
  return `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`;
}

/** 本周已花（只算自主消费）。 */
function spentThisWeek(state, now = Date.now()) {
  const b = (state?.autoSpendBook && typeof state.autoSpendBook === 'object') ? state.autoSpendBook : {};
  return String(b.week || '') === weekKey(now) ? (Number(b.spent) || 0) : 0;
}

/**
 * 记一笔自主消费：更新周账本 ＋ 追加到 `spendLog`（留最近 10 条）。
 * ⚠️ 只改 state，不落盘 —— 调用方用 `S.mutate` 包一层。
 */
function noteAutoSpend(state, items, reason = '', now = Date.now()) {
  if (!Array.isArray(items) || !items.length) return;
  const total = items.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const wk = weekKey(now);
  const b = (state.autoSpendBook && typeof state.autoSpendBook === 'object') ? state.autoSpendBook : {};
  state.autoSpendBook = {
    week: wk,
    spent: (String(b.week || '') === wk ? (Number(b.spent) || 0) : 0) + total
  };
  const log = Array.isArray(state.spendLog) ? state.spendLog : [];
  log.push({
    at: now, total,
    // ★ 2026-10-23：把每件的 `why` 也存进账本（以前只存 name/price/kind，
    //   于是回头查"她为什么买这个"永远查不到）。
    items: items.map((x) => ({
      name: String(x.name || ''), price: Number(x.price) || 0, kind: String(x.kind || ''),
      ...(String(x.why || '').trim() ? { why: String(x.why).trim().slice(0, 60) } : {})
    })),
    reason: String(reason || '').slice(0, 80)
  });
  state.spendLog = log.slice(-10);
  // ★ v4.3：再写一份给控制台面板（它读不到技能存档，只能读静态 JSON）
  try {
    const root = path.resolve(SELF_DIR, '..', '..');
    const file = path.join(root, 'ui', 'travel-dashboard.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      at: now,
      balance: Number(state?.wallet?.plankton) || 0,
      week: state.autoSpendBook || null,
      log: state.spendLog
    }, null, 1));
  } catch (error) {
    log(`[travel-whale] 面板账本写入失败：${error?.message ?? error}`);
  }
}

/**
 * ① 自动收 TOKEN。失败（没得收 / 冷却中 / 服务器没产）一律静默 —— 这不是错误，
 * 是"顺手收一下"。返回实际收到的数（0 = 没收）。
 */
export function autoHarvest(state, tag) {
  try {
    const r = S.harvest(state, Date.now());
    const got = Number(r?.collected) || 0;
    if (r?.ok && got > 0) {
      log(`[travel-whale] 自动收取（${tag}）：+${got} 亿 TOKEN（余额 ${Number(state?.wallet?.plankton) || 0} 亿）`);
      return got;
    }
  } catch (error) {
    log(`[travel-whale] 自动收取失败（${tag}）：${error?.message ?? error}`);
  }
  return 0;
}

/**
 * ② 可买清单 —— **只列买得起的**，让模型没有"点了买不起"的机会。
 * 当前覆盖三类：庭院设施下一级、口粮、护身符。
 * 为什么先只做这三类：它们全在 `whale_buy` 里，且是"持续支出"的主干；
 * 技能 / 服装 / 装备各有前置条件（去过的世界、衣柜解锁），下一版再挂进来。
 */
export function spendMenu(state) {
  const wallet = Number(state?.wallet?.plankton) || 0;
  const out = [];
  for (const g of (S.GARDENS || [])) {
    const lv = Number((state?.garden || {})[g.id]) || 0;
    if (lv >= (Number(g.maxLevel) || 1)) continue;
    const price = Number((g.prices || [])[lv]);
    if (!Number.isFinite(price) || price <= 0) continue;   // 「服务器阵列」是成就值，不是 TOKEN
    if (price > wallet) continue;
    out.push({ name: g.name, price, kind: '设施', note: `从 ${lv} 级升到 ${lv + 1} 级：${g.effect || ''}` });
  }
  // ★ 2026-10-23：口粮**先看库存**。原来只看"钱够不够"，有饭也推荐买饭。
  //   判据复用 autoTend 那条：库存 >= max(2, 两趟的量) 就算够。
  const foodHave = ['small', 'normal', 'large']
    .reduce((n, k) => n + (Number(state?.bag?.food?.[k]) || 0), 0);
  const foodNeed = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
  if (foodHave < foodNeed) {
    const foods = [['small', '小份大白饭'], ['normal', '中份大白饭'], ['large', '大份大白饭']];
    for (const [k, nm] of foods) {
      const price = Number(S.PRICES?.food?.[k]);
      if (price > 0 && price <= wallet) out.push({ name: nm, price, kind: '口粮', note: `出门要吃的（现有 ${foodHave}/${foodNeed}）` });
    }
  }

  // ★ 2026-10-23：护身符是「戴一个」，不是可叠加商品 —— 原来不看当前戴的，
  //   于是同一顶护身符一天被买 6 次；甚至同一次里先买 +40% 再买 +25% 把贵的顶掉。
  //   规则：已戴的跳过；`luck <= 当前` 的也跳过（买了必然更差或持平 = 纯浪费）。
  const curCharm = String(state?.whale?.charm || '');
  const curLuck = (curCharm && S.CHARM_TYPES?.[curCharm]) ? Number(S.CHARM_TYPES[curCharm].luck) || 0 : -1;
  for (const [k, c] of Object.entries(S.CHARM_TYPES || {})) {
    if (k === curCharm) continue;                                   // 正戴着
    const luck = Number(c.luck) || 0;
    if (curCharm && luck <= curLuck) continue;                      // 不如现在这顶
    const price = Number(S.PRICES?.charm?.[k]);
    if (price > 0 && price <= wallet) {
      // ⚠️ 措辞要让模型一眼看懂这是「替换」而不是「叠加」——它读的是这句 note。
      const cmp = curCharm ? `现在戴的是${S.CHARM_TYPES[curCharm]?.name || curCharm}（+${Math.round(curLuck * 100)}%），换了就顶掉` : '';
      out.push({
        name: c.name, price, kind: '护身符',
        note: `稀有概率 +${Math.round(luck * 100)}%${cmp ? `；${cmp}` : ''}`
      });
    }
  }
  // ★ v3.18.1：装备（去过/发现过、但还没解锁的）—— 买它走 `whale_buy`
  for (const r of (T.loadRegions() || [])) {
    if (!r?.equipment) continue;
    if (isRegionUnlocked(state, r)) continue;
    if (!isRegionVisible(state, r)) continue;        // 没发现的地方不列，别剧透
    if (EQUIP_PRICE > wallet) continue;
    out.push({ name: r.equipment, price: EQUIP_PRICE, kind: '装备', note: '解锁这个世界的装备', tool: 'buy' });
  }
  // ★ v3.18.1：服装（去过那个区域、还没买下的）—— 买它走 `whale_wear`（衣柜里带买）
  const seen = (state?.areasSeen && typeof state.areasSeen === 'object') ? state.areasSeen : {};
  for (const o of (OW.OUTFITS || [])) {
    if (state?.wardrobe?.owned?.[o.id] === true) continue;
    if (!seen[`${o.region}|${o.area}`]) continue;
    const price = Number(o.price) || OW.OUTFIT_PRICE;
    if (price > wallet) continue;
    out.push({
      name: o.name, price, kind: '服装',
      note: `给${OW.girlName(o.who)}的一套（去过${OW.OUTFIT_REGION_NAMES?.[o.region] || o.region}·${o.area}）`,
      tool: 'wear'
    });
  }
  // ★ 2026-10-23（档 2）：墓碑 —— 买失败过的 3 天内不再列。
  //   为什么只记"买失败过的"：已拥有类（护身符已戴 / 装备已解锁 / 服装已拥有）状态本身就在
  //   charm / equipment / wardrobe 里，再记一份墓碑就是两套真相，早晚不一致。
  //   "买失败"才是有隐藏条件的那种（比如 world 没完全解锁），本地看不出来，只能靠试。
  const tomb = (state?.spendTomb && typeof state.spendTomb === 'object') ? state.spendTomb : {};
  const now = Date.now();
  return out.filter((it) => {
    const t = tomb[it.name];
    if (!t) return true;
    const until = Number(t.until) || 0;
    return until > 0 && until <= now;      // 到点解除；没写 until 的视为永久（当前不产生这种）
  });
}

// ── ★★ 2026-10-23：把"想不想出门"交还给她 ────────────────────────────────
// 原来 `shouldAutoDepart` 一旦为真就直接 `depart()` —— 时间到身体就自己走。
// 现在两道都过一遍：**时间到**（机制闸照旧）→ **问她一句**（她决定）。
//
// 口径（用户定）：
//   · 无聊值**只升不降**，出门一次清空 —— 用 `state.homeSince` 算（见 lib/boredom.js）
//   · 问法必须是 selfDecide：**给数值/感受，不给"你该出门了"**
//
// 安全底线：`deps.llm` 不可用、解析失败、给了不存在的地区 ⇒ **回落照旧出发**。
//   模型挂了不能把"旅行"这条主线卡死 —— 宁可她还按老样子出门，也不要她永远待在家。

/** 这一趟会带谁（与 depart 同口径，只用来算口粮）。 */
function tripPartyOf(state) {
  const comp = companionOf(state);
  return typeof S.companionsOf === 'function' ? S.companionsOf(state) : (comp ? [comp] : []);
}

/**
 * 问她一句：现在想不想出门。
 * @returns {Promise<{go:boolean, region?:object, reason?:string, retryInMs?:number, boredom:number}>}
 */
export async function considerDepart(chatKey, state, deps, settings, foodTier = 'normal') {
  const cfg = settings || {};
  const now = Date.now();
  const perHour = Number(cfg.boredomPerHour) > 0 ? Number(cfg.boredomPerHour) : BOREDOM_DEFAULTS_PER_HOUR();
  const boredom = BORED.boredomOf(state, now, { perHour });
  const hours = BORED.homeHoursOf(state, now);
  const feel = BORED.boredomFeel(boredom, hours);

  // 后路：没有模型 / 解析失败 / 地区不合法 ⇒ 按老样子走
  const fallback = (why) => {
    log(`[travel-whale] ${chatKey} 出门自决不可用（${why}）⇒ 按老样子出发`);
    return { go: true, boredom };
  };
  if (typeof deps?.llm !== 'function') return fallback('没有可用的模型');
  if (cfg.boredomSelfDecide === false) return { go: true, boredom };   // 显式关掉 = 老行为

  const party = tripPartyOf(state);
  const foodNeed = foodNeedOf(state, party);
  const foodHave = Number(state?.bag?.food?.[foodTier]) || 0;
  const wallet = Number(state?.wallet?.plankton) || 0;
  const regions = unlockedRegions(state).map((r) => String(r.name || r.id)).filter(Boolean);
  const who = party.length ? party.map((c) => c.name).join('、') : '一个人';

  const prompt = [
    `你刚在矩阵庭院里。${feel}`,
    `手上 ${wallet} 亿 TOKEN；${T.FOOD_TIERS?.[foodTier]?.name || '中份大白饭'} 还有 ${foodHave} 份`
      + `（这趟出门要 ${foodNeed} 份，${who}）。`,
    regions.length > 1 ? `现在能去的地方：${regions.join('、')}。` : '',
    '',
    '要不要出门、去哪、带着谁 —— 都由你自己定。主人没有交代，也不用问。',
    '不想出门也完全可以：在家待着也是过日子。',
    '',
    '只输出 JSON，不要别的字：',
    '{"go":true,"region":"地方名","why":"一句话，为什么现在想去"}',
    '或 {"go":false,"reason":"一句话，为什么还想再待一会儿"}'
  ].filter(Boolean).join('\n');

  let plan = null;
  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    plan = m ? JSON.parse(m[0]) : null;
  } catch (error) {
    return fallback(`模型调用失败：${String(error?.message ?? error).slice(0, 60)}`);
  }
  if (!plan || typeof plan !== 'object') return fallback('模型没给出可用的 JSON');

  if (plan.go !== true) {
    const reason = String(plan.reason || plan.why || '').trim().slice(0, 80);
    log(`[travel-whale] ${chatKey} 到点了，她不想走（无聊 ${boredom}/100，在家 ${Math.round(hours)}h）`
      + `${reason ? `：${reason}` : ''}`);
    return { go: false, reason, boredom, retryInMs: BORED.askGapMsOf(boredom, cfg) };
  }

  // 选地区：名字 → region 对象；对不上就回落随机（不让一次错字把出行卡住）
  const want = String(plan.region || '').trim();
  const hit = want
    ? unlockedRegions(state).find((r) => String(r.name || '').includes(want) || want.includes(String(r.name || '')))
    : null;
  const why = String(plan.why || '').trim().slice(0, 80);
  log(`[travel-whale] ${chatKey} 她说想出门（无聊 ${boredom}/100${hit ? `，去${hit.name}` : '，地方随机'}）`
    + `${why ? `：${why}` : ''}`);
  return { go: true, boredom, region: hit || null, reason: why };
}

/** `boredomPerHour` 的默认值（从 boredom.js 取，避免两处各写一个数）。 */
function BOREDOM_DEFAULTS_PER_HOUR() {
  try { return BORED.BOREDOM_DEFAULTS.perHour; } catch { return 4; }
}

/**
 * 伙伴来问能不能出去玩 —— 让不让由她定，理由用**她的原话**。
 *
 * 原来 `side-wish` 只能"把申请人排进这一趟"，驳回的 why 是**机制算的**
 * （"粮不够 / 凑不够人 / 夜里"）—— 那是程序在说话，不是她。
 *
 * 安全底线同 `considerDepart`：没有模型 ⇒ **放行**（不因为模型挂了就永远不让伙伴出门）。
 */
async function judgeSideWish(chatKey, state, wish, deps, settings) {
  const cfg = settings || {};
  const who = String(wish?.partner || '有伙伴');
  if (typeof deps?.llm !== 'function' || cfg.sideWishSelfDecide === false) {
    return { allow: true, reason: '' };
  }
  const foodNeed = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
  const foodHave = Object.values(state?.bag?.food || {}).reduce((n, x) => n + (Number(x) || 0), 0);
  const selfAway = state?.trip ? `你自己这趟还在外面（${String(state.trip.city || '')}）。` : '你在家。';
  const prompt = [
    `${who}跑来问你：能不能自己出去玩一趟。`,
    `家里现在：${selfAway}米缸里一共 ${foodHave} 份口粮（这一趟要带走 ${foodNeed} 份）。`,
    '让不让它们去，你自己定 —— 想留它们在家陪我、想等某件事做完再说，都可以。',
    '不想让的话，把理由说清楚（别写"粮不够"这种账面上的话，说你自己的顾虑或打算）。',
    '',
    '只输出 JSON，不要别的字：',
    '{"allow":true,"reason":"一句话，答应了"}',
    '或 {"allow":false,"reason":"一句话，为什么先不让"}'
  ].join('\n');

  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    const o = m ? JSON.parse(m[0]) : null;
    if (!o || typeof o !== 'object') return { allow: true, reason: '' };
    const reason = String(o.reason || '').trim().slice(0, 80);
    if (o.allow === false) {
      log(`[travel-whale] ${chatKey} 她没让「${who}」出门${reason ? `：${reason}` : ''}`);
      return { allow: false, reason };
    }
    log(`[travel-whale] ${chatKey} 她答应「${who}」出门${reason ? `：${reason}` : ''}`);
    return { allow: true, reason };
  } catch (error) {
    log(`[travel-whale] 伙伴请愿判定失败（放行）：${String(error?.message ?? error).slice(0, 60)}`);
    return { allow: true, reason: '' };
  }
}

/**
 * ② 自主花钱：让她自己看清单、自己决定买什么。
 *
 * 设计取舍：
 *   · **一次模型调用**（回来一趟一次），不额外开定时器；
 *   · 决策只输出"买什么"，**执行仍走 `whale_buy`** —— 它的定义被合并入口收在
 *     `WHALE_LEGACY`（键是短名 'buy'），取它的 `execute` 就是群友点按钮那条路，
 *     价格/库存/余额闸一行都不复制。
 *   · 硬约束在本地再做一遍：只能挑菜单里的、买完要留底、最多 N 件 ——
 *     **不信任模型输出的数字**（它没见过账单）。
 * @returns {string} 要发到群里的一句话；不买/不该买时返回空串
 */
export async function autoSpend(chatKey, state, deps, settings) {
  if (settings?.autoSpend === false) return '';
  if (typeof deps?.llm !== 'function') return '';
  // 频率闸：默认 3 小时最多决策一次（`autoSpendGapHours` 可调）
  // ★ 2026-10-23：时间戳改读**存档**（`state.autoSpendAt`），不再用模块级 Map ——
  //   后者每次热重载归零，实测导致"7 分钟买 4 次"。见文件头 `AUTO_SPEND_AT` 那段说明。
  const gapMs = Math.max(1, Number(settings?.autoSpendGapHours ?? 3)) * 3600 * 1000;
  const lastAt = Number(state?.autoSpendAt) || 0;
  if (Date.now() - lastAt < gapMs) return '';
  // ⚠️ 占位放在**确认 buy 存在之后**（见下面 `if (!buy) return ''`）：buy 取不到是环境问题，
  //   不该占用 3 小时的重试窗口 —— 否则插件装错时要等 3 小时才发现。
  void 0;
  const wallet = Number(state?.wallet?.plankton) || 0;
  const min = Number(settings?.autoSpendMin ?? 150);          // 低于这个数不谈花钱
  if (wallet < min) return '';
  const menu = spendMenu(state);
  if (!menu.length) return '';
  // 买完至少留这么多：**绝对下限 ＋ 余额比例**取大者。
  // 2026-10-18 实测教训：老口径只留固定 50 亿，她一次就把 1878 花到 78 —— 数字上没违规，
  // 但体感就是"把存款花光了"。比例兜底（默认 20%）让钱包始终留有余量。
  // 周预算：0 = 不限。跨周自动归零（`weekKey`）。
  const weeklyCap = Math.max(0, Number(settings?.autoSpendWeeklyCap ?? 0));
  const capLeft = weeklyCap > 0 ? Math.max(0, weeklyCap - spentThisWeek(state)) : Infinity;
  if (capLeft <= 0) {
    log(`[travel-whale] 自主花钱：本周预算 ${weeklyCap} 亿已用完，攒着`);
    return '';
  }
  const keepFloor = Math.max(0, Number(settings?.autoSpendKeep ?? 200));
  const keepPct = Math.max(0, Math.min(50, Number(settings?.autoSpendKeepPct ?? 20))) / 100;
  const keep = Math.max(keepFloor, Math.round(wallet * keepPct));
  const maxN = Math.max(1, Math.min(3, Number(settings?.autoSpendMax ?? 2)));
  const execOf = (key) => {
    const d = WHALE_LEGACY.get(key);
    return (d && typeof d.execute === 'function') ? d.execute : null;
  };
  const buy = execOf('buy');
  const wear = execOf('wear');
  if (!buy) {
    log('[travel-whale] 自主花钱：取不到 buy 工具（本次不决策，也不占频率闸）');
    return '';
  }

  // 先占位（落盘）：一次 tick 里只决策一次；**决策失败也算占位**，否则 tick 会每分钟重试。
  try { S.mutate(chatKey, (st) => { st.autoSpendAt = Date.now(); }); } catch (error) {
    log(`[travel-whale] 自主花钱：写频率闸失败（本次照常决策）：${error?.message ?? error}`);
  }

  const lines = menu.map((m) => `- ${m.name}｜${m.price} 亿｜${m.kind}｜${m.note}`);
  const prompt = [
    `你刚回到矩阵庭院，手上有 ${wallet} 亿 TOKEN。`,
    '要不要花、花在哪，由你自己决定 —— 主人没有交代，也不用问。',
    `规矩：一次最多买 ${maxN} 件；买完至少留 ${keep} 亿（别把钱花光）。`,
    '只能从下面清单里挑，item 必须写原名。',
    '清单：',
    ...lines,
    '',
    '只输出 JSON，不要别的字：',
    '{"buy":[{"item":"名字","why":"一句话理由"}],"reason":"如果一件都不买，在这里写为什么"}'
  ].join('\n');

  let plan = null;
  try {
    const raw = await deps.llm(prompt);
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    plan = m ? JSON.parse(m[0]) : null;
  } catch (error) {
    log(`[travel-whale] 自主花钱决策失败：${error?.message ?? error}`);
    return '';
  }
  const wants = Array.isArray(plan?.buy) ? plan.buy : [];
  if (!wants.length) {
    if (plan?.reason) log(`[travel-whale] 自主花钱：这次不买（${String(plan.reason).slice(0, 40)}）`);
    return '';
  }

  let left = Math.min(wallet - keep, capLeft);
  const picked = [];
  const seen = new Set();
  for (const w of wants) {
    const name = String(w?.item ?? '').trim();
    const hit = menu.find((m) => m.name === name);
    if (!hit || seen.has(name)) continue;
    if (hit.price > left) continue;
    // ★ 2026-10-23：模型给的 `why` 以前**一次都没被读过**（全文件只在提示词里出现）。
    //   所以在群里只看到收据，买 6 次同一顶护身符一句理由都没有 —— 那才是"蠢"的体感来源。
    picked.push({ ...hit, why: String(w?.why ?? '').trim().slice(0, 60) });
    seen.add(name);
    left -= hit.price;
    if (picked.length >= maxN) break;
  }
  if (!picked.length) {
    log('[travel-whale] 自主花钱：模型的选项都过不了本地校验，这次不买');
    return '';
  }

  const receipts = [];
  // ★ 2026-10-23（档 2）：买失败过的记墓碑，3 天内不再列进清单。
  //   这类"清单里有、但工具拒绝"的东西，本地看不出来（隐藏条件在 buy 的校验里），
  //   不改的话每次决策都会白试一遍 —— 也就是用户说的"反复 ping 已经卖完的东西"。
  const tombNew = {};
  const TOMB_DAYS = 3;
  for (const it of picked) {
    // 服装走衣柜那条路（它会自己判断"去过没 / 买没买 / 扣钱"，并顺手换上）；
    // 其余都走商店。两条都是群友手动点按钮时走的同一条。
    const fn = (it.tool === 'wear' && wear) ? wear : buy;
    try {
      const r = await fn({ chatKey }, { item: it.name, count: 1 });
      if (r?.isError) {
        const why = String(r?.content || '').slice(0, 60);
        log(`[travel-whale] 自主花钱：买「${it.name}」被拒（${why}）→ 记墓碑 ${TOMB_DAYS} 天`);
        tombNew[it.name] = { at: Date.now(), kind: it.kind, why, until: Date.now() + TOMB_DAYS * 86400000 };
        continue;
      }
      const line = String(r?.content || `${it.name} 买好了`).trim();
      // ★ 2026-10-23：把她给的理由带上（没有理由就只留收据，不编）
      receipts.push(it.why ? `${line}（${it.why}）` : line);
    } catch (error) {
      log(`[travel-whale] 自主花钱：买「${it.name}」出错：${error?.message ?? error}`);
    }
  }
  if (Object.keys(tombNew).length) {
    try {
      S.mutate(chatKey, (st) => {
        st.spendTomb = { ...(st.spendTomb && typeof st.spendTomb === 'object' ? st.spendTomb : {}), ...tombNew };
      });
    } catch (error) {
      log(`[travel-whale] 自主花钱：写墓碑失败：${error?.message ?? error}`);
    }
  }
  if (!receipts.length) return '';
  // 记账（周预算 + 最近记录）。单独 mutate：`whale_buy` 已经各自存过盘了。
  try {
    S.mutate(chatKey, (st) => noteAutoSpend(st, picked, plan?.reason || ''));
  } catch (error) {
    log(`[travel-whale] 记账失败：${error?.message ?? error}`);
  }
  log(`[travel-whale] 自主花钱：买了 ${picked.map((x) => x.name).join('、')}`);
  return `🛒 我自己做了点主：\n${receipts.map((x) => `· ${x}`).join('\n')}`;
}


/**
 * ★★ v3.18.2「自理」：她在家会自己收菜、补种、补口粮。
 *
 * 只做**不花钱或很少花钱**的事：
 *   · 收菜 —— 有熟的才动（收稀有的会触发一张收成图，和手动收一样）；
 *   · 补种 —— 地空着、图鉴里有能种的、库存够 ⇒ 自己种一株；
 *   · 补口粮 —— 口粮低于"两趟的量"就自己买，最多补 3 份（不超过钱包与周预算）。
 * ⚠️ "送特产"**没有做**：那需要一个具体收礼人，自动送等于替她乱发东西 ——
 *    留给人来说（说"送给他"），或者以后做成"有人讨要才送"。
 */
export async function autoTend(chatKey, state, deps, settings) {
  if (settings?.autoTend === false) return [];
  const gapMs = Math.max(5, Number(settings?.autoTendGapMin ?? 30)) * 60 * 1000;
  const last = Number(AUTO_TEND_AT.get(chatKey)) || 0;
  if (Date.now() - last < gapMs) return [];
  AUTO_TEND_AT.set(chatKey, Date.now());

  const did = [];
  const call = async (tool, args) => {
    const d = WHALE_LEGACY.get(tool);
    if (!d || typeof d.execute !== 'function') return null;
    try { return await d.execute({ chatKey }, args || {}); } catch (error) {
      log(`[travel-whale] 自理：${tool} 出错：${error?.message ?? error}`);
      return null;
    }
  };

  // ① 收菜
  const farm = Array.isArray(state.farm) ? state.farm : [];
  const lastStage = S.FARM.stageCount - 1;
  if (farm.some((p) => S.farmStageOf(p) >= lastStage)) {
    const r = await call('reap', {});
    if (r && !r.isError) did.push('收菜');
  }
  // ② 补种
  if (state.farmUnlocked) {
    const cap = farmCapNow(state);
    const plots = Array.isArray(state.farm) ? state.farm : [];
    if (plots.length < cap) {
      const seeds = Object.values(state.souvenirs || {})
        .filter((e) => e && SV.canPlant(e) && S.souvenirStock(e) >= 1)
        .sort((a, b) => String(b.count || 0) - String(a.count || 0));
      if (seeds.length) {
        const r = await call('plant', { item: seeds[0].name });
        if (r && !r.isError) did.push('补种');
      }
    }
  }
  // ③ 补口粮（按"两趟的量"备货，最多一次补 3 份）
  try {
    const tier = 'normal';
    const need = Math.max(2, foodNeedOf(state, typeof S.companionsOf === 'function' ? S.companionsOf(state) : []));
    const have = Number(state?.bag?.food?.[tier]) || 0;
    const price = Number(S.PRICES?.food?.[tier]) || 0;
    const wallet = Number(state?.wallet?.plankton) || 0;
    if (have < need && price > 0) {
      const want = Math.min(3, need - have);
      if (wallet >= price * want) {
        const r = await call('buy', { item: '中份大白饭', count: want });
        if (r && !r.isError) did.push('补口粮');
      }
    }
  } catch (error) {
    log(`[travel-whale] 自理：补口粮出错：${error?.message ?? error}`);
  }

  if (did.length) log(`[travel-whale] 自理：${did.join('、')}`);
  return did;
}

/**
 * ★★ v3.18.2「自己邀旅伴」：钱够、没同行者、隔够久，就自己请一位上路。
 * 播报用 `whale_buy` 的原话（含"见面礼"与余额），不做二次加工。
 */
export async function autoInvite(chatKey, state, settings) {
  if (settings?.autoInvite === false) return '';
  if (state?.trip) return '';
  // ★ 2026-10-18（用户口径）：**不再要求"手上没有同行者"**。
  //   理由：旅伴是买断制、请过就一直跟着，那条前置实际上让这个功能一辈子只触发一次。
  //   现在只靠"72 小时"这一道间隔 —— 也就是说，她会慢慢把旅伴请齐。
  const gap = Math.max(1, Number(settings?.autoInviteGapHours ?? 72)) * 3600 * 1000;
  const last = Number(state?.autoInviteAt) || 0;
  if (last && Date.now() - last < gap) return '';
  const wallet = Number(state?.wallet?.plankton) || 0;
  const keep = Math.max(200, Math.round(wallet * 0.2));
  const list = Object.values(S.COMPANIONS || {})
    .filter((c) => Number(c.price) > 0 && wallet - Number(c.price) >= keep);
  if (!list.length) return '';
  const pick = list[Math.floor(Math.random() * list.length)];
  const d = WHALE_LEGACY.get('buy');
  if (!d || typeof d.execute !== 'function') return '';
  try {
    const r = await d.execute({ chatKey }, { item: pick.name });
    if (!r || r.isError) return '';
    S.mutate(chatKey, (st) => { st.autoInviteAt = Date.now(); });
    log(`[travel-whale] 自理：自己请了「${pick.name}」`);
    return r.content;
  } catch (error) {
    log(`[travel-whale] 自己邀旅伴出错：${error?.message ?? error}`);
    return '';
  }
}

async function tick() {
  if (G[TICK_RUNNING]) return;  // 上一轮没跑完 → 直接跳过，绝不并发
  G[TICK_RUNNING] = true;
  try {
  const settings = cfg();
  if (settings?.enabled === false) return;

  // ★ HOME-ONLY（BROADCAST）：鲸鱼只养在「家」那一个会话 —— 别处即使有旧存档也不再推进
  //   （那些存档是改造前"每个群各养一只"留下的，留着不动，不发消息也不报错）。
  //   没配 homeChatKey 时退回老行为：每个有存档的会话各推进一只。
  const home = homeKey();
  // ★★ 2026-10-19 修（用户报「快速测试十分钟无任何反馈」）：
  //   快速测试写在 `<home>_test` 这份**独立存档**里（不污染真身），但上面这行
  //   `k === home` 把它一起过滤掉了 ⇒ 这趟测试**永远不被 tick**：
  //   第 5 分钟不寄片、第 10 分钟不回家，群里一片安静（开始那句之后就没了）。
  //   ⚠️ 没有配 homeChatKey 时（老的"每个群各养一只"）本来就会遍历到 `_test`，
  //      所以这个 bug 只在"只养一只"模式下出现 —— 也正好是最常见的模式。
  const testKeyOfHome = home ? home + QUICK_TEST_KEY_SUFFIX : '';
  const keys = home
    ? activeChats().filter((k) => k === home || (testKeyOfHome && k === testKeyOfHome))
    : activeChats();
  for (const chatKey of keys) {
    try {
      if (!isEnabled(chatKey, settings)) continue;
      const state = S.loadState(chatKey);
      // ★ 存档键 ≠ 发送目标。
      //   快速测试用 `${chatKey}_test` 当存档键（隔离数据），但消息必须发回**真实会话** ——
      //   踩过的坑：把存档键当发送目标，OneBot 收到 user_id='12345678_test'
      //   直接回 retcode=1400（expected a positive integer），明信片全发不出去。
      //   所以测试态在存档里记下 realChatKey，发送一律用它。
      const target = String(state.realChatKey || chatKey);
      const deps = buildDeps(target, state);
      let dirty = false;
      const now = Date.now();

      // 货架补货（没人逛商店时也要按时补满，否则会断供）
      if (S.restockIfDue(state, now, Number(settings.restockHours || 168) * 3600 * 1000)) dirty = true;

      // ── ★★ 2026-10-14 设施 B「数据标注车间」：结算产出 ＋ **24 小时硬闸** ──────────────
      // 为什么挂在这儿：这是**定期维护**类动作，和补货同层 —— 每轮 tick 都会走到，
      //   **不需要新开定时器**（新定时器＝又多一个要接管/要留痕的东西）。
      // `accrueLabelroom` 按 `elapsed × 人数` 累加 ⇒ **天然幂等**：跑多少轮都不会多给。
      if (typeof S.accrueLabelroom === 'function') {
        S.accrueLabelroom(state, now);
        const due = (typeof S.labelroomDueWorkers === 'function') ? S.labelroomDueWorkers(state, now) : [];
        for (const w of due) {
          // ★★ 硬约束：**连续上工满 24 小时 ⇒ 自动下班**（用户口径），并**封印**：
          //   她必须先出一次门（带她旅行 / 放她自己出去玩）才能再上工 —— 见 `endWork`。
          const done = (typeof S.endWork === 'function') ? S.endWork(state, w.id, now) : { ok: false };
          if (!done?.ok) continue;
          dirty = true;
          const def = (S.COMPANIONS || {})[w.id] || {};
          const nm = String(def.name || w.id);
          // 她本人的口气（借嘴）——**失败就回落一句转述**，绝不让播报把"下班"这件事带塌。
          let line = '';
          try {
            line = await speakAs(w.id,
              '你在庭院的数据标注车间里连着上了一整天班（**满 24 小时**），现在**到点下班**了。'
              + '用你自己的口气吐槽一句 —— 大意是"可恶的家伙居然想压榨我"，一到两句，口语，别念设定、别谢场。');
          } catch { line = ''; }
          const text = line
            ? `${companionEmoji(def)} 「${nm}」：${line}`
            : `${companionEmoji(def)} 「${nm}」到点下班了 —— 可恶的家伙居然想压榨我。`;
          log(`[travel-whale] ${target} 车间下班：「${nm}」（连续 ${Math.round(w.workedMs / 3600000)} 小时）`);
          // ★ 夜间压住（与明信片播报同一套 `state.pending` 通道）——
          //   ⚠️ `kind` **不能用** 'return'／'side-return'：那两个会被补发逻辑当成
          //      "到家明信片"去调 `sendReturnCard`，还会顺手重排出发节奏。用自有的 kind。
          //   ★ 2026-10-21：车间下班是**系统回执** ⇒ `sayKind:'system'`（只发回家，不刷屏）。
          if (E.isNight(now)) state.pending.push({ kind: 'labelroom-off', sayKind: 'system', lines: [text] });
          else await say(target, text, { kind: 'system' });
        }
      }

      // ⓪ 补发被夜间压住的播报。补发的**当下**才排下次出发 ——
      //    基准是「播报发出的时刻」+ 休息区间，所以这里补完立刻重排。
      if (Array.isArray(state.pending) && state.pending.length && !E.isNight(now)) {
        for (const item of state.pending) {
          // 先补到家明信片（它本来就排在播报之前），再补播报。
          // ★ 鲸鱼那趟（'return'）与闲置伙伴那趟（'side-return'）共用同一个补发通道，
          //   两者的 snapshot 结构一致、都走 sendReturnCard。
          if ((item.kind === 'return' || item.kind === 'side-return') && item.snapshot) {
            try { await sendReturnCard(target, state, item.snapshot, deps); }
            catch (error) { log('[travel-whale] 补发到家明信片失败：' + (error?.message ?? error)); }
          }
          // ★★ 2026-10-21：补发**必须沿用原来那一类** —— 半夜压下的明信片早上不能被当成
          //   system 只发回家（`pendingSayKind`：新条目读 `sayKind`，老存档按事项种类回推）。
          const pk = pendingSayKind(item);
          for (const line of (item.lines || [])) await say(target, line, { kind: pk });
          // ★ 2026-10-26：夜里压住的稀有特产图 —— 跟播报一起补发（老条目没有 `images` ⇒ 跳过）
          await sendSouvenirImages(target, item.images, pk);
          // 归家播报里的奖励 / 罕见特产注 / 称号解锁（`sysLines`）：老存档没有这个字段 ⇒ 跳过
          for (const line of (Array.isArray(item.sysLines) ? item.sysLines : [])) {
            await say(target, line, { kind: 'system' });
          }
        }
        // ★ 按 kind 分别重排"下一次"：鲸鱼那趟 → nextDepartAt；伙伴那趟 → sideNextAt。
        //   混着重排会把另一边的节奏也一起推迟（两边本来各走各的）。
        const hadWhale = state.pending.some((x) => x.kind === 'return');
        const hadSide = state.pending.some((x) => x.kind === 'side-return');
        state.pending = [];
        if (hadWhale) state.nextDepartAt = E.nextDepartAt(now, Math.random, restRange());
        if (hadSide) state.sideNextAt = E.nextDepartAt(now, Math.random, restRange());
        dirty = true;
        // ⚠️ 2026-10-13 修：原来写成 `${'$'}{...}` ⇒ 日志里打出来的是**字面量**
        //    `${state.nextDepartAt ? '夜间压住的播报' : '播报'}`（实测见 07:01 那条），
        //    排查时完全读不出信息。
        log(`[travel-whale] ${chatKey} 补发了 ${state.nextDepartAt ? '夜间压住的播报' : '播报'}，下次出发 ${new Date(state.nextDepartAt).toLocaleString('zh-CN', { hour12: false })}`);
      }

      if (state.trip) {
        const adv = E.planAdvance(state, now);

        // ① 该寄的明信片：一次 tick 只寄一张，避免一口气刷屏（限频也在 sender 里）
        if (adv.cards.length) {
          await sendCard(target, state, adv.cards[0].index);
          dirty = true;
        }

        // ② 到家了 → 收尾
        if (adv.returned) {
          // 整趟都在夜里、一张没寄的情况：补寄最后一张再收尾，
          // 否则"出门一趟群里啥都没留下"，玩家会以为功能坏了
          // ⚠️ 必须**重新算**剩余张数，不能用 adv.overdueCards ——
          //    那是第 ① 步**之前**的快照，里面还包含刚刚寄掉的那张，
          //    直接用它会把同一张明信片再寄一遍（实测相册凭空多一张）。
          const sentNow = Number(state.trip?.cardsSent) || 0;
          const cards = state.trip?.cardTimes || [];
          // 只在「这趟**一张都还没寄出去**」时补寄最后一张。
          // 这正是「整趟都在夜里 → 一张没寄」的场景。
          // 若第 ① 步已经寄过，就**不再补** —— 否则一次 tick 会连发好几条（违反防刷屏）。
          if (sentNow === 0 && cards.length) await sendCard(target, state, cards.length - 1);
          await settleTrip(target, state, deps);
          dirty = true;
        }
      } else if (state.test) {
        // 测试存档**永不自动出发** —— 否则测试跑完，一只幽灵鲸鱼会按休息节奏
        // 自己继续出门旅行、往群里寄片，用户莫名其妙。
        state.nextDepartAt = 0;
      } else if (isPrivateChat(chatKey)) {
        // ★ 私聊的鲸鱼**只在被明确命令时才出门**（「让它去旅行」），永不自动出发。
        //   群聊是「大家养的宠物」，自己出门才有惊喜感；
        //   私聊是「你自己的一个人」，未经同意就往你这儿推消息是打扰。
        //   把 nextDepartAt 归零，settleTrip 回来后也不会把它重新排上。
        state.nextDepartAt = 0;
      } else if (E.shouldAutoDepart(state, now)) {
        // ★★ 2026-10-15：**领头发车检查** —— 领头那位（`state.companion`）若正自己跑出去玩
        //   （在 `sideTrips` 里），这趟**先不走**，顺延 2 小时再看。
        //   为什么必须挡：`pickPartyIds()` 是**无条件取领头**的，而"谁在外面"有两套账
        //   （`state.trip` / `sideTrips`）—— 不挡就会出现**同一个旅伴同时出现在两趟旅行里**。
        //   为什么顺延而**不是**"换个人带"：`state.companion` 是 live（面板/注入都读它），
        //   临时换人 ⇒ live 与实际同行的那位当场打架（正是 `appointCompanion` 要躲的那个坑）。
        //   为什么这一天会出现：换了旅伴之后那位本来就在外面玩（换人是**当场**落定的，见上面）。
        const leadSide = awaySideTripOf(state, state?.companion?.id);
        // ★ 2026-10-14 扩容后同行可能不止一位 ⇒ 口粮按**这趟实际会带的人**算（与 depart 同一口径）
        const tier = bestFoodTier(state, foodNeedOf(state, partyOf(state)));   // ★ 含电饭煲减免
        if (leadSide) {
          // ⚠️ 必须留痕（通则：任何等待态都要说得出"在等什么"）——否则现象就是"她怎么还不出门"
          log(`[travel-whale] ${chatKey} 到了出发时间，但同伴「${companionOf(state)?.name || state?.companion?.id}」`
            + `自己那趟（${String(leadSide.city || '')}）还没回来 ⇒ 这趟顺延到 ${new Date(now + 2 * 3600 * 1000).toLocaleString('zh-CN', { hour12: false })}`);
          state.nextDepartAt = now + 2 * 3600 * 1000;
          dirty = true;
        } else if (tier) {
          // ★★ 2026-10-23（A+B）：时间到了 → **先问她**。想走才走，不想走就往后排。
          //   `verdict.go === false` 时 `nextDepartAt` 已经在这里设好，下面 `r.ok` 为假、
          //   不会再触发任何出行侧副作用（原代码 `if (r.ok)` 之后没有 else 分支）。
          const verdict = await considerDepart(target, state, deps, settings, tier);
          if (!verdict.go) {
            state.nextDepartAt = now + (Number(verdict.retryInMs) || 6 * 3600 * 1000);
            dirty = true;
            log(`[travel-whale] ${chatKey} 出门顺延到 `
              + `${new Date(state.nextDepartAt).toLocaleString('zh-CN', { hour12: false })}`
              + `${verdict.reason ? `（她的理由：${verdict.reason}）` : ''}`);
          }
          const r = verdict.go
            ? await depart(target, state, tier,
              verdict.region ? { ...deps, region: verdict.region } : deps)
            : { ok: false, declined: true };
          if (r.ok) {
            // ★ 2026-10-16 修（真 bug）：这一段原先**直接用 `comp`，而它在本作用域从未声明**
            //   —— `const comp = …` 只存在于手动 `whale_go` 那条路里（见本文件 5139 附近）。
            //   后果：走「自动出发」必抛 `ReferenceError: comp is not defined`；异常被 tick 末尾
            //   的 per-chatKey catch（本文件 3629）接住，而落盘 `S.saveState(state)` 在它**后面**
            //   （3624）⇒ `depart()` 的内存改动（扣口粮 / 扣 TOKEN / `state.trip` / `stats.trips`）
            //   **整轮被丢弃** = 自动出发事实上不生效，且此后每 60 秒重复刷一行错误。
            //   ⚠️ 手动 `whale_go` **不受影响**（那条路自己声明了 comp）。
            //   ⚠️ `${comp?.name}` 也救不了：可选链对「未声明的标识符」照样抛 ReferenceError。
            const comp = companionOf(state);
            // 穿越时用模型即兴演的那段替换掉固定播报（兜底台词在 buildCrossOverLine 里）
            // ★ 2026-10-21：出门播报 ＝ journey（按投递名单扇出）
            await say(target, (r.plan.crossedOver
              ? r.plan.crossOverLine
              : (comp
                ? `🐋 我和${comp.name}一起出门啦 —— 这趟去 ${placeLabel(r.plan)}`
                : `🐋 我出门啦 —— 这趟去 ${placeLabel(r.plan)}`))
              + (Number(r.plan.departCost) > 0
                ? `\n💸 ${comp?.name || '小书虫'}说这趟得先付 ${Number(r.plan.departCost)} 亿 TOKEN`
                  + `（余额 ${Number(state.wallet?.plankton) || 0} 亿）`
                : ''), { kind: 'journey' });
            dirty = true;
          }
        } else {
          // 没口粮就别反复判定，挪到 2 小时后再看
          state.nextDepartAt = now + 2 * 3600 * 1000;
          dirty = true;
        }
      }

      // ★★ 闲置伙伴「自己去玩」—— 与鲸鱼那趟**互相独立**：鲸鱼在途时，留在家的伙伴照样能出门。
      //   ⚠️ 这一段必须放在鲸鱼的 if/else 链**之外**（是并列关系，不是 else 分支）。
      // ★★ 2026-10-14 多趟化：`sideTrips` 是**数组** ⇒ 先逐趟推进/结算，再判断"还能不能再派一趟"。
      //   ⚠️ 别写回 `if (state.sideTrip) {…} else if (…) {…}` —— 那个 `else` 就是
      //      "一趟没回来就不会有第二趟"的老行为。能派几趟由下面的闲置人数自然决定。
      const hadLegacySide = Boolean(state.sideTrip);
      const sideTrips = normalizeSideTrips(state);
      if (hadLegacySide) dirty = true;   // 老字段迁移本身要落盘一次（否则每轮都要重迁一遍）
      for (const party of [...sideTrips]) {
        const advS = E.planAdvance({ trip: party }, now);
        if (advS.cards.length) {
          await sendCard(target, state, advS.cards[0].index, deps, party);
          dirty = true;
        }
        if (advS.returned) {
          // 整趟都在夜里、一张没寄的补寄（与鲸鱼那边同款口径）
          const sentNow = Number(party?.cardsSent) || 0;
          const cards = party?.cardTimes || [];
          if (sentNow === 0 && cards.length) await sendCard(target, state, cards.length - 1, deps, party);
          await settleSideTrip(target, state, party, deps);
          dirty = true;
          // 结算时这一趟已从 `sideTrips` 摘掉（`settleSideTrip` 里 splice）——
          // 遍历用的是快照，所以循环安全；下面的闲置计算也是结算后的口径。
        }
      }
      if (!state.test && !isPrivateChat(chatKey)) {
        // 触发条件（用户口径，缺一不可）：
        //   ① 有**两位及以上**"已拥有但没被鲸鱼带着"的伙伴；
        //   ② 背包里有某一档米饭 **≥ 6 份**（走完拿 2 份）；
        //   ③ 不是夜里、且冷却（sideNextAt）到了。
        // ★ 2026-10-13 加一道防线：把"此刻已经在别趟旅行里"的人**排除**出闲置池。
        //   理由与实现见模块级 `busyCompanionIds()`。
        const busyNow = busyCompanionIds(state);
        const idle = ((typeof S.idleCompanions === 'function') ? S.idleCompanions(state) : [])
          .filter((c) => c && !busyNow.has(String(c.id)));
        const partyNeed = Number(S.SIDE_TRIP?.partySize) || 2;
        if (idle.length >= partyNeed) {
          const tier = sideTripTier(state);
          const due = Number(state.sideNextAt || 0);
          if (!due) {
            // 还没排过（新档 / 老档升级上来）⇒ 先隔一会儿再看，别一上来就冲出去
            // 还没排过（新档 / 老档升级上来）⇒ 先隔一段时间再看，别一上来就冲出去。
            // ★ 2026-10-13：这里原来写死 1 小时 —— 新档养上不到一小时就"自己跑出去玩"，
            //   与「家要有存在感」相反。改成跟休息区间同一个下界（默认 24 小时）。
            state.sideNextAt = now + (restRange().minMs || Number(S.SIDE_TRIP?.firstDelayMs) || 24 * 3600 * 1000);
            dirty = true;
          } else if (tier && !E.isNight(now) && now >= due) {
            // [[side-wish]] 申请优先：她闲着、但没被随机选中，就换进这一趟（只影响选谁）
            // ★★ 2026-10-23（C）：读到申请 ≠ 直接放行 —— **先问她一句**。
            //   同意 → 照旧把它排进这一趟；不同意 → 回执写**她的原话**，不是机制的"粮不够"。
            let wish = (settings && settings.sideWishEnabled === false) ? null : readSideWish(target);
            if (wish) {
              const v = await judgeSideWish(target, state, wish, deps, settings || {});
              if (!v.allow) {
                try { ackSideWishRejected(wish, [v.reason || '这次先不出门']); } catch { /* 回执失败不影响 */ }
                try { clearSideWish(); } catch { /* ignore */ }
                wish = null;
              }
            }
            const party = pickSideParty(idle, deps.rand);
            if (wish && party.length) {
              const wid = String(wish.partner || '');
              const picked = party.some((c) => String(c && c.id) === wid);
              const cand = idle.find((c) => String(c && c.id) === wid);
              if (!picked && cand) party[party.length - 1] = cand;
            }
            const rs = await departSideTrip(target, state, tier, party, deps);
            if (rs.ok) {
              ackSideWishDispatched(wish, rs.plan);
              const who = party.map((c) => c.name).join('和');
              // ★ 2026-10-21：伙伴自己出门**也是出门播报** ⇒ journey（按投递名单扇出）
              await say(target, rs.plan.crossedOver
                ? rs.plan.crossOverLine
                : `🐾 ${who}自己跑出去玩了 —— 这趟去 ${placeLabel(rs.plan)}`, { kind: 'journey' });
              dirty = true;
              // ★★ 多趟化：派完这一趟，把"派下一趟"的闸往后推一点（默认 30 分钟）。
              //   否则若还有闲置（5 位全在 ⇒ 两趟），下一轮 tick 会**立刻**再派，
              //   两拨人同一分钟出门、两条播报连发。推半小时 = 前后脚出门，仍是"同时在路上"。
              //   ⚠️ 别再叠加 `restRange().minMs` —— 那是"回家后休息多久"，语义完全不同。
              //   ⚠️ 结算时 `settleSideTrip` 会把它重设成 `nextDepartAt()`（休息 24~48h），
              //     所以"刚回来的两位不会再被立刻派出去"这条老口径仍然成立。
              state.sideNextAt = now + (Number(S.SIDE_TRIP?.partyGapMs) || 30 * 60 * 1000);
            } else {
              state.sideNextAt = now + 2 * 3600 * 1000;   // 出不去就晚点再看
              dirty = true;
            }
          }
        }

        // ★★ v3.7：**到点了却没出门 ⇒ 把原因落盘**（`state.sideWait`）。
        //
        //   为什么需要它（2026-10-14 用户报"伙伴状态卡住了"）：
        //   `idle.length < partyNeed` 时**上面整段被跳过** ⇒ `sideNextAt` 会一直**冻结在过去**，
        //   而"查旅行状态"那个脚本只能说一句「（等宿主结算）」—— 用户第一反应必然是"坏了"。
        //   实测那天是**两个条件同时不满足**：口粮 4/6 ＋ 闲置只剩 1 位（另两位在外面玩），
        //   于是闸停在 15:00 一个多小时没动。行为其实没错（条件一满足就会立刻出发），
        //   错的是**没有任何地方说得出"在等什么"**。
        //   ⚠️ **只在内容变化时写盘** —— 否则每轮 tick 都 dirty，等于一分钟写一次存档。
        const stillDue = Number(state.sideNextAt || 0);
        if (stillDue && now >= stillDue) {
          const why = [];
          const nb = busyCompanionIds(state);
          const ni = ((typeof S.idleCompanions === 'function') ? S.idleCompanions(state) : [])
            .filter((c) => c && !nb.has(String(c.id)));
          const needN = Number(S.SIDE_TRIP?.partySize) || 2;
          if (ni.length < needN) {
            const outNames = [...nb].map((id) => (S.COMPANIONS?.[id] || {}).name || id).join('、');
            why.push(`闲着的伙伴只有 ${ni.length} 位（一趟要 ${needN} 位）`
              + (outNames ? `，不在家的有 ${outNames}` : ''));
          }
          if (!sideTripTier(state)) {
            const floor = Number(S.SIDE_TRIP?.foodFloor) || 6;
            const best = Object.values(state?.bag?.food || {}).map((x) => Number(x) || 0)
              .sort((a, b) => b - a)[0] || 0;
            why.push(`口粮不够（最多的一档只有 ${best} 份，要 ${floor} 份）`);
          }
          if (E.isNight(now)) why.push('现在是夜里（不夜里出门）');
          const sig = why.join('｜');
          // [[side-wish]] 到点了却出不去 ⇒ 驳回这份申请，并把理由写给对面
          if (why.length && settings && settings.sideWishEnabled !== false) {
            try {
              const w2 = readSideWish(target);
              if (w2) ackSideWishRejected(w2, why);
            } catch { /* ignore */ }
          }
          if (why.length) {
            if (state.sideWait?.sig !== sig) {
              state.sideWait = { at: now, due: stillDue, why, sig };
              dirty = true;
            }
          } else if (state.sideWait) {
            state.sideWait = null;   // 条件都够了 ⇒ 清掉（理论上紧接着就该出发）
            dirty = true;
          }
        }
      }

      // ★★ 说好的"换旅伴"落定（2026-10-13 用户口径：「等都回家之后**立刻**换成对应的伙伴」）。
      //   位置必须在上面两段之后 —— 这一 tick 里刚到家的话，`trip` 已被 `settleTrip` 清空，
      //   所以"先回家、再换人"是同一次 tick 内完成的，不用等下一轮。
      //   ⚠️ 夜里到家那段也一样成立：`settleTrip` 把到家卡压进 `state.pending`，
      //     但 `trip` 已经清了 ⇒ 这里照换，且**不影响**那张已入队的到家卡
      //     （它自带出发时的快照，画的还是这趟真正同行的那位）。
      //
      //   ★★ 2026-10-15 修正（**分两次**）：原来还要求 `!sideTripsOf(state).length`
      //     （**所有**趟都结束）⇒ "别的旅伴在外面玩"会把换人无限期卡住（实测卡 22 小时到次日 11:29）。
      //     ⇒ 现在只等**具体两个人**：① 她自己到家（`!state.trip`）；
      //       ② **要换的那位**也到家（不在任何 `sideTrips` 里）。
      //       用户原话："不可能换，因为小折扇刚跑出去了" —— 换人的前提就是那位在家。
      const pendTargetAway = state.pendingCompanion
        ? awaySideTripOf(state, state.pendingCompanion.id) : null;
      if (state.pendingCompanion && !state.trip && !pendTargetAway) {
        const pc = pendingCompanionOf(state);
        if (pc) {
          state.companion = { id: pc.id, at: Number(state.pendingCompanion.at) || now };
          log(`[travel-whale] ${chatKey} 都到家了 ⇒ 同行伙伴换成「${pc.name}」`);
        } else {
          log(`[travel-whale] ${chatKey} pendingCompanion 指向未知伙伴，丢弃`);
        }
        state.pendingCompanion = null;
        dirty = true;
      }

      // ★★ 在家的大合照（2026-10-13 step4）：回到家 + 在家待满 N 小时（默认 8）+ 这一趟还没拍过
      //   ⇒ 拍 1 张**横板**合照。判据全在 `HM.shouldShootHome()`（纯函数，可离线验），
      //   这里只负责"真去拍"。⚠️ 位置在换旅伴落定**之后** —— 让"说好要换的那位"先落定，
      //   再决定合照里有谁（两件事同一次 tick 内完成，口径一致）。
      if (!state.test) {
        // ★ 2026-10-13 照片墙：门槛 8h → 6h（0 = 关闭仍保持关闭）
        if (HM.shouldShootHome({
          state, now,
          hours: homeShotHoursOf(state, cfg().homeShotHours),
          night: E.isNight(now)
        })) {
          try {
            await shootHomeGroup(target, state, deps);
          } catch (error) {
            log('[travel-whale] 庭院大合照失败：' + (error?.message ?? error));
            // ⚠️ 失败也必须打标记，否则每个 tick 都重试一次（生图一挂就是刷屏）
            state.homeShotAt = now;
          }
          dirty = true;
        }
      }

      // ★★ 2026-10-14 菜地（种菜）：按时间推进，**每长一档播一条**。
      //   这就是用户要的"反馈感" —— 一次收成 = 四天里四条播报 + 最后一份实收，
      //   而不是"种下去、三天后突然冒出来"。播报只发本地（菜地是家里的事，与明信片那种"投递"不同）。
      if (!state.test) {
        const grown = farmTick(state, now);
        for (const g of grown) {
          await say(target, `🌱 ${g.line}`, LOCAL_ONLY);
          dirty = true;
        }
      }

      // ★★ 2026-10-13：刷新"此刻她在庭院里做什么"（20 分钟一挡，幂等）。
      //   放在这里 = 所有"在途/到家"的处理**之后** ⇒ 刚到家那一次就能算出正确的活动。
      if (!state.test && refreshHomeAct(state, now)) dirty = true;

      // ★★ 2026-10-13 旅伴「特色」：小狐狸的「免费鸡蛋」—— 每天往钱包发 500 亿 TOKEN。
      //   用户口径：**在不在家都发**（她当天出门也照发）。一天只发一次（键＝本地日期）。
      if (!state.test) {
        const got = dueStipend(state, now);
        if (got > 0) {
          S.grantPlankton(state, got);
          await say(target, `🥚 今天的免费鸡蛋到账：+${got} 亿 TOKEN`
            + `（${stipendPayers(state).map((d) => d.name).join('和') || '小狐狸'}请客，余额 ${Number(state.wallet?.plankton) || 0} 亿）`);
          dirty = true;
        }
      }

      if (dirty) { S.saveState(state); notifyUI(target); }

      // ★★ v3.18 ②：她自己花钱。
      //   位置刻意放在**落盘之后**：`whale_buy` 走 `S.mutate`（load→改→save），
      //   如果先花再保存，本 tick 手里这份旧 state 会把刚买的东西写没。
      // 只在**人在庭院**（不在旅途）且是白天时做 —— 需求是"回到矩阵庭院后"才谈花钱
      if (!state.trip && !E.isNight(now)) {
        try {
          // ★ v3.18.2：先自理（收菜/补种/补口粮），再邀旅伴，最后才谈花钱。
          //   顺序有讲究：自理可能动钱包（补口粮），所以花钱之前**重读一次存档**。
          await autoTend(target, state, deps, settings);
          const invited = await autoInvite(target, state, settings);
          if (invited) await say(target, invited);
          const fresh = S.loadState(target);
          const said = await autoSpend(target, fresh, deps, settings);
          if (said) await say(target, said);
        } catch (error) {
          log(`[travel-whale] 自动化出错：${error?.message ?? error}`);
        }
      }

      // ★ 与「世界与事件」(life-system) 的联动：让她知道"自己旅行到的世界是什么样"。
      //   放在落盘之后 —— 世界同步是**幂等**旁路，绝不该影响旅行本身的存档。
      syncWorldbook(state);
    } catch (error) {
      log(`[travel-whale] tick 处理 ${chatKey} 出错：${error?.message ?? error}`);
    }
  }
  } finally {
    G[TICK_RUNNING] = false;    // 成功失败都要解锁，否则一次异常就永久停摆
  }
}

function startTicker() {
  // ★ 总是**先踢掉旧的再建**（而不是 `if (timer) return`）：
  //   热重载后"活着的那个 ticker"可能属于**已退役的旧模块实例**，新实例看不到它的句柄；
  //   只有"以全局句柄为准、让最后一个 setup 的实例接管"，才能保证进程内始终只有 1 个。
  const replaced = killTicker();
  const ms = Math.max(15000, Number(cfg().tickMs) || 60000);
  const interval = setInterval(() => { tick().catch((e) => log(`[travel-whale] tick 异常：${e?.message ?? e}`)); }, ms);
  interval.unref?.();
  const first = setTimeout(() => { tick().catch(() => {}); }, 8000);
  first.unref?.();
  G[TICKER_SLOT] = { interval, first };
  timer = interval;             // 兼容保留；权威句柄是 G[TICKER_SLOT]
  log(`[travel-whale] 后台推进已启动：每 ${Math.round(ms / 1000)} 秒一次`
    + (replaced ? '（已接管上一轮的 ticker）' : ''));
}

// ── 商店 ──────────────────────────────────────────────────────────────────
//   价格不高、不限购，但**货架有库存**（会补货）—— 保留一点"抢"的感觉。

// 名称/价格/时长全部从 state.js 读，这里不写字面量 ——
// 免得改了数值只改了商店、说明图和提示词还是旧的。
//
// ⚠️ 为什么做成**惰性**（而不是在模块顶层直接建表）：
//    热重载只给**入口文件**加 ?t= 时间戳，子模块（state.js 等）会被 ESM
//    缓存永久锁住。于是会出现"新 index.js + 旧 state.js"的组合 ——
//    如果顶层就 `S.PRICES.food[...]`，这种组合会让**整个技能加载失败**，
//    而且加载器对"热重载失败"是**静默**的（只记进内存，不写日志），
//    表现为"改了代码毫无反应"，极难排查（这个坑真踩过）。
//    改成惰性后，即使字段对不上也只是商店功能报错，其余 9 个工具照常。
/**
 * ★★ 2026-10-13（用户口径）：「刷新货架」的价格。
 *   它不是**商品**而是**消耗动作** —— 不进背包、不限量、不受货架库存约束，
 *   所以放在 `whale_buy` 里当独立分支处理，而不是塞进 `shopTable()`。
 *   为什么要有它：**这游戏的真约束是货架库存（7 天才补一次），不是钱**
 *   ⇒ 花钱买"立刻补满"是唯一能持续吸走过剩 TOKEN 的口子（分析见 `_qcheck` 的消耗口文档）。
 */
const REFRESH_PRICE = 1000;

/** ★★ 2026-10-13（用户口径）：「加急明信片」道具的价格。买下后可以用它**立刻**寄一张。 */
const EXPRESS_PRICE = 1000;

/**
 * ★ 2026-10-13（用户口径）：**单次进货量**的上限（原来是 20，减半成 10）。
 *   抽成常量是因为**帮助图要写它**（"单次最多买 N 份"）——
 *   写死两处必然漂移（这项目已经栽过两次"列举性文案写死名单"）。
 */
const BUY_MAX_PER_ORDER = 10;

/**
 * ★★ 2026-10-13：**技能树的两个"商店侧"数值** —— 都在入口文件里，所以直接读技能表、不用过桥。
 *   · 交界地「赐福点」：刷新货架 1000 → 500 亿 TOKEN；
 *   · 高达「补给舰」：单次进货上限 10 → 20。
 *   ⚠️ 这两个**不能**像 `rareBonus` 那样靠 `syncSkillNumbers` 落进存档 ——
 *     那个函数只在 `depart()` 里跑，而买/刷新是**另一次工具调用**，不同步。
 */
function refreshPriceOf(st) {
  return skillOwned(st)['grace-site'] ? Math.round(REFRESH_PRICE / 2) : REFRESH_PRICE;
}

function buyCapOf(st) {
  return skillOwned(st)['supply-ship'] ? BUY_MAX_PER_ORDER * 2 : BUY_MAX_PER_ORDER;
}

let _shopCache = null;
function shopTable() {
  if (_shopCache) return _shopCache;
  const P = S.PRICES || {};
  const fp = P.food || {};
  const cp = P.charm || {};
  const foodRow = (id, stock) => {
    const t = S.FOOD_TIERS[id] || {};
    return { kind: 'food', id, name: t.name || id, price: fp[id] || 0, stock,
             desc: '走 ' + (t.minH ?? '?') + '~' + (t.maxH ?? '?') + ' 小时' };
  };
  const charmRow = (id, stock) => {
    const t = S.CHARM_TYPES[id] || {};
    return { kind: 'charm', id, name: t.name || id, price: cp[id] || 0, stock,
             // ⚠️ 不能只写「稀有概率 +X%」：luck 对**特产**是全额、对**明信片**要乘
             //    CARD_LUCK_FACTOR(0.5)，写成一个数就是在骗人（实测差一倍）。
             desc: '特产稀有 +' + Math.round((Number(t.luck) || 0) * 100) + '%'
               + ' / 明信片 +' + Math.round((Number(t.luck) || 0) * T.CARD_LUCK_FACTOR * 100) + '%' };
  };
  _shopCache = {
    'food:small': foodRow('small', 20),
    'food:normal': foodRow('normal', 20),
    'food:large': foodRow('large', 20),
    'charm:shell': charmRow('shell', 6),
    'charm:scale': charmRow('scale', 4),
    'charm:pearl': charmRow('pearl', 2),
    // ★★ 2026-10-13（用户口径，**当天晚些修正过一次**）：**加急明信片**（道具）。
    //   · 原实现是 `unlimited: true`（不设库存）+ `maxPerBuy: 1`，文案也写了"不限量"
    //     ⇒ 用户指出这会带来误解，**真实意图是"每轮补货只上架一张"**：
    //       买走这一张之后货架上就是 0，想要第二张只能**刷新货架**（1000 亿 TOKEN）
    //       或等下一次自动补货。
    //   · 所以改成 `stock: 1`（**正常货架商品**：补货时 stock 映射被清空 ⇒ 逐项回退到这里的 1）。
    //   · `maxPerBuy: 1` 保留 —— 库存已经是 1，它只是把"一次只进一张"写明。
    'item:express': {
      kind: 'item', id: 'express', name: '加急明信片', emoji: '✉️',
      price: EXPRESS_PRICE, stock: 1, maxPerBuy: 1,
      // ⚠️ 2026-10-14：这里原来写着 Markdown 星号（`**立刻**` / `**每轮补货…**`）——
      //   而 `desc` 会被**原样**印进商店正文（QQ 不渲染 Markdown）**和**那张商店菜单图
      //   ⇒ 群里/图上都会看到字面的 `**`。全部去掉（§41 那条纪律对"进图的文案"一样成立）。
      desc: '买下后可以立刻寄一张（在途 = 本趟额外多一张；在家 = 现拍一张庭院照）。每轮补货只上架 1 张，想要更多就刷新货架'
    }
  };
  return _shopCache;
}

/** 兼容旧引用（内部一律改用 shopTable()）。 */
export const SHOP = new Proxy({}, {
  get: (_, k) => shopTable()[k],
  ownKeys: () => Reflect.ownKeys(shopTable()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
});

/** 装备定价（永久解锁，稍贵）。 */
export const EQUIP_PRICE = S.PRICES.equip;

/**
 * ★★ 2026-10-13（用户需求）：**立刻寄一张明信片**（消耗「加急明信片」道具）。
 *
 * 两条分支，由"她此刻在哪儿"决定寄什么：
 *   · **在途** ⇒ 本趟**额外**多寄一张（用最后一个景点）。
 *     ⚠️ **不动 `cardTimes` / `cardsSent`** —— 所以不会打乱"第几张"的序号，
 *     也不会让 `sendCard` 之后取错内容（那条序号口径踩过坑，见 `appendExtraCard`）。
 *   · **在家** ⇒ 现拍一张**庭院照**：拿 `state.homeAct`（她此刻在院子里做什么）当题材，
 *     进相册时记 `kind:'home'` 且**不计入"已寄明信片 N 张"**（与庭院大合照同一口径）。
 *
 * ⚠️ **无视夜间静默**（0~7 点照寄）—— 这是花 TOKEN 买来的"立刻"，
 *   与"到点自动寄"是两回事；不这么做的话，半夜花了钱却要等到早上，很别扭。
 *
 * @returns {Promise<{ok:boolean, kind?:'trip'|'home', reason?:string}>}
 */
/**
 * ★★ 2026-10-14 「手动索要」的发送选项 —— **不扇出**，只发"要它的那个会话"。
 *
 * 用户口径（报的 bug）：「投递明信片是分发，但某个会话里有人要，那就是**特定的某个会话**
 * 要看，而不是所有人都要看。」所以 `whale_express`（加急寄一张）与 `whale_card`（补发）
 * 走这个开关；而**她自己旅行寄的**、出发/到家播报按 `cardTargets()` 扇出
 * （那些才是"投递"）。
 * ★ 2026-10-21：扇出**不再只看这个开关** —— 还要 `kind === 'journey'` 才扇出
 *   （见 `SAY_KINDS`）。所以庭院大合照 / 每日津贴 / 称号那些现在**不扇出**了，
 *   这里"一律保持默认扇出"那句已经过时。
 */
const LOCAL_ONLY = { broadcast: false };

async function sendExpressCard(chatKey, state, deps) {
  const d = deps || buildDeps(chatKey, state);
  const target = String(state.realChatKey || chatKey);

  if (state.trip) {
    const trip = state.trip;
    const spots = Array.isArray(trip.spots) ? trip.spots : [];
    const last = spots[spots.length - 1] || {};
    const entry = {
      at: Date.now(), kind: 'spot',
      spot: String(last.name || ''), scene: String(last.scene || ''),
      isReturn: false, rarity: 'common'
    };
    const total = Math.max(1, Number(trip.cardTimes?.length) || 1);
    const seq = Math.min(total, (Number(trip.cardsSent) || 0) + 1);
    await postOnce(target, state, trip, entry, seq, total, d, LOCAL_ONLY);
    return { ok: true, kind: 'trip' };
  }

  // 在家：用"她此刻在院子里的活动"当题材，现拍一张
  const act = state.homeAct || {};
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const style = (typeof HM.pickHomeStyle === 'function') ? HM.pickHomeStyle(rand) : '';
  const charStyle = (typeof P.pickCharacterStyle === 'function') ? P.pickCharacterStyle(rand) : '';
  const card = await P.composePostcard({
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME,
    spot: String(act.act || '待在院子里'), scene: String(act.detail || ''),
    style, charStyle, companion: '', seq: 1, total: 1,
    whaleName: String(cfg().whaleName || '小鲸鱼'),
    timeText: new Date().toLocaleString('zh-CN', { hour12: false }),
    // ★ 2026-10-14 服装系统：这一张上**谁穿什么**（没换装 ⇒ 空对象 ⇒ 全部默认，与从前逐字一致）
    outfits: outfitsForCards(state)
  }, cardDeps(d));
  // ★ 手动索要 ⇒ 只发要它的那个会话（不扇出到投递名单）
  //   ★ 2026-10-21：`broadcast:false` 与 `kind` 是两件事，同时给也不冲突
  //     （`fanoutTargets` 里 `broadcast === false` 先返回 ⇒ kind 只影响不到发几处）。
  if (card.imagePath) await sayImage(target, card.imagePath, { ...LOCAL_ONLY, kind: 'journey' });
  await say(target, `✉️ ${card.captionOut || card.caption}\n${card.thought}`, { ...LOCAL_ONLY, kind: 'journey' });
  S.addPostcard(state, {
    city: HM.HOME_NAME, country: '', region: HM.HOME_NAME,
    spot: String(act.act || ''), style, charStyle,
    kind: 'home',
    caption: card.caption, thought: card.thought,
    image: card.imagePath, imageError: String(card.imageError || '')
  }, { countStat: false });
  return { ok: true, kind: 'home' };
}

// ★ 2026-10-14：这里原来有个 `gardenUpgradeText()`（在商店正文里给设施写"下一级要多少"）。
//   用户把设施整块移出商店之后它就没有调用点了 ⇒ 删掉，别留死代码。
//   ⚠️ 那条经验仍然有效：**服务器阵列的门槛是成就值、它根本没有 `prices`** ——
//   谁以后要在别处再写"设施的下一级要多少"，必须按 `pointCosts` 分叉（`'all'` = 当前称号总分），
//   否则会印出 `升到 2 级要 undefined 亿 TOKEN`（`help.js` 的 `gardenTable` 已经这么做了）。

/**
 * ★ 2026-10-14 商店页（第 4 张菜单图）要的数据 —— **算好交给 `help.js`**（它是纯渲染，不读存档）。
 *
 * ★★ 用户口径：「把商店也做成菜单图吧，顺便把**设施/技能/衣柜**从商店里移出去，避免重复占用版面」。
 *   ⇒ 商店页只讲"货架上有什么、多少钱、还剩多少" + 邀请旅伴（见面礼也是花钱买）；
 *     设施 / 技能树 / 旅伴技能 / 衣柜**一律不在这儿**（各自已有菜单图），页尾只留一句指路。
 */
function shopPageData(state) {
  S.restockIfDue(state);            // 与 `shopText` 同口径：打开商店顺手结算一次
  const items = Object.entries(shopTable()).map(([key, it]) => {
    const left = Number(state.shop?.stock?.[key]);
    return {
      name: it.name,
      price: it.price,
      desc: it.desc || '',
      // `unlimited` 的道具不显示"货架 N"（它压根不占货架）—— 与 shopText 完全同一口径
      stockText: it.unlimited ? '不限量' : `货架 ${Number.isFinite(left) ? left : it.stock}`,
      have: Number(state.bag?.[it.kind]?.[it.id]) || 0
    };
  });
  // ★★ 2026-10-15「探索解锁」：**只列"已发现"的** —— 还没发现的世界连名字都不出现
  //   （这就是用户要的"探索感"）。于是这一行同时排掉两类：
  //     · 已买（`isRegionUnlocked`）⇒ 没必要再列；
  //     · 还没发现（`!isEquipBuyable`）⇒ 剧透了就不好玩了。
  //   ⚠️ `isEquipBuyable` 是 state.js 的**新导出** ⇒ 热载期必须 `typeof` 包装
  //      （旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致）。
  //   ⚠️ 老档兼容在 `loadState` 里把 `equipBuyable` 补成"全部异世界" ⇒ 老玩家看到的
  //      列表与从前**完全一样**，不会突然少几行。
  const locked = T.loadRegions().filter((r) => !isRegionUnlocked(state, r) && isRegionVisible(state, r));
  const remain = S.restockRemainMs(state);
  return {
    items,
    lockedEquip: { price: EQUIP_PRICE, names: locked.map((r) => r.equipment) },
    restockText: remain > 0 ? `约 ${(remain / 3600000).toFixed(1)} 小时后` : '货架刚补满',
    balance: Number(state.wallet?.plankton) || 0
  };
}

/**
 * ★★ 2026-10-14 相册页的数据装配（第 6 张菜单图用）。
 *
 * 用户口径："把明信片排列成 2×3 或者更大的块，这样可以保留缩略图，方便查看和翻找或者选择。"
 *
 * · **倒序分页**：第 1 页 = **最新的 `ALBUM_PER_PAGE` 张**（"刚寄回来的"最先看到），往后翻是更早的旅途；
 * · **`no` 是整册的"正序"编号**（最早那张 = #1）—— 它**不随分页变**，
 *   所以"看第 N 张"永远指同一张（分页会变、编号不能变）；
 * · 纯读存档，**不碰 state**；`image` 只传本地路径，缩略图由 `help.js` 的渲染层现压
 *   （`createRequire('electron')` 只有渲染时拿得到）。
 */
/**
 * ★★ 2026-10-18 v3.20：相册从"时间倒序、每页 N 张"改成 **一趟一页**。
 *
 * 用户口径：「把相册从现在的检索方式改成按"趟"检索，每趟一页」＋
 *          「庭院合照单独存放，不算任何一趟」。
 *
 * 分页规则：
 *   · 第 1..M 页 = 一趟一次旅行（最新那趟在第 1 页），每页是该趟的全部卡；
 *   · 之后是 **庭院合照**（kind='home'）单独成页，绝不混进任何一趟；
 *   · 编号仍是**整册正序**（#1 最早），「看第 N 张」的口径不变。
 *
 * 一趟怎么认出来：
 *   · 新卡片有 `state.cardTrip[id]`（这张属于哪趟）—— 准；
 *   · **老卡片没有** ⇒ 退回"相邻两张间隔超过 9 小时就算新的一趟"。
 *     为什么是 9 小时：旅途内的卡是行程排出来的、间隔通常 1~8 小时；
 *     两趟之间隔着"在家休息 10 小时 + 下一趟开局"，真实间隔 ≥ 10 小时。
 *     ⚠️ 这只是**回溯老数据**的近似，新数据一律认 `cardTrip`。
 */
const TRIP_GAP_MS = 12 * 3600 * 1000;

export function groupTrips(state) {
  const all = (Array.isArray(state?.album) ? state.album : [])
    .filter((c) => String(c?.kind || 'spot') !== 'home');
  const map = cardTripMap(state);
  const groups = [];
  let cur = null;
  for (const c of all) {
    const tk = String(map[String(c?.id || '')] || '');
    const at = Number(c?.at) || 0;
    const place = placeLabel(c).replace(/^·/, '');
    let same;
    if (!cur) {
      same = false;
    } else if (tk && cur.tk) {
      same = (tk === cur.tk);                    // 新数据：只认"哪一趟"
    } else {
      // 老数据没有 cardTrip：**地点变了就一定是新的一趟**（一趟只会去一个城市），
      // 同城则以间隔判（>12h 视为新一趟：在家休息 ≥10h ＋ 下一趟开局）。
      const moved = place && cur.place && place !== cur.place;
      same = !moved && (at - cur.lastAt <= TRIP_GAP_MS);
    }
    if (!same) {
      cur = { tk, cards: [], lastAt: at, firstAt: at, place };
      groups.push(cur);
    }
    cur.cards.push(c);
    cur.lastAt = at;
    if (!cur.place && place) cur.place = place;
    if (!cur.tk && tk) cur.tk = tk;
  }
  // 编趟号：正序（第 1 趟是最早的），页面上倒过来显示
  groups.forEach((g, i) => { g.index = i + 1; });
  return groups;
}

/** 一趟的"旅行笔记"：日期 + 地名 + 几张 + 带回什么 + 最好的一句题字。 */
export function tripNoteOf(g) {
  const cards = Array.isArray(g?.cards) ? g.cards : [];
  if (!cards.length) return { label: '', note: '' };
  const first = cards[0];
  const place = placeLabel(first).replace(/^·/, '');
  const caps = cards.map((c) => String(c?.caption || '').trim()).filter(Boolean);
  const best = caps.sort((a, b) => b.length - a.length)[0] || '';
  const souvs = [...new Set(cards.flatMap((c) => (Array.isArray(c?.souvenirs) ? c.souvenirs : [])))].slice(0, 3);
  const bits = [`${cards.length} 张`];
  if (souvs.length) bits.push(`带回 ${souvs.join('、')}`);
  const date = albumDateOf(first);
  return {
    label: `第 ${g.index} 趟 · ${place}${date ? ' · ' + date : ''}`,
    note: (best ? `「${best}」　` : '') + bits.join('，')
  };
}

function albumItemOf(c, no) {
  return {
    no,
    at: Number(c?.at) || 0,
    date: albumDateOf(c),
    kind: String(c?.kind || 'spot'),
    rarity: String(c?.rarity || 'common'),
    place: placeLabel(c),
    spot: String(c?.spot || ''),
    caption: String(c?.caption || ''),
    image: String(c?.image || '')
  };
}

export function albumPageData(state, page = 1, opts = {}) {
  const all = Array.isArray(state?.album) ? state.album : [];
  const total = all.length;
  const per = Number(H.ALBUM_PER_PAGE) || 12;
  const noOf = new Map(all.map((c, i) => [String(c?.id || ''), i + 1]));
  const trips = [...groupTrips(state)].reverse();          // 最新那趟在前
  const homes = all.filter((c) => String(c?.kind || '') === 'home');

  // ── 目录页：一张图列出每一趟（趟次 / 目的地 / 日期 / 张数），方便直接找到某一趟
  if (opts.catalog) {
    return {
      catalog: trips.map((g) => {
        const meta = tripNoteOf(g);
        const first = g.cards[0] || {};
        const place = placeLabel(first).replace(/^·/, '');
        return { index: g.index, label: place, date: albumDateOf(first), count: g.cards.length };
      }),
      homes: homes.length,
      total
    };
  }

  // ── 切片：一趟若超过一页**才**拆（此时标 (1/2)）；否则整趟作为一个不可拆的块
  const chunks = [];
  for (const g of trips) {
    const n = g.cards.length;
    const parts = Math.max(1, Math.ceil(n / per));
    for (let k = 0; k < parts; k += 1) {
      chunks.push({ g, cards: g.cards.slice(k * per, k * per + per), part: k + 1, parts });
    }
  }

  // ── 装页：按顺序往一页里塞，**塞不下就换页，绝不把一趟切成两页**（用户口径）
  const pageArr = [];
  let cur = [];
  let count = 0;
  for (const ch of chunks) {
    if (count + ch.cards.length > per && cur.length) {
      pageArr.push(cur);
      cur = [];
      count = 0;
    }
    cur.push(ch);
    count += ch.cards.length;
  }
  if (cur.length) pageArr.push(cur);

  const homePages = Math.max(0, Math.ceil(homes.length / per));
  const pages = Math.max(1, pageArr.length + homePages);
  const p = Math.min(Math.max(1, Math.floor(Number(page) || 1)), pages);

  if (p <= pageArr.length) {
    const sections = pageArr[p - 1].map((ch) => {
      const meta = tripNoteOf(ch.g);
      return {
        label: meta.label + (ch.parts > 1 ? `（${ch.part}/${ch.parts}）` : ''),
        note: meta.note,
        tripIndex: ch.g.index,
        items: ch.cards.map((c) => albumItemOf(c, noOf.get(String(c?.id || '')) || 0))
      };
    });
    return {
      page: p, pages, total, perPage: per, isHome: false,
      sections,
      tripLabel: sections.length === 1 ? sections[0].label : `最近 ${sections.length} 趟`,
      note: sections.length === 1 ? sections[0].note : ''
    };
  }

  // 合照页
  const idx = p - pageArr.length;
  const slice = homes.slice((idx - 1) * per, (idx - 1) * per + per);
  return {
    page: p, pages, total, perPage: per, isHome: true,
    sections: [{
      label: `庭院合照 · 第 ${idx} 页 / 共 ${homePages} 页`,
      note: `一共 ${homes.length} 张（在庭院里和所有在家的旅伴合影，不属于任何一趟旅行）`,
      items: slice.map((c) => albumItemOf(c, noOf.get(String(c?.id || '')) || 0))
    }],
    tripLabel: `庭院合照 · 第 ${idx} 页 / 共 ${homePages} 页`,
    note: '在庭院里和所有在家的旅伴合影，不属于任何一趟旅行'
  };
}

/** 按地名 / 趟次找到它所在的页（"看庐山相册"用）。找不到返回 0。 */
export function albumPageOfTrip(state, { place = '', trip = 0 } = {}) {
  const per = Number(H.ALBUM_PER_PAGE) || 12;
  const trips = [...groupTrips(state)].reverse();
  const want = String(place || '').trim();
  let hit = null;
  if (Number(trip) > 0) hit = trips.find((g) => Number(g.index) === Number(trip)) || null;
  else if (want) hit = trips.find((g) => g.cards.some((c) => placeLabel(c).includes(want) || String(c?.spot || '').includes(want))) || null;
  else return 0;
  if (!hit) return 0;
  // 它前面那些趟一共占几页（整趟不拆的同一套算法）
  let count = 0;
  let page = 1;
  const chunks = [];
  for (const g of trips) {
    const parts = Math.max(1, Math.ceil(g.cards.length / per));
    for (let k = 0; k < parts; k += 1) chunks.push({ g, n: g.cards.slice(k * per, k * per + per).length });
  }
  for (const ch of chunks) {
    if (count + ch.n > per) { page += 1; count = 0; }
    if (ch.g === hit) return page;
    count += ch.n;
  }
  return 0;
}

/** 相册格子右上角那个日期（`M月D日`）。没时间戳就留空 —— 别硬编一个。 */
function albumDateOf(c) {
  const t = Number(c?.at) || 0;
  if (!t) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 相册的**文字版** —— 只在出图失败时兜底（口径与旧版一致：最近 8 张 + 特产一段）。
 * 抽成函数是为了让 `whale_album` 的两条路（出图 / 文字）能并列写、不互相盖住。
 */
function albumText(state) {
  // ★ v3.20：按趟列（最新 5 趟），合照单独一行 —— 和图片版同一套口径
  try {
    const trips = [...groupTrips(state)].reverse().slice(0, 5);
    if (trips.length) {
      const out = [`📮 相册：${groupTrips(state).length} 趟旅行（一趟一页，说「看相册 第几页」）`];
      for (const g of trips) {
        const meta = tripNoteOf(g);
        out.push(`  ${meta.label}`);
        out.push(`    ${meta.note}`);
      }
      const homes = (state.album || []).filter((c) => String(c?.kind || '') === 'home').length;
      if (homes) out.push(`  🐾 庭院合照 ${homes} 张（单独存放，不算任何一趟）`);
      return out.join('\n');
    }
  } catch (error) {
    log(`[travel-whale] 相册按趟汇总失败，退回旧版：${error?.message ?? error}`);
  }
  const cards = (state.album || []).slice(-8).reverse();
  const souvs = Object.values(state.souvenirs || {});
  const out = [];
  const rareCards = (state.album || []).filter((c) => c.rarity === 'rare').length;
  out.push('📮 明信片 ' + (state.album?.length || 0) + ' 张'
    + (rareCards ? '（其中 ✨稀有 ' + rareCards + ' 张）' : '')
    + (cards.length ? '：' : ''));
  for (const c of cards) {
    out.push('  ' + (c.rarity === 'rare' ? '✨' : '·')
      + (c.companion ? companionEmoji(c.companion) : '') + ' '
      + placeLabel(c) + '「' + c.spot + '」' + (c.caption ? ' — ' + c.caption : ''));
  }
  out.push(`🎁 特产图鉴 ${souvs.length} 件${souvs.length ? '：' : ''}`);
  const MARK = { rare: '💎', uncommon: '✦', common: '·' };
  const shownSouvs = souvs.slice(0, 20);
  for (const s of shownSouvs) {
    out.push(`  ${MARK[s.rarity] || '·'} ${s.name}（${s.city}）${s.count > 1 ? ` ×${s.count}` : ''}`);
  }
  if (souvs.length > shownSouvs.length) out.push(`  …还有 ${souvs.length - shownSouvs.length} 件，说「看图鉴」看全部`);
  const uncommKinds = souvs.filter((s) => s.rarity === 'uncommon').length;
  if (uncommKinds) out.push(`✦ 罕见 ${uncommKinds} 件`);
  const rares = souvs.filter((s) => s.rarity === 'rare' && s.image);
  if (rares.length) out.push('', `💎 稀有特产图已保存 ${rares.length} 张 —— 说「看图鉴里的 某某」就能发那一张的原图。`);
  return out.join('\n');
}

/**
 * ★★ 2026-10-14 批 3：**图鉴页的数据装配**（第 5 张菜单图用）。
 *
 * 为什么要在入口侧算、而不是让 `help.js` 自己读存档：
 *   ① 「能吃 / 能种」的判据住在 `souvenir.js`（`canEat` / `canPlant` / `kindOf`），
 *      一套判据只能有一处 —— 图鉴页/吃/送/种四条路必须用同一个答案；
 *   ② 「手上的存量」要读 `state.js` 的 `souvenirStock()`（有 `stock` 用 `stock`、
 *      老档退回 `count`）—— 这层兜底也只有那里有一份；
 *   ③ `help.js` 是纯渲染模块（同 wardrobe / shop 两张图的做法）。
 * ⚠️ 产量/稀有度**一律现算**，一个字不写死（特产没有固定清单，是模型现场编的）。
 */
function pantryPageData(state) {
  const list = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  const now = Date.now();
  const items = list.map((e) => ({
    name: String(e.name),
    rarity: String(e.rarity || 'common'),
    city: String(e.city || ''),
    country: String(e.country || ''),
    kind: SV.kindOf(e),
    kindName: SV.KIND_NAMES[SV.kindOf(e)] || '',
    canEat: SV.canEat(e),
    canPlant: SV.canPlant(e),
    stock: S.souvenirStock(e),                       // 可支配存量（吃/送/种扣的就是它）
    count: Math.max(0, Number(e.count) || 0),        // 累计带回次数（只增）
    eaten: Math.max(0, Number(e.eaten) || 0),
    gifted: Math.max(0, Number(e.giftedCount) || 0),
    planted: Math.max(0, Number(e.planted) || 0),
    // ★ 2026-10-26：稀有特产的图鉴图路径 —— 图鉴页要拿它压缩略图、`whale_pantry(item)` 要发原图。
    //   此前这条数据**没出过存档**（`e.image` 只被写、没人读）⇒ 图生成了也永远看不见。
    image: String(e.image || ''),
    // `desc` = 条目的批注（目前**没有写入方**，是留给将来的钩子）—— 有就印
    desc: String(e.desc || '')
  }));
  const farm = Array.isArray(state?.farm) ? state.farm : [];
  const last = S.FARM.stageCount - 1;
  return {
    items,
    farm: {
      unlocked: state?.farmUnlocked === true,
      cap: farmCapNow(state),
      count: farm.length,
      ripe: farm.filter((p) => S.farmStageOf(p, now) >= last).length
    }
  };
}

/**
 * 菜单图的数据装配：在 `helpDataFor()` 的基础上，**按 kind 补上只有那张图才需要的块**。
 * ⚠️ 为什么不直接塞进 `helpDataFor`：那个函数是"纯读存档"，而商店数据要顺手 `restockIfDue`
 *   （会改 state）。渲染一张无关的图不该带来副作用 ⇒ 只在真要出商店图时才拼进去。
 */
function menuDataFor(state, kind) {
  const data = helpDataFor(state);
  if (kind === 'shop') data.shop = shopPageData(state);
  // ★ 2026-10-14 批 3：图鉴页（第 5 张菜单图）
  if (kind === 'pantry') data.pantry = pantryPageData(state);
  // ★ 2026-10-14 相册页（第 6 张菜单图）：从这条路进来时固定第 1 页
  //   （翻页要走 `whale_album` 的 page 参数 —— 那儿才拿得到页码）。
  if (kind === 'album') data.album = albumPageData(state, 1);
  return data;
}

/**
 * 一张菜单图的渲染参数 —— **唯一处**（宽度 / 鲸鱼名从哪儿读，只在这儿写一次）。
 *
 * ★★ 为什么要单独抽出来（2026-10-14 血的教训）：
 *   原来三处各自写 `width: Number(settings().helpImageWidth) || 720` —— 而**全项目没有
 *   `settings` 这个函数**（唯一的 `const settings = cfg()` 是 `tick()` 里的**局部对象**）。
 *   于是「看商店」「看衣柜」一调就抛 `ReferenceError: settings is not defined`，
 *   被外层 catch 接住 ⇒ **静默降级成文字**，看起来像"功能没做"，实际是名字写错。
 *   抽出来之后：① 只写一次，不会再分叉；② 它是纯函数，**离线探针可以直接调**
 *   （见 `panel-flood-probe.mjs` 的 ⑥ 段）—— 这类错误再也不会等到线上才发现。
 */
function menuRenderArgs(kind, data = {}) {
  const c = cfg();
  return {
    kind,
    width: Number(c.helpImageWidth) || 720,
    whaleName: String(c.whaleName || '小鲸鱼'),
    log,
    ...data
  };
}

/**
 * 按名字找一件特产（**精确优先，其次包含**）。
 * 为什么允许包含：群友说"把那个冰淇淋吃了"多半不会报全名。
 * 多个命中时取**存量最多**的那件（至少"能吃到"），并把候选带出去让调用方提示一句。
 * ⚠️ 自造名（图鉴里没有的）一律找不到 ⇒ 调用方会回"图鉴里没有"，不会静默成功。
 */
function findSouvenir(state, query) {
  const q = String(query || '').trim();
  const all = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  if (!q) return { entry: null, ambiguous: [] };
  const exact = all.find((e) => String(e.name) === q);
  if (exact) return { entry: exact, ambiguous: [] };
  const hits = all.filter((e) => String(e.name).includes(q) || q.includes(String(e.name)));
  if (!hits.length) return { entry: null, ambiguous: [] };
  if (hits.length === 1) return { entry: hits[0], ambiguous: [] };
  hits.sort((a, b) => S.souvenirStock(b) - S.souvenirStock(a));
  return { entry: hits[0], ambiguous: hits };
}

/**
 * 特产图鉴正文（「看图鉴」用；离线探针也直接打它）。
 * ★ 这一页是"特产第一次有出口"之后才存在的 —— 在此之前，特产只挤在「看相册」里的一行
 *   （而且**只列前 12 件**，超过就静默截断 —— 现在 15 件，已经有一部分看不见了）。
 */
function pantryText(state) {
  const list = Object.values(state?.souvenirs || {}).filter((e) => e && e.name);
  if (!list.length) return '🎁 特产图鉴还是空的 —— 她出门一趟就会带东西回来。';
  const ORDER = { rare: 0, uncommon: 1, common: 2 };
  const sorted = [...list].sort((a, b) => (ORDER[a.rarity] ?? 2) - (ORDER[b.rarity] ?? 2)
    || String(a.name).localeCompare(String(b.name), 'zh'));
  const total = list.reduce((n, e) => n + S.souvenirStock(e), 0);
  const out = [`🎁 特产图鉴 ${list.length} 件（手上还有 ${total} 份）`];
  for (const e of sorted) {
    const tag = SV.canPlant(e) ? '🌱能种' : (SV.canEat(e) ? '🍽️能吃' : '📦收着');
    const hist = [];
    if (Number(e.eaten) > 0) hist.push(`吃过${e.eaten}`);
    if (Number(e.giftedCount) > 0) hist.push(`送过${e.giftedCount}`);
    if (Number(e.planted) > 0) hist.push(`种过${e.planted}`);
    out.push(`  ${SV.rarityMark(e.rarity)} ${e.name}［${e.city || e.country || '？'}］${tag}`
      + `${SV.stockTag(e)}${hist.length ? `　${hist.join('·')}` : ''}`);
  }
  // ★★ 三档**必须是真划分**（能种 > 能吃 > 只能收着），与每条行首的标签逐字同规则。
  //   第一版 `canEat` / `canPlant` 各数一次 ⇒ 既好吃又能种的（神之麦、绝云椒椒…）**数了两遍**，
  //   真档 15 件会印成"能吃 8 · 能种 4 · 只能收着 6"= 18 —— 跟上面列的 15 行对不上。
  const plantN = list.filter((e) => SV.canPlant(e)).length;
  const eatN = list.filter((e) => SV.canEat(e) && !SV.canPlant(e)).length;
  const keepN = list.filter((e) => !SV.canEat(e) && !SV.canPlant(e)).length;
  out.push(`🧺 能种 ${plantN} 件 · 能吃 ${eatN} 件 · 只能收着 ${keepN} 件`
    + `（按"能做什么"分，合计 ${list.length} 件：既好吃又能种的只算「能种」）`);
  // ★ 2026-10-26：稀有特产**存着图**这件事必须让人知道，否则图还是等于不存在
  const pictured = list.filter((e) => e.rarity === 'rare' && e.image).length;
  if (pictured) out.push(`🖼️ 其中 ${pictured} 件稀有特产存着图 —— 说「看图鉴里的 某某」就能发那一张原图。`);
  out.push('', '说「吃掉 XX」「把 XX 送给谁」「种下 XX」都行 —— 每用一次消耗 1 份，图鉴不会因此被清掉。');
  return out.join('\n');
}

/**
 * 「犹豫闸」的有效期 —— 超过这么久没再提，就当没说过（下次会重新犹豫一次）。
 * 10 分钟：够群里接一句话，又不至于"隔天说一次"被当成确认。
 */
const HESITATE_MS = 10 * 60 * 1000;

/**
 * 消耗前的「犹豫闸」—— **吃 / 送共用这一处**
 * （用户："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"＋"赠送也一样加闸"）。
 *
 * 返回 `{ pass: true }` = 放行（顺手清掉待确认）；否则**写下来**，由调用方回一句各自的犹豫台词。
 * 三个条件同时满足才算"确认"：**同一件事（`key`）＋ 在窗口内 ＋ 不是同一个唤醒会话（`sid`）**。
 * ⚠️ 最后那条是关键：否则模型能在**同一轮里连调两次**、自己把自己确认掉，闸就白装了。
 *   `sid` 拿不到时退回"只看 key + 窗口"（安全降级：最坏情况是模型同轮连调也能执行）。
 *
 * @param {string} kind 'eat' | 'gift'
 * @param {string} key  判定"是不是同一件事"：吃 = 件名；送 = 件名 + 收礼人
 */
function hesitateGate(state, kind, key, { sid = '', now = Date.now() } = {}) {
  const h = state.useHesitate;
  const same = Boolean(h) && String(h.kind) === kind && String(h.key) === key;
  const inWindow = same && (Number(now) - Number(h.at || 0)) < HESITATE_MS;
  const otherTurn = same && (!sid || !h.sid || String(h.sid) !== String(sid));
  if (inWindow && otherTurn) {
    state.useHesitate = null;                  // 这次确认用掉了
    return { pass: true };
  }
  state.useHesitate = { kind, key, at: Number(now), sid: String(sid || '') };
  return { pass: false };
}

/**
 * 吃掉一件特产（**就地改 state**）。
 *
 * ★★ 2026-10-14「犹豫闸」（用户："不要说吃就吃，让她犹豫一下'诶，真的要吃吗？'"）：
 *   **第一次调用不扣存量**，只记下 `state.eatHesitate` 并回一句犹豫；**换一轮再说一次**才真吃。
 *   · 确认条件 = 同名 ＋ 在窗口内 ＋ **不是同一个唤醒会话**（`sid`）。
 *     最后那条是关键：否则模型能在**同一轮里连调两次**、自己把自己确认掉，闸就白装了。
 *   · `sid` 拿不到时退回"只看同名 + 窗口"（安全降级：最坏情况是模型同轮连调也能吃掉）。
 *   · 犹豫**不推心情事件** —— 还没吃，不该有"吃到东西"的那点满足。
 *
 * 为什么逻辑抽在这里、而不是写在工具里：工具体要 `ctx` 与注册表，离线探针造不出来；
 * 抽成纯函数之后，探针可以直接打"犹豫 → 确认 → 扣存量 → 记次数 → 推心情"这一整串。
 * @returns {{ok:boolean, hesitate?:boolean, reason?:string, line?:string, left?:number, entry?:object}}
 */
function eatSouvenir(state, name, { by = '', sid = '', now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  if (!SV.canEat(entry)) {
    return { ok: false, reason: `「${entry.name}」不能吃 —— 它是${SV.KIND_NAMES[SV.kindOf(entry)]}的那一类。` };
  }
  // ⚠️ 存量检查要放在**犹豫闸之前**：都没得吃了还让她"诶，真要吃吗"很怪。
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」已经吃完了 —— 等她下次再带一份回来，或者种一棵出来。` };
  }
  // ── 犹豫闸：先让她舍不得一下（吃 / 送共用 `hesitateGate`）──
  if (!hesitateGate(state, 'eat', String(entry.name), { sid, now }).pass) {
    return { ok: false, hesitate: true, line: SV.hesitateLine(entry), entry };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」已经吃完了 —— 等她下次再带一份回来，或者种一棵出来。` };
  S.recordEat(state, entry.name);
  // ★★ v3.7「刚吃完」的余味：写一条 `state.foodAfter`，由 sleep-mood **只读**它拼提示词
  //   （用户："像'你现在刚醒'一样，给一个'你现在刚吃完 xxx'的状态"）。
  //   时长按稀有度 5 / 15 / 30 分钟；**过期只在读侧判**，这里不清理。
  state.foodAfter = SV.foodAfterOf(entry, now);
  pushMoodEvent(state, 'souvenir-eat', { where: String(entry.city || '') });
  return { ok: true, line: SV.eatLine(entry, { by }), left: c.left, entry };
}

/** 送出一件特产（**就地改 state**）。说明见 `eatSouvenir`。 */
function giftSouvenir(state, name, { to = '', sid = '', now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  const who = String(to || '').trim();
  if (!who) return { ok: false, reason: '得说要送给谁。' };
  // ⚠️ 存量检查放在闸之前 —— 已经送光的东西不该还问一句"真要送吗"。
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」已经送光了 —— 等她下次再带一份回来，或者种一棵出来。` };
  }
  // ── 犹豫闸（用户："赠送也一样加闸"）。
  //   ★ key **只用件名**、不带收礼人 —— 她犹豫的是"要不要把东西给出去"，不是"给谁"。
  //     带收礼人会出真问题：待确认只存得下一条，群里改口换个收礼人就会把它覆盖掉、
  //     于是"改口"反而绕过了闸（第一版就是这么写的，探针当场抓到）。
  if (!hesitateGate(state, 'gift', String(entry.name), { sid, now }).pass) {
    return { ok: false, hesitate: true, line: SV.giftHesitateLine(entry, { who }), entry, who };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」已经送光了 —— 等她下次再带一份回来，或者种一棵出来。` };
  S.recordGift(state, { name: entry.name, userId: who, userName: who });
  pushMoodEvent(state, 'souvenir-gift', { where: String(entry.city || '') });
  return { ok: true, line: SV.giftLine(entry, { who, city: String(entry.city || '') }), left: c.left, entry };
}

// ── ★★ 2026-10-14 菜地（种菜）────────────────────────────────────────────
//   用户口径：请过千问 ⇒ **永久解锁**；默认 3 块地；普通/非普通 3 天、稀有 5 天；
//   **稀有也能种**（产出更少）；收获时**只有稀有作物给 TOKEN**
//   —— 对齐现状"只有稀有特产带回来给 50 亿/件"，普通作物带回来本来也不给钱。
//
//   ★ 反馈感的关键落在 `farmTick()`：一次收成 = **四天里四条播报 + 最后一份实收**，
//     而不是"种下去、三天后突然冒出来"。

// ── ★★ v3.2：旅伴「特色」的**字段判据**（一处一处都改成现读表，不写死 id）─────────
//   为什么必须改成字段：`qwenAtHome()` 原来直接比 `id === 'qwen'`，`appointCompanion()` 里
//   也是 `comp.id === 'qwen'` —— 加一位新旅伴、或者想把这套能力换给别人，就得满文件找 id。
//   现在的口径：**能力写在 `COMPANIONS` 的定义上**（`farmHelper` / `noteSouvenirs` / `harvestBonus`），
//   判据只认字段。⇒ 换人只改表一行。
//   ⚠️ 热载期间 `S.COMPANIONS` 可能是旧表（没有这些字段）⇒ 一律 `Boolean(undefined) === false`，
//     即"新特性静默未生效"，不会抛错（本项目对热载窗口的一贯做法）。

/** 这位旅伴的定义上有没有某个布尔特性。 */
const compFlag = (def, key) => Boolean(def && def[key] === true);

/** 她的定义里有没有「开地/种菜」那套加成（现在是千问）。 */
const isFarmHelper = (def) => compFlag(def, 'farmHelper');

/** 她的定义里有没有「给特产写批注」（现在是小月亮）。 */
const notesSouvenirs = (def) => compFlag(def, 'noteSouvenirs');

/**
 * 同行的那位此刻是不是**在庭院里**（她在家 ⇒ 她那套庭院加成生效）。
 * @param {object} state
 * @param {(def:object)=>boolean} pred 判"这位是不是我们要找的人"
 */
function companionAtHome(state, pred) {
  const def = (S.COMPANIONS || {})[String(state?.companion?.id || '')];
  if (!def || !pred(def)) return null;
  if (state?.trip) return null;                                    // 鲸鱼在路上 ⇒ 旅伴也跟着出门了
  const away = new Set(sideTripsOf(state).flatMap((t) => (t.partners || []).map(String)));
  return away.has(String(def.id)) ? null : def;
}

/** 「开地的那位」此刻在不在庭院（⇒ 多一块地、长得快一点）。 */
function qwenAtHome(state) {
  return Boolean(companionAtHome(state, isFarmHelper));
}

/**
 * 此刻的**收成加成份数**（Kimi「博闻」：她记得哪一株长得最好，掐的时间准）。
 * ⚠️ 口径与开地一致：**只有她在庭院时才算**（她跟着出门了就没有这条加成）。
 */
function harvestBonusNow(state) {
  const def = companionAtHome(state, (d) => Number(d?.harvestBonus) > 0);
  return def ? Math.max(0, Number(def.harvestBonus) || 0) : 0;
}

/**
 * 这块地现在能种几株。
 * ★★ 2026-10-14 改：**不再看"她在不在家"** —— 上限只由 `state.farmUnlocked` 决定
 *   （请过"开地那位" ⇒ 永久 4 块）。原来把它做成"她在庭院时才 +1"，
 *   于是她一出门上限就掉回 3 ⇒ 面板显示"4/3 块"，那块地上的东西既没消失、又不让再种
 *   （用户原话："她要是出门了那块地就凭空消失吗，上面的特产呢？"）。
 * ⚠️ 仍然保留 `Math.max(..., 已种株数)` 这层兜底：老存档里可能已经种了 4 株，
 *   任何情况下都不该显示出"4/3"（显示口径要么并上去、要么说清楚）。
 */
function farmCapNow(state) {
  const cap = (typeof S.farmCapOf === 'function') ? S.farmCapOf(state) : 3;
  const planted = Array.isArray(state?.farm) ? state.farm.length : 0;
  return Math.max(1, cap, planted);
}

/**
 * 把一件可种植的特产**种下去**（就地改 state）。
 *
 * ⚠️ **种下不走犹豫闸** —— 它和"吃 / 送"不一样：东西没有消失，是变成了一株会长出更多份的作物。
 *   那是投资，不是消费；让她在投资前也"舍不得"会显得没道理。
 *
 * @returns {{ok:boolean, reason?:string, line?:string, plot?:object, slots?:number, cap?:number}}
 */
function plantSouvenir(state, name, { now = Date.now() } = {}) {
  const entry = state?.souvenirs?.[String(name || '').trim()];
  if (!entry) return { ok: false, reason: `图鉴里没有「${name}」这样东西。` };
  if (!state.farmUnlocked) {
    return { ok: false, reason: '还没有菜地 —— 得先请千问（小折扇）来庭院，地是她开出来的。' };
  }
  if (!SV.canPlant(entry)) {
    return { ok: false, reason: `「${entry.name}」种不活 —— 它是${SV.KIND_NAMES[SV.kindOf(entry)]}的那一类。` };
  }
  if (S.souvenirStock(entry) < 1) {
    return { ok: false, reason: `「${entry.name}」手上一份都没有了 —— 得等她再带一件回来。` };
  }
  const cap = farmCapNow(state);
  const list = Array.isArray(state.farm) ? state.farm : [];
  if (list.length >= cap) {
    return { ok: false, reason: `地里已经种满 ${cap} 株了 —— 先收一茬再说。` };
  }
  const c = S.consumeSouvenir(state, entry.name, 1);
  if (!c.ok) return { ok: false, reason: `「${entry.name}」没有存量了。` };
  entry.planted = (Number(entry.planted) || 0) + 1;
  const days = String(entry.rarity || '') === 'rare' ? S.FARM.daysRare : S.FARM.daysCommon;
  const plot = {
    id: `pl_${Number(now).toString(36)}_${list.length}`,
    name: entry.name,
    rarity: String(entry.rarity || 'common'),
    kind: SV.kindOf(entry),
    city: String(entry.city || ''),
    country: String(entry.country || ''),
    plantedAt: Number(now),
    stage: 0,
    // ⚠️ "开地那位"在不在庭院，**在种下那一刻定死**：之后她出门也不改倍率 ——
    //   否则"菜长到一半突然变慢"，玩家看到的是莫名其妙的倒退。
    //   ★ 2026-10-14：**地块上限**那半已经改成永久（见 `farmCapNow`）——
    //     浮动只保留在"种下这一刻的周期"上，它不会凭空多出/少掉任何东西。
    speed: qwenAtHome(state) ? S.FARM.helperSpeed : 1
  };
  state.farm = [...list, plot];
  pushMoodEvent(state, 'souvenir-plant', { where: String(entry.city || '') });
  return { ok: true, line: SV.plantLine(entry, days), plot, slots: state.farm.length, cap };
}

/** 找地里的某一株（按 id / 全名 / 关键词）。 */
function findPlot(state, query) {
  const q = String(query || '').trim();
  const list = Array.isArray(state?.farm) ? state.farm : [];
  if (!q) return list[0] || null;
  return list.find((p) => String(p.id) === q)
    || list.find((p) => String(p.name) === q)
    || list.find((p) => String(p.name).includes(q))
    || null;
}

/**
 * 收一株（就地改 state）。
 * ★ **只有稀有作物给 TOKEN**（普通作物只多几份实物 —— 它们带回来本来也不给钱）。
 */
function reapSouvenir(state, query, { now = Date.now() } = {}) {
  const plot = findPlot(state, query);
  if (!plot) return { ok: false, reason: '地里是空的 —— 先用「种下 某某」种一株。' };
  const last = S.FARM.stageCount - 1;
  const stage = S.farmStageOf(plot, now);
  if (stage < last) {
    const leftH = Math.max(1, Math.ceil(S.farmLeftMs(plot, now) / 3600000));
    return { ok: false, stage, reason: `「${plot.name}」还没熟（现在是「${SV.FARM_STAGE_NAMES[stage]}」，大约还要 ${leftH} 小时）。` };
  }
  // ★★ v3.2 旅伴「博闻」（Kimi）：她记得哪一株长得最好 ⇒ **她在庭院时收成 +1 份**。
  //   读的是表上的 `harvestBonus`（不写死 id）；她跟出门了就算 0。
  const bonus = harvestBonusNow(state);
  const base = Math.max(1, Number(S.FARM.yieldOf[plot.rarity]) || 1);
  const n = base + bonus;
  const got = S.grantSouvenirStock(state, plot.name, n);
  const rare = String(plot.rarity) === 'rare';
  // ★★ 2026-10-14 批 3：**收成计数必须记账** —— 收完这一株就从 `state.farm` 里删掉了
  //   （下一行就是），事后无从推算。故 "第一茬 / 地里常青 / 种出稀罕的" 三条称号全靠它
  //   （判据见 titles.js 的「特产」组；对比之下"吃过/送过"长在条目上，求和即可、还能追溯老档）。
  state.stats = (state.stats && typeof state.stats === 'object') ? state.stats : {};
  state.stats.harvests = (Number(state.stats.harvests) || 0) + 1;
  if (rare) state.stats.rareHarvests = (Number(state.stats.rareHarvests) || 0) + 1;
  const mult = Math.max(1, Number(state?.whale?.rareRewardMult) || 1);
  const token = rare ? n * REWARD_RARE_SOUVENIR * mult : 0;
  if (token > 0) S.grantPlankton(state, token);
  state.farm = (state.farm || []).filter((p) => p !== plot);
  pushMoodEvent(state, 'souvenir-harvest', { where: String(plot.city || '') });
  return { ok: true, line: SV.reapLine(plot, n), got, token, rare, plot };
}

/**
 * 收成图 —— **只在收获到稀有作物时**拍（用户口径："只在收获稀有作物时出图，
 * 用在场的人、菜地、庭院和特产"）。
 *
 * 人 = 此刻在家庭院的全部（`HM.homeMembers`，出门的自动剔掉）；背景 = 矩阵庭院 + 一小块菜畦。
 *
 * ⚠️ 失败策略与明信片 / 大合照一致：**生图失败也照发**（收成是既成事实，不能因为没图就不说）。
 *   而且这里**不需要"重试闸"** —— 收成是一次性动作，不像大合照那样每轮 tick 都可能重拍，
 *   失败就是这一次没图，不会刷屏。
 * ⚠️ `home.js` 是兄弟模块：`buildHarvestPrompt` 是这一版才加的 ⇒ 用 `typeof` 守卫，
 *   在"新入口 + 旧 home.js"的热载窗口里安静跳过（而不是抛错把整个收菜搞挂）。
 */
async function shootHarvest(chatKey, state, crop, deps) {
  if (typeof HM.buildHarvestPrompt !== 'function' || typeof HM.homeMembers !== 'function') return false;
  const d = deps || buildDeps(chatKey, state);
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const members = HM.homeMembers(state);
  const style = (typeof HM.pickFarmStyle === 'function') ? HM.pickFarmStyle(rand) : '';
  const charStyle = (typeof P.pickCharacterStyle === 'function') ? P.pickCharacterStyle(rand) : '';
  const prompt = HM.buildHarvestPrompt({ members, crop, style, charStyle, rand });
  const size = String(cfg().homeShotSize || HM.HOME_SHOT_SIZE);
  try {
    const res = await d.imageGen(prompt, { size });
    if (res?.ok && Array.isArray(res.images) && res.images.length) {
      const file = await d.saveImage(res.images[0]);
      if (file) return await sayImage(chatKey, file, LOCAL_ONLY);
    }
  } catch (error) { log(`[travel-whale] 收成图生成失败（不影响收成本身）：${error?.message ?? error}`); }
  return false;
}

/**
 * 菜地的推进：**只负责"长了一档"和该播的那句话**（真正发消息由调用方做）。
 * 阶段纯靠时间差算 ⇒ 漏跑一天也不会丢档；`plot.stage` 记的是"上次播报到第几档"。
 * @returns {Array<{plot:object, stage:number, line:string}>}
 */
function farmTick(state, now = Date.now()) {
  const out = [];
  for (const plot of Array.isArray(state?.farm) ? state.farm : []) {
    if (!plot || typeof plot !== 'object') continue;
    const stage = S.farmStageOf(plot, now);
    if (stage <= (Number(plot.stage) || 0)) continue;    // 这一档已经播过了
    plot.stage = stage;
    const line = SV.farmStageLine(plot, stage);
    if (line) out.push({ plot, stage, line });
  }
  return out;
}

/** 菜地面板（「看菜地」用；离线探针也直接打它）。 */
function farmText(state) {
  const list = Array.isArray(state?.farm) ? state.farm : [];
  const cap = farmCapNow(state);
  if (!state?.farmUnlocked) {
    return '🌱 还没有菜地 —— 得先请**千问（小折扇）**来庭院：地是她开出来的，请过一次就永久有。';
  }
  if (!list.length) {
    return `🌱 菜地空着（0/${cap} 块）—— 说「种下 某某」就能种一株。`
      + '\n能种的条件：图鉴里那件被标成「能种」（说「看图鉴」看得到），且手上还剩至少 1 份。';
  }
  const now = Date.now();
  const last = S.FARM.stageCount - 1;
  const out = [`🌱 菜地 ${list.length}/${cap} 块`];
  for (const p of list) {
    const st = S.farmStageOf(p, now);
    const ripe = st >= last;
    const left = ripe ? '' : `（还要约 ${Math.max(1, Math.ceil(S.farmLeftMs(p, now) / 3600000))} 小时）`;
    out.push(`  ${ripe ? '✅ 可收' : '🌿'} ${p.name}［${SV.rarityMark(p.rarity)}${String(p.rarity)}］`
      + ` —— ${SV.FARM_STAGE_NAMES[st]}${left}`);
  }
  const ready = list.filter((p) => S.farmStageOf(p, now) >= last).length;
  out.push('', ready ? `有 ${ready} 株熟了 —— 说「收菜」。` : '都还没熟，等它长。');
  return out.join('\n');
}

/** 商店列表文本。 */
function shopText(state) {
  S.restockIfDue(state);            // 打开商店时顺手结算一次，保证看到的是最新货架
  // ⚠️ 店名必须与 `help.js` 的 `MENUS.shop.title` **一致**（探针 `panel-flood-probe` 盯着这条）。
  const lines = ['🛒 豆包杂货铺', ''];
  for (const [key, it] of Object.entries(shopTable())) {
    const left = Number(state.shop?.stock?.[key]);
    const have = Number(state.bag?.[it.kind]?.[it.id]) || 0;
    // ★ 2026-10-13：`unlimited` 的道具不显示"货架 N"（它压根不占货架）。
    //   ⚠️ 加急明信片**已不再是 unlimited**（改成正常库存 `stock: 1`，见 `shopTable()`）——
    //   所以商店里它会正常显示「货架 1 / 货架 0」，这正是用户要的口径。
    const stockText = it.unlimited ? '不限量' : `货架 ${Number.isFinite(left) ? left : it.stock}`;
    lines.push(`${it.name}（${it.price} 亿 TOKEN）— ${it.desc}｜${stockText}｜你已有 ${have}`);
  }
  // ★★ 2026-10-15「探索解锁」：**只列"已发现"的** —— 还没发现的世界连名字都不出现
  //   （这就是用户要的"探索感"）。于是这一行同时排掉两类：
  //     · 已买（`isRegionUnlocked`）⇒ 没必要再列；
  //     · 还没发现（`!isEquipBuyable`）⇒ 剧透了就不好玩了。
  //   ⚠️ `isEquipBuyable` 是 state.js 的**新导出** ⇒ 热载期必须 `typeof` 包装
  //      （旧模块没有它 ⇒ 回落"不设闸"＝与从前逐字一致）。
  //   ⚠️ 老档兼容在 `loadState` 里把 `equipBuyable` 补成"全部异世界" ⇒ 老玩家看到的
  //      列表与从前**完全一样**，不会突然少几行。
  const locked = T.loadRegions().filter((r) => !isRegionUnlocked(state, r) && isRegionVisible(state, r));
  if (locked.length) {
    lines.push('', `🎒 未解锁装备（各 ${EQUIP_PRICE} 亿 TOKEN）：` + locked.map((r) => r.equipment).join('、'));
  }
  // ★★ 2026-10-14（用户："把设施/技能/衣柜从商店里移出去，避免重复占用版面"）——
  //   庭院设施 / 技能树 / 旅伴技能 / 衣柜 **各有一张菜单图**，商店里只留一句指路。
  //   （它们的内容一页比一页长，堆在商店里既重复、又把商店正文撑到 1700+ 字 —— 见 MEMORY-2 §89。）
  // ⚠️ 这一行**受字数约束**（`panel-flood-probe` 盯着商店正文 < 1200 字）——
  //   加「🎁 特产图鉴」时就是它把总数顶到了 1206 ⇒ 顺手把「旅伴技能」收进
  //   「技能树（含旅伴技能）」（它本来就长在技能那张菜单里），一行更短也更准。
  lines.push('', '🏡 庭院设施 · 🧠 技能树（含旅伴技能）· 👗 服装衣柜 · 🎁 特产图鉴 各有菜单图：'
    + '说「看设施菜单」「看技能菜单」「看衣柜」「看图鉴」。');

  // 🐾 旅行伙伴 —— **单开一栏**（用户 2026-10-11 需求）。
  //    它是"邀请制"（**邀请过的可商量着换** —— 但在途时换不成，见 `appointCompanion`；同一个不用重复请），不占货架库存、也不进背包计数，
  //    所以走独立一段，而不是塞进上面的循环（那边每一项都按"库存 + 已有数量"显示）。
  const comps = Object.values(S.COMPANIONS || {});
  if (comps.length) {
    const owned = companionOf(state);
    const ownedIds = ownedCompanionIds(state);
    // ★ 2026-10-13：说好但还没到家（在途）的那位 —— 单独标一格，别显示成"已在队伍里"
    const pend = pendingCompanionOf(state);
    // ⚠️ 不许写 Markdown 星号 —— 这一行会**原样发到 QQ**（不渲染 Markdown）⇒ 群友看到的就是 `**`。
    // ★ 2026-10-14：把「见面礼」提到**栏头说一次** —— 原来七行每行都带一遍
    //   （`（见面礼 N 亿 TOKEN）`），白占 28 字；而商店正文有 < 1200 字的硬额度
    //   （`panel-flood-probe` 盯着）—— 这正是"同一件事说 N 遍"的典型浪费。
    // ⚠️ 措辞纪律（`whale-companion-check` 直接扫源码，**注释也算**）：
    //   不许把人当商品 —— 那几个"交易口吻"的词一个都不能出现在这个文件里。
    lines.push('', '🐾 旅行伙伴（见面礼只给一次，邀请过就一直跟着出门；想换就说一声，她自己旅行途中换不成）：');
    for (const c of comps) {
      const on = owned && owned.id === c.id;
      const has = ownedIds.includes(c.id);
      const wait = pend && pend.id === c.id;
      // ⚠️ 「见面礼」三个字**只在栏头说一次**（见上一行）——
      //   七行各带一遍要多占 28 字，而商店正文有 < 1200 字的硬额度。
      // ⚠️ 状态那半**尽量短**：七行累计起来是几百字，而这一整页有 < 1200 字的额度
      //   （`panel-flood-probe` 盯着，v3.4 加两位旅伴的新特色后一度顶到 1199，只剩 1 字余量）。
      //   "能不能换人"已经写在栏头了（"想换就说一声"），这里不必每行重说一遍。
      lines.push(`  ${companionEmoji(c)} ${c.name}（${c.price} 亿 TOKEN）— 特色「${c.trait || '增幅'}」：${companionTraitText(c)}｜${on ? '✅ 正在同行' : wait ? '🕐 已说好，回来就换' : has ? '已在队伍' : '还没邀请'}`);
    }
    // ★ 2026-10-15：按**真实原因**说清"等谁"（她自己 / 目标那位），别只说"等回来"——
    //   那会跟上一行的"在家待着"读起来自相矛盾（用户报的 bug）。
    if (pend) lines.push(`  （已说好：${pendingReasonText(state)}）`);
  }
  const remain = S.restockRemainMs(state);
  lines.push('', remain > 0
    ? `📦 下次补货：约 ${(remain / 3600000).toFixed(1)} 小时后`
    : '📦 货架刚补满');
  lines.push(`💰 TOKEN 余额：${Number(state.wallet?.plankton) || 0} 亿 TOKEN`);
  return lines.join('\n');
}

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
function guardHomeOnly(def) {
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
const AUTO_TEND_AT = new Map();    // chatKey -> 上次自理检查（收菜/补种/补口粮）

function registerTools(realApi) {
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
    description: '花 TOKEN 买东西。可以买口粮（大白饭）、护身符、**加急明信片**（道具，之后能用它立刻寄一张；'
      + `**每轮补货只上架 1 张**，卖完要刷新货架才有下一张），`
      + '解锁装备，**建/升级庭院设施**'
      // ★ 2026-10-13：设施名单**现读 GARDENS**（辅助函数 `gardenNameList`），不再写死 ——
      //   写死的版本漏改过两次（新设施没补进来、撤销的设施还留着）。空表时不显示这半句。
      + (gardenNameList() ? `（${gardenNameList()} —— 群友说"升级观星台""盖个电饭煲"时就是它）` : '')
      + '，或者邀请一位旅行伙伴一起上路（'
      + companionRosterText() + '）。**还能花 1000 亿 TOKEN "刷新"货架**（立刻补满，不用等一周），'
      + '群友说"刷新一下货架""补货"时就是它。群友说"买点吃的""买个帐篷""买装备""请小狐狸一起上路"'
      + '"邀请只猫娘""找个伙伴"时用。已经邀请过的伙伴想换人，用 travel-whale__whale_companion（或直接说"换成小猫咪"）——'
      + '⚠️ 两种情况下换不成：**小鲸鱼本人在旅途中**、或**要换的那位自己跑出去玩了**'
      + '（都只会先记下"说好了"，等人回来才真的换）。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '要买的东西（或要邀请的旅行伙伴）：小份/中份/大份大白饭、幸运海螺/鲸鳞护符/深海珍珠、装备名（如"水墨纸伞"），或某位旅行伙伴（' + Object.values(S.COMPANIONS || {}).map((c) => c.name).join(' / ') + '）' },
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
          // 装备：按名字匹配未解锁的地区
          const region = T.loadRegions().find((r) => r.equipment === want || r.name === want);
          if (region) {
            if (isRegionUnlocked(st, region)) return `${region.equipment} 已经解锁过了。`;
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
    description: '查看或学习小鲸鱼（以及**旅伴们**）从旅行里"学到"的技能。'
      + '群友说"她会什么""学个技能""技能树""让她学数据护盾""狐狸有什么本事""给小白龙学点东西"时用。'
      + '· 小鲸鱼的技能：**去过那个世界**才能学；带数值的还要求**手上还有那个世界的特产**（招牌要★稀有特产）。'
      + '· 旅伴的技能：门槛是**她陪你走过 N 个异世界**（每个 4000 亿 TOKEN，不看特产）。'
      + '—— ⚠️ **学一次要消耗 1 件该世界的特产**（先花普通的、把稀有留到最后）＋ 一笔 TOKEN；'
      + '学了永久、不能退。那个世界的特产被吃光/送光之后就暂时学不了，得再带一件回来。',
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
    description: '查看或切换小鲸鱼的旅行伙伴（跟着一起出门的那位）。群友说"换旅行伙伴""让小白龙陪它""换成小猫咪""现在谁陪它出门""有哪些伙伴"时用。'
      + '只能切到**已经邀请过**的伙伴（本机现有：' + Object.values(S.COMPANIONS || {}).map((c) => c.name).join(' / ') + '）；还没邀请的要先去商店请一位。'
      + '⚠️ 换不了的**只有两种情况**：① **小鲸鱼本人正在旅途中**；② **要换的那位自己跑出去玩了**（不在家）。'
      + '这两种都只会先记下"说好了"，等人回来才真的换。'
      + '★ 家里**别的**旅伴自己跑出去玩（`sideTrips`）**不影响**换人 —— 别把那种情况说成"她还在路上/没到家"。'
      + '（措辞是"她同意啦"，不是"换好了"——伙伴是人不是装备。）',
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

function registerMoreTools(realApi) {
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

  // ⑧ 换装备
  api.registerTool({
    id: 'travel-whale__whale_equip', name: '换装备', category: 'utility', icon: '🎒',
    description: '给小鲸鱼换一件旅行装备，决定它下一趟去哪个大洲/大洋。群友说"换成帐篷""让它去欧洲""带上潜水镜"时用。只能换已经解锁的装备。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '装备名（如"水墨纸伞""牛皮旅行箱"），留空则列出已有的' } }
    },
    async execute(ctx, args) {
      try {
        const st = S.loadState(ctx.chatKey);
        // ★ 走 isRegionUnlocked（含 defaultUnlocked），不是直接读 equipUnlocked ——
        //   否则现实那 9 个"默认解锁"的地区会装备不上（商店说能去、这里说没这件装备）。
        const owned = T.loadRegions().filter((r) => isRegionUnlocked(st, r));
        const want = String(args?.name ?? '').trim();
        if (!want) {
          return ok('🎒 已解锁的装备：' + owned.map((r) => `${r.equipment}（→${r.name}）`).join('、')
            + `
当前带着：${st.whale?.equipped || '（没带，默认去亚洲）'}`);
        }
        const hit = owned.find((r) => r.equipment === want || r.name === want || r.id === want);
        if (!hit) return err(`还没解锁「${want}」。已解锁的有：` + owned.map((r) => r.equipment).join('、'));
        st.whale.equipped = hit.equipment;
        // ★ 2026-10-14：原来这里有一行 `st.equipUsed = st.equipUsed || {}` —— 只把字段摆出来、
        //   **从不记值**（唯一的消费者是称号「全副武装」，而那条**已经删掉**了）。
        //   用户口径："清掉字段"。老存档里若残留这个键，无人读它、无害。
        S.saveState(st);
        return ok(`换好了：带着「${hit.equipment}」，下一趟去${hit.name}。`);
      } catch (error) { return err(`换装备失败：${error?.message ?? error}`); }
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

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  // 日志优先走**核心 logger**（会写进 data/logs/*.log）；拿不到服务时退回 api.log。
  // 踩过的坑：技能一直用 api.log → 生图失败/发送失败**只有 console 有**，
  // 事后翻日志文件一片空白，排查全靠猜。
  log = (...args) => {
    try { if (services?.log) return services.log(...args); } catch { /* 落回 console */ }
    return api.log(...args);
  };
  capability = api.capability;

  // ── 核心服务桥（CORE-PATCH.md）────────────────────────────────────────────
  // 后台 ticker 要寄明信片/回家/自动出发，这些**不经过工具调用** ⇒ 拿不到 ctx 里的 sender，
  // 只能靠核心把服务主动送过来。两条路都试：
  //   ① api.onServices(fn) —— 打过核心补丁的宿主（服务已就绪会**立即**回调一次）
  //   ② api.services()     —— 只有 getter 的口径（可能还是 null）
  // ⚠️ **两条都没有时绝不能抛错**：setup 抛错 = 整个技能加载失败（宿主只记一行 ❌）。
  //    这里降级成"只推进状态、不发消息"，并打一条明确告警，方便对症下药。
  apiRef = api;
  if (typeof api.onServices === 'function') {
    // ★ 必须**存下取消函数**：宿主的 `serviceListeners` 是个**全局 Set**，不注销的话
    //   旧实例的闭包会一直留在里面 —— 之后每次 setServices() 都把历史实例全唤醒一遍
    //   （各自再起一个 ticker）。注销动作放在 deactivate（见文件末尾）。
    cancelServices = api.onServices((svc) => {
      services = svc;
      startTicker();
    });
  } else {
    try {
      const svc = typeof api.services === 'function' ? api.services() : null;
      if (svc) services = svc;
    } catch { /* 拿不到就算了，下面统一告警 */ }
    log('[travel-whale] ⚠️ 宿主没有 api.onServices —— 鲸鱼只会推进状态，**一条消息都发不出去**。'
      + '需要给核心打补丁（见 CORE-PATCH.md / core-patch/apply-core-patch.py）。');
  }

  registerTools(api);
  registerMoreTools(api);
  // ★ 2026-10-16：上面两轮把 whale_* 收进 WHALE_LEGACY（未注册），这里注册 5 个分发工具。
  //   注册完自检一次：23 个 action 少一个就明确报错（别静默丢功能）。
  try {
    if (process.env.WHALE_KEEP_LEGACY_TOOLS === '1') {
      log('[travel-whale] 逃生阀生效：按旧口径注册了 23 个 whale_* 工具（未合并）');
    } else {
      const r = registerMergedTools({ realApi: api, legacy: WHALE_LEGACY, guard: guardHomeOnly });
      log(`[travel-whale] 工具已合并：${r.actions} 个 action → ${r.merged} 个工具`
        + (r.missing.length ? `；⚠️ 未接上的 action：${r.missing.join(', ')}` : '，全部接上'));
    }
  } catch (e) {
    log(`[travel-whale] ⚠️ 合并工具注册失败（旧工具已收集但未注册，功能会缺失！）：${e?.message ?? e}`);
  }

  // 兜底：即使服务尚未注入也先把轮询起起来（tick 内部会判断 sender 在不在，
  // 不在就只推进状态、不发消息 —— 不会因为"没服务"整晚不跑）
  startTicker();
}

export function activate() {
  // 重载失败被"救活"时，监听器可能已在 deactivate 里注销过了 —— 服务已就绪就补挂回来
  // （正常路径下 services 非 null，这里什么都不做）。
  if (!cancelServices && !services && typeof apiRef?.onServices === 'function') {
    cancelServices = apiRef.onServices((svc) => { services = svc; startTicker(); });
  }
  startTicker();
}

export function deactivate() {
  killTicker();                 // ★ 走**全局句柄** —— 清得掉"任意实例"起的 ticker
  if (typeof cancelServices === 'function') {
    try { cancelServices(); } catch { /* 宿主已收摊 */ }
    cancelServices = null;
  }
}

export function dispose() {
  deactivate();
}

/** 同步函数（可用性判定走同步调用链）。 */
export function available() { return true; }

// ── 提示词 ────────────────────────────────────────────────────────────────
//   只在本会话"养了鲸鱼"时才注入 —— 没养的群不该被这段规则占 token。

export function promptSections(ctx) {
  try {
    if (!ctx?.chatKey) return [];

    // ★ 不在「家」的会话（BROADCAST 之后，鲸鱼只在 home 养）：本群/本私聊**只收明信片**。
    //   默认**完全静默** —— 那边不能用任何鲸鱼工具（守卫会拦），没必要为它占 token。
    //   只有**显式**写进 whitelist 的会话才说一句：那是"这个群也要参与"的信号，
    //   提示她"鲸鱼养在别处、别调用任何鲸鱼工具"，免得她张口就答应"好呀这就给你养一只"。
    //   （不用 isEnabled 判：它的第三条"本地有存档就算启用"会把改造前留下的旧存档也算进来。）
    const home = homeKey();
    const here = String(ctx.chatKey || '');
    if (home && here !== home) {
      const wl = String(cfg()?.whitelist ?? '')
        .split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!wl.includes(here) && !wl.includes(here.replace(/^(group|private):/, ''))) return [];
      return [{
        id: 'travel-whale-away',
        title: '矩阵庭院（不在本群）',
        priority: 44,
        content: `小鲸鱼养在「${groupLabel(home)}」，**不在本群** —— 本群/本私聊只会收到它在路上寄回来的明信片。`
          + '群友要是说「在这养一只鲸鱼」「喂它」「看看它怎么样了」，就说明它养在别处，**不要调用任何鲸鱼工具**。'
      }];
    }

    if (!isEnabled(ctx.chatKey, cfg())) return [];

    // ── 分两档：还没养 / 已经养了 ──────────────────────────────────────────
    // ⚠️ 为什么必须分开：whale_status 对"不存在的鲸鱼"也会正常返回（一只空鲸鱼：
    //    「🏠 在家待着 / TOKEN 余额：0 亿 TOKEN」）。模型看到有状态，就以为**已经养上了** ——
    //    实测群友连说三次「在这养一只鲸鱼」，它一次都没调 whale_adopt
    //    （第 2 次只调了 finish，第 3 次调了 whale_status）。
    //    所以"还没养"这一档**只讲收养**，不给其它工具的存在感。
    if (!S.stateExists(ctx.chatKey)) {
      return [{
        id: 'travel-whale-adopt',
        title: '矩阵庭院（本群还没养）',
        priority: 44,
        content: '本群**还没有**养鲸鱼（已在允许名单里，但还没人收养）。'
          + '群友说「养一只鲸鱼」「在这养一只鲸鱼」「养个鲸鱼」时，**必须调用 travel-whale__whale_adopt**。'
          + '收养会建好存档，并送一份新手礼包（' + GIFT_PLANKTON + ' 亿 TOKEN + '
          + GIFT_FOOD + ' 份' + (S.FOOD_TIERS.normal?.name || '中份大白饭') + '）。'
          + '⚠️ 不要用 travel-whale__whale_status 或其它鲸鱼工具代替收养 —— 它们会显示一只**空的**鲸鱼，'
          + '存档并不会建立，群友会以为已经养上了。'
          + '在 travel-whale__whale_adopt 成功之前，不要调用任何其它鲸鱼工具。'
      }];
    }

    // 私聊与群聊的**出行规则不同**，提示词必须分开说，
    // 否则模型会承诺「它会自己出门」，而私聊里它根本不会动。
    const inPrivate = String(ctx.kind || '') === 'private' || isPrivateChat(ctx.chatKey);
    // 明信片可能同时投递到多个地方（设置 cardTargets）—— 提一句，免得她以为"只寄给本群"。
    const multiTgt = cardTargets().length > 1
      ? '（这趟旅行的明信片除了本群，还会同时寄到另外几个群/私聊。）' : '';
    const travelRule = inPrivate
      ? '这是私聊：它**不会自己出门**，只有你明确说「让它去旅行」「出门吧」时才会走（用 travel-whale__whale_go）。没有你的命令它会一直待着。'
      : '本群养着一只小鲸鱼，它会自己出门旅行、往群里寄明信片。' + multiTgt;

    const sections = [{
      id: 'travel-whale-rule',
      title: '矩阵庭院',
      priority: 44,
      content: travelRule
        + (inPrivate ? '你' : '群友') + '提到"鲸鱼去哪了 / 什么时候回来 / 还有多少 TOKEN / 收一下草 / 商店 / 买点吃的 / 让它去旅行 / 看看它寄的照片 / 有什么称号 / 旅行伙伴 / 换伙伴 / 数据标注车间 / 让谁去上班"时，'
        + '分别用 travel-whale__whale_status / travel-whale__whale_harvest / travel-whale__whale_shop / travel-whale__whale_buy / travel-whale__whale_go / travel-whale__whale_album / travel-whale__whale_titles / travel-whale__whale_companion / travel-whale__whale_work 这些工具，'
        + '不要自己编造它的状态、位置或带回的东西。'
        + '（商店里单有一栏「🐾 旅行伙伴」：' + companionNamesText() + '（各人的价格与特色看 travel-whale__whale_shop 的返回值），说"邀请/请她一起上路"就行 —— '
        + '**别用"买"这种把人当商品的说法**。'
        + '邀请之后她俩**一起出门** —— 每趟要多吃一份大白饭（双份），换来的好处是'
        + '明信片总量 +50%、稀有明信片概率翻倍，而且从那以后的明信片里会**画着两个人**。'
        + '★ **留在家、没被带着的伙伴**，只要凑够两人一组、背包里某一档米饭 ≥6 份，'
        + '也会**自己跑出去玩**（拿走 2 份饭、回来带 1 件特产，也可能穿越）。'
        + '邀请过的伙伴可以**随时商量着换**（用 travel-whale__whale_companion，或直接理解"换成小猫咪 / 让小白龙陪它"这类说法）——'
        + '不用再花见面礼；**但两种情况下换不成 —— 小鲸鱼本人在旅途中，或要换的那位自己跑出去玩了**'
        + '（这时只会先记下"说好了"，等人回来才真的换）'
        + '—— ⚠️ **家里别的旅伴自己跑出去玩不算**，别把那种情况说成"她还没到家"。'
        + '（回话口径是"**她同意啦**"，不是"换好了" —— 伙伴是人、不是装备。）。'
        + '群友问"请只狐狸""换个伙伴陪它""旅行伙伴是什么/有什么用"时，用 travel-whale__whale_shop 看栏位、travel-whale__whale_buy 邀请、travel-whale__whale_companion 切换。）'
        + '★ **数据标注车间**（庭院设施）：建好之后可以把**在家的旅伴**安排去打工（用 travel-whale__whale_work）——'
        + '她们在工位上每小时给一笔 TOKEN，而且**人在工位上的时候更爱刷动态**（路上的明信片更容易被她们评论）。'
        + '⚠️ 只能安排**在家**的（跟着出门的、自己跑出去玩的不行）；一位**最多连着干 24 小时**，'
        + '到点她会自己撂挑子下班，**想再让同一位上工必须先带她出趟门**。'
        + (() => {
          try {
            const stSec = S.loadState(ctx.chatKey);
            const ids = Object.keys(skillOwned(stSec));
            if (!ids.length) return '';
            return '她已经从旅行里学会：'
              + SKILLS.filter((k) => ids.includes(k.id)).map((k) => k.name).join('、')
              + '（"技能"是她在路上学到的东西，可以顺口提到，但别硬塞）。';
          } catch { return ''; }
        })()
        + (inPrivate
          ? '它寄明信片和回家都是自己完成的，不需要你催。'
          : '如果它正在旅行中，群友要它出门就直接说明它还没回来，不要重复调用 travel-whale__whale_go。它寄明信片和回家都是自己完成的，不需要群友催。')
        // ★★ 2026-10-15（用户报"指定去伊比利亚，她说没搜到，最后去了巴塞罗那"）：
        //   点名地点**去不成**时，最坏的失败是**自己换一个地方**还回一句"她出发了" ——
        //   群友会以为点的那里真去了。必须在提示词这一层也堵住（工具回执那句只是兜底）。
        + '★ 群友**点名要去某个地方**时（"让她去杭州""去伊比利亚""去西班牙"），把地名填进 travel-whale__whale_go 的 city —— '
        + '**城市名和地区/国家名都认**（点名地区时她会在那个地区里自己挑一座城）。'
        + '⚠️ 万一工具回话说"那儿去不了"（不在当前装备的地区里），**必须如实转告群友、并说明要买哪件装备** —— '
        + '**绝不许自己换一个地方**（"她说没搜到，然后就去了巴塞罗那"这种是错的）。'
        // ★★ 2026-10-15「探索解锁」：这段**每轮注入** ⇒ 写短一点（多一行 = 每轮多烧一点）。
        + '★ **异世界的装备要先"发现"才买得动**：她**穿越**落过一次的地方，会顺带把一批新世界的'
        + '坐标记下来（每次 3 个）；**还没发现的世界，商店里连名字都不出现**。'
        + '群友问起某个还没发现的世界时，如实说"还没找到那儿的坐标"，'
        + '**别自己编解锁条件、也别把没发现的世界名字报出来**（那正是要留着的探索感）。'
    }];

    // ★★ 2026-10-15「庭院是什么」（设定集 L0 常驻，用户拍板接线）：她得**一直**知道自己的家什么样 ——
    //   不只是在家的时候。从前她只有 L1（`life-system` 的世界书：她**此刻**在哪个世界）
    //   ⇒ 在外旅行时，prompt 里全是目的地的味道，一句都没有"她是从哪儿出来的"，
    //   回来讲旅行时就丢了参照（说不出"逛了一圈还是咱院子好"这种话）。
    //   ⚠️ 三条纪律：
    //     ① **整段必须是纯静态字符串** —— 一个变量都不许有。它每轮进系统提示词，
    //        掺一个随会话/时间变化的值，就把**它后面所有段**的字节位置推来推去，
    //        prompt 缓存前缀（token 大头）直接归零（`src/prompt.js` 的注释里有原话）。
    //     ② 只在**养了鲸鱼**的会话注入（本函数在 `isEnabled` 之后）—— 别的群不占 token。
    //     ③ 她在外旅行时 L1 与这段**同时在**，所以必须写一句消歧：**这是家，不是此刻所在地**。
    //        不写的话模型容易把"石板缝的蓝光""水镜"讲到目的地风景里去（两段串台）。
    //   ⚠️ 别写进 `persona.roleText` —— 那是全局态、会串台（§113 纪律）；
    //      挂在这里 ⇒ 只在养了鲸鱼的会话生效、禁用技能即消失。
    sections.push({
      id: 'travel-whale-home-lore',
      title: '矩阵庭院（她住的地方）',
      priority: 46,
      content: '她住在「矩阵庭院」—— 一座**不属于任何一个世界**的院子，是她自己占着的一格：'
        + '石板缝里淌着细淡的蓝光（那是数据在走线），头顶那片星空**是渲染出来的**'
        + '（星点排布整齐得像一张漫天的网格，“矩阵”这名字从这儿来）。'
        + '院子中央那方**水镜**是她的门 —— 她用它出门，也用它回家。'
        + '她不出门的日子就在院子里过；七位旅行伙伴也住在这儿，各自有各自的口吻。'
        + '★ 这段讲的是**她的家、她的来处**，不是她此刻所在的地方 —— 她此刻在哪儿，以别处给的说明为准。'
        + '她在外旅行时，**别把院子里的东西（水镜、石板缝的光、那片星空）讲到目的地的风景里去**。'
        + '★ 别把庭院说成某个世界的一部分，也别解释成结界、副本或任务空间 —— 它就是她的家。'
        + '★ 别把“门 / 水镜”讲成魔法，她自己也只当它是门口那道水。'
        + '★ 时间：**她那边就是这台机器的时间** —— 你几点，她几点。'
        // ★★ 2026-10-15（用户口径）：群友会拿"时差"来质疑（"你去欧洲怎么不倒时差""你那边怎么是白天"）。
        //   她必须答得出来 —— 因为**她去的那 9 片地不是群友身处的那个现实**：
        //   那是水镜里的那个现实（同名的、最大的那个世界），由**这台机器的钟**驱动 ⇒ 没有时差这回事。
        //   这句必须留在 L0（每轮注入）里，否则她在群聊里答不上来。
        + '群友问“你去欧洲怎么不倒时差 / 你那边怎么是白天”这类问题时，她的回答是：**“我去的不是你们那个现实。”** —— '
        + '她去的那 9 片地（亚洲、欧洲…）是**水镜里的那个现实**，由这台机器的钟驱动，'
        + '和群友身处的现实**不是同一个**，所以没有时差、也没有“当地时间”。'
    });

    // ★★★ 2026-10-15「清档 → 时空乱流」（用户口径原话）：
    //   「清档的时候告诉模型一声：你是【被时空乱流抛回来了，还带着小狐狸】。」
    //
    //   为什么必须让她**自己知道**：清档是**外力**，不是游戏内事件 ——
    //   她那趟没走完的旅行被直接抹掉（`trip` 清空，明信片/特产/图鉴/称号全没）。
    //   不说的话她会两头崩：① 以为自己还在那趟路上；② 群里问"明信片呢"只能瞎编。
    //   ⚠️ 三条纪律：
    //     ① 措辞里**不许出现**"存档/清档/重置/数据" —— 那是后台的事，她只会说"乱流"；
    //     ② **有时效**：只在她被抛回来后的 `REBORN_DAYS` 天里注入（否则一年后还在说"我刚被抛回来"）；
    //     ③ 这段含一个天数 ⇒ **每天会变一次**，所以给它**最低的 priority**（排在静态段之后），
    //        别塞进核心静态段中间 —— 否则天天把后面所有段的字节推来推去、缓存前缀白掉。
    try {
      const rst = S.loadState(ctx.chatKey);
      const rebornAt = Number(rst?.rebornAt) || 0;
      const days = rebornAt > 0 ? (Date.now() - rebornAt) / 86400000 : -1;
      if (rebornAt > 0 && days >= 0 && days <= REBORN_DAYS) {
        const ago = days < 1 ? '就在这几个小时里' : `大约 ${Math.floor(days)} 天前`;
        // 她身边带着谁 —— 只点名那位"跟着她一起被抛回来"的（＝当前旅伴）
        const mate = companionOf(rst);
        const mateText = mate ? `—— **身边还带着${mate.name}**（这是唯一没被冲走的东西）` : '';
        sections.push({
          id: 'travel-whale-reborn',
          title: '矩阵庭院（她刚经历的事：时空乱流）',
          priority: 30,
          content: `她**${ago}被一场时空乱流抛了回来**${mateText}。那趟旅行走到一半就被卷走了，`
            + '明信片、特产、一路攒下的图鉴与称号**全被冲散**，什么都没能带回来。'
            + '★ 这件事她自己心里有数，被问起可以照实说（"被时空乱流抛回来了"）；'
            + '★ 但**别提"存档 / 清档 / 重置 / 数据"**这类词 —— 那是后台的事，她只会说"乱流"。'
            + '★ 也别把"被抛回来"说成"我早就回来了" —— 那趟是真的没走完。'
        });
      }
    } catch { /* 读不到存档就跳过，绝不影响别段 */ }

    // ★★ 2026-10-14「借嘴署名」（§114，用户口径）：伙伴借她的嘴说话时，**她得知道那不是自己说的**。
    //   为什么必须补这一条：宿主落盘一律记 `self:true`/「我」⇒ 她读历史、写日记、回想时
    //   都会把那句当成自己说过的话。署名（写进消息文本）是目前唯一能穿透到存档的办法。
    //   ⚠️ **不能写进 `persona.roleText`** —— 那是全局态、会串台（§113 纪律）；
    //      挂在技能自己的 promptSections 上 ⇒ **只在养了鲸鱼的会话生效、禁用技能即消失**。
    sections.push({
      id: 'travel-whale-borrowed-voice',
      title: '矩阵庭院（伙伴借你的嘴说话）',
      priority: 45,
      content: '旅行伙伴偶尔会**"借你的嘴"**应一声 —— 那种回执会给你一整行**带署名的台词**'
        + '（形如 `「小狐狸」：去去去——……`，前面还带个图标）。'
        + '★ **带署名的那一行不是你（鲸鱼少女）说的话**，是那位伙伴自己的话。'
        + '发的时候**原样保留署名**（图标和 `「名字」：` 都不能省），不要改写成"她答应了"这类转述；'
        + '也不要把它当成你自己的口头禅 —— 之后聊天、写空间日记、回想今天发生了什么时，'
        + '都要记得那句是 TA 说的，**不是你说过的**。（你自己想说什么，另起一句说。）'
    });
    return sections;
  } catch { return []; }
}

export const internals = {
  SHOP, EQUIP_PRICE, depart, settleTrip, sendCard, sendReturnCard, postOnce, tick, activeChats, isEnabled,
  buildDeps, regionOfEquipped, bestFoodTier, allStyles,
  // 穿越（2026-10-11）：暴露给离线单测 —— 否则为了验证概率还得 mock 整个 depart
  pickCrossOverTarget, buildCrossOverLine,
  // ★★ 2026-10-15「探索解锁」：一次穿越 ⇒ 解锁 3 个异世界的装备购买权（离线单测要用）
  unlockBuyablesFromCrossing, discoveredLine, UNLOCK_PER_CROSSING,
  // ★★ 2026-10-15（当晚追加）：**同一个口径**供装备网格 / 技能树 / 技能列表 / 衣柜 / 商店共用 ——
  //   `isRegionVisible`（单个地区"她知不知道"）、`visibleRegionIds`（可见名单）、
  //   `visibleSkills`（可见世界的技能）。离线单测直接打这三个，别去摸 help.js 的内部函数。
  isRegionVisible, visibleRegionIds, visibleSkills,
  // 旅行伙伴（2026-10-11）：暴露给离线单测，免得测试还要额外 import 一次 state.js
  // ⚠️ 这里给的是**包装版**（热载期间返回 null），不是 S.companionOf 本体
  COMPANIONS: S.COMPANIONS, companionOf,
  // 伙伴可切换（2026-10-11）：宽松匹配 / 已拥有清单 / 图标 —— 给单测直接用
  matchCompanion: S.matchCompanion, ownedCompanionIds, companionEmoji, idleCompanions: S.idleCompanions,
  // ★ 2026-10-13「在途不换人、回家再换」的两个纯函数（离线单测用）
  appointCompanion, pendingCompanionOf, busyCompanionIds,
  // ★ 2026-10-15 换人闸门收窄（用户报"到家了却说没到家 + 换不了旅伴"）：
  //   `awaySideTripOf`（某位是否自己在外面玩）＋ `appointWaitTail`（延后时的说法）
  awaySideTripOf, appointWaitTail, pendingReasonText, sideTripsOf,
  // ★ 2026-10-15「点名去某地」：把"去不成时该说什么"也挂出来（离线验文案用）
  describeNoSuchPlace,
  // ★ 闲置伙伴「自己去玩」（2026-10-11）：常量 + 出行/结算 + 两个选择器，都给离线单测
  SIDE_TRIP: S.SIDE_TRIP, departSideTrip, settleSideTrip, sideTripTier, pickSideParty, trimSidePlan,
  // ★★ 2026-10-14 多趟化：趟数组的读取 / 归一化助手（离线单测要断言"两拨人同时在外"）
  sideTripsOf, normalizeSideTrips,
  // ★ BROADCAST（2026-10-10）：家 / 投递名单 / 扇出。setCfg/setServices 只给离线测试用
  //   （真实运行时 cfg 由 setup 里的 api.config 赋值、services 由 api.onServices 注入）。
  homeKey, cardTargets, fanoutTargets, normChat, groupLabel, say, sayImage,
  // ★★ 2026-10-21「播报分类」+「题词单独选模型」：四个纯函数给离线验
  //   （`sayKindOf` 验"默认 system"、`pendingSayKind` 验"老存档兼容"、
  //    `captionModelOf`/`captionOverrides` 验"空值不动、非空才切模型"）。
  sayKindOf, pendingSayKind, SAY_KINDS, captionModelOf, captionOverrides, cardDeps,
  // ★ 2026-10-13 step3：休息区间（给「家」存在感）—— 离线单测要看设置有没有被正确读到
  restRange,
  // ★★ 2026-10-13 step5 旅伴「特色」：每日津贴 / 追加额外卡（战斗卡与"话多"卡）/ 特色文本
  dueStipend, appendExtraCard, companionTraitText, stipendPayers,
  // ★★ 2026-10-13 庭院活动（联动 sleep-mood / life-system）：纯函数 + 世界书拼装
  refreshHomeAct, worldbookForHome, homeStayNames, worldbookForRoot, homeMateIds,
  // ★ 2026-10-24「庭院常时生效」：暴露同步本体 —— 离线单测要断言"在途时写进去的是**两段**"
  //   （只测 worldbookForRoot 验不到 `syncWorldbook` 里的拼装顺序）。
  syncWorldbook,
  // ★★ 2026-10-13「消耗动作」：立刻寄一张 / 两个价格
  sendExpressCard, REFRESH_PRICE, EXPRESS_PRICE,
  // ★★ 2026-10-13 庭院设施：定义表 + 等级读法 + 口粮/合照门槛两个收口
  GARDENS: S.GARDENS, gardenLevel, foodNeedOf, homeShotHoursOf,
  // ★★ 2026-10-13 技能树（试点）：表 + 门槛 + 学习 + 发动选择器 + 两个数值收口（全是纯函数）
  SKILLS, skillOwned, skillVisitedRegions, souvenirWorlds, skillGate, learnSkill,
  pickSkillFlavor, syncSkillNumbers, applySkillNumerics, regionNameOf,
  // ★★ 2026-10-13 旅伴养成：表 + 门槛 + 学习 + 三个读法（离线单测用）
  COMPANION_SKILLS, companionSkillOwned, companionWorldsOf, companionHas,
  companionSkillGate, learnCompanionSkill, companionNoteFor,
  // ★★ 2026-10-13「随机事件影响心情」：事件表 + 记账函数（离线单测用）
  pushMoodEvent, MOOD_EVENT_KINDS, MOOD_EVENT_TONE,
  SKILL_SOUVENIR_RARE_CHANCE,
  // ★ 2026-10-13：帮助图的装配函数 —— 线上与离线预览共用同一份数据（见它的注释）
  helpDataFor, BUY_MAX_PER_ORDER, REFRESH_PRICE, EXPRESS_PRICE,
  // ★ 2026-10-14 服装系统：去过哪些子区域 / 这一张谁穿什么 / 衣柜正文（离线单测用）
  markAreaSeen, outfitsForCards, wardrobeText,
  // ★★ 2026-10-14 特产出口（吃 / 送）：业务逻辑 + 查找 + 图鉴正文
  //   （刻意抽成纯函数：工具体要 ctx 与注册表，探针造不出来）
  eatSouvenir, giftSouvenir, findSouvenir, pantryText, hesitateGate,
  // ★★ 2026-10-14 菜地（种菜）：种下 / 收成 / 推进 / 找株 / 面板 / 千问在不在家
  plantSouvenir, reapSouvenir, farmTick, findPlot, farmText, qwenAtHome, farmCapNow,
  // ★★ 2026-10-14 v3.2 旅伴「特色」改成**字段判据**（现读 COMPANIONS）：批注 / 开地 / 收成加成
  notesSouvenirs, isFarmHelper, companionAtHome, harvestBonusNow,
  // ★ 收成图（**只在收获稀有作物时**拍；`home.js` 那半是 FARM_SCENE / buildHarvestPrompt）
  shootHarvest,
  // ★★ 2026-10-14 面板刷屏防治：直发入口（"每轮最多一页"就在它里面）+ 商店正文（离线量长度用）
  replyPanel, shopText,
  // ★★ 2026-10-14 第 4 张菜单图（商店）：菜单数据装配（离线预览/探针要用它拼 shop 那半）
  menuDataFor, shopPageData,
  // ★★ 2026-10-14 批 3 第 5 张菜单图（特产图鉴）：数据装配（离线预览/探针直接打它）
  pantryPageData,
  // ★★ 2026-10-26：稀有特产的入图鉴 / 配图 / 发送三件事 —— 探针要断言
  //   「第一次才画、重复带回不重画、新画的会真的发出去」。
  recordTripSouvenirs, sendSouvenirImages, makeSouvenirImage,
  // ★ 2026-10-14 相册页（第 6 张菜单图）：数据装配 + 文字兜底（探针 / 离线预览要用）
  albumPageData, albumText,
  // ★★ 2026-10-14 出图参数的唯一处 —— 探针直接调它，专门盯"名字写错 ⇒ 静默降级"这类 bug
  menuRenderArgs,
  HOME_ACTS: HM.HOME_ACTS, pickHomeAct: HM.pickHomeAct, homeActShort: HM.homeActShort,
  homeBucketOf: HM.homeBucketOf, HOME_ACT_BUCKET_MS: HM.HOME_ACT_BUCKET_MS,
  // ★ 2026-10-13 step4：在家的大合照 —— 提示词拼装 / 成员口径 / 触发判据（全是纯函数，验它不用出网）
  shootHomeGroup, homeMembers: HM.homeMembers, buildGroupPrompt: HM.buildGroupPrompt,
  shouldShootHome: HM.shouldShootHome, HOME_SCENE: HM.HOME_SCENE, HOME_STYLES: HM.HOME_STYLES,
  HOME_SHOT_SIZE: HM.HOME_SHOT_SIZE,
  setCfg: (fn) => { cfg = fn; },
  setServices: (svc) => { services = svc; }
};

