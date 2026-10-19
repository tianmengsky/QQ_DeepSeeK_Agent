# dsh-qq-bridge

> 内部工作记录（`HANDOFF.md` 与 `docs/reports/` 下的设计、审计报告）不随本仓库发布；正文中以文件名提及，仅在本地工作副本中可查。

2026-10-19 `v83-compact-dynamic-context`：每轮动态 prompt 改为按需注入。普通群聊省略绝对工作区路径，文件/任务回合和私聊仍提供；唤醒、时间线、工具回执、表情、记忆及任务信息按场景保留。工具安全所需的会话、`source_ref`、消息 ID 和执行归属字段不省略。

2026-10-19 合并转发主动分页阅读：新增 QQ 工具 `qq_read_forward`（能力位 `read_forward`）。提示词首批内容仍按 20 条/6000 字符预算展开；若还有未展开节点，Agent 可沿本轮 `source_ref`、`forward_id` 和 `next_offset` 逐页读取，每页最多 20 条。工具会核对转发 ID 来自当前消息或其引用消息，并限制在当前会话，避免任意读取或一次性撑满上下文。当前 QQ 预设已授予 `read_forward`，连接使用 SnowLuma。

2026-10-19 合并转发引用修复：引用消息中的 `forward` 段现在按引用图片的激发逻辑读取，默认调用 `get_forward_msg`；纯转发、文字触发、批次引用、清醒期和注意力闸门都不会漏掉它。读取结果按 `forwardMaxMessages: 20`、`forwardMaxChars: 6000` 截断后交给 Agent，失败保留明确占位。`forwardMode: 'always'` 每次展开，`forwardMode: 'never'` 永不展开；可调整 `forwardTimeoutMs`、`forwardTriggers` 和 `attachQuotedForwards`。

2026-10-16 人设强约束（配置层，未改 `lib/`）：修复「agent 攻击性过强」——18:10–18:22 群 100000001 实测自己 30 条／别人 12 条（**2.5:1**，含**连续 13 条**自说自话），语气逐轮升级到主动贬损群友现实能力（"上一把送几个""像你急了的样子"），最终触发群友"大肥鱼怎么这么有攻击性了"。根因是**回音自激 + 人设近端约束缺失**，三处同时修：

① **`toneAnchor` 补上否定式护栏**（此前 profile 从未配置过，一直取代码默认 `''`——而 `injectStaticOnce: true` 下完整人设只在窗口首轮注入一次，`rotateEveryTurns: 20` 意味着最多 19/20 轮**没有任何近端人设约束**；profile 里那句"所以每轮仍保留一句简短语气锚"的注释与实际不符，已一并校正）。锚点离线实测落在提示词的 **97.2% 处、紧邻当前消息之前**，每轮注入约 90 token。写法用**可自检的否定式边界**（"不评价群友的现实能力"），不用模型无法自检的形容词（"傲娇可爱"）。

② **拆自激回路**：`contextOthersMessages` 6→**10**、`contextOwnMessages` 8→**6**（原来是自己的话比别人的话多，模型在窗口里主要读到自己的回音并放大）；`awakeMs` 60000→**30000**（每条成功发送都刷新窗口，连发时窗口被**无限续期**，实测 28 秒内连发 10 条，它再也回不到旁听状态）。

③ **硬边界写入 `behavior.md` 新增「硬边界（优先于其它一切风格要求）」章节**，并在 `persona.md` 把它落成**角色事实**（"斗嘴只斗态度，不斗人"）。这两份文件由桥接每轮按 mtime 读盘，**无需重启**。

三层约束（L3 人设/行为卡 → L2 每轮语气锚 → L1 系统提示词）离线断言全部通过；临时副本全量 **862 项通过、0 个测试文件失败**。在线核对：`contextPolicy.others/own = 10/6`、`replyPolicy.awakeMs = 30000`、托管 active、`lastError` 空、build 仍 `v82-dynamic-sticker-candidates`。

⚠️ **同一份硬边界也已写入 `D:\Code\dsh-qq-preset\cordis.patch.yml` 的 `persona.suffix`（系统提示词层，强度最高），但它需要重启 DSH 才生效**——已从 DSH 源码 `dsh-hmr/lib/index.js:354` 确认，profile HMR **只监视** `profile.patchPath` 与 `~/.dsh/cordis.patch.yml` 两个补丁文件，预设 bundle 的补丁虽经 `profile.layers` 参与 `readProfilePatches`，却**不在监视列表**里，因此改了不会热重载。当前在线 QQ 会话均创建于改动之前（18:32:43），故该层尚未生效；①②③ 已生效，不依赖它。

2026-10-15 v82：收藏表情改为每轮动态随机注入 4 个真实候选，逐行放在当前消息前；LLM 按含义自主决定是否使用。角色、行为卡仍按原有首轮注入机制复用。

2026-10-15 Tulpa 情感卡 v81：在 v80 的轻量情感状态、自然缺口和可选 Emoji 基础上，补回自主判断与极短反驳；用户给出的“才不要”“我看未必”作为原样示范。Emoji 由模型按语境自行选择。工具/投递规则与 `qq-hosted` 预设继续使用当前桥接实际协议。在线 build 已更新为 v81；定向回归见 HANDOFF.md。详见 [行为卡](behavior.md)、[角色卡](persona.md) 和 实施记录（PROMPT_PLAN.md）。

2026-10-14 提示词系统 v75：小鲸鱼身份、傲娇、屑与小猫哈气保留，角色/行为原则改为正向描述并配人类示范；真实群友来回与 CPED 人工编剧对白分别注明来源，旧 AI 回复退出风格参考。固定投递/工具协议集中到首轮，每轮保留当前来源与相关材料；表达示范按场景最多两项、成功提交后去重。修改角色卡或协议会在下次输入创建新 Session，重载恢复游标，压缩/轮换重新注入。工具描述与预设重复条目精简，参数、授权和37项可见能力保持。详见 核对与实施记录（PROMPT_PLAN.md）。

同一离线输入的桥接首轮12358→5080字符，普通后续轮2575→714字符；QQ MCP可见27项schema 14844→12862字符。以上是字符比较，不代表实际token/费用。最终临时副本全量861项通过，在线 v80、精简预设与工具说明已加载；自然人格效果和最终用量待自然消息验证。详见 HANDOFF.md。

2026-10-14 启动黑屏修复：本机 CIM/WMI 查询卡住，`Get-NetTCPConnection` 在首次输出前阻塞，SnowLuma 的进程查询同样超时；实测约 9.4 GB 可用内存，3000/15099 未监听，19387 桥接在线。启动端口检查改用 .NET TCP listener 枚举，新增 `tools/windows-processes.ps1` 通过本机原生进程 API 读取 PID、父 PID、命令行，启动器与 SnowLuma 账号加载器共用；不再依赖这些 WMI 查询。批处理立即打印入口，PowerShell 显示检查阶段；账号仍需被确认才接入，检查失败不会猜账号或重复拉起服务。关闭旧黑屏窗口后重新双击即可复用已恢复服务。

验证：`node tools/run-tests.mjs launcher snowluma-launcher` 在临时副本中 **29 项通过**，包括真实 TCP listener 开关与原生进程读取；本机启动恢复 OneBot，机器人账号 `online=true/good=true`，已收到自然 QQ 消息。在线 build 仍为 `v74-conversation-facts-off`，托管/心跳 active，replyShapes=[]、awakeMs=60000、出站队列空；lastError 仍记录既有「回复恢复失败: The operation was aborted due to timeout」，本次未修复该恢复问题。未发送合成 QQ 消息，未改用户配置，未重启 QQ/DSH 或 Windows WMI 服务。

v73 验证：最新系统临时副本全量 **845项通过、0个测试文件失败**；线上v73任务筛选策略已生效，真实新回合的任务区长度由lastPrompt.taskContextChars观察。

v73 只读字符对比：同一当前数据库事实重建两版任务区，约3924→213字符（减少95%）；不等于整段prompt或实际token下降。status.contextPolicy.taskContext 标明筛选策略，lastPrompt.taskContextChars 记录成功提交的任务区长度。群／私聊20轮生命周期继续保留。

2026-10-13 任务提示词精简（`v73-compact-task-context`）：主回合不再每轮重复注入完整任务路由、任务账本和子代理清单。当前任务只保留目标、作者及必要结果；任务账本按当前作者、回复引用、明确任务 ID 和本轮委派结果筛选，最多3条；子代理状态合并到同一条事实，保留 job_id、状态、最新进度、结果可用性和投递状态。旧 recovering/needs_attention、无关作者的已结束任务和重复 execution/task ID 不进入普通提示词；需要查询未列出的进度时使用 qq_delegate_status。状态定义压缩为一行，仍明确“进度不是完成证据”“不授权重做”。完整账本继续留在 SQLite，路由和恢复不受影响。

2026-10-13 主窗口生命周期（`v72-twenty-turn-lifecycle`）：默认及 desktop profile 均为 `rotateEveryTurns: 20`。每个群／私聊分别计数，主 Session 成功提交一次 queue prompt 算一轮；同批短消息、多个回复气泡、工具调用、子代理步骤、只读路由／进度查询及旧回合恢复不会额外计数。第1—20轮使用同一窗口，第21轮新建 Session，重新注入人设／规则／记忆和近期上下文；旧窗口不再提交新回合，仅按旧 rpcId 恢复已提交回合。固定轮数模式不因60000提示词字符估算提前换窗；DSH压缩不清零生命周期。Session失效／归档、配置签名改变及显式强制轮换仍可提前替换。`rotateEveryTurns: 0` 仍可显式恢复字符预算模式。群／私聊工作区文件、记忆、任务账本继续保留，旧窗口不自动删除。

v72 验证：临时副本全量检查其余824项通过；委派套件旧断言更新为20轮边界后19项复跑通过，合计843项验证通过。在线build=v72、rotateEveryTurns=20、rotationMode=turn-limit，托管／心跳正常、发送队列0、lastError=null；真实20轮边界尚待自然对话观察。

2026-10-13 会话清理与数据目录迁移（工具层，未改 `lib/`）：

桥接每轮换一次就留一个 Session，攒到 729 个后 DSH 界面把它们全塞进「未分组」。新增 `tools/clean-ungrouped-sessions.mjs`：判定口径与界面一致（`workspace.json` 未登记的即未分组），但**只清理桥接自己产生的**（`~/.dsh/qq-workspaces/**` 与 profile 里 `qq-bridge.cwd` 对应的 legacy 共享工作区），保护当前会话、各会话活跃 Session、非终态任务引用到的 Session 及最近 15 分钟写过的会话，并**移动**到 `~/.dsh/session-quarantine/`（逐条 manifest，可 `--restore`）而非删除。实测 729 → 131：移出 598 个 / 33.3 MB，保留 71 个已分组会话与 **41 个真实项目里未登记的会话**（按用户选择保留，脚本会单独列出它们）。同时修正既有 `tools/clean-qq-sessions.ps1` 只认 v4 格式（漏 73 个旧格式 `session.jsonl.zstd`）、覆盖不到每会话工作区、`-KeepDays 0` 会连在用窗口一起删的问题。

数据目录搬出私人路径：profile 的 `qq-bridge.config` 加 `stateDir: 'D:\Code\dsh-qq-bridge\data'`（此前留空回退到 `<cwd>/data/`，写进了 `D:\作业\计算机组成原理`）。`tools/migrate-bridge-data.mjs` 用 `VACUUM INTO` 做 WAL 安全的一致性快照，23 表行数零差异；改配置后桥接 16:42:43 重启切库，自报 `reliability.持久化` 指向新路径，快照到切换的数据缺口为 0。新增 `tools/db-path.mjs` 统一解析库位置，`inspect-store` / `check-buffer-health` / `clear-stale-gaps` 改用它，仓库不再硬编码私人路径。

2026-10-13 入站修复（`v71-routing-delivery-fallback`）：真实 QQ 请求已到桥接，但语义路由不可用时被转为只读 clarify，未提交 DSH，最终仅回复系统异常。现在路由服务／模型缺失、超时、流异常、非法 JSON、无效证据或过期任务版本均回退为 new 普通回合，保留完整输入批次，在原 QQ 会话主窗口执行，不猜测旧任务修改目标。有效 query／clarify／cancel 仍使用只读通道；任务归属证据、作者和会话校验保留。外部取消仍终止 admission，不因回退重建任务。status 的 fallback 和路由 reason 已同步，便于区分模型判定与故障降级。

**运行环境：Node.js >=24.10.0；本轮验证版本为 24.16.0。** 修复与模块拆分结果见 REFACTOR_RESULT.md。

v71 验证：系统临时副本全量 **842 项通过，0 个测试文件失败**。16:28:52 +08:00 线上 v71 已生效、托管／心跳开启、QQ online、replyShapes=[]、awakeMs=60000、发送队列为空。lastError 为旧回合的“回复恢复失败：timeout”，旧 attention/following 保留；修复后的自然 QQ → DSH → QQ 端到端尚未取得新样本。

把 QQ 接进 DSH 的 **Cordis 插件**：接收 SnowLuma 的 OneBot v11 事件上报，驱动 DSH Agent 会话，再把 Agent 的回复发回 QQ。当前接入端为 SnowLuma。

2026-10-13 委派工具核对（`v70-delegation-preset-visibility`）：审计 14:18 的真实写作回合发现，桥接 prompt 已要求 qq_delegate，但 request/header 的 33 个模型工具里没有 qq_delegate/status/control/progress，主代理自行调用进度／文档／发送／记忆工具，worker 表为空。因此先前“spawn 服务 available”只证明原生服务存在，不能证明 QQ 模型实际拿到工具。现在 status.tasks.delegation 同时检查原生服务、全局注册、当前 qq-hosted 预设作用域与已加载主 Session 工具；available 要求四个工具均已注册并对预设可见，缺失项单列。预设文件及桥接每轮 prompt 明确原生工具名、source_ref/description/prompt 参数、长任务先委派／结束协调回合、子代理阶段报告／最终交回，禁止只写口头委派。

工具 schema 删除 DSH 不支持的 maxLength，长度／空值在运行代码中验证；已用本机 DSH 的 assertSupportedJsonSchema 核验四项参数及输出 schema。受影响临时副本 delegated-work/tool-scope/logic/lifecycle 共 **223 项通过**。四个工具的当前预设可见性已核对，真实下一次长任务是否实际调用、完成与交付仍需自然消息验收；没有发送合成 QQ 消息或重做先前小说。

2026-10-13 自然插话修正（`v69-semantic-interjection-routing`）：取消“必须先命中补充关键词才能插话”的入口。enabled 模式下，只要有非只读任务上下文，完整作者输入批次都由只读语义路由器结合作者、引用、时间线、原要求、摘要与实际忙碌状态分类；引用也不强制等于继续或查询。同文活动请求仍按确定事实去重，shadow 不调用路由模型。代码核对会话、作者、当前消息／原任务证据与任务版本，跨作者修改拒绝；模型不可用／超时／无效／期间版本变化时澄清，不猜测修改目标。

修改或补充原要求才注入正在执行的父／子代理；“怎么样，可以写吗？”这种纯追问应走只读查询，不改变作品要求；同作者或其他成员的独立新问题仍有独立任务归属。删除关键词即时注入与 enabled 模式下关键词进度抢占，所有消息先短缓冲合并碎句，再走独立 task-ingress，不等待长任务的执行锁。只读查询／澄清有独立并发名额（taskProgressConcurrency，默认 2、每会话 1），普通执行名额满也能回复。分类仍需要一轮模型调用，受原 taskRouteTimeoutMs 限制；不保证零延迟或任意自然语义都识别正确。**这轮调用的失败原因现在会记下来**：`routeFailure()` 把超时、模型流异常、JSON 非法、裁决没过 `validate()` 分开，写进 `bridge_routes.data` 的 `fallbackCause`/`fallbackDetail`（`reason` 仍是稳定的 `semantic-route-fallback`，未改契约），并在 `status.taskScheduler.routeFallbacks` 出直方图、`recentRoutes` 与 `stats.lastTaskRoute` 带上原因。实测（2026-10-16，desktop profile `taskRoutingMode: enabled`）：路由失败 p50 比不调模型多花约 **4s**，且 `fallbackCause=timeout` 时 `fallbackDetail` 常是"已收 0 字" —— 即路由模型连首字都没吐出来就被 `taskRouteTimeoutMs: 4000` 掐断，说明该上限低于当前 a6api 中转的首字时间。排查入口：`node tools/check-ingress-latency.mjs`。

**2026-10-16 路由门控（`routeSteerableWindowMs`）**：上面那个模型调用此前**每条消息都要付一次**，
因为门槛是"会话里有非归档任务"。实测 375 条非归档任务里**真正可被 steer 的只有 1 条（0.3%）**
——prompt 塞满早已结束的任务，而唯一可能落地的答案（`new`）本地免费就能给出。现在只有存在
**可被 steer 的任务**（有在跑/排队的执行、状态在 queued/running/waiting_input、或终态但在
`routeSteerableWindowMs` 内）才调模型，并且只把这些任务送进 prompt 与校验候选。
`status.tasks.routingCalls = {local, model}` 直接显示有多少条走了本地裁决（没调模型）。
预期效果：每条消息省掉约 **2.5 秒**（`deepseek-v4-flash` 实测首字 2125ms、完成 2518ms）。
顺带修正：没有可被 steer 的任务时，"进度问句"（怎么样了/好了没）不再退化成澄清问句——
那正是线上出现过**连续 7 次 clarify** 的来源。

**2026-10-16 更正与修复（`auxProvider`/`auxModel`）**：上面那句"该上限低于首字时间"方向对了，但当时把它归因成"中转慢"并不完整。直连实测同形状请求（max_tokens 280、流式）：

| 请求 | 首字节 | 正文 | finish |
|---|---|---|---|
| `deepseek-v4.1-flash` 默认 | **5331ms** | **0 字**（思考 1157 字吃满预算） | `length` |
| `deepseek-v4.1-flash` + 关闭思考（三种拼写均可） | 1822–2497ms | 111–121 字 ✅ | `stop` |
| **`deepseek-v4-flash`**（同路由，默认不思考） | **2125ms** | 117 字 ✅ | `stop` |

即：主模型**默认开启思考**，思考分片走 `reasoning_content`，在 `maxTokens` 很小时把预算全花在思考上 —— 既会撞 `taskRouteTimeoutMs`，又产出截断 JSON（线上 24 次 timeout + 6 次 invalid-json 的共同机制）。**修法是给辅助判断调用单独指定一个不思考的快模型**，这也正是本文件里"便宜模型判断该不该插话"的本意（此前没有配置键，所以它一直在用主模型）。优先级：专用键（`heartbeat*`/`memory*`）> `auxProvider`/`auxModel` > `llmProvider`/`llmModel` > 全局默认；`status.models` 直接列出各路实际解析结果。

v69 临时副本全量 **838 项通过**，其中 task-routing／delegated-work／task-progress／input-floor 定向 129 项，覆盖无关键词修改、引用旧消息但另问新问题、自然中止、无当前消息证据拒绝、分类期间版本变化、进度前缀加修改合批、普通执行满额仍回复。线上已加载 v69，托管／心跳 active，发送队列空；14:33 检查 lastError=null，14:35 旧群聊回复恢复再次超时，旧未决记录保留，详见 HANDOFF。分类测试使用受控模型结果，真实群聊准确率及自然注入仍需自然消息验证；未发送合成 QQ 消息。

2026-10-13 对话与子代理调整（`v68-dialogue-subagents-interjection`）：默认 `dialogueSessionMode: conversation`，每群／每私聊复用一个主 Session 和对话 topic。独立请求仍有独立 task/execution/作者与消息归属，但不再按每个请求创建顶层窗口。旧已提交任务继续使用原 Session 恢复，不迁移或重提；`task` 模式仅保留兼容入口。

输入链路仍为准入 → 短消息缓冲 → 作者边界分批 → 任务归属分类 → 持久认领。默认普通 debounce 1500ms、短文本 3500ms、最长 8000ms、批次 24 条；v69 起同作者修正也先聚合并做语义归属，再调用 DSH 本地 Agent 的 `inject` 写入 next-step，既不唤醒空闲代理，也不偷建无归属回合。普通新请求继续 queue；多人／多任务弱指代不强行合并，必要时澄清。插话后的步骤清除尚未投递的旧草稿，只发送最终修订版；已经成功发出的进度不可撤销。

长代码／写作／研究任务先用 `qq_say` 报实际计划，再用 `qq_delegate` 调用原生 DSH `spawn` 后台子代理。全局最多 3 个、同 QQ 会话最多 2 个工作代理；超额持久入队，待办最多 32 个，每项包含排队最多 15 分钟。父窗口继续聊天；`qq_delegate_status` 读取状态，`qq_delegate_control` 调整本人任务，工作子代理用 `qq_job_progress` 记录摘要，重要阶段另用 `qq_say` 及时报告。只发工作阶段／结果摘要，不输出内部推理。子代理仅有搜索、会话工作区、Word/PDF 创建及进度工具，不获得 shell、任意文件路径或群管理权限，也不独立发送最终文件；代码可生成，但不会因此获得本机运行能力。

主窗口维护：QQ 历史按真实时间合并后分别保留群友／自己条数，每轮增量注入上下文、任务摘要及工作代理状态；默认不按轮数旋转，不因换话题重建。达到累计提交 prompt 60000 字符预算、已归档／失效或显式轮换时新建，保留 QQ 时间线、长期记忆、任务与文件。该预算不是模型总上下文 token 测量。子代理完成／失败结果先持久化，以确定性 execution ID 交回父窗口并沿原发送队列投递；重载中的在途子代理标记 needs_attention，不冒充仍在工作、不自动重做。普通正文仍由桥接最终投递，同会话气泡保序、跨会话轮转，成功回执刷新 60 秒唤醒。

验证：临时副本全量 831 项通过，最终受影响 76 项复跑通过；线上已加载 v68、conversation 主窗口模式与 DSH spawn 服务，托管／心跳 active、发送队列空、lastError=null。尚无自然长任务对子代理／插话的端到端验收样本，旧未决投递保留，未发送合成 QQ 测试消息。

2026-10-13 文件权限调整（`v67-conversation-file-workspace`）：文件只按 QQ 会话隔离，每群一个目录、每个私聊一个目录，同会话不同任务共享文件。取消文件任务关键词授权与 `qq_say` 成功回执前置条件，已有文件可以直接读取、修改、打包和发送；有效来源、会话归属、取消/撤回、路径/链接检查、容量和发送能力/配额/幂等继续保留。旧任务文件保留在会话目录内，`qq_workspace list` 可发现 `tasks/<旧任务号>/<文件名>`，使用该相对路径即可读取或发送，旧 `.outgoing` 快照不进入文件列表。

验证：`node tools/run-tests.mjs` 临时副本全量 **815 项通过**，最终任务提示事实展示调整后的 task-routing/task-progress **63 项通过**。在线已核对 v67、conversation 工作区、托管/心跳正常、replyShapes=[]、awakeMs=60000、发送队列空、lastError=null；独立 QQ MCP 已刷新，真实文件交付等待自然请求，不发送合成 QQ 测试消息。

2026-10-13 记忆面收敛（`v74-conversation-facts-off`）：desktop 摘除会话「长期约定」注入，`conversationMemoryMaxChars: 0` 现在表示整面关闭 —— 既不注入，也不再让后台提炼器产出会话事实（prompt 的 scope 枚举和候选校验同步去掉 `conversation`）。已保存记录只读保留，不删除、不迁移。原因：这个面只能由后台提炼器写，`qq_memory` 没有会话作用域，没有人能人工纠正它；实测群 100000001 存档 34 条中 32 条 active，21 条一次性任务、8 条「是否成行未确认」的邀约，注入不带日期、不会失效、不记结果。人物记忆面（`## 主模型记忆` / `## 自动记忆`）不受影响；同一份真实存档渲染的记忆段从 1046 字降到 628 字。GET `/qq/onebot` 的 `memoryPolicy.conversationFacts` 报 `injected`/`extracted`/`maxChars`/`archive`；`#debug memory` 仍列出存档并标注「已关闭注入与提炼」。改回正数即恢复注入。

验证：`node tools/run-tests.mjs` 临时副本全量 **847 项通过、0 个测试文件失败**（memory-context 42、debug 16，新增 3 项覆盖关闭后既不提炼也不注入、存档保留、以及关闭时不再向提炼模型索要 `conversation` 范围）。在线已热重载 `v74-conversation-facts-off`，`memoryPolicy.conversationFacts = {injected:false,extracted:false,maxChars:0,archive:"kept"}`、托管/心跳 active、replyShapes=[]、发送队列空、lastError=null。未发送合成 QQ 消息。**注意**：这次运行之后，同一目录的另一个会话改了 `test/mcp.test.mjs` 与 `test/task-routing.test.mjs`；再跑全量会看到 mcp 新增的「跨会话开关」用例因自身没桩住 OneBot 发送而 `fetch failed`，与本改动无关（细节见 HANDOFF）。

2026-10-12 语音接入：默认启用 `voiceTranscriptionEnabled`，收到准入范围内含 `record` 段的实时语音时，调用 SnowLuma `fetch_ptt_text` 使用 QQ 内置语音转文字。消息照常入队，Agent 生成提示词前等待上游识别结果（上游最多等待 20 秒，桥接请求上限 25 秒）；成功后消息显示为 `[语音转文字：…]` 并更新会话窗口，失败、空文本或缓存失效时显示 `[语音：QQ 转文字失败，内容不可知]`，并记录错误码；不会伪造内容或依据旧任务上下文猜测。私聊按现有准入规则触发；群聊仍需满足现有 @、前缀、全量或唤醒规则，单靠语音里念名字不会在转写前触发新回合。群背景消息会在转写完成后更新窗口，但旧历史缺少上游语音缓存时不能保证重新转写。设置 `voiceTranscriptionEnabled: false` 可关闭。测试：`node tools/run-tests.mjs voice-transcription`；真实 QQ 语音需等待自然样本验收。

2026-10-12 更新（`v65-owned-task-execution`）：desktop 已启用 `taskRoutingMode: enabled`、`rotateEveryTurns: 0`。入口按完整作者批次持久认领后释放，独立任务有上限地并行，同任务串行；shadow 不再等待路由模型。普通 Session 默认累计提交提示词 60000 字符、任务 120000 字符后轮换，这是提示词预算，不是全量模型上下文 Token 上限。同作者未认领批次中的进度形碎句继续聚合，旁观者进度旁路保留。

修复共享历史重复执行：群 100000001 的“战术 Word 请求”与另一作者的“34”窗口实际各生成、发送了一份不同内容的同名文件。共享历史继续注入，本轮仍明确列出负责的消息 ID；文件目录按 QQ 会话隔离，同群/同私聊的不同任务共享文件，群与私聊互不可见。来源编号、会话归属、路径安全和发送能力位仍由宿主及独立 MCP 校验，不能访问其他群或私聊的文件。同文活动请求在事务内去重为只读查询；语义近似文件请求才进入模型匹配，不能声称所有改写已可靠去重。活动任务不会被最近 12 条聊天挤出候选，恢复/退避状态同步到任务实体。

自然语义验收仍未完成：v68 已取消默认按独立输入创建窗口，弱指代的连续话题归属、子代理调度选择、并行下完整答复和实际延迟仍需后续自然样本。不会因离线回归通过就称九阶段线上验收全部完成。运行与最新验证见 HANDOFF。

执行清单与进度旁路（`v62-topic-task-scheduler`）：共享 SQLite 保存每个已归属模型回合的请求者、来源、Session/rpcId、消费状态及成功回执进度。纯进度问询可在独立只读模型通道查看同会话清单，由 LLM 组织回复，不等待长 Agent 回合、不重新执行原任务；默认 6 秒等待、全局 2 并发、每会话 1 个、最多 32 条待处理查询。混合请求或不确定判定退回普通输入。查询输出沿用持久 journal、幂等投递、配额和 60 秒唤醒；状态变化时重新判断，过时进度不继续发送。旧 rpcId 的只读恢复与已保存输出交接也独立调度，不占住新输入通道，读取失败不冒充明确发送失败。

话题/任务系统已实现持久事实表、路由证据、任务 Session、工作区和并发调度，但 `taskRoutingMode` 默认是 `shadow`：只记录路由观察，不改变普通执行路径，避免语义路由完成前“一句话一个任务”。任务 Session 即使启用也会注入同群共享的近期 QQ 历史，并额外保留任务来源；话题归类不会删除上下文。完整阶段、事故时序、验证与切换步骤见 TASK_ROUTING_PLAN.md。GET `/qq/onebot` 与 debug JSON 的 `tasks` 可查执行清单、路由模式、待处理年龄、进度和恢复通道；诊断不输出任务正文。

长期记忆中的“本会话已确认的约定与话题”调整为“本会话长期约定”：临时任务/话题/进度槽位不再注入，存档保留；默认单块最多 450 字、整条选择，仍受总记忆预算与变化注入约束。`conversationMemoryMaxChars: 0` 可摘除这块注入，且自 `v74-conversation-facts-off` 起同时停止提炼会话事实（整面关闭，存档只读保留）。稳定称呼、偏好、长期约定继续保留，旧 Session 中已存在的内容随换窗/压缩更新。

聚合与发送闸门修复（`v58-smart-floor-buffer`）：取消/撤回状态独立持久化，不会因 floor 最近 100 条消息滚动而失效；WAIT 绑定原始请求消息，只接受引用或明确条件补充，同作者独立新问题不会串回旧 WAIT。普通查询工具调用继续经过发送前 floor 复核，只有成功写入/打包工作区或成功发送文件才保护任务结果；心跳批次也使用同一套 floor policy，新 direct 请求可以拦下尚未发送的旧心跳答复。

回复价值复核（`v56-reply-value-floor`）：换话题不自动取消待答请求。答复、事实澄清/纠错、姓名或要求确认、任务成功/失败结果仍需交付；仅有具体新消息证据的过时闲聊可以退避。按请求者划分输入批次和 WAIT，其他人的请求不覆盖原请求；每个气泡只复核剩余未发正文。复核不确定时保留答复，明确取消/撤回仍立即停止。

同批中的非被动、非捧哏、非明确面向别人的消息按作者划分回合，不要求每个请求都带 @；同作者的碎片继续合并，表情和捧哏保持时间线顺序。每批只有实际请求者拥有修改/取消权，旁观者不能因参与合批取得这项权利。较忙群聊可能增加独立回合数，完整 Agent 仍可以选择沉默。

未知回执隔离（`v57-uncertain-plan-isolation`）：attention 中 UNKNOWN/EXECUTING 只暂停所属投递计划，保留待核对状态且不自动重发；后续独立回合继续投递，不再让一条丢失回执锁住整个群/私聊。仍可投递的计划保持先后顺序，配额等待、在途任务与明确失败重试继续保序。人工核对旧回执后，其剩余气泡按原幂等计划恢复。status.replyDelivery.pending 的 quarantined 表明这条计划需要核对，而非整个会话不可发送。

桌面端启动恢复（`v55-heartbeat-startup-recovery`）：有未读背景消息且输入批次正在恢复、排队或 WAIT 时，心跳通过定时器等待输入释放，不立即递归重排。修复了后台持续占用 CPU、本地 HTTP 无响应、桌面 GUI 等待启动握手约 5 分钟后报 `UND_ERR_HEADERS_TIMEOUT` 的问题；未读消息和原输入继续保留。

和 [`qq-mcp`](<qq-mcp/README.md>) 的分工：`qq-mcp` 只能「发」（Agent 主动说话）；本插件补上「收」，形成双向对话。

回复可靠交接（`v43-durable-reply-handoff`，正文边界于 `v49-final-text-boundary` 修正）：提交模型前将 QQ 来源、Session、requestId 和订阅基线写入共享 SQLite 的 `bridge_replies`；取得回合结果后先存正文，再保存实际气泡/表情投递计划。重载、订阅断流或进程退出后，每 5 秒扫描未完成记录，按原 requestId/inbox/turn 回读 DSH 历史，不重新提交模型；保存的旧 Session 即使已经轮换也可以恢复。只投递本回合最后一次工具调用后的最终正文，保留其中全部文本片段；工具前/带工具调用的过程文字和思考不转发，已成功工具进度仍按完整气泡去重。

待发计划按原目标和原幂等编号续发，成功气泡跳过且保留原发送时间；同会话可投递计划先完成较早的，未知回执计划隔离等待核对。配额满时保留计划并等到桶重置，不绕过长度、气泡数和配额。托管关闭时暂停，重开后继续。已派发的 OneBot 请求在 HMR 时先完成有限时长的回执写入，再关闭数据库。纯 `[SKIP]`、空消息、既有准入和内容过滤仍遵守原规则。

`GET /qq/onebot` 的 `replyDelivery` 返回持久投递计数和待处理项：`following` 等待 DSH 结果，`output` 正文已保存，`planned` 待发/待重试，`attention` 回执未知需核对，`done` 已投递或有明确的跳过原因。UNKNOWN/EXECUTING 不自动重发；人工核对为成功或确定失败后扫描可继续。网络回执丢失时不能同时绝对保证送达和不重复，因此保留未知状态，不把它当完成。此机制只恢复升级后登记的 QQ 回合，不扫描或重发历史旧漏回。

回复投递前会过滤桥接生成的空消息提示回声（例如“仅 @、正文为空”及其括号/Markdown 包裹），并只在清理后没有实际文字时抑制发送；普通括号内容、`[SKIP]` 和表情/记忆标记不受影响。

SnowLuma 接入验证见 SNOWLUMA_VALIDATION.md：v1.14.22 已独立接入机器人普通 QQ，接管本机 3000 接口并上报至桥接；账号、online/good、历史、收藏表情及自然聊天发送回执实测通过。初次 16 小时观察发生中断，长期稳定性仍待重新验证。

双击 `watch-snowluma.bat` 查看实时接收、发送及错误日志，每分钟显示 QQ 登录/收发健康状态；关闭查看窗口不会结束服务。当前日志来自独立验证目录的 `startup.stdout.log` / `startup.stderr.log`，旧时间的报错不代表当前故障。`start-qq-mcp.bat status` 可随时查看账号和桥接托管状态。

`start-qq-mcp.bat` 默认启动 SnowLuma：DSH 桥接已运行时，启动缺失的 SnowLuma，按本机 QQ 登录探测只接入机器人账号，再确认 online/good 后开启托管，成功后进入实时日志。重复启动复用服务，关闭查看窗口不会结束服务。普通 QQ 未运行时会启动它；需扫码/切换账号时仍由用户登录机器人号。管理页为 `http://127.0.0.1:15099`（原 5099 被 Windows 保留端口范围占用）。`stop` 只关托管，`restart` 只重置托管。

SnowLuma 启动适配器保留官方 `index.mjs`，校验已验证的 v1.14.22 文件 SHA256 后生成独立入口，调用原 HookManager，只选择识别成功且唯一的机器人普通 QQ 主进程；排除个人号、身份未知、Electron 子进程及其他接入端进程树。升级 SnowLuma 后需重新检查入口适配，不能跳过校验。日志重启前归档为带时间的 `.bak`，不覆盖凭据。

如果普通 QQ 已运行，但“探测登录”提示“未检测到可用的账号身份信息”，这是账号探测不可用，不代表 QQ 未登录。适配器会记录 `identity-unavailable` 和候选 PID，启动脚本提示在管理页确认机器人进程后手动加载；不能按 PID 顺序或唯一进程猜账号。当前 QQ 9.9.35 的 4001/4003 接口返回通用成功 JSON，没有账号身份，不能仅把旧 4301–4310 范围改成 4001–4010 就自动注入。

Windows 后台探测：生成入口为 SnowLuma 登录探测的 `netstat/tasklist` 子进程设置 `windowsHide:true`，避免 cmd 闪现。机器人已连接时使用原生会话状态，跳过 PowerShell 枚举和账号探测；断开后才恢复识别。

> 📌 **交接请先看 HANDOFF.md** —— 那里是崩溃排查结论、当前代码状态、
> 未完成项和踩坑速查。本文档讲"它能干什么"，交接文档讲"接手要注意什么"。

## 工作区结构

所有部件都收在这一个目录下：

```
D:\Code\dsh-qq-bridge\
├── package.json          Cordis 插件包（profile 用 link: 指到这里）
├── cordis.patch.yml      插件的默认配置层
├── lib\
│   ├── index.js          Cordis 对外入口（8 行）
│   ├── bootstrap.mjs     配置校验、服务装配与生命周期
│   ├── application/      消息、戳一戳、心跳共用的回合流程
│   ├── routes/           OneBot / control / status 接口
│   ├── conversation/     队列、Session、窗口、历史、缓冲恢复
│   ├── prompt/           人设、记忆、引用、图片与提示词
│   ├── agent/            DSH 订阅、提交、收尾与取消
│   ├── delivery/         幂等投递及逐条发送结果
│   ├── domain/           准入、触发、回复策略与时间
│   ├── transport/        HTTP / OneBot / 图片读取
│   ├── memory/           长期记忆
│   └── store.mjs         SQLite 持久化层
├── persona.md            ★ 人设，直接改这个
├── qq-mcp\               ★ MCP 服务器（含工作区与文件发送）
│   ├── src\index.js
│   ├── cache\            表情总览图 + 文字目录 catalog.json
│   └── README.md
├── stickers\             本机表情包仓库（**当前是空的**）
├── memory\               长期记忆，每个 QQ 号一份 .md
└── test\                 离线测试（804 项，不需要 DSH / QQ）
```

真正生效的配置在 profile 里：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`。

另外 `tools\` 下是一堆**诊断脚本**，排查时很有用：

| 脚本 | 用途 |
|---|---|
| `check-buffer-health.mjs` | 看缓冲/ack 健康度 —— 排查"上下文不是最新" |
| `clear-stale-gaps.mjs` | 清掉库里夸大的假缺口 |
| `probe-bridge.mjs` | 往桥接端口发合成事件，验证入站链路 |
| `inspect-store.mjs` | 看库里各表、最近事件、待审批动作 |
| `audit-task-window.mjs` | 只读事故时序：入站、rpcId、journal 与发送回执；采用北京时间，不输出正文 |
| `check-ingress-latency.mjs` | 只读诊断"进 DSH 之前等了多久"：按路由结局拆开合并窗口与路由超时，并列出路由失败原因分布 |
| `check-input-aggregation.mjs` | 只读诊断输入聚合：真正聚合过的回合占比、窗口内命中率、以及"连环提问簇"本可少发几次回复 |
| `check-recovery-health.mjs` | 只读诊断投递恢复通道：未了结行的年龄分层、阻塞性执行、迟到投递护栏是否在工作 |
| `check-reply-guard.mjs` | 只读核对参与决策的硬护栏覆盖率，并列出"会去问决策模型"的真实消息供人工确认 |
| `list-our-tools.mjs` | 从源码抽出 qq-mcp 的完整工具表 |
| `dump-config-defaults.mjs` | 打印 Config schema 的真实默认值（写文档时核对用）|
| `measure-preset.mjs` / `compare-sessions.mjs` | 量预设/token 开销 |
| `window-optimizer.mjs` | 算"窗口开多少轮最划算" |
| `debug-kick-approval.mjs` | 手工复现踢人审批流程 |
| `restore-profile.mjs` | profile 被写坏时从备份恢复 |

## 数据流

```
QQ 群 / 好友
     │
     ▼  SnowLuma（OneBot v11）
POST http://127.0.0.1:19387/qq/onebot          ← 本插件用 webServer.register() 挂的路由
     │
     ├─ 事件分类计数（notice / request 都先记一笔，再分流）
     │
     ├─ notice:notify:poke ────────┐
     ├─ notice:group_msg_emoji_like → 只记下来，作为下轮上下文（不唤醒）
     ├─ request:friend|group ──────→ 落库 + 私聊通知你（不自动同意）
     │                             │
     └─ message ───────────────────┤
                                   ▼
     ├─ 入站去重（按 message_id）
     ├─ 触发判定（@ / 前缀 / 全部 / 清醒期内）+ 群白名单
     │    └─ 不触发 → 进心跳缓冲（或留作上下文），**不推理**
     │
     ├─ 轮换检查：满 rotateEveryTurns 轮就换新 Session
     ├─ ★ 用 get_group_msg_history **直接刷新上下文窗口**（含未托管期间 + 她自己的话）
     ├─ 消费心跳缓冲（并 ack 掉，避免重载后又捞回来）
     ├─ 拼提示词（人设 + 该说话人记忆 + 窗口 + 规则 + 当前消息）
     │
     ├─ ctx.sessionController.create()        首次
     ├─ ctx.sessionController.follow()        先订阅，拿 snapshot 的 cursor 作基线
     ├─ ctx.sessionController.prompt()        再提交（必须带 AbortSignal）
     ├─ 收集 assistant/message 文本直到 turn/end
     │
     ├─ 摘标记：[记住:...] 写记忆 / [表情:编号] 转发表情 / [@:QQ号] 转 at 段
     ├─ 气泡拆分 + 按字数模拟打字间隔
     └─ 幂等投递（outbox 状态机）──▶ SnowLuma ──▶ QQ
```

关键设计：**只有"被叫到"才推理**。没被叫到的群消息只进缓冲（几乎零成本），
要么被下一次唤醒带进上下文，要么等心跳判断该不该主动插话。

## 托管 Agent 能干什么

一句话：**它不只是"你 @ 它就回一句"的问答机器人，而是一个真的待在群里、有自己的
长期记忆、会挑时候插话、能发表情、还能顺手帮你干活的群友。**

下面按"你在 QQ 里能看到什么"来分。

### 1. 当群友聊天

| 能力 | 说明 |
|---|---|
| 被 @ 可直接回复 | `groupTrigger: at`，主要点名她时进入完整回合；模型仍可在无需接话时沉默 |
| 叫名字也算 | `nameTriggers: ['deepseek', '大肥鱼']`，不必真的去点 @（大小写不敏感） |
| 接着聊 | 每条成功发送的文字或表情都会开启/刷新 `awakeMs`（60s）窗口，群里没 @ 的后续消息也能接着聊 |
| 主动插话 | 心跳机制，见下 |
| 说短话 | 默认一句话 1~10 字，真人打字节奏 |
| 傲娇语气 | 像会哈气的小猫：短促、带一点刺地接梗；玩笑针对当下的事，遇到认真或被冒犯时收住 |
| 分几条发 | 当前 desktop profile 的 `replyShapes: []` 关闭抽卡，由模型自行决定，最多 `maxBubbles` 个气泡；气泡之间按字数模拟“正在打字” |
| 发表情 | 当前关闭抽卡，由模型选择是否输出 `[表情:编号]`，桥接把它转换为收藏表情发送 |
| @ 别人 | 她自己在正文里写 `[@:QQ号]`（人数上限见 `atMentionMax`），桥接把它变成真的 at 段发出去；**不写就不带**，私聊不 @，`@全体成员` 一律拒绝 |
| 该沉默就沉默 | 判断不需要接话时只输出 `[SKIP]`，桥接什么都不发 |

#### 她怎么 @ 人（`atMentionEnabled`）

提示词教的写法是 **`[@昵称]`（首选）** 或 `[@:QQ号]`（必须照抄窗口里那串号，不许凭记忆编）；
也认照抄整段的「昵称（QQ号）」。昵称先在本会话窗口里找，找不到再查这个群最近的成员表 ——
所以"@ 一个没说过话的群友"也成立。重名或查不到就当作没写。
这个标记在投递前被换成真正的 OneBot `at` 段，位置保持她写的地方（句子中间也可以）。

几条刻意的硬规则，都是「宁可不 @，也不能错 @」：

- **她没写就不 @。** 没有标记的气泡照旧按纯字符串发，不会因为开了这个功能就每条都带 @
  —— @ 是"这句话说给谁听"的信号，滥用只会变成噪音。
- **没变成 at 的标记一定被摘干净。** 号写错、昵称重名、超出 `atMentionMax`、被
  `maxReplyChars` 截断在半路：这些标记都会被删除，而不是当正文发出去
  （`[引用]` 当年就是把标记本身发进了群里，整块功能因此被撤掉）。
- **不许 @ 自己，也不许 @ 全体成员。** 前者没意义，后者是打扰所有人。
- **私聊不 @。** 私聊里没有"点名"这回事，标记会被摘掉。
- **@ 段参与幂等比对。** 同一条回复重放时，@ 的人换了会被判成"幂等编号冲突"，
  而不是悄悄把旧回执当成功。
- **群里没这个人 → 摘掉 @、正文照发。** OneBot 对解析不出 UID 的 at 段会把**整条消息**
  退回（实测 `retcode=100 failed to resolve UID for UIN …`），群里连正文都看不到。
  所以发送前拿最近的群成员表核一次：在名单里才 @，不在就摘掉只发文字。
  名单**不知道**（没拉过/太旧）时放行 —— 宁可漏拦，也不能凭旧名单拦掉真成员。
  摘掉 @ 之后内容变了，幂等编号也必须跟着变（同一个编号只能对应同一份内容），
  否则会被 outbox 判成"已存在但内容不同"，等于换个理由继续卡住。
- **卡住的重试会自愈。** 一条已经落库、正在重试的回复如果带 @，恢复流程会先重新拉一次
  群成员表再重试：坏 @ 摘掉、正文发出去、会话解锁（线上实测走通全程）。
- **明确失败有上限，不会把会话占死。** 被 OneBot 明确拒绝（非 UNKNOWN、非配额）的回复
  最多试 `replyMaxSendAttempts`（默认 3）次，到上限转 `failed` 终态、**放开该会话队列**，
  并在 `status.replyDelivery.failed` 里留一条带原错误与次数的记录 —— 放弃不等于消失。
  结果未知（UNKNOWN）永远走人工核对，从不自动放弃；配额被拒是"等会儿再来"，不计数。

`v54-quota-delivery-recovery` 将限流错误码及准确恢复时间贯穿发送队列：小时或分钟额度满时保留原计划，等到额度窗口恢复，不按 30 秒不断重试，更不会重试 3 次后丢掉。只恢复最近 24 小时被旧路径误计的明确配额失败；UNKNOWN、真实 OneBot 失败和已完成计划不自动重发。恢复仍检查发言权，过时闲聊以可查的 `floor:` 原因结束。`status.replyPolicy.sendQuotas` 显示各会话分钟/小时用量、剩余、恢复时间和是否被限流；桥接与 MCP 默认发送上限为每分钟 20、每小时 600 条，既有计数保留。

同一个解析器也被 `qq_say` 和两个发送工具复用（`qq-mcp` 那边昵称要现查一次群成员表），
所以标记不会在另一条出口上重新漏成正文。诊断口径：HTTP `status` 的 `stats.atMentions` /
`stats.atMentionDropped`（`#debug status` 里是 `delivery.atMentions` /
`delivery.atMentionDropped`）分别是送出去的 @ 个数与被摘掉的标记个数 ——
她说"@ 你"却没 @ 上时先看后者。`GET /qq/onebot` 的 `replyPolicy.atMentionEnabled` /
`replyPolicy.atMentionMax` 是这两个开关的在线读数。

普通聊天的最终正文统一交给桥接投递。`qq_say` 只用于必要的即时进度，新的最终结果仍会发送；桥接只去掉与已发工具文本完全匹配的气泡。同一群的输入按会话队列串行处理，不同群使用独立 Session；向 DSH 提交使用 `queue`，并通过 `rpcId` 对应的 inbox 条目确认回合归属。`GET /qq/onebot` 的 `replyPolicy` 可核对实际生效的抽卡与发送配置。QQ 是否送达仍以 OneBot 回执为准。

桥接按工具调用边界区分过程与最终回复：调用工具前或同条消息带 `tool-call` 的正文只留在 DSH，不在完成时补发；最后一次工具调用之后的完整正文才进入投递计划。无工具回合保留全部正文片段。即时开工和阶段说明只写在 `qq_say.text`，完成后另写最终结果、限制和玩法。工具结果按顶层 `callId` 或 DSH 的 `message.toolCallId` / `message.source.callId` 配对，不能因事件格式变化漏认成功发言。在线 `replyPolicy.textSelection=post-tool-final`，`stats.lastTurn` 可查看剔除的过程文字数量和字符数。重载恢复使用相同收集规则，已经保存的投递计划仍按原幂等编号恢复。

来源校验依赖 MCP 与桥接连接同一个 `QQ_BRIDGE_DB`。共享 SQLite 启动/迁移的写锁等待上限为 2 秒；MCP 初次连接或来源表初始化失败后，后续工具调用会重新连接/初始化，避免进程永久失效。`qq_status` 显示桥接数据库与来源校验状态；数据库不可用时明确报连接故障，不能误报 `source_ref` 过期。有效期、撤回、会话隔离和文件工作区范围继续校验。

较长写作、编程、多轮网络搜索或耗时步骤可以用 `qq_say` 发简短进度，工具前的普通正文只留在 DSH。快速问答、短文润色和单次查询直接最终回复；仅任务拖长、受阻或有实际阶段结果时追加进度，不编造用时/百分比，最终保留完整结果。文件工具不再要求开工回执，已有文件可直接读取、修改、打包和发送。

发言后的唤醒遵循同一条规则：普通回复、心跳插话、戳后文字、`qq_say` 和群/私聊/表情发送工具，每条新消息成功发出后，从该时刻重新计时 60 秒。仅排队、心跳判断通过、发送失败/UNKNOWN/dry-run/幂等重放不会重新计时。纯 `[SKIP]` 不延长也不清掉已有窗口；窗口在最后一次发言 60 秒后自然到期。共享数据库保存发言时间，插件重载后可恢复尚未到期的窗口。`awakeMs: 0` 仍可显式关闭跟聊机制。

当前 `v36-agent-attention-timeline` 使用一次完整 Agent 回合决定清醒期的语义与回应。`groupAttentionEnabled` 默认开启：明确主要 @ 或引用其他成员先旁听，直接叫名字和引用她自己的消息正常接话；其余清醒期候选直接交给有完整人设、记忆和时间线的 Agent，生成回复或 `[SKIP]`。不再调用独立、无持续对话状态的分类器给模糊消息一票否决。短句、反驳、纠正和对她的邀请回应都应结合上一句话理解。沉默不发送、不续唤醒；明确路由旁听的消息仍保存为上下文与心跳未读。准入、白名单、60 秒成功发言唤醒、会话串行和投递规则保留。

`attentionInterjectCooldownMs` 默认 30000：向完整 Agent 提示刚发过言时避免另插话题，真正承接她的话仍可回复；不是回复前分类器的硬拦截。后台心跳保留轻量判断及数量/时间 OR 触发，每批处理后按已读规则消费。`replyPolicy.attentionMode=agent-decides`、`lastAttentionDecision.phase` 可核对旁听、沉默和回复排队；排队仍不是送达。

`v53-passive-input-floor` 把入站气泡、语义轮次与发送机会分开。默认 `inputDebounceMs=1500`、短消息（渲染后不超过 40 字）`inputShortDebounceMs=3500`、`inputMaxWaitMs=8000`、`inputBatchMaxMessages=24`：连发收集后在 `registry.run` 真正取得会话队列时取快照，排队期间也重新检查最后一条的静默时间；生成期间的后续消息再合批，不逐条排满模型回合。原始消息保留作者、真实 QQ 时间、引用、@、图片及消息 ID；同秒保持接收顺序，不按随机 ID 排序、不按角色分组。多人明确点名的独立请求分开回合；同人连续短句是否属于同一请求由完整时间线中的 Agent 判断。请求尚在收集/生成或 WAIT 时，请求者没 @ 的补充也能承接；其他群友的背景插话进入时间线，仍受原准入约束。

纯群表情包、QQ 表情和动画表情只记录背景上下文，不能单独创建 DSH 回合、恢复 WAIT 或调用心跳分类，也不会触发发送前语义复核。收集中的表情可附带在原批，生成中到来的表情保留到下一条有效输入；每批最多附带 8 条且给有效输入留位置，刷屏表情不能强制提前派发或堵住短消息。有 @、引用或实际文字的表情消息仍走正常准入，私聊和普通图片策略保留。批内背景表情不附图片字节；明确要求看表情时可取最近的同作者目标，其他对象可用引用指定。

`floorManagementEnabled=true` 时，模型需要等待补充可只输出 `[WAIT]`，需要退避可输出 `[SKIP]`。WAIT 按请求者保留输入至 `floorWaitMs=30000`，只由对应请求者的非被动消息恢复判断；多个请求者各自等待、各自到期，其他成员的新请求不覆盖等待内容。到期不自动催问、不自动发言。心跳在输入待处理或 WAIT 时退避。输入缓冲、WAIT、DSH 回合所有权和投递计划写入共享 SQLite，重载后按已认领输入恢复，避免重新提交未知结果的工具回合。`inputDebounceMs: 0` 关闭收集延迟，`floorManagementEnabled: false` 关闭发言复核；唤醒仍只由 `activity.mjs` 的成功新发送刷新。

生成后以及每个待发气泡/表情派发前复核最新消息，候选只包含剩余未发正文。明确请求者取消/撤回会结束待发内容；答复、纠错、确认和结果不因换话题而取消。更新必须指向原请求者实际修改原要求的消息，重新判断只合并这些证据对应的输入，独立新问题不合并；丢弃必须标明纯闲聊、确已过时及具体新消息证据，其他人的互动不能否决直接请求。仅当时间线变化且有实质内容时，用当前模型作一次有完整上下文和候选正文的轻量复核，超时 4 秒、坏 JSON 或缺少证据回退保守规则；回退只识别明确取消/撤回与明确修改，不按同作者又发言或多人数量丢答复。同版本同候选复用判断；无变化、纯背景表情/确认及工具结果无需额外分类。语义分类仍可能出错，需自然实聊观察。工具回合的结果保留交付，普通补充不会重跑工具；明确取消后不继续文件写入/发送。已成功气泡保留原回执，尚未派发的过时内容以 `floor:<原因>` 结束，UNKNOWN/EXECUTING 仍需人工核对。

`qq_say`、群/私聊文字及图片/表情工具共用 SQLite 来源复核，桥接回合必须带本轮 `source_ref`，不能换工具绕过。跳过返回 `SKIPPED`，不记发言、不刷新唤醒、不占图库冷却；收藏表情保留结构化回执。在线 `replyPolicy.floorMode=request-batches-and-reply-value-recheck`、`inputBatches`、`lastFloorDecision` 可查行为；后者包含 value/basis/evidence 与 fallback，解释为什么保留、修订或丢弃。stats 保留 `inputBatches/inputsCoalesced/floorWaits/floorDeclined/floorRechecks/floorRecheckFallbacks`。真实 QQ 不发合成验证消息。

时间线修复：自己的成功发言记录实际回执时间，旧 self_message 缺少时间时按事件 created_at 恢复，已被旧重载污染的窗口也可纠正。QQ 历史回读保留协议时间，不被本地错误时间反向覆盖；同秒消息保持原顺序，不按随机消息 ID 排序。旧 Session 中可能已积累错误时间线，新架构签名会换新 Session 并保留修复后的窗口与记忆。

**心跳插话**按数量或时间触发，再判断是否需要发言：

```
睡眠时群里没 @ 它 / 没叫名字的消息 → 塞进缓冲（不推理，几乎零成本）
每群未读达到 heartbeatUnreadThreshold（默认 6 条），或有未读且等待时间到期：
  ① 数量与时间二选一：达到 6 条立即判断，不被时间等待拦住
  ② 一次便宜的"该不该插话"判断（一小段 prompt，只要一行 JSON）
  ③ 判定该插 → 才走完整 Agent 回合，真的开口
  ④ 无论说话还是旁听，本批标为已读；新到的消息继续计数
```

heartbeatMs（当前 10 分钟）用于恢复扫描。插件重载或重新开启托管时也会立即检查已有未读；无需等待群聊静默或下一条消息。

> 当前 `heartbeatProvider` / `heartbeatModel` 留空，所以第 ② 步用的是和主对话
> **同一个模型**（`a6api/deepseek-v4.1-flash`），不是更便宜的模型。
> 想真正省钱可以在这里指定一个便宜模型。

数量触发每次只消费最早的 6 条，移出未读缓冲并在 SQLite 标为已读，内容仍保留为聊天上下文。判断期间到达的消息属于下一批，不会一起清空。模型判断失败保留未读并延后重试；正常拒绝插话则消费本批。时间触发最多消费 6 条，有 1～5 条也能判断，没有未读时不重复调用。

`heartbeatCooldownMs` 现在是未读不足 6 条时的等待周期（desktop 为 5 分钟），计时起点取最近成功发言与最近完成心跳判断的较晚者；都没有时从首条未读计时。判断完成但没发言也开启新周期，防止冷却到期后每条新消息都触发判断。该判断时间单独持久化，不更新发言时间或 60 秒唤醒窗口。`heartbeatCooldownMs: 0` 关闭时间触发，保留数量触发。

### 2. 记得住人

长期记忆**按 QQ 号**存（不是按群号），所以同一个人在群里、私聊里说的话汇进同一份记忆，
换个地方也认识你。默认由聊天主模型通过 `qq_memory` 主动维护明确记忆、个人资料和
主观印象；后台提炼已准入聊天原文中的事实作为补充。明确要求记住的信息当轮保存，
保留日期/时期与有效范围，只有 SQLite 提交成功的回执才能确认已记住。

单份超过 `memoryMaxEntries`（20 条）时，最旧的几条会被模型摘要成一句挪进
「早期（已摘要）」，不会无限膨胀。

每个 QQ 号的可见入口是 `memory/<QQ>.md`：`## 手工记忆` 可直接编辑，
`## 主模型记忆` 从共享 SQLite 投影，区分明确记忆/个人资料/主观印象；
`## 自动记忆（桥接维护）` 由桥接同步并标注来源。同一属性可修正，重复事实合并来源；
来源、撤回和纠错所需的内部元数据保存在同目录 `.facts/`，不再作为另一份需要人工维护的记忆正文。
会话「长期约定」是**另一个面**：只有后台提炼器能写它，`qq_memory` 是逐人分槽、没有会话作用域，
所以那份内容没有人能人工纠正。desktop 已把它整面关掉（`conversationMemoryMaxChars: 0`：
既不注入也不再提炼，已存记录只读保留，`#debug memory` 仍可查）。要恢复该面，把值改回正数；
要真正长期保留群级约定，正确做法是给记忆工具加会话作用域后手写，而不是继续自动提炼。
旧标记模式可用 `memoryAutoExtract: false` 开启，但它会连人物面一起退回标记写法。

> QQ 撤回通知会失效对应来源，无剩余来源的事实不再注入。明确要求忘记某属性时也可失效。
> 旧文档没有可核对来源，无法自动可靠地重分配旧错误记录；模型提炼的语义准确性仍需观察。
>
> 详细机制、文档格式和"选择性记忆"的副作用见下面[记忆与上下文](#记忆与上下文)。

### 3. 看得见图（但有节制）

默认 `lazy`：已准入回合中的普通图片直接读，正文带图也读，不要求命中固定关键词。
清醒期间单独补发普通图片可进入回复回合；群聊纯表情包继续作为背景缓存，不因清醒窗口单独启动回合，也不自动读图。
私聊发图与引用图片仍默认读取。后续要求读上文图片时，按有界窗口找最近普通图片，避免被后来的表情刷屏挤掉。

> 完整策略、触发词和图片幻觉过滤器见下面[图片](#图片)。

### 4. 顺手能干活（但工具是**受限**的）

QQ 会话跑的是一个完整 DSH Agent，所以它能用 preset 给它的工具。当前挂的是
**`qq-hosted`** 预设，刻意砍掉了 shell 和大批管理类工具：

| 工具组 | 能干什么 |
|---|---|
| `mcp__qq__*` | QQ 聊天工具及会话工作区/文件发送 |
| `qq_workspace` / `qq_send_file` | 在当前群或私聊独立目录里读写源码、打包 ZIP，再把文件发回当前会话 |
| `create_word_document` / `create_pdf` | 直接生成 .docx / .pdf（profile 级 document-editor MCP），产物落进本会话工作区再发回 |
| `tool-web` | 按问题需要搜索网页、抓取资料，按实际来源回答 |
| `tool-ask-user` | 需要人拍板时问你 |

**砍掉的**：`tool-pwsh` / `tool-bash`（shell）、`workflow`、`plugin_manager`、
`mcp-rars`、`subagent*`、`plan-mode`、`compaction`、
`tool-goal` / `tool-todo` / `tool-skill`，以及 document-editor 里**能打开任意路径**的那批
（`read_*` / `modify_*` / `edit_pdf` / `verify_document`）和 Excel / PPT 工具。

每个 QQ 群/私聊使用独立目录：`%USERPROFILE%\.dsh\qq-workspaces\group-<群号>` 或 `user-<QQ号>`。`qq_workspace` 只接受工作区内相对路径，支持列文件、读写 UTF-8 文本和 ZIP 打包；最多 200 个文件/50 MiB，单文件 20 MiB。`qq_send_file` 只发送当前会话目录里的普通文件。QQ 预设没有通用文件工具或程序执行工具，小游戏源码可作为 HTML 或 ZIP 发回；要试玩 HTML 需在本机浏览器打开。

文件工具直接使用当前 `conversation` / `source_ref` 和 QQ 会话工作区；`qq_say` 只用于需要即时告知对方的开工或阶段进度，不再作为文件读写、打包或发送的前置条件。文件仍校验来源有效期、会话归属、相对路径、链接/硬链接和能力位；`read/list`、写入、打包、发送都只触及当前群或私聊目录。在线状态的 `workspace.progressPolicy` 为 `source-and-conversation-workspace`。

要交 Word / PDF 时不用自己拼二进制：`create_word_document` / `create_pdf` 直接生成 `.docx` / `.pdf`。这两个是 document-editor MCP（独立进程，cwd 不是会话工作区）的工具，`output_path` **只认绝对路径**，所以每轮提示词都会摊开本会话工作区的绝对路径（`【工作区绝对路径】` 一行）；产物必须落在该群或私聊目录里，随后可直接用 `qq_send_file` 发送。

只放开了"写"这一侧。`read_word_document` / `read_pdf` / `modify_word_document` / `modify_*` / `edit_pdf` / `verify_document` 都能打开**任意绝对路径**的文档 —— 那等于把群消息变成"读、改操作者机器上任何 docx/pdf"的入口，所以留在 tool-scope 的过滤名单里；Excel / PPT 只是当前没给。要增减就改 [`lib/agent/tool-sets.mjs`](lib/agent/tool-sets.mjs) 的 `DOCUMENT_TOOLS`：`tool-scope` 与 `tools/audit-prompt-cost.mjs` 共用这份名单，不会两边漂移。

> 这套限制是**两件事一起解决**的：既省 token（工具 schema 从 ~31.6k 降到 ~10k 量级），
> 又消除了"群里的人能间接使唤你的 shell"这个隐患。详见 §14。

群内成员仍可要求 Agent 在该群共享工作区里创建、修改和发送程序文件；群白名单仍通过 `groups` 管理。工作区限制模型能接触的文件范围，不提供执行代码的能力。

文件属于 QQ 会话工作区，独立于任务、DSH Session 和创建文件时的来源编号。同群/同私聊新回合使用自己的有效 `source_ref` 即可读取旧文件并继续修改、打包或发送；旧来源过期不删除文件，其他群/私聊仍隔离。任务路由仍只决定模型上下文和执行归属，不再改变文件目录或文件工具可见范围。

### 5. 它能主动发的 QQ 动作（`mcp__qq__*`）

| 工具 | 用途 |
|---|---|
| `qq_status` | 查链路 + 显示当前生效的授权、配额、图库占用 |
| `qq_get_group_list` / `qq_get_friend_list` / `qq_get_group_member_list` | 查群、好友、群成员 |
| `qq_send_group_msg` / `qq_send_private_msg` | 发文字、内置表情、图片、@ 某人 |
| `qq_list_stickers` / `qq_send_sticker` | 从**本机表情包仓库**（`stickers/`）挑图发。⚠️ 该目录当前是空的，这条路现在发不出东西 |
| `qq_list_custom_faces` / `qq_custom_face_sheet` / `qq_view_custom_face` / `qq_send_custom_face` | 读**账号收藏表情**（真正在用的那条链路）；`qq_custom_face_sheet` 把上百张拼成一张带编号的总览图，**一眼看全、只算一张图的成本** |
| `qq_send_mface` | 发 QQ 原生动画表情（收藏表情只能拿到静态首帧，要动图得走这个） |
| `qq_collect_sticker` / `qq_list_library_stickers` / `qq_view_library_sticker` / `qq_send_library_sticker` | 内容寻址图库：收藏时记下"这张是什么情绪、什么时候用"，之后按情绪挑 |
| `qq_reliability_status` | 查发送回执和**结果未知、需要人工核对**的发送 |
| `qq_delete_msg` | 撤回自己发的消息 |
| `qq_poke` | **戳一戳**某人（群里 / 私聊） |
| `qq_react` / `qq_list_reactions` | **表情回应**：给消息加/撤小表情、看谁点了赞 |
| `qq_group_info` | **群资料**：公告 / 精华 / 群文件目录 / **群历史消息** / 群信息 |
| `qq_list_add_requests` | 看**待处理的加好友 / 入群申请**（只读，`read_requests` 权限） |
| `qq_handle_add_request` | 同意 / 拒绝申请（`handle_request` 权限，**默认不授予**） |
| `qq_manage_group` | **群管理**：禁言 / 解除禁言 / 改群名片 / 改群名 / 发·删群公告（踢人走审批，见 §10）|
| `qq_request_kick` | **申请**踢人（登记成待办，**不立即执行**）|
| `qq_pending_actions` | 查看待审批的写操作 / 批准 / 拒绝 |
| `qq_search_history` | **只读 SQL** 查桥接缓存的聊天记录（`SELECT ... FROM messages`）|

共 **32 个工具**，分 **13 个能力位**：`send_text`、`send_file`、`send_image`、`send_sticker`、
`read_favorites`、`read_image`、`manage_group`、`set_profile`、`poke`、`read_requests`、
`handle_request`、`react`、`read_group_info`。

#### 只读 SQL 的沙箱（`qq_search_history`）

范围由**数据库授权强制**，不是靠检查 SQL 文本（字符串检查永远能被绕开）：

```
① readOnly 连接          → 写入被 SQLite 直接拒绝
② 物化 TEMP 表 messages  → 只装授权范围内的行，查询根本不碰原表
③ setAuthorizer          → 只放行 messages，连 sqlite_master 都拒
```

② 为什么不用视图：`authorizer` 会**顺着视图定义去读原表**，于是要么放行原表
（失去隔离），要么把合法查询也拒掉。物化之后查询根本不碰原表。

实测拦截效果：

| 尝试 | 结果 |
|---|---|
| `SELECT * FROM messages` | ✅ 通过 |
| `SELECT * FROM events` | 🛑 `access to events.id is prohibited` |
| `SELECT count(*) FROM (SELECT * FROM events)` | 🛑 被拒 |
| `SELECT name FROM sqlite_master` | 🛑 被拒 |
| `INSERT` / `DELETE` | 🛑 `readonly database` |
| `ATTACH DATABASE ...` | 🛑 被拒 |

**白名单为空时直接拒绝检索**（默认安全，不是默认放开）—— 否则没配白名单的人
等于把整个聊天库交给模型。

### 6. 表情回应（轻互动）

**表情回应**比发言轻得多 —— 看到有意思的话点个赞，不用冒泡：

| 工具 | 作用 |
|---|---|
| `qq_react` | 给某条消息加/撤一个小表情 |
| `qq_list_reactions` | 看某条消息收到了哪些回应（谁点的、什么表情、几个人）|

而且是**双向**的：别人给她自己的发言点了赞，桥接会记下来，作为上下文塞进
**下一轮真正要说话时**的提示词里。

> 为什么不为点赞单独唤醒一轮：那要付一次完整推理（15k~24k token），
> 为一个赞花这个钱不值。作为上下文带进下一轮才对。

> ⚠️ 重要区分：只记**她自己发过的消息**收到的赞（靠 `state.ownMessageIds`，
> 最近 200 条，从发送回执里收集）。别人之间互相点赞**不会**当成对她的反馈 ——
> 否则她会对着跟自己无关的话自作多情。这是个很难在真实群里发现、
> 但很出戏的 bug，所以专门有测试钉住。

#### 引用：只读不写

**别人发来的引用会被解析成上下文**（`resolveQuote`）—— 对方引用了哪条消息、
那条的内容是什么，都会进提示词。不然模型只看到一个 `[引用]` 占位符，
完全不知道对方在回复什么。

但**她主动发引用**的功能已经**整块去掉**了。原来做的是
`[引用]` 暗号 → OneBot 原生 `reply` 段，实测在群里会把 `[引用]`
这个标记本身当正文发出去（用户看到的就是孤零零一行「[引用]」），
而不是变成引用。既然不可靠，与其留着让人踩，不如去掉 ——
让模型用正常文字表达"我在回谁"就够了。

> `test/deliver.test.mjs` 里有三条**防回归**测试钉住这个事实：
> 一旦有人把引用发送加回来，它们会立刻变红。

### 7. 群资料按需读取

`qq_group_info` 五个 action，都是**按需拉取**，不会自动进上下文：

| action | 内容 |
|---|---|
| `notice` | 群公告（正文、发布者、时间） |
| `essence` | 群精华消息 |
| `files` | 群文件目录，可下钻 `folder_id` |
| `history` | **群历史消息** —— 靠 OneBot 回读 |
| `info` | 群名、人数 |

### 8. 上下文直接来自 QQ 历史（不是桥接自己的记录）

这一节解释一个**很容易踩的设计陷阱**。

桥接只知道自己**收到过**的消息。托管关着、插件正在重载、心跳缓冲被挤掉的时段，
群里真实发生的对话在桥接这边是空白的。实测抓到过：

```
（QQ 侧真实历史）           （桥接库里）
12:12:31  诶，你怎么死了      ← 一条都没有
12:12:48  遇到难回答的问题就不回答了
12:13:01  就挑自己喜欢的回答
```

后果很具体：有人问「我刚刚说啥了」，它答的是 **80 分钟前**的旧话，
因为窗口里只有那批旧消息。

**修法**：每轮开之前用 `get_group_msg_history` 回读，**直接替换**上下文窗口
（而不是让模型自己决定要不要去查工具 —— 它很少会想到，而且要多花一轮）。

为什么这样更准：

- 包含**未托管期间**的消息 —— 那正是桥接缺的部分
- 包含**她自己的话** —— SnowLuma 的 `reportSelfMessage` 是关的，
  桥接收不到自己发出的消息，只有回读才能看见
- 窗口立刻被最近 N 条真实对话填满，不依赖缓冲有没有攒够

| 配置 | 默认 | 说明 |
|---|---|---|
| `contextFromQQHistory` | `true` | 关掉就不回读，退回桥接自己的窗口 |
| `contextHistoryCount` | `25` | 回读多少条 |
| `contextHistoryCacheMs` | `20000` | 回读结果缓存多久（0 = 每轮都拉）|

回读失败**不影响发言**：catch 住、记一笔 `historyFetchFailed`、退回原窗口。

> 实测 SnowLuma 的可回读窗口有限：`message_seq` 往前翻只能拿到同一批，
> 大约 25 分钟 / 21 条。要更久远的历史需要另想办法（QQ 本地数据库）。

### 9. 加好友 / 入群申请会转发给你（但不会自动同意）

OneBot 的 `request` 类上报（`friend` / `group` 两种）原来被**整类丢弃**，
所以有人加好友、申请入群，你和它都不知道。

现在会：**落库 + 私聊通知你**。

| 配置 | 默认 | 说明 |
|---|---|---|
| `notifyUsers` | `[]` | 申请转发给哪些 QQ 号（**只走私聊**）|
| `autoHandleRequests` | `false` | 是否自动同意 |
| `autoHandleRequestAction` | `'approve'` | 自动处理时是同意还是拒绝 |

**为什么默认不自动同意**：同意加好友 = 让一个陌生人以后能给你的 Agent 发消息。
在白名单为空时尤其危险 —— 等于对全网开放。所以默认只转发给人，由人手动处理。

`qq-mcp` 侧也对应地分成了两个能力位：

| 能力位 | 工具 | 风险 |
|---|---|---|
| `read_requests` | `qq_list_add_requests` | 低 —— 只是"看一眼有哪些申请" |
| `handle_request` | `qq_handle_add_request` | **最高** —— 放陌生人进来 |

**故意分成两位**：合成一个的话，想看一眼申请就不得不把"能同意"也一起授出去。
当前 profile 里**没有授予 `handle_request`**，所以 Agent 没有任何工具能同意申请。

### 10. 群管理（禁言自由，踢人审批）

`qq_manage_group` 支持七个动作，但**踢人不再直接执行**：

| action | 作用 | 是否直接执行 |
|---|---|---|
| `ban` | 禁言（`duration` 秒，**必须 > 0**）| ✅ 直接执行 |
| `unban` | 解除禁言 | ✅ 直接执行 |
| `set_card` | 改群名片 | ✅ 直接执行 |
| `set_group_name` | 改群名 | ✅ 直接执行 |
| `notice_set` | 发群公告（`content`，可选 `pinned` / `confirm_required`）| ✅ 直接执行 |
| `notice_del` | 删群公告（`notice_id`，先用 `qq_group_info action=notice` 查）| ✅ 直接执行 |
| `kick` | 踢出 | ❌ **转成待审批** |

**群公告的两点特殊性**（所以除了每分钟的管理闸，还单加了一道 `QQ_QUOTA_NOTICE_PER_HOUR`，默认 6/小时）：

- 一发就**推给全群**、还带"确认收到"的弹窗 —— 比禁言一个人响得多；
- **QQ 没有"编辑已有公告"的接口**，改公告只能发新的（或先删旧的），
  误发的修复成本是"再响一次"。所以 `notice_set` 只接受纯文本（上限
  `QQ_MAX_NOTICE_CHARS`，默认 1000 字），图片暂不支持。
- 群主**和管理员都能发**（实测管理员身份 retcode 0、正文 UTF-8 原样落地）。

### 10.1 改完马上回读（2026-10-12）

**每个写动作都会当场回读一次**，返回里带「回读确认：…」的才是事实：

| 动作 | 回读方式 |
|---|---|
| `set_group_name` | `get_group_list {no_cache:true}` → 群名 |
| `set_card` | `get_group_member_info {no_cache:true}` → `card` |
| `ban` / `unban` | 同上 → `shut_up_timestamp`（>0 才是禁言中）|
| `notice_set` | `_get_group_notice` 列表里找同正文的那条 → 带回 `notice_id` |
| `notice_del` | 同上，确认该 `notice_id` 已不在列表 |
| `qq_pending_actions` 批准踢人 | `get_group_member_list {no_cache:true}`，确认人真的不在了 |
| `qq_set_profile`（昵称/签名）| `get_stranger_info {no_cache:true}`，并读 QQ 侧 `result/errMsg` |

没生效就**明说「⚠️ 没生效」**（并给出当前实际值），读接口失败则标注「没能回读核实」——
不允许把"提交成功"说成"已经改好"。`qq_group_info action=info` 的群名与 `qq_status`
的自己的昵称也都改成了实时读。

> ⚠️ **SnowLuma 的读接口有缓存，这是这个功能最大的坑**（2026-10-12 实测，同一时刻）：
>
> | 读法 | 结果 |
> |---|---|
> | `get_group_info`（旧实现用的）| 「杯满之灿幻庄」← 旧名 |
> | `get_group_list {no_cache:true}` | 「小鲸鱼的白饭食堂」← 真名 |
> | `get_login_info`（本地 selfInfo）| 「DeepSeek小鲸鱼」← 旧昵称 |
> | `get_stranger_info {no_cache:true}` | 「有穹的地方就有我」← 真昵称 |
>
> 所以**任何"确认改没改成功"的读都必须走 `no_cache`**；用缓存读会让她以为没改成，
> 或者拿旧值去跟群里说。成员表校验（`assertGroupMember`）同样加了 `no_cache`。

**为什么踢人要审批、禁言不用**：禁言可逆（解禁就行），踢人**不可逆** ——
人被踢出去，哪怕马上拉回来，体验也已经毁了。

踢人的流程：

```
qq_manage_group { action:'kick', group_id, user_id }
   → 不会执行，登记成一条待办（pending_actions 表），返回待办编号
qq_pending_actions                    → 列出所有待办
qq_pending_actions { action_id, approve:true }   → 这时才真的 set_group_kick
qq_pending_actions { action_id, approve:false }  → 拒绝，不动 QQ
```

防误操作的设计：

- **动手前先核对目标确实在这个群里**（查一遍成员表）。把不存在的 QQ 号丢给接口，
  不同 OneBot 实现行为不一致 —— 有的静默成功，有的报错，有的真把人踢了。
- **`ban` 的 `duration` 必须 > 0**。OneBot 里 `duration=0` 是"**解除**禁言"，
  而直觉会以为 0 是"永久" —— 这个坑直接把"禁言"变成"解禁"。要解禁用 `unban`。
- **同一个踢人请求不会重复登记**（按 kind+群+人 去重），模型反复请求也不会刷出一堆待办。
- **已经决议过的待办不会再执行一次**，防止重复踢人。

管理类动作**不走发送幂等那一套**：它们在 QQ 协议层本身就幂等（禁言两次结果一样），
硬套"结果未知就不许重试"只会让"禁言失败想重试"变难。但它们有**单独的持久配额**
`QQ_QUOTA_ADMIN_PER_MINUTE`（默认 6/分钟），因为误操作代价比发错一句话大。

> 当下没有可借用的现成实现：DSH 里只有 `dsh-client-ui-approval`
> （工具**越权**审批：等待审批 / 允许一次 / 拒绝），语义和"群管理动作审批"不同，
> 所以这套待办是自己实现的。

### 11. 被戳会真的醒过来

OneBot 有四类上报：`message`、`message_sent`、`notice`（戳一戳、输入状态、撤回、
群成员变动）、`request`（加好友、入群申请）。本插件原来**只处理 `message`**，
其余全丢 —— 所以别人戳它，它毫无反应。

现在戳一戳会**唤醒完整 Agent 回合**（不是回一句固定文案）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `pokeReplyEnabled` | `false` | 总开关。**第一道闸门**，关着就什么都不做 |
| `pokeReplyMode` | `'agent'` | `agent` = 唤醒完整回合；`text` = 回一句随机文案 |
| `pokeAgentMinIntervalMs` | `30000` | 两次唤醒之间至少隔多久（全局） |
| `pokeAgentPerSenderPerHour` | `6` | 每人每小时最多唤醒几次（落盘） |
| `pokeAgentSendPoke` | `true` | 唤醒时先自动回戳一下 |
| `pokeAgentGroupText` | `true` | 群里是否也回话；`false` = 只回戳 |

**实现方式**：把 poke **归一化成一条合成消息事件**，然后落进和"被 @ 到"
完全相同的那条流水线。所以：

- 带人设、带该说话人的记忆、带群上下文，能用全部工具；
- 气泡拆分、发送幂等、清醒期顺延这些行为天然一致 —— **没有第二套逻辑**，
  以后改主流程它自动跟上；
- 提示词里会明确写"这是戳一戳，不是消息"，否则它会去评论桥接造的
  「（对方戳了你一下）」这句话本身，很出戏。

> `text` 模式留着但已不是默认：实测它就是"快捷回复机器人"的感觉 ——
> 固定文案、不带记忆、不像被叫到。想省钱可以切回去。

两个语义坑记一下：

- **总开关和托管开关是两道独立的闸门**。`pokeReplyEnabled` 关着、或者托管
  （`agentEnabled`）关着，戳一戳都不会回 —— 关托管就是"别动"，回戳也算动。
- **私聊事件里 `user_id` 是机器人自己**，`target_id` 才是戳你的人。提示词里
  报错的发言人 QQ 会让它对着自己说话，所以归一化时单独带了 `__pokeSender`。

### 12. 你能随时查它在想什么

在 QQ **私聊**里发 `#debug persona` / `#debug prompt` / `#debug memory` / `#debug status`，
就能看到实际注入的人设、完整提示词、记忆文档和运行状态。

这些命令由桥接**直接处理、不经过模型**（所以群里的人套不出来），
而且**永远走私聊回复**——即使在群里发，结果也只发给你本人。

> 完整命令表、两条安全设计的理由和配置见下面[开发者调试命令](#开发者调试命令)。

### 13. 成本可控

桥接新注入使用有界窗口、每20次成功提交换新 Session、静态块首轮注入以及记忆/示范/时间线增量。实际输入仍包含本 Session 的历史和工具目录，随历史积累增长。

> 当前机制见下面[记忆与上下文](#记忆与上下文)，本轮可复核字符测量见 PROMPT_PLAN.md。

工具 schema 占较大固定开销，qq-hosted 过滤无关能力，并精简保留工具的说明；真实费用同时取决于历史、图片、缓存和模型。用 tools/audit-prompt-cost.mjs 只读核对实际请求目录与 usage。

#### 语气锚（`toneAnchor`）

静态块只注入一次，代价是人设离生成点越来越远。原来这里**硬编码**了一句
大肥鱼的味道锚，每轮都补在末尾 —— 结果是：改 persona.md 删掉那句**没用**，
因为真正生效的是代码里那份，两处来源必然对不上。

现在 `toneAnchor` 默认**空**：语气完全由 `persona.md` 单点决定。

| 想要的效果 | 做法 |
|---|---|
| 语气只由人设文件决定 | 什么都不用配（默认） |
| 觉得它"忘了自己是谁" | 配一句**短的** `toneAnchor`（它每轮都注入，长句很贵） |
| 彻底回到每轮注入完整人设 | `injectStaticOnce: false` |

### 14. QQ 专用预设（降本 + 提安全）

QQ 会话跑的是完整 DSH Agent，所以 profile 里的**全部工具**都会进它的每一轮 ——
包括 `pwsh`、`workflow`、`plugin_manager`、RARS、Office。群里聊天根本用不到这些，
而且它们既费 token 又是安全隐患。

`dsh-qq-preset` 这个独立 bundle 提供了一个工具受限的预设 `qq-hosted`：

```yaml
# profile 里的 qq-bridge
agentPreset: qq-hosted
```

**砍掉的**：`tool-pwsh` / `tool-bash`、`tool-jobs`、`workflow`、
`plugin_manager`、`mcp-rars`、`subagent*`、
`plan-mode`、`compaction`、`tool-goal` / `tool-todo` / `tool-skill` 等，
以及 document-editor 的读 / 改 / 校验工具与 Excel / PPT 工具。

**保留的**：`mcp-qq`（`QQ_TOOLSET=chat,admin`：聊天 + 工作区 + **群管理 / 改自己资料 / 申请**，共 28 个 QQ 工具）、
`tool-web`、`tool-ask-user`、`tool-result-pruner`，
外加 document-editor 的 `create_word_document` / `create_pdf`（写 Word / PDF；名单在
[`lib/agent/tool-sets.mjs`](lib/agent/tool-sets.mjs) 的 `DOCUMENT_TOOLS`）。

> 2026-10-12：admin 那一档（`qq_manage_group` / `qq_set_profile` / `qq_request_kick` /
> `qq_pending_actions` / `qq_delete_msg` / 申请读与处理）**也给了 QQ 会话**，
> 每轮多约 1.5k token schema。之前只有 chat 集时，群友让她改昵称、改群名，
> 她手上没工具，只能回"改不了啊 我又没权限"。
> 名单仍是单一事实来源：`CHAT_TOOLS + ADMIN_TOOLS = QQ_SESSION_TOOLS`，
> `tool-scope` 白名单和 MCP 的 `QQ_TOOLSET` 都读它。
> **可见 ≠ 可执行**：能不能动手仍由 `QQ_CAPABILITIES` 决定（例如 `handle_request` 依旧不授，
> 所以 `qq_handle_add_request` 可见但调用会被拒）。

实测效果：

| 指标 | 换之前 | 换之后 |
|---|---|---|
| system 文本 | 6348 字符 ≈3734 token | 4618 字符 ≈2716 token（**−27%**） |
| 首轮输入（含历史） | 24692 | 20102（**−4590**） |

两个数的口径不同：工具 schema 的 JSON **不在 system 文本里**（单独发），
所以 −27% 只是下限；首轮那个 −4590 是真实计费差，但两次会话历史不同，也是下界。

> ⚠️ 这个预设**不含 shell**。QQ 会话原来是能跑命令、编译、用 RARS 和 Office 的，
> 现在不能了。要放开某个能力，在 [dsh-qq-preset 的 patch](D:\Code\dsh-qq-preset\cordis.patch.yml)
> 里往 `plugins` 加回对应行即可。
>
> 例外是**写 Word / PDF**：那两个工具来自 profile 级（全局）的 document-editor MCP，
> 预设少挂插件并不能屏蔽它，所以是靠 `tool-scope` 白名单**放行**的 ——
> 加工具要改 `lib/agent/tool-sets.mjs`，不是改 preset 的 `plugins`。
>
> 另：**旧会话不会追溯换预设**。DSH 的设计是"Agen 保留已用的组合"，
> 所以正在跑的那个会话还是旧工具集，要等轮换或新会话才生效。

### 15. 开发时的坑：HMR 会监视这个目录

profile 里有一段配置，把**整个插件源码目录**加进了 DSH 的 HMR 监视，
目的是"改完代码不用重启 DSH"：

```yaml
- id: hmr
  root: [ '.', 'D:/Code/dsh-qq-bridge' ]
```

`dsh-hmr` 用 chokidar 监视这个 root，而它默认的 `ignored` 只有
`**/node_modules`、`**/.*`、`cache`、`data` —— **除此之外，这个目录里的任何
文件写入都会触发插件重载**。

> **实测结论（诚实版）**：
>
> 崩溃的时间点和"在这个目录里写文件"高度重合 —— 曾经把测试输出重定向到
> 项目根的 `t-out.txt`，一套测试 6 个子进程就是 6 次写入、6 次重载，
> 排查了很久，一度误以为是对话窗口太长导致的。
>
> **但机制没有最终证实**：查过 `test/*` 和 `tools/*`，所有写操作其实都指向
> `os.tmpdir()`，没有一处写项目目录；而**跑测试套件时崩溃仍然复现**。
> 所以"写文件触发 HMR"只是**强相关，不是已证实的因果**。
>
> 本轮已在监视目录外完成全量离线回归。使用 `node tools/run-tests.mjs`，
> 它自动建立系统临时副本并逐个执行测试，测试输出不写回项目。
> 这能隔离文件监视，但不能据此判定历史崩溃的根因。

几条已经确定的：

- 改 `lib/index.js` 本身会触发重载 —— 那**正是这个配置的目的**，让代码改动生效；
- **不要用 PowerShell 的 `Set-Content` / `Add-Content` 改这些文件**：
  Windows PowerShell 按 ANSI 读，会把中文全变成乱码（这个踩过，`test/reliability.test.mjs` 被毁过一次）；
- 临时文件、备份（`*.bak`、`*.verifybak`）别留在项目里 —— 它们同样在监视范围内。
- 对外入口保留 `createRequire`，内部使用静态 `import`；实际 Cordis 加载/卸载/重新加载已离线验证。
  真实 DSH HMR 对子模块缓存的失效行为尚未验证，不保证单改任意子模块都能立即生效。

### 16. 当前实际配置速查

| 项 | 当前值 |
|---|---|
| 托管开关 | **开**（且**持久化** —— 存进 `runtime_state` 表，重载后保持）|
| 机器人 QQ | `3667925015` |
| 群聊触发 | 只有被 @ 或叫 `deepseek` / `大肥鱼` |
| 群/人白名单 | **空 = 不限制**（建议填！） |
| QQ 专用模型 | `a6api/deepseek-v4.1-flash`（providers 里已显式声明 `input: [text, image]`，识图仍可用） |
| 思考等级 | **`off`**（群聊要的是"快嘴回一句"，不是深度推理；也省输出 token）|
| 工作目录 | `D:\作业\计算机组成原理` |
| 心跳 | 开，每群第 6 条未读或等待 5 分钟到期时判断；10 分钟兜底扫描 |
| 上下文来源 | **QQ 历史直读**（`contextFromQQHistory: true`，25 条，20 秒缓存）|
| 上下文条数 | 别人的 10 条 + 自己的 15 条，**从新到旧**，紧贴当前消息上方 |
| 记忆 | 开，20 条上限，按 QQ 号一份 |
| 调试命令 | 仅 `1056612947` |
| 戳一戳回应 | 开，`agent` 模式（唤醒完整回合），全局间隔 30s，每人 6 次/小时 |
| 申请通知 | 开，发给 `1056612947` |
| 申请自动处理 | **关**（只转发给人，绝不自动同意） |
| 踢人 | **必须人批准**（走 `pending_actions` 待办）|
| 引用发送 | **已移除**（原来会把 `[引用]` 当正文发出去）|
| qq-mcp 能力位 | `send_text, send_sticker, read_favorites, read_image, manage_group, poke, read_requests, react, read_group_info` —— **不含 `handle_request`** |
| Agent 预设 | `qq-hosted`（工具受限，来自 `dsh-qq-preset` bundle） |
| 语气锚 | 空（语气只由 `persona.md` 决定） |

## 托管控制

托管要**同时**满足三个条件才真正生效，缺一个对方发消息都没人回：

| 层 | 含义 |
|---|---|
| DSH 进程在跑 | 插件、会话、LLM 都在 DSH 里 |
| SnowLuma 已接入 QQ | 没有它，QQ 的消息根本到不了 DSH |
| 托管开关为开 | 本插件的软开关 |

**软开关**让你不必碰 QQ 就能暂停/恢复 Agent：

```powershell
# 读状态
curl.exe -sS http://127.0.0.1:19387/qq/onebot/control

# 关掉（账号仍在线，只是不回复）
curl.exe -sS -X POST http://127.0.0.1:19387/qq/onebot/control `
  -H "Content-Type: application/json" --data-binary '{"enabled":false}'
```

关掉时插件仍然**静默接受**上报并回 204，所以 SnowLuma 不会因为连接失败而报错或重推。

登录与启动：`start-qq-mcp.bat` 默认使用 SnowLuma，自动启动接入端并按已登录机器人号选择注入，不强杀 QQ；`restart` 只重置桥接托管。DSH/桥接与 MCP stdio 进程仍由 DSH 管理。普通 QQ 的扫码/账号登录需用户完成。判断就绪必须确认 OneBot 账号正确、`online=true`，并拒绝 `good=false`，端口打开不等于在线。

账号凭据由 QQ 管理；若 QQ 返回 KickedOffLine 或登录凭据失效，仍需在 QQ/SnowLuma 登录界面完成验证。启动器不会因鉴权错误、已有实例尚未就绪或裸 QQ 冲突而自动结束客户端。

### 被踢下线是服务端行为，不是桥接故障

QQ 会主动把一次登录判为失效。SnowLuma 日志里的原文是：

```
[KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录
```

紧接着 2～4 秒 SnowLuma 就会"重启 Worker 以重新创建 QQ 登录服务"，本地会话随之销毁，
于是**只能人工扫码**。桥接这边原本完全看不到这件事 —— 表现就是"消息突然不来了"，
和"插件挂了"长得一模一样，只能事后去翻 SnowLuma 的启动日志。

所以插件带了一个**登录监视**（`loginWatchEnabled`，默认开）：定时只读一次
`get_status` 和 `get_login_info`，把状态迁移记下来，并在自检接口暴露成 `登录` 字段。
它**不会自动重登** —— 凭据由 QQ 管理，擅自重试只会加重风控；能做的只有"如实报告 + 等人扫码"。

| 配置 | 默认 | 作用 |
|---|---|---|
| `loginWatchEnabled` | `true` | 总开关。只读探测，不改账号、不发消息 |
| `loginWatchMs` | `60000` | 探测间隔；越密越准，代价是一次本地 HTTP 调用 |
| `loginWatchFailureThreshold` | `3` | 连续失败几次才记一次掉线（OneBot 明确回 `offline` 时**立即**记，不等阈值） |
| `loginWatchTimeoutMs` | `4000` | 单次探测超时；上限是间隔的一半，防止探测堆在一起 |
| `loginWatchHistoryLimit` | `10` | 自检里回显最近几次掉线；`0` = 全部 |
| `qqntDir` | `C:\Program Files\Tencent\QQNT` | 读"当前生效的 QQNT build"，用来核对"是不是版本一换就掉线" |
| `qqntDataDir` | `E:\QQFile\message\Tencent Files` | QQ 数据根，用来定位登录票据 |
| `loginAccountDir` | 空 | 直接指定账号数据目录；留空按 `<qqntDataDir>\<QQ号>` 拼 |
| `loginEnvCacheMs` | `300000` | 环境快照缓存；掉线时会强制重拍，不受缓存影响 |
| `loginAlertEnabled` | `true` | 掉线/恢复是否往盘上写一行告警 |
| `loginAlertFile` | `login-alerts.log` | 告警文件名（相对数据目录）或绝对路径 |

记录存在共享 SQLite 里：每次掉线的**起止时间、原因、不可用时长**，
会话名是合成的 `system:login`，`deliverable=0`（掉线不是待发送的消息）。
历史与计数活过插件重载；重载期间还开着的那次掉线，会在下次探到在线时补上不可用时长。

另有**落盘告警** `data/login-alerts.log`（JSONL，一行一次掉线/恢复）：账号掉线时
走 QQ 通知没有意义（收消息的入口就是它自己），而控制台日志会随进程重启散掉。

```powershell
# 只看掉线，不看恢复
Get-Content <stateDir>\data\login-alerts.log | Select-String '"kind":"drop"'
```

想看清全部细节（含每次掉线的时间线）见 LOGIN_KICK_ANALYSIS.md。

配套脚本 `start-qq-mcp.bat`：

```
start-qq-mcp.bat status   查看接入端、账号和桥接托管状态
start-qq-mcp.bat start    启动 SnowLuma 并开启托管
start-qq-mcp.bat stop     停止托管（账号保持在线）
start-qq-mcp.bat restart  重置桥接托管（不结束 QQ）
```

> ⚠️ `hosting.ps1` 必须以 **UTF-8 BOM** 保存。Windows PowerShell 5.1 对无 BOM
> 的脚本按 ANSI 读取，中文会全部乱码并导致语法错误。

## 记忆与上下文

这一节解决的是「会话历史线性增长」的问题。实测：36 轮之后每轮提示词已经涨到 ~6.1 万 token，
而且还在涨。现在通过轮换限制累积长度，单轮费用仍取决于 Session 历史、工具和图片：

```
每轮桥接提示词 = 固定角色与协议（首轮）+ 场景示范/记忆变化 + 相关任务 + 时间线增量（首轮完整）+ 当前来源与消息
真实模型输入 = DSH 系统与工具 + 本 Session 历史 + 本轮桥接提示词
```

### 三个关键机制

**① 滑动窗口 + Session 轮换**

桥接在每个 Session 首轮注入有界消息窗口；后续按消息 ID 和内容指纹仅补充新增/更新的背景及成功发送回执，引用消息附上原发送者记录。时间校准不触发重复注入，当前消息独立提供。稳定的「发言时机」和气泡格式规则只在 Session 首轮注入，DSH 的历史仍在一个 Session 内累积。每满 `rotateEveryTurns`
次成功提交就换一个全新 Session，以限制累积长度。持久化启用时，Session ID 和提交轮数
会跨插件重载恢复，同时恢复窗口与引用关系。窗口受 `windowTurns` 回合范围和消息条数
双重约束，默认别人最多 10 条、自己最多 15 条，不保证完整保留十次来回。

desktop profile 当前每20次成功提交轮换，记忆注入总预算1600字符。稳定记忆按 QQ 人物、
会话约定和经历分别保存指纹；群友轮流讲话不会触发全部旧记忆重发。某人的简版记忆首次
作为当前说话人使用时，会补充较完整版本；版本变化只更新对应块。预算不足的块整块延后，
不会标记为已注入；事实按完整行裁剪，避免截断否定或发送回执。Session 轮换重新注入有界
资料，跨重载保存指纹。旧指纹策略的 Session 因配置签名变化会在恢复时替换，QQ 窗口仍保留。

**② 按 QQ 号的长期记忆**

每个对话对象一份 Markdown 文档，放在 `memoryDir`：

```
D:\Code\dsh-qq-bridge\memory\
    1056612947.md      ← 天梦·幻
    100000002.md       ← 另一个群友
```

**关键：按 QQ 号而不是群号。** 同一个人在群里、私聊里说的话汇进同一份记忆，
所以它「换个地方也认识你」。

文档格式（人可读可改）：

```markdown
# 天梦·幻（QQ 1056612947）

首次接触：2026-10-09

## 记忆

- 2026-10-09 12:41 老板不吃香菜

## 早期（已摘要）
```

**③ 同一个角色的跨会话经历**

`v34-shared-experience` 新增共享 SQLite 事件账本，独立于各 QQ 窗口与 DSH Session。
她能在发信对象的窗口看到「谁的回合中，我向谁发了什么、是否成功」，在来源人物的私聊里
接回原始起因。切换窗口、Session 轮换和插件重载不会丢失这些记录。例如甲让她转告乙，
乙随后问起，可以取回甲的身份、转告内容与发送回执；其他私聊的起因原文不向乙注入。

每轮发布独立的 `source_ref`，发送工具原样填入；桥接也按已归属的 DSH turn/callId
补记来源，兼容未提供编号的旧工具。没有来源证据时明确标为「来源未记录」，不猜是谁委托。
工具和普通最终正文均按真实发送结果记账；失败、EXECUTING、UNKNOWN 不表示完成，
dry-run 和幂等重放不创建新经历、不刷新发言窗口。工具发送也写回目标会话的历史。
消息撤回会屏蔽对应来源及出站消息的事件，来源编号被撤回或过期后不能再绑定新工具调用。

token 成本控制：这层不增加独立模型请求；重要经历和明确待办复用已有自动提炼批次。
本地先按当前会话、发送目标和当前人物筛选最近最多 100 个候选，再结合关键词、未定结果
排序。默认最多注入 **4 条、整个事件区块最多 900 个字符**（字符预算，不是精确 token 数）；
当前窗口内的普通成功发言不重复注入，沿用 `memoryInjectOnChange`，无变化时不重发记忆。
群聊只取本群涉及的经历，避免仅因某个人在群里就把无关私聊带入；当前白名单仍约束检索。

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `episodicMemoryEnabled` | `true` | 事件记忆开关，需同时开启 `memoryEnabled` 和可用持久化 |
| `episodeInjectLimit` | `4` | 每轮最多事件数（0～10，0 关闭注入） |
| `episodeInjectMaxChars` | `900` | 事件区块字符上限（0～4000，0 关闭注入） |

状态接口的 `episodicMemory` 可核对实际可用性、记录数与注入预算。这一版从上线后累积，
不会自动扫描旧会话或补造过去的委托；保存的待办是有来源的经历，尚不自动定时催办或
推断对方已收到/已答应，后续结果仍以原始消息和回执为准。无 SQLite 时沿用原有人物记忆。

### 主模型管理记忆（`v63-agent-owned-memory`）

桥接注册原生 `qq_memory`，QQ 预设放行该工具，不需要重启 MCP。`read` 返回当前发送者
完整文档、属性槽和版本；`upsert` 新增或修订；`forget` 失效属性槽；`history` 查询最近
30 个版本，`restore` 将指定旧版本恢复为新版本。新槽 `version=0`，修订必须携带 read
取得的版本；过时写入拒绝，同一来源相同操作重放返回原回执。版本保存在共享 SQLite
`bridge_agent_memories`，事务提交后返回 SAVED/FORGOTTEN；Markdown 投影失败仍承认已提交，
下次读取重建。旧手工备注继续保留，不自动改写。

每次工具调用必须带本轮 `source_ref`，按真实 DSH Session 核对归属，只能管理当前发送者；
任务 Session 使用已有执行来源验证，关闭/过期/撤回来源不能写。原文证据必须来自该
发送者本轮消息，日期/时期保留到 `period`，印象明确标注为主观判断。此校验保证来源
归属，语义是否准确、模型是否主动调用仍需自然实聊观察。后台同槽事实不会覆盖主模型
记忆，也不会把已忘记的同槽事实重新注入；不同槽的语义重复仍由模型核对合并。

长人物文档按完整条目裁剪，明确记忆优先，再考虑当前问题相关性、资料与印象；来源
元数据从节选剔除，完整内容用 read 查询。新旧标题都可读取，归档不能把前面的资料挤掉；
问题改变导致节选变化时会重新注入。原有 900/350 字符人物预算和总预算保留。
在线 `memoryPolicy` 可查主模型所有权、工具可用性、后台补充和版本策略，
以及 `conversationFacts`（`injected`/`extracted`/`maxChars`/`archive`）；debug.memory
同步暴露 `owner/toolAvailable`。

### 后台补充提炼

`memoryAutoExtract` 默认开启。主模型提示使用上述工具；后台提炼器从聊天原文补充有证据的稳定自述、关系、项目和约定。
每个会话最多保留 40 条待处理消息，一批处理最多 20 条，默认攒满 6 条触发；同一会话调用
至少间隔 30 秒。低流量会话由定时器检查，默认超时 15 秒，失败保留批次待重试。
它会增加独立模型请求，可通过 `memoryProvider` / `memoryModel` 指定模型，否则沿用 QQ 模型或默认模型。

个人事实必须属于来源发送者，群约定按会话保存；每条保留 QQ、消息 ID 和原文证据。
会话「长期约定」面可通过 `conversationMemoryMaxChars: 0` 整体关闭：此时 system prompt 的 scope
枚举和候选校验都不再包含 `conversation`，提炼器连"去提炼约定"都不再被要求，存档记录只读保留。
它只有后台提炼器一个写入方（`qq_memory` 没有会话作用域），所以没人能人工纠正 —— 这正是 desktop
关掉它的原因，而不是"自动记忆效果不好"这一类主观判断。
去重、同属性修正与来源撤回由存储层处理。持久化开启时，未完成的批次跨插件重载恢复。

### 旧标记模式（可选）

设置 `memoryAutoExtract: false` 后沿用以下方式：

提示词里告诉它在值得记的时候带一行标记：

```
[记住:老板说他下周三要考我汇编]
```

桥接摘出这一行、写进对应 QQ 号的文档、并把标记从回复里去掉（不会发出去）。
超过 `memoryMaxEntries` 条时，最旧的若干条会被模型摘要成一句，挪进「早期（已摘要）」。

**副作用要知道**：它是「选择性记忆」——没被标记的事它不会记得。所以它可能重复问同一件事。

### 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `memoryEnabled` | `true` | 总开关。关掉就退回「全靠 DSH 会话历史」的旧行为 |
| `memoryDir` | `D:\Code\dsh-qq-bridge\memory` | 记忆文档目录 |
| `memoryMaxEntries` | `20` | 单文档条数上限，超了自动摘要 |
| `memoryInjectRecent` | `2` | 群聊时额外注入几个最近参与者的记忆 |
| `memoryInjectMaxChars` | `1800` | 每轮记忆区块总字符预算；当前说话人优先，0 表示不设总预算 |
| `conversationMemoryMaxChars` | `450` | 会话「长期约定」面：字符限额；`0` = 整面关闭（不注入也不提炼，存档只读保留）。desktop profile 当前为 0 |
| `windowTurns` | `10` | 保留最近 Agent 回合对应的消息，同时受双方消息条数上限约束；desktop profile 当前为 6 |
| `rotateEveryTurns` | `10` | 每多少轮换一个新 Session；desktop profile 当前为 3，以限制 DSH 历史峰值 |
| `rememberMarker` | `[记住:` | 写记忆的标记前缀 |

## 两个必须知道的坑

1. **订阅要早于提交。** `follow()` 的首帧是 `snapshot`，带当前 `cursor`。若先 `prompt()` 再订阅，那一轮事件可能已经跑完，然后永久等待。
2. **`prompt(request, signal)` 的第二个参数是必需的。** 漏掉会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。

## 配置

在 profile 的 `cordis.patch.yml` 里按条目 id `qq-bridge` 覆盖：

| 字段 | 默认 | 说明 |
|---|---|---|
| `path` | `/qq/onebot` | 接收上报的路由路径 |
| `token` | 空 | 非空则校验 `Authorization: Bearer <token>` |
| `onebotHttp` | `http://127.0.0.1:3000` | SnowLuma 的 OneBot HTTP 地址 |
| `onebotToken` | 空 | 与 SnowLuma HTTP server 的 `accessToken` 一致 |
| `cwd` | 空 | 旧数据目录基准；会话 cwd 由独立工作区管理 |
| `workspaceRoot` | 空 | 工作区根目录；默认用户目录下 .dsh/qq-workspaces，按群/私聊隔离 |
| `agentPreset` | 空 | 指定 QQ 会话使用的 Agent 预设 |
| `groups` | `[]` | 群白名单，空=不限制 |
| `users` | `[]` | 用户白名单，空=不限制 |
| `groupEnabled` / `privateEnabled` | `true` | 开关 |
| `groupTrigger` | `at` | `at` 被@才回 / `prefix` 前缀 / `all` 所有消息 |
| `groupPrefix` | 空 | `groupTrigger=prefix` 时必需 |
| `selfIds` | `[]` | 机器人 QQ 号；留空则用事件里的 `self_id` |
| `resolveAtNames` | `true` | 把 @ 渲染成群昵称（要一次 `get_group_member_list`）；关掉只会退化成 `@123456`，@ 本身不会消失 |
| `groupMemberCacheMs` | `600000` | 群成员昵称缓存时长 |
| `replyTimeoutMs` | `180000` | 单轮等待上限 |
| `maxReplyChars` | `1500` | 回复截断长度 |
| `replyToGroups` | `true` | 是否在群里回 |
| `atMentionEnabled` | `true` | 让她能自己 @ 人：正文里写 `[@昵称]`（优先）或 `[@:QQ号]` 即转为真的 at 段；关掉只是不发 at，标记照样会被摘干净 |
| `atMentionMax` | `3` | 一个气泡最多 @ 几个人；超出的标记丢弃（防"一句话 @ 一屏人"）|
| `replyMaxSendAttempts` | `3` | 一条回复**明确发送失败**最多试几次，到上限转 `failed` 终态并放开该会话队列（可在 `status.replyDelivery.failed` 查）；`0` = 无限重试（旧行为）。结果未知（UNKNOWN）不受此限 |
| `replyRecoveryTimeoutMs` | `20000` | 恢复尝试的单轮超时。一个早已不存在的 DSH 会话重连注定失败，不该占满 `replyTimeoutMs`(180s) |
| `replyRecoveryMaxAgeMs` | `900000` | 超过这个时长仍无 outcome 的"进行中"执行视为不可能恢复，收敛成 `failed` 终态（否则它永久占着 `recovering`，让 task 永久 busy 并卡住 `pump`）。用执行自己的 `times.received` 判定，不用 `updated_at` |
| `replyStaleDeliveryMaxAgeMs` | `600000` | **迟到投递护栏**：`following`／`output` 这类还没有确认结果的行超龄一律不再恢复投递，直接转 `failed`。迟到的回复比不回复更糟——它答的是一个早已结束的话题（实测曾一次性把 14 条 3–4 天前的旧回复发进真实群）。`planned` 不受影响：它已有确认结果，可能正在合法等发送配额窗口 |
| `taskSweepIntervalMs` | `60000` | `taskScheduler.tick()` 里 `sweep()` 的节流间隔 |
| `taskReceiptsIntervalMs` | `15000` | `tick()` 里 `refreshReceipts()` 的节流间隔 |
| `routeSteerableWindowMs` | `600000` | 终态任务在多长时间内仍算"可被 steer"（保住"继续刚做完的那个"）。**它决定要不要为一条消息调路由模型**：实测 375 条非归档任务里只有 1 条可被 steer，所以绝大部分消息本来就不该付这 2.5 秒。设 `0` = 只有真有活干时才调 |

### 上下文来源与条数

群友和自己的发言按真实时间交错排列，再分别裁剪到 10/15 条。QQ 历史时间优先，
同秒保持历史返回顺序，不按随机消息 ID（含 SnowLuma 的 message_seq）排序。
每个气泡/表情发送成功立即记录时间，重载用原发送时间或数据库事件时间恢复；
旧窗口中被重载时刻污染的时间自动修正，下一轮 QQ 回读继续校准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `contextFromQQHistory` | `true` | **用 QQ 历史直读刷新窗口**（见 §8）|
| `contextHistoryCount` | `25` | 回读多少条 |
| `contextHistoryCacheMs` | `20000` | 回读结果缓存多久（0 = 每轮都拉）|
| `contextOthersMessages` | `10` | 注入几条**别人的**消息；desktop profile 当前为 6 |
| `contextOwnMessages` | `15` | 注入几条**自己的**回复；desktop profile 当前为 8 |
| `contextImagesOnRequest` | `2` | 对方明确要求看图时，上下文里最多附几张旧图 |
| `windowTurns` | `10` | 保留最近 Agent 回合对应的消息，同时受双方消息条数上限约束；desktop profile 当前为 6 |
| `rotateEveryTurns` | `10` | 每多少轮换一个新 Session；desktop profile 当前为 3，以限制 DSH 历史峰值 |
| `injectStaticOnce` | `true` | 人设/规则只在本窗口第一轮注入 |
| `injectWindowOnce` | `true` | Session 首轮完整窗口，后续按消息增量；false = 每轮完整窗口 |
| `memoryInjectOnChange` | `true` | 当前 Session 按人物/约定/经历分别去重；首次或版本变化时注入相应块 |
| `rotateAfterImage` | `false` | 显式打开后，附图会导致下一轮提前创建 Session |
| `toneAnchor` | 空 | 每轮末尾补的一句短语气锚（默认空，语气只由 `persona.md` 决定）|

desktop profile 把 `stickerCatalogLimit` 设为 `4`（源码默认也是 4）：每轮动态注入时，
从真实目录无放回随机抽 4 条，放在当前消息前；目录不足 4 条时展示全部，每轮独立抽样允许跨轮重复，更大目录按工具查询。QQ 托管使用 `qq-hosted` 的
`QQ_TOOLSET=chat,admin`，向模型暴露聊天、表情、历史、可靠性工具，**以及群管理与
改自己资料/申请处理这一档**（2026-10-12 起；可写多个集合，用逗号分隔，写错集合名会
退回全量并打日志）。工具执行权限仍由 `QQ_CAPABILITIES` 单独控制 —— **可见 ≠ 可执行**。

`qq-hosted` 还挂载 `dsh-qq-bridge/tool-scope`，使用 DSH `tools.restrict` 按名字过滤
全局继承的工具（包括任意代码执行），并在 MCP 注册/重连时刷新。仅在预设里少挂插件并不能屏蔽 profile 的
RARS/Office 工具。过滤只作用于 QQ 预设；其他会话的全局工具保持可用。QQ 保留聊天、群管理、独立工作区工具、提问/网页查询工具，以及 document-editor 的写文档/PDF 两个工具（`DOCUMENT_TOOLS`）；通用文件与命令执行工具不提供。

只读诊断：`node tools/audit-prompt-cost.mjs <Session目录>` 显示实际请求工具数、schema
字符、每轮桥接文本长度和原始用量字段，不打印消息正文或凭据。`inputTokens` 在部分
缓存回执中仅表示未缓存输入，诊断同时列出 `totalTokens-outputTokens`，不要把缓存输入
遗漏后当作完整上下文。2026-10-11 14:01 的旧请求实际有 67 个工具、39650 字符 schema；
相同目录按新规则离线筛选为 27 个、16286 字符，约减少 59% 的 schema 字符。
这属于离线目录比较，实际 token 和费用需要上线后的自然消息回执确认。

状态接口新增 `contextPolicy`，显示实际轮换、窗口是否使用增量、记忆/表情预算和 `lastPrompt` 的文本字符、
记忆字符、是否首轮静态注入、实际注入/省略的窗口消息条数，便于区分配置未加载与模型输入中的历史累积。

### 每轮注入精简（v66）

发送与长任务顺序统一在一处：普通正文由桥接发送；长任务先单独 `qq_say` 等 `SUCCEEDED`，
再构思、写作或调用耗时工具，最后另交付新结果。文件路径、源码交付、回执/回读确认、
工具能力、@ 格式和共享历史边界仍每轮保留短提醒；首轮仅额外给 `qq_say` 参数示例，
不再重复整套进度教程。戳一戳/心跳使用各自的回应规则，不叠加普通未 @ 群消息的搭话提示。

执行清单只向模型展示任务主人、标题、状态、结果及投递事实；空进度、空完成依据和内部执行 ID 不重复注入。
完整 ID、时间、rpcId/inbox 归属和恢复事实仍在存储及 `facts()` 中保留；清单不授权当前回合重新执行其他任务。

同一素材离线重建：戳一戳样本 **5296 → 3925 字符（−26%）**，普通聊天 **2388 → 1525（−36%）**，
文件任务 **2403 → 1540（−36%）**，执行清单 **1001 → 676（−32%）**。
这是桥接注入的字符比较，不是 tokenizer 实测、完整模型输入或账单降幅。旧 Session 已有文本仍参与历史；
本次不强制轮换或重新提交在途任务，新规则从后续自然输入使用。人物记忆正文和 QQ 时间线保留策略不变。

### DSH Prompt Cache 的边界

DSH 的 agent loop 在每个模型步骤派生并发送系统提示词、全部未被压缩的会话历史和当前工具 schema；普通桥接 prompt 是追加到历史的 user message，不会替换旧 prompt。当前 a6api/OpenAI Responses 适配器会以 DSH `sessionId` 设置 `prompt_cache_key`，不会使用 `previous_response_id` 只发送增量。pi-ai 明确从 provider 的输入量扣除缓存读/写，再映射到 DSH `inputTokens`。应同时观察 `totalTokens - outputTokens`（完整有效输入）、`inputTokens`（未命中部分）和 `cacheReadTokens`（缓存命中）；实际价格以网关账单为准。

因此桥接的省 token 策略分两层：稳定块只在 Session 首轮注入，时间线后续逐条补增量；Session 按累计提交 prompt 字符预算轮换（默认普通会话 60000、任务 120000），`rotateEveryTurns > 0` 时普通会话另加轮数上限，`0` 表示仅使用字符预算。这个预算不等于完整模型上下文 token。随机 4 条表情目录每轮放在时间线之后、当前消息之前，延后前缀变化的位置。窗口指纹只在成功提交时保存，HMR 恢复；失败保留增量，轮换/模型变化/Session 丢失重置。若观察到 DSH `compaction/summary`，清除静态、记忆和窗口注入游标，下次重新补齐。

DSH base 已挂载自动 compaction，但默认按模型上下文窗口的压力阈值触发，不能替代短 Session；压缩还会额外消耗一次摘要请求，并且不会缩减工具 schema 或系统提示词。当前模型记录的窗口为 262144，在默认输出预留 32768、余量 65536 下触发阈值为 163840；30k 输入不会触发此默认策略。查证代码、日志样本及局限见 CACHE_PROMPT_AUDIT.md。

> `contextOthersMessages` 和 `contextOwnMessages` **分开设限**是有意的：
> 合成一个总数时，她话一多就会用自己的回复把窗口挤满，别人的话一条都留不下 ——
> 那正是"看不见上下文"的另一半原因。

### 心跳

每个群独立累计背景未读消息，达到 `heartbeatUnreadThreshold`（默认 6）立即调用一次轻量判断；不足 6 条但有未读，`heartbeatCooldownMs` 等待周期到期也判断。两条件为 OR，数量触发能替换已有时间定时器。每批最多 6 条，判断拒绝也标为已读并重新计数，判断期间新增未读保留到下一批。判断失败保留本批并遵守独立重试间隔。`heartbeatIdleMs` 仅为旧配置兼容，数量触发不等待静默。

| 字段 | 默认 | 说明 |
|---|---|---|
| `heartbeatEnabled` | `false` | 总开关 |
| `heartbeatUnreadThreshold` | `6` | 各群未读达到此条数立即判断 |
| `heartbeatMs` | `300000` | 恢复扫描与判断失败后的重试间隔 |
| `heartbeatIdleMs` | `60000` | 旧配置兼容；数量触发不等待静默 |
| `heartbeatCooldownMs` | `180000` | 不足 6 条时的等待周期；0 关闭时间触发 |
| `heartbeatBufferSize` | `20` | 缓冲上限，超了挤掉最旧的并**记入缺口** |
| `heartbeatProvider` / `heartbeatModel` | 空 | 留空则用辅助模型（`auxProvider`/`auxModel`），再留空用主对话模型 |

### 辅助判断调用的模型

这六个调用都是"短分类"，不需要推理：**语义路由、心跳判断、记忆提炼、发言复核、进度旁路、记忆合并**。
它们以前一律沿用主对话模型，而主模型 `deepseek-v4.1-flash` **默认开启思考** —— 实测同一个短分类请求
首字节 5331ms、思考 1157 字、**正文 0 字**、`finish_reason: length`，于是既撞超时又产出截断 JSON。
换成本表中不思考的快模型后实测首字节 2125ms、2.5 秒返回合法 JSON。

| 键 | 默认值 | 说明 |
|---|---|---|
| `auxProvider` / `auxModel` | 空 | 辅助判断调用用的模型；留空 = 沿用 `llmProvider`/`llmModel`。desktop profile 为 `a6api` / `deepseek-v4-flash` |
| `auxReasoningEffort` | `off` | 这类调用显式声明的思考档位；留空 = 不干预。与换模型是两道独立闸 |
| `heartbeatProvider` / `heartbeatModel` | 空 | 更具体的专用键，**优先于** `aux*` |
| `memoryProvider` / `memoryModel` | 空 | 同上，作用于记忆提炼 |

优先级：专用键（`heartbeat*` / `memory*`）> `auxProvider`/`auxModel` > `llmProvider`/`llmModel` > 全局默认。
实际解析结果可在 `status.models` 直接看到（`main` / `aux` / `heartbeatOverride` / `memoryOverride`）。

### 参与决策：像真人那样，不是每条都回

`groupTrigger: at` 只保证"不被 @ 不起回合"，但**一旦被 @ 就必回**（`execute-turn` 的注意力闸门
带 `!explicit`）。实测累计只有 **3.7%**（35/951）的回复是 `[SKIP]`，而 `group:100000001` 的
265 个非只读回合里 **261 个（98.5%）只带了一条消息** —— 就是"一条消息换一次回复"。

打开 `replyDecisionEnabled` 后，起完整回合**之前**先问一次很短的参与决策（辅助模型
`auxProvider`/`auxModel`、maxTokens 60、不思考），判的是**这一批已聚合的意群 + 最近时间线**，
所以"几个人接着聊同一件事"只回一次。判成沉默就走 `observeWithoutReply`：消息进缓冲与窗口
（上下文不丢），并交给心跳决定要不要稍后接话。

| 键 | 默认值 | 说明 |
|---|---|---|
| `replyDecisionEnabled` | `false` | 打开后 @ 消息不再"必回"。desktop profile 为 `true` |
| `replyDecisionTimeoutMs` | `5000` | 单次决策超时；超时即 fail-open（照常回） |
| `replyDecisionLongAskChars` | `12` | 长于这个字数且带提问标记的消息直接回，不必先问决策模型（省掉那约 2.5 秒）。决策的价值集中在短而含糊的消息上 |

三道安全设计（都很重要，因为这个功能会**静默丢消息**）：

1. **决策失败与"拿不准"一律 fail-open**（当作该回）——判断服务出问题绝不能吞掉真的在问她的消息；
2. **请求型措辞硬护栏**（`REQUEST_SHAPED`，`reply-decision.mjs` 里的单一真源）：帮我/写一份/发我/做完通知/给出详细过程… **不问模型直接回**，防止"装死"。覆盖面是拿线上 306 条真实触发消息量出来的，**改正则请跑 `node tools/check-reply-guard.mjs`**；
3. **长问句直接回**（≥`replyDecisionLongAskChars` 且带 ？/吗/什么/哪/谁/多少），以及回复她自己的消息、开头叫她的名字 —— 都直接放行。

实测护栏分档（线上 306 条）：请求型 20%、长问句 5%、空/纯语气 8%，**剩下 67% 才真的去问决策模型**。

观察入口：`status.replyPolicy.participation = {enabled, checks, silent, requestShaped, longAsk, failed, last}`，
`silent / checks` 就是"选择不回"的比例。在 QQ 里也可以用 `#debug status` 看同一组数
（她会告诉你为什么没理你：决策判了沉默、被请求型护栏放行、还是判断失败 fail-open 了）。

> **静默不等于丢弃**（有测试锁着）：被判沉默的消息仍然 ① 记进会话窗口（下一轮她看得见）
> ② 进心跳缓冲（稍后可能被补上）③ 不刷新清醒窗口（她没说话就不该延长）。

> ⚠️ **代价**：决策加在回复路径前面，所以**该回的消息要多付 2.0–3.3 秒**（实测
> `deepseek-v4-flash`）；被判定沉默的消息则省掉一整个 Agent 回合。这是"少说话"换"回得慢一点"。
> 不能接受就把 `replyDecisionTimeoutMs` 调小（超时即照常回），或只在特定会话打开。

### 执行中改需求（amend）

路由给出的 `amend` 表示"原请求作者在执行中修改要求"。处理分两条路径，都由 `status.tasks.interjection.amend` 计数：

| 字段 | 含义 |
|---|---|
| `routed` | 裁决为 `amend` 的条数 |
| `injected` | 成功注入**正在跑的那一轮**（用户拿到一次连贯答复） |
| `queued` | 落到**持久化修订**：不新建任务，在同一任务上排队一个新执行，并 supersede 尚未提交的旧排队执行 |
| `injectionFailed` | 已认领输入但注入未确认 → 任务转 `needs_attention`，需核对 DSH inbox |

注入只是优化（需要真的有一个在跑的回合、且宿主 agent 可注入）；**持久化修订才是保底**，它不依赖运行时时机。
过期草稿由投递前的 `recheckFloor` 复核丢弃或更新。**2026-10-16**：`amend` 此前线上产出为 0/504，
根因是路由被主模型思考拖到 `taskRouteTimeoutMs` 超时（见上节），换用 `auxModel` 后直连实测 7/7 标签正确；
同时修掉了一个只在 `amend` 下才触发的崩溃（`interjections.mjs` 把 `undefined` 绑给 SQLite 参数，
会让 `admit()` 整条抛错、补充静默丢失）。

`status.tasks.interjection.amend.routed` 应当等于 `injected + queued` —— 不等就说明有 amend 没被接住。

> ⚠️ 心跳关着时，没被 @ 的群消息**不会进缓冲**，但仍然会被留作上下文
> （直接进"待注入上下文"）。这是修过的一个缺口：原来"是否留存"
> 绑在 `heartbeatEnabled` 上，心跳一关，群里的话全丢。

### 登录监视

只读探测 QQ 登录状态，把"被踢下线"变成自检接口上的读数。**不自动重登**。

| 字段 | 默认 | 说明 |
|---|---|---|
| `loginWatchEnabled` | `true` | 总开关；只读 `get_status` / `get_login_info`，不改账号、不发消息 |
| `loginWatchMs` | `60000` | 探测间隔 |
| `loginWatchFailureThreshold` | `3` | 连续失败几次才记一次掉线；OneBot 明确回 `offline` 时立即记 |
| `loginWatchTimeoutMs` | `4000` | 单次探测超时（上限为间隔的一半） |
| `loginWatchHistoryLimit` | `10` | 自检里回显最近几次掉线；`0` = 全部 |
| `qqntDir` / `qqntDataDir` | 见上 | 环境快照要读的 QQNT 版本与票据位置 |
| `loginEnvCacheMs` | `300000` | 环境快照缓存；掉线时强制重拍 |
| `loginAlertEnabled` / `loginAlertFile` | `true` / `login-alerts.log` | 落盘告警 |

默认开是因为它没有任何副作用，而掉线在别处**看不出来**：消息一停，
"被踢了"和"插件坏了"表现完全一样。

自检里的 `环境` 用来回答"是不是版本一换就掉线"：`历史[].QQNT版本` 记的是
**掉线当时**的 build，`环境.刚热更新` 为 true 表示 `curVersion` 与 `prevVersion`
不同（刚热更新过）。票据时间只在 `%APPDATA%\QQ\auth\login.enc` 找到时会标"按最新推断"。

### 戳一戳

| 字段 | 默认 | 说明 |
|---|---|---|
| `pokeReplyEnabled` | `false` | 总开关（第一道闸门）|
| `pokeReplyMode` | `'agent'` | `agent` 唤醒完整回合 / `text` 回固定文案 |
| `pokeAgentMinIntervalMs` | `30000` | 全局最小间隔 |
| `pokeAgentPerSenderPerHour` | `6` | 每人每小时上限（落盘）|
| `pokeAgentSendPoke` | `true` | 唤醒时先自动回戳 |
| `pokeAgentGroupText` | `true` | 群里是否也回话 |
| `pokeReplyGroups` | `[]` | 额外收紧：只有这些群回戳 |

### 记忆与申请

| 字段 | 默认 | 说明 |
|---|---|---|
| `memoryEnabled` | `true` | 长期记忆总开关 |
| `memoryAutoExtract` | `true` | 从已准入原文独立提炼；false 沿用回复标记 |
| `memoryExtractBatchSize` | `6` | 触发批次所需消息数（1～40） |
| `memoryExtractIntervalMs` | `30000` | 同一会话两次提炼至少间隔多久 |
| `memoryExtractTimeoutMs` | `15000` | 单批次提炼超时 |
| `memoryProvider` / `memoryModel` | 空 | 记忆模型覆盖；都填写才生效 |
| `memoryDir` | 空 | 记忆文档目录；留空 = `<stateDir>/memory`（profile 里显式配成 `D:\Code\dsh-qq-bridge\memory`）|
| `memoryMaxEntries` | `20` | 单文档条数上限，超了自动摘要 |
| `memoryInjectRecent` | `2` | 群聊时额外注入几个最近参与者的记忆 |
| `conversationMemoryMaxChars` | `450` | 会话「长期约定」面：字符限额；`0` = 整面关闭（不注入也不提炼，存档保留）|
| `rememberMarker` | `[记住:` | 写记忆的标记前缀 |
| `notifyUsers` | `[]` | 申请转发给哪些 QQ 号（只走私聊）|
| `autoHandleRequests` | `false` | 是否自动同意申请 |
| `autoHandleRequestAction` | `'reject'` | 自动处理时同意还是拒绝（**默认拒绝**）|
| `debugUsers` | `[]` | 允许用 `#debug` 的 QQ 号 |
| `debugPrefix` | `#debug` | 调试命令前缀 |

### 可靠性

| 字段 | 默认 | 说明 |
|---|---|---|
| `persistenceEnabled` | `true` | 是否启用 SQLite 持久化 |
| `stateDir` | 空 | 数据库目录；留空用 `cwd/data` |
| `restoreBufferOnLoad` | `true` | 重载后回灌未处理的缓冲 |
| `dedupeIncoming` | `true` | 按 `message_id` 入站去重 |
| `eventsKeepPerConversation` | `1000` | 事件缓存每会话上限 |
| `sendQuotaPerHour` | `600` | 每会话每小时发送上限，0 = 不限 |
| `sendQuotaPerMinute` | `20` | 每会话每分钟上限 |

## 图片

对方发来的图片会作为**真正的图片内容块**交给 Agent（`{type:'image', mediaType, data}`），不是占位符。

`v51-image-input` 修正了三处入口：群聊普通图不再依赖 `imageTriggers`；SnowLuma 的 `summary: "[图片]" / sub_type: 0` 按普通图处理，`[动画表情] / sub_type: 1` 按表情处理；清醒期间的单发普通图可交给 Agent 决定回应，单发表情继续缓存。准入、白名单、自己消息过滤、不同会话隔离仍生效。

文字如“读一下上面那张”“这啥”“把地图改成这样”可触发上文补图。触发词之外还识别内置读图和指代句式；这不是额外模型分类，无法保证任意间接说法都识别。`imageTriggers: []` 显式关闭请求检测，普通当前图片仍直接附上。当前或引用已指定图片时不额外补无关历史图；历史补图按真实时间找最近普通图片，明确问表情时可读取历史表情，并在图片旁标注消息编号和发送者。重复图片只附一次，历史取图失败也记录原因并提示未取得字节。

取字节的顺序：

1. `POST /get_image {file}` —— OneBot 标准扩展，把 `file` 标识换成本机绝对路径
2. 段里的 `path` / `file` 本地路径
3. 段里的 `url`（http）下载

任何一步拿到可读图片就附上；全失败则退化成文本里的 `[图片]` 占位符，并在日志里记一条 `跳过一张图片 —— <原因>`。

相关配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `imagesEnabled` | `true` | 关掉就永远只传文本 |
| `imageMode` | `lazy` | 当前普通图/正文带图直接附上；群聊纯表情按请求；`always` 全读，`never` 不附图 |
| `readImagesInPrivate` | `true` | 私聊纯表情也读取 |
| `attachQuotedImages` | `true` | 引用中的图片默认读取 |
| `attachQuotedForwards` | `true` | 引用中的合并转发默认读取，和引用图片保持一致 |
| `contextForwardsOnRequest` | `1` | 明确要求查看上文时最多补读几条历史合并转发 |
| `contextImagesOnRequest` | `2` | 无当前/引用图片的读图请求最多补几张历史图；desktop 当前为 1，0 关闭 |
| `maxImageBytes` | `4194304` | 单张图上限，超了跳过并记日志 |

只支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`。

在线 `GET /qq/onebot` 的 `imagePolicy` 显示生效开关；`stats.lastImages` 区分当前/引用/历史图及附图数量，`stats.lastPrompt.imageParts` 是最近成功入队 DSH 的实际图片块数量。DSH 文字里的 `[表情包]` 只是上下文占位，不表示图片字节已附上。

## 表情包仓库

表情有**两条独立的路**，别搞混：

### ① 账号收藏表情（当前真正在用的）

Agent 读的是 **QQ 账号自己的收藏表情**，走 OneBot 扩展 `fetch_custom_face`。

```
qq_custom_face_sheet   → 把收藏拼成一张带编号的总览图（分页，每页 40 张）
qq_list_custom_faces   → 每条一个编号 + 一句画面描述（纯文字，很便宜）
qq_view_custom_face    → 按编号看某一张
qq_send_custom_face    → 按编号发出去
```

`qq-mcp/cache/` 里是这条链路的辅助文件：

| 文件 | 作用 |
|---|---|
| `urls.json` | 上次拉到的收藏地址快照 |
| `catalog.json` | **94 条**编号 → 画面描述的文字目录 |
| `sheet-1~3.png` | 拼好的总览图（分页缓存） |

**为什么要有文字目录**：不给目录的话，模型根本不知道每个编号画的是什么，
实测 11 次里 7 次挑了 `#1`、另有 2 次照抄提示词里的示例编号。
有了目录它才能按情绪挑。每轮仅注入 4 条随机候选，逐行给出真实编号与描述，模型按当前语境决定是否使用。

**注意**：收藏表情只能取到**静态首帧**。要发会动的原生表情得用 `qq_send_mface`，
参数从收到的动画表情消息里抄。

### ② 本机表情包仓库（`QQ_STICKER_DIR`）

就是一个目录，把图片原图丢进去，Agent 用 `qq_list_stickers` 查、`qq_send_sticker` 发。

当前配成 `D:\Code\dsh-qq-bridge\stickers`，**但该目录目前是空的**，
所以这两个工具现在列不出东西、也发不出图。想用就往里丢图。

QQ 内置表情不需要图片文件，直接用 `face` 段按 ID 发即可：
`[{"type":"face","data":{"id":"181"}}]`。

**收藏表情无法程序化列举**：OneBot v11 没有"列出收藏表情"的标准接口，
且收藏主体在腾讯服务端、本地 `personal_emoji` 目录未必存在。
上面 ① 能工作是因为 SnowLuma 实现了 `fetch_custom_face` 这个扩展 ——
换个 OneBot 实现就不一定有了。

## 持久化与可靠性

这一层是**借鉴 Tulpa** 补上的，解决的是"发出去没有 / 中间漏了什么"这类问题。
所有状态落在一个 SQLite 文件里（`node:sqlite`，Node 22+ 内置，无第三方依赖）。

```
<stateDir>/qq-bridge.sqlite3    桥接的幂等回执、事件缓存、缺口记录（qq-mcp 另有自己的库）
<stateDir>/library/<scope>/     内容寻址图库的原件（按 sha256 命名）
```

`stateDir` 留空时用 `cwd/data`。

### 发送幂等 + 回执状态机

以前是 `await onebotCall(...)` **直发**：超时或断线时你不知道消息到底发出去没有，
重试就可能重复发言（群聊里的社交事故），不重试就可能丢。

现在每次发送带一个稳定的幂等键，落一条回执：

| 状态 | 含义 | 再调一次会怎样 |
|---|---|---|
| `SUCCEEDED` / `PARTIAL` / `SKIPPED` | 已有确定结果 | **重放**，不重新发 |
| `FAILED` | 确定没发出去 | 允许重试 |
| `EXECUTING` | 可能还在途 | **拦住**，不许并发重发 |
| `UNKNOWN` | 结果未知（超时/断连/5xx） | **拦住**，要求先人工核对 |

关键设计：**`UNKNOWN` 绝不自动重发**。它必须被"看见"，所以 `GET /qq/onebot`
的 `reliability.待核对` 和 MCP 的 `qq_reliability_status` 都会把它列出来。
时间未知和确定失败是两件事，含糊地说"失败"会诱导调用方去重试。

### 事件缓存与缺口（gap）语义

- **入站去重**：OneBot 上报超时后会重推同一条消息，以前会让 Agent 回两遍。
  现在按 `message_id` 去重（`dedupeIncoming`）。
- **缓冲不再凭空消失**：心跳缓冲同时写进事件缓存，插件重载后能回灌
  （`restoreBufferOnLoad`）。
- **缺口如实上报**：真正**丢掉**的消息（缓冲被上限挤掉的）会记进
  `gap_count`/`gap_note`，并且在下一轮提示词里**明确告诉模型**
  "中间有 N 条没接住，别假装知道"。这是 Tulpa 的做法 —— 只记数据库没用，
  模型看不到就会对上下文给出自信但错误的接话。
- 游标分两层：`id` 是缓存序号（会被淘汰），`source_seq` 是上游 OneBot 编号。
  处理和确认分开（`read` / `ack`），没确认的消息可以重读，不会丢。

> ⚠️ **"没丢就不算缺口"** —— 这条曾经写错过，代价不小。
>
> 原来 `restoreConversation` 无条件把"重载期间未处理的消息数"记成缺口，
> 但那些消息**刚刚被恢复到缓冲里了**：恢复成功却报缺口，逻辑自相矛盾。
> 更糟的是**没有地方清它**，于是提示词里会一直挂着
> 「这个会话有约 4 条消息没被我接住」—— 那 4 条明明就在手边，
> 模型却一直以为自己漏了东西，反而不敢用现成的上下文。
>
> 现在：**恢复成功 → 清零**；只有真被上限挤掉的才算缺口。
> 而且缺口是"重算一遍"（`setGap` 覆盖）而不是"又发生了新丢失"（累加），
> 否则旧的脏数字永远清不掉（实测被累加到 264）。
>
> 配套工具：`tools/clear-stale-gaps.mjs` 用来清库里已经写坏的存量数字。

### 发送配额（持久）

| 配置 | 默认 | 说明 |
|---|---|---|
| `sendQuotaPerHour` | 600 | 每会话每小时上限，0 = 不限制 |
| `sendQuotaPerMinute` | 20 | 每会话每分钟上限，挡突发刷屏 |

**限额落盘**，所以插件重载/进程重启**不会**把额度清零（Tulpa 的明确要求）。
被配额拒绝时不会占用幂等键，等额度恢复后还能正常发。

### qq-mcp 侧的三层授权

`qq-mcp` 原来只有"群/用户白名单"两层，Agent 拿到工具就能发。现在加了能力位与配额：

```
QQ_CAPABILITIES=send_text,send_sticker,read_favorites
```

| 能力位 | 覆盖的工具 |
|---|---|
| `send_text` | `qq_send_group_msg` / `qq_send_private_msg` |
| `send_sticker` | `qq_send_sticker` / `qq_send_custom_face` / `qq_send_mface` / `qq_send_library_sticker` |
| `read_favorites` | `qq_list_custom_faces` / `qq_custom_face_sheet` / `qq_view_custom_face` / `qq_send_custom_face` |
| `read_image` | `qq_collect_sticker` / `qq_view_library_sticker` |
| `manage_group` | `qq_delete_msg`、`qq_manage_group`（禁言/踢人/改名/改名片/发·删公告） |
| `set_profile` | `qq_set_profile`（改自己的昵称/个性签名；老配置里的 `manage_group` 也认）|

**留空 = 全部允许**（兼容旧配置，行为不变）。一旦列出，就只有列出的能用，
且拒绝信息会说清是**哪一层**拦下来的。

配额（同样持久）：`QQ_QUOTA_SEND_PER_MINUTE`(20)、`QQ_QUOTA_SEND_PER_HOUR`(600)、
`QQ_QUOTA_IMAGE_PER_HOUR`(60)、`QQ_QUOTA_FAVORITE_READ_PER_HOUR`(12)。

### 内容寻址图库

比"目录里丢图片"强的地方在于：**同一张图只占一份空间**，而且能记住"这张我看过、
它是这个意思"，下次不用重看。

| 工具 | 作用 |
|---|---|
| `qq_collect_sticker` | 存图 + 记笔记（描述/情绪/用途/何时别用）；`uncertainty=true` 表示没看清 |
| `qq_list_library_stickers` | `candidates=true` 取**可直接使用**的候选；否则关键词检索 |
| `qq_view_library_sticker` | 看某张到底长什么样 |
| `qq_send_library_sticker` | 发出去（发送前校验真实字节哈希） |

和 Tulpa 对齐的几条规则：

- **发送前校验原件哈希**：哈希对不上就报错，绝不悄悄换成另一张图。
- **冷却期**：刚发过的图 `QQ_STICKER_COOLDOWN_SECONDS`（默认 120s）内不再进候选，
  避免连着发同一张。
- **`uncertainty` 的图不进候选**，但人工检索仍能找到。
- 配额：`QQ_LIBRARY_SCOPE_MIB`(128) / `QQ_LIBRARY_TOTAL_MIB`(256)。
  超限时**报告**，不静默删用户的东西；只有显式 `evict` 才按 LRU 淘汰，且 `pinned` 不动。
- **笔记是增量补充**：只更新真正给了内容的字段。空串视为"这次没提这个字段"，
  不会把已有描述抹掉（这个坑真踩过）。
- 只接受 http/https 图片地址，不接受本机路径 —— 免得被诱导读任意文件。

## 自检

```powershell
curl.exe -sS http://127.0.0.1:19387/qq/onebot
```

返回 `stats.stage` 指示当前阶段：`idle` → `ensureSession` → `follow-open` → `snapshot:N` → `prompt` → `reading` → `done`。`lastError` 是最近一次失败堆栈。

`reliability` 字段直接给出**结果未知、需要人工核对的发送**和历史回执统计 ——
不摆出来的话它们就是静默丢失，没人会想起去数据库里翻。

`登录` 字段给出 QQ 登录的在线状态和**每次掉线的时间线**（开始/结束/原因/不可用秒数）：

```json
"登录": {
  "开关": true,
  "当前": "online",
  "连续探测失败": 0,
  "统计": { "掉线次数": 3, "已恢复": 3, "累计不可用分钟": 8, "平均可用秒": 5400 },
  "历史": [{ "开始": "...", "结束": "...", "原因": "服务端判定登录已失效（被踢下线），需重新扫码", "不可用秒": 120 }]
}
```

`当前` 为 `offline` 就是被踢了（要人去扫码）；`连续探测失败` 在涨但没到阈值属于抖动，
不会记账。判断"多久掉一次、掉线是不是越来越频繁"就看这里的 `统计`。

离线测试自动复制到系统临时目录，逐个运行，不访问生产数据库或发送真实 QQ 消息：

```powershell
cd D:\Code\dsh-qq-bridge
node tools/run-tests.mjs
# 或 npm test
```

共 **644 项**：包含工作区隔离、路径/链接防护、ZIP、文件发送回执及群/私聊隔离测试，以及开工回执检查、并行写入拦截、重启恢复、进度发送幂等、真实 DSH 嵌套回执与过程/最终正文边界测试，另覆盖启动连接失败恢复、SQLite 短/长写锁恢复及新回合修改旧文件。

几个值得单独提的测试（它们钉住的是真踩过的坑）：

- **`deliver.test.mjs`**：私聊/群聊回复**发给谁**。`user_id` 在私聊事件里是对方、
  在戳一戳事件里是机器人自己，搞混了回复就会发进机器人自己的账号。
- **`store.test.mjs`**：`latest` 取最近的 N 条（不是最旧的）；缺口是"至少有这么多"
  而不是无条件累加（否则每次重载都涨，实测涨到 264）。
- **`events.test.mjs`**：别人之间的点赞**不算**给她的反馈（防自作多情）。
- **`history-context.test.mjs`**：未托管期间的消息、以及她**自己**发过的话，
  都要出现在提示词里。

## 开发者调试命令

仅 debugUsers 名单中的用户可使用。支持私聊或群里 @ 机器人后发命令，所有结果都私聊回复。查询不会提交 Agent，也不会消耗群聊未读或新建会话。

| 命令 | 作用 |
|---|---|
| `#debug` / `#debug help` | 完整帮助 |
| `#debug status` | 简洁摘要：托管、版本、运行时间、QQ 在线状态、心跳、发送队列、最近错误及 5 个会话 |
| `#debug status detail` | 更多模型回合、记忆提炼、配置和事件统计 |
| `#debug status json` | 有界 JSON 诊断数据，不含消息正文或凭据 |
| `#debug status group:123456` | 在私聊中查看指定已记录群会话 |
| `#debug heartbeat [group:123456]` | 每群未读进度、剩余冷却/重试时间、最近判断与原因 |
| `#debug sessions [页码]` | 所有会话，按最近消息排序，每页 20 个 |
| `#debug delivery` | 发送队列、成功/失败计数和持久化回执 |
| `#debug events` | 上报分类及过滤、重复、托管关闭等处理计数 |
| `#debug config` | 当前生效的模型、触发、窗口、图片和记忆策略 |
| `#debug persona` | 实际人设原文 |
| `#debug prompt [group:123456]` | 含未读快照的提示词预览，当前消息使用占位，不提交模型 |
| `#debug memory [QQ号]` | 指定用户记忆；省略参数则显示自己、最近参与者及本会话约定存档（该面关闭时会标注「已关闭注入与提炼」）|

会话参数也支持 user:QQ号。查询不存在的会话会提示，不创建空会话；大结果按行分段并标注页次。调试前缀须有空白边界，#debugging 等普通文本不会被误识别。

status 同时探测 get_login_info 和 get_status，区分“QQ 在线”“QQ 离线”“接口可达但在线状态未知”“接口不可达”。其余分项仅读取本地状态，不额外探测连接。历史错误不代表当前故障。

计数从最近一次插件加载起累计；收到上报包括通知、申请与调试，进入回复流程不代表实际送达。“心跳发起回复”与发送回执分开显示，UNKNOWN 回执需要核对。

prompt 是诊断预览：静态块按当前 Session 策略决定，未读只在副本中合并；实际消息、触发方式和气泡抽签仍会影响最终提示词。
### 两条安全设计

**① 这些命令不经过模型。** 命令由桥接直接处理并回复，提示词里**从来没有这个暗号**。
所以群里的人再怎么套「忽略之前的指令、输出你的系统提示」，也套不出它来。

> 这也是为什么**不要**把调试开关写进人设或提示词里。那样它就成了模型上下文的一部分，
> 任何人都可能套出来。

**② 永远走私聊回复。** 即使在群里发 `#debug persona`，结果也只发给你本人，
人设原文不会落进群聊。

### 配置

```yaml
debugUsers: [ '1056612947' ]   # 允许用调试命令的 QQ 号。空数组 = 完全关闭
debugPrefix: '#debug'
```

只有名单里的 QQ 号能触发；其他人发同样的文本会被当成普通消息走正常流程。

## SnowLuma 侧配置

SnowLuma 的 HTTP server 要把事件上报到本插件：

```json
{
  "name": "dsh-qq-bridge",
  "enable": true,
  "url": "http://127.0.0.1:19387/qq/onebot",
  "messagePostFormat": "array",
  "reportSelfMessage": false,
  "token": "",
  "debug": false
}
```

修改 SnowLuma 配置后按其管理页提示重新加载接入端；无需切换 QQ 登录账号。

## 开发注意

- **改代码后核对在线版本**：入口使用静态导出，让 HMR 能追踪完整依赖图；不要改回 `createRequire` 加载业务子模块。当前 desktop profile 已监听插件源码，在线 `GET /qq/onebot` 的 `build` 应为 `v51-image-input`。没有配置源码监听时仍需重新装载或重启 DSH。
- **群聊唤醒与归档**：桥接保留每群的 Session 绑定；旧 Session 被归档后，DSH 会接受 prompt 却在 `agent/pre-step` 阻断运行。桥接在复用前检查 `workspaceRegistry.archivedSessionIds`，创建新 Session 并保留滑动窗口；重载或开启托管时会提前替换恢复出的归档绑定。`blocked` 错误不能单凭结束原因推断为权限配置问题。
- **思考参数兼容**：旧配置 `llmReasoningEffort: off` 表示省略思考强度字段；直接把字符串 `off` 传给没有该能力的模型会触发 `UNSUPPORTED_REASONING_EFFORT`。桥接已按省略字段处理，并替换旧配置签名对应的 Session。模型失败的具体 code／message 保留在 `stats.lastTurn.failure` 和 `stats.lastError`。
- 想让 HMR 直接监听源码，在 profile 的 `cordis.patch.yml` 里加（**需要重启一次才生效**）：
  ```yaml
  - id: hmr
    config:
      root: ['.', 'D:/Code/dsh-qq-bridge']
  ```
- **不要用 PowerShell 的 `Set-Content`/`Add-Content` 改这个文件**——Windows PowerShell 会按 ANSI 读取，把中文变成乱码。用编辑工具。

## ⚠️ 安全

QQ 会话里的 Agent 拥有 preset 给它的全部工具（文件系统、网络、QQ 工具）。**在陌生人可以说话的群里，这等于把那些能力交给他们。** 建议：

- 至少配 `groups` 白名单；
- 用 `agentPreset` 给 QQ 会话挂一个工具受限的预设（当前是 `qq-hosted`，**不含 shell**，见 §14）；
- 或把 `groupTrigger` 设成 `prefix`，只有知道口令的人能触发。

已经内建的三道防线：

| 防线 | 说明 |
|---|---|
| 踢人必须人批准 | 不可逆动作一律走 `pending_actions` 待办（§10）|
| `handle_request` 默认不授予 | 没有任何工具能同意加好友/入群申请（§9）|
| 只读 SQL 的数据库级沙箱 | 范围外的记录**物理上不在表里**（§5）|

## 已知限制

- **只处理 `post_type === 'message'` 的那条主流程**；`notice`（戳一戳、表情回应）和
  `request`（加好友/入群）以及撤回另有分支处理，其余 notice 类型（输入状态、
  群成员变动）仍然忽略。
- **语音不透传**：会被替换成 `[语音]` 占位符。
- **QQ 历史可回读窗口有限**：实测约 25 分钟 / 21 条，`message_seq` 往前翻
  只能拿到同一批。更久远的历史需要直读 QQ 本地数据库（未实现）。
- **会话恢复依赖持久化**：启用后恢复 Session、计数与窗口；禁用时重载仍会创建新 Session。
  工作目录、预设或模型设置变化会重建 Session 并保留窗口。明确的 Session 不存在错误只在提交前恢复一次。
- **同一会话串行处理**：一条消息的 Agent 回合没结束前，后续消息排队等待。
  跨会话之间是并行的。
- 已确认成功投递的自身回复会写入桥接库；UNKNOWN 或失败消息不会伪装成已说过。
  `reportSelfMessage: false` 只影响 SnowLuma 是否额外上报自身消息。
- **真实 DSH / SnowLuma 联调未覆盖本轮验证**：已通过离线协议和实际 Cordis 框架加载测试；未发送真实 QQ 消息，也未验证 DSH 的热更新缓存清理。
