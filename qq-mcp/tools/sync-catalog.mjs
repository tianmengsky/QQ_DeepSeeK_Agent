/**
 * 给表情文字目录补「身份键」（catalog.json 每行的 key）。
 *
 * 为什么需要：编号只是目录里的名字。QQ 的收藏列表顺序会翻（2026-10-19 实测
 * 整份倒序），按位置取第 N 个就会发出镜像位置那张图。目录每行带上
 * 这张表情自己的哈希之后，`qq_send_custom_face 73` 才始终是 #73 那张。
 *
 * 用法:
 *   1. node tools/make-sheets.mjs          # 重新导出总览图 + cache/urls.json
 *   2. （人工/子代理）照图标注 cache/catalog.json 的 desc
 *   3. node tools/sync-catalog.mjs         # 本脚本：按 n 把身份键写进去
 *
 * 前提：第 2 步的编号必须与第 1 步那张总览图一致（#1 = urls.json 的第 1 条）。
 * 已有 key 的行不会覆盖 —— 那张图已经钉住了，翻页/重排都不改它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { faceKeyOf } from '../../lib/domain/stickers.mjs';

const CACHE = path.join(process.cwd(), 'cache');
const CATALOG = path.join(CACHE, 'catalog.json');
const URLS = path.join(CACHE, 'urls.json');

if (!fs.existsSync(CATALOG)) {
  console.error(`没有目录：${CATALOG}`);
  process.exit(1);
}
if (!fs.existsSync(URLS)) {
  console.error(`没有这次导出的顺序：${URLS}\n先跑 node tools/make-sheets.mjs。`);
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const urls = JSON.parse(fs.readFileSync(URLS, 'utf8'));
if (!Array.isArray(catalog) || !Array.isArray(urls)) {
  console.error('catalog.json / urls.json 必须是数组。');
  process.exit(1);
}

let written = 0;
const missing = [];
for (const row of catalog) {
  const n = Number(row?.n);
  if (!Number.isInteger(n) || typeof row?.desc !== 'string') continue;
  if (typeof row.key === 'string' && row.key.trim()) continue;
  const url = urls[n - 1];
  const key = faceKeyOf(url);
  if (!key || !url) {
    missing.push(n);
    continue;
  }
  row.key = key;
  written += 1;
}

fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(`目录 ${catalog.length} 行，补上身份键 ${written} 行。`);
if (missing.length) {
  console.log(`⚠ 这些编号在 urls.json 里没有对应图片（编号可能越界）：${missing.join('、')}`);
  console.log('  重新跑 tools/make-sheets.mjs 后再标注一遍。');
}
