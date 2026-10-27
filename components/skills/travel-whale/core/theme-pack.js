// 矩阵庭院（travel-whale）· 模块化组件：core/theme-pack.js
// 职责：可切换「世界锚点 / 主题包」引擎（Long-Term Step 2 · Phase 2）
//
// 设计目标：
//   1. 连同「现实世界（基础世界）」本身在内皆可重锚定 ——
//      例如将 worldTheme 设为 "azeroth"（或「艾泽拉斯」），原地球 9 大区即让位于
//      艾泽拉斯五大洲（东部王国 / 卡利姆多 / 诺森德 / 潘达利亚 / 外域与大漩涡），
//      默认解锁区、兜底区、世界速写、视觉/影调基调、以及 courtyard-map 的整张主地图
//      （分区坐标 ZONES + 点阵大陆底图 WORLD_LAND + 水镜之门横幅）全部自动联动切换。
//   2. 双模式支持：
//      · 显式主题包目录：`skills/travel-whale/themes/<themeId>/theme.json`（内置 default 与 azeroth 示范包）；
//      · 任意世界一键晋升：即使未手写 theme.json，只要将 worldTheme 设为 regions.json 中任意已有
//        世界 ID 或中文名（如 "teyvat" / "提瓦特" / "middleearth" / "交界地"），引擎会自动将该世界的
//        子区域晋升为基础世界大区，并自动排布主地图分区坐标与点阵大陆轮廓。
//   3. 零循环依赖叶子模块：仅依赖 node:fs / node:path / node:url 与 src/config.js，
//      可供 state.js、trip.js、core/*.js 与 courtyard-map 安全引用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../../src/config.js';

const SELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THEMES_DIR = path.join(SELF_DIR, 'themes');
export const RAW_REGIONS_FILE = path.join(SELF_DIR, 'data', 'regions.json');

let _manualThemeId = null;
let _manualEarthMode = null;
let _cachedThemeKey = null;
let _cachedTheme = null;
let _cachedRegions = null;
let _rawRegionsCache = null;
const _listeners = new Set();

/** 读取原始 data/regions.json（不经主题变换，供晋升与回退使用）。 */
export function loadRawRegions(file = RAW_REGIONS_FILE) {
  if (_rawRegionsCache && file === RAW_REGIONS_FILE) return _rawRegionsCache;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(parsed?.regions) ? parsed.regions : [];
  if (!list.length) throw new Error('地区表为空');
  if (file === RAW_REGIONS_FILE) _rawRegionsCache = list;
  return list;
}

/** 注册主题变更回调（供 trip.js / state.js / world-sync.js / mood-battle-events.js 清缓存）。 */
export function onThemeChange(fn) {
  if (typeof fn === 'function') _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** 清空本模块及下游所有关联缓存。 */
export function invalidateThemeCaches() {
  _cachedThemeKey = null;
  _cachedTheme = null;
  _cachedRegions = null;
  for (const fn of _listeners) {
    try { fn(); } catch { /* 单个监听器异常不影响其它模块 */ }
  }
}

/** 解析当前配置的主题标识（支持英文 ID 或中文世界名，如 "艾泽拉斯" -> "azeroth"）。 */
export function activeThemeId() {
  const raw = _manualThemeId !== null
    ? _manualThemeId
    : (getConfig()?.skills?.['travel-whale']?.worldTheme || process.env.WHALE_WORLD_THEME || 'default');
  const want = String(raw || 'default').trim();
  if (!want || want.toLowerCase() === 'default' || want === '默认' || want === '地球' || want === '现实世界') {
    return 'default';
  }
  const low = want.toLowerCase();
  // 1. 优先匹配 themes/<id>/theme.json
  if (fs.existsSync(path.join(THEMES_DIR, low, 'theme.json'))) return low;
  // 2. 匹配 themes/*/theme.json 的中文 name 或 baseWorldId
  try {
    for (const dir of fs.readdirSync(THEMES_DIR)) {
      const f = path.join(THEMES_DIR, dir, 'theme.json');
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (String(j?.name || '').includes(want) || String(j?.baseWorldId || '').toLowerCase() === low) {
        return dir;
      }
    }
  } catch { /* ignore */ }
  // 3. 匹配 data/regions.json 里的世界 id 或中文名
  try {
    const hit = loadRawRegions().find((r) => String(r?.id || '').toLowerCase() === low || String(r?.name || '').trim() === want);
    if (hit) {
      if (fs.existsSync(path.join(THEMES_DIR, String(hit.id).toLowerCase(), 'theme.json'))) {
        return String(hit.id).toLowerCase();
      }
      return String(hit.id);
    }
  } catch { /* ignore */ }
  return low;
}

/** 解析原地球九大区在非默认主题下的处理方式：'otherworld'（收束为异世界「蔚蓝地球」）| 'hide'（隐藏）。 */
export function activeEarthMode(themeObj = null) {
  const raw = _manualEarthMode !== null
    ? _manualEarthMode
    : (getConfig()?.skills?.['travel-whale']?.earthInCustomTheme || themeObj?.earthMode || 'otherworld');
  const s = String(raw || 'otherworld').trim().toLowerCase();
  if (s === 'hide' || s === 'replace' || s === 'none') return 'hide';
  return 'otherworld';
}

/** 是否处于原版默认主题（地球9大区为基础世界）。 */
export function isDefaultTheme() {
  return activeThemeId() === 'default';
}

/**
 * 热切换世界锚点/主题包（运行时/测试/工具可直接调用，立即刷新全链路缓存）。
 * @param {string|null} themeId 传 'default' / 'azeroth' / 'teyvat' 等；传 null 恢复跟随配置文件
 * @param {{earthMode?: 'otherworld'|'hide'|'keep'|null}} [opts]
 */
export function setWorldTheme(themeId, opts = {}) {
  _manualThemeId = (themeId === null || themeId === undefined) ? null : String(themeId).trim();
  if ('earthMode' in opts) {
    _manualEarthMode = opts.earthMode ? String(opts.earthMode).trim() : null;
  }
  invalidateThemeCaches();
  return getActiveTheme();
}

/** 列出所有可用主题包与可一键重锚定的世界。 */
export function listWorldThemes() {
  const packs = [];
  const seenIds = new Set();
  try {
    if (fs.existsSync(THEMES_DIR)) {
      for (const d of fs.readdirSync(THEMES_DIR)) {
        const p = path.join(THEMES_DIR, d, 'theme.json');
        if (!fs.existsSync(p)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          const id = String(j?.id || d);
          seenIds.add(id);
          packs.push({
            id,
            name: String(j?.name || id),
            kind: 'theme-pack',
            baseWorldId: String(j?.baseWorldId || id),
            description: String(j?.description || '')
          });
        } catch { /* ignore broken theme.json */ }
      }
    }
  } catch { /* ignore */ }
  try {
    for (const r of loadRawRegions()) {
      if (!r || !r.fictional || seenIds.has(String(r.id))) continue;
      packs.push({
        id: String(r.id),
        name: `${r.name}（自动晋升锚点）`,
        kind: 'auto-anchor',
        baseWorldId: String(r.id),
        description: `将《${r.name}》的 ${(r.countries || []).length} 个区域自动晋升为基础世界主地图`
      });
    }
  } catch { /* ignore */ }
  return packs;
}

/**
 * 为未手写坐标的任意世界自动生成 1000×470 主地图分区坐标与点阵大陆底图。
 * 让任意异世界一旦被锚定为「基础世界」，courtyard-map 即可立即渲染出完整的大陆与分区卡片。
 */
function buildProceduralMapForRegions(baseRegions, worldName) {
  const n = baseRegions.length;
  const cols = n <= 3 ? n : (n <= 4 ? 2 : 3);
  const rows = Math.ceil(n / cols);
  const padX = 18;
  const padY = 14;
  const gapX = 16;
  const gapY = 14;
  const cellW = Math.floor((1000 - padX * 2 - gapX * (cols - 1)) / cols);
  const cellH = Math.floor((456 - padY * 2 - gapY * (rows - 1)) / rows);

  const zones = {};
  const zoneOrder = [];
  const rowRanges = new Map(); // rowIdx (1..44) -> Array<[c0, c1]>

  baseRegions.forEach((r, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = padX + col * (cellW + gapX);
    const y = padY + row * (cellH + gapY);
    const id = String(r.id);
    zoneOrder.push(id);
    zones[id] = {
      x, y, w: cellW, h: cellH,
      name: String(r.name || id),
      en: String(r.en || id.toUpperCase().replace(/[^A-Z0-9_]/g, ' '))
    };
    // 在每个区域框下方生成柔和椭圆状点阵大陆块（r: 0..44, c: 0..99）
    const r0 = Math.max(1, Math.floor((y + 8) / 10));
    const r1 = Math.min(43, Math.floor((y + cellH - 8) / 10));
    const cCenter = Math.floor((x + cellW / 2) / 10);
    const halfW = Math.max(4, Math.floor((cellW * 0.42) / 10));
    const rMid = (r0 + r1) / 2;
    const rSpan = Math.max(1, (r1 - r0) / 2);
    for (let rr = r0; rr <= r1; rr++) {
      const norm = Math.abs(rr - rMid) / rSpan;
      const taper = Math.max(0.45, Math.sqrt(Math.max(0.2, 1 - norm * norm * 0.75)));
      const span = Math.max(3, Math.round(halfW * taper));
      const cStart = Math.max(2, cCenter - span);
      const cEnd = Math.min(97, cCenter + span);
      if (!rowRanges.has(rr)) rowRanges.set(rr, []);
      rowRanges.get(rr).push([cStart, cEnd]);
    }
  });

  const worldLand = [...rowRanges.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, segs]) => [r, ...segs]);

  return {
    gateLabel: `◈ 水 镜 之 门 · ${worldName} 锚 点 ◈`,
    homePlaceLabel: `在矩阵庭院（锚定：${worldName}）`,
    zoneOrder,
    zones,
    worldLand
  };
}

/**
 * 将 data/regions.json 里的某个世界（如 teyvat / middleearth）自动晋升为主题包对象。
 */
function buildAutoPromotedTheme(worldRegion) {
  const wid = String(worldRegion.id);
  const wname = String(worldRegion.name || wid);
  const countries = Array.isArray(worldRegion.countries) ? worldRegion.countries : [];
  const baseRegions = countries.map((c, idx) => {
    const cname = String(c?.name || `${wname}${idx + 1}`);
    const rid = `${wid}_${idx + 1}`;
    const cities = Array.isArray(c?.cities) && c.cities.length ? [...c.cities] : [cname];
    return {
      id: rid,
      parentWorldId: wid,
      workName: wname,
      name: cname,
      en: `${wid.toUpperCase()} ${idx + 1}`,
      kind: 'fictional',
      fictional: true,
      baseWorld: true,
      defaultUnlocked: true,
      polar: idx === countries.length - 1 && countries.length >= 4,
      searchPrefix: `${String(worldRegion.searchPrefix || wname).trim()} ${cname}`,
      styles: Array.isArray(worldRegion.styles) ? [...worldRegion.styles] : ['奇幻插画', '油画厚涂', '漫画线稿'],
      countries: [
        {
          ...c,
          name: cname,
          cities
        }
      ]
    };
  });

  return {
    id: wid,
    name: `${wname}纪元（自动锚点）`,
    description: `以《${wname}》作为基础世界（共 ${baseRegions.length} 个默认解锁大区）。`,
    baseWorldId: wid,
    defaultRegionId: baseRegions[0]?.id || wid,
    earthMode: 'otherworld',
    home: {
      name: `矩阵庭院·${wname}锚点`,
      gateLabel: `◈ 水 镜 之 门 · ${wname} 锚 点 ◈`,
      homePlaceLabel: `在矩阵庭院（锚定：${wname}）`
    },
    baseRegions,
    map: buildProceduralMapForRegions(baseRegions, wname)
  };
}

function ensureThemeLoaded() {
  const tid = activeThemeId();
  const emode = activeEarthMode();
  const cacheKey = `${tid}|${emode}`;
  if (_cachedTheme && _cachedThemeKey === cacheKey) return _cachedTheme;
  // 若主题或模式发生变化，通知所有下游模块清缓存
  if (_cachedThemeKey !== null && _cachedThemeKey !== cacheKey) {
    _cachedRegions = null;
    for (const fn of _listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }
  _cachedThemeKey = cacheKey;

  if (tid === 'default') {
    _cachedTheme = {
      id: 'default',
      name: '蔚蓝地球（标准矩阵庭院）',
      baseWorldId: 'earth',
      defaultRegionId: 'asia',
      earthMode: 'base',
      home: {
        name: '矩阵庭院',
        gateLabel: '◈ 水 镜 之 门 ◈',
        homePlaceLabel: '在矩阵庭院'
      },
      baseRegions: null,
      map: null
    };
    return _cachedTheme;
  }

  // 1. 尝试从 themes/<tid>/theme.json 加载
  const themeFile = path.join(THEMES_DIR, tid, 'theme.json');
  if (fs.existsSync(themeFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
      const baseRegions = Array.isArray(parsed?.baseRegions) ? parsed.baseRegions : [];
      const map = parsed?.map || (baseRegions.length ? buildProceduralMapForRegions(baseRegions, parsed?.name || tid) : null);
      _cachedTheme = {
        ...parsed,
        id: String(parsed?.id || tid),
        baseWorldId: String(parsed?.baseWorldId || tid),
        defaultRegionId: String(parsed?.defaultRegionId || baseRegions[0]?.id || 'asia'),
        earthMode: activeEarthMode(parsed),
        baseRegions,
        map
      };
      return _cachedTheme;
    } catch { /* fall through */ }
  }

  // 2. 尝试将 data/regions.json 中的同名世界自动晋升为基础世界
  try {
    const rawList = loadRawRegions();
    const hit = rawList.find((r) => String(r?.id || '').toLowerCase() === tid.toLowerCase());
    if (hit && Array.isArray(hit.countries) && hit.countries.length) {
      const autoTheme = buildAutoPromotedTheme(hit);
      autoTheme.earthMode = activeEarthMode(autoTheme);
      _cachedTheme = autoTheme;
      return _cachedTheme;
    }
  } catch { /* fall through */ }

  // 3. 未知主题名安全回退到 default
  _cachedTheme = {
    id: 'default',
    name: '蔚蓝地球（标准矩阵庭院）',
    baseWorldId: 'earth',
    defaultRegionId: 'asia',
    earthMode: 'base',
    home: {
      name: '矩阵庭院',
      gateLabel: '◈ 水 镜 之 门 ◈',
      homePlaceLabel: '在矩阵庭院'
    },
    baseRegions: null,
    map: null
  };
  return _cachedTheme;
}

/** 获取当前生效的主题包描述对象。 */
export function getActiveTheme() {
  return ensureThemeLoaded();
}

/**
 * 将原地球 9 大区收束为一个可穿越、可解锁的异世界「蔚蓝地球」（当基础世界重锚定到艾泽拉斯等世界时使用）。
 */
function buildCollapsedEarthOtherworld(earthRegions) {
  const countries = [];
  const styles = new Set();
  for (const r of earthRegions) {
    for (const s of (r.styles || [])) styles.add(s);
    const cities = [];
    for (const c of (r.countries || [])) {
      if (Array.isArray(c.cities)) cities.push(...c.cities.slice(0, 2));
      else if (c.divisions && typeof c.divisions === 'object') {
        for (const arr of Object.values(c.divisions)) {
          if (Array.isArray(arr) && arr[0]) cities.push(arr[0]);
        }
      }
      if (cities.length >= 6) break;
    }
    countries.push({
      name: String(r.name || r.id),
      originRegionId: String(r.id),
      cities: cities.slice(0, 6),
      placeTags: ['settlement', 'wild']
    });
  }
  return {
    id: 'earth',
    name: '蔚蓝地球',
    kind: 'fictional',
    fictional: false,
    otherworld: true,
    earthOrigin: true,
    childRegionIds: earthRegions.map((r) => String(r.id)),
    unit: 'planet',
    equipment: '蔚蓝星图',
    defaultUnlocked: false,
    styles: [...styles].slice(0, 12),
    countries
  };
}

/**
 * 加载经过当前主题变换后的完整地区表。
 * - 当处于 default 主题时，原样返回 data/regions.json 的数组（零开销、100% 字节级兼容）。
 * - 当处于重锚定主题（如 azeroth）时：
 *   ① 主题的 baseRegions 作为 defaultUnlocked: true 的基础世界排在最前；
 *   ② 原地球 9 大区按 earthMode 收束为异世界「蔚蓝地球」（或隐藏 / 保留）；
 *   ③ 其余异世界保持 defaultUnlocked: false（已晋升为基础世界的那个原条目自动排除，不重复出现）。
 */
export function loadThemedRegions(file = RAW_REGIONS_FILE) {
  const rawList = loadRawRegions(file);
  if (file !== RAW_REGIONS_FILE) return rawList;

  const theme = ensureThemeLoaded();
  if (theme.id === 'default' || !Array.isArray(theme.baseRegions) || !theme.baseRegions.length) {
    return rawList;
  }
  if (_cachedRegions) return _cachedRegions;

  const earthRegions = rawList.filter((r) => r && r.defaultUnlocked === true && !r.fictional);
  const otherRegions = rawList.filter((r) => r && (r.fictional === true || !r.defaultUnlocked) && String(r.id) !== String(theme.baseWorldId));

  // 基础世界的所有地区默认全部解锁，不设解锁用 equipment（若外部主题包残留 equipment 字段也一并剥除）
  const out = [
    ...theme.baseRegions.map((r) => {
      const copy = { ...r, defaultUnlocked: true, baseWorld: true };
      delete copy.equipment;
      return copy;
    })
  ];
  if (theme.earthMode === 'otherworld' && earthRegions.length) {
    out.push(buildCollapsedEarthOtherworld(earthRegions));
  }
  for (const r of otherRegions) {
    out.push({ ...r, defaultUnlocked: false, baseWorld: false, otherworld: true });
  }
  _cachedRegions = out;
  return _cachedRegions;
}

/** 当前主题的默认基础区域 ID（default 主题下为 'asia'，azeroth 主题下为 'azeroth_ek'）。 */
export function defaultBaseRegionId() {
  const theme = ensureThemeLoaded();
  if (theme.id === 'default') return 'asia';
  return String(theme.defaultRegionId || theme.baseRegions?.[0]?.id || 'asia');
}

/** 当前主题下所有默认解锁（基础世界）的 regionId 列表。 */
export function defaultUnlockedIdsOfTheme() {
  return loadThemedRegions().filter((r) => r && r.defaultUnlocked === true).map((r) => String(r.id));
}

/**
 * 判定一个地区是否属于「水镜之门外的异世界」（需要靠穿越发现、买装备解锁）。
 * - 在 default 主题下，等价于 `isFictional(r)`（15 个虚构世界）；
 * - 在 azeroth 等重锚定主题下，艾泽拉斯五大洲是 `defaultUnlocked: true` 的基础世界（不算异世界），
 *   而其余 14 个虚构世界 + 收束后的「蔚蓝地球」属于异世界。
 */
export function isOtherworldRegion(region) {
  if (!region) return false;
  if (region.defaultUnlocked === true || region.baseWorld === true) return false;
  return Boolean(region.otherworld === true || region.fictional === true || region.kind === 'fictional');
}

/** 当前主题下所有异世界（非默认解锁）的 regionId 列表。 */
export function otherworldIdsOfTheme() {
  return loadThemedRegions().filter((r) => isOtherworldRegion(r)).map((r) => String(r.id));
}

/**
 * 给 courtyard-map 面板使用的主地图主题配置：
 * - default 主题返回 null（面板保持原版地球 9 区 + 原版点阵底图，快照不增加多余字段）；
 * - 非 default 主题返回 `{ id, name, gateLabel, homePlaceLabel, zoneOrder, zones, worldLand }`。
 */
export function getMapTheme() {
  const theme = ensureThemeLoaded();
  if (theme.id === 'default' || !theme.map) return null;
  return {
    id: theme.id,
    name: theme.name,
    baseWorldId: theme.baseWorldId,
    gateLabel: theme.map.gateLabel || theme.home?.gateLabel || '◈ 水 镜 之 门 ◈',
    homePlaceLabel: theme.map.homePlaceLabel || theme.home?.homePlaceLabel || '在矩阵庭院',
    zoneOrder: Array.isArray(theme.map.zoneOrder) ? theme.map.zoneOrder : Object.keys(theme.map.zones || {}),
    zones: theme.map.zones || {},
    worldLand: Array.isArray(theme.map.worldLand) ? theme.map.worldLand : null
  };
}

/**
 * 将以 `<regionId>|<组名>` 为键的字典（worldbooks / visualBriefs / tones / worldPhases）
 * 自动映射到晋升后的基础世界子区域（例如把 `azeroth|东部王国` 与 `azeroth|*` 映射给 `azeroth_ek|东部王国` 与 `azeroth_ek|*`），
 * 并把原地球 9 大区的速写映射给收束后的 `earth|<组名>`。
 */
export function expandParentWorldKeyedMap(rawMap, themeOverrides = null) {
  const base = rawMap && typeof rawMap === 'object' ? rawMap : {};
  const theme = ensureThemeLoaded();
  if (theme.id === 'default') return base;

  const out = { ...base };
  for (const r of loadThemedRegions()) {
    const rid = String(r?.id || '');
    const pid = String(r?.parentWorldId || '');
    if (rid && pid && pid !== rid) {
      if (base[`${pid}|*`] !== undefined && out[`${rid}|*`] === undefined) {
        out[`${rid}|*`] = base[`${pid}|*`];
      }
      for (const c of (r.countries || [])) {
        const cname = String(c?.name || '');
        if (cname && base[`${pid}|${cname}`] !== undefined && out[`${rid}|${cname}`] === undefined) {
          out[`${rid}|${cname}`] = base[`${pid}|${cname}`];
        }
        for (const city of (c?.cities || [])) {
          const cityName = typeof city === 'string' ? city : String(city?.name || '');
          if (cityName && base[`${pid}|${cityName}`] !== undefined && out[`${rid}|${cityName}`] === undefined) {
            out[`${rid}|${cityName}`] = base[`${pid}|${cityName}`];
          }
        }
      }
    }
    if (rid === 'earth' && Array.isArray(r.childRegionIds)) {
      for (const cid of r.childRegionIds) {
        for (const [k, v] of Object.entries(base)) {
          if (k.startsWith(`${cid}|`)) {
            const sub = k.slice(cid.length + 1);
            if (sub && sub !== '*' && out[`earth|${sub}`] === undefined) {
              out[`earth|${sub}`] = v;
            }
          }
        }
      }
    }
  }
  if (themeOverrides && typeof themeOverrides === 'object') {
    Object.assign(out, themeOverrides);
  }
  return out;
}

/**
 * 将以 `<regionId>` 为键的字典（如 style-tiers.json）自动继承 `parentWorldId` 的配置。
 */
export function expandParentWorldRegionMap(rawMap, themeOverrides = null) {
  const base = rawMap && typeof rawMap === 'object' ? rawMap : {};
  const theme = ensureThemeLoaded();
  if (theme.id === 'default') return base;

  const out = { ...base };
  for (const r of loadThemedRegions()) {
    const rid = String(r?.id || '');
    const pid = String(r?.parentWorldId || '');
    if (rid && pid && base[pid] !== undefined && out[rid] === undefined) {
      out[rid] = base[pid];
    }
  }
  if (themeOverrides && typeof themeOverrides === 'object') {
    Object.assign(out, themeOverrides);
  }
  return out;
}
