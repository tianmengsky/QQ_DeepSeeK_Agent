import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceAction, readWorkspaceFile, workspaceDirectory, snapshotFile } from '../lib/agent/workspace.mjs';
import { ensureSession, sessionSignature } from '../lib/conversation/sessions.mjs';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e); }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-workspace-test-'));
const run = (args, conv = 'group:111') => workspaceAction(root, conv, args);
await test('UTF-8 source survives read/write and group/private isolation', () => {
  run({ action: 'write', path: 'game/index.html', content: '<h1>小游戏</h1>' });
  assert.equal(run({ action: 'read', path: 'game/index.html' }), '<h1>小游戏</h1>');
  assert.equal(run({ action: 'list' })[0].path, 'game/index.html');
  assert.deepEqual(run({ action: 'list' }, 'user:111'), []);
  assert.throws(() => run({ action: 'read', path: 'game/index.html' }, 'group:222'));
});
await test('reject traversal, absolute paths, ADS, devices and malformed conversation', () => {
  for (const p of ['../outside', '/tmp/x', 'D:\\x', '..\\x', 'game/a:secret', 'CON.txt', 'a/../b', 'a.'])
    assert.throws(() => run({ action: 'write', path: p, content: 'x' }));
  assert.throws(() => run({ action: 'list' }, 'group:../x'));
});
await test('junction, symbolic link and hard link cannot expose external files', () => {
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  const base = workspaceDirectory(root, 'group:111');
  fs.symlinkSync(outside, path.join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => run({ action: 'read', path: 'linked/secret.txt' }));
  assert.throws(() => run({ action: 'write', path: 'linked/new.txt', content: 'bad' }));
  fs.unlinkSync(path.join(base, 'linked'));
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(base, 'hard.txt'));
  assert.throws(() => run({ action: 'read', path: 'hard.txt' }));
  assert.throws(() => run({ action: 'write', path: 'hard.txt', content: 'bad' }));
  fs.unlinkSync(path.join(base, 'hard.txt'));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
});
await test('write rejects oversized text and limits total file count', () => {
  assert.throws(() => run({ action: 'write', path: 'big', content: 'x'.repeat(1048577) }));
  const base = workspaceDirectory(root, 'user:333');
  run({ action: 'list' }, 'user:333');
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(base, i + '.txt'), '');
  assert.throws(() => run({ action: 'write', path: 'extra', content: 'x' }, 'user:333'));
  assert.doesNotThrow(() => run({ action: 'write', path: '0.txt', content: 'update' }, 'user:333'));
});
await test('ZIP has portable relative names and independently extracts Chinese content', () => {
  run({ action: 'write', path: 'game/说明.txt', content: '打开 index.html 即可玩' });
  run({ action: 'pack', path: 'game', output: 'game.zip' });
  const zip = path.join(workspaceDirectory(root, 'group:111'), 'game.zip');
  // Windows ships tar (libarchive), an independent ZIP reader.
  const result = spawnSync('tar', ['-xOf', zip, '说明.txt'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '打开 index.html 即可玩');
  assert.throws(() => run({ action: 'pack', output: '../escape.zip' }));
});
await test('outgoing snapshot freezes bytes even if source is edited', () => {
  const old = readWorkspaceFile(root, 'group:111', 'game/index.html');
  const full = snapshotFile(root, 'group:111', old);
  run({ action: 'write', path: 'game/index.html', content: 'new' });
  assert.deepEqual(fs.readFileSync(full), old);
  assert.equal(snapshotFile(root, 'group:111', old), full);
  assert.equal(run({ action: 'list' }).some((f) => f.path.includes('.outgoing')), false);
});
await test('new sessions and rotated sessions use isolated cwd and preserve files', async () => {
  const requests = [], entries = new Map();
  const registry = { config: { cwd: 'D:/private', workspaceRoot: root, rotateEveryTurns: 1 },
    entry(key) { if (!entries.has(key)) entries.set(key, { turns: 0 }); return entries.get(key); },
    persist() {}, ctx: { logger: { info() {} }, sessionController: {
      async create(req) { requests.push(req); return { sessionId: 's' + requests.length }; },
    } } };
  await ensureSession(registry, 'group:111');
  registry.entry('group:111').turns = 1;
  await ensureSession(registry, 'group:111');
  await ensureSession(registry, 'user:111');
  assert.equal(requests[0].cwd, requests[1].cwd);
  assert.notEqual(requests[0].cwd, requests[2].cwd);
  assert.equal(requests[0].cwd, workspaceDirectory(root, 'group:111'));
  assert.equal(run({ action: 'read', path: 'game/index.html' }), 'new');
  assert.notEqual(sessionSignature(registry.config), sessionSignature({ ...registry.config, workspaceRoot: root + '-new' }));
});
await test('legacy task files stay readable under the conversation while outgoing snapshots stay hidden', () => {
  const old='tasks/task-00000000-0000-0000-0000-000000000000';
  run({action:'write',path:old+'/result.txt',content:'old result'},'group:444');
  const dir=path.join(workspaceDirectory(root,'group:444'),old,'.outgoing');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'old.bin'),'snapshot');
  assert.deepEqual(run({action:'list'},'group:444').map((f)=>f.path),[old+'/result.txt']);
  assert.equal(run({action:'read',path:old+'/result.txt'},'group:444'),'old result');
  assert.throws(()=>run({action:'read',path:old+'/.outgoing/old.bin'},'group:444'));
  assert.throws(()=>run({action:'read',path:old+'/result.txt'},'user:444'));
});
fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
