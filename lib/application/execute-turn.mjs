import { admitMessage } from '../domain/admission.mjs';
import { renderMessage, atTargets } from '../domain/events.mjs';
import { evaluateAttention, observeWithoutReply } from './attention.mjs';
import { refreshWindowFromQQHistory } from '../conversation/history.mjs';
import { buildMemoryInjection, buildWindowSection } from '../prompt/render.mjs';
import { buildPromptContent } from '../prompt/prepare.mjs';
import { publishImageCatalog, imageReadCount } from '../agent/image-catalog.mjs';
import { planExamples } from '../prompt/examples.mjs';
import { gapNoticeFor } from '../conversation/gaps.mjs';
import {
  pickShape,
  isSilence,
  stripSilence,
  stripImageHallucination,
  removeSentBubbles,
  stripSyntheticPromptEcho,
} from '../domain/reply-policy.mjs';
import { runTurn } from '../agent/runner.mjs';
import { queueReply } from '../delivery/reply-delivery.mjs';
import { contextMessage } from '../conversation/context.mjs';
import { planWindowInjection, commitWindowInjection } from '../conversation/injection.mjs';
import { extractRemember } from '../domain/reply-policy.mjs';
import { isSessionArchived, rotateAfterContextOverflow } from '../conversation/sessions.mjs';
import { recordSpeech, refreshSpeech, wakeAfterSpeech } from '../conversation/activity.mjs';
import { replyJournal } from '../delivery/reply-journal.mjs';
import { batchTimeline, readFloor, publishFloorSource, recheckFloor, isCancellation } from '../conversation/floor.mjs';
import { randomUUID } from 'node:crypto';
import { publishExecutionSource, closeExecutionSource, sourceTtlMs, publishTurnSession, clearTurnSession, stampTurnSession, claimTurnDelivery, releaseTurnClaim } from '../agent/execution-scope.mjs';
import { fileAuthority } from '../conversation/task-ownership.mjs';
import { awaitIncomingVoices } from './voice-transcription.mjs';
import { flushMemoryBeforeRotate } from '../memory/flush.mjs';
import { isContextOverflow } from '../agent/context-overflow.mjs';

/** 超窗丢弃的这一轮在账本/日志里的口径，避免和"投递失败"混为一谈。 */
const OVERFLOW_FAILURE = 'context-overflow';

/**
 * 丢掉被上游判超窗的这一轮，并把 Session 一起丢掉。
 *
 * 三件事必须一起做，少一件都会留下脏账：
 *   · journal 行要删：它停在 following/output，恢复逻辑会把这条当成"待投递"，
 *     然后拿一个不存在的回复去发；
 *   · ledger 要标 failed：否则任务视图里这一轮永远在跑；
 *   · Session 要清：`contextChars` 不含图片，靠预算永远等不到轮换。
 */
function discardOverflowedTurn({ journal, state, turnId, registry, stats, key, detail }) {
  try {
    journal?.store.db.prepare(
      "DELETE FROM bridge_replies WHERE id=? AND state IN ('following','output')").run(turnId);
  } catch { /* 账本清理失败不该挡住重投 */ }
  state.taskLedger?.set(turnId, 'failed', { failure: OVERFLOW_FAILURE });
  rotateAfterContextOverflow(registry, key, detail);
  stats.contextOverflowRecoveries = (stats.contextOverflowRecoveries ?? 0) + 1;
  stats.sessionsRecovered = (stats.sessionsRecovered ?? 0) + 1;
}

/**
 * 共享库里"当前正在跟谁说话"的键 —— 供 `qq_say` 工具校验用。
 *
 * 这是桥接（Host 侧）和 qq-mcp（独立进程）之间唯一的交接通道，
 * 沿用 `QQ_BRIDGE_DB` 那套：两个进程读写同一个 SQLite 的 runtime_state。
 */
const ACTIVE_CONVERSATION_KEY = 'bridge:active-conversation';

/** 把这个会话标成"正在跑"。工具据此拒绝发往别的会话。 */
export function publishActiveConversation(store, key, event = null, sourceRef = null) {
  if (!store?.available) return false;
  store.setState('qq-bridge:floor-active:' + key, JSON.stringify({ sourceRef, at: Date.now() }));
  return store.setState(
    ACTIVE_CONVERSATION_KEY,
    JSON.stringify({
      key: String(key),
      at: Date.now(),
      messageId: event?.message_id == null ? null : String(event.message_id),
      sourceRef,
    }),
  );
}

/** 轮次结束后撤掉标记。下一次轮开始时会重新发布。 */
export function clearActiveConversation(store, key) {
  if (!store?.available) return false;
  store.setState('qq-bridge:floor-active:' + key, 'null');
  try {
    const raw = store.getState(ACTIVE_CONVERSATION_KEY);
    // 只撤自己那一条：并发/交错时别把别人的标记抹掉
    if (raw) {
      const cur = JSON.parse(raw);
      if (cur?.key && String(cur.key) !== String(key)) return false;
    }
  } catch {
    /* 读不出来就照撤，宁可失效也不能留下过期标记 */
  }
  return store.setState(ACTIVE_CONVERSATION_KEY, 'null');
}

/** Called only within the conversation queue, for messages, pokes and heartbeat turns. */
export async function executeTurn(
  ctx,
  config,
  registry,
  state,
  memory,
  stats,
  store,
  key,
  event,
  { heartbeat = false, signal = state.controller?.signal, sendQueue = null, recovered = false,
    consumePending = true, inputEvents = [event], floorPolicy = null, onClaim = null,
    executionId = null, stableTaskId = null } = {},
) {
  const active = () =>
    state.enabled && !state.disposed && !signal?.aborted && admitMessage(config, event);
  if (!active()) return false;
  const entry = registry.entry(key);
  // QQ history belongs to the shared conversation timeline. Task Sessions use a
  // filtered view of that timeline; fetching against the task-local entry would
  // make history disappear after routing a message to a task.
  const sharedRegistry = registry.baseRegistry ?? registry;
  const sharedEntry = sharedRegistry.entry(key);
  inputEvents = inputEvents.filter((e) => admitMessage(config, e) && !entry.recalledIds.includes(String(e.message_id)));
  if (!inputEvents.length) return false;
  await awaitIncomingVoices(inputEvents);
  if (!active()) return false;
  await refreshWindowFromQQHistory(ctx, config, sharedRegistry, sharedEntry, key, stats, signal);
  if (stableTaskId && entry !== sharedEntry) {
    const task = state.taskRouting?.get(stableTaskId);
    const ids = new Set(task?.data?.messageIds?.map(String) ?? []);
    // Keep the full bounded shared chronology. Task sources are retained by ID;
    // the surrounding messages are needed to resolve references and ordinary QQ
    // history even when the semantic router is still in shadow mode.
    const taskMessages = sharedEntry.window.filter((m) => ids.has(String(m.messageId)));
    const recent = sharedEntry.window.slice(-Math.max(4, Number(config.contextOthersMessages ?? 10) + Number(config.contextOwnMessages ?? 15)));
    entry.window = [...new Map([...recent, ...taskMessages].map((m) => [String(m.messageId ?? `${m.at}:${m.text}`), m])).values()];
    entry.recentQqs = [...new Set(entry.window.slice().reverse().filter((m) => !m.bot && m.qq).map((m) => m.qq))].slice(0, 6);
  }
  if (!active()) return false;
  if (inputEvents.length > 1 && config.groupAttentionEnabled && !heartbeat && !event.__poke) {
    const candidates = [];
    for (const item of inputEvents) {
      const targets = atTargets(item.message).filter((id) => id !== 'all');
      const self = (config.selfIds?.length ? config.selfIds : [item.self_id]).map(String);
      const decision = targets.length && self.includes(targets[0]) ? { speak: true }
        : await evaluateAttention(ctx, config, entry, item, stats, signal);
      if (decision.speak && !item.__inputPassive) candidates.push(item);
      else registry.record(entry, contextMessage(item));
    }
    if (candidates.length) {
      if (!candidates.includes(event)) event = candidates[0];
      if (floorPolicy && !floorPolicy.direct) floorPolicy.authors = [String(event.user_id)];
    }
  }
  if (floorPolicy && batchTimeline(inputEvents).some((m) => floorPolicy.authors.includes(m.qq) && isCancellation({
    ...m, otherTarget: readFloor(store, key, entry).messages.find((row) => row.messageId === m.messageId)?.otherTarget,
  }))) {
    for (const item of inputEvents) registry.record(entry, contextMessage(item));
    registry.persist(key);
    stats.floorDeclined = (stats.floorDeclined ?? 0) + 1;
    return false;
  }
  const ids = (config.selfIds?.length ? config.selfIds : [event.self_id]).map(String);
  const firstAt = atTargets(event.message).find((id) => id !== 'all');
  const explicit = firstAt != null && ids.includes(firstAt) ||
    config.groupTrigger === 'prefix' && Boolean(config.groupPrefix) &&
      renderMessage(event.message).trimStart().startsWith(config.groupPrefix);
  let attention = null;
  /**
   * 明确 @ 时原本**完全跳过**注意力闸门（条件里的 `!explicit`）—— 也就是"被 @ 必回"，
   * 这是"每条消息都回"的主要来源（线上 45% 的回合来自 @）。打开 `replyDecisionEnabled`
   * 后 @ 也要过一次参与决策（带着"她被点名"的偏置），否则"像真人那样有的不回"无从实现。
   * 关着时条件与原来完全一致，行为不变。
   */
  const attentionGate = config.groupAttentionEnabled && event.message_type === 'group' &&
    !event.__poke && !heartbeat && !recovered && (!explicit || config.replyDecisionEnabled);
  if (attentionGate) {
    attention = await evaluateAttention(ctx, config, entry, event, stats, signal,
      { events: inputEvents, explicit, key });
    stats.attentionChecks = (stats.attentionChecks ?? 0) + 1;
    stats.lastAttentionDecision = { conversation: key, messageId: event.message_id,
      ...attention, phase: attention.speak ? 'considering' : 'routing-skipped', at: Date.now() };
    entry.lastAttentionDecision = stats.lastAttentionDecision;
    registry.persist(key);
    if (!active()) return false;
    if (!attention.speak) {
      stats.attentionDeclined = (stats.attentionDeclined ?? 0) + 1;
      if (attention.retry) stats.attentionFailed = (stats.attentionFailed ?? 0) + 1;
      for (const item of inputEvents)
        observeWithoutReply(ctx, config, registry, state, memory, stats, store, key, item, sendQueue);
      return false;
    }
  }
  /**
   * 轮换前的静默收尾。
   *
   * 放在 ensureSession 之前：一旦换了新 Session，旧上下文就没了，
   * 这个回合必须在**旧会话**里跑才有意义。它自己会判断"是不是真的该轮换了"，
   * 不轮换时只是一次廉价的空跑（读几个字段就返回）。
   */
  if (memory) await flushMemoryBeforeRotate({ ctx, config, registry, state, memory, stats, key });
  const sessionId = await registry.ensureSession(key);
  if (!active()) return false;
  const seeded = consumePending ? registry.seedContextFromBuffer(entry, key) : 0;
  stats.pokeContextSeeded = (stats.pokeContextSeeded ?? 0) + seeded;
  stats.contextMerged = (stats.contextMerged ?? 0) + registry.flushPendingContext(entry);
  const currentId = event.message_id == null ? null : String(event.message_id);
  // Current message is supplied separately, even when QQ history includes it.
  const inputIds = new Set(inputEvents.map((e) => String(e.message_id)));
  const window = entry.window.filter((m) => !inputIds.has(String(m.messageId)) &&
    !entry.recalledIds.includes(String(m.messageId)));
  if (!event.__poke && !heartbeat) memory?.extractor?.observe(key, contextMessage(event), signal);
  const speakerQq = String(event.user_id),
    speakerName = event.sender?.card || event.sender?.nickname || speakerQq;
  const sourceRef = (memory?.episodes ?? state.sourceLedger)?.origin(key, {
    ...contextMessage(event), qq: speakerQq, who: speakerName,
  }, Math.max(600000, config.replyTimeoutMs + 60000));
  publishFloorSource(store, sourceRef, key, floorPolicy);
  if (!config.memoryAutoExtract && memory?.touch(speakerQq, speakerName))
    stats.memoriesCreated = (stats.memoriesCreated ?? 0) + 1;
  // 群里换发言人/最近参与者不会重发已知人物；经历变化仅更新经历块。
  const memoryInjection = buildMemoryInjection(config, event, entry, memory);
  const includeStatic = !config.injectStaticOnce || !entry.staticDone;
  const windowInjection = planWindowInjection(config, entry, window, {
    ...contextMessage(event), qq: speakerQq, who: speakerName,
  });
  const shape = pickShape(config);
  const reactionEntries = [...(state.pendingReactions?.entries() ?? [])].filter(
    ([, r]) => r.conversation === key,
  );
  const routing = state.taskRouting, currentExecution = executionId && routing?.execution(executionId);
  const inputMessages = inputEvents.filter(e => !e.__inputPassive).map(contextMessage);
  const replyIds = inputMessages.filter(m => m.replyToId != null).map(m => String(m.replyToId));
  const relatedTaskIds = routing ? [...new Set([
    ...replyIds.map(id => routing.related(key, id)?.id),
    ...routing.tasks(key).filter(t => inputMessages.some(m => m.text.includes(t.id))).map(t => t.id),
    currentExecution?.data.referencedTaskId,
  ].filter(Boolean))] : [];
  const taskText = [stableTaskId ? routing?.context(stableTaskId, executionId) : '',
    state.taskLedger?.context(key, state.replyJournal, { owner: speakerQq, taskId: stableTaskId,
      relatedTaskIds, replyIds, delegatedResult: Boolean(currentExecution?.data.delegatedResult) })].filter(Boolean).join('\n');
  const examplePlan = planExamples(config, inputMessages.map((m) => m.text).join('\n'), entry,
    { includeStatic, heartbeat, poke: Boolean(event.__poke), taskText });
  const content = await buildPromptContent(ctx, config, event, stats, {
    examplePlan,
    sourceRef,
    memoryText: memoryInjection.text,
    taskText,
    workspaceScope: entry.workspaceScope,
    windowText: buildWindowSection(config, { ...entry, window: windowInjection.messages }),
    windowMessages: window,
    includeStatic,
    includeWindow: windowInjection.messages.length > 0,
    windowDelta: !windowInjection.full,
    shape,
    heartbeat,
    attention,
    inputTimeline: stableTaskId || inputEvents.length > 1 ? batchTimeline(inputEvents) : null,
    taskOwnership: stableTaskId ? { taskId: stableTaskId, executionId,
      messageIds: inputEvents.filter((e) => !e.__inputPassive).map((e) => String(e.message_id)) } : null,
    workspaceNeeded: Boolean(taskText || stableTaskId || inputMessages.some((m) =>
      /(?:文件|文档|代码|脚本|网页|html|pdf|word|pptx?|xlsx?|表格|写|生成|修改|打包|压缩|发我|上传|下载|workspace)/iu.test(m.text))),
    inputEvents,
    floorManagement: config.floorManagementEnabled !== false && !heartbeat && !event.__poke,
    interjectCooldownRemainingMs: Math.max(0,
      (entry.lastSpokeAt || 0) + (config.attentionInterjectCooldownMs || 0) - Date.now()),
    poke: Boolean(event.__poke),
    awake: Date.now() < entry.awakeUntil,
    stickerAllowed: entry.turnsSinceSticker >= config.stickerMinGapTurns,
    stickerGap: entry.turnsSinceSticker,
    gapNotice: gapNoticeFor(store, key),
    reactions: reactionEntries.map(([, r]) => r),
    signal,
  });
  if (!memoryInjection.text) stats.memorySkipped = (stats.memorySkipped ?? 0) + 1;
  if (!active()) return false;
  publishImageCatalog(store, sourceRef, key, content.imageCatalog, sourceTtlMs(config), config);
  const imageInfo = content.imageInfo;
  const turnId = key + (currentId ? '#m' + currentId : '#t' + Date.now()) +
    (inputEvents.some((e) => e.__inputId) ? '#batch-' + randomUUID() : '');
  const journal = state.replyJournal ?? replyJournal(store);
  let outcome;
  /**
   * 这一轮在 DSH 里是否还活着（只在 catch 里被赋值）。
   *
   * 超时收工 ≠ 回合结束：`replyTimeoutMs` 只决定桥接还愿不愿意等，DSH 那边
   * 照样在跑。这时候撤掉归属，模型下一次 qq_send_file / qq_workspace 就会被
   * MCP 判成"没有本轮 QQ 会话归属" —— "想久了就不能用工具"就是这么来的。
   */
  let turnStillRunning = false;
  /**
   * 把"当前正在跑哪个会话"发布到共享库里 —— 供 `qq_say` 工具校验用。
   *
   * 为什么必须由桥接发布、而不是让工具自己猜：
   *   `qq_say` 跑在**另一个进程**（qq-mcp），它完全不知道模型正在哪个会话里说话。
   *   如果目标由模型自己填、又没人校验，模型一旦填错（或被人用提示词注入骗），
   *   就等于**替它往别的群里说话**。校验权必须留在桥接 —— 它才是唯一知道真相的人。
   *
   * 时序上够用：runTurn 会一直阻塞到这一轮结束，而工具只可能在轮内被调用，
   * 所以"轮内调用"必然落在下面这对 publish/clear 之间。
   */
  // 本轮的归属按 Session 记进共享库：qq-mcp 是独立进程，靠这条记录知道
  // "哪个 DSH Session 正在哪个 QQ 会话里说话"。模型侧不再有任何来源参数。
  publishTurnSession(store, sessionId, { conversation: key, sourceRef,
    expiresAt: Date.now() + sourceTtlMs(config) });
  if (stableTaskId) publishExecutionSource(store, sourceRef, { conversation: key, taskId: stableTaskId,
    executionId, taskVersion: floorPolicy?.taskVersion, workspaceScope: entry.workspaceScope, sessionId,
    authority: state.taskRouting?.execution(executionId)?.data.authority ??
      fileAuthority(inputEvents, event.user_id, state.taskRouting?.get(stableTaskId), state.taskRouting?.execution(executionId)?.data.route?.action),
    expiresAt: Date.now() + sourceTtlMs(config) });
  else publishActiveConversation(store, key, event, sourceRef);
  try {
    outcome = await runTurn(
      ctx,
      config,
      registry,
      key,
      content,
      stats,
      {
        sessionId,
        signal,
        onBeforePrompt(identity) {
          const meta = { ...identity, event, shape, imageInfo, sourceRef,
            speakerQq, speakerName, turnId, attention, floorPolicy,
            executionId, stableTaskId,
            inputIds: inputEvents.map((e) => e.__inputId).filter(Boolean) };
          journal?.begin(turnId, key, meta);
          if (executionId) state.taskRouting.setExecution(executionId, 'following', { turnId });
          // Once durable ownership exists, an uncertain prompt failure is recovery's job, never a new submission.
          if (journal) onClaim?.();
          journal?.active.add(turnId);
          state.taskLedger?.begin(turnId, key, { ...meta,
            floorPolicy: floorPolicy ?? { originals: inputEvents } });
        },
        onOutcome(result) {
          // 命中 0 行 = 这行已经不被当作"在等结果"了（多半被判迟到放弃）。
          // 那种情况下正文照样要落库，否则线上看到的就是"模型答了、群里没有"。
          const kept = journal?.output(turnId, result);
          if (journal && kept === 0) {
            const detail = '结果迟到：行已被放弃/已交付，本轮答复未投递（见 late-output 日志）';
            journal.lateOutput(turnId, result, detail);
            stats.lateRepliesDropped = (stats.lateRepliesDropped ?? 0) + 1;
            ctx.logger?.warn?.(`qq-bridge: 迟到的答复 ${turnId}（${key}）未投递：` +
              String(result?.reply ?? '').slice(0, 80).replace(/\s+/g, ' '));
          }
          state.taskLedger?.outcome(turnId, result);
          if (executionId) { const row = state.taskRouting.execution(executionId);
            state.taskRouting.setExecution(executionId, 'model_finished', { times: { ...row.data.times, output: Date.now() } }); } },
        onConsumed({ turn }) { state.taskLedger?.set(turnId, 'running', { turn });
          // 记下本轮的 turn 号：归属只在**这一轮**的 turn/end 上收尾，别的回合结束不算。
          stampTurnSession(store, sessionId, turn);
          if (executionId) { const row = state.taskRouting.execution(executionId);
            state.taskRouting.setExecution(executionId, 'following', { turn, times: { ...row.data.times, consumed: Date.now() } }); } },
        /**
         * 这一轮已经写出可发正文了。
         *
         * 插话闸从这里关上（`interjections.mjs#injectRunningTurn`）：之后进来的
         * 新消息排成下一轮，而不是并进来把这一句拖成一长段。反问一下为什么不是
         * "继续并进来更连贯"—— 实测 23:55 那轮这样并了 4 分 20 秒，最后 32 秒连
         * 发 12 条，同一句还写了两遍（`dedupeRepeatedBubbles` 只能补救，不能还原节奏）。
         */
        onReplyText() { journal?.markWroteText(turnId); },
        onSpeechResult(speech, receipt) {
          state.taskLedger?.progress(turnId, speech, receipt);
          // Attribution comes from this claimed DSH turn, never the global active-conversation key.
          if (receipt.replayed || receipt.dryRun) return;
          memory?.episodes?.action({ id: receipt.id, sourceRef,
            conversation: speech.conversation, text: speech.text || '[图片/表情]',
            state: receipt.state, onebotId: receipt.onebotId });
          if (receipt.state === 'SUCCEEDED' && speech.conversation === key)
            registry.record(entry, { qq: '', who: '你', text: speech.text || '[图片/表情]',
              bot: true, messageId: receipt.onebotId ?? 'tool:' + receipt.id,
              at: receipt.sentAt, timeSource: 'sent' });
        },
        onSpoke() {
          const previous = entry.lastSpokeAt || 0;
          const sentAt = refreshSpeech(config, entry, store, key);
          wakeAfterSpeech(config, entry, sentAt > previous ? sentAt : recordSpeech(store, key));
        },
        onSubmitted() {
          state.taskLedger?.set(turnId, 'submitted');
          onClaim?.();
          entry.contextTurn = (entry.contextTurn ?? 0) + 1;
          entry.staticDone = true;
          entry.exampleHashes = examplePlan.hashes;
          entry.memoryHashes = memoryInjection.hashes;
          stats.lastPrompt = {
            conversation: key, sessionId, includeStatic,
            windowMessages: windowInjection.messages.length,
            windowMessagesSkipped: windowInjection.skipped,
            windowDelta: !windowInjection.full,
            textChars: content.filter((part) => part.type === 'text')
              .reduce((n, part) => n + (part.text?.length ?? 0), 0) ?? 0,
            memoryChars: memoryInjection.text.length,
            taskContextChars: taskText.length,
            exampleChars: examplePlan.text.length,
            exampleScenes: examplePlan.scenes,
            memoryBlocksKnown: Object.keys(memoryInjection.hashes).length,
            rotateEveryTurns: config.rotateEveryTurns,
            imageParts: content.filter((part) => part.type === 'image').length,
          };
          entry.contextChars = (entry.contextChars ?? 0) + stats.lastPrompt.textChars;
          if (executionId) state.taskRouting.setExecution(executionId, 'following', { promptChars: stats.lastPrompt.textChars });
          if (includeStatic) stats.staticInjections = (stats.staticInjections ?? 0) + 1;
          if (windowInjection.messages.length)
            stats.windowInjections = (stats.windowInjections ?? 0) + 1;
          for (const [id, snapshot] of reactionEntries)
            if (state.pendingReactions.get(id) === snapshot) state.pendingReactions.delete(id);
          for (const item of inputEvents) registry.record(entry, contextMessage(item));
          commitWindowInjection(entry, windowInjection);
        },
      },
    );
  } catch (error) {
    turnStillRunning = Boolean(error?.turnStillRunning) && !state.disposed && !signal?.aborted;
    journal?.active.delete(turnId);
    if (journal && !state.disposed)
      journal.error(turnId, error?.message ?? error);
    if (!state.disposed) state.taskLedger?.set(turnId, 'recovering');
    if (error.sessionMissing && !recovered && active()) {
      // Explicit pre-admission rejection: this request never entered DSH.
      journal?.store.db.prepare("DELETE FROM bridge_replies WHERE id=? AND state='following'").run(turnId);
      state.taskLedger?.set(turnId, 'failed', { failure: 'session-missing-before-admission' });
      entry.sessionId = undefined;
      entry.turns = 0;
      entry.staticDone = false;
      entry.exampleHashes = {};
      entry.windowHashes = {};
      entry.memoryHash = undefined;
      entry.memoryHashes = {};
      registry.persist(key);
      stats.sessionsRecovered = (stats.sessionsRecovered ?? 0) + 1;
      return executeTurn(ctx, config, registry, state, memory, stats, store, key, event,
        { heartbeat, signal, sendQueue, recovered: true, consumePending, inputEvents, floorPolicy, onClaim, executionId, stableTaskId });
    }
    /**
     * 超窗：同一个 Session 再发一次必然复现同一个 413（payload 根本没到模型），
     * 所以这里既不是"重试"也不是"放弃"，而是**换会话后重新投一次**。
     * `recovered: true` 保证一条消息最多重建一次，不会自己打转。
     */
    if (error?.contextOverflow && !recovered && !state.disposed && active()) {
      discardOverflowedTurn({ journal, state, turnId, registry, stats, key,
        detail: String(error?.message ?? error).slice(0, 200) });
      return executeTurn(ctx, config, registry, state, memory, stats, store, key, event,
        { heartbeat, signal, sendQueue, recovered: true, consumePending, inputEvents, floorPolicy, onClaim, executionId, stableTaskId });
    }
    throw error;
  } finally {
    /**
     * 撤归属的条件是**回合结束**，不是"我们不等了"。
     *
     * 还活着就什么都不撤：turn-session、执行来源、floor 标记一起留着，让模型
     * 接着把文件写完发出来；真正收尾交给 `turn-scope` 的 turn/end 钩子
     * （`refreshTurnBinding` 还会按模型步骤续租，长回合不会中途过期）。
     * TTL 仍在 —— 进程崩掉时它兜住最后 10 分钟。
     */
    if (turnStillRunning) {
      ctx.logger?.info?.(`qq-bridge: 回合超时但 DSH 仍在跑（${key}），保留本轮归属，等 turn/end 收尾`);
    } else {
      clearTurnSession(store, sessionId);
      if (stableTaskId) closeExecutionSource(store, sourceRef);
      else clearActiveConversation(store, key);
    }
  }
  /**
   * 超窗也可能以"回合正常收尾、但 reason=error"的形状回来（适配器把 413 放进
   * turn/end.error）。两种形状必须走同一条处置，否则线上只是换了个死法。
   *
   * `toolCalls === 0` 是硬条件：超窗发生在这一步的第一个模型请求上，一旦这一轮
   * 已经调过工具（说明请求真的过去了），就不能再重投 —— 那会二次执行副作用。
   */
  if (!recovered && isContextOverflow(outcome?.failure) && !outcome?.toolCalls && active()) {
    discardOverflowedTurn({ journal, state, turnId, registry, stats, key,
      detail: String(outcome.failure?.message ?? '').slice(0, 200) });
    return executeTurn(ctx, config, registry, state, memory, stats, store, key, event,
      { heartbeat, signal, sendQueue, recovered: true, consumePending, inputEvents, floorPolicy, onClaim, executionId, stableTaskId });
  }
  try {
    // An in-turn injection kept the task version but added real owned sources.
    // Carry their recall checks into the final send plan and recovery metadata.
    if (executionId) {
      const inputs = state.taskRouting?.execution(executionId)?.data.inputEvents;
      if (inputs?.length > inputEvents.length) floorPolicy = { ...floorPolicy, originals: inputs,
        messageIds: [...new Set(inputs.map(e => String(e.message_id)))] };
    }
    return await finishReply(ctx, config, registry.baseRegistry ?? registry, state, memory, stats, store, key, event,
      outcome, { sessionId, imageInfo, speakerQq, speakerName, shape, turnId, sourceRef,
        attention, signal, sendQueue, journal, floorPolicy, stableTaskId });
  } finally {
    journal?.active.delete(turnId);
  }
}

/** Also used by recovery; the captured reply never needs another model submission. */
export async function finishReply(ctx, config, registry, state, memory, stats, store, key, event,
  outcome, { sessionId, imageInfo, speakerQq, speakerName, shape, turnId, sourceRef,
    attention = null, signal = state.controller?.signal, sendQueue = null,
    floorPolicy = null, stableTaskId = null,
    journal = state.replyJournal ?? replyJournal(store) }) {
  const entry = registry.entry(key);
  const active = () => state.enabled && !state.disposed && !signal?.aborted && admitMessage(config, event);
  const finish = (value, detail) => { journal?.finish(turnId, detail); return value; };
  const { reply, endReason, failure, assistantMsgs = 0, textParts = 0, spokeByTool = false, spokeTexts = [] } =
    outcome;
  if (imageReadCount(store, sourceRef, key) > 0)
    imageInfo = { ...imageInfo, present: true, attached: true };
  // Even silent/filtered turns attached images to the DSH session history.
  if (config.rotateAfterImage && imageInfo?.attached) {
    if (stableTaskId && registry.taskEntries?.get(stableTaskId)) registry.taskEntries.get(stableTaskId).forceRotate = true;
    entry.turns = Math.max(entry.turns, config.rotateEveryTurns);
    registry.persist?.(key);
    stats.imageTurnsRotated = (stats.imageTurnsRotated ?? 0) + 1;
  }
  if (!active()) return false;
  // 自动事实提炼不依赖模型回复或是否投递；旧标记在发言过滤前摘除。
  const remembered = extractRemember(reply, config);
  if (!config.memoryAutoExtract && memory) {
    for (const memo of remembered.memories) if (memory.append(speakerQq, speakerName, memo)?.added)
      stats.memoriesWritten = (stats.memoriesWritten ?? 0) + 1;
    if (remembered.memories.length) await memory.trim(speakerQq, speakerName, null);
  }
  if (spokeByTool) {
    // A progress message does not replace the final result. Deduplicate complete bubbles below.
    stats.spokeByToolTurns = (stats.spokeByToolTurns ?? 0) + 1;
    if (!reply.trim()) stats.noTextButSpoke = (stats.noTextButSpoke ?? 0) + 1;
    // Tool receipts already entered the window in onSpeechResult, at their send time.
    if (spokeTexts.length) stats.bubblesSent = (stats.bubblesSent ?? 0) + spokeTexts.length;
  }
  if (!reply.trim()) {
    if (spokeByTool) return finish(true, 'tool-only');
    /**
     * 「回复被吞」的诊断口径。
     *
     * 光写 `no text output` 分不清这几种完全不同的情况：
     *   endReason=blocked → **上游在起跑线上拒了这个回合**（权限/审批最常见），
     *                       连 step/start 都没有；群里的表现是"机器人突然哑了"
     *   assistantMsgs=0   → 这一轮模型根本没产出 assistant 消息
     *                       （很可能被 steer 的下一条提示并进同一轮了）
     *   assistantMsgs>0   → 有消息但没文本（纯工具调用 / 只有思考）
     *   endReason=...     → 是被谁结束的（aborted / 超时 / 正常）
     * 这几个数落在 `stats.lastTurn`，用 `#debug status` 看。
     */
    stats.noTextTurns = (stats.noTextTurns ?? 0) + 1;
    if (failure) {
      stats.lastError = `DSH 模型回合失败: ${key} / ${sessionId}: ` +
        `${failure.code ?? 'UNKNOWN'}: ${String(failure.message ?? '').slice(0, 800)}`;
      return finish(false, stats.lastError);
    }
    if (String(endReason).startsWith('blocked')) {
      stats.lastError =
        `turn blocked by harness: ${key} / ${sessionId} —— ` +
        (isSessionArchived(ctx, sessionId)
          ? 'DSH 会话已归档，下一次唤醒将创建新会话。'
          : 'DSH 的 agent/pre-step 拒绝运行；需检查会话归档状态及提交钩子。') +
        ` endReason=${endReason}`;
      return finish(false, stats.lastError);
    }
    stats.lastError =
      'no text output (turn/end=' +
      endReason +
      ', assistant=' +
      assistantMsgs +
      ', textParts=' +
      textParts +
      ')';
    return finish(false, stats.lastError);
  }
  const finishAttention = (phase) => {
    if (!attention) return;
    const decision = { conversation: key, messageId: event.message_id,
      ...attention, phase, at: Date.now() };
    stats.lastAttentionDecision = entry.lastAttentionDecision = decision;
    registry.persist(key);
  };
  let spoken = removeSentBubbles(remembered.text, spokeTexts);
  spoken = stripSyntheticPromptEcho(spoken);
  if (config.floorManagementEnabled !== false && /^\[WAIT\][。.!！\s]*$/u.test(spoken)) {
    if (spokeByTool) return finish(true, 'wait-after-tool');
    stats.floorWaits = (stats.floorWaits ?? 0) + 1;
    finishAttention('agent-waiting');
    if (floorPolicy?.originals && !stableTaskId) state.inputBatches?.hold(key, floorPolicy.originals);
    finish(false, 'agent-waiting');
    return { wait: true };
  }
  if (spokeByTool && spoken !== remembered.text.trim())
    stats.toolEchoesRemoved = (stats.toolEchoesRemoved ?? 0) + 1;
  if (!spoken) return finish(spokeByTool, 'empty-or-tool-echo');
  if (isSilence(spoken, config)) {
    spoken = stripSilence(spoken, config);
    if (!spoken) {
      stats.skippedSilence = (stats.skippedSilence ?? 0) + 1;
      finishAttention(spokeByTool ? 'spoke-by-tool' : 'agent-silent');
      return finish(spokeByTool, 'agent-silent');
    }
    stats.silenceStripped = (stats.silenceStripped ?? 0) + 1;
  }
  if (imageInfo?.present && !imageInfo.attached) {
    const cleaned = stripImageHallucination(spoken, config);
    spoken = cleaned.text;
    stats.imageHallucinations = (stats.imageHallucinations ?? 0) + cleaned.removed;
  }
  if (!spoken.trim()) return finish(false, 'image-filtered');
  if (event.__poke && event.message_type === 'group' && config.pokeAgentGroupText === false) {
    stats.pokeTextSuppressed = (stats.pokeTextSuppressed ?? 0) + 1;
    return finish(false, 'poke-text-disabled');
  }
  const isGroup = event.message_type === 'group';
  if (floorPolicy) {
    floorPolicy = { ...floorPolicy, task: Boolean(outcome.taskResultReady || floorPolicy.task) };
    const verdict = await recheckFloor(ctx, config, store, key, floorPolicy, entry, spoken, signal, stats);
    if (verdict.action !== 'keep') {
      stats.floorDeclined = (stats.floorDeclined ?? 0) + 1;
      finishAttention('reply-superseded');
      if (verdict.action === 'update') {
        const newer = verdict.newer.filter((m) => !m.otherTarget &&
          floorPolicy.authors.includes(m.qq) && verdict.evidence?.includes(m.messageId)).map((m) => m.event);
        state.inputBatches?.revisit(key, [...floorPolicy.originals, ...newer]);
      }
      return finish(false, 'floor:' + verdict.reason);
    }
  }
  /**
   * 同一条 turn 只投一次。
   *
   * 输入被并进正在跑的 turn 时，两条回复行会同时等到同一条 turn/end：认领了
   * turn 的那条（原回合）和被并进去的那条（merged）。谁先到这里谁投，另一条
   * 记一笔就退出 —— 重复发一条比漏发强，但两条一模一样的气泡依然是 bug。
   */
  if (!claimTurnDelivery(store, sessionId, outcome.turn ?? null, outcome.requestId ?? turnId)) {
    return finish(false,
      `同一条回合（turn ${outcome.turn}）已由另一条回复行投递，这里跳过以免重复`);
  }  /**
   * **排进发送队列就返回**，不等真发出去。
   *
   * 这是"发送来不及 → 下一个回合被卡住"的那一刀：气泡之间的打字节奏
   * （400~6000ms）和 OneBot 往返都改在队列里睡，回合立刻结束，
   * 下一条消息进来时能马上开始推理。
   *
   * 队列由 bootstrap 建好传进来（每个插件实例一个，跨会话共用）。
   * 没传时 `queueReply` 会退回一个按 ctx 缓存的兜底队列 ——
   * "没有队列"绝不能等于"一个字都不发"。
   */
  const delivery = queueReply(ctx, config, sendQueue ?? state.sendQueue ?? null, {
    entry,
    memory,
    stats,
    key,
    reply: spoken,
    shape,
    target: isGroup ? { group_id: event.group_id } : event?.__bridgeSource === 'bili'
      ? { receiver_uid: Number(event.user_id) } : { user_id: Number(event.user_id) },
    isGroup,
    speakerQq,
    speakerName,
    store,
    turnId,
    sourceRef,
    state,
    signal,
    // @ 自己一律不许：这里把登录号也带上，不只是配置里那份。
    selfIds: [...(config.selfIds ?? []), ...(event?.self_id != null ? [String(event.self_id)] : [])],
    canSend: active,
    floorPolicy,
    journal,
    journalId: turnId,
  });
  // Successful send callbacks own the awake window; queued plans are not speech.
  finishAttention(delivery.queued ? 'reply-queued' : 'delivery-skipped');
  if (!delivery.queued) {
    // 没真发出去就别占着"这条 turn 已投递"的名额，否则另一条回复行会被挡住。
    releaseTurnClaim(store, sessionId, outcome.turn ?? null, outcome.requestId ?? turnId);
    journal?.finish(turnId, 'delivery-policy-skipped');
  }
  return delivery.queued;
}
