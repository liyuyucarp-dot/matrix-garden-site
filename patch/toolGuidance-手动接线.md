# toolGuidance：手动接线（不想跑脚本时照这个改）

> 这 3 处是 v2.2.3 新增的核心补丁，**手拷做不到**（两处是插入、一处是改既有的一行）。
> 跑 `apply-core-patch.ps1` 会自动完成；本文是给"脚本跑不了"的人的手动版。
> 作用：让技能可以用 `skill.json` 的 `"toolGuidance": "hooks"` 声明"我的工具引导写在
> `hooks['before-llm-messages']` 里"，从而不再被误报「注册了工具但没有提示词片段」。

---

## ① `src\skills\manifest.js` —— 在白名单里放行 `toolGuidance`

`normalizeManifest()` 是**白名单**：不在返回对象里显式列出的字段一律丢弃，
所以只在 `skill.json` 里写 `toolGuidance` 是没用的，必须先在白名单里放行。

找到：

```js
      prompt: normalizePrompt(raw.prompt),
```

在它**之后**加一行（保持缩进一致）：

```js
      toolGuidance: cleanString(raw.toolGuidance, ''),
```

> `cleanString` 是本文件已有的小工具，直接用。

---

## ② `src\plugin-loader.js` —— 换掉那条 lint 判据（改一行）

找到（`lintKindPlacement()` 内，大约第 700 行）：

```js
  if (kind === 'skill' && hasTools && !manifest.prompt && typeof promptSections !== 'function') {
```

改成：

```js
  if (kind === 'skill' && hasTools && !manifest.prompt && typeof promptSections !== 'function' && !manifest.toolGuidance) {
```

**为什么要改**：kp 的引导全在 `hooks['before-llm-messages']`（7 段 `stableParts`），
旧判据只认 `manifest.prompt` / `promptSections()`，看不到钩子 —— 于是永远误报。
声明了 `toolGuidance` 就跳过这条提示；**没声明的技能照旧提示**（sticker 那类真没引导的仍被抓）。

---

## ③ `skill.json` —— 给"引导写在钩子里"的技能加声明

`skills\kp\skill.json`（或任何这类技能）：

```json
{
  "id": "kp",
  "author": "鲤鱼 / 西塔",
  "enabledByDefault": true,
  "toolGuidance": "hooks",
  "capabilities": [],
  ...
}
```

**这不是本包的组件**（分发包不含 `skills\kp`），所以上面 ①② 是"给宿主装能力"，
③ 是"给具体技能打声明"。装完 ①②，任何技能都能用这个字段。

---

## 验证

1. 改完 `node --check src\plugin-loader.js` 与 `src\skills\manifest.js` 都应无输出；
2. 重启 QQ Agent；
3. 打开「设置 → 技能」，`kp` 那张卡上的 **⚠ 有警告** 应该消失
   （其它卡如果还有警告，说明它们是真的没有任何工具引导 —— 那正是这条 lint 要抓的）。

> 幂等：`apply-core-patch.ps1` 用 marker 判重（`toolGuidance` / `显式声明出来` / `!manifest.toolGuidance`），
> 重复运行不会插两遍。②的判断是"命中必须唯一"，宿主把这行改过就会报错让你手动改，**不会瞎猜**。
