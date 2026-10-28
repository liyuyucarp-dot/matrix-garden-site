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
