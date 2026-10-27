      // ★ 2026-10-25（v2.2.3）：技能显式声明"工具引导写在别处"。
      //   典型值 'hooks' —— 像 skills/kp 那样在 before-llm-messages 里按群注入策略段。
      //   plugin-loader 的 lintKindPlacement 读它决定要不要提示"注册了工具但没提示词片段"。
      //   ⚠️ 必须在这里放行：normalizeManifest 是**白名单**，不列的字段一律丢弃，
      //      直接写在 skill.json 里根本到不了 manifest（这是 v2.2.3 踩到的第一个坑）。
      toolGuidance: cleanString(raw.toolGuidance, ''),
