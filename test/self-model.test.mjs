/**
 * 抽象自我（`me.*`）：她自己的看法能不能被她自己写下来、能不能被看见。
 *
 * 为什么单独一套：这块修的是一个具体断点 —— 日记本 28 条里只有 2 条 public，
 * 群聊里她只能看到 0~3 条"自己"，等于主场里没有自己。
 * 所以这里钉的是**可见性**，不是文案：群聊注入里出现她的看法、私事仍不外泄、
 * 改过之后注入的是最新一版、关掉开关真的关掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { memoryTool } from '../lib/memory/tool.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { config, message } from './helpers/bridge.mjs';
import { publishTurnSession } from '../lib/agent/execution-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'self-model-'));
let passed = 0, failed = 0, sequence = 0;
const stores = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

function rig(settings = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10'], privateEnabled: true, users: ['200'], memoryInjectMaxChars: 1600, ...settings });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const origin = memory.episodes.origin('group:10', { qq: '200', who: '甲', messageId: '1',
    text: '你说你被夸的时候会先装没听懂。', at: Date.now() });
  const registry = { byKey: new Map([['group:10', { sessionId: 'session-a' }]]) };
  const state = { enabled: true, disposed: false, sourceLedger: memory.episodes };
  const tool = memoryTool({ memory, registry, store, config: cfg, state });
  publishTurnSession(store, 'session-a', { conversation: 'group:10', sourceRef: origin });
  const call = (args) => tool.execute(args,
    { agent: { session: { id: 'session-a' } }, signal: new AbortController().signal });
  /** 写一条看法（默认公开、scope=self）。 */
  const stance = (over = {}) => call({ action: 'upsert', scope: 'self', slot: 'me.stance.honored',
    version: 0, kind: 'stance', visibility: 'public', text: '被夸的时候先装没听懂，再偷偷高兴。', ...over });
  const inject = (entry = { memoryHashes: {}, staticDone: false, recentQqs: [] }, id = 2) =>
    buildMemoryInjection(cfg, message(id, '你好'), entry, memory).text;
  return { store, cfg, memory, call, stance, inject };
}

try {
  await test('看法写进自己那一本之后，群聊注入里就能看到她自己的话', () => {
    const r = rig();
    assert.equal(r.stance().status, 'SAVED');
    // 这条断点就是本次要修的：群聊（主场）里必须能看见"我怎么想"。
    assert.match(r.inject(), /被夸的时候先装没听懂/);
  });

  await test('她自己的本子按房间可见：本群的私事读得到，别群的带不过来', () => {
    const r = rig();
    r.stance({ slot: 'me.want.kept', kind: 'want', text: '想被问今天怎么样。' });
    r.call({ action: 'upsert', scope: 'self', slot: 'event.secret', version: 0, kind: 'note',
      visibility: 'private', text: '在这个群说过的私事' });
    // 从另一个群写下的私事：private 的意思是"不给别的房间看"，所以它不能出现在这里。
    r.memory.agent.write({ subject: 'self', slot: 'event.elsewhere', version: 0, kind: 'note',
      text: '别群的私事不该出现在这里', visibility: 'private', period: '',
      sources: [{ conversation: 'group:11', messageId: 'x', qq: '', who: '', at: Date.now() }] });
    const text = r.inject();
    assert.match(text, /想被问今天怎么样/);
    // 本子属于她：同一间屋子里写下的话，回来就该认得（而不是"哪里都不给看"）。
    assert.match(text, /在这个群说过的私事/);
    assert.equal(text.includes('别群的私事不该出现在这里'), false);
    assert.equal(r.memory.agent.latest('self').length, 3);
  });

  await test('me.* 不显式公开就拒绝：会进所有场合，不能靠默认值猜', () => {
    const r = rig();
    assert.throws(() => r.stance({ visibility: undefined }), /visibility=public|公开/);
    assert.equal(r.memory.agent.latest('self').length, 0);
  });

  await test('me.* 里写号码会被拦住：它会进所有群', () => {
    const r = rig();
    assert.throws(() => r.stance({ text: '群 2165079787 里的人说我会先装没听懂。' }), /群号|QQ 号/);
    assert.equal(r.memory.agent.latest('self').length, 0);
    // 只是被拦，不是禁写：换成"某个人"就照常保存。
    assert.equal(r.stance({ text: '有个人说我被夸时会先装没听懂。' }).status, 'SAVED');
  });

  await test('看法只能写进自己那本，别人那本只记事实', () => {    const r = rig();
    assert.throws(() => r.stance({ scope: 'user', slot: 'me.stance.x' }), /scope=self/);
    assert.throws(() => r.stance({ scope: 'group', slot: 'me.stance.x' }), /scope=self/);
    assert.equal(r.memory.agent.latest('200').length, 0);
    assert.equal(r.memory.agent.latest('group:10').length, 0);
  });

  await test('改过之后注入最新一版，旧的话不再出现', () => {
    const r = rig();
    r.stance();
    r.stance({ version: 1, text: '被夸的时候还是先装没听懂，但这次没装住。' });
    const text = r.inject();
    assert.match(text, /这次没装住/);
    assert.equal(text.includes('再偷偷高兴'), false);
  });

  await test('selfModelMaxChars=0 时不注入，日记照旧', () => {
    const off = rig({ selfModelMaxChars: 0 });
    off.stance();
    off.call({ action: 'upsert', scope: 'self', slot: 'event.open', version: 0, kind: 'note',
      visibility: 'public', text: '今天写了一晚上的表' });
    const text = off.inject();
    assert.equal(text.includes('先装没听懂'), false);
    assert.match(text, /今天写了一晚上的表/);
  });

  await test('她自己的看法不会在日记块里重复一遍', () => {
    const r = rig();
    r.stance();
    const text = r.inject();
    assert.equal(text.split('先装没听懂').length - 1, 1);
  });

  await test('预算不够时按槽名稳定取舍，不会每轮换一批', () => {
    const r = rig({ selfModelMaxChars: 40 });
    r.stance({ slot: 'me.stance.a', kind: 'stance', text: 'A'.repeat(30) });
    r.stance({ slot: 'me.stance.b', kind: 'stance', text: 'B'.repeat(30) });
    const first = r.inject({ memoryHashes: {}, staticDone: false, recentQqs: [] }, 2);
    const second = r.inject({ memoryHashes: {}, staticDone: false, recentQqs: [] }, 3);
    assert.match(first, /A{30}/);
    assert.equal(first.includes('BBBB'), false);
    // 同样内容必须给同样的取舍：靠 slot 排序而不是更新时间。
    assert.equal(first, second);
  });
} finally {
  for (const store of stores) { try { store.db.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nself-model: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
