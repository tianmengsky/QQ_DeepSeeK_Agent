import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __test } from '../lib/index.js';
import { Store } from '../lib/store.mjs';
import { runHeartbeat } from '../lib/application/heartbeat.mjs';
import { buildPromptContent } from '../lib/prompt/prepare.mjs';
import { createControlHandler } from '../lib/routes/control.mjs';
import { rig, config, message, poke, request, response } from './helpers/bridge.mjs';
const realFetch = globalThis.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bug-regressions-'));
const stores = [];
let passed = 0;
const db = () => {
  const s = new Store(path.join(root, stores.length + '.sqlite3'));
  stores.push(s);
  return s;
};
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name, e);
    process.exitCode = 1;
  }
}
const yes = {
  async *stream() {
    yield { type: 'text-delta', text: '{"speak":true}' };
  },
};
const opts = (r) => ({
  entry: r.registry.entry('group:10'),
  memory: null,
  stats: r.stats,
  key: 'group:10',
  reply: '你好',
  target: { group_id: 10 },
  isGroup: true,
});
await test('B01 private poke respects user whitelist and private switch', async () => {
  for (const settings of [{ users: ['300'] }, { privateEnabled: false }]) {
    const r = rig({ selfIds: ['100'], ...settings });
    await r.post(poke);
    assert.equal(r.prompts.length, 0);
    assert.equal(r.calls.length, 0);
  }
});
await test('B02 excluded group is neither buffered nor addressed by heartbeat', async () => {
  const r = rig(
    {
      groups: ['11'],
      heartbeatEnabled: true,
      heartbeatIdleMs: 0,
      heartbeatCooldownMs: 0,
      selfIds: ['100'],
    },
    '你好',
    null,
    yes,
  );
  await r.post(message(1));
  await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
  assert.equal(r.registry.entry('group:10').pending.length, 0);
  assert.equal(r.calls.length, 0);
});
await test('B03 awake never admits bot self messages', async () => {
  const r = rig();
  r.registry.entry('group:10').awakeUntil = Date.now() + 10000;
  await r.post(message(1, '自己发的话', 10, 100));
  assert.equal(r.prompts.length, 0);
});
await test('B04 rotation injects persona on each new session and only counts agent turns', async () => {
  const r = rig({ persona: 'UNIQUE-PERSONA', rotateEveryTurns: 2 });
  for (let i = 0; i < 6; i++) await r.post(message(i, '背景'));
  assert.equal(r.registry.entry('group:10').turns, 0);
  for (let i = 6; i < 9; i++) await r.post(message(i, 'deepseek 你好'));
  assert.deepEqual(
    r.prompts.map((p) => p.sessionId),
    ['s1', 's1', 's2'],
  );
  assert.deepEqual(
    r.prompts.map((p) => p.content[0].text.includes('UNIQUE-PERSONA')),
    [true, false, true],
  );
});
await test('archived persisted group sessions are replaced before prompt submission', async () => {
  const store = db();
  const first = rig({ awakeMs: 0, persona: 'ARCHIVE-PERSONA' }, '你好', store);
  await first.post(message(1, 'deepseek 你好'));
  first.sendQueue.dispose();
  const second = rig({ awakeMs: 0, persona: 'ARCHIVE-PERSONA' }, '你好', store);
  const get = second.ctx.get;
  second.ctx.get = (name) => name === 'workspaceRegistry'
    ? { archivedSessionIds: ['s1'] } : get(name);
  second.ctx.sessionController.create = async () => ({ sessionId: 'new-unarchived' });
  await second.post(message(2, 'ARCHIVE-BACKGROUND'));
  const at = message(3, ' ');
  at.message.unshift({ type: 'at', data: { qq: '100' } });
  await second.post(at);
  assert.equal(second.prompts[0].sessionId, 'new-unarchived');
  assert.match(JSON.stringify(second.prompts[0].content), /ARCHIVE-PERSONA/);
  assert.match(JSON.stringify(second.prompts[0].content), /ARCHIVE-BACKGROUND/);
  assert.equal(second.registry.entry('group:10').turns, 1);
  const saved = JSON.parse(store.getState('qq-bridge:conversation:group:10'));
  assert.equal(saved.sessionId, 'new-unarchived');
  second.sendQueue.dispose();
});
await test('archiving a live reused session creates a fresh session on the next wake', async () => {
  const archived = [];
  const r = rig({ awakeMs: 0 });
  const get = r.ctx.get;
  r.ctx.get = (name) => name === 'workspaceRegistry' ? { archivedSessionIds: archived } : get(name);
  await r.post(message(1, 'deepseek 在吗'));
  await r.post(message(2, 'deepseek 接着聊'));
  archived.push('s1');
  await r.post(message(3, 'deepseek 醒醒'));
  assert.deepEqual(r.prompts.map((p) => p.sessionId), ['s1', 's1', 's2']);
  r.sendQueue.dispose();
});
await test('blocked turns report the session and do not infer a permission setting', async () => {
  const r = rig();
  r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'snapshot', cursor: 0 };
    yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
    yield { type: 'event', event: { seq: 2, type: 'turn/end',
      data: { turn: 1, reason: { kind: 'blocked' } } } };
  } });
  await r.post(message(1, 'deepseek 在吗'));
  assert.match(r.stats.lastError, /group:10 \/ s1/);
  assert.match(r.stats.lastError, /agent\/pre-step/);
  assert.doesNotMatch(r.stats.lastError, /danger-full-access|approval/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.stats.lastTurn.sessionId, 's1');
  r.sendQueue.dispose();
});
await test('legacy off omits reasoning control and replaces the incompatible saved binding', async () => {
  for (const effort of ['off', 'low']) {
    const r = rig({ llmProvider: 'qq-provider', llmModel: 'qq-model', llmReasoningEffort: effort });
    const selections = [];
    r.ctx.sessionController.selectModel = async (request) => {
      selections.push(request);
      if (request.reasoningEffort === 'off') throw Error('UNSUPPORTED_REASONING_EFFORT');
      return { selected: request };
    };
    if (effort === 'off') {
      const entry = r.registry.entry('group:10');
      entry.sessionId = 'incompatible-old';
      entry.turns = 1;
      entry.sessionSignature = JSON.stringify(['', '', 'qq-provider', 'qq-model', 'off']);
    }
    await r.post(message(1, 'deepseek 在吗'));
    assert.equal(r.prompts[0].sessionId, 's1');
    assert.equal(selections.length, 1);
    assert.equal(selections[0].provider, 'qq-provider');
    assert.equal(selections[0].model, 'qq-model');
    assert.equal(selections[0].reasoningEffort, effort === 'off' ? undefined : 'low');
    r.sendQueue.dispose();
  }
});
await test('model errors retain their exact code and message in the bridge status', async () => {
  const r = rig();
  const failure = { code: 'UNSUPPORTED_REASONING_EFFORT', message: '模型不支持 off' };
  r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'snapshot', cursor: 0 };
    yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
    yield { type: 'event', event: { seq: 2, type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: failure } } } };
  } });
  await r.post(message(1, 'deepseek 在吗'));
  assert.deepEqual(r.stats.lastTurn.failure, failure);
  assert.match(r.stats.lastError, /UNSUPPORTED_REASONING_EFFORT.*模型不支持 off/);
  assert.equal(r.calls.length, 0);
  r.sendQueue.dispose();
});
await test('B05 later turns include new background even when memory is disabled', async () => {
  const r = rig({ awakeMs: 0 });
  await r.post(message(1, 'deepseek 你好'));
  await r.post(message(2, 'UNIQUE-BACKGROUND'));
  await r.post(message(3, 'deepseek 刚才说啥'));
  assert.ok(r.prompts[1].content[0].text.includes('UNIQUE-BACKGROUND'));
});
await test('B06 concurrent group cannot overwrite local image flags', async () => {
  const r = rig({}, '这张图真好看');
  let unblock, started;
  const gate = new Promise((resolve) => (unblock = resolve)),
    ready = new Promise((resolve) => (started = resolve));
  const original = r.ctx.sessionController.prompt;
  r.ctx.sessionController.prompt = async (req) => {
    await original(req);
    if (req.sessionId === 's1') {
      started();
      await gate;
    }
  };
  const e = message(1, 'deepseek 看图');
  e.message.push({ type: 'image', data: { file: 'missing.png' } });
  const p1 = r.post(e);
  await ready;
  const p2 = r.post(message(2, 'deepseek 你好', 11));
  while (r.prompts.length < 2) await new Promise((resolve) => setImmediate(resolve));
  unblock();
  await Promise.all([p1, p2]);
  assert.ok(!r.calls.some((c) => c.action === 'send_group_msg' && c.payload.group_id === 10));
  assert.ok(r.calls.some((c) => c.payload.group_id === 11));
});
await test('B07 HTTP 500 and malformed success remain UNKNOWN', async () => {
  for (const [status, body] of [
    [500, { error: 'failed' }],
    [200, { error: 'failed' }],
    [200, { status: 'ok', retcode: 0, data: {} }],
  ]) {
    const s = db(),
      r = rig({}, '你好', s);
    globalThis.fetch = async () => ({
      ok: status === 200,
      status,
      text: async () => JSON.stringify(body),
    });
    await assert.rejects(() =>
      __test.sendOnebotIdempotent(r.ctx, r.config, s, {
        idemKey: 'x',
        conversation: 'group:10',
        action: 'send_group_msg',
        target: { group_id: 10 },
        message: 'x',
      }),
    );
    assert.equal(s.getReceipt('x').status, 'UNKNOWN');
  }
});
await test('B08 failed and partial sends record only successful bubbles', async () => {
  const r = rig({ maxBubbles: 3 });
  let n = 0;
  globalThis.fetch = async () => {
    if (++n === 2) throw new Error('fetch failed');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: n } }),
    };
  };
  await __test.deliverReply(r.ctx, r.config, { ...opts(r), reply: '第一条\n\n第二条' });
  assert.deepEqual(
    r.registry.entry('group:10').window.map((m) => m.text),
    ['第一条'],
  );
  const f = rig();
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };
  assert.equal(await __test.deliverReply(f.ctx, f.config, opts(f)), false);
  assert.equal(f.registry.entry('group:10').window.length, 0);
});
await test('B09 image switches also block history attachments', async () => {
  for (const settings of [{ imagesEnabled: false }, { imagesEnabled: true, imageMode: 'never' }]) {
    const r = rig({ ...settings, contextImagesOnRequest: 1 });
    let fetched = 0;
    globalThis.fetch = async () => {
      fetched++;
      throw Error('not expected');
    };
    const p = await buildPromptContent(r.ctx, r.config, message(1, '看看图'), r.stats, {
      windowMessages: [
        { images: [{ type: 'image', data: { url: 'https://example.invalid/p.png' } }] },
      ],
    });
    assert.equal(p.filter((p) => p.type === 'image').length, 0);
    assert.equal(fetched, 0);
  }
});
await test('B12 heartbeat normalizes mixed SKIP without const exception', async () => {
  const r = rig(
    { heartbeatEnabled: true, heartbeatIdleMs: 0, heartbeatCooldownMs: 0, selfIds: ['100'] },
    '[SKIP] 我还是想说一句',
    null,
    yes,
  );
  r.registry.buffer(r.registry.entry('group:10'), { qq: '200', text: '背景' });
  await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
  assert.equal(r.calls.at(-1).payload.message, '我还是想说一句');
});
await test('B13 text poke is lightweight and does not submit an agent prompt', async () => {
  const r = rig({ selfIds: ['100'], pokeReplyMode: 'text', pokeReplyMinIntervalMs: 0 });
  await r.post(poke);
  assert.equal(r.prompts.length, 0);
  assert.ok(r.calls.some((c) => c.action === 'friend_poke'));
  assert.ok(r.calls.some((c) => c.action === 'send_private_msg'));
});
await test('B14 replay does not spend quota; rejected reservation rolls back', async () => {
  const s = db(),
    r = rig({ sendQuotaPerMinute: 1 }, '', s),
    send = {
      idemKey: 'x',
      conversation: 'group:10',
      action: 'send_group_msg',
      target: { group_id: 10 },
      message: 'x',
    };
  await __test.sendOnebotIdempotent(r.ctx, r.config, s, send);
  const replay = await __test.sendOnebotIdempotent(r.ctx, r.config, s, send);
  assert.equal(replay.replayed, true);
  assert.equal(s.usageOf('send:group:10', 60000), 1);
  await assert.rejects(
    () => __test.sendOnebotIdempotent(r.ctx, r.config, s, { ...send, idemKey: 'y' }),
    /配额/,
  );
  assert.equal(s.getReceipt('y'), null);
});
await test('B15 hour boundary keeps minute and hour counters distinct', () => {
  const s = db(),
    now = 1800000000000;
  s.consume('send', 60000, 10, { now });
  s.consume('send', 3600000, 10, { now });
  assert.equal(s.usageOf('send', 60000, { now }), 1);
  assert.equal(s.usageOf('send', 3600000, { now }), 1);
});
await test('B16 sparse conversation retention counts rows, not global ids', () => {
  const s = db();
  s.recordEvent({ conversation: 'group:10', payload: { text: 'old' } });
  for (let i = 0; i < 20; i++)
    s.recordEvent({ conversation: 'group:11', payload: { text: 'other' } });
  s.recordEvent({ conversation: 'group:10', payload: { text: 'new' } });
  s.pruneEvents('group:10', 10);
  assert.equal(s.eventCount('group:10'), 2);
});
await test('B17 declined heartbeat preserves background in window', async () => {
  const r = rig({ heartbeatEnabled: true, heartbeatIdleMs: 0, heartbeatCooldownMs: 0 }, '', null, {
    async *stream() {
      yield { type: 'text-delta', text: '{"speak":false}' };
    },
  });
  const e = r.registry.entry('group:10');
  r.registry.buffer(e, { qq: '200', text: '重要背景' });
  await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
  assert.equal(e.pending.length, 0);
  assert.equal(e.window[0].text, '重要背景');
});
await test('B18 heartbeat-off background is bounded', async () => {
  const r = rig({ heartbeatEnabled: false, heartbeatBufferSize: 10 });
  for (let i = 0; i < 45; i++) await r.post(message(i));
  const e = r.registry.entry('group:10');
  assert.equal(e.pending.length, 10);
  assert.equal(e.pendingContext?.length ?? 0, 0);
});
await test('B19 repeated grant and event restoration is idempotent', () => {
  const s = db(),
    r = rig({}, '', s);
  s.recordEvent({ conversation: 'group:10', payload: { text: 'x', qq: '200' }, deliverable: true });
  s.createGrant({ id: 'g', conversations: ['group:10'], capabilities: ['send_text'] });
  assert.equal(r.registry.restoreFromStore(), 1);
  assert.equal(r.registry.restoreFromStore(), 0);
  assert.equal(r.registry.entry('group:10').pending.length, 1);
});
await test('B20 own-only history is restored without pending background', () => {
  const s = db(),
    r = rig({}, '', s);
  s.recordEvent({
    conversation: 'group:10',
    kind: 'self_message',
    payload: { text: '之前说过' },
    deliverable: false,
  });
  assert.equal(r.registry.restoreConversation('group:10'), 1);
  assert.equal(r.registry.entry('group:10').window[0].text, '之前说过');
});
await test('B21 zero own-context cap keeps no bot messages', () => {
  const r = rig({ contextOwnMessages: 0 }),
    e = r.registry.entry('group:10');
  r.registry.record(e, { bot: true, text: 'x' });
  assert.equal(e.window.length, 0);
});
await test('B22 sticker-only success updates cooldown; replay is not another send', async () => {
  const s = db(),
    r = rig({}, '', s),
    o = { ...opts(r), reply: '[表情:1]', store: s, turnId: 'sticker' };
  assert.equal(await __test.deliverReply(r.ctx, r.config, o), true);
  assert.ok(o.entry.lastSpokeAt);
  assert.equal(await __test.deliverReply(r.ctx, r.config, o), false);
  assert.equal(r.stats.stickersSent, 1);
});
await test('B22b 收藏顺序翻转后，[表情:N] 仍发目录里那一条（按身份键，不按位置）', async () => {
  const catalogFile = path.join(root, 'flipped-catalog.json');
  const face = (token) => `https://p.qpic.cn/qq_expression/1/1_0_0_0_${token}_0_0/0`;
  const want = face('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const other = face('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  fs.writeFileSync(catalogFile, JSON.stringify([
    { n: 1, desc: '得意指着人', key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  ]));
  const r = rig({ stickerCatalogPath: catalogFile }, '', db());
  const inner = globalThis.fetch;
  // 现场就是这样：列表把 want 排到了第二位（整份倒序），按位置取第 1 个会发成 other。
  globalThis.fetch = async (url, init) => {
    if (String(url).split('/').pop() === 'fetch_custom_face') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ status: 'ok', retcode: 0, data: [other, want] }),
      };
    }
    return inner(url, init);
  };
  try {
    await __test.deliverReply(r.ctx, r.config, { ...opts(r), reply: '[表情:1]', turnId: 'flipped' });
  } finally {
    globalThis.fetch = inner;
  }
  const sent = r.calls.filter((c) => c.action === 'send_group_msg').at(-1);
  assert.equal(
    sent?.payload?.message?.[0]?.data?.file,
    want,
    '编号 #1 必须发目录里那一条，而不是当前列表第一个',
  );
});
await test('B23 queued turn stops when disabled through control route', async () => {
  const r = rig();
  let unblock;
  const gate = new Promise((resolve) => (unblock = resolve));
  r.registry.entry('group:10').chain = gate;
  const pending = r.post(message(1, 'deepseek 你好'));
  await new Promise((resolve) => setImmediate(resolve));
  const h = createControlHandler(r.ctx, r.config, r.state);
  await h(request({ enabled: false }), response());
  unblock();
  await pending;
  assert.equal(r.prompts.length, 0);
  assert.equal(r.calls.length, 0);
});
await test('in-flight turn aborts before egress and can be resumed with a new generation', async () => {
  const r = rig();
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const original = r.ctx.sessionController.prompt;
  r.ctx.sessionController.prompt = async (req) => {
    await original(req);
    started();
    await new Promise(() => {});
  };
  const pending = r.post(message(1, 'deepseek 你好'));
  await ready;
  r.state.persistEnabled(false);
  await pending;
  assert.equal(r.calls.length, 0);
  r.state.persistEnabled(true);
  r.ctx.sessionController.prompt = original;
  await r.post(message(2, 'deepseek 又来了'));
  assert.equal(r.calls.length, 1);
});
await test('new background during inference survives the current reply', async () => {
  const r = rig();
  let unblock, started;
  const gate = new Promise((resolve) => (unblock = resolve)),
    ready = new Promise((resolve) => (started = resolve));
  const original = r.ctx.sessionController.prompt;
  r.ctx.sessionController.prompt = async (req) => {
    await original(req);
    started();
    await gate;
  };
  const pending = r.post(message(1, 'deepseek 你好'));
  await ready;
  await r.handler(request(message(2, '后来到达')), response());
  unblock();
  await pending;
  assert.equal(r.registry.entry('group:10').pending[0].text, '后来到达');
});
await test('heartbeat has one owner and only acknowledges the judged snapshot', async () => {
  let unblock, started;
  const gate = new Promise((resolve) => (unblock = resolve)),
    ready = new Promise((resolve) => (started = resolve));
  const llm = {
    async *stream() {
      started();
      await gate;
      yield { type: 'text-delta', text: '{"speak":false}' };
    },
  };
  const s = db(),
    r = rig({ heartbeatEnabled: true, heartbeatIdleMs: 0, heartbeatCooldownMs: 0 }, '', s, llm),
    e = r.registry.entry('group:10');
  r.registry.buffer(e, { qq: '200', text: 'first', conversation: 'group:10' });
  const pending = runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats, s);
  await ready;
  r.registry.buffer(e, { qq: '200', text: 'second', conversation: 'group:10' });
  await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats, s);
  unblock();
  await pending;
  assert.deepEqual(
    e.pending.map((m) => m.text),
    ['second'],
  );
  assert.equal(
    s.readEvents('group:10', { latest: true }).messages.find((m) => m.payload.text === 'second')
      .acked,
    false,
  );
});
await test('memory summary does not overwrite a concurrent append', async () => {
  const cfg = config({
    memoryEnabled: true,
    memoryDir: path.join(root, 'memory'),
    memoryMaxEntries: 4,
  });
  const r = rig();
  const memory = new __test.MemoryStore(r.ctx, cfg);
  for (let i = 0; i < 5; i++) memory.append('200', '甲', 'memo' + i);
  let append = true;
  await memory.trim('200', '甲', async () => {
    if (append) {
      append = false;
      memory.append('200', '甲', 'new concurrent memory');
    }
    return 'summary';
  });
  assert.ok(memory.read('200').includes('new concurrent memory'));
});
await test('heartbeat shutdown interrupts a provider that ignores cancellation', async () => {
  let started;
  const ready = new Promise((resolve) => (started = resolve));
  const llm = {
    async *stream() {
      started();
      await new Promise(() => {});
    },
  };
  const r = rig(
    { heartbeatEnabled: true, heartbeatIdleMs: 0, heartbeatCooldownMs: 0 },
    '',
    null,
    llm,
  );
  const entry = r.registry.entry('group:10');
  r.registry.buffer(entry, { qq: '200', text: '尚未判断的消息' });
  const running = runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
  await ready;
  r.state.persistEnabled(false);
  await running;
  assert.equal(r.state.heartbeatRunning, false);
  assert.equal(entry.pending.length, 1);
  assert.equal(r.calls.length, 0);
});
await test('a turn only consumes its own conversation reactions', async () => {
  const r = rig();
  r.state.pendingReactions.set('a', { conversation: 'group:10', userId: '200', emojiId: '1' });
  r.state.pendingReactions.set('b', { conversation: 'group:11', userId: '201', emojiId: '2' });
  await r.post(message(1, 'deepseek 你好'));
  assert.equal(r.state.pendingReactions.has('a'), false);
  assert.equal(r.state.pendingReactions.has('b'), true);
});

await test('each turn tells the agent that actions need a real tool call', async () => {
  const event = { ...message(1, 'deepseek 改群名'), sender: { nickname: '天梦·幻', card: '' } };
  const shape = { bubbles: 2, sticker: false };
  const first = __test.buildPrompt(event, config(), {
    includeStatic: true,
    shape,
    stickerAllowed: false,
  });
  assert.ok(first.includes('【要动手的事，就真的动手】'));
  assert.ok(first.includes('先调工具再报告'));
  const later = __test.buildPrompt(event, config(), {
    includeStatic: false,
    shape,
    stickerAllowed: false,
  });
  assert.ok(later.includes('【要动手的事，就真的动手】'));
});

await test('poke and heartbeat keep their own participation rules instead of ordinary group-message rules', () => {
  const event = message(1, 'CURRENT-BODY');
  for (const awake of [false, true]) {
    for (const trigger of [{ poke: true }, { heartbeat: true }]) {
      const prompt = __test.buildPrompt(event, config(), { includeStatic: false, awake, ...trigger });
      assert.equal(prompt.includes('【要不要搭话】'), false);
      assert.equal(prompt.includes('【你还醒着】'), false);
      assert.ok(prompt.includes(trigger.poke ? '【这是戳一戳，不是消息】' : '【这是你自己想插一句】'));
      assert.ok(prompt.includes('[SKIP]'));
      assert.ok(prompt.endsWith('CURRENT-BODY'));
    }
  }
  assert.ok(__test.buildPrompt(event, config(), { includeStatic: false }).includes('【要不要搭话】'));
  assert.ok(__test.buildPrompt(event, config(), { includeStatic: false, awake: true }).includes('【你还醒着】'));
});

await test('session survives registry reload and rotates only after ten submitted turns', async () => {
  const store = db();
  const first = rig({ rotateEveryTurns: 10, persona: 'RELOAD-PERSONA' }, '你好', store);
  for (let i = 1; i <= 6; i++) await first.post(message(i, 'deepseek 你好'));
  const second = rig({ rotateEveryTurns: 10, persona: 'RELOAD-PERSONA' }, '你好', store);
  second.ctx.sessionController.create = async () => ({ sessionId: 'after-reload' });
  for (let i = 7; i <= 11; i++) await second.post(message(i, 'deepseek 你好'));
  assert.deepEqual(
    second.prompts.map((p) => p.sessionId),
    ['s1', 's1', 's1', 's1', 'after-reload'],
  );
  assert.deepEqual(
    second.prompts.map((p) => p.content[0].text.includes('RELOAD-PERSONA')),
    [false, false, false, false, true],
  );
});
await test('prompt ends with the current message even with poke, reactions and tone anchor', async () => {
  const event = { ...message(1, 'CURRENT-BODY'), sender: { nickname: '甲' } };
  const text = __test.buildPrompt(
    event,
    config({ memoryEnabled: true, memoryAutoExtract: false, toneAnchor: 'TONE' }),
    {
    includeStatic: false,
    memoryText: 'MEMORY',
    windowText: 'WINDOW',
    poke: true,
    reactions: [{ messageId: '77', add: ['赞'] }],
    },
  );
  assert.ok(text.endsWith('CURRENT-BODY'));
  assert.ok(text.indexOf('MEMORY') < text.indexOf('WINDOW'));
  assert.ok(text.indexOf('WINDOW') < text.indexOf('—— 现在这条消息 ——'));
  assert.ok(text.includes('【记忆写入提醒】'));
});
await test('archive-only memory remains known and long memory retains the latest fact', async () => {
  const ev = message(1, 'deepseek 你好');
  const archived = '# 甲（QQ 200）\n## 记忆\n\n## 早期（已摘要）\n- 曾经告诉我喜欢音乐';
  const memory = { read: () => archived, countEntries: () => 0 };
  const text = __test.buildMemorySection(config({ memoryEnabled: true }), ev, {}, memory);
  assert.ok(text.includes('喜欢音乐'));
  memory.read = () =>
    '# 甲（QQ 200）\n## 记忆\n' + '- 较早事实\n'.repeat(400) + '- LATEST-FACT\n## 早期（已摘要）';
  const long = __test.buildMemorySection(config({ memoryEnabled: true }), ev, {}, memory);
  assert.ok(long.includes('LATEST-FACT'));
  memory.read = () =>
    '# 甲（QQ 200）\n## 记忆\n- LATEST-FACT\n## 早期（已摘要）\n' + '- 老归档\n'.repeat(500);
  const archivedLong = __test.buildMemorySection(config({ memoryEnabled: true }), ev, {}, memory);
  assert.ok(archivedLong.includes('LATEST-FACT'));
  assert.ok(archivedLong.length < 1900);
});

await test('multi-at keeps the addressee in the prompt', async () => {
  const event = {
    post_type: 'message',
    message_type: 'group',
    self_id: 100,
    user_id: 200,
    group_id: 10,
    message: [
      { type: 'at', data: { qq: '200' } },
      { type: 'text', data: { text: ' 你把 ' } },
      { type: 'at', data: { qq: '100' } },
      { type: 'text', data: { text: ' 的管理员下了' } },
    ],
    sender: { nickname: '天梦·幻', card: '' },
  };
  const names = new Map([
    ['200', '天梦·幻'],
    ['100', 'DeepSeek大肥鱼'],
  ]);
  const prompt = __test.buildPrompt(event, config(), { names, includeStatic: false });
  // 说话对象（开头 @ 的那个人）必须留在正文里
  assert.ok(prompt.includes('@天梦·幻 你把 @你 的管理员下了'), prompt.slice(-400));
  assert.equal(prompt.includes('@200'), false);
  // 并且要明说这条不是对它说的
  assert.ok(prompt.includes('不是你'));
  assert.ok(prompt.includes('你是被提及的客体') && prompt.includes('按原作者请求归属理解'));
});

await test('handler-level: a twice-at message keeps the addressee', async () => {
  const r = rig();
  await r.post({
    ...message(1, ''),
    message: [
      { type: 'at', data: { qq: '200' } },
      { type: 'text', data: { text: ' 你把 ' } },
      { type: 'at', data: { qq: '100' } },
      { type: 'text', data: { text: ' 的管理员下了' } },
    ],
    sender: { nickname: '天梦·幻', card: '' },
  });
  const text = r.prompts[0]?.content?.[0]?.text ?? '';
  // 发言人自己那个 @ 免费就有昵称（事件里带着），不用查成员表；
  // 关键是不能被吞掉、也不能让机器人以为在使唤它。
  assert.ok(text.includes('@天梦·幻 你把 @你 的管理员下了'), text.slice(-320));
  assert.ok(text.includes('你是被提及的客体') && text.includes('按原作者请求归属理解'));
});

await test('group member names are fetched once and cached', async () => {
  __test.clearNameCache();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: [
            { user_id: 200, nickname: '天梦·幻', card: '' },
            { user_id: 100, nickname: 'DeepSeek大肥鱼', card: '小鲸鱼' },
          ],
        }),
    };
  };
  const cfg = config({ resolveAtNames: true, groupMemberCacheMs: 60000 });
  const event = {
    message_type: 'group',
    group_id: 10,
    user_id: 200,
    sender: { nickname: '天梦·幻' },
  };
  const first = await __test.buildNameMap(cfg, event, {});
  const second = await __test.buildNameMap(cfg, event, {});
  assert.equal(calls, 1);
  // 群名片优先于昵称
  assert.equal(first.get('100'), '小鲸鱼');
  assert.equal(second.get('100'), '小鲸鱼');
  // 关掉开关就一次都不打（发言人名字仍然免费拿到，只是不再查群成员表）
  __test.clearNameCache();
  const off = await __test.buildNameMap(config({ resolveAtNames: false }), event, {});
  assert.equal(calls, 1);
  assert.equal(off.has('100'), false);
  assert.equal(off.get('200'), '天梦·幻');
  globalThis.fetch = realFetch;
});

await test('qq_say progress preserves a new final result and sticker, only removing the exact echo', async () => {
  for (const final of ['等下我去看看\n\n查到了\n\n[表情:1]', '等下我去看看\n\n[表情:1]']) {
    const r = rig({ stickerHints: true, awakeMs: 0 });
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
      yield event(1, 'turn/start', { turn: 1 });
      yield event(2, 'tool/call', { turn: 1, callId: 'progress', name: 'qq_say',
        arguments: JSON.stringify({ conversation: 'group:10', text: '等下我去看看' }) });
      yield event(3, 'tool/result', { turn: 1, callId: 'progress', message: { isError: false } });
      yield event(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: final }] } });
      yield event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    } });
    await r.post(message(800, 'deepseek 帮我查查'));
    assert.equal(await r.sendQueue.flush(), true);
    const sent = r.calls.filter((c) => c.action === 'send_group_msg');
    assert.equal(sent.some((c) => c.payload.message === '等下我去看看'), false);
    assert.equal(sent.some((c) => c.payload.message === '查到了'), final.includes('查到了'));
    assert.equal(sent.filter((c) => Array.isArray(c.payload.message) && c.payload.message[0]?.type === 'image').length, 1);
    assert.equal(r.stats.stickersSuppressed ?? 0, 0);
    r.sendQueue.dispose();
  }
});

await test('six simultaneous senders in one group or two groups keep all replies and sticker deliveries', async () => {
  for (const groups of [[10], [10, 11]]) {
    const r = rig({ awakeMs: 0 });
    const busy = new Set();
    r.ctx.sessionController.follow = ({ address }) => ({ async *[Symbol.asyncIterator]() {
      const id = address.sessionId;
      assert.equal(busy.has(id), false, 'same session must not run concurrently');
      busy.add(id);
      yield { type: 'snapshot', cursor: 0 };
      const prompt = r.prompts.findLast((p) => p.sessionId === id);
      const source = { rpcId: prompt.requestId };
      const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
      yield event(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source }] });
      yield event(2, 'turn/start', { turn: 1 });
      yield event(3, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
      await new Promise((resolve) => setImmediate(resolve));
      const tag = [...prompt.content[0].text.matchAll(/QUESTION-\d+/g)].at(-1)?.[0];
      yield event(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: tag + '\n\n[表情:1]' }] } });
      busy.delete(id);
      yield event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    } });
    await Promise.all(Array.from({ length: 6 }, (_, i) =>
      r.handler(request(message(900 + i, 'deepseek QUESTION-' + i, groups[i % groups.length], 300 + i)), response())));
    await r.drain();
    assert.equal(await r.sendQueue.flush(), true);
    assert.equal(r.prompts.length, 6);
    assert.ok(r.prompts.every((p) => p.mode === 'queue'));
    const sent = r.calls.filter((c) => c.action === 'send_group_msg');
    assert.deepEqual(sent.filter((c) => typeof c.payload.message === 'string').map((c) => c.payload.message).sort(),
      Array.from({ length: 6 }, (_, i) => 'QUESTION-' + i));
    assert.equal(sent.filter((c) => Array.isArray(c.payload.message)).length, 6);
    for (const c of sent.filter((c) => typeof c.payload.message === 'string'))
      assert.equal(c.payload.group_id, groups[Number(c.payload.message.split('-')[1]) % groups.length]);
    assert.equal(r.stats.noTextTurns ?? 0, 0);
    r.sendQueue.dispose();
  }
});

await test('wake starts on the send receipt, rather than when a reply is queued', async () => {
  const r = rig({ awakeMs: 60000 });
  let started, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    started();
    await gate;
    return { ok: true, status: 200, text: async () =>
      JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  await r.post(message(1000, 'deepseek 在吗'));
  await ready;
  const entry = r.registry.entry('group:10');
  assert.equal(entry.awakeUntil, 0);
  assert.equal(entry.lastSpokeAt, 0);
  release();
  assert.equal(await r.sendQueue.flush(), true);
  assert.equal(entry.awakeUntil - entry.lastSpokeAt, 60000);
  assert.ok(entry.awakeUntil > Date.now());
  r.sendQueue.dispose();
});

await test('failed sends and pure SKIP never create or shorten a wake window', async () => {
  const failed = rig({ awakeMs: 60000 });
  globalThis.fetch = async () => { throw Error('fetch failed'); };
  await failed.post(message(1001, 'deepseek 在吗'));
  await failed.sendQueue.flush();
  assert.equal(failed.registry.entry('group:10').awakeUntil, 0);
  failed.sendQueue.dispose();
  const silent = rig({ awakeMs: 60000 }, '[SKIP]');
  const entry = silent.registry.entry('group:10');
  entry.awakeUntil = Date.now() + 59000;
  const deadline = entry.awakeUntil;
  await silent.post(message(1002, '别人之间的闲聊'));
  assert.equal(entry.awakeUntil, deadline);
  assert.equal(silent.calls.length, 0);
  silent.sendQueue.dispose();
});

await test('each successful bubble or sticker refreshes wake, and replay does not', async () => {
  const store = db(), r = rig({ awakeMs: 60000 }, '你好', store);
  const entry = r.registry.entry('group:10');
  const originalNow = Date.now;
  let now = originalNow();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { now += 100; return fetch(...args); };
  Date.now = () => now;
  try {
    await __test.deliverReply(r.ctx, r.config, { ...opts(r), reply: '一句\n\n两句\n\n[表情:1]', turnId: 'wake-bubbles', store });
    assert.equal(entry.lastSpokeAt, now);
    assert.equal(entry.awakeUntil, now + 60000);
    const deadline = entry.awakeUntil;
    now += 1000;
    await __test.deliverReply(r.ctx, r.config, { ...opts(r), reply: '一句\n\n两句\n\n[表情:1]', turnId: 'wake-bubbles', store });
    assert.equal(entry.awakeUntil, deadline);
    assert.equal(r.calls.filter((c) => c.action === 'send_group_msg').length, 3);
  } finally { Date.now = originalNow; r.sendQueue.dispose(); }
});

await test('unexpired speech wakes survive registry reload and expire after 60 seconds', async () => {
  const store = db(), r = rig({ awakeMs: 60000 }, '你好', store);
  await r.post(message(1003, 'deepseek 在吗'));
  await r.sendQueue.flush();
  const expected = r.registry.entry('group:10').awakeUntil;
  r.sendQueue.dispose();
  const resumed = rig({ awakeMs: 60000 }, '接上了', store);
  assert.equal(resumed.registry.entry('group:10').awakeUntil, expected);
  await resumed.post(message(1004, '插件重载后接着说'));
  await resumed.sendQueue.flush();
  assert.equal(resumed.stats.awakeJoined, 1);
  const originalNow = Date.now;
  const expiredAt = resumed.registry.entry('group:10').awakeUntil + 1;
  Date.now = () => expiredAt;
  try {
    await resumed.post(message(1005, '窗口到期后的背景'));
    assert.equal(resumed.prompts.length, 1);
    assert.equal(resumed.registry.entry('group:10').pending.length, 1);
  } finally { Date.now = originalNow; resumed.sendQueue.dispose(); }
});

await test('a successful sticker tool followed by SKIP still wakes the group', async () => {
  const r = rig({ awakeMs: 60000 });
  r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'snapshot', cursor: 0 };
    const event = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
    yield event(1, 'turn/start', { turn: 1 });
    yield event(2, 'tool/call', { turn: 1, callId: 'image', name: 'mcp__qq__qq_send_custom_face',
      arguments: JSON.stringify({ group_id: 10, index: 1 }) });
    yield event(3, 'tool/result', { turn: 1, callId: 'image', message: { content: [{ type: 'text', text: '已发送到群 10。message_id=123' }] } });
    assert.ok(r.registry.entry('group:10').awakeUntil > Date.now(), 'wake should be set before turn/end');
    yield event(4, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '[SKIP]' }] } });
    yield event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  } });
  await r.post(message(1006, 'deepseek 发张表情'));
  const entry = r.registry.entry('group:10');
  assert.equal(entry.awakeUntil - entry.lastSpokeAt, 60000);
  assert.equal(r.calls.length, 0, 'bridge should not emit extra text');
  assert.equal(r.stats.noTextTurns ?? 0, 0);
  r.sendQueue.dispose();
});

await test('text poke replies wake the group even without persistence or an agent turn', async () => {
  const r = rig({ awakeMs: 60000, pokeReplyMode: 'text', pokeReplyTexts: ['干嘛'],
    pokeReplyMinIntervalMs: 0, pokeReplyGroupText: true });
  await r.post({ ...poke, group_id: 10 });
  const entry = r.registry.entry('group:10');
  assert.equal(entry.awakeUntil - entry.lastSpokeAt, 60000);
  assert.equal(r.prompts.length, 0);
  await r.post(message(1007, '接着聊'));
  assert.equal(r.prompts.length, 1);
  assert.equal(r.stats.awakeJoined, 1);
  r.sendQueue.dispose();
});

globalThis.fetch = realFetch;
for (const s of stores) s.db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(passed + ' passed, ' + (process.exitCode ? 'failures' : '0 failed'));
