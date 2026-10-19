/**
 * 看 DeepSeek 返回的 usage 里到底有哪些字段 —— 特别是有没有缓存命中计数。
 *
 *   node tools/check-cache.mjs [会话目录]
 *
 * 为什么这个数决定"窗口开几轮"：如果人设+工具这 17k 的前缀能命中缓存
 * （按 1/10 计价），那"换窗口导致缓存失效"的代价就很小，最优点会被推到
 * 十几二十轮；如果缓存压根没命中，那每轮都在全价重发人设，窗口就该短。
 * 两种结论完全相反，所以必须先把这个数拿到手，不能猜。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir =
  process.argv[2] ??
  'C:\\Users\\30481\\.dsh\\sessions\\--D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--';

function readSessionLog(file) {
  const buf = fs.readFileSync(file);
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; ) {
    const at = buf.indexOf(MAGIC, i);
    if (at === -1) break;
    starts.push(at);
    i = at + 4;
  }
  const chunks = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)));
    } catch {}
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

const sessions = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const f = path.join(dir, d.name, 'session.v4.jsonl.zstd');
    return { name: d.name, file: f, mtime: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 };
  })
  .filter((s) => fs.existsSync(s.file))
  .sort((a, b) => b.mtime - a.mtime);

const keys = new Map();
const samples = [];

for (const s of sessions.slice(0, 10)) {
  let events;
  try {
    events = readSessionLog(s.file);
  } catch {
    continue;
  }
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const u = e?.data?.usage ?? e?.usage;
    if (!u) continue;
    for (const k of Object.keys(u)) keys.set(k, (keys.get(k) ?? 0) + 1);
    samples.push({ session: s.name.slice(0, 22), u });
  }
}

console.log('=== usage 里出现过的字段 ===');
for (const [k, n] of [...keys.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}  (${n} 次)`);
}

console.log('\n=== 最近 15 条 usage 原始值 ===');
for (const s of samples.slice(-15)) {
  console.log(`  ${s.session}  ${JSON.stringify(s.u)}`);
}

/** 试着把常见命名归一化，算缓存命中率。 */
const norm = samples.map(({ u }) => ({
  in: u.inputTokens ?? u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? u.input ?? null,
  out: u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? u.output ?? null,
  hit:
    u.cacheReadTokens ??
    u.cache_read_input_tokens ??
    u.promptCacheHitTokens ??
    u.cacheRead ??
    u.cachedTokens ??
    u.prompt_tokens_details?.cached_tokens ??
    null,
}));

const withIn = norm.filter((n) => typeof n.in === 'number');
const withHit = norm.filter((n) => typeof n.hit === 'number' && n.hit > 0);
console.log(`\n有 input 的样本 ${withIn.length} 条，有缓存命中字段且 >0 的 ${withHit.length} 条`);
if (withHit.length) {
  const top = withHit.slice(-10);
  for (const n of top) {
    console.log(`  in=${n.in}  hit=${n.hit}  命中率=${Math.round((100 * n.hit) / n.in)}%`);
  }
} else {
  console.log('  ⚠ 没找到缓存命中字段 —— 要么这个 provider 不上报，要么确实没命中。');
  console.log('     无法从这里判断缓存，需要换别的方式（比如看账单口径）。');
}
