// 好感度内核（确定性型 / plugins/）
//
// ── 为什么做成插件而不是纯技能 ────────────────────────────────────────────
// 这套东西的价值不在「模型能记一笔」，而在**每轮都会发生的确定性动作**：
//   · 记一条判断 → 攒进待确认台账 → 攒够门槛自动结算 → 写审计（不需要模型同意）
//   · 每轮把「它现在怎么看这个人」注入提示词（模型想忽略也忽略不掉）
//   · 回合结束后自己判断「值不值得花一次调用做兜底判定」
// 模型主动记账（favor_core__memory_impression / __memory_favor）是另一型：
// 那两个工具进模型的 function 列表，用不用由模型决定 —— 所以两条路都留着，
// 因为它们**互相兜底**（实测 58 次真实运行里模型一次都没顺手记，兜底判定才是主力）。
//
// ── 与核心的关系（零侵入）────────────────────────────────────────────────
// 全部通过 hooks 挂载，没有改一行核心代码：
//   before-context       钩子载荷里有 triggerEntries + store（本轮参与者与消息窗口）
//   before-llm-messages  钩子允许原地改 messages → 注入好感段
//   after-response       回合结束点 → 跑兜底判定（**不 await**：hook 有 5 秒超时，
//                        而判定要调模型，必须后台跑）
//
// ⚠️ 为什么动态注入要用两个钩子：`before-llm-messages` 有 messages 但**没有**
//    triggerEntries/store，拿不到「本轮谁在说话」；`before-context` 反过来。
//    所以前者收集、后者消费（与 plugins/conversation-memory 同一套做法）。
import { chatCompletion } from '../../src/llm.js';
import { getConfig } from '../../src/config.js';
import { getTool, listTools } from '../../src/tool-registry.js';
import {
  buildFavorInject, favorLedger, favorStates, getFavorStatus, recordImpression,
  setFavor, setPending, settleFavor
} from './lib/ledger.js';
import { judgeConfig, maybeFavorJudge } from './lib/judge.js';
import { favorRules, isQqNumber } from './lib/rules.js';

/** 本插件注册的工具 id（注册后会被加载器加上 `favor_core__` 前缀（skillId 里的 - 被 sanitize 成 _））。 */
export const TOOL_IDS = ['favor-core__memory_impression', 'favor-core__memory_favor'];

let api = null;
/** 本轮上下文暂存：sessionId|chatKey → { chatKey, recent, participants, liveNames, runSeq } */
const roundCache = new Map();
/** 每个会话的运行序号（before-context 每次 +1，供 judge.everyN 使用）。 */
const runCounters = new Map();
/** 已经为哪一轮跑过判定（after-response 一个回合里会来多次） */
const judgedRounds = new Set();

/** 当前设置（plugin.json 的 settings 是默认值，用户在设置页改过的覆盖它）。 */
function settings() {
  try {
    return (api && typeof api.config === 'function' ? api.config() : null) || {};
  } catch {
    return {};
  }
}

function log(...args) {
  if (api?.log) api.log(...args);
  else console.log('[favor-core]', ...args);
}

function warn(...args) {
  if (api?.warn) api.warn(...args);
  else console.warn('[favor-core]', ...args);
}

/** 机器人在群里的名字（用于「冲它说话」的名字线索与判定提示词里的「我」）。 */
function selfNames() {
  try {
    const p = getConfig()?.persona || {};
    return [p.selfNickname, p.botName].map((x) => String(x || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// 工具：好感度唯一的入口与出口
// ══════════════════════════════════════════════════════════════════════

const err = (content) => ({ content: `错误：${content}`, isError: true });
const ok = (obj) => ({ content: JSON.stringify(obj, null, 1) });

export function setup(a) {
  api = a;

  // ── 工具 1：memory_impression —— 好感度**唯一**的加减入口 ──────────────
  api.registerTool({
    id: 'favor-core__memory_impression',
    name: '记一条判断',
    description: '记一条「对某人的判断/印象」，并带上你这次的感觉：positive（他对我好：被夸/被帮/被维护/有意思）、'
      + 'negative（他烦我：被怼/被阴阳/被反复嘲/被拿来出气）、neutral（只是记个事实，不加不减）。'
      + '这是**好感度唯一的加减入口**：每记一条后台就攒一条，攒够若干条（通常 3 条）会自动按整体净感觉加分或减分，单次幅度很小。'
      + '所以别乱记：一时情绪、玩笑互损、你俩本来就互怼着玩，都不算；要记就记真的让你改观的事。只查不改时用 favor-core__memory_favor。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先；可带负号会自动转正）' },
        target: { type: 'string', description: '对方短名字（没有 userId 时用；≤24字）' },
        content: { type: 'string', description: '你记住的这件事，≤40字。例如：一直叫我小笨蛋，笑得很开心 / 主动帮我解释刚才那句不是那个意思' },
        sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'], description: '这条让你对他印象变好(+)/变差(−)/没变化。不填则按原文字面粗判' }
      },
      required: ['content']
    },
    async execute(ctx, args = {}) {
      try {
        let userId = String(args.userId ?? '').trim();
        if (/^-?\d{5,15}$/.test(userId)) userId = String(Math.abs(Number(userId)));
        if (userId && !isQqNumber(userId)) userId = '';
        // ⚠️ target 先**判长度再截断**：先截断会让「≤24字」那条守卫永远不触发，
        //    于是整句「今天吃什么？明天…」被悄悄截成 24 字当成一个人的名字存进档案。
        const targetRaw = String(args.target ?? '').trim();
        if (!userId && targetRaw.length > 24) {
          return err('target 只能是短名字（≤24字），不要把整句印象写进 target。请优先填 userId（对方 QQ 号）。');
        }
        const target = targetRaw.slice(0, 24);
        if (!userId && !target) {
          return err('需要 userId（对方 QQ 号，优先）或 target（短名字）。示例：{"userId":123456789,"content":"一直叫我小笨蛋","sentiment":"negative"}');
        }
        const r = recordImpression({
          chatKey: String(ctx?.chatKey || ''),
          userId,
          target,
          content: String(args.content ?? '').trim(),
          sentiment: args.sentiment ?? null,
          settings: settings()
        });
        const st = r.status;
        const out = {
          saved: !r.duplicate,
          sentiment: r.entry?.sentiment,
          content: r.entry?.content,
          pending: `${st.pendingCount}/${st.need}`,
          // 带「好感」二字：模型复述这个数字时口径要与【好感】段一致
          favor: `好感${st.favor}/100`,
          attitude: st.band
        };
        if (r.duplicate) {
          out.alreadyCounted = r.note || '这条判断之前已经算过一次（已结算），不重复计入。';
        } else if (r.verdict) {
          const v = r.verdict;
          out.verdict = v.applied
            ? `攒够 ${v.count} 条判断，好感 ${v.from} → ${v.to}（${v.delta > 0 ? '+' : ''}${v.delta}）：${v.reason}`
            : `这次不结算：${v.reason}`;
        } else {
          out.waiting = `还差 ${Math.max(0, st.need - st.pendingCount)} 条判断才能确认加分还是减分，先记着。`;
        }
        return ok(out);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 工具 2：memory_favor —— 只查不改；手动微调必须带理由 ────────────────
  api.registerTool({
    id: 'favor-core__memory_favor',
    name: '查看与微调好感',
    description: '查看对某人的好感度与「攒了几条判断」。'
      + '**好感分不能随手改**：它由 favor-core__memory_impression 的判断累积出来，攒够门槛会自动结算；'
      + '所以这个工具默认只查。仅在确实有必要时（例如该结算却卡住了）才可以传 delta 强制微调，且**必须给 reason**，会在后台留下记录。'
      + '不传 userId 时列出所有人的好感与待确认条数。',
    category: 'memory',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '对方 QQ 号；不传 = 列出所有人的好感状态' },
        delta: { type: 'integer', description: '强制微调 -3~3（一般不要用；必须同时给 reason，会被记进审计）。不传=只看' },
        reason: { type: 'string', description: '理由，≤30字（强制微调时必填，后台要能查到为什么改这一刀）' }
      }
    },
    async execute(ctx, args = {}) {
      try {
        const raw = String(args.userId ?? '').trim();
        const hasDelta = args.delta !== undefined && args.delta !== null && args.delta !== '';
        // ── 不给 userId：列出所有人的好感状态 ──
        if (!raw) {
          if (hasDelta) return err('要改就得说清是改谁，请给 userId（对方 QQ 号）');
          const list = favorStates(settings()).map((s) => ({
            userId: s.userId,
            name: s.name,
            favor: `${s.favor}/100`,
            attitude: s.band,
            pending: `${s.pendingCount}/${s.need}`,
            cycles: s.cycles
          }));
          return ok({ count: list.length, people: list.slice(0, 30) });
        }
        let uid = raw.replace(/^-/, '');
        if (/^-?\d{5,15}$/.test(raw)) uid = String(Math.abs(Number(raw)));
        if (!isQqNumber(uid)) return err('userId 必须是对方 QQ 号');

        const st = getFavorStatus(uid, settings()) || {};
        if (!hasDelta) {
          const ledger = favorLedger(uid, { limit: 6 }).map((e) => ({
            content: e.content,
            sentiment: e.sentiment,
            pending: e.pending || undefined
          }));
          return ok({
            userId: uid,
            name: st.name || '',
            favor: `${st.favor}/100`,
            attitude: st.band,
            pendingJudgments: `${st.pendingCount}/${st.need}`,
            confirmedCycles: st.cycles,
            lastChange: st.lastChange ? `${st.lastChange.delta > 0 ? '+' : ''}${st.lastChange.delta}｜${st.lastChange.reason}` : null,
            recentJudgments: ledger,
            hint: st.pendingCount >= st.need
              ? '已经够门槛了，结算会在下一次记录判断时自动发生。'
              : `还差 ${Math.max(0, st.need - st.pendingCount)} 条判断。`
          });
        }

        // ── 强制微调：门槛还在，只是允许模型自己下这一刀（后台留痕） ──
        const reason = String(args.reason ?? '').trim().slice(0, 30);
        if (!reason) return err('强制微调必须给 reason（≤30字），后台要能查到为什么改这一刀。');
        let d = Math.round(Number(args.delta));
        if (!Number.isFinite(d) || d === 0) return err('delta 必须是 -3~3 的非零整数');
        d = Math.max(-3, Math.min(3, d));
        const before = Number(st.favor ?? 50);
        const r = setFavor(uid, before + d, { source: 'favor_tool_override', reason, settings: settings() });
        return ok({
          userId: uid,
          from: before,
          favor: `${r.favor}/100`,
          delta: r.favor - before,
          reason,
          note: '已按你的判断强制微调（后台有记录）。好感度正常是靠 favor-core__memory_impression 攒出来的，别频繁走这条。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  log(`好感度内核已注册工具：${TOOL_IDS.map((t) => `favor_core__${t}`).join('、')}`);
}

/** 生效：只清一遍进程内缓存（没有定时器/监听器要起）。 */
export function activate() {
  roundCache.clear();
  judgedRounds.clear();
}

/** 关闭：清缓存。已在磁盘上的账本不动。 */
export function deactivate() {
  roundCache.clear();
  judgedRounds.clear();
}

/** 卸载：清缓存。 */
export function dispose() {
  roundCache.clear();
  judgedRounds.clear();
}

// ══════════════════════════════════════════════════════════════════════
// 钩子
// ══════════════════════════════════════════════════════════════════════

/** 本轮上下文暂存的键：会话 id 优先（同一会话可能有多次运行）。 */
function cacheKey(ctx = {}) {
  return String(ctx.sessionId || ctx.chatKey || '');
}

function peekContext(ctx = {}) {
  const info = roundCache.get(cacheKey(ctx)) || null;
  if (info) return info;
  // 兜底：如果 before-context 没跑到（例如别的入口直接调 hook），至少按会话取一次消息窗口
  const chatKey = String(ctx.chatKey || '');
  if (!chatKey || !ctx.store?.recent) return null;
  return { chatKey, recent: safeRecent(ctx.store, chatKey), participants: [], liveNames: new Map(), runSeq: 0 };
}

function safeRecent(store, chatKey, limit = 40) {
  try {
    const rows = store.recent(chatKey, { limit }) || [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export const hooks = {
  /**
   * 收集本轮参与者与消息窗口。
   *
   * 为什么在这里：`before-context` 是唯一能同时拿到 `triggerEntries`（本轮唤醒的消息）
   * 和 `store`（历史消息）的钩子点；`before-llm-messages` 拿不到它们。
   */
  async 'before-context'(ctx = {}) {
    try {
      const chatKey = String(ctx.chatKey || '');
      if (!chatKey) return;
      const key = cacheKey(ctx);
      // 防泄漏：键是 sessionId，而 orchestrator 每轮都新造 sessionId → 条目只增不删。
      // 每轮顺手清掉 30 分钟前的残留（一次运行远短于此，消费方不受影响）。
      const staleBefore = Date.now() - 30 * 60 * 1000;
      for (const [k, v] of roundCache) {
        if (!v || Number(v.at) < staleBefore) roundCache.delete(k);
      }
      const seq = (runCounters.get(chatKey) || 0) + 1;
      runCounters.set(chatKey, seq);
      const recent = safeRecent(ctx.store, chatKey, 40);
      const participants = [];
      const liveNames = new Map();
      const consider = (m) => {
        if (!m || m.self) return;
        const id = String(m.senderId || '').trim();
        if (!isQqNumber(id)) return;
        if (!liveNames.has(id)) liveNames.set(id, String(m.senderName || ''));
        if (!participants.includes(id)) participants.push(id);
      };
      // 本轮触发的人排在前面（他们是「这轮真的在跟它说话」的人）
      for (const m of (Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [])) consider(m);
      for (const m of recent.slice(-20)) consider(m);
      roundCache.set(key, { chatKey, recent, participants, liveNames, runSeq: seq, at: Date.now() });
    } catch (error) {
      warn('收集本轮上下文失败：', error?.message ?? error);
    }
  },

  /**
   * 注入「它现在怎么看这个人」。
   *
   * ⚠️ 追加到**最后一条 user 消息**末尾，而不是塞进 system：这段每轮都在变
   *    （待确认条数一变就不同），插到系统提示中间会把后面几千 token 的前缀缓存
   *    全部推位（src/prompt.js:218-221 明确警告过）。静态判断基准走 plugin.json
   *    的 prompt.sections，那里可以安全缓存。
   */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    const messages = Array.isArray(ctx.messages) ? ctx.messages : null;
    if (!messages || !messages.length) return;
    try {
      const info = peekContext(ctx);
      if (!info) return;
      // 只注入「本轮真的在场的人」。没有参与者就什么都不注入 ——
      // 传 null/undefined 给 buildFavorInject 的语义是「不限人」（给管理端调试用），
      // 在每轮注入这条路径上那等于把整个群的档案都塞进提示词。
      if (!info.participants.length) return;
      const inject = buildFavorInject({
        chatKey: info.chatKey,
        userIds: info.participants,
        liveNames: info.liveNames,
        notes: memberNotes(),
        settings: s
      });
      if (!inject) return;
      appendToLastUser(messages, inject);
    } catch (error) {
      warn('好感注入失败：', error?.message ?? error);
    }
  },

  /**
   * 回合结束点 → 兜底判定。
   *
   * ⚠️ **绝不能 await**：hook 有 5 秒硬超时（skills/manager.js:22），
   *    而判定要调一次模型（默认 45 秒超时）。await 的后果是「判定永远被超时跳过」，
   *    而且超时会被记成 Skill 错误。
   */
  async 'after-response'(ctx = {}) {
    try {
      const cfg = judgeConfig(settings());
      if (!cfg.enabled || cfg.minSignal === 'never') return;
      const info = peekContext(ctx);
      if (!info) return;
      const roundId = `${info.chatKey}#${info.runSeq}`;
      if (judgedRounds.has(roundId)) return;      // 一个回合会来好几次 after-response
      judgedRounds.add(roundId);
      if (judgedRounds.size > 200) {
        // 简单的容量护栏：只留最近的一批（进程内去重表，丢了最坏是多重判一次）
        for (const k of [...judgedRounds].slice(0, judgedRounds.size - 100)) judgedRounds.delete(k);
      }
      const names = selfNames();
      void maybeFavorJudge({
        chatKey: info.chatKey,
        recent: info.recent,
        triggerEntries: [],
        selfId: '',
        selfName: names[0] || '我',
        runSeq: info.runSeq,
        settings: settings(),
        chat: (messages, opts) => chatCompletion({
          messages,
          temperature: 0.1,
          maxTokens: Number(opts?.maxTokens) || cfg.maxTokens
        }),
        record: (args) => recordImpression({ ...args, settings: settings() })
      }).catch((error) => warn('兜底判定异常：', error?.message ?? error));
    } catch (error) {
      warn('兜底判定调度失败：', error?.message ?? error);
    }
  }
};

/** 把一段文字并到最后一条 user 消息（没有 user 消息就退回 system）。 */
export function appendToLastUser(messages, text) {
  const t = String(text || '').trim();
  if (!t) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      m.content = `${m.content}\n\n${t}`;
      return messages;
    }
    if (Array.isArray(m.content)) {
      m.content.push({ type: 'text', text: `\n\n${t}` });
      return messages;
    }
  }
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') {
    sys.content = `${sys.content}\n\n${t}`;
    return messages;
  }
  messages.push({ role: 'user', content: t });
  return messages;
}

/** 管理页备注（memberNotes）：显示名优先用备注，其次本群实时群名片。 */
function memberNotes() {
  try {
    return getConfig()?.memberNotes || {};
  } catch {
    return {};
  }
}

/**
 * 排障用：当前已注册的工具 id 与它们的归属（给测试/控制台脚本断言用）。
 * 返回的是**实际注册 id**（带 `favor_core__` 前缀），因为那才是发给模型的名字。
 */
export function registeredToolIds() {
  return listTools()
    .filter((t) => t.skillId === 'favor-core')
    .map((t) => t.id);
}

/** 排障用：确认核心加载器真的把工具挂上了（未加载时返回 false）。 */
export function isToolRegistered(id) {
  const t = getTool(String(id));
  return Boolean(t && t.skillId === 'favor-core');
}

/** 排障用：本插件当前的规则/判定配置快照。 */
export function configSnapshot() {
  return { rules: favorRules(settings()), judge: judgeConfig(settings()), tools: registeredToolIds() };
}

// ══════════════════════════════════════════════════════════════════════
// 能力：给核心 / 控制台调用的口子（2026-09-20 主 agent 接线时补）
// ══════════════════════════════════════════════════════════════════════
// 为什么用能力而不是让核心 import 本插件的文件：
//   1. `src/` 至今**不依赖** `plugins/`，这条边界保住了"插件关掉 = 功能真的关掉"；
//   2. 核心按能力名找提供者，换实现不用改核心（本项目一贯约定）。
// 消费方：`src/routes.js` 的 `/api/memory-people*`（控制台「群友」页）。
// 取不到提供者时，路由退回核心数据层（`src/memory-people.js`）的只读视图 +
// 直接改分（那条路径也写审计），所以插件关掉时这一页依然可用、只是少了结算。
export const providers = {
  /** 全部人的好感状态（控制台列表用，含档位等派生字段）。 */
  'memory.favor.states': () => favorStates(settings()),
  /** 单人的好感状态（档位 / 待确认 / 上次结算）。 */
  'memory.favor.status': (args = {}) => getFavorStatus(String(args.userId || ''), settings()),
  /** 判断台账（尾部 N 条）。 */
  'memory.favor.ledger': (args = {}) => favorLedger(String(args.userId || ''), { limit: Number(args.limit) || 20 }),
  /** 手动结算：把攒着的判断按门槛结掉（净 0 也推进一次确认）。 */
  'memory.favor.settle': (args = {}) => settleFavor(String(args.userId || ''), {
    force: args.force !== false,
    reason: String(args.reason || '手动结算'),
    settings: settings()
  }),
  /** 手动改分：**必须带 reason**（会写审计 + manuallyEditedAt）。 */
  'memory.favor.set': (args = {}) => setFavor(String(args.userId || ''), Number(args.favor), {
    source: 'manual',
    reason: String(args.reason || ''),
    settings: settings()
  }),
  /** 手动补/清待确认条数（补的是中性占位，**不会凭空加分**）。 */
  'memory.favor.pending': (args = {}) => setPending(String(args.userId || ''), {
    set: args.set === undefined ? null : Number(args.set),
    add: Number(args.add) || 0,
    clear: args.clear === true,
    note: String(args.note || '手动调整'),
    settings: settings()
  })
};
