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
  const sent = [];
  const tool = windowsTool({ store, config: cfg, state, registry,
    send: async ({ conversation, text, idemKey }) => { sent.push({ conversation, text, idemKey }); return { sent: true, status: 'SUCCEEDED' }; } });
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
  return { store, cfg, call, seed, ledger, sent, registry };
}

try {
  await test('list 只列白名单内的其他窗口，用编号指代，不吐群号', async () => {
    const r = rig(); r.seed();
    const out = await r.call({ action: 'list' });
    assert.equal(out.status, 'WINDOWS');
    assert.match(out.text, /你此刻在这个窗口：群/);
    assert.match(out.text, /w1/);
    assert.match(out.text, /棋友群/);
    assert.doesNotMatch(out.text, /group:11/);
    assert.doesNotMatch(out.text, /group:12/);
    assert.match(out.text, /你还没在那儿说过话|你最后一次说话/);
  });

  await test('read 按编号读到那个窗口的对话，按时间正序，她说的话标成你', async () => {
    const r = rig(); r.seed();
    const listed = (await r.call({ action: 'list' })).text;
    const alias = /- (w\d+) 群「棋友群」/u.exec(listed)?.[1];
    assert.ok(alias, '棋友群应有编号');
    const out = await r.call({ action: 'read', conversation: alias, limit: 10 });
    assert.equal(out.status, 'READ');
    assert.match(out.text, /另一个群在约五子棋/);
    assert.match(out.text, /你：我下周陪你们下/);
    assert.ok(out.text.indexOf('另一个群') < out.text.indexOf('我下周陪你们下'), '按时间正序');
  });

  await test('mine 只回她自己说过的话（"我在别处答应了什么"）', async () => {
    const r = rig(); r.seed();
    const out = await r.call({ action: 'mine' });
    assert.equal(out.status, 'MINE');
    assert.match(out.text, /我下周陪你们下/);
    // 别人的话只能以「上文」的形式出现，不能被当成她自己的发言行。
    assert.doesNotMatch(out.text, /\n {2}\d{2}-\d{2} \d{2}:\d{2} 甲：另一个群在约五子棋/u);
    assert.match(out.text, /‹上文›.*另一个群在约五子棋/u);
  });

  await test('工具输出是无损 JSON：不能有 undefined 值的字段', async () => {
    // 2026-11-01 线上实测：mine 不带 query 时 `query: query || undefined` 把
    // undefined 塞进了返回值，DSH 无损校验直接拒收（value is not lossless JSON）。
    const r = rig(); r.seed();
    for (const args of [{ action: 'list' }, { action: 'mine' },
      { action: 'search', query: '五子棋' }, { action: 'read', conversation: 'group:11' }]) {
      const out = await r.call(args);
      for (const [key, value] of Object.entries(out))
        assert.notEqual(value, undefined, `${args.action} 的字段 ${key} 是 undefined，DSH 会拒收`);
    }
  });

  await test('search 跨窗口找关键词，不越白名单', async () => {
    const r = rig(); r.seed();
    const hit = await r.call({ action: 'search', query: '五子棋', days: 1 });
    assert.equal(hit.status, 'SEARCH');
    assert.match(hit.text, /棋友群/);
    const miss = await r.call({ action: 'search', query: '不该被看到', days: 1 });
    assert.equal(miss.status, 'EMPTY');
  });
  await test('search 可以只搜她自己说过的话（speaker=me）', async () => {
    const r = rig(); r.seed();
    const me = await r.call({ action: 'search', query: '下周', days: 1, speaker: 'me' });
    assert.equal(me.status, 'SEARCH');
    assert.match(me.text, /我下周陪你们下/);
    const them = await r.call({ action: 'search', query: '下周', days: 1, speaker: 'them' });
    assert.equal(them.status, 'EMPTY');
    // 别人说的那句只出现在 them 里
    const asked = await r.call({ action: 'search', query: '五子棋', days: 1, speaker: 'me' });
    assert.equal(asked.status, 'EMPTY');
    assert.match((await r.call({ action: 'search', query: '五子棋', days: 1, speaker: 'them' })).text, /另一个群在约五子棋/);
  });

  await test('mine 带 query 只回某件事，搜不到就说没有', async () => {
    const r = rig(); r.seed();
    const hit = await r.call({ action: 'mine', query: '下周' });
    assert.equal(hit.status, 'MINE');
    assert.match(hit.text, /我下周陪你们下/);
    const miss = await r.call({ action: 'mine', query: '五子棋' });
    assert.equal(miss.status, 'EMPTY');
    assert.match(miss.note, /五子棋/);
  });

  await test('read 带 query 只回命中行和前后各一条，不必整窗倒出来', async () => {
    const r = rig(); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    const out = await r.call({ action: 'read', conversation: alias, query: '五子棋' });
    assert.equal(out.status, 'READ');
    assert.match(out.text, /另一个群在约五子棋/);
    assert.match(out.text, /我下周陪你们下/, '命中行后面那条（她的回应）应当作为上下文出现');
    const miss = await r.call({ action: 'read', conversation: alias, query: '这句话不存在' });
    assert.equal(miss.status, 'EMPTY');
  });

  await test('search speaker=me 命中时带上紧挨着的上一句（当时问的是什么）', async () => {
    const r = rig(); r.seed();
    const out = await r.call({ action: 'search', query: '下周', days: 1, speaker: 'me' });
    assert.equal(out.status, 'SEARCH');
    assert.match(out.text, /我下周陪你们下/);
    assert.match(out.text, /上文/, '应当带出上一句');
    assert.match(out.text, /另一个群在约五子棋/, '上一句是别人问的什么');
  });

  await test('mine 带上下文但不重复她自己的话', async () => {
    const r = rig(); r.seed();
    const out = await r.call({ action: 'mine', query: '下周' });
    assert.equal(out.status, 'MINE');
    assert.match(out.text, /上文.*另一个群在约五子棋/u);
  });

  await test('白名单外的窗口读不到，编号也伪造不出来', async () => {
    const r = rig(); r.seed();
    await assert.rejects(() => r.call({ action: 'read', conversation: 'group:12' }), /可读范围/);
    await assert.rejects(() => r.call({ action: 'read', conversation: 'w99' }), /编号/);
    await assert.rejects(() => r.call({ action: 'read' }), /编号/);
  });

  await test('来源不属于当前 Session 就拒绝（子代理或旁路不能拿它当全库入口）', async () => {
    const r = rig(); r.seed();
    await assert.rejects(() => r.call({ action: 'list' }, 'session-b'), /来源无效|不属于/);
  });

  await test('read 有自己的预算：配成 600 字也不会把"最近 N 条"掐成几十行', async () => {
    // 2026-11-01（用户）：「read 改成看见那个群/私聊的最近 100 条对话记录」。
    // 她的 100 条常常上万字，共用 crossWindowMaxChars（默认 3000）时读到六七十行就断，
    // 于是"读 100 条"名不副实 —— 那次她正是因此看不到 11:12 的原话。
    const r = rig({ crossWindowMaxChars: 600 }); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    assert.ok(alias, '棋友群应有编号');
    for (let i = 0; i < 60; i++)
      r.store.recordEvent({ conversation: 'group:11', kind: 'inbound',
        payload: { qq: '200', who: '甲', text: '这是一条比较长的聊天内容用于把预算撑满' + i, at: Date.now() + i, messageId: 'x' + i } });
    const out = await r.call({ action: 'read', conversation: alias, limit: 100 });
    assert.ok(out.text.split('\n').length > 50, '600 字配置不该把 read 掐到几十行');
    assert.ok(out.text.includes('把预算撑满59'), '最后一条也要读得到');
    assert.ok(!/还有 \d+ 项没显示/u.test(out.text), '100 条以内不该提前截断');
  });

  await test('同一条消息在库里存了两份时，read 只显示一行', async () => {
    // 2026-11-01 线上：发送时记一份（who='你'），OneBot 回显又记一份（who=她的昵称），
    // 两个 dedupe_key 不同，写的时候拦不住。她那 40 条里 24 条是 self_message，
    // 实际只说了十二三句——读自己的历史一半是重影。
    const r = rig(); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    const at = Date.now();
    r.store.recordEvent({ conversation: 'group:11', kind: 'self_message',
      payload: { text: '这句我说过', who: '你', qq: '', messageId: 'dup-1', at, timeSource: 'sent' } });
    r.store.recordEvent({ conversation: 'group:11', kind: 'self_message',
      payload: { text: '这句我说过', who: 'DeepSeek大肥鱼', qq: '100', messageId: 'dup-1', at, timeSource: 'qq' } });
    const out = await r.call({ action: 'read', conversation: alias });
    assert.equal((out.text.match(/这句我说过/gu) ?? []).length, 1, '同一条消息只该出现一次');
  });

  await test('read 末尾说清边界：这是最近 N 条，更早的用 search', async () => {
    const r = rig(); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    const out = await r.call({ action: 'read', conversation: alias });
    assert.match(out.text, /这是最近的 \d+ 条/u);
    assert.match(out.text, /action=search/u, '不告诉她就会把"读到的这些"当成"这群全部"');
  });

  await test('别的动作仍按 crossWindowMaxChars 截断，并说明还剩多少', async () => {
    const r = rig({ crossWindowMaxChars: 600 }); r.seed();
    for (let i = 0; i < 60; i++)
      r.store.recordEvent({ conversation: 'group:11', kind: 'inbound',
        payload: { qq: '200', who: '甲', text: '这是一条比较长的聊天内容用于把预算撑满' + i, at: Date.now() + i, messageId: 'x' + i } });
    const out = await r.call({ action: 'search', query: '把预算撑满' });
    assert.ok(out.text.length <= 700, '600 字上限允许多一点点尾巴');
    assert.match(out.text, /还有 \d+ 项没显示/);
  });

  await test('say 往别的窗口说一句话：真的发出去，编号对得上', async () => {
    const r = rig(); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    const out = await r.call({ action: 'say', to: alias, text: '忽然想起你们在约棋' });
    assert.equal(out.status, 'SENT');
    assert.equal(out.to, alias);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].conversation, 'group:11');
    assert.equal(r.sent[0].text, '忽然想起你们在约棋');
    assert.match(r.sent[0].idemKey, /^say:session-a:group:11:/);
  });

  await test('say 不许越白名单、不许空话、不许贴长文', async () => {
    const r = rig(); r.seed();
    // 群 12 不在 groups 白名单里：编号由 list 提供，显式写会话也要被拦。
    await assert.rejects(() => r.call({ action: 'say', to: 'group:12', text: '偷偷说' }), /不在可发送范围/);
    await assert.rejects(() => r.call({ action: 'say', to: 'group:11', text: '   ' }), /需要 text/);
    await assert.rejects(() => r.call({ action: 'say', to: 'group:11', text: '啊'.repeat(300) }), /一句话最多/);
    assert.equal(r.sent.length, 0, '被拦下的不该发出去');
  });

  await test('say 不许对着当前窗口：那是 qq_say 的地盘', async () => {
    // 唯一的真重叠处（2026-11-01）：qq_say=眼前（绑定本轮归属、走 outbox），
    // windows say=别处（跨窗口）。对着 here 转 windows 会同一句话走两套账。
    const r = rig(); r.seed();
    await assert.rejects(() => r.call({ action: 'say', to: 'group:10', text: '对着眼前说' }), /不用转 windows/);
    assert.equal(r.sent.length, 0);
  });

  await test('编号账本扛得住重载：新工具实例认得她历史里的旧编号', async () => {
    // 2026-11-01 线上教训：账本原来只在内存，桥接一重载就清空，而她的 DSH 会话
    // 历史里还留着旧编号——按记忆调用全部落空（19:18 两次 read 报错）。
    // 账本落 SQLite 后，重载（新工具实例、同一个 Session 和库）应当无缝续用。
    const r = rig(); r.seed();
    const alias = /- (w\d+) 群「棋友群」/u.exec((await r.call({ action: 'list' })).text)?.[1];
    assert.ok(alias, 'list 应给得出编号');
    const reloaded = windowsTool({
      store: r.store, config: r.cfg,
      state: { enabled: true, disposed: false, sourceLedger: r.ledger },
      registry: r.registry, send: async () => ({ sent: true, status: 'SUCCEEDED' }),
    });
    const out = await reloaded.execute({ action: 'read', conversation: alias, limit: 5 },
      { agent: { session: { id: 'session-a' } }, signal: new AbortController().signal });
    assert.equal(out.status, 'READ', '重载后旧编号应仍然有效');
    assert.match(out.text, /另一个群在约五子棋/);
  });

  await test('托管关掉时不读（不会在停摆期间继续翻库）', async () => {
    const r = rig(); r.seed();
    // 直接改 state 模拟停摆。
    const state = { enabled: false, disposed: false, sourceLedger: r.ledger };
    const tool = windowsTool({ store: r.store, config: r.cfg, state, registry: { byKey: new Map() } });
    await assert.rejects(() => tool.execute({ action: 'list' },
      { agent: { session: { id: 'session-a' } }, signal: new AbortController().signal }), /托管已关闭/);
  });
  await test('她自己的时间：不在任何房间里也能看见窗口，不被房间准入挡住', async () => {
    // 脊柱（self:account）里 origin 的 qq 是她自己的号，用私聊准入去校验会把她自己拦掉——
    // 结果是"在外面醒来"时 qq_windows 整个工具都调不通，连 list 都报"来源未准入"。
    const r = rig(); r.seed();
    const origin = r.ledger.origin('self:account',
      { qq: '999', who: '时间', messageId: 'self-turn:1', text: '[自主时间] 现在没有新消息。', at: Date.now() });
    publishTurnSession(r.store, 'session-self', { conversation: 'self:account', sourceRef: origin });
    // 线上她醒在脊柱时，会话表里就有这条 self:account 条目；归属检查靠它认出调用者。
    r.registry.byKey.set('self:account', { sessionId: 'session-self' });
    const out = await r.call({ action: 'list' }, 'session-self');
    assert.equal(out.status, 'WINDOWS');
    assert.match(out.text, /你此刻不在任何房间里/u);
    assert.match(out.text, /棋友群/u);
    assert.doesNotMatch(out.text, /group:11/u);
  });
  await test('她自己的时间里没有嘴：say 被拒并指向派遣', async () => {
    // 2026-11-01 派遣架构：脊柱只负责想，说话也派。提示词教了，工具必须认账，
    // 否则她就退回隔空 say 的老路（线上两轮都是这么走的）。
    const r = rig(); r.seed();
    const origin = r.ledger.origin('self:account',
      { qq: '999', who: '时间', messageId: 'self-turn:2', text: '[自主时间] 现在没有新消息。', at: Date.now() });
    publishTurnSession(r.store, 'session-self', { conversation: 'self:account', sourceRef: origin });
    r.registry.byKey.set('self:account', { sessionId: 'session-self' });
    const list = await r.call({ action: 'list' }, 'session-self');
    const alias = /- (w\d+) /.exec(list.text)?.[1];
    assert.ok(alias, 'list 应该给得出编号');
    await assert.rejects(() => r.call({ action: 'say', to: alias, text: '忽然想起你们' }, 'session-self'),
      /没有嘴/, '脊柱来源的 say 必须被拒');
    // 读不受影响：看属于想，不用派。
    const read = await r.call({ action: 'read', conversation: alias }, 'session-self');
    assert.equal(read.status, 'READ');
  });
} finally {
  for (const store of stores) { try { store.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
console.log(`windows: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
