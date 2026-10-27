// B站鲸鱼 · 人设卡下拉选择器（只写本插件自己的 personaCard 设置）
// 名单来自插件 storage 里由主进程镜像的 meta.personaCatalog（不含角色卡正文）。

const $ = (id) => document.getElementById(id);
const state = { catalog: null, cards: [], settings: {} };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const fmtTime = (ts) => {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false }); } catch { return '—'; }
};
const valueOf = (c) => String(c?.key || c?.id || '');
const labelOf = (c) => `#${c.no} ${c.name}${c.source ? ` · ${c.source}` : ''}`;

function setStatus(text, tone = '') {
  const box = $('status');
  box.className = `persona-status ${tone}`.trim();
  box.textContent = text || '';
}

function render() {
  const cat = state.catalog || {};
  const cards = Array.isArray(cat.cards) ? cat.cards : [];
  const select = $('card');
  const previous = select.value;
  select.replaceChildren();

  const follow = el('option', '', '跟随宿主当前（留空）');
  follow.value = '';
  select.appendChild(follow);

  const seen = new Set(['']);
  for (const c of cards) {
    const value = valueOf(c);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const opt = el('option', '', labelOf(c));
    opt.value = value;
    select.appendChild(opt);
  }

  // 设置里可能是旧值 / 手动写过的名字，不在名单里也要显示出来，不能静默丢掉。
  const selected = String(cat.selected || '');
  if (selected && !seen.has(selected)) {
    const opt = el('option', '', `当前设置：${selected}（不在名单里）`);
    opt.value = selected;
    select.appendChild(opt);
  }

  select.value = selected || (seen.has(previous) ? previous : '');
  if (!select.value && previous) select.value = previous;

  const cur = cat.current || null;
  const currentBox = $('current');
  currentBox.replaceChildren();
  if (!cur) {
    currentBox.className = 'kv muted';
    currentBox.appendChild(el('div', 'empty', '还没有解析当前人设。插件加载后最多一分钟会刷新；也可以点右上角「刷新名单」。'));
  } else {
    currentBox.className = 'kv';
    const rows = [
      ['现在用', cur.name || '未命名'],
      ['来源', cur.source || '—'],
      ['跟随会话', cur.chatKey || '—'],
      ['说明', cur.warning || '—'],
      ['角色卡数', `${cards.length} 张`],
      ['名单更新', fmtTime(cat.at)]
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

  $('subtitle').textContent = cur?.name
    ? `当前：${cur.name}${cur.source ? `（${cur.source}）` : ''}`
    : 'B站鲸鱼写日记、分享评论、回复时用哪张卡说话';

  updateSelectedText();
}

function updateSelectedText() {
  const select = $('card');
  const value = select.value;
  const card = state.cards.find((c) => valueOf(c) === value);
  const box = $('selected');
  if (!value) {
    box.textContent = '未指定 → 跟随宿主当前会话/全局人设。';
  } else if (card) {
    box.textContent = `已选择：${card.name}（${card.source || '宿主人设'}）`;
  } else {
    box.textContent = `已选择：${value}`;
  }
}

async function load() {
  setStatus('读取人设卡名单…', 'busy');
  try {
    const res = await fetch('../@data/storage.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const db = raw?.db || raw || {};
    state.catalog = db.meta?.personaCatalog || null;
    state.cards = Array.isArray(state.catalog?.cards) ? state.catalog.cards : [];
    state.settings = db.meta?.settings || {};
    $('personaExtra').value = state.settings.personaExtra || '';
    $('personaText').value = state.settings.personaText || '';
    render();
    $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    if (!state.cards.length) {
      setStatus('还没有读到宿主人设卡。确认宿主里有人设；插件加载后最多一分钟刷新。', 'bad');
    } else {
      setStatus('名单已加载。选好后点「保存选择」。', '');
    }
  } catch (error) {
    setStatus(`读取名单失败：${String(error?.message || error)}`, 'bad');
  }
}

async function save() {
  const select = $('card');
  const value = select.value;
  const card = state.cards.find((c) => valueOf(c) === value);
  const extra = $('personaExtra').value.replace(/\r\n?/g, '\n').trim();
  const text = $('personaText').value.replace(/\r\n?/g, '\n').trim();
  setStatus('保存中…', 'busy');
  try {
    const res = await fetch('/api/skills/bili-whale', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          personaSource: 'host',
          personaCard: value,
          personaExtra: extra,
          personaText: text
        }
      })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const why = data?.error || `HTTP ${res.status}`;
      throw new Error(why);
    }
    state.settings = { ...(state.settings || {}), personaExtra: extra, personaText: text };
    if (state.catalog) state.catalog.selected = value;
    if (state.catalog?.current) {
      state.catalog.current = {
        ...state.catalog.current,
        name: value ? (card?.name || value) : '跟随宿主当前',
        source: value ? (card?.source || '宿主人设') : '跟随宿主当前',
        warning: ''
      };
    }
    render();
    setStatus(value
      ? `已保存：${card?.name || value}${extra ? '，附加规则已更新' : ''}${text ? '，自定义卡正文已更新' : ''}。下一句起生效。`
      : `已保存：跟随宿主当前${extra ? '，附加规则已更新' : ''}${text ? '，自定义卡正文已更新' : ''}。下一句起生效。`, 'ok');
  } catch (error) {
    setStatus(`保存失败：${String(error?.message || error)}\n可以直接在 QQ 里发 /鲸鱼 人设 <序号或名字> 切换。`, 'bad');
  }
}

$('save').addEventListener('click', save);
$('refresh').addEventListener('click', load);
$('card').addEventListener('change', updateSelectedText);
load();
