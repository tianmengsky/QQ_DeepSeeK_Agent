#!/usr/bin/env node
/**
 * 清理 QQ 桥接产生的「未分组」会话窗口。
 *
 * 背景：桥接按提示词预算轮换 Session，每轮换一次就在 sessions 目录里留下一个
 * 小会话。实测攒了 600+ 个，DSH 界面（按工作区分组时）把它们全塞进「未分组」，
 * 既拖慢渲染，也干扰语义聚合系统的调试。
 *
 * 为什么不直接用 clean-qq-sessions.ps1：
 *   1. 它只认 `session.v4.jsonl.zstd`，旧格式 `session.jsonl.zstd` 会漏掉；
 *   2. 它按工作区目录名匹配、只覆盖桥接自己那个工作区，管不到
 *      `~/.dsh/qq-workspaces/<会话>` 这些每会话工作区；
 *   3. 它不区分「仍被桥接使用」的会话，`-KeepDays 0` 时连当前活跃窗口一起删。
 *
 * 判定「未分组」的口径与 DSH 界面一致（app.asar 里 ungroupedMemberIds）：
 *   未分组 = 磁盘上的会话 − 任何 workspace.json 里登记的 sessionIds
 *
 * 在此基础上本脚本只删**桥接自己产生**的那些，并且保护：
 *   · 环境变量 DSH_SESSION_ID（当前会话）
 *   · 桥接 runtime_state 里各 QQ 会话当前绑定的 sessionId（活跃窗口）
 *   · 仍在 queued/running/recovering/needs_attention 等非终态的任务、执行、worker 引用到的会话
 *   · 最近 --mtime-guard-min 分钟内改动过的会话（防止动到正在写的）
 * 用户自己项目工作区（D:\Code\... 等）里未被登记的会话一律不碰 —— 那是真实对话历史。
 *
 * 桥接工作区只认两个来源，避免把别的目录误判成桥接产物：
 *   1. `~/.dsh/qq-workspaces/**`（conversation-workspace-v2 之后的每会话工作区）
 *   2. profile 里 qq-bridge 插件自己配的 `cwd`（v2 之前的共享工作区，即 legacy 目录）
 *
 * 删除方式：**移动到隔离目录**，不是抹掉，所以随时可还原。
 *
 * 用法：
 *   node tools/clean-ungrouped-sessions.mjs                 预演（默认，不动任何文件）
 *   node tools/clean-ungrouped-sessions.mjs --apply         移动到隔离目录
 *   node tools/clean-ungrouped-sessions.mjs --restore       把最近一次隔离的内容还原回去
 *   node tools/clean-ungrouped-sessions.mjs --purge         彻底删除隔离目录（不可恢复）
 *
 * 可选参数：
 *   --db <path>              指定桥接 SQLite；默认自动在 profile 配的 cwd/stateDir 里找
 *   --legacy-cwd <path>      legacy 共享工作区；默认从 profile 的 qq-bridge 段读取
 *   --keep <sessionId>       额外保护某个会话（可重复）
 *   --mtime-guard-min <n>    最近 n 分钟内改动过的会话不删，默认 15
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bridgeBlock, resolveBridgeDb } from './db-path.mjs';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const repeated = (flag) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  return out;
};

const APPLY = has('--apply');
const RESTORE = has('--restore');
const PURGE = has('--purge');
const MTIME_GUARD_MIN = Number(value('--mtime-guard-min', '15'));
const EXTRA_KEEP = new Set(repeated('--keep'));

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const QUARANTINE_ROOT = path.join(DSH_HOME, 'session-quarantine');
const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd'];

const MB = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';
const say = (text = '', color = '') => {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
  const open = color && codes[color] ? `\u001b[${codes[color]}m` : '';
  console.log(open + text + (open ? '\u001b[0m' : ''));
};

/**
 * 复刻 DSH 的工作区目录转义。规则是实测出来的，已对全部 12 个真实工作区目录
 * 逐一验证吻合：
 *   · 盘符的 `:` 直接**丢掉**（`C:\Users` → `C-Users`，不是 `C--Users`）
 *   · 保留 `[A-Za-z0-9._-]`
 *   · 其余 ASCII（`\` `/` 等）变 `-`
 *   · 非 ASCII 按 UTF-16 码元写成 `~XXXX`
 *   · 前后各包一对 `-`
 *   D:\作业\计算机组成原理 → --D-~4F5C~4E1A-~8BA1~7B97~673A~7EC4~6210~539F~7406--
 */
function escapeWorkspaceDir(target) {
  let out = '';
  for (const ch of target.replaceAll('/', '\\')) {
    if (ch === ':') continue;
    if (ch.codePointAt(0) > 127) {
      for (let i = 0; i < ch.length; i++) out += '~' + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    } else if (/[A-Za-z0-9._-]/.test(ch)) out += ch;
    else out += '-';
  }
  return '--' + out + '--';
}

/** legacy 共享工作区：v2 之前会话 cwd 直接等于这个目录。 */
function legacyWorkspaceDir() {
  const explicit = value('--legacy-cwd', '');
  if (explicit) return explicit.replaceAll('/', path.sep);
  const m = bridgeBlock().match(/^\s*cwd:\s*'([^']+)'/m);
  return m ? m[1].replaceAll('/', path.sep) : '';
}

/** 扫出磁盘上所有会话目录，兼容 v4 与旧格式。 */
function scanSessions() {
  const sessions = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return sessions;
  for (const wsDir of fs.readdirSync(SESSIONS_ROOT)) {
    const wsPath = path.join(SESSIONS_ROOT, wsDir);
    let wsStat; try { wsStat = fs.statSync(wsPath); } catch { continue; }
    if (!wsStat.isDirectory()) continue;
    for (const sessionId of fs.readdirSync(wsPath)) {
      const dir = path.join(wsPath, sessionId);
      let inner; try { inner = fs.readdirSync(dir); } catch { continue; }
      if (!inner.some((f) => SESSION_FILES.includes(f))) continue;
      let bytes = 0, mtimeMs = 0;
      for (const f of inner) {
        try {
          const st = fs.statSync(path.join(dir, f));
          bytes += st.size;
          mtimeMs = Math.max(mtimeMs, st.mtimeMs);
        } catch { /* 读不到按 0 算 */ }
      }
      // 用会话文件自身的最近写入时间，不用工作区目录的 —— 目录时间会随任何新会话变动
      sessions.push({ wsDir, sessionId, dir, bytes, mtimeMs, legacyFormat: !inner.includes(SESSION_FILES[0]) });
    }
  }
  return sessions;
}

/** 收集必须保留的会话 id：当前会话 + 桥接在用 + 非终态任务引用。 */
function collectProtected(dbPath) {
  const protect = new Map();
  const add = (id, why) => { if (id && !protect.has(id)) protect.set(id, why); };
  add(process.env.DSH_SESSION_ID, '当前 DSH 会话');

  if (!dbPath) return protect;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    say(`  ⚠ 读不到桥接数据库（${error.message}）—— 只保护当前会话`, 'yellow');
    return protect;
  }
  try {
    for (const row of db.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'qq-bridge:conversation:%'").all()) {
      try {
        const state = JSON.parse(row.value);
        add(state.sessionId, '活跃窗口 ' + row.key.replace('qq-bridge:conversation:', ''));
      } catch { /* 坏记录跳过 */ }
    }
    const sources = [
      ["SELECT data AS v FROM bridge_workers WHERE state IN ('queued','starting','running','needs_attention')", '进行中 worker'],
      ["SELECT data AS v FROM bridge_executions WHERE state IN ('queued','starting','following','recovering')", '进行中执行'],
      ["SELECT meta AS v FROM bridge_tasks WHERE state IN ('queued','submitted','running','recovering','waiting_input','needs_attention')", '进行中任务'],
    ];
    for (const [sql, why] of sources) {
      let rows = [];
      try { rows = db.prepare(sql).all(); } catch { continue; }
      for (const row of rows) {
        for (const m of String(row.v ?? '').matchAll(/session-[0-9a-f-]{36}/g)) add(m[0], why);
      }
    }
  } finally { try { db.close(); } catch { /* 已关 */ } }
  return protect;
}

function quarantineDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(QUARANTINE_ROOT, stamp);
}

function latestQuarantine() {
  if (!fs.existsSync(QUARANTINE_ROOT)) return null;
  return fs.readdirSync(QUARANTINE_ROOT)
    .map((n) => path.join(QUARANTINE_ROOT, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

/**
 * 读隔离目录的清单。优先用完整 manifest.json；若上次是中途被打断的（没有
 * manifest.json），退回逐条追加的 manifest.jsonl —— 每移动成功一个就写一行，
 * 所以任何时刻中断都能还原。
 */
function readManifest(dir) {
  const full = path.join(dir, 'manifest.json');
  if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf8'));
  const journal = path.join(dir, 'manifest.jsonl');
  if (!fs.existsSync(journal)) return null;
  const moved = fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { interrupted: true, moved };
}

function restore() {
  const from = latestQuarantine();
  if (!from) { say('没有找到任何隔离目录，无需还原。', 'yellow'); return 0; }
  const manifest = readManifest(from);
  if (!manifest?.moved?.length) { say(`隔离目录里没有清单：${from}`, 'red'); return 1; }
  say('');
  say('  还原上一次隔离的会话', 'cyan');
  say(`  来源：${from}${manifest.interrupted ? '（上次中断，按逐条日志还原）' : ''}`, 'gray');
  say('');
  let done = 0, skipped = 0, failed = 0;
  for (const item of manifest.moved) {
    try {
      if (fs.existsSync(item.original)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(item.original), { recursive: true });
      fs.renameSync(item.stored, item.original);
      done++;
    } catch (error) {
      failed++;
      say(`    还原失败 ${item.sessionId} —— ${error.message}`, 'red');
    }
  }
  say(`  已还原 ${done} 个，已存在跳过 ${skipped} 个${failed ? `，失败 ${failed} 个` : ''}`, 'green');
  say('');
  return failed ? 1 : 0;
}

function purge() {
  const from = latestQuarantine();
  if (!from) { say('没有找到任何隔离目录。', 'yellow'); return 0; }
  const manifest = readManifest(from);
  say('');
  say(`  将彻底删除隔离目录（${manifest?.moved?.length ?? '?'} 个会话）：${from}`, 'red');
  say('  这一步不可恢复。', 'red');
  fs.rmSync(from, { recursive: true, force: true });
  say('  已删除。', 'green');
  say('');
  return 0;
}

/** 明确告诉用户：哪些真实项目会话是「未分组」但**故意没删**的。 */
function showUserSessions(sessions, accounted) {
  const kept = sessions.filter((s) => !s.isBridge && !accounted.has(s.sessionId));
  if (!kept.length) return;
  const byWs = {};
  for (const s of kept) byWs[s.wsDir] = (byWs[s.wsDir] ?? 0) + 1;
  say(`  你真实项目里「未分组」但未被删除的会话：${kept.length} 个（${MB(kept.reduce((n, s) => n + s.bytes, 0))}）`, 'cyan');
  for (const [ws, n] of Object.entries(byWs).sort((a, b) => b[1] - a[1])) say(`    ${String(n).padStart(4)}  ${ws}`, 'gray');
  say('');
}

function main() {
  if (RESTORE) return restore();
  if (PURGE) return purge();

  const registry = JSON.parse(fs.readFileSync(path.join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'));
  const accounted = new Set();
  for (const ws of Object.values(registry.tables?.workspaces ?? {})) {
    for (const id of ws.sessionIds ?? []) accounted.add(id);
  }

  const dbPath = resolveBridgeDb(value('--db', ''));
  const legacyDir = legacyWorkspaceDir();
  const qqPrefix = escapeWorkspaceDir(path.join(DSH_HOME, 'qq-workspaces')).slice(0, -2);
  const legacyName = legacyDir ? escapeWorkspaceDir(legacyDir) : '';

  const sessions = scanSessions();
  for (const s of sessions) {
    s.isBridge = s.wsDir.startsWith(qqPrefix) || (legacyName !== '' && s.wsDir === legacyName);
  }
  // 自检：转义规则一旦失配就会「一个都匹配不到」，那种情况下宁可不删也不能误判。
  const qqDirs = new Set(sessions.filter((s) => s.wsDir.startsWith(qqPrefix)).map((s) => s.wsDir));
  if (qqDirs.size === 0) {
    say('  ✗ 没有匹配到任何 `qq-workspaces` 会话目录 —— 转义规则可能已变，中止以免误删', 'red');
    return 1;
  }
  if (legacyName !== '' && !fs.existsSync(path.join(SESSIONS_ROOT, legacyName))) {
    say(`  ⚠ legacy 工作区目录不存在，本次不处理它：${legacyName}`, 'yellow');
  }

  const protect = collectProtected(dbPath);
  const now = Date.now();
  const targets = [], skipped = [];
  for (const s of sessions) {
    if (accounted.has(s.sessionId)) continue;                       // 已归属某个工作区
    if (protect.has(s.sessionId)) { skipped.push([s, protect.get(s.sessionId)]); continue; }
    if (EXTRA_KEEP.has(s.sessionId)) { skipped.push([s, '--keep']); continue; }
    if (now - s.mtimeMs < MTIME_GUARD_MIN * 60000) { skipped.push([s, `最近 ${MTIME_GUARD_MIN} 分钟内改动过`]); continue; }
    if (!s.isBridge) continue;                                      // 用户自己项目的会话，不碰
    targets.push(s);
  }

  const bytes = targets.reduce((n, s) => n + s.bytes, 0);
  const byWs = {};
  for (const s of targets) byWs[s.wsDir] = (byWs[s.wsDir] ?? 0) + 1;

  say('');
  say('  ============================================================', 'cyan');
  say('    QQ 桥接「未分组」会话清理', 'cyan');
  say('  ============================================================', 'cyan');
  say('');
  say(`  会话目录        ${SESSIONS_ROOT}`);
  say(`  桥接数据库      ${dbPath ?? '(未找到，仅保护当前会话)'}`);
  say(`  legacy 工作区   ${legacyDir || '(profile 里没读到，将只处理每会话工作区)'}`);
  say('');
  say(`  磁盘会话总数    ${sessions.length}  （其中旧格式 ${sessions.filter((s) => s.legacyFormat).length} 个）`);
  say(`  已分组          ${sessions.filter((s) => accounted.has(s.sessionId)).length}`);
  say(`  桥接产生未分组  ${sessions.filter((s) => s.isBridge && !accounted.has(s.sessionId)).length}`);
  say('');
  say(`  本次目标        ${targets.length} 个，${MB(bytes)}`, 'yellow');
  say(`  受保护跳过      ${skipped.length} 个`, 'green');
  say('');
  say('  来源分布：', 'gray');
  for (const [ws, n] of Object.entries(byWs).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    say(`    ${String(n).padStart(4)}  ${ws}`, 'gray');
  }
  if (skipped.length) {
    say('');
    say('  受保护（保留）：', 'green');
    for (const [s, why] of skipped.slice(0, 20)) say(`    ${s.sessionId}  ${why}`, 'green');
    if (skipped.length > 20) say(`    …另有 ${skipped.length - 20} 个`, 'green');
  }
  say('');

  if (!APPLY) {
    say('  【预演模式】没有移动任何文件。', 'yellow');
    say('  确认无误后执行：', 'yellow');
    say('      node tools/clean-ungrouped-sessions.mjs --apply', 'yellow');
    say('');
    showUserSessions(sessions, accounted);
    return 0;
  }

  if (!targets.length) { say('  没有需要清理的会话。', 'green'); say(''); return 0; }

  const dest = quarantineDir();
  const journal = path.join(dest, 'manifest.jsonl');
  fs.mkdirSync(dest, { recursive: true });
  const moved = [];
  let failed = 0;
  for (const s of targets) {
    const stored = path.join(dest, s.wsDir, s.sessionId);
    try {
      fs.mkdirSync(path.dirname(stored), { recursive: true });
      fs.renameSync(s.dir, stored);
      const entry = { sessionId: s.sessionId, wsDir: s.wsDir, original: s.dir, stored, bytes: s.bytes };
      moved.push(entry);
      // 先落盘再继续：中途被打断也留得下可还原的逐条记录
      fs.appendFileSync(journal, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
      failed++;
      say(`    移动失败 ${s.sessionId} —— ${error.message}`, 'red');
    }
  }
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    sessionsRoot: SESSIONS_ROOT,
    dbPath,
    legacyDir,
    movedCount: moved.length,
    failedCount: failed,
    moved,
  }, null, 2), 'utf8');

  say(`  已移动到隔离目录：${dest}`, 'green');
  say(`  移动 ${moved.length} 个，失败 ${failed} 个，共 ${MB(moved.reduce((n, m) => n + m.bytes, 0))}`, 'green');
  say('');
  say('  还原：node tools/clean-ungrouped-sessions.mjs --restore', 'gray');
  say('  确认无误后彻底删除：node tools/clean-ungrouped-sessions.mjs --purge', 'gray');
  say('');
  showUserSessions(sessions, accounted);
  return failed ? 1 : 0;
}

process.exitCode = main();
