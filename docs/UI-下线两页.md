# 可选：把「心情」「集成系统」两页从宿主界面摘掉

> **这是可选步骤，不做也不影响功能。**
> 做了之后，「工具」页左栏只剩 SnowLuma / 自检 两项；不做的话，那两页会继续显示
> **旧版 1.x 的指标**（生命值、压力池、debuff 负载、五维情绪），而 v2.2 之后这些数值已经不存在了
> —— 面板上会出现「❤️ 生命值 0/0」这种容易让人以为她出事的数字。

---

## 为什么不用脚本

这四个文件都在宿主 `ui\` 目录里，属于**宿主界面**而不是本包组件。
本包一贯的原则是"不整体覆盖宿主文件"（覆盖会把你宿主上的其它定制倒退回去），
所以这里给**手改步骤**：5 处改动，每处都标了"改成什么"。

---

## 第 0 步：备份

覆盖/编辑前先把这四个复制一份到别处（例如 `D:\ui-backup\`）：

```
QQ Agent\resources\app\ui\index.html
QQ Agent\resources\app\ui\app\14-chrome.js
QQ Agent\resources\app\ui\app\12-mood.js
QQ Agent\resources\app\ui\app\14-integrated.js
```

---

## 第 1 步：改导航数组 `ui\app\14-chrome.js`

搜 `key: 'ops'`（大约在第 49 行），把 `subs` 里的 `'mood', 'integrated'` 删掉：

```js
// 改前
{ key: 'ops', label: '工具', home: 'snowluma', subs: ['snowluma', 'harness', 'mood', 'integrated'] },

// 改后
{ key: 'ops', label: '工具', home: 'snowluma', subs: ['snowluma', 'harness'] },
```

> 左栏项目是**按 `subs` 生成的**，改这里两项就消失了。不用动别处。

## 第 2 步：删标签与图标（同一个文件）

搜 `people: '群友'`（大约第 60 行）：

```js
// 改前
people: '群友', mood: '心情', integrated: '集成系统'

// 改后
people: '群友'
```

再搜 `mood: 'M3 12h4l2-5`（大约第 83 行），删掉这两行：

```js
    mood: 'M3 12h4l2-5 3 10 2-5h7',
    integrated: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
```

## 第 3 步：改 `ui\index.html`（三处）

**① 两个"身份锚点"**（搜 `data-tab="mood"`，大约第 98 行）：

```html
<!-- 改前 -->
<button class="tab" type="button" data-tab="people"></button>
<button class="tab" type="button" data-tab="mood"></button>
<button class="tab" type="button" data-tab="integrated"></button>

<!-- 改后 -->
<button class="tab" type="button" data-tab="people"></button>
```

**② 两个视图容器**（搜 `id="view-mood"`，大约第 266 行）：整段删掉

```html
<section id="view-mood" class="view">
  <div id="mood-page" class="usage-pane"></div>
</section>

<section id="view-integrated" class="view">
  <div id="integrated-page" class="usage-pane"></div>
</section>
```

**③ 两个脚本标签**（搜 `12-mood.js`，大约第 499 行）：两行都删

```html
<script defer src="/app/12-mood.js"></script>
<script defer src="/app/14-integrated.js"></script>
```

## 第 4 步：移走两个页面脚本

```
QQ Agent\resources\app\ui\app\12-mood.js          → 移走（别急着删）
QQ Agent\resources\app\ui\app\14-integrated.js    → 移走
```

## 第 5 步：重启宿主

界面脚本是跟着窗口加载的，**必须重启**（不是刷新插件列表就能生效）。

---

## 怎么确认成功

1. 顶栏「工具」→ 左栏只剩 **SnowLuma / 自检**；
2. 控制台（F12）**没有** `Cannot read properties of null` 之类的报错；
3. 「设置」页左栏还能看到「睡眠·元气·旅行心境系统」小面板 —— 它显示
   **⚡元气 / 🧠活跃心境 / 😴睡眠 / 📍她在哪**，取代了原来的心情页。

---

## 两个无害的小残留（不用管）

- `ui\style.css` 里还有一批 `.mood-*` / `.tg-*` 样式，页面没了它们就是死代码，不影响渲染；
- 浏览器 `localStorage` 里可能还存着 `tg-tab=hp` 之类的旧值 —— 那个 tab 已经不存在，
  打开设置页会自动回落到第一个分区，不会白屏。

---

## 回滚

把第 0 步备份的四个文件覆盖回去，两个 `*.js` 放回 `ui\app\`，重启。
