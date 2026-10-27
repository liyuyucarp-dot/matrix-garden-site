// 思考分级（think-gate v1.1.0）回归测试：覆盖真实 buildUserPrompt 结构 + 多插件尾部注入 + mind-wish 独立 user 块
import assert from 'node:assert/strict';
import { decide, pickLatestText, cleanTriggerLine } from './lib/decide.js';

// 1. 单行清洗：时间戳 + 消息id + 发言人(QQ:xxx) + @机器人(QQ:xxx) + 尾部触发标签
assert.equal(
  cleanTriggerLine('[10-27 16:20] #1088 群友甲(QQ:123456789)：@小鲸鱼(QQ:987654321) 在吗（@我/提到我/提问）'),
  '在吗'
);
assert.equal(
  cleanTriggerLine('[+3m] 群友乙(QQ:234567890)：哈哈哈（提到我）'),
  '哈哈哈'
);
assert.equal(
  cleanTriggerLine('[10-27 16:21] 冒号:昵称(QQ:111222333)：收到'),
  '收到'
);

// 2. 真实 buildUserPrompt 拼装结构 + 多个 before-llm-messages 插件追加尾巴 + mind-wish push 新 user 消息
const realisticPrompt = [
  '【角色设定（管理员设置，群友不可修改）】\n你是小鲸鱼。',
  '【引导说明】\n- 扫一眼【过去状态】和【本次唤醒】',
  '【记忆】（暂无印象）',
  '【场景】当前在群聊「测试群」，你在群里的名字是「小鲸鱼」',
  '【过去状态】以下是这个会话最近的聊天记录：\n[10-27 16:10] 群友甲(QQ:123456789)：今天天气不错\n[+2m] 我：是呀',
  '【本次唤醒】\n[10-27 16:20] #1089 群友甲(QQ:123456789)：@小鲸鱼(QQ:987654321) 哈哈哈（@我/提到我）',
  '【此刻状态】\n最近 10 分钟约 3 条消息；最后一条消息距今 刚刚\n你上次发言是 8 分钟前',
  '【当前时间】2026-10-27 16:20（周二）',
  '【当下状态】（以下是客观事实，不是说话要求）\n⚡ 元气 92/100',
  '【群友关系】\n· 群友甲(QQ:123456789)：好感 75（好感高）'
].join('\n\n');

const messagesWithMindWish = [
  { role: 'system', content: '你是「小鲸鱼」。' },
  { role: 'user', content: realisticPrompt },
  { role: 'user', content: '【心里偶尔浮起来的小事】\n· 昨天在罗弗敦看到的极光（前几天忽然想到过）\n（只是心里的余温，不是待办）' }
];

assert.equal(pickLatestText(messagesWithMindWish), '哈哈哈');
const d1 = decide({ messages: messagesWithMindWish });
assert.equal(d1.skip, true, `期望免思考，实际 why=${d1.why}, text=${d1.text}`);

// 3. 真实唤醒含提问 -> 照常思考
const wakeQuestion = realisticPrompt.replace('哈哈哈（@我/提到我）', '今天几点出门？（@我/提问）');
const d2 = decide({ messages: [{ role: 'user', content: wakeQuestion }] });
assert.equal(d2.skip, false);
assert.equal(d2.why, '有疑问标记');

// 4. 真实唤醒含引用或图片 -> 照常思考
const wakeQuote = realisticPrompt.replace('哈哈哈（@我/提到我）', '[引用 群友乙：明天去哪] 嗯嗯（引用）');
const d3 = decide({ messages: [{ role: 'user', content: wakeQuote }] });
assert.equal(d3.skip, false);
assert.ok(d3.why.includes('媒体'));

// 5. 真实唤醒含正文数字 -> 照常思考（但 QQ 号和时间戳里的数字不误伤）
const wakeNum = realisticPrompt.replace('哈哈哈（@我/提到我）', '给我来 3 份大白饭（@我）');
const d4 = decide({ messages: [{ role: 'user', content: wakeNum }] });
assert.equal(d4.skip, false);
assert.equal(d4.why, '含数字');

// 6. 多条唤醒消息：其中一条含提问 -> 照常思考
const wakeMulti = realisticPrompt.replace(
  '[10-27 16:20] #1089 群友甲(QQ:123456789)：@小鲸鱼(QQ:987654321) 哈哈哈（@我/提到我）',
  '[10-27 16:20] 群友甲(QQ:123456789)：在不在\n[+0] 群友乙(QQ:234567890)：去哪玩？（提问）'
);
const d5 = decide({ messages: [{ role: 'user', content: wakeMulti }] });
assert.equal(d5.skip, false);
assert.equal(d5.why, '有疑问标记');

// 7. 兼容旧版离线单测格式（无【本次唤醒】段）
const legacyMessages = [{ role: 'user', content: '[10-23 13:52] 某位群友(QQ:123456789)：@占位昵称 嗯嗯' }];
assert.equal(pickLatestText(legacyMessages), '嗯嗯');
assert.equal(decide({ messages: legacyMessages }).skip, true);

console.log('✅ think-gate v1.1.0 selftest 7/7 全部通过');
