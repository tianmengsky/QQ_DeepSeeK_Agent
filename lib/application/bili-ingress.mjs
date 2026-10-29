export function normalizeBiliIngress(payload) {
  if (!payload || payload.source !== 'dsh-bili-scroll') return null;
  const uid = String(payload.uid ?? '').trim();
  const messageId = String(payload.messageId ?? '').trim();
  const text = String(payload.text ?? '').trim();
  if (!/^\d{1,20}$/.test(uid) || !messageId || messageId.length > 200 || !text) return null;
  const event = {
    post_type: 'message',
    message_type: 'private',
    self_id: 'bili',
    user_id: uid,
    message_id: messageId,
    time: Number.isFinite(Number(payload.at)) ? Math.floor(Number(payload.at) / 1000) : Math.floor(Date.now() / 1000),
    message: text.slice(0, 6000),
    sender: { user_id: uid, nickname: String(payload.nickname ?? '').slice(0, 100) },
  };
  event.__bridgeSource = 'bili';
  return event;
}
