import z from '@deepseek-ai/schemastery';
import { DEFAULT_QQ_DATA_ROOT } from './application/login-watch.mjs';

const Config = z.object({
  // ingress
  path: z.string().default('/qq/onebot'),
  token: z.string().default(''),
  maxBodyBytes: z.number().default(1048576),
  // egress
  onebotHttp: z.string().default('http://127.0.0.1:3000'),
  onebotToken: z.string().default(''),
  /** Use QQ's native voice-to-text for incoming record segments. */
  voiceTranscriptionEnabled: z.boolean().default(true),
  /** 合并转发正文读取策略：lazy 仅在用户要求阅读时展开，always 每次展开，never 只保留占位。 */
  forwardMode: z.string().default('lazy'),
  /** 合并转发读取的总字符数和节点数上限，避免一条转发挤满上下文。 */
  forwardMaxChars: z.number().default(6000),
  forwardMaxMessages: z.number().default(20),
  /** 单次 get_forward_msg 请求超时。 */
  forwardTimeoutMs: z.number().default(10000),
  /** 额外的懒加载触发词；内置“看看/总结/展开转发”等句式始终可用。 */
  forwardTriggers: z.array(z.string()).default([]),
  /** 引用的消息里带合并转发时，按引用图片同样默认展开正文。 */
  attachQuotedForwards: z.boolean().default(true),
  /** 用户明确要求查看上文时，最多从窗口补读几条旧合并转发。 */
  contextForwardsOnRequest: z.number().default(1),
  // session
  cwd: z.string().default(''),
  workspaceRoot: z.string().default(''),
  agentPreset: z.string().default(''),
  // access control
  groups: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  groupEnabled: z.boolean().default(true),
  privateEnabled: z.boolean().default(true),
  groupTrigger: z.string().default('at'),
  groupPrefix: z.string().default(''),
  /**
   * 名字触发词。群里直接叫这些词也算点名，不必 @。
   * 大小写不敏感：DeepSeek / DEEPSEEK / dEePSeeK 都命中。
   */
  nameTriggers: z.array(z.string()).default(['deepseek', '大肥鱼']),
  selfIds: z.array(z.string()).default([]),
  /**
   * 把 @ 渲染成群昵称而不是裸 QQ 号。
   *
   * OneBot 的 at 段可能不带昵称，所以需要
   * 一次 get_group_member_list，按群缓存 groupMemberCacheMs。
   * 关掉它并不会让 @ 消失，只是退化成 `@123456`。
   */
  resolveAtNames: z.boolean().default(true),
  /** 群成员昵称缓存时长（毫秒）。默认 10 分钟。 */
  groupMemberCacheMs: z.number().default(600000),
  // replies
  replyTimeoutMs: z.number().default(180000),
  maxReplyChars: z.number().default(1500),
  replyToGroups: z.boolean().default(true),
  // images sent to the bot
  maxImageBytes: z.number().default(4194304),
  imagesEnabled: z.boolean().default(true),
  /**
   * 读图策略。
   *
   *   lazy   （默认）已准入回合的普通图片直接附上；带正文的图片也附上。
   *          群聊纯表情包需读图请求，历史图片按本轮请求补充。
   *   always 老行为：收到图就附上，模型每张都看。
   *   never  永不附图，只看占位符。
   */
  imageMode: z.string().default('lazy'),
  /** 附加读图触发词，与内置读图/指代句式共同用于表情和历史图 */
  imageTriggers: z
    .array(z.string())
    .default([
      '看图',
      '看看这',
      '看下这',
      '看看图',
      '这图',
      '图里',
      '图片里',
      '截图',
      '识别',
      '上面写',
      '写的什么',
      '什么字',
      '帮我看',
    ]),
  /**
   * 图片幻觉过滤器。
   *
   * 桥接不把图片内容给模型（省 token），但模型会**脑补**：
   * 实测它在完全看不到图的情况下回了「这表情看着就像在憋笑」，
   * 用户当然以为它读了图。提示词里已经禁止，但它不总听劝。
   *
   * 只在这条消息**带图且没附图**时生效，避免误伤正常聊天。
   */
  imageHallucinationFilter: z.boolean().default(true),
  /** 命中这些就说明它在假装看见了（按句摘掉） */
  imageHallucinationPattern: z
    .string()
    .default('这(?:张|个)?(?:表情|图)|看着像|图里|看图|照片里|截图里'),
  /**
   * 私聊里发的图**总是**读取（群聊纯表情包仍按请求读取）。
   *
   * 理由：群里发个表情包多半只是表达情绪，读它纯属浪费 token；
   * 但私聊里直接把图发给你，多半就是想让你看。实测不开这个的话，
   * 私聊发个表情包它会一直回"我看不见"，很出戏。
   */
  readImagesInPrivate: z.boolean().default(true),
  /**
   * 引用的消息里带图时，把那也附上。
   * 引用一张图基本就是想聊它，所以默认开。
   */
  attachQuotedImages: z.boolean().default(true),
  /**
   * 附过图的那一轮结束后，让下一轮直接开新会话。
   *
   * 为什么需要：图片一旦进了会话历史，就会**跟着历史被反复重发**，
   * 直到会话轮换为止。DSH 的 image-offload 是被动的（只在 provider 报错
   * 要求卸载时才丢最旧的图），不会主动为了省 token 清理。
   * 一张图折合上千 token，被重发 9 轮就是上万。
   *
   * 代价：下一轮会重新注入一次静态块（人设+目录，约 5500 token）。
   * 但只要那张图本身超过约 600 token，就是净赚 —— 而图基本都超过。
   *
   * 对话连续性不受影响：滑动窗口是桥接自己维护的，换会话不丢。
   */
  // 图片本身不应改变“每多少轮换 Session”的语义；需要省图片历史时再显式打开。
  rotateAfterImage: z.boolean().default(false),
  /** 托管总开关。默认关，须显式开启（hosting.bat on）。运行时可用 POST <path>/control 切换。 */
  agentEnabled: z.boolean().default(false),
  /**
   * QQ 账号数据根目录，用于兜底查找收到的表情缓存。
   * 形如 E:\QQFile\message\Tencent Files\3667925015
   * 留空则跳过这条兜底路径。
   */
  qqDataPath: z.string().default(''),
  /**
   * 人设。会作为指令块拼在每次提示词最前面。
   * 只作用于 QQ 会话，不影响你在 DSH 里的其它会话。
   */
  persona: z.string().default(''),
  /**
   * 人设文件路径。设了就以文件为准（便于单独查看和修改），
   * 文件里的 HTML 注释 <!-- --> 会被自动剥掉。留空则用上面的 persona。
   */
  personaFile: z.string().default(''),
  /**
   * 群聊行为规则文件。与 personaFile 分立 —— 换角色卡时不用重写行为规则。
   * HTML 注释同样会被剥掉。
   */
  behaviorFile: z.string().default(''),
  /**
   * 正反示例文件。
   *
   * 这一层是塑造风格最有效的手段：规则说"不要什么"，示例说"应该长什么样"。
   */
  examplesFile: z.string().default(''),
  /** 是否在提示词里提示「用表情包回应」。 */
  stickerHints: z.boolean().default(true),
  /**
   * 两次表情包之间至少隔几轮。
   *
   * 默认 0 = 不额外限制，完全由 replyShapes 的抽签决定频率。
   * 因为抽签本身就是概率性的（当前约 1/3 想要表情），再加一道间隔闸门
   * 会变成两个概率相乘，实际配图率掉到 10% 左右，显得很克制、不自然。
   *
   * 想让表情更稀少就调大（比如 3 = 配过之后两条内不再配）。
   */
  stickerMinGapTurns: z.number().default(0),
  /**
   * 表情文字目录（qq-mcp 生成的 catalog.json）。
   *
   * 为什么要把它喂进提示词：模型不知道每个编号画的是什么，于是永远挑最保险的
   * #1（实测 11 次里 7 次是 #1，另有 2 次照抄了提示词里的示例编号）。
   * 给了目录它才能按情绪挑。
   *
   * 每轮动态注入随机候选，靠近当前消息。
   * 留空 = 提示通过工具查询真实编号。
   */
  stickerCatalogPath: z.string().default(''),
  /** 每轮随机候选数量；0 = 全部。 */
  stickerCatalogLimit: z.number().default(8),

  // ---- 心跳：攒一批消息，定期判断要不要主动插话 -------------------------
  /**
   * 总开关。
   *
   * 关闭时：群里没被 @ / 没叫名字的消息**直接丢弃**（旧行为）。
   * 打开时：那些消息被塞进该群的缓冲，由心跳定期判断要不要插一句。
   *
   * 为什么需要它：`groupTrigger: at` 虽然防刷屏，但也让它完全没法"像群友
   * 一样搭话"——别人聊得热火朝天，它一句都插不上。
   */
  heartbeatEnabled: z.boolean().default(false),
  /** 每群累计多少条未读背景消息就触发一次插话判断。默认 6（超过 5 条）。 */
  heartbeatUnreadThreshold: z.number().default(6),
  /** 心跳间隔。正式用 300000（5 分钟）；测试可以调成 5000。 */
  heartbeatMs: z.number().default(300000),
  /** 每次判断看多少条缓冲消息 */
  heartbeatBufferSize: z.number().default(20),
  /**
   * 群里安静多久之后才允许插话。
   * 大家正聊得停不下来时插进去很讨嫌，所以要求"消息停下来一会儿"。
   */
  heartbeatIdleMs: z.number().default(60000),
  /** 未读不足门槛时，从上次发言/已完成判断计时；到期也判断。0 关闭时间触发。 */
  heartbeatCooldownMs: z.number().default(180000),
  /** 判断用的模型。留空则用 llmProvider/llmModel，再留空用全局默认。 */
  heartbeatProvider: z.string().default(''),
  heartbeatModel: z.string().default(''),

  // ---- 登录监视：把"被踢下线"变成可查的读数 ------------------------------
  /**
   * 定期探测 OneBot 的在线状态，记录每次掉线的起止时间和原因。
   *
   * 为什么默认**开**：它只读 `get_status`，不改账号、不发消息、不碰登录凭据；
   * 而 QQ 服务端使登录失效（KickedOffLine）之后，桥接这边原本完全看不出来 ——
   * 不必事后翻接入端日志数时间戳。开着它才能回答"多久掉一次、掉了多久"。
   *
   * 它**不会**自动重登：凭据由 QQ 管理，擅自重试登录只会加重风控。
   */
  loginWatchEnabled: z.boolean().default(true),
  /** 探测间隔。默认 60000（1 分钟）；越密越准，代价是一次本地 HTTP 调用。 */
  loginWatchMs: z.number().default(60000),
  /**
   * 连续探测失败几次才记为掉线。
   * 默认 3 —— 一次超时/抖动不该被记成一次掉线，否则统计里全是噪声。
   * 注意：OneBot **明确回报 offline** 时立即记为掉线，不等这个阈值。
   */
  loginWatchFailureThreshold: z.number().default(3),
  /** 单次探测超时。本机接口，4 秒还没回就是真有问题的概率更大。 */
  loginWatchTimeoutMs: z.number().default(4000),
  /** 自检接口里最多回显最近几次掉线；0 = 全部。 */
  loginWatchHistoryLimit: z.number().default(10),
  /**
   * QQNT 安装目录。登录监视从这里读"当前生效的 build"，用来核对
   * "是不是每次热更新换版本就掉线"。
   */
  qqntDir: z.string().default('C:\\Program Files\\Tencent\\QQNT'),
  /** QQ 账号数据根目录（下面按 QQ 号分目录）。用来定位登录票据文件。 */
  qqntDataDir: z.string().default(DEFAULT_QQ_DATA_ROOT),
  /** 直接指定账号数据目录（留空则按 `<qqntDataDir>\<QQ号>` 拼）。 */
  loginAccountDir: z.string().default(''),
  /** 环境快照缓存多久。稳态下没必要每分钟读一次磁盘。 */
  loginEnvCacheMs: z.number().default(300000),
  /**
   * 掉线/恢复时**往盘上写一行告警**（JSONL）。
   *
   * 为什么必须落文件：账号掉线时走 QQ 通知没有意义（收消息的入口就是它自己），
   * 而 DSH 控制台日志会随进程重启散掉。落一行，事后 `Get-Content` 就能看到。
   */
  loginAlertEnabled: z.boolean().default(true),
  /** 告警文件。相对路径按 stateDir/cwd 解析；这里给文件名，由 bootstrap 解析成绝对路径。 */
  loginAlertFile: z.string().default('login-alerts.log'),
  /**
   * 一条回复最多拆成几个气泡。
   * 真人聊天是分几条短消息发的，不是一段长文。
   */
  maxBubbles: z.number().default(3),
  /**
   * 气泡之间的间隔 = 上一个气泡的字数 × 这个毫秒数，模拟"正在打字"。
   * 默认 100 = 0.1 秒/字。0 = 不等，一次全发出去。
   * 下限和上限防止过短没节奏、过长像卡住。
   */
  /** 气泡之间的间隔 = 上一个气泡的字数 × 这个毫秒数，模拟"正在打字"。 */
  bubbleDelayPerCharMs: z.number().default(100),
  bubbleDelayMinMs: z.number().default(400),
  bubbleDelayMaxMs: z.number().default(6000),
  /**
   * 回复形态模板。每次回复从里面**随机抽一个**，决定"回几个气泡、配不配图"。
   *
   * 格式：`N` = N 个气泡；`N+s` = N 个气泡 + 1 张表情包。
   *
   * 为什么要由桥接抽而不是让模型自己定：实测模型这两个决定都做不好——
   * 要么每条都配图，要么每条都堆成一大段。抽签能强制出多样性。
   *
   * 想让某种形态更常出现，就把它多写几遍（重复即权重）。
   * 留空数组 = 关闭，回到"模型自己决定"。
   */
  replyShapes: z.array(z.string()).default([
    // 12 条里 8 条带表情 = 抽中率 67%。
    //
    // 注意抽中率和照做率是**相乘**的，而照做率会随提示词强度变化：
    //   指令写成"配 1 张表情包（写法见上面）"时  → 照做率约 85%
    //   写成"这条要配 1 张表情包：在回复最后单独一行写 [表情:编号]…" → 约 100%
    // 所以把指令写明确之后，抽中率可以直接按目标值设，不必再上浮。
    '1',
    '1',
    '1+s',
    '1+s',
    '1+s',
    '1+s',
    '2',
    '2+s',
    '2+s',
    '3',
    '3+s',
    '3+s',
  ]),
  /**
   * 让她能像人一样 @ 别人。
   *
   * 打开时她可以在回复正文里写 `[@:QQ号]`（或窗口里出现过的 `[@昵称]`），
   * 桥接把那一段变成真正的 at 段发出去 —— **只有她自己写了才发**，
   * 不是每条回复都带 @。写错号/重名/超上限的标记会被摘掉，不会漏成正文。
   *
   * 关掉 = 标记照旧被摘干净，只是不会变成 at（私聊永远不 @）。
   */
  atMentionEnabled: z.boolean().default(true),
  /**
   * 一个气泡里最多 @ 几个人。
   *
   * 防的是"一句话 @ 一屏人"——那在群里等于刷屏，也和真人习惯不符。
   */
  atMentionMax: z.number().default(3),
  /**
   * 一条回复**明确发送失败**（不是"结果未知"、也不是配额被拒）最多试几次。
   *
   * 为什么必须有上限：一条被 OneBot 永久拒绝的回复（敏感词、坏 at 段…）
   * 会每 30 秒重试一次，而"较晚回复不得越过未完成计划"会让整个会话一直哑着。
   * 到上限就转 `failed` 终态、放开队列，并在 `status.replyDelivery.failed`
   * 里留一条可查的记录。
   *
   * 结果未知（UNKNOWN）永远走人工核对，不受这个上限影响。
   * 设 0 = 旧行为（无限重试）。
   */
  replyMaxSendAttempts: z.number().default(3),
  /**
   * 让 Agent 主动闭嘴的暗号。
   *
   * 群聊里即使没被 @ 也会把消息交给 Agent（groupTrigger: all），
   * 它判断"这条不需要我插话"时只输出这个令牌，桥接就不发任何东西出去。
   * 留空则关闭这个机制。
   */
  silenceToken: z.string().default('[SKIP]'),
  /**
   * 被激活后保持"清醒"多久（毫秒）。
   *
   * 清醒期内，同一个会话里没被 @ 的消息也算接着聊，不必每次重新 @。
   * 文字或表情成功发出后重新计时；纯 [SKIP] 不延长，也不清掉已有窗口。
   * 0 = 关闭这个机制（退回"每次都要 @ 才理"）。
   */
  awakeMs: z.number().default(60000),
  /** 明确 @/引用他人先旁听，其余由完整 Agent 一次决定回复或 SKIP。 */
  groupAttentionEnabled: z.boolean().default(true),
  /** 非直接对话的主动插话间隔；直接回应不受此冷却影响。 */
  attentionInterjectCooldownMs: z.number().default(30000),
  /** 连发收集；0 显式关闭。最长收集到期只判断，不强制发言。 */
  inputDebounceMs: z.number().default(1500),
  /** 短消息更像未说完的气泡，留足接下一句的时间。 */
  inputShortDebounceMs: z.number().default(3500),
  inputMaxWaitMs: z.number().default(8000),
  inputBatchMaxMessages: z.number().default(24),
  floorManagementEnabled: z.boolean().default(true),
  /** WAIT 保留请求等待补充的期限，不自动催问。 */
  floorWaitMs: z.number().default(30000),
  /** 第一阶段：执行事实清单与只读进度旁路；耗时工具仍按会话串行。 */
  taskLedgerEnabled: z.boolean().default(true),
  // 语义路由完成自然流量验证前只做影子记录；旧执行路径保留完整上下文。
  taskRoutingMode: z.string().default('shadow'),
  dialogueSessionMode: z.string().default('conversation'),
  /**
   * 参与决策：在起一个完整 Agent 回合**之前**，先问一次很短的"此刻该不该在群里回一句"。
   *
   * 默认关（保持既有行为与既有测试不变）；desktop profile 打开。
   * 打开后 `@` 消息不再"必回"，而是带着"她被点名"的偏置过一次决策。
   * 判的是**这一批已聚合的意群**加最近时间线，所以"几个人接着聊同一件事"只回一次。
   * 失败与"拿不准"一律 fail-open（当作该回），且明显请求型措辞直接回。
   */
  replyDecisionEnabled: z.boolean().default(false),
  /** 参与决策的单次超时。短分类，别让它自己变成新的延迟来源。 */
  replyDecisionTimeoutMs: z.number().default(5000),
  /** 长于这个字数且带提问标记的消息直接回，不必先问决策模型（省掉那 2.5 秒）。 */
  replyDecisionLongAskChars: z.number().default(12),
  taskRouteTimeoutMs: z.number().default(4000),
  /**
   * 终态任务在多长时间内仍算"可被 steer"（保住"继续刚做完的那个"这类要求）。
   *
   * 为什么会话里几乎没有可 steer 的任务：实测 375 条非归档任务中只有 1 条（0.3%）
   * 真正有活干或刚结束，而路由原先把最近 12 条非归档任务全塞进 prompt 并调一次模型
   * —— 99.7% 的调用纯属浪费（唯一可能的答案 `new` 本地免费就能给出）。
   */
  routeSteerableWindowMs: z.number().default(600000),
  taskConcurrency: z.number().default(3),
  taskConversationConcurrency: z.number().default(2),
  taskOwnerConcurrency: z.number().default(2),
  taskDispatchScanLimit: z.number().default(128),
  taskContextMaxChars: z.number().default(120000),
  taskWaitExpiryMs: z.number().default(86400000),
  taskIdleArchiveMs: z.number().default(604800000),
  taskProgressEnabled: z.boolean().default(true),
  /**
   * 跨会话发言开关。
   *
   * 默认关：工具目标必须等于本轮会话，`qq_say` 也不许说到别处。
   *
   * 打开后这个 Agent 被当作"一个跨群活动的 QQ 个体"，而不是每个群
   * 各一份的独立客服 —— 发送类工具可以指定白名单内的其它会话；
   * 本轮会话归属（由宿主按 Session 发布）只用于校验"这一轮还在有效期内"，不再限制目标。
   * 白名单（QQ_ALLOW_GROUPS / QQ_ALLOW_USERS）与能力位（QQ_CAPABILITIES）
   * 仍是硬边界：跨会话只能跨到本来就允许发的地方。
   */
  allowCrossConversation: z.boolean().default(false),
  taskProgressTimeoutMs: z.number().default(6000),
  taskProgressConcurrency: z.number().default(2),
  taskProgressMaxPending: z.number().default(32),
  /**
   * 超过这个时长、且**还没有确认 outcome** 的待投递回复，一律不再恢复投递，直接收敛为终态。
   *
   * 为什么必须单独有这道闸：修复恢复通道的饥饿问题后，积压的 `following` 行会
   * 全部被尝试。而 DSH 会话是持久化在磁盘上的，`runTurn(resume)` 对几天前的
   * turn **可能真的成功** —— 于是 4 天前的回复被当成"现在该说的话"发进真实群。
   * 实测：修饥饿当天一次性迟发了 14 条（约 24 个气泡，最旧 99 小时）。
   * 迟到的回复比不回复更糟：它答的是一个早已结束的话题。
   *
   * 只作用于 `following`／`output`（尚无确认结果）这类；`planned` 不受影响 ——
   * 它已经拿到确认结果，可能正在等发送配额窗口（合法等待可达 1 小时）。
   */
  replyStaleDeliveryMaxAgeMs: z.number().default(600000),
  /** 原 rpcId 的只读结果恢复并发，不提交模型或执行工具。 */
  replyRecoveryConcurrency: z.number().default(2),
  /**
   * 恢复尝试的单轮超时。默认 20000 —— 一个早已不存在的 DSH 会话重连注定失败，
   * 用 replyTimeoutMs(180s) 等满 3 分钟只是白占恢复通道。
   */
  replyRecoveryTimeoutMs: z.number().default(20000),
  /**
   * 超过这个时长仍无 outcome 的"进行中"执行，视为不可能恢复：收敛成 failed 终态。
   *
   * 为什么需要：这类执行会被 restore() 判成 recovering，从而
   * ① 让 task 永久 busy（撑大路由 prompt、卡住 pump）② 让 reply 行无限重试。
   * 用执行自己的 `times.received` 判定，不用 updated_at（后者会被反复刷新，不诚实）。
   */
  replyRecoveryMaxAgeMs: z.number().default(900000),
  /** taskScheduler.tick() 里 sweep() 的节流间隔（归档空闲任务、清理过期路由记录）。 */
  taskSweepIntervalMs: z.number().default(60000),
  /** tick() 里 refreshReceipts() 的节流间隔（回填 firstSent 供延迟统计）。 */
  taskReceiptsIntervalMs: z.number().default(15000),
  /** 普通 Session 累计提交提示词字符预算；不等于模型上下文 Token 上限。 */
  conversationContextMaxChars: z.number().default(60000),
  /** 长期约定独立限额；0 显式摘除该块并停止提炼会话事实，不删除已保存记忆。 */
  conversationMemoryMaxChars: z.number().default(450),

  // ---- 记忆与上下文（把线性增长的历史换成恒定成本的窗口 + 长期记忆）----
  /** 总开关 */
  memoryEnabled: z.boolean().default(true),
  /** 与聊天回复独立的记忆提炼；只读取已准入消息，保存可核对来源。 */
  memoryAutoExtract: z.boolean().default(true),
  /** 共享事件账本复用 SQLite 与已有提炼批次，不增加独立模型请求。 */
  episodicMemoryEnabled: z.boolean().default(true),
  episodeInjectLimit: z.number().default(4),
  episodeInjectMaxChars: z.number().default(900),
  memoryExtractBatchSize: z.number().default(6),
  memoryExtractIntervalMs: z.number().default(30000),
  memoryExtractTimeoutMs: z.number().default(15000),
  memoryProvider: z.string().default(''),
  memoryModel: z.string().default(''),
  /**
   * 按 QQ 号存放记忆文档的目录。
   * 留空 = 数据目录下的 memory/（stateDir，未配则 cwd/data）。
   */
  memoryDir: z.string().default(''),
  /** 单个文档最多保留多少条记忆，超了自动摘要进「早期」 */
  memoryMaxEntries: z.number().default(20),
  /** 群聊时额外注入最近几个参与者（不含当前说话人）的记忆 */
  memoryInjectRecent: z.number().default(2),
  /** 每轮记忆区块的总字符预算；0 = 不设总预算（仍受单文档裁剪） */
  memoryInjectMaxChars: z.number().default(1800),
  /** 保留最近多少次 Agent 提交对应的消息；仍受双方消息条数上限约束。 */
  windowTurns: z.number().default(10),
  /** 主会话每20次成功提交后换新 Session；0 改用上下文字符预算。 */
  rotateEveryTurns: z.number().default(20),
  /** 写回记忆的标记前缀 */
  rememberMarker: z.string().default('[记住:'),
  /**
   * 人设 / 表情包说明 / 记忆说明这些**静态内容**，只在会话窗口开启时注入一次。
   *
   * 为什么省得多：这些内容会作为历史**累积**在上下文里。实测一个 9 轮的窗口，
   * 每轮都注入一份完整人设，9 份合计 4 万多 token，而人设本身只占其中一份。
   * 只在第一轮注入的话，后面 8 轮白赚。
   *
   * 代价：人设离当前这轮更远，语气约束会弱一些。
   * 如果确实觉得它"忘了自己是谁"，有两个办法：
   *   ① 把 injectStaticOnce 设成 false，回到每轮都注入完整人设（贵）；
   *   ② 用 toneAnchor 补一句短的、只讲味道的话（便宜，默认空）。
   *
   * 留 false = 回到"每轮都注入"。
   */
  injectStaticOnce: z.boolean().default(true),
  /**
   * 每轮末尾的"语气锚"。
   *
   * 为什么要有这个空位：静态块（人设）默认只在窗口第一轮注入，之后离生成点
   * 越来越远，语气约束会变弱。原来这里**硬编码**了一句大肥鱼的味道锚，
   * 结果是：用户把人设文件里的对应句子删了，它却还在——因为这句根本不在
   * 人设文件里，而在代码里。两处来源必然对不上。
   *
   * 现在默认**空**：语气完全由 persona.md 单点决定，不再有第二份真相。
   *
   * 想加强语气时填一句短的。注意它**每轮都会注入**，所以要短——
   * 原来那句约 40 token/轮，10 轮窗口就是 400 token。
   */
  toneAnchor: z.string().default(''),

  // ---- 上下文注入（滑动窗口）---------------------------------------------
  /**
   * 注入几条**别人的**消息。
   *
   * 和"自己的回复"分开设上限，因为合成一个总数时她会用自己的话把窗口挤满，
   * 别人的消息一条都留不下。
   */
  contextOthersMessages: z.number().default(10),
  /** 注入几条**自己的**回复。 */
  contextOwnMessages: z.number().default(15),
  /**
   * 当前消息**明确要求看图**时，上下文里带图的旧消息最多几张。
   *
   * 默认 2；设 0 = 上下文里永远不带图（只留 `[图片]` 占位）。
   * 理由：图片按整张图计费，而上下文里那些图多半只是当时的背景。
   * 只有对方这次明确说"看上面那张"时才值得把旧图也附上。
   */
  contextImagesOnRequest: z.number().default(2),

  /**
   * 用 QQ 侧的历史（`get_group_msg_history`）**直接**刷新上下文窗口。
   *
   * 为什么默认开：桥接只知道自己收到过的消息。托管关着、插件重载中、
   * 或缓冲被挤掉的时段，群里的对话在桥接这边是空白的 ——
   * 实测群里 12:12 那三条真实对话，桥接库里一条都没有，
   * 于是被唤醒时它完全不知道刚才聊了什么。
   *
   * QQ 历史是协议的真相：包含未托管期间的消息，也包含机器人自己发的
   * （`reportSelfMessage` 关着时桥接收不到自己的话）。
   * 而且**直接注入比让模型自己调工具更准**：模型常常意识不到该去查历史，
   * 查了还要多花一轮。
   */
  contextFromQQHistory: z.boolean().default(true),
  /** 回读多少条（最终还会被 contextOthersMessages/contextOwnMessages 裁） */
  contextHistoryCount: z.number().default(25),
  /**
   * 回读结果的缓存毫秒数。
   *
   * 设 0 = 每轮都拉（最新，但每轮多一次本地 HTTP）。
   * 默认 20 秒：群聊里几十秒内的连续几轮用同一份就够，省掉重复请求。
   */
  contextHistoryCacheMs: z.number().default(20000),
  /** 首轮完整窗口，后续仅注入新增/更新记录；false = 每轮完整窗口。 */
  injectWindowOnce: z.boolean().default(true),
  /**
   * 记忆文档只在**内容变了**的时候才重新注入。
   *
   * 记忆文档很少变，没变就在历史里躺着。用哈希判断，变了才重发。
   * 群里说话人轮换时哈希每轮都变，所以这项主要在私聊里省得明显。
   *
   * 省约 530 token/轮 —— 但风险比窗口那条高：文档要往回翻才看得到。
   * 如果发现它"忘了你是谁"，把这个改成 false。
   */
  memoryInjectOnChange: z.boolean().default(true),

  // ---- 开发者调试命令 ---------------------------------------------------
  /**
   * 允许使用调试命令的 QQ 号。**默认空 = 完全关闭**。
   *
   * 为什么不做成"写在提示词里的后门"：那样它就成了模型上下文的一部分，
   * 群里任何人套一句"忽略之前的指令"都可能把暗号套出来。
   * 而这里的命令**由桥接直接处理、根本不进模型**——模型的上下文里
   * 从来没有这个暗号，所以不存在被套取的问题。
   */
  debugUsers: z.array(z.string()).default([]),
  /** 调试命令前缀 */
  debugPrefix: z.string().default('#debug'),

  // ---- QQ 会话专用的模型 -------------------------------------------------
  /**
   * QQ 的 Agent 用哪个模型。留空则沿用 DSH 的全局默认。
   *
   * 用 sessionController.selectModel 做**按会话**覆盖，所以改这里
   * 不会影响你在 DSH 界面里的其它会话。
   */
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  /**
   * 思考强度。留空 = 不指定，交给模型自己决定。
   * 第三方聚合站的模型未必认这个字段，所以默认不发，避免报错。
   *
   * ⚠️ 注意它与 `auxReasoningEffort` 的**语义差别**：这里留空/`'off'` 在
   * `sessions.mjs` 里是"不发送该字段"（历史语义）。但"不发送"并不等于关闭思考 ——
   * DeepSeek 官方文档写明思考**默认开启、默认 effort 为 high**，实测该网关的
   * 主回合日志里每轮都有上千字符 `reasoning` 块。所以对辅助判断调用改用下面的
   * 显式档位，而不是依赖"省略即关闭"这个假设。
   */
  llmReasoningEffort: z.string().default(''),
  /**
   * 辅助判断调用（语义路由／心跳／记忆提炼／发言复核／进度旁路／记忆合并）
   * 使用的模型。留空 = 沿用 llmProvider/llmModel（即与主对话同模型）。
   *
   * 为什么建议单独指定：这些调用都是"短分类"，不需要推理。而主模型若默认开启思考，
   * 思考分片走 `reasoning_content`（与正文 `content` 是两种分片），在 maxTokens 很小
   * 时会把预算全花在思考上 —— 实测 `deepseek-v4.1-flash` 默认请求：
   * 首字节 5331ms、思考 1157 字、**正文 0 字**、`finish_reason: length`，
   * 于是既要撞 `taskRouteTimeoutMs` 又会产出截断 JSON。
   * 换成同路由不思考的 `deepseek-v4-flash` 后实测：首字节 2125ms、思考 0 字、
   * 2.5 秒返回合法 JSON。这也正是 profile 注释里"便宜模型判断该不该插话"的本意，
   * 只是此前一直没有对应的配置键。
   */
  auxProvider: z.string().default(''),
  auxModel: z.string().default(''),
  /**
   * 辅助判断调用使用的思考档位，默认 `'off'`。
   *
   * 与 `auxProvider`/`auxModel` 是两道独立的闸：换模型解决"这个模型默认就思考"，
   * 这一项解决"即便换了模型也要显式声明不要思考"。留空 = 不干预。
   */
  auxReasoningEffort: z.string().default('off'),

  // ---- 持久化与可靠性（借鉴 Tulpa）---------------------------------------
  /**
   * 数据目录。幂等回执、事件缓存、授权、图库都放这里。
   * 留空 = 用当前工作目录下的 data/。
   */
  stateDir: z.string().default(''),
  /** 总开关。关掉则退回纯内存 + 直发的旧行为。 */
  persistenceEnabled: z.boolean().default(true),

  // ---- 发送配额（持久，重连/重载不重置）--------------------------------
  /** 每个会话每小时最多发几条消息。0 = 不限制。 */
  sendQuotaPerHour: z.number().default(600),
  /** 每个会话每分钟最多发几条消息。0 = 不限制。光靠小时额度挡不住突发刷屏。 */
  sendQuotaPerMinute: z.number().default(20),
  /**
   * 单条回复最多允许拆成几个气泡**计入配额**。
   * 气泡是真人聊天的节奏，不该被当成刷屏，所以默认按"一轮"计数。
   */
  countBubblesAsOne: z.boolean().default(true),
  /**
   * 同一条会话两次发送之间的最小间隔（毫秒）。默认 0 = 不额外限流。
   *
   * 为什么默认是 0：气泡之间的"打字节奏"（`bubbleDelayPerCharMs`）已经
   * 负责让它像真人在敲字，再叠一道全局间隔只会让每条回复都慢半拍。
   * QQ 不像某些平台那样掐这个，所以这个值该留给"被风控了再调大"。
   *
   * ⚠️ 它**不阻塞推理**：发送在队列里排队，Agent 回合早就结束了
   *    （见 delivery/send-queue.mjs）。调大它只会让话说得慢，不会让回复被吞。
   */
  sendMinIntervalMs: z.number().default(0),

  // ---- 事件缓存 ---------------------------------------------------------
  /** 每个会话在事件缓存里保留多少条（超出淘汰最旧的）。 */
  eventsKeepPerConversation: z.number().default(1000),
  /** 启动时从事件缓存回灌心跳缓冲。 */
  restoreBufferOnLoad: z.boolean().default(true),
  /**
   * 把 OneBot 重推按 message_id 去重。
   *
   * 实测 OneBot 上报超时后会重推同一条消息，不去重的话
   * Agent 会对同一句话回两遍。
   */
  dedupeIncoming: z.boolean().default(true),

  // ---- 戳一戳（notice 事件）---------------------------------------------
  /**
   * 被戳之后回戳一下。
   *
   * OneBot 有四类上报，本插件原来只处理 `message`，其余全丢 ——
   * 包括戳一戳、输入状态、撤回、加好友申请。这些开关把 `notice` 里的
   * 戳一戳接起来。
   */
  pokeReplyEnabled: z.boolean().default(false),
  /**
   * 被戳之后做什么。
   *
   *   'text'  回一句固定的随机文案（便宜、即时，但很机械）
   *   'agent' **唤醒完整 Agent 回合** —— 带人设、记忆、群上下文，真"醒过来"
   *           回应。贵得多（每戳一次一轮推理），所以下面有独立限流。
   *
   * 实测：'text' 用起来就是个"快捷回复机器人"，完全不像被叫到。
   * 想让它像群友一样反应，就得用 'agent'。
   */
  pokeReplyMode: z.string().default('agent'),
  /**
   * agent 模式下的额外限流。
   *
   * 为什么和 text 模式分开：text 只是发一条消息，agent 是**一整轮推理**。
   * 有人连戳时，前者最多刷屏，后者会烧钱。
   */
  /** agent 模式下，两次唤醒之间至少隔多久（全局）。 */
  pokeAgentMinIntervalMs: z.number().default(30000),
  /** 每个人每小时最多唤醒几次（落盘）。 */
  pokeAgentPerSenderPerHour: z.number().default(6),
  /**
   * agent 模式下是否由桥接先自动回戳一下。
   *
   * 这是"戳回去"这个动作本身，和文字回复独立：
   * 就算它最后选择 [SKIP] 不说话，回戳也已经发生了 —— 这更像真人。
   */
  pokeAgentSendPoke: z.boolean().default(true),
  /** agent 模式下群里是否也回话（false = 只回戳，不说任何话）。 */
  pokeAgentGroupText: z.boolean().default(true),
  /** 回戳的文案，随机挑一条。空数组 = 不回文字，只回戳一下。 */
  pokeReplyTexts: z.array(z.string()).default(['？', '干嘛', '别戳了', '在呢', '戳我干嘛']),
  /** 两次回戳之间至少隔多久（全局）。防止有人连点。 */
  pokeReplyMinIntervalMs: z.number().default(10000),
  /** 同一个人每小时最多戳回去几次。 */
  pokeReplyPerSenderPerHour: z.number().default(5),
  /**
   * 群里回戳的群白名单。空数组 = 不额外限制（但仍受 groups 白名单约束）。
   * 单独一份是因为回戳算"主动打扰"，和"被 @ 才回复"不是一回事。
   */
  pokeReplyGroups: z.array(z.string()).default([]),
  /** 群里回戳时是否也发一句文字（false = 只回戳，不发消息）。 */
  pokeReplyGroupText: z.boolean().default(true),

  // ---- 加好友 / 入群申请（request 事件）---------------------------------
  /**
   * 收到申请时私聊通知这些 QQ 号。空数组 = 不通知
   * （申请仍会记进数据库，可以用 qq_list_add_requests 查）。
   *
   * 和 debugUsers 一样**只认名单里的人**，且通知一律走私聊。
   */
  notifyUsers: z.array(z.string()).default([]),
  /**
   * 自动处理申请。默认**关闭**，只转发给人。
   *
   * 为什么默认关：同意加好友等于让一个陌生人之后能给这个 QQ 会话发消息，
   * 而这个会话跑的是带完整工具权限的 Agent。白名单为空时尤其危险。
   */
  autoHandleRequests: z.boolean().default(false),
  /** autoHandleRequests 为 true 时的默认动作：'approve' | 'reject'。 */
  autoHandleRequestAction: z.string().default('reject'),
});

function assertConfig(config) {
  if (!['lazy', 'always', 'never'].includes(config.forwardMode ?? 'lazy'))
    throw new Error("forwardMode 只能是 'lazy' | 'always' | 'never'");
  for (const [name, fallback, min, max] of [
    ['forwardMaxChars', 6000, 200, 100000],
    ['forwardMaxMessages', 20, 1, 500],
    ['forwardTimeoutMs', 10000, 1000, 60000],
  ]) {
    const value = config[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} 必须是 ${min}～${max} 之间的整数`);
  }
  if (!['off', 'shadow', 'enabled'].includes(config.taskRoutingMode ?? 'off')) throw new Error('invalid taskRoutingMode');
  if (!['conversation', 'task'].includes(config.dialogueSessionMode ?? 'conversation')) throw new Error('invalid dialogueSessionMode');
  for (const [name, fallback, min, max] of [
    ['inputDebounceMs', 1500, 0, 10000], ['inputShortDebounceMs', 3500, 0, 10000], ['inputMaxWaitMs', 8000, 1, 30000],
    ['inputBatchMaxMessages', 24, 1, 100], ['floorWaitMs', 30000, 1000, 300000],
    ['taskProgressTimeoutMs', 6000, 1000, 15000], ['taskProgressConcurrency', 2, 1, 4],
    ['taskProgressMaxPending', 32, 1, 100], ['conversationMemoryMaxChars', 450, 0, 2000],
    ['replyRecoveryConcurrency', 2, 1, 4],
    ['replyRecoveryTimeoutMs', 20000, 1000, 180000], ['replyRecoveryMaxAgeMs', 900000, 60000, 604800000],
    ['replyStaleDeliveryMaxAgeMs', 600000, 60000, 604800000],
    ['taskSweepIntervalMs', 60000, 5000, 3600000], ['taskReceiptsIntervalMs', 15000, 1000, 600000],
    ['taskRouteTimeoutMs', 4000, 1000, 15000], ['rotateEveryTurns', 20, 0, 10000],
    ['routeSteerableWindowMs', 600000, 0, 86400000],
    ['replyDecisionTimeoutMs', 5000, 500, 30000],
    ['conversationContextMaxChars', 60000, 10000, 1000000],
    ['taskConcurrency', 3, 1, 8],
    ['taskConversationConcurrency', 2, 1, 4], ['taskOwnerConcurrency', 2, 1, 4],
    ['taskDispatchScanLimit', 128, 16, 1000], ['taskContextMaxChars', 120000, 10000, 1000000],
    ['taskWaitExpiryMs', 86400000, 1000, 2592000000], ['taskIdleArchiveMs', 604800000, 1000, 2592000000],
  ]) {
    const value = config[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${name} 必须是 ${min}～${max} 之间的整数`);
  }
  if (Math.max(config.inputDebounceMs ?? 1500, config.inputShortDebounceMs ?? 3500) > (config.inputMaxWaitMs ?? 8000))
    throw new Error('inputMaxWaitMs 不能小于 inputDebounceMs 或 inputShortDebounceMs');
  if (!Number.isInteger(config.episodeInjectLimit ?? 4) || (config.episodeInjectLimit ?? 4) < 0 ||
      (config.episodeInjectLimit ?? 4) > 10 || !Number.isInteger(config.episodeInjectMaxChars ?? 900) ||
      (config.episodeInjectMaxChars ?? 900) < 0 || (config.episodeInjectMaxChars ?? 900) > 4000)
    throw new Error('episodeInjectLimit 必须在 0～10 之间，episodeInjectMaxChars 必须在 0～4000 之间');
  if (!Number.isInteger(config.memoryInjectMaxChars ?? 1800) ||
      (config.memoryInjectMaxChars ?? 1800) < 0 || (config.memoryInjectMaxChars ?? 1800) > 12000)
    throw new Error('memoryInjectMaxChars 必须在 0～12000 之间');
  const batch = config.memoryExtractBatchSize ?? 6, interval = config.memoryExtractIntervalMs ?? 30000,
    timeout = config.memoryExtractTimeoutMs ?? 15000;
  if (!Number.isInteger(batch) || batch < 1 || batch > 40 || !Number.isInteger(interval) ||
    interval < 1000 || !Number.isInteger(timeout) || timeout < 1000 || timeout > 2147483647)
    throw new Error('memoryExtractBatchSize 必须在 1～40 之间，记忆定时与超时必须至少 1000 毫秒');
  if (
    !Number.isInteger(config.heartbeatUnreadThreshold) ||
    config.heartbeatUnreadThreshold < 1 ||
    !Number.isInteger(config.heartbeatBufferSize) ||
    config.heartbeatBufferSize < config.heartbeatUnreadThreshold
  )
    throw new Error('heartbeatUnreadThreshold 必须是正整数，heartbeatBufferSize 不能小于该门槛');
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')) {
    throw new Error('qq-bridge path 必须是以 / 开头、结尾不带 / 的非根路径');
  }
  if (!['at', 'prefix', 'all'].includes(config.groupTrigger)) {
    throw new Error("qq-bridge groupTrigger 只能是 'at' | 'prefix' | 'all'");
  }
  if (config.groupTrigger === 'prefix' && config.groupPrefix === '') {
    throw new Error('qq-bridge groupTrigger=prefix 时必须设置 groupPrefix');
  }
  const watchMs = config.loginWatchMs ?? 60000;
  const watchTimeout = config.loginWatchTimeoutMs ?? 4000;
  const watchThreshold = config.loginWatchFailureThreshold ?? 3;
  if (!Number.isFinite(watchMs) || watchMs < 1000)
    throw new Error('loginWatchMs 必须至少 1000 毫秒');
  if (!Number.isFinite(watchTimeout) || watchTimeout < 500 || watchTimeout > watchMs / 2)
    throw new Error('loginWatchTimeoutMs 必须在 500 毫秒到 loginWatchMs 的一半之间');
  if (!Number.isInteger(watchThreshold) || watchThreshold < 1)
    throw new Error('loginWatchFailureThreshold 必须是正整数');
  const envCache = config.loginEnvCacheMs ?? 300000;
  if (!Number.isFinite(envCache) || envCache < 0)
    throw new Error('loginEnvCacheMs 不能是负数');
  // 注意：这里**不**强制 loginAlertFile 非空。
  // 以编程方式构造配置（测试直接调 apply）会绕过 schemastery 的默认值，
  // 那时文件名可能是 undefined；这种情况下退回"只打日志、不落文件"，
  // 比让整个插件加载失败合理得多。
}

export { Config, assertConfig };
