/**
 * 按预设分组统计桥接会话的**首轮输入 token**，用来量 agentPreset 的实际效果。
 *
 *   node tools/measure-preset.mjs [会话目录]
 *
 * 为什么要按首轮比：首轮 = 固定开销（system prompt + 工具 schema + 人设）
 * + 很少的历史。比"平均每轮"干净得多 —— 后者混了对话长度差异。
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
    return { name: d.name, file: f, created: fs.existsSync(f) ? fs.statSync(f).birthtimeMs : 0 };
  })
  .filter((s) => fs.existsSync(s.file))
  .sort((a, b) => a.created - b.created);

const rows = [];
for (const s of sessions) {
  let events;
  try {
    events = readSessionLog(s.file);
  } catch {
    continue;
  }
  /**
   * 预设 ID 在 `session` 事件的**顶层**字段 `agentPreset`。
   *
   * 注意别把它和 `permission/preset` 搞混 —— 后者是权限预设
   * （workspace-write / danger-full-access），完全是另一回事。
   * 我第一版就取错了字段，结果是所有会话都算成同一组，白测一轮。
   */
  const head = events.find((e) => e.type === 'session');
  const preset = head?.agentPreset ?? '(无)';

  /** system/message 里装着 system prompt + 工具 schema —— 固定开销就在这。 */
  let systemChars = null;
  for (const e of events) {
    if (e.type !== 'system/message') continue;
    const blocks = e?.data?.message?.content;
    if (!Array.isArray(blocks)) continue;
    const chars = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text?.length ?? 0)
      .reduce((a, b) => a + b, 0);
    if (systemChars === null || chars > systemChars) systemChars = chars;
  }

  const ins = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    const v = e?.data?.usage?.inputTokens;
    if (typeof v === 'number') ins.push(v);
  }
  if (!ins.length) continue;
  const turns = events.filter((e) => {
    if (e.type !== 'user/message') return false;
    const t = (e.data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return t.includes('—— 现在这条消息 ——');
  }).length;
  rows.push({
    name: s.name.slice(0, 20),
    created: new Date(s.created).toLocaleTimeString('zh-CN'),
    preset,
    turns,
    first: ins[0],
    last: ins.at(-1),
    systemChars,
  });
}

console.log(`桥接会话 ${rows.length} 个\n`);
console.log('  创建时间   预设          轮数   首轮输入   system字符   会话');
console.log('  ────────────────────────────────────────────────────────────────');
for (const r of rows) {
  console.log(
    `  ${r.created}  ${r.preset.padEnd(12)} ${String(r.turns).padStart(4)} ${String(
      r.first,
    ).padStart(9)} ${String(r.systemChars ?? '?').padStart(11)}   ${r.name}`,
  );
}

/** 按预设分组算首轮均值。 */
const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.preset)) groups.set(r.preset, []);
  groups.get(r.preset).push(r);
}
console.log('\n  按预设分组：');
console.log('    预设            会话数   首轮均值   system 字符均值');
console.log('    ──────────────────────────────────────────────────');
for (const [preset, arr] of [...groups.entries()].sort(
  (a, b) =>
    a[1].reduce((x, y) => x + y.first, 0) / a[1].length -
    b[1].reduce((x, y) => x + y.first, 0) / b[1].length,
)) {
  const avgFirst = Math.round(arr.reduce((x, y) => x + y.first, 0) / arr.length);
  const withSys = arr.filter((r) => r.systemChars);
  const avgSys = withSys.length
    ? Math.round(withSys.reduce((x, y) => x + y.systemChars, 0) / withSys.length)
    : null;
  console.log(
    `    ${preset.padEnd(14)} ${String(arr.length).padStart(5)} ${String(avgFirst).padStart(10)} ${String(
      avgSys ?? '?',
    ).padStart(15)}`,
  );
}
console.log(
  '\n  注：首轮 = system prompt + 工具 schema + 人设 + 少量历史。' +
    '\n      system 字符里装着 system prompt 和工具 schema，两组之差就是换预设省下的固定开销。',
);

