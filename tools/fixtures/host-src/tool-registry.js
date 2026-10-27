// tools/fixtures/host-src/tool-registry.js —— 探针桩：内存版工具表
const tools = new Map();

export function registerTool(def) {
  if (def?.id) tools.set(def.id, def);
  return def?.id;
}

export function unregisterTool(id) {
  return tools.delete(id);
}

export function unregisterToolsBySkill() {
  return 0;
}

export function getTool(id) {
  return tools.get(id) || undefined;
}

export function listTools() {
  return [...tools.values()];
}

export default { registerTool, unregisterTool, unregisterToolsBySkill, getTool, listTools };
