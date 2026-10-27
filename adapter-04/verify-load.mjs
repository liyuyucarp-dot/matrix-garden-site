// 在官方 0.4 的源码树上，用它**自己的** loadPlugins() 加载全部组件。
// 用法： node verify-load.mjs "<0.4 源码根>"
// 说明：数据目录会被指到系统临时目录下的 qq04-verify-data，不碰你真实的 data\。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(path.join(APP, 'src', 'plugin-loader.js'))) {
  console.error('✗ 这个目录不像 QQ Agent 0.4 的源码根（缺 src/plugin-loader.js）:', APP);
  process.exit(2);
}

const DATA = path.join(os.tmpdir(), 'qq04-verify-data-' + Date.now());
fs.mkdirSync(DATA, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = DATA;

const logs = [];
const log = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));

const loader = await import(`file:///${path.join(APP, 'src', 'plugin-loader.js').replace(/\\/g, '/')}`);
const { skillManager } = await import(`file:///${path.join(APP, 'src', 'skills', 'manager.js').replace(/\\/g, '/')}`);

try {
  await loader.loadPlugins({ log });
} catch (e) {
  console.error('✗ loadPlugins 抛错：', e?.message);
  console.error(String(e?.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}

const list = skillManager.list();
const ok = list.filter((s) => !s.loadError);
const bad = list.filter((s) => s.loadError);
const warns = logs.filter((l) => l.includes('⚠'));

console.log(`加载结果：共 ${list.length} 个组件 | 成功 ${ok.length} | 失败 ${bad.length} | 警告 ${warns.length}`);
for (const b of bad) console.log('  ❌', b?.manifest?.id || b?.id, '→', String(b.loadError?.message || b.loadError).slice(0, 110));
for (const w of warns) console.log('  ⚠ ', w.slice(0, 130));
console.log(`数据目录（临时）：${DATA}`);
process.exit(bad.length ? 1 : 0);
