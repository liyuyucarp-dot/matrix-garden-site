// 审计出口（等价老 `src/memory-audit.js` 的写入口）。
//
// 为什么要多这一层而不是直接 import 核心的 logMemoryChange：
//   1. **类型词表**要在一处写清楚 —— 好感度系统只写这几种行，UI 的
//      auditTypeLabel() 靠类型 + source 给人话（老 UI app.js:6515-6529）。
//      散在三个文件里各写各的字符串，改名时必然漏。
//   2. 失败的兜底语义要显式：审计是**旁路**，写不进去绝不能影响记账主流程
//      （核心的 logMemoryChange 已经 try/catch，这里再兜一层是为了防"未来某次
//      改动把 try 去掉"）。
//
// ⚠️ 注意不要重复记：recordImpression 里已经写了一条 impression 行（含 pending/cycle），
//    调用方（兜底判定）**不要**再写一遍 —— 老实现在这里踩过，同一条判断出现过两行。
import { logMemoryChange } from '../../../src/memory-audit.js';

/**
 * 好感度系统会写的审计类型。
 *
 *   impression     记了一条判断（source: impression=模型顺手记 / judge=兜底判定）
 *   favor          好感分变了（source: impression_ledger=自动结算 / manual_verdict=手动结算
 *                  / manual_ui=管理页改 / favor_tool_override=模型强制微调）
 *   pending        待确认台账被手动改（条数/清空）
 *   judge_clean    判定跑了但没有任何人需要记账（全是 neutral）—— 也要留痕
 *   judge_error    判定失败（网络/解析），只留痕不影响聊天
 */
export const AUDIT_TYPES = ['impression', 'favor', 'pending', 'judge_clean', 'judge_error'];

/**
 * 追加一行审计。
 * @param {{type:string}} entry 至少要有 type；其余字段按事件自定
 * @returns {object|null} 写入的行；写失败返回 null
 */
export function audit(entry) {
  try {
    const type = String(entry?.type || '').trim();
    if (!type) return null;
    return logMemoryChange({ ...entry, type });
  } catch {
    return null;
  }
}

export { logMemoryChange };
