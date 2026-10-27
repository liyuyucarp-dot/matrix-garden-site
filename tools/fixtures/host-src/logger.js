// tools/fixtures/host-src/logger.js —— 探针桩
export const logger = {
  info: (...a) => console.log('[probe:info]', ...a),
  warn: (...a) => console.warn('[probe:warn]', ...a),
  error: (...a) => console.error('[probe:error]', ...a),
  debug: () => {}
};

export default logger;
