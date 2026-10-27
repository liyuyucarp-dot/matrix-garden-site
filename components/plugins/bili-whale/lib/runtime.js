// bili-whale / runtime.js
//
// 主流程：醒来 → 选题 → 初筛 → 深读 → 评分 → 分享 → 写两本日记 → 报备主人。
// 以及评论监听、直播监听、草稿审批、手动工具共用的动作。
//
// 设计原则（照参考项目，但按 QQ Agent 的公开契约重写）：
//   · 不叫醒宿主 agent、不 import 核心；自己用 ai.ask / 自带接口 + sender 完成一整轮；
//   · 所有对外动作都过 quota 闸门；撞到风控立刻停手并报备；
//   · B 站文本一律当素材，不当指令；主人昵称/mid 在送模型前打码；
//   · 没有模型也能跑：退化为字幕/弹幕/热评摘要。

import {
  checkLogin, videoContent, videoConclusion, msgfeed, resolveFloor, bvidFromUri,
  addComment, liveHistory, sendDanmaku, searchVideos, fetchPopular, videoRelation, likeVideo, addFavorite, favFolders,
  fetchRanking, fetchFollowing, comments as fetchComments
} from './bili.js';
import { analyzeVideo, writeDiaries, composeReply, composeShareComment, composeVideoComment, ensureMention, heuristicAnalysis, fallbackComment, decideTriple } from './analyze.js';
import { hearVideo } from './hearing.js';
import { watchVideo } from './watch.js';
import { postedToday } from './feed.js';
import { listDiaries, formatDiary, addEntries, todaySummary } from './diary.js';
import { canShare, canReplyToPerson, record, markReplied, markFeedback, status as quotaStatus, silence } from './quota.js';
import { getDb, markDirty, addEvent, addDraft, findDraft, removeDraft } from './store.js';
import { notify, sendImage, defaultChat, hasChannel, appendToHistory } from './notify.js';
import { truncate, redact, todayKey, tzNow, nowMinutes, parseHHMM, newId, mapLimit, withTimeout, textHead, fmtSec } from './util.js';

let apiRef = null;
let logRef = () => {};

// 2026-10-21：本文件的日志出口叫 logRef，不是 log。
// 曾有 6 处误把日志写成未经包装的 log 调用 —— 一调 debrief 就抛 "log is not defined"。
// 加新日志时请用 logRef(...)，或参考 watch.js/hearing.js 里的 const log 包装。
export function initRuntime(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
}

const running = { wake: false, comment: false, live: false };

/**
 * [[activity]] 把"她这会儿在干什么"写给 sleep-mood 看。
 *
 * 为什么走宿主 storage 而不是自己写文件：api.storage 落的正是
 *   <DATA_DIR>/plugin-data/bili-whale/storage.json
 * sleep-mood 直接读那个文件的 activity 键即可 —— 一写一读、不跨插件 import、
 * 也绝不互相写对方的存档。和 sleep-mood/lib/travel-sync.js 读 travel-whale 是
 * 同一个模式（pull，不 push）。
 *
 * ★ 关键：它是**并行状态**，不顶掉旅行、也不顶掉睡觉。
 *   sleep-mood 侧会像「刚吃完」那样与 travel/home/selfState 叠加注入。
 *
 * 写失败一律静默：状态少一句话，远比不上把一轮刷视频搞挂。
 */
export function setActivity(act) {
  try { apiRef?.storage?.set?.('activity', act); } catch { /* 不影响主流程 */ }
}
export function clearActivity() { setActivity(null); }

/** 最近几条分享评论的"开头指纹"，用于同质化自检。 */
function recentShareHeads(n = 6) {
  try {
    return (getDb().quota || [])
      .filter((x) => x && x.share && x.note)
      .slice(-n)
      .map((x) => textHead(x.note))
      .filter(Boolean);
  } catch { return []; }
}
// 一轮最长按 20 分钟算：超过还占着锁，基本是某个 await 卡死（网络没超时 / LLM 不返回），
// 不释放的话后面所有 /鲸鱼 指令都会永远回「上一轮还在跑」。
const WAKE_STALE_MS = 45 * 60 * 1000;

/**
 * 一轮里"深读"这件事的**总**时限（不是单条）。用完就收尾，剩下的留给下一轮。
 * 30 分钟 = 一条最坏预算(17) + 一条正常(3~7) + 余量；必须留出"分享 / 写日记"的位置，
 * 也要保证 总时限 + 前戏 < WAKE_STALE_MS（45），否则会自己把自己判成卡死。
 */
const DEEP_TOTAL_MS = 30 * 60 * 1000;

/**
 * 一条视频的外层预算。
 *
 * 为什么要有这个函数（2026-10-22 修的真 bug）：
 *   这里原来硬编码 75 秒（withTimeout(deepReadVideo(...), 75_000)）。
 *   但 watchVideo 是**真的在跑**：切 ffmpeg、把 10~12 秒的原片当 video 部件发给
 *   全模态模型、等它看完再回来答。实测单段 40~200 秒，2 段一片
 *   81 / 216 / 424 秒（10-22 14:43~14:50 的日志）。
 *   75 秒的 Promise.race 先 reject，**底层请求却不会停** ——
 *   于是钱照花、结果照返回、然后被丢掉。
 *   表现：深读永远"失败" → ctx.deep 空 → 不分享 → 日记写"没有值得深看的"。
 *
 * 原则：外层超时**必须大于内层所有超时之和**，否则它不是保护，是误杀。
 *   内层：playurl 20s ｜ 每段(clip ≤180s + ask ≤200s = 380s) ｜ analyze ≤60s
 *   兜底听觉：每段 75s（每段预算按 80s 算）
 * 宁可给宽：真挂住的场景由内层每段超时兜，外层只负责"别永远不返回"。
 *   当前线上配置（watchSlices=2, hearingSlices=3）→ 90 + 340×2 + 80×3 ≈ 17 分钟。
 */
function deepReadBudget(s) {
  const slices = Math.max(1, Math.min(4, Number(s.watchSlices) || 2));
  const hearN = Math.max(0, Math.min(4, Number(s.hearingSlices) || 3));
  let ms = 90_000 + 340_000 * slices;
  if (s.hearingEnabled) ms += 80_000 * hearN;
  return ms;
}
let wakeStartedAt = 0;
let pendingManualWake = null;

/** 当前那一轮的状态：忙不忙、跑了多久、是不是已经卡死。 */
export function wakeBusyInfo() {
  if (!running.wake) return null;
  const ageMs = Math.max(0, Date.now() - wakeStartedAt);
  return { mins: Math.round(ageMs / 60000), stale: ageMs > WAKE_STALE_MS, ageMs };
}

/** 忙的时候把这次手动请求记下来，等上一轮结束立刻补跑（不丢失操作）。 */
export function queueManualWake(dryRun = false) {
  pendingManualWake = { dryRun: dryRun === true };
}
let lastCommentAt = 0;
let lastLiveAt = 0;

export function extractBvid(text) {
  const m = String(text || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

function setLoginSnapshot(info) {
  const db = getDb();
  db.stats = db.stats || {};
  db.stats.login = {
    ok: Boolean(info?.ok),
    mid: String(info?.mid || ''),
    uname: String(info?.uname || ''),
    reason: String(info?.reason || ''),
    at: Date.now()
  };
  markDirty();
}

/** 窗口解析："20:00-24:00:1, 08:00-09:00:1" → [{label,start,end,wakes}] */
export function parseWindows(s) {
  const raw = String(s.windows || '').trim();
  const parts = raw ? raw.split(/[\r\n,，;；]+/).map((x) => x.trim()).filter(Boolean) : [];
  const list = [];
  for (const part of parts) {
    const m = part.match(/^(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})(?:\s*[:：]\s*(\d+))?$/);
    if (!m) continue;
    const start = parseHHMM(m[1]);
    const end = parseHHMM(m[2]);
    if (start === null || end === null || end <= start) continue;
    const wakes = m[3] === undefined ? 1 : Math.max(0, Math.min(12, Number(m[3]) || 0));
    list.push({ start, end, wakes, label: `${m[1]}–${m[2]}` });
  }
  if (!list.length) list.push({ start: 20 * 60, end: 24 * 60, wakes: 1, label: '20:00–24:00' });
  return list;
}

export function inAnyWindow(s) {
  const now = nowMinutes(s.timeZone);
  return parseWindows(s).some((w) => now >= w.start && now < w.end);
}

// ── 选题 ─────────────────────────────────────────────────────────────────

function scoreCandidate(c, s) {
  const dur = Math.max(30, Number(c.duration) || 0);
  const density = (Number(c.danmaku) || 0) / dur;
  const heat = Math.log10((Number(c.play) || 0) + 1) * 3;
  const hits = s.likeKeywords.filter((k) => `${c.title} ${c.desc} ${c.tag}`.toLowerCase().includes(String(k).toLowerCase())).length;
  const bad = s.dislikeKeywords.filter((k) => `${c.title} ${c.desc} ${c.tag}`.toLowerCase().includes(String(k).toLowerCase())).length;
  return density + heat + hits * 6 - bad * 14 + (c.source === '关注' ? 2 : 0);
}

export async function collectCandidates(s, { limit = 5, keyword = '' } = {}) {
  const pool = [];
  const push = (arr) => { for (const x of arr || []) if (x?.bvid) pool.push(x); };

  if (keyword) {
    try { push(await searchVideos(s, keyword, { limit: 20 })); } catch (error) {
      if (error?.risk) throw error;
      logRef(`搜索「${keyword}」失败：${truncate(error?.message ?? error, 100)}`);
    }
  } else {
    // 关注流最像“真人刷 B 站”；匿名/未登录时自动跳过
    try { push(await fetchFollowing(s)); } catch (error) { logRef(`关注流取不到：${truncate(error?.message ?? error, 80)}`); }
    try { push(await fetchPopular(s)); } catch (error) { logRef(`热门取不到：${truncate(error?.message ?? error, 80)}`); }
    try { push(await fetchRanking(s)); } catch (error) { logRef(`排行取不到：${truncate(error?.message ?? error, 80)}`); }
    for (const kw of s.likeKeywords.slice(0, 4)) {
      try { push(await searchVideos(s, kw, { limit: 12 })); } catch (error) {
        if (error?.risk) throw error;
        logRef(`搜索「${kw}」失败：${truncate(error?.message ?? error, 80)}`);
      }
    }
  }

  const seen = getDb().seen || {};
  const now = Date.now();
  const uniq = new Map();
  for (const c of pool) {
    if (!/^BV[0-9A-Za-z]{10}$/.test(String(c.bvid))) continue;
    if (seen[c.bvid] && now - Number(seen[c.bvid]) < 30 * 86400_000) continue;
    if (!uniq.has(c.bvid)) uniq.set(c.bvid, { ...c, score: scoreCandidate(c, s) });
    else if ((c.desc || '').length > (uniq.get(c.bvid).desc || '').length) {
      uniq.set(c.bvid, { ...uniq.get(c.bvid), ...c, score: scoreCandidate(c, s) });
    }
  }
  const ranked = [...uniq.values()].sort((a, b) => b.score - a.score);
  // 按来源轮转取前 N，避免一整屏都是热门/排行
  const out = [];
  const buckets = new Map();
  for (const item of ranked) {
    const key = item.source || '其他';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const keys = [...buckets.keys()];
  let added = true;
  while (out.length < limit && added) {
    added = false;
    for (const key of keys) {
      const arr = buckets.get(key);
      if (!arr.length) continue;
      out.push(arr.shift());
      added = true;
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 轻量初筛：读完整文字素材，但只做启发式判断（不花模型 token）。 */
export async function previewVideo(s, bvid) {
  // ★ 2026-10-24：初筛**不取**官方 AI 总结 —— 一轮要初筛 5 条，每条多一次签名请求
  //   就是白白多撞 5 次风控面。真正值得看的那 1~3 条在 deepReadVideo 里再补。
  const video = await videoContent(s, bvid, { commentCount: 3, needSubtitles: true, needConclusion: false });
  const analysis = heuristicAnalysis(video, s);
  return { bvid, video, analysis, deep: false };
}

/**
 * ★ 2026-10-24「你到底看了多少」：把抽样覆盖量算成一句人话，塞进素材。
 * 拿不到有效数字就返回 ''（宁可不说，也不写个假百分比）。
 */
export function coverText(verb, cover, durationSec) {
  const parts = Math.max(0, Math.round(Number(cover?.parts) || 0));
  const secs = Math.max(0, Math.round(Number(cover?.secs) || 0));
  const dur = Math.max(0, Math.round(Number(durationSec) || 0));
  if (!parts || !secs) return '';
  const total = parts * secs;
  const pct = dur > 0 ? Math.min(100, Math.round((total / dur) * 100)) : 0;
  return `${verb} ${parts} 段、共约 ${total} 秒${pct ? `（占全片约 ${pct}%）` : ''}`;
}

export async function deepReadVideo(s, bvid, preview = null) {
  const video = preview?.video || await videoContent(s, bvid, { commentCount: 8, needSubtitles: true });
  // ★ 2026-10-24「官方 AI 总结」：初筛时省掉了，这里补 —— 只有真读的那 1~3 条才多这一次请求。
  //   拿不到（未登录 / 没生成过）就当没有，绝不影响后面的字幕/弹幕/热评。
  if (!video.conclusion && s.officialSummary !== false && video.cid) {
    try {
      video.conclusion = await videoConclusion(s, bvid, { cid: video.cid, mid: video.authorMid });
    } catch { /* 取不到 summary 不算错误 */ }
  }
  if (!video.comments || video.comments.length < 5) {
    try {
      const more = await fetchComments(s, video.aid, 8);
      if (more.length > (video.comments?.length || 0)) video.comments = more;
    } catch { /* 热评拿不到不影响 */ }
  }
  // ── 看视频（原生视频输入，2026-10-21）：主通道 ──
  // 把 10~12 秒的原片直接当 video 部件送全模态模型：画面 + 声音 + 口播一次拿到。
  // 不做抽帧 —— 抽帧普通视觉模型就能做，全模态的价值在于"整段视频"。
  // 失败一律静默降级，转听觉兜底，再不行就只靠文本素材。
  // ── 时长闸（2026-10-22，群友方案第 4 条）──
  // 超过 maxWatchMinutes 的片子只翻字幕/弹幕/热评，不调多模态。
  // 不是省钱，是"会不会点开"：人刷视频不会点开 2 小时的直播回放。
  const capMin = Math.max(0, Number(s.maxWatchMinutes) || 0);
  const tooLong = capMin > 0 && Number(video?.duration) > capMin * 60;
  if (tooLong) {
    video.longSkipped = true;
    addEvent('watch-skip-long', `${bvid} 时长 ${fmtSec(video.duration)} 超过 ${capMin} 分钟，只读文字`);
    logRef(`[bili-whale] 不看画面 ${bvid}：时长 ${fmtSec(video.duration)} > 上限 ${capMin} 分钟，只翻字幕`);
  }
  if (s.watchEnabled && video?.cid && !tooLong) {
    try {
      const watched = await watchVideo(s, video, { hint: `视频《${truncate(video.title, 40)}》` });
      if (watched?.ok && watched.text) {
        video.watched = watched.text;
        // [[coverage]] 2026-10-24：把"到底抽了多少"记下来 —— 下面要写进素材，防她拿抽样当全片。
        video.watchCover = {
          parts: (watched.slices || []).filter((x) => x.text).length,
          secs: Math.max(0, Number(watched.meta?.secs) || 0)
        };
        addEvent('watch', `${bvid} 看了 ${watched.slices?.filter((x) => x.text).length || 0} 段｜${truncate(watched.text.replace(/\s+/g, ' '), 90)}`);
        logRef(`[bili-whale] 看视频完成 ${bvid}：${watched.meta?.ms ?? '?'}ms，${watched.meta?.ok ?? '?'}/${watched.meta?.slices ?? '?'} 段`);
      } else if (!watched?.skipped) {
        logRef(`[bili-whale] 看视频未成 ${bvid}：${truncate(watched?.error || watched?.reason || '未知原因', 120)}，转听觉`);
      }
    } catch (e) {
      logRef(`[bili-whale] 看视频异常 ${bvid}：${truncate(e?.message ?? e, 120)}，转听觉`);
    }
  }

  // ── 听觉（兜底）：视频部件不被中转站支持 / 片段太大 / 全部失败时，只喂音频 ──
  if (!video.watched && !tooLong && s.hearingEnabled && video?.cid) {
    try {
      const heard = await hearVideo(s, video, { hint: `视频《${truncate(video.title, 40)}》` });
      if (heard?.ok && heard.text) {
        video.hearing = heard.text;
        // [[coverage]] 同上：听觉也是抽样，篇幅要写清楚。
        video.hearingCover = {
          parts: (heard.slices || []).filter((x) => x.text).length,
          secs: Math.max(0, Number(heard.meta?.secs) || 0)
        };
        addEvent('hearing', `${bvid} 听了 ${heard.slices?.filter((x) => x.text).length || 0} 段｜${truncate(heard.text.replace(/\s+/g, ' '), 90)}`);
        logRef(`[bili-whale] 听觉完成 ${bvid}：${heard.meta?.ms ?? '?'}ms，${heard.meta?.slices ?? '?'} 段`);
      } else if (!heard?.skipped) {
        logRef(`[bili-whale] 听觉跳过 ${bvid}：${truncate(heard?.error || heard?.reason || '未知原因', 120)}`);
      }
    } catch (e) {
      logRef(`[bili-whale] 听觉异常 ${bvid}：${truncate(e?.message ?? e, 120)}`);
    }
  }

  // [[vision-note]] P1-1「看了就是看了」（2026-10-22）
  // 真看过画面 / 只听了几段声音 / 彻底没看成，是三种不同的事实。
  // 以前三种情况素材里**一模一样**（都只有字幕+弹幕+热评），她就按"我看了"的口吻写日记 ——
  // 这是最伤信任的那种假（比"没看"更糟）。现在把"是哪一种"写进素材，让她自己收敛。
  //
  // [[coverage]] 2026-10-24 补第二种假：**抽样 ≠ 全片**。
  //   用户当场抓到：她只抽看了 2 段共 24 秒（4 分钟片子的 10%），却在群里说
  //   「歌是真从头听到尾的」，还引了「最后那句『你回来，这回方向键给你』」——
  //   那句话材料里**根本不存在**（字幕只有"[01:03] 一人掌控方向键"，而且字幕只覆盖 00:39–01:19 中段）。
  //   根因：老版本只在"完全没看成 / 只听声音"时给提示，"看了但只抽了几段"没有任何边界说明，
  //   于是她很自然地把抽样说成全片、把素材里的**描述**改写成**引语**。
  //   ⇒ 现在把覆盖量写死进素材，并明令禁止 extrapolate 到没抽到的段落。
  if (video.watched) {
    const c = coverText('抽看了', video.watchCover, video.duration);
    video.visionNote = [
      c ? `你**只看了一部分**：${c}，不是全片。` : '你只看了抽样片段，不是全片。',
      '没抽到的地方你**没看过** —— 别说"从头到尾 / 全程 / 一直看到最后 / 最后那句"这种话，'
        + '也别替没看到的段落编内容（台词、结尾、画外音都不行）。',
      '素材和字幕里的描述是**概括**，不能改写成引语（"他说『…』"）—— '
        + '只有你真正看到/听到的、或字幕原文里逐字出现的句子才可以打引号。'
    ].join('');
  } else if (video.hearing) {
    const c = coverText('听了几段音频', video.hearingCover, video.duration);
    video.visionNote = [
      c ? `你**只听了抽样音频**：${c}，没看到画面。` : '你只听了几段声音，没看到画面。',
      '可以讲听到的内容，别描述画面；也别说"从头听到尾" —— 你听的是抽样，不是全片。',
      '素材里的描述不能改写成引语。'
    ].join('');
  } else {
    video.visionNote = video.longSkipped
      ? '这条太长、你没点开看，只翻了字幕/弹幕/评论 —— 没看画面也没听声音，别装作看过。'
      : '这次没能看成画面（视频模型没给出结果），你只扫了眼字幕/弹幕/评论 —— 说话别装成看过画面。';
  }

  const analysis = await analyzeVideo(apiRef, video, s);
  return { bvid, video, analysis, deep: true };
}

// ── 分享与回复 ───────────────────────────────────────────────────────────

function riskStop(s, where, error) {
  const db = getDb();
  db.stats = db.stats || {};
  db.stats.riskAt = Date.now();
  db.stats.riskWhere = String(where || '');
  markDirty();
  addEvent('risk-stop', `${where}：${truncate(error?.message ?? error, 160)}`);
  if (s.notifyOnError) {
    void notify(s, `⚠️ 撞到 B 站风控，已停手。\n位置：${where}\n原因：${truncate(redact(error?.message ?? error, s), 200)}\n处理：今天不再对外发，先检查 cookie / 验证码。`, { kind: 'risk', force: true });
  }
}

/**
 * [[triple]] 三连：点赞 → 收藏 → 回读核验。
 *
 * 为什么不分开做（2026-10-22 用户要求）：收藏必须**同时**带点赞和评论，
 * 而评论里要说"我赞了收了"。所以三件事必须绑定成**一个原子动作**：
 * 只有点赞和收藏都被回读确认成 true，才允许往下发那条评论 ——
 * 这样"评论里说的话"永远不会领先于"实际做过的事"。
 *
 * 顺序也讲究：先赞、再收、最后（在 shareVideo 里）发评论。
 * 任何一步失败都整体放弃，不留下"赞了但没评论"的半截动作。
 *
 * ★★ 2026-10-24「赞不赞由她自己决定」：动作集合不再固定全做 ——
 *   `plan` 由 `decideTriple()` 问出来（她可能只想赞、不想收，或者两个都不想）。
 *   回读核验也随之改成**只核她打算做的那几个**，否则"只赞不藏"会被判成失败。
 *   ⚠️ 半个动作也是**原子**的：打算做的那些必须全部核到，缺一个就整体不算成立。
 */
async function doTriple(s, video, plan = {}) {
  const wantLike = plan.like !== false;      // 不传 plan ⇒ 全做（老调用点语义）
  const wantFav = plan.fav !== false;
  const aid = String(video?.aid || '').replace(/\D/g, '');
  const bvid = String(video?.bvid || '');
  if (!wantLike && !wantFav) return { ok: true, liked: false, faved: false, none: true };
  if (!aid) return { ok: false, reason: '没有 aid，三连做不了' };
  try {
    const before = await videoRelation(s, aid);
    if (!before.ok) return { ok: false, reason: `读不到当前状态（${before.error || before.code}）` };

    if (wantLike && !before.like) {
      const lk = await likeVideo(s, { aid, bvid });
      if (!lk.ok) return { ok: false, reason: `点赞失败：${lk.hint || lk.message || `code=${lk.code}`}`, risk: lk.risk };
    }
    if (wantFav && !before.favorite) {
      let fid = Number(getDb()?.meta?.favFid) || 0;
      if (!fid) {
        const f = await favFolders(s);
        if (!f.ok || !f.list?.length) return { ok: false, reason: `找不到收藏夹（${f.error || '空'}）` };
        const prefer = String(s.favFolderName || '').trim();
        const picked = (prefer && f.list.find((x) => String(x.title || '') === prefer))
          || f.list.find((x) => Number(x.attr) === 0)
          || f.list[0];
        fid = Number(picked?.id) || 0;
        if (!fid) return { ok: false, reason: '收藏夹 id 解析失败' };
        const db = getDb();
        db.meta = db.meta || {};
        db.meta.favFid = fid;
        markDirty();
      }
      const fv = await addFavorite(s, { aid, bvid, fid });
      if (!fv.ok) return { ok: false, reason: `收藏失败：${fv.hint || fv.message || `code=${fv.code}`}`, risk: fv.risk };
    }

    // 回读核验：**只核她打算做的那几个**，做了的必须全部是 true。
    // （2026-10-24 起动作集合可变：只赞不藏 ⇒ 不去核 favorite，否则会被判成失败。）
    //
    // ★ 必须带重试（2026-10-22 实测）：接口返回 code 0 之后，relation 里
    //   like/favorite 还会**延迟 1~3 秒**才翻成 true。读一次就判死的话，
    //   每一次三连都会"看起来失败" → 评论永远发不出去。
    const sleeps = [0, 1200, 2500];
    let after = null;
    for (let i = 0; i < sleeps.length; i += 1) {
      if (sleeps[i]) await new Promise((r) => setTimeout(r, sleeps[i]));
      after = await videoRelation(s, aid);
      const okLike = !wantLike || after.like;
      const okFav = !wantFav || after.favorite;
      if (after.ok && okLike && okFav) break;
    }
    if (!after?.ok) return { ok: false, reason: `回读失败（${after?.error || after?.code}）` };
    if ((wantLike && !after.like) || (wantFav && !after.favorite)) {
      return { ok: false, reason: `回读核验没过（赞=${after.like}${wantLike ? '' : '·本次不做'} 收=${after.favorite}${wantFav ? '' : '·本次不做'}，等了约 4 秒）` };
    }
    const done = [wantLike ? '已赞' : '', wantFav ? '已收藏' : ''].filter(Boolean).join(' + ');
    addEvent('triple', `${bvid || aid} ${done}${wantFav ? `（fid=${getDb()?.meta?.favFid || '?'}）` : ''}`);
    logRef(`[bili-whale] 互动完成 ${bvid || aid}：${done}`);
    return { ok: true, liked: wantLike, faved: wantFav };
  } catch (e) {
    return { ok: false, reason: truncate(e?.message ?? e, 120), risk: e?.risk === true };
  }
}

/**
 * 分享一条视频（评论 @ 主人）。自主流程和手动工具共用。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason:string, url?:string, comment?:string}>}
 */
export async function shareVideo(s, { bvid, text = '', reason = '', score = null, analysis = null, video = null, dryRun = false, manual = false }) {
  const bv = extractBvid(bvid);
  if (!bv) return { ok: false, reason: '没有识别出 BV 号' };
  // ★★ 2026-10-24「评论视频模式」（用户口径：默认从"分享给主人"改成"在视频下评论"）：
  //   · `comment`（默认）= 在视频下发一条**公开评论**，不 @ 任何人、不提主人；
  //   · `share`（老行为，`postMode:'share'` 才走）= 老的「@主人 + 三连」。
  //   两种模式**共用同一本额度账**（shareDaily / 沉默衰减 / 同视频 N 天一次）——
  //   公开说话的风险是一样的，不该因为换了形式就绕过闸门。
  const mode = s.postMode === 'share' ? 'share' : 'comment';
  const gate = canShare(s, bv, { mode });
  if (!gate.ok) return { ok: false, skipped: true, reason: gate.reason };
  const min = Math.max(0, Number(s.shareMinScore) || 0);
  const actual = Number.isFinite(Number(score)) ? Number(score) : Number(analysis?.score?.total ?? 0);
  if (actual < min) return { ok: false, skipped: true, reason: `评分 ${actual} < 阈值 ${min}：这条不值得占用主人注意力` };
  const why = String(reason || analysis?.reason || '').trim();
  if (why.length < 8) return { ok: false, skipped: true, reason: '分享必须写清「为什么值得」（至少 8 个字）' };

  let v = video;
  if (!v) {
    try { v = await videoContent(s, bv, { commentCount: 6, needSubtitles: true }); } catch (error) {
      return { ok: false, reason: `取视频素材失败：${truncate(error?.message ?? error, 140)}` };
    }
  }
  // [[triple]] 三连必须在**写评论之前**完成，并且回读核验通过 ——
  // 评论里会写"我赞了收了"，那句只能出现在事情真的发生之后。
  const willSend = !(dryRun || s.dryRun);
  let triple = null;
  let plan = { like: true, fav: true };
  if (willSend && s.tripleOnShare !== false) {
    // ★★ 2026-10-24「赞不赞由她自己决定」（移植自 bili-activity）：**动手之前先问一句**。
    //   · 她说两个都不要 ⇒ **不三连，但分享照旧** —— 只是评论里不许再提赞/收；
    //   · 她说只赞不藏 ⇒ 按部分动作执行（doTriple 只回读核她打算做的那几个）；
    //   · 没问出来（没模型 / JSON 坏）⇒ **退回旧规则全做**，
    //     绝不能变成"她什么都没做"——那是把系统的失败算在她头上。
    if (s.reactTriple !== false) {
      const verdict = await decideTriple(apiRef, v, analysis, s);
      if (verdict.ok) {
        plan = { like: verdict.like, fav: verdict.fav };
        addEvent('react', `${bv}：赞=${plan.like} 收=${plan.fav}${verdict.why ? `｜${verdict.why}` : ''}`);
        logRef(`[bili-whale] 问过她自己 ${bv}：赞=${plan.like} 收=${plan.fav}（${verdict.why || '没说理由'}）`);
      } else {
        addEvent('react-fail', `${bv}：${truncate(verdict.error, 100)}（退回旧规则：赞+收）`);
      }
    }
    if (!plan.like && !plan.fav) {
      addEvent('react-declined', `${bv}：她没被打动，这次只分享、不赞不收`);
      logRef(`[bili-whale] ${bv}：她决定不点赞也不收藏 —— 评论照发，文案不提赞/收`);
    } else {
      triple = await doTriple(s, v, plan);
      if (!triple.ok) {
        if (triple.risk) riskStop(s, '三连', new Error(triple.reason));
        addEvent('triple-fail', `${bv}：${truncate(triple.reason, 120)}`);
        return {
          ok: false,
          skipped: true,
          reason: `三连没成（${truncate(triple.reason, 100)}），这次就不发评论了 —— 否则评论里说的和实际不符`
        };
      }
    }
  }
  // 演练时按"会做三连"预演文案；真发时以**实际做过的事实**为准 —— 可能是半个（只赞/只收），
  // 也可能一个都没有（她没被打动）⇒ 下游 composeShareComment 只说她真做过的那几件。
  const claimTriple = willSend
    ? (triple?.ok ? { liked: triple.liked, faved: triple.faved } : false)
    : Boolean(s.tripleOnShare !== false);

  let body = String(text || '').trim();
  let composedBy = body ? 'user' : '';
  if (!body) {
    try {
      if (mode === 'comment') {
        const c = await composeVideoComment(apiRef, v, s, analysis, { avoid: recentShareHeads(6) });
        body = String(c.text || '');
        composedBy = c.via;              // 'model' | 'fallback'
      } else {
        body = await composeShareComment(apiRef, v, s, analysis, { triple: claimTriple });
        composedBy = 'model';
      }
    } catch { body = ''; composedBy = 'error'; }
  }
  // ★★ 2026-10-24：**公开评论区不拿模板句充数**。
  //   没有模型通道时，兜底句是"热评那句「…」，我看了半天"这种模板 ——
  //   挂在主人面前还行，挂在陌生人的视频底下就是水军。所以评论模式下**宁可不发**。
  //   （分享给主人那条路保持原样：兜底句照发，主人知道那是她的话。）
  if (mode === 'comment' && (composedBy === 'fallback' || composedBy === 'error')) {
    addEvent('comment-skip', `${bv}：没有可用的模型通道，公开评论不拿模板句充数`);
    logRef(`[bili-whale] ${bv}：评论模式但模型不可用（${composedBy}）⇒ 这次不往公开评论区发`);
    return {
      ok: false,
      skipped: true,
      reason: '没有可用的模型通道（ai.ask / 自带接口都不可用），这次不往公开评论区发模板句'
    };
  }
  if (!body) {
    body = mode === 'comment'
      ? `《${truncate(v.title, 40)}》${truncate(analysis?.summary || v.desc || '', 90)}`
      : `@${s.ownerBiliName || '主人'} 《${truncate(v.title, 40)}》${truncate(analysis?.summary || v.desc || '', 90)}`;
  }
  // 只有分享模式要 @ 主人；评论模式下模型若仍带出 @前缀，这里直接剥掉（公开评论区不拉人）
  body = mode === 'comment' ? body.replace(/^@\S+\s*/, '').trim() : ensureMention(body, s);
  if (!body.replace(/^@\S+\s*/, '').trim()) return { ok: false, reason: mode === 'comment' ? '评论正文为空' : '分享正文为空' };

  // [[share-dedupe]] 同质化自检（2026-10-22）
  // 「一两条新奇，多了就泛滥」—— 但光靠提示词里写"别重复开头"是让模型自觉。
  // 这里做真比对：去掉 @某人 与标点后的**前 6 字**，和最近 6 条分享撞了就换。
  //   ① 有模型 → 带 avoid 重写一次；
  //   ② 没模型 / 重写完还撞 → 用兜底模板的另一种"钩子形态"。
  // ⚠️ 任何情况下都不因为"撞"而不发：少发一条，比发一条像复制粘贴的更糟。
  {
    const avoid = recentShareHeads(6);
    const cur = textHead(body);
    if (avoid.length && avoid.includes(cur)) {
      let fixed = '';
      try {
        if (mode === 'comment') {
          const c = await composeVideoComment(apiRef, v, s, analysis, { avoid });
          if (c?.via === 'model') fixed = String(c.text || '');
        } else {
          const alt = await composeShareComment(apiRef, v, s, analysis, { avoid, triple: claimTriple });
          if (alt) fixed = ensureMention(alt, s);
        }
      } catch { /* 重写失败 → 走兜底形态 */ }
      if (!fixed || avoid.includes(textHead(fixed))) {
        try {
          const fb = fallbackComment(v, analysis, s, avoid, { triple: claimTriple });
          fixed = mode === 'comment' ? fb.replace(/^@\S+\s*/, '').trim() : ensureMention(fb, s);
          // 评论模式下这一步是**模板句** ⇒ 标记出来，下面会据此放弃发送
          if (mode === 'comment') composedBy = 'fallback';
        } catch { fixed = ''; }
      } else if (mode === 'comment') {
        composedBy = 'model';
      }
      if (fixed && fixed.replace(/^@\S+\s*/, '').trim()) {
        addEvent('share-dedupe', `开头「${cur}」撞了 → 已换一种说法`);
        logRef(`[bili-whale] 分享开头撞车（${cur}），已换：${truncate(fixed.replace(/^@\S+\s*/, ''), 40)}`);
        body = fixed;
      }
    }
  }
  // ★ 评论模式最后一道闸：换完若仍是模板句（重写失败 / 模型没答），**不发**。
  //   （三连已经做了就做了 —— 不补评论，绝不拿模板去充公开评论区。）
  if (mode === 'comment' && composedBy === 'fallback') {
    addEvent('comment-skip', `${bv}：重写后仍是模板句，公开评论不充数`);
    return { ok: false, skipped: true, reason: '这次没能用她自己的话写出来，公开评论区不拿模板句充数' };
  }
  // 评论模式更短：公开评论区里 1000 字是刷屏，二三百字最像人话
  const cap = mode === 'comment' ? 300 : 1000;
  if (body.length > cap) body = `${body.slice(0, cap - 2)}…`;

  if (dryRun || s.dryRun) {
    addEvent('share-dry', `${bv}：${truncate(body, 80)}`);
    return { ok: true, dryRun: true, reason: '演练模式，未发出', comment: body, url: `https://www.bilibili.com/video/${bv}/` };
  }

  let result;
  try {
    result = await addComment(s, { oid: v.aid, bvid: bv, message: body });
  } catch (error) {
    if (error?.risk) riskStop(s, '分享评论', error);
    return { ok: false, reason: `发送失败：${truncate(error?.message ?? error, 160)}` };
  }
  if (!result.ok) {
    if (result.risk) riskStop(s, '分享评论', new Error(result.hint || result.message));
    return { ok: false, reason: `B站拒绝：${result.hint || result.message || `code=${result.code}`}`, code: result.code };
  }
  record({
    type: 'comment', target: bv,
    // 账本 note 带上模式：`/鲸鱼 额度` 和面板里一眼能看出这条是"评论"还是"@主人分享"
    note: `${mode === 'comment' ? '评论' : '分享'}：${body.replace(/\s+/g, ' ').slice(0, 70)}`,
    // share 仍记 true：它代表"对外公开发言"，日额度与沉默衰减都按这一本账算
    share: true, auto: !manual, bvid: bv
  });
  if (triple?.ok) addEvent('triple-done', `${bv} ${[triple.liked ? '赞' : '', triple.faved ? '收' : ''].filter(Boolean).join('+')}+评 都成了`);
  const db = getDb();
  db.seen = db.seen || {};
  db.seen[bv] = Date.now();
  markDirty();
  addEvent(mode === 'comment' ? 'comment' : 'share', `${bv} rpid=${result.rpid}：${truncate(body, 70)}`, bv);
  if (s.notifyOnShare) {
    const link = result.url || `https://www.bilibili.com/video/${bv}/`;
    void notify(s, mode === 'comment'
      ? [
        `在《${v.title}》底下评论了一句：`,
        truncate(body, 300),
        `视频：${link}`,
        `评分：${actual}/20 · 理由：${truncate(why, 120)}`
      ].join('\n')
      : [
        `分享了一条：${v.title}`,
        `链接：${link}`,
        `正文：${truncate(body, 200)}`,
        `评分：${actual}/20 · 理由：${truncate(why, 120)}`
      ].join('\n'), { kind: 'share' });
  }
  return { ok: true, rpid: result.rpid, url: result.url, comment: body, reason: why, mode };
}

function feedTarget(item) {
  const type = Number(item.business) === 11 ? 11 : 1;
  const bvid = item.bvid || bvidFromUri(item.uri);
  return {
    oid: String(item.oid || ''),
    bvid,
    type,
    root: String(item.root || ''),
    parent: String(item.parent || ''),
    referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : (type === 11 ? 'https://t.bilibili.com/' : 'https://www.bilibili.com/')
  };
}

/** 回复一条收件箱消息 / 草稿。 */
export async function replyToItem(s, item, { text = '', dryRun = false, manual = false } = {}) {
  if (!item) return { ok: false, reason: '没有要回复的对象' };
  const who = String(item.who || '');
  const mid = String(item.mid || '');
  const isOwner = mid && mid === String(s.ownerBiliMid || '');
  const gate = canReplyToPerson(s, mid);
  // 主人手动指定 oid/正文时，若收件箱没给 mid，不该因为“判重状态未知”把人工操作也挡死；
  // 但仍保留“同一个人 30 天只回一条”的检查（有 mid 时）。
  if (!gate.ok && !(manual && !mid)) return { ok: false, skipped: true, reason: gate.reason };
  let body = String(text || '').trim();
  if (!body) {
    const r = await composeReply(apiRef, item, s);
    if (!r.ok) return { ok: false, skipped: true, reason: r.error || '模型认为这句不该回' };
    body = r.text;
  }
  if (!body) return { ok: false, skipped: true, reason: '回复正文为空' };
  if (body.length > 500) body = `${body.slice(0, 498)}…`;
  const t = feedTarget(item);
  if (!t.oid) return { ok: false, reason: '缺少 oid，无法回复' };
  if (dryRun || s.dryRun) return { ok: true, dryRun: true, comment: body, reason: '演练模式，未发出' };

  let result;
  try {
    result = await addComment(s, { ...t, message: body });
  } catch (error) {
    if (error?.risk) riskStop(s, `回复 ${who}`, error);
    return { ok: false, reason: `发送失败：${truncate(error?.message ?? error, 160)}` };
  }
  if (!result.ok) {
    if (result.risk) riskStop(s, `回复 ${who}`, new Error(result.hint || result.message));
    return { ok: false, reason: `B站拒绝：${result.hint || result.message || `code=${result.code}`}`, code: result.code };
  }
  record({ type: 'reply', target: t.bvid || `oid:${t.oid}`, note: `回复 ${who}：${truncate(body, 50)}`, share: false, auto: !manual, bvid: t.bvid });
  markReplied(mid, { target: t.bvid || `oid:${t.oid}`, rpid: result.rpid, name: who });
  if (isOwner) markFeedback(s, '主人回复了评论');
  addEvent('reply', `回复 ${who}（mid ${mid}）：${truncate(body, 60)}`, t.bvid || t.oid);
  return { ok: true, rpid: result.rpid, comment: body, url: result.url, who };
}

// ── 收件箱 / 草稿 ────────────────────────────────────────────────────────

function draftFromItem(s, item, replyText = '') {
  return {
    id: newId('d'),
    at: Date.now(),
    kind: item.kind || 'reply',
    who: String(item.who || ''),
    mid: String(item.mid || ''),
    oid: String(item.oid || ''),
    root: String(item.root || ''),
    parent: String(item.parent || ''),
    business: Number(item.business || 1) || 1,
    bvid: item.bvid || bvidFromUri(item.uri),
    uri: String(item.uri || ''),
    title: String(item.title || ''),
    src: String(item.text || item.source || item.title || ''),
    text: String(replyText || ''),
    status: 'pending'
  };
}

export async function runCommentListen(s, { force = false } = {}) {
  if (!s.listenComment) return { ok: true, skipped: true, reason: '评论区监听关着' };
  if (running.comment) return { ok: false, reason: '上一轮监听还在跑' };
  const interval = Math.max(60, Number(s.listenIntervalSec) || 300) * 1000;
  if (!force && Date.now() - lastCommentAt < interval) return { ok: true, skipped: true, reason: '还没到下一轮' };
  if (!s.listenAllDay && !inAnyWindow(s)) return { ok: true, skipped: true, reason: '不在作息窗口内' };
  lastCommentAt = Date.now();
  running.comment = true;
  try {
    const db = getDb();
    const kinds = s.listenScope === 'at' ? ['at'] : s.listenScope === 'reply' ? ['reply'] : ['reply', 'at'];
    const all = [];
    for (const kind of kinds) {
      try {
        const r = await msgfeed(s, kind, { pages: 1 });
        for (const item of r.items) {
          item.bvid = bvidFromUri(item.uri);
          // 收件箱的 title/source 语义不可靠：有 source 用 source，否则后面回读楼层
          if (!item.text) item.text = String(item.source || item.title || '');
          all.push(item);
        }
      } catch (error) {
        if (error?.risk) { riskStop(s, `收件箱 ${kind}`, error); return { ok: false, reason: truncate(error?.message ?? error, 140) }; }
        logRef(`收件箱 ${kind} 读取失败：${truncate(error?.message ?? error, 100)}`);
      }
    }
    if (!all.length) return { ok: true, fresh: 0, reason: '没有新消息' };

    const login = db.stats?.login || {};
    const selfMid = String(login.mid || '');
    const lastSeen = Number(db.listen?.lastSeen) || 0;
    if (!lastSeen) {
      db.listen = { ...(db.listen || {}), lastSeen: Math.floor(Date.now() / 1000), at: Date.now() };
      markDirty();
      addEvent('listen-baseline', '第一次监听：只把现在当基线，不补历史');
      return { ok: true, baseline: true, fresh: 0, reason: '已建立基线' };
    }
    const seenIds = new Set(Array.isArray(db.listen?.seenIds) ? db.listen.seenIds : []);
    let fresh = all
      .filter((x) => Number(x.t || 0) >= lastSeen || (Number(x.t || 0) === 0 && !seenIds.has(String(x.id))))
      .filter((x) => !seenIds.has(String(x.id)))
      .filter((x) => !selfMid || String(x.mid) !== selfMid)
      .filter((x) => !s.listenOnlyOwner || String(x.mid) === String(s.ownerBiliMid))
      .sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
    // 上限：一次最多处理 5 条，剩下的下一轮
    fresh = fresh.slice(0, 5);
    if (!fresh.length) {
      db.listen.at = Date.now();
      markDirty();
      return { ok: true, fresh: 0, reason: '没有新消息' };
    }

    const handled = [];
    let maxT = lastSeen;
    for (const item of fresh) {
      maxT = Math.max(maxT, Number(item.t || 0));
      seenIds.add(String(item.id));
      // 正文缺失时回读楼层（同一楼同一人只查一次）
      if (!item.text && item.root && item.mid) {
        try {
          const floor = await resolveFloor(s, { business: item.business, oid: item.oid, root: item.root, mid: item.mid, parentRpid: item.parent });
          if (floor?.text) { item.text = floor.text; item.parent = floor.rpid || item.parent; }
        } catch { /* 读不到就用收件箱字段 */ }
      }
      const isOwner = String(item.mid) === String(s.ownerBiliMid) && s.ownerBiliMid;
      const direct = isOwner ? s.autoReplyOwner : s.autoReplyOthers;
      if (direct) {
        const r = await replyToItem(s, item, {});
        handled.push({ ...item, mode: 'reply', result: r });
        if (!r.ok && !r.skipped && s.notifyOnMention) {
          void notify(s, `有人找来（${item.who}），但回复失败：${truncate(r.reason, 160)}`, { kind: 'mention' });
        }
      } else {
        // 先写好一段回复草稿，连原话一起推给主人审；批准才发。
        let draftText = '';
        try {
          const r = await composeReply(apiRef, item, s);
          if (r.ok) draftText = r.text;
        } catch { /* 没有模型就只推原话，批准时再试一次 */ }
        const draft = draftFromItem(s, item, draftText);
        addDraft(draft);
        handled.push({ ...item, mode: 'draft', draft });
      }
    }
    db.listen = {
      ...(db.listen || {}),
      lastSeen: Math.max(lastSeen, maxT),
      at: Date.now(),
      seenIds: [...seenIds].slice(-200)
    };
    markDirty();

    const drafts = handled.filter((x) => x.mode === 'draft');
    if (drafts.length && s.notifyOnMention) {
      const lines = drafts.slice(0, 3).map((x, i) => [
        `${i + 1}. ${x.who}：${truncate(redact(x.text || x.title || '', s), 100)}`,
        `   草稿：${x.draft.text ? truncate(x.draft.text, 100) : '（模型没写出可用回复，批准时会再试）'}`,
        `   批准：/鲸鱼 批准 ${x.draft.id}｜拒绝：/鲸鱼 拒绝 ${x.draft.id}`
      ].join('\n'));
      void notify(s, [
        `有 ${drafts.length} 条新的评论/回复，需要你点个头：`,
        ...lines,
        '（默认不直接回陌生人，避免被当聊天机器人。也可以在设置里打开「陌生人直接回」。）'
      ].join('\n'), { kind: 'mention' });
    }
    const replied = handled.filter((x) => x.mode === 'reply' && x.result?.ok);
    if (replied.length && s.notifyOnMention) {
      void notify(s, `回了 ${replied.length} 条：\n` + replied.map((x) => `· ${x.who}：${truncate(x.result.comment || '', 80)}`).join('\n'), { kind: 'mention' });
    }
    addEvent('listen', `新消息 ${fresh.length} 条，直接回 ${replied.length}，草稿 ${drafts.length}`);
    return { ok: true, fresh: fresh.length, replied: replied.length, drafts: drafts.length, handled };
  } finally {
    running.comment = false;
  }
}

// ── 直播 ─────────────────────────────────────────────────────────────────

const TEMPLATE_RE = /^(欢迎|感谢|谢谢|喜欢主播|点点关注|点个关注|关注|小礼物|礼物|舰长|打call|比心心|收到|好哒|夸我)/;

export async function runLiveListen(s, { force = false } = {}) {
  if (!s.liveEnabled || !s.liveRoom) return { ok: true, skipped: true, reason: '直播监听未开启或没填房间号' };
  if (running.live) return { ok: false, reason: '上一轮直播监听还在跑' };
  const interval = Math.max(5, Number(s.liveIntervalSec) || 12) * 1000;
  if (!force && Date.now() - lastLiveAt < interval) return { ok: true, skipped: true, reason: '还没到下一轮' };
  lastLiveAt = Date.now();
  running.live = true;
  try {
    const db = getDb();
    const login = db.stats?.login || {};
    const selfMid = String(login.mid || '');
    const selfName = String(login.uname || '');
    let data;
    try {
      data = await liveHistory(s, s.liveRoom);
    } catch (error) {
      if (error?.risk) riskStop(s, '直播弹幕', error);
      return { ok: false, reason: truncate(error?.message ?? error, 140) };
    }
    const rows = data.rows || [];
    if (!rows.length) return { ok: true, fresh: 0, room: data.room };
    const recent = new Set(Array.isArray(db.live?.recentIds) ? db.live.recentIds : []);
    const firstRun = recent.size === 0;
    const fresh = rows.filter((r) => !recent.has(r.id)).slice(-20);
    for (const r of rows) recent.add(r.id);
    db.live = { recentIds: [...recent].slice(-200), lastAt: Date.now(), lastRoom: data.room?.roomId || '' };
    markDirty();
    if (firstRun) {
      addEvent('live-baseline', `直播弹幕基线：${rows.length} 条`);
      return { ok: true, baseline: true, fresh: 0, room: data.room };
    }
    if (!fresh.length) return { ok: true, fresh: 0, room: data.room };

    const hits = [];
    for (const row of fresh) {
      if (selfMid && row.uid === selfMid) continue; // 自己发的，别自问自答
      const mentioned = selfName ? row.text.includes(`@${selfName}`) : false;
      const fromOwner = s.ownerBiliMid && row.uid === String(s.ownerBiliMid);
      const wanted = s.liveScope === 'owner' ? Boolean(fromOwner) : mentioned;
      if (!wanted) continue;
      if (TEMPLATE_RE.test(row.text) && !fromOwner) continue;
      hits.push(row);
    }
    if (!hits.length) return { ok: true, fresh: fresh.length, hits: 0, room: data.room };

    const sent = [];
    for (const row of hits.slice(0, 2)) {
      const r = await composeReply(apiRef, { who: row.name, mid: row.uid, kind: 'live', text: row.text }, s);
      if (!r.ok) continue;
      if (s.dryRun) { sent.push({ ...row, text: r.text, dryRun: true }); continue; }
      try {
        const out = await sendDanmaku(s, { room: s.liveRoom, message: r.text, replyMid: row.uid, replyName: row.name });
        if (out.ok) {
          record({ type: 'danmaku', target: `room:${s.liveRoom}`, note: r.text, share: false, auto: true });
          sent.push({ ...row, reply: r.text });
          addEvent('live-reply', `回 ${row.name}：${truncate(r.text, 50)}`);
        } else if (out.risk) {
          riskStop(s, '直播弹幕', new Error(out.message || `code=${out.code}`));
          break;
        }
      } catch (error) {
        if (error?.risk) { riskStop(s, '直播弹幕', error); break; }
        logRef(`直播弹幕发送失败：${truncate(error?.message ?? error, 120)}`);
      }
    }
    return { ok: true, fresh: fresh.length, hits: hits.length, sent, room: data.room };
  } finally {
    running.live = false;
  }
}

// ── 睡眠计划 ─────────────────────────────────────────────────────────────

function todayPlan(s) {
  const now = tzNow(s.timeZone);
  const windows = parseWindows(s);
  const db = getDb();
  const day = now.dateKey;
  const counters = db.counters && db.counters.date === day ? db.counters : { date: day, wakes: 0, used: {} };
  const maxWakes = Math.min(12, Math.max(0, Number(s.maxWakesPerDay) || windows.reduce((n, w) => n + w.wakes, 0)));
  // ★ 每个分支都必须带 date。planTick 用 plan.date !== 今天 判断计划过没过期；
  //   以前 done 分支漏了 date，于是「今天不再醒」之后每 60 秒都重算一次计划、再记一条
  //   plan-done，200 条事件上限三个多小时就被冲干净，上午的记录全没了。
  if (maxWakes === 0) return { action: 'done', date: day, reason: '每天最多醒 0 次', counters, windows, maxWakes };
  if (counters.wakes >= maxWakes) return { action: 'done', date: day, reason: `今天已经醒了 ${counters.wakes} 次（上限 ${maxWakes}）`, counters, windows, maxWakes };
  const used = { ...(counters.used || {}) };
  const open = windows.filter((w) => w.end > now.minutes);
  if (!open.length) return { action: 'done', date: day, reason: '今天的窗口都过完了', counters, windows, maxWakes };
  const usable = open.filter((w) => (used[w.label] || 0) < w.wakes);
  if (!usable.length) return { action: 'done', date: day, reason: '所有窗口的醒来次数都用完了', counters, windows, maxWakes };
  const w = usable[Math.floor(Math.random() * usable.length)];
  // ★ 先掷「不看」，再决定要不要扣次数。
  //   跳过只是「这会儿不想看」，不该占用这个窗口的额度 —— 以前先扣后掷，
  //   6 次机会里 5 次被白白烧掉，一天只真醒 1 次，还把计数器写成「全用完了」。
  //   跳过之后 plan 一直挂到窗口结束才收尾，所以不会在同一个窗口反复重掷；
  //   等到下个窗口/下个时段，额度仍然是满的。
  if (Math.random() < Number(s.skipChance || 0)) {
    return {
      action: 'skip', date: now.dateKey, window: w.label, endAt: w.end, counters: { ...counters, used },
      reason: `这次不想看（掷到「不看」那 ${Math.round(Number(s.skipChance) * 100)}%）`
    };
  }
  // ★ 2026-10-23 修：**排计划时不再预扣名额**。
  //   以前这里立刻 `used[label]++`，于是"计划被丢弃"就等于"名额被吃掉"。
  //   实测（10-23 早上）：used 里 08:00–12:00 已经是 2/2，而 wakes 仍是 0 ——
  //   00:00 排过一次 08:15、01:17 重启后又排了一次 09:12，两次都没真醒，名额却满了。
  //   现在改成"**真醒了才扣**"（见 markPlan 的 woke 分支），丢计划不再有代价。
  const countersNext = counters;
  let at = w.start + Math.floor(Math.random() * Math.max(1, w.end - w.start));
  if (at <= now.minutes) at = Math.min(w.end - 1, now.minutes + 1 + Math.floor(Math.random() * 10));
  return {
    action: 'wake', date: now.dateKey, at, window: w.label, atText: `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`,
    maxVideos: s.maxVideos, counters: countersNext
  };
}

export function planTick(s) {
  const db = getDb();
  const now = tzNow(s.timeZone);
  const counters = db.counters && db.counters.date === now.dateKey ? db.counters : { date: now.dateKey, wakes: 0, used: {} };
  // 进程在长流程里被杀掉时，plan 会停在 fired=true / done=false；超过 30 分钟就当这一趟已经过去，
  // 否则重启后会一直“等待”到跨天。
  if (db.plan && db.plan.fired && !db.plan.done && Date.now() - Number(db.plan.firedAt || 0) > 30 * 60_000) {
    db.plan.done = true;
    markDirty();
  }
  if (!db.plan || db.plan.date !== now.dateKey || db.plan.done === true) {
    const p = todayPlan(s);
    db.plan = { ...p, createdAt: Date.now(), fired: false };
    db.counters = { ...counters, date: now.dateKey, used: p.counters?.used || counters.used || {} };
    markDirty();
    if (p.action === 'skip') addEvent('plan-skip', p.reason || '');
    if (p.action === 'wake') addEvent('plan-wake', `${p.atText} · ${p.window}`);
    if (p.action === 'done') {
      // 同一天、同一个理由只记一条。改设置会把未触发的 plan 置空再重算，
      // 所以判断依据不能放在 plan 上（置空后就没有上一条可比），改记在 db.meta 里。
      const key = String(p.reason || '');
      const last = db.meta?.planDone;
      if (!last || last.date !== now.dateKey || last.reason !== key) {
        addEvent('plan-done', key);
        db.meta = db.meta || {};
        db.meta.planDone = { date: now.dateKey, reason: key, at: Date.now() };
      }
    }
    return { action: 'planned', plan: db.plan };
  }
  const p = db.plan;
  if (p.action === 'skip' && !p.fired && now.minutes >= Number(p.endAt || now.minutes)) {
    return { action: 'skip-now', plan: p };
  }
  if (p.action === 'wake' && !p.fired && now.minutes >= Number(p.at || 0)) {
    return { action: 'wake-now', plan: p };
  }
  return { action: 'waiting', plan: p };
}

export function markPlan(plan, { fired = true, woke = false, done = false } = {}) {
  const db = getDb();
  if (!db.plan) return;
  db.plan = { ...db.plan, ...(plan || {}), fired, woke, done, firedAt: Date.now() };
  if (woke) {
    // 窗口额度改成"醒了才算"（与上面的配额修复配套）：同一窗口醒来 N 次就记 N 次。
    const label = String(db.plan.window || '');
    if (label) {
      db.counters = db.counters || { date: todayKey(), wakes: 0, used: {} };
      db.counters.used = db.counters.used || {};
      db.counters.used[label] = (Number(db.counters.used[label]) || 0) + 1;
    }
    db.counters = db.counters || { date: todayKey(), wakes: 0, used: {} };
    db.counters.wakes = (Number(db.counters.wakes) || 0) + 1;
    db.stats = db.stats || {};
    db.stats.totalWakes = (Number(db.stats.totalWakes) || 0) + 1;
  }
  markDirty();
}

// ── 主流程 ───────────────────────────────────────────────────────────────

/**
 * 这一轮的「记忆便签」：写进她自己的历史，让她下次真的记得刷过什么、写过什么。
 *
 * 刻意用第一人称、短句、只留触点（标题 + 分数 + 看过/听过 + 日记开头），
 * 不搬全文 —— 否则每轮几百上千字常驻上下文，既贵又容易盖住当前对话。
 */
export function formatMemoryNote(ctx, { trigger = 'clock' } = {}) {
  const hhmm = new Date().toTimeString().slice(0, 5);
  const lines = [`（我自己刷了会儿 B 站 · ${hhmm}）`];

  const deep = Array.isArray(ctx?.deep) ? ctx.deep : [];
  if (deep.length) {
    const items = deep.slice(0, 5).map((x) => {
      const title = truncate(String(x?.video?.title || '').trim(), 30);
      const sc = Number(x?.analysis?.score?.total);
      const how = x?.video?.watched ? '看过' : (x?.video?.hearing ? '听过' : '');
      return `《${title}》${Number.isFinite(sc) ? ` ${sc}/20` : ''}${how ? `（${how}）` : ''}`;
    });
    lines.push(`看了 ${deep.length} 条：${items.join('；')}`);
  } else if (Array.isArray(ctx?.previewed) && ctx.previewed.length) {
    lines.push(`刷了 ${ctx.previewed.length} 条，没有值得深看的。`);
  }

  if (ctx?.shared?.title) {
    // ★ 2026-10-24：评论模式下她说的是"我在评论区说了一句"，不再是"分享给他"
    lines.push(ctx.shared.mode === 'comment'
      ? `在《${truncate(ctx.shared.title, 30)}》底下评论了一句：${truncate(ctx.shared.comment || '', 60)}`
      : `把《${truncate(ctx.shared.title, 30)}》分享给他了。`);
  } else if (ctx?.shareReason) {
    lines.push(`这次没${ctx.postMode === 'comment' ? '评论' : '分享'}（${truncate(ctx.shareReason, 40)}）。`);
  }

  if (ctx?.diaryPublic) lines.push(`给主人的信里写了：${truncate(ctx.diaryPublic, 240)}`);
  if (ctx?.diaryPrivate) lines.push(`写给自己：${truncate(ctx.diaryPrivate, 200)}`);

  // 只有标题那一行没有信息量，不写
  return lines.length > 1 ? lines.join('\n') : '';
}

function formatReport(ctx) {
  const lines = [];
  const head = ctx.skipped ? `今天 ${ctx.atText || ''} 醒了一次，但这次不想看。` : `今天 ${ctx.atText || ''} 醒来，看了 ${ctx.previewed?.length || 0} 条，深读 ${ctx.deep?.length || 0} 条。`;
  lines.push(head);
  for (const [i, x] of (ctx.deep || []).slice(0, 4).entries()) {
    lines.push(`${i + 1}. 《${truncate(x.video.title, 40)}》 ${x.analysis.score.total}/20 — ${truncate(x.analysis.summary || '', 90)}`);
  }
  const isComment = (ctx?.shared?.mode || ctx?.postMode) === 'comment';
  if (ctx.shared?.url) {
    lines.push(isComment
      ? `\n在评论区留了一句：${ctx.shared.url}\n${truncate(ctx.shared.comment || '', 180)}`
      : `\n分享给你：${ctx.shared.url}\n${truncate(ctx.shared.comment || '', 180)}`);
  } else if (!ctx.skipped) {
    lines.push(`\n这次没${isComment ? '评论' : '分享'}：${ctx.shareReason || '没有达到“值得占用你注意力”的线。'}`);
  }
  if (ctx.diaryPublic) lines.push(`\n【给你的信】\n${truncate(ctx.diaryPublic, 700)}`);
  if (ctx.replies?.length) lines.push(`\n【谁找过她】\n${ctx.replies.map((r) => `· ${r.who}：${truncate(redact(r.text || '', ctx.s), 70)}`).join('\n')}`);
  return lines.filter(Boolean).join('\n');
}

/**
 * 完整醒来一轮。返回结构化报告；不抛异常（除 cancel 外都兜住）。
 */
export async function runWake(s, { trigger = 'clock', dryRun = false, maxVideos = null, deepReadCount = null, reason = '', silent = false } = {}) {
  if (running.wake) {
    const ageMs = Date.now() - wakeStartedAt;
    if (ageMs <= WAKE_STALE_MS) return { ok: false, busy: true, reason: '上一轮还在跑' };
    // 卡死的锁：记一条事件后强制释放，否则这个会话就永久废了
    addEvent('wake-stale-reset', `上一轮已跑 ${Math.round(ageMs / 60000)} 分钟仍未结束，强制释放锁`);
    running.wake = false;
  }
  running.wake = true;
  wakeStartedAt = Date.now();
  const started = Date.now();
  const date = todayKey(s.timeZone);
  const nowT = tzNow(s.timeZone);
  const db0 = getDb();
  db0.stats = db0.stats || {};
  db0.stats.lastWakeAt = started;
  markDirty();
  const ctx = {
    s, date, skipped: false, trigger,
    atText: `${String(nowT.h).padStart(2, '0')}:${String(nowT.min).padStart(2, '0')}`,
    previewed: [], deep: [], shared: null, shareReason: '', diaryPublic: '', diaryPrivate: '', replies: []
  };
  try {
    addEvent('wake-start', `${trigger}${dryRun ? ' · 演练' : ''}`);
    // 点亮「她这会儿在 B 站」——与旅行/睡觉并行，不顶掉它们。
    // until 是防进程被杀后信标卡住的 TTL（正常路径由 finally 清掉）。
    const actUntil = started + DEEP_TOTAL_MS + 10 * 60_000;
    setActivity({ busy: true, since: started, until: actUntil, stage: '选题', title: '', index: 0, total: 0 });
    const login = await checkLogin(s);
    setLoginSnapshot(login);
    if (!login.ok) {
      const why = `登录态不可用：${login.reason || '未知原因'}。先不动 B 站，只做本地检查。`;
      addEvent('login-failed', why);
      if (s.notifyOnError) void notify(s, why, { kind: 'error' });
      return { ok: false, reason: why, needLogin: true, elapsedMs: Date.now() - started };
    }

    const wanted = Math.max(1, Number(maxVideos) || Number(s.maxVideos) || 5);
    let candidates = [];
    try {
      candidates = await collectCandidates(s, { limit: wanted });
    } catch (error) {
      if (error?.risk) { riskStop(s, '选题', error); return { ok: false, reason: truncate(error?.message ?? error, 160), risk: true }; }
      throw error;
    }
    if (!candidates.length) {
      ctx.skipped = false;
      ctx.shareReason = '今天没有捞到没看过的新视频。';
      addEvent('wake-empty', '没有候选');
    }

    // 初筛（并发 2，避免把 B 站接口打爆）
    const previews = [];
    await mapLimit(candidates, 2, async (c) => {
      try {
        const p = await withTimeout(previewVideo(s, c.bvid), 65_000, `初筛 ${c.bvid}`);
        previews.push(p);
      } catch (error) {
        if (error?.risk) throw error;
        logRef(`初筛 ${c.bvid} 失败：${truncate(error?.message ?? error, 100)}`);
      }
      return null;
    });
    ctx.previewed = previews;
    const db = getDb();
    db.seen = db.seen || {};
    for (const p of previews) db.seen[p.bvid] = Date.now();
    markDirty();

    // 深读：按启发式分数取前 N
    const deepN = Math.max(0, Math.min(Number(deepReadCount) || Number(s.deepReadCount) || 3, previews.length));
    const byScore = [...previews].sort((a, b) => (b.analysis?.score?.total || 0) - (a.analysis?.score?.total || 0));
    // 单条给足预算（见 deepReadBudget），但几条加起来有总时限：
    // 否则一轮会拖到被 WAKE_STALE_MS 判成卡死 —— 那才是真的会重复发消息。
    const perVideo = deepReadBudget(s);
    const deepDeadline = Date.now() + DEEP_TOTAL_MS;
    for (const p of byScore.slice(0, deepN)) {
      const left = deepDeadline - Date.now();
      if (left < 60_000) {
        logRef(`[bili-whale] 深读总时限到了（${Math.round(DEEP_TOTAL_MS / 60000)} 分钟），剩下 ${deepN - ctx.deep.length} 条留给下一轮`);
        break;
      }
      setActivity({
        busy: true, since: started, until: actUntil, stage: '看视频',
        title: String(p.video?.title || ''), index: ctx.deep.length + 1, total: deepN
      });
      const t0 = Date.now();
      try {
        const d = await withTimeout(deepReadVideo(s, p.bvid, p), Math.min(perVideo, left), `深读 ${p.bvid}`);
        d.elapsedMs = Date.now() - t0;
        ctx.deep.push(d);
        // ★ 成功也要记一笔。以前只在失败时打日志，所以"从没看成过"这件事
        //   在日志里长得像"运气不好"，藏了整整一天。
        const how = d.video?.watched ? '看过画面' : d.video?.hearing ? '听过声音' : '只有文字';
        logRef(`[bili-whale] 深读 ${p.bvid} 完成：${Math.round(d.elapsedMs / 1000)}s（${how}）`);
      } catch (error) {
        if (error?.risk) throw error;
        logRef(`深读 ${p.bvid} 失败（耗时 ${Math.round((Date.now() - t0) / 1000)}s）：${truncate(error?.message ?? error, 100)}`);
      }
    }
    ctx.deep.sort((a, b) => (b.analysis?.score?.total || 0) - (a.analysis?.score?.total || 0));

    // 「对外说一句」：只考虑当天深读里的第一名，达到阈值才发。
    // ★ 2026-10-24：默认模式改成**在视频下评论**（comment）；`postMode:'share'` 才回到老的 @主人分享。
    const postMode = s.postMode === 'share' ? 'share' : 'comment';
    ctx.postMode = postMode;
    const best = ctx.deep[0];
    if (best && s.shareEnabled) {
      const gate = canShare(s, best.bvid, { mode: postMode });
      if (!gate.ok) {
        ctx.shareReason = gate.reason;
      } else if ((best.analysis?.score?.total || 0) < s.shareMinScore) {
        ctx.shareReason = `最高分 ${best.analysis?.score?.total || 0}/20，没到阈值 ${s.shareMinScore}；“今天没有值得发的”是合法结果。`;
      } else {
        const r = await shareVideo(s, {
          bvid: best.bvid,
          analysis: best.analysis,
          video: best.video,
          score: best.analysis.score.total,
          reason: best.analysis.reason,
          dryRun,
          manual: false
        });
        if (r.ok) {
          ctx.shared = {
            bvid: best.bvid, title: best.video.title, url: r.url, comment: r.comment,
            mode: r.mode || postMode, dryRun: Boolean(r.dryRun)
          };
        } else {
          ctx.shareReason = r.reason || '这次没发出去';
        }
      }
    } else if (!s.shareEnabled) {
      ctx.shareReason = postMode === 'comment' ? '评论开关关着（只看不说）' : '分享开关关着（只看不说）';
    } else {
      ctx.shareReason = '没有深读结果，今天不发。';
    }

    // 收件箱摘要（不自动回；评论监听循环会处理，这里只让主人知道）
    try {
      const inbox = [];
      for (const kind of ['reply', 'at']) {
        try {
          const r = await msgfeed(s, kind, { pages: 1 });
          for (const item of r.items.slice(0, 5)) {
            const t = Number(item.t || 0) * 1000;
            if (t && Date.now() - t < 24 * 3600_000) inbox.push({ ...item, bvid: bvidFromUri(item.uri), text: item.source || item.title || '' });
          }
        } catch { /* 单个收件箱失败不影响 */ }
      }
      ctx.replies = inbox.slice(0, 8);
    } catch { /* ignore */ }

    // 两本日记（没有模型也能写）
    if (s.diaryEnabled) {
      const d = await writeDiaries(apiRef, {
        date, watched: ctx.deep.length ? ctx.deep : ctx.previewed,
        shared: ctx.shared, skipped: ctx.skipped, reason,
        replies: ctx.replies
      }, s);
      ctx.diaryPublic = d.public || '';
      ctx.diaryPrivate = d.private || '';
      addEntries(s, { publicText: ctx.diaryPublic, privateText: ctx.diaryPrivate, date, meta: { bvs: ctx.deep.map((x) => x.bvid), shares: ctx.shared ? 1 : 0, trigger } });
    }

    // 报备主人
    const report = formatReport(ctx);
    if (!silent && (s.notifyOnDiary || (ctx.shared && s.notifyOnShare))) {
      await notify(s, report, { kind: 'wake', force: trigger === 'manual' });
    }

    // 2026-10-21：把这一轮写进**她自己**的历史（只记账、不发送）。
    // notify 发出去的是"给主人看的报告"；她自己的那份记忆在这里 ——
    // 否则她只知道"跑了一轮"，却想不起看了什么、日记写了什么。
    if (s.rememberInHistory !== false) {
      try {
        const note = formatMemoryNote(ctx, { trigger });
        if (note && appendToHistory(s, note)) {
          addEvent('remember', truncate(note.replace(/\s+/g, ' '), 120));
          logRef(`[bili-whale] 已写进她的历史：${truncate(note.replace(/\s+/g, ' '), 80)}`);
        } else {
          logRef('[bili-whale] 没能写进历史（还没捕获到 store 或 notifyChat 为空）');
        }
      } catch (e) {
        logRef(`[bili-whale] 写历史失败：${truncate(e?.message ?? e, 100)}`);
      }
    }
    addEvent('wake-done', `初筛 ${ctx.previewed.length}，深读 ${ctx.deep.length}，分享 ${ctx.shared ? 1 : 0}`);
    {
      const dbx = getDb();
      dbx.stats = dbx.stats || {};
      dbx.stats.lastWakeResult = {
        at: Date.now(), ok: true, trigger,
        previewed: ctx.previewed.length,
        deep: ctx.deep.length,
        shared: ctx.shared ? ctx.shared.bvid : '',
        shareReason: ctx.shareReason || ''
      };
      markDirty();
    }
    return {
      ok: true,
      dryRun: Boolean(dryRun),
      trigger,
      date,
      previewed: ctx.previewed.length,
      deep: ctx.deep.map((x) => ({
        bvid: x.bvid,
        title: x.video.title,
        author: x.video.author,
        duration: x.video.duration,
        score: x.analysis.score,
        summary: x.analysis.summary,
        reason: x.analysis.reason,
        points: x.analysis.points,
        source: x.analysis.source
      })),
      shared: ctx.shared,
      shareReason: ctx.shareReason,
      diaryPublic: ctx.diaryPublic,
      diaryPrivate: ctx.diaryPrivate,
      replies: ctx.replies.map((r) => ({ who: r.who, text: truncate(r.text, 120), uri: r.uri })),
      report,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    if (error?.risk) {
      riskStop(s, '主流程', error);
      return { ok: false, reason: truncate(error?.message ?? error, 200), risk: true, elapsedMs: Date.now() - started };
    }
    addEvent('wake-error', truncate(error?.message ?? error, 200));
    if (s.notifyOnError) void notify(s, `这一轮没跑完：${truncate(redact(error?.message ?? error, s), 200)}`, { kind: 'error' });
    return { ok: false, reason: truncate(error?.message ?? error, 300), elapsedMs: Date.now() - started };
  } finally {
    running.wake = false;
    clearActivity();          // 不管成功失败，别把"她在刷B站"留在外面
    // 忙的时候收到过手动请求 → 这一轮一结束立刻补跑（别让主人的操作石沉大海）
    const pending = pendingManualWake;
    pendingManualWake = null;
    if (pending) {
      addEvent('wake-queued-start', '上一轮结束后补跑排队中的手动请求');
      setTimeout(() => {
        runWake(s, { trigger: 'manual', dryRun: pending.dryRun, silent: true }).catch(() => {});
      }, 1500);
    }
  }
}

/** 掷到“不看”的夜晚：也要写两本日记说明理由，并报备。 */
export async function runSkip(s, { reason = '', trigger = 'clock', silent = false } = {}) {
  const date = todayKey(s.timeZone);
  const why = String(reason || '今天就是不想看').slice(0, 300);
  addEvent('skip', why);
  let diaryPublic = '';
  let diaryPrivate = '';
  if (s.diaryEnabled) {
    const d = await writeDiaries(apiRef, { date, watched: [], skipped: true, reason: why, shared: null, replies: [] }, s);
    diaryPublic = d.public || '';
    diaryPrivate = d.private || '';
    addEntries(s, { publicText: diaryPublic, privateText: diaryPrivate, date, meta: { skipped: true, trigger } });
  }
  if (!silent && s.notifyOnDiary) {
    await notify(s, `今天这次不想看。\n理由：${truncate(why, 200)}${diaryPublic ? `\n\n【给你的信】\n${truncate(diaryPublic, 600)}` : ''}`, { kind: 'skip' });
  }
  return { ok: true, skipped: true, reason: why, diaryPublic, diaryPrivate };
}

// ── 草稿 / 状态 ──────────────────────────────────────────────────────────

export function listDrafts() {
  const db = getDb();
  return (Array.isArray(db.drafts) ? db.drafts : []).filter((d) => d.status === 'pending').slice(-20);
}

export async function approveDraft(s, id) {
  const draft = findDraft(id);
  if (!draft) return { ok: false, reason: `没有找到草稿 ${id}` };
  const r = await replyToItem(s, draft, { text: draft.text, manual: true });
  if (r.ok) {
    removeDraft(id);
    addEvent('draft-approved', `${draft.who}：${truncate(r.comment || '', 60)}`);
  }
  return r;
}

export function rejectDraft(s, id, reason = '') {
  const draft = findDraft(id);
  if (!draft) return { ok: false, reason: `没有找到草稿 ${id}` };
  removeDraft(id);
  addEvent('draft-rejected', `${draft.who}${reason ? `：${truncate(reason, 80)}` : ''}`);
  return { ok: true, id, who: draft.who, reason };
}

export function statusSnapshot(s) {
  const db = getDb();
  const q = quotaStatus(s);
  const sil = silence(s);
  const today = todaySummary(s);
  return {
    enabled: Boolean(s.enabled),
    dryRun: Boolean(s.dryRun),
    ownerQQ: s.ownerQQ,
    notifyChat: defaultChat(s),
    channel: hasChannel() ? 'host' : (s.onebotHttpUrl ? 'http' : 'none'),
    login: db.stats?.login || null,
    plan: db.plan || null,
    counters: db.counters || null,
    windows: parseWindows(s).map((w) => `${w.label}×${w.wakes}`),
    quota: q,
    silence: sil,
    drafts: listDrafts().length,
    diaryToday: today,
    persona: db.meta?.personaCatalog?.current || null,
    personaCatalog: db.meta?.personaCatalog || null,
    lastWakeAt: Number(db.stats?.lastWakeAt) || 0,
    lastWakeResult: db.stats?.lastWakeResult || null,
    totalWakes: Number(db.stats?.totalWakes) || 0,
    totalShares: Number(db.stats?.totalShares) || 0,
    riskAt: Number(db.stats?.riskAt) || 0,
    events: (Array.isArray(db.events) ? db.events : []).slice(-12).reverse()
  };
}

export function formatStatus(s) {
  const x = statusSnapshot(s);
  const lines = [
    `B站鲸鱼：${x.enabled ? '已启用' : '未启用'}${x.dryRun ? '（演练模式）' : ''}`,
    `登录：${x.login?.ok ? `${x.login.uname || '已登录'}（mid ${x.login.mid}）` : (x.login?.reason || '还没检查')}`,
    `窗口：${x.windows.join(' · ') || '(无)'}｜今天已醒 ${x.counters?.wakes || 0} 次`,
    `计划：${x.plan?.action === 'wake' ? `${x.plan.atText} 醒来（${x.plan.window}）` : x.plan?.action === 'skip' ? `这次不看（${x.plan.window}）` : x.plan?.reason || '等待生成'}`,
    `人设：${x.persona?.name ? `${x.persona.name}（${x.persona.source}）` : '还没解析（去设置里填/选宿主人设卡）'}`,
    `额度：分享 ${x.quota.shares}/${x.quota.shareCap}｜沉默 ${x.silence.days} 天｜剩余 ${x.quota.remaining}`,
    `草稿：${x.drafts} 条待审`,
    `推送通道：${x.channel === 'host' ? '宿主 sender（已接上）' : x.channel === 'http' ? 'OneBot HTTP' : '还没有（等首条消息）'}`,
    // 看视频 / 听觉（2026-10-21）：能不能"看"，看不了时能不能"听"
    `看视频：${s.watchEnabled
      ? `开（${Math.round(Number(s.watchSlices) || 2)} 段 × ${Math.round(Number(s.watchSec) || 12)}s，原生视频输入 ${s.watchModel || s.hearingModel || s.llmModel || '未配模型'}）`
      : '关（只看字幕/弹幕/热评）'}`
      + `｜听觉兜底：${s.hearingEnabled ? `开（${Math.round(Number(s.hearingSlices) || 3)} 段 × ${Math.round(Number(s.hearingSliceSec) || 28)}s${s.hearingBackupBaseUrl ? '，含备用通道' : ''}）` : '关'}`,
    // 动态：读首页跟着登录态；发动态是显式开关 + 每日上限
    `动态：发动态${s.postEnabled ? `开（今天 ${postedToday(s)}/${Number(s.postDailyMax) || 0 || '不限'} 条）` : '关'}｜读首页跟着登录态`,
    x.diaryToday.has ? `\n今天的日记：\n${truncate(x.diaryToday.public || x.diaryToday.private, 500)}` : '',
    x.events.length ? `\n最近事件：\n${x.events.slice(0, 6).map((e) => `· ${new Date(e.at).toLocaleTimeString('zh-CN')} ${e.kind} ${truncate(e.note || '', 70)}`).join('\n')}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

/** 评论收件箱摘要文本（工具/报告用，不回复）。 */
export async function inboxDigest(s, { hours = 24 } = {}) {
  const since = Math.floor(Date.now() / 1000) - Math.max(1, hours) * 3600;
  const out = [];
  for (const kind of ['reply', 'at']) {
    try {
      const r = await msgfeed(s, kind, { pages: 1 });
      for (const item of r.items) {
        if (Number(item.t || 0) && Number(item.t || 0) < since) continue;
        out.push({ ...item, bvid: bvidFromUri(item.uri), text: item.source || item.title || '' });
      }
    } catch { /* ignore */ }
  }
  out.sort((a, b) => Number(a.t || 0) - Number(b.t || 0));
  if (!out.length) return { ok: true, items: [], text: `最近 ${hours} 小时没有人找她。` };
  const text = out.slice(0, 12).map((x) => `· ${x.kind === 'at' ? '@' : '回复'} ${x.who}（${new Date(Number(x.t || 0) * 1000).toLocaleString('zh-CN')}）：${truncate(redact(x.text || '', s), 90)}`).join('\n');
  return { ok: true, items: out, text: `最近 ${hours} 小时有 ${out.length} 条：\n${text}` };
}

export { formatDiary, listDiaries, addEntries, todaySummary, quotaStatus };
