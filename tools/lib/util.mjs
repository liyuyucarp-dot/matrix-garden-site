// tools/lib/util.mjs —— 构建/探针共用的最小工具集（零依赖）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const readText = (p) => fs.readFileSync(p, 'utf8');
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

export function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

export function walk(dir, filter = () => true) {
  const out = [];
  if (!exists(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

export const walkJs = (dir) => walk(dir, (p) => /\.(mjs|cjs|js)$/.test(p));
export const walkText = (dir) => walk(dir, (p) => /\.(js|mjs|cjs|json|md|html|css|ps1|txt|yml|yaml)$/.test(p));

const rel = (base, p) => path.relative(base, p).split(path.sep).join('/');
export { rel };

/** 跑子进程（node --check 等），返回 {code, stdout, stderr} */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout || 60000, ...opts });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

/** 供探针用：把结果按统一 JSON 打到 stdout（build-release 解析） */
export function emit(result) {
  process.stdout.write('\n<<<PROBE_JSON>>>' + JSON.stringify(result) + '\n');
}

export function parseProbeOutput(stdout) {
  const m = stdout.match(/<<<PROBE_JSON>>>(\{.*\})\s*$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i += 1; }
    } else args._.push(a);
  }
  return args;
}
