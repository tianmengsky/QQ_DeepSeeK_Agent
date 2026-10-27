import { turnSessionRow, takeTurnBinding, refreshTurnBinding, sourceTtlMs, closeExecutionSource } from '../agent/execution-scope.mjs';
import { clearActiveConversation } from './execute-turn.mjs';

/**
 * 本轮归属的**收尾权**归谁 —— 这是"想久了就不能用工具"那个 bug 的修法。
 *
 * 归因链有三段：桥接把「DSH Session → 本轮 QQ 会话 + 来源」写进共享库；
 * qq-mcp 按注入的 `source_ref` 逐道核对；模型拿这个归属去调 qq_say / 发文件 /
 * 写工作区。第三段要求归属在**模型还在干活的那段时间里一直有效**。
 *
 * 老实现把"撤归属"塞在 execute-turn 的 finally 里，而那个 finally 的触发点
 * 是 `replyTimeoutMs`（180s）—— 那是"桥接还愿意等多久"，不是"回合结束了"。
 * 线上 2026-10-26 23:54 那一轮「写六博棋 HTML」跑了 6 分钟：
 *   · 15:57:12 桥接超时，finally 把 turn-session 写成 null、执行来源置 closed；
 *   · 15:59:45 模型写好文件，调 qq_send_file —— MCP 查不到 `source_ref`，
 *     直接报"工作区与文件工具只能在本轮 QQ 会话内使用"，用户只看到两次红字；
 *   · 那一轮直到 16:0x 还在 DSH 里跑，最后一段正文也一起丢了。
 * 换句话说：**桥接放弃等待，被当成了回合结束**。工具是回合的副作用，回合没完，
 * 归属就不能没了。
 *
 * 现在两条边界分开：
 *   · 投递等待仍然是 `replyTimeoutMs`（超时后交给回复恢复去重连）；
 *   · 归属跟着 DSH 回合走 —— `turn/end`（或 `error`）到了才撤，模型每走一步
 *     （`agent/pre-step`）就续一次租，于是跑一小时的大活也不会中途失权；
 *     进程崩掉这种谁都没收到 turn/end 的情况，仍由 TTL 兜住。
 *
 * 按 turn 号配对是防"别人的回合结束把我的归属撤了"：绑定里记着自己那轮的
 * turn 号（execute-turn 的 onConsumed 写入），收尾时号对不上就当作没发生。
 */
export function installTurnScopeHooks(ctx, { store, config, logger = ctx?.logger } = {}) {
  if (!store?.available || typeof ctx?.on !== 'function') return false;
  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    if (type !== 'turn/end' && type !== 'error') return;
    const row = turnSessionRow(store, session?.id);
    if (!row) return;
    const ended = event?.data?.turn;
    if (row.turn != null && ended != null && Number(ended) !== Number(row.turn)) return;
    takeTurnBinding(store, session?.id);
    // 执行来源和 floor 标记是同一轮的三块账，必须一起收，否则下一轮会读到
    // "还开着"的来源（表现为戳一戳回合被按已关闭的旧来源拒绝，或反过来）。
    closeExecutionSource(store, row.sourceRef);
    clearActiveConversation(store, row.conversation);
    logger?.info?.(`qq-bridge: 回合结束，撤掉 ${row.conversation} 的本轮归属`);
  }, { global: true });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    refreshTurnBinding(store, agent?.session?.id, sourceTtlMs(config));
    return next();
  }, { global: true });
  return true;
}
