// 矩阵庭院（travel-whale）· 模块化组件：core/runtime-deps.js
// 职责：运行时句柄（RT）、全局 Ticker 锁与 LLM/图片依赖装配

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../../../src/config.js';
import { chatCompletion, resolveApiKey } from '../../../src/llm.js';
import * as S from '../state.js?v=realworld-1';
import * as T from '../trip.js';
import * as P from '../postcard.js?v=realworld-1';
import * as RW from '../lib/real-world.js';
import { searchWeb, quotaSnapshot } from '../search.js';
import { SKILLS } from './skills-appointments.js';
import { defaultBaseRegionId, defaultUnlockedIdsOfTheme, isDefaultTheme, isOtherworldRegion } from './theme-pack.js';

export const RT = {
  cfg: () => ({}),
  log: () => {},
  services: null,          // { sender, store, ... }，由 api.onServices 注入
  timer: null,             // ⚠️ 仅作兼容保留；**权威句柄在 G[TICKER_SLOT]**（见下）
  apiRef: null,            // setup 时存下来，供 activate() 补挂 onServices 监听器
  cancelServices: null,    // api.onServices 返回的取消函数（deactivate 时必须调用）
  capability: () => undefined
};
export function cfg() { return RT.cfg(); }
export function log(...args) { return RT.log(...args); }
export function capability(...args) { return RT.capability(...args); }
export function setCfg(fn) { RT.cfg = typeof fn === 'function' ? fn : () => ({}); }
export function setLog(fn) { RT.log = typeof fn === 'function' ? fn : () => {}; }
export function setServices(svc) { RT.services = svc; }
export function setCapability(fn) { RT.capability = typeof fn === 'function' ? fn : () => undefined; }
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
export const G = globalThis;
export const TICKER_SLOT = '__qqAgentTravelWhaleTicker';    // { interval, first }
export const TICK_RUNNING = '__qqAgentTravelWhaleTicking';  // true = 有 tick 在跑
/** 踢掉当前活着的 ticker（**无论它属于哪个模块实例**），并清空句柄。 */
export function killTicker() {
  const h = G[TICKER_SLOT];
  RT.timer = null;
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
export const QUICK_TEST_PLACES = [
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
export const QUICK_TEST_MS = 10 * 60 * 1000;
/**
 * 快速测试用的**独立存档键后缀**。
 *
 * 为什么不让测试往真身写：测试会走完"寄明信片 → 回家带特产 → 解锁称号"整条链路，
 * 全都会落进相册/图鉴/统计里。跑几次测试，真身的记录就被测试数据污染了。
 * 所以测试读写 `${chatKey}_test` 这份独立存档 —— 真身一个字节都不动。
 * （下划线在 safeKey 的白名单里，来回映射不会变形。）
 */
export const QUICK_TEST_KEY_SUFFIX = '_test';
/** 收养见面礼（只发一次，靠 state.giftAt 记账）。 */
export const GIFT_PLANKTON = 200;
/**
 * 归来奖励 —— **只认稀有**。
 *
 * 原来设计写的是「归来给一小笔 TOKEN」，但那等于每趟都发，出门变成净赚，
 * 口粮就不再是成本了。改成只在**撞上稀有**时才给：普通的一趟颗粒无收，
 * 撞到稀有的那趟才有惊喜 —— 这也让「冲稀有」这件事有了实际收益。
 */
export const REWARD_RARE_SOUVENIR = 50;   // 每件稀有特产
export const REWARD_RARE_CARD = 20;       // 每张稀有明信片
export const GIFT_FOOD = 1;
export const chatsDir = () => path.join(DATA_DIR, 'skills', 'travel-whale', 'chats');
export const safeKey = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
/** 所有"养了鲸鱼"的会话（有存档文件即算）。 */
export function activeChats() {
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
export function isEnabled(chatKey, settings) {
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
export function isPrivateChat(chatKey) {
  return String(chatKey || '').startsWith('private:');
}
export function senderOf(ctx) {
  const list = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const id = String(list[i]?.senderId ?? '').trim();
    if (id) return id;
  }
  return '';
}
export function allStyles() {
  const set = new Set();
  try { for (const r of T.loadRegions()) for (const s of r.styles || []) set.add(s); } catch { /* 表损坏就算了 */ }
  return set;
}
/**
 * 地区总数（称号阈值用）。
 * 表损坏就返回 0 —— titles.js 那边写的是 `ctx?.regionTotal || DEFAULT`，
 * 0 是 falsy，会自动退回兜底值，不会把称号判成"已集齐"。
 */
export function regionCount() {
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
export function fictionalRegionIds() {
  const set = new Set();
  try {
    for (const r of T.loadRegions()) if (isOtherworldRegion(r)) set.add(String(r.id));
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
export function titleCtx() {
  const gardenMax = {};
  try {
    for (const g of (S.GARDENS || [])) gardenMax[String(g.id)] = Math.max(1, Number(g.maxLevel) || 1);
  } catch { /* 表坏了就不给上限（"看得最清"会退回 5 级判定） */ }
  const baseIds = !isDefaultTheme() ? defaultUnlockedIdsOfTheme() : null;
  const polarRegion = !isDefaultTheme() ? T.loadRegions().find((r) => r.polar === true) : null;
  return {
    allStyles: allStyles(),
    regionTotal: regionCount(),
    fictionalRegions: fictionalRegionIds(),
    skillTotal: SKILLS.length,
    skillRegionOf: Object.fromEntries(SKILLS.map((k) => [String(k.id), String(k.region || '')])),
    companionTotal: Object.keys(S.COMPANIONS || {}).length,
    gardenTotal: (S.GARDENS || []).length,
    gardenMax,
    ...(baseIds && baseIds.length ? {
      primaryBaseId: defaultBaseRegionId(),
      baseContinentIds: baseIds.slice(0, 5),
      baseAllIds: baseIds,
      polarBaseId: polarRegion?.id || baseIds[baseIds.length - 1]
    } : {})
  };
}
// ── 依赖装配：把"网络/模型"注入给纯逻辑模块 ──────────────────────────────
//   子模块（trip/postcard）刻意不 import 网络与模型，全靠这里注入，
//   所以它们能脱离运行环境单测。
// capability 由 RT.capability 统一承载（setup 时赋值）
/**
 * ★ 真实照片降级（2026-10-25，参照《大世界》）：生图**真失败**后给明信片找一张
 * 目的地的真实风景照（Wikimedia 优先带署名）。返回 {path, credit} 或 null。
 * 纪律：只在真实区域（REGION_CENTER 有键）启用——家/异世界没有"真实照片"这回事；
 * 落盘进 real-photos/<chatKey>/（相册要长期引用，URL 会失效）。
 */
export function makeRealPhotoSaver(chatKey, { log: logFn } = {}) {
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
export function buildDeps(chatKey, state) {
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
export function captionModelOf() {
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
export function captionOverrides(model) {
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
export function cardDeps(d) {
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
export function charmLuck(state) {
  const id = String(state?.whale?.charm ?? '').trim();
  const def = S.CHARM_TYPES[id];
  return { luck: def ? Number(def.luck) || 0 : 0 };
}
