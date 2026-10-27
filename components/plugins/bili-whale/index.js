// bili-whale / index.js
//
// QQ Agent 自包含插件入口。
//
// 只用宿主公开契约：
//   setup(api) / activate / deactivate / dispose
//   api.config() / api.storage / api.registerTool / api.capability('ai.ask') / api.fetch
//   hooks.onMessage
//   configSchema 里的 action 面板
//
// 不 import ../../src/*（唯一例外：lib/persona.js 只读 import config/personas 来读宿主人设卡，
// 失败自动降级）、不 import fs/child_process、不写插件目录、不注册 HTTP 路由。
// 所以：整目录复制到 plugins/ 即可加载，删除即卸载，热重载不会留下定时器。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings as readSettings, todayKey, truncate, hasCookie, hasLlm } from './lib/util.js';
import { initStore, flush, addEvent, ensureDay, storageError, findDraft, removeDraft, setSettingsSnapshot } from './lib/store.js';
import { initBili, diagnose, videoContent, liveInfo, liveHistory, sendDanmaku } from './lib/bili.js';
import { initLlm } from './lib/llm.js';
import { initRuntime, runWake, deepReadVideo, collectCandidates, shareVideo, replyToItem, approveDraft, rejectDraft, listDrafts, formatStatus, statusSnapshot, inboxDigest, clearActivity } from './lib/runtime.js';
import { initNotify, adoptChannels, notify, defaultChat, sendText } from './lib/notify.js';
import { initHearing } from './lib/hearing.js';
import { initWatch } from './lib/watch.js';
import { homeFeed, postDynamic } from './lib/feed.js';
import { addEntries, formatDiary } from './lib/diary.js';
import { status as quotaStatus, silence, markFeedback } from './lib/quota.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { handleCommand, isCommand } from './lib/commands.js';
import { publishPersonaCatalog, personaOf, hostPersonaCatalog, resolveCardRef, savePersonaSelection } from './lib/persona.js';

let apiRef = null;
let sched = null;
let watchdog = null;
let disposed = false;
let lastOwnerFeedbackAt = 0;

const log = (...args) => { try { apiRef?.log?.(...args); } catch { /* ignore */ } };
const warn = (...args) => { try { apiRef?.warn?.(...args); } catch { /* ignore */ } };

function adopt(ctx) {
  try { adoptChannels(ctx); } catch { /* ignore */ }
}

function isActiveNow() {
  try {
    if (typeof apiRef?.isSkillActive !== 'function') return true;
    return apiRef.isSkillActive('bili-whale', {}) !== false;
  } catch { return true; }
}

function ensureScheduler(s) {
  if (disposed) return;
  try { setSettingsSnapshot(s); } catch { /* ignore */ }
  const active = isActiveNow();
  if (!active || !s.enabled) {
    if (sched) { stopScheduler(!active ? '插件总开关关着' : '自主作息关着'); sched = null; }
    return;
  }
  if (sched) return;
  try {
    sched = startScheduler(apiRef, log);
  } catch (error) {
    warn(`[bili-whale] 定时器启动失败：${truncate(error?.message ?? error, 160)}`);
    sched = null;
  }
}

/**
 * 60 秒小看门狗：宿主保存设置时不一定调用 activate（只改设置、不动总开关）。
 * 有了它，用户把「启用自主作息」从关改到开后，最多一分钟就会自己跑起来，
 * 不必等到下一条 QQ 消息。开销只有一次同步读配置 + 一次 isSkillActive。
 */
function ensureWatchdog() {
  if (watchdog || disposed) return;
  watchdog = setInterval(() => {
    if (disposed) return;
    try { ensureScheduler(readSettings(apiRef)); } catch { /* ignore */ }
    // 宿主人设卡可能被用户改了；把目录镜像到 storage 给面板看（不含正文）。
    try { void publishPersonaCatalog(apiRef); } catch { /* ignore */ }
  }, 60_000);
  if (typeof watchdog?.unref === 'function') watchdog.unref();
}

function stopWatchdog() {
  if (!watchdog) return;
  try { clearInterval(watchdog); } catch { /* ignore */ }
  watchdog = null;
}

function result(content, isError = false) {
  return { content: truncate(String(content ?? ''), 28000), ...(isError ? { isError: true } : {}) };
}

function toolRunner(fn) {
  return async (ctx, args = {}) => {
    adopt(ctx);
    const s = readSettings(apiRef);
    ensureDay(todayKey(s.timeZone));
    try {
      return await fn(ctx || {}, args || {}, s);
    } catch (err) {
      const msg = `✗ ${truncate(err?.message ?? err, 400)}`;
      warn(`[bili-whale] 工具失败：${truncate(err?.message ?? err, 200)}`);
      return result(msg, true);
    }
  };
}

/** 长任务跑完后把结果补到“发起它的那个会话”；拿不到就推给主人。 */
async function reportToChat(s, ctx, text) {
  const chatKey = String(ctx?.chatKey || '').trim();
  if (chatKey) {
    const r = await sendText(s, text, { chatKey });
    if (r.ok) return;
  }
  await notify(s, text, { kind: 'tool-run', force: true });
}

function candidatestText(list) {
  return list.map((x, i) => `${i + 1}. ${x.bvid} 《${truncate(x.title, 44)}》 UP ${truncate(x.author, 18)}｜${x.duration}s｜弹幕 ${x.danmaku}｜播放 ${x.play}｜${x.source}`).join('\n');
}

function draftText(list) {
  if (!list.length) return '没有待审草稿。';
  return `待审 ${list.length} 条：\n` + list.map((d) => `· ${d.id}｜${d.who}：${truncate(d.src, 100)}\n  草稿：${d.text ? truncate(d.text, 120) : '（批准时再生成）'}\n  批准：/鲸鱼 批准 ${d.id}｜拒绝：/鲸鱼 拒绝 ${d.id}`).join('\n');
}

const TOOLS = [
  {
    id: 'status',
    name: 'B站鲸鱼状态',
    description: '查看 B站鲸鱼是否启用、登录态、今天的醒来计划、分享额度、沉默天数、待审草稿、今天的日记和最近事件。用户问“你看了什么/额度还剩多少/计划是什么/为什么没分享”时调用。',
    category: 'query',
    icon: '🐳',
    parameters: { type: 'object', properties: {} },
    execute: toolRunner(async () => {
      const s = readSettings(apiRef);
      await publishPersonaCatalog(apiRef);
      const snap = statusSnapshot(s);
      const q = quotaStatus(s);
      const sil = silence(s);
      const body = [
        formatStatus(s),
        '',
        `草稿：\n${draftText(listDrafts())}`,
        snap.diaryToday.has ? `\n今天的日记：\n${snap.diaryToday.public || snap.diaryToday.private}` : '',
        `\n分享账本：${q.shares}/${q.shareCap}｜沉默 ${sil.days} 天（上限 ${sil.cap}）`
      ].filter(Boolean).join('\n');
      return result(body);
    })
  },
  {
    id: 'bili_feed',
    name: '刷新B站动态',
    description: '拉取 B 站动态首页——关注的人在发什么。返回作者、时间、类型、正文摘要与链接。用户问“B站动态/关注的人最近发了什么/首页有什么”时调用。只读，不会改动任何东西。',
    category: 'query',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多几条，默认 12（上限 30）' },
        type: { type: 'string', description: '筛选类型：all（默认）/ video / draw / word / forward' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const r = await homeFeed(s, {
        limit: Math.max(1, Math.min(30, Number(args.limit) || 12)),
        type: String(args.type || 'all')
      });
      if (!r.ok) return result(`✗ 拉不到动态：${r.error}`, true);
      if (!r.items.length) return result('动态首页是空的（可能关注的人都没发新动态）');
      const lines = r.items.map((x, i) => {
        const when = x.ts ? new Date(x.ts * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
        return `${i + 1}. ${x.author}｜${x.kind}｜${when}\n   ${x.text}${x.extra && x.extra !== x.text ? `\n   补充：${x.extra}` : ''}${x.link ? `\n   ${x.link}` : ''}`;
      });
      return result(`动态首页（${r.count} 条${r.updateNum ? `，有 ${r.updateNum} 条新动态` : ''}）：\n\n${lines.join('\n\n')}`);
    })
  },
  {
    id: 'bili_post_dynamic',
    name: '发B站动态',
    description: '发一条纯文字 B 站动态（公开可见、能删但会留痕）。**只在用户明确要求“发个B站动态/发条动态”时调用**，正文按用户意思写，≤2000 字，不要自己加话题词和 @。没在设置里开启发布权限会直接拒绝；演练模式下只回显不发送。',
    category: 'action',
    icon: '✍️',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '动态正文（纯文字，≤2000 字）' },
        dryRun: { type: 'boolean', description: '只演练不真的发送' }
      },
      required: ['text']
    },
    execute: toolRunner(async (ctx, args, s) => {
      if (!s.postEnabled) return result('✗ 发动态没开启：插件设置里把「允许发动态」打开再说', true);
      const r = await postDynamic(s, { text: args.text, dryRun: args.dryRun === true });
      if (!r.ok) return result(`✗ 没发出去：${r.error}`, true);
      if (r.dryRun) return result(`（演练模式，没有真的发）本来会发：\n${r.text}`);
      return result(`✓ 已发出：${r.url}\n\n${r.text}`);
    })
  },
  {
    id: 'run',
    name: '让鲸鱼醒一轮',
    description: '立刻执行一整轮：按偏好选题 → 读字幕/弹幕/热评 → 深读 1-3 条 → 写两本日记 → 达到阈值才分享给主人。会消耗网络和模型额度。调用后立即返回“已开始”，完整报告稍后补到当前会话（或主人私聊）。用户明确说“现在去看/醒一轮/手动跑一次”时调用。',
    category: 'system',
    icon: '🌙',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '演练：照常选题/深读/写日记/推送，但不对外发评论' },
        maxVideos: { type: 'number', description: '初筛几条，默认 3（工具里控制时长，最多 8）' },
        deepReadCount: { type: 'number', description: '深读几条，默认 2（最多 5）' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const maxVideos = Math.max(1, Math.min(8, Number(args.maxVideos) || 3));
      const deepReadCount = Math.max(1, Math.min(5, Number(args.deepReadCount) || 2));
      const dryRun = args.dryRun === true;
      // 一整轮会联网 + 调模型，可能超过工具 120 秒护栏；这里立即返回，
      // 跑完把完整报告补到发起它的会话（拿不到会话就推主人）。
      Promise.resolve()
        .then(() => runWake(s, { trigger: 'manual', dryRun, maxVideos, deepReadCount, silent: true }))
        .then(async (out) => {
          const c = out.ok && out.shared && out.shared.comment;
          const text = out.ok
            ? (c
              ? `${out.dryRun ? '✓ 演练完成（未发出）' : '✓ 已分享'}：\n\n${c}`
              : '✓ 跑完了，这轮没到分享线，没写评论。')
            : `✗ 这一轮没跑完：${out.reason || '未知原因'}`;
          await reportToChat(s, ctx, text);
        })
        .catch(async (error) => {
          try { await reportToChat(s, ctx, `✗ 醒来失败：${truncate(error?.message ?? error, 300)}`); } catch { /* ignore */ }
        });
      return result(`✓ 已开始跑一轮${dryRun ? '（演练，不对外发）' : ''}。\n跑完把评论发到这个会话；也可以先用 bili-whale__status 看进度。`);
    })
  },
  {
    id: 'feed',
    name: 'B站选题候选',
    description: '按主人的偏好关键词 + 热门/排行/关注流捞候选视频，排除最近看过的。只返回候选列表，不深读、不发。用户问“今天能看什么/帮我找视频”时调用。',
    category: 'query',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：只按这个关键词搜' },
        limit: { type: 'number', description: '最多几条，默认 8' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const list = await collectCandidates(s, { limit: Math.max(1, Math.min(15, Number(args.limit) || 8)), keyword: String(args.keyword || '').trim() });
      if (!list.length) return result('没有捞到没看过的新视频。');
      return result(`候选 ${list.length} 条：\n${candidatestText(list)}`);
    })
  },
  {
    id: 'debrief',
    name: '深读一条B站视频',
    description: '给一个 BV 号，拉元信息、标签、官方字幕、弹幕热区、热评，并让模型做五维评分与摘要。只读，不分享、不评论。用户贴了 BV 号或问“这个视频讲了什么”时调用。',
    category: 'query',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号，例如 BV1xx411c7mD' }
      },
      required: ['bvid']
    },
    execute: toolRunner(async (ctx, args, s) => {
      const bvid = String(args.bvid || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || '';
      if (!bvid) return result('没有识别出 BV 号。', true);
      const d = await deepReadVideo(s, bvid);
      return result([
        `《${d.video.title}》`,
        `UP ${d.video.author}｜${d.video.duration}s｜${d.video.tname}`,
        `评分 ${d.analysis.score.total}/20（信息 ${d.analysis.score.info}｜偏好 ${d.analysis.score.fit}｜新颖 ${d.analysis.score.novelty}｜情绪 ${d.analysis.score.emotion}｜质量 ${d.analysis.score.quality}）`,
        `摘要：${d.analysis.summary}`,
        d.analysis.points?.length ? `看点：\n${d.analysis.points.map((p) => `· ${p}`).join('\n')}` : '',
        `理由：${d.analysis.reason}`,
        d.analysis.comment ? `分享文案：${d.analysis.comment}` : '',
        `素材：字幕 ${d.video.subtitle?.lines?.length || 0} 行｜弹幕 ${d.video.danmaku?.length || 0} 条｜热评 ${d.video.comments?.length || 0} 条`,
        // 2026-10-21：把"看/听"的结果显式写进返回值。
        // 原来这行之后只有字幕/弹幕/热评，看视频成没成在外面完全看不出来 ——
        // 用户只能凭"摘要里有没有画面"猜，很容易误判成"压根没看"。
        d.video.watched
          ? `看视频（原生视频输入，画面+声音，按时间抽样）：\n${truncate(d.video.watched.replace(/\s+/g, ' '), 700)}`
          : '看视频：本轮没有产出',
        d.video.hearing && !d.video.watched
          ? `听觉（只听声音、没有画面）：${truncate(d.video.hearing.replace(/\s+/g, ' '), 400)}`
          : '',
        `\n${truncate(d.video.subtitle?.text || d.video.desc || '', 2000)}`
      ].filter(Boolean).join('\n'));
    })
  },
  {
    id: 'diary',
    name: '读写鲸鱼日记',
    description: '读两本日记（public=给他的信，private=写给自己），或替她补写一篇。写日记必须给 which 和 text。用户问“日记写了什么/读给我听”时用 read；用户明确要求“把这段写进日记”时用 write。',
    category: 'query',
    icon: '📔',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'], description: 'read 或 write' },
        which: { type: 'string', enum: ['public', 'private'], description: '哪一本，默认 public' },
        days: { type: 'number', description: '读最近几天，默认 1' },
        date: { type: 'string', description: '写入的日期 YYYY-MM-DD，默认今天' },
        text: { type: 'string', description: 'write 时的正文' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const which = args.which === 'private' ? 'private' : 'public';
      if (args.action === 'write') {
        if (!String(args.text || '').trim()) return result('写日记要给 text。', true);
        if (which === 'private') addEntries(s, { privateText: args.text, date: args.date || todayKey(s.timeZone) });
        else addEntries(s, { publicText: args.text, date: args.date || todayKey(s.timeZone) });
        return result(`✓ 已写进${which === 'private' ? '「写给自己」' : '「给他的信」'}。`);
      }
      return result(formatDiary(s, { which, days: Math.max(1, Math.min(30, Number(args.days) || 1)), limit: 10 }));
    })
  },
  {
    id: 'share',
    name: '分享B站视频',
    description: '把一条视频以评论形式分享给主人（正文会自动 @ 主人）。仍受代码硬限制：每日分享额度、评分阈值、同一视频 N 天一次、沉默衰减。用户明确说“把这条分享给我/发这条”时调用；不满足条件要如实返回原因，不要绕过。',
    category: 'message',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        text: { type: 'string', description: '可选：指定评论正文；不填会按视频内容生成' },
        reason: { type: 'string', description: '为什么值得占用主人注意力（至少 8 字）' },
        score: { type: 'number', description: '可选：五维总分 0-20；不填用启发式评分' },
        dryRun: { type: 'boolean', description: '演练，不真的发' }
      },
      required: ['bvid']
    },
    execute: toolRunner(async (ctx, args, s) => {
      const bvid = String(args.bvid || '').match(/BV[0-9A-Za-z]{10}/)?.[0] || '';
      if (!bvid) return result('没有识别出 BV 号。', true);
      const video = await videoContent(s, bvid, { commentCount: 8, needSubtitles: true });
      const d = await deepReadVideo(s, bvid, { video, analysis: null });
      const score = Number.isFinite(Number(args.score)) ? Number(args.score) : d.analysis.score.total;
      const reason = String(args.reason || d.analysis.reason || '').trim();
      const out = await shareVideo(s, {
        bvid, video, analysis: d.analysis, score, reason,
        text: String(args.text || ''), manual: true,
        dryRun: args.dryRun === true
      });
      if (!out.ok) return result(`✗ 没发：${out.reason || '未知原因'}`);
      return result(out.dryRun ? `✓ 演练完成（未发出）：\n${out.comment}` : `✓ 已分享：${out.url || ''}\n${out.comment}`);
    })
  },
  {
    id: 'pending',
    name: '待审回复草稿',
    description: '管理“陌生人评论 → 先写草稿等主人批准”的队列。action=list 看草稿，approve 批准并发出，reject 拒绝。用户说“有谁找我/待审有哪些/批准第 N 条”时调用。',
    category: 'message',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'approve', 'reject'], description: '默认 list' },
        id: { type: 'string', description: '草稿 id' },
        text: { type: 'string', description: 'approve 时可替换正文' },
        reason: { type: 'string', description: 'reject 的理由' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const action = String(args.action || 'list');
      if (action === 'list') return result(draftText(listDrafts()));
      const id = String(args.id || '').trim();
      if (!id) return result('要给草稿 id。', true);
      if (action === 'reject') {
        const out = rejectDraft(s, id, String(args.reason || ''));
        return result(out.ok ? `✓ 已拒绝 ${id}。` : out.reason, !out.ok);
      }
      const out = String(args.text || '').trim()
        ? await (async () => {
          const d = findDraft(id);
          if (!d) return { ok: false, reason: `没有找到草稿 ${id}` };
          const r = await replyToItem(s, d, { text: String(args.text), manual: true });
          if (r.ok) removeDraft(id);
          return r;
        })()
        : await approveDraft(s, id);
      return result(out.ok ? `✓ 已发：${out.comment || ''}\n${out.url || ''}` : `✗ 没发：${out.reason || ''}`, !out.ok);
    })
  },
  {
    id: 'reply',
    name: '回复B站评论',
    description: '主人授权的情况下，回复一条评论或草稿。默认会过“同一个人 30 天只回一条”的判重；不填 text 就用模型写一两句。用户说“回他一句/告诉那个人…”时调用。',
    category: 'message',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '草稿 id（从 pending 拿）' },
        oid: { type: 'string', description: '没有草稿时：评论区 oid（视频 aid 或动态 comment_id）' },
        root: { type: 'string', description: '楼层根评论 rpid' },
        parent: { type: 'string', description: '要回复的那条评论 rpid' },
        mid: { type: 'string', description: '对方 mid' },
        who: { type: 'string', description: '对方昵称' },
        business: { type: 'number', description: '1=视频 11=动态，默认 1' },
        text: { type: 'string', description: '回复正文；不填让模型写' },
        dryRun: { type: 'boolean', description: '演练，不真的发' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      let item = null;
      const draftId = String(args.draftId || args.id || '').trim();
      if (draftId) {
        const d = findDraft(draftId);
        if (!d) return result(`没有找到草稿 ${draftId}`, true);
        item = d;
        const r = await replyToItem(s, d, { text: String(args.text || d.text || ''), dryRun: args.dryRun === true, manual: true });
        if (r.ok) removeDraft(draftId);
        return result(r.ok ? `✓ 已发：${r.comment || ''}\n${r.url || ''}` : `✗ 没发：${r.reason || ''}`, !r.ok);
      }
      if (!args.oid) return result('要么给 draftId，要么给 oid/root/parent。', true);
      item = {
        kind: 'reply', oid: String(args.oid), root: String(args.root || ''), parent: String(args.parent || ''),
        mid: String(args.mid || ''), who: String(args.who || ''), business: Number(args.business) || 1, text: ''
      };
      const r = await replyToItem(s, item, { text: String(args.text || ''), dryRun: args.dryRun === true, manual: true });
      return result(r.ok ? `✓ 已发：${r.comment || ''}\n${r.url || ''}` : `✗ 没发：${r.reason || ''}`, !r.ok);
    })
  },
  {
    id: 'live',
    name: 'B站直播间',
    description: '查看直播间信息、最近弹幕，或手动发一条弹幕。自主监听由设置里的「直播间弹幕」开关控制；这里用于用户明确要求。',
    category: 'query',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'history', 'send'], description: '默认 info' },
        room: { type: 'string', description: '房间号，默认用设置里的' },
        message: { type: 'string', description: 'send 时的弹幕内容（≤20 字）' }
      }
    },
    execute: toolRunner(async (ctx, args, s) => {
      const room = String(args.room || s.liveRoom || '').replace(/\D/g, '');
      if (!room) return result('没有直播间房间号。', true);
      const action = String(args.action || 'info');
      if (action === 'send') {
        const msg = String(args.message || '').trim();
        if (!msg) return result('要给 message。', true);
        if (s.dryRun) return result(`演练模式，未发送：${msg}`);
        const out = await sendDanmaku(s, { room, message: msg });
        return result(out.ok ? '✓ 弹幕已发出。' : `✗ 没发出去：${out.message || `code=${out.code}`}`, !out.ok);
      }
      if (action === 'history') {
        const h = await liveHistory(s, room);
        return result(`房间 ${h.room.roomId}「${h.room.title}」最近弹幕：\n` + h.rows.slice(-12).map((r) => `[${r.timeline}] ${r.name}: ${r.text}`).join('\n'));
      }
      const info = await liveInfo(s, room);
      return result([
        `房间 ${room}｜${info.live_status === 1 ? '直播中' : '未开播'}`,
        `标题：${info.title || ''}`,
        `主播 uid：${info.uid || ''}｜在线：${info.online || 0}`,
        `监听：${s.liveEnabled ? '开' : '关'}｜范围：${s.liveScope === 'owner' ? '只回主人' : '只回 @ 她'}`
      ].join('\n'));
    })
  },
  {
    id: 'login',
    name: 'B站登录体检',
    description: '检查 SESSDATA/bili_jct/buvid3、登录账号、主人 mid/昵称、模型通道。cookie 失效、评论发不出去、搜索没结果时调用。不会回显任何凭据。',
    category: 'system',
    icon: '🩺',
    parameters: { type: 'object', properties: {} },
    execute: toolRunner(async () => {
      const s = readSettings(apiRef);
      const d = await diagnose(s);
      const p = await personaOf(s);
      const extra = [
        `模型通道：${s.llmMode}${s.llmBaseUrl ? `（${s.llmBaseUrl}${s.llmModel ? ` / ${s.llmModel}` : ''}）` : ''}`,
        `人设：${p.name || '（未解析）'}（${p.source}${p.warning ? ` · ${p.warning}` : ''}）｜注入上限 ${s.personaMaxChars} 字`,
        `主人 QQ：${s.ownerQQ.join(', ') || '未填'}｜推送会话：${defaultChat(s) || '未定'}`,
        `作息：${s.windows}｜分享 ${s.shareDaily}/天｜阈值 ${s.shareMinScore}/20`,
        storageError() ? `存储：${storageError()}` : '存储：正常'
      ];
      return result(`体检：${d.ok ? '✓ 就绪' : '⚠ 有项目没就绪'}\n` + d.items.map((x) => `${x.ok ? '✓' : '✗'} ${x.id}：${x.detail}`).join('\n') + `\n\n${extra.join('\n')}`);
    })
  }
];

export function setup(api) {
  apiRef = api;
  disposed = false;
  initStore(api, (msg) => warn(`[bili-whale] ${msg}`));
  initBili(api, log);
  initLlm(api, warn);
  initRuntime(api, log);
  initNotify(api, warn);
  initHearing(api, log);
  initWatch(api, log);

  for (const def of TOOLS) {
    try { api.registerTool(def); } catch (error) { warn(`[bili-whale] 工具 ${def.id} 注册失败：${truncate(error?.message ?? error, 120)}`); }
  }
  const s = readSettings(api);
  ensureDay(todayKey(s.timeZone));
  ensureScheduler(s);
  addEvent('setup', `已加载 v1.0.0${s.enabled ? '，已启用' : '，等待启用'}`, null);
  setSettingsSnapshot(s);
  flush();
  ensureWatchdog();
  // 可选：把宿主人设卡目录镜像进 storage（异步，失败不影响加载）。
  void publishPersonaCatalog(api);
  log(`[bili-whale] 已加载：${s.enabled ? '运行中' : '未启用'}${hasCookie(s) ? '' : '（还没有 cookie）'}${hasLlm(s) ? '' : '（未配置模型，将用摘要模式）'}`);
}

// ── 过期临时切片清理（2026-10-24，02.md 2.2）────────────────────────────────
// hearVideo / watchVideo 每次跑都会在 os.tmpdir() 开 bili-hear-* / bili-watch-*
// 工作目录；正常路径 finally 里会删，但宿主被强杀 / ffmpeg 卡死崩溃时会残留，
// 日积月累能堆几十 MB 音视频临时文件。启用时延迟几秒顺手清一次超过 1 小时的
// 陈旧目录（1 小时 >> 单次处理时长，绝不会误删正在跑的那一份）。
function cleanStaleTempDirs() {
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - 3600_000;
    let removed = 0;
    for (const name of fs.readdirSync(tmp)) {
      if (!/^bili-(hear|watch)-/.test(name)) continue;
      try {
        const dir = path.join(tmp, name);
        const st = fs.statSync(dir);
        if (st.isDirectory() && st.mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed += 1;
        }
      } catch { /* 单个失败不影响其他 */ }
    }
    if (removed) log(`[bili-whale] 已清理 ${removed} 个超过 1 小时的残留临时切片目录`);
  } catch { /* tmpdir 读不了就算了 */ }
}

export function activate() {
  const s = readSettings(apiRef);
  ensureScheduler(s);
  ensureWatchdog();
  void publishPersonaCatalog(apiRef);
  const t = setTimeout(() => { try { cleanStaleTempDirs(); } catch { /* ignore */ } }, 5000);
  t.unref?.();
}

export function deactivate(ctx) {
  stopScheduler(ctx?.reason || 'disabled');
  stopWatchdog();
  // 卸载/重载时把「她在刷 B 站」熄掉，否则 sleep-mood 会一直以为她还在看
  // （正常路径由 runWake 的 finally 清；这里兜的是"跑到一半被 reload"）。
  try { clearActivity(); } catch { /* 不影响停用 */ }
  sched = null;
  flush();
  log(`[bili-whale] 已停用${ctx?.reason ? `（${ctx.reason}）` : ''}`);
}

export function dispose() {
  disposed = true;
  stopScheduler('dispose');
  stopWatchdog();
  try { clearActivity(); } catch { /* 不影响卸载 */ }
  sched = null;
  flush();
}

/** 同步自检：插件本身永远可用；cookie/模型缺失只影响功能，不让整块变“依赖未就绪”。 */
export function available() {
  if (disposed) return { ok: false, reason: '已卸载' };
  return { ok: true };
}

// 让宿主内核知道“装上但没启用”不是坏了。提示词用清单里的静态 section；
// 这里不再追加动态内容，避免系统提示每天变一个字节击穿缓存。
export function promptSections() {
  return [];
}

export const hooks = {
  /**
   * 每条入站消息：
   *   ① 接住 sender/onebot/store（定时主动推送靠它）；
   *   ② 主人找她 = 一次“表态”，沉默衰减清零；
   *   ③ 处理 /鲸鱼 命令；
   *   ④ 顺手确保定时器在跑（设置里从关到开时没有 activate 也能恢复）。
   */
  async onMessage(ctx = {}) {
    try {
      adopt(ctx);
      const s = readSettings(apiRef);
      ensureScheduler(s);
      const fromOwner = Array.isArray(s.ownerQQ) && s.ownerQQ.includes(String(ctx.senderId ?? ''));
      if (fromOwner) {
        const text = String(ctx.text || '');
        const toMe = ctx.event?.to_me === true || ctx.event?.is_at === true || /鲸鱼|小鱼/i.test(text);
        if (toMe && Date.now() - lastOwnerFeedbackAt > 60_000) {
          lastOwnerFeedbackAt = Date.now();
          markFeedback(s, '主人在 QQ 里找她');
        }
      }
      // 手动命令不依赖“自主作息”开关：只要插件总开关开着就能体检/演练/审批。
      if (isCommand(ctx.text)) {
        await handleCommand(apiRef, ctx, s);
      }
    } catch (error) {
      warn(`[bili-whale] onMessage 出错：${truncate(error?.message ?? error, 160)}`);
    }
  }
};

export const internals = { TOOLS, candidatestText, draftText };
