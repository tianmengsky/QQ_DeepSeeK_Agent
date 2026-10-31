/**
 * 天气槽（mood）——她此刻的状态。
 *
 * 钉的是**行为**，不是文案：
 *   · 日结写完之后会顺手存一句天气，纯文本的老格式也不会丢日记；
 *   · 天气在所有场合都注入，关掉就一条都不出现；
 *   · 天气里的号码会被拿掉（它要进群聊）。
 *
 * 为什么这些重要：她的每个窗口都是一次独立实例，账记的是"发生过什么"，
 * 不记"我现在是什么感觉"。天气是唯一一处"她带着自己进房间"——一旦它
 * 只在私聊出现、或者把群号带进群里，这一层就白加了，甚至是泄露。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { MemoryDiarist } from '../lib/memory/diary.mjs';
import { readMood, writeMood, sanitizeMood, composeMood, writeMoodCandidate, readMoodCandidates, MOOD_STATE_KEY, MOOD_MAX_CHARS } from '../lib/memory/mood.mjs';
import { config, message } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-'));
const stores = [];
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

function fakeLlm(text) {
  return { stream() { return { async *[Symbol.asyncIterator]() { yield { type: 'text-delta', text }; } }; } };
}

function setup({ settings = {}, llm } = {}) {
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
  const diarist = new MemoryDiarist(ctx, cfg, memory, {}, store);
  const at = (h, m = 0) => new Date(2026, 9, 29, h, m).getTime();
  const say = (conversation, { qq = '123456', who = '甲', text = '随便说说', h = 20, id } = {}) => {
    store.db.prepare(`INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, acked, created_at)
      VALUES (?, ?, ?, 'group_message', ?, 1, 1, ?)`).run(
      conversation, Date.now(), `${conversation}:${id ?? Math.random()}`, JSON.stringify({ qq, who, text, at: at(h) }), at(h),
    );
  };
  const inject = (event) => buildMemoryInjection(cfg, event, { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory).text;
  return { store, cfg, memory, diarist, say, inject };
}

try {
  await test('日结输出 JSON 时，正文进日记、心情进天气槽', async () => {
    const s = setup({ llm: fakeLlm(JSON.stringify({
      mood: '有点闷，那个群后来没人接我的话。',
      diary: '今天群里有人问六博棋，我说那手是唯一的选择。他后来没再说话，我也没再问。',
    })) });
    s.say('group:10', { h: 20 }); s.say('group:10', { h: 20, id: 'b' }); s.say('group:10', { h: 21, id: 'c' });
    const result = await s.diarist.writeDay('group:10', '2026-10-29');
    assert.equal(result.written, true);
    assert.equal(result.mood, true);
    const [row] = s.memory.agent.latest('self');
    assert.doesNotMatch(row.text, /mood/u);
    assert.match(row.text, /六博棋/u);
    assert.equal(readMood(s.store).text, '有点闷，那个群后来没人接我的话。');
  });

  await test('老式纯文本输出仍写日记，且不会把上一条天气冲掉', async () => {
    const s = setup({ llm: fakeLlm('今天群里有人问六博棋，我说那手是唯一的选择。他后来没再说话，我也没再问。') });
    writeMood(s.store, { text: '还算平静。', source: 'test' });
    s.say('group:10', { h: 20 }); s.say('group:10', { h: 20, id: 'b' }); s.say('group:10', { h: 21, id: 'c' });
    const result = await s.diarist.writeDay('group:10', '2026-10-29');
    assert.equal(result.written, true);
    assert.equal(result.mood, false);
    assert.match(s.memory.agent.latest('self')[0].text, /六博棋/u);
    assert.equal(readMood(s.store).text, '还算平静。');
  });

  await test('天气在任何场合都注入：群聊看得见，关掉就一条都没有', async () => {
    const s = setup();
    writeMood(s.store, { text: '有点闷。', source: 'test' });
    const group = s.inject(message('m1', '在吗'));
    assert.match(group, /我此刻的心情/u);
    assert.match(group, /有点闷/u);
    // 关掉只是不注入，不删状态。
    const quiet = buildMemoryInjection(theOff(s), message('m2', '在吗'),
      { memoryHashes: {}, staticDone: false, recentQqs: [] }, s.memory).text;
    assert.doesNotMatch(quiet, /我此刻的心情/u);
    assert.equal(readMood(s.store).text, '有点闷。');
  });

  await test('天气是一行体温：压空白、超长截断、空着不写', async () => {
    const s = setup();
    assert.equal(writeMood(s.store, { text: '   ' }).written, false);
    writeMood(s.store, { text: '今天   有点\n闷' });
    assert.equal(readMood(s.store).text, '今天 有点 闷');
    writeMood(s.store, { text: '啊'.repeat(200) });
    assert.equal(readMood(s.store).text.length, MOOD_MAX_CHARS);
  });

  await test('天气里的号码会被换成"某个人"（它要进群聊）', async () => {
    assert.equal(sanitizeMood('他 987654321 说下次还来'), '他 某个人 说下次还来');
    const s = setup();
    writeMood(s.store, { text: sanitizeMood('跟 123456789 约好了') });
    const text = s.inject(message('m4', '在吗'));
    assert.doesNotMatch(text, /123456789/u);
    assert.match(text, /某个人/u);
    assert.ok(s.store.getState(MOOD_STATE_KEY));
  });
  await test('一天里几个房间的傍晚会合成天气，谁先写完都不会盖掉另一边', () => {
    const s = setup();
    writeMoodCandidate(s.store, { conversation: 'group:10', day: '2026-10-29', text: '这边没人接我的话，有点闷。', at: 1 });
    assert.match(composeMood(readMoodCandidates(s.store, { day: '2026-10-29' })), /有点闷/u);
    writeMoodCandidate(s.store, { conversation: 'group:11', day: '2026-10-29', text: '那边倒是热闹，我还想再插一句。', at: 2 });
    const both = composeMood(readMoodCandidates(s.store, { day: '2026-10-29' }));
    assert.match(both, /有点闷/u, '先写的那间屋子不能被后写的盖掉');
    assert.match(both, /再插一句/u);
    assert.equal(readMoodCandidates(s.store, { day: '2026-10-28' }).length, 0, '昨天的候选不该压今天的天气');
    // 同一间屋子重写：只留最新一句，不重复堆叠。
    writeMoodCandidate(s.store, { conversation: 'group:11', day: '2026-10-29', text: '那边后来冷了，我也不想说话了。', at: 3 });
    const revised = readMoodCandidates(s.store, { day: '2026-10-29' });
    assert.equal(revised.filter((item) => item.conversation === 'group:11').length, 1);
    assert.match(revised.find((item) => item.conversation === 'group:11').text, /不想说话/u);
  });
} finally {
  for (const store of stores) { try { store.close(); } catch { /* 无妨 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不算失败 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

/** 只改 moodMaxChars 的配置副本。 */
function theOff(s) {
  const copy = Object.create(s.cfg);
  Object.assign(copy, { moodMaxChars: 0 });
  return copy;
}
