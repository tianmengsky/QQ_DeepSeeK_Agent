import { onebotCall } from '../transport/onebot-client.mjs';
import { renderMessage } from '../domain/events.mjs';

async function resolveQuote(ctx, config, event) {
  const empty = { text: '', images: [], forwards: [] };
  if (!Array.isArray(event.message)) return empty;
  const reply = event.message.find((s) => s?.type === 'reply');
  const id = reply?.data?.id;
  if (id === undefined || id === null || id === '') return empty;

  try {
    const quoted = await onebotCall(config, 'get_msg', { message_id: id });
    // 只给内容，不带 `[引用 …]` 外壳：调用方（render）会写成 `引用：名字（QQ 号，消息 id）：正文`，
    // 外壳留在里面就会出现「引用：[引用 …]」这种重复标记。
    if (!quoted) return { text: '（这条引用的消息取不到）', images: [], forwards: [] };
    const senderId = quoted.sender?.user_id ?? quoted.user_id ?? '?';
    const sender = quoted.sender?.card || quoted.sender?.nickname || String(senderId);
    const body = renderMessage(quoted.message);
    const short = body.length > 300 ? `${body.slice(0, 300)}…` : body;
    const images = Array.isArray(quoted.message)
      ? quoted.message.filter((s) => s?.type === 'image')
      : [];
    const forwards = Array.isArray(quoted.message)
      ? quoted.message.filter((s) => s?.type === 'forward')
      : [];
    const hint = images.length
      ? `${short ? `${short} ` : ''}（引用中有图片，是否附上以本轮图片说明为准）`
      : short || '(非文本内容)';
    return { text: `${sender}（QQ ${senderId}，消息 ${id}）：${hint}`, images, forwards,
      senderId: String(senderId), targetMessageId: String(id), who: sender };
  } catch (error) {
    ctx.logger.warn(`qq-bridge: 取引用消息失败 (${id}) —— ${error?.message ?? error}`);
    return { text: '（引用的消息内容取不出来）', images: [], forwards: [] };
  }
}

export { resolveQuote };
