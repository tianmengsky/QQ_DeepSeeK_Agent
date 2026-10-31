/**
 * 崩溃保护（tools/dsh-guard.mjs）的契约测试。
 *
 * 钉的是 2026-10-31 那次事故的因果链：DSH 每启动一次就往 cookie 库里多写一个
 * `dsh-auth-<随机>`，堆到几十个之后它自己认领不了自己的 Host（Web authentication
 * failed），而换 profile、关第三方插件全都无效。所以这里只验四件事：
 *   · 数得准：只数 127.0.0.1 上的 dsh-auth-*，别的域名的 cookie 一条不许少；
 *   · 清得干净且留备份：删掉的全部是认证 cookie，其余原样；
 *   · DSH 在跑时**不碰**库（Chromium 独占），并且说得出原因；
 *   · 崩溃日志能分出"认证失败"和"热重载竞态"——这两种的修法完全不同。
 *
 * 全程在临时目录里造一个假的 userData，绝不碰真实的那份。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { cookieStats, lastCrash, pruneAuthCookies } from '../tools/dsh-guard.mjs';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-dsh-guard-'));
const userData = path.join(root, '@deepseek-ai', 'dsh-desktop');
fs.mkdirSync(path.join(userData, 'Network'), { recursive: true });
fs.mkdirSync(path.join(userData, 'logs'), { recursive: true });
const env = { APPDATA: root };

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { console.error('  ✗ ' + name, error); process.exitCode = 1; }
}

/** Chromium 的时间戳：1601 年以来的微秒。1.34e16 超出 JS 安全整数，必须用 BigInt。 */
const chromeMicros = (date) => BigInt(Math.round((date.getTime() - Date.UTC(1601, 0, 1)) * 1000));
const now = Date.now();

function buildCookies(rows) {
  const file = path.join(userData, 'Network', 'Cookies');
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, creation_utc INTEGER, last_access_utc INTEGER)');
  const insert = db.prepare('INSERT INTO cookies (host_key, name, encrypted_value, creation_utc, last_access_utc) VALUES (?,?,?,?,?)');
  for (const [host, name, at] of rows) insert.run(host, name, new Uint8Array(0), chromeMicros(at), chromeMicros(at));
  db.close();
  return file;
}

try {
  buildCookies([
    ['127.0.0.1', 'dsh-auth-aaa', new Date(now - 3 * 86400000)],
    ['127.0.0.1', 'dsh-auth-bbb', new Date(now - 2 * 86400000)],
    ['127.0.0.1', 'dsh-auth-ccc', new Date(now - 86400000)],
    ['127.0.0.1', 'not-ours', new Date(now - 86400000)],
    ['api.deepseek.com', 'session', new Date(now - 86400000)],
  ]);

  test('数得准：只数 127.0.0.1 的 dsh-auth-*，别的域名不算', () => {
    const stats = cookieStats(env);
    assert.equal(stats.available, true);
    assert.equal(stats.total, 5);
    assert.equal(stats.authCookies, 3);
    assert.ok(stats.oldest < stats.newest, '要能看出堆积的时间跨度');
  });

  test('清得干净：只删 dsh-auth-*，其余原样，且留了备份', () => {
    const result = pruneAuthCookies({ env });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 3);
    assert.ok(fs.existsSync(result.backup), '删之前必须备份');
    const after = cookieStats(env);
    assert.equal(after.authCookies, 0);
    assert.equal(after.total, 2, '同域名的非认证 cookie 与别的域名都要留下');
    // 幂等：再清一次什么都不做，也不该再造备份。
    const again = pruneAuthCookies({ env });
    assert.equal(again.removed, 0);
    assert.equal(again.backup, null);
  });

  test('DSH 在跑时不碰库：独占就打不开，且说得出原因', () => {
    const file = buildCookies([['127.0.0.1', 'dsh-auth-ddd', new Date(now)]]);
    fs.chmodSync(file, 0o444); // 模拟 Chromium 独占（Windows 上就是只读属性）
    try {
      const stats = cookieStats(env);
      assert.equal(stats.locked, true);
      assert.equal(stats.authCookies, null, '读不到就不要编一个 0 出来');
      const result = pruneAuthCookies({ env });
      assert.equal(result.ok, false);
      assert.equal(result.locked, true);
      assert.match(result.reason, /正在运行/);
    } finally {
      fs.chmodSync(file, 0o666);
    }
  });

  test('崩溃日志：认证失败与热重载竞态分开判', () => {
    const write = (name, error, at) => {
      const file = path.join(userData, 'logs', name);
      fs.writeFileSync(file, `time: ${new Date(at).toISOString()}\nsource: host\nphase: startup\n\n--- error ---\n${error}\n`);
      const old = new Date(at);
      fs.utimesSync(file, old, old);
      return file;
    };
    write('crash-old-host.log', 'Error: desktop welcome: Web authentication failed', now - 3600000);
    assert.equal(lastCrash(env).kind, 'auth');

    write('crash-new-main.log', 'CordisError: cannot create effect on inactive context\n  code: INACTIVE_EFFECT', now);
    const latest = lastCrash(env);
    assert.equal(latest.kind, 'reload-race');
    assert.match(latest.error, /inactive context/);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`${passed} passed, ${process.exitCode ? '1 failed' : '0 failed'}`);
