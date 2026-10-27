import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { flushMemoryBeforeRotate, shouldFlushMemory, __flushTest } from '../lib/memory/flush.mjs';
import { executionToolGuard } from '../lib/agent/execution-scope.mjs';
import { rig } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-flush-'));
const stores = [];
let passed = 0, failed = 0, n = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function setup(settings = {}, reply = '{"notes":[]}') {
  const store = new Store(path.join(root, String(n++), 'bridge.sqlite3'));
  stores.push(store);
  const r = rig({ memoryEnabled: true, rotateEveryTurns: 45, ...settings }, reply, store);
  const memory = new MemoryStore(r.ctx, { ...r.config, memoryDir: path.join(root, String(n++) + '-memory') }, store);
  return { ...r, store, memory };
}
const entryOf = (r, key = 'group:10') => r.registry.entry(key);

try {
  await test('轮换判定：未到轮数不跑，到了才跑，同一个窗口只跑一次', async () => {
    const base = { sessionId: 's1', turns: 44 };
    const cfg = { memoryEnabled: true, rotateEveryTurns: 45, conversationContextMaxChars: 60000 };
    assert.equal(shouldFlushMemory(cfg, base), false);
    assert.equal(shouldFlushMemory(cfg, { ...base, turns: 45 }), true);
    assert.equal(shouldFlushMemory(cfg, { ...base, turns: 3, forceRotate: true }), true);
    assert.equal(shouldFlushMemory(cfg, { ...base, turns: 45, memoryFlushSession: 's1' }), false);
    assert.equal(shouldFlushMemory({ ...cfg, memoryFlushEnabled: false }, { ...base, turns: 45 }), false);
    assert.equal(shouldFlushMemory({ ...cfg, memoryEnabled: false }, { ...base, turns: 45 }), false);
    assert.equal(shouldFlushMemory(cfg, { turns: 45 }), false);
  });

  await test('字符预算只在没有固定轮数时才算轮换点', async () => {
    const cfg = { memoryEnabled: true, rotateEveryTurns: 45, conversationContextMaxChars: 60000 };
    // 固定生命周期：字符超了也不换会话，所以绝不能在这里收尾（收尾提示会说谎，
    // 而且会把这一窗口仅有的一次收尾机会用掉）。
    assert.equal(shouldFlushMemory(cfg, { sessionId: 's1', turns: 12, contextChars: 67071 }), false);
    // 线上真实形状：第 30 轮才换。
    const live = { ...cfg, rotateEveryTurns: 30 };
    assert.equal(shouldFlushMemory(live, { sessionId: 's1', turns: 12, contextChars: 67071 }), false);
    assert.equal(shouldFlushMemory(live, { sessionId: 's1', turns: 30, contextChars: 67071 }), true);
    // 关掉轮数（rotateEveryTurns: 0）时，字符预算就是唯一的轮换点。
    const unlimited = { ...cfg, rotateEveryTurns: 0 };
    assert.equal(shouldFlushMemory(unlimited, { sessionId: 's1', turns: 12, contextChars: 67071 }), true);
    // 任务 Session 用 taskContextMaxChars，同样按字符预算换。
    assert.equal(shouldFlushMemory({ ...cfg, taskContextMaxChars: 10000 },
      { sessionId: 's1', turns: 12, contextChars: 10001, stableTaskId: 't1' }), true);
    // 归档会话不收模型步骤，收尾只会白等一次超时。
    const archivedCtx = { get: (n) => (n === 'workspaceRegistry' ? { archivedSessionIds: ['s1'] } : undefined) };
    assert.equal(shouldFlushMemory(live, { sessionId: 's1', turns: 30, contextChars: 67071 }, archivedCtx), false);
  });

  await test('解析：只收窗口里出现过的人，坏条目逐条丢弃', async () => {
    const { parseNotes } = __flushTest;
    const raw = JSON.stringify({ notes: [
      { scope: 'user', qq: '200', slot: 'profile.city', text: '在成都上班' },
      { scope: 'user', qq: '999', slot: 'profile.city', text: '这个人没在窗口里出现过' },
      { scope: 'group', slot: 'rhythm.close', text: '凌晨两点最热闹' },
    ] });
    const notes = parseNotes(raw, { key: 'group:10', allowedQqs: ['200'], sessionId: 's1' });
    assert.equal(notes.length, 2);
    assert.equal(notes[0].subject, '200');
    assert.equal(notes[1].subject, 'group:10');
    assert.deepEqual(notes.map((x) => x.kind), ['note', 'note']);
    // 依据是合成 id，撤回级联不会误删；但 note 仍要求有 sources。
    assert.match(notes[0].sources[0].messageId, /^flush:s1$/);
  });

  await test('解析：可见性只对 self 生效，默认 private', async () => {
    const { parseNotes } = __flushTest;
    const raw = JSON.stringify({ notes: [
      { scope: 'self', slot: 'social.timing', text: '别在别人说忙时追问', visibility: 'public' },
      { scope: 'self', slot: 'social.pace', text: '我在群里话太多' },
      { scope: 'group', slot: 'jargon.class', text: '他们把打游戏叫上课', visibility: 'public' },
    ] });
    const notes = parseNotes(raw, { key: 'group:10', allowedQqs: [], sessionId: 's1' });
    assert.equal(notes[0].visibility, 'public');
    assert.equal(notes[1].visibility, 'private');
    // 群本没有可见性维度：即使模型乱填 public，也一律 private。
    assert.equal(notes[2].visibility, 'private');
  });

  await test('解析：文本截断、非法 slot 丢弃、超过三条只取三条', async () => {
    const { parseNotes, MAX_NOTES } = __flushTest;
    assert.equal(MAX_NOTES, 3);
    const raw = JSON.stringify({ notes: [
      { scope: 'group', slot: 'a.b', text: 'x'.repeat(400) },
      { scope: 'group', slot: 'c.d', text: '第三条' },
      { scope: 'group', slot: 'e.f', text: '第四条' },
      { scope: 'group', slot: 'g.h', text: '第五条应被截断掉' },
    ] });
    const notes = parseNotes(raw, { key: 'group:10', allowedQqs: [], sessionId: 's1' });
    assert.equal(notes.length, 3);
    assert.equal(notes[0].slot, 'a.b');
    assert.equal(notes[0].text.length, 120);
    assert.equal(notes.some((x) => x.text.includes('第五条')), false);
    // 坏 slot 单独丢弃，且不会挤掉后面的合法条目。
    const mixed = JSON.stringify({ notes: [
      { scope: 'group', slot: 'BAD SLOT', text: '非法槽' },
      { scope: 'group', slot: 'ok.slot', text: '合法条目' },
    ] });
    const kept = parseNotes(mixed, { key: 'group:10', allowedQqs: [], sessionId: 's1' });
    assert.equal(kept.length, 1);
    assert.equal(kept[0].slot, 'ok.slot');
  });

  await test('非群会话不能写群本，非 JSON 一律无产出', async () => {
    const { parseNotes } = __flushTest;
    const raw = JSON.stringify({ notes: [{ scope: 'group', slot: 'a.b', text: '不属于这个会话' }] });
    assert.equal(parseNotes(raw, { key: 'user:200', allowedQqs: ['200'], sessionId: 's1' }).length, 0);
    assert.equal(parseNotes('我记住了：他叫小明', { key: 'group:10', allowedQqs: ['200'], sessionId: 's1' }).length, 0);
  });

  await test('端到端：收尾回合写入群本，且不残留标记', async () => {
    const r = setup({}, JSON.stringify({ notes: [
      { scope: 'group', slot: 'rhythm.close', text: '凌晨两点最热闹' },
      { scope: 'user', qq: '200', slot: 'profile.city', text: '在成都上班' },
    ] }));
    const entry = entryOf(r);
    entry.sessionId = 's1';
    entry.turns = 45;
    entry.window = [{ qq: '200', who: '甲', text: '这几点人最多', bot: false, at: 1, messageId: '1' }];
    const result = await flushMemoryBeforeRotate({ ctx: r.ctx, config: r.config, registry: r.registry,
      state: r.state, memory: r.memory, stats: r.stats, key: 'group:10' });
    assert.equal(result.ran, true);
    assert.equal(result.notes, 2);
    assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0].content[0].text, /上下文即将清空/);
    assert.equal(r.memory.agent.latest('group:10').length, 1);
    assert.equal(r.memory.agent.latest('200').length, 1);
    assert.equal(r.state.memoryFlushSessions.size, 0);
    assert.equal(entry.memoryFlushSession, 's1');
  });

  await test('同一个窗口不重复收尾', async () => {
    const r = setup({}, JSON.stringify({ notes: [{ scope: 'group', slot: 'a.b', text: '一次就够' }] }));
    const entry = entryOf(r);
    entry.sessionId = 's1'; entry.turns = 45; entry.window = [];
    await flushMemoryBeforeRotate({ ctx: r.ctx, config: r.config, registry: r.registry,
      state: r.state, memory: r.memory, stats: r.stats, key: 'group:10' });
    const again = await flushMemoryBeforeRotate({ ctx: r.ctx, config: r.config, registry: r.registry,
      state: r.state, memory: r.memory, stats: r.stats, key: 'group:10' });
    assert.equal(again.ran, false);
    assert.equal(again.reason, 'not-due');
    assert.equal(r.prompts.length, 1);
  });

  await test('收尾回合里发送工具被拦截（不会真的发进群）', async () => {
    const r = setup();
    const state = { memoryFlushSessions: new Set(['s1']) };
    const exec = { name: 'mcp__qq__qq_say', arguments: { text: '这句不该发出去' },
      agent: { session: { id: 's1' } } };
    assert.match(executionToolGuard(r.store, r.config, exec, state), /收尾回合不允许对外动作/);
    // 不在收尾标记里时，普通会话没有 execution source，守卫照旧放行。
    assert.equal(executionToolGuard(r.store, r.config, exec, { memoryFlushSessions: new Set() }), undefined);
  });
} finally {
  for (const store of stores) { try { store.db.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nmemory-flush: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
