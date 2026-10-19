/** 取显示名：names 可以是 Map，也可以是普通对象；没有就返回 null。 */
function lookupName(names, qq) {
  if (!names) return null;
  const key = String(qq ?? '');
  if (!key) return null;
  const hit = typeof names.get === 'function' ? names.get(key) : names[key];
  const text = hit == null ? '' : String(hit).trim();
  return text || null;
}

function isStickerImage(segment) {
  const data = segment?.data ?? {};
  if (data.sub_type === 'sticker' || String(data.sub_type) === '1') return true;
  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  // OneBot 普通图片也可能有 summary="[图片]"，不能把它当成表情包。
  return Boolean(summary && summary !== '[图片]');
}

/** Background reactions may accompany a request, but never create their own group model turn. */
export function isPassiveReaction(event) {
  if (event.message_type !== 'group' || !Array.isArray(event.message)) return false;
  const visible = event.message.filter((s) => s?.type !== 'text' || String(s.data?.text ?? '').trim());
  return visible.length > 0 && visible.every((s) =>
    ['face', 'mface'].includes(s?.type) || s?.type === 'image' && isStickerImage(s));
}

function renderMessage(message, options = {}) {
  const { names = null, selfIds = [] } = options ?? {};
  const self = new Set((selfIds ?? []).map(String));
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  const out = [];
  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue;
    const data = segment.data ?? {};
    switch (segment.type) {
      case 'text':
        out.push(String(data.text ?? ''));
        break;
      case 'at': {
        /**
         * @ 的渲染是"这句话对谁说的"的唯一线索，所以不能糊。
         *
         * OneBot 的 at 段可能只有 QQ 号，昵称要靠 names 补。
         * 补不到就退回 QQ 号 —— 至少要让人看得出"这里 @ 的是别人"，
         * 而不是像以前那样被整段抹掉。
         */
        const qq = String(data.qq ?? '');
        if (qq === 'all') out.push('@全体成员');
        else if (self.has(qq)) out.push('@你');
        else out.push(`@${lookupName(names, qq) ?? qq}`);
        break;
      }
      case 'image': {
        // QQ 会给表情包带上文字摘要（例如 [动画表情]），普通图片没有。
        // 区分开很重要：表情包只是"一个情绪"，跟一张要读内容的图不是一回事。
        const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
        const isSticker = isStickerImage(segment);
        if (!isSticker) out.push('[图片]');
        else if (summary && !summary.startsWith('[')) out.push(`[表情包：${summary}]`);
        else out.push('[表情包]');
        break;
      }
      case 'face':
        out.push('[表情]');
        break;
      case 'record': {
        const text = typeof data.transcription === 'string' ? data.transcription.trim() : '';
        out.push(text ? `[语音转文字：${text}]` : data.transcriptionStatus === 'failed'
          ? '[语音：QQ 转文字失败，内容不可知]' : '[语音]');
        break;
      }
      case 'video':
        out.push('[视频]');
        break;
      case 'file':
        out.push(`[文件 ${data.name ?? ''}]`);
        break;
      case 'reply':
        out.push('[引用]');
        break;
      case 'mface':
        out.push(`[动画表情${data.summary ? ` ${data.summary}` : ''}]`);
        break;
      case 'forward':
        out.push('[合并转发]');
        break;
      default:
        // 未知段类型也要留痕。否则内容会静默消失，排查时完全看不出发生过什么。
        if (segment.type) out.push(`[${segment.type}]`);
        break;
    }
  }
  return out.join('');
}

/** 这条消息按顺序 @ 了谁（可能含特殊值 'all'）。 */
function atTargets(message) {
  if (!Array.isArray(message)) return [];
  const out = [];
  for (const segment of message) {
    if (segment?.type !== 'at') continue;
    const qq = segment.data?.qq;
    if (qq === undefined || qq === null || qq === '') continue;
    out.push(String(qq));
  }
  return out;
}

function mentionsBot(message, selfIds) {
  if (!Array.isArray(message)) return false;
  return message.some(
    (segment) =>
      segment?.type === 'at' &&
      (selfIds.length === 0 || selfIds.includes(String(segment.data?.qq))),
  );
}

function mentionsName(message, nameTriggers) {
  const triggers = (nameTriggers ?? []).map((t) =>
    String(t ?? '')
      .trim()
      .toLowerCase(),
  );
  if (!triggers.some(Boolean)) return false;
  const text = renderMessage(message).toLowerCase();
  if (!text) return false;
  return triggers.some((needle) => needle && text.includes(needle));
}

function leadingNameMatch(text, nameTriggers) {
  const triggers = (nameTriggers ?? []).map((t) =>
    String(t ?? '')
      .trim()
      .toLowerCase(),
  );
  const lower = String(text ?? '')
    .trim()
    .toLowerCase();
  for (const needle of triggers) {
    if (needle && lower.startsWith(needle)) return String(text).trim().slice(needle.length);
  }
  return null;
}

/**
 * 旧接口：按**文本**剥掉开头的 `@数字`。
 *
 * 它会把开头所有 @ 一起抹掉，包括"这句话是对谁说的"那个 ——
 * 遇到 `@天梦 你把 @大肥鱼 的管理员下了` 会把天梦删掉、只留机器人自己，
 * 意思正好反过来。新代码一律用 stripLeadingSelfMentions（按 at 段判断归属）。
 * 保留它只是为了兼容既有测试与外部调用。
 */
function stripLeadingMention(text, nameTriggers = []) {
  const noAt = String(text ?? '')
    .replace(/^(\s*@\d+\s*)+/, '')
    .trim();
  const rest = leadingNameMatch(noAt, nameTriggers);
  if (rest === null) return noAt;
  // 名字后面可能直接连着「，」「在吗」之类，统一去掉紧跟的分隔符
  return rest.replace(/^[\s,，、:：!！?？~～-]+/, '').trim();
}

/**
 * 只去掉**开头**那些 @ 机器人自己的 at 段（顺带吃掉夹在中间的空白文本）。
 *
 * 为什么必须按段做、不能再用正则抹开头：
 *   `@天梦 你把 @大肥鱼 的管理员下了`
 * 渲染出来是 `@1056612947 你把 @3667925015 的管理员下了`，
 * 旧的正则把开头的 `@1056612947`（**说话对象**）删掉，只留 @ 机器人自己那一段，
 * 整句话的意思正好反过来 —— 模型就以为在使唤它。
 * 别人的 @ 一个都不能动：那是判断"说给谁听"的唯一依据。
 */
function stripLeadingSelfMentions(message, selfIds = []) {
  if (!Array.isArray(message)) return message;
  const self = new Set((selfIds ?? []).map(String));
  let i = 0;
  while (i < message.length) {
    const segment = message[i];
    if (segment?.type === 'at' && self.has(String(segment.data?.qq ?? ''))) {
      i += 1;
      continue;
    }
    if (segment?.type === 'text' && !String(segment.data?.text ?? '').trim()) {
      i += 1;
      continue;
    }
    break;
  }
  return i === 0 ? message : message.slice(i);
}

/**
 * 把**已经渲染成文本**的 `@123456` 换成昵称。
 *
 * 滑动窗口、引用的消息在入库时就渲染过一次了（那时还没有昵称表），
 * 所以拼提示词时再补一次；否则窗口里全是裸 QQ 号，一样看不出说给谁听。
 */
function decorateAtTokens(text, names = null, selfIds = []) {
  const raw = String(text ?? '');
  if (!raw || !raw.includes('@')) return raw;
  const self = new Set((selfIds ?? []).map(String));
  return raw.replace(/@(\d{4,12})/g, (whole, qq) => {
    const key = String(qq);
    if (self.has(key)) return '@你';
    const name = lookupName(names, key);
    return name ? `@${name}` : whole;
  });
}

export {
  isStickerImage,
  renderMessage,
  atTargets,
  mentionsBot,
  mentionsName,
  leadingNameMatch,
  stripLeadingMention,
  stripLeadingSelfMentions,
  decorateAtTokens,
  lookupName,
};
