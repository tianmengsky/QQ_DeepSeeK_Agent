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
async function test(name, fn) {
  try {
    await fn();
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

test('把"话到底怎么出去的"说清楚，通道指向派遣', () => {
  // 2026-11-01 派遣架构：脊柱没有嘴，房间的事一律派；say 对 self:* 关死。
  assert.ok(selfTime.includes('qq_dispatch'), '要点名派遣这条通道');
  assert.ok(selfTime.includes('qq_windows'), '读窗口的通道要留');
  assert.ok(!selfTime.includes('qq_send_group_msg'), '别在协议里列发送工具菜单');
  assert.ok(!selfTime.includes('action=say'), 'say 不再是脊柱的说话通道');
  assert.ok(!selfTime.includes('发言工具，或 qq_windows 的 say'), '旧指路不能残留');
});

test('沉默仍然允许，而且用的是当前配置里的标记', () => {
  assert.ok(selfTime.includes('[SKIP]'));
});

test('普通聊天回合不受影响：气泡协议还在', () => {
  assert.ok(normal.includes('每个气泡用一对'));
  assert.ok(normal.includes('【长任务协调】'));
});

test('群里那套"轮次与退避"不塞进自己的时间', () => {
  assert.ok(!selfTime.includes('【群聊轮次与退避】'));
});

/**
 * 下面两条走真回合，钉的是**管线**而不是措辞。
 *
 * 2026-11-01：`proactive.mjs` 一直在给 `executeTurn` 传 `taskText`（脊柱的世界快照 +
 * "你手里真能做的事"工具菜单），可 `executeTurn` 的解构里没有这个键，随后又用自己算的
 * `taskText` 覆盖 —— 那份文本从来没进过提示词。表现出来就是她醒来只有一句
 * "你可以做任何你想做的事情"，不知道手里有什么、也不知道哪个窗口在聊什么。
 */
const { rig } = await import('./helpers/bridge.mjs');
const { executeTurn } = await import('../lib/application/execute-turn.mjs');

async function spineTurn(taskText, existing = null) {
  const r = existing ?? rig({}, 'reply');
  const event = {
    post_type: 'message', message_type: 'private', self_id: 100, user_id: 100,
    message_id: 'spine:1',
    message: [{ type: 'text', data: { text: '（自己的时间）你醒了，检查一下自己能做什么，找点事情做。包括但不限于：回忆并整理一下自己的记忆、整理归档一下今天发生了什么、想要去了解一个人，问问他你今天去了哪里，吃了什么东西、想要被人看见或认可：去发表一段说说、改一改自己的名称、去群里发表自己的见解、发布一个群公告、去刷B站并分享一个自己看见的有趣视频。你有自己的“冲动”，做任何你自己想要做的事，不只局限于聊天。' } }],
    raw_message: '（自己的时间）你醒了，检查一下自己能做什么，找点事情做。包括但不限于：回忆并整理一下自己的记忆、整理归档一下今天发生了什么、想要去了解一个人，问问他你今天去了哪里，吃了什么东西、想要被人看见或认可：去发表一段说说、改一改自己的名称、去群里发表自己的见解、发布一个群公告、去刷B站并分享一个自己看见的有趣视频。你有自己的“冲动”，做任何你自己想要做的事，不只局限于聊天。',
    sender: { nickname: '时间' }, __selfTurn: true, __spine: true,
  };
  await executeTurn(r.ctx, r.config, r.registry, r.state, null, r.stats, null, 'self:account', event,
    { heartbeat: true, taskText });
  return r.prompts.at(-1).content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

await test('调用方预置的任务材料真的进得了提示词', async () => {
  const text = await spineTurn('SNAPSHOT-ONLY-MARK\n你能做的事：qq_windows');
  assert.ok(text.includes('【相关任务材料】'), '空着就等于没告诉她手里有什么');
  assert.ok(text.includes('SNAPSHOT-ONLY-MARK'));
  assert.ok(text.includes('qq_windows'));
});

await test('她自己的时间里没有"要回应的是这一条"', async () => {
  const text = await spineTurn('SNAPSHOT');
  assert.equal(text.includes('要回应的是这一条'), false);
  assert.equal(text.includes('发送者：'), false, '那一轮没有发送者，是时钟写的一行字');
  assert.ok(text.includes('你自己的时间'));
  assert.equal(text.split('（自己的时间）你醒了').length - 1, 1, '那行字只出现一次');
});

await test('连续的自唤醒在聊天记录里只占一行', async () => {
  // 2026-11-01：`self:account` 的历史里十条全是「你醒了」，真正的对话被挤到窗口外，
  // 她读到的只是自己醒过十遍。折叠之后一行写完次数与时间段。
  const r = rig({}, 'reply');
  const entry = r.registry.entry('self:account');
  const base = new Date(2026, 10, 1, 11, 0).getTime();
  entry.window = Array.from({ length: 6 }, (_, i) => ({
    text: '（自己的时间）你醒了，检查一下自己能做什么，找点事情做。包括但不限于：回忆并整理一下自己的记忆、整理归档一下今天发生了什么、想要去了解一个人，问问他你今天去了哪里，吃了什么东西、想要被人看见或认可：去发表一段说说、改一改自己的名称、去群里发表自己的见解、发布一个群公告、分享一个自己看见的有趣视频。你有自己的“冲动”，做任何你自己想要做的事情',
    messageId: `spine:${1000 + i}`, who: '时间', qq: '100', bot: false, at: base + i * 600000,
  }));
  entry.window.push({
    text: '下午好啊', messageId: 'm-9', who: '随便做自己', qq: '200', bot: false, at: base + 7 * 600000,
  });
  const text = await spineTurn('SNAPSHOT', r);
  assert.match(text, /醒过 6 次/u, '六次唤醒应该折成一行');
  assert.match(text, /下午好啊/u, '真正的历史不能被吞掉');
  const wakeLines = text.split('\n').filter((line) => /你醒了。检查一下自己能做什么/u.test(line));
  assert.ok(wakeLines.length <= 1, `唤醒行不该反复出现，实际 ${wakeLines.length} 行`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
