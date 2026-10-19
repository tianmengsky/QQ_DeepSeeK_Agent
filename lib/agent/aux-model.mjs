/**
 * 辅助判断调用的模型选择 —— 六个调用点共用。
 *
 * 为什么单独抽出来：语义路由、心跳判断、记忆提炼、发言复核、进度旁路、记忆合并
 * 都是"短分类"，却各自拼 selection，还都默认沿用主对话的模型。profile 注释里那句
 * 「便宜模型判断该不该插话」从来没有对应的配置键，所以它实际一直在用主模型 ——
 * 而主模型 `deepseek-v4.1-flash` **默认开启思考**，实测同一个短分类请求：
 *
 *   默认请求      首字节 5331ms，思考 1157 字，正文 **0 字**，finish_reason=length
 *   deepseek-v4-flash  首字节 2125ms，思考 0 字，2.5 秒返回合法 JSON
 *
 * 于是这些调用既要撞 `taskRouteTimeoutMs`，又会产出截断的 JSON。
 *
 * 优先级：显式 base（调用方自己的专用键，如 heartbeatProvider）→ aux* → llm* → 全局默认。
 * 专用键永远优先于 aux*，否则会悄悄推翻既有配置。
 */
export function auxSelection(ctx, config, base = null) {
  // base != null 表示调用方带来了**专用键**（heartbeatProvider/Model、memoryProvider/Model）。
  // 专用键比 aux* 更具体，必须优先；aux* 只覆盖"全局默认"这一层。
  const dedicated = base != null;
  const selection = { ...(base ?? ctx?.get?.('agentDefaultModel')?.currentSelection?.() ?? {}) };
  const provider = config.auxProvider || config.llmProvider;
  const model = config.auxModel || config.llmModel;
  if (!dedicated && provider && model) { selection.provider = provider; selection.model = model; }
  // 短分类不需要思考；留空则不干预，沿用适配器默认。这一项对专用键也生效，
  // 因为它是"这类调用"的属性，而不是某个提供方的属性。
  if (config.auxReasoningEffort) selection.reasoningEffort = config.auxReasoningEffort;
  return selection;
}
