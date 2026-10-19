/**
 * 量工具 schema 到底占多少 token —— 这是 QQ 会话里每轮输入的隐藏大头。
 *
 *   node tools/tool-cost.mjs <listTools 的 JSON 导出文件>
 *
 * 为什么要单独量：window-optimizer 只算「人设+记忆+窗口」那部分，
 * 实测单轮输入 15k~21k，而桥接提示词只有 6.6k —— 差额全在这里。
 * 削减工具（给 QQ 会话挂 agentPreset）比调窗口省得多。
 */
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node tools/tool-cost.mjs <listTools 导出.json>');
  process.exit(1);
}

/** 中文按 1.7 字/token 粗估，和 window-optimizer 保持一致。 */
const CPT = 1.7;
const tok = (chars) => Math.round(chars / CPT);

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error('JSON 解析失败：', error.message);
  process.exit(1);
}

const tools = parsed?.data?.tools ?? parsed?.tools ?? [];
if (!tools.length) {
  console.error('没找到 tools 数组。顶层键：', Object.keys(parsed ?? {}).join(', '));
  process.exit(1);
}

/** 按前缀归类：mcp__<server>__ 归到 <server>，其余归到 dsh 自带。 */
function groupOf(name) {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return `mcp:${m[1]}`;
  return 'dsh 自带';
}

const rows = tools.map((t) => {
  const size = JSON.stringify(t).length;
  return { name: t.name, group: groupOf(t.name), chars: size, tokens: tok(size) };
});

const byGroup = new Map();
for (const r of rows) {
  if (!byGroup.has(r.group)) byGroup.set(r.group, { n: 0, chars: 0, tokens: 0, biggest: [] });
  const g = byGroup.get(r.group);
  g.n += 1;
  g.chars += r.chars;
  g.tokens += r.tokens;
  g.biggest.push(r);
}
for (const g of byGroup.values()) {
  g.biggest.sort((a, b) => b.chars - a.chars);
  g.biggest = g.biggest.slice(0, 3);
}

const totalChars = rows.reduce((a, r) => a + r.chars, 0);
const totalTokens = tok(totalChars);

console.log('============================================================');
console.log('  工具 schema 开销');
console.log('============================================================');
console.log(`  工具总数: ${rows.length}`);
console.log(`  原始 JSON: ${totalChars} 字符  ≈ ${totalTokens} token`);
console.log('  （注意：真实传输里还会加上每轮的固定包裹，这里只量 schema 本身）');
console.log('');
console.log('  按来源分组（贵的排前面）：');
console.log('  组                     工具数     字符    ≈token    占比');
console.log('  ────────────────────────────────────────────────────────────');
for (const [name, g] of [...byGroup.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  const pct = Math.round((100 * g.chars) / totalChars);
  console.log(
    `  ${name.padEnd(20)} ${String(g.n).padStart(5)} ${String(g.chars).padStart(9)} ${String(
      g.tokens,
    ).padStart(9)} ${String(`${pct}%`).padStart(7)}`,
  );
}
console.log('');
console.log('  各组最贵的 3 个工具：');
for (const [name, g] of [...byGroup.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`   ${name}`);
  for (const r of g.biggest) {
    console.log(`     ${String(r.tokens).padStart(5)} token  ${r.name}`);
  }
}

console.log('');
console.log('  结论：');
const mcp = [...byGroup.entries()].filter(([k]) => k.startsWith('mcp:'));
const mcpChars = mcp.reduce((a, [, g]) => a + g.chars, 0);
console.log(
  `    · MCP 工具（rars / qq / document-editor）合计 ≈ ${tok(mcpChars)} token，` +
    `占 ${Math.round((100 * mcpChars) / totalChars)}%。`,
);
console.log('    · 如果 QQ 会话里只留 qq 那一组、其余砍掉，每轮能省下大部分这个开销。');
console.log('    · 做法是在 profile 里给 qq-bridge 配 agentPreset，或把 RARS/Office 的 MCP');
console.log('      客户端设成不挂在 QQ 会话上。具体省多少要按保留集重算。');
