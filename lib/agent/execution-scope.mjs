import { validateWorkspaceOutput, workspaceRoot } from './workspace.mjs';
import { QQ_SESSION_TOOLS, DOCUMENT_TOOLS } from './tool-sets.mjs';
import { fileAuthority } from '../conversation/task-ownership.mjs';
const prefix = 'qq-bridge:execution-source:';
/**
 * 跨会话发言开关的共享状态键。
 *
 * 发送工具跑在独立进程（qq-mcp），读不到桥接的配置对象；沿用
 * `WORKSPACE_STATE_KEY` 那套，由桥接把当前值写进共享 SQLite，
 * MCP 侧按需读取。这样加开关不必改预设、也不必重启 MCP。
 */
export const CROSS_CONVERSATION_STATE_KEY = 'qq-bridge:allow-cross-conversation';

/** MCP/宿主共用：跨会话是否放行。缺省（未发布过）按关处理。 */
export function crossConversationAllowed(store) {
  return store?.getState?.(CROSS_CONVERSATION_STATE_KEY) === 'true';
}

/**
 * 一轮执行来源的有效期。
 *
 * 必须和 `memory_origins` 的 TTL 用同一套算法：MCP 侧先查 origins（原来的
 * 10 分钟），再查 execution-source（原来是 4 分钟）。两边不一致时，第 4～10
 * 分钟之间第一道放行、第二道报错 —— 这正是"来源看着还有效却总被拒"的来源。
 *
 * 调长这里不会真的放宽权限：回合一结束 `closeExecutionSource` 就把
 * `state` 置为 `closed`，而闸门先看 state 再看时间。所以更长的 TTL 只消除
 * 回合中途的误报，不延长回合结束后的可用窗口。
 */
export function sourceTtlMs(config) {
  return Math.max(600000, Number(config?.replyTimeoutMs ?? 180000) + 60000);
}
export function publishExecutionSource(store, sourceRef, data) {
  if (!sourceRef || !store?.available) throw new Error('task execution requires durable source');
  store.setState(prefix + sourceRef, JSON.stringify({ ...data, sourceRef, state: 'active', at: Date.now() }));
  store.setState('qq-bridge:execution-session:' + data.sessionId, sourceRef);
}
export function closeExecutionSource(store, sourceRef, state = 'closed') {
  const source = executionSource(store, sourceRef);
  if (source && state === 'closed' && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_workers'").get() &&
      store.db.prepare("SELECT 1 FROM bridge_workers WHERE json_extract(data,'$.sourceRef')=? AND state IN ('queued','starting','running')").get(sourceRef)) {
    store.setState(prefix + sourceRef, JSON.stringify({ ...source, parentClosed: true }));
    return;
  }
  if (source) store.setState(prefix + sourceRef, JSON.stringify({ ...source, state, closedAt: Date.now() }));
  // 清掉指向这条来源的 Session 指针。
  //
  // 为什么必须清：会话是按 QQ 会话复用的（同一个 DSH Session 跨多轮），而心跳、
  // 戳一戳这类回合不带 stableTaskId，只写旧的 legacy 槽、不会重新发布执行来源。
  // 指针留着的话，它们之后调用发送工具时会被按一条**已关闭**的旧来源拒绝
  // —— 表现为"这一轮根本没跑过任务，却报来源已关闭"。
  releaseExecutionSession(store, sourceRef);
}
/** 只撤指向该来源的指针，别的 Session 引用不动。 */
export function releaseExecutionSession(store, sourceRef) {
  if (!store?.available || !sourceRef) return false;
  try {
    for (const row of store.db.prepare(
      "SELECT key,value FROM runtime_state WHERE key LIKE 'qq-bridge:execution-session:%'").all()) {
      if (String(row.value) === String(sourceRef)) store.setState(row.key, '');
    }
  } catch { /* 清理失败只是留下一根旧指针，不影响本轮结果 */ }
  return true;
}
export function executionSource(store, ref) {
  if (!store?.available || !ref) return null;
  try { return JSON.parse(store.getState(prefix + ref) ?? 'null'); } catch { return null; }
}

/**
 * 每一轮把「DSH Session → 本轮 QQ 会话 + 来源」写进共享库。
 *
 * 为什么要按 Session 记、而不是让模型填：
 *   qq-mcp 是独立进程、被所有 DSH 会话共用，一次工具调用必须知道"这是哪个
 *   QQ 会话的回合"，否则 qq_say 的默认目标、工作区范围和跨会话开关都无从判断。
 *   以前这个归属靠模型把 prompt 里的 `source_ref` 原样抄进参数，抄错/漏抄就会在
 *   完全正确的场景里失败（戳一戳、表情回应都栽过）；而这个值本来就不是秘密 ——
 *   模型看得到就能填，等于没有安全收益。
 *
 * 现在由宿主按真实 Session 注入：模型看不到、也不用填；MCP 侧仍拿得到同一个
 * 来源，但归属权从"模型抄对一个字符串"变成"宿主知道这个 Session 在跑哪一轮"。
 */
export const TURN_SESSION_PREFIX = 'qq-bridge:turn-session:';

export function publishTurnSession(store, sessionId, data) {
  if (!store?.available || !sessionId || !data?.sourceRef || !data?.conversation) return false;
  return store.setState(TURN_SESSION_PREFIX + sessionId, JSON.stringify({
    conversation: String(data.conversation),
    sourceRef: String(data.sourceRef),
    at: Date.now(),
    expiresAt: data.expiresAt ?? Date.now() + 3600000,
  }));
}
export function clearTurnSession(store, sessionId) {
  if (!store?.available || !sessionId) return false;
  return store.setState(TURN_SESSION_PREFIX + sessionId, 'null');
}
export function turnSession(store, sessionId) {
  if (!store?.available || !sessionId) return null;
  try {
    const row = JSON.parse(store.getState(TURN_SESSION_PREFIX + sessionId) ?? 'null');
    return row?.conversation && row?.sourceRef && Date.now() <= Number(row.expiresAt ?? 0) ? row : null;
  } catch { return null; }
}
/**
 * 工具归属：优先本轮回合绑定；后台工作子代理没有自己的 QQ 回合，退回父回合
 * 登记在子 Session 上的执行来源（delegated-work 写的就是这一条）。
 */
export function boundSource(store, sessionId) {
  const turn = turnSession(store, sessionId);
  if (turn) return turn;
  if (!store?.available || !sessionId) return null;
  const ref = store.getState('qq-bridge:execution-session:' + sessionId);
  if (!ref) return null;
  const source = executionSource(store, ref);
  return source?.conversation ? { conversation: source.conversation, sourceRef: String(ref) } : null;
}
export function assertExecutionSource(store, origin) {
  const source = executionSource(store, origin.ref);
  if (!source) return null; // Legacy owned requests retain their old validation path.
  if (source.conversation !== origin.conversation || source.state !== 'active' || Date.now() > source.expiresAt)
    throw new Error('本轮执行来源已关闭、过期或会话不匹配');
  const task = store.db.prepare('SELECT state,version FROM bridge_task_entities WHERE id=? AND conversation=?').get(source.taskId, origin.conversation);
  if (!task || task.state === 'cancelled' || source.taskVersion != null && task.version !== source.taskVersion)
    throw new Error('本轮任务已取消或要求已更新');
  if (!source.authority && source.executionId) {
    const row = store.db.prepare('SELECT data FROM bridge_executions WHERE id=? AND task_id=?').get(source.executionId, source.taskId);
    if (!row) throw new Error('本轮执行归属缺失');
    const execution = JSON.parse(row.data);
    // Retain the owned-input intent facts for pre-HMR executions and diagnostics;
    // file access now uses the conversation workspace, not this heuristic.
    source.authority = execution.authority ?? fileAuthority(execution.inputEvents ?? [execution.event], execution.event.user_id,
      { data: JSON.parse(store.db.prepare('SELECT data FROM bridge_task_entities WHERE id=?').get(source.taskId).data) }, execution.route?.action);
  }
  return source;
}
export function activeExecutionSources(store) {
  if (!store?.available) return [];
  return store.db.prepare("SELECT value FROM runtime_state WHERE key LIKE 'qq-bridge:execution-source:%' AND updated_at>?")
    .all(Date.now() - 86400000).flatMap((r) => { try { const s = JSON.parse(r.value); return s.state === 'active' && s.expiresAt > Date.now() ? [s] : []; } catch { return []; } });
}

/** Host guard uses the caller's real DSH Session, never a model-supplied task ID. */
export function executionToolGuard(store, config, exec) {
  const sessionId = exec.agent?.session?.id;
  const ref = sessionId && store?.getState('qq-bridge:execution-session:' + sessionId);
  if (!ref) return;
  let source = executionSource(store, ref);
  try {
    if (!source) throw new Error('任务执行来源缺失');
    source = assertExecutionSource(store, { ref, conversation: source.conversation });
    const args = exec.arguments ?? {}, name = String(exec.name);
    // 子代理 / 记忆工具自己按 Session 解析来源，guard 不再比对模型填的字符串。
    if (['qq_delegate','qq_delegate_status','qq_delegate_control','qq_job_progress','qq_memory'].includes(name))
      return;
    const qq = QQ_SESSION_TOOLS.find((t) => name === t || name.endsWith('__' + t));
    const doc = DOCUMENT_TOOLS.find((t) => name === t || name.endsWith('__' + t));
    if (doc) {
      validateWorkspaceOutput(workspaceRoot(config), source.conversation, args.output_path);
      return;
    }
    if (qq) {
      if (['qq_say','qq_send_group_msg','qq_send_private_msg','qq_send_sticker','qq_send_custom_face',
        'qq_send_library_sticker','qq_send_mface','qq_send_file','qq_send_ai_voice','qq_workspace','qq_poke','qq_react'].includes(qq)) {
        const target = args.conversation ?? (args.group_id != null ? 'group:' + args.group_id : args.user_id != null ? 'user:' + args.user_id : source.conversation);
        // 跨会话放行后仍受白名单与能力位约束；这里只拦"模型把目标写到本轮会话之外"。
        if (target !== source.conversation && !crossConversationAllowed(store))
          throw new Error('工具目标必须属于当前任务会话');
        // 文件仍属于创建它的会话工作区，跨会话发送不能绕开这层归属。
        if (qq === 'qq_send_file' && target !== source.conversation)
          throw new Error('文件属于当前 QQ 会话工作区，不能跨会话发送');
      }
      return;
    }
    if (!['ask_user_question','web_search','web_fetch','run_code'].includes(name)) throw new Error('当前任务不允许此工具');
  } catch (error) { return String(error.message); }
}
