/**
 * 看一眼桥接库里到底存了什么 —— 排查"上下文读的不是最近消息"这类问题用。
 *
 *   node tools/inspect-store.mjs                 # 用默认路径
 *   node tools/inspect-store.mjs <db 路径>
 *   QQ_BRIDGE_DB=... node tools/inspect-store.mjs
 *
 * 默认路径由 tools/db-path.mjs 统一解析：优先本仓库 data/，
 * 其次 profile 里 qq-bridge 段配的 stateDir / cwd。
 */
import { bridgeDbCandidates, resolveBridgeDb } from './db-path.mjs';
import { Store } from '../lib/store.mjs';

const dbPath = resolveBridgeDb(process.argv[2]);

if (!dbPath) {
  console.log('找不到桥接库。试过：');
  for (const c of bridgeDbCandidates(process.argv[2])) console.log('  ' + c);
  console.log('\n用法：node tools/inspect-store.mjs <db 路径>');
  process.exit(1);
}

console.log(`库：${dbPath}\n`);
const s = new Store(dbPath);
console.log('available:', s.available, s.degradedReason || '');

if (s.available) {
  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log('表:', tables.join(', '));

  console.log('\n=== 会话（含缺口）===');
  for (const r of s.db
    .prepare('SELECT conversation, gap_count, gap_note, last_message_at FROM conversations ORDER BY last_message_at DESC')
    .all()) {
    const when = r.last_message_at ? new Date(Number(r.last_message_at)).toLocaleString('zh-CN') : '—';
    console.log(
      `  ${String(r.conversation).padEnd(22)} gap=${String(r.gap_count).padStart(5)}  ${when}  ${r.gap_note ?? ''}`,
    );
  }

  console.log('\n=== 每个会话最近 5 条事件（这就是"最近聊了什么"的来源）===');
  const convs = s.db.prepare('SELECT DISTINCT conversation FROM events').all();
  for (const { conversation } of convs) {
    const rows = s.db
      .prepare(
        `SELECT id, kind, acked, deliverable, payload, created_at
           FROM events WHERE conversation = ? ORDER BY id DESC LIMIT 5`,
      )
      .all(conversation);
    if (!rows.length) continue;
    console.log(`\n  ${conversation}（倒序显示，最新在上）`);
    for (const r of rows) {
      let text = '';
      try {
        text = String(JSON.parse(r.payload)?.text ?? '');
      } catch {}
      const when = new Date(Number(r.created_at)).toLocaleTimeString('zh-CN');
      console.log(
        `    #${String(r.id).padStart(5)} ${when}  acked=${r.acked ? 'Y' : 'N'} ` +
          `kind=${r.kind}  ${text.slice(0, 50)}`,
      );
    }
  }

  console.log('\n=== 待审批动作（踢人）===');
  if (tables.includes('pending_actions')) {
    const acts = s.db
      .prepare("SELECT id, kind, group_id, user_id, status, reason FROM pending_actions ORDER BY id DESC LIMIT 10")
      .all();
    if (!acts.length) console.log('  （没有）');
    for (const a of acts) {
      console.log(`  #${a.id} ${a.kind} ${a.group_id}/${a.user_id} [${a.status}] ${a.reason}`);
    }
  } else {
    console.log('  （pending_actions 表不存在）');
  }
}

s.db?.close();
