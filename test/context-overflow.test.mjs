/**
 * 上下文超窗的恢复路径。
 *
 * 线上事故（2026-10-24）：a6api 在转发前做上下文预检，判定 41.1 万 token 超过
 * deepseek-v4.1-flash-1017 的 26.2 万窗口，且"图片独占 37.2 万，压缩删不掉"，
 * 于是直接拒收（`retryable: false`，payload 未转发）。旧实现只把它写进 lastError，
 * 下一条消息仍用同一个 Session，于是一直哑火，直到常规轮换才恢复。
 *
 * 这里钉的是**行为**：撞上超窗 → 丢掉会话 → 同一条消息重新投一次 → 且只投一次。
 *
 *   node test/context-overflow.test.mjs
 */
import assert from 'node:assert/strict';
import { isContextOverflow } from '../lib/agent/context-overflow.mjs';
import { rig, message } from './helpers/bridge.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

const overflowError = {
  code: 'server_error',
  message: 'a6api API error (413): {"type":"server_error","code":"preflight_compress_failed",' +
    '"message":"context ~411065.95 tokens exceeds the model window 262144 ' +
    '(model=deepseek-v4.1-flash-1017), with 7 compressible range(s) still visible and ' +
    'preflight compression could not bring it under: futile round ... Images alone account ' +
    'for ~372547.2 tokens (≥ window 262144)"}',
};

/** 第一个会话永远回超窗，后面的会话正常回一句话。 */
function overflowRig(reply = '你好') {
  const r = rig({ groupTrigger: 'all' });
  r.ctx.sessionController.follow = (address) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      if (address.address.sessionId === 's1') {
        yield { type: 'event',
          event: { seq: 1, type: 'turn/end', data: { reason: { kind: 'error', error: overflowError } } } };
        return;
      }
      yield { type: 'event', seq: 1,
        event: { seq: 1, type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: reply }] } } } };
      yield { type: 'event', event: { seq: 2, type: 'turn/end', data: { reason: { kind: 'stop' } } } };
    },
  });
  return r;
}

await test('识别超窗形状，不误伤普通失败', () => {
  assert.equal(isContextOverflow(overflowError), true);
  // 适配器把它当异常抛出时只有 message，也要认得。
  assert.equal(isContextOverflow(new Error(overflowError.message)), true);
  assert.equal(isContextOverflow({ code: 'context_length_exceeded', message: 'nope' }), true);
  assert.equal(isContextOverflow({ message: 'prompt is too long' }), true);
  // 以下都不是超窗：网络抖动、限流、入站 body 过大（413 但语义完全不同）。
  assert.equal(isContextOverflow(new Error('network timeout')), false);
  assert.equal(isContextOverflow({ code: 429, message: 'rate limit reached for tokens per min' }), false);
  assert.equal(isContextOverflow({ status: 413, message: 'body too large' }), false);
  assert.equal(isContextOverflow(null), false);
});

await test('回合以 reason=error 报超窗：丢会话、原消息重投一次、回复照常送达', async () => {
  const r = overflowRig('重投之后才发出的回复');
  await r.post(message(1, '你好'));
  assert.equal(r.prompts.length, 2, '应当把同一条消息投两次（旧会话一次、新会话一次）');
  assert.equal(r.registry.entry('group:10').sessionId, 's2', '旧会话必须被丢掉');
  assert.equal(r.stats.contextOverflowRecoveries, 1);
  // 第二投真的带着这条消息，而不是空提交。
  assert.ok(r.prompts[1].content.some((p) => p.type === 'text' && p.text.includes('你好')));
  // 回复按正常路径投递，不是被当成"被吞的回合"。
  assert.equal(r.stats.lastError, undefined);
});

await test('prompt 直接抛超窗（尚未提交）走同一条路，且不会无限重投', async () => {
  const r = rig({ groupTrigger: 'all' });
  let attempts = 0;
  const prompt = r.ctx.sessionController.prompt;
  r.ctx.sessionController.prompt = async (request) => {
    attempts += 1;
    // 新会话也拒收：模拟"窗口真的不够，换会话也救不回来"。
    throw Object.assign(new Error(overflowError.message), { code: 'preflight_compress_failed' });
    // eslint-disable-next-line no-unreachable
    return prompt(request);
  };
  await r.post(message(1, '你好'));
  assert.equal(attempts, 2, '一条消息最多重建一次会话');
  assert.equal(r.stats.contextOverflowRecoveries, 1);
  assert.match(String(r.stats.lastError ?? ''), /413|preflight_compress_failed/);
});

await test('调过工具的回合不再重投，避免二次执行副作用', async () => {
  const r = rig({ groupTrigger: 'all' });
  r.ctx.sessionController.follow = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'snapshot', cursor: 0 };
      yield { type: 'event', event: { seq: 1, type: 'turn/start', data: { turn: 1 } } };
      yield { type: 'event', event: { seq: 2, type: 'tool/call',
        data: { name: 'mcp__qq__qq_workspace', callId: 'c1', arguments: '{"action":"write"}' } } };
      yield { type: 'event', event: { seq: 3, type: 'tool/result',
        data: { callId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } } };
      yield { type: 'event', event: { seq: 4, type: 'turn/end',
        data: { turn: 1, reason: { kind: 'error', error: overflowError } } } };
    },
  });
  await r.post(message(1, '写个文件'));
  assert.equal(r.prompts.length, 1, '已经产生副作用的一轮不得再投');
  assert.equal(r.stats.contextOverflowRecoveries, undefined);
});

console.log(`\ncontext-overflow: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
