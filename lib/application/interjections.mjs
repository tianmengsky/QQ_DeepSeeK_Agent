import { randomUUID } from 'node:crypto';
import { contextMessage, sortWindow } from '../conversation/context.mjs';

/**
 * 同一个会话里正在跑的执行，最新启动的在前。
 *
 * 为什么按 `times.started` 倒序："注入"要并进**正在思考的那一轮**。同一会话允许
 * 两条并发执行（`taskConversationConcurrency` 默认 2），较旧的那条往往是残留，
 * 新的才是用户眼前这一轮；挑错回合等于把话喂进一段已经跑偏的上下文。
 */
function runningExecutions(scheduler, key) {
  return [...scheduler.active.values()]
    .filter((e) => e.conversation === key && !e.data?.detached)
    .sort((a, b) => Number(b.data?.times?.started ?? b.created_at ?? 0) -
      Number(a.data?.times?.started ?? a.created_at ?? 0));
}

/**
 * 一轮"还活着、还能被注入"的判定。
 *
 * 四条缺一不可：执行仍在 `following`、reply journal 仍在 `active`、
 * 对应 DSH Session 的 Agent 仍 `running`、且它真的暴露了 `inject`。
 *
 * 为什么必须这么严：`agent.inject` = `send(input, 'next-step', false)`，**不唤醒**任何东西。
 * 回合已经结束时调用它，这条消息既不会被处理，也不会回到队列 —— 轻则压到下一轮才被看见
 * （迟到的话答的是早已结束的话题），重则一直留在 inbox 里。比排队更糟。
 */
function liveTurn(scheduler, executionId) {
  const { ctx, state } = scheduler;
  const execution = scheduler.routing.execution(executionId);
  if (!execution) return null;
  const journal = execution.turn_id && state.replyJournal?.get(execution.turn_id);
  if (!journal || !state.replyJournal?.active?.has(journal.id) || execution.state !== 'following') return null;
  const sessionId = journal.meta?.sessionId;
  const agent = sessionId && (ctx.get?.('agents') ?? ctx.agents)?.get(sessionId);
  if (!agent?.inject || agent.status !== 'running') return null;
  return { execution, journal, agent };
}

/**
 * 注入正文。两种语义的措辞不能混用：
 *   · amend = 原作者在执行中改需求（原本轮仍是他的，只是要求变了）
 *   · all   = 这一轮还没结束，又来了新消息（作者可能不同，目标是"别另起一轮"）
 */
function instruction(mode, timeline) {
  const payload = JSON.stringify(timeline);
  if (mode === 'amend')
    return '【原请求作者在本轮执行中的补充】\n' + payload +
      '\n将这些真实消息纳入当前任务，调整下一步及最终结果。来源和会话仍属于原本轮；不要把补充当成另一个人的独立请求。此前尚未投递的答案需重新核对；已发送的进度不能撤销。';
  return '【本轮还在进行时收到的新消息】\n' + payload +
    '\n这一轮还没结束：把这些消息并进当前这一轮，调整下一步和最终答复，不要另起一轮、也不要重复已经发出去的内容。' +
    '它们若是背景闲聊，最终答复仍以原请求为准。来源和会话仍属于本轮；不要把它们当成另一个人的独立请求。';
}

/**
 * 把一批输入写进**已经在跑**的那一轮。
 *
 * 顺序是有意的，不要调换：
 *   ① 先在事务里认领 message/input ID（bridge_input_routes）——
 *      认领之后即使注入本身结果未知，也绝不允许同一条输入再被当成新请求排一次；
 *   ② 再把输入并进执行、reply journal 与窗口；
 *   ③ 最后才 `agent.inject`。它不确定时执行转 `needs_attention`，让人核对 inbox，
 *      绝不静默丢、也不自动重发。
 */
function injectInTurn(scheduler, key, events, { execution, journal, agent, task, mode, route }) {
  const { registry, store, stats } = scheduler;
  const ids = events.map((e) => e.__inputId ?? `${e.self_id}:${e.message_id}`);
  const claimed = ids.map((id) => store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE id=?').get(id));
  // 已经认领过 = 上一次注入已经生效（或至少已经写进 inbox），幂等返回成功。
  if (claimed.every(Boolean)) return true;
  if (claimed.some(Boolean)) return false;
  const rpcId = 'qq-interject:' + randomUUID();
  const timeline = sortWindow(events.map(contextMessage));
  const message = Object.freeze({ id: randomUUID(), role: 'user',
    source: Object.freeze({ kind: 'user', rpcId }),
    content: Object.freeze([Object.freeze({ type: 'text', text: instruction(mode, timeline) })]) });
  // Commit input ownership BEFORE touching the DSH inbox. An uncertain crash is
  // recoverable evidence, never permission to enqueue the same amendment again.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [i, event] of events.entries()) store.db.prepare('INSERT INTO bridge_input_routes VALUES (?,?,?,?,?)')
      .run(ids[i], key, String(event.message_id), task.id, execution.id);
    const inputEvents = [...(execution.data.inputEvents ?? []), ...events];
    scheduler.routing.setExecution(execution.id, execution.state, { inputEvents,
      interjections: [...(execution.data.interjections ?? []), { rpcId, inputIds: ids, at: Date.now(), mode }] });
    store.db.prepare('UPDATE bridge_task_entities SET data=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...task.data,
      messageIds: [...new Set([...(task.data.messageIds ?? []), ...events.filter((e) => !e.__inputPassive).map((e) => String(e.message_id))])].slice(-200) }), Date.now(), task.id);
    store.db.prepare('INSERT INTO bridge_routes(conversation,mode,action,confidence,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(key, 'enabled', mode === 'amend' ? 'amend' : 'interject', route?.confidence ?? 1, JSON.stringify({
        ...(route ?? {}), action: mode === 'amend' ? 'amend' : 'interject',
        reason: mode === 'amend' ? 'in-turn-injection' : 'forced-in-turn-injection', rpcId }), Date.now());
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  try {
    agent.inject(message);
  } catch (error) {
    // Suppress the unrevised final draft as well as further tools. A claimed
    // but uncertain injection must not silently fall back to the old answer.
    store.db.prepare("UPDATE bridge_task_entities SET state='needs_attention',version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(Date.now(), task.id, task.version);
    scheduler.routing.setExecution(execution.id, 'needs_attention', { injectionError: String(error.message).slice(0, 160) });
    if (mode === 'amend') stats.amendInjectionFailed = (stats.amendInjectionFailed ?? 0) + 1;
    else stats.forcedInjectionFailed = (stats.forcedInjectionFailed ?? 0) + 1;
    stats.lastError = (mode === 'amend' ? '插话已认领但注入未确认' : '强制注入已认领但注入未确认') + '，需核对 DSH inbox';
    return true;
  }
  const originals = [...(journal.meta.floorPolicy?.originals ?? execution.data.inputEvents ?? []), ...events];
  const policy = { ...journal.meta.floorPolicy, originals,
    messageIds: [...new Set([...(journal.meta.floorPolicy?.messageIds ?? []), ...events.map((e) => String(e.message_id))])] };
  if (journal.meta.sourceRef)
    store.setState('qq-bridge:floor-source:' + journal.meta.sourceRef, JSON.stringify({ key, policy }));
  store.db.prepare('UPDATE bridge_replies SET meta=? WHERE id=?').run(JSON.stringify({ ...journal.meta, floorPolicy: policy,
    inputIds: [...new Set([...(journal.meta.inputIds ?? []), ...ids])] }), journal.id);
  for (const event of events) registry.record(registry.entry(key), contextMessage(event));
  const entry = registry.entry(key);
  entry.contextChars = (entry.contextChars ?? 0) + message.content[0].text.length;
  registry.persist(key);
  if (mode === 'amend') stats.humanInterjections = (stats.humanInterjections ?? 0) + 1;
  else stats.forcedInterjections = (stats.forcedInterjections ?? 0) + 1;
  return true;
}

/**
 * 强制注入（`inTurnInjectionMode: all`）：只要有在跑的回合，就把这批 QQ 消息
 * 并进那一轮，不调语义路由、不新建任务、不另起回合。
 *
 * 判定比 amend 宽：不要求"原作者"、不要求路由判成 amend，只要求这一轮**确实还在跑**。
 * 代价是作者与任务归属不再严格对应 —— 这正是"强制"的含义：宁可让这一轮多看见一句话，
 * 也不要让她先答完再纠正一遍。
 */
export function injectRunningTurn(scheduler, key, events) {
  const { store } = scheduler;
  // 任何一条已经被别的执行认领过，就不该再试下一轮（否则事务会撞主键）。
  if (events.some((e) => store.db.prepare('SELECT 1 FROM bridge_input_routes WHERE id=?')
    .get(e.__inputId ?? `${e.self_id}:${e.message_id}`))) return false;
  for (const candidate of runningExecutions(scheduler, key)) {
    const live = liveTurn(scheduler, candidate.id);
    if (!live) continue;
    const task = live.execution.task_id ? scheduler.routing.get(live.execution.task_id) : null;
    if (!task || task.state === 'cancelled') continue;
    // 版本对不上 = 这一轮已经被修订过，注进旧轮次会答一个过期要求。
    if (live.execution.data.taskVersion !== undefined && live.execution.data.taskVersion !== task.version) continue;
    if (injectInTurn(scheduler, key, events, { ...live, task, mode: 'all', route: null })) return true;
  }
  return false;
}

/** 原作者在执行中改需求：只注入他本人的、仍匹配当前任务版本的那一轮。 */
export function injectOwnedAmendment(scheduler, key, events, route) {
  if (route.action !== 'amend' || !route.taskId) return false;
  const { ctx, routing, state } = scheduler;
  const task = routing.get(route.taskId), owner = String(events.find(e => !e.__inputPassive)?.user_id);
  if (!task || task.conversation !== key || task.owner !== owner || task.state === 'cancelled') return false;
  const running = runningExecutions(scheduler, key).find((e) => e.task_id === task.id);
  const worker = [...(state.delegatedWork?.live.values() ?? [])].find(j => state.delegatedWork.get(j.id)?.task_id === task.id &&
    state.delegatedWork.get(j.id)?.state === 'running');
  /**
   * ⚠️ 这里必须自己判空，不能把 `undefined` 直接喂给 `routing.execution()`。
   *
   * 原来的写法是 `routing.execution(running?.id ?? (worker && ...))` —— 当既没有在跑的
   * 回合、也没有 worker 时，这个表达式的值是 `undefined`，于是走到
   * `SELECT * FROM bridge_executions WHERE id=?` 并抛
   * `TypeError: Provided value cannot be bound to SQLite parameter 1`。
   *
   * 后果不是"注入失败"，而是 `TaskScheduler.admit()` **整条抛错**：输入批次既不注入、
   * 也不落到下面的持久化修订路径，那条补充直接丢失。
   * 这个 bug 只在 `route.action === 'amend'` 时才会触发，而 amend 此前线上产出为 0，
   * 所以一直被掩盖着 —— 一旦路由修好、amend 开始出现，它就会立刻发作。
   */
  const executionId = running?.id ?? (worker ? state.delegatedWork.get(worker.id)?.data?.executionId : null);
  const execution = executionId ? routing.execution(executionId) : null;
  if (!execution) return false;
  const journal = execution.turn_id && state.replyJournal?.get(execution.turn_id);
  const parent = journal?.meta.sessionId && (ctx.get?.('agents') ?? ctx.agents)?.get(journal.meta.sessionId);
  const agent = worker?.run?.localAgent ?? parent;
  if (!journal || (!worker && (!state.replyJournal?.active?.has(journal.id) || execution.state !== 'following')) ||
      execution.data.taskVersion !== task.version || !agent?.inject || agent.status !== 'running') return false;
  return injectInTurn(scheduler, key, events, { execution, journal, agent, task, mode: 'amend', route });
}
