// 庭院体检（courtyard-doctor）：跨组件只读诊断面板。02.md 5.3 落地 + 本机特化项。
//
// 纪律（写在最前，改代码前先读）：
//   · **只读**：只读 config / 数据文件 / 进程内能力探针，外加一次本地 `ffmpeg -version`。
//     不联网、不写任何文件 —— 体检本身绝不能成为新的故障源。
//   · **不泄密**：凭据只报"已配置/长度"，任何 Key / SESSDATA 的值一律不进输出。
//   · 拿不准就报"未检测"，不猜。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, DATA_DIR } from '../../src/config.js';

let api = null;
const log = (...a) => { try { api?.log?.(...a); } catch { /* ignore */ } };

const OK = '✓';
const WARN = '⚠';
const NOTE = '·';

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

/** resources/app 根（本文件在 skills/courtyard-doctor/ 下，往上两级）。 */
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 某个组件是否真的装在这台机器上（按目录判断，不看配置）。 */
const installed = (kind, id) => {
  try { return fs.existsSync(path.join(APP_ROOT, kind, id)); } catch { return false; }
};

function fmtShort(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtClock(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${fmtShort(ts).slice(5)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dayKeyOf(now) {
  const d = new Date(Number(now) || Date.now());
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地探一次 ffmpeg（只看版本串，2 秒上限；失败=未检测到）。 */
function probeFfmpeg() {
  return new Promise((resolve) => {
    try {
      execFile('ffmpeg', ['-version'], { timeout: 2000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve('');
        const m = String(stdout || '').match(/ffmpeg version (\S+)/);
        resolve(m ? m[1] : 'unknown');
      });
    } catch { resolve(''); }
  });
}

/** 生成体检报告（幂等、只读）。 */
async function buildReport() {
  const cfg = getConfig() || {};
  const skills = cfg.skills || {};
  const trusted = Array.isArray(cfg.trustedPlugins) ? cfg.trustedPlugins : [];
  const now = Date.now();
  const today = dayKeyOf(now);
  const lines = [];
  const warns = [];
  const push = (lv, name, detail) => {
    lines.push(`${lv} ${name}：${detail}`);
    if (lv === WARN) warns.push(name);
  };

  // ── 一、组件开关与存档 ──────────────────────────────────────────────
  const tw = skills['travel-whale'] || {};
  const home = String(tw.homeChatKey || '').trim();
  const twState = home
    ? readJson(path.join(DATA_DIR, 'skills', 'travel-whale', 'chats', `${home.replace(/[^a-z0-9_]/gi, '_')}.json`))
    : null;
  if (!home) {
    push(WARN, 'travel-whale', '未配置 homeChatKey（家）—— 明信片/日记配图都不知道寄给谁');
  } else if (!twState) {
    push(WARN, 'travel-whale', `家=${home}，但家会话存档读不到（检查 data/skills/travel-whale/chats/）`);
  } else {
    const t = twState.trip || {};
    const away = Number(t.departAt) > 0 && Number(t.returnAt) > 0 && now >= Number(t.departAt) && now <= Number(t.returnAt);
    push(OK, 'travel-whale',
      `家=${home}｜${away ? `旅途中（${[t.country, t.city].filter(Boolean).join('·') || '目的地未知'}）` : '在庭院'}｜相册 ${Array.isArray(twState.album) ? twState.album.length : 0} 张`);
  }

  const qzCfg = skills['qqzone'] || {};
  const qzSt = readJson(path.join(DATA_DIR, 'qqzone', 'state.json'));
  {
    const bits = [];
    bits.push(qzCfg.diaryAuto === false ? '自动日记关' : `自动日记开（${qzCfg.diaryAtHour ?? 23}:${String(qzCfg.diaryAtMinute ?? 0).padStart(2, '0')}+抖动）`);
    const lastDiary = Array.isArray(qzSt?.diaries) && qzSt.diaries.length ? Number(qzSt.diaries[qzSt.diaries.length - 1]) : 0;
    if (lastDiary > 0) {
      const fresh = now - lastDiary <= 36 * 3600_000;
      bits.push(`最近一篇 ${fmtClock(lastDiary)}${fresh ? '' : '（超过一天没写了 ⚠）'}`);
      if (!fresh) push(WARN, 'qqzone', bits.join('｜'));
      else if (qzSt.riskDay === today) push(WARN, 'qqzone', bits.join('｜') + `｜⚠ 风控锁生效中（${qzSt.riskReason || '原因未记录'}）`);
      else push(OK, 'qqzone', bits.join('｜'));
    } else {
      push(WARN, 'qqzone', bits.join('｜') + '｜还没有写过日记');
    }
  }

  const qzoneSt = readJson(path.join(DATA_DIR, 'qzone', 'state.json'));
  if (qzoneSt && qzoneSt.riskDay === today) {
    push(WARN, 'qzone', `风控锁生效中（${qzoneSt.riskReason || '原因未记录'}）—— 轮询已停，明天自动恢复`);
  } else {
    push(OK, 'qzone', qzoneSt ? `正常轮询（上次 ${qzoneSt.lastPollAt ? fmtClock(qzoneSt.lastPollAt) : '记录缺失'}）` : '状态文件尚未创建（还没轮询过）');
  }

  const sm = skills['sleep-mood'] || {};
  const moodOk = !!readJson(path.join(DATA_DIR, 'mood.json'));
  push(sm.enabled === false ? WARN : OK, 'sleep-mood',
    `${sm.enabled === false ? '已停用' : '运行中'}｜${moodOk ? 'mood.json 可读' : 'mood.json 读不到 ⚠'}`);

  const spSt = readJson(path.join(DATA_DIR, 'silence-ping.json'));
  push(skills['silence-ping']?.enabled === false ? NOTE : OK, 'silence-ping',
    skills['silence-ping']?.enabled === false ? '已停用（配置显式关闭）'
      : `最近一轮 ${spSt?.lastCheckAt ? fmtClock(spSt.lastCheckAt) : '还没跑过（重启后等第一个唤醒周期）'}`);

  {
    let wishCount = null;
    try {
      const r = api?.capability?.('mind.wishes', { top: 6 });
      wishCount = Array.isArray(r) ? r.length : null;
    } catch { wishCount = null; }
    push(skills['mind-wish']?.enabled === false ? WARN : OK, 'mind-wish',
      skills['mind-wish']?.enabled === false ? '已停用'
        : wishCount === null ? '已启用（念想读取走能力探针，当前未取到 —— 检查插件是否加载）'
          : `当前有效念想 ${wishCount} 条`);
  }

  const bw = skills['bili-whale'] || {};
  {
    const sdLen = String(bw.sessdata || '').length;
    push(bw.enabled === false ? WARN : OK, 'bili-whale',
      `${bw.enabled === false ? '已停用' : '启用'}｜SESSDATA ${sdLen > 0 ? `已配置（${sdLen} 字符；登录态以服务端为准，此前待实名）` : '未配置 ⚠'}`);
  }

  // ── v2.1 / v2.2 新增组件的体检项（2026-10-25 补）──────────────────────
  // 都是只读探针；**装了才查**，包外的东西不出现（同 sticker / desktop-pet 的原则）。
  if (installed('plugins', 'courtyard-bus')) {
    let desc = null;
    try { desc = api?.capability?.('courtyard.bus')?.describe?.() || null; } catch { desc = null; }
    if (!desc) {
      push(WARN, 'courtyard-bus', '插件在，但取不到总线（未加载 / 未启用）');
    } else {
      const wired = (desc.topics || []).filter((t) => t.subscribers > 0);
      const subs = wired.map((t) => `${t.topic}×${t.subscribers}`).join('、') || '暂无订阅者';
      // 这条是"事件到底通没通"的唯一实证：订阅者数为 0 = 词表接了一半（发布方有、没人听）
      push(wired.length ? OK : NOTE, 'courtyard-bus',
        `已发布 ${desc.published} / 投递 ${desc.delivered}｜订阅：${subs}`);
    }
  }

  if (installed('plugins', 'autobiography')) {
    const ab = skills['autobiography'] || {};
    const nodes = readJson(path.join(DATA_DIR, 'autobiography', 'nodes.json'));
    const list = Array.isArray(nodes) ? nodes : [];
    const last = list[list.length - 1];
    const kbFile = path.join(DATA_DIR, 'knowledge-base', 'learned', '她的回忆.md');
    const kbOk = fs.existsSync(kbFile);
    if (ab.enabled === false) {
      push(WARN, 'autobiography', '已停用（不会再生新回忆）');
    } else {
      push(kbOk ? OK : NOTE, 'autobiography',
        `${list.length} 条台账｜最近 ${last?.date || '无'}｜沉淀文件 ${kbOk ? '已生成' : '还没生成（等下一次睡前触发）'}`);
    }
  }

  if (installed('plugins', 'knowledge-base')) {
    const kb = skills['knowledge-base'] || {};
    let learned = 0;
    let idx = null;
    try { learned = fs.readdirSync(path.join(DATA_DIR, 'knowledge-base', 'learned')).filter((f) => f.endsWith('.md')).length; } catch { /* 没目录就是 0 */ }
    idx = readJson(path.join(DATA_DIR, 'knowledge-base', '.index.json'));
    const idxAt = Number(idx?.builtAt) || 0;
    push(kb.enabled === false ? WARN : OK, 'knowledge-base',
      `${kb.enabled === false ? '已停用' : '启用'}｜learned ${learned} 篇｜索引 ${idxAt ? `${fmtClock(idxAt)}（${Number(idx?.sections) || 0} 段）` : '尚未建立'}｜注入 ${kb.injectMode || 'index'}`);
  }

  if (installed('plugins', 'learning-loop')) {
    const ll = skills['learning-loop'] || {};
    push(ll.enabled === false ? NOTE : OK, 'learning-loop',
      ll.enabled === false ? '已停用' : '启用（检索无命中时攒候选，达标写知识库）');
  }

  if (installed('skills', 'courtyard-map')) {
    const panelOk = fs.existsSync(path.join(APP_ROOT, 'skills', 'courtyard-map', 'panel', 'map.html'));
    push(panelOk ? OK : WARN, 'courtyard-map',
      panelOk ? '面板在位（对 travel-whale 只读）' : '面板文件缺失（panel/map.html 找不到）');
  }

  // ★ v2.2.1：sticker / desktop-pet **不是本包的组件**。旧版无条件 push，
  //   新用户装完第一次体检就看到「⚠ sticker / ⚠ desktop-pet 不在 trustedPlugins」，
  //   两条全是假警报（那人根本没装桌面宠物）。改成「装了才查」。
  if (installed('plugins', 'sticker')) {
    const stickers = readJson(path.join(DATA_DIR, 'stickers.json'));
    const n = Array.isArray(stickers) ? stickers.length : 0;
    push(skills['sticker']?.enabled === false ? WARN : OK, 'sticker',
      `${skills['sticker']?.enabled === false ? '已停用' : '启用'}｜表情库 ${n} 张｜档位 ${skills['sticker']?.encourage ?? 3}`);
  }

  if (installed('plugins', 'desktop-pet')) {
    push(trusted.includes('desktop-pet') ? NOTE : WARN, 'desktop-pet',
      trusted.includes('desktop-pet')
        ? `已装（UI 兼容问题修复中，属已知状态）${skills['desktop-pet']?.enabled === false ? '｜配置已关' : ''}`
        : '不在 trustedPlugins —— 桌宠文件不会被加载');
  }

  push(OK, 'courtyard-doctor', '体检工具自身正常（只读模式）');

  // ── 二、配置一致性（家 / 主人）──────────────────────────────────────
  const consist = [];
  if (home) {
    const homeId = home.split(':')[1] || '';
    const tg = String(sm.travelGroups || '').split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean);
    consist.push(`${homeId && tg.includes(homeId) ? OK : WARN} 家(${homeId}) ${tg.includes(homeId) ? '在' : '不在'} sleep-mood.travelGroups [${tg.join('/') || '空'}]`);
  }
  {
    const owners = [
      ['sleep-mood.ownerQq', sm.ownerQq],
      ['bili-whale.ownerQQ', bw.ownerQQ],
      ['owner-identity.ids', (skills['owner-identity'] || {}).ids]
    ].filter(([, v]) => String(v || '').trim());
    const uniq = [...new Set(owners.map(([, v]) => String(v).trim()))];
    consist.push(uniq.length <= 1
      ? `${OK} 主人 QQ 一致：${uniq[0] || '（未配置任何一处 ⚠）'}`
      : `${WARN} 主人 QQ 不一致：${owners.map(([k, v]) => `${k}=${v}`).join('、')}`);
    if (!owners.length) consist[consist.length - 1] = `${WARN} 主人 QQ 一处都没配（ownerQq / ownerQQ / owner-identity）`;
  }

  // ── 三、核心补丁 ────────────────────────────────────────────────────
  const patches = [];
  patches.push(`${typeof api?.onServices === 'function' ? OK : WARN} api.onServices ${typeof api?.onServices === 'function' ? '就绪' : '缺失（后台技能发不出消息）'}`);
  try {
    const rr = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'reply-rescue.js'), 'utf8');
    patches.push(`${/tool_call|tool_use/.test(rr) ? OK : WARN} reply-rescue 工具残骸拦截 ${/tool_call|tool_use/.test(rr) ? '已含' : '未检出（检查补丁）'}`);
  } catch {
    patches.push(`${NOTE} reply-rescue 源码读不到（不判定）`);
  }
  patches.push(`${NOTE} autoEndAfterSend=${cfg.api?.autoEndAfterSend !== false ? '开（纯发送批自动收尾）' : '关（每轮跑满或模型自收尾）'}`);

  // ── 四、可信权限 ────────────────────────────────────────────────────
  // ★ v2.2.1：可信权限检查改成「**装了才查** + 覆盖本包真正 import fs 的组件」。
  //   旧版写死 5 个：其中 sticker / desktop-pet 本包不含（→ 新用户必报两条假警告），
  //   而 sleep-mood / autobiography / knowledge-base / learning-loop / life-system /
  //   silence-ping / courtyard-map / travel-whale / qqzone / qzone 这些真会读文件、
  //   被宿主「能力闸」拦的组件一个都没查（→ 真出问题时报告反而是绿的）。
  //   判据用目录存在性，所以对"只装了其中几个"的机器也准确。
  const TRUST_CANDIDATES = [
    ['plugins', 'mind-wish'], ['plugins', 'bili-whale'], ['plugins', 'sleep-mood'],
    ['plugins', 'silence-ping'], ['plugins', 'life-system'], ['plugins', 'autobiography'],
    ['plugins', 'knowledge-base'], ['plugins', 'learning-loop'],
    ['plugins', 'sticker'], ['plugins', 'desktop-pet'],        // 宿主自带，装了就查
    ['skills', 'courtyard-doctor'], ['skills', 'courtyard-map'],
    ['skills', 'travel-whale'], ['skills', 'qqzone'], ['skills', 'qzone']
  ];
  const needTrust = TRUST_CANDIDATES
    .filter(([kind, id]) => installed(kind, id))
    .map(([, id]) => id);
  const missingTrust = needTrust.filter((x) => !trusted.includes(x));
  const trustLine = missingTrust.length
    ? `${WARN} trustedPlugins 缺：${missingTrust.join('、')}（这些组件要读写本地文件，缺了会被宿主能力闸拦下 —— 打开 config.json 把它们加进 trustedPlugins）`
    : `${OK} trustedPlugins 覆盖完整（已装 ${needTrust.length} 个需文件权限的组件，全在列）`;

  // ── 五、禁言链路 ────────────────────────────────────────────────────
  let banWired = false;
  try { banWired = api?.capability?.('chat.ban-state', { action: 'check' }) != null; } catch { banWired = false; }
  const banLine = `${banWired ? OK : WARN} 禁言链路（ban-state）${banWired ? '已接线' : '未接线（检查插件加载）'}`;

  // ── 六、环境与凭据（存在性，不联网）─────────────────────────────────
  const env = [];
  const ff = await probeFfmpeg();
  env.push(`${ff ? OK : WARN} ffmpeg ${ff ? ff : 'PATH 里找不到（看视频/听觉/抽帧依赖它）'}`);
  const ig = skills['image-generate'] || {};
  const hasIgKey = Object.entries(ig).some(([k, v]) => /key/i.test(k) && String(v || '').trim().length > 8);
  env.push(`${hasIgKey ? OK : NOTE} 绘图凭据 ${hasIgKey ? '已配置（配额不体检，控制台看）' : '未配置/未启用'}`);
  env.push(`${NOTE} Qzone 登录态运行时获取，以「最近一篇日记」那行为准`);

  const okCount = lines.filter((l) => l.startsWith(OK)).length;
  const head = `【庭院体检 · ${fmtClock(now)}】${lines.length} 个组件：${okCount} 正常 / ${warns.length} 注意`;
  const body = [
    '── 组件 ──', ...lines,
    '── 配置一致性 ──', ...consist,
    '── 核心补丁 ──', ...patches,
    '── 可信权限 ──', trustLine,
    '── 禁言链路 ──', banLine,
    '── 环境与凭据 ──', ...env
  ].join('\n');
  const tail = warns.length
    ? `总结：${warns.length} 项需要注意 —— ${warns.join('、')}。`
    : '总结：全部正常。';
  return `${head}\n${body}\n${tail}`;
}

export function setup(a) {
  api = a;
  a.registerTool({
    id: 'courtyard_checkup',
    name: '庭院体检',
    description: '一键体检矩阵庭院各组件：核心补丁、家/主人配置一致性、可信权限、禁言链路、风控锁、凭据存在性、最近日记。只读、不联网，随时可调。用户说「庭院体检 / 给庭院做个体检」时调用，把报告转述给用户：先说总结，再逐条讲 ⚠ 项；别加自己的猜测。',
    category: 'query',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        return { content: await buildReport() };
      } catch (e) {
        return { content: `体检跑挂了（${e?.message ?? e}）—— 体检本身只读，不影响任何组件`, isError: true };
      }
    }
  });
  log('庭院体检已加载（只读诊断；对机器人说「庭院体检」出报告）');
}

export function activate() { }
export function deactivate() { }

export function promptSections() {
  return [{
    id: 'courtyard-doctor-usage',
    title: '庭院体检',
    priority: 63,
    content: '主人说「庭院体检」「给庭院做个体检」「检查一下庭院」时，调用 courtyard-doctor__courtyard_checkup，'
      + '然后把报告转述给他：先说总结（几项正常、几项注意），再逐条讲 ⚠ 的项；全绿就一句话带过。'
      + '报告里 ⚠ 是"需要注意"、· 是"仅说明"。不要替报告里的项目猜原因。'
  }];
}
