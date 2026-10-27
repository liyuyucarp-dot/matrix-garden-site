  // ★ 2026-10-23（P0-1）：**工具调用残骸**。模型把工具调用写成了文本、而外层 `<tool_call>`
  //   缺失或被截断时，正文里会留下 `<parameter name="messages">…</parameter>` 这种碎片。
  //   它不是"要说的话"，发进群等于把协议细节摊给群友看（12:33 的真实事故）。
  //   ⚠️ 不用 `\b`：`<tool_call_36a8b9…>` 里 `l` 与 `_` 都是单词字符、`\b` 不成立，
  //      那正是核心解析器当初漏掉这种格式的原因。这里用 `[\s=>]` 收尾。
  /<\/?(?:tool_call|tool_use|tool_result|invoke\b|antml:)|<\/?(?:function|parameter)[\s=>]/i,
