/**
 * 面板预览：把 buildPage() 的成品包一层假 fetch，用真数据形状渲染一遍，
 * 供无头浏览器截图检查版式。只写临时目录，不进仓库、不碰线上。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPage } from '../lib/routes/panel.mjs';

const now = Date.now();
const minutes = (m) => now - m * 60000;

const status = {
  ok: true,
  build: 'v99-panel-judgement',
  agentEnabled: true,
  conversations: 4,
  stats: {
    since: now - 3600_000,
    lastError: null,
    ttftSamples: [9800, 11200, 13400],
    heartbeatChecks: 18,
    heartbeatDeclined: 13,
    heartbeatSpoke: 5,
    lastTurn: { conversation: 'group:100000001', at: minutes(3), ttftMs: 11200, totalMs: 48200,
      replyChars: 268, endReason: 'stop', hasReply: true },
  },
  登录: { 当前: 'online', 最后一次探测: minutes(1), 统计: { 掉线次数: 2, 累计不可用分钟: 14 } },
  reliability: { 持久化: 'D:/Code/dsh-qq-bridge/data/bridge.sqlite3', 发送回执: { SUCCEEDED: 812, UNKNOWN: 1 }, 待核对: [] },
  replyDelivery: { counts: { done: 403, failed: 1 }, failed: [], pending: [] },
  tasks: { counts: { model_finished: 6 }, active: [], queued: [] },
  replyPolicy: {
    sendQuotas: [],
    participation: { enabled: true, timeoutMs: 5000, checks: 42, silent: 27, requestShaped: 11,
      longAsk: 6, explicitAsk: 3, failed: 1, lastFailure: null, attentionDeclined: 31 },
    lastFloorDecision: { action: 'keep', reason: '仍有未尽答复' },
  },
  auxHealth: { calls: 96, ok: 91, failed: 5, empty: 3, successRate: 0.948, degraded: false,
    thinkingCalls: 0, basis: 'recent-window', samples: 96},
  出站队列: { items: 0, batches: 0, inFlightMs: 0, 同会话最小间隔ms: 900 },
  heartbeat: { enabled: true, active: true, unreadThreshold: 6, cooldownMs: 600000,
    groups: [{ conversation: 'group:100000001', phase: 'collecting', unread: 3, waitRemainingMs: 240000 },
      { conversation: 'group:324089993', phase: 'cooldown', unread: 0, cooldownRemainingMs: 90000 }] },
  models: {
    main: { provider: 'deepseek', model: 'deepseek-v4.1-flash', sessionReasoningEffort: 'off',
      reasoningEffortWire: 'off' },
    aux: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'off' },
  },
  contextPolicy: { lastPrompt: { conversation: 'group:100000001', textChars: 18422, windowMessages: 24,
    windowMessagesSkipped: 2, memoryChars: 1904, taskContextChars: 820, includeStatic: true } },
  事件分类: { group_message: 1204, private_message: 96, self_message: 388, notice: 12 },
  awake: [
    { 会话: 'group:100000001', 清醒剩余秒: 42, 本轮轮数: 3, 窗口条数: 24, 上下文累计轮数: 7,
      距上次表情: 3, 心跳缓冲条数: 3, 距最后消息秒: 12, 距上次说话秒: 46 },
    { 会话: 'group:324089993', 清醒剩余秒: 0, 本轮轮数: 0, 窗口条数: 18, 上下文累计轮数: 12,
      距上次表情: 9, 心跳缓冲条数: 0, 距最后消息秒: 320, 距上次说话秒: 1200 },
    { 会话: 'user:1056612947', 清醒剩余秒: 18, 本轮轮数: 1, 窗口条数: 9, 上下文累计轮数: 4,
      距上次表情: 1, 心跳缓冲条数: 0, 距最后消息秒: 40, 距上次说话秒: 61 },
  ],
  auxDecisions: [
    { kind: 'model', label: 'reply-decision', ok: true, durationMs: 1180, reasoningChars: 0,
      verdict: '不接', reason: '群友之间互相对话，不需要她参与',
      subject: '阿柚：那我先去洗澡了 ／ 老猫：去吧去吧', conversation: 'group:100000001',
      sample: '{"reply":false,"reason":"群友之间互相对话，不需要她参与"}', at: minutes(0.4) },
    { kind: 'rule', label: 'reply-decision', ok: true, durationMs: 0, reasoningChars: 0,
      verdict: '不接', reason: '明确 @ 其他成员，旁听',
      subject: '老王：@阿柚 你那个图呢', conversation: 'group:100000001', sample: null, at: minutes(1.2) },
    { kind: 'model', label: 'reply-decision', ok: true, durationMs: 1460, reasoningChars: 0,
      verdict: '接话', reason: '上一句是她的话，在接着问她',
      subject: '阿柚：你刚说的那个模板还能再发一次吗', conversation: 'group:100000001',
      sample: '{"reply":true,"reason":"上一句是她的话，在接着问她"}', at: minutes(2.5) },
    { kind: 'model', label: 'heartbeat', ok: true, durationMs: 2320, reasoningChars: 0,
      verdict: '插话·开放话题', reason: '大家在挑下午茶，她能给个具体建议',
      subject: '阿柚：喝什么好 ／ 老猫：随便', conversation: 'group:324089993',
      sample: '{"speak":true,"why":"大家在挑下午茶，她能给个具体建议","recipient":"group","kind":"interject"}',
      at: minutes(6) },
    { kind: 'model', label: 'floor', ok: true, durationMs: 1740, reasoningChars: 0,
      verdict: '照发', reason: '仍有未尽答复，新消息只是闲聊',
      subject: '她说：我查了下，那个接口要先申请 key……', conversation: 'group:100000001',
      sample: '{"action":"keep","value":"answer","basis":"valid","reason":"仍有未尽答复，新消息只是闲聊"}',
      at: minutes(8) },
    { kind: 'model', label: 'reply-decision', ok: false, durationMs: 4001, reasoningChars: 96,
      verdict: '判断失败', reason: 'empty-output', subject: '老猫：废鱼',
      conversation: 'group:100000001', sample: '', at: minutes(11) },
    { kind: 'rule', label: 'reply-decision', ok: true, durationMs: 0, reasoningChars: 0,
      verdict: '接话·护栏', reason: '请求型措辞，直接回',
      subject: '阿柚：帮我写一份周报模板', conversation: 'group:324089993', at: minutes(14) },
    { kind: 'model', label: 'routing', ok: true, durationMs: 990, reasoningChars: 0,
      verdict: '新任务', reason: 'independent-input', subject: '那再帮我画一只猫',
      conversation: 'group:324089993', sample: '{"action":"new","taskId":null,"confidence":0.9,"reason":"independent-input"}',
      at: minutes(17) },
    { kind: 'model', label: 'memory', ok: true, durationMs: 3100, reasoningChars: 0,
      verdict: '完成', reason: null, subject: null, conversation: null,
      sample: '{"memories":[]}', at: minutes(21) },
  ],
};

const page = buildPage();
// 预览专用：在模块脚本之前换掉 fetch，并让它永远返回上面这份快照。
const stub = `<script>
window.fetch = async (url, options) => {
  const body = options && options.body ? options.body : '';
  const payload = String(url).includes('/control')
    ? { ok: true }
    : String(url).includes('/admin/')
      ? { ok: true, entries: [], groups: [], texts: [], files: [], counts: {} }
      : ${JSON.stringify(status)};
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
};
</script>`;
const html = page.replace('<script type="module">', stub + '\n<script type="module">');
const out = path.join(os.tmpdir(), 'qq-panel-preview.html');
fs.writeFileSync(out, html);

// `?sim=1` 时自动点几个按钮（筛选、"只看没接"、会话名），用来确认事件处理没抛错。
const sim = `<script>
if (location.search.includes('sim')) {
  setTimeout(() => {
    const click = (label) => {
      const node = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
      if (node) node.click(); else console.error('missing button', label);
    };
    click('心跳 1');
    click('只看没接');
    const key = document.querySelector('#judgement .v-link');
    if (key) key.click();
    document.title = 'sim done';
  }, 800);
}
</script>`;
fs.writeFileSync(out, html.replace('</body>', sim + '</body>'));
console.log(out);

