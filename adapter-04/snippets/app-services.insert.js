  // [[travel-whale:services]] 把核心服务交给技能（**官方 0.4 适配版**）。
  //
  // 为什么需要：travel-whale 的 ticker、qqzone/qzone 的定时任务都不经过工具调用，
  //   拿不到 ctx ⇒ 只能靠这个口子拿到 sender 去发消息（否则"静默失声"：
  //   日志存档相册全正常，就是寄不出一条消息）。
  //
  // ⚠️ 与 0.4.8.x 版的差异（适配官方 0.4 时踩到的）：
  //   官方 0.4 的 Orchestrator **没有** registerOutboundGuard —— 那是 v2 补丁加的能力。
  //   直接写 `(fn) => orchestrator.registerOutboundGuard(fn)` 会在插件一调用时抛
  //   TypeError，所以这里用 typeof 守卫，两个版本都能跑。
  skillManager.setServices({
    store, memory, sender, sessions, onebot, reminders, videoReader,
    orchestrator, emit, log, stickers,
    registerOutboundGuard: typeof orchestrator.registerOutboundGuard === 'function'
      ? (fn) => orchestrator.registerOutboundGuard(fn)
      : () => () => {},
    // 主动发送标准入口：限频/去重/留档全在核心发送队列里，
    // 插件不要自建 OneBot HTTP 直发（HTTP 兜底只在 services 未就绪时保留）。
    sendProactive: async (chatKey, text) => {
      const lines = String(text ?? '').split(/\r?\n/).filter((s) => s.trim());
      if (!lines.length) throw new Error('sendProactive：内容为空');
      await sender.sendTextBatch(chatKey, lines);
      return { ok: true, via: 'core-sender' };
    }
  });
