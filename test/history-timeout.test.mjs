/**
 * 群历史回读的等待上限。
 *
 * 为什么单独测：`onebotCall` 默认 15 秒。SnowLuma 正常时几十毫秒就回，
 * 但卡住一次，这一轮会在"还没开始拼提示词"之前白等十几秒，用户看到的就是
 * "她彻底不理人"。现在按 `contextHistoryTimeoutMs`（默认 3s）收手，
 * 退回内存窗口照常回答，并单独记 `historyFetchTimeouts`。
 */
import assert from 'node:assert/strict';
import { refreshWindowFromQQHistory, prefetchHistory } from '../lib/conversation/history.mjs';

const realFetch = globalThis.fetch;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e.stack); }
}

const makeLogger = () => { const warnings = []; return { warnings, logger: { warn: (m) => warnings.push(m), info: () => {} } }; };
const baseConfig = (over = {}) => ({ contextFromQQHistory: true, contextHistoryCacheMs: 0,
  contextHistoryCount: 5, contextHistoryTimeoutMs: 30, onebotHttp: 'http://127.0.0.1:1', onebotToken: '', ...over });

await test('回读超时按失败处理：不拖住回合，窗口保持原样', async () => {
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  // AbortSignal.timeout 的定时器是 unref 的：测试进程空闲时事件循环先空掉，
  // 定时器来不及触发。真实桥接里始终有别的 timer/连接撑着，这里补一个 keepalive。
  const keepAlive = setInterval(() => {}, 5);
  try {
    const { warnings, logger } = makeLogger();
    const ctx = { logger };
    const before = [{ messageId: 'old', text: '旧窗口', at: Date.now() }];
    const entry = { window: before, recalledIds: [], contextTurn: 0 };
    const registry = { trimWindow: () => {}, entry: () => entry };
    const stats = {};
    const startedAt = Date.now();
    const added = await refreshWindowFromQQHistory(ctx, baseConfig(), registry, entry, 'group:1', stats);
    const elapsed = Date.now() - startedAt;
    assert.equal(added, 0);
    assert.equal(stats.historyFetchTimeouts, 1, '超时单独计数');
    assert.equal(stats.historyFetchFailed ?? 0, 0, '超时不要混进普通失败');
    assert.equal(entry.window, before, '超时不能改动已有窗口');
    assert.ok(elapsed < 1000, `必须在配置上限附近收手，实际 ${elapsed}ms`);
    assert.match(warnings[0] ?? '', /超过 30ms/);
  } finally { clearInterval(keepAlive); globalThis.fetch = realFetch; }
});

await test('正常返回仍然刷新窗口（超时改动不影响成功路径）', async () => {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [
      { message_id: 'm1', time: Math.floor(Date.now() / 1000), sender: { user_id: 200, nickname: '甲' },
        message: [{ type: 'text', data: { text: '刚才说到哪了' } }] },
    ] } }),
  });
  try {
    const { warnings, logger } = makeLogger();
    const entry = { window: [], recalledIds: [], contextTurn: 0 };
    const registry = { trimWindow: () => {}, entry: () => entry };
    const stats = {};
    const added = await refreshWindowFromQQHistory({ logger }, baseConfig(), registry, entry, 'group:1', stats);
    assert.equal(added, 1);
    assert.equal(stats.historyRefreshed, 1);
    assert.equal(stats.historyFetchTimeouts ?? 0, 0);
    assert.equal(warnings.length, 0);
    assert.equal(entry.window[0].text, '刚才说到哪了');
    assert.equal(entry.window[0].qq, '200');
  } finally { globalThis.fetch = realFetch; }
});

await test('缓存期内不再请求（TTL 仍然生效）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [] } }) };
  };
  try {
    const entry = { window: [], recalledIds: [], contextTurn: 0, historyFetchedAt: Date.now() };
    const registry = { trimWindow: () => {}, entry: () => entry };
    const stats = {};
    await refreshWindowFromQQHistory({ logger: makeLogger().logger }, baseConfig({ contextHistoryCacheMs: 20000 }),
      registry, entry, 'group:1', stats);
    assert.equal(calls, 0, 'TTL 内不该再打 HTTP');
  } finally { globalThis.fetch = realFetch; }
});

await test('入站预取：并发只打一次、完成后回合命中 TTL', async () => {
  let calls = 0, release;
  globalThis.fetch = () => {
    calls++;
    return new Promise((resolve) => { release = resolve; });
  };
  try {
    const ctx = { logger: makeLogger().logger };
    const entry = { window: [], recalledIds: [], contextTurn: 0 };
    const registry = { trimWindow: () => {}, entry: () => entry };
    const stats = {};
    // 入站时预取（不 await），回合开始时再调用一次：此时还在飞，不能再打一遍。
    const pending = prefetchHistory(ctx, baseConfig({ contextHistoryCacheMs: 20000 }), registry, entry, 'group:1', stats);
    const during = await refreshWindowFromQQHistory(ctx, baseConfig({ contextHistoryCacheMs: 20000 }),
      registry, entry, 'group:1', stats);
    assert.equal(during, 0, '同一批请求进行中时不能并发再发');
    assert.equal(calls, 1, '并发去重要生效');
    release({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [
      { message_id: 'm9', time: Math.floor(Date.now() / 1000), sender: { user_id: 200 }, message: [{ type: 'text', data: { text: '预取到的消息' } }] },
    ] } }) });
    await pending;
    assert.equal(entry.window[0]?.text, '预取到的消息', '预取结果要写进窗口');
    const after = await refreshWindowFromQQHistory(ctx, baseConfig({ contextHistoryCacheMs: 20000 }),
      registry, entry, 'group:1', stats);
    assert.equal(after, 0);
    assert.equal(calls, 1, '预取完成后 TTL 内回合开始不再请求');
  } finally { globalThis.fetch = realFetch; }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
