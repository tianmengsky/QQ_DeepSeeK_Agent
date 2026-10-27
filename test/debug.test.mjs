import assert from 'node:assert/strict';
import { rig, message } from './helpers/bridge.mjs';
import { chunkText, parseDebugCommand, probeOneBot, __debugTest } from '../lib/application/debug.mjs';
import { debugSnapshot, renderDebugStatus, redact } from '../lib/application/debug-status.mjs';
import { heartbeatSnapshot, statusSnapshot } from '../lib/routes/status.mjs';
let passed = 0;
const oldFetch = globalThis.fetch;
const rigs = [];
const make = (overrides = {}) => {
  const r = rig({ debugUsers: ['200'], heartbeatUnreadThreshold: 6, ...overrides });
  rigs.push(r);
  r.state.sendQueue = r.sendQueue;
  r.stats.build = 'test-debug';
  r.stats.since = Date.now() - 65000;
  return r;
};
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}
const output = (r) =>
  r.calls
    .filter((c) => c.action === 'send_private_msg')
    .map((c) => c.payload.message)
    .join('\n');
const fakeProbe = (data = { online: true, good: true }, failed = false) => {
  globalThis.fetch = async (url) => {
    if (failed && String(url).endsWith('get_status')) throw Error('status unavailable');
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: String(url).endsWith('get_status') ? data : { user_id: 100 },
        }),
    };
  };
};
try {
  await test('记事本视图：群本、日记本各自渲染，日记标出可公开条目', () => {
    const row = (extra = {}) => ({ kind: 'note', text: '凌晨两点最热闹', slot: 'rhythm.close',
      version: 1, visibility: 'private', deleted: 0,
      sources: [{ conversation: 'group:10', messageId: '7' }], ...extra });
    const fake = { agent: { latest: (subject) => subject === 'self'
      ? [row({ text: '别在别人说忙时追问', slot: 'social.timing', visibility: 'public' })]
      : subject === 'group:10' ? [row()] : [] } };
    const diary = __debugTest.notebookView(fake, 'self');
    assert.match(diary, /【日记】/);
    assert.match(diary, /可公开/);
    assert.match(diary, /共 1 条/);
    const group = __debugTest.notebookView(fake, 'group:10');
    assert.match(group, /【群 10 记事】/);
    assert.match(group, /依据 group:10 消息 7/);
    // 空本不能返回空串，否则调试输出里那一段会凭空消失。
    assert.match(__debugTest.notebookView(fake, 'group:99'), /（暂无）/);
  });
  await test('command boundaries preserve ordinary messages and custom prefixes', async () => {
    assert.equal(parseDebugCommand('#debugging status'), null);
    assert.equal(parseDebugCommand('#debug-status'), null);
    assert.deepEqual(parseDebugCommand('#debug\nSTATUS detail'), {
      command: 'status',
      args: ['detail'],
    });
    assert.equal(parseDebugCommand('#debug help', '#ops'), null);
    const r = make({ debugPrefix: '#ops' });
    await r.post(message(1, '#ops help'));
    assert.ok(output(r).includes('#ops status detail'));
    assert.equal(r.prompts.length, 0);
  });
  await test('unauthorized debug commands never reveal data', async () => {
    const r = make();
    await r.post(message(1, '#debug status', 10, 201));
    assert.equal(r.calls.length, 0);
    assert.equal(r.stats.debugCommands, undefined);
  });
  await test('group commands with a self mention reply privately even when hosting is off', async () => {
    const r = make();
    r.state.persistEnabled(false);
    await r.post({
      ...message(1),
      message: [
        { type: 'at', data: { qq: '100' } },
        { type: 'text', data: { text: ' #debug help' } },
      ],
    });
    assert.equal(r.prompts.length, 0);
    assert.ok(output(r).includes('【调试命令】'));
    assert.ok(r.calls.every((c) => c.action === 'send_private_msg' && c.payload.user_id === 200));
    assert.equal(r.registry.byKey.size, 0, 'query does not create a session');
  });
  await test('default status summarizes unread threshold and excludes old idle rule', async () => {
    const r = make({ heartbeatEnabled: true });
    for (let i = 0; i < 8; i++) {
      const e = r.registry.entry('group:' + (10 + i));
      e.pending.push({ text: 'PRIVATE-CONTENT', qq: '300' });
    }
    await r.post(message(100, '#debug status'));
    const text = output(r);
    assert.ok(text.includes('每群未读 6 条或等待'));
    assert.ok(text.includes('当前未读 8 条'));
    assert.ok(text.includes('接口可达，QQ 在线状态未知'));
    assert.ok(text.includes('#debug sessions'));
    assert.ok(!text.includes('PRIVATE-CONTENT'));
    assert.ok(!text.includes('安静'));
    assert.equal(r.calls.filter((c) => c.action === 'get_status').length, 1);
    assert.equal(r.prompts.length, 0);
    assert.equal(r.registry.byKey.size, 8);
  });
  await test('OneBot distinguishes online, offline and unknown even when API works', async () => {
    const r = make();
    fakeProbe({ online: false, good: false });
    let result = await probeOneBot(r.config);
    assert.equal(result.reachable, true);
    assert.equal(result.online, false);
    assert.ok(result.text.includes('QQ 离线'));
    fakeProbe({ online: true, good: true });
    assert.ok((await probeOneBot(r.config)).text.includes('QQ 在线'));
    fakeProbe({}, true);
    result = await probeOneBot(r.config);
    assert.equal(result.online, null);
    assert.ok(result.text.includes('在线状态未知'));
  });
  await test('transport failures are shown and credentials are redacted', async () => {
    const r = make({ onebotToken: 'SECRET-123', token: 'INBOUND-456' });
    globalThis.fetch = async () => {
      throw Error('HTTP Bearer SECRET-123 INBOUND-456');
    };
    const result = await probeOneBot(r.config);
    assert.equal(result.reachable, false);
    assert.ok(result.text.includes('接口不可达'));
    assert.ok(!result.text.includes('SECRET-123'));
    assert.ok(!result.text.includes('INBOUND-456'));
    assert.ok(!redact('Bearer another-key', r.config).includes('another-key'));
  });
  await test('heartbeat snapshot shows cooldown, retry, collecting and disabled accurately', () => {
    const r = make({ heartbeatEnabled: true, heartbeatCooldownMs: 300000 });
    const now = Date.now(),
      e = r.registry.entry('group:10');
    e.pending = Array.from({ length: 6 }, () => ({ text: 'x' }));
    e.lastSpokeAt = now - 100000;
    let h = heartbeatSnapshot(r.config, r.registry, r.state, r.stats, now);
    assert.equal(h.groups[0].phase, 'ready');
    assert.equal(h.groups[0].waitRemainingMs, 0);
    e.heartbeatRetryAt = now + 250000;
    assert.equal(
      heartbeatSnapshot(r.config, r.registry, r.state, r.stats, now).groups[0].phase,
      'retry',
    );
    e.pending.pop();
    e.heartbeatRetryAt = 0;
    assert.equal(
      heartbeatSnapshot(r.config, r.registry, r.state, r.stats, now).groups[0].phase,
      'cooldown',
    );
    r.state.enabled = false;
    assert.equal(
      heartbeatSnapshot(r.config, r.registry, r.state, r.stats, now).groups[0].phase,
      'disabled',
    );
    assert.equal(
      statusSnapshot(r.config, r.registry, r.state, r.stats).heartbeat.unreadThreshold,
      6,
    );
  });
  await test('failed heartbeat decisions are not reported as a decline', async () => {
    const r = make({ heartbeatEnabled: true });
    r.stats.lastHeartbeatDecision = {
      conversation: 'group:10',
      unread: 6,
      retry: true,
      speak: false,
      why: '模型不可用',
      at: Date.now(),
    };
    await r.post(message(1, '#debug heartbeat'));
    assert.ok(output(r).includes('判断失败，保留未读'));
    assert.equal(r.calls.filter((c) => c.action === 'get_status').length, 0);
  });
  await test('private query can target a group and reports its unread cooldown', async () => {
    const r = make({ heartbeatEnabled: true, heartbeatCooldownMs: 300000 });
    const e = r.registry.entry('group:123');
    e.pending = Array.from({ length: 5 }, () => ({ text: 'background' }));
    e.lastSpokeAt = Date.now();
    await r.post({ ...message(1, '#debug heartbeat group:123'), message_type: 'private' });
    const text = output(r);
    assert.ok(text.includes('group:123'));
    assert.ok(text.includes('未读 5/6'));
    assert.ok(text.includes('时间触发等待中'));
    assert.equal(e.pending.length, 5);
    assert.equal(r.registry.byKey.size, 1);
  });
  await test('sessions are bounded and paginated without silently dropping groups', async () => {
    const r = make();
    for (let i = 0; i < 23; i++) r.registry.entry('group:' + (100 + i)).lastMessageAt = i;
    await r.post(message(1, '#debug sessions 2'));
    assert.ok(output(r).includes('第 2/2 页'));
    assert.equal((output(r).match(/group:/g) ?? []).length, 3);
    assert.equal(r.registry.byKey.size, 23);
  });
  await test('malformed arguments and missing targets do not create phantom sessions', async () => {
    const r = make();
    await r.post(message(1, '#debug sessions 0'));
    await r.post(message(2, '#debug status group:999'));
    await r.post(message(3, '#debug memory ../secret'));
    assert.ok(output(r).includes('参数不正确'));
    assert.ok(output(r).includes('尚未记录会话 group:999'));
    assert.equal(r.registry.byKey.size, 0);
    assert.equal(r.calls.filter((c) => c.action === 'get_status').length, 0);
  });
  await test('JSON mode includes queue, turn diagnostics and history-safe data', async () => {
    const r = make();
    r.stats.lastError = 'Bearer private-key';
    r.stats.lastTurn = { at: Date.now(), replyChars: 100, sayOk: 1, endReason: 'completed' };
    const e = r.registry.entry('group:10');
    e.window.push({ text: 'NEVER-PRINT-CONTENT', bot: false });
    await r.post(message(1, '#debug status json'));
    const text = r.calls
      .filter((c) => c.action === 'send_private_msg')
      .map((c) => c.payload.message.replace(/^【调试结果 \d+\/\d+】\n/, ''))
      .join('');
    assert.equal(JSON.parse(text).agent.lastTurn.endReason, 'completed');
    assert.ok(text.includes('"queue"'));
    assert.ok(text.includes('"endReason": "completed"'));
    assert.ok(!text.includes('private-key'));
    assert.ok(!text.includes('NEVER-PRINT-CONTENT'));
  });
  await test('prompt preview reads pending context without consuming, storing or inferring', async () => {
    const r = make({ persona: 'STATIC-PERSONA' });
    const e = r.registry.entry('group:10');
    e.pending.push({ qq: '300', who: '乙', text: 'UNREAD-CONTEXT', messageId: 'pending' });
    e.window.push({ qq: '300', who: '乙', text: 'EARLIER-CONTEXT', messageId: 'earlier' });
    e.staticDone = true;
    await r.post(message(1, '#debug prompt group:10'));
    const text = output(r);
    assert.ok(text.includes('UNREAD-CONTEXT'));
    assert.ok(text.includes('当前消息占位'));
    assert.ok(!text.includes('STATIC-PERSONA'));
    assert.equal(e.pending.length, 1);
    assert.equal(e.window.length, 1);
    assert.equal(r.stats.windowInjections, undefined);
    assert.equal(r.prompts.length, 0);
  });
  await test('named memory reads and shared conversation facts do not create documents', async () => {
    const r = make();
    const { maybeHandleDebug } = await import('../lib/application/debug.mjs');
    const memory = {
      read: (qq) => (qq === '123' ? 'FACT-123' : null),
      activeFacts: () => [{ fact: 'GROUP-FACT' }],
    };
    await maybeHandleDebug(
      r.ctx,
      r.config,
      message(1, '#debug memory 123'),
      { recentQqs: [] },
      memory,
      r.stats,
      r.state,
      r.registry,
    );
    assert.ok(output(r).includes('FACT-123'));
    await maybeHandleDebug(
      r.ctx,
      r.config,
      message(2, '#debug memory'),
      { recentQqs: [] },
      memory,
      r.stats,
      r.state,
      r.registry,
    );
    assert.ok(output(r).includes('GROUP-FACT'));
    // 会话约定面关掉后存档仍可查，但标签必须说明它不再注入。
    const archived = make({ conversationMemoryMaxChars: 0 });
    await maybeHandleDebug(
      archived.ctx,
      archived.config,
      message(1, '#debug memory'),
      { recentQqs: [] },
      memory,
      archived.stats,
      archived.state,
      archived.registry,
    );
    assert.ok(output(archived).includes('GROUP-FACT'));
    assert.ok(output(archived).includes('已关闭注入与提炼'));
  });
  await test('line-based chunks preserve emoji and reconstruct original text exactly', () => {
    const text = '每行😀测试\n'.repeat(20);
    const chunks = chunkText(text, 13);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((s) => Array.from(s).length <= 13));
    assert.ok(chunks.every((s) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(s)));
  });
  await test('delivery distinguishes unknown receipts from successful sends and handles a broken store', () => {
    const r = make();
    const store = { available: true, countByStatus: () => ({ SENT: 3, UNKNOWN: 1 }) };
    const report = debugSnapshot(r.config, r.registry, r.state, r.stats, null, store);
    assert.ok(renderDebugStatus(report, { section: 'delivery' }).includes('UNKNOWN 1'));
    assert.ok(renderDebugStatus(report, { section: 'delivery' }).includes('实际送达看回执'));
    store.countByStatus = () => {
      throw Error('database closed');
    };
    assert.ok(
      debugSnapshot(
        r.config,
        r.registry,
        r.state,
        r.stats,
        null,
        store,
      ).delivery.reliability.reason.includes('读取失败'),
    );
  });
  console.log(passed + ' passed, 0 failed');
} finally {
  for (const r of rigs) {
    r.state.persistEnabled(false);
    r.sendQueue.dispose();
  }
  globalThis.fetch = oldFetch;
}
