import { sendOnebotIdempotent } from './outbox.mjs';
import { recordContext } from '../conversation/context.mjs';
import { wakeAfterSpeech } from '../conversation/activity.mjs';
import { splitBubbles, bubbleDelayFor } from '../domain/reply-policy.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

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
export async function sendSelfMessage({ ctx, config, store, registry, memory, state = null, conversation, text, idemKey }) {
  const key = String(conversation ?? '');
  const group = key.startsWith('group:');
  if (!group && !key.startsWith('user:')) throw new Error('目标窗口不认识（要 group:<id> 或 user:<id>）');
  const body = String(text ?? '').trim();
  if (!body) throw new Error('要说的话不能是空的');

  /*
   * 学到的记性在这里生效。
   *
   * 用户在 2026-11-01 的原话是"她会学习，如果她判断这个人或这个群对她的内容
   * 不感兴趣，她会减少频率直到不和这个人或群主动交互"。降权不够——她现在能
   * 对任意窗口开口，权重管不住嘴。回应率掉到 0 的目标先按住，并如实告诉她
   * 为什么；别的目标一点不受影响（学习是按目标的，不是全局静音）。
   */
  const learned = state?.proactive?.learningFor?.(key);
  if (learned && learned.factor === 0) {
    return {
      sent: false,
      status: 'HELD',
      note: `这儿最近 ${learned.attempts} 次你开口都没人接，先别急着去。`,
    };
  }

  const at = Date.now();
  /**
   * 一条气泡 = 一条 QQ 消息，和回合一模一样。
   *
   * 2026-11-01 线上（群 1033440455，13:27）她把「我还在呢」和后面那句用空行连在
   * 一条 `message` 里发出去，QQ 里就是一个大气泡两段话 —— 回复通道有『』拆条和
   * 按字数停顿，这条通道却把整段原样倒出去。同一个"她"，说话的形状不该有两套。
   */
  const bubbles = splitBubbles(body, 0);
  const sentBubbles = [];
  let last = null;
  for (let index = 0; index < bubbles.length; index += 1) {
    const piece = bubbles[index];
    // 第二条起按字数等一会儿：紧贴着发出去，观感还是"一口气倒完"。
    if (index > 0) await sleep(bubbleDelayFor(piece, config));
    const pieceKey = index === 0 ? idemKey : `${idemKey}#${index + 1}`;
    const result = await sendOnebotIdempotent(ctx, config, store, {
      idemKey: pieceKey,
      conversation: key,
      action: group ? 'send_group_msg' : 'send_private_msg',
      target: group ? { group_id: Number(key.slice(6)) } : { user_id: Number(key.slice(5)) },
      message: [{ type: 'text', data: { text: piece } }],
    });
    if (!result?.sent) {
      // 前半已经出去了：如实说清"发了几条"，别让她以为一句都没发。
      return {
        sent: false,
        status: String(result?.status ?? 'unknown'),
        bubbles: sentBubbles.length,
        partial: sentBubbles.length > 0,
      };
    }
    last = result;
    const sentAt = Number(result.sentAt) || at;
    const messageId = String(result.onebotId ?? pieceKey);
    const entry = registry?.entry?.(key);
    if (entry) {
      try {
        recordContext(config, entry, {
          qq: '', who: '你', text: piece, bot: true, messageId, at: sentAt, timeSource: 'sent',
        });
        wakeAfterSpeech(config, entry, sentAt);
        registry.persist?.(key, entry);
      } catch { /* 记不进上下文不影响这句已经发出去了 */ }
    }
    try {
      store?.recordEvent?.({
        conversation: key,
        kind: 'self_message',
        payload: { text: piece, who: '你', qq: '', messageId, at: sentAt, timeSource: 'sent' },
        deliverable: false,
        dedupeKey: 'self:' + pieceKey,
      });
    } catch { /* 事件表写失败时消息也已经发了，不回头重发 */ }
    sentBubbles.push(piece);
  }
  try {
    memory?.selfLedger?.record?.({
      kind: 'speak', target: key, summary: body.slice(0, 80), outcome: 'sent', source: 'self-turn',
    });
  } catch { /* 自传是加餐 */ }
  return {
    sent: true,
    status: String(last?.status ?? 'ok'),
    messageId: String(last?.onebotId ?? idemKey),
    sentAt: Number(last?.sentAt) || at,
    bubbles: sentBubbles.length,
  };
}
