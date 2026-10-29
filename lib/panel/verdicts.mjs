/**
 * 面板判定：把 `GET /qq/onebot` 的快照压成「现在哪坏了」。
 *
 * 为什么单独一个文件、并且**什么都不 import**：这份代码同时跑在两个地方 ——
 * node 里的单测，和浏览器里的面板页（服务端把它原样内联进 HTML）。
 * 有 node 依赖就进不了浏览器；有 store/registry 依赖就得为测试造一座桥。
 * 所以它只吃一个 JSON 快照，返回纯数据，阈值全在下面这个常量里。
 *
 * 判定项形状：`{id, level: 'error'|'warn'|'info'|'ok', label, detail, goTo}`。
 * `goTo` 只用来让页面点一下跳到对应 tab，不是链接。
 */

export const LEVEL_RANK = { error: 0, warn: 1, info: 2, ok: 3 };

export const THRESHOLDS = {
  /** 任务在 recovering 里挂多久算「卡住」。 */
  stuckMs: 6 * 3600 * 1000,
  /** 首字 p50 超过这个数就是「慢」。线上实测 p50 约 20s。 */
  slowTtftMs: 15000,
  /** 在途批次超过这个数还没发完 = 一批卡在半路，不是空闲。 */
  queueStallMs: 15000,
  /** 投递失败多久之内算「还热着」，更早的只进 tab 不报警。 */
  deliveryFailWindowMs: 24 * 3600 * 1000,
};

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value) => (value === null || value === undefined ? '' : String(value));
const cut = (value, max) => {
  const s = text(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
};

/** 中文短时长：42秒 / 3分12秒 / 2小时5分 / 3天2小时。 */
export function describeDuration(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 60) return seconds + '秒';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return days + '天' + (hours % 24 ? (hours % 24) + '小时' : '');
  if (hours) return hours + '小时' + (minutes % 60 ? (minutes % 60) + '分' : '');
  return minutes + '分' + (seconds % 60 ? (seconds % 60) + '秒' : '');
}

/** 分位数（nearest-rank：p95 落在接近最差的那个样本上，而不是它下面一格）。
 *  样本不足/非法值时给 null —— 页面显示破折号，不显示假 0。 */
export function percentile(values, p) {
  const xs = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const index = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[index];
}

/**
 * @param {object|null} status `/qq/onebot` 的 JSON 快照
 * @param {number} now
 * @returns {{id:string, level:string, label:string, detail:string, goTo:string|null}[]}
 */
export function verdicts(status, now = Date.now()) {
  if (!status || typeof status !== 'object' || status.ok === false) {
    return [{
      id: 'no-data', level: 'error', label: '读不到状态',
      detail: '自检接口没有给出可用快照 —— 插件可能正在重载，或这个页面已经和桥接脱节', goTo: null,
    }];
  }

  const out = [];
  const push = (id, level, label, detail, goTo = null) => out.push({ id, level, label, detail, goTo });
  const stats = status.stats ?? {};
  const recovery = status.stats?.recovery ?? {};

  // —— 硬失败：这三条意味着"她根本不会说话" ——
  if (status.agentEnabled === false)
    push('enabled', 'error', '托管关着',
      'agentEnabled=false：新消息只入缓冲，不会有回合。确认是有意关的', null);

  const login = status.登录 ?? {};
  if (login.当前 && login.当前 !== 'online')
    push('login', 'error', 'QQ 不在线',
      `当前=${login.当前}` + (login.原因 ? ' · ' + login.原因 : '') +
        (login.最后一次探测 ? ' · 最近探测 ' + text(login.最后一次探测) : ''),
      null);

  const paused = Object.entries(recovery)
    .filter(([, lane]) => lane && lane.paused === true)
    .map(([label, lane]) => `${label}自 ${describeDuration(now - num(lane.since))}前暂停`);
  if (status.回复恢复?.paused === true && !paused.some((line) => line.startsWith('投递恢复')))
    paused.push('投递恢复自 ' + describeDuration(now - num(status.回复恢复.since)) + '前暂停');
  if (paused.length)
    push('recovery', 'error', '后台恢复循环停了',
      paused.join('；') + ' —— planned 行不会再有人去发，而队列和登录都显示正常', 'tasks');

  if (text(stats.lastError).trim())
    push('lastError', 'error', '最近一次错误',
      cut(stats.lastError, 300) +
        ' · ' + (stats.lastErrorAt ? describeDuration(now - num(stats.lastErrorAt)) + '前' : '时间未知（可能早已恢复）'),
      'failures');

  if (status.reliability?.持久化 == null)
    push('store', 'error', '持久化不可用',
      text(status.reliability?.说明) || '库没打开：回执、任务账本、投递计划全部不落盘', null);

  // —— 会把消息吃掉、但还活着的 ——
  const receipts = status.reliability?.发送回执 ?? {};
  const unknown = num(receipts.UNKNOWN);
  if (unknown > 0) {
    const oldest = (status.reliability?.待核对 ?? [])
      .map((row) => text(row.时间)).filter(Boolean).sort()[0];
    push('receipts', 'warn', unknown + ' 条发送回执结果未知',
      '不知道有没有真的发出去' + (oldest ? ' · 最早 ' + oldest : ''), 'failures');
  }

  const delivery = status.replyDelivery ?? {};
  const deliveryCounts = delivery.counts ?? {};
  const recentFailures = (delivery.failed ?? [])
    .filter((row) => now - num(row.updated_at) <= THRESHOLDS.deliveryFailWindowMs);
  if (recentFailures.length)
    push('deliveryFailed', 'warn', '24 小时内有 ' + recentFailures.length + ' 条投递失败',
      cut(recentFailures[0]?.detail, 200) || '看投递 tab 的失败原文', 'delivery');

  const quarantined = (delivery.pending ?? []).filter((row) => row.quarantined === true);
  if (quarantined.length)
    push('quarantine', 'warn', quarantined.length + ' 条投递被隔离',
      '这些计划的回合已经结束、但没确认发送，恢复时需人工核对', 'delivery');

  const tasks = status.tasks ?? {};
  const taskCounts = tasks.counts ?? {};
  const stuck = (tasks.active ?? [])
    .filter((task) => task.state === 'recovering' && num(task.elapsedMs) > THRESHOLDS.stuckMs);
  if (stuck.length) {
    const oldest = Math.max(...stuck.map((task) => num(task.elapsedMs)));
    push('tasksStuck', 'warn', stuck.length + ' 个恢复中的任务卡了很久',
      `最久 ${describeDuration(oldest)} · recovering ${num(taskCounts.recovering)} · ` +
        `failed ${num(taskCounts.failed)} · 这些任务占着会话，新的会被排队`, 'tasks');
  }

  const blocked = (status.replyPolicy?.sendQuotas ?? [])
    .filter((quota) => quota.minute?.blocked || quota.hour?.blocked)
    .map((quota) => `${quota.conversation}（${quota.minute?.blocked ? '分钟' : '小时'}档）`);
  if (blocked.length)
    push('quota', 'warn', '发送配额被限流',
      blocked.join('、') + ' —— 气泡被扣着没发，等窗口滑过去', 'delivery');

  const aux = status.auxHealth ?? {};
  if (aux.degraded === true)
    push('aux', 'warn', '辅助判断层降级',
      `成功率 ${Math.round(num(aux.successRate) * 100)}%（${num(aux.failed)}/${num(aux.calls)} 次失败，` +
        `阈值 ${Math.round(num(aux.threshold) * 100)}%）—— 路由/心跳/记忆提炼在走 fallback`, null);

  const queue = status.出站队列 ?? {};
  if (num(queue.items) > 0 && num(queue.inFlightMs) > THRESHOLDS.queueStallMs)
    push('queue', 'warn', '一批发送卡在半路',
      `在途 ${describeDuration(queue.inFlightMs)} · 排队 ${num(queue.items)} 项 · ${text(queue.inFlightKey) || '未知会话'}`,
      'delivery');

  const retrying = (status.heartbeat?.groups ?? []).filter((group) => group.phase === 'retry');
  if (retrying.length)
    push('heartbeat', 'warn', retrying.length + ' 个群的心跳在等重试',
      retrying.map((group) => `${group.conversation}（未读 ${num(group.unread)}）`).join('、'), null);

  // —— 只是慢 ——
  const ttftP50 = percentile(stats.ttftSamples, 0.5);
  if (ttftP50 != null && ttftP50 > THRESHOLDS.slowTtftMs) {
    const sendP50 = status.taskScheduler?.latency?.firstSuccessfulSend?.p50Ms;
    push('slow', 'info', '模型首字慢',
      `首字 p50 ${describeDuration(ttftP50)} / p95 ${describeDuration(percentile(stats.ttftSamples, 0.95))}` +
        (sendP50 != null ? ` · 首次投递 p50 ${describeDuration(sendP50)}` : '') +
        ` · ${num(stats.ttftSamples?.length)} 个样本`, null);
  }

  if (!out.length) {
    const conversations = num(status.conversations);
    push('ok', 'ok', '一切正常',
      `${conversations} 个会话 · 托管${status.agentEnabled ? '开' : '关'} · ` +
        `登录 ${text(login.当前) || '未知'} · 队列 ${num(queue.items)} 项`, null);
  }

  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}
