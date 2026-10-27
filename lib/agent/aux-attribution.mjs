/**
 * 辅助模型调用的共享归因与健康度。
 *
 * 为什么需要（B1）：线上 742 条路由里 192 条被记成 `invalid-json`，而 `fallbackDetail`
 * 是空串 —— 模型其实**什么都没返回**，`JSON.parse('')` 抛 SyntaxError 后被归成"坏 JSON"。
 * 这两件事的修法完全相反：坏 JSON 是提示词/校验要放宽，空输出是预算/思考/供应商问题。
 * 所以"正文为空"必须在解析之前单独识别出来，记为 `empty-output`。
 *
 * 空输出单看字段又不足以定位，必须一起记：收到哪些分片、各多少段、思考多少字、
 * finishReason、耗时。`deepseek-v4.1-flash` 默认开思考，`maxTokens 60~280` 下很可能
 * 把预算全烧在思考上、正文 0 字且 finishReason=length —— 那要看数据说话。
 *
 * 健康度（C）：只放内存环形缓冲，不为它新增任何高频写库。重载后从零累计。
 */

/** 环形缓冲只保留最近这么多次调用；够看趋势，也不占内存。 */
const RING_SIZE = 240;
/** 健康度默认看最近 15 分钟。 */
export const AUX_WINDOW_MS = 15 * 60 * 1000;
/** 低于这个成功率就认为辅助判断层已经降级。 */
export const AUX_DEGRADED_RATE = 0.8;
/** 样本太少时不报警 —— 1/1 失败就喊"降级"只会变成噪音。 */
export const AUX_MIN_SAMPLES = 3;

/** 调用点的中文名。分组展示与告警都用它。 */
export const AUX_LABELS = {
  heartbeat: '心跳插话',
  routing: '语义路由',
  memory: '记忆提炼',
  'reply-decision': '参与决策',
  floor: '楼层复核',
  progress: '进度旁路',
  reflect: '记忆反思',
};

/** 内存环形缓冲：{ label, ok, cause, empty, durationMs, detail, at } */
const history = [];

/** finishReason 在不同适配器上字段名不一样，全都试一遍。 */
function readFinishReason(chunk) {
  const reason = chunk?.finishReason ?? chunk?.finish_reason ?? chunk?.raw?.finish_reason ??
    chunk?.raw?.finishReason ?? chunk?.usage?.finish_reason;
  return reason == null || reason === '' ? null : String(reason);
}

/**
 * 流片段探针：数清楚模型到底吐了什么。
 *
 * 只在内存里数，不保存正文（正文由调用方自己拼），所以对既有循环是纯附加，
 * 不会改变任何控制流。用法：
 *
 *   const probe = new AuxProbe('routing');
 *   for (;;) { ... const step = ...; probe.observe(step.value); ... }
 *   probe.detail(raw)   // "收到 0 段正文 / reasoning 3 段 / 用时 4021ms（…）"
 */
export class AuxProbe {
  constructor(label = 'aux') {
    this.label = label;
    this.startedAt = Date.now();
    this.chunks = new Map();
    this.reasoningChars = 0;
    this.finishReason = null;
    /**
     * 最后一个"既不是正文也不是思考"的分片（结束/用量/错误帧）。
     *
     * 为什么必须留：线上实测辅助调用**用时 0~1ms、零正文、零思考**，只收到一个
     * `finish` 分片 —— 这不是"思考吃光预算"，而是请求在本地就被结束掉了。
     * 结束帧里通常带着 finish_reason / usage / error，是唯一能分清
     * "供应商拒绝" "模型名不识别" "参数不合法" 的证据。只留一段截断文本，
     * 避免把整段完成内容带进状态页。
     */
    this.lastOther = null;
  }

  /** 记录一个流片段。返回 this，方便链式写。 */
  observe(chunk) {
    const type = String(chunk?.type ?? 'unknown');
    this.chunks.set(type, (this.chunks.get(type) ?? 0) + 1);
    const finish = readFinishReason(chunk);
    if (finish) this.finishReason = finish;
    if (type === 'reasoning-delta') this.reasoningChars += String(chunk?.text ?? '').length;
    if (type !== 'text-delta' && type !== 'reasoning-delta' && chunk != null) {
      try {
        this.lastOther = JSON.stringify(chunk).slice(0, 240);
      } catch { this.lastOther = String(type); }
    }
    return this;
  }

  count(type) { return this.chunks.get(type) ?? 0; }
  get durationMs() { return Math.max(0, Date.now() - this.startedAt); }
  get textChunks() { return this.count('text-delta'); }
  get reasoningChunks() { return this.count('reasoning-delta'); }
  /** 正文与思考之外的分片（工具、用量、结束标记等）。 */
  get otherChunks() {
    let sum = 0;
    for (const [type, n] of this.chunks) if (type !== 'text-delta' && type !== 'reasoning-delta') sum += n;
    return sum;
  }
  /** 分片明细，写进 fallbackDetail / warning 用。 */
  get chunkBreakdown() {
    return [...this.chunks].map(([type, n]) => `${type}×${n}`).join(' ') || '无分片';
  }

  /**
   * 一句话说清"这次调用看到了什么"。
   *
   * 前半段是 `收到 N 段正文 / reasoning N 段 / 用时 Xms` —— 路由的
   * `fallbackCause=empty-output` 直接用它，格式要稳定（读库的人按这个找规律）。
   */
  detail(text = '') {
    const chars = String(text ?? '').length;
    return `收到 ${this.textChunks} 段正文 / reasoning ${this.reasoningChunks} 段 / 用时 ${this.durationMs}ms` +
      `（正文 ${chars} 字，思考 ${this.reasoningChars} 字，分片 ${this.chunkBreakdown}，` +
      `finishReason=${this.finishReason ?? '未知'}` +
      (this.lastOther ? `，末分片 ${this.lastOther}` : '') + '）';
  }
}

/**
 * 把"没拿到可用裁决"归因。
 *
 * 顺序很重要：超时 → 语法错误（空串解析失败归到 empty-output）→ 流异常 → 空输出 → 裁决不合法。
 * 关键是不能让 `JSON.parse('')` 的 SyntaxError 抢在空输出之前 —— 否则线上那 192 条
 * "模型什么都没返回"全都记成了"坏 JSON"。反过来，真正抛了异常时优先报异常本身
 * （stream-error），因为"连流都断了"比"流正常结束但没内容"更贴事实。
 *
 * @returns {{cause: string, detail: string}}
 */
export function auxFailure(error, probe = null, { text = '', timedOut = false } = {}) {
  const detail = probe?.detail?.(text) ?? `收到 ${String(text ?? '').length} 字`;
  const body = String(text ?? '');
  if (timedOut || error?.name === 'TimeoutError') return { cause: 'timeout', detail: `超时；${detail}` };
  if (error instanceof SyntaxError)
    return body.trim()
      ? { cause: 'invalid-json', detail: body.slice(0, 200) }
      : { cause: 'empty-output', detail };
  if (error) return { cause: 'stream-error', detail: String(error?.message ?? error).slice(0, 200) };
  if (!body.trim()) return { cause: 'empty-output', detail };
  return { cause: 'invalid-verdict', detail };
}

/**
 * 记一次辅助调用。
 *
 * `probe` 可选：带上它就能把"这次到底思考了多少字"一起留下。这件事必须可观测 ——
 * 配置里写着 `auxReasoningEffort: 'off'`（请求层确实发了 `thinking: disabled`），
 * 但服务端是否真的不思考，只能看分片。没有这个读数，"为什么关了还在想"永远只能猜。
 *
 * @param {string} label AUX_LABELS 里的键
 * @param {{ok?: boolean, cause?: string|null, durationMs?: number, detail?: string,
 *   probe?: AuxProbe|null, reasoningChars?: number, textChars?: number}} result
 */
export function recordAuxCall(label, { ok = false, cause = null, durationMs = 0, detail = '',
  probe = null, reasoningChars = null, textChars = null } = {}) {
  history.push({
    label: String(label),
    ok: Boolean(ok),
    // 空输出是失败的一个子类：单独计一次，方便直接从健康度里读出 empty-output 有多少。
    cause: ok ? null : (cause ?? 'unknown'),
    empty: !ok && cause === 'empty-output',
    durationMs: Math.max(0, Number(durationMs) || 0),
    /** 思考分片字数；0 = 这次没看到思考（不代表服务端一定没想，只代表流里没有）。 */
    reasoningChars: Math.max(0, Number(reasoningChars ?? probe?.reasoningChars) || 0),
    /** 正文字数；传了才记，避免在成功路径上多算一次。 */
    textChars: textChars == null ? null : Math.max(0, Number(textChars) || 0),
    detail: String(detail ?? '').slice(0, 240),
    at: Date.now(),
  });
  if (history.length > RING_SIZE) history.splice(0, history.length - RING_SIZE);
  return history.length;
}

/** 测试与诊断用：只读拷贝，外部改不动内部状态。 */
export function auxHistory() { return history.map((r) => ({ ...r })); }
/** 重载/测试之间清空。插件没用到它，留给回归测试。 */
export function resetAuxHealth() { history.length = 0; }

const rate = (ok, total) => (total ? Math.round((ok / total) * 1000) / 1000 : null);

/**
 * 辅助判断层健康度。
 *
 * 口径：优先取最近 `windowMs` 内的调用；这一窗里一条都没有时，退回最近 N 次
 * （否则"刚失败两次然后安静了"在状态里会变成不可见）。
 */
export function auxHealthSnapshot({ now = Date.now(), windowMs = AUX_WINDOW_MS } = {}) {
  const inWindow = history.filter((r) => now - r.at <= windowMs);
  const recent = inWindow.length ? inWindow : history.slice(-RING_SIZE);
  const groups = new Map();
  for (const label of Object.keys(AUX_LABELS))
    groups.set(label, { label, name: AUX_LABELS[label], calls: 0, ok: 0, failed: 0, empty: 0,
      durationMs: 0, thinkingCalls: 0, reasoningChars: 0, lastCause: null, lastDetail: null, lastAt: null });
  for (const row of recent) {
    const group = groups.get(row.label) ??
      groups.set(row.label, { label: row.label, name: row.label, calls: 0, ok: 0, failed: 0, empty: 0,
        durationMs: 0, thinkingCalls: 0, reasoningChars: 0, lastCause: null, lastDetail: null, lastAt: null }).get(row.label);
    group.calls += 1;
    if (row.ok) group.ok += 1; else group.failed += 1;
    if (row.empty) group.empty += 1;
    group.durationMs += row.durationMs;
    /**
     * "思考过几次"是独立于成败的读数：请求发了 thinking: disabled 仍然出现
     * reasoning-delta，说明关闭思考没有在服务端生效 —— 这跟"调用失败"是两件事。
     */
    if (Number(row.reasoningChars) > 0) { group.thinkingCalls += 1; group.reasoningChars += Number(row.reasoningChars); }
    // recent 是按时间正序的，所以这里一路覆盖，留下的就是**最近一次**失败。
    if (!row.ok) {
      group.lastCause = row.cause;
      group.lastDetail = row.detail || null;
    }
    group.lastAt = row.at;
  }
  const labels = [...groups.values()]
    .map((g) => ({ ...g, avgMs: g.calls ? Math.round(g.durationMs / g.calls) : 0,
      avgReasoningChars: g.thinkingCalls ? Math.round(g.reasoningChars / g.thinkingCalls) : 0,
      successRate: rate(g.ok, g.calls) }))
    .sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
  const calls = recent.length;
  const ok = recent.filter((r) => r.ok).length;
  const empty = recent.filter((r) => r.empty).length;
  const thinkingCalls = recent.filter((r) => Number(r.reasoningChars) > 0).length;
  const reasoningChars = recent.reduce((n, r) => n + (Number(r.reasoningChars) || 0), 0);
  const successRate = rate(ok, calls);
  return {
    windowMs,
    /** recent-window = 最近 15 分钟；last-samples = 这一窗没流量，退回最近 N 次。 */
    basis: inWindow.length ? 'recent-window' : 'last-samples',
    samples: calls,
    ringSize: history.length,
    calls,
    ok,
    failed: calls - ok,
    empty,
    /** 看到 reasoning-delta 的调用数：>0 就说明"关思考"没有在服务端生效。 */
    thinkingCalls,
    reasoningChars,
    successRate,
    threshold: AUX_DEGRADED_RATE,
    minSamples: AUX_MIN_SAMPLES,
    /** 只有样本够了才判降级，否则一两次失败就报警只会变成噪音。 */
    degraded: calls >= AUX_MIN_SAMPLES && successRate != null && successRate < AUX_DEGRADED_RATE,
    labels: labels.filter((g) => g.calls > 0 || Object.hasOwn(AUX_LABELS, g.label)),
    note: '内存环形缓冲，仅本进程；重载后从零累计，不写库',
  };
}
