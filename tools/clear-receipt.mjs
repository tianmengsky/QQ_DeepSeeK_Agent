/**
 * 清掉离线验证时留下的一条 UNKNOWN 回执。
 *
 * 为什么必须清：UNKNOWN 在幂等层是"结果未知、不许自动重发"的状态。
 * 那条回执对应的假申请早就删了，但它仍然占着那个幂等键，
 * 会导致同一件事永远发不出去（这正是设计意图，所以得人工确认后清）。
 *
 *   node tools/clear-receipt.mjs <db路径> <idemKey>
 */
import { Store } from 'file:///D:/Code/dsh-qq-bridge/lib/store.mjs';

const [dbPath, idemKey] = process.argv.slice(2);
if (!dbPath || !idemKey) {
  console.error('用法: node tools/clear-receipt.mjs <db> <idemKey>');
  process.exit(1);
}

const store = new Store(dbPath);
if (!store.available) {
  console.error('打不开数据库:', store.degradedReason);
  process.exit(1);
}

const row = store.getReceipt(idemKey);
if (!row) {
  console.log('没有这条回执，无需清理');
} else {
  console.log('将要删除：');
  console.log('  键   :', row.idemKey);
  console.log('  会话 :', row.conversation);
  console.log('  状态 :', row.status);
  console.log('  详情 :', row.detail);
  const res = store.db.prepare('DELETE FROM outbox WHERE idem_key = ?').run(idemKey);
  console.log('已删除', res.changes, '条');
}

console.log('剩余回执统计:', JSON.stringify(store.countByStatus()));
console.log('剩余待核对:', store.listUnknown(null, 20).length, '条');
store.db.close();
