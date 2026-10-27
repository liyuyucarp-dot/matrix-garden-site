// tools/probes/theme.mjs —— 闸3d：世界主题包自测（换主世界 / 任意世界晋升 / 切回零残留）
// 用法：node tools/probes/theme.mjs --repo <repo> --json
//
// 为什么单独一道：主题包会牵动「地区表 / 默认解锁 / 世界速写 / 影调 / 主地图分区」五条链路，
// 而且要跨 travel-whale 与 courtyard-map 两个组件。跑它自带的 theme-selftest 最省事也最权威。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const scriptRel = path.join('components', 'skills', 'travel-whale', 'theme-selftest.mjs');

function fail(msg, extra = {}) {
  const out = { name: 'theme', ok: false, problems: [{ check: 'theme', detail: msg }], ...extra };
  if (args.json) emit(out); else console.log('❌ ' + msg);
  process.exit(1);
}

if (!exists(path.join(repo, scriptRel))) fail('缺 theme-selftest.mjs（travel-whale 未带自测脚本）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-theme-'));
const app = path.join(tmp, 'app');
fs.cpSync(path.join(repo, 'components', 'skills'), path.join(app, 'skills'), { recursive: true });
fs.cpSync(path.join(repo, 'components', 'plugins'), path.join(app, 'plugins'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'fixtures', 'host-src'), path.join(app, 'src'), { recursive: true });
const data = path.join(tmp, 'data');
fs.mkdirSync(data, { recursive: true });

const script = path.join(app, 'skills', 'travel-whale', 'theme-selftest.mjs');
let tail = '';
let ok = true;
let err = '';
try {
  const out = execFileSync(process.execPath, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, QQ_AGENT_DATA_DIR: data },
    encoding: 'utf8',
    timeout: 120000
  });
  tail = out.trim().split('\n').slice(-6).join('\n');
} catch (e) {
  ok = false;
  const out = ((e.stdout || '') + (e.stderr || '')).trim();
  tail = out.split('\n').slice(-10).join('\n');
  const m = out.match(/AssertionError[^\n]*: ?([^\n]*)/);
  err = m ? m[1] : (out.split('\n').slice(-2)[0] || '未知失败');
}
fs.rmSync(tmp, { recursive: true, force: true });

const groups = (tail.match(/===\s*\[(\d)\/4\]/g) || []).length;
const result = {
  name: 'theme',
  ok,
  groups,
  detail: tail,
  problems: ok ? [] : [{ check: 'theme-selftest', detail: err.slice(0, 200) }],
  message: ok ? `主题包自测通过（默认 / 艾泽拉斯 / 任意世界晋升 / 切回零残留，4 组）` : `主题包自测失败：${err.slice(0, 120)}`
};
if (args.json) emit(result);
else console.log(`${ok ? '✅' : '❌'} ${result.message}`);
process.exit(ok ? 0 : 1);
