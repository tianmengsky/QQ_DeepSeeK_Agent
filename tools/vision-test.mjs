/**
 * 视觉通路测试
 *
 * 分层验证"Agent 到底能不能看图"：
 *   第 1 层  直连 API —— 这个模型本身支不支持图片输入？
 *   第 2 层  DSH 调用 —— 桥接把图附进去之后，模型收到的是什么？
 *
 * 用法：
 *   cd D:\Code\dsh-qq-bridge
 *   node tools/vision-test.mjs                 # 测默认的候选模型
 *   node tools/vision-test.mjs --model xxx     # 测指定模型
 */

import fs from 'node:fs';
import path from 'node:path';

const CREDS = 'C:\\Users\\30481\\.dsh\\.credentials.yaml';
const IMAGE = process.argv.includes('--image')
  ? process.argv[process.argv.indexOf('--image') + 1]
  : 'D:\\Code\\dsh-qq-bridge\\tools\\vision-test.png';

const argv = process.argv.slice(2);
const modelArg = argv.indexOf('--model') >= 0 ? argv[argv.indexOf('--model') + 1] : null;

const BASE = 'https://api.a6api.com/v1';
const CANDIDATES = modelArg
  ? [modelArg]
  : ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash'];

/** 从 .credentials.yaml 里抠出 key（不打印出来）。 */
function readKey() {
  const text = fs.readFileSync(CREDS, 'utf8');
  const m = text.match(/A6API_API_KEY:\s*['"]?([^'"\r\n]+)['"]?/);
  if (!m) throw new Error('在 .credentials.yaml 里找不到 A6API_API_KEY');
  return m[1].trim();
}

const QUESTION = '这张图里写了什么字？画了什么形状？用中文简短回答。';

async function askVision(key, model, imageB64, mediaType) {
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: QUESTION },
          {
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${imageB64}` },
          },
        ],
      },
    ],
    max_tokens: 200,
  };

  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, note: `HTTP ${res.status} 非 JSON: ${text.slice(0, 200)}` };
  }
  if (json.error) {
    return { ok: false, note: `HTTP ${res.status} 报错: ${JSON.stringify(json.error).slice(0, 200)}` };
  }
  const content = json.choices?.[0]?.message?.content ?? '';
  return { ok: true, content: String(content).trim(), usage: json.usage };
}

/** 对照组：只发文字，不发图。看它会不会"没看到图也硬答"。 */
async function askTextOnly(key, model) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: QUESTION }],
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  return String(json.choices?.[0]?.message?.content ?? json.error?.message ?? '').trim();
}

const key = readKey();
const buf = fs.readFileSync(IMAGE);
const mediaType = IMAGE.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const b64 = buf.toString('base64');

console.log('============================================================');
console.log('  视觉通路测试（第 1 层：直连 API）');
console.log('============================================================');
console.log('');
console.log(`  测试图 : ${path.basename(IMAGE)}  (${buf.length} 字节, ${mediaType})`);
console.log(`  头字节 : ${[...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log(`  问的是 : ${QUESTION}`);
console.log('');

for (const model of CANDIDATES) {
  console.log('------------------------------------------------------------');
  console.log(`  模型: ${model}`);
  console.log('------------------------------------------------------------');

  // 先看只发文字会怎样 —— 如果它连"没图"都能编出内容，那答对也不可信
  try {
    const noImg = await askTextOnly(key, model);
    console.log(`  [不附图] 它答: ${noImg.slice(0, 120).replace(/\n/g, ' ')}`);
  } catch (error) {
    console.log(`  [不附图] 失败: ${error.message}`);
  }

  try {
    const r = await askVision(key, model, b64, mediaType);
    if (!r.ok) {
      console.log(`  [附图]   ✗ ${r.note}`);
    } else {
      const hit42 = /42/.test(r.content);
      const hitHello = /hello/i.test(r.content);
      const hitRed = /红|red/i.test(r.content);
      const hitCircle = /圆|circle/i.test(r.content);
      const score = [hit42, hitHello, hitRed, hitCircle].filter(Boolean).length;
      console.log(`  [附图]   它答: ${r.content.replace(/\n/g, ' ').slice(0, 160)}`);
      console.log('');
      console.log(
        `  命中要素: ${[
          hitHello ? 'HELLO ✓' : 'HELLO ✗',
          hit42 ? '42 ✓' : '42 ✗',
          hitRed ? '红 ✓' : '红 ✗',
          hitCircle ? '圆 ✓' : '圆 ✗',
        ].join('  ')}   (${score}/4)`,
      );
      console.log(
        score >= 2
          ? '  → 判断：这个模型**能**看图'
          : '  → 判断：这个模型**看不了**图（答不出图里内容）',
      );
    }
  } catch (error) {
    console.log(`  [附图]   ✗ 请求失败: ${error.message}`);
  }
  console.log('');
}

console.log('============================================================');
console.log('  怎么解读：');
console.log('    · 两个模型都答不出 → 是"供应商/协议"层的问题，换 api 协议试试');
console.log('    · 新旧模型差别明显 → 就是模型能力问题，得用带 vision 的那个');
console.log('    · 但[不附图]也能答对 → 它在编，不能作为能力证据');
console.log('============================================================');
