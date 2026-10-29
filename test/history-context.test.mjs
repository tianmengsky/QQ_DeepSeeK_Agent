/**
 * 上下文来源：**直接注入 QQ 历史**。
 *
 * 这条测试防的是用户实测到的问题：
 *   "她只能看见托管期间的消息，QQ 里的历史上下文看不见"
 *
 * 根因：桥接只知道自己收到过的消息。托管关着、插件重载中、缓冲被挤掉的时段，
 * 群里的对话在桥接这边是空白的 —— 实测群里 12:12 那三条真实对话，
 * 桥接库里一条都没有，于是被唤醒时它完全不知道刚才聊了什么。
 *
 * 修法：每轮开之前用 `get_group_msg_history` 回读，**直接**替换窗口。
 *
 *   node test/history-context.test.mjs
 */
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bridge = await import(
  pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href
);

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

// ---------------------------------------------------------------- 假件

function fakeRequest(body) {
  const json = JSON.stringify(body);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    complete: true,
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(json, 'utf8');
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(n, v) {
      this.headers[n] = v;
    },
    writeHead(c) {
      this.statusCode = c;
      return this;
    },
    end(text) {
      this.payload = text ? JSON.parse(text) : null;
    },
  };
}

function fakeCtx(sessionController) {
  const routes = [];
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionController,
    get: (n) => (n === 'sessionController' ? sessionController : undefined),
    webServer: { register: (r) => (routes.push(r), () => {}) },
    // 宿主给了事件总线（B 站外部消息走 ctx.on 进来）；假的 ctx 也得有一个，
    // 否则 handle 一构造就 TypeError，测试会整片红。
    on: () => () => {},
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
  };
  ctx.routes = routes;
  return ctx;
}

function fakeSessionController(replyText = '哦') {
  const prompts = [];
  let seq = 0;
  return {
    prompts,
    async create() {
      seq += 1;
      return { sessionId: `s${seq}` };
    },
    async selectModel() {
      return {};
    },
    follow() {
      const base = (seq + 1) * 1000;
      let step = 0;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'snapshot', cursor: base };
          while (step < 2) {
            await new Promise((r) => setTimeout(r, 5));
            if (step === 0) {
              yield {
                type: 'event',
                event: {
                  seq: base + 1,
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: replyText }] } },
                },
              };
            } else {
              yield {
                type: 'event',
                event: { seq: base + 2, type: 'turn/end', data: { reason: { kind: 'ok' } } },
              };
            }
            step += 1;
          }
        },
      };
    },
    async prompt(req) {
      prompts.push(req);
    },
  };
}

const SELF = 3667925015;
const GROUP = 100000001;

/**
 * 假的 OneBot：`get_group_msg_history` 返回一段"桥接从没收到过"的历史。
 *
 * 关键点：这些内容**不在**桥接的任何缓冲里 —— 模拟"未托管期间的消息"。
 */
function fakeOnebot(historyMessages) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    let params = {};
    try {
      params = JSON.parse(init.body);
    } catch {}
    calls.push({ action, params });
    let data = { message_id: calls.length };
    if (action === 'get_group_msg_history') data = { messages: historyMessages };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data }),
    };
  };
  return calls;
}

/** 一条 QQ 历史里的群消息。 */
function histMsg(uid, nick, text, secondsAgo = 30) {
  return {
    message_id: Math.floor(Math.random() * 1e9),
    time: Math.floor((Date.now() - secondsAgo * 1000) / 1000),
    sender: { user_id: uid, nickname: nick },
    message: text.startsWith('[')
      ? [{ type: 'image', data: { file: 'x.jpg' } }]
      : [{ type: 'text', data: { text } }],
  };
}

function baseConfig(overrides = {}) {
  return bridge.Config({
    path: '/qq/onebot',
    cwd: os.tmpdir(),
    selfIds: [String(SELF)],
    groups: [],
    groupEnabled: true,
    privateEnabled: true,
    groupTrigger: 'at',
    agentEnabled: true,
    heartbeatEnabled: false,
    persistenceEnabled: false,
    imagesEnabled: false,
    stickerMode: 'off',
    memoryEnabled: true,
    replyToGroups: true,
    pokeReplyEnabled: true,
    pokeReplyMode: 'agent',
    pokeAgentMinIntervalMs: 0,
    pokeAgentPerSenderPerHour: 0,
    ...overrides,
  });
}

const realFetch = globalThis.fetch;

const HISTORY = [
  histMsg(111, '天梦·幻', '诶，你怎么死了', 400),
  histMsg(222, '辛斯普里特牛奶', '遇到难回答的问题就不回答了', 380),
  histMsg(SELF, 'DeepSeek大肥鱼', '别戳 会戳坏的', 200),
  histMsg(333, '淼293', '又卡了？', 60),
];

console.log('\nhistory-context: 直接注入 QQ 历史');

await test('**未托管期间的群消息会被注入**（桥接从没收到过它们）', async () => {
  const calls = fakeOnebot(HISTORY);
  const sc = fakeSessionController('在的在的');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig());
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  // 直接戳它 —— 桥接的缓冲里**什么都没有**
  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(sc.prompts.length, 1, '戳应该唤醒一轮');
  const text = sc.prompts[0].content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

  assert.match(text, /诶，你怎么死了/, '未托管期间的消息必须出现');
  assert.match(text, /遇到难回答的问题就不回答了/, '第二条也要在');
  assert.match(text, /又卡了？/, '最近一条也要在');

  // 确实调了历史接口
  assert.ok(
    calls.some((c) => c.action === 'get_group_msg_history'),
    '应该调用 get_group_msg_history',
  );
});

await test('她**自己**发过的话也进上下文（reportSelfMessage 关着时桥接收不到）', async () => {
  const calls = fakeOnebot(HISTORY);
  const sc = fakeSessionController('嗯');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig());
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 600));

  const text = sc.prompts[0].content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  assert.match(text, /别戳 会戳坏的/, '她自己说过的话也要在上下文里');
  assert.match(text, /你自己刚才说的/, '而且要标成"她自己说的"，不能混成别人的话');
});

await test('顺序是从旧到新（最近的贴着当前消息）', async () => {
  const calls = fakeOnebot(HISTORY);
  const sc = fakeSessionController('嗯');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig());
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 600));

  const text = sc.prompts[0].content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const iNewest = text.indexOf('又卡了？');
  const iOldest = text.indexOf('诶，你怎么死了');
  assert.ok(iNewest >= 0 && iOldest >= 0, '两条都该在');
  assert.ok(iNewest > iOldest, '最近的「又卡了？」必须排在更旧的「诶，你怎么死了」后面');
});

await test('窗口紧贴在「现在这条消息」上方', async () => {
  const calls = fakeOnebot(HISTORY);
  const sc = fakeSessionController('嗯');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig());
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 600));

  const text = sc.prompts[0].content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const iWindow = text.indexOf('【最近聊了什么');
  const iCurrent = text.indexOf('════════ 现在这条消息');
  assert.ok(iWindow >= 0, '该有窗口段');
  assert.ok(iCurrent > iWindow, '窗口必须在「现在这条消息」之前');
  // 中间不该夹着大段别的说明
  const between = text.slice(iWindow, iCurrent);
  assert.ok(
    between.length < 1200,
    `窗口和当前消息之间不该夹太多东西（实际 ${between.length} 字符）`,
  );
});

await test('回读失败时**退回原有窗口**，不影响发言', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    calls.push({ action });
    if (action === 'get_group_msg_history') {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ status: 'failed', retcode: 1, message: 'boom' }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }),
    };
  };
  const sc = fakeSessionController('还在');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig());
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 600));

  assert.equal(sc.prompts.length, 1, '回读失败也必须照常说话');
});

await test('关掉 contextFromQQHistory 就不回读', async () => {
  const calls = fakeOnebot(HISTORY);
  const sc = fakeSessionController('嗯');
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, baseConfig({ contextFromQQHistory: false }));
  const route = ctx.routes.find((r) => r.path === '/qq/onebot');

  await route.handler(
    fakeRequest({
      post_type: 'notice',
      notice_type: 'notify',
      sub_type: 'poke',
      self_id: SELF,
      user_id: 1056612947,
      target_id: SELF,
      group_id: GROUP,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '天梦·幻' },
    }),
    fakeResponse(),
  );
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(
    calls.filter((c) => c.action === 'get_group_msg_history').length,
    0,
    '关掉之后不该回读',
  );
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
