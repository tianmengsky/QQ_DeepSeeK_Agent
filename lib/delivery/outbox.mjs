import { onebotCall } from '../transport/onebot-client.mjs';
import { loadStoreModule } from '../transport/persistence.mjs';
import { recordSpeech } from '../conversation/activity.mjs';

async function sendOnebotIdempotent(
  ctx,
  config,
  store,
  { idemKey, conversation, action, target, message, signal },
) {
  signal?.throwIfAborted();
  const payload = { ...target, message };

  const conv = String(conversation ?? 'unknown');
  const begin = store?.available
    ? store.reserveSend(
        { idemKey, conversation, kind: action, target: JSON.stringify(target), payload },
        [
          { bucket: 'send:' + conv, windowMs: 60000, limit: config.sendQuotaPerMinute },
          { bucket: 'send:' + conv, windowMs: 3600000, limit: config.sendQuotaPerHour },
        ],
      )
    : { action: 'send', receipt: null };

  if (begin.action === 'replay') {
    ctx.logger.info(`qq-bridge: 幂等重放 ${idemKey}（${begin.receipt.status}，未重发）`);
    return {
      sent: false,
      replayed: true,
      status: begin.receipt.status,
      onebotId: begin.receipt.onebotId,
      sentAt: begin.receipt.status === 'SUCCEEDED' ? begin.receipt.updatedAt : null,
    };
  }
  if (begin.action === 'hold') {
    // 结果未知／还在途。**不许替它做决定**，只如实报告。
    ctx.logger.warn(
      `qq-bridge: ⚠ 发送被幂等闸门拦下（${begin.receipt.status}），需人工核对 —— ${idemKey}`,
    );
    return {
      sent: false,
      held: true,
      status: begin.receipt.status,
      onebotId: begin.receipt.onebotId,
    };
  }
  if (begin.action === 'conflict') {
    throw new Error(`幂等编号冲突：${idemKey} 已存在但内容不同`);
  }

  // 3) 真发
  try {
    const data = await onebotCall(config, action, payload, 15000, signal);
    const onebotId = data?.message_id === undefined ? null : String(data.message_id);
    store?.finishSend(idemKey, 'SUCCEEDED', { onebotId, detail: 'ok' });
    const sentAt = recordSpeech(store, conv);
    return { sent: true, status: 'SUCCEEDED', onebotId, sentAt };
  } catch (error) {
    const { classifySendError, STATUS } = loadStoreModule();
    const status = classifySendError(error);
    store?.finishSend(idemKey, status, { detail: String(error?.message ?? error) });
    if (status === STATUS.UNKNOWN) {
      // 关键：**抛之前先说清楚这是"未知"，不是"失败"**。
      // 让调用方和日志都能区分，避免有人手贱去重试。
      ctx.logger.warn(
        `qq-bridge: ⚠ 发送结果未知（${error?.message ?? error}）—— ${idemKey}，不自动重发，请人工核对`,
      );
    }
    throw error;
  }
}

async function sendBiliIdempotent(ctx, config, store, { idemKey, conversation, target, message, signal }) {
  signal?.throwIfAborted();
  const conv = String(conversation ?? 'unknown');
  const payload = { ...target, message };
  const begin = store?.available
    ? store.reserveSend({ idemKey, conversation: conv, kind: 'bili_send_message',
      target: JSON.stringify(target), payload }, [
      { bucket: 'send:' + conv, windowMs: 60000, limit: config.sendQuotaPerMinute },
      { bucket: 'send:' + conv, windowMs: 3600000, limit: config.sendQuotaPerHour },
    ])
    : { action: 'send', receipt: null };
  if (begin.action === 'replay') return { sent: false, replayed: true, status: begin.receipt.status,
    onebotId: begin.receipt.onebotId, sentAt: begin.receipt.status === 'SUCCEEDED' ? begin.receipt.updatedAt : null };
  if (begin.action === 'hold') return { sent: false, held: true, status: begin.receipt.status, onebotId: begin.receipt.onebotId };
  if (begin.action === 'conflict') throw new Error(`幂等编号冲突：${idemKey} 已存在但内容不同`);
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, new Error('B站私信发送已取消'));
      const timer = setTimeout(() => finish(reject, new Error('B站私信发送等待插件回执超时')), 30000);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        ctx.emit('qq-bridge:send-bili-message', { source: 'dsh-qq-bridge', uid: String(target.receiver_uid),
          message, idemKey, acknowledge: (receipt) => finish(resolve, receipt) });
      } catch (error) { finish(reject, error); }
    });
    if (!result?.sent || !result.msgKey) {
      const error = new Error(result?.error || 'B站工具未确认私信已投递');
      if (result?.unknown || /没有投递回执|结果未知/i.test(error.message)) error.code = 'BILI_SEND_UNKNOWN';
      throw error;
    }
    store?.finishSend(idemKey, 'SUCCEEDED', { onebotId: String(result.msgKey), detail: 'bili tool receipt' });
    const sentAt = recordSpeech(store, conv);
    return { sent: true, status: 'SUCCEEDED', onebotId: String(result.msgKey), sentAt };
  } catch (error) {
    const { classifySendError } = loadStoreModule();
    const status = classifySendError(error);
    store?.finishSend(idemKey, status, { detail: String(error?.message ?? error) });
    if (status === 'UNKNOWN') ctx.logger?.warn?.(
      `qq-bridge: ⚠ B站私信投递结果未知（${error?.message ?? error}）—— ${idemKey}，不自动重发，请人工核对`,
    );
    throw error;
  }
}

export { sendOnebotIdempotent, sendBiliIdempotent };
