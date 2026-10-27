// tools/install.mjs —— 跨平台安装/打补丁（取代 install.ps1 + apply-core-patch.ps1）
//
// 用法：
//   node tools/install.mjs --app "D:\QQ-Agent 0.4 preview" --components [--patch patch] [--adapter adapter-04]
//   node tools/install.mjs --app "<APP>" --patch patch --adapter adapter-04 --dry-run
//   node tools/install.mjs --app "<APP>" --components --refs "D:\refs" --yes
//
// 设计要点：
//   · **同一份 manifest.json 由两个执行器共用**（本文件与旧 ps1），绝不允许各写一份（必然漂移）
//   · 支持 4 种操作：copy-new / copy / anchor-insert / replace-block（+ replace-line 兼容）
//   · 幂等：marker 命中即 SKIP；`--dry-run` 只打印计划
//   · 备份到 <app>/_backup_<stamp>/，**任一操作失败自动回滚**已改的文件
//   · 自动识别宿主形态：源码树（有 src/）还是安装版（有 resources/app/src/）
import fs from 'node:fs';
import path from 'node:path';
import { readJson, exists, walk, rel, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(import.meta.dirname, '..');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const DRY = !!args['dry-run'];

function die(msg) { console.error('❌ ' + msg); process.exit(1); }

// ── 解析 app 目录 ─────────────────────────────────────────────────────
function resolveApp(input) {
  const cands = [];
  if (input) cands.push(path.resolve(String(input)));
  cands.push(path.resolve(repo, '..'));
  for (const c of cands) {
    if (exists(path.join(c, 'resources', 'app', 'src', 'plugin-loader.js'))) return path.join(c, 'resources', 'app');
    if (exists(path.join(c, 'src', 'plugin-loader.js'))) return c;
  }
  return null;
}
const appDir = resolveApp(args.app);
if (!appDir) die('找不到宿主 app 目录（需要含 src/plugin-loader.js）。用 --app 指定，如 --app "D:\\QQ-Agent 0.4 preview"');

const backupDir = path.join(appDir, `_backup_${stamp}`);
const plan = [];
let changed = 0, skipped = 0, failed = 0;

function readText(p) { return fs.readFileSync(p, 'utf8'); }
function eolOf(s) { return s.includes('\r\n') ? '\r\n' : '\n'; }
function backup(relPath) {
  const src = path.join(appDir, relPath);
  if (!exists(src)) return;
  const dst = path.join(backupDir, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function writeFile(relPath, content) {
  const dst = path.join(appDir, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!DRY) fs.writeFileSync(dst, content, 'utf8');
}

// ── 四种操作 ──────────────────────────────────────────────────────────
function opCopyNew(entry, manDir) {
  const src = path.join(manDir, 'files', entry.path);
  if (!exists(src)) return { status: 'fail', note: `模板缺失 files/${entry.path}` };
  if (exists(path.join(appDir, entry.path))) return { status: 'skip', note: '已存在（copy-new 不覆盖）' };
  backup(entry.path);
  if (!DRY) {
    const dst = path.join(appDir, entry.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return { status: 'ok', note: '新增 ' + entry.path };
}

function opCopy(entry, manDir) {
  const src = path.join(manDir, 'files', entry.path);
  if (!exists(src)) return { status: 'fail', note: `模板缺失 files/${entry.path}` };
  backup(entry.path);
  if (!DRY) {
    const dst = path.join(appDir, entry.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return { status: 'ok', note: '覆盖 ' + entry.path };
}

function opAnchorInsert(entry, manDir) {
  const target = path.join(appDir, entry.path);
  if (!exists(target)) return { status: 'fail', note: `目标不存在 ${entry.path}` };
  const snippetPath = path.join(manDir, entry.insertFile);
  if (!exists(snippetPath)) return { status: 'fail', note: `片段缺失 ${entry.insertFile}` };
  const cur = readText(target);
  const marker = entry.marker || '';
  if (marker && cur.includes(marker)) return { status: 'skip', note: '已打过（marker 命中）' };
  const anchor = entry.anchor || '';
  const eol = eolOf(cur);
  const lines = cur.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(anchor));
  if (idx < 0) return { status: 'fail', note: `锚点未命中：${anchor.slice(0, 40)}` };
  const snippet = readText(snippetPath).replace(/\r?\n/g, eol);
  const at = entry.insertAfterAnchor === false ? idx : idx + 1;
  lines.splice(at, 0, snippet.replace(new RegExp(eol + '$'), ''));
  backup(entry.path);
  writeFile(entry.path, lines.join(eol));
  return { status: 'ok', note: `插入 ${entry.insertFile} @行${at + 1}` };
}

function opReplaceBlock(entry) {
  const target = path.join(appDir, entry.path);
  if (!exists(target)) return { status: 'fail', note: `目标不存在 ${entry.path}` };
  const cur = readText(target);
  if (entry.marker && cur.includes(entry.marker)) return { status: 'skip', note: '已打过（marker 命中）' };
  const eol = eolOf(cur);
  // ⚠️ manifest 里 from/to 既可能是**数组**（多行块）也可能是**字符串**（单行替换，v2.2.9 起大量使用），
  //    早期版本只处理数组，字符串会被 `"abc".join` 打成运行期错误。
  const arr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  const from = arr(entry.from).join(eol);
  const to = arr(entry.to).join(eol);
  if (!from) return { status: 'fail', note: '该条目没有 from（无法定位）' };
  if (!cur.includes(from)) return { status: 'fail', note: `待替换内容未命中（${from.slice(0, 40)}）` };
  backup(entry.path);
  writeFile(entry.path, cur.replace(from, to));
  return { status: 'ok', note: '替换 1 处' };
}

function opReplaceLine(entry, manDir) {
  // 兼容旧格式：{ path, anchor, insertFile } 或 { path, from, to }
  if (entry.from && entry.to) return opReplaceBlock(entry);
  const target = path.join(appDir, entry.path);
  if (!exists(target)) return { status: 'fail', note: `目标不存在 ${entry.path}` };
  const cur = readText(target);
  if (entry.marker && cur.includes(entry.marker)) return { status: 'skip', note: '已打过（marker 命中）' };
  const eol = eolOf(cur);
  const lines = cur.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(entry.anchor || ''));
  if (idx < 0) return { status: 'fail', note: '行锚点未命中' };
  const snippet = entry.insertFile ? readText(path.join(manDir, entry.insertFile)).replace(/\r?\n$/, '') : (entry.to || '');
  backup(entry.path);
  lines[idx] = snippet;
  writeFile(entry.path, lines.join(eol));
  return { status: 'ok', note: `替换第 ${idx + 1} 行` };
}

function applyManifest(manDir, label) {
  const mf = path.join(manDir, 'manifest.json');
  if (!exists(mf)) { console.log(`\n— ${label}: 没有 manifest.json，跳过`); return; }
  const m = readJson(mf);
  console.log(`\n— ${label}（${m.name || ''} ${m.version || ''}｜${m.entries.length} 项）`);
  if (m.target) console.log(`  目标宿主：${m.target}`);
  for (const e of m.entries) {
    let r;
    try {
      if (e.kind === 'copy-new') r = opCopyNew(e, manDir);
      else if (e.kind === 'copy') r = opCopy(e, manDir);
      else if (e.kind === 'anchor-insert') r = opAnchorInsert(e, manDir);
      else if (e.kind === 'replace-block') r = opReplaceBlock(e);
      else if (e.kind === 'replace-line') r = opReplaceLine(e, manDir);
      else r = { status: 'fail', note: '未知操作 ' + e.kind };
    } catch (err) {
      r = { status: 'fail', note: String(err?.message || err) };
    }
    const mark = r.status === 'ok' ? (DRY ? '·' : '[OK]  ') : r.status === 'skip' ? '[SKIP]' : '[ERR] ';
    console.log(`  ${mark} ${r.note}  → ${e.path}`);
    plan.push({ label, path: e.path, kind: e.kind, ...r });
    if (r.status === 'ok') changed += 1;
    else if (r.status === 'skip') skipped += 1;
    else { failed += 1; if (!DRY) rollbackAndDie(`补丁失败：${e.path}`); }
  }
}

function rollbackAndDie(reason) {
  console.error(`\n❌ ${reason} → 开始回滚（把备份拷回宿主）`);
  if (exists(backupDir)) {
    const files = walk(backupDir);
    for (const f of files) {
      const r = rel(backupDir, f);
      fs.mkdirSync(path.dirname(path.join(appDir, r)), { recursive: true });
      fs.copyFileSync(f, path.join(appDir, r));
      console.error('   已还原 ' + r);
    }
  }
  // 删掉本次新增的文件（备份里没有、但 plan 记录为 ok 的 copy-new）
  for (const p of plan.filter((x) => x.kind === 'copy-new' && x.status === 'ok')) {
    try { fs.rmSync(path.join(appDir, p.path), { force: true }); console.error('   已删除新增 ' + p.path); } catch { /* ignore */ }
  }
  process.exit(1);
}

function copyComponents() {
  const meta = readJson(path.join(repo, 'components.json'));
  console.log(`\n— 组件（${meta.components.length} 个）`);
  for (const c of meta.components) {
    const src = path.join(repo, c.path);
    const dst = path.join(appDir, c.kind, c.id);
    if (exists(dst)) backup(`${c.kind}/${c.id}`);
    if (!DRY) {
      fs.rmSync(dst, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    console.log(`  ${DRY ? '·' : '[OK]  '} ${c.kind}/${c.id} ${c.version || ''}`);
    changed += 1;
  }
}

function copyRefs(refDir) {
  const dst = path.join(appDir, '..', 'data', 'skills', 'travel-whale', 'refs');
  const target = exists(path.join(appDir, '..', 'data')) ? dst : path.join(appDir, 'data', 'skills', 'travel-whale', 'refs');
  console.log(`\n— 角色图（从 ${refDir} → ${target}）`);
  if (!exists(refDir)) { console.log('  [SKIP] 源目录不存在'); return; }
  const files = walk(refDir, (p) => /\.(jpg|jpeg|png|webp)$/i.test(p));
  if (!DRY) fs.mkdirSync(target, { recursive: true });
  for (const f of files) if (!DRY) fs.copyFileSync(f, path.join(target, path.basename(f)));
  console.log(`  ${DRY ? '·' : '[OK]  '} ${files.length} 张`);
}

// ── 执行 ──────────────────────────────────────────────────────────────
console.log('矩阵庭院 · 安装器' + (DRY ? '（演练模式，不改任何文件）' : ''));
console.log('宿主：' + appDir);

if (args.components) copyComponents();
if (args.patch) applyManifest(path.join(repo, String(args.patch)), '核心补丁');
if (args.adapter) applyManifest(path.join(repo, String(args.adapter)), '官方0.4适配');
if (args.refs) copyRefs(String(args.refs));

console.log('\n' + '='.repeat(56));
console.log(`完成 ${changed} · 跳过 ${skipped} · 失败 ${failed}`);
if (failed) {
  console.log('提示：失败通常是「宿主版本不对」——核心补丁只对 QQ Agent 0.4.8.x 有效；');
  console.log('      官方 0.4 preview 请改用 --adapter adapter-04（两套补丁针对不同宿主，别混用）。');
}
if (!DRY && exists(backupDir)) console.log('备份：' + backupDir);
if (!DRY && changed) console.log('⚠️ 核心补丁/组件改动需要【重启宿主】才生效');
process.exit(failed ? 1 : 0);
