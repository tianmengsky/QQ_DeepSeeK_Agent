/**
 * 开机对账：把"桥没开着那段时间"的群消息补回 `events`。
 *
 * 钉的是行为，不是文案：
 *   · 补进来的消息 `created_at` 必须是**它自己发生的时间** —— 否则补回来的日子全堆在今天，
 *     日结按天切分时又是一片空白（这是整套补账的地基）；
 *   · 重复对账不写第二遍，**已经实时收过的消息**也不写第二遍；
 *   · 只补群：私聊没有历史接口，那段空白要认；
 *   · 拉不到就记一笔，不抛 —— 补不上原料不该让插件看起来出错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { MemoryDiarist } from '../lib/memory/diary.mjs';
import { HistoryReconciler } from '../lib/memory/reconcile.mjs';
import { config } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-reconcile-'));
const stores = [];
const realFetch = globalThis.fetch;
let passed = 0;
let failed = 0;
let sequence = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`, error);
  }
}

/** 一条 QQ 历史里的群消息。`secondsAgo` 决定它属于哪一天。 */
function histMsg(uid, nick, text, secondsAgo = 30, id = null) {
  return {
    message_id: id ?? Math.floor(Math.random() * 1e9),
    time: Math.floor((Date.now() - secondsAgo * 1000) / 1000),
    sender: { user_id: uid, nickname: nick },
    message: [{ type: 'text', data: { text } }],
  };
}

/**
 * 假 OneBot：只认 `get_group_msg_history`。
 * `fail` 为真时抛错，用来钉"拉不到不抛"。
 */
function fakeOnebot(messages, { fail = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    let params = {};
    try { params = JSON.parse(init.body); } catch { /* 空 body */ }
    calls.push({ action, params });
    if (fail) throw new Error('connect ECONNREFUSED');
    const data = action === 'get_group_msg_history' ? { messages } : { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data }) };
  };
  return calls;
}

function setup({ settings = {} } = {}) {
  const dir = path.join(root, String(sequence++));
  fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3'));
  stores.push(store);
  const cfg = config({
    memoryEnabled: true,
    memoryDir: path.join(dir, 'memory'),
    groupEnabled: true,
    groups: ['10'],
    privateEnabled: true,
    users: ['200'],
    contextFromQQHistory: true,
    selfIds: ['100'],
    reconcileEnabled: true,
    ...settings,
  });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const ctx = { disposed: false, logger: { info() {}, warn() {} }, get: (n) => (n === 'llm' ? null : undefined) };
  const stats = {};
  const reconciler = new HistoryReconciler(ctx, cfg, store, stats);
  const rows = (conversation) =>
    store.db.prepare('SELECT * FROM events WHERE conversation = ? ORDER BY created_at').all(conversation);
  return { store, cfg, memory, ctx, stats, reconciler, rows };
}

try {
  await test('补进 events，created_at 用消息自己的时间', async () => {
    const s = setup();
    const at = Math.floor(Date.now() / 1000) - 3 * 86400;
    fakeOnebot([
      { message_id: 901, time: at, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '三天前的话' } }] },
      { message_id: 902, time: at + 60, sender: { user_id: 222, nickname: '乙' }, message: [{ type: 'text', data: { text: '第二句' } }] },
    ]);
    const result = await s.reconciler.tick();
    assert.equal(result.inserted, 2);
    const events = s.rows('group:10');
    assert.equal(events.length, 2);
    // 关键：不是"现在"，是三天前。否则日结按天切分时又读不到那一天。
    assert.equal(Number(events[0].created_at), at * 1000);
    const payload = JSON.parse(events[0].payload);
    assert.equal(payload.text, '三天前的话');
    assert.equal(payload.qq, '111');
  });

  await test('重复对账不写第二遍', async () => {
    const s = setup();
    fakeOnebot([histMsg(111, '甲', '同一句', 30, 5001)]);
    await s.reconciler.tick();
    const again = await s.reconciler.tick();
    assert.equal(again.inserted, 0);
    assert.equal(s.rows('group:10').length, 1);
  });

  await test('实时已经收过的消息不重复（同一把去重钥匙）', async () => {
    const s = setup();
    // 实时路径的钥匙是 `onebot:<self_id>:<message_id>`。
    s.store.recordEvent({
      conversation: 'group:10',
      dedupeKey: 'onebot:100:7001',
      kind: 'inbound',
      payload: { qq: '111', text: '实时收过的' },
      deliverable: false,
    });
    fakeOnebot([histMsg(111, '甲', '实时收过的', 30, 7001)]);
    const result = await s.reconciler.tick();
    assert.equal(result.inserted, 0);
    assert.equal(s.rows('group:10').length, 1);
  });

  await test('只补群：私聊不会去拉历史', async () => {
    const s = setup();
    const groups = s.reconciler.groups();
    assert.deepEqual(groups, ['group:10']);
    assert.ok(groups.every((c) => c.startsWith('group:')));
  });

  await test('拉不到就记一笔，不抛', async () => {
    const s = setup();
    fakeOnebot([], { fail: true });
    const result = await s.reconciler.tick();
    assert.equal(result.ran, true);
    assert.equal(result.inserted, 0);
    assert.equal(s.stats.reconcileFailures, 1);
  });

  await test('空历史什么都不做', async () => {
    const s = setup();
    fakeOnebot([]);
    const result = await s.reconciler.tick();
    assert.equal(result.inserted, 0);
    assert.equal(s.rows('group:10').length, 0);
  });

  await test('对账之后，日结能看见"那一天"', async () => {
    const s = setup();
    const at = Math.floor(Date.now() / 1000) - 10 * 3600;
    const day = new Date(at * 1000);
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    fakeOnebot([
      { message_id: 8001, time: at, sender: { user_id: 111, nickname: '甲' }, message: [{ type: 'text', data: { text: '离线期第一句' } }] },
      { message_id: 8002, time: at + 30, sender: { user_id: 222, nickname: '乙' }, message: [{ type: 'text', data: { text: '离线期第二句' } }] },
    ]);
    await s.reconciler.tick();
    // 没有对账之前这一天是空的；对账之后它出现了。
    const diarist = new MemoryDiarist(s.ctx, s.cfg, s.memory, s.stats, s.store);
    assert.ok(diarist.conversationsOn(dayKey).includes('group:10'));
  });

  await test('关掉开关就什么都不做', async () => {
    const s = setup({ settings: { reconcileEnabled: false } });
    fakeOnebot([histMsg(111, '甲', '不该被补', 30, 9001)]);
    const result = await s.reconciler.tick();
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(s.rows('group:10').length, 0);
  });
} finally {
  globalThis.fetch = realFetch;
  for (const store of stores) { try { store.close?.(); } catch { /* 关不掉就算了 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
