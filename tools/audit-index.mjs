/**
 * 给 lib/index.js 做结构体检：列出顶层声明、它们的位置和行数，
 * 以及每个声明依赖了哪些外部符号 —— 拆分前必须先有这张图。
 *   node tools/audit-index.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync('D:/Code/dsh-qq-bridge/lib/index.js', 'utf8');
const lines = src.split('\n');

console.log(`lib/index.js: ${lines.length} 行\n`);

/** 顶层声明（无缩进的 function / class / const）。 */
const decls = [];
for (let i = 0; i < lines.length; i += 1) {
  const l = lines[i];
  const m =
    l.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/) ||
    l.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/) ||
    l.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/) ||
    l.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*z\./);
  if (m) decls.push({ name: m[1], line: i + 1 });
}

// 算每个声明的结束行（下一个顶层声明之前）
for (let i = 0; i < decls.length; i += 1) {
  decls[i].end = i + 1 < decls.length ? decls[i + 1].line - 1 : lines.length;
  decls[i].len = decls[i].end - decls[i].line + 1;
}

console.log('顶层声明（按位置，含行数）：');
let total = 0;
for (const d of decls) {
  total += d.len;
  console.log(`  L${String(d.line).padStart(4)}  ${String(d.len).padStart(4)}行  ${d.name}`);
}
console.log(`\n顶层声明合计 ${total} 行 / 全文 ${lines.length} 行`);

console.log('\n=== 外部依赖（import / require）===');
for (const [i, l] of lines.entries()) {
  if (/^import\s|createRequire|require\(/.test(l)) console.log(`  L${i + 1}: ${l.trim()}`);
}

/** 粗算每个声明体里引用到的顶层名字，用来判断模块边界。 */
const names = new Set(decls.map((d) => d.name));
console.log('\n=== 关键声明的引用关系（引用到的顶层名字）===');
const KEY = [
  'onebotCall',
  'sendOnebotIdempotent',
  'buildPrompt',
  'buildPromptContent',
  'buildWindowSection',
  'buildMemorySection',
  'deliverReply',
  'runTurn',
  'handlePokeNotice',
  'handleAddRequest',
  'handleReactionNotice',
  'resolvePersona',
  'resolveBehavior',
  'resolveExamples',
  'renderMessage',
  'loadImagePart',
  'createHandler',
  'apply',
  'MemoryStore',
  'ConversationRegistry',
];
for (const d of decls) {
  if (!KEY.includes(d.name)) continue;
  const body = lines.slice(d.line - 1, d.end).join('\n');
  const used = [...names].filter(
    (n) => n !== d.name && new RegExp(`\\b${n}\\b`).test(body),
  );
  console.log(`  ${d.name} → ${used.join(', ') || '(无)'}`);
}
