/** Durable handoff: DSH request identity -> captured output -> exact send plan. */
export class ReplyJournal {
  constructor(store) {
    this.store = store;
    this.active = new Set();
    this.sending = new Set();
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_replies (
        id TEXT PRIMARY KEY, conversation TEXT NOT NULL, state TEXT NOT NULL,
        meta TEXT NOT NULL, outcome TEXT, plan TEXT, detail TEXT,
        retry_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS bridge_replies_pending ON bridge_replies(state, created_at);
    `);
    /**
     * 明确失败要能"放弃"，否则一条被 OneBot 永久拒绝的回复会每 30 秒重试一次，
     * 按"较晚回复不得越过未完成计划"把整个会话一直挡住。老库补列。
     */
    const columns = store.db.prepare('PRAGMA table_info(bridge_replies)').all()
      .map((column) => column.name);
    if (!columns.includes('attempts'))
      store.db.exec('ALTER TABLE bridge_replies ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    // v53 lost the quota error code in the queue, counting a deferred send as a
    // hard failure. Restore only recent exact quota failures with known receipts.
    const repaired = [];
    for (const row of store.db.prepare(`SELECT id,state,plan,detail FROM bridge_replies
      WHERE state IN ('failed','planned') AND attempts>0 AND updated_at>? AND detail LIKE '%发送配额已满：%'`)
      .all(Date.now() - 86400000)) {
      if (!/^(?:已放弃投递（\d+ 次明确失败）：)?发送配额已满：/u.test(row.detail ?? '') || !row.plan) continue;
      let plan; try { plan = JSON.parse(row.plan); } catch { continue; }
      if (!plan.floorPolicy || !Array.isArray(plan.bubbles)) continue;
      const ids = [...plan.bubbles.map((_, i) => plan.idemBase + '#b' + i),
        ...plan.bubbles.map((_, i) => plan.idemBase + '#b' + i + '#noat'),
        ...(plan.sticker == null ? [] : [plan.idemBase + '#s'])];
      if (ids.some((id) => ['UNKNOWN','EXECUTING','FAILED','PARTIAL'].includes(store.getReceipt(id)?.status))) continue;
      store.db.prepare(`UPDATE bridge_replies SET state='planned',attempts=0,retry_at=0,
        detail='限流误判已修复，等待按原计划复核投递',updated_at=? WHERE id=?`).run(Date.now(), row.id);
      repaired.push(row.id);
    }
    this.quotaRepaired = repaired;
  }
  get(id) {
    const row = this.store.db.prepare('SELECT * FROM bridge_replies WHERE id=?').get(id);
    return row && { ...row, meta: JSON.parse(row.meta),
      outcome: row.outcome && JSON.parse(row.outcome), plan: row.plan && JSON.parse(row.plan) };
  }
  begin(id, conversation, meta) {
    const now = Date.now();
    this.store.db.prepare(`INSERT INTO bridge_replies
      (id,conversation,state,meta,created_at,updated_at) VALUES (?,?,'following',?,?,?)
      ON CONFLICT(id) DO NOTHING`).run(id, conversation, JSON.stringify(meta), now, now);
  }
  output(id, outcome) {
    this.store.db.prepare(`UPDATE bridge_replies SET state='output',outcome=?,detail=NULL,
      retry_at=0,updated_at=? WHERE id=? AND state='following'`)
      .run(JSON.stringify(outcome), Date.now(), id);
  }
  planned(id, plan) {
    this.store.db.prepare(`UPDATE bridge_replies SET state='planned',plan=?,detail=NULL,
      retry_at=0,updated_at=? WHERE id=? AND state IN ('output','planned')`)
      .run(JSON.stringify(plan), Date.now(), id);
  }
  finish(id, detail = 'delivered') {
    this.store.db.prepare(`UPDATE bridge_replies SET state='done',detail=?,retry_at=0,
      updated_at=? WHERE id=?`).run(detail, Date.now(), id);
  }
  /**
   * 记一次投递失败。
   *
   * 三种情况分得很清，因为它们的正确处置完全不同：
   *   · `attention`（结果**未知**）→ 转 attention，**绝不自动重发**，等人工核对；
   *     永不放弃（放弃等于把"可能已经发出去了"的消息当没发生）。
   *   · 明确失败 + 配了 `maxAttempts` → 计数；到上限转 `failed` 终态并放开队列，
   *     detail 留一句"已放弃投递（N 次明确失败）：…"，人工还能查。
   *   · 配额之类的"待会儿再来"（调用方传 maxAttempts: 0）→ 只更新 retryAt，不计数。
   *
   * `maxAttempts: 0` = 旧行为（无限重试）。
   * @returns {'attention'|'failed'|'pending'} 这次调用把行置成了什么状态
   */
  error(id, error, { attention = false, retryAt = Date.now() + 30000, maxAttempts = 0 } = {}) {
    const now = Date.now();
    const detail = String(error).slice(0, 800);
    if (attention) {
      this.store.db.prepare(`UPDATE bridge_replies SET state='attention',detail=?,retry_at=?
        ,updated_at=? WHERE id=?`).run(detail, retryAt, now, id);
      return 'attention';
    }
    const row = this.get(id);
    const cap = Math.max(0, Number(maxAttempts) || 0);
    // 同一个重试周期里只算一次：第一次失败会把 retry_at 推到未来，
    // 紧接着的第二次记账（同一批的收尾）就不该再 +1。
    const counted = cap > 0 && Number(row?.retry_at ?? 0) <= now
      ? Number(row?.attempts ?? 0) + 1
      : Number(row?.attempts ?? 0);
    if (cap > 0 && counted >= cap) {
      this.store.db.prepare(`UPDATE bridge_replies SET state='failed',attempts=?,detail=?,
        retry_at=0,updated_at=? WHERE id=?`)
        .run(counted, `已放弃投递（${counted} 次明确失败）：${detail}`.slice(0, 800), now, id);
      return 'failed';
    }
    this.store.db.prepare(`UPDATE bridge_replies SET attempts=?,detail=?,retry_at=?,
      updated_at=? WHERE id=?`).run(counted, detail, retryAt, now, id);
    return 'pending';
  }
  /**
   * 放弃一次**不可能成功**的恢复（DSH 会话早已不在，重连只会撞超时）。
   *
   * 与 `error` 的区别很重要：`error` 记的是"这次尝试失败了"，还会按 `maxAttempts`
   * 再试；`abandon` 是"这条永远不会成功了"，直接转 `failed` 终态并放开会话队列。
   * 为什么必须有它：`following` 走的是 `maxAttempts: 0`（无限重试，因为"读 DSH
   * 流失败"不等于发送失败），于是一条 4 天前的记录会永远每 30 秒重试一次，
   * 同时把该 task 永久钉在 busy 上。放弃不等于消失——`snapshot().failed` 里能查。
   *
   * @returns {number} 实际被改写的行数（0 = 已经是终态）
   */
  abandon(id, detail = '已放弃恢复') {
    return this.store.db.prepare(`UPDATE bridge_replies SET state='failed',detail=?,retry_at=0,
      updated_at=? WHERE id=? AND state NOT IN ('done','failed')`)
      .run(String(detail).slice(0, 800), Date.now(), id).changes;
  }
  /**
   * 还没了结的行。
   *
   * `failed`（已明确放弃投递）不算 —— 它已经不该再占住会话队列了，
   * 否则一条永远发不出去的消息会让整个群哑掉（线上真发生过）。
   * 它没有被藏起来：`snapshot().failed` 里列着，人工随时能查。
   */
  pending() {
    return this.store.db.prepare(`SELECT id FROM bridge_replies WHERE state NOT IN ('done','failed')
      ORDER BY created_at,rowid`).all().map((r) => this.get(r.id));
  }
  /** Unknown delivery is quarantined to its own plan, never a conversation-wide lock. */
  needsReconciliation(row) {
    if (row.state !== 'attention') return false;
    if (!row.plan) return true;
    const ids = [...row.plan.bubbles.flatMap((_, i) => [row.plan.idemBase + '#b' + i,
      row.plan.idemBase + '#b' + i + '#noat']),
      ...(row.plan.sticker == null ? [] : [row.plan.idemBase + '#s'])];
    return ids.some((id) => ['UNKNOWN', 'EXECUTING'].includes(this.store.getReceipt(id)?.status));
  }
  deliveryHead(conversation) {
    // Generation has no send plan yet. It must not block a ready independent progress answer.
    // Quota waits, in-flight sends and definite retries still preserve send-plan order.
    return this.pending().find((row) => row.conversation === conversation &&
      ['planned', 'attention'].includes(row.state) && row.plan && !this.needsReconciliation(row));
  }
  snapshot() {
    const counts = Object.fromEntries(this.store.db.prepare(
      'SELECT state,COUNT(*) n FROM bridge_replies GROUP BY state').all().map((r) => [r.state, r.n]));
    const failed = this.store.db.prepare(`SELECT id,conversation,detail,updated_at,attempts
      FROM bridge_replies WHERE state='failed' ORDER BY updated_at DESC LIMIT 5`).all();
    return { available: true, counts, failed, quotaRepaired: this.quotaRepaired,
      pending: this.pending().slice(0, 20).map((r) => ({
      id: r.id, conversation: r.conversation, state: r.state, attempts: r.attempts,
      sessionId: r.meta.sessionId, requestId: r.meta.requestId,
      createdAt: r.created_at, retryAt: r.retry_at, detail: r.detail,
      quarantined: this.needsReconciliation(r),
    })) };
  }
}
const journals = new WeakMap();
export function replyJournal(store) {
  if (!store?.available) return null;
  let journal = journals.get(store);
  if (!journal) { journal = new ReplyJournal(store); journals.set(store, journal); }
  return journal;
}
