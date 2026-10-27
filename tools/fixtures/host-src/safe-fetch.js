// tools/fixtures/host-src/safe-fetch.js —— 探针桩：不联网
// 真实宿主提供带白名单/大小限制的 fetch；探针里一律拒绝，避免构建机偷偷出网。
export async function safeFetch() {
  throw new Error('probe: 不联网（safe-fetch 桩）');
}

export async function safeFetchBinaryToFile() {
  throw new Error('probe: 不联网（safe-fetch 二进制通道桩）');
}

export default { safeFetch, safeFetchBinaryToFile };
