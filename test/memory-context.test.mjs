import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { FactStore } from '../lib/memory/facts.mjs';
import { createHandler } from '../lib/routes/onebot.mjs';
import { executeTurn } from '../lib/application/execute-turn.mjs';
import { refreshWindowFromQQHistory } from '../lib/conversation/history.mjs';
import { contextMessage } from '../lib/conversation/context.mjs';
import { planWindowInjection, commitWindowInjection } from '../lib/conversation/injection.mjs';
import { buildPrompt, buildWindowSection, buildMemorySection, buildMemoryInjection } from '../lib/prompt/render.mjs';
import { rig, config, message, request, response } from './helpers/bridge.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-context-'));
const realFetch = globalThis.fetch;
let passed = 0, failed = 0, counter = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
const memo = (id = '1', overrides = {}) => ({ scope: 'user', subjectQq: '200',
  sourceMessageId: id, key: 'preference.coriander', evidence: '我不吃香菜', fact: '不吃香菜', ...overrides });
function setup(candidates = [memo()], settings = {}) {
  let runs = 0;
  const llm = { async *stream() {
    runs++;
    yield { type: 'text-delta', text: JSON.stringify({ memories: candidates }) };
  } };
  const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40, memoryExtractIntervalMs: 0,
    ...settings }, '[SKIP]', null, llm);
  const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, String(counter++)) });
  memory.extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
  r.handler = createHandler(r.ctx, r.config, r.registry, r.state, memory, r.stats);
  const post = async (event) => { await r.handler(request(event), response()); await r.drain(); };
  return { ...r, memory, post, runs: () => runs };
}
const source = (id = '1', text = '我不吃香菜') => ({ qq: '200', who: '甲', messageId: id, text, at: 1000 });

try {
  await test('background message writes source-attributed memory without any agent reply', async () => {
    const r = setup();
    await r.post(message(1, '我不吃香菜'));
    assert.equal(r.prompts.length, 0);
    await r.memory.extractor.flush(r.state.controller.signal, { force: true });
    const facts = r.memory.facts.active('user:200');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].sources[0].conversation, 'group:10');
    assert.equal(facts[0].sources[0].messageId, '1');
    assert.ok(r.memory.read('200').includes('不吃香菜'));
    const visible = fs.readFileSync(r.memory.pathFor('200'), 'utf8');
    assert.match(visible, /## 自动记忆（桥接维护）/);
    assert.match(visible, /来源 group:10 消息 1/);
    assert.equal(r.calls.length, 0);
  });
  await test('automatic facts refresh the visible document without overwriting hand-written notes', async () => {
    const r = setup();
    r.memory.append('200', '甲', '手工备注');
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    const first = fs.readFileSync(r.memory.pathFor('200'), 'utf8');
    assert.match(first, /手工备注/);
    assert.match(first, /不吃香菜/);
    r.memory.facts.commit({ subject: 'user:200', key: 'preference.coriander', fact: '现在吃香菜',
      source: { conversation: 'group:10', messageId: '2', qq: '200', who: '甲', evidence: '现在吃香菜' } });
    r.memory.syncDocument('200');
    const second = fs.readFileSync(r.memory.pathFor('200'), 'utf8');
    assert.match(second, /手工备注/);
    assert.match(second, /现在吃香菜/);
    assert.doesNotMatch(second, /不吃香菜（属性/);
  });
  await test('silent and group-suppressed turns still observe facts and never write reply claims', async () => {
    const r = setup();
    await executeTurn(r.ctx, { ...r.config, replyToGroups: false }, r.registry, r.state,
      r.memory, r.stats, null, 'group:10', message(1, 'deepseek 我不吃香菜'));
    await r.memory.extractor.flush(r.state.controller.signal, { force: true });
    assert.equal(r.memory.facts.active('user:200').length, 1);
    assert.equal(r.calls.length, 0);
  });
  await test('cross-speaker, nonexistent source and invented evidence are rejected', async () => {
    const r = setup([memo('1', { subjectQq: '201' }), memo('9'), memo('1', { evidence: '我爱编译器' })]);
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.stats.memoryCandidatesRejected, 3);
    assert.equal(r.memory.facts.active('user:200').length, 0);
    assert.equal(r.memory.facts.active('user:201').length, 0);
  });
  await test('duplicate facts merge sources, distinct message retries do not create extra model calls', async () => {
    const r = setup();
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.runs(), 1);
    const fact = r.memory.facts.active('user:200')[0];
    r.memory.facts.commit({ subject: 'user:200', key: fact.key, fact: fact.fact,
      source: { ...fact.sources[0], messageId: '2' } });
    assert.equal(r.memory.facts.active('user:200').length, 1);
    assert.equal(r.memory.facts.active('user:200')[0].sources.length, 2);
    r.memory.facts.retract('group:10', '1');
    assert.equal(r.memory.facts.active('user:200').length, 1);
    r.memory.facts.retract('group:10', '2');
    assert.equal(r.memory.facts.active('user:200').length, 0);
  });
  await test('explicit correction supersedes a slot and forget invalidates it', async () => {
    const r = setup([memo(), memo('2', { evidence: '我现在吃香菜了', fact: '现在吃香菜' })]);
    r.memory.extractor.observe('group:10', source());
    r.memory.extractor.observe('group:10', source('2', '我现在吃香菜了'));
    await r.memory.extractor.flush(null, { force: true });
    const facts = r.memory.facts.active('user:200');
    assert.equal(facts.length, 1);
    assert.equal(facts[0].fact, '现在吃香菜');
    r.memory.facts.commit({ subject: 'user:200', key: facts[0].key, fact: '现在吃香菜', operation: 'forget',
      source: { conversation: 'group:10', messageId: '3', evidence: '忘记这个喜好' } });
    assert.equal(r.memory.facts.active('user:200').length, 0);
  });
  await test('group commitments are stored separately and appear in prompts', async () => {
    const r = setup([memo('1', { scope: 'conversation', evidence: '我周三带蛋糕到群聚会',
      key: 'commitment.cake', fact: '甲约定周三带蛋糕到群聚会' })]);
    r.memory.extractor.observe('group:10', source('1', '我周三带蛋糕到群聚会'));
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.memory.facts.active('user:200').length, 0);
    const prompt = buildMemorySection(r.config, message(2), {}, r.memory);
    assert.ok(prompt.includes('本会话长期约定'));
    assert.ok(prompt.includes('消息 1'));
  });
  await test('conversation facts are neither extracted nor injected when the surface is off', async () => {
    const r = setup([
      memo('1'),
      memo('1', { scope: 'conversation', key: 'commitment.cake', fact: '甲约定周三带蛋糕到群聚会' }),
    ], { conversationMemoryMaxChars: 0 });
    r.memory.extractor.observe('group:10', source('1', '我不吃香菜，我周三带蛋糕到群聚会'));
    await r.memory.extractor.flush(null, { force: true });
    // 同批次的人物记忆照常落盘，只有会话面被拒。
    assert.equal(r.memory.facts.active('user:200').length, 1);
    assert.equal(r.memory.facts.active('group:10').length, 0);
    assert.equal(r.stats.memoryCandidatesRejected, 1);
    assert.equal(buildMemorySection(r.config, message(2), {}, r.memory).includes('本会话长期约定'), false);
    // 旧存档保留为只读记录，摘掉开关就还能看到，不会被删除或迁移。
    r.memory.facts.commit({ subject: 'group:10', key: 'commitment.cake', fact: '甲约定周三带蛋糕到群聚会',
      source: { conversation: 'group:10', messageId: '1', qq: '200', who: '甲', evidence: '我周三带蛋糕到群聚会' } });
    assert.equal(r.memory.facts.active('group:10').length, 1);
    assert.equal(buildMemorySection(r.config, message(3), {}, r.memory).includes('长期约定'), false);
    // 已经注入过旧块的活动 Session：关闭后补一次「已失效」，之后不再提。
    const stale = { staticDone: true, memoryHashes: { 'facts:group:10': { hash: 'old:1', rank: 2 } } };
    const notice = buildMemoryInjection(r.config, message(4), stale, r.memory);
    assert.ok(notice.text.includes('之前注入的会话约定已失效'));
    assert.equal(buildMemoryInjection(r.config, message(5),
      { staticDone: true, memoryHashes: notice.hashes }, r.memory).text, '');
  });
  await test('a closed conversation surface is not requested from the extractor model', async () => {
    const capture = (settings) => {
      const r = setup([], settings);
      let system = '';
      r.ctx.get = (name) => name === 'llm'
        ? { async *stream(req) { system = req.system; yield { type: 'text-delta', text: JSON.stringify({ memories: [] }) }; } }
        : { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return { r, read: () => system };
    };
    const off = capture({ conversationMemoryMaxChars: 0 });
    off.r.memory.extractor.observe('group:10', source());
    await off.r.memory.extractor.flush(null, { force: true });
    assert.match(off.read(), /会话约定面已关闭/);
    assert.doesNotMatch(off.read(), /user\|conversation/);
    assert.match(off.read(), /"scope":"user"/);
    const on = capture({});
    on.r.memory.extractor.observe('group:10', source());
    await on.r.memory.extractor.flush(null, { force: true });
    assert.match(on.read(), /"scope":"user\|conversation"/);
    assert.doesNotMatch(on.read(), /会话约定面已关闭/);
  });
  await test('recall notice invalidates facts, removes context and blocks later resurrection', async () => {
    const r = setup();
    await r.post(message(1, '我不吃香菜'));
    await r.memory.extractor.flush(null, { force: true });
    r.registry.record(r.registry.entry('group:10'), source());
    await r.post({ post_type: 'notice', notice_type: 'group_recall', self_id: 100, user_id: 200, group_id: 10, message_id: 1 });
    assert.equal(r.memory.facts.active('user:200').length, 0);
    assert.equal(r.registry.entry('group:10').window.length, 0);
    assert.equal(r.registry.record(r.registry.entry('group:10'), source()), false);
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.runs(), 1);
  });
  await test('recall during model extraction prevents an in-flight candidate from committing', async () => {
    const r = setup();
    let release, start;
    const gate = new Promise((resolve) => release = resolve), ready = new Promise((resolve) => start = resolve);
    const llm = { async *stream() { start(); await gate; yield { type: 'text-delta', text: JSON.stringify({ memories: [memo()] }) }; } };
    r.ctx.get = (name) => name === 'llm' ? llm : { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    r.memory.extractor.observe('group:10', source());
    const running = r.memory.extractor.flush(null, { force: true });
    await ready;
    r.memory.extractor.retract('group:10', '1');
    release(); await running;
    assert.equal(r.memory.facts.active('user:200').length, 0);
  });
  await test('shutdown interrupts a provider that ignores cancellation and leaves batch pending', async () => {
    const r = setup();
    let start;
    const ready = new Promise((resolve) => start = resolve);
    r.ctx.get = (name) => name === 'llm' ? { async *stream() { start(); await new Promise(() => {}); } }
      : { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    r.memory.extractor.observe('group:10', source());
    const running = r.memory.extractor.flush(r.state.controller.signal, { force: true });
    await ready; r.state.persistEnabled(false); await running;
    assert.equal(r.memory.extractor.entries.get('group:10').pending.length, 1);
    assert.equal(r.memory.facts.active('user:200').length, 0);
  });
  await test('malformed JSON keeps a pending batch available for retry', async () => {
    const r = setup();
    r.ctx.get = (name) => name === 'llm' ? { async *stream() { yield { type: 'text-delta', text: 'bad JSON' }; } }
      : { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.stats.memoryExtractFailed, 1);
    assert.equal(r.memory.extractor.entries.get('group:10').pending.length, 1);
  });
  await test('lagging reversed QQ history merges without losing newer local context', async () => {
    const r = rig({ contextFromQQHistory: true });
    const entry = r.registry.entry('group:10');
    r.registry.record(entry, { ...source('3', '最新本地消息'), at: 3000 });
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0,
      data: { messages: [{ message_id: '2', time: 2, user_id: 201, message: '第二条' },
        { message_id: '1', time: 1, user_id: 200, message: '第一条' }] } }) });
    await refreshWindowFromQQHistory(r.ctx, r.config, r.registry, entry, 'group:10', r.stats);
    assert.deepEqual(entry.window.map((m) => m.messageId), ['1', '2', '3']);
  });
  await test('window preserves reply target and uses windowTurns alongside message caps', async () => {
    const r = rig({ windowTurns: 2, contextOthersMessages: 20 });
    const entry = r.registry.entry('group:10');
    for (let i = 1; i <= 3; i++) {
      entry.contextTurn = i;
      const event = message(i, '第' + i + '句');
      event.time = i;
      if (i === 3) event.message.unshift({ type: 'reply', data: { id: 2 } });
      r.registry.record(entry, contextMessage(event));
    }
    assert.deepEqual(entry.window.map((m) => m.messageId), ['2', '3']);
    const text = buildWindowSection(r.config, entry);
    assert.match(text, /回复 200 的消息 2/);
  });
  await test('current message follows output constraints and output bubbles are a maximum', async () => {
    const text = buildPrompt(message(1, 'CURRENT'), config({ persona: 'PERSONA' }), {
      shape: { bubbles: 3, sticker: false }, windowText: 'WINDOW', includeStatic: true,
    });
    assert.ok(text.includes('最多回 3 个气泡'));
    assert.ok(text.indexOf('【这条回多少】') > text.indexOf('【要做的事就得真做】'));
    assert.ok(text.indexOf('【这条回多少】') < text.indexOf('WINDOW'));
    assert.ok(text.endsWith('CURRENT'));
  });
  await test('stable speaking and bubble rules are only in the Session static block', async () => {
    const event = message(1, '普通消息');
    const first = buildPrompt(event, config(), { includeStatic: true, shape: null });
    const later = buildPrompt(event, config(), { includeStatic: false, shape: null });
    assert.ok(first.includes('【群聊轮次与退避】'));
    assert.ok(first.includes('补充或转折时用空行分隔'));
    assert.equal(later.includes('【群聊轮次与退避】'), false);
    assert.equal(later.includes('补充或转折时用空行分隔'), false);
    assert.ok(later.includes('当前会话 group:10'));
  });
  await test('memory is injected on the first Session turn and only when its content changes', async () => {
    const r = setup([], { memoryAutoExtract: false, memoryInjectOnChange: true });
    r.memory.append('200', '甲', '喜欢吃辣');
    await r.post(message(1, 'deepseek 第一条'));
    await r.post(message(2, 'deepseek 第二条'));
    const first = r.prompts[0].content.map((p) => p.text ?? '').join('\n');
    const second = r.prompts[1].content.map((p) => p.text ?? '').join('\n');
    assert.ok(first.includes('喜欢吃辣'));
    assert.equal(second.includes('喜欢吃辣'), false);
  });
  await test('sliding window is seeded once per DSH Session', async () => {
    const r = setup([], { memoryAutoExtract: false, injectWindowOnce: true, rotateEveryTurns: 10 });
    r.registry.record(r.registry.entry('group:10'), { qq: '201', who: '乙', text: '背景消息', messageId: '0', at: 1 });
    await r.post(message(1, 'deepseek 第一条'));
    await r.post(message(2, 'deepseek 第二条'));
    const first = r.prompts[0].content.map((p) => p.text ?? '').join('\n');
    const second = r.prompts[1].content.map((p) => p.text ?? '').join('\n');
    assert.match(first, /【最近聊了什么/);
    assert.doesNotMatch(second, /【最近聊了什么/);
    assert.match(second, /第二条/);
  });
  await test('window compatibility switch keeps per-turn injection available', async () => {
    const r = setup([], { memoryAutoExtract: false, injectWindowOnce: false, rotateEveryTurns: 10 });
    r.registry.record(r.registry.entry('group:10'), { qq: '201', who: '乙', text: '背景消息', messageId: '0', at: 1 });
    await r.post(message(1, 'deepseek 第一条'));
    await r.post(message(2, 'deepseek 第二条'));
    const second = r.prompts[1].content.map((p) => p.text ?? '').join('\n');
    assert.match(second, /【最近聊了什么/);
  });
  await test('new background is a delta, not another copy of known context', async () => {
    const r = setup([], { memoryAutoExtract: false, awakeMs: 0 });
    r.registry.record(r.registry.entry('group:10'), source('old', '已知背景'));
    await r.post(message(1, 'deepseek 第一条'));
    await r.post(message(2, '新背景'));
    await r.post(message(3, 'deepseek 第二条'));
    const text = r.prompts[1].content[0].text;
    assert.match(text, /时间线增量/);
    assert.match(text, /新背景/);
    assert.doesNotMatch(text, /已知背景|第一条/);
    assert.equal(r.stats.lastPrompt.windowMessages, 1);
  });
  await test('QQ history containing the current message cannot trigger full reinjection', async () => {
    const r = setup([], { memoryAutoExtract: false });
    await r.post(message(1, 'deepseek 第一条'));
    const entry = r.registry.entry('group:10');
    entry.window.push(contextMessage(message(2, 'deepseek 第二条')));
    await r.post(message(2, 'deepseek 第二条'));
    assert.doesNotMatch(r.prompts[1].content[0].text, /【最近聊了什么/);
  });
  await test('window delta follows time order and retains a known quoted source', async () => {
    const cfg = config(), entry = { turns: 1, windowHashes: {} };
    const a = source('a', '引用原文'), b = { ...source('b', '跟进'), at: 2000, replyToId: 'a' };
    commitWindowInjection(entry, planWindowInjection(cfg, entry, [a]));
    const plan = planWindowInjection(cfg, entry, [b, a]);
    assert.deepEqual(plan.messages.map((m) => m.messageId), ['a', 'b']);
    assert.match(buildWindowSection(cfg, { window: plan.messages }), /回复 甲 的消息 a/);
  });
  await test('timestamp calibration is ignored, but changed text and new self receipts are injected', async () => {
    const cfg = config(), entry = { turns: 1, windowHashes: {} };
    const a = source('a', '旧正文');
    commitWindowInjection(entry, planWindowInjection(cfg, entry, [a]));
    assert.equal(planWindowInjection(cfg, entry, [{ ...a, at: 2000, timeSource: 'qq' }]).messages.length, 0);
    const own = { ...source('receipt', '实际发出的气泡'), bot: true, at: 3000 };
    const plan = planWindowInjection(cfg, entry, [own, { ...a, text: '更新正文' }]);
    assert.deepEqual(plan.messages.map((m) => m.messageId), ['a', 'receipt']);
    commitWindowInjection(entry, plan);
    assert.equal(planWindowInjection(cfg, entry, plan.messages).messages.length, 0);
  });
  await test('failed admission does not consume window delta or static injection', async () => {
    const r = setup([], { memoryAutoExtract: false });
    await r.post(message(1, 'deepseek 第一条'));
    const entry = r.registry.entry('group:10');
    r.registry.record(entry, source('background', '失败后还需注入'));
    const known = JSON.stringify(entry.windowHashes);
    const prompt = r.ctx.sessionController.prompt;
    r.ctx.sessionController.prompt = async () => { throw Error('network timeout'); };
    await r.post(message(2, 'deepseek 第二条'));
    assert.equal(JSON.stringify(entry.windowHashes), known);
    r.ctx.sessionController.prompt = prompt;
    await r.post(message(3, 'deepseek 第三条'));
    assert.match(r.prompts[1].content[0].text, /失败后还需注入/);
  });
  await test('background arriving during prompt construction stays unseen for the next submission', async () => {
    const cfg = config(), entry = { turns: 1, windowHashes: {} };
    const a = source('a', '构建时的背景'), b = source('b', '稍后到达的背景');
    const pending = planWindowInjection(cfg, entry, [a]);
    commitWindowInjection(entry, pending);
    assert.deepEqual(planWindowInjection(cfg, entry, [a, b]).messages.map((m) => m.messageId), ['b']);
  });
  await test('DSH compaction invalidates prompt injection cursors', async () => {
    const r = setup([], { memoryAutoExtract: false });
    r.memory.append('200', '甲', '喜欢吃辣');
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '[SKIP]' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'compaction/summary', data: {} } };
      yield { type: 'event', event: { seq: 3, type: 'turn/end' } };
    } });
    await r.post(message(1, 'deepseek 第一条'));
    const entry = r.registry.entry('group:10');
    assert.equal(entry.staticDone, false);
    assert.deepEqual(entry.windowHashes, {});
    assert.deepEqual(entry.memoryHashes, {});
    await r.post(message(2, 'deepseek 第二条'));
    assert.match(r.prompts[1].content[0].text, /喜欢吃辣/);
    assert.match(r.prompts[1].content[0].text, /【群聊轮次与退避】/);
    assert.match(r.prompts[1].content[0].text, /\[WAIT\]/);
    assert.deepEqual(entry.exampleHashes, {});
  });
  await test('changing episodic recall does not mark long-term memory as changed', async () => {
    let episode = '【相关经历】\n- 第一次经历';
    const fakeMemory = {
      recallEpisodes: () => episode,
      activeFacts: () => [],
      read: () => '# QQ 200\n\n## 记忆\n',
    };
    const event = message(1, '问题');
    const memoryConfig = config({ memoryEnabled: true });
    const first = buildMemorySection(memoryConfig, event, {}, fakeMemory);
    const stableFirst = buildMemorySection(memoryConfig, event, {}, fakeMemory, { includeEpisodes: false });
    episode = '【相关经历】\n- 另一段不同经历';
    const second = buildMemorySection(memoryConfig, event, {}, fakeMemory);
    const stableSecond = buildMemorySection(memoryConfig, event, {}, fakeMemory, { includeEpisodes: false });
    assert.notEqual(first, second);
    assert.equal(stableFirst, stableSecond);
  });
  await test('alternating group speakers do not resend unchanged documents', async () => {
    const r = setup([], { memoryAutoExtract: false, memoryInjectOnChange: true, memoryInjectRecent: 1 });
    r.memory.append('200', '甲', '甲喜欢吃辣');
    r.memory.append('201', '乙', '乙喜欢吃甜');
    await r.post(message(1, 'deepseek 甲来聊天'));
    await r.post(message(2, 'deepseek 乙来聊天', 10, 201));
    await r.post(message(3, 'deepseek 甲又来了'));
    const third = r.prompts[2].content.map((p) => p.text ?? '').join('\n');
    assert.equal(third.includes('甲喜欢吃辣'), false);
    assert.equal(third.includes('乙喜欢吃甜'), false);
    r.memory.append('201', '乙', '乙现在喜欢吃酸');
    await r.post(message(4, 'deepseek 乙更新了', 10, 201));
    const fourth = r.prompts[3].content.map((p) => p.text ?? '').join('\n');
    assert.ok(fourth.includes('乙现在喜欢吃酸'));
    assert.equal(fourth.includes('甲喜欢吃辣'), false);
  });
  await test('episodic changes inject independently of unchanged personal memory', async () => {
    let episode = '【相关经历】\n- 先前经历';
    const memory = { read: () => '# 甲\n## 记忆\n- 喜欢吃辣', activeFacts: () => [], recallEpisodes: () => episode };
    const cfg = config({ memoryEnabled: true });
    const event = message(1);
    const first = buildMemoryInjection(cfg, event, {}, memory);
    const entry = { staticDone: true, memoryHashes: first.hashes };
    assert.equal(buildMemoryInjection(cfg, event, entry, memory).text, '');
    episode = '【相关经历】\n- 刚刚的新经历';
    const next = buildMemoryInjection(cfg, event, entry, memory);
    assert.ok(next.text.includes('刚刚的新经历'));
    assert.equal(next.text.includes('喜欢吃辣'), false);
  });
  await test('total memory budget includes separators and never marks omitted blocks as known', async () => {
    const facts = [{ fact: '约定' + '很长的内容'.repeat(40), sources: [{ qq: '200', messageId: '1' }] }];
    const memory = { read: () => '# 甲\n## 记忆\n- 事实' + '重要内容'.repeat(70),
      activeFacts: () => facts, recallEpisodes: () => '【相关经历】\n- 新经历' };
    const cfg = config({ memoryEnabled: true, memoryInjectMaxChars: 500 });
    const first = buildMemoryInjection(cfg, message(1), {}, memory);
    assert.ok(first.text.length <= 500);
    assert.ok(first.text.includes('事实'));
    assert.equal(first.hashes['facts:group:10'], undefined);
    const next = buildMemoryInjection(cfg, message(2), { staticDone: true, memoryHashes: first.hashes }, memory);
    assert.ok(next.text.includes('本会话长期约定'));
    assert.ok(next.text.length <= 500);
  });
  await test('long facts are omitted whole rather than cut before their negation or receipt', async () => {
    const unsafe = '- 很长的记录'.repeat(200) + '，并没有完成';
    const memory = { read: () => '# 甲\n## 记忆\n' + unsafe + '\n- 最新事实：不吃香菜\n## 早期\n', activeFacts: () => [] };
    const text = buildMemorySection(config({ memoryEnabled: true }), message(1), {}, memory);
    assert.ok(text.includes('最新事实：不吃香菜'));
    assert.equal(text.includes('很长的记录'), false);
  });
  await test('withdrawn group facts invalidate the previously injected commitment', async () => {
    let facts = [{ fact: '周三见面', sources: [{ qq: '200', messageId: '1' }] }];
    const memory = { read: () => null, activeFacts: () => facts };
    const cfg = config({ memoryEnabled: true });
    const first = buildMemoryInjection(cfg, message(1), {}, memory);
    facts = [];
    const next = buildMemoryInjection(cfg, message(2), { staticDone: true, memoryHashes: first.hashes }, memory);
    assert.ok(next.text.includes('之前注入的会话约定已失效'));
    assert.equal(next.text.includes('暂无已保存'), false);
  });
  await test('private personal and conversation fact hashes do not collide', async () => {
    const event = { ...message(1), message_type: 'private' };
    const memory = { read: () => '# 甲\n## 记忆\n- 喜欢吃辣', activeFacts: () => [] };
    const cfg = config({ memoryEnabled: true });
    const first = buildMemoryInjection(cfg, event, {}, memory);
    assert.ok(first.hashes['user:200']);
    assert.ok(first.hashes['facts:user:200']);
    assert.equal(buildMemoryInjection(cfg, event, { staticDone: true, memoryHashes: first.hashes }, memory).text, '');
  });
  await test('Session rotation reinjects bounded memory without losing the QQ window', async () => {
    const r = setup([], { memoryAutoExtract: false, rotateEveryTurns: 2 });
    r.memory.append('200', '甲', '喜欢吃辣');
    await r.post(message(1, 'deepseek 第一条'));
    await r.post(message(2, 'deepseek 第二条'));
    const oldSession = r.registry.entry('group:10').sessionId;
    await r.post(message(3, 'deepseek 第三条'));
    const text = r.prompts[2].content.map((p) => p.text ?? '').join('\n');
    assert.notEqual(r.registry.entry('group:10').sessionId, oldSession);
    assert.ok(text.includes('喜欢吃辣'));
    assert.ok(text.includes('第一条'));
  });
  await test('missing session is rebuilt before submission, unknown prompt errors are not retried', async () => {
    const r = rig({ persona: 'RECOVER-PERSONA' });
    r.registry.entry('group:10').sessionId = 'deleted';
    r.registry.entry('group:10').staticDone = true;
    const follow = r.ctx.sessionController.follow;
    r.ctx.sessionController.follow = (address) => {
      if (address.address.sessionId === 'deleted') throw Object.assign(Error('session not found'), { code: 'SESSION_NOT_FOUND' });
      return follow(address);
    };
    await r.post(message(1, 'deepseek 你好'));
    assert.equal(r.prompts.length, 1);
    assert.ok(r.prompts[0].content[0].text.includes('RECOVER-PERSONA'));
    r.ctx.sessionController.prompt = async () => { throw Error('network timeout'); };
    await r.post(message(2, 'deepseek 你好'));
    assert.equal(r.stats.sessionsRecovered, 1);
  });
  await test('memory batches and source facts survive extractor reload without repeated writes', async () => {
    const r = setup(), saved = new Map();
    const store = { getState: (key) => saved.get(key), setState: (key, value) => saved.set(key, value) };
    r.memory.extractor = new MemoryExtractor(r.ctx, r.config, r.memory, r.stats, store);
    r.memory.extractor.observe('group:10', source());
    r.memory.extractor.dispose();
    const recovered = new MemoryStore(r.ctx, r.memory.config);
    const extractor = new MemoryExtractor(r.ctx, r.config, recovered, r.stats, store);
    await extractor.flush(null, { force: true });
    assert.equal(recovered.facts.active('user:200')[0].sources[0].messageId, '1');
    extractor.dispose();
    const again = new MemoryExtractor(r.ctx, r.config, recovered, r.stats, store);
    again.observe('group:10', source());
    await again.flush(null, { force: true });
    assert.equal(r.runs(), 1);
    recovered.facts.retract('group:10', '1');
    assert.equal(new FactStore(recovered.dir).withdrawn('group:10', '1'), true);
    again.dispose();
  });
  await test('restored batches obey changed admission and excluded messages do not reach the model', async () => {
    const r = setup(), saved = new Map();
    const store = { getState: (key) => saved.get(key), setState: (key, value) => saved.set(key, value) };
    const initial = new MemoryExtractor(r.ctx, r.config, r.memory, r.stats, store);
    initial.observe('group:10', source()); initial.dispose();
    const recovered = new MemoryExtractor(r.ctx, { ...r.config, groups: ['11'] }, r.memory, r.stats, store);
    await recovered.flush(null, { force: true });
    assert.equal(r.runs(), 0);
    assert.equal(recovered.entries.get('group:10').pending.length, 0);
    recovered.dispose();
  });
  await test('one failed extraction does not starve another conversation', async () => {
    const r = setup();
    r.ctx.get = (name) => name === 'llm' ? { async *stream(req) {
      const data = JSON.parse(req.messages[0].content[0].text);
      yield { type: 'text-delta', text: data.conversation === 'group:10' ? 'invalid' :
        JSON.stringify({ memories: [memo('2')] }) };
    } } : { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    r.memory.extractor.observe('group:10', source());
    r.memory.extractor.observe('group:11', source('2'));
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(r.stats.memoryExtractFailed, 1);
    assert.equal(r.memory.facts.active('user:200')[0].sources[0].conversation, 'group:11');
  });
  await test('corrupt facts preserve legacy memory and cannot be silently overwritten', async () => {
    const r = setup();
    r.memory.append('200', '甲', '旧手写记录');
    const file = r.memory.facts.file('user:200');
    fs.writeFileSync(file, 'broken JSON');
    assert.ok(r.memory.read('200').includes('旧手写记录'));
    assert.doesNotThrow(() => buildMemorySection(r.config, message(2), {}, r.memory));
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken JSON');
    assert.equal(r.memory.extractor.entries.get('group:10').pending.length, 1);
  });
  await test('recall is processed while hosting is off and includes the bots own context', async () => {
    const r = setup();
    r.memory.extractor.observe('group:10', source());
    await r.memory.extractor.flush(null, { force: true });
    r.registry.record(r.registry.entry('group:10'), { ...source('2'), qq: '100', bot: true });
    r.state.persistEnabled(false);
    await r.post({ post_type: 'notice', notice_type: 'group_recall', self_id: 100, user_id: 200, group_id: 10, message_id: 1 });
    await r.post({ post_type: 'notice', notice_type: 'group_recall', self_id: 100, user_id: 100, group_id: 10, message_id: 2 });
    assert.equal(r.memory.facts.active('user:200').length, 0);
    assert.equal(r.registry.entry('group:10').window.length, 0);
  });
  await test('context and quotes restore with the session; changed model rebuilds only the session', async () => {
    const saved = new Map(), store = { available: true,
      getState: (key) => saved.get(key), setState: (key, value) => saved.set(key, value) };
    const first = rig({ llmModel: 'old' }, '你好', store);
    const entry = first.registry.entry('group:10');
    await first.registry.ensureSession('group:10');
    entry.turns = 6; entry.contextTurn = 6; entry.staticDone = true;
    entry.memoryHashes = { 'user:200': { hash: 'injected', rank: 2 } };
    entry.windowHashes = { 'id:1': 'known-message' };
    first.registry.record(entry, { ...source(), replyToId: 'before' });
    entry.recalledIds = ['recalled']; first.registry.persist('group:10');
    const same = rig({ llmModel: 'old' }, '你好', store);
    assert.equal(await same.registry.ensureSession('group:10'), 's1');
    assert.equal(same.registry.entry('group:10').turns, 6);
    assert.deepEqual(same.registry.entry('group:10').memoryHashes, entry.memoryHashes);
    assert.deepEqual(same.registry.entry('group:10').windowHashes, entry.windowHashes);
    assert.equal(same.registry.entry('group:10').window[0].replyToId, 'before');
    assert.deepEqual(same.registry.entry('group:10').recalledIds, ['recalled']);
    const changed = rig({ llmModel: 'new' }, '你好', store);
    changed.ctx.sessionController.create = async () => ({ sessionId: 'changed-model' });
    assert.equal(await changed.registry.ensureSession('group:10'), 'changed-model');
    assert.equal(changed.registry.entry('group:10').window[0].messageId, '1');
    assert.equal(changed.registry.entry('group:10').staticDone, false);
    assert.deepEqual(changed.registry.entry('group:10').memoryHashes, {});
    assert.deepEqual(changed.registry.entry('group:10').windowHashes, {});
  });
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
