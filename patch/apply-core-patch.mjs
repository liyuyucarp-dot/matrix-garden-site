#!/usr/bin/env node
/**
 * 核心补丁 · 手术式应用（跨平台 Node.js 版，Windows / Linux / macOS 通用）
 *
 * 作用：
 *   读取同目录下的 manifest.json，逐项执行 copy-new / anchor-insert / replace-line（及向后兼容 copy）。
 *   与 apply-core-patch.ps1 行为 100% 对齐：先备份到目标宿主目录的 `_core_patch_backup_<时间戳>`、
 *   按 marker 严格幂等跳过、锚点或待替换行不唯一时拒绝盲改并打印清晰指引。
 *
 * 用法：
 *   node apply-core-patch.mjs --app-dir "/path/to/QQ Agent/resources/app"
 *   node apply-core-patch.mjs --app-dir "D:\\QQAgent\\resources\\app" --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let appDir = '';
  let dryRun = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-DryRun') dryRun = true;
    else if ((a === '--app-dir' || a === '-AppDir') && argv[i + 1]) {
      appDir = argv[++i];
    } else if (!a.startsWith('-') && !appDir) {
      appDir = a;
    }
  }
  return { appDir, dryRun };
}

function stampOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function applyCorePatch({ appDir, dryRun = false, silent = false } = {}) {
  const log = (...a) => { if (!silent) console.log(...a); };
  const ok = (t) => log(`  [OK]   ${t}`);
  const skip = (t) => log(`  [SKIP] ${t}`);
  const err = (t) => log(`  [ERR]  ${t}`);

  if (!appDir || !fs.existsSync(path.join(appDir, 'src'))) {
    throw new Error(`指定的目录不像 QQ Agent 的 resources/app（缺少 src 子目录）：${appDir || '(未指定)'}`);
  }
  const appRoot = path.resolve(appDir);
  const backupDir = path.join(appRoot, `_core_patch_backup_${stampOf()}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));

  log(`\n== ${manifest.name}（${manifest.version}）==`);
  log(`  目标：${appRoot}`);
  if (dryRun) log('  [!!]   演练模式：只看会动哪些文件，不实际写入');

  const backupItem = (dstFile, relPath) => {
    if (!fs.existsSync(dstFile)) return;
    if (dryRun) { skip(`会备份：${relPath}`); return; }
    const bDst = path.join(backupDir, relPath);
    fs.mkdirSync(path.dirname(bDst), { recursive: true });
    fs.copyFileSync(dstFile, bDst);
  };

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const e of manifest.entries) {
    const relPath = e.path;
    const dstFile = path.join(appRoot, relPath);
    const kind = e.kind;

    try {
      if (kind === 'copy-new') {
        if (fs.existsSync(dstFile)) {
          skip(`已存在（幂等跳过）：${relPath}`);
          skipped += 1;
          continue;
        }
        const srcFile = path.join(HERE, 'files', relPath);
        if (!fs.existsSync(srcFile)) {
          err(`补丁包缺文件：${relPath}`);
          failed += 1;
          continue;
        }
        if (dryRun) { skip(`会新增：${relPath}`); continue; }
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
        ok(`新增 ${relPath}`);
        done += 1;
      } else if (kind === 'copy') {
        const srcFile = path.join(HERE, 'files', relPath);
        if (!fs.existsSync(srcFile)) {
          err(`补丁包缺文件：${relPath}`);
          failed += 1;
          continue;
        }
        backupItem(dstFile, relPath);
        if (dryRun) { skip(`会覆盖：${relPath}`); continue; }
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
        ok(`覆盖 ${relPath}`);
        done += 1;
      } else if (kind === 'anchor-insert') {
        if (!fs.existsSync(dstFile)) {
          err(`目标文件不存在：${relPath}`);
          failed += 1;
          continue;
        }
        const content = fs.readFileSync(dstFile, 'utf8');
        if (content.includes(e.marker)) {
          skip(`已打过（幂等跳过）：${relPath} [${e.marker}]`);
          skipped += 1;
          continue;
        }
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const idx = lines.findIndex((l) => l.includes(e.anchor));
        if (idx < 0) {
          err(`锚点未找到：${relPath}（anchor: ${e.anchor}）—— 宿主版本可能不同，请检查手动接线文档`);
          failed += 1;
          continue;
        }
        const snippetRaw = fs.readFileSync(path.join(HERE, e.insertFile), 'utf8').replace(/\r?\n$/, '');
        const snippetLines = snippetRaw.split(/\r?\n/);
        if (dryRun) {
          skip(`会插入 ${e.insertFile} → ${relPath} @行${idx + 1}`);
          continue;
        }
        backupItem(dstFile, relPath);
        const out = e.insertAfterAnchor
          ? [...lines.slice(0, idx + 1), ...snippetLines, ...lines.slice(idx + 1)]
          : [...lines.slice(0, idx), ...snippetLines, ...lines.slice(idx)];
        fs.writeFileSync(dstFile, out.join(eol), 'utf8');
        ok(`插入 ${e.insertFile} → ${relPath}`);
        done += 1;
      } else if (kind === 'replace-line') {
        if (!fs.existsSync(dstFile)) {
          err(`目标文件不存在：${relPath}`);
          failed += 1;
          continue;
        }
        const content = fs.readFileSync(dstFile, 'utf8');
        if (content.includes(e.marker)) {
          skip(`已打过（幂等跳过）：${relPath} [${e.marker}]`);
          skipped += 1;
          continue;
        }
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const lines = content.split(/\r?\n/);
        const hits = [];
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(e.from)) hits.push(i);
        }
        if (hits.length === 0) {
          err(`待替换行未找到：${relPath}（from: ${e.from}）—— 宿主版本可能不同`);
          failed += 1;
          continue;
        }
        if (hits.length > 1) {
          err(`待替换行命中 ${hits.length} 处（应唯一）：${relPath} —— 为避免误改已跳过`);
          failed += 1;
          continue;
        }
        const hitIdx = hits[0];
        if (dryRun) {
          skip(`会替换第 ${hitIdx + 1} 行 → ${relPath}`);
          continue;
        }
        backupItem(dstFile, relPath);
        lines[hitIdx] = e.to;
        fs.writeFileSync(dstFile, lines.join(eol), 'utf8');
        ok(`替换第 ${hitIdx + 1} 行 → ${relPath}`);
        done += 1;
      }
    } catch (error) {
      err(`${relPath} 失败：${error?.message ?? error}`);
      failed += 1;
    }
  }

  log(`\n  完成 ${done} · 跳过 ${skipped} · 失败 ${failed}`);
  if (fs.existsSync(backupDir)) log(`  备份在：${backupDir}`);
  log('  [!!]   核心补丁需要【完整重启】QQ Agent 才生效。\n');
  return { done, skipped, failed, backupDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { appDir, dryRun } = parseArgs(process.argv);
  try {
    const res = applyCorePatch({ appDir, dryRun });
    if (res.failed > 0) process.exitCode = 1;
  } catch (e) {
    console.error(`  [ERR]  ${e?.message ?? e}`);
    process.exitCode = 1;
  }
}
