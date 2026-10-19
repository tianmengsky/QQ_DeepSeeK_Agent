import { onebotCall } from '../transport/onebot-client.mjs';
import { renderMessage } from '../domain/events.mjs';
import { contextMessage, boundedText, sortWindow, qqTime, validTime } from './context.mjs';

async function refreshWindowFromQQHistory(ctx, config, registry, entry, key, stats) {
  if (!config.contextFromQQHistory) return 0;
  if (!String(key).startsWith('group:')) return 0; // 只对群；私聊另说

  const groupId = String(key).split(':')[1];
  const ttl = Math.max(0, Number(config.contextHistoryCacheMs) || 0);
  const now = Date.now();

  // TTL 内且上次成功过 → 直接用上次的结果（避免每轮都打一次 HTTP）
  if (entry.historyFetchedAt && ttl > 0 && now - entry.historyFetchedAt < ttl) {
    return 0;
  }

  let list;
  try {
    const data = await onebotCall(config, 'get_group_msg_history', {
      group_id: Number(groupId),
      count: Math.max(5, Math.min(100, Number(config.contextHistoryCount) || 25)),
    });
    list = data?.messages;
  } catch (error) {
    // 回读失败不能影响发言：记一笔统计，退回原本的内存窗口
    stats.historyFetchFailed = (stats.historyFetchFailed ?? 0) + 1;
    ctx.logger.warn(`qq-bridge: 回读群 ${groupId} 历史失败 —— ${error?.message ?? error}`);
    return 0;
  }
  if (!Array.isArray(list) || !list.length) {
    entry.historyFetchedAt = now;
    return 0;
  }

  /**
   * 转成窗口条目。
   *
   * 几个要点：
   *  · 判断"是不是我自己说的"用 sender.user_id 和 selfIds 比 —— 这样
   *    她自己的话也能进窗口（以前只有内存里的记录，重载就丢了）。
   *  · 非文字内容（表情包/图片/语音）也保留一个占位，因为"有人发了个表情"
   *    本身是语境，但正文不能是空串。
   *  · 跳过 air/占位类型。
   */
  const fresh = [];
  for (const m of list) {
    if ((entry.recalledIds ?? []).includes(String(m.message_id))) continue;
    const uid = String(m?.sender?.user_id ?? m?.user_id ?? '');
    const isSelf = (config.selfIds ?? []).map(String).includes(uid);
    const text = boundedText(renderMessage(m?.message));
    if (!text) continue;
    fresh.push({
      ...contextMessage({ ...m, user_id: uid }),
      qq: uid,
      messageId: m.message_id == null ? null : String(m.message_id),
      who: isSelf ? '你' : m?.sender?.card || m?.sender?.nickname || uid || '?',
      text,
      bot: isSelf,
      images: Array.isArray(m?.message) ? m.message.filter((s) => s?.type === 'image') : [],
      /** 标记来源，便于排查"这条是回读来的还是实时收来的" */
      fromHistory: true,
      turnIndex: entry.contextTurn ?? 0,
      at: qqTime(m?.time),
      timeSource: qqTime(m?.time) ? 'qq' : undefined,
    });
  }
  if (!fresh.length) {
    entry.historyFetchedAt = now;
    return 0;
  }

  // QQ 历史可能滞后或不足 N 条；保留本地已确认的内容，按 ID 合并后排序裁剪。
  const before = entry.window.length;
  const local = new Map(entry.window.filter((m) => m.messageId != null).map((m) => [String(m.messageId), m]));
  const merged = new Map();
  for (const m of fresh) {
    const old = m.messageId == null ? null : local.get(String(m.messageId));
    merged.set(m.messageId == null ? m : String(m.messageId), {
      ...m, ...(old ?? {}), fromHistory: true,
      at: m.at || validTime(old?.at),
      timeSource: m.timeSource ?? old?.timeSource,
      sourceSeq: m.sourceSeq,
    });
  }
  for (const m of entry.window) {
    const id = m.messageId == null ? m : String(m.messageId);
    // Keep the protocol timestamp above; local restore time must not overwrite it.
    if (!merged.has(id)) merged.set(id, m);
  }
  entry.window = sortWindow([...merged.values()]);
  registry.trimWindow(entry);
  entry.recentQqs = [...new Set(
    entry.window.slice().reverse().filter((m) => !m.bot && m.qq).map((m) => m.qq),
  )].slice(0, 6);
  entry.historyFetchedAt = now;
  stats.historyRefreshed = (stats.historyRefreshed ?? 0) + 1;
  ctx.logger.info(
    `qq-bridge: 用 QQ 历史刷新窗口 —— ${fresh.length} 条（原 ${before} 条），` +
      `最新「${fresh[fresh.length - 1].text.slice(0, 24)}」`,
  );
  return fresh.length;
}

export { refreshWindowFromQQHistory };
