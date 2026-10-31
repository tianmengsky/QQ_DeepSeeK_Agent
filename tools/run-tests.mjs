/** Keep tests and their outputs outside the directory watched by DSH HMR. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const project = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'logic',
  'store',
  'reliability',
  'deliver',
  'at-mention',
  'send-queue',
  'turn-attribution',
  'reply-recovery',
  'events',
  'voice-transcription',
  'voice-intent',
  'voice-library',
  'history-context',
  'history-timeout',
  'context-time',
  'context-overflow',
  'poke-wake',
  'mcp',
  'bug-regressions',
  'image-input',
  'forward',
  'memory-context',
  'agent-memory',
  'episodes',
  'memory-flush',
  'memory-reflect',
  'self',
  'self-model',
  'diary',
  'mood',
  'self-actions',
  'world-snapshot',
  'intent',
  'reconcile',
  'introspect',
  'windows',
  'proactive',
  'bili-feed',
  'notebook-projection',
  'lifecycle',
  'launcher',
  'snowluma-launcher',
  'heartbeat',
  'login-watch',
  'debug',
  'attention',
  'input-floor',
  'overlap-shadow',
  'timeline',
  'tool-scope',
  'workspace',
  'task-routing',
  'task-reaper',
  'subagent-results',
  'aux-health',
  'json-output',
  'recovery-guard',
  'panel',
  'console',
  'dsh-guard',
  'admin',
  'reasoning-effort',
  'bili-ingress',
];
/**
 * 两项实测最慢，占全量七成以上时间，原因都是"在等真实时间"：
 *
 *   · `mcp`        —— 43 次 spawn 真实的 qq-mcp 子进程，单次冷启动约 1.8 秒，
 *                     再加上 stdio JSON-RPC 往返，整文件 ~168 秒。
 *   · `poke-wake`  —— 每项都在等真实的唤醒窗口/冷却定时器，16 项 ~46 秒。
 *
 * 它们慢得有理由（测的就是进程边界和定时器），所以不优化它们，
 * 而是给日常迭代一条更快的路：`--fast` 跳过这两项。
 */
const SLOW_SUITES = new Set(['mcp', 'poke-wake']);

/**
 * 日常迭代的核心子集。
 *
 * 选的是"改动最常落到、又跑得快"的九套：串行约 17 秒，4 路并行约 6 秒。
 * 刻意不含 `bug-regressions` / `reliability` / `reply-recovery` —— 它们各 3-5 秒，
 * 覆盖的是线上事故回归，属于"提交前"那一档，不该塞进每改一行就跑的循环里。
 */
const QUICK_SUITES = new Set([
  'logic', 'store', 'agent-memory', 'memory-flush', 'self',
  'notebook-projection', 'heartbeat', 'debug', 'task-routing',
]);

const argv = process.argv.slice(2);
const KNOWN_FLAGS = ['--fast', '--list', '--quick', '--jobs'];
const flags = argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.split('=')[0]);
const unknownFlag = flags.find((flag) => !KNOWN_FLAGS.includes(flag));
if (unknownFlag) throw new Error('未知参数：' + unknownFlag + '（可用：' + KNOWN_FLAGS.join(' / ') + '）');
const flagValue = (name) => {
  const hit = argv.find((arg) => arg.startsWith(name + '='));
  return hit === undefined ? null : hit.slice(name.length + 1);
};
if (flags.includes('--list')) {
  for (const suite of suites) {
    const tags = [QUICK_SUITES.has(suite) ? 'quick' : '', SLOW_SUITES.has(suite) ? 'slow' : '']
      .filter(Boolean);
    console.log(suite + (tags.length ? '  (' + tags.join(', ') + ')' : ''));
  }
  process.exit(0);
}
const requested = argv.filter((arg) => !arg.startsWith('--'));
if (requested.length) {
  for (const suite of requested) if (!suites.includes(suite)) throw new Error('Unknown test suite: ' + suite);
  suites.splice(0, suites.length, ...new Set(requested));
} else if (flags.includes('--quick')) {
  suites.splice(0, suites.length, ...suites.filter((suite) => QUICK_SUITES.has(suite)));
  console.log('--quick：只跑核心九套（日常迭代用）');
} else if (flags.includes('--fast')) {
  const slow = suites.filter((suite) => SLOW_SUITES.has(suite));
  suites.splice(0, suites.length, ...suites.filter((suite) => !SLOW_SUITES.has(suite)));
  console.log('--fast：跳过 ' + slow.join(' / ') + '（它们慢在真实子进程与真实定时器）');
}

/**
 * 并行度。
 *
 * 默认 4 路：每个套件是一次独立的 node 冷启动（约 0.7 秒），串行跑 35 个
 * 光启动就 25 秒；4 路能把这段压到 6-8 秒。再高收益递减，而且几套测试
 * 会同时打 SQLite/HTTP，CPU 争抢下单套耗时读数会变得不可比。
 *
 * `--jobs=1` 回到串行：排查"某套在并行下变红"时用。
 */
const requestedJobs = Number(flagValue('--jobs'));
const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : 4;
const jobs = Number.isInteger(requestedJobs) && requestedJobs > 0
  ? Math.min(requestedJobs, 16)
  : Math.max(1, Math.min(4, cpus));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-tests-'));

/** 起一个套件子进程并收集输出。用异步 spawn 而不是 spawnSync —— 原因见 runPool。 */
function runSuite(suite, env, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['test/' + suite + '.test.mjs'], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // 与原来 spawnSync 的 maxBuffer 对齐；超出就截断，避免失控输出吃内存。
    const cap = 8 * 1024 * 1024;
    child.stdout.on('data', (chunk) => { if (stdout.length < cap) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < cap) stderr += chunk; });
    const finish = (code, error) => {
      clearTimeout(timer);
      resolve({ suite, code, stdout, stderr, error, timedOut, ms: Date.now() - startedAt });
    };
    child.on('error', (error) => finish(-1, String(error)));
    child.on('close', (code) => finish(code));
  });
}

/**
 * 固定大小并发池。
 *
 * 为什么不用 `Promise.all(list.map(runSuite))`：那会把 35 个 node 进程
 * 同时拉起来，SQLite 与 HTTP mock 抢 CPU，单套耗时读数全部失真、还可能
 * 把本来宽裕的测试挤到超时。固定 4 路既够压住启动开销，又保持可比的读数。
 *
 * 输出顺序仍由 `suites` 决定（结果先收集、后统一打印）。
 */
async function runPool(list, jobs, env, cwd) {
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      results[index] = await runSuite(list[index], env, cwd);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, list.length)) }, worker));
  return results;
}

let passed = 0;
let failed = 0;
try {
  for (const relative of [
    'lib',
    'test',
    'package.json',
    'persona.md',
    'behavior.md',
    'examples.md',
    'tools/start-qq-mcp.ps1',
    'tools/windows-processes.ps1',
    'tools/snowluma-account-loader.mjs',
    // 控制台是独立进程，但它自己的解析/接口契约要测；页面随服务一起复制过去。
    'tools/console.mjs',
    'tools/console',
    'tools/dsh-guard.mjs',
    'qq-mcp/src',
    'qq-mcp/cache',
    'qq-mcp/package.json',
  ]) {
    const source = path.join(project, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(temporary, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  for (const relative of ['node_modules', 'qq-mcp/node_modules']) {
    fs.symlinkSync(
      path.join(project, relative),
      path.join(temporary, relative),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  console.log(`在系统临时副本中运行离线测试（${jobs > 1 ? jobs + ' 路并行' : '串行'}）；不复制生产数据库或记忆。`);
  const suiteEnv = {
    ...process.env,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    QQ_BRIDGE_DB: '',
    QQ_DRY_RUN: '0',
    QQ_CAPABILITIES: '',
    QQ_ALLOWED_GROUPS: '',
    QQ_ALLOWED_USERS: '',
    QQ_PERSISTENCE: '1',
    QQ_WORKSPACE_ROOT: path.join(temporary, 'workspaces'),
  };
  /**
   * 结果统一收集后再打印，所以并行时套件行仍按 `suites` 顺序输出。
   * 失败详情照旧走 stderr，不会和别人的进度行穿插。
   */
  const results = await runPool(suites, jobs, suiteEnv, temporary);
  for (const result of results) {
    const english = result.stdout.match(/(\d+) passed, (\d+) failed/);
    const chinese = result.stdout.match(/全部通过：(\d+) 项/);
    const summary =
      english ?? (chinese ? [chinese[1] + ' passed, 0 failed', chinese[1], '0'] : null);
    const ok = result.code === 0 && summary && Number(summary[2]) === 0;
    const elapsed = (result.ms / 1000).toFixed(1) + 's';
    console.log(result.suite + ': ' + (ok ? summary[0] : 'FAILED') + ' (' + elapsed + ')');
    if (ok) passed += Number(summary[1]);
    else {
      failed++;
      console.error(result.stdout, result.stderr,
        result.error ?? '', result.timedOut ? '（超时 120 秒被杀）' : '');
    }
  }
  console.log(`总计 ${passed} 项通过，${failed} 个测试文件失败。`);
  if (failed) process.exitCode = 1;
} finally {
  // Remove junctions first so recursive cleanup cannot follow dependency targets.
  for (const relative of ['node_modules', 'qq-mcp/node_modules']) {
    const link = path.join(temporary, relative);
    if (fs.existsSync(link)) fs.unlinkSync(link);
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
