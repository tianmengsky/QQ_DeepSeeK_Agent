/**
 * 出站发送队列的回归测试。
 *
 * 防的是这一整类 bug：**发送慢 → 卡住下一个回合 → 回复被吞**。
 * 旧路径里气泡之间的打字节奏是在 `registry.run(key)` 的串行链上 await 的，
 * 所以"发得慢"直接等于"下一条消息进不来"。
 *
 *   node test/send-queue.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../lib/index.js');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
  }
}

const { ConversationSendQueue, bubbleDelayFor } = bridge.__test;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `at` 是**绝对时刻**（epoch 毫秒），不是相对延迟 ——
 * delivery 规划阶段就是这么算的。用相对值写会得到"早就在过去"的时刻，
 * 队列于是立刻全发出去（这正是第一版测试踩到的坑）。
 */
const at = (ms) => Date.now() + ms;

console.log('\nsend-queue: 发送不该卡住回合');

await test('enqueue 立刻返回，批次自己慢慢发完', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  const promise = queue.enqueue({
    key: 'group:1',
    items: [
      { at: at(0), run: async () => (sent.push('a'), { sent: true }) },
      { at: at(300), run: async () => (sent.push('b'), { sent: true }) },
      { at: at(600), run: async () => (sent.push('c'), { sent: true }) },
    ],
  });
  // 同步返回：调用方（Agent 回合）此刻就能往下走
  await sleep(80);
  assert.deepEqual(sent, ['a'], `80ms 时应该只发出去第一条，实际 ${JSON.stringify(sent)}`);
  const report = await promise;
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.equal(report.sentAny, true);
  queue.dispose();
});

await test('同一个会话严格保序，不同会话互不阻塞', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  const slow = queue.enqueue({
    key: 'group:slow',
    items: [
      { at: at(0), run: async () => (sent.push('慢1'), { sent: true }) },
      { at: at(500), run: async () => (sent.push('慢2'), { sent: true }) },
    ],
  });
  const fast = queue.enqueue({
    key: 'user:2',
    items: [{ at: at(0), run: async () => (sent.push('快1'), { sent: true }) }],
  });
  await fast;
  assert.ok(sent.includes('快1'), '另一个会话不该被慢会话的节奏堵住');
  await slow;
  assert.deepEqual(sent.filter((s) => s.startsWith('慢')), ['慢1', '慢2'], '同会话必须保序');
  queue.dispose();
});

await test('失败即止：一条发不出去，后面的气泡不再发（避免半截话）', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  const report = await queue.enqueue({
    key: 'group:1',
    items: [
      { at: at(0), run: async () => (sent.push('a'), { sent: true }) },
      { at: at(0), run: async () => ({ sent: false, error: 'fetch failed' }) },
      { at: at(0), run: async () => (sent.push('c'), { sent: true }) },
    ],
  });
  assert.deepEqual(sent, ['a']);
  assert.equal(report.failed, true);
  assert.equal(report.sentAny, true);
  queue.dispose();
});

await test('排队期间被关掉（gate）就一个字都不发', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  let allowed = true;
  const sent = [];
  const promise = queue.enqueue({
    key: 'group:1',
    items: [
      { at: at(0), run: async () => (sent.push('a'), { sent: true }) },
      {
        at: at(200),
        gate: () => allowed === false,
        run: async () => (sent.push('b'), { sent: true }),
      },
    ],
  });
  await sleep(60);
  allowed = false; // 等价于"托管被关了 / 回合被取消"
  const report = await promise;
  assert.deepEqual(sent, ['a'], '关掉之后不该再发第二条');
  assert.equal(report.failed, true);
  queue.dispose();
});

await test('dispose 会丢弃还没发出去的排队项', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  const promise = queue.enqueue({
    key: 'group:1',
    items: [
      { at: at(0), run: async () => (sent.push('a'), { sent: true }) },
      { at: at(400), run: async () => (sent.push('b'), { sent: true }) },
    ],
  });
  await sleep(60);
  queue.dispose();
  await assert.rejects(() => promise, /关闭/);
  await sleep(120);
  assert.deepEqual(sent, ['a'], 'dispose 之后第二条不该再出去');
});

console.log('\nsend-queue: 排空之后必须真的静下来（防定时器空转）');

/**
 * 这一条钉的是一个**把整套测试挂死**的 bug。
 *
 * 第一版 `idle()` 把挂着的定时器也算成"有活"，而 `pump()` 在空队列上
 * 还会再排一个 1 秒的收尾闹钟 —— 闹钟醒来发现没活，再排一个。
 * 定时器于是永续存在，`flush()` 永远等不到队列静下来。
 *
 * 表现：B06 之后的用例全部超时（spawnSync ETIMEDOUT），而且
 * **生产上也是真的在白白空转**：每秒钟醒一次，永远不停。
 */
await test('发完之后队列必须真的空下来，并且不留空转的定时器', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  await queue.enqueue({
    key: 'group:1',
    items: [{ at: at(0), run: async () => (sent.push('a'), { sent: true }) }],
  });
  assert.deepEqual(sent, ['a']);
  // 批次的 promise 是在 runBatch 里 resolve 的，而"从队列里摘掉这批"
  // 发生在紧随其后的 .finally —— 所以这里必须让出一轮微任务再断言。
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.hasWork(), false, '发完了就不该还有活');
  assert.equal(queue.idle(), true, 'idle 必须为真，否则 flush 永远不返回');
  // 留出足够时间让"收尾闹钟"暴露出来（第一版会在 1 秒后重排）
  await sleep(1300);
  assert.equal(queue.timer, null, '空队列上不该留着定时器');
  assert.equal(queue.hasWork(), false);
  assert.equal(await queue.flush(2000), true, 'flush 必须能在超时前返回');
  queue.dispose();
});

await test('还有一批没到点时，flush 会等它发完而不是提前返回', async () => {
  const queue = new ConversationSendQueue({ logger: null });
  const sent = [];
  const promise = queue.enqueue({
    key: 'group:1',
    items: [
      { at: at(0), run: async () => (sent.push('a'), { sent: true }) },
      { at: at(250), run: async () => (sent.push('b'), { sent: true }) },
    ],
  });
  assert.equal(await queue.flush(5000), true, 'flush 应该等到两个气泡都发完');
  assert.deepEqual(sent, ['a', 'b']);
  await promise;
  queue.dispose();
});

console.log('\nsend-queue: 打字节奏仍然由配置决定（只是搬到队列里睡）');

await test('气泡间隔 = 下一个气泡字数 × 每字毫秒，并遵守上下限', () => {
  const config = { bubbleDelayPerCharMs: 100, bubbleDelayMinMs: 400, bubbleDelayMaxMs: 6000 };
  assert.equal(bubbleDelayFor('一二三', config), 400, '3 字算出来 300，应被下限抬到 400');
  assert.equal(bubbleDelayFor('一'.repeat(20), config), 2000, '20 字 = 2000ms');
  assert.equal(bubbleDelayFor('一'.repeat(200), config), 6000, '超长应被上限截到 6000');
  assert.equal(bubbleDelayFor('一二三', { bubbleDelayPerCharMs: 0 }), 0, '0 = 不等，一次全发');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
