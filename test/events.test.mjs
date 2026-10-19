/**
 * events.test.mjs —— 戳一戳 / 加好友申请的离线测试。
 *
 *   node test/events.test.mjs
 *
 * 不发真消息：OneBot 用假的 fetch 顶替。
 * 重点验证三件容易出事的地方：
 *   1. 戳一戳的字段语义（群里看 target_id，私聊别搞反）
 *   2. 回戳必须有节流（连点不该把消息刷爆）
 *   3. 申请**默认绝不自动同意**（这是安全底线，不能被配置意外翻掉）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const bridge = await import(
  pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href
);
const { __test } = bridge;
const { Store } = require('./../lib/store.mjs');

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

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-ev-'));
  return new Store(path.join(dir, 'b.sqlite3'));
}

function fakeCtx() {
  return { logger: { info: () => {}, warn: () => {}, error: () => {} }, get: () => undefined };
}

function baseConfig(overrides = {}) {
  return {
    groupEnabled: true,
    groups: [],
    selfIds: ['3667925015'],
    pokeReplyEnabled: true,
    pokeReplyTexts: ['？', '干嘛'],
    pokeReplyMinIntervalMs: 10000,
    pokeReplyPerSenderPerHour: 5,
    pokeReplyGroups: [],
    pokeReplyGroupText: true,
    notifyUsers: [],
    autoHandleRequests: false,
    autoHandleRequestAction: 'reject',
    onebotHttp: 'http://127.0.0.1:3000',
    onebotToken: '',
    sendQuotaPerMinute: 0,
    sendQuotaPerHour: 0,
    maxReplyChars: 1500,
    ...overrides,
  };
}

/** 假 OneBot：记录所有调用。 */
function fakeOnebot(behavior = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    const payload = JSON.parse(init.body);
    calls.push({ action, payload });
    const b = behavior[action];
    if (typeof b === 'function') return b(payload, calls);
    if (b === 'fail') throw new Error('fetch failed');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: calls.length } }),
    };
  };
  return calls;
}

/**
 * 一个形状完整的群聊戳一戳事件。
 *
 * self_id / target_id 必须和 baseConfig 里的 selfIds 一致 ——
 * 不一致的话 botIds 匹配不上，handler 会正确地判定"戳的不是我"然后什么都不做，
 * 测试就会以假象失败。
 */
function groupPokeEvent(overrides = {}) {
  return {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    self_id: 3667925015,
    user_id: 1056612947, // 发起者
    target_id: 3667925015, // 被戳的是机器人
    group_id: 9,
    ...overrides,
  };
}

const realFetch = globalThis.fetch;

console.log('events: 戳一戳');

await test('群里被戳 → 回戳 + 回一句话', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const ctx = fakeCtx();
  const config = baseConfig();
  const stats = {};
  const state = { lastPokeAt: 0 };

  const handled = await __test.handlePokeNotice(
    ctx,
    config,
    {
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: 3667925015,
      user_id: 1056612947, // 发起者
      target_id: 3667925015, // 被戳的是我
      group_id: 111,
    },
    state,
    stats,
    store,
  );

  assert.equal(handled, true);
  assert.equal(calls.filter((c) => c.action === 'group_poke').length, 1, '应该回戳一次');
  assert.deepEqual(calls.find((c) => c.action === 'group_poke').payload, {
    group_id: 111,
    user_id: 1056612947,
  }, '回戳要戳发起者，不是戳自己');
  assert.equal(calls.filter((c) => c.action === 'send_group_msg').length, 1, '应该回一句话');
  assert.ok(['？', '干嘛'].includes(calls.find((c) => c.action === 'send_group_msg').payload.message));
  assert.equal(stats.pokeReplied, 1);
});

await test('私聊被戳 → 用 friend_poke', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const stats = {};
  await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig(),
    {
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: 3667925015,
      user_id: 1056612947,
      target_id: 3667925015,
      // 没有 group_id = 私聊
    },
    { lastPokeAt: 0 },
    stats,
    store,
  );
  assert.equal(calls.filter((c) => c.action === 'friend_poke').length, 1);
  assert.equal(calls.filter((c) => c.action === 'send_private_msg').length, 1);
});

await test('戳的是别人 → 完全不管', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const handled = await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig(),
    {
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: 3667925015,
      user_id: 1056612947,
      target_id: 999999999, // 戳的是第三方
      group_id: 111,
    },
    { lastPokeAt: 0 },
    {},
    store,
  );
  assert.equal(handled, false);
  assert.equal(calls.length, 0, '不该有任何动作');
});

await test('自己戳自己 → 当噪音忽略', async () => {
  const calls = fakeOnebot();
  const handled = await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig(),
    {
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: 3667925015,
      user_id: 3667925015,
      target_id: 3667925015,
      group_id: 111,
    },
    { lastPokeAt: 0 },
    {},
    tmpStore(),
  );
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

await test('开关关着就什么都不做', async () => {
  const calls = fakeOnebot();
  const handled = await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig({ pokeReplyEnabled: false }),
    groupPokeEvent(),
    { lastPokeAt: 0 },
    {},
    tmpStore(),
  );
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

await test('全局最小间隔：连戳第二次不回', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const config = baseConfig({ pokeReplyMinIntervalMs: 60_000 });
  const state = { lastPokeAt: 0 };
  const ev = groupPokeEvent();
  await __test.handlePokeNotice(fakeCtx(), config, ev, state, {}, store);
  const after1 = calls.length;
  const stats2 = {};
  await __test.handlePokeNotice(fakeCtx(), config, ev, state, stats2, store);
  assert.equal(calls.length, after1, '第二次不该再发');
  assert.equal(stats2.pokeThrottled, 1);
});

await test('每人每小时上限（持久，落盘）', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const config = baseConfig({ pokeReplyMinIntervalMs: 0, pokeReplyPerSenderPerHour: 2 });
  const state = { lastPokeAt: 0 };
  const ev = groupPokeEvent();
  for (let i = 0; i < 4; i += 1) {
    await __test.handlePokeNotice(fakeCtx(), config, ev, state, {}, store);
  }
  const pokes = calls.filter((c) => c.action === 'group_poke').length;
  assert.equal(pokes, 2, `每小时上限 2，实际回戳 ${pokes} 次`);
});

await test('群白名单外的群不回戳', async () => {
  const calls = fakeOnebot();
  const stats = {};
  const handled = await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig({ pokeReplyGroups: ['777'] }),
    groupPokeEvent({ group_id: 111 }),
    { lastPokeAt: 0 },
    stats,
    tmpStore(),
  );
  assert.equal(handled, true, '已处理（决定是不回）');
  assert.equal(calls.length, 0);
  assert.equal(stats.pokeSkipped, 1);
});

await test('groups 白名单同样拦截（回戳不能绕开它）', async () => {
  const calls = fakeOnebot();
  const handled = await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig({ groups: ['777'] }),
    groupPokeEvent({ group_id: 111 }),
    { lastPokeAt: 0 },
    {},
    tmpStore(),
  );
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
});

await test('群里只回戳不冒泡（pokeReplyGroupText=false）', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  await __test.handlePokeNotice(
    fakeCtx(),
    baseConfig({ pokeReplyGroupText: false }),
    groupPokeEvent(),
    { lastPokeAt: 0 },
    {},
    store,
  );
  assert.equal(calls.filter((c) => c.action === 'group_poke').length, 1);
  assert.equal(calls.filter((c) => c.action === 'send_group_msg').length, 0, '不该发文字');
});

console.log('\nevents: 表情回应');

/** 一个形状完整的群里"表情回应"事件。 */
function reactionEvent(overrides = {}) {
  return {
    post_type: 'notice',
    notice_type: 'group_msg_emoji_like',
    self_id: 3667925015,
    user_id: 1056612947,
    group_id: 9,
    message_id: 'msg-mine-1',
    likes: [{ emoji_id: '128077' }],
    is_add: true,
    ...overrides,
  };
}

await test('别人给她自己的发言点赞 → 记下来', async () => {
  const stats = {};
  const state = { ownMessageIds: new Set(['msg-mine-1']) };
  const handled = await __test.handleReactionNotice(
    fakeCtx(),
    baseConfig(),
    reactionEvent(),
    state,
    stats,
    tmpStore(),
  );
  assert.equal(handled, true);
  assert.equal(stats.reactionsSeen, 1);
  assert.equal(stats.reactionsIgnored, undefined, '是给她的，不该被忽略');
  const entry = state.pendingReactions.get('msg-mine-1');
  assert.ok(entry, '应该记进 pendingReactions');
  assert.deepEqual(entry.add, ['128077']);
});

await test('**别人之间**的点赞不算给她的（防自作多情）', async () => {
  const stats = {};
  const state = { ownMessageIds: new Set(['msg-mine-1']) };
  await __test.handleReactionNotice(
    fakeCtx(),
    baseConfig(),
    reactionEvent({ message_id: 'msg-someone-else' }),
    state,
    stats,
    tmpStore(),
  );
  assert.equal(stats.reactionsSeen, 1);
  assert.equal(stats.reactionsIgnored, 1, '不是她的消息要计入忽略');
  assert.equal(state.pendingReactions.size, 0, '绝不能进提示词');
});

await test('撤销回应会被单独记成 remove', async () => {
  const state = { ownMessageIds: new Set(['m1']) };
  await __test.handleReactionNotice(
    fakeCtx(),
    baseConfig(),
    reactionEvent({ message_id: 'm1', is_add: false, likes: [{ emoji_id: '128516' }] }),
    state,
    {},
    tmpStore(),
  );
  const e = state.pendingReactions.get('m1');
  assert.deepEqual(e.remove, ['128516']);
  assert.deepEqual(e.add, []);
});

await test('同一条消息多次点赞会累加而不是覆盖', async () => {
  const state = { ownMessageIds: new Set(['m1']) };
  const cfg = baseConfig();
  await __test.handleReactionNotice(
    fakeCtx(),
    cfg,
    reactionEvent({ message_id: 'm1', likes: [{ emoji_id: '128077' }] }),
    state,
    {},
    tmpStore(),
  );
  await __test.handleReactionNotice(
    fakeCtx(),
    cfg,
    reactionEvent({ message_id: 'm1', likes: [{ emoji_id: '128516' }] }),
    state,
    {},
    tmpStore(),
  );
  assert.deepEqual(state.pendingReactions.get('m1').add, ['128077', '128516']);
});

await test('重复的同一个表情不会重复记', async () => {
  const state = { ownMessageIds: new Set(['m1']) };
  const cfg = baseConfig();
  for (let i = 0; i < 3; i += 1) {
    await __test.handleReactionNotice(fakeCtx(), cfg, reactionEvent({ message_id: 'm1' }), state, {}, tmpStore());
  }
  assert.deepEqual(state.pendingReactions.get('m1').add, ['128077']);
});

await test('没有 message_id 的事件直接忽略', async () => {
  const state = { ownMessageIds: new Set() };
  const handled = await __test.handleReactionNotice(
    fakeCtx(),
    baseConfig(),
    reactionEvent({ message_id: undefined }),
    state,
    {},
    tmpStore(),
  );
  assert.equal(handled, false);
});

await test('没有 ownMessageIds 时不崩（老会话没有这个集合）', async () => {
  const state = {}; // 故意不给 ownMessageIds
  const handled = await __test.handleReactionNotice(
    fakeCtx(),
    baseConfig(),
    reactionEvent(),
    state,
    {},
    tmpStore(),
  );
  assert.equal(handled, true, '不该抛异常');
  assert.equal(state.pendingReactions.size, 0, '判不出是自己的，就不进提示词');
});

console.log('\nevents: 加好友 / 入群申请');

const friendRequest = {
  post_type: 'request',
  request_type: 'friend',
  self_id: 3667925015,
  user_id: 1056612947,
  comment: '我是群友',
  flag: 'flag-friend-1',
  sender: { nickname: '天梦·幻' },
};

await test('申请默认**不自动同意**，只记库', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const stats = {};
  // 关键：autoHandleRequestAction 故意设成 approve，
  // 但只要 autoHandleRequests 是 false，就绝不能真的同意
  const handled = await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({ autoHandleRequestAction: 'approve' }),
    friendRequest,
    stats,
    store,
  );

  assert.equal(handled, true);
  assert.equal(
    calls.filter((c) => c.action === 'set_friend_add_request').length,
    0,
    'autoHandleRequests 关着时绝不能自动同意 —— 这是安全底线',
  );
  const open = store.listOpenRequests('friend');
  assert.equal(open.length, 1);
  assert.equal(open[0].flag, 'flag-friend-1');
  assert.equal(open[0].comment, '我是群友');
  assert.equal(open[0].nickname, '天梦·幻');
  assert.equal(stats.requestsReceived, 1);
});

await test('转发给 notifyUsers（只走私聊）', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const stats = {};
  await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({ notifyUsers: ['1056612947', '100000002'] }),
    friendRequest,
    stats,
    store,
  );

  const sent = calls.filter((c) => c.action === 'send_private_msg');
  assert.equal(sent.length, 2, '名单里两个人各通知一次');
  assert.deepEqual(
    sent.map((c) => c.payload.user_id).sort((a, b) => a - b),
    [100000002, 1056612947].sort((a, b) => a - b),
  );
  assert.match(sent[0].payload.message, /加好友申请/);
  assert.match(sent[0].payload.message, /我是群友/);
  assert.match(sent[0].payload.message, /flag-friend-1/);
  assert.equal(stats.requestsNotified, 2);
});

await test('通知名单为空时不发通知，但申请仍记库', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  await __test.handleAddRequest(fakeCtx(), baseConfig(), friendRequest, {}, store);
  assert.equal(calls.length, 0, '没人可通知就不发消息');
  assert.equal(store.listOpenRequests('friend').length, 1, '但数据库里要有，否则这条申请就丢了');
});

await test('重复上报只记一次、只通知一次', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const config = baseConfig({ notifyUsers: ['1056612947'] });
  await __test.handleAddRequest(fakeCtx(), config, friendRequest, {}, store);
  const after1 = calls.length;
  const stats2 = {};
  await __test.handleAddRequest(fakeCtx(), config, friendRequest, stats2, store);

  assert.equal(calls.length, after1, '重推不该再通知一遍');
  assert.equal(stats2.requestDuplicates, 1);
  assert.equal(store.listOpenRequests('friend').length, 1);
});

await test('入群申请带 group_id 和附言', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({ notifyUsers: ['1056612947'] }),
    {
      post_type: 'request',
      request_type: 'group',
      sub_type: 'add',
      self_id: 3667925015,
      user_id: 999,
      group_id: 111,
      comment: '求进群',
      flag: 'flag-group-1',
      sender: { nickname: '路人' },
    },
    {},
    store,
  );
  const open = store.listOpenRequests('group');
  assert.equal(open.length, 1);
  assert.equal(open[0].groupId, '111');
  assert.match(calls[0].payload.message, /入群申请/);
  assert.match(calls[0].payload.message, /群 111|111/);
});

await test('没有 flag 的申请直接忽略（处理不了）', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  const handled = await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({ notifyUsers: ['1056612947'] }),
    { post_type: 'request', request_type: 'friend', user_id: 1, comment: 'x' },
    {},
    store,
  );
  assert.equal(handled, false);
  assert.equal(calls.length, 0);
  assert.equal(store.listOpenRequests().length, 0, '没 flag 就不该入库，否则永远决议不了');
});

await test('显式开启自动处理才会真的同意', async () => {
  const store = tmpStore();
  const calls = fakeOnebot();
  await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({ autoHandleRequests: true, autoHandleRequestAction: 'approve' }),
    friendRequest,
    {},
    store,
  );
  const auto = calls.filter((c) => c.action === 'set_friend_add_request');
  assert.equal(auto.length, 1);
  assert.equal(auto[0].payload.approve, true);
  assert.equal(auto[0].payload.flag, 'flag-friend-1');
  // 已决议的申请不该再出现在待处理列表里
  assert.equal(store.listOpenRequests('friend').length, 0);
});

await test('自动处理失败时如实告知，不假装成功', async () => {
  const store = tmpStore();
  const calls = fakeOnebot({ set_friend_add_request: 'fail' });
  const stats = {};
  await __test.handleAddRequest(
    fakeCtx(),
    baseConfig({
      autoHandleRequests: true,
      autoHandleRequestAction: 'approve',
      notifyUsers: ['1056612947'],
    }),
    friendRequest,
    stats,
    store,
  );
  const notify = calls.find((c) => c.action === 'send_private_msg');
  assert.match(notify.payload.message, /自动处理失败/);
  assert.equal(store.listOpenRequests('friend').length, 1, '失败了就该还留在待处理里');
  assert.equal(stats.requestsAutoHandled, undefined);
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
