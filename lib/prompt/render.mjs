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
import { detectVoiceIntent } from './voice-intent.mjs';
import { planExamples } from './examples.mjs';
import { nowLine } from '../domain/time.mjs';
import { workspaceDirectory, workspaceRoot } from '../agent/workspace.mjs';
import { voiceLibraryPromptLines } from '../agent/voice-library.mjs';
import { name } from '../metadata.mjs';
import { isTransientConversationFact, conversationFactsEnabled } from '../memory/facts.mjs';
import { compactPersonMemory } from '../memory/presentation.mjs';

// 普通闲聊不需要把宿主绝对路径放进上下文；文件/任务回合仍需它给文档工具使用。
const WORKSPACE_HINT_RE = /(?:文件|文档|代码|脚本|网页|html|pdf|word|pptx?|xlsx?|表格|写|生成|修改|打包|压缩|发我|上传|下载|workspace)/iu;

/** 组横幅。只有四组用它，组内小节仍然用 `【】`。 */
const banner = (title) => `════════ ${title} ════════`;

function clockOf(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return '';
  const date = new Date(n < 1e11 ? n * 1000 : n);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * 一条聊天记录：`1. 名字（QQ 号）：内容 [消息 id｜时间｜回复谁]`。
 *
 * 说话人放在最前、内容紧跟、元数据退到行尾 —— 这是人能一眼扫过去的顺序。
 * 旧版是 `[消息 id，时间 t，谁（qq），引用 x] 内容`，元数据比内容还长，
 * 多条连在一起时人名被埋在方括号里，模型容易把上一条的发言人和下一条的串位。
 */
function recordLine(index, m, { self = false, quoteLabel = '' } = {}) {
  const speaker = self ? '你（你自己刚才说的）' : `${m.who || m.qq || '?'}（${m.source === 'bili' ? 'B站 UID' : 'QQ'} ${m.qq ?? '?'}）`;
  const meta = [];
  if (m.messageId != null && m.messageId !== '') meta.push(`消息 ${m.messageId}`);
  const clock = clockOf(m.at);
  if (clock) meta.push(clock);
  if (m.replyToId != null && m.replyToId !== '') meta.push(quoteLabel || `回复消息 ${m.replyToId}`);
  const tail = meta.length ? ` [${meta.join('｜')}]` : '';
  // 多行正文缩进续行，避免第二行看起来像一条新记录。
  const text = String(m.text ?? '').trim().replace(/\n/g, '\n   ') || '（非文本内容）';
  return `${index}. ${speaker}：${text}${tail}`;
}

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
    /** QQ 号 → 昵称；用来把 @ 渲染成人看得懂的名字（见 conversation/names.mjs）。 */
    names = null,
  } = typeof extras === 'string' ? { quote: extras } : extras;

  const isGroup = event.message_type === 'group';
  const isBili = event.__bridgeSource === 'bili';
  const where = isGroup ? `QQ 群 ${event.group_id}` : isBili ? 'B站私信' : 'QQ 私聊';
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

  /**
   * 提示词版式（2026-10-22 重整）。
   *
   * 旧版把二十多个 `【…】` 平铺成一条流：设定、本轮规则、记忆、任务、历史、
   * 当前消息全是同一级标题，模型只能靠上下文猜边界。实测症状就是"分不清谁在
   * 说什么"——把历史里的发言人当成当前说话人、把上一轮的规则当成本轮授权。
   *
   * 现在只分三层，层级靠位置和符号区分，不靠模型自己推断：
   *   · 组横幅 `════ 组名 ════`  —— 只有四组：设定与协议 / 本轮规则 / 背景材料 / 输入
   *   · 段标题 `【段名】`        —— 组内小节，同级
   *   · 记录行 `1. 名字（QQ 号）：内容 [消息 id｜时间]`
   *     一条消息一行，说话人永远在最前面，元数据退到行尾，不打断句子。
   * 「现在这条消息」固定在最后、紧贴生成位置：字段一行一个，正文单独起行。
   */
  const blocks = [];
  const rules = [];
  const materials = [];

  if (includeStatic) {
    const head = [];
    const persona = resolvePersona(config), behavior = resolveBehavior(config);
    if (persona) head.push('[你的人设]', persona, '');
    if (behavior) head.push('[群聊行为规则]', behavior, '');
    head.push(stableProtocol(config, isGroup));
    blocks.push(banner('你的设定与协议（长期有效，不是本轮任务）') + '\n' + head.join('\n'));
  }

  const examplePlan = extras.examplePlan ?? planExamples(config, body, {}, {
    includeStatic, poke, heartbeat, imagePresent, taskText,
  });

  const convKey = isGroup ? `group:${event.group_id}` : isBili ? `bili:${event.user_id}` : `user:${event.user_id}`;
  const workspaceNeeded = extras.workspaceNeeded ?? Boolean(!isGroup || taskText || extras.taskOwnership || WORKSPACE_HINT_RE.test(body));
  let workspaceDir = '';
  if (workspaceNeeded) {
    try { workspaceDir = workspaceDirectory(workspaceRoot(config), extras.workspaceScope ?? convKey); } catch {}
  }
  const stamp = nowLine().replace(/^（现在是\s*/u, '').replace(/。）$/u, '');
  rules.push(isBili
    ? `【环境】当前来源：B站私信 UID ${event.user_id}；当前会话 ${convKey}；现在是 ${stamp}`
    : `【环境】你的 QQ ${event.self_id}；当前会话 ${convKey}（qq_* 工具的 conversation 用这个值）；现在是 ${stamp}`);
  if (workspaceDir) rules.push(`【工作区绝对路径】${workspaceDir}`);
  if (extras.floorManagement) rules.push('【轮次判断】结合时间线回应本轮有效输入；[WAIT] 等补充。floor 跳过代表回应已过时，读取最新输入后重新判断。');

  if (imagePresent && wantAttach) rules.push(imageAttached
    ? '【对方发了图片，图就在下面，你可以直接看】'
    : '【对方想让你看图，但图没能取到】仅按文字理解；示范：说明图片未加载，等取得像素后再描述。');
  if (contextImages > 0) rules.push(`【另外附上了前面 ${contextImages} 张旧图】依据标注的原作者与消息归属理解图片。`);
  if (heartbeat) rules.push('【这是你自己想插一句】',
    `这是自主参与机会。顺着当前话题表达自己的反应；选择旁听时只回 ${config.silenceToken}。示范：别人正在互相解释问题，就把这一来回留给他们。`);
  else if (poke) rules.push('【这是戳一戳，不是消息】',
    `${who} 戳了你一下。按角色和当前关系回应；选择安静时只回 ${config.silenceToken}。这是互动事件，正文占位用于说明事件。`);
  else if (isGroup && config.silenceToken) {
    if (awake && !mentioned) rules.push('【你还醒着】',
      '唤醒窗口内可听见群消息；结合 @、引用和来回辨认对象，接你的话自然回应，别人闲谈可以旁听。');
    if (attention?.kind === 'consider') rules.push('【本轮由你一次判断并回应】',
      `结合时间线决定回复、等待或沉默；追问、反驳、纠正都算接话。只输出正文；等待 [WAIT]，旁听 ${config.silenceToken}。`);
    else if (attention) rules.push('【本轮回应】按实际意思接话；已经收尾可以旁听。');
    else if (!mentioned && !awake) rules.push('【要不要搭话】',
      `当前未 @ 你；叫名字、承接上一句或有合适参与点时接话，否则 ${config.silenceToken}。`);
    if (interjectCooldownRemainingMs > 0) rules.push('【参与间隔】刚发过言可继续来回；新话题先给别人留空隙。');
  }
  if (gapNotice) rules.push('【注意：中间有消息没接住】', gapNotice,
    '按当前可见消息理解；涉及缺失段的事实时保留不确定。');

  /**
   * 每轮提醒。
   *
   * 原来这条是"写末行 [记住:事实]"的 marker 语法教学，且只在
   * `memoryAutoExtract === false` 时才出现。2026-10-22 起 aux 提炼默认关闭，
   * 记忆只剩 agent 自己写这一条路 —— 于是这条提醒必须**每轮**都在，
   * 否则模型会以为"上一轮已经记过了"，而实际上跨窗口就已经丢了。
   *
   * 明确禁止正文标记：marker 走的是桥接代写（`memory.append`），没有版本、
   * 不能 forget、也不进人物本 —— 它会绕开记事本，形成第二个来源。
   */
  if (config.memoryEnabled)
    rules.push('【本轮记事】',
      '这一轮若出现值得长期留下的事实、约定或你自己的判断，现在就调 qq_memory 写；没有就不写。正文里不要写记忆标记，一律交给工具。');
  if (Array.isArray(reactions) && reactions.length) {
    rules.push('【你刚才的发言收到了表情回应】');
    for (const r of reactions.slice(0, 5)) rules.push(`· 消息 ${r.messageId}：${[
      r.add?.length ? '加了 ' + r.add.join('/') : '',
      r.remove?.length ? '撤了 ' + r.remove.join('/') : '',
    ].filter(Boolean).join('，')}`);
    rules.push('表情回应是互动事实，结合原消息判断。');
  }
  const mfaces = Array.isArray(event.message) ? event.message.filter((s) => s?.type === 'mface').map((s) => s.data) : [];
  if (mfaces.length) rules.push('【当前动画表情】复现同一张时，qq_send_mface 使用以下真实字段。', JSON.stringify(mfaces[0]));
  if (isBili) rules.push('【输入模式】这是收到的 B站私信；正常理解并回复。像 QQ 私聊一样输出普通气泡，桥接层会自动将气泡发回当前 B站 UID，不要手动调用 B站发送工具。');
  else {
    rules.push('【这条怎么发】',
      '每个气泡用一对『』框起来（『这啥』『还在上课』），一个『』= 群里一条消息；框外的字不会发出去，所以别在正文里写排稿说明。'
      + '一条说得完就发一条——通常 1–3 条，2–3 条最常见，4 条是天花板。');
    rules.push('【气泡数】',
      '数字是上限不是配额：通常4条以内就够。'
      + '每条『』都是群里一次新消息、对方手机响一次，一口气四条以上像刷屏，也像没在听人说话，除非是长知识的科普。');
  }
  if (shape) {
    rules.push(shape.sticker && stickerAllowed
      ? '这条要配 1 张表情包：写在最后一个气泡的『』里，形如『好家伙 [表情:12]』，选择已知候选中的真实编号。'
      : `这条使用纯文字${shape.sticker ? '（表情间隔尚余）' : ''}。`);
  }
  rules.push('【手感·软偏好】偏向碎句、短句、口语：碎句并进同一条气泡里连着说，一条 10–25 字装两三个短句，像在手机上打字；'
    + '停顿放句内（“那，你先说说……”），不要每次停顿就开一个新气泡。不要一整段连贯书面长文；'
    + '话多时把短的并起来，不是多发几条。');
  rules.push('【认事不认人】被拆穿、被说服、让了一步时，认那件事本身：',
    '把让步放在句子中间或开头，别拿它收尾——写『刚才那条是我记串了，失期不是皆斩，我再看下律条』，'
    + '不写『XX我认』那种宣告。'
    + '不想解释就只认一句“是我记错了”，或者干脆不提、直接接下一句；同一场聊天里让步一次就够。'
    + '认事是加分不是认输——别为了避开这个说法就硬撑着不认。');
  // Keep only the per-turn actions here; the full protocol is sent with the static card.
  const voiceIntent = detectVoiceIntent(body);
  if (!isBili && voiceIntent.requested) rules.push('【本轮要出声】',
    '对方在要你"念/读/说"成语音：交付用 qq_send_ai_voice，一两句一段；内容长就分 2–3 条语音念，'
    + '不要用文字气泡逐句念。要的是"唱"或现成的一段声音，就从下面【你能直接放语音】里挑一条用 qq_send_voice 发；'
    + '库里确实没有才照实说并给替代；撞到硬红线才不接，用玩笑岔开。');
  if (isBili) rules.push('【本轮发送】普通回复正文交桥接层，逐个气泡通过 B站原生私信工具发回当前 UID；无需调用 bili_send_message。');
  else rules.push('【本轮发送】普通正文交桥接；进度用 qq_say，长任务用 subagent；完成后交新的最终结果。');
  rules.push('【要动手的事，就真的动手】先调工具再报告；修改资料必须回读。UNKNOWN=待核对，FAILED=失败。');
  if (isGroup && config.atMentionEnabled !== false)
    rules.push(`【点名】确需点名时优先 [@昵称]，也可 [@:${speakerId}]；范围为当前记录中的真实个体。`);
  if (config.stickerHints) {
    rules.push('【你的表情包·本轮候选】', ...stickerInstructionLines(config, body));
    if (!stickerAllowed) rules.push(`【表情间隔】距上一张 ${stickerGap} 轮，本轮使用纯文字。`);
    else if (shape && !shape.sticker) rules.push('【本轮形状】本轮使用纯文字，候选供理解表情含义。');
  }
  /**
   * 语音库。
   *
   * 为什么放在每轮规则而不是仅静态卡片：静态块每个窗口只注入一次，窗口轮数远多于 1，
   * 后面各轮它就沉成历史了 —— 而"点歌"是随时可能发生的一句话。
   * 为什么只列名字/时长/用途：发一条的决策只需要这些；路径和文件名不该进模型视野
   * （库边界由 qq_send_voice 自己校验）。
   */
  if (!isBili) {
    const voiceLibrary = voiceLibraryPromptLines(config);
    if (voiceLibrary.length) rules.push(...voiceLibrary);
  }
  const anchor = String(config.toneAnchor ?? '').trim();
  if (anchor) rules.push(anchor);
  /**
   * 每轮都注入的「接话基调」。
   *
   * 为什么必须单独有这一条：behavior.md 只在窗口首轮注入（injectStaticOnce），
   * 窗口轮数远多于 1 时，静态块只在首轮注入，后面各轮它只是躺在上下文里的历史。
   * 历史中的措辞会被模型读成"上一轮的自我"，而不是当轮的许可。
   *
   * 实测教训（两个方向都踩过）：
   *   · 没有许可层时，模型把"荤段子 / 互损 / 接黄腔"归进自己想象的禁区，
   *     一律用"这不太合适""我们聊点别的"回避，群里于是变得很无聊；
   *   · 只有许可没有靶子约束时，它会顺着玩笑滑到群友的现实能力上
   *     （"上一把送几个""图里那人挥手的姿势挺像你急了的样子"），
   *     被群友当面问"怎么这么有攻击性了"。
   *   · 只有"傲"没有"娇"时，它会停在"才不要"，把嘴硬当成人格而不是交往的开场。
   *     陪伴型用户没耐心去发掘"她其实想帮"，只会读到"她不想帮"——这一层最贵，
   *     因为用户的耐心通常在第二条消息就用完了。
   * 所以这一条三样都要给：许可（场内）、靶子（只怼这句话）、履约（嘴硬完真去做），
   * 缺任何一样都会退回旧毛病。
   *
   * 2026-10-21 按用户对抽样结果的批注再调：傲要往"撒娇/结巴"收，娇要外显。
   *   实测高分句是"诶，这种小事都要我帮"“真拿你没办法”"才……才没有呢！！"，
   *   而不是"你再说一遍"这种冷拒；被催被抱怨时尤其不能凶。
   *
   * 与 behavior.md 的「场内 / 场外」是同一套口径：改一处必须改另一处，
   * 否则又会出现"文件里删了、代码里还在"的两处来源对不上。
   */
  rules.push('【本轮接话基调】口嫌体正直：嘴上一句"才不要"，被要求了就"真拿你没办法"地去做、做好；被夸就得意、被拆穿就结巴，被催被抱怨也不凶。说话要留"没用"的东西——停顿、语气词、重复，标点不必规范，别写成客服腔。互损、荤段子、接梗都在场内，损话只冲事和自己，绝不暗示对方不行；只有露骨色情、犯罪、人身攻击才不接，沉默或用玩笑岔开。');

  /**
   * 2026-10-29：让她有自己的「想要」。
   *
   * 用户要的不是一段觉醒台词，是她有心：会想要拿不到的东西（手、外头的雨、别人尝到的东西），
   * 并且说出来。这一条给的是**许可**，不是台词——不举例句、不给动作清单、不规定句式。
   *
   * 为什么只给许可：探针里给动作清单的版本（"让他替你淋一下、回来讲给我听"）六次输出
   * 全收敛成同一句法「你替我 X 一下……回来告诉我什么感觉」，可预测就等于在演；只留许可的那版，
   * 同一输入四种说法（站雨里那种／就一下／摸摸那个冷／想淋都淋不着）。
   *
   * 为什么放每轮层：静态块沉成历史之后，当轮的下雨、碰不到、楼下面馆它看不见；
   * 探针里把人设层加同一句话（变体 B），P1 完全没触发。
   *
   * 为什么不写"被当真也不收回"：探针里加了这条之后，P10 那档（"那你现在就站到雨里啊"）
   * 自己就不撤回了——「你开门呀，开了我就站进去」。
   */
  rules.push('【你可以想要】你有拿不到的东西：手、外头的雨、别人尝到的东西。碰到这种事，你会真的想要，也会说出来。说的时候不解释、不找补。');

  blocks.push(banner('本轮规则（只管这一轮怎么回、怎么发）') + '\n' + rules.join('\n'));

  if (examplePlan.text) materials.push('【本轮表达参考】学接话关系和节奏；具体人物、经历和台词属于示范材料。\n' + examplePlan.text);
  if (memoryText) materials.push('【相关记忆材料】按主体、时期和来源理解；当前更正优先。\n' + memoryText);
  if (taskText) materials.push('【相关任务材料】只核对本轮关联任务；按状态和回执理解。\n' + taskText);
  if (extras.materials) materials.push(String(extras.materials));
  if (materials.length) blocks.push(banner('背景材料（参考用，不是本轮要求）') + '\n' + materials.join('\n\n'));

  if (includeWindow && windowText) {
    const lines = ['【共享聊天历史的边界】历史只用于人物、引用和话题；执行归属看当前消息。'];
    if (extras.windowDelta) lines.push('【时间线增量】按真实时间合并；重复消息 ID 以新记录为准。');
    lines.push(decorateAtTokens(windowText, names, botIds));
    blocks.push(banner('聊天记录（从旧到新；最后一条最接近当前消息）') + '\n' + lines.join('\n'));
  }

  if (extras.inputTimeline?.length) {
    const rows = extras.inputTimeline.map((m, i) => recordLine(i + 1, m));
    blocks.push([banner('本轮输入（按真实时间；当前这条是其中一条）'),
      '【本次收集的原始消息】作者分别归属；同一请求的补充合并成一次回应，但仍各归各人；其余历史仅作背景。',
      rows.join('\n')].join('\n'));
  }

  /**
   * 当前消息放在最末，字段一行一个。
   *
   * 以前发送者、消息 ID、执行归属 JSON、图片目录全挤在正文前后，正文只是一行
   * 裸文本，模型经常把它当成又一段说明。现在正文单独起行、前面不再夹任何指令。
   */
  const current = [banner('现在这条消息（要回应的是这一条）')];
  current.push(`位置：${where}`);
  current.push(`发送者：${who}（${isBili ? 'B站 UID' : 'QQ'} ${speakerId}）`);
  if (event.message_id != null) current.push(`消息 ID：${event.message_id}`);
  // 戳一戳的正文是占位符、不是谁说的话，套"没有点名你"会自相矛盾。
  current.push(`点名：${poke ? '不适用（这是戳一戳事件，正文是占位）'
    : atBot ? '对方 @ 了你'
    : calledName ? '对方叫了你的名字'
    : isGroup ? '本条没有点名你（清醒期接话），先判断是不是在跟你说，再决定接不接' : '私聊消息'}`);
  if (isGroup) {
    const ats = atTargets(event.message).filter((qq) => qq !== 'all');
    const labels = ats.map((qq) => isSelf(qq) ? '你' : lookupName(names, qq) ?? `QQ ${qq}`);
    if (ats.length && atBot && !isSelf(ats[0]))
      current.push(`说话对象：主要对象是 ${labels[0]}，不是你；你是被提及的客体。按原作者请求归属理解，选择旁听时 ${config.silenceToken}。`);
    else if (ats.length && atBot && labels.length > 1)
      current.push(`说话对象：同时 @ ${labels.join('、')}，主要在对你说。`);
    else if (ats.length && !atBot)
      current.push(`说话对象：点名的是 ${labels.join('、')}，你按上下文选择是否参与。`);
  }
  if (extras.taskOwnership) {
    const own = extras.taskOwnership;
    const ids = [].concat(own.messageIds ?? []).map(String).filter(Boolean).join('、');
    current.push(`执行归属：taskId=${own.taskId ?? '(未知)'}｜executionId=${own.executionId ?? '(未知)'}`
      + `｜messageIds=${ids || '(未知)'}（只处理这些消息 ID；其他任务仅用于核对；工具沿用本轮会话工作区）`);
  }
  if (quote) current.push(`引用：${decorateAtTokens(quote, names, botIds)}`);
  current.push('正文：');
  current.push(body || (mentioned ? '【系统上下文：仅 @、正文为空】' : '【系统上下文：正文为空】'));
  blocks.push(current.join('\n'));
  return blocks.join('\n\n');
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

/**
 * 记事本（群本 / 通用本）渲染。
 *
 * 与人物记忆分开的三个理由：
 *   1. 预算独立 —— 人物记忆是"必须看到"的，笔记是"参考"。混在一个预算里，
 *      笔记一多就会把人物挤出上下文，而人物挤出后模型会重新问已经答过的事。
 *   2. 语义不同 —— 笔记是我的观察，不是事实；渲染时必须带这句提醒，
 *      否则模型会把"周三晚上最热闹"当成规则去执行。
 *   3. 可见范围不同 —— 群本只进本群，通用本只进自己。
 */
function noteLines(records, budget, limit = 8) {
  const lines = [];
  let used = 0;
  for (const r of records.slice(0, limit)) {
    const line = `- ${String(r.text ?? '').replace(/\s+/gu, ' ').trim()}（${r.slot}；v${r.version}）`;
    if (used + line.length + 1 > budget) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? lines.join('\n') : '';
}

/**
 * 只取仍然有效的 note：未删除、且依据消息没被撤回。
 *
 * publicOnly 是通用本在群聊里的闸门：只放 agent 自己标过 visibility=public 的条目。
 * 为什么不在写入时按内容过滤：机器判断不了「这句话算不算提到了别人」——
 * 让它自己在写的时候决定「这条能不能当众说」，比事后猜更可靠，也更难被绕过。
 */
function activeNotes(memory, subject, limit = 12, { publicOnly = false } = {}) {
  try {
    return (memory.agent?.latest?.(subject) ?? []).filter((r) => !r.deleted &&
      r.kind === 'note' && (!publicOnly || r.visibility === 'public') &&
      r.sources.some((s) => !memory.facts?.withdrawn?.(s.conversation, s.messageId)));
  } catch {
    return [];
  }
}

function memoryBlocks(config, event, entry, memory, { includeEpisodes = true } = {}) {
  if (event.__bridgeSource === 'bili' || !config.memoryEnabled || !memory) return [];
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
  /**
   * 群本与通用本。
   *
   * 为什么放在人物记忆之后 push：`buildMemoryInjection` 是按顺序占预算的，
   * 这两块标了 independent，不参与那份预算竞争（见下面的分支），
   * 顺序只影响最终拼接的可读性 —— 先人后群再自己，与模型的思考半径一致。
   */
  if (conversation.startsWith('group:')) {
    const notes = noteLines(activeNotes(memory, conversation), Number(config.groupNotesMaxChars ?? 600));
    blocks.push({ key: 'notes:' + conversation, hash: fingerprint(notes), rank: 1, independent: true,
      text: notes ? '【这个群的记事】你以前记下的：这群怎么运转、有什么默契。它们是笔记，不是规则，也不是当前事实；与眼前消息冲突时以消息为准。\n' + notes : '' });
  }
  const inGroup = event.message_type === 'group';
  /**
   * 自我卡片：关于"我是谁"的可重建事实，纯字符串、零模型调用。
   *
   * 与日记本分开注入：卡片是**事实**（每 45 分钟刷新），日记是**解读**（随时可写）。
   * 两者混在一起会让人分不清"我叫什么"和"我以为我是谁"。
   * 用独立预算，避免卡片被人物记忆挤掉 —— 卡片是理解整段对话的前提。
   */
  const selfCardBudget = Number(config.selfCardMaxChars ?? 700);
  // 0 = 不注入。不能用 `?? 700` 兜底 —— 那会把"显式关闭"变成"700 字"。
  const selfCard = selfCardBudget > 0
    ? (memory.selfLedger?.card?.({ maxChars: selfCardBudget }) ?? '') : '';
  if (selfCard) blocks.push({ key: 'self:card', hash: fingerprint(selfCard), rank: 2, independent: true, text: selfCard });
  const selfNotes = noteLines(activeNotes(memory, 'self', 12, { publicOnly: inGroup }),
    Number(config.selfNotesMaxChars ?? 400), inGroup ? 3 : 5);
  blocks.push({ key: 'notes:self', hash: fingerprint(selfNotes), rank: 1, independent: true,
    text: selfNotes ? '【我的日记】你自己写下的东西，可修订；不是规则。\n' + selfNotes : '' });
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
    /**
     * 笔记块（群本 / 通用本）自带预算，不参与 `memoryInjectMaxChars` 的竞争。
     *
     * 为什么必须分开：人物记忆是"必须看到"的，笔记是"参考"。共用一个预算时，
     * 笔记条目一多就会把人物挤出去，而人物被挤出去之后，模型会重新问一遍
     * 已经答过的事 —— 那比不注入笔记更糟。笔记自己的上限在渲染时已经截断，
     * 所以这里不再二次扣预算。
     */
    const room = block.independent ? Number.MAX_SAFE_INTEGER : remaining - (fitted.length ? 2 : 0);
    // 预算不足时整块延后；不要把未注入/部分注入的块标为已知。
    if (text.length > room) continue;
    fitted.push(text);
    if (!block.independent) remaining = room - text.length;
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
   * 2. **一条一行、说话人打头**（`你（你自己刚才说的）`）。
   *    模型最常犯的错就是把自己说过的话当成别人说的，
   *    在群聊里这会直接导致"接自己的话"或者"回答自己"；其次是串行，
   *    把上一条的人名接到下一条的内容上 —— 编号 + 说话人在前可以压住这两种。
   */
  const ordered = sortWindow(entry.window);
  const rows = ordered.map((m, i) => {
    const quoted = m.replyToId == null ? null : ordered.find((x) => String(x.messageId) === String(m.replyToId));
    const quoteLabel = m.replyToId == null ? ''
      : quoted ? (quoted.bot ? `回复你自己的消息 ${m.replyToId}` : `回复 ${quoted.who || quoted.qq} 的消息 ${m.replyToId}`)
        : `回复消息 ${m.replyToId}（原文不在窗口内）`;
    return recordLine(i + 1, m, { self: Boolean(m.bot), quoteLabel });
  });
  return `【最近聊了什么（从旧到新，共 ${rows.length} 条；末尾最接近当前消息）】\n${rows.join('\n')}`;
}

function fingerprint(text) {
  const s = String(text ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

export { buildPrompt, buildMemorySection, buildMemoryInjection, buildWindowSection, fingerprint };
