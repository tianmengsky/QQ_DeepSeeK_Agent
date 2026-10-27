import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ReplyJournal, replyJournal } from '../lib/delivery/reply-journal.mjs';
import { runTurn } from '../lib/agent/runner.mjs';
import { queueReply } from '../lib/delivery/reply-delivery.mjs';
import { recoverReplies } from '../lib/application/reply-recovery.mjs';
import { executeTurn } from '../lib/application/execute-turn.mjs';
import { rig, message, config } from './helpers/bridge.mjs';
import { ConversationSendQueue } from '../lib/delivery/send-queue.mjs';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-replies-'));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e.stack); }
}
let serial = 0;
const opened = [];
function setup() {
  const store = new Store(path.join(root, String(++serial) + '.sqlite3'));
  opened.push(store);
  const r = rig({ contextFromQQHistory: false, sendQuotaPerMinute: 100 }, '', store);
  r.state.replyJournal = replyJournal(store);
  return { ...r, cfg: r.config, store, journal: r.state.replyJournal };
}
const event = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data } });
function frames(requestId, text = '第一条\n\n第二条') {
  return [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { rpcId: requestId } }),
    event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text }] } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}
function meta(id = 1, over = {}) {
  return { sessionId: 'old-rotated-session', requestId: 'request-' + id, baseSeq: 0,
    event: message(id), speakerQq: '200', speakerName: '群友', turnId: 'group:10#m' + id,
    shape: null, ...over };
}
const logger = { info() {}, warn() {} };
function plan(r, id = 1, reply = '第一条\n\n第二条') {
  const m = meta(id), key = 'group:10';
  r.journal.begin(m.turnId, key, m);
  r.journal.output(m.turnId, { reply, spokeTexts: [] });
  return queueReply(r.ctx, r.cfg, r.sendQueue, {
    entry: r.registry.entry(key), stats: r.stats, key, reply, shape: null,
    target: { group_id: 10 }, isGroup: true, speakerQq: '200', speakerName: '群友',
    store: r.store, turnId: m.turnId, journal: r.journal, journalId: m.turnId,
    state: r.state, signal: r.state.controller.signal, canSend: () => r.state.enabled,
  });
}
async function recover(r) {
  await Promise.all(await recoverReplies(r.ctx, r.cfg, r.registry, r.state, null, r.stats,
    r.store, r.sendQueue));
  assert.equal(await r.sendQueue.flush(), true);
  await new Promise((resolve) => setImmediate(resolve));
}
try {
  await test('minute and hour quota retries never count as hard failures and preserve exact reset time', async () => {
    for (const windowMs of [60000, 3600000]) {
      const r = setup();
      r.cfg.sendQuotaPerMinute = windowMs === 60000 ? 1 : 0;
      r.cfg.sendQuotaPerHour = windowMs === 3600000 ? 1 : 0;
      r.store.consume('send:group:10', windowMs, 1);
      plan(r, 1, '不能丢');
      await r.sendQueue.flush(); await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 4; i++) {
        r.store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run('group:10#m1');
        await recover(r);
        const row = r.journal.get('group:10#m1');
        assert.equal(row.state, 'planned'); assert.equal(row.attempts, 0);
        assert.ok(Math.abs(row.retry_at - (Math.floor(Date.now() / windowMs) + 1) * windowMs) < 20);
      }
      assert.equal(r.calls.length, 0); assert.equal(r.store.getReceipt('group:10#m1#b0'), null);
      r.store.db.prepare("DELETE FROM usage WHERE bucket LIKE 'send:group:10:%'").run();
      r.store.db.prepare('UPDATE bridge_replies SET retry_at=0 WHERE id=?').run('group:10#m1');
      await recover(r);
      assert.equal(r.calls[0].payload.message, '不能丢'); assert.equal(r.journal.get('group:10#m1').state, 'done');
      r.store.db.close();
    }
  });
  await test('quota in a later bubble does not recount an earlier failed receipt after successful retry', async () => {
    const r = setup(); r.cfg.sendQuotaPerMinute = 1;
    r.sendQueue.dispose(); plan(r);
    await new Promise((resolve) => setImmediate(resolve));
    const id = 'group:10#m1#b0';
    r.store.beginSend({ idemKey: id, conversation: 'group:10', kind: 'send_group_msg',
      target: '{"group_id":10}', payload: { group_id: 10, message: '第一条' } });
    r.store.finishSend(id, 'FAILED', { detail: 'prior explicit refusal' });
    r.journal.error('group:10#m1', 'retry', { retryAt: 0 });
    r.sendQueue = new ConversationSendQueue(); await recover(r);
    const row = r.journal.get('group:10#m1');
    assert.equal(r.calls.length, 1); assert.equal(row.state, 'planned'); assert.equal(row.attempts, 0);
    assert.equal(r.store.getReceipt(id).status, 'SUCCEEDED');
    r.store.db.prepare("DELETE FROM usage WHERE bucket LIKE 'send:group:10:%'").run();
    r.journal.error(row.id, 'reset', { retryAt: 0 }); await recover(r);
    assert.deepEqual(r.calls.map(c => c.payload.message), ['第一条', '第二条']);
    r.store.db.close();
  });
  await test('recent exact quota misfailures restore, but UNKNOWN and actual failures remain untouched', async () => {
    const r = setup(); r.sendQueue.dispose();
    for (let i = 1; i <= 5; i++) {
      plan(r, i, '保存原回复' + i);
      const row = r.journal.get('group:10#m' + i);
      r.store.db.prepare("UPDATE bridge_replies SET state='failed',attempts=3,plan=?,detail=? WHERE id=?")
        .run(JSON.stringify({ ...row.plan, floorPolicy: { version: 0, originals: [row.meta.event], authors: ['200'] } }),
          i === 4 ? '已放弃投递（3 次明确失败）：retcode=100' : '已放弃投递（3 次明确失败）：发送配额已满：send:group:10（已用 1/1）', row.id);
      if ([2, 3].includes(i)) {
        const id = row.id + '#b0';
        r.store.beginSend({ idemKey: id, conversation: 'group:10', kind: 'send_group_msg', target: '10', payload: {} });
        r.store.finishSend(id, i === 2 ? 'UNKNOWN' : 'FAILED');
      }
      if (i === 5) r.store.db.prepare('UPDATE bridge_replies SET updated_at=? WHERE id=?')
        .run(Date.now() - 2 * 86400000, row.id);
    }
    await new Promise((resolve) => setImmediate(resolve));
    const repaired = new ReplyJournal(r.store);
    assert.deepEqual(repaired.quotaRepaired, ['group:10#m1']);
    assert.equal(repaired.get('group:10#m1').state, 'planned'); assert.equal(repaired.get('group:10#m1').attempts, 0);
    for (const i of [2,3,4,5]) assert.equal(repaired.get('group:10#m' + i).state, 'failed');
    r.store.db.close();
  });
  await test('mid-follow interruption restores exact rpcId from snapshot without re-prompting', async () => {
    const r = setup(), m = meta();
    let requestId, prompts = 0;
    r.ctx.sessionController.prompt = async (req) => { prompts++; requestId = req.requestId; };
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 }; throw new Error('connection lost');
    } });
    await assert.rejects(runTurn(r.ctx, r.cfg, r.registry, 'group:10', [], r.stats, {
      sessionId: m.sessionId,
      onBeforePrompt(identity) { r.journal.begin(m.turnId, 'group:10', { ...m, ...identity }); },
    }), /connection lost/);
    const records = frames(requestId);
    // A different turn's output before our rpc must not be claimed.
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 4, records, hasMore: false };
      throw new Error('snapshot already contains the completed owned turn');
    } });
    await recover(r);
    assert.equal(prompts, 1);
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['第一条', '第二条']);
    assert.equal(r.journal.get(m.turnId).state, 'done');
    r.store.db.close();
  });

  await test('output saved before hosting pause survives reopen with no DSH call', async () => {
    const r = setup();
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '保住这句' }] } });
      r.state.enabled = false;
      yield event(2, 'turn/end');
    } });
    await executeTurn(r.ctx, r.cfg, r.registry, r.state, null, r.stats, r.store,
      'group:10', message(1), { sendQueue: r.sendQueue });
    assert.equal(r.calls.length, 0);
    assert.equal(r.journal.get('group:10#m1').state, 'output');
    r.state.enabled = true;
    r.ctx.sessionController.follow = () => { throw Error('must use captured output'); };
    await recover(r);
    assert.equal(r.calls[0].payload.message, '保住这句');
    r.store.db.close();
  });

  await test('陈旧且未确认结果的回复不再迟发，直接收敛为终态', async () => {
    const r = setup(), m = meta();
    r.journal.begin(m.turnId, 'group:10', m); // state='following'，无 outcome
    r.store.db.prepare('UPDATE bridge_replies SET created_at=?, updated_at=? WHERE id=?')
      .run(Date.now() - 4 * 86400000, Date.now() - 4 * 86400000, m.turnId);
    // 即便 resume 能"成功"重建结果，也不得把 4 天前的回复发进群。
    let followed = 0;
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      followed++;
      yield { type: 'snapshot', cursor: 4, records: frames(m.requestId), hasMore: false };
    } });
    await recover(r);
    assert.equal(r.calls.length, 0, '不得向真实群迟发旧回复');
    assert.equal(followed, 0, '根本不该去重连一个早已结束的 turn');
    assert.equal(r.journal.get(m.turnId).state, 'failed');
    assert.equal(r.stats.staleRepliesDropped, 1);
    assert.match(r.journal.get(m.turnId).detail, /replyStaleDeliveryMaxAgeMs/);
    r.store.db.close();
  });

  await test('仍在等待发送配额窗口的 planned 行不受迟发护栏影响', async () => {
    const r = setup();
    r.cfg.sendQuotaPerMinute = 1;
    r.store.consume('send:group:10', 60000, 1);
    plan(r, 1, '等配额也要发');
    await r.sendQueue.flush(); await new Promise((resolve) => setImmediate(resolve));
    const row = r.journal.get('group:10#m1');
    assert.equal(row.state, 'planned');
    // 把它改老，模拟"配额窗口还没到、但行已不年轻"的合法等待
    r.store.db.prepare('UPDATE bridge_replies SET created_at=? WHERE id=?')
      .run(Date.now() - 4 * 86400000, row.id);
    r.store.db.prepare("DELETE FROM usage WHERE bucket LIKE 'send:group:10:%'").run();
    r.journal.error(row.id, 'reset', { retryAt: 0 });
    await recover(r);
    assert.equal(r.calls[0].payload.message, '等配额也要发');
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    r.store.db.close();
  });

  await test('crash before first send survives database reopen, including exact sticker plan', async () => {
    const r = setup();
    r.sendQueue.dispose();
    plan(r, 1, '文字\n\n[表情:1]');
    await new Promise((resolve) => setImmediate(resolve));
    r.store.db.close();
    const reopened = new Store(r.store.path);
    r.store = reopened; r.journal = replyJournal(reopened); r.state.replyJournal = r.journal;
    r.sendQueue = new ConversationSendQueue({ logger });
    await recover(r);
    assert.deepEqual(r.calls.map((c) => c.action), ['send_group_msg', 'fetch_custom_face', 'send_group_msg']);
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    r.sendQueue.dispose(); reopened.db.close();
  });

  await test('partial send reload skips confirmed bubble and resumes remaining bubble in order', async () => {
    const r = setup();
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const res = await original(...args);
      if (r.calls.length === 1) r.state.enabled = false;
      return res;
    };
    plan(r);
    await r.sendQueue.flush();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.calls.length, 1);
    r.state.enabled = true;
    r.journal.error('group:10#m1', 'resume', { retryAt: 0 });
    await recover(r);
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['第一条', '第二条']);
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    r.store.db.close();
  });

  await test('receipt committed before batch completion: replay neither resends nor refreshes speech', async () => {
    const r = setup();
    r.sendQueue.dispose(); plan(r);
    await new Promise((resolve) => setImmediate(resolve));
    const at = Date.now() - 90000;
    for (const [i, text] of ['第一条', '第二条'].entries()) {
      const id = 'group:10#m1#b' + i;
      r.store.beginSend({ idemKey: id, conversation: 'group:10', kind: 'send_group_msg',
        target: '{"group_id":10}', payload: { group_id: 10, message: text } });
      r.store.finishSend(id, 'SUCCEEDED', { onebotId: String(10 + i) });
      r.store.db.prepare('UPDATE outbox SET updated_at=? WHERE idem_key=?').run(at, id);
    }
    r.sendQueue = new ConversationSendQueue();
    const entry = r.registry.entry('group:10'), before = entry.awakeUntil;
    await recover(r);
    assert.equal(r.calls.length, 0);
    assert.equal(entry.awakeUntil, before);
    assert.ok(entry.window.every((x) => x.at === at));
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    r.store.db.close();
  });

  await test('UNKNOWN stops automatic resend and is persistently visible after reload', async () => {
    const r = setup();
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error('fetch failed'); };
    plan(r);
    await r.sendQueue.flush(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.journal.get('group:10#m1').state, 'attention');
    await recover(r); await recover(r);
    assert.equal(attempts, 1);
    assert.equal(r.journal.snapshot().counts.attention, 1);
    // Once reconciled, the confirmed first bubble is skipped and the rest can resume.
    r.store.finishSend('group:10#m1#b0', 'SUCCEEDED', { onebotId: '-123' });
    globalThis.fetch = async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 456 } }) });
    await recover(r);
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    assert.equal(r.state.ownMessageIds.has('-123'), true);
    r.store.db.close();
  });

  await test('UNKNOWN and orphaned EXECUTING isolate their own plan while new replies can send', async () => {
    for (const status of ['UNKNOWN', 'EXECUTING']) {
      const r = setup(); r.sendQueue.dispose(); plan(r, 1, '不确定的旧气泡\n\n旧尾部');
      await new Promise((resolve) => setImmediate(resolve));
      const id = 'group:10#m1#b0#noat';
      r.store.beginSend({ idemKey: id, conversation: 'group:10', kind: 'send_group_msg',
        target: '10', payload: { group_id: 10, message: '不确定的旧气泡' } });
      if (status === 'UNKNOWN') r.store.finishSend(id, status, { detail: 'lost receipt' });
      r.journal.error('group:10#m1', 'needs reconciliation', { attention: true });
      r.sendQueue = new ConversationSendQueue({ logger });
      assert.equal(r.journal.snapshot().pending[0].quarantined, true);
      plan(r, 2, '新的戳回复'); await r.sendQueue.flush(); await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(r.calls.map((c) => c.payload.message), ['新的戳回复'], status);
      await recover(r); await recover(r);
      assert.equal(r.journal.get('group:10#m1').state, 'attention');
      assert.equal(r.store.getReceipt(id).status, status); assert.equal(r.calls.length, 1);
      assert.equal(r.journal.get('group:10#m2').state, 'done');
      r.sendQueue.dispose(); r.store.db.close();
    }
  });

  await test('persisted newer plans recover past a quarantined receipt after database reopen', async () => {
    const r = setup(); r.sendQueue.dispose(); plan(r, 1, '未知的旧内容');
    await new Promise((resolve) => setImmediate(resolve));
    const id = 'group:10#m1#b0';
    r.store.beginSend({ idemKey: id, conversation: 'group:10', kind: 'send_group_msg',
      target: '10', payload: { group_id: 10, message: '未知的旧内容' } });
    r.store.finishSend(id, 'UNKNOWN', { detail: 'lost receipt' });
    r.journal.error('group:10#m1', 'lost receipt', { attention: true });
    plan(r, 2, '第二轮'); plan(r, 3, '第三轮'); await new Promise((resolve) => setImmediate(resolve));
    r.store.db.close(); r.store = new Store(r.store.path); opened.push(r.store);
    r.journal = replyJournal(r.store); r.state.replyJournal = r.journal;
    r.sendQueue = new ConversationSendQueue({ logger });
    await recover(r); await recover(r);
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['第二轮', '第三轮']);
    assert.equal(r.journal.get('group:10#m1').state, 'attention');
    assert.equal(r.store.getReceipt(id).status, 'UNKNOWN');
    r.store.finishSend(id, 'SUCCEEDED', { onebotId: 99 });
    await recover(r); assert.equal(r.calls.length, 2);
    assert.equal(r.journal.get('group:10#m1').state, 'done');
    r.sendQueue.dispose(); r.store.db.close();
  });

  await test('quota refusal preserves plan, retries after reset, and never lets later reply overtake', async () => {
    const r = setup();
    r.cfg.sendQuotaPerMinute = 1;
    r.store.consume('send:group:10', 60000, 1);
    plan(r, 1, '先来的');
    await r.sendQueue.flush(); await new Promise((resolve) => setImmediate(resolve));
    plan(r, 2, '后来的');
    await r.sendQueue.flush();
    assert.equal(r.calls.length, 0);
    const first = r.journal.get('group:10#m1');
    assert.equal(first.state, 'planned'); assert.ok(first.retry_at > Date.now());
    assert.equal(r.store.getReceipt('group:10#m1#b0'), null);
    r.store.db.prepare("DELETE FROM usage WHERE bucket LIKE 'send:group:10:%'").run();
    r.journal.error(first.id, 'reset', { retryAt: 0 });
    await recover(r);
    assert.equal(r.calls[0].payload.message, '先来的');
    r.store.db.prepare("DELETE FROM usage WHERE bucket LIKE 'send:group:10:%'").run();
    await recover(r);
    assert.equal(r.calls[1].payload.message, '后来的');
    r.store.db.close();
  });

  await test('多个无工具的最终正文片段完整保留，思考内容仍不投递', async () => {
    const r = setup();
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield event(1, 'turn/start', { turn: 1 });
      yield event(2, 'assistant/message', { turn: 1, message: {
        content: [{ type: 'reasoning', text: '不能转录思考' }, { type: 'text', text: '查一下' }] } });
      yield event(3, 'assistant/message', { turn: 1, message: {
        content: [{ type: 'text', text: '结果来了' }] } });
      yield event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    } });
    const out = await runTurn(r.ctx, r.cfg, r.registry, 'group:10', [], r.stats, { sessionId: 's' });
    assert.equal(out.reply, '查一下\n\n结果来了');
    r.store.db.close();
  });

  await test('真实 DSH 快照恢复只投递工具后的最终结果，不补发过程或重复成功进度', async () => {
    const r = setup(), m = meta(), at = Date.now() - 5000;
    const records = [
      event(1, 'turn/start', { turn: 1 }),
      event(2, 'user/message', { source: { rpcId: m.requestId } }),
      event(3, 'assistant/message', { turn: 1, step: 1, message: { content: [
        { type: 'text', text: '给我一会儿' }, { type: 'tool-call', id: 'start', name: 'qq_say' },
      ] } }),
      event(4, 'tool/call', { turn: 1, step: 1, callId: 'start', name: 'qq_say',
        arguments: { conversation: 'group:10', text: '我去写' } }),
      event(5, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'start',
        source: { kind: 'tool', callId: 'start' }, isError: false,
        content: [{ type: 'text', text: '已发送到群 10。message_id=901' }],
      } }),
      event(6, 'step/end', { turn: 1, step: 1 }),
      event(7, 'tool/call', { turn: 1, step: 2, callId: 'write', name: 'qq_workspace', arguments: {} }),
      event(8, 'tool/result', { turn: 1, step: 2, message: { toolCallId: 'write', content: [] } }),
      event(9, 'assistant/message', { turn: 1, step: 3, message: {
        content: [{ type: 'text', text: '我去写\n\n文件发了\n\n玩法说明' }] } }),
      event(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ];
    records[4].event.time = at;
    r.journal.begin(m.turnId, 'group:10', m);
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 10, records, hasMore: false };
    } });
    await recover(r);
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['文件发了', '玩法说明']);
    assert.equal(r.prompts.length, 0);
    const row = r.journal.get(m.turnId);
    assert.equal(row.state, 'done');
    assert.equal(row.outcome.replySelection, 'post-tool-final');
    assert.equal(row.outcome.intermediateTextParts, 1);
    assert.deepEqual(row.outcome.spokeTexts, ['我去写']);
    const progress = r.registry.entry('group:10').window.find((x) => x.messageId === '901');
    assert.equal(progress.at, at, '恢复沿用原发送时间');
    r.store.db.close();
  });

  await test('recovery paginates to saved baseline and isolates earlier and later rpc turns', async () => {
    const r = setup(), m = meta();
    const events = [
      event(1, 'turn/start', { turn: 10 }),
      event(2, 'user/message', { source: { rpcId: 'unrelated' } }),
      event(3, 'assistant/message', { turn: 10, message: { content: [{ type: 'text', text: '别人' }] } }),
      event(4, 'turn/end', { turn: 10, reason: { kind: 'completed' } }),
      ...frames(m.requestId, '我的').map((e) => ({ ...e, event: { ...e.event, seq: e.event.seq + 4,
        data: { ...e.event.data, ...(e.event.data.turn !== undefined ? { turn: 11 } : {}) } } })),
    ];
    let pages = 0;
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 8, records: events.slice(4), hasMore: true };
    } });
    r.ctx.sessionController.page = async (req) => {
      pages++; assert.equal(req.beforeSeq, 5); assert.equal(req.throughSeq, 8);
      return { records: events.slice(0, 4), hasMore: false };
    };
    const out = await runTurn(r.ctx, r.cfg, r.registry, 'group:10', [], r.stats,
      { sessionId: m.sessionId, resume: m });
    assert.equal(out.reply, '我的'); assert.equal(pages, 1);
    assert.equal(r.prompts.length, 0);
    r.store.db.close();
  });

  await test('recovery refuses history gaps rather than guessing the last text', async () => {
    const r = setup(), m = meta();
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 4, records: frames(m.requestId).slice(1), hasMore: false };
    } });
    await assert.rejects(runTurn(r.ctx, r.cfg, r.registry, 'group:10', [], r.stats,
      { sessionId: m.sessionId, resume: m }), /non-contiguous history/);
    assert.equal(r.calls.length, 0);
    r.store.db.close();
  });

  await test('two conversation recovery keeps saved targets and never shares response ownership', async () => {
    const r = setup();
    for (const group of [10, 20]) {
      const m = meta(group, { event: message(group, 'hello', group), turnId: 'group:' + group + '#m' + group });
      r.journal.begin(m.turnId, 'group:' + group, m);
      r.journal.output(m.turnId, { reply: '回给' + group, spokeTexts: [] });
    }
    await recover(r);
    assert.deepEqual(r.calls.map((c) => [c.payload.group_id, c.payload.message]),
      [[10, '回给10'], [20, '回给20']]);
    assert.ok(r.journal.pending().length === 0);
    r.store.db.close();
  });

  await test('actual Cordis disposal awaits dispatched receipt then reload sends only remaining bubble', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'lifecycle-'));
    const seed = new Store(path.join(dir, 'qq-bridge.sqlite3')), j = new ReplyJournal(seed), m = meta();
    j.begin(m.turnId, 'group:10', m); j.output(m.turnId, { reply: 'a\n\nb' });
    j.planned(m.turnId, { key: 'group:10', isGroup: true, target: { group_id: 10 },
      action: 'send_group_msg', idemBase: m.turnId, bubbles: ['a', 'b'], sticker: null,
      turnId: m.turnId, speakerQq: '200', speakerName: '群友' });
    seed.setState('agentEnabled', 'true'); seed.db.close();
    const ctx = new Context(), routes = new Map(), sent = [];
    ctx.provide('webServer', { register(route) {
      routes.set(route.path, route.handler); return () => routes.delete(route.path);
    } });
    ctx.provide('sessionController', { create() { throw Error('unexpected model submission'); } });
    let release, started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    const firstGate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (_url, init) => {
      /**
       * 自传刷新（get_login_info / get_group_list / get_friend_list）也走这个 HTTP 口，
       * 但它不是发送：既不该计入 sent，也不该触发 firstStarted。
       * 这条判断是 2026-10-22 加自传层之后必须的 —— 否则第一次"发送"其实是取昵称。
       */
      if (!/send_(?:group|private)_msg$/.test(String(_url)))
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: {} }) };
      sent.push(JSON.parse(init.body).message);
      if (sent.length === 1) { started(); await firstGate; }
      return { ok: true, status: 200, text: async () => JSON.stringify({
        status: 'ok', retcode: 0, data: { message_id: sent.length },
      }) };
    };
    const cfg = { ...config(), stateDir: dir, agentEnabled: true,
      persistenceEnabled: true, heartbeatEnabled: false, loginWatchEnabled: false };
    let fiber = ctx.plugin(plugin, cfg);
    await fiber; await firstStarted;
    let disposed = false;
    const disposing = fiber.dispose().then(() => { disposed = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposed, false, 'database must remain open for the in-flight receipt');
    release(); await disposing;
    const check = new Store(path.join(dir, 'qq-bridge.sqlite3'));
    assert.equal(check.getReceipt(m.turnId + '#b0').status, 'SUCCEEDED');
    assert.equal(check.getReceipt(m.turnId + '#b1'), null);
    check.db.close();
    fiber = ctx.plugin(plugin, cfg); await fiber;
    const deadline = Date.now() + 1500;
    while (sent.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(sent, ['a', 'b']);
    await fiber.dispose(); await ctx.fiber.dispose();
  });
} finally {
  for (const store of opened) { try { store.db.close(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
