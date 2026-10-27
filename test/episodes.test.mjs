import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { EpisodeLedger } from '../lib/memory/episodes.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { executeTurn } from '../lib/application/execute-turn.mjs';
import { publishTurnSession, stampTurnSession, turnSession, turnSessionRow, claimTurnDelivery, releaseTurnClaim } from '../lib/agent/execution-scope.mjs';
import { installTurnScopeHooks } from '../lib/application/turn-scope.mjs';
import { buildMemorySection } from '../lib/prompt/render.mjs';
import { config, rig, message } from './helpers/bridge.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-episodes-'));
const realFetch = globalThis.fetch;
const stores = [];
let passed = 0, failed = 0, n = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function setup() {
  const store = new Store(path.join(root, String(n++), 'bridge.sqlite3')); stores.push(store);
  const ledger = new EpisodeLedger(store);
  const source = (qq = '200', conversation = 'user:200', text = '请给用户201发消息约周三见面', id = '1') =>
    ledger.origin(conversation, { qq, who: '甲' + qq, text, messageId: id });
  return { store, ledger, source };
}
const recall = (ledger, qq = '201', extra = {}) => ledger.recall({ conversation: 'user:' + qq, qq, ...extra });
try {
  await test('recipient and requester recall a durable attributed send after reload', async () => {
    const { store, ledger, source } = setup();
    ledger.action({ id: 'sent', sourceRef: source(), conversation: 'user:201', text: '周三见', state: 'SUCCEEDED', onebotId: '7' });
    const loaded = new EpisodeLedger(store);
    assert.match(recall(loaded), /甲200.*QQ 200.*user:201 已发送.*周三见.*回执 7/);
    assert.doesNotMatch(recall(loaded), /请给用户201发消息/);
    assert.match(recall(loaded, '200'), /起因消息 1：请给用户201发消息/);
    assert.equal(recall(loaded, '999'), '');
  });
  await test('parallel sources ignore the shared active conversation singleton', async () => {
    const { store, ledger, source } = setup();
    const a = source(), b = source('300', 'group:10', '请给201发另一件事', '2');
    store.setState('bridge:active-conversation', JSON.stringify({ key: 'group:99' }));
    ledger.action({ id: 'a', sourceRef: a, conversation: 'user:201', text: '甲的事', state: 'SUCCEEDED' });
    ledger.action({ id: 'b', sourceRef: b, conversation: 'user:201', text: '乙的事', state: 'SUCCEEDED' });
    const rows = store.db.prepare('SELECT qq, conversation FROM memory_episodes ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.qq, r.conversation]), [['200', 'user:200'], ['300', 'group:10']]);
  });
  await test('failure, in-flight and UNKNOWN never become completion, success cannot regress', async () => {
    const { ledger, source } = setup(), ref = source();
    for (const state of ['EXECUTING', 'FAILED', 'UNKNOWN']) ledger.action({ id: state, sourceRef: ref,
      conversation: 'user:201', text: state, state });
    const text = recall(ledger);
    assert.match(text, /尚无成功回执/); assert.match(text, /发送失败/); assert.match(text, /不可认定完成/);
    assert.doesNotMatch(text, /已发送：/);
    ledger.action({ id: 'done', sourceRef: ref, conversation: 'user:201', text: 'done', state: 'SUCCEEDED' });
    assert.equal(ledger.action({ id: 'done', sourceRef: ref, conversation: 'user:201', state: 'UNKNOWN' }), false);
  });
  await test('receipt dedupe enriches an MCP record without inventing another send', async () => {
    const { ledger, source, store } = setup();
    ledger.action({ id: 'mcp', conversation: 'user:201', text: '周三见', state: 'SUCCEEDED', onebotId: '77' });
    ledger.action({ id: 'dsh', sourceRef: source(), conversation: 'user:201', text: '周三见', state: 'SUCCEEDED', onebotId: '77' });
    assert.equal(ledger.snapshot().records, 1);
    assert.equal(store.db.prepare('SELECT qq FROM memory_episodes').get().qq, '200');
  });
  await test('unrelated private experiences stay out of groups, direct group sends are recalled', async () => {
    const { ledger, source } = setup();
    ledger.action({ id: 'secret', sourceRef: source(), conversation: 'user:201', text: '私密内容', state: 'SUCCEEDED' });
    assert.equal(ledger.recall({ conversation: 'group:10', qq: '200' }), '');
    ledger.action({ id: 'public', sourceRef: source(), conversation: 'group:10', text: '公开转告', state: 'SUCCEEDED' });
    const text = ledger.recall({ conversation: 'group:10', qq: '201' });
    assert.match(text, /公开转告/); assert.doesNotMatch(text, /私密内容|请给用户/);
  });
  await test('withdrawn source and withdrawn outgoing receipt cannot reappear on reload', async () => {
    const { ledger, source, store } = setup(), ref = source();
    ledger.action({ id: 'a', sourceRef: ref, conversation: 'user:201', text: '周三见', state: 'SUCCEEDED', onebotId: '7' });
    ledger.retract('user:200', '1');
    assert.equal(ledger.resolve(ref), null); assert.equal(recall(new EpisodeLedger(store)), '');
    ledger.action({ id: 'b', sourceRef: source('200', 'user:200', '新请求', '2'), conversation: 'user:201', text: '再见', state: 'SUCCEEDED', onebotId: '8' });
    ledger.retract('user:201', '8'); assert.equal(recall(ledger), '');
  });
  await test('expired refs cannot bind new tool calls but remain valid historical evidence', async () => {
    const { ledger, source, store } = setup(), ref = source();
    ledger.action({ id: 'a', sourceRef: ref, conversation: 'user:201', text: '周三见', state: 'SUCCEEDED' });
    store.db.prepare('UPDATE memory_origins SET expires_at=0 WHERE ref=?').run(ref);
    assert.equal(ledger.resolve(ref), null); assert.ok(ledger.resolve(ref, { active: false }));
    source(); assert.match(recall(ledger, '200'), /起因消息/);
  });
  await test('hard budgets, changed admission and duplicate-window suppression bound prompt costs', async () => {
    const { ledger, source } = setup();
    for (let i = 0; i < 20; i++) ledger.action({ id: String(i), sourceRef: source('200', 'group:10'),
      conversation: 'group:10', text: '约定'.repeat(300), state: 'SUCCEEDED', onebotId: String(i) });
    const args = { conversation: 'group:10', qq: '200' };
    const text = ledger.recall(args); assert.ok(text.length <= 900);
    assert.ok(text.split('\n').filter((l) => l.startsWith('- ')).length <= 4);
    assert.equal(ledger.recall({ ...args, limit: 0 }), '');
    assert.equal(ledger.recall({ ...args, maxChars: 20 }), '');
    assert.equal(ledger.recall({ ...args, allowed: () => false }), '');
    assert.equal(ledger.recall({ ...args, windowIds: Array.from({ length: 20 }, (_, i) => String(i)) }), '');
  });
  await test('existing extractor batch stores a sourced episode without an extra model request', async () => {
    const { store, ledger } = setup();
    let calls = 0;
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractIntervalMs: 0 }, '[SKIP]', store, { async *stream() {
      calls++; yield { type: 'text-delta', text: JSON.stringify({ memories: [{ scope: 'episode', sourceMessageId: '1',
        key: 'commitment.meeting', fact: '甲200请我帮忙约周三见面，未确认完成', evidence: '帮忙约周三见面' }] }) };
    } });
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'memory') }, store);
    const extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats, store);
    extractor.observe('user:200', { qq: '200', who: '甲200', messageId: '1', text: '请帮忙约周三见面' });
    await extractor.flush(null, { force: true }); extractor.dispose();
    assert.equal(calls, 1); assert.match(recall(ledger, '200'), /未确认完成/);
    assert.match(buildMemorySection(r.config, { ...message(2), message_type: 'private' }, {}, memory), /你的相关经历/);
    r.sendQueue.dispose();
  });
  await test('cross-target DSH tool result associates requester before final SKIP', async () => {
    const { store, ledger } = setup();
    const r = rig({ memoryEnabled: true }, '[SKIP]', store);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'cross') }, store);
    let boundDuringTurn = 0;
    const liveBindings = () => Number(store.db.prepare(
      "SELECT COUNT(*) AS n FROM runtime_state WHERE key LIKE 'qq-bridge:turn-session:%' AND value NOT IN ('null','')").get().n);
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      boundDuringTurn = liveBindings();
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
      yield { type: 'event', event: { seq: 2, type: 'tool/call', data: { turn: 1, callId: 'c', name: 'qq_send_private_msg', arguments: JSON.stringify({ user_id: 201, message: '周三见' }) } } };
      yield { type: 'event', event: { seq: 3, type: 'tool/result', data: { callId: 'c', message: { content: [{ type: 'text', text: '已发送到QQ 201。message_id=77' }] } } } };
      yield { type: 'event', event: { seq: 4, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '[SKIP]' }] } } } };
      yield { type: 'event', event: { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
    } });
    await executeTurn(r.ctx, r.config, r.registry, r.state, memory, r.stats, store, 'group:10', message(1, 'deepseek 请转告201周三见'));
    assert.equal(boundDuringTurn, 1, '回合内必须发布 Session→来源绑定，供宿主注入工具');
    assert.equal(liveBindings(), 0, '回合结束后必须撤掉绑定，不能让迟到调用冒用旧归属');
    assert.match(recall(ledger), /QQ 200.*user:201 已发送.*周三见/);
    assert.equal(r.registry.entry('group:10').window.some((m) => m.bot), false);
    assert.match(r.prompts[0].content[0].text, /当前会话 group:10/); r.sendQueue.dispose();
  });
  await test('桥接超时收工不撤归属：回合还在跑时工具必须继续可用，turn/end 才收尾', async () => {
    const { store } = setup();
    const r = rig({ memoryEnabled: true, replyTimeoutMs: 80 }, '[SKIP]', store);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, 'timeout-keep') }, store);
    const sessionId = await r.registry.ensureSession('group:10');
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
      // 模型还在思考：流不再吐帧。桥接的 replyTimeoutMs（这里是 80ms）会先到，
      // 但 DSH 那边的 turn 还开着 —— 这正是"想久了就不能用工具"的事故形状。
      await new Promise(() => {});
    } });
    const live = () => turnSessionRow(store, sessionId);
    // AbortSignal.timeout 的定时器是 unref 的：测试里没有别的句柄，进程会在超时前退出。
    const alive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(executeTurn(r.ctx, r.config, r.registry, r.state, memory, r.stats, store,
        'group:10', message(1, 'deepseek 写个六博棋网页')));
    } finally { clearTimeout(alive); }
    assert.ok(live(), '回合没结束，归属不能跟着桥接超时被撤掉');
    const hooks = {};
    installTurnScopeHooks({ logger: { info() {} }, on: (type, fn) => { hooks[type] = fn; } }, { store, config: r.config });
    hooks['session/event']({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } });
    assert.ok(live(), '回合开始的帧不该撤归属');
    hooks['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(live(), null, 'turn/end 才是撤归属的边界');
    r.sendQueue.dispose();
  });
  await test('归属只认本轮 turn/end，且长回合按模型步骤续租两道闸', async () => {
    const { store, ledger } = setup();
    const r = rig({ memoryEnabled: true }, '[SKIP]', store);
    const hooks = {};
    installTurnScopeHooks({ logger: { info() {} }, on: (type, fn) => { hooks[type] = fn; } }, { store, config: r.config });
    const sessionId = 'session-keep';
    const ref = ledger.origin('group:10', { qq: '200', who: '甲200', text: '写个六博棋网页', messageId: '9' }, 1000);
    publishTurnSession(store, sessionId, { conversation: 'group:10', sourceRef: ref, expiresAt: Date.now() + 1000 });
    stampTurnSession(store, sessionId, 5);
    hooks['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 6 } });
    assert.ok(turnSessionRow(store, sessionId), '别的回合结束不该撤我的归属');
    await hooks['agent/pre-step']({ agent: { session: { id: sessionId } } }, async () => {});
    const row = turnSessionRow(store, sessionId);
    const origin = store.db.prepare('SELECT expires_at FROM memory_origins WHERE ref=?').get(ref);
    assert.ok(row.expiresAt > Date.now() + 60000, '模型每走一步就续租，长回合不该中途过期');
    assert.ok(origin.expires_at > Date.now() + 60000, 'MCP 第一道闸（memory_origins）必须一起续');
    hooks['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 5 } });
    assert.equal(turnSession(store, sessionId), null, '我这轮结束，归属撤掉');
  });
  await test('同一条 turn/end 只让一条回复行投递正文（并入别人的 turn 时不能各发一份）', async () => {
    const { store } = setup();
    // 同一条回合、同一条回复行重试：放行。
    assert.equal(claimTurnDelivery(store, 'session-x', 7, 'request-a'), true);
    assert.equal(claimTurnDelivery(store, 'session-x', 7, 'request-a'), true, '同一个请求重试不算重复投递');
    // 同一条回合、另一条回复行：挡住。
    assert.equal(claimTurnDelivery(store, 'session-x', 7, 'request-b'), false, '正文已经被别人投过了');
    // 换了一条回合：照常放行。
    assert.equal(claimTurnDelivery(store, 'session-x', 8, 'request-b'), true);
    // 认不出回合号的（老形状）一律放行，别拿它当拦截理由。
    assert.equal(claimTurnDelivery(store, 'session-x', null, 'request-c'), true);
    assert.equal(claimTurnDelivery(store, null, 7, 'request-c'), true);
    // 认领了却没真发出去：退掉，别把另一条回复行挡在门外。
    assert.equal(claimTurnDelivery(store, 'session-x', 9, 'request-a'), true);
    releaseTurnClaim(store, 'session-x', 9, 'request-b');
    assert.equal(claimTurnDelivery(store, 'session-x', 9, 'request-b'), false, '不是自己认领的不许退');
    releaseTurnClaim(store, 'session-x', 9, 'request-a');
    assert.equal(claimTurnDelivery(store, 'session-x', 9, 'request-b'), true, '空认领退掉后要让给另一条');
  });
  await test('no database and explicit disable degrade to existing person memory', async () => {
    assert.equal(new EpisodeLedger(null).available, false);
    const cfg = config({ memoryEnabled: true, episodicMemoryEnabled: false, memoryDir: path.join(root, 'disabled') });
    const memory = new MemoryStore({ logger: { warn() {} } }, cfg, setup().store);
    assert.equal(memory.episodes, null); assert.equal(memory.recallEpisodes(message(1)), '');
  });
} finally {
  globalThis.fetch = realFetch;
  for (const store of stores) store.db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
