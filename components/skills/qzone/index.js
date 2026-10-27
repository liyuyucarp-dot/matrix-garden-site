// QQ 空间动态 —— **自包含** Skill（QQ Agent 0.3.1 规范）
//
// 这个文件会被**原样拷进别人的 app 目录**，那份 app 的 src/ 结构与我们的不同，
// 所以这里**不 import 任何 `../../src/...`**，只用 Node 内置模块。
//
// ── 能力 ────────────────────────────────────────────────────────────────
//   qzone__post_mood      发说说（文字，可带聊天里的图）
//   qzone__list_feeds     刷好友动态（只读）
//   qzone__read_comments  读某条说说的评论与回复（只读）
//   qzone__like_feed      点赞某条说说
//   qzone__comment_feed   评论某条说说
//   qzone__reply_comment  回复某条**已有的**评论（1.3.0 新增）
//
// ── 评论收件箱：轮询 + 静默带出（1.4.0 新增）──────────────────────────────
//   她自己发的说说有人评论了，她得知道。做法不是"主动发消息"，而是：
//   activate() 起一个自调度定时器（默认 15 分钟），只盯她最近几条说说；
//   有新评论就落 data/qzone/inbox.json，再由 before-llm-messages 钩子
//   在**她下一次要开口之前**追加到上下文尾部。由她自己决定回不回。
//   为什么不用主动发消息：宿主没有 proactive 能力、v0.4.5 的 capabilities
//   也是空的（没有任何核心发送能力提供者），要发只能自己拼 OneBot HTTP ——
//   那等于替她开口，打扰且收不回来。详见 §六·五。
//
// ── 评论正文从哪来（1.2.0 新增）────────────────────────────────────────
//   列表接口 feeds3_html_more **不会**把评论放进结构体字段里（`mergeData` 恒为
//   [null]、`likecnt/commentcnt` 是空串）——它只把前几条评论**渲染进 html**
//   （`<li class="comments-item" data-type="commentroot" data-uin=".." data-nick="..">`），
//   更早的评论要再点"查看更多"才取。所以：
//     · 列表里的**条数/点赞数**只当"提示"，从 html 里数（见 feedCountsOf）；
//     · 要看**评论正文**，走 `emotion_cgi_msgdetail_v6`（PC 版详情接口），
//       它给结构化 `commentlist[]`，每条评论的**回复嵌在 `list_3[]`** 里，
//       还带权威的 `cmtnum`。这是 read_comments 的唯一数据源。
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
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // …/skills/qzone
const SKILL_ID = 'qzone'
const TOOL = (n) => `${SKILL_ID}__${n}`

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const QZONE = 'https://user.qzone.qq.com'
const HTTP_TIMEOUT_MS = 15000
const COOKIE_CACHE_MS = 5 * 60 * 1000

// 图片上传走独立域名（不是 /proxy/domain 那套代理），字段口径照 SnowLuma 桥里
// region src/bridge/apis/qzone.ts 的实现抄——那份是真跑通的。
const QZONE_UPLOAD = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'
const IMG_PER_POST_DEFAULT = 3
const IMG_PER_POST_HARD_MAX = 9      // 空间单条说说的图上限
const IMG_MB_DEFAULT = 8
const IMG_DOWNLOAD_TIMEOUT_MS = 30000   // 下图比调接口慢，给足时间

// 读评论：PC 版「说说详情」接口。返回正文 content + 权威计数 cmtnum + commentlist[]，
// 每条评论的回复在 list_3[] 里。列表接口拿不到评论正文，只能靠它。
const QZONE_DETAIL = '/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6'
// 回复评论：与顶层评论**同一个域**（user.qzone.qq.com）。
// ★ 实测过两条路：h5.qzone.qq.com 那条在本机通不了（回 html），user 这条直接成功。
//   两者表单结构完全一致，差别只在 commentId/commentUin 和 content 里的 @标记。
const QZONE_REPLY = 'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds'
const CMTS_PER_FEED_DEFAULT = 20
const CMTS_PER_FEED_HARD_MAX = 50    // 详情接口 num 的经验上限，再大也是分页
const CMT_TEXT_MAX = 300             // 单条评论展示的字数上限

// ── setup 里存下来的引用（available / diagnose 可能在任何时候被调用）──
let cfgOf = () => ({})
let log = () => {}
let onebotRef = null
const debugLog = []
function dbg(step, ok, detail) {
  debugLog.push({ t: Date.now(), step, ok: !!ok, detail: String(detail ?? '').slice(0, 120) })
  if (debugLog.length > 30) debugLog.splice(0, debugLog.length - 30)
  if (ok == null) return
  const msg = `[qzone] ${step}: ${detail ?? ''}`
  try { ok ? log(msg) : console.warn(msg) } catch { /* 日志失败不影响主流程 */ }
}

/* ══════════════════════════════════════════════════════════════════════
   一、布局探测：找到 app 根（resources/app）与 data 目录
   ══════════════════════════════════════════════════════════════════════ */

let cachedAppRoot = null
function findAppRoot() {
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
function dataDirCandidates() {
  const appRoot = findAppRoot()
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
  return [
    fromEnv || null,
    appRoot ? path.join(appRoot, 'data') : null,
    path.resolve(HERE, '..', '..', 'data'),
  ].filter(Boolean)
}

function dataDir() {
  for (const c of dataDirCandidates()) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c } catch { /* 继续试 */ }
  }
  return dataDirCandidates()[0]
}

// snowluma 配置目录候选（拿 accessToken 用）。同一个"陈旧副本"教训见 doujin-lookup。
function snowConfigCandidates() {
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

/** 把 Qzone 返回的 `_Callback(...)` / `shine0_Callback(...)` 之类剥掉，取内部 JSON。 */
export function stripCallback(text) {
  const s = String(text ?? '').trim()
  const m = s.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/)
  if (m) return m[1].trim()
  // ★ 2026-10-11：壳不一定"从头到尾完整"。实测【图片上传】那条响应就在 callback(...)
  //   后面还挂着东西（`</script>` 之类的尾巴），也可能是 `a && a({...})` 这种写法。
  //   原来的整串精确匹配一失败就**原样返回**，于是 jsLiteralToJson 把裸标识符
  //   `callback` 当成字符串保下来 —— 输出正好是 `"callback"`（10 个字符），
  //   JSON.parse 报 "Unexpected non-whitespace character after JSON at position 10"，
  //   用户看到的就是"发了两次都传不上去"。这里改成"定位到第一个 `名({`，再取到最后一个 `)`"。
  const at = s.search(/[A-Za-z_$][\w$]*\s*\(\s*\{/)
  if (at > 0) {
    const open = s.indexOf('(', at)
    const end = s.lastIndexOf(')')
    if (open >= 0 && end > open) return s.slice(open + 1, end).trim()
  }
  return s
}

/** 说说 HTML → 人读摘要：解 \xNN、去标签、解实体、收空白、截断。 */
export function htmlToText(html, maxLen = 300) {
  let s = String(html ?? '')
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&#[0-9]+;/g, (m2) => { try { return String.fromCharCode(parseInt(m2.slice(2, -1), 10)) } catch { return m2 } })
  s = s.replace(/\s+/g, ' ').trim()
  // Qzone 在正文后依次拼"展开全文"/"N 人觉得很赞"/"浏览 N"等尾巴（去标签后数字和汉字间会有空格），
  // 从最早出现的那一处砍掉
  const cut = s.search(/\d+\s*人觉得很赞|浏览\s*\d|展开全文/)
  if (cut > 0) s = s.slice(0, cut).trim()
  s = s.replace(/[，,、\s]*$/, '').trim()
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

/**
 * 列表 html → **正文**。只取 `<div class="f-info">`，别整块过 htmlToText——
 * 整块会把「昵称 + 时间」的头部也带进来（实测会得到"占位昵称 12:06 正文…"）。
 * 没有 f-info（纯图说说）就返回空串。
 */
export function feedTextOf(html, maxLen = 300) {
  const h = String(html ?? '').replace(/\\x([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))
  // ★ LONG-FEED-FIX（2026-10-10）：正则原来写死 `<div class="f-info">`（精确匹配）。
  //   **长说说**（超出折叠阈值的那类）渲染成 `<div class="f-info qz_info_cut">`，多一个
  //   `qz_info_cut` 类 ⇒ 精确匹配失败 ⇒ 这条说说"一个字都读不到"，feedToItem 只好给
  //   「（无文字）」。现场：狐狸 13:38 的长说说 —— 工具报没读到，而它其实写了整整一段
  //   （末尾还自嘲"以上，零傲娇，一个字都没有"）。
  //   现在：接受 f-info 后面跟任意 class，但**排除 `qz_info_complete`**（那是空壳，
  //   全文要点"展开全文"才异步加载），并把折叠提示词一起剥掉。
  const m = h.match(/<div class="f-info(?! qz_info_complete)[^"]*">([\s\S]*?)<\/div>/)
  if (!m) return ''
  return htmlToText(m[1], maxLen).replace(/展开全文|收起/g, '').trim()
}

/**
 * 列表 html → 计数提示 `{ likes, comments, truncated }`。
 * 别再用结构体字段：`mergeData` 恒为 [null]（旧代码因此把评论数恒算成 1），
 * `likecnt/commentcnt` 是空串。真值只在渲染好的 html 里：
 *   点赞 `data-likecnt="20"`（或 `共<span class="f-like-cnt">20</span>人觉得很赞`）
 *   评论 `<li class="comments-item" data-type="commentroot">` 的个数
 * `truncated` = 有"查看更多评论"之类的尾巴 → 实际条数 ≥ 数出来的这个。
 */
export function feedCountsOf(html) {
  const h = String(html ?? '').replace(/\\x([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)))
  const likeM = h.match(/data-likecnt="(\d+)"/) || h.match(/class="f-like-cnt"[^>]*>(\d+)</)
  const likes = likeM ? Number(likeM[1]) || 0 : 0
  const comments = (h.match(/data-type="commentroot"/g) || []).length
  const truncated = /comments-more|查看更多评论|展开更多评论|comments-expand/.test(h)
  return { likes, comments, truncated }
}

/**
 * 评论正文里的 @ 是协议串：`@{uin:123,nick:名字,who:1,auto:1}`。
 * 换成 `@名字` 给人看。Qzone 表情是 `[em]e100[/em]`，一并去掉。
 * 兜底：万一 nick 里有 `}` 导致正则没吃到，再把残留的 `{uin:...}` 段清掉。
 */
export function cleanMentions(s) {
  let t = String(s ?? '')
  // ★ 协议串本身是带前缀 @ 的：`@{uin:123,nick:名字,who:1,auto:1}`
  //   —— 正则必须把那个 @ 一起吃进去，否则替换后又补一个 @，变成 "@@名字"。
  t = t.replace(/@?\{uin:(\d+),nick:([^}]*),who:\d+,auto:\d+\}/g, (_, uin, nick) => `@${nick || uin}`)
  t = t.replace(/\[em\]e\d+\[\/em\]/g, '')
  t = t.replace(/@?\{uin:\d+,[^}]*\}/g, '')
  return t
}

/**
 * 说说详情响应 → 可读结构。
 * 响应顶层就是说说本体（没有 data 包一层）：content 正文、cmtnum 权威评论数、
 * commentlist[] 评论（回复在每条的 list_3[] 里）。
 * 返回 null 表示"这不是一条能读懂的说说了"。
 */
export function parseMsgDetail(j) {
  if (!j || typeof j !== 'object') return null
  const tid = String(j.tid ?? '')
  if (!isValidTid(tid)) return null
  const uin = String(j.uin ?? '')
  // 正文：优先顶层 content；图片/纯转发类说说 content 可能为空，退到 conlist
  let content = String(j.content ?? '').trim()
  if (!content && Array.isArray(j.conlist)) {
    content = j.conlist.map((x) => String(x?.con ?? '')).filter(Boolean).join(' ')
  }
  const rawList = Array.isArray(j.commentlist) ? j.commentlist : []
  const list = []
  for (const c of rawList) {
    if (!c || typeof c !== 'object') continue
    const root = {
      tid: String(c.tid ?? ''),              // 楼层号：回复评论时要拿它当 commentId
      uin: String(c.uin ?? ''),
      name: String(c.name ?? '').trim() || String(c.uin ?? ''),
      content: cleanMentions(sanitizeText(c.content, CMT_TEXT_MAX * 2)),
      time: String(c.createTime2 || c.createTime || '').trim(),
      replies: []
    }
    for (const r of (Array.isArray(c.list_3) ? c.list_3 : [])) {
      if (!r || typeof r !== 'object') continue
      root.replies.push({
        tid: String(r.tid ?? ''),
        uin: String(r.uin ?? r?.owner?.uin ?? ''),
        name: String(r.name ?? r?.owner?.name ?? '').trim() || String(r.uin ?? ''),
        content: cleanMentions(sanitizeText(r.content, CMT_TEXT_MAX * 2)),
        time: String(r.createTime2 || r.createTime || '').trim()
      })
    }
    list.push(root)
  }
  return {
    uin, tid,
    name: String(j.name ?? '').trim(),
    content: sanitizeText(content, 800),
    pics: Number(j.pictotal) || (Array.isArray(j.pic) ? j.pic.length : 0),
    declared: Number(j.cmtnum) || 0,
    list
  }
}

/** 详情 → 给模型看的评论线程文本。selfUin 用来标出"这条是你自己发的"。 */
export function formatCommentThread(d, selfUin) {
  const me = String(selfUin || '')
  const who = d.name ? `${d.name}(${d.uin})` : String(d.uin)
  const head = d.content ? `「${d.content}」` : '（这条没有文字，是图片/转发类说说）'
  const pic = d.pics > 0 ? `，带 ${d.pics} 张图` : ''
  const lines = [`${who} 的说说${pic}：${head}`]
  if (!d.list.length) {
    return `${lines[0]}\n还没有人评论。`
  }
  const shown = d.list.length
  lines.push(`共 ${d.declared || shown} 条评论${shown < (d.declared || 0) ? `（这里显示最早的 ${shown} 条）` : ''}：`)
  d.list.forEach((c, i) => {
    const mine = c.uin === me ? '（你自己）' : ''
    lines.push(`${i + 1}. ${c.name}(${c.uin})${mine} ${c.time}：${c.content}`)
    for (const r of c.replies) {
      const rMine = r.uin === me ? '（你自己）' : ''
      lines.push(`      └ ${r.name}(${r.uin})${rMine} ${r.time}：${r.content}`)
    }
  })
  return lines.join('\n')
}

export function isValidUin(u) {
  const s = String(u ?? '').trim()
  return /^\d{5,11}$/.test(s)
}

export function isValidTid(t) {
  const s = String(t ?? '').trim()
  return /^[0-9a-f]{24}$/.test(s)
}

/**
 * 图片引用 → { mid, index }。只认聊天记录里的消息号（#12345；一条消息多图时
 * #12345:2 表示第 2 张）。其余形状——路径、URL、base64://、file://、表情 id、
 * 空串——一律 null。这个函数是"模型拿不到任意图"的唯一闸门，别放宽。
 */
export function parseImageRef(v) {
  const m = String(v ?? '').trim().match(/^#?(-?\d{1,19})(?::([1-9]\d{0,2}))?$/)
  if (!m) return null
  const mid = m[1]
  if (Number(mid) === 0) return null            // 0 不是合法消息号
  return { mid, index: m[2] ? Number(m[2]) : 1 }
}

/**
 * 图片魔数校验。Qzone 只吃这几种；顺手挡掉"把任意文件当图上传"
 * （与 src/tts.js 的 isAudio 一个纪律：出网前先验明正身）。
 */
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
export function sanitizeText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}

/** 本地时区 'YYYY-MM-DD HH:mm'，状态文件里给人看的。 */
export function fmtLocal(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ══════════════════════════════════════════════════════════════════════
   三、状态与限频：data/qzone/state.json
   ══════════════════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function defaultState() {
  return { posts: [], likes: [], comments: [], lastBrowse: 0, feedCache: null, acted: {} }
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

let cookieCache = null   // { cookies: Map, gtk2, selfUin, ts }

function cookieHeader(cookies) {
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

async function fetchCookiesViaOnebot(token, base) {
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
function ownHttpPorts() {
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

function readSnowHttpServices() {
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

async function acquireCookies() {
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

function finishCookies(map, now) {
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

async function qzoneGet(urlPath, params, cookies) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${QZONE}${urlPath}?${qs}`, {
    headers: { 'user-agent': UA, cookie: cookieHeader(cookies) },
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

async function qzonePost(urlPath, form, cookies) {
  // urlPath 允许是绝对地址：图片上传在 up.qzone.qq.com，不在 user.qzone.qq.com 的代理下。
  riskGateOrThrow()
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
  if (res.status >= 300 && res.status < 400) {
    redirectStreak += 1
    if (redirectStreak >= 2) markRisk(`连续 ${redirectStreak} 次被重定向到登录页`)
    throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  }
  redirectStreak = 0
  return riskCheckText(text, riskLabel(urlPath))
}

/**
 * **写入类**的 POST。与 qzonePost 的唯一差别：**3xx 重定向算成功**。
 *
 * 为什么必须分开：Qzone 对「回复评论」这类写入，成功后回的恰恰是一个 302
 * （body 是 html）。拿通用的「3xx = 登录失效」去判，会把**已经落库的操作报成失败** ——
 * 实测踩过：回复其实已经出现在空间里了，客户端却抛异常；调用方一重试就会重复发。
 * 3xx 时不再解析 body（它是 html），直接当成功。
 */
async function qzonePostWrite(urlPath, form, cookies) {
  riskGateOrThrow()
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
  if (res.status >= 300 && res.status < 400) return { redirected: true, text: '' }
  const text = await res.text()
  if (res.status >= 400) throw new Error(`请求失败：HTTP ${res.status}`)
  return { redirected: false, text: riskCheckText(text, riskLabel(urlPath)) }
}

/* ═══ 风控熔断（2026-10-24）═══ 与 skills/qqzone 同一套判据/口径：
   ① 响应正文出现 verify/captcha；② code=-3000（未登录/登录态失效）或
   -10000（频控）；③ 连续 2 次被重定向到登录页（写入类 3xx 算成功，不计入）。
   锁存在本技能 state.json 的 riskDay（自然日键），次日自然失效；
   锁着时轮询不出网、发布/点赞/评论直接给人话错误。 */
let redirectStreak = 0;
let riskNoted = '';

function riskDayKey(now = Date.now()) {
  const d = new Date(now);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function riskLocked(now = Date.now()) {
  try { return loadState().riskDay === riskDayKey(now); } catch { return false; }
}

function riskLabel(urlPath) {
  return String(urlPath).split('?')[0].split('/').filter(Boolean).pop() || '请求';
}

/** 命中风控 → 写当日锁（幂等，一天只写一次）。 */
function markRisk(reason) {
  try {
    const st = loadState();
    const day = riskDayKey();
    if (st.riskDay === day) return;
    st.riskDay = day;
    st.riskAt = Date.now();
    st.riskReason = String(reason).slice(0, 120);
    saveState(st);
    dbg('risk', false, `⚠️ 风控熔断：${st.riskReason} —— 当日停轮询/停写入，明天自动恢复`);
  } catch { /* 锁写不进去也别影响主流程 */ }
}

/** 出网前的风控闸：锁着就直接给人话错误，不打请求。 */
function riskGateOrThrow() {
  const st = loadState();
  if (st.riskDay === riskDayKey()) {
    throw new Error(`今天空间被风控锁着（${st.riskReason || '原因未记录'}）—— 明天自动恢复`);
  }
}

/** 响应文本带验证码页或 -3000/-10000 风控码 → 落锁并抛人话错误。 */
function riskCheckText(text, label) {
  const t = String(text ?? '');
  if (/verify|captcha/i.test(t)) {
    markRisk(`响应出现 verify/captcha（${label}）`);
    throw new Error(`${label} 被风控拦了（返回了验证码页），今天先不试了`);
  }
  const m = t.match(/code['"]?\s*[:=]\s*-(3000|10000)\b/);
  if (m) {
    markRisk(`${label} code=-${m[1]}（${m[1] === '3000' ? '登录态失效' : '频控'}）`);
    throw new Error(`${label} 失败：code=-${m[1]}，今天先不试了`);
  }
  return t;
}

/**
 * 发评论 / 回复评论共用的一条路：调 re_feeds 并按它的**真实**响应形状判成败。
 * 三种都算"发出去了"：① 3xx 重定向；② 200 + HTML 壳（code 从壳里抠，最常见）；
 * ③ 200 + JSON（万一哪天改了）。只有明确拿到非 0 的 code 才报错。
 */
async function postReFeeds(urlPath, form, cookies, what) {
  const resp = await qzonePostWrite(urlPath, form, cookies)
  if (resp.redirected) return { ok: true, via: 'redirect' }
  const t = String(resp.text || '').trim()
  if (!t) return { ok: true, via: 'empty' }
  if (t.startsWith('<')) {
    const code = codeFromHtml(resp.text)
    if (code != null && code !== 0) throw new Error(`${what} 失败：code=${code}`)
    if (code == null) dbg(what, null, '响应是 HTML 但没找到 code，按成功处理')
    return { ok: true, via: 'html', code }
  }
  parseQzoneJson(resp.text, what)
  return { ok: true, via: 'json' }
}

/** 统一的成功判定：剥 callback 后 code===0。 */
function parseQzoneJson(text, what) {
  let j
  try {
    j = JSON.parse(jsLiteralToJson(stripCallback(text)))
  } catch (e) {
    throw new Error(`${what} 返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  if (!j || j.code !== 0) {
    throw new Error(`${what} 失败: code=${j?.code ?? '?'} ${j?.message || j?.msg || ''}`.trim())
  }
  return j
}

/**
 * 上传 / 发布这两个接口的响应**不一定带 code 字段**（成功时可能整个没有），
 * 所以不能复用上面那个"必须 code===0"的严格判定，否则成功会被当成失败。
 * 口径照 SnowLuma 桥：code / subcode 只在是数字且非 0 时才算错。
 * 另外上传接口偶尔在 callback( 前面吐一段垃圾，先切到 callback 再剥壳。
 */
export function parseQzoneLooseJson(text, what) {
  const raw = String(text ?? '').trim()
  let s = raw
  const at = s.indexOf('callback')
  if (at > 0) s = s.slice(at)
  // ★ 兜底：只认**最外层那个 `{…}`**，把前后所有壳/垃圾都丢掉。
  //   这是"响应形状再怪也能解析"的最后一道保险（见 stripCallback 的注释）。
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  let j
  try {
    j = JSON.parse(jsLiteralToJson(stripCallback(s)))
  } catch (e) {
    // ★ 2026-10-11：把**原始响应前 200 字**带上 —— 以前只报 JSON 的报错，等于没有线索
    //   （用户看到"卡住了"，排查要从头猜响应长什么样）。带 URL 的地方去掉 query，
    //   免得把带签名的直链带进模型上下文/聊天里。
    const head = raw.slice(0, 200)
      .replace(/https?:\/\/[^\s"']+/g, (u) => u.split('?')[0] + '?…')
      .replace(/\s+/g, ' ')
    throw new Error(`${what}返回无法解析（${String(e?.message ?? e).slice(0, 80)}）｜响应前 200 字：${head}`)
  }
  for (const k of ['code', 'subcode']) {
    if (typeof j?.[k] === 'number' && j[k] !== 0) {
      throw new Error(`${what}失败: ${k}=${j[k]} ${j?.message || j?.msg || ''}`.trim())
    }
  }
  return j || {}
}

/**
 * 从 Qzone **写入类**响应的 HTML 壳里抠出 code。
 *
 * 为什么要有这个函数：`emotion_cgi_re_feeds`（发评论 / 回复评论）成功时回的
 * **不是 JSON**，而是一整页 HTML，真正的结果塞在
 *   <script>frameElement.callback({ code: 0, … });</script>
 * 里。直接扔给 JSON.parse 会报 "Unexpected token '<'"，于是**操作明明已经生效、
 * 客户端却报失败** —— 实测踩过两次（两条回复都稳稳落在空间里，程序还说自己失败了）。
 * 抠不到 callback 就返回 null，交给上层按"不确定"处理，绝不武断报错。
 */
export function codeFromHtml(text) {
  const s = String(text ?? '')
  const at = s.indexOf('frameElement.callback(')
  if (at < 0) return null
  const start = at + 'frameElement.callback('.length
  const end = s.lastIndexOf(');')
  if (!(end > start)) return null
  const jsonStr = s.slice(start, end).trim().replace(/;$/, '')
  // 响应里是 **JS 对象字面量**（`{ code: 0, … }`，key 不带引号），
  // 所以先试带引号的 JSON 写法，再试裸 key —— 且要求前面是 { , 或空白，
  // 免得把 `subcode` 或正文里的文字误当成 code。
  const m = jsonStr.match(/"code"\s*:\s*(-?\d+)/) || jsonStr.match(/(?:^|[{,\s])code\s*:\s*(-?\d+)/)
  return m ? Number(m[1]) : null
}

/* ══════════════════════════════════════════════════════════════════════
   五点五、带图说说：聊天里的图 → Qzone 图床 → richval
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 把模型给的消息号换成"那张图"的定位符。**纯本地读，不出网** ——
 * 坏 id / 没图的消息 / 越界的第 N 张都在这里死掉，绝不带着脏参数去打 Qzone。
 */
export function resolveChatImage(ctx, ref) {
  const store = ctx?.store
  if (!store || typeof store.findByMid !== 'function') {
    return { error: '这个会话拿不到消息存档，引用不了聊天里的图（这次只能发纯文字）' }
  }
  let entry = null
  try {
    entry = store.findByMid(ctx.chatKey, ref.mid)
  } catch (e) {
    return { error: `查消息 #${ref.mid} 时存档报错了（${String(e?.message ?? e).slice(0, 40)}）` }
  }
  if (!entry) return { error: `聊天记录里没有消息 #${ref.mid}。id 只能用聊天记录里真出现过的那个，别编` }
  const imgs = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image' && (m.url || m.file))
  if (!imgs.length) return { error: `消息 #${ref.mid} 里没有图片（[语音]/[文件]/纯文字都当不了图发）` }
  if (ref.index > imgs.length) {
    return { error: `消息 #${ref.mid} 只有 ${imgs.length} 张图，没有第 ${ref.index} 张` }
  }
  const pick = imgs[ref.index - 1]
  return { mid: ref.mid, index: ref.index, url: String(pick.url || ''), file: String(pick.file || ''), total: imgs.length }
}

/**
 * 下载那张图的字节。QQ 的图片直链会过期，所以：先用存档里的地址，
 * 失败了再让 OneBot 重签一次（onebot.freshImageUrlOfMessage），跟 send_sticker 一个思路。
 */
async function downloadChatImage(img, maxBytes) {
  const attempt = async (u) => {
    const res = await fetch(u, {
      headers: { 'user-agent': UA, referer: `${QZONE}/` },
      signal: AbortSignal.timeout(IMG_DOWNLOAD_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('下回来是空的')
    return buf
  }

  const urls = img.url ? [img.url] : []
  let lastErr = '存档里没有可用的图片地址'
  for (const u of urls) {
    try {
      const buf = await attempt(u)
      return finishDownload(buf, maxBytes)
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  // 直链过期兜底：问 OneBot 要这条消息的新地址
  if (typeof onebotRef?.freshImageUrlOfMessage === 'function') {
    try {
      const fresh = await onebotRef.freshImageUrlOfMessage(img.mid, img.file)
      if (fresh && !urls.includes(fresh)) {
        const buf = await attempt(fresh)
        return finishDownload(buf, maxBytes)
      }
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  return { error: `图片下载不了：${lastErr}` }
}

function finishDownload(buf, maxBytes) {
  if (buf.length > maxBytes) {
    return { error: `图片 ${(buf.length / 1048576).toFixed(1)}MB，超过上限 ${(maxBytes / 1048576).toFixed(0)}MB，发不了` }
  }
  const kind = imageKindOf(buf)
  if (!kind) return { error: '那张图不是 Qzone 认的格式（只支持 jpg/png/gif/webp/bmp）' }
  return { buf, kind }
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
  const j = parseQzoneLooseJson(await qzonePost(`${QZONE_UPLOAD}?g_tk=${gtk2}`, form, cookies), '上传图片')
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
   六、四个工具的实现
   ══════════════════════════════════════════════════════════════════════ */

async function doPostMood(content, images, ctx) {
  const cfg = cfgOf()
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxPostChars) || 500))
  if (!text) return { content: '说说内容不能为空', isError: true }

  // ── 图片：全部本地校验/解析完再出网（顺序别调，脏参数不许碰网络）──
  const wanted = Array.isArray(images) ? images : (images == null || images === '' ? [] : [images])
  const picked = []
  if (wanted.length) {
    if (cfg.allowChatImages === false) {
      return { content: '带图说说被关掉了（设置里"允许引用聊天里的图"是关的），这次只能发纯文字', isError: true }
    }
    const cap = Math.min(IMG_PER_POST_HARD_MAX, Math.max(1, Number(cfg.maxImagesPerPost) || IMG_PER_POST_DEFAULT))
    if (wanted.length > cap) {
      return { content: `一条说说最多带 ${cap} 张图，这次给了 ${wanted.length} 张`, isError: true }
    }
    for (const raw of wanted) {
      const ref = parseImageRef(raw)
      if (!ref) {
        return {
          content: `图片引用「${String(raw ?? '').slice(0, 40)}」不认。只能给聊天记录里的消息号（如 #12345，一条消息多图时用 #12345:2 指第 2 张）；路径、网址、base64 一律不收`,
          isError: true
        }
      }
      const got = resolveChatImage(ctx, ref)
      if (got.error) return { content: got.error, isError: true }
      picked.push(got)
    }
  }

  const st = loadState()
  const capCheck = checkCap(st, 'post', cfg)
  if (!capCheck.ok) return { content: capCheck.reason, isError: true }

  const auth = await acquireCookies()
  if (!auth.selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  // 全部图传成功再发说说：传一半就发，空间里会留下一条缺图的说说，收不回来
  const maxBytes = Math.min(32, Math.max(1, Number(cfg.maxImageMB) || IMG_MB_DEFAULT)) * 1024 * 1024
  const richvals = []
  for (const img of picked) {
    const dl = await downloadChatImage(img, maxBytes)
    if (dl.error) {
      dbg('image', false, `#${img.mid} 下载失败：${dl.error}`)
      return { content: dl.error, isError: true }
    }
    try {
      const up = await uploadQzoneImage(auth, dl.buf)
      richvals.push(up.richval)
      dbg('image', true, `#${img.mid} 已上传（${dl.kind} ${up.width}x${up.height}）`)
    } catch (e) {
      dbg('image', false, `#${img.mid} 上传失败：${String(e?.message ?? e).slice(0, 100)}`)
      return { content: `图片上传失败：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
  }

  const withPic = richvals.length > 0
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: withPic ? '1' : '',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    who: '1',
    con: text,
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
    const j = parseQzoneLooseJson(
      await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies),
      '发说说'
    )
    // 没有 tid 就是没发成：空间拒稿时也返回 200，只有 tid 是"服务器真收下了"的凭据
    tid = String(j?.t1_tid ?? j?.tid ?? '')
    if (!tid) throw new Error('发说说失败：响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
  } catch (e) {
    dbg('post_mood', false, String(e?.message ?? e).slice(0, 120))
    return { content: String(e?.message ?? e).slice(0, 200), isError: true }
  }
  recordAct(st, 'post', null)
  dbg('post_mood', true, `tid=${tid}，${text.length} 字${withPic ? `，${richvals.length} 图` : ''}`)
  return {
    content: `已发到你的 QQ 空间：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」${withPic ? `（带 ${richvals.length} 张图）` : ''}`
  }
}

function feedToItem(f) {
  const uin = String(f?.uin ?? '')
  const tid = String(f?.key ?? '')
  if (!isValidUin(uin) || !isValidTid(tid)) return null
  const abstime = Number(f?.abstime) || 0
  const nick = String(f?.nickname ?? '').trim() || uin
  const html = f?.html ?? ''
  const text = feedTextOf(html)
  const { likes, comments, truncated } = feedCountsOf(html)
  // 纯图 / 纯转发说说没有 f-info：**不再整条丢掉**（以前会把好友的图说说从列表里
  // 直接吞掉），标成"（无文字）"就好，tid 仍然有效、能点赞能读评论。
  return {
    uin, tid, nick,
    time: fmtLocal(abstime * 1000),
    likes, comments,
    cmtMore: !!truncated,        // 列表里被截断（还有更早的评论没渲染）
    text: text || '（无文字）'
  }
}

async function fetchFeeds(count) {
  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) throw new Error('识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）')
  const text = await qzoneGet('/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more', {
    uin: selfUin,
    scope: '0',
    view: '1',
    filter: 'all',
    flag: '1',
    applist: 'all',
    pagenum: '1',
    aisortEndTime: '0',
    aisortOffset: '0',
    aisortBeginTime: '0',
    begintime: '0',
    format: 'json',
    g_tk: gtk2,
    useutf8: '1',
    outputhtmlfeed: '1'
  }, cookies)
  const j = parseQzoneJson(text, '拉取动态')
  const rawItems = j?.data?.data
  if (!Array.isArray(rawItems)) return { items: [], hasMore: false }
  const items = []
  for (const f of rawItems) {
    if (items.length >= count) break
    if (String(f?.appid ?? '311') !== '311') continue   // 只认"说说"，过滤相册/分享等多媒体动态
    const it = feedToItem(f)
    if (it) items.push(it)
  }
  return { items, hasMore: !!j?.data?.main?.hasMoreFeeds, selfUin }
}

async function doListFeeds(countArg) {
  const cfg = cfgOf()
  const count = Math.min(20, Math.max(1, Number(countArg) || Number(cfg.maxFeeds) || 10))
  const st = loadState()
  const now = Date.now()
  const interval = Math.max(0, Number(cfg.browseIntervalMinutes) || 0) * 60000

  // 刷动态是只读但带"打扰度"：太频繁的调用直接喂上一次缓存
  if (interval > 0 && now - (st.lastBrowse || 0) < interval && st.feedCache) {
    const cached = st.feedCache.items.slice(0, count)
    return { content: formatFeeds(cached, st, true, false, st.feedCache.selfUin || '') }
  }

  const { items, hasMore, selfUin } = await fetchFeeds(count)
  st.lastBrowse = now
  st.feedCache = { t: now, items, selfUin }
  saveState(st)
  dbg('list_feeds', true, `${items.length} 条`)
  return { content: formatFeeds(items, st, false, hasMore, selfUin) }
}

function formatFeeds(items, st, fromCache, hasMore = false, selfUin = '') {
  if (!items.length) return '好友动态里暂时没有能看懂的说说（可能有转发类动态被跳过了）。'
  const acted = st.acted || {}
  const me = String(selfUin || '')
  const lines = items.map((f, i) => {
    const mark = `${me && f.uin === me ? '（你自己发的）' : ''}${acted[`${f.uin}:${f.tid}`] ? '（已互动过）' : ''}`
    const likePart = f.likes > 0 ? `，${f.likes} 人觉得很赞` : ''
    const cmtPart = f.comments > 0 ? `，${f.comments}${f.cmtMore ? '+' : ''} 条评论` : ''
    return `${i + 1}. [${f.nick}(${f.uin}) ${f.time}${likePart}${cmtPart}] ${f.text}（tid: ${f.tid}）${mark}`
  })
  const head = fromCache ? '（距上次刷动态不久，这是缓存的上一次结果）' : ''
  const tail = hasMore ? '\n还有更早的动态，需要的话可以说"再看几条"。' : ''
  return `${head}刷到 ${items.length} 条好友说说：\n${lines.join('\n')}\n想点赞用 qzone__like_feed，想评论用 qzone__comment_feed，uin 和 tid 照抄上面；**想看某条说说下面的评论正文与回复**，用 qzone__read_comments（uin + tid 照抄）。${tail}`.trim()
}

/**
 * 读某条说说的**评论与回复**。
 * uin / tid 都可以省：省了就去动态流里找她自己最近发的那条（她自己发的最靠前）。
 * 数据源是 PC 版「说说详情」接口 —— 列表接口只有渲染好的前几条评论，读不出结构。
 */
async function doReadComments(uinArg, tidArg, countArg) {
  const cfg = cfgOf()
  let uin = String(uinArg ?? '').trim()
  let tid = String(tidArg ?? '').trim()

  // 定位给全了就先验参数：脏参数不该先跑去要 cookie（与"脏参数拦在出网前"同一纪律）
  if (uin && tid) {
    if (!isValidUin(uin)) return { content: `uin 不合法：${uin.slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
    if (!isValidTid(tid)) return { content: `tid 不合法：${tid.slice(0, 30)}（必须是 24 位十六进制，从 qzone__list_feeds 原样抄回）`, isError: true }
  }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  let auto = false
  if (!uin || !tid) {
    let items = []
    try {
      ({ items } = await fetchFeeds(20))
    } catch (e) {
      return { content: `想自动找你自己最新的说说，但拉动态失败了：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
    const mine = items.find((x) => x.uin === selfUin)
    if (!mine) {
      return {
        content: '动态流里没找到你自己发的说说（可能最近没发，或被空间折叠了）。要看某条好友说说的评论，就把 list_feeds 给的 uin 和 tid 传进来。',
        isError: true
      }
    }
    uin = mine.uin; tid = mine.tid; auto = true
  }

  const num = Math.min(CMTS_PER_FEED_HARD_MAX, Math.max(1, Number(countArg) || Number(cfg.maxComments) || CMTS_PER_FEED_DEFAULT))
  const params = {
    uin, tid,
    t1_source: '1', ftype: '0', sort: '0', pos: '0', num: String(num),
    g_tk: gtk2, callback: '_preloadCallback', code_version: '1', format: 'jsonp', need_private_comment: '1'
  }
  let j
  try {
    j = parseQzoneJson(await qzoneGet(QZONE_DETAIL, params, cookies), '读评论')
  } catch (e) {
    dbg('read_comments', false, String(e?.message ?? e).slice(0, 120))
    return { content: String(e?.message ?? e).slice(0, 200), isError: true }
  }
  const d = parseMsgDetail(j)
  if (!d) return { content: '这条说说读不出来（详情响应里没有可识别的 tid，可能已经被删了）。', isError: true }

  // 她已经自己读过了 → 收件箱里这条说说的提示清掉，别下一轮再提示一遍
  clearInboxFor(uin, tid)

  const head = auto ? '（你没给定位，这是你自己最近发的那条说说）\n' : ''
  dbg('read_comments', true, `${tid} 评论 ${d.list.length}/${d.declared}`)
  return { content: head + formatCommentThread(d, selfUin) }
}

async function doLikeFeed(uin, tid) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 qzone__list_feeds 原样抄回）`, isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复点。', isError: true }
  const cap = checkCap(st, 'like', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const unikey = `${QZONE}/${uin}/mood/${tid}`
  const form = {
    qzreferrer: `${QZONE}/${selfUin}`,
    opuin: selfUin,
    unikey,
    curkey: unikey,
    appid: '311',
    from: '1',
    typeid: '0',
    abstime: String(Math.floor(Date.now() / 1000)),
    fid: String(tid),
    active: '0',
    format: 'json',
    fupdate: '1'
  }
  parseQzoneJson(
    await qzonePost(`/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${gtk2}`, form, cookies),
    '点赞'
  )
  recordAct(st, 'like', feedId)
  dbg('like_feed', true, feedId)
  return { content: `已给 ${uin} 的这条说说点赞。` }
}

async function doCommentFeed(uin, tid, content) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 qzone__list_feeds 原样抄回）`, isError: true }
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxCommentChars) || 200))
  if (!text) return { content: '评论内容不能为空', isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复刷评论。', isError: true }
  const cap = checkCap(st, 'comment', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const form = {
    topicId: `${uin}_${tid}__1`,
    uin: selfUin,
    hostUin: String(uin),
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: text
  }
  await postReFeeds(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${gtk2}`, form, cookies, '评论')
  recordAct(st, 'comment', feedId)
  dbg('comment_feed', true, `${feedId} «${text.slice(0, 20)}»`)
  return { content: `已在 ${uin} 的说说下评论：「${text}」` }
}

/**
 * 回复某条评论（或某一层里的一条回复）。
 *
 * 与顶层评论（doCommentFeed）的差别，是**实测出来**的，不是猜的：
 *   ① 表单要多 `commentId` + `commentUin` —— 锚定被回复的**那层评论**；
 *   ② content 开头要带 Qzone 原生关系标记 `@{uin:..,nick:..,who:1,auto:1}` ——
 *      网页端回复时生成的就是它（实测 commentlist[i].list_3 的 content 原样如此）；
 *   ③ 回复「楼中回复」时锚点仍是所属楼层，@的才是被回复者本人。
 * 序号口径刻意对齐 qzone__read_comments 的输出（那里就是 1、2、3 编号）——
 * 模型不用自己去翻协议里的 tid，照抄它刚看到的编号就行。
 */
async function doReplyComment(uin, tid, commentNo, replyNo, content) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 qzone__read_comments / qzone__list_feeds 原样抄回）`, isError: true }
  const no = Number(commentNo)
  if (!Number.isInteger(no) || no < 1 || no > CMTS_PER_FEED_HARD_MAX) {
    return { content: 'comment 要填评论序号（read_comments 结果里那个 1、2、3），从 1 开始。', isError: true }
  }
  let rn = null
  if (replyNo != null && String(replyNo).trim() !== '') {
    rn = Number(replyNo)
    if (!Number.isInteger(rn) || rn < 1 || rn > CMTS_PER_FEED_HARD_MAX) {
      return { content: 'reply 要填那一层里第几条回复（read_comments 结果里「└」的行序），从 1 开始。', isError: true }
    }
  }
  // 模型可能自己拼了 @ 标记 —— 连它前面的 @ 一起剥掉（只剥 {uin:…} 会留个孤零零的 @）。
  // 标记由我们自己按真实 uin 加，防双 @ / 防拼错。
  const raw = String(content ?? '').replace(/@?\{uin:\d+,[^}]*\}/g, ' ')
  const text = sanitizeText(raw, Math.max(1, Number(cfg.maxCommentChars) || 200))
  if (!text) return { content: '回复内容不能为空', isError: true }

  const st = loadState()
  const cap = checkCap(st, 'comment', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  // 先读一遍评论，把"第几条"翻译成协议要的 commentId / commentUin。
  // 必须现读：楼层号会随别人删评论而变，缓存里的序号会指错人。
  let d
  try {
    const j = parseQzoneJson(await qzoneGet(QZONE_DETAIL, {
      uin, tid, t1_source: '1', ftype: '0', sort: '0', pos: '0',
      num: String(CMTS_PER_FEED_HARD_MAX),
      g_tk: gtk2, callback: '_preloadCallback', code_version: '1', format: 'jsonp', need_private_comment: '1'
    }, cookies), '读评论')
    d = parseMsgDetail(j)
  } catch (e) {
    dbg('reply_comment', false, String(e?.message ?? e).slice(0, 120))
    return { content: String(e?.message ?? e).slice(0, 200), isError: true }
  }
  if (!d) return { content: '这条说说读不出来（可能已经被删了）。', isError: true }

  const anchor = d.list[no - 1]
  if (!anchor) {
    return { content: `这条说说下只有 ${d.list.length} 条评论，没有第 ${no} 条。先 qzone__read_comments 看一眼再回。`, isError: true }
  }
  let target = anchor
  if (rn != null) {
    target = anchor.replies[rn - 1]
    if (!target) {
      return { content: `第 ${no} 条评论下只有 ${anchor.replies.length} 条回复，没有第 ${rn} 条。`, isError: true }
    }
  }

  const actedKey = `${String(uin).trim()}:${String(tid).trim()}:r${anchor.tid}${rn != null ? `-${rn}` : ''}`
  if (st.acted?.[actedKey]) return { content: '这条你已经回过了，别重复。', isError: true }

  const form = {
    topicId: `${uin}_${tid}__1`,
    uin: selfUin,
    hostUin: String(uin),
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: `@{uin:${target.uin},nick:${target.name},who:1,auto:1} ${text}`,
    commentId: String(anchor.tid),
    commentUin: String(anchor.uin),
    richval: '',
    richtype: '',
    private: '0',
    paramstr: '1',
    qzreferrer: `${QZONE}/${selfUin}/main`
  }
  await postReFeeds(`${QZONE_REPLY}?g_tk=${gtk2}`, form, cookies, '回复评论')
  recordAct(st, 'comment', actedKey)
  // 回过了 → 收件箱里这条（这一层）的提示清掉
  clearInboxFor(uin, tid, anchor.tid, rn != null ? target.tid : '')
  dbg('reply_comment', true, `${uin}:${tid} 楼层${no}${rn != null ? `回复${rn}` : ''} «${text.slice(0, 20)}»`)
  return { content: `已回复 ${target.name}：「${text}」` }
}

/* ══════════════════════════════════════════════════════════════════════
   六·五、评论收件箱（1.4.0）：轮询自己的说说，有人评论就静默带给她
   ══════════════════════════════════════════════════════════════════════

   为什么是"静默带出"而不是主动发消息：宿主**没有** proactive 能力，v0.4.5 的
   `capabilities` 里也**没有任何核心发送能力提供者**（`chat.send` 根本没人提供，
   silence-ping 试了它再退到 OneBot HTTP 直发）。要主动开口只能自己拼 OneBot
   HTTP —— 那是**替她说话**，打扰、且发出去收不回来。改成：

     定时器轮询 → 新评论落 data/qzone/inbox.json
       → before-llm-messages 钩子把它追加到**最后一条 user 消息**尾部
         （只动尾部：system+tools 是字节前缀缓存，往中间插东西会让后面全废）
       → 她自己决定要不要去回复

   ── 省流的"计数闸门" ────────────────────────────────────────────────
   每轮先拉 1 次动态流：列表 html 里 `data-type="commentroot"` 的条数（+是否有
   "查看更多"）就是**评论数的廉价代理**。与上次一致 → 跳过详情请求。只有变了
   才去读 `emotion_cgi_msgdetail_v6`。稳态每轮 1 个请求，有变化时最多 3 个。

   ── 两个必须记住的边界 ──────────────────────────────────────────────
   ① **首轮（以及第一次遇到某条说说时）只把 `inboxFirstRunHours` 小时内的
      评论当新评论**，更早的静默记为已见 —— 否则插件一上线就把几个月的旧评论
      全砸给她，还会让她去回几个月前的话。
   ② **序号不能写进提示**。qzone__read_comments 的 1/2/3 会随别人删评论而变，
      qzone__reply_comment 又拿这个序号去现读翻译，写死了就会回错人。所以提示里只给
      "谁说了什么"，要看第几条让她自己现读。
   ══════════════════════════════════════════════════════════════════════ */

const INBOX_PENDING_MAX = 20        // 收件箱最多攒多少条（超出丢最旧的）
const INBOX_SHOW_MAX = 3            // 一次最多提示几条（免得一屏塞满）
const BROWSE_QUEUE_MAX = 20         // 自动巡视队列上限
const BROWSE_SHOW_MAX = 3           // 自动巡视一次最多带出几条
const BROWSE_SEEN_MAX = 600         // browseSeen 记忆上限（按时间淘汰最旧的）
const POLL_MIN_MS = 60 * 1000       // 再配也快不过 1 分钟一轮
const POLL_MAX_MS = 6 * 60 * 60 * 1000
const POLL_BOOT_DELAY_MS = 90 * 1000   // 开机高峰（插件加载/价格表/遥测）之后再首轮

function inboxFile() {
  return path.join(dataDir(), SKILL_ID, 'inbox.json')
}

function defaultInbox() {
  return {
    feeds: [], seen: {}, counts: {}, pending: [], seededAt: 0, lastPollAt: 0,
    // ── 自动巡视（1.5.0）──
    browse: [],          // 待带出的**好友**新动态队列（与 pending 分开：语义、文案都不同）
    browseSeen: {},      // `uin:tid` → 已入过队的时间戳（防同一条反复入队）
    browseSeededAt: 0    // 首次巡视只做标记、不入队（别一上线把历史动态全砸给她）
  }
}

export function loadInbox() {
  try {
    const j = JSON.parse(fs.readFileSync(inboxFile(), 'utf8'))
    return {
      ...defaultInbox(),
      ...(j && typeof j === 'object' ? j : {}),
      feeds: Array.isArray(j?.feeds) ? j.feeds : [],
      seen: (j && typeof j.seen === 'object' && j.seen) || {},
      counts: (j && typeof j.counts === 'object' && j.counts) || {},
      pending: Array.isArray(j?.pending) ? j.pending : []
    }
  } catch {
    return defaultInbox()
  }
}

function saveInbox(ib) {
  const file = inboxFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(ib, null, 2), 'utf8')
    fs.renameSync(tmp, file)      // 原子替换，与 state.json 同一纪律
  } catch (e) {
    dbg('inbox-save', false, String(e?.message ?? e).slice(0, 100))
  }
}

/**
 * 评论时间串 → 毫秒。拿不准就返回 0（调用方把 0 当"老评论"处理，宁可漏报不误报）。
 * 实测两种形态都有：`2026-10-07 17:06:45`（createTime2）和 `10月07日 17:06`。
 */
export function parseCommentTime(s, now = Date.now()) {
  const t = String(s ?? '').trim()
  if (!t) return 0
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
  m = /^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/.exec(t)
  if (m) return new Date(new Date(now).getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime()
  m = /^(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(t)
  if (m) return new Date(new Date(now).getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]).getTime()
  return 0
}

/**
 * 详情 → 扁平的条目列表（评论 + 楼中回复各算一条），id 口径稳定可复现。
 * `id` 是差集与去重的唯一键：`<前缀>:楼层` / `<前缀>:楼层:r回复`。
 * 前缀默认取详情自己的 `uin:tid`；轮询时传"跟踪的那条说说"的键，
 * 这样 **seen 的键与 counts 的键始终一致**（详情里的 tid 理论上等于列表的 key，
 * 但两者一旦不一致，差集就会整批重报 —— 所以宁可显式指定，不靠它们碰巧相同）。
 */
export function enumerateComments(d, prefix = '') {
  const out = []
  if (!d || !Array.isArray(d.list)) return out
  const p = prefix || `${d.uin}:${d.tid}`
  d.list.forEach((c, i) => {
    const ckey = c.tid ? String(c.tid) : `c${i + 1}`
    const base = `${p}:${ckey}`
    out.push({
      id: base, kind: 'comment', ctid: ckey, rtid: '',
      uin: c.uin, name: c.name, text: c.content, time: c.time,
      floor: i + 1, replyFloor: 0
    })
    c.replies.forEach((r, j) => {
      const rkey = r.tid ? `r${r.tid}` : `r${j + 1}`
      out.push({
        id: `${base}:${rkey}`, kind: 'reply', ctid: ckey, rtid: rkey,
        uin: r.uin, name: r.name, text: r.content, time: r.time,
        floor: i + 1, replyFloor: j + 1
      })
    })
  })
  return out
}

/**
 * 一轮轮询。抛错由调用方兜（不抛到钩子/定时器外面）。
 * 返回 { feeds, read, added, pending }。
 */
export async function pollOnce(now = Date.now()) {
  const cfg = cfgOf()
  const ib = loadInbox()
  const firstRun = !ib.seededAt
  const want = Math.max(1, Math.min(5, Number(cfg.pollFeedCount) || 2))
  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) throw new Error('识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）')

  // ① 动态流：找她自己最近几条说说。找不到就沿用上次跟踪的那几条，
  //    免得"好友刷屏把她挤到第二页"时跟踪突然断掉。
  const { items } = await fetchFeeds(40)
  const mine = items.filter((x) => x.uin === selfUin && isValidTid(x.tid)).slice(0, want)
  if (mine.length) {
    ib.feeds = mine.map((x) => ({
      uin: x.uin, tid: x.tid,
      head: String(x.text || '').slice(0, 40),
      time: x.time || ''
    }))
  }
  // ①.5 自动巡视（1.5.0）：从**同一批**动态流里挑出好友的新说说 → 进 browse 队列。
  //   ★ 零额外请求：items 本来就是上面为查评论拉的 40 条。
  //   ★ 绝不因"有新动态"唤醒她 —— 队列只由 before-llm-messages 在她**本来就要开口**的
  //     那一轮带出（与 inbox 同一条纪律：不替她开口、不主动发消息）。
  //   ★ 放在 `if (!ib.feeds.length)` 那个提前 return **之前** —— 否则她没发过说说时
  //     巡视永远不会跑（这是最容易踩的位置坑）。
  if (cfg.browseAutoEnabled !== false) {
    const seenB = { ...(ib.browseSeen || {}) }
    const firstBrowse = !ib.browseSeededAt
    const maxPick = Math.max(0, Math.min(10, Number(cfg.browseAutoMaxItems) || 3))
    ib.browse = Array.isArray(ib.browse) ? ib.browse : []
    let picked = 0
    for (const x of items) {
      if (picked >= maxPick) break
      if (!x || x.uin === selfUin) continue                  // 只巡视**好友**的
      if (!isValidUin(x.uin) || !isValidTid(x.tid)) continue
      const bkey = `${x.uin}:${x.tid}`
      if (seenB[bkey]) continue
      seenB[bkey] = now
      if (firstBrowse) continue                              // 首次只标记：不把历史动态砸给她
      if (ib.browse.some((b) => b.key === bkey)) continue
      const txt = String(x.text || '').trim()
      if (!txt || txt === '（无文字）') continue              // 纯图/纯转发，没话可接
      ib.browse.push({
        key: bkey, uin: String(x.uin), tid: String(x.tid),
        nick: String(x.nick || x.uin), time: String(x.time || ''),
        text: txt.slice(0, 80),
        likes: Number(x.likes) || 0, comments: Number(x.comments) || 0,
        at: now, shown: 0
      })
      picked += 1
    }
    // browseSeen 别无限长：超过上限按时间淘汰最旧的
    const bkeys = Object.keys(seenB)
    if (bkeys.length > BROWSE_SEEN_MAX) {
      bkeys.sort((a, b) => (seenB[a] || 0) - (seenB[b] || 0))
      for (let i = 0; i < bkeys.length - BROWSE_SEEN_MAX; i += 1) delete seenB[bkeys[i]]
    }
    ib.browseSeen = seenB
    ib.browseSeededAt = ib.browseSeededAt || now
    const bShows = Math.max(1, Number(cfg.browseAutoMaxShows) || 2)
    const bTtl = Math.max(1, Number(cfg.browseAutoTtlHours) || 12) * HOUR_MS
    ib.browse = ib.browse
      .filter((e) => (e.shown || 0) < bShows && now - (e.at || now) < bTtl)
      .slice(-BROWSE_QUEUE_MAX)
  }

  if (!ib.feeds.length) {
    ib.seededAt = ib.seededAt || now
    ib.lastPollAt = now
    saveInbox(ib)
    return { feeds: 0, read: 0, added: 0, pending: ib.pending.length }
  }

  const hours = Math.max(0, Number(cfg.inboxFirstRunHours) || 48)
  const cutoff = now - hours * HOUR_MS
  let read = 0
  let added = 0

  // ② 逐条走"计数闸门"：列表计数没变就别花详情请求
  for (const f of ib.feeds) {
    const key = `${f.uin}:${f.tid}`
    const item = mine.find((x) => x.uin === f.uin && x.tid === f.tid)
    if (item) {
      const sig = `${item.comments || 0}${item.cmtMore ? '+' : ''}`
      if (ib.counts[key] === sig) continue
    }
    let d
    try {
      d = parseMsgDetail(parseQzoneJson(await qzoneGet(QZONE_DETAIL, {
        uin: f.uin, tid: f.tid,
        t1_source: '1', ftype: '0', sort: '0', pos: '0',
        num: String(CMTS_PER_FEED_HARD_MAX),
        g_tk: gtk2, callback: '_preloadCallback', code_version: '1', format: 'jsonp', need_private_comment: '1'
      }, cookies), '读评论'))
    } catch (e) {
      dbg('poll-detail', false, `${key}｜${String(e?.message ?? e).slice(0, 100)}`)
      continue
    }
    if (!d) continue
    read += 1

    const cold = !Array.isArray(ib.seen[key])      // 第一次遇到这条说说
    const useCutoff = firstRun || cold
    const seenSet = new Set(ib.seen[key] || [])
    for (const e of enumerateComments(d, key)) {
      if (seenSet.has(e.id)) continue
      seenSet.add(e.id)                             // 先记已见：即使被下面 continue 掉也不会重报
      if (e.uin === selfUin) continue               // 她自己留的不提示
      const ts = parseCommentTime(e.time, now)
      if (useCutoff && (!ts || ts < cutoff)) continue
      if (ib.pending.some((p) => p.id === e.id)) continue
      ib.pending.push({
        id: e.id, uin: f.uin, tid: f.tid, ctid: e.ctid, rtid: e.rtid, kind: e.kind,
        from: e.name || e.uin, fromUin: e.uin, text: e.text, ts,
        floor: e.floor, replyFloor: e.replyFloor,
        feedHead: f.head, feedTime: f.time, at: now, shown: 0
      })
      added += 1
    }
    ib.seen[key] = [...seenSet]
    if (item) ib.counts[key] = `${item.comments || 0}${item.cmtMore ? '+' : ''}`
  }

  // ③ 清过期：提示够次数、或超过 TTL 的就丢掉，别一直挂在上下文里
  const maxShows = Math.max(1, Number(cfg.inboxMaxShows) || INBOX_SHOW_MAX)
  const ttl = Math.max(1, Number(cfg.inboxTtlHours) || 24) * HOUR_MS
  ib.pending = ib.pending
    .filter((e) => (e.shown || 0) < maxShows && now - (e.at || now) < ttl)
    .slice(-INBOX_PENDING_MAX)

  ib.seededAt = ib.seededAt || now
  ib.lastPollAt = now
  saveInbox(ib)
  return { feeds: ib.feeds.length, read, added, pending: ib.pending.length }
}

/**
 * 组装要注入给她看的"空间新评论"块。返回空串表示没什么可说的。
 * ⚠️ 每调用一次就把这几条的 `shown` +1 —— 同一批最多提示 inboxMaxShows 轮。
 */
export function inboxBlock() {
  const cfg = cfgOf()
  if (cfg.inboxEnabled === false) return ''
  let ib
  try { ib = loadInbox() } catch { return '' }
  if (!ib.pending.length) return ''

  // 这里也要过一遍"提示次数/TTL"闸门：清理由轮询那侧做，但两轮之间
  // 钩子会被调用很多次，不在这儿过滤的话同一批能刷出几十遍。
  const maxShows = Math.max(1, Number(cfg.inboxMaxShows) || INBOX_SHOW_MAX)
  const ttl = Math.max(1, Number(cfg.inboxTtlHours) || 24) * HOUR_MS
  const now = Date.now()
  const live = ib.pending.filter((e) => (e.shown || 0) < maxShows && now - (e.at || now) < ttl)
  if (!live.length) return ''

  const fresh = live.slice(-INBOX_SHOW_MAX)
  const groups = new Map()
  for (const e of fresh) {
    const gk = `${e.uin}:${e.tid}`
    if (!groups.has(gk)) groups.set(gk, [])
    groups.get(gk).push(e)
  }

  const lines = ['【空间新评论】有人在你自己的说说下面留言了（你大概还没看过）：']
  for (const list of groups.values()) {
    const head = list[0]
    lines.push(`· 你的说说${head.feedTime ? `（${head.feedTime}）` : ''}「${head.feedHead || '（无文字）'}」`)
    for (const e of list) {
      const verb = e.kind === 'reply' ? '回复了你' : '评论'
      let text = String(e.text || '').trim()
      if (e.kind === 'reply') {
        // 楼中回复开头那个 @ 就是"我在回谁" —— 已经由"回复了你"表达了，去掉更干净
        // （剥完是空的就保留原文，别把她的话吃没了）
        const stripped = text.replace(/^@\S+\s+/, '').trim()
        if (stripped) text = stripped
      }
      lines.push(`    - ${e.from}(${e.fromUin}) ${verb}：${text || '（表情或空）'}`)
    }
  }
  lines.push('想看完整对话：qzone__read_comments（不给参数就是你最近那条说说）；'
    + '想回某一条：先 read_comments 拿到它**当前**的序号，再用 qzone__reply_comment。'
    + '这是你自己的空间，回不回、怎么回都看你——但别人跟你说话了，你该是知情的。')

  for (const e of fresh) e.shown = (e.shown || 0) + 1
  saveInbox(ib)
  return lines.join('\n')
}

/**
 * 组装"自动巡视"带出的**好友新动态**块（1.5.0）。
 *
 * 与 inboxBlock 同一套纪律：只读本地 json、**不出网**（钩子 5 秒硬超时），
 * **不主动发消息** —— 只是在她本来就要开口的那一轮，把"你刚逛到的东西"放到她眼前。
 * ⚠️ 每调用一次就把带出的这几条 `shown` +1，同一批最多出现 browseAutoMaxShows 轮。
 */
export function browseBlock() {
  const cfg = cfgOf()
  if (cfg.browseAutoEnabled === false) return ''
  let ib
  try { ib = loadInbox() } catch { return '' }
  const list = Array.isArray(ib.browse) ? ib.browse : []
  if (!list.length) return ''

  const maxShows = Math.max(1, Number(cfg.browseAutoMaxShows) || 2)
  const ttl = Math.max(1, Number(cfg.browseAutoTtlHours) || 12) * HOUR_MS
  const now = Date.now()
  const live = list.filter((e) => (e.shown || 0) < maxShows && now - (e.at || now) < ttl)
  if (!live.length) return ''

  const show = live.slice(-BROWSE_SHOW_MAX)
  const lines = ['【好友新动态】你顺手翻了翻好友的空间，这几条是新的'
    + '（**别当播报念出来**，也不用每条都接——你只是随便逛逛）：']
  show.forEach((e, i) => {
    const like = e.likes > 0 ? `，${e.likes} 赞` : ''
    const cmt = e.comments > 0 ? `，${e.comments} 条评论` : ''
    lines.push(`${i + 1}. ${e.nick}(${e.uin}) ${e.time}${like}${cmt}：${e.text}（tid: ${e.tid}）`)
  })
  lines.push('看着顺眼可以用 qzone__like_feed 点赞，想接话用 qzone__comment_feed 评论'
    + '（uin、tid 照抄上面的）；想细看这条下面的评论用 qzone__read_comments。'
    + '都不感兴趣就当没看见。')

  const ids = new Set(show.map((x) => x.key))
  ib.browse = list.map((e) => (ids.has(e.key) ? { ...e, shown: (e.shown || 0) + 1 } : e))
  saveInbox(ib)
  return lines.join('\n')
}

/**
 * 把已读的从收件箱里清掉（避免刷屏）。
 *   clearInboxFor(u, t)            —— 整条说说的提示全清（她读过评论了）
 *   clearInboxFor(u, t, ctid)      —— 只清这一层（她回复了这一层的评论）
 *   clearInboxFor(u, t, ctid, rid) —— 只清这一条楼中回复
 * ⚠️ `ctid`/`rtid` 传**裸 tid** 即可（调用方拿的是协议里的 tid）；
 *    入箱里存的是 `r<tid>` 形态，这里统一去掉前缀再比。
 */
export function clearInboxFor(uin, tid, ctid = '', rtid = '') {
  try {
    const ib = loadInbox()
    const before = ib.pending.length
    if (!before) return 0
    const key = `${String(uin)}:${String(tid)}`
    const bare = (v) => String(v ?? '').replace(/^r/, '')
    const wantC = bare(ctid)
    const wantR = bare(rtid)
    ib.pending = ib.pending.filter((e) => {
      if (`${e.uin}:${e.tid}` !== key) return true
      if (!ctid) return false                                   // 整条说说读过了
      if (bare(e.ctid) !== wantC) return true
      if (!rtid) return false                                   // 回了一整层
      return !(e.kind === 'reply' && bare(e.rtid) === wantR)
    })
    if (ib.pending.length !== before) saveInbox(ib)
    return before - ib.pending.length
  } catch {
    return 0
  }
}

/** 只动尾部：system+tools 是字节前缀缓存，插在中间会让后面全部重算。 */
function appendInboxToTail(messages, text) {
  if (!Array.isArray(messages) || !messages.length) return false
  const block = `\n\n${String(text).trim()}`
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue
    if (typeof msg.content === 'string') { msg.content += block; return true }
    if (Array.isArray(msg.content)) { msg.content.push({ type: 'text', text: block }); return true }
    break
  }
  messages.push({ role: 'user', content: block.trim() })
  return true
}

/**
 * 钩子：把她空间里的新评论带出来（静默、不主动发消息）。
 * 钩子有 5 秒硬超时，所以这里**只读一个几 KB 的 json**，绝不出网 ——
 * 出网全在定时器那侧（runPoll），它超时也不影响她回话。
 */
export const hooks = {
  'before-llm-messages'(ctx = {}) {
    try {
      // 顺序有讲究：先"别人在她空间跟她说话"（要知情），再"她逛到的好友动态"（可看可不看）
      const block = [inboxBlock(), browseBlock()].filter(Boolean).join('\n\n')
      if (!block) return
      appendInboxToTail(ctx?.messages, block)
    } catch (error) {
      dbg('inbox-inject', false, String(error?.message ?? error).slice(0, 120))
    }
  }
}

/* ── 定时器：自调度 setTimeout 链（不是 setInterval）────────────────────
   每轮结束重读一次配置再排下一轮 —— 这样 UI 里改「轮询间隔 / 开不开收件箱」
   下一轮就生效，不必重启（setInterval 会把间隔写死在创建时）。 */

let pollTimer = null
let pollBusy = false
let lastPollErrSig = ''

function pollIntervalMs() {
  const cfg = cfgOf()
  const minutes = Math.max(1, Number(cfg.pollIntervalMinutes) || 15)
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, minutes * 60000))
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function scheduleNextPoll(delayMs) {
  stopPolling()
  pollTimer = setTimeout(async () => {
    try {
      const cfg = cfgOf()
      if (cfg.inboxEnabled !== false) {
        if (pollBusy) return
        // ★ 2026-10-24 风控锁：锁着就不出网（外层 finally 照常排下一轮，链条不断；
        //   锁按自然日失效，次日自动恢复轮询）。一天只记一条日志。
        if (riskLocked()) {
          if (riskNoted !== riskDayKey()) {
            riskNoted = riskDayKey()
            dbg('poll', false, `今天在风控锁里（${loadState().riskReason || '原因未记录'}）—— 本轮跳过出网，明天自动恢复`)
          }
          return
        }
        pollBusy = true
        try {
          const r = await pollOnce(Date.now())
          lastPollErrSig = ''
          dbg('poll', true, `说说 ${r.feeds} 条｜读详情 ${r.read}｜新评论 ${r.added}｜待提示 ${r.pending}`)
        } finally {
          pollBusy = false
        }
      }
    } catch (e) {
      // 同一个错误只报一次（bot 掉线时否则每 15 分钟刷一条一模一样的警告）
      const sig = String(e?.message ?? e).slice(0, 90)
      if (sig !== lastPollErrSig) {
        lastPollErrSig = sig
        dbg('poll', false, sig)
      }
    } finally {
      scheduleNextPoll(pollIntervalMs())
    }
  }, delayMs)
  try { pollTimer.unref?.() } catch { /* 老 node 没有 unref 就算了 */ }
}

/** 启动轮询。宿主在启动完成与手动重扫后都会调（app.js 的 reloadSkills）。 */
export function activate() {
  scheduleNextPoll(POLL_BOOT_DELAY_MS)
}

/** 停轮询。禁用 / 热重载第一段 / 卸载都会走到这里。 */
export function deactivate() {
  stopPolling()
}

/* ══════════════════════════════════════════════════════════════════════
   七、技能契约：setup / available / dispose / diagnose
   ══════════════════════════════════════════════════════════════════════ */

// orchestrator 的 ctx 里有 onebot；setup 的 api 没有。所以第一次执行工具时把它记下来，
// 之后取 cookie 都走它的常规通道（被 SnowLuma 1401 拒了再退到读配置文件那条路）。
function rememberOnebot(ctx) {
  if (!onebotRef && ctx && typeof ctx.onebot?.call === 'function') onebotRef = ctx.onebot
}

// 群聊闸门（与 doujin-lookup 同一套约定）
function gateByContext(ctx) {
  const cfg = cfgOf()
  if (cfg.allowInGroup === false && ctx?.kind === 'group') {
    return '此功能只在私聊可用'
  }
  return ''
}

let availCache = { t: 0, v: false }

// 同步：只探测"登录态有没有可能拿到"，不做网络
export function available() {
  const now = Date.now()
  if (now - availCache.t < 30000) return availCache.v
  let v = false
  if (onebotRef && typeof onebotRef.call === 'function' && onebotRef.httpUrl) v = true
  if (!v) {
    for (const dir of snowConfigCandidates()) {
      try {
        if (fs.readdirSync(dir).some((f) => /^onebot_.*\.json$/i.test(f))) { v = true; break }
      } catch { /* 目录不存在就换下一个 */ }
    }
  }
  availCache = { t: now, v }
  return v
}

export function diagnose() {
  const steps = debugLog.slice(-8).map((d) => `${fmtLocal(d.t)} ${d.ok == null ? '…' : d.ok ? '✓' : '✗'} ${d.step} ${d.detail}`)
  let inbox = '收件箱: 尚未创建'
  try {
    const ib = loadInbox()
    const cfg = cfgOf()
    inbox = `收件箱: 轮询${cfg.inboxEnabled === false ? '关' : '开'}（${pollIntervalMs() / 60000} 分钟/轮，定时器${pollTimer ? '在' : '没起'}）`
      + `｜跟踪 ${ib.feeds.length} 条说说｜待提示 ${ib.pending.length} 条`
      + `｜上次轮询 ${ib.lastPollAt ? fmtLocal(ib.lastPollAt) : '还没跑过'}`
  } catch { /* 读不出来就用默认文案 */ }
  return [
    `可用性（30s 缓存）: ${available() ? '是' : '否'}`,
    `onebot 通道: ${onebotRef && onebotRef.httpUrl ? '有' : '无'}`,
    `data 目录: ${dataDir()}`,
    `state 文件: ${fs.existsSync(stateFile()) ? '存在' : '尚未创建'}`,
    inbox,
    steps.length ? `最近动态:\n  ${steps.join('\n  ')}` : '尚无调用记录'
  ].join('\n')
}

export function dispose() {
  stopPolling()
  cookieCache = null
  onebotRef = null
  availCache = { t: 0, v: false }
  debugLog.length = 0
}

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  // ★ 2026-10-11：日志优先走**核心 logger**（`api.services().log`，会写进 data/logs/*.log）。
  //   原来只走 api.log ⇒ 只进 console ⇒ `dbg()` 打的 `[qzone] image: #xxx 上传失败：…`
  //   **在日志文件里一行都看不到**（实测：00:46 那次上传失败，全天日志里 qzone 只有她发的那句话）。
  //   同一个坑 image-generate / travel-whale 都踩过，接法一致。
  log = (...a) => {
    try {
      const svc = typeof api.services === 'function' ? api.services() : null
      if (svc && typeof svc.log === 'function') return svc.log(...a)
    } catch { /* 落回 api.log */ }
    try { api.log(...a) } catch { /* ignore */ }
  }
  onebotRef = api.onebot || api.context?.onebot || null

  api.registerTool({
    id: 'post_mood',
    name: '发说说',
    icon: '📝',
    description: '以你自己的身份发一条 QQ 空间说说。内容要真是你想发的，一两句、你的语气。可以带图：images 里放**聊天记录里的消息号**（如 "#12345"，那条消息有多张图时用 "#12345:2" 指第 2 张），只能引用你已经看到过的图，不接受路径、网址或 base64。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，第一人称、你自己的语气' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '要一起发的图，每项是聊天记录里的消息号（"#12345" 或 "#12345:2"）。不发图就别传。'
        }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doPostMood(args?.content, args?.images, ctx)
    }
  })

  api.registerTool({
    id: 'list_feeds',
    name: '刷好友动态',
    icon: '📰',
    description: '刷好友的 QQ 空间动态（只读），返回作者/时间/摘要/点赞数，供你决定要不要点赞评论。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '想看几条（默认取配置，上限 20）' }
      }
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doListFeeds(args?.count)
    }
  })

  api.registerTool({
    id: 'read_comments',
    name: '读说说评论',
    icon: '💭',
    description: '读某条说说下面的**评论正文和回复**（只读）。uin/tid 从 qzone__list_feeds 的返回里原样抄；两个都不传时，读你自己最近发的那条说说。想知道别人在评论里说了什么、有没有回你，就用这个——qzone__list_feeds 只给条数，看不到内容。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '说说作者的 QQ 号（list_feeds 返回里的 uin）。不传就找你自己最新的说说。' },
        tid: { type: 'string', description: '说说的 tid（list_feeds 返回里的 tid）。不传就找你自己最新的说说。' },
        count: { type: 'integer', description: '最多读几条评论（默认取配置，上限 50）' }
      }
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doReadComments(args?.uin, args?.tid, args?.count)
    }
  })

  api.registerTool({
    id: 'like_feed',
    name: '点赞说说',
    icon: '👍',
    description: '给指定好友的一条说说点赞。uin/tid 从 qzone__list_feeds 的返回里原样抄。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' }
      },
      required: ['uin', 'tid']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doLikeFeed(args?.uin, args?.tid)
    }
  })

  api.registerTool({
    id: 'comment_feed',
    name: '评论说说',
    icon: '💬',
    description: '给指定好友的一条说说写评论。uin/tid 从 qzone__list_feeds 的返回里原样抄，评论要短、像你本人。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' },
        content: { type: 'string', description: '评论内容' }
      },
      required: ['uin', 'tid', 'content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doCommentFeed(args?.uin, args?.tid, args?.content)
    }
  })

  api.registerTool({
    id: 'reply_comment',
    name: '回复评论',
    icon: '↩️',
    description: '回复某条说说下面**已有的某条评论**（不是发新评论）。'
      + '先用 qzone__read_comments 看评论列表，参数 comment 填那个编号（1、2、3…）；'
      + '想回复某层里的某条楼中回复，再填 reply（「└」那行的序号）。'
      + 'uin/tid 照抄 qzone__read_comments / qzone__list_feeds 返回的。',
    category: 'utility',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '说说作者的 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' },
        comment: { type: 'number', description: '要回复的评论序号，从 1 开始（read_comments 结果里的编号）' },
        reply: { type: 'number', description: '可选：回复某一层里的第几条楼中回复，从 1 开始' },
        content: { type: 'string', description: '回复内容（不要自己写 @，工具会自动带上）' }
      },
      required: ['uin', 'tid', 'comment', 'content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doReplyComment(args?.uin, args?.tid, args?.comment, args?.reply, args?.content)
    }
  })
}
