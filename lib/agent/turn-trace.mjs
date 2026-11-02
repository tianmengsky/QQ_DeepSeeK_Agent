/**
 * 回合结果账 —— 把"判断"和"结果"接起来的那一节。
 *
 * 为什么需要（2026-11-01）：面板的「判断流」只记到"参与决策说『接』，因为『上一句是地的话』"，
 * 再往下就断了。可用户真正想知道的是**这条判断最后变成了什么**：
 *   · 判了接 → 最后是不是真的发了？发了几个气泡？
 *   · 判了接 → 结尾 `[SKIP]`（白判一次）
 *   · 判了接 → 楼层复核撤了 / 投递策略挡了 / 队列失败
 * 这三种在"她没说话"这件事上一模一样，修法却完全不同。
 *
 * 实现刻意用 `turnId` 显式串，不用 AsyncLocalStorage：
 * 回合可能并发（多个群同时跑），隐式上下文一旦漏挂就会把 A 群的判断记到 B 群头上，
 * 而这种错误在面板上看不出来。
 *
 * 只放内存环形缓冲（120 条），随重载清零 —— 与判断流同一寿命，不新增任何写库。
 */

const RING = 120;
/** turnId → 结果。Map 保持插入顺序，超量时删最旧的。 */
const outcomes = new Map();

/** 结尾原因的中文名。面板与 `/status` 共用一份，别两边各写一套。 */
export const END_REASON_LABELS = {
  'tool-only': '只有工具发言',
  'wait-after-tool': '工具说完在等',
  'agent-silent': '她自己决定不说',
  'agent-waiting': '在等同一个人说完',
  'empty-or-tool-echo': '正文只剩工具回声',
  'image-filtered': '图片幻觉被滤空',
  'poke-text-disabled': '戳一戳不回文字',
  'spine:no-target': '自主时间，没有收件人',
  'delivery-policy-skipped': '投递策略没放行',
  'no text output': '模型没吐正文',
  'spine-no-delivery': '自主时间不投递',
};

const reasonLabel = (reason) => {
  const text = String(reason ?? '');
  if (!text) return null;
  if (END_REASON_LABELS[text]) return END_REASON_LABELS[text];
  if (text.startsWith('floor:')) return '楼层复核撤了（' + text.slice(6) + '）';
  if (text.startsWith('blocked')) return '上游拒了这个回合';
  return text.slice(0, 60);
};

/**
 * 记一次回合结果。
 *
 * @param {{turnId: string, conversation?: string, endReason?: string,
 *   queued?: boolean|null, bubbles?: number|null, chars?: number|null,
 *   viaTool?: boolean|null, ok?: boolean|null, at?: number}} input
 */
export function recordTurnOutcome({ turnId, conversation = null, endReason = '',
  queued = null, bubbles = null, chars = null, viaTool = null, ok = null, at = Date.now() } = {}) {
  if (!turnId) return null;
  const id = String(turnId);
  const record = {
    turnId: id,
    conversation: conversation == null ? null : String(conversation),
    endReason: endReason == null ? '' : String(endReason).slice(0, 120),
    label: reasonLabel(endReason),
    queued: queued == null ? null : Boolean(queued),
    bubbles: bubbles == null ? null : Math.max(0, Number(bubbles) || 0),
    chars: chars == null ? null : Math.max(0, Number(chars) || 0),
    viaTool: viaTool == null ? null : Boolean(viaTool),
    ok: ok == null ? null : Boolean(ok),
    at,
  };
  outcomes.set(id, record);
  while (outcomes.size > RING) outcomes.delete(outcomes.keys().next().value);
  return record;
}

/** 按 turnId 取结果：判断流里每一行都带 turnId，展开时用它回查。 */
export function turnOutcome(turnId) {
  if (!turnId) return null;
  return outcomes.get(String(turnId)) ?? null;
}

/** 测试与诊断用：只读拷贝，新的在后。 */
export function turnOutcomes() {
  return [...outcomes.values()].map((row) => ({ ...row }));
}

export function resetTurnTrace() {
  outcomes.clear();
}
