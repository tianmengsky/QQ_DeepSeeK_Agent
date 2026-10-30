import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearEffortCache, supportedEfforts, planEffort, markEffortRejected, repairSessionEffort,
} from '../lib/agent/reasoning-effort.mjs';
import { ensureSession, sessionSignature, modelSignature as modelSignatureOf } from '../lib/conversation/sessions.mjs';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('   ok ' + name); }
  catch (e) { failed++; console.error('   FAIL ' + name, e); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-effort-test-'));

/** 造一个只有 llm 服务的 ctx；`efforts` 为 null 表示探测会抛错。 */
function fakeCtx(efforts, { throws = false, calls = { n: 0 } } = {}) {
  return {
    calls,
    logger: { info() {}, warn() {} },
    get(name) {
      if (name !== 'llm') return null;
      return {
        async resolveModelInfo() {
          calls.n += 1;
          if (throws) throw new Error('adapter down');
          return { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } };
        },
      };
    },
  };
}

function fakeRegistry(efforts, options = {}) {
  const selects = [];
  const ctx = fakeCtx(efforts, options);
  const entries = new Map();
  const registry = {
    config: {
      cwd: root, workspaceRoot: root, llmProvider: 'a6api', llmModel: 'm-1',
      llmReasoningEffort: options.effort ?? 'off', rotateEveryTurns: 0,
    },
    selects,
    ctx: {
      logger: ctx.logger,
      get: ctx.get,
      sessionController: {
        async create() { return { sessionId: 'session-1' }; },
        async selectModel(sel) { selects.push(sel); return { selected: sel }; },
      },
    },
    entry(key) { if (!entries.has(key)) entries.set(key, { turns: 0 }); return entries.get(key); },
    persist() {},
  };
  return registry;
}

await test('留空 = 什么都不发', async () => {
  const result = await planEffort(fakeCtx(['off']), { llmReasoningEffort: '', llmProvider: 'a6api', llmModel: 'm-1' });
  assert.equal(result.effort, undefined);
  assert.equal(result.note, null);
});

await test('适配器认 off 就真的发 off', async () => {
  clearEffortCache();
  const result = await planEffort(fakeCtx(['off', 'low']), {
    llmReasoningEffort: 'off', llmProvider: 'deepseek-official', llmModel: 'deepseek-flash',
  });
  assert.equal(result.effort, 'off');
  assert.equal(result.note, null);
});

await test('适配器不认这个档位就不发，并说明只认哪些', async () => {
  clearEffortCache();
  const result = await planEffort(fakeCtx(['low', 'high']), {
    llmReasoningEffort: 'off', llmProvider: 'a6api', llmModel: 'm-1',
  });
  assert.equal(result.effort, undefined);
  assert.equal(result.note.kind, 'unsupported');
  assert.deepEqual(result.note.supported, ['low', 'high']);
  assert.match(result.note.message, /不支持思考档位 "off"/);
});

await test('问不到适配器时宁可信用户：照发', async () => {
  clearEffortCache();
  const result = await planEffort(fakeCtx([], { throws: true }), {
    llmReasoningEffort: 'off', llmProvider: 'a6api', llmModel: 'm-1',
  });
  assert.equal(result.effort, 'off');
  assert.equal(result.note, null);
});

await test('没有 llm 服务也照发（不因为探测不了就悄悄丢掉配置）', async () => {
  const ctx = { logger: { info() {}, warn() {} }, get: () => null };
  const result = await planEffort(ctx, { llmReasoningEffort: 'max', llmProvider: 'x', llmModel: 'y' });
  assert.equal(result.effort, 'max');
});

await test('探测结果按 provider+model 缓存', async () => {
  clearEffortCache();
  const ctx = fakeCtx(['off']);
  await supportedEfforts(ctx, 'a6api', 'm-1');
  await supportedEfforts(ctx, 'a6api', 'm-1');
  await supportedEfforts(ctx, 'a6api', 'm-2');
  assert.equal(ctx.calls.n, 2);
});

await test('被拒过一次之后不再发同一个档位', async () => {
  clearEffortCache();
  const registry = {};
  const stats = {};
  const record = markEffortRejected(registry, stats, { message: 'UNSUPPORTED_REASONING_EFFORT: nope' }, {
    llmReasoningEffort: 'off', llmProvider: 'a6api', llmModel: 'm-1',
  });
  assert.equal(record.effort, 'off');
  assert.equal(registry.effortRejected.effort, 'off');
  assert.equal(stats.effortRejected.effort, 'off');
  const planned = await planEffort(fakeCtx(['off']), {
    llmReasoningEffort: 'off', llmProvider: 'a6api', llmModel: 'm-1',
  }, registry);
  assert.equal(planned.effort, undefined);
  assert.equal(planned.note.kind, 'rejected');
  // 换个档位不受影响
  const other = await planEffort(fakeCtx(['off', 'low']), {
    llmReasoningEffort: 'low', llmProvider: 'a6api', llmModel: 'm-1',
  }, registry);
  assert.equal(other.effort, 'low');
});

await test('退回不带档位的选择会真的发一次 selectModel', async () => {
  const registry = fakeRegistry(['low']);
  const entry = { sessionId: 'session-9' };
  assert.equal(await repairSessionEffort(registry, entry, registry.config), true);
  assert.equal(registry.selects.length, 1);
  assert.deepEqual(registry.selects[0], { sessionId: 'session-9', provider: 'a6api', model: 'm-1' });
  assert.equal('reasoningEffort' in registry.selects[0], false);
  assert.equal(await repairSessionEffort(registry, {}, registry.config), false);
});

await test('ensureSession：适配器认 off，selectModel 带上 reasoningEffort: off', async () => {
  clearEffortCache();
  const registry = fakeRegistry(['off', 'low']);
  await ensureSession(registry, 'group:1');
  assert.equal(registry.selects.length, 1);
  assert.equal(registry.selects[0].reasoningEffort, 'off');
  assert.equal(registry.effortNote ?? null, null);
});

await test('ensureSession：适配器不认 off，选择里不带它，但留下原因', async () => {
  clearEffortCache();
  const registry = fakeRegistry(['low']);
  await ensureSession(registry, 'group:2');
  assert.equal(registry.selects.length, 1);
  assert.equal('reasoningEffort' in registry.selects[0], false);
  assert.equal(registry.effortNote.kind, 'unsupported');
  assert.equal(registry.entry('group:2').effortNote.kind, 'unsupported');
});

await test('改档位不进提示词签名：不会把整段上下文换掉', () => {
  const base = { cwd: root, workspaceRoot: root, llmProvider: 'a6api', llmModel: 'm-1' };
  assert.equal(sessionSignature({ ...base, llmReasoningEffort: 'off' }),
    sessionSignature({ ...base, llmReasoningEffort: '' }));
  assert.equal(sessionSignature({ ...base, llmReasoningEffort: 'low' }),
    sessionSignature({ ...base, llmReasoningEffort: 'off' }));
});

await test('老会话换档位：原地重选，不新建会话', async () => {
  clearEffortCache();
  const registry = fakeRegistry(['off', 'low']);
  const entry = registry.entry('group:3');
  entry.sessionId = 'session-old';
  entry.sessionSignature = sessionSignature(registry.config);
  entry.modelSignature = modelSignatureOf(registry.config);
  // 用户把 off 改成 low；会话本身不该动，选择要跟着改。
  registry.config.llmReasoningEffort = 'low';
  const created = [];
  registry.ctx.sessionController.create = async () => { created.push(1); return { sessionId: 'nope' }; };
  const sessionId = await ensureSession(registry, 'group:3');
  assert.equal(sessionId, 'session-old');
  assert.equal(created.length, 0);
  assert.equal(registry.selects.at(-1).reasoningEffort, 'low');
  assert.equal(registry.selects.at(-1).sessionId, 'session-old');
});

await test('没改模型和档位就不会重复重选', async () => {
  clearEffortCache();
  const registry = fakeRegistry(['off']);
  await ensureSession(registry, 'group:4');
  const before = registry.selects.length;
  await ensureSession(registry, 'group:4');
  assert.equal(registry.selects.length, before);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
