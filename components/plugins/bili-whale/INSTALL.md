# 安装说明（3 分钟）

## 1. 放进插件目录

把整个 `bili-whale` 文件夹解压到：

```
<QQ Agent 安装目录>\plugins\bili-whale
```

目录里应该直接看到 `plugin.json`、`index.js`、`lib\`、`panel\`。

然后在 QQ Agent 控制台的「插件」页点一下**重新扫描**（或重启 QQ Agent），
日志里出现 `✅ 加载成功：B站鲸鱼（bili-whale v1.0.0）` 就是装好了。

## 2. 必填设置（插件设置页）

| 设置 | 说明 |
|---|---|
| `ownerQQ` | 你的 QQ 号，逗号分隔可填多个 |
| `sessdata` / `biliJct` / `buvid3` | B 站网页版 Cookie，三个必须同账号 |
| `ownerBiliMid` | 你的 B 站 UID（数字） |
| `ownerBiliName` | 你的 B 站昵称（分享时会 `@` 这个） |
| `notifyChat` | 消息推送到哪个会话（私聊填 QQ 号，群聊填群号） |

Cookie 获取：浏览器登录 bilibili.com → F12 → Application → Cookies → 复制
`SESSDATA`、`bili_jct`、`buvid3` 三个值（**只填值，不要带 `SESSDATA=` 前缀**）。

## 3. 模型（可选）

不配也能跑：会退化成字幕/弹幕/热评摘要。
想让它真的"看懂"再写评论，把 `llmMode` 设成 `auto` 或 `host`，或在设置里填
`llmBaseUrl` / `llmApiKey` / `llmModel`（OpenAI 兼容接口）。

## 4. 常用指令

```
/鲸鱼 现在        立刻跑一轮（选题 → 深读 → 日记 → 分享）
/鲸鱼 状态        看当前配置、额度、登录态
/鲸鱼 候选        只看候选，不深读不发
/鲸鱼 不看 <理由>  今天跳过，但照样写日记
/鲸鱼 日记 [私|N]  看日记（需在设置里开启）
```

## 5. 注意

- 分享有硬上限：每天 ≤3 条、同一视频 7 天一次、同一个人 30 天一条；
- 撞到 B 站风控（`-412` / `-352` / 验证码）会立即停手并在 QQ 里报备；
- 所有状态存在插件自己的 `api.storage` 里，删除插件目录即卸载，不会留下残留文件。

---
本插件为 QQ Agent 扩展，功能与设计参考 `Alterssss/dsh-bili-whale`，按 QQ Agent 的扩展契约重写。
