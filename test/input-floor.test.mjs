import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { observeFloor, captureFloor, checkFloor, publishFloorSource, checkToolFloor, recheckFloor, recordFloorRecall } from '../lib/conversation/floor.mjs';
import { InputBatches } from '../lib/conversation/input-batches.mjs';
import { replyJournal } from '../lib/delivery/reply-journal.mjs';
import { queueReply } from '../lib/delivery/reply-delivery.mjs';
import { recoverReplies } from '../lib/application/reply-recovery.mjs';
import { Store } from '../lib/store.mjs';
import { isPassiveReaction } from '../lib/domain/events.mjs';
import { gateShouldSpeak } from '../lib/application/heartbeat.mjs';

let passed = 0, failed = 0;
const rigs = [], stores = [], originalFetch = globalThis.fetch;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-floor-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (over = {}, reply = '[SKIP]', store = null, llm = null) => {
  const r = rig({ inputDebounceMs: 20, inputMaxWaitMs: 70, floorManagementEnabled: true,
    groupTrigger: 'all', selfIds: ['100'], sendQuotaPerMinute: 100, ...over }, reply, store, llm);
  rigs.push(r); return r;
};
const post = (r, e) => r.handler(request(e), response());
const settle = async (r, ms = 90) => { await sleep(ms); await r.drain(); await r.sendQueue.flush(); };
const direct = (id, text, user = 200) => {
  const e = message(id, text, 10, user); e.message.unshift({ type: 'at', data: { qq: '100' } }); return e;
};
const reaction = (id, user = 200) => ({ ...message(id, '', 10, user),
  message: [{ type: 'image', data: { sub_type: 1, summary: '[动画表情]' } }] });
const storeFor = () => { const s = new Store(path.join(root, `${stores.length}.sqlite3`)); stores.push(s); return s; };
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e.stack); }
}
try {
  await test('same-author independent speech and several other speakers cannot erase an answer on fallback', async () => {
    const r = make(), key = 'group:10', e = message('request', '这不是你自己搜到的？');
    observeFloor(r.config, r.registry, key, e);
    const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('new-question', '另外问一下，几点了'));
    observeFloor(r.config, r.registry, key, message('other-a', '去打瓦吧', 10, 300));
    observeFloor(r.config, r.registry, key, message('other-b', '我来', 10, 400));
    const verdict = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key),
      '刚那个是真搜到的，另一个是编的，两回事', r.state.controller.signal, r.stats);
    assert.equal(verdict.action, 'keep');
    assert.equal(checkFloor(null, key, policy, r.registry.entry(key)).action, 'keep');
  });
  await test('a backchannel author cannot acquire cancellation rights over an unmentioned request', async () => {
    const r = make(), key = 'group:10', request = message('request', '请确认我的名字'), aside = message('aside', '哈哈', 10, 300);
    observeFloor(r.config, r.registry, key, request); observeFloor(r.config, r.registry, key, aside);
    const policy = captureFloor(r.config, r.registry, key, [request, aside]);
    assert.deepEqual(policy.authors, ['200']);
    observeFloor(r.config, r.registry, key, message('cancel', '不用了', 10, 300));
    assert.equal(checkFloor(null, key, policy, r.registry.entry(key)).action, 'keep');
  });
  await test('semantic drops require disposable chat and concrete evidence, direct questions remain owed', async () => {
    for (const shape of ['answer', 'direct', 'no-evidence']) {
      const llm = { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ action: 'drop',
        value: shape === 'answer' ? 'correction' : 'chat', basis: 'obsolete-chat',
        evidence: shape === 'no-evidence' ? ['invented'] : ['new'], reason: '话题转走了' }) }; } };
      const r = make({}, '', null, llm), key = 'group:10';
      const e = shape === 'direct' ? direct('request', '需要一份清单') : message('request', '上次说错了吧');
      observeFloor(r.config, r.registry, key, e);
      const policy = captureFloor(r.config, r.registry, key, [e]);
      observeFloor(r.config, r.registry, key, message('new', '来打瓦', 10, 300));
      const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key),
        '这是我的答复', r.state.controller.signal, r.stats);
      assert.equal(result.action, 'keep', shape); assert.equal(r.stats.lastFloorDecision.fallback, true);
    }
  });
  await test('an evidenced obsolete chat tail still yields the floor', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text:
      '{"action":"drop","value":"chat","basis":"obsolete-chat","evidence":["new"],"reason":"接梗已过时"}' }; } };
    const r = make({}, '', null, llm), key = 'group:10', e = message('request', '哈哈这事闹的');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('new', '我们现在讨论下一场比赛', 10, 300));
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key),
      '笑死', r.state.controller.signal, r.stats);
    assert.equal(result.action, 'drop'); assert.deepEqual(r.stats.lastFloorDecision.evidence, ['new']);
  });
  await test('unsupported semantic updates preserve the old answer instead of merging unrelated questions', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text:
      '{"action":"update","reason":"同一个人又说话了"}' }; } };
    const r = make({}, '', null, llm), key = 'group:10', e = direct('request', '我名字是什么');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('new', '下一局打什么'));
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key),
      '吴家杰，记住了', r.state.controller.signal, r.stats);
    assert.equal(result.action, 'keep');
  });
  await test('a semantic revision names the actual amendment and excludes an independent question', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text:
      '{"action":"update","basis":"revision","evidence":["amendment"],"reason":"原要求补充尺寸"}' }; } };
    const r = make({}, '', null, llm), key = 'group:10', e = direct('request', '给我一个方案');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('amendment', '尺寸其实是40乘20'));
    observeFloor(r.config, r.registry, key, message('independent', '另外问一下，几点了'));
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key),
      '按10乘10来做', r.state.controller.signal, r.stats);
    assert.equal(result.action, 'update'); assert.deepEqual(result.evidence, ['amendment']);
  });
  await test('unmentioned questions from different authors own separate batches', async () => {
    const r = make(); await post(r, message('first', '你上次的消息是真搜的吗'));
    await post(r, message('second', '能给我看看地图吗', 10, 300));
    await settle(r, 140); assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[0].content[0].text, /你上次的消息是真搜的吗/);
    assert.match(r.prompts[1].content[0].text, /能给我看看地图吗/);
  });
  await test('another person cannot resume or consume a requester WAIT', async () => {
    const r = make({}, '[WAIT]');
    await post(r, direct('first', '等我把要求发来')); await settle(r);
    await post(r, direct('other', '这是另一件事', 300)); await settle(r);
    const section = r.prompts[1].content[0].text;
    assert.ok(!section.includes('消息 first'));
    assert.equal(r.state.inputBatches.entry('group:10').waiting[0].message_id, 'first');
    await post(r, message('fragment', '要白色的')); await settle(r);
    assert.match(r.prompts[2].content[0].text, /消息 first/);
  });
  await test('same-author independent question does not revive a WAIT batch', async () => {
    const r = make({}, '[WAIT]'), key = 'group:10';
    await post(r, direct('wait', '等我发条件')); await settle(r);
    await post(r, direct('new', '这是另一件事')); await settle(r);
    assert.equal(r.prompts.length, 2);
    assert.ok(!r.prompts[1].content[0].text.includes('消息 wait'));
    assert.equal(r.state.inputBatches.entry(key).waiting[0].message_id, 'wait');
  });
  await test('requester cancellation remains effective after the 100-row floor window rolls over', async () => {
    const r = make(), key = 'group:10', request = direct('request', '帮我画图');
    observeFloor(r.config, r.registry, key, request);
    const policy = captureFloor(r.config, r.registry, key, [request]);
    observeFloor(r.config, r.registry, key, message('cancel', '不用了'));
    for (let i = 0; i < 105; i++) observeFloor(r.config, r.registry, key, message('later-' + i, '普通聊天', 10, 300));
    assert.equal(r.registry.entry(key).floor.messages.length, 100);
    assert.equal(checkFloor(null, key, policy, r.registry.entry(key)).reason, 'request-cancelled');
  });
  await test('request recall is persisted in floor state independently of the context window', async () => {
    const store = storeFor(), r = make({}, '', store), key = 'group:10', request = direct('request', '给我做个表');
    observeFloor(r.config, r.registry, key, request);
    const policy = captureFloor(r.config, r.registry, key, [request]);
    recordFloorRecall(store, key, 'request', r.registry.entry(key));
    const restored = { floor: null, recalledIds: [] };
    assert.equal(checkFloor(store, key, policy, restored).reason, 'request-recalled');
  });
  await test('WAIT ownership and individual expiry survive restoring a shared database', async () => {
    const store = storeFor(), r = make({}, '', store);
    const first = direct('first', '等我发条件'), second = direct('second', '等我的条件', 300);
    r.state.inputBatches.hold('group:10', [first]); r.state.inputBatches.hold('group:10', [second]);
    const entry = r.state.inputBatches.entry('group:10');
    entry.waiting[0].__waitUntil = Date.now() - 1; r.state.inputBatches.save('group:10');
    const restored = new InputBatches({ config: r.config, registry: r.registry, state: r.state, stats: r.stats,
      run: async () => {}, onError: () => {} });
    restored.add('group:10', message('fragment', '我的补充', 10, 300)); restored.dispose();
    assert.deepEqual(restored.entry('group:10').events.map((e) => e.message_id), ['second', 'fragment']);
    assert.equal(restored.entry('group:10').waiting.length, 0);
  });
  await test('between-bubble rechecks see only unsent candidate text', async () => {
    const candidates = [], llm = { async *stream(input) {
      candidates.push(JSON.parse(input.messages[0].content[0].text).candidate);
      yield { type: 'text-delta', text: '{"action":"keep","reason":"仍需交付"}' };
    } };
    const r = make({ bubbleDelayMinMs: 80, bubbleDelayMaxMs: 80, bubbleDelayPerCharMs: 1 }, '', null, llm);
    const key = 'group:10', e = direct('request', '给我说明');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    queueReply(r.ctx, r.config, r.sendQueue, { key, entry: r.registry.entry(key), stats: r.stats,
      target: { group_id: 10 }, isGroup: true, reply: '第一句\n\n第二句', floorPolicy: policy });
    await sleep(25); observeFloor(r.config, r.registry, key, message('new', '另问一个问题，几点了'));
    await r.sendQueue.flush();
    assert.deepEqual(candidates, ['第二句']); assert.deepEqual(r.calls.map((c) => c.payload.message), ['第一句', '第二句']);
  });
  await test('pure reactions never trigger group-all or awake model calls, but stay in context', async () => {
    const r = make({ heartbeatEnabled: true });
    const entry = r.registry.entry('group:10'); entry.awakeUntil = Date.now() + 60000;
    const until = entry.awakeUntil;
    for (let i = 0; i < 8; i++) await post(r, reaction('sticker-' + i));
    await settle(r);
    assert.equal(r.prompts.length, 0); assert.equal(r.calls.length, 0);
    assert.equal(entry.awakeUntil, until); assert.equal(entry.pending.length, 8);
    assert.equal(r.stats.passiveReactionsBuffered, 8);
  });
  await test('a reaction arriving while generation runs cannot create a standalone next turn', async () => {
    const r = make(); let release;
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      await new Promise((resolve) => { release = resolve; });
      yield { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[SKIP]' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    await post(r, direct('request', '你们这些家伙在说什么呢')); await sleep(40);
    assert.equal(typeof release, 'function');
    await post(r, reaction('late-sticker')); release(); await settle(r);
    assert.equal(r.prompts.length, 1);
    const snapshot = r.state.inputBatches.snapshot()[0];
    assert.equal(snapshot.pending, 0); assert.equal(snapshot.passive, 1); assert.equal(snapshot.scheduled, false);
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '[SKIP]' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    await post(r, message('followup', '就是刚才那个事情')); await settle(r);
    assert.equal(r.prompts.length, 2); assert.match(r.prompts[1].content[0].text, /消息 late-sticker/);
  });
  await test('short bubbles spaced beyond the base debounce still form one input batch', async () => {
    const r = make({ inputShortDebounceMs: 100, inputMaxWaitMs: 300 });
    await post(r, direct('first', '画个小狗')); await sleep(45);
    assert.equal(r.prompts.length, 0);
    await post(r, message('second', '白色的')); await sleep(45);
    await post(r, reaction('third')); await settle(r, 140);
    assert.equal(r.prompts.length, 1);
    const prompt = r.prompts[0].content[0].text;
    assert.match(prompt, /白色的/); assert.match(prompt, /消息 third/);
  });
  await test('a queued batch waits for renewed quiet time after obtaining the conversation', async () => {
    const r = make({ inputShortDebounceMs: 100, inputMaxWaitMs: 300 }); let release;
    r.registry.run('group:10', () => new Promise((resolve) => { release = resolve; })); await sleep(1);
    await post(r, direct('first', '第一个条件')); await sleep(110);
    await post(r, message('second', '第二个条件')); release(); await sleep(35);
    assert.equal(r.prompts.length, 0);
    await post(r, message('third', '第三个条件')); await settle(r, 140);
    assert.equal(r.prompts.length, 1); assert.match(r.prompts[0].content[0].text, /第三个条件/);
  });
  await test('reaction floods are bounded and cannot force a passive-only drain or strand real inputs', async () => {
    const r = make({ inputBatchMaxMessages: 3, inputShortDebounceMs: 80, inputMaxWaitMs: 160 });
    await post(r, direct('request', '能解释一下吗'));
    for (let i = 0; i < 30; i++) await post(r, reaction('reaction-' + i, 300));
    assert.equal(r.prompts.length, 0);
    assert.equal(r.state.inputBatches.snapshot()[0].passive, 2);
    await settle(r, 190); assert.equal(r.prompts.length, 1);
    assert.equal(r.state.inputBatches.snapshot()[0].scheduled, false);
  });
  await test('reactions do not resume WAIT; the next actual fragment still includes the original request', async () => {
    const r = make({}, '[WAIT]');
    await post(r, direct('request', '等我补充')); await settle(r);
    await post(r, reaction('sticker')); await settle(r);
    assert.equal(r.prompts.length, 1); assert.equal(r.state.inputBatches.snapshot()[0].waiting, 1);
    await post(r, message('fragment', '要白色的')); await settle(r);
    assert.equal(r.prompts.length, 2); assert.match(r.prompts[1].content[0].text, /等我补充/);
  });
  await test('reaction-only restored heartbeat input needs no classification model call', async () => {
    let calls = 0; const r = make({}, '', null, { async *stream() { calls++; } });
    const verdict = await gateShouldSpeak(r.ctx, r.config, { pending: [
      { text: '[表情包][表情]' }, { text: ' [动画表情 哈哈] ' },
    ] }, r.stats, r.state.controller.signal);
    assert.equal(verdict.speak, false); assert.equal(calls, 0);
  });
  await test('reaction detection keeps directed, quoted, text-captioned and private images actionable', async () => {
    assert.equal(isPassiveReaction(reaction('pure')), true);
    for (const kind of ['at', 'reply', 'text', 'private', 'ordinary']) {
      const e = reaction(kind);
      if (kind === 'private') e.message_type = 'private';
      else if (kind === 'ordinary') e.message[0].data = { sub_type: 0, summary: '[图片]' };
      else e.message.unshift({ type: kind, data: { qq: '100', id: 'quoted', text: '哈哈' } });
      assert.equal(isPassiveReaction(e), false, kind);
    }
    const r = make(); const e = reaction('direct'); e.message.unshift({ type: 'at', data: { qq: '100' } });
    await post(r, e); await settle(r); assert.equal(r.prompts.length, 1);
  });
  await test('native face, mface and summary-only sticker reactions never invalidate ongoing output', async () => {
    const r = make(), key = 'group:10', e = direct('request', '解释一下');
    observeFloor(r.config, r.registry, key, e);
    const policy = captureFloor(r.config, r.registry, key, [e]);
    for (const segment of [ { type: 'face', data: { id: 64 } }, { type: 'mface', data: { summary: '哈哈' } },
      { type: 'image', data: { summary: '[动画表情]' } } ]) {
      const next = message('reaction-' + segment.type, ''); next.message = [segment];
      observeFloor(r.config, r.registry, key, next);
    }
    assert.equal(checkFloor(null, key, policy, r.registry.entry(key)).action, 'keep');
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key), '解释', r.state.controller.signal, r.stats);
    assert.equal(result.action, 'keep'); assert.equal(r.stats.floorRechecks, undefined);
  });
  await test('one direct request collects unmentioned fragments before first speech; real author and times survive', async () => {
    const r = make({ groupTrigger: 'at', awakeMs: 0 }, '可以');
    await post(r, direct('a', '画个小狗')); await post(r, message('b', '白色的')); await post(r, message('c', '戴帽子'));
    await settle(r);
    assert.equal(r.prompts.length, 1);
    assert.equal(r.calls.filter((c) => c.action === 'send_group_msg').length, 1);
    const prompt = r.prompts[0].content[0].text;
    assert.match(prompt, /画个小狗/); assert.match(prompt, /白色的/); assert.match(prompt, /戴帽子/);
    assert.deepEqual(r.registry.entry('group:10').window.filter((m) => !m.bot).map((m) => m.messageId), ['a', 'b', 'c']);
  });
  await test('interleaved authors remain A B C A, same-second opaque ids never reorder', async () => {
    const r = make();
    for (const e of [direct('z', '能画吗'), message('x', '666', 10, 300), message('y', '哈哈', 10, 400), message('a', '白色的小狗')]) {
      e.time = 1800000000; await post(r, e);
    }
    await settle(r);
    assert.equal(r.prompts.length, 1);
    const prompt = r.prompts[0].content[0].text, section = prompt.slice(prompt.indexOf('本次收集的原始消息'));
    assert.ok(section.indexOf('消息 z') < section.indexOf('消息 x'));
    assert.ok(section.indexOf('消息 x') < section.indexOf('消息 y'));
    assert.ok(section.indexOf('消息 y') < section.indexOf('消息 a'));
    assert.match(section, /300/); assert.match(section, /400/);
  });
  await test('queued bursts take their snapshot when they actually own registry.run', async () => {
    const r = make(); let release;
    r.registry.run('group:10', () => new Promise((res) => { release = res; })); await sleep(1);
    await post(r, direct('1', '第一个条件')); await sleep(30); await post(r, message('2', '第二个条件'));
    release(); await settle(r);
    assert.equal(r.prompts.length, 1); assert.match(r.prompts[0].content[0].text, /第二个条件/);
  });
  await test('independent explicit requests from different people get separate source turns', async () => {
    const r = make(); await post(r, direct('1', '画个小狗')); await post(r, direct('2', '查一下时间', 300));
    await settle(r, 130); assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[0].content[0].text, /画个小狗/); assert.match(r.prompts[1].content[0].text, /查一下时间/);
  });
  await test('a routed aside before a valid followup cannot veto the whole collected batch', async () => {
    const r = make({ groupAttentionEnabled: true });
    const aside = message('1', '你等一下', 10, 300); aside.message.unshift({ type: 'at', data: { qq: '400' } });
    await post(r, aside); await post(r, message('2', '你刚才说的能解释一下吗'));
    await settle(r); assert.equal(r.prompts.length, 1);
    assert.match(r.prompts[0].content[0].text, /能解释一下吗/);
  });
  await test('cancellation in the collection window consumes the request without generating or waking', async () => {
    const r = make(); await post(r, direct('1', '画狗')); await post(r, message('2', '不用做了'));
    await settle(r); assert.equal(r.prompts.length, 0); assert.equal(r.calls.length, 0);
    assert.equal(r.registry.entry('group:10').awakeUntil, 0);
  });
  await test('WAIT sends nothing, keeps awake unchanged, and resumes with original request', async () => {
    const r = make({}, '[WAIT]'); const entry = r.registry.entry('group:10');
    entry.awakeUntil = Date.now() + 60000; const until = entry.awakeUntil;
    await post(r, direct('1', '稍等我把要求发来')); await settle(r);
    assert.equal(r.calls.length, 0); assert.equal(entry.awakeUntil, until);
    assert.equal(r.state.inputBatches.snapshot()[0].waiting, 1);
    await post(r, message('2', '要白色小狗')); await settle(r);
    assert.equal(r.prompts.length, 2); assert.match(r.prompts[1].content[0].text, /稍等我把要求发来/);
    assert.match(r.prompts[1].content[0].text, /要白色小狗/);
  });
  await test('generation-time correction supersedes old output and reprocesses combined inputs once', async () => {
    const r = make({ groupTrigger: 'at' }, '旧答案'); let release, rounds = 0;
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      if (++rounds === 1) await new Promise((res) => { release = res; });
      yield { type: 'event', event: { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: rounds === 1 ? '旧答案' : '更新答案' }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end' } };
    } });
    await post(r, direct('1', '白色小狗')); await sleep(35);
    await post(r, message('2', '改成黑色')); release(); await settle(r, 130);
    assert.equal(rounds, 2); assert.deepEqual(r.calls.map((c) => c.payload.message), ['更新答案']);
    assert.match(r.prompts[1].content[0].text, /白色小狗/); assert.match(r.prompts[1].content[0].text, /改成黑色/);
  });
  await test('ordinary query tool calls do not bypass a generation-time correction', async () => {
    const r = make({ groupTrigger: 'at' }, '旧答案'); let release, rounds = 0;
    r.ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      const round = ++rounds;
      if (round === 1) {
        yield { type: 'event', event: { seq: 1, type: 'tool/call', data: { callId: 'query', name: 'qq_group_info', arguments: {} } } };
        yield { type: 'event', event: { seq: 2, type: 'tool/result', data: { callId: 'query', message: { content: [], isError: false } } } };
        await new Promise((res) => { release = res; });
      }
      yield { type: 'event', event: { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: round === 1 ? '旧答案' : '更新答案' }] } } } };
      yield { type: 'event', event: { seq: 4, type: 'turn/end' } };
    } });
    await post(r, direct('request', '白色小狗')); await sleep(35);
    await post(r, message('change', '改成黑色')); release(); await settle(r, 130);
    assert.equal(rounds, 2); assert.deepEqual(r.calls.map((c) => c.payload.message), ['更新答案']);
  });
  await test('only requester cancellation drops the request, reactions and quoted cancellation do not', async () => {
    const r = make(), key = 'group:10', entry = r.registry.entry(key), e = direct('1', '帮我做图');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('2', '666', 10, 300));
    assert.equal(checkFloor(null, key, policy, entry).action, 'keep');
    observeFloor(r.config, r.registry, key, message('3', '算了', 10, 300));
    assert.equal(checkFloor(null, key, policy, entry).action, 'keep');
    observeFloor(r.config, r.registry, key, message('4', '他说“算了不用做了”'));
    assert.equal(checkFloor(null, key, { ...policy, task: true }, entry).action, 'keep');
    observeFloor(r.config, r.registry, key, message('5', '不用做了'));
    assert.equal(checkFloor(null, key, { ...policy, task: true }, entry).reason, 'request-cancelled');
  });
  await test('same author explicitly speaking to others never changes their earlier request', async () => {
    const r = make(), key = 'group:10', e = direct('1', '画个狗');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    const other = message('2', '算了'); other.message.unshift({ type: 'at', data: { qq: '300' } });
    observeFloor(r.config, r.registry, key, other);
    assert.equal(checkFloor(null, key, policy, r.registry.entry(key)).action, 'keep');
  });
  await test('between-bubble cancellation retains successful first receipt and finishes the durable tail', async () => {
    const store = storeFor(), r = make({ bubbleDelayMinMs: 100, bubbleDelayMaxMs: 100, bubbleDelayPerCharMs: 1 }, '', store);
    const journal = r.state.replyJournal = replyJournal(store), key = 'group:10', e = direct('1', '能做吗');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    journal.begin('tail', key, { event: e }); journal.output('tail', { reply: '第一句\n\n第二句' });
    queueReply(r.ctx, r.config, r.sendQueue, { key, entry: r.registry.entry(key), stats: r.stats, store, state: r.state,
      target: { group_id: 10 }, isGroup: true, reply: '第一句\n\n第二句', turnId: 'tail', journal, journalId: 'tail',
      floorPolicy: policy });
    await sleep(25); observeFloor(r.config, r.registry, key, message('2', '不用了'));
    await r.sendQueue.flush(); await sleep(1);
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['第一句']);
    assert.equal(store.getReceipt('tail#b0').status, 'SUCCEEDED'); assert.equal(store.getReceipt('tail#b1'), null);
    assert.equal(journal.get('tail').state, 'done'); assert.match(journal.get('tail').detail, /floor:request-cancelled/);
    await recoverReplies(r.ctx, r.config, r.registry, r.state, null, r.stats, store, r.sendQueue);
    assert.equal(r.calls.length, 1);
  });
  await test('source guards survive reload and protect MCP chat, task outputs and cancellation', async () => {
    const store = storeFor(), r = make({}, '', store), key = 'group:10', e = direct('1', '画狗');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    publishFloorSource(store, 'ref', key, policy); observeFloor(r.config, r.registry, key, message('2', '黑色的'));
    assert.equal(checkToolFloor(store, 'ref', key).action, 'update');
    store.setState('qq-bridge:file-progress:ref', JSON.stringify({ at: Date.now() }));
    assert.equal(checkToolFloor(store, 'ref', key).action, 'keep');
    observeFloor(r.config, r.registry, key, message('3', '取消'));
    assert.equal(checkToolFloor(store, 'ref', key, { task: true }).action, 'drop');
    assert.equal(checkToolFloor(store, 'ref', 'group:20').action, 'keep');
  });
  await test('uncertain durable prompt ownership never resubmits the same request after restore', async () => {
    const store = storeFor(), r = make({}, '', store); r.state.replyJournal = replyJournal(store);
    let submitted = 0;
    r.ctx.sessionController.prompt = async () => { submitted++; throw Error('unknown prompt transport result'); };
    await post(r, direct('1', '制作文件')); await settle(r);
    assert.equal(submitted, 1); assert.equal(r.state.inputBatches.snapshot()[0].pending, 0);
    assert.equal(r.state.replyJournal.pending().length, 1);
    r.state.inputBatches.restore(); await settle(r);
    assert.equal(submitted, 1);
  });
  await test('task delivery survives correction chatter without replaying tools or changing UNKNOWN ownership', async () => {
    const store = storeFor(), r = make({}, '', store), key = 'group:10', e = direct('1', '制作文件');
    const journal = r.state.replyJournal = replyJournal(store);
    observeFloor(r.config, r.registry, key, e); const policy = { ...captureFloor(r.config, r.registry, key, [e]), task: true };
    observeFloor(r.config, r.registry, key, message('2', '再加个按钮'));
    journal.begin('task', key, { event: e }); journal.output('task', { reply: '文件结果' });
    queueReply(r.ctx, r.config, r.sendQueue, { key, entry: r.registry.entry(key), stats: r.stats, store, state: r.state,
      target: { group_id: 10 }, isGroup: true, reply: '文件结果', turnId: 'task', journal, journalId: 'task', floorPolicy: policy });
    await r.sendQueue.flush(); await sleep(1); assert.equal(journal.get('task').state, 'done');
    assert.deepEqual(r.calls.map((c) => c.payload.message), ['文件结果']);
    journal.begin('unknown', key, { event: e }); journal.output('unknown', { reply: '未知内容' });
    const payload = { group_id: 10, message: '未知内容' };
    store.reserveSend({ idemKey: 'unknown#b0', conversation: key, kind: 'send_group_msg', target: '10', payload }, []);
    store.finishSend('unknown#b0', 'UNKNOWN', { detail: 'lost response' });
    journal.planned('unknown', { key, isGroup: true, target: { group_id: 10 }, action: 'send_group_msg', idemBase: 'unknown',
      bubbles: ['未知内容'], sticker: null, floorPolicy: policy }); journal.error('unknown', 'lost response', { attention: true });
    observeFloor(r.config, r.registry, key, message('3', '取消'));
    await recoverReplies(r.ctx, r.config, r.registry, r.state, null, r.stats, store, r.sendQueue);
    assert.equal(journal.get('unknown').state, 'attention'); assert.equal(store.getReceipt('unknown#b0').status, 'UNKNOWN');
    assert.equal(r.calls.length, 1);
  });
  await test('semantic recheck receives full context and keeps a new independent question separate', async () => {
    const inputs = [], llm = { async *stream(input) { inputs.push(input); yield { type: 'text-delta', text: '{"action":"keep","reason":"另一个问题"}' }; } };
    const r = make({}, '', null, llm), key = 'group:10', e = direct('1', '你能做图吗');
    r.registry.record(r.registry.entry(key), { bot: true, text: '你想做什么图？', messageId: 'previous' });
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('2', '还有个独立问题，几点了'));
    const verdict = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key), '可以做图', r.state.controller.signal, r.stats);
    assert.equal(verdict.action, 'keep'); assert.match(inputs[0].messages[0].content[0].text, /你想做什么图/);
    assert.match(inputs[0].messages[0].content[0].text, /可以做图/);
  });
  await test('malformed recheck falls back without losing direct replies to other peoples 666', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text: 'oops' }; } };
    const r = make({}, '', null, llm), key = 'group:10', e = direct('1', '你好');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('2', '我们去开黑', 10, 300));
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key), '你好', r.state.controller.signal, r.stats);
    assert.equal(result.action, 'keep'); assert.equal(r.stats.floorRecheckFallbacks, 1);
  });
  await test('a cancellation arriving during a failed semantic check uses the latest version', async () => {
    let r;
    const llm = { async *stream() {
      observeFloor(r.config, r.registry, 'group:10', message('3', '不用了'));
      yield { type: 'text-delta', text: 'invalid JSON' };
    } };
    r = make({}, '', null, llm); const key = 'group:10', e = direct('1', '画狗');
    observeFloor(r.config, r.registry, key, e); const policy = captureFloor(r.config, r.registry, key, [e]);
    observeFloor(r.config, r.registry, key, message('2', '改成白色'));
    const result = await recheckFloor(r.ctx, r.config, null, key, policy, r.registry.entry(key), '可以', r.state.controller.signal, r.stats);
    assert.equal(result.reason, 'request-cancelled');
  });
  await test('pending inputs and WAIT restore durably, unclaimed messages obey changed admission', async () => {
    const store = storeFor(), r = make({}, '', store);
    r.state.inputBatches.add('group:10', direct('1', '原请求')); r.state.inputBatches.dispose();
    let seen;
    const restored = new InputBatches({ config: r.config, registry: r.registry, state: r.state, stats: r.stats,
      run: async (_, events) => { seen = events; return { wait: true }; }, onError: (e) => { throw e; } });
    restored.restore(); await sleep(90); await r.registry.entry('group:10').chain;
    assert.equal(seen.length, 1); assert.equal(restored.snapshot()[0].waiting, 1);
    restored.dispose(); r.config.groups = ['20'];
    const filtered = new InputBatches({ config: r.config, registry: r.registry, state: r.state, stats: r.stats,
      run: () => { throw Error('excluded group'); }, onError: () => {} });
    filtered.add('group:10', message('2', '补充')); await sleep(90); await r.registry.entry('group:10').chain;
    assert.equal(filtered.snapshot()[0].pending, 0); filtered.dispose();
  });
  await test('conversation isolation, whitelist and self-message filters remain active', async () => {
    const r = make({ groups: ['10', '20'] });
    await post(r, direct('1', '群一')); const e = direct('2', '群二'); e.group_id = 20; await post(r, e);
    await post(r, message('3', '不准入', 30)); await post(r, message('4', '机器人自己的话', 10, 100));
    await settle(r); assert.equal(r.prompts.length, 2); assert.equal(r.registry.byKey.has('group:30'), false);
  });
  await test('maximum collection deadline makes a decision without forcing speech in a busy group', async () => {
    const r = make({ inputDebounceMs: 35, inputMaxWaitMs: 70 });
    for (let i = 0; i < 7; i++) { await post(r, message(String(i), '哈哈', 10, 200 + i)); await sleep(15); }
    await settle(r); assert.ok(r.prompts.length >= 1); assert.equal(r.calls.length, 0);
  });
  await test('recalled fragments are removed before prompt and expired WAIT never revives an old request', async () => {
    const r = make(); await post(r, direct('1', '请求')); await post(r, message('2', '撤回内容'));
    r.registry.entry('group:10').recalledIds.push('2'); await settle(r);
    assert.ok(!r.prompts[0].content[0].text.includes('撤回内容'));
    r.state.inputBatches.hold('group:10', [direct('old', '旧请求')]); r.state.inputBatches.entry('group:10').waitUntil = Date.now() - 1;
    await post(r, direct('new', '新请求')); await settle(r);
    assert.ok(!r.prompts[1].content[0].text.includes('旧请求'));
  });
} finally {
  for (const r of rigs) { r.state.inputBatches?.dispose(); r.sendQueue.dispose(); }
  globalThis.fetch = originalFetch;
  for (const s of stores) { try { s.db.close(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
