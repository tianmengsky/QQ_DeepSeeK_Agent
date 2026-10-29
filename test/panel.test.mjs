import assert from 'node:assert/strict';

import { Config } from '../lib/index.js';
import { trackLastError } from '../lib/application/stats-errors.mjs';
import { createControlHandler } from '../lib/routes/control.mjs';
import { createPanelHandler, PAGE } from '../lib/routes/panel.mjs';
import { describeDuration, percentile, verdicts } from '../lib/panel/verdicts.mjs';

let passed = 0;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const ids = (list) => list.map((item) => item.id);
const levelOf = (list, id) => list.find((item) => item.id === id)?.level;

function healthy(over = {}) {
  return {
    ok: true,
    build: 'test-build',
    agentEnabled: true,
    conversations: 3,
    stats: { since: NOW - 60000, lastError: null, ttftSamples: [1200, 2400] },
    登录: { 当前: 'online' },
    reliability: { 持久化: '/tmp/bridge.db', 发送回执: { SUCCEEDED: 10 }, 待核对: [] },
    replyDelivery: { counts: { done: 5 }, failed: [], pending: [] },
    tasks: { counts: {}, active: [] },
    replyPolicy: { sendQuotas: [] },
    auxHealth: { degraded: false },
    出站队列: { items: 0, batches: 0, inFlightMs: 0 },
    heartbeat: { groups: [] },
    ...over,
  };
}

function fakeRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return {
    method,
    url,
    headers,
    complete: true,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(body);
    },
  };
}

function fakeResponse() {
  const response = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      response.headers[key.toLowerCase()] = value;
    },
    writeHead(code, headers) {
      response.statusCode = code;
      response.headersSent = true;
      for (const [key, value] of Object.entries(headers ?? {})) response.headers[key.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) response.body += String(chunk);
    },
  };
  return response;
}

// —— 判定：全绿压成一条 ——
assert.deepEqual(ids(verdicts(healthy(), NOW)), ['ok']);
passed++;

// —— 判定：红在前、灰在后，且每条都带齐五个字段 ——
const broken = healthy({
  agentEnabled: false,
  登录: { 当前: 'offline', 原因: '探测失败' },
  stats: { lastError: 'boom', lastErrorAt: NOW - 120000, ttftSamples: [99000] },
});
const ranked = verdicts(broken, NOW);
assert.equal(ranked[0].level, 'error');
assert.equal(ranked.at(-1).level, 'info');
assert.ok(ranked.every((item) => typeof item.id === 'string' && typeof item.label === 'string' &&
  typeof item.detail === 'string' && (item.goTo === null || ['tasks', 'delivery', 'failures'].includes(item.goTo))));
assert.ok(ranked.findIndex((item) => item.level === 'error') <
  ranked.findIndex((item) => item.level === 'info'));
passed++;

// —— 判定：坏消息各就各位 ——
const cases = [
  ['enabled', 'error', healthy({ agentEnabled: false })],
  ['login', 'error', healthy({ 登录: { 当前: 'offline' } })],
  ['recovery', 'error', healthy({ stats: { recovery: { 投递恢复: { paused: true, since: NOW - 90000 } } } })],
  ['lastError', 'error', healthy({ stats: { lastError: 'database disk image is malformed' } })],
  ['store', 'error', healthy({ reliability: { 持久化: null, 说明: '库没打开' } })],
  ['receipts', 'warn', healthy({ reliability: { 持久化: 'x', 发送回执: { UNKNOWN: 3 }, 待核对: [] } })],
  ['quarantine', 'warn', healthy({ replyDelivery: { counts: {}, failed: [], pending: [{ quarantined: true }] } })],
  ['tasksStuck', 'warn', healthy({
    tasks: { counts: { recovering: 1 }, active: [{ state: 'recovering', elapsedMs: 7 * 3600 * 1000 }] },
  })],
  ['quota', 'warn', healthy({ replyPolicy: { sendQuotas: [{ conversation: 'group:1', minute: { blocked: true } }] } })],
  ['aux', 'warn', healthy({ auxHealth: { degraded: true, successRate: 0.5, failed: 5, calls: 10, threshold: 0.6 } })],
  ['queue', 'warn', healthy({ 出站队列: { items: 4, batches: 1, inFlightMs: 30000 } })],
  ['heartbeat', 'warn', healthy({ heartbeat: { groups: [{ conversation: 'group:1', phase: 'retry', unread: 2 }] } })],
  ['slow', 'info', healthy({ stats: { ttftSamples: [20000, 22000] } })],
];
for (const [id, level, status] of cases) {
  const list = verdicts(status, NOW);
  assert.equal(levelOf(list, id), level, id);
}
assert.equal(verdicts(healthy(), NOW).length, 1, '健康快照不该冒出一堆绿条');
passed++;

// —— 判定：新鲜失败才算数，昨天的只进 tab ——
assert.equal(levelOf(verdicts(healthy({
  replyDelivery: { counts: {}, failed: [{ updated_at: NOW - 3600000, detail: '刚才' }], pending: [] },
}), NOW), 'deliveryFailed'), 'warn');
assert.equal(levelOf(verdicts(healthy({
  replyDelivery: { counts: {}, failed: [{ updated_at: NOW - 48 * 3600000, detail: '前天' }], pending: [] },
}), NOW), 'deliveryFailed'), undefined);
passed++;

// —— 判定：没数据、没时间戳也不能崩 ——
assert.deepEqual(ids(verdicts(null, NOW)), ['no-data']);
assert.deepEqual(ids(verdicts({ ok: false }, NOW)), ['no-data']);
const untimed = verdicts(healthy({ stats: { lastError: 'boom' } }), NOW);
assert.match(untimed.find((item) => item.id === 'lastError').detail, /时间未知/);
const empty = verdicts({ ok: true }, NOW);
assert.ok(empty.length >= 1, '空快照也要给出判定，而不是空白');
passed++;

// —— 小工具 ——
assert.equal(percentile([], 0.5), null);
assert.equal(percentile([3, 1, 2], 0.5), 2);
assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
assert.equal(describeDuration(0), '0秒');
assert.equal(describeDuration(61234), '1分1秒');
assert.equal(describeDuration((3 * 24 + 2) * 3600000), '3天2小时');
passed++;

// —— lastErrorAt：13 处赋值点靠一个访问器补时间戳 ——
const stats = { lastError: null };
trackLastError(stats, () => 1111);
stats.lastError = 'boom';
assert.equal(stats.lastErrorAt, 1111);
assert.equal(JSON.parse(JSON.stringify(stats)).lastError, 'boom', '快照里还得看得见原文');
const restored = { lastError: '旧错误' };
trackLastError(restored);
assert.equal(restored.lastError, '旧错误', '装上钩子不该改写已有值');
trackLastError(restored);
restored.lastError = '新错误';
assert.ok(restored.lastErrorAt > 0);
restored.lastError = null;
assert.equal(restored.lastErrorAt, null, '错误清掉后时间戳也跟着清掉，不能留住旧时间');
passed++;

// —— 面板页：外壳 + 内联脚本 ——
assert.match(PAGE, /^<!doctype html>/i);
assert.match(PAGE, /<meta charset="utf-8">/);
assert.doesNotMatch(PAGE.split('<script type="module">')[1] ?? '', /\bexport\b/,
  '内联进模块的代码不能留 export');
const inline = PAGE.split('<script type="module">')[1]?.split('</script>')[0] ?? '';
assert.ok(inline.includes('verdicts'), '判定逻辑要内联进页面，而不是再开一条路由');
assert.doesNotThrow(() => new Function(inline), '内联脚本必须能过语法解析');
assert.match(PAGE, /data-theme="day"/, '默认主题要落在 <html> 上，否则首帧没底');
assert.match(PAGE, /:root\[data-theme=night\]/, '夜间要自带一套变量，不能只靠换 class 名');
passed++;

const openConfig = Config({ token: '' });
const open = createPanelHandler(openConfig);
const pageResponse = fakeResponse();
open(fakeRequest('/qq/onebot/panel'), pageResponse);
assert.equal(pageResponse.statusCode, 200);
assert.match(pageResponse.headers['content-type'], /text\/html/);
assert.equal(pageResponse.headers['cache-control'], 'no-store');
assert.match(pageResponse.body, /<!doctype html>/i);
const headless = fakeResponse();
open(fakeRequest('/qq/onebot/panel', { method: 'POST' }), headless);
assert.equal(headless.statusCode, 405, '面板是只读的');
passed++;

// —— 面板页：token 不进 HTML ——
const secret = 'panel-secret-token';
const locked = createPanelHandler(Config({ token: secret }));
const anon = fakeResponse();
locked(fakeRequest('/qq/onebot/panel'), anon);
assert.equal(anon.statusCode, 401);
const viaQuery = fakeResponse();
locked(fakeRequest('/qq/onebot/panel?token=' + secret), viaQuery);
assert.equal(viaQuery.statusCode, 200);
assert.ok(!viaQuery.body.includes(secret), '页面正文里不能出现 token');
const viaHeader = fakeResponse();
locked(fakeRequest('/qq/onebot/panel', { headers: { authorization: 'Bearer ' + secret } }), viaHeader);
assert.equal(viaHeader.statusCode, 200);
const wrong = fakeResponse();
locked(fakeRequest('/qq/onebot/panel?token=nope'), wrong);
assert.equal(wrong.statusCode, 401);
passed++;

// —— 托管开关：跨站写请求要挡，命令行脚本（无 Origin）要放行 ——
function controlRig() {
  const state = { enabled: true, since: 1, persistEnabled(next) { state.enabled = next; } };
  const logs = [];
  const handler = createControlHandler({ logger: { info: (m) => logs.push(m) } }, Config({ token: '' }), state);
  return { state, logs, handler };
}

async function post(handler, headers) {
  const response = fakeResponse();
  await handler(fakeRequest('/qq/onebot/control', {
    method: 'POST', headers, body: JSON.stringify({ enabled: false }),
  }), response);
  return response;
}

const rig = controlRig();
const hostile = await post(rig.handler, { host: '127.0.0.1:10620', origin: 'https://evil.example' });
assert.equal(hostile.statusCode, 403);
assert.equal(rig.state.enabled, true, '被挡的请求不能改状态');

const opaque = await post(rig.handler, { host: '127.0.0.1:10620', origin: 'null' });
assert.equal(opaque.statusCode, 403);

const sniffed = await post(rig.handler, { host: '127.0.0.1:10620', 'sec-fetch-site': 'cross-site' });
assert.equal(sniffed.statusCode, 403);

const scripted = await post(rig.handler, { host: '127.0.0.1:10620' });
assert.equal(scripted.statusCode, 200, '没有 Origin 的调用方是启动脚本，必须放行');
assert.equal(rig.state.enabled, false);

const sameOrigin = await post(controlRig().handler, {
  host: '127.0.0.1:10620', origin: 'http://127.0.0.1:10620',
});
assert.equal(sameOrigin.statusCode, 200);

const badBody = fakeResponse();
const badRig = controlRig();
await badRig.handler(fakeRequest('/qq/onebot/control', {
  method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: JSON.stringify({ enabled: 'yes' }),
}), badBody);
assert.equal(badBody.statusCode, 400);
assert.equal(badRig.state.enabled, true);
passed++;

console.log(`${passed} passed, 0 failed`);
