// 庭院与旅程（courtyard-map）—— 快照发布者 + 位置速览工具（skills/ LLM 型）。
//
// 职责：每 30 秒读一次 travel-whale 的家会话存档（mtime 没变就跳过），洗成一份
// 只给面板看的快照写进 api.storage 的 `view` 键（面板经 ../@data/storage.json 取），
// 并把最近的明信片图片复制进自己的 plugin-data/img/（@data 路由按扩展名白名单吐出）。
// 另注册 courtyard_where 工具：模型被问「她现在在哪 / 旅伴都在干嘛」时直接报快照。
//
// 纪律：
//   · 对 travel-whale **零侵入** —— 只读它的存档文件，不改它一行代码；
//   · 快照不含任何凭据；图片只认 jpg/jpeg/png/webp；
//   · storage.json 有 1MB 上限（storage.set 会抛）—— 快照预算 ≤300KB，超了截明细保骨架；
//   · 旅伴**有立绘**（2026-10-26 主人改口径；此前 10-24 是"不用立绘、面板用图标"）：
//     立绘静态图在 panel/portraits/<id>.webp（也认 png/jpg），快照只给相对路径，面板拼 /plugin-panel 前缀取。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { outfitOf } from '../../skills/travel-whale/outfits.js';
import { TITLES } from '../../skills/travel-whale/titles.js';
import { COMPANIONS } from '../../skills/travel-whale/state.js';
import { coordsForSync } from '../../skills/travel-whale/lib/real-world.js';
// ★ 2026-10-26：旅伴技能表与门槛判定直接复用 travel-whale 的导出（同一进程、同一模块实例），
//   不复制一份逻辑 —— 那边改数值这里立刻跟着变，不会出现"面板说 2 个、实际要 3 个"。
//   ⚠️ 实测踩坑：`COMPANION_SKILLS` / `companionSkillGate` 这些**不是顶层命名导出**，
//      它们挂在 `export const internals = {...}` 里。写成 `import { COMPANION_SKILLS }`
//      会在**链接期**就抛 "does not provide an export named …"，整个 courtyard-map 起不来。
//      所以只能 import `internals`，再带守卫地取字段。
import { internals as TW_INTERNALS } from '../../skills/travel-whale/index.js';

const TW_SKILLS = (() => {
  const T = TW_INTERNALS || {};
  const pick = (k, fb) => (typeof T[k] === 'function' ? T[k] : fb);
  return {
    table: Array.isArray(T.COMPANION_SKILLS) ? T.COMPANION_SKILLS : [],
    owned: pick('companionSkillOwned', () => ({})),
    worldsOf: pick('companionWorldsOf', () => []),
    gate: pick('companionSkillGate', () => ({ ok: false, reason: '' }))
  };
})();

let api = null;
let timer = null;
const log = (...a) => { try { api?.log?.(...a); } catch { /* ignore */ } };
const warn = (...a) => { try { api?.warn?.(...a); } catch { /* ignore */ } };

// ── 旅伴来历 / 性格（2026-10-26 新写）──────────────────────────────────────
//   · 放独立 JSON：改文案不用动代码，也方便主人直接编辑；
//   · 内容从 travel-whale/personas.json 的人物卡提炼（不另造人设，避免 OOC）；
//   · 缺失/写坏 → 面板少两行字，绝不拖垮快照。
const LORE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'companions-lore.json');
const LORE = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(LORE_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { return {}; }
})();
// 立绘：静态图放 panel/portraits/<id>.{webp,png,jpg}，随面板走 /plugin-panel 只读路由。
const PORTRAIT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'panel', 'portraits');
function portraitOf(id) {
  for (const ext of ['webp', 'png', 'jpg']) {
    try {
      if (fs.statSync(path.join(PORTRAIT_DIR, `${id}.${ext}`)).size > 4096) return `portraits/${id}.${ext}`;
    } catch { /* 换下一种扩展名 */ }
  }
  return '';
}

// ★ 定时器挂 globalThis 单例槽（本机惯例：热重载新实例接管旧心跳，防幽灵定时器）。
const TIMER_SLOT = '__qqAgentCourtyardMapTimer';
const TICK_MS = 30_000;

// ── 区域元数据（地图分区用；未知区域自动落"水镜之门外"兜底，不炸版）──────────
const REGION_META = {
  arctic: { name: '北冰洋', type: 'real' },
  americas: { name: '美洲', type: 'real' },
  europe: { name: '欧洲', type: 'real' },
  africa: { name: '非洲', type: 'real' },
  asia: { name: '亚洲', type: 'real' },
  pacific: { name: '太平洋', type: 'real' },
  indian: { name: '印度洋', type: 'real' },
  arknights: { name: '明日方舟', type: 'other' },
  warhammer40k: { name: '战锤40K', type: 'other' },
  nightcity: { name: '赛博朋克2077', type: 'other' }
};

// ── 世界观区域表（regions.json 单一来源：名字 / 解锁装备 / 虚实 / 解锁与可见态）──
//   unlocked = regions.json defaultUnlocked ∪ 存档 whale.equipUnlocked（与 isRegionUnlocked 同口径）
//   visible  = unlocked ∪ 存档 whale.equipBuyable（穿越预告）∪ 她去过的 region（与 isRegionVisible 同口径）
// 面板据此区分四种态：去过 / 已解锁待启程 / 可见未解锁 / 不可见（不渲染，异世界分批揭示）。
const REGIONS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'travel-whale', 'data', 'regions.json');
let regionsCache = null;
function regionsOf() {
  if (regionsCache) return regionsCache;
  const j = readJson(REGIONS_FILE);
  regionsCache = (j && Array.isArray(j.regions)) ? j.regions.filter((r) => r && r.id) : [];
  return regionsCache;
}
function worldOf(st) {
  const equipUnlocked = new Set((Array.isArray(st?.whale?.equipUnlocked) ? st.whale.equipUnlocked : []).map(String));
  const equipBuyable = new Set((Array.isArray(st?.whale?.equipBuyable) ? st.whale.equipBuyable : []).map(String));
  const visited = new Set(Object.values(st?.visitedCities && typeof st.visitedCities === 'object' ? st.visitedCities : {})
    .map((v) => String(v?.region || '')).filter(Boolean));
  if (st?.trip?.region) visited.add(String(st.trip.region));
  const map = {};
  for (const r of regionsOf()) {
    const id = String(r.id);
    const unlocked = Boolean(r.defaultUnlocked) || equipUnlocked.has(id);
    map[id] = {
      name: String(r.name || id),
      equipment: String(r.equipment || ''),
      kind: r.fictional ? 'other' : 'real',
      unlocked,
      visible: unlocked || equipBuyable.has(id) || visited.has(id)
    };
  }
  return map;
}

/** 穿着显示：解析套装真名（outfits.js 单一来源）；解析不到 / default / 空 → 默认着装。
 *  旧版直接 Object.keys(worn) 把少女 id（whale）当名字输出了 —— 2026-10-24 修。 */
function wornDisplay(worn) {
  const vals = worn && typeof worn === 'object' ? Object.values(worn) : [];
  const names = vals.map((oid) => (outfitOf(oid) || {}).name || '').filter(Boolean);
  return names.join('、') || '默认着装';
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

/** travel-whale 家会话存档路径（与 qqzone 读明信片同一约定） */
function stateFileOf() {
  const home = String(getConfig()?.skills?.['travel-whale']?.homeChatKey || '').trim();
  if (!home) return '';
  return path.join(DATA_DIR, 'skills', 'travel-whale', 'chats', `${home.replace(/[^a-z0-9_]/gi, '_')}.json`);
}

/** 从存档各处攒一份 旅伴id → 名字 的映射（解析不出就让面板显示 id，不猜） */
function nameMapOf(st) {
  const m = {};
  const put = (id, name) => {
    const k = String(id || '').trim();
    const v = String(name || '').trim();
    if (k && v && !m[k]) m[k] = v;
  };
  const t = st.trip || {};
  put(t.companion, t.companionName);
  for (const p of Array.isArray(t.party) ? t.party : []) {
    put(p?.id, p?.name || p?.companionName);
  }
  for (const e of Array.isArray(st.homeLog) ? st.homeLog.slice(-60) : []) put(e?.mateId, e?.mate);
  if (st.homeAct) put(st.homeAct.mateId, st.homeAct.mate);
  return m;
}

/** 当前生效中的伙伴自游趟（sideTrips；兼容老 sideTrip 单对象）。
 *  有时间窗的按窗判（tick 会结算过期趟，这里只兜热载窗口的脏数据）。 */
function activeSideTrips(st, now) {
  const raw = Array.isArray(st.sideTrips) ? st.sideTrips
    : (st.sideTrip && typeof st.sideTrip === 'object' && !Array.isArray(st.sideTrip) ? [st.sideTrip] : []);
  return raw
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const departAt = Number(t.departAt) || 0;
      const returnAt = Number(t.returnAt) || (departAt + (Number(t.durationMs) || 0));
      return { t, departAt, returnAt };
    })
    .filter((x) => !x.departAt || !x.returnAt || (now >= x.departAt && now <= x.returnAt + 60_000));
}

/** 旅伴状态：随行(traveling，仅在出行窗口内) / 庭院(home) / 自有行程(side，含目的地) */
function companionStatus(st, id, now, sides) {
  const t = st.trip || {};
  const away = Number(t.departAt) > 0 && Number(t.returnAt) > 0 && now >= Number(t.departAt) && now <= Number(t.returnAt);
  // st.companions / party 记的是"当前结伴选择"，只有真的在出行窗口里才等于"随行中"
  const travelingIds = new Set(away ? [
    String(t.companion || ''),
    ...(Array.isArray(t.party) ? t.party.map((p) => String(p?.id || '')) : []),
    ...(Array.isArray(st.companions) ? st.companions.map((c) => String(c?.id || '')) : [])
  ].filter(Boolean) : []);
  if (travelingIds.has(id)) return { status: 'traveling', side: null };
  for (const s of sides) {
    const partnerIds = (Array.isArray(s.t.partners) ? s.t.partners : []).map(String);
    if (partnerIds.includes(String(id))) {
      return {
        status: 'side',
        side: {
          city: String(s.t.city || ''), country: String(s.t.country || ''),
          region: String(s.t.region || ''), regionName: String(s.t.regionName || ''),
          departAt: s.departAt, returnAt: s.returnAt, partnerIds
        }
      };
    }
  }
  return { status: 'home', side: null };
}

// ── Studio 扩容（2026-10-24）：情绪/身体（sleep-mood，只读）+ 好感图谱（favor-core，只读）──
// favor 目录可能一大把档案，30 秒一次读不动 —— 用 150 秒节流缓存。
let favorCache = { at: 0, list: [] };
function readVitals() {
  const j = readJson(path.join(DATA_DIR, 'mood.json')) || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
  // ★ 2026-10-25（v2.2.1）：sleep-mood 换成「元气 + 具身情境心境」两条轴之后，
  //   `depress` / `spunk` / `neglect` 已被降级成恒 0 的兼容桩 —— 继续读它们，
  //   面板上会常驻三根永远为空的条，看起来像"她抑郁到底/毫无活力"，纯属误导。
  //   现在只暴露真实存在的量：vitality（身体轴）、fatigue（= 100 - vitality，旧字段仍同步维护）、
  //   mood / satisfaction / rage（心境投影）。
  const vit = num(j.vitality?.value
    ?? (Number.isFinite(Number(j.fatigue?.value)) ? 100 - Number(j.fatigue.value) : null));
  // ★ 2026-10-25：具身情境 Tag 是 v2 的第二条轴（最多 2 个）。
  //   光给几条数字看不出"她为什么是这个心情、还能持续多久"，所以把 tag / 原因 / 剩余分钟一起交给面板。
  const nowMs = Date.now();
  const tags = (Array.isArray(j.activeTags) ? j.activeTags : [])
    .filter((t) => t && t.tag)
    .slice(0, 2)
    .map((t) => ({
      tag: String(t.tag).slice(0, 20),
      why: String(t.why || '').slice(0, 40),
      tone: String(t.tone || ''),
      level: Math.max(0, Math.min(100, Math.round(Number(t.level) || 0))),
      leftMin: Math.max(0, Math.round(((Number(t.expiresAt) || 0) - nowMs) / 60000))
    }));
  return {
    vitality: vit,
    fatigue: num(j.fatigue?.value),
    mood: num(j.mood?.value),
    satisfaction: num(j.satisfaction?.value),
    rage: num(j.rage?.value),
    tags
  };
}
function readFavorTop(now = Date.now()) {
  if (now - favorCache.at < 150_000) return favorCache.list;
  const out = [];
  try {
    const dir = path.join(DATA_DIR, 'memory', 'people');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || out.length >= 120) continue;
        const j = readJson(path.join(dir, f));
        if (!j || !Number.isFinite(Number(j.favor))) continue;
        out.push({ name: String(j.name || f.replace(/\.json$/, '')).slice(0, 40), favor: Number(j.favor) || 0, pending: Number(j.pending?.count) || 0 });
      }
    }
    out.sort((a, b) => b.favor - a.favor);
    favorCache = { at: now, list: out.slice(0, 8) };
  } catch { /* favor-core 不在就少一块 */ }
  return favorCache.list;
}

/** 快照主体（纯函数：state + 时间 → 快照对象，方便离线测试）。
 *  opts.extras：Studio 扩容数据（情绪/疲劳/好感图谱，只读 sleep-mood 与 favor-core 的存档）。
 *  默认关闭 —— 离线测试的确定性不受这些随时变化的外部文件影响。 */
export function buildSnapshot(st, now = Date.now(), opts = {}) {
  const t = st.trip || {};
  const names = nameMapOf(st);
  const away = Number(t.departAt) > 0 && Number(t.returnAt) > 0 && now >= Number(t.departAt) && now <= Number(t.returnAt);
  const sides = activeSideTrips(st, now);
  const extras = opts.extras === true;

  // ── 她的位置 ──
  const act = st.homeAct && typeof st.homeAct === 'object' ? st.homeAct : null;
  const whale = away
    ? {
        state: 'traveling',
        place: { city: String(t.city || ''), country: String(t.country || ''), region: String(t.region || ''), regionName: String(t.regionName || '') },
        // ★ 2026-10-25 现实坐标（同步零网络：读缓存/区域中心；家与异世界 = 无此字段）
        coords: coordsForSync({ country: t.country, city: t.city, regionKey: t.region }),
        phase: t.phase && t.phase.name ? { name: String(t.phase.name), brief: String(t.phase.brief || '') } : null,
        mateIds: [String(t.companion || ''), ...(Array.isArray(t.party) ? t.party.map((p) => String(p?.id || '')) : [])].filter(Boolean),
        departAt: Number(t.departAt) || 0, returnAt: Number(t.returnAt) || 0,
        homeAct: null
      }
    : {
        state: 'home',
        place: { city: '', country: '', region: 'home', regionName: '矩阵庭院' },
        phase: null, mateIds: [],
        departAt: 0, returnAt: 0,
        homeAct: act ? { act: String(act.act || ''), detail: String(act.detail || ''), mate: String(act.mate || '') } : null
      };

  // ── 旅伴全量名册（2026-10-24 主人口径）：state.js 的 COMPANIONS 为权威
  //    （名字/emoji 严格对齐庭院本体）；解锁与否看存档 companionOwned，
  //    未解锁的以 locked 标记（面板标【未解锁】并禁入）。
  const owned = new Set([
    ...(Array.isArray(st.companionOwned) ? st.companionOwned : []).map(String),
    ...(Array.isArray(st.companions) ? st.companions : []).map((c) => String(c?.id || '')),
    ...(Array.isArray(t.party) ? t.party.map((p) => String(p?.id || '')) : []),
    String(t.companion || ''),
  ].filter(Boolean));
  const companions = Object.values(COMPANIONS && typeof COMPANIONS === 'object' ? COMPANIONS : {})
    .map((def) => {
      const id = String(def?.id || '').trim();
      if (!id) return null;
      const isOwned = owned.has(id);
      const cs = isOwned ? companionStatus(st, id, now, sides) : { status: 'locked', side: null };
      // ★ 2026-10-26 立绘档案：能力 / 技能 / 同行异世界 / 累计趟数 / 城市足迹 / 来历性格
      let worlds = [];
      let learnedMap = {};
      try { worlds = TW_SKILLS.worldsOf(st, id) || []; } catch { worlds = []; }
      try { learnedMap = TW_SKILLS.owned(st) || {}; } catch { learnedMap = {}; }
      const skills = TW_SKILLS.table
        .filter((k) => String(k?.companion || '') === id)
        .map((k) => {
          const learned = Boolean(learnedMap[k.id]);
          let gate = { ok: false, reason: '' };
          try {
            gate = TW_SKILLS.gate(st, k) || gate;
          } catch { /* 门槛算不出来就只显示未学，不炸整份快照 */ }
          return {
            id: String(k.id),
            name: String(k.name || k.id),
            emoji: String(k.emoji || ''),
            needWorlds: Number(k.needWorlds) || 2,
            price: Number(k.price) || 0,
            effect: String(k.effect || ''),
            desc: String(k.desc || ''),
            learned,
            gate: { ok: Boolean(gate?.ok), reason: String(gate?.reason || '') }
          };
        });
      const tripsFiction = Number(st?.whale?.compTrips?.[id]) || 0;
      const footMap = (st?.whale?.mateCities?.[id] && typeof st.whale.mateCities[id] === 'object')
        ? st.whale.mateCities[id] : {};
      const footprint = Object.values(footMap)
        .filter((x) => x && x.city)
        .map((x) => ({
          regionId: String(x.regionId || ''),
          city: String(x.city || ''),
          country: String(x.country || ''),
          n: Number(x.n) || 1,
          lastAt: Number(x.lastAt) || 0
        }))
        .sort((a, b) => b.lastAt - a.lastAt)
        .slice(0, 60);   // 快照预算：单人最多 60 个城市（够看，不撑爆 storage）
      const lore = LORE[id] || {};
      return {
        id,
        name: String(def?.name || id),
        emoji: String(def?.emoji || ''),
        status: cs.status,
        side: cs.side,
        locked: !isOwned,
        note: '',
        // ── 档案字段（面板「旅伴」页用）──
        trait: String(def?.trait || ''),
        desc: String(def?.desc || ''),
        mult: {
          foodCostMult: Number(def?.foodCostMult) || 1,
          cardMult: Number(def?.cardMult) || 1,
          rareMult: Number(def?.rareMult) || 1,
          dailyTokens: Number(def?.dailyTokens) || 0
        },
        portrait: portraitOf(id),
        worlds: worlds.slice(0, 40),
        worldsCount: worlds.length,
        tripsFiction,
        footprint,
        skills,
        lore: { origin: String(lore.origin || ''), persona: String(lore.persona || '') }
      };
    })
    .filter(Boolean);
  // ── 区域与城市（数据驱动：visitedCities ∪ 当前目的地）──
  const cityMap = {};
  const vc = st.visitedCities && typeof st.visitedCities === 'object' ? st.visitedCities : {};
  for (const [k, v] of Object.entries(vc)) {
    if (!v || typeof v !== 'object') continue;
    const city = String(v.city || k.split('·').slice(-1)[0] || '').trim();
    if (!city) continue;
    cityMap[`${String(v.region || '')}|${city}`] = {
      city, country: String(v.country || ''), region: String(v.region || 'other'),
      count: Number(v.count) || 1, lastAt: Number(v.lastAt) || 0, current: false
    };
  }
  if (away && t.city) {
    const key = `${t.region}|${t.city}`;
    cityMap[key] = cityMap[key] || { city: String(t.city), country: String(t.country || ''), region: String(t.region || ''), count: 0, lastAt: 0, current: false };
    cityMap[key].current = true;
  }
  // 旅伴自游趟的目的地也上地图：不冒充她的到访（count/lastAt 不动），
  // 只挂 sideIds（谁在那儿），面板据此画旅伴节点与角标
  for (const s of sides) {
    const st2 = s.t;
    if (!st2.city || !st2.region) continue;
    const key = `${String(st2.region)}|${String(st2.city)}`;
    const partnerIds = (Array.isArray(st2.partners) ? st2.partners : []).map(String);
    const entry = cityMap[key] || (cityMap[key] = {
      city: String(st2.city), country: String(st2.country || ''), region: String(st2.region || ''),
      count: 0, lastAt: 0, current: false
    });
    entry.sideIds = [...new Set([...(entry.sideIds || []), ...partnerIds])];
  }
  const byRegion = {};
  for (const c of Object.values(cityMap)) (byRegion[c.region] = byRegion[c.region] || []).push(c);
  const regions = Object.entries(byRegion).map(([key, cities]) => {
    cities.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || b.lastAt - a.lastAt);
    const meta = worldOf(st)[key] || REGION_META[key] || { name: key, type: 'other' };
    return { key, name: meta.name, type: meta.type, cities: cities.slice(0, 24) };
  }).sort((a, b) => (b.cities[0]?.current ? 1 : 0) - (a.cities[0]?.current ? 1 : 0));

  // ── 庭院 ──
  const garden = st.garden && typeof st.garden === 'object' ? st.garden : {};
  const pond = st.pond && typeof st.pond === 'object' ? st.pond : {};
  const wardrobe = st.wardrobe && typeof st.wardrobe === 'object' ? st.wardrobe : {};
  const wallet = st.wallet && typeof st.wallet === 'object' ? st.wallet : {};
  const souvenirsAll = st.souvenirs && typeof st.souvenirs === 'object' ? Object.values(st.souvenirs) : [];
  // 成就值（titles.js 单一来源：TITLES 带分值 1/3/5/10；已获得 = 存档 titles 里的 id）
  const gotTitles = st.titles && typeof st.titles === 'object' ? st.titles : {};
  let achievePoints = 0;
  let achieveTotal = 0;
  for (const ti of Array.isArray(TITLES) ? TITLES : []) {
    const p = Math.max(0, Number(ti?.points) || 0);
    achieveTotal += p;
    if (gotTitles[ti?.id]) achievePoints += p;
  }
  const courtyard = {
    garden: Object.fromEntries(Object.entries(garden).map(([k, v]) => [k, Number(v) || 0])),
    pond: { ready: Number(pond.ready) || 0, glow: Number(pond.glow) || 0 },
    farmCount: Array.isArray(st.farm) ? st.farm.length : 0,
    wallet: { plankton: Number(wallet.plankton) || 0, glow: Number(wallet.glow) || 0 },
    wardrobe: { owned: Object.keys(wardrobe.owned || {}).length, worn: wornDisplay(wardrobe.worn) },
    titles: Object.keys(st.titles || {}).length,
    achievePoints, achieveTotal,
    souvenirs: souvenirsAll.slice(0, 30).map((s) => ({
      name: String(s?.name || ''), city: String(s?.city || ''), rarity: String(s?.rarity || ''),
      kind: String(s?.kind || ''), count: Number(s?.count) || 0, eaten: Number(s?.eaten) || 0
    }))
  };

  // ── 相册（文本 + 图片相对路径；图片本体由 copyAlbumImages 落盘）──
  const albumAll = Array.isArray(st.album) ? st.album : [];
  const album = albumAll.slice(-24).map((a) => ({
    id: String(a?.id || ''),
    spot: String(a?.spot || a?.city || ''),
    city: String(a?.city || ''), country: String(a?.country || ''),
    style: String(a?.style || ''),
    thought: String(a?.thought || a?.caption || '').slice(0, 60),
    credit: String(a?.credit || ''),   // 真实照片署名（生图 = 空）
    img: ''    // copyAlbumImages 填
  })).filter((a) => a.id);

  // ── 庭院近况 ──
  const homeFeed = (Array.isArray(st.homeLog) ? st.homeLog : []).slice(-10).map((e) => ({
    at: Number(e?.at) || 0, act: String(e?.act || ''), detail: String(e?.detail || '').slice(0, 80), mate: String(e?.mate || '')
  }));

  return {
    v: 1, at: now, whale, companions, regions,
    ...(extras ? { vitals: readVitals(), favor: readFavorTop(now) } : {}),
    world: worldOf(st), courtyard, album, homeFeed
  };
}

const IMG_DIR = () => path.join(DATA_DIR, 'plugin-data', 'courtyard-map', 'img');
const IMG_EXT = /\.(jpe?g|png|webp)$/i;

/** 把最近明信片的图片复制进自己的 plugin-data/img/（存在且同大小就跳过；顺手清掉不在册的旧图） */
function copyAlbumImages(st, albumRows) {
  try {
    const dir = IMG_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    const albumAll = Array.isArray(st.album) ? st.album : [];
    for (const row of albumRows) {
      const src = albumAll.find((a) => String(a?.id || '') === row.id)?.image;
      const p = String(src || '');
      if (!p || !IMG_EXT.test(p) || !fs.existsSync(p)) continue;
      const dest = path.join(dir, `${row.id}${path.extname(p).toLowerCase()}`);
      keep.add(path.basename(dest));
      try {
        const same = fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(p).size;
        if (!same) fs.copyFileSync(p, dest);
        row.img = `img/${path.basename(dest)}`;
      } catch { /* 单张失败不影响其他 */ }
    }
    // 简单回收：img/ 里不在本批的旧图删掉（数量硬顶，防长期膨胀）
    let extra = fs.readdirSync(dir).filter((f) => !keep.has(f));
    if (extra.length > 8) for (const f of extra) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ } }
  } catch { /* 整个搬运失败只影响图片，不影响快照 */ }
}

/** 读存档 → 快照 → 落 storage（activate 与测试都会调；返回快照便于断言） */
export function publishNow() {
  const now = Date.now();
  const file = stateFileOf();
  const st = file ? readJson(file) : null;
  if (!st) {
    try {
      api?.storage?.set?.('view', { v: 1, at: now, error: file ? '读不到旅行存档（还没出过门？）' : '未配置 travel-whale.homeChatKey，画不了地图' });
    } catch { /* ignore */ }
    return null;
  }
  const snap = buildSnapshot(st, now, { extras: true });
  copyAlbumImages(st, snap.album);
  try {
    api?.storage?.set?.('view', snap);
  } catch (e) {
    // 1MB 上限兜底：砍掉明细（相册感触/近况详情）保骨架再试一次
    try {
      snap.album = snap.album.map((a) => ({ ...a, thought: '' }));
      snap.homeFeed = snap.homeFeed.map((h) => ({ ...h, detail: '' }));
      api?.storage?.set?.('view', snap);
      warn(`快照超限，已降级（去明细）：${e?.message ?? e}`);
    } catch { warn(`快照写入失败：${e?.message ?? e}`); }
    return snap;
  }
  return snap;
}

function stopLoop() {
  const prev = globalThis[TIMER_SLOT];
  if (prev) { try { clearInterval(prev); } catch { /* ignore */ } globalThis[TIMER_SLOT] = null; }
  if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
}

export function setup(a) {
  api = a;
  log('庭院与旅程已加载（快照发布者 + 位置速览；面板入口在设置里「打开庭院与旅程」）');
  // 位置速览工具：把最新快照转成几句人话给模型（只读；快照陈旧就顺手重发布一次）
  a.registerTool({
    id: 'courtyard_where',
    name: '庭院与旅程速览',
    description: '查矩阵庭院与旅程的当前状态：她此刻在哪（或在家做什么）、随行旅伴、哪位旅伴自己出门了在哪、'
      + '返程/回家时间、庭院成就值。只读、近乎零开销（读 30 秒一刷的快照，陈旧才现算）。'
      + '用户问「她现在在哪」「旅伴们都在干嘛」「庭院什么情况」一类问题时调用，照实转述即可。',
    category: 'query',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        let snap = null;
        try { snap = api?.storage?.get?.('view') || null; } catch { /* ignore */ }
        if (!snap || snap.error || Date.now() - (Number(snap.at) || 0) > 90_000) {
          try { snap = publishNow() || snap; } catch { /* ignore */ }
        }
        if (!snap || snap.error) return { content: '庭院快照还没准备好（travel-whale 未配置或还没出过门）。' };
        return { content: summarizeSnap(snap) };
      } catch (e) {
        return { content: `庭院速览失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
  // qqzone 教训：宿主重扫描后不一定再走 activate() —— setup 也把心跳拉起来（startLoop 先清旧，幂等）
  startLoop();
}

/** 快照 → 几句人话（工具输出；只转述快照，不加猜测） */
function summarizeSnap(snap) {
  const w = snap.whale || {};
  const nameOf = (id) => (snap.companions || []).filter((c) => c.id === id)[0]?.name || id;
  const lines = [];
  if (w.state === 'traveling' && w.place) {
    const mates = (w.mateIds || []).map(nameOf);
    lines.push(`她在【${w.place.country || ''}·${w.place.city}】${w.phase?.name ? '（' + w.phase.name + '）' : ''}`
      + (mates.length ? '，随行：' + mates.join('、') : ''));
    if (w.returnAt) lines.push('返程：' + fmtClockC(w.returnAt) + '（' + fmtDurC(w.returnAt - Date.now()) + '）');
  } else {
    lines.push('她在矩阵庭院' + (w.homeAct ? '：' + w.homeAct.act + (w.homeAct.mate ? '（和' + w.homeAct.mate + '）' : '') : ''));
  }
  const out = (snap.companions || []).filter((c) => c.status === 'side' && c.side && c.side.city);
  if (out.length) {
    lines.push('旅伴在外：' + out.map((c) => `${c.name}在【${c.side.country || ''}·${c.side.city}】`
      + (c.side.returnAt ? '（' + fmtDurC(c.side.returnAt - Date.now()) + '后回家）' : '')).join('、'));
  }
  const home = (snap.companions || []).filter((c) => c.status === 'home').map((c) => c.name);
  if (home.length) lines.push('在庭院：' + home.join('、'));
  const c = snap.courtyard || {};
  lines.push(`庭院：池塘可收 ${c.pond?.ready || 0} · TOKEN ${c.wallet?.plankton || 0} 亿 · 称号 ${c.titles || 0} 枚 · 成就值 ${c.achievePoints || 0}/${c.achieveTotal || 0} 分`);
  return lines.join('\n');
}

function fmtClockC(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDurC(ms) {
  if (!(ms > 0)) return '该回来了';
  const h = Math.floor(ms / 3600e3);
  if (h >= 24) return Math.round(h / 24) + ' 天';
  if (h >= 1) return h + ' 小时';
  return Math.max(1, Math.round(ms / 60e3)) + ' 分钟';
}

export function promptSections() {
  return [{
    id: 'courtyard-map-usage',
    title: '庭院与旅程速览',
    priority: 62,
    content: '主人问「她现在在哪」「旅伴都在哪/在干嘛」「庭院什么情况」时，调用 courtyard-map__courtyard_where，'
      + '把快照内容照实转述（她在哪/随行谁/哪位旅伴自己出门了/什么时候回来）。速览是只读的，随口就能调，不用攒着。'
  }];
}

export function activate() {
  startLoop();
}

function startLoop() {
  stopLoop();
  timer = setInterval(() => { try { publishNow(); } catch { /* ignore */ } }, TICK_MS);
  timer.unref?.();
  globalThis[TIMER_SLOT] = timer;
  setTimeout(() => { try { publishNow(); } catch { /* ignore */ } }, 800).unref?.();
}

export function deactivate() { stopLoop(); }
export function dispose() { stopLoop(); }
