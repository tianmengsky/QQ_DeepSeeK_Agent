import assert from 'node:assert/strict';
import { rig, message } from './helpers/bridge.mjs';
import { formatForwardNodes } from '../lib/prompt/forward.mjs';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { console.error('  ✗ ' + name, error); process.exitCode = 1; }
}

const nodes = [
  { sender: { user_id: 201, nickname: '甲' }, time: 1700000000,
    content: [{ type: 'text', data: { text: '第一条' } }] },
  { sender: { user_id: 202, card: '乙' }, content: [{ type: 'text', data: { text: '第二条' } }] },
];
const forwardEvent = (id, text = '看看这个') => ({ ...message(id), message: [
  { type: 'at', data: { qq: '100' } },
  { type: 'text', data: { text: ` ${text}` } },
  { type: 'forward', data: { id: 'forward-1' } },
] });
const quotedForwardEvent = (id, text = '收到') => ({ ...message(id), message: [
  { type: 'at', data: { qq: '100' } },
  { type: 'text', data: { text: ` ${text}` } },
  { type: 'reply', data: { id: 'quoted-forward-message' } },
] });

function mockForwardFetch(previous, { forwardCalls = null } = {}) {
  return async (url, init) => {
    const action = String(url).split('/').pop();
    if (action === 'get_msg') return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: {
        sender: { user_id: 203, nickname: '丙' },
        message: [{ type: 'forward', data: { id: 'forward-quoted' } }],
      } }),
    };
    if (action === 'get_forward_msg') {
      if (forwardCalls) forwardCalls.count++;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }),
      };
    }
    return previous(url, init);
  };
}

await test('forward formatter keeps sender identity and obeys a character budget', () => {
  const rendered = formatForwardNodes(nodes, { maxMessages: 1, maxChars: 180 });
  assert.match(rendered, /甲（QQ 201/);
  assert.match(rendered, /其余 1 条未展开/);
  assert.doesNotMatch(rendered, /第二条/);
});

await test('lazy mode reads a forward only when the message asks to read it', async () => {
  const r = rig({ forwardMode: 'lazy', forwardMaxMessages: 1, forwardMaxChars: 180 });
  const original = globalThis.fetch;
  let forwardCalls = 0;
  globalThis.fetch = async (url, init) => String(url).endsWith('/get_forward_msg')
    ? (forwardCalls++, { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }) })
    : original(url, init);
  try {
    await r.post(forwardEvent(31));
    assert.equal(forwardCalls, 1);
    assert.match(JSON.stringify(r.prompts), /第一条/);
    assert.doesNotMatch(JSON.stringify(r.prompts), /第二条/);
    assert.match(JSON.stringify(r.prompts), /qq_read_forward/);
    assert.match(JSON.stringify(r.prompts), /next_offset/);
  } finally { globalThis.fetch = original; }
});

await test('lazy mode leaves an unrequested forward collapsed', async () => {
  const r = rig({ forwardMode: 'lazy' });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => String(url).endsWith('/get_forward_msg')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }) }
    : original(url, init);
  try {
    await r.post(forwardEvent(32, '收到'));
    assert.equal(r.calls.some((c) => c.action === 'get_forward_msg'), false);
    assert.match(JSON.stringify(r.prompts), /合并转发/);
    assert.doesNotMatch(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('a fully displayed quoted forward with images exposes lazy image reading without loading pixels', async () => {
  const r = rig({ forwardMode: 'lazy' });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/get_forward_msg')) return { ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [
        { sender: { user_id: 201, nickname: '甲' }, content: [{ type: 'image', data: { file: 'lazy-image' } }] },
      ] } }) };
    return mockForwardFetch(original)(url, init);
  };
  try {
    await r.post(quotedForwardEvent(49, '看里面的图片'));
    const prompt = JSON.stringify(r.prompts);
    assert.match(prompt, /节点 0/);
    assert.match(prompt, /图片尚未加载/);
    assert.match(prompt, /forward_id=forward-quoted/);
    assert.match(prompt, /node_index/);
    assert.match(prompt, /image_index/);
    assert.equal(r.calls.some((call) => call.action === 'get_image'), false);
  } finally { globalThis.fetch = original; }
});

await test('lazy mode reads a message that contains only a forward', async () => {
  const r = rig({ forwardMode: 'lazy' });
  const original = globalThis.fetch;
  let forwardCalls = 0;
  globalThis.fetch = async (url, init) => String(url).endsWith('/get_forward_msg')
    ? (forwardCalls++, { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }) })
    : original(url, init);
  try {
    await r.post(forwardEvent(35, ''));
    assert.equal(forwardCalls, 1);
    assert.match(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('quoted forward is expanded like a quoted image', async () => {
  const r = rig({ forwardMode: 'lazy' });
  const original = globalThis.fetch;
  const forwardCalls = { count: 0 };
  globalThis.fetch = mockForwardFetch(original, { forwardCalls });
  try {
    await r.post(quotedForwardEvent(36));
    assert.equal(forwardCalls.count, 1);
    assert.match(JSON.stringify(r.prompts), /第一条/);
    assert.match(JSON.stringify(r.prompts), /引用 丙/);
  } finally { globalThis.fetch = original; }
});

await test('quoted forward passes the attention gate instead of being treated as passive context', async () => {
  const r = rig({ forwardMode: 'lazy', groupAttentionEnabled: true, replyDecisionEnabled: true });
  const original = globalThis.fetch;
  const forwardCalls = { count: 0 };
  globalThis.fetch = mockForwardFetch(original, { forwardCalls });
  try {
    await r.post(quotedForwardEvent(37, '收到'));
    assert.equal(forwardCalls.count, 1);
    assert.equal(r.prompts.length, 1);
    assert.match(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('forward-only followup is admitted during the shared group awake window', async () => {
  const r = rig({ forwardMode: 'lazy' });
  r.registry.entry('group:10').awakeUntil = Date.now() + 30000;
  const original = globalThis.fetch;
  const forwardCalls = { count: 0 };
  globalThis.fetch = mockForwardFetch(original, { forwardCalls });
  try {
    const event = { ...message(39, ''), message: [{ type: 'forward', data: { id: 'forward-1' } }] };
    await r.post(event);
    assert.equal(forwardCalls.count, 1);
    assert.equal(r.prompts.length, 1);
    assert.match(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('explicit history request lazily reads the nearest stored forward', async () => {
  const r = rig({ forwardMode: 'lazy', contextForwardsOnRequest: 1 });
  const entry = r.registry.entry('group:10');
  entry.awakeUntil = Date.now() + 30000;
  r.registry.buffer(entry, {
    messageId: 'old-forward', qq: '200', who: '甲', text: '[合并转发]',
    forwards: [{ type: 'forward', data: { id: 'forward-history' } }], at: Date.now() - 1000,
  });
  const original = globalThis.fetch;
  const forwardCalls = { count: 0 };
  globalThis.fetch = mockForwardFetch(original, { forwardCalls });
  try {
    await r.post(message(40, '看上面那个'));
    assert.equal(forwardCalls.count, 1);
    assert.match(JSON.stringify(r.prompts), /上文合并转发/);
    assert.match(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('quoted forward honors never mode and keeps the collapsed placeholder', async () => {
  const r = rig({ forwardMode: 'never' });
  const original = globalThis.fetch;
  let forwardCalls = 0;
  globalThis.fetch = async (url, init) => {
    const action = String(url).split('/').pop();
    if (action === 'get_msg') return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: {
        sender: { user_id: 203, nickname: '丙' },
        message: [{ type: 'forward', data: { id: 'forward-quoted' } }],
      } }),
    };
    if (action === 'get_forward_msg') { forwardCalls++; }
    return original(url, init);
  };
  try {
    await r.post(quotedForwardEvent(38, '看看这个'));
    assert.equal(forwardCalls, 0);
    assert.match(JSON.stringify(r.prompts), /\[合并转发\]/);
    assert.doesNotMatch(JSON.stringify(r.prompts), /第一条/);
  } finally { globalThis.fetch = original; }
});

await test('always and never modes are explicit', async () => {
  const original = globalThis.fetch;
  const reply = { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { messages: nodes } }) };
  for (const [mode, expected] of [['always', true], ['never', false]]) {
    const r = rig({ forwardMode: mode });
    const previous = globalThis.fetch;
    let forwardCalls = 0;
    globalThis.fetch = async (url, init) => String(url).endsWith('/get_forward_msg')
      ? (forwardCalls++, reply) : previous(url, init);
    try {
      await r.post(forwardEvent(mode === 'always' ? 33 : 34, '收到'));
      assert.equal(forwardCalls > 0, expected, mode);
    } finally { globalThis.fetch = original; }
  }
});

console.log(`${passed} passed, ${process.exitCode ? 1 : 0} failed`);
