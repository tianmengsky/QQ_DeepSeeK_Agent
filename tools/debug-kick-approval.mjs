/**
 * 手工复现"批准/拒绝踢人审批"，打印原始返回。
 *   node tools/debug-kick-approval.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-kick-'));
const dbFile = path.join(dir, 'bridge.sqlite3');
{
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, source_seq INTEGER,
    dedupe_key TEXT, kind TEXT NOT NULL DEFAULT 'message', payload TEXT NOT NULL,
    deliverable INTEGER NOT NULL DEFAULT 1, acked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL);`);
  db.close();
}
// pending_actions 表由 store 自建，这里手动建一份（结构照抄 lib/store.mjs）
{
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, group_id TEXT NOT NULL,
    user_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', requested_by TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, resolved_at INTEGER,
    resolution TEXT, detail TEXT);`);
  db.close();
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const action = req.url.replace(/^\//, '');
    let params = {};
    try {
      params = JSON.parse(body || '{}');
    } catch {}
    console.log(`   [onebot] ${action} ${JSON.stringify(params)}`);
    const data =
      action === 'get_group_member_list'
        ? [{ user_id: 334, nickname: '群友', role: 'member' }]
        : action === 'set_group_kick'
          ? { ok: true }
          : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const child = spawn(
  process.execPath,
  [path.join(process.cwd(), 'qq-mcp', 'src', 'index.js')],
  {
    env: {
      ...process.env,
      ONEBOT_HTTP: `http://127.0.0.1:${port}`,
      QQ_STATE_DIR: dir,
      QQ_BRIDGE_DB: dbFile,
      QQ_ALLOW_GROUPS: '111',
      QQ_CAPABILITIES: 'manage_group',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`   [mcp stderr] ${d}`));

let id = 0;
const pending = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  }
});

function rpc(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(myId)) {
        pending.delete(myId);
        resolve({ TIMEOUT: true });
      }
    }, 8000);
  });
}

await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'dbg', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });

console.log('\n=== 1) request_kick(334) ===');
const r1 = await call('qq_request_kick', { group_id: 111, user_id: 334 });
console.log('   返回:', JSON.stringify(r1).slice(0, 400));

const m = JSON.stringify(r1).match(/#(\d+)/);
const actionId = m ? Number(m[1]) : null;
console.log('   解析到待办号:', actionId);

console.log('\n=== 2) pending_actions 列出 ===');
const r2 = await call('qq_pending_actions');
console.log('   返回:', JSON.stringify(r2).slice(0, 400));

console.log('\n=== 3) pending_actions 拒绝 ===');
const r3 = await call('qq_pending_actions', { action_id: actionId, approve: false });
console.log('   返回:', JSON.stringify(r3).slice(0, 500));

console.log('\n=== 4) 再申请一次，然后批准 ===');
const r4 = await call('qq_request_kick', { group_id: 111, user_id: 334 });
console.log('   申请返回:', JSON.stringify(r4).slice(0, 300));
const m2 = JSON.stringify(r4).match(/#(\d+)/);
const id2 = m2 ? Number(m2[1]) : null;
const r5 = await call('qq_pending_actions', { action_id: id2, approve: true });
console.log('   批准返回:', JSON.stringify(r5).slice(0, 500));

child.kill();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('\nDONE');
