// bili-whale / watch.js
//
// 「看视频」：把视频切成 10~12 秒的小段，**原生视频部件**（video_url + data URL）
// 送给全模态模型 —— 让它同时看到画面、听到声音、读到口播。
//
// 和 hearing.js 的分工：
//   · watch  = 主通道。一次请求同时给出画面 + 声音 + 说话内容，信息最全。
//   · hearing= 兜底。中转站不支持 video 部件、或者视频段太大/超时时，
//     退回去只喂音频（体积小一个数量级，实测更稳）。
//
// 为什么切片只有 10~12 秒（实测，2026-10-21）：
//   12 秒 / 193 KB → 13.5 秒返回，画面+人声+配乐全能复述；
//   25 秒 / 294 KB → 网关 502「智能路由候选均请求失败」（等 136 秒才报错）。
//   → 所以宁可多切两段，也不要单段变长。
//
// ⚠️ 与 hearing.js 一样 import 了 fs/child_process，需要 config.trustedPlugins 放行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UA } from './bili.js';
import { withTimeout, truncate, fmtSec } from './util.js';
import { resolveFfmpeg, endpointsOf } from './hearing.js';

let apiRef = null;
let logRef = () => {};
export function initWatch(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
}
const log = (...a) => { try { logRef(...a); } catch { /* ignore */ } };

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code) => { if (done) return; done = true; resolve({ code, stdout: out, stderr: err }); };
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); } catch { return finish(-1); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish(-2); }, Math.max(5000, timeoutMs || 180000));
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? -1); });
  });
}

function endpointOf(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return '';
  return /\/chat\/completions$/i.test(b) ? b : `${b}/chat/completions`;
}

/** 取可切的视频流：优先 H.264（兼容性最好），取最低清晰度（转 480p 后无差别，切得快）。 */
async function videoStream(s, bvid, cid) {
  const qs = new URLSearchParams({ bvid, cid: String(cid), fnval: '16', fnver: '0', fourk: '1' });
  const res = await withTimeout(apiRef.fetch(`https://api.bilibili.com/x/player/playurl?${qs}`, {
    headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}`, accept: 'application/json, text/plain, */*' }
  }), 20000, 'playurl(video)');
  const j = await res.json();
  if (Number(j?.code) !== 0) throw new Error(`playurl code=${j?.code} ${j?.message || ''}`);
  const all = Array.isArray(j?.data?.dash?.video) ? j.data.dash.video.slice() : [];
  if (!all.length) throw new Error('这条视频没有视频流（可能是纯音频稿）');
  const avc = all.filter((v) => /avc/i.test(String(v.codecs || '')));
  const pick = (avc.length ? avc : all).sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0))[0];
  const url = pick.baseUrl || pick.base_url || pick.backupUrl?.[0];
  if (!url) throw new Error('视频流地址为空');
  return { url, bandwidth: Number(pick.bandwidth) || 0, codecs: String(pick.codecs || '') };
}

async function clipToMp4(ff, { url, bvid, at, secs, out }) {
  // 重编码而不是 -c copy：fMP4 直接 copy 出来的容器有些解码器不吃，
  // 实测 copy 版模型偶发 400；重编码 480p/crf32 一段 12 秒约 1~5 秒、200 KB。
  const args = [
    '-y', '-v', 'error',
    '-headers', `Referer: https://www.bilibili.com/video/${bvid}\r\n`,
    '-user_agent', UA,
    '-ss', String(Math.max(0, Math.round(at))),
    '-t', String(Math.max(5, Math.round(secs))),
    '-i', url,
    '-vf', 'scale=480:-2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1',
    '-movflags', '+faststart',
    out
  ];
  const r = await run(ff, args, 180000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error(`ffmpeg 切片失败（code=${r.code}）${truncate(r.stderr.replace(/\s+/g, ' '), 120)}`);
  }
  const size = fs.statSync(out).size;
  if (size < 2048) throw new Error('切片过小（可能定位到了黑帧/片尾）');
  return size;
}

async function askVideo({ base, key, model, mp4Buf, hint, at, secs }) {
  const b64 = mp4Buf.toString('base64');
  const prompt = [
    `这是一段视频（约 ${secs} 秒${at != null ? `，取自原片 ${fmtSec(at)} 附近` : ''}）。请用 2~4 句中文说清：`,
    '1) 画面里在发生什么（谁、在哪、在做什么；有明显转场/字幕/图表就点出来）；',
    '2) 有没有人说话，说了什么（尽量转写关键句）；',
    '3) 有没有明显的声音（配乐/音效/环境声）。',
    '只描述你看到听到的，不要评论、不要总结成标题。',
    hint ? `背景：${hint}` : ''
  ].filter(Boolean).join('\n');

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 480,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'video_url', video_url: { url: `data:video/mp4;base64,${b64}` } }
    ] }]
  };
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await withTimeout(apiRef.fetch(endpointOf(base), {
    method: 'POST', headers, body: JSON.stringify(body)
  }), 200000, '看视频');
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${truncate(text, 160)}`);
  let data = null;
  try { data = JSON.parse(text); } catch { throw new Error('模型返回不是 JSON'); }
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  const out = String(content).trim();
  if (!out) throw new Error('模型返回空内容');
  return out;
}

/**
 * 看一条视频（原生视频输入）。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error?:string, text?:string,
 *                    slices?:Array, meta?:object}>}
 */
export async function watchVideo(s, video, { hint = '' } = {}) {
  if (!s?.watchEnabled) return { ok: false, skipped: true, reason: '看视频未启用' };
  // 2026-10-21：改成多通道（复用听觉那套 endpoints：main + backup + third）。
  // 原来只认 hearingBaseUrl 一条，主通道一挂（实测 a6api 返回
  // HTTP 502 smart_route_all_candidates_failed）整片就看不成，白白降级到听觉。
  // watchModel 若单独填了，主备两条都用它；第三层（基元律动）用它自己配的模型，
  // 不被覆盖 —— 那一层的模型跟主备根本不是一类（seed-2.1-pro 是推理型多模态）。
  const endpoints = endpointsOf(s, { need: 'video' }).map((ep) => ({
    ...ep,
    model: String((ep.name === 'third' ? ep.model : s.watchModel) || ep.model || '').trim()
  })).filter((ep) => ep.base && ep.model);
  if (!endpoints.length) return { ok: false, skipped: true, reason: '没有可用的视频模型接口' };

  const bvid = String(video?.bvid || '');
  const cid = String(video?.cid || '');
  const dur = Number(video?.duration) || 0;
  if (!bvid || !cid) return { ok: false, skipped: true, reason: '缺少 bvid/cid' };
  if (dur < 12) return { ok: false, skipped: true, reason: '视频太短' };

  const ff = await resolveFfmpeg(s);
  if (!ff) return { ok: false, error: '找不到 ffmpeg' };

  const started = Date.now();
  let tmp = '';
  try {
    const vs = await videoStream(s, bvid, cid);
    const n = Math.max(1, Math.min(4, Math.round(Number(s.watchSlices) || 2)));
    const secs = Math.max(6, Math.min(14, Math.round(Number(s.watchSec) || 12)));
    const span = Math.max(0, dur - secs);
    const points = Array.from({ length: n }, (_, i) => Math.round((span * i) / n));

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-watch-'));
    const slices = [];
    const dead = new Set();          // 已判定不可用的通道（避免每段都先吃一次超时）
    const fails = new Map();         // 每通道累计失败次数
    for (const at of points) {
      const out = path.join(tmp, `v${at}.mp4`);
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const live = endpoints.filter((ep) => !dead.has(ep.name));
        if (!live.length) { lastErr = lastErr || new Error('所有视频通道都不可用'); break; }
        let success = false;
        for (const ep of live) {
          try {
            const bytes = await clipToMp4(ff, { url: vs.url, bvid, at, secs, out });
            const mb = bytes / 1048576;
            if (mb > 9) throw new Error(`切片 ${mb.toFixed(1)}MB 偏大，跳过（网关不稳）`);
            const said = await askVideo({
              base: ep.base, key: ep.key, model: ep.model,
              mp4Buf: fs.readFileSync(out), at, secs,
              hint: hint || (video?.title ? `视频《${truncate(video.title, 40)}》` : '')
            });
            slices.push({ at, text: said, kb: Math.round(bytes / 1024), attempt, via: ep.name });
            log(`[bili-whale] 看视频 ${fmtSec(at)}（${ep.name}）→ ${truncate(said.replace(/\s+/g, ' '), 70)}`);
            lastErr = null;
            success = true;
            break;
          } catch (e) {
            lastErr = e;
            // 任一通道连挂就熔断，本片剩余片段不再在它身上白等。
            // 第三层阈值是 1：它单段要 50 秒往上，失败两次的成本比换通道高得多。
            const cnt = (fails.get(ep.name) || 0) + 1;
            fails.set(ep.name, cnt);
            const limit = ep.name === 'third' ? 1 : 2;
            if (cnt >= limit && !dead.has(ep.name)) {
              dead.add(ep.name);
              log(`[bili-whale] 看视频：${ep.name} 失败 ${cnt} 次，本片剩余片段跳过它`);
            }
            log(`[bili-whale] 看视频 ${fmtSec(at)} ${ep.name} 第 ${attempt} 次失败：${truncate(e?.message ?? e, 110)}`);
          } finally {
            try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* ignore */ }
          }
        }
        if (success) break;
      }
      if (lastErr) slices.push({ at, text: '', error: truncate(lastErr?.message ?? lastErr, 140) });
    }

    const good = slices.filter((x) => x.text);
    if (!good.length) {
      return { ok: false, error: slices.find((x) => x.error)?.error || '所有片段都没看成', slices };
    }
    const text = good.map((x) => `[${fmtSec(x.at)}] ${x.text.replace(/\s+/g, ' ').trim()}`).join('\n');
    return {
      ok: true, text, slices,
      meta: {
        model: endpoints.map((x) => x.model).join(' / '),
        backends: [...new Set(slices.filter((x) => x.via).map((x) => x.via))],
        slices: n, secs, ms: Date.now() - started, ok: good.length
      }
    };
  } catch (e) {
    return { ok: false, error: truncate(e?.message ?? e, 200) };
  } finally {
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
