/* 面板前端：只读渲染 + 一个托管开关。零框架、零构建，与 verdicts.mjs 一起内联进 HTML。 */

const API = location.pathname.replace(/\/panel\/?$/, '') || '';
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const POLL_MS = 30000;

const els = {
  banner: document.getElementById('banner'),
  build: document.getElementById('build'),
  hosting: document.getElementById('pill-hosting'),
  login: document.getElementById('pill-login'),
  queue: document.getElementById('pill-queue'),
  aux: document.getElementById('pill-aux'),
  stamp: document.getElementById('stamp'),
  refresh: document.getElementById('refresh'),
  theme: document.getElementById('theme'),
  toggle: document.getElementById('toggle'),
  auto: document.getElementById('auto'),
  verdicts: document.getElementById('verdicts'),
  sessionSummary: document.getElementById('session-summary'),
  sessions: document.getElementById('sessions'),
  allSessions: document.getElementById('all-sessions'),
  tabs: document.getElementById('tabs'),
  tabBody: document.getElementById('tab-body'),
  sessionDetail: document.getElementById('session-detail'),
  sessionKey: document.getElementById('session-key'),
  sessionBody: document.getElementById('session-body'),
  sessionClose: document.getElementById('session-close'),
  recent: document.getElementById('recent'),
  raw: document.getElementById('raw'),
  foot: document.getElementById('foot'),
};

let snap = null;
let fetchedAt = 0;
let authFailed = false;
let lastError = '';
let tab = 'tasks';
let showAll = false;
let autoPolling = true;
let pollTimer = 0;
/** 会话详情：key 是当前展开的那个，data 是 `/admin/conversation` 的返回。 */
let sessionKey = '';
let sessionData = null;
let sessionError = '';

/* —— 小工具 —— */

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const S = () => (snap && typeof snap === 'object' ? snap : {});
const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const int = (value) => {
  const n = numeric(value);
  return n === null ? '—' : n.toLocaleString('zh-CN');
};
const dur = (ms) => (numeric(ms) === null ? '—' : describeDuration(ms));
const pct = (value) => (numeric(value) === null ? '—' : Math.round(numeric(value) * 100) + '%');
const stamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
};
const clamp = (value, max = 240) => {
  const s = value === null || value === undefined ? '' : String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
};

function sub(title, ...kids) {
  return [el('div', { class: 'sub-head' }, title), ...kids];
}

function table(headers, rows, emptyText = '无') {
  if (!rows.length) return el('div', { class: 'empty' }, emptyText);
  return el('div', { class: 'tbl-wrap' },
    el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, headers.map((head) =>
        el('th', { class: head.num ? 'num' : null }, head.label)))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((cell, index) =>
        el('td', { class: headers[index]?.num ? 'num' : null }, cell ?? '—')))))));
}

function chips(counts, toneFor) {
  const entries = Object.entries(counts || {});
  if (!entries.length) return el('div', { class: 'empty' }, '没有计数');
  return el('div', { class: 'chips' }, entries
    .sort((a, b) => numeric(b[1]) - numeric(a[1]) || a[0].localeCompare(b[0]))
    .map(([key, value]) => {
      const tone = typeof toneFor === 'function' ? toneFor(key) : null;
      return el('span', { class: 'chip', 'data-bad': tone === 'bad' ? 'true' : null,
        'data-warn': tone === 'warn' ? 'true' : null }, key, el('b', {}, int(value)));
    }));
}

/* —— 顶栏 —— */

function pill(node, label, value, tone) {
  node.dataset.tone = tone || '';
  node.replaceChildren(document.createTextNode(label + ' '), el('b', {}, value));
}

function renderHeader() {
  const s = S();
  els.build.textContent = s.build || '未知构建';
  const hosting = s.agentEnabled;
  pill(els.hosting, '托管', hosting ? '开' : '关', hosting ? 'ok' : 'err');
  const login = s.登录 || {};
  const loginState = login.当前 || '未知';
  pill(els.login, 'QQ', loginState, loginState === 'online' ? 'ok' : login.当前 ? 'err' : '');
  const queue = s.出站队列 || {};
  pill(els.queue, '队列', int(queue.items) + ' 项', numeric(queue.inFlightMs) > 15000 ? 'warn' : '');
  const aux = s.auxHealth || {};
  pill(els.aux, '辅助层', aux.calls ? pct(aux.successRate) : '无样本', aux.degraded ? 'warn' : '');

  els.toggle.textContent = hosting ? '关闭托管' : '开启托管';
  els.toggle.className = hosting ? 'danger' : 'primary';
  els.foot.textContent = '本页与桥接同生共死：桥接挂了，这个页面也打不开。真正的告警仍走 QQ · ' +
    '统计自 ' + stamp(s.stats?.since) + '（重载后归零）';
}

function renderStamp() {
  if (authFailed) {
    els.stamp.textContent = '未通过鉴权';
    return;
  }
  if (lastError) {
    els.stamp.textContent = '刷新失败';
    return;
  }
  els.stamp.textContent = fetchedAt ? '刷新于 ' + describeDuration(Date.now() - fetchedAt) + '前' : '加载中…';
}

function renderBanner() {
  const message = authFailed
    ? '鉴权失败：这个部署配了 token。请在地址后面加 ?token=你的token 重新打开。'
    : lastError ? '读取状态失败：' + lastError + '（显示的是上一次读到的数据）' : '';
  els.banner.textContent = message;
  els.banner.dataset.show = message ? 'true' : 'false';
}

/* —— 判定条 —— */

function renderVerdicts() {
  const list = verdicts(snap, Date.now()).slice(0, 8);
  els.verdicts.replaceChildren(...list.map((item) => {
    const row = el('div', { class: 'v', 'data-level': item.level });
    row.append(el('div', { class: 'label' }, item.label));
    const detail = el('div', { class: 'detail' }, item.detail);
    if (item.goTo) detail.append(' ', el('button', {
      class: 'v-link', onclick: () => setTab(item.goTo),
    }, '看明细 →'));
    // 只有能就地解决的那种才给按钮：队列卡住可以冲一次，别的都得先去对应 tab 看清对象。
    if (item.id === 'queue') detail.append(' ', act('冲一次队列', 'queue.flush', { timeoutMs: 15000 }));
    row.append(detail);
    return row;
  }));
}

/* —— 会话表 —— */

function renderSessions() {
  const beats = new Map((S().heartbeat?.groups || []).map((group) => [group.conversation, group]));
  const all = (S().awake || []).map((row) => ({ row, beat: beats.get(row.会话) || null }));
  const live = all.filter(({ row, beat }) => showAll ||
    numeric(row.清醒剩余秒) > 0 ||
    (numeric(row.距最后消息秒) !== null && numeric(row.距最后消息秒) < 86400) ||
    (numeric(beat?.unread) || 0) > 0);
  live.sort((a, b) => (numeric(a.row.距最后消息秒) ?? Infinity) - (numeric(b.row.距最后消息秒) ?? Infinity));

  const beatOf = (beat) => {
    if (!beat) return '—';
    if (beat.phase === 'retry') return 'retry ' + dur(beat.retryRemainingMs) + '后重试';
    if (beat.phase === 'cooldown') return 'cooldown ' + dur(beat.cooldownRemainingMs) + '后';
    return beat.phase;
  };

  els.sessionSummary.textContent = all.length
    ? all.length + ' 个会话 · 显示 ' + live.length + ' · 心跳 ' +
      (S().heartbeat?.active ? '运行中' : S().heartbeat?.enabled ? '待托管' : '关闭')
    : '';

  if (!live.length) {
    els.sessions.replaceChildren(el('div', { class: 'empty' }, '没有活跃会话'));
    return;
  }
  const columns = ['会话', '清醒', '提交轮次', '窗口', '上下文', '距说话', '心跳', '未读'];
  // 数字列的表头也要右对齐，否则表头贴着列左边界、数字贴着右边界，一眼看不成一列。
  const numericColumn = new Set([1, 2, 3, 4, 5, 7]);
  const head = el('thead', {}, el('tr', {}, columns.map((label, index) =>
    el('th', { class: numericColumn.has(index) ? 'num' : null }, label))));
  const body = el('tbody', {}, live.map(({ row, beat }) => el('tr', {},
    el('td', { class: 'key' }, el('button', {
      class: 'keybtn',
      'data-active': String(row.会话 === sessionKey),
      title: '看这个会话的窗口与事件',
      onclick: () => toggleSession(row.会话),
    }, row.会话)),
    el('td', { class: 'num' }, numeric(row.清醒剩余秒) ? dur(row.清醒剩余秒 * 1000) : '—'),
    el('td', { class: 'num' }, int(row.本轮轮数)),
    el('td', { class: 'num' }, int(row.窗口条数)),
    el('td', { class: 'num' }, int(row.上下文累计轮数)),
    el('td', { class: 'num' },
      numeric(row.距上次说话秒) === null ? '—' : dur(row.距上次说话秒 * 1000) + '前'),
    el('td', { class: 'muted' }, beatOf(beat)),
    el('td', { class: 'num' }, beat ? int(beat.unread) : '—'))));
  els.sessions.replaceChildren(head, body);
}

/* —— 会话详情 —— */

async function toggleSession(key) {
  if (sessionKey === key) {
    hideSession();
    return;
  }
  sessionKey = key;
  sessionData = null;
  sessionError = '';
  renderSessions();
  els.sessionDetail.dataset.show = 'true';
  els.sessionKey.textContent = key;
  els.sessionBody.replaceChildren(el('div', { class: 'empty' }, '正在读这个会话…'));
  try {
    sessionData = await api('/admin/conversation?key=' + encodeURIComponent(key));
  } catch (error) {
    sessionError = error?.message ?? String(error);
  }
  if (sessionKey === key) renderSessionDetail();
}

function hideSession() {
  sessionKey = '';
  sessionData = null;
  sessionError = '';
  els.sessionDetail.dataset.show = 'false';
  renderSessions();
}

/** `user:1056612947` → `1056612947.md`；`group:324089993` → `groups/324089993.md`。 */
function memoryPathFor(key) {  const [kind, id] = String(key).split(':');
  if (!id) return '';
  if (kind === 'group') return `groups/${id}.md`;
  if (kind === 'user') return `${id}.md`;
  return '';
}

function eventKindLabel(kind) {
  const names = {
    inbound: '收到',
    group_message: '群消息',
    private_message: '私聊',
    self_message: '我说',
    outbound: '发出',
    meta_event: '元事件',
    notice: '通知',
  };
  return names[kind] ?? String(kind ?? '—');
}

function messageList(messages, emptyText) {
  if (!messages?.length) return el('div', { class: 'empty' }, emptyText);
  return el('div', { class: 'msglist' }, messages.map((message) => el('div', {
    class: 'msg', 'data-bot': String(Boolean(message.bot)),
  },
  el('span', { class: 'who', title: message.qq || '' }, message.who || (message.bot ? '你' : '—')),
  el('span', { class: 'text' }, message.text || '（无正文）',
    message.images ? el('span', { class: 'meta' }, `[图 ${message.images}]`) : null,
    message.forwards ? el('span', { class: 'meta' }, `[合并 ${message.forwards}]`) : null),
  el('span', { class: 'at' }, message.at ? stamp(message.at).slice(5) : '—'))));
}

function renderSessionDetail() {
  if (!sessionKey) return;
  els.sessionKey.textContent = sessionKey;
  if (sessionError) {
    els.sessionBody.replaceChildren(el('div', { class: 'errbox' }, '读不到这个会话：' + sessionError));
    return;
  }
  const data = sessionData;
  if (!data) {
    els.sessionBody.replaceChildren(el('div', { class: 'empty' }, '正在读这个会话…'));
    return;
  }
  const beat = (S().heartbeat?.groups || []).find((group) => group.conversation === sessionKey);
  const tasks = (S().tasks?.active || []).filter((task) => task.conversation === sessionKey);
  const queued = (S().tasks?.queued || []).find((row) => row.conversation === sessionKey);
  const pendingRows = (S().replyDelivery?.pending || []).filter((row) => row.conversation === sessionKey);
  const failedRows = (S().replyDelivery?.failed || []).filter((row) => row.conversation === sessionKey);
  const memoryFile = memoryPathFor(sessionKey);

  const overview = el('dl', { class: 'kv' },
    el('dt', {}, '窗口'), el('dd', {}, `${int(data.windowSize)} 条（列最近 ${int(data.window?.length)} 条）`,
      data.turns ? el('span', { class: 'sub' }, ` · 提交轮次 ${int(data.turns)} · 上下文累计 ${int(data.contextTurn)}`) : null),
    el('dt', {}, 'DSH 会话'), el('dd', {}, data.sessionId || '—'),
    el('dt', {}, '最后消息'), el('dd', {}, data.lastMessageAt
      ? stamp(data.lastMessageAt) + '（' + dur(Date.now() - data.lastMessageAt) + '前）' : '—'),
    el('dt', {}, '上次说话'), el('dd', {}, data.lastSpokeAt
      ? stamp(data.lastSpokeAt) + '（' + dur(Date.now() - data.lastSpokeAt) + '前）' : '—'),
    el('dt', {}, '清醒'), el('dd', {}, data.awakeRemainingMs > 0
      ? '还剩 ' + dur(data.awakeRemainingMs) : '睡着'),
    el('dt', {}, '心跳'), el('dd', {}, beat
      ? [phaseLabel(beat.phase), ` · 未读 ${int(beat.unread)} · 缓冲 ${int(data.pending?.length)} 条`]
      : '—',),
    el('dt', {}, '任务'), el('dd', {}, tasks.length || queued
      ? `${tasks.length} 个活动执行` + (queued ? ` · 排队 ${int(queued.count)} 条（最久 ${dur(queued.oldestWaitMs)}）` : '')
      : '没有'),
    el('dt', {}, '投递'), el('dd', {}, pendingRows.length || failedRows.length
      ? `待送达 ${pendingRows.length} · 失败 ${failedRows.length}` : '没有'),
    el('dt', {}, '最近的人'), el('dd', {}, (data.recentQqs || []).join('、') || '—'));

  const tools = el('div', { class: 'actions' },
    act('清空上下文', 'conversation.reset', { key: sessionKey }, {
      danger: true, confirm: '清掉 ' + sessionKey + ' 的上下文与窗口？下一轮她会当第一次见面。',
    }),
    memoryFile
      ? el('button', {
        class: 'mini',
        onclick: () => {
          setTab('memory');
          ensureMemory().then(() => openMemory(memoryFile));
        },
      }, '打开记忆文件')
      : null,
    beat
      ? act('现在催一次', 'heartbeat.poke', { key: sessionKey }, {})
      : null);

  els.sessionBody.replaceChildren(
    ...[].concat(
      overview,
      sub('现场', tools),
      sub('窗口（最近 ' + (data.window?.length ?? 0) + ' 条，按时间顺序）', messageList(data.window, '窗口是空的')),
      data.pending?.length ? sub('心跳缓冲（' + data.pending.length + ' 条）', messageList(data.pending, '')) : [],
        sub('事件流（数据库最近 ' + (data.events?.length ?? 0) + ' 条）',
        data.eventsError
          ? el('div', { class: 'errbox' }, '读事件流失败：' + data.eventsError)
          : messageList((data.events || []).map((event) => ({
            who: eventKindLabel(event.kind), qq: event.kind,
            text: event.text || '（无正文）', at: event.at, bot: !event.deliverable,
          })), '没有存下来的事件（可能没开持久化）')),
    ),
  );
}

/* —— tab —— */

function setTab(next) {
  tab = next;
  for (const button of els.tabs.querySelectorAll('button'))
    button.dataset.active = String(button.dataset.tab === next);
  renderTab();
  // 设置/记忆按需取数：只读页不该为了两个没人看的 tab 多打两次接口。
  if (next === 'settings') ensureSettings().then(() => { if (tab === 'settings') renderSettings(); });
  if (next === 'memory') ensureMemory().then(() => { if (tab === 'memory') renderMemory(); });
  if (next === 'failures') ensureAudit();
}

function renderTab() {
  if (tab === 'settings') { renderSettings(); return; }
  if (tab === 'memory') { renderMemory(); return; }
  const body = tab === 'delivery' ? renderDelivery()
    : tab === 'failures' ? renderFailures()
      : renderTasks();
  els.tabBody.replaceChildren(...[].concat(body).filter(Boolean));
}

function renderTasks() {
  const tasks = S().tasks || {};
  const counts = tasks.counts || {};
  const queued = tasks.queued || [];
  const active = tasks.active || [];
  const tone = (state) => (state === 'failed' ? 'bad'
    : state === 'recovering' || state === 'needs_attention' ? 'warn' : null);

  return [
    chips(counts, tone),
    ...sub('排队中的输入（' + queued.length + ' 个会话）', queued.length
      ? table([{ label: '会话' }, { label: '待处理', num: true }, { label: '最久等待', num: true }],
        queued.map((row) => [row.conversation, int(row.count), dur(row.oldestWaitMs)]))
      : el('div', { class: 'empty' }, '没有排队')),
    ...sub('活跃任务（最久在前）', active.length
      ? table([{ label: '会话' }, { label: '状态' }, { label: '已耗时', num: true },
        { label: '最近推进', num: true }, { label: '投递' }, { label: '处置' }],
      active.map((row) => [
        el('span', { class: 'key' }, row.conversation),
        row.state,
        dur(row.elapsedMs),
        row.lastProgressAt ? dur(Date.now() - row.lastProgressAt) + '前' : '—',
        row.deliveryState || '—',
        row.id
          ? act('结束', 'task.settle', { id: row.id }, {
            danger: true,
            confirm: '把这个执行判为 failed 并结束？\n' + row.conversation + ' · 已耗时 ' + dur(row.elapsedMs) +
              '\n\n它不会变成"完成"，只是不再占着队列。',
          })
          : '—',
      ]))
      : el('div', { class: 'empty' }, '没有活跃任务')),
    ...sub('并发', el('div', { class: 'muted' },
      '任务 ' + int(tasks.scheduler?.concurrency ?? S().taskScheduler?.concurrency) + ' · 每会话 ' +
      int(S().taskScheduler?.perConversation) + ' · 恢复通道 ' +
      int(S().tasks?.recoveryLane?.active) + '/' + int(S().tasks?.recoveryLane?.maxConcurrent))),
  ];
}

function renderDelivery() {
  const delivery = S().replyDelivery || {};
  const counts = delivery.counts || {};
  const pending = delivery.pending || [];
  const failed = delivery.failed || [];
  const queue = S().出站队列 || {};
  const quotas = S().replyPolicy?.sendQuotas || [];
  const tone = (state) => (state === 'failed' || state === 'attention' ? 'bad' : null);

  return [
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, '队列', el('b', {}, int(queue.items)), '项'),
      el('span', { class: 'chip' }, '批次', el('b', {}, int(queue.batches))),
      el('span', { class: 'chip', 'data-warn': numeric(queue.inFlightMs) > 15000 ? 'true' : null },
        '在途', el('b', {}, dur(queue.inFlightMs)))),
    chips(counts, tone),
    ...sub('待送达（' + pending.length + ' 条，最多列 20）', pending.length
      ? table([{ label: '会话' }, { label: '状态' }, { label: '隔离' }, { label: '尝试', num: true },
        { label: '创建', num: true }, { label: '下次重试', num: true }, { label: '详情' }, { label: '处置' }],
      pending.map((row) => [
        el('span', { class: 'key' }, row.conversation),
        row.state,
        row.quarantined ? el('span', { class: 'chip', 'data-bad': 'true' }, '是') : '—',
        int(row.attempts),
        row.createdAt ? dur(Date.now() - row.createdAt) + '前' : '—',
        row.quarantined ? el('span', { class: 'muted' }, '不重试')
          : row.retryAt && row.retryAt > Date.now() ? dur(row.retryAt - Date.now()) + '后'
            : el('span', { class: 'muted' }, '待重试'),
        el('span', { class: 'wrap', title: String(row.detail || '') }, clamp(row.detail, 160) || '—'),
        el('span', { class: 'acts' },
          act('重排', 'delivery.retry', { id: row.id }),
          act('放弃', 'delivery.abandon', { id: row.id }, {
            danger: true,
            confirm: '放弃这条待送达的回复？\n' + row.conversation + ' · ' + (row.detail || '没有详情') +
              '\n\n放弃了就真的不会发出去了（记录还留在"最近失败"里）。',
          })),
      ]))
      : el('div', { class: 'empty' }, '没有待送达')),
    ...sub('最近失败（最多 5 条）', failed.length
      ? table([{ label: '会话' }, { label: '尝试', num: true }, { label: '更新', num: true }, { label: '原文' }],
        failed.map((row) => [
          el('span', { class: 'key' }, row.conversation),
          int(row.attempts),
          row.updated_at ? dur(Date.now() - row.updated_at) + '前' : '—',
          el('span', { class: 'wrap', title: String(row.detail || '') }, clamp(row.detail, 240) || '—'),
        ]))
      : el('div', { class: 'empty' }, '没有失败记录')),
    ...sub('配额', quotas.length
      ? table([{ label: '会话' }, { label: '分钟档', num: true }, { label: '小时档', num: true }, { label: '状态' }],
        quotas.map((row) => [
          el('span', { class: 'key' }, row.conversation),
          int(row.minute?.used) + ' / ' + int(row.minute?.limit),
          int(row.hour?.used) + ' / ' + int(row.hour?.limit),
          row.minute?.blocked || row.hour?.blocked
            ? el('span', { class: 'chip', 'data-warn': 'true' }, '限流中')
            : el('span', { class: 'muted' }, '正常'),
        ]))
      : el('div', { class: 'empty' }, '配额不可用（库没打开）')),
  ];
}

function renderFailures() {
  const reliability = S().reliability || {};
  const unknownRows = reliability.待核对 || [];
  const stats = S().stats || {};
  const recovery = stats.recovery || {};
  const lanes = Object.entries(recovery);
  const auditRows = (auditData?.recent || []).slice(-12).reverse();

  return [
    chips(reliability.发送回执, (key) => (key === 'UNKNOWN' || key === 'FAILED' ? 'bad' : null)),
    el('div', { class: 'muted', style: null },
      '持久化：' + (reliability.持久化 ? '已启用' : (reliability.说明 || '未启用'))),
    ...sub('待核对回执（' + unknownRows.length + ' 条已列出）', unknownRows.length
      ? table([{ label: '时间' }, { label: '会话' }, { label: '状态' }, { label: '目标' },
        { label: '幂等键' }, { label: '详情' }, { label: '处置' }],
      unknownRows.map((row) => [
        stamp(row.时间),
        el('span', { class: 'key' }, row.会话),
        row.状态,
        row.目标 || '—',
        el('span', { class: 'key' }, clamp(row.键, 44)),
        el('span', { class: 'wrap', title: String(row.详情 || '') }, clamp(row.详情, 160) || '—'),
        el('span', { class: 'acts' },
          act('已发', 'receipt.markSent', { idemKey: row.键 }, {
            confirm: '你确认这条真的发出去了？\n' + row.会话 + ' · ' + stamp(row.时间) +
              '\n\n点完它就不再算"待核对"。',
          }),
          act('没发', 'receipt.markFailed', { idemKey: row.键 }, {
            confirm: '确认这条没发出去、也不会再发？',
          })),
      ]))
      : el('div', { class: 'empty' }, '没有待核对')),
    ...sub('最近一次错误', stats.lastError
      ? el('div', { class: 'errbox' },
        el('div', { class: 'muted' }, stats.lastErrorAt
          ? describeDuration(Date.now() - stats.lastErrorAt) + '前 · ' + stamp(stats.lastErrorAt)
          : '时间未知（这条错误没有时间戳）'),
        el('div', { class: 'mono' }, stats.lastError))
      : el('div', { class: 'empty' }, '本次运行没有错误记录')),
    ...sub('后台恢复循环', lanes.length
      ? table([{ label: '循环' }, { label: '状态' }, { label: '自', num: true }, { label: '恢复次数', num: true }],
        lanes.map(([label, lane]) => [
          label,
          lane?.paused
            ? el('span', { class: 'chip', 'data-bad': 'true' }, '已暂停')
            : el('span', { class: 'muted' }, '运行中'),
          lane?.paused && lane.since ? dur(Date.now() - lane.since) + '前' : '—',
          int(lane?.resumed),
        ]))
      : el('div', { class: 'empty' }, '没有恢复循环记录')),
    ...sub('处置记录（最近 ' + auditRows.length + ' 条）', auditRows.length
      ? table([{ label: '时间' }, { label: '动作' }, { label: '参数' }, { label: '结果' }],
        auditRows.map((row) => [
          stamp(row.at),
          row.action,
          el('span', { class: 'key' }, clamp(JSON.stringify(row.args || {}), 60)),
          row.ok
            ? el('span', { class: 'muted' }, '成功')
            : el('span', { class: 'err-text', title: String(row.error || '') }, clamp(row.error, 120) || '失败'),
        ]))
      : el('div', { class: 'empty' }, '本次运行还没在面板上下过手')),
  ];
}

/* —— 最近一次 —— */

function renderRecent() {
  const s = S();
  const stats = s.stats || {};
  const turn = stats.lastTurn || null;
  const prompt = s.contextPolicy?.lastPrompt || null;
  const login = s.登录 || {};
  const queue = s.出站队列 || {};
  const aux = s.auxHealth || {};
  const models = s.models || {};
  const rows = [];

  if (turn) {
    rows.push(el('dt', {}, '回合'), el('dd', {},
      el('span', { class: 'key' }, String(turn.conversation || '未知会话')), ' · ',
      turn.at ? dur(Date.now() - turn.at) + '前' : '时间未知',
      el('div', { class: 'sub' },
        '首字 ' + dur(turn.ttftMs) + ' · 总 ' + dur(turn.totalMs) + ' · 正文 ' +
        int(turn.replyChars ?? s.stats?.lastLatency?.replyChars) + ' 字 · ' +
        (turn.endReason || '结束原因未知') + (turn.hasReply ? '' : ' · 没有正文'))));
  } else {
    rows.push(el('dt', {}, '回合'), el('dd', { class: 'muted' }, '本次运行还没有回合'));
  }

  if (prompt) {
    rows.push(el('dt', {}, '提示词'), el('dd', {},
      el('span', { class: 'key' }, String(prompt.conversation || '—')),
      el('div', { class: 'sub' },
        '正文 ' + int(prompt.textChars) + ' 字 · 窗口 ' + int(prompt.windowMessages) + ' 条' +
        (prompt.windowMessagesSkipped ? '（跳过 ' + int(prompt.windowMessagesSkipped) + '）' : '') +
        ' · 记忆 ' + int(prompt.memoryChars) + ' · 任务 ' + int(prompt.taskContextChars) +
        ' · 静态块 ' + (prompt.includeStatic ? '有' : '无') + (prompt.windowDelta ? ' · 增量窗口' : ''))));
  }

  rows.push(el('dt', {}, '登录'), el('dd', {},
    (login.当前 || '未知') + (login.最后一次探测 ? ' · 最近探测 ' + stamp(login.最后一次探测) : ''),
    el('div', { class: 'sub' },
      '掉线 ' + int(login.统计?.掉线次数) + ' 次 · 累计不可用 ' +
      int(login.统计?.累计不可用分钟) + ' 分钟' +
      (login.统计?.当前掉线中 ? ' · 正在掉线' : ''))));

  rows.push(el('dt', {}, '出站队列'), el('dd', {},
    int(queue.items) + ' 项 / ' + int(queue.batches) + ' 批 · 在途 ' + dur(queue.inFlightMs) +
    (queue.pumping ? ' · 发送中' : ''),
    el('div', { class: 'sub' }, '同会话最小间隔 ' + dur(s.出站队列?.同会话最小间隔ms))));

  rows.push(el('dt', {}, '辅助层'), el('dd', {},
    ...(aux.calls
      ? [
        pct(aux.successRate) + ' · ' + int(aux.calls) + ' 次调用 · 失败 ' + int(aux.failed) +
          ' · 空输出 ' + int(aux.empty),
        el('div', { class: 'sub' },
          (aux.basis === 'recent-window' ? '最近 15 分钟' : '最近 ' + int(aux.samples) + ' 次样本') +
          (aux.thinkingCalls ? ' · 有思考 ' + int(aux.thinkingCalls) + ' 次（关思考没生效）' : '')),
      ]
      : [el('span', { class: 'muted' }, '本次运行还没有辅助调用（重载后从零累计）')])));

  rows.push(el('dt', {}, '模型'), el('dd', {},
    el('span', { class: 'key' }, (models.main?.provider || '—') + '/' + (models.main?.model || '—')),
    el('div', { class: 'sub' },
      '辅助 ' + (models.aux?.provider || '—') + '/' + (models.aux?.model || '—') +
      ' · 思考档 ' + (models.aux?.reasoningEffort || '默认'))));

  const kinds = Object.entries(s.事件分类 || {}).sort((a, b) => numeric(b[1]) - numeric(a[1]));
  if (kinds.length) {
    rows.push(el('dt', {}, '事件'), el('dd', {},
      el('div', { class: 'sub' }, kinds.map(([key, value]) => key + ' ' + int(value)).join(' · '))));
  }

  els.recent.replaceChildren(...rows);
}

/* —— 后台：设置 / 人设文本 / 记忆 —— */

let settingsData = null;
let settingsError = '';
let draft = {};
let textsData = null;
const textBodies = new Map();
let memoryData = null;
let memPath = '';
let memText = '';
let flashTimer = 0;
let auditData = null;

/** 审计是"我刚才点了什么、结果如何"的账本。只在失败面 tab 用得上，按需拉。 */
async function ensureAudit() {
  try {
    auditData = await api('/admin/actions');
  } catch {
    auditData = null;
  }
  if (tab === 'failures') renderTab();
}

function flash(text, tone) {
  const node = document.getElementById('flash');
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone || 'ok';
  node.dataset.show = 'true';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { node.dataset.show = 'false'; }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: headers({ 'content-type': 'application/json', ...(options.headers || {}) }),
    cache: 'no-store',
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const detail = payload?.rejected
      ? payload.rejected.map((item) => item.key + '：' + item.error).join('；')
      : payload?.error || ('HTTP ' + response.status);
    const error = new Error(detail);
    error.payload = payload;
    throw error;
  }
  return payload ?? {};
}

/**
 * 处置动作。
 *
 * 每个按钮都要带一个幂等键：面板会重试（双击、刷新后重点、网络重发），
 * 服务端拿同一个键第二次进来直接返回第一次的结果，不会重复改库。
 */
function newIdem() {
  try {
    return crypto.randomUUID();
  } catch {
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }
}

async function runAction(id, args, { danger = false, confirm = '', memo = '' } = {}) {
  if (confirm && !window.confirm(confirm)) return null;
  try {
    const payload = { id, args, idemKey: newIdem(), memo };
    if (danger) payload.confirm = true;
    const result = await api('/admin/action', { method: 'POST', body: JSON.stringify(payload) });
    flash('已执行：' + (result.action || id) + (result.replay ? '（重放）' : ''), 'ok');
    await load();
    ensureAudit();
    return result;
  } catch (error) {
    flash('没成：' + error.message, 'bad');
    return null;
  }
}

/** 行内小按钮：点完自己 disable，避免第二次点击挤在同一次请求里。 */
function act(label, id, args, { danger = false, confirm = '', tone = null } = {}) {
  return el('button', {
    class: 'mini' + (danger ? ' danger' : ''),
    'data-tone': tone,
    onclick: async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await runAction(id, args, { danger, confirm });
      } finally {
        button.disabled = false;
      }
    },
  }, label);
}

function entryOf(key) {
  return (settingsData?.entries || []).find((entry) => entry.key === key) || null;
}

/** 表单里的显示值：毫秒项按秒显示，其余原样。 */
function shownValue(entry) {
  const value = entry.value;
  if (entry.kind === 'ms') return numeric(value) === null ? 0 : Math.round(numeric(value) / 1000);
  if (entry.kind === 'bool') return Boolean(value);
  if (entry.kind === 'int') return numeric(value) ?? 0;
  return value === null || value === undefined ? '' : String(value);
}

function toPayload(entry, raw) {
  if (entry.kind === 'bool') return Boolean(raw);
  if (entry.kind === 'ms') return Math.round(Number(raw) * 1000);
  if (entry.kind === 'int') return Number(raw);
  return String(raw);
}

function draftCount() {
  return Object.keys(draft).length;
}

function updateActions() {
  const bar = document.getElementById('settings-actions');
  if (!bar) return;
  const count = draftCount();
  const hint = bar.querySelector('.hint');
  const save = bar.querySelector('#settings-save');
  const undo = bar.querySelector('#settings-undo');
  if (hint) hint.textContent = count ? count + ' 项改了还没保存' : '没有未保存的改动';
  if (save) save.disabled = count === 0;
  if (undo) undo.disabled = count === 0;
}

function settingsSection(entry) {
  const current = draft[entry.key];
  const dirty = current !== undefined;
  const row = el('div', { class: 'field', 'data-dirty': dirty ? 'true' : null, 'data-key': entry.key });
  const label = el('div', {},
    el('div', { class: 'fl' }, entry.label,
      // 只有被面板覆盖的项才挂标签：每行都盖一个"配置文件"会把真正需要注意的区别淹掉。
      entry.overridden ? el('span', { class: 'badge' }, '面板覆盖') : null),
    el('div', { class: 'fh' }, entry.help));
  const control = el('div', { class: 'fc' });
  const value = dirty ? current : shownValue(entry);

  const mark = (next) => {
    draft[entry.key] = next;
    row.dataset.dirty = 'true';
    updateActions();
  };

  if (entry.kind === 'bool') {
    const box = el('input', { type: 'checkbox' });
    box.checked = Boolean(value);
    box.addEventListener('change', () => {
      draft[entry.key] = box.checked;
      row.dataset.dirty = 'true';
      updateActions();
    });
    control.append(box, el('span', { class: 'unit' }, box.checked ? '开' : '关'));
    box.addEventListener('change', () => {
      control.lastChild.textContent = box.checked ? '开' : '关';
    });
  } else if (entry.kind === 'int' || entry.kind === 'ms') {
    const box = el('input', { type: 'number', value: String(value),
      min: entry.kind === 'ms' ? String(Math.round((entry.min ?? 0) / 1000)) : entry.min,
      max: entry.kind === 'ms' ? String(Math.round((entry.max ?? 0) / 1000)) : entry.max,
      step: '1' });
    box.addEventListener('input', () => {
      const raw = Number(box.value);
      const low = entry.kind === 'ms' ? (entry.min ?? 0) / 1000 : entry.min;
      const high = entry.kind === 'ms' ? (entry.max ?? 0) / 1000 : entry.max;
      const bad = !Number.isFinite(raw) || (low != null && raw < low) || (high != null && raw > high);
      row.dataset.bad = bad ? 'true' : 'false';
      draft[entry.key] = raw;
      row.dataset.dirty = 'true';
      updateActions();
    });
    control.append(box, el('span', { class: 'unit' }, entry.kind === 'ms' ? '秒' : entry.unit || ''));
    if (entry.kind === 'ms') {
      const seconds = Number(value);
      control.append(el('span', { class: 'unit muted' },
        seconds >= 60 ? '≈ ' + Math.round(seconds / 60) + ' 分钟' : ''));
    }
  } else if (entry.kind === 'enum') {
    const select = el('select', {});
    for (const option of entry.options || []) {
      const node = el('option', { value: option.value }, option.label);
      select.append(node);
    }
    select.value = String(value);
    select.addEventListener('change', () => mark(select.value));
    control.append(select);
  } else {
    const box = el('input', { type: 'text', value: String(value),
      maxlength: entry.max ? String(entry.max) : null,
      placeholder: entry.placeholder || '' });
    box.addEventListener('input', () => mark(box.value));
    control.append(box);
  }

  if (entry.overridden) {
    control.append(el('button', {
      class: 'mini', title: '把这一项恢复成配置文件里的值',
      onclick: () => resetSettings([entry.key]),
    }, '恢复'));
  }

  row.append(label, control);
  return row;
}

function renderSettings() {
  if (settingsError) {
    els.tabBody.replaceChildren(el('div', { class: 'empty' }, settingsError));
    return;
  }
  if (!settingsData) {
    els.tabBody.replaceChildren(el('div', { class: 'empty' }, '正在读设置…'));
    return;
  }
  const groups = settingsData.groups || [];
  const entries = settingsData.entries || [];
  const bar = el('div', { class: 'actions', id: 'settings-actions' },
    el('button', { class: 'primary', id: 'settings-save', disabled: true, onclick: saveSettings }, '保存改动'),
    el('button', { class: 'mini', id: 'settings-undo', disabled: true, onclick: () => {
      draft = {};
      renderSettings();
    } }, '撤销'),
    el('span', { class: 'hint' }, '没有未保存的改动'),
    el('span', { class: 'muted', style: 'margin-left:auto;font-size:11.5px' },
      settingsData.frozen ? 'config 对象只读，改动不会被接受' : '改完立即生效，不用重载'));

  const body = [bar];
  if (settingsData.lastError) {
    body.push(el('div', { class: 'errbox' }, el('div', { class: 'mono' }, settingsData.lastError)));
  }
  body.push(...renderTextEditors());
  for (const group of groups) {
    const rows = entries.filter((entry) => entry.group === group.id);
    if (!rows.length) continue;
    body.push(el('div', { class: 'grp' },
      el('h3', {}, group.label),
      group.note ? el('p', { class: 'note' }, group.note) : null,
      group.id === 'heartbeat' ? heartbeatLive() : null,
      ...rows.map(settingsSection)));
  }
  if (settingsData.history?.length) {
    body.push(...sub('最近改动（' + settingsData.history.length + ' 条）',
      table([{ label: '时间' }, { label: '项' }, { label: '改成' }, { label: '备注' }],
        settingsData.history.map((item) => [
          stamp(item.at),
          el('span', { class: 'key' }, item.key),
          el('span', { class: 'key' }, clamp(typeof item.to === 'boolean' ? (item.to ? '开' : '关') : item.to, 40)),
          item.note || '—',
        ]))));
  }
  els.tabBody.replaceChildren(...body.filter(Boolean));
  updateActions();
}

/**
 * 心跳的现状：设置只说明"参数是多少"，还得让人看见"现在跑到哪一步了"——
 * 哪个群在攒消息、哪个在冷却、还差几条才触发。
 */
function heartbeatLive() {
  const beat = snap?.heartbeat;
  if (!beat) return null;
  const groups = beat.groups ?? [];
  const wait = (row) => {
    const remain = row.cooldownRemainingMs ?? row.retryRemainingMs ?? row.waitRemainingMs;
    return typeof remain === 'number' && remain > 0 ? dur(remain) + '后' : '—';
  };
  if (!groups.length) return el('p', { class: 'note' }, '心跳开着，但还没有群进入过这个循环。');
  return sub('现在跑到哪一步了（阈值 ' + int(beat.unreadThreshold ?? 0) + ' 条 · 冷却 ' + dur(beat.cooldownMs ?? 0) + '）',
    table([{ label: '会话' }, { label: '阶段' }, { label: '未读', num: true }, { label: '还要等' }, { label: '操作' }],
      groups.map((row) => [
        el('span', { class: 'key' }, row.conversation),
        phaseLabel(row.phase),
        el('span', { class: 'num' }, int(row.unread ?? 0)),
        wait(row),
        el('span', { class: 'acts' }, act('现在催一次', 'heartbeat.poke', { key: row.conversation })),
      ])));
}

function phaseLabel(phase) {
  const names = {
    disabled: '关掉了', checking: '在看', collecting: '攒消息', retry: '等重试',
    ready: '可以插话', cooldown: '冷却中', waiting: '等窗口',
  };
  return el('span', { class: 'chip', 'data-tone': phase === 'retry' ? 'bad' : null },
    names[phase] ?? (phase || '—'));
}

function renderTextEditors() {  if (!textsData) return [el('div', { class: 'empty' }, '正在读人设文件…')];
  return [el('div', { class: 'grp' },
    el('h3', {}, '人设与文本'),
    el('p', { class: 'note' },
      '这三份 markdown 是静态层的正文，改完下一轮就生效（按 mtime 重读）。保存前会自动备份到 data/panel-backups/。'),
    ...textsData.texts.map(textEditor))];
}

function textEditor(meta) {
  const cached = textBodies.get(meta.name);
  const details = el('details', { class: 'ed' });
  const hint = el('span', { class: 'badge open-hint' }, '展开编辑');
  const summary = el('summary', {},
    el('span', {}, meta.label),
    el('span', { class: 'meta' },
      (meta.exists ? int(meta.chars) + ' 字 · ' + bytes(meta.bytes) + ' · ' + dur(Date.now() - meta.mtimeMs) + '前'
        : '文件还不存在')),
    el('span', { class: 'meta' }, meta.file || '（未配置 ' + meta.key + '）'),
    hint);
  details.append(summary);

  if (!meta.file) {
    details.append(el('div', { class: 'empty' }, '这一项没有配置路径，先在设置里填 ' + meta.key));
    return details;
  }

  const box = el('textarea', { spellcheck: 'false' });
  box.value = cached ?? '';
  const metaLine = el('span', { class: 'meta' }, '');
  let loaded = cached !== undefined;

  const save = el('button', { class: 'primary', onclick: async () => {
    try {
      const result = await api('/admin/text', { method: 'POST', body: JSON.stringify({ name: meta.name, text: box.value }) });
      textBodies.set(meta.name, box.value);
      const index = textsData.texts.findIndex((item) => item.name === meta.name);
      if (index >= 0) textsData.texts[index] = result.meta;
      metaLine.textContent = '已保存 · ' + int(result.meta.chars) + ' 字' + (result.backup ? ' · 旧版已备份' : '');
      flash(meta.label + '已保存');
    } catch (error) {
      flash(meta.label + '保存失败：' + error.message, 'bad');
      metaLine.textContent = error.message;
    }
  } }, '保存' + meta.label);

  const reload = el('button', { class: 'mini', onclick: () => {
    loaded = false;
    textBodies.delete(meta.name);
    openEditor();
  } }, '重新读盘');

  const openEditor = async () => {
    if (!loaded) {
      metaLine.textContent = '读取中…';
      try {
        const result = await api('/admin/text?name=' + encodeURIComponent(meta.name));
        box.value = result.text ?? '';
        textBodies.set(meta.name, box.value);
        loaded = true;
        metaLine.textContent = '';
      } catch (error) {
        metaLine.textContent = error.message;
        loaded = true;
      }
    }
  };

  details.addEventListener('toggle', () => {
    hint.textContent = details.open ? '收起' : '展开编辑';
    if (details.open) openEditor();
  });
  details.append(el('div', { class: 'actions' }, save, reload, metaLine), box);
  if (details.hasAttribute('open')) openEditor();
  return details;
}

function bytes(value) {
  const n = numeric(value);
  if (n === null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

async function ensureSettings() {
  if (settingsData) return;
  try {
    const settings = await api('/admin/settings');
    settingsData = settings;
    settingsError = '';
    const texts = await api('/admin/texts');
    textsData = texts;
  } catch (error) {
    settingsError = '读设置失败：' + error.message;
  }
  if (tab === 'settings') renderSettings();
}

async function saveSettings() {
  const patch = {};
  const rejected = [];
  for (const [key, raw] of Object.entries(draft)) {
    const entry = entryOf(key);
    if (!entry) continue;
    const value = toPayload(entry, raw);
    if (entry.kind === 'int' || entry.kind === 'ms') {
      const low = entry.min;
      const high = entry.max;
      if (!Number.isFinite(value) || (low != null && value < low) || (high != null && value > high)) {
        rejected.push(entry.label);
        continue;
      }
    }
    patch[key] = value;
  }
  if (rejected.length) {
    flash('这些还没填对：' + rejected.join('、'), 'bad');
    return;
  }
  if (!Object.keys(patch).length) return;
  try {
    const result = await api('/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ patch, note: '面板 ' + new Date().toLocaleString('zh-CN', { hour12: false }) }),
    });
    settingsData = result;
    draft = {};
    renderSettings();
    const changed = (result.changed || []).length;
    flash(changed ? '已保存 ' + changed + ' 项，下一轮生效' : '值没有变化');
  } catch (error) {
    flash('保存失败：' + error.message, 'bad');
  }
}

async function resetSettings(keys) {
  const label = keys.length === 1 ? (entryOf(keys[0])?.label ?? keys[0]) : keys.length + ' 项';
  if (!window.confirm('把「' + label + '」恢复成 cordis.patch.yml 里的值？')) return;
  try {
    const result = await api('/admin/settings/reset', { method: 'POST', body: JSON.stringify({ keys }) });
    settingsData = result;
    for (const key of keys) delete draft[key];
    renderSettings();
    flash('已恢复 ' + keys.length + ' 项');
  } catch (error) {
    flash('恢复失败：' + error.message, 'bad');
  }
}

async function ensureMemory() {
  if (memoryData) return;
  try {
    memoryData = await api('/admin/memory');
  } catch (error) {
    memoryData = { error: error.message, files: [], counts: {} };
  }
  if (tab === 'memory') renderMemory();
}

async function openMemory(path) {
  memPath = path;
  memText = '';
  renderMemory();
  try {
    const result = await api('/admin/memory/file?path=' + encodeURIComponent(path));
    memText = result.text ?? '';
  } catch (error) {
    memText = '';
    flash('读取失败：' + error.message, 'bad');
  }
  if (tab === 'memory') renderMemory();
}

function renderMemory() {
  if (!memoryData) {
    els.tabBody.replaceChildren(el('div', { class: 'empty' }, '正在读记忆目录…'));
    return;
  }
  if (memoryData.error) {
    els.tabBody.replaceChildren(el('div', { class: 'empty' }, '读记忆失败：' + memoryData.error));
    return;
  }
  const files = memoryData.files || [];
  const counts = memoryData.counts || {};
  // 文件名是 uin，靠 label（记忆文件第一行的标题）才认得出是谁。
  const list = el('div', { class: 'memlist' }, files.map((file) => el('button', {
    class: file.path === memPath ? 'primary mini' : 'mini',
    'data-active': file.path === memPath ? 'true' : null,
    title: file.path + ' · ' + bytes(file.bytes) + ' · ' + stamp(file.mtimeMs),
    onclick: () => openMemory(file.path),
  }, file.label || file.path)));
  const body = [
    el('div', { class: 'chips' },
      el('span', { class: 'chip' }, '日记 ', el('b', {}, int(counts.diary))),
      el('span', { class: 'chip' }, '人物卡 ', el('b', {}, int(counts.person))),
      el('span', { class: 'chip' }, '群记录 ', el('b', {}, int(counts.group))),
      el('span', { class: 'chip' }, '目录 ', el('b', {}, clamp(memoryData.dir, 60)))),
    list,
  ];
  if (!files.length) {
    body.push(el('div', { class: 'empty' }, '这个目录里还没有 .md'));
  } else if (!memPath) {
    body.push(el('div', { class: 'empty' }, '挑一份看'));
  } else {
    const meta = files.find((file) => file.path === memPath);
    const box = el('textarea', { spellcheck: 'false' });
    box.value = memText;
    body.push(
      el('div', { class: 'actions' },
        el('span', { class: 'muted', style: 'font-size:11.5px' },
          (meta && meta.label ? meta.label + ' · ' : '') + memPath
            + (meta ? ' · ' + bytes(meta.bytes) + ' · ' + dur(Date.now() - meta.mtimeMs) + '前' : '')),
        el('button', { class: 'primary mini', onclick: async () => {
          try {
            const result = await api('/admin/memory/file', {
              method: 'POST', body: JSON.stringify({ path: memPath, text: box.value }),
            });
            if (meta) { meta.bytes = result.bytes; meta.mtimeMs = result.mtimeMs; }
            memText = box.value;
            flash(memPath + ' 已保存' + (result.backup ? '（旧版已备份）' : ''));
          } catch (error) {
            flash('保存失败：' + error.message, 'bad');
          }
        } }, '保存'),
        el('button', { class: 'mini', onclick: () => openMemory(memPath) }, '重新读盘')),
      box);
  }
  els.tabBody.replaceChildren(...body);
}



/* —— 取数 —— */

function headers(extra) {
  const base = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
  return { ...base, ...(extra || {}) };
}

async function load() {
  try {
    const response = await fetch(API, { headers: headers(), cache: 'no-store' });
    if (response.status === 401) {
      authFailed = true;
      renderBanner();
      renderStamp();
      return;
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    snap = data;
    fetchedAt = Date.now();
    lastError = '';
    authFailed = false;
    renderAll();
  } catch (error) {
    lastError = String(error?.message ?? error);
    renderBanner();
    renderStamp();
  }
}

function renderAll() {
  renderHeader();
  renderVerdicts();
  renderSessions();
  // 设置/记忆这两页有自己的表单状态（草稿、选中的文件），轮询重绘会把它们冲掉，
  // 所以只在这三张只读表上跟着 30 秒节拍刷新。
  if (tab === 'tasks' || tab === 'delivery' || tab === 'failures') renderTab();
  // 会话详情里有一部分数字来自快照（任务/投递/心跳），跟着刷新但**不重新拉接口**：
  // 窗口和事件流是历史，没必要每 30 秒再读一次库。
  if (sessionKey) renderSessionDetail();
  renderRecent();
  els.raw.textContent = JSON.stringify(snap);
  renderStamp();
  renderBanner();
}

async function toggleHosting() {
  const next = !S().agentEnabled;
  const question = next
    ? '开启托管？开启后她会继续回复群聊与私聊。'
    : '关闭托管？关闭后新消息只入缓冲，她不会再回复，直到你重新开启。';
  if (!window.confirm(question)) return;
  try {
    const response = await fetch(API + '/control', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ enabled: next }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error('HTTP ' + response.status + (detail ? ' · ' + clamp(detail, 120) : ''));
    }
    await load();
  } catch (error) {
    lastError = '切换托管失败：' + String(error?.message ?? error);
    renderBanner();
  }
}

/* —— 轮询 —— */

function schedule() {
  clearTimeout(pollTimer);
  if (!autoPolling || authFailed || document.hidden) return;
  pollTimer = setTimeout(async () => {
    await load();
    schedule();
  }, POLL_MS);
}

els.refresh.addEventListener('click', () => load().then(schedule));
els.auto.addEventListener('change', () => {
  autoPolling = els.auto.checked;
  schedule();
});
els.allSessions.addEventListener('change', () => {
  showAll = els.allSessions.checked;
  renderSessions();
});
els.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) setTab(button.dataset.tab);
});
els.toggle.addEventListener('click', toggleHosting);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    load();
    schedule();
  }
});

/* —— 昼夜主题：<head> 里已经定好首帧，这里只负责按钮与记忆 —— */

const THEME_KEY = 'qq-panel-theme';

function themeName() {
  return document.documentElement.dataset.theme === 'night' ? 'night' : 'day';
}

function paintTheme() {
  const day = themeName() === 'day';
  // 按钮上写的是「点了会变成什么」，不是当前值。
  els.theme.textContent = day ? '夜' : '昼';
  els.theme.title = day ? '切到夜间（墨夜）' : '切到白天（宣纸）';
  els.theme.setAttribute('aria-label', els.theme.title);
}

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (error) {
    // 隐私模式/无 storage 时不记忆，本次照样生效。
  }
  paintTheme();
}

els.theme.addEventListener('click', () => applyTheme(themeName() === 'day' ? 'night' : 'day'));
paintTheme();

els.sessionClose.addEventListener('click', hideSession);

setInterval(renderStamp, 1000);
// 会话详情也能分享：panel?session=group:123 直接把那个会话摊开。
const wantedSession = new URLSearchParams(location.search).get('session');
// tab 可以分享：panel?tab=delivery 直接落在那页（token 参数照旧由 URL 带）。
const wantedTab = new URLSearchParams(location.search).get('tab');
if (wantedTab && ['tasks', 'delivery', 'failures', 'settings', 'memory'].includes(wantedTab)) {
  tab = wantedTab;
  for (const button of els.tabs.querySelectorAll('button'))
    button.dataset.active = String(button.dataset.tab === tab);
  if (tab === 'settings') ensureSettings().then(() => { if (tab === 'settings') renderSettings(); });
  if (tab === 'memory') ensureMemory().then(() => { if (tab === 'memory') renderMemory(); });
  if (tab === 'failures') ensureAudit();
}

load().then(() => {
  if (wantedSession) toggleSession(wantedSession);
  schedule();
});
