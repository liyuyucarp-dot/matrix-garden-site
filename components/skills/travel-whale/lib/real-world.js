// 现实世界层（real-world）—— 经纬度锚点 + 真实风景照（2026-10-25，参照《大世界》取舍后引入）。
//
// ── 提供什么 ──
//   · coordsFor({country, city, regionKey})：目的地的现实经纬度。
//     Photon 地理编码（免 Key）→ 内存+文件双缓存 → 区域中心兜底（标 estimated）。
//   · photosFor(query)：真实风景照，Wikimedia Commons 优先（自带作者/许可元数据），
//     Bing 图片兜底（快、大陆网络稳，但只有来源页没有许可）。
//   · downloadPhoto(url, dir)：下载到本地（走宿主 safe-fetch 的二进制通道）。
//
// ── 纪律（本模块的红线）──
//   · 隐私：一切**对外展示**的坐标一律 3 位小数（≈100m，roundCoord）；
//     「家」（矩阵庭院 / home 会话）与异世界（fictional）**永不给坐标**——返回 null。
//   · 版权：用真实照片必须带署名（artist/license/来源页）；Bing 的注明"版权归原作者"。
//   · 超时：本模块所有网络操作都挂 withTimeout 硬超时——网络挂了返回空/兜底，
//     绝不拖住调用方（调用方是明信片投递与面板快照，都等不起）。
//     ⚠️ 注意区分：生图（image-generate）本身 30s+ 属正常耗时，**不归本模块管**，
//     本模块只在生图已经真失败之后才被调用（见 postcard.js 的降级位）。
//   · 本模块在 index.js 一侧（注入方）；postcard.js / trip.js 照旧不 import 网络。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';
import { safeFetch, safeFetchBinaryToFile } from '../../../src/safe-fetch.js';

/**
 * 宽松抓取：safeFetch 优先（SSRF 闸对正常环境是对的）；命中「域名解析到内网/本机」
 * 时降级裸 fetch —— 那是 fake-ip 代理（Clash TUN 等）的 DNS 形态，宿主自己的
 * web-search 对 Bing 用的就是裸 fetch（同机实测可通），这里保持同一模式。
 * 任何失败都抛错，由调用方接住降级（本模块不无限等网络）。
 */
async function fetchLooseText(url, timeoutMs = 10000) {
  try {
    const r = await safeFetch(url, { browseLocked: false, maxBytes: 800000, timeoutMs });
    const code = Number(r?.statusCode) || 0;
    if (code < 200 || code >= 300) throw new Error(`HTTP ${code}`);
    const body = String(r?.body || '');
    if (!body) throw new Error('空响应');
    return body;
  } catch (e) {
    if (!/内网|本机地址/.test(String(e?.message ?? e))) throw e;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}
async function fetchLooseBinaryToFile(url, dst, timeoutMs = 10000) {
  try {
    await safeFetchBinaryToFile(url, dst, 12 * 1024 * 1024, { timeoutMs, browseLocked: false });
    return dst;
  } catch (e) {
    if (!/内网|本机地址/.test(String(e?.message ?? e))) throw e;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) throw new Error('图片过大');
    fs.writeFileSync(dst, buf);
    return dst;
  }
}

/** 真实区域的中心坐标（兜底锚点；键 = regions.json 的 region id）。异世界不在表里 = 永不给坐标。 */
export const REGION_CENTER = {
  asia: { lat: 35.0, lon: 105.0 },
  europe: { lat: 50.0, lon: 15.0 },
  africa: { lat: 5.0, lon: 20.0 },
  americas: { lat: 15.0, lon: -90.0 },
  oceania: { lat: -25.0, lon: 140.0 },
  pacific: { lat: 0.0, lon: -160.0 },
  atlantic: { lat: 25.0, lon: -40.0 },
  indian: { lat: -20.0, lon: 75.0 },
  arctic: { lat: 80.0, lon: 0.0 }
};

/** 对外坐标一律 3 位小数（≈100m）——隐私纪律，展示前必过这道。 */
export const roundCoord = (v) => Math.round(Number(v) * 1000) / 1000;

/** 硬超时：超时抛错，由调用方接住降级。绝不无限等网络。 */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label || `超时（${ms}ms）`)), ms);
      timer.unref?.();
    })
  ]).finally(() => clearTimeout(timer));
}

// ── 地理编码（Photon；免 Key）────────────────────────────────────────────
const GEO_CACHE_FILE = () => path.join(DATA_DIR, 'skills', 'travel-whale', 'geo-cache.json');
const GEO_CACHE_CAP = 500;
let geoMem = null;            // { key: {lat, lon, at} }
let lastPhotonAt = 0;         // Photon 公共实例限流：1.1s 节流

function loadGeoCache() {
  if (geoMem) return geoMem;
  try {
    const j = JSON.parse(fs.readFileSync(GEO_CACHE_FILE(), 'utf8'));
    geoMem = j && typeof j === 'object' ? j : {};
  } catch { geoMem = {}; }
  return geoMem;
}
function saveGeoCache() {
  try {
    fs.mkdirSync(path.dirname(GEO_CACHE_FILE()), { recursive: true });
    const entries = Object.entries(loadGeoCache()).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, GEO_CACHE_CAP);
    const tmp = `${GEO_CACHE_FILE()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
    fs.renameSync(tmp, GEO_CACHE_FILE());
  } catch { /* 缓存写失败不影响主流程 */ }
}

async function photon(q, timeoutMs = 4000) {
  const wait = 1100 - (Date.now() - lastPhotonAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPhotonAt = Date.now();
  const body = await withTimeout(fetchLooseText(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1`, timeoutMs), timeoutMs + 1500, 'Photon 超时');
  const f = JSON.parse(body).features?.[0];
  const [lon, lat] = f?.geometry?.coordinates || [];
  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) return { lat: Number(lat), lon: Number(lon) };
  throw new Error('Photon 无结果');
}

/** 第二源 Nominatim（共享 1.1s 节流；要求 UA，限 1 req/s）。查询词保持中文原生——
 *  中文查不到就返回无果（落区域中心兜底），**不做英文猜测**（实测英文猜测会张冠李戴）。 */
async function nominatim(q, timeoutMs = 8000) {
  const wait = 1100 - (Date.now() - lastPhotonAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastPhotonAt = Date.now();
  const body = await withTimeout(fetchLooseText(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN&q=${encodeURIComponent(q)}`, timeoutMs), timeoutMs + 1500, 'Nominatim 超时');
  const r = JSON.parse(body)?.[0];
  if (r && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon))) {
    return { lat: Number(r.lat), lon: Number(r.lon) };
  }
  throw new Error('Nominatim 无结果');
}

/** 第三源：zh.wikipedia 词条坐标 —— 旅游地标的中文条目基本都有坐标，
 *  对「罗弗敦群岛」这类专名比 Nominatim 的中文检索准（实测后者查不到、前者直出 68°N）。 */
async function wikiCoords(q, timeoutMs = 8000) {
  const body = await withTimeout(fetchLooseText(`https://zh.wikipedia.org/w/api.php?action=query&prop=coordinates&colimit=1&format=json&origin=*&titles=${encodeURIComponent(q)}`, timeoutMs), timeoutMs + 1500, 'Wikipedia 超时');
  const pages = Object.values(JSON.parse(body)?.query?.pages || {});
  const c = pages?.[0]?.coordinates?.[0];
  if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) {
    return { lat: Number(c.lat), lon: Number(c.lon) };
  }
  throw new Error('Wikipedia 无坐标');
}

/**
 * 目的地的现实坐标。
 * @param {object} p { country, city, regionKey }
 * @param {object} opts { allowNetwork } —— false = 只读缓存/区域中心（面板快照等离线场景）
 * @returns {Promise<{lat:number, lon:number, estimated:boolean}|null>}
 *   null = 不给坐标（家/异世界/查不到且区域不在真实区表）——调用方跳过坐标展示。
 *   坐标已按隐私纪律取 3 位小数。
 */
export async function coordsFor({ country = '', city = '', regionKey = '' } = {}, { allowNetwork = true } = {}) {
  const key = `${String(country)}|${String(city)}`.trim();
  const cache = loadGeoCache();
  const hit = cache[key];
  if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) {
    return { lat: roundCoord(hit.lat), lon: roundCoord(hit.lon), estimated: false };
  }
  const center = REGION_CENTER[String(regionKey)];
  if (allowNetwork && city) {
    const q = [String(city), String(country)].filter(Boolean).join(', ');
    const qPure = String(city);   // wikipedia/Nominatim 用纯地名（带国名反而查偏）
    // 三源（按旅游地标配场景排序）：zh.Wikipedia（地标中文条目直出坐标，快而准）
    // → Photon（泛搜，部分网络不通，4s 短超时）→ Nominatim（query 带国名消歧——
    //   实测"北海"裸查会命中英国同名地，带国名才落广西北海）
    for (const [provider, query] of [[wikiCoords, qPure], [photon, q], [nominatim, q]]) {
      try {
        const got = await provider(query);
        cache[key] = { ...got, at: Date.now() };
        saveGeoCache();
        return { lat: roundCoord(got.lat), lon: roundCoord(got.lon), estimated: false };
      } catch { /* 换下一个源 */ }
    }
  }
  if (center) return { lat: roundCoord(center.lat), lon: roundCoord(center.lon), estimated: true };
  return null;   // 家 / 异世界 / 未知区域：不给坐标
}

/**
 * 同步版（零网络）：只读缓存 → 区域中心 → null。
 * 给"绝不能联网"的调用方（courtyard-map 的 30 秒快照发布者）用；
 * 缓存由明信片投递链路（coordsFor allowNetwork:true）顺手填充。
 */
export function coordsForSync({ country = '', city = '', regionKey = '' } = {}) {
  const key = `${String(country)}|${String(city)}`.trim();
  const hit = loadGeoCache()[key];
  if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) {
    return { lat: roundCoord(hit.lat), lon: roundCoord(hit.lon), estimated: false };
  }
  const center = REGION_CENTER[String(regionKey)];
  if (center) return { lat: roundCoord(center.lat), lon: roundCoord(center.lon), estimated: true };
  return null;
}

// ── 真实风景照（Wikimedia 优先，Bing 兜底）──────────────────────────────
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const photoOk = (url) => typeof url === 'string' && /^https?:\/\//i.test(url)
  && (/\.(jpe?g|png|webp)(\?|$)/i.test(url) || /(^|\.)bing\.net\//i.test(url) || /upload\.wikimedia\.org\//i.test(url));

async function fetchJson(url, timeoutMs = 10000) {
  const body = await withTimeout(fetchLooseText(url, timeoutMs), timeoutMs + 1500, '照片源超时');
  return JSON.parse(body);
}

async function wikimediaPhotos(query, count) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=${count * 2}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1280&format=json&origin=*`;
  const data = await fetchJson(url);
  const pages = Object.values(data?.query?.pages || {});
  const out = [];
  for (const p of pages) {
    const ii = p?.imageinfo?.[0];
    const src = ii?.thumburl || ii?.url;
    if (!photoOk(src)) continue;
    out.push({
      url: src,
      title: String(p.title || '').replace(/^File:/, '') || query,
      page: ii?.descriptionurl || '',
      artist: stripHtml(ii?.extmetadata?.Artist?.value || ''),
      license: stripHtml(ii?.extmetadata?.LicenseShortName?.value || ''),
      source: 'wikimedia'
    });
    if (out.length >= count) break;
  }
  return out;
}

async function bingPhotos(query, count) {
  const html = await withTimeout(fetchLooseText(`https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`, 10000), 11500, 'Bing 超时');
  const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = [];
  const seen = new Set();
  const re = /&quot;murl&quot;:&quot;(.*?)&quot;/g;
  let m;
  while ((m = re.exec(html)) && out.length < count) {
    const url = decode(m[1]);
    if (!photoOk(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: query, page: '', artist: '', license: '', source: 'bing' });
  }
  return out;
}

/**
 * 找真实风景照。Wikimedia 优先（许可清晰）；失败/无果再 Bing（快，但无许可元数据）。
 * 任何失败都返回 []（不抛）——调用方拿空数组就放弃降级，不影响明信片照发。
 */
export async function photosFor(query, { count = 2, timeoutMs = 12000 } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const r = await withTimeout(wikimediaPhotos(q, Math.max(1, Math.min(3, count))), timeoutMs, 'Wikimedia 总超时');
    if (r.length) return r;
  } catch { /* 换 Bing */ }
  try {
    return await withTimeout(bingPhotos(q, Math.max(1, Math.min(3, count))), timeoutMs, 'Bing 总超时');
  } catch { return []; }
}

/** 下载照片到本地（明信片相册要长期引用，URL 会失效）。失败抛错，由调用方放弃这张。 */
export async function downloadPhoto(url, dir, baseName) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = (/\.(jpe?g)(\?|$)/i.test(url) ? '.jpg' : /\.(png)(\?|$)/i.test(url) ? '.png' : /\.(webp)(\?|$)/i.test(url) ? '.webp' : '.jpg');
  const dst = path.join(dir, `${baseName}${ext}`);
  await withTimeout(fetchLooseBinaryToFile(url, dst, 10000), 11500, '下载照片超时');
  return dst;
}

/** 署名行（版权纪律：用真实照片必带）。 */
export function creditOf(photo) {
  if (!photo) return '';
  if (photo.source === 'wikimedia') {
    const who = photo.artist || '佚名';
    const lic = photo.license ? `（${photo.license}）` : '';
    return `图源：Wikimedia Commons · ${who}${lic}`;
  }
  return '图源：Bing 图片（版权归原作者，仅作分享）';
}
