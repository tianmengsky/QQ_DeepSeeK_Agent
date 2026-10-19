/** Read-only incident timeline. No migrations, model submissions, configuration reads or QQ sends. */
import { DatabaseSync } from 'node:sqlite';

const [file = process.env.QQ_BRIDGE_DB, conversation = 'group:100000001', day = '2026-10-12',
  from = '11:30', to = '11:50'] = process.argv.slice(2);
if (!file || !/^(group|user):\d+$/u.test(conversation) || !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !/^\d{2}:\d{2}$/u.test(from) || !/^\d{2}:\d{2}$/u.test(to))
  throw new Error('Usage: node tools/audit-task-window.mjs <sqlite-file> [group:ID] [YYYY-MM-DD] [HH:MM] [HH:MM] (Asia/Shanghai)');
const start = Date.parse(`${day}T${from}:00+08:00`), end = Date.parse(`${day}T${to}:00+08:00`);
if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Invalid audit time range');
const db = new DatabaseSync(file, { readOnly: true });
const stamp = (ms) => ms ? new Date(Number(ms)).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : null;
try {
  const inputs = db.prepare(`SELECT id,payload,created_at FROM events WHERE conversation=?
    AND kind='inbound' AND created_at>=? AND created_at<? ORDER BY created_at,id`).all(conversation, start, end);
  const turns = db.prepare(`SELECT id,state,meta,outcome,created_at,updated_at FROM bridge_replies
    WHERE conversation=? AND created_at>=? AND created_at<? ORDER BY created_at,rowid`).all(conversation, start, end);
  const owned = new Set(turns.flatMap((r) => {
    const m = JSON.parse(r.meta);
    return [String(m.event?.message_id), ...(m.floorPolicy?.messageIds ?? []),
      ...(m.floorPolicy?.originals ?? []).map((e) => String(e.message_id))];
  }));
  const receipts = db.prepare(`SELECT idem_key,status,kind,created_at,updated_at FROM outbox
    WHERE conversation=? AND created_at>=? AND created_at<? ORDER BY created_at,rowid`).all(conversation, start, end);
  console.log(JSON.stringify({ conversation, timezone: 'Asia/Shanghai', from: stamp(start), to: stamp(end),
    interpretation: 'No linked turn inside this time range does not prove loss; journal updated_at is not model completion time.',
    inbound: inputs.map((r) => { const p = JSON.parse(r.payload); return { eventId: r.id,
      messageId: p.messageId, at: stamp(r.created_at), hasLinkedTurnInWindow: owned.has(String(p.messageId)) }; }),
    turns: turns.map((r) => {
      const m = JSON.parse(r.meta), o = r.outcome && JSON.parse(r.outcome);
      return { id: r.id, state: r.state, messageId: m.event?.message_id,
        sessionId: m.sessionId, requestId: m.requestId, submittedAt: stamp(r.created_at),
        receivedAt: stamp(m.event?.__receivedAt), admissionWaitMs: m.event?.__receivedAt ? r.created_at - m.event.__receivedAt : null,
        journalUpdatedAt: stamp(r.updated_at), endReason: o?.endReason ?? null,
        resultChars: o?.reply?.length ?? null, inputCount: m.inputIds?.length ?? null };
    }), receipts: receipts.map((r) => ({ id: r.idem_key, status: r.status, kind: r.kind,
      createdAt: stamp(r.created_at), updatedAt: stamp(r.updated_at) })),
  }, null, 2));
} finally { db.close(); }
