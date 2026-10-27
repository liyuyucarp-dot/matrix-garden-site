  // [[travel-whale:services]] 把核心服务交给技能：后台任务型技能（旅行鲸鱼等）的 ticker
  // 不经过工具调用，拿不到 ctx ⇒ 只能靠这个口子发消息。
  // 纯新增；不读它的既有技能行为完全不变。
  // ★ 2026-10-17：0.4.8.5 起宿主不再有 stickers 这个变量（表情管理搬去 sticker 插件），
  //   直接写它会 ReferenceError ⇒ 宿主起不来。所以用 typeof 守卫，0.4.5 / 0.4.8.5 两版都安全。
  skillManager.setServices({
    store, memory, sender, sessions, onebot, reminders, videoReader,
    orchestrator, emit, log,
    // [[outbound-guard]] 出站守卫管道注册口（2026-10-24，§3.3）：插件可注册自定义出站审查器
    registerOutboundGuard: (fn) => orchestrator.registerOutboundGuard(fn),
    // [[send-proactive]] 主动发送标准入口（2026-10-24，§3.1 收尾）：
    // 限频/去重/留档全在核心发送队列里 —— 插件不要再自建 OneBot HTTP 兜底直发，
    // HTTP 兜底只作为 services 未就绪时的降级路径保留。
    sendProactive: async (chatKey, text) => {
      const lines = String(text ?? '').split(/\r?\n/).filter((s) => s.trim());
      if (!lines.length) throw new Error('sendProactive：内容为空');
      await sender.sendTextBatch(chatKey, lines);
      return { ok: true, via: 'core-sender' };
    },
    ...(typeof stickers === 'undefined' ? {} : { stickers })
  });
