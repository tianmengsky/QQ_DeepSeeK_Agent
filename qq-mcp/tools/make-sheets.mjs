/**
 * 把账号收藏表情导出成分页总览图，落到 cache 目录。
 * 供人工/子代理阅读后编写文字目录。
 *
 * 用法: node tools/make-sheets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const BASE = process.env.ONEBOT_HTTP || 'http://127.0.0.1:16000';
/**
 * 只从环境变量读 token，**不要**再写死默认值。
 *
 * 这个文件在公开仓库里：写死的 token 等于把 SnowLuma 的 OneBot 接口直接公开，
 * 谁拿到都能以机器人身份发消息。需要运行时先设环境变量：
 *   PowerShell: $env:ONEBOT_TOKEN='...'; node tools/make-sheets.mjs
 */
const TOKEN = process.env.ONEBOT_TOKEN ?? '';
if (!TOKEN) {
  throw new Error('缺少 ONEBOT_TOKEN 环境变量（需与 SnowLuma HTTP server 的 accessToken 一致）');
}
const OUT = path.join(process.cwd(), 'cache');

const COLS = 8;
const CELL = 170;
const LABEL = 24;
const PAD = 6;
const PER_PAGE = 40;

async function fetchUrls() {
  const res = await fetch(`${BASE}/fetch_custom_face`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ count: 300 }),
  });
  const json = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function buildPage(urls, page) {
  const perPage = PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(urls.length / perPage));
  const start = (page - 1) * perPage;
  const slice = urls.slice(start, start + perPage);

  const raws = await Promise.all(
    slice.map(async (u) => {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        return Buffer.from(await r.arrayBuffer());
      } catch {
        return null;
      }
    }),
  );

  const rows = Math.max(1, Math.ceil(slice.length / COLS));
  const width = COLS * (CELL + PAD) + PAD;
  const height = rows * (CELL + LABEL + PAD) + PAD;
  const composites = [];

  for (let i = 0; i < slice.length; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PAD + col * (CELL + PAD);
    const y = PAD + row * (CELL + LABEL + PAD);
    const num = start + i + 1;

    if (raws[i]) {
      try {
        const thumb = await sharp(raws[i])
          .resize(CELL, CELL, { fit: 'contain', background: { r: 48, g: 48, b: 54, alpha: 1 } })
          .png()
          .toBuffer();
        composites.push({ input: thumb, left: x, top: y });
      } catch {
        /* 解码失败只画编号 */
      }
    }
    composites.push({
      input: Buffer.from(
        `<svg width="${CELL}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect width="${CELL}" height="${LABEL}" fill="#0f0f12"/>` +
          `<text x="4" y="17" font-family="Consolas,monospace" font-size="15" fill="#e6e6eb">#${num}</text></svg>`,
      ),
      left: x,
      top: y + CELL,
    });
  }

  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 28, g: 28, b: 32 } } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();

  const file = path.join(OUT, `sheet-${page}.png`);
  fs.writeFileSync(file, buf);
  return { file, page, totalPages, from: start + 1, to: start + slice.length };
}

fs.mkdirSync(OUT, { recursive: true });
const urls = await fetchUrls();
console.log(`收藏表情 ${urls.length} 张`);
const totalPages = Math.max(1, Math.ceil(urls.length / PER_PAGE));
for (let p = 1; p <= totalPages; p += 1) {
  const info = await buildPage(urls, p);
  console.log(`  第 ${info.page}/${info.totalPages} 页  #${info.from}~#${info.to}  → ${info.file}`);
}
fs.writeFileSync(path.join(OUT, 'urls.json'), JSON.stringify(urls, null, 2));
console.log('URL 列表已存 cache/urls.json');
