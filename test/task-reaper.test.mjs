/**
 * 开机收殓——"没人认领的回合"不能永远挂着。
 *
 * 钉的是行为：超过 12 小时的 running 改成 recovering（不能再说"还在做"），
 * 超过 7 天的 recovering 改成 failed（没有回执就不能算做完）；
 * 还在时限内的一个都不动；库不可用时不抛。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { TaskLedger } from '../lib/conversation/task-ledger.mjs';
import { reapAbandonedTasks } from '../lib/conversation/task-reaper.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reap-'));
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

function setup() {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3'));
  new TaskLedger(store);
  return store;
}

const HOUR = 3600000;
const now = new Date(2026, 10, 1, 9, 0).getTime();

function task(store, { id, state, ageHours }) {
  store.db.prepare(
    `INSERT INTO bridge_tasks (id, conversation, owner, title, state, meta, progress, progress_at, created_at, updated_at)
     VALUES (?, 'group:10', '200', '做点事', ?, '{}', '', 0, ?, ?)`,
  ).run(id, state, now - ageHours * HOUR, now - ageHours * HOUR);
}

try {
  await test('放了一天的 running 改成 recovering，且写明为什么', () => {
    const store = setup();
    task(store, { id: 't-old', state: 'running', ageHours: 24 });
    const report = reapAbandonedTasks({ store, config: {}, now });
    assert.equal(report.running, 1);
    const row = store.db.prepare('SELECT state, progress FROM bridge_tasks WHERE id = ?').get('t-old');
    assert.equal(row.state, 'recovering');
    assert.match(row.progress, /没有回执/u);
  });

  await test('刚起的 running 不动', () => {
    const store = setup();
    task(store, { id: 't-new', state: 'running', ageHours: 1 });
    const report = reapAbandonedTasks({ store, config: {}, now });
    assert.equal(report.running, 0);
    assert.equal(store.db.prepare('SELECT state FROM bridge_tasks WHERE id = ?').get('t-new').state, 'running');
  });

  await test('recovering 放太久收场为 failed，但不会删掉记录', () => {
    const store = setup();
    task(store, { id: 't-giveup', state: 'recovering', ageHours: 24 * 8 });
    const report = reapAbandonedTasks({ store, config: {}, now });
    assert.equal(report.recovering, 1);
    const row = store.db.prepare('SELECT state, progress FROM bridge_tasks WHERE id = ?').get('t-giveup');
    assert.equal(row.state, 'failed');
    assert.match(row.progress, /不能算做完/u);
  });

  await test('时限内的 recovering 不动（可能真的做了一半，还要核对）', () => {
    const store = setup();
    task(store, { id: 't-wait', state: 'recovering', ageHours: 2 });
    reapAbandonedTasks({ store, config: {}, now });
    assert.equal(store.db.prepare('SELECT state FROM bridge_tasks WHERE id = ?').get('t-wait').state, 'recovering');
  });

  await test('库不可用时不抛，只报跳过', () => {
    const report = reapAbandonedTasks({ store: { available: false }, config: {}, now });
    assert.equal(report.skipped, 'store-unavailable');
    assert.equal(report.running, 0);
  });
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不算失败 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
