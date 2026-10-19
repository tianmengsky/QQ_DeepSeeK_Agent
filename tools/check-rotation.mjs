/**
 * 诊断 rotateEveryTurns 到底有没有生效。
 *
 *   node tools/check-rotation.mjs [会话目录]
 *
 * 判据：
 *   · 如果轮换在生效，应该看到"同一个会话被复用 10 轮，然后换一个新的"，
 *     也就是每个会话目录里的桥接轮数接近 rotateEveryTurns，输入 token 呈锯齿形。
 *   · 如果每个会话目录只有 1~2 轮、目录却在短时间内成片出现，
 *     说明计数被反复清零（通常是插件重载重建了 registry）—— 轮换等于没生效，
 *     DSH 侧历史会一路涨上去。
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

/** 从 profile 读 rotateEveryTurns。 */
function readRotation() {
  const f = path.join(
    process.env.USERPROFILE ?? '',
    '.dsh',
    'profiles',
    'desktop',
    'cordis.patch.yml',
  );
  try {
    const m = fs.readFileSync(f, 'utf8').match(/^\s*rotateEveryTurns:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const configured = readRotation();
console.log(`profile 里配的 rotateEveryTurns = ${configured ?? '(读不到)'}\n`);

const sessions = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const f = path.join(dir, d.name, 'session.v4.jsonl.zstd');
    return { name: d.name, file: f, created: fs.existsSync(f) ? fs.statSync(f).birthtimeMs : 0, mtime: fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0 };
  })
  .filter((s) => fs.existsSync(s.file))
  .sort((a, b) => a.created - b.created);

/** 每个会话里桥接轮数（用「现在这条消息」计数）。 */
function bridgeTurns(file) {
  let events;
  try {
    events = readSessionLog(file);
  } catch {
    return { turns: 0, firstIn: null, lastIn: null };
  }
  const users = events.filter((e) => e.type === 'user/message');
  let turns = 0;
  for (const u of users) {
    const t = (u.data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (t.includes('—— 现在这条消息 ——')) turns += 1;
  }
  const ins = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const v = e?.data?.usage?.inputTokens ?? e?.data?.usage?.input_tokens;
    if (typeof v === 'number') ins.push(v);
  }
  return { turns, firstIn: ins[0] ?? null, lastIn: ins.at(-1) ?? null };
}

console.log(`共 ${sessions.length} 个会话目录（按创建时间排序，只列今天的）\n`);
const today = new Date();
today.setHours(0, 0, 0, 0);

let shown = 0;
let prevCreated = 0;
const gaps = [];
for (const s of sessions) {
  if (s.created < today.getTime()) continue;
  const info = bridgeTurns(s.file);
  if (!info.turns) continue;
  const created = new Date(s.created);
  const gapMin = prevCreated ? (s.created - prevCreated) / 60000 : null;
  if (gapMin !== null) gaps.push(gapMin);
  prevCreated = s.created;
  shown += 1;
  console.log(
    `  ${created.toLocaleTimeString('zh-CN')}  桥接轮数=${String(info.turns).padStart(2)}` +
      `  首轮输入=${String(info.firstIn ?? '?').padStart(6)}  末轮=${String(info.lastIn ?? '?').padStart(6)}` +
      `   距上一个会话=${gapMin === null ? '—' : `${gapMin.toFixed(1)}分`}`,
  );
}

console.log(`\n今天有桥接内容的会话数 = ${shown}`);
if (gaps.length) {
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const short = gaps.filter((g) => g < 3).length;
  console.log(`相邻会话平均间隔 = ${avg.toFixed(1)} 分钟；间隔 < 3 分钟的有 ${short} / ${gaps.length} 次`);
  console.log(
    short > gaps.length / 2
      ? '  ⚠ 大多数会话是"短时间内成片新建"的 —— 这不是"聊满 N 轮后轮换"，\n' +
          '     而是计数被反复清零（插件重载会重建 registry）。轮换实际上没在起作用。'
      : '  · 会话间隔较分散，看起来是正常轮换/新对话。',
  );
}
