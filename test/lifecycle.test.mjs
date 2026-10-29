import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../lib/index.js';
import { Store } from '../lib/store.mjs';
import { request, response } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-lifecycle-'));
try {
  const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url));
  const source = `const p = require(${JSON.stringify(entry)}); if (!p.Config || !p.apply || p.name !== 'qq-bridge' || !p.__test) process.exit(1);`;
  const child = spawnSync(process.execPath, ['-e', source], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr);
  console.log('  ✓ synchronous package loading works from another working directory');

  const graphSource = `const { pathToFileURL } = require('node:url');
    const { getOrInitializeCascadedLoader } = require('internal/modules/esm/loader');
    (async () => {
      const url = pathToFileURL(${JSON.stringify(entry)}).href;
      await import(url);
      const linked = await getOrInitializeCascadedLoader().loadCache.get(url).linked;
      if (!linked.some(job => job.url.endsWith('/bootstrap.mjs'))) process.exit(1);
    })().catch(error => { console.error(error); process.exit(1); });`;
  const graph = spawnSync(process.execPath, ['--expose-internals', '-e', graphSource], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(graph.status, 0, graph.stderr);
  console.log('  ✓ HMR can see the entry dependency graph through Node linked modules');

  const ctx = new Context();
  const routes = new Map();
  ctx.provide('webServer', {
    register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  });
  ctx.provide('sessionController', {
    create() {
      throw Error('unexpected agent call');
    },
  });
  const config = {
    stateDir: root,
    memoryEnabled: false,
    persistenceEnabled: true,
    heartbeatEnabled: false,
    agentEnabled: false,
  };
  for (let i = 0; i < 2; i++) {
    const fiber = ctx.plugin(plugin, config);
    await fiber;
    assert.deepEqual([...routes.keys()].sort(), [
      '/qq/onebot',
      '/qq/onebot/admin/action',
      '/qq/onebot/admin/actions',
  '/qq/onebot/admin/conversation',
      '/qq/onebot/admin/memory',
      '/qq/onebot/admin/memory/file',
      '/qq/onebot/admin/settings',
      '/qq/onebot/admin/settings/reset',
      '/qq/onebot/admin/text',
      '/qq/onebot/admin/texts',
      '/qq/onebot/control',
      '/qq/onebot/panel',
    ]);
    await fiber.dispose();
    assert.equal(routes.size, 0, 'unload must unregister routes');
    const store = new Store(path.join(root, 'qq-bridge.sqlite3'));
    assert.equal(store.available, true);
    store.db.close();
  }
  console.log('  ✓ actual Cordis load, dispose and reload release routes and database handles');

  let checks = 0;
  ctx.provide('llm', {
    async *stream() {
      checks++;
      yield { type: 'text-delta', text: '{"speak":false}' };
    },
  });
  const seed = (offset) => {
    const store = new Store(path.join(root, 'qq-bridge.sqlite3'));
    for (let i = 0; i < 6; i++) store.recordEvent({
      conversation: 'group:10', kind: 'group_message',
      dedupeKey: 'lifecycle:' + (offset + i), deliverable: true,
      payload: { qq: 200, who: '群友', text: '背景', messageId: offset + i },
    });
    store.db.close();
  };
  const untilChecked = async (count) => {
    const deadline = Date.now() + 2000;
    while (checks < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(checks, count);
  };
  const heartbeatConfig = { ...config, heartbeatEnabled: true, heartbeatMs: 600000,
    heartbeatCooldownMs: 0, heartbeatProvider: 'fake', heartbeatModel: 'fake' };
  seed(0);
  let fiber = ctx.plugin(plugin, heartbeatConfig);
  await fiber;
  assert.equal(checks, 0, 'disabled hosting must not infer');
  await routes.get('/qq/onebot/control')(request({ enabled: true }), response());
  await untilChecked(1);
  await fiber.dispose();
  seed(6);
  fiber = ctx.plugin(plugin, heartbeatConfig);
  await fiber;
  await untilChecked(2);
  await fiber.dispose();
  console.log('  ✓ reopened hosting and plugin reload judge six restored unread immediately');

  const seededStore = new Store(path.join(root, 'qq-bridge.sqlite3'));
  seededStore.setState('qq-bridge:conversation:group:10', JSON.stringify({
    sessionId: 'archived-session', turns: 8, staticDone: true,
    window: [{ qq: '200', who: '群友', text: '保留上下文', messageId: 'old-message' }],
  }));
  seededStore.db.close();
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['archived-session'] });
  let created = 0;
  ctx.sessionController.create = async () => {
    created++;
    return { sessionId: 'fresh-session' };
  };
  fiber = ctx.plugin(plugin, config);
  await fiber;
  const deadline = Date.now() + 2000;
  let saved;
  while (Date.now() < deadline) {
    const check = new Store(path.join(root, 'qq-bridge.sqlite3'));
    saved = JSON.parse(check.getState('qq-bridge:conversation:group:10'));
    check.db.close();
    if (saved.sessionId === 'fresh-session') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(created, 1);
  assert.equal(saved.sessionId, 'fresh-session');
  assert.equal(saved.staticDone, false);
  assert.equal(saved.window[0].text, '保留上下文');
  await fiber.dispose();
  await ctx.fiber.dispose();
  console.log('  ✓ plugin reload replaces archived bindings without submitting a model turn');
  console.log('5 passed, 0 failed');
} finally {
  // Windows 上库句柄没放干净时 rmSync 会 EPERM；别让清理异常盖掉真正的断言失败。
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    console.log('cleanup failed:', error.code, error.path);
  }
}
