// tools/fixtures/host-src/web-search.js —— 探针桩：不发网络请求
export async function bingSearch() {
  throw new Error('probe: 探针环境不提供联网搜索（这是预期行为）');
}

export default { bingSearch };
