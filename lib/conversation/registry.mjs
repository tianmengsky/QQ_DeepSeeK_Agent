import { ensureSession } from './sessions.mjs';
import { enqueue } from './queue.mjs';
import { recordContext, trimWindow, validTime } from './context.mjs';
import { sessionSignature } from './sessions.mjs';
import { refreshSpeech } from './activity.mjs';

class ConversationRegistry {
  constructor(ctx, config, store = null) {
    this.ctx = ctx;
    this.config = config;
    /**
     * 持久化层（借鉴 Tulpa）。为 null 时退化成原来的纯内存行为。
     *
     * 它带来三件事：心跳缓冲不再因插件重载凭空消失、
     * 掉线缺口能被如实记录、发送有幂等回执。
     */
    this.store = store;
    this.byKey = new Map();
  }

  entry(key) {
    let entry = this.byKey.get(key);
    if (!entry) {
      let persisted = null;
      if (this.store?.available) {
        try {
          const raw = this.store.getState(`qq-bridge:conversation:${key}`);
          if (raw) persisted = JSON.parse(raw);
        } catch {
          persisted = null;
        }
      }
      entry = {
        sessionId: typeof persisted?.sessionId === 'string' ? persisted.sessionId : undefined,
        turns: Math.max(0, Number(persisted?.turns) || 0),
        chain: Promise.resolve(),
        /** 滑动窗口：[{qq, who, text, bot}] */
        window: [],
        /** 最近说过话的人（最新在前），用于决定注入谁的记忆 */
        recentQqs: [],
        /** 距上次发表情包过了几轮。起始给个大数，好让它能早点用上第一张。 */
        turnsSinceSticker: 99,
        /**
         * 清醒窗口的截止时间戳（0 = 睡着）。
         * 每条成功发出的文字/表情重新计时；纯 [SKIP] 不延长。
         */
        awakeUntil: 0,
        /** 心跳缓冲：群里没被点名、但可能在聊什么的消息。 */
        pending: [],
        /** 该会话最后收到消息的时间，用来判断"群里安静下来了没" */
        lastMessageAt: 0,
        /** 上次主动插话的时间，用来做冷却 */
        lastSpokeAt: 0,
        /** Successful judgment consumes unread and starts a fresh time cycle, without speech. */
        lastHeartbeatCheckAt: Number(persisted?.lastHeartbeatCheckAt) || 0,
        lastAttentionDecision: persisted?.lastAttentionDecision ?? null,
        /**
         * 这个窗口的静态块（人设/规则/表情目录）注入过没有。
         *
         * turns 只统计 Agent 提交次数；staticDone 在 Session 创建/轮换时重置，
         * 在 prompt 成功提交后确认，避免失败重试漏掉静态块。
         */
        staticDone: Boolean(persisted?.staticDone),
        exampleHashes: persisted?.exampleHashes && typeof persisted.exampleHashes === 'object'
          ? persisted.exampleHashes : {},
        sessionSignature: persisted?.sessionSignature,
        contextTurn: Math.max(0, Number(persisted?.contextTurn) || 0),
        contextChars: Math.max(0, Number(persisted?.contextChars) || 0),
        windowHashes: persisted?.windowHashes && typeof persisted.windowHashes === 'object'
          ? persisted.windowHashes : {},
        memoryHash: typeof persisted?.memoryHash === 'string' ? persisted.memoryHash : undefined,
        memoryHashes: persisted?.memoryHashes && typeof persisted.memoryHashes === 'object'
          ? persisted.memoryHashes : {},
        recalledIds: persisted?.recalledIds ?? [],
      };
      entry.window = Array.isArray(persisted?.window) ? persisted.window : [];
      // Correct legacy reload times before applying retention limits.
      if (this.store?.available && this.store.readEvents) {
        const self = new Map(this.store.readEvents(key, { limit: 200, latest: true }).messages
          .filter((m) => m.kind === 'self_message' && m.payload?.messageId != null)
          .map((m) => [String(m.payload.messageId), m]));
        for (const m of entry.window) {
          const event = m.bot && self.get(String(m.messageId));
          if (event && !['qq', 'sent'].includes(m.timeSource)) {
            m.at = validTime(event.payload.at) || validTime(event.createdAt);
            m.timeSource = event.payload.timeSource ?? 'stored';
          }
        }
      }
      trimWindow(this.config, entry);
      entry.recentQqs = [...new Set(entry.window.slice().reverse().filter((m) => !m.bot).map((m) => m.qq))].slice(0, 6);
      this.byKey.set(key, entry);
    }
    refreshSpeech(this.config, entry, this.store, key);
    return entry;
  }

  /** Keep the DSH session cursor across HMR/plugin reloads. */
  persist(key, entry = this.entry(key)) {
    if (!this.store?.available) return false;
    try {
      return this.store.setState(
        `qq-bridge:conversation:${key}`,
        JSON.stringify({
          sessionId: entry.sessionId ?? null,
          turns: Math.max(0, Number(entry.turns) || 0),
          staticDone: Boolean(entry.staticDone),
          exampleHashes: entry.exampleHashes ?? {},
          sessionSignature: entry.sessionSignature ?? sessionSignature(this.config),
          contextTurn: entry.contextTurn ?? 0,
          contextChars: entry.contextChars ?? 0,
          windowHashes: entry.windowHashes ?? {},
          memoryHash: entry.memoryHash ?? null,
          memoryHashes: entry.memoryHashes ?? {},
          lastHeartbeatCheckAt: entry.lastHeartbeatCheckAt || 0,
          lastAttentionDecision: entry.lastAttentionDecision ?? null,
          window: entry.window,
          recalledIds: entry.recalledIds ?? [],
        }),
      );
    } catch {
      return false;
    }
  }

  /** 串行化：同一会话的消息排队处理。 */
  run(key, task, options) {
    return enqueue(this, key, task, options);
  }

  /**
   * 取当前 Session。
   *
   * 每 rotateEveryTurns 轮就换一个全新的 Session —— 这是让上下文保持**恒定**的关键：
   * DSH 侧的历史不再累积，所有上下文（人设 + 记忆 + 滑动窗口）由本插件自己拼。
   */
  async ensureSession(key) {
    return ensureSession(this, key);
  }

  /** 记一轮进滑动窗口与最近参与者列表。 */
  record(entry, message) {
    return recordContext(this.config, entry, message);
  }

  /**
   * 裁剪滑动窗口：**别人的消息**和自己的回复**分别**设上限。
   *
   * 为什么要分开：合成一个总数的话，她话一多就会把自己的回复挤满整个窗口，
   * 别人的话一条都留不下 —— 那正是"看不见上下文"的另一半原因。
   * 用户要的是 10 条别人的 + 最多 15 条自己的。
   */
  trimWindow(entry) {
    trimWindow(this.config, entry);
  }

  /**
   * 把清醒期内攒下的消息一次性并进窗口。
   *
   * 在**每轮开始、拼提示词之前**调用。这样这一轮就能看到"刚才别人接了什么话"，
   * 而当前这条消息仍然等提示词拼完再记（避免重复）。
   */
  flushPendingContext(entry) {
    if (!entry.pendingContext?.length) return 0;
    const n = entry.pendingContext.length;
    for (const m of entry.pendingContext) {
      this.record(entry, { ...m, bot: false });
    }
    entry.pendingContext = [];
    return n;
  }

  /**
   * 戳一戳唤醒时，把"群里刚才聊了什么"补进待注入上下文。
   *
   * ⚠️ 为什么需要它：`pendingContext` 的积累原来只写在
   * `if (!shouldRespond(...))` 那个分支里，而戳一戳归一化后走的是
   * `shouldRespond → true` 那条路 —— **根本不进那个分支**。
   * 结果被戳唤醒时窗口永远是空的，提示词里只剩「（对方戳了你一下）」，
   * 它完全不知道群里刚才在说什么。
   *
   * 上下文来源用**心跳缓冲**：那里本来就存着"没被 @ 的群消息"，
   * 正好就是"刚才群里聊了什么"。搬进 pendingContext 之后清空缓冲，
   * 免得同一批内容在下一轮又被念一遍。
   *
   * @returns 搬了多少条
   */
  seedContextFromBuffer(entry, conversation = null) {
    if (!Array.isArray(entry.pending) || !entry.pending.length) return 0;
    const n = entry.pending.length;
    const ids = entry.pending
      .map((m) => Number(m.eventId))
      .filter((x) => Number.isFinite(x) && x > 0);
    entry.pendingContext ??= [];
    for (const m of entry.pending) {
      entry.pendingContext.push({
        ...m,
        qq: String(m.qq ?? ''),
        who: m.who ?? '',
        text: m.text ?? '',
        images: Array.isArray(m.images) ? m.images : [],
        messageId: m.messageId,
      });
    }
    entry.pending = [];
    /**
     * 消费即 ack。
     *
     * 不 ack 的话，这些事件在库里一直是"未处理"，**每次插件重载都会被
     * restoreConversation 原样捞回缓冲** —— 实测表现就是窗口里反复出现
     * 同一批旧消息（11:10 那 4 条怎么重载都在）。
     */
    if (conversation && this.store?.available && ids.length) {
      try {
        this.store.ackEventIds(String(conversation), ids);
      } catch {
        /* ack 失败不影响本轮上下文 */
      }
    }
    return n;
  }

  /**
   * 把一条"没被点名"的群消息塞进心跳缓冲。
   *
   * 同时也写进事件缓存 —— 这样插件重载、进程重启之后，
   * 缓冲里"还没轮到处理"的消息仍然在，不会凭空消失。
   */
  buffer(
    entry,
    {
      qq,
      who,
      text,
      images = [],
      forwards = [],
      messageId = null,
      conversation = null,
      dedupeKey = null,
      sourceSeq = null,
      at = Date.now(),
      replyToId = null,
      mentions = [],
    },
  ) {
    const item = {
      qq: String(qq ?? ''),
      messageId,
      at, sourceSeq, replyToId, mentions,
      createdAt: Date.now(),
      who: who ?? '',
      text: String(text ?? ''),
      /**
       * 这条带的图片段（只存描述，不存字节）。
       *
       * 存下来的意义：心跳缓冲现在也是"戳一戳唤醒时补上下文"的来源，
       * 不带上 images 的话，从缓冲搬进窗口时图就丢了 ——
       * 对方明确要求看图时会找不到该附哪张。
       */
      images: Array.isArray(images) ? images : [],
      forwards: Array.isArray(forwards) ? forwards : [],
    };
    entry.pending.push(item);
    const cap = Math.max(4, this.config.heartbeatBufferSize);
    if (entry.pending.length > cap) {
      // 原来的做法是静默 splice 掉最旧的。但"丢掉一条群消息"是**信息缺口**，
      // 必须记下来：Tulpa 用 gap_count/gap_note 表达同一件事，
      // 否则下一轮插话时会以为上下文是连续的。
      //
      // 注意要**每次都裁**：只裁一次的话，缓冲会随着持续涌入无限增长。
      const dropped = entry.pending.length - cap;
      entry.pending.splice(0, dropped);
      /**
       * 记的是**这个会话累计丢了多少条**，不是"这一次丢了几条"。
       *
       * 为什么要累计：`noteGap` 用 MAX 语义（防止重复重载把同一个缺口
       * 反复放大）。如果每次只报本次丢弃量（1 条），那连续丢 3 条
       * 就会一直是 1 —— 缺口被低估，模型以为只漏了 1 条。
       * 报累计值则两种情形都对：单次大批丢失记得准，重复重载也不会漂移。
       */
      entry.gapDropped = (entry.gapDropped ?? 0) + dropped;
      this.noteGap(conversation, entry.gapDropped, '心跳缓冲超出上限，最旧的被挤掉');
      this.ctx.logger.warn(
        `qq-bridge: ${conversation ?? '?'} 心跳缓冲超限，丢弃 ${dropped} 条` +
          `（累计 ${entry.gapDropped} 条，已记入 gap）`,
      );
    }
    entry.lastMessageAt = Date.now();

    if (this.store?.available && conversation) {
      const rec = this.store.recordEvent({
        conversation,
        kind: 'group_message',
        sourceSeq,
        dedupeKey,
        payload: item,
        // 缓冲里的是"背景消息"，心跳没接话就不必逐条确认
        deliverable: true,
      });
      /**
       * 记住这条缓冲对应的**事件表 id**。
       *
       * 为什么需要：心跳消费掉这批（无论是插话还是决定不插话）之后，
       * 必须 `ackEvents` 把它们标记成已处理 —— 否则每次插件重载，
       * `restoreConversation` 会把同一批未 ack 的事件again 恢复进缓冲。
       * 实测表现就是：缓冲里永远是 11:10 那 4 条旧消息，看起来"上下文不是最新的"。
       *
       * 只传 dedupeKey 时（`buf:` 前缀那条）不落库，拿不到 id 也没关系。
       */
      if (rec?.id && item) item.eventId = rec.id;
      this.store.upsertConversation(conversation, { lastMessageAt: entry.lastMessageAt });
    }
  }

  /**
   * 把一批缓冲标记为"已处理"。
   *
   * ⚠️ 为什么必须有这个：心跳处理完缓冲（无论决定插话还是决定不插话）
   * 都会 `entry.pending = []`，但**只清内存、没动库**。于是每次插件重载，
   * `restoreConversation` 又把同一批未 ack 的事件捞回缓冲 ——
   * 实测表现：缓冲里永远是 11:10 那 4 条旧消息，怎么重载都不变，
   * 看起来就像"取的不是最新消息"。
   *
   * 事件表里有 id 才 ack；没有 id 的（只走内存的）跳过。
   */
  ackBuffer(entry, conversation) {
    if (!this.store?.available || !conversation) return 0;
    const ids = (entry.pending ?? [])
      .map((m) => Number(m.eventId))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) return 0;
    this.store.ackEventIds(String(conversation), ids);
    return ids.length;
  }

  /** 记一次信息缺口。store 不可用时就只打日志，至少不静默。 */
  noteGap(conversation, count = 1, note = '') {
    if (!conversation) return;
    if (this.store?.available) {
      this.store.recordGap(conversation, count, note);
    }
  }

  /**
   * 启动时把持久化的事件缓存回灌进内存缓冲。
   *
   * 返回恢复了几个会话。恢复过程中**未确认的存量消息一律计入 gap**，
   * 因为插件重载期间它们没有被及时处理 —— 这是事实，不该瞒着模型。
   */
  restoreFromStore() {
    if (!this.store?.available) return 0;
    const conversations = new Set();
    for (const grant of this.store.listGrants())
      for (const conv of grant.conversations) if (conv !== '*') conversations.add(conv);
    for (const row of this.store.db.prepare('SELECT DISTINCT conversation FROM events').all())
      conversations.add(row.conversation);
    let restored = 0;
    for (const conv of conversations) restored += this.restoreConversation(conv);
    return restored;
  }

  restoreConversation(conversation) {
    if (!this.store?.available) return 0;
    const key = String(conversation),
      state = this.store.getConversation(key);
    if (!state) return 0;
    const entry = this.entry(key);
    const cap = Math.max(4, Number(this.config.heartbeatBufferSize) || 20);
    const unacked = this.store.db
      .prepare(
        'SELECT id, payload, created_at FROM events WHERE conversation = ? AND deliverable = 1 AND acked = 0 ORDER BY id DESC LIMIT ?',
      )
      .all(key, cap + 1)
      .reverse();
    const count = Number(
      this.store.db
        .prepare(
          'SELECT COUNT(*) AS n FROM events WHERE conversation = ? AND deliverable = 1 AND acked = 0',
        )
        .get(key).n,
    );
    const excess = Math.max(0, count - cap);
    const skipped = Math.max(0, unacked.length - cap);
    let added = 0;
    for (const m of unacked.slice(skipped)) {
      const p = JSON.parse(m.payload ?? '{}');
      if (entry.pending.some((p) => p.eventId === Number(m.id)) ||
        entry.recalledIds.includes(String(p.messageId))) continue;
      entry.pending.push({
        ...p,
        eventId: Number(m.id),
        createdAt: Number(m.created_at),
        images: p.images ?? [],
      });
      added++;
    }
    entry.pending = entry.pending.slice(-cap);
    for (const m of this.store.readEvents(key, { limit: 200, latest: true }).messages) {
      if (m.kind !== 'self_message' || !m.payload?.text) continue;
      const id = m.payload.messageId ?? 'event:' + m.id;
      if (entry.recalledIds.includes(String(id))) continue;
      const existing = entry.window.find((p) => String(p.messageId) === String(id));
      const at = validTime(m.payload.at) || validTime(m.createdAt);
      if (existing) {
        // Repair timestamps polluted by earlier reloads, even for already persisted bubbles.
        if (!['qq', 'sent'].includes(existing.timeSource)) {
          existing.at = at;
          existing.timeSource = m.payload.timeSource ?? 'stored';
        }
        continue;
      }
      this.record(entry, { ...m.payload, at, timeSource: m.payload.timeSource ?? 'stored',
        bot: true, who: '你', messageId: id });
      if (entry.window.some((p) => String(p.messageId) === String(id))) added++;
    }
    entry.lastMessageAt = state.lastMessageAt || entry.lastMessageAt;
    this.trimWindow(entry);
    if (excess) this.store.setGap(key, excess, '插件重载，缓冲超出上限');
    else if (unacked.length) this.store.clearGap(key);
    this.persist(key, entry);
    return added ? 1 : 0;
  }

  reset(key) {
    this.byKey.delete(key);
    this.store?.setState?.(`qq-bridge:conversation:${key}`, 'null');
  }
}

export { ConversationRegistry };
