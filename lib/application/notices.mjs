import { normalizePoke, processPoke } from './poke.mjs';
import { isAllowed } from '../domain/admission.mjs';
import { onebotCall } from '../transport/onebot-client.mjs';
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';

async function handlePokeNotice(ctx, config, event, state, stats, store) {
  if (!config.pokeReplyEnabled || state.enabled === false) return false;
  if (!normalizePoke({ ...config, pokeReplyGroups: [] }, event)) return false;
  const before = stats.pokeReplied ?? 0;
  await processPoke(ctx, config, event, state, stats, store, 'text');
  return (
    (stats.pokeReplied ?? 0) > before || Boolean(stats.pokeThrottled) || Boolean(stats.pokeSkipped)
  );
}

async function handleReactionNotice(ctx, config, event, state, stats, store) {
  /**
   * 先把两个容器准备好。
   *
   * 踩过一个坑：原来只在"确认是给自己的"那条分支里才 create
   * `pendingReactions`，于是"忽略别人的赞"和"老会话没有这个字段"两条路径
   * 之后去读它 `.size` 会直接抛 —— 一个纯粹的初始化问题，却表现为
   * 处理表情回应报错。容器初始化要放在函数最前面，别放在分支里。
   */
  state.ownMessageIds ??= new Set();
  state.pendingReactions ??= new Map();

  const messageId = String(event.message_id ?? '');
  if (!messageId) return false;

  const isMine = state.ownMessageIds.has(messageId);
  const likes = Array.isArray(event.likes) ? event.likes : [];
  const emojiIds = likes
    .map((l) => l?.emoji_id ?? l?.emojiId)
    .filter((x) => x !== undefined && x !== null)
    .map(String);

  stats.reactionsSeen = (stats.reactionsSeen ?? 0) + 1;

  if (!isMine) {
    // 不是她的消息 —— 只计数，不进提示词，免得它自作多情
    stats.reactionsIgnored = (stats.reactionsIgnored ?? 0) + 1;
    return true;
  }

  const isAdd = event.is_add !== false;
  const entry = {
    ...(state.pendingReactions.get(messageId) ?? {
      messageId,
      add: [],
      remove: [],
      at: Date.now(),
    }),
    conversation:
      state.ownMessageConversations?.get(messageId) ??
      (event.group_id != null ? 'group:' + event.group_id : null),
  };
  entry.add = [...entry.add];
  entry.remove = [...entry.remove];
  const bucket = isAdd ? entry.add : entry.remove;
  for (const e of emojiIds.length ? emojiIds : ['?']) {
    if (!bucket.includes(e)) bucket.push(e);
  }
  entry.at = Date.now();
  state.pendingReactions.set(messageId, entry);

  ctx.logger.info(
    `qq-bridge: 你的消息 ${messageId} 被${isAdd ? '加' : '撤'}了表情回应（${emojiIds.join(',') || '?'}）`,
  );
  return true;
}

export { handlePokeNotice, handleReactionNotice };
