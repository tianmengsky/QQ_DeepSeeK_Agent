import { validateWorkspaceOutput, workspaceRoot } from './workspace.mjs';
import { QQ_SESSION_TOOLS, DOCUMENT_TOOLS, DELEGATION_TOOLS, BILI_READ_TOOLS, BILI_INTERACTION_TOOLS } from './tool-sets.mjs';
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

/**
 * 子代理**不能**调用的工具：一切"对外可见"的动作。
 *
 * 为什么要有这张表：子代理继承父回合的执行来源，闸门原本会按"目标属于本会话"
 * 放行，于是它可以直接 `qq_say` / 发文件 / 发贴纸 / 改群公告 —— 群里就会看到
 * 一条没人认领的消息，甚至顺序插在父代理那几句中间。桥接的契约是**只由父代理
 * 交付**：子代理写文件、写进自己的结果，由父代理核对后发出去。
 *
 * 旧实现（`service.start` 那套）靠 `toolFilter` 只给子代理搜索/工作区/进度工具，
 * 换到 DSH 原生 subagent 后没有等价开关，所以这条边界改由闸门兜住。
 */
const SUBAGENT_DENIED_TOOLS = [
  // 发言与内容投递
  'qq_say', 'qq_send_group_msg', 'qq_send_private_msg', 'qq_send_sticker',
  'qq_send_custom_face', 'qq_send_library_sticker', 'qq_send_mface', 'qq_send_file',
  'qq_send_ai_voice', 'qq_poke', 'qq_react',
  // 群务与账号：子代理不该替群友改任何东西
  'qq_manage_group', 'qq_set_profile', 'qq_delete_msg', 'qq_request_kick',
  'qq_pending_actions', 'qq_handle_add_request',
];


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

/**
 * 「这条 turn 只准投一次」的凭据。
 *
 * 为什么要它：输入被并进正在跑的 turn 时，**两条回复行会同时看见同一条
 * turn/end** —— 认领了 turn 的那条（原回合）和被并进去的那条（merged）。
 * 两边都认为文本是自己的，群里就会发两遍。谁先到这里谁投，另一条跳过。
 */
const CLAIMED_TURN_PREFIX = 'qq-bridge:claimed-turn:';

export function claimTurnDelivery(store, sessionId, turn, by, { ttlMs = 900000 } = {}) {
  if (!store?.available || !sessionId || turn == null) return true;
  const key = CLAIMED_TURN_PREFIX + sessionId;
  let prev = null;
  try {
    prev = JSON.parse(store.getState(key) ?? 'null');
  } catch {
    prev = null;
  }
  const now = Date.now();
  const sameTurn = prev && Number(prev.turn) === Number(turn);
  if (sameTurn && String(prev.by) !== String(by) && now - Number(prev.at ?? 0) < ttlMs) return false;
  store.setState(key, JSON.stringify({ turn: Number(turn), by: String(by), at: now }));
  return true;
}

/**
 * 认领之后又没能真发出去（静默回合、被策略挡掉）时把认领退掉 ——
 * 否则另一条回复行会被自己这条"空认领"挡住，又变成静默丢话。
 */
export function releaseTurnClaim(store, sessionId, turn, by) {
  if (!store?.available || !sessionId || turn == null) return;
  const key = CLAIMED_TURN_PREFIX + sessionId;
  let prev = null;
  try {
    prev = JSON.parse(store.getState(key) ?? 'null');
  } catch {
    prev = null;
  }
  if (!prev || Number(prev.turn) !== Number(turn) || String(prev.by) !== String(by)) return;
  store.setState(key, 'null');
}

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
/** 原始绑定行：不看有效期。清理、续租、按回合号配对都要拿它，不能被过期挡住。 */
export function turnSessionRow(store, sessionId) {
  if (!store?.available || !sessionId) return null;
  try {
    const row = JSON.parse(store.getState(TURN_SESSION_PREFIX + sessionId) ?? 'null');
    return row?.conversation && row?.sourceRef ? row : null;
  } catch { return null; }
}
export function turnSession(store, sessionId) {
  const row = turnSessionRow(store, sessionId);
  return row && Date.now() <= Number(row.expiresAt ?? 0) ? row : null;
}
/** 记下这一轮在 DSH 里的 turn 号，供 turn/end 时按回合配对（不配对的结束不算我的）。 */
export function stampTurnSession(store, sessionId, turn) {
  if (turn == null) return false;
  const row = turnSessionRow(store, sessionId);
  if (!row || Number(row.turn) === Number(turn)) return false;
  return store.setState(TURN_SESSION_PREFIX + sessionId, JSON.stringify({ ...row, turn: Number(turn) }));
}
/** 取走并撤掉绑定：turn/end 到达时由宿主调用，返回值用于收尾执行来源。 */
export function takeTurnBinding(store, sessionId) {
  const row = turnSessionRow(store, sessionId);
  if (!row) return null;
  clearTurnSession(store, sessionId);
  return row;
}
/**
 * 回合还活着 → 把归属的有效期往后推。
 *
 * 为什么需要：`sourceTtlMs`（默认 10 分钟）是按"一轮最多跑多久"估的，可现实里
 * 一轮大活（生成一个完整网页、写一份长文档）能跑十几分钟。过期那一刻起，MCP 的
 * 两道校验（`memory_origins` 的有效期、执行来源的 `expiresAt`）同时失效，模型
 * 正干到一半就忽然"没有本轮归属"了。宿主每收到一个模型步骤就续一次租，
 * 归属的寿命于是等于**回合的寿命**，而不是一条写死的 TTL。
 *
 * 只在这几种情况下拒续：
 *   · 没有绑定（不是 QQ 回合的 Session）；
 *   · 离到期还有两分钟以上（每个步骤都写库没必要）；
 *   · 已经过期超过一个完整 TTL（多半是上个进程崩掉留下的旧行，别复活它）。
 */
export function refreshTurnBinding(store, sessionId, ttlMs) {
  if (!store?.available || !sessionId) return false;
  const row = turnSessionRow(store, sessionId);
  if (!row) return false;
  const now = Date.now(), ttl = Math.max(60000, Number(ttlMs) || 600000);
  const expiresAt = Number(row.expiresAt ?? 0);
  if (expiresAt - now > 120000) return false;
  if (now - expiresAt > ttl) return false;
  const next = now + ttl;
  store.setState(TURN_SESSION_PREFIX + sessionId, JSON.stringify({ ...row, expiresAt: next }));
  const source = executionSource(store, row.sourceRef);
  if (source?.state === 'active')
    store.setState(prefix + row.sourceRef, JSON.stringify({ ...source, expiresAt: next }));
  try {
    // MCP 侧第一道闸查的是 memory_origins 的有效期：两边必须一起续，否则又回到
    // "第一道放行、第二道拒绝"那种自相矛盾。
    store.db.prepare('UPDATE memory_origins SET expires_at=? WHERE ref=? AND expires_at<?')
      .run(next, String(row.sourceRef), next);
  } catch { /* 老库没有这张表：MCP 那边也只按缺省处理 */ }
  return true;
}
/**
 * 工具归属：优先本轮回合绑定；后台工作子代理没有自己的 QQ 回合，退回父回合
 * 登记在子 Session 上的执行来源（subagent-results 写的就是这一条）。
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
export function executionToolGuard(store, config, exec, state = null) {
  const sessionId = exec.agent?.session?.id;
  /**
   * 收尾回合（memory flush）必须拦在**最前面**。
   *
   * 它用的是同一个 DSH Session，但不属于任何 QQ 回合 —— 也就是说下面
   * `execution-session` 那条指针是空的，原本会直接 `return` 放行。
   * 那样模型在收尾时随口调一次 qq_say，话就真发进群里了，
   * 而这条路径的设计前提是"不产生任何外部可见动作"。
   * 所以先按 session 判收尾标记，再走常规归属校验。
   */
  if (sessionId && state?.memoryFlushSessions?.has(sessionId))
    return '上下文收尾回合不允许对外动作（不发消息、不发文件）';
  const activeTurn = sessionId ? turnSession(store, sessionId) : null;
  const name = String(exec.name ?? '');
  if (activeTurn?.conversation.startsWith('bili:')) {
    const qq = QQ_SESSION_TOOLS.find((t) => name === t || name.endsWith('__' + t));
    const bili = [...BILI_INTERACTION_TOOLS, 'bili_send_message']
      .find((t) => name === t || name.endsWith('__' + t));
    if (qq || bili) return 'B站私信会话禁止直接调用外发工具；普通回复由桥接层投递回原 UID';
  }
  /**
   * 子代理（有 parentSession 的 Session）一律不许对外：它只做活、把成品写进自己的
   * 结果，由父代理核对后交付。这条判在来源指针之前 —— 即使来源有效、目标就在本
   * 会话，也一样拒绝。
   */
  if (exec.agent?.session?.header?.parentSession
    && SUBAGENT_DENIED_TOOLS.some((t) => name === t || name.endsWith('__' + t)))
    return '子代理不能直接发消息、发文件或改群设置；把内容写进结果，由父代理交付';
  const ref = sessionId && store?.getState('qq-bridge:execution-session:' + sessionId);
  if (!ref) return;
  let source = executionSource(store, ref);
  try {
    if (!source) throw new Error('任务执行来源缺失');
    source = assertExecutionSource(store, { ref, conversation: source.conversation });
    const args = exec.arguments ?? {};
    // 子代理与记忆工具自己按 Session 解析来源，guard 不再比对模型填的字符串。
    if (['qq_memory', 'qq_windows', ...DELEGATION_TOOLS].includes(name))
      return;
    const qq = QQ_SESSION_TOOLS.find((t) => name === t || name.endsWith('__' + t));
    const doc = DOCUMENT_TOOLS.find((t) => name === t || name.endsWith('__' + t));
    const bili = [...BILI_READ_TOOLS, ...BILI_INTERACTION_TOOLS].find((t) => name === t || name.endsWith('__' + t));
    if (bili) return;
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
    // ask_user_question 不在这里：QQ 回合没有 answerer，问出去就整轮挂起。
    if (!['web_search','web_fetch','run_code', ...DELEGATION_TOOLS].includes(name)) throw new Error('当前任务不允许此工具');
  } catch (error) { return String(error.message); }
}
