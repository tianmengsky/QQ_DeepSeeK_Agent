/**
 * 观测三件套的契约测试：结果账、准入账、以及两者进面板的接口。
 *
 * 钉的是"面板说的话必须能对上事实"：
 *   · 一句判断判了接，最后到底发没发得查得到（turn-trace + auxDecisions 的 join）；
 *   · 一条消息没进回合，是被哪道闸挡的（ingress-log）；
 *   · 「现在醒一次」这个管理动作在主动层关着/缺依赖时要**明确拒绝**，不能假装成功。
 *
 * 全部只动内存与假依赖，不碰真库、不发真消息。
 */
import assert from 'node:assert/strict';

import {
  recordAuxCall,
  auxDecisions,
  resetAuxHealth,
} from '../lib/agent/aux-attribution.mjs';
import {
  recordTurnOutcome,
  turnOutcome,
  turnOutcomes,
  resetTurnTrace,
  END_REASON_LABELS,
} from '../lib/agent/turn-trace.mjs';
import {
  recordAdmission,
  admissionSnapshot,
  resetAdmissionLog,
  DROP_REASONS,
  INGRESS_REASONS,
} from '../lib/agent/ingress-log.mjs';
import { createAdminActions, ACTIONS } from '../lib/admin/actions.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (error) {
    failed++;
    console.error('  ✗ ' + name, error);
  }
}

const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-trace-'));

try {
  await test('结果账：按 turnId 取回，结尾原因翻成人话', () => {
    resetTurnTrace();
    recordTurnOutcome({ turnId: 'k#t1', conversation: 'group:1', endReason: 'queued',
      queued: true, bubbles: 2, chars: 268, ok: true });
    recordTurnOutcome({ turnId: 'k#t2', conversation: 'group:1', endReason: 'agent-silent',
      queued: false, ok: false });
    const sent = turnOutcome('k#t1');
    assert.equal(sent.queued, true);
    assert.equal(sent.bubbles, 2);
    assert.equal(turnOutcome('k#t2').label, END_REASON_LABELS['agent-silent']);
    assert.equal(turnOutcome('没有这轮'), null);
    // 楼层复核撤掉的原因带参数，要能读出来
    recordTurnOutcome({ turnId: 'k#t3', endReason: 'floor:superseded' });
    assert.match(turnOutcome('k#t3').label, /^楼层复核撤了（superseded）/);
    assert.equal(turnOutcomes().length, 3);
  });

  await test('结果账：环形缓冲封顶，旧的不涨内存', () => {
    resetTurnTrace();
    for (let i = 0; i < 200; i++) recordTurnOutcome({ turnId: 'k#' + i, endReason: 'queued', queued: true });
    assert.equal(turnOutcomes().length, 120);
    assert.equal(turnOutcome('k#0'), null, '最旧的应该被挤掉');
    assert.ok(turnOutcome('k#199'));
  });

  await test('判断流：带 turnId 的裁决能查到结果，不带的就不硬凑', () => {
    resetAuxHealth();
    resetTurnTrace();
    recordTurnOutcome({ turnId: 'k#t9', endReason: 'queued', queued: true, bubbles: 3, ok: true });
    recordAuxCall('reply-decision', { ok: true, verdict: '接话', reason: '在问她', turnId: 'k#t9' });
    recordAuxCall('reply-decision', { ok: true, verdict: '不接', reason: '群友闲聊' });
    const rows = auxDecisions();
    const withTurn = rows.find((row) => row.turnId === 'k#t9');
    assert.equal(withTurn.outcome.bubbles, 3, '判了接 → 真发了 3 个气泡');
    const without = rows.find((row) => !row.turnId);
    assert.equal(without.outcome, null);
    // 新记录没有原因 / 没 turnId 时不能编一个对象出来
    assert.equal(rows.every((row) => row.outcome === null || typeof row.outcome === 'object'), true);
  });

  await test('准入账：分得清"没进回合"和"进了回合"，并给出原因明细', () => {
    resetAdmissionLog();
    recordAdmission({ conversation: 'group:1', reason: 'turn', who: '阿柚', qq: '1', text: '在吗' });
    recordAdmission({ conversation: 'group:1', reason: 'buffered', who: '老猫', qq: '2', text: '我先去洗澡了' });
    recordAdmission({ conversation: 'group:1', reason: 'duplicate', who: '阿柚', qq: '1', text: '在吗' });
    const snap = admissionSnapshot();
    assert.equal(snap.total, 3);
    assert.equal(snap.dropped, 2, 'buffered + duplicate 算没进回合，turn 不算');
    assert.equal(snap.rows[0].reason, 'duplicate', '新的在前');
    assert.equal(snap.rows[0].label, INGRESS_REASONS.duplicate);
    const counts = Object.fromEntries(snap.reasons.map((item) => [item.reason, item.count]));
    assert.deepEqual(counts, { turn: 1, buffered: 1, duplicate: 1 });
    // 摘要要截断，别把整段正文搬进内存
    recordAdmission({ conversation: 'group:1', reason: 'passive', text: 'x'.repeat(300) });
    assert.equal(admissionSnapshot().rows[0].text.length, 80);
  });

  await test('准入账：环形缓冲封顶', () => {
    resetAdmissionLog();
    for (let i = 0; i < 200; i++) recordAdmission({ conversation: 'group:1', reason: 'turn', text: String(i) });
    assert.equal(admissionSnapshot().total, 140);
  });

  await test('管理动作：主动层不在/关着/缺依赖时明确拒绝，不假装成功', async () => {
    const admin = createAdminActions({ config: {}, dataDir: auditDir, clock: () => 1000 });
    assert.equal(ACTIONS.some((item) => item.id === 'proactive.tick'), true, '动作要登记，面板靠它渲染按钮');

    let result = await admin.run('proactive.tick', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /没启用/);

    admin.bind({ state: { proactive: { enabled: false } } });
    result = await admin.run('proactive.tick', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /关着/);

    admin.bind({ state: { proactive: { enabled: true, available: false } } });
    result = await admin.run('proactive.tick', {});
    assert.equal(result.ok, false);
    assert.match(result.error, /缺依赖/);

    // 真跑一次：必须 force，且把结果原样带回来
    let forced = null;
    admin.bind({ state: { proactive: { enabled: true, available: true,
      tick: async (options) => { forced = options; return { ran: true, action: 'none', reason: 'no-candidates' }; } } } });
    result = await admin.run('proactive.tick', {});
    assert.equal(result.ok, true);
    assert.equal(result.result.action, 'none');
    assert.equal(forced.force, true, '面板按钮必须是不等钟的强制叫醒');
  });

  await test('管理动作：会落审计，重放不重复执行', async () => {
    let calls = 0;
    const admin = createAdminActions({ config: {}, dataDir: auditDir, clock: () => 2000 });
    admin.bind({ state: { proactive: { enabled: true, available: true,
      tick: async () => { calls++; return { ran: true, action: 'none' }; } } } });
    await admin.run('proactive.tick', {}, { idemKey: 'wake-1', memo: '面板手动叫醒' });
    const replay = await admin.run('proactive.tick', {}, { idemKey: 'wake-1' });
    assert.equal(calls, 1, '同一个幂等键不能叫醒两次（每次都花一次模型调用）');
    assert.equal(replay.replay, true);
    const audit = admin.snapshot().recent;
    assert.ok(audit.some((row) => row.action === 'proactive.tick' && row.memo === '面板手动叫醒'));
  });
  await test('面板读的字段，快照里必须有（键名漂移会静默把整张卡藏起来）', async () => {
    /**
     * 2026-11-01 的真实事故：快照挂在 `memory.proactive`，面板读 `tasks.proactive`，
     * 键名对不上 → 卡片**整块消失**，而预览里是手写数据，把 bug 挡住了。
     * 这条测试直接比对"面板读了哪些字段"和"快照到底给了哪些字段"，
     * 任何一边改名都会立刻红，而不是等人发现"怎么没看见"。
     */
    const { proactiveSnapshot } = await import('../lib/application/proactive.mjs');
    const app = fs.readFileSync(new URL('../lib/panel/app.js', import.meta.url), 'utf8');
    const between = (from, to) => {
      const start = app.indexOf(from);
      assert.ok(start >= 0, '找不到片段：' + from);
      return app.slice(start, app.indexOf(to, start));
    };
    const proactiveBlock = between('/* —— 自主层：钟、账、学习 —— */', '/* —— 会话表 —— */');
    assert.match(proactiveBlock, /S\(\)\.proactive/, '必须读顶层 proactive');
    assert.doesNotMatch(proactiveBlock, /tasks\?\.proactive|memory\?\.proactive/);

    const snap = proactiveSnapshot({});
    const fields = [...new Set([...proactiveBlock.matchAll(/\bp\.([A-Za-z_]+)/g)].map((m) => m[1]))];
    assert.ok(fields.length >= 8, '应该读到不少字段，实际：' + fields.join(','));
    for (const field of fields) assert.ok(field in snap, '快照缺字段：p.' + field);

    const admissionBlock = between('/* —— 消息准入：一条消息去了哪儿 —— */', '/* —— 自主层');
    const admission = admissionSnapshot();
    const admFields = [...new Set([...admissionBlock.matchAll(/\bdata\.([A-Za-z_]+)/g)].map((m) => m[1]))];
    for (const field of admFields) assert.ok(field in admission, '准入快照缺字段：data.' + field);
  });

  await test('两张卡在拿不到数据时也不能整块消失', () => {
    /**
     * 静默隐藏是最坏的失败方式：用户看到的是"没有这个功能"，而不是"这里出问题了"。
     */
    const app = fs.readFileSync(new URL('../lib/panel/app.js', import.meta.url), 'utf8');
    for (const fn of ['renderProactive', 'renderAdmission']) {
      const body = app.slice(app.indexOf('function ' + fn + '('));
      const head = body.slice(0, body.indexOf('\n}\n'));
      assert.doesNotMatch(head, /dataset\.hide = 'true'/, fn + ' 不该在缺数据时把自己藏起来');
      assert.match(head, /没有.*段|没有读数|多半是/, fn + ' 缺数据时要给出人话解释');
    }
  });
} finally {
  fs.rmSync(auditDir, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
