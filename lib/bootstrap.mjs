import path from 'node:path';
import { workspaceRoot, WORKSPACE_STATE_KEY } from './agent/workspace.mjs';
import { voiceLibraryRoot, VOICE_LIBRARY_STATE_KEY } from './agent/voice-library.mjs';
import { EpisodeLedger } from './memory/episodes.mjs';
import { assertConfig } from './config.mjs';
import { loadStoreModule } from './transport/persistence.mjs';
import { ConversationRegistry } from './conversation/registry.mjs';
import { MemoryStore, resolveMemoryDir } from './memory/memory-store.mjs';
import { MemoryExtractor } from './memory/extractor.mjs';
import { MemoryReflector } from './memory/reflect.mjs';
import { createHandler } from './routes/onebot.mjs';
import { runHeartbeat, heartbeatThreshold, pokeHeartbeat, requestHeartbeat } from './application/heartbeat.mjs';
import { LoginWatch } from './application/login-watch.mjs';
import { createControlHandler } from './routes/control.mjs';
import { createPanelHandler } from './routes/panel.mjs';
import { createAdmin, createAdminHandler } from './routes/admin.mjs';
import { trackLastError } from './application/stats-errors.mjs';
import { ConversationSendQueue } from './delivery/send-queue.mjs';
import { isSessionArchived, sessionSignature } from './conversation/sessions.mjs';
import { isAllowed } from './domain/admission.mjs';
import { replyJournal } from './delivery/reply-journal.mjs';
import { recoverReplies } from './application/reply-recovery.mjs';
import { executionToolGuard, CROSS_CONVERSATION_STATE_KEY } from './agent/execution-scope.mjs';
import { bindToolSource } from './agent/tool-binding.mjs';
import { memoryTool } from './memory/tool.mjs';
import { TaskRouting } from './conversation/task-routing.mjs';
import { SubagentResults } from './application/subagent-results.mjs';
import { installTurnScopeHooks } from './application/turn-scope.mjs';
import { createRecoveryGuard } from './application/recovery-guard.mjs';
import { SelfLedger } from './application/self.mjs';

function apply(ctx, config) {
  assertConfig(config);
  const { Store } = loadStoreModule();

  /**
   * 持久化层。stateDir 留空就用 cwd 下的 data/ ——
   * 和 profile 里配的 cwd 保持一致，不凭空往别处写东西。
   */
  let store = null;
  /**
   * 数据目录：stateDir 留空就用 cwd 下的 data/。
   *
   * 抽出来是因为登录告警也要写在这儿 —— 两处各算一次的话，
   * 迟早会出现"库在 A、告警在 B"这种找不到文件的情况。
   */
  const dataDir = config.stateDir?.trim()
    ? config.stateDir.trim()
    : path.join(config.cwd?.trim() || process.cwd(), 'data');
  if (config.persistenceEnabled) {
    store = new Store(path.join(dataDir, 'qq-bridge.sqlite3'), { logger: ctx.logger });
    if (store.available) {
      ctx.logger.info(`qq-bridge: 持久化已启用 —— ${store.path}`);
    } else {
      ctx.logger.warn(
        `qq-bridge: 持久化不可用（${store.degradedReason}），退回保守模式：` +
          '发送结果一律按未知处理，不会自动重发',
      );
    }
  }

  const registry = new ConversationRegistry(ctx, config, store);
  let tools;
  try { tools = ctx.get?.('tools') ?? ctx.tools; } catch { tools = undefined; }
  /**
   * 正在做上下文收尾的 Session。
   *
   * 必须在注册守卫之前创建，并让 state 引用同一个 Set：守卫注册在 state
   * 构造之前，两边各建一个的话永远对不上，"收尾时禁发消息"就会静默失效。
   */
  const memoryFlushSessions = new Set();
  if (tools?.guard && store?.available)
    tools.guard((exec) => executionToolGuard(store, config, exec, { memoryFlushSessions }));
  // 来源归属由宿主按 Session 注入：模型既看不到也不需要填写 source_ref。
  // pre-execute 是宿主公开的 waterfall，跑在 guard 与派发之前，替换后的参数
  // 就是 guard 与 qq-mcp 实际收到的参数。
  if (store?.available)
    ctx.on('tools/pre-execute', async (exec, next) => {
      bindToolSource(store, exec);
      return next();
    }, { global: true });
  /**
   * 归属的收尾权交给"回合真的结束"，而不是"桥接不再等待"。
   * 详见 `lib/application/turn-scope.mjs` 里那段事故复盘 —— 这是
   * "agent 想久了就调不动工具"的修法。
   */
  installTurnScopeHooks(ctx, { store, config, logger: ctx.logger });
  store?.setState?.(WORKSPACE_STATE_KEY, workspaceRoot(config));
  // 语音库根目录同理：qq-mcp 是独立进程，配置传不过去，按需读共享库里的值。
  store?.setState?.(VOICE_LIBRARY_STATE_KEY, voiceLibraryRoot(config));
  // 发送工具在另一个进程，配置对象传不过去：把跨会话开关写进共享库，
  // 由 MCP 侧按需读取（改配置后下一次工具调用即生效，无需重启 MCP）。
  store?.setState?.(CROSS_CONVERSATION_STATE_KEY, config.allowCrossConversation ? 'true' : 'false');

  /**
   * 出站发送队列（**插件级，跨会话共用**）。
   *
   * 为什么必须在这里建、而不是每次投递建一个：
   *   它要记住"每条会话上一次发出去是什么时候"，才能给同一会话保序、
   *   给不同会话轮转 —— 否则"发送"照样会退化成回合里的同步等待，
   *   高并发下又把下一个回合堵住（这正是原来"回复被吞"的一半原因）。
   *
   * minIntervalMs：同一条会话两次发送之间的最小间隔。
   *   默认 0 —— 气泡节奏（bubbleDelayPerCharMs）已经负责"像人打字"，
   *   再叠一道全局间隔只会让每条回复都慢半拍。
   */
  const sendQueue = new ConversationSendQueue({
    minIntervalMs: config.sendMinIntervalMs,
    logger: ctx.logger,
  });

  /**
   * 托管开关：**优先用上次运行时存下来的值**，没有再退回 profile 的配置。
   *
   * 为什么必须持久化：profile 里 `agentEnabled` 是 false（保守默认），
   * 运行时用 HTTP `/qq/onebot/control` 打开只写内存。插件每次重载
   * （改代码、HMR 触发）都会重新读 profile 的 false，于是托管又关上了。
   * 表现是"群里明明很多人说话，它却完全没反应"—— 因为托管关着时，
   * 消息在 shouldCheck 之前就被丢掉了，连缓冲都不进。
   */
  const savedEnabled = store?.available ? store.getState('agentEnabled') : null;
  const initialEnabled =
    savedEnabled === null || savedEnabled === undefined
      ? config.agentEnabled
      : savedEnabled === 'true';

  const state = {
    enabled: initialEnabled,
    controller: new AbortController(),
    disposed: false,
    ownMessageConversations: new Map(),
    since: Date.now(),
    /**
     * 出站队列挂在这里，只为让自检接口（`GET /qq/onebot`）能报积压情况。
     * 它本身不参与状态判定 —— 队列慢不该被读成"托管出问题了"。
     */
    sendQueue,
    /** 上次回戳的时间，用于全局最小间隔。 */
    lastPokeAt: 0,
    /**
     * 她自己发出去的消息 ID（最近 200 条）。
     * 表情回应事件只带 message_id，靠它才分得清"给我的赞"和"别人的赞"。
     */
    ownMessageIds: new Set(),
    /** 她自己发言收到、还没消费掉的表情回应：messageId → {add,remove,at}。 */
    pendingReactions: new Map(),
    /** 戳一戳回合的幂等键序号（同毫秒多次戳不会撞键）。 */
    pokeSeq: 0,
    /** 收尾回合标记（与守卫共享同一个 Set）；见 memory/flush.mjs。 */
    memoryFlushSessions,
    /** 持久化托管开关用。control handler 会调它。 */
    persistEnabled(next) {
      if (!next) state.controller.abort();
      else if (state.controller.signal.aborted) state.controller = new AbortController();
      state.enabled = next;
      state.since = Date.now();
      store?.setState?.('agentEnabled', next ? 'true' : 'false');
      if (next) queueMicrotask(() => { restoreInputs(); recoverDelivery(); recoverSessionBindings(); recoverHeartbeat(); });
    },
  };
  if (savedEnabled !== null && savedEnabled !== undefined) {
    ctx.logger.info(
      `qq-bridge: 托管开关恢复为上次的值 = ${initialEnabled ? '开' : '关'}` +
        `（profile 默认 ${config.agentEnabled ? '开' : '关'}）`,
    );
  }
  /**
   * 记忆目录跟着数据目录走：memoryDir 留空时落在 <dataDir>/memory。
   * 和告警文件同一个理由 —— 免得"库在 A、记忆在 B"。
   */
  const memoryDir = resolveMemoryDir(config, dataDir);
  /**
   * 面板改过的配置在这里落地。
   *
   * 必须比所有服务**更早**执行：心跳、调度器这些在构造时就把 config 的
   * 一部分值抄进了自己的字段（`this.inTurnInjection = config.inTurnInjectionMode`），
   * 覆盖层晚一步 apply，面板改的值就要等下次重载才生效。
   */
  const admin = createAdmin(config, dataDir, memoryDir, Date.now, { store, registry });
  if (Object.keys(admin.settings.appliedOnLoad ?? {}).length) {
    ctx.logger.info(
      `qq-bridge: 面板覆盖了 ${Object.keys(admin.settings.appliedOnLoad).join('、')}` +
        `（来自 ${admin.settings.file}）`,
    );
  }
  if (admin.settings.lastError) ctx.logger.warn(`qq-bridge: ${admin.settings.lastError}`);
  const memory = config.memoryEnabled
    ? new MemoryStore(ctx, { ...config, memoryDir }, store)
    : null;
  if (memory) ctx.logger.info(`qq-bridge: 记忆目录 —— ${memoryDir}`);
  /**
   * 启动时重建记事本投影。
   *
   * 迁移、手工修库、或文件被删之后，投影要能自愈；否则要等到"下次有人写那个本"
   * 才会重新生成，中间那段人手看到的还是旧内容（或根本没有文件）。
   */
  if (memory) {
    try {
      const projected = memory.syncAllNotebooks();
      if (projected) ctx.logger.info(`qq-bridge: 已重建 ${projected} 个记事本投影`);
    } catch (error) {
      ctx.logger.warn(`qq-bridge: 重建记事本投影失败 —— ${error?.message ?? error}`);
    }
  }
  state.replyJournal = replyJournal(store);
  state.episodes = memory?.episodes ?? null;
  state.sourceLedger = memory?.episodes ?? new EpisodeLedger(store, ctx.logger);
  state.memoryToolAvailable = Boolean(memory?.agent?.available && tools?.register);
  if (state.memoryToolAvailable)
    tools.register(memoryTool({ memory, registry, store, config, state }));
  store?.setState?.('qq-bridge:episodic-memory', memory?.episodes?.available ? 'true' : 'false');

  /**
   * 自传层：知道"我是谁、我在哪些群"。
   *
   * 挂在 memory 上而不是单开一条注入链：它和人物/群记事一样是"关于某个主体的材料"，
   * `memoryBlocks` 已经在做去重、预算和渲染顺序，多开一条只会重复这些逻辑。
   * `state.self` 供 `#debug self` 与 `status.self` 读取。
   *
   * 首次刷新在 start() 里 queueMicrotask 触发：插件重载后不必等 45 分钟才有"我是谁"。
   */
  if (config.selfEnabled !== false && store?.available) {
    state.self = new SelfLedger({ config, store, logger: ctx.logger });
    if (memory) memory.selfLedger = state.self;
    ctx.effect(() => {
      // 不挂托管开关：自传只读账号事实，"她要不要说话"与"她在哪些群"是两件事。
      // 登录监视器同理 —— 托管关着的时候更需知道账号还在不在。
      const stop = state.self.start(state.controller.signal);
      return () => { stop(); state.self.dispose(); };
    }, 'qq-bridge: self ledger');
  }

  /**
   * 登录监视器：只读 `get_status` / `get_login_info`，把"被踢下线"变成可查的读数。
   *
   * 放在 state 上而不是闭包里，是为了让自检接口（`GET /qq/onebot`）能报出来 ——
   * 这个读数的全部价值就在于"不用去翻接入端日志"。
   *
   * 告警文件跟着数据目录走（和 sqlite 同一个地方），免得出现"库在 A、告警在 B"。
   */
  const alertFile = String(config.loginAlertFile ?? '').trim();
  const alertPath = alertFile
    ? (path.isAbsolute(alertFile) ? alertFile : path.join(dataDir, alertFile))
    : '';
  state.loginWatch = config.loginWatchEnabled
    ? new LoginWatch({ config, store, logger: ctx.logger, alertPath })
    : null;

  // 启动时恢复未处理缓冲；只有超出缓冲上限的消息才记入缺口。
  if (store?.available && config.restoreBufferOnLoad) {
    try {
      const restored = registry.restoreFromStore();
      if (restored) ctx.logger.info(`qq-bridge: 恢复了 ${restored} 个会话的缓冲`);
    } catch (error) {
      ctx.logger.warn(`qq-bridge: 恢复缓冲失败 —— ${error?.message ?? error}`);
    }
  }

  // stats 建在这里而不是 createHandler 里 —— 心跳定时器也要读它。
  const stats = {
    build: 'v109-example-trim',
    executionToolGuardActive: Boolean(tools?.guard && store?.available),
    stage: 'idle',
    /** 计数从这一刻开始。插件每次重载都会归零，不标出来会被误读成历史总数。 */
    since: Date.now(),
    posts: 0,
    filtered: 0,
    accepted: 0,
    lastEvent: null,
    lastError: null,
  };
  // 面板要回答“这条错误是什么时候的”，13 处赋值点统一由访问器补时间戳。
  trackLastError(stats);

  if (store?.available && tools?.register) {
    // Initialize the durable worker schema before the ingress scheduler mounts.
    state.taskRouting ??= new TaskRouting(store, config);
    // 委派走 DSH 原生 subagent：这里只负责把子代理的成果交回父会话。
    state.subagentResults = new SubagentResults({ ctx, config, registry, state, store, stats });
    ctx.on('session/event', (session, event) => state.subagentResults.onEvent(session, event), { global: true });
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      state.subagentResults.bind(agent); return next();
    }, { global: true });
    ctx.effect(() => {
      const timer = setInterval(() => state.subagentResults.sweep(), 15000); timer.unref?.();
      return () => { clearInterval(timer); };
    }, 'qq-bridge: subagent results');
  }

  /**
   * 插件加载时的状态重建，**只跑一次**。
   *
   * 为什么必须从下面的 5 秒节拍里拿出去：`taskScheduler.restore()` 会把
   * 「有 turn_id、有 reply 行、但无 outcome」的执行重新判成 `recovering`，
   * 而这些正是 `recoverReplies` 反复重连失败的那些 —— 每 5 秒钉回去一次，
   * 就构成永不收敛的环（线上实测卡了 4 天：13 个死任务永久 busy、
   * lastError 永远是同一条超时）。周期推进交给 `taskScheduler.tick()`。
   */
  /**
   * 库还能不能用。只在恢复被暂停之后被问到（见 recovery-guard 的 retryMs）。
   *
   * 用 `quick_check(1)` 而不是 `SELECT 1`：后者不读页，磁盘/文件真坏了也照样返回，
   * 探针就成了摆设。26MB 的库扫一遍是毫秒级，而且只在暂停期间每分钟一次。
   */
  const storeHealthy = () => {
    try {
      const row = store?.db?.prepare('PRAGMA quick_check(1)').get();
      return String(Object.values(row ?? {})[0] ?? '').toLowerCase() === 'ok';
    } catch {
      return false;
    }
  };

  const restoreState = createRecoveryGuard({ state, stats, logger: ctx.logger, label: '状态重建' }, () => {
    state.taskLedger?.reconcile(state.replyJournal);
    state.taskScheduler?.restore();
  });
  const restoreInputs = createRecoveryGuard({ state, stats, logger: ctx.logger, label: '缓冲恢复' }, () => {
    state.inputBatches?.restore();
    return restoreState();
  });

  // 投递恢复带自检探针：它能自愈。停在这里的代价是"群里一条都不发"，而不是一条报错。
  const recoverDelivery = createRecoveryGuard({
    state, stats, logger: ctx.logger, label: '投递恢复', probe: storeHealthy,
  }, () => {
    state.taskScheduler?.tick();
    // 恢复现在是异步的（重试带 @ 的计划前要拉一次群成员表），失败不能没人接。
    return recoverReplies(ctx, config, registry, state, memory, stats, store, sendQueue);
  });
  ctx.effect(() => {
    queueMicrotask(() => { restoreState(); recoverDelivery(); });
    const timer = setInterval(recoverDelivery, 5000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'qq-bridge: durable reply recovery');

  function recoverHeartbeat() {
    runHeartbeat(ctx, config, registry, state, memory, stats, store, { sendQueue }).catch(
      (error) => {
        if (!state.disposed) ctx.logger.warn(`qq-bridge: 心跳异常 —— ${error?.message ?? error}`);
      },
    );
  }

  function recoverSessionBindings() {
    if (!state.enabled || state.disposed) return;
    const signal = state.controller.signal;
    for (const [key, entry] of registry.byKey) {
      const needsRecovery = () => entry.sessionId && (isSessionArchived(ctx, entry.sessionId) ||
        (entry.sessionSignature && entry.sessionSignature !== sessionSignature(config)));
      if (!needsRecovery()) continue;
      const group = key.startsWith('group:');
      if (!(group ? config.groupEnabled && isAllowed(config.groups, key.slice(6))
        : config.privateEnabled && isAllowed(config.users, key.slice(5)))) continue;
      registry.run(key, async () => {
        if (signal.aborted || state.disposed || !state.enabled ||
          !needsRecovery()) return;
        const previousSessionId = entry.sessionId;
        const archived = isSessionArchived(ctx, previousSessionId);
        const sessionId = await registry.ensureSession(key);
        const metric = archived ? 'archivedSessionsRecovered' : 'sessionsReconfigured';
        stats[metric] = (stats[metric] ?? 0) + 1;
        stats.lastSessionRecovery = { conversation: key, previousSessionId, sessionId,
          reason: archived ? 'archived' : 'configuration', at: Date.now() };
      }).catch((error) => {
        if (signal.aborted || state.disposed) return;
        stats.lastError = `归档会话恢复失败: ${key}: ${error?.message ?? error}`;
        ctx.logger.warn('qq-bridge: ' + stats.lastError);
      });
    }
  }

  // Prepare replacements for stale persisted bindings without submitting a model turn.
  ctx.effect(() => { queueMicrotask(recoverSessionBindings); }, 'qq-bridge: session recovery');

  if (memory?.facts && config.memoryAutoExtract) {
    memory.extractor = new MemoryExtractor(ctx, config, memory, stats, store);
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (state.enabled && !state.disposed) memory.extractor.flush(state.controller.signal);
      }, Math.max(1000, config.memoryExtractIntervalMs));
      timer.unref?.();
      return () => { clearInterval(timer); memory.extractor.dispose(); };
    }, 'qq-bridge: memory extraction');
  }

  /**
   * L4 反思：从已有事实归纳可证伪的行为规律，写进 `memory/<qq>.md` 的 `## 规律`。
   *
   * 与提炼分开挂：它读的是 `.facts` 的存量，不依赖"这一轮有没有新消息"，
   * 也不需要写库事务。**产物不进提示词** —— 只落盘等人确认。
   *
   * 为什么要 `store.available`：反思的整个频率控制靠持久化的 lastRun，
   * 没有库就只剩内存，重载一次所有人都会被重跑一遍 —— 那等于没有频率控制。
   * 这种情况下宁可不跑（少一层归纳不影响聊天），也不要做成"重载即重刷上游"。
   */
  if (memory?.facts && config.memoryReflectEnabled !== false && store?.available) {
    memory.reflector = new MemoryReflector(ctx, config, memory, stats, store);
    ctx.effect(() => {
      const tick = () => {
        if (!state.enabled || state.disposed) return;
        memory.reflector.reflectAll({ signal: state.controller.signal }).catch((error) => {
          // 反思失败只该让状态页难看，不该让插件看起来出错。
          if (!state.disposed) ctx.logger.warn(`qq-bridge: 记忆反思异常 —— ${error?.message ?? error}`);
        });
      };
      // 首个 tick 等一个扫描周期：重载瞬间不该抢着打上游。
      const timer = setInterval(tick, Math.max(60000, Number(config.memoryReflectTickMs) || 600000));
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'qq-bridge: memory reflection');
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: config.path,
        handler: createHandler(ctx, config, registry, state, memory, stats, store, {
          sendQueue,
          loginWatch: state.loginWatch,
        }),
      }),
    `qq-bridge: ${config.path}`,
  );

  ctx.effect(() => {
    queueMicrotask(restoreInputs);
    const maintainInputs = createRecoveryGuard({ state, stats, logger: ctx.logger }, () => {
      state.taskLedger?.prune();
    });
    const timer = setInterval(maintainInputs, 30000);
    timer.unref?.();
    return () => { clearInterval(timer); state.inputBatches?.dispose(); };
  }, 'qq-bridge: input aggregation');

  ctx.effect(
    () => () => {
      state.disposed = true;
      state.enabled = false;
      state.controller.abort();
      // 停止旧实例；持久投递计划由新实例按原会话和原幂等编号接续。
      sendQueue.dispose();
    },
    'qq-bridge: cancel tasks',
  );

  // 插件重载时把数据库关掉，避免 WAL 文件句柄泄漏。
  if (store?.available) {
    ctx.effect(
      () => async () => {
        try {
          state.disposed = true;
          state.enabled = false;
          state.controller.abort();
          // Keep SQLite open until an already dispatched send has stored its receipt.
          await sendQueue.inFlight;
          await state.subagentResults?.dispose();
          // 自传刷新会写 self_* 表；不等它，关库之后那次写就会抛 database is closed。
          await state.self?.dispose();
          store.db.close();
        } catch {
          /* 关不掉就算了，进程退出时会释放 */
        }
      },
      'qq-bridge: store close',
    );
  }

  /**
   * 登录监视定时器。
   *
   * 不挂在托管开关上：**托管关着的时候 QQ 一样会掉线**，而那种情况下
   * 更需要知道"是它没上线，还是托管被人关了"。所以只要功能开着就一直探。
   *
   * 开机先立刻探一次，并且补记"上次重载时还开着的那次掉线" ——
   * 插件是在掉线期间被重载的话，那段不可用时间不能凭空消失。
   */
  if (state.loginWatch) {
    ctx.effect(() => {
      const watch = state.loginWatch;
      /**
       * 补记"上次重载时还开着的那次掉线"。
       *
       * 为什么这么绕：watch 的构造是从库里恢复历史的，但**恢复完不立刻探测** ——
       * 刚加载时到底还在不在线还不知道。所以这里等第一次探测落地，
       * 只有确实在线、并且 check() 没把它当成一次新恢复处理过，才由我们闭合，
       * 免得同一次掉线被写两遍恢复记录（去重键相同，但日志会重复）。
       */
      const reconcileCarriedOpen = (result) => {
        if (!watch.carriedOpen || watch.status !== 'online') return;
        if (result?.transition === 'recover') return;
        const carried = watch.closeIncident(watch.lastProbeAt ?? Date.now());
        watch.persist();
        if (carried) {
          ctx.logger.info(
            `qq-bridge: 上次运行结束时仍在掉线中（约 ${Math.round((carried.offlineMs || 0) / 60000)} 分钟），` +
              '已按本次探测到的在线时间闭合',
          );
          // 这段掉线发生在插件不在场的时候，日志早就滚没了 —— 落盘才能事后看到。
          watch.logRecovery(carried);
        }
      };
      const tick = () =>
        watch
          .check(state.controller.signal)
          .then(reconcileCarriedOpen)
          .catch((error) => {
            if (!state.disposed) {
              ctx.logger.warn(`qq-bridge: 登录监视异常 —— ${error?.message ?? error}`);
            }
          });
      tick();
      const id = setInterval(tick, watch.intervalMs);
      id.unref?.();
      ctx.logger.info(
        `qq-bridge: 登录监视已启动，每 ${Math.round(watch.intervalMs / 1000)}s 探测一次保持在线状态` +
          `（连续失败 ${watch.failureThreshold} 次记一次掉线）`,
      );
      return () => clearInterval(id);
    }, 'qq-bridge: login watch');
  }

  // 心跳定时器。用 setInterval 而不是 ctx.timer，少一个依赖，
  // 清理交给 ctx.effect —— 插件重载时会自动 clearInterval，不会留下野定时器。
  if (config.heartbeatEnabled) {
    ctx.effect(() => {
      // Restored unread and a reopened hosting switch must not wait for the recovery interval.
      queueMicrotask(recoverHeartbeat);
      const id = setInterval(
        recoverHeartbeat,
        Math.max(1000, config.heartbeatMs),
      );
      ctx.logger.info(
        `qq-bridge: 心跳已启动，每群未读达到 ${heartbeatThreshold(config)} 条立即判断` +
          `（或等待 ${Math.round(config.heartbeatCooldownMs / 1000)}s 到期；恢复扫描每 ${Math.round(config.heartbeatMs / 1000)}s 一次）`,
      );
      return () => clearInterval(id);
    }, 'qq-bridge: heartbeat');
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${config.path}/panel`,
        handler: createPanelHandler(config),
      }),
    `qq-bridge: ${config.path}/panel`,
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: `${config.path}/control`,
        handler: createControlHandler(ctx, config, state),
      }),
    `qq-bridge: ${config.path}/control`,
  );
  /**
   * 后台接口按"每条精确路径挂一次"注册。
   *
   * 宿主只提供 exact 匹配（现有的 status/control/panel 都是这样），没有前缀路由，
   * 所以这里把已知的子路径都列出来，共用同一个 handler —— handler 自己按路径分发，
   * 免得六份几乎一样的 lambda 散在 bootstrap 里。
   */
  const adminHandler = createAdminHandler(ctx, config, admin);
  /**
   * 处置动作的依赖在这里才齐（registry/sendQueue 在函数前半段，stats 在中段，
   * taskRouting 是懒建的）。所以不塞具体对象，塞一个晚绑定的视图：
   * `taskRouting` 每次调用时回读 `state`，这样懒建之后也不会拿到 null。
   */
  admin.actions.bind({
    store,
    registry,
    sendQueue,
    get taskRouting() {
      return state.taskRouting ?? null;
    },
    pokeHeartbeat(key) {
      const result = pokeHeartbeat(registry, key);
      if (result.ok) {
        requestHeartbeat(ctx, config, registry, state, memory, stats, store, key, { sendQueue });
      }
      return result;
    },
  });
  for (const suffix of [
    'settings',
    'settings/reset',
    'texts',
    'text',
    'memory',
    'memory/file',
    'actions',
    'action',
    'conversation',
  ]) {
    const routePath = `${config.path}/admin/${suffix}`;
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: routePath, handler: adminHandler }),
      `qq-bridge: ${routePath}`,
    );
  }

  ctx.logger.info(
    `qq-bridge: 已挂载 ${config.path}（托管=${state.enabled ? '开' : '关'}, group=${config.groupEnabled ? config.groupTrigger : 'off'}, private=${config.privateEnabled ? 'on' : 'off'}, 登录监视=${state.loginWatch ? '开' : '关'}）`,
  );
}

export { apply };
