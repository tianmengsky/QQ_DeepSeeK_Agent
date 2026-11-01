// "自己的时间"里，协议不能骗她。
//
// 2026-11-01 用户看完整段脊柱提示词后说："这一轮的结果和心跳机制判断接话没区别。"
// 原因不只在任务文本：静态协议里写着"每个气泡用『』框起来，桥接会发出去"——
// 可脊柱回合的 `execute-turn` 在 `__spine` 分支直接返回，正文一个字都不发。
// 她按协议写了一段话，以为发出去了，其实什么也没发生；于是一整轮只剩"说/不说"，
// "做事"这件事从头到尾没有出现在她的选项里。
//
// 这份测试钉的是一条**事实一致性**：自述"会被发出去"的那套协议，不能出现在
// 正文根本不投递的回合里。
import assert from 'node:assert/strict';
import { stableProtocol } from '../lib/prompt/protocol.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error.message}`);
  }
}

const config = { memoryEnabled: true, crossWindowEnabled: true, silenceToken: '[SKIP]' };
const selfTime = stableProtocol(config, true, { selfTime: true });
const normal = stableProtocol(config, true);

test('自己的时间里不再承诺"最终正文会发出去"', () => {
  assert.ok(!selfTime.includes('每个气泡用一对'), '她按这条写话，可那一轮什么都不投递');
  assert.ok(!selfTime.includes('只有『』里的字会进群'), '同上');
});

test('自己的时间说明白了正文去哪：留作笔记，不发出去', () => {
  assert.ok(selfTime.includes('不会发到任何地方'));
  assert.ok(/笔记/.test(selfTime));
});

test('真正能把话送出去的两个出口都写了名字', () => {
  for (const name of ['qq_windows', 'qq_send_group_msg', 'qq_send_private_msg']) {
    assert.ok(selfTime.includes(name), `缺 ${name}：她只认识"正文会发出去"的话，就不会想到用工具`);
  }
});

test('"做事"与"说话"被区分开了（产出不是一句回复）', () => {
  assert.ok(selfTime.includes('你做了什么'));
  assert.ok(selfTime.includes('[SKIP]'), '沉默仍然允许，而且用的是当前配置里的标记');
});

test('普通聊天回合不受影响：气泡协议还在', () => {
  assert.ok(normal.includes('每个气泡用一对'));
  assert.ok(normal.includes('【长任务协调】'));
});

test('群里那套"轮次与退避"不塞进自己的时间', () => {
  assert.ok(!selfTime.includes('【群聊轮次与退避】'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
