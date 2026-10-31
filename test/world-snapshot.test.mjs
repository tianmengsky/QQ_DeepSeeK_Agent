/**
 * 世界快照——"不在任何房间里"的那个视角。
 *
 * 钉的是行为：
 *   · 把各窗口的动静压成几行，安静多久、她最后一次说话是什么时候；
 *   · 带上她最近做过的事、此刻的心情、自己写下的想法；
 *   · 什么都没有时不凭空造热闹；超预算会截断（快照不能挤掉回合本身）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { writeMood } from '../lib/memory/mood.mjs';
import { buildWorldSnapshot } from '../lib/application/world-snapshot.mjs';
import { config } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-world-'));
const stores = [];
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

function setup({ settings = {} } = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10', '11'], privateEnabled: true, users: ['200'], ...settings });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const now = new Date(2026, 10, 1, 1, 30).getTime();
  return { store, cfg, memory, now };
}

const hoursAgo = (now, h) => now - h * 3600000;

try {
  await test('没有窗口时如实说没有，不凭空造热闹', () => {
    const s = setup();
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now });
    assert.match(text, /这是你自己的地方/u);
    assert.match(text, /这一周没有任何窗口在说话/u);
    assert.match(text, /没有人在等你回答/u);
    assert.doesNotMatch(text, /你最近自己做过的事/u);
  });

  await test('窗口按最近说话时间排序，并说明她有没有在那边说过话', () => {
    const s = setup();
    s.store.upsertConversation('group:10', { lastMessageAt: hoursAgo(s.now, 1), lastSpokeAt: hoursAgo(s.now, 5) });
    s.store.upsertConversation('group:11', { lastMessageAt: hoursAgo(s.now, 9) });
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now });
    const ten = text.indexOf('群 10：');
    const eleven = text.indexOf('群 11：');
    assert.ok(ten >= 0 && eleven >= 0, '两个窗口都该出现');
    assert.ok(ten < eleven, '最近说话的排前面');
    assert.match(text, /你最后一次说话是 5 小时前/u);
    assert.match(text, /你还没在那边说过话/u);
  });

  await test('带上她做过的事、心情与自己写下的想法', () => {
    const s = setup();
    s.store.upsertConversation('group:10', { lastMessageAt: hoursAgo(s.now, 1) });
    const id = s.store.recordProactive({ conversation: 'group:10', kind: 'speak', text: '在吗', idemKey: 'p1' });
    s.store.finishProactiveCheck(id, 'quiet');
    writeMood(s.store, { text: '有点闷，那个群后来没人接我的话。', source: 'test' });
    s.memory.agent.write({ subject: 'self', slot: 'me.stance.floor', version: 0, kind: 'stance',
      visibility: 'public', period: '2026-11-01', text: '被夸的时候先装没听懂。',
      sources: [{ conversation: 'self:seed', messageId: 'seed:me.stance.floor', qq: '', who: '', at: s.now }] });
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now });
    assert.match(text, /你最近自己做过的事/u);
    assert.match(text, /说了一句话（没人接）/u);
    assert.match(text, /你此刻的心情/u);
    assert.match(text, /被夸的时候先装没听懂/u);
  });

  await test('超预算截断：快照不能挤掉回合本身', () => {
    const s = setup();
    for (let i = 0; i < 8; i++) {
      s.store.upsertConversation('group:' + (100 + i), { lastMessageAt: hoursAgo(s.now, i + 1) });
    }
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now, maxChars: 260 });
    assert.ok(text.length <= 260, `快照应受预算约束，实际 ${text.length}`);
    assert.match(text, /…$/u);
  });
  await test('会话表那列是死的：从事件里回推"她最后一次说话"', () => {
    const s = setup();
    s.store.upsertConversation('group:10', { lastMessageAt: hoursAgo(s.now, 2) });
    // 真实库里 `conversations.last_spoke_at` 从来没被写过（永远是 0）；
    // 她说过的话在 events 里。快照必须回推到那一份，否则热重载后她会"忘了自己说过话"。
    const event = s.store.recordEvent({
      conversation: 'group:10',
      kind: 'self_message',
      payload: { messageId: 'self-1', text: '我在', at: hoursAgo(s.now, 3), timeSource: 'sent' },
      deliverable: false,
      createdAt: hoursAgo(s.now, 3),
    });
    assert.ok(event);
    assert.equal(s.store.lastSelfMessageAt('group:10'), hoursAgo(s.now, 3));
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now });
    assert.match(text, /你最后一次说话是 3 小时前/u);
    assert.doesNotMatch(text, /你还没在那边说过话/u);
  });

  await test('热重载不丢"她说过话"：会话条目里的时间优先于库里那列', () => {
    const s = setup();
    s.store.upsertConversation('group:10', { lastMessageAt: hoursAgo(s.now, 1) });
    const registry = { byKey: new Map([['group:10', { lastSpokeAt: hoursAgo(s.now, 5) }]]) };
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, registry, now: s.now });
    assert.match(text, /你最后一次说话是 5 小时前/u);
  });
  await test('放久了的欠账不悄悄消失：只写出"已经放了几天"', () => {
    const s = setup();
    const old = s.store.addIntent({ text: '回头问问她那天为什么没来', dueAt: hoursAgo(s.now, 24 * 20) });
    const fresh = s.store.addIntent({ text: '明天跟他说一声', dueAt: hoursAgo(s.now, -24) });
    assert.ok(old && fresh);
    const text = buildWorldSnapshot({ store: s.store, memory: s.memory, now: s.now });
    // 到期 20 天还没了结 → 提醒她这件事放了多久；刚记下的不打扰。
    assert.match(text, /已经放了 20 天，还惦记吗/u);
    assert.equal(text.match(/还惦记吗/gu)?.length, 1);
    // 仍然在账上，没有替她判"过期"。
    assert.equal(s.store.countOpenIntents(), 2);
  });
} finally {
  for (const store of stores) { try { store.close(); } catch { /* 无妨 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不算失败 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
