    // [[travel-whale:services]] 后台任务型技能用它发消息/排提醒（工具 ctx 里也有，但 ticker 不经过工具）
    services: () => skillManager.services,
    onServices: (fn) => skillManager.onServices(fn),
    // 官方 0.4 的 api 里没有 onebot（0.4.8.x 有）。qqzone / qzone 靠它做 QQ 空间的直连
    // 调用，拿不到就只剩降级路径。用 getter 从核心服务里取 —— 组件构造（app.js 第 636 行）
    // 在插件加载（第 1527 行）之前，所以取值时 services 已经就绪。
    get onebot() { try { return skillManager.services?.onebot || null; } catch { return null; } },
