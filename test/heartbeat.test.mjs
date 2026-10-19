import assert from 'node:assert/strict';
import { Config, __test } from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { assertConfig } from '../lib/config.mjs';
import { runHeartbeat, gateShouldSpeak } from '../lib/application/heartbeat.mjs';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { observeFloor } from '../lib/conversation/floor.mjs';

const settings = {
  heartbeatEnabled: true,
  heartbeatUnreadThreshold: 6,
  heartbeatIdleMs: 60000,
  heartbeatCooldownMs: 0,
  awakeMs: 0,
};
let passed = 0;
const oldFetch = globalThis.fetch;
const rigs = [];
const make = (overrides = {}, llm = no()) => {
  const r = rig({ ...settings, ...overrides }, '接上话题', null, llm);
  rigs.push(r);
  return r;
};
function no(onCheck = () => {}) {
  return {
    async *stream(options) {
      onCheck(options);
      yield { type: 'text-delta', text: '{"speak":false}' };
    },
  };
}
async function feed(r, count, group = 10, offset = 0) {
  for (let i = 0; i < count; i++) await r.post(message(offset + i, '背景' + (offset + i), group));
}
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

try {
  await test('heartbeat outputs use the triggering batch floor and yield to new direct requests', async () => {
    const r = make({ floorManagementEnabled: true, groupTrigger: 'at' },
      { async *stream() { yield { type: 'text-delta', text: '{"speak":true}' }; } });
    const key = 'group:10';
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      const newRequest = message('new-direct', '帮我看一下');
      newRequest.message.unshift({ type: 'at', data: { qq: '100' } });
      observeFloor(r.config, r.registry, key, newRequest);
      yield { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '过时心跳' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    await feed(r, 6);
    await r.sendQueue.flush();
    assert.equal(r.prompts.length, 1); assert.equal(r.calls.length, 0);
    assert.equal(r.stats.floorDeclined, 1);
  });
  await test('default is strictly more than five, and unreachable threshold is rejected', () => {
    assert.equal(Config({}).heartbeatUnreadThreshold, 6);
    assert.equal(Config({}).awakeMs, 60000);
    assert.throws(() => assertConfig(Config({ heartbeatBufferSize: 4 })), /heartbeatBufferSize/);
    assert.throws(() => assertConfig(Config({ heartbeatUnreadThreshold: 5.5 })), /正整数/);
  });
  await test('five unread messages do not infer; sixth immediately judges while group is active', async () => {
    let checks = 0;
    const r = make(
      {},
      no(() => checks++),
    );
    await feed(r, 5);
    await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
    assert.equal(checks, 0);
    assert.equal(r.registry.entry('group:10').pending.length, 5);
    await feed(r, 1, 10, 5);
    assert.equal(checks, 1);
    assert.equal(r.registry.entry('group:10').pending.length, 0);
    assert.equal(r.prompts.length, 0);
    assert.equal(r.calls.length, 0);
  });
  await test('long buffered conversations retain the latest topic in the judgment prompt', async () => {
    let promptText;
    const r = make(
      {},
      no((options) => {
        promptText = options.messages[0].content[0].text;
      }),
    );
    const pending = Array.from({ length: 20 }, (_, i) => ({
      who: '群友',
      text: i === 19 ? '最新话题-唯一标记' : '较早发言'.repeat(100),
    }));
    await gateShouldSpeak(r.ctx, r.config, { pending }, r.stats, r.state.controller.signal);
    assert.ok(promptText.includes('最新话题-唯一标记'));
  });
  await test('declining consumes a batch once and next sixth message triggers a new judgment', async () => {
    let checks = 0;
    const r = make(
      {},
      no(() => checks++),
    );
    await feed(r, 6);
    await feed(r, 5, 10, 6);
    assert.equal(checks, 1);
    await feed(r, 1, 10, 11);
    assert.equal(checks, 2);
    assert.ok(r.registry.entry('group:10').window.length > 0);
  });
  await test('group unread counts never combine', async () => {
    let checks = 0;
    const r = make(
      {},
      no(() => checks++),
    );
    await feed(r, 3, 10);
    await feed(r, 3, 11, 100);
    assert.equal(checks, 0);
    await feed(r, 3, 11, 103);
    assert.equal(checks, 1);
    assert.equal(r.registry.entry('group:10').pending.length, 3);
  });
  await test('heartbeat disabled still buffers but never judges', async () => {
    let checks = 0;
    const r = make(
      { heartbeatEnabled: false },
      no(() => checks++),
    );
    await feed(r, 6);
    assert.equal(checks, 0);
    assert.equal(r.registry.entry('group:10').pending.length, 6);
  });
  await test('directly addressed message consumes background and avoids an extra heartbeat', async () => {
    let checks = 0;
    const r = make(
      {},
      no(() => checks++),
    );
    await feed(r, 5);
    await r.post(message(5, 'deepseek 接一下话题'));
    assert.equal(checks, 0);
    assert.equal(r.prompts.length, 1);
    assert.equal(r.registry.entry('group:10').pending.length, 0);
  });
  await test('overlapping arrivals produce one judgment and preserve newer messages', async () => {
    let release,
      started,
      checks = 0;
    const gate = new Promise((resolve) => (release = resolve)),
      ready = new Promise((resolve) => (started = resolve));
    const r = make(
      {},
      {
        async *stream() {
          checks++;
          started();
          await gate;
          yield { type: 'text-delta', text: '{"speak":false}' };
        },
      },
    );
    for (let i = 0; i < 6; i++) await r.handler(request(message(i)), response());
    await ready;
    for (let i = 6; i < 9; i++) await r.handler(request(message(i)), response());
    const tick = runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
    release();
    await tick;
    await r.drain();
    assert.equal(checks, 1);
    assert.deepEqual(
      r.registry.entry('group:10').pending.map((m) => m.messageId),
      [6, 7, 8],
    );
  });
  await test('one slow group does not block judgments in another group', async () => {
    let release,
      started,
      checks = 0;
    const gate = new Promise((resolve) => (release = resolve)),
      ready = new Promise((resolve) => (started = resolve));
    const r = make(
      {},
      {
        async *stream() {
          const n = ++checks;
          if (n === 1) {
            started();
            await gate;
          }
          yield { type: 'text-delta', text: '{"speak":false}' };
        },
      },
    );
    for (let i = 0; i < 6; i++) await r.handler(request(message(i)), response());
    await ready;
    for (let i = 100; i < 106; i++) await r.handler(request(message(i, '背景', 11)), response());
    await r.registry.entry('group:11').chain;
    assert.equal(checks, 2);
    assert.equal(r.registry.entry('group:11').pending.length, 0);
    release();
    await r.drain();
  });
  await test('six unread bypass cooldown and reset count after decline', async () => {
    let checks = 0;
    const r = make({ heartbeatCooldownMs: 5000 }, no(() => checks++));
    const entry = r.registry.entry('group:10');
    entry.lastSpokeAt = Date.now();
    await feed(r, 5);
    assert.ok(entry.heartbeatTimer);
    assert.equal(checks, 0);
    await feed(r, 1, 10, 5);
    assert.equal(checks, 1);
    assert.equal(entry.pending.length, 0);
    assert.equal(r.stats.lastHeartbeatDecision.trigger, 'unread');
    assert.ok(entry.lastHeartbeatCheckAt >= entry.lastSpokeAt);
    await feed(r, 5, 10, 6);
    assert.equal(checks, 1);
    await feed(r, 1, 10, 11);
    assert.equal(checks, 2);
    assert.equal(entry.pending.length, 0);
  });
  await test('elapsed time triggers fewer than six once; empty buffer never repeats', async () => {
    let checks = 0;
    const r = make({ heartbeatCooldownMs: 60 }, no(() => checks++));
    const entry = r.registry.entry('group:10');
    entry.lastSpokeAt = Date.now();
    await feed(r, 2);
    assert.equal(checks, 0);
    assert.ok(entry.heartbeatTimer);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await r.drain();
    assert.equal(checks, 1);
    assert.equal(r.stats.lastHeartbeatDecision.trigger, 'elapsed');
    assert.equal(entry.pending.length, 0);
    await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
    assert.equal(checks, 1);
  });
  await test('queued backlog consumes exactly six at a time and acknowledges only judged records', async () => {
    let release;
    const blocked = new Promise((resolve) => (release = resolve));
    const r = make({}, no());
    const entry = r.registry.entry('group:10');
    const acked = [];
    const store = { ackEventIds(key, ids) { acked.push(ids); } };
    r.registry.run('group:10', () => blocked);
    for (let i = 0; i < 14; i++) entry.pending.push({qq:'200',text:'消息'+i,messageId:i,eventId:i+1});
    const job = runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats, store);
    release();
    await job;
    await r.drain();
    assert.equal(r.stats.heartbeatChecks, 2);
    assert.deepEqual(acked, [[1,2,3,4,5,6],[7,8,9,10,11,12]]);
    assert.deepEqual(entry.pending.map((m) => m.eventId), [13,14]);
  });
  await test('declined batch is acknowledged in SQLite and its fresh cycle survives registry reload', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-heartbeat-read-'));
    const store = new Store(path.join(temp, 'test.sqlite3'));
    try {
      const r = rig({ ...settings, heartbeatCooldownMs: 5000 }, '', store, no());
      rigs.push(r);
      const entry = r.registry.entry('group:10');
      const spoke = entry.lastSpokeAt = Date.now();
      await feed(r, 6);
      assert.equal(entry.pending.length, 0);
      const rows = store.db.prepare("SELECT acked FROM events WHERE conversation=? AND kind='group_message'").all('group:10');
      assert.equal(rows.length, 6);
      assert.ok(rows.every((row) => row.acked === 1));
      const restored = new __test.ConversationRegistry(r.ctx, r.config, store).entry('group:10');
      assert.equal(restored.lastHeartbeatCheckAt, entry.lastHeartbeatCheckAt);
      assert.equal(restored.window.length, 6);
      assert.equal(entry.lastSpokeAt, spoke);
      assert.equal(entry.awakeUntil, 0);
    } finally { store.db.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
  await test('shutdown cancels pending cooldown timers without sending or inference', async () => {
    let checks = 0;
    const r = make(
      { heartbeatCooldownMs: 500 },
      no(() => checks++),
    );
    const entry = r.registry.entry('group:10');
    entry.lastSpokeAt = Date.now();
    await feed(r, 5);
    assert.ok(entry.heartbeatTimer);
    r.state.persistEnabled(false);
    assert.equal(entry.heartbeatTimer, null);
    assert.equal(checks, 0);
    assert.equal(entry.pending.length, 5);
  });
  await test('failed or malformed judgment retains unread and uses delayed retry', async () => {
    const r = make(
      {},
      {
        async *stream() {
          yield { type: 'text-delta', text: 'invalid JSON' };
        },
      },
    );
    await feed(r, 6);
    assert.equal(r.stats.heartbeatChecks, 1);
    assert.equal(r.stats.heartbeatFailed, 1);
    assert.equal(r.registry.entry('group:10').pending.length, 6);
    await feed(r, 1, 10, 6);
    assert.equal(r.stats.heartbeatChecks, 1);
    assert.ok(r.registry.entry('group:10').heartbeatRetryAt > Date.now());
  });
  await test('successful joining leaves arrivals during inference unread for the next judgment', async () => {
    let started, release;
    const ready = new Promise((resolve) => (started = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    const r = make(
      {},
      {
        async *stream() {
          yield { type: 'text-delta', text: '{"speak":true}' };
        },
      },
    );
    const prompt = r.ctx.sessionController.prompt;
    r.ctx.sessionController.prompt = async (req) => {
      await prompt(req);
      started();
      await gate;
    };
    for (let i = 0; i < 6; i++) await r.handler(request(message(i, '背景' + i)), response());
    await ready;
    await r.handler(request(message(6, '后来到达')), response());
    release();
    await r.drain();
    assert.equal(r.prompts.length, 1);
    assert.equal(r.calls.length, 1);
    assert.equal(r.registry.entry('group:10').pending.length, 1);
    assert.equal(r.registry.entry('group:10').pending[0].text, '后来到达');
    const promptText = r.prompts[0].content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    assert.equal(
      promptText.split('背景5').length - 1,
      1,
      'latest judged message is rendered only once',
    );
    assert.equal(r.registry.entry('group:10').window.filter((m) => m.messageId === '5').length, 1);
  });
  await test('arrivals while a heartbeat session is being created remain unread', async () => {
    let started, release;
    const ready = new Promise((resolve) => (started = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    const r = make({}, {
      async *stream() { yield { type: 'text-delta', text: '{"speak":true}' }; },
    });
    const create = r.ctx.sessionController.create;
    r.ctx.sessionController.create = async () => {
      started();
      await gate;
      return create();
    };
    for (let i = 0; i < 6; i++) await r.handler(request(message(i)), response());
    await ready;
    await r.handler(request(message(6, '新到的未读')), response());
    release();
    await r.drain();
    assert.equal(r.prompts.length, 1);
    assert.deepEqual(r.registry.entry('group:10').pending.map((m) => m.messageId), [6]);
    assert.ok(!JSON.stringify(r.prompts[0].content).includes('新到的未读'));
  });
  await test('group at, name, follow-up and poke all wake through the shared turn pipeline', async () => {
    const r = make({ awakeMs: 30000, selfIds: ['100'], pokeAgentSendPoke: false });
    const at = message(1, '在吗');
    at.message.unshift({ type: 'at', data: { qq: '100' } });
    await r.post(at);
    await r.post(message(2, '接着上一句'));
    await r.post(message(3, '大肥鱼 来看看'));
    await r.post({
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      self_id: 100, user_id: 200, target_id: 100, group_id: 10,
    });
    assert.equal(r.prompts.length, 4);
    assert.equal(r.stats.awakeJoined, 1);
    assert.equal(r.stats.pokeWoke, 1);
    assert.equal(r.calls.filter((c) => c.action === 'send_group_msg').length, 4);
  });
  await test('heartbeat speech opens a 60-second window for unmentioned follow-ups', async () => {
    const r = make({ awakeMs: 60000 }, {
      async *stream() { yield { type: 'text-delta', text: '{"speak":true}' }; },
    });
    await feed(r, 6);
    assert.equal(await r.sendQueue.flush(), true);
    const entry = r.registry.entry('group:10');
    assert.equal(entry.awakeUntil - entry.lastSpokeAt, 60000);
    assert.ok(entry.awakeUntil > Date.now());
    await r.post(message(7, '接着你的话说'));
    assert.equal(r.prompts.length, 2);
    assert.equal(r.stats.awakeJoined, 1);
    assert.equal(entry.pending.length, 0);
  });
  for (const blocked of ['events', 'scheduled', 'waitUntil']) {
    await test(`restored heartbeat yields to blocked input ${blocked} and resumes after release`, async () => {
      let checks = 0;
      const r = make({}, no(() => checks++));
      const key = 'group:10', entry = r.registry.entry(key);
      entry.pending = Array.from({ length: 6 }, (_, i) => ({ qq: '200', text: '背景' + i, messageId: i }));
      const inputs = { events: [], scheduled: false, waitUntil: 0 };
      if (blocked === 'events') inputs.events = [{ __inputPassive: false }];
      if (blocked === 'scheduled') inputs.scheduled = true;
      if (blocked === 'waitUntil') inputs.waitUntil = Date.now() + 30000;
      r.state.inputBatches = { entries: new Map([[key, inputs]]) };
      await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(checks, 0);
      assert.equal(entry.pending.length, 6);
      assert.ok(entry.heartbeatTimer, 'blocked recovery waits on a timer instead of recursively scheduling microtasks');
      assert.ok(entry.heartbeatTimerDueAt > Date.now());
      if (blocked === 'waitUntil') assert.ok(entry.heartbeatTimerDueAt >= inputs.waitUntil);
      inputs.events = []; inputs.scheduled = false; inputs.waitUntil = 0;
      await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
      await r.drain();
      assert.equal(checks, 1);
      assert.equal(entry.pending.length, 0);
      assert.equal(entry.heartbeatTimer, null);
    });
  }
  await test('input arriving after heartbeat scheduling cannot trigger recursive recovery', async () => {
    let release, checks = 0;
    const r = make({}, no(() => checks++));
    const key = 'group:10', entry = r.registry.entry(key);
    r.registry.run(key, () => new Promise((resolve) => { release = resolve; }));
    entry.pending = Array.from({ length: 6 }, (_, i) => ({ qq: '200', text: '背景' + i, messageId: i }));
    const job = runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
    await Promise.resolve();
    const inputs = { events: [], scheduled: true, waitUntil: 0 };
    r.state.inputBatches = { entries: new Map([[key, inputs]]) };
    release();
    await job;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(checks, 0);
    assert.equal(entry.pending.length, 6);
    assert.ok(entry.heartbeatTimerDueAt > Date.now());
    r.state.persistEnabled(false);
    assert.equal(entry.heartbeatTimer, null);
  });
  console.log(`${passed} passed, 0 failed`);
} finally {
  for (const r of rigs) r.state.persistEnabled(false);
  globalThis.fetch = oldFetch;
}
