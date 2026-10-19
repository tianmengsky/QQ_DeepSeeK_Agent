/**
 * 把 lib/index.js 里 Config schema 的默认值打出来 —— 写文档时用来核对，
 * 免得凭记忆写错。
 *
 *   node tools/dump-config-defaults.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync('D:/Code/dsh-qq-bridge/lib/index.js', 'utf8');

const keys = process.argv.slice(2);
const all = !keys.length;

const re = /^\s*([A-Za-z_$][\w$]*):\s*(.+?),?\s*$/gm;
const out = [];
for (const m of src.matchAll(re)) {
  const [, name, val] = m;
  if (!val) continue;
  if (!all && !keys.includes(name)) continue;
  out.push([name, val.trim().replace(/,$/, '')]);
}

out.sort((a, b) => a[0].localeCompare(b[0]));
console.log(`共 ${out.length} 个字段\n`);
for (const [k, v] of out) {
  console.log(`  ${k.padEnd(32)} ${v.length > 70 ? `${v.slice(0, 70)}…` : v}`);
}
