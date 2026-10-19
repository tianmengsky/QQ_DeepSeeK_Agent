import { recordContext } from '../conversation/context.mjs';
import { onebotCall } from '../transport/onebot-client.mjs';
import { sendOnebotIdempotent } from './outbox.mjs';
import { ConversationSendQueue } from './send-queue.mjs';
import {
  extractRemember,
  extractStickerMarker,
  extractAtMentions,
  literalAtTarget,
  splitBubbles,
  bubbleDelayFor,
} from '../domain/reply-policy.mjs';
import { llmText } from '../memory/memory-store.mjs';
import { boundedText } from '../conversation/context.mjs';
import { cachedGroupMembers, cachedGroupMemberNames } from '../conversation/names.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
import { recheckFloor } from '../conversation/floor.mjs';
import { auxSelection } from '../agent/aux-model.mjs';

async function sendCustomFace(ctx, config, store, index, target, idemKey = '', signal) {
  const data = await onebotCall(config, 'fetch_custom_face', { count: 300 }, 15000, signal);
  const urls = Array.isArray(data) ? data : [];
  const url = urls[index - 1];
  if (!url) {
    throw new Error(`收藏表情没有第 ${index} 张（当前共 ${urls.length} 张）`);
  }
  const isGroup = target.group_id !== undefined;
  const conversation = isGroup ? `group:${target.group_id}` : `user:${target.user_id}`;
  return sendOnebotIdempotent(ctx, config, store, {
    idemKey: idemKey || `sticker:${conversation}:${index}:${Date.now()}`,
    conversation,
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    target,
    signal,
    message: [{ type: 'image', data: { file: url } }],
  });
}

/**
 * `[@昵称]` 的昵称 → QQ 号。
 *
 * 两个来源，先便宜后贵：
 *   ① 当前会话窗口里出现过的人（含这一轮的发言人）—— 免费，就在手上；
 *   ② 这个群最近一次拉到的成员表 —— 让"@一个没说过话的群友"也能成立
 *      （提示词因此可以建议她**优先写昵称**：名字比记一串数字可靠得多）。
 * 拿不准的重名一律当作"解析不了" —— 宁可这次不 @，也不能 @ 错人。
 * 照着窗口里的「昵称（QQ号）」整段抄下来也认（见 literalAtTarget）。
 */
function mentionResolver(entry, speakerQq, speakerName, memberNames = null) {
  const byQq = new Map();
  const byName = new Map();
  const add = (qq, name) => {
    const id = String(qq ?? '').trim();
    const label = String(name ?? '').trim();
    if (!id || !label) return;
    if (!byQq.has(id)) byQq.set(id, label);
    if (!byName.has(label)) byName.set(label, id);
    else if (byName.get(label) !== id) byName.set(label, null);
  };
  for (const message of entry?.window ?? [])
    if (!message?.bot && message?.qq) add(message.qq, message.who);
  add(speakerQq, speakerName);
  /** 成员表里的重名也算不可用。 */
  const fromMembers = (name) => {
    if (!memberNames) return null;
    const hits = [...memberNames.entries()].filter(([, label]) => label === name);
    return hits.length === 1 ? String(hits[0][0]) : null;
  };
  return (token) => {
    const literal = literalAtTarget(token);
    if (literal) return { qq: literal.qq, name: literal.name || byQq.get(literal.qq) || '' };
    const name = String(token ?? '').trim();
    if (byName.has(name)) {
      const qq = byName.get(name);
      return qq ? { qq, name } : null; // 窗口里重名 → 放弃，不去成员表里赌
    }
    const qq = fromMembers(name);
    return qq ? { qq, name } : null;
  };
}

/**
 * 气泡的两种形态：老计划里是字符串（含持久化日志、测试），新计划是对象。
 * 两边都得能发，否则升级前排队的那条回复会变成 `[object Object]`。
 */
function normalizeBubble(bubble) {
  if (typeof bubble === 'string')
    return { body: bubble, text: bubble, message: bubble, mentions: [], labels: [] };
  const body = String(bubble?.body ?? bubble?.text ?? '');
  return {
    body,
    text: String(bubble?.text ?? body),
    message: bubble?.message ?? body,
    mentions: Array.isArray(bubble?.mentions) ? bubble.mentions.map(String) : [],
    labels: Array.isArray(bubble?.labels) ? bubble.labels.map(String) : [],
  };
}

/**
 * 把"群里根本没有这个人"的 @ 摘掉，只留文字。
 *
 * 为什么必须拦在发送之前：OneBot 对解析不出 UID 的 at 段会把**整条消息**退回
 * （实测 `retcode=100 failed to resolve UID for UIN 2859252770`）——
 * 群里连正文都看不到，而且这条计划每 30 秒重试一次，按"较晚回复不得越过
 * 未完成计划"的规则会把该会话后面的回复一起挡住。她编一个号、或者那个人
 * 已经退群，都不该让整条消息发不出去。
 *
 * 名单不知道（没拉过 / 太旧）就放行：宁可漏拦，也不能凭旧名单拦掉真成员。
 * 放在 `buildSendItems` 里，是为了让**已经落库、正在重试**的计划也走同一条路 ——
 * 坏 @ 摘掉以后，卡住的那条会自己把正文发出去，会话随之解锁。
 */
function dropUnknownAtTargets(plan, bubble) {
  if (!bubble.mentions.length) return bubble;
  const members = cachedGroupMembers(plan.target?.group_id);
  if (!members) return bubble;
  const kept = [];
  const keptLabels = [];
  const gone = [];
  bubble.mentions.forEach((qq, index) => {
    if (members.has(String(qq))) {
      kept.push(qq);
      keptLabels.push(bubble.labels[index] ?? qq);
    } else gone.push({ qq, label: bubble.labels[index] ?? qq });
  });
  if (!gone.length) return bubble;
  const message = Array.isArray(bubble.message)
    ? bubble.message.filter(
        (segment) =>
          segment?.type !== 'at' || !gone.some((g) => g.qq === String(segment.data?.qq)),
      )
    : bubble.message;
  let text = bubble.text;
  for (const { label } of gone) text = text.replace(`@${label}`, '');
  // 摘掉句首/句尾的 @ 会留下一个孤零零的空格（" 有人找你"），收掉
  text = text.replace(/^[ \t]+/u, '').replace(/[ \t]+$/u, '');
  if (plan.stats) plan.stats.atMentionDropped = (plan.stats.atMentionDropped ?? 0) + gone.length;
  plan.ctx?.logger?.info?.(
    `qq-bridge: 摘掉 ${gone.map((g) => g.qq).join('、')} 的 @ —— 不在群 ` +
      `${plan.target?.group_id} 的成员表里（留着会让整条消息被 OneBot 退回）`,
  );
  return {
    ...bubble,
    text,
    message: kept.length ? message : text,
    mentions: kept,
    labels: keptLabels,
    /** 内容被改过：调用方必须换一个幂等编号（同号只能对应同一份内容）。 */
    degraded: true,
  };
}

function registryRecordSelf(
  config,
  entry,
  body,
  { store = null, conversation = null, dedupeKey = null, onebotId = null, at = Date.now() } = {},
) {
  const text = boundedText(body);
  const messageId = onebotId ?? (dedupeKey ? 'self:' + dedupeKey : null);
  recordContext(config, entry, { qq: '', who: '你', text, bot: true, messageId, at, timeSource: 'sent' });
  if (store?.available && conversation)
    store.recordEvent({
      conversation: String(conversation),
      kind: 'self_message',
      payload: { text, who: '你', qq: '', messageId, at, timeSource: 'sent' },
      deliverable: false,
      dedupeKey: dedupeKey ? 'self:' + dedupeKey : null,
    });
}

/**
 * 决定"要不要说、说什么、怎么拆、什么时候发"，但**一条都不发**。
 *
 * 拆出来是为了让"发送"能脱离 Agent 回合（见 send-queue.mjs）：
 * 计划在回合里算（便宜、同步），真发在队列里做（慢、睡觉）。
 *
 * @returns {null|object} null = 这轮什么都不发
 */
function planDelivery(ctx, config, opts) {
  const {
    entry,
    memory,
    stats,
    key,
    reply,
    shape,
    target,
    isGroup,
    speakerQq,
    speakerName,
    store = null,
    turnId = '',
    signal,
    canSend = () => true,
  } = opts;
  if (signal?.aborted || !canSend()) return null;
  if (isGroup && !config.replyToGroups) return null;
  let memoryTrim = null;
  // 摘出 [记住:...] 写进这个人的长期记忆
  const remembered = extractRemember(reply, config);
  for (const memo of remembered.memories) {
    if (config.memoryAutoExtract) break;
    if (!memory) break;
    const res = memory.append(speakerQq, speakerName, memo);
    if (res?.added) {
      stats.memoriesWritten = (stats.memoriesWritten ?? 0) + 1;
      ctx.logger.info(`qq-bridge: 记住 ${speakerName}(${speakerQq}) —— ${memo.slice(0, 60)}`);
    }
  }
  if (memory && !config.memoryAutoExtract && remembered.memories.length) {
    const selection = auxSelection(ctx, config);
    const summarizer = ctx.get('llm')
      ? (digest) =>
          llmText(
            ctx,
            selection,
            '把下面这些关于同一个人的零散记忆合并成一句不超过 60 字的中文事实陈述，只输出这句话本身，不要解释。',
            digest,
          )
      : null;
    // ⚠️ 这里**不能**为了"同步"把它变成不 await 的浮动 promise：
    //    摘要失败会让记忆文档停在超限状态，而下一轮不会再触发 trim。
    //    所以计划里存着这个 promise，两条投递路径都负责把它认领掉。
    memoryTrim = Promise.resolve()
      .then(() => memory.trim(speakerQq, speakerName, summarizer))
      .then((n) => n && ctx.logger.info(`qq-bridge: 记忆超过上限，已摘要 ${n} 条`))
      .catch((error) => ctx.logger.warn(`qq-bridge: 记忆摘要失败 —— ${error?.message ?? error}`));
  }

  const { text: body, sticker } = extractStickerMarker(remembered.text);
  const cap = shape?.bubbles ?? config.maxBubbles;
  /**
   * @ 只在群聊里做（私聊没有"点名"这回事），并且要她**自己**写了标记才发 ——
   * 默认一个都不带。解析不出来就把标记摘掉，绝不让语法漏进群里。
   */
  const atAllowed = isGroup && config.atMentionEnabled !== false;
  const atResolve = atAllowed
    ? mentionResolver(entry, speakerQq, speakerName, cachedGroupMemberNames(target?.group_id))
    : null;
  const selfIds = (opts.selfIds ?? config.selfIds ?? []).map(String);
  const bubbles = splitBubbles(body, cap)
    .map((text) =>
      text.length > config.maxReplyChars ? text.slice(0, config.maxReplyChars) + '…' : text,
    )
    .map((text) => {
      const at = extractAtMentions(text, {
        resolve: atResolve,
        selfIds,
        allow: atAllowed,
        maxAts: config.atMentionMax,
      });
      if (at.dropped) stats.atMentionDropped = (stats.atMentionDropped ?? 0) + at.dropped;
      if (at.mentions.length) stats.atMentions = (stats.atMentions ?? 0) + at.mentions.length;
      return {
        body: text,
        text: at.text,
        message: at.message ?? at.text,
        mentions: at.mentions,
        labels: at.labels,
      };
    });
  if (shape && splitBubbles(body, 99).length > shape.bubbles)
    stats.shapeOvershoot = (stats.shapeOvershoot ?? 0) + 1;
  // 表情包：形状没抽到、或间隔没到，就不发（并在 stats 里记下是"被压掉"而不是"没想发"）
  const stickerWanted = sticker !== null;
  const stickerAllowed =
    stickerWanted &&
    !(shape && !shape.sticker) &&
    (entry.turnsSinceSticker ?? 99) >= config.stickerMinGapTurns;
  if (stickerWanted && !stickerAllowed)
    stats.stickersSuppressed = (stats.stickersSuppressed ?? 0) + 1;

  const plan = {
    key,
    isGroup,
    target,
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    idemBase: turnId || key + ':' + Date.now(),
    bubbles,
    sticker: stickerAllowed ? sticker : null,
    signal,
    store,
    stats,
    entry,
    ctx,
    speakerQq,
    speakerName,
    turnId,
    memory,
    sourceRef: opts.sourceRef ?? null,
    floorPolicy: opts.floorPolicy ?? null,
    /** 真发之前还会再调一次（排队期间托管可能被关掉）。 */
    canSend,
    /** 记忆摘要的收尾 promise（可能为 null），两条投递路径都要认领它。 */
    memoryTrim,
  };
  // 发不出去的计划不值得排队（整条被压掉时 "stickerAllowed" 已经记过一笔）
  if (!bubbles.length && plan.sticker === null) return null;
  entry.turnsSinceSticker = plan.sticker !== null ? 0 : (entry.turnsSinceSticker ?? 99) + 1;
  return plan;
}

/** 记住自己的 message_id（表情回应要靠它判断"这个赞是给我的"）。 */
function rememberOwnId(state, key, result) {
  if (!state || !result?.onebotId) return;
  state.ownMessageIds ??= new Set();
  state.ownMessageConversations ??= new Map();
  state.ownMessageIds.add(String(result.onebotId));
  state.ownMessageConversations.set(String(result.onebotId), key);
  if (state.ownMessageIds.size > 200) {
    const id = state.ownMessageIds.values().next().value;
    state.ownMessageIds.delete(id);
    state.ownMessageConversations.delete(id);
  }
}

/** 一批的发送结果 → 报告 + 记账。 */
function applyBatchReport(config, plan, batch, report) {
  const { key, stats, entry, store } = plan;
  const sentTexts = [];
  let failed = false;
  let stickerError = null;
  let stickerHeld = false;
  for (const row of batch?.results ?? []) {
    const { item, result } = row;
    if (item.kind === 'text') {
      const shown = item.display ?? item.body ?? '';
      report.text.push({
        ...result,
        index: item.index,
        deliveredText: result.sent || result.status === 'SUCCEEDED' ? shown : '',
      });
      if (result.sent) {
        report.sentAny = true;
        stats.bubblesSent = (stats.bubblesSent ?? 0) + 1;
        sentTexts.push(shown);
        rememberOwnId(plan.state, key, result);
      } else stats.sendSuppressed = (stats.sendSuppressed ?? 0) + 1;
      if (result.held) report.unknown = true;
      if (!result.sent && !result.replayed) failed = true;
    } else if (item.kind === 'sticker') {
      report.sticker = result;
      if (result.sent) {
        report.sentAny = true;
        rememberOwnId(plan.state, key, result);
        stats.stickersSent = (stats.stickersSent ?? 0) + 1;
      } else if (result.held) {
        report.unknown = true;
        stickerHeld = true;
      } else if (result.error || !result.replayed) {
        stickerError = result.error ?? '未发送';
      }
    }
  }
  if (sentTexts.length) stats.lastBubbles = sentTexts;
  if (report.text.some((r) => !r.sent && !(r.replayed && r.status === 'SUCCEEDED'))) failed = true;
  report.partial = report.sentAny && (failed || Boolean(stickerError) || stickerHeld);
  report.queued = true;
  if (!report.sentAny && failed) stats.sendFailures = (stats.sendFailures ?? 0) + 1;
  return report;
}

/**
 * 建一批要发的条目（含 `at` = 允许发送的最早时刻）。
 *
 * `at` 在规划阶段就算好，队列只照做 —— 这样"打字节奏"的算法仍然只有一份。
 */
function buildSendItems(config, plan) {
  const items = [];
  let readyAt = Date.now();
  const { bubbles, signal, store, key } = plan;
  /**
   * 排队 ≠ 已发。真发之前必须**再判一次**能不能发：
   * 排队期间托管可能被关掉、回合可能被取消 —— 那时候一个字都不该出去。
   */
  const stopped = async (candidate) => {
    if (signal?.aborted === true || plan.canSend?.() === false) return true;
    if (!plan.floorPolicy) return false;
    const result = await recheckFloor(plan.ctx, config, store, key, plan.floorPolicy, plan.entry,
      candidate, signal, plan.stats);
    if (signal?.aborted === true || plan.canSend?.() === false) return true;
    if (result.action === 'keep') return false;
    if (result.action === 'update') {
      const newer = result.newer.filter((m) => !m.otherTarget && plan.floorPolicy.authors.includes(m.qq) &&
        result.evidence?.includes(m.messageId)).map((m) => m.event);
      plan.state?.inputBatches?.revisit(key, [...plan.floorPolicy.originals, ...newer]);
    }
    plan.stats.floorDeclined = (plan.stats.floorDeclined ?? 0) + 1;
    return 'floor:' + result.reason;
  };
  const rows = bubbles.map((b) => dropUnknownAtTargets(plan, normalizeBubble(b)));
  for (let i = 0; i < rows.length; i++) {
    const bubble = rows[i];
    /**
     * 摘掉 @ 之后内容变了，就必须换一个幂等编号 ——
     * outbox 的规矩是"同一个编号只能对应同一份内容"，沿用旧号会被
     * 判成"幂等编号冲突：已存在但内容不同"，等于换个理由继续卡住
     * （这条是线上实测踩出来的）。
     */
    const idemKey = plan.idemBase + '#b' + i + (bubble.degraded ? '#noat' : '');
    items.push({
      kind: 'text',
      index: i,
      /** 原始正文（含标记）：和"最终回复"原文比对去重时要的是它。 */
      body: bubble.body,
      /** 人真正看到的样子（`[@:123]` → `@昵称`）：进窗口、进统计用这个。 */
      display: bubble.text,
      /** 真发给 OneBot 的：没有 @ 时仍是纯字符串。 */
      message: bubble.message,
      mentions: bubble.mentions,
      idemKey,
      at: readyAt,
      gate: () => stopped(rows.slice(i).map((row) => row.text).join('\n')),
      run: (send) =>
        send({
          kind: 'text',
          idemKey,
          conversation: key,
          target: plan.target,
          action: plan.action,
          message: bubble.message,
          signal,
        }),
    });
    // 下一个气泡要等"上一个气泡的字数 × 每字毫秒"，这就是打字节奏。
    if (i < rows.length - 1) readyAt += bubbleDelayFor(rows[i + 1].body, config);
  }
  if (plan.sticker !== null) {
    const index = plan.sticker;
    const idemKey = plan.idemBase + '#s';
    items.push({
      kind: 'sticker',
      index,
      idemKey,
      at: readyAt,
      gate: () => stopped('[表情:' + index + ']'),
      run: (send) =>
        send({
          kind: 'sticker',
          idemKey,
          conversation: key,
          target: plan.target,
          action: plan.action,
          sticker: index,
          signal,
        }),
    });
  }
  return items;
}

/** 默认发送实现：走幂等 outbox；表情走 fetch_custom_face + 图片段。 */
function defaultSend(ctx, config, plan) {
  return async (req) => {
    if (req.kind === 'text')
      return sendOnebotIdempotent(ctx, config, plan.store, {
        idemKey: req.idemKey,
        conversation: req.conversation,
        action: req.action,
        target: req.target,
        message: req.message,
        // Once a durable send starts, let its bounded OneBot request settle through HMR.
        signal: plan.journal ? undefined : req.signal,
      });
    return sendCustomFace(
      ctx,
      config,
      plan.store,
      req.sticker,
      req.target,
      req.idemKey,
      plan.journal ? undefined : req.signal,
    );
  };
}

/**
 * 给队列用的条目：把 `send` 包进每个 item 的 `run` 里。
 *
 * 队列本身不认识 OneBot、不认识幂等 —— 它只会"到点了就调 run"。
 */
function bindItems(config, plan, send) {
  return buildSendItems(config, plan).map((item) => ({
    ...item,
    run: async () => {
      const ledger = plan.memory?.episodes;
      /** 窗口/记忆里记的是"人看到的样子"，不是带标记的原文。 */
      const shown = item.kind === 'text'
        ? (item.display ?? item.body ?? '')
        : '[收藏表情 #' + item.index + ']';
      const record = (state, onebotId = null) => ledger?.action({ id: item.idemKey,
        sourceRef: plan.sourceRef, conversation: plan.key,
        text: shown, state, onebotId });
      let result;
      try {
        const receipt = plan.store?.getReceipt?.(item.idemKey);
        if (receipt?.status === 'SUCCEEDED') {
          // 幂等编号只能对应同一份内容；@ 段也在比对范围内。
          if (item.kind === 'text' &&
              receipt.payload !== JSON.stringify({ ...plan.target, message: item.message }))
            throw new Error('幂等编号冲突：' + item.idemKey);
          record('SUCCEEDED', receipt.onebotId);
          rememberOwnId(plan.state, plan.key, { onebotId: receipt.onebotId });
          registryRecordSelf(config, plan.entry, shown, {
            store: plan.store, conversation: plan.key, dedupeKey: item.idemKey,
            onebotId: receipt.onebotId, at: receipt.updatedAt,
          });
          return { sent: false, replayed: true, status: 'SUCCEEDED', onebotId: receipt.onebotId };
        }
        result = await item.run(send);
        if (!result?.replayed) record(result?.status ?? (result?.sent ? 'SUCCEEDED' : 'UNKNOWN'), result?.onebotId);
      } catch (error) {
        const receipt = plan.store?.getReceipt?.(item.idemKey);
        record(receipt?.status ?? (error?.code === 'QQ_SEND_QUOTA' ? 'SKIPPED' : 'UNKNOWN'), receipt?.onebotId);
        /**
         * ⚠️ 这里**不**记 journal.error：重试、计数、放弃投递都由
         * `enqueuePlan` 的收尾统一决定（它能看到整批回执，分得清
         * "明确失败 / 结果未知 / 配额等会儿再来"）。两处都记会让
         * 重试次数翻倍，一条消息两轮就被判"放弃"。
         */
        throw error;
      }
      if (result?.sent) wakeAfterSpeech(config, plan.entry, result.sentAt ?? Date.now());
      // Record each receipt immediately; batch completion is not its send time.
      if (result?.sent || (result?.replayed && result.status === 'SUCCEEDED' && result.sentAt))
        registryRecordSelf(config, plan.entry, shown, {
          store: plan.store, conversation: plan.key, dedupeKey: item.idemKey,
          onebotId: result.onebotId, at: result.sentAt ?? Date.now(),
        });
      return result;
    },
  }));
}

/** 在回合里**等**发完（老行为；测试和 `deliverReply` 用它）。 */
async function deliverReplyDetailed(ctx, config, opts) {
  const report = { text: [], sticker: null, sentAny: false, partial: false, unknown: false };
  const plan = planDelivery(ctx, config, opts);
  if (!plan) return report;
  plan.state = opts.state ?? null;
  const queue = new ConversationSendQueue({ logger: ctx.logger });
  try {
    const batch = await queue.enqueue({
      key: plan.key,
      items: bindItems(config, plan, defaultSend(ctx, config, plan)),
    });
    const out = applyBatchReport(config, plan, batch, report);
    await plan.memoryTrim;
    return out;
  } finally {
    queue.dispose();
  }
}

/** 兼容旧调用：只要布尔。 */
async function deliverReply(ctx, config, opts) {
  return (await deliverReplyDetailed(ctx, config, opts)).sentAny;
}

/**
 * 把一轮回复**排进队列就返回** —— Agent 回合走这条。
 *
 * 这是"发送不再卡住下一个回合"的那一刀：回合不等气泡之间的打字节奏，
 * 也不等 onebot 往返。下一轮消息进来时，回合可以立刻开始。
 *
 * ⚠️ 返回值只说明**排上了没有**，不代表已送达。
 *    送达结果（含 UNKNOWN）异步记进 `stats` 和持久化 DB，
 *    可用 `#debug status` / `qq_reliability_status` 核对。
 */
function queueReply(ctx, config, queue, opts) {
  const report = { text: [], sticker: null, sentAny: false, partial: false, unknown: false };
  const outbound = queue ?? fallbackQueue(ctx);
  if (!outbound) return { queued: false, plan: null, report };
  const plan = planDelivery(ctx, config, opts);
  if (!plan) return { queued: false, plan: null, report };
  plan.state = opts.state ?? null;
  if (opts.journal && opts.journalId) {
    plan.journal = opts.journal;
    plan.journalId = opts.journalId;
    opts.journal.planned(opts.journalId, {
      key: plan.key, isGroup: plan.isGroup, target: plan.target, action: plan.action,
      idemBase: plan.idemBase, bubbles: plan.bubbles, sticker: plan.sticker,
      speakerQq: plan.speakerQq, speakerName: plan.speakerName,
      turnId: plan.turnId, sourceRef: plan.sourceRef,
      floorPolicy: plan.floorPolicy,
    });
    // Preserve order among deliverable plans; uncertain receipts hold only their own plan.
    if (opts.journal.deliveryHead(plan.key)?.id !== opts.journalId)
      return { queued: true, plan, report };
  }
  return enqueuePlan(ctx, config, outbound, plan, report);
}

export function queuePersistedPlan(ctx, config, queue, row, opts) {
  const plan = { ...row.plan, ...opts, ctx, store: opts.journal.store,
    journalId: row.id };
  return enqueuePlan(ctx, config, queue, plan,
    { text: [], sticker: null, sentAny: false, partial: false, unknown: false });
}

function enqueuePlan(ctx, config, outbound, plan, report) {
  const journal = plan.journal;
  const id = plan.journalId;
  if (id && journal.sending.has(id)) return { queued: true, plan, report };
  if (id) journal.sending.add(id);
  const items = bindItems(config, plan, defaultSend(ctx, config, plan));
  // 摘出来的记忆摘要不能让回合等（它可能要调一次模型），但也不能丢。
  if (plan.memoryTrim) plan.memoryTrim.catch(() => {});
  if (!items.length) return { queued: false, plan, report };
  report.queued = true;
  outbound
    .enqueue({ key: plan.key, items })
    .then((batch) => {
      applyBatchReport(config, plan, batch, report);
      if (!id) return;
      const receipts = items.map((item) => plan.store.getReceipt(item.idemKey));
      if (batch.stopReason?.startsWith('floor:') && !receipts.some((r) => ['UNKNOWN', 'EXECUTING'].includes(r?.status)))
        journal.finish(id, batch.stopReason);
      else if (receipts.every((r) => r?.status === 'SUCCEEDED')) journal.finish(id);
      else {
        const unknown = receipts.some((r) => ['UNKNOWN', 'EXECUTING'].includes(r?.status));
        /**
         * 只有**明确失败**才计入重试上限。
         *
         * 配额被拒（SKIPPED）是"等会儿再来"，结果未知（UNKNOWN）要人工核对 ——
         * 把它们也算进去，就会出现"发得多了被限流，于是把一条本来能发出去的
         * 回复判成放弃"，那是拿丢消息换队列通畅。
         */
        const quota = batch.results.find((r) => r.result.code === 'QQ_SEND_QUOTA')?.result;
        const definite = batch.results.some((r) => r.result.code !== 'QQ_SEND_QUOTA' &&
          (r.result.status === 'FAILED' || r.result.error && !r.result.held));
        const error = batch.results.find((r) => r.result.error)?.result.error ??
          (batch.gated ? '托管暂停或回合取消，待恢复' : '投递尚未完成');
        const state = journal.error(id, error, { attention: unknown,
          retryAt: quota?.retryAt ?? (journal.get(id)?.retry_at > Date.now()
            ? journal.get(id).retry_at : Date.now() + 30000),
          maxAttempts: definite ? config.replyMaxSendAttempts : 0 });
        if (state === 'failed')
          ctx.logger.warn(
            `qq-bridge: ⚠ ${plan.key} 这条回复投递失败已达上限，已放弃并放开队列 —— ` +
              `${String(error).slice(0, 200)}（可在 status.replyDelivery.failed 里查）`,
          );
        if (unknown || !batch.gated) plan.stats.lastError = error;
      }
    })
    .catch((error) => {
      if (outbound.disposed || plan.state?.disposed) return;
      ctx.logger.warn(`qq-bridge: ${plan.key} 发送队列失败 —— ${error?.message ?? error}`);
      const stats = plan.stats;
      if (stats) {
        stats.sendFailures = (stats.sendFailures ?? 0) + 1;
        stats.lastError = String(error?.message ?? error).slice(0, 400);
      }
      if (id) journal.error(id, error?.message ?? error,
        { maxAttempts: error?.code === 'QQ_SEND_QUOTA' ? 0 : config.replyMaxSendAttempts,
          retryAt: error?.retryAt ?? Date.now() + 30000 });
    })
    .finally(() => { if (id) journal.sending.delete(id); });
  return { queued: true, plan, report };
}

/**
 * 调用方没给队列时的兜底。
 *
 * ⚠️ 为什么必须有：bootstrap 正常会传队列进来，但测试、以及将来新加的入口
 *    （控制路由、脚本）可能直接调 `createHandler` / `runHeartbeat`。
 *    那时"没有队列"绝不能等于"一个字都不发" —— 那是**静默丢消息**，
 *    正是这次要修的病。所以退回一个按需创建的队列：行为一样，
 *    只是每条会话的发送节奏从头开始记。
 *
 * 按 ctx 缓存：每次投递都新建队列的话，节奏记忆就永远建立不起来。
 */
const fallbackQueues = new WeakMap();
function fallbackQueue(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return null;
  let queue = fallbackQueues.get(ctx);
  if (!queue) {
    queue = new ConversationSendQueue({ logger: ctx.logger ?? null });
    fallbackQueues.set(ctx, queue);
  }
  return queue;
}

export {
  sendCustomFace,
  deliverReply,
  deliverReplyDetailed,
  queueReply,
  planDelivery,
  bindItems,
  registryRecordSelf,
  mentionResolver,
  normalizeBubble,
  dropUnknownAtTargets,
};
