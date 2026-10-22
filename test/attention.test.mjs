import assert from 'node:assert/strict';
import { rig, message } from './helpers/bridge.mjs';
import { buildPrompt } from '../lib/prompt/render.mjs';
import { Config } from '../lib/index.js';

let passed = 0;
const originalFetch = globalThis.fetch;
const rigs = [];
function make(verdict, overrides = {}) {
  const inputs = [];
  const llm = { async *stream(input) {
    inputs.push(input);
    yield { type: 'text-delta', text: JSON.stringify(verdict) };
  } };
  const r = rig({ groupAttentionEnabled: true, selfIds: ['100'], ...overrides }, '新的结果', null, llm);
  r.registry.entry('group:10').awakeUntil = Date.now() + 60000;
  rigs.push(r);
  return { ...r, inputs };
}
async function test(label, fn) { await fn(); passed++; console.log('  ✓ ' + label); }
try {
  await test('default enables semantic attention', () => {
    assert.equal(Config({}).groupAttentionEnabled, true);
  });
  await test('the full agent can choose silence without a classifier or awake refresh', async () => {
    const r = rig({ groupAttentionEnabled: true, selfIds: ['100'] }, '[SKIP]');
    rigs.push(r);
    r.registry.entry('group:10').awakeUntil = Date.now() + 60000;
    const entry = r.registry.entry('group:10'), until = entry.awakeUntil;
    await r.post(message(1, '我们为什么要打这把比赛'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.calls.length, 0);
    assert.equal(entry.awakeUntil, until);
    assert.equal(entry.pending.length, 0);
    assert.equal(entry.window.at(-1).text, '我们为什么要打这把比赛');
    assert.ok(entry.sessionId);
    assert.equal(r.stats.lastAttentionDecision.phase, 'agent-silent');
  });
  await test('参与决策说"不必回"时不建 Session、不提交 prompt', async () => {
    const r = make({ reply: false, reason: '纯附和' }, { replyDecisionEnabled: true });
    await r.post(message(1, '牛逼'));
    assert.equal(r.prompts.length, 0, '决定沉默就不该起回合');
    assert.ok(r.inputs.length >= 1, '应该问过一次参与决策');
    assert.equal(r.stats.replyDecisionSilent, 1);
    assert.equal(r.stats.attentionDeclined, 1);
  });
  await test('参与决策说"该回"时照常起回合', async () => {
    const r = make({ reply: true, reason: '在问她' }, { replyDecisionEnabled: true });
    await r.post(message(1, '你觉得这把谁赢'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.stats.replyDecisionSilent ?? 0, 0);
  });
  await test('参与决策失败时 fail-open：当作该回，绝不吞消息', async () => {
    const r = make('不是 JSON', { replyDecisionEnabled: true });
    await r.post(message(1, '你觉得这把谁赢'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.stats.replyDecisionFailed, 1);
  });
  await test('请求型措辞直接回，不问参与决策（防"装死"的硬护栏）', async () => {
    const r = make({ reply: false, reason: '看起来像闲聊' }, { replyDecisionEnabled: true });
    await r.post(message(1, '帮我查一下明天的天气'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0, '请求型不该走决策模型调用');
    assert.equal(r.stats.replyDecisionRequestShaped, 1);
  });
  await test('被 @ 不再"必回"：决策说沉默就沉默', async () => {
    const r = make({ reply: false, reason: '只是喊了她一下' }, { replyDecisionEnabled: true });
    const e = message(1, '在吗');
    e.message.unshift({ type: 'at', data: { qq: '100' } });
    await r.post(e);
    assert.equal(r.prompts.length, 0, '被 @ 也要过一次决策（这是"每条都回"的主要来源）');
    assert.equal(r.stats.replyDecisionSilent, 1);
  });
  await test('关掉 replyDecisionEnabled 时 @ 仍然必回（既有行为不变）', async () => {
    const r = make({ reply: false, reason: '不该被问到' });
    const e = message(1, '在吗');
    e.message.unshift({ type: 'at', data: { qq: '100' } });
    await r.post(e);
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0, '关着时不做参与决策调用');
  });
  await test('被 @ 的短问句直接回（方案 A）：不再被决策模型判成沉默', async () => {
    for (const text of ['猜猜这个是什么', '9月11日忆什么', '9.11 和 9.9 哪个大', '你们谁更厉害']) {
      const r = make({ reply: false, reason: '看起来像闲聊' }, { replyDecisionEnabled: true });
      const e = message(1, text);
      e.message.unshift({ type: 'at', data: { qq: '100' } });
      await r.post(e);
      assert.equal(r.prompts.length, 1, `被点名提问应起回合：${text}`);
      assert.equal(r.inputs.length, 0, `不该再问决策模型：${text}`);
      assert.equal(r.stats.replyDecisionExplicitAsk, 1, `应计入 explicitAsk：${text}`);
      assert.equal(r.stats.replyDecisionSilent ?? 0, 0);
    }
  });
  await test('纯打招呼/纯标点不触发方案 A：仍交给决策模型', async () => {
    for (const text of ['在吗', '在不在？', '？']) {
      const r = make({ reply: false, reason: '只是喊了她一下' }, { replyDecisionEnabled: true });
      const e = message(1, text);
      e.message.unshift({ type: 'at', data: { qq: '100' } });
      await r.post(e);
      assert.equal(r.prompts.length, 0, `仍应允许沉默：${text}`);
      assert.ok(r.inputs.length >= 1, `应问过决策模型：${text}`);
      assert.equal(r.stats.replyDecisionExplicitAsk ?? 0, 0);
    }
  });
  await test('没被点名（清醒期旁听）的短问句不做方案 A 短路', async () => {
    const r = make({ reply: false, reason: '别人在聊' }, { replyDecisionEnabled: true });
    await r.post(message(1, '这是什么'));
    assert.equal(r.prompts.length, 0);
    assert.ok(r.inputs.length >= 1, '旁听消息仍走决策模型');
    assert.equal(r.stats.replyDecisionExplicitAsk ?? 0, 0);
  });
  await test('参与决策能看到「回复谁 / 艾特谁」，不再只有文字', async () => {
    const { decideReply } = await import('../lib/application/reply-decision.mjs');
    const calls = [];
    const llm = { async *stream(input) { calls.push(input);
      yield { type: 'text-delta', text: '{"reply":false,"reason":"在回别人"}' }; } };
    const r = rig({ replyDecisionEnabled: true, selfIds: ['100'] }, 'x', null, llm);
    rigs.push(r);
    const e = message(1, '对的', 10, 300);
    e.message.unshift({ type: 'at', data: { qq: '200' } });
    e.message.push({ type: 'reply', data: { id: 'm-9' } });
    await decideReply(r.ctx, r.config, r.registry.entry('group:10'), [e], { explicit: false });
    const payload = JSON.parse(calls[0].messages[0].content[0].text);
    const item = payload['本轮要判断的消息'][0];
    assert.deepEqual(item['艾特'], ['200'], '要把 @ 对象标成昵称/QQ，方便判断不是叫她');
    assert.equal(item['回复消息'], 'm-9');
  });
  await test('没点名的群消息在提示词里标明"不是叫你"', () => {
    const r = make({ reply: true }, { replyDecisionEnabled: true });
    const plain = buildPrompt(message(1, '今天吃啥'), r.config, { includeStatic: false });
    assert.match(plain, /本条没有点名你/);
    const e = message(2, '今天吃啥');
    e.message.unshift({ type: 'at', data: { qq: '100' } });
    assert.match(buildPrompt(e, r.config, { includeStatic: false }), /对方 @ 了你/);
  });
  await test('长问句直接回，不问参与决策（削掉那 2.5 秒）', async () => {
    const r = make({ reply: false, reason: '不该被问到' }, { replyDecisionEnabled: true });
    await r.post(message(1, '你觉得这场比赛的胜负关键到底在哪里呢'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0, '长问句不该走决策模型调用');
    assert.equal(r.stats.replyDecisionLongAsk, 1);
  });
  await test('请求型护栏覆盖线上实测漏掉的那几种说法', async () => {
    const { REQUEST_SHAPED } = await import('../lib/application/reply-decision.mjs');
    for (const s of ['写一份docs文档，内容是荒漠迷城的战术纸', '把那个网页打枪的文件发我',
      '做完通知一下1056612947', '把fx＝x的五次方表成x-1的方幂和，给出详细过程',
      '想一个既定战术', '帮我查一下明天的天气'])
      assert.ok(REQUEST_SHAPED.test(s), '护栏应覆盖：' + s);
    for (const s of ['牛逼', '我去', '34', '我坐好了', '废鱼'])
      assert.ok(!REQUEST_SHAPED.test(s), '这些不该被护栏直接放行（否则参与决策形同虚设）：' + s);
  });
  await test('被判沉默的消息不能丢：进窗口（下一轮看得见）并进心跳缓冲（可能被补上）', async () => {
    const r = make({ reply: false, reason: '纯附和' }, { replyDecisionEnabled: true, heartbeatEnabled: true });
    const entry = r.registry.entry('group:10');
    const before = entry.window.length, awakeBefore = entry.awakeUntil;
    await r.post(message(1, '牛逼'));
    assert.equal(r.prompts.length, 0, '决定沉默');
    // 这是这个功能最重要的安全性质：静默不等于丢弃。
    assert.ok(entry.window.length > before, '要记进窗口，否则下一轮它根本不知道有人说过话');
    assert.equal(entry.window.at(-1).text, '牛逼');
    assert.ok(entry.pending.some((m) => String(m.text).includes('牛逼')), '要进心跳缓冲，否则这条永远没人再看到');
    assert.equal(entry.awakeUntil, awakeBefore, '纯沉默不该刷新清醒窗口（它没说话）');
  });
  await test('a real unmentioned followup can respond during interjection cooldown', async () => {
    const r = make({ speak: true, kind: 'followup', why: '回答她刚才的问题' });
    const entry = r.registry.entry('group:10');
    entry.lastSpokeAt = Date.now();
    r.registry.record(entry, { bot: true, text: '你想玩什么？', messageId: 'old' });
    await r.post(message(2, '我想玩原神'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0);
    assert.match(JSON.stringify(r.prompts[0].content), /你想玩什么/);
    assert.ok(r.calls.some((c) => c.action === 'send_group_msg'));
  });
  await test('a message explicitly addressed to another member never runs the LLM', async () => {
    const r = make({ speak: true, kind: 'followup' });
    const event = message(3, '玩原神带萌新去了');
    event.message.unshift({ type: 'at', data: { qq: '300' } });
    await r.post(event);
    assert.equal(r.inputs.length, 0);
    assert.equal(r.prompts.length, 0);
  });
  await test('quoting another member declines; quoting herself directly enters a normal turn', async () => {
    const r = make({ speak: true, kind: 'followup' });
    const entry = r.registry.entry('group:10');
    r.registry.record(entry, { qq: '300', text: '来五排', messageId: 'other' });
    const e = message(4, '我不来');
    e.message.unshift({ type: 'reply', data: { id: 'other' } });
    await r.post(e);
    assert.equal(r.inputs.length, 0);
    assert.equal(r.prompts.length, 0);
    r.registry.record(entry, { bot: true, text: '你来吗', messageId: 'own' });
    e.message_id = 5;
    e.message[0].data.id = 'own';
    await r.post(e);
    assert.equal(r.inputs.length, 0);
    assert.equal(r.prompts.length, 1);
  });
  await test('direct name address bypasses an overly conservative judge', async () => {
    const r = make({ speak: false }, { nameTriggers: ['小鲸鱼'] });
    await r.post(message(20, '@小鲸鱼 把我哄乐了'));
    assert.equal(r.inputs.length, 0);
    assert.equal(r.prompts.length, 1);
  });
  await test('self-directed criticism reaches the agent even when speak is false', async () => {
    const r = make({ recipient: 'self', speak: false, why: '对她说没礼貌' });
    const entry = r.registry.entry('group:10');
    r.registry.record(entry, { bot: true, text: '我就说了句你俩一样菜', messageId: 'previous' });
    r.registry.record(entry, { qq: '200', text: '我必须得好好调教调教你了，这么没礼貌', messageId: '21' });
    entry.lastSpokeAt = Date.now();
    await r.post(message(21, '我必须得好好调教调教你了，这么没礼貌', 10, 400));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.stats.lastAttentionDecision.kind, 'consider');
    assert.equal(r.inputs.length, 0);
    const prompt = r.prompts[0].content[0].text;
    assert.match(prompt, /我就说了句你俩一样菜/);
    assert.ok(!prompt.includes('[消息 21]'));
  });
  await test('a stateless false recipient verdict cannot veto a short direct followup', async () => {
    const r = make({ recipient: 'other', speak: false });
    const entry = r.registry.entry('group:10');
    r.registry.record(entry, { bot: true, text: '这个点还接龙，你明天不上课吗', messageId: 'before' });
    await r.post(message(22, '来嘛，明天周日'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0);
    assert.match(r.prompts[0].content[0].text, /你明天不上课吗/);
    assert.match(r.prompts[0].content[0].text, /来嘛，明天周日/);
  });
  await test('explicit @ and private messages bypass attention', async () => {
    const r = make({ speak: false });
    const e = message(6, '你在吗');
    e.message.unshift({ type: 'at', data: { qq: '100' } });
    await r.post(e);
    await r.post({ ...message(7, '你好'), message_type: 'private' });
    assert.equal(r.inputs.length, 0);
    assert.equal(r.prompts.length, 2);
  });
  await test('interjection pacing is supplied to the agent without vetoing normal dialogue', async () => {
    const r = make({ speak: true, kind: 'interject', why: '有个新梗' });
    r.registry.entry('group:10').lastSpokeAt = Date.now();
    await r.post(message(8, '开放话题'));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0);
    assert.match(r.prompts[0].content[0].text, /刚发过言可继续来回；新话题先给别人留空隙/);
  });
  await test('interjection can pass after cooldown', async () => {
    const r = make({ speak: true, kind: 'interject' });
    await r.post(message(9, '开放话题'));
    assert.equal(r.prompts.length, 1);
  });
  await test('an unavailable separate judge cannot drop normal dialogue', async () => {
    const r = make({ speak: true });
    await r.post(message(10));
    assert.equal(r.prompts.length, 1);
    assert.equal(r.inputs.length, 0);
    r.ctx.get = () => null;
    await r.post(message(11));
    assert.equal(r.prompts.length, 2);
    assert.equal(r.registry.entry('group:10').pending.length, 0);
  });
  await test('disable during agent submission cancels delivery', async () => {
    const r = make({ speak: true, kind: 'followup' });
    r.ctx.sessionController.prompt = async () => {
      r.state.persistEnabled(false);
    };
    await r.post(message(12));
    assert.equal(r.prompts.length, 0);
    assert.equal(r.registry.entry('group:10').pending.length, 0);
    assert.equal(r.calls.length, 0);
  });
  await test('dynamic timing instructions survive static prompt injection', () => {
    const config = Config({ selfIds: ['100'] });
    const first = buildPrompt(message(13), config,
      { awake: true, includeStatic: true, attention: { kind: 'consider' } });
    assert.match(first, /甲乙正在互相回答 → \[SKIP\]/);
    const prompt = buildPrompt(message(13), config,
      { awake: true, includeStatic: false, attention: { kind: 'consider' } });
    assert.match(prompt, /结合 @、引用和来回辨认对象/);
    assert.match(prompt, /由你一次判断并回应/);
  });
  console.log(`全部通过：${passed} 项`);
} finally {
  for (const r of rigs) { r.state.controller.abort(); r.sendQueue.dispose(); }
  globalThis.fetch = originalFetch;
}
