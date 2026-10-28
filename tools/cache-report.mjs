// tools/cache-report.mjs —— 前缀缓存命中率报表（P0）
//
// 为什么不需要"加统计"：宿主**已经有** `[cache-stat]` 日志（每轮一行：
//   `[cache-stat] <id> 第 N 次调用 prompt=35450 cached=32256（91%）`
// ）以及 `[cache-warm]` 的形状预热日志。这个脚本只做一件事：把它们变成一张表。
//
// 用法：
//   node tools/cache-report.mjs --log "F:/QingQingyuAgent/data/logs/qq-agent-2026-10-28.log"
//   node tools/cache-report.mjs --dir "F:/QingQingyuAgent/data/logs"        # 汇总最近的日志
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/util.mjs';

const args = parseArgs();
const files = [];
if (args.log) files.push(path.resolve(args.log));
else if (args.dir) {
  const d = path.resolve(args.dir);
  for (const f of fs.readdirSync(d)) {
    if (/\.log$/i.test(f)) files.push(path.join(d, f));
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  files.splice(Number(args.take) || 3);   // 默认最近 3 天
} else {
  console.error('用法：node tools/cache-report.mjs --log <file.log> | --dir <logs目录> [--take 3]');
  process.exit(2);
}

const RE_STAT = /\[cache-stat\][^\n]*?prompt=(\d+)\s+cached=(\d+)/g;
const RE_SHAPE = /形状变化预热/g;
const RE_WARM = /\[cache-warm\][^\n]*?命中\s*(\d+)/g;

const rows = [];
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  let prompt = 0;
  let cached = 0;
  let calls = 0;
  let m;
  RE_STAT.lastIndex = 0;
  while ((m = RE_STAT.exec(txt)) !== null) {
    prompt += Number(m[1]) || 0;
    cached += Number(m[2]) || 0;
    calls += 1;
  }
  const shapes = (txt.match(RE_SHAPE) || []).length;
  rows.push({
    file: path.basename(f),
    calls, prompt, cached,
    hitRate: prompt ? cached / prompt : 0,
    shapeChanges: shapes
  });
}

const sum = rows.reduce((a, r) => ({
  calls: a.calls + r.calls, prompt: a.prompt + r.prompt, cached: a.cached + r.cached, shapes: a.shapes + r.shapeChanges
}), { calls: 0, prompt: 0, cached: 0, shapes: 0 });

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const k = (n) => `${Math.round(n / 1000)}k`;
const pad = (v, n, right = false) => {
  const s = String(v);
  return right ? s.padStart(n) : s.padEnd(n);
};
const line = (a, b, c, d, e, f) => `${pad(a, 16)}${pad(b, 7, true)}${pad(c, 9, true)}${pad(d, 9, true)}${pad(e, 9, true)}${pad(f, 10, true)}`;

console.log('前缀缓存命中率报表（口径：ΣcachedTokens / ΣpromptTokens，按 token 加权）\n');
console.log(line('日志', '调用', 'prompt', 'cached', '命中率', '形状变化'));
console.log('-'.repeat(60));
for (const r of rows) {
  console.log(line(
    r.file.replace(/^qq-agent-/, '').replace(/\.log$/, ''),
    r.calls, k(r.prompt), k(r.cached), pct(r.hitRate), r.shapeChanges));
}
console.log('-'.repeat(60));
console.log(line('合计', sum.calls, k(sum.prompt), k(sum.cached), pct(sum.prompt ? sum.cached / sum.prompt : 0), sum.shapes));

console.log('\n解读：');
console.log(`· 命中率 ${pct(sum.prompt ? sum.cached / sum.prompt : 0)}（目标 ≥80%）`);
console.log(`· 每轮平均 miss ≈ ${sum.calls ? k((sum.prompt - sum.cached) / sum.calls) : 0} token（这部分就是 user 提示词 + 尾部注入）`);
console.log(`· system 形状变化 ${sum.shapes} 次 / ${rows.length} 天 → 平均 ${(sum.shapes / Math.max(1, rows.length)).toFixed(1)} 次/天`);
if (sum.prompt && sum.cached / sum.prompt >= 0.8) {
  console.log('· 结论：**已经达标**。system/tools 前缀稳定，剩下的 miss 集中在 user 段与尾部注入 —— 再优化只能压那部分体积，不是命中率问题。');
} else {
  console.log('· 结论：未达标，先看 system 是否每轮在变（形状变化次数）与 tools 段是否抖动。');
}
