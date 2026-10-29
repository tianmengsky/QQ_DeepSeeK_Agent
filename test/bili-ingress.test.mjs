import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendBiliIdempotent } from '../lib/delivery/outbox.mjs';
import { Store, STATUS } from '../lib/store.mjs';
import { normalizeBiliIngress } from '../lib/application/bili-ingress.mjs';
import { rig } from './helpers/bridge.mjs';
import { executionToolGuard } from '../lib/agent/execution-scope.mjs';
import { __test } from '../lib/index.js';

const accepted = normalizeBiliIngress({ source: 'dsh-bili-scroll', uid: '12345', messageId: 'm-1', text: 'hello' });
assert.equal(accepted.user_id, '12345');
assert.equal(accepted.message_type, 'private');
assert.equal(accepted.__bridgeSource, 'bili');
assert.equal(normalizeBiliIngress({ source: 'other', uid: '12345', messageId: 'm-1', text: 'hello' }), null);
assert.equal(normalizeBiliIngress({ source: 'dsh-bili-scroll', uid: 'not-a-uid', messageId: 'm-1', text: 'hello' }), null);
assert.equal(normalizeBiliIngress({ source: 'dsh-bili-scroll', uid: '12345', messageId: '', text: 'hello' }), null);

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-ingress-'));
const store = new Store(path.join(testDir, 'bridge.sqlite3'));
const r = rig({ privateEnabled: false, users: [], inputDebounceMs: 1500, inputShortDebounceMs: 3500, dedupeIncoming: true },
  '『看到了』『你发来我看看』', store);
const biliSends = [];
r.ctx.on('qq-bridge:send-bili-message', (payload) => {
  biliSends.push({ uid: payload.uid, message: payload.message, idemKey: payload.idemKey });
  payload.acknowledge({ sent: true, msgKey: 'bili-receipt-' + biliSends.length });
});
try {
  const payload = { source: 'dsh-bili-scroll', uid: '12345', messageId: 'm-1', text: '请帮我看一下这个视频' };
  let receipt = null;
  r.ctx.emit('qq-bridge:external-message', { ...payload, acknowledge: (value) => { receipt = value; } });
  assert.deepEqual(receipt, { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await r.drain();
  await r.sendQueue.flush();
  assert.equal(r.prompts.length, 1);
  assert.ok(r.registry.byKey.has('bili:12345'));
  assert.equal(r.stats.biliAccepted, 1);
  const prompt = __test.buildPrompt({ ...accepted, message: 'hello' }, r.config, { includeStatic: false, includeWindow: false });
  assert.match(prompt, /B站私信/);
  assert.match(prompt, /B站 UID 12345/);
  assert.match(prompt, /桥接层会自动将气泡发回当前 B站 UID/);
  assert.doesNotMatch(prompt, /QQ 12345/);
  assert.equal(r.calls.length, 0, 'B站 replies must not be sent through OneBot');
  assert.deepEqual(biliSends.map(({ uid, message }) => ({ uid, message })), [
    { uid: '12345', message: '看到了' }, { uid: '12345', message: '你发来我看看' },
  ]);
  assert.notEqual(biliSends[0].idemKey, biliSends[1].idemKey);
  assert.match(biliSends[0].idemKey, /^bili:12345#/);
  assert.equal(store.getReceipt(biliSends[0].idemKey).onebotId, 'bili-receipt-1');
    assert.equal(store.getReceipt(biliSends[1].idemKey).onebotId, 'bili-receipt-2');
  assert.ok(r.registry.entry('bili:12345').awakeUntil > Date.now(), 'B站回复成功后应开启唤醒窗口');


  const unknownSend = { idemKey: 'bili:12345#unknown', conversation: 'bili:12345',
    target: { receiver_uid: 12345 }, message: '可能发出但没回执', signal: undefined };
  let uncertainCalls = 0;
  const uncertainCtx = { emit: (_name, payload) => {
    uncertainCalls++;
    payload.acknowledge({ sent: false, unknown: true, error: '没有投递回执' });
  } };
  await assert.rejects(sendBiliIdempotent(uncertainCtx, r.config, store, unknownSend), /没有投递回执/);
  assert.equal(store.getReceipt(unknownSend.idemKey).status, STATUS.UNKNOWN);
  const held = await sendBiliIdempotent(uncertainCtx, r.config, store, unknownSend);
  assert.equal(held.held, true);
  assert.equal(uncertainCalls, 1, 'UNKNOWN receipts must not auto-retry');

  let duplicateReceipt = null;
  r.ctx.emit('qq-bridge:external-message', { ...payload, acknowledge: (value) => { duplicateReceipt = value; } });
  assert.deepEqual(duplicateReceipt, { accepted: false });
  await r.drain();
  assert.equal(r.prompts.length, 1);
  assert.equal(r.stats.duplicatesDropped, 1);

  await r.post({ post_type: 'message', message_type: 'private', self_id: 100, user_id: '54321',
    message_id: 'spoof', message: 'not trusted', __bridgeSource: 'bili' });
  assert.equal(r.registry.byKey.has('bili:54321'), false);

  const sessionStore = { available: true, getState: () => JSON.stringify({ conversation: 'bili:12345',
    sourceRef: 'bili-test', expiresAt: Date.now() + 60_000 }) };
  const session = { id: 'bili-session' };
  assert.match(executionToolGuard(sessionStore, {}, { name: 'qq_send_private_msg', agent: { session } }), /禁止直接调用外发工具/);
  assert.match(executionToolGuard(sessionStore, {}, { name: 'bili_send_message', agent: { session } }), /禁止直接调用外发工具/);
  assert.notEqual(executionToolGuard(sessionStore, {}, { name: 'bili_search', agent: { session } }),
    'B站私信会话禁止直接调用外发工具；普通回复由桥接层投递回原 UID');
} finally {
  await r.sendQueue.dispose();
  r.state.disposed = true;
  store.db.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}
console.log('1 passed, 0 failed');
