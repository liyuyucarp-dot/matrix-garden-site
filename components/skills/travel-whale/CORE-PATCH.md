# 核心补丁：让「后台任务型」技能拿得到核心服务

矩阵庭院（`skills/travel-whale/`）本身只是一个技能，但它要真正做到"自己会出门、
会寄明信片、会回家"，**必须先给核心开一个口子**：把 `sender` / `reminders` 等
核心实例暴露给技能。

> **为什么非改不可**：技能能拿到的 `ctx` 只在**工具被调用时**才有
> （里面有 `sender`、`reminders`、`store`…）。但鲸鱼寄明信片、回家、自动出发
> 这些事**发生在没有任何工具调用的时刻** —— 是后台定时器驱动的。
> 拿不到 `sender`，就只能等下一次有人调它的工具才能干活；重启后甚至永远等不到。
>
> 实测这个失败是**完全静默的**：日志正常、存档正常、相册正常，就是一条消息都发不出去。
> 写端到端测试时踩过这个坑（见 `待读取/旅行鲸鱼测试/README.md`）。
>
> 这个口子是**通用扩展点**，不止服务鲸鱼：任何"定时推送 / 自主发言 / 后台轮询"
> 类技能都需要它。符合项目"核心只加最小钩子"的原则。

---

## 改动位置

| 文件 | 改动 |
|---|---|
| `src/skills/manager.js` | 新增 `setServices()` / `get services` / `onServices()` |
| `src/plugin-loader.js` | `createSkillApi` 里新增 `api.services()` 与 `api.onServices(fn)` |
| `src/app.js` | 核心服务构造完成之后注入一次 |

**全部是纯新增**，没有修改任何已有函数的行为。

---

## 改动内容

### ① `src/skills/manager.js`（`SkillManager`）

构造函数里加两个字段：

```js
this.servicesRef = null;         // 核心服务对象
this.serviceListeners = new Set();
```

新增三个成员（位置在 `setLog` 之后）：

```js
setServices(services) {
  this.servicesRef = services && typeof services === 'object' ? services : null;
  for (const fn of this.serviceListeners) {
    try { fn(this.servicesRef); } catch (error) { this.#warn('core', 'services 监听器失败', error); }
  }
  return this.servicesRef;
}

get services() { return this.servicesRef; }

onServices(fn) {
  if (typeof fn !== 'function') return () => {};
  this.serviceListeners.add(fn);
  if (this.servicesRef) {                    // 已就绪 → 立即回调
    try { fn(this.servicesRef); } catch (error) { this.#warn('core', 'services 监听器失败', error); }
  }
  return () => this.serviceListeners.delete(fn);
}
```

**关键设计：服务未就绪时"不回调"**，而不是回调 `null`。
否则技能会拿到一个半成品服务对象去解构 `svc.sender.xxx` 直接抛错。

### ② `src/plugin-loader.js`（`createSkillApi` 的返回值）

```js
// 核心服务（store/memory/stickers/sender/sessions/onebot/reminders/videoReader/
// orchestrator/emit/log）。后台任务型技能用它发消息、排提醒 ——
// 这些能力在工具的 ctx 里也有，但后台 ticker 不经过工具调用。
services: () => skillManager.services,

// 注册"核心服务就绪"回调；已就绪会立即回调一次。
// 两种加载顺序（先注入后注册 / 先注册后注入）都能正确触发。
onServices: (fn) => skillManager.onServices(fn),
```

### ③ `src/app.js`（服务构造完之后）

```js
const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit, reminders, videoReader });

// ↓↓↓ 新增 ↓↓↓
skillManager.setServices({
  store, memory, stickers, sender, sessions, onebot, reminders, videoReader,
  orchestrator, emit, log
});
```

---

## 技能侧怎么用

```js
let services = null;

export function setup(api) {
  // 已就绪会立即回调；否则等 app.js 注入
  api.onServices((svc) => { services = svc; startTicker(); });

  // 兜底：服务还没来也先把轮询起起来（tick 内部判断 sender 在不在）
  startTicker();
}

async function say(chatKey, text) {
  if (!services?.sender?.sendTextBatch) {
    log('[travel-whale] 发送队列不可用，本条跳过');   // ⚠️ 必须留痕，别静默
    return false;
  }
  await services.sender.sendTextBatch(chatKey, [text]);
  return true;
}
```

**两条纪律**（都是踩坑换来的）：

1. **一定判空**：`services` 在极早期可能是 `null`，直接解构会抛错；
2. **失败必须留痕**：静默跳过会让"功能没生效"变成未解之谜 —— 这正是本次踩的坑。

---

## 向后兼容

- 不读 `api.services` / `api.onServices` 的既有技能（21 个）**行为完全不变**；
- `setServices` 只在 `app.js` 里调用一次，不改变任何启动顺序；
- `onServices` 的返回值是取消函数，不调用也不会泄漏（监听器随 `SkillManager` 单例存活）。

### 回滚方式

三处都是**纯新增代码块**，逐块删掉即可：

| 文件 | 删掉什么 |
|---|---|
| `manager.js` | 构造函数两行 + `setServices` / `get services` / `onServices` 三个成员 |
| `plugin-loader.js` | `services:` 与 `onServices:` 两行 |
| `app.js` | `skillManager.setServices({...})` 那一整块 |

---

## 验证

`skills/travel-whale/` 的端到端测试覆盖了这个口子：

| 场景 | 结果 |
|---|---|
| 服务未注入时注册监听 | 不回调（避免拿到 null）✓ |
| 注入后 getter 就绪 | ✓ |
| 注入后再注册 | 立即拿到 ✓ |
| 取消注册后 | 不再回调 ✓ |
| 注入 `null` | getter 返回 `null`，旧技能无感 ✓ |

另有一个**反向验证**：测试里把 `onServices` 写成空函数时，技能一条消息都发不出去
且完全静默 —— 修好后立刻捕获到 7 条消息。说明这个口子既是能力，也是**必须留痕的失败点**。

---

## ⚠️ 附带发现：热重载不会重载子模块

写这个技能时踩到一个**与前缀缓存/加载器都无关、但同样隐蔽**的坑：

加载器用 `import(entryUrl + '?t=' + Date.now())` 刷新入口，但入口里的
`import './state.js'` 解析出的仍是不带时间戳的 URL —— Node 的 ESM 缓存按 URL 记，
**子模块会一直是进程启动时那一版**。

后果：出现「新 `index.js` + 旧 `state.js`」的组合。若新入口在**顶层**读了子模块
新增的字段，就会整个技能加载失败；而热重载失败走的是 `hadPrevious` 分支，
**只记内存、不写日志**，日志里只有 `21 成功，1 失败`。

**两条应对**（已写进技能 README 的「热重载的边界」一节）：
1. 改子模块后**重启应用**；
2. 入口顶层**不要读子模块的新字段**，用惰性函数包起来。
