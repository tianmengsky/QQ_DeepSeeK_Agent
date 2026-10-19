import { renderMessage, stripLeadingSelfMentions } from '../domain/events.mjs';
import { resolvePersona } from '../prompt/text-sources.mjs';
import { buildPromptContent } from '../prompt/prepare.mjs';
import { buildMemorySection, buildWindowSection } from '../prompt/render.mjs';
import { onebotCall } from '../transport/onebot-client.mjs';
import { recordContext } from '../conversation/context.mjs';
import { planWindowInjection } from '../conversation/injection.mjs';
import { conversationFactsEnabled } from '../memory/facts.mjs';
import { debugSnapshot, renderDebugStatus, redact } from './debug-status.mjs';

function chunkText(text, size = 1800) {
  size = Math.max(1, Math.floor(Number(size) || 1800));
  const points = Array.from(String(text ?? ''));
  if (!points.length) return [''];
  const result = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + size, points.length);
    if (end < points.length) {
      const line = points.lastIndexOf('\n', end - 1);
      if (line >= start + Math.floor(size / 2)) end = line + 1;
    }
    result.push(points.slice(start, end).join(''));
    start = end;
  }
  return result;
}
export function parseDebugCommand(text, prefix = '#debug') {
  if (!text.startsWith(prefix)) return null;
  const rest = text.slice(prefix.length);
  if (rest && !/^\s/u.test(rest)) return null;
  const [command = 'help', ...args] = rest.trim().split(/\s+/u).filter(Boolean);
  return { command: command.toLowerCase(), args };
}
const targetKey = (value) => (/^(group|user):\d+$/.test(value || '') ? value : null);
const usage = (prefix) =>
  [
    '【调试命令】',
    prefix + ' status                 简洁运行状态',
    prefix + ' status detail          全部诊断信息',
    prefix + ' status json            有界结构化状态',
    prefix + ' status group:群号      查看一个已有群会话',
    prefix + ' heartbeat [group:群号] 未读进度、冷却、最近判断',
    prefix + ' sessions [页码]        所有会话（每页 20 个）',
    prefix + ' delivery               发送队列和回执',
    prefix + ' events                 上报分类和处理计数',
    prefix + ' config                 当前生效策略和模型',
    prefix + ' persona                实际人设原文',
    prefix + ' prompt [group:群号]    提示词预览，不提交模型',
    prefix + ' memory [QQ号]          记忆内容；默认自己与最近参与者',
    prefix + ' help                   查看帮助',
    '',
    '仅管理员名单可用；结果一律私聊。会话参数也支持 user:QQ号。',
    '状态为只读查询，计数自最近一次插件加载起累计。',
  ].join('\n');

export async function probeOneBot(config) {
  const results = await Promise.allSettled([
    onebotCall(config, 'get_login_info', {}, 3000),
    onebotCall(config, 'get_status', {}, 3000),
  ]);
  const login = results[0].status === 'fulfilled' ? results[0].value : null;
  const status = results[1].status === 'fulfilled' ? results[1].value : null;
  const reachable = results.some((r) => r.status === 'fulfilled');
  const online = typeof status?.online === 'boolean' ? status.online : null;
  const good = typeof status?.good === 'boolean' ? status.good : null;
  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => {
      const cause = r.reason?.cause?.code ?? r.reason?.cause?.message;
      return redact(String(r.reason?.message ?? r.reason) + (cause ? ' (' + cause + ')' : ''), config).slice(0, 160);
    });
  const label =
    online === true
      ? 'QQ 在线'
      : online === false
        ? 'QQ 离线'
        : reachable
          ? '接口可达，QQ 在线状态未知'
          : '接口不可达';
  return {
    reachable,
    online,
    good,
    account: login?.user_id ?? null,
    text:
      label +
      (good === false ? '（服务异常）' : '') +
      (login?.user_id ? ' · 账号 ' + login.user_id : '') +
      (errors.length ? ' · ' + errors.join('；') : ''),
  };
}

async function maybeHandleDebug(ctx, config, event, entry, memory, stats, state, registry) {
  const allowed = (config.debugUsers ?? []).map(String).filter(Boolean);
  const sender = String(event.user_id ?? '');
  if (!allowed.includes(sender)) return false;
  const prefix = config.debugPrefix || '#debug';
  const selfIds = [...(config.selfIds ?? []), ...(event.self_id != null ? [event.self_id] : [])];
  const text = renderMessage(stripLeadingSelfMentions(event.message, selfIds)).trim();
  const parsed = parseDebugCommand(text, prefix);
  if (!parsed) return false;
  const { command, args } = parsed;
  const key = event.message_type === 'group' ? 'group:' + event.group_id : 'user:' + sender;
  let out;
  const invalid = (hint) =>
    '参数不正确。用法：' + prefix + ' ' + hint + '\n完整帮助：' + prefix + ' help';
  const resolveEntry = (target) => (target ? registry.byKey.get(target) : entry);
  switch (command) {
    case 'help':
      out = args.length ? invalid('help') : usage(prefix);
      break;
    case 'status':
    case 'heartbeat':
    case 'sessions':
    case 'delivery':
    case 'events':
    case 'config': {
      const argument = args[0],
        target = targetKey(argument),
        mode = argument?.toLowerCase();
      const page = command === 'sessions' && /^\d+$/.test(argument || '') ? Number(argument) : 1;
      const valid =
        args.length <= 1 &&
        (command === 'status'
          ? !argument || ['detail', 'json'].includes(mode) || target
          : command === 'heartbeat'
            ? !argument || target?.startsWith('group:')
            : command === 'sessions'
              ? !argument || (Number.isSafeInteger(page) && page > 0 && /^\d+$/.test(argument))
              : !argument);
      if (!valid) {
        out = invalid(command);
        break;
      }
      if (target && !resolveEntry(target)) {
        out = '尚未记录会话 ' + target + '。不会为查询新建会话。';
        break;
      }
      const report = debugSnapshot(config, registry, state, stats, memory, registry.store, {
        target,
        page,
      });
      if (command === 'sessions' && report.pages && page > report.pages) {
        out = '页码超出范围，共 ' + report.pages + ' 页。';
        break;
      }
      if (command === 'status') report.connection = await probeOneBot(config);
      out =
        mode === 'json'
          ? JSON.stringify(report, null, 2)
          : renderDebugStatus(report, { section: command, detail: mode === 'detail', prefix });
      break;
    }
    case 'persona': {
      if (args.length) {
        out = invalid('persona');
        break;
      }
      const persona = resolvePersona(config);
      out =
        `【实际人设】${persona.length} 字\n来源：${config.personaFile || '配置内联 persona'}\n` +
        persona;
      break;
    }
    case 'prompt': {
      const target = targetKey(args[0]);
      if (args.length > 1 || (args.length && !target)) {
        out = invalid('prompt [group:群号或user:QQ号]');
        break;
      }
      const source = resolveEntry(target);
      if (!source) {
        out = '尚未记录会话 ' + target + '。';
        break;
      }
      const snapshot = {
        ...source,
        window: source.window.slice(),
        recentQqs: [...source.recentQqs],
      };
      for (const item of [...(source.pendingContext ?? []), ...source.pending])
        recordContext(config, snapshot, { ...item, bot: false });
      const conversation = target || key,
        [kind, id] = conversation.split(':');
      const preview = {
        ...event,
        message_type: kind === 'group' ? 'group' : 'private',
        group_id: kind === 'group' ? Number(id) : undefined,
        user_id: kind === 'user' ? Number(id) : event.user_id,
        sender: kind === 'user' && id !== sender ? { nickname: id } : event.sender,
        message_id: undefined,
        raw_message: '',
        message: [{ type: 'text', data: { text: '（调试预览：当前消息占位，未提交模型）' } }],
      };
      const content = await buildPromptContent(
        ctx,
        config,
        preview,
        {},
        {
          memoryText: buildMemorySection(config, preview, snapshot, memory),
          windowText: buildWindowSection(config, { ...snapshot,
            window: planWindowInjection(config, snapshot, snapshot.window).messages }),
          windowMessages: snapshot.window,
          includeStatic: !config.injectStaticOnce || !snapshot.staticDone,
          includeWindow: true,
          windowDelta: config.injectWindowOnce && snapshot.turns > 0,
          awake: Date.now() < snapshot.awakeUntil,
          stickerAllowed: snapshot.turnsSinceSticker >= config.stickerMinGapTurns,
          stickerGap: snapshot.turnsSinceSticker,
        },
      );
      const plain = content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      out =
        `【提示词预览】${conversation} · ${plain.length} 字\n` +
        '使用当前窗口与未读快照；当前消息为占位，实际请求还取决于触发方式与回复抽签。\n' +
        plain;
      break;
    }
    case 'memory': {
      if (args.length > 1 || (args.length && !/^\d+$/.test(args[0]))) {
        out = invalid('memory [QQ号]');
        break;
      }
      if (!memory) {
        out = '记忆功能关闭。';
        break;
      }
      const qq = args[0] || sender;
      const lines = [`【QQ ${qq} 的记忆】`, memory.read(qq) || '暂无已保存记忆。'];
      if (!args.length) {
        for (const other of (entry.recentQqs ?? []).filter((x) => x !== qq).slice(0, 3)) {
          const doc = memory.read(other);
          if (doc) lines.push('', `【最近参与者 ${other} 的记忆】`, doc);
        }
        const facts = memory.activeFacts?.(key) ?? [];
        if (facts.length)
          lines.push('', conversationFactsEnabled(config) ? '【本会话约定】'
            : '【本会话约定：已关闭注入与提炼，以下仅为存档】', ...facts.slice(-10).map((f) => '- ' + f.fact));
      }
      out = lines.join('\n');
      break;
    }
    default:
      out = '未知命令：' + command + '\n\n' + usage(prefix);
  }
  const pieces = chunkText(redact(out, config));
  for (let i = 0; i < pieces.length; i++) {
    const message =
      (pieces.length > 1 ? `【调试结果 ${i + 1}/${pieces.length}】\n` : '') + pieces[i];
    await onebotCall(config, 'send_private_msg', { user_id: Number(sender), message });
  }
  stats.debugCommands = (stats.debugCommands ?? 0) + 1;
  ctx.logger.info(`qq-bridge: [debug] ${sender} 执行 ${prefix} ${command}`);
  return true;
}
export { chunkText, maybeHandleDebug };
