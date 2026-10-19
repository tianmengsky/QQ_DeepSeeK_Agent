import { createHash } from 'node:crypto';
import { boundedText, sortWindow } from './context.mjs';

// Only model-visible message fields count. QQ timestamp calibration and local
// retention metadata must not turn a known message into a new prompt copy.
function version(message) {
  return createHash('sha256').update(JSON.stringify([
    Boolean(message.bot), message.bot ? '' : String(message.qq ?? ''),
    message.bot ? '你' : message.who ?? '', boundedText(message.text),
    message.replyToId == null ? null : String(message.replyToId),
    message.mentions ?? [],
  ])).digest('hex');
}

function identity(message) {
  return message.messageId == null
    ? 'local:' + String(message.at ?? message.createdAt ?? '') + ':' + version(message)
    : 'id:' + String(message.messageId);
}

/** Plan without mutation: only successful prompt admission commits the cursor. */
export function planWindowInjection(config, entry, window, current = null) {
  const known = entry.windowHashes ?? {};
  const full = !config.injectWindowOnce || entry.turns === 0;
  const fresh = window.filter((m) => full || known[identity(m)] !== version(m));
  // A new reply may quote a known message. Keep its source beside the new
  // row to preserve speaker attribution even when sending only a delta.
  const targets = new Set(fresh.map((m) => String(m.replyToId ?? '')));
  const messages = sortWindow(window.filter((m) => fresh.includes(m) ||
    m.messageId != null && targets.has(String(m.messageId))));
  const hashes = Object.fromEntries([...messages, ...(current ? [current] : [])]
    .map((m) => [identity(m), version(m)]));
  return { messages, hashes, full, skipped: window.length - messages.length };
}

export function commitWindowInjection(entry, plan) {
  // Bound persisted state even when a profile chooses very long Sessions.
  entry.windowHashes = Object.fromEntries(Object.entries({
    ...(entry.windowHashes ?? {}), ...plan.hashes,
  }).slice(-1000));
}
