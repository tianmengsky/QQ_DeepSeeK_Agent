import { waitWithSignal } from './cancellation.mjs';
import { replayFrames } from './replay.mjs';
import { isContextOverflow } from './context-overflow.mjs';

/** 发言工具名（MCP 工具在事件里的名字形如 mcp__qq__qq_say，所以按后缀匹配）。 */
const SAY_TOOL_SUFFIX = 'qq_say';
const SPEECH_TOOLS = ['qq_say', 'qq_send_group_msg', 'qq_send_private_msg', 'qq_send_sticker',
  'qq_send_custom_face', 'qq_send_library_sticker', 'qq_send_mface', 'qq_send_file', 'qq_send_ai_voice'];

export function speechTarget(name, raw) {
  const tool = SPEECH_TOOLS.find((t) => name === t || name?.endsWith('__' + t) || name?.endsWith('_' + t));
  if (!tool) return null;
  try {
    const args = typeof raw === 'object' ? raw : JSON.parse(String(raw));
    const conversation = tool === 'qq_say' || tool === 'qq_send_file' ? args.conversation : args.group_id != null
      ? 'group:' + args.group_id : args.user_id != null ? 'user:' + args.user_id : null;
    const text = tool === 'qq_send_file' ? `[文件 ${args.name ?? String(args.path ?? '').split(/[\\/]/).pop()}]`
      : tool === 'qq_send_ai_voice' ? `[语音：${String(args.text ?? '')}]`
      : tool === 'qq_say' ? String(args.text ?? '') : typeof args.message === 'string'
      ? args.message : Array.isArray(args.message) ? args.message.filter((p) => p.type === 'text')
        .map((p) => p.data?.text ?? '').join('') : '';
    return { conversation, text, idemKey: args.idem_key };
  } catch {}
  return null;
}

function taskResultTool(name, raw) {
  const tool = String(name ?? '');
  try {
    const args = typeof raw === 'object' ? raw : JSON.parse(String(raw));
    if (tool === 'qq_send_file' || tool.endsWith('__qq_send_file')) return true;
    return (tool === 'qq_workspace' || tool.endsWith('__qq_workspace')) &&
      ['write', 'pack'].includes(args.action);
  } catch { return false; }
}

function toolResultSucceeded(data) {
  if (data?.message?.isError || data?.error) return false;
  const receipt = data?.message?.structuredContent?.receipt;
  return !receipt || receipt.status === 'SUCCEEDED' && !receipt.dryRun;
}

function speechResultWasDelivered(data) {
  if (data?.message?.isError || data?.error) return false;
  const receipt = data?.message?.structuredContent?.receipt;
  if (receipt && (receipt.status !== 'SUCCEEDED' || receipt.dryRun)) return false;
  const text = (data?.message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return !/\[dry-run\]|状态=(?:UNKNOWN|EXECUTING|IN_FLIGHT|FAILED)|发送结果[^\n]*未知/.test(text);
}

export function speechReceipt(data, speech, fallbackId, fallbackAt = Date.now()) {
  const text = (data?.message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const structured = data?.message?.structuredContent?.receipt;
  const dryRun = Boolean(structured?.dryRun) || /\[dry-run\]/.test(text);
  const replayed = Boolean(structured?.replayed) || /幂等重放/.test(text);
  const state = dryRun ? 'SKIPPED' : structured?.status ??
    (/发送结果[^\n]*未知|状态=(?:UNKNOWN|EXECUTING)/.test(text) ? 'UNKNOWN' :
      data?.message?.isError || data?.error ? 'FAILED' : /^已发送到/m.test(text) ? 'SUCCEEDED' : 'UNKNOWN');
  return { id: structured?.id ?? speech.idemKey ?? fallbackId, state, dryRun, replayed,
    sentAt: Number(structured?.sentAt) || fallbackAt,
    onebotId: structured?.onebotId ?? /message_id=(-?\d+)/.exec(text)?.[1] ?? null };
}

/** 从 tool/call 的参数里抠出要发的话（模板字符串，不是 JSON，得容错）。 */
function textFromSayArguments(raw) {
  if (raw && typeof raw === 'object') return String(raw.text ?? '');
  const s = String(raw ?? '');
  if (!s) return '';
  const m = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s);
  if (!m) return '';
  try {
    return JSON.parse('"' + m[1] + '"');
  } catch {
    return m[1];
  }
}

function isSayTool(name) {
  const n = String(name ?? '');
  return n === SAY_TOOL_SUFFIX || n.endsWith('__' + SAY_TOOL_SUFFIX) || n.endsWith('_' + SAY_TOOL_SUFFIX);
}

function textPartsOf(data) {
  return (data?.message?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => String(p.text ?? ''));
}

/**
 * 按顺序拼一条 assistant 消息里的多个文本段，**丢弃重复的那一份**。
 *
 * 为什么需要（线上事故 2026-10-24）：a6api 的流偶尔把同一个 text block 开两次
 * —— `block-start(1,text)` 从未收尾，`block-start(2,text)` 又带着同一份完整
 * 正文收尾。适配器按块累积，一条消息里就出现两个内容相同的 text part。
 * 旧写法用 `''` 直接 join：正文翻倍，而且前一段结尾的 `[表情:38]` 会和后一段
 * 开头粘成 `[表情:38]哈？`，标记因此落到字符串中间、逃过摘取，最后当正文发进群。
 *
 * 去重只认三种**确定**的重复，其余情况仍按原样拼接：
 *   · 与已拼好的内容完全相同；
 *   · 是已拼好内容的尾巴（重发了尾部）；
 *   · 已拼好的内容是它的前缀（重发且更完整 → 用它替换）。
 * 后两条要求这一段本身够长，免得把「嗯」「。」这种正常的分段吞掉。
 * 是否同一段话，判据只有"一模一样"，不做相似度猜测 —— 递进式两句要留着。
 */
function mergeTextParts(parts) {
  let out = '';
  let dropped = 0;
  for (const part of parts) {
    const text = String(part ?? '');
    if (!text.trim()) continue;
    if (!out) {
      out = text;
      continue;
    }
    if (text === out) {
      dropped += 1;
      continue;
    }
    const long = text.trim().length >= 4;
    if (long && out.endsWith(text)) {
      dropped += 1;
      continue;
    }
    if (long && text.startsWith(out)) {
      dropped += 1;
      out = text;
      continue;
    }
    out += text;
  }
  return { text: out, dropped };
}

function textOfAssistantEvent(data) {
  return mergeTextParts(textPartsOf(data)).text;
}

async function runTurn(ctx, config, registry, key, content, stats, options = {}) {
  /**
   * 单轮超时。默认 `replyTimeoutMs`（180s），但**恢复**一个早已不存在的 DSH 会话
   * 不该等这么久：那种尝试注定失败，等满 3 分钟只是白占恢复通道。
   * 恢复路径传 options.timeoutMs（见 replyRecoveryTimeoutMs）。
   */
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : config.replyTimeoutMs;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  const sessionId = options.sessionId ?? (await registry.ensureSession(key));
  const controller = new AbortController();
  const streamSignal = AbortSignal.any([signal, controller.signal]);
  const wait = (promise) => waitWithSignal(promise, streamSignal);
  let iterator;
  let submitted = false;
  /**
   * 我这一轮在 DSH 里到底结束了没有（必须在 try 之外，catch 要读）。
   *
   * 调用方要用它决定"超时之后还要不要保留本轮归属"：`replyTimeoutMs` 只是
   * 桥接愿意等多久，它不会让 DSH 停下 —— 线上 2026-10-26 那一轮写六博棋 HTML
   * 跑到 6 分钟，桥接 180s 收工却把归属一起撤了，模型之后的 qq_send_file
   * 全被判成"没有本轮归属"。所以只有**真看到本轮的 turn/end**才算结束。
   */
  let turnEnded = false;
  const requestId = options.resume?.requestId ??
    ('qq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  try {
    stats.stage = 'follow-open';
    const address = { kind: 'session', sessionId };
    iterator = ctx.sessionController
      .follow({ address, ...(options.resume ? { maxMessages: 100 } : {}) }, streamSignal)
      [Symbol.asyncIterator]();
    const first = await wait(iterator.next());
    if (first.done || first.value?.type !== 'snapshot')
      throw new Error('DSH follow missing snapshot');
    const baseSeq = Number(options.resume?.baseSeq ?? first.value.cursor ?? -1);
    const backlog = options.resume
      ? await replayFrames(ctx.sessionController, first.value, address, baseSeq, streamSignal) : [];
    stats.stage = 'prompt';
    if (!options.resume) {
      options.onBeforePrompt?.({ requestId, baseSeq, sessionId });
      await wait(
        ctx.sessionController.prompt(
          { requestId, sessionId, mode: 'queue', content },
          streamSignal,
        ),
      );
      registry.entry(key).turns++;
      submitted = true;
      options.onSubmitted?.();
      registry.persist?.(key);
    } else submitted = true;
    /**
     * TTFT（首字延迟）从"提交成功"算到"第一条属于本轮的正文"。
     *
     * 为什么要单独记：`stats.lastTurn` 原来只有总时长，无法区分
     * "模型迟迟不出字"（供应商/线路问题，换模型就有救）和
     * "出了字但写很久"（提示词/输出长度问题）。线上实测两者差距很大 ——
     * 2026-10-21 抽 a6api 的四个真实回合：输出只有 27~35 字，
     * turn/start→assistant/message 却是 4.5s / 5.9s / 8.9s / 12.0s，
     * 也就是时间全花在等首字上，不是生成。
     */
    const promptedAt = Date.now();
    /**
     * 「从哪一刻起算我的正文」。正常回合就是提交时刻；恢复（resume）重连时
     * `promptedAt` 是重连时刻，拿它当界限会把原来那条回复的文本全过滤掉，
     * 所以退回这条消息的 QQ 时间（秒 → 毫秒）。
     */
    const metaTime = Number(options.resume?.event?.time ?? 0);
    const ownedSince = options.resume
      ? (metaTime > 0 && metaTime < 1e12 ? metaTime * 1000 : metaTime) || 0
      : promptedAt;
    let firstTextAt = null;
    stats.stage = 'reading';
    let reply = '',
      endReason = 'unknown';
    let intermediateTextParts = 0, intermediateChars = 0, replyTextParts = 0;
    // Only text after the last owned tool boundary belongs to the final delivery.
    // Earlier text stays in DSH history; immediate QQ progress must use qq_say.
    const discardIntermediate = () => {
      intermediateTextParts += replyTextParts;
      intermediateChars += reply.length;
      reply = '';
      replyTextParts = 0;
    };
    let failure = null;
    /**
     * 为什么要认 turn 号（这是「DSH 里有、QQ 里没有」的根因）：
     *
     * `mode: 'steer'` 的语义是「把这条输入喂给**正在跑的那个 turn**」，
     * 而不是新开一个 turn。如果另一条路径（心跳、戳、或并发的第二个提交）
     * 先把一个 turn 跑起来了，我这次提交会被并进去 —— **不会产生属于我的
     * turn/end**。
     *
     * 旧实现在循环里「看到第一个 turn/end 就收工」，于是：
     *   · 我的 submit 被并进别人的 turn → 我可能把**别人那段回复**当成自己的发出去；
     *   · 或者永远等不到属于我的 turn/end，整段文本读不到，一个字都发不出去。
     *
     * 现在用 queue 提交，不合并正在跑的回合；跟踪 rpcId 对应的 inbox 条目，
     * 在它被消费时确认 turn 号，只取这个 turn 的回复。
     * 不提供 inbox 标识的旧事件流才退回「第一个 turn/start」语义。
     */
    let myTurn = null,
      sawOtherTurnEnd = 0,
      steeredIntoRunningTurn = false,
      toolCalls = 0,
      sayToolCalls = 0;
    /**
     * 「我的输入被并进正在跑的 turn」时，那条 turn 里属于我的正文。
     *
     * 线上 2026-10-27 00:06 的真实事故：六博那一轮跑了十几分钟还没结束，
     * 「我的文件呢」「搜索一下姆巴佩」两条消息都被 DSH 并进那一轮。于是
     * **没有属于我的 turn/start**，旧实现把那一轮的 assistant 文本整段丢掉，
     * 群里一个字都没有 —— 用户在 GUI 里看得见答案，QQ 里什么都没有。
     *
     * 这个会话同一时刻只跑一个 turn（串行），所以我提交之后生成的文本就是
     * 对我这条输入的回复。收集起来，turn/end 时按证据决定要不要用。
     */
    let orphanText = '';
    let mergedReply = false;
    let endedTurn = null;
    // Modern DSH inbox events identify our queued prompt before it is consumed.
    // Do not claim a currently running turn, or an earlier queued prompt's turn.
    let currentTurn = null, queuedRequestSeen = Boolean(options.resume), requestConsumed = false, ownQueueIndex = null;
    let consumptionReported = false;
    const reportConsumption = () => {
      if (consumptionReported) return;
      consumptionReported = true;
      options.onConsumed?.({ turn: myTurn, requestId, sessionId });
    };
    /** callId → 这次 qq_say 说了什么、成没成。按 callId 配对是不怕 steer 合并的。 */
    const sayCalls = new Map();
    const speechCalls = new Map();
    const taskCalls = new Map();
    const sentSpeech = [];
    let taskResultReady = false;
    let assistantMsgs = 0,
      textParts = 0,
      sameSeq = 0,
      droppedTextParts = 0;
    let lastSeq = baseSeq;
    for (;;) {
      const step = backlog.length ? { value: backlog.shift(), done: false } : await wait(iterator.next());
      if (step.done) throw new Error('DSH follow ended before owned turn/end');
      const frame = step.value,
        event = frame?.event;
      if (frame?.type !== 'event' || !event || event.seq <= baseSeq) continue;
      if (event.type === 'compaction/summary') {
        // Compaction can summarize away the bridge's user-role static block
        // and message seeds. Never keep a dedupe cursor across that rewrite.
        const entry = registry.entry(key);
        entry.staticDone = false;
        entry.exampleHashes = {};
        entry.memoryHashes = {};
        entry.windowHashes = {};
        registry.persist?.(key);
        stats.contextCompactions = (stats.contextCompactions ?? 0) + 1;
        continue;
      }
      // 同一 seq 上出现多个事件 = 事件是分批推的，取回复时可能抢跑
      if (Number(event.seq) === lastSeq) sameSeq++;
      lastSeq = Number(event.seq);
      if (event.type === 'agent/inbox/spliced' && event.data?.target === 'next-turn') {
        const { start = 0, removedCount = 0, inserted = [] } = event.data;
        if (ownQueueIndex !== null) {
          if (ownQueueIndex >= start && ownQueueIndex < start + removedCount) {
            ownQueueIndex = null;
            if (event.data.outcome !== 'canceled') {
              requestConsumed = true;
              myTurn = currentTurn;
              reportConsumption();
            }
          } else if (ownQueueIndex >= start + removedCount) {
            ownQueueIndex += inserted.length - removedCount;
          }
        }
        const offset = inserted.findIndex((message) => message?.source?.rpcId === requestId);
        if (offset >= 0) {
          queuedRequestSeen = true;
          ownQueueIndex = start + offset;
          myTurn = null;
          reply = '';
        }
        continue;
      }
      if (event.type === 'turn/start') {
        currentTurn = Number(event.data?.turn);
        // Compatibility with older streams that do not expose inbox/request identities.
        if (!queuedRequestSeen && myTurn === null) { myTurn = currentTurn; reportConsumption(); }
        continue;
      }
      if (event.type === 'user/message' && event.data?.source?.rpcId === requestId) {
        requestConsumed = true;
        myTurn = event.data.turn === undefined ? currentTurn : Number(event.data.turn);
        reportConsumption();
        continue;
      }
      if (event.type === 'user/message' && String(event.data?.source?.rpcId ?? '').startsWith('qq-interject:') &&
          myTurn !== null && (event.data?.turn === undefined || Number(event.data.turn) === myTurn)) {
        /**
         * 两种注入的语义**不同**，不能共用一个"清空"：
         *
         * - `amend`（原作者本轮改了需求）：旧草稿答的是过期要求，必须作废，
         *   只认修订后的收尾答复。
         * - `all`（这一轮还没结束又来了新消息，`inTurnInjectionMode: all`）：
         *   注入指令自己就写着「最终答复仍以原请求为准」，所以**已经写出的正文
         *   不许丢**，修订后的部分接在后面。
         *
         * 反例（真踩过，2026-10-27 21:13）：用户问「还敢不敢了」，模型先答
         * 「……不敢了不敢了／再漏，我就把草稿自己咽下去」，紧接着群里又来一句
         * （被当成 all 注入），这里一个 discard 把上面那段整段作废，最终只发了
         * 后一句「概率这东西，只要漏过一次，就成 100% 了」—— 用户看到的是
         * 「问的那句没答、答的是别的事」。旧格式 rpcId 没有模式段，按 amend 走。
         */
        const interjectMode = /^qq-interject:(all|amend):/.exec(String(event.data?.source?.rpcId ?? ''))?.[1] ?? 'amend';
        if (interjectMode === 'amend') discardIntermediate();
        continue;
      }
      if (event.type === 'assistant/message') {
        assistantMsgs++;
        const parts = Array.isArray(event.data?.message?.content)
          ? event.data.message.content.filter((p) => p.type === 'text').length
          : 0;
        textParts += parts;
        /**
         * 只认**我那个 turn**里的文本。
         *
         * 老写法是"谁最后说话就取谁"，于是并发下容易把上一个 turn 的尾巴
         * 当成自己的回复发出去（也就是"发了不该发的话"）。
         * 事件里带 turn 号时按 turn 筛；不带（老事件形状）就退回全收。
         */
        const msgTurn = event.data?.turn === undefined ? null : Number(event.data.turn);
        /**
         * ⚠️ 只在**已经认领了自己的 turn**之后才收文本。
         *
         * 反例（真踩过）：并发路径先在这个会话里跑了一个 turn 并吐了文本，
         * 而我的 turn/start 还没出现 —— 这时候要是先收下，那条文本就会被
         * 当成我的回复、**发进 QQ 里一句不是我该说的话**。
         * 宁可这一轮不发（发言工具那条路仍然通），也不能发错话。
         *
         * 只有"事件不带 turn 号"（老形状，无从判断）时才退回全收。
         */
        // 事件不带 turn 号（老形状）→ 无从判断，退回全收；
        // 带了 turn 号就必须等自己那个 turn 被认领、且对得上。
        const claimable = msgTurn === null || (myTurn !== null && msgTurn === myTurn);
        if (claimable) {
          const merged = mergeTextParts(textPartsOf(event.data));
          if (merged.dropped) {
            droppedTextParts += merged.dropped;
            if (stats) stats.dupTextParts = (stats.dupTextParts ?? 0) + merged.dropped;
          }
          const text = merged.text;
          if (text.trim()) {
            firstTextAt ??= Number(event.time) || Date.now();
            reply += (reply ? '\n\n' : '') + text;
            replyTextParts += parts;
          }
          // DSH emits text and tool calls in the same model message (stopReason=toolUse).
          // This also works if a stream does not emit a separate tool/call frame.
          if (event.data?.message?.content?.some((p) => p.type === 'tool-call'))
            discardIntermediate();
        } else if (myTurn === null && (requestConsumed || Boolean(options.resume))) {
          /**
           * 输入被并进别人的 turn：先把文本收着，turn/end 时再决定（orphanText）。
           *
           * 必须有"我这条确实进了这个会话"的证据（收件箱里见过我的 rpcId，
           * 或这是恢复重连）—— 没有证据就一律不取，宁可这一轮不发，也不把
           * 别人那个 turn 的话发进群里。
           * 只收「我提交之后」生成的：事件带 time 时按时间筛，不带就无条件收
           * （老形状没有时间戳；宁可重复也不要静默丢话）。
           */
          const at = Number(event.time || 0);
          if (!at || at >= ownedSince) {
            const merged = mergeTextParts(textPartsOf(event.data));
            if (merged.text.trim()) orphanText += (orphanText ? '\n\n' : '') + merged.text;
            // 带 tool-call 的那段只是过程话，最终正文在工具之后。
            if (event.data?.message?.content?.some((p) => p.type === 'tool-call')) orphanText = '';
          }
        }
        continue;
      }
      if (event.type === 'tool/call') {
        if (myTurn === null) orphanText = '';
        if (event.data?.turn !== undefined && Number(event.data.turn) !== myTurn) continue;
        discardIntermediate();
        toolCalls++;
        const speech = speechTarget(event.data?.name, event.data?.arguments);
        if (speech?.conversation) speechCalls.set(String(event.data?.callId ?? ''), speech);
        if (taskResultTool(event.data?.name, event.data?.arguments))
          taskCalls.set(String(event.data?.callId ?? ''), true);
        if (isSayTool(event.data?.name)) {
          const callId = event.data?.callId;
          sayCalls.set(String(callId ?? '#' + sayToolCalls), {
            callId: String(callId ?? ''),
            text: textFromSayArguments(event.data?.arguments),
          });
          sayToolCalls++;
        }
        continue;
      }
      if (event.type === 'tool/result') {
        if (event.data?.turn !== undefined && Number(event.data.turn) !== myTurn) continue;
        const callId = String(event.data?.callId ?? event.data?.message?.toolCallId ??
          event.data?.message?.source?.callId ?? '');
        const sent = speechResultWasDelivered(event.data);
        if (taskCalls.get(callId) && toolResultSucceeded(event.data)) taskResultReady = true;
        taskCalls.delete(callId);
        const speech = speechCalls.get(callId);
        if (speech) options.onSpeechResult?.(speech,
          speechReceipt(event.data, speech, requestId + ':' + callId, Number(event.time) || Date.now()));
        if (speech?.conversation === key && sent) {
          sentSpeech.push(speech);
          const resultText = (event.data?.message?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          if (!/幂等重放/.test(resultText) && !event.data?.message?.structuredContent?.receipt?.replayed)
            options.onSpoke?.();
        }
        speechCalls.delete(callId);
        const say = sayCalls.get(callId);
        if (say) {
          say.error = Boolean(event.data?.message?.isError ?? event.data?.error);
          if (sent) say.ok = true;
        }
        continue;
      }
      if (event.type === 'turn/end') {
        const rawTurn = event.data?.turn;
        const ended = rawTurn === undefined ? null : Number(rawTurn);
        endedTurn = ended;
        if (queuedRequestSeen && !requestConsumed) {
          sawOtherTurnEnd++;
          stats.turnEndNotMine = (stats.turnEndNotMine ?? 0) + 1;
          continue;
        }
        // DSH pre-step rejection (for example an archived session), distinct from no model text.
        if (event.data?.reason?.kind === 'blocked')
          stats.blockedTurns = (stats.blockedTurns ?? 0) + 1;
        if (myTurn !== null && ended === myTurn) {
          endReason = event.data?.reason?.kind ?? 'unknown';
          if (endReason === 'error') failure = event.data.reason.error ?? null;
          break;
        }
        if (myTurn === null) {
          /**
           * 一个 turn/start 都没看到，却来了 turn/end —— 说明**我的输入被
           * steer 进了别人正在跑的 turn**，不存在属于我的那一段。
           *
           * 旧实现会把最后一个 assistant/message 当成自己的回复（张冠李戴），
           * 或者干脆把下一个 turn 的文本吃掉。现在两种情况都从"假设"变成
           * "证据"：只有当**这条流里真的出现过 assistant 文本**、且事件不带
           * turn 号（老形状，无从判断）时，才按老语义收下并如实标注；
           * 带 turn 号却不是我那个 turn → 一个字都不取。
           */
          const kind = event.data?.reason?.kind ?? 'unknown';
          if (kind === 'error') failure = event.data.reason.error ?? null;
          if (assistantMsgs > 0) {
            endReason = ended === null ? kind + '(no turn/start seen)' : kind + '(steered into running turn)';
            if (ended !== null) {
              steeredIntoRunningTurn = true;
              /**
               * 这里以前无条件 `reply = ''`：把"这不是我的 turn"当成"这段文本不是我的"。
               * 但输入被并进正在跑的 turn 时，那条 turn 里回复我的正文就是我的回复 ——
               * 丢掉它等于这轮静默消失（线上 2026-10-27 00:09 就这样丢了一条）。
               * 只有确实没收到"我提交之后"的文本时才留空。
               */
              reply = orphanText;
              mergedReply = reply.trim().length > 0;
              if (stats) stats.steeredIntoRunningTurn = (stats.steeredIntoRunningTurn ?? 0) + 1;
            }
            break;
          }
          // 连文本都没见到：死等只会撞 replyTimeoutMs 白丢一轮
          steeredIntoRunningTurn = true;
          endReason = kind + '(no assistant text seen)';
          if (stats) stats.steeredIntoRunningTurn = (stats.steeredIntoRunningTurn ?? 0) + 1;
          break;
        }
        // 别人的 turn 结束了：不能收工，我的还在里面
        sawOtherTurnEnd++;
        if (stats) stats.turnEndNotMine = (stats.turnEndNotMine ?? 0) + 1;
        continue;
      }
    }
    // 走到这里只可能是 break 出来的：本轮的结束形状已经确定。
    turnEnded = true;
    /**
     * 只认**成功**的 qq_say。
     *
     * 如果工具报错（会话对不上、发不出去），那话其实没进 QQ —— 这时候
     * 绝不能把最终文本也压掉，否则那一轮就彻底没声了。这是一条
     * "宁可重复也不静默丢话"的取舍：只有确认发出去了才抑制。
     */
    const sayOk = [...sayCalls.values()].filter((c) => c.ok && !c.error);
    const spokeTexts = [...new Set([...sayOk.map((c) => c.text), ...sentSpeech.map((c) => c.text)].filter(Boolean))];
    const spokeByTool = sayOk.length > 0 || sentSpeech.length > 0;
    if (sayToolCalls && !sayOk.length && stats)
      stats.sayToolFailed = (stats.sayToolFailed ?? 0) + 1;
    const endedAt = Date.now();
    const ttftMs = firstTextAt == null ? null : Math.max(0, firstTextAt - promptedAt);
    const totalMs = Math.max(0, endedAt - promptedAt);
    if (stats && ttftMs != null) {
      stats.ttftSamples = [...(stats.ttftSamples ?? []), ttftMs].slice(-30);
      stats.lastLatency = { ttftMs, totalMs, replyChars: reply.length,
        outputCharsPerSecond: totalMs > 0 ? Math.round((reply.length / totalMs) * 1000 * 10) / 10 : null };
    }
    stats.lastTurn = {
      at: Date.now(),
      conversation: key,
      sessionId,
      baseSeq,
      requestId,
      myTurn,
      assistantMsgs,
      textParts,
      ttftMs,
      totalMs,
      sameSeq,
      toolCalls,
      sayToolCalls,
      sayOk: sayOk.length,
      sawOtherTurnEnd,
      steeredIntoRunningTurn,
      mergedReply,
      endReason,
      failure,
      hasReply: reply.trim().length > 0,
      replyChars: reply.length,
      replySelection: 'post-tool-final',
      /** 上游重复吐出的文本段（已丢弃），非零说明这次的流不对劲。 */
      dupTextParts: droppedTextParts,
      intermediateTextParts,
      intermediateChars,
    };
    stats.stage = 'done';
    /**
     * `spokeByTool`：这一轮已经通过发言工具把话发出去了。
     * 调用方据此只去掉最终文本中已发过的完整气泡，新的结果仍然投递。
     * `spokeTexts` 是工具实际发出去的内容，用于最终正文去重；窗口在回执时记录。
     * `steeredIntoRunningTurn`：我的输入被并进了别人的 turn，没有属于我的文本。
     */
    const outcome = {
      reply,
      endReason,
      failure,
      ttftMs,
      totalMs,
      assistantMsgs,
      textParts,
      sameSeq,
      spokeByTool,
      taskResultReady,
      sayToolCalls,
      toolCalls,
      spokeTexts,
      steeredIntoRunningTurn,
      mergedReply,
      requestId,
      turn: myTurn ?? endedTurn,
      replySelection: 'post-tool-final',
      intermediateTextParts,
      intermediateChars,
    };
    // Save before cancellation checks, memory writes or enqueueing can interrupt delivery.
    options.onOutcome?.(outcome);
    return outcome;
  } catch (error) {
    // 仅明确“会话不存在”且尚未提交时允许重建；未知/已提交错误不能重发。
    const detail = String(error?.message ?? error);
    if (!submitted && (/session.*(?:not found|does not exist)/i.test(detail) ||
      ['SESSION_NOT_FOUND', 'session_not_found'].includes(error?.code))) error.sessionMissing = true;
    /**
     * 超窗标记只回答一个问题："这个 Session 还能不能继续用" —— 答案是不能。
     * 它不等于"可以重发"：是否重投由调用方按 recovered 只做一次（见 execute-turn）。
     */
    if (isContextOverflow(error)) error.contextOverflow = true;
    /**
     * 提交过、又没看到本轮的 turn/end → DSH 里那一轮**可能还在跑**。
     * 调用方据此保留归属（工具还得能用），不能把"我们不等了"当成"回合结束了"。
     */
    if (submitted && !turnEnded) error.turnStillRunning = true;
    throw error;
  } finally {
    controller.abort();
    if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
  }
}
export { textOfAssistantEvent, mergeTextParts, runTurn, isSayTool, SAY_TOOL_SUFFIX };
