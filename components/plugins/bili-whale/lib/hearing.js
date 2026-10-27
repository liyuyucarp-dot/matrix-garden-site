// bili-whale / hearing.js
//
// 「听觉」：把视频的**音频抽样**送进全模态模型，让她真的听到声音，
// 而不是只能靠字幕/弹幕/热评猜。
//
// 为什么是抽样而不是整条听：
//   · 本机网关（api.a6api.com → gemini）单次音频有明显上限：30 秒 mp3（118 KB）
//     约 12 秒返回正常；同样内容 700 KB 起就稳定 HTTP 502（上游候选全部超时）。
//     —— 所以一次只喂 25~30 秒，分几段采样覆盖全片。
//   · ffmpeg 直接读远端 m4s 流并 `-ss` 定位，只取需要的那 30 秒，
//     实测 0.5~0.7 秒、产物 118 KB，不需要把整段音频落到磁盘。
//
// ⚠️ 这个模块 import 了 fs / os / path / child_process，属于宿主定义的
//    「高危能力」。第三方插件默认会被 plugin-loader 拦下，必须在
//    config.trustedPlugins 里显式登记本插件 id 才会放行。
//    没登记时整插件加载失败 —— 所以把这些 import 收在本文件里，
//    其它模块不碰它们，便于排查。
//
// 依赖：ffmpeg（PATH 里或常见路径，也可在设置里指定）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { UA } from './bili.js';
import { withTimeout, truncate, fmtSec } from './util.js';

let apiRef = null;
let logRef = () => {};

export function initHearing(api, log) {
  apiRef = api;
  if (typeof log === 'function') logRef = log;
}

const log = (...a) => { try { logRef(...a); } catch { /* ignore */ } };

// ── ffmpeg 探测 ───────────────────────────────────────────────────────────

let _ffCache = { at: 0, path: null };

function commonFfmpegPaths() {
  return [
    'ffmpeg',
    'ffmpeg.exe',
    path.join(os.homedir(), 'bin', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ];
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, stdout: out, stderr: err });
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return finish(-1);
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(-2);
    }, Math.max(5000, timeoutMs || 120000));
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(-1); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ?? -1); });
  });
}

/**
 * 找到可用的 ffmpeg（设置优先，其次 PATH 与常见安装位置；结果缓存 10 分钟）。
 * @returns {Promise<string|null>}
 */
export async function resolveFfmpeg(s, { force = false } = {}) {
  const want = String(s?.hearingFfmpeg || '').trim();
  if (_ffCache.path && !force && want === _ffCache.want && Date.now() - _ffCache.at < 600000) return _ffCache.path;
  const candidates = want ? [want, ...commonFfmpegPaths()] : commonFfmpegPaths();
  for (const c of candidates) {
    const r = await run(c, ['-version'], 15000);
    if (r.code === 0 && /ffmpeg version/i.test(r.stdout)) {
      _ffCache = { at: Date.now(), path: c, want };
      log(`[bili-whale] 听觉：ffmpeg 可用（${c}）`);
      return c;
    }
  }
  _ffCache = { at: Date.now(), path: null, want };
  log('[bili-whale] 听觉：找不到 ffmpeg（可在设置里填可执行文件路径）');
  return null;
}

// ── 取音频流 ─────────────────────────────────────────────────────────────

async function playurlAudio(s, bvid, cid) {
  const qs = new URLSearchParams({ bvid, cid: String(cid), fnval: '16', fnver: '0', fourk: '1' });
  const url = `https://api.bilibili.com/x/player/playurl?${qs.toString()}`;
  const res = await withTimeout(apiRef.fetch(url, {
    headers: {
      'user-agent': UA,
      referer: `https://www.bilibili.com/video/${bvid}`,
      accept: 'application/json, text/plain, */*'
    }
  }), 20000, 'playurl');
  if (!res || typeof res.json !== 'function') throw new Error('playurl 返回异常');
  const j = await res.json();
  if (Number(j?.code) !== 0) throw new Error(`playurl code=${j?.code} ${j?.message || ''}`);
  const audios = Array.isArray(j?.data?.dash?.audio) ? j.data.dash.audio.slice() : [];
  if (!audios.length) throw new Error('这条视频没有音频流');
  // 选**最低**码率：转成 32k 单声道之后音质无差别，但 ffmpeg 定位更快、流量更小
  audios.sort((a, b) => (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0));
  const pick = audios[0];
  const streamUrl = pick.baseUrl || pick.base_url || pick.backupUrl?.[0];
  if (!streamUrl) throw new Error('音频流地址为空');
  return { url: streamUrl, bandwidth: Number(pick.bandwidth) || 0 };
}

// ── 切片 + 问模型 ────────────────────────────────────────────────────────

async function sliceToMp3(ff, { url, bvid, at, secs, out }) {
  const args = [
    '-y', '-v', 'error',
    // 远端流必须带 Referer，否则 B 站 CDN 会 403
    '-headers', `Referer: https://www.bilibili.com/video/${bvid}\r\n`,
    '-user_agent', UA,
    '-ss', String(Math.max(0, Math.round(at))),
    '-t', String(Math.max(5, Math.round(secs))),
    '-i', url,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'mp3', out
  ];
  const r = await run(ff, args, 90000);
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error(`ffmpeg 切片失败（code=${r.code}）${truncate(r.stderr.replace(/\s+/g, ' '), 120)}`);
  }
  return fs.statSync(out).size;
}

function endpointOf(base) {
  const b = String(base || '').replace(/\/+$/, '');
  if (!b) return '';
  return /\/chat\/completions$/i.test(b) ? b : `${b}/chat/completions`;
}

async function askAudio({ base, key, model, mp3Buf, hint, style = 'raw' }) {
  const b64 = mp3Buf.toString('base64');
  const prompt = [
    '这是一段视频里的原始声音，请只做「听写」，不要评论、不要总结：',
    '1) 有人说话就按顺序转写成中文（保留原话口气，听不清用「（听不清）」标记）；',
    '2) 没有人声但有明显声音（音乐/音效/环境声），一句话说明是什么声音；',
    '3) 真的什么都听不到，就只回「静音」。',
    hint ? `背景：${hint}` : ''
  ].filter(Boolean).join('\n');

  // 两种协议端的喂法（实测）：
  //   · gemini（a6api 这类 OpenAI 兼容网关）：裸 base64 + format
  //   · qwen-omni（dashscope）：必须 data URL，裸 base64 会 400 "provided URL does not appear to be valid"
  const audio = style === 'dataurl'
    ? { data: `data:audio/mp3;base64,${b64}`, format: 'mp3' }
    : { data: b64, format: 'mp3' };

  const body = {
    model,
    temperature: 0.2,
    max_tokens: 320,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'input_audio', input_audio: audio }
    ] }]
  };
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await withTimeout(apiRef.fetch(endpointOf(base), {
    method: 'POST', headers, body: JSON.stringify(body)
  }), 75000, '听觉模型');
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
 * 把设置展开成"通道列表"：主通道 + 备用通道。
 * 备用通道默认按 data URL 送（qwen-omni 的口径）。
 */
/**
 * 通道表：main → backup → third。
 *
 * `need` 决定取哪些通道（'video' / 'audio' / 'any'）：
 *   · main / backup 是 gemini / qwen-omni 这类全模态，视频音频都能吃；
 *   · third（基元律动）**只吃视频**，音频部件直接 MODEL_CAPABILITY_NOT_SUPPORTED，
 *     所以给它打 caps: ['video']，听觉取通道时自动跳过，不会白等一次失败。
 */
export function endpointsOf(s, { need = 'any' } = {}) {
  const list = [];
  const primaryBase = String(s.hearingBaseUrl || s.llmBaseUrl || '').trim();
  if (primaryBase) {
    list.push({
      name: 'main',
      base: primaryBase,
      key: String(s.hearingApiKey || s.llmApiKey || '').trim(),
      model: String(s.hearingModel || s.llmModel || '').trim(),
      style: 'raw',
      caps: ['video', 'audio']
    });
  }
  const backupBase = String(s.hearingBackupBaseUrl || '').trim();
  if (backupBase) {
    list.push({
      name: 'backup',
      base: backupBase,
      key: String(s.hearingBackupApiKey || '').trim(),
      model: String(s.hearingBackupModel || 'qwen3.8-omni-flash').trim(),
      style: 'dataurl',
      caps: ['video', 'audio']
    });
  }
  // 第三层：基元律动。只用于看视频，不进听觉。
  const thirdBase = String(s.watchThirdBaseUrl || '').trim();
  if (thirdBase) {
    list.push({
      name: 'third',
      base: thirdBase,
      key: String(s.watchThirdApiKey || '').trim(),
      model: String(s.watchThirdModel || '').trim(),
      style: 'dataurl',
      caps: ['video']
    });
  }
  return list.filter((x) => x.model && (need === 'any' || x.caps.includes(need)));
}

// ── 对外入口 ─────────────────────────────────────────────────────────────

/** 是否能听（只看配置层面，不探测 ffmpeg）。 */
export function hearingConfigOk(s) {
  const base = String(s?.hearingBaseUrl || s?.llmBaseUrl || '').trim();
  return Boolean(s?.hearingEnabled && base);
}

/**
 * 听一条视频：按 hearingSlices 段抽样，逐段切片 → 逐段听写。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error?:string, text?:string,
 *                    slices?:Array<{at:number, text:string}>, meta?:object}>}
 */
export async function hearVideo(s, video, { hint = '' } = {}) {
  if (!s?.hearingEnabled) return { ok: false, skipped: true, reason: '听觉未启用' };
  const endpoints = endpointsOf(s, { need: 'audio' });
  if (!endpoints.length) {
    return { ok: false, skipped: true, reason: '没有可用的听觉接口（填 hearingBaseUrl+模型，或 hearingBackupBaseUrl）' };
  }
  // 主通道连续失败就熔断，剩下的片段直接走备用 —— 否则每段都要先吃一次 502 的超时
  const breaker = { mainFails: 0, mainDown: false };

  const bvid = String(video?.bvid || '');
  const cid = String(video?.cid || '');
  const dur = Number(video?.duration) || 0;
  if (!bvid || !cid) return { ok: false, skipped: true, reason: '缺少 bvid/cid' };
  if (dur < 15) return { ok: false, skipped: true, reason: '视频太短，没必要听' };

  // 字幕够用就不花这笔钱（可用 hearingOnlyWhenThin 关掉）
  const subLen = String(video?.subtitle?.text || '').length;
  if (s.hearingOnlyWhenThin !== false && subLen >= (Number(s.hearingMinSubtitle) || 300)) {
    return { ok: false, skipped: true, reason: `已有 ${subLen} 字字幕，不必再听` };
  }

  const ff = await resolveFfmpeg(s);
  if (!ff) return { ok: false, error: '找不到 ffmpeg' };

  const started = Date.now();
  let tmp = '';
  try {
    const audio = await playurlAudio(s, bvid, cid);
    const n = Math.max(1, Math.min(6, Math.round(Number(s.hearingSlices) || 3)));
    const secs = Math.max(15, Math.min(45, Math.round(Number(s.hearingSliceSec) || 28)));
    // 采样点：从 0 均匀铺到 (n-1)/n 处，避开片尾（大多是片尾曲/推荐位）
    const span = Math.max(0, dur - secs);
    const points = Array.from({ length: n }, (_, i) => Math.round((span * i) / n));

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-hear-'));
    const slices = [];
    const usedBackends = new Set();
    for (const at of points) {
      const out = path.join(tmp, `s${at}.mp3`);
      let lastErr = null;
      let bytes = 0;
      // 每段：最多 2 轮；每轮按"主 → 备"顺序试，谁先成功用谁
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        for (const ep of endpoints) {
          if (ep.name === 'main' && breaker.mainDown) continue;
          try {
            if (!bytes) {
              bytes = await sliceToMp3(ff, { url: audio.url, bvid, at, secs, out });
            }
            const said = await askAudio({
              base: ep.base, key: ep.key, model: ep.model, style: ep.style,
              mp3Buf: fs.readFileSync(out),
              hint: hint || (video?.title ? `视频《${truncate(video.title, 40)}》` : '')
            });
            slices.push({ at, text: said, kb: Math.round(bytes / 1024), backend: ep.name, attempt });
            usedBackends.add(ep.model);
            log(`[bili-whale] 听觉 ${fmtSec(at)}（${ep.name}）→ ${truncate(said.replace(/\s+/g, ' '), 60)}`);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (ep.name === 'main') {
              breaker.mainFails += 1;
              if (breaker.mainFails >= 2) breaker.mainDown = true;
            }
            log(`[bili-whale] 听觉 ${fmtSec(at)} ${ep.name} 第 ${attempt} 次失败：${truncate(e?.message ?? e, 120)}`);
          }
        }
        if (!lastErr) break;          // 这一轮已经成功，不再重试
      }
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* ignore */ }
      if (lastErr) slices.push({ at, text: '', error: truncate(lastErr?.message ?? lastErr, 140) });
    }

    const good = slices.filter((x) => x.text);
    if (!good.length) {
      const firstErr = slices.find((x) => x.error)?.error || '全部片段都没拿到内容';
      return { ok: false, error: firstErr, slices };
    }
    const text = good.map((x) => `[${fmtSec(x.at)}] ${x.text.replace(/\s+/g, ' ').trim()}`).join('\n');
    return {
      ok: true,
      text,
      slices,
      meta: {
        backends: [...usedBackends], slices: n, secs,
        kb: Math.round((audio.bandwidth / 8000) || 0),
        ms: Date.now() - started
      }
    };
  } catch (e) {
    return { ok: false, error: truncate(e?.message ?? e, 200) };
  } finally {
    try { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
