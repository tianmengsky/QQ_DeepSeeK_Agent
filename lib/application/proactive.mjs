/**
 * proactive.mjs —— 宿主：她**不被谁问**的时候，也自己决定要不要开口。
 *
 * 这个文件是"一个钟 + 一本账 + 一次决定"，不是第二个 AI：
 *   · 钟（本地规则，零 token）：每隔约一小时（带抖动）看一遍账，产出候选；
 *   · 决定（一次短模型调用）：候选里挑一件做、或者都不做（`none` 是默认答案）；
 *   · 手（本地）：拿锁、让位、复查时效、发送、记账、写回执。
 *
 * 三条硬规矩，都来自线上踩过的坑：
 *   1. **不唤醒子窗口生成**。那句话由宿主写，写完作为 `self_message` 写回目标窗口的
 *      `events` —— 下次那个窗口醒来，"你：……"是它自己的历史，归属正确。
 *   2. **决策不持会话锁**。只在"发送 + 记账"那一小段进 `registry.run()`，
 *      否则她思考的 8 秒里，群里来的消息会全被卡在队列里。
 *   3. **发了就算账**。15 分钟后回查有没有人接；连着没人接，她对这个群/这个人的
 *      主动频率就往下掉，直到不再主动（`frequencyFactor()`）。
 *
 * 为什么这些都要落 SQLite：频率学习依赖**历史**（6~8 次窗口），
 * 内存里那几条撑不起"这个人一直不理我"这个判断，而插件每次热重载都会清内存。
 */
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';
import { recordContext } from '../conversation/context.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
import { auxSelection } from '../agent/aux-model.mjs';
import { AuxProbe, auxFailure, recordAuxCall } from '../agent/aux-attribution.mjs';
import { parseJsonLoose } from '../agent/json-output.mjs';
import { waitWithSignal } from '../agent/cancellation.mjs';
import { fetchBiliRanking, biliShortlist, biliShareText } from './bili-feed.mjs';
import { executeTurn } from './execute-turn.mjs';
import { buildWorldSnapshot } from './world-snapshot.mjs';

export const PROACTIVE_STATE_KEY = 'qq-bridge:proactive';
export const PROACTIVE_ACTIONS = ['none', 'speak', 'bili_share'];
const DAY_MS = 86400000;

/** 带抖动的间隔：用户要的是"大约每小时一次，但不是整点"，固定周期会像闹钟。 */
export function jitteredDelay(baseMs, pct = 0.35, pick = Math.random) {
  const base = Math.max(60000, Number(baseMs) || 3600000);
  const spread = Math.max(0, Math.min(0.9, Number(pct) || 0));
  const low = 1 - spread;
  const high = 1 + spread;
  const factor = low + (high - low) * Math.max(0, Math.min(1, Number(pick()) || 0));
  // 下限放在**结果**上：base 再小，两次主动发言也不会挤在一分钟内。
  return Math.max(60000, Math.round(base * factor));
}

/**
 * 下一次醒来的倒计时。
 *
 * 2026-11-01 用户改口径：不要"一小时 ±40%"，要**每次 30~60 分钟之间随机**——
 * 抖动的周期仍然有一个可预期的重心，而随机区间是没有重心的：她不会让人觉得
 * "差不多整点又要来了"。区间配成 min/max 两个值时按均匀分布取；只配了
 * `proactiveIntervalMs` 的老配置仍走 `jitteredDelay`。
 */
export function nextDelay(config, pick = Math.random) {
  const min = Number(config?.proactiveIntervalMinMs);
  const max = Number(config?.proactiveIntervalMaxMs);
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min) {
    const span = Math.max(0, Math.min(1, Number(pick()) || 0));
    return Math.max(60000, Math.round(min + (max - min) * span));
  }
  return jitteredDelay(config?.proactiveIntervalMs, config?.proactiveJitterPct, pick);
}

/**
 * 状态页要的那一份"她现在为什么没开口"。
 *
 * 只读、不改变任何状态；`/status` 的 `memory.proactive` 用它展开。
 * 四个角度对应四种排查动作：
 *   钟   —— 还没到点，别以为她不理你；
 *   今天 —— 到点了，但额度 / 判断用完了；
 *   学习 —— 每一处她对"有没有人接"的记性；
 *   最后 —— 她上一次怎么决定、为什么。
 */
export function proactiveSnapshot({ host = null, store = null, config = {}, stats = {} } = {}) {
  const now = Date.now();
  const nextAt = Number(host?.runtime?.nextAt) || 0;
  let rows = [];
  try {
    rows = store?.proactiveRecent?.({ limit: 100, since: startOfDay(now) }) ?? [];
  } catch {
    rows = [];
  }
  const sent = rows.filter((row) => row && row.status === 'sent');
  const byKey = new Map();
  for (const row of rows) {
    const key = String(row?.conversation ?? '');
    if (!key) continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(row);
    byKey.set(key, bucket);
  }
  const learn = [...byKey.entries()]
    .map(([key, history]) => {
      const factor = frequencyFactor(history, config, now);
      return {
        conversation: key,
        factor: factor.factor,
        total: history.filter((row) => row.status === 'sent').length,
        answered: history.filter((row) => row.outcome === 'replied').length,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 4);
  return {
    enabled: host?.enabled ?? config.proactiveEnabled !== false,
    // 决策点在哪：`spine` = 她自己的外面（默认），`turn` = 借一个房间，`prompt` = 旧菜单。
    mode: config.proactiveMode === 'prompt'
      ? 'prompt'
      : (config.proactiveSpine === false ? 'turn' : 'spine'),
    intervalMs: Number(config.proactiveIntervalMs) || 3600000,
    jitterPct: Number(config.proactiveJitterPct) || 0,
    // 现在真正生效的是"每次 30~60 分钟随机"（`nextDelay`），旧的两个字段只作回退。
    intervalMinMs: Number(config.proactiveIntervalMinMs) || 1800000,
    intervalMaxMs: Number(config.proactiveIntervalMaxMs) || 3600000,
    sleep: { from: Number(config.proactiveSleepFrom) || 0, to: Number(config.proactiveSleepTo) || 0 },
    clock: {
      nextAt,
      due: nextAt ? now >= nextAt : true,
      waitMs: nextAt ? Math.max(0, nextAt - now) : 0,
      lastRunAt: Number(host?.runtime?.lastRunAt) || 0,
    },
    counts: {
      ticks: Number(stats.proactiveTicks) || 0,
      spoken: Number(stats.proactiveSpoke) || 0,
      declined: Number(stats.proactiveDeclined) || 0,
      failures: Number(stats.proactiveFailures) || 0,
    },
    today: {
      sent: sent.length,
      replied: sent.filter((row) => row.outcome === 'replied').length,
      quiet: sent.filter((row) => row.outcome === 'quiet').length,
      checking: sent.filter((row) => row.outcome == null).length,
      budget: Number(config.proactiveDailyMax) || 4,
    },
    learn,
    recent: rows.slice(0, 5),
    candidates: host?.lastCandidates ?? null,
    last: stats.lastProactive ?? null,
    // `spine` 模式下 `candidates` 恒为 null：她不是从候选里挑一间屋子，而是在
    // `self:account` 里看世界快照、自己决定要不要用 `qq_windows say` 找谁。
    note: (config.proactiveSpine === false || config.proactiveMode === 'prompt'
      ? '钟没到点不算异常；today.sent 为 0 多半是钟/额度，learn.factor 为 0 才是"她决定不开口"'
      : '钟没到点不算异常；mode=spine 表示决定发生在 self:account（不属于任何房间），candidates 恒为 null；today.sent 为 0 多半是钟/睡觉/额度'),
  };
}

/**
 * 她在这个会话还该不该主动 —— 0 就是"不再主动了"。
 *
 * 判据只看**回应率**，不看模型自评：模型总会说"这次会有人理我"，
 * 而账本上是 0/5。回应率分成四档，理由是要能在 `/status` 里一句话解释清楚：
 *   0/1 次：样本不够，照常（1.0）
 *   ≥50%：照常（1.0）；≥20%：减半（0.5）；有过但很少：四分之一（0.25）
 *   一次都没有（样本 ≥2）：0 —— 停
 * 停不是永久的：`proactiveProbeDays` > 0 时，隔那么久探一次
 * （默认 0 = 不探，用户的原话是"直到不和这个人或群主动交互"）。
 */
export function frequencyFactor(history, config = {}, now = Date.now()) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((row) => row && row.status === 'sent')
    .slice(0, Math.max(1, Number(config.proactiveLearnWindow) || 6));
  const total = rows.length;
  const answered = rows.filter((row) => row.outcome === 'replied').length;
  const rate = total ? answered / total : 1;
  if (total < 2) return { factor: 1, rate, answered, total, stopped: false };
  let factor = 1;
  if (rate >= (Number(config.proactiveKeepRate) || 0.5)) factor = 1;
  else if (rate >= (Number(config.proactiveSlowRate) || 0.2)) factor = 0.5;
  else if (rate > 0) factor = 0.25;
  else factor = 0;
  if (factor === 0) {
    const probeDays = Math.max(0, Number(config.proactiveProbeDays) || 0);
    const lastAt = Number(rows[0]?.created_at) || 0;
    if (probeDays > 0 && lastAt && now - lastAt >= probeDays * DAY_MS) factor = 0.25;
  }
  return { factor, rate, answered, total, stopped: factor === 0 };
}

/**
 * 从 `events` 里看"她发出去之后有没有人接"。
 *
 * 只认**别人说的**：她自己的 `self_message` 不算；表情/图片也算接话
 * （有人回一张图就是回应，不能要求人家写满一句）。
 */
export function engagementOf(events, since) {
  for (const event of events ?? []) {
    const at = Number(event?.createdAt ?? event?.payload?.at) || 0;
    if (at <= since) continue;
    if (event.kind === 'self_message' || event.kind === 'action') continue;
    const payload = event.payload ?? {};
    if (String(payload.qq ?? '') === '' && String(event.kind) === 'message') continue;
    return true;
  }
  return false;
}

/**
 * 她"醒来那一刻"看到的东西，拼成一段文本。
 *
 * 刻意做成可导出的纯函数：这段文本是这一层唯一的"输入面"，
 * 能不能被看懂、有没有给她留拒绝的余地，只能靠读它来判断。
 */
export function buildProactiveAsk({ speak = [], bili = null, now = Date.now(), thoughts = '' } = {}) {
  const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const parts = [
    `现在是 ${stamp}。没人问你话——这是你自己醒着的时刻。`,
    '',
    '你最近写下的关于自己的想法：',
    String(thoughts ?? '').trim() || '（还没有）',
    '',
    '可以做的事：',
  ];
  if (speak.length) {
    parts.push('想说话的窗口（安静很久了）：');
    for (const item of speak) {
      const learn = item.learn?.total
        ? `那边你主动说过 ${item.learn.total} 次，有人接 ${item.learn.answered} 次`
        : '你还没在那边主动开过口';
      parts.push(`- ${item.key}｜${item.label}｜安静了 ${item.quietHours} 小时｜${learn}`);
    }
  }
  if (bili?.items?.length) {
    parts.push('', 'B站此刻的热门（你刚翻到的）：');
    bili.items.forEach((item, index) => {
      parts.push(`[${index + 1}] ${item.title}（UP：${item.owner || '未知'}｜${item.tname || '分区未知'}｜播放 ${item.view}）`);
    });
  }
  parts.push(
    '',
    '选一件做，或者都不做。规矩：',
    '1. 大多数时候应该是 none —— 你不是在完成"每小时说一句"的任务；',
    '2. 想说话，就写一两句真的想说的话（不超过 60 字），不要问候式开场，不要"在吗"；',
    '3. 分享视频，写一句你自己的话（不超过 40 字），别写"推荐"「安利」这种词，也别复述标题；',
    '4. 一次只做一件，目标只能从上面的窗口里选。',
    '',
    '只输出一行 JSON：',
    '{"action":"none|speak|bili_share","target":"group:123 或 user:456","pick":1,"text":"你要说的话","why":"不超过20字"}',
  );
  return parts.join('\n');
}

function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function hoursSince(now, at) {
  const from = Number(at) || 0;
  if (!from) return 999;
  return (now - from) / 3600000;
}

export class ProactiveHost {
  constructor(ctx, config, registry, state, memory, stats, store) {
    this.ctx = ctx;
    this.config = config;
    this.registry = registry;
    this.state = state;
    this.memory = memory;
    this.stats = stats;
    this.store = store;
    this.runtime = this.#loadState();
  }

  get enabled() {
    return this.config.proactiveEnabled !== false && Boolean(this.state?.enabled) && !this.state?.disposed;
  }

  get available() {
    return Boolean(this.store?.available) && Boolean(this.ctx?.get?.('llm'));
  }

  #loadState() {
    const fallback = { nextAt: 0, shared: [], lastDecision: null, lastRunAt: 0 };
    try {
      const raw = this.store?.getState?.(PROACTIVE_STATE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        nextAt: Number(parsed?.nextAt) || 0,
        shared: Array.isArray(parsed?.shared) ? parsed.shared.slice(-200) : [],
        lastDecision: parsed?.lastDecision ?? null,
        lastRunAt: Number(parsed?.lastRunAt) || 0,
      };
    } catch {
      return fallback;
    }
  }

  persist() {
    try {
      this.store?.setState?.(PROACTIVE_STATE_KEY, JSON.stringify(this.runtime));
    } catch { /* 状态丢了最多是"早一轮"或"晚一轮"，不影响正确性 */ }
  }

  /** 到点了吗。`force` 给面板的"现在让她看一眼"。 */
  due(now = Date.now(), { force = false } = {}) {
    if (force) return true;
    return now >= (Number(this.runtime.nextAt) || 0);
  }

  /** 候选：安静的窗口（含"她在那儿有未完成的事"的线索）+ 新鲜的热门视频。 */
  async candidates({ now = Date.now(), signal = null } = {}) {
    const speak = [];
    const skipped = [];
    const skippedCounts = {};
    const skip = (key, reason) => {
      skipped.push({ key, reason });
      skippedCounts[reason] = (skippedCounts[reason] ?? 0) + 1;
    };
    const rows = this.store?.listConversations?.({ since: now - 30 * DAY_MS, limit: 40 }) ?? [];
    const limit = Math.max(1, Number(this.config.proactiveQueryLimit) || 6);
    const selfId = String((this.config?.selfIds ?? [])[0] ?? '').trim();
    // 陈旧上限：对三周前的一句私聊开口，比不说更吓人。默认只回七天内的沉默。
    const staleHours = Math.max(1, Number(this.config.proactiveStaleHours) || 168);
    for (const row of rows) {
      const key = String(row?.conversation ?? '');
      if (!this.#permitted(key)) { skip(key, 'not-permitted'); continue; }
      // 她自己的号也是会话（user:<self_id>），不能当成"想跟谁说话"的对象。
      if (selfId && key === `user:${selfId}`) { skip(key, 'self'); continue; }
      if (!this.#budgetFor(key, now)) { skip(key, 'budget'); continue; }
      const quiet = hoursSince(now, row.last_message_at);
      if (quiet < (Number(this.config.proactiveQuietHours) || 8)) { skip(key, 'quiet'); continue; }
      if (quiet > staleHours) { skip(key, 'stale'); continue; }
      if (hoursSince(now, row.last_spoke_at) < (Number(this.config.proactiveCooldownMs) || 21600000) / 3600000) { skip(key, 'cooldown'); continue; }
      const history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(2, Number(this.config.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
      const learn = frequencyFactor(history, this.config, now);
      if (learn.factor <= 0) { skip(key, 'learn-stopped'); continue; }
      speak.push({
        key,
        label: this.#labelOf(key),
        quietHours: Math.round(quiet),
        factor: learn.factor,
        learn,
        lastSpokeAt: Number(row.last_spoke_at) || 0,
      });
    }
    speak.sort((a, b) => b.quietHours - a.quietHours);
    const shortSpeak = speak.slice(0, limit);
    for (const item of speak.slice(limit)) skip(item.key, 'shortlist');

    let bili = null;
    if (this.config.proactiveBiliEnabled !== false && this.config.proactiveBiliIntent !== 'off') {
      const feed = await fetchBiliRanking({
        config: this.config,
        signal,
        rid: 0,
        timeoutMs: Number(this.config.proactiveBiliTimeoutMs) || 8000,
      });
      if (feed.items?.length) {
        const items = biliShortlist(feed.items, {
          shared: this.runtime.shared,
          keywords: this.config.proactiveBiliKeywords ?? [],
          count: Math.max(2, Number(this.config.proactiveBiliShortlist) || 8),
        });
        if (items.length) bili = { items, reason: feed.reason };
      } else {
        this.stats.lastProactiveFeed = { at: now, reason: feed.reason };
      }
    }
    // 诊断留给 /status：每一个被筛掉的窗口都要说得出是哪个、为什么。
    this.lastCandidates = {
      at: now,
      considered: rows.length,
      picked: shortSpeak.map((item) => ({ key: item.key, label: item.label, quietHours: item.quietHours, factor: item.factor })),
      skipped,
      skippedCounts,
    };
    return { speak: shortSpeak, bili };
  }

  #permitted(key) {
    const [kind, id] = String(key).split(':');
    if (kind === 'group') return this.config.groupEnabled !== false && this.#allowed(this.config.groups, id);
    if (kind === 'user') return this.config.privateEnabled !== false && this.#allowed(this.config.users, id);
    return false;
  }

  #allowed(list, id) {
    if (!Array.isArray(list) || !list.length) return true;
    return list.map(String).includes(String(id));
  }

  /** 这个会话今天还有额度吗（每会话每天最多 1 次主动）。 */
  #budgetFor(key, now) {
    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const total = rows.filter((row) => row.status === 'sent').length;
    if (total >= (Number(this.config.proactiveDailyMax) || 4)) return false;
    return !rows.some((row) => row.conversation === key && row.status === 'sent');
  }

  #labelOf(key) {
    try {
      const [kind, id] = String(key).split(':');
      if (kind === 'group') {
        const group = this.memory?.selfLedger?.groups?.().find((g) => String(g.groupId) === String(id));
        return group?.name ? `群「${group.name}」` : '某个群';
      }
      const friend = this.memory?.selfLedger?.friends?.().find((f) => String(f.userId) === String(id));
      return friend?.remark || friend?.nickname ? `私聊「${friend.remark || friend.nickname}」` : '某个人';
    } catch {
      return String(key).startsWith('group:') ? '某个群' : '某个人';
    }
  }

  /** 自己在不在状态（关着/在跑回合/刚说完话）。 */
  #busy(key, now) {
    const entry = this.registry?.entry?.(key);
    if (!entry) return 'no-entry';
    if (entry.pending?.length) return 'unread';
    if (Number(entry.awakeUntil) > now) return 'recently-spoke';
    return '';
  }

  /**
   * 结算到点的主动发言：15 分钟内有没有人接。
   *
   * 结果写回 `proactive.outcome`，它同时是 `/status` 的读数与下一轮频率的输入。
   */
  async settle({ now = Date.now(), signal = null } = {}) {
    const window = Math.max(60000, Number(this.config.proactiveEngageWindowMs) || 900000);
    const rows = this.store?.pendingProactiveChecks?.({ before: now - window, limit: 20 }) ?? [];
    for (const row of rows) {
      if (signal?.aborted) break;
      const since = Number(row.created_at) || 0;
      const events = this.store?.readEvents?.(row.conversation, { limit: 40, latest: true })?.messages ?? [];
      const replied = engagementOf(events.filter((event) => Number(event.createdAt) > since), since);
      this.store?.finishProactiveCheck?.(row.id, replied ? 'replied' : 'quiet');
    }
    return rows.length;
  }

  #historyLines() {
    try {
      const records = this.memory?.agent?.latest?.('self') ?? [];
      const lines = records
        .filter((r) => r && !r.withdrawn && /^me\./u.test(String(r.slot ?? '')) && r.visibility === 'public')
        .slice(0, 6)
        .map((r) => `- ${String(r.text ?? '').slice(0, 120)}`);
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  #ask({ speak, bili, now }) {
    return buildProactiveAsk({ speak, bili, now, thoughts: this.#historyLines() });
  }

  async #callModel(ask, signal) {
    const llm = this.ctx?.get?.('llm');
    if (!llm?.stream) return { ok: false, reason: 'llm-unavailable' };
    const sel = auxSelection(
      this.ctx,
      this.config,
      this.config.proactiveProvider && this.config.proactiveModel
        ? { provider: this.config.proactiveProvider, model: this.config.proactiveModel }
        : null,
    );
    if (!sel?.provider || !sel?.model) return { ok: false, reason: 'model-unavailable' };
    const timeout = Number(this.config.proactiveTimeoutMs) || 40000;
    const scope = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const system = '你是小鲸鱼本人，正在决定"现在要不要主动做点什么"。只输出一行 JSON，不解释、不用代码块。';
    const probe = new AuxProbe('proactive');
    let out = '';
    let iterator;
    try {
      const stream = llm.stream({
        ...sel,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: ask }] }],
        maxTokens: 500,
        signal: scope,
      });
      iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const step = await waitWithSignal(iterator.next(), scope);
        if (step.done) break;
        probe.observe(step.value);
        if (step.value?.type === 'text-delta') out += step.value.text;
      }
    } catch (error) {
      const failure = auxFailure(error, probe, { text: out, timedOut: scope?.aborted });
      recordAuxCall('proactive', { ok: false, cause: failure.cause, durationMs: probe.durationMs, probe, detail: failure.detail, verdict: '决定失败', reason: failure.cause, subject: '主动开口', sample: out });
      return { ok: false, reason: failure.cause };
    } finally {
      if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    }
    try {
      const parsed = parseJsonLoose(out);
      recordAuxCall('proactive', { ok: true, durationMs: probe.durationMs, probe, verdict: String(parsed?.action ?? '?'), reason: String(parsed?.why ?? '').slice(0, 40), subject: '主动开口', sample: out });
      return { ok: true, verdict: parsed };
    } catch {
      recordAuxCall('proactive', { ok: false, cause: 'invalid-json', durationMs: probe.durationMs, probe, verdict: '决定失败', reason: 'JSON 坏了', subject: '主动开口', sample: out });
      return { ok: false, reason: 'invalid-json' };
    }
  }

  #validate(verdict, { speak, bili }) {
    const action = String(verdict?.action ?? 'none');
    if (!PROACTIVE_ACTIONS.includes(action)) return { action: 'none', why: '无效动作' };
    if (action === 'none') return { action, why: String(verdict?.why ?? '').slice(0, 40) };
    const target = String(verdict?.target ?? '');
    const allowed = new Set(speak.map((item) => item.key));
    if (!allowed.has(target)) return { action: 'none', why: '目标不在候选里' };
    const pick = Number(verdict?.pick) || 0;
    if (action === 'bili_share') {
      if (!bili?.items?.[pick - 1]) return { action: 'none', why: '没选到视频' };
      return { action, target, pick, text: String(verdict?.text ?? '').slice(0, 80), why: String(verdict?.why ?? '').slice(0, 40), item: bili.items[pick - 1] };
    }
    const text = String(verdict?.text ?? '').trim();
    if (!text || text.length > (Number(this.config.proactiveMaxTextChars) || 120)) return { action: 'none', why: '话太长或没写' };
    return { action, target, text, why: String(verdict?.why ?? '').slice(0, 40) };
  }

  /**
   * 真开口的那一段。**锁只在这里**：决策已经在外面做完了，
   * 这里只做"复查 → 发 → 记账"，几十毫秒。
   */
  async deliver({ verdict, signal, now = Date.now() }) {
    const key = verdict.target;
    const busy = this.#busy(key, now);
    if (busy) return { sent: false, reason: busy };
    if (!this.#budgetFor(key, now)) return { sent: false, reason: 'budget' };
    const text = verdict.action === 'bili_share'
      ? biliShareText({
        line: verdict.text,
        title: verdict.item?.title ?? '',
        bvid: verdict.item?.bvid ?? '',
      })
      : verdict.text;
    const isGroup = key.startsWith('group:');
    const target = isGroup ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) };
    const idemKey = `proactive:${key}:${now}:${Math.floor(Math.random() * 1e6)}`;
    let result;
    try {
      result = await sendOnebotIdempotent(this.ctx, this.config, this.store, {
        idemKey,
        conversation: key,
        action: isGroup ? 'send_group_msg' : 'send_private_msg',
        target,
        message: [{ type: 'text', data: { text } }],
        signal,
      });
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: verdict.action, target: key, ok: false, reason: String(error?.message ?? error).slice(0, 120) };
      return { sent: false, reason: 'send-failed' };
    }
    if (!result?.sent) return { sent: false, reason: result?.held ? 'held' : 'replayed' };

    // 三样记账：窗口历史（归属）、账本（学习）、自传（"我做过什么"）。
    try {
      const entry = this.registry?.entry?.(key);
      if (entry) {
        recordContext(this.config, entry, { qq: '', who: '你', text, bot: true, messageId: result.onebotId ?? 'self:' + idemKey, at: now, timeSource: 'sent' });
        wakeAfterSpeech(this.config, entry, now);
        this.registry?.persist?.(key, entry);
      }
      this.store?.recordEvent?.({
        conversation: key,
        kind: 'self_message',
        payload: { text, who: '你', qq: '', messageId: result.onebotId ?? 'self:' + idemKey, at: now, timeSource: 'sent' },
        deliverable: false,
        dedupeKey: 'self:' + idemKey,
      });
    } catch { /* 记账失败不影响已经发出的那条 */ }
    this.store?.recordProactive?.({
      conversation: key,
      kind: verdict.action,
      trigger: verdict.why || 'host-clock',
      text,
      ref: verdict.item?.bvid ?? '',
      idemKey,
    });
    try {
      this.memory?.selfLedger?.record?.({
        kind: 'speak',
        target: key,
        summary: `主动开口：${text.split('\n')[0].slice(0, 60)}`,
        outcome: verdict.action === 'bili_share' ? '分享了视频' : '',
        source: 'self-turn',
      });
    } catch { /* 自传写入是加餐，不是前提 */ }
    this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
    this.stats.lastProactive = { at: now, action: verdict.action, target: key, ok: true, text: text.slice(0, 120), why: verdict.why };
    return { sent: true, text };
  }

  /**
   * 她在"自己的时间"里看到的东西。
   *
   * 这不是任务分配，是场景说明：现在几点、她在哪个窗口、可以做什么。
   * 刻意**不写**"大多数时候应该是 none"，也不给候选清单——那是替她做决定。
   * 工具就在手边，用不用、做不做，由她。
   */
  #selfTask({ key, now }) {
    const label = this.#labelOf(key);
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
    return [
      `现在是 ${stamp}，你在${label}这个窗口里。没有人在等你回答。`,
      '',
      '这是你自己的时间。你可以：',
      '- 什么都不做（回 [SKIP] 就行，这很正常，不用找理由）；',
      '- 看看别处最近怎么样：qq_windows（list 有哪些窗口，read 读某个窗口，mine 看自己说过什么）；',
      '- 去刷会儿B站：bili_search 搜、bili_subtitle 看字幕、bili_frames 看画面；看到觉得这边会喜欢的，就直接发出来；',
      '- 想跟谁说话就跟谁说（这个窗口直接回话；别的窗口用 qq_windows action=say，to 用 list 里的编号）。',
      '',
      '没有任务清单，也没有人要求你产出什么。要不要开口、开在哪、说什么，你自己定。',
    ].join('\n');
  }

  /**
   * 该在哪个窗口醒来。
   *
   * 权重 = 她对那地方的记性 × 随机。factor 为 0 不是"禁止"，只是权重降到很低
   * （0.05）——她会记得没人接，但记忆不该替她把门锁上。
   */
  #pickWindow({ now }) {
    const rows = this.store?.listConversations?.({ since: now - 7 * DAY_MS, limit: 30 }) ?? [];
    const selfId = String((this.config?.selfIds ?? [])[0] ?? '').trim();
    const pool = [];
    for (const row of rows) {
      const key = String(row?.conversation ?? '');
      if (!this.#permitted(key)) continue;
      if (selfId && key === `user:${selfId}`) continue;
      const blocked = this.#busy(key, now);
      // 正在进行的对话不打断；没载入的窗口也不硬闯。
      if (blocked === 'unread' || blocked === 'no-entry') continue;
      const history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(4, Number(this.config.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
      const learn = frequencyFactor(history, this.config, now);
      pool.push({ key, factor: learn.factor, weight: Math.max(0.05, learn.factor) * (0.5 + Math.random()) });
    }
    pool.sort((a, b) => b.weight - a.weight);
    return pool[0] ?? null;
  }

  /** 这一回合里她自己说出去了吗（工具发送与回合回话都算）。 */
  #spokeSince(key, since) {
    try {
      const events = this.store?.readEvents?.(key, { limit: 20, latest: true })?.messages ?? [];
      return events.some((event) => String(event.kind) === 'self_message' && Number(event.createdAt) >= since);
    } catch {
      return false;
    }
  }

  /** 把合成的"没有新消息"标记从窗口历史里摘掉，别让它冒充谁说过的话。 */
  #dropSelfTurn(key, marker) {
    try {
      const entry = this.registry?.entry?.(key);
      if (!entry?.window) return;
      const before = entry.window.length;
      entry.window = entry.window.filter((message) => String(message?.messageId ?? '') !== marker);
      if (entry.window.length !== before) this.registry?.persist?.(key, entry);
    } catch { /* 摘不掉最多是历史里多一行标记，不影响正确性 */ }
  }

  /**
   * 真回合模式：她带着工具醒一次，自己决定做不做、做什么。
   *
   * 和旧实现的差别不是"更聪明"，是**权限**：旧版我先筛候选、再问"这几个里挑一个"，
   * 她能决定的只有选项；这里她拿到的是"现在是你的时间"+ 全套工具，
   * 宿主管的只剩钟、账和三件世界的物理（睡觉、每日总次数、不打断在场对话）。
   */
  /**
   * 物理边界：夜里不打扰、一天说够就停。
   *
   * 这两条是"世界的物理"，不是"我替她写好该怎么办"：她可以想说什么就说什么，
   * 但夜里没人应、说太多会被讨厌，是这个世界的性质。
   */
  #guard({ now }) {
    const hour = new Date(now).getHours();
    const from = Number(this.config.proactiveSleepFrom);
    const to = Number(this.config.proactiveSleepTo);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      const asleep = from < to ? hour >= from && hour < to : hour >= from || hour < to;
      if (asleep) {
        this.stats.lastProactive = { at: now, action: 'sleep', ok: true };
        return { ran: false, reason: 'sleep' };
      }
    }
    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const today = rows.filter((row) => row.status === 'sent').length;
    if (today >= (Number(this.config.proactiveDailyMax) || 4)) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '今天开口够多了' };
      return { ran: true, action: 'none', reason: 'daily-budget' };
    }
    return null;
  }

  async #turnTick({ signal, now }) {
    if (signal?.aborted || !this.enabled) return { ran: false, reason: 'aborted' };

    const hour = new Date(now).getHours();
    const from = Number(this.config.proactiveSleepFrom);
    const to = Number(this.config.proactiveSleepTo);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
      const asleep = from < to ? hour >= from && hour < to : hour >= from || hour < to;
      if (asleep) {
        this.stats.lastProactive = { at: now, action: 'sleep', ok: true };
        return { ran: false, reason: 'sleep' };
      }
    }

    const rows = this.store?.proactiveRecent?.({ limit: 200, since: startOfDay(now) }) ?? [];
    const today = rows.filter((row) => row.status === 'sent').length;
    if (today >= (Number(this.config.proactiveDailyMax) || 4)) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '今天开口够多了' };
      return { ran: true, action: 'none', reason: 'daily-budget' };
    }

    const pick = this.#pickWindow({ now });
    if (!pick) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '没有能待的窗口' };
      return { ran: true, action: 'none', reason: 'no-window' };
    }

    const key = pick.key;
    const isGroup = key.startsWith('group:');
    const marker = `self-turn:${now}`;
    const text = '[自主时间] 现在没有新消息。';
    const event = {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      ...(isGroup ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) }),
      user_id: isGroup ? Number((this.config?.selfIds ?? [])[0] ?? 0) : Number(key.slice(5)),
      self_id: this.config?.selfIds?.[0],
      message_id: marker,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { nickname: '时间' },
      __selfTurn: true,
    };

    let spoke = false;
    /**
     * 自主回合是"后台写者"之一：它允许写 `scope=self`（她可以在自己的时间里
     * 记下今天想通了什么）。房间里的普通回合不行——那是"收回房间写权"的边界，
     * 见 `lib/memory/tool.mjs`。
     */
    const turnSession = this.registry?.byKey?.get?.(key)?.sessionId;
    if (turnSession) this.state?.selfTurnSessions?.add?.(turnSession);
    try {
      const budget = Math.max(5000, Number(this.config.proactiveTurnTimeoutMs) || 120000);
      const withTimeout = AbortSignal.timeout(budget);
      await executeTurn(this.ctx, this.config, this.registry, this.state, this.memory, this.stats, this.store, key, event, {
        heartbeat: true,
        signal: signal ? AbortSignal.any([signal, withTimeout]) : withTimeout,
        taskText: this.#selfTask({ key, now }),
      });
      spoke = this.#spokeSince(key, now);
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = {
        at: now, action: 'failed', ok: false, target: key,
        reason: String(error?.message ?? error).slice(0, 120),
      };
      return { ran: true, reason: 'turn-failed' };
    } finally {
      if (turnSession) this.state?.selfTurnSessions?.delete?.(turnSession);
      this.#dropSelfTurn(key, marker);
    }

    this.store?.recordProactive?.({
      conversation: key,
      kind: 'turn',
      trigger: 'self-time',
      text: '',
      ref: '',
      idemKey: `proactive:${key}:${now}`,
      status: spoke ? 'sent' : 'skipped',
    });
    if (spoke) {
      this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
    } else {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
    }
    this.stats.lastProactive = {
      at: now,
      action: spoke ? 'speak' : 'none',
      ok: true,
      target: key,
      factor: pick.factor,
      mode: 'turn',
      text: spoke ? '这一回合她开口了' : '这一回合她没说',
    };
    return { ran: true, action: spoke ? 'speak' : 'none', target: key, mode: 'turn' };
  }

  /**
   * 脊柱：她自己的时间不在任何房间里。
   *
   * `self:account` 这个会话不属于任何群、任何私聊，所以它看见的不是"某间屋子的
   * 最近消息"，而是 `buildWorldSnapshot()` 压出来的世界动静；它说的话也不会被
   * 投递到任何地方（`execute-turn` 里 `__spine` 分支直接返回），只有她主动用
   * `qq_windows say` 点名一个窗口，那句话才会真发出去。
   *
   * 这就是"多脑"的修法：决策发生在一个视野最宽、又不被任何房间带偏的地方；
   * 房间退回"嘴"。
   */
  async #spineTick({ signal, now }) {
    const key = 'self:account';
    const entry = this.registry?.entry?.(key);
    if (!entry) return { ran: false, reason: 'no-registry' };
    let sessionId = entry.sessionId;
    if (!sessionId) {
      try {
        sessionId = await this.registry.ensureSession(key);
      } catch (error) {
        this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
        this.stats.lastProactive = {
          at: now, action: 'failed', ok: false, target: key, mode: 'spine',
          reason: String(error?.message ?? error).slice(0, 120),
        };
        return { ran: true, reason: 'spine-session-failed' };
      }
    }
    this.state?.selfTurnSessions?.add?.(sessionId);

    const marker = `spine:${now}`;
    const text = '[自主时间] 这里没有新消息。';
    const selfId = this.config?.selfIds?.[0];
    const event = {
      post_type: 'message',
      message_type: 'private',
      // 她没有"对面的人"，这个 user_id 只是准入函数要求的一个非空发送者。
      // `__selfTurn` 会在 selfIds 拦截之前放行；没配 selfIds 时用 1 兜底，
      // 否则 user_id=0 会被当成"没有发送者"直接挡掉，整层静默失效。
      user_id: Number(selfId) || 1,
      self_id: selfId,
      message_id: marker,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { nickname: '时间' },
      __selfTurn: true,
      __spine: true,
    };

    let spoke = false;
    try {
      const snapshot = buildWorldSnapshot({ store: this.store, memory: this.memory, now });
      const before = this.store?.countSelfMessages?.({ since: now }) ?? 0;
      const budget = Math.max(5000, Number(this.config.proactiveTurnTimeoutMs) || 120000);
      const withTimeout = AbortSignal.timeout(budget);
      await executeTurn(this.ctx, this.config, this.registry, this.state, this.memory, this.stats, this.store, key, event, {
        heartbeat: true,
        signal: signal ? AbortSignal.any([signal, withTimeout]) : withTimeout,
        taskText: this.#spineTask({ now, snapshot }),
      });
      const after = this.store?.countSelfMessages?.({ since: now }) ?? 0;
      spoke = after > before;
    } catch (error) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = {
        at: now, action: 'failed', ok: false, target: key, mode: 'spine',
        reason: String(error?.message ?? error).slice(0, 120),
      };
      return { ran: true, reason: 'spine-failed' };
    } finally {
      this.state?.selfTurnSessions?.delete?.(sessionId);
    }

    this.store?.recordProactive?.({
      conversation: key,
      kind: 'spine',
      trigger: 'self-time',
      text: '',
      ref: '',
      idemKey: `proactive:${key}:${now}`,
      status: spoke ? 'sent' : 'skipped',
    });
    if (spoke) this.stats.proactiveSpoke = (this.stats.proactiveSpoke ?? 0) + 1;
    else this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
    this.stats.lastProactive = {
      at: now,
      action: spoke ? 'speak' : 'none',
      ok: true,
      target: key,
      mode: 'spine',
      text: spoke ? '她开口了' : '她没说话',
    };
    return { ran: true, action: spoke ? 'speak' : 'none', target: key, mode: 'spine' };
  }

  #spineTask({ snapshot }) {
    return [
      snapshot,
      '',
      '这是你自己的时间。上面写的是别处的动静——没有人在等你回答。',
      '你可以什么都不做（回 [SKIP] 就行），可以看别处、去 B 站逛一会儿，也可以忽然想起谁、想跟谁说句话。',
      '要跟谁说：先用 qq_windows 的 list 看有哪些窗口，再用 action=say、to=编号、text=一句话。',
      '想起"回头要问某人一件事"，就用 qq_intent add 记下来（它会在你下次醒着的时候出现，不会到点提醒你）。',
      '注意：这里是"外面"，不是任何一个房间。你直接回话不会被发到任何地方——只有 say 那一下才会真发出去。',
    ].join('\n');
  }

  /** 一个完整的"醒一次"：结算 → 排下一轮 → 候选 → 决定 → 执行。 */
  async tick({ signal = null, now = Date.now(), force = false } = {}) {
    if (!this.enabled) return { ran: false, reason: 'disabled' };
    if (!this.due(now, { force })) return { ran: false, reason: 'not-due' };
    this.stats.proactiveTicks = (this.stats.proactiveTicks ?? 0) + 1;
    this.runtime.nextAt = now + nextDelay(this.config);
    this.runtime.lastRunAt = now;
    this.persist();

    await this.settle({ now, signal });
    if (signal?.aborted || !this.enabled) return { ran: false, reason: 'aborted' };

    // 默认走"真回合"：她带着工具醒一次，自己决定做什么。
    // `proactiveMode: 'prompt'` 保留旧的选择题实现（下面那段），作回退与对照。
    if (this.config.proactiveMode !== 'prompt') {
      // 睡觉闸与每日额度对所有模式一致，先过一遍。
      const gate = this.#guard({ now });
      if (gate) return gate;
      // 脊柱：默认在她的"外面"醒，而不是借某个房间。房间退回"嘴"。
      if (this.config.proactiveSpine !== false) return this.#spineTick({ signal, now });
      return this.#turnTick({ signal, now });
    }

    const candidates = await this.candidates({ now, signal });
    if (!candidates.speak.length && !candidates.bili) {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: '没有候选' };
      return { ran: true, action: 'none', reason: 'no-candidates' };
    }
    const decided = await this.#callModel(this.#ask({ ...candidates, now }), signal);
    if (!decided.ok) {
      this.stats.proactiveFailures = (this.stats.proactiveFailures ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'failed', reason: decided.reason };
      return { ran: true, reason: decided.reason };
    }
    const verdict = this.#validate(decided.verdict, candidates);
    if (verdict.action === 'none') {
      this.stats.proactiveDeclined = (this.stats.proactiveDeclined ?? 0) + 1;
      this.stats.lastProactive = { at: now, action: 'none', ok: true, why: verdict.why };
      return { ran: true, action: 'none', why: verdict.why };
    }
    const sent = await this.deliver({ verdict, signal, now });
    if (sent.sent && verdict.action === 'bili_share' && verdict.item?.bvid) {
      this.runtime.shared = [...new Set([...(this.runtime.shared ?? []), verdict.item.bvid])].slice(-200);
      this.persist();
    }
    return { ran: true, action: verdict.action, ...sent };
  }
}
