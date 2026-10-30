/**
 * 日结：给"今天"写一条日记。
 *
 * 钉的是**行为**，不是文案：一天一条、幂等、太安静不写、只在自己那个会话里可见、
 * 正文里的号码会被拿掉。为什么这些：她的所有写入本来都由"消息"触发，
 * 没人说话的那一天就会整天空白；而日结是第一个由钟驱动的写入。
 * 一旦它的可见性写错，A 群的一天就会出现在 B 群 —— 那是隐私事故，不是文案问题。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { MemoryDiarist, __diaryTest } from '../lib/memory/diary.mjs';
import { config, message } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diary-'));
const stores = [];
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

/** 极简 llm：每次调用吐一段正文；`before` 次调用先抛错（测重试之外的失败路径）。 */
function fakeLlm(text, { failFirst = 0 } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    stream() {
      calls++;
      const nth = calls;
      return {
        async *[Symbol.asyncIterator]() {
          if (nth <= failFirst) throw new Error('upstream down');
          yield { type: 'text-delta', text };
        },
      };
    },
  };
}

function setup({ settings = {}, llm = fakeLlm('今天群里有人问六博棋，我说那手是唯一的选择。他后来没再说话，我也没再问。'), day = '2026-10-29' } = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10', '11'], privateEnabled: true, users: ['200'], diaryEnabled: true, ...settings });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const ctx = {
    disposed: false,
    logger: { info() {}, warn() {} },
    get: (n) => (n === 'llm' ? llm
      : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : undefined),
  };
  const stats = {};
  const diarist = new MemoryDiarist(ctx, cfg, memory, stats, store);
  const at = (h, m = 0) => new Date(2026, 9, Number(day.slice(8, 10)), h, m).getTime();
  /** 往 events 里塞一条真实的群消息。 */
  const say = (conversation, { qq = '123456', who = '甲', text = '随便说说', h = 10, id } = {}) => {
    store.db.prepare(`INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, acked, created_at)
      VALUES (?, ?, ?, 'group_message', ?, 1, 1, ?)`).run(
      conversation, Date.now(), `${conversation}:${id ?? Math.random()}`, JSON.stringify({ qq, who, text, at: at(h) }), at(h),
    );
  };
  /** 她自己说过的一句（memory_episodes 里 kind=action 的那类）。 */
  const told = (conversation, text = '我：随便回一句', h = 11) => {
    store.db.prepare(`INSERT INTO memory_episodes (id, kind, conversation, text, state, target, created_at, updated_at)
      VALUES (?, 'action', ?, ?, 'SUCCEEDED', ?, ?, ?)`).run(
      `${conversation}#${Math.random()}`, conversation, text, conversation, at(h), at(h),
    );
  };
  const inject = (event) => buildMemoryInjection(cfg, event, { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory).text;
  return { store, cfg, memory, diarist, stats, say, told, inject, day, at };
}

try {
  await test('一天一条：读当天的日志写进日记本，slot 带会话与日期', async () => {
    const s = setup();
    s.say('group:10', { text: '这手棋是不是只能这么走', h: 21 });
    s.say('group:10', { text: '他赛后说那是唯一的选择', h: 21, id: 'b' });
    s.told('group:10', '我说最像人的地方就在这儿', 21);
    const result = await s.diarist.writeDay('group:10', s.day);
    assert.equal(result.written, true);
    assert.equal(result.slot, 'diary.g10.20261029');
    const [row] = s.memory.agent.latest('self');
    assert.equal(row.kind, 'note');
    assert.equal(row.period, '2026-10-29');
    // 日记是私事：写的时候一律 private，可见性交给"来源会话"判断。
    assert.equal(row.visibility, 'private');
    assert.equal(row.sources[0].conversation, 'group:10');
    assert.match(row.text, /六博棋/);
  });

  await test('同一天写过的跳过，force 才重写并且版本 +1', async () => {
    const s = setup();
    s.say('group:10');
    s.say('group:10', { id: 'b' });
    s.told('group:10', '我先说了一句', 10);
    assert.equal((await s.diarist.writeDay('group:10', s.day)).written, true);
    const again = await s.diarist.writeDay('group:10', s.day);
    assert.equal(again.written, false);
    assert.equal(again.reason, 'already-written');
    assert.equal(s.memory.agent.latest('self').length, 1);
    const forced = await s.diarist.writeDay('group:10', s.day, { force: true });
    assert.equal(forced.written, true);
    const rows = s.memory.agent.latest('self');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].version), 2);
  });

  await test('那天几乎没人说话就不写（日志太少等于没有一天）', async () => {
    const s = setup({ settings: { diaryMinMessages: 3 } });
    s.say('group:10');
    const result = await s.diarist.writeDay('group:10', s.day);
    assert.equal(result.written, false);
    assert.equal(result.reason, 'too-quiet');
    assert.equal(s.memory.agent.latest('self').length, 0);
  });

  await test('日记只在自己的会话里可见：A 群的一天不出现在 B 群和私聊', async () => {
    const s = setup();
    const marker = '今天群里有人问六博棋';
    s.say('group:10', { text: '这一局我只想说那手很像我，说完就有点后悔', h: 22 });
    s.say('group:10', { text: '真的', h: 22, id: 'b' });
    s.told('group:10', '我说了句嘴硬的话', 22);
    await s.diarist.writeDay('group:10', s.day);
    const own = s.inject(message(1, '在吗', 10));
    assert.match(own, new RegExp(marker));
    const otherGroup = s.inject(message(2, '在吗', 11));
    assert.doesNotMatch(otherGroup, new RegExp(marker));
    const privateChat = s.inject({ post_type: 'message', message_type: 'private', self_id: 100,
      user_id: 200, message_id: 3, message: [{ type: 'text', data: { text: '在吗' } }] });
    assert.doesNotMatch(privateChat, new RegExp(marker));
  });

  await test('正文里的群号和 QQ 号会被拿掉', async () => {
    const s = setup({ llm: fakeLlm('今天 987654321 里有人 @123456 问我那手是不是唯一的选择，我说不知道，其实我想说的是别的。') });
    s.say('group:10', { qq: '123456', h: 22 });
    s.say('group:10', { qq: '123456', h: 22, id: 'b' });
    s.told('group:10', '我说不知道', 22);
    await s.diarist.writeDay('group:10', s.day);
    const [row] = s.memory.agent.latest('self');
    // 群号来自 conversation，QQ 号来自参与者名单；都在写入前替换掉。
    assert.doesNotMatch(row.text, /987654321|123456/);
    assert.doesNotMatch(row.text, /@/);
    assert.match(row.text, /某个人/);
  });

  await test('夜里才把"今天"算一天；白天只补昨天', async () => {
    const s = setup();
    const today = s.at(22, 30);
    const morning = s.at(9, 30);
    assert.deepEqual(s.diarist.days(today).slice(0, 1), ['2026-10-29']);
    assert.deepEqual(s.diarist.days(morning).slice(0, 1), ['2026-10-28']);
  });

  await test('tick 按天补写：关机两天，开机把漏的补上', async () => {
    const s = setup({ settings: { diaryMaxConversationsPerTick: 1, diaryLookbackDays: 3 } });
    // 今天（10-29）和昨天（10-28）都有活动。
    s.say('group:10', { h: 21 });
    s.say('group:10', { h: 21, id: 'b' });
    s.told('group:10', '今天说了句', 21);
    const yesterday = new Date(2026, 9, 28, 21, 0).getTime();
    for (const id of ['c', 'd', 'e']) {
      s.store.db.prepare(`INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, acked, created_at)
        VALUES ('group:10', ?, ?, 'group_message', ?, 1, 1, ?)`).run(Date.now(), `y:${id}`,
        JSON.stringify({ qq: '123456', who: '甲', text: '昨天也聊了', at: yesterday }), yesterday);
    }
    const first = await s.diarist.tick({ now: s.at(22, 0) });
    assert.equal(first.written, 1);
    assert.equal(s.memory.agent.latest('self')[0].slot, 'diary.g10.20261029');
    const second = await s.diarist.tick({ now: s.at(22, 0) });
    assert.equal(second.written, 1);
    assert.equal(s.memory.agent.latest('self')[0].slot, 'diary.g10.20261028');
    // 第三天再跑：两条都在，不重复。
    assert.equal((await s.diarist.tick({ now: s.at(22, 0) })).written, 0);
    assert.equal(s.memory.agent.latest('self').length, 2);
  });

  await test('开机冲刺：budget 放大，先还最老的账', async () => {
    // 断三天再开机：10-27、28、29 都有活动。日常一轮 3 条、按"今天→昨天"，
    // 补账时反过来：先补最老的那天，否则积压时永远在写今天，老账一直挂着。
    const s = setup({ settings: { diaryLookbackDays: 7, diaryMaxConversationsPerTick: 3 } });
    const put = (y, m, d, tag) => {
      const ts = new Date(2026, m - 1, d, 21, 0).getTime();
      for (const id of ['a', 'b', 'c']) {
        s.store.db.prepare(`INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, acked, created_at)
          VALUES ('group:10', ?, ?, 'group_message', ?, 1, 1, ?)`).run(Date.now(), `${tag}:${id}`,
          JSON.stringify({ qq: '123456', who: '甲', text: `${d} 号那天聊了几句`, at: ts }), ts);
      }
    };
    put(2026, 10, 27, 'd27'); put(2026, 10, 28, 'd28'); put(2026, 10, 29, 'd29');
    const result = await s.diarist.tick({ now: s.at(22, 0), budget: 2, oldestFirst: true });
    assert.equal(result.written, 2);
    const slots = s.memory.agent.latest('self').map((r) => r.slot).sort();
    // 先补 27 和 28，今天（29）还挂着 —— 下次 tick 再还。
    assert.deepEqual(slots, ['diary.g10.20261027', 'diary.g10.20261028']);
    const rest = await s.diarist.tick({ now: s.at(22, 0) });
    assert.equal(rest.written, 1);
    assert.ok(s.memory.agent.latest('self').some((r) => r.slot === 'diary.g10.20261029'));
  });

  await test('模型不可用/输出太短时什么都不写，也不抛', async () => {
    const broken = setup({ llm: null });
    broken.say('group:10'); broken.say('group:10', { id: 'b' }); broken.told('group:10');
    assert.equal((await broken.diarist.writeDay('group:10', broken.day)).reason, 'model-unavailable');
    const short = setup({ llm: fakeLlm('嗯。') });
    short.say('group:10'); short.say('group:10', { id: 'b' }); short.told('group:10');
    const result = await short.diarist.writeDay('group:10', short.day);
    assert.equal(result.written, false);
    assert.equal(result.reason, 'too-short');
  });

  await test('日志超预算时掐中间留两头', async () => {
    const { buildTranscript } = __diaryTest;
    const events = Array.from({ length: 60 }, (_, i) => ({
      createdAt: 1000 + i, payload: { who: '甲', text: `第 ${i} 句闲聊，内容差不多` },
    }));
    const { text, clipped } = buildTranscript({ events, budget: 600 });
    assert.equal(clipped, true);
    assert.match(text, /第 0 句/);
    assert.match(text, /第 59 句/);
    assert.match(text, /（中间略）/);
  });
} finally {
  for (const store of stores) { try { store.db.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\ndiary: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
