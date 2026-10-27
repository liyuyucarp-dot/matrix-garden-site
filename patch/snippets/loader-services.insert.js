    // [[travel-whale:services]] 后台任务型技能用它发消息/排提醒（工具 ctx 里也有，但 ticker 不经过工具）
    services: () => skillManager.services,
    onServices: (fn) => skillManager.onServices(fn),
