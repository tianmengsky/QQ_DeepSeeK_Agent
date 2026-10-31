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
/** 各房间当天的候选心情。全局天气由它们合成，而不是"最后写完的那个群说了算"。 */
export const MOOD_CANDIDATES_KEY = 'qq-bridge:mood:candidates';

/**
 * 上限。天气是体温计，不是日记；超过这个长度就该写进日记本。
 *
 * 2026-11-01 从 80 放宽到 110：一天里几个房间各留一句，80 字装不下两句，
 * 合成时只能砍掉一整间屋子。
 */
export const MOOD_MAX_CHARS = 110;

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

/**
 * 记一条"这个房间的傍晚"。
 *
 * 为什么不是直接写全局天气：日结是短工，一次只看得见一间屋子。让最后写完的
 * 那个群决定她的全局天气，等于天气变成了那个群的投影——另一边刚被夸、这边刚
 * 被冷落，合起来像换了个人。候选按天累积，天气由 `composeMood` 合成，与写入
 * 顺序无关：谁先写完都不会丢掉别的屋子。
 */
export function writeMoodCandidate(store, { conversation = '', text = '', day = '', at = Date.now() } = {}) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim().slice(0, MOOD_MAX_CHARS);
  if (!clean || !conversation) return { written: false, reason: 'empty' };
  if (typeof store?.setState !== 'function') return { written: false, reason: 'no-store' };
  const current = parse(store.getState?.(MOOD_CANDIDATES_KEY)) ?? {};
  const sameDay = String(current.day ?? '') === String(day ?? '');
  const items = (sameDay && Array.isArray(current.items) ? current.items : [])
    .filter((item) => item && item.conversation !== conversation);
  items.push({ conversation, text: clean, at: Number(at) || Date.now() });
  // 一天最多留 8 间屋子：再多也不是"天气"了，是台账。
  const kept = items.slice(-8);
  return store.setState(MOOD_CANDIDATES_KEY, JSON.stringify({ day: String(day ?? ''), items: kept }))
    ? { written: true, items: kept }
    : { written: false, reason: 'not-saved' };
}

/** 读当天的候选；不同日子一律当作没有（昨天的心情不该压今天的天气）。 */
export function readMoodCandidates(store, { day = '' } = {}) {
  const value = parse(store?.getState?.(MOOD_CANDIDATES_KEY));
  if (!value || String(value.day ?? '') !== String(day ?? '')) return [];
  return Array.isArray(value.items) ? value.items : [];
}

/**
 * 把几个房间的傍晚合成一条天气。
 *
 * 规则刻意简单（不叫模型）：按时间取最早的几句、去重、用"；"连起来，超长就停在
 * 句号处。它只需要"今天不只有一间屋子"这个事实，不需要写得漂亮——写得漂亮是
 * 日记的活。
 */
export function composeMood(items = [], { maxChars = MOOD_MAX_CHARS } = {}) {
  const list = [...items].sort((a, b) => Number(a?.at ?? 0) - Number(b?.at ?? 0));
  // 只有一间屋子时原样保留（连同句号）——那是她自己写的句子，不必为合成而改。
  if (list.length === 1) {
    const only = String(list[0]?.text ?? '').replace(/\s+/gu, ' ').trim();
    return only ? only.slice(0, Math.max(20, Number(maxChars) || MOOD_MAX_CHARS)) : '';
  }
  const seen = new Set();
  const clauses = [];
  for (const item of [...items].sort((a, b) => Number(a?.at ?? 0) - Number(b?.at ?? 0))) {
    const first = String(item?.text ?? '').split(/[。！？!?]/u)[0].trim();
    if (!first || seen.has(first)) continue;
    seen.add(first);
    clauses.push(first);
    if (clauses.length >= 3) break;
  }
  if (!clauses.length) return '';
  return clauses.join('；').slice(0, Math.max(20, Number(maxChars) || MOOD_MAX_CHARS));
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
