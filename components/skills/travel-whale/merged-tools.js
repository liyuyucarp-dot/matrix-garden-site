// 合并入口（2026-10-16）：把 23 个 `whale_*` 工具收成 5 个带 `action` 的分发工具。
//
// ★ 只改"模型怎么喊"，**不改玩法**：每个 action 原样转交给它自己那份 execute，
//   引擎/存档/进度一律不动。旧定义被 `index.js` 的收集器拦下、不进注册表。
// ★ 描述只留"什么时候用 + 这个 action 要传什么"，把原来 4,695 字符的工具说明压到 ~700。
export const MERGED = [
  {
    id: 'travel-whale__whale_status', name: '看庭院', icon: '🐋', category: 'query',
    description: '查看庭院（用 action 选一样，一次只做一件事）：'
      + 'status=看面板（在哪/余额/背包/设施等级。⚠️整页会直接发群，别"顺手看一眼"）；'
      // ★ 2026-10-21 纠正：原话写"page=第几趟"，反了 —— page 是页码、趟次是 trip。
      + 'album=相册（**page=第几页**、trip=第几趟、place=地名直达、index=true 出目录、no=第几张）；'
      + 'titles=称号；pantry=仓库/存粮；card=图鉴（count=看几条）；'
      + 'wardrobe=衣橱；help=说明图（**menu=garden 看庭院设施菜单**、skill 技能、shop 商店…；text=true 要文字版）；'
      + 'quick_test=自检。'
      // ★ 同上：把"只查不建"写在明面上，免得模型拿"看面板"当"能建造"。
      + '⚠️ 这里**只查不建**：真要建造/升级设施，走「商店」的 buy。'
  },
  {
    id: 'travel-whale__whale_go', name: '出门与旅伴', icon: '✈️', category: 'utility',
    description: '出门与旅伴（用 action 选）：'
      + 'go=让她出门旅行（food=normal/large 口粮档；**city / country 只在群友明确点了地名时才填**）；'
      // ★★ 2026-10-16（用户报"概率调成 1 也不穿越"）：**这一句必须写在这儿** ——
      //   工具合并之后模型看到的是**这份**说明（旧 `whale_go` 定义已被收集、不进注册表）。
      //   实查：群友说"你想去哪就去哪"，模型自己往 `city` 里填了座城 ⇒ 命中"点名不参与穿越"
      //   的设计 ⇒ **手动出门那条路永远不会穿越**（只有自动出行会）。
      + '⚠️ **别替她定目的地**：群友只说"出门吧 / 去玩吧 / 你想去哪就去哪 / 带她散散心"这类'
      + '**没点地名**的话时，`city` 和 `country` **都留空** —— 留空她自己挑地方，'
      + '也才**有可能在路上穿越**（穿越只会发生在没有点名的那趟）；'
      + '群友**原话里明确点了地名**（"让她去杭州""去伊比利亚"）才填，那种趟她会一定去那儿、也不会穿越。'
      + 'companion=换旅伴（name=名字）；adopt=领养一位新旅伴；'
      + 'gift=让出门的人捎礼物（item=礼物，to=给谁）；express=用一张加急明信片（立刻寄）。'
  },
  {
    id: 'travel-whale__whale_life', name: '庭院生计', icon: '🌾', category: 'utility',
    description: '庭院里的营生（用 action 选）：'
      // ★★ 2026-10-21 修（玩家报"车间建好了却派不上工"）：这段原话只写"work=去打工赚 TOKEN"，
      //   模型以为是小鲸鱼自己去，而且不知道"安排谁"要传 `mate` ⇒ 反复空转。
      //   现在明写：work 是**安排旅伴上工**，谁上工用 `mate`，让她下班用 `op=stop`。
      + 'work=**把旅伴安排到「数据标注车间」上班**（mate=哪位旅伴，如"小狐狸"；'
      + '不传 mate = 只看车间现状；op=stop = 让她下班）；'
      + 'plant=种东西（item=种子/作物名）；reap=收成；'
      + 'harvest=收服务器里攒下的 TOKEN；eat=吃口粮（item=口粮名，by=谁请的）。'
      + '⚠️ 只能安排**在家**的旅伴（跟着出门的、自己跑出去玩的要等回来）；'
      + '⚠️ 一位最多连着干 24 小时，到点自己下班，想再上工得先带她出趟门。'
  },
  {
    id: 'travel-whale__whale_shop', name: '商店', icon: '🏪', category: 'utility',
    description: '商店与营造（用 action 选）：'
      + 'shop=看货架和价格；'
      + 'buy=买 / **建造 / 升级**（item=名字，count=份数）—— 它同时管四件事：'
      + '①买口粮护身符 ②**建造或升级庭院设施**（item 直接写设施名，如"观星台""檐廊""电饭煲""服务器阵列"）'
      + '③解锁装备 ④邀请旅伴。'
      // ★★ 2026-10-18 修（玩家报的 bug）：玩家说"建服务器阵列"，模型理解成"搭一台现实中的服务器"，
      //   回一句"我没有这个工具"就完了。根因是合并时把设施的说明漏了 —— 模型看到的
      //   `whale_shop` 只写着"买商品"，而"设施"两个字只出现在 `whale_status`（看面板）里。
      //   ⇒ 这里必须**明写**：建造设施走 buy，而且设施是**庭院里**的东西。
      + '⚠️ 群友说"建/盖/升级/造 某个设施"时**就是它** —— 这些是**庭院里的设施**（成就与 TOKEN 攒出来的），'
      + '不是现实里的机器，别答"做不到"。服务器阵列例外：它要的是**成就值**、不花 TOKEN。'
  },
  {
    id: 'travel-whale__whale_skill', name: '技能与打扮', icon: '🧠', category: 'utility',
    description: '技能与打扮（用 action 选）：skill=看/学技能；'
      + 'equip=用一件道具（name=道具名）；wear=给某位换衣服（girl=谁，outfit=衣服名；'
      + '**random=true = 随机换装**（每位各抽一套已解锁的）；'
      + '**也可以借穿旅伴的默认那身：outfit=「小狐狸的默认」（要先邀请过那位）**；'
      + '**outfit 传「默认」= 脱掉、换回原装那身**）。'
  }
];

// 合并工具共同声明的参数（并集；模型按 action 的需要传，多余的会被下层忽略）
const SHARED_PARAMS = {
  no: { type: ['integer', 'string'], description: 'album：第几张' },
  count: { type: ['integer', 'string'], description: 'card/buy：几条 / 几份' },
  item: { type: 'string', description: 'buy/plant/eat/gift：名字。buy 传商品名，**也可以传庭院设施名**（"观星台""服务器阵列"）来建造/升级' },
  city: { type: 'string', description: 'go：目的城市名。⚠️ **只在群友原话里点了地名时才填**（"让她去杭州"）；'
    + '"你想去哪就去哪 / 出门吧 / 去玩吧"这类**留空** —— 留空她自己挑，也才可能在路上穿越' },
  country: { type: 'string', description: 'go：目的地区/国家名（如"伊比利亚""西班牙"）。'
    + '⚠️ **只在群友原话里点了地名时才填**（没点名就留空 —— 留空才可能穿越；填了这趟就钉死在那个地区、也不会穿越）' },
  food: { type: 'string', description: 'go：口粮档 normal / large' },
  name: { type: 'string', description: 'companion/equip：名字' },
  // ★★ 2026-10-21 修（玩家报的 bug：车间建好了、旅伴也在家，却怎么都派不上工）
  //   根因：`whale_work` 的 execute 读的是 `args.mate`，而合并层的 SHARED_PARAMS 里**没有 `mate`**
  //   ⇒ 模型只能传 name/girl/item（schema 里就这几个），`want` 恒为空 ⇒ 每次都走"只查看"分支，
  //   回一句"（现在没人上工）"就完了。**凡是 legacy 工具 execute 读的字段，都必须在这里有同名字段。**
  mate: { type: 'string', description: 'work：安排**哪位旅伴**去上班（名字即可，如"小狐狸"）。'
    + '不传 = 只看车间现状（谁在上工、还能安排谁）' },
  op: { type: 'string', description: 'work：start=让她上工（默认）/ stop=让她下班。'
    + '⚠️ 只有 work 用得上；`action` 已经被"选哪件事"占用了，所以子动作走 `op`' },
  girl: { type: 'string', description: 'wear：给哪位旅伴换' },
  outfit: { type: 'string', description: 'wear：衣服名；传「默认」= 脱掉换回原装那身（不说 girl 就是全体）；传「<某人>的默认」（如「小狐狸的默认」）= 借穿那位的默认着装（free、随时可换回）' },
  // ★ 2026-10-21 同批补齐：album 的 page/place/trip/index、wear 的 random，原来**全都不在 schema 里** ——
  //   模型看得到 `album=相册` 却传不进"第几页/哪一趟"，只能每次都给第 1 页。
  page: { type: ['integer', 'string'], description: 'album：第几页（默认 1；整页约 12 张就翻页，一趟不会被拆到两页）' },
  place: { type: 'string', description: 'album：按**地名/景点**直达（"看庐山相册" → 直接翻到那趟所在的页）' },
  trip: { type: ['integer', 'string'], description: 'album：按**趟次**直达（第几趟）' },
  index: { type: ['boolean', 'string'], description: 'album：传 true = 出**旅行目录**（一张图列出每趟的目的地/日期/张数）' },
  random: { type: ['boolean', 'string'], description: 'wear：传 true = **随机换装**（每位少女各自从已解锁的里抽一套）' },
  to: { type: 'string', description: 'gift：送给谁' },
  by: { type: 'string', description: 'eat：谁请的' },
  menu: { type: 'string', description: 'help：想看哪一节' },
  text: { type: ['boolean', 'string'], description: 'help：**只在对方明确要求发文字时**才传 true（比如「别发图」「打成文字」）。看菜单类的东西（技能树 / 庭院设施 / 商店 / 衣柜）一律用 menu 出图；传了 menu 时 text 会被忽略' }
};

/**
 * 注册 5 个分发工具。
 * @param {object} o
 * @param {object} o.realApi 宿主给的 api
 * @param {Map<string, object>} o.legacy 被收集下来的旧定义（action → def）
 * @param {(def: object) => object} o.guard 与旧工具同款的 guardHomeOnly
 */
export function registerMergedTools({ realApi, legacy, guard }) {
  const missing = [];
  for (const t of MERGED) {
    const actionNames = t.actions || null;
    realApi.registerTool(guard({
      id: t.id,
      name: t.name,
      category: t.category,
      icon: t.icon,
      description: t.description,
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', description: '要做哪件事（见工具说明）' }, ...SHARED_PARAMS },
        required: ['action'],
        additionalProperties: true
      },
      async execute(ctx, args) {
        const action = String(args?.action ?? '').trim();
        const def = legacy.get(action);
        if (!def || typeof def.execute !== 'function') {
          const usable = [...legacy.keys()].sort().join(' / ');
          return {
            content: `action「${action}」不认识。这个工具能做的：${usable}（一次只能选一个）。`,
            isError: true
          };
        }
        const rest = { ...(args || {}) };
        delete rest.action;
        // ★★ 2026-10-21：`action` 这一格被"选哪件事"占死了（work / go / buy…），
        //   而 `whale_work` 自己的 execute 又要用 `action` 判 start / stop。
        //   ⇒ 子动作统一走 `op`，分发时再交还成 `action`。
        //   不这么做的话"让她下班"永远执行不到（op 会被当成未知字段忽略）。
        if (rest.op != null && rest.op !== '') {
          rest.action = rest.op;
          delete rest.op;
        }
        return def.execute(ctx, rest);
      }
    }));
  }
  // 覆盖自检：23 个旧工具里若有没收进来的，明确报出来（别静默丢功能）
  const EXPECTED = ['status', 'album', 'titles', 'pantry', 'card', 'wardrobe', 'help', 'quick_test',
    'go', 'companion', 'adopt', 'gift', 'express',
    'work', 'plant', 'reap', 'harvest', 'eat',
    'shop', 'buy', 'skill', 'equip', 'wear'];
  for (const a of EXPECTED) if (!legacy.has(a)) missing.push(a);
  return { merged: MERGED.length, actions: legacy.size, missing };
}
