import { HttpError, header, readBody, respond } from '../transport/http.mjs';
import { admitMessage, isAllowed, shouldRespond } from '../domain/admission.mjs';
import { renderMessage, isStickerImage, isPassiveReaction } from '../domain/events.mjs';
import { processPoke } from '../application/poke.mjs';
import { handleReactionNotice } from '../application/notices.mjs';
import { handleAddRequest } from '../application/requests.mjs';
import { maybeHandleDebug } from '../application/debug.mjs';
import { executeTurn } from '../application/execute-turn.mjs';
import { requestHeartbeat } from '../application/heartbeat.mjs';
import { statusSnapshot } from './status.mjs';
import { contextMessage } from '../conversation/context.mjs';
import { observeFloor, captureFloor, readFloor, recordFloorRecall } from '../conversation/floor.mjs';
import { InputBatches } from '../conversation/input-batches.mjs';
import { TaskLedger } from '../conversation/task-ledger.mjs';
import { TaskProgress, isProgressQuestion } from '../application/task-progress.mjs';
import { TaskScheduler } from '../application/task-scheduler.mjs';
import { transcribeIncomingVoice } from '../application/voice-transcription.mjs';

export function createHandler(
  ctx,
  config,
  registry,
  state,
  memory,
  stats,
  store = null,
  { sendQueue = null, loginWatch = null } = {},
) {
  if (config.taskLedgerEnabled !== false && store?.available)
    state.taskLedger ??= new TaskLedger(store);
  if (store?.available && store.db?.exec && store.db?.prepare)
    state.taskScheduler ??= new TaskScheduler({ ctx, config, registry, state, memory, stats, store, sendQueue });
  const batches = state.inputBatches ??= new InputBatches({ config, registry, state, stats,
    run: async (key, events, options) => {
      if (await state.taskScheduler?.admit(key, events, options)) return { admitted: true };
      const floor = readFloor(store, key, registry.entry(key));
      const event = events.find((e) => !e.__inputPassive && floor.messages.some((m) => m.messageId === String(e.message_id) && m.direct)) ?? events.find((e) => !e.__inputPassive);
      const result = await executeTurn(ctx, config, registry, state, memory, stats, store, key, event, {
        ...options, sendQueue, inputEvents: events,
        floorPolicy: config.floorManagementEnabled === false ? null : captureFloor(config, registry, key, events),
      });
      for (const input of events) state.taskLedger?.settleInput(input, result?.wait ? 'waiting_input' : 'handled');
      return result;
    }, onError: (error) => {
      if (state.disposed || state.controller?.signal.aborted) return;
      stats.lastError = String(error.stack ?? error).slice(0, 800);
      ctx.logger.warn('qq-bridge: 聚合回合失败 —— ' + error.message);
    } });
  state.taskProgress ??= new TaskProgress({ ctx, config, registry, state, memory, stats,
    store, ledger: state.taskLedger, sendQueue,
    fallback: (key, event) => batches.add(key, event) });
  return async (request, response) => {
    try {
      if (
        config.token &&
        (header(request, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '') !== config.token
      )
        throw new HttpError(401, 'invalid token');
      if (request.method === 'GET')
        return respond(
          response,
          200,
          // 队列优先用调用方注入的那个；bootstrap 也把它挂在 state 上，
          // 所以自检接口在任何入口下都报得出积压。
          statusSnapshot(config, registry, state, stats, store, sendQueue ?? state.sendQueue, {
            loginWatch: loginWatch ?? state.loginWatch ?? null,
          }),
        );
      if (request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST');
        throw new HttpError(405, 'method not allowed');
      }
      let event;
      let normalizedPoke = false;
      try {
        event = JSON.parse(await readBody(request, config.maxBodyBytes));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'body is not valid JSON');
      }
      if (!event || typeof event !== 'object' || Array.isArray(event))
        throw new HttpError(400, 'event must be an object');
      respond(response, 204);
      stats.posts++;
      stats.lastEvent = {
        post_type: event.post_type,
        message_type: event.message_type,
        user_id: event.user_id,
        self_id: event.self_id,
        group_id: event.group_id,
        segments: Array.isArray(event.message)
          ? event.message.map((s) => ({ type: s?.type, keys: Object.keys(s?.data ?? {}) }))
          : typeof event.message,
      };
      const kind =
        event.post_type === 'notice'
          ? 'notice:' + event.notice_type + (event.sub_type ? ':' + event.sub_type : '')
          : event.post_type === 'request'
            ? 'request:' + event.request_type
            : String(event.post_type ?? 'unknown');
      stats.eventKinds ??= {};
      stats.eventKinds[kind] = (stats.eventKinds[kind] ?? 0) + 1;
      if (event.post_type === 'notice') {
        if (['group_recall', 'friend_recall'].includes(event.notice_type)) {
          const recalled = {
            ...event,
            message_type: event.notice_type === 'group_recall' ? 'group' : 'private',
          };
          const allowed =
            recalled.message_type === 'group'
              ? config.groupEnabled &&
                event.group_id != null &&
                isAllowed(config.groups, event.group_id)
              : admitMessage(config, recalled);
          if (!state.disposed && allowed && event.message_id != null) {
            const key =
              recalled.message_type === 'group'
                ? 'group:' + event.group_id
                : 'user:' + event.user_id;
            try {
              memory?.episodes?.retract(key, event.message_id);
              if (memory?.extractor) memory.extractor.retract(key, event.message_id);
              else memory?.facts?.retract(key, event.message_id);
            } catch (error) {
              ctx.logger.warn(`qq-bridge: 撤回记忆来源失败 —— ${error?.message ?? error}`);
            }
            const entry = registry.entry(key);
            recordFloorRecall(store, key, event.message_id, entry);
            entry.recalledIds = [
              ...new Set([...(entry.recalledIds ?? []), String(event.message_id)]),
            ].slice(-1000);
            for (const field of ['window', 'pending', 'pendingContext'])
              if (entry[field])
                entry[field] = entry[field].filter(
                  (m) => String(m.messageId) !== String(event.message_id),
                );
            registry.persist(key);
            stats.memoryRecalls = (stats.memoryRecalls ?? 0) + 1;
          }
          return;
        }
        if (event.notice_type === 'notify' && event.sub_type === 'poke') {
          stats.pokeReceived = (stats.pokeReceived ?? 0) + 1;
          event = await processPoke(ctx, config, event, state, stats, store,
            config.pokeReplyMode ?? 'agent', { registry });
          if (!event) return;
          normalizedPoke = true;
        } else if (event.notice_type === 'group_msg_emoji_like') {
          await handleReactionNotice(ctx, config, event, state, stats, store);
          return;
        } else return;
      }
      if (event.post_type === 'request') {
        await handleAddRequest(ctx, config, event, stats, store);
        return;
      }
      if (event.post_type !== 'message') return;
      // Internal trigger flags are accepted only from the normalization step.
      if (!normalizedPoke) {
        delete event.__poke;
        delete event.__pokeSender;
      }
      delete event.__inputId;
      delete event.__inputPassive;
      event.__receivedAt = Date.now();
      const key =
        event.message_type === 'group' ? 'group:' + event.group_id : 'user:' + event.user_id;
      stats.lastMessage = {
        message_type: event.message_type,
        user_id: event.user_id,
        group_id: event.group_id,
        at: Date.now(),
        raw: JSON.stringify(event.message ?? null).slice(0, 4000),
      };
      if (
        await maybeHandleDebug(
          ctx,
          config,
          event,
          registry.byKey.get(key) ?? {
            window: [],
            pending: [],
            recentQqs: [],
            turnsSinceSticker: 99,
          },
          memory,
          stats,
          state,
          registry,
        )
      )
        return;
      if (!state.enabled || state.disposed) {
        stats.skippedDisabled = (stats.skippedDisabled ?? 0) + 1;
        return;
      }
      if (!admitMessage(config, event)) {
        stats.filtered++;
        return;
      }
      const entry = registry.entry(key);
      const dedupeKey =
        config.dedupeIncoming && event.message_id != null
          ? 'onebot:' + (event.self_id ?? '') + ':' + event.message_id
          : null;
      if (dedupeKey && store?.available) {
        const rec = store.recordEvent({
          conversation: key,
          dedupeKey,
          kind: 'inbound',
          payload: {
            ...contextMessage(event),
          },
          deliverable: false,
        });
        if (rec.duplicate) {
          stats.duplicatesDropped = (stats.duplicatesDropped ?? 0) + 1;
          return;
        }
        store.pruneEvents(key, config.eventsKeepPerConversation);
      }
      transcribeIncomingVoice(config, event, registry, key, stats, ctx.logger, state.controller?.signal);
      if (!event.__poke)
        memory?.extractor?.observe(key, contextMessage(event), state.controller?.signal);
      if (config.floorManagementEnabled !== false) {
        observeFloor(config, registry, key, event);
        registry.record(entry, contextMessage(event));
        registry.persist(key);
      }
      if (config.floorManagementEnabled !== false && !event.__poke && isPassiveReaction(event)) {
        registry.buffer(entry, { ...contextMessage(event), conversation: key,
          dedupeKey: dedupeKey ? 'buf:' + dedupeKey : null });
        const pending = batches.entries.get(key);
        if (pending?.events.length || pending?.active.length || pending?.waitUntil > Date.now())
          batches.add(key, event, { passive: true });
        stats.passiveReactionsBuffered = (stats.passiveReactionsBuffered ?? 0) + 1;
        // Pure reactions are context only; don't ask heartbeat/DSH to classify them one by one.
        return;
      }
      const hasText =
        renderMessage(event.message)
          .replace(/\[[^\]]*\]/gu, '')
          .trim().length > 0;
      const hasImage = Array.isArray(event.message) &&
        event.message.some((s) => s?.type === 'image' && !isStickerImage(s));
      const hasVoice = config.voiceTranscriptionEnabled !== false && Array.isArray(event.message) &&
        event.message.some((s) => s?.type === 'record');
      const hasForward = Array.isArray(event.message) &&
        event.message.some((s) => s?.type === 'forward');
      const awake =
        config.awakeMs > 0 &&
        Date.now() < entry.awakeUntil &&
        event.message_type === 'group' &&
        (hasText || hasImage || hasVoice || hasForward);
      if (!shouldRespond(config, event) && !awake) {
        if (event.message_type === 'group') {
          registry.buffer(entry, {
            ...contextMessage(event),
            qq: event.user_id,
            who: event.sender?.card || event.sender?.nickname || String(event.user_id),
            text: renderMessage(event.message) || '[图片/表情等非文字内容]',
            images: Array.isArray(event.message)
              ? event.message.filter((s) => s?.type === 'image')
              : [],
            messageId: event.message_id,
            conversation: key,
            dedupeKey: dedupeKey ? 'buf:' + dedupeKey : null,
          });
          const pending = batches.entries.get(key);
          if (pending?.events.some((e) => !e.__inputPassive) ||
              pending?.active.some((e) => String(e.user_id) === String(event.user_id)) ||
              pending?.waitUntil > Date.now() && pending.waiting.some((e) =>
                (e.__waitUntil ?? pending.waitUntil) > Date.now() && String(e.__waitOwner ?? e.user_id) === String(event.user_id))) {
            batches.add(key, event);
            return;
          }
          requestHeartbeat(ctx, config, registry, state, memory, stats, store, key, {
            sendQueue,
          });
          const metric = config.heartbeatEnabled ? 'buffered' : 'contextBuffered';
          stats[metric] = (stats[metric] ?? 0) + 1;
        } else stats.filtered++;
        return;
      }
      if (awake && !shouldRespond(config, event)) stats.awakeJoined = (stats.awakeJoined ?? 0) + 1;
      entry.lastMessageAt = Date.now();
      stats.accepted++;
      state.taskLedger?.input(key, event);
      // Keep a progress-shaped fragment with an unclaimed same-author batch.
      // Otherwise the read-only progress lane consumes it before the ordinary
      // Agent can see the preceding fragment and decide its meaning.
      if (state.taskScheduler?.mode !== 'enabled' && isProgressQuestion(event) && batches.hasPendingAuthor(key, event.user_id)) {
        stats.taskProgressBuffered = (stats.taskProgressBuffered ?? 0) + 1;
        batches.add(key, event, { route: 'same-author-progress-fragment' });
        return;
      }
      // Enabled routing owns the whole semantic batch. A progress-shaped prefix
      // must not steal a following correction from the running task.
      if (state.taskScheduler?.mode !== 'enabled' && state.taskProgress.accept(key, event)) return;
      if (state.taskScheduler?.enabled && !event.__poke) {
        batches.add(key, event);
        return;
      }
      if (!event.__poke && (config.inputDebounceMs ?? 1500) > 0) {
        batches.add(key, event);
        return;
      }
      const signal = state.controller?.signal;
      registry
        .run(key, async () => {
          const result = await executeTurn(ctx, config, registry, state, memory, stats, store, key, event, {
            signal,
            sendQueue,
            floorPolicy: config.floorManagementEnabled === false ? null : captureFloor(config, registry, key, [event]),
          });
          state.taskLedger?.settleInput(event, result?.wait ? 'waiting_input' : 'handled');
          return result;
        })
        .catch((error) => {
          if (signal?.aborted || state.disposed) return;
          stats.lastError = String(error.stack ?? error).slice(0, 800);
          ctx.logger.warn('qq-bridge: ' + key + ' 处理失败 —— ' + error.message);
        });
    } catch (error) {
      if (response.headersSent) {
        stats.lastError = String(error.message);
        ctx.logger.warn('qq-bridge: 请求处理失败 —— ' + error.message);
        return;
      }
      respond(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : 'internal error',
      });
    }
  };
}
