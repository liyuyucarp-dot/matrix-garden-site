
  // [[courtyard:panel]] 界面入口：把 configSchema 里 type:'action' + panel 的条目摘出来单独校验，
  // 剩下的 schema 不再带 action —— 否则通用表单会渲染出一颗点不动的"按钮"。
  const rawSchema = (raw.configSchema && typeof raw.configSchema === 'object') ? raw.configSchema : {};
  const { panels, problems: panelProblems } = collectPanels(id, rawSchema);
  for (const p of panelProblems) problems.push(p);
