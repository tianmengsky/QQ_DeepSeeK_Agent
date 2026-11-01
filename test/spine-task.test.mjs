// 她"外面的时间"那份任务文本：列出来的每件事，都必须真有工具能做。
//
// 2026-11-01：原来那段只写"你可以什么都不做／也可以看别处"，她第一次醒来 4 秒就回
// [SKIP]——不是不想做，是没被告知手里有什么。修的时候最容易犯的错正好相反：
// 把想让她做的事写进去，但工具白名单里没有，于是她照着去调、被拒、再也不敢试。
// 所以这份测试钉的是"文本与白名单一致"，不是措辞。
import assert from 'node:assert/strict';
import { spineTaskText } from '../lib/application/proactive.mjs';
import { allowedToolNames } from '../lib/agent/tool-scope.mjs';

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

const allowed = new Set(allowedToolNames());
const text = spineTaskText('【快照】');

// 文本里提到的工具名，去掉 mcp__qq__ 前缀后再和名单比。
const mentioned = [...new Set(text.match(/\b(?:qq|bili)_[a-z_]+/g) ?? [])];

await test('任务文本里提到的每个工具，白名单里都真的有', () => {
  assert.ok(mentioned.length >= 5, `应该提到好几件具体的事，实际只有 ${mentioned.length} 个工具名`);
  const missing = mentioned.filter((name) => !allowed.has(name) && !allowed.has(`mcp__qq__${name}`));
  assert.deepEqual(missing, [], `文本里列了却没有工具：${missing.join('、')}`);
});

await test('不是空话：至少列出"说话、看 B 站、记事情、写自己"四类', () => {
  for (const name of ['qq_windows', 'qq_send_group_msg', 'bili_search', 'qq_intent', 'qq_memory']) {
    assert.ok(text.includes(name), `缺 ${name}`);
  }
});

await test('"什么都不做"仍然允许，但不能是唯一的建议', () => {
  assert.ok(text.includes('[SKIP]'), '要告诉她可以沉默');
  const skipLine = text.split('\n').filter((line) => line.includes('[SKIP]')).join('');
  const others = text.split('\n').filter((line) => line.startsWith('· '));
  assert.ok(others.length >= 5, '其余建议要成条列出');
  assert.ok(!/^(你可以什么都不做)/.test(text), '不能一上来就劝她别做');
  assert.ok(skipLine.length < 120, '沉默只该是一句附带选项，不该是主建议');
});

await test('快照原样保留在最前面，不被说明挤掉', () => {
  assert.ok(text.startsWith('【快照】'));
});

await test('分享视频的形状写死了：话 + 标题 + 完整链接', () => {
  // 2026-11-01：她在群里主动 "分享" 了一条自己刷到的视频，但只发一句感想、
  // 没有标题也没有链接，看到的人不知道她在讲什么。她的历史发言里一条链接
  // 都没有过，所以这个形状不写死就不会自己长出来。
  assert.match(text, /bilibili\.com\/video\/BV/u, '要给出完整链接的形状');
  assert.match(text, /标题/u);
  assert.match(text, /三行|三样/u, '要说明是几样东西一起给');
  assert.ok(/不算分享/.test(text), '要点明只发一句感想不算分享');
});

await test('"外面"与房间的区别要写清楚（否则她会就地回话，什么都没发出去）', () => {
  assert.ok(text.includes('只有 say 那一下才真发出去'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
