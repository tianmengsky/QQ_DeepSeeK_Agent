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
  /**
   * 思考档位。
   *
   * ⚠️ `'off'` 能不能原样交给 provider，**取决于 provider**。2026-10-19 的线上证据：
   *   provider "a6api" model "deepseek-v4.1-flash" does not support reasoning effort "off"
   *   provider "a6api" model "deepseek-v4.1-flash" does not support reasoning effort "max"
   *   code: UNSUPPORTED_REASONING_EFFORT
   * 也就是 a6api 这条 Responses 路由**拒绝任何显式 effort**（'off' 和默认的 'max' 都被拒），
   * 适配器把它表达成"流正常结束但没有内容"，于是旧代码记成了 `invalid-json`（detail 空串）——
   * 整条辅助判断层（路由／心跳／记忆／复核／进度）因此常年 0%。
   *
   * 对 a6api 只能**不发这个字段**（代价是模型自己想：实测 routing 思考 993 字/3.9s、
   * memory 4222 字/9.2s，短分类会被拖慢并挤占 maxTokens）。
   * 对官方 `deepseek-official` 则相反：它的适配器认 'off'，**必须显式发**，
   * 否则会落到 provider 默认档（官方会话实测默认 high）继续思考。
   *
   * 所以：a6api 路由删字段，其他 provider 原样发送。留空 = 不干预。
   */
  const effort = config.auxReasoningEffort;
  if (!effort) return selection;
  if (effort === 'off' && /^a6api\b/i.test(String(selection.provider ?? '')))
    delete selection.reasoningEffort;
  else selection.reasoningEffort = effort;
  return selection;
}
