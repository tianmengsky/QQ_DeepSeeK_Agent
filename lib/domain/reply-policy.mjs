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

/**
 * "这段文字里有没有 @ 标记"。
 *
 * 不能写成 `raw.includes('[@')`。2026-11-02 17:42 线上（群 946719566）她写的是
 * `[ @好运成双倍 ]` —— 方括号里带了空格。主正则本来就容忍 `\[\s*@`，可这条
 * 提前返回的快路径不容忍，于是标记既没变成 at 段、也没被 cleanAtSyntax 摘掉，
 * **原样发进了群里**（群里看到的就是「[ @好运成双倍 ] 那你告诉告诉我嘛」）。
 *
 * 判据必须和主正则同源：方括号 + 可选空白 + @。
 */
const AT_MARKER_GUARD_RE = /\[\s*@/u;

/** 文本里写了哪些 @ 标记（原样 token），给需要异步查昵称的调用方先解析用。 */
function atMarkerTokens(text) {
  const raw = String(text ?? '');
  if (!AT_MARKER_GUARD_RE.test(raw)) return [];
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
  if (!AT_MARKER_GUARD_RE.test(raw))
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
 * `[引用:消息ID]` / `[回复:消息ID]`：这一段要引用哪条历史消息。
 *
 * 为什么是"显式 ID"而不是旧的 `[引用]` 暗号：旧功能没有目标，只能引用
 * "当前这条"（O′ 那种 QQ 自带的引用回复），实测会把标记本身发进群，整块撤掉了。
 * 现在她手里有消息 ID（窗口记录、`qq_windows` 都给），要引用哪条是可以写清楚的：
 * 写清楚了就能校验、能摘掉、发不出去也不会变成语法泄漏。
 *
 * 三条硬规则，和 @ 一致，都是"宁可不引用，也不能发错"：
 *   ① 只认带方括号的标记；`引用`/`回复`/`quote`/`reply` 都收（模型两边混着写）；
 *   ② `allow(id)` 说不行的（不在本窗口里、写坏了）就把标记**摘掉**，不当正文发；
 *   ③ 一个气泡最多引用一条，多写的当残片摘掉。
 *
 * 返回 `target` 为 null = 这一气泡不引用；`text` 是摘掉标记后的正文。
 */
const QUOTE_MARKER_RE = /\[\s*(?:引用|回复|quote|reply)\s*(?:[:：#]\s*(-?\d{1,19})\s*)?\]/giu;
/** 连 ID 都写残了的（`[引用: abc]`、`[引用:`）也不能漏进群。 */
const QUOTE_MARKER_BROKEN_RE = /\[\s*(?:引用|回复|quote|reply)[^\]\n]{0,24}\]?/giu;
/**
 * 注意这里**不能写 `\b`**：中文字符不属于 JS 的 `\w`，`引用\b` 永远不成立。
 * 这也是上面两个正则只写 `\s*` 的原因（踩过一次，标记整个不生效）。
 */
const QUOTE_MARKER_GUARD_RE = /\[\s*(?:引用|回复|quote|reply)/iu;

function extractQuoteTarget(text, options = {}) {
  const raw = String(text ?? '');
  const { allow = () => true } = options ?? {};
  if (!QUOTE_MARKER_GUARD_RE.test(raw)) return { text: raw, target: null, dropped: 0 };
  let target = null;
  let dropped = 0;
  const cleaned = raw
    .replace(QUOTE_MARKER_RE, (match, id) => {
      const value = String(id ?? '').trim();
      // 第一个**校验通过**的标记成为这个气泡的引用对象；后面的都算多写
      if (target == null && value && allow(value)) {
        target = value;
        return '';
      }
      dropped += 1;
      return '';
    })
    .replace(QUOTE_MARKER_BROKEN_RE, () => {
      dropped += 1;
      return '';
    });
  const text2 = cleaned
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/^[ \t]+/u, '')
    .replace(/[ \t]+$/u, '')
    .trim();
  return { text: text2, target, dropped };
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
/**
 * 框外要"搬回来"的标记：@ 与引用。
 *
 * 只认这两种 —— 它们带的是**地址**（说给谁听、引哪一条），不是语气；
 * 框外的其它文字仍然按排稿说明丢掉，一个字都不进群。
 */
const RESCUE_MARKER_RE =
  /\[\s*@[^\]\n]{0,40}\]|\[\s*(?:引用|回复|quote|reply)\s*(?:[:：#]\s*-?\d{1,19}\s*)?\]/giu;
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
  const spans = [];
  for (const m of raw.matchAll(BUBBLE_MARK_RE)) {
    // 气泡内部换行会破坏 splitBubbles 的段落切分，折成空格
    const value = m[1].replace(/\s*\n\s*/gu, ' ').trim();
    if (value) spans.push({ text: value, start: m.index, end: m.index + m[0].length });
  }
  if (!spans.length) return { bubbles: [], rest: raw, found: false };
  const rest = raw
    .replace(BUBBLE_MARK_RE, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
  /**
   * 框外不只是排稿说明，还可能是"这句话说给谁听"。
   *
   * 模型很自然地把 @ 写在句子前面而不是框里面：`[@小林]『你说啥』`、或者
   * 单独一行 `[@小林]` 再接几条气泡。以前这里一律丢框外，于是 @ 和引用
   * **静默消失**（2026-10-27 换 『』 协议之后线上就再没出现过带 at 段的消息）。
   *
   * 现在的分界：框外的**文字**照旧丢（那是排稿说明），框外的 **@/引用标记**
   * 搬进最近的气泡 —— 在前面的并进第一条，在后面的并到最后一条，夹在中间的
   * 并进它前面那条。标记本身不携带语气，搬动不会改变她说了什么。
   */
  const outside = raw.replace(BUBBLE_MARK_RE, (match) => ' '.repeat(match.length));
  const bubbles = spans.map((span) => span.text);
  for (const m of outside.matchAll(RESCUE_MARKER_RE)) {
    const mark = m[0].trim();
    if (!mark) continue;
    const end = m.index + m[0].length;
    const prev = spans.filter((span) => span.end <= m.index).pop() ?? null;
    const next = spans.find((span) => span.start >= end) ?? null;
    if (!prev && !next) continue;
    // 就近并：紧挨着哪个气泡就归哪个，夹在中间时比距离（.md 里常见的是紧贴上一条或下一条）
    if (!prev) {
      bubbles[spans.indexOf(next)] = `${mark} ${bubbles[spans.indexOf(next)]}`.trim();
      continue;
    }
    if (!next) {
      bubbles[spans.indexOf(prev)] += ' ' + mark;
      continue;
    }
    const toPrev = m.index - prev.end;
    const toNext = next.start - end;
    if (toNext <= toPrev) bubbles[spans.indexOf(next)] = `${mark} ${bubbles[spans.indexOf(next)]}`.trim();
    else bubbles[spans.indexOf(prev)] += ' ' + mark;
  }
  const letters = rest.replace(RESCUE_MARKER_RE, ' ').replace(/[ \t]{2,}/gu, ' ').trim();
  return { bubbles, rest: letters, found: true };
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

/** 比较气泡"是不是同一句话"时忽略的噪声：标点、空白、表情标记。 */
const BUBBLE_NOISE_RE = /[\s，。！？、,.!?~～…—－（）()「」『』“”"'‘’:：;；]/gu;

function bubbleFingerprint(text) {
  return String(text ?? '')
    .replace(STICKER_SYNTAX_RE, '')
    .replace(BUBBLE_NOISE_RE, '')
    .toLowerCase();
}

/** 二元组 Dice 系数（0–1）。用于认出"换个说法重写的同一句话"。 */
function bigramDice(a, b) {
  const grams = (text) => {
    const map = new Map();
    for (let i = 0; i < text.length - 1; i++) {
      const gram = text.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * 同一轮里的"复述"只留最后一条。
 *
 * 2026-10-28 线上（群 324089993，23:44、23:55）：回合中途又来了新消息，模型把
 * 已经写过的几条答复**换个说法重写了一遍**；runner 把两段正文按 `\n\n` 拼在
 * 一起，于是群里看到"？说我笨 / 刚进来的时候确实笨…"各发两遍。
 *
 * 判重分三档（都先去掉标点与表情标记）：
 *   ① 完全相同；
 *   ② 一条整句被另一条包含（≥4 字才判，避免短句误杀）；
 *   ③ 二元组 Dice 相似度 ≥ 0.6 且两边都 ≥6 字 —— 实测线上"换个说法的复述"
 *      约 0.69，真正不同的话 0.00–0.13，中间没有模糊地带。
 * 保留靠后的那条 —— 模型复述时后写的是它认可的那版。
 *
 * @param {string[]} bubbles
 * @returns {{bubbles:string[], dropped:number}}
 */
function dedupeRepeatedBubbles(bubbles) {
  const list = (bubbles ?? []).map((text) => String(text ?? ''));
  const marks = list.map(bubbleFingerprint);
  const drop = new Set();
  for (let j = list.length - 1; j >= 0; j--) {
    const later = marks[j];
    if (!later) continue;
    for (let i = j - 1; i >= 0; i--) {
      if (drop.has(i)) continue;
      const earlier = marks[i];
      if (!earlier) continue;
      const contained =
        earlier.length >= 4 && later.length >= 4 && (later.includes(earlier) || earlier.includes(later));
      const similar =
        earlier.length >= 6 && later.length >= 6 && bigramDice(earlier, later) >= 0.6;
      if (earlier === later || contained || similar) {
        drop.add(i);
        break;
      }
    }
  }
  if (!drop.size) return { bubbles: list, dropped: 0 };
  return { bubbles: list.filter((_, index) => !drop.has(index)), dropped: drop.size };
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
  extractQuoteTarget,
  literalAtTarget,
  cleanAtSyntax,
  stripBridgeTags,
  extractMarkedBubbles,
  stripPlanningReply,
  resolveReplyBubbles,
  dedupeRepeatedBubbles,
};
