/**
 * 直接对比两个会话的 system/message 大小与内容差异 —— 换预设到底省了多少。
 *
 *   node tools/compare-sessions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dir =
  'C:\\Users\\30481\\.dsh\\sessions\\--D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--';
const CPT = 1.7;
const tok = (c) => Math.round(c / CPT);

function read(f) {
  const buf = fs.readFileSync(f);
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const st = [];
  for (let i = 0; i + 4 <= buf.length; ) {
    const a = buf.indexOf(M, i);
    if (a < 0) break;
    st.push(a);
    i = a + 4;
  }
  const cs = [];
  for (let k = 0; k < st.length; k += 1) {
    const e = k + 1 < st.length ? st[k + 1] : buf.length;
    try {
      cs.push(zlib.zstdDecompressSync(buf.subarray(st[k], e)));
    } catch {}
  }
  const ev = [];
  for (const l of Buffer.concat(cs).toString('utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      ev.push(JSON.parse(l));
    } catch {}
  }
  return ev;
}

function pick(sessionName) {
  const f = path.join(dir, sessionName, 'session.v4.jsonl.zstd');
  const ev = read(f);
  const head = ev.find((e) => e.type === 'session');
  let sys = null;
  for (const e of ev) {
    if (e.type !== 'system/message') continue;
    const t = (e?.data?.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!sys || t.length > sys.length) sys = t;
  }
  const ins = ev
    .filter((e) => e.type === 'assistant/message' && typeof e?.data?.usage?.inputTokens === 'number')
    .map((e) => e.data.usage.inputTokens);
  return { preset: head?.agentPreset ?? '(无)', sys, ins };
}

const OLD = 'session-9e3e7dad-ef90-4684-8aa1-7bd614a71d5c'; // standard
const NEW = 'session-46ec564c-ce7c-4beb-a99c-1e403c69042b'; // qq-hosted

const a = pick(OLD);
const b = pick(NEW);

console.log('=== 两个会话 ===');
console.log(`  ${OLD}  preset=${a.preset}  system=${a.sys.length} 字符 ≈${tok(a.sys.length)} token`);
console.log(`  ${NEW}  preset=${b.preset}  system=${b.sys.length} 字符 ≈${tok(b.sys.length)} token`);
console.log('');
const delta = a.sys.length - b.sys.length;
console.log(`  system 缩小：${delta} 字符 ≈ ${tok(delta)} token（${Math.round((100 * delta) / a.sys.length)}%）`);
console.log(`\n  首轮输入：standard ${a.ins[0]} → qq-hosted ${b.ins[0]}`);
console.log(`  （注意首轮还含历史，两者历史不同，别直接相减）`);

console.log('\n=== system message 里都有哪些段 ===');
for (const [label, s] of [['standard', a.sys], ['qq-hosted', b.sys]]) {
  console.log(`\n── ${label} ──`);
  const marks = [
    'You are an AI agent powered by DeepSeek Harness',
    'Your working directory is',
    'Tokens prefixed with @',
    '<tool',
    'tool',
  ];
  console.log('  前 400 字符：');
  console.log('  ' + s.slice(0, 400).replace(/\n/g, '\n  '));
  // 找工具清单的痕迹
  const toolish = s.match(/^[a-z_]{3,30}$/gm) ?? [];
  console.log(`  看起来像工具名的行数：${toolish.length}`);
  console.log('  样例：' + toolish.slice(0, 25).join(', '));
}
