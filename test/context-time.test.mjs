import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ConversationRegistry } from '../lib/conversation/registry.mjs';
import { contextMessage, recordContext, sortWindow, trimWindow } from '../lib/conversation/context.mjs';
import { refreshWindowFromQQHistory } from '../lib/conversation/history.mjs';
import { bindItems } from '../lib/delivery/reply-delivery.mjs';
import { buildWindowSection } from '../lib/prompt/render.mjs';

const config = { contextOthersMessages: 10, contextOwnMessages: 15, windowTurns: 10,
  heartbeatBufferSize: 20, awakeMs: 60000, selfIds: ['9'], contextFromQQHistory: true,
  contextHistoryCacheMs: 0, contextHistoryCount: 100, onebotHttp: 'http://fake.local' };
const ctx = { logger: { info() {}, warn() {} } };
const time = 1791646600000;
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('✓ ' + name); }
  catch (error) { failed++; console.error(name, error); }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-time-'));
  const store = new Store(path.join(dir, 'db.sqlite3'));
  const registry = new ConversationRegistry(ctx, config, store);
  return { dir, store, registry, entry: registry.entry('group:1') };
}
const originalFetch = globalThis.fetch;
function history(messages) {
  globalThis.fetch = async () => ({ ok: true, text: async () =>
    JSON.stringify({ status: 'ok', retcode: 0, data: { messages } }) });
}
function msg(id, at, bot = false) {
  return { message_id: id, message_seq: id, time: at / 1000,
    sender: { user_id: bot ? 9 : 1, nickname: bot ? '你' : '群友' },
    message: [{ type: 'text', data: { text: '消息' + id } }] };
}

await test('无时间条目不阻断已知时间排序；同秒保留 QQ 顺序，不按随机 ID 排序', () => {
  const sorted = sortWindow([{ messageId: '8', at: time + 2000 }, { messageId: 'unknown' },
    { messageId: '900', sourceSeq: 900, at: time }, { messageId: '2', sourceSeq: 2, at: time }]);
  assert.deepEqual(sorted.map(m => m.messageId), ['unknown', '900', '2', '8']);
});

await test('OneBot 秒和毫秒时间归一化，非法时间用接收时间', () => {
  assert.equal(contextMessage({ time: time / 1000 }).at, time);
  assert.equal(contextMessage({ time }).at, time);
  assert.equal(contextMessage({ time: -1 }).timeSource, 'received');
});

await test('群友 10 条和自己 15 条分别保留，最终按时间交错注入', () => {
  const window = [];
  for (let i = 0; i < 20; i++) window.push({ text: '群友' + i, bot: false, at: time + i * 2000 });
  for (let i = 0; i < 20; i++) window.push({ text: '自己' + i, bot: true, at: time + i * 2000 + 1000 });
  const entry = { window, contextTurn: 0 };
  trimWindow(config, entry);
  assert.equal(entry.window.filter(m => m.bot).length, 15);
  assert.equal(entry.window.filter(m => !m.bot).length, 10);
  assert.deepEqual(entry.window.slice(-4).map(m => m.text), ['群友18', '自己18', '群友19', '自己19']);
  const prompt = buildWindowSection(config, { window: [...entry.window].reverse() });
  assert.ok(prompt.indexOf('群友18') < prompt.indexOf('自己18'));
  assert.ok(prompt.indexOf('自己18') < prompt.indexOf('群友19'));
});

await test('历史真实时间覆盖污染时间，同秒按历史顺序，保留本地未回读消息', async () => {
  const registry = new ConversationRegistry(ctx, config);
  const entry = registry.entry('group:1');
  entry.window = [
    { messageId: '2', text: '保留本地正文', bot: true, at: time + 999999 },
    { messageId: '900', text: '群友', bot: false, at: time },
    { messageId: '3', text: '同秒群友', bot: false, at: time + 1000 },
    { messageId: 'poke', text: '戳', at: time + 500 },
  ];
  history([msg(900, time), msg(3, time + 1000), msg(2, time + 1000, true)]);
  await refreshWindowFromQQHistory(ctx, config, registry, entry, 'group:1', {});
  assert.deepEqual(entry.window.map(m => m.messageId), ['900', 'poke', '3', '2']);
  assert.equal(entry.window[3].at, time + 1000);
  assert.equal(entry.window[3].text, '保留本地正文');
  assert.equal(entry.window[3].timeSource, 'qq');
});

await test('重复条目更新可靠时间，且数据库旧值不覆盖 QQ 修正后的时间', () => {
  const { store, registry, entry, dir } = fixture();
  try {
    store.recordEvent({ conversation: 'group:1', kind: 'self_message',
      payload: { messageId: 'a', text: '自己' }, deliverable: false });
    recordContext(config, entry, { messageId: 'a', text: '自己', bot: true, at: time + 100000 });
    assert.equal(recordContext(config, entry, { messageId: 'a', at: time, timeSource: 'qq' }), false);
    registry.restoreConversation('group:1');
    assert.equal(entry.window[0].at, time);
    assert.equal(entry.window.length, 1);
  } finally { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('legacy 无 at 的自己消息使用 DB.createdAt 恢复；重载不改变时间', () => {
  const { store, registry, dir } = fixture();
  try {
    const e = store.recordEvent({ conversation: 'group:1', kind: 'self_message',
      payload: { messageId: 'a', text: '自己' }, deliverable: false });
    store.db.prepare('UPDATE events SET created_at=? WHERE id=?').run(time + 1000, e.id);
    store.setState('qq-bridge:conversation:group:1', JSON.stringify({ window: [
      { messageId: 'a', text: '自己', bot: true, at: Date.now() },
      { messageId: 'b', text: '群友', at: time + 2000 },
    ] }));
    const restored = new ConversationRegistry(ctx, config, store);
    restored.restoreConversation('group:1');
    assert.deepEqual(restored.entry('group:1').window.map(m => m.messageId), ['a', 'b']);
    assert.equal(restored.entry('group:1').window[0].at, time + 1000);
    restored.persist('group:1');
    const again = new ConversationRegistry(ctx, config, store);
    again.restoreConversation('group:1');
    assert.deepEqual(again.entry('group:1').window, restored.entry('group:1').window);
  } finally { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

await test('第一气泡回执立即进入窗口；第二气泡完成前到达的群友消息保持交错', async () => {
  const { store, registry, entry, dir } = fixture();
  try {
    const plan = { key: 'group:1', entry, store, bubbles: ['第一句', '第二句'], sticker: null,
      idemBase: 'turn', target: { group_id: 1 }, action: 'send_group_msg', canSend: () => true };
    const items = bindItems(config, plan, async req => ({ sent: true, status: 'SUCCEEDED',
      onebotId: req.idemKey, sentAt: req.idemKey.endsWith('b0') ? time : time + 2000 }));
    await items[0].run();
    assert.equal(entry.window[0].at, time);
    registry.record(entry, { messageId: 'human', text: '群友接话', at: time + 1000 });
    await items[1].run();
    assert.deepEqual(entry.window.map(m => m.text), ['第一句', '群友接话', '第二句']);
    assert.deepEqual(store.readEvents('group:1', { latest: true }).messages.map(m => m.payload.at), [time, time + 2000]);
    registry.persist('group:1');
    const restored = new ConversationRegistry(ctx, config, store);
    restored.restoreConversation('group:1');
    assert.deepEqual(restored.entry('group:1').window.map(m => m.text), ['第一句', '群友接话', '第二句']);
  } finally { store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

globalThis.fetch = originalFetch;
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
