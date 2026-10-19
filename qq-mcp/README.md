# qq-mcp

运行环境为 Node >=24.10.0，本轮验证版本 24.16.0。`QQ_DRY_RUN=1` 统一拦截发送、戳一戳、回应、撤回、群管理、申请处理和待办决议，并明确返回“未执行”。超时或无法确认的发送记录为 UNKNOWN，同一 idem_key 不会自动重发。

让 Agent 通过 **SnowLuma 提供的 OneBot v11 HTTP 接口**在 QQ 里发消息的 MCP server。

提供发送、只读查询和受授权控制的管理动作。MCP 是 request/response 的被动工具调用，**无法把 QQ 收到的新消息推给 Agent**；要做「人在 QQ 里问、Agent 答」需要另外的常驻服务（见文末）。

桥接回合的发送工具不需要模型填来源：宿主在派发前按真实 DSH Session 注入本轮归属，共享 SQLite 在派发前复核请求是否被补充、取消或撤回，限流等待后再次检查。过时返回结构化 `SKIPPED` 回执，不真实发送、不刷新 60 秒唤醒、不占图库冷却。文件工具直接使用当前会话工作区，明确取消或撤回后停止新的写入/打包/发送；幂等成功重放及 UNKNOWN/EXECUTING 仍遵守原回执规则，不因群里新消息改写。收藏表情保留结构化回执；跳过不能声称已发送。不在 QQ 回合内的桌面会话可以显式指定 `group:/user:` 目标手动发送，不参与发言时机复核。

`v56-reply-value-floor` 的共享保守判定不再把同作者任意新消息视作修订，也不按多人发言数量取消回复；仅明确修改原要求才 update，明确取消/撤回才 drop。桥接最终发送另外按候选的交付价值作有证据的语义复核，答复、纠错、确认和任务结果不因话题转走而消失。

## 工具

发送默认配额为每会话每分钟 20 条、每小时 600 条，环境变量 `QQ_QUOTA_SEND_PER_MINUTE` / `QQ_QUOTA_SEND_PER_HOUR` 可覆盖；持久计数不会因重连清零。桥接输出的限流待发计划保留并在窗口恢复后复核投递，已成功气泡不重复发送，UNKNOWN 仍需人工核对。

| 工具 | 作用 |
|---|---|
| `qq_status` | 检查链路 + 显示当前生效的安全设置 |
| `qq_get_group_list` | 群列表（群号/群名/人数） |
| `qq_get_friend_list` | 好友列表（QQ 号/昵称/备注） |
| `qq_get_group_member_list` | 群成员列表 |
| `qq_send_group_msg` | 群消息 |
| `qq_send_private_msg` | 私聊消息 |
| `qq_say` | **在当前会话里发言**（不用填目标，见下） |
| `qq_workspace` | 当前会话隔离工作区：列出、读取、写入文件或打包 ZIP |
| `qq_send_file` | 将当前会话工作区内的文件发送给该群/好友（需 `send_file` 能力） |
| `qq_delete_msg` | 撤回自己发的消息 |
| `qq_collect_sticker` | 收藏图到本地图库 + 记笔记（描述/情绪/用途） |
| `qq_list_library_stickers` | 查图库；`candidates=true` 取可直接使用的候选 |
| `qq_view_library_sticker` | 看图库里某张 |
| `qq_send_library_sticker` | 发图库里的图（发送前校验真实哈希） |
| `qq_reliability_status` | 看发送回执统计和**结果未知需要人工核对**的发送 |
| `qq_poke` | 戳一戳某人（群里 / 私聊） |
| `qq_list_add_requests` | 看待处理的加好友 / 入群申请（只读） |
| `qq_handle_add_request` | 同意 / 拒绝申请（需 `handle_request` 权限） |
| `qq_manage_group` | 群管理：禁言 / 解除禁言 / 踢人 / 改群名片 / 改群名 / 发·删群公告 |

发送类工具都支持可选的 `idem_key`：同一次发送重试时传同一个编号，就不会重复发；
如果上次结果未知，它会**拦住**重发并要求先去核对。

文件工作区通过宿主注入的本轮归属绑定当前会话；两群或群与私聊互不可见。路径仅接受相对路径，拒绝路径穿越、链接和特殊文件；不执行源码。容量为每会话 200 个文件/50 MiB，单文件最多 20 MiB。文件发送复用目标白名单、持久发送配额、幂等和 UNKNOWN 回执，并将成功文件记入发言窗口。

工作区文件按 QQ 会话持久保存，新回合自动带自己的有效归属即可读取、修改、打包和发送旧文件；不要求使用创建文件时的来源编号，也不按任务或 DSH Session 分目录。群与私聊始终隔离，旧来源过期或 DSH Session 轮换不会移除文件。

### 为什么要有 `qq_say`

桥接只在整轮结束后投递最后一次工具调用之后的最终正文；工具前或带工具调用的 assistant 正文只留在 DSH，不会完成时补发。`qq_say` 用于立即发送必要的开工说明或阶段进度，并返回发送回执。即时说明只写在 `text` 参数里，不在工具旁边另写一份开工正文；完成全部工具后，另写结果、限制和玩法作为最终回复。同会话回合串行执行，DSH 通过 `queue` 提交，并按 `rpcId` / inbox 确认归属。

用法：

- `conversation` 填提示词里`【当前会话】`那一行的值（形如 `group:100000001`）。
- 本轮来源由宿主按 DSH Session 自动注入，工具参数里没有这个键；文件与工作区工具要求本轮存在归属。桌面会话手动调用时，显式给出 `conversation`（或发送工具的 `group_id` / `user_id`）即可，文件工具仍只在本轮 QQ 会话内可用。
- `qq_status` 可查看桥接数据库及归属校验状态。启动连接/归属表初始化失败时，后续工具调用会重新连接；共享 SQLite 写锁短暂等待 2 秒。数据库不可用会明确报连接故障，而非"来源无效"。恢复不放宽来源有效期、撤回或会话隔离检查。
- 较长写作、编程、多轮网络搜索/阅读核实或多个耗时步骤，可用 `qq_say` 及时告知实际进度。快速问答、短文润色和单次查询直接最终回复；选择沉默时不发开工说明。进度发送不作为文件工具的前置条件。
- 文件任务可直接调用 `qq_workspace write/read/list/pack` 和 `qq_send_file`；`qq_say` 只用于需要让对方及时看到的开工或阶段进度，不是文件操作的前置条件。所有文件仍必须通过本轮归属、当前 QQ 会话工作区、路径安全检查和发送能力位校验。
- 发出去之后会往桥接的会话窗口补一条 `self_message`，否则下一轮它不记得自己说过什么。
- 发进度后仍应输出新的最终结果或文件玩法；桥接仅去掉与已发工具文本完全匹配的气泡，不会因为用了 `qq_say` 就压掉最终回复。
- 有本轮归属而未填 `idem_key` 时，默认按来源与文字生成幂等编号。同一回合同样文字重试不会重复发送，不同阶段文字仍可发送。失败、UNKNOWN、dry-run 或旧回执重放不登记新的开工凭据，也不刷新发言窗口；UNKNOWN 应先核对，不能换编号盲目重发。

`QQ_ACTIVE_CONVERSATION_TTL_MS`（默认 300000 = 5 分钟）只用于旧的无归属当前会话标记；有本轮归属的调用按宿主绑定的来源校验。

`qq_say` 使用 `text` 参数；群/私聊发送工具的 `message` 参数可以是纯文本字符串，也可以是 OneBot 消息段数组：

```json
[
  { "type": "at",   "data": { "qq": "10001" } },
  { "type": "text", "data": { "text": " 你好" } }
]
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ONEBOT_HTTP` | `http://127.0.0.1:3000` | SnowLuma 的 OneBot HTTP 地址 |
| `ONEBOT_TOKEN` | 空 | 需与 SnowLuma 的 HTTP server `accessToken` 一致 |
| `QQ_ALLOW_GROUPS` | 空=不限制 | 逗号分隔的群号白名单 |
| `QQ_ALLOW_USERS` | 空=不限制 | 逗号分隔的 QQ 号白名单 |
| `QQ_DRY_RUN` | `0` | 置 `1` 则只打印不真发 |
| `QQ_MIN_INTERVAL_MS` | `1200` | 两次发送之间的最小间隔（限流） |
| `QQ_MAX_MESSAGE_CHARS` | `2000` | 单条消息长度上限 |
| `QQ_CAPABILITIES` | 空=全部允许 | 能力位白名单，见下 |
| `QQ_STATE_DIR` | `qq-mcp/data` | 持久化目录（幂等回执、配额、图库） |
| `QQ_PERSISTENCE` | `1` | 置 `0` 关掉持久化，退回旧行为 |
| `QQ_QUOTA_SEND_PER_MINUTE` | `12` | 每个目标每分钟发送上限，0=不限 |
| `QQ_QUOTA_SEND_PER_HOUR` | `200` | 每个目标每小时发送上限，0=不限 |
| `QQ_QUOTA_IMAGE_PER_HOUR` | `60` | 每小时读图上限 |
| `QQ_QUOTA_FAVORITE_READ_PER_HOUR` | `12` | 每小时读收藏表情上限 |
| `QQ_LIBRARY_DIR` | `<state>/library` | 内容寻址图库的原件目录 |
| `QQ_LIBRARY_SCOPE_MIB` | `128` | 单授权图库容量上限 |
| `QQ_LIBRARY_TOTAL_MIB` | `256` | 全局图库容量上限 |
| `QQ_STICKER_COOLDOWN_SECONDS` | `120` | 发过的图多久内不再进候选 |
| `QQ_MAX_IMAGE_BYTES` | `6291456` | 单张图大小上限（收藏时） |
| `QQ_ACTIVE_CONVERSATION_TTL_MS` | `300000` | `qq_say` 认的"当前会话"标记多久算过期 |

**建议至少配一个白名单。** 不限制意味着 Agent 能给任何好友/群发消息。

### 能力位（`QQ_CAPABILITIES`）

留空 = 全部允许（兼容旧配置，行为不变）。一旦列出，就只有列出的能用：

| 能力位 | 覆盖 |
|---|---|
| `send_text` | 群/私聊文字（含 `qq_say`） |
| `send_sticker` | 表情包、收藏表情、mface、图库图 |
| `read_favorites` | 列举/查看账号收藏表情 |
| `read_image` | 收藏图到图库、看图库里的图 |
| `manage_group` | 群管理（禁言/踢人/改名/改名片/发·删公告）+ 撤回 |
| `set_profile` | 改**自己**的昵称 / 个性签名（账号级；老配置里的 `manage_group` 也认）|
| `poke` | 戳一戳 |
| `read_requests` | 查看待处理的加好友 / 入群申请（**只读**） |
| `handle_request` | 同意 / 拒绝申请（**放陌生人进来，风险最高**） |

`read_requests` 和 `handle_request` 是**分开**的：只看是低风险的，同意/拒绝等于让
陌生人之后能驱动这个 Agent。合成一位的话，"想看一眼申请"就不得不把"能放人进来"
也一起授出去。

例如只让它发文字和表情、不许读账号收藏、也不许放人进来：

```
QQ_CAPABILITIES=send_text,send_sticker,poke,read_requests
```

配额和收藏表情读取是**分开**的 —— 它们的敏感度和成本都不一样。
配额是**持久**的：进程重启不会把额度清零。

### 申请收件箱（`QQ_BRIDGE_DB`）

加好友 / 入群申请是**桥接**（`dsh-qq-bridge` 插件）收到的，因为它是 OneBot 的上报
端点；而处理申请的工具在这里。两个进程靠一个共同的 SQLite 库交接，所以要指：

```
QQ_BRIDGE_DB=D:\作业\计算机组成原理\data\qq-bridge.sqlite3
```

不配它，`qq_list_add_requests` / `qq_handle_add_request` 会明确报"没连桥接数据库"。
只影响这两个工具，其它照常用。

### 管理类动作的两条纪律

- **动手前核对目标在群里**（`ban`/`unban`/`kick`/`set_card` 都会先查成员表）。
  把不存在的 QQ 号丢给接口，不同 OneBot 实现有的静默成功、有的报错、有的真把人踢了。
- **`ban` 的 `duration` 必须 > 0**。OneBot 里 `duration=0` 是**解除**禁言 ——
  直觉会以为 0 是"永久"，这个坑直接把"禁言"变成"解禁"。

管理类动作不走发送幂等（协议层本就幂等），但受 `QQ_QUOTA_ADMIN_PER_MINUTE`
（默认 6/分钟）限流。

群公告（`notice_set` / `notice_del`）另外受 `QQ_QUOTA_NOTICE_PER_HOUR`（默认 6/小时）限流：
它一发就推给全群，而且 QQ **没有"编辑已有公告"的接口** —— 改公告只能先 `notice_del`
再发新的。正文上限 `QQ_MAX_NOTICE_CHARS`（默认 1000 字），暂不支持附图。

## 本地冒烟测试

```powershell
cd D:\Code\dsh-qq-bridge\qq-mcp
node smoke-test.mjs
```

## 挂到 DSH

配置在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，条目 id `mcp-qq`。

## 前置条件

1. SnowLuma 已启动，普通 QQ 已登录机器人账号。
   SnowLuma 通过当前 QQ 进程接入，不需要额外启动第二个 QQ 实例。
2. SnowLuma 的 OneBot HTTP 服务在 3000 端口监听（登录成功后才会起）。
   令牌使用 SnowLuma 配置中的 HTTP server `accessToken`。

## 要做「QQ 消息触发 Agent」怎么办

MCP 做不到，需要写 **DSH 的 Cordis 插件**（Host 侧），用这几个 Service：

- `ctx.webServer.register(route)` — 注册 HTTP 路由
- `ctx.webhookRuntime.register(rule)` / `dispatch()` — 接 OneBot 的 HTTP 上报
- `ctx.agents` / `ctx.agentLoop` — 创建或恢复 Session、注入消息

数据流：SnowLuma 配 HTTP 上报 → 插件路由 → 喂给 Session → 取回复 → 回手调 OneBot `/send_group_msg`。
