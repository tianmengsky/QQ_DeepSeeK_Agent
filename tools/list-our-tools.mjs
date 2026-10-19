/**
 * 从 qq-mcp 源码里抽出全部工具清单（名字 + 一句话说明 + 能力位）。
 *   node tools/list-our-tools.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync('D:/Code/dsh-qq-bridge/qq-mcp/src/index.js', 'utf8');

// 工具定义块：name: '...', description: ... ，按 name 切
const blocks = src.split(/\n  \{\n    name: '/).slice(1);
console.log(`qq-mcp 工具共 ${blocks.length} 个\n`);

for (const b of blocks) {
  const name = b.slice(0, b.indexOf("'"));
  // 取 description 里的字面量（可能跨行拼接）
  const dm = b.match(/description:\s*([\s\S]*?),\n    inputSchema/);
  let desc = '';
  if (dm) {
    desc = [...dm[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
  }
  console.log(`── ${name}`);
  console.log(`   ${desc.slice(0, 160).replace(/\s+/g, ' ')}`);
}

// 能力位
const capm = src.match(/const CAPABILITY_KEYS = \[([\s\S]*?)\];/);
if (capm) {
  const caps = [...capm[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  console.log(`\n能力位（${caps.length} 个）：${caps.join(', ')}`);
}

// 环境变量（可配项）
const envs = [...src.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
console.log(`\n读的环境变量（${[...new Set(envs)].length} 个）：${[...new Set(envs)].sort().join(', ')}`);
