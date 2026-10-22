/**
 * 辅助调用失败后的退避阶梯（B2）。
 *
 * 为什么需要：记忆提炼原来失败只 `warn` + 计数，`process()` 由 30 秒定时器驱动，
 * 于是每个会话每 30 秒重试同一批，永不放弃 —— 线上 `memoryExtractFailed=406`
 * 且 `memoryExtractChecks=0`，一条都没成功过，很可能也是把上游打成限流的放大器。
 * 心跳则反过来：一次失败就锁 `heartbeatMs`（10 分钟），线上实测 `retryRemainingMs≈525058`，
 * 于是"临时抖动"和"模型根本不能用"在读数上长得一模一样，插话 0 次。
 *
 * 阶梯：30s → 1m → 2m → 5m 封顶。前几档贴着重试窗口（抖动很快能恢复），
 * 末档足够长（真坏了就别再打上游）。成功或正常判定后清零。
 */

/** 心跳判断失败的重试阶梯。 */
export const HEARTBEAT_RETRY_LADDER = [30000, 60000, 120000, 300000];
/** 记忆提炼失败的重试阶梯（同一套数值，语义独立，将来可以分开调）。 */
export const MEMORY_RETRY_LADDER = [30000, 60000, 120000, 300000];
/** 单批连续失败到这个次数就丢弃，避免无限重试同一批原文。 */
export const MEMORY_MAX_FAILURES = 5;

/**
 * 取第 `failures` 次失败对应的等待毫秒数（failures 从 1 开始，超出阶梯就封顶）。
 *
 * 传 0 或负数按第 1 档处理 —— 调用方拿到的一定是个正数，不会算出一个"立刻重试"。
 */
export function backoffDelay(ladder, failures) {
  const steps = Array.isArray(ladder) && ladder.length ? ladder : HEARTBEAT_RETRY_LADDER;
  const index = Math.min(Math.max(1, Math.floor(Number(failures) || 1)) - 1, steps.length - 1);
  return Math.max(1000, Number(steps[index]) || steps[steps.length - 1]);
}

/** 人类可读的阶梯，写进状态页与日志。 */
export function ladderText(ladder) {
  return ladder.map((ms) => (ms < 60000 ? `${ms / 1000}s` : `${ms / 60000}m`)).join(' → ') + ' 封顶';
}
