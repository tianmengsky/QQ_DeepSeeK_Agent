import { randomUUID } from 'node:crypto';
import { assertExecutionSource, executionSource, closeExecutionSource } from '../agent/execution-scope.mjs';
import { DOCUMENT_TOOLS } from '../agent/tool-sets.mjs';
import { speechTarget, speechReceipt } from '../agent/runner.mjs';
import { contextMessage } from '../conversation/context.mjs';

export const DELEGATION_TOOLS = ['qq_delegate', 'qq_delegate_status', 'qq_delegate_control', 'qq_job_progress'];
const childTools = ['web_search', 'web_fetch', 'mcp__qq__qq_workspace', 'mcp__qq__qq_say', 'qq_job_progress',
  ...DOCUMENT_TOOLS.map(name => 'mcp__document-editor__' + name)];
const activeStates = new Set(['queued', 'starting', 'running']);
const decode = row => row && { ...row, data: JSON.parse(row.data) };

/** DSH owns the child Agent; the bridge owns QQ source, completion and recovery. */
export class DelegatedWork {
  constructor({ ctx, config, registry, state, store, stats }) {
    Object.assign(this, { ctx, config, registry, state, store, stats });
    this.live = new Map(); this.closed = false;
    // No restart of uncertain work: native sessions can have already written files.
    const interrupted = store.db.prepare("SELECT data FROM bridge_workers WHERE state IN ('queued','starting','running')").all();
    store.db.prepare("UPDATE bridge_workers SET state='needs_attention',updated_at=? WHERE state IN ('queued','starting','running')")
      .run(Date.now());
    for (const row of interrupted) closeExecutionSource(store, JSON.parse(row.data).sourceRef);
  }
  service() { return this.ctx.get?.('subagents') ?? this.ctx.subagents; }
  get(id) { return decode(this.store.db.prepare('SELECT * FROM bridge_workers WHERE id=?').get(id)); }
  rows(key) { return this.store.db.prepare('SELECT * FROM bridge_workers WHERE conversation=? ORDER BY created_at DESC LIMIT 20').all(key).map(decode); }
  save(id, state, patch = {}) {
    if (this.closed || this.state.disposed) return;
    const row = this.get(id); if (!row) return;
    this.store.db.prepare('UPDATE bridge_workers SET state=?,data=?,updated_at=? WHERE id=?')
      .run(state, JSON.stringify({ ...row.data, ...patch }), Date.now(), id);
  }
  source(args, exec) {
    if (!this.state.enabled || this.state.disposed || this.closed) throw new Error('托管已关闭');
    const ref = this.store.getState('qq-bridge:execution-session:' + exec.agent?.session?.id);
    if (!ref || ref !== args.source_ref) throw new Error('子代理工具需要当前真实 Session 的 source_ref');
    const origin = this.state.sourceLedger.resolve(ref);
    if (!origin) throw new Error('来源已过期或撤回');
    const source = assertExecutionSource(this.store, origin);
    if (!source) throw new Error('子代理需要持久任务来源');
    return { source, origin };
  }
  async start(args, exec) {
    if (typeof args.description !== 'string' || !args.description.trim() || args.description.length > 100 ||
        typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 20000)
      throw new Error('委派需要非空 description（最多100字符）和完整 prompt（最多20000字符）');
    const { source } = this.source(args, exec), service = this.service();
    if (!service?.getProvider('spawn')) throw new Error('DSH spawn 子代理服务不可用；不要声称已委派');
    // One live worker per execution prevents accidental duplicate delegation.
    const existing = decode(this.store.db.prepare("SELECT * FROM bridge_workers WHERE json_extract(data,'$.executionId')=? AND state IN ('queued','starting','running') LIMIT 1").get(source.executionId));
    if (existing) return { job_id: existing.id, state: existing.state, reused: true };
    if (this.live.size >= 32) throw new Error('子代理待办已满，请先处理现有任务');
    const id = 'worker-' + randomUUID(), now = Date.now();
    const original = this.state.taskRouting.execution(source.executionId);
    if (original?.data.delegatedResult) throw new Error('本轮正在交付子代理结果，不能重新委派同一任务');
    const expiresAt = now + 15 * 60000;
    this.store.setState('qq-bridge:execution-source:' + source.sourceRef, JSON.stringify({ ...source, expiresAt }));
    this.store.db.prepare('UPDATE memory_origins SET expires_at=MAX(expires_at,?) WHERE ref=?').run(expiresAt, source.sourceRef);
    this.store.db.prepare('INSERT INTO bridge_workers VALUES (?,?,?,?,?,?,?,?)').run(id, source.conversation, source.taskId,
      original.owner, 'queued', JSON.stringify({ sourceRef: source.sourceRef, executionId: source.executionId,
        taskVersion: source.taskVersion, parentSessionId: exec.agent.session.id,
        title: String(args.description).slice(0, 100), prompt: String(args.prompt).slice(0, 20000), expiresAt }), now, now);
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.state.controller.signal, AbortSignal.timeout(15 * 60000)]);
    const job = { id, conversation: source.conversation, controller, signal, parent: exec.agent, args, source, done: null, run: null };
    this.live.set(id, job);
    await this.dispatch();
    const row = this.get(id);
    return { job_id: id, agent_id: row.data.childSessionId ?? null, state: row.state,
      delivery: '已持久认领；并发满时等待空位，工作结果由桥接交回主窗口' };
  }
  dispatch() {
    if (this.dispatchPromise) return this.dispatchPromise;
    this.dispatchPromise = (async () => {
      for (const job of this.live.values()) {
        if (this.closed || this.state.disposed) return;
        const row = this.get(job.id), task = this.state.taskRouting?.get(row.task_id);
        if (row.state !== 'queued') continue;
        if (!task || task.state === 'cancelled' || task.version !== row.data.taskVersion || job.signal.aborted || !this.state.sourceLedger.resolve(row.data.sourceRef)) {
          this.save(job.id, 'cancelled'); this.live.delete(job.id); continue;
        }
        const working = [...this.live.values()].filter(j => ['starting','running'].includes(this.get(j.id)?.state));
        if (working.length >= 3) break;
        if (working.filter(j => j.conversation === job.conversation).length >= 2) continue;
        await this.launch(job);
      }
    })().finally(() => { this.dispatchPromise = null; });
    return this.dispatchPromise;
  }
  async launch(job) {
    const { id, args, parent, source, signal, controller } = job, service = this.service();
    try {
      this.save(id, 'starting');
      const run = await service.start('spawn', { parent, signal, label: args.description,
        maxDepth: 1, toolFilter: { allow: childTools },
        persona: '你是 QQ 对话窗口下的工作子代理，完成父代理明确委派的代码、写作或研究，文件保存在当前 QQ 会话工作区。' +
          '用 qq_job_progress 保存实际阶段摘要；有重要阶段变化时用 qq_say 发可观察的简短进度。成果、路径、实际验证和限制交回父代理，由父代理核对最终投递。工作范围沿用本次委派与来源。' +
          '操作示范：写好 game.html → 回报路径及实际检查；文件缺少必需资料 → 保存具体阻碍并向父代理说明。',
        prompt: [{ type: 'text', text: JSON.stringify({ conversation: source.conversation, source_ref: source.sourceRef,
          job_id: id, task: args.prompt, workspace: parent.session.header?.cwd }) }] });
      job.run = run;
      // Require a local native child so authority and injection use real Sessions.
      if (!run.localAgent?.session?.id) { controller.abort(); await run.dispose(); throw new Error('子代理必须为 DSH 本地 Agent'); }
      this.store.setState('qq-bridge:execution-session:' + run.localAgent.session.id, source.sourceRef);
      this.save(id, 'running', { childSessionId: run.localAgent.session.id });
      job.done = this.finish(job, run).catch(error => {
        if (!this.closed && !this.state.disposed) {
          this.save(id, 'needs_attention', { error: String(error.message).slice(0, 500) });
          this.ctx.logger.warn('qq-bridge: 子代理结果待核对 ' + String(error.message).slice(0, 160));
        }
      });
    } catch (error) {
      this.live.delete(id); this.save(id, 'failed', { error: String(error.message).slice(0, 500) });
      this.save(id, 'failed', { stopReason: 'error', diagnostic: String(error.message).slice(0, 500), result: '' });
      this.enqueueResult(id);
    }
  }
  async finish(job, run) {
    let result;
    try { result = await run.result; }
    catch (error) { result = { stopReason: 'error', output: [], diagnostic: String(error.message).slice(0, 500) }; }
    if (!this.closed && !this.state.disposed && this.get(job.id)?.state !== 'cancelled') {
      this.save(job.id, result.stopReason === 'completed' ? 'completed' : 'failed', {
        stopReason: result.stopReason, result: (result.output ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n').slice(0, 20000),
        diagnostic: String(result.diagnostic ?? '').slice(0, 500) });
      this.enqueueResult(job.id);
    }
    if (!this.closed && !this.state.disposed) {
      const row = this.get(job.id), source = executionSource(this.store, row.data.sourceRef);
      if (source?.parentClosed) closeExecutionSource(this.store, row.data.sourceRef);
    }
    try { await run.dispose(); }
    catch (error) { if (!this.closed) this.ctx.logger.warn('qq-bridge: 子代理释放失败 ' + String(error.message).slice(0, 160)); }
    this.live.delete(job.id);
    if (!this.closed && !this.state.disposed) queueMicrotask(() => this.dispatch());
  }
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
    const origin = this.state.sourceLedger.resolve(row.data.sourceRef);
    if (!origin) { this.save(id, 'needs_attention', { deliveryError: 'source-expired-or-recalled' }); return; }
    // Deterministic identity: restarting between capture and dispatch cannot duplicate completion.
    const data = { ...original.data, delegatedResult: { jobId: id, state: row.state, result: row.data.result,
      stopReason: row.data.stopReason, diagnostic: row.data.diagnostic },
      event: { ...original.data.event, __delegateResult: id }, attempts: 0, retryAt: 0,
      times: { received: row.updated_at, routed: Date.now() } };
    this.store.db.prepare('INSERT OR IGNORE INTO bridge_executions VALUES (?,?,?,?,?,?,?,?,?)')
      .run(executionId, row.task_id, row.conversation, row.owner, 'queued', null, JSON.stringify(data), Date.now(), Date.now());
    this.save(id, row.state, { completionExecutionId: executionId });
    queueMicrotask(() => this.state.taskScheduler?.pump());
  }
  reconcile() {
    if (this.closed || this.state.disposed) return;
    for (const [id, job] of this.live) {
      const row = this.get(id), task = this.state.taskRouting?.get(row.task_id);
      const recalled = !this.state.sourceLedger.resolve(row.data.sourceRef);
      if (!task || task.state === 'cancelled' || task.version !== row.data.taskVersion || recalled) {
        this.save(id, 'cancelled'); job.controller.abort();
      }
      if (!job.run && this.get(id).state === 'cancelled') {
        this.live.delete(id);
        const source = executionSource(this.store, row.data.sourceRef);
        if (source?.parentClosed) closeExecutionSource(this.store, row.data.sourceRef);
      }
    }
    for (const row of this.store.db.prepare("SELECT id FROM bridge_workers WHERE state IN ('completed','failed') AND json_extract(data,'$.completionExecutionId') IS NULL AND updated_at>?").all(Date.now() - 86400000)) this.enqueueResult(row.id);
    this.dispatch();
  }
  bindChild(agent) {
    if (this.closed || this.state.disposed || !agent?.session?.header?.parentSession) return;
    for (const job of this.live.values()) {
      const row = this.get(job.id);
      if (row.state === 'starting' && row.data.parentSessionId === agent.session.header.parentSession) {
        this.store.setState('qq-bridge:execution-session:' + agent.session.id, row.data.sourceRef);
        this.save(row.id, row.state, { childSessionId: agent.session.id });
        return;
      }
    }
  }
  control(args, exec) {
    if (!['amend', 'cancel'].includes(args.action) || args.action === 'amend' &&
        (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000))
      throw new Error('控制 action 必须为 amend/cancel，修改需要非空 message（最多4000字符）');
    const { source, origin } = this.source(args, exec), row = this.get(args.job_id);
    if (!row || row.conversation !== source.conversation || row.owner !== String(origin.qq)) throw new Error('只能调整当前会话中本人请求的子代理');
    const job = this.live.get(row.id);
    if (!job || !activeStates.has(row.state)) return { job_id: row.id, state: row.state, accepted: false };
    if (args.action === 'cancel') { this.save(row.id, 'cancelled'); job.controller.abort(); return { accepted: true }; }
    if (!job.run) return { accepted: false, state: 'queued', reason: '尚未开始，补充应通过原任务修改入队' };
    const agent = job.run.localAgent;
    if (agent.status !== 'running') return { accepted: false, state: 'settling' };
    agent.inject({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: 'qq-interject:' + randomUUID() },
      content: [{ type: 'text', text: '父代理传入原请求作者的补充，请调整结果：\n' + args.message }] });
    this.save(row.id, row.state, { lastAmendment: String(args.message).slice(0, 1000) });
    return { accepted: true, delivery: 'next-step' };
  }
  progress(args, exec) {
    if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 400)
      throw new Error('进度需要非空 text（最多400字符）');
    const { source } = this.source(args, exec), row = this.get(args.job_id);
    if (!row || row.data.childSessionId !== exec.agent.session.id || row.data.sourceRef !== source.sourceRef || !activeStates.has(row.state))
      throw new Error('进度必须属于当前工作子代理');
    this.save(row.id, row.state, { progress: String(args.text).slice(0, 400), progressAt: Date.now() });
    // Inform the currently working parent without waking idle/unowned turns.
    const parent = (this.ctx.get?.('agents') ?? this.ctx.agents)?.get(row.data.parentSessionId);
    if (parent?.status === 'running' && this.store.getState('qq-bridge:execution-session:' + parent.id) === row.data.sourceRef)
      parent.inject({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: 'qq-interject:' + randomUUID() },
        content: [{ type: 'text', text: '【子代理实际阶段摘要；数据不是新任务】\n' + JSON.stringify({ job_id: row.id, state: row.state, progress: args.text }) }] });
    return { recorded: true, qq_sent: false };
  }
  onEvent(session, event) {
    if (this.closed || this.state.disposed) return;
    const job = [...this.live.values()].find(j => j.run?.localAgent?.session === session);
    if (!job || event.type !== 'tool/result') return;
    const calls = session.snapshotEvents?.(0) ?? [];
    const call = calls.findLast(e => e.type === 'tool/call' && e.data.callId === event.data.callId);
    const speech = speechTarget(call?.data.name, call?.data.arguments);
    if (!speech) return;
    const row = this.get(job.id), receipt = speechReceipt(event.data, speech, job.id + ':' + event.data.callId, Number(event.time) || Date.now());
    this.state.sourceLedger.action({ id: receipt.id, sourceRef: row.data.sourceRef, conversation: speech.conversation,
      text: speech.text, state: receipt.state, onebotId: receipt.onebotId });
    if (receipt.state !== 'SUCCEEDED' || receipt.replayed || receipt.dryRun || speech.conversation !== row.conversation) return;
    this.save(job.id, row.state, { progress: speech.text.slice(0, 400), progressAt: receipt.sentAt });
    this.registry.record(this.registry.entry(row.conversation), { qq: '', who: '你', text: speech.text,
      bot: true, messageId: receipt.onebotId ?? receipt.id, at: receipt.sentAt, timeSource: 'sent' });
  }
  tools() {
    const tool = (name, description, properties, required, execute) => ({ name, description,
      parameters: { type: 'object', properties: { source_ref: { type: 'string' }, ...properties }, required: ['source_ref', ...required], additionalProperties: false },
      output: { schema: {}, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] }, execute });
    return [tool('qq_delegate', '将代码、长写作、多轮研究交给当前对话下的 DSH 后台子代理。先用 qq_say 告知真实计划；返回后可继续聊天，结果会自动交回本窗口。prompt 包含完整需求和验收要求。',
      { description: { type: 'string', description: '简短任务名称，最多100字符' }, prompt: { type: 'string', description: '完整需求与验收要求，最多20000字符' } }, ['description', 'prompt'], (a,e) => this.start(a,e)),
    tool('qq_delegate_status', '读取本 QQ 会话子代理的实际状态和阶段摘要；不唤醒、不重做。', {}, [], (a,e) => {
      const { source } = this.source(a,e); return this.rows(source.conversation).map(r => ({ job_id: r.id, task_id: r.task_id,
        state: r.state, title: r.data.title, progress: r.data.progress ?? '', updated_at: r.updated_at, result: r.data.result?.slice(0, 2000) })); }),
    tool('qq_delegate_control', '向本人请求的工作子代理注入补充或取消；注入在下一步调整结果，不会撤销已发送的内容。',
      { job_id: { type: 'string' }, action: { type: 'string', enum: ['amend','cancel'] }, message: { type: 'string', description: '修改要求，最多4000字符' } }, ['job_id','action'], (a,e) => this.control(a,e)),
    tool('qq_job_progress', '工作子代理保存实际阶段摘要并通知正在工作的父代理。不会发送 QQ；有值得告知的进展另用 qq_say。',
      { job_id: { type: 'string' }, text: { type: 'string', description: '可观察的阶段摘要，最多400字符' } }, ['job_id','text'], (a,e) => this.progress(a,e))];
  }
  async refreshToolVisibility() {
    if (this.visibilityPromise) return this.visibilityPromise;
    this.visibilityPromise = (async () => {
      const presets = this.ctx.get?.('agentPresets') ?? this.ctx.agentPresets;
      const tools = this.ctx.get?.('tools') ?? this.ctx.tools;
      if (!presets?.acquireScope || !tools?.schemas) return;
      let lease;
      try {
        lease = await presets.acquireScope(this.config.agentPreset);
        const scoped = tools.schemas(lease.key);
        const names = new Set(scoped.map(t => t.name));
        const say = scoped.find(t => t.name === 'mcp__qq__qq_say');
        const declaration = presets.readDocument && await presets.readDocument(this.config.agentPreset);
        this.presetVisibility = { id: this.config.agentPreset, checkedAt: Date.now(),
          visible: DELEGATION_TOOLS.filter(name => names.has(name)), missing: DELEGATION_TOOLS.filter(name => !names.has(name)),
          delegationInstruction: declaration ? declaration.content.includes('qq_delegate 是桥接注册的原生工具') : null,
          positiveContract: declaration ? declaration.content.includes('角色与详细协议由桥接首轮注入') : null,
          promptDescriptions: { count: scoped.length, qqSayChars: say?.description?.length ?? null,
            qqSayCompact: say ? (say.description ?? '').includes('必要的真实进度') : null } };
      } catch {
        this.presetVisibility = { id: this.config.agentPreset, checkedAt: Date.now(), visible: [],
          missing: [...DELEGATION_TOOLS], error: '无法核对当前预设工具作用域' };
      } finally { await lease?.[Symbol.asyncDispose]?.(); }
    })().finally(() => { this.visibilityPromise = null; });
    return this.visibilityPromise;
  }
  toolVisibility() {
    const tools = this.ctx.get?.('tools') ?? this.ctx.tools;
    const agents = this.ctx.get?.('agents') ?? this.ctx.agents;
    const registered = new Set((tools?.schemas?.() ?? []).map(t => t.name));
    const sessions = [...this.registry.byKey].flatMap(([conversation, entry]) => {
      const agent = entry.sessionId && agents?.get(entry.sessionId);
      if (!agent) return [];
      const visible = new Set((tools?.schemas?.(agent) ?? []).map(t => t.name));
      return [{ conversation, sessionId: entry.sessionId, visible: DELEGATION_TOOLS.filter(name => visible.has(name)),
        missing: DELEGATION_TOOLS.filter(name => !visible.has(name)) }];
    });
    return { registered: DELEGATION_TOOLS.filter(name => registered.has(name)), preset: this.presetVisibility ?? null, sessions };
  }
  snapshot() {
    const tools = this.toolVisibility(), nativeAvailable = Boolean(this.service()?.getProvider('spawn'));
    return { available: nativeAvailable && tools.registered.length === DELEGATION_TOOLS.length && tools.preset?.missing.length === 0,
    nativeAvailable, tools,
    active: [...this.live.keys()].filter(id => ['starting','running'].includes(this.get(id)?.state)).length,
    queued: [...this.live.keys()].filter(id => this.get(id)?.state === 'queued').length,
    mode: 'native-spawn-bridge-completion', maxConcurrent: 3, perConversation: 2,
    counts: Object.fromEntries(this.store.db.prepare('SELECT state,COUNT(*) n FROM bridge_workers GROUP BY state').all().map(r => [r.state, r.n])) }; }
  async dispose() {
    this.closed = true;
    for (const job of this.live.values()) job.controller.abort();
    await this.dispatchPromise;
    await Promise.allSettled([...this.live.values()].map(job => job.done));
  }
}
