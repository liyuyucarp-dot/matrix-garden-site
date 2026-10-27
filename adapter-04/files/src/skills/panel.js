// 插件界面契约 —— 一个模块怎么把「自己的页面」放进控制台。
//
// ── 一句话 ────────────────────────────────────────────────────────────────
// 在 plugin.json / skill.json 的 configSchema 里写一条：
//
//     "viewer": {
//       "type": "action",
//       "label": "表情库",
//       "button": "查看收藏的表情",
//       "panel": "panel/viewer.html",
//       "description": "打开一个只读的查看器…"
//     }
//
// 设置弹窗就渲染出一颗按钮，点开是 iframe，src = /plugin-panel/<id>/panel/viewer.html。
// 页面要的数据由插件写进 api.storage（= <DATA_DIR>/plugin-data/<id>/storage.json），
// 页面 fetch 相对路径 `../@data/storage.json` 拿到。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────────
// 这条通道的三段 —— 后端静态服务（src/app.js）、前端弹层（ui/app/06-settings-render.js）、
// 插件侧助手（src/plugin-loader.js 的 api.panel）—— 必须对**同一套常量与同一套路径规则**
// 达成一致。以前它们各写一份：后端自带一份扩展名表，前端自己拼 URL 字符串，插件要手抄
// `/plugin-panel/<自己的 id>/`。任何一处改动漏掉另一处，症状都是"按钮点了没反应 / 白屏"，
// 而且**不报错**，非常难查。
//
// 收口方式：
//   · 后端（src/app.js）与插件侧（src/plugin-loader.js 的 api.panel）——直接 import 本文件；
//   · 前端弹层（ui/app/06-settings-render.js）——**不 import**（它是 classic script，不是 ES
//     模块，见 ui/index.html 的 defer 列表），改为**只消费后端在加载期算好的 `panels[].url`**，
//     自己一行路径都不拼。它只保留一个形状检查（URL 是否以 PANEL_ROUTE_PREFIX 开头）。
// 所以常量、路径校验、URL 拼装、CSP 的唯一实现都在这里；改规则只改这一处。
//
// ── 安全模型（谁在防谁）───────────────────────────────────────────────────
// 页面是**插件自己写的 HTML**，跑在控制台的**同源** iframe 里。所以：
//   · 只能读，不能写 —— 通道是纯 GET 静态文件，没有任何写接口；
//   · 只有两个根：插件自己的目录（plugins|skills/<id>/）与它自己的 plugin-data；
//     两者都经 realpath 二次确认，符号链接 / 目录联接指到外面一律 404；
//   · 扩展名白名单（PANEL_FILE_TYPES）—— 不做通用文件下载器；
//   · 来源校验 —— 恶意网页借浏览器读 127.0.0.1 也读不到（app.js 的 originAllowed）；
//   · 页面 CSP 由 panelCsp() 统一给出：script-src 'self'（禁内联脚本）、
//     frame-ancestors 'self'（只允许控制台自己嵌）。
// 反过来说：**页面能读到自己插件的全部源码与全部 plugin-data**。这不是漏洞
// （那本来就是它自己的东西），但插件不该把别人的机密往 plugin-data 里塞。
//
// ⚠️ 改了 plugins/** 或 skills/** 下任何内置模块，都要重算 builtin-modules.json 指纹
//    （.workbuddy/tools/refresh-builtin-baseline.mjs），否则插件会被当第三方扫、被拒加载。

/** 只读挂载的路由前缀。前端与插件都从这里取，不要硬编码字面量。 */
export const PANEL_ROUTE_PREFIX = '/plugin-panel';

/** `@data` 段：映射到 <DATA_DIR>/plugin-data/<id>/（插件的运行时数据）。 */
export const PANEL_DATA_SEGMENT = '@data';

/** api.storage 的落盘文件名 —— 也是页面默认的数据通道。 */
export const PANEL_DATA_FILE = 'storage.json';

/** 一个模块最多声明几个界面入口（防手滑写出几十个按钮）。 */
export const PANEL_MAX_ENTRIES = 8;

/** panel 路径长度上限（磁盘路径本来也有限制，这里给个明确的天花板）。 */
export const PANEL_PATH_MAX = 180;

/**
 * 允许从 /plugin-panel/ 吐出的文件类型。
 *
 * 刻意**不是**"任意文件"：只列插件页面真正会用到的那几种。这条通道一旦放开成
 * 通用文件下载器，插件目录里的 .md / .log / 无扩展名文件（可能含调试残留的密钥）
 * 都会跟着被挂出去。
 */
export const PANEL_FILE_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
});

/** action 条目认得的字段。写别的会被 problems 点出来（静默忽略最坑人）。 */
export const PANEL_ACTION_KEYS = Object.freeze(new Set(['type', 'label', 'button', 'panel', 'description', 'icon']));

/** 插件 id 的形态。与 skills/manifest.js 的 id 校验同口径。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 路径段的公共校验：拒绝一切"能跑到目录外面去"的写法。 */
function checkRelPath(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: '没写 panel' };
  if (s.length > PANEL_PATH_MAX) return { ok: false, reason: `路径过长（上限 ${PANEL_PATH_MAX} 字符）` };
  if (/[\x00-\x1f\x7f]/.test(s)) return { ok: false, reason: '路径含控制字符' };
  if (s.startsWith('/') || s.startsWith('\\')) return { ok: false, reason: '必须是相对插件目录的路径（不要以 / 开头）' };
  if (/^[A-Za-z]:/.test(s)) return { ok: false, reason: '不能带盘符' };
  if (s.includes('\\')) return { ok: false, reason: '请用 / 分隔，不要用反斜杠' };
  if (s.includes('://')) return { ok: false, reason: '不能是绝对 URL' };
  const segs = s.split('/');
  if (segs.some((x) => x === '' || x === '.' || x === '..')) {
    return { ok: false, reason: '路径不能含空段、. 或 ..' };
  }
  return { ok: true, segs, ext: extOf(segs[segs.length - 1]) };
}

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i <= 0 ? '' : String(name).slice(i).toLowerCase();
}

/**
 * 校验 configSchema 里声明的**入口页**路径。
 * 比 normalizePanelAsset 严一档：必须是 .html（iframe 的入口只能是页面）。
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function normalizePanelPath(raw) {
  const base = checkRelPath(raw);
  if (!base.ok) return base;
  if (base.segs[0] === PANEL_DATA_SEGMENT) {
    return { ok: false, reason: `不能指向 ${PANEL_DATA_SEGMENT}/（那是运行时数据，不是页面）` };
  }
  if (base.ext !== '.html') {
    return { ok: false, reason: `入口页必须是 .html（当前 .${base.ext.replace('.', '') || '无扩展名'}）` };
  }
  return { ok: true, path: base.segs.join('/') };
}

/**
 * 校验页面**引用到的资源**路径（.js/.css/图片/字体…）。
 * 用于 api.panel.url()：插件在自己的日志/通知里给链接时用。
 *
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function normalizePanelAsset(raw) {
  const base = checkRelPath(raw);
  if (!base.ok) return base;
  if (!PANEL_FILE_TYPES[base.ext]) {
    return { ok: false, reason: `扩展名不在白名单（允许：${Object.keys(PANEL_FILE_TYPES).join(' ')}）` };
  }
  return { ok: true, path: base.segs.join('/') };
}

/**
 * 拼出插件页面的只读 URL。**前后端共用这一份**，避免两边各拼一次拼出分歧。
 * id 或路径不合法时返回 ''（调用方据此显示"这个入口打不开"）。
 */
export function panelUrl(id, relPath) {
  const safeId = String(id ?? '').trim();
  if (!ID_RE.test(safeId)) return '';
  const segs = String(relPath ?? '').split('/').filter(Boolean);
  if (!segs.length) return '';
  return `${PANEL_ROUTE_PREFIX}/${encodeURIComponent(safeId)}/${segs.map(encodeURIComponent).join('/')}`;
}

/**
 * 拼出插件运行时数据的只读 URL（默认就是 api.storage 的落盘文件）。
 * 页面里写相对路径 `../@data/storage.json` 等价，且不必知道自己的 id —— 推荐后者。
 */
export function panelDataUrl(id, relPath = PANEL_DATA_FILE) {
  const safeId = String(id ?? '').trim();
  if (!ID_RE.test(safeId)) return '';
  const segs = String(relPath ?? '').split('/').filter(Boolean);
  if (!segs.length) return '';
  return `${PANEL_ROUTE_PREFIX}/${encodeURIComponent(safeId)}/${PANEL_DATA_SEGMENT}/${segs.map(encodeURIComponent).join('/')}`;
}

/**
 * 插件页面的 CSP。
 *
 * 与 /ui 同款，只有两处不同：
 *   · script-src 去掉 index.html 那个内联主题脚本的 hash —— 插件页面一律用外链 .js，
 *     不给内联脚本留口子（内联脚本连 onclick= 一起算）；
 *   · frame-ancestors 从 'none' 放宽成 'self' —— /ui 是顶层导航不需要放宽，
 *     而插件页面**就是要**被设置弹窗里的 iframe 嵌，写 'none' 会被浏览器直接拒掉。
 *
 * @param {{frameAncestors?: string|null}} [opts]
 *   frameAncestors 传 null 表示不发这条指令（预览服务要能被任意宿主嵌时用）。
 */
export function panelCsp({ frameAncestors = "'self'" } = {}) {
  const parts = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ];
  if (frameAncestors) parts.push(`frame-ancestors ${frameAncestors}`);
  return parts.join('; ');
}

/** 这条 configSchema 条目是不是界面入口。 */
export function isPanelAction(def) {
  return Boolean(def && typeof def === 'object' && def.type === 'action');
}

/**
 * 从 configSchema 里挑出所有界面入口，规范成 UI 能直接用的形态。
 *
 * 与 stripPanelActions 是一对：一个负责"取出入口"，一个负责"从配置项里摘掉"。
 * 两者都在 normalizeManifest 里调用一次，之后全流程都只认 `manifest.panels`
 * 与"已经不含 action 的 configSchema" —— UI 不必再过滤一遍，
 * 「共 N 项设置」也不必再减掉它（那个减法曾经是必须的，见 06-settings-render.js 的历史）。
 *
 * @returns {{panels: Array<{key:string,label:string,button:string,icon:string,
 *   description:string,panel:string,url:string,problem:string}>, problems: string[]}}
 */
export function collectPanels(id, configSchema) {
  const problems = [];
  const panels = [];
  const schema = (configSchema && typeof configSchema === 'object') ? configSchema : {};

  for (const [key, def] of Object.entries(schema)) {
    if (!isPanelAction(def)) continue;

    if (panels.length >= PANEL_MAX_ENTRIES) {
      problems.push(`configSchema.${key}：一个模块最多声明 ${PANEL_MAX_ENTRIES} 个界面入口，多余的已忽略`);
      continue;
    }

    const unknown = Object.keys(def).filter((k) => !PANEL_ACTION_KEYS.has(k));
    if (unknown.length) {
      problems.push(`configSchema.${key}：action 条目不支持字段 ${unknown.join('、')}（已忽略；可用：${[...PANEL_ACTION_KEYS].join(' ')}）`);
    }

    const checked = normalizePanelPath(def.panel);
    if (!checked.ok) problems.push(`configSchema.${key}：${checked.reason}`);

    const label = String(def.label ?? '').trim() || key;
    panels.push({
      key,
      label,
      button: String(def.button ?? '').trim() || '打开',
      icon: String(def.icon ?? '').trim(),
      description: String(def.description ?? '').trim(),
      panel: checked.ok ? checked.path : '',
      url: checked.ok ? panelUrl(id, checked.path) : '',
      // 空串 = 能打开；非空 = 给用户看的失败原因（UI 就地把按钮换成这行字，别给个死按钮）
      problem: checked.ok ? '' : checked.reason
    });
  }

  return { panels, problems };
}

/**
 * 从 configSchema 里摘掉界面入口，只留真正的配置项。
 *
 * 为什么必须摘：action 不是"设置值"，不该出现在保存循环里（它会变成一个
 * 不存在的配置键写进 config.skills[id]），也不该被算进「共 N 项设置」。
 */
export function stripPanelActions(configSchema) {
  const out = {};
  const schema = (configSchema && typeof configSchema === 'object') ? configSchema : {};
  for (const [key, def] of Object.entries(schema)) {
    if (isPanelAction(def)) continue;
    out[key] = def;
  }
  return out;
}
