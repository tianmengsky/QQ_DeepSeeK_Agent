import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { LearnedReviewer, __learnedReviewTest } from '../lib/memory/learned-review.mjs';
import { config } from './helpers/bridge.mjs';

const { collectLearned, buildAsk, parseOps } = __learnedReviewTest;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-review-'));
let passed = 0, failed = 0, sequence = 0;
const stores = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function rig() {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'),
    groupEnabled: true, groups: ['10'], learnedReviewEnabled: true });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const reviewer = new LearnedReviewer({ logger: { info() {}, warn() {} }, get: () => null },
    cfg, memory, {}, store);
  return { store, cfg, memory, reviewer };
}
/** 直接经 agent.write 放 learned 条目，绕过工具层（等价于她写完后的库里状态）。 */
function put(memory, { subject, slot, text, at = Date.now(), visibility = 'private', kind = 'learned', sources }) {
  const current = memory.agent.latest(subject).find((r) => r.slot === slot);
  memory.agent.write({ subject, slot, version: current?.version ?? 0, kind, text,
    visibility, sources: sources ?? [{ conversation: subject === 'self' ? 'group:10' : subject,
      messageId: 'seed:' + slot, qq: '', who: '', at }] });
  // write() 不收 updated_at（它自己打时间戳）；为了测 stale/补位顺序，直接改表。
  memory.store.db.prepare('UPDATE bridge_agent_memories SET updated_at = ? WHERE slot = ?')
    .run(at, slot);
}

try {
  await test('collectLearned：只收活着的 learned，stale/今天新学/pinned 标记正确', () => {
    const r = rig(), now = Date.now();
    put(r.memory, { subject: 'group:10', slot: 'learn.docu', text: '这个群不喜欢纪录片', at: now });
    put(r.memory, { subject: 'self', slot: 'core.learn.docu', text: '发长文会被嫌刷屏',
      visibility: 'public', at: now - 20 * 86400000 });
    put(r.memory, { subject: 'group:10', slot: 'note.e1', text: '这不是 learned', kind: 'note' });
    const rows = collectLearned(r.memory, { now, staleDays: 14 });
    assert.equal(rows.length, 2, '人物本与 note 不进清单');
    const docu = rows.find((x) => x.subject === 'group:10');
    assert.equal(docu.pinned, false);
    assert.equal(docu.stale, false);
    assert.equal(docu.updatedToday, true);
    const core = rows.find((x) => x.subject === 'self');
    assert.equal(core.pinned, true);
    assert.equal(core.stale, true, '20 天没修订算 stale');
    assert.equal(core.updatedToday, false);
  });

  await test('parseOps：坏条目逐条丢弃，subject/slot 必须在清单里，上限生效', () => {
    const rows = [
      { subject: 'group:10', slot: 'learn.a', version: 1, text: '旧结论', pinned: false, stale: true },
      { subject: 'self', slot: 'core.learn.b', version: 1, text: '钉住的', pinned: true },
    ];
    const raw = JSON.stringify({ ops: [
      { op: 'forget', subject: 'group:10', slot: 'learn.a' },
      { op: 'rewrite', subject: 'group:10', slot: 'learn.a', text: '这个结论改一版' },
      { op: 'rewrite', subject: 'group:10', slot: 'ghost', text: '编的槽' },
      { op: 'pin', subject: 'self', slot: 'core.learn.b' },
      { op: 'unpin', subject: 'group:10', slot: 'learn.a' },
      { op: 'promote', subject: 'self', slot: 'core.learn.b', text: 'self 本没有可提升的' },
      { op: 'promote', subject: 'group:10', slot: 'learn.a', text: '通用结论' },
      { op: 'nonsense', subject: 'group:10', slot: 'learn.a' },
    ] });
    const ops = parseOps(raw, { rows, maxOps: 12 });
    assert.deepEqual(ops.map((x) => x.op), ['forget', 'rewrite', 'promote'],
      'ghost 槽/重复 pin/unpin 没钉的/promote self/未知 op 全部丢弃');
    const capped = parseOps(JSON.stringify({ ops: Array.from({ length: 20 }, () =>
      ({ op: 'forget', subject: 'group:10', slot: 'learn.a' })) }), { rows, maxOps: 3 });
    assert.equal(capped.length, 3, 'maxOps 封顶');
  });

  await test('pin = 写新槽 + forget 旧槽，保留 sources；版本对不上就放弃', async () => {
    const r = rig(), now = Date.now();
    const sources = [{ conversation: 'group:10', messageId: 'seed:1', qq: '', who: '', at: now }];
    put(r.memory, { subject: 'group:10', slot: 'learn.docu', text: '这个群不喜欢纪录片', sources });
    const rows = collectLearned(r.memory, { now, staleDays: 14 });
    const applied = await r.reviewer.applyOps(
      [{ op: 'pin', subject: 'group:10', slot: 'learn.docu', row: rows[0] }], { now });
    assert.equal(applied, 1);
    const latest = r.memory.agent.latest('group:10').filter((x) => !x.deleted);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].slot, 'core.learn.docu');
    assert.equal(latest[0].version, 1, '新槽从头计版本');
    assert.deepEqual(latest[0].sources, sources, '出处证据不丢');
    assert.ok(r.memory.agent.latest('group:10').some((x) => x.slot === 'learn.docu' && x.deleted),
      '旧槽标记 forget，不是凭空消失');
    // 版本漂移：清单生成后她又改过 → 放弃这条操作，不覆盖。
    put(r.memory, { subject: 'group:10', slot: 'learn.other', text: '另一条', at: now });
    const rows2 = collectLearned(r.memory, { now, staleDays: 14 });
    const other = rows2.find((x) => x.slot === 'learn.other');
    r.memory.agent.write({ subject: 'group:10', slot: 'learn.other', version: other.version,
      kind: 'learned', text: '她又改了一版', sources: other.sources });
    const applied2 = await r.reviewer.applyOps(
      [{ op: 'rewrite', subject: 'group:10', slot: 'learn.other', text: '夜里整理的版本', row: other }], { now });
    assert.equal(applied2, 0, '版本对不上不动笔');
    assert.equal(r.memory.agent.latest('group:10').find((x) => x.slot === 'learn.other' && !x.deleted).text,
      '她又改了一版');
  });

  await test('promote：群教训提升进通用本，public、脱敏、同名槽不覆盖', async () => {
    const r = rig(), now = Date.now();
    put(r.memory, { subject: 'group:10', slot: 'learn.longpost', text: '别在群里发长图' });
    const rows = collectLearned(r.memory, { now, staleDays: 14 });
    const applied = await r.reviewer.applyOps(
      [{ op: 'promote', subject: 'group:10', slot: 'learn.longpost', text: '发长图会被嫌刷屏，控制在 3 张内',
        row: rows.find((x) => x.slot === 'learn.longpost') }], { now });
    assert.equal(applied, 1);
    const promoted = r.memory.agent.latest('self').find((x) => x.slot === 'learn.longpost');
    assert.ok(promoted, '提升进 self 本');
    assert.equal(promoted.visibility, 'public');
    // 再提升同名槽：不覆盖已有条目。
    put(r.memory, { subject: 'group:10', slot: 'learn2.x', text: '另一条' });
    const rows2 = collectLearned(r.memory, { now, staleDays: 14 });
    const applied2 = await r.reviewer.applyOps(
      [{ op: 'promote', subject: 'group:10', slot: 'learn.longpost', text: '想覆盖已有结论',
        row: rows2.find((x) => x.slot === 'learn.longpost') }], { now });
    assert.equal(applied2, 0, '同名槽已存在就不动笔');
    assert.equal(r.memory.agent.latest('self').find((x) => x.slot === 'learn.longpost').text,
      '发长图会被嫌刷屏，控制在 3 张内');
  });

  await test('due：一天一次；傍晚后才整理今天；隔天补跑', () => {
    const r = rig();
    const evening = new Date('2026-11-01T21:30:00').getTime();
    assert.equal(r.reviewer.due(evening).due, true, '从没跑过 → 跑');
    r.reviewer.state.day = '2026-11-01'; r.reviewer.state.lastAttempt = 0;
    assert.equal(r.reviewer.due(evening).due, false, '当天跑过就不再跑');
    const morning = new Date('2026-11-02T09:00:00').getTime();
    r.reviewer.state.day = '2026-11-01';
    assert.equal(r.reviewer.due(morning).reason, 'wait-evening', '昨天的账今天傍晚再整');
    const twoDays = new Date('2026-11-04T09:00:00').getTime();
    assert.equal(r.reviewer.due(twoDays).due, true, '隔两天不再等晚上，立刻补');
  });

  await test('buildAsk：清单带标记与操作说明；空清单也说清楚', () => {
    const ask = buildAsk({ rows: [{ subject: 'group:10', slot: 'learn.docu', version: 1,
      text: '这个群不喜欢纪录片', pinned: false, stale: true, updatedToday: false, updatedAgoDays: 20 }],
      staleDays: 14, maxOps: 12 });
    assert.match(ask, /learn\.docu/);
    assert.match(ask, /20 天没修订/);
    assert.match(ask, /\{"ops":\[\]\}/);
    assert.match(buildAsk({ rows: [] }), /还一条都没有/);
  });

} finally { for (const s of stores) s.db.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
