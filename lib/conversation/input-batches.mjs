import { admitMessage } from '../domain/admission.mjs';
import { readFloor, captureFloor, isBackchannel } from './floor.mjs';
import { renderMessage } from '../domain/events.mjs';

const storageKey = (key) => 'qq-bridge:input:' + key;
const identity = (event) => event.__inputId;
function continuesWait(event, waiting) {
  const row = readFloor(this.registry.store, this.key, this.registry.entry(this.key)).messages
    .find((m) => m.messageId === String(event.message_id));
  if (row?.replyToId != null && waiting.some((e) => String(e.message_id) === String(row.replyToId))) return true;
  const text = renderMessage(event.message).trim();
  return /^(?:补充(?:一下)?[：:，, ]?|条件(?:是|：|:)|我的补充|改成|改为|换成|换为|再加(?:上)?|尺寸(?:是|：|:)|颜色(?:是|：|:)|要.{1,24}(?:的|色|尺寸|大小)|不要.{1,24}要)/u.test(text);
}
/** One scheduled drain per conversation; take the snapshot only after registry.run actually owns the floor. */
export class InputBatches {
  constructor({ config, registry, state, stats, run, onError }) {
    Object.assign(this, { config, registry, state, stats, run, onError });
    this.entries = new Map();
  }
  entry(key) {
    let entry = this.entries.get(key);
    if (!entry) {
      let saved;
      try { saved = JSON.parse(this.registry.store?.getState(storageKey(key)) ?? 'null'); } catch {}
      entry = { events: saved?.events ?? [], waiting: saved?.waiting ?? [], active: [], claimed: [], waitUntil: saved?.waitUntil ?? 0,
        startedAt: saved?.startedAt ?? 0, lastAt: saved?.lastAt ?? 0, lastRoute: saved?.lastRoute ?? null,
        lastDispatch: saved?.lastDispatch ?? null, timer: null, scheduled: false };
      // A durable request already owns its inputs, even if HMR interrupted the input acknowledgement.
      const store = this.registry.store;
      if (store?.available) {
        const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_replies'").get();
        if (exists) {
          const owned = new Set(store.db.prepare('SELECT meta FROM bridge_replies WHERE conversation=?').all(key)
            .flatMap((r) => { try { return JSON.parse(r.meta).inputIds ?? []; } catch { return []; } }));
          entry.events = entry.events.filter((e) => !owned.has(identity(e)));
        }
        // Admission owns an entire batch before a DSH prompt exists. HMR in
        // that interval must resume the durable execution, never route it again.
        if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_input_routes'").get()) {
          const routed = new Set(store.db.prepare('SELECT id FROM bridge_input_routes WHERE conversation=?').all(key).map((r) => r.id));
          entry.events = entry.events.filter((e) => !routed.has(identity(e)));
        }
      }
      this.entries.set(key, entry);
    }
    return entry;
  }
  save(key, entry = this.entry(key)) {
    this.registry.store?.setState?.(storageKey(key), JSON.stringify({ events: entry.events,
      waiting: entry.waiting, waitUntil: entry.waitUntil, startedAt: entry.startedAt, lastAt: entry.lastAt,
      lastRoute: entry.lastRoute, lastDispatch: entry.lastDispatch }));
  }
  add(key, event, { passive = false, route = 'ordinary' } = {}) {
    const entry = this.entry(key), now = Date.now();
    entry.events = entry.events.filter((e) => !e.__inputPassive || now - (e.__receivedAt ?? now) < (this.config.floorWaitMs ?? 30000));
    event = { ...event, __inputPassive: passive, __inputId: event.__inputId ?? `${event.self_id}:${event.message_id ?? now + ':' + Math.random()}` };
    if (!passive) this.state.taskLedger?.input(key, event);
    entry.lastRoute = passive ? 'passive' : route;
    if (!entry.events.some((e) => identity(e) === identity(event))) entry.events.push(event);
    // Reaction floods must not hide an actionable input behind a passive-only full snapshot.
    const reactions = entry.events.filter((e) => e.__inputPassive);
    const reactionCap = Math.min(8, Math.max(0, (this.config.inputBatchMaxMessages ?? 24) - 1));
    const retained = new Set((reactionCap ? reactions.slice(-reactionCap) : []).map(identity));
    entry.events = entry.events.filter((e) => !e.__inputPassive || retained.has(identity(e)));
    this.pruneWaiting(key, now);
    const waiting = !passive ? this.waitingFor(key, event) : [];
    if (waiting.length) {
      for (const old of waiting.slice().reverse())
        if (!entry.events.some((e) => String(e.message_id) === String(old.message_id)))
          entry.events.unshift({ ...old, __inputId: identity(old) + ':wait:' + now });
      entry.waiting = entry.waiting.filter((e) => !waiting.includes(e));
      entry.waitUntil = Math.max(0, ...entry.waiting.map((e) => e.__waitUntil));
    }
    if (!passive || entry.events.some((e) => !e.__inputPassive)) {
      entry.startedAt ||= now; entry.lastAt = now;
    }
    this.save(key); this.schedule(key);
  }
  /** True when an unclaimed same-author input is still waiting for ordinary aggregation. */
  hasPendingAuthor(key, userId) {
    return this.entry(key).events.some((event) => !event.__inputPassive &&
      String(event.user_id) === String(userId));
  }
  dueAt(entry) {
    const actionable = entry.events.filter((e) => !e.__inputPassive);
    const short = actionable.length && renderMessage(actionable.at(-1).message).trim().length <= 40;
    const quiet = Math.max(this.config.inputDebounceMs ?? 1500, short ? this.config.inputShortDebounceMs ?? 3500 : 0);
    return Math.min(entry.lastAt + quiet, entry.startedAt + (this.config.inputMaxWaitMs ?? 8000));
  }
  schedule(key) {
    const entry = this.entry(key);
    if (entry.scheduled || !entry.events.some((e) => !e.__inputPassive) || !this.state.enabled || this.state.disposed) return;
    clearTimeout(entry.timer);
    const due = this.dueAt(entry);
    const delay = entry.events.filter((e) => !e.__inputPassive).length >= (this.config.inputBatchMaxMessages ?? 24) ? 0 : Math.max(0, due - Date.now());
    entry.timer = setTimeout(() => { entry.timer = null; this.dispatch(key); }, delay);
    entry.timer.unref?.();
  }
  dispatch(key) {
    const entry = this.entry(key);
    if (entry.scheduled) return;
    entry.scheduled = true;
    const signal = this.state.controller?.signal;
    const lane = this.state.taskScheduler?.mode === 'enabled' ? 'task-ingress' : 'execution';
    this.registry.run(key, async () => {
      if (this.state.disposed || !this.state.enabled || signal?.aborted) return;
      // A queued drain may become ready while generation is finishing. Respect the latest quiet period.
      while (entry.events.some((e) => !e.__inputPassive) && entry.events.filter((e) => !e.__inputPassive).length < (this.config.inputBatchMaxMessages ?? 24) && this.dueAt(entry) > Date.now()) {
        await new Promise((resolve) => {
          const timer = setTimeout(done, Math.max(1, this.dueAt(entry) - Date.now()));
          function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
          signal?.addEventListener('abort', done, { once: true });
        });
        if (this.state.disposed || !this.state.enabled || signal?.aborted) return;
      }
      entry.events = entry.events.filter((e) => admitMessage(this.config, e) &&
        !this.registry.entry(key).recalledIds.includes(String(e.message_id)));
      this.save(key);
      let events = entry.events.slice(0, this.config.inputBatchMaxMessages ?? 24);
      const floor = readFloor(this.registry.store, key, this.registry.entry(key));
      const actionable = (e) => {
        const row = floor.messages.find((m) => m.messageId === String(e.message_id));
        return !e.__inputPassive && !row?.otherTarget && (!row || !isBackchannel(row));
      };
      const owner = events.find(actionable);
      let splitReason = null;
      /**
       * 多作者批次按作者边界截断：**这是被测试锁定的设计决策，不要顺手改成合并。**
       *
       * 规格见 test/input-floor.test.mjs 的两条：
       *   · `unmentioned questions from different authors own separate batches`
       *   · `independent explicit requests from different people get separate source turns`
       * 都断言"两个作者的独立请求 = 两个回合，各自只含自己的话"。
       *
       * 为什么必须这样：**文件权限与任务归属只来自"本人的输入"**
       * （见 task-ownership.fileAuthority：file authority comes from owned inputs,
       * never from the shared QQ history）。把别人的请求并进一个不属于他的 owner 下，
       * 要么拒绝、要么误授权，两者都不能接受。amend/continue/cancel 的原作者校验同理。
       *
       * 代价是已知且量过的（2026-10-16 只读复核）：间隔<=5s 且跨度<=15s 的
       * "多人几乎同时提问"共 16 簇 / 34 回合，其中 **18 次回复本可省掉**
       * （若放宽到间隔<=10s 则是 23 次）。注意不要引用更早那个"87 次"的数字 ——
       * 那是把间隔<=30s、跨度上百秒的正常来回对话也算进去得到的，口径过宽。
       *
       * 所以这是一个**权衡**：18 次回复 vs 归属与文件权限的正确性。
       * 要动它请先明确替代方案如何保住 fileAuthority 与原作者校验。
       */
      if (owner) {
        const boundary = events.findIndex((e) => String(e.user_id) !== String(owner.user_id) && actionable(e));
        if (boundary > 0) { splitReason = 'author-boundary'; events = events.slice(0, boundary); }
      }
      if (!events.length) { entry.events = []; this.save(key); return; }
      if (!events.some((e) => !e.__inputPassive)) return;
      entry.lastDispatch = { at: Date.now(), count: events.length,
        authors: [...new Set(events.filter((e) => !e.__inputPassive).map((e) => String(e.user_id)))], splitReason };
      this.save(key);
      entry.active = events;
      const consume = () => {
        const used = new Set(events.map(identity));
        entry.events = entry.events.filter((e) => !used.has(identity(e)));
        const remaining = entry.events.filter((e) => !e.__inputPassive);
        entry.startedAt = remaining.length ? Math.min(...remaining.map((e) => e.__receivedAt ?? Date.now())) : 0;
        this.save(key);
      };
      this.stats.inputBatches = (this.stats.inputBatches ?? 0) + 1;
      this.stats.inputsCoalesced = (this.stats.inputsCoalesced ?? 0) + Math.max(0, events.length - 1);
      const result = await this.run(key, events, { signal, onClaim: () => {
        entry.claimed = [...entry.claimed, ...events.map((e) => String(e.message_id))].slice(-200);
        consume();
      } });
      consume();
      if (result?.wait) {
        this.hold(key, events);
      }
    }, { lane }).catch((error) => {
      // Unclaimed work stays durable for HMR; back off real failures rather than spin at max-wait.
      entry.lastAt = entry.startedAt = Date.now() + 5000;
      this.onError(error);
    }).finally(() => { entry.active = []; entry.scheduled = false; this.schedule(key); });
  }
  resumeWaiting(key) {
    const entry = this.entry(key);
    this.pruneWaiting(key);
    const waiting = new Set(entry.events.filter((e) => !e.__inputPassive).flatMap((e) => this.waitingFor(key, e)));
    for (const old of [...waiting].reverse())
      if (!entry.events.some((e) => String(e.message_id) === String(old.message_id)))
        entry.events.unshift({ ...old, __inputId: identity(old) + ':wait:' + Date.now() });
    entry.waiting = entry.waiting.filter((e) => !waiting.has(e));
    entry.waitUntil = Math.max(0, ...entry.waiting.map((e) => e.__waitUntil));
    this.save(key);
  }
  pruneWaiting(key, now = Date.now()) {
    const entry = this.entry(key);
    entry.waiting = entry.waiting.filter((e) => Math.min(e.__waitUntil ?? entry.waitUntil, entry.waitUntil) > now)
      .map((e) => ({ ...e, __waitUntil: e.__waitUntil ?? entry.waitUntil }));
    entry.waitUntil = Math.max(0, ...entry.waiting.map((e) => e.__waitUntil));
  }
  waitingFor(key, event) {
    const entry = this.entry(key);
    const floor = readFloor(this.registry.store, key, this.registry.entry(key));
    const row = floor.messages
      .find((m) => m.messageId === String(event.message_id));
    if (row?.otherTarget) return [];
    return entry.waiting.filter((e) => {
      if (String(e.__waitOwner ?? e.user_id) !== String(event.user_id)) return false;
      const requestIds = e.__waitRequestIds ?? [String(e.message_id)];
      const related = requestIds.includes(String(row?.replyToId ?? '')) ||
        continuesWait.call({ registry: this.registry, key }, event,
          entry.waiting.filter((w) => requestIds.includes(String(w.message_id))));
      return related;
    });
  }
  revisit(key, originals) {
    const entry = this.entry(key);
    if (!originals.some((e) => !entry.claimed.includes(String(e.message_id)))) return;
    for (const event of originals.slice().reverse())
      if (!entry.events.some((e) => identity(e) === identity(event) ||
          event.message_id != null && String(e.message_id) === String(event.message_id)))
        entry.events.unshift({ ...event, __inputId: (event.__inputId ?? event.message_id) + ':revision:' + Date.now() + ':' + Math.random() });
    entry.startedAt ||= Date.now(); entry.lastAt ||= Date.now();
    this.save(key); this.schedule(key);
  }
  hold(key, originals) {
    const entry = this.entry(key);
    this.pruneWaiting(key);
    const policy = captureFloor(this.config, this.registry, key, originals);
    const until = Date.now() + (this.config.floorWaitMs ?? 30000);
    const requestIds = policy.messageIds;
    for (const event of originals)
      if (!entry.waiting.some((e) => String(e.message_id) === String(event.message_id)))
        entry.waiting.push({ ...event, __waitOwner: policy.authors[0] ?? String(event.user_id),
          __waitRequestIds: requestIds, __waitUntil: until });
    entry.waitUntil = Math.max(0, ...entry.waiting.map((e) => e.__waitUntil));
    this.save(key);
    if (entry.events.some((e) => !e.__inputPassive)) { this.resumeWaiting(key); this.schedule(key); }
  }
  restore() {
    const store = this.registry.store;
    if (store?.available) for (const row of store.db.prepare("SELECT key FROM runtime_state WHERE key LIKE 'qq-bridge:input:%'").all())
      this.entry(row.key.slice('qq-bridge:input:'.length));
    for (const key of this.entries.keys()) this.schedule(key);
  }
  dispose() { for (const entry of this.entries.values()) clearTimeout(entry.timer); }
  snapshot() { return [...this.entries].map(([key, e]) => ({ conversation: key, pending: e.events.filter((m) => !m.__inputPassive).length,
    passive: e.events.filter((m) => m.__inputPassive).length, scheduled: e.scheduled, active: e.active.length,
    oldestAt: e.startedAt || null, latestAt: e.lastAt || null,
    dueAt: e.events.some((m) => !m.__inputPassive) ? this.dueAt(e) : null,
    authors: [...new Set(e.events.filter((m) => !m.__inputPassive).map((m) => String(m.user_id)))],
    lastRoute: e.lastRoute, lastDispatch: e.lastDispatch,
    waiting: e.waitUntil > Date.now() ? e.waiting.length : 0 })); }
}
