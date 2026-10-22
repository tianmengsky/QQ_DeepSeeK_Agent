/**
 * 只读诊断：输入重叠的影子读数。
 *
 * 桥接在每次真实回合结束时记一条影子样本（只记录，不改变发送时机）：
 *   · savedMs —— 若"第一条就到点开跑、仍守在窗口后发"，能提前多少
 *   · heldMs  —— 生成比窗口快时，要扣着不发多久（抢答风险的度量）
 *   · late    —— 生成期间又到了几条消息（重叠时需要合并或留给下一轮）
 *
 * 这些样本来自 InputBatches.recordShadow()，存在 runtime_state 的
 * `qq-bridge:input:<会话>` 里。本脚本只读打开 SQLite，不写库、不发消息。
 *
 * 用法：node tools/check-overlap-gain.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const file = resolveBridgeDb();
if (!file) {
  console.error('找不到桥接数据库；可用 QQ_BRIDGE_DB 显式指定。');
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const pct = (xs, p) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
const ms = (v) => (v == null ? '—' : Math.round(v) + 'ms');
const secs = (v) => (v == null ? '—' : (v / 1000).toFixed(2) + 's');

console.log('库：' + file + '\n');

const rows = db.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'qq-bridge:input:%'").all();
const byConversation = [];
for (const row of rows) {
  let state;
  try { state = JSON.parse(row.value); } catch { continue; }
  const samples = Array.isArray(state?.shadow) ? state.shadow : [];
  if (!samples.length) continue;
  byConversation.push({ conversation: row.key.replace('qq-bridge:input:', ''), samples });
}
const all = byConversation.flatMap((c) => c.samples)
  .map((s) => ({ saved: Number(s.savedMs) || 0, held: Number(s.heldMs) || 0, late: Number(s.late) || 0,
    gen: Number(s.genMs) || 0, wait: Number(s.waitMs) || 0, queue: Number(s.queueMs) || 0 }))
  .sort((a, b) => a.wait - b.wait);

if (!all.length) {
  console.log('还没有影子样本。');
  console.log('原因通常是：插件重载后还没有跑过真实回合，或所有回合都走了任务准入/被拒。');
  console.log('等几条自然消息再看；不需要打开任何开关。');
  process.exit(0);
}

const pick = (field, p) => pct(all.map((s) => s[field]).sort((a, b) => a - b), p);
const avg = (field) => Math.round(all.reduce((n, s) => n + s[field], 0) / all.length);
const savedCount = all.filter((s) => s.saved > 0).length;
const heldCount = all.filter((s) => s.held > 0).length;
const lateSamples = all.filter((s) => s.late > 0);

console.log(`样本 ${all.length} 条，来自 ${byConversation.length} 个会话。\n`);
console.log('=== 能省多少（savedMs） ===');
console.log(`p50=${ms(pick('saved', 0.5))}  p90=${ms(pick('saved', 0.9))}  平均=${ms(avg('saved'))}  有收益的样本=${savedCount}/${all.length}`);
console.log('\n=== 实际付掉的窗口 / 生成耗时 ===');
console.log(`窗口 waitMs  p50=${ms(pick('wait', 0.5))}  生成 genMs  p50=${ms(pick('gen', 0.5))}`);
console.log('\n=== 串行等待（上一轮没跑完） ===');
console.log(`queueMs p50=${ms(pick('queue', 0.5))}  p90=${ms(pick('queue', 0.9))}  有排队的样本=${all.filter((s) => s.queue > 0).length}/${all.length}`);
console.log('\n=== 抢答风险（heldMs：生成完了但要扣着不发） ===');
console.log(`p50=${ms(pick('held', 0.5))}  p90=${ms(pick('held', 0.9))}  出现过扣留的样本=${heldCount}/${all.length}`);
console.log('\n=== 生成期间又来的消息（late） ===');
console.log(`含新消息的样本=${lateSamples.length}/${all.length}  合计 ${all.reduce((n, s) => n + s.late, 0)} 条`);

if (heldCount > all.length * 0.3)
  console.log('\n⚠️ 超过三成回合会出现"生成完了要等窗口"。说明窗口对体感的影响真实存在，重叠方案值得做，但要保留窗口。');
if (lateSamples.length > all.length * 0.3)
  console.log('⚠️ 生成期间常有新消息——真正打开重叠时，必须处理"合并进当前回合 / 留给下一轮"，不能简单丢弃。');
if (pick('saved', 0.5) > 1000)
  console.log('\n结论：中位可省 >1s，值得进入影子后的下一步（先小范围打开）。');
else
  console.log('\n结论：可省时间有限，先别动窗口；继续收集样本。');

console.log('\n=== 按会话（最近一条） ===');
for (const { conversation, samples } of byConversation.sort((a, b) => b.samples.length - a.samples.length).slice(0, 10)) {
  const last = samples[samples.length - 1];
  console.log(
    String(conversation).padEnd(20),
    '样本=' + String(samples.length).padEnd(3),
    '最近：省 ' + secs(last.savedMs),
    '扣 ' + secs(last.heldMs),
    '窗口 ' + secs(last.waitMs),
    '排队 ' + secs(last.queueMs),
    '生成 ' + secs(last.genMs),
    'late=' + (last.late ?? 0),
  );
}
console.log('\n口径：savedMs = 完成时刻 - max(截止时刻, 首条到达 + 生成耗时)；只记录，不改变发送时机。');
