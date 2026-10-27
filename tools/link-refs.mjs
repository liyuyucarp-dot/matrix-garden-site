#!/usr/bin/env node
// tools/link-refs.mjs —— 角色图不进仓库，这里负责"把本地的图对上去"
//
// 用法：
//   node tools/link-refs.mjs --check --from "D:\my-refs"          # 按 refs.manifest.json 校验 sha256
//   node tools/link-refs.mjs --app "D:\QQ-Agent 0.4 preview" --from "D:\my-refs"
//
// 为什么单独一个脚本：角色图来源混杂（自绘/AI 生成/他人开源作品），不能随 MIT 代码一起分发。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, exists, walk, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(import.meta.dirname, '..');
const manifest = readJson(path.join(repo, 'assets-optional', 'refs.manifest.json'));
const from = args.from ? path.resolve(String(args.from)) : null;
if (!from) {
  console.error('用法: node tools/link-refs.mjs [--check] --from <角色图目录> [--app <宿主目录>]');
  console.error(`清单里共 ${manifest.files.length} 张（合计 ${(manifest.total_bytes / 1048576).toFixed(2)} MB）`);
  process.exit(2);
}
if (!exists(from)) { console.error('目录不存在: ' + from); process.exit(2); }

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const local = new Map(walk(from, (p) => /\.(jpg|jpeg|png|webp)$/i.test(p)).map((p) => [path.basename(p), p]));
const missing = [], mismatch = [];
for (const f of manifest.files) {
  const p = local.get(f.file);
  if (!p) { missing.push(f.file); continue; }
  if (sha(p) !== f.sha256) mismatch.push(f.file);
}
console.log(`清单 ${manifest.files.length} 张 ｜ 本地命中 ${manifest.files.length - missing.length} ｜ 缺 ${missing.length} ｜ 校验不符 ${mismatch.length}`);
if (missing.length) console.log('  缺:', missing.join(', '));
if (mismatch.length) console.log('  不符（可能是你自己的替代图，允许）:', mismatch.join(', '));

if (args.check) process.exit(missing.length ? 1 : 0);

let appDir = args.app ? path.resolve(String(args.app)) : null;
if (appDir && exists(path.join(appDir, 'resources', 'app'))) appDir = path.join(appDir, 'resources', 'app');
if (!appDir) { console.error('要拷贝请给 --app <宿主目录>'); process.exit(2); }
const root = exists(path.join(appDir, '..', 'data')) ? path.join(appDir, '..') : appDir;
const dst = path.join(root, 'data', 'skills', 'travel-whale', 'refs');
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const [, p] of local) { fs.copyFileSync(p, path.join(dst, path.basename(p))); n += 1; }
console.log(`已拷贝 ${n} 张 → ${dst}`);
console.log('提示：立绘（panel/portraits）是另一套图，随组件分发，不需要这里处理。');
