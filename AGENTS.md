# 项目惯例

## 发言与唤醒

- 唤醒状态属于 QQ 会话；同群成员共享该群窗口，不同群/私聊隔离。
- 任意 agent 发言（普通回复、心跳插话、qq_say、群/私聊发送工具、图片/表情工具）成功发送一条新消息后，开启或刷新 60 秒窗口。
- 戳一戳默认走桥接 wake 模式：不回合成消息、不提交 DSH，桥接回戳一次并直接把该会话窗口开到 awakeMs。窗口从"收到并放行这个 poke"计时，回戳失败也照开。
- 从成功发送回执时刻计时，每个气泡和表情都刷新；排队和心跳判断不是成功发言；被限流或白名单挡掉的 poke 不刷新窗口。
- 失败、UNKNOWN、dry-run、幂等重放不刷新窗口；纯 [SKIP] 不延长也不清空已有窗口。
- 唤醒期间未 @ 的非空群消息可以跟聊，原有准入、白名单及 bot 自己消息过滤仍生效。
- 唤醒时间通过 lib/conversation/activity.mjs 统一管理；poke 的窗口也写共享 SQLite 的 qq-bridge:speech:<会话>，重载后恢复。不要在新入口另写计时策略。
- pokeReplyMode 默认 wake；agent 仅作兼容开关（会合成消息提交 DSH），text 只回固定文案。改默认前先确认"戳一下就回一句"不是想要的效果。
- 默认值和 desktop profile 的 awakeMs 均为 60000；awakeMs: 0 是显式关闭（wake 模式只剩回戳）。

## 回复投递

- desktop profile 使用 replyShapes: []，LLM 自行决定气泡和表情；仍遵守长度和发送配额，气泡数不封顶（v98 起；『』协议见 README）。
- 普通聊天最终正文由桥接发送；qq_say 仅作必要的即时进度，保留新的最终结果。
- 同会话回合走 registry.run；DSH 使用 queue 提交并按 rpcId/inbox 消费确认归属。禁止按最后一段文本猜回合。
- 不向真实 QQ 发送合成测试消息；真实端到端验证使用自然到来的消息。

## 修改与验证

- 上下文先合并按真实时间排序，再分别保留群友/自己条数，禁止按角色分组。QQ 历史时间优先，同秒保留返回顺序，不按 SnowLuma 随机 message_seq/ID 排序。
- 每个气泡/图片回执立即记窗口及 self_message，保存发送时间。恢复使用 payload.at 或事件 createdAt，不能使用重载时刻；旧时间在裁剪前迁移，QQ 校准结果不得被旧值覆盖。

- 本目录是 Git 仓库，远端为公开仓库 tianmengsky/QQ_DeepSeeK_Agent。`HANDOFF.md`、`docs/reports/`、`memory/`、`data/` 已在 .gitignore 中，禁止改为跟踪：前两类是内部记录，后两类含群友隐私与真实聊天记录。
- 提交前避免覆盖用户配置或打印 profile/preset 中的密钥。
- 修改中文源码和配置使用 apply_patch，避免 PowerShell Set-Content 编码问题。
- 测试只钉行为（归属、顺序、去重、投递、回执、窗口/记忆预算），不钉提示词措辞：改版式或换一句文案不该让测试变红。`test/prompt-system.test.mjs` 已按此原则删除，纯文案断言不再新增。
- DSH HMR 监视源码目录，测试通过 node tools/run-tests.mjs 在系统临时副本运行。
- 分三档，按改动范围选，不必每次跑全量：
  - 日常改完一个模块：`node tools/run-tests.mjs <套件名>`（几秒）或 `--quick`（核心九套，349 项，6 秒）
  - 提交前：`--fast`（跳过 mcp/poke-wake，约 900 项，约 20 秒）
  - 动了 mcp、poke-wake 或桥接核心：全量（约 1200 项，约 100 秒，4 路并行）
- `mcp` 单套就占全量一半以上：它 spawn 43 次真实的 qq-mcp 子进程（单次冷启动约 1.8 秒），测的是进程边界，不要为了快把它 mock 掉。
- 改动完成后核对在线 build、replyPolicy、托管/心跳状态、发送队列及 lastError，并更新 README/HANDOFF。

## 版本号

- 线上能看到的版本号只有 `stats.build`：`lib/bootstrap.mjs` 里的 `build:` 字段，`/status` 与面板页脚读的就是它。`package.json` 的 `0.1.0` 是私有包遗留，全仓库没有代码读它，别拿它当版本号。
- 什么时候升：一批**会改变线上行为**的提交落地时升一次（提示词/气泡协议、投递与去重、插话与节奏、队列与恢复），不是每个 commit 都升；但也不要让拖了十几天的提交共用一个号——判据是"用户从 `/status` 看到的号能不能区分改前改后"。只改文档或测试、行为不变的提交不动号。
- 格式 `v<序号>-<主题 slug>`：序号只增不减、不许复用（回收旧号没有意义，历史记录里已经引用过）；slug 用 2–4 个英文短词概括这批改动，例如 `v98-brackets-pacing-dedupe`。
- 每次升号同时做两件事：`build:` 序号 +1；在 `README.md` 顶部（最新在最上）写一条当日记录，写清从上个号到这个号之间装了什么、验证数字（测试项数）、以及这次为什么该升。README 的当日记录是给人看的，HANDOFF 记调查过程，两者不互相替代。
- 升完要确认：插件重载后 `/status` 的 `build` 应该是新号。桥接没在跑时不要声称已在线验证（2112 不监听、DSH 上 `/qq/onebot/status` 404 都算没跑），直接写明"等下次重载生效"。
