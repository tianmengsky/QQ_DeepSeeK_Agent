import { workspaceRoot, workspaceDirectory, workspaceAction } from '../agent/workspace.mjs';
import { promptSourceVersion } from '../prompt/text-sources.mjs';
import { PROMPT_REVISION } from '../prompt/protocol.mjs';

export function sessionSignature(config) {
  return JSON.stringify([config.cwd ?? '', config.agentPreset ?? '', config.llmProvider ?? '',
    config.llmModel ?? '', config.llmReasoningEffort === 'off' ? '' : config.llmReasoningEffort ?? '',
    // Changing bridge prompt placement must invalidate existing DSH history;
    // otherwise an upgraded process would continue the duplicate-window chain.
    PROMPT_REVISION, promptSourceVersion(config), config.injectWindowOnce ?? true,
    'final-reply-v2-post-tool', config.replyShapes ?? [],
    'shared-experience-v1', config.episodicMemoryEnabled ?? true,
    'agent-attention-v3-reply-value', 'memory-blocks-v3-agent-owned', config.memoryInjectMaxChars ?? 1800,
    'conversation-workspace-v2', workspaceRoot(config), 'file-access-v2', 'long-task-progress-v1',
    'task-ledger-progress-v1', config.taskLedgerEnabled !== false, config.conversationMemoryMaxChars ?? 450,
    'task-sessions-v2-owned-inputs', config.taskRoutingMode ?? 'enabled',
    config.rotateEveryTurns ?? 20, config.conversationContextMaxChars ?? 60000]);
}

/** Archived DSH sessions reject model steps even though prompt admission succeeds. */
export function isSessionArchived(ctx, sessionId) {
  return Boolean(sessionId && ctx.get?.('workspaceRegistry')?.archivedSessionIds?.includes(sessionId));
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

export async function ensureSession(registry, key) {
  const entry = registry.entry(key);
  const configuredLimit = Number(registry.config.rotateEveryTurns);
  const limit = entry.stableTaskId ? Infinity : configuredLimit > 0 ? configuredLimit : Infinity;
  // Fixed lifecycles count admitted main-dialogue turns. A character estimate
  // must not shorten them; DSH compaction can maintain the same Session.
  const fixedLifecycle = !entry.stableTaskId && configuredLimit > 0;
  const contextLimit = entry.stableTaskId
    ? Number(registry.config.taskContextMaxChars) || 120000
    : Number(registry.config.conversationContextMaxChars) || 60000;

  const signature = sessionSignature(registry.config);
  if (isSessionArchived(registry.ctx, entry.sessionId)) {
    registry.ctx.logger.info(`qq-bridge: ${key} 旧会话已归档，创建新会话并保留上下文`);
    clearSession(entry);
    registry.persist(key, entry);
  } else if (entry.sessionId && entry.sessionSignature && entry.sessionSignature !== signature) {
    clearSession(entry);
  }
  entry.sessionSignature = signature;

  if (entry.sessionId && entry.turns < limit && !entry.forceRotate &&
      (fixedLifecycle || (entry.contextChars ?? 0) < contextLimit)) return entry.sessionId;

  // 区分"首次建会话"和"聊满轮换"。
  // Session 在构建提示词之前准备；首次创建和轮换都重置注入状态。
  const rotating = Boolean(entry.sessionId);
  if (rotating) {
    registry.ctx.logger.info(
      `qq-bridge: ${key} 换新会话（原因：${entry.forceRotate ? 'force' : entry.turns >= limit ? 'turn-limit' : 'context-budget'}，轮数 ${entry.turns}，提示词字符 ${entry.contextChars ?? 0}）`,
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
      const sel = {
        sessionId: created.sessionId,
        provider: registry.config.llmProvider,
        model: registry.config.llmModel,
      };
      // Legacy bridge value "off" means omit the optional control, not an adapter effort id.
      if (registry.config.llmReasoningEffort && registry.config.llmReasoningEffort !== 'off') {
        sel.reasoningEffort = registry.config.llmReasoningEffort;
      }
      const picked = await registry.ctx.sessionController.selectModel(sel);
      registry.ctx.logger.info(
        `qq-bridge: ${key} 模型 → ${picked?.selected?.provider ?? sel.provider}/${
          picked?.selected?.model ?? sel.model
        }`,
      );
    } catch (error) {
      // 选不上就退回全局默认，别让整条链路挂掉
      registry.ctx.logger.warn(
        `qq-bridge: ${key} 指定模型失败，退回默认 —— ${error?.message ?? error}`,
      );
    }
  }
  return entry.sessionId;
}
