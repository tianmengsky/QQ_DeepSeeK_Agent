/**
 * 输入重叠的影子读数（只记录，不改变发送时机）。
 *
 * 背景：现在"先等合并窗口，再生成"，两段时间串起来。想验证的改法是
 * "第一条就到点开跑，但仍守在窗口之后才发"。上线前先量三件事：
 *   · savedMs  能省多少（窗口与生成重叠的部分）
 *   · heldMs   生成比窗口快时，要扣着不发多久（抢答风险）
 *   · late     生成期间又来了几条（重叠时需要合并或留给下一轮）
 *
 * 这里断言的是影子样本本身，以及"它没有提前派发"——影子绝不能改变行为。
 */
import assert from 'node:assert/strict';
import { InputBatches } from '../lib/conversation/input-batches.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 1500) => {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error('condition timeout');
    await sleep(5);
  }
};
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e.stack); }
}

function harness({ genMs = 30, debounce = 50, queueDelay = 0 } = {}) {
  const config = {
    inputDebounceMs: debounce, inputShortDebounceMs: debounce, inputMaxWaitMs: 400,
    inputBatchMaxMessages: 24, floorWaitMs: 30000,
    groupEnabled: true, groups: [], selfIds: [],
  };
  const entry = { recalledIds: [] };
  const registry = { entry: () => entry, store: null,
    run: async (key, fn) => { if (queueDelay) await sleep(queueDelay); return fn(); } };
  const state = { enabled: true, disposed: false, controller: new AbortController(), taskScheduler: null };
  const stats = {};
  const starts = [];
  const run = async () => { starts.push(Date.now()); await sleep(genMs); return { endReason: 'stop', reply: '好' }; };
  const batches = new InputBatches({ config, registry, state, stats, run, onError: (error) => { throw error; } });
  return { batches, entry, stats, starts, debounce };
}

const event = (id, text = '你好', user = 200) => ({
  message_id: id, user_id: user, self_id: 100, message_type: 'group', group_id: 10,
  message: [{ type: 'text', data: { text } }], __receivedAt: Date.now(),
});

await test('生成比窗口慢：影子给出"省下整个窗口"，不需要扣着不发', async () => {
  const h = harness({ genMs: 140, debounce: 50 });
  const addedAt = Date.now();
  h.batches.add('group:10', event('1'));
  try {
    await until(() => h.batches.entry('group:10').shadow?.length === 1);
    const sample = h.batches.entry('group:10').shadow[0];
    assert.ok(h.starts[0] - addedAt >= h.debounce - 10, '影子不能让它提前开始：仍然要等窗口');
    assert.ok(sample.waitMs >= h.debounce - 10, `waitMs=${sample.waitMs}`);
    // 影子生成 140ms > 窗口 50ms → 省下的就是窗口本身（允许 15ms 抖动）。
    assert.ok(sample.savedMs >= h.debounce - 15, `savedMs=${sample.savedMs}`);
    assert.ok(sample.savedMs <= sample.waitMs + 15, `savedMs=${sample.savedMs} 不应超过窗口 ${sample.waitMs}`);
    assert.equal(sample.heldMs, 0, '生成比窗口慢时没有"扣着不发"');
    assert.equal(sample.late, 0);
    assert.equal(h.stats.overlapShadowSamples, 1);
  } finally { h.batches.dispose(); }
});

await test('生成比窗口快：影子给出扣着不发的时长（抢答风险）', async () => {
  const h = harness({ genMs: 15, debounce: 60 });
  h.batches.add('group:10', event('1'));
  try {
    await until(() => h.batches.entry('group:10').shadow?.length === 1);
    const sample = h.batches.entry('group:10').shadow[0];
    // 影子 15ms 就生成完了，但窗口 60ms 才结束 → 要扣约 45ms。
    assert.ok(sample.heldMs >= 25, `heldMs=${sample.heldMs}`);
    assert.ok(sample.heldMs <= sample.waitMs, `heldMs=${sample.heldMs} 不应超过窗口`);
    // 生成 15ms 装得进窗口 → 影子只比"窗口结束"早 15ms 左右就绪。
    assert.ok(sample.savedMs >= 5 && sample.savedMs <= 40, `savedMs=${sample.savedMs}`);
    assert.equal(sample.late, 0);
  } finally { h.batches.dispose(); }
});

await test('生成期间又来的消息会计进 late（重叠时需要合并的证据）', async () => {
  const h = harness({ genMs: 150, debounce: 40 });
  h.batches.add('group:10', event('1'));
  try {
    await sleep(80); // 已派发、还在生成
    h.batches.add('group:10', event('2', '补充一句'));
    await until(() => h.batches.entry('group:10').shadow?.length >= 1);
    const sample = h.batches.entry('group:10').shadow[0];
    assert.equal(sample.late, 1, '生成期间到达的那条要算进 late');
  } finally { h.batches.dispose(); }
});

await test('上一轮没跑完时的串行等待会计进 queueMs', async () => {
  const h = harness({ genMs: 40, debounce: 30, queueDelay: 60 });
  h.batches.add('group:10', event('1'));
  try {
    await until(() => h.batches.entry('group:10').shadow?.length === 1);
    const sample = h.batches.entry('group:10').shadow[0];
    assert.ok(sample.queueMs >= 40, `queueMs=${sample.queueMs}（模拟上轮占用 60ms）`);
  } finally { h.batches.dispose(); }
});

await test('影子样本落盘后重载还能读到（便于跑一两天再汇总）', async () => {
  let saved = null;
  const registry = { entry: () => ({ recalledIds: [] }), store: { setState: (key, value) => { saved = JSON.parse(value); return true; } }, run: (key, fn) => fn() };
  const config = { inputDebounceMs: 20, inputShortDebounceMs: 20, inputMaxWaitMs: 200,
    inputBatchMaxMessages: 24, floorWaitMs: 30000, groupEnabled: true, groups: [], selfIds: [] };
  const state = { enabled: true, disposed: false, controller: new AbortController(), taskScheduler: null };
  const batches = new InputBatches({ config, registry, state, stats: {}, onError: (e) => { throw e; },
    run: async () => { await sleep(60); return { endReason: 'stop' }; } });
  batches.add('group:10', event('1'));
  try {
    await until(() => saved?.shadow?.length === 1);
    assert.equal(saved.shadow[0].heldMs >= 0, true);
    assert.ok(Number.isFinite(saved.shadow[0].savedMs));
    // 重载：新的实例从同一份持久状态恢复出样本。
    registry.store.getState = () => JSON.stringify(saved);
    const restored = new InputBatches({ config, registry, state, stats: {}, run: async () => ({ endReason: 'stop' }),
      onError: (e) => { throw e; } });
    assert.equal(restored.entry('group:10').shadow.length, 1);
    restored.dispose();
  } finally { batches.dispose(); }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
