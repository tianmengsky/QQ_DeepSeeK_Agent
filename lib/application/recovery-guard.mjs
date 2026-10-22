/** Contain errors from background callbacks; corrupt storage needs operator attention. */
export function createRecoveryGuard({ state, stats, logger }, action) {
  let paused = false;
  const report = (error) => {
    if (state.disposed) return;
    const detail = String(error?.message ?? error);
    const primaryCode = Number(error?.errcode) & 0xff;
    paused ||= primaryCode === 11 || primaryCode === 26 ||
      /database disk image is malformed|file is not a database/i.test(detail);
    stats.lastError = `后台恢复失败: ${detail}`;
    logger.warn(`qq-bridge: ${stats.lastError}${paused ? '（已暂停这项后台恢复；请检查数据库后重新加载）' : ''}`);
  };
  return (...args) => {
    if (paused || state.disposed) return;
    try {
      return Promise.resolve(action(...args)).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
