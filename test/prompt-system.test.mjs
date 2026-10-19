import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planExamples } from '../lib/prompt/examples.mjs';
import { buildPrompt } from '../lib/prompt/render.mjs';
import { stickerInstructionLines } from '../lib/prompt/text-sources.mjs';
import { Store } from '../lib/store.mjs';
import { rig, message, config } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-prompt-system-'));
const project = fileURLToPath(new URL('..', import.meta.url));
const realFetch = globalThis.fetch;
const cards = {};
for (const field of ['persona', 'behavior', 'examples']) {
  cards[field + 'File'] = path.join(root, field + '.md');
  fs.copyFileSync(path.join(project, field + '.md'), cards[field + 'File']);
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e); }
}
try {
  await test('Tulpa examples are retained as the complete custom source', () => {
    const cfg = config(cards), entry = { exampleHashes: {} };
    const one = planExamples(cfg, '难受，被拆穿了，还说我嘴硬', entry);
    assert.equal(one.scenes[0], 'custom');
    assert.match(one.text, /\"id\":\"banter\"/);
    assert.match(one.text, /\"id\":\"unfinished\"/);
    assert.deepEqual(entry.exampleHashes, {});
    const committed = { exampleHashes: one.hashes };
    assert.equal(planExamples(cfg, '普通消息', committed, { includeStatic: false }).text, '');
  });
  await test('custom examples are independent of scene keyword routing', () => {
    const cfg = config(cards);
    const first = planExamples(cfg, '普通消息', {}, { includeStatic: false });
    assert.equal(first.scenes[0], 'custom');
    assert.match(first.text, /\"id\":\"identity\"/);
    const committed = { exampleHashes: first.hashes };
    assert.equal(planExamples(cfg, '任何关键词', committed, { includeStatic: false }).text, '');
    const forced = planExamples(cfg, '普通消息', committed, { includeStatic: true });
    assert.equal(forced.scenes[0], 'custom');
    assert.match(forced.text, /\"id\":\"identity\"/);
  });
  await test('custom examples retain full content and reset with a fresh Session', () => {
    const file = path.join(root, 'custom.md');
    fs.writeFileSync(file, '# 用户自定义\r\n## A\r\n自己的完整约定\r\n## B\r\n另一条约定');
    const cfg = config({ examplesFile: file });
    const first = planExamples(cfg, '普通消息');
    assert.match(first.text, /自己的完整约定\n## B\n另一条约定/);
    const entry = { exampleHashes: first.hashes };
    assert.equal(planExamples(cfg, '普通消息', entry, { includeStatic: false }).text, '');
    assert.equal(planExamples(cfg, '普通消息', entry, { includeStatic: true }).text, first.text);
  });
  await test('failed prompt admission keeps both static and scene references for retry', async () => {
    const r = rig(cards, '[SKIP]');
    r.ctx.sessionController.prompt = async () => { throw Error('offline admission failed'); };
    await r.post(message(1, 'deepseek 厉害'));
    const entry = r.registry.entry('group:10');
    assert.equal(entry.staticDone, false);
    assert.deepEqual(entry.exampleHashes, {});
    assert.equal(entry.turns, 0);
    r.ctx.sessionController.prompt = async p => r.prompts.push(p);
    await r.post(message(2, 'deepseek 厉害'));
    assert.match(r.prompts[0].content[0].text, /\"id\":\"banter\"/);
    assert.equal(entry.staticDone, true);
    assert.ok(entry.exampleHashes.custom);
    await r.post(message(3, 'deepseek 厉害'));
    assert.doesNotMatch(r.prompts[1].content[0].text, /\"id\":\"banter\"|【长任务协调】/);
    assert.equal(r.calls.filter(c => c.action.startsWith('send_')).length, 0);
  });
  await test('saved scene cursors survive registry reload and source edits create a clean Session', async () => {
    const store = new Store(path.join(root, 'test.sqlite3'));
    try {
      const r = rig(cards, '[SKIP]', store);
      await r.post(message(1, 'deepseek 厉害'));
      const oldId = r.registry.entry('group:10').sessionId;
      const restored = rig(cards, '[SKIP]', store);
      restored.ctx.sessionController.create = async () => ({ sessionId: 'new-card-session' });
      await restored.post(message(2, 'deepseek 厉害'));
      assert.equal(restored.registry.entry('group:10').sessionId, oldId);
      assert.doesNotMatch(restored.prompts[0].content[0].text, /\"id\":\"banter\"/);
      fs.appendFileSync(cards.personaFile, '\n新增角色来源标识');
      const tick = new Date(Date.now() + 5000);
      fs.utimesSync(cards.personaFile, tick, tick);
      await restored.post(message(3, 'deepseek 厉害'));
      assert.equal(restored.registry.entry('group:10').sessionId, 'new-card-session');
      assert.match(restored.prompts[1].content[0].text, /新增角色来源标识/);
      assert.match(restored.prompts[1].content[0].text, /\"id\":\"banter\"/);
    } finally { store.db.close(); }
  });
  await test('compaction restores scene references alongside the static protocol', async () => {
    const r = rig(cards, '[SKIP]');
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'compaction/summary', data: {} } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    await r.post(message(1, 'deepseek 嘴硬'));
    assert.deepEqual(r.registry.entry('group:10').exampleHashes, {});
    assert.equal(r.registry.entry('group:10').staticDone, false);
    await r.post(message(2, 'deepseek 嘴硬'));
    assert.match(r.prompts[1].content[0].text, /\"id\":\"banter\"/);
    assert.match(r.prompts[1].content[0].text, /【长任务协调】/);
  });
  await test('dynamic context keeps source, addressee and chronological history near the current input', () => {
    const prompt = buildPrompt(message(4, '当前提问'), config(cards), {
      includeStatic: false, sourceRef: 'offline-source', taskText: '任务事实',
      memoryText: '人物事实', windowText: '甲旧消息\n自己消息\n乙新消息',
    });
    assert.match(prompt, /【本轮来源】offline-source/);
    assert.ok(prompt.indexOf('甲旧消息') < prompt.indexOf('自己消息'));
    assert.ok(prompt.indexOf('自己消息') < prompt.indexOf('乙新消息'));
    assert.ok(prompt.indexOf('乙新消息') < prompt.indexOf('—— 现在这条消息 ——'));
    assert.ok(prompt.endsWith('当前提问'));
    assert.doesNotMatch(prompt, /【长任务协调】|【记住事情】|【怎么说话】/);
  });
  await test('ordinary dynamic turns omit the workspace path while file turns retain it', () => {
    const chat = buildPrompt(message(14, '今天吃什么'), config(), { includeStatic: false });
    assert.doesNotMatch(chat, /【工作区绝对路径】/);
    const file = buildPrompt(message(15, '帮我写一个 html 文件'), config(), { includeStatic: false });
    assert.match(file, /【工作区绝对路径】/);
    const owned = buildPrompt(message(16, '继续任务'), config(), {
      includeStatic: false,
      taskOwnership: { taskId: 'task-1', executionId: 'execution-1', messageIds: ['16'] },
    });
    assert.match(owned, /【本轮执行归属】/);
    assert.match(owned, /execution-1/);
  });
  await test('sticker samples use real unique candidates and random draws instead of text matching', () => {
    const file = path.join(root, 'catalog.json');
    fs.writeFileSync(file, JSON.stringify([{ n: 91, desc: '难过哭泣' }, { n: 92, desc: '开心得意' }, { n: 93, desc: '吃饭' }]));
    const cfg = config({ stickerCatalogPath: file, stickerCatalogLimit: 2 });
    const lines = stickerInstructionLines(cfg, '难过', () => 0.99).join('\n');
    assert.match(lines, /#93 吃饭\n#92 开心得意/);
    assert.match(lines, /\[表情:93\]/);
    assert.doesNotMatch(lines, /#91|干饭碗/);
    assert.match(stickerInstructionLines(cfg, '难过', () => 0).join('\n'), /#91 难过哭泣\n#92 开心得意/);
    assert.equal(stickerInstructionLines({ ...cfg, stickerCatalogLimit: 4 }).filter(line => line.startsWith('#')).length, 3);
  });
  await test('later turns refresh four sticker candidates next to the current message while static cards stay omitted', async () => {
    const file = path.join(root, 'dynamic-catalog.json');
    fs.writeFileSync(file, JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ n: 101 + i, desc: `真实表情${i}` }))));
    const r = rig({ ...cards, stickerHints: true, stickerCatalogPath: file }, '[SKIP]');
    const realRandom = Math.random;
    try {
      Math.random = () => 0;
      await r.post(message(11, 'deepseek 同一句'));
      Math.random = () => 0.99;
      await r.post(message(12, 'deepseek 同一句'));
    } finally { Math.random = realRandom; }
    const first = r.prompts[0].content[0].text, later = r.prompts[1].content[0].text;
    for (const prompt of [first, later]) {
      assert.match(prompt, /【你的表情包·本轮候选】/);
      assert.equal((prompt.match(/^#\d+ /gm) ?? []).length, 4);
      assert.ok(prompt.indexOf('【你的表情包·本轮候选】') > prompt.indexOf('【本轮发送规则】'));
      assert.ok(prompt.indexOf('【你的表情包·本轮候选】') < prompt.indexOf('—— 现在这条消息 ——'));
    }
    assert.match(first, /#101 真实表情0/);
    assert.doesNotMatch(first, /#108 /);
    assert.match(later, /#108 真实表情7/);
    assert.doesNotMatch(later, /#101 |【怎么说话】|\[你的人设\]/);
    const disabled = buildPrompt(message(13), config({ stickerHints: false, stickerCatalogPath: file }), { includeStatic: false });
    assert.doesNotMatch(disabled, /【你的表情包·本轮候选】|#10[1-8] /);
  });
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
