/**
 * 收殓"没人认领的回合"。
 *
 * 背景：`bridge_tasks` 里的 `running` 只有人把状态推走才会变。桥接被杀、HMR 重载、
 * 模型链路断在半路——这些回合会永远停在 `running`。实测线上最老的 `running` 已经
 * 放了十一天，`tasks.running` 因此长期显示 3，`/status` 的"她正在做"是假的。
 *
 * 收殓规则（不删数据，只改说法）：
 *   running 超过 `taskAbandonHours`（默认 12h）→ recovering（"待核对，不能说仍在做"）
 *   recovering 超过 `taskGiveUpDays`（默认 7 天）→ failed（"没有回执，不能算做完"）
 *
 * 为什么不是直接 failed：`recovering` 是账本里已有的语义（"需要核对"），
 * 直接判死会把"可能真做了一半"的东西一起丢掉；而 `recovering` 放太久也应当收场。
 */
export function reapAbandonedTasks({ store, config = {}, now = Date.now() } = {}) {
  const report = { running: 0, recovering: 0, skipped: '' };
  if (!store?.available || !store.db) {
    report.skipped = 'store-unavailable';
    return report;
  }
  const abandonHours = Math.max(1, Number(config.taskAbandonHours) || 12);
  const giveUpDays = Math.max(1, Number(config.taskGiveUpDays) || 7);
  const runningCutoff = Number(now) - abandonHours * 3600000;
  const recoveringCutoff = Number(now) - giveUpDays * 86400000;
  try {
    const running = store.db
      .prepare("SELECT id FROM bridge_tasks WHERE state = 'running' AND updated_at < ?")
      .all(runningCutoff);
    for (const row of running) {
      store.db
        .prepare(
          `UPDATE bridge_tasks SET state = 'recovering', progress = ?, progress_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running'`,
        )
        .run(`超时 ${abandonHours} 小时没有回执：重启时收尾，不再算"还在做"`, Number(now), Number(now), row.id);
      report.running += 1;
    }
    const stuck = store.db
      .prepare("SELECT id FROM bridge_tasks WHERE state = 'recovering' AND updated_at < ?")
      .all(recoveringCutoff);
    for (const row of stuck) {
      store.db
        .prepare(
          `UPDATE bridge_tasks SET state = 'failed', progress = ?, progress_at = ?, updated_at = ?
           WHERE id = ? AND state = 'recovering'`,
        )
        .run(`放了 ${giveUpDays} 天仍没有回执：不能算做完`, Number(now), Number(now), row.id);
      report.recovering += 1;
    }
    return report;
  } catch (error) {
    report.skipped = String(error?.message ?? error);
    return report;
  }
}
