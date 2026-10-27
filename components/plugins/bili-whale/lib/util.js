// bili-whale / util.js
//
// 纯函数与设置解析层。刻意**不 import 任何宿主核心模块**（不碰 fs / 子进程），
// 这样整目录复制到任何 QQ Agent 0.4+ 实例都能加载，热插拔、可分享。
//
// 约定：
//   · 所有设置都从 api.config() 读（宿主把 manifest.settings 与用户配置合并好了）；
//   · 所有时间都按设置里的 timeZone 解释，留空用本机时区；
//   · 日志和数据里永远不打印 cookie。

/** manifest.settings 的内置兜底（第三道保险：api.config 拿不到时仍能跑）。 */
export const DEFAULT_SETTINGS = {
  enabled: false,
  ownerQQ: '',
  ownerBiliMid: '',
  ownerBiliName: '',
  notifyChat: '',
  sessdata: '',
  biliJct: '',
  buvid3: '',
  likeKeywords: 'AI 工具与插件\n鬼畜与怀旧向剪辑\n猫咪\nLive2D/模型',
  dislikeKeywords: '带货\n擦边\n标题党\n纯搬运',
  windows: '20:00-24:00:1',
  skipChance: 0.3,
  maxWakesPerDay: 3,
  maxVideos: 5,
  deepReadCount: 3,
  shareEnabled: true,
  // ★★ 2026-10-24「评论视频模式」（用户口径）：默认在视频下留一条**公开评论**；
  // 填 'share' 才回到老的「@主人 + 三连」。两种模式共用同一本额度账。
  postMode: 'comment',
  shareDaily: 3,
  shareMinScore: 13,
  // [[triple]] 三连（2026-10-22）：分享时**同时**点赞 + 收藏，评论里把这三件事说出来。
  // 关掉 = 回到老行为（只发评论）。开着时三件事是一个原子动作：
  // 点赞/收藏回读核验不过，就整轮不发评论（宁可少发，也不让评论说谎）。
  tripleOnShare: true,
  // ★★ 2026-10-24「赞不赞由她自己决定」：动手之前先问一句（一次小调用，低温度）。
  // 关掉 = 回到 10-22 的无条件三连（分享就赞+收）。
  reactTriple: true,
  // ★★ 2026-10-24「官方 AI 总结」：把 B 站的 AI 总结当**定向**素材塞进提示词。
  // 它不是每条都有（未登录 / 没生成过都会空），取不到就当没有，不影响主流程。
  officialSummary: true,
  // 收藏夹名（留空 = 用「我创建的收藏夹」里那个默认的）
  favFolderName: '',
  sameVideoDays: 7,
  oncePerPerson: true,
  silentAfterDays: 3,
  silentStopDays: 7,
  diaryEnabled: true,
  diaryKeepDays: 30,
  listenComment: true,
  listenIntervalSec: 300,
  listenAllDay: false,
  listenScope: 'both',
  listenOnlyOwner: false,
  autoReplyOwner: true,
  autoReplyOthers: false,
  liveEnabled: false,
  liveRoom: '',
  liveScope: 'owner',
  liveIntervalSec: 12,
  llmMode: 'auto',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  llmTemperature: 0.9,
  llmMaxTokens: 1200,
  // ── 看视频（原生视频输入，2026-10-21）：把画面+声音整段交给全模态模型 ──
  watchEnabled: true,
  watchSlices: 2,
  watchSec: 12,
  watchModel: '',
  // ── 看视频第三层兜底（2026-10-21）：基元律动 tokenrhythm.studio ──
  // 实测该网关只有 seed-2.1-pro / minimax-m3.1-flash 能吃 video 部件，
  // 且**都不吃音频**（audio/file 直接 MODEL_CAPABILITY_NOT_SUPPORTED），
  // 所以这一层只挂在看视频上，不进听觉通道表。
  watchThirdBaseUrl: '',
  watchThirdApiKey: '',
  watchThirdModel: '',
  // 时长闸（2026-10-22）：超过这个时长的片子只翻字幕/弹幕/热评，不调多模态看画面。
  // 理由不是省钱，是"会不会点开"：人刷视频不会点开 2 小时的直播回放。0 = 不限。
  maxWatchMinutes: 60,
  // ── 动态（2026-10-21）：读首页 + 发动态 ──
  postEnabled: false,
  postDailyMax: 2,
  // ── 听觉（2026-10-21 新增）：把视频音频抽样送进全模态模型 ──
  hearingEnabled: false,
  hearingSlices: 3,
  hearingSliceSec: 28,
  hearingModel: 'gemini-3.8-flash',
  hearingBaseUrl: '',
  hearingApiKey: '',
  hearingFfmpeg: '',
  hearingOnlyWhenThin: true,
  hearingMinSubtitle: 300,
  hearingBackupBaseUrl: '',
  hearingBackupApiKey: '',
  hearingBackupModel: 'qwen3.8-omni-flash',
  notifyOnShare: true,
  notifyOnDiary: true,
  // 把每轮"刷了什么/写了什么"写进她自己的历史（只记账、不发送）
  rememberInHistory: true,
  notifyOnMention: true,
  notifyOnError: true,
  maxNotifyPerDay: 12,
  onebotHttpUrl: '',
  onebotHttpToken: '',
  timeZone: '',
  dryRun: false,
  personaSource: 'host',
  personaCard: '',
  personaInheritChat: '',
  personaText: '',
  personaExtra: '',
  personaMaxChars: 6000,
  personaName: '',
  ownerTitle: '你',
  selfClaim: '我'
};

const clamp = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/**
 * 一句话的"开头指纹"：去掉 @某人 前缀与所有标点/空白，取前 n 字。
 * 用途：分享评论的同质化自检 —— 不靠模型自觉，靠这个真比对。
 * 两侧（写评论的 analyze.js、发出去的 runtime.js）必须用同一个函数，
 * 否则"自己觉得撞了"和"实际撞了"会各算一套。
 */
export function textHead(text, n = 6) {
  return String(text || '')
    .replace(/^@\S+\s*/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .slice(0, Math.max(1, n));
}

export function asLines(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x ?? '').trim()).filter(Boolean);
  }
  return String(value ?? '')
    .split(/[\r\n,，;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitKeywords(value) {
  return String(value ?? '')
    .split(/[\r\n,，;；|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 24);
}

/** 读设置并做范围收敛。每次调用都重新读，保存设置后立刻生效。 */
export function settings(api) {
  let raw = {};
  try { raw = api?.config?.() || {}; } catch { raw = {}; }
  const s = { ...DEFAULT_SETTINGS, ...raw };
  s.enabled = s.enabled === true;
  s.ownerQQ = String(s.ownerQQ ?? '').split(/[,，;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{4,15}$/.test(x));
  s.ownerBiliMid = String(s.ownerBiliMid ?? '').replace(/\D/g, '');
  s.ownerBiliName = String(s.ownerBiliName ?? '').trim();
  s.notifyChat = String(s.notifyChat ?? '').trim();
  s.sessdata = String(s.sessdata ?? '').trim();
  s.biliJct = String(s.biliJct ?? '').trim();
  s.buvid3 = String(s.buvid3 ?? '').trim();
  s.likeKeywords = splitKeywords(s.likeKeywords);
  s.dislikeKeywords = splitKeywords(s.dislikeKeywords);
  s.windows = String(s.windows ?? '').trim();
  s.skipChance = clamp(s.skipChance, 0, 0.95, 0.3);
  s.maxWakesPerDay = Math.round(clamp(s.maxWakesPerDay, 0, 12, 3));
  s.maxVideos = Math.round(clamp(s.maxVideos, 1, 20, 5));
  s.deepReadCount = Math.round(clamp(s.deepReadCount, 1, 8, 3));
  s.shareEnabled = s.shareEnabled !== false;
  // ★ 2026-10-24：只认 'share'，其它一律当 'comment'（默认模式，写错也不会跑回旧行为）
  s.postMode = s.postMode === 'share' ? 'share' : 'comment';
  s.shareDaily = Math.round(clamp(s.shareDaily, 0, 20, 3));
  s.shareMinScore = Math.round(clamp(s.shareMinScore, 0, 20, 13));
  s.tripleOnShare = s.tripleOnShare !== false;
  // ★ 2026-10-24：两个新开关都是"默认开"，只有显式 false 才关
  s.reactTriple = s.reactTriple !== false;
  s.officialSummary = s.officialSummary !== false;
  s.favFolderName = String(s.favFolderName ?? '').trim().slice(0, 40);
  s.sameVideoDays = Math.round(clamp(s.sameVideoDays, 1, 90, 7));
  s.oncePerPerson = s.oncePerPerson !== false;
  s.silentAfterDays = Math.round(clamp(s.silentAfterDays, 1, 90, 3));
  s.silentStopDays = Math.round(clamp(s.silentStopDays, 2, 180, 7));
  s.diaryEnabled = s.diaryEnabled !== false;
  s.diaryKeepDays = Math.round(clamp(s.diaryKeepDays, 1, 90, 30));
  s.listenComment = s.listenComment !== false;
  s.listenIntervalSec = Math.round(clamp(s.listenIntervalSec, 60, 3600, 300));
  s.listenAllDay = s.listenAllDay === true;
  s.listenScope = ['both', 'reply', 'at'].includes(String(s.listenScope)) ? String(s.listenScope) : 'both';
  s.listenOnlyOwner = s.listenOnlyOwner === true;
  s.autoReplyOwner = s.autoReplyOwner !== false;
  s.autoReplyOthers = s.autoReplyOthers === true;
  s.liveEnabled = s.liveEnabled === true;
  s.liveRoom = String(s.liveRoom ?? '').replace(/\D/g, '');
  s.liveScope = String(s.liveScope) === 'mention' ? 'mention' : 'owner';
  s.liveIntervalSec = Math.round(clamp(s.liveIntervalSec, 5, 300, 12));
  s.llmMode = ['auto', 'capability', 'own', 'off'].includes(String(s.llmMode)) ? String(s.llmMode) : 'auto';
  s.llmBaseUrl = String(s.llmBaseUrl ?? '').trim().replace(/\/+$/, '');
  s.llmApiKey = String(s.llmApiKey ?? '').trim();
  s.llmModel = String(s.llmModel ?? '').trim();
  s.llmTemperature = clamp(s.llmTemperature, 0, 2, 0.9);
  s.llmMaxTokens = Math.round(clamp(s.llmMaxTokens, 128, 8000, 1200));
  // 看视频：单段必须短（实测 12 秒稳、25 秒网关 502）
  s.watchEnabled = s.watchEnabled !== false;
  s.watchSlices = Math.round(clamp(s.watchSlices, 1, 4, 2));
  s.watchSec = Math.round(clamp(s.watchSec, 6, 14, 12));
  s.watchModel = String(s.watchModel ?? '').trim();
  s.watchThirdBaseUrl = String(s.watchThirdBaseUrl ?? '').trim();
  s.watchThirdApiKey = String(s.watchThirdApiKey ?? '').trim();
  s.watchThirdModel = String(s.watchThirdModel ?? '').trim();
  // 时长闸：0 = 不限，上限 600 分钟（防手滑多打一个 0）
  s.maxWatchMinutes = Math.round(clamp(s.maxWatchMinutes, 0, 600, 60));
  s.postEnabled = s.postEnabled === true;
  s.postDailyMax = Math.round(clamp(s.postDailyMax, 0, 10, 2));
  // 听觉：段数/每段秒数都收紧到"网关能一次吃完"的范围（实测 >30 秒易 502）
  s.hearingEnabled = s.hearingEnabled === true;
  s.hearingSlices = Math.round(clamp(s.hearingSlices, 1, 6, 3));
  s.hearingSliceSec = Math.round(clamp(s.hearingSliceSec, 15, 45, 28));
  s.hearingModel = String(s.hearingModel ?? '').trim();
  s.hearingBaseUrl = String(s.hearingBaseUrl ?? '').trim().replace(/\/+$/, '');
  s.hearingApiKey = String(s.hearingApiKey ?? '').trim();
  s.hearingFfmpeg = String(s.hearingFfmpeg ?? '').trim();
  s.hearingOnlyWhenThin = s.hearingOnlyWhenThin !== false;
  s.hearingMinSubtitle = Math.round(clamp(s.hearingMinSubtitle, 0, 5000, 300));
  s.hearingBackupBaseUrl = String(s.hearingBackupBaseUrl ?? '').trim().replace(/\/+$/, '');
  s.hearingBackupApiKey = String(s.hearingBackupApiKey ?? '').trim();
  s.hearingBackupModel = String(s.hearingBackupModel ?? '').trim();
  s.notifyOnShare = s.notifyOnShare !== false;
  s.notifyOnDiary = s.notifyOnDiary !== false;
  s.rememberInHistory = s.rememberInHistory !== false;
  s.notifyOnMention = s.notifyOnMention !== false;
  s.notifyOnError = s.notifyOnError !== false;
  s.maxNotifyPerDay = Math.round(clamp(s.maxNotifyPerDay, 0, 100, 12));
  s.onebotHttpUrl = String(s.onebotHttpUrl ?? '').trim().replace(/\/+$/, '');
  s.onebotHttpToken = String(s.onebotHttpToken ?? '').trim();
  s.timeZone = String(s.timeZone ?? '').trim();
  s.dryRun = s.dryRun === true;
  s.personaSource = ['host', 'custom', 'off'].includes(String(s.personaSource)) ? String(s.personaSource) : 'host';
  s.personaCard = String(s.personaCard ?? '').trim();
  s.personaInheritChat = String(s.personaInheritChat ?? '').trim();
  s.personaText = String(s.personaText ?? '');
  s.personaExtra = String(s.personaExtra ?? '');
  s.personaMaxChars = Math.round(clamp(s.personaMaxChars, 800, 30000, 6000));
  s.personaName = String(s.personaName ?? '').trim();
  s.ownerTitle = String(s.ownerTitle ?? '').trim() || '你';
  s.selfClaim = String(s.selfClaim ?? '').trim() || '我';
  return s;
}

/** 是否填了可用的登录三件套。 */
export function hasCookie(s) {
  return Boolean(s?.sessdata && s?.biliJct);
}

/** 是否填了模型通道（能力通道无法静态判断，按 auto 当作可能有）。 */
export function hasLlm(s) {
  if (s.llmMode === 'off') return false;
  if (s.llmMode === 'own') return Boolean(s.llmBaseUrl && s.llmModel);
  return true;
}

/** 当前时区下的一组时间字段。非法时区自动退回本机时区。 */
export function tzNow(timeZone) {
  const d = new Date();
  const tz = String(timeZone || '').trim();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
      }).formatToParts(d);
      const get = (t) => parts.find((p) => p.type === t)?.value || '';
      const y = Number(get('year'));
      const m = Number(get('month'));
      const day = Number(get('day'));
      const h = Number(get('hour'));
      const min = Number(get('minute'));
      return {
        dateKey: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        h, min, minutes: h * 60 + min, week: d.getDay(), tz
      };
    } catch { /* 非法时区 → 走本地 */ }
  }
  return {
    dateKey: d.toLocaleDateString('sv-SE'),
    h: d.getHours(), min: d.getMinutes(), minutes: d.getHours() * 60 + d.getMinutes(),
    week: d.getDay(), tz: ''
  };
}

export const todayKey = (timeZone) => tzNow(timeZone).dateKey;
export const nowMinutes = (timeZone) => tzNow(timeZone).minutes;

/** "20:00" / "24:00" → 分钟。24:00 是 1440（当天结束）。 */
export function parseHHMM(input) {
  const m = String(input ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  if (h === 24 && min === 0) return 1440;
  if (h < 0 || h > 23) return null;
  return h * 60 + min;
}

export function clockText(minutes) {
  const m = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)));
  if (m === 1440) return '24:00';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 秒 → 00:00 / 1:02:03 */
export function fmtSec(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function parseDuration(value) {
  const parts = String(value ?? '').split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function truncate(value, max = 400) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/** 从模型输出里抠 JSON（允许 ```json 包裹、前后有解释）。 */
export function extractJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const direct = safeJsonParse(raw);
  if (direct && typeof direct === 'object') return direct;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const j = safeJsonParse(fenced[1].trim());
    if (j && typeof j === 'object') return j;
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const j = safeJsonParse(raw.slice(first, last + 1));
    if (j && typeof j === 'object') return j;
  }
  return null;
}

/** 把主人昵称/mid 从外部素材里打码，防“自称主人”的提示注入诱饵。 */
export function redact(value, s) {
  let out = String(value ?? '');
  const name = String(s?.ownerBiliName || '').trim();
  const mid = String(s?.ownerBiliMid || '').trim();
  if (name.length >= 2) out = out.split(name).join('「主人昵称·已打码」');
  if (mid.length >= 4) out = out.split(mid).join('「主人mid·已打码」');
  return out;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    if (typeof t?.unref === 'function') t.unref();
  });
}

export function randInt(min, max) {
  const a = Math.ceil(Math.min(min, max));
  const b = Math.floor(Math.max(min, max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

export function newId(prefix = 'id') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function withTimeout(promise, ms, label = '操作') {
  const n = Math.max(1000, Number(ms) || 30000);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(n / 1000)} 秒）`)), n);
      if (typeof timer?.unref === 'function') timer.unref();
    })
  ]);
}

/** 并发上限的 map（B 站接口不该一次打太多）。 */
export async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const n = Math.max(1, Math.min(8, Number(limit) || 2));
  const out = new Array(list.length);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

/** 人类可读的相对时间，用于日志/面板。 */
export function agoText(ts) {
  const n = Number(ts) || 0;
  if (!n) return '从未';
  const diff = Math.max(0, Date.now() - n);
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}
