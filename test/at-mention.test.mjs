/**
 * at-mention.test.mjs —— 她"像人一样 @ 别人"的回归测试。
 *
 *   node test/at-mention.test.mjs
 *
 * 这一层防的不是权限，而是**三种尴尬**：
 *   ① 想 @ 却没 @ 上：标记被当正文发出去（群里看到 `[@:123]` 这种语法）
 *   ② @ 错人：昵称重名猜错了、或者写到私聊里去了
 *   ③ 每句都带 @（那比不 @ 更烦人）
 *
 * 全部走 `deliverReply` + 假 OneBot，断言的是**真正发给 OneBot 的 message**。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bindItems } from '../lib/delivery/reply-delivery.mjs';

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

function baseConfig(overrides = {}) {
  return bridge.Config({
    memoryEnabled: false,
    stickerMode: 'off',
    bubbleDelayMs: 0,
    typingCps: 0,
    replyToGroups: true,
    maxReplyChars: 2000,
    ...overrides,
  });
}

const BOT = '3667925015';
/** 真实 QQ 号至少 5 位，解析器也要求 ≥4 位 —— 测试必须用真长度的号。 */
const FISH = '123456789';
const DREAM = '1056612947';

/** 窗口里已经聊过的人 —— 昵称解析只能看见这些人。 */
function fakeEntry() {
  return {
    window: [
      { qq: DREAM, who: '天梦', bot: false, text: '在吗', at: 1 },
      { qq: FISH, who: '大肥鱼', bot: false, text: '在', at: 2 },
    ],
    recentQqs: [DREAM, FISH],
    turns: 0,
    awakeUntil: 0,
    lastSpokeAt: 0,
  };
}

function groupOpts(reply, over = {}) {
  return {
    entry: fakeEntry(),
    stats: {},
    key: 'group:999001',
    reply,
    shape: null,
    target: { group_id: 999001 },
    isGroup: true,
    speakerQq: DREAM,
    speakerName: '天梦',
    state: { ownMessageIds: new Set() },
    selfIds: [BOT],
    ...over,
  };
}

const realFetch = globalThis.fetch;
const sent = (calls) =>
  calls.filter((c) => c.action === 'send_group_msg').map((c) => c.payload.message);

console.log('\nat：她自己在句子里点名（@ 段）');

await test('写了 [@:QQ号] → 真的发成 at 段，正文里不留标记', async () => {
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig(),
    groupOpts(`[@:${FISH}] 你来看看这个`, { stats }),
  );
  const messages = sent(calls);
  assert.equal(messages.length, 1, `应该只发一条，实际 ${messages.length}`);
  assert.ok(Array.isArray(messages[0]), '有 @ 的气泡必须走消息段，不能是纯字符串');
  assert.deepEqual(messages[0][0], { type: 'at', data: { qq: FISH } });
  assert.ok(!JSON.stringify(messages[0]).includes('[@'), '标记语法绝不能出现在真正发出去的内容里');
  assert.match(JSON.stringify(messages[0]), /你来看看这个/);
  assert.equal(stats.atMentions, 1);
});

await test('句中的 @ 保持原位（不是一律挪到句首）', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts(`你把[@:${FISH}]的锅背了`));
  const [message] = sent(calls);
  assert.deepEqual(message.map((p) => p.type), ['text', 'at', 'text']);
  assert.equal(message[0].data.text, '你把');
  assert.equal(message[1].data.qq, FISH);
  assert.equal(message[2].data.text, '的锅背了');
});

await test('没写 @ 时一条都不带（不能每句都 @）', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts('就随便说一句'));
  const [message] = sent(calls);
  assert.equal(typeof message, 'string', '没有 @ 就必须还是纯字符串，保持原样发货');
  assert.equal(message, '就随便说一句');
});

await test('昵称按窗口里出现过的人解析，并记成 @昵称 进窗口', async () => {
  const calls = fakeOnebot();
  const entry = fakeEntry();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts('[@大肥鱼] 别装了', { entry }));
  const [message] = sent(calls);
  assert.deepEqual(message[0], { type: 'at', data: { qq: FISH } });
  const own = entry.window.filter((m) => m.bot);
  assert.equal(own.at(-1).text, '@大肥鱼 别装了', '自己说过的话要按人看到的样子记');
});

await test('照抄窗口里的「昵称（QQ号）」也认', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts(`[@天梦（${DREAM}）] 在吗`));
  const [message] = sent(calls);
  assert.deepEqual(message[0], { type: 'at', data: { qq: DREAM } });
});

await test('解析不出来的标记被摘掉，而不是当正文发出去', async () => {
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts('[@查无此人] 你是谁', { stats }));
  const [message] = sent(calls);
  assert.equal(typeof message, 'string');
  assert.equal(message, ' 你是谁');
  assert.ok(!message.includes('[@'), '写坏的标记也不许漏进群里');
  assert.equal(stats.atMentions, undefined);
  assert.ok(stats.atMentionDropped >= 1, '丢掉的标记要记一笔，便于排查');
});

await test('@全体成员 一律拒绝（那是打扰所有人）', async () => {
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts('[@:all] 都出来', { stats }));
  const [message] = sent(calls);
  assert.equal(typeof message, 'string');
  assert.ok(!JSON.stringify(message).includes('"at"'));
  assert.ok(stats.atMentionDropped >= 1);
});

await test('不许 @ 自己', async () => {
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts(`[@:${BOT}] 我自己`, { stats }));
  const [message] = sent(calls);
  assert.equal(typeof message, 'string');
  assert.ok(stats.atMentionDropped >= 1);
});

await test('一个气泡最多 @ 三个人，多出来的摘掉', async () => {
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig(),
    groupOpts('[@:111111][@:222222][@:333333][@:444444] 都快来', { stats }),
  );
  const [message] = sent(calls);
  const ats = message.filter((p) => p.type === 'at').map((p) => p.data.qq);
  assert.deepEqual(ats, ['111111', '222222', '333333']);
  assert.equal(stats.atMentions, 3);
  assert.equal(stats.atMentionDropped, 1);
});

await test('上限可配：atMentionMax=1', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig({ atMentionMax: 1 }),
    groupOpts('[@:111111][@:222222] 来'),
  );
  const [message] = sent(calls);
  assert.deepEqual(message.filter((p) => p.type === 'at').map((p) => p.data.qq), ['111111']);
});

await test('私聊：标记摘掉，永远不发 at 段', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), {
    ...groupOpts(`[@:${FISH}] 我跟你说`),
    key: `user:${DREAM}`,
    isGroup: false,
    target: { user_id: Number(DREAM) },
  });
  const priv = calls.filter((c) => c.action === 'send_private_msg').map((c) => c.payload.message);
  assert.equal(priv.length, 1);
  assert.equal(typeof priv[0], 'string');
  assert.ok(!JSON.stringify(priv[0]).includes('[@'));
});

await test('开关关掉（atMentionEnabled=false）：标记照样摘干净，但不发 at', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig({ atMentionEnabled: false }),
    groupOpts(`[@:${FISH}] 你好`),
  );
  const [message] = sent(calls);
  assert.equal(typeof message, 'string');
  assert.ok(!message.includes('[@'));
  assert.ok(!JSON.stringify(message).includes('"at"'));
});

await test('被截断的半截标记不会漏出去（maxReplyChars 卡在标记中间）', async () => {
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig({ maxReplyChars: 9 }),
    groupOpts(`你好 [@:${FISH}] 快来`),
  );
  const [message] = sent(calls);
  assert.ok(!JSON.stringify(message).includes('[@'), `不该漏标记：${JSON.stringify(message)}`);
});

console.log('\nat：幂等（@ 段必须参与内容比对）');

await test('回执内容一致 → 重放不重发；换了 @ 对象 → 必须报幂等冲突', async () => {
  const message = [
    { type: 'at', data: { qq: FISH } },
    { type: 'text', data: { text: ' 你好' } },
  ];
  const plan = {
    key: 'group:1',
    entry: fakeEntry(),
    bubbles: [{ body: `[@:${FISH}] 你好`, text: '@大肥鱼 你好', message, mentions: [FISH] }],
    sticker: null,
    idemBase: 'at-idem',
    target: { group_id: 1 },
    action: 'send_group_msg',
    canSend: () => true,
    store: {
      getReceipt: () => ({
        status: 'SUCCEEDED',
        payload: JSON.stringify({ group_id: 1, message }),
        onebotId: 'm1',
        updatedAt: 1,
      }),
    },
  };
  const calls = fakeOnebot();
  const items = bindItems(baseConfig(), plan, async (req) => {
    calls.push({ action: 'fake', payload: req });
    return { sent: true, status: 'SUCCEEDED', onebotId: 'x' };
  });
  const result = await items[0].run();
  assert.equal(result.replayed, true, '内容一致的重放不该真的再发一次');
  assert.equal(calls.length, 0);

  const changed = {
    ...plan,
    bubbles: [
      {
        body: '[@:999999999] 你好',
        text: '@别人 你好',
        message: [
          { type: 'at', data: { qq: '999999999' } },
          { type: 'text', data: { text: ' 你好' } },
        ],
        mentions: ['999999999'],
      },
    ],
  };
  const mismatch = bindItems(baseConfig(), changed, async () => ({ sent: true }));
  await assert.rejects(() => mismatch[0].run(), /幂等编号冲突/, '换了 @ 对象必须报冲突');
});

console.log('\nat：不在群里的人 —— 宁可不 @，也不能发不出去');

/** 真拉一次 `get_group_member_list`，把成员表灌进昵称缓存（真实路径就是拼提示词时拉的）。 */
async function warmMemberList(groupId, members) {
  const real = globalThis.fetch;
  const data = members.map((member) =>
    Array.isArray(member)
      ? { user_id: member[0], nickname: member[1] }
      : { user_id: member, nickname: `u${member}` },
  );
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 'ok', retcode: 0, data }),
  });
  try {
    await bridge.__test.buildNameMap(
      baseConfig(),
      { message_type: 'group', group_id: groupId, user_id: '1056612947', sender: { nickname: '天梦' } },
      {},
    );
  } finally {
    globalThis.fetch = real;
  }
}

await test('她写了一个不在群里的号 → @ 摘掉、正文照发（OneBot 会因坏 at 退回整条消息）', async () => {
  bridge.__test.clearNameCache();
  await warmMemberList(999001, ['1056612947', FISH, BOT]);
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig(),
    groupOpts('[@:2859252770] 有人找你', { stats }),
  );
  const [message] = sent(calls);
  assert.equal(typeof message, 'string', '摘掉 @ 之后必须退回纯文本，否则接入端还会退回整条');
  assert.equal(message, '有人找你');
  assert.equal(stats.atMentions, 1, '她是写过 @ 的');
  assert.equal(stats.atMentionDropped, 1, '摘掉的 @ 要记账，否则只能靠猜');
  bridge.__test.clearNameCache();
});

await test('已经落库、正在重试的计划也走同一条校验（坏 @ 摘掉后会话能自己解锁）', async () => {
  bridge.__test.clearNameCache();
  await warmMemberList(999001, ['1056612947', FISH, BOT]);
  const plan = {
    key: 'group:999001',
    entry: fakeEntry(),
    ctx: fakeCtx(),
    stats: {},
    target: { group_id: 999001 },
    action: 'send_group_msg',
    idemBase: 'ghost-retry',
    sticker: null,
    canSend: () => true,
    bubbles: [
      {
        body: '[@:2859252770] 有人找你',
        text: '@淼293 有人找你',
        message: [
          { type: 'at', data: { qq: '2859252770' } },
          { type: 'text', data: { text: ' 有人找你' } },
        ],
        mentions: ['2859252770'],
        labels: ['淼293'],
      },
    ],
  };
  const seen = [];
  const keys = [];
  const items = bindItems(baseConfig(), plan, async (req) => {
    seen.push(req.message);
    keys.push(req.idemKey);
    return { sent: true, status: 'SUCCEEDED', onebotId: 'x' };
  });
  await items[0].run();
  assert.equal(typeof seen[0], 'string', '重试的那条也必须退回纯文本');
  assert.equal(seen[0], '有人找你');
  assert.equal(plan.stats.atMentionDropped, 1);
  // 内容变了就必须换编号，否则 outbox 会判"同号不同内容"继续卡住
  assert.equal(keys[0], 'ghost-retry#b0#noat');
  bridge.__test.clearNameCache();
});

await test('真成员照旧 @（校验不能手滑把有效 @ 也摘掉）', async () => {
  bridge.__test.clearNameCache();
  await warmMemberList(999001, ['1056612947', FISH, BOT]);
  const plan = {
    key: 'group:999001',
    entry: fakeEntry(),
    ctx: fakeCtx(),
    stats: {},
    target: { group_id: 999001 },
    action: 'send_group_msg',
    idemBase: 'real',
    sticker: null,
    canSend: () => true,
    bubbles: [
      {
        body: `[@:${FISH}] 你来`,
        text: '@大肥鱼 你来',
        message: [
          { type: 'at', data: { qq: FISH } },
          { type: 'text', data: { text: ' 你来' } },
        ],
        mentions: [FISH],
        labels: ['大肥鱼'],
      },
    ],
  };
  const seen = [];
  const items = bindItems(baseConfig(), plan, async (req) => {
    seen.push(req.message);
    return { sent: true, status: 'SUCCEEDED', onebotId: 'x' };
  });
  await items[0].run();
  assert.ok(Array.isArray(seen[0]));
  assert.deepEqual(seen[0][0], { type: 'at', data: { qq: FISH } });
  assert.equal(plan.stats.atMentionDropped, undefined, '有效 @ 不该被记成丢弃');
  bridge.__test.clearNameCache();
});

await test('名单不知道（没拉过）→ 放行，不凭猜测拦掉 @', async () => {
  bridge.__test.clearNameCache();
  const plan = {
    key: 'group:888888',
    entry: fakeEntry(),
    ctx: fakeCtx(),
    stats: {},
    target: { group_id: 888888 },
    action: 'send_group_msg',
    idemBase: 'unknown-group',
    sticker: null,
    canSend: () => true,
    bubbles: [
      {
        body: `[@:${FISH}] 你来`,
        text: '@大肥鱼 你来',
        message: [
          { type: 'at', data: { qq: FISH } },
          { type: 'text', data: { text: ' 你来' } },
        ],
        mentions: [FISH],
        labels: ['大肥鱼'],
      },
    ],
  };
  const seen = [];
  const items = bindItems(baseConfig(), plan, async (req) => {
    seen.push(req.message);
    return { sent: true, status: 'SUCCEEDED', onebotId: 'x' };
  });
  await items[0].run();
  assert.ok(Array.isArray(seen[0]), '没名单时必须放行');
  bridge.__test.clearNameCache();
});

await test('老计划里的字符串气泡仍然发得出去（升级时还在排队的那条）', async () => {
  const plan = {
    key: 'group:1',
    entry: fakeEntry(),
    bubbles: ['旧格式的一句', '旧格式的第二句'],
    sticker: null,
    idemBase: 'legacy',
    target: { group_id: 1 },
    action: 'send_group_msg',
    canSend: () => true,
  };
  const seen = [];
  const items = bindItems(baseConfig(), plan, async (req) => {
    seen.push(req.message);
    return { sent: true, status: 'SUCCEEDED', onebotId: 'x' };
  });
  await items[0].run();
  await items[1].run();
  assert.deepEqual(seen, ['旧格式的一句', '旧格式的第二句']);
});

console.log('\nat：解析器单元（不经过投递）');

await test('extractAtMentions 不给 resolve 时只认 QQ 号字面量', async () => {
  const { extractAtMentions } = bridge.__test;
  const hit = extractAtMentions('[@:12345] hi');
  assert.deepEqual(hit.mentions, ['12345']);
  assert.deepEqual(hit.message, [
    { type: 'at', data: { qq: '12345' } },
    { type: 'text', data: { text: ' hi' } },
  ]);
  const miss = extractAtMentions('[@昵称] hi');
  assert.deepEqual(miss.mentions, []);
  assert.equal(miss.message, null);
  assert.equal(miss.text, ' hi');
  // 三位数不认：那多半是写坏了，宁可这次不 @
  assert.deepEqual(extractAtMentions('[@:123] hi').mentions, []);
});

await test('atMarkerTokens 取出所有 token（含昵称，供异步解析）', async () => {
  const { atMarkerTokens } = bridge.__test;
  assert.deepEqual(atMarkerTokens('[@天梦] 和 [@:200222] 都来'), ['天梦', '200222']);
  assert.deepEqual(atMarkerTokens('没有标记'), []);
});

await test('mentionResolver 对重名一律返回"解析不了"', async () => {
  const { mentionResolver } = bridge.__test;
  const resolve = mentionResolver(
    {
      window: [
        { qq: '111111', who: '小明', bot: false },
        { qq: '222222', who: '小明', bot: false },
        { qq: '333333', who: '小红', bot: false },
      ],
    },
    '111111',
    '小明',
  );
  assert.equal(resolve('小明'), null, '重名必须放弃，不能猜');
  assert.deepEqual(resolve('小红'), { qq: '333333', name: '小红' });
  assert.deepEqual(resolve('333333'), { qq: '333333', name: '小红' });
});

await test('[@昵称] 认全群成员，不只窗口里说过话的人', async () => {
  bridge.__test.clearNameCache();
  await warmMemberList(999001, [
    ['1056612947', '天梦'],
    [FISH, '大肥鱼'],
    ['777777777', '没说过话的人'],
    [BOT, '小鲸鱼'],
  ]);
  const calls = fakeOnebot();
  await bridge.__test.deliverReply(fakeCtx(), baseConfig(), groupOpts('[@没说过话的人] 你来一下'));
  const [message] = sent(calls);
  assert.deepEqual(message[0], { type: 'at', data: { qq: '777777777' } });
  bridge.__test.clearNameCache();
});

await test('成员表里重名 → 放弃这个 @（不能猜）', async () => {
  bridge.__test.clearNameCache();
  await warmMemberList(999001, [
    ['1056612947', '天梦'],
    ['888888888', '同名'],
    ['999999888', '同名'],
  ]);
  const calls = fakeOnebot();
  const stats = {};
  await bridge.__test.deliverReply(
    fakeCtx(),
    baseConfig(),
    groupOpts('[@同名] 你说', { stats }),
  );
  const [message] = sent(calls);
  assert.equal(typeof message, 'string');
  assert.ok(stats.atMentionDropped >= 1);
  bridge.__test.clearNameCache();
});

await test('提示词：优先写昵称，号只能照抄，别每句都带', async () => {
  const prompt = bridge.__test.buildPrompt(
    {
      post_type: 'message',
      message_type: 'group',
      group_id: 999001,
      user_id: Number(DREAM),
      self_id: Number(BOT),
      message: [{ type: 'text', data: { text: '在吗' } }],
      sender: { nickname: '天梦' },
    },
    baseConfig(),
    { includeStatic: false },
  );
  assert.match(prompt, /优先 \[@昵称\]/, '点名优先使用昵称');
  assert.match(prompt, /当前记录中的真实个体/, '对象来自当前记录且范围限定为个体');
  assert.match(prompt, /确需点名时/, '点名由实际需要决定');
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
