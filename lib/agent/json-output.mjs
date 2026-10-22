/**
 * 辅助模型 JSON 输出的宽容解析。
 *
 * 为什么需要：路由/参与决策这类调用曾把整次裁决判成 `invalid-json`，而实际正文
 * 往往只是多了一句“好的，我的判断是：”或者包了 ```json 围栏。严格 `JSON.parse`
 * 把这类**可用**的输出整条丢掉，代价是回退成 new（路由）或 fail-open（决策），
 * 既慢又不准。
 *
 * 解析顺序（从严到宽）：
 *   1. 原文直接 parse（绝大多数情况走这条，零成本）；
 *   2. 去 BOM / 代码围栏后再 parse；
 *   3. 从第一个 `{` 或 `[` 起按**括号配对**截出完整值（字符串内的括号与转义不计数），
 *      再 parse。
 *
 * 仍然解析不出来才抛 SyntaxError —— 调用方现有的失败归因不需要改。
 * 不猜、不补字段：只负责“把模型写的那段 JSON 找出来”。
 */

/** 去掉 ```json ... ``` 围栏；没有围栏时原样返回。 */
function unfence(text) {
  const match = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  return match ? match[1].trim() : null;
}

/**
 * 从任意文本里截出第一个完整的 JSON 对象/数组。
 *
 * 括号配对而不是正则：正文里出现 `{"reason":"他说{好}"}` 时，正则会在字符串内的
 * 花括号上提前收尾，解析必然失败。
 */
export function sliceFirstJsonValue(text) {
  const source = String(text ?? '');
  const start = source.search(/[{[]/u);
  if (start < 0) return null;
  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 宽容解析模型输出。
 *
 * @returns {object|Array} 解析结果
 * @throws {SyntaxError} 实在找不到合法 JSON 时抛出（与 JSON.parse 语义一致）
 */
export function parseJsonLoose(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/u, '').trim();
  if (!text) throw new SyntaxError('empty json');
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试更宽的路径 */
  }
  const inner = unfence(text);
  for (const candidate of inner ? [inner, text] : [text]) {
    const sliced = sliceFirstJsonValue(candidate);
    if (sliced == null) continue;
    try {
      return JSON.parse(sliced);
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new SyntaxError('unparsable json');
}
