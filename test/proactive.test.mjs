/**
 * 主动层：没人问她的时候，她自己决定要不要开口。
 *
 * 钉的是行为，不是文案：
 *   · 钟到点才醒，间隔带抖动（不是整点闹钟）；
 *   · 候选只挑**安静很久**、今天还没主动过、回应率不为 0 的窗口；
 *   · 模型说 none 就不发（`none` 是默认答案，不是失败）；
 *   · 发出去的那条会**写回该窗口的 events**（下次醒来认得出是自己说的）；
 *   · 窗口在忙（有未读/刚说完话）就退让，不抢；
 *   · 发完 15 分钟回查有没有人接，结果决定下一轮还主不主动。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import {
  ProactiveHost,
  PROACTIVE_STATE_KEY,
  proactiveSnapshot,
  frequencyFactor,
  jitteredDelay,
  nextDelay,
  engagementOf,
} from '../lib/application/proactive.mjs';
import { config } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-proactive-'));
const stores = [];
const realFetch = globalThis.fetch;
let passed = 0;
let failed = 0;
let sequence = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`, error);
  }
}

/** 假模型：直接吐一行 JSON。 */
function fakeLlm(verdict, { fail = false } = {}) {
  const text = typeof verdict === 'string' ? verdict : JSON.stringify(verdict);
  return {
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          if (fail) {
            const error = new Error('upstream exploded');
            error.code = 'ECONNRESET';
            throw error;
          }
          yield { type: 'text-delta', text };
          yield { type: 'done' };
        },
      };
    },
  };
}

/**
 * 假 OneBot + 假B站。
 *
 * 两个都要桩：发送走 `send_group_msg` / `send_private_msg`，
 * 视频走 `api.bilibili.com/x/web-interface/ranking/v2`。
 */
function fakeNet({ bili = [], failSend = false } = {}) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('api.bilibili.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { list: bili } }),
      };
    }
    const action = target.split('/').pop();
    let params = {};
    try { params = JSON.parse(init.body ?? '{}'); } catch { /* 空 body */ }
    if (failSend) throw new Error('connect ECONNREFUSED');
    sent.push({ action, params });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 5000 + sent.length } }),
    };
  };
  return sent;
}

function rankingItem(bvid, title, view = 200000) {
  return {
    bvid,
    title,
    owner: { name: '某个UP' },
    desc: '简介',
    stat: { view, danmaku: 10 },
    duration: 300,
    tname: '动物',
  };
}

function setup({ settings = {}, llm = fakeLlm({ action: 'none', why: '现在没必要' }), entries = {} } = {}) {
  const dir = path.join(root, String(sequence++));
  fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3'));
  stores.push(store);
  const cfg = config({
    memoryEnabled: true,
    memoryDir: path.join(dir, 'memory'),
    groupEnabled: true,
    groups: ['10', '11'],
    privateEnabled: true,
    users: ['200'],
    onebotHttp: 'http://127.0.0.1:2112',
    proactiveEnabled: true,
    proactiveMode: 'prompt',
    proactiveIntervalMs: 3600000,
    proactiveJitterPct: 0.4,
    proactiveQuietHours: 8,
    proactiveCooldownMs: 0,
    proactiveDailyMax: 4,
    proactiveBiliEnabled: false,
    proactiveBiliKeywords: [],
    ...settings,
  });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const ctx = {
    disposed: false,
    logger: { info() {}, warn() {} },
    get: (name) => {
      if (name === 'llm') return llm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      return undefined;
    },
  };
  const stats = {};
  const registry = {
    entry: (key) => entries[key] ?? { window: [], recalledIds: [], pending: [], awakeUntil: 0 },
    persist: () => true,
    run: async (key, fn) => fn(),
  };
  const state = { enabled: true, disposed: false };
  const host = new ProactiveHost(ctx, cfg, registry, state, memory, stats, store);
  const rows = (conversation, kind = null) => store.db
    .prepare(`SELECT * FROM events WHERE conversation = ?${kind ? ' AND kind = ?' : ''} ORDER BY id`)
    .all(...(kind ? [conversation, kind] : [conversation]));
  const proactive = () => store.db.prepare('SELECT * FROM proactive ORDER BY id').all();
  return { store, cfg, memory, ctx, stats, registry, state, host, rows, proactive };
}

/** 往会话里塞一条"很多小时前"的消息，让 conversations 表的 last_message_at 生效。 */
function quietFor(store, conversation, hours, text = '有人吗', now = Date.now()) {
  store.recordEvent({
    conversation,
    kind: conversation.startsWith('group:') ? 'group_message' : 'private_message',
    payload: { text, who: '甲', qq: '111', messageId: `${conversation}:${hours}` },
    createdAt: now - hours * 3600000,
  });
}

try {
  await test('频率闸：没被理过就停，偶尔有人接就减半，接得多就照常', () => {
    const now = Date.now();
    assert.equal(frequencyFactor([], {}, now).factor, 1);
    // 两次主动、零回应 —— 停。
    const quiet = [
      { status: 'sent', outcome: 'quiet', created_at: now - 86400000 },
      { status: 'sent', outcome: 'quiet', created_at: now - 2 * 86400000 },
    ];
    const stopped = frequencyFactor(quiet, { proactiveProbeDays: 0 }, now);
    assert.equal(stopped.factor, 0);
    assert.equal(stopped.stopped, true);
    // 探一次：最后一次主动是 40 天前，30 天闸已过。
    const old = [
      { status: 'sent', outcome: 'quiet', created_at: now - 40 * 86400000 },
      { status: 'sent', outcome: 'quiet', created_at: now - 41 * 86400000 },
    ];
    assert.equal(frequencyFactor(old, { proactiveProbeDays: 30 }, now).factor, 0.25);
    assert.equal(frequencyFactor(quiet, { proactiveProbeDays: 30 }, now).factor, 0);
    // 一半被接住 —— 照常。
    const half = [
      { status: 'sent', outcome: 'replied', created_at: now - 86400000 },
      { status: 'sent', outcome: 'quiet', created_at: now - 2 * 86400000 },
    ];
    assert.equal(frequencyFactor(half, {}, now).factor, 1);
    // 偶尔被接住（1/4 = 25%）—— 减半。
    const rare = [
      { status: 'sent', outcome: 'replied', created_at: now },
      ...Array.from({ length: 3 }, (_, i) => ({ status: 'sent', outcome: 'quiet', created_at: now - i * 1000 })),
    ];
    assert.equal(frequencyFactor(rare, {}, now).factor, 0.5);
  });

  await test('间隔有抖动，且不会短到刷屏', () => {
    const base = 3600000;
    assert.equal(jitteredDelay(base, 0.4, () => 0), 2160000);
    assert.equal(jitteredDelay(base, 0.4, () => 1), 5040000);
    assert.equal(jitteredDelay(1000, 0.4, () => 0), 60000);
  });

  /**
   * 2026-11-01 用户改口径：不要"一小时 ±40%"，要每次 30~60 分钟之间随机。
   * 两端都要钉住——否则某次调参把它写成固定周期，测试也看不出来。
   */
  await test('倒计时是 30~60 分钟之间的随机值，不是周期抖动', () => {
    const cfg = { proactiveIntervalMinMs: 1800000, proactiveIntervalMaxMs: 3600000 };
    assert.equal(nextDelay(cfg, () => 0), 1800000);
    assert.ok(nextDelay(cfg, () => 0.999999) >= 3590000, '接近上界时应落到 60 分钟附近');
    const mid = nextDelay(cfg, () => 0.5);
    assert.ok(mid > 2600000 && mid < 2800000, `中点应落在 27 分钟附近，实际 ${mid}`);
    for (let i = 0; i < 20; i++) {
      const value = nextDelay(cfg);
      assert.ok(value >= 1800000 && value <= 3600000, `第 ${i} 次越界：${value}`);
    }
    // 只配了老字段的配置仍走抖动路径，不能直接崩。
    assert.equal(nextDelay({ proactiveIntervalMs: 3600000, proactiveJitterPct: 0.4 }, () => 0), 2160000);
  });

  await test('"有人接"只认别人说的：她自己那条不算回应', () => {
    const since = 1000;
    assert.equal(engagementOf([{ kind: 'self_message', createdAt: 2000, payload: { text: '我自己说的' } }], since), false);
    assert.equal(engagementOf([{ kind: 'group_message', createdAt: 2000, payload: { qq: '111', text: '接一句' } }], since), true);
    assert.equal(engagementOf([{ kind: 'group_message', createdAt: 500, payload: { qq: '111' } }], since), false);
  });

  await test('没到点就不醒', async () => {
    const s = setup();
    const now = Date.now();
    // 先落"下一轮在 1 分钟后"，再构造宿主（构造时从 SQLite 读这一格）。
    s.store.setState(PROACTIVE_STATE_KEY, JSON.stringify({ nextAt: now + 60000, shared: [], lastRunAt: now }));
    const host = new ProactiveHost(s.ctx, s.cfg, s.registry, s.state, s.memory, s.stats, s.store);
    const result = await host.tick({ now });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'not-due');
  });

  await test('候选只挑安静够久的窗口；今天已经主动过的排除', async () => {
    const s = setup();
    quietFor(s.store, 'group:10', 10);
    quietFor(s.store, 'group:11', 1);
    const now = Date.now();
    const { speak } = await s.host.candidates({ now });
    assert.deepEqual(speak.map((item) => item.key), ['group:10']);
    // 今天已经在群 10 主动过一次 —— 额度用完，不再进候选。
    s.store.recordProactive({ conversation: 'group:10', kind: 'speak', trigger: 'test', text: '早' });
    const again = await s.host.candidates({ now });
    assert.deepEqual(again.speak.map((item) => item.key), []);
  });

  await test('模型说 none：不发，也不记成失败', async () => {
    const s = setup();
    quietFor(s.store, 'group:10', 10);
    fakeNet();
    const result = await s.host.tick({ now: Date.now(), force: true });
    assert.equal(result.action, 'none');
    assert.equal(s.rows('group:10', 'self_message').length, 0);
    assert.equal(s.proactive().length, 0);
    assert.equal(s.stats.proactiveDeclined, 1);
    assert.equal(s.stats.proactiveFailures ?? 0, 0);
  });

  await test('说一句：发出去、写回 self_message、落账本', async () => {
    const s = setup({ llm: fakeLlm({ action: 'speak', target: 'group:10', text: '忽然想起昨天那盘棋。', why: '安静太久' }) });
    quietFor(s.store, 'group:10', 10);
    const sent = fakeNet();
    const result = await s.host.tick({ now: Date.now(), force: true });
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'send_group_msg');
    assert.equal(sent[0].params.message[0].data.text, '忽然想起昨天那盘棋。');
    // 归属：下次窗口醒来，"你：……"必须是它自己的历史。
    const written = s.rows('group:10', 'self_message');
    assert.equal(written.length, 1);
    assert.equal(JSON.parse(written[0].payload).who, '你');
    // 账本与状态页的读数。
    const rows = s.proactive();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].conversation, 'group:10');
    assert.equal(rows[0].status, 'sent');
    assert.equal(s.stats.proactiveSpoke, 1);
    assert.equal(s.stats.lastProactive.ok, true);
    // 下一轮的时间被推后，且落在 30~60 分钟的随机区间里。
    assert.ok(s.host.runtime.nextAt > Date.now() + 1800000 - 5000);
    assert.ok(s.host.runtime.nextAt <= Date.now() + 3600000 + 5000);
  });

  await test('窗口在忙就退让：有未读不发、刚说完话不发', async () => {
    const now = Date.now();
    const entries = {
      'group:10': { window: [], recalledIds: [], pending: [{ id: 1 }], awakeUntil: 0 },
    };
    const s = setup({ llm: fakeLlm({ action: 'speak', target: 'group:10', text: '在吗', why: 'x' }), entries });
    quietFor(s.store, 'group:10', 10);
    const sent = fakeNet();
    const result = await s.host.tick({ now, force: true });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'unread');
    assert.equal(sent.length, 0);
  });

  await test('15 分钟回查：有人接记 replied，没人接记 quiet', async () => {
    const s = setup();
    const now = Date.now();
    const rowA = s.store.recordProactive({ conversation: 'group:10', kind: 'speak', trigger: 'test', text: '早' });
    const rowB = s.store.recordProactive({ conversation: 'group:11', kind: 'speak', trigger: 'test', text: '早' });
    // 有人在 15 分钟窗口里接了群 10；群 11 没人理。
    s.store.recordEvent({
      conversation: 'group:10',
      kind: 'group_message',
      payload: { text: '嗯，早', who: '甲', qq: '111', messageId: 'r1' },
      createdAt: now + 60000,
    });
    const settled = await s.host.settle({ now: now + 20 * 60000 });
    assert.equal(settled, 2);
    const rows = s.proactive();
    const byId = Object.fromEntries(rows.map((row) => [Number(row.id), row]));
    assert.equal(byId[Number(rowA)].outcome, 'replied');
    assert.equal(byId[Number(rowB)].outcome, 'quiet');
  });

  await test('分享视频：一句自己的话 + 标题 + 完整链接，bvid 记进 shared', async () => {
    const s = setup({
      settings: { proactiveBiliEnabled: true, proactiveBiliKeywords: ['鲸'] },
      llm: fakeLlm({ action: 'bili_share', target: 'group:10', pick: 1, text: '这只像是认得我。', why: '刷到了' }),
    });
    quietFor(s.store, 'group:10', 10);
    const sent = fakeNet({ bili: [rankingItem('BV1xx411c7mD', '一只鲸鱼跟着船游了半小时')] });
    const result = await s.host.tick({ now: Date.now(), force: true });
    assert.equal(result.sent, true);
    const text = sent[0].params.message[0].data.text;
    assert.ok(text.includes('这只像是认得我。'));
    assert.ok(text.includes('一只鲸鱼跟着船游了半小时'));
    assert.ok(text.includes('https://www.bilibili.com/video/BV1xx411c7mD'));
    // 同一个视频不会再分享第二遍。
    assert.deepEqual(s.host.runtime.shared, ['BV1xx411c7mD']);
  });

  await test('发送失败不抛，记一次失败并留在状态页', async () => {
    const s = setup({ llm: fakeLlm({ action: 'speak', target: 'group:10', text: '早', why: 'x' }) });
    quietFor(s.store, 'group:10', 10);
    fakeNet({ failSend: true });
    const result = await s.host.tick({ now: Date.now(), force: true });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send-failed');
    assert.equal(s.stats.proactiveFailures, 1);
    assert.equal(s.proactive().length, 0);
  });
  await test('陈旧上限：安静超过七天的窗口不算候选', async () => {
    const s = setup({ settings: { proactiveStaleHours: 168 }, llm: fakeLlm({ action: 'none', why: 'x' }) });
    quietFor(s.store, 'group:10', 24 * 10);
    const found = await s.host.candidates({ now: Date.now() });
    assert.equal(found.speak.length, 0);
  });

  await test('不把她自己的号当成想说话的窗口', async () => {
    const s = setup({ settings: { selfIds: ['900'] }, llm: fakeLlm({ action: 'none', why: 'x' }) });
    quietFor(s.store, 'user:900', 10);
    quietFor(s.store, 'user:200', 10);
    const found = await s.host.candidates({ now: Date.now() });
    assert.deepEqual(found.speak.map((x) => x.key), ['user:200']);
  });

  /**
   * 面板要回答"她怎么不主动找我"，靠的就是这一组排除原因。
   * 少了它，`action: none` 和"钟根本没走"在读数上一模一样。
   */
  await test('候选被筛掉的原因要留下来，够安静的才进候选', async () => {
    const s = setup({ settings: { groups: ['10', '11', '12'] } });
    quietFor(s.store, 'group:10', 30);   // 够安静 → 唯一进候选的
    quietFor(s.store, 'group:11', 1);    // 刚聊过 → quiet
    quietFor(s.store, 'user:200', 30);   // 安静，但今天已经主动过 → budget
    quietFor(s.store, 'group:12', 40);   // 安静，但在她这儿一直没人接 → learn-stopped

    s.store.recordProactive({ conversation: 'user:200', kind: 'speak', trigger: 'test', text: '早' });
    // group:12 的三次都是"发了没人接"，且都要放到今天之前，否则先被日额度挡住。
    for (let i = 0; i < 3; i++) {
      const id = s.store.recordProactive({ conversation: 'group:12', kind: 'speak', trigger: 'test', text: '嗯' });
      s.store.finishProactiveCheck(id, 'quiet');
    }
    s.store.db.prepare('UPDATE proactive SET created_at = ? WHERE conversation = ?')
      .run(Date.now() - 3 * 86400000, 'group:12');

    const now = Date.now();
    const { speak } = await s.host.candidates({ now });
    assert.deepEqual(speak.map((item) => item.key), ['group:10'], '够安静的才是候选');

    const seen = s.host.lastCandidates;
    assert.equal(seen.considered >= 4, true);
    assert.deepEqual(seen.picked.map((item) => item.key), ['group:10']);
    assert.ok(seen.skippedCounts.quiet >= 1, '刚聊过的要记成 quiet');
    assert.ok(seen.skippedCounts.budget >= 1, '今天已发过的要记成 budget');
    assert.ok(seen.skippedCounts['learn-stopped'] >= 1, '没人接导致停手要单独记');
    assert.equal(typeof seen.at, 'number');
    // 每个被筛的窗口都要说得出是哪个、为什么。
    assert.ok(seen.skipped.every((item) => typeof item.key === 'string' && typeof item.reason === 'string'));
  });

  await test('主动层快照：钟、今日账、频率学习、候选都读得到', async () => {
    const s = setup();
    quietFor(s.store, 'group:10', 10);
    const now = Date.now();
    await s.host.candidates({ now });
    const id = s.store.recordProactive({ conversation: 'group:10', kind: 'speak', trigger: 'test', text: '早' });
    s.store.finishProactiveCheck(id, 'replied');
    s.host.runtime.nextAt = now + 20 * 60000;
    s.stats.proactiveTicks = 5;

    const snap = proactiveSnapshot({ host: s.host, store: s.store, config: s.cfg, stats: s.stats, now });
    assert.equal(snap.enabled, true);
    assert.equal(snap.clock.due, false, '还没到点：这就是"不是她不理你"的答案');
    assert.ok(snap.clock.waitMs >= 19 * 60000);
    assert.equal(snap.counts.ticks, 5);
    assert.equal(snap.today.sent, 1);
    assert.equal(snap.today.replied, 1);
    assert.equal(snap.today.checking, 0);
    assert.equal(snap.learn[0].conversation, 'group:10');
    assert.equal(snap.learn[0].answered, 1);
    assert.equal(snap.recent[0].outcome, 'replied');
    assert.equal(snap.candidates, s.host.lastCandidates, '快照里的候选就是上一轮真正算出来的那份');
  });

  await test('主动开口在判断流里有中文名，不是裸的英文键', async () => {
    const { AUX_LABELS } = await import('../lib/agent/aux-attribution.mjs');
    assert.equal(AUX_LABELS.proactive, '主动开口');
  });
  await test('真回合模式：睡着的时候不醒，也不花一次调用', async () => {
    const hour = new Date().getHours();
    const s = setup({ settings: { proactiveMode: 'turn', proactiveSleepFrom: hour, proactiveSleepTo: (hour + 1) % 24 } });
    quietFor(s.store, 'group:10', 10);
    const result = await s.host.tick({ now: Date.now(), force: true });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'sleep');
    assert.equal(s.proactive().length, 0);
  });

  await test('真回合模式：今天的次数用完了就不醒', async () => {
    // 用固定的白天时间：睡觉闸是 01:00–08:00，用真实墙上时间写这条断言，
    // 凌晨跑 CI 时就会先被 sleep 拦下，测不到额度闸。
    const daytime = new Date(2026, 9, 30, 15, 0).getTime();
    const s = setup({ settings: { proactiveMode: 'turn', proactiveDailyMax: 1 } });
    quietFor(s.store, 'group:10', 10, '有人吗', daytime);
    s.store.recordProactive({ conversation: 'group:10', kind: 'turn', trigger: 'self-time', idemKey: 'x:1' });
    const result = await s.host.tick({ now: daytime, force: true });
    assert.equal(result.reason, 'daily-budget');
    assert.equal(s.proactive().length, 1, '不该再记一条');
  });

  await test('真回合模式：没有能待的窗口就什么都不做，不报错', async () => {
    const daytime = new Date(2026, 9, 30, 15, 0).getTime();
    // 关掉脊柱：这条测的是"借某个房间醒"的旧路径，脊柱要单独测。
    const s = setup({ settings: { proactiveMode: 'turn', proactiveSpine: false } });
    const result = await s.host.tick({ now: daytime, force: true });
    assert.equal(result.reason, 'no-window');
    assert.equal(s.stats.proactiveFailures ?? 0, 0);
  });

  /**
   * 脊柱：醒在"外面"（self:account），而不是借某个房间。
   *
   * 钉两件事：①到点真的去开一个**不属于任何房间**的会话（`self:account`），
   * 而不是从候选里挑一个窗口；②这个会话自己建不出来时不抛错、记一次失败。
   */
  await test('脊柱模式：醒在自己的外面，不借任何房间', async () => {
    const daytime = new Date(2026, 9, 30, 15, 0).getTime();
    const opened = [];
    const s = setup({ settings: { proactiveMode: 'turn', proactiveSpine: true } });
    quietFor(s.store, 'group:10', 10, '有人吗', daytime);
    s.host.registry = {
      config: s.cfg,
      ctx: s.ctx,
      byKey: new Map(),
      entry(key) {
        if (!this.byKey.has(key)) this.byKey.set(key, { window: [], pending: [], awakeUntil: 0 });
        return this.byKey.get(key);
      },
      async ensureSession(key) {
        opened.push(key);
        this.byKey.get(key).sessionId = 'session-spine';
        return 'session-spine';
      },
      persist() {},
      record(entry, item) { entry.window.push(item); },
    };
    s.host.state.selfTurnSessions = new Set();
    const result = await s.host.tick({ now: daytime, force: true });
    // 假的 registry 撑不起一个完整回合（真机器要 sessionController/agent/…），
    // 所以这里不钉"回合跑通了"，只钉这一层自己的责任：她确实被送进
    // `self:account` 这个不属于任何房间的会话，而且写权限在结束时摘掉了。
    assert.equal(result.ran, true);
    assert.equal(s.stats.lastProactive.mode, 'spine');
    assert.deepEqual(opened, ['self:account'], '应该打开她自己的那个会话');
    assert.equal(s.host.state.selfTurnSessions.size, 0, '回合结束后要摘掉写权限');
    assert.ok(result.mode === 'spine' || result.reason === 'spine-failed',
      `不该走到房间路径：${result.mode ?? result.reason}`);
  });

  await test('脊柱模式：开会话失败就记一次失败，不往外抛', async () => {
    const daytime = new Date(2026, 9, 30, 15, 0).getTime();
    const s = setup({ settings: { proactiveMode: 'turn', proactiveSpine: true } });
    s.host.registry = {
      config: s.cfg,
      ctx: s.ctx,
      byKey: new Map(),
      entry(key) {
        if (!this.byKey.has(key)) this.byKey.set(key, { window: [], pending: [], awakeUntil: 0 });
        return this.byKey.get(key);
      },
      async ensureSession() { throw new Error('模型不可用'); },
      persist() {},
      record() {},
    };
    s.host.state.selfTurnSessions = new Set();
    const result = await s.host.tick({ now: daytime, force: true });
    assert.equal(result.reason, 'spine-session-failed');
    assert.equal(s.stats.proactiveFailures, 1);
  });

  /**
   * 真回合的准入是这一层最容易悄悄坏掉的地方：合成事件的发送者就是她自己，
   * 如果不带场景标记，`admitMessage` 会当成"她自己发的消息"拦掉，
   * 于是每次醒来都"什么都没发生"，而且看不出报错。所以两头都钉住。
   */
  await test('真回合模式：场景标记放行，冒充她自己发的消息仍然拦掉', async () => {
    const { admitMessage } = await import('../lib/domain/admission.mjs');
    const cfg = config({ selfIds: ['999'], groupEnabled: true, groups: ['10'] });
    const base = {
      post_type: 'message',
      message_type: 'group',
      group_id: 10,
      user_id: 999,
      message_id: 'self-turn:1',
      message: [{ type: 'text', data: { text: '[自主时间] 现在没有新消息。' } }],
    };
    assert.equal(admitMessage(cfg, { ...base, __selfTurn: true }), true, '场景标记要放行');
    assert.equal(admitMessage(cfg, base), false, '她自己账号的正常消息不能当成新消息');
  });

} finally {
  globalThis.fetch = realFetch;
  for (const store of stores) {
    try { store.db.close(); } catch { /* 已关 */ }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清不掉可忽略 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
