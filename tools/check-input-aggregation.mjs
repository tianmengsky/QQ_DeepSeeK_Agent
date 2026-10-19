/**
 * 只读诊断：输入聚合（把连续消息并成一次回答）实际有没有生效。
 *
 * 为什么要单独量它：`input-batches` 的聚合只有「时间窗 + 正则」，
 * 没有语义层。status 只报 inputsCoalesced 一个累计数，看不出
 * 「本该合却没合」的比例，也看不出"agent 回复一大堆"是谁造成的。
 *
 * 三个口径（都由 executions.data.inputEvents 这一份事实推导，避免口径漂移）：
 *   1. 回合携带的输入条数分布 → 真正聚合过的回合占比
 *   2. 落在 debounce 窗口内的相邻输入是否同回合 → 机制本身准不准
 *   3. 同会话相邻回合、不同作者、间隔<30s 的"连环提问簇" → 本可少发几次回复
 *
 * 用法：node tools/check-input-aggregation.mjs   （只读，不写库、不发消息）
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const file = resolveBridgeDb();
if (!file) { console.error('找不到桥接数据库；可用 QQ_BRIDGE_DB 显式指定。'); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const WINDOW_MS = 3500;   // = inputShortDebounceMs（≤40 字消息）
const CLUSTER_MS = 30000; // "连环提问"的观察半径

console.log('库：' + file + '\n');

const execs = all('SELECT id,conversation,owner,data FROM bridge_executions').flatMap((r) => {
  try { return [{ id: r.id, conversation: r.conversation, owner: String(r.owner), d: JSON.parse(r.data) }]; } catch { return []; }
});
const info = execs.map((e) => {
  const ins = (e.d.inputEvents ?? []).filter((x) => !x.__inputPassive);
  return { id: e.id, conversation: e.conversation, readOnly: Boolean(e.d.readOnly), d: e.d,
    route: e.d.route?.action ?? null, n: ins.length,
    authors: [...new Set(ins.map((x) => String(x.user_id)))],
    at: ins.length ? Math.min(...ins.map((x) => Number(x.__receivedAt ?? Infinity))) : Infinity };
}).filter((e) => e.n > 0 && Number.isFinite(e.at));
const work = info.filter((e) => !e.readOnly);

console.log('=== 1. 每个回合携带几条输入（>1 才算真的聚合了） ===');
const dist = new Map();
for (const e of work) dist.set(e.n, (dist.get(e.n) ?? 0) + 1);
for (const [n, c] of [...dist].sort((a, b) => a[0] - b[0])) console.log(`带回 ${n} 条 → ${c} 个回合`);
const merged = work.filter((e) => e.n > 1).length;
console.log(`聚合过的回合 ${merged}/${work.length} = ${work.length ? ((merged / work.length) * 100).toFixed(1) : 0}%` +
  `；平均 ${work.length ? (work.reduce((a, e) => a + e.n, 0) / work.length).toFixed(2) : 0} 条/回合\n`);

console.log(`=== 2. 相邻输入落在 ${WINDOW_MS}ms 窗口内，是否落进同一回合（机制准不准） ===`);
const byConv = new Map();
for (const e of work) (byConv.get(e.conversation) ?? byConv.set(e.conversation, []).get(e.conversation)).push(e);
let pairs = 0, same = 0, auPairs = 0, auSame = 0;
for (const [conv, list] of byConv) {
  const ins = list.flatMap((e) => (e.d.inputEvents ?? []).filter((x) => !x.__inputPassive)
    .map((x) => ({ exec: e.id, user: String(x.user_id), at: Number(x.__receivedAt ?? Infinity) })))
    .filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  let cp = 0, cs = 0;
  for (let i = 1; i < ins.length; i++) {
    const gap = ins[i].at - ins[i - 1].at;
    if (gap < 0 || gap >= WINDOW_MS) continue;
    pairs++; cp++;
    if (ins[i].exec === ins[i - 1].exec) { same++; cs++; }
    if (ins[i].user === ins[i - 1].user) { auPairs++; if (ins[i].exec === ins[i - 1].exec) auSame++; }
  }
  console.log(String(conv).padEnd(20), `窗口内 ${String(cp).padEnd(3)} 对 → 同回合 ${cs}`);
}
console.log(`全部 ${pairs} 对 → 同回合 ${same}（${pairs ? ((same / pairs) * 100).toFixed(1) : 0}%）；` +
  `同作者 ${auPairs} 对 → 同回合 ${auSame}（${auPairs ? ((auSame / auPairs) * 100).toFixed(1) : 0}%）\n`);

console.log(`=== 3. 同会话相邻回合、不同作者、间隔<${CLUSTER_MS / 1000}s 的连环提问簇 ===`);
console.log('   （含只读 clarify/query 回合：它们同样会发一条消息，所以也算一次回答）');
let clusters = 0, turns = 0, wasted = 0;
const allByConv = new Map();
for (const e of info) (allByConv.get(e.conversation) ?? allByConv.set(e.conversation, []).get(e.conversation)).push(e);
for (const [conv, list] of allByConv) {
  list.sort((a, b) => a.at - b.at);
  let run = [];
  const flush = () => {
    if (run.length > 1 && new Set(run.flatMap((e) => e.authors)).size > 1) {
      clusters++; turns += run.length; wasted += run.length - 1;
      console.log(String(conv).padEnd(20), `${run.length} 回合 / ${new Set(run.flatMap((e) => e.authors)).size} 作者 / ` +
        `${((run.at(-1).at - run[0].at) / 1000).toFixed(1)}s：` + run.map((e) => e.route).join(' → '));
    }
    run = [];
  };
  for (const e of list) { if (run.length && e.at - run.at(-1).at >= CLUSTER_MS) flush(); run.push(e); }
  flush();
}
console.log(`\n连环簇 ${clusters} 个 / ${turns} 个回合 → 若合并本可少发 ${wasted} 次回复`);
const bubbles = all('SELECT plan FROM bridge_replies WHERE plan IS NOT NULL')
  .flatMap((r) => { try { return [(JSON.parse(r.plan).bubbles ?? []).length]; } catch { return []; } });
if (bubbles.length) {
  const avg = bubbles.reduce((a, b) => a + b, 0) / bubbles.length;
  console.log(`每回合平均 ${avg.toFixed(2)} 个气泡 → 约 ${Math.round(wasted * avg)} 个多余气泡`);
}

console.log('\n=== 附带：只读澄清/查询回合占比（clarify 低置信度时最容易连环） ===');
const clar = info.filter((e) => e.route === 'clarify').length;
const query = info.filter((e) => e.route === 'query').length;
console.log(`全部带回输入的回合 ${info.length}：clarify ${clar}、query ${query}、其余 ${info.length - clar - query}`);
let runs = 0, longest = 0;
for (const [, list] of allByConv) {
  list.sort((a, b) => a.at - b.at);
  let run = 0;
  for (let i = 0; i < list.length; i++) {
    const consecutive = i > 0 && list[i].at - list[i - 1].at < CLUSTER_MS && list[i].route === list[i - 1].route
      && ['clarify', 'query'].includes(list[i].route);
    run = consecutive ? run + 1 : 1;
    if (['clarify', 'query'].includes(list[i].route) && run >= 3) { if (run === 3) runs++; longest = Math.max(longest, run); }
  }
}
console.log(`连续 ≥3 次只读澄清/查询的串 ${runs} 个，最长 ${longest} 连`);
