/**
 * 宽容 JSON 解析的回归测试。
 *
 * 线上 10-19 那批 170 条 invalid-json 里，有相当一部分并不是"模型没答"，
 * 而是答了、但前面多一句解释或包了代码块。严格 JSON.parse 会把可用裁决丢掉，
 * 代价是路由退回 new 或参与决策 fail-open。这里锁住"能救回来的几种形状"和
 * "真正坏掉时仍然抛错"。
 */
import assert from 'node:assert/strict';
import { parseJsonLoose, sliceFirstJsonValue } from '../lib/agent/json-output.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name, e.stack); }
}

await test('纯 JSON 原样解析（快路径不变）', () => {
  assert.deepEqual(parseJsonLoose('{"action":"new","confidence":0.9}'), { action: 'new', confidence: 0.9 });
});

await test('去掉 ```json 围栏', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"reply":true,"reason":"在问她"}\n```'), { reply: true, reason: '在问她' });
});

await test('前面多一句解释也能救回来', () => {
  assert.deepEqual(parseJsonLoose('好的，我的判断是：{"action":"query","taskId":"task-1"}'),
    { action: 'query', taskId: 'task-1' });
});

await test('字符串里的花括号不会提前收尾', () => {
  const value = { reason: '他说{"好"}，所以继续', action: 'keep' };
  assert.deepEqual(parseJsonLoose('判断如下：' + JSON.stringify(value)), value);
  // 同一份文本用正则 /\{[\s\S]*?\}/ 会在第一个 `}` 处截断，这里必须完整。
  assert.equal(sliceFirstJsonValue('{"reason":"他说{好}"}'), '{"reason":"他说{好}"}');
});

await test('转义引号不破坏配对', () => {
  const value = { reason: '他说"{\\"好\\"}"' };
  assert.deepEqual(parseJsonLoose('前缀 ' + JSON.stringify(value)), value);
});

await test('数组根也能解析', () => {
  assert.deepEqual(parseJsonLoose('结果：[{"key":"a"}]'), [{ key: 'a' }]);
});

await test('真正坏掉的输出仍然抛 SyntaxError', () => {
  assert.throws(() => parseJsonLoose(''), SyntaxError);
  assert.throws(() => parseJsonLoose('完全没有 JSON'), SyntaxError);
  assert.throws(() => parseJsonLoose('{"action":'), SyntaxError);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
