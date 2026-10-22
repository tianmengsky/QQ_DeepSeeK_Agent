/**
 * 只读诊断：每个回合的"首字延迟"（TTFT）与总时长。
 *
 * 为什么要单独有这个工具：`status.lastTurn` 只有一个总时长，看不出时间花在哪。
 * 从真实 DSH 会话日志里把 `turn/start → 第一条 assistant 正文` 抠出来，
 * 就能区分两种情况：
 *   · 首字就很慢（TTFT 高、正文很短）→ 供应商/线路/提示词预填充问题，换模型或换线有救；
 *   · 首字很快但总时长很长 → 模型在写长文或反复调工具，是另一类问题。
 *
 * 2026-10-21 用它量 a6api 的真实 QQ 回合：输出只有 27~35 字，
 * TTFT 却是 4.5s / 5.9s / 8.9s / 12.0s —— 时间全在等首字。
 *
 * 用法：node tools/check-turn-latency.mjs <Session 目录或 session.v4.jsonl.zstd>
 * 只读文件，不连 DSH、不写库。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.argv[2];
if (!root) {
  console.error('用法: node tools/check-turn-latency.mjs <Session 目录或 session.v4.jsonl.zstd>');
  process.exit(1);
}
const file = fs.statSync(root).isDirectory() ? path.join(root, 'session.v4.jsonl.zstd') : root;
const bytes = fs.readFileSync(file);
const chunks = [];
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
for (let cursor = 0; cursor < bytes.length;) {
  const start = bytes.indexOf(magic, cursor);
  if (start < 0) break;
  const end = bytes.indexOf(magic, start + 4);
  try { chunks.push(zlib.zstdDecompressSync(bytes.subarray(start, end < 0 ? undefined : end))); }
  catch { /* 正在写入的半帧不作为完整记录 */ }
  cursor = end < 0 ? bytes.length : end;
}
const events = Buffer.concat(chunks).toString('utf8').split('\n')
  .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
  .filter((e) => Number.isFinite(e?.time))
  .sort((a, b) => a.seq - b.seq);

const textOf = (e) => (e?.data?.message?.content ?? []).filter((p) => p.type === 'text')
  .map((p) => p.text ?? '').join('');
const turns = new Map();
for (const event of events) {
  const turn = event?.data?.turn;
  if (turn == null) continue;
  const t = turns.get(turn) ?? { turn, startedAt: null, firstTextAt: null, endedAt: null, chars: 0, toolCalls: 0, steps: 0 };
  if (event.type === 'turn/start') t.startedAt = event.time;
  else if (event.type === 'assistant/message' && textOf(event).trim()) {
    if (t.firstTextAt == null) t.firstTextAt = event.time;
    t.chars += textOf(event).trim().length;
  } else if (event.type === 'tool/call') t.toolCalls++;
  else if (event.type === 'step/start') t.steps++;
  else if (event.type === 'turn/end') t.endedAt = event.time;
  turns.set(turn, t);
}

const rows = [...turns.values()].filter((t) => t.startedAt && t.firstTextAt).sort((a, b) => a.turn - b.turn);
if (!rows.length) {
  console.log('这个会话里没有可测量的回合（缺少 turn/start 或正文）。');
  process.exit(0);
}
const ttfts = rows.map((t) => t.firstTextAt - t.startedAt).sort((a, b) => a - b);
const totals = rows.filter((t) => t.endedAt).map((t) => t.endedAt - t.startedAt).sort((a, b) => a - b);
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
const s = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + 's');

console.log('会话：' + file);
console.log(`可测回合 ${rows.length} 个\n`);
console.log('回合   首字      总时长    正文   工具  步数');
for (const t of rows.slice(-15)) {
  const ttft = t.firstTextAt - t.startedAt;
  const total = t.endedAt ? t.endedAt - t.startedAt : null;
  console.log(
    String(t.turn).padEnd(5),
    s(ttft).padEnd(9),
    s(total).padEnd(9),
    String(t.chars).padEnd(5),
    String(t.toolCalls).padEnd(5),
    String(t.steps),
  );
}
console.log(`\n首字 p50=${s(pct(ttfts, 0.5))}  p90=${s(pct(ttfts, 0.9))}`);
console.log(`总时长 p50=${s(pct(totals, 0.5))}  p90=${s(pct(totals, 0.9))}`);
const short = rows.filter((t) => t.chars > 0 && t.chars <= 60);
if (short.length >= 2) {
  const shortTtft = short.map((t) => t.firstTextAt - t.startedAt).sort((a, b) => a - b);
  console.log(`\n正文 ≤60 字的回合 ${short.length} 个：首字 p50=${s(pct(shortTtft, 0.5))}。` +
    ' 如果这个数很高，时间花在等模型开口，不在生成。');
}
console.log('\n口径：首字 = 同一 turn 的第一条含正文 assistant/message；只读日志，不连 DSH。');
