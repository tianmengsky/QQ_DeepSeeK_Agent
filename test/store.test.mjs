/**
 * store.test.mjs —— 持久化层（幂等回执 / 事件缓存 / 授权配额 / 图库）的离线测试。
 *
 * 不需要 DSH、不需要 QQ、不需要 OneBot：全部在本机临时目录里跑。
 *   node test/store.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store, STATUS, classifySendError, sha256, stableKey, formatBytes } from '../lib/store.mjs';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-'));
  const store = new Store(path.join(dir, 'data', 'test.sqlite3'));
  return { dir, store };
}

console.log('store.mjs');

// ---------------------------------------------------------------- outbox

await test('第一次发送放行，终态回执重放不再执行', () => {
  const { store } = tmpStore();
  const args = {
    idemKey: 'k1',
    conversation: 'group:1',
    kind: 'send_group_msg',
    target: '1',
    payload: { message: '你好' },
  };
  const first = store.beginSend(args);
  assert.equal(first.action, 'send');

  store.finishSend('k1', STATUS.SUCCEEDED, { onebotId: '42' });

  const second = store.beginSend(args);
  assert.equal(second.action, 'replay', '已成功的幂等编号必须重放而不是重发');
  assert.equal(second.receipt.status, STATUS.SUCCEEDED);
  assert.equal(second.receipt.onebotId, '42');
  assert.equal(second.receipt.attempts, 1, '重放不应该把 attempts 加一');
});

await test('UNKNOWN 状态绝不自动重发（这是重复发言的根源）', () => {
  const { store } = tmpStore();
  const args = {
    idemKey: 'k2',
    conversation: 'group:2',
    kind: 'send_group_msg',
    target: '2',
    payload: { message: '在吗' },
  };
  assert.equal(store.beginSend(args).action, 'send');
  store.finishSend('k2', STATUS.UNKNOWN, { detail: 'send timeout' });

  const retry = store.beginSend(args);
  assert.equal(retry.action, 'hold', 'UNKNOWN 必须被拦住，先核对再决定');
  assert.equal(retry.receipt.status, STATUS.UNKNOWN);
  assert.equal(retry.receipt.attempts, 1, '被拦住就不能算一次尝试');
});

await test('EXECUTING（在途）同样被拦住', () => {
  const { store } = tmpStore();
  const args = { idemKey: 'k3', conversation: 'c', kind: 'send_group_msg', target: '3', payload: {} };
  assert.equal(store.beginSend(args).action, 'send');
  assert.equal(store.beginSend(args).action, 'hold', '还没落终态时不许并发重发');
});

await test('FAILED 是确定失败，允许显式重试', () => {
  const { store } = tmpStore();
  const args = { idemKey: 'k4', conversation: 'c', kind: 'send_group_msg', target: '4', payload: {} };
  store.beginSend(args);
  store.finishSend('k4', STATUS.FAILED, { detail: 'retcode=100' });
  const retry = store.beginSend(args);
  assert.equal(retry.action, 'send');
  assert.equal(retry.receipt.attempts, 2);
});

await test('同一幂等编号换内容会被拒绝，不会被顶掉', () => {
  const { store } = tmpStore();
  store.beginSend({ idemKey: 'k5', conversation: 'c', kind: 'x', target: '5', payload: { message: 'A' } });
  const conflict = store.beginSend({
    idemKey: 'k5',
    conversation: 'c',
    kind: 'x',
    target: '5',
    payload: { message: 'B' },
  });
  assert.equal(conflict.action, 'conflict');
  assert.equal(conflict.receipt.payload, JSON.stringify({ message: 'A' }), '原回执不能被改写');
});

await test('migrate 可以重复调用：热重载补建新表不会报错', () => {
  const { store } = tmpStore();
  // 线上踩过：热重载复用了同一个 Store 实例，新版本加的 `proactive` 表没被建出来，
  // 只能手工补 DDL。补建（bootstrap 里再调一次 migrate）必须是安全的。
  assert.doesNotThrow(() => store.migrate());
  assert.doesNotThrow(() => store.migrate());
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  for (const table of ['proactive', 'intents', 'events', 'conversations']) {
    assert.ok(names.includes(table), `应该有 ${table} 表`);
  }
});

await test('UNKNOWN 能被列出来（不许静默丢失）', () => {
  const { store } = tmpStore();
  store.beginSend({ idemKey: 'u1', conversation: 'group:7', kind: 'x', target: '7', payload: {} });
  store.finishSend('u1', STATUS.UNKNOWN);
  store.beginSend({ idemKey: 's1', conversation: 'group:7', kind: 'x', target: '7', payload: {} });
  store.finishSend('s1', STATUS.SUCCEEDED);

  const unknown = store.listUnknown('group:7');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].idemKey, 'u1');
  assert.deepEqual(store.countByStatus(), { UNKNOWN: 1, SUCCEEDED: 1 });
});

await test('stableKey 对同一组输入稳定、对不同输入相异', () => {
  assert.equal(stableKey('group:1', 'm42', 0), stableKey('group:1', 'm42', 0));
  assert.notEqual(stableKey('group:1', 'm42', 0), stableKey('group:1', 'm42', 1));
  assert.equal(stableKey('a', 'b').length, 32);
});

await test('超时/断连归为 UNKNOWN，业务错误归为 FAILED', () => {
  assert.equal(classifySendError(new Error('OneBot send_group_msg 失败：retcode=100 权限不足')), STATUS.FAILED);
  assert.equal(classifySendError(new Error('连不上 OneBot：fetch failed')), STATUS.UNKNOWN);
  assert.equal(classifySendError(new Error('request timeout after 15000ms')), STATUS.UNKNOWN);
  assert.equal(classifySendError(new Error('HTTP 502 Bad Gateway')), STATUS.UNKNOWN);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(classifySendError(abort), STATUS.UNKNOWN);
});

// ---------------------------------------------------------------- events

await test('重复上报按 dedupeKey 去重，不当错误', () => {
  const { store } = tmpStore();
  const a = store.recordEvent({
    conversation: 'group:1',
    sourceSeq: 100,
    dedupeKey: 'onebot:100',
    payload: { text: 'hi' },
  });
  const b = store.recordEvent({
    conversation: 'group:1',
    sourceSeq: 100,
    dedupeKey: 'onebot:100',
    payload: { text: 'hi' },
  });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(store.eventCount('group:1'), 1);
});

await test('read/ack 游标：未确认的消息会被重读', () => {
  const { store } = tmpStore();
  for (const text of ['a', 'b', 'c']) {
    store.recordEvent({ conversation: 'g', payload: { text }, dedupeKey: `d-${text}` });
  }
  const page = store.readEvents('g', { limit: 2 });
  assert.deepEqual(page.messages.map((m) => m.payload.text), ['a', 'b']);
  assert.equal(page.readThroughId, page.messages[1].id);

  // 没 ack 之前重读，还是从头开始 —— 不丢消息
  const again = store.readEvents('g', { limit: 2 });
  assert.deepEqual(again.messages.map((m) => m.payload.text), ['a', 'b']);

  store.ackEvents('g', page.readThroughId);
  const next = store.readEvents('g', { limit: 2 });
  assert.deepEqual(next.messages.map((m) => m.payload.text), ['c'], '确认后应接着往下读');
});

/**
 * `latest: true` 必须取**最近**的 N 条。
 *
 * 这条防的是一个很隐蔽的 bug：默认的 readEvents 是"从 readThrough 往后读"
 * （取最旧的），而 `ackEvents` 在生产代码里从未被调用，readThrough 恒为 0。
 * 于是"恢复心跳缓冲"时取回来的是**很早以前**的消息，不是刚才在聊的 ——
 * 用户看到的现象就是"历史上下文读取错，获取的不是最近最新的消息"。
 */
await test('latest 取最近的 N 条（而不是最旧的 N 条）', () => {
  const { store } = tmpStore();
  for (let i = 1; i <= 10; i += 1) {
    store.recordEvent({ conversation: 'g', payload: { text: `第${i}条` }, dedupeKey: `d${i}` });
  }

  // 默认（游标语义）：从最旧开始
  const oldest = store.readEvents('g', { limit: 3 });
  assert.deepEqual(
    oldest.messages.map((m) => m.payload.text),
    ['第1条', '第2条', '第3条'],
    '默认仍是游标语义：从最旧开始读',
  );

  // latest：取最近的，且**顺序仍是从旧到新**（窗口按时间累积）
  const newest = store.readEvents('g', { limit: 3, latest: true });
  assert.deepEqual(
    newest.messages.map((m) => m.payload.text),
    ['第8条', '第9条', '第10条'],
    'latest 要取最近 3 条',
  );
  assert.ok(
    newest.messages[0].id < newest.messages[2].id,
    '返回顺序必须是从旧到新，否则上下文读起来是倒着的',
  );

  // latest 不受 readThrough 影响
  store.ackEvents('g', 5);
  const stillNewest = store.readEvents('g', { limit: 2, latest: true });
  assert.deepEqual(
    stillNewest.messages.map((m) => m.payload.text),
    ['第9条', '第10条'],
    'ack 过游标也不影响 latest',
  );
});

await test('游标是独立缓存序号，和上游 source_seq 分开', () => {  const { store } = tmpStore();
  store.recordEvent({ conversation: 'g', sourceSeq: 90000, payload: { text: 'x' }, dedupeKey: 'x' });
  const page = store.readEvents('g');
  assert.equal(page.messages[0].sourceSeq, 90000, 'source_seq 保留上游编号');
  assert.equal(page.messages[0].id, 1, '缓存序号从 1 开始，与上游无关');
  assert.equal(store.getConversation('g').lastSeq, 90000);
});

/**
 * 缺口的语义是"**此刻**有多少条没接住"，是一个**快照**，不是累加计数器。
 *
 * 这条测试原来断言的是累加（3 + 1 = 4）。那个语义后来被证明是错的：
 * 插件每次重载都会重算一次"没接住多少条"，累加之后只增不减，
 * 而 clearGap 从来没被调用过。实测涨到 `gap_count = 264`，
 * 提示词里就会告诉模型"你有 264 条没接住" —— 她以为自己漏了一大段对话，
 * 表现得像失忆。所以改成覆盖，这里也改成断言覆盖。
 */
await test('gap 是快照不是计数器：再记一次是覆盖，确认后清零', () => {
  const { store } = tmpStore();
  store.setGap('group:9', 3, '插件重载，缓冲丢失');
  assert.equal(store.getConversation('group:9').gapCount, 3);

  store.setGap('group:9', 1, '再次掉线');
  const state = store.getConversation('group:9');
  assert.equal(state.gapCount, 1, '缺口是快照，必须覆盖而不是累加');
  assert.match(state.gapNote, /再次掉线/);

  // recordGap 保留为兼容入口，但语义同样是覆盖
  store.recordGap('group:9', 5, '兼容入口');
  assert.equal(store.getConversation('group:9').gapCount, 5, 'recordGap 不再累加');

  store.clearGap('group:9');
  assert.equal(store.getConversation('group:9').gapCount, 0);
  assert.equal(store.getConversation('group:9').gapNote, '');
});

await test('缺口清零后 note 也要清掉（否则会残留过期原因）', () => {
  const { store } = tmpStore();
  store.setGap('group:9', 7, '插件重载');
  store.clearGap('group:9');
  const s = store.getConversation('group:9');
  assert.equal(s.gapCount, 0);
  assert.equal(s.gapNote, '', '清零后不能再留着上次的原因');
});

await test('事件缓存按会话淘汰旧消息', () => {
  const { store } = tmpStore();
  for (let i = 0; i < 30; i += 1) {
    store.recordEvent({ conversation: 'g', payload: { i }, dedupeKey: `k${i}` });
  }
  assert.equal(store.eventCount('g'), 30);
  const pruned = store.pruneEvents('g', 10);
  assert.equal(pruned, 20);
  assert.equal(store.eventCount('g'), 10);
});

// ---------------------------------------------------------------- grants / usage

await test('授权按平台×会话×日期×能力位判定', () => {
  const { store } = tmpStore();
  store.createGrant({
    id: 'conn-1',
    platform: 'qq',
    conversations: ['111', '222'],
    since: '2026-01-01T00:00:00Z',
    until: '2026-12-31T00:00:00Z',
    capabilities: ['read', 'send_text'],
  });
  const grant = store.getGrant('conn-1');

  assert.equal(store.checkGrant(grant, { capability: 'send_text', conversation: '111' }).allowed, true);
  assert.equal(
    store.checkGrant(grant, { capability: 'send_image', conversation: '111' }).allowed,
    false,
    '没勾的能力位要拒绝',
  );
  assert.equal(
    store.checkGrant(grant, { capability: 'send_text', conversation: '999' }).allowed,
    false,
    '不在会话范围内要拒绝',
  );
  assert.equal(
    store.checkGrant(grant, {
      capability: 'send_text',
      conversation: '111',
      at: '2027-06-01T00:00:00Z',
    }).allowed,
    false,
    '超出截止日期要拒绝',
  );
});

await test('没选会话不等于全部会话（要全部必须显式写 *）', () => {
  const { store } = tmpStore();
  store.createGrant({ id: 'empty', conversations: [], capabilities: ['send_text'] });
  const empty = store.checkGrant(store.getGrant('empty'), { capability: 'send_text', conversation: '111' });
  assert.equal(empty.allowed, false);
  assert.match(empty.why, /没有选择任何会话/);

  store.createGrant({ id: 'all', conversations: ['*'], capabilities: ['send_text'] });
  assert.equal(
    store.checkGrant(store.getGrant('all'), { capability: 'send_text', conversation: '111' }).allowed,
    true,
  );
});

await test('撤销授权后立即失效', () => {
  const { store } = tmpStore();
  store.createGrant({ id: 'c', conversations: ['1'], capabilities: ['send_text'] });
  assert.equal(store.revokeGrant('c'), true);
  const denied = store.checkGrant(store.getGrant('c'), { capability: 'send_text', conversation: '1' });
  assert.equal(denied.allowed, false);
  assert.match(denied.why, /撤销/);
  assert.equal(store.listGrants().length, 0);
});

await test('配额在窗口内累计，超了拒绝，跨窗口重置', () => {
  const { store } = tmpStore();
  const hour = 3600_000;
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  assert.equal(store.consume('send', hour, 3, { now }).allowed, true);
  assert.equal(store.consume('send', hour, 3, { now }).allowed, true);
  assert.equal(store.consume('send', hour, 3, { now }).allowed, true);
  const fourth = store.consume('send', hour, 3, { now });
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.used, 3);
  assert.ok(fourth.resetInMs > 0);

  // 换到下一个小时窗口就重新计数
  assert.equal(store.consume('send', hour, 3, { now: now + hour }).allowed, true);
});

await test('配额是持久的 —— 重开数据库不会重置（Tulpa: 重连不清零）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-'));
  const file = path.join(dir, 'data', 'p.sqlite3');
  const hour = 3600_000;
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const a = new Store(file);
  a.consume('send', hour, 2, { now });
  a.consume('send', hour, 2, { now });
  a.db.close();

  const b = new Store(file);
  assert.equal(b.consume('send', hour, 2, { now }).allowed, false, '重开后配额应该还在');
});

await test('限额为 0 表示不限制', () => {
  const { store } = tmpStore();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(store.consume('x', 1000, 0).allowed, true);
  }
});

// ---------------------------------------------------------------- stickers

function pngBytes(n) {
  // 假的"图片"字节即可 —— 这里验的是内容寻址和配额，不是解码
  return Buffer.alloc(1024, 0).fill(n % 256);
}

await test('内容寻址：同内容只占一份，重复入库不重复存', () => {
  const { dir, store } = tmpStore();
  const buf = pngBytes(7);
  const first = store.putSticker(buf, { dir: path.join(dir, 'lib'), notes: { description: '笑' } });
  assert.equal(first.stored, true);
  assert.equal(first.verified, true);

  const again = store.putSticker(Buffer.from(buf), { dir: path.join(dir, 'lib') });
  assert.equal(again.stored, false);
  assert.equal(again.sha, first.sha, '同内容必须得到同一个 sha');
  assert.equal(store.stickerStats().count, 1);
});

await test('读取时校验真实字节，被篡改就报缺失而不顶替', () => {
  const { dir, store } = tmpStore();
  const res = store.putSticker(pngBytes(3), { dir: path.join(dir, 'lib') });
  const ok = store.readSticker(res.sha);
  assert.equal(ok.ok, true);
  assert.equal(sha256(ok.buffer), res.sha);

  // 模拟原件损坏/被人换掉
  fs.writeFileSync(res.path, pngBytes(4));
  const bad = store.readSticker(res.sha);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /哈希不符/);
});

await test('冷却期内不推荐刚用过的图', () => {
  const { dir, store } = tmpStore();
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const a = store.putSticker(pngBytes(11), { dir: path.join(dir, 'lib'), notes: { description: '开心' } });
  const b = store.putSticker(pngBytes(22), { dir: path.join(dir, 'lib'), notes: { description: '难过' } });

  const before = store.pickStickers({ limit: 5, now, cooldownMs: 60_000 });
  assert.equal(before.length, 2);

  store.markUsed([a.sha], now);
  const after = store.pickStickers({ limit: 5, now, cooldownMs: 60_000 });
  assert.deepEqual(after.map((s) => s.sha256), [b.sha], '刚用过的应被冷却掉');

  // 冷却过了就回来
  const later = store.pickStickers({ limit: 5, now: now + 120_000, cooldownMs: 60_000 });
  assert.equal(later.length, 2);
});

await test('uncertainty 的图不进可直接使用候选，但仍可搜到', () => {
  const { dir, store } = tmpStore();
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  store.putSticker(pngBytes(5), {
    dir: path.join(dir, 'lib'),
    notes: { description: '看不清', uncertainty: true },
  });
  const picks = store.pickStickers({ limit: 5, now });
  assert.equal(picks.length, 0, '没看清的图不能当候选');

  const found = store.searchStickers({ query: '看不清' });
  assert.equal(found.length, 1, '但人工检索要能找到');
});

await test('关键词命中优先于纯用量', () => {
  const { dir, store } = tmpStore();
  const now = Date.UTC(2026, 4, 1, 12, 0, 0);
  const hot = store.putSticker(pngBytes(41), { dir: path.join(dir, 'lib'), notes: { description: '一般' } });
  const fit = store.putSticker(pngBytes(42), {
    dir: path.join(dir, 'lib'),
    notes: { description: '无语', emotion: '无奈' },
  });
  store.markUsed([hot.sha], now - 600_000);
  store.markUsed([hot.sha], now - 500_000);
  const picks = store.pickStickers({ query: '无奈', limit: 2, now, cooldownMs: 0 });
  assert.equal(picks[0].sha256, fit.sha);
});

await test('笔记可以后补，且不改动原件', () => {
  const { dir, store } = tmpStore();
  const res = store.putSticker(pngBytes(9), { dir: path.join(dir, 'lib') });
  store.noteSticker(res.sha, { description: '摸鱼', emotion: '摆烂', usage: '工作日白天' });
  const st = store.getSticker(res.sha);
  assert.equal(st.description, '摸鱼');
  assert.equal(st.emotion, '摆烂');
  assert.equal(st.usageHint, '工作日白天');
  assert.equal(sha256(fs.readFileSync(res.path)), res.sha, '补笔记不该碰原图');
});

await test('配额超限默认只报告，不删用户的东西', () => {
  const { dir, store } = tmpStore();
  const chunk = Buffer.alloc(1024 * 1024, 1);
  for (let i = 0; i < 3; i += 1) {
    chunk[0] = i;
    store.putSticker(Buffer.from(chunk), { dir: path.join(dir, 'lib') });
  }
  const report = store.enforceQuota({ totalMiB: 6, scopeMiB: 6 });
  assert.equal(report.over, false, '6MiB 下限内不该报超');

  const tiny = store.enforceQuota({ scopeMiB: 6, totalMiB: 6 });
  assert.equal(tiny.over, false);
  assert.equal(store.stickerStats().count, 3, '默认不删');
});

await test('明确要求 evict 时按 LRU 淘汰，pinned 不动', () => {
  const { dir, store } = tmpStore();
  // 直接塞行来精确控制 bytes / last_used_at
  const mk = (name, bytes, lastUsed, pinned) => {
    const file = path.join(dir, `${name}.bin`);
    fs.writeFileSync(file, Buffer.alloc(10));
    const sha = sha256(Buffer.from(name));
    store.db
      .prepare(
        `INSERT INTO stickers (sha256, bytes, path, notes_scope, last_used_at, pinned, collected_at)
         VALUES (?, ?, ?, 'default', ?, ?, 0)`,
      )
      .run(sha, bytes, file, lastUsed, pinned ? 1 : 0);
    return sha;
  };
  const old = mk('old', 8 * 1024 * 1024, 1000, false);
  const keep = mk('pinned', 8 * 1024 * 1024, 1, true);

  const res = store.enforceQuota({ scopeMiB: 6, totalMiB: 6, evict: true });
  assert.ok(res.evicted.includes(old), '最久未用的应先淘汰');
  assert.ok(!res.evicted.includes(keep), 'pinned 的不能动');
  assert.equal(store.getSticker(keep) !== null, true);
});

await test('补笔记不能抹掉已有内容（空串 = 这次没提这个字段）', () => {
  const { dir, store } = tmpStore();
  const res = store.putSticker(pngBytes(21), {
    dir: path.join(dir, 'lib'),
    account: '',
    notes: { description: '无语', emotion: '无奈', usage: '被问到奇怪问题时' },
  });

  // 调用方第二次"只补情绪"时会带进来一堆空串 ——
  // 这是真实踩过的坑：不加判断地 UPDATE 会把描述抹成空，图库就"失忆"了。
  store.noteSticker(res.sha, { description: '', emotion: '', usage: '', avoid: '' });

  const st = store.getSticker(res.sha);
  assert.equal(st.description, '无语', '描述不能被空串覆盖');
  assert.equal(st.emotion, '无奈');
  assert.equal(st.usageHint, '被问到奇怪问题时');
});

await test('补笔记可以只更新指定字段', () => {
  const { dir, store } = tmpStore();
  const res = store.putSticker(pngBytes(31), {
    dir: path.join(dir, 'lib'),
    notes: { description: '打招呼' },
  });
  store.noteSticker(res.sha, { emotion: '友好' });
  const st = store.getSticker(res.sha);
  assert.equal(st.description, '打招呼', '没提的字段要保留');
  assert.equal(st.emotion, '友好', '提了的字段要更新');
});

await test('没有可用字段时 noteSticker 返回 false 而不是空更新', () => {
  const { dir, store } = tmpStore();
  const res = store.putSticker(pngBytes(32), { dir: path.join(dir, 'lib') });
  assert.equal(store.noteSticker(res.sha, { description: '' }), false);
  assert.equal(store.noteSticker(res.sha, {}), false);
});

await test('sha256 前缀能定位唯一一张，找不到就说找不到', () => {
  const { dir, store } = tmpStore();
  const a = store.putSticker(pngBytes(51), { dir: path.join(dir, 'lib') });
  assert.equal(store.findSticker(a.sha).ok, true);
  assert.equal(store.findSticker(a.sha.slice(0, 12)).ok, true, '模型常只抄前 12 位');
  assert.equal(store.findSticker('zzzz').ok, false, '非十六进制要拒绝');
  assert.equal(store.findSticker('deadbeefdead').ok, false, '找不到要说清楚');
});

await test('formatBytes 用于配额报错信息', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(2048), '2.0KiB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0MiB');
});

// ---------------------------------------------------------------- 降级

await test('数据库打不开时降级为保守模式而不是崩溃', () => {
  // 用一个"目录"当数据库文件 → 必然打不开
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-'));
  const bogus = path.join(dir, 'as-dir');
  fs.mkdirSync(bogus, { recursive: true });
  const store = new Store(bogus);
  assert.equal(store.available, false);
  assert.ok(store.degradedReason.length > 0);

  // 关键：降级时发送要"放行但记账失败可见"，读取一律返回安全空值
  assert.equal(store.beginSend({ idemKey: 'x', conversation: 'c', kind: 'k', target: '1', payload: {} }).action, 'send');
  assert.equal(store.getReceipt('x'), null);
  assert.deepEqual(store.pickStickers({}), []);
  assert.deepEqual(store.readEvents('c').messages, []);
  assert.equal(store.listUnknown().length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
