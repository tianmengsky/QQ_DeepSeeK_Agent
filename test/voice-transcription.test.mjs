import assert from 'node:assert/strict';
import { rig, message, request, response } from './helpers/bridge.mjs';
import { renderMessage } from '../lib/domain/events.mjs';
import { transcribeIncomingVoice, awaitIncomingVoices } from '../lib/application/voice-transcription.mjs';
import { TaskScheduler } from '../lib/application/task-scheduler.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { console.error('  ✗ ' + name, error); process.exitCode = 1; }
}
const record = (id = 7) => ({ ...message(id), message: [
  { type: 'at', data: { qq: '100' } }, { type: 'record', data: { file: 'voice.silk' } },
] });
const success = (text) => ({ ok: true, status: 200, text: async () =>
  JSON.stringify({ status: 'ok', retcode: 0, data: { text } }) });

await test('voice rendering preserves text around the transcript', () => {
  assert.equal(renderMessage([{ type: 'text', data: { text: '听听' } },
    { type: 'record', data: { transcription: '你好' } }]), '听听[语音转文字：你好]');
  assert.equal(renderMessage([{ type: 'record', data: { file: 'x' } }]), '[语音]');
});
await test('ingress queues immediately and the model reads QQ transcription', async () => {
  const r = rig({ groupTrigger: 'at', voiceTranscriptionEnabled: true });
  const event = record();
  let finish;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith('/fetch_ptt_text')
    ? new Promise((resolve) => { finish = () => resolve(success('今天天气')); })
    : original(url, init);
  const res = response();
  await r.handler(request(event), res);
  assert.equal(res.statusCode, 204);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.prompts.length, 0);
  assert.equal(typeof finish, 'function');
  finish();
  await r.drain();
  assert.equal(r.stats.voiceTranscribed, 1);
  assert.match(JSON.stringify(r.prompts), /今天天气/);
  assert.equal(r.registry.entry('group:10').window.find((m) => m.messageId === '7').text.includes('今天天气'), true);
  assert.deepEqual(r.calls.filter((c) => c.action === 'fetch_ptt_text').map((c) => c.payload), []);
});
await test('failed transcription keeps the voice placeholder', async () => {
  const r = rig({ groupTrigger: 'at' });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith('/fetch_ptt_text')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ status: 'failed', retcode: 100, wording: 'ptt translate failed: error=9' }) }
    : original(url, init);
  await r.post(record(8));
  assert.equal(r.stats.voiceTranscriptionFailed, 1);
  assert.match(JSON.stringify(r.prompts), /QQ 转文字失败，内容不可知/);
  assert.match(r.registry.entry('group:10').window.find((m) => m.messageId === '8').text,
    /QQ 转文字失败，内容不可知/);
  assert.equal(r.stats.lastVoiceTranscriptionError.messageId, '8');
  assert.match(r.stats.lastVoiceTranscriptionError.detail, /error=9/);
});
await test('disabled transcription does not call QQ', async () => {
  const r = rig({ groupTrigger: 'at', voiceTranscriptionEnabled: false });
  await r.post(record(9));
  assert.equal(r.calls.some((c) => c.action === 'fetch_ptt_text'), false);
  assert.match(JSON.stringify(r.prompts), /\[语音\]/);
});
await test('recalled message is not rewritten by late transcription', async () => {
  const event = record(10);
  const entry = { recalledIds: ['10'], window: [{ messageId: '10', text: '[语音]' }] };
  const registry = { entry: () => entry, persist: () => { throw new Error('should not persist recalled text'); } };
  const original = globalThis.fetch;
  globalThis.fetch = async () => success('撤回后文本');
  try {
    transcribeIncomingVoice({ onebotHttp: 'http://localhost', voiceTranscriptionEnabled: true }, event,
      registry, 'group:10', {}, { warn() {} });
    await awaitIncomingVoices([event]);
    assert.equal(entry.window[0].text, '[语音]');
    assert.equal(renderMessage(event.message), '@100[语音]');
  } finally { globalThis.fetch = original; }
});
await test('enabled task routing waits for the transcript before deciding and persisting', async () => {
  const event = record(11);
  const entry = { recalledIds: [], window: [], floor: { version: 0, messages: [] } };
  const registry = { entry: () => entry, persist() {} };
  const original = globalThis.fetch;
  let finish, decided = false;
  globalThis.fetch = async () => new Promise((resolve) => { finish = () => resolve(success('帮我写计划')); });
  const scheduler = Object.create(TaskScheduler.prototype);
  Object.assign(scheduler, { enabled: true, mode: 'enabled', config: {}, registry,
    ctx: {}, state: {}, stats: {}, pump() {},
    routing: {
      async decide(ctx, reg, key, input) {
        decided = true;
        assert.match(renderMessage(input.message), /帮我写计划/);
        return { action: 'new' };
      },
      admit(key, input) {
        assert.match(renderMessage(input.message), /帮我写计划/);
        assert.equal(input.__voicePromise, undefined);
        return { data: { route: { action: 'new' } } };
      },
    },
  });
  try {
    transcribeIncomingVoice({ onebotHttp: 'http://localhost' }, event, registry,
      'group:10', {}, { warn() {} });
    const pending = scheduler.admit('group:10', [event]);
    assert.equal(decided, false);
    finish();
    assert.equal(await pending, true);
    assert.equal(decided, true);
  } finally { globalThis.fetch = original; }
});
await test('private voice is transcribed without an @ mention', async () => {
  const r = rig({ voiceTranscriptionEnabled: true });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith('/fetch_ptt_text')
    ? success('帮我看一下') : original(url, init);
  const event = { ...record(12), message_type: 'private', group_id: undefined,
    message: [{ type: 'record', data: { file: 'voice.silk' } }] };
  try {
    await r.post(event);
    assert.match(JSON.stringify(r.prompts), /帮我看一下/);
    assert.equal(r.stats.voiceTranscribed, 1);
  } finally { globalThis.fetch = original; }
});
console.log(`${passed} passed, ${process.exitCode ? 1 : 0} failed`);
