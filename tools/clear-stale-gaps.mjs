/**
 * 清掉库里那些**夸大的假缺口**。
 *
 * 背景：`recordGap` 早期是无条件累加（`gap_count = gap_count + ?`），
 * 而插件每次重载都会重算一次"重载期间有多少条没接住"，于是同一个缺口被
 * 反复计入。实测缓冲里只有 4 条，`gap_count` 却涨到 264 ——
 * 提示词里就会告诉模型"你有 264 条没接住"，她以为自己漏了一大段对话，
 * 表现得像失忆。
 *
 * 代码已经改成取较大值（不会漂移），但**库里已经写坏的数字不会自己变小**，
 * 这个脚本用来把存量清掉。
 *
 *   node tools/clear-stale-gaps.mjs            # 只看
 *   node tools/clear-stale-gaps.mjs --apply    # 真清
 *   node tools/clear-stale-gaps.mjs --apply --over 50
 */
import { DatabaseSync } from 'node:sqlite';
import { bridgeDbCandidates, resolveBridgeDb } from './db-path.mjs';

const apply = process.argv.includes('--apply');
const overIdx = process.argv.indexOf('--over');
const over = overIdx >= 0 ? Number(process.argv[overIdx + 1]) : 50;

const dbPath = resolveBridgeDb(process.argv[2]);

if (!dbPath) {
  console.log('找不到桥接库。试过：');
  for (const c of bridgeDbCandidates(process.argv[2])) console.log('  ' + c);
  process.exit(1);
}

console.log(`库：${dbPath}`);
console.log(`阈值：gap_count > ${over}${apply ? '（会写入）' : '（只读，加 --apply 才写）'}\n`);

const db = new DatabaseSync(dbPath);
const before = db
  .prepare('SELECT conversation, gap_count, gap_note FROM conversations ORDER BY gap_count DESC')
  .all();

console.log('当前缺口：');
for (const r of before) {
  const flag = Number(r.gap_count) > over ? '  ← 可疑' : '';
  console.log(`  ${String(r.conversation).padEnd(24)} ${String(r.gap_count).padStart(6)}  ${r.gap_note ?? ''}${flag}`);
}

const suspects = before.filter((r) => Number(r.gap_count) > over);
if (!suspects.length) {
  console.log('\n没有超过阈值的缺口，不用清。');
} else if (!apply) {
  console.log(`\n${suspects.length} 个会话的缺口超过阈值。加 --apply 清理。`);
} else {
  const stmt = db.prepare(
    'UPDATE conversations SET gap_count = 0, gap_note = NULL WHERE conversation = ?',
  );
  for (const r of suspects) stmt.run(r.conversation);
  console.log(`\n已清掉 ${suspects.length} 个会话的缺口。`);
}

db.close();
