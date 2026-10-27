/**
 * Contain errors from background callbacks; corrupt storage needs operator attention.
 *
 * 2026-10-27 加了一道**自愈窗**。原来的语义是"看见 malformed / not a database 就永久
 * 暂停"，可这类错误常常是瞬时的（磁盘抖动、WAL 被别的进程摸了一下）：线上那次事后
 * `PRAGMA integrity_check` 是 ok，恢复循环却已经停了 —— 而它停摆的表现不是报错，是
 * **群里一条正文都不再出现**（`bridge_replies` 里全是 planned，没人去发），一直等到
 * 人工重载才通。
 *
 * 所以：暂停后每隔 `retryMs` 让 `probe()` 摸一下库，**摸通了就自动接着跑**并留一条
 * warn。没传 `probe` 的守卫保持老语义（永远等人工）—— 启动时的状态重建不该自动重放
 * 一个可能真坏了的库。真损坏时 probe 自己也会失败，于是继续退避，不会越修越坏。
 */
export function createRecoveryGuard(
  { state, stats, logger, probe, retryMs = 60000, label = '后台恢复' },
  action,
) {
  let paused = false;
  let pausedAt = 0;
  let resumed = 0;

  const publish = () => {
    stats.recovery = { ...(stats.recovery ?? {}),
      [label]: { paused, since: paused ? pausedAt : 0, resumed } };
  };
  publish();

  const report = (error) => {
    if (state.disposed) return;
    const detail = String(error?.message ?? error);
    const primaryCode = Number(error?.errcode) & 0xff;
    const damaged = primaryCode === 11 || primaryCode === 26 ||
      /database disk image is malformed|file is not a database/i.test(detail);
    if (damaged && !paused) {
      paused = true;
      pausedAt = Date.now();
      publish();
    }
    stats.lastError = `后台恢复失败: ${detail}`;
    logger.warn(`qq-bridge: ${stats.lastError}${paused
      ? (probe
        ? `（${label}已暂停；每 ${Math.round(retryMs / 1000)}s 自检一次，库恢复可用就自动接着跑）`
        : `（${label}已暂停；请检查数据库后重新加载）`)
      : ''}`);
  };

  /** true = 可以继续跑。暂停中且自检通过时顺手解除暂停。 */
  const healthy = () => {
    if (!paused) return true;
    if (typeof probe !== 'function') return false;
    if (Date.now() - pausedAt < retryMs) return false;
    let ok = false;
    try { ok = probe() !== false; } catch { ok = false; }
    if (!ok) { pausedAt = Date.now(); return false; }
    paused = false;
    resumed += 1;
    publish();
    logger.warn(`qq-bridge: ${label}已恢复运行（数据库自检通过，本次暂停 ` +
      `${Math.round((Date.now() - pausedAt) / 1000)}s）`);
    return true;
  };

  return (...args) => {
    if (state.disposed || !healthy()) return;
    try {
      return Promise.resolve(action(...args)).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
