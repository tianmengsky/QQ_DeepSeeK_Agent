/**
 * QQ 桥接控制台 —— 不寄生在桥接上的那个页面。
 *
 * 为什么要有它：`/qq/onebot/panel` 是桥接插件自己挂出来的，桥接一挂、DSH 一关，
 * 页面跟着一起消失 —— 而"东西全挂了"恰恰是最需要看页面的时候。所以这个控制台是
 * 一个**独立 node 进程**（零依赖，只绑 127.0.0.1），只管三件事：
 *
 *   1. 看见：DSH / SnowLuma / 桥接 三个各自活着没有、关键读数是什么；
 *   2. 拉起：按依赖顺序启动（DSH → 桥接 → 接入与托管），并把子进程输出实时回传；
 *   3. 转场：桥接起来了就把「打开面板」放到最显眼的位置。
 *
 * 它**不实现**任何 QQ / SnowLuma 逻辑：启动接入一律调 `tools/start-qq-mcp.ps1`
 * （那里有互斥锁、复用在线账号、同步上报地址、托管开关，全是踩过坑写下的），
 * 启动 DSH 调 `tools/start-dsh.ps1`。这里只负责顺序、超时和把日志搬给页面。
 *
 * 端口/路径全走环境变量，默认值与 `start-qq-mcp.ps1` 保持一致：
 *   QQ_CONSOLE_PORT   控制台端口（默认 7788）
 *   QQ_ONEBOT         OneBot 地址（默认 http://127.0.0.1:16000）
 *   QQ_SNOWLUMA_DIR   SnowLuma runtime 目录
 *   QQ_DSH_EXE        DSH 可执行文件（不写就用进程里读到的那个）
 *   QQ_BRIDGE         直接指定桥接地址（不写就按 DSH 端口自动发现）
 *   QQ_PANEL_TOKEN    桥接配了 token 时用（只在这里用，不下发给页面）
 *   QQ_CONSOLE_TOKEN  给控制台自己加一道口令（默认不加，只监听本机）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));

/**
 * 环境变量（和少数命令行参数）→ 配置。
 *
 * 为什么还要支持 `--port` 这类参数：启动脚本用 WMI 起进程时没法带环境变量
 * （那是项目里脱离父进程的既有做法，见 start-qq-mcp.ps1），只能塞命令行。
 */
export function readConfig(env = process.env, root = project, argv = []) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const flag = (name) => {
    const prefix = `--${name}=`;
    const inline = argv.find((item) => String(item).startsWith(prefix));
    if (inline) return String(inline).slice(prefix.length);
    const index = argv.findIndex((item) => item === `--${name}`);
    return index >= 0 ? argv[index + 1] : '';
  };
  const pick = (name, fallback) => flag(name) || fallback;
  return {
    project: root,
    port: number(pick('port', env.QQ_CONSOLE_PORT), 7788),
    onebot: String(pick('onebot', env.QQ_ONEBOT) || 'http://127.0.0.1:16000').replace(/\/+$/, ''),
    // 与 start-qq-mcp.ps1 同一个默认目录：tools\..\..\SnowLuma-validation\runtime。
    // 注意 project 自带结尾分隔符（fileURLToPath 的结果），所以只回退一层。
    snowlumaDir: pick('snowluma-dir', env.QQ_SNOWLUMA_DIR) ||
      path.resolve(root, '..', 'SnowLuma-validation', 'runtime'),
    dshExe: String(pick('dsh-exe', env.QQ_DSH_EXE) || ''),
    bridgeUrl: String(pick('bridge', env.QQ_BRIDGE) || '').replace(/\/+$/, ''),
    bridgeToken: String(pick('bridge-token', env.QQ_PANEL_TOKEN) || ''),
    token: String(pick('token', env.QQ_CONSOLE_TOKEN) || ''),
  };
}

/* ── 解析：只在 Windows 上用的两条命令输出 ─────────────────────────────── */

/**
 * `netstat -ano` → 本机 LISTEN 的端口。
 *
 * 只看 LISTENING：UDP 行、以及一大堆 ESTABLISHED（QQ 有几百条）都不是我们关心的，
 * 而且它们会把进程号→端口的映射搅乱。
 */
export function parseNetstat(text) {
  const ports = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [proto, local, , state, pid] = parts;
    if (!/^TCP/i.test(proto)) continue;
    if (!/^LISTEN/i.test(state ?? '')) continue;
    const index = local.lastIndexOf(':');
    if (index < 0) continue;
    const port = Number(local.slice(index + 1));
    const owner = Number(pid);
    if (!Number.isInteger(port) || port <= 0) continue;
    if (!Number.isInteger(owner) || owner <= 0) continue;
    ports.push({ port, pid: owner, address: local.slice(0, index) });
  }
  return ports;
}

/** CSV 的一行；Windows 的 tasklist 会把带空格的镜像名整个括起来。 */
function csvFields(line) {
  const out = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(value); value = ''; continue; }
    value += ch;
  }
  out.push(value);
  return out;
}

/** `tasklist /FO CSV /NH` → Map<pid, "DeepSeek Harness.exe">。 */
export function parseTasklist(text) {
  const table = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || !line.includes(',')) continue;
    const [name, pid] = csvFields(line);
    const id = Number(String(pid ?? '').trim());
    if (!name || !Number.isInteger(id) || id <= 0) continue;
    table.set(id, String(name).trim());
  }
  return table;
}

/** 像 DSH 的进程名。抓不到就退化成"任何叫 harness / deepseek 的东西"。 */
const DSH_NAME = /deepseek\s*harness|(^|[^a-z])harness([^a-z]|$)|dsh([^a-z]|$)/i;

/**
 * 从进程表里挑出 DSH 的监听端口。
 *
 * 为什么要按进程名挑、而不是扫全部端口：桥接挂在 DSH 自己的 HTTP 服务上，
 * 端口每次启动都可能变；而本机监听端口有几十个，逐个发请求既慢又可能撞上
 * 别人的同名路径。按 pid → 进程名先筛一遍，通常只剩 1~2 个候选。
 */
export function dshPorts(ports, table) {
  const out = [];
  for (const item of ports) {
    const name = table.get(item.pid) ?? '';
    if (!DSH_NAME.test(name)) continue;
    if (!out.includes(item.port)) out.push(item.port);
  }
  return out.sort((a, b) => a - b);
}

/* ── 探测 ─────────────────────────────────────────────────────────────── */

async function fetchJson(url, { method = 'GET', headers = {}, body = null, timeout = 1200 } = {}) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, text };
}

/** SnowLuma 的 OneBot 访问令牌写在 `config/onebot_<uin>.json` 里；账号不硬编码，按端口找。 */
function onebotToken(config) {
  try {
    const dir = path.join(config.snowlumaDir, 'config');
    const target = Number(new URL(config.onebot).port || 80);
    for (const name of fs.readdirSync(dir)) {
      if (!/^onebot_\d+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const server of conf?.networks?.httpServers ?? []) {
        if (server?.enabled === false) continue;
        if (Number(server?.port) !== target) continue;
        return String(server?.accessToken ?? '');
      }
    }
  } catch { /* 没配置就是没令牌，401 会照实报出来 */ }
  return '';
}

/** 进程表（pid→名字）与监听端口，两台命令并行跑；2 秒内复用，避免每次刷新都打一遍。 */
function readProcessTable(config, cache) {
  const now = Date.now();
  if (cache.value && now - cache.at < 2000) return Promise.resolve(cache.value);
  const run = (command, args) => new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 4000, maxBuffer: 4 << 20 },
      (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
  });
  return Promise.all([
    run('netstat', ['-ano']),
    run('tasklist', ['/FO', 'CSV', '/NH']),
  ]).then(([netstat, tasklist]) => {
    const table = parseTasklist(tasklist);
    const ports = parseNetstat(netstat);
    const value = { ports, table, dsh: dshPorts(ports, table), at: now };
    cache.at = now;
    cache.value = value;
    return value;
  });
}

/**
 * 一次完整快照。
 *
 * 三个对象的"活"要分开判，因为它们会各自死：DSH 在跑但插件没加载（桥接 404）、
 * 桥接在跑但 OneBot 没起（她听不见）、OneBot 在跑但账号掉线（发不出去）。
 * 合成一个"在线/离线"会让人以为是一个故障，实际要修的地方完全不同。
 */
export async function probe(config, { cache = { at: 0, value: null }, bridgeCache = { at: 0, url: '', value: null },
  // 进程表可注入：单测里绝不能让结果取决于这台机器上现在跑着什么。
  readTable = readProcessTable } = {}) {
  const proc = await readTable(config, cache).catch(() => ({ ports: [], table: new Map(), dsh: [] }));
  const dshPids = [...proc.table.entries()].filter(([, name]) => DSH_NAME.test(name)).map(([pid]) => pid);
  const dsh = {
    running: dshPids.length > 0,
    pids: dshPids.sort((a, b) => a - b),
    ports: proc.dsh,
    /** 有端口才谈得上打开；DSH 的 Web GUI 就在这个端口上。 */
    url: proc.dsh.length ? `http://127.0.0.1:${proc.dsh[0]}/` : null,
  };

  // 桥接：优先用上次找到的地址（DSH 端口会变，但不会每秒变），失败再全量试。
  const candidates = [];
  if (config.bridgeUrl) candidates.push(config.bridgeUrl);
  if (bridgeCache.url) candidates.push(bridgeCache.url);
  for (const port of proc.dsh) candidates.push(`http://127.0.0.1:${port}/qq/onebot`);
  const unique = [...new Set(candidates)];
  const headers = config.bridgeToken ? { authorization: `Bearer ${config.bridgeToken}` } : {};
  /** 找到一个就记住：下次先试它，省掉 45 秒等待里的几十次无效请求。 */
  const remember = (url, value) => {
    bridgeCache.url = url ?? '';
    bridgeCache.value = value ?? null;
    bridgeCache.at = Date.now();
  };
  let bridge = { up: false, url: null, build: null, agentEnabled: null, conversations: null, lastError: null };
  for (const url of unique) {
    try {
      const { status, json } = await fetchJson(url, { headers });
      if (status === 401) {
        bridge = { ...bridge, up: true, url, build: null, unauthorized: true };
        remember(url, bridge);
        break;
      }
      if (json && (json.ok != null || json.agentEnabled != null)) {
        bridge = {
          up: true,
          url,
          build: json.build ?? null,
          agentEnabled: json.agentEnabled ?? null,
          conversations: json.conversations ?? null,
          lastError: json.stats?.lastError ?? null,
          panelUrl: url.replace(/\/qq\/onebot$/, '') + '/qq/onebot/panel',
        };
        remember(url, bridge);
        break;
      }
    } catch { /* 这个端口上没有桥接，下一个 */ }
  }
  if (!bridge.up) remember('', null);

  // SnowLuma：OneBot 有 HTTP 就说明接口活着；账号在不在线要看 get_status。
  const token = onebotToken(config);
  const headersOneBot = token ? { authorization: `Bearer ${token}` } : {};
  const onebotPort = Number(new URL(config.onebot).port || 80);
  const listening = proc.ports.some((item) => item.port === onebotPort);
  let snow = { listening, online: false, account: null, nickname: null, error: null, port: onebotPort };
  try {
    const status = await fetchJson(`${config.onebot}/get_status`, { method: 'POST', headers: headersOneBot, body: '{}' });
    const login = await fetchJson(`${config.onebot}/get_login_info`, { method: 'POST', headers: headersOneBot, body: '{}' });
    if (status.status === 401 || login.status === 401) {
      snow = { ...snow, listening: true, error: '接口在，但没有访问令牌（或令牌不对）' };
    } else {
      snow = {
        ...snow,
        listening: true,
        online: Boolean(status.json?.data?.online),
        good: status.json?.data?.good !== false,
        account: login.json?.data?.user_id ? String(login.json.data.user_id) : null,
        nickname: login.json?.data?.nickname ?? null,
        error: status.json?.data?.online ? null : (status.json?.message || '账号未在线'),
      };
    }
  } catch (error) {
    snow = { ...snow, error: snow.listening ? String(error?.message ?? error) : '接口端口没有响应' };
  }

  return { dsh, bridge, snow, at: Date.now() };
}

/* ── 动作：只负责顺序与超时，具体怎么起交给现成的 ps1 ─────────────────── */

const POWERSHELL = 'powershell.exe';

function runPowerShell(script, args, { cwd, onLine, timeout = 240000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, ...args], { cwd, windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      reject(new Error(`超过 ${Math.round(timeout / 1000)} 秒没有结束，已放弃等待`));
    }, timeout);
    const relay = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.search(/\r?\n/);
          if (index < 0) break;
          const line = buffer.slice(0, index).replace(/\r$/, '').trim();
          buffer = buffer.slice(index + 1).replace(/^\n/, '');
          if (line) onLine?.(line);
        }
      });
      stream.on('end', () => {
        const line = buffer.trim();
        if (line) onLine?.(line);
      });
    };
    relay(child.stdout);
    relay(child.stderr);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code}`));
    });
  });
}

/* ── 任务：串行执行，日志留在内存里给页面读 ────────────────────────────── */

const JOB_LIMIT = 200;

export function createConsole({ config = readConfig(), probes = probe, runner = runPowerShell, now = Date.now } = {}) {
  const cache = { at: 0, value: null };
  const bridgeCache = { at: 0, url: '', value: null };
  const jobs = [];
  let active = null;

  const line = (text, tone = 'info') => {
    if (!active) return;
    active.lines.push({ at: now(), text: String(text), tone });
    if (active.lines.length > JOB_LIMIT) active.lines.splice(0, active.lines.length - JOB_LIMIT);
  };

  async function startJob(name, label, steps) {
    if (active) throw Object.assign(new Error('上一件事还在跑，等它结束'), { status: 409 });
    const job = { id: `job-${now()}-${Math.random().toString(16).slice(2, 8)}`, name, label,
      running: true, ok: null, lines: [], startedAt: now(), endedAt: null };
    jobs.push(job);
    if (jobs.length > 5) jobs.shift();
    active = job;
    (async () => {
      try {
        await steps({ line, job });
        job.ok = true;
        line('完成', 'ok');
      } catch (error) {
        job.ok = false;
        line(String(error?.message ?? error), 'bad');
      } finally {
        job.running = false;
        job.endedAt = now();
        active = null;
      }
    })();
    return job;
  }

  async function snapshot() {
    const state = await probes(config, { cache, bridgeCache });
    const job = jobs.at(-1) ?? null;
    return {
      ok: true,
      now: now(),
      console: { port: config.port, pid: process.pid, project: config.project, onebot: config.onebot },
      dsh: state.dsh,
      bridge: state.bridge,
      snow: state.snow,
      job,
    };
  }

  const actions = {
    /** 一键：DSH → 等桥接 → 接入与托管。这是启动台真正省事的那一步。 */
    async startAll() {
      return startJob('startAll', '启动全部', async ({ line }) => {
        line('① 检查 DSH');
        const state = await probes(config, { cache, bridgeCache });
        if (state.dsh.running) {
          line(`DSH 已在运行（端口 ${state.dsh.ports.join('、') || '未知'}）`);
        } else {
          line('DSH 没在跑，正在拉起…');
          await runner(path.join(config.project, 'tools', 'start-dsh.ps1'), [], {
            cwd: config.project, onLine: (text) => line(text),
          });
          cache.at = 0;
        }
        line('② 等桥接挂上（DSH 起来后插件要一两分钟）');
        let bridge = null;
        for (let i = 0; i < 45; i++) {
          bridgeCache.url = '';
          bridge = (await probes(config, { cache, bridgeCache })).bridge;
          if (bridge?.up) break;
          if (i % 5 === 0) line('仍在等 /qq/onebot …');
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!bridge?.up) throw new Error('等不到桥接：DSH 起来了但 /qq/onebot 没有响应（插件没加载？）');
        line(`桥接就绪：${bridge.url}（build ${bridge.build ?? '未知'}）`);
        line('③ 接入 QQ 并开启托管');
        await runner(path.join(config.project, 'tools', 'start-qq-mcp.ps1'), ['-Mode', 'start'], {
          cwd: config.project, onLine: (text) => line(text),
        });
        cache.at = 0;
      });
    },

    async startDsh() {
      return startJob('startDsh', '启动 DSH', async ({ line }) => {
        const state = await probes(config, { cache, bridgeCache });
        if (state.dsh.running) {
          line(`DSH 已经在跑（端口 ${state.dsh.ports.join('、') || '未知'}），不重复启动`, 'ok');
          return;
        }
        await runner(path.join(config.project, 'tools', 'start-dsh.ps1'), [], {
          cwd: config.project, onLine: (text) => line(text),
        });
        cache.at = 0;
      });
    },

    /** 接入 = SnowLuma + 托管开关。它必须等桥接在，否则 SnowLuma 会把事件发去旧端口。 */
    async startAccess() {
      return startJob('startAccess', '启动接入', async ({ line }) => {
        const state = await probes(config, { cache, bridgeCache });
        if (!state.bridge.up) {
          throw new Error('桥接没在跑：先启动 DSH，接入才有地方上报（顺序反了收不到消息）');
        }
        line(`桥接 ${state.bridge.url}（build ${state.bridge.build ?? '未知'}）`);
        await runner(path.join(config.project, 'tools', 'start-qq-mcp.ps1'), ['-Mode', 'start'], {
          cwd: config.project, onLine: (text) => line(text),
        });
        cache.at = 0;
      });
    },

    async restartHosting() {
      return startJob('restartHosting', '重置托管', async ({ line }) => {
        await runner(path.join(config.project, 'tools', 'start-qq-mcp.ps1'), ['-Mode', 'restart'], {
          cwd: config.project, onLine: (text) => line(text),
        });
        cache.at = 0;
      });
    },

    /** 托管开关直接打桥接的 /control：不开子进程，也就不用等 PowerShell 起来。 */
    async hosting(args) {
      const enabled = args?.enabled === true;
      return startJob('hosting', enabled ? '开启托管' : '关闭托管', async ({ line }) => {
        const state = await probes(config, { cache, bridgeCache });
        if (!state.bridge.up || !state.bridge.url) throw new Error('桥接没在跑，托管开关无从改起');
        const headers = { 'content-type': 'application/json' };
        if (config.bridgeToken) headers.authorization = `Bearer ${config.bridgeToken}`;
        const { status, json } = await fetchJson(state.bridge.url.replace(/\/qq\/onebot$/, '') + '/qq/onebot/control', {
          method: 'POST', headers, body: JSON.stringify({ enabled }), timeout: 8000,
        });
        if (status !== 200 || json?.agentEnabled !== enabled) {
          throw new Error(`桥接没有确认托管状态（HTTP ${status}）`);
        }
        line(`托管已${enabled ? '开启' : '关闭'}`, 'ok');
        cache.at = 0;
      });
    },
  };

  return { actions, snapshot, jobs, config };
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */

const PAGE = new URL('./console/page.html', import.meta.url);
let pageCache = { key: '', html: '' };

function pageHtml() {
  const info = fs.statSync(PAGE);
  const key = `${info.mtimeMs}:${info.size}`;
  if (pageCache.key !== key) pageCache = { key, html: fs.readFileSync(PAGE, 'utf8') };
  return pageCache.html;
}

/**
 * 写操作的同源校验。
 *
 * 这个进程能拉起进程，所以不能让它被任意网页 POST —— 浏览器发起的跨站写请求一定带
 * Origin（或 Sec-Fetch-Site: cross-site），而本机脚本（curl、启动脚本）两者都没有。
 * 判定与桥接 `/control` 一致：没有 Origin 就放行，有就必须和 Host 同源。
 */
export function crossSite(request) {
  const site = String(request.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return true;
  const origin = request.headers?.origin;
  if (!origin) return false;
  if (origin === 'null') return true;
  try {
    return new URL(origin).host !== String(request.headers?.host ?? '');
  } catch {
    return true;
  }
}

function send(response, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

async function readBody(request, limit = 8192) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > limit) throw new Error('body 太大');
  }
  return text ? JSON.parse(text) : {};
}

export function createHandler(console) {
  return async function handler(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const method = String(request.method ?? 'GET').toUpperCase();
    try {
      if (console.config.token) {
        const bearer = String(request.headers?.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (bearer !== console.config.token && url.searchParams.get('token') !== console.config.token) {
          response.setHeader('www-authenticate', 'Bearer');
          return send(response, 401, { ok: false, error: '需要 token' });
        }
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (method !== 'GET' && method !== 'HEAD') return send(response, 405, { ok: false, error: '只读' });
        return send(response, 200, pageHtml());
      }
      if (url.pathname === '/api/status') {
        if (method !== 'GET') return send(response, 405, { ok: false, error: '只读' });
        return send(response, 200, await console.snapshot());
      }
      if (url.pathname === '/api/action') {
        if (method !== 'POST') return send(response, 405, { ok: false, error: '只接受 POST' });
        if (crossSite(request)) return send(response, 403, { ok: false, error: '拒绝跨站请求' });
        const body = await readBody(request);
        const action = console.actions[String(body.name ?? '')];
        if (typeof action !== 'function') return send(response, 404, { ok: false, error: '没有这个动作' });
        const job = await action(body);
        return send(response, 200, { ok: true, job });
      }
      return send(response, 404, { ok: false, error: '没有这个路径' });
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error('[console]', error);
      return send(response, status, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

export function createServer(options) {
  const console = createConsole(options);
  const server = http.createServer(createHandler(console));
  // 只监听回环：这个进程能拉起 DSH，绝不能出现在局域网里。
  server.listen(console.config.port, '127.0.0.1');
  return { server, console };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const config = readConfig(process.env, project, process.argv.slice(2));
  const { server } = createServer({ config });
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.log(`[console] 端口 ${config.port} 已经被占用 —— 大概控制台已经在跑了：`);
      console.log(`http://127.0.0.1:${config.port}/`);
      process.exit(0);
    }
    console.error('[console]', error);
    process.exit(1);
  });
  server.on('listening', () => {
    console.log(`QQ 桥接控制台： http://127.0.0.1:${config.port}/`);
    console.log(`OneBot ${config.onebot} · 项目 ${config.project}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(() => process.exit(0)); });
  }
}
