import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SubagentResults } from '../lib/application/subagent-results.mjs';

let passed = 0, failed = 0;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
};
const decode = row => row && { ...row, data: JSON.parse(row.data) };
const now = () => Date.now();

function make() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE runtime_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE bridge_workers(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,task_id TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE bridge_executions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,conversation TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,turn_id TEXT,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE bridge_task_entities(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,conversation TEXT NOT NULL,owner TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);
  const store = {
    available: true, db,
    getState: key => db.prepare('SELECT value FROM runtime_state WHERE key=?').get(key)?.value ?? null,
    setState: (key, value) => {
      db.prepare(`INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(value), now());
      return true;
    },
  };
  const parentData = JSON.stringify({ event: { message_id: 'm1', user_id: 1056612947 }, inputEvents: [{ message_id: 'm1' }] });
  db.prepare('INSERT INTO bridge_task_entities VALUES (?,?,?,?,?,?,?,?,?)')
    .run('task-1', 'topic-1', 'group:1', '1056612947', 'running', 2, '{}', now(), now());
  db.prepare('INSERT INTO bridge_executions VALUES (?,?,?,?,?,?,?,?,?)')
    .run('execution-parent', 'task-1', 'group:1', '1056612947', 'following', null, parentData, now(), now());
  store.setState('qq-bridge:execution-source:ref-1', JSON.stringify({ sourceRef: 'ref-1', conversation: 'group:1',
    taskId: 'task-1', executionId: 'execution-parent', taskVersion: 2, state: 'active', expiresAt: now() + 600000 }));
  store.setState('qq-bridge:execution-session:session-parent', 'ref-1');

  const agents = {};
  const state = {
    enabled: true, disposed: false,
    taskRouting: {
      get: id => id === 'task-1' ? { id: 'task-1', state: 'running', version: 2, owner: '1056612947' } : null,
      execution: id => decode(db.prepare('SELECT * FROM bridge_executions WHERE id=?').get(id)),
    },
    sourceLedger: { resolve: ref => ref === 'ref-1' ? { ref: 'ref-1', conversation: 'group:1' } : null },
    taskScheduler: { pumps: 0, pump() { this.pumps++; } },
  };
  const ctx = { get: name => name === 'agents' ? { get: id => agents[id] } : undefined };
  const service = new SubagentResults({ ctx, config: {}, registry: {}, state, store, stats: {} });
  return { service, store, state, agents, db };
}

const childSession = { id: 'session-child', header: { parentSession: 'session-parent', title: '写围棋AI' } };
const event = (type, text) => ({ type, data: text ? { message: { content: [{ type: 'text', text }] } } : {} });

await test('a child session of a QQ turn is registered and inherits the parent source', () => {
  const r = make();
  r.agents['session-child'] = { id: 'session-child', status: 'running' };
  r.service.bind({ session: childSession });
  const row = decode(r.db.prepare("SELECT * FROM bridge_workers WHERE id='worker-session-child'").get());
  assert.equal(row.state, 'running');
  assert.equal(row.conversation, 'group:1');
  assert.equal(row.task_id, 'task-1');
  assert.equal(row.data.parentSessionId, 'session-parent');
  assert.equal(r.store.getState('qq-bridge:execution-session:session-child'), 'ref-1');
  // 重复 bind 不会写第二行，也不会重置成果
  r.service.bind({ session: childSession });
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM bridge_workers').get().n, 1);
});

await test('a child of a session outside any QQ turn is ignored', () => {
  const r = make();
  r.service.bind({ session: { id: 'session-gui-child', header: { parentSession: 'session-gui' } } });
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM bridge_workers').get().n, 0);
  r.service.bind({ session: { id: 'session-root' } });
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM bridge_workers').get().n, 0);
});

await test('the child result becomes one completion execution for the parent turn', async () => {
  const r = make();
  r.agents['session-child'] = { id: 'session-child', status: 'running' };
  r.service.bind({ session: childSession });
  r.service.onEvent(childSession, event('turn/start'));
  r.service.onEvent(childSession, event('assistant/message', '棋盘和规则都好了，文件在 go-ai.html'));
  r.service.onEvent(childSession, event('turn/end'));
  r.agents['session-child'].status = 'idle';
  r.service.settle('session-child');

  const row = decode(r.db.prepare("SELECT * FROM bridge_workers WHERE id='worker-session-child'").get());
  assert.equal(row.state, 'completed');
  assert.match(row.data.result, /go-ai\.html/);
  assert.equal(row.data.completionExecutionId, 'execution-worker-session-child');
  const completion = decode(r.db.prepare("SELECT * FROM bridge_executions WHERE id='execution-worker-session-child'").get());
  assert.equal(completion.state, 'queued');
  assert.equal(completion.task_id, 'task-1');
  assert.equal(completion.conversation, 'group:1');
  assert.equal(completion.data.delegatedResult.jobId, 'worker-session-child');
  assert.match(completion.data.delegatedResult.result, /go-ai\.html/);
  assert.equal(completion.data.event.__delegateResult, 'worker-session-child');
  await flush();
  assert.equal(r.state.taskScheduler.pumps, 1);

  // 同一个子代理只交回一次
  r.service.settle('session-child');
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM bridge_executions').get().n, 2);
  assert.equal(r.state.taskScheduler.pumps, 1);
});

await test('a child that is still running is not settled early, and an empty result is reported as failed', () => {
  const r = make();
  r.agents['session-child'] = { id: 'session-child', status: 'running' };
  r.service.bind({ session: childSession });
  r.service.settle('session-child');
  assert.equal(decode(r.db.prepare("SELECT * FROM bridge_workers WHERE id='worker-session-child'").get()).state, 'running');

  r.agents['session-child'].status = 'idle';
  r.service.settle('session-child');
  assert.equal(decode(r.db.prepare("SELECT * FROM bridge_workers WHERE id='worker-session-child'").get()).state, 'failed');
  r.service.dispose();
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
