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

- desktop profile 使用 replyShapes: []，LLM 自行决定气泡和表情；仍遵守长度、气泡数和发送配额。
- 普通聊天最终正文由桥接发送；qq_say 仅作必要的即时进度，保留新的最终结果。
- 同会话回合走 registry.run；DSH 使用 queue 提交并按 rpcId/inbox 消费确认归属。禁止按最后一段文本猜回合。
- 不向真实 QQ 发送合成测试消息；真实端到端验证使用自然到来的消息。

## 修改与验证

- 上下文先合并按真实时间排序，再分别保留群友/自己条数，禁止按角色分组。QQ 历史时间优先，同秒保留返回顺序，不按 SnowLuma 随机 message_seq/ID 排序。
- 每个气泡/图片回执立即记窗口及 self_message，保存发送时间。恢复使用 payload.at 或事件 createdAt，不能使用重载时刻；旧时间在裁剪前迁移，QQ 校准结果不得被旧值覆盖。

- 本目录是 Git 仓库，远端为公开仓库 tianmengsky/QQ_DeepSeeK_Agent。`HANDOFF.md`、`docs/reports/`、`memory/`、`data/` 已在 .gitignore 中，禁止改为跟踪：前两类是内部记录，后两类含群友隐私与真实聊天记录。
- 提交前避免覆盖用户配置或打印 profile/preset 中的密钥。
- 修改中文源码和配置使用 apply_patch，避免 PowerShell Set-Content 编码问题。
- DSH HMR 监视源码目录，测试通过 node tools/run-tests.mjs 在系统临时副本运行。
- 改动完成后核对在线 build、replyPolicy、托管/心跳状态、发送队列及 lastError，并更新 README/HANDOFF。
