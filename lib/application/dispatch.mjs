/**
 * dispatch.mjs —— 派遣：脊柱只负责"想"，房间的事交给在那儿醒着的她去办。
 *
 * 为什么需要这一层（2026-11-01，用户）：「让脊柱 agent 往会话窗口发消息太割裂了。
 * 脊柱只负责想，怎么做交给对应窗口的 agent。」
 *
 * 脊柱（`self:account`）的视野是快照，不是现场。她隔着快照去改群名、发公告，
 * 做出来的事没有现场感，也接不上那个房间正在发生的对话。派遣把这件事翻过来：
 *
 *   · 脊柱（父会话）起一个念头，`qq_dispatch` 把念头派到目标窗口；
 *   · 桥接往目标窗口的会话注入一次合成回合（机制与脊柱唤醒同构，
 *     见 `proactive.mjs` 的 `#turnTick`），那个窗口自己的 LLM 带着房间的
 *     全部历史接下这件事，用自己的工具去办；
 *   · 子会话的产出走正常投递路径——气泡归属、60 秒窗口、配额、结算全部白捡；
 *   · 办完写回 `bridge_dispatches`，脊柱下一次醒来从世界快照看到回执。
 *
 * 边界（用提示词说清，不靠工具拦）：
 *   · 元认知类（改自己的名字、签名、头像、本子）→ 脊柱自己动手；
 *   · 房间身份类（群名、公告、头衔、起话题、撤消息）→ 派给那间屋子。
 *   · `qq_dispatch` 只在 `self:` 来源可用：房间里的她调它会被拒——念头不该
 *     在房间里再派一次，否则子会话派回脊柱、脊柱再派回来，能绕圈。
 *
 * 三条硬规矩，都是既有线上教训的直接套用：
 *   1. **fire-and-forget**。脊柱的回合只花"记账 + 排队"那几毫秒；真正的回合
 *      排进目标窗口的执行链（`registry.run`），不打断在场对话，也不让脊柱等——
 *      等一个房间回合的十几秒会把脊柱自己那轮拖死（proactive.mjs 踩过）。
 *   2. **合成事件不留痕**。回合结束后把 marker 从窗口滑动窗口里摘掉
 *      （同 `#turnTick` 的 `#dropSelfTurn`）：念头不是房间里说过的话，
 *      摘掉了才不会冒充"你：……"进她的历史。
 *   3. **崩溃如实对账**。桥接重载会杀掉内存里的执行链，queued/running 的
 *      派遣全部标 `needs_attention`，不假装还能续跑（同 `subagent-results.mjs`）。
 */
import { randomUUID } from 'node:crypto';
import { executeTurn } from './execute-turn.mjs';
import { describeActions } from './proactive.mjs';
import {
  windowNames, permittedConversation, listRecentWindows, conversationLabel,
  aliasOf, conversationOf,
} from '../conversation/window-index.mjs';
import { boundSource } from '../agent/execution-scope.mjs';

/** 目标窗口的准入：和消息准入同一套判据（开关 + 白名单），别处的窗口不派。 */
function permitted(config, key) {
  return permittedConversation(config, key);
}

/**
 * 合成派遣事件。抽成纯函数是为了能离线钉形状：
 * `__selfTurn` 让准入放行自己（同脊柱回合），`__dispatch` 让提示词换一帧
 * ——念头不是"现在这条消息（要回应的是这一条）"，见 `prompt/render.mjs`。
 */
export function dispatchEvent({ id, target, instruction, selfId }) {
  const isGroup = target.startsWith('group:');
  const text = `（你自己的念头）${instruction}`;
  return {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    ...(isGroup ? { group_id: Number(target.slice(6)) } : { user_id: Number(target.slice(5)) }),
    // 群里"她自己在场"，user_id 用她自己（同 #turnTick）；私聊才是对面那个人。
    user_id: isGroup ? Number(selfId) || 1 : Number(target.slice(5)),
    self_id: selfId,
    message_id: `dispatch:${id}`,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { nickname: '念头' },
    __selfTurn: true,
    __dispatch: true,
  };
}

/** 合成事件不是房间历史的一部分：办完从滑动窗口里摘掉，别让它冒充谁说过的话。 */
function dropMarker(registry, key, marker) {
  try {
    const entry = registry?.entry?.(key);
    if (!entry?.window) return;
    const before = entry.window.length;
    entry.window = entry.window.filter((m) => String(m?.messageId ?? '') !== marker);
    if (entry.window.length !== before) registry?.persist?.(key, entry);
  } catch { /* 摘不掉只是历史里多一行，不影响正确性 */ }
}

/** 一次派遣的真正执行：排进目标窗口的执行链后由这里接手。 */
async function runDispatchTurn({ ctx, config, registry, state, memory, stats, store },
  { id, target, instruction, signal }) {
  if (state.disposed) {
    store.updateDispatch(id, 'failed', '托管已关闭，这一件没有办');
    return;
  }
  const event = dispatchEvent({ id, target, instruction, selfId: config?.selfIds?.[0] });
  const marker = String(event.message_id);
  store.updateDispatch(id, 'running');
  try {
    // 和自主回合同一档超时：派遣办的是一件具体的事，不该比脊柱醒着的时间短。
    const budget = Math.max(30000, Number(config.proactiveTurnTimeoutMs) || 120000);
    const withTimeout = AbortSignal.timeout(budget);
    const outcome = await executeTurn(ctx, config, registry, state, memory, stats, store, target, event, {
      heartbeat: true,
      signal: signal ? AbortSignal.any([signal, withTimeout]) : withTimeout,
    });
    dropMarker(registry, target, marker);
    /**
     * 回执只写事实：动了什么手、说了什么话。不写"办得好不好"——
     * 那是评语，贴到脊柱眼前就成了替她判断（见 AGENTS.md 的材料规矩）。
     * "动了手"从工具调用证据里翻（同脊柱回合的 describeActions 口径），
     * "说了什么"取回合最终正文的前 200 字。
     */
    const acted = describeActions((outcome?.toolNames ?? [])
      .map((name) => String(name).replace(/^mcp__qq__/, ''))
      .filter((name) => !/^qq_send_(group|private)_msg$/.test(name)));
    const draft = String(outcome?.reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const result = [acted ? `动作：${acted}` : '', draft ? `说了：${draft}` : '']
      .filter(Boolean).join('；');
    store.updateDispatch(id, acted || draft ? 'done' : 'silent',
      result || '这一轮她看了看，没有动手');
  } catch (error) {
    dropMarker(registry, target, marker);
    if (!state.disposed) store.updateDispatch(id, 'failed',
      String(error?.message ?? error).slice(0, 200));
  }
}

/**
 * 排一次派遣。在目标窗口的执行链上排队：正在回人的窗口先回人，
 * 念头排在后面，不打断在场对话。返回排队 promise（调用方自行 catch）。
 */
export function scheduleDispatch(deps, { id, target, instruction, signal }) {
  const { registry } = deps;
  return registry.run(target, () => runDispatchTurn(deps, { id, target, instruction, signal }));
}

/**
 * 开机对账：内存里的执行链活不过重载，上一次没办完的派遣如实标出。
 * 返回标了多少条（0 条是常态）。
 */
export function sweepOrphanDispatches(store) {
  if (!store?.available) return 0;
  try {
    const res = store.db.prepare(
      "UPDATE bridge_dispatches SET state='needs_attention', "
      + "result='桥接重载时这一件还没办完；要不要重新派，由你自己决定', updated_at=? "
      + "WHERE state IN ('queued','running')",
    ).run(Date.now());
    return Number(res.changes) || 0;
  } catch {
    return 0;
  }
}

/**
 * `qq_dispatch` 工具本体。只在脊柱（`self:*` 来源）可用；房间里的她调它
 * 会得到一句明确的拒绝——念头在房间里就该直接动手，没有第二次派遣。
 */
export function dispatchTool({ ctx, config, registry, state, memory, stats, store }) {
  const deps = { ctx, config, registry, state, memory, stats, store };
  return {
    name: 'qq_dispatch',
    description:
      '把一件事派到某个窗口去办。群名、公告、头衔、起话头这类"那间屋子里的事"，' +
      '派给在那儿醒着的你——她看得见现场，由她决定怎么办、什么时候办。' +
      '不带 conversation 调一次，它会列出你现在能派的窗口（编号 w?）；' +
      'conversation=目标窗口编号（和 qq_windows 的编号同一份，也可以直接写 group:<群号>）；' +
      'instruction=你想在那边做的事（一句话，派方向不派剧本）。' +
      '只在你自己的时间能用；你自己的事（名字、签名、本子）不派，直接动手。' +
      '派出去的事会记在账里，下次你自己的时间能在快照里看到那边办得怎么样。',
    parameters: { type: 'object', properties: {
      conversation: { type: 'string', description: '目标窗口编号，如 w2（和 qq_windows 同一份编号；也可以直接写 group:<群号> / user:<号>）。不传就只列出能派的窗口' },
      instruction: { type: 'string', description: '想在那边做的事（一两句以内；是念头，不是步骤清单）' },
    }, required: ['instruction'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted();
      if (!store?.available || state.disposed || !state.enabled) throw new Error('派遣不可用：托管没有在跑');
      /**
       * 来源校验和窗口工具同一套：调用必须来自一个真实的 QQ 回合。
       * 在这个之上加一条：只有 `self:*`（她自己的时间）能派。
       */
      const origin = state.sourceLedger?.resolve?.(boundSource(store, exec.agent?.session?.id)?.sourceRef);
      if (!origin || !origin.qq || !origin.message_id) throw new Error('派遣来源无效或已过期');
      const here = String(origin.conversation ?? '');
      if (!here.startsWith('self:')) throw new Error('派遣只属于你自己的时间：在这间屋子里，想做什么直接动手');
      const session = exec.agent?.session?.id;
      const map = windowNames(store);
      /**
       * 不带目标就先报名册。
       *
       * 为什么需要：编号是 `qq_windows list` 发的，她没 list 过就没有编号可传——
       * 线上她按提示词传编号，两次都被拒，只好退回自己动手。工具自己能报名册，
       * "派"这件事就不再依赖她先做过别的调用。
       */
      const token = String(args.conversation ?? '').trim();
      if (!token) {
        const rows = listRecentWindows(store, config, { limit: 20 });
        const lines = ['这些是现在能派的窗口（编号两边通用，qq_windows 也认）：'];
        for (const row of rows) {
          const alias = aliasOf(session, row.conversation, store);
          const ago = Math.max(1, Math.round((Date.now() - Number(row.last_message_at || 0)) / 60000));
          lines.push(`- ${alias} ${conversationLabel(row.conversation, map)}｜${ago} 分钟前有动静`);
        }
        if (rows.length <= 0) lines.push('（这一周没有任何窗口有动静。）');
        return { status: 'WINDOWS', text: lines.join('\n') };
      }
      const target = conversationOf(session, token, store);
      if (!target) throw new Error('conversation 传窗口编号（如 w2；不带 conversation 调一次能拿到编号），或直接写 group:<群号>');
      if (!permitted(config, target)) throw new Error('这个窗口不在可派遣的范围里');
      const instruction = String(args.instruction ?? '').trim();
      if (!instruction) throw new Error('instruction 写你想在那边做的事');
      if (instruction.length > 200) throw new Error('念头最多 200 字：派的是方向，不是剧本');
      const id = `disp:${randomUUID()}`;
      if (!store.recordDispatch({ id, conversation: target, instruction }))
        throw new Error('派遣没能记账，这一次没有派出去');
      // fire-and-forget：排进目标窗口的执行链就返回。失败只会落进账里（failed），
      // 不回头打断脊柱这一轮——她已经把注意力交出去了，收不回来也不该收。
      scheduleDispatch(deps, { id, target, instruction, signal: state.controller?.signal })
        .catch((error) => {
          store.updateDispatch(id, 'failed', String(error?.message ?? error).slice(0, 200));
          if (!state.disposed) ctx.logger?.warn?.(`qq-bridge: 派遣 ${id} 执行失败 —— ${error?.message ?? error}`);
        });
      return { status: 'DISPATCHED', id, to: aliasOf(session, target, store), name: conversationLabel(target, map), note: '已经把这件事派到那个窗口。那边怎么办由在那儿的你看着现场定；结果下次你自己的时间里能看到。' };
    },
  };
}
