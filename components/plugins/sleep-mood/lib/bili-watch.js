// bili-watch —— 「她这会儿在 B 站刷视频」这个**并行状态**的读侧。
//
// 背景（2026-10-22）：bili-whale 每轮醒来会真的调多模态看视频，一轮可能持续
// 十几分钟到半小时。这段时间里如果主人找她，她应该知道"我手上正开着 B 站"，
// 而不是表现得像闲着 —— 这是群友方案里最值钱的一条。
//
// 三条硬约束（都是被本项目教训出来的）：
//   ① **不顶掉任何东西**。旅行 / 在家 / 刚被叫醒 / 刚吃完 都照常注入，
//      这一条是**叠加**的（和 foodAfter 同一个位置，都在 travel 的 if/else 外面）。
//      所以文案里**不许出现位置**，只说"手上在做的事"。
//   ② **一写一读，不互相写**。bili-whale 写它自己的
//      <DATA_DIR>/plugin-data/bili-whale/storage.json 的 activity 键；
//      这里只读。和 travel-sync 读 travel-whale 是同一个模式（pull，不 push）。
//   ③ **坏文件/过期一律当"没在刷"**。绝不因为一个状态文件把正常聊天锁死。
//
// 为什么这里带 mtime 缓存：before-llm-messages 是每条入站消息都跑一遍，
// 而 bili 的 storage.json 可能到 1MB。stat 一次很便宜，整文件反序列化不便宜。
// 信标变一次 mtime 就变，所以按 mtime+size 缓存是精确的。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE_REL = ['plugin-data', 'bili-whale', 'storage.json'];
const MAX_AGE_MS = 4 * 60 * 60 * 1000;      // 4 小时上限：防脏数据把人锁在"正在刷"

let cache = { key: '', val: null };

export function biliStoragePath() {
  try { return path.join(DATA_DIR, ...FILE_REL); } catch { return ''; }
}

/**
 * 读信标。返回 null = 没在刷 / 过期 / 文件坏了。
 * @returns {null | {since:number, mins:number, stage:string, title:string, index:number, total:number}}
 */
export function biliActivity(now = Date.now()) {
  try {
    const p = biliStoragePath();
    if (!p) return null;
    let st = null;
    try { st = fs.statSync(p); } catch { return null; }        // 没装 bili-whale 就走这里
    const key = `${st.mtimeMs}:${st.size}`;
    if (cache.key !== key) {
      let val = null;
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        const a = j?.activity;
        if (a && a.busy === true) val = a;
      } catch { val = null; }
      cache = { key, val };
    }
    const a = cache.val;
    if (!a) return null;
    const since = Number(a.since) || 0;
    const until = Number(a.until) || 0;
    if (until && now > until) return null;                      // bili 没清干净（进程被杀）→ TTL 收口
    if (since && now - since > MAX_AGE_MS) return null;
    return {
      since,
      mins: since ? Math.max(0, Math.round((now - since) / 60000)) : 0,
      stage: String(a.stage || ''),
      title: String(a.title || '').slice(0, 40),
      index: Number(a.index) || 0,
      total: Number(a.total) || 0
    };
  } catch { return null; }
}

/**
 * 注入用的那一行。空串 = 不注入。
 *
 * 写法上的三条讲究：
 *   · 只说"手上"，不说"在哪" —— 位置归 travel，两个块各管一段才不会打架；
 *   · 明写"还没看完" —— 否则她会在半途被问起时按"我看完了"的口吻编内容；
 *   · 给出"被打断时怎么办"的台词（等我看完这条）—— 人的反应是敷衍一句，不是沉默。
 */
export function biliWatchPromptText(now = Date.now()) {
  const a = biliActivity(now);
  if (!a) return '';
  const when = a.mins >= 3 ? `已经 ${a.mins} 分钟了` : '刚打开';
  let doing = '';
  if (a.title) {
    const idx = a.index ? `第 ${a.index}${a.total ? `/${a.total}` : ''} 条` : '一条';
    doing = `，正在看${idx}《${a.title}》`;
  } else if (a.stage === '选题') {
    doing = '，在首页翻，还没点开';
  }
  const tail = a.title
    ? '这条还没看完 —— 有人找你，可以边看边回，也可以直说“等我看完这条”；但别把“正在看”说成“看完了”，也别编这条里没出现的东西。'
    : '有人找你，可以边看边回，也可以直说“我先看会儿”。';
  return `【手上】你正在 B 站刷视频（${when}${doing}）。${tail}`;
}

// ── 「刷手机」闸（PHONE-GATE，2026-10-22）────────────────────────────────
//
// 语义：和「自然睡眠」同一套逻辑，只是**轻一档**。
//   · 自然睡眠：睡着 → 默认不响应；只有喊醒词/接触词把她叫醒才放行。
//   · 刷手机  ：低着头在刷 → 大概率没抬头；但**被点名/私聊/被 @ 一定抬头**，
//              而且**越催越容易抬头**（连叫 2 次概率砍半，3 次再砍半…）。
//
// 为什么概率要随次数下降：人刷手机时，第一条消息常常真的没看见，第二条开始就会瞄一眼。
// 固定概率会演成"她心情好了才理人"，那不像人，像坏了的客服。
//
// ★★ 2026-10-23 再改一层：**概率本身也删了**（默认 selfDecide=true）。
//   概率闸的问题不是"概率调得对不对"，是它**替她做了决定** —— 系统说不回，她就没机会回。
//   现在只把事实给她（在刷手机 / 第几次被打扰），抬不抬头她自己定；
//   要退回旧行为：设置里 selfDecide=false，再把 phoneIgnoreChance 调上去。
//   （依据：「溟月的心」§30 不变式①——闸门只能决定"有没有机会"，不能决定"她说什么"。）
//
// ⚠️ 只在**没在睡**的时候用（睡着由 sleepGate 管，两套不叠加）。
// ⚠️ 判定一次就消费一次随机数：同一条消息不会被判两遍（调用方每条消息只调一次）。

const MISS_TTL_MS = 30 * 60 * 1000;   // 超过 30 分钟没再被打扰 → 忘掉"没抬头"的累计
const misses = new Map();             // chatKey -> { n, at }

function addressedToHer(entries, { selfNickname, botName, isPrivate }) {
  if (isPrivate) return true;         // 私聊本来就是单独找她
  const nick = String(selfNickname || '').trim();
  const bot = String(botName || '').trim();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const t = String(e?.text ?? '');
    if (e.isAtMe || t.includes('@你') || (nick && t.includes(nick)) || (bot && t.includes(bot))) return true;
  }
  return false;
}

/**
 * @returns {{block:boolean, kind:string, reason:string, misses?:number}}
 *   block=true → 这条她"没抬头"，发送类工具会被拦下（消息照常存档，不丢）。
 */
export function phoneGate({
  chatKey = '', entries = [], selfNickname = '', botName = '', isPrivate = false,
  now = Date.now(), baseChance = 0, selfDecide = true
} = {}) {
  const a = biliActivity(now);
  if (!a) {
    misses.delete(chatKey);
    return { block: false, kind: 'phone', reason: 'not-browsing' };
  }
  if (addressedToHer(entries, { selfNickname, botName, isPrivate })) {
    misses.delete(chatKey);
    return { block: false, kind: 'phone', browsing: true, reason: '被点名 → 抬头' };
  }
  const rec = misses.get(chatKey);
  const n = (rec && now - rec.at < MISS_TTL_MS) ? Number(rec.n) || 0 : 0;

  // ★ 2026-10-23：**决定权在她**（见文件头「刷手机」那节的补充说明）。
  //   selfDecide=true（默认）：不掷骰子、不 block —— 只把"她在刷手机、这是第几次被叫"
  //   这个**事实**交给调用方去注入，抬不抬头由她自己定。
  //   为什么改：概率闸是"系统替她决定不回"，不是"给她机会自己决定"。
  if (selfDecide) {
    misses.set(chatKey, { n: n + 1, at: now });
    return {
      block: false,
      kind: 'phone',
      browsing: true,
      misses: n + 1,
      reason: `在刷手机（第 ${n + 1} 次被打扰，抬不抬头她自定）`
    };
  }

  // 旧行为（selfDecide=false 时）：按概率替她判定没抬头
  const base = Math.max(0, Math.min(1, Number(baseChance) || 0));
  const p = base * Math.pow(0.45, n);
  if (p > 0 && Math.random() < p) {
    misses.set(chatKey, { n: n + 1, at: now });
    return { block: true, kind: 'phone', reason: `低头刷手机（第 ${n + 1} 次没抬头）`, misses: n + 1 };
  }
  misses.delete(chatKey);
  return { block: false, kind: 'phone', reason: `抬头了（概率 ${p.toFixed(2)}）` };
}

/** 测试用：清掉「没抬头」计数。 */
export function _resetPhoneMisses() { misses.clear(); }

/** 测试用：清掉模块内缓存（宿主里不需要）。 */
export function _resetCache() { cache = { key: '', val: null }; }
