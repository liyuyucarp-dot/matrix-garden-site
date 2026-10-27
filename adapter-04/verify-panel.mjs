// 面板路由验收：启动官方 0.4 的 app（headless），用真实 HTTP 打面板 / assets / skills 三路。
// 用法： node verify-panel.mjs "<0.4 源码根>"
// 前置：该树里要有 node_modules（ws / js-yaml 等）；数据目录会被指到系统临时目录，不碰真实 data\。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(process.argv[2] || '.');
if (!fs.existsSync(path.join(APP, 'src', 'app.js'))) {
  console.error('✗ 这个目录不像 QQ Agent 0.4 的源码根（缺 src/app.js）:', APP);
  process.exit(2);
}
const DATA = path.join(os.tmpdir(), 'qq04-panel-verify-' + Date.now());
fs.mkdirSync(DATA, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = DATA;

const quiet = [];
const realLog = console.log;
console.log = (...a) => quiet.push(a.map(String).join(' '));

const { createApp } = await import(`file:///${path.join(APP, 'src', 'app.js').replace(/\\/g, '/')}`);
const { getConfig } = await import(`file:///${path.join(APP, 'src', 'config.js').replace(/\\/g, '/')}`);
const cfg = getConfig();
const app = createApp();
try {
  await app.start();
} catch (e) {
  console.log = realLog;
  console.error('✗ 启动失败：', e?.message);
  console.error(String(e?.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
const port = app.port || app.server?.address?.()?.port || cfg.server?.port || 3000;
console.log = realLog;
const base = `http://127.0.0.1:${port}`;

let bad = 0;
async function probe(label, url, expect) {
  try {
    const r = await fetch(base + url, { headers: { origin: base } });
    const ok = r.status === expect;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${label.padEnd(44)} ${r.status}${ok ? '' : '（期望 ' + expect + '）'}`);
    return r;
  } catch (e) {
    bad++;
    console.log(`❌ ${label.padEnd(44)} 请求失败：${e?.message}`);
    return null;
  }
}

console.log(`端口 ${port}｜数据目录 ${DATA}`);
console.log('\n== 面板静态路由（/plugin-panel/）==');
await probe('courtyard-map/panel/map.html', '/plugin-panel/courtyard-map/panel/map.html', 200);
await probe('courtyard-map/panel/map.js', '/plugin-panel/courtyard-map/panel/map.js', 200);
await probe('bili-whale/panel/index.html', '/plugin-panel/bili-whale/panel/index.html', 200);
await probe('不存在的文件', '/plugin-panel/courtyard-map/panel/nope.html', 404);

console.log('\n== plugin-assets（settingsUi 用 import() 取自己）==');
await probe('sleep-mood/plugin.json', '/plugin-assets/sleep-mood/plugin.json', 200);
await probe('sleep-mood/settings-ui.js', '/plugin-assets/sleep-mood/settings-ui.js', 200);
await probe('travel-whale/settings-ui.js', '/plugin-assets/travel-whale/settings-ui.js', 200);

console.log('\n== /api/skills 是否带 panels / settingsUi ==');
try {
  const r = await fetch(base + '/api/skills', { headers: { origin: base, 'x-console-token': 'verify' } });
  const j = await r.json();
  const sm = (j.skills || []).find((s) => s.id === 'sleep-mood');
  const cm = (j.skills || []).find((s) => s.id === 'courtyard-map');
  console.log(`   HTTP ${r.status}`);
  console.log('   sleep-mood.settingsUi =', JSON.stringify(sm?.settingsUi));
  console.log('   courtyard-map.panels  =', JSON.stringify(cm?.panels));
  if (!sm?.settingsUi || !(cm?.panels || []).length) { bad++; console.log('   ❌ 字段缺失 → 前端不会有按钮'); }
  else console.log('   ✅ 前端能拿到界面数据');
} catch (e) {
  bad++;
  console.log('   ❌ 请求失败', e?.message);
}

await app.stop();
console.log(bad ? `\n✗ 有 ${bad} 项不通过` : '\n✅ 全部通过');
process.exit(bad ? 1 : 0);
