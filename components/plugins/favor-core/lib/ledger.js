// 好感度账本内核：记账（判断）→ 攒（待确认台账）→ 结算（好感分）。
//
// 语义逐条对齐老实现 `_legacy-features-backup-20260920/legacy-src-20260917/memory.js`：
//   recordImpression  memory.js:557-728   （三道防刷闸 + 印象归档 + 台账累加 + 自动结算 + 审计）
//   #verdict          memory.js:744-815   （门槛 / 冷静期 / 净分 clamp / 整批打 cycle 号）
//   #verdictReason    memory.js:818-824
//   #commitPerson     memory.js:827-844   （ledger 裁剪：台账里的条目永不裁掉）
//   settleFavor       memory.js:850-863
//   setPending        memory.js:876-942   （手动改条数 = 补中性占位，绝不凭空加分）
//   favorLedger       memory.js:945-955
//   setFavor          memory.js:1177-1205
//   #findRecentPeerEntry memory.js:1507-1522（跟风复读闸）
//   formatForPrompt   memory.js:1579-1659 （注入段，见本文件 buildFavorInject）
//
// ⚠️ 存储层用的是**本仓已实现的数据层** src/memory-people.js（不要重写它）：
//    `data/memory/people/<档案键>.json`，字段形状与真实老档案逐一对齐，
//    且「不认识的字段一律原样保留」—— 正好接住老实现会静默抹掉的 intensity/hits/lastAt。
import {
  blankPerson, clampFavor, ensurePerson, listPeople, readPerson, writePerson
} from '../../../src/memory-people.js';
import { audit } from './audit.js';
import {
  FAVOR_RULE_DEFAULTS, LEDGER_CONTENT_MAX, favorBand, favorCapOf, favorRules, favorStatusOf, inferSentiment,
  isQqNumber, ledgerId, nameOnlyKey, normalizeLedgerEntry, normalizePending, normalizeSentiment,
  readSetting, resolvePersonKey, sentimentScore, trimImpressions
} from './rules.js';

/**
 * 按码点安全截断（与 judge.js 的同名工具等价）。裸 `.slice(0,n)` 会把 emoji/代理对
 * 劈成孤立代理项，该段每轮进 user/system 消息 → JSON.stringify 产出 \udXXX → 服务端 400
 * （历史上"连着 6 次判定失败"就是这个）。存储与注入两处都必须走这里。
 */
function safeTruncate(text, max = 80, suffix = '') {
  const s = String(text ?? '');
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, max).join('') + suffix;
}

/** 读一份档案并把它里面的 ledger 归一化（老档案/手改过的文件都能安全计算）。 */
function readForWrite(key) {
  const person = readPerson(key);
  return person || blankPerson(key);
}

function ledgerOf(person) {
  return (Array.isArray(person?.ledger) ? person.ledger : [])
    .map(normalizeLedgerEntry)
    .filter(Boolean);
}

/**
 * 跟风复读闸：找「别人刚刚记过的同一条判断」。
 *
 * 只看**尚未结算**的条目（已结算的历史不该拦后来的新对话），且只看同一个会话
 * （两个群互相看不见对方在说什么，跨群不算跟风）。全库扫描 —— 档案量级是几十个人，
 * 单次运行只调一两次，开销可忽略。
 */
function findRecentPeerEntry(selfKey, text, now, windowMs, chatKey = '') {
  if (!windowMs) return null;
  let best = null;
  for (const m of listPeople()) {
    const key = String(m.userId || '');
    if (!key || key === selfKey) continue;
    for (const e of ledgerOf(m)) {
      if (e.counted === true) continue;                       // 已结算：不参与
      if (String(e.content) !== text) continue;
      if (chatKey && String(e.chatKey || '') !== String(chatKey)) continue;
      const t = Number(e.at) || 0;
      if (!t || !now || t >= now || now - t > windowMs) continue;
      if (!best || t > best.at) best = { ...e, key, name: String(m.name || key) };
    }
  }
  return best;
}

/**
 * 记一条判断 —— 好感度系统**唯一**的入口。
 *
 * 一次调用做四件事（顺序即老实现的顺序，别调换）：
 *   1. 三道防刷闸：同一批同内容 / 跟风复读 / 24h 内已结算过的同内容；
 *   2. 印象正文进 impressions（按会话隔离，每人每会话 8 条、总量 40）；
 *   3. 一条带情绪的「判断记录」进 ledger，并累加进 pending 台账；
 *   4. 台账条数达到门槛 → 自动结算（净分 clamp 到 [minStep, maxStep]）。
 *
 * @param {object} opts
 * @param {string} opts.chatKey   当前会话（判断发生在哪个群）
 * @param {string} [opts.userId]  对方 QQ 号（优先）
 * @param {string} [opts.target]  只有名字时的短名（会存成 `_n_<名字>.json`）
 * @param {string} opts.content   判断内容（≤80 字）
 * @param {string} [opts.sentiment] positive/neutral/negative；缺省按原文粗判
 * @param {boolean} [opts.autoSettle] 够门槛时是否立即结算
 * @param {string} [opts.source]  记账来源（impression=模型顺手记 / judge=兜底判定）
 * @param {object} [opts.settings] 插件设置（见 plugin.json）
 * @returns {{entry:object, status:object, verdict:object|null, wrote:boolean, duplicate?:boolean, note?:string}}
 */
export function recordImpression({
  chatKey = '', userId = '', target = '', content = '', sentiment = null,
  autoSettle = true, source = 'impression', settings = {}, now = Date.now()
} = {}) {
  const rules = favorRules(settings);
  const key = resolvePersonKey(userId, target);
  const nameRaw = String(target ?? '').trim();
  // 码点安全截断：裸 slice 劈开代理对会把孤立代理项永久存进档案（→ 后续进消息 400）
  const name = safeTruncate(nameRaw, 40);
  const text = safeTruncate(String(content ?? '').trim(), LEDGER_CONTENT_MAX);
  if (!text) throw new Error('印象内容不能为空');
  if (!key) throw new Error('需要 userId（QQ 号）或 target（短名字）');
  // ⚠️ 「短名字」的守卫要在**截断之前**判：先 slice 再判长度会让这条守卫永远不触发，
  //    结果「今天吃什么？明天…」这种整句被悄悄截成 24 字当成一个人的名字存进档案。
  if (!isQqNumber(key) && nameRaw.length > 24) {
    throw new Error('target 只能是短名字（≤24字），不要把整句印象写进 target');
  }
  const impKey = String(chatKey || '').trim();
  const person = readForWrite(key);
  person.userId = String(person.userId || key);
  if (!person.name && name) person.name = name;
  person.ledger = ledgerOf(person);

  const senti = (sentiment === null || sentiment === undefined || sentiment === '')
    ? inferSentiment(text)
    : normalizeSentiment(sentiment);

  // ── 闸 1：同一批（还没结算的台账）里同内容同会话只算一条 ──────────────
  const pendingNow = normalizePending(person.pending, person.ledger);
  const pendingIdSet = new Set(pendingNow.entries);
  const batch = person.ledger.filter((e) => pendingIdSet.has(e.id));
  const batchDup = batch.find((e) => String(e.content) === text
    && String(e.chatKey || '') === impKey);
  if (batchDup) {
    return {
      entry: { ...batchDup },
      status: favorStatusOf(person, rules),
      verdict: null,
      duplicate: true,
      wrote: false,
      note: '这条判断已经记在这批待确认里了（同一批不重复计数），等这批结算。'
    };
  }

  // ── 闸 2：跟风复读（别人刚说过同一句，只算第一个人的）──────────────────
  const follower = findRecentPeerEntry(String(person.userId || key), text, now, rules.copycatWindowMs, impKey);
  if (follower) {
    return {
      entry: { ...follower },
      status: favorStatusOf(person, rules),
      verdict: null,
      duplicate: true,
      wrote: false,
      note: `这句话刚有人（${follower.name || follower.key}）说过，属于跟风复读，不重复计数。`
    };
  }

  // ── 闸 3：自己刚结算过的同内容（默认 24h）—— 防「同一句夸奖刷两轮」──
  const recentSettled = person.ledger
    .filter((e) => e.counted === true && String(e.content) === text
      && now - Number(e.at || 0) < rules.repeatWindowMs)
    .at(-1);
  if (recentSettled) {
    return {
      entry: { ...recentSettled },
      status: favorStatusOf(person, rules),
      verdict: null,
      duplicate: true,
      wrote: false,
      note: '这条判断刚结算过（同一句话不重复计数），换一件真的新事再来记。'
    };
  }

  // ── 印象归档（按会话隔离；同内容只改情绪，不追加）─────────────────────
  if (!Array.isArray(person.impressions)) person.impressions = [];
  const exist = person.impressions.find((e) => String(e.content) === text
    && String(e.chatKey || '') === impKey);
  if (exist) {
    exist.sentiment = senti;
  } else {
    person.impressions.push({ content: text, createdAt: now, sentiment: senti, chatKey: impKey });
    person.impressions = trimImpressions(person.impressions);
  }

  // ── 判断记录 + 台账 ──────────────────────────────────────────────────
  const entry = {
    id: ledgerId(),
    content: text,
    sentiment: senti,
    at: now,
    counted: false,
    cycle: 0,
    chatKey: impKey
  };
  person.ledger.push(entry);
  // 归属会话必须一起维护，否则会把一个**新人**写成「所有会话都可见」
  // （老实现 2026-09-17 线上实测：新人的 chats 为空 → 随即出现在每个群的提示词里）
  if (impKey) person.chats = [...new Set([...(person.chats || []), impKey])].slice(-8);
  const pending = normalizePending(person.pending, person.ledger);
  pending.count += 1;
  pending.score += sentimentScore(senti);
  if (!pending.since) pending.since = now;
  pending.entries.push(entry.id);
  person.pending = pending;
  person.pendingSince = pending.since;

  // ── 门槛：够条数才结算 ───────────────────────────────────────────────
  let verdict = null;
  if (autoSettle && pending.count >= rules.minPending) {
    verdict = applyVerdict(person, rules, { source: 'auto', now });
  }
  commitPerson(person, { ledgerMax: rules.ledgerMax, now });
  // 兜底判定（source='judge'）也走这里记审计 —— 只记一次。
  audit({
    type: 'impression',
    userId: String(person.userId || key || ''),
    name: String(person.name || name || ''),
    sentiment: senti,
    content: safeTruncate(text, 60),
    pending: person.pending?.count ?? 0,
    source,
    cycle: verdict ? person.cycleCount : undefined
  });
  return {
    entry: { ...entry },
    status: favorStatusOf(person, rules),
    verdict,
    wrote: true
  };
}

/**
 * 结算：把台账里攒下的净分变成好感分（**就地修改 person，不写盘**）。
 *
 * 规则（老实现 memory.js:730-776 的注释原文精神）：
 *   · 条数 < minPending → 不动分（除非 force，管理页「立即结算」用）；
 *   · 净分 0（有夸有怼）→ 不动分，但仍算一次确认（cycle 照涨，记一笔「平」进 cycles）；
 *   · 净分 ≠ 0 → delta = clamp(净分, minStep, maxStep)，默认 -3 ~ +2；
 *   · 冷静期（cooldownMs）：同一人两次结算之间必须隔开，防分数坐电梯。
 *
 * @returns {{applied:boolean,delta:number,from:number,to:number,reason:string,sum:number,count:number,cycle:number,skipped?:string}}
 */
export function applyVerdict(person, rules = FAVOR_RULE_DEFAULTS, { source = 'auto', force = false, now = Date.now() } = {}) {
  const pending = normalizePending(person?.pending, person?.ledger || []);
  const from = Number(person?.favor ?? 50);
  const count = pending.count;
  const sum = pending.score;
  const cycleNow = Number(person?.cycleCount) || 0;
  if (!count) {
    return {
      applied: false, delta: 0, from, to: from, sum: 0, count: 0, cycle: cycleNow,
      skipped: 'empty', reason: '台账是空的，没有可结算的判断'
    };
  }
  if (!force && count < rules.minPending) {
    return {
      applied: false, delta: 0, from, to: from, sum, count, cycle: cycleNow,
      skipped: 'below-threshold',
      reason: `判断条数还不够（${count}/${rules.minPending}），继续攒`
    };
  }
  const lastAt = Number(person?.lastVerdictAt) || 0;
  if (!force && rules.cooldownMs > 0 && lastAt && now - lastAt < rules.cooldownMs) {
    return {
      applied: false, delta: 0, from, to: from, sum, count, cycle: cycleNow,
      skipped: 'cooldown',
      reason: `距上次确认还没到冷静期（${Math.ceil((rules.cooldownMs - (now - lastAt)) / 60000)} 分钟），先不结算`
    };
  }

  const delta = sum === 0 ? 0 : Math.max(rules.minStep, Math.min(rules.maxStep, sum));
  // ★ 2026-10-19：非白名单人员封顶（写回时就压住，不给"先涨上去再显示封顶"的错觉）
  const to = Math.min(clampFavor(from + delta), favorCapOf(person.userId, rules));
  const reason = verdictReason({ count, sum, delta, source });
  const cycle = cycleNow + 1;

  // 整批打上 cycle 号 → 这一批以后再也不会被重复结算
  for (const id of pending.entries) {
    const e = person.ledger.find((x) => x.id === id);
    if (e) { e.counted = true; e.cycle = cycle; }
  }
  if (!Array.isArray(person.cycles)) person.cycles = [];
  person.cycles.push({
    at: now, from, to, delta, sum, count, cycle,
    reason: reason.slice(0, 80), source
  });
  if (person.cycles.length > 20) person.cycles = person.cycles.slice(-20);

  person.cycleCount = cycle;
  person.lastVerdictAt = now;
  person.pending = { count: 0, score: 0, since: 0, entries: [] };
  person.pendingSince = 0;
  person.favor = to;
  person.updatedAt = now;
  // 只有真的动了分才更新 lastFavorChangeAt —— 净 0 的确认不算「改过分」
  if (delta !== 0) person.lastFavorChangeAt = now;

  audit({
    type: 'favor',
    userId: String(person.userId || ''),
    name: String(person.name || ''),
    from, to, delta, sum, count, cycle,
    source: source === 'manual' ? 'manual_verdict' : 'impression_ledger',
    reason: reason.slice(0, 80)
  });
  // applied 的口径：**分数真的变了**才算「生效」；净 0 仍然是一次确认（cycle 已 +1）
  return { applied: delta !== 0, delta, from, to, reason, sum, count, cycle };
}

/** 结算理由：给管理页和审计看的一句人话（不是给模型看的）。 */
export function verdictReason({ count, sum, delta, source }) {
  const dir = delta > 0 ? '加分' : delta < 0 ? '减分' : '不动';
  const tail = delta === 0
    ? (sum === 0 && count ? '好坏互相抵消，这次不改分数' : '净印象不足以改分数')
    : `净印象 ${sum > 0 ? '+' : ''}${sum}，单次最多 ${delta > 0 ? '加' : '减'} ${Math.abs(delta)} 分`;
  return `攒够 ${count} 条判断（${source === 'manual' ? '管理员手动结算' : '自动结算'}）→ ${dir}：${tail}`;
}

/**
 * 写盘 + 判断记录上限裁剪。
 *
 * 裁剪顺序很重要：**未结算的台账条目永远保留**，否则 pending.entries 会指向
 * 已经被裁掉的 id，结算时找不到对象（老实现 memory.js:827-839 的注释）。
 */
export function commitPerson(person, { ledgerMax = FAVOR_RULE_DEFAULTS.ledgerMax, now = Date.now() } = {}) {
  if (Array.isArray(person.ledger) && person.ledger.length > ledgerMax) {
    const pendingIds = new Set(normalizePending(person.pending, person.ledger).entries);
    const keep = [];
    for (let i = person.ledger.length - 1; i >= 0; i -= 1) {
      const e = person.ledger[i];
      if (keep.length >= ledgerMax && !pendingIds.has(e.id)) continue;
      keep.push(e);
    }
    person.ledger = keep.reverse();
  }
  person.updatedAt = Number(now) || Date.now();
  return writePerson(person);
}

/**
 * 管理页/工具用：手动结算某人的台账。
 * @param {boolean} [force] true = 不看条数与冷静期（管理页「立即结算」）
 */
export function settleFavor(userId, { force = true, reason = '', settings = {}, now = Date.now() } = {}) {
  const key = resolvePersonKey(userId, '');
  if (!key) throw new Error('userId 必须是数字 QQ 号');
  const rules = favorRules(settings);
  const person = readForWrite(key);
  const r = applyVerdict(person, rules, { source: 'manual', force, now });
  if (!r.applied && r.count === 0) return r;
  // 手动结算时给理由加一句「谁按的」（审计里能分清自动/手动）
  const cyc = person.cycles?.[person.cycles.length - 1];
  if (cyc && reason) cyc.reason = `${String(reason).slice(0, 40)}｜${cyc.reason}`.slice(0, 90);
  commitPerson(person, { ledgerMax: rules.ledgerMax, now });
  return r;
}

/**
 * 管理页/工具用：直接调台账计数器（「后台应有数字标注出来并可以随时变动」）。
 *   { set: n } / { add: ±n } / { clear: true }
 *
 * ⚠️ 口径：计数是**标注**，不是分数。人为把 0 改成 3 只会让「够门槛了」，
 *    结算方向仍由真实的判断记录决定；凑数的占位条目一律是 neutral（不加不减分）。
 *    **绝不出现「手改一个数字就把好感加上去」**。
 */
export function setPending(userId, { set = null, add = 0, clear = false, note = '', settings = {}, now = Date.now() } = {}) {
  const key = resolvePersonKey(userId, '');
  if (!key) throw new Error('userId 必须是数字 QQ 号');
  const rules = favorRules(settings);
  const person = ensurePerson(key);
  person.ledger = ledgerOf(person);
  const before = normalizePending(person.pending, person.ledger);
  const beforeCount = before.count;

  let count;
  if (clear) count = 0;
  else if (set !== null && set !== undefined) count = Math.max(0, Math.round(Number(set) || 0));
  else count = Math.max(0, beforeCount + Math.round(Number(add) || 0));
  count = Math.min(99, count);

  // 台账条目对齐到 count：先留旧的（还存在于 ledger 里的），不够就补**中性占位**条目。
  const live = before.entries.filter((id) => person.ledger.some((e) => e.id === id)).slice(0, count);
  const entries = [...live];
  for (let i = entries.length; i < count; i += 1) {
    const ph = {
      id: ledgerId(),
      content: `（手动标注的判断条数 ${i + 1}/${count}${note ? `：${String(note).slice(0, 30)}` : ''}）`,
      sentiment: 'neutral',
      at: now,
      counted: false,
      cycle: 0
    };
    person.ledger.push(ph);
    entries.push(ph.id);
  }
  const score = entries
    .map((id) => person.ledger.find((e) => e.id === id))
    .reduce((n, e) => n + sentimentScore(e?.sentiment), 0);

  person.pending = {
    count: entries.length,
    score,
    since: entries.length ? (before.since || now) : 0,
    entries
  };
  person.pendingSince = person.pending.since;
  // 手动把条数改到门槛之上 = 「这批我看够了，结算吧」：
  // 否则会出现「数字卡在 3/3 却永远等下一次记判断」的怪状态。
  const verdict = (count >= rules.minPending)
    ? applyVerdict(person, rules, { source: 'manual', now })
    : null;
  // ⚠️ verdict 非空 ≠ 结算发生：冷静期会让 applyVerdict 返回 skipped（pending 原样保留）。
  // 之前只判 `verdict ?` 会在没结算时把审计与返回值谎报成"台账已清零"。
  const settled = Boolean(verdict && !verdict.skipped);
  commitPerson(person, { ledgerMax: rules.ledgerMax, now });
  audit({
    type: 'pending',
    userId: key,
    name: String(person.name || ''),
    from: beforeCount,
    to: settled ? 0 : person.pending.count,
    score,
    note: String(note || (clear ? '清空台账' : '手动改计数')).slice(0, 40)
  });
  return {
    userId: key,
    pendingCount: person.pending.count,
    pendingScore: settled ? 0 : score,
    verdict,
    status: favorStatusOf(person, rules)
  };
}

/**
 * 直接设置好感度 0~100（50=中性）。
 *
 * ⚠️ 这是**管理侧**的口子（管理页 / memory_favor 的强制微调）。它刻意不占判断台账：
 *    「管理员说多少就是多少」是必须保留的纠正路径，但每一次都要写审计。
 */
export function setFavor(userId, favor, { source = 'manual', reason = '', settings = {}, now = Date.now() } = {}) {
  const key = resolvePersonKey(userId, '');
  if (!key) throw new Error('userId 必须是数字 QQ 号');
  const rules = favorRules(settings);
  const person = ensurePerson(key);
  person.ledger = ledgerOf(person);
  const before = Number(person.favor ?? 50);
  const v = Math.min(clampFavor(favor), favorCapOf(person.userId, rules));
  person.favor = v;
  person.userId = key;
  // 管理页改过 → 24h 内不要用自动整理把它冲掉（老实现 isManuallyEdited 的口径）。
  person.manuallyEditedAt = now;
  person.updatedAt = now;
  if (before !== v) person.lastFavorChangeAt = now;
  commitPerson(person, { ledgerMax: rules.ledgerMax, now });
  if (before !== v) {
    audit({
      type: 'favor',
      userId: key,
      name: String(person.name || ''),
      from: before,
      to: v,
      delta: v - before,
      source,
      reason: String(reason || '').slice(0, 60)
    });
  }
  return { userId: key, favor: v, from: before, status: favorStatusOf(person, rules) };
}

/** 某人当前的好感/台账状态（查不到就按默认值给一份）。 */
export function getFavorStatus(userId, settings = {}) {
  const key = resolvePersonKey(userId, '');
  if (!key) return null;
  const person = readPerson(key);
  return favorStatusOf(person || blankPerson(key), favorRules(settings));
}

/** 全员好感状态（数字 QQ 号的档案才列，和老的 favorStates 口径一致）。 */
export function favorStates(settings = {}) {
  const rules = favorRules(settings);
  return listPeople()
    .filter((p) => isQqNumber(p.userId))
    .map((p) => favorStatusOf(p, rules));
}

/** 某人最近的判断记录（含未结算标记），倒序。 */
export function favorLedger(userId, { limit = 20 } = {}) {
  const key = resolvePersonKey(userId, '');
  if (!key) return [];
  const person = readPerson(key);
  if (!person) return [];
  const pendingIds = new Set(normalizePending(person.pending, ledgerOf(person)).entries);
  return ledgerOf(person)
    .slice(-Math.max(1, limit))
    .reverse()
    .map((e) => ({ ...e, pending: pendingIds.has(e.id) }));
}

/**
 * 动态注入段：把「它现在怎么看这个人」拼成极短的一段（老 formatForPrompt 的好感部分）。
 *
 * 注入四样东西（都是模型自己能看懂的短标记，不解释机制）：
 *   1. 好感分与档位：`好感50/100·中性`
 *   2. **待确认条数**：`待确认2/3` —— 后台那个数字，模型据此知道还差几条
 *   3. 印象正文（按会话隔离；可关）
 *   4. 最近两条「有情绪」的判断，带 +/- 标记
 *
 * ⚠️ 与老实现的差异（有意）：段名从【印象】改成【好感】。0.4.0 的
 *    src/memory.js 已经用【记忆】按群注入印象，这里只补「跨群的人这一维」，
 *    沿用【印象】会让模型把两套东西混成一套。
 *
 * @param {string[]|null} [opts.userIds] 只注入这些人（QQ 号数组）。
 *        传数组（含空数组）= 精确限定；传 null/undefined = 不限人（管理端调试用）。
 *        每轮注入的调用方**必须**传数组，否则会把整个群的档案都塞进提示词。
 */
export function buildFavorInject({
  chatKey = '', userIds = null, liveNames = null, notes = null, settings = {}
} = {}) {
  const raw = settings || {};
  if (pickSetting(raw, 'inject.enabled', 'injectEnabled') === false) return '';
  const maxPeople = Math.max(1, Math.round(Number(pickSetting(raw, 'inject.maxPeople', 'injectMaxPeople')) || 6));
  // 0 是合法值（= 每人不带印象正文，只留好感行），不能被 `|| 2` 吞；空串/非有限/负数才回落默认。
  const maxEachVal = pickSetting(raw, 'inject.maxEach', 'injectMaxEach');
  const maxEachNum = Math.round(Number(maxEachVal));
  const maxEach = String(maxEachVal ?? '').trim() !== '' && Number.isFinite(maxEachNum) && maxEachNum >= 0 ? maxEachNum : 2;
  const maxChars = Math.max(40, Math.round(Number(pickSetting(raw, 'inject.maxChars', 'injectMaxChars')) || 300));
  const withImpressions = pickSetting(raw, 'inject.impressions', 'injectImpressions') !== false;
  const rules = favorRules(raw);
  const live = liveNames instanceof Map ? liveNames : new Map(Object.entries(liveNames || {}));

  const filter = userIds ? new Set([...userIds].map(String).filter(Boolean)) : null;
  let people = listPeople();
  if (filter) people = people.filter((p) => filter.has(String(p.userId)));
  if (!people.length) return '';

  const parts = [];
  const hints = [];
  for (const m of people.slice(0, maxPeople)) {
    const qq = String(m.userId || '');
    const scoped = filterImpressionsByChat(m.impressions, chatKey);
    const favor = Math.min(Number(m.favor ?? 50), favorCapOf(m.userId, rules));
    const band = favorBand(favor);
    const pending = normalizePending(m.pending, ledgerOf(m));
    // 什么都没得说的人不注入（省 token）：中性起步 + 没印象 + 没待确认 = 白占一行
    if (favor === 50 && !pending.count && !scoped.length) continue;
    const stored = String(m.name || '').trim();
    const liveName = String(live.get(qq) || '').trim();
    const who = (notes && notes[qq]) || liveName || (stored && stored !== qq ? stored : '') || qq;
    const mark = `好感${favor}/100·${band}` + (pending.count > 0 ? `·待确认${pending.count}/${rules.minPending}` : '');
    const lines = withImpressions
      ? (maxEach > 0 ? scoped.slice(-maxEach) : []).map((e) => safeTruncate(e.content || '', 40))
      : [];
    const anchor = isQqNumber(qq) ? `@${qq} ` : '';
    parts.push(lines.length
      ? `${anchor}${who}(${mark}): ${lines.join(' / ')}`
      : `${anchor}${who}(${mark})`);
    // 最近的判断：优先「有情绪」的（中性占位对判断这人的态度没意义）
    const recent = ledgerOf(m)
      .filter((e) => !chatKey || !e.chatKey || e.chatKey === String(chatKey))
      .slice(-8)
      .filter((e) => e.sentiment !== 'neutral')
      .slice(-rules.promptLedger)
      .map((e) => `${e.sentiment === 'positive' ? '+' : '-'}${safeTruncate(e.content, 24)}`);
    if (recent.length) parts.push(`  ${who}最近：${recent.join('；')}`);
    if (favor >= 70) hints.push(`对${who}：可以热情、亲近一点，愿意多接话`);
    else if (favor <= 30) hints.push(`对${who}：态度可以冷淡、敷衍，甚至不想理；别热脸贴冷屁股`);
    else if (favor >= 55) hints.push(`对${who}：稍友好即可`);   // 60→55，与档位口径同步
    else if (favor <= 40) hints.push(`对${who}：稍冷淡、话少一点`);
    else if (pending.count > 0) hints.push(`对${who}：还在观察（攒够 ${rules.minPending} 条判断再决定加分还是减分）`);
  }
  if (!parts.length && !hints.length) return '';
  let text = parts.join('；');
  if (text.length > maxChars) text = `${safeTruncate(text, maxChars - 1)}…`;
  const hintLine = hints.length ? `\n（态度）${hints.join('；')}` : '';
  return `【好感】${text}${hintLine}`;
}

/** 印象按来源会话过滤：带 chatKey 的只在那一个会话可见，没带的（老数据）仍然全局可见。 */
export function filterImpressionsByChat(list, chatKey) {
  const arr = Array.isArray(list) ? list : [];
  if (!chatKey) return arr;
  return arr.filter((e) => {
    const from = String(e?.chatKey || '');
    return !from || from === String(chatKey);
  });
}

function pickSetting(raw, path, flatKey) {
  return readSetting(raw, path, flatKey);
}

/** 只给 UI/排障用：把当前规则与某人的状态一起吐出来。 */
export function favorDebug(userId, settings = {}) {
  return { rules: favorRules(settings), status: getFavorStatus(userId, settings) };
}

export { nameOnlyKey, resolvePersonKey, favorRules, favorStatusOf, normalizePending, sentimentScore };
export { LEDGER_CONTENT_MAX, FAVOR_RULE_DEFAULTS };
