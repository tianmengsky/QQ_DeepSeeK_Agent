/**
 * 周反思：她回看一周，改写"我怎么想"。
 *
 * 钉的是**行为**，不是文案：一周只跑一次、没到周日夜里不跑、太安静不写、
 * 想不出东西就沉默（不拿空反思覆盖上周）、能改写自己的立场（版本 +1、渲染标"改过"）、
 * 只改自己写过的槽（白名单）、别人的反应真的进了输入、坏 JSON 不落盘。
 *
 * 为什么值得单独一套：这是唯一一个会**改掉既有 `me.*`** 的路径。写错的话，
 * 她的人格会被一次模型抽风覆盖掉；而如果它悄悄不跑，看起来又是"她没长进"。
 * 两种失败都必须能在测试里当场炸。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { MemoryIntrospector, isoWeek } from '../lib/memory/introspect.mjs';
import { config, message } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-introspect-'));
const stores = [];
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

/** 极简 llm：收集每次的 prompt，吐固定正文。 */
function fakeLlm(text) {
  const prompts = [];
  return {
    prompts,
    get calls() { return prompts.length; },
    stream(args) {
      prompts.push(String(args?.messages?.[0]?.content?.[0]?.text ?? ''));
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text };
        },
      };
    },
  };
}

const WEEK = '2026-W44';
/** 槽只允许小写（`agent-memory.mjs:132`），所以周期标签进槽时降成 `2026-w44`。 */
const SLOT = 'me.reflect.2026-w44';
/** W44 = 2026-10-26 ~ 11-01；那周的周日 22:00 是回看的临界点。 */
const cutoff = new Date(2026, 10, 1, 22, 0).getTime();
const AFTER = cutoff + 30 * 60 * 1000;

const GOOD = JSON.stringify({
  thought: '这周我一直在等别人先开口，等不到就说算了。其实我也不是不想说，是怕说了没人接。',
  revised: [{ slot: 'me.stance.praise', text: '被夸的时候我先装没听懂，但这次我没装到底，笑了。' }],
  noticed: ['每次被夸都先否认'],
  want: ['有人问我今天怎么样，而不是问我能干什么'],
  unsure: [],
});

function setup({ settings = {}, llm = fakeLlm(GOOD) } = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10'], privateEnabled: true, users: ['200'], introspectEnabled: true, ...settings });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const ctx = {
    disposed: false,
    logger: { info() {}, warn() {} },
    get: (n) => (n === 'llm' ? llm
      : n === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } : undefined),
  };
  const stats = {};
  const introspector = new MemoryIntrospector(ctx, cfg, memory, stats, store);
  const at = (day, h = 10, m = 0) => new Date(2026, 9, day, h, m).getTime();
  const say = (conversation, { qq = '123456', who = '甲', text = '随便说说', day = 29, h = 10, m = 0, id } = {}) => {
    store.db.prepare(`INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, acked, created_at)
      VALUES (?, ?, ?, 'group_message', ?, 1, 1, ?)`).run(
      conversation, Date.now(), `${conversation}:${id ?? Math.random()}`,
      JSON.stringify({ qq, who, text, at: at(day, h, m) }), at(day, h, m),
    );
  };
  const told = (conversation, text = '我说一句', { day = 29, h = 11, m = 0 } = {}) => {
    store.db.prepare(`INSERT INTO memory_episodes (id, kind, conversation, text, state, target, created_at, updated_at)
      VALUES (?, 'action', ?, ?, 'SUCCEEDED', ?, ?, ?)`).run(
      `${conversation}#${Math.random()}`, conversation, text, conversation, at(day, h, m), at(day, h, m),
    );
  };
  /** 直接写一条日记（跳过日结：这一套只关心"一周里有没有日子可看"）。 */
  const diary = (day, text = '那天我写了一句。') => memory.agent.write({
    subject: 'self', slot: `diary.g10.${day.replace(/-/gu, '')}`, version: 0, kind: 'note',
    text, period: day, visibility: 'private',
    sources: [{ conversation: 'group:10', messageId: `diary:${day}`, qq: '', who: '', at: AFTER }],
  });
  /** 直接写一条立场（模拟她之前写下的 `me.*`）。 */
  const stance = (slot, text, kind = 'stance', visibility = 'public') => memory.agent.write({
    subject: 'self', slot, version: 0, kind, text, period: '2026-10',
    visibility, sources: [{ conversation: 'self:seed', messageId: `seed:${slot}`, qq: '', who: '', at: AFTER }],
  });
  const inject = (conversation = 'group:10') => buildMemoryInjection(cfg,
    message('你好', { conversation }), { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory).text;
  return { store, cfg, memory, introspector, stats, say, told, diary, stance, inject, llm };
}

try {
  await test('周日夜里回看：写 me.reflect.<周>，public，记下那一周', async () => {
    const s = setup();
    s.diary('2026-10-28'); s.diary('2026-10-29'); s.diary('2026-10-30');
    const result = await s.introspector.tick({ now: AFTER });
    assert.equal(result.ran, true);
    assert.equal(result.week, WEEK);
    const row = s.memory.agent.latest('self').find((r) => r.slot === SLOT);
    assert.ok(row, '应该写下 ' + SLOT);
    // 她写下的自己要被看见 —— 所以是 public，而不是只进私聊。
    assert.equal(row.visibility, 'public');
    assert.equal(row.period, WEEK);
    assert.equal(row.kind, 'note');
    assert.match(row.text, /等别人先开口/u);
    assert.match(row.text, /我好像每次被夸都先否认/u);
    assert.equal(row.sources[0].conversation, 'self:introspect');
  });

  await test('同一周只跑一次：第二次不再打上游', async () => {
    const s = setup();
    s.diary('2026-10-28'); s.diary('2026-10-29');
    assert.equal((await s.introspector.tick({ now: AFTER })).ran, true);
    const again = await s.introspector.tick({ now: AFTER + 3600000 });
    assert.equal(again.ran, false);
    assert.equal(again.reason, 'done');
    assert.equal(s.llm.calls, 1);
  });

  await test('太安静的一周：少于两天日记就不写，也不算跑过', async () => {
    const s = setup();
    s.diary('2026-10-29');
    const first = await s.introspector.tick({ now: AFTER });
    assert.equal(first.ran, false);
    assert.equal(first.reason, 'too-quiet');
    assert.equal(s.memory.agent.latest('self').filter((r) => /^me\.reflect\./u.test(r.slot)).length, 0);
    // 六小时的重试闸过去之后还应该再看一眼 —— "这周刚开始记"不等于"这周没长进"。
    const later = await s.introspector.tick({ now: AFTER + 7 * 3600000 });
    assert.equal(later.reason, 'too-quiet');
    assert.equal(s.llm.calls, 0);
  });

  await test('沉默权：什么都没想出来就不写，但仍算这一周跑过', async () => {
    const s = setup({ llm: fakeLlm(JSON.stringify({ thought: '', revised: [], noticed: [], want: [], unsure: [] })) });
    s.diary('2026-10-28'); s.diary('2026-10-29');
    const result = await s.introspector.tick({ now: AFTER });
    assert.equal(result.reason, 'silent');
    assert.equal(s.memory.agent.latest('self').filter((r) => /^me\.reflect\./u.test(r.slot)).length, 0);
    assert.equal((await s.introspector.tick({ now: AFTER + 3600000 })).reason, 'done');
  });

  await test('改写自己的立场：版本 +1，渲染标"（改过）"，类别不变', async () => {
    const s = setup();
    s.diary('2026-10-28'); s.diary('2026-10-29');
    s.stance('me.stance.praise', '被夸的时候我第一反应是「？」，先装没听懂。');
    assert.equal((await s.introspector.tick({ now: AFTER })).revised, 1);
    const row = s.memory.agent.latest('self').find((r) => r.slot === 'me.stance.praise');
    assert.equal(row.version, 2);
    assert.equal(row.kind, 'stance');
    assert.match(row.text, /这次我没装到底/u);
    const text = s.inject();
    assert.match(text, /\[立场\].*没装到底.*（改过）/u);
  });

  await test('只改自己写过的槽：未知 slot 与 reflect 槽都被丢掉', async () => {
    const s = setup({
      llm: fakeLlm(JSON.stringify({
        thought: '这周我想通了一件小事：我不用每次都把话说满，说一半也可以，剩下的话等人来问，也比自己替他说完强。',
        revised: [
          { slot: 'me.stance.praise', text: '被夸的时候我先笑了。' },
          { slot: 'me.never.exists', text: '这条不该被写进去。' },
          { slot: SLOT, text: '反思不该改写自己。' },
        ],
        noticed: [], want: [], unsure: [],
      })),
    });
    s.diary('2026-10-28'); s.diary('2026-10-29');
    s.stance('me.stance.praise', '先装没听懂。');
    assert.equal((await s.introspector.tick({ now: AFTER })).revised, 1);
    assert.equal(s.memory.agent.latest('self').filter((r) => r.slot === 'me.never.exists').length, 0);
    // reflect 槽本身只能是她这次新写的那一条（version 1）。
    const reflect = s.memory.agent.latest('self').filter((r) => r.slot === SLOT);
    assert.equal(reflect.length, 1);
    assert.equal(reflect[0].version, 1);
  });

  await test('别人的反应进了输入：接没接、接了什么', async () => {
    const s = setup();
    s.diary('2026-10-28'); s.diary('2026-10-29');
    s.told('group:10', '我觉得这手棋只能这么走', { day: 29, h: 11, m: 0 });
    s.say('group:10', { text: '确实，没别的走法', day: 29, h: 11, m: 2 });
    s.told('group:10', '你们今天都去哪了', { day: 28, h: 20, m: 0 });
    assert.equal((await s.introspector.tick({ now: AFTER })).ran, true);
    const prompt = s.llm.prompts[0];
    assert.match(prompt, /你说「我觉得这手棋只能这么走」 → 有人接：「确实，没别的走法」/u);
    assert.match(prompt, /你说「你们今天都去哪了」 → 没人接/u);
  });

  await test('坏 JSON 不落盘：记失败，下一周再看', async () => {
    const s = setup({ llm: fakeLlm('我也想写点什么呢') });
    s.diary('2026-10-28'); s.diary('2026-10-29');
    const result = await s.introspector.tick({ now: AFTER });
    assert.equal(result.reason, 'invalid-json');
    assert.equal(s.stats.introspectFailures, 1);
    assert.equal(s.memory.agent.latest('self').filter((r) => /^me\.reflect\./u.test(r.slot)).length, 0);
  });

  await test('渲染：单独成块、只显示最新一段、号码被拿掉', async () => {
    const s = setup({ llm: fakeLlm(JSON.stringify({
      thought: '晚上有人报了一串数字 123456789，我听着有点走神，后来才想起他其实是在问我今天在不在，就有点后悔没接住。',
      noticed: [], want: [], unsure: [],
    })) });
    s.diary('2026-10-28'); s.diary('2026-10-29');
    s.stance('me.stance.praise', '先装没听懂。');
    assert.equal((await s.introspector.tick({ now: AFTER })).ran, true);
    const text = s.inject();
    assert.match(text, /【我这周想明白的】/u);
    assert.match(text, /〔2026-W44〕/u);
    assert.doesNotMatch(text, /123456789/u);
    // 块顺序：先"我现在的想法"（立场），再"我这周想明白的"（结论）。
    assert.ok(text.indexOf('【我现在的想法】') < text.indexOf('【我这周想明白的】'));
    // 旧的一段不该和新的一段同时挤进提示词。
    assert.equal((text.match(/【我这周想明白的】/gu) ?? []).length, 1);
  });

  await test('没到周日夜里，先补上一周；那一周写完就停', async () => {
    const s = setup();
    // 上一周 W43 = 10-19 ~ 10-25；周中（10-29）跑，补的是 W43。
    s.diary('2026-10-20'); s.diary('2026-10-21');
    const mid = new Date(2026, 9, 29, 12, 0).getTime();
    assert.equal(isoWeek(new Date(mid)), WEEK);
    const result = await s.introspector.tick({ now: mid });
    assert.equal(result.week, '2026-W43');
    assert.equal(s.memory.agent.latest('self').filter((r) => r.slot === 'me.reflect.2026-w43').length, 1);
    // 再跑也不会重写 W43，也不会因为 W44 还没到点就去写 W44。
    const again = await s.introspector.tick({ now: mid + 3600000 });
    assert.equal(again.ran, false);
    assert.equal(again.reason, 'done');
  });
  await test('关机几周再开：最近一周想过了，回头补更早那一个缺口', async () => {
    const s = setup();
    s.diary('2026-10-28'); s.diary('2026-10-29');
    assert.equal((await s.introspector.tick({ now: AFTER })).week, WEEK);
    // 断网那段是 W43：日记在，可当时没人替她想 —— 这就是要补的缺口。
    s.diary('2026-10-20'); s.diary('2026-10-21');
    const later = await s.introspector.tick({ now: AFTER + 7 * 3600000 });
    assert.equal(later.week, '2026-W43');
    assert.equal(s.memory.agent.latest('self').filter((r) => r.slot === 'me.reflect.2026-w43').length, 1);
    // 补过一次就不再补；也不会把同一周写第二遍。
    const again = await s.introspector.tick({ now: AFTER + 14 * 3600000 });
    assert.equal(again.ran, false);
    assert.equal(again.reason, 'done');
  });
} finally {
  for (const store of stores) { try { store.close?.(); } catch { /* 清理失败不影响结论 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 上偶尔删不掉 */ }
}

console.log(`\n周反思：${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
