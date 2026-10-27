import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRecoveryGuard } from '../lib/application/recovery-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';
import { TaskScheduler } from '../lib/application/task-scheduler.mjs';

let passed = 0;
function rig(action) {
  const state = { disposed: false }, stats = {}, warnings = [];
  const run = createRecoveryGuard({ state, stats, logger: { warn: m => warnings.push(m) } }, action);
  return { state, stats, warnings, run };
}

// A timer exception formerly reached DSH's uncaughtException handler and killed its host.
const moduleUrl = new URL('../lib/application/recovery-guard.mjs', import.meta.url).href;
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { createRecoveryGuard } from ${JSON.stringify(moduleUrl)};
  let logs = 0;
  const run = createRecoveryGuard({ state: {}, stats: {}, logger: { warn() { logs++; } } }, () => {
    throw Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 });
  });
  setTimeout(run, 0);
  setTimeout(() => { if (logs !== 1) process.exitCode = 1; }, 30);
`], { encoding: 'utf8', timeout: 10000 });
assert.equal(child.status, 0, child.stderr); passed++;

let calls = 0;
const corrupt = rig(() => {
  calls++;
  throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 });
});
await corrupt.run(); await corrupt.run();
assert.equal(calls, 1, 'do not repeatedly access damaged storage');
assert.equal(corrupt.warnings.length, 1);
assert.match(corrupt.stats.lastError, /database disk image is malformed/); passed++;

calls = 0;
const transient = rig(() => {
  calls++;
  if (calls === 1) throw Object.assign(new Error('database is locked'), { errcode: 5 });
});
await transient.run(); await transient.run();
assert.equal(calls, 2, 'temporary errors must not permanently disable recovery'); passed++;

// 2026-10-27：malformed 常常是瞬时的。带探针的守卫自检通过后必须自己接着跑，
// 否则"暂停"= 群里此后再无一条正文，而状态页看上去一切正常。
calls = 0;
const healable = (() => {
  const fired = [];
  const run = createRecoveryGuard({
    state: {}, stats: fired.stats = {}, logger: { warn: m => fired.push(m) },
    label: '投递恢复', retryMs: 0, probe: () => true,
  }, () => { calls++; throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 }); });
  return { run, stats: fired.stats, warnings: fired };
})();
await healable.run();
assert.equal(healable.stats.recovery['投递恢复'].paused, true, 'paused after damage');
await healable.run();
assert.equal(calls, 2, 'probe said the db is fine again, so recovery resumes');
assert.equal(healable.stats.recovery['投递恢复'].paused, true, 'the retry failed again, so it pauses again');
assert.equal(healable.stats.recovery['投递恢复'].resumed, 1); passed++;

calls = 0;
const stillBroken = createRecoveryGuard({
  state: {}, stats: {}, logger: { warn() {} }, retryMs: 0, probe: () => false,
}, () => { calls++; throw Object.assign(new Error('file is not a database'), { errcode: 26 }); });
await stillBroken(); await stillBroken(); await stillBroken();
assert.equal(calls, 1, 'a db that still fails the probe stays paused'); passed++;

const rejected = rig(async () => { throw new Error('async recovery failed'); });
await rejected.run();
assert.match(rejected.stats.lastError, /async recovery failed/); passed++;

const disposed = rig(() => { throw new Error('should not run after disposal'); });
disposed.state.disposed = true;
await disposed.run();
assert.equal(disposed.warnings.length, 0); passed++;

let reject;
const inFlight = rig(() => new Promise((_, fail) => { reject = fail; }));
const pending = inFlight.run();
inFlight.state.disposed = true;
reject(new Error('late rejection'));
await pending;
assert.equal(inFlight.warnings.length, 0); passed++;

// Exercise both actual bootstrap callbacks with an offline Cordis context.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-bootstrap-'));
const originalTick = TaskScheduler.prototype.tick;
const originalRestore = TaskScheduler.prototype.restore;
let fiber;
try {
  const invoked = [];
  for (const method of ['tick', 'restore']) TaskScheduler.prototype[method] = () => {
    invoked.push(method);
    throw Object.assign(new Error('database disk image is malformed'), { errcode: 11 });
  };
  const ctx = new Context();
  ctx.provide('webServer', { register() { return () => {}; } });
  ctx.provide('sessionController', { create() { throw new Error('unexpected agent call'); } });
  fiber = ctx.plugin(plugin, { stateDir: temporary, persistenceEnabled: true,
    memoryEnabled: false, heartbeatEnabled: false, loginWatchEnabled: false,
    agentEnabled: false, taskRoutingMode: 'enabled' });
  await fiber;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(invoked.includes('restore'), 'startup restore is contained');
  assert.ok(invoked.includes('tick'), 'delivery tick is contained');
  passed++;
} finally {
  if (fiber) await fiber.dispose();
  TaskScheduler.prototype.tick = originalTick;
  TaskScheduler.prototype.restore = originalRestore;
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log(`${passed} passed, 0 failed`);
