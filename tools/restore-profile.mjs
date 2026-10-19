/**
 * restore-profile.mjs —— 把被崩溃截断的 profile 配置恢复回来。
 *
 *   node tools/restore-profile.mjs <当前文件> <备份文件> <输出文件>
 *
 * 做法是**结构化合并**，不是简单覆盖：
 *   · 以备份为骨架（它有 qq-bridge / mcp-* / hmr / llm-pi-ai 这些丢失的段）；
 *   · 当前文件里存在的同名条目**覆盖**备份里的版本 ——
 *     因为崩溃之后你可能又在界面上改过设置，那些改动不能丢；
 *   · 备份里独有的条目原样保留；
 *   · 当前文件里有、备份里没有的条目（比如 ui-settings-general）追加到末尾。
 *
 * 之所以不直接 copy，是因为当前文件比备份"新"的那部分改动往往正是
 * 崩溃后你手工做的（比如重新走了一遍设置向导）。
 */

import fs from 'node:fs';

const [currentPath, backupPath, outPath] = process.argv.slice(2);
if (!currentPath || !backupPath || !outPath) {
  console.error('用法: node tools/restore-profile.mjs <当前> <备份> <输出>');
  process.exit(1);
}

const currentText = fs.readFileSync(currentPath, 'utf8');
const backupText = fs.readFileSync(backupPath, 'utf8');

/**
 * 把 patch 文件切成「文件头注释」+「若干条目块」。
 *
 * 条目以行首的 `- ` 开头；块一直延伸到下一个行首 `- ` 之前。
 * 这样天然支持 `- insert:` 这种自带子条目的块，不必真的解析 YAML
 * （profile 里允许 `!!js` 表达式，用 YAML 解析器反而有风险）。
 */
function splitEntries(text) {
  const lines = text.split(/\r?\n/);
  let header = [];
  let i = 0;
  while (i < lines.length && !/^- /.test(lines[i])) {
    header.push(lines[i]);
    i += 1;
  }
  const blocks = [];
  let cur = null;
  for (; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) {
      if (cur) blocks.push(cur);
      cur = [lines[i]];
    } else if (cur) {
      cur.push(lines[i]);
    }
  }
  if (cur) blocks.push(cur);
  return { header: header.join('\n'), blocks };
}

/** 取出一个条目块的 id。顶层 `- id: x` 或 `- insert:` 里的 `- id: x`。 */
function entryId(block) {
  const text = block.join('\n');
  const top = text.match(/^- id:\s*(\S+)/m);
  if (top) return top[1];
  const nested = text.match(/^\s+- id:\s*(\S+)/m);
  if (nested) return nested[1];
  return null;
}

/** 去掉块尾因为文件结束而多出来的空行。 */
function trimBlock(block) {
  const copy = [...block];
  while (copy.length && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

const backup = splitEntries(backupText);
const current = splitEntries(currentText);

const currentById = new Map();
for (const block of current.blocks) {
  const id = entryId(block);
  if (id) currentById.set(id, trimBlock(block));
}

const usedFromCurrent = new Set();
const merged = [];

for (const block of backup.blocks) {
  const id = entryId(block);
  // 同名条目以当前文件为准（崩溃后你可能改过）
  if (id && currentById.has(id)) {
    merged.push(currentById.get(id));
    usedFromCurrent.add(id);
  } else {
    merged.push(trimBlock(block));
  }
}

// 当前文件里有、备份里没有的条目，追加到末尾
for (const block of current.blocks) {
  const id = entryId(block);
  if (id && !usedFromCurrent.has(id)) {
    merged.push(trimBlock(block));
    usedFromCurrent.add(id);
  }
}

const header = backup.header.trimEnd() || current.header.trimEnd();
const output = `${header}\n\n${merged.map((b) => b.join('\n')).join('\n\n')}\n`;

fs.writeFileSync(outPath, output, 'utf8');

// 把合并结果说清楚，方便人工核对
const backupIds = backup.blocks.map(entryId).filter(Boolean);
const currentIds = current.blocks.map(entryId).filter(Boolean);
console.log('备份条目 :', backupIds.join(', '));
console.log('当前条目 :', currentIds.join(', '));
console.log('采用当前 :', [...usedFromCurrent].filter((id) => backupIds.includes(id)).join(', ') || '(无)');
console.log('仅当前有 :', currentIds.filter((id) => !backupIds.includes(id)).join(', ') || '(无)');
console.log('输出条目 :', merged.map(entryId).filter(Boolean).join(', '));
console.log('输出字节 :', Buffer.byteLength(output, 'utf8'));
