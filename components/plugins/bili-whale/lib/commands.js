// bili-whale / commands.js
//
// 聊天里的手动入口。只认「/鲸鱼」「#鲸鱼」「鲸鱼 」开头，绝不抢普通聊天。
// 长任务（醒来、分享、深读、选题）先回一句“收到”，再在后台跑完补发结果 ——
// 宿主 onMessage 钩子有 5 秒超时，不能在里面 await 一整轮。

import { checkLogin, videoContent, liveInfo, sendDanmaku, diagnose } from './bili.js';
import { deepReadVideo, collectCandidates, runWake, runSkip, shareVideo, approveDraft, rejectDraft, listDrafts, formatStatus, inboxDigest, wakeBusyInfo, queueManualWake } from './runtime.js';
import { heuristicAnalysis } from './analyze.js';
import { formatDiary, listDiaries } from './diary.js';
import { status as quotaStatus, silence, markFeedback } from './quota.js';
import { findDraft } from './store.js';
import { truncate, redact, todayKey } from './util.js';
import { hostPersonaCatalog, resolveCardRef, savePersonaSelection, personaOf, publishPersonaCatalog } from './persona.js';

const PREFIX_RE = /^(?:\/|#|！|!)?鲸鱼(?:\s+([\s\S]*))?$/;
const PREFIX_ALT_RE = /^(?:鲸鱼|小鱼|bili)[，,：:\s]+([\s\S]+)$/i;

export function isCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return PREFIX_RE.test(t) || PREFIX_ALT_RE.test(t);
}

function parse(text) {
  const t = String(text || '').trim();
  let m = t.match(PREFIX_RE);
  if (!m) m = t.match(PREFIX_ALT_RE);
  return String(m?.[1] || '').trim();
}

function isOwner(s, ctx) {
  const ids = Array.isArray(s.ownerQQ) ? s.ownerQQ : [];
  if (!ids.length) return false;
  return ids.includes(String(ctx?.senderId ?? ''));
}

function reply(ctx, text, api) {
  const body = truncate(String(text || ''), 3500);
  if (!body) return;
  try {
    if (typeof ctx.send === 'function') { ctx.send(body); return; }
    if (typeof ctx.sendSegments === 'function') { ctx.sendSegments([{ type: 'text', data: { text: body } }]); return; }
  } catch (error) {
    try { api?.warn?.(`[bili-whale] 命令回复失败：${truncate(error?.message ?? error, 120)}`); } catch { /* ignore */ }
  }
}

function background(ctx, api, label, fn) {
  Promise.resolve()
    .then(fn)
    .then((out) => { if (out) reply(ctx, out, api); })
    .catch((error) => reply(ctx, `✗ ${label}失败：${truncate(error?.message ?? error, 300)}`, api));
}

function helpText(s) {
  return [
    'B站鲸鱼 · 手动入口',
    '/鲸鱼 状态            看登录、计划、额度、草稿',
    '/鲸鱼 现在            立刻醒一轮（选题→深读→日记→分享）',
    '/鲸鱼 不看 [理由]     今天不想看，写日记说明理由',
    '/鲸鱼 日记 [私|公] [天数]  看两本日记',
    '/鲸鱼 额度            分享额度与沉默衰减',
    '/鲸鱼 人设            列宿主人设卡；人设 <名字/序号> 切换',
    '/鲸鱼 待审            看草稿；批准 <id> / 拒绝 <id>',
    '/鲸鱼 分享 <BV> [理由]  手动分享一条（仍过评分/额度闸门）',
    '/鲸鱼 看 <BV>         深读一条并返回摘要（不发）',
    '/鲸鱼 找 [关键词]      看今天能选哪些视频',
    '/鲸鱼 谁找我          最近 24h 评论/@ 摘要',
    '/鲸鱼 登录            检查 cookie 和依赖',
    '/鲸鱼 表态 [一句话]    记一次“主人有反应”，沉默清零',
    '/鲸鱼 直播            看直播间状态；直播 发 <文字> 手动发弹幕',
    '',
    '自主流程到点会自己跑，不需要你发命令。'
  ].join('\n');
}

export async function handleCommand(api, ctx, s) {
  const text = String(ctx?.text || '');
  if (!isCommand(text)) return false;
  if (!isOwner(s, ctx)) {
    reply(ctx, '这只鲸鱼只认主人。先在插件设置里填「主人 QQ 号」。', api);
    return true;
  }
  const body = parse(text);
  const [headRaw, ...rest] = body.split(/\s+/);
  const head = String(headRaw || '').toLowerCase();
  const tail = body.slice(headRaw.length).trim();

  if (!head || ['帮助', 'help', '?', '？'].includes(head)) {
    reply(ctx, helpText(s), api);
    return true;
  }

  if (['状态', 'status', 's'].includes(head)) {
    reply(ctx, formatStatus(s), api);
    return true;
  }

  if (['现在', '醒来', 'run', 'wake'].includes(head)) {
    const dry = /演练|dry/i.test(tail);
    // 上一轮还没跑完时别先回「收到」再打脸：直接排队，并说清楚什么时候会跑。
    const busy = wakeBusyInfo();
    if (busy && !busy.stale) {
      queueManualWake(dry);
      reply(ctx, `上一轮还在跑（已经 ${busy.mins} 分钟了），我记下了 —— 它一结束我立刻接着跑这一轮${dry ? '（演练）' : ''}。`, api);
      return true;
    }
    reply(ctx, `收到，现在跑一轮${dry ? '（演练，不对外发）' : ''}。要一会儿，跑完把评论发你。`, api);
    background(ctx, api, '醒来', async () => {
      const out = await runWake(s, { trigger: 'manual', dryRun: dry, silent: true });
      if (!out.ok) return `✗ 这一轮没跑完：${out.reason || '未知原因'}`;
      const c = out.shared && out.shared.comment;
      return c
        ? `${dry ? '✓ 演练完成（未发出）' : '✓ 已分享'}：\n\n${c}`
        : '✓ 跑完了，这轮没到分享线，没写评论。';
    });
    return true;
  }

  if (['不看', 'skip'].includes(head)) {
    const reason = tail || '今天就是不想看';
    reply(ctx, `收到，今天不看。理由：${truncate(reason, 120)}`, api);
    background(ctx, api, '写日记', async () => {
      await runSkip(s, { reason, trigger: 'manual' });
      return '';
    });
    return true;
  }

  if (['日记', 'diary'].includes(head)) {
    // 2026-10-20：主人不想在聊天里收到日记内容。默认关闭，静默忽略；
    // 需要时在插件设置里把「允许 /日记 指令读日记」打开即可恢复。
    if (s.diaryCommandEnabled !== true) return true;
    const parts = tail.split(/\s+/).filter(Boolean);
    const which = parts.includes('私') || parts.includes('private') ? 'private' : 'public';
    const days = Math.max(1, Math.min(30, Number(parts.find((x) => /^\d+$/.test(x)) || 1)));
    reply(ctx, formatDiary(s, { which, days, limit: 10 }), api);
    return true;
  }

  if (['额度', 'quota'].includes(head)) {
    const q = quotaStatus(s);
    const sil = silence(s);
    reply(ctx, [
      `今天：分享 ${q.shares}/${q.shareCap}（基础上限 ${q.shareDaily}）｜自主回复 ${q.replies} 条`,
      `沉默：${sil.days} 天 → 分享上限 ${sil.cap}${sil.cap === 0 ? '（已停止分享，日记照写）' : ''}`,
      q.recent.length ? `最近：\n${q.recent.map((x) => `· ${new Date(x.at).toLocaleTimeString('zh-CN')} ${x.type}${x.share ? '（分享）' : ''} ${x.target || ''}`).join('\n')}` : '最近：无'
    ].join('\n'), api);
    return true;
  }

  if (['人设', 'persona', '角色卡'].includes(head)) {
    const ref = tail.trim();
    if (!ref) {
      reply(ctx, '正在读宿主人设卡…', api);
      background(ctx, api, '读人设卡', async () => {
        const cat = await hostPersonaCatalog();
        const cur = await personaOf(s);
        if (!cat.cards.length) {
          return `没有读到宿主人设卡${cat.coreError ? `（${cat.coreError}）` : ''}。\n可以在插件设置里改用「插件内自定义人设卡」，或确认宿主人设已经配置。`;
        }
        const list = cat.cards.slice(0, 40).map((c) => `${c.no}. ${c.name}（${c.source}）${c.key ? `  id=${c.key}` : ''}`);
        return [
          `当前人设：${cur.name || '未解析'}（${cur.source}）${cur.warning ? `\n⚠ ${cur.warning}` : ''}`,
          '',
          `宿主人设卡（共 ${cat.cards.length} 张）：`,
          ...list,
          cat.cards.length > 40 ? `…还有 ${cat.cards.length - 40} 张，去插件面板「人设」页看全部` : '',
          '',
          '切换：/鲸鱼 人设 <序号 或 名字>',
          '恢复跟随宿主当前：/鲸鱼 人设 默认'
        ].filter(Boolean).join('\n');
      });
      return true;
    }
    if (['默认', '跟随', '全局', '清空', 'reset', 'default'].includes(ref.toLowerCase())) {
      const r = await savePersonaSelection('');
      if (r.ok) {
        reply(ctx, '已清空指定卡，改为跟随宿主当前人设。', api);
        void publishPersonaCatalog(api);
      } else {
        reply(ctx, `没写成设置：${r.reason}\n请在插件设置里把「宿主人设卡」清空。`, api);
      }
      return true;
    }
    reply(ctx, `收到，切到「${truncate(ref, 40)}」。`, api);
    background(ctx, api, '切换人设', async () => {
      const cat = await hostPersonaCatalog();
      const hit = resolveCardRef(ref, cat.cards);
      if (!hit.ok) {
        const hints = (hit.matches || cat.cards).slice(0, 6).map((c) => `${c.no}.${c.name}`).join('、');
        return `没找到「${ref}」。可选：${hints || '（人设卡列表是空的）'}\n发 /鲸鱼 人设 看完整名单。`;
      }
      const saved = await savePersonaSelection(hit.card.key || hit.card.id);
      if (!saved.ok) return `找到了「${hit.card.name}」，但${saved.reason}`;
      void publishPersonaCatalog(api);
      return `已把人设卡切到「${hit.card.name}」（${hit.card.source}，${hit.how}匹配）。\n已写进插件设置；下一句起生效。`;
    });
    return true;
  }

  if (['待审', 'pending', '草稿'].includes(head)) {
    const list = listDrafts();
    if (!list.length) reply(ctx, '没有待审草稿。', api);
    else reply(ctx, `待审 ${list.length} 条：\n` + list.map((d) => `· ${d.id}｜${d.who}：${truncate(redact(d.src, s), 90)}\n  草稿：${d.text ? truncate(d.text, 100) : '（批准时再生成）'}\n  批准：/鲸鱼 批准 ${d.id}｜拒绝：/鲸鱼 拒绝 ${d.id}`).join('\n'), api);
    return true;
  }

  if (['批准', 'approve'].includes(head)) {
    let id = tail.split(/\s+/)[0] || '';
    if (!id) {
      const one = listDrafts();
      if (one.length === 1) id = one[0].id;
    }
    if (!id) { reply(ctx, '要给草稿 id。用 /鲸鱼 待审 看。', api); return true; }
    reply(ctx, `收到，去发草稿 ${id}。`, api);
    background(ctx, api, '批准草稿', async () => {
      const out = await approveDraft(s, id);
      return out.ok ? `✓ 已发：${out.comment}\n${out.url || ''}` : `✗ 没发出去：${out.reason || ''}`;
    });
    return true;
  }

  if (['拒绝', 'reject'].includes(head)) {
    const parts = tail.split(/\s+/);
    const id = parts[0] || '';
    const why = parts.slice(1).join(' ');
    if (!id) { reply(ctx, '要给草稿 id。', api); return true; }
    const out = rejectDraft(s, id, why);
    reply(ctx, out.ok ? `已拒绝 ${id}。` : out.reason, api);
    return true;
  }

  if (['分享', 'share'].includes(head)) {
    const parts = tail.split(/\s+/);
    const bvid = parts.find((x) => /BV[0-9A-Za-z]{10}/.test(x)) || '';
    const why = parts.filter((x) => !/BV[0-9A-Za-z]{10}/.test(x)).join(' ');
    if (!bvid) { reply(ctx, '要给 BV 号，例如 /鲸鱼 分享 BV1xx411c7mD 这个讲得很清楚', api); return true; }
    reply(ctx, `收到，先读懂 ${bvid} 再判断值不值得分享。`, api);
    background(ctx, api, '分享', async () => {
      const video = await videoContent(s, bvid, { commentCount: 8, needSubtitles: true });
      const analysis = heuristicAnalysis(video, s);
      const reason = why || analysis.reason;
      const out = await shareVideo(s, { bvid, video, analysis, score: analysis.score.total, reason, manual: true });
      if (!out.ok) return `✗ 没发：${out.reason || '未知原因'}`;
      return out.dryRun ? `✓ 演练完成（未发出）：\n${out.comment}` : `✓ 已分享：\n${out.comment}\n${out.url || ''}`;
    });
    return true;
  }

  if (['看', 'debrief', '深读'].includes(head)) {
    const bvid = (tail.match(/BV[0-9A-Za-z]{10}/) || [])[0];
    if (!bvid) { reply(ctx, '要给 BV 号。', api); return true; }
    reply(ctx, `收到，深读 ${bvid}。`, api);
    background(ctx, api, '深读', async () => {
      const d = await deepReadVideo(s, bvid);
      return [
        `《${d.video.title}》 UP ${d.video.author}｜${d.video.duration}s`,
        `评分：${d.analysis.score.total}/20（信息${d.analysis.score.info} 偏好${d.analysis.score.fit} 新颖${d.analysis.score.novelty} 情绪${d.analysis.score.emotion} 质量${d.analysis.score.quality}）`,
        `摘要：${d.analysis.summary}`,
        d.analysis.points?.length ? `看点：\n${d.analysis.points.map((p) => `· ${p}`).join('\n')}` : '',
        d.analysis.comment ? `\n如果分享会这样写：\n${d.analysis.comment}` : '',
        `\n${truncate(d.video.subtitle?.text || d.video.desc || '', 800)}`
      ].filter(Boolean).join('\n');
    });
    return true;
  }

  if (['找', 'feed', '选题'].includes(head)) {
    reply(ctx, `收到，去捞${tail ? `「${tail}」` : '今天的候选'}。`, api);
    background(ctx, api, '选题', async () => {
      const list = await collectCandidates(s, { limit: 10, keyword: tail });
      if (!list.length) return '今天没有捞到没看过的新视频。';
      return `候选 ${list.length} 条：\n` + list.map((x, i) => `${i + 1}. ${x.bvid} 《${truncate(x.title, 42)}》 UP ${truncate(x.author, 16)}｜${x.duration}s｜弹幕 ${x.danmaku}｜${x.source}`).join('\n');
    });
    return true;
  }

  if (['谁找我', '收件箱', 'inbox'].includes(head)) {
    reply(ctx, '收到，去翻收件箱。', api);
    background(ctx, api, '收件箱', async () => {
      const r = await inboxDigest(s, { hours: 24 });
      return r.text;
    });
    return true;
  }

  if (['登录', 'login', '体检', 'deps'].includes(head)) {
    reply(ctx, '收到，去检查登录态和依赖。', api);
    background(ctx, api, '体检', async () => {
      const d = await diagnose(s);
      return `体检：${d.ok ? '✓ 全部就绪' : '⚠ 有项目没就绪'}\n` + d.items.map((x) => `${x.ok ? '✓' : '✗'} ${x.id}：${x.detail}`).join('\n');
    });
    return true;
  }

  if (['表态', 'react', '反馈'].includes(head)) {
    markFeedback(s, tail || '主人在 QQ 里表态');
    reply(ctx, `已记一次表态，沉默清零。${tail ? `（${truncate(tail, 80)}）` : ''}`, api);
    return true;
  }

  if (['直播', 'live'].includes(head)) {
    const actual = tail.trim();
    if (!actual) {
      reply(ctx, '收到，查直播间。', api);
      background(ctx, api, '直播状态', async () => {
        if (!s.liveRoom) return '还没填直播间房间号。';
        const info = await liveInfo(s, s.liveRoom);
        return [
          `房间 ${s.liveRoom}｜${info.live_status === 1 ? '直播中' : '未开播'}`,
          `标题：${info.title || ''}`,
          `主播 uid：${info.uid || ''}｜在线：${info.online || 0}`,
          `监听开关：${s.liveEnabled ? '开' : '关'}｜范围：${s.liveScope === 'owner' ? '只回主人' : '只回 @ 她'}`
        ].join('\n');
      });
      return true;
    }
    const action = actual.split(/\s+/)[0];
    if (['发', 'send'].includes(action)) {
      const msg = actual.slice(action.length).trim();
      if (!msg) { reply(ctx, '要给弹幕内容。', api); return true; }
      reply(ctx, '收到，发一条弹幕。', api);
      background(ctx, api, '发弹幕', async () => {
        if (s.dryRun) return `演练模式，没发：${msg}`;
        const out = await sendDanmaku(s, { room: s.liveRoom, message: msg });
        return out.ok ? '✓ 弹幕已发出。' : `✗ 没发出去：${out.message || `code=${out.code}`}`;
      });
      return true;
    }
    reply(ctx, '直播相关的开关在插件设置里；这里只能看状态或「直播 发 <文字>」。', api);
    return true;
  }

  reply(ctx, helpText(s), api);
  return true;
}
