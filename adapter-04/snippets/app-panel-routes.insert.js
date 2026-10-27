      // ── [[courtyard:panel]] 插件自带界面：/plugin-panel/<id>/… 与 /plugin-assets/<id>/… ──
      // 官方 0.4 原本没有这个口子（插件无法在控制台里放自己的界面）。两个前缀共用一套处理：
      //   /plugin-panel/<id>/<file>       → <app>/plugins/<id>/ 或 <app>/skills/<id>/（只读）
      //   /plugin-panel/<id>/@data/<file> → <DATA_DIR>/plugin-data/<id>/
      //   /plugin-assets/<id>/<file>      → 同第一行（settingsUi 模块用 import() 取回自己）
      // 安全五道：同源校验 → id 白名单 → 逐段拒绝 ..（上面的 clean 已做）
      //          → realpath 二次确认（挡符号链接）→ 扩展名白名单（不做通用文件下载器）。
      if ((clean[0] === PANEL_ROUTE_PREFIX.slice(1) || clean[0] === 'plugin-assets') && clean.length >= 3) {
        if (!originAllowed(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Forbidden');
          return;
        }
        const panelId = clean[1];
        const rest = clean.slice(2);
        const fromData = rest[0] === PANEL_DATA_SEGMENT;
        if (fromData) rest.shift();
        const panelIdOk = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(panelId);
        let panelRoot = null;
        if (panelIdOk && rest.length) {
          if (fromData) {
            panelRoot = path.join(DATA_DIR, 'plugin-data', panelId);
          } else {
            for (const base of [path.resolve(UI_DIR, '..', 'plugins'), path.resolve(UI_DIR, '..', 'skills')]) {
              const cand = path.join(base, panelId);
              try { if (fs.statSync(cand).isDirectory()) { panelRoot = cand; break; } } catch { /* 试下一个 */ }
            }
          }
        }
        let realRoot = null;
        let realFile = null;
        if (panelRoot) {
          try {
            realRoot = fs.realpathSync(panelRoot);
            realFile = fs.realpathSync(path.join(panelRoot, ...rest));
          } catch { /* 不存在 → 走下面 404 */ }
        }
        const panelInside = Boolean(realRoot && realFile)
          && (realFile === realRoot || realFile.startsWith(realRoot + path.sep));
        const panelType = panelInside ? PANEL_FILE_TYPES[path.extname(realFile).toLowerCase()] : null;
        if (!panelType) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        try {
          const panelData = fs.readFileSync(realFile);
          const panelHeaders = { 'content-type': panelType, 'cache-control': 'no-cache' };
          if (panelType.startsWith('text/html')) {
            panelHeaders['content-security-policy'] = panelCsp();
            panelHeaders['x-content-type-options'] = 'nosniff';
            panelHeaders['referrer-policy'] = 'no-referrer';
          }
          res.writeHead(200, panelHeaders);
          res.end(panelData);
          return;
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
      }
