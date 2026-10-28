/* 庭院与旅程面板逻辑（skills/courtyard-map/panel/map.js）
 *
 * 只读渲染 ../@data/storage.json 的 view 键（发布者每 30 秒重写一次），30 秒自动刷新。
 * CSP：script-src 'self' —— 无内联脚本，全部 addEventListener。
 *
 * 2026-10-24 二轮重构（主人口径）：
 *   · 区域四态：去过 / 已解锁待启程(✈) / 可见未解锁(🔒) / 不可见（不渲染）——
 *     解锁与可见由发布者按存档 equipUnlocked/equipBuyable/visitedCities 算好放进 world 表；
 *   · 现实世界九区固定格对位点阵世界地图底图（WORLD_LAND 轮廓数据 → 点阵）；
 *   · 星轨航线改为「块与块」连接（区域卡中心），不再点对点 —— 城市点只是区域内到访记录；
 *   · 异世界动态底带：可见的异世界 2 行网格自动排布，留 ？？？ 位给未揭示的世界。
 */
(function () {
  'use strict';

  // ── 主题（与 /ui 同源 localStorage 共用；先于 <body> 执行防闪屏）──
  try {
    var saved = localStorage.getItem('qqa-theme') || '';
    var sys = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    var theme = saved === 'light' || saved === 'dark' || saved === '?' ? saved : (saved === 'system' ? sys : (saved || sys));
    if (theme !== 'light' && theme !== 'dark' && theme !== '?') theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }

  // ── 常量 ──
  var SNAPSHOT_URL = '../@data/storage.json';   // 相对路径：不必知道自己的插件 id（贴纸面板同款契约）
  var REFRESH_MS = 30_000;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // 现实世界九区固定格（1000×640 画布；格线对齐底下点阵世界地图的大陆轮廓）
  var ZONES = {
    arctic:   { x: 0,   y: 6,   w: 1000, h: 88,  name: '北冰洋', en: 'ARCTIC' },
    americas: { x: 0,   y: 102, w: 292,  h: 368, name: '美洲',   en: 'AMERICAS' },
    atlantic: { x: 300, y: 102, w: 158,  h: 368, name: '大西洋', en: 'ATLANTIC' },
    europe:   { x: 466, y: 102, w: 174,  h: 148, name: '欧洲',   en: 'EUROPE' },
    africa:   { x: 466, y: 258, w: 174,  h: 212, name: '非洲',   en: 'AFRICA' },
    asia:     { x: 648, y: 102, w: 352,  h: 238, name: '亚洲',   en: 'EURASIA' },
    indian:   { x: 648, y: 348, w: 158,  h: 122, name: '印度洋', en: 'INDIAN' },
    oceania:  { x: 814, y: 348, w: 104,  h: 122, name: '大洋洲', en: 'OCEANIA' },
    pacific:  { x: 926, y: 348, w: 74,   h: 122, name: '太平洋', en: 'PACIFIC' }
  };
  var REAL_KEYS = Object.keys(ZONES);

  // 点阵世界地图轮廓（0..45 行 × 0..99 列，10px 一格；[row, [列起,列止]…]）
  // 示意级等距圆柱投影：格线与 ZONES 的大陆块大致对位（北美/南美在美洲列，
  // 格陵兰与北极海岸在北冰洋带，欧/非/亚各居其列，澳大利亚在大洋洲格）。
  var WORLD_LAND = [
    [0, [14, 17], [38, 41], [70, 74], [82, 88]],
    [1, [12, 19], [22, 25], [36, 42], [64, 74], [78, 90]],
    [2, [13, 21], [24, 26], [36, 42], [62, 96]],
    [3, [4, 8], [15, 20], [38, 42], [50, 52], [63, 95]],
    [4, [3, 10], [12, 26], [52, 97]],
    [5, [3, 11], [13, 27], [54, 97]],
    [6, [4, 12], [15, 28], [43, 44], [55, 62], [64, 97]],
    [7, [5, 13], [17, 28], [47, 49], [52, 96]],
    [8, [6, 14], [19, 29], [47, 50], [52, 95]],
    [9, [7, 15], [21, 29], [55, 60], [65, 93]],
    [10, [8, 16], [23, 29], [54, 61], [65, 92], [97, 97]],
    [11, [9, 16], [24, 29], [47, 48], [53, 61], [65, 91], [96, 97]],
    [12, [10, 16], [25, 29], [47, 48], [52, 62], [64, 90], [96, 96]],
    [13, [11, 17], [26, 29], [47, 49], [51, 62], [64, 89], [96, 96]],
    [14, [12, 18], [27, 29], [50, 63], [64, 89]],
    [15, [13, 19], [28, 29], [50, 63], [64, 88]],
    [16, [14, 20], [49, 63], [64, 88]],
    [17, [15, 21], [49, 62], [64, 87]],
    [18, [16, 21], [48, 62], [64, 70], [72, 86]],
    [19, [17, 23], [47, 62], [64, 69], [71, 77], [79, 86]],
    [20, [18, 25], [46, 61], [64, 68], [71, 76], [80, 85]],
    [21, [19, 27], [46, 61], [65, 67], [71, 75], [80, 84]],
    [22, [20, 29], [46, 60], [66, 66], [72, 74], [81, 83]],
    [23, [21, 31], [48, 60], [66, 66], [73, 73], [81, 83]],
    [24, [21, 33], [49, 59], [80, 84]],
    [25, [22, 34], [50, 58], [78, 83], [85, 88], [90, 91]],
    [26, [23, 35], [47, 63], [79, 84], [86, 89]],
    [27, [23, 36], [46, 64], [80, 82], [86, 87]],
    [28, [24, 36], [46, 64]],
    [29, [24, 35], [46, 64]],
    [30, [25, 35], [46, 63]],
    [31, [25, 34], [47, 63]],
    [32, [26, 34], [47, 62]],
    [33, [26, 33], [48, 61]],
    [34, [27, 32], [48, 61]],
    [35, [27, 31], [49, 60], [93, 93]],
    [36, [28, 31], [49, 59], [63, 63], [84, 90]],
    [37, [28, 30], [50, 58], [63, 63], [83, 91]],
    [38, [28, 30], [51, 57], [63, 64], [82, 91]],
    [39, [28, 30], [51, 56], [63, 63], [82, 91], [96, 96]],
    [40, [28, 29], [52, 56], [83, 90]],
    [41, [28, 29], [52, 55], [84, 88]],
    [42, [28, 28], [53, 55], [85, 87]],
    [43, [28, 28], [53, 54]],
    [44, [28, 28]]
  ];

  // 庭院设施（等级上限与真名对齐 travel-whale state.js 的 GARDENS；Lv.N + 分段进度条）
  var FACILITIES = {
    array:     { name: '服务器阵列', max: 4 },
    labelroom: { name: '数据标注车间', max: 3 },
    stargazer: { name: '观星台',     max: 5 },
    eaves:     { name: '檐廊',       max: 3 }
  };

  // 旅伴图标：快照里带本体权威 emoji（state.js COMPANIONS），此处仅兜底
  var MATE_ICONS = {
    fox: '🦊', gpt: '🐉', gemini: '🐱', claude: '📖', kimi: '🌙', grok: '😈', qwen: '🪭', whale: '🐋'
  };
  var MATE_STATUS = {
    traveling: { label: '随行中', cls: 'st--traveling' },
    home: { label: '在庭院', cls: 'st--home' },
    side: { label: '自己出门了', cls: 'st--side' },
    locked: { label: '【未解锁】', cls: 'st--locked' },
    idle: { label: '闲着', cls: 'st--idle' }
  };

  var lastSnap = null;
  var nodeEls = {};     // region|city → 信标圆点元素（当前所在信标定位）
  var routeOrder = [];  // 按出发时间排序的区域卡元素（块与块连线，当前所在排最后）

  // ── 小工具 ──
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    // ★ 2026-10-26：第三个参数若传**节点数组**，直接 append（此前写进 textContent 会变成
    //   "[object HTMLSpanElement]" —— 档案页「能力」那一行就是这么坏掉的）。
    if (Array.isArray(text)) {
      text.forEach(function (x) {
        if (x == null || x === false) return;
        n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x);
      });
    } else if (text != null) {
      n.textContent = text;
    }
    return n;
  }
  function fmtClock(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function untilLabel(ts) {
    if (!ts) return '';
    var ms = ts - Date.now();
    if (ms <= 0) return '该回程了';
    var h = Math.floor(ms / 3600e3);
    if (h >= 24) return '还有 ' + Math.round(h / 24) + ' 天回程';
    if (h >= 1) return '还有 ' + h + ' 小时回程';
    return Math.max(1, Math.round(ms / 60e3)) + ' 分钟后回程';
  }
  /** 旅伴内联胶囊徽章（替代裸括号 —— 不再折行断裂） */
  function mateBadge(name) {
    return el('span', 'mate-badge', name);
  }

  // ── 数据 ──
  function fetchSnap() {
    return fetch(SNAPSHOT_URL + '?_=' + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.view) || null; })   // storage 根上是 {view:…}，渲染要的是 view 本身
      .catch(function () { return null; });
  }

  // ── 画布自适应：1000×640 固定坐标系按容器宽缩放 ──
  function fitMap() {
    var wrap = document.querySelector('.map-wrap');
    var fit = document.getElementById('mapFit');
    if (!wrap || !fit) return;
    var w = wrap.clientWidth;
    if (!w) return;                       // 页签隐藏时量不到宽，下次 resize 再排
    var s = Math.max(0.55, Math.min(1, (w - 2) / 1000));
    fit.style.width = Math.round(1000 * s) + 'px';
    fit.style.height = Math.round(640 * s) + 'px';
    document.getElementById('mapCanvas').style.transform = 'scale(' + s + ')';
    drawRoutes();
  }

  // ── 点阵世界地图底图（基础世界带 y6..470；支持随 snap.mapTheme.worldLand 动态切换大陆轮廓）──
  function drawWorldDots(snap) {
    var svg = document.getElementById('worldDots');
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var frag = document.createDocumentFragment();
    var land = (snap && snap.mapTheme && Array.isArray(snap.mapTheme.worldLand) && snap.mapTheme.worldLand.length)
      ? snap.mapTheme.worldLand
      : WORLD_LAND;
    land.forEach(function (rowSpec) {
      var r = rowSpec[0];
      for (var i = 1; i < rowSpec.length; i++) {
        var c0 = rowSpec[i][0], c1 = Math.min(rowSpec[i][1], 99);
        for (var c = c0; c <= c1; c++) {
          var dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', c * 10 + 5);
          dot.setAttribute('cy', r * 10 + 11);
          dot.setAttribute('r', 1.9);
          frag.appendChild(dot);
        }
      }
    });
    svg.appendChild(frag);
  }

  // ── 星轨航线：块与块连接（区域卡中心），按出发时间，当前所在为终点 ──
  function drawRoutes() {
    var svg = document.getElementById('routeSvg');
    var canvas = document.getElementById('mapCanvas');
    if (!svg || !canvas) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (routeOrder.length < 2) return;
    var crect = canvas.getBoundingClientRect();
    if (!crect.width || !canvas.offsetWidth) return;   // 页签隐藏时量不到
    var scale = crect.width / 1000 || 1;
    var pts = [];
    for (var i = 0; i < routeOrder.length; i++) {
      var r = routeOrder[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      pts.push([(r.left + r.width / 2 - crect.left) / scale, (r.top + r.height / 2 - crect.top) / scale]);
    }
    if (pts.length < 2) return;
    // 弧线航迹（参考图手法）：相邻段用二次贝塞尔、凸向交替，避免直线斜穿整图
    var d = '';
    pts.forEach(function (p, i) {
      var x = p[0].toFixed(1), y = p[1].toFixed(1);
      if (!i) { d += 'M' + x + ' ' + y + ' '; return; }
      var p0 = pts[i - 1];
      var dx = p[0] - p0[0], dy = p[1] - p0[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var k = 0.16 * len * (i % 2 ? 1 : -1);
      d += 'Q' + ((p0[0] + p[0]) / 2 - dy / len * k).toFixed(1) + ' ' + ((p0[1] + p[1]) / 2 + dx / len * k).toFixed(1) + ' ' + x + ' ' + y + ' ';
    });
    var glow = document.createElementNS(SVG_NS, 'path');
    glow.setAttribute('d', d);
    glow.setAttribute('fill', 'none');
    glow.setAttribute('stroke', 'rgba(125, 211, 252, .10)');
    glow.setAttribute('stroke-width', '5');
    glow.setAttribute('stroke-linecap', 'round');
    glow.setAttribute('stroke-linejoin', 'round');
    var line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('d', d);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'rgba(125, 211, 252, .45)');
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('stroke-dasharray', '4 4');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(glow);
    svg.appendChild(line);
  }

  // ── 渲染：地图 ──
  function renderMap(snap) {
    var canvas = document.getElementById('mapCanvas');
    [].slice.call(canvas.querySelectorAll('.zone')).forEach(function (n) { n.parentNode.removeChild(n); });
    drawWorldDots(snap);
    var gateEl = canvas.querySelector('.mirror-gate');
    if (gateEl) {
      gateEl.textContent = (snap && snap.mapTheme && snap.mapTheme.gateLabel) || '◈ 水 镜 之 门 ◈';
    }

    var regions = snap.regions || [];
    var world = snap.world || {};
    var byKey = {};
    regions.forEach(function (r) { byKey[r.key] = r; });
    nodeEls = {}; routeOrder = [];
    var allBlocks = [];

    // 同行旅伴徽章 + 旅伴自游徽章（当前区域右下角；图标口径）
    // ⚠️ 随行徽章只属于鲸鱼当前所在的那一格：自游区域也会调用本函数画自己的伙伴徽章，
    //    若无条件带上 mateIds，正在随行的旅伴会被错挂到每一组自游行程上。
    function matesChipsOf(sideEntries, whaleHere) {
      var ids = whaleHere ? ((snap.whale && snap.whale.mateIds) || []) : [];
      var sideList = sideEntries || [];
      if (!ids.length && !sideList.length) return null;
      var box = el('div', 'zone__mates');
      ids.forEach(function (id) {
        var m = (snap.companions || []).filter(function (c) { return c.id === id; })[0];
        var icon = (m && m.emoji) || MATE_ICONS[id] || '🔹';
        box.appendChild(el('span', 'mchip', icon + ' ' + (m ? m.name : id)));
      });
      sideList.forEach(function (e) {
        var label = e.ids.map(function (id) {
          var m = (snap.companions || []).filter(function (c) { return c.id === id; })[0];
          return (MATE_ICONS[id] || '🔹') + (m ? m.name : id);
        }).join('+');
        var chip = el('span', 'mchip mchip--side', label);
        chip.title = '旅伴自游中：' + (e.country ? e.country + '·' : '') + e.city;
        box.appendChild(chip);
      });
      return box;
    }

    /**
     * 画一张区域卡。四态（主人口径 2026-10-24）：
     *   去过(has) / 已解锁待启程(open, ✈) / 可见未解锁(locked, 🔒+需:装备)；
     * 去过但未解锁 → has 态 + 「未解锁」角标（如穿越去过的明日方舟）。
     */
    function draw(key, region, z, worldEntry) {
      var w = worldEntry || {};
      var isOther = w.kind === 'other' || z.other || region.type === 'other';
      var visited = region.cities && region.cities.length > 0;
      var unlocked = w.unlocked === undefined ? true : !!w.unlocked;   // 表外键不设闸
      var state = visited ? 'has' : (unlocked ? 'open' : 'locked');
      var active = false;

      var zone = el('div', 'zone zone--' + state + (isOther ? ' zone--other' : ''));
      zone.style.left = z.x + 'px'; zone.style.top = z.y + 'px';
      zone.style.width = z.w + 'px'; zone.style.height = z.h + 'px';
      zone.appendChild(el('div', 'zone__name', (isOther ? '◇ ' : '◆ ') + z.name));
      zone.appendChild(el('div', 'zone__wm', z.en || ''));
      if (state === 'has' && !unlocked) zone.appendChild(el('div', 'zone__flag', '未解锁'));

      var body = el('div', 'zone__body');
      var sideEntries = [];
      if (visited) {
        // 展示序 = 行程序（当前所在最后）；点 = 区域内的到访记录
        var cities = region.cities.slice().sort(function (a, b) {
          return (a.current ? 1 : 0) - (b.current ? 1 : 0) || (Number(a.lastAt) || 0) - (Number(b.lastAt) || 0);
        });
        var firstAt = 0, hasCur = false;
        cities.forEach(function (c) {
          var isSide = c.sideIds && c.sideIds.length;
          var node = el('div', 'node' + (c.current ? ' node--cur' : (isSide ? ' node--side' : (c.count > 1 ? ' node--hot' : ''))));
          node.title = c.city + '（' + c.country + '）· 到访 ' + Math.max(1, c.count) + ' 次' + (c.lastAt ? ' · 最近 ' + fmtClock(c.lastAt) : '');
          if (isSide) node.title = '旅伴自游中：' + c.sideIds.join('、') + ' · ' + node.title;
          var dot = el('span', 'node__dot');
          node.appendChild(dot);
          node.appendChild(el('span', 'node__label', c.city));
          if (c.count > 1) node.appendChild(el('sup', 'node__n', '×' + c.count));
          body.appendChild(node);
          nodeEls[region.key + '|' + c.city] = dot;
          if (c.lastAt && (!firstAt || c.lastAt < firstAt)) firstAt = c.lastAt;
          if (c.current) hasCur = true;
          if (isSide) sideEntries.push({ ids: c.sideIds, city: c.city, country: c.country });
        });
        if (hasCur) active = true;
        if (hasCur || sideEntries.length) {
          var chips = matesChipsOf(sideEntries, hasCur);
          if (chips) zone.appendChild(chips);
        }
        allBlocks.push({ el: zone, firstAt: firstAt, current: hasCur });
      } else if (state === 'open') {
        // 已解锁、还没去过：不再是"锁"，是待启程的邀请
        var go = el('div', 'zone__go', '✈');
        go.title = w.equipment ? '行头：' + w.equipment : '已解锁，随时可以出发';
        body.appendChild(go);
        body.appendChild(el('div', 'zone__hint', '待启程'));
      } else {
        // 可见但未解锁
        body.appendChild(el('div', 'zone__lock', '🔒'));
        body.appendChild(el('div', 'zone__hint', w.equipment ? '需：' + w.equipment : '未解锁'));
      }
      zone.appendChild(body);
      if (active) zone.classList.add('zone--active');
      canvas.appendChild(zone);
      return zone;
    }

    function drawMystery(z) {
      var zone = el('div', 'zone zone--other zone--mystery');
      zone.style.left = z.x + 'px'; zone.style.top = z.y + 'px';
      zone.style.width = z.w + 'px'; zone.style.height = z.h + 'px';
      zone.appendChild(el('div', 'zone__name', '◇ ？？？'));
      var body = el('div', 'zone__body');
      body.appendChild(el('div', 'zone__q', '？ ？ ？'));
      body.appendChild(el('div', 'zone__hint', '尚未揭示的世界'));
      zone.appendChild(body);
      canvas.appendChild(zone);
    }

    // 基础世界固定格（默认地球九区；当 snap.mapTheme 生效时，动态切换为艾泽拉斯等新锚点分区）
    var activeZones = (snap && snap.mapTheme && snap.mapTheme.zones && Object.keys(snap.mapTheme.zones).length)
      ? snap.mapTheme.zones
      : ZONES;
    var activeRealKeys = (snap && snap.mapTheme && Array.isArray(snap.mapTheme.zoneOrder) && snap.mapTheme.zoneOrder.length)
      ? snap.mapTheme.zoneOrder
      : Object.keys(activeZones);
    activeRealKeys.forEach(function (k) {
      var z = activeZones[k];
      if (!z) return;
      var r = byKey[k] || { key: k, name: z.name, type: 'real', cities: [] };
      draw(k, r, z, world[k]);
      byKey[k] = null;   // 已画
    });

    // 其余全部进异世界动态底带（可见者 + 表外数据键），留 ？？？ 给未揭示的世界
    var bandKeys = Object.keys(world).filter(function (k) {
      return world[k].kind === 'other' && world[k].visible && !activeZones[k];
    });
    Object.keys(byKey).forEach(function (k) {
      if (!byKey[k]) return;
      if (world[k] && world[k].visible === false) { byKey[k] = null; return; }   // 不可见世界不上图（不剧透）
      if (bandKeys.indexOf(k) === -1) bandKeys.push(k);
    });
    bandKeys.sort(function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); });
    var items = bandKeys.map(function (k) {
      return { key: k, region: byKey[k] || { key: k, name: (world[k] || {}).name || k, cities: [] },
               name: (world[k] || {}).name || (byKey[k] || {}).name || k };
    });
    var hasHidden = Object.keys(world).some(function (k) { return world[k].kind === 'other' && !world[k].visible; });
    if (hasHidden) items.push({ mystery: true });
    if (items.length) {
      var cols = Math.min(8, Math.max(3, Math.ceil(items.length / 2)));
      var tw = Math.floor((1000 - (cols - 1) * 8) / cols);
      items.forEach(function (it, i) {
        var col = i % cols, row = Math.floor(i / cols);
        var z = { x: col * (tw + 8), y: 496 + row * 70, w: tw, h: 64, other: true, en: 'GATE' };
        if (it.mystery) drawMystery(z);
        else draw(it.key, it.region, { x: z.x, y: z.y, w: z.w, h: z.h, other: true, en: 'GATE', name: it.name }, world[it.key]);
      });
    }

    // 航线节点序：区域首次到访时间（当前所在区排最后 = 航线终点）
    allBlocks.sort(function (a, b) {
      return (a.current ? 1 : 0) - (b.current ? 1 : 0) || (a.firstAt || 0) - (b.firstAt || 0);
    });
    routeOrder = allBlocks.map(function (b) { return b.el; });
    drawRoutes();                          // 同步先画（getBoundingClientRect 可强制排版，不依赖合成帧）
    requestAnimationFrame(drawRoutes);     // 布局稳定后再补一次（低频合成面板上 rAF 可能延迟）
  }

  // ── 渲染：右侧栏 ──
  function renderSide(snap) {
    var w = snap.whale || {};
    var wc = document.getElementById('whaleCard');
    wc.textContent = '';
    wc.appendChild(el('h2', '', '她现在'));
    if (w.state === 'traveling' && w.place) {
      wc.appendChild(el('div', 'place', '【' + (w.place.country || '') + '·' + w.place.city + '】'));
      // ★ 2026-10-25 现实经纬度（3 位小数 ≈100m，隐私纪律；家/异世界无此行）
      if (w.coords && Number.isFinite(w.coords.lat)) {
        wc.appendChild(el('div', 'dim', '📍 ' + w.coords.lat + '°N, ' + w.coords.lon + '°E' + (w.coords.estimated ? '（约）' : '')));
      }
      var bits = [];
      if (w.phase && w.phase.name) bits.push(w.phase.name);
      var mateNames = (w.mateIds || []).map(function (id) {
        var m = (snap.companions || []).filter(function (c) { return c.id === id; })[0];
        return m ? m.name : id;
      });
      if (mateNames.length) bits.push('和 ' + mateNames.join('、') + ' 同行');
      wc.appendChild(el('div', 'dim', bits.join(' · ')));
      if (w.phase && w.phase.brief) wc.appendChild(el('div', 'dim', w.phase.brief));
      if (w.returnAt) wc.appendChild(el('div', 'gold', untilLabel(w.returnAt)));
      // 返程进度条：已走时长 / 全程
      if (w.departAt && w.returnAt && w.returnAt > w.departAt) {
        var pct = Math.max(0, Math.min(100, Math.round(((Date.now() - w.departAt) / (w.returnAt - w.departAt)) * 100)));
        var tp = el('div', 'trip-progress');
        tp.title = '行程进度 ' + pct + '%（已走 / 全程）';
        var bar = el('div', 'bar');
        bar.style.width = pct + '%';
        tp.appendChild(bar);
        wc.appendChild(tp);
        var tl = el('div', 'trip-legend');
        tl.appendChild(el('span', '', '出发 ' + fmtClock(w.departAt)));
        tl.appendChild(el('span', '', '返程 ' + fmtClock(w.returnAt)));
        wc.appendChild(tl);
      }
    } else {
      var homeLabel = (snap && snap.mapTheme && snap.mapTheme.homePlaceLabel) || '在矩阵庭院';
      wc.appendChild(el('div', 'place', homeLabel));
      if (w.homeAct) {
        var actLine = el('div', 'dim');
        actLine.appendChild(document.createTextNode(w.homeAct.act || ''));
        if (w.homeAct.mate) actLine.appendChild(mateBadge(w.homeAct.mate));
        wc.appendChild(actLine);
      } else {
        wc.appendChild(el('div', 'dim', '（这会儿没在做什么）'));
      }
    }

    // 旅伴自游跟踪：谁在哪、什么时候回家（与她的行程互相独立，两态都显示）
    var outMates = (snap.companions || []).filter(function (c) { return c.status === 'side' && c.side && c.side.city; });
    if (outMates.length) {
      var line = el('div', 'dim side-line');
      line.appendChild(document.createTextNode('旅伴在外：'));
      line.appendChild(el('span', 'side-ico', outMates.map(function (c) { return MATE_ICONS[c.id] || '🔹'; }).join('')));
      line.appendChild(document.createTextNode(outMates.map(function (c) { return c.name; }).join('、')));
      var dest0 = outMates[0].side;
      var same = outMates.every(function (c) { return c.side.city === dest0.city && c.side.country === dest0.country; });
      if (same) {
        line.appendChild(document.createTextNode(' 在【' + (dest0.country || dest0.regionName || '') + '·' + dest0.city + '】'));
      } else {
        line.appendChild(document.createTextNode(' 各自在外'));
      }
      var ret = outMates.map(function (c) { return c.side.returnAt || 0; }).sort(function (a, b) { return a - b; })[0];
      if (ret) line.appendChild(document.createTextNode('，最早 ' + untilLabel(ret).replace('回程', '回家')));
      wc.appendChild(line);
    }

    var hc = document.getElementById('homeNowCard');
    hc.textContent = '';
    hc.appendChild(el('h2', '', '庭院近况'));
    hc.appendChild(feedGrid(snap, 3));
  }

  /** 近况两列网格（时间戳列固定宽；旅伴用胶囊徽章，不再裸括号） */
  function feedGrid(snap, limit) {
    var feed = el('div', 'feed2');
    var list = (snap.homeFeed || []).slice();
    if (limit) list = list.slice(-limit);
    list.reverse();
    if (!list.length) {
      var e = el('div', 'tx dim', '（还没有记录）');
      e.style.gridColumn = '1 / -1';
      feed.appendChild(e);
      return feed;
    }
    list.forEach(function (f) {
      feed.appendChild(el('span', 't', fmtClock(f.at)));
      var tx = el('div', 'tx');
      tx.appendChild(document.createTextNode(f.act || ''));
      if (f.mate) tx.appendChild(mateBadge(f.mate));
      if (f.detail) tx.appendChild(el('span', 'detail', f.detail));
      feed.appendChild(tx);
    });
    return feed;
  }

  // ── 渲染：庭院页（三层 Bento）──
  function kpiCard(kind, ico, title, rows) {
    var card = el('div', 'kpi');
    card.appendChild(el('div', 'kpi__ico kpi__ico--' + kind, ico));
    var body = el('div', 'kpi__rows');
    body.appendChild(el('div', 'kpi__title', title));
    rows.forEach(function (r) {
      var kv = el('div', 'kv');
      kv.appendChild(el('span', '', r[0]));
      kv.appendChild(el('b', '', r[1]));
      body.appendChild(kv);
    });
    card.appendChild(body);
    return card;
  }

  function renderYard(snap) {
    var c = snap.courtyard || {};
    var kpiRow = document.getElementById('kpiRow');
    kpiRow.textContent = '';
    kpiRow.appendChild(kpiCard('pond', '🌊', '池塘', [
      ['可收', String((c.pond && c.pond.ready) || 0)],
      ['荧光', String((c.pond && c.pond.glow) || 0)]
    ]));
    kpiRow.appendChild(kpiCard('wallet', '💰', '钱袋', [
      ['TOKEN 余额（亿）', String((c.wallet && c.wallet.plankton) || 0)],
      ['发光 TOKEN', String((c.wallet && c.wallet.glow) || 0)]
    ]));
    var worn = (c.wardrobe && c.wardrobe.worn) || '';
    if (/^(whale|default)$/i.test(worn)) worn = '默认着装';   // 旧快照兜底：别把英文 key 摆上桌
    kpiRow.appendChild(kpiCard('wardrobe', '👗', '衣柜', [
      ['已拥有', ((c.wardrobe && c.wardrobe.owned) || 0) + ' 件'],
      ['穿着', worn || '默认着装']
    ]));
    var tc = kpiCard('titles', '🏅', '称号', [
      ['已获得', (c.titles || 0) + ' 枚'],
      ['成就值', (c.achievePoints || 0) + ' 分']
    ]);
    tc.title = '全部称号共 ' + (c.achieveTotal || 0) + ' 分（成就值 = 已获得称号的分值合计）';
    kpiRow.appendChild(tc);

    var mid = document.getElementById('bentoMid');
    mid.textContent = '';

    // 左：庭院设施（Lv.N + 分段进度条，上限对齐 state.js 的 GARDENS）
    var fac = el('div', 'card');
    fac.appendChild(el('h2', '', '庭院设施'));
    var levels = c.garden || {};
    var any = false;
    Object.keys(FACILITIES).forEach(function (k) {
      var lv = Number(levels[k]) || 0;
      if (!lv) return;
      any = true;
      var f = FACILITIES[k];
      var row = el('div', 'fac');
      row.appendChild(el('span', 'fac__name', f.name));
      row.appendChild(el('span', 'fac__lv', 'Lv.' + lv));
      var seg = el('div', 'seg');
      for (var i = 0; i < f.max; i++) seg.appendChild(el('i', i < lv ? 'on' : ''));
      row.appendChild(seg);
      fac.appendChild(row);
    });
    if (!any) fac.appendChild(el('div', 'empty', '（还没建过设施）'));
    mid.appendChild(fac);

    // 右：纪念品墙（特产图鉴，稀有度上色）
    var wallCard = el('div', 'card');
    var wh = el('h2', '', '');
    wh.appendChild(document.createTextNode('纪念品墙'));
    wh.appendChild(el('span', 'hdim', '特产图鉴 · 共 ' + ((c.souvenirs || []).length) + ' 件'));
    wallCard.appendChild(wh);
    var wall = el('div', 'wall');
    (c.souvenirs || []).forEach(function (x) {
      var cls = 'chip' + (x.rarity === 'rare' ? ' chip--rare' : (x.rarity === 'uncommon' ? ' chip--uncommon' : ''));
      var chip = el('span', cls, x.name + (x.count > 1 ? ' ×' + x.count : ''));
      chip.title = (x.city || '') + ' · ' + (x.kind || '') + (x.eaten ? ' · 吃过 ' + x.eaten : '');
      wall.appendChild(chip);
    });
    if (!(c.souvenirs || []).length) wall.appendChild(el('span', 'chip', '（还没买过东西）'));
    wallCard.appendChild(wall);
    mid.appendChild(wallCard);

    // 身心与好感（Studio 扩容，2026-10-24）：快照有 vitals/favor 才渲染（旧快照静默跳过）
    var vitalsRow = document.getElementById('vitalsRow');
    vitalsRow.textContent = '';
    var hasVitals = snap.vitals && Object.keys(snap.vitals).some(function (k) {
      var v = snap.vitals[k];
      return !Array.isArray(v) && v !== null && v !== undefined;   // tags 是数组，不算"有数值"
    });
    var hasFavor = Array.isArray(snap.favor) && snap.favor.length;
    if (hasVitals || hasFavor) {
      if (hasVitals) {
        var vc = el('div', 'card');
        vc.appendChild(el('h2', '', '元气与心境'));
        var vit = snap.vitals;
        // ★ 2026-10-28：元气单轴。`mood` / `satisfaction` / `rage` 是 sleep-mood 的兼容投影
        //   （由情境 Tag 推算给人看的），不是她的真实驱动量 —— 摆出来只会读成
        //   "心情 93 / 很满足 / 在生气"，误导。现在只画一条元气（老存档回退疲劳）。
        var vitRows = [];
        if (vit.vitality !== null && vit.vitality !== undefined) vitRows.push(['元气', vit.vitality]);
        else vitRows.push(['疲劳', vit.fatigue]);
        vitRows
          .forEach(function (p) {
            if (p[1] === null || p[1] === undefined) return;
            var row = el('div', 'vital');
            row.appendChild(el('span', 'vital__k', p[0]));
            var bar = el('div', 'vital__bar');
            bar.appendChild(el('i', p[1] >= 60 ? 'hot' : ''));
            bar.style.setProperty('--w', Math.max(2, p[1]) + '%');
            row.appendChild(bar);
            row.appendChild(el('b', 'vital__v', String(p[1])));
            vc.appendChild(row);
          });
        // 具身情境 Tag：她此刻"为什么是这个心情、还能持续多久"
        if (Array.isArray(vit.tags) && vit.tags.length) {
          var tagBox = el('div', 'vital-tags');
          vit.tags.forEach(function (t) {
            var line = el('div', 'vital-tag' + (t.tone === 'bad' ? ' is-bad' : '') + (t.tone === 'mixed' ? ' is-mixed' : ''));
            line.appendChild(el('b', 'vital-tag__name', t.tag));
            if (t.why) line.appendChild(el('span', 'vital-tag__why', '· ' + t.why));
            if (t.leftMin > 0) line.appendChild(el('span', 'vital-tag__left', '剩 ' + t.leftMin + ' 分'));
            tagBox.appendChild(line);
          });
          vc.appendChild(tagBox);
        }
        vitalsRow.appendChild(vc);
      }
      if (hasFavor) {
        var fc = el('div', 'card');
        fc.appendChild(el('h2', '', '好感图谱'));
        snap.favor.forEach(function (f) {
          var row = el('div', 'vital');
          row.appendChild(el('span', 'vital__k', f.name));
          var bar = el('div', 'vital__bar');
          bar.appendChild(el('i', ''));
          // favor-core 的好感度本来就是 0~100（实测 220 份档案 min 23 / max 100）。
          // 旧代码这里除以 40 是照 0~4000 的老口径写的 —— 结果好感 100 的人条形只有 3%，
          // 看起来像"谁都不熟"。现在直接按百分比画。
          bar.style.setProperty('--w', Math.max(2, Math.min(100, Math.round(Math.abs(f.favor)))) + '%');
          row.appendChild(bar);
          row.appendChild(el('b', 'vital__v', String(f.favor) + (f.pending ? ' ⏳' + f.pending : '')));
          fc.appendChild(row);
        });
        vitalsRow.appendChild(fc);
      }
    }

    // 底：庭院近况通栏
    var feedCard = document.getElementById('yardFeedCard');
    feedCard.textContent = '';
    feedCard.appendChild(el('h2', '', '庭院近况'));
    feedCard.appendChild(feedGrid(snap, 0));
  }

  // ── 渲染：旅伴页（卡片 = 按钮，点开档案）──
  //   ★ 2026-10-26：卡片由 div 改成 <button>（键盘可达），点开「旅伴档案」。
  function renderMates(snap) {
    var box = document.getElementById('mates');
    box.textContent = '';
    var list = snap.companions || [];
    if (!list.length) { box.appendChild(el('div', 'empty', '（还没有旅伴）')); return; }
    var w = snap.whale || {};
    list.forEach(function (m) {
      var locked = m.locked === true || m.status === 'locked';
      var card = el('button', 'card mate' + (locked ? ' mate--locked' : ''));
      card.type = 'button';
      card.dataset.mate = m.id;
      card.setAttribute('aria-label', m.name + ' 的旅伴档案');
      // 有立绘就在卡片上露一小条，没有则回退 emoji
      if (m.portrait) {
        var th = el('div', 'mate__thumb');
        var ti = el('img'); ti.src = m.portrait; ti.alt = ''; ti.loading = 'lazy';
        th.appendChild(ti);
        card.appendChild(th);
      }
      var ico = el('div', 'mate__ico', m.emoji || MATE_ICONS[m.id] || '🔹');
      ico.title = locked ? `${m.id}（未解锁）` : m.id;
      card.appendChild(ico);
      var info = el('div');
      info.appendChild(el('div', 'mate__name', m.name));
      var st = locked ? MATE_STATUS.locked : (MATE_STATUS[m.status] || MATE_STATUS.idle);
      var stEl = el('div', 'mate__st ' + st.cls, st.label);
      if (!locked && m.status === 'traveling' && w.state === 'traveling') stEl.textContent += ' · 和她在一起';
      info.appendChild(stEl);
      // 自游中的旅伴：目的地与回家时间
      if (!locked && m.status === 'side' && m.side && m.side.city) {
        var dest = el('div', 'mate__dest', '【' + (m.side.country || m.side.regionName || '') + '·' + m.side.city + '】'
          + (m.side.returnAt ? ' · ' + untilLabel(m.side.returnAt).replace('回程', '回家') : ''));
        info.appendChild(dest);
      }
      // 一行摘要：技能进度 + 同行趟数（点开看全）
      if (!locked) {
        var sk = (m.skills || [])[0];
        var bits = [];
        if (sk) bits.push(sk.learned ? '技能已解锁' : `技能 ${m.worldsCount || 0}/${sk.needWorlds}`);
        if (m.tripsFiction) bits.push(`同行 ${m.tripsFiction} 趟`);
        if (bits.length) info.appendChild(el('div', 'mate__sum', bits.join(' · ')));
      }
      if (locked) card.title = '还没请她加入庭院 —— 在庭院本体里解锁后这里就会亮起来';
      card.appendChild(info);
      card.appendChild(el('div', 'mate__go', '档案 ›'));
      box.appendChild(card);
    });
  }

  /** 区域 id → 中文名（足迹用；取不到就显示 id） */
  function regionNameOf(snap, key) {
    var k = String(key || '');
    var list = (snap && snap.regions) || [];
    for (var i = 0; i < list.length; i += 1) {
      if (String(list[i].key) === k) return list[i].name || k;
    }
    return k || '未记';
  }

  // ── 渲染：同行足迹页（2026-10-26）──
  //   口径：只数**异世界**同行（trip.regionFictional）；同一座城去两次 = 两趟。
  function renderTrail(snap) {
    var box = document.getElementById('trail');
    if (!box) return;
    box.textContent = '';
    var list = (snap.companions || []).filter(function (m) { return !m.locked; });
    var rows = list.filter(function (m) { return (m.footprint && m.footprint.length) || (m.tripsFiction || 0) > 0; });
    if (!rows.length) {
      box.appendChild(el('div', 'empty', '（还没有一起出过远门 —— 等她带上某位旅伴去异世界走一趟，这里就会记下来）'));
      return;
    }
    rows.sort(function (a, b) { return (b.tripsFiction || 0) - (a.tripsFiction || 0); });
    rows.forEach(function (m) {
      var g = el('div', 'trail-grp card');
      var hd = el('div', 'trail-grp__hd');
      if (m.portrait) {
        var av = el('img', 'trail-grp__av'); av.src = m.portrait; av.alt = ''; av.loading = 'lazy';
        hd.appendChild(av);
      } else {
        hd.appendChild(el('span', 'trail-grp__av trail-grp__av--emoji', m.emoji || '🔹'));
      }
      var name = el('div', 'trail-grp__name');
      name.appendChild(el('b', '', m.name));
      name.appendChild(el('span', 'trail-grp__meta',
        `同行 ${m.tripsFiction || 0} 趟 · 带路去过 ${m.worldsCount || 0} 个异世界`));
      hd.appendChild(name);
      g.appendChild(hd);

      var cities = m.footprint || [];
      if (cities.length) {
        var wrap = el('div', 'trail-cities');
        cities.forEach(function (c) {
          var chip = el('span', 'trail-city');
          chip.appendChild(el('span', 'trail-city__where',
            regionNameOf(snap, c.regionId) + '·' + c.city));
          if (c.n > 1) chip.appendChild(el('b', 'trail-city__n', '×' + c.n));
          wrap.appendChild(chip);
        });
        g.appendChild(wrap);
      } else {
        g.appendChild(el('div', 'trail-grp__note', '（这几位是同行过，但城市记录还没开始记 —— 从下一次出发起会补上）'));
      }
      box.appendChild(g);
    });
  }

  // ── 旅伴档案弹层 ──────────────────────────────────────────────────────────
  function openMateProfile(snap, id) {
    var m = (snap.companions || []).filter(function (x) { return x.id === id; })[0];
    var host = document.getElementById('mateProfile');
    var body = document.getElementById('mateProfileBody');
    if (!m || !host || !body) return;
    body.textContent = '';

    var grid = el('div', 'mp__grid');
    // 左：立绘（默认 240×300 压小；点一下看原图大图 —— 2026-10-26 主人口径）
    var art = el('div', 'mp__art');
    if (m.portrait) {
      var im = el('img'); im.src = m.portrait; im.alt = m.name + ' 立绘';
      art.appendChild(im);
      art.appendChild(el('div', 'mp__zoom', '点击看大图'));
      art.title = '点击看大图';
      art.setAttribute('role', 'button');
      art.setAttribute('tabindex', '0');
      art.addEventListener('click', function () { openPortraitBig(m); });
      art.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPortraitBig(m); }
      });
    } else {
      art.appendChild(el('div', 'mp__art--none', m.emoji || '🔹'));
    }
    art.appendChild(el('div', 'mp__artcap', m.name));
    grid.appendChild(art);

    // 右：信息
    var info = el('div', 'mp__info');
    var title = el('div', 'mp__title');
    title.appendChild(el('h2', 'mp__name', m.name));
    title.id = 'mpName';
    if (m.trait) title.appendChild(el('span', 'mp__trait', m.trait));
    info.appendChild(title);

    // 能力
    var ab = el('div', 'mp__sec');
    ab.appendChild(el('div', 'mp__sec-hd', '能力'));
    if (m.desc) ab.appendChild(el('p', 'mp__text', m.desc));
    var mult = m.mult || {};
    var bits = [];
    if (mult.cardMult && mult.cardMult !== 1) bits.push('明信片 ×' + mult.cardMult);
    if (mult.rareMult && mult.rareMult !== 1) bits.push('稀有 ×' + mult.rareMult);
    if (mult.foodCostMult && mult.foodCostMult !== 1) bits.push('伙食 ×' + mult.foodCostMult);
    if (mult.dailyTokens) bits.push('每日 ' + mult.dailyTokens + ' 亿 TOKEN');
    if (bits.length) ab.appendChild(el('div', 'mp__chips', bits.map(function (t) { return chipOf(t); })));
    info.appendChild(ab);

    // 同行
    var tw = el('div', 'mp__sec');
    tw.appendChild(el('div', 'mp__sec-hd', '同行'));
    tw.appendChild(el('div', 'mp__stat',
      `一共同行 ${m.tripsFiction || 0} 趟 · 带路去过 ${m.worldsCount || 0} 个异世界`));
    if ((m.worlds || []).length) {
      var wchips = el('div', 'mp__chips');
      m.worlds.forEach(function (r) { wchips.appendChild(chipOf(regionNameOf(snap, r))); });
      tw.appendChild(wchips);
    }
    if ((m.footprint || []).length) {
      var fc = el('div', 'mp__chips');
      m.footprint.slice(0, 12).forEach(function (c) {
        fc.appendChild(chipOf(regionNameOf(snap, c.regionId) + '·' + c.city + (c.n > 1 ? ' ×' + c.n : '')));
      });
      tw.appendChild(fc);
    }
    info.appendChild(tw);

    // 技能
    var sk = el('div', 'mp__sec');
    sk.appendChild(el('div', 'mp__sec-hd', '技能'));
    var list = m.skills || [];
    if (!list.length) sk.appendChild(el('div', 'mp__note', '（这位还没有可学的技能）'));
    list.forEach(function (s) {
      var box = el('div', 'mp__skill' + (s.learned ? ' mp__skill--on' : ''));
      var hd = el('div', 'mp__skill-hd');
      hd.appendChild(el('b', '', (s.emoji || '✦') + ' ' + s.name));
      if (s.learned) hd.appendChild(el('span', 'mp__skill-tag mp__skill-tag--on', '已解锁'));
      else if (s.gate && s.gate.ok) hd.appendChild(el('span', 'mp__skill-tag', '可学（' + s.price + ' 亿）'));
      else hd.appendChild(el('span', 'mp__skill-tag', `${m.worldsCount || 0}/${s.needWorlds} 个异世界`));
      box.appendChild(hd);
      if (s.effect) box.appendChild(el('div', 'mp__skill-fx', s.effect));
      if (!s.learned && s.gate && s.gate.reason) box.appendChild(el('div', 'mp__skill-why', s.gate.reason));
      sk.appendChild(box);
    });
    info.appendChild(sk);

    // 来历 / 性格
    var lore = m.lore || {};
    if (lore.origin || lore.persona) {
      var lo = el('div', 'mp__sec');
      lo.appendChild(el('div', 'mp__sec-hd', '来历'));
      if (lore.origin) lo.appendChild(el('p', 'mp__text', lore.origin));
      if (lore.persona) {
        lo.appendChild(el('div', 'mp__sec-hd', '性格'));
        lo.appendChild(el('p', 'mp__text', lore.persona));
      }
      info.appendChild(lo);
    }

    grid.appendChild(info);
    body.appendChild(grid);
    host.hidden = false;
  }

  function chipOf(text) {
    return el('span', 'mp__chip', String(text));
  }

  function closeMateProfile() {
    var host = document.getElementById('mateProfile');
    if (host) host.hidden = true;
  }

  /** 立绘大图：复用相册那个 lightbox，但**直接给相对路径**（走 panel 目录，不是 ../@data/） */
  function openPortraitBig(m) {
    if (!m || !m.portrait) return;
    var lb = document.getElementById('lightbox');
    if (!lb) return;
    document.getElementById('lightboxImg').src = m.portrait;
    document.getElementById('lightboxCap').textContent = m.name + ' · 点任意处关闭';
    lb.hidden = false;
  }

  // ── 渲染：相册页 ──
  function renderAlbum(snap) {
    var box = document.getElementById('album');
    box.textContent = '';
    var list = (snap.album || []).slice().reverse();
    if (!list.length) { box.appendChild(el('div', 'empty', '（相册还是空的 —— 寄出第一张明信片后这里就有了）')); return; }
    list.forEach(function (a) {
      var shot = el('div', 'shot');
      if (a.img) {
        var img = el('img'); img.src = '../@data/' + a.img; img.alt = a.spot; img.loading = 'lazy';
        shot.appendChild(img);
      } else {
        shot.appendChild(el('div', 'shot--empty', '（无图）'));
      }
      var cap = el('div', 'shot__cap');
      cap.appendChild(el('b', '', a.spot));
      cap.appendChild(document.createTextNode((a.city || '') + (a.style ? ' · ' + a.style : '')));
      if (a.credit) cap.appendChild(el('span', 'shot__credit', a.credit));   // 真实照片署名
      shot.appendChild(cap);
      shot.addEventListener('click', function () { openLightbox(a); });
      box.appendChild(shot);
    });
  }
  function openLightbox(a) {
    if (!a.img) return;
    var lb = document.getElementById('lightbox');
    document.getElementById('lightboxImg').src = '../@data/' + a.img;
    document.getElementById('lightboxCap').textContent = a.spot + ' · ' + (a.city || '') + (a.thought ? ' —— ' + a.thought : '');
    lb.hidden = false;
  }

  // ── 总渲染 ──
  function render(snap) {
    if (!snap || snap.error) {
      document.getElementById('meta').textContent = snap && snap.error ? snap.error : '快照还没准备好';
      return;
    }
    lastSnap = snap;
    document.getElementById('meta').textContent = '刷新于 ' + fmtClock(snap.at) + ' · 每 30 秒自动';
    renderMap(snap);
    renderSide(snap);
    renderYard(snap);
    renderMates(snap);
    renderTrail(snap);
    renderAlbum(snap);
  }

  function refresh() {
    fetchSnap().then(render);
  }

  // ── 事件 ──
  document.addEventListener('DOMContentLoaded', function () {
    var tabs = document.getElementById('tabs');
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (!btn) return;
      [].slice.call(tabs.children).forEach(function (b) { b.classList.toggle('tab--on', b === btn); });
      ['map', 'yard', 'mates', 'trail', 'album'].forEach(function (k) {
        document.getElementById('page-' + k).classList.toggle('page--on', k === btn.dataset.tab);
      });
      if (btn.dataset.tab === 'map') {
        // 页签刚显示时容器才有宽度：下一帧排版 + 补画航线
        requestAnimationFrame(function () { fitMap(); });
      }
    });
    // 旅伴卡 → 档案（事件委托；卡片是 <button>，键盘回车也走 click）
    document.getElementById('mates').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-mate]');
      if (!btn || !lastSnap) return;
      openMateProfile(lastSnap, btn.dataset.mate);
    });
    document.getElementById('mateProfileClose').addEventListener('click', closeMateProfile);
    document.getElementById('mateProfile').addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-mp-close') === '1') closeMateProfile();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMateProfile();
    });
    document.getElementById('reload').addEventListener('click', refresh);
    document.getElementById('lightbox').addEventListener('click', function () {
      document.getElementById('lightbox').hidden = true;
    });
    fitMap();
    window.addEventListener('resize', fitMap);
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
})();
