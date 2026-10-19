/**
 * 只读诊断：投递恢复通道的健康度。
 *
 * 为什么需要单独一个工具：这个通道出过一次**自维持死循环**和一次**迟到投递事故**
 * （详见 HANDOFF：4 天前的回复被当成"现在该说的话"发进真实群）。两者的共同征兆
 * 都是"pending 列表里堆着很旧的行"，而 status 只给一个计数，看不出年龄分层。
 *
 * 用法：node tools/check-recovery-health.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const file = resolveBridgeDb();
if (!file) { console.error('找不到桥接数据库；可用 QQ_BRIDGE_DB 显式指定。'); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const now = Date.now();
const hrs = (ms) => (ms / 3600000).toFixed(1) + 'h';

console.log('库：' + file + '\n');

console.log('=== reply 行状态分布 ===');
for (const r of all('SELECT state,COUNT(*) n FROM bridge_replies GROUP BY state ORDER BY n DESC'))
  console.log('  ' + String(r.state).padEnd(12), r.n);

console.log('\n=== 未了结的行（含年龄分层；>10h 即"可能变成迟到投递"） ===');
const open = all("SELECT id,conversation,state,attempts,retry_at,created_at,detail FROM bridge_replies WHERE state NOT IN ('done') ORDER BY created_at");
if (!open.length) console.log('  （无）');
for (const r of open) {
  const age = now - Number(r.created_at);
  const retry = Number(r.retry_at ?? 0);
  const flag = age > 10 * 3600000 && ['following', 'output', 'planned'].includes(r.state) ? ' ⚠️ 陈旧且未终结' : '';
  console.log('  ' + String(r.state).padEnd(10), String(r.id).slice(0, 42).padEnd(44),
    hrs(age).padStart(7), (retry > now ? '+ ' + ((retry - now) / 1000).toFixed(0) + 's' : 'now').padEnd(8) + flag);
}

console.log('\n=== 执行状态分布（recovering/needs_attention 会让 task 永久 busy） ===');
for (const r of all('SELECT state,COUNT(*) n FROM bridge_executions GROUP BY state ORDER BY n DESC'))
  console.log('  ' + String(r.state).padEnd(16), r.n);
const blocking = all("SELECT id,conversation,state,created_at,data FROM bridge_executions WHERE state IN ('queued','starting','following','recovering','needs_attention')");
if (blocking.length) {
  console.log('\n  阻塞性执行明细：');
  for (const r of blocking) {
    let d; try { d = JSON.parse(r.data); } catch { d = {}; }
    const rec = Number(d.times?.received);
    console.log('    ' + String(r.state).padEnd(16), String(r.conversation).padEnd(18),
      Number.isFinite(rec) ? hrs(now - rec) : '?');
  }
} else console.log('  （无阻塞性执行：pump 与路由都不会被卡住）');

console.log('\n=== 迟到投递护栏是否在工作 ===');
const dropped = all("SELECT COUNT(*) n FROM bridge_replies WHERE detail LIKE '%replyStaleDeliveryMaxAgeMs%'")[0].n;
console.log(`  因超龄被放弃的待投递行：${dropped} 条`);
console.log('  （>0 说明护栏拦下过迟到回复；若同时 pending 里还有 >10h 的 following 行，说明护栏没生效）');
