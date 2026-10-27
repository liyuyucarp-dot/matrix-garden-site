// mood-chain.js —— 「元气 (Vitality) + 具身情境心境 (Episodic Mood Tags)」双轴引擎 (v2.0)
// ═════════════════════════════════════════════════════════════════════════════
// 重构核心设计（方案一 + 方案二定制版）：
//   1. 【第一轴：元气值 Vitality (0~100)】
//      · 彻底废除旧版 HP 生命值扣血、零血失忆、A/B/C 压力池暴走、吵架速度(spunk)、抑郁度(depress)。
//      · ★ 日常清醒与聊天绝不自然消耗元气（不按在线时长扣分、不按发消息条数扣分）。
//      · 元气仅由【旅途/庭院具体事件】（遭遇战、异世界穿越、吃特产、庭院慢生活）、
//        【睡眠恢复 / 泡澡恢复 / 被强行吵醒】或【手动工具调整】驱动。
//      · 落盘自动映射兼容字段 `fatigue.value = 100 - vitality.value`，下游零改动兼容。
//
//   2. 【第二轴：具身情境心境标签 Active Mood Tags（最多 2 个，带明确 why 与过期时间 TTL）】
//      · 告别 5 维情绪微积分与好感概率骰子；所有心情波动均由真实事件（旅途奇遇、寄明信片、
//        吃特产、庭院互动、群友夸奖/斗嘴/吃醋）挂载具身 Tag。
//      · 自动投影生成 `mood.json` 的 `moods.{happy,excited,angry,jealous,sad}`（含 `why` 与 `at`）
//        以及 `mood.value` / `satisfaction.value`，100% 兼容 `mind-wish`、`autobiography`、`courtyard-map`。
// ═════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STATE_FILE = 'mood.json';
const MAX_ACTIVE_TAGS = 2;
const DEFAULT_VITALITY = 85;
const DEFAULT_TAG_TTL_MS = 3 * 60 * 60 * 1000; // 默认心境余味保留 3 小时

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(num(v, lo))));

export const MOOD_BANDS = [
  { max: 9, label: '一丝' },
  { max: 29, label: '有点' },
  { max: 59, label: '明显' },
  { max: 84, label: '强烈' },
  { max: 100, label: '极度' }
];

export function bandOf(level) {
  const v = clamp(level, 0, 100);
  for (const b of MOOD_BANDS) {
    if (v <= b.max) return b.label;
  }
  return '极度';
}

export const EMOTIONS = {
  happy: { word: '开心', tone: 'good', defaultTag: '心情雀跃' },
  excited: { word: '兴奋', tone: 'good', defaultTag: '兴致勃勃' },
  angry: { word: '生气', tone: 'bad', defaultTag: '鼓腮帮子赌气' },
  jealous: { word: '吃醋', tone: 'bad', defaultTag: '心里泛酸' },
  sad: { word: '难过', tone: 'bad', defaultTag: '有点小委屈' }
};

export const SATISFACTION_DEFAULTS = {
  enabled: true,
  travelBase: 65,
  travelPullPerHour: 0
};

export const MOOD_DEFAULTS = {
  enabled: true,
  stateFile: STATE_FILE,
  vitality: {
    defaultVal: DEFAULT_VITALITY,
    sleepRecoverPerHour: 22,    // 睡眠期间每小时恢复元气
    wakeSettleMinMs: 20 * 60 * 1000, // 睡够 20 分钟醒来保底恢复
    lowHintThreshold: 45,       // 元气 <= 45 提示微倦
    sleepyThreshold: 20         // 元气 <= 20 提示困倦
  },
  mood: {
    requireAddressed: true,
    selfNegateWords: '如果 要是 假如 本来 打算 差点',
    triggers: {
      happy: '喜欢 爱你 太棒 厉害 真棒 可爱 乖 贴贴 抱抱 摸摸 夸 好吃 好看 谢谢 辛苦了',
      excited: '出发 冒险 抽到 稀有 极光 宝藏 异世界 赢了 太酷 绝了 期待',
      angry: '好烦 烦死 烦人 真烦 讨厌 滚蛋 滚开 滚出去 闭嘴 啰嗦 死开 少管你 无聊 幼稚 恶心 笨死了 吵死 吵什么 别吵',
      jealous: '她也cute 她好可爱 别人也 姐姐好 妹妹好 你们聊 抱她 亲她 夸她',
      sad: '不理你了 没意思 失望 委屈 讨厌我 讨厌我吗 不喜欢我了吗'
    },
    rage: {
      snapWords: '呵 啧 就这？ 你行你上 说的就是你 关你什么事 少管闲事 你懂什么 不理你 行了吧 可真行 无语 懒得理你'
    },
    jealousy: {
      intimateWords: '抱抱 抱住 亲亲 亲一口 贴贴 蹭蹭 摸头 牵手 靠肩 膝枕 捏脸 摸摸'
    }
  },
  fatigue: {
    // 兼容旧配置结构，但日常与发言增量恒为 0
    msgGain: 0,
    denseBonus: 0,
    actCapPerHour: 0
  }
};

function stateFilePath() {
  return path.join(DATA_DIR, STATE_FILE);
}

/**
 * 清理过期情境 Tag，并由【元气 + 活跃情境 Tag】自动推导生成下游全量兼容字段。
 * 下游契约保障：
 *   · mind-wish 读 `moods[*].why`、`mood.value`、`depress.value`、`satisfaction.value`
 *   · autobiography 读 `moods[*].why` 与 `moods[*].at`
 *   · courtyard-map 读 `mood.value`、`satisfaction.value`、`fatigue.value` 等
 *   · tone-link 读 `fatigue.value`、`rage.hitAt`、`moods.jealous.level`
 */
function normalizeAndProject(raw = {}, now = Date.now()) {
  const st = (raw && typeof raw === 'object') ? { ...raw } : {};
  st.scale = 'v4-travel';

  // 1. 元气值（若旧存档只有 fatigue，自动按 100 - fatigue 迁移一次）
  let vitVal = DEFAULT_VITALITY;
  if (st.vitality && Number.isFinite(Number(st.vitality.value))) {
    vitVal = clamp(st.vitality.value, 0, 100);
  } else if (st.fatigue && Number.isFinite(Number(st.fatigue.value))) {
    vitVal = clamp(100 - Number(st.fatigue.value), 15, 100);
  }
  const sleptAt = num(st.vitality?.sleptAt ?? st.fatigue?.sleptAt, 0);
  const vitAt = num(st.vitality?.at ?? st.fatigue?.at, now);
  st.vitality = {
    value: vitVal,
    at: vitAt,
    sleptAt,
    why: String(st.vitality?.why || '')
  };

  // 同步映射 fatigue（供 courtyard-map / tone-link / 旧工具无缝读取）
  st.fatigue = {
    value: clamp(100 - vitVal, 0, 100),
    at: vitAt,
    sleptAt,
    updatedAt: vitAt
  };

  // 2. 具身情境 Tag 队列（过滤已过期项，最多保留最新 MAX_ACTIVE_TAGS 条）
  const rawTags = Array.isArray(st.activeTags) ? st.activeTags : [];
  const validTags = rawTags
    .filter((t) => t && t.tag && num(t.expiresAt, 0) > now)
    .map((t) => ({
      id: String(t.id || `${t.category || 'happy'}:${t.at || now}`),
      tag: String(t.tag).trim(),
      tone: String(t.tone || 'good'),
      category: EMOTIONS[t.category] ? t.category : (t.tone === 'bad' ? 'angry' : 'happy'),
      level: clamp(t.level ?? 65, 10, 100),
      why: String(t.why || '').trim(),
      guide: String(t.guide || '').trim(),
      source: String(t.source || 'event'),
      at: num(t.at, now),
      expiresAt: num(t.expiresAt, now + DEFAULT_TAG_TTL_MS)
    }));
  validTags.sort((a, b) => b.at - a.at);
  st.activeTags = validTags.slice(0, MAX_ACTIVE_TAGS);

  // 3. 投影情绪五维 moods（保留已有未过期的 why，供 mind-wish / autobiography 采集）
  const prevMoods = (st.moods && typeof st.moods === 'object') ? st.moods : {};
  const nextMoods = {
    happy: { level: 55, why: String(prevMoods.happy?.why || ''), at: num(prevMoods.happy?.at, 0) },
    excited: { level: 20, why: String(prevMoods.excited?.why || ''), at: num(prevMoods.excited?.at, 0) },
    angry: { level: 0, why: String(prevMoods.angry?.why || ''), at: num(prevMoods.angry?.at, 0) },
    jealous: { level: 0, why: String(prevMoods.jealous?.why || ''), at: num(prevMoods.jealous?.at, 0) },
    sad: { level: 0, why: String(prevMoods.sad?.why || ''), at: num(prevMoods.sad?.at, 0) }
  };

  let moodScore = 65;
  let satScore = 65;
  let lastAngryAt = num(st.rage?.hitAt, 0);

  for (const t of st.activeTags) {
    const cat = t.category;
    if (nextMoods[cat]) {
      nextMoods[cat] = {
        level: Math.max(nextMoods[cat].level, t.level),
        why: t.why || t.tag,
        at: t.at
      };
    }
    if (t.tone === 'good') {
      moodScore += 14;
      satScore += 10;
      nextMoods.happy.level = Math.max(nextMoods.happy.level, t.level);
      if (!nextMoods.happy.why || t.at >= nextMoods.happy.at) {
        nextMoods.happy.why = t.why || t.tag;
        nextMoods.happy.at = t.at;
      }
    } else if (t.tone === 'bad') {
      moodScore -= 16;
      satScore -= 10;
      nextMoods.happy.level = Math.min(nextMoods.happy.level, 35);
      if (cat === 'angry') lastAngryAt = Math.max(lastAngryAt, t.at);
    } else if (t.tone === 'mixed') {
      nextMoods.excited.level = Math.max(nextMoods.excited.level, t.level);
      if (!nextMoods.excited.why || t.at >= nextMoods.excited.at) {
        nextMoods.excited.why = t.why || t.tag;
        nextMoods.excited.at = t.at;
      }
    }
  }

  st.moods = nextMoods;
  st.mood = { value: clamp(moodScore, 0, 100), at: now };
  st.satisfaction = { value: clamp(satScore, 0, 100), at: now };
  st.depress = { value: 0, at: now };
  st.spunk = { value: 0, at: now };
  st.neglect = { value: 0, at: now };
  st.rage = {
    value: nextMoods.angry.level,
    channel: nextMoods.angry.level >= 50 ? 'snap' : '',
    hitAt: nextMoods.angry.level > 0 ? lastAngryAt : 0
  };

  return st;
}

// 进程内轻量读缓存（按 mtimeMs 校验，避免每次钩子重复 JSON.parse）
let _cache = { mtimeMs: -1, data: null };

export function readMoodChain(now = Date.now()) {
  const file = stateFilePath();
  try {
    const stat = fs.statSync(file);
    if (_cache.data && _cache.mtimeMs === stat.mtimeMs) {
      return normalizeAndProject(JSON.parse(JSON.stringify(_cache.data)), now);
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    _cache = { mtimeMs: stat.mtimeMs, data: raw };
    return normalizeAndProject(raw, now);
  } catch {
    return normalizeAndProject({}, now);
  }
}

export function writeMoodChain(state, now = Date.now()) {
  const file = stateFilePath();
  try {
    const norm = normalizeAndProject(state, now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(norm, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    try {
      const stat = fs.statSync(file);
      _cache = { mtimeMs: stat.mtimeMs, data: norm };
    } catch {
      _cache = { mtimeMs: -1, data: null };
    }
    return true;
  } catch {
    return false;
  }
}

export function moodChainConfig(cfg = {}) {
  const src = (cfg && cfg.moodChain) ? cfg.moodChain : (cfg || {});
  return {
    ...MOOD_DEFAULTS,
    ...src,
    vitality: { ...MOOD_DEFAULTS.vitality, ...(src.vitality || {}) },
    mood: {
      ...MOOD_DEFAULTS.mood,
      ...(src.mood || {}),
      triggers: { ...MOOD_DEFAULTS.mood.triggers, ...(src.mood?.triggers || {}) }
    }
  };
}

export function migrateStateOnce(now = Date.now()) {
  const st = readMoodChain(now);
  return writeMoodChain(st, now);
}

/**
 * 调整元气值（正数恢复，负数消耗）。
 * ★ 遵循定制规则：日常清醒与聊天不自然消耗元气，仅由具体事件、睡眠/泡澡或手动工具触发。
 */
export function stepVitality(delta, why = '', now = Date.now()) {
  const d = Math.round(num(delta, 0));
  const st = readMoodChain(now);
  if (!d) return st.vitality;
  const before = st.vitality.value;
  st.vitality = {
    ...st.vitality,
    value: clamp(before + d, 0, 100),
    at: now,
    why: String(why || st.vitality.why || '').slice(0, 80)
  };
  writeMoodChain(st, now);
  return { before, after: st.vitality.value, delta: st.vitality.value - before, why: st.vitality.why };
}

/**
 * 挂载一个具身情境心境 Tag（最多保留 2 个最新活跃 Tag，同类或同标签自动刷新覆盖）。
 */
export function pushMoodTag({
  tag = '',
  tone = 'good',
  category = 'happy',
  level = 68,
  why = '',
  guide = '',
  source = 'event',
  ttlMs = DEFAULT_TAG_TTL_MS,
  now = Date.now()
} = {}) {
  const cleanTag = String(tag || '').trim();
  if (!cleanTag) return null;
  const st = readMoodChain(now);
  const cat = EMOTIONS[category] ? category : (tone === 'bad' ? 'angry' : 'happy');
  const entry = {
    id: `${cat}:${now}`,
    tag: cleanTag,
    tone: ['good', 'bad', 'mixed', 'calm'].includes(tone) ? tone : 'good',
    category: cat,
    level: clamp(level, 15, 100),
    why: String(why || cleanTag).trim().slice(0, 100),
    guide: String(guide || '').trim(),
    source: String(source || 'event'),
    at: now,
    expiresAt: now + Math.max(5 * 60 * 1000, num(ttlMs, DEFAULT_TAG_TTL_MS))
  };

  // 同 tag 名或同 category 的旧标签直接替换，避免重复挂两个同类标签
  const filtered = (st.activeTags || []).filter(
    (t) => t.tag !== entry.tag && !(t.category === entry.category && t.source === entry.source)
  );
  st.activeTags = [entry, ...filtered].slice(0, MAX_ACTIVE_TAGS);
  writeMoodChain(st, now);
  return entry;
}

/**
 * 兼容旧版 stepMood(deltas, whys, cfg, now) 调用口：
 * 将 delta 增量自动转化为具身情境 Tag 挂载，确保存量调用方（如旅途瞬间、对话情绪词、工具）无缝工作。
 */
export function stepMood(deltas = {}, whys = {}, _cfg = null, now = Date.now()) {
  if (!deltas || typeof deltas !== 'object') return readMoodChain(now);
  let bestKey = '';
  let bestVal = 0;
  for (const [k, v] of Object.entries(deltas)) {
    const abs = Math.abs(num(v, 0));
    if (EMOTIONS[k] && abs > bestVal) {
      bestKey = k;
      bestVal = abs;
    }
  }
  if (!bestKey || bestVal < 2) return readMoodChain(now);

  const rawDelta = num(deltas[bestKey], 0);
  const whyText = (typeof whys === 'string' ? whys : (whys?.[bestKey] || Object.values(whys || {})[0] || '')).trim();

  // 如果是对负面情绪做负向抵消（例如安抚消气），清除对应负面 Tag
  if ((bestKey === 'angry' || bestKey === 'sad' || bestKey === 'jealous') && rawDelta < 0) {
    const st = readMoodChain(now);
    st.activeTags = (st.activeTags || []).filter((t) => t.category !== bestKey);
    writeMoodChain(st, now);
    return st;
  }

  // 如果是对 happy/excited 扣负分（例如旅途遇挫 happy: -10, sad: 12），找正增量的负面键或映射为小郁闷
  let targetCat = bestKey;
  if ((bestKey === 'happy' || bestKey === 'excited') && rawDelta < 0) {
    targetCat = num(deltas.angry, 0) >= num(deltas.sad, 0) && num(deltas.angry, 0) > 0 ? 'angry' : 'sad';
  }

  const def = EMOTIONS[targetCat] || EMOTIONS.happy;
  const tagLabel = inferTagLabelFromWhy(targetCat, whyText, def.defaultTag);
  const ttlMs = bestVal >= 12 ? 3 * 3600_000 : 90 * 60_000;
  pushMoodTag({
    tag: tagLabel,
    tone: def.tone,
    category: targetCat,
    level: clamp(45 + bestVal * 2, 35, 95),
    why: whyText || tagLabel,
    source: whyText.includes('旅') || whyText.includes('庭院') ? 'travel' : 'chat',
    ttlMs,
    now
  });
  return readMoodChain(now);
}

function inferTagLabelFromWhy(category, why = '', fallback = '心情微澜') {
  const w = String(why || '');
  if (w.includes('明信片')) return '旅途雀跃';
  if (w.includes('特产')) return w.includes('吃') ? '口齿留香' : '收获满满';
  if (w.includes('大合照')) return '庭院热闹余温';
  if (w.includes('压退') || w.includes('战胜')) return '得胜小骄傲';
  if (w.includes('吃了亏') || w.includes('遭遇了敌手')) return '小有狼狈';
  if (w.includes('陌生的世界')) return '异界惊奇';
  if (w.includes('回到了家')) return '归家安心';
  if (w.includes('庭院')) return '庭院闲适';
  if (w.includes('旅途瞬间')) return category === 'sad' || category === 'angry' ? '旅途小插曲' : '旅途好兴致';
  if (category === 'happy') return '被顺毛的愉悦';
  if (category === 'excited') return '兴致高涨';
  if (category === 'jealous') return '暗自泛酸';
  if (category === 'angry') return '鼓腮帮子赌气';
  if (category === 'sad') return '有点小委屈';
  return fallback;
}

/**
 * 睡眠元气恢复结算。
 * ★ 严格遵守用户定制改动：
 *   · `sleeping === false` 时绝不自然扣减元气，也绝不统计发言条数扣减元气！
 *   · 仅在 `sleeping === true` 时按睡眠时长自然恢复元气。
 */
export function stepFatigue({ sleeping = false, cfg = null, now = Date.now() } = {}) {
  const st = readMoodChain(now);
  if (!sleeping) {
    // 清醒期间不消耗元气，保持恒定
    return st.fatigue;
  }
  const c = moodChainConfig(cfg);
  const from = num(st.vitality.sleptAt || st.vitality.at, now);
  const elapsedHours = Math.max(0, (now - from) / 3600_000);
  if (elapsedHours <= 0.01) return st.fatigue;

  const gain = Math.round(elapsedHours * num(c.vitality?.sleepRecoverPerHour, 22));
  if (gain >= 1) {
    st.vitality.value = clamp(st.vitality.value + gain, 0, 100);
    st.vitality.at = now;
    st.vitality.sleptAt = now;
    st.vitality.why = '睡眠休息恢复';
    writeMoodChain(st, now);
  }
  return st.fatigue;
}

/** 标记入睡 / 睡醒结算 */
export function markFatigueSleep(asleep, now = Date.now()) {
  const st = readMoodChain(now);
  if (asleep) {
    st.vitality.sleptAt = now;
    st.vitality.at = now;
    writeMoodChain(st, now);
    return st.fatigue;
  }
  // 醒来结算：如果睡够了 20 分钟，保底恢复 +25 元气（上限 100），并清除负面小脾气 Tag
  const sleptAt = num(st.vitality.sleptAt, 0);
  if (sleptAt > 0 && now - sleptAt >= 20 * 60_000) {
    const hours = (now - sleptAt) / 3600_000;
    const bonus = Math.max(20, Math.round(hours * 22));
    st.vitality.value = clamp(st.vitality.value + bonus, 0, 100);
    st.vitality.why = '刚睡醒精力恢复';
    st.activeTags = (st.activeTags || []).filter((t) => t.tone !== 'bad');
  }
  st.vitality.sleptAt = 0;
  st.vitality.at = now;
  writeMoodChain(st, now);
  return st.fatigue;
}

export function fatigueFactor(_cfg = null, now = Date.now()) {
  const st = readMoodChain(now);
  return st.vitality.value <= 25 ? 0.7 : 1.0;
}

/**
 * 元气提示词注入块（原 fatigueBlock）：
 * 平时元气充沛时不啰嗦；元气偏低时**只报状态**。
 *
 * ★ 2026-10-25 改（主人的要求）：这一段原来夹带"说话要短、慢半拍、带点揉眼睛"
 *   之类的**表演指令** —— 那是在替她决定"该怎么说话"。现在只留客观数值与原因，
 *   她看到自己累了会自己决定怎么说，不需要提示词教。
 */
export function fatigueBlock(cfg = null, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const st = readMoodChain(now);
  const vit = st.vitality.value;
  const why = st.vitality.why ? `原因：${st.vitality.why}` : '';

  if (vit <= num(c.vitality?.sleepyThreshold, 20)) {
    return `【身体状态】元气 ${vit}/100（精力见底）${why ? `｜${why}` : ''}`;
  }
  if (vit <= num(c.vitality?.lowHintThreshold, 45)) {
    return `【身体状态】元气 ${vit}/100（偏低）${why ? `｜${why}` : ''}`;
  }
  return '';
}

/**
 * 醋意段：同样只报状态。
 * ★ 2026-10-25 改：原来还教"话里可以带点刺或故意撇清关系（'那你去找她聊呀'）"，
 *   那是最典型的"替她演出"。现在只留"心里有点泛酸 + 因为什么"。
 */
export function jealousyTierBlock(_cfg = null, now = Date.now()) {
  const st = readMoodChain(now);
  const jTag = (st.activeTags || []).find((t) => t.category === 'jealous');
  if (!jTag) return '';
  return `【此刻心境】心里有点泛酸：${jTag.why || '看他夸别人'}`;
}

export function currentMood(cfg = null, now = Date.now()) {
  const st = readMoodChain(now);
  const top = (st.activeTags || [])[0];
  if (!top) {
    return { emotion: 'calm', word: '平静', level: 0, why: '' };
  }
  return {
    emotion: top.category,
    word: top.tag,
    level: top.level,
    why: top.why
  };
}

export function moodSnapshot(cfg = null, now = Date.now()) {
  const st = readMoodChain(now);
  const dom = currentMood(cfg, now);
  return {
    scale: 'v4-travel',
    vitality: st.vitality.value,
    vitalityWhy: st.vitality.why,
    activeTags: st.activeTags,
    dominant: dom.level > 0 ? dom : null,
    moods: {
      happy: st.moods.happy.level,
      excited: st.moods.excited.level,
      angry: st.moods.angry.level,
      jealous: st.moods.jealous.level,
      sad: st.moods.sad.level
    },
    fatigue: st.fatigue.value,
    spunk: 0,
    depress: 0,
    satisfaction: st.satisfaction.value
  };
}

// ── 文本与触发辅助 ──────────────────────────────────────────────────────────

export function stripQuoteForMatch(text) {
  let t = String(text ?? '');
  if (!t || !t.includes('[引用')) return t;
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(/\[引用\s[^\]]*(?:\][^\]]*)?\]/g, ' ');
    if (next === t) break;
    t = next;
  }
  return t.replace(/^\s*\]\s*/, '').replace(/\s+/g, ' ').trim();
}

export function isAddressedToSelf(e, { selfNames = [], selfId = '', isPrivate = false } = {}) {
  if (!e || e.self) return false;
  if (isPrivate || e.isAtMe || e.isPoke) return true;
  const raw = String(e.text || '');
  if (!raw) return false;
  if (selfId && raw.includes(`qq=${selfId}`)) return true;
  for (const name of selfNames) {
    if (name && raw.includes(name)) return true;
  }
  return false;
}

function matchTriggerWords(text, wordStr) {
  const clean = stripQuoteForMatch(text);
  if (!clean) return '';
  const words = String(wordStr || '').split(/[\s,，、;；]+/).map((w) => w.trim()).filter(Boolean);
  for (const w of words) {
    if (w && clean.includes(w)) return w;
  }
  return '';
}

/**
 * 观察入站对话：只对明确冲她说的互动（夸奖/贴贴/惹毛/吃醋）挂载轻量具身情境 Tag。
 * 不再跑冷落惩罚（detectNeglect）和吵架加速（spunk）。
 */
export function observeTrigger(entries = [], { cfg = null, ownerQq = '', now = Date.now(), selfNames = [], selfId = '', chatKey = '' } = {}) {
  const c = moodChainConfig(cfg);
  if (!c.enabled || !Array.isArray(entries) || !entries.length) return null;
  const isPrivate = String(chatKey || '').startsWith('private:');
  const addrCtx = { selfNames, selfId, isPrivate };
  const trig = c.mood?.triggers || MOOD_DEFAULTS.mood.triggers;

  for (const e of entries) {
    if (!e || e.self) continue;
    if (c.mood?.requireAddressed !== false && !isAddressedToSelf(e, addrCtx)) continue;
    const senderName = String(e.senderName || e.nickname || e.senderId || '群友').slice(0, 20);
    const isOwner = !!ownerQq && String(e.senderId || '') === String(ownerQq);
    const whoLabel = isOwner ? '主人' : senderName;

    const hitJealous = matchTriggerWords(e.text, trig.jealous);
    if (hitJealous) {
      return pushMoodTag({
        tag: '暗自泛酸',
        tone: 'bad',
        category: 'jealous',
        level: isOwner ? 72 : 55,
        why: `听见${whoLabel}提「${hitJealous}」`,
        source: 'chat',
        ttlMs: 90 * 60_000,
        now
      });
    }

    const hitAngry = matchTriggerWords(e.text, trig.angry);
    if (hitAngry) {
      // 如果对方在凶她，挂小脾气 Tag；若是被顺毛夸奖，会在下面消掉负面 Tag
      return pushMoodTag({
        tag: '鼓腮帮子赌气',
        tone: 'bad',
        category: 'angry',
        level: 65,
        why: `${whoLabel}说了刺耳的话（「${hitAngry}」）`,
        source: 'chat',
        ttlMs: 60 * 60_000,
        now
      });
    }

    const hitHappy = matchTriggerWords(e.text, trig.happy);
    if (hitHappy) {
      // 被夸奖或贴贴时，自动消解身上挂着的赌气/委屈 Tag
      const st = readMoodChain(now);
      st.activeTags = (st.activeTags || []).filter((t) => t.tone !== 'bad');
      writeMoodChain(st, now);
      return pushMoodTag({
        tag: isOwner ? '被主人顺毛的甜意' : '被夸奖的小得意',
        tone: 'good',
        category: 'happy',
        level: isOwner ? 78 : 66,
        why: `${whoLabel}温声互动（「${hitHappy}」）`,
        source: 'chat',
        ttlMs: 120 * 60_000,
        now
      });
    }
  }
  return null;
}

export function selfMoodDelta(text, cfg = null, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const clean = stripQuoteForMatch(text);
  if (!clean) return null;
  if (matchTriggerWords(clean, c.mood?.selfNegateWords)) return null;
  if (/(好开心|太棒了|真好吃|喜欢这里|太美了)/.test(clean)) {
    return { delta: { happy: 8 }, why: { happy: `自己感慨「${clean.slice(0, 24)}」` }, at: now };
  }
  return null;
}

// ── 已退役细碎数值模块的零副作用兼容桩（防止旧脚本或热重载期调用报错）──────
export const DEPRESS_FAIL_HIT = 0;
export function rageDeltaFromEntries() { return null; }
export function rageApplyCap() { return null; }
export function rageBlock() { return ''; }
export function moodDeltaFromEntries() { return null; }
export function detectNeglect() { return null; }
export function applyNeglect() { return null; }
export function spunkFightHit() { return false; }
export function stepSpunk() { return { value: 0, fast: false }; }
export function spunkFactor() { return 1; }
export function spunkBlock() { return ''; }
export function jealousyDeltaFromEntries() { return null; }
export function jealousyReleaseCheck() { return null; }
export function stepDepress() { return { value: 0 }; }
export function depressActive() { return false; }
export function depressMods() { return {}; }
export function depressBlock() { return ''; }
export function stepSatisfaction() { return { value: 65 }; }
export function stepSatisfactionTick() { return { value: 65 }; }
export function satisfactionBlock() { return ''; }
export function applyRecoveryEffect({ fatigue = 0 } = {}, now = Date.now()) {
  if (fatigue < 0) stepVitality(-fatigue, '放松恢复', now);
  return readMoodChain(now);
}
export function applyRecoveryMood(_cfg = null, now = Date.now()) {
  return { before: { satisfaction: 65, depress: 0 }, satisfaction: 70, depress: 0, at: now };
}
export function applySootheRelief(byOwner = false, _cfg = null, now = Date.now()) {
  const st = readMoodChain(now);
  st.activeTags = (st.activeTags || []).filter((t) => t.tone !== 'bad');
  writeMoodChain(st, now);
  return { cleared: true, byOwner };
}
