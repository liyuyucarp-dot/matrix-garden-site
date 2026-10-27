// tools/build-dist.mjs —— 生成「外发版」（给不懂 / 不能用 GitHub 的人）
//
// 它与 build-release.mjs 的区别：
//   build-release 产的是**开发者包**（带 tools/probes/fixtures/components.json，能用 node 装）
//   build-dist    产的是**傻瓜包**（双击 bat 就装；不含任何 node/CI/构建脚本）
//
// 用法：node tools/build-dist.mjs [--version 3.0.0] [--out dist]
//
// 布局：
//   矩阵庭院-外发版-vX.Y.Z/
//     一键安装.bat          双击即装（纯 ASCII + CRLF，cmd 才不会拆坏中文）
//     install.ps1           实际干活的脚本（UTF-8 BOM，PS5.1 才不乱码）
//     README.md             ← docs/外发包-README.md（小白手册）
//     更新日志-全部.md       14 个版本合成一份
//     组件介绍.md
//     LICENSE / THIRD-PARTY-NOTICES.md
//     skills/ plugins/      15 个组件
//     核心补丁/              0.4.8.x 用
//     官方0.4适配/           官方 0.4 preview 用
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, walk, sha256File, rel, exists, parseArgs } from './lib/util.mjs';
import { writeZip } from './lib/zip.mjs';

const args = parseArgs();
const repo = path.resolve(import.meta.dirname, '..');
const meta = readJson(path.join(repo, 'components.json'));
const version = String(args.version || meta.version || '0.0.0');
const stageName = `矩阵庭院-外发版-v${version}`;
const distDir = path.join(repo, args.out || 'dist');
const zipPath = path.join(distDir, `${stageName}.zip`);

const need = [
  'tools/一键安装.bat',
  'tools/install-user.ps1',
  'docs/外发包-README.md',
  'docs/更新日志-全部.md',
  'docs/组件介绍.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.md'
];
const missing = need.filter((p) => !exists(path.join(repo, p)));
if (missing.length) {
  console.error('❌ 缺文件，无法出外发版：\n   ' + missing.join('\n   '));
  process.exit(1);
}

const entries = [];
const add = (abs, name) => entries.push({ abs, name: `${stageName}/${name}` });
const addTree = (absDir, namePrefix) => {
  for (const f of walk(absDir)) add(f, `${namePrefix}/${rel(absDir, f)}`);
};

// 单文件（重命名到小白看得懂的名字）
add(path.join(repo, 'tools/一键安装.bat'), '一键安装.bat');
add(path.join(repo, 'tools/install-user.ps1'), 'install.ps1');
add(path.join(repo, 'docs/外发包-README.md'), 'README.md');
add(path.join(repo, 'docs/更新日志-全部.md'), '更新日志-全部.md');
add(path.join(repo, 'docs/组件介绍.md'), '组件介绍.md');
add(path.join(repo, 'LICENSE'), 'LICENSE');
add(path.join(repo, 'THIRD-PARTY-NOTICES.md'), 'THIRD-PARTY-NOTICES.md');

// 组件
addTree(path.join(repo, 'components', 'skills'), 'skills');
addTree(path.join(repo, 'components', 'plugins'), 'plugins');

// 两套补丁（去掉 .mjs 版补丁器和说明文档里给开发者看的那些，只留能跑的）
const addPatch = (srcDir, dstName) => {
  for (const f of walk(srcDir)) {
    const r = rel(srcDir, f);
    if (r.endsWith('.mjs')) continue;                       // node 版执行器，小白用不上
    if (/风险|迁移|手动接线/.test(r)) continue;               // 开发者说明
    add(f, `${dstName}/${r}`);
  }
};
addPatch(path.join(repo, 'patch'), '核心补丁');
addPatch(path.join(repo, 'adapter-04'), '官方0.4适配');

// 自检：不得夹带私有标识 / 绝对路径
const BAN = ['青晴雨', '小鲤鱼', '鲤鱼少女', '银囧牙', 'F:\\QingQingyuAgent'];
const leaks = [];
for (const e of entries) {
  if (!/\.(js|mjs|json|md|ps1|bat|txt)$/i.test(e.abs)) continue;
  const s = fs.readFileSync(e.abs, 'utf8');
  for (const b of BAN) if (s.includes(b)) leaks.push(`${e.name} ← ${b}`);
}
if (leaks.length) {
  console.error('❌ 外发包里有不该出现的内容：\n   ' + leaks.slice(0, 10).join('\n   '));
  process.exit(1);
}

const zr = writeZip(zipPath, entries);
const sha = sha256File(zipPath);
fs.writeFileSync(path.join(distDir, `${stageName}.zip.sha256`), `${sha}  ${stageName}.zip\n`, 'utf8');
writeJson(path.join(distDir, 'release-dist.json'), {
  package: 'matrix-garden-dist',
  version,
  builtAt: new Date().toISOString(),
  file: `${stageName}.zip`,
  bytes: zr.bytes,
  entries: zr.entries,
  sha256: sha,
  components: (meta.components || []).map((c) => `${c.kind}/${c.id}@${c.version}`)
});

const mb = (zr.bytes / 1048576).toFixed(2);
console.log(`✅ 外发版：${rel(repo, zipPath)}`);
console.log(`   ${zr.entries} 条目 / ${mb} MB / UTF-8 文件名标志已置位`);
console.log(`   sha256 ${sha.slice(0, 16)}…`);
console.log(`   组件：${(meta.components || []).length} 个（skills ${(meta.components || []).filter((c) => c.kind === 'skills').length} / plugins ${(meta.components || []).filter((c) => c.kind === 'plugins').length}）`);
