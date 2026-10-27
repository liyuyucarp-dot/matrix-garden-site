// tools/fixtures/host-src/skills/manager.js —— 探针桩：只提供组件实际用到的那几个方法
const registry = new Map();

export const skillManager = {
  registry,
  services: null,
  settingsOf: () => ({}),
  isActive: () => ({ active: false }),
  hasCapability: () => false,
  getCapabilityProviders: () => [],
  onServices: () => () => {},
  list: () => [...registry.values()],
  get: (id) => registry.get(id)
};

export default { skillManager };
