// tools/probes/protect.mjs —— 闸4c：安全类插件自检（persona-shield）
//
// 为什么单独一道：这两个插件（护心镜 / 视觉卫士）改的是**发给模型的上下文与出站消息**，
// 一旦误伤就是"该说话时闭嘴"或"上下文被删"。它们各自带离线自测，跑一遍比人工点强。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const psSelftest = path.join(repo, 'components', 'plugins', 'persona-shield', 'selftest.mjs');
const vgIndex = path.join(repo, 'components', 'plugins', 'vision-guard', 'index.js');

const problems = [];
let detail = '';

// ① persona-shield 自带自测
if (!exists(psSelftest)) {
  problems.push({ check: 'persona-shield', detail: '缺 selftest.mjs' });
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-protect-'));
  try {
    const out = execFileSync(process.execPath, [psSelftest], {
      cwd: path.dirname(psSelftest),
      env: { ...process.env, QQ_AGENT_DATA_DIR: path.join(tmp, 'data') },
      encoding: 'utf8',
      timeout: 60000
    });
    detail = out.trim().split('\n').slice(-2).join(' ');
  } catch (e) {
    const out = ((e.stdout || '') + (e.stderr || '')).trim();
    const m = out.match(/AssertionError[^\n]*: ?([^\n]*)/);
    problems.push({ check: 'persona-shield', detail: (m ? m[1] : out.split('\n').slice(-2)[0] || '未知失败').slice(0, 180) });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ② vision-guard 必须能 import 且导出宿主契约（hooks / providers / setup）
if (!exists(vgIndex)) {
  problems.push({ check: 'vision-guard', detail: '缺 index.js' });
} else {
  try {
    const mod = await import(new URL('file://' + vgIndex.replace(/\\/g, '/')).href);
    const need = ['setup', 'hooks', 'providers', 'dispose'];
    const miss = need.filter((k) => !(k in mod));
    if (miss.length) problems.push({ check: 'vision-guard', detail: '缺导出：' + miss.join(',') });
    if (!mod.hooks || !mod.hooks['before-context']) problems.push({ check: 'vision-guard', detail: '缺 before-context hook' });
    if (!mod.providers || !mod.providers['llm.request-params'] || !mod.providers['tool.guard']) {
      problems.push({ check: 'vision-guard', detail: '缺 llm.request-params / tool.guard provider' });
    }
  } catch (e) {
    problems.push({ check: 'vision-guard', detail: String(e?.message || e).slice(0, 180) });
  }
}

const ok = problems.length === 0;
const result = {
  name: 'protect',
  ok,
  problems,
  message: ok ? '安全插件自检通过（护心镜离线自测 + 视觉卫士契约）' : `安全插件自检失败：${problems.map((p) => p.detail).join('；').slice(0, 160)}`
};
if (args.json) emit(result);
else console.log(`${ok ? '✅' : '❌'} ${result.message}`);
process.exit(ok ? 0 : 1);
