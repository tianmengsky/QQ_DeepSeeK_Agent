/**
 * voice-intent.test.mjs —— "要我出声"的识别只做提示，不决定发送。
 *
 * 断言两件事：
 *   1. 高精度短语能识别（发语音 / 念给我听 / 用语音说）；
 *   2. 字面像、实际不是的说法不识别（吟唱、唱歌、读一下文件、说句话、否定句）。
 * 依据见 lib/prompt/voice-intent.mjs 顶部：9.5 天真实消息里这些误伤都出现过。
 */
import assert from 'node:assert/strict';
import { detectVoiceIntent } from '../lib/prompt/voice-intent.mjs';
import { rig, message } from './helpers/bridge.mjs';

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

console.log('voice-intent: 出声请求识别');

await test('明确的语音请求能识别', () => {
  for (const text of ['发条语音', '来一个语音', '念给我听', '读出来', '念一遍',
    '用语音说一遍', '语音念一下这句', '你可以发语音信息了吗？', '背一遍']) {
    assert.equal(detectVoiceIntent(text).requested, true, text);
  }
});

await test('字面像但不是在要语音的说法不识别', () => {
  for (const text of ['五条悟的吟唱', '唱一首歌', '唱歌不行 我五音不全', '读一下这个文件',
    '说句话比戳管用', '读一下这段代码', '念你名字怎么了']) {
    assert.equal(detectVoiceIntent(text).requested, false, text);
  }
});

await test('否定说法不识别，超长文本也不识别', () => {
  assert.equal(detectVoiceIntent('别发语音了').requested, false);
  assert.equal(detectVoiceIntent('不要用语音').requested, false);
  assert.equal(detectVoiceIntent('发语音'.repeat(80)).requested, false);
  assert.equal(detectVoiceIntent('').requested, false);
});

await test('命中时本轮提示词加【本轮要出声】，未命中不加', async () => {
  const hit = rig({ groupTrigger: 'all' }, '好');
  await hit.post(message(1, '发条语音'));
  const hitText = hit.prompts[0].content[0].text;
  assert.match(hitText, /【本轮要出声】/);
  assert.match(hitText, /qq_send_ai_voice/);
  assert.match(hitText, /不要用文字气泡逐句念/);

  const miss = rig({ groupTrigger: 'all' }, '好');
  await miss.post(message(2, '五条悟的吟唱'));
  assert.doesNotMatch(miss.prompts[0].content[0].text, /【本轮要出声】/);
});

await test('静态协议里始终有念与语音的载体制规则', async () => {
  const r = rig({ groupTrigger: 'all' }, '好');
  await r.post(message(3, '随便聊聊'));
  const text = r.prompts[0].content[0].text;
  assert.match(text, /【念与语音】/);
  assert.match(text, /长文分段念/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
