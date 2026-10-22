import { readFloor } from '../conversation/floor.mjs';

const prefix = 'qq-bridge:image-catalog:';

/** Only the host publishes image segments; tool arguments never supply paths or URLs. */
export function publishImageCatalog(store, sourceRef, conversation, messages, ttlMs = 600000, config = {}) {
  if (!store?.available || !sourceRef) return false;
  store.db.prepare('DELETE FROM runtime_state WHERE key LIKE ? AND json_extract(value,\'$.expiresAt\') < ?')
    .run(prefix + '%', Date.now());
  return store.setState(prefix + sourceRef, JSON.stringify({ conversation,
    expiresAt: Date.now() + ttlMs, messages,
    maxImageBytes: Math.min(4 * 1024 * 1024, config.maxImageBytes ?? 4 * 1024 * 1024),
    qqDataPath: config.qqDataPath || '' }));
}

export function readImageCatalog(store, sourceRef, conversation) {
  const value = JSON.parse(store.getState(prefix + sourceRef) ?? 'null');
  if (!value || value.conversation !== conversation || !(value.expiresAt > Date.now()))
    throw new Error('本轮图片目录不存在或已过期；请让对方重新发送或引用目标消息。');
  const recalled = new Set((readFloor(store, conversation).recalled ?? []).map(String));
  return { ...value, messages: value.messages.filter((m) => !recalled.has(m.messageId)) };
}

export function recordImageRead(store, sourceRef, conversation, messageId, imageIndex) {
  const catalog = readImageCatalog(store, sourceRef, conversation);
  const message = catalog.messages.find((m) => m.messageId === messageId);
  if (!message?.images[imageIndex]) throw new Error('目标图片已不在本轮目录中，可能已撤回。');
  message.read = [...new Set([...(message.read ?? []), imageIndex])];
  store.setState(prefix + sourceRef, JSON.stringify(catalog));
}

/** Successful tool reads also count as real pixels for delivery/recovery. */
export function imageReadCount(store, sourceRef, conversation) {
  if (!store?.available || !sourceRef) return 0;
  const catalog = JSON.parse(store.getState(prefix + sourceRef) ?? 'null');
  if (catalog?.conversation !== conversation) return 0;
  return catalog.messages.reduce((n, m) => n + (m.read?.length ?? 0), 0);
}

export function imageCatalogSummary(messages) {
  return messages.map(({ messageId, who, qq, source, images, attached = [], read = [] }) => ({
    message_id: messageId, sender: who || qq || '?', source,
    image_count: images.length, attached_indices: attached, read_indices: read,
  }));
}
