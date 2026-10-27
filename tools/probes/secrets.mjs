// tools/probes/secrets.mjs —— 闸 5：私名 / QQ号 / 群号 / 手机号 / 密钥 / 绝对路径 扫描
// 用法：node tools/probes/secrets.mjs --repo <repo> --json
//
// 设计要点：
//   · **只扫将被分发的东西**（components / patch / adapter-04 / docs），不扫 tools 与站点 assets
//   · 误报要能白名单（tools/secrets-allowlist.json），否则第一次跑就会被真·端口号淹没
//   · 命中要带「文件:行号 + 片段 + 命中的规则名」，否则修起来等于大海捞针
import fs from 'node:fs';
import path from 'node:path';
import { walkText, rel, emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));

const SCAN_DIRS = ['components', 'patch', 'adapter-04', 'docs'];
const TEXT = /\.(js|mjs|cjs|json|md|html|css|ps1|txt)$/i;

// 规则分两级：
//   error = 一出现就拦（私名、密钥、绝对路径、带上下文的 QQ/群号）
//   warn  = 只报告不拦（裸长数字：FNV 常量 2166136261、哈希位移 4294967296、
//           文档里的示例号都会命中，硬拦会把闸变成噪声源）
const RULES = [
  { name: '私名', level: 'error', re: /青晴雨|小鲤鱼|鲤鱼少女|银囧牙|大肚鱼/g },
  { name: 'QQ号(带上下文)', level: 'error', re: /(?:QQ|uin|qq)[\s:：=]*["']?[1-9]\d{6,11}/gi },
  { name: '群号(带上下文)', level: 'error', re: /(?:群号|group|group_id)[\s:：=]*["']?[1-9]\d{7,11}/gi },
  { name: '手机号', level: 'error', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: 'API密钥', level: 'error', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { name: 'Bearer令牌', level: 'error', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
  { name: '本机绝对路径', level: 'error', re: /[A-Za-z]:\\\\?(?:Users|QingQingyuAgent|QQ-Agent)/g },
  { name: '裸长数字(疑似QQ)', level: 'warn', re: /(?<![\d.])\d{9,11}(?![\d.])/g }
];

// 允许的例外（按 文件相对路径 + 规则名 + 片段/整行 三者匹配）
const allowlistPath = path.join(repo, 'tools', 'secrets-allowlist.json');
const allowlist = exists(allowlistPath) ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) : { entries: [] };

// 明显是**示例/占位**的数字：文档与测试里到处都是（123456/john doe 那一套）。
// 全局放行它们，比给每个文件开白名单更安全 —— 真号不会长这样。
const SYNTHETIC = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890',
  '789012', '10001', '10002', '000000000', '0123456789'
]);

function isSynthetic(snippet) {
  const digits = String(snippet).replace(/\D/g, '');
  return SYNTHETIC.has(digits);
}

function allowed(file, rule, snippet, line) {
  return (allowlist.entries || []).some((e) =>
    (!e.file || file.includes(e.file)) &&
    (!e.rule || e.rule === rule) &&
    (!e.contains || snippet.includes(e.contains) || String(line).includes(e.contains)));
}

const hits = [];
const warns = [];
const files = SCAN_DIRS.map((d) => path.join(repo, d)).filter(exists)
  .flatMap((d) => walkText(d).filter((p) => TEXT.test(p)));

for (const f of files) {
  const file = rel(repo, f);
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 4000) return;                 // 压缩产物跳过
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const snippet = m[0].slice(0, 40);
        if (isSynthetic(snippet)) { if (m[0].length === 0) break; continue; }
        if (allowed(file, rule.name, snippet, line)) { if (m[0].length === 0) break; continue; }
        const item = { file, line: i + 1, rule: rule.name, snippet, context: line.trim().slice(0, 90) };
        if (rule.level === 'warn') warns.push(item); else hits.push(item);
        if (m[0].length === 0) break;
      }
    }
  });
}

const result = {
  name: 'secrets',
  ok: hits.length === 0,
  scanned: files.length,
  hits: hits.slice(0, 40),
  total: hits.length,
  warnings: warns.slice(0, 12),
  warningTotal: warns.length,
  message: hits.length
    ? `${hits.length} 处阻断级命中（另有 ${warns.length} 处提示级）`
    : `${files.length} 个文件：阻断级 0 处${warns.length ? `，提示级 ${warns.length} 处（裸数字，需人工扫一眼）` : ''}`
};
if (args.json) emit(result);
else {
  console.log(`${result.ok ? '✅' : '❌'} ${result.message}`);
  for (const h of result.hits.slice(0, 20)) console.log(`   ${h.file}:${h.line} [${h.rule}] ${h.context}`);
  if (warns.length) {
    console.log(`   — 提示级（不拦）${warns.length} 处，前 5：`);
    for (const w of warns.slice(0, 5)) console.log(`     ${w.file}:${w.line} ${w.snippet}`);
  }
}
process.exit(result.ok ? 0 : 1);
