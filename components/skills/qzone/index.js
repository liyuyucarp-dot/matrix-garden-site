// components/skills/qzone/index.js —— 合并后的装配层
//
// 结构（v2.3.0）：
//   lib/social.js  社交线：发说说 / 刷动态 / 读评论 / 点赞 / 评论 / 回复（原 skills/qzone）
//   lib/diary.js   日记线：收集素材 / 发日记说说 + 自动日记闸（原 skills/qqzone）
//   index.js       本文件：设置合并与迁移、按开关装配两条线、统一生命周期
//
// 为什么用「代理 api」而不是让两个分片各自读设置：
//   宿主只给一个 config()（整个技能的设置）。两条线的设置键完全不相交，所以这里把
//   合并后的设置**切两份视图**传下去 —— 分片里的代码一行都不用改，也不用知道对方存在。
import * as social from './lib/social.js'
import * as diary from './lib/diary.js'

const SOCIAL_KEYS = ["maxPostChars", "maxCommentChars", "maxFeeds", "maxComments", "postsPerDay", "likesPerHour", "commentsPerHour", "browseIntervalMinutes", "allowChatImages", "maxImagesPerPost", "inboxEnabled", "pollIntervalMinutes", "pollFeedCount", "inboxMaxShows", "inboxTtlHours", "inboxFirstRunHours", "browseAutoEnabled", "browseAutoMaxItems", "browseAutoMaxShows", "browseAutoTtlHours"]
const DIARY_KEYS = ["diaryPerDay", "maxDiaryChars", "showInChat", "maxChats", "msgsPerChat", "maxCollectChars", "worldbookChars", "useDiaryCards", "maxDiaryCards", "diaryTargetMin", "diaryTargetMax", "diaryAuto", "diaryAtHour", "diaryAtMinute", "diaryModelMaxTokens"]
const SHARED_KEYS = ["allowInGroup", "maxImageMB"]

let apiRef = null
let state = { social: false, diary: false }

/** 旧版迁移：skills.qqzone + skills.qzone 各自的历史配置 → 合并后的单段配置（幂等） */
export function migrateSettings(raw = {}) {
  const out = { ...raw }
  if (out.settingsVersion === 3) return out
  const merged = { ...(raw || {}) }
  if (merged.socialEnabled == null) merged.socialEnabled = raw.enabled !== false
  if (merged.diaryEnabled == null) merged.diaryEnabled = raw.enabled !== false
  merged.enabled = raw.enabled !== false
  merged.settingsVersion = 3
  out.settingsVersion = 3
  Object.assign(out, merged)
  return out
}

function view(all, keys, shared) {
  const v = {}
  for (const k of keys) if (k in all) v[k] = all[k]
  for (const k of shared) if (k in all) v[k] = all[k]
  return v
}

export function setup(api) {
  apiRef = api
  const raw = (api.config && typeof api.config === 'function' ? api.config() : {}) || {}
  const cfg = migrateSettings(raw)
  const wantSocial = cfg.enabled !== false && cfg.socialEnabled !== false
  const wantDiary = cfg.enabled !== false && cfg.diaryEnabled !== false

  if (wantSocial) {
    const sub = { ...api, config: () => ({ ...view(cfg, SOCIAL_KEYS, SHARED_KEYS), enabled: true }) }
    try { social.setupSocial(sub); state.social = true }
    catch (e) { api.warn?.('[qzone] 社交线装配失败：' + (e && e.message || e)) }
  }
  if (wantDiary) {
    const sub = { ...api, config: () => ({ ...view(cfg, DIARY_KEYS, SHARED_KEYS), enabled: true }) }
    try { diary.setupDiary(sub); state.diary = true }
    catch (e) { api.warn?.('[qzone] 日记线装配失败：' + (e && e.message || e)) }
  }
}

export function activate() {
  try { if (state.social) social.activateSocial() } catch (e) { apiRef?.warn?.('[qzone] 社交线激活失败：' + e?.message) }
  try { if (state.diary) diary.activateDiary() } catch (e) { apiRef?.warn?.('[qzone] 日记线激活失败：' + e?.message) }
}

export function deactivate() {
  try { if (state.social) social.deactivateSocial() } catch { /* ignore */ }
  try { if (state.diary) diary.deactivateDiary() } catch { /* ignore */ }
}

export function dispose() {
  try { if (state.social) social.disposeSocial() } catch { /* ignore */ }
  try { if (state.diary) diary.disposeDiary() } catch { /* ignore */ }
}

/** 可用性：两条线**任一**可用即算可用（缺 Cookies 时用各自的说明） */
export function available() {
  const s = state.social ? safe(() => social.available()) : null
  const d = state.diary ? safe(() => diary.available()) : null
  const ok = (s && s.ok) || (d && d.ok) || false
  return ok ? { ok: true } : { ok: false, reason: (s && s.reason) || (d && d.reason) || '两条线都没启用或不可用' }
}

export function diagnose() {
  const s = state.social ? safe(() => social.diagnose()) : null
  const d = state.diary ? safe(() => diary.diagnose()) : null
  return { social: s, diary: d }
}

function safe(fn) { try { return fn() } catch (e) { return { ok: false, reason: String(e?.message || e) } } }

// 供测试/排障：把两条线的导出挂出来（不影响宿主契约）
export { social, diary }
