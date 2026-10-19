/** Keep tests and their outputs outside the directory watched by DSH HMR. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'logic',
  'prompt-system',
  'store',
  'reliability',
  'deliver',
  'at-mention',
  'send-queue',
  'turn-attribution',
  'reply-recovery',
  'events',
  'voice-transcription',
  'history-context',
  'context-time',
  'poke-wake',
  'mcp',
  'bug-regressions',
  'image-input',
  'forward',
  'memory-context',
  'agent-memory',
  'episodes',
  'lifecycle',
  'launcher',
  'snowluma-launcher',
  'heartbeat',
  'login-watch',
  'debug',
  'attention',
  'input-floor',
  'timeline',
  'tool-scope',
  'workspace',
  'task-progress',
  'task-routing',
  'delegated-work',
];
const requested = process.argv.slice(2);
if (requested.length) {
  for (const suite of requested) if (!suites.includes(suite)) throw new Error('Unknown test suite: ' + suite);
  suites.splice(0, suites.length, ...new Set(requested));
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-tests-'));
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
  console.log('在系统临时副本中逐个运行离线测试；不复制生产数据库或记忆。');
  for (const suite of suites) {
    const result = spawnSync(process.execPath, ['test/' + suite + '.test.mjs'], {
      cwd: temporary,
      env: {
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
      },
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const english = result.stdout?.match(/(\d+) passed, (\d+) failed/);
    const chinese = result.stdout?.match(/全部通过：(\d+) 项/);
    const summary =
      english ?? (chinese ? [chinese[1] + ' passed, 0 failed', chinese[1], '0'] : null);
    const ok = result.status === 0 && summary && Number(summary[2]) === 0;
    console.log(suite + ': ' + (ok ? summary[0] : 'FAILED'));
    if (ok) passed += Number(summary[1]);
    else {
      failed++;
      console.error(result.stdout ?? '', result.stderr ?? '', result.error?.message ?? '');
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
