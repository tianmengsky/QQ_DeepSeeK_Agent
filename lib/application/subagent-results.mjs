import { executionSource, closeExecutionSource } from '../agent/execution-scope.mjs';
import { DELEGATION_TOOLS } from '../agent/tool-sets.mjs';

/**
 * DSH 原生子代理（`subagent` / `subagent_fork`）在 QQ 会话里的结果交回。
 *
 * 为什么需要这一段：原生的 `subagent` 是**非阻塞**的 —— 父代理拿到 child id 就往下走、
 * 结束本轮，子代理在同一个 DSH 进程里自己跑。跑完时 DSH 会给父会话投一条「结算通知」
 * 并唤醒它，但**桥接没有在跟那个回合**（回复只从桥接自己驱动的 `follow` 流里取，
 * 见 lib/agent/runner.mjs），所以那段正文到不了 QQ，用户只会看到父代理当初那句
 * 「我先派下去了」。
 *
 * 这里补的就是这一段：登记子代理 → 它收工时把结果排成父会话的一次执行，走原来那条
 * 「子代理结果交回」的渲染与投递路径（`bridge_executions.data.delegatedResult`，
 * 见 lib/conversation/task-routing.mjs 的 context()）。区别只在于登记源从
 * 老的 `service.start()` 变成了 DSH 自己创建的子会话。
 *
 * 记录仍写 `bridge_workers`：它是历史遗留表，但任务账本（lib/conversation/task-ledger.mjs）
 * 已经按这个形状读子代理行，换表等于白改一处显示。
 */
const decode = row => row && { ...row, data: JSON.parse(row.data) };

export class SubagentResults {
  constructor({ ctx, config, registry, state, store, stats }) {
    Object.assign(this, { ctx, config, registry, state, store, stats });
    /** childSessionId -> 登记信息（内存态；落库那份是给重启后对账用的）。 */
    this.children = new Map();
    this.timers = new Map();
    this.closed = false;
    // 重启后不假装能续跑：写到一半的子代理结果交人核对，不自动重放。
    this.store.db.prepare("UPDATE bridge_workers SET state='needs_attention',updated_at=? WHERE state IN ('queued','starting','running')")
      .run(Date.now());
  }

  agents() { return this.ctx.get?.('agents') ?? this.ctx.agents; }
  get(id) { return decode(this.store.db.prepare('SELECT * FROM bridge_workers WHERE id=?').get(id)); }
  save(id, state, patch = {}) {
    if (this.closed || this.state.disposed) return;
    const row = this.get(id); if (!row) return;
    this.store.db.prepare('UPDATE bridge_workers SET state=?,data=?,updated_at=? WHERE id=?')
      .run(state, JSON.stringify({ ...row.data, ...patch }), Date.now(), id);
  }

  /**
   * 子代理会话出生时登记一次。
   *
   * 只在**父会话仍挂在某轮 QQ 执行来源上**时登记 —— GUI 里自己起的子代理、以及桥接
   * 自己的记忆/心跳回合派生的子代理都不该往 QQ 投结果。
   */
  bind(agent) {
    if (this.closed || this.state.disposed) return;
    const session = agent?.session, parentSessionId = session?.header?.parentSession;
    if (!session?.id || !parentSessionId || this.children.has(session.id)) return;
    const ref = this.store.getState('qq-bridge:execution-session:' + parentSessionId);
    const source = ref && executionSource(this.store, ref);
    if (!source?.conversation) return;
    /**
     * 子代理继承父回合的执行来源：它自己的 qq_workspace / document-editor 调用要落在
     * 同一个 QQ 会话的工作区里。父回合马上会 close —— 靠 `bridge_workers` 里这条
     * running 行把来源留在 parentClosed 状态（见 closeExecutionSource），否则子代理
     * 一跑几分钟，中途发文件会被「来源已关闭」拒掉。
     */
    this.store.setState('qq-bridge:execution-session:' + session.id, ref);
    const id = 'worker-' + session.id, now = Date.now();
    const original = source.executionId ? this.state.taskRouting?.execution(source.executionId) : null;
    this.store.db.prepare('INSERT OR REPLACE INTO bridge_workers VALUES (?,?,?,?,?,?,?,?)').run(id,
      source.conversation, source.taskId ?? '', String(original?.owner ?? ''), 'running',
      JSON.stringify({ sourceRef: ref, executionId: source.executionId, taskVersion: source.taskVersion,
        parentSessionId, childSessionId: session.id,
        title: String(session.header?.title ?? session.header?.label ?? '子代理').slice(0, 100),
        text: '' }), now, now);
    this.children.set(session.id, { id, conversation: source.conversation, sourceRef: ref,
      parentSessionId, text: '', settled: false });
  }

  /** 累积子代理本轮的正文；turn 结束时安排交回。 */
  onEvent(session, event) {
    if (this.closed || this.state.disposed) return;
    const child = this.children.get(session?.id);
    if (!child) return;
    if (event.type === 'turn/start') { child.text = ''; return; }
    if (event.type === 'assistant/message') {
      child.text += (event.data?.message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('');
      return;
    }
    if (event.type === 'turn/end' || event.type === 'error') this.schedule(session.id);
  }

  schedule(childSessionId) {
    if (this.timers.has(childSessionId)) clearTimeout(this.timers.get(childSessionId));
    const timer = setTimeout(() => { this.timers.delete(childSessionId); this.settle(childSessionId); }, 1500);
    timer.unref?.();
    this.timers.set(childSessionId, timer);
  }

  /**
   * 收工判定：子代理可能被 `send_message` 追加要求而再跑几轮，只有它**真的空闲**了
   * 才算这一份成果结束；还在跑就再等一拍。
   */
  settle(childSessionId, attempt = 0) {
    const child = this.children.get(childSessionId);
    if (!child || this.closed || this.state.disposed) return;
    const agent = this.agents()?.get?.(childSessionId);
    if (agent?.status === 'running' && attempt < 60) {
      const timer = setTimeout(() => { this.timers.delete(childSessionId); this.settle(childSessionId, attempt + 1); }, 1000);
      timer.unref?.(); this.timers.set(childSessionId, timer);
      return;
    }
    if (child.settled) return;
    child.settled = true;
    const text = String(child.text ?? '').slice(0, 20000);
    const state = text.trim() ? 'completed' : 'failed';
    this.save(child.id, state, { result: text, stopReason: text.trim() ? 'completed' : 'empty-result',
      diagnostic: text.trim() ? '' : '子代理没有留下正文' });
    this.enqueueResult(child.id);
    const source = executionSource(this.store, child.sourceRef);
    if (source?.parentClosed) closeExecutionSource(this.store, child.sourceRef);
    this.children.delete(childSessionId);
  }

  /** 把「子代理交回」排成父会话的一次执行；身份确定，重启也不会重复投递。 */
  enqueueResult(id) {
    const row = this.get(id), routing = this.state.taskRouting;
    if (!row || !routing || !row.data.stopReason || !['completed', 'failed'].includes(row.state) || !this.state.enabled) return;
    const task = routing.get(row.task_id), original = routing.execution(row.data.executionId);
    if (!task || task.state === 'cancelled' || task.version !== row.data.taskVersion || !original) return;
    const executionId = 'execution-' + id;
    if (routing.execution(executionId)) {
      if (!row.data.completionExecutionId) this.save(id, row.state, { completionExecutionId: executionId });
      return;
    }
    if (!this.state.sourceLedger.resolve(row.data.sourceRef)) {
      this.save(id, 'needs_attention', { deliveryError: 'source-expired-or-recalled' });
      return;
    }
    const data = { ...original.data, delegatedResult: { jobId: id, state: row.state, result: row.data.result,
      stopReason: row.data.stopReason, diagnostic: row.data.diagnostic },
      event: { ...original.data.event, __delegateResult: id }, attempts: 0, retryAt: 0,
      times: { received: row.updated_at, routed: Date.now() } };
    this.store.db.prepare('INSERT OR IGNORE INTO bridge_executions VALUES (?,?,?,?,?,?,?,?,?)')
      .run(executionId, row.task_id, row.conversation, row.owner, 'queued', null, JSON.stringify(data), Date.now(), Date.now());
    this.save(id, row.state, { completionExecutionId: executionId });
    queueMicrotask(() => this.state.taskScheduler?.pump());
  }

  /** 兜底：内存里还挂着的子代理没收到 turn/end 时，按状态补一次收工。 */
  sweep() {
    if (this.closed || this.state.disposed) return;
    for (const id of [...this.children.keys()]) {
      const agent = this.agents()?.get?.(id);
      if (!agent && !this.timers.has(id)) this.settle(id);
    }
  }

  snapshot() {
    const counts = Object.fromEntries(this.store.db.prepare('SELECT state,COUNT(*) n FROM bridge_workers GROUP BY state').all()
      .map(r => [r.state, r.n]));
    return { available: true, mode: 'native-subagent-bridge-completion', tools: DELEGATION_TOOLS,
      watching: this.children.size, active: counts.running ?? 0, counts };
  }

  dispose() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.children.clear();
  }
}
