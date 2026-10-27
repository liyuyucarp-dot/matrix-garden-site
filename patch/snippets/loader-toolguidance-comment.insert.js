  //
  // ⚠️ 2026-10-25（v2.2.3）：技能可以把"引导写在别处"显式声明出来 ——
  //    manifest.toolGuidance（典型值 'hooks'：像 skills/kp 那样在 before-llm-messages
  //    里按群注入策略段）。声明了就跳过这条提示；**没声明的仍然提示** —— sticker 那类
  //    真的一个字引导都没有的，正是当初加这条要抓的对象，不能一并放过。
  //    （发现背景：kp 的提示词全靠 hooks['before-llm-messages'] 的 7 段 stableParts，
  //      而本函数虽然拿到了 hooks 参数、却只用它算 provides，于是永远误报。）
