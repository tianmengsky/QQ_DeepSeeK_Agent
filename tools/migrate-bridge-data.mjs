/**
 * 把桥接数据目录迁出 profile 里配的 cwd，落到本仓库的 data/ 下。
 *
 * 为什么要用 VACUUM INTO 而不是拷文件：库是 WAL 模式，`-wal` 里可能还有没并回主库的
 * 已提交数据，直接拷 .sqlite3 会丢这些。VACUUM INTO 走一次读事务，出来的是**一致的**
 * 单文件快照，且不需要停掉正在运行的桥接。
 *
 * ⚠ 快照是某一时刻的副本。桥接进程仍在使用旧库，直到它重新加载配置。
 *   所以正确顺序是：**先跑本工具，紧接着改 profile 的 stateDir**，
 *   把两次之间的时间窗压到最小；否则窗口期内写入的未发送回复会丢。
 *
 *   node tools/migrate-bridge-data.mjs                 查看源/目标与差异（只读）
 *   node tools/migrate-bridge-data.mjs --apply         做一致性快照并校验
 *   node tools/migrate-bridge-data.mjs --apply --force 目标已存在时，先备份再覆盖
 *
 * ⚠ 方向自检：目标比源库新时默认**拒绝执行** —— 那说明源是落后副本、目标是活库，
 *   再"迁移"就是回退。确需回退数据才加 --allow-regression。
 *   2026-10-13 的实例：profile 的 stateDir 已指向仓库 data/，而 cwd 下还留着
 *   一份落后约 79 分钟的旧副本；不加这道闸，--force 会把活库覆盖掉。
 *
 * 可选：
 *   --from <db>          指定源库
 *   --to <dir>           指定目标目录（默认 <repo>/data）
 *   --allow-regression   明确允许用较旧的源覆盖较新的目标
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REPO_ROOT, bridgeDataDirs, resolveBridgeDb } from './db-path.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const APPLY = has('--apply');
const FORCE = has('--force');
const ALLOW_REGRESSION = has('--allow-regression');
const say = (t = '', c = '') => {
  const codes = { red: 31, green: 32, yellow: 33, cyan: 36, gray: 90 };
  console.log((c && codes[c] ? `\u001b[${codes[c]}m` : '') + t + (c && codes[c] ? '\u001b[0m' : ''));
};

const targetDir = path.resolve(value('--to', path.join(REPO_ROOT, 'data')));
const targetFile = path.join(targetDir, 'qq-bridge.sqlite3');

/** 源库：优先显式指定，其次 profile 配的 stateDir/cwd，最后才是仓库 data/。 */
function findSource() {
  const explicit = value('--from', '');
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const profileDirs = bridgeDataDirs().slice(1);            // 第 1 项就是仓库 data/，即目标
  for (const dir of profileDirs) {
    const p = path.join(dir, 'qq-bridge.sqlite3');
    if (fs.existsSync(p) && path.resolve(p) !== path.resolve(targetFile)) return p;
  }
  const fallback = resolveBridgeDb();
  return fallback && path.resolve(fallback) !== path.resolve(targetFile) ? fallback : null;
}

function stats(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  const rows = {};
  for (const t of tables) { try { rows[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch { rows[t] = null; } }
  let integrity = null;
  try { integrity = db.prepare('PRAGMA integrity_check').get().integrity_check; } catch { /* 可选 */ }
  db.close();
  return { tables, rows, integrity, bytes: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs };
}

/**
 * 方向自检：目标是**更新**的库时，「迁移」实际上是拿旧快照覆盖活库 —— 会丢数据。
 *
 * 为什么需要这道闸：本工具诞生时的场景是「数据误写进 profile 的 cwd，要挪到
 * 仓库 data/」。但一旦 profile 的 stateDir 已经改到仓库 data/，源和目标就反过来
 * 了：此时 profile 的 cwd 下那份是**历史遗留的落后副本**，而目标才是正在写入的活库。
 * 光看「谁存在」分不出方向，必须比时间。
 */
function regressionRisk(src) {
  if (!fs.existsSync(targetFile)) return null;
  const s = fs.statSync(src).mtimeMs, t = fs.statSync(targetFile).mtimeMs;
  return t > s ? { targetNewerMs: t - s } : null;
}

const source = findSource();
say('');
say('  桥接数据目录迁移', 'cyan');
say('');
if (!source) {
  say(`  没有找到需要迁移的源库。目标：${targetFile}`, 'yellow');
  say(`  当前生效的库：${resolveBridgeDb() ?? '(无)'}`, 'gray');
  say('');
  process.exit(0);
}
say(`  源库    ${source}`);
say(`  目标    ${targetFile}`);
say('');

if (path.resolve(source) === path.resolve(targetFile)) {
  say('  源和目标相同，已经在新位置，无需迁移。', 'green');
  say('');
  process.exit(0);
}

const REGRESSION = regressionRisk(source);
const before = stats(source);
say(`  源库：${before.tables.length} 张表，${(before.bytes / 1048576).toFixed(1)} MB，integrity=${before.integrity}`, 'gray');
say('');

if (REGRESSION) {
  const mins = Math.round(REGRESSION.targetNewerMs / 60000);
  say(`  ⚠ 方向可能有误：目标比源库新（约 ${mins} 分钟）。`, 'red');
  say('    目标才是正在写入的活库，源是历史遗留的落后副本。', 'red');
  say('    照现在的方向执行 = 用旧快照覆盖活库，窗口期内的新数据会丢。', 'red');
  say('', '');
  say(`    源库 mtime  ${new Date(before.mtimeMs).toLocaleString('zh-CN')}`, 'gray');
  say(`    目标 mtime  ${new Date(fs.statSync(targetFile).mtimeMs).toLocaleString('zh-CN')}`, 'gray');
  say('', '');
  say('    通常你要做的不是迁移，而是让桥接和 MCP 指向同一个库：', 'yellow');
  say(`      · qq-bridge.config.stateDir = '${targetDir}'（活库所在）`, 'yellow');
  say(`      · mcp-qq.env.QQ_BRIDGE_DB    = '${targetFile}'`, 'yellow');
  say('', '');
  say('    确认要回退到源库（会丢新数据）才加 --allow-regression。', 'yellow');
  say('');
}

if (!APPLY) {
  if (fs.existsSync(targetFile)) {
    const after = stats(targetFile);
    say(`  目标已存在（${(after.bytes / 1048576).toFixed(1)} MB）—— 加 --force 会先备份再覆盖`, 'yellow');
    let diff = 0;
    for (const t of new Set([...before.tables, ...after.tables])) {
      if (before.rows[t] !== after.rows[t]) { diff++; say(`    DIFF ${t}: ${before.rows[t]} -> ${after.rows[t]}`, 'yellow'); }
    }
    say(`  与源库的行数差异：${diff} 处`, diff ? 'yellow' : 'green');
  } else {
    say('  目标不存在，可以直接迁移。', 'green');
  }
  say('');
  say('  【预演模式】没有写入任何文件。执行：', 'yellow');
  say('      node tools/migrate-bridge-data.mjs --apply', 'yellow');
  say('');
  say('  迁移后必须改 profile 让桥接指向新位置：', 'gray');
  say(`      qq-bridge.config.stateDir: '${targetDir}'`, 'gray');
  say('');
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
if (fs.existsSync(targetFile)) {
  if (REGRESSION && !ALLOW_REGRESSION) {
    const mins = Math.round(REGRESSION.targetNewerMs / 60000);
    say(`  拒绝执行：目标比源库新约 ${mins} 分钟，这会把活库回退成旧快照。`, 'red');
    say('  先把 stateDir 与 QQ_BRIDGE_DB 指到同一个库（见上面的预演输出）；', 'yellow');
    say('  确实要回退数据才加 --allow-regression。', 'yellow');
    say('');
    process.exit(1);
  }
  if (!FORCE) {
    say(`  目标已存在：${targetFile}`, 'red');
    say('  确认要覆盖就加 --force（会先把现有目标改名备份）。', 'yellow');
    say('');
    process.exit(1);
  }
  const backup = targetFile + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.renameSync(targetFile, backup);
  say(`  已备份原目标 → ${backup}`, 'gray');
}

const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${targetFile.replaceAll('\\', '/').replaceAll("'", "''")}'`);
} finally { db.close(); }

const after = stats(targetFile);
let diff = 0;
for (const t of new Set([...before.tables, ...after.tables])) {
  if (before.rows[t] !== after.rows[t]) { diff++; say(`  ✗ DIFF ${t}: ${before.rows[t]} -> ${after.rows[t]}`, 'red'); }
}
say('');
say(`  已写入 ${targetFile}  （${(after.bytes / 1048576).toFixed(1)} MB，integrity=${after.integrity}）`, 'green');
say(`  表 ${after.tables.length} 张，行数差异 ${diff} 处${diff ? ' —— 请勿切换配置，先排查' : ''}`, diff ? 'red' : 'green');
say('');
if (diff || after.integrity !== 'ok') {
  say('  校验未通过，不要把 stateDir 指过来。', 'red');
  process.exit(1);
}
say('  下一步（要紧接着做，窗口期内旧库的新写入不会进快照）：', 'yellow');
say(`      在 profile 的 qq-bridge.config 里加  stateDir: '${targetDir}'`, 'yellow');
say('      然后重启 DSH（或等 profile 触发的重载）。', 'yellow');
say('');
