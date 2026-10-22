#!/usr/bin/env node
/**
 * 只读诊断：语义路由（bridge_routes）的失败原因分布与时序。
 *
 * 为什么要有这个工具：辅助判断层出问题时，`status.taskScheduler.routeFallbacks`
 * 只能给一个全局直方图，看不出"什么时候开始坏的""空输出占多少""detail 里到底是什么"。
 * 而 `bridge_routes` 是唯一保留逐条 `fallbackCause` / `fallbackDetail` 的地方。
 *
 * ⚠️ 只读，且**不碰线上库**：SQLite 在 WAL 模式下被运行中的桥接持有，
 * 直接打开会读到半写状态、甚至阻塞写入。这里先把 `.sqlite3` + `-wal` + `-shm`
 * 复制到系统临时目录，再以 readOnly 打开副本，退出时删掉临时目录。
 *
 * 用法：
 *   node tools/probe-routes.mjs                       # 自动定位库，看全量分布
 *   node tools/probe-routes.mjs --hours 6             # 只看最近 6 小时
 *   node tools/probe-routes.mjs --since '2026-10-19T22:43:00+08:00'
 *   node tools/probe-routes.mjs --db D:\Code\dsh-qq-bridge\data\qq-bridge.sqlite3
 *   node tools/probe-routes.mjs --json                # 机器可读（对比前后用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

function parseArgs(argv) {
  const options = { hours: null, since: null, until: null, db: null, json: false, samples: 4 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--hours') options.hours = Number(argv[++i]);
    else if (arg === '--since') options.since = String(argv[++i]);
    else if (arg === '--until') options.until = String(argv[++i]);
    else if (arg === '--db') options.db = String(argv[++i]);
    else if (arg === '--samples') options.samples = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('未知参数：' + arg);
  }
  return options;
}

/** 输入毫秒时间戳或可被 Date 解析的字符串，返回毫秒。 */
function toMillis(value, fallback = null) {
  if (value == null) return fallback;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 复制库（含 WAL/SHM）到临时目录，返回只读副本路径与清理函数。 */
function snapshotDatabase(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-probe-routes-'));
  const target = path.join(dir, 'db.sqlite3');
  let copied = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.copyFileSync(file + suffix, target + suffix);
      copied++;
    } catch { /* 没有 WAL/SHM 是正常情况 */ }
  }
  if (!copied) throw new Error('复制数据库失败：' + file);
  return { target, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const stamp = (ms) => (ms == null ? '-' : new Date(ms).toLocaleString('zh-CN', { hour12: false }));

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node tools/probe-routes.mjs [--hours N] [--since ISO] [--until ISO] [--db 路径] [--json]');
    return;
  }
  const source = resolveBridgeDb(options.db);
  if (!source) {
    console.error('找不到桥接数据库。用 --db 显式指定，或先启动一次桥接。');
    process.exitCode = 1;
    return;
  }
  const until = toMillis(options.until, Date.now());
  const since = toMillis(options.since,
    Number.isFinite(options.hours) ? until - options.hours * 3600 * 1000 : null);

  const snapshot = snapshotDatabase(source);
  const db = new DatabaseSync(snapshot.target, { readOnly: true });
  try {
    const where = since == null ? '' : 'WHERE created_at>=?';
    const params = since == null ? [] : [since];
    const bounded = since == null ? '' : ' AND created_at<=?';
    const boundedParams = since == null ? [] : [...params, until];

    const total = db.prepare(`SELECT COUNT(*) n FROM bridge_routes ${where}`).get(...params).n;
    if (!total) {
      console.log('这段时间里没有路由记录。');
      return;
    }
    const span = db.prepare(`SELECT MIN(created_at) a, MAX(created_at) b FROM bridge_routes ${where}`)
      .get(...params);

    /**
     * 失败原因直方图。`fallbackCause IS NULL` 表示成功（模型裁决能用或本地门控直接给出）。
     * 之所以把 `empty-output` 单列：它是"模型什么都没返回"，与"答了但 JSON 坏"
     * 完全是两类问题，混在一起就会像 2026-10 那次一样把诊断带偏。
     */
    const causes = db.prepare(`
      SELECT COALESCE(json_extract(data,'$.fallbackCause'),'ok') cause, COUNT(*) n
      FROM bridge_routes ${where} GROUP BY cause ORDER BY n DESC`).all(...params);
    const reasons = db.prepare(`
      SELECT COALESCE(json_extract(data,'$.reason'),'-') reason, COUNT(*) n
      FROM bridge_routes ${where} GROUP BY reason ORDER BY n DESC LIMIT 10`).all(...params);
    const hourly = db.prepare(`
      SELECT strftime('%Y-%m-%d %H', created_at/1000, 'unixepoch', '+8 hours') hour,
             COALESCE(json_extract(data,'$.fallbackCause'),'ok') cause, COUNT(*) n
      FROM bridge_routes ${where} GROUP BY hour, cause ORDER BY hour DESC LIMIT 60`).all(...params);
    // 失败详情样本：detail 里通常写着分片/reasoning/耗时/结束帧，是唯一的一手证据。
    const samples = db.prepare(`
      SELECT COALESCE(json_extract(data,'$.fallbackCause'),'ok') cause,
             COALESCE(json_extract(data,'$.fallbackDetail'),'') detail, COUNT(*) n
      FROM bridge_routes ${where} AND json_extract(data,'$.fallbackCause') IS NOT NULL
      GROUP BY cause, detail ORDER BY n DESC LIMIT ?`).all(...params, Math.max(1, options.samples));

    const failures = causes.filter((row) => row.cause !== 'ok').reduce((sum, row) => sum + row.n, 0);
    const empty = causes.find((row) => row.cause === 'empty-output')?.n ?? 0;
    const report = {
      database: source,
      copiedTo: snapshot.target,
      window: { since: since == null ? null : stamp(since), until: stamp(until) },
      span: { from: stamp(span.a), to: stamp(span.b) },
      total,
      failures,
      failureRate: Math.round((failures / total) * 1000) / 1000,
      emptyOutput: empty,
      emptyOutputShare: failures ? Math.round((empty / failures) * 1000) / 1000 : 0,
      causes,
      reasons,
      samples,
      hourly,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`库（只读副本）：${snapshot.target}`);
    console.log(`原始库：${source}`);
    console.log(`时间范围：${report.span.from} → ${report.span.to}` + (since == null ? '' : `（筛选后 ${report.window.since} → ${report.window.until}）`));
    console.log(`\n=== 失败原因（${total} 条，失败 ${failures} 条，失败率 ${(report.failureRate * 100).toFixed(1)}%）===`);
    for (const row of causes)
      console.log(`${String(row.n).padStart(6)}  ${String(row.cause).padEnd(16)} ${(row.n / total * 100).toFixed(1)}%`);
    console.log(`空输出 ${empty} 条 = 全部失败的 ${(report.emptyOutputShare * 100).toFixed(1)}%`);
    console.log('\n=== reason 分布 ===');
    for (const row of reasons) console.log(`${String(row.n).padStart(6)}  ${row.reason}`);
    console.log('\n=== 失败详情样本（按出现次数）===');
    if (!samples.length) console.log('（无失败记录）');
    for (const row of samples) console.log(`${String(row.n).padStart(4)}× ${row.cause}: ${String(row.detail).slice(0, 220) || '(空)'}`);
    console.log('\n=== 按小时（本地 +8）===');
    for (const row of hourly) console.log(`${row.hour}  ${String(row.cause).padEnd(16)} ${row.n}`);
  } finally {
    db.close();
    snapshot.cleanup();
  }
}

main();
