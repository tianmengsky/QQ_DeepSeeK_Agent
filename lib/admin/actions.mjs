import fs from 'node:fs';
import path from 'node:path';

import { replyJournal } from '../delivery/reply-journal.mjs';

/**
 * 面板的写操作层。
 *
 * 之前的六个 admin 接口都是「读文件 / 改配置」，各自一个路由还撑得住；
 * 一旦开始做处置（把一条 UNKNOWN 回执判成已发、放弃一条隔离投递、结束一个卡住
 * 的执行），如果继续「一个动作一条路由」，很快就会出现十几个形状各异的接口：
 * 有的要 body、有的要 query、有的没法重放、有的忘了审计。
 *
 * 所以收成一个入口：`POST {base}/admin/action { id, args, idemKey }`。
 * 每个动作在 `ACTIONS` 里登记一次（面板靠它渲染按钮），执行统一走
 * 参数校验 → 幂等检查 → 执行 → 审计落盘 → 返回结果。
 *
 * 依赖是**晚绑定**的：`createAdmin` 在 bootstrap 里跑得很早（要赶在心跳、
 * 调度器构造之前应用覆盖层），那时候 store/registry/queue 都还没建好。
 * 所以这里只保存一个 `bind(deps)`，等 bootstrap 建完再一次性塞进来。
 */

const AUDIT_FILE = 'panel-audit.jsonl';
const AUDIT_MEMORY = 200;

/** 动作登记表：面板拿它渲染按钮，路由拿它校验。 */
export const ACTIONS = [
  {
    id: 'receipt.markSent',
    label: '确认已发出',
    group: 'receipt',
    help: '把一条「结果未知」的回执判成已发送。只有人真的去群里看过了才该点。',
    danger: false,
    params: [
      { name: 'idemKey', type: 'string', required: true, label: '幂等键' },
      { name: 'detail', type: 'string', max: 200, label: '备注' },
    ],
  },
  {
    id: 'receipt.markFailed',
    label: '确认没发出',
    group: 'receipt',
    help: '把一条「结果未知」的回执判成失败，之后不会再被当成待核对。',
    danger: false,
    params: [
      { name: 'idemKey', type: 'string', required: true, label: '幂等键' },
      { name: 'detail', type: 'string', max: 200, label: '备注' },
    ],
  },
  {
    id: 'delivery.abandon',
    label: '放弃投递',
    group: 'delivery',
    help: '把一条待送达/隔离的回复直接判死。放弃了就真的不会发出去。',
    danger: true,
    params: [
      { name: 'id', type: 'int', required: true, min: 1, label: '记录号' },
    ],
  },
  {
    id: 'delivery.retry',
    label: '重新排队',
    group: 'delivery',
    help: '把一条待送达的记录立刻重新放回重试队列（不再等隔离冷却）。',
    danger: false,
    params: [
      { name: 'id', type: 'int', required: true, min: 1, label: '记录号' },
    ],
  },
  {
    id: 'task.settle',
    label: '结束执行',
    group: 'task',
    help: '把一个卡住的执行判为结束。任务实体会跟着变成 failed（不做成 done，免得谎报完成）。',
    danger: true,
    params: [
      { name: 'id', type: 'string', required: true, max: 80, label: '执行 ID' },
    ],
  },
  {
    id: 'queue.flush',
    label: '冲刷队列',
    group: 'queue',
    help: '等出站队列排空（最多等 timeoutMs），用来确认「到底是慢还是卡死」。',
    danger: false,
    params: [
      { name: 'timeoutMs', type: 'int', min: 1000, max: 120000, label: '最多等多久' },
    ],
  },
  {
    id: 'conversation.reset',
    label: '清空上下文',
    group: 'conversation',
    help: '把这个会话的窗口和进行中的状态清掉。下一次发言从零开始。',
    danger: true,
    params: [
      { name: 'key', type: 'string', required: true, max: 80, label: '会话' },
    ],
  },
  {
    id: 'heartbeat.poke',
    label: '现在催一次',
    group: 'heartbeat',
    help: '跳过一次冷却，让这个群的心跳立刻判断一次要不要插话。',
    danger: false,
    params: [
      { name: 'key', type: 'string', required: true, max: 80, label: '会话' },
    ],
  },
];

export const ACTION_BY_ID = new Map(ACTIONS.map((entry) => [entry.id, entry]));

function coerceParam(spec, raw) {
  if (raw === undefined || raw === null || raw === '') {
    if (spec.required) return { ok: false, error: `${spec.label ?? spec.name} 不能为空` };
    return { ok: true, value: undefined };
  }
  if (spec.type === 'int') {
    const value = Number(raw);
    if (!Number.isInteger(value)) return { ok: false, error: `${spec.label ?? spec.name} 必须是整数` };
    if (spec.min !== undefined && value < spec.min) {
      return { ok: false, error: `${spec.label ?? spec.name} 不能小于 ${spec.min}` };
    }
    if (spec.max !== undefined && value > spec.max) {
      return { ok: false, error: `${spec.label ?? spec.name} 不能大于 ${spec.max}` };
    }
    return { ok: true, value };
  }
  const text = String(raw);
  if (spec.max !== undefined && text.length > spec.max) {
    return { ok: false, error: `${spec.label ?? spec.name} 太长了（上限 ${spec.max} 字）` };
  }
  return { ok: true, value: text };
}

function validate(spec, args) {
  const out = {};
  for (const param of spec.params ?? []) {
    const result = coerceParam(param, args?.[param.name]);
    if (!result.ok) return result;
    if (result.value !== undefined) out[param.name] = result.value;
  }
  return { ok: true, value: out };
}

const HANDLERS = {
  async 'receipt.markSent'(deps, args) {
    if (!deps.store?.available) throw new Error('回执库不可用');
    const ok = deps.store.finishSend(args.idemKey, 'SUCCEEDED', {
      detail: args.detail || '面板人工确认：已发出',
    });
    if (!ok) throw new Error('写回执失败，库可能不可用');
    return { idemKey: args.idemKey, status: 'SUCCEEDED' };
  },
  async 'receipt.markFailed'(deps, args) {
    if (!deps.store?.available) throw new Error('回执库不可用');
    const ok = deps.store.finishSend(args.idemKey, 'FAILED', {
      detail: args.detail || '面板人工确认：没发出',
    });
    if (!ok) throw new Error('写回执失败，库可能不可用');
    return { idemKey: args.idemKey, status: 'FAILED' };
  },
  async 'delivery.abandon'(deps, args) {
    const journal = replyJournal(deps.store);
    if (!journal) throw new Error('投递记录不可用');
    const changed = journal.abandon(args.id, args.detail || '面板手动放弃');
    if (!changed) throw new Error('没有这条待送达记录（可能已经结束了）');
    return { id: args.id, changed };
  },
  async 'delivery.retry'(deps, args) {
    const journal = replyJournal(deps.store);
    if (!journal) throw new Error('投递记录不可用');
    const state = journal.error(args.id, '面板手动重排', { retryAt: Date.now() });
    return { id: args.id, state };
  },
  async 'task.settle'(deps, args) {
    if (!deps.taskRouting) throw new Error('任务调度没启用');
    if (!deps.taskRouting.execution(args.id)) throw new Error('没有这个执行');
    deps.taskRouting.setExecution(args.id, 'failed', {
      panelNote: '面板手动结束',
      panelAt: Date.now(),
    });
    return { id: args.id, state: 'failed' };
  },
  async 'queue.flush'(deps, args) {
    if (!deps.sendQueue) throw new Error('发送队列没启用');
    const timeoutMs = args.timeoutMs ?? 15000;
    const before = deps.sendQueue.stats?.().items ?? null;
    const drained = await deps.sendQueue.flush(timeoutMs);
    const after = deps.sendQueue.stats?.() ?? {};
    return { drained, before, items: after.items ?? null, inFlightMs: after.inFlightMs ?? null };
  },
  async 'conversation.reset'(deps, args) {
    if (!deps.registry) throw new Error('会话表没启用');
    if (!deps.registry.entry(args.key)) throw new Error('没有这个会话');
    deps.registry.reset(args.key);
    return { key: args.key };
  },
  async 'heartbeat.poke'(deps, args) {
    if (!deps.registry) throw new Error('会话表没启用');
    const poke = deps.pokeHeartbeat?.(args.key);
    if (poke && poke.ok === false) throw new Error(poke.error);
    return { key: args.key, pending: poke?.pending ?? null };
  },
};

export function createAdminActions({ config, dataDir, clock = Date.now, logger = null } = {}) {
  const file = dataDir ? path.join(dataDir, AUDIT_FILE) : '';
  const recent = [];
  const replays = new Map();
  let deps = {};

  function bind(next = {}) {
    deps = { ...deps, ...next };
  }

  function remember(entry) {
    recent.push(entry);
    if (recent.length > AUDIT_MEMORY) recent.shift();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (error) {
      logger?.warn?.(`qq-bridge: 审计写入失败 —— ${error?.message ?? error}`);
    }
  }

  /**
   * 执行一个动作。
   *
   * `idemKey` 不是可选的礼貌 —— 面板的按钮会重试（双击、网络重发、刷新后重点）。
   * 同一个 key 第二次进来直接返回第一次的结果，不重复改库。
   */
  async function run(id, args = {}, { idemKey = '', memo = '' } = {}) {
    const spec = ACTION_BY_ID.get(id);
    if (!spec) return { ok: false, error: `没有这个动作：${id}` };
    if (idemKey && replays.has(idemKey)) {
      return { ok: true, replay: true, action: id, result: replays.get(idemKey) };
    }
    const parsed = validate(spec, args);
    if (!parsed.ok) {
      remember({ at: clock(), action: id, args: args ?? {}, memo, idemKey, ok: false, error: parsed.error });
      return { ok: false, error: parsed.error };
    }
    const at = clock();
    try {
      const result = await HANDLERS[id]({ ...deps, config }, parsed.value);
      remember({ at, action: id, args: parsed.value, memo, idemKey, ok: true, result });
      if (idemKey) replays.set(idemKey, result);
      return { ok: true, action: id, result };
    } catch (error) {
      const message = String(error?.message ?? error);
      remember({ at, action: id, args: parsed.value, memo, idemKey, ok: false, error: message });
      return { ok: false, action: id, error: message };
    }
  }

  return {
    bind,
    run,
    get file() {
      return file;
    },
    /** 审计是只读的：面板显示最近 60 条，不提供清除接口。 */
    snapshot() {
      /**
       * 内存里没有就回读文件。
       *
       * HMR 每次改代码都会重载插件，内存里那份 `recent` 就没了；而"我十分钟前
       * 点过放弃、到底成没成"正是重载之后最想查的。所以文件才是账本本身。
       */
      if (!recent.length && file) {
        try {
          const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
          for (const line of lines.slice(-AUDIT_MEMORY)) {
            try {
              recent.push(JSON.parse(line));
            } catch {
              /* 半行/坏行跳过：账本不能因为一行写坏就整个不显示 */
            }
          }
        } catch {
          /* 还没有审计文件 */
        }
      }
      return { file: file || null, recent: recent.slice(-60) };
    },
  };
}
