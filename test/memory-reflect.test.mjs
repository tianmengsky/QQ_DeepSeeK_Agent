/**
 * 记忆反思（L4）与 fact 印证权重的行为测试。
 *
 * 按仓库规矩只钉行为：印证计数、旧档兼容、规律段落替换而非追加、key 校验丢弃、
 * 频率限制、重载后不立刻重跑。**不**断言任何提示词措辞。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { FactStore } from '../lib/memory/facts.mjs';
import { MemoryExtractor } from '../lib/memory/extractor.mjs';
import { createHandler } from '../lib/routes/onebot.mjs';
import {
  MemoryReflector,
  MEMORY_REFLECT_STATE_KEY,
  rankFacts,
  mergeCandidates,
  parseRules,
  upsertRulesSection,
  renderRulesSection,
  RULES_HEADING,
} from '../lib/memory/reflect.mjs';
import { rig, message, request, response } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-reflect-'));
const stores = [];
let passed = 0, failed = 0, counter = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
const DAY = 24 * 60 * 60 * 1000;
const dirFor = (tag = 'd') => path.join(root, `${tag}-${counter++}`);

const source = (id, qq = '200') => ({ conversation: 'group:10', messageId: String(id), qq, who: '甲',
  evidence: `证据${id}`, at: Date.now() });

function seed(memory, qq = '200', count = 10, agentCount = 0) {
  for (let i = 0; i < count; i++) {
    memory.facts.commit({ subject: `user:${qq}`, key: `topic.${i}`, fact: `第 ${i} 条事实`,
      source: source(i + 1, qq) });
  }
  // 主源：模型通过 qq_memory 写的记事本条目（SQLite）。
  for (let i = 0; i < agentCount; i++) {
    memory.agent.write({ subject: qq, slot: `note.${i}`, version: 0, kind: 'note',
      text: `记事第 ${i} 条`, sources: [{ conversation: 'group:10', messageId: `note-${i}`,
        qq, who: '甲', at: Date.now() }] });
  }
  memory.syncDocument(qq);
}

function fakeStore() {
  const store = new Store(path.join(root, `db-${counter++}`, 'bridge.sqlite3'));
  stores.push(store);
  return store;
}

/** 造一个反思器 + 一份人物档。`reply` 可以是字符串、函数或 Error。 */
function makeReflector({ over = {}, reply = '{"rules":[]}', count = 10, agentCount = 0, qq = '200',
  store = null, dir = null } = {}) {
  const llm = {
    calls: 0,
    requests: [],
    async *stream(request) {
      llm.calls++;
      llm.requests.push(request);
      const out = typeof reply === 'function' ? reply(request) : reply;
      if (out instanceof Error) throw out;
      yield { type: 'text-delta', text: out };
    },
  };
  const r = rig({ memoryEnabled: true, ...over }, '[SKIP]', store, llm);
  const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: dir ?? dirFor('memory') }, store);
  seed(memory, qq, count, agentCount);
  const stats = {};
  const reflector = new MemoryReflector(r.ctx, r.config, memory, stats, store);
  return { ...r, memory, stats, reflector, llm, qq };
}

try {
  // ---------------------------------------------------------------- fact 权重

  await test('同 key 再以印证出现只加证据：计数+1、置信度升档、原文不变', async () => {
    const facts = new FactStore(dirFor('facts'));
    facts.commit({ subject: 'user:200', key: 'preference.cat', fact: '喜欢猫', source: source(1) });
    const first = facts.active('user:200')[0];
    assert.equal(first.confirmations, 1);
    assert.equal(first.confidence, 0.5);
    assert.ok(first.lastSeen > 0, 'lastSeen 必须落盘，反思层靠它做衰减');

    const result = facts.commit({ subject: 'user:200', key: 'preference.cat', fact: '养了两只猫',
      relation: 'confirm', source: source(2) });
    assert.equal(result.confirmed, true);
    assert.equal(result.added, false);
    const active = facts.active('user:200');
    assert.equal(active.length, 1, '印证不能多出一条记录');
    assert.equal(active[0].fact, '喜欢猫', '印证不改写原文（改写属于纠正）');
    assert.equal(active[0].confirmations, 2);
    assert.ok(active[0].confidence > first.confidence);
    assert.equal(active[0].sources.length, 2);
    assert.equal(active[0].sourceCount, 2);
  });

  await test('同一条消息重放不算印证，避免重试把权重刷上去', async () => {
    const facts = new FactStore(dirFor('replay'));
    facts.commit({ subject: 'user:200', key: 'topic.a', fact: '甲', source: source(7) });
    facts.commit({ subject: 'user:200', key: 'topic.a', fact: '甲', source: source(7) });
    facts.commit({ subject: 'user:200', key: 'topic.a', fact: '甲', relation: 'confirm', source: source(7) });
    assert.equal(facts.active('user:200')[0].confirmations, 1);
    assert.equal(facts.active('user:200')[0].sources.length, 1);
  });

  await test('纠正按覆盖处理：旧记录失效、新记录从 1 次印证重新开始', async () => {
    const facts = new FactStore(dirFor('correct'));
    facts.commit({ subject: 'user:200', key: 'preference.cat', fact: '喜欢猫', source: source(1) });
    facts.commit({ subject: 'user:200', key: 'preference.cat', fact: '也喜欢狗', relation: 'confirm', source: source(2) });
    facts.commit({ subject: 'user:200', key: 'preference.cat', fact: '现在不养猫了', source: source(3) });
    const active = facts.active('user:200');
    assert.equal(active.length, 1);
    assert.equal(active[0].fact, '现在不养猫了');
    assert.equal(active[0].confirmations, 1);
  });

  await test('旧档缺新字段：读取时补齐默认值，写入不报错', async () => {
    const facts = new FactStore(dirFor('legacy'));
    const legacy = [{
      subject: 'user:300', key: 'profile.city', fact: '在成都上班',
      sources: [{ conversation: 'group:10', messageId: '9', qq: '300' }], sourceCount: 1,
      createdAt: 1700000000000, active: true, memoryKind: 'stable',
    }, {
      subject: 'user:300', key: 'profile.job', fact: '做前端',
      sources: [{ conversation: 'group:10', messageId: '10', qq: '300' }], sourceCount: 1,
      active: true, memoryKind: 'stable',
    }];
    fs.writeFileSync(facts.file('user:300'), JSON.stringify(legacy), 'utf8');

    const active = facts.active('user:300');
    assert.equal(active.length, 2);
    for (const record of active) {
      assert.equal(record.confirmations, 1);
      assert.equal(record.confidence, 0.5);
    }
    assert.equal(active[0].lastSeen, 1700000000000, '有 createdAt 就用它');
    assert.equal(active[1].lastSeen, 0, '连 createdAt 都没有时退 0，而不是 now');

    // 旧档上继续写：不能抛，而且新记录带全字段。
    const added = facts.commit({ subject: 'user:300', key: 'profile.city', fact: '搬到重庆了',
      source: source(11, '300') });
    assert.equal(added.added, true);
    const latest = facts.active('user:300').find((r) => r.key === 'profile.city');
    assert.equal(latest.fact, '搬到重庆了');
    assert.equal(latest.confirmations, 1);
    assert.ok(latest.lastSeen > 0);
  });

  // ---------------------------------------------------------------- 提炼器

  await test('提炼器：缺 relation 按纠正处理，标 confirm 时只加证据', async () => {
    const candidates = { list: [] };
    const llm = { async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ memories: candidates.list }) };
    } };
    const r = rig({ memoryEnabled: true, memoryAutoExtract: true, memoryExtractBatchSize: 40,
      memoryExtractIntervalMs: 0 }, '[SKIP]', null, llm);
    const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: dirFor('extract') });
    memory.extractor = new MemoryExtractor(r.ctx, r.config, memory, r.stats);
    r.handler = createHandler(r.ctx, r.config, r.registry, r.state, memory, r.stats);
    const post = async (event) => { await r.handler(request(event), response()); await r.drain(); };

    candidates.list = [{ scope: 'user', subjectQq: '200', sourceMessageId: '1',
      evidence: '我不吃香菜', key: 'preference.coriander', fact: '不吃香菜', operation: 'upsert' }];
    await post(message(1, '我不吃香菜'));
    await memory.extractor.flush(null, { force: true });
    assert.equal(memory.facts.active('user:200')[0].confirmations, 1);

    candidates.list = [{ scope: 'user', subjectQq: '200', sourceMessageId: '2',
      evidence: '真的不吃香菜', key: 'preference.coriander', fact: '一点香菜都不吃',
      operation: 'upsert', relation: 'confirm' }];
    await post(message(2, '真的不吃香菜'));
    await memory.extractor.flush(null, { force: true });
    let active = memory.facts.active('user:200');
    assert.equal(active.length, 1);
    assert.equal(active[0].fact, '不吃香菜');
    assert.equal(active[0].confirmations, 2);
    assert.equal(r.stats.memoriesConfirmed, 1);

    // 模型漏吐 relation：沿用原来的覆盖语义，整条候选不能因此被丢掉。
    candidates.list = [{ scope: 'user', subjectQq: '200', sourceMessageId: '3',
      evidence: '我现在吃香菜了', key: 'preference.coriander', fact: '现在吃香菜' }];
    await post(message(3, '我现在吃香菜了'));
    await memory.extractor.flush(null, { force: true });
    active = memory.facts.active('user:200');
    assert.equal(active.length, 1);
    assert.equal(active[0].fact, '现在吃香菜');
    assert.equal(r.stats.memoriesWritten, 2);
  });

  // ---------------------------------------------------------------- 反思纯函数

  await test('权重排序：置信度 × 衰减 × log(印证)，并按 topN 截断', async () => {
    const now = 1_700_000_000_000;
    const facts = [
      { key: 'a', confidence: 0.9, confirmations: 5, lastSeen: now },
      { key: 'b', confidence: 0.9, confirmations: 5, lastSeen: now - 180 * DAY },
      { key: 'c', confidence: 0.2, confirmations: 1, lastSeen: now },
      { key: 'd', confidence: 0.6, confirmations: 2, lastSeen: now - 5 * DAY },
    ];
    assert.deepEqual(rankFacts(facts, { now }).map((r) => r.key), ['a', 'd', 'c', 'b']);
    assert.equal(rankFacts(facts, { now, limit: 2 }).length, 2);
    // 缺新字段的旧记录也要能参与排序（按 1 次印证、0.5 置信度）。
    assert.equal(rankFacts([{ key: 'e' }], { now }).length, 1);
  });

  await test('规律校验：supports 引用了不存在的 key 就整条丢弃', async () => {
    const raw = JSON.stringify({ rules: [
      { rule: '人少于四个才开玩笑', supports: ['topic.0', 'topic.1'], confidence: 0.7 },
      { rule: '引用了一个不存在的 key', supports: ['topic.0', 'topic.404'], confidence: 0.8 },
      { rule: '没有支撑', supports: [], confidence: 0.6 },
      { rule: '置信度越界', supports: ['topic.0'], confidence: 1.7 },
      { rule: '人少于四个才开玩笑', supports: ['topic.2'], confidence: 0.6 },
    ] });
    const rules = parseRules(raw, ['topic.0', 'topic.1', 'topic.2']);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule, '人少于四个才开玩笑');
    assert.deepEqual(rules[0].supports, ['topic.0', 'topic.1']);
    // 整份不是 JSON 时抛给调用方（反思器负责归因为 invalid-json / empty-output）。
    assert.throws(() => parseRules('这不是 JSON', ['topic.0']));
  });

  await test('规律段落：整段替换而不是追加，其它段落原样保留', async () => {
    const base = ['# 甲（QQ 200）', '', '## 手工记忆', '', '- 手工条目', '',
      '## 自动记忆（桥接维护）', '', '- 自动事实', '', '## 早期（已摘要）', '', '- 旧摘要', ''].join('\n');
    const once = upsertRulesSection(base, renderRulesSection([
      { rule: '提到猫会主动接话', supports: ['topic.0', 'topic.1'], confidence: 0.7 },
    ]));
    assert.ok(once.includes(RULES_HEADING));
    assert.ok(once.includes('支撑：topic.0、topic.1；置信度 0.7'));
    const twice = upsertRulesSection(once, renderRulesSection([
      { rule: '人少于四个才开玩笑', supports: ['topic.2', 'topic.3'], confidence: 0.8 },
    ]));
    assert.equal(twice.split(RULES_HEADING).length - 1, 1, '同一个标题只能出现一次');
    assert.ok(twice.includes('人少于四个才开玩笑'));
    assert.ok(!twice.includes('提到猫会主动接话'), '旧规律必须被替换掉');
    // 其它段落不能被动到。
    assert.ok(twice.includes('- 手工条目') && twice.includes('- 自动事实') && twice.includes('- 旧摘要'));
  });

  // ---------------------------------------------------------------- 端到端

  await test('反思落盘：写进 ## 规律，且经过一次文档同步仍然在', async () => {
    const reply = JSON.stringify({ rules: [
      { rule: '提到猫他会主动接话，而且句子明显变长', supports: ['topic.0', 'topic.1'], confidence: 0.7 },
    ] });
    const setup = makeReflector({ reply });
    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, true);
    assert.equal(out.rules, 1);
    const file = setup.memory.pathFor('200');
    let text = fs.readFileSync(file, 'utf8');
    assert.match(text, /## 规律/);
    assert.match(text, /提到猫他会主动接话/);
    assert.equal(setup.stats.memoryReflectRuns, 1);
    assert.equal(setup.stats.memoryReflectRules, 1);

    // 投影流程会重写 ## 主模型记忆 / 自动记忆，规律段必须存活（否则人手看到的会消失）。
    setup.memory.syncDocument('200');
    text = fs.readFileSync(file, 'utf8');
    assert.match(text, /## 规律/);
    assert.match(text, /提到猫他会主动接话/);
  });

  await test('反思失败不影响主流程：记状态、不抛、24 小时内不再打上游', async () => {
    const setup = makeReflector({ reply: new Error('upstream down') });
    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, false);
    assert.equal(out.reason, 'failed');
    assert.ok(out.cause);
    assert.equal(setup.stats.memoryReflectFailed, 1);
    assert.ok(setup.stats.lastMemoryReflect?.cause);
    assert.equal(fs.readFileSync(setup.memory.pathFor('200'), 'utf8').includes(RULES_HEADING), false);

    const again = await setup.reflector.reflectSubject('user:200');
    assert.equal(again.reason, 'not-due');
    assert.equal(setup.llm.calls, 1, '失败也占用 24 小时窗口，避免重试风暴');
  });

  await test('频率限制：同一个人 24 小时内只反思一次', async () => {
    const reply = JSON.stringify({ rules: [
      { rule: '深夜才愿意聊技术', supports: ['topic.0', 'topic.1'], confidence: 0.6 },
    ] });
    const setup = makeReflector({ reply });
    const now = Date.now();
    assert.equal((await setup.reflector.reflectSubject('user:200', { now })).ran, true);
    const second = await setup.reflector.reflectSubject('user:200', { now: now + 60_000 });
    assert.equal(second.reason, 'not-due');
    assert.equal(setup.llm.calls, 1);
    // 过了周期就允许再跑。
    const third = await setup.reflector.reflectSubject('user:200', { now: now + 25 * 60 * 60 * 1000 });
    assert.equal(third.ran, true);
    assert.equal(setup.llm.calls, 2);
  });

  await test('主源是 agent-memory：FactStore 为空也能触发，supports 用记事 key 能过校验', async () => {
    const reply = JSON.stringify({ rules: [
      { rule: '提到猫他会主动接话', supports: ['note.0', 'note.1'], confidence: 0.7 },
    ] });
    const setup = makeReflector({ reply, store: fakeStore(), count: 0, agentCount: 8 });
    // 前提：提炼事实一条都没有，记忆全在 SQLite 里。
    assert.equal(setup.memory.activeFacts('user:200').length, 0);
    assert.equal(setup.reflector.due('user:200').due, true, '门槛要按合并后的条数算');

    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, true);
    assert.equal(out.rules, 1);
    assert.equal(setup.llm.calls, 1);
    assert.deepEqual(setup.stats.lastMemoryReflect.inputs, { agent: 8, facts: 0 });

    const text = fs.readFileSync(setup.memory.pathFor('200'), 'utf8');
    assert.match(text, /## 规律/);
    assert.ok(text.includes('支撑：note.0、note.1'), 'support 引用记事本 slot 必须保留下来');
  });

  await test('两源合并计数达到门槛（各自单独都不够）', async () => {
    const reply = JSON.stringify({ rules: [
      { rule: '深夜才愿意聊技术', supports: ['note.0', 'topic.0'], confidence: 0.6 },
    ] });
    const setup = makeReflector({ reply, store: fakeStore(), count: 4, agentCount: 4 });
    assert.equal(setup.memory.activeFacts('user:200').length, 4);
    assert.equal(setup.reflector.due('user:200').facts, 8, '合并后 8 条才够门槛');

    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, true);
    assert.deepEqual(setup.stats.lastMemoryReflect.inputs, { agent: 4, facts: 4 });
    assert.ok(fs.readFileSync(setup.memory.pathFor('200'), 'utf8').includes('深夜才愿意聊技术'));
  });

  await test('合并后仍低于门槛就不跑：记事 5 条 + 事实 2 条 = 7', async () => {
    const setup = makeReflector({ store: fakeStore(), count: 2, agentCount: 5 });
    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, false);
    assert.equal(out.reason, 'too-few-facts');
    assert.equal(out.facts, 7);
    assert.equal(setup.llm.calls, 0);
  });

  await test('版本因子：改写得越多的记事排得越前，v1 不被扣分', async () => {
    const now = 1_700_000_000_000;
    const merged = mergeCandidates({
      agent: [
        { slot: 'a', text: '只写过一次', version: 1, updated_at: now },
        { slot: 'b', text: '改写过两次', version: 3, updated_at: now },
      ],
      facts: [{ key: 'c', fact: '提炼事实', confidence: 0.5, confirmations: 1, lastSeen: now }],
    });
    assert.deepEqual(rankFacts(merged, { now }).map((r) => r.key), ['b', 'a', 'c']);
    // 同一个 key 两源都有时只留一条（先排序再去重）。
    const duplicated = mergeCandidates({
      agent: [{ slot: 'dup', text: '记事版本', version: 2, updated_at: now }],
      facts: [{ key: 'dup', fact: '事实版本', confidence: 0.5, confirmations: 1, lastSeen: now }],
    });
    const picked = rankFacts(duplicated, { now });
    assert.equal(picked.length, 1);
    assert.equal(picked[0].source, 'agent');
  });

  await test('事实太少不反思：门槛按合并条数算，不是只看 FactStore', async () => {
    const setup = makeReflector({ count: 5, over: { memoryReflectMinFacts: 8 } });
    const out = await setup.reflector.reflectSubject('user:200');
    assert.equal(out.ran, false);
    assert.equal(out.reason, 'too-few-facts');
    assert.equal(setup.llm.calls, 0);
  });

  await test('重载后不立刻重跑：上次运行时间在库里', async () => {
    const store = fakeStore();
    const reply = JSON.stringify({ rules: [
      { rule: '群里人少才开玩笑', supports: ['topic.0', 'topic.1'], confidence: 0.7 },
    ] });
    const setup = makeReflector({ reply, store });
    const now = Date.now();
    assert.equal((await setup.reflector.reflectSubject('user:200', { now })).ran, true);
    assert.ok(store.getState(MEMORY_REFLECT_STATE_KEY)?.includes('user:200'));

    // 模拟进程重载：同一个库、同一个记忆目录，新的反思器实例。
    const reloaded = new MemoryReflector(setup.ctx, setup.config, setup.memory, {}, store);
    assert.equal(reloaded.lastRun('user:200'), now);
    const out = await reloaded.reflectSubject('user:200', { now: now + 1000 });
    assert.equal(out.reason, 'not-due');
    assert.equal(setup.llm.calls, 1);
  });

  await test('一次扫描只处理一个人，群本不作为反思对象', async () => {
    const store = fakeStore();
    const dir = dirFor('scan');
    const reply = JSON.stringify({ rules: [
      { rule: '提到球赛会主动接话', supports: ['topic.0', 'topic.1'], confidence: 0.7 },
    ] });
    const a = makeReflector({ reply, store, dir, qq: '200' });
    seed(a.memory, '201', 10);
    a.memory.facts.commit({ subject: 'group:10', key: 'group.a', fact: '这个群凌晨最热闹',
      source: source(99) });

    const results = await a.reflector.reflectAll();
    assert.equal(results.length, 1, '默认每次扫描只反思一个人');
    assert.equal(results[0].ran, true);
    assert.equal(a.llm.calls, 1);
    assert.ok(a.reflector.subjects().includes('user:201'));
    assert.ok(!a.reflector.subjects().includes('group:10'));
    assert.equal(a.reflector.due('group:10').due, false);
  });
} finally {
  for (const store of stores) { try { store.db.close(); } catch { /* 已关闭 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  console.log(`\nmemory-reflect: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
