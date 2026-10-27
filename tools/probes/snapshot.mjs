// tools/probes/snapshot.mjs —— 闸 4：快照生成探针（防 v2.2.7「快照一跑就崩」）
// 用法：node tools/probes/snapshot.mjs --repo <repo> --json
//
// 为什么必须有这一道：
//   v2.2.6 → v2.2.7 的 `portraitExists is not defined` 是**运行期** ReferenceError：
//   `node --check` 看不见、加载探针也不触发（它在 publishNow → buildSnapshot 里）。
//   结果：包发出去，用户面板整页空白。这道闸就是"用夹具存档真跑一次快照并断言产物"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, readJson, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-snap-'));
// 还原宿主布局（skills/ 与 src/ 是兄弟目录），否则组件的 ../../src/* 解析不到
const appDir = path.join(tmp, 'app');
fs.cpSync(path.join(repo, 'components', 'skills'), path.join(appDir, 'skills'), { recursive: true });
fs.cpSync(path.join(repo, 'components', 'plugins'), path.join(appDir, 'plugins'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'fixtures', 'host-src'), path.join(appDir, 'src'), { recursive: true });
const dataDir = path.join(tmp, 'data');
const CHAT_KEY = 'group:000000000';                 // 虚构群号，仅用于拼路径
fs.mkdirSync(path.join(dataDir, 'skills', 'travel-whale', 'chats'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  trustedPlugins: ['courtyard-map', 'travel-whale'],
  skills: {
    'travel-whale': { enabled: true, homeChatKey: CHAT_KEY },
    'courtyard-map': { enabled: true }
  }
}, null, 2), 'utf8');
fs.copyFileSync(
  path.join(repo, 'tools', 'fixtures', 'state-courtyard.json'),
  path.join(dataDir, 'skills', 'travel-whale', 'chats', CHAT_KEY.replace(/[^a-z0-9_]/gi, '_') + '.json')
);
process.env.QQ_AGENT_DATA_DIR = dataDir;

const cmDir = path.join(appDir, 'skills', 'courtyard-map');
const problems = [];
const info = {};

function makeApi() {
  const storageFile = path.join(dataDir, 'plugin-data', 'courtyard-map', 'storage.json');
  const readAll = () => { try { return JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch { return {}; } };
  const writeAll = (o) => { fs.mkdirSync(path.dirname(storageFile), { recursive: true }); fs.writeFileSync(storageFile, JSON.stringify(o, null, 2), 'utf8'); };
  return {
    id: 'courtyard-map',
    config: () => ({ enabled: true }),
    registerTool: (d) => d?.id,
    capability: () => undefined,
    hasCapability: () => false,
    isSkillActive: () => true,
    log: () => {}, warn: () => {}, error: () => {},
    fetch: () => Promise.reject(new Error('probe')),
    utils: { sleep: async () => {} },
    services: () => null,
    onServices: () => () => {},
    storage: {
      get: (k, d = null) => { const a = readAll(); return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : d; },
      set: (k, v) => { const a = readAll(); a[k] = v ?? null; writeAll(a); return true; },
      remove: (k) => { const a = readAll(); delete a[k]; writeAll(a); return true; }
    }
  };
}

let mod = null;
try {
  mod = await import(pathToFileURL(path.join(cmDir, 'index.js')).href);
} catch (e) {
  problems.push({ check: 'import', detail: String(e?.message || e).slice(0, 300) });
}

if (mod) {
  // ── A) 纯函数：buildSnapshot 用夹具存档 ──────────────────────────────
  if (typeof mod.buildSnapshot !== 'function') {
    problems.push({ check: 'buildSnapshot', detail: '未导出 buildSnapshot（探针无法验证快照结构）' });
  } else {
    const fixture = readJson(path.join(repo, 'tools', 'fixtures', 'state-courtyard.json'));
    let snap = null;
    try {
      snap = mod.buildSnapshot(fixture, Date.now(), { extras: true });
    } catch (e) {
      problems.push({ check: 'buildSnapshot', detail: '抛错: ' + String(e?.message || e).slice(0, 300) });
    }
    if (snap) {
      const comps = Array.isArray(snap.companions) ? snap.companions : [];
      info.companionCount = comps.length;
      if (comps.length !== 7) problems.push({ check: 'companions.length', detail: `期望 7，实际 ${comps.length}` });
      const portraitDir = path.join(cmDir, 'panel', 'portraits');
      let withPortrait = 0;
      for (const c of comps) {
        if (typeof c.portrait !== 'string') problems.push({ check: 'portrait.type', detail: `${c.id}: portrait 不是字符串（${typeof c.portrait}）` });
        if (c.portrait) {
          withPortrait += 1;
          // 快照给的是「相对 panel/ 的路径」（面板用 <img src> 直接取），所以要在 panel/ 下找
          if (!exists(path.join(cmDir, 'panel', c.portrait))) {
            problems.push({ check: 'portrait.file', detail: `${c.id}: 快照给的是 ${c.portrait}，panel/ 下不存在` });
          }
        }
        if (!Array.isArray(c.skills) || c.skills.length === 0) problems.push({ check: 'skills', detail: `${c.id}: 技能列表为空` });
        else if (typeof c.skills[0].needWorlds !== 'number') problems.push({ check: 'skills.needWorlds', detail: `${c.id}: needWorlds 不是数字` });
        if (typeof c.tripsFiction !== 'number') problems.push({ check: 'tripsFiction', detail: `${c.id}: tripsFiction 不是数字` });
        if (!Array.isArray(c.footprint)) problems.push({ check: 'footprint', detail: `${c.id}: footprint 不是数组` });
        if (!c.lore || !c.lore.origin) problems.push({ check: 'lore', detail: `${c.id}: 缺少 lore.origin` });
      }
      info.portraitCount = withPortrait;
      if (withPortrait === 0 && exists(portraitDir)) {
        problems.push({ check: 'portrait.none', detail: '一个立绘都没解析出来（portraits/ 存在却没命中）' });
      }
      info.snapshotKB = Math.round(JSON.stringify(snap).length / 1024);
    }
  }

  // ── B) 完整路径：setup + publishNow → 断言 storage.json 真的落盘 ──────
  const api = makeApi();
  try {
    if (typeof mod.setup === 'function') await mod.setup(api);
    if (typeof mod.publishNow !== 'function') {
      problems.push({ check: 'publishNow', detail: '未导出 publishNow' });
    } else {
      mod.publishNow();
      const storeFile = path.join(dataDir, 'plugin-data', 'courtyard-map', 'storage.json');
      if (!exists(storeFile)) {
        problems.push({ check: 'storage', detail: 'publishNow 没写出 plugin-data/courtyard-map/storage.json（api.storage 缺失或早退）' });
      } else {
        const j = readJson(storeFile);
        const view = j.view || {};
        info.storageKeys = Object.keys(j);
        if (view.error) info.storageError = String(view.error).slice(0, 120);
        const n = Array.isArray(view.companions) ? view.companions.length : -1;
        info.storageCompanions = n;
        if (n !== 7) problems.push({ check: 'storage.companions', detail: `storage.json 里 companions 期望 7，实际 ${n}` });
      }
    }
  } catch (e) {
    problems.push({ check: 'publishNow', detail: '抛错: ' + String(e?.message || e).slice(0, 300) });
  }
}

const result = {
  name: 'snapshot',
  ok: problems.length === 0,
  problems,
  info,
  message: problems.length ? `${problems.length} 个快照问题` : `快照探针通过（${info.companionCount} 位旅伴 / ${info.portraitCount} 张立绘 / storage ${info.storageKB ?? '-'}）`
};
if (args.json) emit(result);
else {
  console.log(`${result.ok ? '✅' : '❌'} ${result.message}`);
  for (const p of problems.slice(0, 20)) console.log(`   [${p.check}] ${p.detail}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
