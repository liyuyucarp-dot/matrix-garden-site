/**
 * selftest.mjs —— silence-ping v1.6.0 主宾锁死与防复读离线自测
 * 运行方式：node plugins/silence-ping/selftest.mjs
 */
import assert from 'node:assert/strict';
import {
  cleanMessageForPrompt,
  groupRecentTurns,
  buildSpeakerLedger,
  checkEchoGuard,
  buildSystemRolePrompt,
  internals
} from './index.js';

console.log('── silence-ping v1.6.0 selftest 开始 ──');

// 1. 测试引用头剥离与转译（根治「被引用原话截断喧宾夺主」）
{
  const rawWithLongQuote = '[引用 小鲸鱼(QQ:3410)：我今天刚去罗弗敦群岛看了极光，还买了一大袋超咸的鳕鱼干回来准备分给大家吃] 真的吗，太羡慕你了，我今天在公司加班累死了';
  const cleaned = cleanMessageForPrompt(rawWithLongQuote, 80);
  assert.ok(cleaned.startsWith('（回应「我今天刚去罗弗敦群岛看了极光，还买了…」）'), `应保留简短回应头，实际：${cleaned}`);
  assert.ok(cleaned.includes('我今天在公司加班累死了'), '应完整保留说话人自己的真实正文，不被长引用挤掉');
  assert.ok(!cleaned.includes('[引用'), '不应残留原始 [引用] 标记');
}

// 2. 测试相邻同向短句归并 + 双向箭头强锚定
{
  const now = Date.now();
  const recent = [
    { self: false, senderName: '橙色小书虫', ts: now - 3600_000, text: '在吗' },
    { self: false, senderName: '橙色小书虫', ts: now - 3550_000, text: '我今天加班好累' },
    { self: true, senderName: '我', ts: now - 3500_000, text: '摸摸头，我在庭院喂鱼呢，你几点下班？' }
  ];
  const turns = groupRecentTurns(recent, { botName: '小鲸鱼', peerName: '橙色小书虫', now });
  assert.equal(turns.length, 2, '前两条对方连续发送的短句应归并为 1 轮');
  assert.ok(turns[0].line.includes('【对方(橙色小书虫) → 对你说】：「在吗」 ／ 「我今天加班好累」'));
  assert.ok(turns[1].line.includes('【你(小鲸鱼) → 对橙色小书虫说】：「摸摸头，我在庭院喂鱼呢，你几点下班？」'));
}

// 3. 测试《双方最后表态对账单》（Speaker Grounding Ledger）
{
  const now = Date.now();
  const pick = {
    recent: [
      { self: false, senderName: '橙色小书虫', ts: now - 7200_000, text: '我今天在公司加班写材料累死了' },
      { self: true, senderName: '我', ts: now - 7100_000, text: '我在庭院喂鱼呢，你几点能忙完？' }
    ],
    last: { self: true, senderName: '我', ts: now - 7100_000, text: '我在庭院喂鱼呢，你几点能忙完？' },
    lastIncoming: { self: false, senderName: '橙色小书虫', ts: now - 7200_000, text: '我今天在公司加班写材料累死了' },
    f: { lastProactiveAt: 0, lastMsgAt: 0, replied: false }
  };
  const ledger = buildSpeakerLedger(pick, { botName: '小鲸鱼', peerName: '橙色小书虫', now });
  assert.ok(ledger.includes('1. 👤 对方（橙色小书虫）最后对你说的话'));
  assert.ok(ledger.includes('归属锁死：这是【橙色小书虫】说的'));
  assert.ok(ledger.includes('2. 🤖 你自己（小鲸鱼）最后对橙色小书虫说的话'));
  assert.ok(ledger.includes('3. ⏸️ 当前停顿位置：整个对话停在 1 小时前，最后一句是【你自己】说的'));
}

// 4. 测试 JSON 微推理顺序解析（lastState → mind → say）与旧格式兼容
{
  const d1 = internals.parseDecision('{"lastState":"对方说加班累，我问他几点忙完","mind":"他还没下班，发句关心","say":"忙完早点回去歇着呀","saidWish":1}');
  assert.equal(d1.send, true);
  assert.equal(d1.message, '忙完早点回去歇着呀');
  assert.equal(d1.lastState, '对方说加班累，我问他几点忙完');
  assert.equal(d1.wishIdx, 1);

  const d2 = internals.parseDecision('{"lastState":"我刚问过他，他还没回","mind":"别催他了","say":null}');
  assert.equal(d2.send, false);
  assert.equal(d2.message, '');
}

// 5. 测试本地 2-gram 防复读 / 防鹦鹉学舌硬闸
{
  const pick = {
    recent: [
      { self: false, text: '我今天在公司加班写材料累死了' },
      { self: true, text: '我在庭院喂鱼呢，你几点能忙完？' }
    ],
    f: { lastProactiveText: '今晚吃什么夜宵呀' }
  };
  // 复读自己刚问过的话
  const e1 = checkEchoGuard('我在庭院喂鱼呢，你几点忙完呀？', pick);
  assert.equal(e1.echoed, true, '应拦截复读自己上一句');

  // 鹦鹉学舌把对方的话当成自己的说出来
  const e2 = checkEchoGuard('我今天在公司加班写材料累死啦', pick);
  assert.equal(e2.echoed, true, '应拦截把对方原话复读出来');

  // 正常新话头放行
  const e3 = checkEchoGuard('忙完早点回家歇着，我给你留了鳕鱼干', pick);
  assert.equal(e3.echoed, false, '正常新话头应放行');
}

// 6. 测试 buildPrompt 与 buildSystemRolePrompt 整体输出无乱码且含关键段落
{
  const now = Date.now();
  const pick = {
    recent: [
      { self: false, senderName: '测试好友', ts: now - 3600_000, text: '刚才去买了杯冰美式' }
    ],
    last: { self: false, senderName: '测试好友', ts: now - 3600_000, text: '刚才去买了杯冰美式' },
    lastIncoming: { self: false, senderName: '测试好友', ts: now - 3600_000, text: '刚才去买了杯冰美式' },
    f: { lastProactiveAt: 0, lastMsgAt: 0 }
  };
  const sys = buildSystemRolePrompt('private:10001', { personaMaxChars: 500 });
  const usr = internals.buildPrompt(pick, 'private:10001', { personaMaxChars: 500 }, now, [], '你正在【罗弗敦】旅行');
  assert.ok(sys.includes('【核心视角铁律（最高优先级）】'));
  assert.ok(usr.includes('【双方最后表态对账单（发言前必核，严禁把两边经历或话语调换）】'));
  assert.ok(usr.includes('"lastState"'));
}

console.log('✅ silence-ping v1.6.0 selftest 全部通过（6/6）');
process.exit(0);
