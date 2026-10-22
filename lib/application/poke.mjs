import { admitMessage, isAllowed } from '../domain/admission.mjs';
import { onebotCall } from '../transport/onebot-client.mjs';
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';
import { recordSpeech, wakeAfterSpeech } from '../conversation/activity.mjs';
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
  mode = config.pokeReplyMode ?? 'wake',
  { registry = null } = {},
) {
  if (!config.pokeReplyEnabled || state.enabled === false || state.disposed) return null;
  const normalized = normalizePoke(config, event);
  if (!normalized) {
    stats.pokeSkipped = (stats.pokeSkipped ?? 0) + 1;
    return null;
  }
  const agent = mode === 'agent',
    wake = mode === 'wake',
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
  /**
   * wake 模式：被戳不等于被叫说话。
   *
   * 桥接只做两件事 —— 回戳一下、把这条会话的清醒窗口开到 `awakeMs`。
   * 对方接着真的说了什么，才走普通消息回合决定接不接；没人说话就到此为止。
   * 这样不会每戳一次就生成一句"干嘛"，也不会把"（对方戳了你一下）"这种
   * 桥接合成的句子交给模型评论。
   *
   * 顺序上先开窗口再回戳：回戳要走 OneBot，可能慢或失败，而紧随其后的群消息
   * 不该因为这一下网络等待错过窗口。窗口来自"被戳"这个事实，不是"回戳成功"。
   */
  const waking = wake && isGroup && Number(config.awakeMs) > 0;
  if (waking) {
    stats.pokeWoke = (stats.pokeWoke ?? 0) + 1;
    const key = 'group:' + normalized.group_id,
      entry = registry?.entry(key);
    if (entry) wakeAfterSpeech(config, entry, now);
    // 窗口落在共享 speech 时间戳里，插件重载后 refreshSpeech 还能恢复。
    recordSpeech(store, key, now);
  }
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
      // 回戳只是附赠动作：agent 回合和 wake 窗口都不该被它拖垮。
      if (!agent && !waking) throw error;
      ctx.logger.warn('qq-bridge: 回戳失败 —— ' + error.message);
    }
  }
  if (state.enabled === false || signal?.aborted) return null;
  if (agent) {
    stats.pokeWoke = (stats.pokeWoke ?? 0) + 1;
    return normalized;
  }
  if (wake) return null;
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
