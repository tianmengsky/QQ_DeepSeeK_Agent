/**
 * 开机对账：把"桥接没开着那段时间"的群消息补回本地的 `events` 表。
 *
 * 为什么需要它：
 *
 *   `events` 是**桥接收到消息时才写**的。人不在线，群里的话就没有人听见，
 *   第二天日结去读那一天，读到的是空的，判 `too-quiet` —— 那一天就真的没有了。
 *   日结、周反思、语感这三层全部建立在 `events` 上，所以"原料缺一段"比"日记晚写几天"严重得多。
 *
 * 原料从哪来：
 *
 *   SnowLuma 那边自己存着群消息，OneBot 有 `get_group_msg_history`（一次最多 100 条）。
 *   开机时按群拉一遍，把本地缺的补进 `events`，日结就有东西可读了。
 *
 * 几条边界，写死在这里：
 *
 *   1. **只补群**。私聊没有公开的历史接口（`conversation/history.mjs:7` 同一条边界），
 *      私聊的离线期就是空白 —— 这个要认，不能假装补上了。
 *   2. **去重靠上游编号**，和实时路径用同一把钥匙（`onebot:<self_id>:<message_id>`）：
 *      已经实时收过的消息会被唯一索引挡掉，不会写第二遍。
 *   3. `created_at` 用**消息自己的时间**，不是回读的时刻，否则补回来的日子全堆在今天。
 *   4. 一次最多 100 条/群，这是接口上限。群里刷得快的时候，补回来的可能只是最近几小时 ——
 *      所以对账是"尽量捞"，不是"保证完整"，status 里会给出实际补到的条数与最早时间。
 *   5. 失败只记一笔，不上抛：补不上原料不该让插件看起来出错。
 */

import { onebotCall } from '../transport/onebot-client.mjs';
import { contextMessage, qqTime } from '../conversation/context.mjs';

/** 历史消息一次最多拉 100 条，这是 OneBot 的硬上限。 */
export const HISTORY_LIMIT = 100;

export class HistoryReconciler {
  constructor(ctx, config, store, stats) {
    this.ctx = ctx;
    this.config = config;
    this.store = store;
    this.stats = stats ?? {};
    this.running = false;
    /** group:123 → 上次成功对账的时刻（进程内就够：开机那一次最重要）。 */
    this.lastRun = new Map();
    this.selfIdCache = null;
  }

  get enabled() {
    return this.config?.reconcileEnabled !== false;
  }

  get available() {
    return Boolean(this.store?.available && this.config?.contextFromQQHistory !== false);
  }

  /**
   * 她自己的 QQ。
   *
   * 实时路径的 dedupeKey 里带着它（`onebot:<self_id>:<message_id>`），
   * 对账要用同一把钥匙去重，所以得先知道它是谁。
   * 配置里没写就从库里最后一条"她自己发的"消息里捡。
   */
  selfId() {
    const configured = (this.config?.selfIds ?? []).map(String).filter(Boolean);
    if (configured.length) return configured[0];
    if (this.selfIdCache) return this.selfIdCache;
    try {
      const row = this.store.db
        .prepare("SELECT payload FROM events WHERE kind = 'self_message' ORDER BY id DESC LIMIT 1")
        .get();
      const payload = row?.payload ? JSON.parse(row.payload) : null;
      const qq = String(payload?.qq ?? '');
      if (/^\d+$/u.test(qq)) this.selfIdCache = qq;
    } catch { /* 捡不到就算了：去重钥匙退化成不带 self_id 的形态 */ }
    return this.selfIdCache ?? '';
  }

  /**
   * 要对账哪些群。
   *
   * 优先用白名单（那是她真正会说话的地方）；没配白名单时，用最近一周在库里有消息的群。
   */
  groups() {
    const allowed = (this.config?.groups ?? []).map(String).filter(Boolean);
    if (allowed.length) return allowed.map((id) => `group:${id}`);
    try {
      const rows = this.store.db
        .prepare(
          `SELECT DISTINCT conversation FROM events
           WHERE conversation LIKE 'group:%' AND created_at > ?
           ORDER BY conversation`,
        )
        .all(Date.now() - 7 * 86400000);
      return rows.map((r) => String(r.conversation));
    } catch {
      return [];
    }
  }

  /** 拉一个群的最近历史，把库里没有的补进去。 */
  async reconcileGroup(conversation, { signal = null, now = Date.now() } = {}) {
    const groupId = String(conversation).split(':')[1];
    if (!/^\d+$/u.test(String(groupId))) return { inserted: 0, reason: 'bad-group' };
    let list;
    try {
      const data = await onebotCall(
        this.config,
        'get_group_msg_history',
        { group_id: Number(groupId), count: HISTORY_LIMIT },
        Math.max(1000, Number(this.config?.reconcileTimeoutMs) || 5000),
        signal ?? undefined,
      );
      list = data?.messages;
    } catch (error) {
      this.stats.reconcileFailures = (this.stats.reconcileFailures ?? 0) + 1;
      this.ctx?.logger?.warn?.(
        `qq-bridge: 对账回读群 ${groupId} 失败 —— ${error?.name === 'TimeoutError' ? '超时' : (error?.message ?? error)}`,
      );
      return { inserted: 0, reason: 'fetch-failed' };
    }
    if (!Array.isArray(list) || !list.length) return { inserted: 0, reason: 'empty' };

    const selfId = this.selfId();
    let inserted = 0;
    let earliest = 0;
    for (const message of list) {
      const event = {
        self_id: selfId,
        message_id: message?.message_id,
        time: message?.time,
        sender: message?.sender,
        message: message?.message,
      };
      const payload = contextMessage(event);
      if (!payload.text) continue;
      const at = qqTime(message?.time) || Number(payload.at) || 0;
      if (!at) continue;
      const dedupeKey = message?.message_id == null
        ? null
        : `onebot:${selfId}:${message.message_id}`;
      const rec = this.store.recordEvent({
        conversation,
        dedupeKey,
        kind: payload.qq === selfId ? 'self_message' : 'inbound',
        payload,
        deliverable: false,
        createdAt: at,
      });
      if (rec.id) {
        inserted++;
        if (!earliest || at < earliest) earliest = at;
      }
    }
    this.lastRun.set(conversation, now);
    if (inserted) this.store.pruneEvents?.(conversation, this.config?.eventsKeepPerConversation);
    return { inserted, earliest, scanned: list.length };
  }

  /**
   * 跑一轮对账。永不抛出。
   *
   * @returns {Promise<{ran:boolean, inserted:number, groups:number, reason?:string}>}
   */
  async tick({ signal = null, now = Date.now() } = {}) {
    if (!this.enabled) return { ran: false, inserted: 0, groups: 0, reason: 'disabled' };
    if (!this.available) return { ran: false, inserted: 0, groups: 0, reason: 'unavailable' };
    if (this.running) return { ran: false, inserted: 0, groups: 0, reason: 'busy' };
    this.running = true;
    const started = Date.now();
    let inserted = 0;
    let groups = 0;
    try {
      const max = Math.max(1, Number(this.config?.reconcileMaxGroups ?? 8));
      for (const conversation of this.groups().slice(0, max)) {
        if (signal?.aborted) break;
        const result = await this.reconcileGroup(conversation, { signal, now });
        groups++;
        inserted += result.inserted ?? 0;
      }
      this.stats.reconcileRuns = (this.stats.reconcileRuns ?? 0) + 1;
      if (inserted) this.stats.reconcileInserted = (this.stats.reconcileInserted ?? 0) + inserted;
      this.stats.lastReconcile = { at: Date.now(), ms: Date.now() - started, inserted, groups };
      if (inserted) {
        this.ctx?.logger?.info?.(
          `qq-bridge: 开机对账补进 ${inserted} 条历史消息（${groups} 个群）`,
        );
      }
      return { ran: true, inserted, groups };
    } catch (error) {
      this.stats.reconcileFailures = (this.stats.reconcileFailures ?? 0) + 1;
      if (!this.ctx?.disposed) {
        this.ctx?.logger?.warn?.(`qq-bridge: 对账异常 —— ${error?.message ?? error}`);
      }
      return { ran: false, inserted, groups, reason: 'failed' };
    } finally {
      this.running = false;
    }
  }
}
