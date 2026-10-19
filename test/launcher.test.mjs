import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Windows launcher checks skipped on this platform.');
  console.log('0 passed, 0 failed');
} else {
  const fixture = fileURLToPath(new URL('./helpers/launcher-tests.ps1', import.meta.url));
  const launcher = fileURLToPath(new URL('../tools/start-qq-mcp.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Launcher', launcher], {
    encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? ''));
  assert.match(result.stdout, /20 passed, 0 failed/);
  console.log(result.stdout.trim());
}
