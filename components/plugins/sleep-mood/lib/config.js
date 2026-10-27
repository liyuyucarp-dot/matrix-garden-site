// 数据根目录：与核心共用**唯一真源**。
//
// 为什么不自己算：DATA_DIR 由 QQ_AGENT_DATA_DIR（显式覆盖）> QQ_AGENT_PROFILE（多实例
// 推导 data-2/）> 默认 data/ 三层决定。插件若自己拼一遍，多实例下会算错根目录 ——
// 表现是"实例 #2 的心情写进了 #1 的目录"，两个机器人的心情互相污染，且极难发现。
//
// 本文件同时充当心情引擎（lib/mood-chain.js、lib/self-state.js）的 './config.js' 依赖：
// 那两个文件只从这里取 DATA_DIR，其余全部零宿主依赖，因此可以原样保留。
//
// lib/ -> mood-chain/ -> plugins/ -> 仓库根
export { DATA_DIR, ROOT } from '../../../src/config.js';
