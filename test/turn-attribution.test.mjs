/**
 * 「回复被吞」的回归测试 —— DSH 里有文本、QQ 里没有。
 *
 * 根因是**归因**：桥接用 `mode: 'steer'` 提交提示词，steer 会把输入喂给
 * **正在跑的那个 turn**。如果别的路径先把 turn 跑起来了，我这次提交会被并进去，
 * **不会产生属于我的 turn/end**。旧实现"看到第一个 turn/end 就收工"，于是：
 *   · 把别人那段回复当成自己的发出去；
 *   · 或者永远等不到，整段文本读不到 —— 一个字都发不出去。
 *
 *   node test/turn-attribution.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('../lib/index.js');
const { runTurn, isSayTool, textOfAssistantEvent } = await import('../lib/agent/runner.mjs');
const { ConversationRegistry } = bridge.__test;

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
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
  }
}

/** 假的 sessionController：把给定的帧原样回放。 */
function fakeSession(frames) {
  return {
    prompts: [],
    async create() {
      return { sessionId: 's1' };
    },
    follow() {
      return {
        async *[Symbol.asyncIterator]() {
          for (const f of frames) yield f;
        },
      };
    },
    async prompt(req) {
      this.prompts.push(req);
    },
  };
}

const snapshot = (cursor) => ({ type: 'snapshot', cursor });
const turnStart = (seq, turn) => ({ type: 'event', event: { seq, type: 'turn/start', data: { turn } } });
const turnEnd = (seq, turn, kind = 'completed') => ({
  type: 'event',
  event: { seq, type: 'turn/end', data: { turn, reason: { kind } } },
});
const assistant = (seq, turn, text) => ({
  type: 'event',
  event: {
    seq,
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  },
});
const toolCall = (seq, turn, name, args) => ({
  type: 'event',
  event: { seq, type: 'tool/call', data: { turn, step: 1, callId: 'c1', name, arguments: args } },
});
const toolResult = (seq, turn, { isError = false } = {}) => ({
  type: 'event',
  event: {
    seq,
    type: 'tool/result',
    data: { turn, step: 1, callId: 'c1', message: { role: 'tool', isError, content: [] } },
  },
});

function config(over = {}) {
  return bridge.Config({
    replyTimeoutMs: 3000,
    bubbleDelayPerCharMs: 0,
    bubbleDelayMinMs: 0,
    autoEscape: false,
    ...over,
  });
}

function rigWith(frames) {
  const ctx = { logger: { info() {}, warn() {}, error() {} }, get: () => undefined };
  ctx.sessionController = fakeSession(frames);
  const cfg = config();
  const registry = new ConversationRegistry(ctx, cfg, null);
  return { ctx, cfg, registry, stats: {} };
}

console.log('\nturn 归因：只认属于我的那个 turn/end');

await test('我的 turn 结束后还有别人一轮 → 只取我的回复，不把别人的发出去', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 1),
    assistant(2, 1, '我回的第一句'),
    turnEnd(3, 1, 'completed'),
    // 后面还有一整轮（心跳/戳/并发提交），绝不能被当成我的
    turnStart(4, 2),
    assistant(5, 2, '这是别人的回复'),
    turnEnd(6, 2, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '我回的第一句', '不能把下一个 turn 的文本当自己的回复');
  assert.equal(out.endReason, 'completed');
});

/**
 * 关于归因的取舍（为什么按 turn 号严筛，而不是"取最后一个说话的人"）：
 *
 * 同一条会话的回合是**串行**的（消息/戳/心跳都走 registry.run(key) 那条链），
 * 所以正常时序是「提交 → 出现我的 turn/start → 我的文本 → 我的 turn/end」。
 * 但并发路径（心跳/戳）仍可能在这个窗口里插进别的 turn 事件。
 *
 * 代价不对称：
 *   · 多发一句**别人的话** = 群里看到一句莫名其妙、还可能冒犯人的话；
 *   · 少发一句 = 这一轮没声（而且 `qq_say` 那条路照样通）。
 * 所以宁可少发：**只认自己 turn 号里的文本**。
 */

await test('别人的 turn 的文本不许冒充我的回复', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 6),
    // 另一个 turn 的文本（编号对不上我）先到 —— 必须丢掉
    assistant(2, 7, '别人的话'),
    assistant(3, 6, '我的话'),
    turnEnd(4, 6, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '我的话', '把别的 turn 的文本当成自己的回复 = 往群里发错话');
});

await test('我的 turn 结束之后，别人的一整轮都不许被吃进来', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 6),
    assistant(2, 6, '我的话'),
    turnEnd(3, 6, 'completed'),
    // 我之后别人的一整轮
    turnStart(4, 7),
    assistant(5, 7, '后面那轮的话'),
    turnEnd(6, 7, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '我的话');
});

await test('还没认领到自己的 turn 时，别人先吐的文本一个字都不收', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    // 关键顺序：文本在**我的 turn/start 之前**到达（并发路径先跑）
    assistant(1, 9, '这个 turn 是谁的都不知道'),
    turnStart(2, 9),
    assistant(3, 9, '认领之后这句才收'),
    turnEnd(4, 9, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '认领之后这句才收', '认领前收到的文本必须丢掉，否则会发出不该发的话');
});

await test('被 steer 进别人正在跑的 turn（带 turn 号）→ 一个字都不取，如实标注', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    // 没有属于我的 turn/start：我的输入被并进了正在跑的 turn 3
    assistant(1, 3, '那段回复是那个 turn 的，不是我的'),
    turnEnd(2, 3, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '', '不确认归属就不许当成自己的回复发出去');
  assert.equal(out.steeredIntoRunningTurn, true);
  assert.ok(
    String(out.endReason).includes('steered into running turn'),
    `应如实标注，实际 ${out.endReason}`,
  );
  assert.equal(stats.steeredIntoRunningTurn, 1);
});

console.log('\nturn 归因：上游把回合挡在起跑线上时的读数');

await test('reason=blocked 会被单独计数（和"模型没吐字"分开）', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 1),
    // 上游拒了整个回合：没有 step、没有 assistant
    turnEnd(2, 1, 'blocked'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.endReason, 'blocked');
  assert.equal(out.reply, '');
  assert.equal(stats.blockedTurns, 1, 'blocked 必须有独立计数，不能混进 noTextTurns');
});

await test('老事件形状（不带 turn 号）→ 退回老语义并把文本捞出来，不死等', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    assistant(1, undefined, '并进别人 turn 的回复'),
    turnEnd(2, undefined, 'completed'),
  ]);
  const start = Date.now();
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.reply, '并进别人 turn 的回复', '读不到 turn 号时也得把文本捞出来，不能白丢一轮');
  assert.ok(
    String(out.endReason).includes('no turn/start seen'),
    `应如实标注退化了，实际 ${out.endReason}`,
  );
  assert.equal(out.steeredIntoRunningTurn, false);
  assert.ok(Date.now() - start < 2500, '不该等到 replyTimeoutMs 才返回');
});

console.log('\nturn 归因：认出「这轮用发言工具说了话」');

await test('qq_say 成功 → spokeByTool 为真，并带出说了什么', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 1),
    toolCall(2, 1, 'mcp__qq__qq_say', '{"conversation":"group:1","text":"等下我去看看"}'),
    toolResult(3, 1, { isError: false }),
    assistant(4, 1, ''),
    turnEnd(5, 1, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.spokeByTool, true);
  assert.deepEqual(out.spokeTexts, ['等下我去看看'], '要能把工具实际发出去的内容带出来');
});

await test('工具报错 → 不能算说过话（否则那一轮彻底没声）', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0),
    turnStart(1, 1),
    toolCall(2, 1, 'mcp__qq__qq_say', '{"conversation":"group:9","text":"发错群"}'),
    toolResult(3, 1, { isError: true }),
    assistant(4, 1, '那我正常回一句'),
    turnEnd(5, 1, 'completed'),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats, {});
  assert.equal(out.spokeByTool, false, '工具失败必须退回文本投递');
  assert.equal(out.reply, '那我正常回一句');
  assert.equal(stats.sayToolFailed, 1);
});

await test('工具名匹配容得下各种前缀写法', () => {
  assert.equal(isSayTool('qq_say'), true);
  assert.equal(isSayTool('mcp__qq__qq_say'), true);
  assert.equal(isSayTool('mcp__qq__qq_say_anything'), false);
  assert.equal(isSayTool('qq_send_group_msg'), false);
  assert.equal(isSayTool(undefined), false);
});

await test('助手文本抽取只看 text 段，忽略 reasoning', () => {
  assert.equal(
    textOfAssistantEvent({
      message: {
        content: [
          { type: 'reasoning', text: '我不该被当成回复' },
          { type: 'text', text: '真正的回复' },
        ],
      },
    }),
    '真正的回复',
  );
});

console.log('\nqq_say: 提示词必须告诉它"当前会话"');

await test('提示词里写明了当前会话，且教了 qq_say 怎么用', async () => {
  const { buildPrompt } = bridge.__test;
  const cfg = config({ persona: 'P', behavior: '', examples: '' });
  const prompt = buildPrompt(
    {
      post_type: 'message',
      message_type: 'group',
      self_id: 3667925015,
      user_id: 1056612947,
      group_id: 100000001,
      message_id: 7,
      message: [{ type: 'text', data: { text: 'deepseek 在吗' } }],
      sender: { nickname: '天梦·幻' },
    },
    cfg,
    { includeStatic: true, includeWindow: false, shape: null },
  );
  const text = Array.isArray(prompt) ? prompt.map((p) => p.text ?? '').join('') : String(prompt);
  assert.match(text, /【当前会话】group:100000001/, '不写这一行，qq_say 的 conversation 就只能靠猜');
  assert.match(text, /qq_say/, '得告诉它有这个工具');
  assert.match(text, /最终回复交付新的结果/, '即时进度之后保留新的最终结果');
});

await test('queued prompt waits past an existing turn and an earlier queued prompt', async () => {
  const { ctx, cfg, registry, stats } = rigWith([]);
  ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
    yield snapshot(0);
    const request = ctx.sessionController.prompts[0];
    assert.equal(request.mode, 'queue');
    const own = { source: { kind: 'user', rpcId: request.requestId } };
    const splice = (seq, start, removedCount, inserted) => ({ type: 'event', event: {
      seq, type: 'agent/inbox/spliced', data: { target: 'next-turn', start, removedCount, inserted },
    } });
    yield splice(1, 1, 0, [own]);
    yield assistant(2, 7, '正在运行的旧回合');
    yield turnEnd(3, 7);
    yield turnStart(4, 8);
    yield splice(5, 0, 1, []);
    yield assistant(6, 8, '排在前面的另一条输入');
    yield turnEnd(7, 8);
    yield turnStart(8, 9);
    yield splice(9, 0, 1, []);
    yield assistant(10, 9, '我的最终结果');
    yield turnEnd(11, 9);
  } });
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats);
  assert.equal(out.reply, '我的最终结果');
  assert.equal(stats.lastTurn.myTurn, 9);
  assert.equal(stats.lastTurn.sawOtherTurnEnd, 2);
  // 首字延迟与总时长必须落盘：用来区分"等首字"和"写得慢"（供应商 vs 提示词）。
  assert.equal(typeof stats.lastTurn.ttftMs, 'number');
  assert.ok(stats.lastTurn.totalMs >= stats.lastTurn.ttftMs);
  assert.equal(stats.lastLatency.ttftMs, stats.lastTurn.ttftMs);
});

await test('queued prompt blocked before user/message still reports its own blocked turn', async () => {
  const { ctx, cfg, registry, stats } = rigWith([]);
  ctx.sessionController.follow = () => ({ async *[Symbol.asyncIterator]() {
    yield snapshot(0);
    const own = { source: { rpcId: ctx.sessionController.prompts[0].requestId } };
    const splice = (seq, removedCount, inserted) => ({ type: 'event', event: {
      seq, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount, inserted },
    } });
    yield splice(1, 0, [own]);
    yield turnStart(2, 1);
    yield splice(3, 1, []);
    yield turnEnd(4, 1, 'blocked');
  } });
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats);
  assert.equal(out.endReason, 'blocked');
  assert.equal(stats.blockedTurns, 1);
});

await test('a different turn using qq_say cannot suppress my final reply', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1),
    toolCall(2, 8, 'qq_say', '{"conversation":"group:1","text":"别人的进度"}'),
    toolResult(3, 8), assistant(4, 1, '我的最终回复'), turnEnd(5, 1),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats);
  assert.equal(out.spokeByTool, false);
  assert.equal(out.reply, '我的最终回复');
});

await test('failed, unknown, dry-run and replay tool results never refresh the wake window', async () => {
  for (const [text, error, delivered] of [
    ['[dry-run] 未执行', false, false],
    ['发送结果未知（状态=UNKNOWN）', false, false],
    ['发送失败', true, false],
    ['幂等重放，状态=SUCCEEDED', false, true],
    ['已发送到群 1。message_id=1', false, true],
  ]) {
    const result = toolResult(3, 1, { isError: error });
    result.event.data.message.content = [{ type: 'text', text }];
    const { ctx, cfg, registry, stats } = rigWith([
      snapshot(0), turnStart(1, 1),
      toolCall(2, 1, 'qq_say', '{"conversation":"group:1","text":"进度"}'),
      result, assistant(4, 1, ''), turnEnd(5, 1),
    ]);
    let wakes = 0;
    const out = await runTurn(ctx, cfg, registry, 'group:1', [{ type: 'text', text: 'x' }], stats,
      { onSpoke: () => wakes++ });
    assert.equal(out.spokeByTool, delivered);
    assert.equal(wakes, text.startsWith('已发送到') ? 1 : 0);
  }
});

await test('真实 DSH 格式：工具前正文不补发，嵌套 callId 回执归属正确，最终多段完整保留', async () => {
  const start = assistant(2, 1, '先声明一下，我做个简化版\n\n给我一会儿');
  start.event.data.message.content.push({ type: 'tool-call', id: 'c1', name: 'qq_say' });
  const sent = toolResult(4, 1);
  delete sent.event.data.callId;
  sent.event.time = 123456;
  sent.event.data.message.source = { kind: 'tool', callId: 'c1' };
  sent.event.data.message.toolCallId = 'c1';
  sent.event.data.message.content = [{ type: 'text', text: '已发送到群 1。message_id=-123' }];
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1), start,
    toolCall(3, 1, 'qq_say', { conversation: 'group:1', text: '游戏王啊，我去写' }), sent,
    toolCall(5, 1, 'qq_workspace', { action: 'write' }), toolResult(6, 1),
    toolCall(7, 1, 'qq_send_file', { conversation: 'group:1', path: 'game.html' }), toolResult(8, 1),
    assistant(9, 1, '文件发了\n\n双击打开'), assistant(10, 1, '规则简化过\n\n[表情:1]'), turnEnd(11, 1),
  ]);
  const receipts = [];
  let wakes = 0;
  const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats, {
    onSpeechResult: (speech, receipt) => receipts.push({ speech, receipt }), onSpoke: () => wakes++,
  });
  assert.equal(out.reply, '文件发了\n\n双击打开\n\n规则简化过\n\n[表情:1]');
  assert.equal(out.spokeByTool, true);
  assert.deepEqual(out.spokeTexts, ['游戏王啊，我去写', '[文件 game.html]']);
  assert.equal(receipts[0].receipt.state, 'SUCCEEDED');
  assert.equal(receipts[0].receipt.onebotId, '-123');
  assert.equal(receipts[0].receipt.sentAt, 123456);
  assert.equal(wakes, 2);
  assert.equal(stats.lastTurn.sayOk, 1);
  assert.equal(out.intermediateTextParts, 1);
  assert.equal(out.replySelection, 'post-tool-final');
});

await test('分开发来的工具边界也清掉过程正文，失败后的最终解释保留', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1), assistant(2, 1, '我查查'),
    toolCall(3, 1, 'web_search', {}), toolResult(4, 1, { isError: true }),
    assistant(5, 1, '查询失败\n\n现有信息不足，无法核实'), turnEnd(6, 1),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats);
  assert.equal(out.reply, '查询失败\n\n现有信息不足，无法核实');
  assert.equal(out.intermediateTextParts, 1);
});

await test('工具后又继续工具步骤，只投递最后一段完整结果', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1), toolCall(2, 1, 'web_search', {}), toolResult(3, 1),
    assistant(4, 1, '找到一条，还要核实'), toolCall(5, 1, 'web_fetch', {}), toolResult(6, 1),
    assistant(7, 1, '已核实\n\n来源与限制'), turnEnd(8, 1),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats);
  assert.equal(out.reply, '已核实\n\n来源与限制');
  assert.equal(out.intermediateTextParts, 1);
});

await test('只有工具前正文而没有最终正文时，不把旧开工话当结果补发', async () => {
  for (const isError of [false, true]) {
    const { ctx, cfg, registry, stats } = rigWith([
      snapshot(0), turnStart(1, 1), assistant(2, 1, '等我一下'),
      toolCall(3, 1, 'qq_say', '{"conversation":"group:1","text":"我去查"}'),
      toolResult(4, 1, { isError }), turnEnd(5, 1, isError ? 'error' : 'completed'),
    ]);
    const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats);
    assert.equal(out.reply, '');
    assert.equal(out.spokeByTool, !isError);
  }
});

await test('没有单独 tool/call 事件时，assistant 内的工具块仍区分过程与结果', async () => {
  const start = assistant(2, 1, '我来做');
  start.event.data.message.content.push({ type: 'tool-call', id: 'x', name: 'web_search' });
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1), start, assistant(3, 1, '最终结果'), turnEnd(4, 1),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats);
  assert.equal(out.reply, '最终结果');
  assert.equal(out.intermediateTextParts, 1);
});

await test('别的回合工具不能清掉我的结果，也不能借相同 callId 认领成功发言', async () => {
  const { ctx, cfg, registry, stats } = rigWith([
    snapshot(0), turnStart(1, 1),
    toolCall(2, 1, 'qq_say', '{"conversation":"group:1","text":"我去查"}'),
    toolResult(3, 8), toolResult(4, 1, { isError: true }), assistant(5, 1, '我的结果'),
    toolCall(6, 8, 'web_search', {}), assistant(7, 8, '别人的文本'), turnEnd(8, 1),
  ]);
  const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats);
  assert.equal(out.reply, '我的结果');
  assert.equal(out.spokeByTool, false);
});

await test('两种嵌套 callId 均可用；结构化失败/未知/dry-run/重放回执不续醒', async () => {
  for (const shape of ['toolCallId', 'source']) for (const status of ['FAILED', 'UNKNOWN', 'EXECUTING', 'dry-run', 'replayed', 'SUCCEEDED']) {
    const result = toolResult(3, 1);
    delete result.event.data.callId;
    if (shape === 'source') result.event.data.message.source = { callId: 'c1' };
    else result.event.data.message.toolCallId = 'c1';
    result.event.data.message.structuredContent = { receipt: {
      id: 'receipt1', status: ['dry-run', 'replayed'].includes(status) ? 'SUCCEEDED' : status,
      dryRun: status === 'dry-run', replayed: status === 'replayed', sentAt: 1234,
    } };
    const { ctx, cfg, registry, stats } = rigWith([
      snapshot(0), turnStart(1, 1),
      toolCall(2, 1, 'qq_say', { conversation: 'group:1', text: '开始查' }), result,
      assistant(4, 1, '新的最终结果'), turnEnd(5, 1),
    ]);
    let wakes = 0;
    const out = await runTurn(ctx, cfg, registry, 'group:1', [], stats, { onSpoke: () => wakes++ });
    assert.equal(out.reply, '新的最终结果');
    assert.equal(out.spokeByTool, ['replayed', 'SUCCEEDED'].includes(status));
    assert.equal(wakes, status === 'SUCCEEDED' ? 1 : 0);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
