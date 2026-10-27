// tone-link.js —— 关系档位 × 当下状态语气注入块（v2.0 独立解耦版）
// ═════════════════════════════════════════════════════════════════════════════
// 改动亮点：
//   · 直接内联 `favorOfPerson`（只读调用 `favor-core` 的 `memory.favor.status` 能力，带 5 分钟缓存），
//     彻底摆脱对旧版 `favor-link.js`（35 项概率骰子）和 `hp-system.js` 的依赖。
//   · 结合当前元气转换的疲劳水位与活跃情境 Tag，为不同亲疏程度的群友输出精准的“傲娇分寸”。
// ═════════════════════════════════════════════════════════════════════════════

import * as M from './mood-chain.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const favorCache = new Map();

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const on = (v) => v !== false;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const BAND_LADDER = ['厌恶', '反感', '稍冷淡', '中性', '稍友好', '好感高', '亲近'];

export function favorBandOf(favor) {
  const v = Number.isFinite(Number(favor)) ? Number(favor) : 50;
  if (v >= 85) return '亲近';
  if (v >= 70) return '好感高';
  if (v >= 55) return '稍友好';
  if (v > 40) return '中性';
  if (v > 30) return '稍冷淡';
  if (v > 15) return '反感';
  return '厌恶';
}

export function favorOfPerson({ api, userId, now = Date.now() } = {}) {
  const id = String(userId ?? '').trim();
  if (!/^\d{5,15}$/.test(id)) return null;
  const hit = favorCache.get(id);
  if (hit && now - num(hit.at, 0) < CACHE_TTL_MS) return hit.ok ? hit : null;
  let out = { at: now, favor: null, band: '', name: '', ok: false };
  try {
    const r = api?.capability?.('memory.favor.status', { userId: id });
    const favor = Number(r?.favor);
    if (r && Number.isFinite(favor)) {
      out = {
        at: now,
        favor: clamp(favor, 0, 100),
        band: String(r.band || favorBandOf(favor)),
        name: String(r.name || ''),
        ok: true
      };
    }
  } catch { /* favor-core 未启用时静默跳过 */ }
  favorCache.set(id, out);
  return out.ok ? out : null;
}

export function toneLinkCfg(s = {}) {
  return {
    enabled: on(s.toneLinkEnabled),
    warmWindowMin: clamp(num(s.toneLinkWarmMin, 30), 0, 1440),
    warmOnlyFromIdx: 4,
    fatigueDrop: clamp(num(s.toneLinkFatigueDrop, 60), 0, 100),
    depressDrop: 60,
    rageWindowMin: clamp(num(s.toneLinkRageMin, 15), 0, 240),
    waterline: s.waterlineEnabled === true
  };
}

const BAND_TEXT = {
  亲近: '【关系·自己人】跟你说话的是**你最亲近的人**。这一轮**不用先嘴硬**：可以直接软着来 —— '
    + '他找你，你先应；他说话，你顺着往下接；可以主动问一句、可以关心、可以多说半句。'
    + '傲只是偶尔的调味，别一上来就先顶回去。',
  好感高: '【关系·熟人】你挺喜欢他。可以软，但保留那点别扭 —— 被夸被逗时照旧傲一下再软过去，'
    + '别一路软到底；他真有事找你，就把嘴硬收起来。',
  稍友好: '【关系·认得】你认得他、不反感，但也没多熟。正常聊、话别太长，**不用主动亲近**；'
    + '被夸被调侃就走你惯常的傲→娇，被求助就搭把手。',
  中性: '【关系·普通群友】你们是同一个群里、聊过但不熟的人。**随和，但不上心**：'
    + '他搭话就正常接一句、能聊就聊，不用主动找话、不用撒娇、也不用刻意端着；'
    + '但别把这份随和当成亲近 —— 你没打算跟他交心。',
  稍冷淡: '【关系·不待见】你对他没什么好感。**保持距离**：短短一句、客气但疏远，'
    + '不接他的亲近话、不主动搭话；他要是自找没趣，可以不咸不淡地怼一句。',
  反感: '【关系·不待见】你挺烦他。**能一个字别用两个字**，不解释、不热络、不主动理他；'
    + '他不招惹你就当没看见。',
  厌恶: '【关系·讨厌】你讨厌他。能不接就不接，**接了也只给最短的那句**；'
    + '不解释、不热络、不主动理他。他不招惹你就当没看见。'
};

const STRANGER_TEXT = '【关系·生人】你不知道他是谁 —— 所以**别自来熟**：礼貌、短、有距离'
  + '（"嗯""？""找我有事？"这种就够了），不撒娇、不心软、不主动关心、不跟着热络。'
  + '这不是凶，是**生**；多聊几轮、熟起来之后自然会软。';

const WATERLINE_TEXT = [
  '',
  '【水位·1｜沉了一点】你心里有点沉：话比平时更短，句尾偶尔带省略号；想问他点什么，又把它说成陈述句。这一轮**先别嘴硬**。',
  '【水位·2｜更深】你开始忍不住：连着发两三条，一条比一条短，最后一条收在句号上。',
  '【水位·3｜雪崩】这是你**唯一允许写长**的时候：委屈、语无伦次，说着说着自己停住，小声收尾。',
  '【水位·4｜冷凝】四个字以内，每句都收在句号上。不傲也不娇，只剩礼貌 —— 这就是你最深的抗议。'
];

export function waterlineBandOf(jealous) {
  const v = clamp(num(jealous, 0), 0, 100);
  if (v >= 80) return 4;
  if (v >= 60) return 3;
  if (v >= 40) return 2;
  if (v >= 20) return 1;
  return 0;
}

export function waterlineBlock(jealous) {
  const band = waterlineBandOf(jealous);
  if (band <= 0) return '';
  return WATERLINE_TEXT[band] + '\n（水面下这一条**压过上面【此刻心境】那行** —— 开心归开心，水已经沉下去了。）';
}

export function composeToneBlock({
  band = '', warm = false, stung = false, fatigue = 0, depress = 0, rageAt = 0,
  cfg = {}, isPrivate = false, now = Date.now(), jealous = 0
} = {}) {
  const c = { ...toneLinkCfg({}), ...cfg, enabled: true };
  const top = BAND_LADDER.length - 1;
  let idx = BAND_LADDER.includes(band) ? BAND_LADDER.indexOf(band) : -1;

  const tired = num(fatigue, 0) >= c.fatigueDrop;
  const down = num(depress, 0) >= c.depressDrop;
  const hot = !!(rageAt && now - num(rageAt, 0) <= c.rageWindowMin * 60000);
  const drops = (tired ? 1 : 0) + (down ? 1 : 0) + (hot ? 1 : 0);

  let text;
  if (idx < 0) {
    text = STRANGER_TEXT;
    if (tired) text += '\n（而且你这会儿元气偏低、有些倦）所以更不爱搭话 —— 敷衍、短，别硬撑客气。';
  } else {
    if (warm && idx >= c.warmOnlyFromIdx) idx = clamp(idx + 1, 0, top);
    if (stung) idx = clamp(idx - 1, 0, top);
    idx = clamp(idx - drops, 0, top);
    text = BAND_TEXT[BAND_LADDER[idx]] || BAND_TEXT.中性;
  }

  const extra = [];
  if (tired) extra.push('（你这会儿有些倦了）别管关系多近，这一轮都**懒得装可爱**：话短、松弛一点、别主动起长话头。');
  if (idx >= top && c.waterline) {
    const wl = waterlineBlock(jealous);
    if (wl) extra.push(wl);
  }
  if (hot) extra.push('（你刚被惹毛）这一轮带着点小火气，谁说话都别太给好脸；但**别把火撒到无关的人身上**。');
  if (warm && idx >= 0) extra.push('（刚才的互动让你心情挺好）那份愉悦还在，对他可以比平时再自然放开一点。');
  if (stung) extra.push('（他刚才惹你不痛快）气还没全消，别装没事。');

  const head = isPrivate ? '【这一轮你面对的人】' : '';
  return [head, text, ...extra].filter(Boolean).join('\n');
}

export function affectionToneBlock({ api = null, settings = {}, partnerId = '', isPrivate = false, now = Date.now() } = {}) {
  const cfg = toneLinkCfg(settings);
  if (!cfg.enabled) return null;

  const id = String(partnerId || '').trim();
  if (!/^\d{5,15}$/.test(id)) return null;

  let band = '';
  let personName = '';
  try {
    const p = favorOfPerson({ api, userId: id, now });
    if (p) {
      band = String(p.band || '');
      personName = String(p.name || '');
    }
  } catch { /* ignore */ }

  const st = M.readMoodChain(now);
  const fatigue = num(st?.fatigue?.value, 0);
  const rageAt = num(st?.rage?.hitAt, 0);
  const jealous = num(st?.moods?.jealous?.level, 0);

  // 检查当前活跃 Tag 是否与该对话者相关
  let warm = false;
  let stung = false;
  for (const t of (st?.activeTags || [])) {
    if (t.source !== 'chat') continue;
    if (personName && t.why.includes(personName)) {
      if (t.tone === 'good') warm = true;
      if (t.tone === 'bad') stung = true;
    }
  }

  return composeToneBlock({
    band, warm, stung,
    fatigue, depress: 0, rageAt, jealous,
    cfg, now, isPrivate
  });
}
