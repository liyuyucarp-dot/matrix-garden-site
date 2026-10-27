/**
 * Skill 持久化存储：api.storage.get / set / remove（[[courtyard:storage]]，v1.1.2 新增）
 *
 * 为什么必须有它：0.4 preview 的 createSkillApi **没有 storage**，而 0.4.8.x 有；
 *   插件按"宿主有 api.storage"写（courtyard-map 的 publishNow 写快照），
 *   面板再去 `/plugin-panel/<id>/@data/storage.json` 取 —— 缺一环就是"面板永远空白"。
 *   ⚠️ 适配层 v1.1.0/1.1.1 只补了面板**路由**，没补**写入端**，所以 @data 一直是 404。
 *
 * 落盘：`<DATA_DIR>/plugin-data/<skillId>/storage.json`
 *   与 src/skills/panel.js 的 PANEL_DATA_FILE 同一约定 —— 路由读的就是这个文件。
 * 设计取舍同 0.4.8.x：同步读写、每次整文档落盘、1MB 软上限、拒 __proto__ 这类 key。
 */
const SKILL_STORAGE_MAX_BYTES = 1024 * 1024;

function makeSkillStorage(skillId) {
  const dir = path.join(DATA_DIR, 'plugin-data', skillId);
  const file = path.join(dir, 'storage.json');
  const readAll = () => {
    try {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch { return {}; }   // 不存在/损坏都从空开始：存储坏了不能拖死整个扩展
  };
  const writeAll = (obj) => {
    const text = JSON.stringify(obj, null, 2);
    if (Buffer.byteLength(text, 'utf8') > SKILL_STORAGE_MAX_BYTES) {
      throw new Error(`storage 写入失败：数据超过 1MB 上限（当前 ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)}KB）。`
        + '大体积内容请存文件并只在这里记路径，或清理旧键后再写。');
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 写文件时再报真实错误 */ }
    fs.writeFileSync(file, text, 'utf8');
  };
  return {
    get: (key, fallback = null) => {
      const all = readAll();
      return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
    },
    set: (key, value) => {
      if (typeof key !== 'string' || !key.trim()) throw new Error('storage.set：key 必须是非空字符串');
      // __proto__ / constructor / prototype 在 JS 对象上有特殊语义：写了不是存数据，是改原型
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`storage.set：key 不能是 "${key}"（会命中 JS 原型语义，数据无法正常存取）`);
      }
      const all = readAll();
      all[key] = value === undefined ? null : value;
      writeAll(all);
      return true;
    },
    remove: (key) => {
      const all = readAll();
      if (!Object.prototype.hasOwnProperty.call(all, key)) return false;
      delete all[key];
      writeAll(all);
      return true;
    }
  };
}

