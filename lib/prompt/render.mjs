import { sortWindow } from '../conversation/context.mjs';
import {
  renderMessage,
  atTargets,
  mentionsBot,
  mentionsName,
  leadingNameMatch,
  stripLeadingSelfMentions,
  decorateAtTokens,
  lookupName,
} from '../domain/events.mjs';
import {
  resolvePersona,
  resolveBehavior,
  stickerInstructionLines,
} from './text-sources.mjs';
import { stableProtocol } from './protocol.mjs';
import { planExamples } from './examples.mjs';
import { nowLine } from '../domain/time.mjs';
import { workspaceDirectory, workspaceRoot } from '../agent/workspace.mjs';
import { name } from '../metadata.mjs';
import { isTransientConversationFact, conversationFactsEnabled } from '../memory/facts.mjs';
import { compactPersonMemory } from '../memory/presentation.mjs';

// 普通闲聊不需要把宿主绝对路径放进上下文；文件/任务回合仍需它给文档工具使用。
const WORKSPACE_HINT_RE = /(?:文件|文档|代码|脚本|网页|html|pdf|word|pptx?|xlsx?|表格|写|生成|修改|打包|压缩|发我|上传|下载|workspace)/iu;

function buildPrompt(event, config, extras = {}) {
  const {
    quote = '',
    memoryText = '',
    taskText = '',
    windowText = '',
    stickerAllowed = true,
    stickerGap = 0,
    awake = false,
    interjectCooldownRemainingMs = 0,
    imagePresent = false,
    imageAttached = false,
    shape = null,
    heartbeat = false,
    attention = null,
    includeStatic = true,
    includeWindow = true,
    wantAttach = false,
    gapNotice = '',
    /** 这条其实是戳一戳（由桥接归一化成合成消息事件）。 */
    poke = false,
    /** 她自己发过的消息最近收到的表情回应。 */
    reactions = null,
    /** 上下文（滑动窗口）里要求附上的旧图数量。 */
    contextImages = 0,
    sourceRef = null,
    /** QQ 号 → 昵称；用来把 @ 渲染成人看得懂的名字（见 conversation/names.mjs）。 */
    names = null,
  } = typeof extras === 'string' ? { quote: extras } : extras;

  const isGroup = event.message_type === 'group';
  const where = isGroup ? `QQ 群 ${event.group_id}` : 'QQ 私聊';
  /**
   * 发言人。
   *
   * 戳一戳要特殊处理：私聊事件里 `user_id` 是**机器人自己**，归一化时
   * 被换成了发言人，所以直接用 event.user_id 是对的；
   * 但为了避免"谁知道以后哪一环又改回去"，戳一戳一律以 __pokeSender 为准。
   */
  const speakerId = poke ? (event.__pokeSender ?? event.user_id) : event.user_id;
  const who = event.sender?.card || event.sender?.nickname || String(speakerId);

  // 必须显式告诉 Agent「你被 @ 了」：触发判定用的是 at 段，
  // 但正文里机器人自己的那个 @ 会被去掉（见下）。
  const botIds = config.selfIds.length ? config.selfIds.map(String) : [String(event.self_id)];
  const isSelf = (qq) => botIds.includes(String(qq));
  // 被 @ 和"被叫名字"要分开告诉它：@ 是明确点名，叫名字语气更随意。
  const atBot = isGroup && mentionsBot(event.message, botIds);
  const calledName = isGroup && !atBot && mentionsName(event.message, config.nameTriggers);
  const mentioned = atBot || calledName;

  /**
   * 正文。
   *
   * 只去掉**开头 @ 机器人自己**的那一段；别人的 @ 全部保留、并且尽量渲染成昵称。
   *
   * 旧实现是拿正则把开头的 `@数字` 全部删掉，遇到
   * `@天梦 你把 @大肥鱼 的管理员下了` 就变成「你把 @你 的管理员下了」——
   * 说话对象被删掉、只剩下机器人自己，意思完全反了，
   * 它会以为有人在使唤它（实测就会接不上梗、答非所问）。
   */
  const bodySegments = isGroup ? stripLeadingSelfMentions(event.message, botIds) : event.message;
  const renderedBody = isGroup
    ? renderMessage(bodySegments, { names, selfIds: botIds })
    : renderMessage(event.message, { names, selfIds: botIds }).trim();
  const nameStripped = isGroup ? leadingNameMatch(renderedBody, config.nameTriggers) : null;
  const body =
    nameStripped === null
      ? renderedBody.trim()
      : nameStripped.replace(/^[\s,，、:：!！?？~～-]+/, '').trim();

  const lines = [];
  if (includeStatic) {
    const persona = resolvePersona(config), behavior = resolveBehavior(config);
    if (persona) lines.push('[你的人设]', persona, '');
    if (behavior) lines.push('[群聊行为规则]', behavior, '');
    lines.push(stableProtocol(config, isGroup));
  }

  const examplePlan = extras.examplePlan ?? planExamples(config, body, {}, {
    includeStatic, poke, heartbeat, imagePresent, taskText,
  });
  if (examplePlan.text) lines.push('', '【本轮表达参考】学接话关系和节奏；具体人物、经历和台词属于示范材料。', examplePlan.text);

  if (imagePresent && wantAttach) lines.push('', imageAttached
    ? '【对方发了图片，图就在下面，你可以直接看】'
    : '【对方想让你看图，但图没能取到】仅按文字理解；示范：说明图片未加载，等取得像素后再描述。');
  if (contextImages > 0) lines.push('', `【另外附上了前面 ${contextImages} 张旧图】依据标注的原作者与消息归属理解图片。`);
  if (heartbeat) lines.push('', '【这是你自己想插一句】',
    `这是自主参与机会。顺着当前话题表达自己的反应；选择旁听时只回 ${config.silenceToken}。示范：别人正在互相解释问题，就把这一来回留给他们。`);
  else if (poke) lines.push('', '【这是戳一戳，不是消息】',
    `${who} 戳了你一下。按角色和当前关系回应；选择安静时只回 ${config.silenceToken}。这是互动事件，正文占位用于说明事件。`);
  else if (isGroup && config.silenceToken) {
    if (awake && !mentioned) lines.push('', '【你还醒着】',
      '唤醒窗口内可听见群消息；结合 @、引用和来回辨认对象，接你的话自然回应，别人闲谈可以旁听。');
    if (attention?.kind === 'consider') lines.push('', '【本轮由你一次判断并回应】',
      `结合时间线决定回复、等待或沉默；追问、反驳、纠正都算接话。只输出正文；等待 [WAIT]，旁听 ${config.silenceToken}。`);
    else if (attention) lines.push('', '【本轮回应】按实际意思接话；已经收尾可以旁听。');
    else if (!mentioned && !awake) lines.push('', '【要不要搭话】',
      `当前未 @ 你；叫名字、承接上一句或有合适参与点时接话，否则 ${config.silenceToken}。`);
    if (interjectCooldownRemainingMs > 0) lines.push('【参与间隔】刚发过言可继续来回；新话题先给别人留空隙。');
  }
  if (gapNotice) lines.push('', '【注意：中间有消息没接住】', gapNotice,
    '按当前可见消息理解；涉及缺失段的事实时保留不确定。');
  lines.push(`【你的 QQ】${event.self_id}`);
  const convKey = isGroup ? `group:${event.group_id}` : `user:${event.user_id}`;
  lines.push(`【当前会话】${convKey}（工具 conversation）`);
  if (sourceRef) lines.push(`【本轮来源】${sourceRef}（工具 source_ref 原样填写）`);
  if (extras.floorManagement) lines.push('【轮次判断】结合时间线回应本轮有效输入；[WAIT] 等补充。floor 跳过代表回应已过时，读取最新输入后重新判断。');
  let workspaceDir = '';
  const workspaceNeeded = extras.workspaceNeeded ?? Boolean(!isGroup || taskText || extras.taskOwnership || WORKSPACE_HINT_RE.test(body));
  if (workspaceNeeded) {
    try { workspaceDir = workspaceDirectory(workspaceRoot(config), extras.workspaceScope ?? convKey); } catch {}
    if (workspaceDir) lines.push(`【工作区绝对路径】${workspaceDir}`);
  }
  lines.push(nowLine());

  if (memoryText) lines.push('', '【相关记忆材料】按主体、时期和来源理解；当前更正优先。', memoryText);
  if (taskText) lines.push('', '【相关任务材料】只核对本轮关联任务；按状态和回执理解。', taskText);
  if (config.memoryEnabled && !config.memoryAutoExtract && config.rememberMarker)
    lines.push('', '【记忆写入提醒】',
      `当前发送者的稳定事实可写末行 ${config.rememberMarker}事实]；日期由宿主记录。`);
  if (Array.isArray(reactions) && reactions.length) {
    lines.push('', '【你刚才的发言收到了表情回应】');
    for (const r of reactions.slice(0, 5)) lines.push(`· 消息 ${r.messageId}：${[
      r.add?.length ? '加了 ' + r.add.join('/') : '',
      r.remove?.length ? '撤了 ' + r.remove.join('/') : '',
    ].filter(Boolean).join('，')}`);
    lines.push('表情回应是互动事实，结合原消息判断。');
  }
  if (extras.inputTimeline?.length) {
    lines.push('', '【本次收集的原始消息（按真实时间；作者各自独立）】');
    for (const m of extras.inputTimeline)
      lines.push(`[消息 ${m.messageId ?? '?'}，时间 ${m.at}，${m.who}（${m.qq}）${m.replyToId ? '，引用 ' + m.replyToId : ''}] ${m.text}`);
    lines.push('合并同一请求的补充，作者分别归属；其余历史仅作背景。');
  }
  const mfaces = Array.isArray(event.message) ? event.message.filter((s) => s?.type === 'mface').map((s) => s.data) : [];
  if (mfaces.length) lines.push('', '【当前动画表情】复现同一张时，qq_send_mface 使用以下真实字段。', JSON.stringify(mfaces[0]));
  const anchor = String(config.toneAnchor ?? '').trim();
  if (anchor) lines.push('', anchor);
  if (shape) {
    lines.push('', '【这条回多少】', `最多回 ${shape.bubbles} 个气泡，空行分隔；一句够用就停。`);
    lines.push(shape.sticker && stickerAllowed
      ? '这条要配 1 张表情包：在回复最后单独一行写 [表情:编号]，选择已知候选中的真实编号。'
      : `这条使用纯文字${shape.sticker ? '（表情间隔尚余）' : ''}。`);
  }
  // Keep only the per-turn actions here; the full protocol is sent with the static card.
  lines.push('', '【本轮发送规则】普通正文交桥接；进度用 qq_say，长任务用 qq_delegate；完成后交新的最终结果。',
    '【要动手的事，就真的动手】先调工具再报告；修改资料必须回读。UNKNOWN=待核对，FAILED=失败。');
  if (isGroup && config.atMentionEnabled !== false)
    lines.push(`【点名对象】确需点名时优先 [@昵称]，也可 [@:${speakerId}]；范围为当前记录中的真实个体。`);

  if (includeWindow && windowText) {
    lines.push('', '【共享聊天历史的边界】历史只用于人物、引用和话题；执行归属看本轮来源。');
    if (extras.windowDelta) lines.push('【时间线增量】按真实时间合并；重复消息 ID 以新记录为准。');
    lines.push(decorateAtTokens(windowText, names, botIds));
  }
  if (config.stickerHints) {
    lines.push('', '【你的表情包·本轮候选】', ...stickerInstructionLines(config, body));
    if (!stickerAllowed) lines.push(`【表情间隔】距上一张 ${stickerGap} 轮，本轮使用纯文字。`);
    else if (shape && !shape.sticker) lines.push('【本轮形状】本轮使用纯文字，候选供理解表情含义。');
  }
  lines.push('', '—— 现在这条消息 ——');
  const suffix = atBot ? '｜对方 @ 了你' : calledName ? '｜对方叫了你的名字' : '';
  lines.push(`[来自 ${where}｜发送者：${who}（QQ ${speakerId}）${suffix}]`);
  if (event.message_id != null) lines.push(`[当前消息 ID：${event.message_id}]`);
  if (isGroup) {
    const ats = atTargets(event.message).filter((qq) => qq !== 'all');
    const labels = ats.map((qq) => isSelf(qq) ? '你' : lookupName(names, qq) ?? `QQ ${qq}`);
    if (ats.length && atBot && !isSelf(ats[0]))
      lines.push(`【说话对象】主要对象是 ${labels[0]}，不是你；你是被提及的客体。按原作者请求归属理解，选择旁听时 ${config.silenceToken}。`);
    else if (ats.length && atBot && labels.length > 1)
      lines.push(`【说话对象】同时 @ ${labels.join('、')}，主要在对你说。`);
    else if (ats.length && !atBot)
      lines.push(`【说话对象】点名的是 ${labels.join('、')}，你按上下文选择是否参与。`);
  }
  if (quote) lines.push(decorateAtTokens(quote, names, botIds));
  if (extras.taskOwnership) lines.push('【本轮执行归属】' + JSON.stringify(extras.taskOwnership),
    '只处理上述消息 ID；其他任务仅用于核对。工具沿用本轮 source_ref 和会话工作区。');
  lines.push(body || (mentioned ? '【系统上下文：仅 @、正文为空】' : '【系统上下文：正文为空】'));
  return lines.join('\n');
}

// 只按完整行裁剪，避免截断事实的否定、消息来源或发送结果。
function fitMemoryLines(text, max, { tail = false } = {}) {
  if (text.length <= max) return text;
  const chosen = [];
  let used = 0;
  const rows = String(text).split('\n');
  for (const row of tail ? rows.reverse() : rows) {
    const size = row.length + (chosen.length ? 1 : 0);
    if (used + size > max) continue;
    chosen.push(row);
    used += size;
  }
  return (tail ? chosen.reverse() : chosen).join('\n').trim();
}

function memoryBlocks(config, event, entry, memory, { includeEpisodes = true } = {}) {
  if (!config.memoryEnabled || !memory) return [];
  const qq = String(event.user_id ?? '');
  if (!qq) return [];
  const who = event.sender?.card || event.sender?.nickname || qq;
  const blocks = [];
  const conversation = event.message_type === 'group' ? 'group:' + event.group_id : 'user:' + qq;
  // 会话约定整面关闭时连存档都不读，避免为注定不注入的内容付 IO。
  const sharedBudget = conversationFactsEnabled(config)
    ? (config.conversationMemoryMaxChars ?? 450) : 0;
  const shared = sharedBudget > 0
    ? (memory.activeFacts?.(conversation) ?? []).filter((r) => !isTransientConversationFact(r))
    : [];
  const sharedBlock = shared.length ? `【本会话长期约定】\n` + shared.slice(-10).map((r) =>
    `- ${r.fact}（${r.sources.map((s) => `${s.who || s.qq}，消息 ${s.messageId}`).join('；')}）`).join('\n') : '';
  const cap = (text, max = 900) => {
    return compactPersonMemory(text, max, typeof event.raw_message === 'string' ? event.raw_message
      : Array.isArray(event.message) ? event.message.filter((p) => p.type === 'text').map((p) => p.data?.text ?? '').join(' ') : event.message);
  };

  const own = memory.read(qq);
  // 无长期事实不代表没见过；归档里的事实也属于已保存记忆。
  const known = own && /^-\s+\S/m.test(own);
  const personBlock = (id, label, doc, rank) => {
    const rendered = doc && /^-\s+\S/m.test(doc)
      ? `【你对 ${label}（QQ ${id}）的记忆】\n${cap(doc, rank === 2 ? 900 : 350)}`
      : `【${label}（QQ ${id}）暂无已保存的长期记忆，不代表初见】`;
    return { key: 'user:' + id, hash: fingerprint(doc + '\n' + (doc ? cap(doc, 900) : '')), rank, text: rendered };
  };
  blocks.push(personBlock(qq, who, known ? own : '', 2));
  // 空约定也有版本：过去的约定被撤回时，通知模型不要继续沿用旧历史。
  const renderedShared = sharedBlock ? fitMemoryLines(sharedBlock, sharedBudget, { tail: true }) : '';
  blocks.push({ key: 'facts:' + conversation, hash: fingerprint(renderedShared), rank: 2,
    text: renderedShared,
    removedText: '【本会话约定更新】之前注入的会话约定已失效，以当前消息为准。' });
  if (includeEpisodes) {
    const episodes = memory.recallEpisodes?.(event, entry);
    if (episodes) blocks.push({ key: 'episodes:' + conversation,
      hash: fingerprint(episodes), rank: 1, text: fitMemoryLines(String(episodes), 450) });
  }

  const recentLimit = Math.max(0, Number(config.memoryInjectRecent) || 0);
  if (recentLimit > 0) {
    for (const other of (entry?.recentQqs ?? []).filter((x) => x !== qq).slice(0, recentLimit)) {
      const doc = memory.read(other);
      if (!doc) continue;
      const name = (doc.match(/^#\s*(.+?)（QQ/) ?? [])[1] ?? other;
      blocks.push(personBlock(other, name, doc, 1));
    }
  }
  return blocks;
}

/** 首次/变化的稳定记忆逐块注入；经历独立检索与去重，不改变人物指纹。 */
function buildMemoryInjection(config, event, entry, memory, options = {}) {
  const blocks = memoryBlocks(config, event, entry, memory, options);
  const hashes = { ...(entry?.memoryHashes ?? {}) };
  const onChange = config.memoryInjectOnChange && entry?.staticDone;
  let remaining = Number(config.memoryInjectMaxChars ?? 1800) || Infinity;
  const fitted = [];
  let stableInjected = false;
  for (const block of blocks) {
    const previous = block.key ? hashes[block.key] : null;
    if (onChange && previous?.hash === block.hash && previous.rank >= block.rank) continue;
    const text = block.text || (previous && previous.hash !== block.hash ? block.removedText ?? '' : '');
    if (!text) {
      if (block.key) hashes[block.key] = { hash: block.hash, rank: block.rank };
      continue;
    }
    const room = remaining - (fitted.length ? 2 : 0);
    // 预算不足时整块延后；不要把未注入/部分注入的块标为已知。
    if (text.length > room) continue;
    fitted.push(text);
    remaining = room - text.length;
    if (block.key) {
      hashes[block.key] = { hash: block.hash, rank: block.rank };
      stableInjected = true;
    }
  }
  return { text: fitted.join('\n\n'), hashes, stableInjected };
}

function buildMemorySection(config, event, entry, memory, options = {}) {
  return buildMemoryInjection({ ...config, memoryInjectOnChange: false }, event, entry, memory, options).text;
}

function buildWindowSection(config, entry) {
  if (!entry?.window?.length) return '';
  /**
   * 渲染"最近聊了什么"。
   *
   * 两个刻意的设计：
   *
   * 1. **从旧到新**。`entry.window` 内部也是按时间顺序保存，
   *    最新消息放在窗口末尾，和「现在这条消息」物理上相邻，近因更强。
   *
   * 2. **标出说话人身份**（`你（你自己刚才说的）`）。
   *    模型最常犯的错就是把自己说过的话当成别人说的，
   *    在群聊里这会直接导致"接自己的话"或者"回答自己"。
   */
  const lines = sortWindow(entry.window).map((m) => {
    const speaker = m.bot ? '你（你自己刚才说的）' : `${m.who || m.qq}（${m.qq}）`;
    const quoted = m.replyToId == null ? null : entry.window.find((x) => String(x.messageId) === String(m.replyToId));
    const source = m.messageId == null ? '' : ` [消息 ${m.messageId}]`;
    const quote = m.replyToId == null ? '' : ` [回复消息 ${m.replyToId}${quoted ? `，原发送者 ${quoted.bot ? '你' : quoted.who || quoted.qq}` : '，原文不在窗口内'}]`;
    return `${speaker}${source}${quote}：${m.text}`;
  });
  return `【最近聊了什么（从旧到新，共 ${lines.length} 条）】\n${lines.join('\n')}`;
}

function fingerprint(text) {
  const s = String(text ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export { buildPrompt, buildMemorySection, buildMemoryInjection, buildWindowSection, fingerprint };
