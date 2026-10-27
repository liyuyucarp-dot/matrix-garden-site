// tools/fixtures/host-src/skills/config.js —— 探针桩
const store = new Map();

export function setSkillConfig(skillId, patch = {}) {
  const cur = store.get(skillId) || {};
  const next = { ...cur, ...patch };
  store.set(skillId, next);
  return next;
}

export function getSkillConfig(skillId) {
  return store.get(skillId) || {};
}

export default { setSkillConfig, getSkillConfig };
