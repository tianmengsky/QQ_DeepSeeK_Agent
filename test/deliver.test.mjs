/**
 * 投递目标与引用回复的回归测试。
 *
 * 这里防的是两个"发错人/发不出去"级别的 bug：
 *
 *   1. **回复发给机器人自己**。私聊事件里 `user_id` 是"对方"，
 *      戳一戳事件里 `user_id` 是"机器人自己" —— 两处语义不同。
 *      搞混了，回复就会进机器人自己的账号。
 *
 *   2. **`[引用]` 让整轮回复失败**。deliverReply 的参数里没有 `event`，
 *      早期版本在里面写 `event?.message_id`，一旦模型用了引用标记就抛
 *      ReferenceError，整轮回复一个字都发不出去。语法检查抓不到这种错。
 *
 *   node test/deliver.test.mjs
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

/** 假的 OneBot：记录所有出站调用。 */
function fakeOnebot() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    let payload = {};
    try {
      payload = JSON.parse(init.body);
    } catch {}
    calls.push({ action, payload });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: calls.length } }),
    };
  };
  return calls;
}

function fakeCtx() {
  const logs = [];
  return {
    logs,
    logger: {
      info: (m) => logs.push(['info', String(m)]),
      warn: (m) => logs.push(['warn', String(m)]),
      error: (m) => logs.push(['error', String(m)]),
      debug: () => {},
    },
    get: () => undefined,
  };
}

/**
 * 一个最小可用的配置。
 *
 * 用导出的 Config 校验一遍，拿到**真实默认值** —— 手工补键会漏
 * （第一次就漏了 replyToGroups，导致群聊投递直接被拦），
 * 而漏掉的默认值会让测试"因为配置不对"而不是"因为代码不对"失败。
 */
function baseConfig(overrides = {}) {
  return bridge.Config({
    // 关掉一切会干扰投递的副作用：不记记忆、不发表情、不等打字节奏
    memoryEnabled: false,
    stickerMode: 'off',
    bubbleDelayMs: 0,
    typingCps: 0,
    replyToGroups: true,
    maxReplyChars: 2000,
    ...overrides,
  });
}

function fakeEntry() {
  return { window: [], recentQqs: [], turns: 0, awakeUntil: 0, lastSpokeAt: 0 };
}

const realFetch = globalThis.fetch;

console.log('\ndeliver: 回复到底发给了谁');

await test('私聊回复发给**对方**，不是机器人自己', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const sent = await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats: {},
    key: 'user:1056612947',
    reply: '收到啦',
    shape: null,
    target: { user_id: 1056612947 },
    isGroup: false,
    speakerQq: '1056612947',
    speakerName: '宿主',
    state,
  });
  assert.equal(sent, true, '应该真的发出去了');
  const priv = calls.filter((c) => c.action === 'send_private_msg');
  assert.equal(priv.length, 1, `应该有 1 次 send_private_msg，实际 ${priv.length}`);
  assert.equal(String(priv[0].payload.user_id), '1056612947', '必须发给对方');
  assert.equal(
    calls.filter((c) => c.action === 'send_group_msg').length,
    0,
    '私聊不能走群接口',
  );
});

await test('私聊回复绝不能发给机器人自己的 QQ', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const SELF = 3667925015;
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats: {},
    key: 'user:1056612947',
    reply: '一句回复',
    shape: null,
    target: { user_id: 1056612947 },
    isGroup: false,
    speakerQq: '1056612947',
    speakerName: '宿主',
    state,
  });
  for (const c of calls) {
    if (c.action !== 'send_private_msg') continue;
    assert.notEqual(
      String(c.payload.user_id),
      String(SELF),
      '❌ 回复被发进了机器人自己的账号',
    );
  }
});

await test('群聊回复发到群里，且不带错 user_id', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats: {},
    key: 'group:999001',
    reply: '群里的回复',
    shape: null,
    target: { group_id: 999001 },
    isGroup: true,
    speakerQq: '1056612947',
    speakerName: '宿主',
    state,
  });
  const grp = calls.filter((c) => c.action === 'send_group_msg');
  assert.equal(grp.length, 1);
  assert.equal(String(grp[0].payload.group_id), '999001');
  assert.equal(
    calls.filter((c) => c.action === 'send_private_msg').length,
    0,
    '群聊不能走私聊接口（那会变成私聊骚扰）',
  );
});

await test('她发出去的消息 ID 会被记下来（表情回应靠它判断归属）', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats: {},
    key: 'group:999001',
    reply: '记一下',
    shape: null,
    target: { group_id: 999001 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  assert.ok(state.ownMessageIds.size > 0, 'ownMessageIds 应该有内容，否则表情回应分不清归属');
});

console.log('\ndeliver: 引用发送功能**已移除**（这几条钉住这个事实）');

/**
 * `[引用]` 暗号 → OneBot reply 段 这套功能已经**整块去掉**。
 *
 * 为什么去掉：实测在群里会把 `[引用]` 这个标记本身当正文发出去
 * （用户看到的就是孤零零一行「[引用]」），而不是变成引用。
 * 与其留着让人踩，不如去掉 —— 模型用正常文字表达"我在回谁"就够了。
 *
 * 这几条测试的意义是**防回归**：如果哪天有人手滑把它加回来，
 * 这里会立刻变红。
 *
 * 注意区分：**别人发来的引用**仍然会被解析成上下文（见 resolveQuote），
 * 那是"读"，不受影响。
 */
await test('回复里带 [引用] 时，整条按**纯文本**原样发出（不再挂 reply 段）', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const stats = {};
  const sent = await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats,
    key: 'group:999001',
    reply: '[引用] 这条是回复上面那句',
    shape: null,
    target: { group_id: 999001 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
    // 就算调用方给了 quoteId（旧接口），也不该再产生 reply 段
    quoteId: '700123',
  });
  assert.equal(sent, true, '不该因为引用而失败');
  const grp = calls.filter((c) => c.action === 'send_group_msg');
  assert.equal(grp.length, 1);
  const msg = grp[0].payload.message;
  assert.equal(
    typeof msg,
    'string',
    '现在应该始终是纯文本 —— 出现消息段数组说明引用功能被加回来了',
  );
  assert.ok(!JSON.stringify(msg).includes('"reply"'), '不该有 reply 段');
  assert.equal(stats.quotesRequested, undefined, '不该再统计引用请求');
});

await test('引用相关的统计字段不再产生', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const stats = {};
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats,
    key: 'user:1',
    reply: '[引用] 没东西可引',
    shape: null,
    target: { user_id: 1 },
    isGroup: false,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  assert.equal(stats.quotesRequested, undefined);
  assert.equal(stats.quotesSkipped, undefined, '移除后不该再记"想引用但没目标"');
  const priv = calls.filter((c) => c.action === 'send_private_msg');
  assert.equal(priv.length, 1);
  assert.equal(typeof priv[0].payload.message, 'string');
});

await test('普通回复仍然是纯文本（不引入多余结构）', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats: {},
    key: 'group:999001',
    reply: '普通一句',
    shape: null,
    target: { group_id: 999001 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
    quoteId: '700123',
  });
  const grp = calls.filter((c) => c.action === 'send_group_msg');
  assert.equal(typeof grp[0].payload.message, 'string', '不该有 reply 段');
});

console.log('\ndeliver: 上游重复吐正文时，群里只该看到一遍');

/**
 * 线上事故原样重放（2026-10-24）：一条 assistant 消息里两个内容相同的文本段，
 * 拼出来的正文是 `A\n\nB\n\n[表情:38]A\n\nB\n\n[表情:38]`。
 * 当时群里是：A、B、然后第三条「A\nB\n[表情:38]」加一张表情 —— 字面量标记漏了出去。
 */
await test('正文重复时只发两份气泡，且不漏出 [表情:N] 字面量', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const line1 = '哈？这拼写…是故意的吧';
  const line2 = '行行行，Suck 也是我，反正我一条都不少干';
  const one = `${line1}\n\n${line2}\n\n[表情:38]`;
  const stats = {};
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats,
    key: 'group:999002',
    reply: `${one}${one}`,
    shape: null,
    target: { group_id: 999002 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  const texts = calls
    .filter((c) => c.action === 'send_group_msg' && typeof c.payload.message === 'string')
    .map((c) => c.payload.message);
  assert.deepEqual(texts, [line1, line2], '只该有这两条气泡');
  for (const c of calls) {
    assert.ok(
      !JSON.stringify(c.payload).includes('[表情:'),
      '任何出站消息都不能带表情标记语法：' + JSON.stringify(c.payload).slice(0, 120),
    );
  }
  assert.equal(stats.repeatedReplyCollapsed, 1, '折回一份要有读数');
});

await test('正文协议：只有 『』 里的气泡会进群，框外的排稿说明丢弃', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const stats = {};
  const reply = [
    '两气泡：',
    '『？你这比喻……』',
    '『行行行，我憋住，不漏了不漏了』',
    '配表情 #67 震惊冒冷汗"卧槽，用户怒了"。我选 #67。',
  ].join('\n');
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats,
    key: 'group:999004',
    reply,
    shape: null,
    target: { group_id: 999004 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  const texts = calls
    .filter((c) => c.action === 'send_group_msg' && typeof c.payload.message === 'string')
    .map((c) => c.payload.message);
  assert.deepEqual(texts, ['？你这比喻……', '行行行，我憋住，不漏了不漏了'], '只该发框里那两条');
  assert.equal(stats.bubbleProtocolTrimmed, 1, '裁剪要有读数');
  for (const c of calls) {
    const raw = JSON.stringify(c.payload);
    assert.ok(!/两气泡|配表情|我选 #/.test(raw), '排稿说明不能进群：' + raw.slice(0, 160));
  }
});

await test('正文协议：兼容路径只捞回她排稿时写过的候选句（复现 21:39 那条泄露）', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  const stats = {};
  const reply = [
    '用"憋"字接他的梗挺自然。',
    '两气泡：',
    '"？你这比喻……"',
    '"……行吧，我憋着，尽量不漏"',
    '配表情 #39 崩溃乱抓头发"爆了爆了" 或 #67 震惊冒冷汗"卧槽，用户怒了"。用 #67 挺贴。或者 #75 装死。',
    '我选 #67（冒冷汗，被骂的感觉）。',
    '最终：',
    '"？这什么破比喻……"',
    '"行行行，我憋住，不漏了不漏了"',
    '',
    '配 #67。',
    '<acp tokens="24" type="text">m00027</acp>',
    '？这什么破比喻……',
    '',
    '行行行，我憋住，不漏了不漏了',
  ].join('\n');
  await bridge.__test.deliverReply(ctx, baseConfig(), {
    entry: fakeEntry(),
    stats,
    key: 'group:999005',
    reply,
    shape: null,
    target: { group_id: 999005 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  const texts = calls
    .filter((c) => c.action === 'send_group_msg' && typeof c.payload.message === 'string')
    .map((c) => c.payload.message);
  assert.deepEqual(texts, ['？这什么破比喻……', '行行行，我憋住，不漏了不漏了'], '只该发最终那两句');
  for (const c of calls) {
    const raw = JSON.stringify(c.payload);
    assert.ok(!raw.includes('<acp'), '代理注解标签不能进群：' + raw.slice(0, 160));
    assert.ok(!/两气泡|配表情|我选 #/.test(raw), '排稿说明不能进群：' + raw.slice(0, 160));
  }
});

await test('正文协议 strict：没有 『』 就什么都不发', async () => {
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const state = { ownMessageIds: new Set(), pendingReactions: new Map() };
  await bridge.__test.deliverReply(ctx, baseConfig({ bubbleProtocol: 'brackets' }), {
    entry: fakeEntry(),
    stats: {},
    key: 'group:999006',
    reply: '就是一句普通的回复',
    shape: null,
    target: { group_id: 999006 },
    isGroup: true,
    speakerQq: '1',
    speakerName: 'x',
    state,
  });
  const sends = calls.filter((c) => c.action.startsWith('send_'));
  assert.equal(sends.length, 0, 'strict 模式下没框过的不该发出去');
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
