/**
 * 将来（`qq_intent`）的行为钉子。
 *
 * 钉的是"她能不能记着还没做的事"，不是文案：记下了、读得到、了结就不再出现、
 * 欠太多会被拦、时间说法能认、世界快照里看得见。改版式不该让这些变红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { intentTool, parseWhen, __intentTest } from '../lib/application/intent-tool.mjs';
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
    console.log(`  ✗ ${name} ${error?.stack ?? error}`);
  }
}

function rig(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-intent-'));
  const store = new Store(path.join(dir, 'qq.sqlite3'));
  const config = { intentEnabled: true, intentMaxOpen: 2, intentMaxChars: 20, ...over };
  const state = { disposed: false };
  const tool = intentTool({ store, config, state });
  return { store, config, state, tool, dir };
}

const DAY = 86400000;

await test('add 记下一条，list 读得到', async () => {
  const r = rig();
  const saved = await r.tool.execute({ action: 'add', text: '问问天梦那个口令到底怎么算' });
  assert.equal(saved.status, 'SAVED');
  assert.ok(saved.id > 0);
  const list = await r.tool.execute({ action: 'list' });
  assert.equal(list.status, 'LIST');
  assert.match(list.text, /口令/);
  assert.match(list.text, /什么时候都行/);
});

await test('同一句话记两遍只留一条', async () => {
  const r = rig();
  const a = await r.tool.execute({ action: 'add', text: '回头问问围棋那手棋' });
  const b = await r.tool.execute({ action: 'add', text: '回头问问围棋那手棋' });
  assert.equal(a.id, b.id);
  assert.equal(r.store.openIntents({ before: Date.now() }).length, 1);
});

await test('了结之后不再出现，重复了结会报错', async () => {
  const r = rig();
  const saved = await r.tool.execute({ action: 'add', text: '问问雨爱那首歌唱完没' });
  assert.equal((await r.tool.execute({ action: 'done', id: saved.id })).status, 'DONE');
  const list = await r.tool.execute({ action: 'list' });
  assert.equal(list.status, 'EMPTY');
  await assert.rejects(() => r.tool.execute({ action: 'done', id: saved.id }), /已经了结|没有这个编号/);
});

await test('drop 是不想做了，和 done 一样不再出现', async () => {
  const r = rig();
  const saved = await r.tool.execute({ action: 'add', text: '说完那半句话' });
  assert.equal((await r.tool.execute({ action: 'drop', id: saved.id })).status, 'DROPPED');
  assert.equal(r.store.openIntents({ before: Date.now() }).length, 0);
});

await test('欠太多会被拦：先了结几件', async () => {
  const r = rig();
  await r.tool.execute({ action: 'add', text: '第一件事' });
  await r.tool.execute({ action: 'add', text: '第二件事' });
  await assert.rejects(() => r.tool.execute({ action: 'add', text: '第三件事' }), /先了结/);
});

await test('一句话太长就不记：那不是记事，是写作文', async () => {
  const r = rig();
  await assert.rejects(
    () => r.tool.execute({ action: 'add', text: 'x'.repeat(40) }),
    /一句话最多/,
  );
});

await test('时间说法能认：today / tomorrow / 3d / 认不出来就"什么时候都行"', async () => {
  const now = new Date(2026, 10, 1, 10, 0).getTime();
  assert.equal(parseWhen('', now), 0);
  assert.equal(parseWhen('随便', now), 0);
  assert.equal(parseWhen('3d', now), now + 3 * DAY);
  const today = parseWhen('today', now);
  assert.ok(today > now && today - now <= DAY);
  const tomorrow = parseWhen('tomorrow', now);
  assert.ok(tomorrow > today);
});

await test('世界快照里看得见她欠着的事，到期的会标出来', async () => {
  const r = rig({ intentMaxOpen: 10, intentMaxChars: 200 });
  const now = new Date(2026, 10, 1, 10, 0).getTime();
  await r.tool.execute({ action: 'add', text: '问问天梦那个口令' });
  r.store.addIntent({ text: '给棋友群发昨天那盘棋', dueAt: now - DAY, conversation: 'group:10' });
  const text = buildWorldSnapshot({ store: r.store, memory: null, now, maxChars: 4000 });
  assert.match(text, /【你还欠着的事】/);
  assert.match(text, /问问天梦那个口令/);
  assert.match(text, /到时间了/);
  assert.match(text, /群 10/);
});

await test('关了开关就记不了', async () => {
  const r = rig({ intentEnabled: false });
  await assert.rejects(() => r.tool.execute({ action: 'add', text: '记不下来' }), /关着/);
});

assert.equal(__intentTest.MAX_OPEN, 12);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
