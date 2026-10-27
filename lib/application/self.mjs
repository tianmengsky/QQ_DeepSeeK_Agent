/**
 * 自传层：关于"我自己"的可重建事实。
 *
 * 与记事本（`bridge_agent_memories`）的分工，别混：
 *   · 这里存 **发生过的事实**：我叫什么、在哪些群、有哪些好友、改过什么名、说过什么话。
 *     只能由工具回执或账号会话写入，**不可编辑、不可忘记**，只追加。
 *   · 记事本存 **我选择记下的东西**：判断、观察、约定、日记。可版本化、可 forget。
 *
 * 为什么这么分：事实一旦允许自由编辑，"我是谁"就会随对话漂移（"你不是叫小鲸鱼吗"
 * 这类话会把自我认知改掉）。所以事实层只吃**有回执的来源**，解读放进记事本。
 *
 * 为什么全部可重建：`self_profile` / `self_group` / `self_friend` 都是"上次拉到的快照"，
 * 删了重新拉一次就回来。只有 `self_event` 是真正的历史 —— 它记录的是"当时做了什么"，
 * 拉不回来。所以卡片上必须标出快照的年龄，让模型知道自己看的是几十秒前的事实。
 */
import { randomUUID } from 'node:crypto';
import { onebotCall } from '../transport/onebot-client.mjs';
import { localStamp } from '../domain/time.mjs';

/** `self_event` 允许的类别。新增类别必须同时改这里和卡片的渲染。 */
const EVENT_KINDS = ['rename', 'profile', 'post', 'speak', 'promise', 'refresh'];

/** 只接受这两类来源的写入 —— 见文件头注释。 */
const EVENT_SOURCES = ['tool-receipt', 'self-turn'];

const clip = (text, size) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

export class SelfLedger {
  constructor({ config, store, logger = store?.logger }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.ready = false;
    this.lastError = null;
    this.lastRefreshAt = 0;
    this.lastReason = '';
    this.timer = null;
    this.refreshing = null;
    if (!store?.available) return;
    try {
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS self_profile (
          key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'onebot', fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_group (
          group_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
          member_count INTEGER NOT NULL DEFAULT 0, my_role TEXT NOT NULL DEFAULT 'member',
          seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_friend (
          user_id TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '',
          remark TEXT NOT NULL DEFAULT '', seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_event (
          id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL,
          target TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL,
          outcome TEXT NOT NULL DEFAULT '', ref TEXT, source TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS self_event_at ON self_event(at DESC);
        CREATE INDEX IF NOT EXISTS self_event_kind ON self_event(kind, at DESC);
      `);
      this.ready = true;
      /**
       * 恢复上次的刷新健康度。
       *
       * 为什么必须落库：刷新失败的原因（接入端没起来、接口不支持好友列表）
       * 只在内存里的话，**重载一次就消失**，`#debug self` 会显示"尚未刷新"——
       * 而"尚未刷新"与"刷了三次都失败"是两种完全不同的处境，修法也不同。
       * 2026-10-22 实测踩到：四张表 0 行，但界面上看不出是没跑还是跑了失败。
       */
      try {
        const saved = JSON.parse(store.getState('qq-bridge:self-health') ?? 'null');
        if (saved && typeof saved === 'object') {
          this.lastRefreshAt = Number(saved.lastRefreshAt) || 0;
          this.lastError = typeof saved.lastError === 'string' ? saved.lastError : null;
          this.lastReason = typeof saved.lastReason === 'string' ? saved.lastReason : '';
        }
      } catch { /* 坏数据当作没有 */ }
    } catch (error) {
      this.lastError = `建表失败：${error?.message ?? error}`;
      logger?.warn?.(`qq-bridge: ${this.lastError}`);
    }
  }

  get available() {
    return this.ready && Boolean(this.store?.available);
  }

  /**
   * 刷新账号事实。
   *
   * 三个接口并发、**各自独立失败**：好友列表在某些实现上不可用，不能因此把
   * 群列表也丢掉。任一部分成功就写那一部分，失败的部分保留旧值并记 `lastError`
   * —— 这比"整次刷新失败就什么都不写"更接近事实：旧的群名比没有群名好。
   */
  async refresh({ signal = null, reason = 'scheduled' } = {}) {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh({ signal, reason }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async #refresh({ signal, reason }) {
    const timeout = Math.max(3000, Number(this.config.selfRefreshTimeoutMs) || 10000);
    const call = (action, payload = {}) =>
      onebotCall(this.config, action, payload, timeout, signal ?? undefined);
    const errors = [];
    const [login, groupList, friendList] = await Promise.all([
      call('get_login_info').catch((error) => { errors.push('login:' + (error?.message ?? error)); return null; }),
      // `no_cache: true` 是这里唯一不能省的一行：不传它，改名之后仍会拿到旧群名。
      call('get_group_list', { no_cache: true }).catch((error) => { errors.push('groups:' + (error?.message ?? error)); return null; }),
      call('get_friend_list').catch((error) => { errors.push('friends:' + (error?.message ?? error)); return null; }),
    ]);
    const now = Date.now();
    try {
      if (login && typeof login === 'object') {
        this.#putProfile('uin', login.user_id, now);
        this.#putProfile('nickname', login.nickname, now);
        if (typeof login.remark === 'string' && login.remark) this.#putProfile('remark', login.remark, now);
      }
      const groups = normalizeList(groupList);
      if (groups) this.#putGroups(groups, now);
      const friends = normalizeList(friendList);
      if (friends) this.#putFriends(friends, now);
      this.lastRefreshAt = now;
      this.lastReason = reason;
      this.lastError = errors.length ? errors.join('；').slice(0, 300) : null;
      this.#persistHealth();
      if (errors.length) this.logger?.warn?.(`qq-bridge: 自传刷新部分失败 —— ${this.lastError}`);
      return { ok: !errors.length, groups: groups?.length ?? null, friends: friends?.length ?? null,
        errors: errors.length };
    } catch (error) {
      this.lastError = String(error?.message ?? error).slice(0, 300);
      this.#persistHealth();
      this.logger?.warn?.(`qq-bridge: 自传刷新失败 —— ${this.lastError}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** 刷新健康度落库；失败只影响诊断，不影响主链路。 */
  #persistHealth() {
    try {
      this.store?.setState?.('qq-bridge:self-health', JSON.stringify({
        lastRefreshAt: this.lastRefreshAt, lastError: this.lastError,
        lastReason: this.lastReason, at: Date.now(),
      }));
    } catch { /* 写不进去就只在内存里留一份 */ }
  }

  #putProfile(key, value, at) {
    if (value == null || value === '') return;
    this.store.db.prepare(`INSERT INTO self_profile (key, value, source, fetched_at) VALUES (?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, source=excluded.source, fetched_at=excluded.fetched_at`)
      .run(String(key), String(value), 'onebot', at);
  }

  #putGroups(groups, at) {
    const keep = new Set();
    const stmt = this.store.db.prepare(`INSERT INTO self_group
      (group_id, name, member_count, my_role, seen_at) VALUES (?,?,?,?,?)
      ON CONFLICT(group_id) DO UPDATE SET name=excluded.name,
        member_count=excluded.member_count, my_role=excluded.my_role, seen_at=excluded.seen_at`);
    for (const g of groups) {
      const id = String(g.group_id ?? g.groupId ?? '').trim();
      if (!/^[1-9]\d*$/.test(id)) continue;
      keep.add(id);
      stmt.run(id, clip(g.group_name ?? g.groupName ?? '', 60),
        Math.max(0, Number(g.member_count ?? g.memberCount) || 0),
        clip(g.role ?? g.my_role ?? 'member', 20) || 'member', at);
    }
    // 退了的群要真的消失；否则卡片会长期显示一个已经不在的群。
    for (const row of this.store.db.prepare('SELECT group_id FROM self_group').all())
      if (!keep.has(String(row.group_id)))
        this.store.db.prepare('DELETE FROM self_group WHERE group_id=?').run(String(row.group_id));
  }

  #putFriends(friends, at) {
    const keep = new Set();
    const stmt = this.store.db.prepare(`INSERT INTO self_friend
      (user_id, nickname, remark, seen_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname,
        remark=excluded.remark, seen_at=excluded.seen_at`);
    for (const f of friends) {
      const id = String(f.user_id ?? f.userId ?? '').trim();
      if (!/^[1-9]\d*$/.test(id)) continue;
      keep.add(id);
      stmt.run(id, clip(f.nickname ?? f.nick ?? '', 60), clip(f.remark ?? '', 60), at);
    }
    for (const row of this.store.db.prepare('SELECT user_id FROM self_friend').all())
      if (!keep.has(String(row.user_id)))
        this.store.db.prepare('DELETE FROM self_friend WHERE user_id=?').run(String(row.user_id));
  }

  profile() {
    if (!this.available) return {};
    const rows = this.store.db.prepare('SELECT key, value, fetched_at FROM self_profile').all();
    return Object.fromEntries(rows.map((r) => [r.key, { value: r.value, at: r.fetched_at }]));
  }

  groups() {
    if (!this.available) return [];
    return this.store.db.prepare('SELECT * FROM self_group ORDER BY member_count DESC, group_id').all()
      .map((r) => ({ groupId: String(r.group_id), name: r.name, memberCount: Number(r.member_count),
        myRole: r.my_role, seenAt: Number(r.seen_at) }));
  }

  friends() {
    if (!this.available) return [];
    return this.store.db.prepare('SELECT * FROM self_friend ORDER BY user_id').all()
      .map((r) => ({ userId: String(r.user_id), nickname: r.nickname, remark: r.remark, seenAt: Number(r.seen_at) }));
  }

  events({ limit = 10 } = {}) {
    if (!this.available) return [];
    return this.store.db.prepare('SELECT * FROM self_event ORDER BY at DESC LIMIT ?').all(Math.max(1, limit))
      .map((r) => ({ id: r.id, at: Number(r.at), kind: r.kind, target: r.target,
        summary: r.summary, outcome: r.outcome, ref: r.ref, source: r.source }));
  }

  /**
   * 追加一条自传事件。
   *
   * `source` 白名单是硬约束：只有"工具回执"和"账号会话显式写入"能进。
   * 明确拒绝从群聊内容提炼 —— 那正是"你不是叫小鲸鱼吗"能污染自我认知的入口。
   */
  record({ kind, target = '', summary, outcome = '', ref = null, source }) {
    if (!this.available) return { ok: false, reason: 'unavailable' };
    if (!EVENT_KINDS.includes(kind)) throw new Error('未知自传类别：' + kind);
    if (!EVENT_SOURCES.includes(source))
      throw new Error('自传事件只接受工具回执或账号会话写入，不接受 ' + source);
    const text = clip(summary, 200);
    if (!text) throw new Error('自传事件需要摘要');
    const id = randomUUID(), at = Date.now();
    this.store.db.prepare(`INSERT INTO self_event (id, at, kind, target, summary, outcome, ref, source)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, at, kind, clip(target, 80), text, clip(outcome, 120),
      ref == null ? null : String(ref).slice(0, 120), source);
    return { ok: true, id, at };
  }

  /**
   * 渲染自我卡片。**纯字符串，零模型调用** —— 这是它能被长期开着的前提。
   *
   * @returns {string} 没有可用事实时返回空串（注入侧据此跳过，避免空标题）。
   */
  card({ maxGroups = 20, maxEvents = 3, maxFriends = 0, maxChars = 0 } = {}) {
    if (!this.available) return '';
    const profile = this.profile();
    const groups = this.groups();
    const friends = this.friends();
    const events = this.events({ limit: Math.max(1, maxEvents) });
    const name = profile.nickname?.value ?? '';
    const uin = profile.uin?.value ?? '';
    if (!name && !uin && !groups.length) return '';
    const ageMs = this.lastRefreshAt ? Date.now() - this.lastRefreshAt : 0;
    /**
     * 用 `lastRefreshAt` 判断"刷过没有"，不能用 `ageMs`。
     *
     * 刷新与渲染落在**同一毫秒**时 `ageMs === 0`，而 0 是 falsy ——
     * 于是刚刷新完的卡片会写"尚未刷新"，让模型以为自己没有账号信息。
     * 这不是理论风险：全量测试里偶发复现过（快机器上两次 Date.now() 相同）。
     * 秒数用 `Math.max(1, …)` 兜底，避免显示"0 秒前"。
     */
    const age = this.lastRefreshAt
      ? (ageMs < 90000
        ? `${Math.max(1, Math.round(ageMs / 1000))} 秒前`
        : `${Math.max(1, Math.round(ageMs / 60000))} 分钟前`)
      : '尚未刷新';
    const lines = [];
    const head = [`你叫「${name || '（未获取）'}」`, uin ? `QQ ${uin}` : ''].filter(Boolean).join('，');
    lines.push(`【关于我自己】${head}。（账号信息 ${age}读取）`);
    if (groups.length) {
      lines.push(`你在 ${groups.length} 个群：`);
      for (const g of groups.slice(0, maxGroups))
        lines.push(`  · ${g.groupId} ${g.name || '（无名）'}（${g.memberCount} 人）`);
      if (groups.length > maxGroups) lines.push(`  …另有 ${groups.length - maxGroups} 个群未列出`);
    } else if (this.lastRefreshAt && !this.lastError) {
      // 只有"刷新成功且确实是空"才敢这么说。否则"接口连不上"会被写成"你没加群"。
      lines.push('你目前没有加入任何群。');
    } else {
      lines.push(`（群信息还没取到：${this.lastError ? this.lastError.slice(0, 80) : '尚未刷新'}）`);
    }
    if (!this.lastRefreshAt || this.lastError)
      lines.push(friends.length ? `已知好友 ${friends.length} 人（上次成功刷新时的快照）。` : '好友数未知。');
    else
      lines.push(maxFriends > 0 && friends.length
        ? `好友 ${friends.length} 人，例如 ${friends.slice(0, maxFriends).map((f) => f.remark || f.nickname || f.userId).join('、')}。`
        : `好友 ${friends.length} 人。`);
    if (events.length) {
      lines.push('最近你自己做过的事：');
      for (const e of events) lines.push(`  · ${localStamp(new Date(e.at))} ${e.summary}${e.outcome ? ' → ' + e.outcome : ''}`);
    }
    // 这一行是硬要求：群名会变、也可能重名，动作的 target 一律用群号。
    lines.push('【定位规则】说群只认群号；群名会变、也可能重名。');
    const text = lines.join('\n');
    const cap = Number(maxChars) > 0 ? Number(maxChars) : Number(this.config.selfCardMaxChars) || 700;
    return text.length > cap ? text.slice(0, cap) + '\n（卡片已截断）' : text;
  }

  /** 供 status / #debug 用的只读快照。 */
  snapshot() {
    if (!this.available) return { available: false, lastError: this.lastError || '库不可用' };
    const profile = this.profile();
    const groups = this.groups(), friends = this.friends(), events = this.events({ limit: 1 });
    return {
      available: true,
      enabled: this.config.selfEnabled !== false,
      nickname: profile.nickname?.value ?? null,
      uin: profile.uin?.value ?? null,
      groups: groups.length,
      friends: friends.length,
      events: Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM self_event').get().n),
      refreshedAt: this.lastRefreshAt || null,
      cardAgeMs: this.lastRefreshAt ? Date.now() - this.lastRefreshAt : null,
      lastEventAt: events[0]?.at ?? null,
      lastReason: this.lastReason || null,
      lastError: this.lastError,
    };
  }

  /**
   * 周期刷新。
   *
   * 首次立刻跑一次（`queueMicrotask`），之后按 `selfRefreshIntervalMs`。
   * 失败不重试得更密 —— 下一个周期自然会再试，而刷新失败不该产生重试风暴。
   */
  start(signal = null) {
    if (!this.available || this.config.selfEnabled === false) return () => {};
    const tick = () => {
      if (signal?.aborted) return;
      this.refresh({ signal, reason: 'scheduled' }).catch(() => {});
    };
    /**
     * 首刷延迟 3 秒，而不是 queueMicrotask。
     *
     * 插件刚加载的那一瞬间，登录探测、会话恢复、发送队列全在抢同一台上游；
     * 而且 SnowLuma 可能还没就绪 —— 立刻打三个接口大概率全失败，然后要等
     * 45 分钟才重试。3 秒后基本已可用，代价只是"我是谁"晚 3 秒出现。
     */
    this.firstTimer = setTimeout(tick, 3000);
    this.firstTimer.unref?.();
    this.timer = setInterval(tick, Math.max(60000, Number(this.config.selfRefreshIntervalMs) || 2700000));
    this.timer.unref?.();
    return () => {
      if (this.firstTimer) clearTimeout(this.firstTimer);
      if (this.timer) clearInterval(this.timer);
      this.firstTimer = null;
      this.timer = null;
    };
  }

  /**
   * 停止刷新，并等在途的那一次收尾。
   *
   * 为什么必须 await：刷新会往 `self_*` 表写。如果调用方（插件的 store close）
   * 不等它，`store.db.close()` 之后这次写就会抛 "database is closed"，
   * 在日志里表现为"重载时莫名报错"，实际是关闭顺序问题。
   */
  async dispose() {
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
    if (this.refreshing) { try { await this.refreshing; } catch { /* 失败也要让关闭继续 */ } }
  }
}

/**
 * OneBot 的 data 在数组/对象两种形状上都出现过（部分实现把列表包在 `{list:[...]}`）。
 * 不认识就返回 null —— 调用方据此保留旧快照，而不是写一批空数据把群清空。
 */
function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  return null;
}

export const __selfTest = { normalizeList, EVENT_KINDS, EVENT_SOURCES };
