import { resolveQuote } from './quote.mjs';
import { isStickerImage } from '../domain/events.mjs';
import { contextMessage, sortWindow } from '../conversation/context.mjs';
import { imageCatalogSummary } from '../agent/image-catalog.mjs';
import { loadImagePart } from '../transport/media.mjs';
import { buildPrompt } from './render.mjs';
import { buildNameMap } from '../conversation/names.mjs';
import { asksToReadForward, fetchForward, forwardSegments } from './forward.mjs';

function hasImageSegment(message) {
  return Array.isArray(message) && message.some((s) => s?.type === 'image');
}

function asksToLook(text, triggers) {
  const t = String(text ?? '').toLowerCase();
  if (!t || !triggers?.length) return false;
  if ((triggers ?? []).some((k) => {
    const needle = String(k ?? '')
      .trim()
      .toLowerCase();
    return needle && t.includes(needle);
  })) return true;
  // 内置句式不依赖旧 profile 的固定词表；只用于有图可取的回合。
  return /(?:读|看|分析|描述|解释|辨认|认出|识别|提取|比较|对比|照着|按照|根据).{0,16}(?:图|照片|截图|相片|表情|上面|上边|前面|刚才|这张|那张|这几张|那几张)/u.test(t) ||
    /(?:图|照片|截图|相片|这张|那张).{0,16}(?:什么|啥|怎么|怎样|内容|意思|哪里|哪儿)/u.test(t) ||
    /(?:看|读|分析|描述|解释).{0,8}(?:这|那)(?:个|张)?/u.test(t) ||
    /(?:改成|做成|照着|按|参考|对照).{0,12}(?:这样|这个|上面|上边|刚才|那张|这张)/u.test(t) ||
    /(?:这|那)(?:个|张)?(?:是)?(?:什么|啥)|这个啊|这张啊/u.test(t);
}

async function buildPromptContent(ctx, config, event, stats, extras = {}) {
  const quote = await resolveQuote(ctx, config, event);
  const batchQuotes = [];
  if (extras.inputTimeline?.length) for (const m of extras.inputTimeline) {
    if (m.replyToId == null || String(m.messageId) === String(event.message_id)) continue;
    const resolved = await resolveQuote(ctx, config, { ...event,
      message: [{ type: 'reply', data: { id: m.replyToId } }] });
    batchQuotes.push({ messageId: m.messageId, ...resolved });
  }

  // 这条消息自己的图 + **被引用消息里的图**。
  // 引用那部分以前被完全丢掉了。
  const batchEvents = extras.inputEvents?.length > 1 ? extras.inputEvents : null;
  const textOf = (item) => Array.isArray(item.message)
    ? item.message.filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('').trim()
    : String(item.message ?? '').trim();
  const allEvents = batchEvents ?? [event];
  const rawBody = (batchEvents ? batchEvents.map(textOf).join('\n') : textOf(event)).trim();
  const currentForwardEntries = allEvents.flatMap((item) =>
    forwardSegments(item.message).map((segment) => ({ item, segment })));
  const quotedForwardEntries = [
    ...(quote.forwards ?? []).map((segment) => ({ quote, segment })),
    ...batchQuotes.flatMap((item) => (item.forwards ?? []).map((segment) => ({ quote: item, segment }))),
  ];
  const forwardPresent = currentForwardEntries.length > 0 || quotedForwardEntries.length > 0;
  // A message containing only a forward is itself an explicit request to read
  // that object, just like a private message containing only an image. Keep
  // unrelated forward segments in a text batch lazy.
  const directForward = currentForwardEntries.length > 0 && !rawBody;
  const forwardMode = ['lazy', 'always', 'never'].includes(String(config.forwardMode))
    ? String(config.forwardMode) : 'lazy';
  const quotedForwardAuto = quotedForwardEntries.length > 0 && config.attachQuotedForwards !== false;
  const wantForward = forwardPresent && forwardMode !== 'never' &&
    (forwardMode === 'always' || directForward || quotedForwardAuto || asksToReadForward(rawBody, config.forwardTriggers));
  const contextForwardCap = Math.max(0, Number(config.contextForwardsOnRequest) || 0);
  const contextForwardRequested = !forwardPresent && forwardMode !== 'never' && contextForwardCap > 0 &&
    asksToReadForward(rawBody, config.forwardTriggers);
  const contextForwardEntries = [];
  if (contextForwardRequested) {
    const currentId = event.message_id == null ? null : String(event.message_id);
    const candidates = sortWindow(extras.windowMessages ?? [])
      .filter((item) => !item.bot && Array.isArray(item.forwards) && item.forwards.length &&
        (currentId == null || String(item.messageId) !== currentId))
      .reverse();
    for (const item of candidates) {
      for (const segment of item.forwards) {
        if (contextForwardEntries.length >= contextForwardCap) break;
        contextForwardEntries.push({ item, segment });
      }
      if (contextForwardEntries.length >= contextForwardCap) break;
    }
  }
  const expandedEvents = new Map();
  const forwardBlocks = [];
  const forwardCache = new Map();
  const readForward = async (segment) => {
    const id = segment?.data?.id ?? segment?.data?.resid ?? segment?.data?.message_id;
    const key = id == null || id === '' ? segment : String(id);
    if (!forwardCache.has(key))
      forwardCache.set(key, fetchForward(ctx, config, segment, { stats, signal: extras.signal }));
    return forwardCache.get(key);
  };
  if (wantForward) {
    for (const item of allEvents) {
      const entries = currentForwardEntries.filter((entry) => entry.item === item);
      if (!entries.length) continue;
      const replacements = new Map();
      for (const { segment } of entries) {
        const loaded = await readForward(segment);
        replacements.set(segment, loaded.text);
        forwardBlocks.push({ item, ...loaded, source: 'current' });
      }
      const message = Array.isArray(item.message)
        ? item.message.flatMap((segment) => replacements.has(segment)
          ? [{ type: 'text', data: { text: replacements.get(segment) } }]
          : [segment])
        : item.message;
      expandedEvents.set(item, { ...item, message });
    }
  }
  const expandedQuoteText = { primary: quote.text, batch: new Map() };
  if (wantForward) {
    for (const { quote: target, segment } of quotedForwardEntries) {
      const loaded = await readForward(segment);
      const suffix = loaded.text;
      const previous = target === quote
        ? expandedQuoteText.primary
        : expandedQuoteText.batch.get(target) ?? target.text;
      const text = previous ? `${previous}\n${suffix}` : suffix;
      if (target === quote) expandedQuoteText.primary = text;
      else expandedQuoteText.batch.set(target, text);
      forwardBlocks.push({ quote: target, ...loaded, source: 'quote' });
    }
  }
  for (const { item, segment } of contextForwardEntries) {
    const loaded = await readForward(segment);
    forwardBlocks.push({ item, ...loaded, source: 'context' });
  }
  const expandedEvent = expandedEvents.get(event) ?? event;
  const expandedBatch = batchEvents?.map((item) => expandedEvents.get(item) ?? item) ?? null;
  const expandedTextOf = (item) => Array.isArray(item.message)
    ? item.message.filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('').trim()
    : String(item.message ?? '').trim();
  const body = (expandedBatch ? expandedBatch.map(expandedTextOf).join('\n') : expandedTextOf(expandedEvent)).trim();
  const look = asksToLook(body, config.imageTriggers);
  const ownImages = batchEvents ? batchEvents.flatMap((item) => {
    const text = textOf(item);
    return (Array.isArray(item.message) ? item.message : []).filter((s) => s?.type === 'image' &&
      (!isStickerImage(s) || !item.__inputPassive && Boolean(text)));
  }) : Array.isArray(event.message)
    ? event.message.filter((s) => s?.type === 'image')
    : [];
  const quotedImages = [...(quote.images ?? []), ...batchQuotes.flatMap((q) => q.images ?? [])];
  if (batchEvents && look && !quotedImages.length && (/表情/u.test(body) || !ownImages.length)) {
    // A request can arrive in one bubble and its sticker in another. Select the nearest
    // same-author image, rather than attaching every other person's reaction.
    const requester = batchEvents.findLast((item) => !item.__inputPassive && asksToLook(textOf(item), config.imageTriggers));
    const target = requester && batchEvents.filter((item) => item.__inputPassive &&
      String(item.user_id) === String(requester.user_id) && item.message?.some((s) => s?.type === 'image'))
      .sort((a, b) => Math.abs(batchEvents.indexOf(a) - batchEvents.indexOf(requester)) -
        Math.abs(batchEvents.indexOf(b) - batchEvents.indexOf(requester)))[0];
    if (target) ownImages.push(...target.message.filter((s) => s?.type === 'image'));
  }
  const withImage = ownImages.length + quotedImages.length > 0;

  // 读图策略
  const mode = config.imagesEnabled ? String(config.imageMode || 'lazy') : 'never';
  const isPrivate = event.message_type === 'private';
  const wantAttach =
    mode === 'always' ||
    (mode === 'lazy' &&
      (look ||
        ownImages.some((s) => !isStickerImage(s)) ||
        (ownImages.length > 0 && Boolean(body)) ||
        // 私聊纯表情包也直接读取
        (isPrivate && config.readImagesInPrivate) ||
        // 引用一张图，基本就是想聊它
        (quotedImages.length > 0 && config.attachQuotedImages)));

  // 先把图真的读出来，再拼提示词。
  // 顺序反过来的话，图片加载失败时提示词里会写着"图就在下面"，
  // 而实际一张都没附上 —— 模型会以为自己看得见，然后对着空气描述。
  const imageParts = [];
  const seenImages = new Set();
  const loadedImages = new Set();
  const partKeys = new Map();
  const imageKey = (segment) => segment?.data?.file || segment?.data?.url || segment?.data?.path || segment;
  let loadAttempts = 0;
  const load = async (segment) => {
    const id = imageKey(segment);
    if (seenImages.has(id) || loadAttempts >= 16) return null;
    seenImages.add(id);
    loadAttempts++;
    const loaded = await loadImagePart(config, segment);
    if (loaded?.skipped) {
      ctx.logger.warn(`qq-bridge: 跳过一张图片 —— ${loaded.skipped}`);
      if (stats) stats.imageSkips = [...(stats.imageSkips ?? []), loaded.skipped].slice(-3);
    }
    if (loaded?.part) {
      loadedImages.add(id);
      partKeys.set(loaded.part, id);
    }
    return loaded?.part ?? null;
  };
  if (withImage && wantAttach) {
    const allImages = [...ownImages, ...quotedImages];
    for (const segment of allImages) {
      if (imageParts.length >= 4 || loadAttempts >= 16) break;
      const part = await load(segment);
      if (part) imageParts.push(part);
    }
  }

  const attached = imageParts.length > 0;

  /**
   * QQ 号 → 昵称。@ 段里只有号，不补昵称的话提示词里就是一堆 `@123456`，
   * 谁也看不出「这条 @ 的是谁」——而那正是判断"这话是不是对我说的"的关键。
   */
  const names = await buildNameMap(config, event, {
    ctx,
    stats,
    windowMessages: extras.windowMessages,
  });

  /**
   * 上下文里的旧图：只在**这次明确要求看图**时才附。
   *
   * `look` 是"对方这轮的消息里有看图触发词"（或私聊直发图）。
   * 平时上下文里只留 `[图片]` 占位 —— 把历史图片一直挂着按张计费，
   * 而它们多半只是当时的背景噪音。
   */
  const contextParts = [];
  let contextImageCount = 0;
  const contextCap = Math.max(0, Number(config.contextImagesOnRequest) || 0);
  let contextImagePresent = false;
  // 当前/引用的图就是明确对象，避免再附无关旧图；无图请求才回找历史。
  if (mode !== 'never' && look && !withImage && contextCap > 0) {
    // 从窗口尾部往前找带图的旧消息（跳过当前这条，它已经单独处理过）
    const withImages = sortWindow(extras.windowMessages ?? [])
      .filter((m) => !m.bot && Array.isArray(m.images) && m.images.length &&
        (event.message_id == null || String(m.messageId) !== String(event.message_id)))
      .reverse();
    // 普通截图优先，不让随后刷的表情把真正要看的图挤掉。
    const ordinary = withImages.filter((m) => m.images.some((s) => !isStickerImage(s)));
    const selected = /表情/u.test(body) || !ordinary.length ? withImages : ordinary;
    contextImagePresent = selected.length > 0;
    for (const m of selected) {
      if (contextImageCount >= contextCap) break;
      for (const segment of m.images) {
        if (contextImageCount >= contextCap) break;
        if (ordinary.length && !/表情/u.test(body) && isStickerImage(segment)) continue;
        const part = await load(segment);
        if (part) {
          contextParts.push({ type: 'text', text:
            `【上文图片：消息 ${m.messageId ?? '(未知)'}，发送者 ${m.who || m.qq || '(未知)'}】` }, part);
          contextImageCount += 1;
        }
      }
    }
    if (contextImageCount && stats) {
      stats.contextImagesAttached = (stats.contextImagesAttached ?? 0) + contextImageCount;
    }
  }

  // Keep every addressable picture in a bounded, per-turn catalog. Bytes stay lazy,
  // including earlier messages when the current/quoted target already has images.
  const imageMessages = new Map();
  const addImages = (m, source) => {
    if (m.messageId == null || !m.images?.length) return;
    imageMessages.set(String(m.messageId), { messageId: String(m.messageId), qq: m.qq,
      who: m.who, at: m.at, source, images: m.images });
  };
  if (mode !== 'never') {
    for (const m of sortWindow(extras.windowMessages ?? [])) if (!m.bot) addImages(m, 'history');
    for (const q of [quote, ...batchQuotes]) addImages({ messageId: q.targetMessageId,
      qq: q.senderId, who: q.who, images: q.images }, 'quote');
    for (const item of allEvents) addImages(contextMessage(item), 'current');
  }
  const imageCatalog = [...imageMessages.values()].map((m) => ({ ...m,
    attached: m.images.flatMap((s, i) => loadedImages.has(imageKey(s)) ? [i] : []) }));

  const expandedTimeline = extras.inputTimeline?.map((m) => {
    const item = allEvents.find((candidate) => String(candidate.message_id) === String(m.messageId));
    const expanded = item && expandedEvents.get(item);
    return expanded ? { ...m, text: expandedTextOf(expanded) } : m;
  });
  /**
   * 图片目录 / 合并转发 / 批量引用都算「背景材料」，交给 buildPrompt 放进材料区。
   *
   * 以前这些是直接拼在 buildPrompt 结果**后面**的，等于塞进了「现在这条消息」的
   * 正文之后：正文被一串 JSON 夹在中间，模型分不清哪一句是要回的话、哪一段是资源
   * 清单。现在材料归材料、正文归正文，当前消息永远是最后一段。
   */
  const materials = [];
  if (imageCatalog.length) {
    materials.push(['【本轮可读图片目录】',
      '要读图时调 qq_read_image：message_id 用下面的编号，image_index 从 0 开始，每次返回一张。',
      '「已附」是本轮已经给了像素的图；「未附」只是占位，不能当成看过。',
      '不能把最近一张当作整组图片：涉及多图、前面几张或比较时，按任务范围逐张补读，读全后再下结论。',
      '不带参数可重新列目录；目录之外的图需要对方重新发送或引用。',
      ...imageCatalogSummary(imageCatalog).map((m) =>
        `- 消息 ${m.message_id}｜${m.sender}｜来源 ${m.source}｜共 ${m.image_count} 张`
        + `｜已附 ${m.attached_indices.length ? m.attached_indices.join('、') : '无'}`
        + `｜已读 ${m.read_indices.length ? m.read_indices.join('、') : '无'}`),
    ].join('\n'));
  }
  const nonCurrentForward = forwardBlocks.filter(({ source, item }) => source === 'current' && item !== event);
  if (nonCurrentForward.length)
    materials.push(nonCurrentForward.map(({ text }) => text).join('\n'));
  const contextBlocks = forwardBlocks.filter(({ source }) => source === 'context');
  if (contextBlocks.length) {
    materials.push(contextBlocks.map(({ item, text }) =>
      `【上文合并转发：消息 ${item.messageId ?? '(未知)'}，发送者 ${item.who || item.qq || '(未知)'}】\n${text}`).join('\n'));
  } else if (contextForwardRequested) {
    materials.push('【你要求查看上文合并转发，但目标不在当前有界窗口内；不要猜测其内容。】');
  }
  const visibleForwardIds = [
    ...currentForwardEntries.map(({ segment }) => segment?.data?.id ?? segment?.data?.resid ?? segment?.data?.message_id),
    ...quotedForwardEntries.map(({ segment }) => segment?.data?.id ?? segment?.data?.resid ?? segment?.data?.message_id),
  ].filter((id) => id != null && id !== '').map(String);
  if (forwardPresent && !forwardBlocks.length) {
    materials.push((forwardMode === 'never'
      ? '【这里有一条合并转发；当前配置未展开其正文。】'
      : '【这里有一条合并转发；若要阅读其正文，请明确要求查看、总结或展开。】') +
      `\n需要时可调用 qq_read_forward，forward_id：${visibleForwardIds.join(', ') || '（未取到编号）'}，按 next_offset 分页读取。`);
  }
  if (forwardBlocks.length)
    materials.push('【合并转发正文已由桥接按预算读取；不要用历史搜索工具猜测其内容。】');
  const expandableForwards = forwardBlocks.filter((block) => block.hasMore && block.forwardId);
  const forwardsWithImages = forwardBlocks.filter((block) => block.imageCount > 0 && block.forwardId);
  if (forwardsWithImages.length) {
    materials.push('【合并转发中的图片尚未加载】[图片] 只是占位。需要看图时调用 qq_read_forward：' +
      'forward_id 取下列编号，node_index 填正文中的节点编号，image_index 从 0 开始（默认 0）；每次返回一张真实图片。' +
      '同一节点有多张图片时，需按 image_count 读取任务所需的全部序号，不能只看默认第 0 张。' +
      '未展示的节点可先分页查询 index 与 image_count。\n' +
      [...new Map(forwardsWithImages.map((block) => [block.forwardId, block])).values()]
        .map((block) => `- forward_id=${block.forwardId}（共 ${block.imageCount} 张图片）`).join('\n'));
  }
  if (expandableForwards.length) {
    materials.push('【合并转发仍有未展开内容】若任务需要完整阅读，调用 qq_read_forward，' +
      'forward_id 取下列编号，按 next_offset 分页；单页最多 20 条。\n' +
      expandableForwards.map((block) => `- forward_id=${block.forwardId}（已展示 ${block.shown ?? 0}/${block.total ?? '?'} 条）`).join('\n'));
  }
  if (batchQuotes.length) materials.push('【本批其他消息的引用】\n' +
    batchQuotes.map((q) => `消息 ${q.messageId}：${expandedQuoteText.batch.get(q) ?? q.text}`).join('\n'));

  if (contextImagePresent && !contextImageCount)
    materials.push('【你要求查看上文图片，但图片字节未能取到；不要猜测图片内容。】');

  const parts = [
    {
      type: 'text',
      text: buildPrompt(expandedEvent, config, {
        quote: expandedQuoteText.primary,
        ...extras,
        inputTimeline: expandedTimeline,
        names,
        imagePresent: withImage,
        imageAttached: attached,
        wantAttach,
        contextImages: contextImageCount,
        materials: materials.join('\n\n'),
      }),
    },
    ...[...imageParts, ...contextParts].flatMap((part) => {
      if (part.type !== 'image') return [part];
      const addresses = imageCatalog.flatMap((m) => m.images.flatMap((s, i) =>
        imageKey(s) === partKeys.get(part) ? [`消息 ${m.messageId}，图片 ${i}`] : []));
      return addresses.length ? [{ type: 'text', text: `【${addresses.join('；')}】` }, part] : [part];
    }),
  ];

  if (withImage && !attached) {
    stats && (stats.imagesSkipped = (stats.imagesSkipped ?? 0) + 1);
    ctx.logger.info(
      `qq-bridge: 没读图（${
        !wantAttach
          ? mode === 'lazy'
            ? '没触发读图条件'
            : '图片功能已关闭'
          : '要求了但没取到图片字节'
      }）`,
    );
  }

  // 回报给调用方：这条消息（含被引用的）到底有没有图、附上了没有。
  // 让 handler 不必重新推断 —— 引用的图不在 event.message 里，重算必然漏。
  if (stats) {
    stats.lastForward = { mode: forwardMode, present: forwardPresent || contextForwardEntries.length > 0,
      requested: wantForward || contextForwardRequested, expanded: forwardBlocks.length,
      quoted: forwardBlocks.filter((item) => item.source === 'quote').length,
      messages: forwardBlocks.reduce((n, item) => n + (item.count ?? 0), 0) };
    stats.lastImagePresent = withImage;
    stats.lastImageAttached = attached;
    stats.lastQuotedImages = quotedImages.length;
    stats.lastImages = { mode, requested: look, own: ownImages.length, quoted: quotedImages.length,
      wantAttach, attached: imageParts.length, contextAttached: contextImageCount,
      contextPresent: contextImagePresent };
  }
  Object.defineProperty(parts, 'imageInfo', {
    value: {
      present: withImage || contextImagePresent,
      attached: attached || contextImageCount > 0,
      attachedCount: imageParts.length + contextImageCount,
    },
  });
  Object.defineProperty(parts, 'imageCatalog', { value: imageCatalog });
  return parts;
}

export { hasImageSegment, asksToLook, buildPromptContent };
