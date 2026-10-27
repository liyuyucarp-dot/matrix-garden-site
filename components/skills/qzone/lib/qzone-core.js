// components/skills/qzone/lib/qzone-core.js
// 账号级基础设施（v2.4.0 从 social.js / diary.js 抽出，约 430 行重复归零）
//
// 为什么抽：两条业务线原来各带一份**相同**的底层 —— Cookie 链路、OneBot 探活、
// SnowLuma 目录扫描、布局与数据目录、几个纯工具。同一处改版要改两遍，
// 而且很容易只改一边（"日记能发、说说发不出去"就是这么来的）。
//
// 刻意**不搬**（避免把两条线的状态搅在一起）：
//   · cfgOf            每个技能读自己的设置
//   · log / dbg / debugLog   业务日志按线区分前缀，留在各自文件
//   · loadState / saveState / stateFile   两条线各有自己的存档
//   · registerTool / activate / dispose     由分片或 index.js 负责
//
// SnowLuma 降级为**可选**来源：resolveTransport() 候选链 env → 宿主 onebot → SnowLuma 目录。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件在 <skill>/lib/ ⇒ 上一层即技能根（与分片里的 HERE 同值）
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

export const QZONE = 'https://user.qzone.qq.com'

export const QZONE_UPLOAD = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'

export const HTTP_TIMEOUT_MS = 15000

export const COOKIE_CACHE_MS = 5 * 60 * 1000

// 图片上传走独立域名（不是 /proxy/domain 那套代理），字段口径照 SnowLuma 桥里
// region src/bridge/apis/qzone.ts 的实现抄——那份是真跑通的。

export const IMG_PER_POST_HARD_MAX = 9      // 空间单条说说的图上限

export const DAY_MS = 24 * 60 * 60 * 1000

export const HOUR_MS = 60 * 60 * 1000

let onebotRef = null

let cookieCache = null   // { cookies: Map, gtk2, selfUin, ts }

let cachedAppRoot = null

// ── core 自己的诊断日志（业务日志仍走各分片的 log；宿主 logger 由 setup 装进来）──
const debugLog = []
let logImpl = null
export function setLogger(fn) { logImpl = typeof fn === 'function' ? fn : null }
export function coreDebugLog() { return debugLog.slice() }

function dbg(step, ok, detail) {
  debugLog.push({ t: Date.now(), step, ok: !!ok, detail: String(detail ?? '').slice(0, 120) })
  if (debugLog.length > 30) debugLog.splice(0, debugLog.length - 30)
  if (ok == null) return
  const msg = `[qzone-core] ${step}: ${detail ?? ''}`
  try { logImpl ? logImpl(msg) : console.warn(msg) } catch { /* 日志失败不影响主流程 */ }
}

// ── 账号级状态访问器（OneBot 引用与 Cookie 缓存**跨两条线共享**）──
export function getOnebot() { return onebotRef }
export function setOnebot(ref) { onebotRef = ref || null }
export function resetCookies() { cookieCache = null }
export function resetLayoutCache() { cachedAppRoot = null }

export function findAppRoot() {
  if (cachedAppRoot !== null) return cachedAppRoot || null
  // 技能在 <app>/resources/app/skills/<id>，往上找带 src/skills.js 的那级
  let dir = path.resolve(HERE, '..', '..')
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'skills.js'))) {
        cachedAppRoot = dir
        return dir
      }
    } catch { /* 权限等，继续往上 */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  cachedAppRoot = false
  return null
}

// data 目录候选：标准布局是 <app>/resources/app/data；净版 zip 多包了一层目录也照样命中。

export function dataDirCandidates() {
  const appRoot = findAppRoot()
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
  return [
    fromEnv || null,
    appRoot ? path.join(appRoot, 'data') : null,
    path.resolve(HERE, '..', '..', 'data'),
  ].filter(Boolean)
}

export function dataDir() {
  for (const c of dataDirCandidates()) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c } catch { /* 继续试 */ }
  }
  return dataDirCandidates()[0]
}

// snowluma 配置目录候选（拿 accessToken 用）。同一个"陈旧副本"教训见 doujin-lookup。

export function snowConfigCandidates() {
  const appRoot = findAppRoot()
  return [
    appRoot ? path.join(appRoot, 'snowluma', 'config') : null,
    path.resolve(HERE, '..', '..', 'snowluma', 'config'),
  ].filter(Boolean)
}

/* ══════════════════════════════════════════════════════════════════════
   二、纯函数工具（测试直接打这些，不打网络）
   ══════════════════════════════════════════════════════════════════════ */

/** g_tk：p_skey 的 5381 哈希，Qzone 所有接口的防伪参数。 */

export function gtk(skey) {
  let h = 5381
  const s = String(skey || '')
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i)
  return (h & 0x7fffffff).toString()
}

/**
 * JS 对象字面量 → 可 JSON.parse 的字符串。逐字符扫描，同时吃得下：
 * 单/双引号字符串、\xNN、\uNNNN、\n \t \r 等控制转义、裸 true/false/null/undefined。
 */

export function cookieHeader(cookies) {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * OneBot get_cookies 的 cookies 字段三种实现三种形状，都得吃：
 *   字符串 "k=v; k=v"（OneBot v11 标准 / SnowLuma 实测）
 *   对象 {k: v, ...}
 *   数组 [{name, value}, ...]
 * 值原样保留（Qzone 要求分号等特殊字符留在值里），这里不做 decodeURIComponent。
 */

export function parseCookiesField(v) {
  const map = new Map()
  if (typeof v === 'string') {
    for (const part of v.split(';')) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      const k = part.slice(0, idx).trim()
      const val = part.slice(idx + 1).trim()
      if (k && val) map.set(k, val)
    }
    return map
  }
  if (Array.isArray(v)) {
    for (const c of v) {
      if (c && c.name != null && c.value != null && c.value !== '') map.set(String(c.name), String(c.value))
    }
    return map
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (val != null && val !== '') map.set(String(k), String(val))
    }
  }
  return map
}

export async function acquireCookies() {
  const now = Date.now()
  if (cookieCache && now - cookieCache.ts < COOKIE_CACHE_MS && cookieCache.cookies.get('p_skey')) {
    return cookieCache
  }
  // 第一路：走 ctx.onebot 的常规通道（应用自己配了 token 时一条就通）
  if (onebotRef && typeof onebotRef.call === 'function') {
    try {
      const data = await onebotRef.call('get_cookies', { domain: 'qzone.qq.com' }, HTTP_TIMEOUT_MS)
      const map = parseCookiesField(data?.cookies ?? data?.cookie)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 ctx.onebot 拿到 p_skey')
        return cookieCache
      }
      dbg('cookies', null, 'ctx.onebot 通道没拿到 p_skey')
    } catch (e) {
      dbg('cookies', null, `ctx.onebot 通道失败：${e?.message ?? e}`)
    }
  }
  // 第二路：读 snowluma 配置拿 token/base，自己拼 get_cookies（SnowLuma 对敏感接口强制校验 token）
  for (const svc of readSnowHttpServices()) {
    try {
      const map = await fetchCookiesViaOnebot(svc.token, svc.base)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 snowluma 配置 token 拿到 p_skey')
        return cookieCache
      }
    } catch { /* 换下一个 token 试 */ }
  }
  dbg('cookies', false, '两路都没拿到 p_skey')
  throw new Error('拿不到 Qzone 登录态（get_cookies 失败）。确认 bot 账号在线、SnowLuma 已登录。')
}

export async function fetchCookiesViaOnebot(token, base) {
  base = String(base || onebotRef?.httpUrl || '').replace(/\/$/, '')
  if (!base) throw new Error('onebot httpUrl 不可用')
  const res = await fetch(`${base}/get_cookies`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ domain: 'qzone.qq.com' }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body.status !== 'ok' && body.retcode !== 0)) {
    throw new Error(`get_cookies 失败: HTTP ${res.status} retcode=${body.retcode ?? body.status}`)
  }
  return parseCookiesField(body.data?.cookies ?? body.data?.cookie)
}

// 从 snowluma 的 onebot_*.json 里收集 http 服务的 {token, base}。
// token 只进内存，绝不写日志——本项目对"密钥回显"有过教训。
// base 取配置里的 host/port（缺省 127.0.0.1:3000），因为这条路恰恰是在
// ctx.onebot 还没拿到手（或不存在）时用的，不能依赖 onebotRef.httpUrl。
/**
 * 宿主自己那条 OneBot 的端口（2026-10-21 新增）。
 *
 * 为什么需要：snowluma/config 下可能同时存在多个号的 onebot_*.json（同一台机器
 * 跑两个 agent 时必然如此）。原实现把所有 token 都收集起来逐个试、谁先成功用谁，
 * 而 readdirSync 一般按名字排序 —— 于是 10003 排在 10002 前面时，
 * 晴雨的 qzone 就用星澄的号发了说说（真实事故）。
 *
 * 端口是"我是谁"最可靠的标识：宿主配置里 snowluma.httpUrl 指向的就是自己那条。
 * 拿不到端口时才返回空集合，由调用方决定退回原行为。
 */

export function finishCookies(map, now) {
  const selfUin = (map.get('pt2gguin') || map.get('uin') || '').replace(/^o0*/, '')
  return { cookies: map, gtk2: gtk(map.get('p_skey')), selfUin, ts: now }
}

/* ══════════════════════════════════════════════════════════════════════
   五、Qzone HTTP 封装 —— ★ 这就是「通道驱动层」（§5.1 Driver-A 边界，2026-10-24 标注）
   ══════════════════════════════════════════════════════════════════════
   本节以下三个函数（qzoneGet / qzonePost / qzonePostWrite）是**全部**腾讯 CGI
   的进出通道；上面的业务逻辑（发说说/点赞/评论/回复）只调它们，不碰 fetch、
   cookie 拼装与 referer/UA 细节。

   若腾讯 CGI 改版/加严风控，按《03.md》§5.1 的三驱动方案在这里换实现：
     · Driver A（当前）：原生 CGI 直调 —— 快，但吃腾讯改版影响；
     · Driver B：Electron 隐身浏览器驱动 —— 真实 Chromium 环境带指纹，
       滑块验证码本地弹窗手滑即可恢复；
     · Driver C：自建动态墙 —— 平台完全不可用时的落点。
   换驱动 = 重写本节三个函数，签名（urlPath, params/form, cookies）不变，
   业务逻辑层零改动。 */

export function ownHttpPorts() {
  const ports = new Set()
  const addFrom = (u) => {
    const m = String(u || '').match(/:(\d{2,5})(?:\/|$)/)
    if (m) ports.add(Number(m[1]))
  }
  try { addFrom(onebotRef?.httpUrl) } catch { /* ignore */ }
  try { addFrom(onebotRef?.baseUrl) } catch { /* ignore */ }
  for (const d of dataDirCandidates()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8'))
      const sl = j?.snowluma || {}
      addFrom(sl.httpUrl)
      addFrom(sl.wsUrl)
    } catch { /* 没有 config.json 就跳过 */ }
  }
  return ports
}

export function readSnowHttpServices() {
  const ports = ownHttpPorts()
  const matched = []
  const others = []
  for (const dir of snowConfigCandidates()) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /^onebot_.*\.json$/i.test(f)) } catch { continue }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const servers = j?.networks?.httpServers || j?.httpServers || []
        for (const s of Array.isArray(servers) ? servers : []) {
          if (!s) continue
          const host = s.host || '127.0.0.1'
          const port = Number(s.port) || 3000
          const rec = {
            token: s.accessToken ? String(s.accessToken) : '',
            base: `http://${host}:${port}`,
            port,
            file: f
          }
          if (ports.size && ports.has(port)) matched.push(rec)
          else others.push(rec)
        }
      } catch { /* 单个配置文件坏了不影响别的 */ }
    }
  }
  // 知道自己的端口 → 只认它。一个都匹配不上就拒绝盲试：
  // 用别人的号发说说比"发不出去"严重得多（收不回来，还顶着别人的名字）。
  if (ports.size) {
    if (!matched.length) {
      dbg('cookies', false,
        `宿主端口 ${[...ports].join('/')} 在 onebot_*.json 里找不到对应项，拒绝盲试其它号（见 ${snowConfigCandidates().filter(Boolean).join(' | ')}）`)
      return []
    }
    dbg('cookies', null, `按端口 ${[...ports].join('/')} 选中 ${matched.map((x) => x.file).join(', ')}`)
    return matched
  }
  // 拿不到端口信息：退回原行为，但明确记一条，方便下次定位
  dbg('cookies', null, '拿不到宿主端口，退回遍历所有 onebot 配置（可能抓错号）')
  return others
}

export function rememberOnebot(ctx) {
  if (!onebotRef && ctx && typeof ctx.onebot?.call === 'function') onebotRef = ctx.onebot
}

// 群聊闸门（与 doujin-lookup 同一套约定）

export function sanitizeText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}

/** 本地时区 'YYYY-MM-DD HH:mm'，状态文件里给人看的。 */

export function imageKindOf(buf) {
  if (!buf || buf.length < 12) return null
  const head = (n) => buf.subarray(0, n).toString('latin1')
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (head(8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return 'gif'
  if (head(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (head(2) === 'BM') return 'bmp'
  return null
}

/** 清理用户可见文本：去控制字符、压空白、限长。 */

// ── 传输层说明（v3.0）：雪露玛只是候选之一，找不到就降级并说清原因 ──
export function resolveTransport() {
  const envBase = String(process.env.QZONE_ONEBOT_BASE || '').trim()
  const envToken = String(process.env.QZONE_ONEBOT_TOKEN || '').trim()
  if (envBase) return { source: 'env', cands: [{ token: envToken, base: envBase, why: 'env QZONE_ONEBOT_BASE' }] }
  if (onebotRef?.httpUrl) return { source: 'own-port', cands: [{ token: '', base: onebotRef.httpUrl, why: '宿主 onebot.httpUrl' }] }
  const cands = readSnowHttpServices()
  if (cands.length) return { source: 'snowluma', cands: cands.map((c) => ({ ...c, why: 'snowluma onebot_*.json' })) }
  return { source: 'none', cands: [] }
}
