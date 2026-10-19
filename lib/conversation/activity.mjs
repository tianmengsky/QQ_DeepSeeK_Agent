/** Shared speech activity: bridge and QQ MCP update this only after a new successful send. */
export function speechStateKey(conversation) {
  return 'qq-bridge:speech:' + String(conversation);
}

export function recordSpeech(store, conversation, at = Date.now()) {
  if (store?.available) {
    try { store.setState(speechStateKey(conversation), JSON.stringify({ at })); } catch {}
  }
  return at;
}

export function wakeAfterSpeech(config, entry, at = Date.now()) {
  entry.lastSpokeAt = Math.max(entry.lastSpokeAt || 0, at);
  const duration = Math.max(0, Number(config.awakeMs) || 0);
  entry.awakeUntil = duration ? Math.max(entry.awakeUntil || 0, at + duration) : 0;
}

/** Sync tool sends and restore the unexpired window after plugin reload. */
export function refreshSpeech(config, entry, store, conversation) {
  if (!store?.available) return null;
  try {
    const speech = JSON.parse(store.getState(speechStateKey(conversation)) ?? 'null');
    if (!Number.isFinite(speech?.at) || speech.at <= 0) return null;
    if (speech.at > (entry.lastSpokeAt || 0)) wakeAfterSpeech(config, entry, speech.at);
    return speech.at;
  } catch { return null; }
}
