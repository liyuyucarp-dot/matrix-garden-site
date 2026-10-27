// 矩阵庭院 · 控制台设置面板（自动化）
//
// 契约（见 ui/app/06-settings-render.js）：render(ctx) → HTML，bind(root, ctx) → 卸载函数。
//   · 默认值从 skill.json 取（/plugin-assets/travel-whale/skill.json）
//   · 用户改过的值在 ctx.pluginConfig() 里（= config.skills['travel-whale']）
//   · 保存一律走 ctx.save({key: value})（浅合并，后端 deepMerge）
//
// ⚠️ 这里只做两组设置：「明信片题词用哪个模型」（2026-10-21 新增）与「自动化」开关。
//    其它设置（群号、白名单、生图 key）仍在原来的地方，
//    不搬过来 —— 搬了就会出现"两处都能改同一件事"，迟早对不上。
//    ⚠️ `homeChatKey` / `cardTargets` 的 UI **刻意不在这里**（它们在通用设置页按
//    configSchema 渲染），别为了"顺手"把它们搬过来。

const FIELDS = [
  { key: 'autoHarvest', t: 'bool', l: '出发 / 归来自动收 TOKEN', d: '她出门前和到家后，顺手把服务器里攒下的 TOKEN 收进钱包（收不到就静默跳过）。' },
  { key: 'autoSpend', t: 'bool', l: '让她自己在家花钱', d: '回家后、钱够时，她自己看清单决定买什么：设施、口粮、护身符、装备、服装。' },
  { key: 'autoTend', t: 'bool', l: '自理（收菜 / 补种 / 补口粮）', d: '在家时自己收熟了的菜、空地上补种一株、口粮少于两趟的量就自己买。不碰送礼。' },
  { key: 'autoTendGapMin', t: 'num', l: '自理检查间隔（分钟）', d: '默认 30。太勤会反复读写存档，没必要。' },
  { key: 'autoInvite', t: 'bool', l: '自己邀旅伴', d: '没有同行者、钱够、且隔够久时，她自己请一位上路（由那位本人应声）。' },
  { key: 'autoInviteGapHours', t: 'num', l: '两次邀约至少隔几小时', d: '默认 72。她请过的旅伴会一直在，所以这个只是防“刚散伙又请”。' },
  { key: 'autoSpendWeeklyCap', t: 'num', l: '每周自主消费上限（亿）', d: '0 = 不限。按自然周（周一 0 点）归零；超了就攒着，直到下周。' },
  { key: 'autoSpendMin', t: 'num', l: '多大金额才谈花钱（亿）', d: '余额低于这个数就不做决策，省一次模型调用。默认 150。' },
  { key: 'autoSpendKeep', t: 'num', l: '至少留多少（亿）', d: '买完钱包的绝对下限。默认 200。' },
  { key: 'autoSpendKeepPct', t: 'num', l: '至少留多少（% 余额）', d: '和上面取较大值。默认 20 —— 防止一次把存款花到只剩几十亿。' },
  { key: 'autoSpendMax', t: 'num', l: '一次最多买几件', d: '默认 2，最多 3。' },
  { key: 'autoSpendGapHours', t: 'num', l: '两次决策至少隔几小时', d: '默认 3。tick 是分钟级的，没有这道闸会每轮都问模型。' }
];

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ── ★★ 2026-10-21 新增：明信片题词可单独选模型（`skills.travel-whale.captionModel`）──
//
// 范围（用户明确划定）：**只有明信片的 `caption`（题词）与 `thought`（感想）** 用这个模型，
// 画风提示词与出图模型都不换。留空 = 跟随主模型（默认，行为与从前完全一致）。
//
// ⚠️ 选项来自**宿主的 `config.providers`**（context 里的 `ctx.config()`，已脱敏但保留
//    `models` / `modelNames`）—— 不另开接口、也不读 apiKey（这里根本用不到）。
// ⚠️ 保存时存的是**模型 id 字符串**，空串表示"跟随主模型"。

/** 把 `config.providers` 摊平成 [{ id, name, models:[{id,name}] }]（脏数据一律跳过）。 */
function providerModelList(ctx) {
  let cfg = null;
  try { cfg = (typeof ctx.config === 'function') ? ctx.config() : null; } catch { cfg = null; }
  const list = (cfg && Array.isArray(cfg.providers)) ? cfg.providers : [];
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const names = (p.modelNames && typeof p.modelNames === 'object') ? p.modelNames : {};
    const raw = Array.isArray(p.models) ? p.models : (p.model ? [p.model] : []);
    const models = [];
    const seen = new Set();
    for (const m of raw) {
      const id = String((m && typeof m === 'object') ? (m.id || m.model || '') : (m ?? '')).trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const label = String((m && typeof m === 'object' && m.name) ? m.name : (names[id] || id));
      models.push({ id, name: label });
    }
    if (!models.length) continue;
    out.push({ id: String(p.id || ''), name: String(p.name || p.label || p.id || '（未命名提供商）'), models });
  }
  return out;
}

/** 题词模型的 `<select>`（第一项固定是"跟随主模型（默认）"，值为空串）。 */
function captionSelectHtml(cur, providers) {
  const value = String(cur == null ? '' : cur).trim();
  const known = new Set();
  let html = '<option value=""' + (value === '' ? ' selected' : '') + '>跟随主模型（默认）</option>';
  for (const p of providers) {
    const opts = p.models.map((m) => {
      known.add(m.id);
      return '<option value="' + esc(m.id) + '"' + (m.id === value ? ' selected' : '') + '>'
        + esc(m.name) + '</option>';
    }).join('');
    if (opts) html += '<optgroup label="' + esc(p.name) + '">' + opts + '</optgroup>';
  }
  // ⚠️ 配置里留着一个"当前提供商列表里已经没有"的模型名（换过提供商 / 手改过配置）⇒
  //    也必须列出来。否则下拉会显示成"跟随主模型"，用户一保存就把它**静默清空**了。
  if (value && !known.has(value)) {
    html += '<option value="' + esc(value) + '" selected>' + esc(value) + '（不在当前模型列表里）</option>';
  }
  return '<select class="tw-sel" id="tw-captionModel" data-tw="captionModel" data-tw-type="model">' + html + '</select>';
}

async function loadSpend() {
  try {
    const d = await fetch('/travel-dashboard.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    return d && Array.isArray(d.log) ? d : null;
  } catch { return null; }
}

function spendHtml(d) {
  if (!d || !d.log || !d.log.length) {
    return '<div class="tw-foot" style="margin-top:18px">🧾 还没有自主消费记录 —— 她花过钱之后这里会列出来。</div>';
  }
  const rows = d.log.slice(-6).reverse().map((e) => {
    const when = new Date(Number(e.at) || Date.now());
    const hm = (when.getMonth() + 1) + '/' + when.getDate() + ' '
      + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
    const what = (e.items || []).map((x) => x.name + ' ' + x.price + '亿').join('、');
    return '<div class="tw-row" style="padding:8px 0"><div style="font-size:12.5px">' + esc(what) + '</div>'
      + '<div class="tw-desc" style="margin-left:0">' + esc(hm) + '　共 ' + (Number(e.total) || 0) + ' 亿</div></div>';
  }).join('');
  const wk = d.week ? ('本周已花 ' + (Number(d.week.spent) || 0) + ' 亿') : '';
  return '<div style="margin-top:18px"><b style="font-size:14px">🧾 最近花了什么</b>'
    + '<div class="tw-desc" style="margin-left:0">' + esc(wk) + (wk ? '　·　' : '') + '余额 ' + (Number(d.balance) || 0) + ' 亿</div>'
    + rows + '</div>';
}

async function loadValues(ctx) {
  let defaults = {};
  try {
    const m = await fetch('/plugin-assets/travel-whale/skill.json', { cache: 'no-store' }).then((r) => r.json());
    if (m && m.settings && typeof m.settings === 'object') defaults = m.settings;
  } catch { /* 拿不到就用空默认 */ }
  const stored = (typeof ctx.pluginConfig === 'function' ? ctx.pluginConfig() : null) || {};
  return { ...defaults, ...stored };
}

export async function render(ctx) {
  const v = await loadValues(ctx);
  const providers = providerModelList(ctx);
  const rows = FIELDS.map((f) => {
    const id = 'tw-' + f.key;
    const val = v[f.key];
    if (f.t === 'bool') {
      return '<div class="tw-row"><label class="tw-lab" for="' + id + '">'
        + '<input type="checkbox" id="' + id + '" data-tw="' + esc(f.key) + '" data-tw-type="bool"' + (val !== false ? ' checked' : '')
        + '> <b>' + esc(f.l) + '</b></label>'
        + '<div class="tw-desc">' + esc(f.d) + '</div></div>';
    }
    return '<div class="tw-row"><label class="tw-lab" for="' + id + '"><b>' + esc(f.l) + '</b></label>'
      + '<div class="tw-desc">' + esc(f.d) + '</div>'
      + '<input class="tw-num" type="number" min="0" step="1" id="' + id + '" data-tw="' + esc(f.key) + '" data-tw-type="num" value="'
      + esc(val == null ? '' : val) + '"></div>';
  }).join('');

  // ★ 2026-10-21：明信片题词模型 —— 单独一段，别混进"她自己管钱"那一组里
  //   （那一组是自动化开关，这一条是"文案用哪个模型"，两件事）。
  const captionBlock = '<h3 style="margin:0 0 6px">明信片 · 题词用哪个模型</h3>'
    + '<div class="tw-lead">明信片的<b>题词</b>和<b>感想</b>是模型现写的两段短文案。'
    + '这里可以把它们交给另一个模型（例如主模型用便宜的、题词用好文笔的）。'
    + '<br>⚠️ <b>只影响题词与感想，不影响出图</b> —— 画风提示词和生图模型一个字都不换。'
    + '<br>留空 = 跟随主模型（默认，与从前完全一样）。</div>'
    + '<div class="tw-row tw-row-plain">'
    + '<div class="tw-desc" style="margin-left:0">题词 / 感想</div>'
    + captionSelectHtml(v.captionModel, providers) + '</div>'
    + (providers.length ? '' : '<div class="tw-foot">⚠️ 没有读到任何提供商模型（宿主配置里 `providers` 是空的）'
      + '—— 先去「设置 → API」配一个提供商，这里才有选项。</div>');

  return '<style>'
    + '.tw-wrap{max-width:760px}'
    + '.tw-lead{color:#8a8f98;font-size:12.5px;line-height:1.7;margin:2px 0 14px}'
    + '.tw-row{border-bottom:1px solid rgba(128,128,128,.18);padding:12px 0 14px}'
    + '.tw-row-plain{padding-top:8px}'
    + '.tw-lab{display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer}'
    + '.tw-desc{color:#8a8f98;font-size:12px;line-height:1.7;margin:5px 0 0 24px}'
    + '.tw-num{width:120px;margin:8px 0 0 24px;padding:5px 8px;border:1px solid rgba(128,128,128,.35);'
    + 'border-radius:6px;background:transparent;color:inherit;font-size:13px}'
    + '.tw-sel{width:100%;max-width:420px;margin:8px 0 0 0;padding:6px 8px;border:1px solid rgba(128,128,128,.35);'
    + 'border-radius:6px;background:transparent;color:inherit;font-size:13px}'
    + '.tw-foot{margin-top:16px;font-size:12.5px;color:#8a8f98;line-height:1.8}'
    + '.tw-flash{color:#3f9d6b;font-weight:600;margin-left:8px;opacity:0;transition:opacity .2s}'
    + '.tw-flash.on{opacity:1}'
    + '</style>'
    + '<div class="tw-wrap">'
    + captionBlock
    + '<h3 style="margin:24px 0 6px">自动化 · 她自己管钱</h3>'
    + '<div class="tw-lead">这两件事都是"不用主人交代"的：她自己收钱、自己决定买什么。'
    + '关掉任意一项，对应行为立即停止。</div>'
    + rows
    + + spendHtml(await loadSpend())
    + '<div class="tw-foot">改动即刻写入配置；若发现没生效，在设置页点一次重新扫描（或重启宿主）。<span class="tw-flash" id="tw-flash">已保存</span>'
    + '<br>⚠️ 自主花钱只在<b>她在家、且是白天</b>时发生；夜里买完没法播报，会留到下次白天。'
    + '<br>⚠️ 想让她少花：把「至少留多少」调高，或把「多大金额才谈花钱」调高。</div>'
    + '</div>';
}

export function bind(root, ctx) {
  const flash = root.querySelector('#tw-flash');
  let timer = 0;
  const showFlash = () => {
    if (!flash) return;
    flash.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => flash.classList.remove('on'), 1400);
  };

  const onChange = async (ev) => {
    const el = ev.target.closest('[data-tw]');
    if (!el) return;
    const key = el.getAttribute('data-tw');
    const type = el.getAttribute('data-tw-type');
    let value;
    if (type === 'bool') {
      value = el.checked === true;
    } else if (type === 'model') {
      // ★ 2026-10-21：题词模型 —— 存**模型 id 字符串**，空串 = 跟随主模型
      value = String(el.value == null ? '' : el.value).trim();
    } else {
      const n = Number(el.value);
      value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
      el.value = String(value);
    }
    try {
      await ctx.save({ [key]: value });
      showFlash();
    } catch (e) {
      console.error('[travel-whale] 保存设置失败', e);
      if (flash) { flash.textContent = '保存失败'; flash.classList.add('on'); }
    }
  };

  root.addEventListener('change', onChange);
  return () => {
    clearTimeout(timer);
    root.removeEventListener('change', onChange);
  };
}
