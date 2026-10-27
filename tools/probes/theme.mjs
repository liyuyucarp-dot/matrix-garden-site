// tools/probes/theme.mjs —— 闸3d：世界主题包自测（换主世界 / 任意世界晋升 / 切回零残留）
// 用法：node tools/probes/theme.mjs --repo <repo> --json
//
// 为什么单独一道：主题包会牵动「地区表 / 默认解锁 / 世界速写 / 影调 / 主地图分区」五条链路，
// 而且要跨 travel-whale 与 courtyard-map 两个组件。跑它自带的 theme-selftest 最省事也最权威。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const scriptRel = path.join('components', 'skills', 'travel-whale', 'theme-selftest.mjs');

function fail(msg, extra = {}) {
  const out = { name: 'theme', ok: false, problems: [{ check: 'theme', detail: msg }], ...extra };
  if (args.json) emit(out); else console.log('❌ ' + msg);
  process.exit(1);
}

if (!exists(path.join(repo, scriptRel))) fail('缺 theme-selftest.mjs（travel-whale 未带自测脚本）');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-theme-'));
const app = path.join(tmp, 'app');
fs.cpSync(path.join(repo, 'components', 'skills'), path.join(app, 'skills'), { recursive: true });
fs.cpSync(path.join(repo, 'components', 'plugins'), path.join(app, 'plugins'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'fixtures', 'host-src'), path.join(app, 'src'), { recursive: true });
const data = path.join(tmp, 'data');
fs.mkdirSync(data, { recursive: true });

const script = path.join(app, 'skills', 'travel-whale', 'theme-selftest.mjs');
let tail = '';
let ok = true;
let err = '';
try {
  const out = execFileSync(process.execPath, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, QQ_AGENT_DATA_DIR: data },
    encoding: 'utf8',
    timeout: 120000
  });
  tail = out.trim().split('\n').slice(-6).join('\n');
} catch (e) {
  ok = false;
  const out = ((e.stdout || '') + (e.stderr || '')).trim();
  tail = out.split('\n').slice(-10).join('\n');
  const m = out.match(/AssertionError[^\n]*: ?([^\n]*)/);
  err = m ? m[1] : (out.split('\n').slice(-2)[0] || '未知失败');
}
fs.rmSync(tmp, { recursive: true, force: true });

// ── 附加回归：**老存档 + 新主题**的键归位（2026-10-27 修的真实 bug）──
// 老存档里 trip.region 是旧 id（某异世界被晋升成基础世界后自己不再是地区）；
// 若不归位，面板会「右侧说她在外域、地图上外域却显示待启程」。
// 这里用**合成夹具**（不依赖真实存档）断言三件事：归位成功 / 旧地球区不残留 / azeroth 本体不残留。
let legacyProblems = [];
try {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-theme-legacy-'));
  const app2 = path.join(tmp2, 'app');
  fs.cpSync(path.join(repo, 'components', 'skills'), path.join(app2, 'skills'), { recursive: true });
  fs.cpSync(path.join(repo, 'tools', 'fixtures', 'host-src'), path.join(app2, 'src'), { recursive: true });
  const data2 = path.join(tmp2, 'data');
  fs.mkdirSync(data2, { recursive: true });
  // 配置：锚定 azeroth（走内置主题包，不依赖用户配置）
  fs.writeFileSync(path.join(data2, 'config.json'), JSON.stringify({
    skills: { 'travel-whale': { enabled: true, worldTheme: 'azeroth', earthInCustomTheme: 'otherworld' } }
  }), 'utf8');
  process.env.QQ_AGENT_DATA_DIR = data2;

  const tw2 = await import(pathToFileURL(path.join(app2, 'skills/travel-whale/index.js')).href);
  tw2.internals.setWorldTheme('azeroth');
  const cm2 = await import(pathToFileURL(path.join(app2, 'skills/courtyard-map/index.js')).href);

  // 老存档：trip 还写着旧 id 'azeroth'，历史访问记录里有地球九区
  const legacyState = {
    trip: { region: 'azeroth', city: '沙塔斯城', country: '外域', departAt: Date.now() - 3600e3, returnAt: Date.now() + 6 * 3600e3 },
    whale: { equipUnlocked: ['asia', 'europe', 'azeroth'] },
    visitedCities: {
      'asia|巴黎': { region: 'asia', city: '巴黎', country: '法国', count: 1, lastAt: Date.now() - 86400e3 },
      'europe|罗马': { region: 'europe', city: '罗马', country: '意大利', count: 1, lastAt: Date.now() - 172800e3 }
    },
    companions: [], companionOwned: [], garden: {}, pond: {}, wardrobe: {}, wallet: {}, souvenirs: {}, album: [], titles: {}, stats: {}
  };
  const snap = cm2.buildSnapshot(legacyState, Date.now(), { extras: true });
  const place = snap.whale?.place || {};
  if (place.regionKey !== 'azeroth_outland') legacyProblems.push({ check: 'legacy.regionKey', detail: `应归位到 azeroth_outland，实际 ${place.regionKey}` });
  const keys = Object.keys(snap.world || {});
  for (const k of ['azeroth', 'asia', 'europe']) {
    if (keys.includes(k)) legacyProblems.push({ check: 'legacy.residue', detail: `world 里仍残留旧键 ${k}` });
  }
  if (!keys.includes('earth')) legacyProblems.push({ check: 'legacy.earth', detail: '旧地球应收束成 earth（蔚蓝地球），实际没有' });
  // ★ 地球必须**可见**（用户实测过的坑：收束成 earth 后 equipUnlocked 里没有这个 id，
  //   被 visible 判定过滤掉 ⇒ 面板上"地球整张卡消失"）
  const earth = snap.world?.earth;
  if (earth && (earth.unlocked !== true || earth.visible !== true)) {
    legacyProblems.push({ check: 'legacy.earthVisible', detail: `地球应 unlocked+visible，实际 unlocked=${earth.unlocked} visible=${earth.visible}` });
  }
  const curZone = (snap.regions || []).find((r) => (r.cities || []).some((c) => c.current));
  if (!curZone || curZone.key !== 'azeroth_outland') {
    legacyProblems.push({ check: 'legacy.current', detail: `"她现在在这"应落在 azeroth_outland，实际 ${curZone ? curZone.key : '(无)'}` });
  }
  fs.rmSync(tmp2, { recursive: true, force: true });
} catch (e) {
  legacyProblems.push({ check: 'legacy.throw', detail: String(e?.message || e).slice(0, 160) });
}
if (legacyProblems.length) {
  ok = false;
  err = legacyProblems.map((p) => p.detail).join('；');
}

const groups = (tail.match(/===\s*\[(\d)\/4\]/g) || []).length;
const result = {
  name: 'theme',
  ok,
  groups,
  detail: tail,
  problems: ok ? [] : [...(err ? [{ check: 'theme-selftest', detail: err.slice(0, 200) }] : []), ...legacyProblems],
  message: ok ? '主题包自测通过（默认 / 艾泽拉斯 / 任意世界晋升 / 切回零残留）+ 老存档键归位回归通过' : `主题包自测失败：${err.slice(0, 120)}`
};
if (args.json) emit(result);
else console.log(`${ok ? '✅' : '❌'} ${result.message}`);
process.exit(ok ? 0 : 1);
