/**
 * 表情包配图率统计
 *
 * 分开算两个不同的东西，因为它们乘在一起才是最终效果：
 *   抽中率 = 抽签抽到"要配图"的比例      ← 由 replyShapes 决定
 *   照做率 = 抽到之后模型真的写了标记的比例 ← 由模型决定
 *   实际配图率 = 抽中率 × 照做率
 *
 * 所以想拉到 66% 的实际配图率，抽签权重得按照做率反推。
 *
 * 用法：
 *   cd D:\Code\dsh-qq-bridge
 *   node tools/sticker-stats.mjs
 *   node tools/sticker-stats.mjs --dir "C:\Users\...\sessions\--xxx--"
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_DIR =
  'C:\\Users\\30481\\.dsh\\sessions\\--D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--';

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const dir = argOf('--dir', DEFAULT_DIR);
const limit = Number(argOf('--sessions', '12'));

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

const MARKER = /\[\s*(?:表情|sticker)\s*[:：]\s*(\d+)\s*\]/iu;
// 抽签把"配不配图"写在这两句话里，二选一
const WANT = /另外在最后单独一行配 1 张表情包/;
const DONT = /这条不要配表情包/;

const sessions = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(dir, d.name))
  .filter((d) => fs.existsSync(path.join(d, 'session.v4.jsonl.zstd')))
  .map((d) => ({ dir: d, mtime: fs.statSync(path.join(d, 'session.v4.jsonl.zstd')).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, limit);

let turns = 0;
let want = 0;
let dont = 0;
const byBubbles = {};
const numbers = [];
let replied = 0;

for (const s of sessions) {
  let events;
  try {
    events = readSessionLog(path.join(s.dir, 'session.v4.jsonl.zstd'));
  } catch {
    continue;
  }

  // 把 user 提示词和紧随其后的 assistant 回复配对
  const seq = [];
  for (const e of events) {
    if (e.type === 'user/message') {
      const t = (e.data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!t.includes('—— 现在这条消息 ——')) continue;
      seq.push({ k: 'u', t });
    } else if (e.type === 'assistant/message') {
      const t = (e.data.message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (t.trim()) seq.push({ k: 'a', t });
    }
  }

  for (let i = 0; i < seq.length; i += 1) {
    if (seq[i].k !== 'u') continue;
    turns += 1;
    if (WANT.test(seq[i].t)) want += 1;
    else if (DONT.test(seq[i].t)) dont += 1;
    const m = seq[i].t.match(/回 (\d) 个气泡/);
    if (m) byBubbles[m[1]] = (byBubbles[m[1]] ?? 0) + 1;
    const a = seq.slice(i + 1).find((x) => x.k === 'a');
    if (!a) continue;
    replied += 1;
    const mk = a.t.match(MARKER);
    if (mk) numbers.push(mk[1]);
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

console.log('============================================================');
console.log('  表情包配图率统计');
console.log('============================================================');
console.log('');
console.log(`  抽样会话 ${sessions.length} 个，有效轮数 ${turns}`);
console.log('');
console.log(`  抽到「要配图」  : ${want} 轮   (${pct(want, turns)})`);
console.log(`  抽到「不配图」  : ${dont} 轮   (${pct(dont, turns)})`);
console.log(`  实际带表情标记  : ${numbers.length} 轮   (${pct(numbers.length, turns)})`);
console.log('');
console.log(`  → 抽中率 = ${pct(want, turns)}`);
console.log(`  → 照做率 = ${pct(numbers.length, want)}   （抽到之后模型真的写标记的比例）`);
console.log(`  → 实际配图率 = 抽中率 × 照做率 = ${pct(numbers.length, turns)}`);
console.log('');
console.log('  气泡数分布（由 replyShapes 决定）:');
for (const k of Object.keys(byBubbles).sort()) {
  console.log(`    ${k} 个气泡 : ${byBubbles[k]} 轮   ${pct(byBubbles[k], turns)}`);
}
if (numbers.length) {
  const uniq = new Set(numbers);
  console.log('');
  console.log(`  用过的表情编号：${numbers.length} 次，${uniq.size} 个不同编号`);
  const tally = {};
  for (const n of numbers) tally[n] = (tally[n] ?? 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  最常用：${top.map(([n, c]) => `#${n}×${c}`).join('  ')}`);
}
console.log('');
console.log('  想反推抽签权重：目标实际配图率 ÷ 照做率 = 需要的抽中率');
