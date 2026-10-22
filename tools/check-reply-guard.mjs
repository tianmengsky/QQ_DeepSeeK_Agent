/**
 * 只读诊断：参与决策的**硬护栏覆盖率**。
 *
 * 为什么需要它：`replyDecisionEnabled` 打开后，唯一会"把一条消息判成不回"的地方就是
 * 参与决策。它最危险的失效方式是把**真的在让她做事**的消息判成沉默（用户会觉得"她装死"），
 * 而 `observeWithoutReply` 只把消息塞进心跳缓冲（间隔 10 分钟）。
 *
 * 所以护栏的覆盖面必须能对着真实消息核，而不是靠猜。本工具用
 * `reply-decision.mjs` 里那一份正则（单一真源）跑历史触发消息，报三档：
 *   ① 请求型 → 直接回，不付决策的 2.5 秒
 *   ② 空/纯语气 → 本地一眼可判
 *   ③ 会真的去问决策模型（付 2.5 秒）
 * 并把 ③ 的实例列出来，人工确认里面没有"明显在要她做事却被送去判沉默"的。
 *
 * 用法：node tools/check-reply-guard.mjs [条数]
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';
import { REQUEST_SHAPED } from '../lib/application/reply-decision.mjs';

const file = resolveBridgeDb();
if (!file) { console.error('找不到桥接数据库；可用 QQ_BRIDGE_DB 显式指定。'); process.exit(1); }
const db = new DatabaseSync(file, { readOnly: true });
const LIMIT = Number(process.argv[2] ?? 20);

const textOf = (e) => (Array.isArray(e.message)
  ? e.message.filter((p) => p?.type === 'text').map((p) => p.data?.text ?? '').join('').trim()
  : String(e.message ?? '').trim());
const PHATIC = /^(?:[？?！!。,.、~～\s]*|[哈呵嘿草6６靠额emmo…]+|[？?！!]{2,}|在吗|在不在|好的?|收到|谢谢|笑死|牛逼|我去|专业|强|牛|6+)$/u;

const work = db.prepare('SELECT data FROM bridge_executions').all().flatMap((r) => {
  let d; try { d = JSON.parse(r.data); } catch { return []; }
  if (d.detached || d.readOnly) return [];
  return (d.inputEvents ?? []).filter((x) => !x.__inputPassive).map((x) => ({
    at: Number(x.__receivedAt ?? NaN),
    hasAt: Array.isArray(x.message) && x.message.some((p) => p?.type === 'at'),
    text: textOf(x) }));
}).filter((x) => Number.isFinite(x.at));

let guard = 0, longAsk = 0, phatic = 0; const consult = [];
for (const w of work) {
  const body = w.text.replace(/^[@＠]\s*/u, '').trim();
  if (REQUEST_SHAPED.test(body)) { guard++; continue; }
  if (body.length >= 12 && /[？?]|吗|什么|哪|谁|多少|几点/u.test(body)) { longAsk++; continue; }
  if (!body.replace(/\s/g, '') || PHATIC.test(body.replace(/^[@＠]\s*/u, '').replace(/\s/g, ''))) { phatic++; continue; }
  consult.push(w);
}
const total = work.length || 1;
const pct = (n) => `${n}  ${((n / total) * 100).toFixed(0)}%`;
console.log(`库：${file}`);
console.log(`真实非只读触发输入 ${work.length} 条\n`);
console.log(`  ① 请求型护栏直接放行        ${pct(guard)}`);
console.log(`  ② 长问句直接放行            ${pct(longAsk)}`);
console.log(`  ③ 空/纯语气（本地可判）      ${pct(phatic)}`);
console.log(`  ④ **会去问决策模型（付 2.5s）** ${pct(consult.length)}`);
console.log('\n→ ①+② 是"不付决策代价"的部分；④ 才是新增延迟与"装死"风险的来源。');

console.log(`\n=== ④ 的实例（前 ${LIMIT} 条；请人工确认里面没有"明显在要她做事"的） ===`);
for (const w of consult.slice(0, LIMIT))
  console.log(`  @=${w.hasAt ? 'Y' : 'n'}  「${w.text.slice(0, 44)}」`);
