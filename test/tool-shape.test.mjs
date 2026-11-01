/**
 * 工具形状守卫。
 *
 * 为什么单独一条：v130 的 `qq_intent` 把参数表写成了 `inputSchema`，宿主的
 * `tools.register` 读的是 `parameters`，于是在**插件加载阶段**抛错 —— 表现不是
 * "这个工具用不了"，而是 DSH 整个起不来（页面上只有一句"应用无法启动"）。
 * 这种错跑任何单个工具的 execute 都测不到，只能钉"交给宿主的那个对象长什么样"。
 *
 * 这里用最小的假 registry 复刻宿主的契约：
 *   - `name` 非空字符串
 *   - `description` 非空字符串
 *   - `parameters` 是 type=object 的 JSON Schema
 *   - `output.render(args, value)` 返回 text 段数组
 *   - `execute` 是函数
 */
import assert from 'node:assert/strict';

import { intentTool } from '../lib/application/intent-tool.mjs';
import { windowsTool } from '../lib/conversation/window-tool.mjs';
import { memoryTool } from '../lib/memory/tool.mjs';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log('       ' + (error?.message ?? String(error)));
  }
}

/** 宿主 `tools.register` 的最小复刻：只校验它真正读的字段。 */
function hostRegister(tool) {
  if (typeof tool?.name !== 'string' || !tool.name) throw new Error('tools.register: 缺少 name');
  if (typeof tool.description !== 'string' || !tool.description) throw new Error(`${tool.name}: 缺少 description`);
  if (!tool.parameters || tool.parameters.type !== 'object') {
    throw new Error(`${tool.name}: 缺少 parameters（宿主读的是 parameters，不是 inputSchema）`);
  }
  if (!Array.isArray(tool.parameters.required) || tool.parameters.required.length === 0) {
    throw new Error(`${tool.name}: parameters.required 不能为空`);
  }
  if (typeof tool.output?.render !== 'function') throw new Error(`${tool.name}: 缺少 output.render`);
  if (typeof tool.execute !== 'function') throw new Error(`${tool.name}: 缺少 execute`);
  return true;
}

const state = { disposed: false, enabled: true };
const toolset = {
  qq_memory: () => memoryTool({
    memory: { agent: { available: true } },
    registry: {},
    store: {},
    config: {},
    state,
  }),
  qq_windows: () => windowsTool({
    store: { available: true },
    config: { groupEnabled: true, privateEnabled: true },
    state,
    registry: {},
  }),
  qq_intent: () => intentTool({ store: { available: true }, config: {}, state }),
};

for (const [expected, make] of Object.entries(toolset)) {
  await test(`${expected} 交给宿主的形状能通过 register`, () => {
    const tool = make();
    assert.equal(tool.name, expected);
    assert.equal(hostRegister(tool), true);
  });
}

await test('参数表一律用 parameters，不允许 inputSchema', () => {
  for (const [expected, make] of Object.entries(toolset)) {
    const tool = make();
    assert.equal(tool.inputSchema, undefined, `${expected} 又写回了 inputSchema`);
    assert.ok(tool.parameters, `${expected} 没有 parameters`);
  }
});

await test('output.render 把结果压成一条 text 段', () => {
  for (const [, make] of Object.entries(toolset)) {
    const tool = make();
    const segments = tool.output.render({}, { status: 'OK' });
    assert.equal(segments.length, 1);
    assert.equal(segments[0].type, 'text');
    assert.match(segments[0].text, /"status":"OK"/);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
