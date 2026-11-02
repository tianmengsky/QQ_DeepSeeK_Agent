/**
 * 控制台（tools/console.mjs）的契约测试。
 *
 * 这个进程能拉起 DSH、能开关托管，所以钉的不是"页面长什么样"，而是三件事：
 *   · 解析对：`netstat -ano` / `tasklist` 的文本是唯一数据源，解析歪了就会给错端口；
 *   · 判定分开：DSH 活着 ≠ 桥接活着 ≠ OneBot 在线，三条各判各的；
 *   · 写操作有闸：跨站 POST 一律拒绝，且它不会真去执行。
 *
 * 端口与子进程全部由假实现代替 —— 测试里绝不能真启动 DSH 或改线上托管。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {
  crossSite,
  createConsole,
  createHandler,
  createServer,
  dshPorts,
  parseNetstat,
  parseTasklist,
  probe,
  readConfig,
  runPowerShell,
} from '../tools/console.mjs';

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name); })
    .catch((error) => { console.error('  ✗ ' + name, error); process.exitCode = 1; });
}

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1052
  TCP    127.0.0.1:14438        0.0.0.0:0              LISTENING       34412
  TCP    127.0.0.1:16000        0.0.0.0:0              LISTENING       39911
  TCP    127.0.0.1:14438        127.0.0.1:52344        ESTABLISHED     34412
  UDP    0.0.0.0:5353           *:*                                    2211
  TCP    [::1]:14438            [::]:0                 LISTENING       34412
`;

const TASKLIST = `"System Idle Process","0","Services","0","8 K"
"DeepSeek Harness.exe","34412","Console","1","201,344 K"
"node.exe","39911","Console","1","88,120 K"
"DeepSeek Harness.exe","36968","Console","1","120,004 K"
"QQ.exe","8944","Console","1","64,220 K"`;

await test('netstat：只认 LISTENING 的 TCP，UDP 与已建立的连接不算', () => {
  const ports = parseNetstat(NETSTAT);
  assert.deepEqual(ports.map((item) => item.port).sort((a, b) => a - b), [135, 14438, 14438, 16000]);
  assert.ok(ports.every((item) => item.pid > 0));
  // ESTABLISHED 的那一行不能被当成监听（否则 14438 会重复算两次以上）
  assert.equal(ports.filter((item) => item.port === 14438).length, 2, 'IPv4 + IPv6 各一条，ESTABLISHED 不算');
});

await test('tasklist：带空格的镜像名和带逗号的内存列都要切对', () => {
  const table = parseTasklist(TASKLIST);
  assert.equal(table.get(34412), 'DeepSeek Harness.exe');
  assert.equal(table.get(39911), 'node.exe');
  assert.equal(table.size, 4, 'PID 0 的 System Idle Process 不是监听者，跳过');
});

await test('DSH 端口只按进程名挑，别的服务不会被误当成 DSH', () => {
  const table = parseTasklist(TASKLIST);
  const ports = parseNetstat(NETSTAT);
  assert.deepEqual(dshPorts(ports, table), [14438]);
  // 名字不像 DSH 的进程一个都不给
  assert.deepEqual(dshPorts(parseNetstat('  TCP    127.0.0.1:8080   0.0.0.0:0   LISTENING   39911'),
    parseTasklist('"node.exe","39911","Console","1","1 K"')), []);
});

await test('配置：默认值、环境变量、命令行参数三级覆盖', () => {
  const base = readConfig({}, 'D:/proj/');
  assert.equal(base.port, 7788);
  assert.equal(base.onebot, 'http://127.0.0.1:16000');
  // project 自带结尾分隔符时不能多退一层（曾经把路径算到盘符上）
  assert.match(base.snowlumaDir.replace(/\\/g, '/'), /^D:\/SnowLuma-validation\/runtime$/i);

  const env = readConfig({ QQ_CONSOLE_PORT: '7799', QQ_ONEBOT: 'http://127.0.0.1:17000/' },
    'D:/proj/', []);
  assert.equal(env.port, 7799);
  assert.equal(env.onebot, 'http://127.0.0.1:17000', '结尾斜杠要去掉');

  // WMI 起进程时带不了环境变量，只能走命令行 —— 这条路径必须能用。
  const argv = readConfig({}, 'D:/proj/', ['--port', '7801', '--onebot=http://127.0.0.1:18000']);
  assert.equal(argv.port, 7801);
  assert.equal(argv.onebot, 'http://127.0.0.1:18000');
  assert.equal(readConfig({}, 'D:/proj/', ['--port', 'abc']).port, 7788, '非法端口要退回默认');
});

await test('探测：三件事分开判 —— DSH 在跑不代表桥接挂上了', async () => {
  const config = readConfig({}, 'D:/proj/');
  // 进程表注入：这个断言之前会去读**真实**的 netstat，机器上 DSH 一换端口它就红。
  const table = { ports: parseNetstat(NETSTAT), table: parseTasklist(TASKLIST), dsh: [14438], at: Date.now() };
  const readTable = async () => table;
  const cache = { at: 0, value: null };
  const bridgeCache = { at: 0, url: '', value: null };
  const realFetch = globalThis.fetch;
  try {
    // 端口上没有桥接（404）→ up:false，但 dsh.running 仍为 true
    globalThis.fetch = async () => new Response('not found', { status: 404 });
    const down = await probe(config, { cache, bridgeCache, readTable });
    assert.equal(down.dsh.running, true);
    assert.deepEqual(down.dsh.ports, [14438]);
    assert.equal(down.bridge.up, false);

    // 桥接正常回 JSON
    globalThis.fetch = async (url) => {
      if (String(url).includes('/qq/onebot')) {
        return new Response(JSON.stringify({ ok: true, build: 'v1', agentEnabled: true, conversations: 3 }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ status: 'ok', data: { online: true } }), { status: 200 });
    };
    const up = await probe(config, { cache, bridgeCache, readTable });
    assert.equal(up.bridge.up, true);
    assert.equal(up.bridge.build, 'v1');
    assert.match(up.bridge.panelUrl, /\/qq\/onebot\/panel$/);
    // 顺手确认它记下了地址：下一次先试这个端口，不必再全量扫。
    assert.match(bridgeCache.url, /:14438\/qq\/onebot$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** 最小 HTTP 客户端：只走本机回环，自己拼请求，不引入依赖。 */
function call(port, pathname, { method = 'GET', body = null, headers = {} } = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? null : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => null) }));
}

await test('接口：状态可读、跨站写被拒、未知动作 404、只认 POST', async () => {
  const fakeState = {
    dsh: { running: true, ports: [14438], pids: [1], url: 'http://127.0.0.1:14438/' },
    bridge: { up: true, url: 'http://127.0.0.1:14438/qq/onebot', build: 'v1', agentEnabled: true },
    snow: { listening: true, online: true, nickname: '鱼' },
  };
  const { server } = createServer({
    config: { ...readConfig({}, 'D:/proj/'), port: 0 },
    probes: async () => fakeState,
    runner: async () => {},
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const status = await call(port, '/api/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.dsh.running, true);
    assert.equal(status.json.bridge.build, 'v1');
    assert.ok(status.json.console.pid > 0);

    assert.equal((await call(port, '/api/action')).status, 405, '动作接口不接受 GET');
    assert.equal((await call(port, '/api/action', { method: 'POST', body: { name: 'nope' } })).status, 404);
    const cross = await call(port, '/api/action', {
      method: 'POST', body: { name: 'startAll' }, headers: { origin: 'https://evil.example' },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.ok, false);
    // 没有 Origin 的本机脚本要能过：启动脚本就是这么调的。
    const scripted = await call(port, '/api/action', { method: 'POST', body: { name: 'startDsh' } });
    assert.equal(scripted.status, 200);
    assert.equal(scripted.json.ok, true);
    assert.match(scripted.json.job.id, /^job-/, '动作返回的是任务对象，页面靠它轮询进度');
    assert.equal(scripted.json.job.label, '启动 DSH');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

await test('任务：子进程输出进日志，同一时刻只允许一件', async () => {
  const config = { ...readConfig({}, 'D:/proj/'), port: 0 };
  // 第一轮"检查"时 DSH 还没起，之后马上就好了：这样 startAll 会走完
  // ① 启动 → ② 等桥接 → ③ 接入三段，而不用真等 90 秒。
  let call = 0;
  const console = createConsole({
    config,
    probes: async () => {
      call++;
      return {
        dsh: { running: call > 1, ports: call > 1 ? [14438] : [] },
        bridge: call > 1
          ? { up: true, url: 'http://127.0.0.1:14438/qq/onebot', build: 'v1' }
          : { up: false },
        snow: {},
      };
    },
    runner: async (script, args, { onLine }) => {
      onLine('假脚本第一行');
    },
  });
  const job = await console.actions.startAll();
  assert.equal(job.running, true, '动作先返回任务对象，页面靠轮询看进度');
  await assert.rejects(() => console.actions.startDsh(), /还在跑/);
  for (let i = 0; i < 60 && job.running; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(job.running, false);
  assert.equal(job.ok, true, job.lines.map((line) => line.text).join(' | '));
  const text = job.lines.map((line) => line.text).join('\n');
  assert.match(text, /① 检查 DSH/);
  assert.match(text, /假脚本第一行/, '子进程输出要原样进日志');
  assert.match(text, /完成/);
  // 上一件结束后闸门要放开：否则一次失败就把控制台永久锁死。
  const again = await console.actions.startDsh();
  for (let i = 0; i < 60 && again.running; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(again.ok, true);
});

await test('同源判定：有 Origin 要跟 Host 一致，脚本调用（无 Origin）放行', () => {
  assert.equal(crossSite({ headers: {} }), false);
  assert.equal(crossSite({ headers: { origin: 'http://127.0.0.1:7788', host: '127.0.0.1:7788' } }), false);
  assert.equal(crossSite({ headers: { origin: 'http://127.0.0.1:7788', host: '127.0.0.1:7799' } }), true);
  assert.equal(crossSite({ headers: { origin: 'null' } }), true);
  assert.equal(crossSite({ headers: { 'sec-fetch-site': 'cross-site' } }), true);
});

await test('口令：配了 QQ_CONSOLE_TOKEN 就必须带，页面正文不下发它', async () => {
  const secret = 'console-secret-42';
  const config = { ...readConfig({ QQ_CONSOLE_TOKEN: secret }, 'D:/proj/'), port: 0 };
  const console = createConsole({
    config,
    probes: async () => ({ dsh: { running: false, ports: [] }, bridge: { up: false }, snow: {} }),
    runner: async () => {},
  });
  const server = http.createServer(createHandler(console));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await call(port, '/api/status')).status, 401);
    assert.equal((await call(port, '/api/status?token=' + secret)).status, 200);
    const page = await fetch(`http://127.0.0.1:${port}/?token=${secret}`).then((response) => response.text());
    assert.doesNotMatch(page, new RegExp(secret), '页面里不能出现口令本身');
    assert.match(page, /id="start-all"/, '页面能打开，且带得动按钮');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


/**
 * 2026-11-02 的事故：`start-qq-mcp.ps1` 每一步都打印了成功（"托管=True"），控制台却
 * 报"超过 240 秒没有结束"。原因是判定等的是**管道 EOF**，而脚本用 `Start-Process`
 * 起的 QQ / SnowLuma 会继承 stdout —— 脚本早就退了，管道一直开着。
 *
 * 这里造一份"起了长命子进程然后立刻退出"的脚本，验证我们看的是进程 exit。
 */
await test('跑脚本看进程 exit，不等管道 EOF（被别人继承 stdout 也不能卡住）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-console-wait-'));
  const script = path.join(dir, 'spawn-holder.ps1');
  // 子进程活 4 秒、继承 stdout；父脚本说完一句就退。
  // 断言"3 秒内就返回"，说明判定看的是进程 exit 而不是管道 EOF（旧实现要等满 4 秒）。
  fs.writeFileSync(script, [
    "Write-Output 'parent-ok'",
    "$p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 4' -WorkingDirectory $env:TEMP -PassThru",
    "Write-Output ('child=' + $p.Id)",
    "exit 0",
  ].join('\r\n'), 'utf8');
  const lines = [];
  const started = Date.now();
  let holderPid = 0;
  try {
    await runPowerShell(script, [], { cwd: dir, onLine: (line) => lines.push(line), timeout: 20000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `应该在子进程还活着时就返回，实际用了 ${elapsed}ms`);
    assert.ok(lines.includes('parent-ok'), '正常输出不能被吞掉');
    const holder = lines.find((line) => /^child=\d+$/.test(line));
    assert.ok(holder, '子进程 pid 那行也要读到');
    holderPid = Number(holder.split('=')[1]);
  } finally {
    // 收工：把还活着的子进程结束掉，别让它拖着临时目录 4 秒（会让清理 EBUSY）。
    if (holderPid) { try { process.kill(holderPid); } catch { /* 已经自己退了 */ } }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录而已 */ }
  }
});

await test('超时消息要说清"没有结束"，便于排查', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-console-timeout-'));
  const script = path.join(dir, 'sleep.ps1');
  fs.writeFileSync(script, "Start-Sleep 30\r\nexit 0\r\n", 'utf8');
  try {
    await assert.rejects(
      () => runPowerShell(script, [], { cwd: dir, timeout: 1500 }),
      (error) => {
        assert.match(error.message, /没有结束/);
        return true;
      },
    );
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 同上 */ }
  }
});

// 汇总行格式要与 tools/run-tests.mjs 的解析一致，否则整套会被判成失败。
console.log(`${passed} passed, ${process.exitCode ? '1 failed' : '0 failed'}`);
