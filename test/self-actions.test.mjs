/**
 * 足迹（"我最近自己做过的事"）——她主动开口之后留下的痕迹。
 *
 * 钉的是行为，不是文案：
 *   · 主动说过话、有没有人接，会被摆在她下一次醒来的眼前；
 *   · 同一间屋子说"在这儿"，别的屋子说"在别处"，号码不出场；
 *   · 没有足迹时一块都不出现（不凭空造"你最近很活跃"）。
 *
 * 为什么这些重要：每个窗口都是一次独立实例，主动时间又是随机到点才醒。
 * 没有这一块，她每次醒来都像第一次醒——这是"记忆连续"和"体验连续"之间
 * 差的那一格。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MemoryStore } from '../lib/memory/memory-store.mjs';
import { buildMemoryInjection } from '../lib/prompt/render.mjs';
import { config, message } from './helpers/bridge.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-self-actions-'));
const stores = [];
let passed = 0, failed = 0, sequence = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (error) { failed++; console.error('  ✗ ' + name, error); }
}

function setup({ settings = {} } = {}) {
  const dir = path.join(root, String(sequence++)); fs.mkdirSync(dir);
  const store = new Store(path.join(dir, 'test.sqlite3')); stores.push(store);
  const cfg = config({ memoryEnabled: true, memoryDir: path.join(dir, 'memory'), groupEnabled: true,
    groups: ['10', '11'], privateEnabled: true, users: ['200'], ...settings });
  const memory = new MemoryStore({ logger: { warn() {} } }, cfg, store);
  const inject = (event) => buildMemoryInjection(cfg, event, { memoryHashes: {}, staticDone: false, recentQqs: [] }, memory).text;
  return { store, cfg, memory, inject };
}

try {
  await test('主动说过话、有没有人接，下一次醒来时摆在眼前', () => {
    const s = setup();
    const id1 = s.store.recordProactive({ conversation: 'group:10', kind: 'speak',
      text: '在吗，今天那个局我没去。', idemKey: 'p1' });
    s.store.finishProactiveCheck(id1, 'quiet');
    s.store.recordProactive({ conversation: 'group:11', kind: 'bili_share',
      text: '这个视频你可能会笑。', ref: 'BV1xx411c7mD', idemKey: 'p2' });
    const text = s.inject(message('m1', '在吗'));
    assert.match(text, /我最近自己做过的事/u);
    assert.match(text, /说了一句话/u);
    assert.match(text, /分享了一个视频/u);
    assert.match(text, /没人接/u);
    assert.match(text, /还没回音/u, '十五分钟的观察窗没过，就该说还没回音');
  });

  await test('同一间屋子说这儿、别处说那儿，号码不出场', () => {
    const s = setup();
    s.store.recordProactive({ conversation: 'group:10', kind: 'speak', text: '在这儿说的', idemKey: 'p1' });
    s.store.recordProactive({ conversation: 'group:11', kind: 'speak', text: '在别处说的', idemKey: 'p2' });
    const text = s.inject(message('m2', '在吗'));
    assert.match(text, /在这儿说了一句话/u);
    assert.match(text, /在别处说了一句话/u);
    // 号码与 `group:` 前缀都不该出现在注入里：这条会进群聊。
    assert.doesNotMatch(text, /group:1[01]\b/u);
    assert.doesNotMatch(text, /\b10\b\s*群/u);
  });

  await test('没有足迹时一块都不出现，关掉也不出现', () => {
    const empty = setup();
    assert.doesNotMatch(empty.inject(message('m3', '在吗')), /我最近自己做过的事/u);
    const off = setup({ settings: { selfActionsMaxChars: 0 } });
    off.store.recordProactive({ conversation: 'group:10', kind: 'speak', text: '说过一句', idemKey: 'p1' });
    assert.doesNotMatch(off.inject(message('m4', '在吗')), /我最近自己做过的事/u);
  });
} finally {
  for (const store of stores) { try { store.close(); } catch { /* 无妨 */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不算失败 */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
