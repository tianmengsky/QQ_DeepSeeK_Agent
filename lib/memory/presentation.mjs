/** 按条目和当前问题排序，元数据不占用有限的人物记忆预算。 */
export function compactPersonMemory(text, max, query = '') {
  if (text.length <= max) return text;
  const header = text.split('\n')[0].slice(0, 100);
  const tokens = String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const sections = [], seen = new Set();
  let heading = '', order = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) heading = line;
    if (!/^-\s+\S/u.test(line)) continue;
    const clean = line.replace(/（属性 [^）]*）$/u, '').trim();
    if (seen.has(clean)) continue;
    seen.add(clean);
    const priority = line.includes('[明确记忆]') ? 0
      : line.includes('[个人资料]') || /手工记忆|^## 记忆$/u.test(heading) ? 1
      : /自动记忆/u.test(heading) ? 2 : line.includes('[主观印象') ? 3 : 4;
    sections.push({ line: clean, priority, match: tokens.some((t) => clean.toLowerCase().includes(t)), order: order++ });
  }
  sections.sort((a, b) => Number(a.priority !== 0) - Number(b.priority !== 0) ||
    Number(b.match) - Number(a.match) || a.priority - b.priority || b.order - a.order);
  const prefix = header + '\n（节选；完整资料和版本可用 qq_memory read 查询）';
  const rows = [], room = max - prefix.length;
  let used = 0;
  for (const entry of sections) {
    if (used + entry.line.length + 1 > room) continue;
    rows.push(entry.line); used += entry.line.length + 1;
  }
  return prefix + (rows.length ? '\n' + rows.join('\n') : '');
}
