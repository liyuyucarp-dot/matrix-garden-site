// tools/fixtures/host-src/llm.js —— 探针桩：不发任何网络请求
export function resolveApiKey() {
  return null;
}

export async function chatCompletion() {
  throw new Error('probe: 探针环境不提供 LLM（这是预期行为）');
}

export default { resolveApiKey, chatCompletion };
