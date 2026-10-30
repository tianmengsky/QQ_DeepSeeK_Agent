import { workspaceRoot, workspaceDirectory, workspaceAction } from '../agent/workspace.mjs';
import { promptSourceVersion } from '../prompt/text-sources.mjs';
import { PROMPT_REVISION } from '../prompt/protocol.mjs';
import { planEffort } from '../agent/reasoning-effort.mjs';

export function sessionSignature(config) {
  return JSON.stringify([config.cwd ?? '', config.agentPreset ?? '', config.llmProvider ?? '',
    config.llmModel ?? '',
    /*
     * 思考档位这个槽位**恒为空**：模型/档位改由 `modelSignature` 记账并在原
     * Session 上重选（`selectModelFor`）。留一个常量占位是为了让已有会话的
     * 签名保持原样 —— 否则升级当天所有会话都会被判成"签名变了"、整段上下文
     * 一起丢掉。
     */
    '',
    // Changing bridge prompt placement must invalidate existing DSH history;
    // otherwise an upgraded process would continue the duplicate-window chain.
    PROMPT_REVISION, promptSourceVersion(config), config.injectWindowOnce ?? true,
    'final-reply-v2-post-tool', config.replyShapes ?? [],
    'shared-experience-v1', config.episodicMemoryEnabled ?? true,
    'agent-attention-v3-reply-value', 'memory-blocks-v3-agent-owned', config.memoryInjectMaxChars ?? 1800,
    'conversation-workspace-v2', workspaceRoot(config), 'file-access-v2', 'long-task-progress-v1',
    'task-ledger-progress-v1', config.taskLedgerEnabled !== false, config.conversationMemoryMaxChars ?? 450,
    'task-sessions-v2-owned-inputs', config.taskRoutingMode ?? 'enabled',
    config.rotateEveryTurns ?? 30, config.conversationContextMaxChars ?? 60000]);
}

/** Archived DSH sessions reject model steps even though prompt admission succeeds. */
export function isSessionArchived(ctx, sessionId) {
  return Boolean(sessionId && ctx?.get?.('workspaceRegistry')?.archivedSessionIds?.includes(sessionId));
}

/**
 * 这个会话下一轮会不会被换掉；null 表示继续用当前会话。
 *
 * flush 与 ensureSession 必须共用**同一个**判定。两边各写一份时，flush 会因为
 * "提示词字符超了 `conversationContextMaxChars`"而提前收尾 —— 可配了
 * `rotateEveryTurns` 的会话是固定生命周期，字符预算根本不参与轮换（见下），
 * 它还要再用十几个回合。提示词那句"这个窗口马上关闭"是假的；更糟的是
 * `memoryFlushSession` 一次性标记已经被这次假轮换用掉，等到第 30 轮真的换会话时
 * 反而收不到尾 —— 记事变少而提示变吵，两头都输。
 */
export function sessionRotationDue(config, entry, ctx) {
  if (!entry?.sessionId) return null;
  if (isSessionArchived(ctx, entry.sessionId)) return 'archived';
  if (entry.sessionSignature && entry.sessionSignature !== sessionSignature(config)) return 'signature';
  if (entry.forceRotate) return 'force';
  const configuredLimit = Number(config.rotateEveryTurns);
  const limit = entry.stableTaskId ? Infinity : configuredLimit > 0 ? configuredLimit : Infinity;
  // Fixed lifecycles count admitted main-dialogue turns. A character estimate
  // must not shorten them; DSH compaction can maintain the same Session.
  const fixedLifecycle = !entry.stableTaskId && configuredLimit > 0;
  const contextLimit = entry.stableTaskId
    ? Number(config.taskContextMaxChars) || 120000
    : Number(config.conversationContextMaxChars) || 60000;
  if ((entry.turns ?? 0) >= limit) return 'turn-limit';
  if (!fixedLifecycle && (entry.contextChars ?? 0) >= contextLimit) return 'context-budget';
  return null;
}

function clearSession(entry) {
  entry.sessionId = undefined;
  entry.turns = 0;
  entry.contextChars = 0;
  entry.staticDone = false;
  entry.windowHashes = {};
  entry.exampleHashes = {};
  entry.memoryHash = undefined;
  entry.memoryHashes = {};
}

/**
 * 上下文超窗后的立即重建。
 *
 * 为什么不能等常规轮换：`contextChars` 只累加**文本**字符，图片 token 一分都不算，
 * 所以"还没到轮换点、上游已经拒收"是常态 —— 线上就是这样：图片占 37 万 token，
 * 而窗口只有 26 万。此时继续用同一个 Session，每一条消息都会撞同一个 413。
 *
 * 这里刻意**不跑 memory flush**：flush 回合仍然要带上整段历史，会被同一道预检
 * 一起拒掉（还要白等一次超时）。旧会话收不了尾这件事，只能记日志说明。
 */
export function rotateAfterContextOverflow(registry, key, detail = '') {
  const entry = registry.entry(key);
  if (!entry) return null;
  const previous = entry.sessionId ?? null;
  clearSession(entry);
  registry.persist?.(key);
  registry.ctx?.logger?.info(
    `qq-bridge: ${key} 上下文超出模型窗口，丢弃会话 ${previous ?? '(无)'} 并重建` +
      (detail ? ` —— ${detail}` : ''),
  );
  return previous;
}

/**
 * 模型选择指纹。**不放进 `sessionSignature`**：提示词签名一变就要换会话、
 * 丢掉整段上下文，而换模型不需要 —— `selectModel` 可以在同一个 Session 上
 * 原地换掉（见 `selectModelFor`）。分开记账，改模型才不会把群友聊了上千轮
 * 的上下文一起清掉。
 */
export function modelSignature(config) {
  return JSON.stringify([config.llmProvider ?? '', config.llmModel ?? '',
    config.llmReasoningEffort ?? '']);
}

/**
 * 给一个 Session 选模型（含思考档位）。
 *
 * 档位发不发由 `planEffort` 决定：配了就发（`off` 也发），适配器明确不认才不发，
 * 并且把原因留在 `registry.effortNote` 上给面板看。
 */
async function selectModelFor(registry, key, entry, sessionId) {
  const { llmProvider, llmModel } = registry.config;
  if (!llmProvider || !llmModel) return;
  const selectModel = registry.ctx?.sessionController?.selectModel;
  if (!selectModel) return;
  const plan = await planEffort(registry.ctx, registry.config, registry);
  const sel = { sessionId, provider: llmProvider, model: llmModel };
  if (plan.effort) sel.reasoningEffort = plan.effort;
  if (plan.note) {
    registry.effortNote = plan.note;
    entry.effortNote = plan.note;
    registry.ctx.logger.warn(`qq-bridge: ${key} 思考档位没发出去 —— ${plan.note.message}`);
  } else {
    registry.effortNote = null;
    delete entry.effortNote;
  }
  const picked = await selectModel.call(registry.ctx.sessionController, sel);
  entry.modelSignature = modelSignature(registry.config);
  registry.ctx.logger.info(
    `qq-bridge: ${key} 模型 → ${picked?.selected?.provider ?? sel.provider}/${
      picked?.selected?.model ?? sel.model
    }` + (plan.effort ? ` · 思考 ${plan.effort}` : ''),
  );
}

export async function ensureSession(registry, key) {
  const entry = registry.entry(key);
  const reason = sessionRotationDue(registry.config, entry, registry.ctx);

  const signature = sessionSignature(registry.config);
  if (isSessionArchived(registry.ctx, entry.sessionId)) {
    registry.ctx.logger.info(`qq-bridge: ${key} 旧会话已归档，创建新会话并保留上下文`);
    clearSession(entry);
    registry.persist(key, entry);
  } else if (entry.sessionId && entry.sessionSignature && entry.sessionSignature !== signature) {
    clearSession(entry);
  }
  entry.sessionSignature = signature;

  // 没有会话，或者刚被归档/签名变化清掉：下面照旧新建。
  if (entry.sessionId && !reason) {
    // 同一个 Session 上换模型/换思考档：原地重选，不换会话。
    if (entry.modelSignature !== modelSignature(registry.config)) {
      try {
        await selectModelFor(registry, key, entry, entry.sessionId);
        registry.persist?.(key, entry);
      } catch (error) {
        registry.ctx.logger.warn(
          `qq-bridge: ${key} 重选模型失败，这轮先用旧选择 —— ${error?.message ?? error}`,
        );
      }
    }
    return entry.sessionId;
  }

  // 区分"首次建会话"和"聊满轮换"。
  // Session 在构建提示词之前准备；首次创建和轮换都重置注入状态。
  const rotating = Boolean(entry.sessionId);
  if (rotating) {
    registry.ctx.logger.info(
      `qq-bridge: ${key} 换新会话（原因：${reason}，轮数 ${entry.turns}，提示词字符 ${entry.contextChars ?? 0}）`,
    );
  }

  const request = {};
  request.cwd = workspaceDirectory(workspaceRoot(registry.config), entry.workspaceScope ?? key);
  workspaceAction(workspaceRoot(registry.config), entry.workspaceScope ?? key, { action: 'list' });
  if (registry.config.agentPreset) request.agentPreset = registry.config.agentPreset;

  const created = await registry.ctx.sessionController.create(request);

  entry.sessionId = created.sessionId;
  entry.turns = 0;
  entry.forceRotate = false;
  entry.contextChars = 0;
  entry.staticDone = false;
  entry.windowHashes = {};
  entry.exampleHashes = {};
  entry.memoryHash = undefined;
  entry.memoryHashes = {};
  registry.persist(key, entry);
  registry.ctx.logger.info(`qq-bridge: 会话 ${key} → ${created.sessionId}`);

  // 给这个会话单独选模型。只能用 selectModel —— 改全局默认会连主界面
  // 里的其它会话一起切走，那不是我们要的。
  if (registry.config.llmProvider && registry.config.llmModel) {
    try {
      await selectModelFor(registry, key, entry, created.sessionId);
    } catch (error) {
      // 选不上就退回全局默认，别让整条链路挂掉
      registry.ctx.logger.warn(
        `qq-bridge: ${key} 指定模型失败，退回默认 —— ${error?.message ?? error}`,
      );
    }
  }
  return entry.sessionId;
}
