import { TaskRouting } from '../conversation/task-routing.mjs';
import { taskRegistry } from '../conversation/task-sessions.mjs';
import { executeTurn } from './execute-turn.mjs';
import { captureFloor, isCancellation } from '../conversation/floor.mjs';
import { contextMessage } from '../conversation/context.mjs';
import { EpisodeLedger } from '../memory/episodes.mjs';
import { awaitIncomingVoices } from './voice-transcription.mjs';
import { injectOwnedAmendment, injectRunningTurn } from './interjections.mjs';

/** Durable queue admission returns before model/tool waits. Memory contains only bounded running work. */
export class TaskScheduler {
  constructor({ ctx, config, registry, state, memory, stats, store, sendQueue }) {
    Object.assign(this, { ctx, config, registry, state, memory, stats, store, sendQueue });
    this.routing = new TaskRouting(store, config); this.active = new Map(); this.lastBucket = '';
    this.mode = config.taskRoutingMode ?? 'shadow';
    /** `all` = 有在跑的回合就把新消息并进去（跳过语义路由）；`amend` = 只在路由判成 amend 时注入。 */
    this.inTurnInjection = config.inTurnInjectionMode ?? 'amend';
    this.enabled = this.routing.available && this.mode !== 'off';
    state.taskRouting = this.routing;
    if (store?.available) state.sourceLedger ??= new EpisodeLedger(store, ctx.logger);
  }
  async admit(key, events, { signal, onClaim } = {}) {
    if (!this.enabled) return false;
    signal?.throwIfAborted();
    const floor = captureFloor(this.config, this.registry, key, events);
    const event = events.find((e) => !e.__inputPassive && String(e.user_id) === floor.authors[0]);
    if (!event) return false;
    await awaitIncomingVoices(events);
    signal?.throwIfAborted();
    /**
     * 强制注入排在语义路由**之前**。
     *
     * 顺序有实际收益：这里不判"这是不是同一个任务"，也不付 `taskRouteTimeoutMs`
     * （线上实测 p50 4.3s、p95 8.4s）。这一批消息本来就该让正在思考的那一轮看见，
     * 花 4 秒问模型"它属于哪个任务"再决定注入，等于先把消息压住再注入。
     */
    if (this.mode === 'enabled' && this.inTurnInjection === 'all' && this.forceInject(key, events)) {
      this.stats.interjected = (this.stats.interjected ?? 0) + 1;
      for (const input of events) this.state.taskLedger?.settleInput(input, 'interjected');
      onClaim?.(); return true;
    }
    // One collected batch is one semantic input. The executing Agent receives
    // its complete timeline and may answer several questions within it.
    const started = Date.now();
    const route = await this.routing.decide(this.ctx, this.registry, key, event, signal,
      { allowModel: this.mode !== 'shadow', inputEvents: events });
    signal?.throwIfAborted();
    if (this.state.disposed) return false;
    this.stats.lastTaskRoute = { conversation: key, mode: this.mode, action: route.action,
      reason: route.reason, fallbackCause: route.fallbackCause ?? null, fallbackDetail: route.fallbackDetail ?? null,
      inputCount: events.length, durationMs: Date.now() - started, at: Date.now() };
    // amend 是"执行中改需求"，此前线上从未产出过一次裁决（0/504）——根因是路由
    // 被主模型的思考拖到 4 秒超时，换掉辅助模型后实测 7/7 标签正确（含 4 例 amend）。
    // 这条路径刚从死里复活，必须能被观测，否则无从验证它到底走的是哪条处理方式。
    if (route.action === 'amend') this.stats.amendRouted = (this.stats.amendRouted ?? 0) + 1;
    /**
     * 路由调用的可观测信号：本地裁决（没调模型）vs 走了模型（含失败回退）。
     *
     * 为什么要分开数：门控的收益就是"少调几次模型"，而这次的模型调用实测
     * `deepseek-v4-flash` 首字 2125ms / 完成 2518ms，压在每条消息的关键路径上。
     * `local` 的三个固定 reason 即"没调模型"；其余（含 semantic-route-fallback
     * 这类失败原因）都说明真的发了请求。
     */
    if (['independent-input', 'uncertain-target', 'active-identical-request'].includes(route.reason))
      this.stats.routeLocal = (this.stats.routeLocal ?? 0) + 1;
    else this.stats.routeModel = (this.stats.routeModel ?? 0) + 1;
    // 优先尝试"注入正在跑的那一轮"：用户能拿到一次连贯的答复，而不是答复 + 更正。
    // 注入不可用（没有在跑的回合、agent 不可注入等）时**必须**落到下面的持久化路径。
    if (this.mode === 'enabled' && injectOwnedAmendment(this, key, events, route)) {
      this.stats.amendInjected = (this.stats.amendInjected ?? 0) + 1;
      for (const input of events) this.state.taskLedger?.settleInput(input, 'interjected');
      onClaim?.(); return true;
    }
    const admitted = this.routing.admit(key, event, route, this.mode, events);
    if (route.action === 'amend') this.stats.amendQueued = (this.stats.amendQueued ?? 0) + 1;
    this.state.subagentResults?.sweep();
    this.stats.lastTaskRoute = { conversation: key, mode: this.mode, action: admitted?.data.route?.action ?? route.action,
      reason: admitted?.data.route?.reason ?? route.reason,
      fallbackCause: admitted?.data.route?.fallbackCause ?? route.fallbackCause ?? null,
      fallbackDetail: admitted?.data.route?.fallbackDetail ?? route.fallbackDetail ?? null,
      inputCount: events.length, durationMs: Date.now() - started, at: Date.now() };
    if (this.mode !== 'shadow') for (const input of events) this.state.taskLedger?.settleInput(input, 'routed');
    if (this.mode === 'shadow') return false;
    onClaim?.(); queueMicrotask(() => this.pump()); return true;
  }
  /**
   * 强制注入的入口：有在跑的回合就把这批消息并进去。
   *
   * 唯一的例外是取消（`isCancellation`）—— 它必须真的把任务置成 `cancelled`
   * 并放开后续排队；注入给模型只会变成"她口头答应不做"，账本上任务还在跑。
   *
   * 进度问句以前也在这里被挑出去走进度旁路（桥自己调模型答一句）。那条路同样是
   * 不经 DSH 的正文，已经删掉：现在进度问句要么并进这一轮由 DSH 一起回答，
   * 要么排成一轮独立回合。
   */
  forceInject(key, events) {
    const actionable = events.filter((e) => !e.__inputPassive);
    if (!actionable.length) return false;
    if (isCancellation(contextMessage(actionable[0]))) {
      this.stats.inTurnInjectionSkipped = (this.stats.inTurnInjectionSkipped ?? 0) + 1;
      return false;
    }
    return injectRunningTurn(this, key, events);
  }
  /**
   * 插件**加载时**跑一次的状态重建：把"进行中"的执行按 reply journal 的真实进展重新归类。
   *
   * ⚠️ 不要把它放进周期节拍。`else if (journal)` 那个分支会把「有 turn_id、有 reply 行、
   * 但无 outcome」的执行重新判成 `recovering` —— 而这些执行恰恰就是 recoverReplies
   * 反复重连失败的那些。每 5 秒钉回去一次，就形成永不收敛的环：实测 11 条执行卡了
   * 4 天，把 13 个早已死掉的任务永久钉在 busy 上（撑大路由 prompt、卡住 pump），
   * 并让 lastError 永远是那条超时。周期推进改用 tick()。
   */
  restore() {
    if (!this.enabled || this.mode === 'shadow' || this.state.disposed) return;
    const now = Date.now(), maxAge = this.config.replyRecoveryMaxAgeMs ?? 900000;
    for (const raw of this.store.db.prepare("SELECT id FROM bridge_executions WHERE state IN ('starting','following','recovering','needs_attention')").all()) {
      if (this.active.has(raw.id)) continue;
      const e = this.routing.execution(raw.id), journal = e.turn_id && this.state.replyJournal?.get(e.turn_id);
      if (journal?.outcome) { this.routing.summary(e.task_id, e, journal.outcome); this.routing.setExecution(e.id, 'model_finished'); }
      // 陈旧且无 outcome：DSH 会话早已不在，重连只会超时。收敛成终态，
      // 否则它永久占着 recovering，既让 task 永久 busy，又让 reply 行无限重试。
      else if (journal && this.staleExecution(e, now, maxAge)) this.abandonStale(e, journal);
      else if (journal) this.routing.setExecution(e.id, 'recovering');
      else if (!e.turn_id) this.routing.setExecution(e.id, 'queued');
      else this.routing.setExecution(e.id, 'needs_attention');
    }
    /**
     * `needs_attention` 单独收敛：它不在上面的分支里（上式只在 else 分支产出它），
     * 却同样占着 `busyExecutionStates`，会让 task 永久 busy、永久卡住 pump。
     * 实测有 2 条 4 天前、`turn_id` 为空的这种记录没人看。
     *
     * 但**只收敛"没有待核对投递"的那些**：如果它对应的 reply 行还需要人工核对
     * （UNKNOWN 回执），那才是真的需要人看，保留状态不动。
     */
    for (const raw of this.store.db.prepare("SELECT id FROM bridge_executions WHERE state='needs_attention'").all()) {
      if (this.active.has(raw.id)) continue;
      const e = this.routing.execution(raw.id);
      if (!this.staleExecution(e, now, maxAge)) continue;
      const reply = e.turn_id && this.state.replyJournal?.get(e.turn_id);
      if (reply && this.state.replyJournal?.needsReconciliation?.(reply)) continue;
      this.abandonStale(e, this.state.replyJournal);
    }
    this.routing.sweep(); this.refreshReceipts(); this.pump();
  }
  /**
   * 周期节拍：只推进队列与回执，**不做状态重判**。
   * sweep / refreshReceipts 各自节流——它们一次要扫全表与最近 500 条执行，
   * 没必要跟着 5 秒的投递恢复节拍跑。
   */
  tick() {
    if (!this.enabled || this.mode !== 'enabled' || this.state.disposed) return;
    const now = Date.now();
    if (now - (this.lastSweepAt ?? 0) >= (this.config.taskSweepIntervalMs ?? 60000)) {
      this.lastSweepAt = now; this.routing.sweep();
    }
    if (now - (this.lastReceiptsAt ?? 0) >= (this.config.taskReceiptsIntervalMs ?? 15000)) {
      this.lastReceiptsAt = now; this.refreshReceipts();
    }
    this.pump();
  }
  /** 执行是否已陈旧到不可能恢复。用 times.received 判定——updated_at 会被反复刷新，不诚实。 */
  staleExecution(e, now, maxAge) {
    const received = Number(e.data?.times?.received);
    return Number.isFinite(received) && now - received > maxAge;
  }
  /** 放弃一条不可能的恢复：执行置终态 failed（放开 pump 与 busy），reply 行一并终结。 */
  abandonStale(e, journal) {
    const detail = '超过 replyRecoveryMaxAgeMs 仍无 outcome：DSH 会话已不在，放弃恢复';
    this.routing.setExecution(e.id, 'failed', { staleAbandonedAt: Date.now(), staleDetail: detail });
    let rows = 0;
    try { rows = journal.abandon(e.turn_id, detail); } catch (error) { this.ctx.logger.warn('qq-bridge: 终结陈旧 reply 失败 —— ' + error.message); }
    this.ctx.logger.warn(`qq-bridge: 放弃陈旧恢复 ${e.conversation} / ${e.id}（reply 行 ${rows} 条）—— ${detail}`);
  }
  refreshReceipts() {
    for (const r of this.store.db.prepare('SELECT id FROM bridge_executions WHERE turn_id IS NOT NULL ORDER BY updated_at DESC LIMIT 500').all()) {
      const e = this.routing.execution(r.id), journal = this.state.replyJournal?.get(e.turn_id);
      if (!journal?.plan || e.data.times.firstSent) continue;
      const ids = journal.plan.bubbles.flatMap((_, i) => [journal.plan.idemBase + '#b' + i, journal.plan.idemBase + '#b' + i + '#noat']);
      if (journal.plan.sticker != null) ids.push(journal.plan.idemBase + '#s');
      const receipts = ids.map((id) => this.store.getReceipt(id)).filter((r) => r?.status === 'SUCCEEDED' && r.updatedAt);
      if (receipts.length) this.routing.setExecution(e.id, e.state, { times: { ...e.data.times, firstSent: Math.min(...receipts.map((r) => r.updatedAt)) } });
    }
  }
  pump() {
    if (!this.enabled || this.mode !== 'enabled' || !this.state.enabled || this.state.disposed || this.state.controller?.signal.aborted) return;
    const max = this.config.taskConcurrency ?? 3, perConversation = this.config.taskConversationConcurrency ?? 2;
    const running = () => [...this.active.values()];
    while (running().length < max) {
      const queued = this.store.db.prepare(`SELECT * FROM bridge_executions WHERE state='queued'
        AND COALESCE(json_extract(data,'$.retryAt'),0)<=? AND task_id NOT IN
        (SELECT task_id FROM bridge_executions WHERE state IN ('starting','following','recovering','needs_attention'))
        ORDER BY CASE WHEN conversation||':'||owner>? THEN 0 ELSE 1 END, conversation,owner,created_at,rowid LIMIT ?`)
        .all(Date.now(), this.lastBucket, this.config.taskDispatchScanLimit ?? 128).map((r) => ({ ...r, data: JSON.parse(r.data) }));
      const eligible = queued.filter((e) => {
        if (e.data.retryAt > Date.now()) return false;
        if ([...this.active.values()].some((r) => r.task_id === e.task_id)) return false;
        if (this.store.db.prepare("SELECT 1 FROM bridge_executions WHERE task_id=? AND state IN ('starting','following','recovering','needs_attention') AND id!=?").get(e.task_id,e.id)) return false;
        return running().length < max &&
          running().filter((r) => r.conversation === e.conversation).length < perConversation &&
          running().filter((r) => r.conversation === e.conversation && r.owner === e.owner).length < (this.config.taskOwnerConcurrency ?? 2);
      });
      const buckets = [...new Set(eligible.map((e) => e.conversation + ':' + e.owner))].sort();
      if (!buckets.length) break;
      const next = buckets.find((b) => b > this.lastBucket) ?? buckets[0];
      const e = eligible.find((e) => e.conversation + ':' + e.owner === next); this.lastBucket = next;
      this.routing.setExecution(e.id, 'starting', { times: { ...e.data.times, started: Date.now() } });
      this.active.set(e.id, e);
      const dialogue = this.routing.get(e.task_id)?.data.sessionMode === 'conversation';
      this.registry.run(e.conversation, () => this.run(e), { lane: dialogue ? 'execution' : 'task-execution', taskId: e.task_id })
        .catch((error) => {
          if (this.state.disposed) return;
          const row = this.routing.execution(e.id);
          if (row.turn_id) this.routing.setExecution(e.id, 'recovering');
          else if ((row.data.attempts ?? 0) < 2) this.routing.setExecution(e.id, 'queued', { attempts: (row.data.attempts ?? 0) + 1, retryAt: Date.now() + 5000 });
          else this.routing.setExecution(e.id, 'needs_attention');
          // 记堆栈而不只是 message：`Converting circular structure to JSON` 这类
          // 序列化失败光看 message 定位不到是哪个 stringify，只有堆栈能。
          this.stats.lastError = '任务执行失败: ' + String(error?.stack ?? error).slice(0, 800);
        }).finally(() => { this.active.delete(e.id); queueMicrotask(() => this.pump()); });
    }
  }
  async run(e) {
    const { ctx, config, registry, state, memory, stats, store, sendQueue } = this;
    const current = this.routing.execution(e.id), task = this.routing.get(e.task_id);
    if (current.data.retryAt > Date.now()) { this.routing.setExecution(e.id,'queued'); return; }
    const event = current.data.event;
    if (task.state === 'cancelled' || registry.entry(e.conversation).recalledIds.includes(String(event.message_id))) {
      this.routing.setExecution(e.id, 'cancelled'); return;
    }
    if (task.version !== current.data.taskVersion) { this.routing.setExecution(e.id, 'superseded'); return; }
    this.store.db.prepare("UPDATE bridge_task_entities SET state='running',updated_at=? WHERE id=? AND state!='cancelled'").run(Date.now(),e.task_id);
    const inputEvents = current.data.inputEvents ?? [event];
    const floorPolicy = { ...captureFloor(config, registry, e.conversation, inputEvents),
      version: current.data.floorVersion, stableTaskId: e.task_id, taskVersion: current.data.taskVersion, task: true };
    const scoped = taskRegistry(registry, this.routing, e.task_id);
    const result = await executeTurn(ctx, config, scoped, state, memory, stats, store, e.conversation, event, {
      signal: state.controller?.signal, sendQueue, consumePending: false, inputEvents, floorPolicy,
      executionId: e.id, stableTaskId: e.task_id,
    });
    const latest = this.routing.execution(e.id);
    const outcome = latest.turn_id && state.replyJournal?.get(latest.turn_id)?.outcome;
    if (outcome) this.routing.summary(e.task_id, latest, outcome);
    else if (!latest.turn_id) this.store.db.prepare("UPDATE bridge_task_entities SET state='declined',updated_at=? WHERE id=? AND version=?")
      .run(Date.now(), e.task_id, current.data.taskVersion);
    this.routing.setExecution(e.id, result?.wait ? 'waiting_input' : latest.turn_id ? 'model_finished' : 'declined');
    scoped.persist(e.conversation);
  }
  snapshot() { return { enabled: this.enabled, mode: this.mode, active: this.active.size,
    concurrency: this.config.taskConcurrency ?? 3, perConversation: this.config.taskConversationConcurrency ?? 2,
    fairness: 'conversation-owner-round-robin', ...this.routing.snapshot() }; }
}
