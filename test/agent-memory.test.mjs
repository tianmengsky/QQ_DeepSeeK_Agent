import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore, resolveMemoryDir } from '../lib/memory/memory-store.mjs';
import { memoryTool } from '../lib/memory/tool.mjs';
import { compactPersonMemory } from '../lib/memory/presentation.mjs';
import { buildMemoryInjection, buildPrompt } from '../lib/prompt/render.mjs';
import { config, message } from './helpers/bridge.mjs';
import { publishExecutionSource, closeExecutionSource, publishTurnSession } from '../lib/agent/execution-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
let passed = 0, failed = 0, sequence = 0;
const stores = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function rig() {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10'], privateEnabled: true, users: ['200'], memoryInjectMaxChars: 1600 });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const origin = memory.episodes.origin('group:10', { qq: '200', who: '甲', messageId: '1',
    text: '请记住我十月到十二月在实习。我不吃香菜。忘记我的偏好。恢复旧版本。', at: Date.now() });
  const registry = { byKey: new Map([['group:10', { sessionId: 'session-a' }]]) };
  const state = { enabled: true, disposed: false, sourceLedger: memory.episodes };
  const tool = memoryTool({ memory, registry, store, config: cfg, state });
  publishTurnSession(store, 'session-a', { conversation: 'group:10', sourceRef: origin });
  const call = (args, session = 'session-a') => tool.execute(args,
    { agent: { session: { id: session } }, signal: new AbortController().signal });
  const write = (args = {}) => call({ action: 'upsert', slot: 'profile.internship', version: 0,
    kind: 'explicit', text: '在实习', period: '十月到十二月', evidence: '十月到十二月在实习', ...args });
  return { store, cfg, memory, call, write, state, origin };
}
try {
  await test('explicit memory saves period, acknowledges commit and survives reopening', () => {
    const r = rig(), receipt = r.write(); assert.equal(receipt.status, 'SAVED');
    const reopened = new MemoryStore({ logger: { warn() {} } }, r.cfg, r.store);
    assert.match(reopened.read('200'), /明确记忆.*十月到十二月/);
    assert.equal(r.call({ action: 'read' }).records[0].version, 1);
  });
  await test('replay is idempotent and stale concurrent revision cannot overwrite', () => {
    const r = rig(); r.write(); assert.equal(r.write().replay, true);
    r.write({ version: 1, text: '实习期已确认' });
    assert.throws(() => r.write({ version: 1, text: '过时写入' }), /版本已变化/);
    assert.equal(r.memory.agent.history('200', 'profile.internship').length, 2);
  });
  await test('background same-slot update does not overwrite or resurrect forgotten main memory', () => {
    const r = rig(); r.write({ slot: 'preference.coriander', kind: 'profile', text: '不吃香菜', period: '', evidence: '不吃香菜' });
    r.memory.facts.commit({ subject: 'user:200', key: 'preference.coriander', fact: '吃香菜',
      source: { conversation: 'group:10', messageId: '2' } });
    assert.doesNotMatch(r.memory.read('200'), /- 吃香菜/);
    assert.equal(r.call({ action: 'forget', slot: 'preference.coriander', version: 1, evidence: '忘记我的偏好' }).status, 'FORGOTTEN');
    assert.doesNotMatch(r.memory.read('200'), /不吃香菜|\n- 吃香菜/);
  });
  await test('subjective impressions are labeled; old version can be restored as a new version', () => {
    const r = rig(); r.write({ kind: 'impression', text: '我感觉他很重视记忆是否准确' });
    assert.match(r.memory.read('200'), /主观印象，可修订/);
    r.write({ version: 1, kind: 'impression', text: '新的印象' });
    r.call({ action: 'restore', slot: 'profile.internship', version: 2, restore_version: 1, evidence: '恢复旧版本' });
    assert.equal(r.memory.agent.latest('200')[0].version, 3);
    assert.match(r.memory.read('200'), /很重视记忆/);
  });
  await test('another Session, fabricated evidence, disabled hosting and revoked source cannot write', () => {
    const r = rig(); assert.throws(() => r.call({ action: 'read' }, 'session-other'), /来源无效|当前 Session/);
    assert.throws(() => r.write({ evidence: '我今年毕业' }), /真实原文/);
    r.state.enabled = false; assert.throws(() => r.write(), /不可用|关闭/); r.state.enabled = true;
    r.memory.episodes.retract('group:10', '1'); assert.throws(() => r.write(), /来源无效/);
    assert.equal(r.memory.agent.latest('200').length, 0);
  });
  await test('withdrawn source removes visible main memory without reviving superseded facts', () => {
    const r = rig(); r.write(); r.memory.facts.retract('group:10', '1');
    assert.doesNotMatch(r.memory.read('200'), /在实习/);
  });
  await test('task Session owns its source and a closed execution cannot read or write memories', () => {
    const r = rig();
    r.store.db.exec('CREATE TABLE bridge_task_entities (id TEXT,state TEXT,version INTEGER,conversation TEXT)');
    r.store.db.prepare('INSERT INTO bridge_task_entities VALUES (?,?,?,?)').run('task-1', 'running', 1, 'group:10');
    publishExecutionSource(r.store, r.origin, { sessionId: 'task-session', taskId: 'task-1', taskVersion: 1,
      conversation: 'group:10', expiresAt: Date.now() + 60000 });
    assert.throws(() => r.call({ action: 'read' }), /当前 Session/);
    assert.equal(r.call({ action: 'read' }, 'task-session').status, 'READ');
    closeExecutionSource(r.store, r.origin);
    assert.throws(() => r.call({ action: 'read' }, 'task-session'), /来源无效|关闭|过期/);
  });
  await test('SQLite failure reports failure instead of claiming saved', () => {
    const r = rig(); r.store.db.exec(`CREATE TRIGGER fail_agent_memory BEFORE INSERT ON bridge_agent_memories
      BEGIN SELECT RAISE(ABORT,'disk write failed'); END;`);
    assert.throws(() => r.write(), /disk write failed/);
    assert.equal(r.memory.agent.latest('200').length, 0);
  });
  await test('Markdown projection failure still returns committed receipt and recovers on next read', () => {
    const r = rig(), sync = r.memory.syncDocument;
    r.memory.syncDocument = () => { throw new Error('projection unavailable'); };
    assert.equal(r.write().documentPending, true); r.memory.syncDocument = sync;
    assert.match(r.memory.read('200'), /十月到十二月/);
  });
  await test('long new-format documents retain explicit periods and manual profile instead of archive tail', () => {
    const doc = '# 甲\n## 主模型记忆\n- [明确记忆] 实习（时期：十月到十二月）\n## 手工记忆\n- 名字是小甲\n## 自动记忆（桥接维护）\n' +
      Array.from({ length: 30 }, (_, i) => '- 自动资料' + i + '很长的来源注释'.repeat(6)).join('\n') + '\n## 早期（已摘要）\n' + '- 早期闲聊\n'.repeat(40);
    const rendered = compactPersonMemory(doc, 350);
    assert.match(rendered, /十月到十二月/); assert.match(rendered, /名字是小甲/); assert.ok(rendered.length <= 350);
  });
  await test('question-specific recall updates fingerprint even when saved document has not changed', () => {
    const r = rig(); r.memory.append('200', '甲', '旧资料'.repeat(400));
    for (let i = 0; i < 25; i++) r.memory.append('200', '甲', `资料${i} ` + '常见内容'.repeat(20));
    const entry = { staticDone: false, memoryHashes: {} };
    const a = buildMemoryInjection(r.cfg, message(2, '资料1'), entry, r.memory);
    entry.staticDone = true; entry.memoryHashes = a.hashes;
    const b = buildMemoryInjection(r.cfg, message(3, '资料2'), entry, r.memory);
    assert.ok(b.text.includes('资料2'));
  });
  await test('prompt gives primary agent responsibility and demands success receipt before confirmation', () => {
    const p = buildPrompt(message(1), config({ memoryEnabled: true }), { includeStatic: true });
    assert.match(p, /qq_memory/); assert.match(p, /SAVED 回执才支持/); assert.match(p, /impression/);
    assert.doesNotMatch(p, /正常聊天即可/);
  });
  await test('memory directory follows stateDir when left empty', () => {
    const data = path.join(root, 'state');
    assert.equal(resolveMemoryDir({ memoryDir: '' }, data), path.join(data, 'memory'));
    assert.equal(resolveMemoryDir({ memoryDir: '   ' }, data), path.join(data, 'memory'));
    assert.equal(resolveMemoryDir({}, data), path.join(data, 'memory'));
    const explicit = path.join(root, 'explicit-memory');
    assert.equal(resolveMemoryDir({ memoryDir: explicit }, data), explicit, '显式配置必须优先');
  });
} finally { for (const s of stores) s.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
