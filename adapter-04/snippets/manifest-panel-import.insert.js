
// [[courtyard:panel]] 插件自带界面（官方 0.4 适配层，2026-10-25）
//   · settingsUi  → 插件自己的设置页模块（前端 import 后调 render/bind）
//   · panels      → configSchema 里 type:'action' + panel 的条目（弹窗里渲染成按钮 + iframe）
import { collectPanels, stripPanelActions } from './panel.js';
