/**
 * 看缓冲与 ack 的健康状况 —— 排查"上下文不是最新"用。
 *
 *   node tools/check-buffer-health.mjs [会话]
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const conv = process.argv[2] ?? 'group:100000001';
const dbPath = resolveBridgeDb();
if (!dbPath) {
  console.error('找不到桥接库；可用 QQ_BRIDGE_DB 指定路径。');
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

const fmt = (t) => new Date(Number(t)).toLocaleTimeString('zh-CN');

console.log(`库内会话 ${conv}\n`);

console.log('=== 可进缓冲的消息（group_message）与自己的话（self_message）===');
const rows = db
  .prepare(
    `SELECT id, kind, acked, deliverable, payload, created_at
       FROM events
      WHERE conversation = ? AND kind IN ('group_message','self_message')
      ORDER BY id ASC`,
  )
  .all(conv);
if (!rows.length) console.log('  （一条都没有）');
for (const r of rows) {
  let t = '';
  try {
    t = JSON.parse(r.payload)?.text ?? '';
  } catch {}
  console.log(
    `  #${String(r.id).padStart(4)} ${fmt(r.created_at)}  ${String(r.kind).padEnd(13)} ` +
      `acked=${r.acked ? 'Y' : 'N'} del=${r.deliverable}  ${String(t).slice(0, 40)}`,
  );
}

const unackedGroup = rows.filter((r) => r.kind === 'group_message' && !r.acked && r.deliverable);
console.log(`\n未 ack 的 group_message：${unackedGroup.length} 条`);
if (unackedGroup.length) {
  console.log('  ⚠️ 这些会在**每次插件重载时被重新捞回缓冲**，');
  console.log('     如果长时间不变，说明心跳没有消费它们（或没跑）。');
  for (const r of unackedGroup) {
    let t = '';
    try {
      t = JSON.parse(r.payload)?.text ?? '';
    } catch {}
    console.log(`     #${r.id} ${fmt(r.created_at)} ${String(t).slice(0, 40)}`);
  }
}

console.log('\n=== 全部事件里各 kind 的数量 ===');
for (const r of db.prepare('SELECT kind, COUNT(*) n, SUM(acked) acked FROM events GROUP BY kind').all()) {
  console.log(`  ${String(r.kind).padEnd(14)} ${String(r.n).padStart(4)} 条，已 ack ${r.acked ?? 0}`);
}

console.log('\n=== 最近 15 条事件（不论类型）===');
for (const r of db
  .prepare('SELECT id, conversation, kind, acked, deliverable, payload, created_at FROM events ORDER BY id DESC LIMIT 15')
  .all()) {
  let t = '';
  try {
    t = JSON.parse(r.payload)?.text ?? '';
  } catch {}
  console.log(
    `  #${String(r.id).padStart(4)} ${fmt(r.created_at)} ${String(r.conversation).padEnd(20)} ` +
      `${String(r.kind).padEnd(13)} acked=${r.acked ? 'Y' : 'N'} del=${r.deliverable} ${String(t).slice(0, 28)}`,
  );
}

db.close();
