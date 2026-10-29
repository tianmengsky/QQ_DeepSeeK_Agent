import { Config, __test } from '../../lib/index.js';
import { createHandler } from '../../lib/routes/onebot.mjs';
import { ConversationSendQueue } from '../../lib/delivery/send-queue.mjs';
export function message(id, text = '背景', group = 10, user = 200) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 100,
    user_id: user,
    group_id: group,
    message_id: id,
    message: [{ type: 'text', data: { text } }],
  };
}
export const poke = {
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  self_id: 100,
  user_id: 200,
  target_id: 100,
  time: 999,
};
export const config = (over = {}) =>
  Config({
    agentEnabled: true,
    pokeReplyEnabled: true,
    persistenceEnabled: false,
    memoryEnabled: false,
    contextFromQQHistory: false,
    imagesEnabled: false,
    stickerHints: false,
    replyShapes: [],
    bubbleDelayPerCharMs: 0,
    bubbleDelayMinMs: 0,
    rotateAfterImage: false,
    replyTimeoutMs: 1000,
    // Legacy delivery/heartbeat fixtures test transport, not semantic attention.
    groupAttentionEnabled: false,
    inputDebounceMs: 0,
    // Transport fixtures keep the legacy execution path; task-routing has its own integration suite.
    taskRoutingMode: 'off',
    inputShortDebounceMs: 0,
    floorManagementEnabled: false,
    // 昵称表要打一次 get_group_member_list；离线测试不该有网络副作用。
    // 需要昵称的用例直接给 buildPrompt 传 names，或单独测 buildNameMap。
    resolveAtNames: false,
    heartbeatUnreadThreshold: 1,
    ...over,
  });
export function request(body, method = 'POST') {
  return {
    method,
    headers: {},
    complete: true,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}
export function response() {
  return {
    headersSent: false,
    statusCode: 0,
    writeHead(n) {
      this.headersSent = true;
      this.statusCode = n;
    },
    end() {},
    setHeader() {},
  };
}
export function rig(settings = {}, reply = '你好', store = null, llm = null) {
  const cfg = config(settings),
    calls = [],
    prompts = [],
    warnings = [];
  let sessions = 0;
  const eventListeners = new Map();
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    calls.push({ action, payload: JSON.parse(init?.body ?? '{}') });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data:
            action === 'fetch_custom_face'
              ? ['https://example.invalid/face.png']
              : { message_id: calls.length },
        }),
    };
  };
  const ctx = {
    on: (name, listener) => {
      const listeners = eventListeners.get(name) ?? new Set();
      listeners.add(listener);
      eventListeners.set(name, listeners);
      return () => listeners.delete(listener);
    },
    emit: (name, payload) => {
      for (const listener of eventListeners.get(name) ?? []) listener(payload);
    },
    logger: {
      info() {},
      warn(m) {
        warnings.push(m);
      },
    },
    get: (n) =>
      n === 'llm'
        ? llm
        : n === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
          : undefined,
    sessionController: {
      create: async () => ({ sessionId: 's' + ++sessions }),
      prompt: async (r) => prompts.push(r),
      follow: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'snapshot', cursor: 0 };
          yield {
            type: 'event',
            event: {
              seq: 1,
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text: reply }] } },
            },
          };
          yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
        },
      }),
    },
  };
  const registry = new __test.ConversationRegistry(ctx, cfg, store);
  const state = {
    enabled: true,
    controller: new AbortController(),
    ownMessageIds: new Set(),
    ownMessageConversations: new Map(),
    pendingReactions: new Map(),
  };
  state.persistEnabled = (next) => {
    if (!next) state.controller.abort();
    else if (state.controller.signal.aborted) state.controller = new AbortController();
    state.enabled = next;
  };
  const stats = { posts: 0, accepted: 0, filtered: 0 };
  const sendQueue = new ConversationSendQueue();
  const handler = createHandler(ctx, cfg, registry, state, null, stats, store, { sendQueue });
  const drain = async () => {
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setImmediate(r));
      await Promise.all([...registry.byKey.values()].map((e) => e.chain));
      await new Promise((r) => setImmediate(r));
    }
  };
  const post = async (event) => {
    await handler(request(event), response());
    await drain();
  };
  return {
    config: cfg,
    ctx,
    registry,
    state,
    stats,
    calls,
    prompts,
    warnings,
    handler,
    post,
    drain,
    sendQueue,
  };
}
