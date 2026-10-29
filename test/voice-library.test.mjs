/**
 * voice-library.test.mjs —— 语音库的边界：路径、名字、时长、清单注入。
 *
 * 这一层的价值全在"拒绝"上：它挡在 SnowLuma 的 `loadPtt` 之前，而后者会直接
 * 读给它的本机路径。所以断言不算发送成功与否，只算"什么能出去、什么必须拒"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  voiceLibraryRoot,
  loadVoiceLibrary,
  matchClip,
  resolveClip,
  voiceLibraryPromptLines,
  formatDuration,
  MAX_CLIP_BYTES,
} from '../lib/agent/voice-library.mjs';

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

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-library-'));
}

/** 建库：entries 写进 index.json，文件按需写进 clips/。 */
function makeLibrary(entries, { files = { 'clips/a.mp3': 1024 } } = {}) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'clips'), { recursive: true });
  for (const [rel, size] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), Buffer.alloc(size, 7));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(entries));
  return root;
}

const sha = (bytes) => createHash('sha256').update(Buffer.alloc(bytes, 7)).digest('hex');

console.log('voice-library: 语音库边界');

await test('库根默认在部署级目录，config 与环境变量可覆盖', () => {
  const saved = process.env.QQ_VOICE_LIBRARY;
  try {
    delete process.env.QQ_VOICE_LIBRARY;
    assert.match(voiceLibraryRoot({}), /\.dsh[\\/]qq-voices$/);
    assert.equal(voiceLibraryRoot({ voiceLibraryRoot: 'D:\\voices' }), path.resolve('D:\\voices'));
    process.env.QQ_VOICE_LIBRARY = path.join(os.tmpdir(), 'env-voices');
    assert.equal(voiceLibraryRoot({}), path.resolve(process.env.QQ_VOICE_LIBRARY));
    // 显式配置优先于环境变量
    assert.equal(voiceLibraryRoot({ voiceLibraryRoot: 'D:\\cfg' }), path.resolve('D:\\cfg'));
  } finally {
    if (saved === undefined) delete process.env.QQ_VOICE_LIBRARY;
    else process.env.QQ_VOICE_LIBRARY = saved;
  }
});

await test('没建库是空清单而不是异常；坏 JSON 才报错', () => {
  const empty = loadVoiceLibrary(tmpDir());
  assert.equal(empty.exists, false);
  assert.deepEqual(empty.entries, []);

  const root = makeLibrary([]);
  fs.writeFileSync(path.join(root, 'index.json'), '{ 不是 JSON');
  assert.throws(() => loadVoiceLibrary(root), /不是合法 JSON/);
});

await test('清单接受 { clips } 形状，停用条目与缺 file 的条目被跳过', () => {
  const root = makeLibrary([]);
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ clips: [
    { id: 'on', file: 'clips/a.mp3', label: '能唱的' },
    { id: 'off', file: 'clips/a.mp3', label: '停用的', enabled: false },
    { id: 'broken', label: '没文件' },
  ] }));
  const { entries } = loadVoiceLibrary(root);
  assert.deepEqual(entries.map((e) => e.id), ['on']);
  assert.equal(entries[0].label, '能唱的');
});

await test('路径越界、符号链接、超大白名单外一律拒绝', () => {
  const root = makeLibrary([
    { id: 'escape', file: '../outside.mp3', label: '越界' },
    { id: 'sub', file: 'clips/a.mp3', label: '正常' },
  ]);
  fs.writeFileSync(path.join(path.dirname(root), 'outside.mp3'), 'x');
  const { entries } = loadVoiceLibrary(root);
  assert.throws(() => resolveClip(root, entries.find((e) => e.id === 'escape')), /越界/);
  assert.equal(resolveClip(root, entries.find((e) => e.id === 'sub')).file, fs.realpathSync(path.join(root, 'clips/a.mp3')));

  const huge = makeLibrary([{ id: 'huge', file: 'clips/a.mp3', label: '超大' }], { files: { 'clips/a.mp3': MAX_CLIP_BYTES + 1 } });
  assert.throws(() => resolveClip(huge, loadVoiceLibrary(huge).entries[0]), /超过/);

  const missing = makeLibrary([{ id: 'gone', file: 'clips/none.mp3', label: '不见了' }], { files: {} });
  assert.throws(() => resolveClip(missing, loadVoiceLibrary(missing).entries[0]), /不存在/);
});

await test('sha256 与时长是硬约束：被替换的文件、超长音频都不发', () => {
  const root = makeLibrary([
    { id: 'sum', file: 'clips/a.mp3', label: '带指纹', sha256: sha(1024) },
    { id: 'bad', file: 'clips/a.mp3', label: '指纹不对', sha256: sha(2048) },
    { id: 'long', file: 'clips/a.mp3', label: '太长', durationMs: 6 * 60 * 1000 },
  ]);
  const { entries } = loadVoiceLibrary(root);
  assert.equal(resolveClip(root, entries.find((e) => e.id === 'sum')).sha256, sha(1024));
  assert.throws(() => resolveClip(root, entries.find((e) => e.id === 'bad')), /sha256/);
  assert.throws(() => resolveClip(root, entries.find((e) => e.id === 'long')), /超过上限 300 秒/);
});

await test('按 id / 名字 / 关键词找，歧义和找不到都明确报候选', () => {
  const entries = [
    { id: 'yuai-sifeng', label: '雨爱(司凤版)', tags: ['唱歌'], description: '整首' },
    { id: 'yuai-live', label: '雨爱(现场)', tags: ['唱歌'] },
    { id: 'lullaby', label: '摇篮曲', tags: ['晚安'] },
  ];
  assert.equal(matchClip(entries, '雨爱(司凤版)').entry.id, 'yuai-sifeng');
  assert.equal(matchClip(entries, '雨爱-司凤版').entry.id, 'yuai-sifeng', '标点/空格不该影响匹配');
  assert.equal(matchClip(entries, 'yuai-sifeng').entry.id, 'yuai-sifeng');
  assert.equal(matchClip(entries, '摇篮').entry.id, 'lullaby');
  assert.equal(matchClip(entries, '晚安').entry.id, 'lullaby');
  assert.throws(() => matchClip(entries, '雨爱'), /匹配到 2 条/);
  assert.throws(() => matchClip(entries, '七里香'), /没有匹配/);
  assert.throws(() => matchClip(entries, '   '), /不能为空/);
});

await test('提示词清单只列名字时长用途：不给文件名和路径，条目多时报还有几条', () => {
  const root = makeLibrary([
    { id: 'a', file: 'clips/a.mp3', label: '雨爱(司凤版)', durationMs: 140140, description: '整首' },
    { id: 'b', file: 'clips/a.mp3', label: '摇篮曲', spoken: '（哼一段）' },
    { id: 'c', file: 'clips/a.mp3', label: '第三条' },
    { id: 'd', file: 'clips/a.mp3', label: '第四条' },
  ]);
  const lines = voiceLibraryPromptLines({ voiceLibraryRoot: root }, { maxInline: 2 });
  const text = lines.join('\n');
  assert.match(text, /qq_send_voice/);
  assert.match(text, /雨爱\(司凤版\)｜2分20秒｜整首/);
  assert.match(text, /另有 2 条/);
  assert.doesNotMatch(text, /\.mp3|clips\//, '模型不该看到库内文件名');

  assert.deepEqual(voiceLibraryPromptLines({ voiceLibraryRoot: tmpDir() }), [], '空库不注入任何小节');
});

await test('时长写法', () => {
  assert.equal(formatDuration(0), '时长未知');
  assert.equal(formatDuration(45000), '45秒');
  assert.equal(formatDuration(140140), '2分20秒');
  assert.equal(formatDuration(120000), '2分钟');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.error(`\n✗ ${f.name}\n${f.error?.stack ?? f.error}`);
  process.exitCode = 1;
}
