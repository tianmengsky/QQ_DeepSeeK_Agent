// stats.lastError 有 13 处赋值点散在 9 个文件里，逐处改容易漏（漏一处的症状是“错误有了、时间还是上一回”）。
// 所以在 stats 建出来的地方装一次访问器：任何一处写 lastError，时间戳跟着走。
function trackLastError(stats, clock = Date.now) {
  if (!stats || typeof stats !== 'object') return stats;
  const existing = Object.getOwnPropertyDescriptor(stats, 'lastError');
  if (existing && typeof existing.get === 'function') return stats;
  let value = stats.lastError ?? null;
  Object.defineProperty(stats, 'lastError', {
    enumerable: true,
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next ?? null;
      stats.lastErrorAt = value ? clock() : null;
    },
  });
  stats.lastErrorAt = null;
  return stats;
}

export { trackLastError };
