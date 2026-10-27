// tools/probes/syntax.mjs —— 闸 2：所有 JS 过 node --check
// 用法：node tools/probes/syntax.mjs --repo <repo> --json
import path from 'node:path';
import { walkJs, run, rel, emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));

const targets = ['components', 'tools', 'patch', 'adapter-04']
  .map((d) => path.join(repo, d))
  .filter((d) => exists(d));

// ⚠️ `*/snippets/*.js` 是**代码片段**（插进宿主文件的半截语句），不是独立模块 ——
//    直接 node --check 必然报错。它们由 install.mjs 的锚点插入负责校验（插入后宿主能过语法检查）。
const isFragment = (p) => p.split(/[\\/]/).includes('snippets') || p.endsWith('.deprecated');

const files = targets.flatMap((d) => walkJs(d)).filter((p) => !isFragment(p));
const bad = [];
for (const f of files) {
  const r = run(process.execPath, ['--check', f]);
  if (r.code !== 0) {
    bad.push({ file: rel(repo, f), error: (r.stderr || r.error?.message || '').split('\n').slice(0, 3).join(' ').trim() });
  }
}

const result = {
  name: 'syntax',
  ok: bad.length === 0,
  checked: files.length,
  failures: bad,
  message: bad.length ? `${bad.length}/${files.length} 个文件语法错误` : `${files.length} 个文件语法全部通过`
};
if (args.json) emit(result);
else console.log(`${result.ok ? '✅' : '❌'} ${result.message}`, bad.slice(0, 5));
process.exit(result.ok ? 0 : 1);
