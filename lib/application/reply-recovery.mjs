import { replyJournal } from '../delivery/reply-journal.mjs';
import { queuePersistedPlan } from '../delivery/reply-delivery.mjs';
import { runTurn } from '../agent/runner.mjs';
import { finishReply } from './execute-turn.mjs';
import { admitMessage } from '../domain/admission.mjs';
import { refreshGroupMembers } from '../conversation/names.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
import { taskRegistry } from '../conversation/task-sessions.mjs';

/**
 * Reattach only saved QQ-origin requests, including rotated Sessions.
 *
 * 现在返回 Promise（重试带 @ 的计划前要先拉一次群成员表）—— 调用方
 * 要么 `await` 它拿任务数组，要么自己 `.catch()`，别把它当同步函数用。
 */
export async function recoverReplies(ctx, config, registry, state, memory, stats, store, sendQueue) {
  const journal = state.replyJournal ?? replyJournal(store);
  if (!journal || !state.enabled || state.disposed) return [];
  const tasks = [], blocked = new Set();
  const recovering = state.replyRecoveryActive ??= new Set();
  for (const row of journal.pending()) {
    const key = row.conversation;
    const category = row.state === 'following' ? 'execution' : row.state === 'output' ? 'output' : 'delivery';
    const blockKey = key + ':' + category + (category === 'output' && row.meta.lane === 'task-progress' ? ':progress' : '');
    if (blocked.has(blockKey)) continue;
    // Hold only the uncertain plan. A lost receipt must not mute all later turns.
    if (journal.needsReconciliation(row)) continue;
    /**
     * ⚠️ `blocked` 必须在"这一轮真的要处理这条"之后才记。
     *
     * 放在退避检查之前时，一条处于 30 秒退避中的行会把**同会话同类别**后面的行
     * 全部 `continue` 掉 —— 实测 16 条 `following` 全在同一个群时，只有最旧那条
     * 被反复尝试，另外 11 条 `retry_at` 一直是 0、**从未被尝试过**。
     */
    if (row.retry_at > Date.now() && row.state !== 'attention' ||
        journal.active.has(row.id) || journal.sending.has(row.id)) continue;
    if (row.state === 'following' && recovering.size >= (config.replyRecoveryConcurrency ?? 2)) continue;
    blocked.add(blockKey);
    const signal = state.controller.signal;
    const canSend = () => state.enabled && !state.disposed && !signal.aborted &&
      admitMessage(config, row.meta.event);
    if (!canSend()) continue;
    /**
     * 迟到的回复比不回复更糟。
     *
     * 只拦 `following`／`output`（还没有确认 outcome 的）—— 这类行要靠
     * `runTurn(resume)` 重连 DSH 会话重建结果，而 DSH 会话是持久化在磁盘上的，
     * 几天前的 turn **可能真的重连成功**，于是旧回复被当成"现在该说的话"发出去。
     * 实测：修掉恢复通道的饥饿问题后，一次性迟发了 14 条旧回复（最旧 99 小时）。
     *
     * `planned` 不在此列：它已经拿到确认结果，可能正在合法地等发送配额窗口。
     */
    const staleMaxAge = config.replyStaleDeliveryMaxAgeMs ?? 600000;
    if (['following', 'output'].includes(row.state) &&
        Date.now() - Number(row.created_at ?? Date.now()) > staleMaxAge) {
      const detail = `超过 replyStaleDeliveryMaxAgeMs(${staleMaxAge}ms) 仍未确认结果：放弃迟到的投递，不把旧回复发进群里`;
      journal.abandon(row.id, detail);
      if (row.meta?.executionId && state.taskRouting) {
        try { state.taskRouting.setExecution(row.meta.executionId, 'failed',
          { staleAbandonedAt: Date.now(), staleDetail: detail }); } catch { /* 执行行可能已不在 */ }
      }
      stats.staleRepliesDropped = (stats.staleRepliesDropped ?? 0) + 1;
      ctx.logger?.warn?.(`qq-bridge: 放弃迟到回复 ${row.id}（${((Date.now() - Number(row.created_at)) / 3600000).toFixed(1)}h）`);
      continue;
    }
    if (row.state === 'planned' || row.state === 'attention') {
      /**
       * 重试前先把群成员表拉回来 —— 一条待发的回复里如果有 @，
       * 而名单是冷的（重载后还没拉过），"@ 的人不在群里"就发现不了：
       * 它会被 OneBot 整条退回，然后每 30 秒失败一次，按"不得越过未完成计划"
       * 把该会话后面的回复一起挡住。只在真的带 @ 时才多花这一次 HTTP。
       */
      const hasAt = row.plan?.bubbles?.some(
        (bubble) => Array.isArray(bubble?.mentions) && bubble.mentions.length,
      );
      if (hasAt && row.plan?.target?.group_id != null) {
        try {
          await refreshGroupMembers(config, row.plan.target.group_id, { ctx, stats });
        } catch (error) {
          ctx.logger?.warn?.(
            `qq-bridge: 恢复前拉群成员表失败（${key}）—— ${error?.message ?? error}`,
          );
        }
      }
      queuePersistedPlan(ctx, config, sendQueue, row, { journal, state, stats, memory,
        entry: registry.entry(key), signal, canSend });
      continue;
    }
    journal.active.add(row.id);
    if (row.state === 'following') recovering.add(row.id);
    const task = registry.run(key, async () => {
      if (!canSend()) return;
      let outcome = row.outcome;
      if (row.state === 'following') {
        // Reconstruct an already-owned result; do not publish/overwrite a live tool conversation.
        const scopedRegistry = row.meta.stableTaskId && state.taskRouting?.get(row.meta.stableTaskId)
          ? taskRegistry(registry, state.taskRouting, row.meta.stableTaskId) : registry;
        outcome = await runTurn(ctx, config, scopedRegistry, key, [], stats, {
          sessionId: row.meta.sessionId, resume: row.meta, signal,
          // 恢复尝试用短超时：一个 4 天前的会话重连注定失败，没必要占满 replyTimeoutMs(180s)。
          timeoutMs: config.replyRecoveryTimeoutMs ?? 20000,
          onOutcome(result) { journal.output(row.id, result); state.taskLedger?.outcome(row.id, result);
            if (row.meta.executionId && state.taskRouting) {
              const e = state.taskRouting.execution(row.meta.executionId);
              if (e) { state.taskRouting.summary(e.task_id, e, result); state.taskRouting.setExecution(e.id, 'model_finished'); }
            } },
          onConsumed({ turn }) { state.taskLedger?.set(row.id, 'running', { turn }); },
          onSpeechResult(speech, receipt) {
            state.taskLedger?.progress(row.id, speech, receipt);
            if (receipt.state !== 'SUCCEEDED' || receipt.dryRun || receipt.replayed) return;
            memory?.episodes?.action({ id: receipt.id, sourceRef: row.meta.sourceRef,
              conversation: speech.conversation, text: speech.text || '[图片/表情]',
              state: receipt.state, onebotId: receipt.onebotId });
            if (speech.conversation === key) {
              const entry = registry.entry(key);
              registry.record(entry, { bot: true, qq: '', who: '你', text: speech.text || '[图片/表情]',
                messageId: receipt.onebotId ?? 'tool:' + receipt.id,
                at: receipt.sentAt, timeSource: 'sent' });
              wakeAfterSpeech(config, entry, receipt.sentAt);
            }
          },
        });
      }
      if (canSend()) {
        const result = await finishReply(ctx, config, registry, state, memory, stats, store,
          key, row.meta.event, outcome, { ...row.meta, journal, signal, sendQueue });
        if (result?.wait && row.meta.floorPolicy?.originals && !row.meta.stableTaskId)
          state.inputBatches?.hold(key, row.meta.floorPolicy.originals);
      }
    }, { lane: row.meta.lane === 'task-progress' ? 'task-progress' :
      row.state === 'following' ? 'reply-recovery' : 'reply-output' }).catch((error) => {
      if (state.disposed) return;
      /**
       * `following` 保持 `maxAttempts: 0`（不计数、不放弃）是对的：读 DSH 流失败
       * **不等于**发送失败，不能当"明确失败"处理。
       *
       * 但它因此少了自限。这里用**行龄**做递增退避：越老的行重试越稀，
       * 直到超过 `replyRecoveryMaxAgeMs` 被 taskScheduler.restore() 收敛成终态。
       * 既不像原来那样每 30 秒无限重试，也不误判"可能已发出"的消息。
       */
      const age = Date.now() - Number(row.created_at ?? Date.now());
      const backoff = Math.min(30000 * 2 ** Math.min(5, Math.floor(age / 300000)), 600000);
      journal.error(row.id, error?.message ?? error, {
        // Failure to read a DSH stream is not a definite send failure. Keep its identity for later recovery.
        maxAttempts: row.state === 'following' || error?.code === 'QQ_SEND_QUOTA' ? 0 : config.replyMaxSendAttempts,
        retryAt: error?.retryAt ?? Date.now() + backoff,
      });
      stats.lastError = '回复恢复失败: ' + (error?.message ?? error);
      ctx.logger.warn(stats.lastError);
    }).finally(() => { journal.active.delete(row.id); recovering.delete(row.id); });
    tasks.push(task);
  }
  return tasks;
}
