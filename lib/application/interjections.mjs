import { randomUUID } from 'node:crypto';
import { contextMessage, sortWindow } from '../conversation/context.mjs';

/** Synchronous inject never wakes an idle Agent or creates an unowned turn. */
export function injectOwnedAmendment(scheduler, key, events, route) {
  if (route.action !== 'amend' || !route.taskId) return false;
  const { ctx, routing, registry, state, store, stats } = scheduler;
  const task = routing.get(route.taskId), owner = String(events.find(e => !e.__inputPassive)?.user_id);
  if (!task || task.conversation !== key || task.owner !== owner || task.state === 'cancelled') return false;
  const running = [...scheduler.active.values()].find(e => e.task_id === task.id && !e.data.readOnly);
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
  if (!journal || (!worker && (!state.replyJournal.active.has(journal.id) || execution.state !== 'following')) ||
      execution.data.taskVersion !== task.version || !agent?.inject || agent.status !== 'running') return false;
  const ids = events.map(e => e.__inputId ?? `${e.self_id}:${e.message_id}`);
  const claimed = ids.map(id => store.db.prepare('SELECT execution_id FROM bridge_input_routes WHERE id=?').get(id));
  if (claimed.every(Boolean)) return true;
  if (claimed.some(Boolean)) return false;
  const rpcId = 'qq-interject:' + randomUUID();
  const timeline = sortWindow(events.map(contextMessage));
  const message = Object.freeze({ id: randomUUID(), role: 'user',
    source: Object.freeze({ kind: 'user', rpcId }),
    content: Object.freeze([Object.freeze({ type: 'text', text:
      '【原请求作者在本轮执行中的补充】\n' + JSON.stringify(timeline) +
      '\n将这些真实消息纳入当前任务，调整下一步及最终结果。来源和会话仍使用原本轮 source_ref；不要把补充当成另一个人的独立请求。此前尚未投递的答案需重新核对；已发送的进度不能撤销。' })]) });
  // Commit input ownership BEFORE touching the DSH inbox. An uncertain crash is
  // recoverable evidence, never permission to enqueue the same amendment again.
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const [i, event] of events.entries()) store.db.prepare('INSERT INTO bridge_input_routes VALUES (?,?,?,?,?)')
      .run(ids[i], key, String(event.message_id), task.id, execution.id);
    const inputEvents = [...execution.data.inputEvents, ...events];
    routing.setExecution(execution.id, execution.state, { inputEvents,
      interjections: [...(execution.data.interjections ?? []), { rpcId, inputIds: ids, at: Date.now() }] });
    store.db.prepare('UPDATE bridge_task_entities SET data=?,updated_at=? WHERE id=?').run(JSON.stringify({ ...task.data,
      messageIds: [...new Set([...task.data.messageIds, ...events.filter(e => !e.__inputPassive).map(e => String(e.message_id))])].slice(-200) }), Date.now(), task.id);
    store.db.prepare('INSERT INTO bridge_routes(conversation,mode,action,confidence,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(key, 'enabled', 'amend', route.confidence, JSON.stringify({ ...route, reason: 'in-turn-injection', rpcId }), Date.now());
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  try {
    agent.inject(message);
  } catch (error) {
    // Suppress the unrevised final draft as well as further tools. A claimed
    // but uncertain injection must not silently fall back to the old answer.
    store.db.prepare("UPDATE bridge_task_entities SET state='needs_attention',version=version+1,updated_at=? WHERE id=? AND version=?")
      .run(Date.now(), task.id, task.version);
    routing.setExecution(execution.id, 'needs_attention', { injectionError: String(error.message).slice(0, 160) });
    stats.amendInjectionFailed = (stats.amendInjectionFailed ?? 0) + 1;
    stats.lastError = '插话已认领但注入未确认，需核对 DSH inbox';
    return true;
  }
  const originals = [...(journal.meta.floorPolicy?.originals ?? execution.data.inputEvents ?? []), ...events];
  const policy = { ...journal.meta.floorPolicy, originals,
    messageIds: [...new Set([...(journal.meta.floorPolicy?.messageIds ?? []), ...events.map(e => String(e.message_id))])] };
  store.setState('qq-bridge:floor-source:' + journal.meta.sourceRef, JSON.stringify({ key, policy }));
  store.db.prepare('UPDATE bridge_replies SET meta=? WHERE id=?').run(JSON.stringify({ ...journal.meta, floorPolicy: policy,
    inputIds: [...new Set([...(journal.meta.inputIds ?? []), ...ids])] }), journal.id);
  if (worker) state.delegatedWork.save(worker.id, 'running', { lastAmendment: timeline.map(m => m.text).join('\n').slice(0, 1000) });
  for (const event of events) registry.record(registry.entry(key), contextMessage(event));
  const entry = registry.entry(key);
  entry.contextChars = (entry.contextChars ?? 0) + message.content[0].text.length;
  registry.persist(key);
  stats.humanInterjections = (stats.humanInterjections ?? 0) + 1;
  return true;
}
