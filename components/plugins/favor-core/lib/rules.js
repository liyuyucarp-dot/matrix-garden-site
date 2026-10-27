// 好感度的「规则层」：默认值、钳制、情绪归一化、台账/判断记录的归一化。
//
// 这一层的语义**逐条对齐老实现**（快照 S1 = `_legacy-features-backup-20260920/
// legacy-src-20260917/memory.js`，行号见 docs/port-specs/01-favor-system.md §2.1）：
//   偏好默认值/钳制        memory.js:43-74   FAVOR_RULE_DEFAULTS / favorRules()
//   好感分 → 档位          memory.js:77-86   favorBand()
//   情绪归一/取值/粗判      memory.js:89-117  normalizeSentiment / sentimentScore / inferSentiment
//   印象按会话裁剪          memory.js:136-169 trimImpressions()
//   判断记录归一            memory.js:176-191 normalizeLedgerEntry()
//   台账归一（与 ledger 对齐）memory.js:273-288 normalizePending()
//
// 与老实现的差异都写在文件对应位置的注释里，并在 docs/port-P2a-favor-core-变更记录.md 汇总。

/** 单条判断原文的长度上限（提示词里只截 40 字，这里存宽松一点）。 */
export const LEDGER_CONTENT_MAX = 80;

/** 印象条数上限：**按来源会话**各留这么多，另加一个总量天花板。 */
export const IMPRESSIONS_PER_CHAT = 8;
export const IMPRESSIONS_TOTAL_MAX = 40;

/** 判断记录上限（可在设置里改；未结算的台账条目永远保留）。 */
export const LEDGER_MAX_DEFAULT = 40;

/** 只带名字、没有 QQ 号时的档案键前缀（对齐老 `personFileName` 的 `_n_<名字>.json`）。 */
export const NAME_ONLY_PREFIX = '_n_';

/**
 * 兜底默认值。plugin.json 的 settings 是给用户改的；
 * 这里保证「设置缺字段 / 直接传空对象」也能跑。
 */
export const FAVOR_RULE_DEFAULTS = {
  minPending: 3,              // 攒够几条判断才允许确认加分/减分
  maxStep: 2,                 // 单次确认最多加多少分（加分慢：好感难得）
  minStep: -3,                // 单次确认最多减多少分（减分快：被怼更容易掉）
  ledgerMax: LEDGER_MAX_DEFAULT,
  promptLedger: 2,            // 注入提示词时每人带几条「最近判断」
  cooldownMs: 5 * 60 * 1000,  // 两次确认之间的冷静期（防一轮内连续结算）
  repeatWindowMs: 24 * 3600 * 1000,  // 同一句已结算内容多久内不再计数
  copycatWindowMs: 5 * 60 * 1000     // 跟风复读（别人刚说过）的窗口
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/**
 * 设置读取：优先「点分子键」（UI 通用表单保存出来的形状，如 `judge.enabled`），
 * 其次嵌套对象（plugin.json 的 settings 形状，如 `judge.enabled` 嵌在 judge 里），
 * 最后才是默认值。
 *
 * 为什么要认两种形状：本仓的技能设置表单是**按 configSchema 的键名**提交的
 * （ui/app/06-settings-render.js:1040-1056），而 configSchema 里要逐项给出中文
 * label/description 就必须是**扁平可渲染的键**（type 为 internal 的组不渲染输入框）。
 * 于是配置里可能出现 `judge.enabled: false` 这种字面点号键 —— 它不是笔误，是
 * 表单真实写出来的东西，读取侧必须认，否则「改了设置却不生效」。
 */
function pick(raw, path, flatKey) {
  if (!raw || typeof raw !== 'object') return undefined;
  const dotted = raw[path];
  if (dotted !== undefined && dotted !== null) return dotted;
  const [head, tail] = path.split('.');
  if (tail && raw[head] && typeof raw[head] === 'object') {
    const v = raw[head][tail];
    if (v !== undefined && v !== null) return v;
  }
  if (flatKey && raw[flatKey] !== undefined && raw[flatKey] !== null) return raw[flatKey];
  return undefined;
}

/** 上面那套「三种键形都认」的读取口，导出给 ledger.js / judge.js 复用。 */
export { pick as readSetting };

/**
 * 读当前生效的规则（设置对象进、钳制后的规则对象出）。
 *
 * ⚠️ 每次调用都重新算，**不要缓存到模块级变量**：设置页改完要立刻生效，
 *    缓存住就得重启程序（老实现 memory.js:56-58 的注释同款理由）。
 */
/**
 * ★ 2026-10-19「好感度封顶」：除白名单以外的人，好感最高只能到 `capOthers`。
 * 动机（用户口径）：主人和某一位特殊的角色之外，其他人不该走到"亲近"档。
 * · `favorCap` = 0 或 ≥100 ⇒ 关闭（默认关，避免影响别人的包）；
 * · `favorCapExcept` = 逗号/空格分隔的 QQ 列表（不封顶的人）。
 */
export function favorCapOf(userId, rules = {}) {
  const cap = Number(rules?.capOthers) || 0;
  if (!(cap > 0 && cap < 100)) return 100;
  const uid = String(userId ?? '').trim();
  const list = Array.isArray(rules?.capExcept) ? rules.capExcept : [];
  return list.includes(uid) ? 100 : cap;
}

export function favorRules(raw = {}) {
  const minPending = Math.max(1, Math.round(num(pick(raw, 'minPending'), FAVOR_RULE_DEFAULTS.minPending)));
  const maxStep = Math.max(0, Math.round(num(pick(raw, 'maxStep'), FAVOR_RULE_DEFAULTS.maxStep)));
  // minStep 老口径是负数（-3），老实现用 Math.min(-1, …) 保证它永远为负 ——
  // 副作用是「填正数 3 想表示减 3 分」会被静默抬成 -1（幅度变成 1，没人看得出为什么）。
  // 这里按「负向幅度」取负：-3 与 3 等价，语义唯一，且下限仍是 1。
  const rawMin = num(pick(raw, 'minStep'), FAVOR_RULE_DEFAULTS.minStep);
  const minStep = -Math.max(1, Math.abs(Math.round(rawMin)));
  return {
    minPending,
    maxStep,
    minStep,
    ledgerMax: Math.max(4, Math.round(num(pick(raw, 'ledgerMax'), FAVOR_RULE_DEFAULTS.ledgerMax))),
    promptLedger: Math.max(0, Math.round(num(pick(raw, 'promptLedger'), FAVOR_RULE_DEFAULTS.promptLedger))),
    cooldownMs: Math.max(0, num(pick(raw, 'cooldownMs'), FAVOR_RULE_DEFAULTS.cooldownMs)),
    repeatWindowMs: Math.max(0, num(pick(raw, 'repeatWindowMs'), FAVOR_RULE_DEFAULTS.repeatWindowMs)),
    copycatWindowMs: Math.max(0, num(pick(raw, 'copycatWindowMs'), FAVOR_RULE_DEFAULTS.copycatWindowMs)),
    // ★ 2026-10-19 封顶
    capOthers: (() => {
      const n = Math.round(num(pick(raw, 'favorCap'), 0));
      return (n > 0 && n < 100) ? n : 0;
    })(),
    capExcept: String(pick(raw, 'favorCapExcept') || '')
      .split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean)
  };
}

/** 好感分 → 档位（提示词/UI 共用的口径：0~100，50 中性）。 */
export function favorBand(favor) {
  const v = Number.isFinite(Number(favor)) ? Number(favor) : 50;
  if (v >= 85) return '亲近';
  if (v >= 70) return '好感高';
  // ★ 2026-10-12：「稍友好」门槛 60 → 55。原因：实测 207 人里 189 人（91%）落在
  //   「中性」带（41~59），而好感值天然聚集在 50~57 —— 档位几乎无区分度，关系/态度类
  //   注入对绝大多数人输出同一句。降 5 分让 55~57 那批人自然进入「稍友好」。
  //   ⚠️ 口径唯一：同值必须同步改 `sleep-mood/lib/favor-link.js`、`src/routes.js`、
  //   `ui/app/12-people.js`，以及 `ledger.js` 里那句「稍友好即可」的阈值。
  if (v >= 55) return '稍友好';
  if (v > 40) return '中性';
  if (v > 30) return '稍冷淡';
  if (v > 15) return '反感';
  return '厌恶';
}

/** 一条印象落在哪个情绪档（只认三个值，其它一律 neutral）。 */
export function normalizeSentiment(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'positive' || s === 'pos' || s === '好' || s === '+' || s === '1') return 'positive';
  if (s === 'negative' || s === 'neg' || s === '坏' || s === '差' || s === '-' || s === '-1') return 'negative';
  return 'neutral';
}

/** 情绪档 → 分值（好 +1 / 坏 −1 / 平 0）。 */
export function sentimentScore(v) {
  const s = normalizeSentiment(v);
  return s === 'positive' ? 1 : (s === 'negative' ? -1 : 0);
}

const POS_HINT = /(帮了|帮我|帮过我|好意|请我|送|夸|认可|道歉|谢谢|感谢|信任|维护|站我|护着|客气|温柔|耐心|陪我|记得我|关心|有趣|有意思|好笑|逗|靠谱|大方|请客|投喂|支持|站队|不让怼|护短|人情|善意|道歉了)/;
const NEG_HINT = /(怼|骂|嘲|阴阳|讽刺|骂人|恶心|蠢|笨|垃圾|废物|滚|闭嘴|烦死|烦人|辱骂|贬低|针对|挑刺|阴阳怪气|杠|抬杠|嘲讽|看不起|瞧不起|羞辱|人身攻击|刷屏|骚扰|逼|威胁|骗|耍|赖|凶|吐|喷|踩|嫌|催|挂我|点名骂|反复损|拿我出气|不尊重|发泄)/;

/** 没写 sentiment 时按原文粗判；认不出来就是 neutral（宁可记「平」，也不瞎打分）。 */
export function inferSentiment(content) {
  const t = String(content ?? '');
  if (!t) return 'neutral';
  const pos = POS_HINT.test(t);
  const neg = NEG_HINT.test(t);
  if (pos && !neg) return 'positive';
  if (neg && !pos) return 'negative';
  return 'neutral';
}

/** 判断记录 id（与老实现同构：36 进制时间戳 + 4 位随机）。 */
export function ledgerId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 把任意来源（文件/旧格式）归一成一条判断记录；认不出来返回 null。
 *
 * ⚠️ 这里**原样保留未知字段**（intensity/hits/lastAt 这类后加的字段）。
 *    老实现只挑固定字段重打包，读盘即把这些字段静默抹掉（规格 §10.2 记过一笔）。
 *    本移植的白名单是「必须有哪些字段」，而不是「只允许有哪些字段」。
 */
export function normalizeLedgerEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content ?? '').trim().slice(0, LEDGER_CONTENT_MAX);
  if (!content) return null;
  return {
    ...raw,
    id: String(raw.id || ledgerId()),
    content,
    sentiment: normalizeSentiment(raw.sentiment),
    at: Number(raw.at ?? raw.createdAt) || Date.now(),
    counted: raw.counted === true,   // true = 这条已经算进某次确认里
    cycle: Number(raw.cycle) || 0,   // 被哪一轮确认吃掉的（0 = 还没）
    // 这条判断发生在哪个会话：印象按会话隔离靠它（老实现曾因归一化漏掉它而隔离失效）
    chatKey: String(raw.chatKey || '')
  };
}

/**
 * 台账归一：count/score 永远和 entries 对齐（文件被手改过也不会错位），
 * 并且**只保留还没结算的条目**。
 */
export function normalizePending(raw, ledger = null) {
  let entries = Array.isArray(raw?.entries) ? raw.entries.map(String).filter(Boolean) : [];
  if (Array.isArray(ledger)) {
    const byId = new Map(ledger.map((e) => [String(e.id), e]));
    entries = entries.filter((id) => byId.has(id) && byId.get(id).counted !== true);
  }
  const score = Array.isArray(ledger)
    ? entries.reduce((n, id) => n + sentimentScore(ledger.find((e) => String(e.id) === id)?.sentiment), 0)
    : (Number(raw?.score) || 0);
  return {
    count: entries.length,
    score,
    since: Number(raw?.since) || 0,
    entries
  };
}

/**
 * 按来源会话裁剪印象列表（返回新数组）。
 *
 * ⚠️ 为什么不能只写 `slice(-12)`：全局一个窗口时，**在 B 群多聊几句就会把 A 群的
 *    印象挤出去**（老实现 memory.js:126-135 记录了这次线上事故）。改成「每个会话
 *    各留 N 条」后两个群的记忆互不挤占；总量天花板只用来防文件无限膨胀。
 */
export function trimImpressions(list) {
  if (!Array.isArray(list) || !list.length) return list;
  const byChat = new Map();
  for (const e of list) {
    const ck = String(e?.chatKey || '');
    if (!byChat.has(ck)) byChat.set(ck, []);
    byChat.get(ck).push(e);
  }
  // ① 每个会话内部只留最近的 N 条（保持原有先后顺序）
  const drop = new Set();
  for (const arr of byChat.values()) {
    if (arr.length <= IMPRESSIONS_PER_CHAT) continue;
    for (const e of arr.slice(0, arr.length - IMPRESSIONS_PER_CHAT)) drop.add(e);
  }
  let kept = list.filter((e) => !drop.has(e));
  // ② 总量还超 → 从「当前条数最多的会话」里淘汰最旧的一条，反复直到满足上限。
  //    轮流淘汰是为了不出现「某个群被整个清空」的偏袒。
  while (kept.length > IMPRESSIONS_TOTAL_MAX) {
    const counts = new Map();
    for (const e of kept) {
      const ck = String(e?.chatKey || '');
      counts.set(ck, (counts.get(ck) || 0) + 1);
    }
    let victimChat = null;
    let victimN = 0;
    for (const [ck, n] of counts) {
      if (n > victimN) { victimN = n; victimChat = ck; }
    }
    const idx = kept.findIndex((e) => String(e?.chatKey || '') === victimChat);
    if (idx < 0) break;
    kept = kept.filter((_, i) => i !== idx);
  }
  return kept;
}

/**
 * 「只有名字、没有 QQ 号」时的档案键 —— 与老 `personFileName` 的清洗规则一致。
 *
 * ⚠️ 与老实现的差异（有意）：老档案里 `userId` 存空串、文件名是 `_n_<名字>.json`；
 *    本移植直接把 `_n_<名字>` 当**档案键**（`data/memory/people/_n_<名字>.json`）。
 *    原因：新数据层 src/memory-people.js 只以 `userId` 为文件名（personFile），
 *    ensurePerson 也要求非空 id —— 用它当键既能复用数据层，又恰好落在老文件名上，
 *    老档案可以直接读。
 */
export function nameOnlyKey(name) {
  const safe = String(name || '').trim().replace(/[^a-z0-9_一-鿿]/gi, '_').slice(0, 40);
  return `${NAME_ONLY_PREFIX}${safe || 'unknown'}`;
}

/** QQ 号是否可信（老实现到处用的那个正则：5~15 位数字）。 */
export function isQqNumber(v) {
  return /^\d{5,15}$/.test(String(v ?? '').trim());
}

/**
 * 把工具的 userId 参数归一成「档案键」：能当 QQ 号就用它，否则退回 `_n_<名字>`。
 * 认不出来又没有名字 → 返回 ''（调用方报错，不要把整句印象当名字存进档案）。
 */
export function resolvePersonKey(userId, target = '') {
  let uid = String(userId ?? '').trim();
  // 老实现容错：模型偶尔会把 QQ 号写成负数（引用消息的 uid 前缀）
  if (/^-?\d{5,15}$/.test(uid)) uid = String(Math.abs(Number(uid)));
  if (isQqNumber(uid)) return uid;
  const name = String(target ?? '').trim();
  if (name) return nameOnlyKey(name);
  return '';
}

/** 某人当前的好感/台账状态（提示词、工具、UI 共用同一份口径）。 */
export function favorStatusOf(person, rules = FAVOR_RULE_DEFAULTS) {
  // ★ 封顶在读取处也生效：面板、关系档位、tone-link 看到的都是封顶后的值
  const favor = Math.min(Number(person?.favor ?? 50), favorCapOf(person?.userId, rules));
  const pending = normalizePending(person?.pending, person?.ledger || null);
  const last = Array.isArray(person?.cycles) && person.cycles.length
    ? person.cycles[person.cycles.length - 1]
    : null;
  return {
    key: String(person?.userId || ''),
    userId: String(person?.userId || ''),
    name: String(person?.name || ''),
    favor,
    band: favorBand(favor),
    pendingCount: pending.count,
    pendingScore: pending.score,
    pendingSince: pending.since,
    need: Math.max(1, Number(rules?.minPending) || FAVOR_RULE_DEFAULTS.minPending),
    cycles: Number(person?.cycleCount) || 0,
    lastChange: last
      ? { at: Number(last.at) || 0, delta: Number(last.delta) || 0, reason: String(last.reason || '') }
      : null,
    lastFavorChangeAt: Number(person?.lastFavorChangeAt) || 0,
    lastVerdictAt: Number(person?.lastVerdictAt) || 0
  };
}
