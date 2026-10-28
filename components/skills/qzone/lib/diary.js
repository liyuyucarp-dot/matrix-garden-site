// components/skills/qzone/lib/diary.js
// 由原 skills/qqzone/index.js 迁入（2026-10-27 合并第一步）。
// 本轮只做「合并成一个技能」，底层重复（Cookie/OneBot/布局探测）暂留两份，
// 去重放到下一步（那时 core 就在同一个技能里，不再有跨技能依赖问题）。
// QQ 空间动态 —— **自包含** Skill（QQ Agent 0.3.1 规范）
//
// 这个文件会被**原样拷进别人的 app 目录**，那份 app 的 src/ 结构与我们的不同，
// 所以这里**不 import 任何 `../../src/...`**，只用 Node 内置模块。
//
// ── 能力 ────────────────────────────────────────────────────────────────
//   qqzone__collect_diary  收集今天的日记素材（只读，不出网）
//   qqzone__post_diary     日记正文 → 长文排版图 → 发说说
//
//   （发说说/刷动态/点赞/评论四个工具 2026-10-12 裁给 skills/qzone，裁剪残留
//     已于 2026-10-23 清理，见 README 开头说明。）
//
// ── 日记这条线（v2.0 改装）────────────────────────────────────────────
//   collect_diary 把三样原料喂给模型：当天全部会话的聊天记录（热段+冷段，按天过滤、
//   按条数/字数封顶）、「世界与事件」插件的世界观（config.skills['life-system'].worldbook）
//   和近况账本（data/life-events.json，只取今天的条目）。日记正文由模型自己写——
//   第一人称、它今天的经历和感受，工具不代笔。
//   post_diary 复用「长文排版图」的渲染管线（skills/text-image 的 renderPages，
//   软依赖：模块不在就自动把日记发成纯文字说说，不报错拦人），PNG 字节直接走本文件
//   已有的 uploadQzoneImage 上 Qzone 图床再发说说——不经聊天记录，所以不受
//   "模型拿不到任意图"那条铁律约束：图是本地渲染出来的，不是模型塞进来的字节。
//   日记按天限频（diaryPerDay，默认 1 篇），与 postsPerDay 是两条独立的闸。
//
// ── 前置依赖（v2.1 起全部软性，manifest.requires 留空）─────────────────
//   「世界与事件」插件（plugins/life-system）和「长文排版图」技能（skills/text-image）
//   都**不强制**：没装世界与事件，collect_diary 照常回素材（注明跳过世界观与账本）；
//   没装长文排版图（或渲染失败），post_diary 自动把日记发成纯文字说说。
//   装了就增强，没装就降级，任何一个缺失都不挡工具注册。
//
// ── 带图说说的图片只从聊天记录里来（铁律，别开口子）────────────────────
//   模型给的**不是**路径 / 网址 / base64，而是聊天记录里的消息号（#12345，
//   多张图用 #12345:2）。定位符由我们从 ctx.store 的存档里取 —— 与 src/tools.js
//   的 send_voice 一个口径：模型只给白名单键，出网的东西全由应用侧解析。
//   这样"任意本地文件被当图上传"这条路根本不存在，坏引用在碰网络之前就死。
//
// ── 登录态从哪来 ─────────────────────────────────────────────────────────
//   Qzone 网页接口只认 cookie。bot 账号在 SnowLuma 里登录着，OneBot 的 get_cookies
//   能直接把它取出来（注意：SnowLuma 对 get_cookies 这类敏感接口强制校验
//   accessToken，所以调用必须带 Bearer——先从 ctx.onebot 的常规通道走，
//   被 1401 拒了再去读 snowluma 的配置文件自己拿 token 拼请求）。
//   对本项目"API Key 不回显"的铁律：token 只存在内存变量里，绝不写日志、绝不进返回值。
//
// ── available() 的铁律：必须同步 ────────────────────────────────────────
//   只 existsSync 探测"登录态有没有可能拿到"，绝不做网络 IO。结果缓存 30 秒，
//   因为 bot 掉线/重连会改变答案。
//
// ── 为什么解析器是个状态机而不是 JSON.parse ──────────────────────────────
//   Qzone 的动态接口返回的是 **JS 对象字面量**（key 不带引号、字符串用单引号、
//   还有 \xNN / \uNNNN 转义和裸 undefined），JSON.parse 会直接抛。正则替换试过，
//   会在"双引号字符串里套单引号"的数据上把文本改坏——只有逐字符 tokenizer 才稳。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  UA, QZONE, QZONE_UPLOAD, HTTP_TIMEOUT_MS, COOKIE_CACHE_MS, IMG_PER_POST_HARD_MAX, DAY_MS, HOUR_MS,
  findAppRoot, dataDirCandidates, dataDir, snowConfigCandidates, gtk, cookieHeader, parseCookiesField, acquireCookies, fetchCookiesViaOnebot, finishCookies, ownHttpPorts, readSnowHttpServices, rememberOnebot, sanitizeText, imageKindOf,
  getOnebot, setOnebot, resetCookies, setLogger
} from './qzone-core.js'

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')   // lib/ 的上一层 = 技能根   // …/skills/qqzone
const SKILL_ID = 'qqzone'
const TOOL = (n) => `${SKILL_ID}__${n}`

const IMG_MB_DEFAULT = 8

// ── setup 里存下来的引用（available / diagnose 可能在任何时候被调用）──
let cfgOf = () => ({})
let log = () => {}
const debugLog = []
function dbg(step, ok, detail) {
  debugLog.push({ t: Date.now(), step, ok: !!ok, detail: String(detail ?? '').slice(0, 120) })
  if (debugLog.length > 30) debugLog.splice(0, debugLog.length - 30)
  if (ok == null) return
  const msg = `[qqzone] ${step}: ${detail ?? ''}`
  try { ok ? log(msg) : console.warn(msg) } catch { /* 日志失败不影响主流程 */ }
}

/* ══════════════════════════════════════════════════════════════════════
   一、布局探测：找到 app 根（resources/app）与 data 目录
   ══════════════════════════════════════════════════════════════════════ */

export function jsLiteralToJson(s) {
  const str = String(s ?? '')
  let out = ''
  let i = 0
  const n = str.length
  while (i < n) {
    const ch = str[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let inner = ''
      i++
      while (i < n) {
        const c = str[i]
        if (c === '\\') {
          const nx = str[i + 1]
          if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 4), 16)); i += 4; continue
          }
          if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 6), 16)); i += 6; continue
          }
          const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }[nx]
          inner += simple !== undefined ? simple : (nx ?? ''); i += 2; continue
        }
        if (c === quote) { i++; break }
        inner += c; i++
      }
      out += JSON.stringify(inner)
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let word = ''
      while (i < n && /[A-Za-z0-9_$]/.test(str[i])) { word += str[i]; i++ }
      out += word === 'undefined' || word === 'NaN' ? 'null'
        : word === 'true' || word === 'false' ? word
        : word === 'null' ? 'null'
        : JSON.stringify(word)   // 未知标识符（比如裸枚举值）按字符串保下来，别让解析炸
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * 从响应里截出第一个括号配平的 {...} / [...] 块。靠正则剥 callback 的做法要求
 * `callback(...)` 独占整个响应，但上传接口偶尔会在收尾 `);` 后再吐一段尾巴
 * （或连着第二个 callback），此时正则不匹配、原样放行，jsLiteralToJson 会把
 * 开头的 `callback` 变成 10 字符的字符串 "callback"，JSON.parse 就报
 * "Unexpected non-whitespace character after JSON at position 10"。按字符扫描
 * 配平（跳过引号字符串和 \ 转义）不怕任何前后垃圾。
 */
export function extractJsonBlock(text) {
  const str = String(text ?? '')
  let start = -1
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{' || str[i] === '[') { start = i; break }
  }
  if (start === -1) return str
  let depth = 0
  let inStr = false
  let quote = ''
  for (let i = start; i < str.length; i++) {
    const ch = str[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === quote) inStr = false
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return str.slice(start, i + 1)
    }
  }
  return str.slice(start)
}

/**
 * 图片魔数校验。Qzone 只吃这几种；顺手挡掉"把任意文件当图上传"
 * （与 src/tts.js 的 isAudio 一个纪律：出网前先验明正身）。
 */
export function fmtLocal(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ══════════════════════════════════════════════════════════════════════
   三、状态与限频：data/qqzone/state.json
   ══════════════════════════════════════════════════════════════════════ */

function defaultState() {
  return { posts: [], diaries: [], likes: [], comments: [], lastBrowse: 0, feedCache: null, acted: {} }
}

function stateFile() {
  return path.join(dataDir(), SKILL_ID, 'state.json')
}

export function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const j = JSON.parse(raw)
    return { ...defaultState(), ...j, acted: (j && typeof j.acted === 'object' && j.acted) || {} }
  } catch {
    return defaultState()
  }
}

export function saveState(st) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
  fs.renameSync(tmp, file)   // 原子替换：崩在半路不会留下半个 JSON
}

/**
 * 限频判定（纯函数，方便测试）。
 *   posts   按"今天 0 点起"计（每天发条数要严格）
 *   likes/comments 按滑动 1 小时窗口计
 * 返回 { ok, reason? }
 */
export function checkCap(st, kind, cfg, now = Date.now()) {
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  if (kind === 'diary') {
    // 日记单独按天限频：和 postsPerDay 是两条闸，发日记不占普通说说的额度
    // ★★ 2026-10-14 修：`Number('') === 0` ⇒ 用户在设置页**把这一项清空**时，
    //   旧写法会把"没配"读成"配了 0 篇" ⇒ 闸**永远不写、且不报错**（静默失效）。
    //   本项目的成文纪律：判"参数到底传没传"必须显式排除 `null`/`undefined`/`''`
    //   （同类事故已栽过五次）。默认 **1**（一天一篇）；显式填 0 才算真的关掉。
    const cap = Math.max(0, numOr(cfg.diaryPerDay, 1))
    const n = (st.diaries || []).filter((t) => t >= dayStart).length
    if (n < cap) return { ok: true }
    // 说清"为什么不算数"：最常见的场景就是**她自己当天已经写过一篇了**。
    // 带上那篇的时刻 —— 排查时一眼就知道"额度被谁用掉了"（今天 10:14 就靠这一条
    // 认出"昨天没发"是因为凌晨测试时已经发过一篇）。
    const last = (st.diaries || []).filter((t) => t >= dayStart).sort((a, b) => b - a)[0]
    const at = last ? ` —— 今天 ${hhmmOf(last)} 那篇` : ''
    return {
      ok: false,
      reason: cap === 0
        ? '这一项被设成了每天 0 篇（等于关掉写日记），要写就先去设置里把它改成 1'
        : `今天的日记已经写过了${at}（每天 ${cap} 篇），明天再来记吧`
    }
  }
  if (kind === 'post') {
    const cap = Math.max(0, Number(cfg.postsPerDay) || 0)
    const n = (st.posts || []).filter((t) => t >= dayStart).length
    return n < cap ? { ok: true } : { ok: false, reason: `今天已发 ${n} 条说说（上限 ${cap} 条/天），明天再来吧` }
  }
  const key = kind === 'like' ? 'likes' : 'comments'
  const cfgKey = kind === 'like' ? 'likesPerHour' : 'commentsPerHour'
  const cap = Math.max(0, Number(cfg[cfgKey]) || 0)
  const n = (st[key] || []).filter((t) => now - t < HOUR_MS).length
  return n < cap
    ? { ok: true }
    : { ok: false, reason: `最近一小时已${kind === 'like' ? '点赞' : '评论'} ${n} 次（上限 ${cap} 次/小时），歇一会吧` }
}

/** 记录一次成功写入并落盘。 */
export function recordAct(st, kind, feedId, now = Date.now()) {
  if (kind === 'diary') st.diaries = [...(st.diaries || []), now]
  if (kind === 'post') st.posts = [...(st.posts || []), now]
  if (kind === 'like') st.likes = [...(st.likes || []), now]
  if (kind === 'comment') st.comments = [...(st.comments || []), now]
  if (feedId) {
    st.acted = st.acted || {}
    st.acted[feedId] = { kind, t: now }
    const ids = Object.keys(st.acted)
    if (ids.length > 300) {                    // 老的互动记忆定期清掉
      ids.sort((a, b) => (st.acted[a].t || 0) - (st.acted[b].t || 0))
      for (let i = 0; i < ids.length - 300; i++) delete st.acted[ids[i]]
    }
  }
  saveState(st)
}

/* ══════════════════════════════════════════════════════════════════════
   四、登录态：cookie / g_tk 的获取与缓存
   ══════════════════════════════════════════════════════════════════════ */

async function qzonePost(urlPath, form, cookies) {
  // urlPath 允许是绝对地址：图片上传在 up.qzone.qq.com，不在 user.qzone.qq.com 的代理下。
  const url = /^https?:\/\//i.test(urlPath) ? urlPath : `${QZONE}${urlPath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      cookie: cookieHeader(cookies),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: `${QZONE}/`
    },
    redirect: 'manual',
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

/* ═══ 风控熔断（2026-10-24）═══
   空间被拦时往往仍返回 200、装作成功；这时硬重试只会把风控推得更深。
   判据（任一命中即锁当日）：① 响应正文出现 verify/captcha；② code=-3000
   （未登录/登录态失效）或 -10000（频控）；③ 连续 2 次被重定向到登录页。
   锁存在 state.json 的 riskDay（本地自然日键），次日自然失效；
   自动日记与 qqzone__post_diary 出网前都会先看这把锁。 */
let redirectStreak = 0;

/** 命中风控 → 写当日锁（幂等，一天只写一次）。 */
function markRisk(reason) {
  try {
    const st = loadState();
    const day = diaryDayKey();
    if (st.riskDay === day) return;
    st.riskDay = day;
    st.riskAt = Date.now();
    st.riskReason = String(reason).slice(0, 120);
    saveState(st);
    log?.(`[qqzone] ⚠️ 风控熔断：${st.riskReason} —— 当日停发（自动日记与发日记工具），明天自动恢复`);
  } catch { /* 锁写不进去也别影响主流程 */ }
}

/** 上传/发布的出网口都走这里：把"看起来成功、其实被拦"的响应挑出来。 */
async function qzonePostGuarded(urlPath, form, cookies, what) {
  let text;
  try {
    text = await qzonePost(urlPath, form, cookies);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('重定向到了登录页')) {
      redirectStreak += 1;
      if (redirectStreak >= 2) markRisk(`连续 ${redirectStreak} 次被重定向到登录页（${what}）`);
    }
    throw e;
  }
  redirectStreak = 0;
  if (/verify|captcha/i.test(text)) {
    markRisk(`响应出现 verify/captcha（${what}）`);
    throw new Error(`${what}被风控拦了（返回了验证码页），今天先不试了`);
  }
  return text;
}

/** 发日记说说的统一出口：穿守卫 + code=-3000/-10000 落锁后原样抛错。 */
async function qzonePublish(form, auth) {
  try {
    return parseQzoneLooseJson(
      await qzonePostGuarded(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies, '发日记说说'),
      '发日记说说'
    );
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/code=(-3000|-10000)/.test(msg)) markRisk(`发日记说说 ${msg.slice(0, 80)}`);
    throw e;
  }
}

/**
 * 上传 / 发布这两个接口的响应**不一定带 code 字段**（成功时可能整个没有），
 * 所以不能复用上面那个"必须 code===0"的严格判定，否则成功会被当成失败。
 * 口径照 SnowLuma 桥：code / subcode 只在是数字且非 0 时才算错。
 * 另外上传接口偶尔在 callback( 前面吐一段垃圾、或在收尾 ); 后再挂尾巴/连发
 * 第二个 callback——前面先切到 callback，后面交给 extractJsonBlock 配平截取。
 */
export function parseQzoneLooseJson(text, what) {
  let s = String(text ?? '').trim()
  const at = s.indexOf('callback')
  if (at > 0) s = s.slice(at)
  let j
  try {
    j = JSON.parse(jsLiteralToJson(extractJsonBlock(s)))
  } catch (e) {
    throw new Error(`${what}返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  for (const k of ['code', 'subcode']) {
    if (typeof j?.[k] === 'number' && j[k] !== 0) {
      throw new Error(`${what}失败: ${k}=${j[k]} ${j?.message || j?.msg || ''}`.trim())
    }
  }
  return j || {}
}

/**
 * 传到 Qzone 图床，换回 richval（发说说时靠它挂图）。
 * 返回的 richval 形如 `,albumid,lloc,lloc,type,height,width,,height,width`；
 * 多图就把多个 richval 用 \t 连起来交给发布接口。
 */
async function uploadQzoneImage(auth, buf) {
  const { cookies, gtk2, selfUin } = auth
  const form = {
    filename: 'filename',
    uin: selfUin,
    skey: cookies.get('skey') || '',
    zzpaneluin: selfUin,
    p_uin: selfUin,
    p_skey: cookies.get('p_skey') || '',
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: `https://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image`,
    base64: '1',
    jsonhtml_callback: 'callback',
    picfile: buf.toString('base64'),
    qzreferrer: `${QZONE}/${selfUin}/main`
  }
  let j
  try {
    j = parseQzoneLooseJson(await qzonePostGuarded(`${QZONE_UPLOAD}?g_tk=${gtk2}`, form, cookies, '上传图片'), '上传图片')
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (/code=(-3000|-10000)/.test(msg)) markRisk(`上传图片 ${msg.slice(0, 80)}`)
    throw e
  }
  const d = j?.data
  if (!d?.albumid || !d?.lloc || !d?.url) throw new Error('上传图片失败：响应缺少 albumid/lloc/url')
  const h = Number(d.height) || 0
  const w = Number(d.width) || 0
  const t = Number(d.type) || 0
  return {
    richval: `,${d.albumid},${d.lloc},${d.lloc},${t},${h},${w},,${h},${w}`,
    url: String(d.url),
    width: w,
    height: h
  }
}

/* ══════════════════════════════════════════════════════════════════════
   六点九、日记：素材收集（纯本地） + 排版出图 + 发说说
   ══════════════════════════════════════════════════════════════════════ */

export function localDayStart(now = Date.now()) {
  return new Date(now).setHours(0, 0, 0, 0)
}

/** 小时 → 时段词。日记素材拿它把「00:03」翻译成「凌晨 00:03」——光给数字，
 *  模型会把深夜的事顺手写成「晚上」（试跑实锤过：凌晨 3 点的跑团被写成"晚上查怪事"）。 */
export function timeOfDay(hour) {
  const h = Number(hour)
  if (!Number.isFinite(h)) return ''
  if (h < 5) return '凌晨'
  if (h < 8) return '清晨'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 23) return '晚上'
  return '深夜'
}

/** 时间戳 → 「HH:mm」；取不到（0/空/NaN）给空串。
 *  ⚠️ 判"有没有传"必须显式排除 null/undefined——Number(null)===0 且 isFinite(0) 为真，
 *  用 `Number(x) || ''` 那类写法会把"没有时间戳"当成"0 点"。 */
export function hhmmOf(ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 一个会话块的时间范围 → 「凌晨 00:03 → 上午 10:27」；没有时间戳给「今天」。 */
function chatSpanLabel(c) {
  const from = Number(c?.from)
  const to = Number(c?.to)
  const a = hhmmOf(from)
  if (!a) return '今天'
  const ta = timeOfDay(new Date(from).getHours())
  const b = hhmmOf(to)
  if (!b || b === a) return `${ta} ${a}`
  return `${ta} ${a} → ${timeOfDay(new Date(to).getHours())} ${b}`
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 存档里所有会话的 chatKey（热段 + 冷段文件名并集）。 */
export function listArchiveChats(messagesDir, coldDir) {
  const keys = new Set()
  try {
    for (const f of fs.readdirSync(messagesDir)) {
      if (/^(group|private)_.+\.json$/.test(f)) keys.add(f.replace(/\.json$/, ''))
    }
  } catch { /* 目录不存在就当没有 */ }
  try {
    for (const f of fs.readdirSync(coldDir)) {
      const m = f.match(/^((?:group|private)_.+)\.\d{5}\.json$/)
      if (m) keys.add(m[1])
    }
  } catch { /* 同上 */ }
  return [...keys]
}

function chatLabel(chatKey) {
  const m = String(chatKey).match(/^(group|private)_(\d+)$/)
  if (!m) return String(chatKey)
  return m[1] === 'group' ? `群 ${m[2]}` : `私聊 ${m[2]}`
}

/** 一条存档消息 → 「HH:mm 谁：内容」一行。控制字符、超长、CQ 噪音都在这里收掉。 */
export function chatLineOf(m) {
  const d = new Date(Number(m?.ts) || 0)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const who = m?.self ? '我' : String(m?.senderName || '某人').replace(/\s+/g, ' ').slice(0, 14)
  let text = String(m?.text || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > 100) text = text.slice(0, 99) + '…'
  const media = Array.isArray(m?.media) && m.media.length ? ' [图]' : ''
  return `${hhmm} ${who}：${text || (media ? media.trim() : '…')}${text ? media : ''}`
}

/**
 * 当天的聊天素材。messagesDir 是热段目录（<data>/messages），冷段在
 * <data>/messages-cold（<chatKey>.NNNNN.json，seq 升序）——两段都读，按天过滤。
 * 每个会话最多取最近 msgsPerChat 条，会话按今天消息数排座次，最多 maxChats 个，
 * 全部行加起来不超 maxTotalChars（超了就整段会话丢弃，不切半行）。
 */
export function collectTodayMessages(messagesDir, coldDir, opts = {}, now = Date.now()) {
  const dayStart = localDayStart(now)
  // ★★ 2026-10-17（用户口径）：**旅行是主线、群聊是重要组成 = 约 7:3**。
  //   原值 40 句 / 8 会话 / 6000 字 —— 即便 10-15 已降过一次，仍是旅行线（几百字）的**十倍量级**，
  //   与"三成"完全不成比例；而**素材体积决定注意力**，模型只能按体积走（→ 干脆不写群聊）。
  //   ⇒ 收紧到 16 句 / 4 会话 / 2400 字，约等于旅行线素材的 2~3 倍，
  //     留出"挑两三处"的余地，成文比重交给 `diaryGuidance` 的 7:3 决定。
  //   ⚠️ 死旋钮的教训保留：这里读的是 `opts.maxCollectChars`（**不是** maxTotalChars）。
  const msgsPerChat = Math.min(500, Math.max(10, Number(opts.msgsPerChat) || 16))
  const maxChats = Math.min(30, Math.max(1, Number(opts.maxChats) || 4))
  const maxTotalChars = Math.min(60000, Math.max(800, Number(opts.maxCollectChars) || 2400))

  const perChat = []
  for (const chatKey of listArchiveChats(messagesDir, coldDir)) {
    const files = []
    try {
      files.push(...fs.readdirSync(coldDir)
        .filter((f) => f.startsWith(chatKey + '.') && /\.\d{5}\.json$/.test(f))
        .sort())                                   // 字典序 == seq 升序（补零定长）
    } catch { /* 冷段读不了就只有热段 */ }
    files.push(chatKey + '.json')                  // 热段一定在最后（文件名不带 .NNNNN，不会混进上面那批）
    const today = []
    for (const f of files) {
      const isCold = /\.\d{5}\.json$/.test(f)
      const full = isCold ? path.join(coldDir, f) : path.join(messagesDir, f)
      // ★ 2026-10-24 冷分片剪枝（02.md 4.1.3）：冷段是归档数据，mtime 早于今天 0 点的
      //   分片不可能含今天的消息 —— 直接跳过打开与 JSON.parse。冷分片按天滚动归档，
      //   今天有新消息只会落进热段或今天新写/触碰的冷分片；stat 失败就照旧读（保守）。
      if (isCold) {
        try { if (fs.statSync(full).mtimeMs < dayStart) continue } catch { /* stat 不了就照旧读 */ }
      }
      const j = readJsonSafe(full)
      const list = Array.isArray(j?.messages) ? j.messages : []
      for (const m of list) {
        const ts = Number(m?.ts) || 0
        if (ts >= dayStart && ts <= now + 60000) today.push(m)
      }
    }
    if (today.length) perChat.push({ chatKey, count: today.length, latest: today[today.length - 1], today })
  }

  // 今天话最多的会话排前面；同样多比谁最后说话
  perChat.sort((a, b) => (b.count - a.count) || (b.latest.ts - a.latest.ts))

  const chats = []
  let dropped = 0
  let used = 0
  for (const c of perChat) {
    if (chats.length >= maxChats) { dropped += 1; continue }
    const picked = c.today.slice(-msgsPerChat)
    const lines = picked.map(chatLineOf)
    const cost = lines.join('\n').length + 40
    if (used + cost > maxTotalChars) { dropped += 1; continue }
    used += cost
    // 块内首末时刻（给日记素材标时间范围用；构造素材时按它重新排座次）
    const from = Number(picked[0]?.ts) || 0
    const to = Number(picked[picked.length - 1]?.ts) || 0
    chats.push({ chatKey: c.chatKey, label: chatLabel(c.chatKey), count: c.count, from, to, lines })
  }
  return { chats, dropped }
}

/**
 * 「世界与事件」插件的两样原料，软依赖：插件没装 / 没写世界观 / 账本文件不存在，
 * 都返回空串，日记照写——只是少了背景。
 */
export function readWorldMaterial(dataDir, cfg = {}, now = Date.now()) {
  const dayStart = localDayStart(now)
  const worldbookChars = Math.min(8000, Math.max(200, Number(cfg.worldbookChars) || 2000))

  const conf = readJsonSafe(path.join(dataDir, 'config.json'))
  const lsConf = conf?.skills?.['life-system']
  const ledger = readJsonSafe(path.join(dataDir, 'life-events.json'))
  // 插件在不在的判据：config 里有它的配置段，或落过账本文件。两个都没有视为没装。
  const installed = lsConf != null || ledger != null

  let worldbook = ''
  const raw = String(lsConf?.worldbook ?? '').trim()
  if (raw) {
    const marker = '…（世界观过长已节选）'
    worldbook = raw.length > worldbookChars
      ? raw.slice(0, Math.max(1, worldbookChars - marker.length - 1)) + marker
      : raw
  }

  const facts = []
  const map = ledger?.facts && typeof ledger.facts === 'object' ? ledger.facts : {}
  for (const entry of Object.values(map)) {
    const at = Number(entry?.at) || 0
    const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    // 只取今天记下的（账本自带半衰期，昨天的旧事不该进今天的日记）
    if (at >= dayStart && at <= now + 60000) {
      const d = new Date(at)
      facts.push({ at, line: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${text}` })
    }
  }
  facts.sort((a, b) => a.at - b.at)
  return { installed, worldbook, facts: facts.map((f) => f.line) }
}

/**
 * 矩阵庭院**今天寄回来的明信片**（软依赖）。
 *
 * 为什么要读它的存档、而不是反过来 import 它：
 *   矩阵庭院是 `skills/travel-whale` 下的**独立技能**，它只保证存档格式稳定
 *   （`album[]` + `cardDelivered{id: 送达时间}`，每张自带 `image` 绝对路径）。
 *   反向 import 会变成技能之间互相咬死；读 JSON 是两边都稳的接口
 *   —— sleep-mood 的 travel-sync 也是这么做的。
 *
 * 读不到就返回空数组，日记照写，只是没有配图。
 */
/**
 * 日记最多配几张明信片。
 * ⚠️ 用显式 `Number.isFinite` 判默认值：`Number(undefined) || 3` 这类写法会被
 *   `Number(null) === 0` 之类的坑吃掉合法 0（本项目已栽四次）。
 * 上限 6：加上日记正文图，不能超过空间单条说说的 9 张。
 */
export function diaryCardsMax(cfg = {}) {
  const raw = cfg.maxDiaryCards;
  // ⚠️ 必须先显式排除 null/undefined/'' —— `Number(null) === 0` 且 `Number.isFinite(0)` 为真，
  //    直接 Number() 会把"没配这一项"读成"配成了 0 张"（本项目已栽五次，见 MEMORY 通则第一条）。
  if (raw === null || raw === undefined || raw === '') return 3;
  const v = Number(raw);
  if (!Number.isFinite(v)) return 3;
  return Math.min(6, Math.max(0, Math.round(v)));
}

export function readTravelCards(dataDir, cfg = {}, now = Date.now()) {
  const dayStart = localDayStart(now);
  const conf = readJsonSafe(path.join(dataDir, 'config.json'));
  const tw = conf?.skills?.['travel-whale'] || {};
  // 「家」以 travel-whale 自己的 homeChatKey 为准；没配再退回本技能的 cardsFromChat
  const chatKey = String(tw.homeChatKey || cfg.cardsFromChat || '').trim();
  const file = chatKey
    ? path.join(dataDir, 'skills', 'travel-whale', 'chats',
        `${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`)
    : '';
  const st = file ? readJsonSafe(file) : null;
  const album = Array.isArray(st?.album) ? st.album : [];
  const delivered = st?.cardDelivered && typeof st.cardDelivered === 'object' ? st.cardDelivered : {};

  const all = [];
  for (const a of album) {
    const id = String(a?.id ?? '').trim();
    if (!id) continue;
    const at = Number(delivered[id]) || 0;
    if (!(at >= dayStart && at <= now + 60000)) continue;   // ★ 只取**今天真寄出去的**
    const image = String(a?.image ?? '').trim();
    all.push({
      id, at,
      spot: String(a?.spot ?? '').trim(),
      city: String(a?.city ?? '').trim(),
      country: String(a?.country ?? '').trim(),
      kind: String(a?.kind ?? '').trim(),
      rarity: String(a?.rarity ?? '').trim(),
      caption: String(a?.caption ?? '').trim(),
      thought: String(a?.thought ?? '').trim(),
      image,
      hasFile: !!(image && fs.existsSync(image))
    });
  }
  all.sort((a, b) => a.at - b.at);
  // 序号只发给**文件还在**的：免得模型挑到一张打不开的（相册里的旧图可能已被清理）
  let n = 0;
  for (const c of all) c.no = c.hasFile ? (n += 1) : 0;
  // ★ 2026-10-13：把 **trip 原样带出去**（不只 album）——
  //   日记素材一直只有"明信片"没有"这趟是谁陪着走的"，于是她写日记时会
  //   把旅伴当成一个**留在家里的人**（"要给那只小狐狸带点礼物"）。
  //   消费者：`travelContextLine()`（见下）。
  return {
    installed: st != null, chatKey, cards: all.filter((c) => c.hasFile),
    droppedMissing: all.length - n,
    trip: (st && st.trip) || null
  };
}

/**
 * 旅伴 id → 显示名 的**兜底表**（只为老存档准备）。
 *
 * ⚠️ 为什么不直接 import travel-whale 的 `state.js`：跨技能 import 会让"软依赖"变成硬依赖
 *   （qqzone 得能在没装 travel-whale 的机器上照常跑）。这里照抄 sleep-mood 的 travel-sync
 *   的做法：**新存档以 `trip.companionName` 为准**，老存档（2026-10-12 前出发的旅程
 *   没写这个字段）才用这张表兜底。id 是稳定的（改显示名只动 name 不动 id）。
 */
const COMPANION_NAMES = {
  fox: '黑发兽耳小狐狸',
  gpt: '小白龙',
  claude: '小书虫',
  gemini: '小猫咪',
  grok: '小魔王',
  kimi: '小月亮',
  qwen: '小折扇'
};

/** 取这趟的同行伙伴显示名；没有伙伴返回 ''。 */
function companionNameOfTrip(trip) {
  const written = String(trip?.companionName || '').trim();
  if (written) return written;
  return COMPANION_NAMES[String(trip?.companion || '').trim()] || '';
}

/**
 * ★ 日记素材里的「你此刻的处境」（2026-10-13 加）。
 *
 * 为什么必须有：日记是"总结这一天"，而这一天里**她一直在外面旅行**。
 *   素材里若只给明信片、不给"这趟是谁陪着走的"，她就会写出
 *   「要给那只小狐狸带点礼物」这种把旅伴当成留守者的句子 —— 实测踩过。
 *   ⚠️ 只陈述**事实**，不替她抒情；写不写进日记由她自己决定。
 */
export function travelContextLine(trip) {
  if (!trip || !trip.city) return '';
  const place = [String(trip.country || ''), String(trip.city || '')].filter(Boolean).join('·');
  const mate = companionNameOfTrip(trip);
  const spots = (Array.isArray(trip.spots) ? trip.spots : [])
    .map((s) => String((s && s.name) || '').trim()).filter(Boolean);
  const lines = [
    `【你此刻的处境】这一天你在外面旅行：${place}${trip.regionName ? `（${trip.regionName}）` : ''}。`
      + (mate ? `**同行的旅伴是「${mate}」，她这一整天都跟你在一起**（不是留在家里的人）。` : '这一趟你是一个人走的，没有旅伴。')
      + (spots.length ? `这趟去过：${spots.slice(0, 6).join('、')}。` : '')
      + '★ 写日记时如果提到旅行或旅伴，**请按这个事实写**，别写成"她在家等我"这种反过来的关系。'
  ];
  return lines.join('\n');
}

// ══ 「她的一天」：流水 → 筛选 → 回忆（2026-10-14）════════════════════════════════
//
// 用户口径：那些"和小狐狸在巴塞罗那躲雨"之类的随机事件**发生完就刷掉了**
//   （它们本来就是 `pickState()` 哈希现算的，任何地方都不落盘），于是
//   "开个目录把这些'发生'在她身上的事情记录下来，先走一遍模型调用让她想想哪些开心、
//    哪些不爽、哪些无聊，筛过之后再投给日志。"
//
// 素材三处（**全是从别人的存档/文件里只读**）：
//   ① 旅途瞬间 —— sleep-mood 写的 `<data>/sleep-mood-moments.json`（每 20 分钟一挡）
//   ② 在家瞬间 —— travel-whale 存档的 `state.homeLog`
//   ③ 心情事件 —— 同一份存档的 `state.moodEvents`（好事/坏事，一天几条）
//
// ★ **有图的那半边（明信片 / 大合照）不走这里**：它们本来就会进日记素材
//   （见 `readTravelCards`），而且 album 里每条都带她当时写的 `thought`
//   ⇒ 再"筛"一遍是重复劳动（用户拍板："有图的部分本来也会给到日志"）。
//
// 产物 `<data>/qqzone/memory.json` = **她自己筛过一遍的"回忆"**（按天）：
//   既投给日记（`buildDiaryDigest`），也是一份能长期留的资产 ——
//   素材只留 14 天（在各自的写入方那边裁），**回忆留 60 天**。
const MEMORY_FILE = 'memory.json';
/** sleep-mood 写的那份"旅途瞬间"（**别人的文件**，我们只读）。⚠️ 名字必须与那边 `MOMENTS_FILE` 一致。 */
const MOMENTS_FILE = 'sleep-mood-moments.json';
const MEMORY_KEEP_DAYS = 60;
/** 两次筛之间至少隔这么久（心跳 60 秒一次；一有新料就筛会把模型调用打满）。 */
const MEMORY_MIN_GAP_MS = 20 * 60 * 1000;
/** 状态池的挡位宽度，必须与 sleep-mood 的 `BUCKET_MS` / travel-whale 的 `HOME_ACT_BUCKET_MS` 一致。 */
const MOMENT_BUCKET_MS = 20 * 60 * 1000;
/** 一次喂给模型的上限（一天最多 144 条，正常情况用不到）。 */
const MEMORY_ITEM_MAX = 160;

/**
 * 心情事件 → 一句人话。
 *
 * ⚠️⚠️ `where` 这个字段**按 kind 分两种语义**（2026-10-14 用户实测抓到的坑）：
 *   · `place` —— **事发生在哪**（战斗 / 翻车 / 被丢到的世界 / 回到家的地方）
 *   · `from`  —— **特产的出处**（吃·送·种·收成记的是 `entry.city`／`plot.city`，
 *     也就是"这东西是从哪带回来的"）⇒ 绝不能说"**在霍比屯**把特产吃掉了"，
 *     那会读成"她此刻在霍比屯"（她当时其实在巴塞罗那）。
 * ⚠️ `by === 'mates'`：这条是**伙伴那趟**的事（不是她亲身遇到的）——
 *   话里必须点明，否则她会把它当成自己的经历写进日记。
 * ⚠️ 必须与 sleep-mood 的 `TRAVEL_EVENT_MOOD` 保持**同一批 kind**（探针有跨文件守卫）。
 */
const MOOD_EVENT_PHRASE = {
  'rare-card': { plain: '寄回一张稀有的明信片', where: 'place' },
  'rare-souvenir': { plain: '带回了一件稀有特产', where: 'place' },
  'home-photo': { plain: '在庭院里和大家拍了张大合照', where: null },
  // ★ 2026-10-15 补（§123 那批带出来的）：她在**家里**做完一件小事时推的那条心情事件
  //   （travel-whale 的 `refreshHomeAct` 落定时 `pushMoodEvent('home-act', …)`）。
  //   ⚠️ `where: null` —— 事发生在**庭院**，不是某个世界；写成地点会让她把这条读成
  //      "我此刻在那儿的家里"（同 `home-photo` 的纪律）。
  'home-act': { plain: '在庭院里做了一阵小事', where: null },
  'trip-home': { plain: '平平安安回到了家', where: 'place' },
  'battle-card': { plain: '遭遇了敌手', where: 'place' },
  crossover: { plain: '被丢到了一个完全陌生的世界', where: 'place' },
  flop: { plain: '那张明信片答非所问、翻了车', where: 'place' },
  'souvenir-eat': { plain: '把带回来的特产吃掉了', where: 'from', from: '吃掉了从「%s」带回来的特产' },
  'souvenir-gift': { plain: '把带回来的特产送给了别人', where: 'from', from: '把从「%s」带回来的特产送给了别人' },
  'souvenir-plant': { plain: '把特产种进了菜地', where: 'from', from: '把从「%s」带回来的特产种进了菜地' },
  'souvenir-harvest': { plain: '亲手种出了收成', where: 'from', from: '收了一茬从「%s」种下的东西' }
};

/**
 * 把一条心情事件说成人话（导出给探针用）。
 * @returns {string} 表里没有的 kind 返回 ''（不认 —— 同 sleep-mood 的过滤纪律）
 */
export function moodEventText(ev) {
  const spec = MOOD_EVENT_PHRASE[String(ev?.kind || '')];
  if (!spec) return '';
  const where = String(ev?.where || '').trim();
  let text = spec.plain;
  if (where && spec.where === 'place') {
    text = `${spec.plain}（${where}${ev?.foe ? `·${String(ev.foe)}` : ''}）`;
  } else if (where && spec.where === 'from') {
    text = String(spec.from || '').split('%s').join(where) || spec.plain;
  }
  return String(ev?.by || '') === 'mates' ? `【伙伴那趟】${text}` : text;
}

const clockOf = (ts) => {
  const d = new Date(Number(ts) || 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 她那个群的 travel-whale 存档（定位口径与 `readTravelCards` 完全一致）。 */
function travelStateOf(dataDir, cfg = {}) {
  const conf = readJsonSafe(path.join(dataDir, 'config.json'));
  const tw = conf?.skills?.['travel-whale'] || {};
  const chatKey = String(tw.homeChatKey || cfg.cardsFromChat || '').trim();
  if (!chatKey) return { chatKey: '', st: null };
  const file = path.join(dataDir, 'skills', 'travel-whale', 'chats',
    `${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
  return { chatKey, st: readJsonSafe(file) };
}

/**
 * 她**真被唤醒过**的那些挡位（`Set<挡位号>`）—— 这就是 `used` 的判据。
 *
 * 逻辑：那一挡（20 分钟）里这个群出现过她的发言（`self === true`）
 *   ⇒ 她被叫到了 ⇒ 集成系统那一轮就会把"她此刻在做什么"注进提示词 ⇒ 这条**被看见过**。
 *   （反过来，没人理她的那些挡位，那条状态只是"设定"，从没进过任何模型的上下文。）
 *
 * ⚠️ `data/messages/<key>.json` 可能十几 MB（主群 4.9 万条）⇒ **按 mtime 缓存**，
 *   别每次筛都重解析一遍。
 */
const selfBucketCache = new Map();
function selfSpeakBuckets(dataDir, chatKey) {
  const key = String(chatKey || '').trim();
  if (!key) return new Set();
  const file = path.join(dataDir, 'messages', `${key.replace(/[^a-z0-9_]/gi, '_')}.json`);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return new Set(); }
  const hit = selfBucketCache.get(file);
  if (hit && hit.mtime === mtime) return hit.buckets;
  const buckets = new Set();
  try {
    const raw = readJsonSafe(file);
    const list = Array.isArray(raw) ? raw : (raw?.messages || raw?.list || []);
    for (const m of list) {
      if (!m || m.self !== true) continue;
      const ts = Number(m.ts) || 0;
      if (ts > 0) buckets.add(Math.floor(ts / MOMENT_BUCKET_MS));
    }
  } catch { /* 读不到就当"没被唤醒过" —— 宁可少标，不要错标 */ }
  if (selfBucketCache.size > 8) selfBucketCache.clear();   // 缓存别无限涨（只会用到 1~2 个文件）
  selfBucketCache.set(file, { mtime, buckets });
  return buckets;
}

/**
 * 汇总**今天**发生在她身上的事（三处素材合一，按时间升序）。
 * 纯读，不写任何东西 —— 供筛选轮与探针用。
 * @returns {{items:Array, moments:number, home:number, events:number, usedCount:number}}
 */
export function readDayMaterial(dataDir, cfg = {}, now = Date.now()) {
  const dayStart = localDayStart(now);
  const inToday = (at) => at >= dayStart && at <= now + 60000;
  const items = [];

  // ① 旅途瞬间（sleep-mood 每 20 分钟记一条）
  let moments = 0;
  const mf = readJsonSafe(path.join(dataDir, MOMENTS_FILE));
  const bucketCache = new Map();
  const bucketOf = (key) => {
    if (!bucketCache.has(key)) bucketCache.set(key, selfSpeakBuckets(dataDir, key));
    return bucketCache.get(key);
  };
  for (const it of (Array.isArray(mf?.items) ? mf.items : [])) {
    const at = Number(it?.at) || 0;
    if (!inToday(at)) continue;
    const key = String(it.key || '');
    moments += 1;
    items.push({
      at, atClock: clockOf(at), kind: 'moment',
      text: [String(it.act || ''), String(it.detail || '')].filter(Boolean).join(' —— '),
      place: String(it.place || ''), mate: String(it.mate || ''),
      used: bucketOf(key).has(Math.floor(at / MOMENT_BUCKET_MS))
    });
  }

  // ② 在家瞬间 + ③ 心情事件（同一份 travel-whale 存档）
  let home = 0; let events = 0;
  const { chatKey, st } = travelStateOf(dataDir, cfg);
  if (st) {
    const hb = selfSpeakBuckets(dataDir, chatKey);
    for (const it of (Array.isArray(st.homeLog) ? st.homeLog : [])) {
      const at = Number(it?.at) || 0;
      if (!inToday(at)) continue;
      home += 1;
      items.push({
        at, atClock: clockOf(at), kind: 'home',
        text: [String(it.act || ''), String(it.detail || '')].filter(Boolean).join(' —— '),
        place: '', mate: String(it.mate || ''),
        used: hb.has(Math.floor(at / MOMENT_BUCKET_MS))
      });
    }
    for (const ev of (Array.isArray(st.moodEvents) ? st.moodEvents : [])) {
      const at = Number(ev?.at) || 0;
      if (!inToday(at)) continue;
      const text = moodEventText(ev);        // ⚠️ where 的语义按 kind 分两种，见 MOOD_EVENT_PHRASE
      if (!text) continue;                   // 表里没有的 kind ⇒ 不认（同 sleep-mood 的过滤纪律）
      events += 1;
      items.push({
        at, atClock: clockOf(at), kind: 'event',
        text,
        place: String(ev.where || ''), mate: '',
        // 事件本身就是"真发生了"（它写进存档就是为了结算心情），一律算被看见
        used: true
      });
    }
  }

  items.sort((a, b) => a.at - b.at);
  const clipped = items.length > MEMORY_ITEM_MAX ? items.slice(-MEMORY_ITEM_MAX) : items;
  return {
    items: clipped, moments, home, events,
    usedCount: clipped.filter((x) => x.used).length,
    dropped: items.length - clipped.length
  };
}

/** 拼"让她回想"的提示词。 */
export function buildMemoryAsk(items, { dayLabel = '' } = {}) {
  const lines = items.map((x) => {
    const bits = [`[${x.atClock}]`];
    if (!x.used) bits.push('（这一会儿没人理你）');
    bits.push(x.text);
    if (x.mate) bits.push(`（和${x.mate}一起）`);
    if (x.place && x.kind !== 'event') bits.push(`@${x.place}`);
    return bits.join(' ');
  });
  return [
    dayLabel ? `# ${dayLabel} 的原始记录` : '# 这一天的原始记录',
    '下面是你这一天**实际发生的事**，按时间排（每 20 分钟一条，很碎）。',
    lines.join('\n'),
    '',
    '# 你要做的事（还不用写日记）',
    '先替自己**回想一遍这一天**：哪些事现在想起来还有意思，哪些当时就不痛快，'
      + '哪些压根没什么可说的。想完再往下看。',
    '',
    '输出**严格 JSON**（除了 JSON 什么都别写，不要 markdown 代码块）：',
    '{',
    '  "rich": "rich" | "normal" | "thin",',
    '  "picks": [',
    '    { "at": "HH:MM", "what": "用自己的话说清那件事（别照抄原文）",',
    '      "feel": "你当时/现在的心情，一句你自己的话", "mood": "good" | "bad" | "flat" }',
    '  ],',
    '  "dull": "如果这一天大部分时间都平平淡淡，用一句话说说那种平淡是什么感觉"',
    '}',
    '',
    '挑选的规矩：',
    '· `picks` **3~6 条**，按时间排。**宁可少，不许凑数** —— 只挑你自己会想再讲一遍的。',
    '· **重复的只留一条**：同一种"赶路/躲雨/发呆"出现好几次，挑最有意思的那次。',
    '· 有起伏的优先（打赢打输、被丢到别处、吃到稀罕东西、送出去的东西、种出来什么）。',
    '· `mood` 就三档：`good` / `bad` / `flat` —— **"平淡"也是一档**，不用硬找情绪。',
    '· ★ 标了 `【伙伴那趟】` 的，是**伙伴们自己出去玩**时发生的事，**不是你亲身遇到的** ——',
    '  要么不挑它，要么挑的时候写清是"他们"（例如"听说小虫子他们在外面碰上了敌手"），'
      + '**绝不能写成你自己经历的**。',
    '· 如果这一天真没什么事，`rich` 就写 `"thin"`、`picks` 可以是空数组 —— **别编**。'
  ].join('\n');
}

/**
 * 解析模型给的回忆。**健壮优先**：它可能套 markdown 围栏、可能多话、可能给烂 JSON。
 * 解析不出来返回 null（调用方据此"这次不更新"，日记照写、只是少这一块）。
 */
export function parseMemory(text) {
  const t = String(text || '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  let j = null;
  try { j = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const rich = ['rich', 'normal', 'thin'].includes(String(j.rich)) ? String(j.rich) : 'normal';
  const picks = (Array.isArray(j.picks) ? j.picks : []).slice(0, 8).map((p) => ({
    at: String(p?.at ?? '').replace(/\[|\]/g, '').trim().slice(0, 8),
    what: String(p?.what ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    feel: String(p?.feel ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    mood: ['good', 'bad', 'flat'].includes(String(p?.mood)) ? String(p.mood) : 'flat'
  })).filter((p) => p.what);
  const dull = String(j.dull ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return { rich, picks, dull };
}

function memoryFilePath(dataDir) {
  return path.join(dataDir, SKILL_ID, MEMORY_FILE);
}

/** 读回忆（读不到给空壳）。 */
export function readMemoryFile(dataDir) {
  const j = readJsonSafe(memoryFilePath(dataDir));
  if (j && typeof j === 'object' && j.days && typeof j.days === 'object') return j;
  return { version: 1, days: {} };
}

function saveMemoryFile(dataDir, m) {
  const file = memoryFilePath(dataDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
    fs.renameSync(tmp, file);            // 原子替换（同 saveState 的做法）
    return true;
  } catch { return false; }
}

/** 取**今天**的回忆（没有返回 null）—— 日记素材用它。 */
export function readMemoryDigest(dataDir, now = Date.now()) {
  try { return readMemoryFile(dataDir).days[diaryDayKey(now)] || null; } catch { return null; }
}

/**
 * 筛选轮：读素材 → 让她"回想一遍" → 落盘成回忆。
 *
 * 触发（调用方负责）：① 后台心跳 —— 有**新素材**且距上次筛 ≥ `MEMORY_MIN_GAP_MS`；
 *   ② 写日记前兜底（`force`）。
 * **按天全量重筛**（不用游标）：当天的素材有界（~72 条瞬间 + 几条事件），
 *   重筛一次很便宜，而且幂等 —— 比"增量游标"少一堆状态。
 * @returns {{ok:boolean, why?:string, picks?:number, rich?:string}}
 */
export async function refreshMemoryDigest(cfg = {}, now = Date.now(), { force = false } = {}) {
  const dir = dataDir();
  const mat = readDayMaterial(dir, cfg, now);
  if (!mat.items.length) return { ok: false, why: 'no-items' };

  const day = diaryDayKey(now);
  const mem = readMemoryFile(dir);
  const cur = mem.days[day];
  const newest = mat.items[mat.items.length - 1].at;
  if (!force && cur) {
    if (Number(cur.newestItemAt) >= newest) return { ok: false, why: 'no-new' };
    if (now - Number(cur.at) < MEMORY_MIN_GAP_MS) return { ok: false, why: 'too-soon' };
  }

  const d = new Date(now);
  const dayLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ask = buildMemoryAsk(mat.items, { dayLabel });
  // ⚠️ 预算要**跟写日记一样宽**（默认 8000）：本机默认是思考型模型，`maxTokens` 给小了
  //   会被 reasoning 吃光 ⇒ 返回**空串**。实测给 2000 就是空的（日记那边早有同一条注释，
  //   见 runAutoDiary 的"模型返回空"）。要单独调就配 `memoryModelMaxTokens`。
  const budget = Math.min(16000, Math.max(1000,
    Math.round(numOr(cfg.memoryModelMaxTokens, numOr(cfg.diaryModelMaxTokens, 8000)))));
  let text = '';
  try {
    const { chatCompletion } = await import('../../src/llm.js');
    const r = await chatCompletion({
      messages: [{ role: 'user', content: ask }],
      temperature: 0.6,
      maxTokens: budget
    });
    text = String(r?.message?.content || '').trim();
  } catch (e) {
    log?.(`[qqzone] 回想失败（${e?.message ?? e}）—— 日记照写，只是少这一块`);
    return { ok: false, why: 'llm-error' };
  }
  if (!text) {
    log?.(`[qqzone] 回想：模型返回空（预算 ${budget} 可能被 reasoning 吃光了，可调 memoryModelMaxTokens）`);
    return { ok: false, why: 'empty' };
  }
  const parsed = parseMemory(text);
  if (!parsed) {
    log?.(`[qqzone] 回想：模型没给出可解析的 JSON（开头 80 字：${text.slice(0, 80)}）`);
    return { ok: false, why: 'bad-json' };
  }

  mem.days[day] = {
    at: now, day, newestItemAt: newest,
    items: mat.items.length, usedCount: mat.usedCount,
    counts: { moments: mat.moments, home: mat.home, events: mat.events },
    rich: parsed.rich, picks: parsed.picks, dull: parsed.dull
  };
  // 保留期（回忆是长期资产，但也不能无限涨）
  const cut = diaryDayKey(now - MEMORY_KEEP_DAYS * 86400000);
  for (const k of Object.keys(mem.days)) if (String(k) < cut) delete mem.days[k];
  saveMemoryFile(dir, mem);

  // ★★ 2026-10-14：把筛过的回忆**接进长期记忆库**（本体分支 `bot:self`）。
  //   为什么是这一支：「她的一天」记的是"关于我自己的事"，正是本体语义。
  //   它带来两条天然行为 —— 正好是用户要的"这就是旅行"：
  //     · 不提就想不起来：预取（prefetch）按 chatKey 过滤，群里聊天**不会**自动注入本体块；
  //     · 提起能想起来：memory_search 不填 chatKey ＝ **全库检索**，一搜就命中。
  //   ⚠️ 必须在**宿主进程内**写（同一个 getMemory() 单例）—— 外部脚本改 index.json
  //      会被宿主内存里持有的那份索引覆盖掉。
  //   ⚠️ 失败绝不影响日记：回忆已落盘，这只是它的一个下游。
  let lt = null;
  try { lt = await writePicksToLongterm(parsed.picks, day, now); } catch { /* 内部已兜底 */ }

  log?.(`[qqzone] 回想已更新：${day} · ${mat.items.length} 条素材（被看见 ${mat.usedCount} 条）`
    + ` → 挑出 ${parsed.picks.length} 件 · 料：${parsed.rich}`
    + (lt ? ` · 长期记忆 ${lt.written}/${lt.total} 条` : ''));
  return { ok: true, day, picks: parsed.picks.length, rich: parsed.rich, longterm: lt };
}

/** 本体记忆分支的会话键 —— 与记忆插件（mem-layered）的 `bot:self` 分片一致。 */
const SELF_CHAT_KEY = 'bot:self'
/**
 * 宿主 API 引用（在 setup 里存下来）。
 * 写长期记忆要走 `api.capability('memory.write-note', …)` 这条**软依赖**通道 ——
 * 它只能在 setup 拿到的那个 api 对象上调用，而调用点（日记/补写）在模块作用域里。
 */
let hostApi = null;

/**
 * 「HH:MM」+ 哪一天 → 毫秒时间戳；解析不出来就用 fallback。
 * ⚠️ 显式判空：`Number('') === 0` 会把"没给时间"变成 1970（通则：别用 `||` 吞 0）。
 */
function pickTsOf(day, at, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  if (!m) return fallback;
  const [y, mo, d] = String(day).split('-').map((x) => Number(x));
  const t = new Date(y, mo - 1, d, Number(m[1]), Number(m[2]), 0, 0).getTime();
  return Number.isFinite(t) ? t : fallback;
}

/**
 * 把一天的回忆**逐条**写进长期记忆库（本体分支）。
 *
 * 入口＝宿主能力 `memory.write-note`（本机由 plugins/mem-layered 提供）。
 *
 * ⚠️ 2026-10-21 修：这里原先是**直接 import 核心的记忆运行时模块**拿写入函数
 *   （`addMemoryNote`）。那条路在"向量记忆退役"时随整个 `src/memory/` 目录一起被
 *   删掉了，于是**每天写库都失败**，日志里只剩一句"拿不到记忆核心" —— 而回忆本身
 *   早已落盘，所以表面上一切正常，只有长期记忆库一直不增长。
 *   改成软依赖（能力 `memory.write-note`）之后：记忆插件没装 / 没开 / 版本旧
 *   ⇒ 照旧降级（打一条日志 + 跳过），**绝不抛、绝不打断日记流程**
 *   （日记才是主产物，记忆是下游）。
 *
 * 粒度＝**一事一条**（不是一天一条），两条理由：
 *   ① 用户举的例子本身就是单条事件（"和小狐狸在巴塞罗那躲雨"）；
 *   ② 块的关键词上限是 **16 个 bigram**（见 mem-layered 的 Consolidator.addNote）⇒
 *      长正文只有前半段能被**关键词**命中，短句才能整句覆盖。
 *
 * 幂等：块 id ＝ `note_bot_self_<when>`，`when` 取事件本身的时刻
 *   ⇒ 同一天重筛、热载补写、隔天再跑 —— 都只**覆盖同一块**，不会堆积。
 *   （这条性质由 mem-layered 的 addNote 保证，本函数不需要自己去重。）
 *
 * @returns {Promise<{ok:boolean, written:number, total:number, vector:number, why?:string}>}
 *   vector 恒为 0：向量记忆已退役，这个字段只为兼容既有消费方
 *   （index.js 的日志、backfill 的累加）而保留。
 */
async function writePicksToLongterm(picks, day, now) {
  const list = Array.isArray(picks) ? picks.filter((p) => p && p.what) : []
  if (!list.length) return { ok: false, why: 'no-picks', written: 0, total: 0, vector: 0 }

  const capabilityOf = hostApi && typeof hostApi.capability === 'function' ? hostApi.capability : null
  // hasCapability 是宿主给的"有没有人提供这个能力"的同步问法。没有它时（老宿主）
  // 就把"第一次调用返回 undefined"当成同一个结论，见下面的 lost 分支。
  const hasCap = capabilityOf
    ? (typeof hostApi.hasCapability === 'function' ? hostApi.hasCapability('memory.write-note') : true)
    : false
  if (!hasCap) {
    log?.('[qqzone] 长期记忆：记忆插件未提供写入能力 —— 回忆仍已落盘，跳过这一步')
    return { ok: false, why: 'no-capability', written: 0, total: list.length, vector: 0 }
  }

  let written = 0
  let lost = false
  for (const p of list) {
    try {
      const when = pickTsOf(day, p.at, now)
      // 感受放括号里紧跟叙述；关键词按出现顺序取前 16 个 ⇒ 叙述（含地名/人名）
      // 在最前，可检索的词优先保住。
      const text = p.feel ? `${p.what}（${p.feel}）` : String(p.what)
      // ★★ 必须显式给 importance：块的 msgCount 只有 1，不给就落回 0.7 以下的
      //   派生值；而记忆强度直接参与衰减与排序。0.7 是"她自己的经历比群聊琐事
      //   值得记"的分量，又不去压满分组块。
      const r = await capabilityOf('memory.write-note', {
        chatKey: SELF_CHAT_KEY, text, when, who: '我', importance: 0.7
      })
      if (r && r.ok) { written += 1; continue }
      // undefined = 宿主侧这条能力上没有可用提供者（插件被关掉/卸载）
      if (r == null) { lost = true; break }
      log?.(`[qqzone] 长期记忆：这一条没写进（${r.error || '未知原因'}）· ${String(p.what).slice(0, 30)}`)
    } catch (e) {
      log?.(`[qqzone] 长期记忆：单条写入异常（${e?.message ?? e}）`)
    }
  }
  if (lost && !written) {
    log?.('[qqzone] 长期记忆：记忆插件未提供写入能力 —— 回忆仍已落盘，跳过这一步')
    return { ok: false, why: 'no-capability', written: 0, total: list.length, vector: 0 }
  }
  return { ok: written > 0, written, total: list.length, vector: 0 }
}

/**
 * 补写：把**已经攒在 memory.json 里**的回忆接进长期记忆库。
 * 用途＝热载/重启后立刻生效（否则要等下一次"有新素材"才触发重筛）。
 * 幂等（见 writePicksToLongterm）⇒ 重复调用只是覆盖，安全。
 */
async function backfillLongtermMemory(days = 2) {
  try {
    const dir = dataDir();
    const m = readMemoryFile(dir);
    const keys = Object.keys(m.days || {}).sort().slice(-Math.max(1, Number(days) || 2));
    let written = 0, total = 0;
    for (const k of keys) {
      const d = m.days[k];
      if (!d || !Array.isArray(d.picks) || !d.picks.length) continue;
      const dayEnd = new Date(`${k}T23:59:00`).getTime();
      const r = await writePicksToLongterm(d.picks, k, Number.isFinite(dayEnd) ? dayEnd : Date.now());
      written += r.written; total += r.total;
    }
    return { written, total, days: keys.length };
  } catch (e) {
    log?.(`[qqzone] 长期记忆补写跳过（${e?.message ?? e}）`);
    return { written: 0, total: 0, days: 0 };
  }
}

/** 明信片图片允许的根目录 —— 只许读自己技能目录里的图，不接受任意路径。 */
function travelPhotosRoot(dataDir) {
  return path.join(dataDir, 'skills', 'travel-whale', 'photos');
}

/**
 * 把模型挑的 `pics` 解析成本地图片字节。
 * 接受两种写法：**序号**（`"1"`/`1`，对应素材里的「#1」）与**卡片 id**（`pc_xxx`）。
 *
 * 原则：**一张都解析不出来不报错**，返回空数组 —— 配图是锦上添花，
 * 不能因为它毁掉整篇日记（和"特产兜底"同一条纪律）。
 */
export function resolveDiaryPics(dataDir, picks, cards, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const wanted = Array.isArray(picks) ? picks : (picks == null || picks === '' ? [] : [picks]);
  const root = path.resolve(travelPhotosRoot(dataDir));
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const byNo = new Map();
  const byId = new Map();
  for (const c of cards || []) {
    if (c.no) byNo.set(String(c.no), c);
    byId.set(String(c.id), c);
  }
  const picked = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of wanted) {
    const key = String(raw ?? '').trim().replace(/^#/, '');
    if (!key) continue;
    const card = byNo.get(key) || byId.get(key);
    if (!card) { skipped.push(`「${key}」不在今天的明信片里`); continue; }
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    try {
      const real = fs.realpathSync(card.image);
      if (!(norm(real) === norm(root) || norm(real).startsWith(norm(root) + path.sep))) {
        skipped.push(`#${card.no} 不在明信片目录里`);
        continue;
      }
      const buf = fs.readFileSync(real);
      if (!buf.length) { skipped.push(`#${card.no} 是空文件`); continue; }
      if (buf.length > maxBytes) { skipped.push(`#${card.no} 超过 ${(maxBytes / 1048576).toFixed(0)}MB`); continue; }
      const kind = imageKindOf(buf);
      if (!kind) { skipped.push(`#${card.no} 不是空间认的图片格式`); continue; }
      picked.push({ id: card.id, no: card.no, spot: card.spot, city: card.city, buf, kind });
    } catch (e) {
      skipped.push(`#${card.no || key} 读不出来（${String(e?.message ?? e).slice(0, 40)}）`);
    }
  }
  return { picked, skipped };
}

export function buildDiaryDigest({ chats, world, travelCards, dropped, memory = null, bili = null, now = Date.now() }) {
  const d = new Date(now)
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const p2 = (x) => String(x).padStart(2, '0')
  const dateLabel = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${weeks[d.getDay()]}`
  const nowClock = `${p2(d.getHours())}:${p2(d.getMinutes())}`

  const out = []
  out.push(`【日记素材 · ${dateLabel}】`)
  // ★ 「现在几点」必须给：素材窗口是自然日 00:00→此刻，不加这个锚点，模型看到
  //   深夜的对话就会默认"整篇是夜里写的"，把凌晨的事写成"晚上"、结尾补一句"明天再说"
  //   （2026-10-12 实锤：00:03 的跑团被写成"晚上在韦兰婶店里查怪事"）。
  out.push(`【现在】${nowClock}（${timeOfDay(d.getHours())}）· 素材覆盖 00:00 → 此刻，日记写到此刻为止`)
  out.push('（这是给你写日记用的原料，不是日记本身。写完调 qqzone__post_diary 发出。）')
  out.push('')
  // ★★ 2026-10-17（用户口径）：主线**不再只是旅行** ——
  //   「【旅行是你生活的主线，群聊是你生活的重要组成部分】」，成文约 **7 : 3**。
  //   ⚠️ 2026-10-15 那版把主线定成"旅行与同伴"、并把聊天写成"别当主体"，
  //     实测**矫枉过正**：群聊被彻底摘掉，日记成了纯游记。
  //     根因是素材比例（当时聊天 6000 字 vs 旅行几百字）——
  //     所以这次**先收紧素材**（见 collectTodayMessages 的默认值），再把两边都摆进主线区。
  const tcMain = travelCards && typeof travelCards === 'object' ? travelCards : null;
  const tripMain = tcMain && tcMain.trip ? tcMain.trip : null;
  // ★★ 2026-10-23（用户口径）：比例从「七成旅行 / 三成聊天」改成
  //   **一半旅行 · 四分之一 B站 · 四分之一 聊天**。
  //   为什么加 B站：日记原来只有"路上"和"群里"两个窗口，
  //   而她一天里真实花时间的地方还有第三块 —— 她看了什么、为什么记住那句。
  //   ⚠️ 没出门那天，空出来的那一半给"庭院"，比例保持 1/2 : 1/4 : 1/4。
  const hasBili = Array.isArray(bili) && bili.length > 0;
  const biliWord = hasBili
    ? '**四分之一写你在B站刷到的**（看了什么、哪句让你停了一下）'
    : '**四分之一留给`你自己的想法`**（B站今天没素材，就把那点笔墨给自己）';
  if (tripMain) {
    const who = String(tripMain.companionName || '').trim();
    // ⚠️ 地点与同伴**不在这里重复**（下一段的 `travelContextLine` 会正式声明）。
    out.push('【今天的主线】**这一天是三块拼起来的：**'
      + '**一半写这一趟**：路上看到什么、遇到谁、心里怎么想'
      + (who ? `，**尤其是你和同行的 TA（${who}）之间**` : '')
      + '；' + biliWord + '；'
      + '**四分之一写群里的对话** —— 谁说了什么、你怎么接、哪句话让你记住了。');
  } else {
    out.push('【今天的主线 · 在庭院】你今天没有出门 —— '
      + '**一半写庭院里的这一天**（怎么过的、身边有谁、和 TA 之间发生了什么），'
      + biliWord + '；'
      + '**四分之一写群里的对话**。');
  }
  out.push('')
  // ★★ 2026-10-15（用户口径）：【世界】和【近况账本】**从最前面挪到最后**（见下面的"背景"段）。
  //   它们排在开头，等于告诉模型"这篇日记要围绕世界观和作息写" —— 而这两样都只是**氛围**。
  const tc = travelCards && typeof travelCards === 'object' ? travelCards : null;
  // ★ 2026-10-13：先声明「这一天你在外面、身边是谁」，**再**摆明信片。
  //   否则素材里只有图、没有关系 —— 她会把旅伴写成"留在家里等我的人"
  //   （实测：日记里出现「要给那只小狐狸带点礼物」，而小狐狸其实一路都在她身边）。
  if (tc && tc.trip) {
    const ctxLine = travelContextLine(tc.trip);
    if (ctxLine) { out.push(ctxLine); out.push(''); }
  }
  if (tc && tc.installed !== false) {
    const list = Array.isArray(tc.cards) ? tc.cards : [];
    if (list.length) {
      out.push(`【今天的明信片（你旅途中真寄回来的，共 ${list.length} 张）】`);
      out.push('这些是**你自己**今天寄回来的明信片，可以拿来当日记配图。下面是摘要（你看不到图本身，就靠这些挑）：');
      for (const c of list) {
        const where = [c.country, c.city].filter(Boolean).join('·');
        const bits = [
          where ? `📍${where}` : '',
          c.spot ? `景点：${c.spot}` : '',
          c.rarity === 'rare' ? '稀有' : ''
        ].filter(Boolean).join(' · ');
        // ★ 2026-10-15：补上**寄出时刻** —— 主线要按时间线写，没有时间就拼不出"这一天怎么过的"
        //   （素材里 `at` 一直有，只是没显示出来）。
        const tm = c.at ? `${p2(new Date(c.at).getHours())}:${p2(new Date(c.at).getMinutes())}` : '';
        out.push(`#${c.no}${tm ? ` ${tm}` : ''}${bits ? ' ' + bits : ''}${c.caption ? ` ／ 当时写的：「${c.caption}」` : ''}`);
      }
      out.push('');
    } else {
      out.push('【今天的明信片】今天没有寄回来的明信片（没出门，或还没到寄卡的点）——日记别配图。');
      out.push('');
    }
  }
  // ★ 2026-10-23：B站那一段（用户口径：日记 1/4 写这个）
  if (hasBili) {
    out.push(`【今天在B站（${bili.length} 条，都是你自己留下的）】`);
    for (const b of bili) {
      const tm = b.at ? `${p2(new Date(b.at).getHours())}:${p2(new Date(b.at).getMinutes())}` : '';
      const head = b.kind === 'share' ? '分享时写的' : '当天的小结';
      out.push(`${tm ? tm + ' ' : ''}${head}：${String(b.text || '').replace(/\s+/g, ' ').slice(0, 260)}`);
    }
    out.push('（这些是你看过、并且**自己写下过感想**的东西 —— 写日记时可以提，但不用全提，挑你真记住的那条。）');
    out.push('');
  }

  // ★★ 2026-10-14「今天发生的事」：**她自己筛过一遍**的版本（见 `refreshMemoryDigest`）。
  //   为什么需要它：这一天她在路上，发生了上百件小事（躲雨、赶路、遇敌手、收成…），
  //   但日记素材里原来**一件都没有** —— 于是日记只能写"聊天里提过的那点东西"。
  //   ⚠️ 有图的那半边不在这里：它在下面的【今天的明信片】（那边每条都带她当时写的 `thought`）。
  //   ⚠️ 素材空（那天真没事 / 回想还没跑过）⇒ 这一块不出现，日记照写。
  if (memory && ((memory.picks && memory.picks.length) || memory.dull)) {
    out.push('【今天发生的事（你自己回想过的）】');
    if (memory.picks && memory.picks.length) {
      out.push(memory.picks.map((p) => `- ${p.at ? `${p.at} ` : ''}${p.what}`
        + (p.feel ? `（当时心里：${p.feel}）` : '')
        + (p.mood === 'bad' ? ' 〔不痛快〕' : (p.mood === 'flat' ? ' 〔就是平淡〕' : ''))).join('\n'));
    } else {
      out.push('（这一天没什么值得单拎出来的事 —— **别硬编**，写心境、写天气、写你在想什么就好）');
    }
    if (memory.dull) out.push(`（这一天的底色：${memory.dull}）`);
    out.push('★ 这是**你自己**挑出来的，不是流水账 —— 写日记时顺着这些展开，**别再逐条复述**。');
    out.push('');
  }
  // ════════════ ★★ 以下是**背景**，不是日记素材（2026-10-15 用户口径）════════════
  //   为什么单开一段、还带分隔线：主线和背景混在一起摆，模型会**平均用力** ——
  //   于是日记变成"世界观 + 作息 + 聊天记录"的拼盘。标成"背景"之后，
  //   它们只在需要时点一句，不再抢主线的分量。
  // ★★ 2026-10-17（用户口径）：群聊**从"背景"提到主线区** —— 它要占约三成，
  //   而分隔线下面是"氛围参考、别当素材写"，留在那里与口径直接矛盾。
  if (chats.length) {
    out.push(`【今天群里的对话（${chats.length} 个会话${dropped ? `，另有 ${dropped} 个没放进来` : ''}）】`);
    out.push('这些是今天群里聊到的片段。**群聊是你生活的重要组成部分** —— 日记里大约占三成：'
      + '挑两三处你真正记得的写（谁说了什么、你当时怎么想、哪句话没接住），'
      + '**别逐句复述、也别整段搬进日记**。');
    // ★ 按**时间先后**摆块（不是按句数）—— 日记要的是一天的时间线。
    const startOf = (c) => {
      const a = Number(c?.from)
      if (Number.isFinite(a) && a > 0) return a
      const b = Number(c?.to)
      return Number.isFinite(b) && b > 0 ? b : 0
    }
    const ordered = [...chats].sort((a, b) => startOf(a) - startOf(b))
    for (const c of ordered) {
      const span = chatSpanLabel(c)
      const pickNote = c.count > c.lines.length ? `，取 ${c.lines.length} 句` : ''
      out.push(`── ${c.label}（${span} · 共 ${c.count} 句${pickNote}）──`)
      out.push(c.lines.join('\n'))
    }
    out.push('')
  } else {
    out.push('【今天群里的对话】今天群里很安静；日记就写你的日程和心境。')
    out.push('')
  }
  // ════════════ ★★ 以下是**背景**（2026-10-15 用户口径）════════════
  out.push('════════ 以下是背景（氛围参考，**别当素材写**）════════');
  out.push('');
  if (world.installed === false) {
    // 没装「世界与事件」：两段原料都没有，明说跳过，别让模型对着占位文案编世界观
    out.push('【你所处的世界】（未装「世界与事件」插件，世界观与近况账本这次跳过——别编世界观，就写普通日常）')
    out.push('')
  } else {
    out.push('【你所处的世界（世界观节选，用来对齐"你在哪、今天是什么日子"）】')
    out.push(world.worldbook || '（「世界与事件」插件里还没有世界观文本）')
    out.push('')
    out.push('【你的近况账本（今天）】')
    out.push(world.facts.length ? world.facts.map((l) => `- ${l}`).join('\n') : '（今天账本还没有新条目）')
    out.push('')
  }
  return out.join('\n')
}

/**
 * 日记的目标字数区间。
 * ⚠️ 又一处 `Number(null) === 0` 的猎场：`Number(cfg.x) || 默认` 会把"没配"读成"配成 0"，
 *    所以这里显式排除 null/undefined/''（本项目已栽五次，见 MEMORY 通则第一条）。
 */
export function diaryLenRange(cfg = {}) {
  const pick = (raw, dflt) => {
    if (raw === null || raw === undefined || raw === '') return dflt;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : dflt;
  };
  const min = pick(cfg.diaryTargetMin, 1500);
  const max = Math.max(min, pick(cfg.diaryTargetMax, 2000));
  return { min, max };
}

/**
 * 日记写作口径（尾注）。
 * ★ 抽成函数（依赖字数额度）+ 导出：探针与试跑能拿到**与线上完全同一份**文案，不会各写一遍而漂移。
 *
 * ★★ 这里必须**显式解除**"说短话"的约束：宿主 `toolProtocol.8`「不要小作文」、
 *    `qqSceneRules`「回复保持简短」、人设「默认 1~10 字」三条都在推她写短，
 *    而日记侧原先一个字都没提长度 ⇒ 实测日记只有 ~540 字（2026-10-12 量过）。
 */
/**
 * 日记写作口径（尾注）。
 * ★ 抽成函数（依赖字数额度）+ 导出：探针与试跑能拿到**与线上完全同一份**文案，不会各写一遍而漂移。
 *
 * ★★ 这里必须**显式解除**"说短话"的约束：宿主 `toolProtocol.8`「不要小作文」、
 *    `qqSceneRules`「回复保持简短」、人设「默认 1~10 字」三条都在推她写短，
 *    而日记侧原先一个字都没提长度 ⇒ 实测日记只有 ~540 字（2026-10-12 量过）。
 *
 * ★★ 2026-10-17（用户口径）：**旅行 7 : 群聊 3**；并**删掉段数指标**
 *    （"分 8~12 段、每段 120~250 字"正是"公式感"的主因 —— 它逼出等长段落和"每段收个尾"）。
 *    `memory` 只用于"今天料少 ⇒ 别凑字数"这一条（原在 runAutoDiary 里算，现并到这里）。
 */
export function diaryGuidance(cfg = {}, memory = null) {
  const { min, max } = diaryLenRange(cfg);
  const thin = memory?.rich === 'thin';
  const lo = thin ? Math.max(300, Math.round(min * 0.45)) : min;
  return '\n\n写日记的口径：第一人称、你自己的口气；**不是流水账**（别把一天按小时抄一遍）。'
    + '别人的原话不要原文照搬（空间全体好友可见），概括或用昵称。'
    + '\n★★ **结构（很重要）：旅行是你生活的主线（约七成），群聊是你生活的重要组成部分（约三成）。**'
    + '挑今天真正有味道的两三件事写：旅行的展开写细，群里那两三处点到就够 —— 不必把每一段时间都交代一遍。'
    + `\n★★ **篇幅**：${lo}~${max} 字。`
    + (thin ? '（今天本来就没多少事 —— **别凑字数**，写心境、写你在想什么也行。）' : '有料就写长，没料写短一点也合格。')
    + '\n★★ 群里那套「默认 1~10 字」「不要小作文」「回复保持简短」**写日记时一律不适用**。'
    + '\n★ 时间上要诚实：00:00–05:00 的事就是凌晨／后半夜，别写成"晚上"；日记写到【现在】那个时刻为止。'
    + '\n★★ **别写成这样**：'
    + '① 每段都是"时间 + 干了啥 + 一句感悟"（那是流水账，不是日记）；'
    + '② 每段结尾都升华一句（一篇里最多一次）；'
    + '③ 开头"今天……"、结尾"不知道就不知道吧"这类收束句（一篇最多一处）；'
    + '④ 什么都写全（**日记不是账本，今天可以交代不完整**）。'
    + '\n★ 段落长短**不必均匀** —— 允许有的段只有两句。';
}
const DIARY_POST_NOTE = '写完调 qqzone__post_diary：text=日记全文，title=如「我的日记 · 10月4日」，caption=说说正文的一句话。';

/**
 * 拼出完整的「日记素材 + 写作口径」。
 * ★ 抽成导出函数（而不是塞在 doCollectDiary 里）：探针与试跑可以直接拿到
 *   **与线上完全同一份**文案，不会因为各写一遍而漂移。
 */
/**
 * 读 bili-whale 今天留下了什么（2026-10-23，用户口径：日记 1/4 写 B站）。
 *
 * 取两样，都是**她自己写的**：
 *   · `db.diaries[*]` 里 `date` == 今天的 → 她看完这些视频后写的那段
 *   · `db.quota[]` 里今天发出的分享 → `note` 是她当时的分享语
 *
 * ⚠️ **不取 `db.events`**：实测 200 条里 176 条是 `setup`（插件加载日志），
 *    混进来会污染素材。
 * ⚠️ 读不到 / 文件不存在 / 格式变了 ⇒ 返回空数组，日记照写（不因为B站挂了就写不成）。
 */
export function readBiliMaterial(dir, cfg = {}, now = Date.now()) {
  const out = [];
  try {
    const p = path.join(dir, 'plugin-data', 'bili-whale', 'storage.json');
    if (!fs.existsSync(p)) return out;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const db = (j && j.db) || {};
    const today = diaryDayKey(now);
    // ① 今天的日记
    const diaries = db.diaries && typeof db.diaries === 'object' ? db.diaries : {};
    for (const list of Object.values(diaries)) {
      if (!Array.isArray(list)) continue;
      for (const d of list) {
        if (!d) continue;
        const date = String(d.date || '');
        const text = String(d.text || '').trim();
        if (!text || date !== today) continue;
        out.push({ at: Number(d.at) || now, kind: 'diary', text: text.slice(0, 600) });
      }
    }
    // ② 今天的分享（note 是她自己写的）
    const dayStart = (() => {
      const t = new Date(now); t.setHours(0, 0, 0, 0); return t.getTime();
    })();
    for (const q of (Array.isArray(db.quota) ? db.quota : [])) {
      if (!q) continue;
      const at = Number(q.at) || 0;
      const note = String(q.note || '').trim();
      if (!at || at < dayStart || !note) continue;
      out.push({ at, kind: 'share', text: note.slice(0, 200), bvid: String(q.bvid || '') });
    }
    out.sort((a, b) => a.at - b.at);
    return out.slice(0, 6);
  } catch {
    return out;
  }
}

export function diaryBriefing(cfg = {}, now = Date.now()) {
  const messagesDir = path.join(dataDir(), 'messages');
  const coldDir = path.join(dataDir(), 'messages-cold');
  const { chats, dropped } = collectTodayMessages(messagesDir, coldDir, cfg, now);
  const world = readWorldMaterial(dataDir(), cfg, now);
  const travelCards = cfg.useDiaryCards === false
    ? { installed: false, chatKey: '', cards: [] }
    : readTravelCards(dataDir(), cfg, now);
  const pickMax = diaryCardsMax(cfg);
  const cardNote = travelCards.cards.length && pickMax > 0
    ? `★ 配图：今天有 ${travelCards.cards.length} 张明信片，从中挑**最多 ${Math.min(pickMax, travelCards.cards.length)} 张**最配这篇日记的，`
      + '把编号写进 qqzone__post_diary 的 pics（例如 pics:["1","3"]）。**挑不出就留空，不要硬凑、也不要自己编配图。**'
    : '';
  // ★ 2026-10-14「今天发生的事」：读她自己筛过的那份回忆（没有就是 null ⇒ 素材里不出现这一块）
  const memory = readMemoryDigest(dataDir(), now);
  // ★ 2026-10-23：B站那一路（她今天看了什么、写了什么分享语）
  const bili = cfg.useDiaryBili === false ? [] : readBiliMaterial(dataDir(), cfg, now);
  return {
    text: buildDiaryDigest({ chats, world, travelCards, dropped, memory, bili, now })
      + diaryGuidance(cfg, memory) + cardNote + DIARY_POST_NOTE,
    stats: {
      chats: chats.length, facts: world.facts.length, cards: travelCards.cards.length, dropped,
      bili: bili.length,
      pickMax, memory: (memory && memory.picks ? memory.picks.length : 0), rich: memory?.rich || ''
    }
  };
}

async function doCollectDiary(ctx) {
  const deny = gateByContext(ctx)
  if (deny) return { content: deny, isError: true }
  const cfg = cfgOf()
  const { text, stats } = diaryBriefing(cfg)
  dbg('qqzone__collect_diary', true, `${stats.chats} 会话，账本 ${stats.facts} 条，明信片 ${stats.cards} 张`)
  return { content: text }
}

/** 软依赖加载「长文排版图」的渲染管线；找不到给 null，调用方给人话错误。 */
export async function loadRenderer() {
  if (diaryHooks.renderer) return diaryHooks.renderer
  const candidates = [
    path.join(HERE, '..', 'text-image', 'index.js'),
    path.join(HERE, '..', '..', 'skills', 'text-image', 'index.js')
  ]
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod.renderPages === 'function') return mod
    } catch { /* 换下一个候选路径 */ }
  }
  return null
}

// 测试注入点：authImpl 换掉 acquireCookies，renderer 换掉排版图模块。生产路径完全不碰。
export const diaryHooks = { authImpl: null, renderer: null }

function cleanDiaryText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > maxLen ? t.slice(0, maxLen) : t
}

async function doPostDiary(text, title, caption, pics, ctx) {
  const deny = gateByContext(ctx)
  if (deny) return { content: deny, isError: true }
  const cfg = cfgOf()
  const diary = cleanDiaryText(text, Math.min(18000, Math.max(500, Number(cfg.maxDiaryChars) || 8000)))
  if (!diary) return { content: '日记正文是空的。先想好写什么，或者先调 qqzone__collect_diary 看今天的素材。', isError: true }

  const st = loadState()
  if (st.riskDay === diaryDayKey()) {
    return { content: `今天空间被风控锁着（${st.riskReason || '原因未记录'}）—— 自动日记今天也已停发，明天自动恢复。`, isError: true }
  }
  const capCheck = checkCap(st, 'diary', cfg)
  if (!capCheck.ok) return { content: capCheck.reason, isError: true }

  // ── 明信片配图：先把挑选解析成本地字节。★ 全程**不拦人** —— 配图是锦上添花，
  //    挑错编号、文件被清掉、格式不对，都只记一条 note，日记照发。
  const maxBytes = Math.min(32, Math.max(1, Number(cfg.maxImageMB) || IMG_MB_DEFAULT)) * 1024 * 1024
  const picMax = diaryCardsMax(cfg)
  const wantPics = Array.isArray(pics) ? pics : (pics == null || pics === '' ? [] : [pics])
  const picPick = { picked: [], skipped: [] }
  if (wantPics.length && picMax > 0 && cfg.useDiaryCards !== false) {
    const tc = readTravelCards(dataDir(), cfg)
    const got = resolveDiaryPics(dataDir(), wantPics, tc.cards, { maxBytes })
    picPick.picked = got.picked;
    picPick.skipped = got.skipped;
    if (picPick.picked.length > picMax) {
      picPick.skipped.push(...picPick.picked.slice(picMax).map((p) => `#${p.no} 超出上限（最多 ${picMax} 张）`))
      picPick.picked = picPick.picked.slice(0, picMax)
    }
    dbg('diary', true, `明信片挑选：要 ${wantPics.length} 张 → 命中 ${picPick.picked.length} 张（${picPick.picked.map((p) => '#' + p.no).join(',') || '无'}）`)
  }
  // 排版图是软依赖（v2.1）：找不着渲染器或渲染炸了都不拦人，日记退成纯文字说说照发
  const renderer = await loadRenderer()
  let pages = null
  let renderNote = ''
  if (!renderer) {
    renderNote = '未装「长文排版图」技能（skills/text-image）'
  } else {
    try {
      pages = await renderer.renderPages(diary, { title: cleanDiaryText(title, 60) || '日记' }, {})
    } catch (e) {
      renderNote = `排版失败（${String(e?.message ?? e).slice(0, 80)}）`
    }
    if (!Array.isArray(pages) || !pages.length) {
      pages = null
      renderNote = renderNote || '排版结果为空'
    }
  }

  const auth = await (diaryHooks.authImpl ? diaryHooks.authImpl() : acquireCookies())
  if (!auth.selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  if (!pages) {
    // 没有排版图：日记退成纯文字说说 —— **但明信片配图照带**（这正是它最有用的场合）
    const fbVals = []
    for (const p of picPick.picked) {
      try {
        const up = await uploadQzoneImage(auth, p.buf)
        fbVals.push(up.richval)
        dbg('diary', true, `明信片 #${p.no} 已上传（${up.width}x${up.height}）`)
      } catch (e) {
        picPick.skipped.push(`#${p.no} 上传失败（${String(e?.message ?? e).slice(0, 60)}）`)
      }
    }
    const con = sanitizeText(`${caption || '把今天记成了一页日记。'}\n\n${diary}`, 5000)
    const form = {
      syn_tweet_verson: '1',
      paramstr: '1',
      pic_template: '',
      richtype: fbVals.length ? '1' : '',
      richval: fbVals.join('\t'),
      special_url: '',
      subrichtype: '',
      who: '1',
      con,
      feedversion: '1',
      ver: '1',
      ugc_right: '1',
      to_sign: '0',
      hostuin: auth.selfUin,
      code_version: '1',
      format: 'json',
      qzreferrer: `${QZONE}/${auth.selfUin}`
    }
    let tid = ''
    try {
      const j = await qzonePublish(form, auth)
      tid = String(j?.t1_tid ?? j?.tid ?? '')
      if (!tid) throw new Error('响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
    } catch (e) {
      dbg('qqzone__post_diary', false, `纯文字兜底也失败：${String(e?.message ?? e).slice(0, 120)}`)
      return { content: `日记没能发出（${renderNote}，退纯文字也没发成：${String(e?.message ?? e).slice(0, 120)}）`, isError: true }
    }
    recordAct(st, 'diary', null)
    dbg('qqzone__post_diary', true, `tid=${tid}，纯文字兜底（${renderNote}）${fbVals.length ? `，${fbVals.length} 张明信片` : ''}`)
    return {
      content: `${renderNote}——这篇日记退成了纯文字说说发到 QQ 空间（超 5000 字截断）${fbVals.length ? `，带上了 ${fbVals.length} 张明信片` : ''}。装上「长文排版图」后日记会自动排成图，不用改用法。${picPick.skipped.length ? `（配图有调整：${picPick.skipped.join('；')}）` : ''}`
    }
  }

  const richvals = []
  for (const buf of pages) {
    const kind = imageKindOf(buf)
    if (!kind) return { content: '排出来的日记图不是 Qzone 认的图片格式，发不了', isError: true }
    if (buf.length > maxBytes) return { content: `日记图 ${(buf.length / 1048576).toFixed(1)}MB 超过上限，调小每页字数再试`, isError: true }
    try {
      const up = await uploadQzoneImage(auth, buf)
      richvals.push(up.richval)
      dbg('diary', true, `第 ${richvals.length}/${pages.length} 页已上传（${up.width}x${up.height}）`)
    } catch (e) {
      dbg('diary', false, `上传失败：${String(e?.message ?? e).slice(0, 100)}`)
      return { content: `日记图上传失败（第 ${richvals.length + 1} 页）：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
  }

  // ── 明信片配图：排在日记页之后。★ 空间单条上限 9 张，超了从后往前丢
  //    （宁可少配一张，也别让整条说说发不出去）
  const room = Math.max(0, IMG_PER_POST_HARD_MAX - richvals.length)
  const usePics = picPick.picked.slice(0, room)
  if (picPick.picked.length > room) {
    picPick.skipped.push(...picPick.picked.slice(room).map((p) => `#${p.no} 因图片总数上限（${IMG_PER_POST_HARD_MAX}）没带上`))
  }
  for (const p of usePics) {
    try {
      const up = await uploadQzoneImage(auth, p.buf)
      richvals.push(up.richval)
      dbg('diary', true, `明信片 #${p.no} 已上传（${up.width}x${up.height}）`)
    } catch (e) {
      picPick.skipped.push(`#${p.no} 上传失败（${String(e?.message ?? e).slice(0, 60)}）`)
    }
  }

  const cap = Math.max(1, Number(cfg.maxPostChars) || 500)
  const con = sanitizeText(caption || '把今天记成了一页日记。', cap) || '把今天记成了一页日记。'
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: '1',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    who: '1',
    con,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: auth.selfUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${QZONE}/${auth.selfUin}`
  }
  let tid = ''
  try {
    const j = await qzonePublish(form, auth)
    tid = String(j?.t1_tid ?? j?.tid ?? '')
    if (!tid) throw new Error('响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
  } catch (e) {
    dbg('qqzone__post_diary', false, String(e?.message ?? e).slice(0, 120))
    return { content: `发日记说说失败：${String(e?.message ?? e).slice(0, 180)}`, isError: true }
  }
  recordAct(st, 'diary', null)
  dbg('qqzone__post_diary', true, `tid=${tid}，${pages.length} 页图`)

  // 日记图同时落到当前会话，让对面看得见。这一步失败不影响"说说已发出"的事实。
  if (cfg.showInChat !== false && ctx && (ctx.sender || ctx.onebot)) {
    try {
      const osMod = await import('node:os')
      const dir = path.join(osMod.tmpdir(), 'qq-agent-diary')
      fs.mkdirSync(dir, { recursive: true })
      for (let i = 0; i < pages.length; i++) {
        const file = path.join(dir, `${Date.now()}-diary-${i + 1}.png`)
        fs.writeFileSync(file, pages[i])
        try {
          if (ctx?.sender && typeof ctx.sender.sendImage === 'function') {
            await ctx.sender.sendImage(ctx.chatKey, { file, note: `日记第 ${i + 1}/${pages.length} 页` }, { note: `日记第 ${i + 1}/${pages.length} 页` })
          } else if (ctx?.onebot && typeof ctx.onebot.sendImage === 'function') {
            await ctx.onebot.sendImage(ctx.kind, ctx.chatId, file)
          }
        } finally {
          try { fs.unlinkSync(file) } catch { /* 清理失败不影响主结果 */ }
        }
      }
    } catch (e) {
      dbg('diary', null, `回显到会话失败（说说已发出）：${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  return {
    content: `今天的日记已排成 ${pages.length} 页图发到 QQ 空间（说说：${con.slice(0, 40)}${con.length > 40 ? '…' : ''}）`
      + `${usePics.length ? `，另配了 ${usePics.length} 张当天的明信片（${usePics.map((p) => `#${p.no}`).join('、')}）` : ''}`
      + '。日记图也发到当前会话了，不要再复述日记正文。'
      + `${picPick.skipped.length ? `（配图有调整：${picPick.skipped.join('；')}）` : ''}`
  }
}

/* ══════════════════════════════════════════════════════════════════════
   七、技能契约：setup / available / dispose / diagnose
   ══════════════════════════════════════════════════════════════════════ */


// orchestrator 的 ctx 里有 onebot；setup 的 api 没有。所以第一次执行工具时把它记下来，
// 之后取 cookie 都走它的常规通道（被 SnowLuma 1401 拒了再退到读配置文件那条路）。
function gateByContext(ctx) {
  const cfg = cfgOf()
  if (cfg.allowInGroup === false && ctx?.kind === 'group') {
    return '此功能只在私聊可用'
  }
  return ''
}

// 同步：不设硬门槛。真正的句柄在每次工具执行时从运行期 ctx 拿（rememberOnebot），
// 通道不通时调用本身会报人话错误；在这里拦，只会把"设置页开关激活拿不到句柄"
// 的宿主口径差异放大成"依赖不满足"，工具连注册都注册不上。

export function available() {
  return true
}

export function diagnose() {
  const steps = debugLog.slice(-8).map((d) => `${fmtLocal(d.t)} ${d.ok == null ? '…' : d.ok ? '✓' : '✗'} ${d.step} ${d.detail}`)
  return [
    `可用性: ${available() ? '是' : '否'}（onebot 通道见下行）`,
    `onebot 通道: ${getOnebot() && getOnebot().httpUrl ? '有' : '无'}`,
    `data 目录: ${dataDir()}`,
    `state 文件: ${fs.existsSync(stateFile()) ? '存在' : '尚未创建'}`,
    ...autoDiaryStatus(),
    steps.length ? `最近动态:\n  ${steps.join('\n  ')}` : '尚无调用记录'
  ].join('\n')
}

export function disposeDiary() {
  resetCookies()
  setOnebot(null)
  // ★ 卸载/重载时必须熄火 —— 否则就是 §56 那种"起了没人熄"的幽灵定时器。
  stopAutoDiary()
}

/* ══════════════════════════════════════════════════════════════════════
   ★ 自动日记闸（2026-10-13 用户需求）
   ══════════════════════════════════════════════════════════════════════
   需求：「加个阀，让她到 23:00 左右的时候写日志总结一天的事。」
   现场：用户 10-12 晚上睡着，第二天醒来发现**她没有写日记**。

   为什么必须由代码驱动（而不是"提醒她一下"）：
     本宿主只在**别人先开口**的会话里让她说话（见 skills/proactive-dm 头注释），
     宿主的 proactive 起会话又是**随机低概率**（默认关、命中率 25%）⇒
     "没人搭话的夜里"**根本没有轮次**，光往提示词里写"该写日记了"永远不会被执行。
     所以这里自己起定时器、自己调模型、自己发布 —— 与 travel-whale 主动寄明信片同一套做法。

   ★★ 定时器纪律（2026-10-12 幽灵 ticker 事故的教训，见 HANDOFF §56）：
     · 句柄挂 `globalThis` ⇒ 热重载产生的新模块实例也能拿到并**接管**旧的；
     · `startAutoDiary()` **总是先踢掉旧的再建**，绝不"有就不管"；
     · 一轮没跑完不并发（跨实例共享 busy 标记）。
   ══════════════════════════════════════════════════════════════════════ */

const AUTO_DIARY_SLOT = '__qqzoneAutoDiary';       // globalThis 上的单例槽
const AUTO_DIARY_CHECK_MS = 60000;
const AUTO_DIARY_MAX_TRIES = 3;                    // 同一个自然日最多尝试几次
/** 已经为"哪一天"记过一条跳过日志（内存级，只为**别每分钟刷屏**）。 */
let skippedNoted = '';

/** 读数字设置：**显式排除 null / undefined / 空串**。
 *  ⚠️ `Number(null) === 0`，直接 Number() 会把"没配"读成 0（本项目栽过五次）。 */
function numOr(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function autoDiaryCfg(cfg = {}) {
  return {
    on: cfg.diaryAuto !== false,                   // 默认**开**；关掉就完全退回老行为
    hour: Math.min(23, Math.max(0, Math.round(numOr(cfg.diaryAtHour, 23)))),
    minute: Math.min(59, Math.max(0, Math.round(numOr(cfg.diaryAtMinute, 0)))),
    jitterMax: Math.min(30, Math.max(0, Math.round(numOr(cfg.diaryJitterMax, 20)))),   // 每日抖动上限（分钟），0=关
    maxTokens: Math.min(16000, Math.max(1000, Math.round(numOr(cfg.diaryModelMaxTokens, 8000)))),
    picMax: Math.min(3, Math.max(0, Math.round(numOr(cfg.maxDiaryCards, 3))))
  };
}

/** 本地自然日的键（用于"今天尝试过几次"）。 */
function diaryDayKey(now = Date.now()) {
  const d = new Date(now);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 当日**确定性**抖动分钟数（0~jitterMax）。
 * ★ 用日期键做 FNV-1a 哈希取模，不用随机数：同一天每次算出同一个偏移 ——
 *   日志可解释（"今天为什么 23:07 才写"），也不会"每分钟重掷"。 */
export function diaryJitterMin(dayKey, jitterMax) {
  const jm = Math.min(30, Math.max(0, Math.round(numOr(jitterMax, 0))));
  if (jm <= 0) return 0;
  let h = 0x811c9dc5;
  const s = String(dayKey ?? '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h >>> 0) % (jm + 1);
}

/** "23:00（今日抖动 +7 分 → 23:07）" —— 状态面板与启动日志共用的到点显示。 */
function diaryDueLabel(ac, now = Date.now()) {
  const p2 = (x) => String(x).padStart(2, '0');
  const jit = diaryJitterMin(diaryDayKey(now), ac.jitterMax);
  if (!jit) return `${p2(ac.hour)}:${p2(ac.minute)}`;
  const due = new Date(now);
  due.setHours(ac.hour, ac.minute, 0, 0);
  due.setMinutes(due.getMinutes() + jit);
  return `${p2(ac.hour)}:${p2(ac.minute)}（今日抖动 +${jit} 分 → ${p2(due.getHours())}:${p2(due.getMinutes())}）`;
}

/**
 * 自动日记闸的**现状**（给 `diagnose()` 用）。
 *
 * 为什么单独做一个：这个技能走的是 `api.log`，而**技能的日志不进日志文件**
 *   （本项目已知口径）⇒ 光看 log 无法确认"闸到底跑起来没有"。
 *   所以必须让用户**在界面上自己看得到**。
 */
export function autoDiaryStatus() {
  const cfg = cfgOf();
  const ac = autoDiaryCfg(cfg);
  const g = globalThis[AUTO_DIARY_SLOT];
  const st = loadState();
  const day = diaryDayKey();
  const tried = (st.autoDiary && st.autoDiary.day === day) ? numOr(st.autoDiary.n, 0) : 0;
  const canWrite = checkCap(st, 'diary', cfg, Date.now()).ok;
  return [
    `自动日记: ${ac.on ? '开' : '关'}｜到点 ${diaryDueLabel(ac)}`,
    `  定时器: ${g && g.timer ? '在跑' : '★ 没跑（宿主可能没调 setup/activate）'}${g && g.busy ? '（正在写）' : ''}`,
    `  今天: ${canWrite ? '还没写 → 到点会自动写' : '已经写过'}｜自动尝试 ${tried}/${AUTO_DIARY_MAX_TRIES} 次`,
    ...(st.riskDay === day ? [`  ⚠️ 风控锁: 今天已熔断（${st.riskReason || '原因未记录'}，${fmtLocal(numOr(st.riskAt, 0))}）—— 自动日记停发`] : [])
  ];
}

/** 停掉定时器 —— 能清掉**任意实例**留下的那一个（这正是 §56 缺的那一环）。 */
export function stopAutoDiary() {
  const g = globalThis[AUTO_DIARY_SLOT];
  if (g && g.timer) { try { clearInterval(g.timer); } catch { /* ignore */ } }
  globalThis[AUTO_DIARY_SLOT] = null;
}

/** 起定时器：**总是先踢掉旧的再建**（热重载会 import 出新实例，模块级守卫挡不住）。 */
export function startAutoDiary() {
  stopAutoDiary();
  const g = { timer: null, busy: false };
  g.timer = setInterval(() => { tickAutoDiary().catch(() => {}) }, AUTO_DIARY_CHECK_MS);
  g.timer.unref?.();
  globalThis[AUTO_DIARY_SLOT] = g;
  // ★ 2026-10-14：启动时把**判据现状**一并打出来。这一条日志就能回答
  //   "开没开 / 几点 / 今天写过没"，不用再去翻源码 —— 用户问"是不是我忘了打开"，
  //   根因就是这个闸以前**一声不吭**：它的状态只活在内存里，谁也看不见。
  try {
    const cfg = cfgOf();
    const ac = autoDiaryCfg(cfg);
    const cap = checkCap(loadState(), 'diary', cfg);
    log?.(`[qqzone] 自动日记闸已启动（每 60 秒看一眼）：${ac.on ? '开' : '关'}`
      + `｜到点 ${diaryDueLabel(ac)}｜今天${cap.ok ? '还没写' : `已经写过（到点会跳过：${cap.reason}）`}`);
  } catch (e) {
    log?.(`[qqzone] 自动日记闸已启动（每 60 秒看一眼）｜但现状读取失败：${e?.message ?? e}`);
  }
  skippedNoted = '';        // 新实例重新允许记一条"今天跳过"
}

/**
 * 一分钟一看：到点了、今天还没写过、且没在写 → 写一篇。
 * 失败不抛（定时器里抛会变成 unhandled rejection）；当天最多试 `AUTO_DIARY_MAX_TRIES` 次。
 */
export async function tickAutoDiary(now = Date.now()) {
  const cfg = cfgOf();
  const ac = autoDiaryCfg(cfg);
  if (!ac.on) return;

  // ★★ 2026-10-14「她的一天」：先把"今天发生的事"刷新一遍（让她自己筛过），再考虑写日记。
  //   为什么挂在这儿：这是本技能唯一的后台心跳（60 秒一次），而内部**自带节流**
  //   （有新素材 + 距上次 ≥ 20 分钟才真跑）⇒ 不会把模型调用打满，
  //   也不需要为它单开一个定时器（那会多一个"启动/停用/热载"都要照顾的生命周期）。
  try { await refreshMemoryDigest(cfg, now); } catch { /* 回想失败不影响日记闸 */ }

  const due = new Date(now);
  due.setHours(ac.hour, ac.minute, 0, 0);
  // ★ 2026-10-24 每日抖动：分钟级准点发长图说说太整齐（典型脚本指纹）。
  //   偏移对"哪一天"是确定的（diaryJitterMin），一天之内不会漂。
  due.setMinutes(due.getMinutes() + diaryJitterMin(diaryDayKey(now), ac.jitterMax));
  if (now < due.getTime()) return;                 // 还没到点（含抖动）

  const g = globalThis[AUTO_DIARY_SLOT];
  if (!g || g.busy) return;                        // 上一轮没跑完 → 跳过，绝不并发

  // ★ 今天已经写过日记了吗？**复用现有判据** ——
  //   她白天自己写过（或已被自动写过）就返回 not ok，这里直接收手，
  //   所以"用户让她写过了"和"闸写过"两种情况都不会重复。
  const st = loadState();
  const day = diaryDayKey(now);
  // ★ 2026-10-24 风控锁：今天已被熔断（验证码/频控/连续登录页重定向）就整日停发 ——
  //   风控期继续到点重试只会把账号推得更远。一天只留一条日志。
  if (st.riskDay === day) {
    if (skippedNoted !== day + ':risk') {
      skippedNoted = day + ':risk';
      log?.(`[qqzone] 自动日记：今天在风控锁里（${st.riskReason || '原因未记录'}）—— 停发，明天自动恢复`);
    }
    return;
  }
  const capCheck = checkCap(st, 'diary', cfg, now);
  if (!capCheck.ok) {
    // ★★ 2026-10-14：**被挡下时必须留痕，而且一天只留一条**。
    //   以前这里一声不吭地 return ⇒ 晚上没看到日记、日志里也一个字都没有，
    //   于是只能怀疑"是不是我没打开这个功能"（用户 10-14 原话）。
    //   ⚠️ 静默跳过是最难查的一类问题 —— 判据越早说清楚越好。
    if (skippedNoted !== day) {
      skippedNoted = day;
      log?.(`[qqzone] 自动日记：今天跳过（不算失败）—— ${capCheck.reason}`);
    }
    return;
  }

  const tried = (st.autoDiary && st.autoDiary.day === day) ? numOr(st.autoDiary.n, 0) : 0;
  if (tried >= AUTO_DIARY_MAX_TRIES) {
    // 同上：试满了也要吭一声，否则"到点了却没动静"照样没法排查。
    if (skippedNoted !== day) {
      skippedNoted = day;
      log?.(`[qqzone] 自动日记：今天跳过 —— 自动尝试已用满 ${AUTO_DIARY_MAX_TRIES} 次`
        + `（多半是"素材空/模型返回空/发布失败"反复发生，往上翻几行有具体原因）`);
    }
    return;                                        // 今天试够了，别整晚每 60 秒重试
  }
  skippedNoted = '';                               // 真的要写了 ⇒ 这一天的"已提醒"作废

  g.busy = true;
  try {
    st.autoDiary = { day, n: tried + 1, at: now };
    saveState(st);
    await runAutoDiary(cfg, ac);
  } catch (e) {
    log?.(`[qqzone] 自动日记出错：${e?.message ?? e}`);
  } finally {
    const gg = globalThis[AUTO_DIARY_SLOT];
    if (gg) gg.busy = false;
  }
}

/**
 * 真正写一篇并发出去。
 *
 * 做法：素材用**和工具调用完全同一份** `diaryBriefing(cfg)`（所以口径不会两套）；
 *   人设只用来"把握口吻"，不让它复述；
 *   模型**只产正文**，标题/配图由代码补 —— 少一次工具往返，也避免它乱挑图。
 */
async function runAutoDiary(cfg, ac) {
  // ★★ 2026-10-14 兜底：写之前再对着"今天"刷一次回想（心跳那轮可能刚过、也可能失败了）。
  //   保证日记看到的是**最新一份**；真失败就用上一份 —— 绝不让"回想"卡住日记。
  try { await refreshMemoryDigest(cfg, Date.now(), { force: true }); } catch { /* 用上一份 */ }
  const brief = diaryBriefing(cfg);
  if (!brief || !brief.text) { log?.('[qqzone] 自动日记：素材是空的，跳过'); return; }

  let persona = '';
  try {
    const conf = readJsonSafe(path.join(dataDir(), 'config.json'));
    persona = String((conf && conf.persona && conf.persona.roleText) || '').slice(0, 3000);
  } catch { /* 读不到人设也能写，只是口吻淡一点 */ }

  // ★★ 2026-10-17：**口径全部在 `diaryGuidance` 里**（它是 `brief.text` 的尾巴，随素材一起给），
  //   这里只留"只输出正文"和"别把关系搞反"两条 —— 格式与事实约束。
  //   原来这里还重复写了"篇幅 1500~2000"和"按时间顺序"：与 guidance 叠加成**双份约束**，
  //   而"8~12 段 ＋ 1500~2000 ＋ 按时间顺序"三样合起来，正是"等长流水账"的配方。
  const ask = [
    persona ? `# 你是谁（只用来把握口吻，**不要**在正文里复述这些设定）\n${persona}` : '',
    `# 今天的素材与口径\n${brief.text}`,
    '# 现在写\n按上面的素材和口径，写今天的日记。'
      + '只输出**正文本身** —— 不要标题、不要 markdown 标记、不要任何解释或前后缀。'
      + '素材里若有【你此刻的处境】，涉及旅行/旅伴时**照它写**，别把关系搞反。'
  ].filter(Boolean).join('\n\n');

  const { chatCompletion } = await import('../../src/llm.js');
  const r = await chatCompletion({
    messages: [{ role: 'user', content: ask }],
    temperature: 0.85,
    maxTokens: ac.maxTokens
  });
  const text = String((r && r.message && r.message.content) || '').trim();
  if (!text) {
    log?.('[qqzone] 自动日记：模型返回空（思考模型的预算可能被 reasoning 吃光了，可调大 diaryModelMaxTokens）');
    return;
  }

  // 配图：自动取当天最早的 N 张明信片。**不让模型挑** —— 省一次往返，也免得它挑到不存在的编号。
  const pics = [];
  if (ac.picMax > 0 && cfg.useDiaryCards !== false) {
    try {
      const tc = readTravelCards(dataDir(), cfg, Date.now());
      for (const c of tc.cards.slice(0, ac.picMax)) if (c.no) pics.push(String(c.no));
    } catch { /* 没有明信片就不配图 */ }
  }

  const d = new Date();
  const title = `我的日记 · ${d.getMonth() + 1}月${d.getDate()}日`;
  const res = await doPostDiary(text, title, '', pics, { kind: 'private' });
  if (res && res.isError) log?.(`[qqzone] 自动日记发布失败：${String(res.content).slice(0, 140)}`);
  else log?.(`[qqzone] 自动日记已发布（${text.length} 字，配图 ${pics.length} 张）`);
}

export function activateDiary() {
  startAutoDiary();
  // ★★ 2026-10-14：热载/重启后**立刻**把已攒下的回忆接进长期记忆库
  //   （否则要等下一次"有新素材"触发重筛，用户会以为没生效）。
  //   幂等 ⇒ 每次都跑也无害：已写过的块只被覆盖，向量侧内容没变会跳过。
  //   fire-and-forget：补写失败绝不拖累技能加载。
  backfillLongtermMemory(2)
    .then((r) => { if (r && r.written) log?.(`[qqzone] 长期记忆补写：${r.written}/${r.total} 条（近 ${r.days} 天）`); })
    .catch(() => { /* 内部已兜底 */ });
}
export function deactivateDiary() { stopAutoDiary(); }

export function setupDiary(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  // ★★ 2026-10-14：日志优先走**核心 logger**（会写进 data/logs/*.log）。
  //   以前一律走 `api.log` ⇒ **技能的日志不进日志文件**（本项目已知口径）⇒
  //   "自动日记闸到底跑没跑"事后翻日志一片空白，只能靠猜 ——
  //   用户当天原话就是"是这功能我忘了打开吗？"。**看不见 = 等于没有**。
  //   写法与 travel-whale 同款：拿不到核心服务就退回 `api.log`，
  //   且任何一步都不许把主流程带崩（setup 抛错 = 整个技能加载失败）。
  log = (...a) => {
    try {
      const svc = typeof api.services === 'function' ? api.services() : null
      if (svc && typeof svc.log === 'function') return svc.log(...a)
    } catch { /* 落回 api.log */ }
    try { api.log(...a) } catch { /* ignore */ }
  }
  setOnebot(api.onebot || api.context?.onebot || null)
  setLogger(log)
  // ★ 长期记忆的写入通道（见 writePicksToLongterm）：只在 setup 拿得到 api 对象。
  //   activate() 里的补写是 fire-and-forget，setup 一定先跑完，所以这里赋值够用。
  hostApi = api || null

  api.registerTool({
    id: 'collect_diary',
    name: '收集日记素材',
    description: '收集写日记的素材（只读、不出网）：今天的聊天记录 + 当天寄回的明信片清单（带编号，可当配图）+'
      + '「世界与事件」插件的世界观与近况（没装就只给聊天记录）。返回原料，正文由你自己写。',
    category: 'utility',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      rememberOnebot(ctx)
      return doCollectDiary(ctx)
    }
  })

  api.registerTool({
    id: 'post_diary',
    name: '发日记说说',
    description: '把日记正文排成长文排版图，发成一条带图的 QQ 空间说说（一天一篇，按天限频）。'
      + '**日记是长文（1500~2000 字、8~12 段），不是群聊短句**——「1~10 字别写小作文」那套不适用于日记。'
      + '可用 pics 附当天明信片当配图。没装排版图技能或渲染失败时会自动发成纯文字说说，不用改道。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '日记全文，第一人称、你的口气。支持简单 markdown（标题/列表/引用/粗体）。' },
        title: { type: 'string', description: '可选，图片顶部标题，如「我的日记 · 10月4日」。' },
        caption: { type: 'string', description: '可选，说说正文一句话；默认「把今天记成了一页日记。」' },
        pics: {
          type: 'array',
          items: { type: 'string' },
          description: '可选，当天明信片编号（如 ["1","3"]，见 collect_diary 素材的「明信片 #N」），最多 3 张。'
            + '挑不出就别传，不要编编号。'
        }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      rememberOnebot(ctx)
      return doPostDiary(args?.text, args?.title, args?.caption, args?.pics, ctx)
    }
  })

  // ★ 兜底启动「自动日记闸」：`activate()` 是正路，但宿主对"技能要不要调 activate"
  //   在各版本口径不一（travel-whale 就是 activate + onServices 双保险）。
  //   `startAutoDiary()` 幂等（总是先踢掉旧的再建）⇒ 两处都调也只会有一个活着。
  try { startAutoDiary() } catch (e) { log?.(`[qqzone] 自动日记闸启动失败：${e?.message ?? e}`) }
}
