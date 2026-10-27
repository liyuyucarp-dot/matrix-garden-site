// bili-whale / feed.js
//
// 「动态」两件事：
//   ① 刷新动态首页（只读）——看关注的人在发什么，可选带进日记/回应
//   ② 发一条动态（写入，公开可见）——必须显式开关 + 每日上限 + 去重
//
// 为什么单独成文件：动态跟"视频内容"是两条完全不同的链路（不是 bvid 维度），
// 放在 bili.js 里会让那个文件更臃肿；复用它的 internals（headers/netFetch/getJson）
// 保证 cookie 域、风控识别、SSRF 防护口径一致。
//
// 实测记录（2026-10-21）：
//   · 动态首页 `x/polymer/web-dynamic/v1/feed/all`：**需要登录**，未登录返回 -101「账号未登录」
//   · 发动态 `x/dynamic/feed/create/dyn?csrf=<bili_jct>`：POST JSON，同样需要登录
//   · 两套都要 `bili_jct`（csrf）——没有它一律 -111「csrf 校验失败」

import { internals, checkLogin } from './bili.js';
import { getDb, addEvent, markDirty } from './store.js';
import { truncate, todayKey, tzNow } from './util.js';

const { headers, netFetch } = internals;

const DYNAMIC_TYPES = {
  DYNAMIC_TYPE_AV: '视频',
  DYNAMIC_TYPE_DRAW: '图文',
  DYNAMIC_TYPE_WORD: '文字',
  DYNAMIC_TYPE_FORWARD: '转发',
  DYNAMIC_TYPE_ARTICLE: '专栏',
  DYNAMIC_TYPE_LIVE_RCMD: '直播',
  DYNAMIC_TYPE_MUSIC: '音频',
  DYNAMIC_TYPE_PGC: '番剧'
};

const RISK_CODES = new Set([-412, -352, -509, 412, 12015, 12051]);
const isRisk = (code, msg) => RISK_CODES.has(Number(code)) || /风控|验证码|频繁|拒绝访问|too many|captcha/i.test(String(msg || ''));

/** 一条动态压成一行：谁、什么时候、什么类型、说了什么、链到哪。 */
function normalizeItem(it) {
  const mod = it?.modules || {};
  const author = mod.module_author || {};
  const dyn = mod.module_dynamic || {};
  const major = dyn.major || {};
  const desc = dyn.desc?.text || '';
  const ts = Number(author.pub_ts) || 0;
  const type = String(it?.type || '');
  const kind = DYNAMIC_TYPES[type] || type.replace('DYNAMIC_TYPE_', '').toLowerCase() || '动态';

  // 取一个"最像内容"的补充：视频标题 / 专栏标题 / 图文首图
  let extra = '';
  let link = '';
  if (major.archive?.title) {
    extra = String(major.archive.title);
    if (major.archive.bvid) link = `https://www.bilibili.com/video/${major.archive.bvid}`;
  } else if (major.article?.title) {
    extra = String(major.article.title);
    if (major.article.jump_url) link = 'https:' + String(major.article.jump_url).replace(/^https?:/, '');
  } else if (major.opus?.title) {
    extra = String(major.opus.title);
  } else if (major.draw?.items?.length) {
    extra = `[图文 ${major.draw.items.length} 张]`;
  }
  const dynId = String(it?.id_str || it?.id || '');
  if (!link && dynId) link = `https://t.bilibili.com/${dynId}`;

  const pics = (major.draw?.items || []).map((x) => String(x?.src || '')).filter(Boolean).slice(0, 4);

  return {
    dynId,
    mid: String(author.mid || ''),
    author: String(author.name || '?'),
    ts,
    kind,
    text: truncate((desc || extra || '').replace(/\s+/g, ' ').trim(), 220),
    extra: extra && extra !== desc ? truncate(extra, 80) : '',
    link,
    pics,
    type
  };
}

/**
 * 刷新动态首页（关注的人在发什么）。
 * @returns {Promise<{ok:boolean, items:Array, hasMore:boolean, count:number, error?:string}>}
 */
export async function homeFeed(s, { page = 1, limit = 20, type = 'all' } = {}) {
  if (!s?.sessdata) return { ok: false, items: [], hasMore: false, count: 0, error: '没有填 SESSDATA，读不了动态首页' };
  const qs = new URLSearchParams({
    timezone_offset: '-480',
    type: String(type || 'all'),
    page: String(Math.max(1, Number(page) || 1)),
    features: 'itemOpusStyle'
  });
  try {
    const data = await internals.getJson(s, `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?${qs}`, {
      referer: 'https://t.bilibili.com/'
    });
    const raw = data?.items || data?.data?.items || [];
    const items = raw.map(normalizeItem).filter((x) => x.dynId || x.text);
    return {
      ok: true,
      items: items.slice(0, Math.max(1, Math.min(50, Number(limit) || 20))),
      hasMore: Boolean(data?.has_more ?? data?.data?.has_more),
      count: items.length,
      updateNum: Number(data?.update_num ?? data?.data?.update_num ?? 0) || 0
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    const hint = /-101|未登录/.test(msg)
      ? '（cookie 失效：去插件设置里重新粘贴 SESSDATA / bili_jct / buvid3）'
      : '';
    return { ok: false, items: [], hasMore: false, count: 0, error: truncate(msg, 200) + hint, risk: Boolean(e?.risk) };
  }
}

/** 今天发过几条动态（按事件账本 + 时区算当天零点，跨天自动归零）。 */
export function postedToday(s) {
  try {
    const db = getDb();
    const now = tzNow(s?.timeZone);
    const startOfDay = Date.now() - Math.max(0, Number(now.minutes) || 0) * 60000;
    return (db.events || []).filter((e) => e.kind === 'post-dyn' && Number(e.at) >= startOfDay).length;
  } catch { return 0; }
}

/**
 * 发一条纯文字动态。
 *
 * ⚠️ 这是**公开、不可撤回**的动作（能删但会留下痕迹），所以：
 *   · 必须 postEnabled=true 才会有工具暴露；
 *   · dryRun（演练模式）下只回显不发送；
 *   · 每天有 postDailyMax 上限；
 *   · 同一段文字 24 小时内不重复发（防抖）。
 *
 * @returns {Promise<{ok:boolean, dryRun?:boolean, dynId?:string, url?:string, error?:string, code?:number}>}
 */
export async function postDynamic(s, { text, dryRun = false } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '正文为空' };
  if (!s?.sessdata || !s.sessdata) return { ok: false, error: '没有填 SESSDATA，不能发动态' };
  if (!s?.biliJct) return { ok: false, error: '没有填 bili_jct（csrf），不能发动态' };
  if (body.length > 2000) return { ok: false, error: `正文太长（${body.length}/2000）` };

  const cap = Math.max(0, Math.min(10, Number(s.postDailyMax) || 0));
  const used = postedToday(s);
  if (cap && used >= cap) return { ok: false, error: `今天已经发过 ${used} 条（上限 ${cap}），明天再说` };

  // 24 小时内不重复同一条
  try {
    const db = getDb();
    const since = Date.now() - 24 * 3600 * 1000;
    const dup = (db.events || []).find((e) => e.kind === 'post-dyn' && Number(e.at) > since && String(e.note || '').includes(body.slice(0, 40)));
    if (dup) return { ok: false, error: '这条 24 小时内发过，不重复发' };
  } catch { /* ignore */ }

  if (dryRun || s.dryRun) {
    return { ok: true, dryRun: true, dynId: '', url: '', text: body, note: '演练模式：没有真的发出去' };
  }

  const payload = {
    dyn_req: {
      content: { contents: [{ raw_text: body, type: 1, biz_id: '' }] },
      scene: 1,
      attach_card: null,
      upload_id: '',
      meta: { platform: 'web', from: 'create.dyn' }
    }
  };

  try {
    const res = await netFetch(`https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(String(s.biliJct))}`, {
      method: 'POST',
      headers: {
        ...headers(s, { referer: 'https://t.bilibili.com/', cookie: true, origin: 'https://t.bilibili.com' }),
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, { timeoutMs: 30000 });

    const rawText = await res.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch { data = null; }
    if (!data) return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）：${truncate(rawText, 120)}` };

    const code = Number(data.code);
    if (code !== 0) {
      const msg = String(data.message || data.msg || '');
      const hint = /-101|未登录/.test(`${code} ${msg}`)
        ? '（cookie 失效，去设置里重新粘贴 SESSDATA / bili_jct）'
        : /-111|csrf/.test(`${code} ${msg}`) ? '（csrf 不对：bili_jct 要和 SESSDATA 同一次登录）'
          : /-352|风控/.test(`${code} ${msg}`) ? '（撞到风控，今天别再发了）' : '';
      if (isRisk(code, msg)) addEvent('risk-stop', `发动态被拦：code=${code} ${truncate(msg, 120)}`);
      return { ok: false, code, error: `B站返回 code=${code} ${msg}${hint}`, risk: isRisk(code, msg) };
    }

    const dynId = String(data?.data?.dyn_id_str ?? data?.data?.dyn_id ?? data?.data?.dynamic_id ?? '');
    addEvent('post-dyn', body.slice(0, 120), dynId || null);
    markDirty();
    return { ok: true, dynId, url: dynId ? `https://t.bilibili.com/${dynId}` : 'https://t.bilibili.com/', text: body };
  } catch (e) {
    return { ok: false, error: truncate(String(e?.message ?? e), 200), risk: Boolean(e?.risk) };
  }
}

/** 动态相关的自检（给 status / 工具用）。 */
export async function feedDiagnose(s) {
  const login = await checkLogin(s);
  const feed = await homeFeed(s, { limit: 3 });
  return {
    login: { ok: login.ok, reason: login.reason, mid: login.mid, uname: login.uname },
    feed: { ok: feed.ok, count: feed.count, error: feed.error || '' },
    post: { enabled: Boolean(s?.postEnabled), usedToday: postedToday(s), cap: Number(s?.postDailyMax) || 0 }
  };
}
