// travel-sync.js —— 「矩阵庭院 & 跨次元旅行」状态同步与事件直驱器（v2.0）
// ═════════════════════════════════════════════════════════════════════════════
// 核心职责：
//   1. **只读** `skills/travel-whale` 的群存档，将【在途旅行 (trip)】、【在家庭院活动 (homeAct)】、
//      【刚吃完特产余味 (foodAfter)】转化为鲜活的当下提示词与面板快照；
//   2. 将 `travel-whale` 存档中的 `moodEvents` 直接映射为 `mood-chain.js` 的：
//      · 具身情境心境 Tag（带具体事件与地点 `why`）
//      · 元气值（Vitality）增减（如遭遇战消耗元气、吃特产/归家恢复元气）
//   3. ★ 严格遵守方案二定制要求：不做归途体力强制睡眠结算，也不设出发元气门槛拦截。
// ═════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { pickState, phaseOf, worldOf } from './travel-states.js';

const COMPANION_NAMES = {
  fox: '黑发兽耳小狐狸',
  gpt: '小白龙',
  claude: '小书虫',
  gemini: '小猫咪',
  grok: '小魔王',
  kimi: '小月亮',
  qwen: '小折扇'
};

function companionIdOf(trip) {
  return String(trip?.companion || '').trim();
}

function companionNameOf(trip) {
  const written = String(trip?.companionName || '').trim();
  if (written) return written;
  return COMPANION_NAMES[companionIdOf(trip)] || '';
}

export function chatsDir() {
  return path.join(DATA_DIR, 'skills', 'travel-whale', 'chats');
}

export function normalizeChatKey(raw, asGroup = true) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.includes(':')) return s;
  if (s.includes('_')) return s.replace('_', ':');
  return `${asGroup ? 'group' : 'private'}:${s}`;
}

function fileOf(chatKey) {
  const name = String(chatKey).replace(/[:/\\]/g, '_');
  return path.join(chatsDir(), `${name}.json`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function listChatKeys() {
  try {
    const dir = chatsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, '').replace('_', ':'));
  } catch {
    return [];
  }
}

export function humanSpan(ms) {
  const m = Math.max(1, Math.round(Number(ms || 0) / 60000));
  if (m < 60) return `约 ${m} 分钟`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem >= 15 ? `约 ${h} 小时 ${rem} 分钟` : `约 ${h} 小时`;
}

// ── ① 在途旅程读取与提示词拼装 ──────────────────────────────────────────────

export function tripOf(chatKey, now = Date.now()) {
  const key = normalizeChatKey(chatKey);
  if (!key) return null;
  const data = readJson(fileOf(key));
  const trip = data?.trip;
  if (!trip || typeof trip !== 'object') return null;
  const returnAt = Number(trip.returnAt) || 0;
  const departAt = Number(trip.departAt) || 0;
  if (!returnAt || returnAt <= now) return null;

  const cards = Array.isArray(trip.cards) ? trip.cards : [];
  const sentSpots = cards
    .filter((c) => c && c.sent && c.spot)
    .map((c) => String(c.spot).trim())
    .filter(Boolean);

  return {
    chatKey: key,
    country: String(trip.country || '').trim(),
    city: String(trip.city || '').trim(),
    region: String(trip.region || '').trim(),
    group: String(trip.group || '').trim(),
    fiction: !!trip.fiction,
    crossOver: trip.crossOver || null,
    companion: companionIdOf(trip),
    companionName: companionNameOf(trip),
    departAt,
    returnAt,
    leftMs: Math.max(0, returnAt - now),
    elapsedMs: Math.max(0, now - departAt),
    totalMs: Math.max(1, returnAt - departAt),
    weather: String(trip.weather?.name || trip.weather || '').trim(),
    foe: String(trip.foe || '').trim(),
    foeKind: String(trip.foeKind || '').trim(),
    missingTraits: Array.isArray(trip.missingTraits) ? trip.missingTraits : [],
    sentSpots,
    souvenirs: Array.isArray(trip.souvenirs) ? trip.souvenirs : []
  };
}

export function placeOf(trip) {
  if (!trip) return '';
  if (trip.crossOver?.world && trip.crossOver?.place) {
    return `${trip.crossOver.world}·${trip.crossOver.place}`;
  }
  if (trip.country && trip.city && trip.country !== trip.city) {
    return `${trip.country}·${trip.city}`;
  }
  return trip.city || trip.country || '外地';
}

export function activeTrip(rawKeys = [], now = Date.now()) {
  const list = (Array.isArray(rawKeys) ? rawKeys : String(rawKeys || '').split(/[\r\n,，、;；|]+/))
    .map((x) => normalizeChatKey(x))
    .filter(Boolean);
  const keys = list.length ? list : listChatKeys();
  let best = null;
  for (const k of keys) {
    const t = tripOf(k, now);
    if (t && (!best || t.departAt > best.departAt)) best = t;
  }
  return best;
}

export function travelShort(trip, now = Date.now()) {
  if (!trip) return '';
  const place = placeOf(trip);
  const mate = trip.companionName ? `（与${trip.companionName}同行）` : '';
  const st = pickState(trip, now);
  return st?.act
    ? `在${place}${st.act}${mate}`
    : `在${place}旅行中${mate}`;
}

export function travelPublic(trip, now = Date.now()) {
  if (!trip) return null;
  const st = pickState(trip, now);
  return {
    place: placeOf(trip),
    country: trip.country,
    city: trip.city,
    companion: trip.companion,
    companionName: trip.companionName,
    weather: trip.weather,
    phase: phaseOf(trip, now),
    world: worldOf(trip),
    act: st?.act || '',
    detail: st?.detail || '',
    leftText: humanSpan(trip.leftMs),
    returnAt: trip.returnAt
  };
}

export function travelFactLine(trip) {
  if (!trip) return '';
  const place = placeOf(trip);
  const mate = trip.companionName ? `，身边是同行旅伴「${trip.companionName}」` : '（独自出行）';
  return `【行程事实】你眼下人正在「${place}」旅行${mate}。`;
}

export function travelPromptText(trip, now = Date.now()) {
  if (!trip) return null;
  const place = placeOf(trip);
  const mate = trip.companionName ? `，和「${trip.companionName}」一起` : '（独自一人）';
  const weather = trip.weather ? `，当地天气是「${trip.weather}」` : '';
  const left = humanSpan(trip.leftMs);
  const st = pickState(trip, now);
  const doing = st?.act
    ? `此刻你正${st.act}${st.detail ? `（${st.detail}）` : ''}。`
    : '此刻你正在当地边走边看。';
  const visited = trip.sentSpots?.length
    ? `这趟已经去过并寄过明信片的地方：${trip.sentSpots.join('、')}。`
    : '这趟刚出发不久，还没寄出第一张明信片（别提前把没去过的景点说成已经逛完了）。';

  return `【自身状态·在路上】你现在不在家，人正在「${place}」旅行${mate}${weather}，距离回程还有${left}。\n`
    + `· 当下切片：${doing}\n`
    + `· 行程进度：${visited}\n`
    + '· 语气纪律：把旅途的现场感自然带进聊天里（比如顺口提一嘴手头正在做的事或身边的旅伴），但别像导游背说明书。';
}

// ── ② 在家庭院活动读取与提示词拼装 ──────────────────────────────────────────

export function homeOf(chatKey, now = Date.now()) {
  const key = normalizeChatKey(chatKey);
  if (!key) return null;
  const data = readJson(fileOf(key));
  if (!data || typeof data !== 'object') return null;
  // 如果正在旅行中，则不在庭院
  if (data.trip && Number(data.trip.returnAt) > now) return null;
  const ha = data.homeAct;
  if (!ha || !ha.act) return null;
  return {
    chatKey: key,
    act: String(ha.act || '').trim(),
    detail: String(ha.detail || '').trim(),
    mates: Array.isArray(ha.mates) ? ha.mates : [],
    at: Number(ha.at) || now
  };
}

export function homeShort(home) {
  if (!home || !home.act) return '';
  return `在庭院里${home.act}`;
}

export function homePublic(home, _now = Date.now()) {
  if (!home) return null;
  return {
    act: home.act,
    detail: home.detail,
    mates: home.mates,
    at: home.at
  };
}

export function homePromptText(home, _now = Date.now()) {
  if (!home || !home.act) return null;
  const mates = home.mates?.length ? `（院子里一起的有：${home.mates.join('、')}）` : '';
  return `【自身状态·在庭院】你这会儿没出远门，人待在自家矩阵庭院里，正${home.act}${mates}`
    + `${home.detail ? `——${home.detail}` : ''}。聊天时带着在家放松的闲适感即可，不用每句都刻意汇报。`;
}

// ── ③ 旅途与庭院事件 → 元气 (Vitality) & 具身情境 Tag 映射表 ────────────────
//
// ⚠️ key 集合严格保持与 `skills/travel-whale` 及 `skills/qqzone` 同步（共 16 种）。
// 每个事件定义：
//   · label:         中文原因描述（生成 `why`）
//   · tag:           挂载的具身情境 Tag 名称
//   · tone:          'good' | 'bad' | 'mixed'
//   · category:      投影到五维的槽位 ('happy' | 'excited' | 'angry' | 'sad')
//   · vitalityDelta: 对元气值的直接影响（正数回元气，负数耗元气）
//   · ttlMin:        该情境余味持续多少分钟
//   · delta / satisfaction: 兼容旧探针字段
export const TRAVEL_EVENT_MOOD = {
  'rare-card': {
    label: '寄回一张稀有的明信片',
    tag: '旅途雀跃', tone: 'good', category: 'excited',
    vitalityDelta: 5, ttlMin: 240,
    delta: { happy: 14, excited: 18 }, satisfaction: 5
  },
  'rare-souvenir': {
    label: '带回了一件稀有特产',
    tag: '收获满满', tone: 'good', category: 'happy',
    vitalityDelta: 5, ttlMin: 240,
    delta: { happy: 16, excited: 6 }, satisfaction: 6
  },
  'home-photo': {
    label: '在庭院里和大家拍了张大合照',
    tag: '庭院热闹余温', tone: 'good', category: 'happy',
    vitalityDelta: 8, ttlMin: 240,
    delta: { happy: 22, excited: 8 }, satisfaction: 6
  },
  'trip-home': {
    label: '平平安安回到了家',
    tag: '归家安心', tone: 'good', category: 'happy',
    vitalityDelta: 10, ttlMin: 180,
    delta: { happy: 8 }, satisfaction: 3
  },
  'battle-card': {
    label: '在路上遭遇了敌手',
    tag: '遭遇战挂彩', tone: 'bad', category: 'angry',
    vitalityDelta: -10, ttlMin: 150,
    delta: { happy: -8, sad: 16, angry: 10 }, satisfaction: -8
  },
  'battle-win': {
    label: '在路上压退了敌手',
    tag: '得胜小骄傲', tone: 'good', category: 'excited',
    vitalityDelta: -5, ttlMin: 180, // 打赢了很得意，但战斗本身也消耗一点体力
    delta: { happy: 10, excited: 6 }, satisfaction: 2
  },
  'battle-lose': {
    label: '在路上吃了亏',
    tag: '小有狼狈', tone: 'bad', category: 'sad',
    vitalityDelta: -14, ttlMin: 180,
    delta: { happy: -12, sad: 12, angry: 16 }, satisfaction: -10
  },
  'event-good': {
    label: '路上遇上了好事',
    tag: '旅途小确幸', tone: 'good', category: 'happy',
    vitalityDelta: 6, ttlMin: 180,
    delta: { happy: 8, excited: 5 }, satisfaction: 3
  },
  'event-bad': {
    label: '路上遇上了麻烦事',
    tag: '旅途小郁闷', tone: 'bad', category: 'sad',
    vitalityDelta: -8, ttlMin: 150,
    delta: { happy: -7, sad: 10, angry: 6 }, satisfaction: -6
  },
  crossover: {
    label: '被丢到了一个完全陌生的世界',
    tag: '异界惊奇', tone: 'mixed', category: 'excited',
    vitalityDelta: -8, ttlMin: 210,
    delta: { happy: -12, excited: 14, sad: 10 }, satisfaction: -6
  },
  flop: {
    label: '这张明信片答非所问、翻了车',
    tag: '明信片翻车嘴硬', tone: 'bad', category: 'angry',
    vitalityDelta: -4, ttlMin: 120,
    delta: { angry: 8, happy: -6 }, satisfaction: -5
  },
  'souvenir-eat': {
    label: '把带回来的特产吃掉了',
    tag: '口齿留香', tone: 'good', category: 'happy',
    vitalityDelta: 12, ttlMin: 150,
    delta: { happy: 6 }, satisfaction: 2
  },
  'souvenir-gift': {
    label: '把带回来的特产送给了别人',
    tag: '分享的愉悦', tone: 'good', category: 'happy',
    vitalityDelta: 4, ttlMin: 180,
    delta: { happy: 10, excited: 4 }, satisfaction: 3
  },
  'souvenir-plant': {
    label: '把特产种进了菜地',
    tag: '种地的期待', tone: 'good', category: 'excited',
    vitalityDelta: 3, ttlMin: 150,
    delta: { happy: 5, excited: 6 }, satisfaction: 2
  },
  'souvenir-harvest': {
    label: '亲手种出了收成',
    tag: '丰收雀跃', tone: 'good', category: 'happy',
    vitalityDelta: 8, ttlMin: 210,
    delta: { happy: 12, excited: 8 }, satisfaction: 4
  },
  'home-act': {
    label: '在庭院里做了一阵小事',
    tag: '庭院闲适', tone: 'good', category: 'happy',
    vitalityDelta: 5, ttlMin: 120,
    delta: {}
  }
};

// ── ④ 「刚吃完」特产余味（只读 state.foodAfter）────────────────────────────

export function foodAfterOf(chatKey, now = Date.now()) {
  const raw = readJson(fileOf(normalizeChatKey(chatKey)));
  const fa = raw?.foodAfter;
  if (!fa || !fa.name) return null;
  if (!(Number(fa.until) > Number(now))) return null;
  return fa;
}

const AFTER_LEFT_TEXT = {
  common: '再过几分钟就散了',
  uncommon: '还得持续小一阵',
  rare: '这个劲儿要顶好一阵'
};

const AFTER_TONE = {
  drink: '酒劲正慢慢上来。这轮**至少挑一两样**做出来（别全上、也别一样都不做）：'
    + '① 句子比平时松、比平时长，中间带"……"的停顿；'
    + '② 冷不丁笑一下，或者把话说岔了再自己拽回来；'
    + '③ 嘴上硬撑"我没醉""这点算什么"，但小动作已经不利索；'
    + '④ 想赖着人多扯两句，情绪比平时外放。'
    + '★ 是"有点上头、很放松"，**不是烂醉** —— 别瘫、别语无伦次到看不懂。',
  spicy: '嘴里还在烧。这轮**至少挑一两样**做出来：'
    + '① 句子被吸气声打断："呼……""嘶——""嗬……"；'
    + '② 说两句就去够水，边喝边嘴硬"不辣，真不辣"；'
    + '③ 被逗到会更急，回话变短、连着发。'
    + '★ 是"辣得直吸气但死要面子"，别一直喊辣、也别整句只剩"呼嗬"。',
  sweet: '嘴里还是甜的。这轮**至少挑一两样**做出来：'
    + '① 句尾带上笑意（"嗯……""挺好的呀"这种软收尾）；'
    + '② 对亲近的人格外没抵抗力，被夸就顺着答；'
    + '③ 不自觉地再提一句刚才那口东西。'
    + '★ 别撒娇过头，也别自夸"我好开心"。',
  tea: '喉咙里留着回甘。这轮**至少挑一两样**做出来：'
    + '① 回话慢半拍，先"嗯……"再答；'
    + '② 用词比平时工整一点，不急不躁；'
    + '③ 回味一句"苦过之后才回甜"这类话（点到为止）。'
    + '★ 别掉书袋、别突然文绉绉。',
  staple: '这会儿是**真的饱**。这轮**至少挑一两样**做出来：'
    + '① 句子变短、动作变少 —— 能用三个字就别用一整句；'
    + '② 会念叨"不想动了""让我坐会儿""撑"；'
    + '③ 被叫去做什么，先讨价还价一句。'
    + '★ 心情是好的，只是懒得使劲 —— 别演成丧。',
  other: '味道还留在嘴里 —— 偶尔顺口提一句它就好，别刻意。'
};

export function foodAfterPromptText(fa, now = Date.now()) {
  if (!fa || !fa.name) return null;
  if (!(Number(fa.until) > Number(now))) return null;
  const flavor = String(fa.flavor || '');
  const verb = (flavor === 'drink' || flavor === 'tea') ? '喝' : '吃';
  const left = AFTER_LEFT_TEXT[String(fa.tier || '')] || AFTER_LEFT_TEXT.common;
  const tone = AFTER_TONE[flavor] || AFTER_TONE.other;
  return `【自身状态·刚吃完】你刚${verb}了「${fa.name}」，${left}。${tone}`
    + ' 这是**身体上**的状态（不是心情）—— 渗进语气里就行，'
    + '**别直接宣布它**（别说"我现在醉了""我好饱"这类），也别每句都点。';
}

export function toneOfEvent(kind) {
  const d = TRAVEL_EVENT_MOOD[String(kind || '')];
  if (!d) return '';
  return d.tone === 'good' ? 'good' : (d.tone === 'bad' ? 'bad' : '');
}

export function eventWhy(ev) {
  const d = TRAVEL_EVENT_MOOD[String(ev?.kind || '')];
  if (!d) return '';
  const where = String(ev?.where || '').trim();
  const n = Number(ev?.n) || 0;
  return `${n > 1 ? `${d.label} ×${n}` : d.label}${where ? `（${where}）` : ''}`;
}

const MOOD_CURSOR_FILE = 'sleep-mood-travel-events.json';

export function readMoodCursor() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, MOOD_CURSOR_FILE), 'utf8'));
    return { at: Number(j?.at) || 0, ids: Array.isArray(j?.ids) ? j.ids.map(String) : [] };
  } catch { return { at: 0, ids: [] }; }
}

export function writeMoodCursor(c) {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, MOOD_CURSOR_FILE),
      JSON.stringify({ at: Number(c?.at) || 0, ids: (c?.ids || []).map(String) }, null, 2)
    );
    return true;
  } catch { return false; }
}

const MOOD_EVENT_MAX_APPLY = 12;

export function newTravelEvents(rawKeys = [], cursor = null, _now = Date.now()) {
  const cur = cursor && typeof cursor === 'object'
    ? { at: Number(cursor.at) || 0, ids: (cursor.ids || []).map(String) }
    : readMoodCursor();
  const list = (Array.isArray(rawKeys) ? rawKeys : String(rawKeys || '').split(/[\r\n,，、;；|]+/))
    .map((x) => normalizeChatKey(x)).filter(Boolean);
  const keys = list.length ? list : listChatKeys();

  const pool = [];
  for (const k of keys) {
    const data = readJson(fileOf(k));
    if (!data || !Array.isArray(data.moodEvents)) continue;
    for (const e of data.moodEvents) {
      const at = Number(e?.at) || 0;
      const id = String(e?.id || '');
      if (!at || !id || !TRAVEL_EVENT_MOOD[String(e?.kind || '')]) continue;
      if (at < cur.at) continue;
      if (at === cur.at && cur.ids.includes(id)) continue;
      pool.push({
        id,
        at,
        kind: String(e.kind),
        where: String(e.where || ''),
        foe: String(e.foe || ''),
        n: Number(e.n) || 0,
        who: String(e.who || ''),
        deltas: (e.deltas && typeof e.deltas === 'object' && !Array.isArray(e.deltas)) ? e.deltas : null
      });
    }
  }
  pool.sort((a, b) => (a.at - b.at) || a.id.localeCompare(b.id));

  let at = cur.at;
  let ids = [...cur.ids];
  for (const e of pool) {
    if (e.at > at) { at = e.at; ids = [e.id]; }
    else if (e.at === at && !ids.includes(e.id)) ids.push(e.id);
  }
  return { events: pool.slice(-MOOD_EVENT_MAX_APPLY), cursor: { at, ids }, total: pool.length };
}
