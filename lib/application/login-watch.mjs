/**
 * login-watch.mjs —— 盯住"QQ 登录还在不在"。
 *
 * 这个模块监测 QQ/OneBot 接入端的登录与可用状态；服务端失效登录或接入端
 * 重启都会让消息突然停止，仅靠 QQ 客户端日志很难还原中断的起止时间。
 *
 * 这个模块把那次状态迁移变成一个**可复现的读数**：
 *   - 最后一次探测到的在线状态；
 *   - 每次掉线的开始/结束时间、原因、持续多久；
 *   - 累计掉线次数、累计不可用时长。
 *
 * 它**只做观测，不做恢复动作**。没有自动重登：登录凭据由 QQ 管理，
 * 机器人这边能做的只有"如实报告 + 等你扫码"，擅自重试登录只会加重风控。
 *
 * 三种"不在线"的原因分开记，因为它们指向完全不同的处理方式：
 *   onebot-offline —— 服务端明确说 online=false（这一般就是被踢了）；
 *   onebot-unknown —— 接口可达，但没给出在线状态（协议噪声）；
 *   unreachable    —— OneBot 接口连不上（接入端未运行或未连接 QQ）。
 *
 * 另外每次掉线会**顺手拍一张环境快照**（QQNT build、登录票据文件时间）。
 * 理由很实际：QQ 热更新换 build、或者本地票据被重写，都可能影响接入端
 * 与登录态 —— 但过几天再回头翻日志时，没人记得当时是哪个版本。
 * 顺便把每次掉线写一行 JSONL 到 `data/login-alerts.log`：
 * 账号掉线时走 QQ 通知没有意义（账号本身就掉了），得有一份落在盘上的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { onebotCall } from '../transport/onebot-client.mjs';

/** 运行态快照的键。插件重载后靠它接上上一段观测，不把计数清零。 */
export const LOGIN_STATE_KEY = 'loginWatch:state';

/**
 * 事件表里用的合成会话名。
 *
 * 掉线不属于任何一条群/私聊会话，但事件表需要一个 conversation ——
 * 用一个明显不是真实会话的名字，避免被当成群号去解析。
 */
export const LOGIN_EVENT_CONVERSATION = 'system:login';

/** 快照里最多留几次掉线记录。够看清频率，不会把状态键撑大。 */
export const LOGIN_HISTORY_LIMIT = 40;

/** 默认连续探测失败几次才算"真的连不上了"。正常的一次抖动不该记成一笔账。 */
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_INTERVAL_MS = 60000;
const DEFAULT_TIMEOUT_MS = 4000;
/** 环境快照的缓存时长：稳态下不必每 60 秒去读一次磁盘。 */
const DEFAULT_ENV_CACHE_MS = 300000;
/** 搜登录票据时最多递归几层，免得在大目录树里走丢。 */
const CREDENTIAL_SCAN_DEPTH = 4;
/** QQ 账号数据根目录的默认位置。配了 qqntDataDir 就以配置为准。 */
export const DEFAULT_QQ_DATA_ROOT = 'E:\\QQFile\\message\\Tencent Files';

/**
 * 登录票据（`login.enc`）的已知位置，按优先级排。
 *
 * 实测这台机器上它是 `%APPDATA%\QQ\auth\login.enc`（QQ 客户端自己那份），
 * 而**不在**账号数据目录 `E:\QQFile\message\Tencent Files\<QQ号>\nt_qq` 里 ——
 * 所以只盯数据目录会一直报"未找到"。这里列几个候选，谁先命中用谁，
 * 并在报告里说清是哪一个命中的。
 */
export function defaultCredentialRoots() {
  const roots = [];
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, 'QQ', 'auth'));
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) roots.push(path.join(localAppData, 'QQ', 'auth'));
  return roots;
}

// ------------------------------------------------------------ 环境快照

/**
 * 读 QQNT 版本。优先 `versions\config.json`（里面有 curVersion 和上一个版本），
 * 读不到就退回去看 `versions\` 下有哪些目录。
 *
 * 为什么要连 prevVersion 一起记：`curVersion !== prevVersion` 就是"刚热更新过"
 * 的直接证据 —— 这类抖动最容易让注入和登录态重新洗牌。
 */
export function readQqntVersion(qqntDir) {
  if (!qqntDir || !fs.existsSync(qqntDir)) return { current: null, previous: null, note: '目录不存在' };
  const configPath = path.join(qqntDir, 'versions', 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (raw?.curVersion) {
      return { current: String(raw.curVersion), previous: raw.prevVersion ? String(raw.prevVersion) : null, note: '' };
    }
  } catch {
    /* 读不到就退回列目录，不把监视器带崩 */
  }
  try {
    const dirs = fs
      .readdirSync(path.join(qqntDir, 'versions'), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort();
    return { current: dirs.at(-1) ?? null, previous: null, note: dirs.length ? '从目录名推断' : '没有版本目录' };
  } catch (error) {
    return { current: null, previous: null, note: '读取失败：' + String(error?.message ?? error) };
  }
}

/** 在账号数据目录里找登录票据（login.enc），最多递归 CREDENTIAL_SCAN_DEPTH 层。 */
export function findLoginCredential(accountDir) {
  if (!accountDir || !fs.existsSync(accountDir)) return { path: null, mtimeMs: null };
  const walk = (dir, depth) => {
    if (depth > CREDENTIAL_SCAN_DEPTH) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === 'login.enc') {
        const full = path.join(dir, entry.name);
        try {
          return { path: full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return { path: full, mtimeMs: null };
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(accountDir, 0) ?? { path: null, mtimeMs: null };
}

/**
 * 拍一张"这次登录是跑在什么上面"的快照。
 *
 * 票据的找法分两级，因为**它不一定在账号数据目录里**：
 *   ① 账号目录（显式给的，或"数据根 + QQ号"拼的）—— 命中就是精确的；
 *   ② 已知根目录（`%APPDATA%\QQ\auth` 等）—— 这是 QQ 客户端自己存这张票的地方，
 *      命中算"按已知位置找到"，不是精确到账号，报告里会标明。
 */
export function readLoginEnvironment({
  qqntDir = '',
  account = null,
  accountDir = '',
  dataRoot = '',
  credentialRoots = null,
} = {}) {
  const at = Date.now();
  const qqnt = readQqntVersion(qqntDir);
  let credential = { path: null, mtimeMs: null };
  let credentialFrom = 'none';
  let credentialRoot = '';

  // ① 账号目录：显式给的最准；没给就按"数据根 + QQ号"拼一个。
  const resolvedDir = accountDir || (dataRoot && account ? path.join(dataRoot, String(account)) : '');
  if (resolvedDir) {
    credential = findLoginCredential(resolvedDir);
    if (credential.path) {
      credentialFrom = 'account';
      credentialRoot = resolvedDir;
    }
  }

  // ② 已知根目录。`%APPDATA%\QQ\auth` 是实测命中率最高的那个。
  if (!credential.path) {
    const roots = Array.isArray(credentialRoots)
      ? credentialRoots.filter(Boolean)
      : defaultCredentialRoots();
    let newest = { path: null, mtimeMs: null };
    for (const root of roots) {
      if (!root || !fs.existsSync(root)) continue;
      const candidate = findLoginCredential(root);
      if (!candidate.path) continue;
      if (!newest.path || (candidate.mtimeMs ?? 0) > (newest.mtimeMs ?? 0)) {
        newest = candidate;
        credentialRoot = root;
      }
    }
    if (!newest.path && dataRoot && fs.existsSync(dataRoot) && !account) {
      // 连账号都没有（第一轮探测）：只能扫数据根，取最新的一份。
      for (const entry of fs.readdirSync(dataRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = findLoginCredential(path.join(dataRoot, entry.name));
        if (!candidate.path) continue;
        if (!newest.path || (candidate.mtimeMs ?? 0) > (newest.mtimeMs ?? 0)) {
          newest = candidate;
          credentialRoot = dataRoot;
        }
      }
    }
    if (newest.path) {
      credential = newest;
      credentialFrom = 'latest';
    }
  }

  return {
    at,
    account: account ? String(account) : null,
    qqnt: qqnt.current,
    qqntPrevious: qqnt.previous,
    qqntNote: qqnt.note || '',
    刚热更新: Boolean(qqnt.current && qqnt.previous && qqnt.current !== qqnt.previous),
    credentialMtimeMs: credential.mtimeMs ?? null,
    credentialPath: credential.path,
    credentialFrom,
    credentialRoot: credentialRoot || null,
  };
}

/** 环境快照 → 一行短描述，塞进告警和日志里。 */
export function describeEnvironment(env) {
  if (!env) return '（无环境快照）';
  const parts = [];
  parts.push(env.qqnt ? 'QQNT ' + env.qqnt : 'QQNT 版本未知');
  if (env.qqntPrevious && env.qqntPrevious !== env.qqnt) parts.push('上一版 ' + env.qqntPrevious);
  parts.push(
    env.credentialMtimeMs
      ? '登录票据 ' + new Date(env.credentialMtimeMs).toISOString().slice(0, 16).replace('T', ' ')
      : '登录票据 未找到',
  );
  if (env.credentialFrom === 'latest') parts.push('票据按最新推断');
  if (env.account) parts.push('账号 ' + env.account);
  return parts.join(' · ');
}

/**
 * 把这次掉线和上次的环境比一比。**只报事实，不猜因果** ——
 * 版本变了不等于就是它干的，但没有这个对比，事后再也说不清当时是什么版本。
 */
export function compareEnvironment(before, after) {
  if (!before || !after) return null;
  const changes = [];
  if (before.qqnt !== after.qqnt) {
    changes.push(`QQNT 版本变化：${before.qqnt ?? '未知'} → ${after.qqnt ?? '未知'}`);
  }
  if (before.credentialMtimeMs !== after.credentialMtimeMs) {
    changes.push('登录票据文件时间变化（期间重新登录或票据被重写）');
  }
  if (!changes.length) return null;
  return changes;
}

/** 把探测结果分成三种原因，供状态机和报告使用。 */
export function classifyLoginProbe({ online = null, error = '' } = {}) {
  if (online === true) return { status: 'online', cause: null, error: '' };
  if (online === false) {
    // 明确说离线：这就是 KickedOffLine 那一类，不需要等阈值。
    return { status: 'offline', cause: 'onebot-offline', error: String(error ?? '') };
  }
  // 没拿到在线状态。有错误 = 调用本身失败了（接口不可达）；
  // 没错误 = 接口通了但它没回答 online —— 这两种要分开，处理方式不一样。
  const message = String(error ?? '');
  return {
    status: 'unknown',
    cause: message ? 'unreachable' : 'onebot-unknown',
    error: message,
  };
}

/** 原因 → 一句人话，直接给自检接口用。 */
export function loginIncidentReason(cause) {
  switch (cause) {
    case 'onebot-offline':
      return '服务端判定登录已失效（被踢下线），需重新扫码';
    case 'onebot-unknown':
      return 'OneBot 可达但未回报在线状态';
    case 'unreachable':
      return 'OneBot 接口连不上（接入端未运行、重启中或未连接 QQ）';
    default:
      return String(cause ?? '未知');
  }
}

/**
 * 探测一次 OneBot。永远不抛：失败也要变成可记录的原因。
 *
 * 顺带取一次 `get_login_info` —— 一次探测同时拿到"在不在线"和"登的是哪个号"，
 * 而账号是定位登录票据文件的唯一线索。两个动作都读 `allSettled`，谁挂了都不影响另一个。
 */
export async function probeLogin(config, signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const at = Date.now();
  const [statusResult, loginResult] = await Promise.allSettled([
    onebotCall(config, 'get_status', {}, timeoutMs, signal),
    onebotCall(config, 'get_login_info', {}, timeoutMs, signal),
  ]);
  const account = loginResult.status === 'fulfilled' ? (loginResult.value?.user_id ?? null) : null;
  if (statusResult.status === 'fulfilled') {
    const data = statusResult.value;
    const online = typeof data?.online === 'boolean' ? data.online : null;
    const good = typeof data?.good === 'boolean' ? data.good : null;
    return { at, online, good, account, error: '' };
  }
  const error = statusResult.reason;
  const cause = error?.cause?.code ?? error?.cause?.message ?? '';
  return {
    at,
    online: null,
    good: null,
    account,
    error: String(error?.message ?? error) + (cause ? ' (' + cause + ')' : ''),
  };
}

/** 一串掉线记录 → 频率读数。没人算得出来的话，界面就只能显示一堆时间戳。 */
export function summarizeLoginHistory(incidents = [], now = Date.now()) {
  const list = Array.isArray(incidents) ? incidents : [];
  const done = list.filter((i) => Number.isFinite(i?.endedAt) && Number.isFinite(i?.startedAt));
  const offlineMs = list.reduce(
    (sum, i) => sum + Math.max(0, Number(i?.offlineMs) || 0),
    0,
  );
  const starts = list.map((i) => Number(i?.startedAt)).filter(Number.isFinite);
  const spanMs = starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : 0;
  const avgMs = done.length
    ? Math.round(done.reduce((s, i) => s + (i.endedAt - i.startedAt), 0) / done.length)
    : null;
  return {
    drops: list.length,
    recovered: done.length,
    /** 还没确认恢复的那一次（null = 当前在线）。 */
    open: list.find((i) => !Number.isFinite(i?.endedAt)) ?? null,
    lastDropAt: starts.length ? Math.max(...starts) : null,
    lastRecoveredAt: done.length ? Math.max(...done.map((i) => i.endedAt)) : null,
    /** 最近/平均"能连续用多久"。会话寿命短 = 风控盯得紧。 */
    lastStableMs: starts.length >= 2 ? starts.at(-1) - starts.at(-2) : null,
    avgStableMs: spanMs && starts.length > 1 ? Math.round(spanMs / (starts.length - 1)) : null,
    avgOfflineMs: avgMs,
    offlineMs,
    now,
  };
}

export class LoginWatch {
  /**
   * @param {object} args
   * @param {object} args.config      插件配置（读 loginWatch* / qqntDir / loginAlert* ）
   * @param {object|null} args.store  持久化层；null = 只留内存
   * @param {object|null} args.logger
   * @param {Function} [args.probe]   注入探测函数，默认打真实 OneBot（测试注入假实现）
   * @param {Function} [args.snapshot] 注入环境快照函数，默认读本机 QQNT / 票据文件
   */
  constructor({
    config = {},
    store = null,
    logger = null,
    probe = null,
    snapshot = null,
    alertPath = '',
  } = {}) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.probe = probe ?? ((signal) => probeLogin(config, signal, this.timeoutMs));
    this.snapshot = snapshot ?? ((args) => readLoginEnvironment(args));
    this.alertPath = alertPath || '';
    this.intervalMs = Math.max(1000, Number(config.loginWatchMs) || DEFAULT_INTERVAL_MS);
    this.timeoutMs = Math.max(1000, Number(config.loginWatchTimeoutMs) || DEFAULT_TIMEOUT_MS);
    this.failureThreshold = Math.max(
      1,
      Number(config.loginWatchFailureThreshold) || DEFAULT_FAILURE_THRESHOLD,
    );
    this.envCacheMs = Math.max(0, Number(config.loginEnvCacheMs ?? DEFAULT_ENV_CACHE_MS));
    this.alertEnabled = config.loginAlertEnabled !== false;

    const saved = store?.available ? safeParse(store.getState(LOGIN_STATE_KEY)) : null;
    this.status = saved?.status === 'online' || saved?.status === 'offline' ? saved.status : 'unknown';
    this.cause = saved?.status ? (saved.cause ?? null) : null;
    this.lastError = saved?.lastError ?? '';
    this.failures = Math.max(0, Number(saved?.failures) || 0);
    this.lastProbeAt = Number(saved?.lastProbeAt) || null;
    this.lastOnlineAt = Number(saved?.lastOnlineAt) || null;
    this.since = Number(saved?.since) || Date.now();
    this.incidents = Array.isArray(saved?.incidents)
      ? saved.incidents.slice(-LOGIN_HISTORY_LIMIT)
      : [];
    /** 上一段观测里没关掉的那次掉线：说明重载/退出发生在掉线期间。 */
    this.carriedOpen = this.incidents.some((i) => !Number.isFinite(i?.endedAt));
    /** 最近拍的在线环境快照；掉线时用它和"当时"对比。 */
    this.environment = saved?.environment ?? null;
    this.account = saved?.account ?? null;
    this.alertError = '';
  }

  /**
   * 拍一张环境快照。
   *
   * 稳态下按 `loginEnvCacheMs` 缓存 —— 没必要每分钟去读磁盘；
   * 但状态迁移时 `force` 必须重拍，否则"掉线那一刻是什么版本"就没意义了。
   */
  captureEnvironment(force = false) {
    const now = Date.now();
    if (!force && this.environment && now - (this.environment.at ?? 0) < this.envCacheMs) {
      return this.environment;
    }
    try {
      // 账号目录优先用显式配置；没配就按"数据根 + QQ号"拼一个，
      // 这样兜底的"按最新推断"也才有目录可扫。
      this.environment = this.snapshot({
        qqntDir: this.config.qqntDir ?? '',
        account: this.account,
        accountDir: this.accountDirFor(this.account),
        dataRoot: this.config.qqntDataDir ?? '',
      });
    } catch (error) {
      this.environment = {
        at: now,
        account: this.account,
        qqnt: null,
        qqntPrevious: null,
        刚热更新: false,
        credentialMtimeMs: null,
        credentialPath: null,
        credentialFrom: 'none',
        note: '快照失败：' + String(error?.message ?? error),
      };
    }
    return this.environment;
  }

  /** 账号数据目录：`<数据根>\<QQ号>`，没有这层信息就返回空串。 */
  accountDirFor(account) {
    const explicit = String(this.config.loginAccountDir ?? '').trim();
    if (explicit) return explicit;
    const root = String(this.config.qqntDataDir ?? '').trim() || DEFAULT_QQ_DATA_ROOT;
    if (!account) return '';
    return path.join(root, String(account));
  }

  /**
   * 掉线/恢复各写一行 JSONL 到盘上。
   *
   * 为什么不能只打日志：账号掉线时**走 QQ 通知没有意义**（收消息的入口就是它自己），
   * 而 DSH 控制台的日志会随进程重启散掉。落一行文件，事后 `Get-Content` 一眼就看到。
   */
  writeAlert(kind, incident, extra = {}) {
    if (!this.alertEnabled || !this.alertPath) return;
    const record = {
      at: new Date(incident?.endedAt ?? incident?.startedAt ?? Date.now()).toISOString(),
      kind,
      cause: incident?.cause ?? null,
      reason: incident?.cause ? loginIncidentReason(incident.cause) : null,
      account: incident?.account ?? this.account ?? null,
      startedAt: incident?.startedAt ? new Date(incident.startedAt).toISOString() : null,
      endedAt: Number.isFinite(incident?.endedAt) ? new Date(incident.endedAt).toISOString() : null,
      offlineMs: Number.isFinite(incident?.offlineMs) ? incident.offlineMs : null,
      checks: incident?.checks ?? null,
      error: incident?.lastError ?? '',
      environment: incident?.environment ?? this.environment ?? null,
      ...extra,
    };
    try {
      fs.mkdirSync(path.dirname(this.alertPath), { recursive: true });
      fs.appendFileSync(this.alertPath, JSON.stringify(record) + '\n', 'utf8');
      this.alertError = '';
    } catch (error) {
      // 写盘失败不能反过来影响监视本身，但也不能装作没发生。
      this.alertError = String(error?.message ?? error);
      this.logger?.warn?.(`qq-bridge: 掉线提醒写入失败（${this.alertPath}）—— ${this.alertError}`);
    }
  }

  /**
   * 探测一次并把状态迁移记下来。
   *
   * 没到失败阈值时**不改变对外状态** —— 一次超时不等于掉线，
   * 否则报出来的"掉线"里会混进大量网络抖动。
   */
  async check(signal) {
    const probe = await this.probe(signal);
    const verdict = classifyLoginProbe(probe);
    this.lastProbeAt = probe.at ?? Date.now();
    if (probe.account) this.account = String(probe.account);

    if (verdict.status === 'online') {
      this.failures = 0;
      this.lastOnlineAt = this.lastProbeAt;
      const transition = this.status === 'online' ? null : 'recover';
      // 在线时顺手刷新环境快照：它是"健康的基线"，掉线时才有东西可比。
      this.captureEnvironment(transition === 'recover');
      const recovered = transition === 'recover' ? this.closeIncident(this.lastProbeAt) : null;
      this.status = 'online';
      this.cause = null;
      this.lastError = '';
      if (recovered) this.logRecovery(recovered);
      this.persist();
      return { transition, status: this.status, recovered };
    }

    if (verdict.status === 'offline') {
      this.failures = 0;
      // 明确离线：不用等阈值，这一次探测就算掉线。
      const transition = this.status === 'offline' ? null : 'drop';
      // 掉线那一刻必须重拍：缓存下来的"健康快照"正是要拿来对比的那个。
      this.captureEnvironment(true);
      const incident = this.markOffline(verdict.cause, verdict.error, this.lastProbeAt);
      this.status = 'offline';
      this.cause = verdict.cause;
      this.lastError = verdict.error;
      if (transition) this.logDrop(incident);
      this.persist();
      return { transition, status: this.status };
    }

    // 不可达 / 状态未知：攒够阈值才算一次掉线。
    this.failures += 1;
    this.lastError = verdict.error;
    const ready = this.failures >= this.failureThreshold;
    const missed = this.failureThreshold - this.failures;
    let transition = null;
    if (ready) {
      // 只有"从在线被判定为掉线"才算一次迁移；已经在掉线中的只是继续记录。
      transition = this.status === 'online' ? 'drop' : null;
      if (transition) this.captureEnvironment(true);
      const incident = this.markOffline(verdict.cause, verdict.error, this.lastProbeAt);
      this.status = 'offline';
      this.cause = verdict.cause;
      if (transition) this.logDrop(incident);
    } else if (this.logger?.warn) {
      this.logger.warn(
        `qq-bridge: 登录探测失败 ${this.failures}/${this.failureThreshold}` +
          `（再失败 ${missed} 次记为掉线）—— ${verdict.error}`,
      );
    }
    this.persist();
    return { transition, status: this.status };
  }

  /** 当前没关闭的那次掉线（null = 在线或还没掉过）。 */
  openIncident() {
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const item = this.incidents[i];
      if (item && !Number.isFinite(item.endedAt)) return item;
    }
    return null;
  }

  /**
   * 记下"进入不在线"。已经在不在线里就只刷新最近一次错误，
   * 不新建第二条 —— 否则一次掉线会被每次探测复制成几十条。
   */
  markOffline(cause, error, at) {
    const open = this.openIncident();
    if (open) {
      if (error) open.lastError = String(error).slice(0, 200);
      if (cause && cause !== 'unreachable') open.cause = cause;
      open.checks = (Number(open.checks) || 1) + 1;
      return open;
    }
    const incident = {
      startedAt: at,
      endedAt: null,
      cause: cause ?? 'unreachable',
      lastError: String(error ?? '').slice(0, 200),
      checks: 1,
      /** 掉线那一刻的环境快照：事后能回答"当时是哪个 QQNT build"。 */
      environment: this.environment ?? null,
    };
    this.incidents.push(incident);
    if (this.incidents.length > LOGIN_HISTORY_LIMIT) {
      this.incidents.splice(0, this.incidents.length - LOGIN_HISTORY_LIMIT);
    }
    this.recordEvent('drop', incident);
    return incident;
  }

  /** 关掉当前那次掉线，算出不可用时长。返回被关掉的那条（没有则 null）。 */
  closeIncident(at) {
    const open = this.openIncident();
    if (!open) return null;
    open.endedAt = at;
    open.offlineMs = Math.max(0, at - open.startedAt);
    this.recordEvent('recover', open);
    return open;
  }

  /**
   * 把日志变成你的"掉线记录"，而不是一条容易划过去的 warn。
   * 这里顺手把原因翻成人话 —— 看日志的人不该先学会 KickedOffLine 是什么意思。
   */
  logDrop(incident) {
    if (!incident) return;
    const versionNote = this.incidentVersionNote(incident);
    this.logger?.warn?.(
      `qq-bridge: [掉线] QQ 登录不在线 —— ${loginIncidentReason(incident.cause)}` +
        (incident.lastError ? `（${incident.lastError}）` : '') +
        '；恢复后需要重新扫码，桥接不会自动重登',
    );
    // 版本/票据这类环境信息单独一行：它是"为什么这次掉"的旁证，
    // 混在掉线告警里会被划过去。落盘的告警里也带同一份。
    this.logger?.info?.(`qq-bridge: [掉线环境] ${describeEnvironment(this.environment)}`);
    if (versionNote) this.logger?.warn?.(`qq-bridge: [掉线线索] ${versionNote}`);
    this.writeAlert('drop', incident, versionNote ? { versionNote } : {});
  }

  logRecovery(incident) {
    const minutes = Math.round((Number(incident?.offlineMs) || 0) / 60000);
    this.logger?.info?.(
      `qq-bridge: [掉线恢复] QQ 登录已重新在线（本次不可用约 ${minutes} 分钟）；` +
        `最近 ${this.incidents.length} 次掉线累计不可用 ` +
        `${Math.round(summarizeLoginHistory(this.incidents).offlineMs / 60000)} 分钟`,
    );
    const credentialRewritten =
      incident?.environment?.credentialMtimeMs != null &&
      this.environment?.credentialMtimeMs != null &&
      incident.environment.credentialMtimeMs !== this.environment.credentialMtimeMs;
    this.writeAlert('recover', incident, credentialRewritten ? { 票据已重写: true } : {});
  }

  /**
   * 这次掉线时和上一次"健康检查"之间，QQNT 版本变了吗？
   *
   * 用 QQNT 版本变化辅助分析接入端断线，不预设是哪种接入实现。
   * 只比对**版本**，不比对票据文件时间 —— 扫码本来就会重写票据，
   * 每次恢复都拿它当"线索"等于制造噪声（但恢复告警里会标出来供参考）。
   */
  incidentVersionNote(incident) {
    const env = incident?.environment;
    if (!env) return '';
    if (env.刚热更新) {
      return `QQNT 刚换过版本（${env.qqntPrevious} → ${env.qqnt}），注入与登录态容易重新洗牌；` +
        '建议关掉 QQ 自动更新后再观察频率。';
    }
    return '';
  }

  /**
   * 落的是一条**痕迹**，不是发送回执：掉线不该进 outbox（那会被当成待发送）。
   * conversation 用合成名，去重键用"开始时间+原因"，重放不会写重。
   */
  recordEvent(kind, incident) {
    this.store?.recordEvent?.({
      conversation: LOGIN_EVENT_CONVERSATION,
      kind: 'login-' + kind,
      dedupeKey: `login:${kind}:${incident.startedAt}:${incident.cause}`,
      payload: {
        startedAt: incident.startedAt,
        endedAt: incident.endedAt,
        cause: incident.cause,
        reason: loginIncidentReason(incident.cause),
        offlineMs: incident.offlineMs ?? null,
        error: incident.lastError ?? '',
        qqnt: incident.environment?.qqnt ?? null,
      },
      deliverable: false,
    });
  }

  persist() {
    this.store?.setState?.(
      LOGIN_STATE_KEY,
      JSON.stringify({
        status: this.status,
        cause: this.cause,
        lastError: this.lastError,
        failures: this.failures,
        lastProbeAt: this.lastProbeAt,
        lastOnlineAt: this.lastOnlineAt,
        since: this.since,
        account: this.account,
        environment: this.environment,
        incidents: this.incidents.slice(-LOGIN_HISTORY_LIMIT),
      }),
    );
  }

  /**
   * 自检读数。默认只给最近 10 次掉线，避免自检接口被历史撑爆；
   * `loginHistoryLimit: 0` 表示"全都要"。
   */
  report({ limit = 10 } = {}) {
    const summary = summarizeLoginHistory(this.incidents, this.lastProbeAt ?? Date.now());
    const keep = Number.isFinite(limit) && limit > 0
      ? this.incidents.slice(-limit)
      : this.incidents;
    return {
      开关: Boolean(this.config.loginWatchEnabled),
      当前: this.status,
      原因: this.cause ? loginIncidentReason(this.cause) : null,
      连续探测失败: this.failures,
      探测间隔秒: Math.round(this.intervalMs / 1000),
      失败阈值: this.failureThreshold,
      最后一次探测: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      最后一次在线: this.lastOnlineAt ? new Date(this.lastOnlineAt).toISOString() : null,
      观测起于: new Date(this.since).toISOString(),
      /**
       * 当前环境：QQNT build + 登录票据文件时间。
       *
       * 存在的意义是"事后可核对"：换 build、票据被重写，都是让登录重新洗牌的
       * 可疑因素，但过几天再翻日志没人记得当时是哪个版本。
       */
      环境: {
        说明: describeEnvironment(this.environment),
        账号: this.environment?.account ?? this.account ?? null,
        QQNT版本: this.environment?.qqnt ?? null,
        上一版本: this.environment?.qqntPrevious ?? null,
        刚热更新: this.environment?.刚热更新 ?? false,
        登录票据时间: this.environment?.credentialMtimeMs
          ? new Date(this.environment.credentialMtimeMs).toISOString()
          : null,
        票据来源: this.environment?.credentialFrom ?? 'none',
        票据根目录: this.environment?.credentialRoot ?? null,
        备注: this.environment?.qqntNote || this.environment?.note || '',
      },
      提醒: {
        开关: this.alertEnabled,
        文件: this.alertPath || null,
        最后写入失败: this.alertError || null,
      },
      统计: {
        掉线次数: summary.drops,
        已恢复: summary.recovered,
        当前掉线中: summary.open
          ? {
              开始: new Date(summary.open.startedAt).toISOString(),
              原因: loginIncidentReason(summary.open.cause),
              已持续秒: Math.round((Date.now() - summary.open.startedAt) / 1000),
            }
          : null,
        累计不可用分钟: Math.round(summary.offlineMs / 60000),
        最近一次掉线: summary.lastDropAt ? new Date(summary.lastDropAt).toISOString() : null,
        最近一次恢复: summary.lastRecoveredAt
          ? new Date(summary.lastRecoveredAt).toISOString()
          : null,
        平均可用秒: summary.avgStableMs != null ? Math.round(summary.avgStableMs / 1000) : null,
        平均不可用秒: summary.avgOfflineMs != null ? Math.round(summary.avgOfflineMs / 1000) : null,
      },
      历史: keep.map((i) => ({
        开始: new Date(i.startedAt).toISOString(),
        结束: Number.isFinite(i.endedAt) ? new Date(i.endedAt).toISOString() : null,
        原因: loginIncidentReason(i.cause),
        不可用秒: Number.isFinite(i.offlineMs) ? Math.round(i.offlineMs / 1000) : null,
        探测次数: i.checks ?? null,
        最近错误: i.lastError || null,
        // 掉线当时的 QQNT build：以后核对"是不是版本一换就掉"就靠这一列。
        QQNT版本: i.environment?.qqnt ?? null,
        掉线时刚热更新: i.environment?.刚热更新 ?? null,
      })),
      说明:
        '掉线由 QQ 服务端失效登录引起时，本机无法自动恢复，需在 QQ 客户端重新登录；' +
        '本模块只记录，不会自动重登。',
    };
  }
}

/**
 * 给自检接口用的快照。watch 缺省时也要给出**明确的**"未启用"，
 * 否则读的人会以为"没有这个功能"和"从来没掉过线"是一回事。
 */
export function loginSnapshot(loginWatch) {
  if (!loginWatch) return { 开关: false, 说明: '登录监视未启用' };
  try {
    return loginWatch.report();
  } catch (error) {
    return { 开关: true, 说明: '登录监视读取失败：' + String(error?.message ?? error) };
  }
}

function safeParse(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
