// tools/fixtures/host-src/config.js —— **探针专用桩**，不是真宿主配置。
// 目的：让组件的 `import { getConfig, DATA_DIR } from '../../src/config.js'` 能解析。
// 数据目录用 QQ_AGENT_DATA_DIR（与真宿主同约定），其余一律给空/默认值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(process.env.QQ_AGENT_DATA_DIR || path.join(os.tmpdir(), 'matrix-garden-probe'), '..');
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(os.tmpdir(), 'matrix-garden-probe', 'data');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
let cache = null;

export function getConfig() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

export function updateConfig(patch = {}) {
  const cur = getConfig();
  cache = { ...cur, ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* 探针里写不进去也不影响判定 */ }
  return cache;
}

export function personaForChat() {
  return { name: '探针', roleText: '', nicknames: [] };
}

export default { ROOT, DATA_DIR, getConfig, updateConfig, personaForChat };
