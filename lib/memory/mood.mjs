/**
 * 天气槽（mood）——她此刻的状态。
 *
 * 为什么需要这一层：她的每个窗口都是一次独立的实例，共享的只有"账"
 * （`me.*` / 日记 / 周反思 / 自传）。账记的是**发生过什么**，不记**我现在
 * 是什么感觉**。于是群里的她被夸得很开心、私聊里的她刚被冷落，两边的情绪
 * 各自成立、合起来不像一个人。
 *
 * 人不需要"记得上周三为什么烦躁"，因为**同一具身体**替他记着天气。
 * 这一层就是那具身体：几十个字，后台写（日结/周反思），所有回合读。
 *
 * 三条刻意的约定：
 *   1. 只有后台写（日结、周反思，将来还有脊柱）。房间里的她不能随手改天气
 *      ——否则又变成十几个念头各自调温，这一层就白加了。
 *   2. 所有场合都读，包括群聊：这是唯一一处"她带着自己进房间"的地方。
 *   3. 它不是规则。注入时明写"不要求我照着演"——人被写死的天气绑住，比没有
 *      天气更假。
 */
export const MOOD_STATE_KEY = 'qq-bridge:mood';

/** 上限。天气是体温计，不是日记；超过这个长度就该写进日记本。 */
export const MOOD_MAX_CHARS = 80;

function parse(raw) {
  if (!raw) return null;
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 读天气。任何异常都返回 null —— 天气坏了不该让整轮对话起不来。
 */
export function readMood(store, { maxChars = MOOD_MAX_CHARS } = {}) {
  const value = parse(store?.getState?.(MOOD_STATE_KEY));
  const text = String(value?.text ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return {
    text: text.slice(0, maxChars),
    at: Number(value?.at) || 0,
    source: String(value?.source ?? ''),
  };
}

/**
 * 写天气。返回 `{written, ...}`，不抛 —— 写不进去比写错更常见。
 */
export function writeMood(store, { text = '', source = '', at = Date.now() } = {}) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, MOOD_MAX_CHARS);
  if (!clean) return { written: false, reason: 'empty' };
  if (typeof store?.setState !== 'function') return { written: false, reason: 'no-store' };
  const value = { text: clean, source: String(source ?? ''), at: Number(at) || Date.now() };
  return store.setState(MOOD_STATE_KEY, JSON.stringify(value))
    ? { written: true, ...value }
    : { written: false, reason: 'not-saved' };
}

/**
 * 注入用的文本。
 *
 * 语气是刻意选的：这是她自己的句子（后台写、以第一人称），不是旁人给的评语。
 * 标题里那句"不要求我照着演"很重要——天气会滞后，这一轮真高兴了就不该被
 * 上一轮的阴天按住。
 */
export function moodLines(mood, budget = 160) {
  if (!mood?.text) return '';
  const head = '【我此刻的心情】这是你刚写完自己那边的事之后留下的感觉，不是别人的评价。';
  const tail = '（天气会过时：这一轮要真高兴了，就按真的来。）';
  const body = `\n- ${mood.text}`;
  const text = head + body + '\n' + tail;
  const max = Number(budget) > 0 ? Number(budget) : 160;
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
}

/** 从日结/反思的模型输出里挑出天气句子：去掉号码，压成一行。 */
export function sanitizeMood(text, { maxChars = MOOD_MAX_CHARS } = {}) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .replace(/[1-9]\d{5,}/gu, '某个人')
    .replace(/["'`]/gu, '')
    .trim()
    .slice(0, maxChars);
}
