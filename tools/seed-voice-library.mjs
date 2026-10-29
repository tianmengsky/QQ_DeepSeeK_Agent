#!/usr/bin/env node
/**
 * 语音库维护工具：把音频登记进 index.json（可选切段）。
 *
 * 用法：
 *   node tools/seed-voice-library.mjs list
 *   node tools/seed-voice-library.mjs add "public/雨爱(司凤版).mp3" \
 *     --id yuai-sifeng --label "雨爱(司凤版)" --spoken "（唱《雨爱》）" \
 *     --description "整首 2 分 20 秒，点歌时用" --tags 唱歌,长语音
 *   node tools/seed-voice-library.mjs add <file> --id yuai --split 45   # 切成 ≤45 秒的片段
 *
 * 只做三件事：把文件复制到 clips/、量时长算 sha256、增量更新 index.json。
 * 不联网、不动 QQ、不改配置。--root 省略时用 lib/agent/voice-library.mjs 的默认值
 * （config.voiceLibraryRoot → QQ_VOICE_LIBRARY → ~/.dsh/qq-voices）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { voiceLibraryRoot } from '../lib/agent/voice-library.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'list';

function flag(name, fallback = '') {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : '';
}

const root = path.resolve(flag('root') || voiceLibraryRoot({ voiceLibraryRoot: process.env.QQ_VOICE_LIBRARY || '' }));
const indexFile = path.join(root, 'index.json');

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.clips) ? parsed.clips : [];
  } catch {
    return [];
  }
}

function writeIndex(entries) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** 逐帧扫一遍 MPEG Layer III：拿到帧偏移、时长的同时，切段也靠这份帧表。 */
function scanMp3(buffer) {
  let offset = 0;
  if (buffer.slice(0, 3).toString('latin1') === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size + (buffer[5] & 0x10 ? 10 : 0);
  }
  const frames = [];
  let seconds = 0;
  for (let i = offset; i + 4 <= buffer.length; ) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) {
      i += 1;
      continue;
    }
    const version = (buffer[i + 1] >> 3) & 3;
    const layer = (buffer[i + 1] >> 1) & 3;
    const bitrateIndex = (buffer[i + 2] >> 4) & 0xf;
    const sampleIndex = (buffer[i + 2] >> 2) & 3;
    const padding = (buffer[i + 2] >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
      i += 1;
      continue;
    }
    const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex] * 1000;
    const sampleRate = SAMPLE_RATES[version === 3 ? 3 : version][sampleIndex];
    const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
    if (length <= 4) {
      i += 1;
      continue;
    }
    const samples = version === 3 ? 1152 : 576;
    frames.push({ at: i, length, seconds: samples / sampleRate });
    seconds += samples / sampleRate;
    i += length;
  }
  return { frames, seconds };
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function upsert(entry) {
  const entries = readIndex();
  const at = entries.findIndex((e) => e.id === entry.id);
  if (at >= 0) entries[at] = { ...entries[at], ...entry };
  else entries.push(entry);
  writeIndex(entries);
  return entries.length;
}

if (command === 'list') {
  const entries = readIndex();
  const clipsDir = path.join(root, 'clips');
  const files = fs.existsSync(clipsDir) ? fs.readdirSync(clipsDir) : [];
  console.log(`语音库：${root}`);
  console.log(`清单：${fs.existsSync(indexFile) ? `${entries.length} 条` : '（还没有 index.json）'}`);
  for (const e of entries) {
    const file = path.join(root, e.file ?? '');
    const exists = e.file && fs.existsSync(file);
    console.log(`· ${e.label ?? e.id} [${e.id}] ${e.durationMs ? `${(e.durationMs / 1000).toFixed(1)}s` : '时长未知'} ` +
      `${exists ? '' : '（文件缺失！）'}${e.enabled === false ? '（已停用）' : ''}`);
  }
  const unregistered = files.filter((name) => !entries.some((e) => String(e.file).endsWith(name)));
  if (unregistered.length) console.log(`未登记的音频：${unregistered.join('、')}`);
  process.exit(0);
}

if (command !== 'add') {
  console.error(`未知命令：${command}（可用：list / add）`);
  process.exit(2);
}

const source = args[1] && !args[1].startsWith('--') ? path.resolve(args[1]) : '';
if (!source) {
  console.error('用法：node tools/seed-voice-library.mjs add <音频文件> --id <slug> [--label 名字] [--split 秒]');
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error(`文件不存在：${source}`);
  process.exit(2);
}

const ext = path.extname(source).toLowerCase() || '.mp3';
const id = slug(flag('id') || path.basename(source, path.extname(source)));
const label = flag('label') || path.basename(source, path.extname(source));
const spoken = flag('spoken');
const description = flag('description');
const tags = flag('tags').split(/[,，\s]+/).filter(Boolean);
const splitSeconds = Number(flag('split', '0')) || 0;

const buffer = fs.readFileSync(source);
const clipsDir = path.join(root, 'clips');
fs.mkdirSync(clipsDir, { recursive: true });

function currentIds() {
  return readIndex().map((e) => e.id);
}

if (!splitSeconds) {
  const file = `clips/${id}${ext}`;
  fs.writeFileSync(path.join(root, file), buffer);
  const scanned = ext === '.mp3' ? scanMp3(buffer) : { seconds: 0 };
  const entry = {
    id,
    file,
    label,
    ...(spoken ? { spoken } : {}),
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
    ...(scanned.seconds ? { durationMs: Math.round(scanned.seconds * 1000) } : {}),
    sha256: (await import('node:crypto')).createHash('sha256').update(buffer).digest('hex'),
    enabled: true,
  };
  const total = upsert(entry);
  console.log(`已登记 ${id} → ${file}（${(buffer.length / 1024).toFixed(0)} KiB，` +
    `${scanned.seconds ? `${scanned.seconds.toFixed(1)}s` : '时长未知'}）；清单共 ${total} 条`);
  process.exit(0);
}

if (ext !== '.mp3') {
  console.error('切段目前只支持 CBR/VBR 的 MP3（其他格式请先在外部切成文件再逐条 add）');
  process.exit(2);
}
const { frames, seconds } = scanMp3(buffer);
if (!frames.length) {
  console.error('没扫到 MPEG 帧，无法切段');
  process.exit(2);
}
console.log(`源文件 ${seconds.toFixed(1)}s，共 ${frames.length} 帧，按每段 ≤${splitSeconds}s 切`);

const groups = [];
let current = [];
let accumulated = 0;
for (const frame of frames) {
  current.push(frame);
  accumulated += frame.seconds;
  if (accumulated >= splitSeconds) {
    groups.push(current);
    current = [];
    accumulated = 0;
  }
}
if (current.length) groups.push(current);

let index = 0;
for (const group of groups) {
  index += 1;
  const idWithPart = groups.length > 1 ? `${id}-${index}` : id;
  const labelWithPart = groups.length > 1 ? `${label}（第 ${index} 段）` : label;
  const file = `clips/${idWithPart}${ext}`;
  const start = group[0].at;
  const last = group[group.length - 1];
  const end = Math.min(buffer.length, last.at + last.length);
  const bytes = buffer.subarray(start, end);
  fs.writeFileSync(path.join(root, file), bytes);
  const durationMs = Math.round(group.reduce((sum, frame) => sum + frame.seconds, 0) * 1000);
  upsert({
    id: idWithPart,
    file,
    label: labelWithPart,
    ...(spoken ? { spoken } : {}),
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
    durationMs,
    sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'),
    enabled: true,
  });
  console.log(`· ${idWithPart} → ${file}（${(bytes.length / 1024).toFixed(0)} KiB，${(durationMs / 1000).toFixed(1)}s）`);
}
console.log(`已登记 ${groups.length} 段，清单共 ${currentIds().length} 条`);
