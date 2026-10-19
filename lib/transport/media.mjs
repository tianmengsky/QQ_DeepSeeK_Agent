import fs from 'node:fs';
import path from 'node:path';
import { onebotCall } from './onebot-client.mjs';

const MEDIA_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

function mediaTypeOf(filePath, fallback = 'image/png') {
  return MEDIA_BY_EXT.get(path.extname(filePath).toLowerCase()) ?? fallback;
}

function sniffMediaType(buffer) {
  if (!buffer || buffer.length < 12) return '';
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return '';
}

function imagePartFromFile(filePath, config) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length > config.maxImageBytes) {
    return {
      skipped: `图片 ${Math.round(buffer.length / 1024)}KB 超过上限 ${Math.round(config.maxImageBytes / 1024)}KB`,
    };
  }
  const mediaType = sniffMediaType(buffer) || mediaTypeOf(filePath);
  if (!isSupportedMedia(mediaType)) {
    return {
      skipped: `不支持的图片格式（嗅探=${sniffMediaType(buffer) || '未知'} 扩展名=${path.extname(filePath)}）`,
    };
  }
  return {
    part: {
      type: 'image',
      mediaType,
      data: buffer.toString('base64'),
      name: path.basename(filePath),
    },
  };
}

function isSupportedMedia(mediaType) {
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType);
}

function extractHash(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const m = value.match(/[0-9a-fA-F]{32}/);
    if (m) return m[0].toLowerCase();
  }
  return '';
}

function findEmojiCacheFile(qqDataPath, hash) {
  if (!qqDataPath || !hash) return '';
  const emojiRoot = path.join(qqDataPath, 'nt_qq', 'nt_data', 'Emoji');
  for (const sub of ['emoji-recv', 'personal_emoji', 'emoji-related']) {
    const base = path.join(emojiRoot, sub);
    if (!fs.existsSync(base)) continue;
    for (const dir of listDirsRecursive(base, 2)) {
      for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
        const candidate = path.join(dir, `${hash}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function listDirsRecursive(root, depth) {
  const out = [root];
  if (depth <= 0) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...listDirsRecursive(path.join(root, entry.name), depth - 1));
  }
  return out;
}

async function loadImagePart(config, segment) {
  const data = segment?.data ?? {};
  const candidates = [];

  // 1) get_image 是 OneBot 的标准扩展，能把 file 标识换成本机绝对路径
  try {
    const info = await onebotCall(config, 'get_image', {
      file: data.file ?? data.url ?? data.path,
    });
    if (typeof info?.file === 'string') candidates.push(info.file);
  } catch {
    /* 不支持就算了，继续试别的 */
  }
  for (const key of ['path', 'file']) {
    if (typeof data[key] === 'string') candidates.push(data[key]);
  }

  // 2) 本地文件
  for (const candidate of candidates) {
    const local = candidate.replace(/^file:\/\/\/?/i, '');
    try {
      if (!local || !fs.existsSync(local)) continue;
      if (!fs.statSync(local).isFile()) continue;
      const loaded = imagePartFromFile(local, config);
      if (loaded.part) return loaded;
    } catch {
      /* 换下一个候选 */
    }
  }

  // 3) 远程 URL
  if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) {
    try {
      const response = await fetch(data.url, { signal: AbortSignal.timeout(20000) });
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const sniffed = sniffMediaType(buffer);
        const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim();
        const mediaType = sniffed || declared;
        if (isSupportedMedia(mediaType) && buffer.length <= config.maxImageBytes) {
          return {
            part: { type: 'image', mediaType, data: buffer.toString('base64'), name: 'qq-image' },
          };
        }
        return {
          skipped: `远程图片不可用（嗅探=${sniffed || '未知'} 声明=${declared || '未知'} ${Math.round(buffer.length / 1024)}KB）`,
        };
      }
    } catch (error) {
      /* 落到缓存兜底 */
      var remoteError = error?.message ?? String(error);
    }
  }

  // 4) 账号表情缓存兜底：段里通常带一个 32 位哈希，文件名就是它。
  //    注意 QQ 常用 .jpg 命名实际是 PNG 的动画表情，所以必须按字节判类型。
  const hash = extractHash(data.file, data.url, data.path);
  const cached = findEmojiCacheFile(config.qqDataPath, hash);
  if (cached) {
    try {
      const loaded = imagePartFromFile(cached, config);
      if (loaded.part) return loaded;
      if (loaded.skipped) return { skipped: `缓存文件不可用 —— ${loaded.skipped}` };
    } catch {
      /* 落到下面的 skipped */
    }
  }

  return {
    skipped:
      `取不到图片字节。hash=${hash || '(无)'} 缓存命中=${cached || '否'} ` +
      (typeof remoteError === 'string' ? `远程失败=${remoteError} ` : '') +
      `候选=${JSON.stringify(candidates.slice(0, 6))} ` +
      `url=${String(data.url ?? '').slice(0, 160)} file=${String(data.file ?? '').slice(0, 160)}`,
  };
}

export {
  MEDIA_BY_EXT,
  mediaTypeOf,
  sniffMediaType,
  imagePartFromFile,
  isSupportedMedia,
  extractHash,
  findEmojiCacheFile,
  listDirsRecursive,
  loadImagePart,
};
