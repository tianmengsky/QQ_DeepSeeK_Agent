import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore, resolveMemoryDir } from '../lib/memory/memory-store.mjs';
import { memoryTool } from '../lib/memory/tool.mjs';
import { compactPersonMemory } from '../lib/memory/presentation.mjs';
import { buildMemoryInjection, buildPrompt } from '../lib/prompt/render.mjs';
import { config, message } from './helpers/bridge.mjs';
import { publishExecutionSource, closeExecutionSource, publishTurnSession } from '../lib/agent/execution-scope.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
let passed = 0, failed = 0, sequence = 0;
const stores = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function rig({ conversation = 'group:10' } = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10'], privateEnabled: true, users: ['200'], memoryInjectMaxChars: 1600 });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const origin = memory.episodes.origin(conversation, { qq: '200', who: '甲', messageId: '1',
    text: '请记住我十月到十二月在实习。我不吃香菜。忘记我的偏好。恢复旧版本。', at: Date.now() });
  const registry = { byKey: new Map([[conversation, { sessionId: 'session-a' }]]) };
  const state = { enabled: true, disposed: false, sourceLedger: memory.episodes,
    // 这些用例代表"后台写者"（收尾/自主时间）——房间里的普通回合写不了 scope=self，
    // 那条边界由 agent-memory.test.mjs 的"房间不能替她署名"单独钉。
    memoryFlushSessions: new Set(), selfTurnSessions: new Set(['session-a']) };
  const tool = memoryTool({ memory, registry, store, config: cfg, state });
  publishTurnSession(store, 'session-a', { conversation, sourceRef: origin });
  const call = (args, session = 'session-a') => tool.execute(args,
    { agent: { session: { id: session } }, signal: new AbortController().signal });
  const write = (args = {}) => call({ action: 'upsert', slot: 'profile.internship', version: 0,
    kind: 'explicit', text: '在实习', period: '十月到十二月', evidence: '十月到十二月在实习', ...args });
  return { store, cfg, memory, call, write, state, origin };
}
try {
  await test('explicit memory saves period, acknowledges commit and survives reopening', () => {
    const r = rig(), receipt = r.write(); assert.equal(receipt.status, 'SAVED');
    const reopened = new MemoryStore({ logger: { warn() {} } }, r.cfg, r.store);
    assert.match(reopened.read('200'), /明确记忆.*十月到十二月/);
    assert.equal(r.call({ action: 'read' }).records[0].version, 1);
  });
  await test('read 返回条数与注入预算，接近上限时给清理提示', () => {
    const r = rig();
    const text = '在实习'.repeat(60); // 180 字
    for (let i = 0; i < 3; i++)
      r.call({ action: 'upsert', scope: 'group', slot: 'rhythm.t' + i, kind: 'note', text, version: 0 });
    const read = r.call({ action: 'read', scope: 'group' });
    assert.equal(read.subject, 'group:10');
    assert.equal(read.count, 3);
    assert.equal(read.chars, 540);
    assert.equal(read.budget, 600);
    assert.match(read.hint, /已占 540\/600 字/);
    // 没接近预算时不该有 hint，否则提示会退化成噪音。
    r.call({ action: 'upsert', scope: 'self', slot: 'social.short', kind: 'note', text: '短', version: 0 });
    const diary = r.call({ action: 'read', scope: 'self' });
    assert.equal(diary.hint, undefined);
    // 钉"预算跟着配置走"，不钉某个具体数字：默认值会随注入预算调整而变。
    assert.equal(diary.budget, r.cfg.selfNotesMaxChars);
  });
  await test('replay is idempotent and stale concurrent revision cannot overwrite', () => {
    const r = rig(); r.write(); assert.equal(r.write().replay, true);
    r.write({ version: 1, text: '实习期已确认' });
    assert.throws(() => r.write({ version: 1, text: '过时写入' }), /版本已变化/);
    assert.equal(r.memory.agent.history('200', 'profile.internship').length, 2);
  });
  await test('background same-slot update does not overwrite or resurrect forgotten main memory', () => {
    const r = rig(); r.write({ slot: 'preference.coriander', kind: 'profile', text: '不吃香菜', period: '', evidence: '不吃香菜' });
    r.memory.facts.commit({ subject: 'user:200', key: 'preference.coriander', fact: '吃香菜',
      source: { conversation: 'group:10', messageId: '2' } });
    assert.doesNotMatch(r.memory.read('200'), /- 吃香菜/);
    assert.equal(r.call({ action: 'forget', slot: 'preference.coriander', version: 1, evidence: '忘记我的偏好' }).status, 'FORGOTTEN');
    assert.doesNotMatch(r.memory.read('200'), /不吃香菜|\n- 吃香菜/);
  });
  await test('subjective impressions are labeled; old version can be restored as a new version', () => {
    const r = rig(); r.write({ kind: 'impression', text: '我感觉他很重视记忆是否准确' });
    assert.match(r.memory.read('200'), /主观印象，可修订/);
    r.write({ version: 1, kind: 'impression', text: '新的印象' });
    r.call({ action: 'restore', slot: 'profile.internship', version: 2, restore_version: 1, evidence: '恢复旧版本' });
    assert.equal(r.memory.agent.latest('200')[0].version, 3);
    assert.match(r.memory.read('200'), /很重视记忆/);
  });
  await test('another Session, disabled hosting and revoked source cannot write', () => {
    const r = rig(); assert.throws(() => r.call({ action: 'read' }, 'session-other'), /来源无效|当前 Session/);
    r.state.enabled = false; assert.throws(() => r.write(), /不可用|关闭/); r.state.enabled = true;
    r.memory.episodes.retract('group:10', '1'); assert.throws(() => r.write(), /来源无效/);
    assert.equal(r.memory.agent.latest('200').length, 0);
  });
  await test('withdrawn source removes visible main memory without reviving superseded facts', () => {
    const r = rig(); r.write(); r.memory.facts.retract('group:10', '1');
    assert.doesNotMatch(r.memory.read('200'), /在实习/);
  });
  await test('task Session owns its source and a closed execution cannot read or write memories', () => {
    const r = rig();
    r.store.db.exec('CREATE TABLE bridge_task_entities (id TEXT,state TEXT,version INTEGER,conversation TEXT)');
    r.store.db.prepare('INSERT INTO bridge_task_entities VALUES (?,?,?,?)').run('task-1', 'running', 1, 'group:10');
    publishExecutionSource(r.store, r.origin, { sessionId: 'task-session', taskId: 'task-1', taskVersion: 1,
      conversation: 'group:10', expiresAt: Date.now() + 60000 });
    assert.throws(() => r.call({ action: 'read' }), /当前 Session/);
    assert.equal(r.call({ action: 'read' }, 'task-session').status, 'READ');
    closeExecutionSource(r.store, r.origin);
    assert.throws(() => r.call({ action: 'read' }, 'task-session'), /来源无效|关闭|过期/);
  });
  await test('SQLite failure reports failure instead of claiming saved', () => {
    const r = rig(); r.store.db.exec(`CREATE TRIGGER fail_agent_memory BEFORE INSERT ON bridge_agent_memories
      BEGIN SELECT RAISE(ABORT,'disk write failed'); END;`);
    assert.throws(() => r.write(), /disk write failed/);
    assert.equal(r.memory.agent.latest('200').length, 0);
  });
  await test('Markdown projection failure still returns committed receipt and recovers on next read', () => {
    const r = rig(), sync = r.memory.syncDocument;
    r.memory.syncDocument = () => { throw new Error('projection unavailable'); };
    assert.equal(r.write().documentPending, true); r.memory.syncDocument = sync;
    assert.match(r.memory.read('200'), /十月到十二月/);
  });
  await test('long new-format documents retain explicit periods and manual profile instead of archive tail', () => {
    const doc = '# 甲\n## 主模型记忆\n- [明确记忆] 实习（时期：十月到十二月）\n## 手工记忆\n- 名字是小甲\n## 自动记忆（桥接维护）\n' +
      Array.from({ length: 30 }, (_, i) => '- 自动资料' + i + '很长的来源注释'.repeat(6)).join('\n') + '\n## 早期（已摘要）\n' + '- 早期闲聊\n'.repeat(40);
    const rendered = compactPersonMemory(doc, 350);
    assert.match(rendered, /十月到十二月/); assert.match(rendered, /名字是小甲/); assert.ok(rendered.length <= 350);
  });
  await test('question-specific recall updates fingerprint even when saved document has not changed', () => {
    const r = rig(); r.memory.append('200', '甲', '旧资料'.repeat(400));
    for (let i = 0; i < 25; i++) r.memory.append('200', '甲', `资料${i} ` + '常见内容'.repeat(20));
    const entry = { staticDone: false, memoryHashes: {} };
    const a = buildMemoryInjection(r.cfg, message(2, '资料1'), entry, r.memory);
    entry.staticDone = true; entry.memoryHashes = a.hashes;
    const b = buildMemoryInjection(r.cfg, message(3, '资料2'), entry, r.memory);
    assert.ok(b.text.includes('资料2'));
  });
  await test('prompt gives primary agent responsibility and demands success receipt before confirmation', () => {
    const p = buildPrompt(message(1), config({ memoryEnabled: true }), { includeStatic: true });
    assert.match(p, /qq_memory/); assert.match(p, /只有 SAVED 回执才能说/); assert.match(p, /impression/);
    assert.doesNotMatch(p, /正常聊天即可/);
  });
  await test('memory directory follows stateDir when left empty', () => {
    const data = path.join(root, 'state');
    assert.equal(resolveMemoryDir({ memoryDir: '' }, data), path.join(data, 'memory'));
    assert.equal(resolveMemoryDir({ memoryDir: '   ' }, data), path.join(data, 'memory'));
    assert.equal(resolveMemoryDir({}, data), path.join(data, 'memory'));
    const explicit = path.join(root, 'explicit-memory');
    assert.equal(resolveMemoryDir({ memoryDir: explicit }, data), explicit, '显式配置必须优先');
  });
  await test('房间不能替她署名：聊天里写不了 scope=self，读得到，收尾会话可以写', () => {
    const r = rig();
    // 普通房间回合：不在任何后台写者名单里。
    r.state.selfTurnSessions.clear();
    assert.throws(
      () => r.call({ action: 'upsert', scope: 'self', slot: 'me.stance.floor', version: 0, kind: 'stance',
        visibility: 'public', text: '我改主意了。' }),
      /后台/, '房间写自己的本子必须被拦，且提示要说清是后台在写',
    );
    // 读从不拦：她随时可以翻自己的本子，那是阅读，不是署名。
    r.state.memoryFlushSessions.add('session-a');
    assert.equal(r.call({ action: 'upsert', scope: 'self', slot: 'me.stance.floor', version: 0, kind: 'stance',
      visibility: 'public', text: '我改主意了。' }).status, 'SAVED');
    const read = r.call({ action: 'read', scope: 'self' });
    assert.ok(read.chars > 0, '收尾会话写下的条目应当读得到');
  });
  /**
   * 2026-11-01 线上：她想记「他很在意被叫狗」，引的是他前面两句话拼起来的证据
   * （中间还用 `___` 遮了一个词），校验只拿"触发本轮那一条"去比，永远比不上——
   * 连着两次 Error，31 秒的一轮全废在写不进本子上。人的引用本来就是跨句的。
   */
  await test('引用可以跨句：用 / 分几段、每段都真出现过，就写得进去', () => {
    const r = rig();
    const say = (id, text) => r.store.recordEvent({ conversation: 'group:10', kind: 'inbound',
      payload: { qq: '200', who: '甲', text, messageId: id }, deliverable: false });
    say('7', '你这是…在骂我？');
    say('8', '你这样说别人是狗别人是会不高兴的，你不知道吗？');
    const ok = r.call({ action: 'upsert', scope: 'user', slot: 'taboo.being_called_dog', version: 0,
      kind: 'explicit', text: '很在意被叫成狗',
      evidence: '你这是___在骂我？ / 你这样说别人是狗别人是会不高兴的' });
    assert.equal(ok.status, 'SAVED');
  });

  await test('编造的原话不会变成事实：降级成观察，并如实告诉她', () => {
    // 2026-11-01（用户：「怎么写是她的自由」）：不再用报错把她挡在门外——
    // 记不成事实就记成观察，回执里说清楚为什么。底线是"没原话撑腰的不能自称事实"。
    const r = rig();
    const out = r.call({ action: 'upsert', scope: 'user', slot: 'taboo.x', version: 0,
      kind: 'explicit', text: '编的', evidence: '他从来没说过这句话' });
    assert.equal(out.status, 'SAVED');
    assert.equal(out.kind, 'impression');
    assert.match(String(out.note ?? ''), /观察|没对上/u);
    const hit = r.call({ action: 'read' }).records.find((x) => x.slot === 'taboo.x');
    assert.equal(hit.kind, 'impression', '没对上原文的只能记成观察');
  });

  await test('自己的时间里也能记别人的事：指名 QQ 号即可，猜不出来才拦', () => {
    const r = rig({ conversation: 'self:account' });
    // 自主时间：origin 的发送者是她自己，宿主猜不出"他"是谁 —— 指名就能写。
    const ok = r.call({ action: 'upsert', scope: 'user', subject: '200', slot: 'taboo.dog', version: 0,
      kind: 'impression', text: '他好像很在意被叫狗' });
    assert.equal(ok.status, 'SAVED');
    assert.ok(r.memory.agent.latest('200').some((x) => x.slot === 'taboo.dog'));
    // 不说记谁 → 拦，且给出下一步；白名单外的人 → 拦。
    assert.throws(() => r.call({ action: 'upsert', scope: 'user', slot: 'x.y', version: 0,
      kind: 'impression', text: '谁' }), /subject/u);
    assert.throws(() => r.call({ action: 'upsert', scope: 'user', subject: '999999', slot: 'x.y', version: 0,
      kind: 'impression', text: '谁' }), /名单/u);
  });

  await test('learned：写对的本子；人物本拒收是结构拦截不是提示词约定', () => {
    const r = rig();
    // 群本当场就能记（房间里的她只能记别人和群——群知识正好属于这里）。
    assert.equal(r.call({ action: 'upsert', scope: 'group', slot: 'learn.docu', version: 0,
      kind: 'learned', text: '这个群不喜欢纪录片' }).status, 'SAVED');
    // 人物本拒收："学会的东西"没有主体落在某个人身上。
    assert.throws(() => r.call({ action: 'upsert', slot: 'learn.x', version: 0,
      kind: 'learned', text: '他教我的' }), /学会的东西不属于某个人/u);
    // self 本只有后台写者能写（与日记同一条边界），写进去的 public 不许带号码。
    assert.throws(() => r.call({ action: 'upsert', scope: 'self', slot: 'learn.priv', version: 0,
      kind: 'learned', visibility: 'public', text: '找 12345678 问问' }), /public 的 learned/u);
    assert.throws(() => r.call({ action: 'upsert', scope: 'self', slot: 'core.notlearned', version: 0,
      kind: 'note', text: '普通记事' }), /core\. 前缀/u);
    assert.equal(r.call({ action: 'upsert', scope: 'self', slot: 'core.learn.docu', version: 0,
      kind: 'learned', visibility: 'public', text: '发长文会被嫌刷屏' }).status, 'SAVED');
  });

  await test('注入：群教训独立成块，不挤记事；日记块不混 learned', () => {
    const r = rig();
    r.call({ action: 'upsert', scope: 'group', slot: 'learn.docu', version: 0,
      kind: 'learned', text: '这个群不喜欢纪录片' });
    r.call({ action: 'upsert', scope: 'group', slot: 'rhythm.m1', version: 0,
      kind: 'note', text: '群黑话备忘' });
    const entry = { staticDone: true, memoryHashes: {} };
    const out = buildMemoryInjection(r.cfg, message(2, '在吗'), entry, r.memory).text;
    assert.match(out, /【这个群教我的】[\s\S]*这个群不喜欢纪录片/);
    const notesBlock = out.split('【这个群的记事】')[1]?.split('【')[0] ?? '';
    assert.match(notesBlock, /群黑话备忘/);
    assert.doesNotMatch(notesBlock, /纪录片/, '记事块不混 learned');
    const learnedBlock = out.split('【这个群教我的】')[1]?.split('【')[0] ?? '';
    assert.match(learnedBlock, /纪录片/);
    assert.doesNotMatch(learnedBlock, /群黑话备忘/, '教训块不混 note');
  });

  await test('注入：private 的教训在写下它的房间可见，别的群看不到；pin 排在前面', () => {
    const r = rig();
    r.call({ action: 'upsert', scope: 'self', slot: 'core.learn.docu', version: 0,
      kind: 'learned', visibility: 'public', text: '发长文会被嫌刷屏' });
    r.call({ action: 'upsert', scope: 'self', slot: 'learn.local', version: 0,
      kind: 'learned', text: '在这儿学到的 privately' });
    const entry = { staticDone: true, memoryHashes: {} };
    const here = buildMemoryInjection(r.cfg, message(2, '在吗'), entry, r.memory).text;
    assert.match(here, /【我学会的】/);
    assert.match(here, /发长文会被嫌刷屏/);
    assert.match(here, /在这儿学到的 privately/, 'private 的 learned 回到写下它的房间该认得');
    const other = buildMemoryInjection(r.cfg, message(3, '在吗', 20), { staticDone: true, memoryHashes: {} },
      r.memory).text;
    assert.doesNotMatch(other, /在这儿学到的 privately/, 'private 的教训不出本群');
    assert.match(other, /发长文会被嫌刷屏/, 'public 的教训跟着她走所有群');
    const block = here.split('【我学会的】')[1] ?? '';
    assert.ok(block.indexOf('发长文会被嫌刷屏') < block.indexOf('在这儿学到的'), 'pin 优先于最新补位');
  });

  await test('注入：limit 5 硬顶，第 6 条留库不进块', () => {
    const r = rig();
    for (let i = 0; i < 6; i++) {
      r.call({ action: 'upsert', scope: 'group', slot: `learn.n${i}`, version: 0,
        kind: 'learned', text: `教训${i}` });
      // 拉开时间戳：n0 最旧、n5 最新——补位顺序才可断言。
      r.store.db.prepare('UPDATE bridge_agent_memories SET updated_at = ? WHERE slot = ?')
        .run(Date.now() + i * 60000, `learn.n${i}`);
    }
    const entry = { staticDone: true, memoryHashes: {} };
    const out = buildMemoryInjection(r.cfg, message(2, '在吗'), entry, r.memory).text;
    const block = out.split('【这个群教我的】')[1]?.split('【')[0] ?? '';
    const lines = block.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 5, '块里最多 5 条');
    assert.match(block, /教训5/, '最新的补位进块');
    assert.doesNotMatch(block, /教训0/, '最旧的被挤出块，但留在库里');
    assert.equal(r.memory.agent.latest('group:10').filter((x) => x.kind === 'learned').length, 6,
      '第 6 条还在库里，只是不注入');
  });

  await test('工具描述列出 learned 的触发条件与 core. 钉住语义', async () => {
    const r = rig();
    const { memoryTool } = await import('../lib/memory/tool.mjs');
    const tool = memoryTool({ memory: r.memory, registry: { byKey: new Map() }, store: r.store,
      config: r.cfg, state: { enabled: true, disposed: false, sourceLedger: r.memory.episodes } });
    assert.match(tool.description, /learned/u);
    assert.match(tool.description, /core\./u);
    assert.match(JSON.stringify(tool.parameters), /learned/u);
  });

} finally { for (const s of stores) s.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
