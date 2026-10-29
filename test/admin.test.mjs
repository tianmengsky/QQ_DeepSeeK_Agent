import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Config } from '../lib/index.js';
import { createAdminConversation } from '../lib/admin/conversation.mjs';
import { createAdminMemory } from '../lib/admin/memory.mjs';
import { createAdminSettings } from '../lib/admin/settings.mjs';
import { ENTRIES, coerce, BY_KEY } from '../lib/admin/spec.mjs';
import { createAdminTexts } from '../lib/admin/texts.mjs';
import { createAdmin, createAdminHandler } from '../lib/routes/admin.mjs';
import { Store } from '../lib/store.mjs';

let passed = 0;
const NOW = Date.UTC(2026, 9, 28, 0, 30, 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-admin-'));

function fakeRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  return {
    method,
    url,
    headers,
    complete: true,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(body);
    },
  };
}

function fakeResponse() {
  const response = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { response.headers[key.toLowerCase()] = value; },
    writeHead(code, headers) {
      response.statusCode = code;
      response.headersSent = true;
      for (const [key, value] of Object.entries(headers ?? {})) {
        response.headers[key.toLowerCase()] = value;
      }
    },
    end(chunk) { if (chunk) response.body += String(chunk); },
  };
  return response;
}

// —— 清单：每种 kind 的边界都要挡住 ——
assert.equal(coerce(BY_KEY.get('windowTurns'), 12).ok, true);
assert.equal(coerce(BY_KEY.get('windowTurns'), 0).ok, false, '小于下限要拒');
assert.equal(coerce(BY_KEY.get('windowTurns'), 61).ok, false, '大于上限要拒');
assert.equal(coerce(BY_KEY.get('windowTurns'), 12.5).ok, false, '整数项不收小数');
assert.equal(coerce(BY_KEY.get('windowTurns'), 'abc').ok, false);
assert.equal(coerce(BY_KEY.get('windowTurns'), '12').value, 12, '字符串数字要能收');
assert.equal(coerce(BY_KEY.get('heartbeatEnabled'), 'true').value, true);
assert.equal(coerce(BY_KEY.get('heartbeatEnabled'), 1).ok, false, 'bool 不收 1');
assert.equal(coerce(BY_KEY.get('inTurnInjectionMode'), 'nope').ok, false);
assert.equal(coerce(BY_KEY.get('inTurnInjectionMode'), 'all').value, 'all');
assert.equal(coerce(BY_KEY.get('auxReasoningEffort'), '').ok, true, '空串是合法枚举值');
assert.equal(coerce(BY_KEY.get('llmModel'), 'x'.repeat(200)).ok, false, '文本超长要拒');
assert.equal(coerce(BY_KEY.get('heartbeatCooldownMs'), 600000).value, 600000);
assert.equal(coerce(undefined, 1).ok, false, '没登记过的键一律拒');
const keys = ENTRIES.map((entry) => entry.key);
assert.equal(new Set(keys).size, keys.length, '清单里不能有重复键');
for (const entry of ENTRIES) {
  assert.ok(entry.label && entry.help, entry.key + ' 要有标签与说明');
  assert.ok(['layers', 'context', 'models', 'heartbeat'].includes(entry.group));
}
passed++;

// —— 覆盖层：改值 → 落盘 → 重启后仍然生效 ——
const dir = tmp();
const config = Config({ token: '' });
config.windowTurns = 10;
config.llmModel = 'baseline-model';
const clock = () => NOW;
const store = createAdminSettings(config, dir, clock).load();
assert.equal(config.windowTurns, 10, '没有覆盖文件时不动原值');
const applied = store.patch({ windowTurns: 15, llmModel: 'next-model' }, '测试');
assert.equal(applied.ok, true);
assert.deepEqual(applied.changed.sort(), ['llmModel', 'windowTurns']);
assert.equal(config.windowTurns, 15, 'patch 必须直接改到 live config 上');
assert.equal(config.llmModel, 'next-model');
const file = path.join(dir, 'panel-settings.json');
assert.ok(fs.existsSync(file), '改完要落盘');
const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(saved.values.windowTurns, 15);
assert.equal(saved.history.at(-1).note, '测试', '审计要记住备注');
passed++;

// 重新来一遍（模拟插件重载）：新 config 读同一份文件 → 覆盖值生效
const config2 = Config({ token: '' });
config2.windowTurns = 10;
const store2 = createAdminSettings(config2, dir, clock).load();
assert.equal(config2.windowTurns, 15, '重载后覆盖值要重新应用');
const snap = store2.snapshot();
const row = snap.entries.find((entry) => entry.key === 'windowTurns');
assert.equal(row.overridden, true);
assert.equal(row.baseline, 10, '基线是配置文件里的值，不是覆盖值');
assert.equal(row.value, 15);
assert.equal(store2.snapshot().frozen, false);
passed++;

// —— 恢复默认 ——
const reset = store2.reset(['windowTurns']);
assert.deepEqual(reset.changed, ['windowTurns']);
assert.equal(config2.windowTurns, 10, '恢复默认要回到基线');
assert.equal(store2.snapshot().entries.find((entry) => entry.key === 'windowTurns').overridden, false);
assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).values.windowTurns, undefined);
passed++;

// —— 整批校验：有一个不合法就整批不落地 ——
const before = config2.llmModel;
const partial = store2.patch({ llmModel: 'ok-model', windowTurns: 999 });
assert.equal(partial.ok, false);
assert.equal(config2.llmModel, before, '整批拒绝时连合法的那个也不能改');
assert.match(partial.rejected[0].error, /不能大于/);
const unknown = store2.patch({ nope: 1 });
assert.equal(unknown.ok, false);
assert.match(unknown.rejected[0].error, /不在可改清单/);
assert.equal(store2.patch(null).ok, false, 'patch 必须是对象');
passed++;

// —— config 只读时不炸，只是拒绝 ——
const frozenConfig = Object.freeze(Config({ token: '' }));
const frozenStore = createAdminSettings(frozenConfig, tmp(), clock).load();
const frozenResult = frozenStore.patch({ windowTurns: 20 });
assert.equal(frozenResult.ok, false, '冻结的 config 不能假装改成功了');
assert.equal(frozenStore.snapshot().frozen, true);
passed++;

// —— 人设文本：写前备份、可读回、拒绝未知名字 ——
const textDir = tmp();
const personaFile = path.join(textDir, 'persona.md');
fs.writeFileSync(personaFile, '# 旧人设\n', 'utf8');
const textConfig = Config({ token: '', personaFile });
const texts = createAdminTexts(textConfig, textDir, clock);
assert.equal(texts.list().length, 3);
assert.equal(texts.meta('persona').exists, true);
const read = texts.read('persona');
assert.match(read.text, /旧人设/);
const written = texts.write('persona', '# 新人设\n\n说人话。\n');
assert.equal(written.ok, true);
assert.ok(written.backup && fs.existsSync(written.backup), '写前必须留备份');
assert.match(fs.readFileSync(personaFile, 'utf8'), /新人设/);
assert.match(fs.readFileSync(written.backup, 'utf8'), /旧人设/, '备份里是旧内容');
assert.equal(texts.write('nope', 'x').ok, false);
assert.equal(texts.write('persona', 'x'.repeat(200_001)).ok, false, '超长正文要拒');
assert.equal(createAdminTexts(Config({ token: '', personaFile: '' }), textDir).write('persona', 'x').ok, false,
  '没配路径时要明确报错，而不是写到某个默认位置');
passed++;

// —— 记忆：只认目录内的 .md ——
const memDir = tmp();
fs.mkdirSync(path.join(memDir, 'groups'), { recursive: true });
fs.writeFileSync(path.join(memDir, 'diary.md'), '# 日记\n\n- 今天\n', 'utf8');
fs.writeFileSync(path.join(memDir, '1056612947.md'), '# 人物卡\n\n- 印象\n', 'utf8');
fs.writeFileSync(path.join(memDir, 'groups', '324089993.md'), '# 群记忆\n\n- 事\n', 'utf8');
fs.mkdirSync(path.join(memDir, '.facts'), { recursive: true });
fs.writeFileSync(path.join(memDir, '.facts', 'x.json'), '{}', 'utf8');
const memory = createAdminMemory(memDir, textDir, clock);
const listing = memory.list();
assert.deepEqual(listing.counts, { diary: 1, person: 1, group: 1 }, '点开头的目录不该被算进去');
assert.equal(listing.files[0].path, 'diary.md', '日记排最前');
assert.equal(listing.files[0].label, '日记', '列表用第一行标题，不用裸文件名');
const person = listing.files.find((file) => file.path === '1056612947.md');
assert.match(person.label, /人物卡/, '标题行去掉 # 前缀之后拿来显示');
assert.equal(listing.files.find((file) => file.path === 'groups/324089993.md').label, '群记忆');
assert.equal(memory.resolveSafe('../escape.md'), null, '不许出目录');
assert.equal(memory.resolveSafe(path.join(memDir, 'diary.md')), null, '不接受绝对路径');
assert.equal(memory.resolveSafe('notes.txt'), null, '只认 .md');
assert.equal(memory.resolveSafe('diary.md') !== null, true);
const memWrite = memory.write('diary.md', '- 今天\n- 加一条\n');
assert.equal(memWrite.ok, true);
assert.ok(fs.existsSync(memWrite.backup));
assert.match(fs.readFileSync(path.join(memDir, 'diary.md'), 'utf8'), /加一条/);
assert.equal(memory.write('../x.md', 'x').ok, false);
assert.equal(createAdminMemory(path.join(memDir, 'groups'), textDir).write('sub.md', 'x').ok, true,
  '子目录里的相对路径要能写');
passed++;

// —— 路由：鉴权、跨站、分发 ——
function rig(overrides = {}) {
  const routeDir = tmp();
  const routeConfig = Config({ token: '', ...overrides });
  const logs = [];
  const ctx = { logger: { info() {}, warn() {}, debug() {} } };
  const admin = createAdmin(routeConfig, routeDir, path.join(routeDir, 'memory'), clock);
  const handler = createAdminHandler(ctx, routeConfig, admin);
  return { routeConfig, admin, handler, routeDir, logs };
}

{
  const { handler, routeConfig, routeDir } = rig();
  const get = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings'), get);
  assert.equal(get.statusCode, 200);
  const payload = JSON.parse(get.body);
  assert.equal(payload.ok, true);
  assert.ok(payload.entries.length >= 20);
  assert.ok(Array.isArray(payload.groups));
  assert.equal(payload.frozen, false);

  const post = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:1' },
    body: JSON.stringify({ patch: { windowTurns: 14 }, note: '来自面板' }),
  }), post);
  assert.equal(post.statusCode, 200);
  assert.equal(routeConfig.windowTurns, 14, '接口改的值要落到 config');
  assert.ok(fs.existsSync(path.join(routeDir, 'panel-settings.json')));

  const crossed = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings', {
    method: 'POST',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:1' },
    body: JSON.stringify({ patch: { windowTurns: 3 } }),
  }), crossed);
  assert.equal(crossed.statusCode, 403, '跨站写要挡');
  assert.equal(routeConfig.windowTurns, 14, '挡掉之后不能有副作用');

  const noOrigin = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings/reset', {
    method: 'POST', headers: { host: '127.0.0.1:1' }, body: JSON.stringify({ keys: ['windowTurns'] }),
  }), noOrigin);
  assert.equal(noOrigin.statusCode, 200, '命令行（无 Origin）要放行');

  const bad = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings', {
    method: 'POST', headers: { host: '127.0.0.1:1' }, body: JSON.stringify({ patch: { windowTurns: 999 } }),
  }), bad);
  assert.equal(bad.statusCode, 400);

  const wrongMethod = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings', { method: 'PUT' }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const missing = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/nope'), missing);
  assert.equal(missing.statusCode, 404);
}

// token：配了就必须带
{
  const { handler } = rig({ token: 'admin-token' });
  const anon = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings'), anon);
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.headers['www-authenticate'], 'Bearer');
  assert.ok(!anon.body.includes('admin-token'), '错误响应里不能回显 token');
  const viaHeader = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/settings', {
    headers: { authorization: 'Bearer admin-token' },
  }), viaHeader);
  assert.equal(viaHeader.statusCode, 200);
  const viaQuery = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/memory?token=admin-token'), viaQuery);
  assert.equal(viaQuery.statusCode, 200, 'curl 用 ?token= 也要能读');
}

// 文本与记忆接口
{
  const routeDir = tmp();
  const personaFile = path.join(routeDir, 'persona.md');
  fs.writeFileSync(personaFile, '# 原样\n', 'utf8');
  const routeConfig = Config({ token: '', personaFile });
  const admin = createAdmin(routeConfig, routeDir, path.join(routeDir, 'memory'), clock);
  fs.mkdirSync(path.join(routeDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(routeDir, 'memory', 'diary.md'), '- 日记\n', 'utf8');
  const handler = createAdminHandler({ logger: { info() {}, warn() {} } }, routeConfig, admin);

  const list = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/texts'), list);
  assert.equal(JSON.parse(list.body).texts.length, 3);

  const readText = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/text?name=persona'), readText);
  assert.match(JSON.parse(readText.body).text, /原样/);

  const writeText = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/text', {
    method: 'POST', headers: { host: '1' }, body: JSON.stringify({ name: 'persona', text: '# 新版\n' }),
  }), writeText);
  assert.equal(writeText.statusCode, 200);
  assert.match(fs.readFileSync(personaFile, 'utf8'), /新版/);

  const oversize = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/text', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ name: 'persona', text: 'x'.repeat(200_001) }),
  }), oversize);
  assert.equal(oversize.statusCode, 400);

  const mem = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/memory'), mem);
  assert.equal(JSON.parse(mem.body).counts.diary, 1);

  const memRead = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/memory/file?path=diary.md'), memRead);
  assert.match(JSON.parse(memRead.body).text, /日记/);

  const traversal = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/memory/file?path=../secret.md'), traversal);
  assert.equal(traversal.statusCode, 404, '越界路径按"没有这个文件"回');

  const memWrite = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/memory/file', {
    method: 'POST', headers: { host: '1' }, body: JSON.stringify({ path: 'diary.md', text: '- 改过\n' }),
  }), memWrite);
  assert.equal(memWrite.statusCode, 200);
  assert.match(fs.readFileSync(path.join(routeDir, 'memory', 'diary.md'), 'utf8'), /改过/);
}
passed++;

// 处置动作：登记表、参数校验、幂等、审计、危险确认
{
  const actionDir = tmp();
  const actionConfig = Config({ token: '' });
  const store = new Store(path.join(actionDir, 'qq-bridge.sqlite3'));
  const admin = createAdmin(actionConfig, actionDir, path.join(actionDir, 'memory'), clock);
  const logs = [];
  const handler = createAdminHandler(
    { logger: { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) } },
    actionConfig,
    admin,
  );
  const resets = [];
  const settled = [];
  admin.actions.bind({
    store,
    sendQueue: { stats: () => ({ items: 2, inFlightMs: 0 }), flush: async () => true },
    registry: {
      entry: (key) => (key === 'group:1' ? {} : null),
      reset: (key) => resets.push(key),
    },
    taskRouting: {
      execution: (id) => (id === 'ex-1' ? { id } : null),
      setExecution: (id, state) => settled.push([id, state]),
    },
    pokeHeartbeat: (key) => (key === 'group:1' ? { ok: true, pending: 3 } : { ok: false, error: '没有这个会话' }),
  });

  const list = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/actions'), list);
  assert.equal(list.statusCode, 200);
  const catalog = JSON.parse(list.body);
  assert.ok(catalog.actions.length >= 6, '动作清单要够用');
  for (const entry of catalog.actions) {
    assert.ok(entry.id && entry.label && entry.help, entry.id + ' 要有 id/标签/说明');
    assert.ok(Array.isArray(entry.params));
  }

  // 造一条 UNKNOWN 回执，再让面板把它判成"确认已发出"
  store.db.prepare(
    `INSERT INTO outbox (idem_key,conversation,kind,target,payload,status,created_at,updated_at)
     VALUES ('k1','group:1','send','t','{}','UNKNOWN',?,?)`,
  ).run(NOW, NOW);
  assert.equal(store.getReceipt('k1').status, 'UNKNOWN');

  const mark = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST',
    headers: { host: '1' },
    body: JSON.stringify({ id: 'receipt.markSent', args: { idemKey: 'k1' }, idemKey: 'op-1' }),
  }), mark);
  assert.equal(mark.statusCode, 200);
  assert.equal(store.getReceipt('k1').status, 'SUCCEEDED', '处置要真的落到回执上');

  // 同一个 idemKey 再来一次：返回第一次的结果，不再改库
  store.db.prepare("UPDATE outbox SET status='UNKNOWN' WHERE idem_key='k1'").run();
  const replay = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST',
    headers: { host: '1' },
    body: JSON.stringify({ id: 'receipt.markSent', args: { idemKey: 'k1' }, idemKey: 'op-1' }),
  }), replay);
  assert.equal(JSON.parse(replay.body).replay, true, '同 idemKey 要幂等重放');
  assert.equal(store.getReceipt('k1').status, 'UNKNOWN', '重放不能再改一次库');

  const tooFast = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'queue.flush', args: { timeoutMs: 'abc' } }),
  }), tooFast);
  assert.equal(tooFast.statusCode, 400, '参数不合法要拒');

  const noConfirm = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'conversation.reset', args: { key: 'group:1' } }),
  }), noConfirm);
  assert.equal(noConfirm.statusCode, 400, '危险动作没确认要拒');
  assert.equal(resets.length, 0, '被拒的动作不能有副作用');

  const confirmed = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'conversation.reset', args: { key: 'group:1' }, confirm: true }),
  }), confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.deepEqual(resets, ['group:1']);

  const settle = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'task.settle', args: { id: 'ex-1' }, confirm: true }),
  }), settle);
  assert.equal(settle.statusCode, 200);
  assert.deepEqual(settled, [['ex-1', 'failed']], '结束执行要落到 failed，不能谎报完成');

  const missingTask = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'task.settle', args: { id: 'nope' }, confirm: true }),
  }), missingTask);
  assert.equal(missingTask.statusCode, 400, '不存在的执行要给错误，不能静默成功');

  const abandon = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' },
    body: JSON.stringify({ id: 'delivery.abandon', args: { id: 999 }, confirm: true }),
  }), abandon);
  assert.equal(abandon.statusCode, 400, '放弃一条不存在的投递要报错');

  const unknown = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action', {
    method: 'POST', headers: { host: '1' }, body: JSON.stringify({ id: 'nope' }),
  }), unknown);
  assert.equal(unknown.statusCode, 404);

  const wrongMethod = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/action'), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const auditFile = path.join(actionDir, 'panel-audit.jsonl');
  assert.ok(fs.existsSync(auditFile), '审计文件要落盘');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => line.action && line.at === NOW));
  assert.ok(lines.some((line) => line.action === 'receipt.markSent' && line.ok === true));
  assert.ok(
    lines.some((line) => line.action === 'delivery.abandon' && line.ok === false),
    '失败的动作也要记下来（不然"为什么没生效"永远查不到）',
  );
  store.db.close();
}
passed++;

// —— 会话详情：只读、不凭空造会话 ——
{
  const window = [
    { who: '他', qq: '1', text: 'x'.repeat(300), at: NOW - 2000, bot: false, turnIndex: 3, images: [1], forwards: [] },
    { who: '你', qq: '', text: '在', at: NOW - 1000, bot: true, turnIndex: 3, images: [], forwards: [] },
  ];
  const entry = {
    window,
    pending: [{ who: '路人', text: '有人在吗', at: NOW - 500 }],
    turns: 4,
    contextTurn: 7,
    sessionId: 'sess-1',
    awakeUntil: NOW + 60_000,
    lastMessageAt: NOW - 1000,
    lastSpokeAt: NOW - 900,
    turnsSinceSticker: 2,
    recentQqs: ['1', '2'],
  };
  const byKey = new Map([['group:1', entry]]);
  const asked = [];
  const fakeStore = {
    available: true,
    readEvents(conv) {
      asked.push(conv);
      // 只有这个会话有历史事件；别的键要回空，否则"found"会假阳。
      if (conv !== 'group:1') return { messages: [] };
      return {
        messages: [{
          id: 9, conversation: conv, kind: 'inbound',
          payload: { who: '他', text: 'hi' }, createdAt: NOW - 500,
          deliverable: true, acked: false,
        }],
      };
    },
  };
  const conversation = createAdminConversation({ registry: { byKey }, store: fakeStore, clock: () => NOW });

  assert.equal(conversation.detail('').ok, false, '没给会话要明确报错');
  const detail = conversation.detail('group:1');
  assert.equal(detail.ok, true);
  assert.equal(detail.found, true);
  assert.equal(detail.window.length, 2, '窗口按原顺序给');
  assert.equal(detail.window[0].bot, false);
  assert.equal(detail.window[1].bot, true, '自己说的话要标出来');
  assert.equal(detail.window[0].text.length, 241, '长消息要截断，但不能截成空');
  assert.ok(detail.window[0].text.endsWith('…'));
  assert.equal(detail.window[0].images, 1, '图片数量要带回去');
  assert.equal(detail.pending.length, 1);
  assert.equal(detail.awakeRemainingMs, 60_000);
  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].kind, 'inbound');
  assert.equal(detail.events[0].deliverable, true);
  assert.deepEqual(asked, ['group:1'], '要按会话去读事件流');

  // 看一眼不存在的会话，不能顺手在 registry 里造一个（那样会话表会凭空多一行）
  const ghost = conversation.detail('group:404');
  assert.equal(ghost.found, false);
  assert.equal(byKey.size, 1, '查一个不存在的会话不该往 byKey 里塞东西');
  assert.deepEqual(ghost.window, []);

  // 库坏了：把原因带回去，别假装"没有事件"
  const broken = createAdminConversation({
    registry: { byKey },
    store: { available: true, readEvents() { throw new Error('database disk image is malformed'); } },
    clock: () => NOW,
  }).detail('group:1');
  assert.equal(broken.ok, true);
  assert.match(broken.eventsError, /malformed/);
  assert.deepEqual(broken.events, []);

  // 没开持久化：窗口照样能看
  const memoryOnly = createAdminConversation({ registry: { byKey }, store: null, clock: () => NOW })
    .detail('group:1');
  assert.equal(memoryOnly.window.length, 2);
  assert.deepEqual(memoryOnly.events, []);
  assert.equal(memoryOnly.eventsError, null);
  passed++;
}

// 路由：/conversation 只读
{
  const routeDir = tmp();
  const routeConfig = Config({ token: '', path: '/qq/onebot', memoryEnabled: false });
  const admin = createAdmin(routeConfig, routeDir, path.join(routeDir, 'memory'), clock);
  const handler = createAdminHandler({ logger: { info() {}, warn() {} } }, routeConfig, admin);
  const ok = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/conversation?key=group:1'), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).key, 'group:1');
  const wrong = fakeResponse();
  await handler(fakeRequest('/qq/onebot/admin/conversation?key=group:1', { method: 'POST' }), wrong);
  assert.equal(wrong.statusCode, 405, '会话详情只读');
  try { fs.rmSync(routeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 临时目录 */ }
  passed++;
}

for (const scratch of [dir, textDir, memDir]) {
  try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 临时目录 */ }
}

console.log(`admin: ${passed} passed, 0 failed`);
