#!/usr/bin/env node
/**
 * 记忆迁移：把 aux 时代提炼的 `.facts` 迁进 SQLite 记事本，并清空旧档。
 *
 * 为什么需要：
 *   `lib/memory/facts.mjs` 的 `.facts/*.json` 是"后台提炼器"的产物。2026-10-22
 *   关掉提炼器（`memoryAutoExtract: false`）之后它不再新增，但**历史记录仍在注入**
 *   —— `memoryBlocks` 里的 `activeFacts('user:' + qq)` 照样读它。于是同一份"记忆"
 *   同时存在两套来源：agent 写的（可版本、可 forget）和提炼器写的（只能按消息撤回）。
 *
 *   本脚本把这些历史事实搬进 `bridge_agent_memories`（kind=note），它们从此和
 *   agent 自己写的条目一样可修订、可忘记、可查版本；随后清空 `.facts`，只保留
 *   `_withdrawn` 这个**运行时仍在用**的撤回索引。
 *
 * 安全设计：
 *   · 默认 dry-run，只报告不动数据；必须显式 `--apply`。
 *   · 动手前整目录备份到 `memory/.facts.bak-<时间戳>/`。
 *   · `.facts` 里的 `_withdrawn` **永不删除**：`facts.withdrawn()` 仍被
 *     `agent.active()` / `activeNotes()` 用来判断"依据消息是否已撤回"，
 *     删了会让撤回失效（群友撤回消息后她的笔记还留着）。
 *   · 与 agent 已写过的同 subject+slot 冲突时**跳过迁移**，agent 版本优先。
 *
 * 用法：
 *   node tools/migrate-memory-v2.mjs                    # 只报告
 *   node tools/migrate-memory-v2.mjs --apply            # 备份 → 迁移 → 清空
 *   node tools/migrate-memory-v2.mjs --apply --db D:\...\qq-bridge.sqlite3
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const SLOT_RE = /^[a-z][a-z0-9_.-]{0,79}$/u;
const MAX_TEXT = 600;

function parseArgs(argv) {
  const options = { apply: false, db: null, memoryDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--db') options.db = String(argv[++i]);
    else if (arg === '--memory') options.memoryDir = String(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('未知参数：' + arg);
  }
  return options;
}

const clip = (text, size) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

/**
 * `.facts` 的 subject 是 `user:<qq>` / `group:<gid>`。
 *
 * 记事本的 subject 约定不同：人物本用**纯 QQ 号**（因为 `syncDocument` 要按
 * `memory/<qq>.md` 投影，那份投影按纯号找行），群本保留 `group:` 前缀。
 */
function normalizeSubject(subject) {
  const raw = String(subject ?? '');
  const user = /^user:(\d+)$/.exec(raw);
  if (user) return user[1];
  if (/^group:[1-9]\d*$/.test(raw)) return raw;
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法：node tools/migrate-memory-v2.mjs [--apply] [--db 路径] [--memory 目录]');
    return;
  }
  const dbPath = options.db || resolveBridgeDb();
  /**
   * 默认取 `<cwd>/memory`，不是 `data/memory`。
   *
   * 本项目的 profile 把 `memoryDir` 显式指到仓库根下的 `memory/`，
   * 而 `resolveBridgeDb()` 给的是 `data/qq-bridge.sqlite3` —— 两者不同级。
   * 推断错目录的后果是"没找到旧档，无需迁移"，比报错更危险（会以为清完了）。
   */
  const memoryDir = options.memoryDir || path.join(process.cwd(), 'memory');
  const factsDir = path.join(memoryDir, '.facts');
  if (!fs.existsSync(factsDir)) {
    console.log(`没有找到 ${factsDir}，无需迁移。`);
    return;
  }

  console.log(`库：${dbPath}`);
  console.log(`旧档：${factsDir}`);
  console.log(`模式：${options.apply ? 'APPLY（会改数据）' : 'DRY-RUN（只报告）'}\n`);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  // 表由 AgentMemory 在运行时创建；迁移前确保存在，否则先跑一次插件。
  db.exec(`CREATE TABLE IF NOT EXISTS bridge_agent_memories (
    id TEXT PRIMARY KEY, qq TEXT NOT NULL, slot TEXT NOT NULL, version INTEGER NOT NULL,
    kind TEXT NOT NULL, text TEXT NOT NULL, period TEXT NOT NULL, deleted INTEGER NOT NULL,
    sources TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(qq,slot,version))`);
  try {
    const cols = db.prepare('PRAGMA table_info(bridge_agent_memories)').all().map((c) => c.name);
    if (!cols.includes('visibility'))
      db.exec("ALTER TABLE bridge_agent_memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  } catch (error) {
    console.error('补 visibility 列失败：' + (error?.message ?? error));
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(factsDir).filter((f) => f.endsWith('.json'));
  const plan = [];
  const skipped = [];
  let totalRecords = 0;
  for (const file of files) {
    if (file === '_withdrawn.json') continue;
    let records;
    try { records = JSON.parse(fs.readFileSync(path.join(factsDir, file), 'utf8')); }
    catch { skipped.push({ file, why: '读不出 JSON' }); continue; }
    if (!Array.isArray(records)) { skipped.push({ file, why: '不是数组' }); continue; }
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      totalRecords++;
      if (!record.active) continue;
      const subject = normalizeSubject(record.subject);
      if (!subject) { skipped.push({ file, why: '无法识别主体 ' + record.subject }); continue; }
      const slot = String(record.key ?? '');
      if (!SLOT_RE.test(slot)) { skipped.push({ file, why: '非法 slot ' + slot }); continue; }
      const text = clip(record.fact, MAX_TEXT);
      if (!text) { skipped.push({ file, why: '空事实' }); continue; }
      const sources = (Array.isArray(record.sources) ? record.sources : []).map((s) => ({
        conversation: String(s?.conversation ?? ''),
        messageId: s?.messageId == null ? null : String(s.messageId),
        evidence: clip(s?.evidence, 200),
        qq: String(s?.qq ?? ''),
        who: clip(s?.who, 60),
        at: Number(s?.at) || Number(record.createdAt) || Date.now(),
      })).filter((s) => s.conversation);
      if (!sources.length) { skipped.push({ file, why: '没有可用的来源 ' + slot }); continue; }
      // 同一 subject+slot 只保留一条：`commit()` 保证 active 唯一，这里兜底防空档。
      if (plan.some((p) => p.subject === subject && p.slot === slot)) continue;
      plan.push({ subject, slot, text, sources, kind: 'note', file });
    }
  }

  // 与 agent 已写过的槽冲突时跳过 —— 主模型的版本永远优先。
  const conflicts = [];
  const fresh = [];
  for (const item of plan) {
    const row = db.prepare(`SELECT 1 FROM bridge_agent_memories m WHERE m.qq=? AND m.slot=?
      AND NOT EXISTS (SELECT 1 FROM bridge_agent_memories n WHERE n.qq=m.qq AND n.slot=m.slot AND n.version>m.version)`)
      .get(item.subject, item.slot);
    (row ? conflicts : fresh).push(item);
  }

  const bySubject = new Map();
  for (const item of fresh) bySubject.set(item.subject, (bySubject.get(item.subject) ?? 0) + 1);
  console.log(`旧档：${files.length} 个文件 / ${totalRecords} 条记录`);
  console.log(`可迁移：${fresh.length} 条，涉及 ${bySubject.size} 个主体`);
  for (const [subject, n] of [...bySubject].sort((a, b) => b[1] - a[1]))
    console.log(`  ${subject}：${n} 条`);
  if (conflicts.length) {
    console.log(`\n跳过 ${conflicts.length} 条（agent 已有同槽记忆，由主模型版本优先）：`);
    for (const c of conflicts.slice(0, 10)) console.log(`  ${c.subject} / ${c.slot}`);
    if (conflicts.length > 10) console.log(`  …另 ${conflicts.length - 10} 条`);
  }
  if (skipped.length) {
    console.log(`\n无法迁移 ${skipped.length} 条：`);
    for (const s of skipped.slice(0, 10)) console.log(`  ${s.file} — ${s.why}`);
    if (skipped.length > 10) console.log(`  …另 ${skipped.length - 10} 条`);
  }

  if (!options.apply) {
    console.log('\n这是 dry-run。确认无误后加 --apply 执行（会先备份整个 .facts 目录）。');
    db.close();
    return;
  }

  const backup = path.join(memoryDir, `.facts.bak-${stamp()}`);
  fs.cpSync(factsDir, backup, { recursive: true });
  console.log(`\n已备份：${backup}`);

  let written = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`INSERT INTO bridge_agent_memories
      (id, qq, slot, version, kind, text, period, deleted, sources, updated_at, visibility)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    for (const item of fresh) {
      insert.run(randomUUID(), item.subject, item.slot, 1, item.kind, item.text, '', 0,
        JSON.stringify(item.sources), now, 'private');
      written++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('写入失败，已回滚（旧档未清空）：' + (error?.message ?? error));
    db.close();
    process.exitCode = 1;
    return;
  }

  // 清空旧档，但保留 _withdrawn —— 撤回索引仍在运行时被读取。
  let cleared = 0;
  for (const file of files) {
    if (file === '_withdrawn.json') continue;
    fs.writeFileSync(path.join(factsDir, file), '[]\n', 'utf8');
    cleared++;
  }
  if (!fs.existsSync(path.join(factsDir, '_withdrawn.json')))
    fs.writeFileSync(path.join(factsDir, '_withdrawn.json'), '[]\n', 'utf8');

  console.log(`已写入 ${written} 条到 bridge_agent_memories（kind=note，version=1）`);
  console.log(`已清空 ${cleared} 个旧档文件（_withdrawn 保留）`);
  console.log('\n下一步：重载插件后，人物本的 `## 自动记忆` 段会变成"（暂无自动提炼事实）"，');
  console.log('迁移来的条目会出现在 `## 主模型记忆` 段里。');
  db.close();
}

main();
