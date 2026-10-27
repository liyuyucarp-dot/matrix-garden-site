  // ★ 2026-10-23（P0-1）：工具调用残骸当正文 —— 见文件头 LEAK_PATTERNS 里那条的说明。
  //   为什么放在这一层也要挡：`looksLikeSystemPromptLeak` 只覆盖"系统提示词泄露"那类，
  //   而残骸是**格式坏掉的工具调用**，两件事，得各挡各的。
  if (/<\/?(?:tool_call|tool_use|tool_result|invoke\b|antml:)|<\/?(?:function|parameter)[\s=>]/i.test(t)) return null;
