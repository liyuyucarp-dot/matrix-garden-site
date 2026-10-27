// B站鲸鱼 · 只读面板
// 数据来自插件 storage（../@data/storage.json），不显示 cookie，不改任何东西。

const $ = (id) => document.getElementById(id);
const state = { db: null, which: 'public', tab: 'today', timer: null };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const dayKey = (ts) => {
  try { return new Date(Number(ts) || Date.now()).toLocaleDateString('sv-SE'); } catch { return ''; }
};
const fmtTime = (ts) => {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }); } catch { return '—'; }
};
const fmtClock = (ts) => {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return '—'; }
};
const esc = (s) => String(s ?? '');

function computeSilence(db, settings) {
  const quota = Array.isArray(db?.quota) ? db.quota : [];
  const firstShare = quota.find((x) => x.share);
  const base = Number(db?.feedback?.last) || Number(firstShare?.at) || 0;
  const days = base ? Math.floor((Date.now() - base) / 86400000) : 0;
  const after = Math.max(1, Number(settings?.silentAfterDays) || 3);
  const stopAt = Math.max(after + 1, Number(settings?.silentStopDays) || 7);
  const baseCap = Math.max(0, Number(settings?.shareDaily) || 0);
  let cap;
  if (days < after) cap = baseCap;
  else if (days >= stopAt) cap = 0;
  else cap = Math.max(1, Math.floor((baseCap * (stopAt - days)) / (stopAt - after)));
  return { days, cap, base, firstShare };
}

function todayQuota(db) {
  const today = dayKey(Date.now());
  const list = Array.isArray(db?.quota) ? db.quota : [];
  return list.filter((x) => dayKey(x.at) === today);
}

function card(label, value, note, tone = '') {
  const box = el('div', `card ${tone}`.trim());
  box.appendChild(el('div', 'label', label));
  const v = el('div', 'value', value);
  if (String(value).length > 12) v.classList.add('small');
  box.appendChild(v);
  if (note) box.appendChild(el('div', 'note', note));
  return box;
}

function renderCards() {
  const db = state.db || {};
  const settings = db.meta?.settings || {};
  const qToday = todayQuota(db);
  const shares = qToday.filter((x) => x.share).length;
  const sil = computeSilence(db, settings);
  const cap = Math.min(Number(settings.shareDaily) || 0, sil.cap);
  const plan = db.plan;
  const wakes = Number(db.counters?.wakes) || 0;
  const login = db.stats?.login;
  const drafts = Array.isArray(db.drafts) ? db.drafts.filter((d) => d.status === 'pending').length : 0;
  const cards = $('cards');
  cards.replaceChildren();

  cards.appendChild(card(
    '状态',
    settings.enabled ? '运行中' : '未启用',
    settings.dryRun ? '演练模式（不对外发）' : (settings.cookieSet ? 'cookie 已配置' : '还没有 cookie'),
    settings.enabled ? 'good' : 'warn'
  ));
  cards.appendChild(card(
    '登录',
    login?.ok ? (login.uname || '已登录') : '未登录',
    login?.ok ? `mid ${login.mid}` : (login?.reason || '还没检查'),
    login?.ok ? 'cyan' : 'bad'
  ));
  cards.appendChild(card(
    '今天醒来',
    `${wakes} 次`,
    plan?.action === 'wake' ? `下一次 ${plan.atText || ''}` : plan?.action === 'skip' ? '这次不想看' : (plan?.reason || '等待计划'),
    'cyan'
  ));
  cards.appendChild(card(
    '分享额度',
    `${shares} / ${Math.max(0, cap)}`,
    `基础 ${settings.shareDaily || 0}/天 · 阈值 ${settings.shareMinScore || 0}/20`,
    shares >= cap && cap > 0 ? 'warn' : ''
  ));
  cards.appendChild(card(
    '沉默',
    `${sil.days} 天`,
    sil.cap === 0 ? '已停止分享（日记照写）' : `当前上限 ${sil.cap}`,
    sil.days >= (Number(settings.silentAfterDays) || 3) ? 'warn' : 'good'
  ));
  cards.appendChild(card(
    '待审',
    `${drafts} 条`,
    drafts ? '在 QQ 里 /鲸鱼 待审' : '没有陌生人的草稿',
    drafts ? 'warn' : ''
  ));
  const persona = db.meta?.personaCatalog?.current;
  cards.appendChild(card(
    '人设',
    persona?.name || '未解析',
    persona?.source ? `${persona.source}${persona.warning ? ' · 有回退' : ''}` : '去「人设卡」页选',
    persona?.name ? 'cyan' : 'warn'
  ));
}

function renderPlan() {
  const db = state.db || {};
  const settings = db.meta?.settings || {};
  const p = db.plan;
  const box = $('plan');
  box.replaceChildren();
  if (!p) { box.appendChild(el('div', 'empty', '还没有生成今天的计划。启用后最多一分钟内会排一次。')); return; }
  const rows = [
    ['日期', p.date || '—'],
    ['动作', p.action === 'wake' ? '醒来看视频' : p.action === 'skip' ? '这次不看' : p.action === 'done' ? '今天到此为止' : (p.action || '—')],
    ['时间', p.atText || (p.endAt ? `窗口末 ${Math.floor(p.endAt / 60)}:${String(p.endAt % 60).padStart(2, '0')}` : '—')],
    ['窗口', p.window || '—'],
    ['状态', p.fired ? (p.woke ? '已执行' : '已触发') : '等待中'],
    ['理由', p.reason || '—'],
    ['作息', settings.windows || '—']
  ];
  for (const [k, v] of rows) {
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', v));
  }
  box.className = 'kv';
}

function renderQuota() {
  const db = state.db || {};
  const settings = db.meta?.settings || {};
  const q = todayQuota(db);
  const shares = q.filter((x) => x.share).length;
  const sil = computeSilence(db, settings);
  const box = $('quota');
  box.replaceChildren();
  const rows = [
    ['今天发言', `${q.length} 条`],
    ['分享', `${shares} 条`],
    ['回复', `${q.filter((x) => x.type === 'reply').length} 条`],
    ['有效上限', `${Math.min(Number(settings.shareDaily) || 0, sil.cap)} 条`],
    ['沉默', `${sil.days} 天`],
    ['最近一次表态', sil.base ? fmtTime(sil.base) : '从来没有'],
    ['同一视频', `${settings.sameVideoDays || 7} 天内一次`]
  ];
  for (const [k, v] of rows) {
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', v));
  }
  box.className = 'kv';
  if (q.length) {
    const recent = el('div', 'events');
    recent.style.gridColumn = '1 / -1';
    for (const x of q.slice(-5).reverse()) {
      const row = el('div', 'event');
      row.appendChild(el('div', 'at', fmtClock(x.at)));
      row.appendChild(el('div', 'kind', x.share ? '分享' : x.type));
      row.appendChild(el('div', 'note', `${x.target || ''} ${x.note || ''}`));
      recent.appendChild(row);
    }
    box.appendChild(recent);
  }
}

function renderStats() {
  const db = state.db || {};
  const settings = db.meta?.settings || {};
  const box = $('stats');
  box.replaceChildren();
  const rows = [
    ['主人', settings.ownerQQ?.length ? settings.ownerQQ.join(', ') : '未填'],
    ['B站昵称', settings.ownerBiliName || '未填'],
    ['推送会话', settings.notifyChat || (settings.ownerQQ?.[0] ? `private:${settings.ownerQQ[0]}` : '未定')],
    ['模型', settings.llmMode || 'auto'],
    ['评论监听', settings.listenComment ? '开' : '关'],
    ['直播间', settings.liveEnabled ? `开（${settings.liveRoom || '未填房间'}）` : '关'],
    ['总醒来', `${Number(db.stats?.totalWakes) || 0} 次`],
    ['总分享', `${Number(db.stats?.totalShares) || 0} 条`],
    ['数据更新', fmtTime(db.meta?.lastSaveAt)]
  ];
  for (const [k, v] of rows) {
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', v));
  }
  box.className = 'kv';
}

function renderLastWake() {
  const db = state.db || {};
  const box = $('lastWake');
  box.replaceChildren();
  const r = db.stats?.lastWakeResult;
  if (!r) { box.appendChild(el('div', 'empty', '还没有跑过一轮。')); return; }
  const rows = [
    ['时间', fmtTime(r.at)],
    ['结果', r.ok ? '成功' : '失败'],
    ['初筛', `${r.previewed || 0} 条`],
    ['深读', `${r.deep || 0} 条`],
    ['分享', r.shared || '没有'],
    ['说明', r.reason || r.shareReason || '—']
  ];
  for (const [k, v] of rows) {
    box.appendChild(el('div', 'k', k));
    box.appendChild(el('div', 'v', v));
  }
  box.className = 'kv';
}

function renderDiary() {
  const db = state.db || {};
  const list = Array.isArray(db.diaries?.[state.which]) ? db.diaries[state.which] : [];
  const box = $('diary');
  box.replaceChildren();
  if (!list.length) {
    box.className = 'diary muted';
    box.appendChild(el('div', 'empty', state.which === 'public' ? '还没有写给主人的信。' : '还没有写给自己的日记。'));
    return;
  }
  box.className = 'diary';
  for (const entry of list.slice(-10).reverse()) {
    const wrap = el('div', 'entry');
    wrap.appendChild(el('div', 'date', `${entry.date || dayKey(entry.at)} · ${fmtClock(entry.at)}`));
    wrap.appendChild(el('div', 'text', esc(entry.text)));
    box.appendChild(wrap);
  }
}

function renderDrafts() {
  const db = state.db || {};
  const list = Array.isArray(db.drafts) ? db.drafts.filter((d) => d.status === 'pending') : [];
  const box = $('drafts');
  box.replaceChildren();
  if (!list.length) {
    box.className = 'muted';
    box.appendChild(el('div', 'empty', '没有待审草稿。陌生人的回复会先在这里等你点头。'));
    return;
  }
  box.className = '';
  for (const d of list.slice(-20).reverse()) {
    const card = el('div', 'draft');
    card.appendChild(el('div', 'who', `${d.who || '?'} · ${d.kind === 'at' ? '@ 了我' : '回复了我'}`));
    card.appendChild(el('div', 'src', esc(d.src || d.title || '（没读到正文）')));
    if (d.text) card.appendChild(el('div', 'src', `草稿：${esc(d.text)}`));
    const cmd = el('div', 'hint');
    cmd.appendChild(document.createTextNode('批准：'));
    cmd.appendChild(el('code', '', `/鲸鱼 批准 ${d.id}`));
    cmd.appendChild(document.createTextNode('　拒绝：'));
    cmd.appendChild(el('code', '', `/鲸鱼 拒绝 ${d.id}`));
    card.appendChild(cmd);
    if (d.bvid) {
      const a = el('div', 'hint', `位置：${d.bvid}`);
      card.appendChild(a);
    }
    box.appendChild(card);
  }
}

function renderEvents() {
  const db = state.db || {};
  const list = Array.isArray(db.events) ? db.events.slice().reverse() : [];
  const box = $('events');
  box.replaceChildren();
  if (!list.length) { box.appendChild(el('div', 'empty', '还没有事件。')); return; }
  for (const e of list.slice(0, 60)) {
    const row = el('div', 'event');
    row.appendChild(el('div', 'at', fmtTime(e.at)));
    row.appendChild(el('div', 'kind', e.kind || 'event'));
    row.appendChild(el('div', 'note', `${e.target ? `[${e.target}] ` : ''}${e.note || ''}`));
    box.appendChild(row);
  }
}

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${tab}`);
}

function setWhich(which) {
  state.which = which;
  for (const b of document.querySelectorAll('#diarySwitch .chip')) b.classList.toggle('active', b.dataset.which === which);
  renderDiary();
}

function renderPersona() {
  const db = state.db || {};
  const cat = db.meta?.personaCatalog || null;
  const cur = cat?.current || null;
  const currentBox = $('personaCurrent');
  currentBox.replaceChildren();
  if (!cur) {
    currentBox.className = 'kv muted';
    currentBox.appendChild(el('div', 'empty', '还没有解析人设。插件启用后最多一分钟内会读取宿主人设卡。'));
  } else {
    currentBox.className = 'kv';
    const rows = [
      ['现在用', cur.name || '未命名'],
      ['来源', cur.source || '—'],
      ['跟随会话', cur.chatKey || '—'],
      ['指定卡', cat.selected || '（留空 = 跟随宿主）'],
      ['模式', cat.source === 'host' ? '宿主人设卡' : cat.source === 'custom' ? '插件内自定义' : '中性'],
      ['机器人名', cat.botName || '—'],
      ['说明', cur.warning || '—']
    ];
    for (const [k, v] of rows) {
      currentBox.appendChild(el('div', 'k', k));
      currentBox.appendChild(el('div', 'v', v));
    }
    if (cat.errors?.length) {
      currentBox.appendChild(el('div', 'k', '读取问题'));
      currentBox.appendChild(el('div', 'v', cat.errors.join(' / ')));
    }
  }

  const box = $('personaCards');
  box.replaceChildren();
  const cards = Array.isArray(cat?.cards) ? cat.cards : [];
  if (!cards.length) {
    box.className = 'persona-list muted';
    box.appendChild(el('div', 'empty', '没有读到宿主人设卡。确认宿主设置里有人设，或改用「插件内自定义人设卡」。'));
    return;
  }
  box.className = 'persona-list';
  for (const c of cards) {
    const item = el('div', 'persona-item');
    if (cur && (c.name === cur.name || String(c.key || '') === String(cat.selected || ''))) item.classList.add('current');
    item.appendChild(el('div', 'no', `#${c.no}`));
    item.appendChild(el('div', 'name', c.name || '未命名'));
    item.appendChild(el('div', 'meta', `${c.source || ''}${c.key ? ` · id=${c.key}` : ''}`));
    box.appendChild(item);
  }
}

function renderAll() {
  renderCards();
  renderPlan();
  renderQuota();
  renderStats();
  renderLastWake();
  renderDiary();
  renderPersona();
  renderDrafts();
  renderEvents();
  $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function load() {
  try {
    const res = await fetch('../@data/storage.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    state.db = raw?.db || raw || {};
    const settings = state.db.meta?.settings;
    $('subtitle').textContent = settings?.enabled
      ? `运行中${settings.dryRun ? '（演练）' : ''} · ${settings.windows || '未设窗口'} · 分享 ${settings.shareDaily}/天`
      : '未启用 · 打开插件设置里的总开关，或先在设置里填 cookie';
    renderAll();
  } catch (error) {
    const box = $('cards');
    box.replaceChildren();
    box.appendChild(card('读取失败', '无法读取 storage', String(error?.message || error), 'bad'));
  }
}

$('refresh').addEventListener('click', load);
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
for (const b of document.querySelectorAll('#diarySwitch .chip')) b.addEventListener('click', () => setWhich(b.dataset.which));

setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }); }, 1000);
load();
state.timer = setInterval(load, 30_000);
