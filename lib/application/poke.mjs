import { admitMessage, isAllowed } from '../domain/admission.mjs';
import { onebotCall } from '../transport/onebot-client.mjs';
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
export function normalizePoke(config, event) {
  const isGroup = event.group_id != null;
  const ids = config.selfIds?.length
    ? config.selfIds.map(String)
    : [String(event.self_id ?? event.target_id ?? '')];
  const candidates = [event.sender_id, event.user_id, event.target_id]
    .filter((x) => x != null)
    .map(String);
  const sender = isGroup
    ? String(event.sender_id ?? event.user_id ?? '')
    : candidates.find((x) => !ids.includes(x));
  const poked = isGroup
    ? ids.includes(String(event.target_id))
    : candidates.some((x) => ids.includes(x));
  if (!poked || !sender || ids.includes(sender)) return null;
  const message = {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    self_id: event.self_id,
    user_id: Number(sender),
    group_id: event.group_id,
    sender: event.sender,
    message_id:
      'poke-' + (isGroup ? event.group_id + '-' : '') + sender + '-' + (event.time ?? Date.now()),
    message: [{ type: 'text', data: { text: '（对方戳了你一下）' } }],
    __poke: true,
    __pokeSender: sender,
  };
  // Older direct notice tests omit privateEnabled; omission is the historical default.
  if (!admitMessage({ ...config, privateEnabled: config.privateEnabled ?? true }, message))
    return null;
  if (isGroup && !isAllowed(config.pokeReplyGroups, event.group_id)) return null;
  return message;
}
export async function processPoke(
  ctx,
  config,
  event,
  state,
  stats,
  store,
  mode = config.pokeReplyMode ?? 'agent',
  { registry = null } = {},
) {
  if (!config.pokeReplyEnabled || state.enabled === false || state.disposed) return null;
  const normalized = normalizePoke(config, event);
  if (!normalized) {
    stats.pokeSkipped = (stats.pokeSkipped ?? 0) + 1;
    return null;
  }
  const agent = mode === 'agent',
    now = Date.now(),
    sender = normalized.user_id;
  const interval = agent ? config.pokeAgentMinIntervalMs : config.pokeReplyMinIntervalMs;
  if (interval > 0 && now - (state.lastPokeAt ?? 0) < interval) {
    stats.pokeThrottled = (stats.pokeThrottled ?? 0) + 1;
    return null;
  }
  if (
    store?.available &&
    !store.consume(
      (agent ? 'pokeAgent:' : 'poke:') + sender,
      3600000,
      agent ? config.pokeAgentPerSenderPerHour : config.pokeReplyPerSenderPerHour,
    ).allowed
  ) {
    stats.pokeThrottled = (stats.pokeThrottled ?? 0) + 1;
    return null;
  }
  state.lastPokeAt = now;
  const isGroup = normalized.message_type === 'group',
    signal = state.controller?.signal;
  if (!agent || config.pokeAgentSendPoke) {
    try {
      await onebotCall(
        config,
        isGroup ? 'group_poke' : 'friend_poke',
        { ...(isGroup ? { group_id: normalized.group_id } : {}), user_id: sender },
        15000,
        signal,
      );
      stats.pokeReplied = (stats.pokeReplied ?? 0) + 1;
    } catch (error) {
      if (!agent) throw error;
      ctx.logger.warn('qq-bridge: 回戳失败 —— ' + error.message);
    }
  }
  if (state.enabled === false || signal?.aborted) return null;
  if (agent) {
    stats.pokeWoke = (stats.pokeWoke ?? 0) + 1;
    return normalized;
  }
  const texts = (config.pokeReplyTexts ?? []).filter((t) => String(t).trim());
  if (texts.length && (!isGroup || config.pokeReplyGroupText)) {
    const seq = (state.pokeSeq = (state.pokeSeq ?? 0) + 1);
    const result = await sendOnebotIdempotent(ctx, config, store, {
      idemKey: normalized.message_id + ':' + seq,
      conversation: isGroup ? 'group:' + normalized.group_id : 'user:' + sender,
      action: isGroup ? 'send_group_msg' : 'send_private_msg',
      target: isGroup ? { group_id: normalized.group_id } : { user_id: sender },
      message: texts[Math.floor(Math.random() * texts.length)],
      signal,
    });
    if (result.sent) {
      stats.pokeTextSent = (stats.pokeTextSent ?? 0) + 1;
      if (registry) wakeAfterSpeech(config, registry.entry(isGroup ? 'group:' + normalized.group_id : 'user:' + sender), result.sentAt);
    }
  }
  return null;
}
