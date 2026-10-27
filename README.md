# 矩阵庭院（matrix-garden-site）

QQ Agent 的「她自己的生活」整合包：**15 个组件**（4 技能 + 11 插件）+ **两套宿主补丁** + **一条可复现的构建流水线**。

- 站点/下载入口：本仓库 GitHub Pages（`index.html`）
- 发布产物：本仓库 **Releases**（由 CI 自动产出，附 `SHA256SUMS`）
- 许可：代码与文档 **MIT**；角色图**不随仓库分发**（见 `THIRD-PARTY-NOTICES.md`）

---

## 一、仓库结构

```
components/
  skills/          courtyard-doctor · courtyard-map · qzone（v2.3.0 起合并了原 qqzone）· travel-whale
  plugins/         autobiography · bili-whale · courtyard-bus · favor-core · knowledge-base
                   learning-loop · life-system · mind-wish · silence-ping · sleep-mood · think-gate
patch/             核心补丁（QQ Agent 0.4.8.x，11 项）
adapter-04/        官方 0.4 适配补丁（19 项：服务接线 + 插件自带界面 + api.storage）
docs/              00-先读我 / 安装说明 / 组件介绍 / 更新日志 / UI-下线两页
tools/
  build-release.mjs    七道闸 + 打包
  install.mjs          跨平台安装/打补丁（取代 install.ps1）
  link-refs.mjs        角色图校验与拷贝（图不进仓库）
  probes/*.mjs         syntax / load / snapshot / secrets / panel
  fixtures/            桩宿主 + 快照夹具（全为虚构数据）
assets-optional/   角色图清单（只有 sha256，不含图）
components.json    组件清单（单一事实源）
```

站点文件（`index.html` / `assets/`）保持在仓库根，GitHub Pages 直接可用。

---

## 二、安装（跨平台，只需 Node ≥ 20）

```bash
# 0. 先退出 QQ Agent（组件是运行时读的，热覆盖会出新旧混用）
# 1. 装组件
node tools/install.mjs --app "D:\QQ-Agent 0.4 preview" --components

# 2.0 官方 0.4 preview 宿主：打适配补丁
node tools/install.mjs --app "D:\QQ-Agent 0.4 preview" --adapter adapter-04

# 2.1 0.4.8.x 宿主：打核心补丁
node tools/install.mjs --app "F:\QingQingyuAgent\resources\app" --patch patch

# 3. 角色图（可选，自备）
node tools/link-refs.mjs --app "D:\QQ-Agent 0.4 preview" --from "D:\my-refs"

# 先看会做什么、不真改：
node tools/install.mjs --app "<APP>" --components --patch patch --dry-run
```

特性：自动识别宿主形态（源码树 / `resources/app`）、按 `manifest.json` 的 marker 幂等、备份到 `<app>/_backup_<stamp>/`、**任一操作失败自动回滚**。

---

## 三、构建（七道闸，任一失败不产包）

```bash
node tools/build-release.mjs                 # 跑闸 + 出 dist/*.zip
node tools/build-release.mjs --no-zip        # 只跑闸（PR 检查）
node tools/build-release.mjs --strict        # 跳过也算失败（发布用）
node tools/build-release.mjs --version 3.0.0
```

| # | 闸 | 抓什么 |
|---|---|---|
| 1 | 组件清单 | 缺目录 / manifest 非法 / `components.json` 与 manifest 版本漂移 |
| 2 | 语法 | `node --check`（组件 + tools + 补丁片段） |
| 3 | 加载探针 ×2 | 用**桩宿主**分别按 0.4.8.x 与官方 0.4 preview 的 api 形状跑 `setup()`：抓"加载即崩" |
| 4 | **快照探针** | 用夹具存档真跑 `buildSnapshot()` + `publishNow()`，断言 7 位旅伴 / 立绘路径存在 / `storage.json` 落盘 —— **防 v2.2.7 的 `portraitExists` 那次事故** |
| 5 | 脱敏/隐私 | 私名、QQ/群号、手机号、`sk-` 密钥、本机绝对路径 |
| 6 | 面板契约 | `configSchema.action.panel` 文件存在、css/js 带 `?v=`、`portraits/*` 引用都存在 |
| 7 | 打包 | ZIP **显式 UTF-8 标志（EFS bit 11）** + `SHA256SUMS` + `release.json` |
| 8 | ESLint | 可选：只开 `no-undef`（装了 eslint 就跑，没装则跳过；`--strict` 下跳过=失败） |

> 为什么要有闸 4：`portraitExists is not defined` 只在 `publishNow` 里触发 —— 语法检查看不见、加载探针也不经过，结果包发出去面板整页空白。

---

## 四、CI

`.github/workflows/ci.yml`

- **pr / push**：三平台（ubuntu / windows / macos）× Node 20/22 跑 `--no-zip`（1~6 闸）
- **smoke**：ubuntu 上额外跑 `install.mjs --dry-run`
- **tag `v*`**：跑 `--strict` → 打 zip → 上传 Release，附 `.sha256` 与 `release.json`

---

## 五、发版流程（人只做三件事）

1. 改 `components.json` 的 `version`（组件版本在各自 manifest 里）；
2. 补 `docs/更新日志-Vx.y.z.md`；
3. `git tag vX.Y.Z && git push --tags` —— 其余交给 CI。

---

## 六、已知边界

- 探针是**离线**的：不连真实 OneBot / Qzone，也不发消息。真实环境验收仍靠《安装说明》里的手工清单。
- 快照夹具是**虚构数据**（假 QQ 号、假城市），验证的是"结构不崩"，不是"业务正确"。
- 角色图 16 张来源混杂且部分无明确授权 → **永远不进仓库、不进发布包**。
