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
    const rows = this.store?.listConversations?.({ since: now - 30 * DAY_MS, limit: 40 }) ?? [];
    const limit = Math.max(1, Number(this.config.proactiveQueryLimit) || 6);
    for (const row of rows) {
      const key = String(row?.conversation ?? '');
      if (!this.#permitted(key)) continue;
      if (!this.#budgetFor(key, now)) continue;
      const quiet = hoursSince(now, row.last_message_at);
      if (quiet < (Number(this.config.proactiveQuietHours) || 8)) continue;
      if (hoursSince(now, row.last_spoke_at) < (Number(this.config.proactiveCooldownMs) || 21600000) / 3600000) continue;
      const history = this.store?.proactiveHistory?.(key, {
        limit: Math.max(2, Number(this.config.proactiveLearnWindow) || 6) * 2,
        since: now - 90 * DAY_MS,
      }) ?? [];
      const learn = frequencyFactor(history, this.config, now);
      if (learn.factor <= 0) continue;
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
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
    const parts = [
      `现在是 ${stamp}。没人问你话——这是你自己醒着的时刻。`,
      '',
      '你最近写下的关于自己的想法：',
      this.#historyLines() || '（还没有）',
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

  /** 一个完整的"醒一次"：结算 → 排下一轮 → 候选 → 决定 → 执行。 */
  async tick({ signal = null, now = Date.now(), force = false } = {}) {
    if (!this.enabled) return { ran: false, reason: 'disabled' };
    if (!this.due(now, { force })) return { ran: false, reason: 'not-due' };
    this.stats.proactiveTicks = (this.stats.proactiveTicks ?? 0) + 1;
    this.runtime.nextAt = now + jitteredDelay(this.config.proactiveIntervalMs, this.config.proactiveJitterPct);
    this.runtime.lastRunAt = now;
    this.persist();

    await this.settle({ now, signal });
    if (signal?.aborted || !this.enabled) return { ran: false, reason: 'aborted' };

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
