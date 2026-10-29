/*
 * 一个会话的"体检报告"。
 *
 * 面板的会话表只告诉你"这个会话有多少条窗口、心跳在哪一步"，看不了窗口里到底是什么。
 * 这里把它摊开：窗口里的消息（按时间顺序）、心跳缓冲、数据库里的事件流、以及那几个
 * 计数器。**只读**——写操作走 `lib/admin/actions.mjs` 那张动作表。
 *
 * 设计上刻意只读内存里的 `registry.byKey` 而不调 `registry.entry(key)`：后者会顺手
 * 新建一个空 entry 塞进 map，等于"看了一眼就多出一个会话"。
 */

const MAX_WINDOW = 40;
const MAX_PENDING = 20;
const MAX_EVENTS = 40;
const TEXT_LIMIT = 240;

function text(value, limit = TEXT_LIMIT) {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  return raw.length > limit ? raw.slice(0, limit) + '…' : raw;
}

function summarizeEvent(message) {
  const payload = message.payload ?? {};
  const body = typeof payload.text === 'string'
    ? payload.text
    : payload.message != null
      ? JSON.stringify(payload.message)
      : '';
  return {
    id: message.id,
    kind: message.kind,
    at: message.createdAt,
    who: text(payload.who ?? payload.sender?.card ?? payload.sender?.nickname ?? '', 40),
    text: text(body),
    deliverable: Boolean(message.deliverable),
    acked: Boolean(message.acked),
  };
}

export function createAdminConversation({ store = null, registry = null, clock = Date.now } = {}) {
  function detail(rawKey) {
    const key = String(rawKey ?? '').trim();
    if (!key) return { ok: false, error: '缺少会话' };
    // 只读，不新建：看一眼不该凭空多出一个会话。
    const entry = registry?.byKey?.get?.(key) ?? null;
    const now = clock();
    const window = Array.isArray(entry?.window) ? entry.window : [];
    const pending = Array.isArray(entry?.pending) ? entry.pending : [];
    let events = [];
    let eventsError = null;
    if (store?.available && typeof store.readEvents === 'function') {
      try {
        events = store.readEvents(key, { limit: MAX_EVENTS, latest: true }).messages.map(summarizeEvent);
      } catch (error) {
        // 库出问题不该让整页打不开：把原因带回去，别假装"没有事件"。
        eventsError = String(error?.message ?? error);
      }
    }
    return {
      ok: true,
      key,
      found: Boolean(entry) || events.length > 0,
      awakeRemainingMs: entry?.awakeUntil > now ? entry.awakeUntil - now : 0,
      turns: Number(entry?.turns) || 0,
      contextTurn: Number(entry?.contextTurn) || 0,
      sessionId: entry?.sessionId ?? null,
      windowSize: window.length,
      lastMessageAt: Number(entry?.lastMessageAt) || null,
      lastSpokeAt: Number(entry?.lastSpokeAt) || null,
      lastHeartbeatCheckAt: Number(entry?.lastHeartbeatCheckAt) || null,
      turnsSinceSticker: entry ? Number(entry.turnsSinceSticker) || 0 : null,
      recentQqs: Array.isArray(entry?.recentQqs) ? entry.recentQqs.slice(0, 6) : [],
      window: window.slice(-MAX_WINDOW).map((message) => ({
        who: text(message.who ?? '', 40),
        qq: message.qq ? String(message.qq) : '',
        text: text(message.text),
        at: message.at ?? null,
        bot: Boolean(message.bot),
        turnIndex: Number(message.turnIndex) || 0,
        images: Array.isArray(message.images) ? message.images.length : 0,
        forwards: Array.isArray(message.forwards) ? message.forwards.length : 0,
      })),
      pending: pending.slice(-MAX_PENDING).map((message) => ({
        who: text(message.who ?? '', 40),
        text: text(message.text),
        at: message.at ?? message.createdAt ?? null,
      })),
      events,
      eventsError,
    };
  }

  return { detail, MAX_WINDOW, MAX_EVENTS };
}
