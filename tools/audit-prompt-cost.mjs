/** 只读审计真实请求的工具与用量，不打印消息、系统提示或凭据。 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { allowedToolNames } from '../lib/agent/tool-scope.mjs';

const root = process.argv[2];
if (!root) {
  console.error('用法: node tools/audit-prompt-cost.mjs <Session 目录或 session.v4.jsonl.zstd>');
  process.exit(1);
}
const file = fs.statSync(root).isDirectory() ? path.join(root, 'session.v4.jsonl.zstd') : root;
const bytes = fs.readFileSync(file), chunks = [], magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
for (let cursor = 0; cursor < bytes.length;) {
  const start = bytes.indexOf(magic, cursor);
  if (start < 0) break;
  const end = bytes.indexOf(magic, start + 4);
  try { chunks.push(zlib.zstdDecompressSync(bytes.subarray(start, end < 0 ? undefined : end))); }
  catch { /* 正在写入的半帧不作为完整记录 */ }
  cursor = end < 0 ? bytes.length : end;
}
const events = Buffer.concat(chunks).toString('utf8').split('\n').flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const tools = events.findLast((e) => e.type === 'request/header')?.data?.header?.tools ?? [];
const allowed = new Set(allowedToolNames());
const kept = tools.filter((t) => allowed.has(t.name ?? t.function?.name));
const groups = {};
for (const tool of tools) {
  const name = tool.name ?? tool.function?.name ?? '';
  const group = name.match(/^mcp__([^_]+)__/)?.[1] ?? 'native';
  const g = groups[group] ??= { count: 0, schemaChars: 0 };
  g.count++; g.schemaChars += JSON.stringify(tool).length;
}
const prompts = events.filter((e) => e.type === 'user/message').map((e) => {
  const text = (e.data.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return { bridge: text.includes('—— 现在这条消息 ——'), chars: text.length,
    static: text.includes('[你的人设]'), memory: text.includes('的记忆】') };
}).filter((p) => p.bridge);
const usage = events.filter((e) => e.type === 'assistant/message' && e.data?.usage).map((e) => {
  const u = e.data.usage;
  const input = u.inputTokens ?? u.input_tokens ?? null;
  const cached = u.cacheReadTokens ?? u.cache_read_input_tokens ?? null;
  const written = u.cacheWriteTokens ?? u.cache_creation_input_tokens ?? null;
  const total = u.totalTokens ?? u.total_tokens ?? null;
  const output = u.outputTokens ?? u.output_tokens ?? null;
  // 本机 pi-ai Responses 实现明确从 provider input_tokens 扣除缓存读/写，
  // DSH inputTokens 因此为未缓存部分；缓存输入仍占用完整上下文。
  return { reportedInput: input, cacheRead: cached,
    cacheWrite: written,
    inputFromTotal: total != null && output != null ? total - output : null,
    inputFromBuckets: input == null ? null : input + (cached ?? 0) + (written ?? 0), output };
});
const latestContext = events.findLast((e) => e.type === 'request/context')?.data;
const systemTexts = events.filter((e) => e.type === 'system/message').map((e) =>
  (e.data.content ?? e.data.message?.content ?? []).filter((p) => p.type === 'text')
    .map((p) => p.text).join('\n'));
// Message ids let us quantify repeated window rows without revealing chat text.
const windowRows = events.filter((e) => e.type === 'user/message').flatMap((e) => {
  const t = (e.data.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const start = t.indexOf('【最近聊了什么'), end = t.indexOf('—— 现在这条消息 ——', start);
  return start < 0 ? [] : t.slice(start, end < 0 ? undefined : end).split('\n')
    .filter((row) => /\[消息 [^\]]+\]/.test(row));
});
const uniqueWindowRows = [...new Set(windowRows)];
const sumChars = (rows) => rows.reduce((n, row) => n + row.length, 0);
console.log(JSON.stringify({ tools: { actualCount: tools.length,
  actualSchemaChars: JSON.stringify(tools).length, groups,
  afterScopeFilterCount: kept.length, afterScopeFilterSchemaChars: JSON.stringify(kept).length,
  comparison: '过滤后的 schema 来自旧请求的离线筛选，不是新上线请求的实测 token' },
  context: latestContext ? { provider: latestContext.provider, model: latestContext.model,
    contextWindow: latestContext.contextWindow } : null,
  system: { recordedVersions: systemTexts.length, versionChars: systemTexts.map((t) => t.length) },
  history: { compactionSummaries: events.filter((e) => e.type === 'compaction/summary').length,
    windowRows: windowRows.length, uniqueWindowRows: uniqueWindowRows.length,
    repeatedWindowChars: sumChars(windowRows) - sumChars(uniqueWindowRows),
    note: '历史重复文本字符统计，不是新版本的实测 token 或费用降幅' },
  prompts, usage }, null, 2));
