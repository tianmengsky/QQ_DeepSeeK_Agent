import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { EpisodeLedger } from '../lib/memory/episodes.mjs';
import { SelfLedger } from '../lib/application/self.mjs';
import { windowsTool } from '../lib/conversation/window-tool.mjs';
import { config } from './helpers/bridge.mjs';
import { publishTurnSession } from '../lib/agent/execution-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-'));
let passed = 0, failed = 0, sequence = 0;
const stores = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

/** 一条入站消息（群/私聊通用）。 */
function inbound(conversation, { qq = '200', who = '甲', text = '你好', at = Date.now(), id = String(Math.random()) } = {}) {
  return { conversation, payload: { qq, who, text, at, messageId: id }, at };
}

function rig(over = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ groupEnabled: true, groups: ['10', '11'], privateEnabled: true, users: ['200'],
    crossWindowEnabled: true, crossWindowMaxChars: 3000, ...over });
  const ledger = new EpisodeLedger(store);
  // self_group / self_friend 是自传层建的表，工具只读；这里让表存在，名字才查得到。
  new SelfLedger({ config: cfg, store, logger: { warn() {} } });
  const origin = ledger.origin('group:10', { qq: '200', who: '甲', messageId: '1', text: '你好', at: Date.now() });
  const registry = { byKey: new Map([['group:10', { sessionId: 'session-a' }]]) };
  const state = { enabled: true, disposed: false, sourceLedger: ledger };
  const tool = windowsTool({ store, config: cfg, state, registry });
  publishTurnSession(store, 'session-a', { conversation: 'group:10', sourceRef: origin });
  const call = (args, session = 'session-a') => tool.execute(args,
    { agent: { session: { id: session } }, signal: new AbortController().signal });
  /** 造一段历史：群 10、群 11、私聊 200 各几条，还有一条不在白名单的群 12。 */
  const seed = () => {
    const base = Date.now() - 3600_000;
    const say = (conv, msg, delta) => store.recordEvent({ conversation: conv,
      kind: msg.self ? 'self_message' : 'inbound',
      payload: { qq: msg.self ? undefined : (msg.qq ?? '200'), who: msg.self ? undefined : (msg.who ?? '甲'),
        text: msg.text, at: base + delta, messageId: 'm' + delta },
      createdAt: base + delta });
    say('group:10', { text: '这个群在聊天气' }, 0);
    say('group:11', { text: '另一个群在约五子棋' }, 1000);
    say('group:11', { text: '我下周陪你们下' , self: true }, 2000);
    say('user:200', { text: '私聊里问你今天怎么样' }, 3000);
    say('group:12', { text: '不该被看到的群' }, 4000);
    store.db.prepare("INSERT INTO self_group (group_id, name, member_count, my_role, seen_at) VALUES ('11','棋友群',9,'member',0)").run();
    store.db.prepare("INSERT INTO self_friend (user_id, nickname, remark, seen_at) VALUES ('200','天梦','天梦',0)").run();
  };
  return { store, cfg, call, seed, ledger };
}

try {
  await test('list 只列白名单内的其他窗口，用编号指代，不吐群号', () => {
    const r = rig(); r.seed();
    const out = r.call({ action: 'list' });
    assert.equal(out.status, 'WINDOWS');
    assert.match(out.text, /你此刻在这个窗口：群/);
    assert.match(out.text, /w1/);
    assert.match(out.text, /棋友群/);
    assert.doesNotMatch(out.text, /group:11/);
    assert.doesNotMatch(out.text, /group:12/);
    assert.match(out.text, /你还没在那儿说过话|你最后一次说话/);
  });

  await test('read 按编号读到那个窗口的对话，按时间正序，她说的话标成你', () => {
    const r = rig(); r.seed();
    const listed = r.call({ action: 'list' }).text;
    const alias = /- (w\d+) 群「棋友群」/u.exec(listed)?.[1];
    assert.ok(alias, '棋友群应有编号');
    const out = r.call({ action: 'read', conversation: alias, limit: 10 });
    assert.equal(out.status, 'READ');
    assert.match(out.text, /另一个群在约五子棋/);
    assert.match(out.text, /你：我下周陪你们下/);
    assert.ok(out.text.indexOf('另一个群') < out.text.indexOf('我下周陪你们下'), '按时间正序');
  });

  await test('mine 只回她自己说过的话（"我在别处答应了什么"）', () => {
    const r = rig(); r.seed();
    const out = r.call({ action: 'mine' });
    assert.equal(out.status, 'MINE');
    assert.match(out.text, /我下周陪你们下/);
    assert.doesNotMatch(out.text, /另一个群在约五子棋/);
  });

  await test('search 跨窗口找关键词，不越白名单', () => {
    const r = rig(); r.seed();
    const hit = r.call({ action: 'search', query: '五子棋', days: 1 });
    assert.equal(hit.status, 'SEARCH');
    assert.match(hit.text, /棋友群/);
    const miss = r.call({ action: 'search', query: '不该被看到', days: 1 });
    assert.equal(miss.status, 'EMPTY');
  });

  await test('白名单外的窗口读不到，编号也伪造不出来', () => {
    const r = rig(); r.seed();
    assert.throws(() => r.call({ action: 'read', conversation: 'group:12' }), /可读范围/);
    assert.throws(() => r.call({ action: 'read', conversation: 'w99' }), /编号/);
    assert.throws(() => r.call({ action: 'read' }), /编号/);
  });

  await test('来源不属于当前 Session 就拒绝（子代理或旁路不能拿它当全库入口）', () => {
    const r = rig(); r.seed();
    assert.throws(() => r.call({ action: 'list' }, 'session-b'), /来源无效|不属于/);
  });

  await test('输出按 crossWindowMaxChars 截断，并说明还剩多少', () => {
    // 下限 600：再小就只剩一行，不如让她换个范围查。
    const r = rig({ crossWindowMaxChars: 600 }); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec(r.call({ action: 'list' }).text)?.[1];
    assert.ok(alias, '棋友群应有编号');
    for (let i = 0; i < 60; i++)
      r.store.recordEvent({ conversation: 'group:11', kind: 'inbound',
        payload: { qq: '200', who: '甲', text: '这是一条比较长的聊天内容用于把预算撑满' + i, at: Date.now() + i, messageId: 'x' + i } });
    const out = r.call({ action: 'read', conversation: alias, limit: 100 });
    assert.ok(out.text.length <= 700, '600 字上限允许多一点点尾巴');
    assert.match(out.text, /还有 \d+ 项没显示/);
  });

  await test('托管关掉时不读（不会在停摆期间继续翻库）', () => {
    const r = rig(); r.seed();
    // 直接改 state 模拟停摆。
    const state = { enabled: false, disposed: false, sourceLedger: r.ledger };
    const tool = windowsTool({ store: r.store, config: r.cfg, state, registry: { byKey: new Map() } });
    assert.throws(() => tool.execute({ action: 'list' },
      { agent: { session: { id: 'session-a' } }, signal: new AbortController().signal }), /托管已关闭/);
  });
} finally {
  for (const store of stores) { try { store.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
console.log(`windows: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
