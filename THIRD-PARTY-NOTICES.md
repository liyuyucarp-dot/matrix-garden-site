# 第三方声明与资产边界（THIRD-PARTY-NOTICES）

本仓库的 **MIT LICENSE 只覆盖代码与文档**。下面这些不属于 MIT 覆盖范围，或另有其许可。

---

## 一、角色图（`assets-optional/`，**不随本仓库分发**）

`assets-optional/refs.manifest.json` 只记录文件名与 sha256，**仓库里不含任何图片**。

| 来源 | 数量 | 说明 |
|---|---|---|
| 作者自行 AI 生成 | 部分 | 由作者用生成模型产出并自行整理 |
| 第三方**已开源**的 AI 生成作品 | 部分 | 来源于公开可获取的分享，原分享者未附带明确许可条款 |

**结论：来源混杂且部分无明确授权 → 一律不随仓库与发布包分发。**

使用方式（三选一）：

1. **自备（推荐）**：放自己的 `data/skills/travel-whale/refs/<id>--pro.jpg` / `<id>--q.jpg`；
2. **从原出处下载**：按原分享者要求的署名/使用范围自行获取；
3. **不配**：功能不依赖参考图，只是明信片/立绘风格会不统一。

校验与拷贝：`node tools/link-refs.mjs --check --from <目录>` / `--app <宿主> --from <目录>`。

> 立绘 `components/skills/courtyard-map/panel/portraits/*.webp` 是**本包自制**（为七位旅伴绘制的立绘），
> 随组件分发；如你要二次分发，请保留本声明。

---

## 二、第三方组件

| 组件 | 位置 | 许可/来源 |
|---|---|---|
| `bili-whale` | `components/plugins/bili-whale/` | 自带 `LICENSE`（**以其自带许可为准**，优先于本仓库 MIT） |
| 其余 15 个组件 | `components/` | 本仓库 MIT 覆盖（作者自制） |

---

## 三、宿主与运行时

- 本仓库**不含** QQ Agent 宿主本体；`patch/` 与 `adapter-04/` 只是**补丁片段**，按原宿主许可用于其自身。
- 运行期数据（`data/`）、群号/QQ 号/昵称、API 密钥**永不入库**：
  `tools/probes/secrets.mjs` 会在每次构建时扫描私名、QQ/群号、手机号、`sk-` 密钥与本机绝对路径。

---

## 四、字体/图标

本仓库未内嵌第三方字体或图标集；面板使用系统字体与 emoji。
