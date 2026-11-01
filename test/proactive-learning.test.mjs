// 按目标学习：她对某个群/某个人说了几句、被接过几次、该不该收住嘴。
//
// 用户的原话（2026-11-01）："她会学习，如果她判断这个人或这个群对她的内容
// 不感兴趣，她会减少频率直到不和这个人或群主动交互。"
//
// 这份测试钉三件事：记账按目标、降频按目标、到 0 时嘴真的被按住——而别的
// 目标一点不受影响（学习不是全局静音）。
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { AgentMemory } from '../lib/memory/agent-memory.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { config as rawConfig } from './helpers/bridge.mjs';
import { sendSelfMessage } from '../lib/delivery/self-send.mjs';
import { buildWorldSnapshot } from '../lib/application/world-snapshot.mjs';
import { frequencyFactor } from '../lib/application/proactive.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function cfgOf(dir) {
  return rawConfig({
    memoryEnabled: true,
    memoryDir: dir,
    groupEnabled: true,
    groups: [],
    privateEnabled: true,
    users: [],
    proactiveEnabled: true,
    proactiveMode: 'prompt',
  });
}

function rig() {
  const dir = `mem-${Math.random().toString(36).slice(2)}`;
  const store = new Store(':memory:');
  const config = cfgOf(dir);
  const memory = new MemoryStore({ logger: { warn() {} } }, config, store);
  store.upsertConversation('group:10', { lastMessageAt: Date.now() - 3600_000 });
  store.upsertConversation('group:11', { lastMessageAt: Date.now() - 3600_000 });
  return { store, config, memory, config2: config };
}

// 一个最小的"她"：学习只依赖 proactive 行，发送走 sendOnebotIdempotent 的替身。
function fakeHost(store, config) {
  return {
    learningFor(conversation, { now = Date.now() } = {}) {
      const history = store.proactiveHistory(conversation, { limit: 12, since: now - 90 * 86400_000 }) ?? [];
      return {
        attempts: history.length,
        answered: history.filter((r) => r?.outcome === 'replied').length,
        factor: frequencyFactor(history, config, now).factor,
      };
    },
  };
}

await test('记三笔"没人接"，回应率就掉到 0', () => {
  const { store, config } = rig();
  const host = fakeHost(store, config);
  for (let i = 0; i < 3; i++) {
    const id = store.recordProactive({
      conversation: 'group:10', kind: 'say', trigger: 'self-time', text: '', ref: 'spine:1',
      idemKey: `spine:${i}:group:10`, status: 'sent',
    });
    store.finishProactiveCheck(Number(id), 'quiet');
  }
  const learned = host.learningFor('group:10');
  assert.equal(learned.attempts, 3);
  assert.equal(learned.answered, 0);
  assert.equal(learned.factor, 0);
});

await test('有人接过，就还是照常去', () => {
  const { store, config } = rig();
  const host = fakeHost(store, config);
  for (let i = 0; i < 3; i++) {
    const id = store.recordProactive({
      conversation: 'group:11', kind: 'say', trigger: 'self-time', text: '', ref: 'spine:1',
      idemKey: `spine:${i}:group:11`, status: 'sent',
    });
    store.finishProactiveCheck(Number(id), i === 0 ? 'quiet' : 'replied');
  }
  const learned = host.learningFor('group:11');
  assert.equal(learned.attempts, 3);
  assert.equal(learned.answered, 2);
  assert.ok(learned.factor >= 0.5, `回应 2/3 应该照常或减半，实际 ${learned.factor}`);
});

await test('学到的记性会按住嘴：那个群发不出去，别的群照常', async () => {
  const { store, config } = rig();
  const host = fakeHost(store, config);
  for (let i = 0; i < 3; i++) {
    const id = store.recordProactive({
      conversation: 'group:10', kind: 'say', trigger: 'self-time', text: '', ref: 'spine:1',
      idemKey: `spine:${i}:group:10`, status: 'sent',
    });
    store.finishProactiveCheck(Number(id), 'quiet');
  }
  const state = { proactive: host };
  const sent = [];
  const registry = {
    entry: () => null,
    persist() {},
  };
  const ctx = { get: () => undefined };

  // 送到 group:10 会被按住，且一条都不该发出去。
  const held = await sendSelfMessage({
    ctx, config, store, registry, state,
    conversation: 'group:10', text: '在吗', idemKey: 'k-10',
  });
  assert.equal(held.sent, false);
  assert.equal(held.status, 'HELD');
  assert.match(held.note, /没人接/u);
  assert.equal(sent.length, 0);

  // 换 group:11（没有记账）不受影响：不再被 HELD（这里没有真 OneBot，
  // 发送本身会失败，但失败≠被她的记性按住，两者必须能区分开）。
  let other = null;
  try {
    other = await sendSelfMessage({
      ctx, config, store, registry, state,
      conversation: 'group:11', text: '在吗', idemKey: 'k-11',
    });
  } catch (error) {
    other = { sent: false, status: 'send-error', note: String(error?.message ?? error) };
  }
  assert.notEqual(other.status, 'HELD');
});

await test('世界快照里写的是"被接过几次"这个事实，不是指令', () => {
  const { store, config, memory } = rig();
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const id = store.recordProactive({
      conversation: 'group:10', kind: 'say', trigger: 'self-time', text: '', ref: 'spine:1',
      idemKey: `snap:${i}:group:10`, status: 'sent',
    });
    store.finishProactiveCheck(Number(id), 'quiet');
  }
  const host = fakeHost(store, config);
  const text = buildWorldSnapshot({
    store, memory, now, learning: (key) => host.learningFor(key),
  });
  assert.match(text, /最近 3 次你在这儿开口，没人接/u);
  assert.doesNotMatch(text, /别再|不许|不准/u);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
