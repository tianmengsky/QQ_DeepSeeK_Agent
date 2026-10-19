/**
 * 统计"她到底多常配表情"：收藏表情条数 / 全部发言条数，按天看。
 *
 * 为什么要有这个：表情使用率只能从真实发言里量。2026-10-19 排查时发现它从
 * 20.7%（10-11）掉到 1.6%（10-19），而当时没有任何读数能直接看到这件事——
 * 只能事后翻 outbox。调完提示词就用这条命令看趋势，别凭感觉。
 *
 * 用法: node tools/sticker-rate.mjs [天数]
 * 读 data/qq-bridge.sqlite3（只读），不发消息、不改库。
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const dbFile = process.env.QQ_BRIDGE_DB
  ?? path.join(import.meta.dirname, '..', 'data', 'qq-bridge.sqlite3');
const days = Math.max(1, Number(process.argv[2]) || 14);

const db = new DatabaseSync(dbFile, { readOnly: true });
const rows = db.prepare(
  "select created_at, payload from outbox where kind in ('send_group_msg','send_private_msg') and status = 'SUCCEEDED'",
).all();

/** 收藏表情走 qpic 表情链接；本机表情包是 file:// 或图库，不算在内。 */
const isFavorite = (payload) => String(payload ?? '').includes('p.qpic.cn/qq_expression');
const isImage = (payload) => String(payload ?? '').includes('"type":"image"');

const byDay = new Map();
let text = 0;
let sticker = 0;
for (const row of rows) {
  const payload = row.payload;
  const favorite = isFavorite(payload);
  if (isImage(payload) && !favorite) continue; // 普通图片/表情包不算
  const at = Number(row.created_at);
  if (!Number.isFinite(at)) continue;
  const day = new Date(at).toISOString().slice(0, 10);
  const slot = byDay.get(day) ?? { text: 0, sticker: 0 };
  if (favorite) {
    sticker += 1;
    slot.sticker += 1;
  } else {
    text += 1;
    slot.text += 1;
  }
  byDay.set(day, slot);
}

const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) + '%' : '—');
console.log(`库里成功发送 ${text + sticker} 条：文字 ${text}，收藏表情 ${sticker}（${pct(sticker, text + sticker)}）`);
console.log('');
console.log('日期        文字   表情   表情占比');
for (const [day, slot] of [...byDay.entries()].sort().slice(-days)) {
  const total = slot.text + slot.sticker;
  console.log(`${day}  ${String(slot.text).padStart(4)}  ${String(slot.sticker).padStart(4)}   ${pct(slot.sticker, total)}`);
}
