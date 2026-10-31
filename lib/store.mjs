/**
 * store.mjs —— 借鉴 Tulpa 的持久化层（幂等回执 / 事件缓存 / 授权配额 / 内容寻址图库）。
 *
 * 为什么需要它：桥接和 qq-mcp 原本都是**纯内存 + 直发**，
 *   · 发送没有幂等记录，重试或断线重连可能重复发言（群聊里的社交事故）；
 *   · 心跳缓冲在插件重载后凭空消失，且没有任何"缺了多少条"的提示；
 *   · 只有群/人白名单，没有能力位与额度，Agent 拿到工具就能无限发；
 *   · 收藏表情每次现拉，没有去重、没有配额、也没有"这张我看过且理解过"的凭据。
 *
 * 这里把 Tulpa 的四套设计落成可复用的表结构：
 *   1. outbox       —— 发送幂等 + 回执状态机（UNKNOWN 绝不自动重发）
 *   2. events       —— 事件缓存与 gap 语义（掉线如实报告缺了多少条）
 *   3. grants/usage —— 三层授权（平台×会话×日期）+ 能力位 + 持久配额
 *   4. stickers     —— 内容寻址图库（SHA256 原件 + LRU + 哈希校验 + 冷却）
 *
 * 只用 node:sqlite（Node 22.5+ 内置），不引入任何第三方依赖。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * node:sqlite 是内置模块，但要用同步 require 拿它 ——
 * Store 的构造必须是同步的，否则每个调用点都得 await，改动面会失控。
 */
const require = createRequire(import.meta.url);
let DatabaseSyncCtor = null;
function loadSqlite() {
  if (!DatabaseSyncCtor) {
    ({ DatabaseSync: DatabaseSyncCtor } = require('node:sqlite'));
  }
  return DatabaseSyncCtor;
}

// ---------------------------------------------------------------- 常量

/** 操作回执的状态。语义抄 Tulpa：UNKNOWN 是"结果未知"，不是失败。 */
export const STATUS = {
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
  SKIPPED: 'SKIPPED',
};

/** 终态：已经有确定结论，重复调用直接返回原回执，不重新执行。 */
const TERMINAL = new Set([STATUS.SUCCEEDED, STATUS.PARTIAL, STATUS.FAILED, STATUS.SKIPPED]);

/** 不能再自动重发的状态。EXECUTING 可能已经在途，UNKNOWN 需要人工核对。 */
const NO_AUTO_RETRY = new Set([STATUS.EXECUTING, STATUS.UNKNOWN]);

/**
 * 哪些错误算"结果未知"。
 *
 * 关键判断：**请求已经发出去、但没拿到确定回执**时，绝不能当作失败去重发 ——
 * 那正是重复发言的来源。超时、连接中断、5xx 都归到这里。
 */
export function classifySendError(error) {
  if (error?.code === 'BILI_SEND_UNKNOWN') return STATUS.UNKNOWN;
  const msg = String(error?.message ?? error ?? '');
  const name = String(error?.name ?? '');
  if (error?.cause && error.cause !== error && classifySendError(error.cause) === STATUS.UNKNOWN)
    return STATUS.UNKNOWN;
  if (name === 'AbortError' || /abort/i.test(name) || /\baborted\b/i.test(msg))
    return STATUS.UNKNOWN;
  if (/timeout|timed out|超时|response unknown/i.test(msg)) return STATUS.UNKNOWN;
  if (/ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network/i.test(msg)) {
    return STATUS.UNKNOWN;
  }
  if (/\b5\d\d\b/.test(msg)) return STATUS.UNKNOWN;
  return STATUS.FAILED;
}

// ---------------------------------------------------------------- 小工具

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 稳定哈希：同一组输入永远得到同一个 key。 */
export function stableKey(...parts) {
  return sha256(parts.map((p) => String(p ?? '')).join('\u0000')).slice(0, 32);
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function nowMs() {
  return Date.now();
}

/** 把时间戳对齐到窗口起点（用于小时/分钟桶计数）。 */
function windowStart(ms, windowMs) {
  return Math.floor(ms / windowMs) * windowMs;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KiB`;
  return `${(v / 1024 / 1024).toFixed(1)}MiB`;
}

// ---------------------------------------------------------------- Store

/**
 * 一个数据目录 = 一个 Store。桥接和 qq-mcp 各自持有一份，互不干扰。
 *
 * 打不开数据库（磁盘满、权限、文件损坏）时**不能让整条链路挂掉**：
 * 退化成"无持久化"模式，回执一律返回 UNKNOWN 并说明原因，宁可保守也不重复发言。
 */
export class Store {
  constructor(dbPath, { logger = null } = {}) {
    this.path = dbPath;
    this.logger = logger;
    this.degraded = false;
    this.degradedReason = '';
    this.db = null;

    try {
      ensureDir(dbPath);
      const DatabaseSync = loadSqlite();
      this.db = new DatabaseSync(dbPath);
      // Bridge and multiple MCP processes open/migrate the same SQLite at startup.
      // Wait for a short writer lock instead of permanently degrading on SQLITE_BUSY.
      this.db.exec('PRAGMA busy_timeout = 2000');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.migrate();
    } catch (error) {
      this.degraded = true;
      this.degradedReason = String(error?.message ?? error);
      this.logger?.warn?.(`store: 持久化不可用，退化为只读保守模式 —— ${this.degradedReason}`);
      try { this.db?.close(); } catch {}
      this.db = null;
    }
  }

  get available() {
    return Boolean(this.db) && !this.degraded;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        idem_key     TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        kind         TEXT NOT NULL,
        target       TEXT NOT NULL,
        payload      TEXT NOT NULL,
        status       TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        onebot_id    TEXT,
        detail       TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_conv ON outbox(conversation, created_at);

      CREATE TABLE IF NOT EXISTS events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL,
        source_seq   INTEGER,
        dedupe_key   TEXT,
        kind         TEXT NOT NULL DEFAULT 'message',
        payload      TEXT NOT NULL,
        deliverable  INTEGER NOT NULL DEFAULT 1,
        acked        INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_conv ON events(conversation, id);
      CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe
        ON events(conversation, dedupe_key) WHERE dedupe_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS conversations (
        conversation  TEXT PRIMARY KEY,
        last_seq      INTEGER NOT NULL DEFAULT 0,
        read_through  INTEGER NOT NULL DEFAULT 0,
        gap_count     INTEGER NOT NULL DEFAULT 0,
        gap_note      TEXT,
        last_message_at INTEGER NOT NULL DEFAULT 0,
        last_spoke_at   INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS grants (
        id           TEXT PRIMARY KEY,
        platform     TEXT NOT NULL DEFAULT 'qq',
        conversations TEXT NOT NULL DEFAULT '[]',
        since        TEXT,
        until        TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]',
        note         TEXT,
        created_at   INTEGER NOT NULL,
        revoked_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS usage (
        bucket   TEXT NOT NULL,
        window   INTEGER NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, window)
      );

      CREATE TABLE IF NOT EXISTS stickers (
        sha256      TEXT PRIMARY KEY,
        bytes       INTEGER NOT NULL,
        mime        TEXT,
        kind        TEXT NOT NULL DEFAULT 'image',
        path        TEXT NOT NULL,
        account     TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        emotion     TEXT NOT NULL DEFAULT '',
        usage_hint  TEXT NOT NULL DEFAULT '',
        avoid       TEXT NOT NULL DEFAULT '',
        uncertainty INTEGER NOT NULL DEFAULT 0,
        notes_scope TEXT NOT NULL DEFAULT '',
        uses        INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL DEFAULT 0,
        collected_at INTEGER NOT NULL DEFAULT 0,
        pinned      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS stickers_lru ON stickers(pinned, last_used_at);
      CREATE INDEX IF NOT EXISTS stickers_scope ON stickers(notes_scope, kind);

      /**
       * 待处理的加好友 / 入群申请。
       *
       * 为什么落库而不是只发一条通知：申请是**桥接**收到的（它才是 OneBot 的
       * 上报端点），而处理申请的工具在 qq-mcp 那个进程里。两个进程必须靠一个
       * 共同的事实来源来交接，否则"转发给你了但谁也点不了同意"。
       */
      CREATE TABLE IF NOT EXISTS pending_requests (
        flag         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        sub_type     TEXT,
        user_id      TEXT,
        group_id     TEXT,
        comment      TEXT,
        nickname     TEXT,
        notified     INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        resolved_at  INTEGER,
        resolution   TEXT,
        PRIMARY KEY (flag, kind)
      );
      CREATE INDEX IF NOT EXISTS pending_open ON pending_requests(resolved_at, created_at);

      /**
       * 需要人工审批的写操作（目前只有"踢人"）。
       *
       * 为什么不复用 pending_requests：那张表语义是"别人发来的申请"，
       * 这张是"我方 Agent 想做的动作"。混在一起会让 qq_list_add_requests
       * 把"我想踢人"显示成"有人想加群"，很误导。
       *
       * 为什么踢人要审批而禁言不用：禁言可逆（解禁就行），踢人不可逆 ——
       * 人被踢出去，哪怕马上拉回来，体验也已经毁了。
       */
      CREATE TABLE IF NOT EXISTS pending_actions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        group_id     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        reason       TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   INTEGER NOT NULL,
        resolved_at  INTEGER,
        resolution   TEXT,
        detail       TEXT
      );
      CREATE INDEX IF NOT EXISTS pending_actions_open
        ON pending_actions(status, created_at);

      /**
       * 主动开口的账（宿主）—— 谁、什么时候、说了什么、有没有人接。
       *
       * 为什么要落库而不是只在内存里数：
       *   · "她对这个人/这个群还有没有兴趣"必须活过重载，否则每次 HMR 都像第一次开口；
       *   · 频率学习靠的是**历史回应率**，内存里那几条撑不起 6~8 次的窗口；
       *   · 迟到的呼应（15 分钟后才有人接）要能在下一 tick 补记，
       *     所以记录先写 checked_at=0，由检查队列补 outcome。
       */
      CREATE TABLE IF NOT EXISTS proactive (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'speak',
        trigger      TEXT NOT NULL DEFAULT '',
        text         TEXT NOT NULL DEFAULT '',
        ref          TEXT NOT NULL DEFAULT '',
        idem_key     TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'sent',
        outcome      TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        checked_at   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS proactive_conv ON proactive(conversation, created_at);
      CREATE INDEX IF NOT EXISTS proactive_check ON proactive(checked_at, created_at);

      -- 运行时状态（键值）。存在的理由：托管开关是运行时的，但必须活过插件重载。
      -- 踩过的坑：agentEnabled 在 profile 里是 false，运行时用 HTTP
      -- /qq/onebot/control 打开只写内存；插件每次重载（改代码、HMR 触发）
      -- 都重新读 profile 的 false，于是托管又关上了 ——
      -- 表现就是"群里明明很多人说话，它却完全没反应，上下文里也没有"，
      -- 因为托管关着时消息在准入判断之前就被丢掉了。
      CREATE TABLE IF NOT EXISTS runtime_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  // -------------------------------------------------------------- outbox

  /**
   * 取回执；不存在返回 null。
   * payload 不同的复用会被调用方拒绝（同一幂等编号只能对应同一份内容）。
   */
  getReceipt(idemKey) {
    if (!this.available) return null;
    const row = this.db.prepare('SELECT * FROM outbox WHERE idem_key = ?').get(String(idemKey));
    return row ? normalizeReceipt(row) : null;
  }

  /**
   * 登记一次发送并**判定该不该真的发**。
   *
   * 返回值 { action, receipt }：
   *   'send'   —— 可以发，已占位为 EXECUTING
   *   'replay' —— 已有终态回执，直接返回，不重新执行
   *   'hold'   —— EXECUTING/UNKNOWN，**不许自动重发**，交给调用方决定
   *   'conflict' —— 同一幂等编号配了不同内容，拒绝
   */
  reserveSend(args, quotas = []) {
    if (!this.available) return this.beginSend(args);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.beginSend(args);
      if (result.action === 'send') {
        for (const { bucket, windowMs, limit, label = bucket } of quotas) {
          const quota = this.consume(bucket, windowMs, limit);
          if (!quota.allowed) {
            const error = new Error('发送配额已满：' + label + '（已用 ' + quota.used + '/' + limit + '）');
            error.code = 'QQ_SEND_QUOTA';
            error.retryAt = Date.now() + quota.resetInMs;
            throw error;
          }
        }
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  beginSend({ idemKey, conversation, kind, target, payload }) {
    const key = String(idemKey);
    const body = JSON.stringify(payload ?? null);

    if (!this.available) {
      return { action: 'send', receipt: null, degraded: true };
    }

    const existing = this.getReceipt(key);
    if (existing) {
      if (existing.payload !== body) {
        return { action: 'conflict', receipt: existing };
      }
      // 终态里 FAILED 是唯一可以重试的：它表示"确定没发出去"。
      // SUCCEEDED / PARTIAL / SKIPPED 已经有确定结果，重放即可。
      if (TERMINAL.has(existing.status) && existing.status !== STATUS.FAILED) {
        return { action: 'replay', receipt: existing };
      }
      // EXECUTING 可能还在途，UNKNOWN 需要人工核对 —— 都不许自动重发
      if (NO_AUTO_RETRY.has(existing.status)) return { action: 'hold', receipt: existing };
    }

    const ts = nowMs();
    this.db
      .prepare(
        `INSERT INTO outbox (idem_key, conversation, kind, target, payload, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(idem_key) DO UPDATE SET
           status = excluded.status,
           attempts = outbox.attempts + 1,
           updated_at = excluded.updated_at`,
      )
      .run(key, String(conversation), String(kind), String(target), body, STATUS.EXECUTING, ts, ts);

    return { action: 'send', receipt: this.getReceipt(key) };
  }

  /** 落终态回执。写不进去时返回 false，让调用方知道回执没保住。 */
  finishSend(idemKey, status, { onebotId = null, detail = '' } = {}) {
    if (!this.available) return false;
    try {
      this.db
        .prepare(
          `UPDATE outbox SET status = ?, onebot_id = ?, detail = ?, updated_at = ?
           WHERE idem_key = ?`,
        )
        .run(
          String(status),
          onebotId === null ? null : String(onebotId),
          String(detail).slice(0, 500),
          nowMs(),
          String(idemKey),
        );
      return true;
    } catch (error) {
      this.logger?.warn?.(`store: 写回执失败 (${idemKey}) —— ${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 找出所有"结果未知"的操作。UNKNOWN 不自动重发，
   * 但它必须**看得见** —— 否则就成了静默丢失。
   */
  listUnknown(conversation = null, limit = 50) {
    if (!this.available) return [];
    const rows = conversation
      ? this.db
          .prepare(
            `SELECT * FROM outbox WHERE status IN (?, ?) AND conversation = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(STATUS.UNKNOWN, STATUS.EXECUTING, String(conversation), limit)
      : this.db
          .prepare(`SELECT * FROM outbox WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT ?`)
          .all(STATUS.UNKNOWN, STATUS.EXECUTING, limit);
    return rows.map(normalizeReceipt);
  }

  countByStatus() {
    if (!this.available) return {};
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status').all();
    const out = {};
    for (const row of rows) out[row.status] = Number(row.n);
    return out;
  }

  recentReceipts(conversation, limit = 10) {
    if (!this.available) return [];
    return this.db
      .prepare('SELECT * FROM outbox WHERE conversation = ? ORDER BY created_at DESC LIMIT ?')
      .all(String(conversation), limit)
      .map(normalizeReceipt);
  }

  // -------------------------------------------------------------- events

  /**
   * 记一条事件进缓存。
   *
   * dedupeKey 非空时重复上报会被忽略（OneBot 重推、HTTP 重试都会导致重复）。
   * 返回 { id, duplicate }。
   */
  recordEvent({
    conversation,
    sourceSeq = null,
    dedupeKey = null,
    kind = 'message',
    payload,
    deliverable = true,
    // 补账用：历史消息的 created_at 必须是**它自己发生的时间**，不是回读的时刻。
    // 否则补回来的 10-27 会全堆在"今天"，日结按天切分时又是一片空白。
    createdAt = null,
  }) {
    if (!this.available) return { id: null, duplicate: false };
    const ts = Number(createdAt) > 0 ? Number(createdAt) : nowMs();
    const conv = String(conversation);
    try {
      const res = this.db
        .prepare(
          `INSERT INTO events (conversation, source_seq, dedupe_key, kind, payload, deliverable, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conv,
          sourceSeq === null ? null : Number(sourceSeq),
          dedupeKey === null ? null : String(dedupeKey),
          String(kind),
          JSON.stringify(payload ?? null),
          deliverable ? 1 : 0,
          ts,
        );
      this.upsertConversation(conv, {
        lastMessageAt: ts,
        // 上游编号（OneBot message_id / 事件序号）单独留一份，
        // 不能和缓存序号混为一谈：缓存序号会被淘汰，上游编号不会。
        ...(sourceSeq === null ? {} : { lastSeq: Number(sourceSeq) }),
      });
      return { id: Number(res.lastInsertRowid), duplicate: false };
    } catch (error) {
      // 唯一索引冲突 = 重复上报，按 Tulpa 的做法静默去重，不当错误
      if (/UNIQUE|constraint/i.test(String(error?.message ?? error))) {
        return { id: null, duplicate: true };
      }
      this.logger?.warn?.(`store: 记事件失败 —— ${error?.message ?? error}`);
      return { id: null, duplicate: false };
    }
  }

  upsertConversation(conv, patch = {}) {
    if (!this.available) return;
    const key = String(conv);
    const ts = nowMs();
    this.db
      .prepare('INSERT OR IGNORE INTO conversations (conversation, updated_at) VALUES (?, ?)')
      .run(key, ts);
    const sets = [];
    const args = [];
    if (patch.lastSeq !== undefined) {
      sets.push('last_seq = MAX(last_seq, ?)');
      args.push(Number(patch.lastSeq) || 0);
    }
    if (patch.readThrough !== undefined) {
      sets.push('read_through = MAX(read_through, ?)');
      args.push(Number(patch.readThrough) || 0);
    }
    if (patch.lastMessageAt !== undefined) {
      // 单调不回退：补账会把更早的消息写进来，不能因此把"最后消息"改早。
      sets.push('last_message_at = MAX(last_message_at, ?)');
      args.push(Number(patch.lastMessageAt) || 0);
    }
    if (patch.lastSpokeAt !== undefined) {
      sets.push('last_spoke_at = ?');
      args.push(Number(patch.lastSpokeAt) || 0);
    }
    sets.push('updated_at = ?');
    args.push(ts);
    args.push(key);
    this.db
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE conversation = ?`)
      .run(...args);
  }

  /**
   * 报告"**真丢了** N 条"（累加）。
   *
   * 用于**缓冲被上限挤掉**这类真正的丢失：丢了就得算上，累加是对的。
   *
   * ⚠️ 为什么用 `MAX(gap_count, ?)` 而不是 `gap_count + ?`：
   * 调用方（`buffer()`）传进来的已经是**累计丢弃量**，所以取较大值
   * 既能把"累计 3 条"记对，又不会在重复调用/重复重载时重复放大。
   * 早期用无条件 `+`，实测把 4 条缓冲累成了 `gap_count = 264`。
   */
  recordGap(conv, count = 1, note = '') {
    if (!this.available) return;
    const key = String(conv);
    const ts = nowMs();
    const n = Math.max(0, Number(count) || 0);
    this.db
      .prepare('INSERT OR IGNORE INTO conversations (conversation, updated_at) VALUES (?, ?)')
      .run(key, ts);
    this.db
      .prepare(
        `UPDATE conversations
         SET gap_count = MAX(gap_count, ?), gap_note = ?, updated_at = ?
         WHERE conversation = ?`,
      )
      .run(n, n > 0 ? String(note).slice(0, 300) : null, ts, key);
  }

  /**
   * **直接设置**缺口（覆盖），用于"重算一遍，这就是此刻的真相"。
   *
   * 传 0 就等于清零 —— 这是**唯一能消掉缺口**的入口，
   * 而"消息已经恢复进缓冲了"就该清（因为没丢东西）。
   */
  setGap(conv, count = 0, note = '') {
    if (!this.available) return;
    const key = String(conv);
    const ts = nowMs();
    const n = Math.max(0, Number(count) || 0);
    this.db
      .prepare('INSERT OR IGNORE INTO conversations (conversation, updated_at) VALUES (?, ?)')
      .run(key, ts);
    this.db
      .prepare(
        `UPDATE conversations
         SET gap_count = ?, gap_note = ?, updated_at = ?
         WHERE conversation = ?`,
      )
      .run(n, n > 0 ? String(note).slice(0, 300) : null, ts, key);
  }

  getConversation(conv) {
    if (!this.available) return null;
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE conversation = ?')
      .get(String(conv));
    if (!row) return null;
    return {
      conversation: row.conversation,
      lastSeq: Number(row.last_seq) || 0,
      readThrough: Number(row.read_through) || 0,
      gapCount: Number(row.gap_count) || 0,
      gapNote: row.gap_note ?? '',
      lastMessageAt: Number(row.last_message_at) || 0,
      lastSpokeAt: Number(row.last_spoke_at) || 0,
    };
  }

  /** 一次 gap 被如实告知之后清零，避免每轮都重复念叨同一件事。 */
  clearGap(conv) {
    if (!this.available) return;
    this.db
      .prepare(
        'UPDATE conversations SET gap_count = 0, gap_note = NULL, updated_at = ? WHERE conversation = ?',
      )
      .run(nowMs(), String(conv));
  }

  /**
   * 读未确认的事件页，并取出"处理到哪了"的游标。
   *
   * 沿用 Tulpa 的 read_through_id / acknowledge_through_id 协议：
   * 返回的 id 是**独立缓存序号**；调用方处理完后显式确认，
   * 不确认就能重读。source_seq 才是上游（OneBot）的编号。
   */
  /**
   * 读事件缓存。
   *
   * @param {object} [options]
   * @param {number} [options.limit] 最多取几条
   * @param {number|null} [options.afterId] 从哪个 id 之后开始（游标语义）
   * @param {boolean} [options.latest]
   *   `true` = 取**最近**的 N 条（内部倒序取再正序返回）。
   *
   *   ⚠️ 为什么必须有这个开关：默认那条路径是"从 `readThrough` 往后读"，
   *   取的是**最旧**的 N 条。而生产代码里 `ackEvents` **从未被调用**，
   *   于是 `readThrough` 一直是 0 —— 缓冲里有 1000 条时，它取回来的是
   *   **最早的 4 条**，而不是最近的 4 条。
   *   表现就是：戳一戳唤醒后提示词里的"最近聊了什么"全是**很早以前**的话，
   *   完全不是刚才在聊的内容。
   *
   *   游标语义本身是对的（不 ack 就不丢消息），所以保留默认行为不变，
   *   只给"恢复心跳缓冲"这种**明确要最近消息**的场合用 latest。
   */
  readEvents(conv, { limit = 50, afterId = null, latest = false } = {}) {
    if (!this.available) return { messages: [], readThroughId: 0, sourceSeq: 0 };
    const key = String(conv);
    const state = this.getConversation(key);
    const cap = Math.max(1, Math.min(200, Number(limit) || 50));

    let rows;
    let from;
    if (latest) {
      from = 0;
      rows = this.db
        .prepare(
          `SELECT * FROM events WHERE conversation = ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(key, cap);
      // 倒序取回来的是"从新到旧"，翻回"从旧到新"再交给调用方 ——
      // 窗口是按时间顺序累积的，顺序反了会导致上下文读起来是倒着的。
      rows.reverse();
    } else {
      from = afterId === null ? (state?.readThrough ?? 0) : Number(afterId) || 0;
      rows = this.db
        .prepare(
          `SELECT * FROM events WHERE conversation = ? AND id > ?
           ORDER BY id ASC LIMIT ?`,
        )
        .all(key, from, cap);
    }

    const messages = rows.map((row) => ({
      id: Number(row.id),
      conversation: row.conversation,
      sourceSeq: row.source_seq === null ? null : Number(row.source_seq),
      kind: row.kind,
      deliverable: Boolean(row.deliverable),
      payload: safeParse(row.payload),
      createdAt: Number(row.created_at),
      acked: Boolean(row.acked),
    }));
    return {
      messages,
      readThroughId: messages.length ? messages[messages.length - 1].id : from,
      sourceSeq: state?.lastSeq ?? 0,
    };
  }

  /** 确认处理到某个缓存序号。未确认的消息仍会被重读（不丢）。 */
  ackEventIds(conv, ids) {
    if (!this.available) return;
    const statement = this.db.prepare(
      'UPDATE events SET acked = 1 WHERE conversation = ? AND id = ?',
    );
    for (const id of new Set(ids)) statement.run(String(conv), Number(id));
  }

  ackEvents(conv, throughId) {
    if (!this.available) return;
    const key = String(conv);
    const id = Number(throughId) || 0;
    this.db.prepare('UPDATE events SET acked = 1 WHERE conversation = ? AND id <= ?').run(key, id);
    this.upsertConversation(key, { readThrough: id });
  }

  /** 缓存淘汰：每个会话最多保留 N 条，旧的先走。 */
  pruneEvents(conv, keep = 1000) {
    if (!this.available) return 0;
    const key = String(conv);
    const max = Math.max(10, Number(keep) || 1000);
    const res = this.db
      .prepare(
        `DELETE FROM events WHERE conversation = ? AND id <= (
           SELECT id FROM events WHERE conversation = ? ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
      )
      .run(key, key, max);
    return Number(res.changes) || 0;
  }

  eventCount(conv) {
    if (!this.available) return 0;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE conversation = ?')
      .get(String(conv));
    return Number(row?.n) || 0;
  }

  // -------------------------------------------------------------- grants

  /**
   * 登记一份授权：平台 × 会话 × 日期 × 能力位。
   *
   * 和 Tulpa 一样，"没勾选"不等于"全部"——conversations 为空表示**没有**任何会话，
   * 要全部会话必须显式写 ['*']。
   */
  createGrant({
    id,
    platform = 'qq',
    conversations = [],
    since = null,
    until = null,
    capabilities = [],
    note = '',
  }) {
    if (!this.available) return null;
    const gid = String(id);
    this.db
      .prepare(
        `INSERT INTO grants (id, platform, conversations, since, until, capabilities, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           platform = excluded.platform,
           conversations = excluded.conversations,
           since = excluded.since,
           until = excluded.until,
           capabilities = excluded.capabilities,
           note = excluded.note,
           revoked_at = NULL`,
      )
      .run(
        gid,
        String(platform),
        JSON.stringify(conversations.map(String)),
        since === null ? null : String(since),
        until === null ? null : String(until),
        JSON.stringify(capabilities.map(String)),
        String(note),
        nowMs(),
      );
    return this.getGrant(gid);
  }

  getGrant(id) {
    if (!this.available) return null;
    const row = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      platform: row.platform,
      conversations: safeParse(row.conversations) ?? [],
      since: row.since ?? null,
      until: row.until ?? null,
      capabilities: safeParse(row.capabilities) ?? [],
      note: row.note ?? '',
      revoked: row.revoked_at !== null,
    };
  }

  revokeGrant(id) {
    if (!this.available) return false;
    const res = this.db
      .prepare('UPDATE grants SET revoked_at = ? WHERE id = ?')
      .run(nowMs(), String(id));
    return (Number(res.changes) || 0) > 0;
  }

  listGrants() {
    if (!this.available) return [];
    return this.db
      .prepare('SELECT id FROM grants WHERE revoked_at IS NULL ORDER BY created_at')
      .all()
      .map((row) => this.getGrant(row.id));
  }

  /**
   * 判定一次调用是否被允许。
   *
   * 返回 { allowed, why }。任何一项不满足都拒绝，并把原因说清楚 ——
   * Tulpa 的经验是"配置成功 ≠ 数据可读"，含糊的拒绝会让人排查半天。
   */
  checkGrant(grant, { capability, conversation = null, at = null }) {
    if (!grant || grant.revoked) return { allowed: false, why: '授权不存在或已撤销' };
    if (capability && !grant.capabilities.includes(capability)) {
      return { allowed: false, why: `该连接没有「${capability}」权限` };
    }
    if (conversation !== null) {
      const list = grant.conversations ?? [];
      if (!list.length) return { allowed: false, why: '该授权没有选择任何会话' };
      if (!list.includes('*') && !list.includes(String(conversation))) {
        return { allowed: false, why: `会话 ${conversation} 不在授权范围内` };
      }
    }
    const ts = at === null ? nowMs() : new Date(at).getTime();
    if (grant.since && ts < new Date(grant.since).getTime()) {
      return { allowed: false, why: `早于授权起始日期 ${grant.since}` };
    }
    if (grant.until && ts > new Date(grant.until).getTime()) {
      return { allowed: false, why: `晚于授权截止日期 ${grant.until}` };
    }
    return { allowed: true, why: '' };
  }

  // -------------------------------------------------------------- 申请收件箱

  /**
   * 记一条加好友 / 入群申请。
   *
   * 同一个 flag 重复上报只留一条（OneBot 可能重推），但**不覆盖已决议的记录** ——
   * 否则"已经处理过"这件事会被后来的重推抹掉，人就会重复看到同一条申请。
   */
  recordRequest({
    flag,
    kind,
    subType = '',
    userId = '',
    groupId = '',
    comment = '',
    nickname = '',
  }) {
    if (!this.available) return { stored: false, duplicate: false };
    const key = String(flag);
    const k = String(kind);
    const existing = this.db
      .prepare('SELECT resolved_at FROM pending_requests WHERE flag = ? AND kind = ?')
      .get(key, k);
    if (existing) {
      return { stored: false, duplicate: true, resolved: existing.resolved_at !== null };
    }
    this.db
      .prepare(
        `INSERT INTO pending_requests
           (flag, kind, sub_type, user_id, group_id, comment, nickname, notified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        key,
        k,
        String(subType),
        String(userId),
        String(groupId),
        String(comment).slice(0, 500),
        String(nickname),
        nowMs(),
      );
    return { stored: true, duplicate: false };
  }

  /** 还没处理的申请，最近的在前。 */
  listOpenRequests(kind = null, limit = 20) {
    if (!this.available) return [];
    const rows = kind
      ? this.db
          .prepare(
            `SELECT * FROM pending_requests WHERE resolved_at IS NULL AND kind = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(String(kind), limit)
      : this.db
          .prepare(
            `SELECT * FROM pending_requests WHERE resolved_at IS NULL
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit);
    return rows.map(normalizeRequest);
  }

  getRequest(flag, kind) {
    if (!this.available) return null;
    const row = this.db
      .prepare('SELECT * FROM pending_requests WHERE flag = ? AND kind = ?')
      .get(String(flag), String(kind));
    return row ? normalizeRequest(row) : null;
  }

  /** 标记已通知过，避免每次重推都再吵你一遍。 */
  markRequestNotified(flag, kind) {
    if (!this.available) return;
    this.db
      .prepare('UPDATE pending_requests SET notified = 1 WHERE flag = ? AND kind = ?')
      .run(String(flag), String(kind));
  }

  /** 记决议结果。返回 false 表示这条申请不存在。 */
  resolveRequest(flag, kind, resolution) {
    if (!this.available) return false;
    const res = this.db
      .prepare(
        `UPDATE pending_requests SET resolved_at = ?, resolution = ?
         WHERE flag = ? AND kind = ? AND resolved_at IS NULL`,
      )
      .run(nowMs(), String(resolution), String(flag), String(kind));
    return (Number(res.changes) || 0) > 0;
  }

  // -------------------------------------------------------------- 运行时状态

  /** 读一个运行时状态值；不存在返回 null。 */
  getState(key) {
    if (!this.available) return null;
    try {
      const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(String(key));
      return row ? String(row.value) : null;
    } catch {
      return null;
    }
  }

  /** 写一个运行时状态值（覆盖）。 */
  setState(key, value) {
    if (!this.available) return false;
    try {
      this.db
        .prepare(
          `INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(key), String(value), nowMs());
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------- 主动开口的账

  /** 记一条"她主动说了话"。返回 id；库不可用时返回 null。 */
  recordProactive({ conversation, kind = 'speak', trigger = '', text = '', ref = '', idemKey = '', status = 'sent' }) {
    if (!this.available) return null;
    try {
      const res = this.db
        .prepare(
          `INSERT INTO proactive (conversation, kind, trigger, text, ref, idem_key, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          String(conversation),
          String(kind),
          String(trigger).slice(0, 40),
          String(text).slice(0, 2000),
          String(ref).slice(0, 200),
          String(idemKey),
          String(status),
          nowMs(),
        );
      return Number(res.lastInsertRowid);
    } catch (error) {
      this.logger?.warn?.(`store: 记主动发言失败 —— ${error?.message ?? error}`);
      return null;
    }
  }

  /** 标记这条主动发言已结算（replied / quiet / unknown）。 */
  finishProactiveCheck(id, outcome = 'quiet') {
    if (!this.available) return false;
    try {
      const res = this.db
        .prepare("UPDATE proactive SET outcome = ?, checked_at = ? WHERE id = ? AND checked_at = 0")
        .run(String(outcome), nowMs(), Number(id));
      return (Number(res.changes) || 0) > 0;
    } catch {
      return false;
    }
  }

  /** 到点该结算的主动发言（created_at + 观察窗 <= before）。 */
  pendingProactiveChecks({ before, limit = 20 }) {
    if (!this.available) return [];
    try {
      return this.db
        .prepare(
          `SELECT * FROM proactive
           WHERE checked_at = 0 AND status = 'sent' AND created_at <= ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(Number(before), Number(limit));
    } catch {
      return [];
    }
  }

  /**
   * 某个会话最近的主动发言（新→旧），用来算"她在这里还该不该主动"。
   * 只看 status='sent' 的：被拦下/失败的没发出去，不该算进"人家不理她"。
   */
  proactiveHistory(conversation, { limit = 8, since = 0 } = {}) {
    if (!this.available) return [];
    try {
      return this.db
        .prepare(
          `SELECT * FROM proactive
           WHERE conversation = ? AND status = 'sent' AND created_at >= ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(String(conversation), Number(since), Number(limit));
    } catch {
      return [];
    }
  }

  /** 全局最近若干条（状态页 / 每日预算用）。 */
  proactiveRecent({ limit = 50, since = 0 } = {}) {
    if (!this.available) return [];
    try {
      return this.db
        .prepare(`SELECT * FROM proactive WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`)
        .all(Number(since), Number(limit));
    } catch {
      return [];
    }
  }

  /**
   * 最近活跃过的会话（主动层挑候选用）。
   *
   * 只按 `last_message_at` 倒序：主动开口的候选是"安静了很久的窗口"，
   * 安静时长由调用方用 `last_message_at` 现算，这里不预判。
   */
  listConversations({ since = 0, limit = 40 } = {}) {
    if (!this.available) return [];
    try {
      return this.db
        .prepare(
          `SELECT conversation, last_message_at, last_spoke_at FROM conversations
           WHERE last_message_at >= ?
           ORDER BY last_message_at DESC
           LIMIT ?`,
        )
        .all(Number(since), Math.max(1, Number(limit) || 40));
    } catch {
      return [];
    }
  }

  /**
   * 这段时间里以"她自己"的身份发出去的消息条数。
   *
   * 脊柱回合没有投递对象（她人在"外面"），所以判断"她这一轮开口了没有"不能看
   * 回合正文，只能看那句 `qq_windows say` 有没有落地——落地的证据就是
   * `self_message` 事件。收尾、心跳都不写这个 kind，不会串味。
   */
  countSelfMessages({ since = 0 } = {}) {
    if (!this.available) return 0;
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'self_message' AND created_at >= ?`)
        .get(Number(since));
      return Number(row?.n) || 0;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------- 待审批动作

  /**
   * 登记一个需要人工审批的写操作（目前只有 kick）。
   *
   * 去重规则：同一个 (kind, group_id, user_id) 已经有 pending 的，
   * 就不再新建一条 —— 否则模型反复请求会刷出一堆重复待办。
   */
  requestAction({ kind, groupId, userId, reason = '', requestedBy = '' }) {
    if (!this.available) return { created: false, duplicate: false, id: null };
    const k = String(kind);
    const g = String(groupId);
    const u = String(userId);
    const existing = this.db
      .prepare(
        `SELECT id FROM pending_actions
         WHERE kind = ? AND group_id = ? AND user_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(k, g, u);
    if (existing) return { created: false, duplicate: true, id: Number(existing.id) };

    const res = this.db
      .prepare(
        `INSERT INTO pending_actions (kind, group_id, user_id, reason, requested_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(k, g, u, String(reason).slice(0, 300), String(requestedBy), nowMs());
    return { created: true, duplicate: false, id: Number(res.lastInsertRowid) };
  }

  listPendingActions(limit = 20) {
    if (!this.available) return [];
    return this.db
      .prepare(
        `SELECT * FROM pending_actions WHERE status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(Math.max(1, limit))
      .map(normalizePendingAction);
  }

  getPendingAction(id) {
    if (!this.available) return null;
    const row = this.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(Number(id));
    return row ? normalizePendingAction(row) : null;
  }

  /** 决议一个待审批动作。返回 false 表示它不存在或已经决议过了。 */
  resolveAction(id, resolution, detail = '') {
    if (!this.available) return false;
    const res = this.db
      .prepare(
        `UPDATE pending_actions SET status = ?, resolved_at = ?, resolution = ?, detail = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run('resolved', nowMs(), String(resolution), String(detail).slice(0, 500), Number(id));
    return (Number(res.changes) || 0) > 0;
  }

  // -------------------------------------------------------------- usage


  /**
   * 持久配额。Tulpa 的关键细节：**限额持久保存，重连不会重置**，
   * 失败尝试也计入。所以计数必须落盘，不能只放内存。
   *
   * 返回 { allowed, used, limit, resetInMs }。
   */
  consume(bucket, windowMs, limit, { now = nowMs(), cost = 1 } = {}) {
    if (!limit || limit <= 0) return { allowed: true, used: 0, limit: 0, resetInMs: 0 };
    const key = String(bucket) + ':' + windowMs;
    const win = windowStart(now, windowMs);
    if (!this.available) {
      // 拿不到持久层就**保守放行**，但明说计数没有生效
      return { allowed: true, used: 0, limit, resetInMs: 0, degraded: true };
    }
    const row = this.db
      .prepare('SELECT count FROM usage WHERE bucket = ? AND window = ?')
      .get(key, win);
    const legacy = this.db
      .prepare('SELECT count FROM usage WHERE bucket = ? AND window = ?')
      .get(String(bucket), win);
    const used = Math.max(Number(row?.count) || 0, Number(legacy?.count) || 0);
    if (used + cost > limit) {
      return {
        allowed: false,
        used,
        limit,
        resetInMs: Math.max(0, win + windowMs - now),
      };
    }
    this.db
      .prepare(
        `INSERT INTO usage (bucket, window, count) VALUES (?, ?, ?)
         ON CONFLICT(bucket, window) DO UPDATE SET count = excluded.count`,
      )
      .run(key, win, used + cost);
    return {
      allowed: true,
      used: used + cost,
      limit,
      resetInMs: Math.max(0, win + windowMs - now),
    };
  }

  usageOf(bucket, windowMs, { now = nowMs() } = {}) {
    if (!this.available) return 0;
    const row = this.db
      .prepare('SELECT count FROM usage WHERE bucket = ? AND window = ?')
      .get(String(bucket) + ':' + windowMs, windowStart(now, windowMs));
    const legacy = this.db
      .prepare('SELECT count FROM usage WHERE bucket = ? AND window = ?')
      .get(String(bucket), windowStart(now, windowMs));
    return Math.max(Number(row?.count) || 0, Number(legacy?.count) || 0);
  }

  /** 清掉过期窗口，免得 usage 表无限长。 */
  pruneUsage(keepWindows = 24) {
    if (!this.available) return 0;
    const cutoff = nowMs() - Math.max(1, keepWindows) * 3600_000;
    const res = this.db.prepare('DELETE FROM usage WHERE window < ?').run(cutoff);
    return Number(res.changes) || 0;
  }

  // -------------------------------------------------------------- stickers

  /**
   * 存入一张（内容寻址）。同一个 SHA256 只占一份空间。
   *
   * 返回 { sha, stored, verified }：verified 表示"落盘后重新读出来哈希一致"。
   * Tulpa 反复强调候选前要校验真实字节 —— 这里把校验放在写入时和读取时两端。
   */
  putSticker(
    buffer,
    { dir, mime = 'image/png', kind = 'image', account = '', source = '', notes = {} },
  ) {
    const sha = sha256(buffer);
    if (!this.available) return { sha, stored: false, verified: false, reason: '持久化不可用' };

    const existing = this.getSticker(sha);
    if (existing) {
      // 已有原件：只补笔记，不重复占空间
      if (Object.keys(notes).length) this.noteSticker(sha, notes);
      return { sha, stored: false, verified: true, reason: '已存在同内容原件' };
    }

    // 注意用 || 而不是 ??：调用方很可能传进来空字符串（args.account ?? ''），
    // 而空字符串骗不过 ??，会让整批图落进一个空 scope 里，检索时全都找不到。
    const scope = String(notes.scope || account || 'default');
    const scopeDir = path.join(dir, safeScope(scope));
    fs.mkdirSync(scopeDir, { recursive: true });
    const file = path.join(scopeDir, `${sha}.bin`);
    fs.writeFileSync(file, buffer);

    // 写完立刻校验：磁盘满 / 截断 / 杀毒软件改写都能在这一步发现
    let verified = false;
    try {
      verified = sha256(fs.readFileSync(file)) === sha;
    } catch {
      verified = false;
    }
    if (!verified) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* 删不掉就留着，反正不会入库 */
      }
      return { sha, stored: false, verified: false, reason: '落盘校验失败' };
    }

    const ts = nowMs();
    this.db
      .prepare(
        `INSERT INTO stickers
           (sha256, bytes, mime, kind, path, account, source, description, emotion,
            usage_hint, avoid, uncertainty, notes_scope, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sha,
        buffer.length,
        String(mime),
        String(kind),
        file,
        String(account),
        String(source).slice(0, 200),
        String(notes.description ?? ''),
        String(notes.emotion ?? ''),
        String(notes.usage ?? ''),
        String(notes.avoid ?? ''),
        notes.uncertainty ? 1 : 0,
        scope,
        ts,
      );

    return { sha, stored: true, verified: true, path: file };
  }

  getSticker(sha) {
    if (!this.available) return null;
    const row = this.db.prepare('SELECT * FROM stickers WHERE sha256 = ?').get(String(sha));
    return row ? normalizeSticker(row) : null;
  }

  /**
   * 按 sha256 或它的前缀找图。
   *
   * 为什么要前缀：模型很容易只抄前 12 位（列表里显示的就是这个）。
   * 但**前缀必须唯一** —— 撞了就报错列出候选，绝不替它猜一张。
   */
  findSticker(shaOrPrefix) {
    if (!this.available) return { ok: false, reason: '持久化不可用' };
    const raw = String(shaOrPrefix ?? '')
      .trim()
      .toLowerCase();
    if (!raw) return { ok: false, reason: 'sha256 不能为空' };
    if (!/^[0-9a-f]+$/.test(raw)) return { ok: false, reason: `不像 sha256：${raw}` };

    const exact = this.getSticker(raw);
    if (exact) return { ok: true, sticker: exact };

    const rows = this.db
      .prepare('SELECT * FROM stickers WHERE sha256 LIKE ? LIMIT 6')
      .all(`${raw}%`);
    if (rows.length === 1) return { ok: true, sticker: normalizeSticker(rows[0]) };
    if (rows.length > 1) {
      return {
        ok: false,
        reason: `前缀 ${raw} 匹配到多张：${rows.map((r) => r.sha256.slice(0, 12)).join('、')}。请给更长的前缀。`,
      };
    }
    return { ok: false, reason: `图库里找不到 ${raw}` };
  }

  /**
   * 补写笔记。
   *
   * 语义是**增量补充**，不是整体覆盖：只更新真正给了内容的字段。
   *
   * 这里踩过一个坑：调用方常常会传 `description: ''`（因为
   * `args.description ?? ''` 会把"没传"变成空串），如果照单全收，
   * 第二次"只补情绪"的调用就会把已有的描述**抹成空**。
   * 所以空字符串一律视为"这次没提这个字段"。
   */
  noteSticker(sha, notes = {}) {
    if (!this.available) return false;
    const fields = [];
    const args = [];
    const map = {
      description: 'description',
      emotion: 'emotion',
      usage: 'usage_hint',
      avoid: 'avoid',
    };
    for (const [key, column] of Object.entries(map)) {
      const value = notes[key];
      if (value === undefined || value === null) continue;
      const text = String(value).trim();
      // 空串 = 这次没提这个字段，保留原值
      if (!text) continue;
      fields.push(`${column} = ?`);
      args.push(text);
    }
    if (notes.uncertainty !== undefined) {
      fields.push('uncertainty = ?');
      args.push(notes.uncertainty ? 1 : 0);
    }
    if (!fields.length) return false;
    args.push(String(sha));
    this.db.prepare(`UPDATE stickers SET ${fields.join(', ')} WHERE sha256 = ?`).run(...args);
    return true;
  }

  /**
   * 取原件**并校验真实哈希**。
   *
   * 这是 Tulpa「候选前校验实际字节」的直接落地：哈希对不上就当作缺失，
   * **绝不悄悄换成另一张图**。
   */
  readSticker(sha) {
    const row = this.getSticker(sha);
    if (!row) return { ok: false, reason: '库里没有这张图' };
    try {
      const buffer = fs.readFileSync(row.path);
      const actual = sha256(buffer);
      if (actual !== row.sha256) {
        return {
          ok: false,
          reason: `原件哈希不符（期望 ${row.sha256.slice(0, 8)}，实际 ${actual.slice(0, 8)}）`,
        };
      }
      return { ok: true, buffer, mime: row.mime, meta: row };
    } catch (error) {
      return { ok: false, reason: `原件读不到：${error?.message ?? error}` };
    }
  }

  /** 记一次使用。冷却与用量都靠它。 */
  markUsed(shas, at = nowMs()) {
    if (!this.available) return 0;
    const list = Array.isArray(shas) ? shas : [shas];
    const stmt = this.db.prepare(
      'UPDATE stickers SET uses = uses + 1, last_used_at = ? WHERE sha256 = ?',
    );
    let n = 0;
    for (const sha of list) {
      const res = stmt.run(Number(at), String(sha));
      n += Number(res.changes) || 0;
    }
    return n;
  }

  /**
   * 挑候选。Tulpa 的规则照搬：
   *   · 冷却期内刚用过的图不推荐；
   *   · uncertainty 的图不进"可直接使用"候选；
   *   · 关键词命中优先，其次常用，最后按时间桶轮换保证多样性。
   */
  pickStickers({ scope = null, query = '', limit = 4, cooldownMs = 120_000, now = nowMs() } = {}) {
    if (!this.available) return [];
    const rows = scope
      ? this.db.prepare('SELECT * FROM stickers WHERE notes_scope = ?').all(String(scope))
      : this.db.prepare('SELECT * FROM stickers').all();

    const q = String(query ?? '')
      .trim()
      .toLowerCase();
    const scored = [];
    for (const raw of rows) {
      const st = normalizeSticker(raw);
      if (st.uncertainty) continue;
      if (cooldownMs > 0 && now - st.lastUsedAt < cooldownMs) continue;
      let score = 0;
      if (q) {
        const hay = `${st.description} ${st.emotion} ${st.usageHint} ${st.avoid}`.toLowerCase();
        if (hay.includes(q)) score += 100;
      }
      score += Math.min(20, st.uses);
      // 时间桶轮换：同一桶内的图优先，换桶就换一批，避免永远只发那几张
      const bucket = Math.floor(now / Math.max(60_000, cooldownMs * 15));
      score += ((hashNum(st.sha256) + bucket) % 7) / 7;
      scored.push({ sticker: st, score });
    }
    scored.sort((a, b) => b.score - a.score || a.sticker.lastUsedAt - b.sticker.lastUsedAt);
    return scored.slice(0, Math.max(1, Math.min(12, limit))).map((s) => s.sticker);
  }

  /** 关键词/标签检索，含 uncertainty 的也返回（人工核对用）。 */
  searchStickers({ scope = null, query = '', limit = 20 } = {}) {
    if (!this.available) return [];
    const rows = scope
      ? this.db.prepare('SELECT * FROM stickers WHERE notes_scope = ?').all(String(scope))
      : this.db.prepare('SELECT * FROM stickers').all();
    const q = String(query ?? '')
      .trim()
      .toLowerCase();
    return rows
      .map(normalizeSticker)
      .filter((st) => {
        if (!q) return true;
        return `${st.description} ${st.emotion} ${st.usageHint} ${st.avoid} ${st.sha256}`
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.uses - a.uses || b.collectedAt - a.collectedAt)
      .slice(0, Math.max(1, limit));
  }

  stickerStats(scope = null) {
    if (!this.available) return { count: 0, bytes: 0 };
    const row = scope
      ? this.db
          .prepare(
            'SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM stickers WHERE notes_scope = ?',
          )
          .get(String(scope))
      : this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM stickers').get();
    return { count: Number(row?.n) || 0, bytes: Number(row?.b) || 0 };
  }

  /**
   * LRU 配额。超了**报告**而不是静默删用户的东西 ——
   * 除非调用方明确要求 evict，并且该原件不是 pinned。
   */
  enforceQuota({ scopeMiB = 128, totalMiB = 256, scope = null, evict = false } = {}) {
    if (!this.available) return { evicted: [], over: false };
    const totalLimit = Math.max(6, totalMiB) * 1024 * 1024;
    const scopeLimit = Math.max(6, scopeMiB) * 1024 * 1024;
    const evicted = [];

    const overLimit = (rows, limit) =>
      rows.reduce((sum, r) => sum + Number(r.bytes || 0), 0) > limit;

    const collect = (rows) =>
      rows
        .filter((r) => !r.pinned)
        .sort((a, b) => (Number(a.last_used_at) || 0) - (Number(b.last_used_at) || 0));

    // 先按单授权配额，再按全局配额
    for (const [rows, limit, tag] of [
      [
        scope
          ? this.db.prepare('SELECT * FROM stickers WHERE notes_scope = ?').all(String(scope))
          : [],
        scopeLimit,
        'scope',
      ],
      [this.db.prepare('SELECT * FROM stickers').all(), totalLimit, 'total'],
    ]) {
      if (!rows.length) continue;
      let sum = rows.reduce((s, r) => s + Number(r.bytes || 0), 0);
      if (sum <= limit) continue;
      for (const row of collect(rows)) {
        if (sum <= limit) break;
        if (!evict) {
          return {
            evicted,
            over: true,
            reason: `${tag} 超出配额（${formatBytes(sum)} / ${formatBytes(limit)}）`,
            overBy: sum - limit,
          };
        }
        try {
          fs.unlinkSync(row.path);
        } catch {
          /* 文件可能已经不在了 */
        }
        this.db.prepare('DELETE FROM stickers WHERE sha256 = ?').run(row.sha256);
        sum -= Number(row.bytes || 0);
        evicted.push(row.sha256);
      }
    }
    return { evicted, over: false };
  }
}

// ---------------------------------------------------------------- 辅助

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeScope(scope) {
  return String(scope ?? 'default').replace(/[^\dA-Za-z_-]/g, '') || 'default';
}

function hashNum(text) {
  const digest = sha256(String(text));
  return parseInt(digest.slice(0, 8), 16);
}

function normalizeReceipt(row) {
  return {
    idemKey: row.idem_key,
    conversation: row.conversation,
    kind: row.kind,
    target: row.target,
    payload: row.payload,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    onebotId: row.onebot_id ?? null,
    detail: row.detail ?? '',
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

function normalizePendingAction(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    groupId: row.group_id,
    userId: row.user_id,
    reason: row.reason ?? '',
    requestedBy: row.requested_by ?? '',
    status: row.status,
    createdAt: Number(row.created_at) || 0,
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    resolution: row.resolution ?? '',
    detail: row.detail ?? '',
  };
}

function normalizeRequest(row) {
  return {
    flag: row.flag,
    kind: row.kind,
    subType: row.sub_type ?? '',
    userId: row.user_id ?? '',
    groupId: row.group_id ?? '',
    comment: row.comment ?? '',
    nickname: row.nickname ?? '',
    notified: Boolean(row.notified),
    createdAt: Number(row.created_at) || 0,
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    resolution: row.resolution ?? '',
  };
}

function normalizeSticker(row) {
  return {
    sha256: row.sha256,
    bytes: Number(row.bytes) || 0,
    mime: row.mime ?? '',
    kind: row.kind,
    path: row.path,
    account: row.account ?? '',
    source: row.source ?? '',
    description: row.description ?? '',
    emotion: row.emotion ?? '',
    usageHint: row.usage_hint ?? '',
    avoid: row.avoid ?? '',
    uncertainty: Boolean(row.uncertainty),
    scope: row.notes_scope ?? '',
    uses: Number(row.uses) || 0,
    lastUsedAt: Number(row.last_used_at) || 0,
    collectedAt: Number(row.collected_at) || 0,
    pinned: Boolean(row.pinned),
  };
}
