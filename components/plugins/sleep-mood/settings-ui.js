// 集成系统 · 插件侧小面板（完整设置已搬到顶栏「集成系统」独立页）
// 这里只做三件事：① 实时状态一眼看；② 6 个最常用开关；③ 一个按钮跳到完整页面。
// 契约不变：render(ctx) / bind(root, ctx)。
//
// ★ 2.0.1 补丁（2026-10-25）：v2 已没有「生命值 / 好感联动」两个子系统，
//   旧面板仍读 dash.hp.value / dash.favor.enabled → 会显示「❤️ 生命值 0/0」，
//   看着像她血空了。这里改成直接展示 v2 真正的两条轴：元气 + 具身情境心境，
//   并把两个已废弃的开关换成元气相关项。
const BASIC = [
  { key: 'enabled', t: 'bool', l: '总开关', d: '关掉后不再观察/不推进/不注入（数值留在磁盘）' },
  { key: 'ignoreWhileSleeping', t: 'bool', l: '睡眠时底层忽略（省 token）', d: '睡着时普通消息入站就拦，零 token，醒来补看' },
  { key: 'wakeChancePercent', t: 'num', l: '可被吵醒的概率（%）', d: '默认 55；同一窗口内被吵醒越多越难醒' },
  { key: 'playAlongMaxReplies', t: 'num', l: '陪闹可回复条数', d: '心情好被吵醒时陪你玩几条，然后收尾回睡' },
  { key: 'sleepRecoverPerHour', t: 'num', l: '睡眠每小时恢复元气', d: '默认 22；清醒时元气不自然下降' },
  { key: 'vitalityLowThreshold', t: 'num', l: '微倦提示线', d: '元气低于此值时语气放软、节奏放慢（默认 45）' }
];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

async function loadView(ctx) {
  const stored = (typeof ctx.pluginConfig === 'function' ? ctx.pluginConfig() : null) || {};
  let defaults = {};
  try {
    const m = await fetch('/plugin-assets/sleep-mood/plugin.json', { cache: 'no-store' }).then((r) => r.json());
    if (m?.settings && typeof m.settings === 'object') defaults = m.settings;
  } catch { /* 忽略 */ }
  let dash = null;
  try { dash = await fetch('/mood-dashboard.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()); } catch { dash = null; }
  return { cfg: { ...defaults, ...stored }, dash };
}

function liveHtml(d) {
  if (!d) return '<div class="sm-desc">读不到实时数据（插件未启用或还没跑过心跳）</div>';
  const sys = d.systems || {}; const sl = sys.sleep || {};
  const vit = num(d.vitality, num(d?.meters?.vitality, 0));
  const tone = vit <= 20 ? 'sm-bad' : (vit <= 45 ? 'sm-warn' : 'sm-ok');
  const tags = Array.isArray(d.activeTags) ? d.activeTags : [];
  const moodText = (d.dominant && d.dominant.word) || (tags.length ? tags.map((t) => t.tag).join(' / ') : '平静');
  const where = d?.self?.what ? String(d.self.what) : '';
  return '<div class="sm-live-strip">'
    + '<span class="sm-chip ' + tone + '">⚡ 元气 <b>' + Math.round(vit) + '/100</b></span>'
    + '<span class="sm-chip">🧠 ' + esc(moodText) + (tags.length > 1 ? '（' + tags.length + ' 个活跃）' : '') + '</span>'
    + '<span class="sm-chip">😴 ' + (sl.sleeping ? (sl.kind === 'command' ? '命令睡眠' : '自然睡眠') : '醒着') + '</span>'
    + (where ? '<span class="sm-chip">📍 ' + esc(where.slice(0, 18)) + '</span>' : '')
    + '</div>';
}

export async function render(ctx) {
  const { cfg, dash } = await loadView(ctx);
  const fields = BASIC.map((f) => {
    const v = cfg[f.key];
    const id = 'sm-basic-' + f.key;
    if (f.t === 'bool') {
      return '<div class="sm-field sm-bool"><label for="' + id + '"><input type="checkbox" id="' + id + '" data-sm="' + esc(f.key) + '"' + (v === true ? ' checked' : '') + '> <b>' + esc(f.l) + '</b></label><div class="sm-desc">' + esc(f.d) + '</div></div>';
    }
    return '<div class="sm-field"><label for="' + id + '"><b>' + esc(f.l) + '</b></label><div class="sm-desc">' + esc(f.d) + '</div><input type="number" id="' + id + '" data-sm="' + esc(f.key) + '" value="' + esc(v == null ? '' : v) + '"></div>';
  }).join('');
  return '<style>'
    + '.sm-live-strip{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 12px}'
    + '.sm-chip{font-size:11.5px;padding:3px 8px;border-radius:999px;background:rgba(128,128,128,.14)}'
    + '.sm-chip.sm-ok{background:rgba(79,191,122,.20)}.sm-chip.sm-warn{background:rgba(224,164,60,.24)}.sm-chip.sm-bad{background:rgba(217,92,92,.26)}'
    + '.sm-field{margin:8px 0}.sm-field label{font-size:12.5px}'
    + '.sm-field input[type=number]{width:100%;max-width:200px;padding:5px 7px;border-radius:6px;border:1px solid var(--border,#444);background:var(--bg-2,transparent);color:inherit}'
    + '.sm-desc{color:var(--muted,#888);font-size:11.5px;line-height:1.6}'
    + '.sm-actions{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}.sm-msg{font-size:12px;color:var(--muted,#888)}'
    + '</style>'
    + '<div><h3 style="margin:0 0 4px">睡眠 · 元气 · 旅行心境</h3>'
    + '<div class="sm-desc">这里只放最常用的 6 项；<b>完整 40 项在「设置 → 插件 → sleep-mood」的齿轮弹窗里</b>。生命值与好感联动已在 v2 移除。</div>'
    + liveHtml(dash) + fields
    + '<div class="sm-actions"><button class="btn" id="sm-save" type="button">保存这几项</button>'
    + '<span class="sm-msg" id="sm-msg"></span></div></div>';
}

export function bind(root, ctx) {
  const msg = root.querySelector('#sm-msg');
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.style.color = bad ? '#d95c5c' : ''; } };
  const collect = () => {
    const patch = {};
    for (const el of root.querySelectorAll('[data-sm]')) {
      const key = el.getAttribute('data-sm');
      if (el.type === 'checkbox') patch[key] = !!el.checked;
      else patch[key] = el.value === '' ? 0 : Number(el.value);
    }
    return patch;
  };
  const onSave = async () => {
    say('保存中…');
    try {
      await ctx.api('/api/skills/sleep-mood', { method: 'POST', body: JSON.stringify({ settings: collect() }) });
      say('已保存');
      try { await ctx.reload(); } catch { /* 忽略 */ }
    } catch (e) { say('保存失败：' + (e?.message || e), true); }
  };
  // 2026-10-25：顶栏「集成系统」页已下线 —— 本面板本身就在设置页内，
  //   原来那个"跳到完整设置"的按钮已无去处，故移除，只保留保存。
  const saveBtn = root.querySelector('#sm-save');
  saveBtn?.addEventListener('click', onSave);
  return () => { saveBtn?.removeEventListener('click', onSave); };
}
