# QQ 空间动态（qzone）

让 AI 打理自己的 QQ 空间：发说说（可带聊天里的图）、刷好友动态、读说说下面的评论与回复、
给有意思的说说点赞评论、回复别人留的评论；**她自己发的说说有人评论时，她会自动知道**
（静默带进上下文，不主动发消息）。
所有读写都走 **bot 账号自己**的 Qzone 网页登录态（SnowLuma 登录着 QQ，OneBot
的 `get_cookies` 能取到 Qzone cookie），不需要也不应该收集任何人的账号密码。

## 工具

| 工具 | 作用 | 写操作 |
|---|---|---|
| `qzone__post_mood` | 发一条说说，可选带图（`images` 传消息号） | 是 |
| `qzone__list_feeds` | 刷好友动态（只读），返回作者/时间/摘要/点赞数/评论数 | 否 |
| `qzone__read_comments` | 读某条说说的**评论正文与回复**（只读） | 否 |
| `qzone__like_feed` | 点赞指定说说（uin + tid 从 list_feeds 抄） | 是 |
| `qzone__comment_feed` | 评论指定说说 | 是 |
| `qzone__reply_comment` | **回复某条已有的评论**（不是发新评论） | 是 |

## 带图说说

模型只能**引用**它已经在聊天里看到过的图，不能指定任意图：

```
images: ["#12345"]        // 那条消息的第一张图
images: ["#12345", "#12345:2"]   // 同一条消息的第 1、2 张
```

`#12345` 就是聊天记录里的消息 id（和 `get_message_images`、`send_voice` 用的是同一个号）。
路径、网址、`data:`/`base64://`、表情 id 一律拒——这与 `send_voice` 是同一条纪律：
**模型拿不到"任意图"这个能力**，只能在已经流过这个会话的内容里挑。

拿到消息号之后的流程（`resolveChatImage` → `downloadChatImage` → `uploadQzoneImage`）：

1. `ctx.store.findByMid(chatKey, mid)` 从存档里翻出那条消息的 `media[]`，取第 N 张的
   `url` / `file`。消息不存在、没有图、第 N 张越界，都在这里给出人话错误，**不出网**。
2. 按存档里的直链下载；直链过期（QQ 图片链接会失效）就问 OneBot 重签一次
   （`onebot.freshImageUrlOfMessage(mid, file)`）。
3. 验字节：超过 `maxImageMB` 拒；魔数不是 jpg/png/gif/webp/bmp 拒（挡掉"把任意文件当图传"）。
4. `POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=` 上传，
   拿回 `albumid/lloc/width/height/type`，拼成
   `richval = ,albumid,lloc,lloc,type,height,width,,height,width`。
5. **所有图都传成功之后**才发说说（传一半就发，空间里会留下一条缺图的说说，收不回来）：
   发布表单加 `richtype='1'`、多图 `richval` 用 `\t` 连接。

> 隐私：发到空间的图，bot 的所有好友都看得见。别人私发的、或明说过不想公开的图不该发——
> 这条写进了提示词；要一刀切就把 `allowChatImages` 关掉。

## 读评论（1.2.0）

**列表接口拿不到评论正文**，这一点踩过坑，写清楚免得后人再试：

| | `feeds3_html_more`（列表） | `emotion_cgi_msgdetail_v6`（详情） |
|---|---|---|
| 评论正文 | ✗ 结构体里没有 | ✓ `commentlist[].content` |
| 评论的**回复** | ✗ | ✓ 嵌在 `commentlist[].list_3[]` |
| 权威评论数 | ✗（只有渲染进 html 的前几条） | ✓ `cmtnum` |
| 代价 | 1 次请求拿 10 条动态 | **每条说说 1 次请求** |

所以：**列表只给条数，正文一律走详情接口**。`qzone__read_comments(uin, tid)` 就是这么做的；
两个参数都不传时，它先去动态流里找**她自己最近发的那条**（所以"别人评论了我的说说"这种
场景，她直接调这个工具就行，不需要先 list_feeds 抄 tid）。

顺带修掉列表解析里三个**长期静默出错**的地方（都是被 `mergeData` / 正则骗了）：

1. **点赞数恒 0** —— 旧正则 `/(\d+)\s*人觉得很赞/` 匹配不上真实 html
   （真身是 `共<span class="f-like-cnt">20</span>人觉得很赞`，标签夹在数字和文字中间）。
   改从 `data-likecnt="20"` 取，回退 `f-like-cnt`。
2. **评论数恒 1** —— 旧代码用 `mergeData.length`，而 `mergeData` **恒为 `[null]`**、长度永远是 1
   （`likecnt/commentcnt` 那两个字段也确实存在，但值是**空串**，是响应模板的占位）。
   改成数 `<li class="comments-item" data-type="commentroot">` 的个数；带"查看更多评论"时
   返回 `N+`，如实告诉模型这不是全部。
3. **正文被头部污染** —— 旧代码把整块 html 过 `htmlToText`，会把「昵称 + 时间」一起带出来
   （实测得到 `"占位昵称 12:06 正文…"`）。改成只取 `<div class="f-info">`；纯图/纯转发
   说说没有 `f-info`，**不再整条丢弃**（以前好友的图说说会从列表里消失），标成「（无文字）」。

评论里的 @ 是协议串 `@{uin:123,nick:名字,who:1,auto:1}`，`cleanMentions()` 换成 `@名字`。
★ 正则里的 `@?` 不能省：**协议串本身带前缀 `@`**，不吃掉它就会得到 `@@名字`。

## 回复评论（1.3.0）

`qzone__reply_comment(uin, tid, comment, content[, reply])`：`comment` 填 `read_comments`
输出里的序号（1、2、3…），想回某一层里的某条楼中回复再填 `reply`。
**模型不该自己写 `@`** —— 工具会带好。

与顶层评论（`comment_feed`）的差别，是**实测出来的**，不是猜的：

| | `comment_feed`（发新评论） | `reply_comment`（回复某条） |
|---|---|---|
| 端点 | `emotion_cgi_re_feeds` | **同一个** `emotion_cgi_re_feeds` |
| 域 | `/proxy/domain/taotao.qzone.qq.com` | **`user.qzone.qq.com`**（h5 域实测不通，回 html） |
| 表单 | 只要 `topicId/uin/hostUin/…` | 多 `commentId`（被回复那层的 `tid`）+ `commentUin` |
| content | 原样 | 开头必须带原生关系标记 `@{uin:..,nick:..,who:1,auto:1}` |

★ 回复"楼中回复"时**锚点仍是所属楼层**，`@` 的才是被回复者本人（照抄网页端 `list_3[]`
里 content 的形态即可）。

★★ **写入类响应不是 JSON —— 会骗人**：`emotion_cgi_re_feeds` 成功时回 **200 + 一整页 HTML**，
真正的 `code` 埋在 `<script>frameElement.callback({ code: 0, … });</script>` 里。
第一版直接 `JSON.parse` → 抛 `Unexpected token '<'` → **操作其实已经生效，程序却报失败**
（实测踩两次：空间里那两条回复都稳稳落上了，日志全是失败）。调用方一重试就会**重复发**。
所以写入统一走 `postReFeeds()`：**3xx / 200+HTML壳 / 200+JSON 三种形状都算成功**，
只有明确解析出 `code != 0` 才算失败。★ 抠 code 的正则要**同时吃带引号和不带引号的 key**
（Qzone 回的是裸 key `{ code: 0 }`，参考实现 Maizone 的 `extract_code_html()` 也是这么干的）。

★ `read_comments` 输出的序号**会随别人删评论而变**，所以 `reply_comment` 每次**现读一遍**
详情把"第几条"翻成 `commentId/commentUin`，绝不缓存序号 —— 缓存了就会回错人。
去重键是 `uin:tid:r<锚定楼层tid>[-<回复序号>]`。

## 有人评论时她会知道（1.4.0）

她自己发的说说下面有人留言，她得知道。做法是**轮询 + 静默带出**，不是主动发消息：

```
activate() 起自调度定时器（默认 15 分钟）
  → 拉动态流找到她自己最近 2 条说说
     · 列表 html 里 data-type="commentroot" 的条数 = 评论数的**廉价代理**
     · 与上次一致 → 跳过详情请求（稳态每轮就 1 个请求）
  → 变了才读 emotion_cgi_msgdetail_v6，与已见集合做差
  → 新评论落 data/qzone/inbox.json
  → before-llm-messages 钩子把它追加到**最后一条 user 消息**尾部
     （只动尾部：system+tools 是字节前缀缓存，插中间会让后面全废）
  → 她自己决定回不回；read_comments / reply_comment 一执行就自动清掉对应提示
```

为什么不用"主动发消息"：宿主**没有** `proactive` 能力，v0.4.5 的 `capabilities` 里也
**没有任何核心发送能力提供者**（`chat.send` 根本没人提供，silence-ping 试了它再退到
OneBot HTTP 直发）。要主动开口只能自己拼 OneBot HTTP —— 那是**替她说话**，打扰且收不回来。

两条必须记住的边界：

1. **首轮（以及第一次遇到某条说说时）只把 `inboxFirstRunHours`（默认 48）小时内的评论
   当新评论**，更早的静默记为已见 —— 否则插件一上线就把几个月的旧评论全砸给她，
   还会让她去回几个月前的话。时间**读不出来的一律当老评论**（宁可漏报不误报）。
2. **序号绝不能写进提示**。`read_comments` 的 1/2/3 会随别人删评论而变，`reply_comment`
   又拿这个序号去现读翻译，写死了就会回错人。提示里只给"谁说了什么"。

其它：`shown` 计数让同一批最多提示 `inboxMaxShows`（默认 3）轮，`inboxTtlHours`
（默认 24）小时后丢掉；`inboxEnabled=false` 一键关掉整个收件箱。

★ 定时器是**自调度 `setTimeout` 链**而不是 `setInterval` —— 每轮结束重读一次配置再排
下一轮，这样 UI 里改间隔/开关**下一轮就生效**，不必重启。

## 登录态怎么拿

1. 先走 `ctx.onebot.call('get_cookies', {domain:'qzone.qq.com'})`（应用自己配了
   OneBot token 时一条就通）；
2. 被 SnowLuma 1401 拒（它对敏感接口强制校验 accessToken）→ 读
   `<app>/resources/app/snowluma/config/onebot_*.json` 的 `networks.httpServers[].accessToken`，
   自己拼 `POST {httpUrl}/get_cookies`。
3. cookie + g_tk 内存缓存 5 分钟。**token 只进内存**：不写日志、不进返回值。

## 自律（硬编码 + 配置双保险）

- 发说说按**天**限流（默认 3 条/天），点赞（6/小时）和评论（3/小时）按滑动一小时窗口。
- 带图另有三道闸：`allowChatImages`（总开关，默认开）、`maxImagesPerPost`（默认 3，硬上限 9）、
  `maxImageMB`（默认 8，最大 32）。
- 同一条说说（uin+tid）只互动一次，记忆落在 `data/qzone/state.json`（`acted`，
  超 300 条清最老的）。
- 刷动态有最小间隔（默认 30 分钟）：间隔内的调用直接喂上一次缓存，不重复出网。
- uin 必须 5~11 位纯数字；tid 必须 24 位小写十六进制；图片引用必须是消息号——
  脏参数一律在**出网前**就被拒。
- `allowInGroup=false` 可把整个技能限定在私聊。
- 状态写入是原子的（tmp + rename），崩在半路不会留下半个 JSON。
- `read_comments` **没有限频**（只读、每次 1 个请求，也不落 state）；`browseIntervalMinutes`
  只约束 `list_feeds` 那种"带打扰度"的浏览。
- **收件箱轮询也是只读**，但它自己看门：`pollIntervalMinutes`（默认 15）控制间隔、
  `inboxEnabled` 一键关。稳态每轮只 1 个请求（计数闸门），**且不主动发任何消息**。

## 接口依据

端点常量取自持续维护的 [guohuiyuan/qzone-go](https://github.com/guohuiyuan/qzone-go)
并经本机只读实测（拉动态 code=0、10 条 item）；带图那套字段口径照 SnowLuma 桥里
已在用的实现（`cgi_upload_image` + `richtype/richval`）：

- 发说说 `POST /proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=`
- 传图 `POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=`
- 动态 `GET /proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?...`
- **读评论** `GET /proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?uin=&tid=&pos=0&num=20&need_private_comment=1&g_tk=`
  （**顶层就是说说本体，没有 `data` 包一层**；正文 `content`、图 `pic/pictotal`、
  评论 `commentlist[]`，每条评论的回复在 `list_3[]`，回复正文带 @ 协议串）
- 点赞 `POST /proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=`
- 评论 `POST /proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=`
- **回复评论** `POST https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=`
  （与顶层评论**同一个 cgi**，但域必须是 `user.qzone.qq.com`；多带 `commentId`/`commentUin`，
  content 开头带 `@{uin,..}` 关系标记。**成功回 200+HTML 壳，不是 JSON** —— 见「回复评论」一节）

注意：动态接口返回的是 **JS 对象字面量**（单引号、未引号 key、`\xNN`、裸
`undefined`），不是 JSON——`index.js` 里的 `jsLiteralToJson` 是逐字符状态机，
别换成正则或 `eval`。

上传/发布这两个接口的响应**不一定带 `code` 字段**（成功时可能整个没有），所以用的是
`parseQzoneLooseJson`：`code`/`subcode` 只在是数字且非 0 时才算错，成功与否看
**有没有回 `tid`**（空间拒稿也返回 200）。别把它们换回严格的 `parseQzoneJson`。

## 测试

`tests/test-qzone.mjs`：离线回归（假 data 目录，全程不出网），钉住清单↔实现、
三态装载、群聊闸门、参数安全、限频/去重/缓存、解析器，以及带图那套：图片引用的
收/拒矩阵、魔数、`resolveChatImage` 的各种人话错误、上传与发布表单的形状（`fetch` 打桩）。
其中 [8] 把 `fetch` 换成"一调就报错"，用来**证明**脏参数拦在出网之前。

1.2.0 起另有姊妹文件（随开发环境走，`/8/_qzone/`）：覆盖 `feedTextOf` / `feedCountsOf`
的转义与已解析两种形态、`cleanMentions` 的 `@@` 回归、`parseMsgDetail` 的嵌套回复与
`conlist` 兜底，以及 `read_comments` 端到端（打桩 get_cookies + 详情 + 动态流）——
含"不给 uin/tid 时自动定位自己最新说说"和"脏参数一次网都不出"两条。
**当前共 149 项断言**（`_test_qzone.mjs`，离线、全程不出网）。1.3.0 / 1.4.0 追加：

- **13 节 `reply_comment`**：`codeFromHtml` 的裸 key/带引号 key 双形态、脏参数不出网、
  序号越界、群聊闸门、写入表单形状（`topicId`/`commentId`/`commentUin`/`@` 标记/`paramstr`/`format`）、
  同层重复被拒、楼中回复锚点仍是楼层、模型自带 `@` 被剥、**200+HTML 壳与 3xx 都算成功**、
  `code≠0` 才报错。写入 mock 有 `writeMode` 三态：`html`（默认）/`redirect`/`badcode`。
- **14 节 评论收件箱**：时间解析四种形态、条目枚举的 id 口径、**计数闸门（计数没变就不读详情）**、
  首轮 48 小时窗口（旧评论静默记为已读、自己留的不提示）、楼中回复入箱、
  `inboxBlock` 的抬头/分组/**不写死序号**/`@` 清理、`shown` 封顶、`clearInboxFor` 三种粒度、
  读过评论后自动清空、钩子只动 user 尾部不碰 system（含数组 content）、
  `activate`/`deactivate` 起停定时器。

★ 测试直接调 `def.execute` 时必须**自己兜异常**（包一层 try/catch 成 `{isError:true}`）——
宿主 `src/tools.js` 的 `executeTool` 就是这么做的；不兜的话会崩在未捕获异常上，
把"服务端报错"这种断言误判成整个测试挂掉。

**只读路径已用真账号实测**（拉动态、读详情、轮询；均 `code=0`）；真账号的写路径
（发/赞/评/回复）首次启用时**先问用户**再实测。
