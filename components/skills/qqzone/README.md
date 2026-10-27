# 空间日记（QQ空间动态，qqzone）

让 AI 打理自己的 QQ 空间：**结合当天聊天记录与「世界与事件」插件写日记，用「长文排版图」的管线排成图片发成日记说说**。

> 2026-10-12 起本技能只保留「日记」这条线：发说说/刷动态/点赞/评论与现役 `skills/qzone`
> 功能重复，双技能注册同批工具会让模型面前出现两套一样的工具、且限频分开算（不同
> state 文件）⇒ 同一条说说可能被点赞/评论两次。2026-10-23 把当时的裁剪残留（四个工具
> 的实现与 `if (ENABLE_OVERLAP_TOOLS)` 工具块，共 508 行）从源码里清掉了，现在没有死分支。
所有读写都走 **bot 账号自己**的 Qzone 网页登录态（SnowLuma 登录着 QQ，OneBot
的 `get_cookies` 能取到 Qzone cookie），不需要也不应该收集任何人的账号密码。

## 前置依赖（v2.1 起全部软性，不装也能用）

两个增强模块**都不强制**，`skill.json` 的 `requires` 留空，任何环境都会注册日记线的两个工具：

- **「世界与事件」插件**（plugins/life-system）：没装时 `collect_diary` 只给
  聊天记录，素材里注明世界观与近况账本跳过；
- **「长文排版图」技能**（skills/text-image）：没装（或渲染失败）时 `post_diary`
  自动把日记发成**纯文字说说**（超 5000 字截断），不报错拦人。

装上它们日记体验才完整（排图 + 世界观），对外发布时建议在说明里注明这条。

## 工具

| 工具 | 作用 | 写操作 |
|---|---|---|
| `qqzone__collect_diary` | 收集今天的日记素材（聊天记录 + 世界观 + 近况账本，后两样没装插件就跳过），**不出网** | 否 |
| `qqzone__post_diary` | 日记正文 → 长文排版图 → 带图说说（一天一篇）；没装排版图自动发纯文字 | 是 |

## 日记这条线

流程三步，**日记正文由模型自己写**，工具不代笔：

```
qqzone__collect_diary   →  模型写日记（第一人称）  →  qqzone__post_diary(text, title, caption)
```

1. **collect_diary**（纯本地读）：
   - 聊天：扫 `<data>/messages`（热段）+ `<data>/messages-cold`（冷段分片，
     字典序 == seq 升序），两段合并后按**今天 0 点**过滤；每个会话取最近
     `msgsPerChat`（默认 80）句，会话按今天消息量排座次取前 `maxChats`（默认 8）个，
     全部行合计不超 `maxCollectChars`（默认 14000），超了整段会话丢弃并注明。
   - 世界观：`config.json → skills['life-system'].worldbook`，节选前 `worldbookChars`
     （默认 2000）字。
   - 账本：`<data>/life-events.json` 的 `facts`，只取今天记下的条目（账本自带半衰期，
     昨天的旧事不该进今天的日记）。
   - 插件没装 / 没写世界观 / 账本是空的都**软降级**：对应区段写明"没有"，日记照写。
2. **post_diary**：
   - 正文先 `cleanDiaryText`（保留换行的清理，**不走** `sanitizeText`——那会把
     markdown 的换行压没），上限 `maxDiaryChars`（默认 8000，硬顶 18000）。
   - 软依赖动态 import `../text-image/index.js` 的 `renderPages`（同一套
     Electron 隐藏窗口 → capturePage → PNG 管线）；找不到模块或渲染失败时
     **自动降级发纯文字说说**，不用模型改道。
   - PNG 字节**直接**走本文件已有的 `uploadQzoneImage` 上 Qzone 图床，再发说说
     （`richtype='1'` + richval）。不经聊天记录——"模型拿不到任意图"那条铁律
     约束的是模型塞进来的字节，这里图是本地渲染的。
   - 限频独立于说说：`diaryPerDay`（默认 1）按天计，记在 `state.json` 的
     `diaries`，不占 `postsPerDay` 的额度。
   - 发成之后把同样的图回显到当前会话（`showInChat`，默认开）；回显失败不影响
     "说说已发出"的事实。
   - 隐私口径写进了提示词：空间全体好友可见，别人原话不照搬、概括或用昵称。

## 登录态怎么拿

1. 先走 `ctx.onebot.call('get_cookies', {domain:'qzone.qq.com'})`；
2. 被 SnowLuma 1401 拒 → 读 `<app>/snowluma/config/onebot_*.json` 的
   `networks.httpServers[].accessToken`，自己拼 `POST {httpUrl}/get_cookies`。
3. cookie + g_tk 内存缓存 5 分钟。**token 只进内存**：不写日志、不进返回值。

## 自律（硬编码 + 配置双保险）

- 日记 1 篇/天（`diaryPerDay`）。
- 日记图：单图 `maxImageMB`（默认 8MB）上限；单条说说图数硬上限 9。
- `allowInGroup=false` 整体限定私聊。
- 状态写入原子（tmp + rename）；记账在 `data/qqzone/state.json`（`acted`，超 300 清最老）。

## 接口依据

端点常量取自 [guohuiyuan/qzone-go](https://github.com/guohuiyuan/qzone-go) 并经本机
只读实测；带图字段口径照 SnowLuma 桥已跑通的实现（`cgi_upload_image` + richtype/richval）：

- 发说说 `POST /proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=`
- 传图 `POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=`

发布/上传接口的响应偶尔是 **JS 对象字面量**（单引号、未引号 key、`\xNN`、裸 `undefined`）
包在 callback 里，`jsLiteralToJson` 是逐字符状态机，别换成正则或 `eval`。上传/发布响应**不一定带
`code`**，用的是 `parseQzoneLooseJson`：成功与否看**有没有回 `tid`**。

## 测试

```bash
node skills/qqzone/dev-tests/diary-test.mjs
```

纯 node、不出网（假 data 目录 + fetch 打桩）：日记素材的按天过滤/会话封顶/账本抽取/
世界观节选、digest 形状、日记限频与落盘、渲染器软依赖（找不到模块的人话错误）、
post_diary 的上传与发布表单形状、回显发图。

真账号的写路径（发日记）首次启用时**先问用户**再实测。
