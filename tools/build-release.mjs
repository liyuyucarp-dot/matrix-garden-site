// tools/build-release.mjs —— 一键构建/校验/打包（七道闸 + 可选 ESLint）
//
// 用法：
//   node tools/build-release.mjs                      # 全跑 + 打包到 dist/
//   node tools/build-release.mjs --no-zip             # 只跑闸，不产包（CI 的 PR 检查用）
//   node tools/build-release.mjs --version 3.0.0      # 覆盖产物版本号
//   node tools/build-release.mjs --strict             # 跳过也算失败（CI 发布用）
//   node tools/build-release.mjs --only syntax,secrets
//
// 设计原则：
//   · **零依赖**（不 npm install 也能跑），CI 里也一样
//   · 每道闸都是独立子进程：一个崩了不影响其他闸的报告
//   · 任何一道失败 → 退出码 1，**绝不产包**（宁可不发，也不发半成品）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readJson, writeJson, walk, sha256File, rel, exists, parseArgs, parseProbeOutput } from './lib/util.mjs';
import { writeZip } from './lib/zip.mjs';

const args = parseArgs();
const repo = path.resolve(import.meta.dirname, '..');
const distDir = path.join(repo, args.out || 'dist');
const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;

const GATES = [
  { id: 'manifest', title: '闸1 组件清单', run: gateManifest },
  { id: 'syntax', title: '闸2 语法', probe: 'syntax.mjs' },
  { id: 'load', title: '闸3 加载探针（0.4.8.x 形状）', probe: 'load.mjs', probeArgs: ['--shape', '048'] },
  { id: 'qzone-core', title: '闸3c qzone-core 纯函数自检', probe: 'qzone-core.mjs' },
  { id: 'load-04', title: '闸3b 加载探针（官方 0.4 preview 形状，无 storage）', probe: 'load.mjs', probeArgs: ['--shape', '04preview'] },
  { id: 'snapshot', title: '闸4 快照探针', probe: 'snapshot.mjs' },
  { id: 'theme', title: '闸4b 世界主题包自测（换主世界/任意世界晋升）', probe: 'theme.mjs' },
  { id: 'secrets', title: '闸5 脱敏/隐私', probe: 'secrets.mjs' },
  { id: 'panel', title: '闸6 面板契约', probe: 'panel.mjs' },
  { id: 'eslint', title: '闸8 ESLint(no-undef)', run: gateEslint, optional: true }
];

function gateManifest() {
  const problems = [];
  const cf = path.join(repo, 'components.json');
  if (!exists(cf)) return { ok: false, problems: [{ check: 'components.json', detail: '缺失' }] };
  const meta = readJson(cf);
  const comps = meta.components || [];
  if (!comps.length) problems.push({ check: 'components', detail: '清单为空' });
  for (const c of comps) {
    const dir = path.join(repo, c.path);
    if (!exists(dir)) { problems.push({ check: 'missing', detail: `${c.id}: 目录不存在 ${c.path}` }); continue; }
    const mf = path.join(dir, c.kind === 'skills' ? 'skill.json' : 'plugin.json');
    if (!exists(mf)) { problems.push({ check: 'manifest', detail: `${c.id}: 缺 ${path.basename(mf)}` }); continue; }
    let m;
    try { m = readJson(mf); } catch (e) { problems.push({ check: 'json', detail: `${c.id}: manifest 不是合法 JSON` }); continue; }
    if (!m.version) problems.push({ check: 'version', detail: `${c.id}: manifest 无 version` });
    if (c.version && m.version && c.version !== m.version) {
      problems.push({ check: 'version-drift', detail: `${c.id}: components.json=${c.version} 与 manifest=${m.version} 不一致` });
    }
    if (!exists(path.join(dir, m.entry || 'index.js'))) problems.push({ check: 'entry', detail: `${c.id}: 入口文件不存在` });
  }
  // 补丁清单也要能解析
  for (const p of (meta.patches || [])) {
    const mf = path.join(repo, p.path, 'manifest.json');
    if (!exists(mf)) { problems.push({ check: 'patch', detail: `${p.id}: 缺 ${p.path}/manifest.json` }); continue; }
    try {
      const m = readJson(mf);
      if (!Array.isArray(m.entries) || !m.entries.length) problems.push({ check: 'patch', detail: `${p.id}: entries 为空` });
    } catch { problems.push({ check: 'patch', detail: `${p.id}: manifest 不是合法 JSON` }); }
  }
  return { ok: problems.length === 0, problems, detail: `${comps.length} 个组件 / ${(meta.patches || []).length} 套补丁` };
}

function gateEslint() {
  // 用 ESLint 8 而不是 9：9 的 flat config 删掉了 --no-eslintrc/--env/--parser-options，
  // 而这里刻意**不落 .eslintrc 文件**（保持仓库零配置），所以钉 8.x。
  const local = path.join(repo, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const versionProbe = exists(local)
    ? spawnSync(process.execPath, [local, '--version'], { encoding: 'utf8' })
    : spawnSync('npx', ['--no-install', 'eslint@8', '--version'], { encoding: 'utf8', shell: true });
  const available = versionProbe.status === 0;
  if (!available) return { skipped: true, ok: true, detail: '未安装 eslint@8（npm i -D eslint@8 后启用；CI 会装）' };

  const bin = exists(local) ? process.execPath : 'npx';
  const base = exists(local) ? [local] : ['--no-install', 'eslint@8'];
  const argv = [
    ...base,
    'components',
    '--no-eslintrc',
    '--rule', '{"no-undef":"error"}',
    // 面板 JS 是浏览器代码（document/window/localStorage），组件是 Node —— 两套环境都要给
    '--env', 'es2022,node,browser',
    '--parser-options', '{"ecmaVersion":2022,"sourceType":"module"}',
    '--ignore-pattern', '**/dev-tests/**',
    '--ignore-pattern', '**/panel/**/*.min.js',
    '--ext', '.js,.mjs'
  ];
  const r = spawnSync(bin, argv, { cwd: repo, encoding: 'utf8', shell: bin === 'npx' });
  return { ok: r.status === 0, detail: (r.stdout || r.stderr || '').slice(-1500) };
}

function runProbe(file, extraArgs = []) {
  const p = path.join(repo, 'tools', 'probes', file);
  const r = spawnSync(process.execPath, [p, '--repo', repo, '--json', ...extraArgs], { encoding: 'utf8', timeout: 180000 });
  const parsed = parseProbeOutput(r.stdout || '');
  if (parsed) return parsed;
  return { ok: false, message: '探针没有产出 JSON', stderr: (r.stderr || '').slice(-800), stdout: (r.stdout || '').slice(-400) };
}

async function main() {
  const meta = readJson(path.join(repo, 'components.json'));
  const version = String(args.version || meta.version || '0.0.0');
  console.log(`\n矩阵庭院 · 构建 ${version}   （${new Date().toLocaleString('zh-CN')}）`);
  console.log('='.repeat(64));

  const results = [];
  for (const g of GATES) {
    if (only && !only.includes(g.id)) continue;
    let res;
    if (g.run) res = g.run();
    else res = runProbe(g.probe, g.probeArgs);
    if (g.optional && res.skipped) {
      console.log(`⏭  ${g.title}: ${res.detail}`);
      results.push({ ...g, skipped: true, ok: true });
      continue;
    }
    const okMark = res.ok ? '✅' : '❌';
    console.log(`${okMark} ${g.title}: ${res.message || res.detail || ''}`);
    if (!res.ok) {
      const list = res.problems || res.failures || res.hits || [];
      for (const it of list.slice(0, 20)) {
        const line = it.detail || it.error || `[${it.rule || it.kind || it.check}] ${it.file || ''}${it.line ? ':' + it.line : ''} ${it.context || it.snippet || ''}`;
        console.log('     - ' + String(line).replace(/\s+/g, ' ').slice(0, 240));
      }
      if (res.stderr) console.log('     stderr: ' + res.stderr.split('\n').slice(-4).join(' | '));
    }
    results.push({ ...g, ...res });
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);

  console.log('='.repeat(64));
  console.log(`结果：${results.length - failed.length - skipped.length} 通过 / ${skipped.length} 跳过 / ${failed.length} 失败`);

  if (failed.length) {
    if (args.strict && skipped.length) console.log('⚠️ strict 模式：跳过项视为失败');
    if (!args.strict || !skipped.length) {
      console.log('❌ 有闸未通过，**不产包**。修完再跑。');
      process.exit(1);
    }
  }
  if (args.strict && skipped.length) {
    console.log('❌ strict 模式：存在跳过项（' + skipped.map((s) => s.id).join(',') + '），不产包。');
    process.exit(1);
  }

  if (args['no-zip']) {
    console.log('（--no-zip：跳过打包）');
    return;
  }

  // ── 闸7：打包（UTF-8 EFS + SHA256SUMS + release.json）──────────────
  const stageName = `matrix-garden-v${version}`;
  const entries = [];
  const collect = (absDir, prefix) => {
    if (!exists(absDir)) return;
    for (const f of walk(absDir)) {
      entries.push({ abs: f, name: `${prefix}/${rel(absDir, f)}` });
    }
  };
  collect(path.join(repo, 'components', 'skills'), `${stageName}/skills`);
  collect(path.join(repo, 'components', 'plugins'), `${stageName}/plugins`);
  collect(path.join(repo, 'patch'), `${stageName}/核心补丁`);
  collect(path.join(repo, 'adapter-04'), `${stageName}/官方0.4适配`);
  collect(path.join(repo, 'docs'), `${stageName}`);
  collect(path.join(repo, 'tools'), `${stageName}/tools`);
  const readme = path.join(repo, 'README.md');
  if (exists(readme)) entries.push({ abs: readme, name: `${stageName}/README.md` });
  // components.json 必须在包根：包内的 tools/install.mjs 就是按 `<stage>/components.json` 找清单的
  const compPath = path.join(repo, 'components.json');
  if (exists(compPath)) entries.push({ abs: compPath, name: `${stageName}/components.json` });
  const lic = path.join(repo, 'LICENSE');
  if (exists(lic)) entries.push({ abs: lic, name: `${stageName}/LICENSE` });
  const notices = path.join(repo, 'THIRD-PARTY-NOTICES.md');
  if (exists(notices)) entries.push({ abs: notices, name: `${stageName}/THIRD-PARTY-NOTICES.md` });

  const zipPath = path.join(distDir, `${stageName}.zip`);
  const zr = writeZip(zipPath, entries);
  console.log(`✅ 闸7 打包: ${rel(repo, zipPath)}（${zr.entries} 条目 / ${(zr.bytes / 1048576).toFixed(2)} MB，UTF-8 标志已置位）`);

  const sha = sha256File(zipPath);
  fs.writeFileSync(path.join(distDir, `${stageName}.zip.sha256`), `${sha}  ${stageName}.zip\n`, 'utf8');
  writeJson(path.join(distDir, 'release.json'), {
    package: 'matrix-garden',
    version,
    builtAt: new Date().toISOString(),
    file: `${stageName}.zip`,
    bytes: zr.bytes,
    entries: zr.entries,
    sha256: sha,
    components: (meta.components || []).map((c) => ({ kind: c.kind, id: c.id, version: c.version })),
    gates: results.map((r) => ({ id: r.id, ok: r.ok, skipped: !!r.skipped, message: r.message || r.detail || '' }))
  });
  console.log(`  sha256 ${sha.slice(0, 16)}…  → dist/release.json`);
}

await main();
