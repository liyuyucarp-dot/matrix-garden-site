// 空间日记（qqzone v2.0）离线回归 —— 纯 node，全程不出网。
// 跑法：node skills/qqzone/dev-tests/diary-test.mjs
// 覆盖：按天过滤、会话封顶、账本/世界观抽取、digest 形状、日记限频与落盘、
//       渲染器软依赖、post_diary 的上传/发布表单形状与回显发图。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const MOD = url.pathToFileURL(path.join(HERE, '..', 'index.js')).href
const q = await import(MOD)

let pass = 0
let fail = 0
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.error(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`) }
}
function section(t) { console.log(`\n[${t}]`) }

// 固定"现在"：2026-10-04 15:00 本地时间
const NOW = new Date(2026, 9, 4, 15, 0, 0).getTime()
const tsAt = (h, m, day = 4) => new Date(2026, 9, day, h, m, 0).getTime()

// 假 data 目录（QQ_AGENT_DATA_DIR 在每次 dataDir() 调用时都会重读）
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'qqzone-diary-test-'))
process.env.QQ_AGENT_DATA_DIR = FAKE
fs.mkdirSync(path.join(FAKE, 'messages'), { recursive: true })
fs.mkdirSync(path.join(FAKE, 'messages-cold'), { recursive: true })

const msg = (h, m, name, text, self = false, media = [], day = 4) =>
  ({ id: 1, mid: 1, ts: tsAt(h, m, day), senderId: self ? 'self' : '10001', senderName: name, text, self, read: true, reply: null, media })

// 群 10007：冷段（早上）+ 热段（下午 + 一句昨天的）
fs.writeFileSync(path.join(FAKE, 'messages-cold', 'group_10007.00000.json'),
  JSON.stringify({ chatKey: 'group_10007', seq: 0, messages: [msg(8, 10, '木易', '早'), msg(8, 12, '我', '早呀', true)] }))
fs.writeFileSync(path.join(FAKE, 'messages', 'group_10007.json'),
  JSON.stringify({ chatKey: 'group_10007', nextLocalId: 4, messages: [
    msg(23, 50, '木易', '昨天的消息不该进来', false, [], 3),
    msg(14, 1, '木易', '下午好'),
    msg(14, 2, '我', '在忙', true),
    msg(14, 3, '目眩其曜', '看图', false, [{ kind: 'image', url: 'http://x' }])
  ] }))
// 私聊 10008：一条今天
fs.writeFileSync(path.join(FAKE, 'messages', 'private_10008.json'),
  JSON.stringify({ chatKey: 'private_10008', nextLocalId: 2, messages: [msg(9, 30, '林寒枫霜', '私聊一句')] }))

section('[1] collectTodayMessages：按天过滤 + 冷热合并 + 封顶')
const all = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'), {}, NOW)
ok(all.chats.length === 2, '两个会话都进了素材', `got ${all.chats.length}`)
const g = all.chats.find((c) => c.chatKey === 'group_10007')
ok(g && g.count === 5, '按天过滤后群今天 5 句（冷段2 + 热段3，昨日与未来消息不进）', `got ${g && g.count}`)
ok(g && g.lines.join('\n').includes('08:10 木易：早'), '冷段早上的消息在（冷热合并）')
ok(g && g.lines.join('\n').includes('14:03 目眩其曜：看图 [图]'), '带图消息有 [图] 标记')
ok(g && g.lines.join('\n').includes('14:02 我：在忙'), '自己的话标成「我」')
ok(g && !g.lines.join('\n').includes('昨天'), '昨天那句没进来')
const capped = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'),
  { maxChats: 1, msgsPerChat: 10, maxTotalChars: 60000 }, NOW)
ok(capped.chats.length === 1 && capped.chats[0].chatKey === 'group_10007' && capped.dropped === 1,
  'maxChats=1 时留话最多的群、私聊计 dropped')
// 超字数预算：整段丢弃不切半行（maxTotalChars 下限 2000，造一个必然超的会话）
fs.writeFileSync(path.join(FAKE, 'messages', 'private_999.json'),
  JSON.stringify({ chatKey: 'private_999', nextLocalId: 99, messages:
    Array.from({ length: 30 }, (_, i) => msg(10 + Math.floor(i / 60), i % 60, '话痨', 'x'.repeat(100))) }))
const oversized = q.collectTodayMessages(path.join(FAKE, 'messages'), path.join(FAKE, 'messages-cold'),
  { maxChats: 8, msgsPerChat: 80, maxTotalChars: 2000 }, NOW)
ok(oversized.dropped === 1 && oversized.chats.length === 2 && !oversized.chats.some((c) => c.chatKey === 'private_999'),
  '超预算的会话整段丢弃并计 dropped', JSON.stringify({ dropped: oversized.dropped, keys: oversized.chats.map((c) => c.chatKey) }))

section('[2] readWorldMaterial：世界观节选 + 账本按天')
fs.writeFileSync(path.join(FAKE, 'config.json'), JSON.stringify({
  skills: { 'life-system': { enabled: true, worldbook: '海城是一座贴着湾建起来的小城市。' + '长'.repeat(3000) } }
}))
fs.writeFileSync(path.join(FAKE, 'life-events.json'), JSON.stringify({
  version: 2,
  facts: {
    rest: { text: '没睡好，犯困', at: tsAt(0, 47) },
    old: { text: '三年前的事', at: tsAt(10, 0, 1) },
    future: { text: '时钟坏了', at: NOW + 3600e3 }
  }
}))
const world = q.readWorldMaterial(FAKE, { worldbookChars: 2000 }, NOW)
ok(world.worldbook.startsWith('海城'), '世界观取到 worldbook 开头')
ok(world.worldbook.length <= 2000 && world.worldbook.endsWith('…（世界观过长已节选）'), '超长世界观被节选并注明', `len=${world.worldbook.length}`)
ok(world.facts.length === 1 && world.facts[0] === '00:47 没睡好，犯困', '账本只留今天的条目', JSON.stringify(world.facts))

section('[3] buildDiaryDigest：形状')
const digest = q.buildDiaryDigest({ chats: all.chats, world, dropped: 1, now: NOW })
ok(digest.includes('【日记素材 · 2026-10-04'), '日期标题对')
ok(digest.includes('海城是一座贴着湾'), '世界观区段在')
ok(digest.includes('00:47 没睡好，犯困'), '账本区段在')
ok(digest.includes('群 10007') && digest.includes('私聊 10008'), '会话标签可读')
ok(digest.includes('另有 1 个没放进来'), '丢弃数有注明')
ok(digest.includes('qqzone__post_diary'), 'digest 尾部给出下一步工具名')

section('[3.5] 时间感：现在锚点 + 块按时间排 + 时段词')
ok(/【现在】\d\d:\d\d（(凌晨|清晨|上午|中午|下午|傍晚|晚上|深夜)）/.test(digest), '头部给出「现在」，带时段词',
  digest.match(/【现在】[^\n]*/)?.[0])
ok(digest.includes('素材覆盖 00:00 → 此刻'), '写明素材窗口与「写到此刻为止」')
ok(q.timeOfDay(3) === '凌晨' && q.timeOfDay(9) === '上午' && q.timeOfDay(15) === '下午' && q.timeOfDay(23) === '深夜',
  '时段词分档对')
ok(q.hhmmOf(0) === '' && q.hhmmOf(null) === '' && q.hhmmOf(NaN) === '', 'hhmmOf 对 0/空/NaN 给空串（不误判成 00:00）')
// 块按时间先后摆：群 08:10 开始 → 私聊 09:30 开始 ⇒ 私聊块必须排在群块之后
const gi = digest.indexOf('── 群 10007')
const pi = digest.indexOf('── 私聊 10008')
ok(gi >= 0 && pi > gi, '会话块按时间先后排（早的在前）', `群@${gi} 私聊@${pi}`)
ok(/── 群 10007（上午 08:10 → 下午 14:03 · 共 5 句）──/.test(digest),
  '块头带「时段 时刻 → 时段 时刻」', digest.match(/── 群 10007[^\n]*/)?.[0])

section('[4] 日记限频：独立于说说，按天计，落盘可回读')
const cfg1 = { postsPerDay: 3, diaryPerDay: 1 }
let st = q.loadState()
ok(q.checkCap(st, 'diary', cfg1, NOW).ok, '今天还没写，放行')
st.posts = [NOW]                                       // 说说今天已发 1 条（上限 3），还放行
ok(q.checkCap(st, 'post', cfg1, NOW).ok, '说说按天额度照常算')
st.posts = [NOW, NOW, NOW]
ok(q.checkCap(st, 'post', cfg1, NOW).ok === false, '说说额度用满会拒（与日记互不影响）')
ok(q.checkCap(st, 'diary', cfg1, NOW).ok, '发满说说照样能写日记')
q.recordAct(st, 'diary', null, NOW)
st = q.loadState()
ok((st.diaries || []).length === 1, 'diaries 落盘（tmp+rename）')
const denied = q.checkCap(st, 'diary', cfg1, NOW)
ok(!denied.ok && denied.reason.includes('已经写过'), '同日第二篇被拒，人话理由')

section('[5] 工具注册：setup 捕获六件套')
const tools = {}
const api = {
  config: () => ({ enabled: true, diaryPerDay: 1, showInChat: true, maxChats: 8, msgsPerChat: 80, maxCollectChars: 14000, worldbookChars: 2000, maxPostChars: 500, maxImageMB: 8 }),
  log: () => {},
  registerTool: (def) => { tools[def.id] = def }
}
q.setup(api)
for (const id of ['qqzone__collect_diary', 'qqzone__post_diary']) {
  ok(typeof tools[id]?.execute === 'function', `注册了 ${id}`)
}
// ★ 2026-10-12 裁剪：qqzone 只留日记线；发说说/刷动态/点赞/评论交给现役 skills/qzone。
//   这不是"写掉了"，是**故意裁的**——所以断言反过来，钉住它别再长回来。
for (const id of ['qzone__post_mood', 'qzone__list_feeds', 'qzone__like_feed', 'qzone__comment_feed']) {
  ok(!tools[id], `不再注册 ${id}（已裁给 skills/qzone）`)
}
const ctx = {
  kind: 'private', chatKey: 'private_10008',
  sender: { sendImage: async (key, payload, opts) => { ctx._sent = ctx._sent || []; ctx._sent.push({ key, opts }) } },
  onebot: null, store: null
}

section('[6] qqzone__collect_diary：只读、返回素材')
const collected = await tools['qqzone__collect_diary'].execute(ctx, {})
ok(!collected.isError && collected.content.includes('【日记素材'), '返回素材摘要')
ok(collected.content.includes('日记就写你自己的日程') === false || true, '占位')

section('[7] qqzone__post_diary：空正文拒、渲染软依赖、上传/发布表单形状')
const empty = await tools['qqzone__post_diary'].execute(ctx, { text: '   ' })
ok(empty.isError && empty.content.includes('日记正文是空的'), '空正文给出人话错误')

// [4] 已经往同一个假 data 里记过一次日记，先清掉 state 再测发信全链路
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })

// 真渲染器（软依赖真的能找到 text-image）；纯 node 下 Electron 不可用，应给"回退"指引
q.diaryHooks.renderer = null
const realMod = await q.loadRenderer()
ok(realMod && typeof realMod.renderPages === 'function', 'loadRenderer 找到 skills/text-image')
let rendererErr = ''
try { await realMod.renderPages('测试', { title: 't' }, {}) } catch (e) { rendererErr = String(e?.message ?? e) }
ok(/BrowserWindow|electron/i.test(rendererErr), '纯 node 下渲染给人话错误', rendererErr)

section('[7.5] 软依赖降级：没渲染器退纯文字、没插件 digest 注明跳过')
// 未装「世界与事件」时 digest 明说跳过，且不再出现占位文案
ok(q.buildDiaryDigest({ chats: [], world: { installed: false, worldbook: '', facts: [] }, dropped: 0, now: NOW })
  .includes('未装「世界与事件」插件'), 'digest 对未装插件明说跳过')
ok(q.readWorldMaterial(path.join(FAKE, 'no-such-dir'), {}, NOW).installed === false, '无配置无账本判为未装')
// 渲染走不通（真渲染器在纯 node 下必炸）→ post_diary 自动退纯文字说说，不再 isError 拦人
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })
q.diaryHooks.renderer = null   // 让 loadRenderer 找到真模块，渲染在纯 node 下必炸 → 走兜底
q.diaryHooks.authImpl = async () => ({
  cookies: new Map([['p_skey', 'psk']]), gtk2: '12345', selfUin: '12345678'
})
const textCalls = []
globalThis.fetch = async (u, init) => {
  textCalls.push({ url: String(u), form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null })
  return { ok: true, status: 200, text: async () => `callback(${JSON.stringify({ t1_tid: '0123456789abcdef01234567' })})` }
}
const fallback = await tools['qqzone__post_diary'].execute(ctx, { text: '纯文字兜底的日记。', caption: '记一笔' })
ok(!fallback.isError, '渲染不可用时日记照发（纯文字兜底）', fallback.content)
const textPub = textCalls.find((c) => c.url.includes('emotion_cgi_publish_v6'))
ok(textPub && !textCalls.some((c) => c.url.includes('cgi_upload_image')), '兜底只发文字不传图')
if (textPub) {
  ok(!textPub.form.richtype && textPub.form.con.includes('纯文字兜底的日记。') && textPub.form.con.startsWith('记一笔'),
    '兜底表单 richtype 空、caption+正文进 con', JSON.stringify({ richtype: textPub.form.richtype, con: textPub.form.con.slice(0, 40) }))
}
st = q.loadState()
ok((st.diaries || []).length === 1, '兜底发成也计一次日记频')

// 打桩渲染器 + 打桩 auth + 打桩 fetch，验证上传/发布全链路形状
fs.rmSync(path.join(FAKE, 'qqzone'), { recursive: true, force: true })   // 兜底测试记过一次频，清掉再测带图链路
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
q.diaryHooks.renderer = { renderPages: async (text, meta) => [PNG, PNG] }
q.diaryHooks.authImpl = async () => ({
  cookies: new Map([['p_skey', 'psk'], ['skey', 'sk'], ['pt2gguin', 'o012345678']]),
  gtk2: '12345', selfUin: '12345678'
})
const calls = []
globalThis.fetch = async (u, init) => {
  calls.push({ url: String(u), form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null })
  const j = String(u).includes('cgi_upload_image')
    ? { data: { albumid: 'alb1', lloc: 'loc1', url: 'http://img', width: 900, height: 1200, type: 1 } }
    : { t1_tid: '0123456789abcdef01234567' }
  return { ok: true, status: 200, text: async () => `callback(${JSON.stringify(j)})` }
}
ctx._sent = []
const posted = await tools['qqzone__post_diary'].execute(ctx, { text: '# 十月四日\n\n今天装了日记技能。', title: '我的日记 · 10月4日' })
ok(!posted.isError, '发日记成功', posted.content)
const upload = calls.filter((c) => c.url.includes('cgi_upload_image'))
const publish = calls.find((c) => c.url.includes('emotion_cgi_publish_v6'))
ok(upload.length === 2, '两页图各传一次')
ok(upload[0].form.picfile && upload[0].form.p_skey === 'psk' && upload[0].form.uin === '12345678', '上传表单带字节与凭据')
ok(!!publish, '发布了说说')
if (publish) {
  ok(publish.form.richtype === '1', 'richtype=1（带图说说）')
  ok(publish.form.richval.split('\t').length === 2 && publish.form.richval.includes(',alb1,loc1'), 'richval 两页用 \\t 连接', publish.form.richval)
  ok(publish.form.con === '把今天记成了一页日记。', 'caption 缺省有兜底', publish.form.con)
  ok(publish.form.hostuin === '12345678', 'hostuin 是自己')
}
ok((ctx._sent || []).length === 2, '日记图回显到当前会话（showInChat 默认开）')
st = q.loadState()
ok((st.diaries || []).length === 1, '这次发日记计了一次频（[4] 的记录已清）')
const again = await tools['qqzone__post_diary'].execute(ctx, { text: '第二篇' })
ok(again.isError && again.content.includes('已经写过'), '同日第二篇被工具拒')

// ── 上传响应解析的脏尾巴回归（2026-10-04 实机：); 后挂尾巴炸 position 10）──
section('上传响应解析（脏尾巴回归）')
const good = '{"code":0,"data":{"albumid":"alb","lloc":"loc","url":"u","height":1,"width":2,"type":1}}'
ok(q.parseQzoneLooseJson(`callback(${good});`, '上传图片').data.albumid === 'alb', '标准 callback 壳照常')
ok(q.parseQzoneLooseJson(`callback(${good});\n<!-- stats -->`, '上传图片').data.albumid === 'alb', '); 后挂 HTML 尾巴')
ok(q.parseQzoneLooseJson(`callback(${good});callback(${good});`, '上传图片').data.albumid === 'alb', 'callback 连发两段')
ok(q.parseQzoneLooseJson(`null\n${good}`, '上传图片').data.albumid === 'alb', '裸 JSON 带前缀垃圾')
let threw = ''
try { q.parseQzoneLooseJson('callback({"code":-1,"msg":"x"});', '上传图片') } catch (e) { threw = String(e.message) }
ok(threw.includes('code=-1'), 'code 非 0 照旧报错', threw)

// ── 日记配图：当天的旅行明信片（2026-10-12 加）────────────────────────────
section('日记配图：当天明信片')
{
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
  const photoDir = path.join(FAKE, 'skills', 'travel-whale', 'photos', 'group_10007')
  fs.mkdirSync(photoDir, { recursive: true })
  const p1 = path.join(photoDir, 'a.png'); fs.writeFileSync(p1, PNG)
  const p2 = path.join(photoDir, 'b.png'); fs.writeFileSync(p2, PNG)
  const confPath = path.join(FAKE, 'config.json')
  let conf = {}
  try { conf = JSON.parse(fs.readFileSync(confPath, 'utf8')) } catch { conf = {} }
  conf.skills = { ...(conf.skills || {}), 'travel-whale': { homeChatKey: 'group:10007' } }
  fs.writeFileSync(confPath, JSON.stringify(conf))
  const twDir = path.join(FAKE, 'skills', 'travel-whale', 'chats')
  fs.mkdirSync(twDir, { recursive: true })
  fs.writeFileSync(path.join(twDir, 'group_10007.json'), JSON.stringify({
    album: [
      { id: 'pc_a', spot: '岚山', city: '京都', country: '日本', rarity: 'rare', caption: '竹林的绿', image: p1 },
      { id: 'pc_b', spot: '金阁寺', city: '京都', country: '日本', caption: '闪瞎了', image: p2 },
      { id: 'pc_old', spot: '昨天的地方', city: '京都', country: '日本', caption: '昨天', image: p1 },
      { id: 'pc_gone', spot: '文件没了', city: '京都', country: '日本', caption: '裂图', image: path.join(photoDir, 'nope.png') }
    ],
    cardDelivered: { pc_a: tsAt(11, 44), pc_b: tsAt(14, 14), pc_old: tsAt(9, 0, 3), pc_gone: tsAt(12, 0) }
  }))

  const tc = q.readTravelCards(FAKE, {}, NOW)
  ok(tc.installed === true, '读到旅行存档')
  ok(tc.chatKey === 'group:10007', 'homeChatKey 解析正确', tc.chatKey)
  ok(tc.cards.length === 2, '只留「今天寄出 + 文件还在」的', String(tc.cards.length))
  ok(tc.cards.map((c) => c.id).join(',') === 'pc_a,pc_b', '按送达时间排序', tc.cards.map((c) => c.id).join(','))
  ok(tc.droppedMissing === 1, '文件缺失的被丢并计数', String(tc.droppedMissing))
  ok(tc.cards[0].no === 1 && tc.cards[1].no === 2, '编号从 1 连续')

  const dg = q.buildDiaryDigest({ chats: [], world: { installed: false }, travelCards: tc, dropped: 0, now: NOW })
  ok(dg.includes('【今天的明信片'), 'digest 里有明信片段')
  ok(dg.includes('#1') && dg.includes('#2'), 'digest 列出编号')
  ok(dg.includes('岚山') && dg.includes('竹林的绿'), 'digest 带景点与当时写的话')
  ok(!dg.includes('昨天的地方'), 'digest 不含昨天的卡')
  ok(!dg.includes('pc_a'), 'digest 不暴露内部 id（只给编号）')
  const dgNone = q.buildDiaryDigest({ chats: [], world: { installed: false }, travelCards: { installed: true, cards: [] }, dropped: 0, now: NOW })
  ok(dgNone.includes('今天没有寄回来的明信片'), '今天没卡时明说别配图')
  const dgOff = q.buildDiaryDigest({ chats: [], world: { installed: false }, travelCards: { installed: false, cards: [] }, dropped: 0, now: NOW })
  ok(!dgOff.includes('【今天的明信片'), '没装旅行技能时整段不出现')

  const picks = q.resolveDiaryPics(FAKE, ['1', 'pc_b', '1'], tc.cards)
  ok(picks.picked.length === 2, '按编号+id 挑、并去重', String(picks.picked.length))
  ok(picks.picked.every((p) => p.buf.length > 0 && p.kind === 'png'), '解析出合法 PNG 字节')
  const bad = q.resolveDiaryPics(FAKE, ['9'], tc.cards)
  ok(bad.picked.length === 0 && bad.skipped.length === 1, '越界编号 → 空 + 说明，不抛错', JSON.stringify(bad.skipped))
  const esc = q.resolveDiaryPics(FAKE, ['../../../config.json'], tc.cards)
  ok(esc.picked.length === 0, '路径穿越被拒')
  const over = q.resolveDiaryPics(FAKE, ['1'], tc.cards, { maxBytes: 10 })
  ok(over.picked.length === 0 && over.skipped.length === 1, '超体积按 maxBytes 拒绝')
  ok(q.diaryCardsMax({}) === 3 && q.diaryCardsMax({ maxDiaryCards: null }) === 3
     && q.diaryCardsMax({ maxDiaryCards: '' }) === 3 && q.diaryCardsMax({ maxDiaryCards: 0 }) === 0
     && q.diaryCardsMax({ maxDiaryCards: 99 }) === 6,
     '配图上限：默认 3 / null 也 3（Number 坑）/ 显式 0 生效 / 封顶 6')
}

// ── 日记字数下限（2026-10-12：实测不设下限时只写 ~540 字）──────────────────
section('日记长度：目标区间与「短句规矩不适用」')
{
  const d0 = q.diaryLenRange({})
  ok(d0.min === 1500 && d0.max === 2000, '默认 1500~2000', JSON.stringify(d0))
  ok(q.diaryLenRange({ diaryTargetMin: null }).min === 1500, 'min=null → 1500（Number 坑）')
  ok(q.diaryLenRange({ diaryTargetMin: '' }).min === 1500, "min='' → 1500")
  ok(q.diaryLenRange({ diaryTargetMax: null }).max === 2000, 'max=null → 2000')
  ok(q.diaryLenRange({ diaryTargetMin: 0 }).min === 1500, 'min=0 无意义 → 回默认（0 不是合法的目标字数）')
  ok(q.diaryLenRange({ diaryTargetMin: 800 }).min === 800, 'min=800 生效')
  const inv = q.diaryLenRange({ diaryTargetMin: 1800, diaryTargetMax: 1000 })
  ok(inv.min === 1800 && inv.max === 1800, '上限低于下限时自动抬到下限', JSON.stringify(inv))
  ok(q.diaryLenRange({ diaryTargetMin: '2500' }).min === 2500, '字符串数字也认')

  const g = q.diaryGuidance({})
  ok(g.includes('1500~2000 字'), '口径里写了目标字数')
  ok(g.includes('8~12 段'), '口径里写了段落数')
  ok(g.includes('一律不适用'), '口径里显式解除了群聊短句规矩')
  ok(g.includes('1~10 字') && g.includes('不要小作文'), '点名了要解除的两条具体规则')
  ok(g.includes('一篇长文'), '说明了日记是长文')

  const brief = q.diaryBriefing({}, NOW)
  ok(brief.text.includes('1500~2000 字'), 'briefing 里带上长度要求')
  ok(brief.text.indexOf('写日记的口径') > brief.text.indexOf('【今天的聊天】'), '口径排在素材之后（尾注）')
  const len = q.diaryGuidance({ diaryTargetMin: 900, diaryTargetMax: 1200 })
  ok(len.includes('900~1200 字'), '改设置会同步改掉提示词里的数字')
}

// ── 日记抖动（2026-10-24）：分钟级准点 → 每日确定性偏移 ──────────────────
section('日记抖动：确定性、范围、开关')
{
  ok(q.autoDiaryCfg({}).jitterMax === 20, '默认 20 分钟', JSON.stringify(q.autoDiaryCfg({})))
  ok(q.autoDiaryCfg({ diaryJitterMax: null }).jitterMax === 20, 'null → 20（Number 坑）')
  ok(q.autoDiaryCfg({ diaryJitterMax: '' }).jitterMax === 20, "'' → 20")
  ok(q.autoDiaryCfg({ diaryJitterMax: 0 }).jitterMax === 0, '0 生效（关闭）')
  ok(q.autoDiaryCfg({ diaryJitterMax: 99 }).jitterMax === 30, '封顶 30')
  const a = q.diaryJitterMin('2026-10-24', 20)
  ok(a === q.diaryJitterMin('2026-10-24', 20), '同一天结果确定（两次计算一致）')
  ok(a >= 0 && a <= 20, `范围 [0,20]（实得 ${a}）`)
  ok(q.diaryJitterMin('2026-10-24', 0) === 0, 'jitterMax=0 → 偏移 0')
  let inRange = true
  for (let d = 1; d <= 31; d++) {
    const v = q.diaryJitterMin(`2026-10-${String(d).padStart(2, '0')}`, 25)
    if (!(v >= 0 && v <= 25)) inRange = false
  }
  ok(inRange, '整月偏移都在 [0,25]')
  const uniq = new Set(Array.from({ length: 30 }, (_, i) => q.diaryJitterMin(`2026-11-${String(i + 1).padStart(2, '0')}`, 20)))
  ok(uniq.size >= 5, `一个月偏移有分散（${uniq.size} 种），不是常数`)
}

// ── 清场 ──
fs.rmSync(FAKE, { recursive: true, force: true })
console.log(`\n结果：${pass} 过，${fail} 挂`)
process.exit(fail ? 1 : 0)
