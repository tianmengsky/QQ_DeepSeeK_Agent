import { name } from '../metadata.mjs';
import { workspaceRoot } from '../agent/workspace.mjs';
import { heartbeatThreshold, heartbeatSchedule } from '../application/heartbeat.mjs';
import { loginSnapshot } from '../application/login-watch.mjs';
import { conversationFactsEnabled } from '../memory/facts.mjs';
import { PROMPT_REVISION } from '../prompt/protocol.mjs';

function quotaSnapshot(store, key, windowMs, limit) {
  const now = Date.now(), used = store.usageOf('send:' + key, windowMs, { now });
  return { limit, used, remaining: limit > 0 ? Math.max(0, limit - used) : null,
    resetAt: Math.floor(now / windowMs) * windowMs + windowMs, blocked: limit > 0 && used >= limit };
}

export function heartbeatSnapshot(config, registry, state, stats, now = Date.now()) {
  for (const key of registry.byKey.keys()) registry.entry(key);
  const threshold = heartbeatThreshold(config);
  const enabled = Boolean(
    config.heartbeatEnabled && config.groupEnabled && state.enabled && !state.disposed,
  );
  return {
    enabled: config.heartbeatEnabled,
    active: enabled,
    unreadThreshold: threshold,
    cooldownMs: config.heartbeatCooldownMs,
    recoveryMs: config.heartbeatMs,
    triggerPolicy: 'unread-or-elapsed',
    lastDecision: stats.lastHeartbeatDecision ?? null,
    groups: [...registry.byKey.entries()]
      .filter(([key]) => key.startsWith('group:'))
      .map(([key, entry]) => {
        const unread = entry.pending.length;
        const schedule = heartbeatSchedule(config, entry, now);
        const cooldownRemainingMs = Number.isFinite(schedule.timeDueAt)
          ? Math.max(0, schedule.timeDueAt - now) : 0;
        const retryRemainingMs = Math.max(0, (entry.heartbeatRetryAt || 0) - now);
        const checking = Boolean(entry.heartbeatTask);
        const phase = !enabled
          ? 'disabled'
          : checking
            ? 'checking'
            : !unread
              ? 'collecting'
              : retryRemainingMs > 0
                ? 'retry'
                : schedule.dueAt <= now
                  ? 'ready'
                : cooldownRemainingMs > 0
                  ? 'cooldown'
                  : 'collecting';
        return {
          conversation: key,
          unread,
          checking,
          waiting: Boolean(entry.heartbeatTimer),
          phase,
          cooldownRemainingMs,
          retryRemainingMs,
          trigger: schedule.trigger,
          waitRemainingMs: Number.isFinite(schedule.dueAt) ? Math.max(0, schedule.dueAt - now) : 0,
        };
      }),
  };
}

export function statusSnapshot(
  config,
  registry,
  state,
  stats,
  store,
  sendQueue = null,
  { loginWatch = null } = {},
) {
  return {
    ok: true,
    plugin: name,
    build: stats.build,
    promptPolicy: { revision: PROMPT_REVISION, style: 'positive-tulpa-persona-and-interaction-checklist',
      stable: 'persona-behavior-tool-protocol', interaction: 'address-choice-wait-silence-pacing-stickers-context', examples: 'scene-max-two-on-change',
      dynamic: 'current-source-related-memory-tasks-timeline', sourceChange: 'new-session-on-next-turn' },
    workspace: { root: workspaceRoot(config), isolation: 'conversation', maxFileBytes: 20971520,
      progressPolicy: 'source-and-conversation-workspace',
      executionAuthority: 'session-source-and-conversation',
      hostGuardActive: Boolean(stats.executionToolGuardActive),
      tools: ['qq_workspace', 'qq_send_file'] },
    agentEnabled: state.enabled,
    tasks: { ...(state.taskLedger?.snapshot(state.replyJournal) ?? { available: false }),
      executionPolicy: state.taskScheduler?.mode === 'enabled' ? 'conversation-dialogue-and-background-workers' : 'conversation-serial',
      sessionMode: config.dialogueSessionMode ?? 'conversation',
      delegation: state.delegatedWork?.snapshot() ?? { available: false },
      interjection: { mode: 'semantic-owned-amendment-next-step-inject', accepted: stats.humanInterjections ?? 0,
        routing: 'semantic-with-task-context', buffering: 'author-batches', fallback: 'normal-turn-without-steering',
        /**
         * amend（执行中改需求）的四段计数，用来验证这条路径真的活着。
         *
         * amend 此前线上**一次都没产出过**（0/504）——根因是路由被主模型的思考拖到
         * 4 秒超时，与 amend 的判定规则无关。换掉辅助模型后直连实测 7/7 标签正确
         * （含 4 例 amend）。routed = 裁决为 amend；injected = 注入正在跑的那一轮成功；
         * queued = 落到持久化修订（新建执行、supersede 旧排队执行）；
         * injectionFailed = 已认领但注入未确认，需人工核对。
         */
        amend: { routed: stats.amendRouted ?? 0, injected: stats.amendInjected ?? 0,
          queued: stats.amendQueued ?? 0, injectionFailed: stats.amendInjectionFailed ?? 0 } },
      topicRouting: state.taskScheduler?.mode ?? 'off',
      /** 路由调用去向：local = 没调模型（门控或本就无任务），model = 真发了请求。 */
      routingCalls: { local: stats.routeLocal ?? 0, model: stats.routeModel ?? 0,
        note: 'local 越多越好；model 那一档实测 deepseek-v4-flash 首字 2125ms' },
      progressLane: state.taskProgress?.snapshot() ?? { enabled: false },
      recoveryLane: { active: state.replyRecoveryActive?.size ?? 0, maxConcurrent: config.replyRecoveryConcurrency ?? 2 } },
    imagePolicy: {
      enabled: config.imagesEnabled, mode: config.imageMode,
      currentImages: 'ordinary-or-with-text',
      readImagesInPrivate: config.readImagesInPrivate,
      attachQuotedImages: config.attachQuotedImages,
      contextImagesOnRequest: config.contextImagesOnRequest,
      lastImages: stats.lastImages ?? null,
    },
    forwardPolicy: {
      mode: config.forwardMode,
      attachQuotedForwards: config.attachQuotedForwards,
      contextForwardsOnRequest: config.contextForwardsOnRequest,
      maxMessages: config.forwardMaxMessages,
      maxChars: config.forwardMaxChars,
      timeoutMs: config.forwardTimeoutMs,
      lastForward: stats.lastForward ?? null,
    },
    conversations: registry.byKey.size,
    memoryPolicy: { owner: 'chat-agent', tool: 'qq_memory',
      available: Boolean(state.memoryToolAvailable),
      backgroundSupplement: Boolean(config.memoryEnabled && config.memoryAutoExtract),
      kinds: ['explicit', 'profile', 'impression'], writeConfirmation: 'committed-receipt',
      versions: true, explicitFirst: true,
      /** 会话「长期约定」面：关掉时既不注入也不提炼，存档只读保留。 */
      conversationFacts: { injected: conversationFactsEnabled(config),
        extracted: conversationFactsEnabled(config),
        maxChars: config.conversationMemoryMaxChars ?? 450,
        archive: 'kept' }, },
    /**
     * 各路调用实际会用哪个模型 —— 以前只有 llmProvider/llmModel 生效，
     * 辅助判断调用沿用什么完全不可见，导致"路由为什么慢/为什么超时"没法从
     * status 判断。这里把解析结果直接列出来（与 auxSelection 同一套优先级）。
     */
    models: {
      main: { provider: config.llmProvider || null, model: config.llmModel || null,
        sessionReasoningEffort: config.llmReasoningEffort || null },
      aux: { provider: config.auxProvider || config.llmProvider || null,
        model: config.auxModel || config.llmModel || null,
        reasoningEffort: config.auxReasoningEffort || null,
        note: '语义路由／心跳／记忆提炼／发言复核／进度旁路／记忆合并' },
      heartbeatOverride: { provider: config.heartbeatProvider || null, model: config.heartbeatModel || null },
      memoryOverride: { provider: config.memoryProvider || null, model: config.memoryModel || null },
    },
    contextPolicy: {
      rotateEveryTurns: config.rotateEveryTurns,
      rotationMode: config.rotateEveryTurns > 0 ? 'turn-limit' : 'prompt-budget',
      turnCountBasis: 'successful-main-session-prompt-submissions',
      oldSessionPolicy: 'no-new-turns-after-rotation',
      conversationContextMaxChars: config.conversationContextMaxChars ?? 60000,
      taskContextMaxChars: config.taskContextMaxChars ?? 120000,
      budgetBasis: 'submitted-prompt-chars-not-model-context-tokens',
      memoryInjectOnChange: config.memoryInjectOnChange,
      memoryInjectMaxChars: config.memoryInjectMaxChars,
      stickerCatalogLimit: config.stickerCatalogLimit,
      others: config.contextOthersMessages, own: config.contextOwnMessages,
      windowOnce: Boolean(config.injectWindowOnce),
      taskContext: 'current-task-and-related-facts-max-three',
      lastPrompt: stats.lastPrompt ?? null,
    },
    episodicMemory: {
      enabled: Boolean(config.memoryEnabled && config.episodicMemoryEnabled),
      ...(state.episodes?.snapshot() ?? { available: false }),
      injectLimit: config.episodeInjectLimit,
      injectMaxChars: config.episodeInjectMaxChars,
      extraModelCalls: 0,
    },
    /**
     * 登录监视读数：在线状态 + 每次掉线的起止时间与原因。
     *
     * 掉线在别的地方都表现为"消息突然不来了"，和"插件坏了"长得一模一样；
     * 把这一块摆出来，才能一眼分清是 QQ 被踢了还是桥接出问题。
     */
    登录: loginSnapshot(loginWatch ?? state.loginWatch ?? null),
    replyPolicy: {
      replyShapes: config.replyShapes,
      shapeLottery: Boolean(config.replyShapes?.length),
      maxBubbles: config.maxBubbles,
      stickerMinGapTurns: config.stickerMinGapTurns,
      ordinaryChat: 'final-reply',
      textSelection: 'post-tool-final',
      /** 她自己在正文里写 [@:QQ号] 才会 @ 人；这两个值用来核对开关是否在线生效。 */
      atMentionEnabled: config.atMentionEnabled,
      atMentionMax: config.atMentionMax,
      /** 明确发送失败的放弃上限；0 = 无限重试（旧行为）。 */
      replyMaxSendAttempts: config.replyMaxSendAttempts,
      sendQuotaPerMinute: config.sendQuotaPerMinute,
      sendQuotaPerHour: config.sendQuotaPerHour,
      sendQuotas: store?.available ? [...registry.byKey.keys()].map((key) => ({ conversation: key,
        minute: quotaSnapshot(store, key, 60000, config.sendQuotaPerMinute),
        hour: quotaSnapshot(store, key, 3600000, config.sendQuotaPerHour),
      })) : [],
      awakeMs: config.awakeMs,
      groupAttentionEnabled: config.groupAttentionEnabled,
      attentionMode: 'agent-decides',
      inputDebounceMs: config.inputDebounceMs ?? 1500,
      inputShortDebounceMs: config.inputShortDebounceMs ?? 3500,
      inputMaxWaitMs: config.inputMaxWaitMs ?? 8000,
      inputBatchMaxMessages: config.inputBatchMaxMessages ?? 24,
      floorManagementEnabled: config.floorManagementEnabled !== false,
      floorWaitMs: config.floorWaitMs ?? 30000,
      floorMode: 'request-batches-and-reply-value-recheck',
      lastFloorDecision: stats.lastFloorDecision ?? null,
      inputBatches: state.inputBatches?.snapshot() ?? [],
      /**
       * 参与决策：起完整回合**之前**先判断"此刻该不该回一句"。
       * `silent / checks` 就是"选择不回"的比例 —— 这是"像真人那样不必每条都回"的直接指标。
       * `requestShaped` 是被硬护栏直接放行的请求型措辞（防止判成沉默导致"装死"）。
       */
      participation: {
        enabled: config.replyDecisionEnabled === true,
        timeoutMs: config.replyDecisionTimeoutMs ?? 5000,
        checks: stats.replyDecisionChecks ?? 0,
        silent: stats.replyDecisionSilent ?? 0,
        requestShaped: stats.replyDecisionRequestShaped ?? 0,
        failed: stats.replyDecisionFailed ?? 0,
        attentionDeclined: stats.attentionDeclined ?? 0,
        last: stats.lastReplyDecision ?? null,
        note: 'silent/checks = 选择不回的比例；failed = 判断失败后 fail-open 的次数',
      },
      attentionInterjectCooldownMs: config.attentionInterjectCooldownMs,
      lastAttentionDecision: stats.lastAttentionDecision ??
        [...registry.byKey.values()].map((e) => e.lastAttentionDecision).filter(Boolean)
          .sort((a, b) => b.at - a.at)[0] ?? null,
    },
    stats,
    voicePolicy: { enabled: config.voiceTranscriptionEnabled !== false,
      transcribed: stats.voiceTranscribed ?? 0, failed: stats.voiceTranscriptionFailed ?? 0 },
    replyDelivery: state.replyJournal?.snapshot() ?? { available: false },
    taskScheduler: state.taskScheduler?.snapshot() ?? { enabled: false },
    heartbeat: heartbeatSnapshot(config, registry, state, stats),
    /**
     * 出站队列的积压情况。
     *
     * 这是"发送跟不上"的直接读数：`batches` 一直不降 = 队列在排长队，
     * 而回合**不等**它（回合早已结束），所以这里涨起来不再会堵住推理。
     */
    出站队列:
      (sendQueue ?? state.sendQueue)
        ? {
            ...(sendQueue ?? state.sendQueue).stats(),
            同会话最小间隔ms: config.sendMinIntervalMs,
            说明: '排队中：回合已结束，气泡在按打字节奏发出',
          }
        : null,
    groupTrigger: config.groupTrigger,
    groupEnabled: config.groupEnabled,
    privateEnabled: config.privateEnabled,
    /**
     * 按事件类型分了多少条。
     *
     * 自检时最常问的两个问题："消息到底到没到？""是不是被开关吃了？"
     * 这里一眼能分开：类型没出现 = 上游没上报；
     * 类型有计数但没动作 = 被自己的开关/白名单拦了。
     */
    事件分类: stats.eventKinds ?? {},
    /**
     * 戳一戳的四个计数，直接摆在自检里。
     *
     * 之前它们只在 `#debug status` 里渲染，于是"开关关着"和
     * "事件没上报"在自检接口上表现一样（都是什么都没有）——
     * 排查时只能去翻接入端日志。四个数的含义：
     *   收到 = 上游确实推过来了（0 说明应先排查接入端）
     *   回戳 = 真的回应了
     *   限流 = 被最小间隔或每人上限挡了
     *   跳过 = 被群白名单挡了
     */
    戳: {
      开关: config.pokeReplyEnabled,
      模式: config.pokeReplyMode,
      收到: stats.pokeReceived ?? 0,
      唤醒: stats.pokeWoke ?? 0,
      回戳: stats.pokeReplied ?? 0,
      文字: stats.pokeTextSent ?? 0,
      文字被抑: stats.pokeTextSuppressed ?? 0,
      限流: stats.pokeThrottled ?? 0,
      跳过: stats.pokeSkipped ?? 0,
    },
    /**
     * 可靠性状态。把"结果未知的发送"和"信息缺口"直接摆在自检接口上 ——
     * 不摆出来的话，它们就是静默丢失，没人会想起去数据库里翻。
     */
    reliability: store?.available
      ? {
          持久化: store.path,
          发送回执: store.countByStatus(),
          待核对: store.listUnknown(null, 10).map((r) => ({
            键: r.idemKey,
            会话: r.conversation,
            状态: r.status,
            目标: r.target,
            时间: new Date(r.createdAt).toISOString(),
            详情: r.detail,
          })),
        }
      : { 持久化: null, 说明: store?.degradedReason ?? '未启用' },
    // 每个会话的清醒状态，方便不开 QQ 就能确认窗口有没有生效
    awake: [...registry.byKey.entries()].map(([k, e]) => ({
      会话: k,
      清醒剩余秒: e.awakeUntil > Date.now() ? Math.ceil((e.awakeUntil - Date.now()) / 1000) : 0,
      本轮轮数: e.turns,
      Session: e.sessionId ?? null,
      上下文累计轮数: e.contextTurn ?? 0,
      窗口条数: e.window.length,
      距上次表情: e.turnsSinceSticker,
      心跳缓冲条数: e.pending.length,
      心跳缓冲: e.pending.slice(-5).map((m) => `${m.who}: ${m.text.slice(0, 40)}`),
      距最后消息秒: e.lastMessageAt ? Math.round((Date.now() - e.lastMessageAt) / 1000) : null,
      距上次说话秒: e.lastSpokeAt ? Math.round((Date.now() - e.lastSpokeAt) / 1000) : null,
    })),
  };
}
