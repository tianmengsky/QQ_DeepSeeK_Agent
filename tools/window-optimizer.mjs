/**
 * 窗口长度优化器
 *
 * 问题：会话窗口（rotateEveryTurns）开多少轮最省 token？
 *
 * 两股力量在拉扯：
 *   窗口越短 → 静态块（人设+规则+表情目录）被重复注入得越频繁 → 贵
 *   窗口越长 → 会话历史在上下文里堆得越高       → 贵
 * 所以存在一个最优值。
 *
 * 模型（一次窗口 N 轮，静态块 S 只在第 1 轮注入，动态内容每轮 D，回复每轮 A）：
 *
 *   第 k 轮的输入 ≈ S + (k-1)(D+A) + D
 *   窗口合计      = N·S + N·D + (D+A)·N(N-1)/2
 *   摊到每轮      = S/N + D + (D+A)(N-1)/2
 *
 *   求极值：d/dN = -S/N² + (D+A)/2 = 0  →  N* = sqrt( 2S / (D+A) )
 *
 * ⚠️ 上面这个**不含缓存**，会高估短窗口的好处。真实计费里：
 *   · 历史前缀命中 prompt cache，只按 cacheRate（DeepSeek 约 0.1）计价
 *   · 但每轮新加的内容是全价
 *   · **换窗口 = 全新前缀 = 缓存全失效**，那一轮的人设要全价重算
 *
 * 所以脚本默认按缓存感知的模型算（见 estimate()），并且把两种口径都打印出来，
 * 让你看到缓存把最优值往长窗口那边推了多少。
 *
 * 用法：
 *   cd D:\Code\dsh-qq-bridge
 *   node tools/window-optimizer.mjs --measure        # 从真实会话日志量 S / D / A
 *   node tools/window-optimizer.mjs --cacheRate 0    # 假设没有缓存
 *   node tools/window-optimizer.mjs --S 5500 --D 690 --A 26
 *   node tools/window-optimizer.mjs --current 10     # 手动指定"当前配了几轮"
 *
 * 「当前配了几轮」默认从 profile 的 cordis.patch.yml 里读 rotateEveryTurns，
 * 不再写死 —— 之前写死成 4，而实际配的是 10，结论里那句"当前配的 4 轮贵 23%"
 * 是错的，会把人带偏。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_SESSIONS =
  'C:\\Users\\30481\\.dsh\\sessions\\--D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--';

/** 中文按 1.7 字/token 粗估。用真实 usage 校准过就在输出里说明。 */
const CHARS_PER_TOKEN = 1.7;
const tok = (chars) => Math.round(chars / CHARS_PER_TOKEN);

// ---------------------------------------------------------------- 读会话日志

/** 会话日志是多帧 zstd，必须按魔数切开逐帧解，否则只能读到第一帧。 */
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
      /* 半截帧跳过 */
    }
  }
  const events = [];
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 忽略坏行 */
    }
  }
  return events;
}

/** 从最近的会话里量出静态块 / 动态内容 / 回复各自的字符数。 */
function measure(dir) {
  const sessions = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
    .filter((d) => fs.existsSync(path.join(d, 'session.v4.jsonl.zstd')))
    .map((d) => ({
      dir: d,
      mtime: fs.statSync(path.join(d, 'session.v4.jsonl.zstd')).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const staticChars = [];
  const dynamicChars = [];
  const replyChars = [];

  for (const s of sessions.slice(0, 12)) {
    let events;
    try {
      events = readSessionLog(path.join(s.dir, 'session.v4.jsonl.zstd'));
    } catch {
      continue;
    }
    const users = events.filter((e) => e.type === 'user/message');
    const replies = events.filter((e) => e.type === 'assistant/message');

    for (const u of users) {
      const text = (u.data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text.includes('—— 现在这条消息 ——')) continue; // 跳过 DSH 内部消息

      // 静态块 = 人设头 到 「怎么说话」 之间
      const a = text.indexOf('[你的人设]');
      const b = text.indexOf('【怎么说话】');
      if (a >= 0 && b > a) staticChars.push(b - a);

      // 动态部分 = 去掉静态块之后剩下的
      const dyn = a >= 0 && b > a ? text.slice(0, a).length + text.slice(b).length : text.length;
      dynamicChars.push(dyn);
    }
    for (const r of replies) {
      const text = (r.data.message.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim()) replyChars.push(text.length);
    }
  }

  const avg = (arr, fallback) =>
    arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : fallback;

  return {
    S: tok(avg(staticChars, 9000)),
    D: tok(avg(dynamicChars, 1400)),
    A: tok(avg(replyChars, 170)),
    samples: {
      静态块: staticChars.length,
      动态: dynamicChars.length,
      回复: replyChars.length,
    },
  };
}

// ---------------------------------------------------------------- 优化计算

/** 无缓存口径：每轮把整个前缀全价重发。 */
function perTurnCost(N, S, D, A) {
  return S / N + D + ((D + A) * (N - 1)) / 2;
}

/**
 * 缓存感知口径。
 *
 * 一次窗口 N 轮：
 *   第 1 轮 —— 全新前缀，S 和 D 都全价（换窗口导致缓存失效，这是短窗口的隐性成本）
 *   第 k 轮 —— 之前的内容都在缓存里，按 cacheRate 计价；只有本轮新加的 D 是全价
 *
 * 返回摊到每轮的"等效全价 token"，可以直接和上面的口径比大小。
 */
function perTurnCostCached(N, S, D, A, cacheRate) {
  let total = S + D; // 第 1 轮：全价
  for (let k = 2; k <= N; k += 1) {
    const prefix = S + (k - 1) * (D + A);
    total += cacheRate * prefix + D;
  }
  return total / N;
}

/** 窗口合计（T 轮里每个窗口的总成本之和，再摊到每轮）。 */
function scan(S, D, A, cacheRate, maxN = 60) {
  const rows = [];
  for (let N = 1; N <= maxN; N += 1) {
    rows.push({
      N,
      perTurn: perTurnCost(N, S, D, A),
      cached: perTurnCostCached(N, S, D, A, cacheRate),
    });
  }
  const bestPlain = rows.reduce((m, r) => (r.perTurn < m.perTurn ? r : m), rows[0]);
  const bestCached = rows.reduce((m, r) => (r.cached < m.cached ? r : m), rows[0]);
  return { rows, bestPlain, bestCached };
}

/** 从 profile 里读出实际配的 rotateEveryTurns（不再写死）。 */
function readCurrentRotation() {
  const candidates = [
    path.join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    path.join(process.cwd(), 'cordis.patch.yml'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const m = text.match(/^\s*rotateEveryTurns:\s*(\d+)/m);
      if (m) return { value: Number(m[1]), from: file };
    } catch {
      /* 换下一个 */
    }
  }
  return { value: 10, from: '(没找到 profile，用默认 10)' };
}

// ---------------------------------------------------------------- 主程序

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : undefined;
};

const dir = (() => {
  const i = argv.indexOf('--dir');
  return i >= 0 ? argv[i + 1] : DEFAULT_SESSIONS;
})();

let S = arg('--S');
let D = arg('--D');
let A = arg('--A');
let measured = null;

if (argv.includes('--measure') || S === undefined) {
  try {
    measured = measure(dir);
    S = S ?? measured.S;
    D = D ?? measured.D;
    A = A ?? measured.A;
  } catch (error) {
    console.log(`量不了会话日志（${error.message}），改用默认估计值。`);
    S = S ?? 5500;
    D = D ?? 800;
    A = A ?? 100;
  }
}

const theory = Math.sqrt((2 * S) / (D + A));
const cacheRate = arg('--cacheRate') ?? 0.1;
const { rows, bestPlain, bestCached } = scan(S, D, A, cacheRate);

console.log('============================================================');
console.log('  会话窗口长度优化');
console.log('============================================================');
console.log('');
if (measured) {
  console.log(`  实测样本：${JSON.stringify(measured.samples)}`);
  console.log('  （静态块按「[你的人设] → 【怎么说话】」量；动态按剩余部分量）');
  console.log('');
}
console.log(`  静态块 S = ${S} token   （人设 + 规则 + 表情目录，每个窗口注入一次）`);
console.log(`  动态   D = ${D} token   （记忆 + 滑动窗口 + 当前消息，每轮都有）`);
console.log(`  回复   A = ${A} token   （它自己说过的话，会留在历史里）`);
console.log(`  缓存折扣 = ${cacheRate}   （DeepSeek 命中缓存约 1/10 价；0 = 假设没有缓存）`);
console.log('');
console.log(`  理论公式（无缓存）N* = sqrt(2S/(D+A)) = ${theory.toFixed(1)} 轮`);
console.log('');
console.log('  ┌─ 两种口径给出的最优值 ──────────────────────────────');
console.log(`  │ 无缓存口径   : ${bestPlain.N} 轮   每轮等效 ${Math.round(bestPlain.perTurn)} token`);
console.log(`  │ 缓存感知口径 : ${bestCached.N} 轮   每轮等效 ${Math.round(bestCached.cached)} token`);
console.log('  │');
console.log('  │ 缓存把最优值往**长窗口**推 —— 因为换窗口会让缓存全部失效，');
console.log('  │ 短窗口省下的历史，还不够付重新建立缓存的代价。');
console.log('  └──────────────────────────────────────────────────────');
console.log('');

const showN = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50];
console.log('  窗口   无缓存/轮   缓存感知/轮    vs 缓存最优');
console.log('  ───────────────────────────────────────────────');
for (const r of rows) {
  if (!showN.includes(r.N)) continue;
  const mark = r.N === bestCached.N ? '  ◀ 最优' : '';
  const delta =
    r.N === bestCached.N
      ? ''
      : `+${Math.round(100 * (r.cached / bestCached.cached - 1))}%`;
  console.log(
    `  ${String(r.N).padStart(4)}  ${String(Math.round(r.perTurn)).padStart(10)}  ${String(
      Math.round(r.cached),
    ).padStart(12)}  ${delta.padStart(12)}${mark}`,
  );
}

console.log('');
const current = arg('--current') ?? readCurrentRotation().value;
const curCached = perTurnCostCached(current, S, D, A, cacheRate);
const curPlain = perTurnCost(current, S, D, A);
console.log('  结论：');
console.log(
  `    · 无缓存假设下最优 ${bestPlain.N} 轮，缓存感知下最优 ${bestCached.N} 轮。`,
);
const deltaPct = Math.round(100 * (curCached / bestCached.cached - 1));
console.log(
  `    · 当前配的 ${current} 轮：无缓存口径 ${Math.round(curPlain)}，缓存口径 ${Math.round(curCached)}` +
    (deltaPct === 0
      ? '（正好在最优上）。'
      : `（比缓存最优贵 ${deltaPct}%）。`),
);
if (deltaPct !== 0) {
  const target = bestCached.N;
  console.log(
    `      改成 ${target} 轮每轮约省 ${Math.round(curCached - bestCached.cached)} token` +
      `（约 ${deltaPct}%）。`,
  );
}
console.log('    · 缓存折扣调成 0 看"最坏情况"，调成 0.1 看 DeepSeek 的常态。');
console.log('');
console.log('  ⚠️ 这个模型只算「人设+记忆+窗口」那部分，**不含工具 schema 和 DSH 的');
console.log('     system prompt**。实测后者在 QQ 会话里能占到每轮输入的 2/3 以上 ——');
console.log('     想省大钱去削减 QQ 会话挂的工具（agentPreset），比调窗口有效得多。');
console.log('     用 node tools/tool-cost.mjs 量具体数额。');
console.log('');
console.log('  两个参数的关系（容易搞混）：');
console.log('    rotateEveryTurns  多久清一次会话历史  ← 本脚本优化的对象');
console.log('    windowTurns       它记得最近多少轮对话 ← 独立，调短窗口不会让它失忆');
console.log('    桥接每轮都把滑动窗口重新拼进提示词，所以换会话不会丢上下文。');
