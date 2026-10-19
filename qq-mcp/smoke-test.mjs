/**
 * 冒烟测试：以 MCP 客户端身份连上本项目的 stdio server，
 * 验证协议握手 + tools/list，并试调 qq_status（OneBot 没起时应返回可读错误）。
 *
 * 用法：node smoke-test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/index.js'],
  env: { ...process.env },
});

const client = new Client({ name: 'qq-mcp-smoke', version: '0.0.1' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`工具数：${tools.length}`);
for (const t of tools) console.log(`  - ${t.name}`);

console.log('\n--- call qq_status ---');
const res = await client.callTool({ name: 'qq_status', arguments: {} });
console.log('isError:', res.isError ?? false);
console.log(res.content.map((c) => c.text).join('\n'));

await client.close();
process.exit(0);
