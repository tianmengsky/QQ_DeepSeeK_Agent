/**
 * 语音库：预烘培好的音频（歌曲片段、录音、自定义音色）当 QQ 语音气泡发出去。
 *
 * 为什么要有这一层，而不是让模型直接给 `qq_send_group_msg` 传 record 段：
 *   · 路径白名单：record 段里的 file 是**本机绝对路径**，SnowLuma 会直接读它转 SILK。
 *     不设库边界，就等于给群消息开了一个"读操作者机器上任意文件并发出去"的入口。
 *   · 记账：语音气泡没有文字，后续回合里模型看不见自己"唱了什么"。
 *     库里的 `spoken` 是唯一能让它记住这件事的来源。
 *   · 配额与冷却：语音比文字贵（不能扫读、占时间），要能被单独限住。
 *
 * 目录约定（root 默认 `~/.dsh/qq-voices`）：
 *   index.json          清单，数组，也接受 { clips: [...] }
 *   clips/xxx.mp3       音频本体，任意能被 SnowLuma 的 ffmpeg 认出的格式
 *
 * 清单条目的最小形状：
 *   { id, file, label?, spoken?, description?, tags?, durationMs?, sha256?, enabled? }
 *
 * 这里只做"读 + 校验 + 匹配"，不做发送：发送在 qq-mcp 里（它才有幂等/回执/能力位）。
 * 语音不设冷却或小时闸——点了歌就得发得出去；要收口子在 qq-mcp 的 QUOTA 里加。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const VOICE_LIBRARY_STATE_KEY = 'qq-bridge:voice-library-root';
export const VOICE_INDEX_FILE = 'index.json';
/** 单条音频上限：与发送工具的家规一致（20 MiB）。 */
export const MAX_CLIP_BYTES = 20 * 1024 * 1024;
/** 一次发送允许的最长时长；超了本地就拒，别让 QQ 那边替我们报错。 */
export const MAX_CLIP_SECONDS = 300;

export function voiceLibraryRoot(config = {}) {
  return path.resolve(
    String(config.voiceLibraryRoot ?? '').trim() ||
      process.env.QQ_VOICE_LIBRARY ||
      path.join(os.homedir(), '.dsh', 'qq-voices'),
  );
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 条目 → 稳定形状；缺 id/file 的直接判无效。 */
function normalizeEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id) || `clip-${index + 1}`;
  const file = asString(raw.file ?? raw.path ?? raw.url);
  if (!file) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.map(asString).filter(Boolean) : [];
  return {
    id,
    file,
    label: asString(raw.label ?? raw.name) || id,
    spoken: asString(raw.spoken ?? raw.text),
    description: asString(raw.description ?? raw.note),
    tags,
    durationMs: asPositiveNumber(raw.durationMs ?? raw.duration),
    sha256: asString(raw.sha256).toLowerCase(),
    enabled: raw.enabled !== false,
  };
}

const cache = new Map();

/**
 * 读清单。
 *
 * 缓存按 mtime+size 失效：清单是人手改的（用 tools/seed-voice-library.mjs 或直接编辑），
 * 没有 notify 通道，每次 stat 一下最省事，也避免每轮都重新解析。
 */
export function loadVoiceLibrary(root = voiceLibraryRoot()) {
  const indexFile = path.join(root, VOICE_INDEX_FILE);
  let stat;
  try {
    stat = fs.statSync(indexFile);
  } catch {
    return { root, indexFile, entries: [], exists: false };
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(indexFile);
  if (cached && cached.stamp === stamp) return cached.value;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`语音库清单不是合法 JSON（${indexFile}）：${error?.message ?? error}`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.clips) ? parsed.clips : null;
  if (!list) throw new Error(`语音库清单必须是数组或 { clips: [...] }（${indexFile}）`);
  const entries = list
    .map((raw, i) => normalizeEntry(raw, i))
    .filter(Boolean)
    .filter((entry) => entry.enabled);
  const value = { root, indexFile, entries, exists: true };
  cache.set(indexFile, { stamp, value });
  return value;
}

/** 条目路径必须落在库根之内；根与文件都用 realpath 比较，符号链接绕不出去。 */
export function clipPath(root, entry) {
  const full = path.resolve(root, entry.file);
  const rel = path.relative(path.resolve(root), full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`语音库条目 ${entry.id} 的 file 越界：${entry.file}`);
  return full;
}

/**
 * 校验并返回可发送的**真实**路径。
 *
 * 之所以返回 realpath：SnowLuma 的 `loadPtt` 会 `resolveLocalFilePath(source)` 直接
 * 读这个路径，中间经历一次符号链接跳转的话，白名单检查过的目标和实际读取的目标
 * 就不是同一个文件了。
 */
export function resolveClip(root, entry) {
  const full = clipPath(root, entry);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    throw new Error(`语音库条目 ${entry.id} 的文件不存在：${entry.file}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`语音库禁止符号链接：${entry.file}`);
  if (!stat.isFile()) throw new Error(`语音库条目不是普通文件：${entry.file}`);
  if (stat.size > MAX_CLIP_BYTES)
    throw new Error(`语音文件 ${entry.label} 有 ${formatBytes(stat.size)}，超过 ${formatBytes(MAX_CLIP_BYTES)}`);
  const real = fs.realpathSync(full);
  const realRoot = fs.realpathSync(path.resolve(root));
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error(`语音库条目 ${entry.id} 解析后越界：${entry.file}`);
  let digest = '';
  if (entry.sha256) {
    digest = sha256File(real);
    if (digest !== entry.sha256) throw new Error(`语音文件 ${entry.label} 与清单里的 sha256 不一致（可能被替换）`);
  }
  if (entry.durationMs > MAX_CLIP_SECONDS * 1000)
    throw new Error(
      `语音 ${entry.label} 时长 ${formatDuration(entry.durationMs)}，超过上限 ${MAX_CLIP_SECONDS} 秒；` +
        '请用 tools/seed-voice-library.mjs --split 切段后再登记。',
    );
  return { entry, file: real, size: stat.size, sha256: digest || sha256File(real) };
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/[\s《》「」『』"'“”()（）\-_/、，。,.!！?？]+/g, '');
}

/**
 * 按名字/关键词找一条。
 *
 * 允许三种写法：id（yuai-sifeng）、label（雨爱(司凤版)）、tags 里的词（唱歌）。
 * 命中多条就报错并列出候选 —— 让模型自己挑，而不是悄悄选第一条发出去。
 */
export function matchClip(entries, query) {
  const q = norm(query);
  if (!q) throw new Error('name 不能为空：用语音库里的名字或关键词');
  const exact = entries.filter((e) => norm(e.id) === q || norm(e.label) === q);
  if (exact.length === 1) return { entry: exact[0], candidates: exact };
  const fuzzy = entries.filter(
    (e) =>
      norm(e.id).includes(q) ||
      norm(e.label).includes(q) ||
      norm(e.description).includes(q) ||
      e.tags.some((tag) => norm(tag).includes(q)),
  );
  if (fuzzy.length === 1) return { entry: fuzzy[0], candidates: fuzzy };
  if (!fuzzy.length)
    throw new Error(
      `语音库里没有匹配「${query}」的音频。现有：` +
        (entries.length ? entries.map((e) => e.label).join('、') : '（空）'),
    );
  throw new Error(
    `「${query}」在语音库里匹配到 ${fuzzy.length} 条，请用更准确的名字：` +
      fuzzy.map((e) => e.label).join('、'),
  );
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (!total) return '时长未知';
  const m = Math.floor(total / 60), s = total % 60;
  return m ? `${m}分${s ? `${s}秒` : '钟'}` : `${s}秒`;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * 给模型的清单摘要（每轮注入）。
 *
 * 只塞名字、时长、用途；文件名和路径不给 —— 模型只需要"点什么"，不需要知道本机路径，
 * 也不该被诱导去关心 `clips/xxx.mp3`。条目多时只列前几条，全量交给 qq_voice_library。
 */
export function voiceLibraryPromptLines(config = {}, { maxInline = 8 } = {}) {
  let library;
  try {
    library = loadVoiceLibrary(voiceLibraryRoot(config));
  } catch {
    return [];
  }
  if (!library.entries.length) return [];
  const shown = library.entries.slice(0, maxInline);
  const lines = [
    '【你能直接放语音】语音库里有这些现成音频。对方点歌、让你唱、想听你的声音，或你想用声音回应时，用 qq_send_voice 发出去；name 填下面的名字或关键词：',
    ...shown.map((e) => {
      const bits = [e.label, formatDuration(e.durationMs)];
      if (e.description) bits.push(e.description);
      else if (e.spoken) bits.push(`内容：${e.spoken}`);
      return `· ${bits.join('｜')}`;
    }),
  ];
  if (library.entries.length > shown.length)
    lines.push(`· 另有 ${library.entries.length - shown.length} 条，用 qq_voice_library 查全量。`);
  lines.push('语音不能扫读、也发得比文字慢：点到为止，一条就够，别自己连发好几条。');
  return lines;
}
