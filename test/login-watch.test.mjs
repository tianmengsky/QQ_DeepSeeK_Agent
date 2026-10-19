/**
 * login-watch.test.mjs —— 登录掉线监视的离线测试。
 *
 * 不需要 DSH、不需要 QQ、不需要 OneBot：探测函数是注入的假实现，
 * 时间用假钟推进，所以"掉了多久"这类断言是确定的。
 *   node test/login-watch.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.mjs';
import { Config, assertConfig } from '../lib/config.mjs';
import { __test } from '../lib/index.js';

const {
  LoginWatch,
  classifyLoginProbe,
  loginIncidentReason,
  summarizeLoginHistory,
  loginSnapshot,
  readLoginEnvironment,
  readQqntVersion,
  findLoginCredential,
  describeEnvironment,
} = __test;

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

/** 假钟：只替换 Date.now，代码里所有时间戳都跟着走。 */
function fakeClock(start = Date.UTC(2026, 9, 10, 0, 0, 0)) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    advance(ms) {
      now += ms;
      return now;
    },
    restore() {
      Date.now = real;
    },
  };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-login-watch-'));
  return new Store(path.join(dir, 'data', 'test.sqlite3'));
}

/** 依次返回给定探测结果；用完之后一直返回最后一个。 */
function scriptedProbes(list) {
  let index = 0;
  const calls = [];
  const probe = async () => {
    const item = list[Math.min(index, list.length - 1)];
    index += 1;
    calls.push(item);
    // 只补时间戳，**不覆盖**已经给出的字段：
    // 用 `{ at: Date.now(), ...item }` 的话，item 里的 online 会被后面的默认值顶掉。
    return { at: Date.now(), ...item };
  };
  probe.calls = calls;
  return probe;
}

const ONLINE = { online: true, good: true, account: '3667925015' };
const OFFLINE = { online: false, good: false, account: '3667925015' };
const DOWN = { online: null, error: 'fetch failed (ECONNREFUSED)' };

const settings = (over = {}) => ({
  loginWatchEnabled: true,
  loginWatchMs: 60000,
  loginWatchFailureThreshold: 3,
  loginWatchTimeoutMs: 4000,
  ...over,
});

console.log('login-watch.mjs');

// ------------------------------------------------------------ 配置

await test('配置默认值合理，坏值在加载时就拒绝', () => {
  const defaults = Config({});
  assert.equal(defaults.loginWatchEnabled, true, '只读探测、无副作用，默认应当开着');
  assert.equal(defaults.loginWatchMs, 60000);
  assert.equal(defaults.loginWatchFailureThreshold, 3);
  assert.equal(defaults.loginWatchTimeoutMs, 4000);
  assert.doesNotThrow(() => assertConfig(defaults));

  for (const bad of [
    { loginWatchMs: 500 },
    { loginWatchTimeoutMs: 100 },
    { loginWatchTimeoutMs: 60000 },
    { loginWatchFailureThreshold: 0 },
    { loginWatchFailureThreshold: 2.5 },
  ]) {
    assert.throws(
      () => assertConfig(Config(bad)),
      /loginWatch/,
      JSON.stringify(bad) + ' 必须在加载时报错，不能等到运行期才发现',
    );
  }
});

// ------------------------------------------------------------ 纯函数

await test('classifyLoginProbe 把在线/离线/未知分开，离线不等阈值', () => {
  assert.deepEqual(classifyLoginProbe({ online: true }), {
    status: 'online',
    cause: null,
    error: '',
  });
  const offline = classifyLoginProbe({ online: false });
  assert.equal(offline.status, 'offline');
  assert.equal(offline.cause, 'onebot-offline', '明确 offline 必须归为被踢下线这一类');

  assert.equal(classifyLoginProbe({ online: null, error: 'boom' }).cause, 'unreachable');
  assert.equal(
    classifyLoginProbe({ online: null }).cause,
    'onebot-unknown',
    '接口通了但它没回答 online，不能和"连不上"混为一谈',
  );
});

await test('loginIncidentReason 说的是人话，不是错误码', () => {
  assert.match(loginIncidentReason('onebot-offline'), /扫码|登录已失效/);
  assert.match(loginIncidentReason('unreachable'), /连不上/);
  assert.equal(loginIncidentReason('别的'), '别的');
});

await test('summarizeLoginHistory 算出频率，而不是只回一堆时间戳', () => {
  const summary = summarizeLoginHistory([
    { startedAt: 1000, endedAt: 4000, offlineMs: 3000 },
    { startedAt: 10000, endedAt: 12000, offlineMs: 2000 },
    { startedAt: 20000, endedAt: null, offlineMs: null },
  ]);
  assert.equal(summary.drops, 3);
  assert.equal(summary.recovered, 2);
  assert.equal(summary.open.startedAt, 20000);
  assert.equal(summary.lastDropAt, 20000);
  assert.equal(summary.lastRecoveredAt, 12000);
  assert.equal(summary.lastStableMs, 10000, '两次掉线之间能连续用多久');
  assert.equal(summary.offlineMs, 5000);
});

// ------------------------------------------------------------ 状态机

await test('在线 → 掉线 → 恢复：一次掉线只记一条，恢复补上不可用时长', async () => {
  const clock = fakeClock();
  try {
    const store = tmpStore();
    const watch = new LoginWatch({
      config: settings(),
      store,
      logger: { info() {}, warn() {} },
      probe: scriptedProbes([ONLINE, OFFLINE, OFFLINE, ONLINE, ONLINE]),
    });

    assert.equal(
      (await watch.check()).transition,
      'recover',
      '刚加载时在线状态未知，第一次探到在线就是一次恢复（这也是补记掉线时长的时机）',
    );
    assert.equal(watch.status, 'online');

    clock.advance(60000);
    const drop = await watch.check();
    assert.equal(drop.transition, 'drop');
    assert.equal(watch.status, 'offline');
    assert.equal(watch.cause, 'onebot-offline');

    // 还在掉线中：再探一次也只刷新那一条，不能复制成两条
    clock.advance(60000);
    assert.equal((await watch.check()).transition, null, '已经在掉线中，不是新的迁移');
    assert.equal(watch.incidents.length, 1, '同一次掉线只能有一条记录');
    assert.equal(watch.incidents[0].checks, 2, '掉线那一刻 + 后续每次探测都累加到同一条上');

    clock.advance(60000);
    const recover = await watch.check();
    assert.equal(recover.transition, 'recover');
    assert.equal(watch.status, 'online');
    assert.equal(watch.incidents[0].offlineMs, 120000, '从判定掉线到探到恢复，2 分钟不可用');

    const report = watch.report();
    assert.equal(report.统计.掉线次数, 1);
    assert.equal(report.统计.已恢复, 1);
    assert.equal(report.当前, 'online');
    assert.equal(report.历史[0].不可用秒, 120);
  } finally {
    clock.restore();
  }
});

await test('接口连不上要连续失败满阈值才算掉线，中间只告警不记账', async () => {
  const clock = fakeClock();
  try {
    const warnings = [];
    const probe = scriptedProbes([ONLINE, DOWN, DOWN, DOWN, ONLINE]);
    const watch = new LoginWatch({
      config: settings({ loginWatchFailureThreshold: 3 }),
      store: null,
      logger: { info() {}, warn: (m) => warnings.push(m) },
      probe,
    });

    await watch.check();
    await watch.check();
    assert.equal(watch.status, 'online', '一次失败不该被记成掉线');
    assert.equal(watch.incidents.length, 0);

    clock.advance(60000);
    await watch.check();
    assert.equal(watch.status, 'online');
    assert.equal(watch.incidents.length, 0, '两次失败仍不算掉线');
    assert.equal(warnings.length, 2, '每次未达阈值都要留一条线索，别让它静默');

    clock.advance(60000);
    const drop = await watch.check();
    assert.equal(drop.transition, 'drop', '第三次失败才落账');
    assert.equal(watch.status, 'offline');
    assert.equal(watch.incidents.length, 1);
    assert.equal(watch.incidents[0].cause, 'unreachable', '接口连不上要记成 unreachable');
    assert.match(watch.incidents[0].lastError, /ECONNREFUSED/);

    clock.advance(60000);
    await watch.check();
    assert.equal(watch.status, 'online');
    assert.equal(watch.incidents[0].offlineMs, 60000, '恢复探测晚一个间隔，就记 1 分钟');
  } finally {
    clock.restore();
  }
});

await test('掉线中重复探测不会再写一条 drop 日志', async () => {
  const clock = fakeClock();
  try {
    const warns = [];
    const watch = new LoginWatch({
      config: settings(),
      store: null,
      logger: { info() {}, warn: (m) => warns.push(m) },
      probe: scriptedProbes([ONLINE, OFFLINE, OFFLINE]),
    });
    await watch.check();
    clock.advance(1000);
    await watch.check();
    const afterDrop = warns.length;
    assert.equal(afterDrop, 1, '掉线那一刻告警一次');
    assert.match(warns[0], /\[掉线\]/);
    assert.match(warns[0], /不会自动重登/);

    clock.advance(1000);
    await watch.check();
    assert.equal(warns.length, afterDrop, '还在掉线中不该反复刷同一条告警');
  } finally {
    clock.restore();
  }
});

// ------------------------------------------------------------ 持久化

await test('历史与统计活过插件重载；重载期间还开着的那次掉线能被闭合', async () => {
  const clock = fakeClock();
  try {
    const store = tmpStore();
    const first = new LoginWatch({
      config: settings(),
      store,
      logger: { info() {}, warn() {} },
      probe: scriptedProbes([ONLINE, OFFLINE]),
    });
    await first.check();
    clock.advance(60000);
    await first.check();
    assert.equal(first.status, 'offline');

    // 掉线期间插件重载：新实例必须接上这段历史
    clock.advance(300000);
    const second = new LoginWatch({
      config: settings(),
      store,
      logger: { info() {}, warn() {} },
      probe: scriptedProbes([ONLINE]),
    });
    assert.equal(second.incidents.length, 1, '掉线记录要活过重载');
    assert.equal(second.carriedOpen, true, '重载时那次掉线还没闭合，必须认出来');
    assert.equal(second.status, 'offline', '重载后先沿用上次的状态，等探测确认');

    await second.check();
    assert.equal(second.status, 'online');
    assert.equal(second.incidents.length, 1, '闭合不能新建一条');
    // 掉线从 t=60000 那次探测开始算，重载期间的 5 分钟也在里面
    assert.equal(second.incidents[0].offlineMs, 300000);
    assert.equal(second.openIncident(), null);

    // 痕迹落到了事件表，用合成会话名，且不可投递
    const rows = store
      .db.prepare("SELECT conversation, kind, deliverable FROM events ORDER BY id")
      .all();
    assert.equal(rows.length, 2, '一次 drop + 一次 recover');
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['login-drop', 'login-recover'],
    );
    assert.ok(rows.every((r) => r.conversation === 'system:login'));
    assert.ok(rows.every((r) => r.deliverable === 0), '掉线不是待发送的消息');
  } finally {
    clock.restore();
  }
});

await test('没有持久化层时照样工作，只是不留历史', async () => {
  const watch = new LoginWatch({
    config: settings(),
    store: null,
    logger: null,
    probe: scriptedProbes([OFFLINE]),
  });
  const drop = await watch.check();
  assert.equal(drop.transition, 'drop');
  assert.equal(watch.incidents.length, 1);
  assert.equal(watch.report().统计.掉线次数, 1);
});

await test('状态键坏了也不会把监视器带崩', async () => {
  const store = tmpStore();
  store.setState('loginWatch:state', '{这不是 JSON');
  const watch = new LoginWatch({
    config: settings(),
    store,
    logger: null,
    probe: scriptedProbes([ONLINE]),
  });
  assert.equal(watch.incidents.length, 0);
  await watch.check();
  assert.equal(watch.status, 'online');
});

// ------------------------------------------------------------ 读数

await test('report 给出人话原因；历史条数受 loginWatchHistoryLimit 约束', async () => {
  const clock = fakeClock();
  try {
    const watch = new LoginWatch({
      config: settings(),
      store: null,
      logger: null,
      probe: scriptedProbes([ONLINE]),
    });
    for (let i = 0; i < 3; i++) {
      clock.advance(60000);
      watch.markOffline('onebot-offline', '被踢', Date.now());
      clock.advance(60000);
      watch.closeIncident(Date.now());
    }
    assert.equal(watch.incidents.length, 3);

    const limited = watch.report({ limit: 2 });
    assert.equal(limited.历史.length, 2);
    assert.match(limited.历史[0].原因, /扫码|登录已失效/);
    assert.match(limited.说明, /不会自动重登/);

    const all = watch.report({ limit: 0 });
    assert.equal(all.历史.length, 3);
  } finally {
    clock.restore();
  }
});

await test('历史上限封顶，长期运行不会把状态键撑大', async () => {
  const clock = fakeClock();
  try {
    const watch = new LoginWatch({
      config: settings(),
      store: null,
      logger: null,
      probe: scriptedProbes([ONLINE]),
    });
    for (let i = 0; i < 60; i++) {
      clock.advance(1000);
      watch.markOffline('unreachable', '', Date.now());
      clock.advance(1000);
      watch.closeIncident(Date.now());
    }
    assert.equal(watch.incidents.length, 40);
    assert.equal(watch.report().历史.length, 10, '默认只回显最近 10 次');
  } finally {
    clock.restore();
  }
});

await test('loginSnapshot 把"没开"和"没掉过线"分开说', () => {
  const off = loginSnapshot(null);
  assert.equal(off.开关, false);
  assert.match(off.说明, /未启用/);

  const watch = new LoginWatch({
    config: settings({ loginWatchEnabled: false }),
    store: null,
    logger: null,
    probe: scriptedProbes([ONLINE]),
  });
  const snapshot = loginSnapshot(watch);
  assert.equal(snapshot.开关, false);
  assert.equal(snapshot.统计.掉线次数, 0);
  assert.equal(snapshot.当前, 'unknown', '还没探过就不要假装在线');
});

await test('report 自身出错时给出一条可读的降级读数', () => {
  const broken = { report: () => { throw new Error('boom'); } };
  const snapshot = loginSnapshot(broken);
  assert.equal(snapshot.开关, true);
  assert.match(snapshot.说明, /读取失败/);
});

// ------------------------------------------------------------ 环境快照

/** 造一棵假的 QQNT + 账号数据目录：读盘逻辑必须能对着真文件跑。 */
function fakeEnvTree({
  curVersion = '9.9.35-52892',
  prevVersion = '9.9.33-52074',
  accounts = ['3667925015'],
  ownCredential = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-login-env-'));
  const qqntDir = path.join(root, 'QQNT');
  fs.mkdirSync(path.join(qqntDir, 'versions', curVersion), { recursive: true });
  if (prevVersion) fs.mkdirSync(path.join(qqntDir, 'versions', prevVersion), { recursive: true });
  fs.writeFileSync(
    path.join(qqntDir, 'versions', 'config.json'),
    JSON.stringify({ curVersion, prevVersion }),
    'utf8',
  );
  const dataDir = path.join(root, 'Tencent Files');
  for (const uin of accounts) {
    const authDir = path.join(dataDir, uin, 'nt_qq', 'nt_data', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    // ownCredential=false 用来模拟"票据根本不在账号目录里"这台机器的真实情况
    if (ownCredential) fs.writeFileSync(path.join(authDir, 'login.enc'), 'v1', 'utf8');
  }
  return { root, qqntDir, dataDir };
}

await test('读 QQNT 版本：优先 config.json，并认出"刚热更新过"', () => {
  const tree = fakeEnvTree();
  const version = readQqntVersion(tree.qqntDir);
  assert.equal(version.current, '9.9.35-52892');
  assert.equal(version.previous, '9.9.33-52074');

  const env = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '3667925015',
    accountDir: path.join(tree.dataDir, '3667925015'),
  });
  assert.equal(env.刚热更新, true, 'curVersion 与 prevVersion 不同 = 刚换过 build');
  assert.equal(env.credentialFrom, 'account');
  assert.match(env.credentialPath, /login\.enc$/);

  // 同版本时不算"刚热更新"
  const same = fakeEnvTree({ curVersion: '9.9.35-52892', prevVersion: '9.9.35-52892' });
  assert.equal(
    readLoginEnvironment({ qqntDir: same.qqntDir, account: '3667925015', accountDir: path.join(same.dataDir, '3667925015') }).刚热更新,
    false,
  );
});

await test('读不到 config.json 时退回目录名，不会把监视器带崩', () => {
  const tree = fakeEnvTree();
  fs.rmSync(path.join(tree.qqntDir, 'versions', 'config.json'));
  const version = readQqntVersion(tree.qqntDir);
  assert.equal(version.current, '9.9.35-52892', '目录名排序取最后一个');
  assert.match(version.note, /目录名/);
  assert.equal(readQqntVersion('D:\\不\\存在\\的\\路径').current, null);
});

await test('找登录票据：按账号找；找不到就退回"数据目录里最新的那份"', () => {
  const tree = fakeEnvTree({ accounts: ['1056612947', '3667925015'] });
  const mine = findLoginCredential(path.join(tree.dataDir, '3667925015'));
  assert.match(mine.path, /3667925015/);
  assert.ok(mine.mtimeMs > 0);

  // 票据只存在于另一个账号目录里：allowed 会退化成"按最新推断"，并标明来源
  const onlyOther = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '3667925015',
    accountDir: path.join(tree.dataDir, '1056612947'),
  });
  assert.equal(onlyOther.credentialFrom, 'account', '给了账号目录就以它为准');

  // 账号目录无从得知时，按"数据根 + QQ号"拼出来 —— 拿到的是精确路径，所以是 account。
  // 只有连账号目录都不存在时才会退化成"取数据根下最新的一份"（见下一个断言）。
  const derived = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '3667925015',
    accountDir: '',
    dataRoot: tree.dataDir,
  });
  assert.equal(derived.credentialFrom, 'account', '按数据根+QQ号拼出来的仍然算精确命中');
  assert.match(derived.credentialPath, /3667925015/, '拼出来的路径必须真的是这个账号的');

  // 账号目录不存在（比如刚登录、目录还没建）：这时只能取"数据根里最新的那份"
  const missing = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '999999999',
    accountDir: path.join(tree.dataDir, '999999999'),
    dataRoot: tree.dataDir,
  });
  assert.equal(missing.credentialFrom, 'latest', '自己那份不存在时按"最新"推断');
  assert.match(describeEnvironment(missing), /票据按最新推断/, '推断出来的必须标明');

  assert.equal(findLoginCredential('D:\\不\\存在').path, null);
});

await test('票据不在账号目录里时，退到已知位置（%APPDATA%\\QQ\\auth 那一类）', () => {
  // 实测这台机器上 login.enc 就只在 %APPDATA%\QQ\auth，不在账号数据目录 ——
  // 所以"只盯账号目录"会让这个读数永远是"未找到"。
  const tree = fakeEnvTree({ ownCredential: false });
  const authRoot = path.join(tree.root, 'Roaming', 'QQ', 'auth');
  fs.mkdirSync(authRoot, { recursive: true });
  fs.writeFileSync(path.join(authRoot, 'login.enc'), 'ticket', 'utf8');

  const env = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '3667925015',
    accountDir: path.join(tree.dataDir, '3667925015'), // 里面没有票据
    credentialRoots: [authRoot],
  });
  assert.equal(env.credentialFrom, 'latest', '已知位置命中算推断，不算精确到账号');
  assert.equal(env.credentialRoot, authRoot);
  assert.match(env.credentialPath, /auth.*login\.enc$/);
  assert.match(describeEnvironment(env), /票据按最新推断/);

  // 账号目录里有票时优先用它，不去看已知位置
  const withOwn = fakeEnvTree();
  const own = readLoginEnvironment({
    qqntDir: withOwn.qqntDir,
    account: '3667925015',
    accountDir: path.join(withOwn.dataDir, '3667925015'),
    credentialRoots: [],
  });
  assert.equal(own.credentialFrom, 'account', '账号目录那份才是精确的');
});

await test('环境描述是一行可读文本，不是一堆字段', () => {
  const tree = fakeEnvTree();
  const env = readLoginEnvironment({
    qqntDir: tree.qqntDir,
    account: '3667925015',
    accountDir: path.join(tree.dataDir, '3667925015'),
  });
  const text = describeEnvironment(env);
  assert.match(text, /QQNT 9\.9\.35-52892/);
  assert.match(text, /上一版 9\.9\.33-52074/);
  assert.match(text, /登录票据/);
  assert.match(text, /账号 3667925015/);
  assert.match(describeEnvironment(null), /无环境快照/);
});

await test('掉线与健康快照的版本差异会写进历史，票据差异只做旁证', async () => {
  const clock = fakeClock();
  try {
    const tree = fakeEnvTree();
    const healthy = readLoginEnvironment({
      qqntDir: tree.qqntDir,
      account: '3667925015',
      accountDir: path.join(tree.dataDir, '3667925015'),
    });
    // 掉线时 QQ 已经升级到新 build
    const upgraded = fakeEnvTree({ curVersion: '9.9.36-53644' });
    const after = readLoginEnvironment({
      qqntDir: upgraded.qqntDir,
      account: '3667925015',
      accountDir: path.join(upgraded.dataDir, '3667925015'),
    });

    let call = 0;
    const snapshots = [healthy, after];
    const warns = [];
    const watch = new LoginWatch({
      config: settings(),
      store: null,
      logger: { info() {}, warn: (m) => warns.push(m) },
      probe: scriptedProbes([ONLINE, OFFLINE]),
      snapshot: () => snapshots[Math.min(call++, snapshots.length - 1)],
    });

    await watch.check();
    watch.environment = healthy;
    clock.advance(60000);
    await watch.check();

    const report = watch.report();
    assert.equal(report.历史[0].QQNT版本, '9.9.36-53644', '掉线当时的 build 要留在历史里');
    assert.ok(
      warns.some((m) => /掉线线索/.test(m) && /换过版本/.test(m)),
      '换了 build 就要给一条线索，别只记时间戳',
    );
    assert.match(report.环境.说明, /QQNT/);
  } finally {
    clock.restore();
  }
});

// ------------------------------------------------------------ 落盘提醒

await test('掉线与恢复各写一行 JSONL，带原因和环境快照', async () => {
  const clock = fakeClock();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-login-alert-'));
    const alertPath = path.join(dir, 'data', 'login-alerts.log');
    const watch = new LoginWatch({
      config: settings(),
      store: null,
      logger: null,
      probe: scriptedProbes([ONLINE, OFFLINE, ONLINE, ONLINE]),
      snapshot: () => ({ at: Date.now(), account: '3667925015', qqnt: '9.9.35-52892', credentialFrom: 'account' }),
      alertPath,
    });

    await watch.check();
    clock.advance(60000);
    await watch.check();
    clock.advance(120000);
    await watch.check();

    const lines = fs
      .readFileSync(alertPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2, '一次掉线 + 一次恢复 = 两行');
    assert.equal(lines[0].kind, 'drop');
    assert.match(lines[0].reason, /扫码|登录已失效/);
    assert.equal(lines[0].account, '3667925015');
    assert.equal(lines[0].environment.qqnt, '9.9.35-52892', '告警里要带当时的环境');
    assert.equal(lines[1].kind, 'recover');
    assert.equal(lines[1].offlineMs, 120000, '恢复那一行带不可用时长');

    // 告警文件要在自检里可见，否则"写了但没人知道写在哪"等于没写
    const report = watch.report();
    assert.equal(report.提醒.文件, alertPath);
    assert.equal(report.提醒.最后写入失败, null);
  } finally {
    clock.restore();
  }
});

await test('关掉提醒就不写文件；写不进去也不影响监视本身', async () => {
  const clock = fakeClock();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-login-alert-off-'));
    const alertPath = path.join(dir, 'x.log');
    const off = new LoginWatch({
      config: settings({ loginAlertEnabled: false }),
      store: null,
      logger: null,
      probe: scriptedProbes([OFFLINE]),
      alertPath,
    });
    await off.check();
    assert.equal(fs.existsSync(alertPath), false, '关掉开关就不该落文件');

    // 指向一个"父路径是文件"的位置，写入必然失败
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a dir', 'utf8');
    const warns = [];
    const broken = new LoginWatch({
      config: settings(),
      store: null,
      logger: { info() {}, warn: (m) => warns.push(m) },
      probe: scriptedProbes([OFFLINE]),
      alertPath: path.join(blocker, 'login-alerts.log'),
    });
    const result = await broken.check();
    assert.equal(result.transition, 'drop', '写盘失败不能反过来把状态机搞坏');
    assert.equal(broken.report().统计.掉线次数, 1);
    assert.ok(warns.some((m) => /提醒写入失败/.test(m)), '写失败要有痕迹');
    assert.ok(broken.report().提醒.最后写入失败, '自检里要能看到写入失败');
  } finally {
    clock.restore();
  }
});

if (failed) {
  console.error(`\n${failed} 个用例失败：`);
  for (const item of failures) console.error(' - ' + item.name + ' :: ' + (item.error?.stack ?? item.error));
  process.exitCode = 1;
}
console.log(`\n${passed} passed, ${failed} failed`);
