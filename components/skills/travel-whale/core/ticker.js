// 矩阵庭院（travel-whale）· 模块化组件：core/ticker.js
// 职责：后台主时钟（tick / startTicker）：跨会话推进、夜间暂存补发、津贴发放与自理循环

import * as S from '../state.js?v=realworld-1';
import * as E from '../engine.js';
import * as HM from '../home.js';
import {
  G,
  QUICK_TEST_KEY_SUFFIX,
  RT,
  TICKER_SLOT,
  TICK_RUNNING,
  activeChats,
  buildDeps,
  cfg,
  isEnabled,
  isPrivateChat,
  killTicker,
  log
} from './runtime-deps.js';
import {
  companionEmoji,
  companionOf,
  dueStipend,
  foodNeedOf,
  homeShotHoursOf,
  partyOf,
  speakAs,
  stipendPayers
} from './companions-voice.js';
import { pendingCompanionOf } from './skills-appointments.js';
import {
  awaySideTripOf,
  busyCompanionIds,
  normalizeSideTrips,
  placeLabel,
  refreshHomeAct,
  restRange,
  syncWorldbook
} from './world-sync.js';
import { depart } from './departure.js';
import { homeKey, notifyUI, pendingSayKind, say } from './broadcast.js';
import { sendCard, sendReturnCard, sendSouvenirImages, settleTrip } from './postcards-settle.js';
import {
  ackSideWishDispatched,
  ackSideWishRejected,
  clearSideWish,
  departSideTrip,
  pickSideParty,
  readSideWish,
  settleSideTrip,
  shootHomeGroup,
  sideTripTier
} from './side-trips.js';
import { autoInvite, autoSpend, autoTend, bestFoodTier, considerDepart, judgeSideWish } from './autonomy.js';
import { LOCAL_ONLY } from './shop-album-menu.js';
import { farmTick } from './pantry-farm.js';

// ── 2026-10-28（P2）：定时器统一交给中央心跳 ────────────────────────────────
// 有 courtyard.clock 就挂到它那**一个 1s 主循环**上（±10% 抖动错峰、单任务超时、一处注销）；
// 拿不到就退回本地 setInterval —— 组件可能被单独安装，必须能独立跑。
function infraClock() {
  try { return globalThis.__courtyardInfra?.clock || null; } catch { return null; }
}
function everyTimer(id, ms, fn) {
  const clk = infraClock();
  if (clk) { try { return clk.every(id, ms, fn, { jitter: 0.1 }); } catch { /* 落到本地 */ } }
  const t = setInterval(fn, ms);
  try { t.unref?.(); } catch { /* ignore */ }
  return t;
}
function stopTimer(h) {
  if (!h) return;
  if (typeof h === 'function') { try { h(); } catch { /* ignore */ } return; }
  try { clearInterval(h); } catch { /* ignore */ }
}


export async function tick() {
  if (G[TICK_RUNNING]) return;  // 上一轮没跑完 → 直接跳过，绝不并发
  G[TICK_RUNNING] = true;
  try {
  const settings = cfg();
  if (settings?.enabled === false) return;

  // ★ HOME-ONLY（BROADCAST）：鲸鱼只养在「家」那一个会话 —— 别处即使有旧存档也不再推进
  //   （那些存档是改造前"每个群各养一只"留下的，留着不动，不发消息也不报错）。
  //   没配 homeChatKey 时退回老行为：每个有存档的会话各推进一只。
  const home = homeKey();
  // ★★ 2026-10-19 修（用户报「快速测试十分钟无任何反馈」）：
  //   快速测试写在 `<home>_test` 这份**独立存档**里（不污染真身），但上面这行
  //   `k === home` 把它一起过滤掉了 ⇒ 这趟测试**永远不被 tick**：
  //   第 5 分钟不寄片、第 10 分钟不回家，群里一片安静（开始那句之后就没了）。
  //   ⚠️ 没有配 homeChatKey 时（老的"每个群各养一只"）本来就会遍历到 `_test`，
  //      所以这个 bug 只在"只养一只"模式下出现 —— 也正好是最常见的模式。
  const testKeyOfHome = home ? home + QUICK_TEST_KEY_SUFFIX : '';
  const keys = home
    ? activeChats().filter((k) => k === home || (testKeyOfHome && k === testKeyOfHome))
    : activeChats();
  for (const chatKey of keys) {
    try {
      if (!isEnabled(chatKey, settings)) continue;
      const state = S.loadState(chatKey);
      // ★ 存档键 ≠ 发送目标。
      //   快速测试用 `${chatKey}_test` 当存档键（隔离数据），但消息必须发回**真实会话** ——
      //   踩过的坑：把存档键当发送目标，OneBot 收到 user_id='12345678_test'
      //   直接回 retcode=1400（expected a positive integer），明信片全发不出去。
      //   所以测试态在存档里记下 realChatKey，发送一律用它。
      const target = String(state.realChatKey || chatKey);
      const deps = buildDeps(target, state);
      let dirty = false;
      const now = Date.now();

      // 货架补货（没人逛商店时也要按时补满，否则会断供）
      if (S.restockIfDue(state, now, Number(settings.restockHours || 168) * 3600 * 1000)) dirty = true;

      // ── ★★ 2026-10-14 设施 B「数据标注车间」：结算产出 ＋ **24 小时硬闸** ──────────────
      // 为什么挂在这儿：这是**定期维护**类动作，和补货同层 —— 每轮 tick 都会走到，
      //   **不需要新开定时器**（新定时器＝又多一个要接管/要留痕的东西）。
      // `accrueLabelroom` 按 `elapsed × 人数` 累加 ⇒ **天然幂等**：跑多少轮都不会多给。
      if (typeof S.accrueLabelroom === 'function') {
        S.accrueLabelroom(state, now);
        const due = (typeof S.labelroomDueWorkers === 'function') ? S.labelroomDueWorkers(state, now) : [];
        for (const w of due) {
          // ★★ 硬约束：**连续上工满 24 小时 ⇒ 自动下班**（用户口径），并**封印**：
          //   她必须先出一次门（带她旅行 / 放她自己出去玩）才能再上工 —— 见 `endWork`。
          const done = (typeof S.endWork === 'function') ? S.endWork(state, w.id, now) : { ok: false };
          if (!done?.ok) continue;
          dirty = true;
          const def = (S.COMPANIONS || {})[w.id] || {};
          const nm = String(def.name || w.id);
          // 她本人的口气（借嘴）——**失败就回落一句转述**，绝不让播报把"下班"这件事带塌。
          let line = '';
          try {
            line = await speakAs(w.id,
              '你在庭院的数据标注车间里连着上了一整天班（**满 24 小时**），现在**到点下班**了。'
              + '用你自己的口气吐槽一句 —— 大意是"可恶的家伙居然想压榨我"，一到两句，口语，别念设定、别谢场。');
          } catch { line = ''; }
          const text = line
            ? `${companionEmoji(def)} 「${nm}」：${line}`
            : `${companionEmoji(def)} 「${nm}」到点下班了 —— 可恶的家伙居然想压榨我。`;
          log(`[travel-whale] ${target} 车间下班：「${nm}」（连续 ${Math.round(w.workedMs / 3600000)} 小时）`);
          // ★ 夜间压住（与明信片播报同一套 `state.pending` 通道）——
          //   ⚠️ `kind` **不能用** 'return'／'side-return'：那两个会被补发逻辑当成
          //      "到家明信片"去调 `sendReturnCard`，还会顺手重排出发节奏。用自有的 kind。
          //   ★ 2026-10-21：车间下班是**系统回执** ⇒ `sayKind:'system'`（只发回家，不刷屏）。
          if (E.isNight(now)) state.pending.push({ kind: 'labelroom-off', sayKind: 'system', lines: [text] });
          else await say(target, text, { kind: 'system' });
        }
      }

      // ⓪ 补发被夜间压住的播报。补发的**当下**才排下次出发 ——
      //    基准是「播报发出的时刻」+ 休息区间，所以这里补完立刻重排。
      if (Array.isArray(state.pending) && state.pending.length && !E.isNight(now)) {
        for (const item of state.pending) {
          // 先补到家明信片（它本来就排在播报之前），再补播报。
          // ★ 鲸鱼那趟（'return'）与闲置伙伴那趟（'side-return'）共用同一个补发通道，
          //   两者的 snapshot 结构一致、都走 sendReturnCard。
          if ((item.kind === 'return' || item.kind === 'side-return') && item.snapshot) {
            try { await sendReturnCard(target, state, item.snapshot, deps); }
            catch (error) { log('[travel-whale] 补发到家明信片失败：' + (error?.message ?? error)); }
          }
          // ★★ 2026-10-21：补发**必须沿用原来那一类** —— 半夜压下的明信片早上不能被当成
          //   system 只发回家（`pendingSayKind`：新条目读 `sayKind`，老存档按事项种类回推）。
          const pk = pendingSayKind(item);
          for (const line of (item.lines || [])) await say(target, line, { kind: pk });
          // ★ 2026-10-26：夜里压住的稀有特产图 —— 跟播报一起补发（老条目没有 `images` ⇒ 跳过）
          await sendSouvenirImages(target, item.images, pk);
          // 归家播报里的奖励 / 罕见特产注 / 称号解锁（`sysLines`）：老存档没有这个字段 ⇒ 跳过
          for (const line of (Array.isArray(item.sysLines) ? item.sysLines : [])) {
            await say(target, line, { kind: 'system' });
          }
        }
        // ★ 按 kind 分别重排"下一次"：鲸鱼那趟 → nextDepartAt；伙伴那趟 → sideNextAt。
        //   混着重排会把另一边的节奏也一起推迟（两边本来各走各的）。
        const hadWhale = state.pending.some((x) => x.kind === 'return');
        const hadSide = state.pending.some((x) => x.kind === 'side-return');
        state.pending = [];
        if (hadWhale) state.nextDepartAt = E.nextDepartAt(now, Math.random, restRange());
        if (hadSide) state.sideNextAt = E.nextDepartAt(now, Math.random, restRange());
        dirty = true;
        // ⚠️ 2026-10-13 修：原来写成 `${'$'}{...}` ⇒ 日志里打出来的是**字面量**
        //    `${state.nextDepartAt ? '夜间压住的播报' : '播报'}`（实测见 07:01 那条），
        //    排查时完全读不出信息。
        log(`[travel-whale] ${chatKey} 补发了 ${state.nextDepartAt ? '夜间压住的播报' : '播报'}，下次出发 ${new Date(state.nextDepartAt).toLocaleString('zh-CN', { hour12: false })}`);
      }

      if (state.trip) {
        const adv = E.planAdvance(state, now);

        // ① 该寄的明信片：一次 tick 只寄一张，避免一口气刷屏（限频也在 sender 里）
        if (adv.cards.length) {
          await sendCard(target, state, adv.cards[0].index);
          dirty = true;
        }

        // ② 到家了 → 收尾
        if (adv.returned) {
          // 整趟都在夜里、一张没寄的情况：补寄最后一张再收尾，
          // 否则"出门一趟群里啥都没留下"，玩家会以为功能坏了
          // ⚠️ 必须**重新算**剩余张数，不能用 adv.overdueCards ——
          //    那是第 ① 步**之前**的快照，里面还包含刚刚寄掉的那张，
          //    直接用它会把同一张明信片再寄一遍（实测相册凭空多一张）。
          const sentNow = Number(state.trip?.cardsSent) || 0;
          const cards = state.trip?.cardTimes || [];
          // 只在「这趟**一张都还没寄出去**」时补寄最后一张。
          // 这正是「整趟都在夜里 → 一张没寄」的场景。
          // 若第 ① 步已经寄过，就**不再补** —— 否则一次 tick 会连发好几条（违反防刷屏）。
          if (sentNow === 0 && cards.length) await sendCard(target, state, cards.length - 1);
          await settleTrip(target, state, deps);
          dirty = true;
        }
      } else if (state.test) {
        // 测试存档**永不自动出发** —— 否则测试跑完，一只幽灵鲸鱼会按休息节奏
        // 自己继续出门旅行、往群里寄片，用户莫名其妙。
        state.nextDepartAt = 0;
      } else if (isPrivateChat(chatKey)) {
        // ★ 私聊的鲸鱼**只在被明确命令时才出门**（「让它去旅行」），永不自动出发。
        //   群聊是「大家养的宠物」，自己出门才有惊喜感；
        //   私聊是「你自己的一个人」，未经同意就往你这儿推消息是打扰。
        //   把 nextDepartAt 归零，settleTrip 回来后也不会把它重新排上。
        state.nextDepartAt = 0;
      } else if (E.shouldAutoDepart(state, now)) {
        // ★★ 2026-10-15：**领头发车检查** —— 领头那位（`state.companion`）若正自己跑出去玩
        //   （在 `sideTrips` 里），这趟**先不走**，顺延 2 小时再看。
        //   为什么必须挡：`pickPartyIds()` 是**无条件取领头**的，而"谁在外面"有两套账
        //   （`state.trip` / `sideTrips`）—— 不挡就会出现**同一个旅伴同时出现在两趟旅行里**。
        //   为什么顺延而**不是**"换个人带"：`state.companion` 是 live（面板/注入都读它），
        //   临时换人 ⇒ live 与实际同行的那位当场打架（正是 `appointCompanion` 要躲的那个坑）。
        //   为什么这一天会出现：换了旅伴之后那位本来就在外面玩（换人是**当场**落定的，见上面）。
        const leadSide = awaySideTripOf(state, state?.companion?.id);
        // ★ 2026-10-14 扩容后同行可能不止一位 ⇒ 口粮按**这趟实际会带的人**算（与 depart 同一口径）
        const tier = bestFoodTier(state, foodNeedOf(state, partyOf(state)));   // ★ 含电饭煲减免
        if (leadSide) {
          // ⚠️ 必须留痕（通则：任何等待态都要说得出"在等什么"）——否则现象就是"她怎么还不出门"
          log(`[travel-whale] ${chatKey} 到了出发时间，但同伴「${companionOf(state)?.name || state?.companion?.id}」`
            + `自己那趟（${String(leadSide.city || '')}）还没回来 ⇒ 这趟顺延到 ${new Date(now + 2 * 3600 * 1000).toLocaleString('zh-CN', { hour12: false })}`);
          state.nextDepartAt = now + 2 * 3600 * 1000;
          dirty = true;
        } else if (tier) {
          // ★★ 2026-10-23（A+B）：时间到了 → **先问她**。想走才走，不想走就往后排。
          //   `verdict.go === false` 时 `nextDepartAt` 已经在这里设好，下面 `r.ok` 为假、
          //   不会再触发任何出行侧副作用（原代码 `if (r.ok)` 之后没有 else 分支）。
          const verdict = await considerDepart(target, state, deps, settings, tier);
          if (!verdict.go) {
            state.nextDepartAt = now + (Number(verdict.retryInMs) || 6 * 3600 * 1000);
            dirty = true;
            log(`[travel-whale] ${chatKey} 出门顺延到 `
              + `${new Date(state.nextDepartAt).toLocaleString('zh-CN', { hour12: false })}`
              + `${verdict.reason ? `（她的理由：${verdict.reason}）` : ''}`);
          }
          const r = verdict.go
            ? await depart(target, state, tier,
              verdict.region ? { ...deps, region: verdict.region } : deps)
            : { ok: false, declined: true };
          if (r.ok) {
            // ★ 2026-10-16 修（真 bug）：这一段原先**直接用 `comp`，而它在本作用域从未声明**
            //   —— `const comp = …` 只存在于手动 `whale_go` 那条路里（见本文件 5139 附近）。
            //   后果：走「自动出发」必抛 `ReferenceError: comp is not defined`；异常被 tick 末尾
            //   的 per-chatKey catch（本文件 3629）接住，而落盘 `S.saveState(state)` 在它**后面**
            //   （3624）⇒ `depart()` 的内存改动（扣口粮 / 扣 TOKEN / `state.trip` / `stats.trips`）
            //   **整轮被丢弃** = 自动出发事实上不生效，且此后每 60 秒重复刷一行错误。
            //   ⚠️ 手动 `whale_go` **不受影响**（那条路自己声明了 comp）。
            //   ⚠️ `${comp?.name}` 也救不了：可选链对「未声明的标识符」照样抛 ReferenceError。
            const comp = companionOf(state);
            // 穿越时用模型即兴演的那段替换掉固定播报（兜底台词在 buildCrossOverLine 里）
            // ★ 2026-10-21：出门播报 ＝ journey（按投递名单扇出）
            await say(target, (r.plan.crossedOver
              ? r.plan.crossOverLine
              : (comp
                ? `🐋 我和${comp.name}一起出门啦 —— 这趟去 ${placeLabel(r.plan)}`
                : `🐋 我出门啦 —— 这趟去 ${placeLabel(r.plan)}`))
              + (Number(r.plan.departCost) > 0
                ? `\n💸 ${comp?.name || '小书虫'}说这趟得先付 ${Number(r.plan.departCost)} 亿 TOKEN`
                  + `（余额 ${Number(state.wallet?.plankton) || 0} 亿）`
                : ''), { kind: 'journey' });
            dirty = true;
          }
        } else {
          // 没口粮就别反复判定，挪到 2 小时后再看
          state.nextDepartAt = now + 2 * 3600 * 1000;
          dirty = true;
        }
      }

      // ★★ 闲置伙伴「自己去玩」—— 与鲸鱼那趟**互相独立**：鲸鱼在途时，留在家的伙伴照样能出门。
      //   ⚠️ 这一段必须放在鲸鱼的 if/else 链**之外**（是并列关系，不是 else 分支）。
      // ★★ 2026-10-14 多趟化：`sideTrips` 是**数组** ⇒ 先逐趟推进/结算，再判断"还能不能再派一趟"。
      //   ⚠️ 别写回 `if (state.sideTrip) {…} else if (…) {…}` —— 那个 `else` 就是
      //      "一趟没回来就不会有第二趟"的老行为。能派几趟由下面的闲置人数自然决定。
      const hadLegacySide = Boolean(state.sideTrip);
      const sideTrips = normalizeSideTrips(state);
      if (hadLegacySide) dirty = true;   // 老字段迁移本身要落盘一次（否则每轮都要重迁一遍）
      for (const party of [...sideTrips]) {
        const advS = E.planAdvance({ trip: party }, now);
        if (advS.cards.length) {
          await sendCard(target, state, advS.cards[0].index, deps, party);
          dirty = true;
        }
        if (advS.returned) {
          // 整趟都在夜里、一张没寄的补寄（与鲸鱼那边同款口径）
          const sentNow = Number(party?.cardsSent) || 0;
          const cards = party?.cardTimes || [];
          if (sentNow === 0 && cards.length) await sendCard(target, state, cards.length - 1, deps, party);
          await settleSideTrip(target, state, party, deps);
          dirty = true;
          // 结算时这一趟已从 `sideTrips` 摘掉（`settleSideTrip` 里 splice）——
          // 遍历用的是快照，所以循环安全；下面的闲置计算也是结算后的口径。
        }
      }
      if (!state.test && !isPrivateChat(chatKey)) {
        // 触发条件（用户口径，缺一不可）：
        //   ① 有**两位及以上**"已拥有但没被鲸鱼带着"的伙伴；
        //   ② 背包里有某一档米饭 **≥ 6 份**（走完拿 2 份）；
        //   ③ 不是夜里、且冷却（sideNextAt）到了。
        // ★ 2026-10-13 加一道防线：把"此刻已经在别趟旅行里"的人**排除**出闲置池。
        //   理由与实现见模块级 `busyCompanionIds()`。
        const busyNow = busyCompanionIds(state);
        const idle = ((typeof S.idleCompanions === 'function') ? S.idleCompanions(state) : [])
          .filter((c) => c && !busyNow.has(String(c.id)));
        const partyNeed = Number(S.SIDE_TRIP?.partySize) || 2;
        if (idle.length >= partyNeed) {
          const tier = sideTripTier(state);
          const due = Number(state.sideNextAt || 0);
          if (!due) {
            // 还没排过（新档 / 老档升级上来）⇒ 先隔一会儿再看，别一上来就冲出去
            // 还没排过（新档 / 老档升级上来）⇒ 先隔一段时间再看，别一上来就冲出去。
            // ★ 2026-10-13：这里原来写死 1 小时 —— 新档养上不到一小时就"自己跑出去玩"，
            //   与「家要有存在感」相反。改成跟休息区间同一个下界（默认 24 小时）。
            state.sideNextAt = now + (restRange().minMs || Number(S.SIDE_TRIP?.firstDelayMs) || 24 * 3600 * 1000);
            dirty = true;
          } else if (tier && !E.isNight(now) && now >= due) {
            // [[side-wish]] 申请优先：她闲着、但没被随机选中，就换进这一趟（只影响选谁）
            // ★★ 2026-10-23（C）：读到申请 ≠ 直接放行 —— **先问她一句**。
            //   同意 → 照旧把它排进这一趟；不同意 → 回执写**她的原话**，不是机制的"粮不够"。
            let wish = (settings && settings.sideWishEnabled === false) ? null : readSideWish(target);
            if (wish) {
              const v = await judgeSideWish(target, state, wish, deps, settings || {});
              if (!v.allow) {
                try { ackSideWishRejected(wish, [v.reason || '这次先不出门']); } catch { /* 回执失败不影响 */ }
                try { clearSideWish(); } catch { /* ignore */ }
                wish = null;
              }
            }
            const party = pickSideParty(idle, deps.rand);
            if (wish && party.length) {
              const wid = String(wish.partner || '');
              const picked = party.some((c) => String(c && c.id) === wid);
              const cand = idle.find((c) => String(c && c.id) === wid);
              if (!picked && cand) party[party.length - 1] = cand;
            }
            const rs = await departSideTrip(target, state, tier, party, deps);
            if (rs.ok) {
              ackSideWishDispatched(wish, rs.plan);
              const who = party.map((c) => c.name).join('和');
              // ★ 2026-10-21：伙伴自己出门**也是出门播报** ⇒ journey（按投递名单扇出）
              await say(target, rs.plan.crossedOver
                ? rs.plan.crossOverLine
                : `🐾 ${who}自己跑出去玩了 —— 这趟去 ${placeLabel(rs.plan)}`, { kind: 'journey' });
              dirty = true;
              // ★★ 多趟化：派完这一趟，把"派下一趟"的闸往后推一点（默认 30 分钟）。
              //   否则若还有闲置（5 位全在 ⇒ 两趟），下一轮 tick 会**立刻**再派，
              //   两拨人同一分钟出门、两条播报连发。推半小时 = 前后脚出门，仍是"同时在路上"。
              //   ⚠️ 别再叠加 `restRange().minMs` —— 那是"回家后休息多久"，语义完全不同。
              //   ⚠️ 结算时 `settleSideTrip` 会把它重设成 `nextDepartAt()`（休息 24~48h），
              //     所以"刚回来的两位不会再被立刻派出去"这条老口径仍然成立。
              state.sideNextAt = now + (Number(S.SIDE_TRIP?.partyGapMs) || 30 * 60 * 1000);
            } else {
              state.sideNextAt = now + 2 * 3600 * 1000;   // 出不去就晚点再看
              dirty = true;
            }
          }
        }

        // ★★ v3.7：**到点了却没出门 ⇒ 把原因落盘**（`state.sideWait`）。
        //
        //   为什么需要它（2026-10-14 用户报"伙伴状态卡住了"）：
        //   `idle.length < partyNeed` 时**上面整段被跳过** ⇒ `sideNextAt` 会一直**冻结在过去**，
        //   而"查旅行状态"那个脚本只能说一句「（等宿主结算）」—— 用户第一反应必然是"坏了"。
        //   实测那天是**两个条件同时不满足**：口粮 4/6 ＋ 闲置只剩 1 位（另两位在外面玩），
        //   于是闸停在 15:00 一个多小时没动。行为其实没错（条件一满足就会立刻出发），
        //   错的是**没有任何地方说得出"在等什么"**。
        //   ⚠️ **只在内容变化时写盘** —— 否则每轮 tick 都 dirty，等于一分钟写一次存档。
        const stillDue = Number(state.sideNextAt || 0);
        if (stillDue && now >= stillDue) {
          const why = [];
          const nb = busyCompanionIds(state);
          const ni = ((typeof S.idleCompanions === 'function') ? S.idleCompanions(state) : [])
            .filter((c) => c && !nb.has(String(c.id)));
          const needN = Number(S.SIDE_TRIP?.partySize) || 2;
          if (ni.length < needN) {
            const outNames = [...nb].map((id) => (S.COMPANIONS?.[id] || {}).name || id).join('、');
            why.push(`闲着的伙伴只有 ${ni.length} 位（一趟要 ${needN} 位）`
              + (outNames ? `，不在家的有 ${outNames}` : ''));
          }
          if (!sideTripTier(state)) {
            const floor = Number(S.SIDE_TRIP?.foodFloor) || 6;
            const best = Object.values(state?.bag?.food || {}).map((x) => Number(x) || 0)
              .sort((a, b) => b - a)[0] || 0;
            why.push(`口粮不够（最多的一档只有 ${best} 份，要 ${floor} 份）`);
          }
          if (E.isNight(now)) why.push('现在是夜里（不夜里出门）');
          const sig = why.join('｜');
          // [[side-wish]] 到点了却出不去 ⇒ 驳回这份申请，并把理由写给对面
          if (why.length && settings && settings.sideWishEnabled !== false) {
            try {
              const w2 = readSideWish(target);
              if (w2) ackSideWishRejected(w2, why);
            } catch { /* ignore */ }
          }
          if (why.length) {
            if (state.sideWait?.sig !== sig) {
              state.sideWait = { at: now, due: stillDue, why, sig };
              dirty = true;
            }
          } else if (state.sideWait) {
            state.sideWait = null;   // 条件都够了 ⇒ 清掉（理论上紧接着就该出发）
            dirty = true;
          }
        }
      }

      // ★★ 说好的"换旅伴"落定（2026-10-13 用户口径：「等都回家之后**立刻**换成对应的伙伴」）。
      //   位置必须在上面两段之后 —— 这一 tick 里刚到家的话，`trip` 已被 `settleTrip` 清空，
      //   所以"先回家、再换人"是同一次 tick 内完成的，不用等下一轮。
      //   ⚠️ 夜里到家那段也一样成立：`settleTrip` 把到家卡压进 `state.pending`，
      //     但 `trip` 已经清了 ⇒ 这里照换，且**不影响**那张已入队的到家卡
      //     （它自带出发时的快照，画的还是这趟真正同行的那位）。
      //
      //   ★★ 2026-10-15 修正（**分两次**）：原来还要求 `!sideTripsOf(state).length`
      //     （**所有**趟都结束）⇒ "别的旅伴在外面玩"会把换人无限期卡住（实测卡 22 小时到次日 11:29）。
      //     ⇒ 现在只等**具体两个人**：① 她自己到家（`!state.trip`）；
      //       ② **要换的那位**也到家（不在任何 `sideTrips` 里）。
      //       用户原话："不可能换，因为小折扇刚跑出去了" —— 换人的前提就是那位在家。
      const pendTargetAway = state.pendingCompanion
        ? awaySideTripOf(state, state.pendingCompanion.id) : null;
      if (state.pendingCompanion && !state.trip && !pendTargetAway) {
        const pc = pendingCompanionOf(state);
        if (pc) {
          state.companion = { id: pc.id, at: Number(state.pendingCompanion.at) || now };
          log(`[travel-whale] ${chatKey} 都到家了 ⇒ 同行伙伴换成「${pc.name}」`);
        } else {
          log(`[travel-whale] ${chatKey} pendingCompanion 指向未知伙伴，丢弃`);
        }
        state.pendingCompanion = null;
        dirty = true;
      }

      // ★★ 在家的大合照（2026-10-13 step4）：回到家 + 在家待满 N 小时（默认 8）+ 这一趟还没拍过
      //   ⇒ 拍 1 张**横板**合照。判据全在 `HM.shouldShootHome()`（纯函数，可离线验），
      //   这里只负责"真去拍"。⚠️ 位置在换旅伴落定**之后** —— 让"说好要换的那位"先落定，
      //   再决定合照里有谁（两件事同一次 tick 内完成，口径一致）。
      if (!state.test) {
        // ★ 2026-10-13 照片墙：门槛 8h → 6h（0 = 关闭仍保持关闭）
        if (HM.shouldShootHome({
          state, now,
          hours: homeShotHoursOf(state, cfg().homeShotHours),
          night: E.isNight(now)
        })) {
          try {
            await shootHomeGroup(target, state, deps);
          } catch (error) {
            log('[travel-whale] 庭院大合照失败：' + (error?.message ?? error));
            // ⚠️ 失败也必须打标记，否则每个 tick 都重试一次（生图一挂就是刷屏）
            state.homeShotAt = now;
          }
          dirty = true;
        }
      }

      // ★★ 2026-10-14 菜地（种菜）：按时间推进，**每长一档播一条**。
      //   这就是用户要的"反馈感" —— 一次收成 = 四天里四条播报 + 最后一份实收，
      //   而不是"种下去、三天后突然冒出来"。播报只发本地（菜地是家里的事，与明信片那种"投递"不同）。
      if (!state.test) {
        const grown = farmTick(state, now);
        for (const g of grown) {
          await say(target, `🌱 ${g.line}`, LOCAL_ONLY);
          dirty = true;
        }
      }

      // ★★ 2026-10-13：刷新"此刻她在庭院里做什么"（20 分钟一挡，幂等）。
      //   放在这里 = 所有"在途/到家"的处理**之后** ⇒ 刚到家那一次就能算出正确的活动。
      if (!state.test && refreshHomeAct(state, now)) dirty = true;

      // ★★ 2026-10-13 旅伴「特色」：小狐狸的「免费鸡蛋」—— 每天往钱包发 500 亿 TOKEN。
      //   用户口径：**在不在家都发**（她当天出门也照发）。一天只发一次（键＝本地日期）。
      if (!state.test) {
        const got = dueStipend(state, now);
        if (got > 0) {
          S.grantPlankton(state, got);
          await say(target, `🥚 今天的免费鸡蛋到账：+${got} 亿 TOKEN`
            + `（${stipendPayers(state).map((d) => d.name).join('和') || '小狐狸'}请客，余额 ${Number(state.wallet?.plankton) || 0} 亿）`);
          dirty = true;
        }
      }

      if (dirty) { S.saveState(state); notifyUI(target); }

      // ★★ v3.18 ②：她自己花钱。
      //   位置刻意放在**落盘之后**：`whale_buy` 走 `S.mutate`（load→改→save），
      //   如果先花再保存，本 tick 手里这份旧 state 会把刚买的东西写没。
      // 只在**人在庭院**（不在旅途）且是白天时做 —— 需求是"回到矩阵庭院后"才谈花钱
      if (!state.trip && !E.isNight(now)) {
        try {
          // ★ v3.18.2：先自理（收菜/补种/补口粮），再邀旅伴，最后才谈花钱。
          //   顺序有讲究：自理可能动钱包（补口粮），所以花钱之前**重读一次存档**。
          await autoTend(target, state, deps, settings);
          const invited = await autoInvite(target, state, settings);
          if (invited) await say(target, invited);
          const fresh = S.loadState(target);
          const said = await autoSpend(target, fresh, deps, settings);
          if (said) await say(target, said);
        } catch (error) {
          log(`[travel-whale] 自动化出错：${error?.message ?? error}`);
        }
      }

      // ★ 与「世界与事件」(life-system) 的联动：让她知道"自己旅行到的世界是什么样"。
      //   放在落盘之后 —— 世界同步是**幂等**旁路，绝不该影响旅行本身的存档。
      syncWorldbook(state);
    } catch (error) {
      log(`[travel-whale] tick 处理 ${chatKey} 出错：${error?.message ?? error}`);
    }
  }
  } finally {
    G[TICK_RUNNING] = false;    // 成功失败都要解锁，否则一次异常就永久停摆
  }
}

export function startTicker() {
  // ★ 总是**先踢掉旧的再建**（而不是 `if (timer) return`）：
  //   热重载后"活着的那个 ticker"可能属于**已退役的旧模块实例**，新实例看不到它的句柄；
  //   只有"以全局句柄为准、让最后一个 setup 的实例接管"，才能保证进程内始终只有 1 个。
  const replaced = killTicker();
  const ms = Math.max(15000, Number(cfg().tickMs) || 60000);
  const interval = everyTimer('travel-whale/tick', ms, () => { tick().catch((e) => log(`[travel-whale] tick 异常：${e?.message ?? e}`)); });
  interval.unref?.();
  const first = setTimeout(() => { tick().catch(() => {}); }, 8000);
  first.unref?.();
  G[TICKER_SLOT] = { interval, first };
  RT.timer = interval;             // 兼容保留；权威句柄是 G[TICKER_SLOT]
  log(`[travel-whale] 后台推进已启动：每 ${Math.round(ms / 1000)} 秒一次`
    + (replaced ? '（已接管上一轮的 ticker）' : ''));
}

