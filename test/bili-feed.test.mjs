// bili-feed —— 主动层"刷B站"那一侧的取数。
//
// 这里钉的是**请求形状**而不是文案：2026-10-31 线上第一次真跑就撞上
// code=-352（风控校验失败），根因是 UA 写成了残缺的
// `AppleWebKit/537.36 Chrome/126 Safari/537.36`。少了 "(KHTML, like Gecko)"
// 与完整版本号，B站 100% 拒绝；完整的 Chrome UA 就返回 100 条。
// 所以这条测试盯着"请求里带的 UA 像不像真浏览器"，而不是某个具体字符串。

import assert from 'node:assert/strict';

import { fetchBiliRanking, biliShortlist, biliShareText } from '../lib/application/bili-feed.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`\nnot ok ${name}`);
    console.log(error?.stack ?? error);
  }
}

/** 一次假响应：把 fetch 收到的 init 记下来，方便断言请求形状。 */
function fakeFetch(payload, { status = 200, seen = [] } = {}) {
  return async (url, init) => {
    seen.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
}

const SAMPLE = [
  { bvid: 'BV1xx411c7mD', title: '鲸鱼为什么唱歌', duration: 300, stat: { view: 500000 }, owner: { name: '海洋台' }, tname: '动物', desc: '一段描述' },
  { bvid: 'BV1yy411c7mE', title: '三分钟学会做饭', duration: 180, stat: { view: 30000 }, owner: { name: '厨房' }, tname: '美食', desc: '' },
  { bvid: 'BV1zz411c7mF', title: '课程：从零开始', duration: 600, stat: { view: 900000 }, owner: { name: '网校' }, tname: '知识', desc: '' },
];

await test('请求带真浏览器 UA 与 referer（缺了会被 B站风控判 -352）', async () => {
  const seen = [];
  await fetchBiliRanking({ fetchImpl: fakeFetch({ code: 0, data: { list: SAMPLE } }, { seen }) });
  assert.equal(seen.length, 1);
  const headers = seen[0].init.headers;
  const ua = headers['user-agent'];
  assert.match(ua, /\(KHTML, like Gecko\)/u, 'UA 必须像真 Chrome，否则 -352');
  assert.match(ua, /Chrome\/\d+\.\d+\.\d+\.\d+/u);
  assert.equal(headers.referer, 'https://www.bilibili.com/');
  assert.match(seen[0].url, /ranking\/v2\?rid=0&type=all$/u);
});

await test('非 0 code / 非 2xx / 空列表都返回空结果而不是抛出', async () => {
  const risky = await fetchBiliRanking({ fetchImpl: fakeFetch({ code: -352, message: '-352' }) });
  assert.deepEqual(risky.items, []);
  assert.equal(risky.reason, 'code--352');

  const broken = await fetchBiliRanking({ fetchImpl: fakeFetch({}, { status: 503 }) });
  assert.equal(broken.reason, 'http-503');

  const missing = await fetchBiliRanking({ fetchImpl: fakeFetch({ code: 0, data: { list: [] } }) });
  assert.equal(missing.reason, 'empty');
});

await test('短名单：去掉广告/课程与已分享，关键词加分，取够 count 条', async () => {
  const items = SAMPLE.map((raw) => ({
    bvid: raw.bvid,
    title: raw.title,
    desc: raw.desc,
    owner: raw.owner.name,
    view: raw.stat.view,
    duration: raw.duration,
    tname: raw.tname,
    danmaku: 0,
    pubdate: 0,
  }));
  // pick 给 0.99 是为了让 Fisher–Yates 原地不动，否则短名单顺序本来就是被打散的。
  const picked = biliShortlist(items, { shared: [], keywords: ['鲸'], count: 3, pick: () => 0.99 });
  const bvids = picked.map((item) => item.bvid);
  assert.ok(!bvids.includes('BV1zz411c7mF'), '课程类要被 OFF_LIMIT 挡掉');
  assert.equal(picked[0].bvid, 'BV1xx411c7mD', '关键词命中要排在前面');

  const again = biliShortlist(items, { shared: ['BV1xx411c7mD'], keywords: ['鲸'], count: 3, pick: () => 0.99 });
  assert.ok(!again.map((item) => item.bvid).includes('BV1xx411c7mD'), '分享过的不能再挑一次');
});

await test('分享文案：她的话在上，标题其次，链接必须是完整 BV 地址', async () => {
  const text = biliShareText({ line: '这个瞅着有意思', title: '鲸鱼为什么唱歌', bvid: 'BV1xx411c7mD' });
  const lines = text.split('\n');
  assert.equal(lines[0], '这个瞅着有意思');
  assert.equal(lines[1], '鲸鱼为什么唱歌');
  assert.equal(lines[2], 'https://www.bilibili.com/video/BV1xx411c7mD');
});

await test('-352 是概率性的：撞上会退一步重试，第二次成了就算成', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, status: 200, json: async () => ({ code: -352 }) };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: SAMPLE } }) };
  };
  const result = await fetchBiliRanking({ fetchImpl: flaky, attempts: 2 });
  assert.equal(calls, 2);
  assert.equal(result.reason, 'ok');
  assert.equal(result.items.length, SAMPLE.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
