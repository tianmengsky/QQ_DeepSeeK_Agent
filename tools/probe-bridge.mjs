/**
 * 探针：往桥接端口发一条**合成 QQ 消息**，看它有没有被接住、走到哪一步。
 *
 * 用不在白名单里的 QQ 号，这样 shouldRespond 会拦下它 ——
 * 既验证链路通不通，又不会真的花一次模型调用。
 *
 *   node tools/probe-bridge.mjs
 */
const BASE = process.env.QQ_BRIDGE ?? 'http://127.0.0.1:19387/qq/onebot';

async function status() {
  const r = await fetch(BASE, { method: 'GET' });
  return r.json();
}

function pretty(label, obj) {
  console.log(`\n── ${label}`);
  console.log(JSON.stringify(obj, null, 2).slice(0, 1400));
}

console.log('=== 1) 发送前的计数 ===');
const before = await status();
console.log('  ok =', before.ok, ' 托管 =', before.agentEnabled);
console.log('  stats.posts =', before.stats?.posts, ' accepted =', before.stats?.accepted, ' filtered =', before.stats?.filtered);
console.log('  stage =', before.stats?.stage, ' lastError =', before.stats?.lastError);
console.log('  白名单群 =', JSON.stringify(before.groups ?? before.stats?.groups ?? null));

console.log('\n=== 2) 发一条合成群消息（发送者不在白名单）===');
const event = {
  post_type: 'message',
  message_type: 'group',
  sub_type: 'normal',
  time: Math.floor(Date.now() / 1000),
  self_id: before.selfId ?? 0,
  group_id: 999001,
  user_id: 999000001,
  message_id: 999999001,
  raw_message: '探针测试',
  message: [{ type: 'text', data: { text: '【探针】这是一条合成消息' } }],
  sender: { user_id: 999000001, nickname: '探针' },
};
const res = await fetch(BASE, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(event),
});
console.log('  HTTP', res.status, await res.text());

console.log('\n=== 3) 发送后的计数 ===');
await new Promise((r) => setTimeout(r, 500));
const after = await status();
console.log('  stats.posts    ', before.stats?.posts, '→', after.stats?.posts);
console.log('  stats.accepted ', before.stats?.accepted, '→', after.stats?.accepted);
console.log('  stats.filtered ', before.stats?.filtered, '→', after.stats?.filtered);
console.log('  stats.skippedDisabled', before.stats?.skippedDisabled, '→', after.stats?.skippedDisabled);
console.log('  stage =', after.stats?.stage);
console.log('  lastError =', after.stats?.lastError);
console.log('  事件分类 =', JSON.stringify(after.stats?.事件分类 ?? null));

if ((after.stats?.posts ?? 0) > (before.stats?.posts ?? 0)) {
  console.log('\n✅ 入站链路通：桥接收到了消息');
} else {
  console.log('\n❌ 入站链路断了：桥接没收到这条消息（问题在 SnowLuma 或端口，不在逻辑）');
}
