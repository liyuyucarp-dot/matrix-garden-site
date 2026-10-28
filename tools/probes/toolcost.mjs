// tools/probes/toolcost.mjs —— 闸7：工具段「常驻成本」预算
//
// 工具描述是**每轮请求都随 tools 段发出去**的固定成本，而且 tools 在 messages 之前，
// 一变就打穿前缀缓存。所以它必须有个预算，不能想写多长写多长。
//
// 口径（为什么不用运行时抓 registerTool）：
//   描述大多是 `'a' + 'b' + fn()` 拼的，运行时一旦 setup 在桩环境里早退就抓不到；
//   这里静态把**字面量拼起来**量字符数（运行时插值不计，前后对比一致）。
//   params 用大括号配对截取，绝不把 execute 的代码算进成本。
//
// 用法：node tools/probes/toolcost.mjs [--repo .] [--json] [--verbose]
import fs from 'node:fs';
import path from 'node:path';
import { emit, parseArgs, readJson, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const meta = readJson(path.join(repo, 'components.json'));

// 预算（2026-10-28 首次标定：当前 17,732 字符，留 8% 余量）
const BUDGET = {
  toolMax: Number(args.toolMax || 1050),      // 单工具 desc+params 字符上限
  descMax: Number(args.descMax || 300),       // 单工具 description 文本上限
  totalMax: Number(args.totalMax || 19200),   // 全部工具合计字符上限
  compMax: { 'travel-whale': 8800 }            // 大户单独卡
};

function lits(seg) {
  let out = '';
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(seg)) !== null) out += m[2];
  return out;
}

function braceEnd(s, i) {
  let d = 0;
  for (; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') { d--; if (d === 0) return i; }
  }
  return s.length - 1;
}

function measure(src) {
  const rows = [];
  const reReg = /registerTool\(\s*\{/g;
  let m;
  while ((m = reReg.exec(src)) !== null) {
    const b0 = src.indexOf('{', m.index);
    const body = src.slice(b0, braceEnd(src, b0) + 1);
    const idm = body.match(/\bid\s*:\s*(?:TOOL\.(\w+)|TOOL\(\s*'([^']+)'\s*\)|'([^']+)'|`([^`]+)`)/);
    const tid = idm ? (idm[1] || idm[2] || idm[3] || idm[4]) : '?';
    let paramsTxt = '';
    let dEnd = body.length;
    const pm = body.match(/\bparameters\s*:\s*\{/);
    if (pm) {
      const ps = body.indexOf('{', pm.index);
      paramsTxt = body.slice(ps, braceEnd(body, ps) + 1);
      dEnd = pm.index;
    }
    const d = body.indexOf('description:');
    const descTxt = (d >= 0 && d < dEnd) ? lits(body.slice(d, dEnd)) : '';
    rows.push({ id: tid, desc: descTxt.length, params: paramsTxt.length, total: descTxt.length + paramsTxt.length });
  }
  return rows;
}

const problems = [];
const all = [];
let total = 0;
for (const c of meta.components || []) {
  const cdir = path.join(repo, c.path);
  if (!exists(cdir)) continue;
  let compSum = 0;
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (f.name === 'panel' || f.name === 'themes' || f.name === 'node_modules') continue;
        walk(p);
      } else if (f.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (!src.includes('registerTool')) continue;
        for (const r of measure(src)) {
          compSum += r.total;
          all.push({ comp: c.id, ...r });
        }
      }
    }
  };
  walk(cdir);
  total += compSum;
  if (BUDGET.compMax[c.id] && compSum > BUDGET.compMax[c.id]) {
    problems.push({ check: 'comp-budget', detail: `${c.id} 工具段 ${compSum} 字符 > 预算 ${BUDGET.compMax[c.id]}` });
  }
}

for (const t of all) {
  if (t.total > BUDGET.toolMax) problems.push({ check: 'tool-budget', detail: `${t.comp}/${t.id} = ${t.total} 字符 > ${BUDGET.toolMax}` });
  if (t.desc > BUDGET.descMax) problems.push({ check: 'desc-budget', detail: `${t.comp}/${t.id} 描述 ${t.desc} 字符 > ${BUDGET.descMax}` });
}
if (total > BUDGET.totalMax) problems.push({ check: 'total-budget', detail: `工具段合计 ${total} 字符 > ${BUDGET.totalMax}` });

const top = [...all].sort((a, b) => b.total - a.total).slice(0, 12);
const ok = problems.length === 0;
const out = {
  name: 'toolcost',
  ok,
  tools: all.length,
  chars: total,
  estTokens: Math.round(total * 0.62),
  budget: BUDGET,
  top,
  problems,
  message: ok
    ? `${all.length} 个工具 / ${total} 字符（≈${Math.round(total * 0.62)} token），在预算内`
    : `超预算：${problems.map((p) => p.detail).join('；').slice(0, 200)}`
};
if (args.json) emit(out);
else {
  console.log(`${ok ? '✅' : '❌'} ${out.message}`);
  if (args.verbose) {
    console.log('\n最贵的 12 个工具：');
    for (const t of top) console.log(`   ${String(t.total).padStart(5)}  ${t.comp.padEnd(18)} ${t.id.padEnd(32)} 描述${String(t.desc).padStart(4)}`);
  }
  for (const p of problems.slice(0, 10)) console.log('   · ' + p.detail);
}
process.exit(ok ? 0 : 1);
