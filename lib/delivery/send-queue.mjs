/**
 * 出站发送队列：把"按打字节奏发气泡"从 Agent 回合里挪出来。
 *
 * 为什么要挪（高并发下"回复被吞"的根因之一）：
 *
 *   旧路径里 `deliverReplyDetailed` 是**在 `registry.run(key)` 那条串行链上**
 *   逐个气泡 await 的，气泡之间还按字数睡 400~6000ms。于是
 *   「发得慢」直接变成「下一个回合进不来」：
 *   群里连发两条 → 第二条的 turn 排在链上等前一条发完 →
 *   而 turn 自己还挂着 replyTimeoutMs(180s) 的计时。
 *   表现就是用户看到的"桥接发送来不及，它就跑去想下一条了"。
 *
 * 这个队列只有一个目标：**让回合尽早结束**。
 *   - 同一条会话内部**严格保序**（消息顺序不能乱，这是底线）；
 *   - 会话之间互不阻塞、互不拖累（限流按目标算，不是全局一刀切）；
 *   - 谁等够了就先发谁 —— 很吵的群不会把安静的私聊饿死。
 *
 * 它**不负责**幂等、配额、UNKNOWN 判定 —— 那些仍在 `sendOnebotIdempotent` 里。
 * 队列只决定"什么时候调用它"。
 *
 * item 的形状：`{ at, run }`
 *   at  = 允许发送的最早时刻（由 delivery 规划阶段算好，含打字节奏）
 *   run = 真正发送并返回 `{ sent, status, onebotId, held? }` 的函数
 * 没有 `run` 的 item 只是节奏占位，等到 `at` 就跳过。
 */
class ConversationSendQueue {
  constructor({ minIntervalMs = 0, logger = null, batchTimeoutMs = 120000 } = {}) {
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.logger = logger;
    /**
     * 一批发送最多允许占着队列多久（毫秒）。
     *
     * 为什么必须有：2026-10-26 线上，一次 OneBot 请求在 16:43 之后就再没回来，
     * `runBatch` 永远 await 在那里 —— `pumping` 卡在 true、批次已被 shift 出
     * `queues`（所以 `stats()` 报 0 项、看着像队列是空的），而 `journal.sending`
     * 里那条计划一直没删，恢复循环每 5 秒都跳过它，整个群从此一条都发不出去。
     * 只报警不救命，但至少这一行会把"看着空、其实卡死"说出来。
     */
    this.batchTimeoutMs = Math.max(1000, Number(batchTimeoutMs) || 120000);
    /** key → 批次 FIFO。每个 key 各自保序，key 之间独立。 */
    this.queues = new Map();
    /** key → 上一次真正开始发送的时刻（算同一会话的最小间隔）。 */
    this.lastSentAt = new Map();
    /** 轮转顺序：刚发过的会话排到最后，避免一个热群饿死其它会话。 */
    this.order = [];
    this.pumping = false;
    this.disposed = false;
    this.timer = null;
    /** 正在飞的批次（诊断用）：它不在 `queues` 里，只有这里能看到。 */
    this.inFlightKey = null;
    this.inFlightSince = 0;
    this.watchdog = null;
  }

  stats() {
    let batches = 0;
    let items = 0;
    for (const list of this.queues.values()) {
      batches += list.length;
      for (const b of list) items += b.items.length;
    }
    return {
      conversations: this.queues.size, batches, items, lastSentAt: this.lastSentAt.size,
      // 在途批次单独报：它已经从 queues 里挪走，不报的话"卡死"和"空闲"长得一模一样。
      pumping: this.pumping,
      inFlightKey: this.inFlightKey,
      inFlightMs: this.inFlightSince ? Date.now() - this.inFlightSince : 0,
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.timer = null;
    for (const list of this.queues.values())
      for (const batch of list) batch.reject(new Error('发送队列已关闭'));
    this.queues.clear();
    this.order.length = 0;
    this.lastSentAt.clear();
  }

  /** 还有活没干完吗（含正在发的那一批）。 */
  hasWork() {
    if (this.pumping) return true;
    for (const list of this.queues.values()) if (list.length) return true;
    return false;
  }

  /** 队列彻底静下来了吗 —— 挂着的定时器不算，它可能只是空转的收尾闹钟。 */
  idle() {
    return !this.hasWork();
  }

  /**
   * 等队列排空。
   *
   * **生产路径不用它** —— 回合就是不该等发送。只给自检和测试用：
   * 否则"到底发完了没"只能靠 sleep 猜，而猜的时长会被打字节奏打脸。
   *
   * ⚠️ 判据只能是 `hasWork()`，**不能把 `this.timer` 算进去**。
   *    第一版就是那么写的，结果 `flush()` 永远不返回：一批发完之后
   *    `pump()` 在空队列上又排了个 1 秒的收尾闹钟，闹钟醒来发现没活，
   *    **再排一个** —— 定时器永远存在，`idle()` 永远是 false。
   *    表现是测试整套挂死（B06 之后超时）。
   */
  async flush(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.disposed && this.hasWork()) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return !this.disposed;
  }

  /**
   * 排一批发送。**同步返回**，不等真发出去。
   *
   * @param {{ key: string, items: Array<{at?: number, run?: Function}> }} batch
   * @returns {Promise<object>} 这批处理完（含失败）时 resolve。
   */
  enqueue({ key, items }) {
    if (this.disposed) return Promise.reject(new Error('发送队列已关闭'));
    const conversation = String(key);
    const list = this.queues.get(conversation) ?? [];
    return new Promise((resolve, reject) => {
      list.push({
        items: Array.isArray(items) ? items : [],
        resolve,
        reject,
        failed: false,
      });
      this.queues.set(conversation, list);
      if (!this.order.includes(conversation)) this.order.push(conversation);
      queueMicrotask(() => this.pump());
    });
  }

  /**
   * 挑下一条该处理的会话，并算出还要等多久。
   *
   * 三种结果，必须分清楚 —— 混淆它们就会排出空转的定时器：
   *   `{ ready: true, ... }`  现在就能发
   *   `{ ready: false, wait }` 有活，但还差 `wait` 毫秒（要排闹钟）
   *   `{ ready: false, wait: Infinity }` **真没活了**（别排闹钟）
   *
   * 第一版把"没活"和"还没到点"都写成 `wait: Infinity`，于是空队列
   * 每次 pump 都排一个 1 秒闹钟，闹钟醒来又排一个 —— 定时器永续，
   * `flush()` 永远等不到队列静下来，整套测试挂死。
   */
  nextBatch() {
    let soonest = null;
    let soonestAt = Infinity;
    for (let i = 0; i < this.order.length; i++) {
      const key = this.order[i];
      const list = this.queues.get(key);
      if (!list || !list.length) continue;
      const batch = list[0];
      const first = batch.items[0];
      const floor = (this.lastSentAt.get(key) ?? 0) + this.minIntervalMs;
      // 批内第一项可能带着上一批留下的节奏余量；取两者更晚的那个
      const at = Math.max(Number(first?.at) || 0, floor);
      if (at <= Date.now()) {
        // 有会话现在就能发：把它排到队尾，让别的会话也有机会（轮转）
        this.order.splice(i, 1);
        this.order.push(key);
        return { ready: true, key, list, batch };
      }
      // 还没到点：记下来比一比，别让它把别人堵住
      if (at < soonestAt) {
        soonestAt = at;
        soonest = { ready: false, wait: at - Date.now(), key };
      }
    }
    // 有活但全都没到点 → 告诉调用方该等多久；真没活 → Infinity
    return soonest ?? { ready: false, wait: Infinity };
  }

  schedule(wait) {
    if (this.disposed) return;
    // 真没活了就别排闹钟，否则定时器会被无限续上（第一版的挂死就是这么来的）
    if (!this.hasWork()) return;
    const delay = Number.isFinite(wait) ? Math.min(Math.max(1, wait), 3600000) : 1000;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
    this.timer.unref?.();
  }

  pump() {
    if (this.disposed || this.pumping) return;
    const next = this.nextBatch();
    if (!next.ready) return this.schedule(next.wait);
    const batch = next.batch;
    const key = next.key;
    this.pumping = true;
    this.inFlightKey = key;
    this.inFlightSince = Date.now();
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.pumping) return;
      const seconds = Math.round((Date.now() - this.inFlightSince) / 1000);
      this.logger?.warn?.(
        `qq-bridge: 发送批次卡住 —— ${key} 这批已经 ${seconds}s 没结束（${batch.items.length} 项），` +
          '队列从此停摆；一次 OneBot 请求没回来就会这样',
      );
    }, this.batchTimeoutMs);
    this.watchdog.unref?.();
    this.inFlight = this.runBatch(key, batch)
      .catch((error) => {
        this.logger?.warn?.(`qq-bridge: 发送队列异常 —— ${error?.message ?? error}`);
        try {
          batch.reject(error);
        } catch {
          /* 已经 resolve 过就算了 */
        }
      })
      .finally(() => {
        this.pumping = false;
        this.inFlightKey = null;
        this.inFlightSince = 0;
        if (this.watchdog) clearTimeout(this.watchdog);
        this.watchdog = null;
        const cur = this.queues.get(key);
        if (cur && cur[0] === batch) cur.shift();
        if (cur && !cur.length) this.queues.delete(key);
        this.pump();
      });
  }

  /**
   * 跑一整批。批内逐个发，每个 item 等到自己的 `at` 才发 ——
   * 那就是"像人在打字"的节奏，只是现在它睡在队列里，不睡在回合里。
   *
   * 同一会话严格保序：下一批一定等这一批发完才开始。
   */
  async runBatch(key, batch) {
    const results = [];
    const report = { results, sentAny: false, unknown: false, failed: false, startedAt: Date.now() };
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i];
      if (this.disposed) break;
      const wait = (Number(item?.at) || 0) - Date.now();
      if (wait > 0) await sleep(wait);
      if (this.disposed) break;
      if (typeof item?.run !== 'function') continue;
      // 等完节奏之后再判一次：排队期间托管可能被关掉、回合可能被取消，
      // 那时候一个字都不该出去。
      const gate = item.gate ? await item.gate() : false;
      if (gate === true || typeof gate === 'string') {
        report.failed = true;
        report.gated = (report.gated ?? 0) + 1;
        report.stopReason = typeof gate === 'string' ? gate : null;
        break;
      }
      this.lastSentAt.set(key, Date.now());
      let result;
      try {
        result = await item.run();
      } catch (error) {
        result = { sent: false, error: String(error?.message ?? error),
          code: error?.code, retryAt: error?.retryAt,
          status: error?.code === 'QQ_SEND_QUOTA' ? 'SKIPPED' : undefined };
      }
      results.push({ index: i, item, result });
      if (!result?.sent && !(result?.replayed && result.status === 'SUCCEEDED')) {
        report.failed = true;
        if (result?.held) report.unknown = true;
        // 失败就停：后面的气泡不再发，免得半截话出去还说不清
        break;
      }
      report.sentAny = true;
    }
    report.lastSentAt = this.lastSentAt.get(key) ?? report.startedAt;
    if (this.disposed) {
      // 插件重载/关停：这批**没发完**。必须让调用方知道（reject），
      // 否则它会以为"已经发完了，只是都没成功"，从而静默丢消息。
      throw new Error('发送队列已关闭');
    }
    batch.resolve(report);
    return report;
  }
}

/**
 * ⚠️ 这个定时器**绝对不能 unref**。
 *
 * `runBatch` 正 await 着它：一旦 unref，当它是事件循环里唯一的待办时
 * （测试里、以及安静群里的正常情况），Node 会直接判定"没活干了"并让
 * 进程退出/让这个 await 永远悬着 —— 表现就是气泡一股脑全在同一毫秒发出，
 * 打字节奏整个失效。实测：三个 at=0/300/600 的气泡全在 2ms 内发完。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export { ConversationSendQueue };
