// tools/probes/statebus.mjs —— 闸4d：状态原语自检（StateStore / Heartbeat / RateLimiter）
//
// 为什么单独一道：这三个东西**错了不会报错，只会悄悄丢数据或悄悄不说话**。
//   · store：并发读-改-写丢更新、非原子写、缓存读到旧值
//   · clock：注销不干净（泄漏）、单任务抛错拖死全部
//   · limit：额度算错（该拦不拦 / 该说不说）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const dir = path.join(repo, 'components', 'plugins', 'courtyard-bus');
const problems = [];
const log = [];

function ok(cond, name, detail = '') {
  if (!cond) problems.push({ check: name, detail });
}

if (!exists(path.join(dir, 'store.js'))) {
  problems.push({ check: 'files', detail: '缺 store.js' });
} else {
  const { createStore } = await import(pathToFileURL(path.join(dir, 'store.js')).href);
  const { createClock } = await import(pathToFileURL(path.join(dir, 'clock.js')).href);
  const { createLimiter } = await import(pathToFileURL(path.join(dir, 'limiter.js')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-state-'));

  // ① 并发 update 不丢更新（20 个并发 +1 必须得到 20）
  {
    const st = createStore({ debounceMs: 0, log: (m) => log.push(m) });
    const file = path.join(tmp, 'counter.json');
    fs.writeFileSync(file, JSON.stringify({ n: 0 }), 'utf8');
    await Promise.all(Array.from({ length: 20 }, () => st.update(file, (d) => ({ n: (Number(d?.n) || 0) + 1 }))));
    await st.flush(file);
    const got = JSON.parse(fs.readFileSync(file, 'utf8')).n;
    ok(got === 20, 'store.concurrent', `并发 20 次 +1 得到 ${got}`);
  }

  // ② append 原子 + 不丢行
  {
    const st = createStore({ debounceMs: 0 });
    const file = path.join(tmp, 'lines.jsonl');
    for (let i = 0; i < 50; i += 1) await st.append(file, { i });
    await st.flush(file);
    const n = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    ok(n === 50, 'store.append', `写 50 行读到 ${n} 行`);
  }

  // ③ 只留一个 tmp（不残留垃圾）
  {
    const st = createStore({ debounceMs: 0 });
    const file = path.join(tmp, 'atomic.json');
    await st.update(file, () => ({ a: 1 }), { immediate: true });
    const junk = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));
    ok(junk.length === 0, 'store.atomic-tmp', `残留 tmp：${junk.join(',')}`);
  }

  // ④ 外部改动能被 mtime 巡检发现（不返回旧缓存）
  {
    const st = createStore({ debounceMs: 0, recheckMs: 0 });
    const file = path.join(tmp, 'ext.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1 }), 'utf8');
    ok(st.read(file).v === 1, 'store.read#1');
    fs.writeFileSync(file, JSON.stringify({ v: 2 }), 'utf8');
    ok(st.read(file).v === 2, 'store.external-change', `外部改动后读到 v=${st.read(file).v}`);
  }

  // ⑤ clock：按周期触发；注销后不再触发；任务抛错不能拖死别的任务
  {
    const clock = createClock({ tickMs: 20 });
    let a = 0;
    let b = 0;
    clock.every('t/a', 20, () => { a += 1; }, { jitter: 0, runOnStart: true });
    clock.every('t/b', 20, () => { b += 1; throw new Error('boom'); }, { jitter: 0, runOnStart: true });
    await new Promise((r) => setTimeout(r, 140));
    clock.cancel('t/a');
    const aAtCancel = a;
    await new Promise((r) => setTimeout(r, 100));
    ok(a >= 3, 'clock.runs', `a 触发 ${a} 次`);
    ok(a === aAtCancel, 'clock.cancel', `注销后还在跑：${aAtCancel} → ${a}`);
    ok(b >= 3, 'clock.isolation', `坏任务应自己失败但不影响别人：b=${b}`);
    clock.dispose();
  }

  // ⑥ limiter：超额拒绝；reset 后恢复；回应用户不占主动桶
  {
    const rl = createLimiter({ rules: { global: { cap: 3, refillMs: 60000 }, perChat: { cap: 2, refillMs: 60000 }, proactive: { cap: 99, refillMs: 60000 } } });
    const r1 = rl.take({ chatKey: 'g:1' });
    const r2 = rl.take({ chatKey: 'g:1' });
    const r3 = rl.take({ chatKey: 'g:1' });
    ok(r1.allowed && r2.allowed && !r3.allowed, 'limit.perChat', `前 2 次应放行、第 3 次应拦：${[r1, r2, r3].map((x) => x.allowed).join(',')}`);
    ok(typeof r3.reason === 'string' && r3.reason.length > 0, 'limit.reason', '拒绝时必须给原因');
    rl.reset();
    ok(rl.take({ chatKey: 'g:1' }).allowed, 'limit.reset', 'reset 后应恢复额度');
    const rp = createLimiter({ rules: { proactive: { cap: 1, refillMs: 60000 } } });
    ok(rp.take({ chatKey: 'p:1', proactive: true }).allowed, 'limit.pro#1');
    ok(!rp.take({ chatKey: 'p:1', proactive: true }).allowed, 'limit.pro#2');
    ok(rp.take({ chatKey: 'p:1' }).allowed, 'limit.reply-not-counted', '回应用户不应被主动桶拦');
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  // ⑦ 接线检查：courtyard-bus 装载后必须把 infra 挂到 globalThis
  //    —— 各组件的 everyTimer() 就是靠这个全局句柄拿时钟的（跨模块实例唯一）。
  {
    const busDir = path.join(repo, 'components', 'plugins', 'courtyard-bus', 'index.js');
    const mod = await import(pathToFileURL(busDir).href);
    const noop = () => () => {};
    mod.setup({
      id: 'courtyard-bus', manifest: {}, config: () => ({}),
      registerTool: () => 't', capability: () => undefined, hasCapability: () => false,
      isSkillActive: () => true, log: () => {}, warn: () => {}, error: () => {},
      services: () => ({}), onServices: noop, storage: { get: () => null, set: () => true },
      events: { on: noop, emit: () => {} }, personas: {}
    });
    const infra = globalThis.__courtyardInfra;
    ok(!!infra?.clock && typeof infra.clock.every === 'function', 'wiring.clock',
      '组件拿不到 globalThis.__courtyardInfra.clock —— everyTimer 会永远走本地降级');
    ok(!!infra?.limiter && typeof infra.limiter.take === 'function', 'wiring.limiter',
      '组件拿不到 globalThis.__courtyardInfra.limiter —— 主动限流不会生效');
    ok(!!infra?.store && typeof infra.store.update === 'function', 'wiring.store',
      '组件拿不到 globalThis.__courtyardInfra.store');
    try { await mod.dispose(); } catch { /* ignore */ }
  }

  // ⑧ P5 的 readText / writeText（存档级读写：读走 mtime 缓存、写必须原子）
  {
    const st2 = createStore({ debounceMs: 0 });
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-text-'));
    const f = path.join(t2, 'state.json');
    st2.writeText(f, JSON.stringify({ a: 1 }));
    ok(JSON.parse(st2.readText(f)).a === 1, 'store.text-roundtrip', '写后读不回原值');
    const hits0 = st2.stats().textHits;
    st2.readText(f); st2.readText(f);
    ok(st2.stats().textHits > hits0, 'store.text-cache', '连续读没有命中缓存（等于没省 IO）');
    fs.writeFileSync(f, JSON.stringify({ a: 2 }), 'utf8');   // 模拟外部/其它路径改了文件
    ok(JSON.parse(st2.readText(f)).a === 2, 'store.text-external', '外部改动后读到旧缓存 —— 存档会被旧值覆盖');
    ok(fs.readdirSync(t2).filter((x) => x.endsWith('.tmp')).length === 0, 'store.text-atomic', 'writeText 残留 tmp');
    fs.rmSync(t2, { recursive: true, force: true });
  }

  // ⑨ P6 契约：travel-whale 的后台播报必须走"限流版"入口（sayP / sayImageP）
  {
    const bc = path.join(repo, 'components', 'skills', 'travel-whale', 'core', 'broadcast.js');
    if (!exists(bc)) {
      problems.push({ check: 'p6.broadcast', detail: '缺 core/broadcast.js' });
    } else {
      const src = fs.readFileSync(bc, 'utf8');
      ok(/export async function sayP\b/.test(src), 'p6.sayP', '缺 sayP —— 后台播报没接限流');
      ok(/export async function sayImageP\b/.test(src), 'p6.sayImageP', '缺 sayImageP');
      ok(/proactiveGate\(/.test(src), 'p6.gate', 'say/sayImage 里没有 proactiveGate 调用');
      // 后台 4 个文件不许再出现裸 say( —— 否则就有绕过限流的漏口
      const bg = ['ticker.js', 'postcards-settle.js', 'side-trips.js', 'companions-voice.js'];
      for (const f of bg) {
        const p = path.join(repo, 'components', 'skills', 'travel-whale', 'core', f);
        if (!exists(p)) continue;
        const t = fs.readFileSync(p, 'utf8');
        const bare = (t.match(/(?<![\w.])say\(/g) || []).length;
        ok(bare === 0, `p6.${f}`, `${f} 里还有 ${bare} 处裸 say( —— 这条路径绕过了主动限流`);
      }
    }
  }
}

const okAll = problems.length === 0;
const out = {
  name: 'statebus', ok: okAll, problems,
  message: okAll ? '状态原语自检通过（并发不丢更新 / 原子追加 / 无残留 tmp / 外部改动可见 / 定时器可注销且隔离 / 限流额度正确）'
    : `状态原语自检失败：${problems.map((p) => `${p.check}: ${p.detail}`).join('；').slice(0, 220)}`
};
if (args.json) emit(out);
else {
  console.log(`${okAll ? '✅' : '❌'} ${out.message}`);
  for (const p of problems) console.log(`   · ${p.check} ${p.detail}`);
  if (args.verbose && log.length) console.log('   store 日志:', log.slice(0, 5).join(' | '));
}
process.exit(okAll ? 0 : 1);
