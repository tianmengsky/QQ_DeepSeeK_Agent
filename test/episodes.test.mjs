import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { EpisodeLedger } from '../lib/memory/episodes.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { executeTurn } from '../lib/application/execute-turn.mjs';
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
    const r = rig({ memoryEnabled: true, memoryExtractIntervalMs: 0 }, '[SKIP]', store, { async *stream() {
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
    assert.match(r.prompts[0].content[0].text, /【当前会话】group:10/); r.sendQueue.dispose();
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
