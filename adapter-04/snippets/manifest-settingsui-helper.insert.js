
/**
 * [[courtyard:panel]] 插件自带设置页：`settingsUi: { id, label, file }`。
 *
 * 前端用 `import('/plugin-assets/<id>/<file>')` 取回这个模块，调它的
 * `render(ctx)` 拿 HTML、`bind(root, ctx)` 绑事件 —— 契约与 0.4.8.x 版一致。
 * 带 `..` / 绝对路径 / 盘符的一律判 null：宁可没有面板，也不能让它指到目录外。
 */
function normalizeSettingsUi(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sectionId = cleanString(raw.id, 'main');
  if (!sectionId || !/^[a-z][a-z0-9-]*$/.test(sectionId)) return null;
  const file = cleanString(raw.file, 'settings-ui.js');
  if (!file || file.startsWith('/') || file.startsWith('\\') || /^[a-zA-Z]:/.test(file) || file.includes('..')) return null;
  return {
    id: sectionId,
    label: cleanString(raw.label, ''),
    file
  };
}
