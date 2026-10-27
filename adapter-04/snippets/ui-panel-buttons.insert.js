
/**
 * ── [[courtyard:panel]] 插件自带界面入口（官方 0.4 适配层，2026-10-25）──────────
 * 数据来自后端已校验的两个字段：
 *   · skill.panels     —— configSchema 里 type:'action' + panel 的条目（后端拼好了 url）
 *   · skill.settingsUi —— 插件自己的设置页模块（import('/plugin-assets/<id>/<file>')）
 *
 * 为什么自带一层 overlay 而不复用控制台弹层：0.4 的弹层是给"设置表单"写死的，
 * 硬塞 iframe 会和它的关闭/焦点逻辑打架。这里自成一体，坏了也只影响这一颗按钮。
 * ⚠️ 所有事件都用**委托**绑定（CSP 禁内联 onclick）。
 */
const PLUGIN_PANEL_UI = { bound: false };

function pluginPanelButtons(skill) {
  if (!skill) return '';
  const panels = Array.isArray(skill.panels) ? skill.panels : [];
  const su = skill.settingsUi;
  if (!panels.length && !su) return '';
  const btns = [];
  if (su) {
    btns.push(`<button class="btn btn-small" data-plugin-panel="settings" data-skill="${esc(skill.id)}" data-file="${esc(su.file)}" data-title="${esc(su.label || skill.name || '插件设置页')}">⚙ ${esc(su.label || '插件设置页')}</button>`);
  }
  for (const p of panels) {
    if (!p || !p.url) continue;
    btns.push(`<button class="btn btn-small" data-plugin-panel="iframe" data-skill="${esc(skill.id)}" data-url="${esc(p.url)}" data-title="${esc(p.label || p.id || '插件界面')}">${esc(p.icon || '▣')} ${esc(p.label || '打开界面')}</button>`);
  }
  if (!btns.length) return '';
  PLUGIN_PANEL_UI.bind();
  return `<div class="skill-modal__internal-head" style="margin-top:12px">插件自带界面</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${btns.join('')}</div>`;
}

PLUGIN_PANEL_UI.bind = function bind() {
  if (PLUGIN_PANEL_UI.bound) return;
  PLUGIN_PANEL_UI.bound = true;
  document.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-plugin-panel]') : null;
    if (!btn) return;
    ev.preventDefault();
    const title = btn.getAttribute('data-title') || '插件界面';
    if (btn.getAttribute('data-plugin-panel') === 'iframe') {
      pluginPanelOpenFrame(title, btn.getAttribute('data-url'));
    } else {
      pluginPanelOpenSettings(btn.getAttribute('data-skill'), btn.getAttribute('data-file'), title);
    }
  });
};

/** 建一层 overlay，返回 { box, close }。ESC / 点遮罩 / 右上角 ✕ 都能关。 */
PLUGIN_PANEL_UI.shell = function shell(title, width) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px';
  const box = document.createElement('div');
  box.style.cssText = `position:relative;width:min(${width || '1100px'},100%);height:100%;max-height:100%;background:var(--bg,#14161a);border:1px solid var(--line,#2a2f38);border-radius:12px;overflow:hidden;display:flex;flex-direction:column`;
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line,#2a2f38);font-size:13px';
  const h = document.createElement('b');
  h.textContent = title;
  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'background:none;border:0;color:inherit;font-size:15px;cursor:pointer';
  head.append(h, spacer, close);
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;overflow:auto';
  box.append(head, body);
  wrap.append(box);
  const hide = () => { try { wrap.remove(); } catch { /* ignore */ } document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') hide(); };
  close.addEventListener('click', hide);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) hide(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  return { body, hide };
};

function pluginPanelOpenFrame(title, url) {
  if (!url) return;
  const { body } = PLUGIN_PANEL_UI.shell(title, '1100px');
  const f = document.createElement('iframe');
  f.src = url;
  f.style.cssText = 'width:100%;height:100%;border:0;background:#14161a';
  body.append(f);
}

async function pluginPanelOpenSettings(skillId, file, title) {
  const { body } = PLUGIN_PANEL_UI.shell(title, '820px');
  const mount = document.createElement('div');
  mount.style.cssText = 'padding:14px';
  mount.textContent = '加载中…';
  body.append(mount);
  const skill = (state.skills || []).find((x) => x.id === skillId) || {};
  const patch = async (p) => {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ skills: { [skillId]: p } }) });
    if (typeof refreshSkills === 'function') { try { await refreshSkills(); } catch { /* ignore */ } }
  };
  const ctx = {
    pluginId: skillId,
    pluginConfig: () => (state.skills || []).find((x) => x.id === skillId)?.settings || {},
    config: (state.skills || []).find((x) => x.id === skillId)?.settings || {},
    esc,
    api: { get: (u) => api(u), post: (u, b) => api(u, { method: 'POST', body: JSON.stringify(b || {}) }) },
    save: patch,
    reload: () => pluginPanelOpenSettings(skillId, file, title)
  };
  try {
    const mod = await import(`/plugin-assets/${encodeURIComponent(skillId)}/${file}`);
    const html = await mod.render(ctx);
    mount.innerHTML = html && typeof html === 'string' ? html : '';
    if (typeof mod.bind === 'function') await mod.bind(mount, ctx);
  } catch (e) {
    mount.textContent = `这个插件的设置页加载失败：${e?.message || e}`;
  }
}
