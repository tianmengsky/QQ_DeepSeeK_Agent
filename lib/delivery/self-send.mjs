import { sendOnebotIdempotent } from './outbox.mjs';
import { recordContext } from '../conversation/context.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';

/**
 * 她主动说一句话（不是"回复某条消息"）。
 *
 * 为什么单独有这条通道：回合里的最终正文只能发回"当前这个窗口"——她在 A 群
 * 醒着，就没法顺手给 B 私聊里那个人留一句话。她自己不是窗口，是一本账加一张嘴；
 * 嘴必须能对着任意一个房间说话，否则"她"就只能是她刚好站着的那个房间。
 *
 * 三件事必须一起做，少一件下次就认不出来：
 *   1. 真的发出去（`sendOnebotIdempotent`：幂等 + 配额 + 回执）；
 *   2. 写进目标窗口的上下文（`recordContext` + 清醒窗口），否则那边的下一回合
 *      不知道"这句话是我说的"，@ 回复也接不上；
 *   3. 落 `events` 的 `self_message`，否则重启后历史里没有这句，账本也对不上。
 */
export async function sendSelfMessage({ ctx, config, store, registry, memory, conversation, text, idemKey }) {
  const key = String(conversation ?? '');
  const group = key.startsWith('group:');
  if (!group && !key.startsWith('user:')) throw new Error('目标窗口不认识（要 group:<id> 或 user:<id>）');
  const body = String(text ?? '').trim();
  if (!body) throw new Error('要说的话不能是空的');

  const at = Date.now();
  const result = await sendOnebotIdempotent(ctx, config, store, {
    idemKey,
    conversation: key,
    action: group ? 'send_group_msg' : 'send_private_msg',
    target: group ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) },
    message: [{ type: 'text', data: { text: body } }],
  });
  if (!result?.sent) return { sent: false, status: String(result?.status ?? 'unknown') };

  const sentAt = Number(result.sentAt) || at;
  const messageId = String(result.onebotId ?? idemKey);
  const entry = registry?.entry?.(key);
  if (entry) {
    try {
      recordContext(config, entry, {
        qq: '', who: '你', text: body, bot: true, messageId, at: sentAt, timeSource: 'sent',
      });
      wakeAfterSpeech(config, entry, sentAt);
      registry.persist?.(key, entry);
    } catch { /* 记不进上下文不影响这句已经发出去了 */ }
  }
  try {
    store?.recordEvent?.({
      conversation: key,
      kind: 'self_message',
      payload: { text: body, who: '你', qq: '', messageId, at: sentAt, timeSource: 'sent' },
      deliverable: false,
      dedupeKey: 'self:' + idemKey,
    });
  } catch { /* 事件表写失败时消息也已经发了，不回头重发 */ }
  try {
    memory?.selfLedger?.record?.({
      kind: 'speak', target: key, summary: body.slice(0, 80), outcome: 'sent', source: 'self-turn',
    });
  } catch { /* 自传是加餐 */ }
  return { sent: true, status: String(result.status ?? 'ok'), messageId, sentAt };
}
