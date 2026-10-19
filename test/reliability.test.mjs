/**
 * reliability.test.mjs —— 借鉴 Tulpa 的四项可靠性改造的离线测试。
 *
 *   node test/reliability.test.mjs
 *
 * 全程不发真消息：OneBot 用一个假的 fetch 顶替，DSH 用一个假的 ctx 顶替。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const bridgeUrl = pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href;
const bridge = await import(bridgeUrl);
const { __test } = bridge;
const { Store, STATUS } = require('./../lib/store.mjs');

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
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-'));
}

/** 只提供被测代码真正用到的那几个能力。 */
function fakeCtx(overrides = {}) {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    ...overrides,
  };
}

/** deliverReply 会往 entry.window 里写自己的回复，所以这几个字段必须存在。 */
function fakeEntry() {
  return {
    turnsSinceSticker: 0,
    window: [],
    recentQqs: [],
    turns: 0,
    lastSpokeAt: 0,
    lastMessageAt: 0,
    pending: [],
  };
}

function baseConfig(overrides = {}) {
  return {
    windowTurns: 10,
    heartbeatBufferSize: 20,
    eventsKeepPerConversation: 200,
    sendQuotaPerMinute: 0,
    sendQuotaPerHour: 0,
    stickerMinGapTurns: 0,
    maxReplyChars: 1500,
    maxBubbles: 3,
    countBubblesAsOne: true,
    onebotHttp: 'http://127.0.0.1:3000',
    onebotToken: '',
    replyToGroups: true,
    memoryEnabled: false,
    memoryDir: '',
    memoryMaxEntries: 20,
    ...overrides,
  };
}

/**
 * 假的 OneBot。记录每一次真实发出的请求，方便断言"到底发了几条"。
 * behavior 可以按 action 注入错误。
 */
function fakeOnebot(behavior = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    const payload = JSON.parse(init.body);
    calls.push({ action, payload });
    const b = behavior[action];
    if (typeof b === 'function') return b(payload, calls);
    if (b === 'timeout') {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'AbortError';
      throw err;
    }
    if (b === 'network') throw new Error('fetch failed');
    if (b === 'failed') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'failed', retcode: 100, message: '权限不足' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: calls.length } }),
    };
  };
  return calls;
}

const realFetch = globalThis.fetch;

console.log('reliability: 发送幂等 + 回执状态机');

await test('同一轮重复投递：第二次是幂等重放，不会重复发言', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const config = baseConfig();

  const entry = fakeEntry();
  const opts = {
    entry,
    memory: null,
    stats: {},
    key: 'group:100',
    reply: '你好呀',
    shape: { bubbles: 1, sticker: false },
    target: { group_id: 100 },
    isGroup: true,
    speakerQq: '1',
    speakerName: '甲',
    store,
    turnId: 'group:100#m555',
  };

  const first = await __test.deliverReply(ctx, config, { ...opts });
  assert.equal(first, true);
  assert.equal(calls.length, 1, '第一次应该真发一条');

  const second = await __test.deliverReply(ctx, config, { ...opts, stats: {} });
  assert.equal(second, false, '重放没有真的发出去');
  assert.equal(calls.length, 1, '第二次绝不能重发 —— 这正是原来的重复发言 bug');
  assert.equal(store.getReceipt('group:100#m555#b0').status, STATUS.SUCCEEDED);
});

await test('多气泡各自独立幂等，重放时一条都不重发', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const config = baseConfig({ maxReplyChars: 20 });

  const opts = {
    entry: fakeEntry(),
    memory: null,
    stats: {},
    key: 'group:1',
    reply: '第一句\n\n第二句\n\n第三句',
    shape: { bubbles: 3, sticker: false },
    target: { group_id: 1 },
    isGroup: true,
    speakerQq: '1',
    speakerName: '甲',
    store,
    turnId: 'group:1#m7',
  };

  await __test.deliverReply(ctx, config, { ...opts });
  assert.equal(calls.length, 3, '三个气泡应发三条');

  await __test.deliverReply(ctx, config, { ...opts, entry: fakeEntry(), stats: {} });
  assert.equal(calls.length, 3, '重放后仍然是三条，没有翻倍');
});

await test('发送超时记为 UNKNOWN，第二次被闸门拦住而不是重发', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const calls = fakeOnebot({ send_group_msg: 'timeout' });
  const ctx = fakeCtx();
  const config = baseConfig();

  const opts = {
    entry: fakeEntry(),
    memory: null,
    stats: {},
    key: 'group:2',
    reply: '在吗',
    shape: { bubbles: 1, sticker: false },
    target: { group_id: 2 },
    isGroup: true,
    speakerQq: '1',
    speakerName: '甲',
    store,
    turnId: 'group:2#m9',
  };

  await __test.deliverReply(ctx, config, { ...opts });
  assert.equal(calls.length, 1, '第一次尝试发出去了（但结果未知）');
  assert.equal(store.getReceipt('group:2#m9#b0').status, STATUS.UNKNOWN);

  await __test.deliverReply(ctx, config, { ...opts, entry: fakeEntry(), stats: {} });
  assert.equal(calls.length, 1, 'UNKNOWN 状态绝不能自动重发');

  const unknown = store.listUnknown('group:2');
  assert.equal(unknown.length, 1, '但必须能被列出来核对');
});

await test('业务失败（retcode=100）归为 FAILED，允许重试', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  let fail = true;
  const calls = fakeOnebot({
    send_group_msg: () =>
      fail
        ? {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ status: 'failed', retcode: 100, message: '权限不足' }),
          }
        : {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ status: 'ok', data: { message_id: 1 } }),
          },
  });
  const ctx = fakeCtx();
  const config = baseConfig();
  const opts = {
    entry: fakeEntry(),
    memory: null,
    stats: {},
    key: 'group:3',
    reply: '试试',
    shape: { bubbles: 1, sticker: false },
    target: { group_id: 3 },
    isGroup: true,
    speakerQq: '1',
    speakerName: '甲',
    store,
    turnId: 'group:3#m1',
  };

  await __test.deliverReply(ctx, config, { ...opts });
  assert.equal(store.getReceipt('group:3#m1#b0').status, STATUS.FAILED);

  fail = false;
  await __test.deliverReply(ctx, config, { ...opts, entry: fakeEntry(), stats: {} });
  assert.equal(calls.length, 2, '确定失败应该允许重试');
  assert.equal(store.getReceipt('group:3#m1#b0').status, STATUS.SUCCEEDED);
});

await test('配额是持久的：插件重载后额度不清零', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'b.sqlite3');
  const ctx = fakeCtx();
  const config = baseConfig({ sendQuotaPerHour: 2, sendQuotaPerMinute: 0 });

  const a = new Store(file);
  fakeOnebot();
  for (const n of [1, 2]) {
    await __test.sendOnebotIdempotent(ctx, config, a, {
      idemKey: `k${n}`,
      conversation: 'group:5',
      action: 'send_group_msg',
      target: { group_id: 5 },
      message: `第${n}条`,
    });
  }
  a.db.close();

  // "重载"：同一份数据库重新打开
  const b = new Store(file);
  const calls = fakeOnebot();
  await assert.rejects(
    () =>
      __test.sendOnebotIdempotent(ctx, config, b, {
        idemKey: 'k3',
        conversation: 'group:5',
        action: 'send_group_msg',
        target: { group_id: 5 },
        message: '第3条',
      }),
    /配额已满/,
    '重开后配额应该还在，第 3 条要被拒',
  );
  assert.equal(calls.length, 0, '被配额拒绝时不该发出任何请求');
});

await test('配额被拒时不会浪费掉这个幂等编号', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const ctx = fakeCtx();
  const config = baseConfig({ sendQuotaPerHour: 1, sendQuotaPerMinute: 0 });
  fakeOnebot();

  await __test.sendOnebotIdempotent(ctx, config, store, {
    idemKey: 'once',
    conversation: 'group:6',
    action: 'send_group_msg',
    target: { group_id: 6 },
    message: 'hi',
  });
  try {
    await __test.sendOnebotIdempotent(ctx, config, store, {
      idemKey: 'twice',
      conversation: 'group:6',
      action: 'send_group_msg',
      target: { group_id: 6 },
      message: 'hi again',
    });
  } catch {
    /* 预期被配额拦住 */
  }
  assert.equal(store.getReceipt('twice'), null, '没发出去的编号不该留下 EXECUTING 占位');
});

console.log('\nreliability: 事件缺口（gap）语义');

await test('心跳缓冲超限时如实记 gap，而不是静默丢弃', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const ctx = fakeCtx();
  // 注意：缓冲上限有 4 的下限（Math.max(4, ...)），所以这里用 4。
  const config = baseConfig({ heartbeatBufferSize: 4 });
  const registry = new __test.ConversationRegistry(ctx, config, store);
  const entry = registry.entry('group:8');

  for (let i = 0; i < 7; i += 1) {
    registry.buffer(entry, {
      qq: '1',
      who: '甲',
      text: `第${i}条`,
      conversation: 'group:8',
      dedupeKey: `buf:d${i}`,
    });
  }
  assert.equal(entry.pending.length, 4, '缓冲按上限裁剪');

  const state = store.getConversation('group:8');
  assert.equal(state.gapCount, 3, '被挤掉的 3 条必须计入 gap');
  assert.match(state.gapNote, /超出上限/);
});

/**
 * 插件重载后缓冲要回灌，但**恢复成功的消息不算缺口**。
 *
 * ⚠️ 这条测试原来断言 `gapCount === 3`（"重载期间没接住的必须记成 gap"）。
 * 那个断言后来被证明是**错的**，而且造成了用户实测到的 bug：
 *
 *   提示词里一直挂着「这个会话有约 4 条消息没被我接住（原因：插件重载…）」，
 *   而那 4 条其实**已经恢复进缓冲、随时可用**。恢复成功却报缺口，
 *   逻辑自相矛盾；更糟的是这个数字**没人清**，于是永远消不掉，
 *   模型一直以为自己漏了东西，反而不敢用现成的上下文。
 *
 * 正确的语义：**没丢就不算缺口**。只有真被上限挤掉的才算。
 */
await test('插件重载后缓冲回灌，但**恢复成功的不算缺口**', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'b.sqlite3');
  const ctx = fakeCtx();
  const config = baseConfig({ heartbeatBufferSize: 10 });

  // 第一次运行：攒了几条缓冲
  const a = new Store(file);
  const regA = new __test.ConversationRegistry(ctx, config, a);
  const entryA = regA.entry('group:11');
  for (let i = 0; i < 3; i += 1) {
    regA.buffer(entryA, {
      qq: '2',
      who: '乙',
      text: `缓冲${i}`,
      conversation: 'group:11',
      dedupeKey: `buf:x${i}`,
    });
  }
  a.db.close();

  // 第二次运行（相当于插件重载）
  const b = new Store(file);
  const regB = new __test.ConversationRegistry(ctx, config, b);
  const restored = regB.restoreFromStore();
  assert.equal(restored, 1, '应该恢复出 1 个会话');
  const entryB = regB.entry('group:11');
  assert.equal(entryB.pending.length, 3, '缓冲里的 3 条要回来');
  assert.deepEqual(
    entryB.pending.map((m) => m.text),
    ['缓冲0', '缓冲1', '缓冲2'],
  );

  const state = b.getConversation('group:11');
  assert.equal(
    state.gapCount,
    0,
    '这 3 条已经回到缓冲里了 —— 没丢就不算缺口，否则会一直挂着消不掉',
  );
  assert.equal(
    __test.gapNoticeFor(b, 'group:11'),
    '',
    '没缺口时提示词里不该出现"没接住"那段话',
  );
});

await test('确认过的缓冲不会被重复回灌', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'b.sqlite3');
  const ctx = fakeCtx();
  const config = baseConfig();

  const a = new Store(file);
  const regA = new __test.ConversationRegistry(ctx, config, a);
  const entryA = regA.entry('group:12');
  regA.buffer(entryA, {
    qq: '1',
    who: '甲',
    text: '看过了',
    conversation: 'group:12',
    dedupeKey: 'buf:z',
  });
  const page = a.readEvents('group:12');
  a.ackEvents('group:12', page.readThroughId);
  a.db.close();

  const b = new Store(file);
  const regB = new __test.ConversationRegistry(ctx, config, b);
  assert.equal(regB.restoreFromStore(), 0, '确认过的消息不该再回灌');
  assert.equal(regB.entry('group:12').pending.length, 0);
});

await test('重复上报按 message_id 去重（OneBot 重推不会回两遍）', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const key = 'group:20';
  const dedupeKey = 'onebot:999:12345';

  const first = store.recordEvent({
    conversation: key,
    dedupeKey,
    kind: 'inbound',
    payload: { text: '重复的话' },
    deliverable: false,
  });
  const second = store.recordEvent({
    conversation: key,
    dedupeKey,
    kind: 'inbound',
    payload: { text: '重复的话' },
    deliverable: false,
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.eventCount(key), 1);
});

await test('事件缓存按会话独立，且能按上限淘汰', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  for (let i = 0; i < 25; i += 1) {
    store.recordEvent({ conversation: 'group:30', dedupeKey: `a${i}`, payload: { i } });
  }
  store.recordEvent({ conversation: 'group:31', dedupeKey: 'b0', payload: { i: 0 } });
  assert.equal(store.eventCount('group:30'), 25);
  assert.equal(store.eventCount('group:31'), 1, '别的会话不受影响');

  const pruned = store.pruneEvents('group:30', 10);
  assert.equal(pruned, 15);
  assert.equal(store.eventCount('group:30'), 10);
  assert.equal(store.eventCount('group:31'), 1);
});

console.log('\nreliability: 内容寻址图库');

await test('同一张图重复收藏只占一份，笔记可后补', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const libDir = path.join(dir, 'library');
  const img = Buffer.alloc(2048, 9);

  const a = store.putSticker(img, { dir: libDir, notes: { description: '打招呼' } });
  const b = store.putSticker(Buffer.from(img), { dir: libDir, notes: { emotion: '友好' } });
  assert.equal(a.sha, b.sha);
  assert.equal(b.stored, false);
  assert.equal(store.stickerStats().count, 1);
  assert.equal(store.getSticker(a.sha).emotion, '友好', '第二次应补上笔记');
  assert.equal(store.getSticker(a.sha).description, '打招呼', '原有笔记不能被抹掉');
});

await test('原件被换掉后拒绝使用（不悄悄顶替）', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const libDir = path.join(dir, 'library');
  const res = store.putSticker(Buffer.alloc(1024, 3), { dir: libDir });
  fs.writeFileSync(res.path, Buffer.alloc(1024, 4));
  const read = store.readSticker(res.sha);
  assert.equal(read.ok, false);
  assert.match(read.reason, /哈希不符/);
});

await test('冷却与轮换：刚发过的图不会被连续推荐', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const libDir = path.join(dir, 'library');
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  store.putSticker(Buffer.alloc(100, 1), { dir: libDir, notes: { description: '甲' } });
  store.putSticker(Buffer.alloc(100, 2), { dir: libDir, notes: { description: '乙' } });

  const first = store.pickStickers({ limit: 2, now, cooldownMs: 60_000 });
  assert.equal(first.length, 2);

  store.markUsed([first[0].sha256], now);
  const second = store.pickStickers({ limit: 2, now: now + 1000, cooldownMs: 60_000 });
  assert.equal(second.length, 1);
  assert.notEqual(second[0].sha256, first[0].sha256, '用过的应进冷却');

  const later = store.pickStickers({ limit: 2, now: now + 120_000, cooldownMs: 60_000 });
  assert.equal(later.length, 2, '冷却过了就回来');
});

await test('图库降级时不影响聊天主流程', async () => {
  const dir = tmpDir();
  const bogus = path.join(dir, 'dir-as-db');
  fs.mkdirSync(bogus);
  const store = new Store(bogus);
  assert.equal(store.available, false);
  const res = store.putSticker(Buffer.alloc(10), { dir: path.join(dir, 'lib') });
  assert.equal(res.stored, false);
  assert.deepEqual(store.pickStickers({}), []);
});

/**
 * 缺口**不能粘住**：恢复成功的消息不算缺口，而且事后要能清掉。
 *
 * 用户实测的问题：提示词里一直显示
 *   「这个会话有约 4 条消息没被我接住（原因：插件重载，缓冲消息未及时处理）」
 * 那 4 条其实**已经被恢复到缓冲里了**（没丢），而且消费掉之后这个数字
 * 仍然挂着消不掉 —— 模型会一直以为自己漏了东西，反而不敢用现成的上下文。
 *
 * 两处根因：
 *   ① `restoreConversation` 无条件记缺口，但那些消息刚刚被恢复进缓冲了
 *      —— 恢复成功却报缺口，逻辑矛盾。
 *   ② 就算它们后来被正常消费掉，也**没有任何地方清掉这个计数**。
 */
await test('恢复成功的消息**不算缺口**（它们已经回到缓冲里了）', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'b.sqlite3');
  const ctx = fakeCtx();
  const config = baseConfig({ heartbeatBufferSize: 10 });

  const a = new Store(file);
  const regA = new __test.ConversationRegistry(ctx, config, a);
  const entryA = regA.entry('group:20');
  for (let i = 0; i < 3; i += 1) {
    regA.buffer(entryA, {
      qq: '2',
      who: '乙',
      text: `缓冲${i}`,
      conversation: 'group:20',
      dedupeKey: `buf:g${i}`,
    });
  }
  a.db.close();

  // 模拟插件重载
  const b = new Store(file);
  const regB = new __test.ConversationRegistry(ctx, config, b);
  regB.restoreFromStore();
  const entryB = regB.entry('group:20');
  assert.equal(entryB.pending.length, 3, '缓冲要恢复回来');

  assert.equal(
    b.getConversation('group:20').gapCount,
    0,
    '这 3 条已经恢复到缓冲里了，不该报缺口（否则模型会以为自己漏了东西）',
  );

  // 再把它们消费掉（模拟一次唤醒把缓冲搬进上下文）
  regB.seedContextFromBuffer(entryB, 'group:20');
  const afterConsume = b.getConversation('group:20');
  assert.equal(afterConsume.gapCount, 0, '消费掉之后仍然不该有缺口');
  assert.equal(afterConsume.gapNote, '', 'note 也要清干净');
});

await test('缺口不会**粘住**：清掉之后不再出现在提示词里', async () => {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'b.sqlite3'));
  const ctx = fakeCtx();

  // 先制造一个缺口（模拟缓冲被挤掉 —— 这才是真缺口）
  const config = baseConfig({ heartbeatBufferSize: 4 });
  const registry = new __test.ConversationRegistry(ctx, config, store);
  const entry = registry.entry('group:21');
  for (let i = 0; i < 7; i += 1) {
    registry.buffer(entry, {
      qq: '1',
      who: '甲',
      text: `第${i}条`,
      conversation: 'group:21',
      dedupeKey: `buf:h${i}`,
    });
  }
  assert.ok(store.getConversation('group:21').gapCount > 0, '挤掉的消息要记缺口');
  assert.match(
    __test.gapNoticeFor(store, 'group:21'),
    /没被我接住/,
    '有缺口时提示词里要出现',
  );

  // 清掉之后，提示词里就不该再出现
  store.clearGap('group:21');
  assert.equal(
    __test.gapNoticeFor(store, 'group:21'),
    '',
    '缺口清掉之后，提示词里不能再出现"没接住"那段话',
  );
});

globalThis.fetch = realFetch;

console.log('\n回复投递的重试上限（明确失败要能放弃，别把会话一直占住）');

const { ReplyJournal } = await import('../lib/delivery/reply-journal.mjs');

function seedJournal(id) {
  const dir = tmpDir();
  const store = new Store(path.join(dir, 'journal.sqlite3'));
  const journal = new ReplyJournal(store);
  journal.begin(id, 'group:1', { sessionId: 's1', requestId: 'r1', event: {} });
  journal.output(id, { reply: '一句' });
  journal.planned(id, {
    key: 'group:1',
    target: { group_id: 1 },
    idemBase: id,
    bubbles: ['一句'],
    sticker: null,
  });
  return { store, journal };
}

await test('明确失败到上限 → failed 终态，队列放开，记录仍可查', async () => {
  const { store, journal } = seedJournal('group:1#m1');
  const id = 'group:1#m1';
  assert.equal(journal.error(id, 'retcode=100', { maxAttempts: 3 }), 'pending');
  assert.equal(journal.get(id).attempts, 1);
  // 同一轮里紧接着的第二次记账不该再 +1（否则两轮就被判放弃）
  assert.equal(journal.error(id, 'retcode=100', { maxAttempts: 3 }), 'pending');
  assert.equal(journal.get(id).attempts, 1);
  assert.equal(journal.pending().length, 1, '还没到上限，仍要重试');

  // 下一轮（retry_at 已过）
  store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run(id);
  assert.equal(journal.error(id, 'retcode=100', { maxAttempts: 3 }), 'pending');
  assert.equal(journal.get(id).attempts, 2);

  store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run(id);
  assert.equal(journal.error(id, 'retcode=100', { maxAttempts: 3 }), 'failed');
  assert.equal(journal.get(id).state, 'failed');
  assert.match(journal.get(id).detail, /已放弃投递（3 次明确失败）/);
  assert.deepEqual(journal.pending(), [], '放弃了就不能再占住这个会话');
  assert.equal(journal.snapshot().failed.length, 1, '放弃不等于消失，状态里必须查得到');
  assert.equal(journal.snapshot().failed[0].attempts, 3);
  store.db.close();
});

await test('结果未知永不放弃；配额这类"等会儿再来"不计数', async () => {
  const { store, journal } = seedJournal('group:1#m2');
  const id = 'group:1#m2';
  for (let i = 0; i < 5; i += 1) {
    store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run(id);
    assert.equal(journal.error(id, '发送结果未知', { attention: true, maxAttempts: 3 }), 'attention');
  }
  assert.equal(journal.get(id).state, 'attention', 'UNKNOWN 只能人工核对，绝不能被上限吞掉');
  assert.equal(journal.get(id).attempts, 0, 'UNKNOWN 不算"明确失败"');

  const quota = seedJournal('group:1#m3');
  quota.journal.error('group:1#m3', '配额已满', { maxAttempts: 0 });
  assert.equal(quota.journal.get('group:1#m3').attempts, 0, '配额是等会儿再来，不该计数');
  assert.equal(quota.journal.pending().length, 1, '被限流的回复要留着，不能丢');
  store.db.close();
  quota.store.db.close();
});

await test('replyMaxSendAttempts=0 → 保持旧行为（无限重试）', async () => {
  const { store, journal } = seedJournal('group:1#m4');
  const id = 'group:1#m4';
  for (let i = 0; i < 8; i += 1) {
    store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run(id);
    assert.equal(journal.error(id, 'retcode=100', { maxAttempts: 0 }), 'pending');
  }
  assert.equal(journal.get(id).state, 'planned');
  assert.equal(journal.get(id).attempts, 0);
  assert.equal(journal.pending().length, 1);
  store.db.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
