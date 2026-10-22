import { heartbeatSnapshot } from '../routes/status.mjs';
import { localStamp } from '../domain/time.mjs';
import { auxHealthSnapshot } from '../agent/aux-attribution.mjs';

export function duration(ms) {
  const seconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (seconds < 60) return seconds + '秒';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + '分' + (seconds % 60 ? (seconds % 60) + '秒' : '');
  const hours = Math.floor(minutes / 60);
  return (
    (hours >= 24 ? Math.floor(hours / 24) + '天' : '') +
    (hours % 24) +
    '小时' +
    (minutes % 60 ? (minutes % 60) + '分' : '')
  );
}
export function redact(text, config) {
  let result = String(text ?? '');
  for (const secret of [config.token, config.onebotToken].filter(Boolean))
    result = result.replaceAll(secret, '[已隐藏]');
  return result.replace(/Bearer[ \t]+(?!\[已隐藏\])[^\s"'\\,}\]]+/gi, 'Bearer [已隐藏]');
}
const phaseNames = {
  idle: '待命',
  done: '本轮已结束',
  reading: '等待模型输出',
  ensureSession: '准备会话',
  prompt: '提交提示词',
  'follow-open': '连接模型事件流',
};
const phaseName = (stage) =>
  phaseNames[stage] ?? (String(stage).startsWith('snapshot:') ? '同步模型历史' : stage || '待命');
const count = (stats, key) => Number(stats[key]) || 0;
const model = (provider, name, fallback = '沿用全局默认') =>
  provider && name ? provider + '/' + name : fallback;

/** Read-only, bounded diagnostic data. No message bodies, credentials or production writes. */
export function debugSnapshot(config, registry, state, stats, memory, store, options = {}) {
  const now = options.now ?? Date.now();
  const heartbeat = heartbeatSnapshot(config, registry, state, stats, now);
  const groupMap = new Map(heartbeat.groups.map((g) => [g.conversation, g]));
  const entries = [...registry.byKey.entries()].sort(
    (a, b) => (b[1].lastMessageAt || 0) - (a[1].lastMessageAt || 0) || a[0].localeCompare(b[0]),
  );
  const selected = options.target ? entries.filter(([key]) => key === options.target) : entries;
  const page = Math.max(1, options.page || 1),
    pageSize = 20;
  const sessions = selected.slice((page - 1) * pageSize, page * pageSize).map(([key, entry]) => ({
    conversation: key,
    turns: entry.turns || 0,
    sessionId: entry.sessionId ?? null,
    contextTurn: entry.contextTurn || 0,
    windowOthers: entry.window.filter((m) => !m.bot).length,
    windowOwn: entry.window.filter((m) => m.bot).length,
    awakeRemainingMs: Math.max(0, (entry.awakeUntil || 0) - now),
    lastMessageAgoMs: entry.lastMessageAt ? Math.max(0, now - entry.lastMessageAt) : null,
    heartbeat: groupMap.get(key) ?? null,
  }));
  const queue = state.sendQueue?.stats?.() ?? null;
  let reliability;
  try {
    reliability = store?.available
      ? { enabled: true, counts: store.countByStatus() }
      : { enabled: false, reason: store?.degradedReason || '未启用' };
  } catch (error) {
    reliability = { enabled: false, reason: '读取失败：' + redact(error.message, config) };
  }
  const lastTurn = stats.lastTurn;
  const extractor = memory?.extractor;
  return {
    build: stats.build || '未知',
    since: stats.since ?? state.since ?? now,
    uptimeMs: Math.max(0, now - (stats.since ?? state.since ?? now)),
    agentEnabled: Boolean(state.enabled && !state.disposed),
    disposed: Boolean(state.disposed),
    stage: phaseName(stats.stage),
    conversationCount: entries.length,
    page,
    pages: Math.ceil(selected.length / pageSize),
    selectedCount: selected.length,
    sessions,
    tasks: { ...(state.taskLedger?.snapshot(state.replyJournal, now, options.target) ?? { available: false }),
      scheduler: state.taskScheduler?.snapshot() ?? { enabled: false },
      recoveryLane: { active: state.replyRecoveryActive?.size ?? 0, maxConcurrent: config.replyRecoveryConcurrency ?? 2 } },
    heartbeat: {
      ...heartbeat,
      groups: undefined,
      unread: heartbeat.groups.reduce((n, g) => n + g.unread, 0),
      checks: count(stats, 'heartbeatChecks'),
      declined: count(stats, 'heartbeatDeclined'),
      failed: count(stats, 'heartbeatFailed'),
      repliesStarted: count(stats, 'heartbeatSpoke'),
    },
    traffic: {
      posts: count(stats, 'posts'),
      accepted: count(stats, 'accepted'),
      filtered: count(stats, 'filtered'),
      disabled: count(stats, 'skippedDisabled'),
      duplicate: count(stats, 'duplicatesDropped'),
      debug: count(stats, 'debugCommands'),
      buffered: count(stats, 'buffered') + count(stats, 'contextBuffered'),
      awake: count(stats, 'awakeJoined'),
      silence: count(stats, 'skippedSilence'),
    },
    /**
     * 参与决策的去向 —— 当用户觉得"她太安静了"或"她怎么又不理我"时，
     * 这里能直接看出是决策判了沉默、还是被请求型护栏放行、还是判断失败 fail-open 了。
     */
    participation: {
      enabled: config.replyDecisionEnabled === true,
      checks: count(stats, 'replyDecisionChecks'),
      silent: count(stats, 'replyDecisionSilent'),
      requestShaped: count(stats, 'replyDecisionRequestShaped'),
      longAsk: count(stats, 'replyDecisionLongAsk'),
      failed: count(stats, 'replyDecisionFailed'),
      last: stats.lastReplyDecision ?? null,
      lastFailure: stats.lastReplyDecisionFailure ?? null,
    },
    /** 辅助判断层的健康度与退避阶梯（C）。 */
    auxHealth: auxHealthSnapshot({ now }),
    delivery: {
      queue,
      bubbles: count(stats, 'bubblesSent'),
      stickers: count(stats, 'stickersSent'),
      /** 真正送出去的 @ 个数 / 被摘掉的标记个数（想 @ 没 @ 上时看后者）。 */
      atMentions: count(stats, 'atMentions'),
      atMentionDropped: count(stats, 'atMentionDropped'),
      failures: count(stats, 'sendFailures'),
      suppressed: count(stats, 'sendSuppressed'),
      reliability,
    },
    agent: {
      model: model(config.llmProvider, config.llmModel),
      noText: count(stats, 'noTextTurns'),
      blocked: count(stats, 'blockedTurns'),
      steered: count(stats, 'steeredIntoRunningTurn'),
      toolSpoke: count(stats, 'spokeByToolTurns'),
      lastTurn: lastTurn
        ? {
            at: lastTurn.at,
            endReason: lastTurn.endReason,
            assistantMsgs: lastTurn.assistantMsgs,
            textParts: lastTurn.textParts,
            replyChars: lastTurn.replyChars,
            sayOk: lastTurn.sayOk,
            hasReply: lastTurn.hasReply,
            ttftMs: lastTurn.ttftMs ?? null,
            totalMs: lastTurn.totalMs ?? null,
          }
        : null,
    },
    memory: {
      enabled: Boolean(memory),
      owner: 'chat-agent',
      toolAvailable: Boolean(state.memoryToolAvailable),
      autoExtract: Boolean(memory && config.memoryAutoExtract),
      episodes: memory?.episodes?.snapshot() ?? { available: false },
      running: Boolean(extractor?.running),
      pending: [...(extractor?.entries?.values() ?? [])].reduce((n, e) => n + e.pending.length, 0),
      checks: count(stats, 'memoryExtractChecks'),
      written: count(stats, 'memoriesWritten'),
      corrected: count(stats, 'memoriesCorrected'),
      failed: count(stats, 'memoryExtractFailed'),
      rejected: count(stats, 'memoryCandidatesRejected'),
      /** 空输出/超时这类原因，以及"连续失败到上限被丢弃"的批次。 */
      lastFailure: stats.lastMemoryExtractFailure ?? null,
      abandoned: { batches: count(stats, 'memoryBatchAbandoned'),
        messages: count(stats, 'memoryMessagesAbandoned') },
    },
    events: { ...(stats.eventKinds ?? {}) },
    interaction: {
      pokeReceived: count(stats, 'pokeReceived'),
      pokeReplied: count(stats, 'pokeReplied'),
      pokeWoke: count(stats, 'pokeWoke'),
      pokeLimited: count(stats, 'pokeThrottled'),
      reactions: count(stats, 'reactionsSeen'),
      requests: count(stats, 'requestsReceived'),
    },
    config: {
      group: config.groupEnabled
        ? { at: '被@或叫名字', all: '所有消息', prefix: '指定前缀' }[config.groupTrigger] ||
          config.groupTrigger
        : '关闭',
      private: Boolean(config.privateEnabled),
      awakeMs: config.awakeMs,
      rotateEveryTurns: config.rotateEveryTurns,
      others: config.contextOthersMessages,
      own: config.contextOwnMessages,
      staticOnce: Boolean(config.injectStaticOnce),
      windowOnce: Boolean(config.injectWindowOnce),
      memoryOnChange: Boolean(config.memoryInjectOnChange),
      memoryInjectMaxChars: config.memoryInjectMaxChars,
      images: config.imagesEnabled ? config.imageMode : '关闭',
      heartbeatModel: model(config.heartbeatProvider, config.heartbeatModel, '沿用主对话模型'),
      memoryModel: model(config.memoryProvider, config.memoryModel, '沿用主对话模型'),
      poke: config.pokeReplyEnabled ? config.pokeReplyMode : '关闭',
      autoRequests: config.autoHandleRequests ? config.autoHandleRequestAction : '关闭',
    },
    lastError: stats.lastError ? redact(stats.lastError, config).slice(0, 400) : null,
  };
}

function groupLine(g, threshold) {
  const labels = {
    disabled: '暂停判断',
    checking: '判断/回复中',
    collecting: '等待积累',
    retry: '失败待重试',
    cooldown: '时间触发等待中',
    ready: '已达门槛，等待会话队列',
  };
  return (
    '未读 ' +
    g.unread +
    '/' +
    threshold +
    ' · ' +
    labels[g.phase] +
    (g.waitRemainingMs > 0 && ['retry', 'cooldown'].includes(g.phase)
      ? '（还需 ' + duration(g.waitRemainingMs) + '）'
      : '')
  );
}
function sessionsText(report, prefix, limit = 20) {
  const lines = [
    `【会话】共 ${report.selectedCount} 个 · 第 ${report.page}/${Math.max(1, report.pages)} 页`,
  ];
  for (const s of report.sessions.slice(0, limit)) {
    lines.push(
      `${s.conversation} · ${s.awakeRemainingMs ? '清醒 ' + duration(s.awakeRemainingMs) : '待唤醒'} · 提交 ${s.turns} 轮`,
      `  窗口：他人 ${s.windowOthers} / 自己 ${s.windowOwn}` +
        (s.lastMessageAgoMs === null
          ? ' · 暂无消息'
          : ' · 最近消息 ' + duration(s.lastMessageAgoMs) + '前'),
    );
    if (s.heartbeat) lines.push('  ' + groupLine(s.heartbeat, report.heartbeat.unreadThreshold));
  }
  if (!report.selectedCount) lines.push('暂无会话。');
  if (report.sessions.length > limit || report.page < report.pages)
    lines.push('更多：' + prefix + ' sessions' + (limit < 20 ? '' : ' ' + (report.page + 1)));
  return lines.join('\n');
}
function heartbeatText(r) {
  const h = r.heartbeat,
    lines = [
      '【心跳】' + (h.active ? '运行中' : h.enabled ? '已配置开启，托管或群聊关闭' : '关闭'),
      `每群未读 ${h.unreadThreshold} 条或等待 ${duration(h.cooldownMs)} 到期触发 · 兜底扫描 ${duration(h.recoveryMs)}`,
      `当前未读 ${h.unread} 条 · 判断 ${h.checks} / 不插话 ${h.declined} / 失败 ${h.failed} / 发起回复 ${h.repliesStarted}`,
    ];
  const d = h.lastDecision;
  if (d)
    lines.push(
      `最近：${d.conversation} · ${localStamp(new Date(d.at))} · ${d.unread} 条 · ${d.retry ? '判断失败，保留未读' : d.speak ? '适合插话' : '不插话'}` +
        (d.backoffMs ? ` · 退避 ${duration(d.backoffMs)}` : ''),
      '原因：' + (d.why || '未提供') + (d.cause ? `（${d.cause}）` : ''),
    );
  else lines.push('尚无判断记录。');
  return lines.join('\n');
}
function deliveryText(r) {
  const d = r.delivery,
    q = d.queue;
  const counts = Object.entries(d.reliability.counts ?? {})
    .map(([key, n]) => key + ' ' + n)
    .join(' / ');
  return [
    '【发送】',
    q ? `队列：${q.conversations} 个会话 / ${q.batches} 批 / ${q.items} 项` : '队列：不可用',
    `已发气泡 ${d.bubbles} · 表情 ${d.stickers} · 失败 ${d.failures} · 配额等拦截 ${d.suppressed}`,
    d.reliability.enabled ? '持久化回执：' + (counts || '暂无') : '持久化：' + d.reliability.reason,
    '“发起回复”仅表示已提交发送；实际送达看回执。',
  ].join('\n');
}
function memoryText(r) {
  const m = r.memory;
  const failure = m.lastFailure;
  return [
    '【记忆】' + (!m.enabled ? '关闭' : m.autoExtract ? '自动提炼聊天原文' : '回复标记写入'),
    `待提炼 ${m.pending} 条 · ${m.running ? '正在提炼' : '空闲'}`,
    `提炼 ${m.checks} 次 · 新写入 ${m.written} · 纠正 ${m.corrected} · 失败 ${m.failed} · 无效候选 ${m.rejected}`,
    `连续失败 ${m.abandoned.batches} 批被丢弃（共 ${m.abandoned.messages} 条原文）` +
      (failure ? ` · 最近 ${failure.cause}（连续 ${failure.failures} 次）` : ''),
  ].join('\n');
}
/** 成功率读数：没有样本就显示破折号，不显示 0%。 */
const percent = (value) => (value == null ? '—' : Math.round(value * 100) + '%');

/**
 * 辅助判断层的分项读数（C）。
 *
 * 为什么要有：整条辅助层失效时用户只看到"她变笨、变安静"，而各调用点自己
 * 只留下失败计数 —— 没有成功率、没有空输出占比，也就没法判断是不是该关掉它。
 */
function auxHealthText(h) {
  if (!h) return '【辅助判断层】不可用';
  const lines = [
    '【辅助判断层】' +
      (h.basis === 'recent-window' ? '最近 15 分钟' : '最近 ' + h.samples + ' 次') +
      ` · ${h.calls} 次 · 成功 ${h.ok} · 失败 ${h.failed} · 空输出 ${h.empty} · 成功率 ${percent(h.successRate)}` +
      (h.thinkingCalls
        ? ` · 有思考 ${h.thinkingCalls} 次（共 ${h.reasoningChars} 字，说明关思考没在服务端生效）`
        : ' · 未见思考分片'),
  ];
  const used = h.labels.filter((g) => g.calls);
  for (const g of used)
    lines.push(
      `${g.name}(${g.label}) ${g.calls} 次 · 失败 ${g.failed} · 空输出 ${g.empty} · ${percent(g.successRate)}` +
        (g.thinkingCalls ? ` · 思考 ${g.thinkingCalls} 次` : '') +
        (g.lastCause ? ' · 最近原因 ' + g.lastCause : ''),
    );
  if (!used.length) lines.push('本次运行还没有辅助调用记录（环形缓冲，重载后从零累计）。');
  return lines.join('\n');
}

/** 降级告警只输出一行，但必须在最顶上。 */
function auxWarning(h) {
  if (!h?.degraded) return null;
  const bad = h.labels
    .filter((g) => g.calls && g.successRate != null && g.successRate < h.threshold)
    .map((g) => g.name);
  return (
    `⚠️ 辅助判断层降级中：成功率 ${percent(h.successRate)}（${h.failed}/${h.calls} 次失败，阈值 ${percent(h.threshold)}）` +
    (bad.length
      ? ` —— ${bad.join('、')}正在走 fallback`
      : ' —— 以下功能在走 fallback')
  );
}

function configText(r) {
  const c = r.config;
  return [
    '【运行配置】',
    `群聊：${c.group} · 私聊：${c.private ? '开' : '关'} · 清醒窗口 ${duration(c.awakeMs)}`,
    `模型：${r.agent.model} · 心跳：${c.heartbeatModel} · 记忆：${c.memoryModel}`,
    `窗口上限：他人 ${c.others} / 自己 ${c.own} · Session 每 ${c.rotateEveryTurns} 次提交轮换`,
    `静态块：${c.staticOnce ? '每窗口一次' : '每轮'} · 时间线：${c.windowOnce ? '首轮完整，后续增量' : '每轮完整'} · 记忆：${c.memoryOnChange ? '变化时注入' : '每轮注入'} · 记忆预算 ${c.memoryInjectMaxChars ?? '不限'} 字符`,
    `读图：${c.images} · 戳一戳：${c.poke} · 自动处理申请：${c.autoRequests}`,
  ].join('\n');
}
function eventsText(r) {
  const t = r.traffic,
    i = r.interaction;
  return [
    '【事件与处理】',
    `收到上报 ${t.posts} · 进入回复流程 ${t.accepted} · 过滤 ${t.filtered}`,
    `托管关闭跳过 ${t.disabled} · 重复上报 ${t.duplicate} · 背景入缓冲 ${t.buffered} · 调试 ${t.debug}`,
    `清醒接话 ${t.awake} · 主动沉默 ${t.silence}`,
    `戳一戳：收到 ${i.pokeReceived} / 回戳 ${i.pokeReplied} / 唤醒 ${i.pokeWoke} / 限流 ${i.pokeLimited}`,
    `表情回应 ${i.reactions} · 申请 ${i.requests}`,
    ...Object.entries(r.events)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => k + '：' + n),
  ].join('\n');
}
export function renderDebugStatus(
  r,
  { section = 'status', detail = false, prefix = '#debug' } = {},
) {
  const title =
    `【QQ 桥接】${r.agentEnabled ? '托管开启' : '托管关闭'} · ${r.build}\n` +
    `统计自 ${localStamp(new Date(r.since))} · 已运行 ${duration(r.uptimeMs)}\n` +
    `OneBot：${r.connection?.text ?? '未探测（本地分项查询）'} · 最近阶段：${r.stage}`;
  const blocks = {
    heartbeat: heartbeatText(r),
    sessions: sessionsText(r, prefix),
    events: eventsText(r),
    config: configText(r),
    delivery: deliveryText(r),
    memory: memoryText(r),
    aux: auxHealthText(r.auxHealth),
  };
  const warning = auxWarning(r.auxHealth);
  if (section !== 'status')
    return (
      title + '\n\n' + blocks[section] + (section === 'heartbeat' ? '\n\n' + blocks.sessions : '')
    );
  const a = r.agent,
    turn = a.lastTurn;
  const agent = [
    '【模型回合】' + a.model,
    `无文本回合 ${a.noText} · 上游阻止 ${a.blocked} · 并入其他回合 ${a.steered} · 已通过工具发言 ${a.toolSpoke}`,
    turn
      ? `最近结束：${turn.endReason || '未知'} · 文本 ${turn.replyChars || 0} 字 · 发言工具成功 ${turn.sayOk || 0} 次` +
        (turn.ttftMs != null ? ` · 首字 ${turn.ttftMs}ms / 总 ${turn.totalMs}ms` : '')
      : '暂无回合记录。',
  ].join('\n');
  return [
    title,
    ...(warning ? [warning] : []),
    blocks.heartbeat,
    blocks.delivery,
    detail
      ? blocks.events
      : `【本次运行】上报 ${r.traffic.posts} · 回复流程 ${r.traffic.accepted} · 过滤 ${r.traffic.filtered} · 沉默 ${r.traffic.silence}`,
    sessionsText(r, prefix, detail ? 20 : 5),
    ...(detail ? [agent, blocks.memory, blocks.aux, blocks.config] : []),
    r.lastError ? '【最近错误（历史记录）】\n' + r.lastError : '最近错误：无',
    !detail
      ? `详细：${prefix} status detail\n分项：heartbeat / sessions / events / config / delivery / memory / aux`
      : '计数均从最近一次插件加载起累计。',
  ].join('\n\n');
}
