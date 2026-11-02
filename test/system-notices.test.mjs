/**
 * system-notices.test.mjs —— 禁言/头衔等系统 notice 事件进会话窗口。
 *
 *   node test/system-notices.test.mjs
 *
 * 背景：以前 routes/onebot.mjs 的 notice 分支只认撤回、戳一戳、表情回应，
 * 其余全部 `return` 丢掉 —— 群友一句"你被禁言了"（纯文字）她没法核实，
 * 因为真实的"你被群主禁言10分钟"（notice: group_ban）根本进不了上下文。
 *
 * 本文件钉两件事：
 *   1. 渲染映射：notice → 一句系统文案（你/QQ 号、时长、解除、头衔）。
 *   2. 端到端：真 handler 收到 group_ban 后不触发回合，但下一条被接纳的
 *      消息的提示词里能看到「系统：你被禁言 10 分钟」；白名单外的群不记。
 *
 * 全程不发真消息，假 OneBot / 假 DSH 与 poke-wake.test.mjs 同一套路。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

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

function fakeSessionController(replyText = '干嘛呀') {
  const prompts = [];
  let seq = 0;
  return {
    prompts,
    async create() {
      seq += 1;
      return { sessionId: `sess-${seq}` };
    },
    async selectModel() {
      return { selected: {} };
    },
    follow() {
      const base = seq * 1000;
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
              yield { type: 'event', event: { seq: base + 2, type: 'turn/end', data: { reason: { kind: 'ok' } } } };
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

function fakeCtx(sessionController) {
  const routes = [];
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sessionController,
    get: (name) => (name === 'sessionController' ? sessionController : undefined),
    webServer: { register: (route) => routes.push(route) },
    on: (name, fn) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    },
    emit: (name, payload) => {
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    effect: (fn) => {
      const d = fn();
      return typeof d === 'function' ? d : () => {};
    },
  };
  ctx.routes = routes;
  return ctx;
}

function baseConfig(overrides = {}) {
  return {
    path: '/qq/onebot',
    token: '',
    maxBodyBytes: 1048576,
    onebotHttp: 'http://127.0.0.1:3000',
    onebotToken: '',
    cwd: os.tmpdir(),
    agentPreset: '',
    groups: ['100000001'],
    users: [],
    groupEnabled: true,
    privateEnabled: true,
    groupTrigger: 'at',
    groupPrefix: '',
    nameTriggers: ['deepseek'],
    selfIds: ['3667925015'],
    replyTimeoutMs: 5000,
    maxReplyChars: 1500,
    replyToGroups: true,
    maxImageBytes: 4194304,
    imagesEnabled: false,
    imageMode: 'never',
    imageTriggers: [],
    imageHallucinationFilter: true,
    readImagesInPrivate: true,
    attachQuotedImages: true,
    agentEnabled: true,
    qqDataPath: '',
    persona: '你是一只测试鲸鱼。',
    personaFile: '',
    behaviorFile: '',
    examplesFile: '',
    stickerHints: false,
    stickerMinGapTurns: 0,
    stickerCatalogPath: '',
    stickerCatalogLimit: 0,
    heartbeatEnabled: false,
    heartbeatMs: 300000,
    heartbeatBufferSize: 20,
    heartbeatUnreadThreshold: 6,
    heartbeatIdleMs: 60000,
    heartbeatCooldownMs: 180000,
    heartbeatProvider: '',
    heartbeatModel: '',
    maxBubbles: 1,
    bubbleDelayPerCharMs: 0,
    bubbleDelayMinMs: 0,
    bubbleDelayMaxMs: 0,
    replyShapes: ['1'],
    silenceToken: '[SKIP]',
    awakeMs: 30000,
    memoryEnabled: false,
    memoryDir: '',
    memoryMaxEntries: 20,
    memoryInjectRecent: 0,
    windowTurns: 10,
    rotateEveryTurns: 10,
    rememberMarker: '[记住:',
    injectStaticOnce: true,
    injectWindowOnce: true,
    memoryInjectOnChange: true,
    debugUsers: [],
    debugPrefix: '#debug',
    llmProvider: '',
    llmModel: '',
    llmReasoningEffort: '',
    stateDir: os.tmpdir(),
    persistenceEnabled: false,
    sendQuotaPerHour: 0,
    sendQuotaPerMinute: 0,
    countBubblesAsOne: true,
    eventsKeepPerConversation: 100,
    restoreBufferOnLoad: false,
    dedupeIncoming: true,
    autoHandleRequests: false,
    autoHandleRequestAction: 'reject',
    ...overrides,
  };
}

function fakeOnebot() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    calls.push({ action, payload: init ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: calls.length } }),
    };
  };
  return calls;
}

async function waitFor(predicate, { timeoutMs = 8000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function fakeRequest(body, method = 'POST') {
  const json = JSON.stringify(body);
  const chunks = [Buffer.from(json, 'utf8')];
  return {
    method,
    complete: true,
    headers: { 'content-length': String(Buffer.byteLength(json)) },
    resume() {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    payload: null,
    headersSent: false,
    headers: {},
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    },
    end(text) {
      this.headersSent = true;
      this.payload = text ? JSON.parse(text) : null;
    },
  };
}

/** 启动桥接并拿到路由 handler。 */
async function start(config) {
  const calls = fakeOnebot();
  const sc = fakeSessionController();
  const ctx = fakeCtx(sc);
  bridge.apply(ctx, config);
  const route = ctx.routes.find((r) => r.path === config.path);
  assert.ok(route, '应该注册了上报路由');
  const post = async (event) => {
    const res = fakeResponse();
    await route.handler(fakeRequest(event), res);
    return res;
  };
  return { calls, sc, post };
}

/** 被接纳的群消息：@ 她 + 一句话。 */
function groupAt(overrides = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 3667925015,
    user_id: 942042148,
    group_id: 100000001,
    message_id: 321434012,
    time: 1791602100,
    sender: { card: '蚝油叉烧包', nickname: '蚝油叉烧包' },
    message: [
      { type: 'at', data: { qq: '3667925015' } },
      { type: 'text', data: { text: '刚才谁把你禁言了？' } },
    ],
    ...overrides,
  };
}

function promptText(prompt) {
  return (prompt?.content ?? prompt?.messages ?? [])
    .map((p) => p.text ?? (typeof p === 'string' ? p : ''))
    .join('\n');
}

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------- 渲染映射

const { renderSystemNoticeText } = await import(
  pathToFileURL(path.join(process.cwd(), 'lib', 'application', 'system-notices.mjs')).href
);

await test('group_ban：自己被禁言按分钟报', () => {
  const text = renderSystemNoticeText({
    notice_type: 'group_ban', sub_type: 'ban', self_id: 3667925015,
    user_id: 3667925015, operator_id: 10001, duration: 600,
  }, ['3667925015']);
  assert.equal(text, '你被禁言 10 分钟');
});

await test('group_ban：别人被禁言报 QQ 号，秒数不换算成假分钟', () => {
  const text = renderSystemNoticeText({
    notice_type: 'group_ban', sub_type: 'ban', self_id: 3667925015,
    user_id: 942042148, duration: 90,
  }, ['3667925015']);
  assert.equal(text, 'QQ 942042148被禁言 90 秒');
});

await test('group_ban：解除禁言', () => {
  const text = renderSystemNoticeText({
    notice_type: 'group_ban', sub_type: 'lift_ban', self_id: 3667925015,
    user_id: 3667925015, duration: 0,
  }, ['3667925015']);
  assert.equal(text, '你被解除禁言');
});

await test('honor：头衔映射成中文', () => {
  const text = renderSystemNoticeText({
    notice_type: 'honor', sub_type: 'talkative', self_id: 3667925015,
    user_id: 3667925015,
  }, ['3667925015']);
  assert.equal(text, '你获得了群荣誉「龙王」');
});

await test('不认识的 notice 返回 null', () => {
  assert.equal(renderSystemNoticeText({ notice_type: 'group_msg_emoji_like' }), null);
  assert.equal(renderSystemNoticeText({ notice_type: 'group_ban', sub_type: 'whatever' }), null);
  assert.equal(renderSystemNoticeText(null), null);
});

// ---------------------------------------------------------------- 端到端

await test('group_ban 不触发回合，但下一条消息的提示词看得见', async () => {
  const config = baseConfig();
  const { sc, post } = await start(config);
  const res = await post({
    post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban',
    self_id: 3667925015, user_id: 3667925015, operator_id: 10001,
    duration: 600, group_id: 100000001, time: 1791602050,
  });
  assert.equal(res.statusCode, 204);
  assert.equal(sc.prompts.length, 0, '系统事件不能触发回合');
  await waitFor(() => sc.prompts.length > 0, { timeoutMs: 400 });
  assert.equal(sc.prompts.length, 0, '系统事件不能延迟触发回合');

  await post(groupAt());
  assert.ok(await waitFor(() => sc.prompts.length > 0), '@ 消息应该触发一轮');
  const text = promptText(sc.prompts[0]);
  assert.match(text, /你被禁言 10 分钟/, '提示词里应该有系统事件');
  assert.match(text, /系统/, '发送者应该显示为「系统」');
});

await test('白名单外的群不记录系统事件', async () => {
  const config = baseConfig();
  const { sc, post } = await start(config);
  await post({
    post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban',
    self_id: 3667925015, user_id: 3667925015, operator_id: 10001,
    duration: 600, group_id: 999999999, time: 1791602050,
  });
  await post(groupAt({ group_id: 999999999 }));
  await waitFor(() => sc.prompts.length > 0, { timeoutMs: 300 });
  assert.equal(sc.prompts.length, 0, '白名单外的群整个回合都不该发生');
});

await test('systemNoticesEnabled: false 时事件被丢弃', async () => {
  const config = baseConfig({ systemNoticesEnabled: false });
  const { sc, post } = await start(config);
  await post({
    post_type: 'notice', notice_type: 'group_ban', sub_type: 'ban',
    self_id: 3667925015, user_id: 3667925015, operator_id: 10001,
    duration: 600, group_id: 100000001, time: 1791602050,
  });
  await post(groupAt());
  assert.ok(await waitFor(() => sc.prompts.length > 0), '@ 消息应该触发一轮');
  const text = promptText(sc.prompts[0]);
  assert.doesNotMatch(text, /你被禁言/, '开关关闭时系统事件不进上下文');
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
