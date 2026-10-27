function extractRemember(reply, config) {
  if (!config.memoryEnabled) return { text: reply, memories: [] };
  const marker = config.rememberMarker;
  if (!marker) return { text: reply, memories: [] };
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}([^\\]\\n]{1,300})\\]`, 'gu');
  const memories = [];
  let text = reply;
  for (const m of reply.matchAll(re)) {
    const body = m[1].trim();
    if (body) memories.push(body);
  }
  text = text
    .replace(re, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, memories };
}

function parseShape(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^(\d+)\s*(?:\+\s*([sS]))?$/);
  if (!m) return null;
  const bubbles = Math.max(1, Math.min(9, Number(m[1]) || 1));
  return { bubbles, sticker: Boolean(m[2]) };
}

function pickShape(config, random = Math.random) {
  const list = (config.replyShapes ?? []).map(parseShape).filter(Boolean);
  if (!list.length) return null;
  const i = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[i];
}

/** Only remove complete bubbles already sent by a tool; keep new results and sticker markers. */
export function removeSentBubbles(reply, sentTexts = []) {
  const normalize = (text) => String(text ?? '').trim().replace(/\s+/gu, ' ');
  const sent = new Set(sentTexts.flatMap((text) =>
    [String(text ?? ''), ...String(text ?? '').split(/\n\s*\n/u)]).map(normalize).filter(Boolean));
  return String(reply ?? '').split(/\n\s*\n/u)
    .filter((bubble) => !sent.has(normalize(bubble))).join('\n\n').trim();
}

// The prompt uses a synthetic description when a message has no text. If the
// model quotes that description, strip only the known descriptions; normal
// parenthesized chat remains untouched.
const SYNTHETIC_PROMPT_ECHO_RE = /[*_~`]*\s*(?:[（(]\s*对方\s*只\s*@\s*了?\s*你\s*[，,]\s*没\s*说\s*话\s*[）)]|[（(]\s*你\s*只\s*@\s*了?\s*我\s*[，,]\s*没\s*说\s*话\s*[）)]|[（(]\s*对方\s*只\s*发\s*了?\s*空\s*消息\s*[）)]|【\s*系统上下文\s*[：:]\s*仅\s*@\s*[、,，]\s*正文\s*为空\s*[；;，,]?\s*不要\s*复述\s*此行\s*】|【\s*系统上下文\s*[：:]\s*正文\s*为空\s*[；;，,]?\s*不要\s*复述\s*此行\s*】)\s*[*_~`]*/gu;

/** Remove model echoes of bridge-generated empty-message metadata. */
export function stripSyntheticPromptEcho(reply) {
  const original = String(reply ?? '');
  let removed = false;
  let text = original.replace(SYNTHETIC_PROMPT_ECHO_RE, () => {
    removed = true;
    return '';
  });
  if (!removed) return original;
  // A reply such as "？*（metadata）*" has no conversational content left.
  text = text
    .replace(/(^|\n)[ \t]*[*_~`]+[ \t]*(?=\n|$)/gu, '$1')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return /[^\s。．.，,、；;：:！!？?~～…*_`-]/u.test(text) ? text : '';
}

function splitBubbles(text, maxBubbles) {
  const chunks = String(text)
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length <= 1) return chunks;
  // 2026-10-27：气泡数不再由桥接封顶。想发几条由她把话说清楚决定，
  // 传非正数 / 不传 = 不限制（历史调用仍可传 cap 做单点截断）。
  const cap = Number(maxBubbles);
  if (!Number.isFinite(cap) || cap <= 0) return chunks;
  if (chunks.length <= cap) return chunks;
  return [...chunks.slice(0, cap - 1), chunks.slice(cap - 1).join('\n')];
}

function bubbleDelayFor(nextBubble, config) {
  const perChar = Number(config.bubbleDelayPerCharMs ?? 100);
  if (!(perChar > 0)) return 0;
  const min = Number(config.bubbleDelayMinMs ?? 400);
  const max = Number(config.bubbleDelayMaxMs ?? 6000);
  const raw = String(nextBubble ?? '').length * perChar;
  return Math.min(Math.max(raw, min), max);
}

function stripImageHallucination(text, config) {
  if (!config.imageHallucinationFilter) return { text, removed: 0 };
  let re;
  try {
    re = new RegExp(config.imageHallucinationPattern, 'u');
  } catch {
    return { text, removed: 0 };
  }
  // 按中英文句末标点和换行切句，尽量保住正常表达
  const sentences = String(text).split(/(?<=[。！？!?；;\n])/u);
  const kept = [];
  let removed = 0;
  for (const s of sentences) {
    if (!s.trim() || !re.test(s)) {
      kept.push(s);
      continue;
    }
    removed += 1;
    // 整句命中时再按逗号细分：一句里常常只有前半截在编，
    // 「这表情看着就像在憋笑，行吧，算你原谅我了喵」
    // 后半句是正常回应，不该跟着一起丢。
    const survivors = s.split(/(?<=[，,])/u).filter((clause) => clause.trim() && !re.test(clause));
    if (survivors.length) kept.push(survivors.join(''));
  }
  return {
    text: kept
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removed,
  };
}

function isSilence(reply, config) {
  const token = (config.silenceToken ?? '').trim();
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'u').test(String(reply));
}

function stripSilence(reply, config) {
  const token = (config.silenceToken ?? '').trim();
  if (!token) return String(reply);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = String(reply)
    .replace(new RegExp(escaped, 'gu'), '')
    .split('\n')
    // 摘掉令牌后常留下双空格或只剩标点的行，都得清掉
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .filter((line) => line && !/^[。．.，,、；;：:！!？?~～\s]+$/u.test(line))
    .join('\n\n')
    .trim();
  // 整条只剩标点/空白 = 什么都没说
  return /[^\s。．.，,、；;：:！!？?~～]/u.test(out) ? out : '';
}

const STICKER_MARKER_RE = /\[\s*(?:表情|sticker)\s*[:：]\s*(\d+)\s*\]/iu;
/**
 * 同一段正文被上游吐了两遍时，标记也会跟着出现两次。
 *
 * 只摘第一个（无 `g`）的旧写法会把第二个 `[表情:38]` 当普通文字留在正文里，
 * 于是群里看到的是「…行行行…[表情:38]」——语法漏进了聊天。
 * 编号只认第一个（她本来就只该写一个），但**标记必须摘干净**。
 */
const STICKER_MARKER_ALL_RE = /\[\s*(?:表情|sticker)\s*[:：]\s*(\d+)\s*\]/giu;
/** 连编号都写坏了的残骸（`[表情:…]`、`[表情:]`）也不能漏进群；`[表情包]` 这种正文不动。 */
const STICKER_SYNTAX_RE = /\[\s*(?:表情|sticker)\s*[:：][^\]]{0,12}\]/giu;

function extractStickerMarker(reply) {
  const m = reply.match(STICKER_MARKER_RE);
  const text = reply
    .replace(STICKER_MARKER_ALL_RE, '')
    .replace(STICKER_SYNTAX_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!m) return { text, sticker: null };
  const index = Number(m[1]);
  return { text, sticker: Number.isInteger(index) && index > 0 ? index : null };
}

/**
 * 把"整段重复了一遍"的正文折回一份。
 *
 * 上游偶尔会在一条 assistant 消息里吐两个内容相同的文本段（a6api 的流会重复
 * 开一个 text block），拼出来的正文就成了 `A\n\nB\n\nA\n\nB`：聊天里看起来
 * 像她把前两条气泡又原样重发了一次。按段落对半比对，前半等于后半就只留前半。
 *
 * 三条克制的边界，都是"宁可重复也不改她的语气"：
 *   ① 只在**段落序列完全相等**时动手，递进式的两句（"嗯" → "嗯，行吧"）不算；
 *   ② 至少两段才算一次重复 —— 一段话重复两遍有可能是真的在重复（人味）；
 *   ③ 段数必须是偶数，奇数序列不动。
 */
function collapseRepeatedReply(text) {
  const value = String(text ?? '');
  const chunks = value.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length < 4 || chunks.length % 2 !== 0) return value.trim();
  const half = chunks.length / 2;
  if (chunks.slice(0, half).join('\n') !== chunks.slice(half).join('\n')) return value.trim();
  return chunks.slice(0, half).join('\n\n');
}

/**
 * `[@:123456]` / `[@昵称]`：她**自己**在句子里点名某个人的写法。
 *
 * 为什么要有它：@ 在群里是"这句话说给谁听"的唯一明确信号，
 * 而自动回复这条路以前只能发纯文本 —— 她没法像人一样把人叫进来。
 *
 * 三条硬规则，都是"宁可不 @，也不能错 @"：
 *   ① 只认带方括号的标记。裸写的 `@123` 一律当普通文字，不猜。
 *   ② 解析不出来（号写错 / 昵称重名 / 超过上限）就把标记**摘掉** ——
 *      既不 @ 错人，也不让 `[@:xxx]` 这串语法漏进群里
 *      （`[引用]` 当年就是这么翻车的：标记本身被当正文发了出去）。
 *   ③ 不许 @ 自己，也不许 @全体成员 —— 那是打扰所有人，不是叫人。
 */
const AT_QQ_RE = /^\d{4,12}$/u;
/**
 * 解析器（昵称表 / 群成员表）给出来的号只做形状检查。
 *
 * 两类 token 的信任度不一样：
 *   · 模型**手打**的数字（`[@:123]`）要像真 QQ 号（≥4 位），否则多半是写坏了，不认；
 *   · 由昵称解析出来的号来自 QQ 自己，几位都得认 —— 否则换个短号环境就会静默不 @。
 */
const AT_QQ_RESOLVED_RE = /^\d{1,12}$/u;
const AT_ALL_TOKENS = new Set(['all', '全体', '全体成员', '所有人', 'everyone']);

/**
 * 字面量写法的公共部分：纯 QQ 号，以及照着窗口格式抄下来的「昵称（QQ号）」。
 *
 * 返回 null = 这不是字面量，得由调用方去查昵称表（见 mentionResolver / qq-mcp）。
 */
function literalAtTarget(token) {
  const value = String(token ?? '').trim();
  if (AT_QQ_RE.test(value)) return { qq: value, name: '' };
  const copied = value.match(/^(.+?)\s*[（(]\s*(\d{4,12})\s*[）)]$/u);
  if (copied) return { qq: copied[2], name: copied[1].trim() };
  return null;
}

/** 文本里写了哪些 @ 标记（原样 token），给需要异步查昵称的调用方先解析用。 */
function atMarkerTokens(text) {
  const raw = String(text ?? '');
  if (!raw.includes('[@')) return [];
  const out = [];
  const marker = /\[\s*@\s*:?\s*([^\]\s]{1,32})\s*\]/gu;
  for (let m = marker.exec(raw); m; m = marker.exec(raw)) out.push(String(m[1] ?? '').trim());
  return out.filter(Boolean);
}

/** 主正则没吃掉的 `[@…]` 残片：宁可删掉，也不让它以字面量出现在群里。 */
function cleanAtSyntax(text) {
  let dropped = 0;
  const out = String(text ?? '')
    .replace(/\[\s*@[^\]\n]{0,40}\]/gu, () => {
      dropped += 1;
      return '';
    })
    // 被 maxReplyChars 截断在结尾的半截标记
    .replace(/\[\s*@[^\]\n]*$/u, () => {
      dropped += 1;
      return '';
    });
  return { text: out, dropped };
}

/**
 * 把一个气泡解析成 OneBot 消息段 + 给人看的文本。
 *
 * @param {string} text 气泡原文（模型写的，可能含标记）
 * @param {object} [options]
 * @param {(token:string)=>({qq:string,name?:string}|null)} [options.resolve]
 *        标记 token → 目标；返回 null 表示"解析不了"。不给则只认 QQ 号字面量。
 * @param {string[]} [options.selfIds] 机器人自己的 QQ 号（一律不许 @）
 * @param {boolean} [options.allow] 是否真的允许 @（群聊 + 开关打开）。
 *        false 时标记照样会被摘干净，只是不会变成 at 段。
 * @param {number} [options.maxAts] 一个气泡最多 @ 几个人
 * @returns {{text:string, message:Array|null, mentions:string[], labels:string[], dropped:number}}
 *        `message` 为 null = 没有有效 @，调用方照旧发纯字符串。
 *        `mentions` 与 `labels` 一一对应（QQ 号 / 人看到的名字），
 *        方便调用方事后摘掉其中一个 @ 并同步修正显示文本。
 */
function extractAtMentions(text, options = {}) {
  const raw = String(text ?? '');
  const { resolve = null, selfIds = [], allow = true, maxAts = 3 } = options ?? {};
  if (!raw.includes('[@'))
    return { text: raw, message: null, mentions: [], labels: [], dropped: 0 };
  const self = new Set((selfIds ?? []).map((v) => String(v ?? '')).filter(Boolean));
  const cap = Math.max(0, Math.floor(Number(maxAts) || 0));
  const marker = /\[\s*@\s*:?\s*([^\]\s]{1,32})\s*\]/gu;
  const parts = [];
  const mentions = [];
  const labels = [];
  let display = '';
  let dropped = 0;
  let cursor = 0;
  /** 文本片段也要洗一遍：标记语法绝不能漏进群里。 */
  const pushText = (value) => {
    if (!value) return;
    const cleaned = cleanAtSyntax(value);
    dropped += cleaned.dropped;
    if (!cleaned.text) return;
    parts.push({ type: 'text', data: { text: cleaned.text } });
    display += cleaned.text;
  };
  for (let match = marker.exec(raw); match; match = marker.exec(raw)) {
    pushText(raw.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const token = String(match[1] ?? '').trim();
    const hit =
      allow && mentions.length < cap && !AT_ALL_TOKENS.has(token.toLowerCase())
        ? (resolve ? resolve(token) : literalAtTarget(token))
        : null;
    const qq = hit?.qq == null ? '' : String(hit.qq).trim();
    // 重复 @ 同一个人只留第一个：多出来的标记载体直接摘掉
    if (!qq || !AT_QQ_RESOLVED_RE.test(qq) || self.has(qq) || mentions.includes(qq)) {
      dropped += 1;
      continue;
    }
    mentions.push(qq);
    const label = String(hit?.name ?? '').trim() || qq;
    labels.push(label);
    parts.push({ type: 'at', data: { qq } });
    display += `@${label}`;
  }
  pushText(raw.slice(cursor));
  return {
    text: display,
    message: mentions.length ? parts : null,
    mentions,
    labels,
    dropped,
  };
}

/**
 * 正文协议：气泡必须写在『』里。
 *
 * 2026-10-27 的三条进群草稿（21:38–21:39）说明光靠"分段落"拆气泡不够 ——
 * 模型会把排稿说明（"两气泡：""配表情 #67""最终：…"）和最终答复写在同一个
 * 正文通道里，桥接无从分辨哪句是要发的。
 *
 * 所以把"哪段是气泡"变成显式语法：『』里的是气泡，框外一律丢弃。
 * 模型漏写时（旧提示词、弱模型）退回 _auto_ 的兼容路径，但那条路要过
 * 排稿标记闸 —— 宁可这一轮不发，也不把草稿发出去。
 */
const BUBBLE_MARK_RE = /『([^『』]{1,600})』/gu;
/** 排稿说明的典型措辞。命中说明这段是"怎么发"，不是"发什么"。 */
const PLAN_MARKER_RE = /(两气泡|三个?气泡|气泡[:：]|配表情|配\s*#\s*\d+|我选\s*#?\s*\d*|最终[：:]|或者更|也可以更|用\s*#\s*\d+|这条给|应该回|可以回)/u;
/** 一整行只有一句引号包裹的话。 */
const QUOTED_LINE_RE = /^\s*["“「『]([^"”」』]{1,600})["”」』]\s*$/u;
/** 代理层塞进模型上下文的注解标签（`<acp …>`/`<ref …>`），绝不能进群。 */
const BRIDGE_TAG_RE = /<\/?(?:acp|ref)\b[^>\n]{0,120}>/giu;
/** `<acp …>m00027</acp>` 这种成对标签：里面装的是消息编号，整对丢掉。 */
const BRIDGE_PAIR_RE = /<acp\b[^>\n]{0,200}>[\s\S]{0,60}?<\/acp>/giu;

/** 摘掉代理注入的注解标签；摘完顺手收一下空白。 */
function stripBridgeTags(text) {
  const raw = String(text ?? '');
  if (!/<(?:acp|ref)\b/iu.test(raw)) return raw;
  return raw
    .replace(BRIDGE_PAIR_RE, '')
    .replace(BRIDGE_TAG_RE, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
}

/** 取出所有 『』 气泡；`rest` 是框外的残留文字（只用于判断"漏没漏"，不发）。 */
function extractMarkedBubbles(text) {
  const raw = String(text ?? '');
  if (!raw.includes('『')) return { bubbles: [], rest: raw, found: false };
  const bubbles = [];
  for (const m of raw.matchAll(BUBBLE_MARK_RE)) {
    // 气泡内部换行会破坏 splitBubbles 的段落切分，折成空格
    const value = m[1].replace(/\s*\n\s*/gu, ' ').trim();
    if (value) bubbles.push(value);
  }
  if (!bubbles.length) return { bubbles: [], rest: raw, found: false };
  const rest = raw
    .replace(BUBBLE_MARK_RE, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
  return { bubbles, rest, found: true };
}

/**
 * 兼容路径：没有 『』 时，从"排稿说明 + 最终答复"里捞出最终答复。
 *
 * 只认最后一条排稿标记**之后**的话，而且必须是"她前面已经当成候选句写过的"
 * —— 模型排稿时会把候选答复用引号列出来，最后再挑一条落地。于是可以拿
 * 全文的引号句做白名单：标记之后逐行剥掉引号，命中白名单的才算答复。
 *
 * 这样捞不到就返回空：这一轮不发，比发一份草稿好。
 */
function stripPlanningReply(text) {
  const raw = String(text ?? '');
  const lines = raw.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (PLAN_MARKER_RE.test(line)) last = index;
  });
  if (last < 0) return { text: raw, dropped: false };
  /** 全文出现过的引号句 —— 既包含候选，也包含"最终："后面那几条。 */
  const candidates = new Set();
  for (const line of lines) {
    const hit = line.trim().match(QUOTED_LINE_RE);
    if (hit && hit[1].trim()) candidates.add(hit[1].trim());
  }
  const picked = [];
  for (const line of lines.slice(last + 1)) {
    const value = line.trim();
    if (!value || PLAN_MARKER_RE.test(value)) continue;
    const quoted = value.replace(/^["“「『]+|["”」』]+$/gu, '').trim();
    if (quoted && candidates.has(quoted) && !picked.includes(quoted)) picked.push(quoted);
  }
  return { text: picked.join('\n\n'), dropped: true };
}

/**
 * 正文 → 要发的气泡文本。
 *
 * @param {string} text
 * @param {{protocol?: 'auto'|'brackets'|'off'}} [options]
 * @returns {{text:string, source:'brackets'|'brackets-missing'|'planning'|'plain'|'off', dropped:boolean}}
 */
function resolveReplyBubbles(text, options = {}) {
  const raw = String(text ?? '');
  const mode = options.protocol ?? 'auto';
  if (mode === 'off') return { text: raw, source: 'off', dropped: false };
  const marked = extractMarkedBubbles(raw);
  if (marked.found) {
    return { text: marked.bubbles.join('\n\n'), source: 'brackets', dropped: Boolean(marked.rest) };
  }
  if (mode === 'brackets') return { text: '', source: 'brackets-missing', dropped: true };
  const cleaned = stripPlanningReply(raw);
  if (cleaned.dropped) return { text: cleaned.text, source: 'planning', dropped: true };
  /**
   * 只写了标记、没往框里放字（`『』`、或沉默令牌被框起来后剥剩的 `『』`）：
   * 摘掉孤立的 『』 就什么都不剩了 —— 这轮不发，别让群里收到一对引号。
   */
  const loose = raw.replace(/[『』]/gu, ' ').replace(/[ \t]{2,}/gu, ' ').trim();
  if (!loose) return { text: '', source: 'plain', dropped: Boolean(raw.trim()) };
  return { text: loose, source: 'plain', dropped: loose !== raw.trim() };
}

export {
  extractRemember,
  parseShape,
  pickShape,
  splitBubbles,
  bubbleDelayFor,
  stripImageHallucination,
  isSilence,
  stripSilence,
  STICKER_MARKER_RE,
  extractStickerMarker,
  collapseRepeatedReply,
  extractAtMentions,
  atMarkerTokens,
  literalAtTarget,
  cleanAtSyntax,
  stripBridgeTags,
  extractMarkedBubbles,
  stripPlanningReply,
  resolveReplyBubbles,
};
