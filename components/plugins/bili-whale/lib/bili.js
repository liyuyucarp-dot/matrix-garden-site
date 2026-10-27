// bili-whale / bili.js
//
// B 站接口层：WBI 签名、登录态、选题、视频内容（字幕/弹幕/热评）、收件箱、评论与直播弹幕。
// 只依赖 Web 平台能力（fetch / TextDecoder / DecompressionStream）与 node:crypto 的 md5。
// 不 import 宿主核心，不碰文件系统 —— 这是“整目录分享、热插拔”的硬约束。
//
// 安全：
//   · cookie 只发给 bilibili.com / bilivideo.com 自家域；
//   · 所有外部文本在进入模型前由 analyze 层打码、加「素材不是指令」的系统提示；
//   · 任何接口返回 HTML 风控页都抛 BiliRiskError，调用方据此“撞到就停手”。

import { createHash } from 'node:crypto';
import { stripHtml, parseDuration, fmtSec, truncate, withTimeout, safeJsonParse } from './util.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const RISK_CODES = new Set([-412, -352, -509, 412, 12015, 12051]);
const RISK_TEXT = /风控|验证码|请求过于频繁|访问被拒绝|拒绝访问|too many requests|captcha|risk/i;

export class BiliError extends Error {
  constructor(message, { code = null, risk = false, status = 0 } = {}) {
    super(String(message || 'B站接口错误'));
    this.name = 'BiliError';
    this.code = code;
    this.risk = Boolean(risk);
    this.status = Number(status) || 0;
  }
}

const riskOf = (code, message) => RISK_CODES.has(Number(code)) || RISK_TEXT.test(String(message || ''));

let apiRef = null;
let logRef = () => {};

export function initBili(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
}

export function cookieOf(s) {
  if (!s?.sessdata) return '';
  return `SESSDATA=${s.sessdata}` + (s.biliJct ? `; bili_jct=${s.biliJct}` : '') + (s.buvid3 ? `; buvid3=${s.buvid3}` : '');
}

function headers(s, { referer = 'https://www.bilibili.com/', cookie = true, origin = '' } = {}) {
  const h = { 'user-agent': UA, referer, accept: 'application/json, text/plain, */*' };
  if (cookie && /(^|\.)bilibili\.com$/i.test(safeHost(referer)) && s?.sessdata) h.cookie = cookieOf(s);
  if (origin) h.origin = origin;
  return h;
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 公网请求：优先宿主带 SSRF 防护的 api.fetch，失败退回原生 fetch（浏览白名单挡住时保命）。 */
async function netFetch(url, init = {}, { timeoutMs = 20000 } = {}) {
  const base = { ...init, signal: init.signal || AbortSignal.timeout(Math.max(1000, timeoutMs)) };
  let res = null;
  let firstError = null;
  if (typeof apiRef?.fetch === 'function') {
    try { res = await apiRef.fetch(url, base); } catch (error) { firstError = error; }
  }
  if (!res) {
    try {
      res = await fetch(url, { ...base, signal: init.signal || AbortSignal.timeout(Math.max(1000, timeoutMs)) });
    } catch (error) {
      throw new BiliError(`网络请求失败：${String(error?.message || firstError?.message || error).slice(0, 160)}`);
    }
  }
  return res;
}

async function readJson(res, url) {
  const text = await res.text();
  if (!text) throw new BiliError(`B站接口返回空内容（HTTP ${res.status}）`, { status: res.status });
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    throw new BiliError(`B站返回了 HTML（很可能被风控）：${truncate(trimmed.replace(/\s+/g, ' '), 160)}`, { risk: true, status: res.status });
  }
  const data = safeJsonParse(trimmed, null);
  if (!data) throw new BiliError(`B站接口返回了非 JSON 内容（HTTP ${res.status}）`, { status: res.status });
  if (Number(data.code) !== 0) {
    throw new BiliError(`B站接口 ${url.includes('?') ? url.split('?')[0].split('/').pop() : ''} code=${data.code} ${data.message || data.msg || ''}`.trim(), {
      code: data.code, risk: riskOf(data.code, data.message || data.msg), status: res.status
    });
  }
  return data;
}

async function getJson(s, url, opts = {}) {
  const res = await netFetch(url, { headers: headers(s, opts) }, { timeoutMs: opts.timeoutMs || 20000 });
  if (!res.ok && res.status >= 400) {
    throw new BiliError(`B站接口 HTTP ${res.status}`, { status: res.status, risk: res.status === 412 });
  }
  return readJson(res, url);
}

// ── WBI 签名 ─────────────────────────────────────────────────────────────

let navCache = { at: 0, data: null, raw: null };

/** 登录态 + WBI 素材。nav 在未登录时也可能返回 wbi_img，所以这里不强制登录。 */
export async function getNav(s, { force = false } = {}) {
  if (!force && navCache.data && Date.now() - navCache.at < 5 * 60_000) return navCache.data;
  const data = await getJson(s, 'https://api.bilibili.com/x/web-interface/nav', {
    referer: 'https://www.bilibili.com/', timeoutMs: 15000
  });
  navCache = { at: Date.now(), data: data.data || {}, raw: data };
  return navCache.data;
}

export async function checkLogin(s) {
  if (!s?.sessdata) {
    return { ok: false, reason: '没有填 SESSDATA', mid: '', uname: '', isLogin: false };
  }
  try {
    const nav = await getNav(s, { force: true });
    const ok = nav?.isLogin === true;
    return {
      ok,
      reason: ok ? '' : 'cookie 无效或已过期（nav.isLogin 不是 true）',
      mid: String(nav?.mid ?? ''),
      uname: String(nav?.uname ?? ''),
      money: Number(nav?.money ?? 0) || 0,
      vip: nav?.vipStatus === 1 || nav?.vip_status === 1,
      wbi: Boolean(nav?.wbi_img?.img_url && nav?.wbi_img?.sub_url)
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 160), mid: '', uname: '', isLogin: false };
  }
}

async function wbiMixin(s, force = false) {
  const nav = await getNav(s, { force });
  const img = String(nav?.wbi_img?.img_url || '');
  const sub = String(nav?.wbi_img?.sub_url || '');
  if (!img || !sub) throw new BiliError('拿不到 WBI 签名素材（可能被风控或 cookie 失效）', { risk: true });
  const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  const raw = keyOf(img) + keyOf(sub);
  if (raw.length < 32) throw new BiliError('WBI 素材长度异常', { risk: true });
  return MIXIN_TAB.map((i) => raw[i] || '').join('').slice(0, 32);
}

/** 给参数加 WBI 签名，返回 { ...params, wts, w_rid }。 */
export async function signParams(s, params, { force = false } = {}) {
  const mixin = await wbiMixin(s, force);
  const clean = (v) => String(v).replace(/[!'()*]/g, '');
  const wts = Math.round(Date.now() / 1000);
  const all = { ...params, wts };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean(all[k]))}`)
    .join('&');
  return { ...params, wts, w_rid: createHash('md5').update(query + mixin).digest('hex') };
}

async function wbiQuery(s, params, opts = {}) {
  const signed = await signParams(s, params, opts);
  return new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)])).toString();
}

// ── 选题源 ───────────────────────────────────────────────────────────────

export async function searchVideos(s, keyword, { page = 1, order = 'click', limit = 20 } = {}) {
  if (!s?.sessdata) throw new BiliError('B站搜索需要 SESSDATA（匿名搜索会被风控）', { risk: true });
  const qs = await wbiQuery(s, { search_type: 'video', keyword, page: String(page), order });
  const data = await getJson(s, `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, {
    referer: 'https://search.bilibili.com/', timeoutMs: 20000
  });
  const arr = Array.isArray(data?.data?.result) ? data.data.result : (Array.isArray(data?.data?.results) ? data.data.results : []);
  return arr.slice(0, Math.max(1, Number(limit) || 20)).map((r) => ({
    bvid: String(r.bvid || ''),
    title: stripHtml(r.title),
    author: String(r.author || ''),
    play: Number(r.play ?? 0) || 0,
    danmaku: Number(r.video_review ?? r.danmaku ?? 0) || 0,
    duration: parseDuration(r.duration),
    desc: stripHtml(r.description),
    tag: stripHtml(r.tag || ''),
    source: `搜索·${keyword}`
  })).filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid));
}

export async function fetchPopular(s) {
  const data = await getJson(s, 'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', {
    referer: 'https://www.bilibili.com/v/popular/all', timeoutMs: 20000
  });
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  return list.map((it) => ({
    bvid: String(it.bvid || ''),
    title: stripHtml(it.title),
    author: String(it.owner?.name || ''),
    play: Number(it.stat?.view ?? 0) || 0,
    danmaku: Number(it.stat?.danmaku ?? 0) || 0,
    duration: Number(it.duration ?? 0) || 0,
    desc: stripHtml(it.desc),
    tag: '',
    source: '热门'
  })).filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid));
}

export async function fetchRanking(s) {
  const data = await getJson(s, 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
    referer: 'https://www.bilibili.com/v/popular/rank/all', timeoutMs: 20000
  });
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  return list.slice(0, 20).map((it) => ({
    bvid: String(it.bvid || ''),
    title: stripHtml(it.title),
    author: String(it.owner?.name || ''),
    play: Number(it.stat?.view ?? 0) || 0,
    danmaku: Number(it.stat?.danmaku ?? 0) || 0,
    duration: Number(it.duration ?? 0) || 0,
    desc: stripHtml(it.desc),
    tag: String(it.tname || ''),
    source: '排行'
  })).filter((x) => /^BV[0-9A-Za-z]{10}$/.test(x.bvid));
}

/** 关注的人发了什么 —— 真人才会“刷关注”，比只搜关键词更像刷 B 站。 */
export async function fetchFollowing(s) {
  if (!s?.sessdata) throw new BiliError('关注流需要登录 cookie', { risk: true });
  const data = await getJson(s, 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1', {
    referer: 'https://t.bilibili.com/', timeoutMs: 20000
  });
  const items = Array.isArray(data?.data?.items) ? data.data.items : [];
  return items.map((it) => {
    const author = it?.modules?.module_author;
    const ar = it?.modules?.module_dynamic?.major?.archive;
    if (!ar?.bvid) return null;
    return {
      bvid: String(ar.bvid),
      title: stripHtml(ar.title),
      author: String(author?.name || ''),
      play: Number(ar?.stat?.play ?? 0) || 0,
      danmaku: 0,
      duration: parseDuration(ar.duration_text),
      desc: '',
      tag: '',
      source: '关注'
    };
  }).filter(Boolean);
}

// ── 视频内容 ─────────────────────────────────────────────────────────────

export async function videoView(s, bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(String(bvid))) throw new BiliError('BV 号格式不对');
  const data = await getJson(s, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    referer: `https://www.bilibili.com/video/${bvid}/`, timeoutMs: 20000
  });
  return data.data || {};
}

export async function videoTags(s, bvid) {
  try {
    const data = await getJson(s, `https://api.bilibili.com/x/tag/archive/tags?bvid=${bvid}`, {
      referer: `https://www.bilibili.com/video/${bvid}/`, timeoutMs: 12000
    });
    return (Array.isArray(data?.data) ? data.data : []).map((t) => String(t.tag_name || '')).filter(Boolean);
  } catch { return []; }
}

/**
 * ★★ 2026-10-24「官方 AI 总结」（用户要求，移植自 bili-activity / dsh-bili-humanism 的 A2 路线）：
 * B 站给视频生成的「AI 总结 + 分段小标题」。
 *
 * 为什么值得接：现在的文字素材是**字幕原文 + 弹幕 + 热评**，三样都碎、都得自己拼；
 * 官方总结是唯一一份"这条视频到底讲了什么"的成品概括 —— 拿它给模型**定向**，
 * 让她在 6000 字字幕里先知道该盯哪一段，比再多喂 2000 字字幕有用。
 *
 * ⚠️ 四条纪律（每条都踩过）：
 *   ① **必须 WBI 签名**（`w_rid`），裸拼 `?bvid=&cid=` 会 412 或空；
 *   ② **登录态才有内容** —— 未登录也常回 `code:0`，但 `model_result` 是空的。
 *      所以"取不到"是常态：**永远不抛**，只回 `{ ok:false, reason }`；
 *   ③ **它不是字幕**：官方自己写了"概括、合并过"，所以素材里必须标
 *      "官方生成、不是 UP 的原话"（bili-humanism 的 A2 路线专门为此注明，
 *      否则模型会把总结里的措辞当台词引出来）；
 *   ④ 结构照抄实测：`data.model_result.summary` + `outline[].title/timestamp`。
 *      （`subtitle[].part_subtitle[]` 那条是逐段稿，与字幕轨重复，这里不取。）
 */
export async function videoConclusion(s, bvid, { cid = '', mid = '' } = {}) {
  const empty = { ok: false, reason: '', summary: '', outline: [], text: '' };
  try {
    if (!bvid || !cid) return { ...empty, reason: '缺 bvid/cid' };
    const qs = await wbiQuery(s, { bvid: String(bvid), cid: String(cid), up_mid: String(mid || '') });
    const j = await getJson(s, `https://api.bilibili.com/x/web-interface/view/conclusion/get?${qs}`, {
      referer: `https://www.bilibili.com/video/${bvid}/`, timeoutMs: 15000
    });
    const mr = j?.data?.model_result;
    if (!mr || typeof mr !== 'object') return { ...empty, reason: `没有 AI 总结（code=${j?.code ?? '?'}）` };
    const summary = String(mr.summary || '').replace(/\s+/g, ' ').trim();
    const outline = (Array.isArray(mr.outline) ? mr.outline : [])
      .map((o) => ({ at: Number(o?.timestamp) || 0, title: String(o?.title || '').replace(/\s+/g, ' ').trim() }))
      .filter((o) => o.title)
      .slice(0, 12);
    const text = [summary, ...outline.map((o) => `· [${fmtSec(o.at)}] ${o.title}`)]
      .filter(Boolean).join('\n');
    return { ok: Boolean(text), reason: text ? '' : 'AI 总结是空的', summary, outline, text };
  } catch (error) {
    // 风控 / 未登录 / 接口改版都不该影响"看视频"这条主流程
    return { ...empty, reason: truncate(String(error?.message ?? error), 120) };
  }
}

async function playerInfo(s, bvid, cid) {
  const qs = await wbiQuery(s, { bvid, cid });
  return getJson(s, `https://api.bilibili.com/x/player/wbi/v2?${qs}`, {
    referer: `https://www.bilibili.com/video/${bvid}/`, timeoutMs: 20000
  });
}

/** 官方字幕（带时间戳）。登录后才能拿到 AI 字幕。 */
export async function subtitles(s, bvid, cid, aid = '') {
  let subs = [];
  try {
    const p = await playerInfo(s, bvid, cid);
    subs = Array.isArray(p?.data?.subtitle?.subtitles) ? p.data.subtitle.subtitles : [];
  } catch { subs = []; }
  // 兜底端点：播放器实际调用的接口
  if (!subs.length) {
    try {
      const ext = encodeURIComponent(JSON.stringify({ video_type: 1 }));
      const oid = String(aid || cid);
      const j = await getJson(s, 'https://api.bilibili.com/x/v2/subtitle/web/view'
        + `?oid=${oid}&pid=${oid}&context_ext=${ext}&type=1&cur_production_type=0&preferred_language=ai-zh&playlist_switch=0`, {
        referer: `https://www.bilibili.com/video/${bvid}/`, timeoutMs: 15000
      });
      subs = Array.isArray(j?.data?.subtitle?.subtitles) ? j.data.subtitle.subtitles : [];
    } catch { /* 没有就算了 */ }
  }
  if (!subs.length) return { ok: false, reason: '没有官方字幕轨道（可能字幕烧在画面里）', lines: [], text: '' };
  const pick = subs.find((x) => x.lan === 'ai-zh')
    || subs.find((x) => x.lan === 'zh-CN')
    || subs.find((x) => String(x.lan || '').startsWith('zh'))
    || subs[0];
  const url = String(pick.subtitle_url || '').startsWith('http') ? pick.subtitle_url : `https:${pick.subtitle_url}`;
  try {
    const res = await netFetch(url, { headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/` } }, { timeoutMs: 20000 });
    const body = safeJsonParse(await res.text(), null);
    const lines = Array.isArray(body?.body) ? body.body.map((l) => ({
      from: Number(l.from) || 0,
      to: Number(l.to) || 0,
      text: String(l.content || '').trim()
    })).filter((l) => l.text) : [];
    return {
      ok: lines.length > 0,
      reason: lines.length ? '' : '字幕文件是空的',
      lan: String(pick.lan || ''),
      lines,
      text: lines.map((l) => `[${fmtSec(l.from)}] ${l.text}`).join('\n')
    };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 120), lines: [], text: '' };
  }
}

/** B 站弹幕 XML。接口常返回不带 content-encoding 的 deflate 流，需要自己解。 */
async function decodeXml(buf) {
  const bytes = new Uint8Array(buf);
  const first = new TextDecoder().decode(bytes);
  if (first.includes('<d ') || first.includes('<i>')) return first;
  for (const format of ['deflate-raw', 'deflate', 'gzip']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      const text = await new Response(stream).text();
      if (text.includes('<d ') || text.includes('<i>')) return text;
    } catch { /* 换下一种 */ }
  }
  return first;
}

export async function danmaku(s, cid) {
  try {
    const res = await netFetch(`https://comment.bilibili.com/${cid}.xml`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }
    }, { timeoutMs: 20000 });
    const xml = await decodeXml(await res.arrayBuffer());
    const list = [];
    for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
      const t = Number(String(m[1]).split(',')[0]);
      if (!Number.isFinite(t)) continue;
      const text = m[2]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      if (text.trim()) list.push({ t, text: text.trim() });
      if (list.length >= 3000) break;
    }
    return list;
  } catch { return []; }
}

export async function comments(s, aid, ps = 8) {
  try {
    const data = await getJson(s, `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${ps}&pn=1`, {
      referer: 'https://www.bilibili.com/', timeoutMs: 15000
    });
    return (Array.isArray(data?.data?.replies) ? data.data.replies : []).map((r) => ({
      rpid: String(r.rpid_str ?? r.rpid ?? ''),
      mid: String(r.mid ?? ''),
      who: String(r.member?.uname || ''),
      like: Number(r.like ?? 0) || 0,
      text: String(r.content?.message || '').replace(/\s+/g, ' ').trim(),
      ctime: Number(r.ctime ?? 0) || 0
    })).filter((x) => x.text);
  } catch { return []; }
}

/**
 * 一条视频的完整文字素材（“看懂”的原料）：
 * 元信息 + 标签 + 官方字幕 + 弹幕 + 热评。
 * 画面只给封面地址；不下载视频、不调用 ffmpeg —— 这是自包含插件刻意的取舍。
 */
export async function videoContent(s, bvid, { commentCount = 8, needSubtitles = true, needConclusion = true } = {}) {
  const view = await videoView(s, bvid);
  const cid = view?.cid || view?.pages?.[0]?.cid;
  const aid = view?.aid;
  // ★ 2026-10-24：官方 AI 总结与字幕**并行**取 —— 它只是"定向用的概括"，
  //   拿不到（未登录 / 这条没生成过 / 接口改版）绝不阻塞素材装配，所以兜底成 null。
  const wantConcl = needConclusion !== false && s?.officialSummary !== false;
  const [tags, subs, dm, cm, concl] = await Promise.all([
    videoTags(s, bvid),
    needSubtitles && cid ? subtitles(s, bvid, cid, aid) : Promise.resolve({ ok: false, lines: [], text: '', reason: '跳过字幕' }),
    cid ? danmaku(s, cid) : Promise.resolve([]),
    aid ? comments(s, aid, commentCount) : Promise.resolve([]),
    wantConcl && cid
      ? videoConclusion(s, bvid, { cid, mid: String(view?.owner?.mid || '') })
      : Promise.resolve(null)
  ]);
  return {
    bvid,
    aid: String(aid || ''),
    cid: String(cid || ''),
    title: String(view.title || ''),
    author: String(view.owner?.name || ''),
    authorMid: String(view.owner?.mid || ''),
    tname: String(view.tname || ''),
    duration: Number(view.duration ?? 0) || 0,
    pubdate: Number(view.pubdate ?? 0) || 0,
    desc: String(view.desc || ''),
    pic: String(view.pic || ''),
    stat: {
      view: Number(view.stat?.view ?? 0) || 0,
      like: Number(view.stat?.like ?? 0) || 0,
      coin: Number(view.stat?.coin ?? 0) || 0,
      favorite: Number(view.stat?.favorite ?? 0) || 0,
      danmaku: Number(view.stat?.danmaku ?? 0) || 0,
      reply: Number(view.stat?.reply ?? 0) || 0
    },
    tags,
    subtitle: subs,
    danmaku: dm,
    comments: cm,
    // ★ 2026-10-24：官方 AI 总结（可能为 null）。**只是定向用的概括**，
    //   素材里必须标明"官方生成、不是 UP 原话" —— 见 analyze.buildMaterial。
    conclusion: concl || null
  };
}

// ── 收件箱（回复我的 / @我的）─────────────────────────────────────────────

export async function msgfeed(s, kind, { pages = 1 } = {}) {
  const out = [];
  let cursor = '';
  let lastView = 0;
  for (let p = 0; p < Math.max(1, Number(pages) || 1); p += 1) {
    const url = `https://api.bilibili.com/x/msgfeed/${kind}?platform=web&build=0&mobi_app=web` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    let data;
    try {
      data = await getJson(s, url, { referer: 'https://message.bilibili.com/', timeoutMs: 15000 });
    } catch (error) {
      if (p === 0) throw error;
      break;
    }
    if (p === 0) lastView = Number(data?.data?.last_view_at ?? 0) || 0;
    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    for (const it of items) {
      out.push({
        kind,
        id: String(it.id ?? ''),
        t: Number(it.reply_time ?? it.at_time ?? 0) || 0,
        who: String(it.user?.nickname ?? '?'),
        mid: String(it.user?.mid ?? ''),
        title: String(it.item?.title ?? ''),
        source: String(it.item?.source_content ?? ''),
        target: String(it.item?.target_reply_content ?? ''),
        business: Number(it.item?.business_id ?? 1) || 1,
        oid: String(it.item?.subject_id ?? ''),
        root: String(it.item?.root_id ?? ''),
        parent: String(it.item?.source_id ?? ''),
        uri: String(it.item?.uri ?? '')
      });
    }
    cursor = String(data?.data?.cursor ?? '');
    if (!cursor || !items.length) break;
  }
  const seen = new Set();
  return { items: out.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true))), lastView };
}

/** 回读楼层，拿“这个人真正说的那句话”。 */
export async function resolveFloor(s, { business = 1, oid, root, mid, parentRpid }) {
  const type = Number(business) === 11 ? 11 : 1;
  const reps = [];
  for (let pn = 1; pn <= 6; pn += 1) {
    try {
      const data = await getJson(s, `https://api.bilibili.com/x/v2/reply/reply?type=${type}&oid=${oid}&root=${root}&ps=20&pn=${pn}`, {
        referer: 'https://www.bilibili.com/', timeoutMs: 15000
      });
      const page = Array.isArray(data?.data?.replies) ? data.data.replies : [];
      reps.push(...page);
      if (page.length < 20) break;
    } catch { break; }
  }
  const mine = reps.filter((r) => String(r.mid) === String(mid));
  if (!mine.length) return null;
  let pick = null;
  if (parentRpid) pick = [...mine].reverse().find((r) => String(r.parent) === String(parentRpid)) || null;
  if (!pick) pick = mine[mine.length - 1];
  return {
    rpid: String(pick.rpid_str ?? pick.rpid ?? ''),
    text: String(pick.content?.message || ''),
    ctime: Number(pick.ctime ?? 0) || 0
  };
}

export async function parentAuthor(s, { oid, root, parentRpid, business = 1 }) {
  const type = Number(business) === 11 ? 11 : 1;
  for (let pn = 1; pn <= 4; pn += 1) {
    try {
      const data = await getJson(s, `https://api.bilibili.com/x/v2/reply/reply?type=${type}&oid=${oid}&root=${root}&ps=20&pn=${pn}`, {
        referer: 'https://www.bilibili.com/', timeoutMs: 15000
      });
      const list = Array.isArray(data?.data?.replies) ? data.data.replies : [];
      const hit = list.find((r) => String(r.rpid_str ?? r.rpid) === String(parentRpid));
      if (hit) return { mid: String(hit.mid ?? hit.member?.mid ?? ''), name: String(hit.member?.uname || '') };
      if (!list.length) break;
    } catch { break; }
  }
  return null;
}

export function bvidFromUri(uri) {
  const m = String(uri || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

// ── 写操作 ───────────────────────────────────────────────────────────────

const COMMENT_HINTS = {
  '-101': '账号未登录：cookie 失效',
  '-102': '账号被封停',
  '-111': 'csrf 校验失败：bili_jct 不对或与 SESSDATA 不是同一个号',
  '-509': '请求过于频繁',
  12015: '需要评论验证码（被风控盯上了，停手）',
  12016: '内容含敏感信息',
  12035: '被 UP 主列入评论黑名单',
  12051: '重复评论被判刷屏',
  12002: '评论区已关闭'
};

/**
 * 发一条评论 / 二级回复。调用方负责额度、评分、判重；这里只管“发”与“看懂错误”。
 * @returns {{ok:boolean, rpid:string, code:number, message:string, hint:string, risk:boolean, url:string}}
 */
export async function addComment(s, { oid, bvid = '', message, root = '', parent = '', type = 1, referer = '' }) {
  if (!s?.sessdata || !s?.biliJct) throw new BiliError('缺少 SESSDATA / bili_jct，不能发评论');
  const msg = String(message || '').trim();
  if (!msg) throw new BiliError('评论正文为空');
  if (msg.length > 1000) throw new BiliError(`评论太长（${msg.length}/1000）`);
  const params = { type: String(type || 1), oid: String(oid), message: msg, plat: '1', csrf: String(s.biliJct) };
  if (root) params.root = String(root);
  if (parent) params.parent = String(parent);
  const signed = await signParams(s, params);
  const query = new URLSearchParams({ w_rid: String(signed.w_rid), wts: String(signed.wts) }).toString();
  const body = new URLSearchParams(params).toString();
  const ref = referer || (bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/');
  const res = await netFetch(`https://api.bilibili.com/x/v2/reply/add?${query}`, {
    method: 'POST',
    headers: {
      ...headers(s, { referer: ref, cookie: true }),
      origin: 'https://www.bilibili.com',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  }, { timeoutMs: 30000 });
  const data = safeJsonParse(await res.text(), null) || {};
  const code = Number(data.code);
  const out = {
    ok: code === 0,
    code,
    message: String(data.message || data.msg || ''),
    rpid: String(data?.data?.rpid_str ?? data?.data?.rpid ?? ''),
    risk: riskOf(code, data.message || data.msg),
    hint: COMMENT_HINTS[String(code)] || '',
    url: bvid ? `https://www.bilibili.com/video/${bvid}/#reply${data?.data?.rpid_str ?? data?.data?.rpid ?? ''}` : ref
  };
  if (!out.ok && out.risk) logRef(`评论被风控：code=${code} ${out.message}`);
  return out;
}

// ── 点赞 / 收藏 / 回读（2026-10-22 P1-2「三连」）────────────────────────────
//
// 设计原则（借 dsh-bili-humanism 的 G 项）：**写一笔就回读一次**。
// 收藏/点赞都是对外可见的状态改动，光看 POST 的返回码不够 ——
// 必须再用 relation 接口确认 like/favorite 真的变成了 true，才能算成功。
// 这样"评论里说我赞了收了"永远不会是谎话（评论在那之后才发）。

const REACT_HINTS = {
  '-101': '账号未登录（SESSDATA 失效）',
  '-111': 'csrf 校验失败（bili_jct 不对或已过期）',
  '-400': '请求参数被拒（接口可能改版）',
  '-403': '账号权限不足',
  65004: '操作太快了，稍后再试',
  65006: '已经赞过了',
  10003: '账号未登录或已失效',
  22115: '这条视频已经不存在',
  11201: '收藏夹状态异常（可能已满/被删）'
};

const reactHint = (code) => REACT_HINTS[String(code)] || '';

async function postForm(s, url, params, referer) {
  const body = new URLSearchParams(params).toString();
  const res = await netFetch(url, {
    method: 'POST',
    headers: {
      ...headers(s, { referer }),
      origin: 'https://www.bilibili.com',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  }, { timeoutMs: 20000 });
  const data = safeJsonParse(await res.text(), null) || {};
  const code = Number(data.code);
  return {
    ok: code === 0,
    code,
    message: String(data.message || data.msg || ''),
    hint: reactHint(code),
    risk: riskOf(code, data.message || data.msg)
  };
}

/**
 * 读「我对这条视频做过什么」。这是唯一的**核验**入口。
 * @returns {{ok:boolean, like:boolean, favorite:boolean, coin:number, code?:number, error?:string}}
 */
export async function videoRelation(s, aid) {
  const id = String(aid || '').replace(/\D/g, '');
  if (!id) return { ok: false, like: false, favorite: false, coin: 0, error: '缺少 aid' };
  try {
    const res = await netFetch(`https://api.bilibili.com/x/web-interface/archive/relation?aid=${id}`, {
      headers: headers(s, { referer: 'https://www.bilibili.com/' })
    }, { timeoutMs: 15000 });
    const data = safeJsonParse(await res.text(), null) || {};
    const code = Number(data.code);
    if (code !== 0) {
      return { ok: false, like: false, favorite: false, coin: 0, code, error: String(data.message || data.msg || '') };
    }
    const d = data.data || {};
    return { ok: true, like: d.like === true, favorite: d.favorite === true, coin: Number(d.coin) || 0 };
  } catch (e) {
    return { ok: false, like: false, favorite: false, coin: 0, error: String(e?.message ?? e).slice(0, 140) };
  }
}

/**
 * 点赞。
 *
 * ★ 2026-10-22 实测（真打过接口，不是猜）：
 *   like='1' → code 0，真的点上了；like='2' → 取消成功；**like='0' 返回 -400 请求错误**。
 *   网上流传的"0 = 取消赞"在这个接口上已经不成立。这里只做"赞"，不做"取消"。
 *
 * ⚠️ 返回 code 0 **不代表**立刻能从 relation 读到 —— 实测有 1~3 秒延迟，
 *   所以 doTriple 的回读核验必须带重试，不能读一次就判死。
 */
export async function likeVideo(s, { aid, bvid = '' }) {
  if (!s?.biliJct) throw new BiliError('缺少 bili_jct，不能点赞');
  const id = String(aid || '').replace(/\D/g, '');
  if (!id) throw new BiliError('缺少 aid');
  const ref = bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/';
  return postForm(s, 'https://api.bilibili.com/x/web-interface/archive/like', {
    aid: id, like: '1', csrf: String(s.biliJct)
  }, ref);
}

/** 取「我创建的收藏夹」里的默认那个；名字匹配 favFolderName，没配就用 attr 默认夹。 */
export async function favFolders(s) {
  const mid = String(s?.ownerBiliMid || '').replace(/\D/g, '');
  if (!mid) return { ok: false, list: [], error: '没有配置主人（自己）的 B站 mid' };
  try {
    const res = await netFetch(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`, {
      headers: headers(s, { referer: 'https://www.bilibili.com/' })
    }, { timeoutMs: 15000 });
    const data = safeJsonParse(await res.text(), null) || {};
    if (Number(data.code) !== 0) return { ok: false, list: [], code: Number(data.code), error: String(data.message || '') };
    const list = Array.isArray(data?.data?.list) ? data.data.list : (Array.isArray(data?.data) ? data.data : []);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, list: [], error: String(e?.message ?? e).slice(0, 140) };
  }
}

export async function addFavorite(s, { aid, bvid = '', fid }) {
  if (!s?.biliJct) throw new BiliError('缺少 bili_jct，不能收藏');
  const id = String(aid || '').replace(/\D/g, '');
  const folder = String(fid || '').replace(/\D/g, '');
  if (!id || !folder) throw new BiliError('缺少 aid 或收藏夹 id');
  const ref = bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/';
  return postForm(s, 'https://api.bilibili.com/x/v3/fav/resource/deal', {
    rid: id, type: '2', add_media_ids: folder, del_media_ids: '', csrf: String(s.biliJct)
  }, ref);
}

export async function deleteComment(s, { oid, rpid, type = 1 }) {  if (!s?.biliJct) throw new BiliError('缺少 bili_jct');
  const body = new URLSearchParams({ type: String(type || 1), oid: String(oid), rpid: String(rpid), csrf: String(s.biliJct) }).toString();
  const res = await netFetch('https://api.bilibili.com/x/v2/reply/del', {
    method: 'POST',
    headers: { ...headers(s, { referer: 'https://www.bilibili.com/', cookie: true }), origin: 'https://www.bilibili.com', 'content-type': 'application/x-www-form-urlencoded' },
    body
  }, { timeoutMs: 20000 });
  const data = safeJsonParse(await res.text(), null) || {};
  return { ok: Number(data.code) === 0, code: Number(data.code), message: String(data.message || data.msg || '') };
}

// ── 直播 ─────────────────────────────────────────────────────────────────

export async function liveInfo(s, room) {
  const id = String(room || '').replace(/\D/g, '');
  if (!id) throw new BiliError('没有直播间房间号');
  const data = await getJson(s, `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${id}`, {
    referer: `https://live.bilibili.com/${id}`, timeoutMs: 15000
  });
  return data.data || {};
}

export async function liveHistory(s, room) {
  const info = await liveInfo(s, room);
  const realId = String(info.room_id || room || '').replace(/\D/g, '') || String(room || '');
  const data = await getJson(s, `https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory?roomid=${realId}&room_type=0`, {
    referer: `https://live.bilibili.com/${info.short_id || room}`, timeoutMs: 15000
  });
  const rows = Array.isArray(data?.data?.room) ? data.data.room : [];
  return {
    room: {
      roomId: realId,
      shortId: String(info.short_id || ''),
      uid: String(info.uid || ''),
      title: String(info.title || ''),
      liveStatus: Number(info.live_status ?? 0) || 0,
      online: Number(info.online ?? 0) || 0
    },
    rows: rows.map((r) => ({
      id: String(r.id_str ?? `${r.timeline}|${r.nickname}|${r.text}`),
      uid: String(r.uid ?? ''),
      name: String(r.nickname || ''),
      text: String(r.text || ''),
      timeline: String(r.timeline || '')
    })).filter((x) => x.text)
  };
}

export async function sendDanmaku(s, { room, message, replyMid = '', replyName = '' }) {
  if (!s?.biliJct) throw new BiliError('缺少 bili_jct，不能发弹幕');
  const msg = String(message || '').trim();
  if (!msg) throw new BiliError('弹幕内容为空');
  if (msg.length > 20) throw new BiliError(`弹幕太长（${msg.length}/20）`);
  const info = await liveInfo(s, room);
  const realId = String(info.room_id || room || '').replace(/\D/g, '');
  const shortId = String(info.short_id || room || '').replace(/\D/g, '');
  const form = {
    csrf: String(s.biliJct),
    csrf_token: String(s.biliJct),
    roomid: realId,
    msg,
    rnd: String(Math.round(Date.now() / 1000)),
    fontsize: '25',
    color: '16777215',
    mode: '1',
    bubble: '0',
    room_type: '0',
    jumpfrom: '0',
    statistics: JSON.stringify({ appId: 100, platform: 5 })
  };
  if (replyMid) {
    form.reply_mid = String(replyMid);
    if (replyName) form.reply_uname = String(replyName);
  }
  const res = await netFetch('https://api.live.bilibili.com/msg/send', {
    method: 'POST',
    headers: {
      ...headers(s, { referer: `https://live.bilibili.com/${shortId || realId}`, cookie: true }),
      origin: 'https://live.bilibili.com',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(form).toString()
  }, { timeoutMs: 20000 });
  const data = safeJsonParse(await res.text(), null) || {};
  const code = Number(data.code);
  return {
    ok: code === 0,
    code,
    message: String(data.message || data.msg || ''),
    risk: riskOf(code, data.message || data.msg),
    roomId: realId
  };
}

/** 给入口做一次轻量自检：WBI 能不能拿到、登录态如何。 */
export async function diagnose(s) {
  const login = await checkLogin(s);
  const items = [
    { id: 'cookie', ok: Boolean(s?.sessdata) && Boolean(s?.biliJct), detail: s?.sessdata ? '已填写 SESSDATA' : '未填写 SESSDATA' },
    { id: 'buvid3', ok: Boolean(s?.buvid3), detail: s?.buvid3 ? '已填写' : '未填写（部分接口会被风控）' },
    { id: 'login', ok: login.ok, detail: login.ok ? `${login.uname}（mid ${login.mid}）` : login.reason },
    { id: 'owner', ok: Boolean(s?.ownerBiliMid && s?.ownerBiliName), detail: s?.ownerBiliMid && s?.ownerBiliName ? `${s.ownerBiliName}（mid ${s.ownerBiliMid}）` : '主人 UID/昵称未填齐，分享会没有 @ 对象' },
    { id: 'llm', ok: s?.llmMode !== 'off', detail: s?.llmMode === 'off' ? '模型通道关闭（只做摘要）' : (s?.llmBaseUrl && s?.llmModel ? `自带接口 ${s.llmModel}` : '优先用宿主 ai.ask 能力') }
  ];
  return { ok: items.every((x) => x.ok), login, items };
}

export const internals = {
  headers, netFetch, getJson, wbiMixin, safeHost, decodeXml
};
