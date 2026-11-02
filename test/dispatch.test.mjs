/**
 * 派遣（`qq_dispatch`）的行为钉子。
 *
 * 脊柱只负责"想"，房间身份类的事派给对应窗口的子会话办。这里钉的是机制，
 * 不是文案：
 *   ① 白名单里有它、脊柱材料里列了它（两头钉由 spine-task.test.mjs 全量覆盖，
 *      这里只钉派遣自己的那一半）；
 *   ② 来源边界：只有 `self:*` 来源能派，房间里的调用被拒（防子→父绕圈）；
 *   ③ 合成事件的形状：`__selfTurn`（准入放行）+ `__dispatch`（换提示词帧）；
 *   ④ 账本状态机：queued → done/silent，终态行不可改写，重复记账不重复；
 *   ⑤ 崩溃对账：queued/running 在重载后如实标 needs_attention，不假装续跑；
 *   ⑥ 回执进快照：世界快照里读得到【你派出去的事】。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { allowedToolNames } from '../lib/agent/tool-scope.mjs';
import { dispatchTool, dispatchEvent, sweepOrphanDispatches } from '../lib/application/dispatch.mjs';
import { aliasOf } from '../lib/conversation/window-index.mjs';
import { spineTaskText } from '../lib/application/proactive.mjs';
import { buildWorldSnapshot } from '../lib/application/world-snapshot.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qq-dispatch-case-'));
  const store = new Store(path.join(dir, 'dispatch.sqlite3'));
  const config = {
    dispatchEnabled: true, groupEnabled: true, privateEnabled: true,
    groups: [], users: [], selfIds: ['10000'], ...over.config,
  };
  const state = {
    disposed: false, enabled: true,
    controller: { signal: new AbortController().signal },
    // 来源账本打桩：直接把调用来源定为给定会话。
    sourceLedger: { resolve: () => ({ qq: '10000', message_id: 'm1', conversation: over.origin ?? 'self:account' }) },
  };
  const scheduled = [];
  const registry = {
    // 只记录"排进了哪个窗口的链"，不真跑回合：工具的边界是记账 + 排队，
    // 回合本身（executeTurn）在别的套件里验证。
    run(key) { scheduled.push(key); return Promise.resolve(); },
    entry: () => ({ window: [] }),
    persist: () => {},
  };
  const tool = dispatchTool({ ctx: { logger: { warn() {}, info() {} } }, config, registry, state, memory: null, stats: {}, store });
  return { store, config, state, registry, tool, scheduled, dir };
}

const execFor = (sessionId = 'sess-1') => ({
  agent: { session: { id: sessionId } },
  signal: new AbortController().signal,
});

await test('白名单里有 qq_dispatch，脊柱材料里列了它', () => {
  assert.ok(allowedToolNames().includes('qq_dispatch'), '白名单里没有 qq_dispatch');
  assert.ok(spineTaskText('【快照】').includes('qq_dispatch'), '脊柱材料没有列 qq_dispatch');
});

await test('房间来源调用被拒：念头不在房间里再派一次', async () => {
  const r = rig({ origin: 'group:12345' });
  await assert.rejects(
    () => r.tool.execute({ conversation: 'group:67890', instruction: '改个群名' }, execFor()),
    /派遣只属于你自己的时间/,
  );
  assert.equal(r.store.recentDispatches({ limit: 5 }).length, 0);
});

await test('来源无效（没有真实 QQ 回合）也被拒', async () => {
  const r = rig();
  r.state.sourceLedger = { resolve: () => null };
  await assert.rejects(
    () => r.tool.execute({ conversation: 'group:12345', instruction: '改个群名' }, execFor()),
    /来源无效/,
  );
});

await test('脊柱来源派遣成功：记 queued 账、排进目标窗口的执行链', async () => {
  const r = rig();
  const out = await r.tool.execute({ conversation: 'group:12345', instruction: '把群名改成今晚的暗号' }, execFor());
  assert.equal(out.status, 'DISPATCHED');
  assert.ok(out.id.startsWith('disp:'));
  assert.deepEqual(r.scheduled, ['group:12345'], '没有排进目标窗口的执行链');
  const rows = r.store.recentDispatches({ limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'queued');
  assert.equal(rows[0].conversation, 'group:12345');
  assert.match(rows[0].instruction, /群名/);
});

await test('白名单外的窗口不派；认不出来的指代给出改法', async () => {
  const r = rig({ config: { groups: ['12345'], users: [] } });
  await assert.rejects(
    () => r.tool.execute({ conversation: 'group:67890', instruction: '发个公告' }, execFor()),
    /不在可派遣的范围/,
  );
  // 认不出来的写法（群名、self: 键）不给硬错，告诉她编号怎么传。
  await assert.rejects(
    () => r.tool.execute({ conversation: 'self:account', instruction: '改自己的签名' }, execFor()),
    /conversation 传窗口编号/,
  );
  await assert.rejects(
    () => r.tool.execute({ conversation: '终焉议事厅', instruction: '发个公告' }, execFor()),
    /conversation 传窗口编号/,
  );
  assert.equal(r.scheduled.length, 0);
});

await test('不带 conversation 返回可派窗口列表（自给自足，不依赖先 list）', async () => {
  const r = rig();
  r.store.upsertConversation('group:12345', { lastMessageAt: Date.now() - 60000 });
  r.store.upsertConversation('user:67890', { lastMessageAt: Date.now() - 120000 });
  const out = await r.tool.execute({ instruction: '派件事' }, execFor());
  assert.equal(out.status, 'WINDOWS');
  assert.match(out.text, /w1/);
  assert.match(out.text, /w2/);
  assert.equal(r.scheduled.length, 0, '报名册那一次不该产生派遣');
  assert.equal(r.store.recentDispatches({ limit: 5 }).length, 0);
});

await test('认 qq_windows 同一份 w? 编号（别名账本共享）', async () => {
  const r = rig();
  const alias = aliasOf('sess-1', 'group:12345');
  const out = await r.tool.execute({ conversation: alias, instruction: '改个群名' }, execFor());
  assert.equal(out.status, 'DISPATCHED');
  assert.equal(out.to, alias);
  assert.deepEqual(r.scheduled, ['group:12345']);
});

await test('空 instruction 不派；超长念头不派（派方向，不派剧本）', async () => {
  const r = rig();
  await assert.rejects(() => r.tool.execute({ conversation: 'group:12345', instruction: '  ' }, execFor()));
  await assert.rejects(() => r.tool.execute({ conversation: 'group:12345', instruction: 'x'.repeat(201) }, execFor()));
  assert.equal(r.scheduled.length, 0);
});

await test('合成事件带 __selfTurn 与 __dispatch，正文携带念头', () => {
  const event = dispatchEvent({ id: 'abc', target: 'group:12345', instruction: '起个话题', selfId: 10000 });
  assert.equal(event.message_type, 'group');
  assert.equal(event.group_id, 12345);
  assert.equal(event.self_id, 10000);
  assert.equal(event.message_id, 'dispatch:abc');
  assert.equal(event.__selfTurn, true, '准入要靠 __selfTurn 放行她自己');
  assert.equal(event.__dispatch, true, '提示词要靠 __dispatch 换帧');
  assert.match(event.raw_message, /起个话题/);
  const priv = dispatchEvent({ id: 'abc', target: 'user:67890', instruction: '问一声', selfId: 10000 });
  assert.equal(priv.message_type, 'private');
  assert.equal(priv.user_id, 67890, '私聊派遣的对面是那个人');
});

await test('账本状态机：queued → done；终态行不可改写', () => {
  const r = rig();
  r.store.recordDispatch({ id: 'disp:1', conversation: 'group:1', instruction: '一件事' });
  assert.equal(r.store.updateDispatch('disp:1', 'running'), true);
  assert.equal(r.store.updateDispatch('disp:1', 'done', '动作：动了群里的设置；说了：换好了'), true);
  // done 是终态：迟到的更新不许改写既成事实。
  assert.equal(r.store.updateDispatch('disp:1', 'failed', '迟到的报错'), false);
  const row = r.store.recentDispatches({ limit: 1 })[0];
  assert.equal(row.state, 'done');
  assert.match(row.result, /动了群里的设置/);
});

await test('重复记账只留一条；空 instruction 不入账', () => {
  const r = rig();
  assert.equal(r.store.recordDispatch({ id: 'disp:1', conversation: 'group:1', instruction: '一件事' }), 'disp:1');
  assert.equal(r.store.recordDispatch({ id: 'disp:1', conversation: 'group:1', instruction: '一件事' }), null);
  assert.equal(r.store.recordDispatch({ id: 'disp:2', conversation: 'group:1', instruction: '   ' }), null);
  assert.equal(r.store.recentDispatches({ limit: 5 }).length, 1);
});

await test('开机对账：queued/running 如实标 needs_attention，不假装续跑', () => {
  const r = rig();
  r.store.recordDispatch({ id: 'disp:1', conversation: 'group:1', instruction: '没办完的' });
  r.store.recordDispatch({ id: 'disp:2', conversation: 'group:2', instruction: '正在办的' });
  r.store.updateDispatch('disp:2', 'running');
  r.store.recordDispatch({ id: 'disp:3', conversation: 'group:3', instruction: '办完的' });
  r.store.updateDispatch('disp:3', 'done');
  assert.equal(sweepOrphanDispatches(r.store), 2);
  const states = Object.fromEntries(r.store.recentDispatches({ limit: 5 }).map((row) => [row.id, row.state]));
  assert.equal(states['disp:1'], 'needs_attention');
  assert.equal(states['disp:2'], 'needs_attention');
  assert.equal(states['disp:3'], 'done', '已办完的不动');
  assert.equal(sweepOrphanDispatches(r.store), 0, '对账幂等');
});

await test('世界快照读得到派遣回执，只报事实', () => {
  const r = rig();
  r.store.recordDispatch({ id: 'disp:1', conversation: 'group:1', instruction: '把群名换成今晚的暗号', createdAt: Date.now() - 120000 });
  r.store.updateDispatch('disp:1', 'done', '动作：动了群里的设置');
  const text = buildWorldSnapshot({ store: r.store, memory: null, now: Date.now(), maxChars: 4000 });
  assert.ok(text.includes('你派出去的事'), '快照里没有派遣段');
  assert.ok(text.includes('把群名换成今晚的暗号'));
  assert.ok(text.includes('已经去办了'));
  assert.ok(text.includes('动了群里的设置'));
  // 没有派遣时不出这一段。
  const empty = buildWorldSnapshot({ store: rig().store, memory: null, now: Date.now(), maxChars: 4000 });
  assert.ok(!empty.includes('你派出去的事'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
