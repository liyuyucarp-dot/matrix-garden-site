# 矩阵庭院 · 官方 0.4 适配补丁（v1.1.2）

> 目标：让**矩阵庭院的 16 个组件**（11 插件 + 5 技能）在 **QQ Agent 官方 0.4（preview）** 上跑起来，
> 并**补回「插件自带界面」**（`settingsUi` 设置页 + `configSchema` 里的 `action` 面板）。
>
> 已实测（不是推测）：
> 1. 用官方 0.4 自己的 `loadPlugins()` 加载 **27 个组件（11 官方 + 16 我方）→ 成功 27 / 失败 0 / 警告 0**；
> 2. 真实 `createApp()` 启动后打 HTTP：面板页、`/plugin-assets` 模块、`/api/skills` 三路全通（见第五节）；
> 3. 补丁幂等：第二次运行已打过的项全 SKIP。
> 4. **v1.1.2 新增**：补上 `api.storage`（0.4 的 `createSkillApi` 没有它）—— 实测写→读→落盘→`__proto__` / 1MB 两条防护全过；`storage.json` 落在 `<DATA_DIR>/plugin-data/<id>/`，与面板 `@data` 路由同源。

---

## 版本

| 版本 | 内容 |
|---|---|
| v1.0.0 | 运行必需：3 个核心文件 + 3 处服务接线（**6 项**） |
| v1.1.0 | + UI 支持：`panel.js` 契约模块、manifest 放行、manager 状态暴露、两条静态路由、前端入口（**10 项**，累计 16 项） |
| v1.1.1 | 只修 README（v1.1.0 的包里 README 被上一次编辑拼接坏了：新旧两版叠在一起、后半段还在说"settingsUi 不支持"）。**补丁内容一字未变。** |
| **v1.1.2** | **补 `api.storage`**（3 项：`DATA_DIR` 导入 / `makeSkillStorage()` / `api.storage` 成员）。此前只补了面板**路由**没补**写入端** ⇒ `@data/storage.json` 永远 404、面板整页空白。累计 **19 项**。 |

---

## 一、补丁集做什么（16 项，全部「纯新增」或「改一行」）

### A. 让它跑起来（v1.0.0，6 项）

| # | 动作 | 为什么 |
|---|---|---|
| 1~3 | 新增 `src/half-life.js`、`src/memory-people.js`、`src/memory-audit.js` | 官方 0.4 没有它们；`life-system` / `favor-core` 是**静态 import**，缺文件 = 整块加载失败（`ERR_MODULE_NOT_FOUND`） |
| 4~6 | 给技能接上核心服务（`src/skills/manager.js` / `src/plugin-loader.js` / `src/app.js` 各插一段） | 官方 0.4 的 `createSkillApi()` **没有** `services()` / `onServices()` / `api.onebot`；`travel-whale`、`qqzone`、`qzone` 这些后台任务不经过工具调用、拿不到 `ctx` ⇒ 只能靠这个口子拿 `sender`。缺了就是"静默失声"：日志存档相册全正常，一条消息也寄不出去 |

### B. 补回插件自带界面（v1.1.0，10 项）

| # | 文件 | 处数 | 动作 |
|---|---|---|---|
| 7 | `src/skills/panel.js` | 1 | **整文件新增**：面板契约（路径校验 / URL 拼装 / CSP / 扩展名白名单），从 0.4.8.x 原样搬来，零改动 |
| 8 | `src/skills/manifest.js` | 4 | 导入 `collectPanels`/`stripPanelActions`；算 `rawSchema`+`panels`；**replace-block** 把 `configSchema:` 一行换成三行（`stripPanelActions` + `panels` + `settingsUi`）；补 `normalizeSettingsUi()` |
| 9 | `src/skills/manager.js` | 1 | `status()` 是**显式白名单**，这里加 `panels` / `settingsUi` |
| 10 | `src/app.js` | 2 | 导入 panel.js 常量；插两条只读静态路由：`/plugin-panel/<id>/…`（iframe 面板 + `@data`）与 `/plugin-assets/<id>/…`（settingsUi 模块用 `import()` 取自己） |
| 11 | `ui/app/06-settings-render.js` | 2 | 技能设置弹窗里加「插件自带界面」按钮区 + 一层**自带 overlay**（iframe / 动态 import），不依赖控制台原弹层 |

> **两个白名单是这次最容易踩空的地方**：`normalizeManifest()` 和 `manager.status()` 都是显式字段白名单，
> 少写一处，后端就算算出了 `panels`，`/api/skills` 也不会带出来 —— 症状是"按钮怎么都不出现"。

**新增的 api 成员**（补丁后每个技能都能用）：

```js
services()      // → { sender, store, onebot, ... }，未就绪时为 null
onServices(fn)  // 注册"服务就绪"回调；已就绪会立即回调一次，返回取消函数
api.onebot      // getter，从 services.onebot 取（0.4 的 api 原本没有这个成员）
```

---

## 一·五、v1.1.2 补的第三块：`api.storage`（面板的数据入口）

### 症状

面板能打开，但**一行数据都没有**；`/plugin-panel/courtyard-map/@data/storage.json` 返回 **404**。

### 为什么

面板路由读的是 `<DATA_DIR>/plugin-data/<id>/storage.json`（`src/skills/panel.js` 的 `PANEL_DATA_FILE`），
而**写入端 `api.storage` 在官方 0.4 里不存在** —— 0.4.8.x 的 `createSkillApi()` 有，0.4 preview 没有。

插件那边写的是 `api?.storage?.set?.(…)`（可选链），所以**不报错，只是静默不写**，很难查。

### 补了什么（3 项）

| # | 动作 | 位置 |
|---|---|---|
| 17 | 插入 `import { DATA_DIR } from './config.js';` | `src/plugin-loader.js` |
| 18 | 插入 `makeSkillStorage(skillId)`（`get/set/remove`；1MB 上限；拒 `__proto__`/`constructor`/`prototype`） | `src/plugin-loader.js`，`createSkillApi` 之前 |
| 19 | api 对象加一行 `storage: makeSkillStorage(skillId),` | `src/plugin-loader.js`，`config:` 之后 |

落盘路径与面板路由**同源**，所以补完就通，不需要改 `panel.js`：
```
<DATA_DIR>/plugin-data/<skillId>/storage.json
```

### 实测（0.4 preview 源码树）

```
api 有 storage: true | set/get/remove: function/function/function
写入 7 条 → 回读 7 条 ✅
落盘：<DATA>/plugin-data/courtyard-map/storage.json（键 view，7 条）✅
__proto__ 防护 ✅ 拦截 ｜ 1MB 上限 ✅ 拦截 ｜ remove → get 返回 null ✅
verify-load：27/27 成功 ｜ verify-panel：面板/资产/api 全 200
```

> ⚠️ 幂等提示：第 19 项的 marker 是 `storage: makeSkillStorage(skillId),`，
> 第 18 项是 `function makeSkillStorage(skillId)`，第 17 项是整条 import ——
> 三个 marker 必须足够具体，否则会互相误判成"已打过"（第一版就踩了这个坑）。

---

## 二、**不要**做什么（比做什么更重要）

| 我们原本的补丁 | 在官方 0.4 上要不要打 | 原因 |
|---|---|---|
| `src/prompt.js`（79KB 整文件覆盖） | **不要** | 官方 0.4 的 `prompt.js` 已经自带 `collectSkillSections()` → `skillManager.getPromptSections()` → `renderSkillSections()` 并注入（第 194/201/222/236/274 行）。**它本来就支持技能提示词段**；我们那份是按 0.4.8.7 改的（41KB → 79KB 差异巨大），覆盖只会把 0.4 自己的逻辑换掉 |
| `src/reply-rescue.js`（12.6KB 覆盖 5.5KB） | **不要** | 官方 0.4 的 `Orchestrator` 没有 `registerOutboundGuard`；我们那份是为"出站守卫管道"配套的。要那个能力是另一项独立移植 |
| `manifest-toolguidance` 那 3 件 | **不要** | 那是 0.4.8.x 的 lint 才有的判据；官方 0.4 的 `lintKindPlacement` 没有这段，锚点也不存在（实测 2 项命中失败） |
| `ui/app/08-modals.js` | **不要** | 早前已确认它是旧版原文件快照，早就从补丁清单删了 |

---

## 三、安装

```
1. 把矩阵庭院的 16 个组件拷到官方 0.4 的源码根：
     plugins\{11 个}  →  <0.4 根>\plugins\
     skills\{5 个}    →  <0.4 根>\skills\      （0.4 出厂没有 skills 目录，新建即可）

2. 打核心补丁（必须）：
     powershell -ExecutionPolicy Bypass -File .\apply-core-patch.ps1 -AppDir "<0.4 根>" -Yes
   不带 -AppDir 会进"演练模式"，只打印会动哪些文件。

3. 重启 QQ Agent。
```

`apply-core-patch.ps1` 的行为：先备份（备份放在**目标树**的 `_core_patch_backup_<时间戳>\`，不污染补丁包）、
按 `marker` 幂等、锚点/待替换块找不到就报错**不动手**。重复运行安全。

支持四种 kind：`copy-new`（只补缺）、`copy`（整文件覆盖）、`anchor-insert`（锚点插入）、
`replace-block`（多行整块替换，v1.1.0 新增 —— manifest 的 `configSchema:` 那一行要换成三行）。

---

## 四、已知降级（打完 v1.1.0 之后还剩的）

| 项目 | 现状 | 影响 |
|---|---|---|
| 面板入口的位置 | 「设置 → 技能 → 某个组件 → 设置」，弹窗底部有「插件自带界面」按钮区 | 不像 0.4.8.x 那样有独立侧栏分区 / 顶栏页签，功能等价 |
| `courtyard-map` 地图页 | **可用**（`/plugin-panel/courtyard-map/panel/map.html`，实测 200） | 页面自己 fetch 的数据接口在 0.4 上可能缺 → 图可能空着（页面本身能开） |
| `sleep-mood` 的 settingsUi | **可用**（模块能 import、能 render） | 它内部 fetch 的 `/mood-dashboard.json` 在 0.4 上没有发布器 → "实况"区会显示读不到；**开关仍能改**（走 `POST /api/config`） |
| 出站守卫（guard pipeline） | 未移植 | `registerOutboundGuard` 用 `typeof` 降级为空实现，不报错 |
| 提示词易变度排序 | 用官方原版 | 只是缓存优化缺失，功能不受影响 |

---

## 五、顺手修的一处

`plugins/bili-whale/plugin.json` 的 `category` 原本是 `"fun"` —— 官方 0.4（以及 0.4.8.7）的合法值只有
`model | message | knowledge | media | utility`，非法值会被回退成 `utility` 并每次启动打一条警告。
已改为 `"media"`。**该改动也在正式包（v2.2.4 起）同步了。**

---

## 六、怎么自己验证

```bash
# 1) 只看补丁会动什么（不动手）
powershell -ExecutionPolicy Bypass -File ./apply-core-patch.ps1 -AppDir "<0.4 根>" -DryRun

# 2) 真打（幂等，可重复跑）
powershell -ExecutionPolicy Bypass -File ./apply-core-patch.ps1 -AppDir "<0.4 根>" -Yes

# 3) 用 0.4 自己的 loader 加载一遍（不启动服务）
node verify-load.mjs "<0.4 根>"
#   期望：加载结果：共 N 个组件 | 成功 N | 失败 0 | 警告 0

# 4) 启动真服务 + 打面板路由（v1.1.0 起的验收脚本）
node verify-panel.mjs "<0.4 根>"
#   期望：面板页 200 / plugin-assets 200 / /api/skills 带 panels+settingsUi
```

> ⚠️ 启动服务需要 `node_modules`（`ws`、`js-yaml` 等）。官方 zip 里有，解压时别漏。
> 脚本本身不装依赖。

---

## 七、回滚

把 `_core_patch_backup_<时间戳>\` 里对应文件覆盖回去即可（`src\app.js`、`src\plugin-loader.js`、
`src\skills\manager.js`、`src\skills\manifest.js`、`ui\app\06-settings-render.js`）；
新增的四个文件（`half-life.js`、`memory-people.js`、`memory-audit.js`、`skills/panel.js`）直接删掉。
**不动任何数据**（`data\` 目录不受影响）。
