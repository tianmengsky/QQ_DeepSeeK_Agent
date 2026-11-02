// 她"外面的时间"那份材料：给现场，也给"我手上有什么"。
//
// 2026-11-01 两次转向，都是用户拍板：
//   ① 先删清单——「事情越具体，越容易变成执行清单，这和'自发性'是相违背的」「少就是多」；
//   ② 再补回来——「把她所有能用的工具都在提示词里告诉她……我发现她不会查看自己会什么，
//      一直在进行 windows 查看和 say，从来没有查看过 memory 或写过什么记事本，
//      或查看过自身的状态」。
//
// 数据站得住：`self:account` 六个回合里 `qq_windows` 27 次、`qq_send_group_msg` 5 次，
// 而 `qq_status`／`qq_set_profile`／`qq_poke`／公告／表情／语音一次都没有。
// 差别在于：清单要**由白名单生成**，不是手写剧目——手写会烂（加了工具忘了写、
// 删了工具忘了删，她照着去调被拒，就再也不试了）。
//
// 所以这份测试钉三件事：
//   ① 世界快照原样置顶；
//   ② 白名单里每一个工具都在材料里出现（一个都不能漏）；
//   ③ 材料里出现的每个工具名都真在白名单里（一个都不能编）。
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

const short = (name) => String(name).replace(/^(?:mcp__[a-z-]+__)+/u, '');
const allowed = new Set(allowedToolNames().map(short));
const text = spineTaskText('【快照】');
const TOOLISH = /(?:mcp__[a-z-]+__)?(?:qq|bili)_[a-z_]+|create_word_document|create_pdf|subagent_fork|subagent|list_agents|send_message|interrupt_agent|web_search|web_fetch/g;
const listed = new Set((text.match(TOOLISH) ?? []).map((name) => short(name)));

await test('世界快照原样保留在最前面', () => {
  assert.ok(text.startsWith('【快照】'), '快照必须是她读到的第一样东西');
});

await test('白名单里每个工具都写在材料里', () => {
  const missing = [...allowed].filter((name) => !listed.has(name));
  assert.deepEqual(missing, [], `她不知道还有这些可用：${missing.join('、')}`);
});

await test('材料里的工具名都真能用（不编，也不写已被拿掉的）', () => {
  const bogus = [...listed].filter((name) => !allowed.has(name));
  assert.deepEqual(bogus, [], `列了却没有工具：${bogus.join('、')}`);
});

await test('清单给的是可直接调用的名字：MCP 工具带前缀，裸名不出现在清单里', () => {
  // 2026-11-01 线上实测：清单教裸名 qq_set_profile，DSH 只认 mcp__qq__qq_set_profile，
  // 她照单调用 → unknown tool。清单是目录，名字必须拿起来就能调。
  assert.ok(text.includes('mcp__qq__qq_set_profile'), 'MCP 工具要列真实可调名');
  assert.ok(!/(?:^|[^\w])qq_set_profile(?:[^\w]|$)/u.test(text), '裸名 qq_set_profile 不该再出现');
  assert.ok(!/(?:^|[^\w])qq_send_group_msg(?:[^\w]|$)/u.test(text), '同族裸名一起清');
});

await test('“外面”没有嘴：房间的事指向派遣，不再指 say（2026-11-01 派遣架构）', () => {
  assert.ok(text.includes('没有嘴'), '得写明她的话从外面发不出去');
  assert.ok(text.includes('qq_dispatch'), '房间的事的出口是派遣');
  assert.ok(!text.includes('只有 say 那一下才真发出去'), '旧指路不能残留');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
