import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { Store } from '../lib/store.mjs';
import { TaskLedger } from '../lib/conversation/task-ledger.mjs';
import { TaskProgress, isProgressQuestion } from '../lib/application/task-progress.mjs';
import { replyJournal } from '../lib/delivery/reply-journal.mjs';
import { recoverReplies } from '../lib/application/reply-recovery.mjs';
import { captureFloor, observeFloor } from '../lib/conversation/floor.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { FactStore } from '../lib/memory/facts.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { statusSnapshot } from '../lib/routes/status.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-task-progress-'));
const stores = [], rigs = [], realFetch = globalThis.fetch;
let passed = 0, failed = 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function until(predicate, ms = 1500) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > ms) throw new Error('condition timeout'); await pause(5); }
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error.stack); }
}
function make(llm = null, over = {}) {
  const store = new Store(path.join(root, `${stores.length}.sqlite3`)); stores.push(store);
  const r = rig({ groupTrigger: 'all', selfIds: ['100'], floorManagementEnabled: true,
    taskLedgerEnabled: true, taskProgressEnabled: true, sendQuotaPerMinute: 100,
    sendQuotaPerHour: 1000, ...over }, '[SKIP]', store, llm);
  rigs.push(r); r.store = store; r.state.replyJournal ??= replyJournal(store); return r;
}
function running(r, id = 'long', key = 'group:10', owner = 200) {
  const e = message(id, '帮我写一个程序', Number(key.slice(6)), owner);
  const meta = { event: e, speakerQq: String(owner), speakerName: '甲', turnId: id,
    sessionId: 'long-session', requestId: 'rpc-long', sourceRef: 'source-long',
    floorPolicy: { originals: [e] }, inputIds: [`100:${id}`] };
  r.state.replyJournal.begin(id, key, meta);
  r.state.replyJournal.active.add(id);
  r.state.taskLedger.begin(id, key, meta);
  r.state.taskLedger.set(id, 'running', { turn: 1 });
  return e;
}
const query = (id = 'query', user = 300) => message(id, '那个程序怎么样了？', 10, user);
const jsonModel = (value) => ({ async *stream() { yield { type: 'text-delta', text: JSON.stringify(value) }; } });
const answer = { action: 'reply', taskId: 'long', text: '还在处理，当前还没有最终结果。' };

try {
  await test('only narrow pure progress questions enter the fast lane', async () => {
    for (const text of ['那个程序怎么样了？', '做完了吗', '进度如何？', '文件弄好了没'])
      assert.equal(isProgressQuestion(message(1, text)), true, text);
    for (const text of ['帮我写一个程序', '做完了吗，顺便帮我生成PDF', '改成红色，做好了吗', '快点整理', '取消这个任务'])
      assert.equal(isProgressQuestion(message(1, text)), false, text);
    const image = query(); image.message.push({ type: 'image', data: { file: 'test' } });
    assert.equal(isProgressQuestion(image), false);
  });
  await test('progress answers are delivered while an ordinary conversation turn is blocked', async () => {
    const r = make(jsonModel(answer)); running(r);
    const gate = deferred(); const blocked = r.registry.run('group:10', () => gate.promise);
    try {
      await r.handler(request(query()), response());
      await until(() => r.stats.taskProgressReplies === 1);
      await r.sendQueue.flush();
      assert.equal(r.prompts.length, 0, 'query does not submit to DSH');
      assert.equal(r.calls.filter((c) => c.action === 'send_group_msg').length, 1);
      assert.equal(r.state.replyJournal.get('long').state, 'following');
      assert.equal(r.state.replyJournal.get('progress:group:10:100:query').state, 'done');
      assert.ok(r.registry.entry('group:10').awakeUntil > Date.now());
    } finally { gate.resolve(); await blocked; }
  });
  await test('a same-author progress-shaped fragment stays with an unclaimed input batch', async () => {
    const r = make(jsonModel(answer), { inputDebounceMs: 80, inputShortDebounceMs: 120, inputMaxWaitMs: 300 });
    running(r);
    const first = message('first', '帮我写一个白色的小程序', 10, 200);
    const fragment = message('fragment', '那个程序怎么样了？', 10, 200);
    await r.handler(request(first), response());
    await r.handler(request(fragment), response());
    assert.equal(r.stats.taskProgressAccepted ?? 0, 0);
    assert.equal(r.stats.taskProgressBuffered, 1);
    assert.deepEqual(r.state.inputBatches.entry('group:10').events.map((e) => e.message_id), ['first', 'fragment']);
    await until(() => r.prompts.length === 1, 1200);
    const prompt = r.prompts[0].content[0].text;
    assert.match(prompt, /帮我写一个白色的小程序/);
    assert.match(prompt, /那个程序怎么样了/);
    await r.handler(request(query('observer',300)),response());
    await until(()=>r.stats.taskProgressReplies===1);
    assert.equal(r.stats.taskProgressAccepted,1);
  });
  await test('progress is recorded only from a fresh successful receipt with its original time', async () => {
    const r = make(); running(r);
    for (const extra of [{ state: 'UNKNOWN' }, { state: 'FAILED' }, { dryRun: true }, { replayed: true }])
      r.state.taskLedger.progress('long', { conversation: 'group:10', text: '准备好了' },
        { state: 'SUCCEEDED', sentAt: 1234, ...extra });
    assert.equal(r.state.taskLedger.get('long').progress, '');
    r.state.taskLedger.progress('long', { conversation: 'group:11', text: '跨群' }, { state: 'SUCCEEDED', sentAt: 1234 });
    assert.equal(r.state.taskLedger.get('long').progress, '');
    r.state.taskLedger.progress('long', { conversation: 'group:10', text: '第一阶段' }, { state: 'SUCCEEDED', sentAt: 1234 });
    r.state.taskLedger.progress('long', { conversation: 'group:10', text: '旧进度' }, { state: 'SUCCEEDED', sentAt: 1200 });
    const restored = new TaskLedger(r.store).get('long');
    assert.equal(restored.progress_at, 1234); assert.equal(restored.progress, '第一阶段');
  });
  await test('ledger separates model completion, WAIT, failure and delivery certainty', async () => {
    const r = make(); running(r);
    r.state.taskLedger.outcome('long', { reply: '[WAIT]', endReason: 'completed' });
    assert.equal(r.state.taskLedger.get('long').state, 'waiting_input');
    r.state.taskLedger.outcome('long', { reply: '稍后整理', endReason: 'completed' });
    const fact = r.state.taskLedger.facts('group:10', r.state.replyJournal)[0];
    assert.equal(fact.state, 'model_finished'); assert.equal(fact.resultReady, false);
    assert.equal(fact.deliveryState, 'following');
    r.state.taskLedger.outcome('long', { reply: '', endReason: 'error', failure: { message: 'failed' } });
    assert.equal(r.state.taskLedger.get('long').state, 'failed');
  });
  await test('compact prompt preserves task ownership, receipt time and delivery uncertainty without changing recovery facts', () => {
    const r = make(); running(r);
    r.state.taskLedger.progress('long', { conversation: 'group:10', text: '准备整理' },
      { state: 'SUCCEEDED', sentAt: 1234 });
    r.state.taskLedger.set('long', 'recovering');
    const before = r.state.taskLedger.facts('group:10', r.state.replyJournal);
    const context = r.state.taskLedger.context('group:10', r.state.replyJournal);
    const rows = context.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => ({ owner: row.owner, title: row.title, state: row.state,
      progress: row.progress, progressAt: row.progressAt, resultReady: row.resultReady, deliveryState: row.deliveryState })),
    before.map((row) => ({ owner: row.owner, title: row.title, state: row.state,
      progress: row.progress, progressAt: row.progressAt, resultReady: row.resultReady, deliveryState: row.deliveryState })));
    assert.match(context, /不能说仍在做/);
    assert.match(context, /不是完成证据/);
    assert.match(context, /不授权重做/);
    assert.deepEqual(r.state.taskLedger.facts('group:10', r.state.replyJournal), before);
    assert.equal(r.state.taskLedger.get('long').meta.sessionId, 'long-session');
  });
  await test('restored following turns are recovering until ownership is confirmed', async () => {
    const r = make(); running(r); r.state.replyJournal.active.delete('long');
    const ledger = new TaskLedger(r.store); ledger.reconcile(r.state.replyJournal);
    assert.equal(ledger.get('long').state, 'recovering');
    r.state.replyJournal.active.add('long'); ledger.reconcile(r.state.replyJournal);
    assert.equal(ledger.get('long').state, 'recovering');
  });
  await test('receipt uncertainty without output never claims that a task is still running', async () => {
    const r = make(); running(r);
    r.state.replyJournal.error('long', 'lost', { attention: true });
    r.state.taskLedger.reconcile(r.state.replyJournal);
    assert.equal(r.state.taskLedger.get('long').state, 'needs_attention');
  });
  await test('cross-conversation IDs and malformed model replies fall back without side effects', async () => {
    for (const value of [{ ...answer, taskId: 'other-group' }, { ...answer, text: '[表情:1]' }, { action: 'oops' }]) {
      const r = make(jsonModel(value)); running(r);
      const fallbacks = []; r.state.taskProgress.fallback = (key, event) => fallbacks.push([key, event.message_id]);
      assert.equal(r.state.taskProgress.accept('group:10', query()), true);
      await until(() => fallbacks.length === 1);
      assert.equal(r.calls.length, 0); assert.equal(r.prompts.length, 0);
      assert.deepEqual(fallbacks, [['group:10', 'query']]);
    }
  });
  await test('semantic fallback keeps mixed or unrelated input on the ordinary path', async () => {
    const r = make(jsonModel({ action: 'fallback' })); running(r);
    let count = 0; r.state.taskProgress.fallback = () => count++;
    r.state.taskProgress.accept('group:10', query()); await until(() => count === 1);
    assert.equal(r.calls.length, 0);
  });
  await test('changed task facts invalidate an answer generated against a stale snapshot', async () => {
    const gate = deferred(); let started = false;
    const llm = { async *stream() { started = true; await gate.promise; yield { type: 'text-delta', text: JSON.stringify(answer) }; } };
    const r = make(llm); running(r); let fallback = 0; r.state.taskProgress.fallback = () => fallback++;
    r.state.taskProgress.accept('group:10', query()); await until(() => started);
    r.state.taskLedger.outcome('long', { reply: '结果', endReason: 'completed' }); gate.resolve();
    await until(() => fallback === 1); assert.equal(r.calls.length, 0);
  });
  await test('disabled, recalled and disallowed messages do not start progress model calls', async () => {
    const r = make(jsonModel(answer)); running(r);
    r.state.enabled = false; assert.equal(r.state.taskProgress.accept('group:10', query()), false);
    r.state.enabled = true; r.registry.entry('group:10').recalledIds.push('query');
    assert.equal(r.state.taskProgress.accept('group:10', query()), false);
    assert.equal(r.state.taskProgress.accept('group:11', message(2, '程序怎么样了', 11)), false);
    const other = query('other'); other.message.unshift({ type: 'at', data: { qq: '400' } });
    assert.equal(r.state.taskProgress.accept('group:10', other), false);
  });
  await test('progress duplicates are durably owned exactly once', async () => {
    const r = make(jsonModel(answer)); running(r); const q = query();
    assert.equal(r.state.taskProgress.accept('group:10', q), true);
    assert.equal(r.state.taskProgress.accept('group:10', q), true);
    await until(() => r.stats.taskProgressReplies === 1); await r.sendQueue.flush();
    assert.equal(r.store.db.prepare('SELECT COUNT(*) n FROM bridge_task_queries').get().n, 1);
    assert.equal(r.calls.filter((c) => c.action === 'send_group_msg').length, 1);
  });
  await test('per-conversation progress calls serialize with a bounded durable overflow', async () => {
    const gate = deferred(); let calls = 0, active = 0, max = 0;
    const llm = { async *stream() { calls++; active++; max = Math.max(max, active); await gate.promise;
      active--; yield { type: 'text-delta', text: JSON.stringify(answer) }; } };
    const r = make(llm, { taskProgressMaxPending: 2 }); running(r);
    assert.equal(r.state.taskProgress.accept('group:10', query('q1')), true);
    assert.equal(r.state.taskProgress.accept('group:10', query('q2')), true);
    assert.equal(r.state.taskProgress.accept('group:10', query('q3')), false);
    await until(() => calls === 1); gate.resolve();
    await until(() => r.stats.taskProgressReplies === 2); assert.equal(max, 1);
  });
  await test('HMR keeps pending queries durable and restores them without a DSH submission', async () => {
    const r = make(jsonModel(answer)); running(r);
    r.state.taskProgress.accept('group:10', query()); r.state.taskProgress.dispose();
    const lane = new TaskProgress({ ctx: r.ctx, config: r.config, registry: r.registry,
      state: r.state, memory: null, stats: r.stats, store: r.store, ledger: r.state.taskLedger,
      sendQueue: r.sendQueue, fallback() { throw new Error('unexpected fallback'); } });
    r.state.taskProgress = lane; lane.restore();
    await until(() => r.stats.taskProgressReplies === 1); await r.sendQueue.flush();
    assert.equal(r.prompts.length, 0); assert.equal(r.calls.length, 1);
  });
  await test('saved progress output recovers ahead of an active following turn', async () => {
    const r = make(); running(r);
    const q = query(), journal = r.state.replyJournal, id = 'saved-query';
    observeFloor(r.config, r.registry, 'group:10', q);
    journal.begin(id, 'group:10', { event: q, lane: 'task-progress', turnId: id, sourceRef: null,
      speakerQq: '300', speakerName: '乙', imageInfo: {}, floorPolicy: captureFloor(r.config, r.registry, 'group:10', [q]) });
    journal.output(id, { reply: '仍在处理。', endReason: 'completed', spokeTexts: [] });
    const gate = deferred(); const blocked = r.registry.run('group:10', () => gate.promise);
    try {
      await Promise.all(await recoverReplies(r.ctx, r.config, r.registry, r.state, null, r.stats, r.store, r.sendQueue));
      await r.sendQueue.flush(); assert.equal(journal.get(id).state, 'done'); assert.equal(r.prompts.length, 0);
    } finally { gate.resolve(); await blocked; }
  });
  await test('quota-deferred send plans retain order even with an earlier model turn running', async () => {
    const r = make(); running(r);
    const j = r.state.replyJournal;
    j.begin('older-plan', 'group:10', { event: query() }); j.output('older-plan', { reply: 'older' });
    j.planned('older-plan', { bubbles: ['older'], idemBase: 'older-plan' });
    j.begin('new-plan', 'group:10', { event: query('q2') }); j.output('new-plan', { reply: 'new' });
    j.planned('new-plan', { bubbles: ['new'], idemBase: 'new-plan' });
    assert.equal(j.deliveryHead('group:10').id, 'older-plan');
  });
  await test('a hung read-only recovery cannot block a new ordinary conversation turn or overwrite its tool scope', async () => {
    const r = make(), gate = deferred(); running(r); r.state.replyJournal.active.delete('long');
    r.store.setState('bridge:active-conversation', 'current-live-tool-scope');
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      await gate.promise;
      yield { type: 'event', event: { seq: 1, type: 'user/message', data: { turn: 1, source: { rpcId: 'rpc-long' } } } };
      yield { type: 'event', event: { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '[SKIP]' }] } } } };
      yield { type: 'event', event: { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } };
    } });
    const jobs = await recoverReplies(r.ctx, r.config, r.registry, r.state, null, r.stats, r.store, r.sendQueue);
    try {
      let fresh = false; await r.registry.run('group:10', () => { fresh = true; });
      assert.equal(fresh, true); assert.equal(r.prompts.length, 0);
      assert.equal(r.store.getState('bridge:active-conversation'), 'current-live-tool-scope');
    } finally { gate.resolve(); await Promise.all(jobs); }
  });
  await test('subscription failures retain following identity and never consume the send failure budget', async () => {
    const r = make(); running(r); r.state.replyJournal.active.delete('long');
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() { throw new Error('history stream unavailable'); } });
    for (let i = 0; i < 4; i++) {
      r.store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run('long');
      await Promise.all(await recoverReplies(r.ctx, r.config, r.registry, r.state, null, r.stats, r.store, r.sendQueue));
    }
    assert.equal(r.state.replyJournal.get('long').state, 'following');
    assert.equal(r.state.replyJournal.get('long').attempts, 0); assert.equal(r.prompts.length, 0);
  });
  await test('task diagnostic snapshots omit message text, progress text and secrets', async () => {
    const r = make(); running(r);
    r.state.taskLedger.progress('long', { conversation: 'group:10', text: 'PRIVATE_PROGRESS' }, { state: 'SUCCEEDED', sentAt: Date.now() });
    const s = statusSnapshot(r.config, r.registry, r.state, r.stats, r.store, r.sendQueue).tasks;
    const text = JSON.stringify(s);
    assert.doesNotMatch(text, /PRIVATE_PROGRESS|帮我写一个程序/);
    assert.equal(s.executionPolicy, 'conversation-serial');
  });
  await test('task progress context stays bounded and never treats model finish as product success', async () => {
    const r = make(); running(r);
    const text = r.state.taskLedger.context('group:10', r.state.replyJournal);
    assert.ok(text.length < 2000); assert.match(text, /不等于作品已验证或已送达/);
  });
  await test('task context selects related active facts instead of repeating the full ledger', async () => {
    const r = make(); running(r, 'mine');
    running(r, 'other', 'group:10', 300);
    running(r, 'stale'); r.state.taskLedger.set('stale','recovering');
    r.store.db.prepare('UPDATE bridge_tasks SET title=? WHERE id=?').run('OTHER-AUTHOR','other');
    r.store.db.prepare('UPDATE bridge_tasks SET title=? WHERE id=?').run('OLD-RECOVERY','stale');
    const before=r.state.taskLedger.facts('group:10',r.state.replyJournal);
    const text = r.state.taskLedger.context('group:10', r.state.replyJournal, { owner: '200' });
    assert.match(text, /帮我写一个程序/);
    assert.doesNotMatch(text, /OTHER-AUTHOR|OLD-RECOVERY/);
    assert.ok(text.length < 1200);
    const quoted=r.state.taskLedger.context('group:10',r.state.replyJournal,{owner:'200',replyIds:['other','stale']});
    assert.match(quoted,/OTHER-AUTHOR/);assert.match(quoted,/OLD-RECOVERY/);
    assert.match(quoted,/不能说仍在做/);
    assert.deepEqual(r.state.taskLedger.facts('group:10',r.state.replyJournal),before);
  });
  await test('a provider ignoring abort times out and returns the original query to normal exactly once', async () => {
    const gate = deferred();
    const llm = { async *stream() { await gate.promise; yield { type: 'text-delta', text: JSON.stringify(answer) }; } };
    const r = make(llm, { taskProgressTimeoutMs: 80 }); running(r);
    let fallbacks = 0; r.state.taskProgress.fallback = () => fallbacks++;
    r.state.taskProgress.accept('group:10', query());
    await until(() => fallbacks === 1); gate.resolve(); await pause(20);
    assert.equal(fallbacks, 1); assert.equal(r.calls.length, 0);
  });
  await test('a queued progress answer is discarded and revisited when the original task finishes before sending', async () => {
    const r = make(jsonModel(answer)); running(r);
    r.sendQueue.minIntervalMs = 250;
    r.sendQueue.lastSentAt.set('group:10', Date.now());
    const gate = deferred(); const blocked = r.registry.run('group:10', () => gate.promise);
    try {
      r.state.taskProgress.accept('group:10', query()); await until(() => r.stats.taskProgressReplies === 1);
      r.state.taskLedger.outcome('long', { reply: '模型已结束', endReason: 'completed' });
      await r.sendQueue.flush();
      assert.equal(r.calls.length, 0);
      assert.equal(r.state.replyJournal.get('progress:group:10:100:query').state, 'done');
      assert.ok(r.state.inputBatches.entry('group:10').events.some((e) => e.message_id === 'query'));
      r.state.taskProgress.restore();
      assert.ok(r.state.inputBatches.entry('group:10').events.some((e) => e.message_id === 'query'),
        'query restore must not remove a new revision after the original query was handed off');
    } finally { r.state.inputBatches.dispose(); r.state.enabled = false; gate.resolve(); await blocked; }
  });
  await test('global progress concurrency is bounded across independent conversations', async () => {
    const gate = deferred(); let active = 0, max = 0, started = 0;
    const llm = { async *stream(args) {
      active++; started++; max = Math.max(max, active); await gate.promise;
      const task = JSON.parse(args.messages[0].content[0].text).tasks[0]; active--;
      yield { type: 'text-delta', text: JSON.stringify({ ...answer, taskId: task.id }) };
    } };
    const r = make(llm, { taskProgressConcurrency: 2 });
    for (const group of [10, 11, 12]) {
      running(r, 'long-' + group, 'group:' + group);
      const e = message('q-' + group, '程序怎么样了？', group, 300);
      assert.equal(r.state.taskProgress.accept('group:' + group, e), true);
    }
    await until(() => started === 2); assert.equal(max, 2); gate.resolve();
    await until(() => r.stats.taskProgressReplies === 3); assert.equal(max, 2);
  });
  await test('task state stays submitted until rpcId/inbox ownership confirms its running turn', async () => {
    const r = make(), consumed = deferred(), ended = deferred();
    const frame = (seq, type, data) => ({ type: 'event', event: { seq, type, data } });
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      const source = { rpcId: r.prompts.at(-1).requestId };
      yield frame(1, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ source }] });
      yield frame(2, 'turn/start', { turn: 7 });
      yield frame(3, 'assistant/message', { turn: 7, message: { content: [{ type: 'text', text: '别的回合' }] } });
      await consumed.promise;
      yield frame(4, 'turn/start', { turn: 8 });
      yield frame(5, 'user/message', { turn: 8, source });
      await ended.promise;
      yield frame(6, 'assistant/message', { turn: 8, message: { content: [{ type: 'text', text: '[SKIP]' }] } });
      yield frame(7, 'turn/end', { turn: 8, reason: { kind: 'completed' } });
    } });
    await r.handler(request(message('new-task', '请做一个方案')), response());
    await until(() => r.store.db.prepare("SELECT COUNT(*) n FROM bridge_tasks WHERE state='submitted'").get().n === 1);
    const id = r.store.db.prepare('SELECT id FROM bridge_tasks').get().id;
    assert.equal(r.state.taskLedger.get(id).state, 'submitted'); consumed.resolve();
    await until(() => r.state.taskLedger.get(id).state === 'running');
    assert.equal(r.state.taskLedger.get(id).meta.turn, 8); ended.resolve(); await r.drain();
    assert.equal(r.state.taskLedger.get(id).state, 'model_finished'); assert.equal(r.calls.length, 0);
  });
  await test('long-term convention injection excludes transient slots without deleting storage', async () => {
    const facts = new FactStore(path.join(root, 'facts'));
    for (const [key, fact, kind] of [['preference.reply', '叫我甲', 'stable'], ['task.pdf', '正在生成地图', 'task'],
      ['topic.mc', '讨论仓库', 'topic'], ['legacy.slot', '旧约定仍保留', undefined]])
      facts.commit({ subject: 'group:10', key, fact, memoryKind: kind,
        source: { conversation: 'group:10', messageId: key, qq: '200', who: '甲' } });
    const memory = { activeFacts: (key) => facts.active(key), read: () => '' };
    const r = make(); const cfg = { ...r.config, memoryEnabled: true, conversationMemoryMaxChars: 450 };
    const first = buildMemoryInjection(cfg, message(1), {}, memory);
    assert.match(first.text, /本会话长期约定|叫我甲/); assert.match(first.text, /旧约定仍保留/);
    assert.doesNotMatch(first.text, /正在生成地图|讨论仓库/); assert.equal(facts.active('group:10').length, 4);
    const disabled = buildMemoryInjection({ ...cfg, conversationMemoryMaxChars: 0 }, message(1),
      { staticDone: true, memoryHashes: first.hashes }, memory);
    assert.match(disabled.text, /之前注入的会话约定已失效/); assert.doesNotMatch(disabled.text, /叫我甲/);
  });
  await test('extractor refuses explicit temporary task slots in long-term conventions', async () => {
    const r = make(jsonModel({ memories: [{ scope: 'conversation', subjectQq: '200', sourceMessageId: 'm',
      evidence: '帮我生成地图', key: 'task.map', fact: '甲要求生成地图', memoryKind: 'task' }] }));
    const facts = new FactStore(path.join(root, 'extract'));
    const memory = { facts, syncDocument() {} };
    const extractor = new MemoryExtractor(r.ctx, { ...r.config, memoryExtractBatchSize: 40 }, memory, r.stats);
    extractor.observe('group:10', { qq: '200', messageId: 'm', text: '帮我生成地图', at: Date.now() });
    await extractor.flush(undefined, { force: true }); extractor.dispose();
    assert.equal(facts.active('group:10').length, 0); assert.equal(r.stats.memoryTransientRejected, 1);
  });
} finally {
  for (const r of rigs) { r.state.taskProgress?.dispose(); r.state.inputBatches?.dispose(); r.state.disposed = true;
    r.state.controller.abort(); r.sendQueue.dispose(); }
  await pause(20);
  for (const store of stores) store.db.close();
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
