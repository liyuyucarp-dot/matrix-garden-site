// tools/probes/qzone-core.mjs —— 闸3c：qzone-core 的纯函数自检
// 为什么要单独一道：去重把「同一份代码」变成「一份代码被两处 import」，
// 一旦漏搬/搬错（少导出一个、参数顺序变了），语法检查看不出来，加载探针也只在
// 真正跑到那条路径时才炸。这里对能离线断言的部分逐条钉死。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit, parseArgs, exists } from '../lib/util.mjs';

const args = parseArgs();
const repo = path.resolve(args.repo || path.resolve(import.meta.dirname, '../..'));
const coreFile = path.join(repo, 'components', 'skills', 'qzone', 'lib', 'qzone-core.js');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message || e).slice(0, 200) });
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

if (!exists(coreFile)) {
  const out = { name: 'qzone-core', ok: false, problems: [{ check: 'file', detail: 'lib/qzone-core.js 不存在' }], message: '找不到 qzone-core' };
  if (args.json) emit(out); else console.log('❌ ' + out.message);
  process.exit(1);
}

const core = await import(pathToFileURL(coreFile).href);

check('导出完整', () => {
  const need = ['gtk', 'parseCookiesField', 'cookieHeader', 'finishCookies', 'sanitizeText',
    'imageKindOf', 'dataDir', 'findAppRoot', 'snowConfigCandidates', 'acquireCookies',
    'fetchCookiesViaOnebot', 'ownHttpPorts', 'readSnowHttpServices', 'rememberOnebot',
    'getOnebot', 'setOnebot', 'resetCookies', 'setLogger', 'resolveTransport',
    'UA', 'QZONE', 'QZONE_UPLOAD', 'HTTP_TIMEOUT_MS', 'COOKIE_CACHE_MS'];
  const miss = need.filter((k) => !(k in core));
  if (miss.length) throw new Error('缺导出：' + miss.join(','));
  return `${need.length} 个导出键齐全`;
});

check('gtk 纯函数', () => {
  const v = core.gtk('abc');
  // 实测返回的是**字符串**（腾讯 CGI 的 g_tk 就是拼在 query 里的十进制串）
  eq(typeof v, 'string', 'gtk 返回类型');
  eq(core.gtk(''), '5381', 'gtk("") 应为 5381（DJB 初值）');
  eq(core.gtk('abc'), core.gtk('abc'), 'gtk 应稳定');
});

check('parseCookiesField 解析', () => {
  const m = core.parseCookiesField('a=1; b=2; p_skey=xyz');
  eq(typeof m.get, 'function', '返回 Map');
  eq(m.get('a'), '1');
  eq(m.get('p_skey'), 'xyz');
  eq(core.parseCookiesField('').size, 0, '空串应为空 Map');
});

check('cookieHeader 拼装', () => {
  const m = new Map([['a', '1'], ['b', '2']]);
  const h = core.cookieHeader(m);
  if (!/a=1/.test(h) || !/b=2/.test(h)) throw new Error('拼装结果不含键值：' + h);
  return h;
});

check('finishCookies 取 uin 并算 gtk2', () => {
  const map = new Map([['pt2gguin', 'o1234567890'], ['p_skey', 'psk']]);
  const c = core.finishCookies(map, Date.now());
  eq(c.selfUin, '1234567890', 'selfUin 应去掉 o 前缀');
  eq(typeof c.gtk2, 'string', 'gtk2 应为十进制串');
});

check('sanitizeText 单行化', () => {
  const s = core.sanitizeText('a\r\nb\nc\t\td');
  if (/[\r\n\t]/.test(s)) throw new Error('仍含换行/制表符：' + JSON.stringify(s));
  return JSON.stringify(s);
});

check('imageKindOf 识别 png', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const kind = core.imageKindOf(png);
  if (!kind) throw new Error('未识别出 png');
  return String(kind);
});

check('dataDir 返回路径', () => {
  const d = core.dataDir();
  if (!d || typeof d !== 'string') throw new Error('dataDir 没有返回字符串');
  return d;
});

check('resolveTransport 结构', () => {
  const t = core.resolveTransport();
  if (!t || typeof t !== 'object' || !('source' in t) || !Array.isArray(t.cands)) {
    throw new Error('结构不符：' + JSON.stringify(t));
  }
  return 'source=' + t.source;
});

check('单例状态可注入', () => {
  const fake = { httpUrl: 'http://127.0.0.1:3999' };
  core.setOnebot(fake);
  eq(core.getOnebot(), fake, 'getOnebot 应返回注入值');
  const t = core.resolveTransport();
  if (t.source !== 'own-port') throw new Error('注入 onebot 后 source 应为 own-port，实际 ' + t.source);
  core.setOnebot(null);
  eq(core.getOnebot(), null, 'setOnebot(null) 应清空');
});

const bad = results.filter((r) => !r.ok);
const out = {
  name: 'qzone-core',
  ok: bad.length === 0,
  checks: results,
  problems: bad.map((b) => ({ check: b.name, detail: b.detail })),
  message: bad.length ? `${bad.length}/${results.length} 条自检失败` : `${results.length} 条自检全部通过`
};
if (args.json) emit(out);
else {
  console.log(`${out.ok ? '✅' : '❌'} ${out.message}`);
  for (const r of results) console.log(`   ${r.ok ? '·' : '✗'} ${r.name} ${r.detail ? '→ ' + r.detail : ''}`);
}
process.exit(out.ok ? 0 : 1);
