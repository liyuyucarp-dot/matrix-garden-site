// tools/probes/load.mjs —— 闸 3：加载探针
// 用法：node tools/probes/load.mjs --repo <repo> [--shape 048|04preview] --json
//
// 做法（为什么不直接用真宿主）：
//   · 组件 `import '../../src/*.js'` 依赖宿主，仓库里没有 → 先**搭一个桩宿主**（tools/fixtures/host-src）
//   · 只调 `setup(mockApi)`，**不调 activate()** —— activate 会起定时器/联网，探针要能干净退出
//   · 目标：抓「加载即崩」这一类（模块链接错误、setup 里访问 undefined、缺 import）
//     ⚠️ 抓不到运行期才走到的路径（v2.2.7 的 portraitExists 属于这类）→ 由 snapshot 探针补
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, readJson, exists, rel } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const shape = String(args.shape || '048');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-load-'));
// ⚠️ 必须还原**宿主布局**：`<app>/skills/<id>` 与 `<app>/src/*` 是**兄弟目录**，
//    组件的 `import '../../src/config.js'` 才能解析。仓库里多一层 `components/`，
//    所以这里不能直接拷 components 过去（首版就栽在这：解析成 components/src/config.js）。
const appDir = path.join(tmp, 'app');
const dataDir = path.join(tmp, 'data');
fs.cpSync(path.join(repo, 'components', 'skills'), path.join(appDir, 'skills'), { recursive: true });
fs.cpSync(path.join(repo, 'components', 'plugins'), path.join(appDir, 'plugins'), { recursive: true });
fs.cpSync(path.join(repo, 'tools', 'fixtures', 'host-src'), path.join(appDir, 'src'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = dataDir;

const meta = readJson(path.join(repo, 'components.json'));
const ids = (meta.components || []).filter((c) => !args.filter || c.id === args.filter);

// 让所有组件在探针里「开启」，否则 setup 会 early-return，探不到真实代码
const cfg = { trustedPlugins: ids.map((c) => c.id), skills: {}, plugins: {}, allowAllWhenEmpty: true };
for (const c of ids) {
  const mf = path.join(repo, c.path, c.kind === 'skills' ? 'skill.json' : 'plugin.json');
  const m = exists(mf) ? readJson(mf) : {};
  const sec = { ...(m.settings || {}), enabled: true };
  if (c.kind === 'skills') cfg.skills[c.id] = sec; else cfg.plugins[c.id] = sec;
}
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

function makeApi(id, manifest) {
  // ⚠️ 三个数组必须先初始化：日志桩自己抛错会把"组件加载失败"变成假阳性
  const bag = { logs: [], warns: [], errors: [] };
  const storageFile = path.join(dataDir, 'plugin-data', id, 'storage.json');
  const readAll = () => { try { return JSON.parse(fs.readFileSync(storageFile, 'utf8')); } catch { return {}; } };
  const writeAll = (o) => {
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    fs.writeFileSync(storageFile, JSON.stringify(o, null, 2), 'utf8');
  };
  const api = {
    id,
    manifest,
    config: () => ((manifest.settings || {})),
    registerTool: (def) => def?.id || 'probe-tool',
    registerProvider: () => {},
    capability: () => undefined,
    hasCapability: () => false,
    isSkillActive: () => true,
    log: (...a) => bag.logs.push(a.map(String).join(' ')),
    warn: (...a) => bag.warns.push(a.map(String).join(' ')),
    error: (...a) => bag.errors.push(a.map(String).join(' ')),
    fetch: () => Promise.reject(new Error('probe: 不联网')),
    utils: { sleep: async () => {}, safeJsonParse: (t, f = null) => { try { return JSON.parse(t); } catch { return f; } } },
    services: () => null,
    onServices: () => () => {},
    storage: {
      get: (k, d = null) => { const all = readAll(); return Object.prototype.hasOwnProperty.call(all, k) ? all[k] : d; },
      set: (k, v) => { const all = readAll(); all[k] = v ?? null; writeAll(all); return true; },
      remove: (k) => { const all = readAll(); const had = Object.prototype.hasOwnProperty.call(all, k); delete all[k]; writeAll(all); return had; }
    },
    events: { on: () => () => {}, emit: () => {}, off: () => {} },
    personas: {},
    _probe: bag
  };
  // 官方 0.4 preview 没有 storage / onebot / services —— 用它跑一遍，验证「降级也要能加载」
  if (shape === '04preview') {
    delete api.storage;
    delete api.services;
    delete api.onServices;
  } else {
    Object.defineProperty(api, 'onebot', { get: () => null, configurable: true });
  }
  return api;
}

const results = [];
for (const c of ids) {
  const dir = path.join(appDir, c.kind, c.id);
  const mf = path.join(dir, c.kind === 'skills' ? 'skill.json' : 'plugin.json');
  const manifest = exists(mf) ? readJson(mf) : {};
  const entry = manifest.entry || 'index.js';
  const entryPath = path.join(dir, entry);
  const rec = { id: c.id, kind: c.kind, version: manifest.version, importOk: false, setupOk: false, error: null };
  if (!exists(entryPath)) {
    rec.error = `入口不存在: ${entry}`;
    results.push(rec);
    continue;
  }
  try {
    const mod = await import(pathToFileURL(entryPath).href);
    rec.importOk = true;
    if (typeof mod.setup === 'function') {
      const api = makeApi(c.id, manifest);
      await mod.setup(api);
      rec.setupOk = true;
      // setup 里如果吞了异常会打进 api.error —— 那也算失败线索
      if (api._probe.errors.length) {
        rec.setupOk = false;
        rec.error = 'setup 内部报错: ' + api._probe.errors.slice(0, 2).join(' | ').slice(0, 300);
      }
      if (typeof mod.available === 'function') {
        try { rec.available = mod.available(); } catch (e) { rec.available = { ok: false, reason: String(e?.message || e) }; }
      }
    } else {
      rec.setupOk = true;   // 没有 setup 的组件（纯工具型）也算通过
    }
  } catch (e) {
    rec.error = String(e?.message || e).slice(0, 300);
    rec.stack = String(e?.stack || '').split('\n').slice(1, 4).join(' | ').slice(0, 400);
  }
  results.push(rec);
}

const bad = results.filter((r) => !r.importOk || !r.setupOk);
const result = {
  name: 'load',
  shape,
  ok: bad.length === 0,
  total: results.length,
  failures: bad,
  passed: results.filter((r) => r.importOk && r.setupOk).map((r) => r.id),
  tmp: rel(repo, tmp) || tmp,
  message: bad.length ? `${bad.length}/${results.length} 个组件加载失败` : `${results.length} 个组件全部加载成功（shape=${shape}）`
};
if (args.json) emit(result);
else {
  console.log(`${result.ok ? '✅' : '❌'} ${result.message}`);
  for (const b of bad) console.log(`   ${b.id} → ${b.error}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
