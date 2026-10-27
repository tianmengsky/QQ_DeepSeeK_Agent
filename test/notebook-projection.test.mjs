import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { config } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-projection-'));
const stores = [];
const fakeCtx = { logger: { info() {}, warn() {}, debug() {} } };
let passed = 0, failed = 0, n = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}
function setup() {
  const dir = path.join(root, String(n++));
  const store = new Store(path.join(dir, 'bridge.sqlite3'));
  stores.push(store);
  const memoryDir = path.join(dir, 'memory');
  const memory = new MemoryStore(fakeCtx, { ...config({ memoryEnabled: true }), memoryDir }, store);
  return { store, memory, memoryDir };
}
const src = (conversation = 'group:324089993', messageId = '1') =>
  [{ conversation, messageId, evidence: '原文', qq: '200', who: '甲', at: Date.now() }];
const put = (memory, subject, slot, text, extra = {}) =>
  memory.agent.write({ subject, slot, version: 0, kind: 'note', text, sources: src(), ...extra });

try {
  await test('群本投影：路径、条目、依据与"手改覆盖"提示', async () => {
    const { memory, memoryDir } = setup();
    put(memory, 'group:324089993', 'rhythm.close', '凌晨两点最热闹');
    memory.syncNotebook('group:324089993');
    const file = path.join(memoryDir, 'groups', '324089993.md');
    assert.equal(fs.existsSync(file), true);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^# 群 324089993 · 记事/m);
    assert.match(text, /凌晨两点最热闹/);
    assert.match(text, /rhythm\.close；v1/);
    assert.match(text, /依据 group:324089993 消息 1/);
    assert.match(text, /手改会被下一次同步覆盖/);
    assert.match(text, /共 1 条/);
  });

  await test('日记本投影：单独文件，并标出可公开条目', async () => {
    const { memory, memoryDir } = setup();
    put(memory, 'self', 'social.timing', '别在别人说忙时追问', { visibility: 'public' });
    put(memory, 'self', 'social.pace', '我在群里话太多', { visibility: 'private' });
    memory.syncNotebook('self');
    const text = fs.readFileSync(path.join(memoryDir, 'diary.md'), 'utf8');
    assert.match(text, /^# 日记/m);
    assert.match(text, /别在别人说忙时追问（social\.timing；v1；可公开）/);
    // 私下的那条不带"可公开"，否则人看不出哪条会进群。
    assert.match(text, /我在群里话太多（social\.pace；v1）/);
    assert.equal(/我在群里话太多（[^）]*可公开/.test(text), false);
    assert.match(text, /标了「可公开」的条目才会进群聊/);
  });

  await test('人物本走原文档：保留手工段落，不被群本逻辑覆盖', async () => {
    const { memory, memoryDir } = setup();
    put(memory, '200', 'profile.city', '在成都上班', { kind: 'profile' });
    memory.syncNotebook('200');
    const file = path.join(memoryDir, '200.md');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /## 主模型记忆/);
    assert.match(text, /在成都上班/);
    // 人物本原有的两个段落必须还在 —— 它们是人手维护的，不能被子系统重写。
    assert.match(text, /## 手工记忆/);
    assert.match(text, /## 早期/);
    assert.equal(fs.existsSync(path.join(memoryDir, 'groups')), false);
  });

  await test('全量重建：一次覆盖三本，文件被删后能自愈', async () => {
    const { memory, memoryDir } = setup();
    put(memory, '200', 'profile.city', '在成都');
    put(memory, 'group:324089993', 'rhythm.close', '夜里最热闹');
    put(memory, 'self', 'social.timing', '别追问');
    const n1 = memory.syncAllNotebooks();
    assert.equal(n1 >= 3, true);
    const groupFile = path.join(memoryDir, 'groups', '324089993.md');
    const diary = path.join(memoryDir, 'diary.md');
    assert.equal(fs.existsSync(groupFile) && fs.existsSync(diary), true);
    fs.rmSync(groupFile);
    fs.rmSync(diary);
    memory.syncAllNotebooks();
    assert.equal(fs.existsSync(groupFile) && fs.existsSync(diary), true);
  });

  await test('已删除的条目不出现在投影里', async () => {
    const { memory, memoryDir } = setup();
    put(memory, 'group:324089993', 'rhythm.close', '凌晨两点最热闹');
    memory.agent.write({ subject: 'group:324089993', slot: 'rhythm.close', version: 1, kind: 'note',
      text: '', deleted: true, sources: src() });
    memory.syncNotebook('group:324089993');
    const text = fs.readFileSync(path.join(memoryDir, 'groups', '324089993.md'), 'utf8');
    assert.equal(text.includes('凌晨两点最热闹'), false);
    assert.match(text, /共 0 条/);
  });
} finally {
  for (const store of stores) { try { store.db.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\nnotebook-projection: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
