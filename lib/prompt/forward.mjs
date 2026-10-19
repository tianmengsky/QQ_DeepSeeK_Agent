import { onebotCall } from '../transport/onebot-client.mjs';
import { renderMessage } from '../domain/events.mjs';

/** Return the forward segments in a OneBot message. */
function forwardSegments(message) {
  return Array.isArray(message) ? message.filter((s) => s?.type === 'forward') : [];
}

/**
 * A forward node is not completely uniform across OneBot implementations:
 * SnowLuma uses `content`, while a few adapters expose `message`. Keep the
 * normalisation here so prompt code never has to know those wire details.
 */
function nodeContent(node) {
  if (Array.isArray(node?.content)) return node.content;
  if (Array.isArray(node?.message)) return node.message;
  if (typeof node?.content === 'string' || typeof node?.message === 'string')
    return String(node.content ?? node.message);
  return '';
}

function nodeSender(node) {
  const sender = node?.sender ?? {};
  const id = sender.user_id ?? node?.user_id ?? node?.uin ?? '?';
  const name = sender.card || sender.nickname || node?.nickname || String(id);
  return { id: String(id), name: String(name || id) };
}

function nodeTime(node) {
  const value = Number(node?.time ?? node?.timestamp ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value < 100000000000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

/** Format already fetched forward nodes with a hard character/message budget. */
function formatForwardNodes(nodes, { maxMessages = 20, maxChars = 6000 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const lines = ['【合并转发内容】'];
  let used = lines[0].length;
  let count = 0;
  for (const node of list) {
    if (count >= Math.max(0, Number(maxMessages) || 0)) break;
    const body = typeof nodeContent(node) === 'string'
      ? nodeContent(node)
      : renderMessage(nodeContent(node));
    const text = String(body || '').trim() || '[非文字内容]';
    const sender = nodeSender(node);
    const time = nodeTime(node);
    const line = `[${sender.name}（QQ ${sender.id}${time ? `，${time}` : ''}）] ${text}`;
    const room = Math.max(0, Number(maxChars) || 0) - used - 1;
    if (line.length > room) {
      if (room > 0) lines.push(line.slice(0, Math.max(0, room - 8)) + '…[已截断]');
      break;
    }
    lines.push(line);
    used += line.length + 1;
    count += 1;
  }
  if (list.length > count) lines.push(`（其余 ${list.length - count} 条未展开）`);
  return lines.join('\n');
}

function asksToReadForward(text, triggers = []) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return false;
  const configured = (Array.isArray(triggers) ? triggers : []).some((item) => {
    const needle = String(item ?? '').trim().toLowerCase();
    return needle && value.includes(needle);
  });
  if (configured) return true;
  // Keep the lazy trigger surface aligned with image reading: direct verbs,
  // deictic references, and questions about the referenced object's content.
  return /(?:读|看|分析|描述|解释|辨认|认出|识别|提取|照着|按照|根据|总结|概括|展开|读取).{0,16}(?:合并转发|转发|转发里|里面|其中|这段|这条|这份|上面|上边|刚才|前面)/u.test(value) ||
    /(?:合并转发|转发|转发里|里面|其中|这段|这条|这份).{0,16}(?:什么|啥|怎么|怎样|内容|意思|说了什么|讲了什么|总结|概括|读|看|展开|分析)/u.test(value) ||
    /(?:看|读|分析|描述|解释).{0,8}(?:这|那)(?:个|条|段|份)?/u.test(value) ||
    /(?:这|那)(?:个|条|段|份)?(?:是)?(?:什么|啥)|这条啊|这段啊/u.test(value);
}

async function fetchForward(ctx, config, segment, { stats = null, signal } = {}) {
  const data = segment?.data ?? {};
  const id = data.id ?? data.resid ?? data.message_id;
  if (id == null || id === '') return { text: '【合并转发：缺少消息 ID】', loaded: false };
  try {
    const result = await onebotCall(config, 'get_forward_msg', { message_id: id },
      Math.max(1000, Number(config.forwardTimeoutMs) || 10000), signal);
    const nodes = Array.isArray(result) ? result : result?.messages ?? result?.nodes ?? [];
    if (!nodes.length) return { text: '【合并转发：没有可读取的节点】', loaded: false };
    stats && (stats.forwardMessagesRead = (stats.forwardMessagesRead ?? 0) + nodes.length);
    const maxMessages = Math.max(0, Number(config.forwardMaxMessages) || 0);
    const maxChars = Math.max(0, Number(config.forwardMaxChars) || 0);
    const text = formatForwardNodes(nodes, {
      maxMessages: config.forwardMaxMessages,
      maxChars: config.forwardMaxChars,
    });
    const shown = Math.min(nodes.length, maxMessages);
    return { text, loaded: true, count: nodes.length, forwardId: String(id), total: nodes.length,
      shown, hasMore: nodes.length > shown || /其余 \d+ 条未展开/u.test(text) };
  } catch (error) {
    ctx?.logger?.warn?.(`qq-bridge: 取合并转发失败 (${id}) —— ${error?.message ?? error}`);
    stats && (stats.forwardReadFailures = (stats.forwardReadFailures ?? 0) + 1);
    return { text: '【合并转发：内容暂时取不出来】', loaded: false };
  }
}

export { forwardSegments, formatForwardNodes, asksToReadForward, fetchForward };
