    // [[courtyard:storage]] 与 0.4.8.x 对齐：api.storage 落 <DATA_DIR>/plugin-data/<id>/storage.json，
    // 面板 `/plugin-panel/<id>/@data/storage.json` 读的就是它（src/skills/panel.js 的 PANEL_DATA_FILE）。
    storage: makeSkillStorage(skillId),
