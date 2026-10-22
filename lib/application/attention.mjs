import { atTargets, renderMessage, leadingNameMatch } from '../domain/events.mjs';
import { contextMessage } from '../conversation/context.mjs';
import { resolveQuote } from '../prompt/quote.mjs';
import { asksToLook } from '../prompt/prepare.mjs';
import { asksToReadForward } from '../prompt/forward.mjs';
import { requestHeartbeat } from './heartbeat.mjs';
import { decideReply, REQUEST_SHAPED } from './reply-decision.mjs';

/** 去掉句首的 @ 渲染片段（`@你` / `@100000001` / `@全体成员`），留下真正的内容。 */
function stripLeadingMentions(text) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/^[@＠](?:你|全体成员|\d+)\s*/u, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Run inside registry.run, before creating a full Agent turn. */
export async function evaluateAttention(ctx, config, entry, event, stats, signal, options = {}) {
  const ids = (config.selfIds?.length ? config.selfIds : [event.self_id]).map(String);
  const ats = atTargets(event.message).filter((id) => id !== 'all');
  if (ats.length && !ids.includes(ats[0]))
    return { speak: false, why: '明确 @ 其他成员，旁听' };
  const current = contextMessage(event);
  if (current.replyToId != null) {
    const source = entry.window.find((m) => String(m.messageId) === String(current.replyToId));
    const sourceLooksLikeForward = String(source?.text ?? '').includes('[合并转发]');
    const resolved = !source || (!source.forwards?.length && sourceLooksLikeForward)
      ? await resolveQuote(ctx, config, event) : null;
    const quotedImages = source?.images ?? resolved?.images ?? [];
    const quotedForwards = source?.forwards ?? resolved?.forwards ?? [];
    const body = stripLeadingMentions(renderMessage(event.message));
    const mediaRequested =
      (quotedImages.length > 0 && (config.attachQuotedImages !== false || asksToLook(body, config.imageTriggers))) ||
      (quotedForwards.length > 0 && (config.attachQuotedForwards !== false || asksToReadForward(body, config.forwardTriggers)));
    if (mediaRequested)
      return { speak: true, recipient: 'self', kind: 'followup', why: '引用了可读取的图片或合并转发' };
    const author = source?.qq ?? resolved?.senderId;
    const own = source?.bot || (author != null && ids.includes(String(author)));
    if (own) return { speak: true, recipient: 'self', kind: 'followup', why: '明确回复她自己的消息' };
    if (author != null && !own) return { speak: false, why: '引用其他成员的消息，旁听' };
  }
  const body = stripLeadingMentions(renderMessage(event.message));
  if (leadingNameMatch(body, config.nameTriggers) != null)
    return { speak: true, recipient: 'self', kind: 'followup', why: '开头直接叫她的名字', decided: true };
  /**
   * 通用分支：以前这里直接返回 `kind: 'consider'`，把"回不回"丢给完整回合里的模型自己
   * 用 `[SKIP]` 决定。实测那样几乎不回绝（累计只有 3.7% 的回复是 `[SKIP]`），
   * 而且每条消息都要先建 Session、拼人设+记忆+窗口、提交一次 prompt 才可能说"不说话"。
   *
   * 打开 `replyDecisionEnabled` 后改成先问一次很短的参与决策（辅助模型、maxTokens 60），
   * 判的是**这一批已聚合的意群**加最近时间线，所以"几个人接着聊同一件事"只回一次。
   * 决策失败一律 fail-open（当作该回），绝不因为判断服务出问题而吞掉真的在问她的消息。
   */
  if (config.replyDecisionEnabled) {
    /**
     * 硬护栏一：明显是"请求型"的消息**不问模型直接回**。
     *
     * 这是这个功能最危险的失效方式 —— 把一条真的在让她做事的消息判成"不必插话"，
     * 而 `observeWithoutReply` 只会把它塞进心跳缓冲（心跳间隔 10 分钟），
     * 用户会觉得"她装死"。正则的覆盖面是拿线上 306 条真实触发消息量出来的，
     * 初版只放行 15% 且漏掉了「写一份…」「…发我」「做完通知…」「…给出详细过程」，
     * 见 reply-decision.mjs 的 REQUEST_SHAPED。
     */
    if (REQUEST_SHAPED.test(body)) {
      stats.replyDecisionRequestShaped = (stats.replyDecisionRequestShaped ?? 0) + 1;
      return { speak: true, kind: 'consider', why: '请求型措辞，直接回' };
    }
    /**
     * 硬护栏二：**长且带提问标记**的消息也直接回。
     *
     * 决策的价值集中在**短而含糊**的消息上（实测会被合理拒绝的是「34」「废鱼」「那做」
     * 「我坐好了」这种），长消息里几乎都是真问题。线上 76% 的触发消息会走到模型那一步、
     * 每条多付约 2.5 秒；这一条把"又长又明显在问"的那批短路掉，削成本而不削弱
     * 它该拒绝的那部分能力。
     */
    const askMark = /[？?]|吗|什么|哪|谁|多少|几点/u.test(body);
    /**
     * 硬护栏三：**被点名 + 在提问**的短问句也直接回（2026-10-21，方案 A）。
     *
     * 为什么补这一条：线上 7 天有 24 条 @ 她的消息被判成"不回"，其中 5 条明显是提问
     * （「你们谁更厉害」「猜猜这个是什么」「9.11 和 9.9 哪个大」「9月11日忆什么」）。
     * 前两条都不够长（7 字），也命中不了请求型正则，于是被交给参与决策；而已知决策
     * 模型最近 28 次里 25 次说"不用回"，短问句就成了假阴性。
     *
     * 边界（避免退回"每条都回"）：
     *   · 只对**明确 @ 她**生效（`options.explicit`），旁听消息仍按原规则；
     *   · 纯打招呼（在/在吗/在么/在不在）不算提问，继续交给决策模型；
     *   · 纯标点（？/！）也不算，避免"？"触发抢答。
     * 命中后仍只是 `kind: 'consider'`：完整回合里的模型照样可以用 `[SKIP]` 沉默。
     */
    const questionCore = body.replace(/[？?。.!！\s]/gu, '');
    const explicitAsk = Boolean(options.explicit) && askMark && questionCore.length > 0 &&
      !/^在(?:[吗么嘛]|不在)?$/u.test(questionCore);
    if (explicitAsk) {
      stats.replyDecisionExplicitAsk = (stats.replyDecisionExplicitAsk ?? 0) + 1;
      return { speak: true, kind: 'consider', why: '被点名且在提问，直接回' };
    }
    if (body.length >= (config.replyDecisionLongAskChars ?? 12) && askMark) {
      stats.replyDecisionLongAsk = (stats.replyDecisionLongAsk ?? 0) + 1;
      return { speak: true, kind: 'consider', why: '长问句，直接回' };
    }
    const verdict = await decideReply(ctx, config, entry, options.events ?? [event],
      { explicit: Boolean(options.explicit), signal });
    if (verdict && typeof verdict.reply === 'boolean') {
      stats.replyDecisionChecks = (stats.replyDecisionChecks ?? 0) + 1;
      if (!verdict.reply) {
        stats.replyDecisionSilent = (stats.replyDecisionSilent ?? 0) + 1;
        stats.lastReplyDecision = { conversation: options.key ?? null, reply: false,
          reason: verdict.reason, at: Date.now() };
        return { speak: false, decided: true, why: '参与决策：' + (verdict.reason || '此刻不必插话') };
      }
      stats.lastReplyDecision = { conversation: options.key ?? null, reply: true,
        reason: verdict.reason, at: Date.now() };
    } else {
      /**
       * 失败必须留下原因。此前这里只 `+1` 一个计数，线上读数就是
       * `participation.checks=0 / failed=2` —— 既不知道是空输出、超时还是没配 provider，
       * 也不知道 fail-open 之后到底走了哪条路径。
       */
      stats.replyDecisionFailed = (stats.replyDecisionFailed ?? 0) + 1;
      stats.lastReplyDecisionFailure = { conversation: options.key ?? null,
        cause: verdict?.cause ?? 'unavailable', detail: verdict?.detail ?? null, at: Date.now() };
    }
  }
  // Ambiguous semantics belong to the Agent with memory and full conversation context.
  return { speak: true, kind: 'consider', why: '交给完整对话模型一次决定回复或沉默' };
}

export function observeWithoutReply(ctx, config, registry, state, memory, stats, store, key, event, sendQueue) {
  const entry = registry.entry(key);
  const current = contextMessage(event);
  registry.buffer(entry, { ...current, conversation: key,
    dedupeKey: event.message_id == null ? null : `attention:${event.self_id ?? ''}:${event.message_id}`,
    text: renderMessage(event.message) || '[非文字内容]' });
  registry.record(entry, { ...current, bot: false });
  registry.persist(key);
  requestHeartbeat(ctx, config, registry, state, memory, stats, store, key, { sendQueue });
}
