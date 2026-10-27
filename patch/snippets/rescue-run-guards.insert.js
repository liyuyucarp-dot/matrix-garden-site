  // ⑤ 出站守卫管道：插件注册的审查器在此逐个过（可否决/收窄）。
  //    放在 grounded-select 之后 —— 守卫看到的是"即将发出去的最终句子"。
  const guarded = await runOutboundGuards({ text: body, trigger, messages }, log);
  if (!guarded.length) return [];

