import { name } from '../metadata.mjs';
import { workspaceRoot } from '../agent/workspace.mjs';
import { heartbeatThreshold, heartbeatSchedule } from '../application/heartbeat.mjs';
import { loginSnapshot } from '../application/login-watch.mjs';
import { conversationFactsEnabled } from '../memory/facts.mjs';
import { PROMPT_REVISION } from '../prompt/protocol.mjs';
import { auxHealthSnapshot, auxDecisions } from '../agent/aux-attribution.mjs';
import { HEARTBEAT_RETRY_LADDER, MEMORY_MAX_FAILURES, MEMORY_RETRY_LADDER, ladderText } from '../agent/backoff.mjs';

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

/**
 * 主对话思考档位**实际发出去**的值。
 *
 * 配了就发；只有适配器明确不认这个档位（`reasoningNote`），或者发出去被拒过
 * 一次（`effortRejected`）时才是 "omitted"。这样 status 里的配置值和线上
 * 真实行为不会再各说一套。
 */
function mainEffortWire(config, registry) {
  const wanted = String(config.llmReasoningEffort ?? '').trim();
  if (!wanted) return 'provider-default';
  const note = registry?.effortNote;
  const rejected = registry?.effortRejected;
  if ((note && note.effort === wanted) || (rejected && rejected.effort === wanted)) {
    return 'omitted（provider 不认这个档位）';
  }
  return wanted;
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
      delegation: state.subagentResults?.snapshot() ?? { available: false },
      interjection: { mode: 'semantic-owned-amendment-next-step-inject', accepted: stats.humanInterjections ?? 0,
        routing: 'semantic-with-task-context', buffering: 'author-batches', fallback: 'normal-turn-without-steering',
        /**
         * 强制注入（`inTurnInjectionMode: all`）：有在跑的回合就把这一批 QQ 消息
         * 直接写进那一轮的 next-step，不调路由模型、不新建任务。
         * `skipped` = 本来会注入、但因为取消／进度问句改走原通路的条数；
         * `routeCallsSaved` = 因此省掉的语义路由调用次数（与 injected 同源）。
         */
        inTurn: { mode: config.inTurnInjectionMode ?? 'amend', injected: stats.interjected ?? 0,
          injectionFailed: stats.forcedInjectionFailed ?? 0, skipped: stats.inTurnInjectionSkipped ?? 0,
          routeCallsSaved: stats.interjected ?? 0,
          note: 'all = 只要有在跑的回合就注入；取消与进度问句仍走原通路' },
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
      recoveryLane: { active: state.replyRecoveryActive?.size ?? 0, maxConcurrent: config.replyRecoveryConcurrency ?? 2 } },
    imagePolicy: {
      imageReading: { tool: 'qq_read_image', mode: 'lazy', imagesPerCall: 1, maxImageBytes: 4194304 },
      enabled: config.imagesEnabled, mode: config.imageMode,
      currentImages: 'ordinary-or-with-text',
      readImagesInPrivate: config.readImagesInPrivate,
      attachQuotedImages: config.attachQuotedImages,
      contextImagesOnRequest: config.contextImagesOnRequest,
      lastImages: stats.lastImages ?? null,
    },
    forwardPolicy: {
      imageReading: { tool: 'qq_read_forward', mode: 'lazy', imagesPerCall: 1, maxImageBytes: 4194304 },
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
        sessionReasoningEffort: config.llmReasoningEffort || null,
        /**
         * 主对话档位**实际发出去的值**（见 `lib/agent/reasoning-effort.mjs`）：
         * 配了就发（`off` 也发，那是适配器的"真关思考"值）；只有问过适配器、
         * 确认它不认这个档位时才不发，并把理由放在 `reasoningNote`。
         */
        reasoningEffortWire: mainEffortWire(config, registry),
        reasoningNote: registry.effortNote ?? null,
        reasoningRejected: registry.effortRejected ?? null },
      aux: { provider: config.auxProvider || config.llmProvider || null,
        model: config.auxModel || config.llmModel || null,
        reasoningEffort: config.auxReasoningEffort || null,
        /**
         * `'off'` 到底发不发，**取决于 provider**（见 `aux-model.mjs`）：
         *   · a6api 的 Responses 路由拒绝任何显式档位（'off' 与默认 'max' 都报
         *     `UNSUPPORTED_REASONING_EFFORT`，表现为 0ms 零正文的错误结束帧）→ 只能不发；
         *   · deepseek-official 认 'off'，必须显式发，否则落到默认档（实测 high）继续思考。
         * 这里把"配置值"和"实际发出去的值"分开显示，免得再被误读。
         */
        reasoningEffortWire:
          config.auxReasoningEffort === 'off' &&
          /^a6api\b/i.test(String(config.auxProvider || config.llmProvider || ''))
            ? 'omitted（该 provider 拒收显式档位）'
            : (config.auxReasoningEffort || 'provider-default'),
        note: '语义路由／心跳／记忆提炼／发言复核／记忆合并' },
      heartbeatOverride: { provider: config.heartbeatProvider || null, model: config.heartbeatModel || null },
      memoryOverride: { provider: config.memoryProvider || null, model: config.memoryModel || null },
    },
    /**
     * 辅助判断层健康度（C）。
     *
     * 为什么放在 status 顶层：整条辅助层失效时，表现是"她变笨了/变安静了"，
     * 而各个调用点自己只留下失败的计数，没有成功率也没有空输出占比 ——
     * 于是"模型什么都没返回"和"模型答错"在读数上分不开。
     * 数据只来自内存环形缓冲，不新增任何写库。
     */
    auxHealth: auxHealthSnapshot(),
    /**
     * 判断流：最近这些辅助判断**具体判了什么、为什么**（新的在前）。
     *
     * 和 auxHealth 的分工：`auxHealth` 回答"这条链路健不健康"（成功率、空输出次数），
     * 这里回答"她刚才为什么对那句话不吭声"。健康度只能证明调用成功，
     * 成功的一次 `{"reply":false,"reason":"群友之间闲聊"}` 在健康度里是完全隐形的 ——
     * 而这恰恰是"她为什么不说话"最常见、也最难自查的答案。
     *
     * 只读内存环形缓冲，不新增写库；随重载清零。
     */
    auxDecisions: auxDecisions({ limit: 80 }),
    /**
     * 记事本链路读数。
     *
     * 关掉 aux 提炼后，记忆只有一个来源（agent 自己写）+ 一个补充（轮换前收尾）。
     * 这两条都必须可见，否则"她记不住事"只能靠猜：是没写、写失败、还是压根没到轮换点。
     */
    /**
     * 自传层：关于"我是谁"的可重建事实。
     *
     * 与 memory 分开报：它回答的是"她在哪些群"这类**账号事实**，
     * 而不是"她记住了什么"。排查"她怎么不认识自己的群"时先看这里。
     */
    self: state.self?.snapshot?.() ?? { available: false, reason: 'selfEnabled=false 或持久化不可用' },
    memory: {
      autoExtract: config.memoryAutoExtract !== false,
      bookBudgets: { groupNotes: config.groupNotesMaxChars, selfNotes: config.selfNotesMaxChars,
        personality: config.memoryInjectMaxChars },
      flush: { enabled: config.memoryFlushEnabled !== false, timeoutMs: config.memoryFlushTimeoutMs,
        runs: stats.memoryFlushRuns ?? 0, failed: stats.memoryFlushFailed ?? 0,
        notes: stats.memoryFlushNotes ?? 0, noteErrors: stats.memoryFlushNoteErrors ?? 0,
        last: stats.lastMemoryFlush ?? null },
      /**
       * 日结：每个会话每天写一条日记（`diary.<会话>.<日期>`）。
       *
       * 单独报的原因和 flush 一样：**"她没写日记"有四种完全不同的原因** ——
       * 关着、没到晚上的钟、今天那个会话太安静、模型失败。混在别的计数里就只能猜。
       */
      diary: { enabled: config.diaryEnabled !== false, lookbackDays: config.diaryLookbackDays,
        eveningHour: config.diaryEveningHour, maxChars: config.diaryMaxChars,
        catchup: config.diaryCatchupConversations,
        runs: stats.diaryRuns ?? 0, written: stats.diaryWrites ?? 0,
        failures: stats.diaryFailures ?? 0, last: stats.lastDiary ?? null },
      /**
       * 开机对账：离线期的群消息从 OneBot 回读进 `events`。
       *
       * `inserted` 一直为 0 有两种正常解释：一直在线（本来就不缺），
       * 或者 OneBot 侧的历史也被清掉了。`groups` 与 `last` 能区分。
       */
      reconcile: { enabled: config.reconcileEnabled !== false,
        maxGroups: config.reconcileMaxGroups, intervalMs: config.reconcileIntervalMs,
        runs: stats.reconcileRuns ?? 0, inserted: stats.reconcileInserted ?? 0,
        failures: stats.reconcileFailures ?? 0, last: stats.lastReconcile ?? null,
        note: '只补群；私聊没有历史接口，离线段空着' },
      /**
       * 周反思：回看一周、写回 `me.reflect.<周>`、改写 `me.*`。
       *
       * 一周边界（周日 22 点）+ 至少两天日记，所以"这周没反思"未必是坏了：
       * 看看 `last.week` 与 `weekDue` 就知道是没到点还是跑过。
       */
      introspect: { enabled: config.introspectEnabled !== false, hour: config.introspectHour,
        minDiaries: config.introspectMinDiaries, backfillWeeks: config.introspectBackfillWeeks,
        runs: stats.introspectRuns ?? 0, written: stats.introspectWrites ?? 0,
        revisions: stats.introspectRevisions ?? 0, failures: stats.introspectFailures ?? 0,
        last: stats.lastIntrospect ?? null,
        note: '写 me.reflect.<周> 并直接注入；revised 会改写 me.*，标（改过）' },
      /**
       * 主动层（宿主）：没人问她的时候她自己决定要不要开口。
       *
       * `spoken` 是"她真的发出去了几条"，`declined` 是"看了但决定不说"——
       * 后者大于前者才是常态，也是它健康的样子；两个都是 0 说明钟没转。
       * `shared` 是已经分享过的视频数（不会重复分享同一个）。
       */
      proactive: { enabled: config.proactiveEnabled !== false,
        intervalMs: config.proactiveIntervalMs, jitterPct: config.proactiveJitterPct,
        quietHours: config.proactiveQuietHours, dailyMax: config.proactiveDailyMax,
        bili: config.proactiveBiliEnabled !== false,
        ticks: stats.proactiveTicks ?? 0, spoken: stats.proactiveSpoke ?? 0,
        declined: stats.proactiveDeclined ?? 0, failures: stats.proactiveFailures ?? 0,
        shared: Array.isArray(state.proactive?.runtime?.shared) ? state.proactive.runtime.shared.length : 0,
        nextAt: state.proactive?.runtime?.nextAt ?? 0, last: stats.lastProactive ?? null,
        note: '想说话的目标由账本挑：安静 ≥ quietHours、今天还没主动过、回应率不为 0' },
      /**
       * L4 反思：只落盘、不注入。这里必须能看到 —— "规律段一直是空的"可能是
       * 没到 8 条事实、没到 24 小时、模型失败，三种原因排查动作完全不同。
       */
      reflect: { enabled: config.memoryReflectEnabled !== false,
        intervalMs: config.memoryReflectIntervalMs, minFacts: config.memoryReflectMinFacts,
        runs: stats.memoryReflectRuns ?? 0, failed: stats.memoryReflectFailed ?? 0,
        rules: stats.memoryReflectRules ?? 0, last: stats.lastMemoryReflect ?? null,
        note: '只写 memory/<qq>.md 的 ## 规律 段，不进提示词' },
    },
    /** 失败退避的配置事实：心跳与记忆提炼各自按会话退避。 */
    auxBackoff: {
      heartbeat: { ladder: ladderText(HEARTBEAT_RETRY_LADDER),
        note: '一次失败不再锁 heartbeatMs(10 分钟)；未读一条不丢，只推迟' },
      memory: { ladder: ladderText(MEMORY_RETRY_LADDER), maxFailures: MEMORY_MAX_FAILURES,
        note: '单批连续失败到上限就丢弃该批，避免无限重试' },
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
      /** 窗口的总轮数上限：即使条数没到，超过这么多轮的旧消息也会被裁掉。 */
      windowTurns: config.windowTurns ?? 10,
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
      /** 影子读数：若"生成与合并窗口并行"能省多少、会不会要扣着不发。只记录，不改变行为。 */
      inputOverlap: state.inputBatches?.shadow?.() ?? null,
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
        /** 另外两条"不问模型直接回"的护栏，分开报才看得清哪一条在生效。 */
        longAsk: stats.replyDecisionLongAsk ?? 0,
        explicitAsk: stats.replyDecisionExplicitAsk ?? 0,
        failed: stats.replyDecisionFailed ?? 0,
        /** 失败不只是计数：带上 empty-output / timeout / invalid-json 这类原因。 */
        lastFailure: stats.lastReplyDecisionFailure ?? null,
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
    /**
     * 后台恢复循环还活着吗。
     *
     * 这是"群里安静但一切都显示正常"时第一个该看的地方：恢复循环一旦暂停，
     * planned 行就再没有人去发，outbox、队列、登录数全是健康的。
     */
    回复恢复: stats.recovery?.['投递恢复'] ?? { paused: false, since: 0, resumed: 0 },
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
            /**
             * `inFlightMs` 一直涨 = **有一批发送卡在半路**（不是空闲）。
             * 卡住的批次已经不在 `queues` 里，只看 `items`/`batches` 会误判成"队列是空的"。
             */
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
     * 戳一戳的几个计数，直接摆在自检里。
     *
     * 之前它们只在 `#debug status` 里渲染，于是"开关关着"和
     * "事件没上报"在自检接口上表现一样（都是什么都没有）——
     * 排查时只能去翻接入端日志。各数的含义：
     *   收到 = 上游确实推过来了（0 说明应先排查接入端）
     *   回戳 = 真的回应了
     *   唤醒 = wake 模式开了清醒窗口 / agent 模式提交了一轮推理
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
