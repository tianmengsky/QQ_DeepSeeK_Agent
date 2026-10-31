/**
 * DSH 崩溃保护。
 *
 * 为什么需要（2026-10-31 事故）：DSH 桌面端起不来，弹窗只说
 * `desktop welcome: Web authentication failed`。根因不在插件、不在 profile：
 * 它每次启动都会往 Chromium 的 cookie 库里写一个 `dsh-auth-<随机>`，
 * cookie 是按**域名**存的而启动端口每次都变，旧的那些从来不删 —— 本机堆到 71 个，
 * 于是每次请求都带着 71 个历史令牌，服务端认不出来就回非 2xx，启动直接失败。
 * 更坏的是它**没有自愈**：点"关闭第三方插件并重启"也没用，因为问题在 web 认证层，
 * 比插件早得多。
 *
 * 所以这个文件只做三件小而确定的事：
 *   1. status  —— 一眼看清"现在该不该担心"（DSH 活着没有、认证 cookie 堆了多少、上次怎么崩的）
 *   2. prune   —— 在 **DSH 没跑** 时把 `127.0.0.1` 的 `dsh-auth-*` 清掉（先备份）
 *   3. watch   —— 守护循环：DSH 掉了就 prune 一次再拉起来，带退避，不无限重试
 *
 * 约定：只在 DSH 未运行时动 cookie 库 —— Chromium 开着库的时候写它，轻则改动丢失，
 * 重则把库写坏。所以 prune 自己会先判活，判不了就拒绝。
 *
 * 用法：
 *   node tools/dsh-guard.mjs status            看状态
 *   node tools/dsh-guard.mjs prune             清一次（默认全清）
 *   node tools/dsh-guard.mjs prune --keep 1    只留最新 1 个（保守模式）
 *   node tools/dsh-guard.mjs watch             守护：掉了就拉起
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probe, readConfig } from './console.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

/** DSH 桌面端的 Chromium userData 目录；`--user-data-dir` 换过就用 QQ_DSH_USERDATA 指定。 */
export function userDataDir(env = process.env) {
  if (env.QQ_DSH_USERDATA) return env.QQ_DSH_USERDATA;
  const roaming = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(roaming, '@deepseek-ai', 'dsh-desktop');
}

const cookiesPath = (env) => path.join(userDataDir(env), 'Network', 'Cookies');

/**
 * 惰性拿 `node:sqlite`。
 *
 * 不放在顶层 import：它现在还是 experimental，加载就会打 ExperimentalWarning，
 * 而 `status`（只看一眼）没必要为此污染输出。真要用库的时候才拿。
 */
function sqlite() {
  return createRequire(import.meta.url)('node:sqlite');
}

/** 只读打开，绝不锁库。 */
function openRead(file) {
  const { DatabaseSync } = sqlite();
  // readBigInts：Chromium 的时间戳是 1601 年以来的**微秒**，约 1.34e16，
  // 超过 JS 的安全整数范围。不开这个选项，读 min/max 会直接抛 ERR_OUT_OF_RANGE。
  return new DatabaseSync(file, { readOnly: true, readBigInts: true });
}

const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-').slice(0, 19);

const CHROME_EPOCH = Date.UTC(1601, 0, 1);
/** Chromium 的时间戳是"1601 年以来的微秒"，换成人能读的时间。 */
function chromeTime(micros) {
  if (micros == null) return null;
  // 可能是 BigInt（readBigInts）也可能是 number，两种都收。
  const us = typeof micros === 'bigint' ? micros : BigInt(Math.round(Number(micros)));
  return new Date(CHROME_EPOCH + Number(us / 1000n));
}

/**
 * cookie 库的现状。
 *
 * `authCookies` 是那条真正的指标：它只增不减。一次启动 = 一个 cookie，
 * 堆到几十个就会让 DSH 自己登不进自己的 Host。
 */
export function cookieStats(env = process.env) {
  const file = cookiesPath(env);
  if (!fs.existsSync(file)) return { available: false, file, total: 0, authCookies: 0 };
  /**
   * 先用一个普通文件句柄探一下独占情况，再决定要不要碰 SQLite。
   *
   * 不只是省事：DSH 在跑时 Chromium 独占这个库（连只读都打不开），
   * 而加载 `node:sqlite` 会打一条 ExperimentalWarning。常在的调用路径是
   * "DSH 正在跑，只想看一眼"，先在 fs 层判掉，输出才干净。
   */
  const locked = (() => {
    let handle;
    try { handle = fs.openSync(file, 'r+'); return false; }
    catch { return true; }
    finally { if (handle !== undefined) fs.closeSync(handle); }
  })();
  if (locked) return { available: false, locked: true, file, total: null, authCookies: null };
  let db;
  try {
    db = openRead(file);
  } catch (error) {
    return { available: false, locked: true, file, total: null, authCookies: null,
      error: String(error?.message ?? error) };
  }
  try {
    const total = Number(db.prepare('SELECT count(*) AS n FROM cookies').get()?.n ?? 0);
    const auth = db.prepare("SELECT count(*) AS n, min(creation_utc) AS first, max(creation_utc) AS last FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%'").get();
    const hosts = db.prepare('SELECT host_key, count(*) AS n FROM cookies GROUP BY host_key ORDER BY n DESC LIMIT 5').all();
    return {
      available: true,
      file,
      total,
      authCookies: Number(auth?.n ?? 0),
      oldest: chromeTime(auth?.first),
      newest: chromeTime(auth?.last),
      hosts: hosts.map((row) => ({ host: row.host_key, count: Number(row.n) })),
    };
  } finally {
    db.close();
  }
}

/**
 * 删除堆积的认证 cookie。
 *
 * 为什么默认全删而不是"留最新的一个"：DSH 每次启动都会自己写新的，
 * 旧的没有任何复用价值；留一个反而要证明"服务端认它"，没必要冒险。
 * `keep` 只给"想保守一点"的场合用。
 */
export function pruneAuthCookies({ keep = 0, env = process.env, dryRun = false } = {}) {
  const file = cookiesPath(env);
  if (!fs.existsSync(file)) return { ok: false, reason: '没有 cookie 库（DSH 还没启动过？）', removed: 0 };
  const before = cookieStats(env);
  if (before.locked) return { ok: false, locked: true, removed: 0,
    reason: 'DSH 正在运行，Chromium 独占着 cookie 库 —— 先关掉 DSH 再清' };
  if (!before.authCookies) return { ok: true, removed: 0, total: before.total, backup: null };
  // 先读出要删的 rowid（读连接用完就关，别让它占着库）。
  const reader = openRead(file);
  let rows;
  try {
    rows = reader.prepare("SELECT rowid, creation_utc FROM cookies WHERE host_key='127.0.0.1' AND name LIKE 'dsh-auth-%' ORDER BY creation_utc DESC").all();
  } finally {
    reader.close();
  }
  const doomed = rows.slice(Math.max(0, keep)).map((row) => Number(row.rowid));
  if (!doomed.length) return { ok: true, removed: 0, total: before.total, backup: null };
  if (dryRun) return { ok: true, removed: doomed.length, dryRun: true, backup: null };

  const backup = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, backup);
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    const statement = db.prepare('DELETE FROM cookies WHERE rowid=?');
    for (const id of doomed) statement.run(id);
    db.exec('COMMIT');
    db.exec('VACUUM');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 已经不在事务里 */ }
    db.close();
    return { ok: false, error: String(error?.message ?? error), removed: 0, backup };
  }
  db.close();
  // 备份只留最近 3 份：这个库可能几十 MB，长期堆着没有意义。
  const dir = path.dirname(file);
  const old = fs.readdirSync(dir).filter((name) => name.startsWith('Cookies.bak-')).sort().reverse();
  for (const name of old.slice(3)) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* 被占用就下次再删 */ }
  }
  const after = cookieStats(env);
  return { ok: true, removed: doomed.length, total: after.total, authCookies: after.authCookies, backup };
}

/** 最近一次崩溃：文件、时间、错误行、以及一句人话的判断。 */
export function lastCrash(env = process.env) {
  const dir = path.join(userDataDir(env), 'logs');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((name) => /^crash-.*\.log$/.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!files.length) return null;
  const file = path.join(dir, files[0].name);
  const text = fs.readFileSync(file, 'utf8');
  const error = (text.match(/^(?:Error|CordisError|DesktopHostFatalError):.*$/m) ?? [])[0] ?? '（日志里没写错误行）';
  const phase = (text.match(/^phase:\s*(.*)$/m) ?? [])[1] ?? '?';
  /** 三种已知形态分开说，因为修法完全不同。 */
  const kind = /Web authentication failed/.test(error) ? 'auth'
    : /INACTIVE_EFFECT|inactive context/.test(error) ? 'reload-race'
      : 'other';
  return { file, name: files[0].name, at: new Date(files[0].at), phase, error, kind };
}

const KIND_TEXT = {
  auth: '本地 web 认证失败 —— 典型成因是 cookie 库里堆了太多 dsh-auth-*（跑 prune 即可）',
  'reload-race': '插件热重载竞态（cordis INACTIVE_EFFECT）—— 配置刚被改过或同时启动了多份 DSH',
  other: '其他错误，看日志原文',
};

/** 给 start-dsh.ps1 用的入口：DSH 没在跑才清，且绝不因为清理失败而拦启动。 */
export function pruneIfIdle({ env = process.env, keep = 0 } = {}) {
  return (async () => {
    const config = readConfig(env, project);
    const state = await probe(config, {}).catch(() => null);
    if (state?.dsh?.running) return { skipped: 'DSH 正在运行，不动它的 cookie 库', removed: 0 };
    return pruneAuthCookies({ env, keep });
  })();
}

/* ── 守护 ─────────────────────────────────────────────────────────────── */

const LOG = () => process.env.QQ_DSH_WATCH_LOG || path.join(os.tmpdir(), 'qq-dsh-watch.log');

function log(text) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`;
  console.log(line);
  try { fs.appendFileSync(LOG(), line + '\n'); } catch { /* 日志写不了不影响守护 */ }
}

function launchDsh() {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(project, 'tools', 'start-dsh.ps1')], {
    cwd: project, encoding: 'utf8', timeout: 240000, windowsHide: true,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  for (const line of output.split(/\r?\n/).filter(Boolean)) log('  ' + line);
  return result.status === 0;
}

/**
 * 守护循环。
 *
 * 刻意保守：DSH 在线时只做一次轻量探活（30 秒一次），掉线才动手；
 * 连续失败按 30s → 1m → 2m → 5m 退避，避免"起不来就疯狂重试"把机器拖死。
 * 它**不**替你决定停掉 DSH —— 只负责把掉下去的那一截接回来。
 */
export async function watch({ intervalMs = 30000, env = process.env } = {}) {
  const config = readConfig(env, project);
  const cache = { at: 0, value: null };
  const bridgeCache = { at: 0, url: '', value: null };
  let failures = 0;
  const ladder = [30000, 60000, 120000, 300000];
  log(`守护开始：每 ${Math.round(intervalMs / 1000)} 秒探一次；日志 ${LOG()}`);
  for (;;) {
    const state = await probe(config, { cache, bridgeCache }).catch(() => null);
    const alive = Boolean(state?.dsh?.running);
    if (alive) {
      if (failures) log('DSH 回来了');
      failures = 0;
    } else {
      const wait = ladder[Math.min(failures, ladder.length - 1)];
      log(`DSH 不在${failures ? `（连续第 ${failures + 1} 次尝试，上次失败后等 ${wait / 1000}s）` : ''}`);
      const pruned = await pruneAuthCookies({ env }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (pruned.removed) log(`清理了 ${pruned.removed} 个堆积的 dsh-auth-* cookie（备份 ${pruned.backup ?? '无'}）`);
      else if (pruned.error) log('清理 cookie 失败：' + pruned.error);
      const ok = launchDsh();
      log(ok ? 'DSH 已拉起' : '拉起失败，等下一轮');
      if (!ok) {
        failures += 1;
        await new Promise((resolve) => setTimeout(resolve, ladder[Math.min(failures, ladder.length - 1)]));
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const flag = (name, fallback) => {
    const index = rest.findIndex((item) => item === `--${name}`);
    return index >= 0 ? rest[index + 1] : fallback;
  };
  if (command === 'status') {
    const cookies = cookieStats();
    console.log(`cookie 库：${cookies.available ? cookies.file : (cookies.locked ? `${cookies.file}（DSH 正在运行，被独占）` : '（不存在）')}`);
    if (cookies.locked) {
      console.log('  dsh-auth-* 堆积：暂时读不到 —— 关掉 DSH 后再看/清理');
    } else if (cookies.available) {
      console.log(`  dsh-auth-* 堆积：${cookies.authCookies} 个${cookies.authCookies >= 10 ? '  ← 到几十个就会让启动失败' : ''}`);
      if (cookies.authCookies) console.log(`  最早 ${cookies.oldest?.toLocaleString('zh-CN')} / 最新 ${cookies.newest?.toLocaleString('zh-CN')}`);
    }
    const crash = lastCrash();
    if (crash) {
      console.log(`最近崩溃：${crash.at.toLocaleString('zh-CN')}（${crash.phase}）`);
      console.log(`  ${crash.error}`);
      console.log(`  判断：${KIND_TEXT[crash.kind]}`);
    } else {
      console.log('最近崩溃：没有记录');
    }
  } else if (command === 'prune') {
    pruneIfIdle({ keep: Number(flag('keep', '0')) || 0 }).then((result) => {
      if (result.skipped) { console.log(result.skipped); return; }
      if (result.locked) { console.log(result.reason); return; }
      if (!result.ok) { console.error('清理失败：' + (result.error ?? result.reason)); process.exitCode = 1; return; }
      console.log(result.removed
        ? `清掉 ${result.removed} 个 dsh-auth-*（备份 ${result.backup}），剩下 ${result.total} 个 cookie`
        : '没有需要清理的认证 cookie');
    });
  } else if (command === 'watch') {
    watch({ intervalMs: (Number(flag('interval', '30')) || 30) * 1000 }).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  } else {
    console.log('用法：node tools/dsh-guard.mjs [status|prune [--keep N]|watch [--interval 30]]');
    process.exitCode = 1;
  }
}
