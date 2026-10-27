// self-state.js —— 全局睡眠闸门与唤醒状态机（v2.0 极简重构版）
// ═════════════════════════════════════════════════════════════════════════════
// 重构核心设计（方案二定制版）：
//   1. 【彻底废除室内人类随机作息表 (SCHEDULE) 与随机恢复掷骰子 (RECOVERY-PICK)】：
//      · 她醒着的时候在干什么，100% 由 `travel-whale` 的「在途旅行 (trip)」与
//        「在家庭院日常 (homeAct)」单时钟接管，不再出现“人在罗弗敦群岛却掷骰子去逛街/打游戏”的精神分裂。
//   2. 【删除归途体力结算与出发元气门槛的双向联动】：
//      · 保持与 `travel-whale` 的零侵入只读边界。
//   3. 【专注做好三件事】：
//      · ① 跨群/私聊统一的睡眠状态存档 `data/self-state.json`（sleeping / awake + wakeAt 迷糊窗）；
//      · ② 睡眠入站/工具闸（`sleepGate` / `isWakeCall`：睡着时忽略普通群聊，被 @ + 喊醒词才迷糊应答）；
//      · ③ 她自己在回复里说“我去睡了/晚安”或“我去洗澡了”的言行一致追踪。
// ═════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { stepVitality } from './mood-chain.js';

const STATE_FILE = 'self-state.json';

export const SELF_STATE_DEFAULTS = {
  enabled: true,
  sleepAutoMs: 8 * 60 * 60 * 1000,   // 自然睡眠最多持续 8 小时自动醒
  napAutoMs: 45 * 60 * 1000,         // 小憩/午睡默认 45 分钟自动醒
  awakeGraceMs: 40 * 60 * 1000,      // 刚说过要睡的提醒窗口
  wakeMentionMs: 30 * 60 * 1000,     // 被喊醒后“迷迷糊糊”演出保持 30 分钟
  blockGroupRandom: true
};

export const OUTDOOR_HOME_DEFAULTS = { enabled: false };
export const BATH_EFFECTS = { vitalityGain: 20, fatigue: -20, happy: 5 };

export function selfStatePath() {
  return path.join(DATA_DIR, STATE_FILE);
}

export function readSelfState(now = Date.now()) {
  const file = selfStatePath();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    // ★ 兼容补丁（2026-10-25）：v1（现役宿主上的 1.x 版）把状态包在 `self` 里写，
    //   形如 `{ self: { status, what, at }, updatedAt }`。本文件重构时只读顶层
    //   `raw.status`，于是**上一版留下的存档一律被读成 awake**（她正"煮面"也会丢），
    //   而且写回时会把顶层字段和旧的 `self` 并存，形成双结构脏文件 ——
    //   一旦回滚到 v1，v1 会读到那份陈旧的 `self`。
    //   这里改成：有 `self` 就读 `self`，没有才读顶层（与 v1 的 `const s = j?.self || j` 同口径）。
    const raw = (j && typeof j.self === 'object' && j.self) ? j.self : j;
    const status = String(raw.status || 'awake');
    const at = Number(raw.at) || 0;
    const wakeAt = Number(raw.wakeAt) || 0;

    // 自然睡眠到期自动转醒
    if (status === 'sleeping') {
      const limit = Number(raw.autoWakeMs) || SELF_STATE_DEFAULTS.sleepAutoMs;
      if (at > 0 && now - at >= limit) {
        const next = { ...raw, status: 'awake', what: '', at: now, wakeAt: now, autoWakeMs: 0 };
        writeSelfState(next);
        return next;
      }
    } else if (status === 'busy') {
      // 兼容旧存档遗留的 busy 状态：直接归位为 awake，交由庭院/旅行状态展示
      const next = { ...raw, status: 'awake', what: '', at: now };
      writeSelfState(next);
      return next;
    }

    return {
      status: status === 'sleeping' ? 'sleeping' : 'awake',
      what: String(raw.what || ''),
      at,
      wakeAt,
      bath: raw.bath || null
    };
  } catch {
    return { status: 'awake', what: '', at: 0, wakeAt: 0, bath: null };
  }
}

export function writeSelfState(next = {}) {
  const file = selfStatePath();
  try {
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { prev = {}; }
    // ★ 兼容补丁（2026-10-25）：沿用 v1 的落盘结构 `{ self: {...}, updatedAt }`。
    //   旧存档（v1 嵌套 / 本版曾写出的"顶层+self 并存"脏文件）都先摊平再合并，
    //   这样无论回滚到 v1 还是继续跑 v2，读到的都是同一份状态，不会各读各的。
    const base = { ...prev, ...(prev && typeof prev.self === 'object' && prev.self ? prev.self : {}) };
    delete base.self;
    delete base.updatedAt;
    const merged = {
      ...base,
      ...next,
      status: next.status === 'sleeping' ? 'sleeping' : 'awake',
      what: String(next.what ?? ''),
      at: Number(next.at) || Date.now()
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ self: merged, updatedAt: Date.now() }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// ── 观察她自己的发言：说“去睡了/眯一会” → 进入自然睡眠 ──────────────────────

const SELF_SLEEP_RE = /(?:我先?去?睡了|我先?睡啦|先睡了|去睡觉了|去睡啦|困死了.*睡|撑不住.*睡|眯一会|小睡一会|午睡一会)/;
const SELF_NAP_RE = /(?:眯一会|小睡|午睡|浅眠)/;

export function stateFromSelfText(text, now = Date.now(), _cfg = null) {
  const t = String(text || '').trim();
  if (!t) return null;
  const firstClause = t.split(/[。！？!?\n]/)[0] || t;
  if (!SELF_SLEEP_RE.test(firstClause)) return null;
  const isNap = SELF_NAP_RE.test(firstClause);
  return {
    status: 'sleeping',
    what: isNap ? '小憩眯一会儿' : '自己困了去睡觉',
    at: now,
    autoWakeMs: isNap ? SELF_STATE_DEFAULTS.napAutoMs : SELF_STATE_DEFAULTS.sleepAutoMs
  };
}

// ── 泡澡识别与元气恢复 ────────────────────────────────────────────────────

export function readBathState(now = Date.now()) {
  const st = readSelfState(now);
  return st.bath || { lastAt: 0, dayKey: '' };
}

export function writeBathState({ now = Date.now() } = {}) {
  const dayKey = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const st = readSelfState(now);
  return writeSelfState({ ...st, bath: { lastAt: now, dayKey, active: true } });
}

export function bathStartFromSelfText(text) {
  return /(?:我去洗澡|去泡个?澡|先去洗澡|去冲个澡)/.test(String(text || ''));
}

export function bathDoneFromSelfText(text) {
  return /(?:洗完澡|泡完澡|刚洗完|吹干头发)/.test(String(text || ''));
}

export function bathCommandFromText(texts = []) {
  return (Array.isArray(texts) ? texts : [texts]).some((t) => /(?:去洗澡|洗个澡吧)/.test(String(t || '')));
}

export function settleBath(now = Date.now()) {
  const st = readSelfState(now);
  const dayKey = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  writeSelfState({ ...st, bath: { lastAt: now, dayKey, active: false } });
  stepVitality(BATH_EFFECTS.vitalityGain, '泡了个舒服的热水澡', now);
  return BATH_EFFECTS;
}

// ── 睡眠唤醒判定与提示词注入 ────────────────────────────────────────────────

const WAKE_CALL_RE = /(?:醒醒|快醒|起床|别睡|起来|叫醒|摇醒|戳醒|拍拍|捏脸|掀被子|太阳晒屁股)/;

export function isWakeCall(entries = [], { selfNickname = '', botName = '', selfId = '', isPrivate = false } = {}) {
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const text = String(e.text || '');
    const addressed = isPrivate
      || e.isAtMe
      || e.isPoke
      || (selfNickname && text.includes(selfNickname))
      || (botName && text.includes(botName))
      || (selfId && text.includes(`qq=${selfId}`));
    if (!addressed) continue;
    if (e.isPoke || WAKE_CALL_RE.test(text)) return true;
  }
  return false;
}

export function markWoken(now = Date.now()) {
  const st = readSelfState(now);
  return writeSelfState({ ...st, status: 'awake', what: '', wakeAt: now });
}

export function inWakeGrace(selfState, cfg = null, now = Date.now()) {
  const st = selfState || readSelfState(now);
  const graceMs = Number(cfg?.selfState?.wakeMentionMs) || SELF_STATE_DEFAULTS.wakeMentionMs;
  const wakeAt = Number(st?.wakeAt) || 0;
  return wakeAt > 0 && now - wakeAt <= graceMs;
}

export function sleepGate({
  entries = [],
  selfNickname = '',
  botName = '',
  selfId = '',
  cfg = {},
  now = Date.now(),
  isPrivate = false
} = {}) {
  const st = readSelfState(now);
  if (st.status !== 'sleeping') {
    return { block: false, status: 'awake', reason: '' };
  }
  if (isWakeCall(entries, { selfNickname, botName, selfId, isPrivate })) {
    markWoken(now);
    return { block: false, status: 'woken', reason: '被叫醒' };
  }
  return {
    block: true,
    kind: 'sleep',
    status: 'sleeping',
    reason: st.what ? `正在睡觉（${st.what}）` : '正在睡觉'
  };
}

/**
 * 自身状态注入块：
 *   · 仅在「正在睡觉」或「刚被叫醒 30 分钟迷糊窗内」注入；
 *   · 清醒常态下返回空串，把舞台 100% 交给 `travel-sync.js` 的【在路上】与【在庭院】。
 */
export function selfStateBlock(cfg = null, now = Date.now()) {
  const st = readSelfState(now);
  if (st.status === 'sleeping') {
    return `【此刻状态·睡眠中被惊动】你本来正在睡觉${st.what ? `（${st.what}）` : ''}，这会儿是被吵醒才勉强应一声：语气要困倦、迷迷糊糊、短促，像随时会缩回被窝继续睡。`;
  }
  if (inWakeGrace(st, cfg, now)) {
    const mins = Math.max(1, Math.round((now - Number(st.wakeAt || now)) / 60_000));
    return `【此刻状态·刚被叫醒】你 ${mins} 分钟前才刚被叫醒，脑子还有点懵、困意没全散：说话带一点刚睡醒的软糯或起床气，别一下子表现得过于亢奋。`;
  }
  return '';
}

// ── 已移除的室内作息表/随机外出兼容空桩 ────────────────────────────────────
export function shouldNotifySleepNotice() { return false; }
export function activityOf() { return null; }
export function outdoorReturnHit() { return false; }
export function outdoorTopicRecent() { return false; }
export function shouldAutoReturnHome() { return false; }
export function outdoorHomeNoticeText() { return ''; }
export function pickRecovery() { return null; }
export function settleRecovery() { return null; }
export function scheduleSlotOf() { return null; }
export function pickScheduled() { return null; }
export function pickBoredSwitch() { return null; }
export function scheduleBlock() { return ''; }
