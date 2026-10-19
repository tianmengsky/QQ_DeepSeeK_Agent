/**
 * 只看**桥接会话**，量每个会话里每轮的输入 token 走势。
 *
 *   node tools/check-bridge-usage.mjs [会话目录]
 *
 * 目的：验证 rotateEveryTurns 是否真的在生效 ——
 * 如果配了 10 轮换窗口，那输入 token 应该"涨 10 轮然后掉回去"成锯齿状；
 * 如果一路单调涨上去，说明轮换没发生（或没生效）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir =
  process.argv[2] ?? 'C:\\Users\\30481\\.dsh\\sessions\\--D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--';

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
    } catch {
      /* 半截帧 */
    }
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 坏行 */
    }
  }
  return events;
}

/** 桥接的提示词有这两个固定标志。 */
const isBridgePrompt = (t) => t.includes('[你的人设]') || t.includes('—— 现在这条消息 ——');

const sessions = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(dir, d.name))
  .filter((d) => fs.existsSync(path.join(d, 'session.v4.jsonl.zstd')))
  .map((d) => ({ dir: d, mtime: fs.statSync(path.join(d, 'session.v4.jsonl.zstd')).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

const bridgeSessions = [];
for (const s of sessions.slice(0, 40)) {
  let events;
  try {
    events = readSessionLog(path.join(s.dir, 'session.v4.jsonl.zstd'));
  } catch {
    continue;
  }
  const users = events.filter((e) => e.type === 'user/message');
  const bridgeTurns = users.filter((u) => {
    const t = (u.data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return isBridgePrompt(t);
  });
  if (!bridgeTurns.length) continue;

  // 每个 assistant/message 的 usage，按顺序
  const inTokens = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const u = e?.data?.usage ?? e?.usage;
    const v = u?.inputTokens ?? u?.input_tokens ?? u?.promptTokens;
    if (typeof v === 'number') inTokens.push(v);
  }
  const stat = (t) => (t.includes('[你的人设]') ? 'S' : 'd');
  bridgeSessions.push({
    name: path.basename(s.dir).slice(0, 28),
    mtime: new Date(s.mtime).toLocaleString('zh-CN'),
    turns: bridgeTurns.length,
    firstStatic: stat(
      (bridgeTurns[0].data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(''),
    ),
    inTokens,
  });
}

console.log(`扫了最近 40 个会话，其中桥接会话 ${bridgeSessions.length} 个\n`);

for (const s of bridgeSessions.slice(0, 8)) {
  console.log(`── ${s.name}  ${s.mtime}  轮数=${s.turns}`);
  if (!s.inTokens.length) {
    console.log('   （没有 usage 记录）');
    continue;
  }
  console.log(`   输入 token 走势: ${s.inTokens.join(' → ')}`);
  const first = s.inTokens[0];
  const last = s.inTokens[s.inTokens.length - 1];
  const drops = s.inTokens.filter((v, i) => i > 0 && v < s.inTokens[i - 1] * 0.7).length;
  console.log(
    `   首=${first} 末=${last} 增长=${last - first}  明显回落次数=${drops}` +
      `${drops === 0 && s.inTokens.length > 3 ? '  ⚠ 一直没回落过（轮换可能没生效）' : ''}`,
  );
}

const total = bridgeSessions.reduce((a, s) => a + s.turns, 0);
console.log(`\n桥接会话总轮数 = ${total}`);
const withDrops = bridgeSessions.filter((s) => {
  const t = s.inTokens;
  return t.some((v, i) => i > 0 && v < t[i - 1] * 0.7);
}).length;
console.log(`出现过"回落"（=真的换了窗口）的会话数 = ${withDrops} / ${bridgeSessions.length}`);
