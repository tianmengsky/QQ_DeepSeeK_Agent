/**
 * 清掉离线验证时插进去的那条假申请。
 *
 * 只删这一条（按 flag 精确匹配），不碰别的数据。
 *   node tools/cleanup-verify-request.mjs <db路径> <flag>
 */
import { Store } from 'file:///D:/Code/dsh-qq-bridge/lib/store.mjs';

const [dbPath, flag] = process.argv.slice(2);
if (!dbPath || !flag) {
  console.error('用法: node tools/cleanup-verify-request.mjs <db> <flag>');
  process.exit(1);
}

const store = new Store(dbPath);
if (!store.available) {
  console.error('打不开数据库:', store.degradedReason);
  process.exit(1);
}

const before = store.db
  .prepare('SELECT flag, kind, user_id, comment FROM pending_requests WHERE flag = ?')
  .all(flag);
console.log('匹配到', before.length, '条:', JSON.stringify(before));

const res = store.db.prepare('DELETE FROM pending_requests WHERE flag = ?').run(flag);
console.log('已删除', res.changes, '条');

const left = store.db.prepare('SELECT COUNT(*) AS n FROM pending_requests').get();
console.log('剩余待处理申请:', left.n);
store.db.close();
