/**
 * B1（空输出单独归因）与 B2（失败退避）的回归测试。
 *
 * 这两条都是为了修线上那条已经失效的辅助判断链路：
 *   · 192 条 `invalid-json` 的 `fallbackDetail` 是空串 —— 模型其实什么都没返回；
 *   · `memoryExtractFailed=406 / memoryExtractChecks=0` —— 每 30 秒重试同一批，永不放弃；
 *   · `heartbeatFailed=8 / Checks=10 / 插话 0` —— 一次失败锁 10 分钟。
 * 所以断言的重点是"归因分得开"和"退避有阶梯、能清零、到上限会丢弃"，不是内部实现。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __test } from '../lib/index.js';
import { Store } from '../lib/store.mjs';
import { rig, message } from './helpers/bridge.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { runHeartbeat } from '../lib/application/heartbeat.mjs';
import { decideReply } from '../lib/application/reply-decision.mjs';
import { evaluateAttention } from '../lib/application/attention.mjs';
import {
  AuxProbe,
  auxFailure,
  auxHealthSnapshot,
  recordAuxCall,
  resetAuxHealth,
} from '../lib/agent/aux-attribution.mjs';
import {
  HEARTBEAT_RETRY_LADDER,
  MEMORY_MAX_FAILURES,
  MEMORY_RETRY_LADDER,
  backoffDelay,
  ladderText,
} from '../lib/agent/backoff.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-aux-health-'));
const realFetch = globalThis.fetch;
const rigs = [];
let passed = 0, failed = 0, counter = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed++;
    console.error('  ✗ ' + name, error);
  }
}

const settings = { heartbeatEnabled: true, heartbeatUnreadThreshold: 6, heartbeatCooldownMs: 0, awakeMs: 0 };
function make(overrides = {}, llm = null) {
  const r = rig({ ...settings, ...overrides }, '接上话题', null, llm);
  rigs.push(r);
  return r;
}
async function feed(r, count, group = 10, offset = 0) {
  for (let i = 0; i < count; i++) await r.post(message(offset + i, '背景' + (offset + i), group));
}
/** 什么都不吐的模型 —— 线上最典型的失效形态。 */
const silent = () => ({ async *stream() {} });
/** 只吐思考、不吐正文的模型。 */
const thinking = () => ({ async *stream() { yield { type: 'reasoning-delta', text: '一直在想' }; } });
const source = (id = '1', text = '我不吃香菜') => ({ qq: '200', who: '甲', messageId: id, text, at: 1000 });

try {
  await test('auxSelection sends "off" except to a6api, which rejects any explicit effort', async () => {
    const { auxSelection } = await import('../lib/agent/aux-model.mjs');
    const ctx = { get: () => ({ currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'off' }) }) };
    const base = { auxProvider: 'aux-p', auxModel: 'aux-m' };
    // 线上事故：a6api 的 Responses 路由拒绝**任何**显式档位（'off' 和默认 'max' 都报
    // UNSUPPORTED_REASONING_EFFORT），表现为"流正常结束但零正文"，旧代码记成 invalid-json。
    // 所以对 a6api 只能不发这个字段。
    assert.equal(
      auxSelection(ctx, { auxProvider: 'a6api', auxModel: 'aux-m', auxReasoningEffort: 'off' }).reasoningEffort,
      undefined,
    );
    // 其他 provider（deepseek-official 等）认 'off'，必须显式发，
    // 否则会落到 provider 默认档（官方会话实测默认 high）继续思考。
    assert.equal(auxSelection(ctx, { ...base, auxReasoningEffort: 'off' }).reasoningEffort, 'off');
    // 明确档位原样发送。
    assert.equal(auxSelection(ctx, { ...base, auxReasoningEffort: 'low' }).reasoningEffort, 'low');
    assert.equal(auxSelection(ctx, { ...base, auxReasoningEffort: 'max' }).reasoningEffort, 'max');
    // 留空 = 不干预（保留调用方/会话带来的值）。
    assert.equal(auxSelection(ctx, { ...base, auxReasoningEffort: '' }).reasoningEffort, 'off');
    // 专用键（heartbeatProvider/Model）优先于 aux*。
    const dedicated = auxSelection(ctx, { ...base, auxReasoningEffort: 'off' },
      { provider: 'own-p', model: 'own-m' });
    assert.equal(dedicated.provider, 'own-p');
    assert.equal(dedicated.reasoningEffort, 'off');
  });

  await test('probe counts chunk kinds, finishReason and elapsed time', () => {
    const probe = new AuxProbe('routing');
    probe.observe({ type: 'reasoning-delta', text: '想了两句' });
    probe.observe({ type: 'text-delta', text: '{"a":1}' });
    probe.observe({ type: 'usage', finishReason: 'length' });
    assert.equal(probe.textChunks, 1);
    assert.equal(probe.reasoningChunks, 1);
    assert.equal(probe.otherChunks, 1);
    assert.equal(probe.finishReason, 'length');
    const detail = probe.detail('{"a":1}');
    // 格式是读库的人按着找规律的契约，别随手改。
    assert.match(detail, /^收到 1 段正文 \/ reasoning 1 段 \/ 用时 \d+ms/);
    assert.match(detail, /正文 7 字/);
    assert.match(detail, /思考 4 字/);
    assert.match(detail, /finishReason=length/);
    const empty = new AuxProbe('heartbeat').detail('');
    assert.match(empty, /^收到 0 段正文 \/ reasoning 0 段 \/ 用时 \d+ms/);
    assert.match(empty, /finishReason=未知/);
  });

  await test('empty body outranks the syntax error it causes', () => {
    // 这就是线上 192 条误记的现场：JSON.parse('') 抛 SyntaxError，但真相是模型没返回。
    const emptySyntax = auxFailure(new SyntaxError('Unexpected end of JSON input'), new AuxProbe('routing'), { text: '' });
    assert.equal(emptySyntax.cause, 'empty-output');
    const badJson = auxFailure(new SyntaxError('bad'), new AuxProbe('routing'), { text: '{oops' });
    assert.equal(badJson.cause, 'invalid-json');
    // 真抛了异常就报异常，别被"正文为空"抢走。
    const streamError = auxFailure(new Error('socket hang up'), new AuxProbe('routing'), { text: '' });
    assert.equal(streamError.cause, 'stream-error');
    const timeout = auxFailure(new Error('The operation was aborted due to timeout'), new AuxProbe('routing'), { text: '', timedOut: true });
    assert.equal(timeout.cause, 'timeout');
    // 有正文却没有布尔裁决。
    assert.equal(auxFailure(null, new AuxProbe('reply-decision'), { text: '{"a":1}' }).cause, 'invalid-verdict');
  });

  await test('retry ladders are 30s → 1m → 2m → 5m and stop at the cap', () => {
    assert.deepEqual(HEARTBEAT_RETRY_LADDER, [30000, 60000, 120000, 300000]);
    assert.deepEqual(MEMORY_RETRY_LADDER, [30000, 60000, 120000, 300000]);
    assert.deepEqual([1, 2, 3, 4, 5, 99].map((n) => backoffDelay(HEARTBEAT_RETRY_LADDER, n)),
      [30000, 60000, 120000, 300000, 300000, 300000]);
    // 0 / 负数 / 非数字都按第一档算：调用方不能因此算出"立刻重试"。
    assert.deepEqual([0, -3, undefined, 'x'].map((n) => backoffDelay(HEARTBEAT_RETRY_LADDER, n)),
      [30000, 30000, 30000, 30000]);
    assert.equal(ladderText(HEARTBEAT_RETRY_LADDER), '30s → 1m → 2m → 5m 封顶');
  });

  await test('heartbeat empty output is attributed, keeps unread and backs off 30s', async () => {
    const r = make({}, silent());
    await feed(r, 6);
    const entry = r.registry.entry('group:10');
    const decision = r.stats.lastHeartbeatDecision;
    assert.equal(decision.retry, true);
    assert.equal(decision.cause, 'empty-output');
    assert.match(decision.why, /模型返回空正文/);
    assert.match(decision.detail, /^收到 0 段正文 \/ reasoning 0 段 \/ 用时 \d+ms/);
    assert.equal(decision.failures, 1);
    assert.equal(decision.backoffMs, 30000);
    // 未读不能被丢掉，只推迟。
    assert.equal(entry.pending.length, 6);
    assert.equal(r.stats.heartbeatFailed, 1);
    const remaining = entry.heartbeatRetryAt - Date.now();
    assert.ok(remaining > 25000 && remaining <= 30000, 'first retry should be ~30s, got ' + remaining);
  });

  await test('heartbeat backoff walks the ladder, caps at 5m and resets after a real verdict', async () => {
    const llm = { fail: true, async *stream() { if (llm.fail) return; yield { type: 'text-delta', text: '{"speak":false}' }; } };
    const r = make({}, llm);
    await feed(r, 6);
    const entry = r.registry.entry('group:10');
    const delays = [entry.heartbeatRetryAt - Date.now()];
    // 每次都把退避清零重跑，模拟"退避到期后又失败"。
    for (let i = 0; i < 4; i++) {
      entry.heartbeatRetryAt = 0;
      await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
      delays.push(entry.heartbeatRetryAt - Date.now());
    }
    const remaining = delays.map((ms) => Math.round(ms / 1000));
    assert.deepEqual(remaining.slice(0, 4), [30, 60, 120, 300]);
    assert.equal(remaining[4], 300, 'should stay capped at 5m');
    assert.equal(entry.heartbeatFailures, 5);
    assert.equal(entry.pending.length, 6);
    // 正常判定（哪怕判的是"不插话"）就清零并立刻恢复。
    llm.fail = false;
    entry.heartbeatRetryAt = 0;
    await runHeartbeat(r.ctx, r.config, r.registry, r.state, null, r.stats);
    assert.equal(entry.heartbeatFailures, 0);
    assert.equal(entry.heartbeatRetryAt, 0);
    assert.equal(r.stats.heartbeatDeclined, 1);
    assert.equal(entry.pending.length, 0);
  });

  await test('heartbeat backoff survives a registry reload instead of restarting from zero', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-aux-store-'));
    const store = new Store(path.join(temp, 'aux.sqlite3'));
    try {
      const r = rig({ ...settings }, '', store, silent());
      rigs.push(r);
      await feed(r, 6);
      const entry = r.registry.entry('group:10');
      assert.equal(entry.heartbeatFailures, 1);
      const restored = new __test.ConversationRegistry(r.ctx, r.config, store).entry('group:10');
      assert.equal(restored.heartbeatFailures, 1);
      assert.ok(restored.heartbeatRetryAt > Date.now());
    } finally {
      store.db.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  await test('memory extraction failure is attributed and backs off instead of retrying every 30s', async () => {
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0 }, '[SKIP]', null, silent());
    rigs.push(r);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'backoff-' + counter++) });
    const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
    extractor.observe('group:10', source());
    const entry = extractor.entries.get('group:10');
    await extractor.flush(null, { force: true });
    assert.equal(r.stats.memoryExtractFailed, 1);
    assert.equal(r.stats.lastMemoryExtractFailure.cause, 'empty-output');
    assert.match(r.stats.lastMemoryExtractFailure.detail, /收到 0 段正文/);
    assert.equal(entry.failures, 1);
    assert.equal(entry.pending.length, 1);
    const wait = entry.nextRunAt - Date.now();
    assert.ok(wait > 25000 && wait <= 30000, 'first memory retry should be ~30s, got ' + wait);
    // 退避期内再来一次 flush（不带 force）不应该再打模型。
    const before = r.stats.memoryExtractFailed;
    await extractor.flush(null);
    assert.equal(r.stats.memoryExtractFailed, before);
    assert.equal(entry.failures, 1);
  });

  await test('memory ladder advances per conversation and does not drop the batch early', async () => {
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0 }, '[SKIP]', null, silent());
    rigs.push(r);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'ladder-' + counter++) });
    const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
    extractor.observe('group:10', source());
    extractor.observe('group:11', source('2', '我喜欢下雨'));
    const waits = [];
    for (let i = 0; i < 4; i++) {
      for (const entry of extractor.entries.values()) entry.nextRunAt = 0;
      await extractor.flush(null);
      const entry = extractor.entries.get('group:10');
      waits.push(Math.round((entry.nextRunAt - Date.now()) / 1000));
    }
    assert.deepEqual(waits, [30, 60, 120, 300]);
    // 两个会话各自计：group:11 也失败了 4 次，各自的批次都还在。
    assert.equal(extractor.entries.get('group:11').failures, 4);
    assert.equal(extractor.entries.get('group:10').pending.length, 1);
    assert.equal(r.stats.memoryExtractFailed, 8);
  });

  await test('memory batch is abandoned after the failure cap and the counters say so', async () => {
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0 }, '[SKIP]', null, silent());
    rigs.push(r);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'drop-' + counter++) });
    const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
    extractor.observe('group:10', source());
    const entry = extractor.entries.get('group:10');
    for (let i = 0; i < MEMORY_MAX_FAILURES; i++) {
      entry.nextRunAt = 0;
      await extractor.flush(null);
    }
    assert.equal(r.stats.memoryExtractFailed, MEMORY_MAX_FAILURES);
    // 到上限就放弃这一批：不再无限重试同一批原文。
    assert.equal(entry.pending.length, 0);
    assert.equal(entry.failures, 0);
    assert.equal(entry.nextRunAt, 0);
    assert.equal(r.stats.memoryBatchAbandoned, 1);
    assert.equal(r.stats.memoryMessagesAbandoned, 1);
    assert.ok(r.warnings.some((m) => /连续失败 5 次，丢弃/.test(m)));
  });

  await test('memory backoff and batch state survive an extractor reload', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-aux-memstore-'));
    const store = new Store(path.join(temp, 'mem.sqlite3'));
    try {
      const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0, persistenceEnabled: true }, '[SKIP]', store, silent());
      rigs.push(r);
      const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'persist-' + counter++) });
      const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats, store);
      extractor.observe('group:10', source());
      await extractor.flush(null, { force: true });
      const before = extractor.entries.get('group:10');
      assert.equal(before.failures, 1);
      const restored = new MemoryExtractor(r.ctx, r.config, memory, r.stats, store).entries.get('group:10');
      assert.equal(restored.failures, 1);
      assert.equal(restored.pending.length, 1);
      assert.ok(restored.nextRunAt > Date.now());
    } finally {
      store.db.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  await test('memory success clears the ladder', async () => {
    const llm = { ok: false, async *stream() {
      if (!llm.ok) return;
      yield { type: 'text-delta', text: JSON.stringify({ memories: [] }) };
    } };
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0 }, '[SKIP]', null, llm);
    rigs.push(r);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'clear-' + counter++) });
    const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
    extractor.observe('group:10', source());
    const entry = extractor.entries.get('group:10');
    entry.nextRunAt = 0;
    await extractor.flush(null);
    assert.equal(entry.failures, 1);
    llm.ok = true;
    entry.nextRunAt = 0;
    await extractor.flush(null);
    assert.equal(r.stats.memoryExtractChecks, 1);
    assert.equal(entry.failures, 0);
    assert.equal(entry.nextRunAt, 0);
    assert.equal(entry.pending.length, 0);
  });

  await test('reply decision reports why it gave up instead of only counting', async () => {
    const r = make({ replyDecisionEnabled: true }, silent());
    const entry = r.registry.entry('group:10');
    const verdict = await decideReply(r.ctx, r.config, entry, [message(1, '废鱼')]);
    assert.equal(verdict.reply, null);
    assert.equal(verdict.cause, 'empty-output');
    assert.match(verdict.detail, /收到 0 段正文/);
    // 参与决策失败一律 fail-open，并且把原因留在 stats 上。
    const attention = await evaluateAttention(r.ctx, r.config, entry, message(2, '废鱼'), r.stats, r.state.controller.signal);
    assert.equal(attention.speak, true);
    assert.equal(r.stats.replyDecisionFailed, 1);
    assert.equal(r.stats.lastReplyDecisionFailure.cause, 'empty-output');
    // 思考吃满预算也要能被认出来。
    const thinkingRig = make({ replyDecisionEnabled: true }, thinking());
    const thinkingVerdict = await decideReply(thinkingRig.ctx, thinkingRig.config,
      thinkingRig.registry.entry('group:10'), [message(1, '废鱼')]);
    assert.equal(thinkingVerdict.cause, 'empty-output');
    assert.match(thinkingVerdict.detail, /reasoning 1 段/);
  });

  await test('aux health groups by call site and flags degradation under 80%', () => {
    resetAuxHealth();
    // 样本不足时不报警：一两次失败喊"降级"只会变成噪音。
    recordAuxCall('heartbeat', { ok: false, cause: 'empty-output', durationMs: 10, detail: 'x' });
    assert.equal(auxHealthSnapshot().degraded, false);
    assert.equal(auxHealthSnapshot().successRate, 0);
    recordAuxCall('heartbeat', { ok: false, cause: 'empty-output', durationMs: 10 });
    recordAuxCall('heartbeat', { ok: false, cause: 'empty-output', durationMs: 10 });
    recordAuxCall('routing', { ok: true, durationMs: 10 });
    recordAuxCall('routing', { ok: true, durationMs: 10 });
    recordAuxCall('routing', { ok: true, durationMs: 10 });
    recordAuxCall('routing', { ok: false, cause: 'timeout', durationMs: 10 });
    const health = auxHealthSnapshot();
    assert.equal(health.basis, 'recent-window');
    assert.equal(health.calls, 7);
    assert.equal(health.ok, 3);
    assert.equal(health.failed, 4);
    assert.equal(health.empty, 3);
    assert.equal(health.successRate, 0.429);
    assert.equal(health.degraded, true);
    const heartbeat = health.labels.find((g) => g.label === 'heartbeat');
    assert.equal(heartbeat.name, '心跳插话');
    assert.equal(heartbeat.calls, 3);
    assert.equal(heartbeat.empty, 3);
    assert.equal(heartbeat.successRate, 0);
    assert.equal(heartbeat.lastCause, 'empty-output');
    const routing = health.labels.find((g) => g.label === 'routing');
    assert.equal(routing.calls, 4);
    assert.equal(routing.successRate, 0.75);
    // 健康度只是内存读数，不写库；重载后从零累计。
    resetAuxHealth();
    assert.equal(auxHealthSnapshot().calls, 0);
    assert.equal(auxHealthSnapshot().degraded, false);
  });

  await test('probe 把思考字数带进健康度：关了思考仍出现分片时能被看见', () => {
    resetAuxHealth();
    const probe = new AuxProbe('routing');
    probe.observe({ type: 'reasoning-delta', text: '想了十二个字' });
    probe.observe({ type: 'text-delta', text: '{"action":"new"}' });
    recordAuxCall('routing', { ok: true, durationMs: 1200, probe, textChars: 17 });
    recordAuxCall('routing', { ok: true, durationMs: 900 });
    const health = auxHealthSnapshot();
    assert.equal(health.calls, 2);
    assert.equal(health.thinkingCalls, 1, '只有看到 reasoning-delta 的那次算"有思考"');
    assert.equal(health.reasoningChars, 6);
    const routing = health.labels.find((g) => g.label === 'routing');
    assert.equal(routing.thinkingCalls, 1);
    assert.equal(routing.reasoningChars, 6);
    assert.equal(routing.avgReasoningChars, 6);
  });

  await test('status exposes auxHealth with per-call-site counts', async () => {
    resetAuxHealth();
    recordAuxCall('memory', { ok: false, cause: 'empty-output', durationMs: 500, detail: '收到 0 段正文' });
    recordAuxCall('memory', { ok: true, durationMs: 500 });
    const r = make();
    const { statusSnapshot } = await import('../lib/routes/status.mjs');
    const snapshot = statusSnapshot(r.config, r.registry, r.state, r.stats);
    assert.equal(snapshot.auxHealth.calls, 2);
    assert.equal(snapshot.auxHealth.empty, 1);
    assert.equal(snapshot.auxHealth.labels.find((g) => g.label === 'memory').calls, 2);
    assert.match(snapshot.auxBackoff.heartbeat.ladder, /30s/);
    assert.equal(snapshot.auxBackoff.memory.maxFailures, MEMORY_MAX_FAILURES);
    assert.equal(snapshot.replyPolicy.participation.lastFailure, null);
  });

  await test('debug status puts the degradation warning on the first line', async () => {
    resetAuxHealth();
    for (let i = 0; i < 4; i++) recordAuxCall('routing', { ok: false, cause: 'empty-output', durationMs: 4000 });
    recordAuxCall('routing', { ok: true, durationMs: 4000 });
    const { debugSnapshot, renderDebugStatus } = await import('../lib/application/debug-status.mjs');
    const r = make({ replyDecisionEnabled: false });
    const report = debugSnapshot(r.config, r.registry, r.state, r.stats, null, null, { now: Date.now() });
    assert.equal(report.auxHealth.degraded, true);
    const text = renderDebugStatus(report, { section: 'status' });
    // 告警必须是标题之后的第一块（顶部显著位置）。
    const blocks = text.split('\n\n');
    assert.match(blocks[0], /【QQ 桥接】/);
    assert.match(blocks[1], /^⚠️ 辅助判断层降级中：成功率 20%/);
    assert.match(blocks[1], /语义路由正在走 fallback/);
    // 分项计数在 aux 段（`#debug status aux`）与 detail 模式下出现。
    assert.match(renderDebugStatus(report, { section: 'aux' }), /【辅助判断层】最近 15 分钟/);
    assert.match(renderDebugStatus(report, { section: 'aux' }),
      /语义路由\(routing\) 5 次 · 失败 4 · 空输出 4 · 20%/);
    assert.match(renderDebugStatus(report, { section: 'status', detail: true }), /【辅助判断层】/);
    // 成功率达标时不该有这行。
    resetAuxHealth();
    for (let i = 0; i < 4; i++) recordAuxCall('routing', { ok: true, durationMs: 100 });
    const healthy = debugSnapshot(r.config, r.registry, r.state, r.stats, null, null, { now: Date.now() });
    assert.equal(healthy.auxHealth.degraded, false);
    assert.doesNotMatch(renderDebugStatus(healthy, { section: 'status' }), /辅助判断层降级中/);
  });
} finally {
  for (const r of rigs) r.state.persistEnabled(false);
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
