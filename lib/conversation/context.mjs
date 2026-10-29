import { renderMessage, atTargets } from '../domain/events.mjs';

export function validTime(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function qqTime(value) {
  const n = validTime(value);
  return n && n < 100000000000 ? n * 1000 : n;
}

export function contextMessage(event) {
  return {
    source: event.__bridgeSource === 'bili' ? 'bili' : 'qq',
    qq: String(event.user_id ?? event.sender?.user_id ?? ''),
    who: event.sender?.card || event.sender?.nickname || String(event.user_id ?? ''),
    text: renderMessage(event.message),
    messageId: event.message_id == null ? null : String(event.message_id),
    at: qqTime(event.time) || validTime(event.__receivedAt) || Date.now(),
    timeSource: qqTime(event.time) ? 'qq' : 'received',
    sourceSeq: event.message_seq ?? null,
    replyToId: Array.isArray(event.message)
      ? event.message.find((s) => s?.type === 'reply')?.data?.id ?? null : null,
    mentions: atTargets(event.message),
    images: Array.isArray(event.message) ? event.message.filter((s) => s?.type === 'image') : [],
    forwards: Array.isArray(event.message) ? event.message.filter((s) => s?.type === 'forward') : [],
  };
}

export function boundedText(text, max = 2000) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + ' [正文已截断]' : value;
}

export function sortWindow(messages) {
  return messages.slice().sort((a, b) => {
    const time = validTime(a.at) || validTime(a.createdAt), other = validTime(b.at) || validTime(b.createdAt);
    if (time !== other) return time - other;
    // QQ IDs are opaque. Preserve stable input order for same-second bubbles.
    return 0;
  });
}

/** The sole window retention and identity policy. */
export function trimWindow(config, entry) {
  const others = Math.max(0, Number(config.contextOthersMessages ?? 10));
  const own = Math.max(0, Number(config.contextOwnMessages ?? 15));
  let seenOther = 0,
    seenOwn = 0;
  const rounds = Math.max(1, Number(config.windowTurns) || 10);
  const earliest = Math.max(0, (entry.contextTurn ?? 0) - rounds + 1);
  entry.window = sortWindow(entry.window)
    .filter((m) => m.turnIndex == null || m.turnIndex >= earliest)
    .slice()
    .reverse()
    .filter((m) => (m.bot ? ++seenOwn <= own : ++seenOther <= others))
    .reverse();
}
export function recordContext(config, entry, message) {
  const id = message.messageId == null ? null : String(message.messageId);
  if (id && (entry.recalledIds ?? []).includes(id)) return false;
  const existing = id && entry.window.find((m) => String(m.messageId) === id);
  if (existing) {
    existing.turnIndex = Math.max(existing.turnIndex ?? 0, message.turnIndex ?? entry.contextTurn ?? 0);
    if (validTime(message.at) && (message.timeSource === 'qq' ||
      !['qq', 'sent'].includes(existing.timeSource))) {
      existing.at = validTime(message.at);
      existing.timeSource = message.timeSource ?? existing.timeSource;
    }
    if (message.sourceSeq != null) existing.sourceSeq = message.sourceSeq;
    trimWindow(config, entry);
    return false;
  }
  entry.window.push({
    ...message,
    qq: String(message.qq ?? ''),
    who: message.who ?? '',
    text: boundedText(message.text),
    bot: Boolean(message.bot),
    messageId: id,
    images: message.images ?? [],
    forwards: message.forwards ?? [],
    at: validTime(message.at) || validTime(message.createdAt) || Date.now(),
    turnIndex: message.turnIndex ?? entry.contextTurn ?? 0,
  });
  trimWindow(config, entry);
  if (!message.bot && message.qq)
    entry.recentQqs = [
      String(message.qq),
      ...(entry.recentQqs ?? []).filter((x) => x !== String(message.qq)),
    ].slice(0, 6);
  return true;
}
