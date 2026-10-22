/**
 * mcp.test.mjs —— qq-mcp 的三层授权 / 持久配额 / 幂等 / 内容寻址图库的协议级测试。
 *
 *   node test/mcp.test.mjs
 *
 * 真的 spawn 一个 qq-mcp 子进程，走标准 MCP stdio JSON-RPC。
 * OneBot 侧用一个假的 HTTP 服务顶替（127.0.0.1 随机端口），不发真消息。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Store } from '../lib/store.mjs';
import { EpisodeLedger } from '../lib/memory/episodes.mjs';
import { CHAT_TOOLS, ADMIN_TOOLS, QQ_SESSION_TOOLS } from '../lib/agent/tool-sets.mjs';
import { publishFloorSource, recordFloorRecall } from '../lib/conversation/floor.mjs';
import { publishImageCatalog } from '../lib/agent/image-catalog.mjs';
import { TaskRouting } from '../lib/conversation/task-routing.mjs';
import { publishExecutionSource, publishTurnSession } from '../lib/agent/execution-scope.mjs';
import { bindToolSource } from '../lib/agent/tool-binding.mjs';

/** 造测试用的桥接库需要同步的 node:sqlite。 */
const require = createRequire(import.meta.url);
const forwardPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');

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

// ---------------------------------------------------------------- 假 OneBot

/** 一个最小的 OneBot v11 HTTP 服务。记录收到的每个 action。 */
function startFakeOnebot() {
  const calls = [];
  // 自己的账号资料。set_qq_profile / set_self_longnick 会真的改它，
  // 这样"改完回读核实"那一步才测得到（真实接入端也是靠回读取证的）。
  const self = { nickname: '测试鲸鱼', longNick: '' };
  /**
   * 群状态。
   *
   * `name` 是**实时**值（get_group_list no_cache 读它），
   * `cachedName` 故意一直是旧值 —— 复现接入端的 get_group_info 读缓存：
   * 改完群名，缓存里还是旧名，回读必须走 no_cache 才看得到。
   */
  const group = {
    name: '测试群',
    cachedName: '测试群',
    members: [
      { user_id: 333, nickname: '群友' },
      { user_id: 334, nickname: '另一个群友' },
      { user_id: 335, nickname: '第三个群友' },
      { user_id: 336, nickname: '第四个群友' },
    ],
    cards: new Map(),
    banned: new Map(),
    notices: [],
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/forward-image/')) {
      calls.push({ action: 'download_forward_image', params: { url: req.url } });
      res.writeHead(req.url.endsWith('/missing') ? 404 : 200, { 'content-type': 'image/png' });
      res.end(req.url.endsWith('/large') ? Buffer.alloc(4 * 1024 * 1024 + 1) : forwardPng);
      return;
    }
    // 图片端点：不解析 JSON，直接回字节。
    // 用请求路径派生内容，这样不同 URL 会得到不同的 sha256。
    if (req.url.startsWith('/img/')) {
      const seed = req.url.split('/').pop() || 'x';
      const byte = seed.charCodeAt(0) % 256;
      const buf = Buffer.alloc(1024, byte);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(buf);
      return;
    }

    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const action = req.url.replace(/^\//, '');
      let params = {};
      try {
        params = JSON.parse(body || '{}');
      } catch {
        /* 忽略 */
      }
      calls.push({ action, params });

      const reply = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
      };

      if (action === 'get_login_info') {
        return reply({ nickname: self.nickname, user_id: 10001 });
      }
      if (action === 'get_stranger_info') {
        return reply({
          user_id: 10001,
          nickname: self.nickname,
          long_nick: self.longNick,
        });
      }
      if (action === 'set_qq_profile') {
        // 用一个特定昵称模拟"QQ 侧直接拒了"（不落库，回读会发现没变）
        if (params.nickname === '违规昵称') return reply({ result: 1000, errMsg: '昵称违规' });
        if (params.nickname) self.nickname = String(params.nickname);
        if (params.personal_note !== undefined) self.longNick = String(params.personal_note);
        return reply({ result: 0, errMsg: '' });
      }
      if (action === 'set_self_longnick') {
        self.longNick = String(params.longNick ?? '');
        return reply({ result: 0, errMsg: '' });
      }
      if (action === 'get_group_list') {
        // 群名的**实时**来源：set_group_name 成功后会改它；
        // groupNameCached 则故意保持旧值，用来复现"缓存读不到新名字"。
        return reply([{ group_id: 111, group_name: group.name, member_count: 3 }]);
      }
      if (action === 'get_group_info') {
        return reply({
          group_id: 111,
          group_name: group.cachedName,
          member_count: 3,
          max_member_count: 200,
        });
      }
      if (action === 'set_group_name') {
        // 这个特定名字模拟"QQ 侧收下了但没真的改"（权限/审核/频率限制）
        if (String(params.group_name) !== '不生效的名字') {
          group.name = String(params.group_name ?? group.name);
        }
        return reply({});
      }
      if (action === 'get_group_member_info') {
        if (!group.members.some((m) => String(m.user_id) === String(params.user_id))) {
          // 人不在群里 → OneBot 侧报错（踢人回读就是靠这个判定）
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({ status: 'failed', retcode: 1, message: '成员不存在' }),
          );
        }
        const key = String(params.user_id);
        return reply({
          group_id: 111,
          user_id: Number(params.user_id),
          nickname: '群友',
          card: group.cards.get(key) ?? '',
          shut_up_timestamp: group.banned.get(key) ?? 0,
          role: 'member',
        });
      }
      if (action === 'set_group_card') {
        group.cards.set(String(params.user_id), String(params.card ?? ''));
        return reply({});
      }
      if (action === 'set_group_ban') {
        const key = String(params.user_id);
        if (Number(params.duration) > 0) group.banned.set(key, Math.floor(Date.now() / 1000) + Number(params.duration));
        else group.banned.set(key, 0);
        return reply({});
      }
      if (action === '_get_group_notice') {
        return reply(group.notices.map((n) => ({ ...n })));
      }
      if (action === '_send_group_notice') {
        group.notices.push({
          notice_id: 'notice_' + (group.notices.length + 1),
          sender_id: 10001,
          message: { text: String(params.content ?? '') },
        });
        return reply({});
      }
      if (action === '_del_group_notice') {
        group.notices = group.notices.filter((n) => String(n.notice_id) !== String(params.notice_id));
        return reply({});
      }
      if (action === 'get_friend_list') {
        return reply([{ user_id: 222, nickname: '好友' }]);
      }
      if (action === 'get_group_member_list') {
        /**
         * 多给几个成员。
         *
         * 原来只有 333 一个，于是"踢人审批"那几条测试全被
         * `assertGroupMember` 正确地拦下了 —— 那其实说明校验是好的，
         * 但测不到审批流程本身。成员表丰富一点才测得到后面。
         *
         * 名单由 group.members 驱动，这样"踢完人回读不见了"才测得到。
         */
        return reply(
          group.members.map((m) => ({
            user_id: m.user_id,
            nickname: m.nickname,
            card: group.cards.get(String(m.user_id)) ?? '',
            shut_up_timestamp: group.banned.get(String(m.user_id)) ?? 0,
            role: 'member',
          })),
        );
      }
      if (action === 'get_forward_msg') {
        if (onebot.forwardNodes) return reply({ messages: onebot.forwardNodes });
        return reply({ messages: Array.from({ length: 45 }, (_, i) => ({
          sender: { user_id: 200 + i, nickname: `节点${i}` },
          content: [{ type: 'text', data: { text: `转发内容 ${i}` } }],
        })) });
      }
      if (action === 'get_image' && params.file === 'forward-local')
        return reply({ file: onebot.forwardImageFile });
      if (action === 'get_msg') {
        return reply({ message: [{ type: 'forward', data: { id: 'quoted-forward' } }] });
      }
      if (action === 'fetch_custom_face') {
        return reply(
          onebot.faces ?? [`http://127.0.0.1:${server.address().port}/face/1.png`],
        );
      }
      if (params.message === 'timeout-regression') {
        setTimeout(() => reply({ message_id: calls.length }), 800);
        return;
      }
      if (params.message === 'progress-wait') {
        setTimeout(() => reply({ message_id: calls.length }), 100);
        return;
      }
      if (params.message === 'progress-unknown') return reply({});
      if (params.message === 'progress-failed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: '进度发送被拒绝' }));
      }
      if (action === 'send_group_msg' || action === 'send_private_msg') {
        return reply({ message_id: calls.length });
      }
      // ---- QQ 内置 AI 语音（SnowLuma send_group_ai_record / get_ai_characters）
      if (action === 'get_ai_characters') {
        if (params.group_id === 444) return reply([]);
        return reply([
          { type: '热门', characters: [
            { character_id: '1001', character_name: '小微', preview_url: 'http://x/1.mp3' },
            { character_id: '1002', character_name: '子墨', preview_url: 'http://x/2.mp3' },
          ] },
          { type: '国风', characters: [
            { character_id: '2001', character_name: '青黛', preview_url: 'http://x/3.mp3' },
          ] },
        ]);
      }
      if (action === 'send_group_ai_record') {
        if (params.text === '语音未知') return reply({});
        if (params.text === '语音被拒') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'AI 语音被拒绝' }));
        }
        return reply({ message_id: 70000 + calls.length });
      }
      if (action === 'upload_group_file' || action === 'upload_private_file') {
        if (params.name === 'unknown.html') return reply({});
        if (params.name === 'failed.html') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: '文件上传被拒绝' }));
        }
        return reply({ file_id: 'file-' + calls.length });
      }
      return reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // 也提供一个可下载的假 PNG，供图库收藏测试用
      server.on('request', () => {});
      resolve({ server, calls, self, group, port: server.address().port, faces: null });
    });
  });
}

// ---------------------------------------------------------------- MCP 客户端

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 调用超时：${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async init() {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'qq-mcp-test', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async call(name, args = {}) {
    const res = await this.send('tools/call', { name, arguments: args });
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { text, isError: Boolean(res.isError), raw: res };
  }

  async listTools() {
    const res = await this.send('tools/list', {});
    return res.tools ?? [];
  }

  kill() {
    // 只 kill() 不够：stdin 管道还开着，父进程的事件循环不会退出。
    // 必须显式 end() 掉 stdio，并留一个兜底 kill。
    try {
      this.child.stdin.end();
    } catch {
      /* 可能已经关了 */
    }
    try {
      this.child.kill();
    } catch {
      /* 已经退出了 */
    }
  }
}

/** 起一个配好环境变量的 qq-mcp 子进程。 */
function startMcp(env) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'qq-mcp', 'src', 'index.js')], {
    env: {
      ...process.env,
      /**
       * 默认**不要**读仓库里那份真实表情目录：它是本机账号的私有数据，
       * 让测试读到会让断言随账号变化漂移（"#1 是哪张图"根本不确定）。
       * 需要目录的用例显式传 QQ_STICKER_CATALOG。
       */
      QQ_STICKER_CATALOG: path.join(tmpDir(), 'no-catalog.json'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => stderr.push(d));
  const client = new McpClient(child);
  client.stderrText = () => stderr.join('');
  return client;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-test-'));
}

const onebot = await startFakeOnebot();

// ---------------------------------------------------------------- 测试

console.log('qq-mcp: 工具表与授权可见性');

await test('QQ_TOOLSET=chat 真实协议仅暴露聊天工具，能力授权仍独立生效', async () => {
  const dir = tmpDir();
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_group_info' });
  try {
    await client.init();
    const tools = await client.listTools();
    assert.equal(tools.length, CHAT_TOOLS.length);
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CHAT_TOOLS].sort());
    const denied = await client.call('qq_send_group_msg', { group_id: 111, message: '离线测试' });
    assert.equal(denied.isError, true);
  } finally { client.kill(); }
});

await test('qq_read_image 懒列目录，按序读取当前/历史/引用多图，宿主绑定防止跨会话读取', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge), conversation = 'group:111';
  const ref = ledger.origin(conversation, { qq: '222', messageId: 'image-source', text: '比较这些图' });
  const other = ledger.origin('group:222', { qq: '333', messageId: 'foreign', text: '另一个群' });
  const sharp = createRequire(new URL('../qq-mcp/package.json', import.meta.url))('sharp');
  const bytes = await Promise.all([0, 1, 2].map((i) => sharp({ create: { width: 2, height: 2, channels: 3,
    background: { r: i * 100, g: 10, b: 20 } } }).png().toBuffer()));
  const images = bytes.map((buffer, i) => {
    const file = path.join(dir, `picture-${i}.png`); fs.writeFileSync(file, buffer);
    return { type: 'image', data: { file } };
  });
  const rows = [
    { messageId: 'history', source: 'history', who: '早先用户', images, attached: [2] },
    { messageId: 'image-source', source: 'current', images: [images[2]], attached: [0] },
    { messageId: 'quoted', source: 'quote', images: [images[1]], attached: [] },
    { messageId: 'missing', source: 'history', images: [{ type: 'image', data: { file: 'missing-image.png' } }] },
  ];
  publishImageCatalog(bridge, ref, conversation, rows);
  publishImageCatalog(bridge, other, 'group:222', [{ messageId: 'foreign', images }]);
  publishTurnSession(bridge, 'real-session', { conversation, sourceRef: ref });
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_BRIDGE_DB: bridge.path, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_image' });
  try {
    await client.init();
    const schema = (await client.listTools()).find((t) => t.name === 'qq_read_image');
    assert.ok(schema); assert.equal(schema.inputSchema.properties.source_ref, undefined);
    const before = onebot.calls.length;
    const listing = await client.call('qq_read_image', { source_ref: ref });
    assert.equal(listing.isError, false, listing.text);
    assert.deepEqual(JSON.parse(listing.text).messages.slice(0, 3).map((m) => m.image_count), [3, 1, 1]);
    assert.deepEqual(JSON.parse(listing.text).messages[0].attached_indices, [2]);
    assert.equal(onebot.calls.length, before);
    for (const i of [0, 1, 2]) {
      const result = await client.call('qq_read_image', { source_ref: ref, message_id: 'history', image_index: i });
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(Buffer.from(result.raw.content.find((c) => c.type === 'image').data, 'base64'), bytes[i]);
      assert.equal(JSON.parse(result.text).next_image_index, i < 2 ? i + 1 : null);
    }
    for (const [messageId, index] of [['image-source', 2], ['quoted', 1]]) {
      const result = await client.call('qq_read_image', { source_ref: ref, message_id: messageId });
      assert.equal(result.isError, false, result.text);
      assert.deepEqual(Buffer.from(result.raw.content.find((c) => c.type === 'image').data, 'base64'), bytes[index]);
    }
    const reread = JSON.parse((await client.call('qq_read_image', { source_ref: ref })).text).messages;
    assert.deepEqual(reread[0].read_indices, [0, 1, 2]);
    assert.deepEqual(reread[3].read_indices, []);
    const exec = { name: 'mcp__qq__qq_read_image', agent: { session: { id: 'real-session' } },
      arguments: { source_ref: other, message_id: 'foreign' } };
    bindToolSource(bridge, exec);
    assert.equal(exec.arguments.source_ref, ref);
    const beforeDenied = onebot.calls.length;
    for (const args of [exec.arguments, { source_ref: ref, message_id: 'unrelated' },
      { source_ref: 'unknown', message_id: 'history' }, { message_id: 'history' },
      ...[-1, 0.5, 3, '1'].map((image_index) => ({ source_ref: ref, message_id: 'history', image_index })),
      { source_ref: ref, image_index: 0 }])
      assert.equal((await client.call('qq_read_image', args)).isError, true, JSON.stringify(args));
    assert.equal(onebot.calls.length, beforeDenied);
    const failed = await client.call('qq_read_image', { source_ref: ref, message_id: 'missing' });
    assert.equal(failed.isError, true); assert.match(failed.text, /未加载/);
    recordFloorRecall(bridge, conversation, 'history');
    assert.equal((await client.call('qq_read_image', { source_ref: ref, message_id: 'history' })).isError, true);
    assert.equal(JSON.parse((await client.call('qq_read_image', { source_ref: ref })).text).messages.some((m) => m.message_id === 'history'), false);
    ledger.retract(conversation, 'image-source');
    assert.equal((await client.call('qq_read_image', { source_ref: ref })).isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('qq_read_image 遵守能力位、白名单、失效目录与单小时图片配额', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', messageId: 'source', text: '看图' });
  const file = path.join(dir, 'picture.png'); fs.writeFileSync(file, forwardPng);
  const rows = [{ messageId: 'source', images: [{ type: 'image', data: { file } }] }];
  const env = { ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`, QQ_STATE_DIR: dir,
    QQ_BRIDGE_DB: bridge.path, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_image' };
  let client;
  try {
    publishImageCatalog(bridge, ref, 'group:111', rows);
    for (const overrides of [{ QQ_CAPABILITIES: 'send_text' }, { QQ_ALLOW_GROUPS: '222' }]) {
      client = startMcp({ ...env, ...overrides }); await client.init();
      const before = onebot.calls.length;
      assert.equal((await client.call('qq_read_image', { source_ref: ref, message_id: 'source' })).isError, true);
      assert.equal(onebot.calls.length, before); client.kill();
    }
    client = startMcp({ ...env, QQ_QUOTA_IMAGE_PER_HOUR: '1' }); await client.init();
    assert.equal((await client.call('qq_read_image', { source_ref: ref, message_id: 'source' })).isError, false);
    assert.equal((await client.call('qq_read_image', { source_ref: ref })).isError, false);
    const quota = await client.call('qq_read_image', { source_ref: ref, message_id: 'source' });
    assert.equal(quota.isError, true); assert.match(quota.text, /配额/);
    publishImageCatalog(bridge, ref, 'group:111', []);
    assert.equal(JSON.parse((await client.call('qq_read_image', { source_ref: ref })).text).messages.length, 0);
    assert.equal((await client.call('qq_read_image', { source_ref: ref, message_id: 'source' })).isError, true);
    publishImageCatalog(bridge, ref, 'group:222', rows);
    assert.equal((await client.call('qq_read_image', { source_ref: ref })).isError, true);
    publishImageCatalog(bridge, ref, 'group:111', rows, -1);
    assert.equal((await client.call('qq_read_image', { source_ref: ref })).isError, true);
  } finally { client?.kill(); bridge.db.close(); }
});

await test('qq_read_forward 只按本轮来源分页读取，并拒绝越权 forward_id', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge), conversation = 'group:111';
  const ref = ledger.origin(conversation, { qq: '222', messageId: 'forward-source', text: '看这个' });
  bridge.recordEvent({ conversation, kind: 'inbound', payload: {
    messageId: 'forward-source', qq: '222', who: '群友', text: '[合并转发]',
    forwards: [{ type: 'forward', data: { id: 'fwd-1' } }], replyToId: null,
  }, deliverable: false });
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_BRIDGE_DB: bridge.path, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_forward' });
  try {
    await client.init();
    const tools = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'qq_read_forward'));
    const first = await client.call('qq_read_forward', { source_ref: ref, forward_id: 'fwd-1', limit: 3 });
    assert.equal(first.isError, false, first.text);
    const page = JSON.parse(first.text);
    assert.equal(page.total, 45);
    assert.equal(page.nodes.length, 3);
    assert.equal(page.next_offset, 3);
    assert.equal(page.has_more, true);
    const last = await client.call('qq_read_forward', { source_ref: ref, forward_id: 'fwd-1', offset: page.next_offset, limit: 20 });
    assert.equal(JSON.parse(last.text).offset, 3);
    assert.equal((await client.call('qq_read_forward', { source_ref: ref, forward_id: 'other' })).isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('qq_read_forward 会核对引用消息中的转发归属', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', messageId: 'quoted-source', text: '引用' });
  bridge.recordEvent({ conversation: 'group:111', kind: 'inbound', payload: {
    messageId: 'quoted-source', qq: '222', who: '群友', text: '[引用]', forwards: [], replyToId: 'quoted-msg',
  }, deliverable: false });
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_BRIDGE_DB: bridge.path, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_forward' });
  try {
    await client.init();
    const res = await client.call('qq_read_forward', { source_ref: ref, forward_id: 'quoted-forward', limit: 1 });
    assert.equal(res.isError, false, res.text);
    assert.equal(JSON.parse(res.text).nodes[0].index, 0);
  } finally { client.kill(); bridge.db.close(); }
});

await test('转发图片按节点懒读取：分页不下载，单次返回真实图片，支持后页及 message 格式', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', messageId: 'media-source', text: '看图' });
  bridge.recordEvent({ conversation: 'group:111', kind: 'inbound', payload: {
    messageId: 'media-source', forwards: [{ type: 'forward', data: { id: 'media-forward' } }],
  }, deliverable: false });
  onebot.forwardImageFile = path.join(dir, 'forward.png');
  fs.writeFileSync(onebot.forwardImageFile, forwardPng);
  onebot.forwardNodes = Array.from({ length: 25 }, (_, i) => ({
    sender: { user_id: 222, nickname: '原作者' },
    message: i === 21 ? [{ type: 'image', data: { url: `http://127.0.0.1:${onebot.port}/forward-image/valid` } }]
      : i === 0 ? [{ type: 'image', data: { file: 'forward-local' } },
        { type: 'image', data: { url: `http://127.0.0.1:${onebot.port}/forward-image/missing` } },
        { type: 'image', data: { url: `http://127.0.0.1:${onebot.port}/forward-image/large` } }]
      : [{ type: 'text', data: { text: '文字节点' } }],
  }));
  const env = { ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`, QQ_STATE_DIR: dir,
    QQ_BRIDGE_DB: bridge.path, QQ_TOOLSET: 'chat', QQ_CAPABILITIES: 'read_forward,read_image' };
  let client = startMcp(env);
  const args = { source_ref: ref, forward_id: 'media-forward' };
  try {
    await client.init();
    const before = onebot.calls.length;
    const page = await client.call('qq_read_forward', args);
    assert.equal(page.isError, false, page.text);
    assert.equal(JSON.parse(page.text).nodes[0].image_count, 3);
    assert.equal(page.raw.content.some((c) => c.type === 'image'), false);
    assert.equal(onebot.calls.slice(before).some((c) => ['get_image', 'download_forward_image'].includes(c.action)), false);
    const local = await client.call('qq_read_forward', { ...args, node_index: 0 });
    assert.equal(local.isError, false, local.text);
    const pixels = local.raw.content.filter((c) => c.type === 'image');
    assert.equal(pixels.length, 1);
    assert.equal(pixels[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(pixels[0].data, 'base64'), forwardPng);
    assert.match(local.text, /原作者/);
    const later = JSON.parse((await client.call('qq_read_forward', { ...args, offset: 20 })).text);
    assert.equal(later.nodes.find((n) => n.index === 21).image_count, 1);
    const remote = await client.call('qq_read_forward', { ...args, node_index: 21, image_index: 0 });
    assert.equal(remote.isError, false, remote.text);
    assert.deepEqual(Buffer.from(remote.raw.content.find((c) => c.type === 'image').data, 'base64'), forwardPng);
    const quotedRef = new EpisodeLedger(bridge).origin('group:111', { qq: '222', messageId: 'media-quote', text: '看引用里的图' });
    bridge.recordEvent({ conversation: 'group:111', kind: 'inbound', payload: {
      messageId: 'media-quote', forwards: [], replyToId: 'quoted-msg',
    }, deliverable: false });
    const quotedImage = await client.call('qq_read_forward', {
      source_ref: quotedRef, forward_id: 'quoted-forward', node_index: 0, image_index: 0,
    });
    assert.equal(quotedImage.isError, false, quotedImage.text);
    assert.equal(quotedImage.raw.content.filter((c) => c.type === 'image').length, 1);
    for (const invalid of [{ node_index: -1 }, { node_index: 0.5 }, { image_index: 0 },
      { node_index: 100 }, { node_index: 1 }, { node_index: 0, image_index: 99 },
      { node_index: 0, image_index: 1 }, { node_index: 0, image_index: 2 }]) {
      const result = await client.call('qq_read_forward', { ...args, ...invalid });
      assert.equal(result.isError, true, JSON.stringify(invalid));
      assert.equal(result.raw.content.some((c) => c.type === 'image'), false);
    }
    const count = onebot.calls.length;
    assert.equal((await client.call('qq_read_forward', { ...args, forward_id: 'unrelated', node_index: 0 })).isError, true);
    assert.equal(onebot.calls.length, count);
    const invalidSource = await client.call('qq_read_forward', { ...args, source_ref: 'unknown', node_index: 0 });
    assert.equal(invalidSource.isError, true);
    assert.equal(onebot.calls.length, count);
    client.kill();
    client = startMcp({ ...env, QQ_CAPABILITIES: 'read_forward' });
    await client.init();
    const denied = await client.call('qq_read_forward', { ...args, node_index: 0 });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /read_image/);
    assert.equal(onebot.calls.length, count);
  } finally { client.kill(); onebot.forwardNodes = null; onebot.forwardImageFile = null; bridge.db.close(); }
});

await test('QQ_TOOLSET=chat,admin 把群管理与改资料一并暴露（2026-10-12）', async () => {
  const dir = tmpDir();
  // 故意只授 send_text：验证"可见 ≠ 可执行"这条边界仍然成立。
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_TOOLSET: 'chat,admin', QQ_CAPABILITIES: 'send_text' });
  try {
    await client.init();
    const names = (await client.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, [...QQ_SESSION_TOOLS].sort(), '会话工具集 = chat + admin');
    for (const name of ADMIN_TOOLS) assert.ok(names.includes(name), name + ' 必须可见');
    const denied = await client.call('qq_set_profile', { nickname: '不该改' });
    assert.equal(denied.isError, true, '没授 set_profile/manage_group 时必须拒绝');
    assert.equal(onebot.self.nickname, '测试鲸鱼', '被拒的调用不能真改掉昵称');
  } finally { client.kill(); }
});

await test('老配置只授 manage_group 时改资料仍可用（兼容位，改完还原）', async () => {
  const dir = tmpDir();
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_TOOLSET: 'admin', QQ_CAPABILITIES: 'manage_group' });
  try {
    await client.init();
    const res = await client.call('qq_set_profile', { nickname: '兼容改名' });
    assert.equal(res.isError, false, res.text);
    assert.equal(onebot.self.nickname, '兼容改名');
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    client.kill();
  }
});

await test('QQ_TOOLSET 写错名字时退回全量并出声', async () => {
  const dir = tmpDir();
  const client = startMcp({ ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir, QQ_TOOLSET: 'chat,typo', QQ_CAPABILITIES: '*' });
  try {
    await client.init();
    const names = (await client.listTools()).map((t) => t.name);
    assert.ok(names.length > QQ_SESSION_TOOLS.length, '未知集合应退回全量而不是只给 chat');
    assert.match(client.stderrText(), /QQ_TOOLSET 里有未知集合/);
  } finally { client.kill(); }
});

await test('未设 QQ_CAPABILITIES 时全部能力可用（兼容旧配置）', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
  });
  await client.init();

  const status = await client.call('qq_status');
  assert.equal(status.isError, false, status.text);
  assert.match(status.text, /全部允许/);
  assert.match(status.text, /测试鲸鱼/);
  assert.match(status.text, /持久化已启用|测试/);
  // 新工具应该在工具表里
  assert.match(status.text, /配额/);
  client.kill();
});

await test('QQ_CAPABILITIES 限制了能力位，越权调用被明确拒绝', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_text',
  });
  await client.init();

  // 允许的：发文字
  const okCall = await client.call('qq_send_group_msg', { group_id: 111, message: '你好' });
  assert.equal(okCall.isError, false, okCall.text);

  // 不允许的：读收藏表情
  const denied = await client.call('qq_list_custom_faces');
  assert.equal(denied.isError, true);
  assert.match(denied.text, /没有「read_favorites」权限/);
  assert.match(denied.text, /QQ_CAPABILITIES/);

  // 不允许的：撤回
  const denied2 = await client.call('qq_delete_msg', { message_id: 1 });
  assert.equal(denied2.isError, true);
  assert.match(denied2.text, /manage_group/);

  client.kill();
});

await test('未知能力位会被拒绝加载（早失败好过沉默失效）', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_CAPABILITIES: 'send_text,teleport',
  });
  const exited = await new Promise((resolve) => {
    client.child.on('exit', (code) => resolve(code));
    /**
     * 等子进程退出的上限。
     *
     * 原来是 8000ms，在连跑 6 套测试、机器负载高的时候偶发踩线 ——
     * 表现为"配置错误时应该直接退出"这条随机失败（而且单跑永远不复现）。
     * 子进程启动 + 抛错退出本来就要一两秒，给 20 秒留足余量，
     * 免得把负载抖动误判成功能问题。
     */
    setTimeout(() => resolve('timeout'), 20000);
  });
  assert.notEqual(exited, 'timeout', '配置错误时应该直接退出，而不是默默忽略');
  assert.notEqual(exited, 0);
  assert.match(client.stderrText(), /teleport/);
  client.kill();
});

console.log('\nqq-mcp: 幂等与配额');

await test('同一 idem_key 重放不重复发送', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_text',
    // 放开配额，免得干扰这一项
    QQ_QUOTA_SEND_PER_MINUTE: '0',
    QQ_QUOTA_SEND_PER_HOUR: '0',
  });
  await client.init();

  const before = onebot.calls.filter((c) => c.action === 'send_group_msg').length;

  const a = await client.call('qq_send_group_msg', {
    group_id: 111,
    message: '带幂等键的消息',
    idem_key: 'test-key-1',
  });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, /已发送/);

  const b = await client.call('qq_send_group_msg', {
    group_id: 111,
    message: '带幂等键的消息',
    idem_key: 'test-key-1',
  });
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, /幂等重放/, '第二次必须是重放');

  const after = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  assert.equal(after - before, 1, 'OneBot 只应该收到一次真实的发送');
  client.kill();
});

await test('查看申请与处理申请是两个能力位（只看≠能放人进来）', async () => {
  const dir = tmpDir();
  // 只给 read_requests，**不给** handle_request
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_CAPABILITIES: 'read_requests',
  });
  await client.init();

  // 查看：没配 QQ_BRIDGE_DB，应该报"没连桥接数据库"而不是"没权限" ——
  // 说明它确实走的是 read_requests 那一档
  const list = await client.call('qq_list_add_requests', {});
  assert.equal(list.isError, true);
  assert.doesNotMatch(list.text, /没有「read_requests」权限/, 'read_requests 已授权，不该被它拦');
  assert.match(list.text, /QQ_BRIDGE_DB|桥接数据库/);

  // 处理：应当被 handle_request 拦住
  const handle = await client.call('qq_handle_add_request', {
    kind: 'friend',
    flag: 'whatever',
    approve: true,
  });
  assert.equal(handle.isError, true);
  assert.match(handle.text, /handle_request/, '处理申请必须单独授权');
  client.kill();
});

await test('配额超限时拒绝，且不消耗幂等编号', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_text',
    QQ_QUOTA_SEND_PER_MINUTE: '2',
    QQ_QUOTA_SEND_PER_HOUR: '0',
  });
  await client.init();

  const before = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  for (const n of [1, 2]) {
    const r = await client.call('qq_send_group_msg', {
      group_id: 111,
      message: `第${n}条`,
      idem_key: `q-${n}`,
    });
    assert.equal(r.isError, false, r.text);
  }
  const third = await client.call('qq_send_group_msg', {
    group_id: 111,
    message: '第3条',
    idem_key: 'q-3',
  });
  assert.equal(third.isError, true);
  assert.match(third.text, /配额已满/);
  assert.match(third.text, /每分钟/);

  const after = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  assert.equal(after - before, 2, '被配额拒绝的不能发出去');

  // 被配额拒过的编号没有被占用：换掉配额后应该还能发
  const status = await client.call('qq_reliability_status');
  assert.match(status.text, /待人工核对/);
  assert.doesNotMatch(status.text, /EXECUTING/, '被配额拒绝不该留下 EXECUTING 占位');
  client.kill();
});

await test('配额是持久的：进程重启后不清零', async () => {
  const dir = tmpDir();
  // Use the hour bucket: a restart must preserve usage, independently of a minute rollover.
  const hourRemaining = 3600000 - Date.now() % 3600000;
  if (hourRemaining < 10000) await new Promise((r) => setTimeout(r, hourRemaining + 10));
  const env = {
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_text',
    QQ_QUOTA_SEND_PER_MINUTE: '0',
    QQ_QUOTA_SEND_PER_HOUR: '1',
  };

  const first = startMcp(env);
  await first.init();
  const okCall = await first.call('qq_send_group_msg', {
    group_id: 111,
    message: '第一条',
    idem_key: 'p1',
  });
  assert.equal(okCall.isError, false, okCall.text);
  const denied = await first.call('qq_send_group_msg', {
    group_id: 111,
    message: '第二条',
    idem_key: 'p2',
  });
  assert.equal(denied.isError, true, '同一进程内第二条就该被拒');
  first.kill();
  await new Promise((r) => setTimeout(r, 300));

  // 换个进程，同一份 STATE_DIR
  const second = startMcp(env);
  await second.init();
  const stillDenied = await second.call('qq_send_group_msg', {
    group_id: 111,
    message: '重启后',
    idem_key: 'p3',
  });
  assert.equal(stillDenied.isError, true, 'Tulpa: 限额持久保存，重连不会重置');
  assert.match(stillDenied.text, /配额已满/);
  second.kill();
});

console.log('\nqq-mcp: 内容寻址图库');

await test('收藏 → 列候选 → 取图 → 发送（含哈希校验与冷却）', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_text,send_sticker,read_image,read_favorites',
    QQ_QUOTA_SEND_PER_MINUTE: '0',
    QQ_QUOTA_SEND_PER_HOUR: '0',
    QQ_QUOTA_IMAGE_PER_HOUR: '0',
    QQ_QUOTA_FAVORITE_READ_PER_HOUR: '0',
    QQ_STICKER_COOLDOWN_SECONDS: '600',
  });
  await client.init();

  // 用一个 data: URL 不行（只收 http），改用假 OneBot 提供的图片端点
  const imgUrl = `http://127.0.0.1:${onebot.port}/img/a.png`;
  const collected = await client.call('qq_collect_sticker', {
    url: imgUrl,
    description: '无语',
    emotion: '无奈',
    usage: '被问到奇怪问题时',
  });
  assert.equal(collected.isError, false, collected.text);
  assert.match(collected.text, /已收藏到图库/);
  const sha = collected.text.match(/sha256：([0-9a-f]{64})/)?.[1];
  assert.ok(sha, `应该返回完整 sha256：${collected.text}`);

  // 同内容再收藏一次（只带 url、不带笔记）→ 不重复占空间，**且不能抹掉已有笔记**
  const again = await client.call('qq_collect_sticker', { url: imgUrl });
  assert.equal(again.isError, false, again.text);
  assert.match(again.text, /已有同一张/);

  // 列候选
  const listed = await client.call('qq_list_library_stickers', { candidates: true });
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /无语/);
  assert.match(listed.text, new RegExp(sha.slice(0, 12)));

  // 取图（走前缀）
  const viewed = await client.call('qq_view_library_sticker', { sha256: sha.slice(0, 12) });
  assert.equal(viewed.isError, false, viewed.text);
  assert.ok(
    (viewed.raw.content ?? []).some((c) => c.type === 'image'),
    '应该返回图片内容',
  );

  // 发送
  const sent = await client.call('qq_send_library_sticker', {
    sha256: sha.slice(0, 12),
    group_id: 111,
    caption: '……',
    idem_key: 'lib-send-1',
  });
  assert.equal(sent.isError, false, sent.text);
  assert.match(sent.text, /冷却/);

  // 冷却生效：刚发过的图不再出现在候选里
  const afterSend = await client.call('qq_list_library_stickers', { candidates: true });
  assert.equal(afterSend.isError, false, afterSend.text);
  assert.match(afterSend.text, /没有符合条件的图/, '刚发过的图应进冷却');

  // 但普通检索还能找到
  const search = await client.call('qq_list_library_stickers', { query: '无奈' });
  assert.equal(search.isError, false, search.text);
  assert.match(search.text, /无语/);

  client.kill();
});

await test('uncertainty 的图不进候选，但能搜到', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_sticker,read_image',
    QQ_QUOTA_IMAGE_PER_HOUR: '0',
    QQ_STICKER_COOLDOWN_SECONDS: '0',
  });
  await client.init();

  await client.call('qq_collect_sticker', {
    url: `http://127.0.0.1:${onebot.port}/img/dark.png`,
    description: '看不清是啥',
    uncertainty: true,
  });

  const candidates = await client.call('qq_list_library_stickers', { candidates: true });
  assert.equal(candidates.isError, false, candidates.text);
  assert.match(candidates.text, /没有符合条件的图/);

  const all = await client.call('qq_list_library_stickers', {});
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /看不清是啥/);
  client.kill();
});

await test('发送不存在的 sha 会报错，不会乱发一张', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'send_sticker',
  });
  await client.init();

  const before = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  const res = await client.call('qq_send_library_sticker', {
    sha256: 'deadbeefdead',
    group_id: 111,
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /找不到/);
  const after = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  assert.equal(after, before, '找不到图时不该发出任何消息');
  client.kill();
});

await test('只接受 http/https 图片地址（不接受本机路径）', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_LIBRARY_DIR: path.join(dir, 'lib'),
    QQ_STICKER_DIR: dir,
    QQ_CAPABILITIES: 'read_image',
    QQ_QUOTA_IMAGE_PER_HOUR: '0',
  });
  await client.init();

  const res = await client.call('qq_collect_sticker', { url: 'C:/Windows/System32/config/SAM' });
  assert.equal(res.isError, true);
  assert.match(res.text, /http\/https/);
  client.kill();
});

console.log('\nqq-mcp: 只读历史检索（授权范围必须由数据库强制）');

/**
 * 造一个假的桥接库：三个授权范围内的会话记录 + 一个范围外的。
 *
 * 事件表结构照抄 lib/store.mjs 的真实 schema —— 测试用的库和线上不一致的话，
 * 这个测试就白写了。
 */
function makeBridgeDb(dir, { allowedGroup = 111, otherGroup = 999 } = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'bridge.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation TEXT NOT NULL,
      source_seq INTEGER,
      dedupe_key TEXT,
      kind TEXT NOT NULL DEFAULT 'message',
      payload TEXT NOT NULL,
      deliverable INTEGER NOT NULL DEFAULT 1,
      acked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  const ins = db.prepare(
    'INSERT INTO events (conversation, kind, payload, created_at) VALUES (?,?,?,?)',
  );
  const now = Date.now();
  const row = (conv, text, who, qq, ago) =>
    ins.run(conv, 'group_message', JSON.stringify({ text, who, qq }), now - ago);
  row(`group:${allowedGroup}`, '早上好', '小明', '1001', 3000);
  row(`group:${allowedGroup}`, '中午吃啥', '小红', '1002', 2000);
  row(`group:${allowedGroup}`, '随便', '小明', '1001', 1000);
  // 范围外的群：里面的内容绝不该被查到
  row(`group:${otherGroup}`, '这是范围外的机密内容', '外人', '9999', 500);
  db.close();
  return file;
}

/** 起一个配好桥接库与白名单的客户端。 */
function startSqlClient(dbFile, caps = 'read_group_info') {
  return startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: path.dirname(dbFile),
    QQ_BRIDGE_DB: dbFile,
    QQ_ALLOW_GROUPS: '111',
    QQ_CAPABILITIES: caps,
  });
}

await test('能查 messages，且只包含授权范围内的记录', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', {
    sql: 'SELECT qq, count(*) c FROM messages GROUP BY qq ORDER BY c DESC',
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /1001/);
  assert.match(res.text, /1002/);
  assert.doesNotMatch(res.text, /范围外的机密内容/, '范围外的内容绝不能出现');
  assert.doesNotMatch(res.text, /9999/, '范围外的人绝不能出现');
  assert.match(res.text, /范围内共 3 条/);
  client.kill();
});

await test('**读 events 原表被拒**（范围由数据库强制，不是靠字符串检查）', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', { sql: 'SELECT * FROM events' });
  assert.equal(res.isError, true, '应该报错而不是返回数据');
  assert.doesNotMatch(res.text, /范围外的机密内容/);
  client.kill();
});

await test('子查询绕道读 events 也被拒', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', {
    sql: 'SELECT count(*) c FROM (SELECT * FROM events)',
  });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.text, /范围外的机密内容/);
  client.kill();
});

await test('多语句被拒', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', {
    sql: 'SELECT 1; DROP TABLE events',
  });
  assert.equal(res.isError, true);
  client.kill();
});

await test('非 SELECT 被拒', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', { sql: 'DELETE FROM messages' });
  assert.equal(res.isError, true);
  assert.match(res.text, /只接受 SELECT/);
  client.kill();
});

await test('**没配白名单就拒绝检索**（默认安全，不是默认放开）', async () => {
  const dir = tmpDir();
  const dbFile = makeBridgeDb(dir);
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_BRIDGE_DB: dbFile,
    // 故意不设 QQ_ALLOW_GROUPS / QQ_ALLOW_USERS
    QQ_CAPABILITIES: 'read_group_info',
  });
  await client.init();
  const res = await client.call('qq_search_history', { sql: 'SELECT * FROM messages' });
  assert.equal(res.isError, true, '白名单为空时必须拒绝');
  assert.match(res.text, /QQ_ALLOW_GROUPS|QQ_ALLOW_USERS/);
  client.kill();
});

await test('缺少 read_group_info 能力位时不能检索', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir), 'send_text');
  await client.init();
  const res = await client.call('qq_search_history', { sql: 'SELECT * FROM messages' });
  assert.equal(res.isError, true);
  assert.match(res.text, /read_group_info/);
  client.kill();
});

await test('limit 生效（截断而不是一次拉回全部）', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  const res = await client.call('qq_search_history', {
    sql: 'SELECT * FROM messages ORDER BY id',
    limit: 2,
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /早上好/);
  assert.match(res.text, /中午吃啥/);
  assert.doesNotMatch(res.text, /随便/, '第 3 条应被 limit 截断');
  assert.match(res.text, /已截断到 2 行/);
  client.kill();
});

await test('hours 能限定时间窗', async () => {
  const dir = tmpDir();
  const client = startSqlClient(makeBridgeDb(dir));
  await client.init();
  // 数据都是"几秒前"，给 0.0001 小时（0.36 秒）应该什么都查不到
  const res = await client.call('qq_search_history', {
    sql: 'SELECT * FROM messages',
    hours: 0.0001,
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /没有命中/);
  client.kill();
});

console.log('\nqq-mcp: 待审批动作（踢人必须人批准）');

function startKickClient(dbFile) {
  return startSqlClient(dbFile, 'manage_group');
}

await test('踢人**不会立刻执行**，只登记成待办', async () => {
  const dir = tmpDir();
  const client = startKickClient(makeBridgeDb(dir));
  await client.init();
  onebot.calls.length = 0;

  const res = await client.call('qq_request_kick', {
    group_id: 111,
    user_id: 333,
    reason: '刷屏',
  });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /没有立刻执行|不会立刻执行/);
  // 关键：绝不能真的调 set_group_kick
  assert.equal(
    onebot.calls.filter((c) => c.action === 'set_group_kick').length,
    0,
    '踢人不能立即执行',
  );
  client.kill();
});

await test('批准后才真的调 set_group_kick', async () => {
  const dir = tmpDir();
  const client = startKickClient(makeBridgeDb(dir));
  await client.init();
  onebot.calls.length = 0;

  const req = await client.call('qq_request_kick', { group_id: 111, user_id: 333 });
  assert.equal(req.isError, false, req.text);
  const id = Number((req.text.match(/#(\d+)/) ?? [])[1]);
  assert.ok(id > 0, `应该拿到待办编号，实际：${req.text}`);

  const list = await client.call('qq_pending_actions');
  assert.match(list.text, /333/);

  const okRes = await client.call('qq_pending_actions', { action_id: id, approve: true });
  assert.equal(okRes.isError, false, okRes.text);
  const kicks = onebot.calls.filter((c) => c.action === 'set_group_kick');
  assert.equal(kicks.length, 1, '批准后应该真的踢一次');
  assert.equal(String(kicks[0].params.user_id), '333');
  client.kill();
});

await test('拒绝则**不执行任何 QQ 操作**', async () => {
  const dir = tmpDir();
  const client = startKickClient(makeBridgeDb(dir));
  await client.init();
  onebot.calls.length = 0;

  const req = await client.call('qq_request_kick', { group_id: 111, user_id: 334 });
  const id = Number((req.text.match(/#(\d+)/) ?? [])[1]);
  const res = await client.call('qq_pending_actions', { action_id: id, approve: false });
  assert.equal(res.isError, false, res.text);
  assert.equal(
    onebot.calls.filter((c) => c.action === 'set_group_kick').length,
    0,
    '拒绝绝不能踢人',
  );
  client.kill();
});

await test('同一个踢人请求不会重复登记', async () => {
  const dir = tmpDir();
  const client = startKickClient(makeBridgeDb(dir));
  await client.init();
  const a = await client.call('qq_request_kick', { group_id: 111, user_id: 335 });
  const b = await client.call('qq_request_kick', { group_id: 111, user_id: 335 });
  assert.equal(b.isError, false);
  assert.match(b.text, /已经提交过/);
  assert.match(a.text, /#\d+/);
  client.kill();
});

await test('已经决议过的待办不会被再执行一次', async () => {
  const dir = tmpDir();
  const client = startKickClient(makeBridgeDb(dir));
  await client.init();
  onebot.calls.length = 0;
  const req = await client.call('qq_request_kick', { group_id: 111, user_id: 336 });
  const id = Number((req.text.match(/#(\d+)/) ?? [])[1]);
  await client.call('qq_pending_actions', { action_id: id, approve: true });
  onebot.calls.length = 0;

  const again = await client.call('qq_pending_actions', { action_id: id, approve: true });
  assert.equal(again.isError, false);
  assert.match(again.text, /已经决议过/);
  assert.equal(onebot.calls.filter((c) => c.action === 'set_group_kick').length, 0, '不能重复踢人');
  client.kill();
});

console.log('\nqq-mcp: 群公告（发 / 删）');

await test('notice_set 原样发公告，notice_del 删指定公告', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'manage_group',
    QQ_ALLOW_GROUPS: '111',
  });
  try {
    await client.init();
    onebot.calls.length = 0;

    const text = '本群公告：周五晚八点开黑，来的扣 1。';
    const set = await client.call('qq_manage_group', {
      action: 'notice_set',
      group_id: 111,
      content: text,
      pinned: true,
    });
    assert.equal(set.isError, false, set.text);
    // 现在这里还要带一次回读（真实公告列表里的那条），文案随之变化
    assert.match(set.text, /回读确认/);
    assert.match(set.text, /本群公告：周五晚八点开黑/);

    const sent = onebot.calls.filter((c) => c.action === '_send_group_notice');
    assert.equal(sent.length, 1, '应该真的调一次 _send_group_notice');
    assert.equal(sent[0].params.content, text, '公告正文必须原样传出去');
    assert.equal(String(sent[0].params.pinned), '1');

    const del = await client.call('qq_manage_group', {
      action: 'notice_del',
      group_id: 111,
      notice_id: 'notice_777',
    });
    assert.equal(del.isError, false, del.text);
    const dels = onebot.calls.filter((c) => c.action === '_del_group_notice');
    assert.equal(dels.length, 1);
    assert.equal(String(dels[0].params.notice_id), 'notice_777');
  } finally {
    client.kill();
  }
});

await test('notice_set 空正文 / notice_del 缺 ID 都在本地拦下，不发请求', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'manage_group',
    QQ_ALLOW_GROUPS: '111',
  });
  try {
    await client.init();
    onebot.calls.length = 0;
    const empty = await client.call('qq_manage_group', {
      action: 'notice_set',
      group_id: 111,
      content: '   ',
    });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /非空的 content/);
    const noId = await client.call('qq_manage_group', { action: 'notice_del', group_id: 111 });
    assert.equal(noId.isError, true);
    assert.match(noId.text, /notice_id/);
    assert.equal(
      onebot.calls.filter((c) => c.action.startsWith('_')).length,
      0,
      '参数不全不能碰 OneBot',
    );
  } finally {
    client.kill();
  }
});

console.log('\nqq-mcp: 改自己的账号资料（昵称 / 签名）');

await test('改昵称会真的调 set_qq_profile，并回读核实', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'set_profile',
  });
  try {
    await client.init();
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    onebot.calls.length = 0;

    const res = await client.call('qq_set_profile', { nickname: '深海小鲸鱼' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /已改/);
    assert.match(res.text, /深海小鲸鱼/, '回复里要带核实后的实际值');

    const writes = onebot.calls.filter((c) => c.action === 'set_qq_profile');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params.nickname, '深海小鲸鱼');
    assert.ok(
      onebot.calls.some((c) => c.action === 'get_stranger_info'),
      '必须回读核实',
    );
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    client.kill();
  }
});

await test('只改签名走 set_self_longnick，不碰昵称', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'set_profile',
  });
  try {
    await client.init();
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    onebot.calls.length = 0;

    const res = await client.call('qq_set_profile', { personal_note: '在吃白饭' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /已改/);
    assert.equal(
      onebot.calls.filter((c) => c.action === 'set_qq_profile').length,
      0,
      '改签名不该顺带重发一次昵称',
    );
    const writes = onebot.calls.filter((c) => c.action === 'set_self_longnick');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].params.longNick, '在吃白饭');
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    client.kill();
  }
});

await test('改成一样的值时短路：不发请求、不吃额度', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'set_profile',
    QQ_QUOTA_PROFILE_PER_DAY: '1',
  });
  try {
    await client.init();
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    onebot.calls.length = 0;

    const same = await client.call('qq_set_profile', { nickname: '测试鲸鱼' });
    assert.equal(same.isError, false, same.text);
    assert.match(same.text, /没改/);
    assert.equal(
      onebot.calls.filter((c) => c.action.startsWith('set_')).length,
      0,
      '同名不该发任何写请求',
    );

    // 额度（1 次/天）没被那次短路吃掉 → 真改一次仍然可以
    const real = await client.call('qq_set_profile', { nickname: '改名一次' });
    assert.equal(real.isError, false, real.text);
    // 第二次真改就被天闸拦住
    const third = await client.call('qq_set_profile', { nickname: '再改一次' });
    assert.equal(third.isError, true);
    assert.match(third.text, /配额已满/);
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    client.kill();
  }
});

await test('两个参数都不给时报错，且不碰 OneBot', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'set_profile',
  });
  try {
    await client.init();
    onebot.calls.length = 0;
    const res = await client.call('qq_set_profile', {});
    assert.equal(res.isError, true);
    assert.match(res.text, /至少要给一个/);
    assert.equal(onebot.calls.length, 0);
  } finally {
    client.kill();
  }
});

await test('QQ 侧返回非 0 时如实报"没生效"（不回读也一样）', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'set_profile',
  });
  try {
    await client.init();
    onebot.self.nickname = '测试鲸鱼';
    onebot.calls.length = 0;

    const res = await client.call('qq_set_profile', { nickname: '违规昵称' });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /没生效/);
    assert.match(res.text, /result=1000/);
    assert.match(res.text, /昵称违规/);
    assert.equal(onebot.self.nickname, '测试鲸鱼', '被拒时昵称不能被改掉');
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    onebot.self.longNick = '';
    client.kill();
  }
});

console.log('\nqq-mcp: 改完即时回读（群名/名片/禁言/公告）');

async function adminClient(extra = {}) {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'manage_group,set_profile,read_group_info',
    ...extra,
  });
  await client.init();
  return client;
}

await test('改群名后回读用的是**实时**群名，不是缓存里的旧值', async () => {
  const client = await adminClient();
  try {
    onebot.group.name = '测试群';
    onebot.group.cachedName = '测试群'; // 故意永远停在旧值
    onebot.calls.length = 0;

    const res = await client.call('qq_manage_group', {
      action: 'set_group_name',
      group_id: 111,
      name: '新群名',
    });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /回读确认/);
    assert.match(res.text, /新群名/, '回读值要出现在回复里');
    // 必须真的走了 no_cache 那条读法
    assert.ok(
      onebot.calls.some((c) => c.action === 'get_group_list' && c.params.no_cache === true),
      '回读必须用 get_group_list{no_cache:true}',
    );
    // step 2.5：QQ 侧没生效时不许报成功
    onebot.group.name = '还是旧名';
    const stale = await client.call('qq_manage_group', {
      action: 'set_group_name',
      group_id: 111,
      name: '不生效的名字',
    });
    assert.equal(stale.isError, false, stale.text);
    assert.match(stale.text, /没生效/);
    assert.match(stale.text, /还是旧名/);
  } finally {
    onebot.group.name = '测试群';
    client.kill();
  }
});

await test('qq_group_info action=info 的群名是实时读的（不被缓存骗）', async () => {
  const client = await adminClient({ QQ_TOOLSET: 'chat,admin' });
  try {
    onebot.group.name = '真名';
    onebot.group.cachedName = '缓存旧名';
    onebot.calls.length = 0;
    const res = await client.call('qq_group_info', { action: 'info', group_id: 111 });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /真名/, '要显示实时群名');
    assert.doesNotMatch(res.text, /缓存旧名/, '缓存值不能冒充群名');
    assert.match(res.text, /实时读取/);
  } finally { client.kill(); }
});

await test('改群名片/禁言/解禁都会回读确认', async () => {
  const client = await adminClient();
  try {
    onebot.group.cards.clear();
    onebot.group.banned.clear();

    const card = await client.call('qq_manage_group', {
      action: 'set_card',
      group_id: 111,
      user_id: 333,
      card: '新名片',
    });
    assert.equal(card.isError, false, card.text);
    assert.match(card.text, /回读确认/);
    assert.match(card.text, /新名片/);

    const ban = await client.call('qq_manage_group', {
      action: 'ban',
      group_id: 111,
      user_id: 334,
      duration: 60,
    });
    assert.equal(ban.isError, false, ban.text);
    assert.match(ban.text, /回读确认/);
    assert.match(ban.text, /禁言中/);

    const unban = await client.call('qq_manage_group', {
      action: 'unban',
      group_id: 111,
      user_id: 334,
    });
    assert.equal(unban.isError, false, unban.text);
    assert.match(unban.text, /回读确认/);
    assert.match(unban.text, /不在禁言中/);
  } finally {
    onebot.group.cards.clear();
    onebot.group.banned.clear();
    client.kill();
  }
});

await test('发公告后回读拿到 notice_id；删掉后回读确认不在了', async () => {
  const client = await adminClient();
  try {
    onebot.group.notices = [];
    const text = '回读测试公告';
    const set = await client.call('qq_manage_group', {
      action: 'notice_set',
      group_id: 111,
      content: text,
    });
    assert.equal(set.isError, false, set.text);
    assert.match(set.text, /回读确认/);
    const id = (set.text.match(/notice_id=([A-Za-z0-9_]+)/) ?? [])[1];
    assert.ok(id, '回读要带回 notice_id：' + set.text);

    const del = await client.call('qq_manage_group', {
      action: 'notice_del',
      group_id: 111,
      notice_id: id,
    });
    assert.equal(del.isError, false, del.text);
    assert.match(del.text, /回读确认/);
    assert.equal(onebot.group.notices.length, 0);
  } finally {
    onebot.group.notices = [];
    client.kill();
  }
});

await test('qq_status 的自己的昵称也是实时读的', async () => {
  const client = await adminClient();
  try {
    onebot.self.nickname = '实时昵称';
    const res = await client.call('qq_status');
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /实时昵称/);
    assert.match(res.text, /昵称实时读取/);
  } finally {
    onebot.self.nickname = '测试鲸鱼';
    client.kill();
  }
});

console.log('\nqq-mcp: 收藏表情按身份匹配（顺序可能翻转）');
await test('收藏列表顺序与目录相反时，编号仍指向目录里那张图', async () => {
  const dir = tmpDir();
  const catalog = path.join(dir, 'catalog.json');
  const first = `http://127.0.0.1:${onebot.port}/img/face-a.png`;
  const second = `http://127.0.0.1:${onebot.port}/img/face-b.png`;
  // 目录 #1 是 second 那张；当前列表却把 second 排在第二位（2026-10-19 的现场）。
  fs.writeFileSync(catalog, JSON.stringify([
    { n: 1, desc: '得意指着人', key: second },
    { n: 2, desc: '我死，我死，我死…', key: first },
  ]));
  onebot.faces = [first, second];
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: '*',
    QQ_STICKER_CATALOG: catalog,
  });
  try {
    await client.init();
    const list = await client.call('qq_list_custom_faces');
    assert.equal(list.isError, false, list.text);
    assert.match(list.text, /#1 {2}得意指着人/);
    assert.match(list.text, /#2 {2}我死，我死，我死…/);

    const before = onebot.calls.length;
    const sent = await client.call('qq_send_custom_face', { group_id: 111, index: 1 });
    assert.equal(sent.isError, false, sent.text);
    const call = onebot.calls.slice(before).find((c) => c.action === 'send_group_msg');
    const file = call.params.message.find((seg) => seg.type === 'image').data.file;
    assert.equal(file, second, '按编号 #1 发出去的必须是目录里那一条，不是列表第一个');
  } finally {
    onebot.faces = null;
    client.kill();
  }
});
await test('目录里的表情被删掉时明确报错，不退回按位置猜一张', async () => {
  const dir = tmpDir();
  const catalog = path.join(dir, 'catalog.json');
  const live = `http://127.0.0.1:${onebot.port}/img/face-c.png`;
  fs.writeFileSync(catalog, JSON.stringify([{ n: 1, desc: '已经被删的那张', key: 'DELETED' }]));
  onebot.faces = [live];
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: '*',
    QQ_STICKER_CATALOG: catalog,
  });
  try {
    await client.init();
    const result = await client.call('qq_send_custom_face', { group_id: 111, index: 1 });
    assert.equal(result.isError, true);
    assert.match(result.text, /不在当前收藏里/);
  } finally {
    onebot.faces = null;
    client.kill();
  }
});

console.log('\nqq-mcp: 审计问题回归');
await test('B10 DRY_RUN 对所有外部写工具禁止执行，也不修改待办', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '1',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: '*',
  });
  try {
    await client.init();
    const before = onebot.calls.length;
    for (const name of [
      'qq_send_group_msg',
      'qq_send_private_msg',
      'qq_send_sticker',
      'qq_send_custom_face',
      'qq_send_library_sticker',
      'qq_send_mface',
      'qq_delete_msg',
      'qq_poke',
      'qq_handle_add_request',
      'qq_manage_group',
      'qq_set_profile',
      'qq_react',
      'qq_request_kick',
      'qq_pending_actions',
    ]) {
      const result = await client.call(name, {
        action: 'ban',
        group_id: 111,
        user_id: 333,
        duration: 60,
        message: 'test',
        action_id: 1,
        approve: true,
      });
      assert.equal(result.isError, false, result.text);
      assert.match(result.text, /dry-run.*未执行/);
    }
    assert.equal(onebot.calls.length, before, 'dry-run 不应产生任何 OneBot 请求');
  } finally {
    client.kill();
  }
});
await test('B11 MCP 超时保持 UNKNOWN，同一编号不再向 OneBot 请求', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_REQUEST_TIMEOUT_MS: '250',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'send_text',
  });
  try {
    await client.init();
    const args = { group_id: 111, message: 'timeout-regression', idem_key: 'timeout-key' };
    const first = await client.call('qq_send_group_msg', args);
    assert.equal(first.isError, true, first.text);
    assert.match(first.text, /UNKNOWN/);
    const second = await client.call('qq_send_group_msg', args);
    assert.equal(second.isError, false, second.text);
    assert.match(second.text, /UNKNOWN.*阻止自动重发/s);
    assert.equal(onebot.calls.filter((c) => c.params.message === args.message).length, 1);
  } finally {
    client.kill();
  }
});
await test('MCP 额度满时仍可重放既有成功回执', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: 'http://127.0.0.1:' + onebot.port,
    QQ_STATE_DIR: dir,
    QQ_DRY_RUN: '0',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'send_text',
    QQ_QUOTA_SEND_PER_MINUTE: '1',
  });
  try {
    await client.init();
    const args = { group_id: 111, message: 'quota-replay', idem_key: 'quota-replay-key' };
    assert.equal((await client.call('qq_send_group_msg', args)).isError, false);
    const replay = await client.call('qq_send_group_msg', args);
    assert.equal(replay.isError, false, replay.text);
    assert.match(replay.text, /幂等重放/);
    assert.equal(onebot.calls.filter((c) => c.params.message === args.message).length, 1);
  } finally {
    client.kill();
  }
});

// ---------------------------------------------------------------- qq_say
//
// 「发言工具」解决的是**归因**问题，不是权限问题：
//   assistant 文本挂在 **turn** 上 —— steer 会把两次提交并进同一个 turn，
//   于是桥接从事件流里没法可靠地认领"哪段文本属于我"，
//   表现就是「DSH 界面里有、QQ 里没有」。
//   而 tool/result 挂在 **callId** 上，是原子的，不存在这个歧义。
//
// 这个工具跑在独立进程里，本来无从知道模型此刻在哪个会话说话，
// 所以桥接把"当前会话"写进共享库，工具据此**校验**目标。

/** 真 Store 用的是 runtime_state(key, value, updated_at)。 */
function makeSayDb(dir, marker, source = null) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(dir, 'bridge-say.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE runtime_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_origins (
      ref TEXT PRIMARY KEY, conversation TEXT NOT NULL, message_id TEXT,
      qq TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation TEXT NOT NULL,
      source_seq INTEGER,
      dedupe_key TEXT UNIQUE,
      kind TEXT NOT NULL DEFAULT 'message',
      payload TEXT NOT NULL,
      deliverable INTEGER NOT NULL DEFAULT 1,
      acked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  let sourceRef = null;
  if (source) {
    sourceRef = source.ref ?? 'say-source';
    db.prepare(`INSERT INTO memory_origins
      (ref, conversation, message_id, qq, who, text, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(sourceRef, source.conversation, source.messageId ?? 'm1', source.qq ?? '200',
        source.who ?? '甲', source.text ?? '当前提问', Date.now(), Date.now() + 600000);
  }
  if (marker !== undefined)
    db.prepare('INSERT INTO runtime_state (key, value, updated_at) VALUES (?,?,?)').run(
      'bridge:active-conversation',
      JSON.stringify(marker),
      Date.now(),
    );
  return { file, db, sourceRef };
}

function startSayClient(dbFile, caps = 'send_text', extra = {}) {
  return startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: path.dirname(dbFile),
    QQ_BRIDGE_DB: dbFile,
    QQ_ALLOW_GROUPS: '',
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: caps,
    ...extra,
  });
}

console.log('\nqq_say: 发言工具（会话绑定 + 结果原子）');

await test('工具表里有 qq_say', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
  });
  try {
    await client.init();
    const tools = await client.listTools();
    assert.ok(
      tools.some((t) => t.name === 'qq_say'),
      '没有 qq_say 的话，高并发下就只能靠脆弱的文本通道',
    );
  } finally {
    client.kill();
  }
});

await test('会话对得上 → 真的发出去，并把自己说的话写回桥接窗口', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir, { key: 'group:111', at: Date.now(), messageId: 'm1' });
  const client = startSayClient(file);
  try {
    await client.init();
    const res = await client.call('qq_say', {
      conversation: 'group:111',
      text: '等下我去看看',
    });
    assert.equal(res.isError, false, res.text);
    assert.match(res.text, /已发送到群 111/);
    assert.equal(
      onebot.calls.filter((c) => c.action === 'send_group_msg' && c.params.message === '等下我去看看')
        .length,
      1,
    );
    // 不写回窗口 → 下一轮它不知道自己说过什么
    const wrote = db
      .prepare("SELECT payload FROM events WHERE conversation = ? AND kind = 'self_message'")
      .all('group:111');
    assert.equal(wrote.length, 1, '必须往桥接窗口补一条 self_message');
    assert.equal(JSON.parse(wrote[0].payload).text, '等下我去看看');
  } finally {
    client.kill();
    db.close();
  }
});

await test('qq_say 里的 @ 标记变成真 at 段，标记本身不漏成正文', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir, { key: 'group:111', at: Date.now(), messageId: 'm1' });
  const client = startSayClient(file);
  const parse = (payload) => {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  };
  try {
    await client.init();
    // 昵称走一次 get_group_member_list（假 OneBot 里 333 = 群友）
    const byName = await client.call('qq_say', { conversation: 'group:111', text: '[@群友] 你看下' });
    assert.equal(byName.isError, false, byName.text);
    const named = onebot.calls.filter((c) => c.action === 'send_group_msg').at(-1);
    assert.ok(Array.isArray(named.params.message), '有 @ 就必须走消息段');
    assert.deepEqual(named.params.message[0], { type: 'at', data: { qq: '333' } });
    assert.ok(!JSON.stringify(named.params.message).includes('[@'), '标记不许漏成正文');

    const numeric = await client.call('qq_say', {
      conversation: 'group:111',
      text: '[@:333333] 别装了',
    });
    assert.equal(numeric.isError, false, numeric.text);
    const byQq = onebot.calls.filter((c) => c.action === 'send_group_msg').at(-1);
    assert.deepEqual(byQq.params.message[0], { type: 'at', data: { qq: '333333' } });

    // 写回桥接窗口的是"人看到的样子"
    const wrote = db
      .prepare("SELECT payload FROM events WHERE conversation = ? AND kind = 'self_message'")
      .all('group:111')
      .map((row) => parse(row.payload)?.text ?? '');
    assert.ok(wrote.length >= 1);
    assert.ok(wrote.every((text) => !text.includes('[@')), `窗口里不该留标记：${wrote.join(' | ')}`);

    // 私聊：没有"点名"这回事，标记摘掉、不发 at
    const dir2 = tmpDir();
    const second = makeSayDb(dir2, { key: 'user:1056612947', at: Date.now(), messageId: 'm2' });
    const client2 = startSayClient(second.file);
    try {
      await client2.init();
      const priv = await client2.call('qq_say', {
        conversation: 'user:1056612947',
        text: '[@:333333] 在的',
      });
      assert.equal(priv.isError, false, priv.text);
      const onlyPriv = onebot.calls.filter((c) => c.action === 'send_private_msg').at(-1);
      assert.equal(typeof onlyPriv.params.message, 'string');
      assert.ok(!onlyPriv.params.message.includes('[@'), '私聊里也不许漏标记');
    } finally {
      client2.kill();
      second.db.close();
    }
  } finally {
    client.kill();
    db.close();
  }
});

await test('会话对不上 → 拒绝，绝不发到别的会话', async () => {
  const dir = tmpDir();
  const { file, db, sourceRef } = makeSayDb(dir, { key: 'group:111', at: Date.now(), messageId: 'm1' },
    { conversation: 'group:111' });
  const client = startSayClient(file);
  try {
    await client.init();
    const res = await client.call('qq_say', { conversation: 'group:999', source_ref: sourceRef, text: '发错群了' });
    assert.equal(res.isError, true, '发错地方必须被拦住');
    assert.match(res.text, /会话对不上/);
    assert.equal(
      onebot.calls.filter((c) => c.params.message === '发错群了').length,
      0,
      '一个字都不该出去',
    );
  } finally {
    client.kill();
    db.close();
  }
});

await test('没有本轮归属时显式 conversation 仍可手动发送', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir);
  const client = startSayClient(file);
  try {
    await client.init();
    const before = onebot.calls.filter((c) => c.params.message === '手动发送').length;
    const res = await client.call('qq_say', { conversation: 'group:111', text: '手动发送' });
    assert.equal(res.isError, false, res.text);
    assert.equal(onebot.calls.filter((c) => c.params.message === '手动发送').length, before + 1);
  } finally {
    client.kill();
    db.close();
  }
});

await test('没有本轮归属且没填 conversation → 明确报错而不是乱发', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir);
  db.prepare('INSERT INTO runtime_state (key, value, updated_at) VALUES (?,?,?)').run(
    'bridge:active-conversation',
    'null',
    Date.now(),
  );
  const client = startSayClient(file);
  try {
    await client.init();
    const res = await client.call('qq_say', { text: 'x' });
    assert.equal(res.isError, true);
    assert.match(res.text, /需要 conversation/);
  } finally {
    client.kill();
    db.close();
  }
});

await test('私聊会话也走同一条路（发给对方，不发给机器人自己）', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir, { key: 'user:1056612947', at: Date.now() });
  const client = startSayClient(file);
  // 假的 OneBot 是**全局累积**的（整个文件共用一个），所以只能比增量
  const groupsBefore = onebot.calls.filter((c) => c.action === 'send_group_msg').length;
  try {
    await client.init();
    const res = await client.call('qq_say', { conversation: 'user:1056612947', text: '在的' });
    assert.equal(res.isError, false, res.text);
    const priv = onebot.calls.filter(
      (c) => c.action === 'send_private_msg' && c.params.message === '在的',
    );
    assert.equal(priv.length, 1);
    assert.equal(String(priv[0].params.user_id), '1056612947', '必须发给对方');
    assert.equal(
      onebot.calls.filter((c) => c.action === 'send_group_msg').length,
      groupsBefore,
      '私聊不能走群接口（那会变成群发骚扰）',
    );
  } finally {
    client.kill();
    db.close();
  }
});

await test('没配 QQ_BRIDGE_DB → 手动发送仍可用，来源类工具给出明确限制', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_MIN_INTERVAL_MS: '0',
    QQ_CAPABILITIES: 'send_text',
  });
  try {
    await client.init();
    const res = await client.call('qq_say', { conversation: 'group:111', text: '手动发送' });
    assert.equal(res.isError, false, res.text);
    const workspace = await client.call('qq_workspace', { conversation: 'group:111', action: 'list' });
    assert.equal(workspace.isError, true);
    assert.match(workspace.text, /只能在本轮 QQ 会话内使用/);
  } finally {
    client.kill();
  }
});

await test('text and sticker tools share speech activity; replay and dry-run do not refresh it', async () => {
  const dir = tmpDir();
  const { file, db } = makeSayDb(dir, { key: 'group:111', at: Date.now() });
  const client = startSayClient(file, 'send_text,send_sticker,read_favorites');
  const speech = (key) => JSON.parse(db.prepare('SELECT value FROM runtime_state WHERE key = ?')
    .get('qq-bridge:speech:' + key)?.value ?? 'null');
  try {
    await client.init();
    const text = await client.call('qq_send_group_msg', { group_id: 111, message: '工具发言', idem_key: 'wake-text' });
    assert.equal(text.isError, false, text.text);
    assert.ok(speech('group:111')?.at > 0);
    const before = speech('group:111');
    const replay = await client.call('qq_send_group_msg', { group_id: 111, message: '工具发言', idem_key: 'wake-text' });
    assert.equal(replay.isError, false, replay.text);
    assert.deepEqual(speech('group:111'), before);
    const face = await client.call('qq_send_custom_face', { user_id: 222, index: 1 });
    assert.equal(face.isError, false, face.text);
    assert.ok(speech('user:222')?.at > 0);
  } finally { client.kill(); }
  const dry = startSayClient(file, 'send_text', { QQ_DRY_RUN: '1' });
  try {
    await dry.init();
    const before = speech('group:111');
    const selfCount = db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'self_message'").get().n;
    const result = await dry.call('qq_say', { conversation: 'group:111', text: '模拟发言' });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(speech('group:111'), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'self_message'").get().n, selfCount);
  } finally { dry.kill(); db.close(); }
});

await test('cross-conversation MCP send persists source and receipt; replay and dry-run create no new experiences', async () => {
  const dir = tmpDir(), { file, db } = makeSayDb(dir, { key: 'group:999', at: Date.now() });
  const store = new Store(file), ledger = new EpisodeLedger(store);
  store.setState('qq-bridge:episodic-memory', 'true');
  const ref = ledger.origin('user:200', { qq: '200', who: '甲', messageId: '1', text: '帮我转告222周三见' });
  const client = startSayClient(file);
  try {
    await client.init();
    const tools = await client.listTools();
    assert.ok(!('source_ref' in (tools.find((t) => t.name === 'qq_send_private_msg').inputSchema.properties ?? {})),
      'source_ref 不再暴露给模型，由宿主按 Session 注入');
    const args = { user_id: 222, message: '周三见', source_ref: ref, idem_key: 'cross-request' };
    const res = await client.call('qq_send_private_msg', args);
    assert.equal(res.isError, false, res.text);
    assert.equal(res.raw.structuredContent.receipt.status, 'SUCCEEDED');
    assert.match(ledger.recall({ conversation: 'user:222', qq: '222' }), /甲.*QQ 200.*user:222 已发送.*周三见/);
    assert.equal(ledger.snapshot().records, 1);
    const replay = await client.call('qq_send_private_msg', args);
    assert.match(replay.text, /幂等重放/); assert.equal(ledger.snapshot().records, 1);
    const count = onebot.calls.length;
    const invalid = await client.call('qq_send_private_msg', { ...args, source_ref: 'wrong', idem_key: 'invalid' });
    assert.equal(invalid.isError, true); assert.equal(onebot.calls.length, count);
    const progress = await client.call('qq_say', { conversation: 'user:200', source_ref: ref, text: '转告好了', idem_key: 'progress' });
    assert.equal(progress.isError, false, progress.text);
    assert.equal(ledger.snapshot().records, 2);
    ledger.retract('user:200', '1');
    const revoked = await client.call('qq_send_private_msg', { ...args, idem_key: 'revoked' });
    assert.equal(revoked.isError, true);
  } finally { client.kill(); }
  const dry = startSayClient(file, 'send_text', { QQ_DRY_RUN: '1' });
  try {
    await dry.init();
    const before = Number(store.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get().n);
    await dry.call('qq_send_private_msg', { user_id: 222, message: '测试', source_ref: ref });
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS n FROM memory_episodes').get().n), before);
  } finally { dry.kill(); store.db.close(); db.close(); }
});

// ---------------------------------------------------------------- 收尾
await test('file mutations use the current source and conversation workspace', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge), ref = ledger.origin('group:111', { qq: '222', text: '写小游戏' });
  const root = path.join(dir, 'workspace'); bridge.setState('qq-bridge:workspace-root', root);
  const args = { conversation: 'group:111', source_ref: ref };
  const client = startSayClient(bridge.path, 'send_text,send_file');
  try {
    await client.init();
    assert.equal((await client.call('qq_workspace', { ...args, action: 'list' })).isError, false);
    const count = onebot.calls.length;
    const written = await client.call('qq_workspace', { ...args, action: 'write', path: 'game.html', content: 'game' });
    assert.equal(written.isError, false, written.text);
    assert.equal(fs.existsSync(path.join(root, 'group-111', 'game.html')), true);
    assert.equal((await client.call('qq_workspace', { ...args, action: 'pack', output: 'game.zip' })).isError, false);
    fs.writeFileSync(path.join(root, 'group-111', 'existing.html'), 'existing');
    assert.equal((await client.call('qq_workspace', { ...args, action: 'read', path: 'existing.html' })).isError, false);
    assert.equal((await client.call('qq_send_file', { ...args, path: 'existing.html' })).isError, false);
    assert.equal(fs.existsSync(path.join(root, 'group-111', '.outgoing')), true);
    assert.ok(onebot.calls.length > count, 'sending a file should not require a progress message');
    // Other send tools and an unbound qq_say are not this turn's start receipt.
    await client.call('qq_send_group_msg', { group_id: 111, source_ref: ref, message: '先写一下' });
    bridge.setState('bridge:active-conversation', JSON.stringify({ key: 'group:111', at: Date.now() }));
    await client.call('qq_say', { conversation: 'group:111', text: '未绑定来源' });
    assert.equal((await client.call('qq_workspace', { ...args, action: 'write', path: 'game.html', content: 'game' })).isError, false);
    const announce = await client.call('qq_say', { ...args, text: '我来做一个能直接打开的小游戏' });
    assert.equal(announce.isError, false, announce.text);
    assert.equal(fs.existsSync(path.join(root, 'group-111', 'game.html')), true, 'file writes do not wait for an announcement');
    assert.equal((await client.call('qq_workspace', { ...args, action: 'write', path: 'game.html', content: 'game' })).isError, false);
  } finally { client.kill(); bridge.db.close(); }
});

await test('parallel file write can proceed while an optional qq_say is in flight', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', text: '写小游戏' });
  const root = path.join(dir, 'workspace'); bridge.setState('qq-bridge:workspace-root', root);
  const args = { conversation: 'group:111', source_ref: ref };
  const client = startSayClient(bridge.path, 'send_text');
  try {
    await client.init();
    const saying = client.call('qq_say', { ...args, text: 'progress-wait' });
    const write = { ...args, action: 'write', path: 'game.html', content: 'game' };
    assert.equal((await client.call('qq_workspace', write)).isError, false);
    assert.equal(fs.existsSync(path.join(root, 'group-111', 'game.html')), true);
    const said = await saying; assert.equal(said.isError, false, said.text);
    assert.equal((await client.call('qq_workspace', write)).isError, false);
  } finally { client.kill(); bridge.db.close(); }
});

await test('conversation workspace is isolated by group/private scope and survives MCP restart', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge);
  const root = path.join(dir, 'workspace'); bridge.setState('qq-bridge:workspace-root', root);
  const ref = ledger.origin('group:111', { qq: '222', text: '写小游戏' });
  const other = ledger.origin('group:222', { qq: '333', text: '写小游戏' });
  const args = { conversation: 'group:111', source_ref: ref };
  let client = startSayClient(bridge.path, 'send_text');
  try {
    await client.init();
    const said = await client.call('qq_say', { ...args, text: '我来写小游戏', idem_key: 'first-progress' });
    assert.equal(said.isError, false, said.text);
    const speech = bridge.getState('qq-bridge:speech:group:111'), count = onebot.calls.length;
    const next = ledger.origin('group:111', { qq: '222', text: '再写一个' });
    assert.equal((await client.call('qq_workspace', { ...args, source_ref: next, action: 'write', path: 'next', content: 'x' })).isError, false);
    assert.equal((await client.call('qq_workspace', { conversation: 'group:222', source_ref: other, action: 'write', path: 'other', content: 'x' })).isError, false);
    client.kill(); client = startSayClient(bridge.path, 'send_text'); await client.init();
    const replay = await client.call('qq_say', { ...args, text: '我来写小游戏', idem_key: 'first-progress' });
    assert.match(replay.text, /幂等重放/);
    assert.equal(onebot.calls.length, count);
    assert.equal(bridge.getState('qq-bridge:speech:group:111'), speech);
    assert.equal((await client.call('qq_workspace', { ...args, action: 'write', path: 'game', content: 'x' })).isError, false);
    // Reusing a previous turn's speech receipt cannot unlock a new source.
    await client.call('qq_say', { ...args, source_ref: next, text: '我来写小游戏', idem_key: 'first-progress' });
    assert.equal((await client.call('qq_workspace', { ...args, source_ref: next, action: 'write', path: 'next', content: 'x' })).isError, false);
    assert.equal(onebot.calls.length, count);
  } finally { client.kill(); bridge.db.close(); }
});

await test('failed, UNKNOWN, dry-run and quota-blocked progress do not block file tasks', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge);
  const root = path.join(dir, 'workspace'); bridge.setState('qq-bridge:workspace-root', root);
  let client = startSayClient(bridge.path, 'send_text');
  try {
    await client.init();
    for (const text of ['progress-failed', 'progress-unknown']) {
      const ref = ledger.origin('group:111', { qq: '222', text: '写小游戏' });
      const args = { conversation: 'group:111', source_ref: ref };
      const sent = await client.call('qq_say', { ...args, text });
      assert.equal(sent.isError, true, sent.text);
      assert.equal((await client.call('qq_workspace', { ...args, action: 'write', path: 'game', content: 'x' })).isError, false);
    }
    const ref = ledger.origin('group:111', { qq: '222', text: '写小游戏' });
    const args = { conversation: 'group:111', source_ref: ref };
    client.kill(); client = startSayClient(bridge.path, 'send_text', { QQ_DRY_RUN: '1' }); await client.init();
    assert.match((await client.call('qq_say', { ...args, text: '模拟开工' })).text, /dry-run/);
    client.kill(); client = startSayClient(bridge.path, 'send_text', { QQ_QUOTA_SEND_PER_HOUR: '1' }); await client.init();
    assert.equal((await client.call('qq_say', { ...args, text: '配额已满开工' })).isError, true);
    assert.equal((await client.call('qq_workspace', { ...args, action: 'write', path: 'game', content: 'x' })).isError, false);
    assert.equal(bridge.getState('qq-bridge:speech:group:111'), null);
    assert.equal(fs.existsSync(path.join(root, 'group-111', 'game')), true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('qq_say without idem_key safely replays the same per-turn announcement', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('user:222', { qq: '222', text: '写小游戏' });
  const client = startSayClient(bridge.path);
  try {
    await client.init();
    const args = { conversation: 'user:222', source_ref: ref, text: '我先写个小游戏' };
    assert.equal((await client.call('qq_say', args)).isError, false);
    const count = onebot.calls.length, speech = bridge.getState('qq-bridge:speech:user:222');
    assert.match((await client.call('qq_say', args)).text, /幂等重放/);
    assert.equal(onebot.calls.length, count);
    assert.equal(bridge.getState('qq-bridge:speech:user:222'), speech);
  } finally { client.kill(); bridge.db.close(); }
});

await test('workspace source binding rejects missing, expired, revoked and other conversation refs', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge);
  const ref = ledger.origin('group:111', { qq: '222', messageId: 'a', text: '写小游戏' });
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  const client = startSayClient(bridge.path, 'send_file');
  try {
    await client.init();
    for (const args of [{ conversation: 'group:111' }, { conversation: 'group:222', source_ref: ref }]) {
      const result = await client.call('qq_workspace', { action: 'write', path: 'game.html', content: 'x', ...args });
      assert.equal(result.isError, true, result.text);
    }
    bridge.db.prepare('UPDATE memory_origins SET expires_at=0 WHERE ref=?').run(ref);
    assert.equal((await client.call('qq_workspace', { conversation: 'group:111', source_ref: ref, action: 'list' })).isError, true);
    bridge.db.prepare('UPDATE memory_origins SET expires_at=?, withdrawn=1 WHERE ref=?').run(Date.now() + 600000, ref);
    assert.equal((await client.call('qq_workspace', { conversation: 'group:111', source_ref: ref, action: 'list' })).isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('write game and ZIP then upload group/private files with receipts, self history and replay', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge);
  const refs = Object.fromEntries(['group:111', 'user:222'].map((key) => [key,
    ledger.origin(key, { qq: '222', messageId: key, text: '写小游戏' })]));
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  bridge.setState('qq-bridge:episodic-memory', 'true');
  const client = startSayClient(bridge.path, 'send_file,send_text');
  try {
    await client.init();
    for (const conversation of Object.keys(refs)) {
      const args = { conversation, source_ref: refs[conversation], path: 'game/index.html' };
      const content = '<!doctype html><title>小游戏</title>';
      const progress = await client.call('qq_say', { conversation, source_ref: args.source_ref, text: '我来写个小游戏' });
      assert.equal(progress.isError, false, progress.text);
      assert.equal((await client.call('qq_workspace', { ...args, action: 'write', content })).isError, false);
      assert.equal(JSON.parse((await client.call('qq_workspace', { ...args, action: 'read' })).text), content);
      assert.equal((await client.call('qq_workspace', { ...args, action: 'pack', path: 'game', output: 'game.zip' })).isError, false);
      const before = onebot.calls.length;
      const sent = await client.call('qq_send_file', { ...args, path: 'game.zip' });
      assert.equal(sent.isError, false, sent.text);
      assert.equal(sent.raw.structuredContent.receipt.status, 'SUCCEEDED');
      const call = onebot.calls.at(-1);
      assert.equal(call.action, conversation.startsWith('group:') ? 'upload_group_file' : 'upload_private_file');
      assert.equal(call.params.name, 'game.zip');
      assert.equal(fs.readFileSync(call.params.file).readUInt32LE(), 0x04034b50);
      const at = bridge.getState('qq-bridge:speech:' + conversation);
      const replay = await client.call('qq_send_file', { ...args, path: 'game.zip' });
      assert.match(replay.text, /幂等重放/);
      assert.equal(onebot.calls.length, before + 1);
      assert.equal(bridge.getState('qq-bridge:speech:' + conversation), at);
      assert.ok(bridge.readEvents(conversation, { latest: true }).messages.some((m) => m.kind === 'self_message' && m.payload.text === '[文件 game.zip]'));
    }
    const bypass = await client.call('qq_send_group_msg', { group_id: 111, message: [{ type: 'file', data: { file: 'C:/secret' } }] });
    assert.equal(bypass.isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('file failure and UNKNOWN never refresh speech; unknown blocks resend', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', text: '小游戏' });
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  const client = startSayClient(bridge.path, 'send_file,send_text');
  const args = { conversation: 'group:111', source_ref: ref, path: 'game.html' };
  try {
    await client.init();
    assert.equal((await client.call('qq_say', { ...args, text: '我先写一下' })).isError, false);
    const speechBefore = bridge.getState('qq-bridge:speech:group:111');
    const selfBefore = bridge.readEvents('group:111', { latest: true }).messages.length;
    await client.call('qq_workspace', { ...args, action: 'write', content: 'test' });
    const unknown = await client.call('qq_send_file', { ...args, name: 'unknown.html' });
    assert.equal(unknown.isError, true); assert.match(unknown.text, /UNKNOWN/);
    const count = onebot.calls.length;
    assert.match((await client.call('qq_send_file', { ...args, name: 'unknown.html' })).text, /未知/);
    assert.equal(onebot.calls.length, count);
    assert.equal((await client.call('qq_send_file', { ...args, name: 'failed.html' })).isError, true);
    assert.equal(bridge.getState('qq-bridge:speech:group:111'), speechBefore);
    assert.equal(bridge.readEvents('group:111', { latest: true }).messages.length, selfBefore);
  } finally { client.kill(); bridge.db.close(); }
});

await test('file capability, allowlist, traversal, quota and dry-run reject unsafe dispatch', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', text: '小游戏' });
  const root = path.join(dir, 'workspace'); bridge.setState('qq-bridge:workspace-root', root);
  const args = { conversation: 'group:111', source_ref: ref, path: 'game.html' };
  const start = async (caps, env = {}) => { const c = startSayClient(bridge.path, caps, env); await c.init(); return c; };
  let client = await start('send_text');
  try {
    assert.equal((await client.call('qq_say', { ...args, text: '我来写文件' })).isError, false);
    await client.call('qq_workspace', { ...args, action: 'write', content: 'x' });
    assert.equal((await client.call('qq_send_file', args)).isError, true);
    client.kill(); client = await start('send_file', { QQ_ALLOW_GROUPS: '999' });
    assert.equal((await client.call('qq_send_file', args)).isError, true);
    client.kill(); client = await start('send_file', { QQ_DRY_RUN: '1' });
    const count = onebot.calls.length;
    assert.match((await client.call('qq_send_file', args)).text, /dry-run/);
    await client.call('qq_workspace', { ...args, action: 'write', path: 'dry.html', content: 'no' });
    assert.equal(fs.existsSync(path.join(root, 'group-111', 'dry.html')), false);
    assert.equal(onebot.calls.length, count);
    client.kill(); client = await start('send_file', { QQ_QUOTA_SEND_PER_MINUTE: '2' });
    assert.equal((await client.call('qq_send_file', { ...args, path: '../secret' })).isError, true);
    assert.equal((await client.call('qq_send_file', args)).isError, false);
    assert.equal((await client.call('qq_send_file', { ...args, name: 'second.html' })).isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('桥接连接启动失败后可原进程恢复，错误区分数据库不可用与来源无效', async () => {
  const dir = tmpDir(), blocker = path.join(dir, 'blocked-parent');
  fs.writeFileSync(blocker, '暂时不可用');
  const file = path.join(blocker, 'bridge.sqlite3');
  const client = startSayClient(file, 'send_text,send_file', { QQ_STATE_DIR: path.join(dir, 'mcp-state') });
  let bridge;
  try {
    await client.init();
    const before = onebot.calls.length;
    const unavailable = await client.call('qq_say', {
      conversation: 'group:111', source_ref: 'some-source', text: '不能发送',
    });
    assert.equal(unavailable.isError, true);
    assert.match(unavailable.text, /归属校验数据库暂不可用/);
    assert.equal(onebot.calls.length, before);
    const status = await client.call('qq_status');
    assert.match(status.text, /归属校验：不可用/);
    assert.match(status.text, /连接错误：/);
    fs.unlinkSync(blocker);
    fs.mkdirSync(blocker);
    bridge = new Store(file);
    const ledger = new EpisodeLedger(bridge);
    const ref = ledger.origin('group:111', { qq: '222', text: '修复连接后写文件' });
    bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
    const args = { conversation: 'group:111', source_ref: ref, path: 'game.html' };
    const sent = await client.call('qq_say', { ...args, text: '现在开始写' });
    assert.equal(sent.isError, false, sent.text);
    assert.ok(bridge.getState('qq-bridge:file-progress:' + ref),
      JSON.stringify(sent.raw) + '\n' + client.stderrText());
    const written = await client.call('qq_workspace', { ...args, action: 'write', content: 'OK' });
    assert.equal(written.isError, false, written.text);
    assert.equal(JSON.parse((await client.call('qq_workspace', { ...args, action: 'read' })).text), 'OK');
    assert.equal((await client.call('qq_send_file', args)).isError, false);
    assert.match((await client.call('qq_status')).text, /归属校验：可用/);
    const count = onebot.calls.length;
    const invalid = await client.call('qq_say', { ...args, source_ref: 'unknown', text: '不能发送' });
    assert.match(invalid.text, /本轮归属已失效/);
    assert.equal(onebot.calls.length, count);
  } finally { client.kill(); bridge?.db?.close(); }
});

await test('共享 SQLite 短暂启动写锁会等待，释放后归属校验可用', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', text: '查看文件' });
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  bridge.db.exec('DROP TABLE usage'); // Force the startup schema migration to need a write lock.
  bridge.db.exec('BEGIN IMMEDIATE');
  const client = startSayClient(bridge.path);
  const release = setTimeout(() => bridge.db.exec('COMMIT'), 300);
  try {
    await client.init();
    assert.doesNotMatch(client.stderrText(), /桥接数据库打不开/);
    const result = await client.call('qq_workspace', { conversation: 'group:111', source_ref: ref, action: 'list' });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(JSON.parse(result.text), []);
  } finally {
    clearTimeout(release);
    try { bridge.db.exec('ROLLBACK'); } catch {}
    client.kill(); bridge.db.close();
  }
});

await test('共享 SQLite 启动锁超过等待上限后，释放锁无需重启即可重新连接', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ref = new EpisodeLedger(bridge).origin('group:111', { qq: '222', text: '查看文件' });
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  bridge.db.exec('DROP TABLE usage');
  bridge.db.exec('BEGIN IMMEDIATE');
  const client = startSayClient(bridge.path);
  try {
    await client.init();
    assert.match(client.stderrText(), /桥接数据库打不开.*locked/);
    bridge.db.exec('COMMIT');
    const result = await client.call('qq_workspace', { conversation: 'group:111', source_ref: ref, action: 'list' });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(JSON.parse(result.text), []);
    assert.match((await client.call('qq_status')).text, /归属校验：可用/);
  } finally {
    try { bridge.db.exec('ROLLBACK'); } catch {}
    client.kill(); bridge.db.close();
  }
});

await test('普通插话也可使用当前会话工作区中的文件', async () => {
  const dir=tmpDir(),bridge=new Store(path.join(dir,'bridge.sqlite3')),conversation='group:111';
  bridge.setState('qq-bridge:workspace-root',path.join(dir,'workspace'));
  const event={self_id:100,message_id:'34',user_id:222,message_type:'group',group_id:111,message:[{type:'text',data:{text:'34'}}]};
  const router=new TaskRouting(bridge),e=router.admit(conversation,event,{action:'new',confidence:1,evidenceIds:['34']});
  const ref=new EpisodeLedger(bridge).origin(conversation,{qq:'222',messageId:'34',text:'34'});
  publishExecutionSource(bridge,ref,{conversation,taskId:e.task_id,executionId:e.id,taskVersion:e.data.taskVersion,
    sessionId:'test-session',workspaceScope:conversation+'/'+e.task_id,authority:e.data.authority,expiresAt:Date.now()+60000});
  const client=startSayClient(bridge.path,'send_text,send_file');
  try {
    await client.init();const args={conversation,source_ref:ref};
    assert.equal((await client.call('qq_say',{...args,text:'准备处理'})).isError,false);
    const before=onebot.calls.length;
    for(const [name,extra] of [['qq_workspace',{action:'write',path:'copy.docx',content:'duplicate'}],
      ['qq_workspace',{action:'pack',output:'copy.zip'}],['qq_send_file',{path:'copy.docx'}]]) {
      const result=await client.call(name,{...args,...extra});assert.equal(result.isError,false,result.text);
    }
    assert.equal(onebot.calls.length,before + 1);
    const base=path.join(dir,'workspace','group-111');
    assert.equal(fs.readFileSync(path.join(base,'copy.docx'),'utf8'),'duplicate');
    assert.equal(fs.existsSync(path.join(base,'tasks',e.task_id,'copy.docx')),false,'old source workspaceScope cannot restore task isolation');
    const next=new EpisodeLedger(bridge).origin(conversation,{qq:'333',text:'把刚才的发来'});
    assert.equal(JSON.parse((await client.call('qq_workspace',{conversation,source_ref:next,action:'read',path:'copy.docx'})).text),'duplicate');
    for(const other of ['group:222','user:111']) {
      const otherRef=new EpisodeLedger(bridge).origin(other,{qq:'333',text:'查看文件'});
      assert.equal((await client.call('qq_workspace',{conversation:other,source_ref:otherRef,action:'read',path:'copy.docx'})).isError,true);
      assert.equal((await client.call('qq_workspace',{conversation,source_ref:otherRef,action:'read',path:'copy.docx'})).isError,true);
    }
    assert.deepEqual(JSON.parse((await client.call('qq_workspace',{...args,action:'list'})).text).map((f)=>f.path),['copy.docx','copy.zip']);
  } finally {client.kill();bridge.db.close();}
});

await test('新回合可用新来源修改同会话旧文件，旧来源过期不影响文件归属', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge), conversation = 'group:111';
  bridge.setState('qq-bridge:workspace-root', path.join(dir, 'workspace'));
  const oldRef = ledger.origin(conversation, { qq: '222', messageId: 'old', text: '写CS2D' });
  let client = startSayClient(bridge.path, 'send_text,send_file');
  try {
    await client.init();
    const old = { conversation, source_ref: oldRef, path: 'cs2d.html' };
    assert.equal((await client.call('qq_say', { ...old, text: '我先写个游戏' })).isError, false);
    assert.equal((await client.call('qq_workspace', { ...old, action: 'write', content: 'version1' })).isError, false);
    bridge.db.prepare('UPDATE memory_origins SET expires_at=0 WHERE ref=?').run(oldRef);
    const newRef = ledger.origin(conversation, { qq: '333', messageId: 'new', text: '优化旧游戏' });
    client.kill();
    client = startSayClient(bridge.path, 'send_text,send_file');
    await client.init();
    const current = { conversation, source_ref: newRef, path: 'cs2d.html' };
    assert.equal(JSON.parse((await client.call('qq_workspace', { ...current, action: 'read' })).text), 'version1');
    assert.equal((await client.call('qq_say', { ...current, text: '我去优化旧游戏' })).isError, false);
    const written = await client.call('qq_workspace', { ...current, action: 'write', content: 'version2' });
    assert.equal(written.isError, false, written.text);
    assert.equal(JSON.parse((await client.call('qq_workspace', { ...current, action: 'read' })).text), 'version2');
    assert.equal((await client.call('qq_send_file', current)).isError, false);
    const otherRef = ledger.origin('group:999', { qq: '333', text: '另一群' });
    const wrong = await client.call('qq_workspace', { ...current, source_ref: otherRef, action: 'read' });
    assert.equal(wrong.isError, true);
  } finally { client.kill(); bridge.db.close(); }
});

await test('取消或撤回仍拦截工作区写入与打包，不依赖开工回执', async () => {
  const dir=tmpDir(),bridge=new Store(path.join(dir,'bridge.sqlite3')),conversation='group:111';
  bridge.setState('qq-bridge:workspace-root',path.join(dir,'workspace'));
  const ref=new EpisodeLedger(bridge).origin(conversation,{qq:'222',messageId:'1',text:'写文件'});
  publishFloorSource(bridge,ref,conversation,{version:1,authors:['222'],messageIds:['1'],task:false});
  const client=startSayClient(bridge.path,'send_file');
  try {
    await client.init(); const args={conversation,source_ref:ref};
    assert.equal((await client.call('qq_workspace',{...args,action:'write',path:'a.txt',content:'original'})).isError,false);
    for(const floor of [{version:2,messages:[{version:2,qq:'222',text:'不用了'}]}, {version:2,messages:[],recalled:['1']}]) {
      bridge.setState('qq-bridge:floor:'+conversation,JSON.stringify(floor));
      assert.equal((await client.call('qq_workspace',{...args,action:'write',path:'a.txt',content:'changed'})).isError,true);
      assert.equal((await client.call('qq_workspace',{...args,action:'pack',output:'a.zip'})).isError,true);
      assert.equal(JSON.parse((await client.call('qq_workspace',{...args,action:'read',path:'a.txt'})).text),'original');
      const sent=await client.call('qq_send_file',{...args,path:'a.txt'});
      assert.equal(sent.raw.structuredContent.receipt.status,'SKIPPED');
    }
  } finally {client.kill();bridge.db.close();}
});

await test('MCP sends obey shared floor when a turn source is bound; replay preserves successful receipts', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const ledger = new EpisodeLedger(bridge), ref = ledger.origin('group:111', { qq: '222', text: '画狗' });
  const policy = { version: 1, authors: ['222'], direct: true, originals: [], messageIds: ['1'] };
  publishFloorSource(bridge, ref, 'group:111', policy);
  bridge.setState('bridge:active-conversation', JSON.stringify({ key: 'group:111', sourceRef: ref, at: Date.now() }));
  bridge.setState('qq-bridge:floor:group:111', JSON.stringify({ version: 1, messages: [] }));
  const client = startSayClient(bridge.path, 'send_text,send_sticker,read_favorites');
  try {
    await client.init();
    // 没有本轮归属的手动发送不参与发言时机复核（floor 只约束回合内的工具发言）。
    const manual = await client.call('qq_send_group_msg', { group_id: 111, message: '手动发送' });
    assert.equal(manual.isError, false, manual.text);
    const sent = await client.call('qq_send_group_msg', { group_id: 111, source_ref: ref, message: '已确认', idem_key: 'floor-replay' });
    assert.equal(sent.isError, false, sent.text);
    bridge.setState('qq-bridge:floor:group:111', JSON.stringify({ version: 2,
      messages: [{ version: 2, qq: '222', text: '不用了', otherTarget: false }] }));
    const before = onebot.calls.length, speech = bridge.getState('qq-bridge:speech:group:111');
    const replay = await client.call('qq_send_group_msg', { group_id: 111, source_ref: ref, message: '已确认', idem_key: 'floor-replay' });
    assert.match(replay.text, /幂等重放/);
    for (const [name, args] of [
      ['qq_say', { conversation: 'group:111', text: '过时进度' }],
      ['qq_send_custom_face', { group_id: 111, index: 1 }],
    ]) {
      const result = await client.call(name, { ...args, source_ref: ref });
      assert.match(result.text, /发言已过时/);
      assert.equal(result.raw.structuredContent.receipt.status, 'SKIPPED');
    }
    assert.equal(onebot.calls.filter((c) => c.action === 'send_group_msg').length,
      onebot.calls.slice(0, before).filter((c) => c.action === 'send_group_msg').length);
    assert.equal(bridge.getState('qq-bridge:speech:group:111'), speech);
  } finally { client.kill(); bridge.db.close(); }
});

// ---------------------------------------------------------------- 跨会话发言

await test('跨会话开关：默认拒绝跨群，打开后按目标会话放行且幂等键不串', async () => {
  const dir = tmpDir(), { file } = makeSayDb(dir, { key: 'group:111', at: Date.now() });
  const store = new Store(file), ledger = new EpisodeLedger(store);
  const ref = ledger.origin('user:111', { qq: '111', who: '甲', messageId: '1', text: '去那个群说一声' });
  let client = startSayClient(file);
  try {
    await client.init();
    const cross = { conversation: 'group:222', source_ref: ref, text: '我来了' };
    // 默认关：跨群必须被拒，且不能真的发出去。
    const before = onebot.calls.length;
    const denied = await client.call('qq_say', cross);
    assert.equal(denied.isError, true, denied.text);
    assert.match(denied.text, /会话对不上/);
    assert.equal(onebot.calls.length, before, '拒绝时不得产生真实发送');
  } finally { client.kill(); }

  // 打开开关后：跨群放行，且发送目标确实是那个群。
  store.setState('qq-bridge:allow-cross-conversation', 'true');
  client = startSayClient(file);
  try {
    await client.init();
    const list = await client.listTools();
    const say = list.find((t) => t.name === 'qq_say');
    assert.match(say.description, /允许跨会话发言/, '打开后工具描述必须告诉模型可以跨群');

    const before = onebot.calls.length;
    const sent = await client.call('qq_say', { conversation: 'group:222', source_ref: ref, text: '我来了' });
    assert.equal(sent.isError, false, sent.text);
    assert.equal(onebot.calls.length, before + 1);
    assert.equal(onebot.calls.at(-1).params.group_id, 222);

    // 同一轮对两个不同的群说同样的话：幂等键含会话，第二句不能被当成重放吞掉。
    const other = await client.call('qq_say', { conversation: 'group:333', source_ref: ref, text: '我来了' });
    assert.equal(other.isError, false, other.text);
    assert.equal(onebot.calls.at(-1).params.group_id, 333);

    // 不填 conversation 时仍默认发往本轮会话。
    const dflt = await client.call('qq_say', { conversation: 'user:111', source_ref: ref, text: '回来了' });
    assert.equal(dflt.isError, false, dflt.text);

    // 非法目标格式仍被拒。
    const bad = await client.call('qq_say', { conversation: 'group:abc', source_ref: ref, text: 'x' });
    assert.equal(bad.isError, true);
  } finally { client.kill(); store.db.close(); }
});

console.log('\nQQ 内置 AI 语音: 固定音色 / 发送 / 能力位 / 幂等');

await test('不向模型暴露音色接口：没有列表工具，也没有 character 参数', async () => {
  const dir = tmpDir();
  const client = startMcp({
    ONEBOT_HTTP: `http://127.0.0.1:${onebot.port}`,
    QQ_STATE_DIR: dir,
    QQ_TOOLSET: 'chat',
    QQ_CAPABILITIES: 'send_sticker',
  });
  try {
    await client.init();
    const tools = await client.listTools();
    assert.equal(tools.some((t) => t.name === 'qq_list_ai_voices'), false, '音色列表不应开放给模型');
    const voice = tools.find((t) => t.name === 'qq_send_ai_voice');
    assert.ok(voice, '发送工具要在');
    assert.equal('character' in (voice.inputSchema.properties ?? {}), false, '模型不能指定音色');
    assert.match(voice.description, /傲娇少女/, '工具描述要说清音色固定');
    // 列音色是旧行为，现在发送前不该再查一次
    assert.equal(onebot.calls.some((c) => c.action === 'get_ai_characters'), false);
  } finally { client.kill(); }
});

await test('qq_send_ai_voice 固定用傲娇少女，记账语音并刷新唤醒窗口', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  bridge.setState('qq-bridge:episodic-memory', 'true');
  const client = startSayClient(bridge.path, 'send_sticker');
  try {
    await client.init();
    const before = onebot.calls.length;
    const sent = await client.call('qq_send_ai_voice', {
      group_id: 111, text: '今天风好大', idem_key: 'voice-1',
    });
    assert.equal(sent.isError, false, sent.text);
    assert.equal(sent.raw.structuredContent.receipt.status, 'SUCCEEDED');
    assert.equal(onebot.calls.length, before + 1);
    const call = onebot.calls.at(-1);
    assert.equal(call.action, 'send_group_ai_record');
    assert.deepEqual({ ...call.params },
      { group_id: 111, character: 'lucy-voice-f38', text: '今天风好大', chat_type: 1 });
    assert.match(sent.text, /傲娇少女/);
    assert.ok(bridge.getState('qq-bridge:speech:group:111'), '成功发送必须刷新唤醒窗口');
    assert.ok(
      bridge.readEvents('group:111', { latest: true }).messages.some(
        (m) => m.kind === 'self_message' && m.payload.text === '[语音：今天风好大]'),
      '历史里要记成 [语音：…]，不能只剩一个占位',
    );

    const replay = await client.call('qq_send_ai_voice', {
      group_id: 111, text: '今天风好大', idem_key: 'voice-1',
    });
    assert.match(replay.text, /幂等重放/);
    assert.equal(onebot.calls.length, before + 1);
  } finally { client.kill(); bridge.db.close(); }
});

await test('语音能力位、固定音色的兜底与文本上限', async () => {
  const dir = tmpDir();
  const denied = startSayClient(path.join(dir, 'denied.sqlite3'), 'read_group_info');
  try {
    await denied.init();
    const res = await denied.call('qq_send_ai_voice', { group_id: 111, text: '喂' });
    assert.equal(res.isError, true);
    assert.match(res.text, /send_voice/);
  } finally { denied.kill(); }

  const client = startSayClient(path.join(dir, 'ok.sqlite3'), 'send_voice');
  try {
    await client.init();
    // 就算模型硬塞 character（绕过 schema），也只能用固定音色。
    const forced = await client.call('qq_send_ai_voice', { group_id: 111, text: '喂', character: '1002' });
    assert.equal(forced.isError, false, forced.text);
    assert.equal(onebot.calls.at(-1).params.character, 'lucy-voice-f38');

    // 超长文本直接拒绝，且不得产生任何发送
    const before = onebot.calls.length;
    const long = await client.call('qq_send_ai_voice', { group_id: 111, text: '啊'.repeat(201) });
    assert.equal(long.isError, true);
    assert.match(long.text, /超过上限/);
    assert.equal(onebot.calls.length, before);
  } finally { client.kill(); }
});

await test('AI 语音结果未知时记 UNKNOWN：不刷新窗口、不许自动重发', async () => {
  const dir = tmpDir(), bridge = new Store(path.join(dir, 'bridge.sqlite3'));
  const client = startSayClient(bridge.path, 'send_sticker');
  try {
    await client.init();
    const unknown = await client.call('qq_send_ai_voice', {
      group_id: 111, text: '语音未知', idem_key: 'voice-unknown',
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知/);
    assert.equal(bridge.getState('qq-bridge:speech:group:111'), null);

    const count = onebot.calls.length;
    const again = await client.call('qq_send_ai_voice', {
      group_id: 111, text: '语音未知', idem_key: 'voice-unknown',
    });
    assert.match(again.text, /未知/);
    assert.equal(onebot.calls.length, count, 'UNKNOWN 之后不得自动重发');
  } finally { client.kill(); bridge.db.close(); }
});

onebot.server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}

// 兜底：即使有子进程句柄没释放，也不要挂在那里。
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
