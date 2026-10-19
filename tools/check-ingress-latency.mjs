/**
 * 只读诊断：一条 QQ 消息进 DSH 之前到底等了多久、等在哪一步。
 *
 * 为什么要单独有这个工具：status 的 taskScheduler.latency 只给分位数，
 * 看不出"某个会话是不是每条消息都在白等"。这里按路由结局分组，
 * 把「固定合并窗口」和「路由模型跑满超时」分开 —— 两者的修法完全不同
 * （调 inputShortDebounceMs vs 调 taskRouteTimeoutMs／关掉路由）。
 *
 * 用法：node tools/check-ingress-latency.mjs
 * 只读打开 SQLite，不写库、不发消息。
 */
import { DatabaseSync } from 'node:sqlite';
import { resolveBridgeDb } from './db-path.mjs';

const file = resolveBridgeDb();
if (!file) {
  console.error('找不到桥接数据库；可用 QQ_BRIDGE_DB 显式指定。');
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const all = (sql, ...args) => db.prepare(sql).all(...args);
const pct = (xs, p) => xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null;
const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + 's');

console.log('库：' + file + '\n');

const rows = all('SELECT conversation,data FROM bridge_executions ORDER BY created_at DESC LIMIT 300')
  .flatMap((r) => { try { return [{ conversation: r.conversation, d: JSON.parse(r.data) }]; } catch { return []; } })
  .filter((r) => Number.isFinite(r.d.times?.received) && Number.isFinite(r.d.times?.routed));

const kind = (reason) => /fallback|unavailable/.test(reason ?? '') ? '路由失败（结论被丢弃）'
  : /independent-input/.test(reason ?? '') ? '未进模型（本地判定）' : '模型成功判定';

console.log('=== received→routed（QQ 消息到达 → DSH 回合已入队）按结局分组 ===');
const groups = new Map();
for (const r of rows) {
  const k = kind(r.d.route?.reason);
  (groups.get(k) ?? groups.set(k, []).get(k)).push(r.d.times.routed - r.d.times.received);
}
for (const [k, xs] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  const sorted = [...xs].sort((a, b) => a - b);
  console.log(k.padEnd(22), 'n=' + String(sorted.length).padEnd(4),
    'p50=' + secs(pct(sorted, 0.5)).padEnd(7), 'p95=' + secs(pct(sorted, 0.95)));
}
console.log('\n上表「未进模型」那一行的 p50 ≈ inputShortDebounceMs；');
console.log('「路由失败」减去它，就是每条消息为无效路由白等的时间。\n');

console.log('=== 按会话：路由失败率（白等的比例） ===');
const byConv = new Map();
for (const r of rows) {
  const e = byConv.get(r.conversation) ?? byConv.set(r.conversation, { n: 0, fb: 0, ms: [] }).get(r.conversation);
  e.n++;
  if (/fallback|unavailable/.test(r.d.route?.reason ?? '')) e.fb++;
  e.ms.push(r.d.times.routed - r.d.times.received);
}
for (const [c, e] of [...byConv].sort((a, b) => b[1].n - a[1].n))
  console.log(String(c).padEnd(20), 'n=' + String(e.n).padEnd(4), '失败率=' + String(Math.round((e.fb / e.n) * 100) + '%').padEnd(5),
    'p50=' + secs(pct([...e.ms].sort((a, b) => a - b), 0.5)));

console.log('\n=== 路由失败原因分布（fallbackCause，由本次改动开始记录） ===');
const causes = all("SELECT json_extract(data,'$.fallbackCause') cause,COUNT(*) n FROM bridge_routes WHERE json_extract(data,'$.fallbackCause') IS NOT NULL GROUP BY cause ORDER BY n DESC");
if (!causes.length) console.log('（暂无记录：改动之后还没出现路由失败）');
for (const c of causes) console.log(String(c.cause).padEnd(16), c.n);
const last = all("SELECT data FROM bridge_routes WHERE json_extract(data,'$.fallbackCause') IS NOT NULL ORDER BY id DESC LIMIT 1")[0];
if (last) { const d = JSON.parse(last.data); console.log('最近一次：' + d.fallbackCause + ' — ' + d.fallbackDetail); }
console.log('\n原因对照：timeout=跑满 taskRouteTimeoutMs；stream-error=模型流报错；');
console.log('invalid-json/invalid-verdict=模型答了但没通过校验；unavailable=没接上模型。\n');

console.log('=== 实测合并窗口（消息到达→派发） ===');
for (const r of all("SELECT key,value FROM runtime_state WHERE key LIKE 'qq-bridge:input:%'")) {
  let s; try { s = JSON.parse(r.value); } catch { continue; }
  if (s?.lastDispatch?.at && s?.lastAt) console.log(r.key.replace('qq-bridge:input:', '').padEnd(20), secs(s.lastDispatch.at - s.lastAt));
}

console.log('\n=== 卡住的执行（阻塞 pump 的 task_id） ===');
const stuck = all("SELECT state,conversation,COUNT(*) n,MIN(updated_at) oldest FROM bridge_executions WHERE state IN ('recovering','needs_attention','waiting_input') GROUP BY state,conversation");
if (!stuck.length) console.log('（无）');
for (const s of stuck) console.log(String(s.state).padEnd(16), String(s.conversation).padEnd(20), 'n=' + s.n, '最旧 ' + ((Date.now() - Number(s.oldest)) / 86400000).toFixed(1) + ' 天');
