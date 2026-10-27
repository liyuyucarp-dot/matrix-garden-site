// tools/probes/panel.mjs —— 闸 6：面板契约
// 用法：node tools/probes/panel.mjs --repo <repo> --json
//
// 检查三件事（都是真实踩过的坑）：
//   ① `configSchema.<key>.panel` 指向的文件必须存在 → 否则点了按钮白屏
//   ② 面板 HTML 引用的 css/js 必须带 `?v=` 版本号 → 否则改了看不到效果（v2.2.6 事故）
//   ③ HTML 里引用的相对资源必须存在；快照里出现的 `portraits/xx.webp` 必须在 portraits/ 下
import fs from 'node:fs';
import path from 'node:path';
import { rel, emit, parseArgs, exists, walk } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));

const problems = [];
const notes = [];

const skillsRoot = path.join(repo, 'components', 'skills');
if (exists(skillsRoot)) {
  for (const id of fs.readdirSync(skillsRoot).sort()) {
    const dir = path.join(skillsRoot, id);
    const mf = path.join(dir, 'skill.json');
    if (!exists(mf)) continue;
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const schema = m.configSchema || {};
    for (const [key, def] of Object.entries(schema)) {
      if (!def || def.type !== 'action' || !def.panel) continue;
      const panelPath = path.join(dir, def.panel);
      if (!exists(panelPath)) {
        problems.push({ file: rel(repo, mf), kind: 'panel-missing', detail: `configSchema.${key}.panel → ${def.panel} 不存在` });
        continue;
      }
      notes.push(`panel ok: ${id} → ${def.panel}`);
      // ②/③ 只对 HTML 面板做
      if (!/\.html?$/i.test(panelPath)) continue;
      const dirOfPanel = path.dirname(panelPath);
      const html = fs.readFileSync(panelPath, 'utf8');
      for (const m2 of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const ref = m2[1];
        if (/^(https?:|data:|#|\/)/.test(ref)) continue;
        const [file, query] = ref.split('?');
        const abs = path.join(dirOfPanel, file);
        if (!exists(abs)) {
          problems.push({ file: rel(repo, panelPath), kind: 'asset-missing', detail: `引用 ${ref} 不存在` });
        }
        if (/\.(css|js)$/i.test(file) && !query) {
          problems.push({ file: rel(repo, panelPath), kind: 'no-cache-buster', detail: `${ref} 没带 ?v= 版本号（改了会看不到效果）` });
        }
      }
      // ③ portraits 引用
      const portraitsDir = path.join(dirOfPanel, 'portraits');
      if (exists(portraitsDir)) {
        const have = new Set(fs.readdirSync(portraitsDir));
        const jsFiles = walk(dirOfPanel, (p) => /\.(js|mjs)$/.test(p));
        for (const jf of jsFiles) {
          const js = fs.readFileSync(jf, 'utf8');
          for (const m3 of js.matchAll(/portraits\/([\w.-]+\.(?:webp|png|jpg|jpeg))/g)) {
            if (!have.has(m3[1])) {
              problems.push({ file: rel(repo, jf), kind: 'portrait-missing', detail: `引用了 portraits/${m3[1]} 但文件不存在` });
            }
          }
        }
      }
    }
  }
}

const result = {
  name: 'panel',
  ok: problems.length === 0,
  problems,
  notes: notes.slice(0, 20),
  message: problems.length ? `${problems.length} 个面板问题` : `面板契约通过（${notes.length} 个入口）`
};
if (args.json) emit(result);
else {
  console.log(`${result.ok ? '✅' : '❌'} ${result.message}`);
  for (const p of problems.slice(0, 20)) console.log(`   ${p.file} [${p.kind}] ${p.detail}`);
}
process.exit(result.ok ? 0 : 1);
