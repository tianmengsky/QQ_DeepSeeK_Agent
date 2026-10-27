import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { SelfLedger, __selfTest } from '../lib/application/self.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { config, message } from './helpers/bridge.mjs';

const fakeCtx = { logger: { info() {}, warn() {}, debug() {} } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-self-'));
const realFetch = globalThis.fetch;
const stores = [];
let passed = 0, failed = 0, n = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function setup(settings = {}) {
  const store = new Store(path.join(root, String(n++), 'bridge.sqlite3'));
  stores.push(store);
  const ledger = new SelfLedger({ config: config({ selfEnabled: true, ...settings }), store });
  return { store, ledger };
}
/** 按 action 返回固定载荷；传 null 表示该接口抛错。 */
function stub(data, { fail = [] } = {}) {
  globalThis.fetch = async (url) => {
    const action = String(url).split('/').pop();
    if (fail.includes(action)) throw new Error('模拟失败 ' + action);
    const payload = data[action] ?? {};
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: payload }) };
  };
}
const LOGIN = { user_id: 3667925015, nickname: '小鲸鱼' };
const GROUPS = [
  { group_id: 2165079787, group_name: '小鲸鱼的白饭食堂', member_count: 4 },
  { group_id: 324089993, group_name: '杯满之灿幻庄', member_count: 14 },
  { group_id: 1033440455, group_name: '鸠～鸠～居', member_count: 74 },
];
const FRIENDS = [{ user_id: 200, nickname: '甲', remark: '小林' }, { user_id: 201, nickname: '乙' }];

try {
  await test('刷新写入账号、群与好友，并带上 no_cache', async () => {
    const { ledger } = setup();
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ action: String(url).split('/').pop(), payload: JSON.parse(init.body) });
      const action = String(url).split('/').pop();
      const data = action === 'get_login_info' ? LOGIN : action === 'get_group_list' ? GROUPS : FRIENDS;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data }) };
    };
    const result = await ledger.refresh({ reason: 'test' });
    assert.equal(result.ok, true);
    assert.equal(ledger.profile().nickname.value, '小鲸鱼');
    assert.equal(ledger.profile().uin.value, '3667925015');
    assert.equal(ledger.groups().length, 3);
    assert.equal(ledger.friends().length, 2);
    const groupCall = seen.find((c) => c.action === 'get_group_list');
    // 不传 no_cache 的话，改名之后仍会拿到旧群名 —— 这行是硬要求。
    assert.equal(groupCall.payload.no_cache, true);
    assert.ok(ledger.lastRefreshAt > 0);
  });

  await test('部分接口失败时保留旧值，不把群清空', async () => {
    const { ledger } = setup();
    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    assert.equal(ledger.groups().length, 3);
    // 好友接口挂掉：群与账号事实必须还在。
    stub({ get_login_info: LOGIN, get_group_list: GROUPS }, { fail: ['get_friend_list'] });
    const second = await ledger.refresh();
    assert.equal(second.ok, false);
    assert.equal(ledger.groups().length, 3);
    assert.equal(ledger.friends().length, 2);
    assert.match(ledger.lastError, /friends/);
  });

  await test('退出的群会从快照里消失，不会长期挂着', async () => {
    const { ledger } = setup();
    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    stub({ get_login_info: LOGIN, get_group_list: GROUPS.slice(0, 1), get_friend_list: FRIENDS });
    await ledger.refresh();
    assert.deepEqual(ledger.groups().map((g) => g.groupId), ['2165079787']);
  });

  await test('不认识的列表形状保留旧快照，而不是写空', async () => {
    const { ledger } = setup();
    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    // 某些实现把 data 包成 {message_id} 之类 —— normalizeList 必须返回 null。
    stub({ get_login_info: LOGIN, get_group_list: { message_id: 1 }, get_friend_list: FRIENDS });
    await ledger.refresh();
    assert.equal(ledger.groups().length, 3);
    assert.equal(__selfTest.normalizeList({ list: [1, 2] }).length, 2);
    assert.equal(__selfTest.normalizeList({ message_id: 1 }), null);
  });

  await test('自传事件只接受回执与会话写入，拒绝群聊提炼', async () => {
    const { ledger } = setup();
    const ok = ledger.record({ kind: 'rename', summary: '把昵称改成「小鲸鱼」', source: 'tool-receipt' });
    assert.equal(ok.ok, true);
    assert.equal(ledger.events().length, 1);
    assert.throws(() => ledger.record({ kind: 'promise', summary: '从群聊里提炼的', source: 'chat' }), /只接受/);
    assert.throws(() => ledger.record({ kind: 'unknown', summary: 'x', source: 'tool-receipt' }), /未知自传类别/);
    assert.throws(() => ledger.record({ kind: 'speak', summary: '   ', source: 'self-turn' }), /摘要/);
  });

  await test('卡片含群号、快照年龄与定位规则；没数据时不注入空标题', async () => {
    const { ledger } = setup();
    assert.equal(ledger.card(), '');
    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    ledger.record({ kind: 'rename', summary: '把昵称改成「小鲸鱼」', outcome: '已生效', source: 'tool-receipt' });
    const card = ledger.card();
    assert.match(card, /【关于我自己】/);
    assert.match(card, /小鲸鱼/);
    assert.match(card, /3667925015/);
    assert.match(card, /324089993/);
    assert.match(card, /好友 2 人/);
    assert.match(card, /把昵称改成/);
    assert.match(card, /定位规则/);
    assert.match(card, /账号信息 \d+ 秒前读取/);
    // 截断可验证：给一个极小的预算。
    assert.match(ledger.card({ maxChars: 40 }), /卡片已截断/);
  });

  await test('刷新失败时卡片不谎称“没有加入任何群”', async () => {
    const { ledger } = setup();
    stub({ get_login_info: LOGIN }, { fail: ['get_group_list', 'get_friend_list'] });
    await ledger.refresh();
    const card = ledger.card();
    assert.match(card, /群信息还没取到/);
    assert.equal(card.includes('你目前没有加入任何群'), false);
    assert.match(card, /好友数未知|已知好友/);
  });

  await test('健康度落库，重载后仍能看到上次失败原因', async () => {
    const { store, ledger } = setup();
    stub({}, { fail: ['get_login_info', 'get_group_list', 'get_friend_list'] });
    await ledger.refresh();
    const reloaded = new SelfLedger({ config: config({ selfEnabled: true }), store });
    const snap = reloaded.snapshot();
    assert.match(snap.lastError, /模拟失败/);
  });

  await test('快照只读，且能反映刷新失败原因', async () => {
    const { ledger } = setup();
    stub({}, { fail: ['get_login_info', 'get_group_list', 'get_friend_list'] });
    await ledger.refresh();
    const snap = ledger.snapshot();
    assert.equal(snap.available, true);
    assert.equal(snap.groups, 0);
    assert.match(snap.lastError, /模拟失败/);
    assert.equal(snap.enabled, true);
  });
  await test('自我卡片注入一次后不重复；没有事实时不注入空标题', async () => {
    const { store, ledger } = setup();
    const memory = new MemoryStore(fakeCtx, { ...ledger.config, memoryDir: path.join(root, 'm' + n++) }, store);
    memory.selfLedger = ledger;
    const cfg = { ...ledger.config, memoryEnabled: true, memoryInjectMaxChars: 1800 };
    const entry = { memoryHashes: {}, staticDone: false, recentQqs: [] };
    const empty = buildMemoryInjection(cfg, message(1, '你好'), entry, memory);
    assert.doesNotMatch(empty.text, /关于我自己/);

    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    const first = buildMemoryInjection(cfg, message(2, '你好'), entry, memory);
    assert.match(first.text, /关于我自己/);
    assert.match(first.text, /324089993/);
    // 记下指纹、标记窗口已开过：同样内容第二轮不该再注入。
    entry.memoryHashes = first.hashes;
    entry.staticDone = true;
    const again = buildMemoryInjection(cfg, message(3, '你好'), entry, memory);
    assert.doesNotMatch(again.text, /关于我自己/);
    // 事实变化（改名）之后必须重新注入。
    stub({ get_login_info: { user_id: 3667925015, nickname: '小鲸鱼2' }, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    const changed = buildMemoryInjection(cfg, message(4, '你好'), entry, memory);
    assert.match(changed.text, /小鲸鱼2/);
  });

  await test('selfCardMaxChars=0 时卡片不注入', async () => {
    const { store, ledger } = setup();
    stub({ get_login_info: LOGIN, get_group_list: GROUPS, get_friend_list: FRIENDS });
    await ledger.refresh();
    const memory = new MemoryStore(fakeCtx, { ...ledger.config, memoryDir: path.join(root, 'n' + n++) }, store);
    memory.selfLedger = ledger;
    const injected = buildMemoryInjection({ ...ledger.config, memoryEnabled: true }, message(1, '你好'),
      { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory);
    // 关掉开关只影响"是否启动周期刷新"，卡片本身仍按已抓取事实渲染；
    // 真正拦注入的是 selfCardMaxChars=0。
    const off = buildMemoryInjection({ ...ledger.config, memoryEnabled: true, selfCardMaxChars: 0 },
      message(1, '你好'), { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory);
    assert.equal(off.text.includes('关于我自己'), false);
    assert.match(injected.text, /关于我自己/);
  });
} finally {
  globalThis.fetch = realFetch;
  for (const store of stores) { try { store.db.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nself: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
