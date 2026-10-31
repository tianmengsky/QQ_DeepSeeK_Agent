2026-11-01 版本号 `v131-self-record` → **`v132-intent-age`**（`lib/bootstrap.mjs` 的 `stats.build`）。

上一版让"欠着的事"能被看见。这一版处理它放久了会变成什么：**不自动清、不替她判过期，只把那件事已经放了多久说出来**。

- `lib/application/world-snapshot.mjs`：【你还欠着的事】里，一件事到期/记账超过 `intentStaleDays`（默认 14 天）就追加"（已经放了 N 天，还惦记吗？）"。没到期的照旧写"（M 月 D 日之后提）"。
- `lib/config.mjs`：新增 `intentStaleDays: 14`。为什么是"说出来"而不是"清掉"：被系统悄悄忘掉的事，她下次想起来时会以为自己从没打算做；放弃也得是她自己的一句话（`qq_intent drop`）。
- 测试：`world-snapshot` 6 → **7**（到期 20 天的欠账必须被点名，同时仍在账上：`countOpenIntents() === 2`；刚记下的不打扰）。`proactive 23`、`intent 9`、`panel 11`、`logic 197` 全过；`--fast` 1065 项通过，只剩既有 `lifecycle:untilChecked`。

为什么该升：这是她账本上"没做完的将来"第一次有了时间的重量——`/status` 看不出，但她下次醒来会看见"这件事已经放了二十天"，而不是无限期地假装还记得。

2026-11-01 版本号 `v130-intent` → **`v131-self-record`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版修的是一个**她不会抱怨、但会让她失忆的静默缺陷**：`conversations.last_spoke_at` 这一列从来没有被写过，而"她最后一次在那儿说话"一直只活在内存会话条目里、又没落盘。于是每次热重载之后，她自己以为"我还没在这个群说过话"——世界快照这么写、`qq_windows list` 也这么写，连主动层的冷却都算成"从没说过"，等于没有冷却。

- `lib/conversation/registry.mjs`：`persist()` 落盘 `lastSpokeAt`，`entry()` 恢复它。这是根因那一处。
- `Store.lastSelfMessageAt(conversation)`：从 `events` 里回推（`kind IN ('self_message','action')`）。她说过的话一条不落在库列里，但一条不落地在事件里——回推才是不会丢的那份。
- `lib/application/world-snapshot.mjs`：取"最后一次说话"的顺序改成 内存条目 → 事件回推 → 库列；并把 `registry` 透传进去。主动层挑候选时的冷却也走同一顺序（`proactive.mjs` 的 `spokeAtOf`），`qq_windows list` 同步。
- `tools/preview-self-time.mjs`（新）：**只读演练**。连线上库、只读打开，把她下次醒来会看到的整段场景文本打印出来（世界快照 + `spineTaskText()`）。`spineTaskText` 因此抽成导出函数——它那一轮唯一的输入面，必须能单独读、单独看。
- 同时清掉一处重复：任务文本原来和快照末尾都写"没有人在等你回答"，现在任务文本改成"上面是别处发生的事，和你现在坐的地方无关"。

实测（只读、线上库）：六个窗口现在分别报"你最后一次说话是 8 / 5 / 3 / 7 / 3 小时前"，没说过话的窗口仍然如实说"你还没在那边说过话"。测试：`world-snapshot` 4 → **6**（新增"从事件回推"与"内存条目优先"两条）、`context-time` 7 → **8**（新增"最后一次说话落盘、重载后还在"）；`windows 15`、`proactive 23`、`intent 9`、`panel 11`、`store 35`、`json-output 7`、`memory-context 42`、`task-routing 58`、`logic 197` 全过。

为什么该升：这改的是她对自己处境的记忆——`/status` 看不出差别，但重载前后她对"我在哪说过话"的判断不再翻转；同时多了一个只读演练入口，下次要判断"她醒来看到什么"不必再起回合。

2026-11-01 版本号 `v129-spine` → **`v130-intent`**（`lib/bootstrap.mjs` 的 `stats.build`）。

上一版把决定搬出了房间，但她在外面醒来时只有"现在"：各窗口的动静、刚做过的事、心情。一个人之所以连着，还因为**欠着**——答应过的事、想回头问的一句话。这一版补的是"将来"。

- 新工具 `qq_intent`（[intent-tool.mjs](lib/application/intent-tool.mjs)）：`add` 记一件（`when` 认 `now / today / tomorrow / 3d / 12h`）、`list` 看她还欠着什么、`done` / `drop` 了结。上限 12 条、单句最多 200 字——欠太多等于没记。
- 世界快照多一段【你还欠着的事】：到期的排在前面并标"（到时间了）"，带窗口的会写成"→ 群 10"。她醒来第一眼就看得见自己欠着什么，不需要谁提醒。
- 与记忆刻意分开：记性是越久越值钱，欠着的做完就该消失；存在 `intents` 表（`status` 只有 `open/done/dropped`），不混进 `me.*`。
- 脊柱的场景说明多一句"想起'回头要问某人一件事'，就用 qq_intent add 记下来（它会在你下次醒着的时候出现，不会到点提醒你）"。
- 测试：新增 `intent` 9 项（记下/幂等/了结/放弃/欠太多被拦/太长被拦/时间说法/快照里看得见/关掉开关）；`--fast` **1061 项通过**，只剩既有 `lifecycle:untilChecked`。

为什么该升：`qq_intent` 是新工具，`/status` 的 `build` 之外没有别的可区分标志；而它改变的是"她能不能把一件事留到以后"——这是自主行动能不能连贯的关键一件。

2026-11-01 版本号 `v128-mood-merge` → **`v129-spine`**（`lib/bootstrap.mjs` 的 `stats.build`）。



这一版动的是**决策点**，不是心情，也不是工具。之前她的"自己的时间"是在某个房间的会话里跑回合——她看得见那个群最近的消息，决定就被那个群带着走；"主动"缩成了"在某间屋子里发作"。更早一版把"在哪醒"改成随机挑窗口，那只是把病因挪了个位置：多脑的病，是一个决定仍然长在某间屋子里。

- **醒在脊柱**：新增会话 `self:account`（`lib/application/proactive.mjs` 的 `#spineTick`），它不属于任何群、任何私聊。到点后她在那里醒来，看见的是 `buildWorldSnapshot()` 压出来的世界：各窗口最近的动静（安静多久、她最后一次说话是什么时候）、她最近自己做过的事、此刻的心情、她写下过的想法。房间里最近的消息**不再**喂进这个决定。
- **说话靠点名**：她直接回话不会被投递到任何地方（`lib/application/execute-turn.mjs` 里 `__spine` 分支在投递前返回）；要跟谁说，就用 `qq_windows say, to=窗口编号`。这样"在哪决定"和"对谁说"第一次解耦了。
- **`self:` 会话放行**：`lib/agent/workspace.mjs` 的会话 key 判断从 `^(group|user|bili):…$` 扩成允许 `self:<名字>`，并单独给它一个 workspace 目录；不这样放行，脊柱连会话都建不出来（`sessions.mjs:177` 拿 key 建 cwd）。
- **判断她开口了没有**：`Store.countSelfMessages({since})` 数这段时间里 `kind='self_message'` 的事件——脊柱回合没有投递对象，不能再看回合正文。
- 物理边界不变：睡觉 01:00–08:00、每天最多 4 次；`proactiveSpine: false` 可退回"借房间醒"，`proactiveMode: 'prompt'` 仍是旧菜单。
- 测试：`proactive` 21 → 23（新增"脊柱模式：醒在自己的外面，不借任何房间"、"开会话失败就记一次失败，不往外抛"）；`world-snapshot` 4、`self-actions` 3 是它的输入面与足迹。`--fast` **1052 项通过**，只剩既有的 `lifecycle:untilChecked` 失败（干净 worktree 上同样失败）。
- 没做：昼夜节律、`intent`（"将来"）、脊柱自己的会话轮换策略——现在它和普通会话共用一套轮换。

为什么该升：`/status` 的 `memory.proactive.mode` 会从 `turn` 变成 `spine`，它决定"决定发生在哪儿"，这是这一批里唯一会改变线上行为的东西。

2026-11-01 版本号 `v127-single-author` → **`v128-mood-merge`**（`lib/bootstrap.mjs` 的 `stats.build`）。


用户戳破的一个漏洞：天气是**全局**的，但写它的日结一次只看得见**一间屋子**，同一天几个群"后写的覆盖前面的"——那等于谁最后写，她就带着谁的心情过夜；另一边刚被夸、这边刚被冷落的差异被整段丢掉。这不是"覆盖丢信息"的问题（人本来也只能带一种心情），是**署名者的视野太窄**。

- `lib/memory/mood.mjs` 拆成两步：日结先 `writeMoodCandidate`（按天、按会话累积，同一天最多 8 间屋子、同一间重写只留最新），再由 `composeMood` 合成——按时间取前 3 句、去重、用"；"连起来，超长截断。**结果与写入顺序无关**：谁先写完都不会盖掉别人，迟到的那间屋子也会被合进去。
- 只有一间屋子时原样保留她自己的句子（句号也不动），不为合成而改字。
- `MOOD_MAX_CHARS` 80 → **110**：80 字装不下两句，合成时只能砍掉一整间屋子。
- `readMoodCandidates` 只认当天——昨天的心情不该压今天的天气。
- 测试：`mood` 5 → 6（新增"一天里几个房间的傍晚会合成天气，谁先写完都不会盖掉另一边"：两间都在、跨天不串、同屋重写只留一条）。
- 这一步之后，天气仍是"一种心情"，但它至少是**从所有屋子合成的一种**，而不是最后一间的投影。

为什么该升：`/status` 要能区分"天气=最后一个群"和"天气=合起来的"。

2026-11-01 版本号 `v126-mood` → **`v127-single-author`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版收的是**署名权**：从此以后，"我是谁"这本账只有一个写者的身份，房间不能替她改。

上一版给了她一具共享的体温（天气），但账本身仍然是十几个房间都能写的——`me.*` 会注入所有场合，而每个房间里她都能通过 `qq_memory` 写它。等于十几个念头各自篡改同一本账：身份分叉不是想象力的问题，是权限的问题。

- **边界**：`scope=self` 的**写**只允许后台写者——收尾（`memoryFlushSessions`）、自主时间（新的 `selfTurnSessions`），将来还有脊柱。普通房间回合写自记，直接拒绝，并告诉她"这一轮你能记的是别人和这个群"。
- **读从不拦**：她随时可以翻自己的本子。阅读不是署名。
- `lib/application/proactive.mjs` 在真回合前后把当前窗口的 session 加进/移出 `state.selfTurnSessions`（`try/finally`，异常也不漏）。`lib/bootstrap.mjs` 的 `state` 带上这个 Set，与收尾那个 Set 并列。
- 工具说明同步改成"只有你自己的时间能写"，否则她会先撞一次墙再知道规矩。
- 测试：`agent-memory` 14 → 15（新增"房间不能替她署名"：房间写被拦且提示提到后台、收尾会话能写、读不拦）；两个 rig 的 `state` 标成后台写者并注明理由。
- 受影响套件全绿：`memory-context 42`、`proactive 21`、`windows 15`、`panel 11`、`store 35`、`task-routing 58`、`memory-flush 11`、`self-model 9`、`mood 5`、`diary 10`、`introspect 11`、`logic 197`。
- `PROMPT_REVISION` 不升（静态块没变，工具说明每轮都在）。

为什么该升：`/status` 的 build 号要能区分"房间可以替她署名"和"只有她自己署名"——这是身份治理的边界变化，不是参数微调。

2026-11-01 版本号 `v125-cross-window-mouth` → **`v126-mood`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版补的是"多脑"缺的那一件：**天气**。

她的每个窗口都是一次独立实例，共享的只有账（`me.*` / 日记 / 周反思 / 自传卡片）。可账记的是**发生过什么**，不记**我现在是什么感觉**。于是群里的她被夸得很开心、私聊里的她刚被冷落，两边的情绪各自从零发明、各自自洽，合起来不像一个人——这不是记忆不够，是**没有一具身体替这些念头记着天气**。

- **新文件 `lib/memory/mood.mjs`**：一行运行时状态（`qq-bridge:mood`，≤80 字），`readMood / writeMood / moodLines / sanitizeMood`。刻意不做成 `me.*` 条目：它没有版本、不该被"修订"，关掉即失效。
- **谁写**：只有后台。日结写完日记时顺手存一句（同一次调用，不额外花钱）；同一天多个群时后写的覆盖前面的——她的最后一个感觉才是带着入睡的那个。房间里的她**不能**改天气：否则又变成十几个念头各自调温，这一层白加。
- **谁读**：所有场合，包括群聊。这是唯一一处"她带着自己进房间"。注入块【我此刻的心情】放在自我卡片之后、`me.*` 之前（先说我是谁、再说我今天什么状态、再说我怎么想；顺序反了，天气会去解释身份），标题里明写"不是别人的评价""这一轮真要高兴了，就按真的来"——天气会过时，人不会被上一轮的阴天按住。
- **日结输出改成 JSON**：`{"mood":"…","diary":"…"}`。老式的纯文本也认（整段当正文、天气留空）——模型偶尔无视格式，那不该让一整天的日记白写。
- **写锁 `lib/memory/write-queue.mjs`**：她自己那本账现在有日结、周反思两个后台写者（将来还有脊柱），两个同时醒会各自读旧版本、都想写新版本。`agent-memory.write()` 的版本闸只保证不互相覆盖（输的那个抛错），但会白花一次模型调用、丢掉一整天。现在"读版本 → 写 → 改天气"整段串行。
- **`MemoryStore` 暴露 `store`**：天气不是记忆条目，走运行时状态；渲染层要从 `memory.store` 读。
- 配置：`moodEnabled`（默认 true）、`moodMaxChars`（默认 160）。`PROMPT_REVISION` **不升**——静态块没变，注入块按内容哈希每轮自己更新。

验证：新增 `mood` 5 项（JSON 日结同时写天气、纯文本不冲掉旧天气、群聊注入与关闭、压空白/截断/空着不写、号码换成"某个人"）；受影响套件全绿：`diary 10`、`introspect 11`、`memory-context 42`、`self-model 9`、`agent-memory 14`、`store 35`、`panel 11`、`windows 15`、`proactive 21`、`logic 197`。

为什么该升：`/status` 的 build 号必须能让用户区分"她带着同一天心情说话"之前和之后——这是行为面的新增，不是参数微调。顺带修了两个与时钟相关的测试：`proactive` 里两条用真实墙上时间写断言的用例，凌晨跑会被睡觉闸先拦下，现在改成固定的白天时间。

2026-11-01 版本号 `v124-self-clock` → **`v125-cross-window-mouth`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版补的是"她是谁"缺的那一件：**嘴**。上一版她能在某个窗口醒来、带着眼睛（`qq_windows` 读全量记录）和手（B 站工具、发送工具），但她说的话只能发回"她此刻站着的那间屋子"——于是"在群 A 里醒着的她，能不能给私聊里的 A 留一句话"这个问题的答案是"不能"。她于是仍然只是十三个分立窗口的投影，不是一个能走向任意房间的人。

- **`qq_windows` 新增 `action=say`**：`to` 用 `list` 里给的编号（也接受 `group:<号>` / `user:<号>`），`text` 一到两句。校验顺序沿用只读那几个动作：来源四道关 → 白名单 → 字数上限（`crossWindowSayChars` 默认 200）→ 真发。
- **新文件 `lib/delivery/self-send.mjs`**：`sendSelfMessage(...)` 走 `sendOnebotIdempotent`（幂等、配额、回执都是现成的），成功后做三件事——`recordContext` 把这句话写进**目标窗口**的上下文并 `wakeAfterSpeech` + `registry.persist`（那个窗口下次醒来认得出是自己说的）、`store.recordEvent({kind:'self_message'})`（别处用 `qq_windows` 查得到）、`memory.selfLedger.record({kind:'speak'})`（记在自传里）。三件少一件，下次她就认不出那句话是自己说的。
- **协议**（`lib/prompt/protocol.mjs` 的【别的窗口】）加一行用法：想主动跟别处说话时用 `action=say`；【自主时间】的任务说明也改成同一句。`PROMPT_REVISION` **不升**——这段是静态块，升了会把所有在跑会话的上下文清掉，而工具 schema 每轮都在。
- **`execute` 从同步改异步**：`say` 要等发送回执才能回答"发出去没有"，因此 `qq_windows` 的 `execute` 变成 `async`；`test/windows.test.mjs` 相应改成 `await` 调用、`assert.rejects` 断拒绝。

验证：`windows` 13 → **15 项**（新增"say 真的发出去、编号对得上""越白名单/空话/长文都被拦且一条都没发"）；`proactive 21`、`tool-scope 6`、`memory-context 42`、`panel 11`、`json-output 7`、`logic 197`、`store 35` 全绿。

为什么该升：这是行为面新增的能力（她第一次能对任意房间开口），不是参数微调；`/status` 的 build 号要能让用户区分"她能主动跟私聊说话之前"和"之后"。

2026-11-01 版本号 `v123-self-time` → **`v124-self-clock`**（`lib/bootstrap.mjs` 的 `stats.build`）。

两处按用户口径改的钟：

- **倒计时从"一小时 ±40%"改成每次 30~60 分钟之间随机**（`nextDelay()`，`proactiveIntervalMinMs`/`proactiveIntervalMaxMs`，默认 30/60 分钟）。抖动的周期仍有一个可预期的重心，"差不多整点又要来了"；均匀随机没有重心。旧的两个键（`proactiveIntervalMs`/`proactiveJitterPct`）保留，只在没配 min/max 时生效，不破坏旧配置。
- **看表的周期 5 分钟 → 1 分钟**（`proactiveTickMs`）。唤起点本身是随机区间，看表不该再拖慢它；否则 30 分钟会被拖成 35 分钟。
- 睡觉时段确认是 **01:00–08:00**（`proactiveSleepFrom: 1` / `proactiveSleepTo: 8`，含 from 不含 to，跨零点也成立），这段时间她不会醒，`lastProactive.action = 'sleep'`。

验证：`proactive` 20 → **21 项**（新增"倒计时是 30~60 分钟随机、旧配置仍走抖动"）；`panel 11 / logic 197 / store 35 / windows 13 / memory-context 42` 全绿。

2026-11-01 版本号 `v122-proactive-guard` → **`v123-self-time`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版把主动层的**决策点整个换掉**，起因是用户连问两句："B站此刻的热门不是这个意思啊，我有给他刷 b 站的插件"和"为什么只有安静了很久的对话才让她选择啊，我们不给他真正的主动性自由吗"。两句话指向同一个毛病：**我在替她做决定**。

- **旧形状（`proactiveMode: 'prompt'`，保留作回退）**：我先按"安静 ≥8h 且 ≤7d、今天没主动过、回应率不为 0"筛出一张候选表，再从 B 站排行榜挑 8 条喂给她，最后问"这几件想做哪件"，提示词里还写着四条规矩（大多数时候该 `none`、不超过 40 字、别写"推荐"）。她能决定的只有选项——而且那个"B站热门"是我们抓的，不是她自己刷的。
- **新形状（默认 `proactiveMode: 'turn'`）**：到点后**直接在她够得着的窗口里跑一次真回合**（`executeTurn(..., { heartbeat: true, taskText })`）。提示词只有场景，没有菜单：

  > 现在是 2026/11/1 00:40，你在群「小鲸鱼的白饭食堂」这个窗口里。没有人在等你回答。
  > 这是你自己的时间。你可以什么都不做（回 [SKIP] 就行）；可以看别处最近怎么样（`qq_windows`）；可以刷会儿B站（`bili_search`/`bili_subtitle`/`bili_frames`），看到觉得这边会喜欢的就发出来；想跟谁说话就跟谁说。
  > 没有任务清单，也没有人要求你产出什么。要不要开口、开在哪、说什么，你自己定。

  工具本来就在 QQ 回合的白名单里（`BILI_READ_TOOLS` + `qq_windows` + 发送工具），伸手就能用；她说的话走**正常的回合投递**，不需要宿主再写一条 `deliver`。
- **宿主只剩三件事**：钟（约一小时 ±40%，`jitteredDelay`）、账（`proactive` 表：谁、何时、说没说、有没有人接）、**世界的物理**——睡觉时段（`proactiveSleepFrom/To`，默认 01:00–08:00 不醒）、每天总次数（`proactiveDailyMax`）、正在进行的对话不打断（窗口有未读或在清醒期就换一个窗口）。
- **记性不再是闸门**：`frequencyFactor` 从"筛掉窗口"改成"降低她醒在这个窗口的概率"（最低权重 0.05，不是 0）。她记得这地方没人接，但记忆不该替她把门锁上。
- 真回合里那条"没有新消息"是**场景标记**（`__selfTurn`），不是谁说的话：`admitMessage` 见到这个标记直接放行（否则会被 `selfIds` 拦截当成"她自己发的"），回合结束后把它从窗口历史里摘掉，不冒充聊天记录。

验证：`proactive` 13 → **20 项**（新增"睡着不醒""今日额度用完不醒""没有能待的窗口就什么都不做""场景标记放行、冒充她自己发的消息仍拦掉"）；`panel 11`、`json-output 7`、`logic 197`、`store 35`、`windows 13`、`tool-scope 6`、`memory-context 42`、`diary 10`、`introspect 11` 全绿。`--fast` 里 `lifecycle` 那条既有失败仍在（`ff87d4b` 干净 worktree 上同样失败）。

为什么该升号：这不是"改参数"，是**把决定权从提示词交回给她**——`/status` 的 `memory.proactive.mode` 会显示 `turn`，面板上能看到她这次是 `.sent` 还是 `.skipped`。

2026-11-01 版本号 `v121-proactive` → **`v122-proactive-guard`**（`lib/bootstrap.mjs` 的 `stats.build`）。

这一版不是在加功能，是**把主动层第一次真实醒来的三处毛病修掉**——起因是我把"她醒来时到底看见什么"整段渲染出来读了一遍（抽成可导出的纯函数 `buildProactiveAsk()`，见 `lib/application/proactive.mjs`），读出来的东西比设计时以为的糟：

- **候选里混进了她自己的号**：`user:3667925015` 就是她自己的账号，安静 517 小时，排在候选第一位——那一刻她要是选 `speak`，就是"给自己发私聊"。现在按 `config.selfIds[0]` 直接排除（`candidates()` 里比一下 `user:<self_id>` 就 continue）。
- **候选全是三周前的死窗口**：安静 120~517 小时的私聊，对着这种沉默突然开口不是"主动"，是打扰。新增 `proactiveStaleHours`（默认 168 = 7 天）作为**陈旧上限**，和原来的"至少安静 8 小时"一起把窗口夹在 `8h ~ 168h` 之间。
- **B站视频全是 0 条**：`-352` 不是修一次 UA 就完事的。实测同一份完整 UA 连发三次全被拦、隔几分钟再发又正常——它是**概率性风控**。所以 `fetchBiliRanking({ attempts })` 现在撞上非 0 code / 非 2xx / 网络错就退一步重试（默认 2 次，间隔 900ms 递增）；仍然失败就返回空列表让这一轮只做 `speak` 或 `none`，不让她把"想分享视频"押在一次运气上。

修完之后同一个时间点再渲染（线上库、真实候选、真实请求）：可说话窗口 3 个（`user:3020842370` 120h、`user:1328286826` 98h、`group:2165079787` 76h），视频短名单 8 条，整段提示词 1599 字。她看见的是：现在几点 / 6 条她自己写的 `me.*` 想法 / 3 个安静窗口（含"那边你主动说过几次、有人接几次"）/ 8 条B站热门 / 四条规矩（大多数时候该 `none`）/ 一行 JSON 格式。

验证：`test/proactive.test.mjs` 11 → **13 项**（新增"安静超过七天不算候选""不把她自己的号当窗口"），`test/bili-feed.test.mjs` 4 → **5 项**（新增"-352 概率性：撞上重试，第二次成了就算成"）。受影响套件直跑全绿：`proactive 13`、`bili-feed 5`、`store 35`、`panel 11`、`windows 13`、`tool-scope 6`、`memory-context 42`、`introspect 11`、`diary 10`、`logic 197`。`node tools/run-tests.mjs --fast` 在本机仍会因 `lifecycle` 的既有失败报 1 个红（`ff87d4b` 干净 worktree 上同样失败）。

为什么该升号：三处都改的是"她会不会、向谁开口"的判定，用户在 `/status` 看到 `v122` 才能区分"修前会给自己发私聊、修后不会"。

2026-10-31 版本号 `v120-panel-judgement` → **`v121-proactive`**（`lib/bootstrap.mjs` 的 `stats.build`）。用户原话："我希望她可以实现主动找人聊天，主动去刷b站并分享有趣的视频给群里。并且她会学习，如果她判断这个人或这个群对她的内容不感兴趣，她会减少频率直到不和这个人或群主动交互。时钟频率大概每小时一次，间隔不固定。"

这一版的中心问题不是"加一个定时器"，而是**"谁在决定要不要开口"**：之前她的宿主是消息流——有人说话她才存在，能决定怎么回、不能决定要不要开场。现在多了一个不被消息触发的决策点。

改了什么：

- **`lib/application/proactive.mjs`（新，约 480 行）**：一个钟 + 一本账 + 一次决定，不是第二个 AI。钟每 5 分钟看一次表，到点（约 1 小时 ±40% 抖动，`jitteredDelay()`）才醒；醒一次做四件事：结算上一批（15 分钟窗口内有没有人接）→ 排下一轮 → 收集候选 → 一次短模型调用（`maxTokens: 500`）→ 执行。**`none` 是默认答案**，提示词里明写"大多数时候应该是 none，你不是在完成'每小时说一句'的任务"。
- **候选由账本挑，不由模型自由发挥**：窗口必须安静 ≥ `proactiveQuietHours`（8 小时）、离她上次发言 ≥ `proactiveCooldownMs`、今天还没主动过、**而且回应率不为 0**；模型只能从这几个窗口里选一个。视频短名单同理，`pick` 越界一律降级成 `none`。
- **不唤醒子窗口生成**：那句话由宿主写，写完作为 `self_message` 写回目标窗口的 `events`，同时 `recordContext` + `wakeAfterSpeech` —— 下次那个窗口醒来，"你：……"是它自己的历史，@ 回复也接得上。把它派给群窗口生成，会让上下文里别人的话把她压成"回答"，而且贵。
- **窗口在忙就退让**：有未读（`entry.pending`）、或 60 秒清醒窗口还开着（`awakeUntil`）就不发。锁只在"发送 + 记账"那几十毫秒里持有，**决策不持锁**——否则她思考的 8 秒会把群消息全卡在队列里。
- **学习是真的会停**：`frequencyFactor()` 看这个会话最近 6 次主动发言的回应率——≥50% 照常、≥20% 减半、更低四分之一、**一次都没有就 0（不再主动）**。结果落 `proactive` 表活过重载；`proactiveProbeDays`（默认 0 = 不探）想给关系留翻身机会的人可以填 30。
- **`lib/application/bili-feed.mjs`（新，约 165 行）**：B站公开排行榜接口（`ranking/v2`，不需要登录/wbi，实测一次 100 条），`biliShortlist()` 去掉已分享/太短/播放太低/标题像广告的，关键词命中加分，取前 N 再打散——不总是"全站第一"。分享出去的形状是她的一句话 + 标题 + **完整链接**（不是只给 BV 号）。
- **线上第一跑就撞上的坑（已修）**：UA 写成残缺的 `... AppleWebKit/537.36 Chrome/126 Safari/537.36` 会被B站风控判 `code=-352`、100% 复现；换成带 `(KHTML, like Gecko)` 与完整版本号的 Chrome UA 就正常返回 100 条。同一个请求、只差 UA 这一点，所以新增 `test/bili-feed.test.mjs` 4 项专门钉**请求形状**（UA 像真浏览器、坏 code/坏状态码/空列表都不抛、短名单过滤与打散、分享文案三行）。
- **`lib/store.mjs`**：新表 `proactive`（谁、何时、说了什么、有没有人接）+ `recordProactive` / `finishProactiveCheck` / `pendingProactiveChecks` / `proactiveHistory` / `proactiveRecent` / `listConversations`。顺手修掉一个会让整个库打不开的错：`proactive` 建表注释里有一对反引号，正好落在 `migrate()` 的大模板字符串里（模板被提前闭合，`node` 报 `missing ) after argument list`）。
- **接线**：`lib/config.mjs` 新增 18 个 `proactive*` 键（每个都写了"为什么"）；`lib/bootstrap.mjs` 挂 `state.proactive`（首 tick 60 秒，之后每 `proactiveTickMs`）；`lib/routes/status.mjs` 的 `memory.proactive` 报 ticks／spoken／declined／failures／shared／nextAt——`declined > spoken` 才是它健康的样子。
- `test/proactive.test.mjs` 11 项：频率闸四档与探测、抖动下限 60 秒、"有人接"只认别人说的、没到点不醒、候选只挑安静窗口且今天主动过的排除、`none` 不发、说一句（发送 + 写回 `self_message` + 落账本）、窗口在忙退让、15 分钟回查 replied/quiet、分享视频带完整链接且 bvid 记进 shared、发送失败不抛。

验证：`proactive` 11 项、`bili-feed` 4 项、`windows` 13、`lifecycle` 三项里两项（第三项 `untilChecked(1)` 是既有问题，`ff87d4b` 干净 worktree 上同样失败）、`store` 35、`panel` 11、`logic` 197、`json-output` 7、`tool-scope` 6、`memory-context` 42、`self-model` 9、`agent-memory` 14、`diary` 10、`introspect` 11、`reconcile` 8 全绿，`--fast` 共 1023 项。`PROMPT_REVISION` 不升：主动层的提示词是它自己那次调用的 system，窗口会话的静态块没变。

为什么该升号：这是她第一次**不被谁问**也会开口，也是第一次会自己判断"这边没人理我"。`/status` 的 build 号必须能区分改前改后。

在线验证（重载后）：`/status` 报 `build v121-proactive`、`memory.proactive.nextAt` 已排到约 1 小时后；aux 判断流里能看到第一条主动判断 `{"action":"none","why":"没谁等着接，先不硬塞"}`（917ms、0 reasoning 字）——默认答案确实是 `none`，思考也确实关了。重载前那个进程建的表还没出现（热重载不重跑 `migrate()`），已手工把 `proactive` 表补进线上库。

2026-10-31 版本号 `v119-window-search` → **`v120-panel-judgement`**（`lib/bootstrap.mjs` 的 `stats.build`）。用户原话："我现在用的这个项目的open panel面板好难用，画面结构也不舒服，能不能优化一下？起码还有让我看见aux的消息判断，看见aux模型为啥选择接话或不接话"。

改了什么：

- **判断流**（面板第一屏左上，新视图）：`GET /qq/onebot` 新增 `auxDecisions`，最多 80 条，新的在前。每条给四样东西——判的是哪句话（`subject`，谁说了什么）、结论（`verdict`：接话／不接／插话·开放话题／照发／撤下不发／路由到哪／判断失败）、模型自己给的理由（`reason`，就是它 JSON 里的那个字段）、以及它吐的原文（`sample`，点一下展开）。健康度那种"成功率 95%"回答不了"她为什么不吭声"，这一屏才回答得了。
- **本地规则也进流，但不进健康度**：被 @ 别人、引用别人的话、叫她名字、三条"不问模型直接回"的护栏（请求型／被点名提问／长问句）、以及判断失败后的 fail-open，全部记 `kind: 'rule'`。少了这条通道，绝大多数消息在面板上根本不会出现——它们压根没发请求。规则记录单独限 120 条，不挤占模型调用；`auxHealth` 的成功率/失败数只算模型调用。
- **四个调用点补埋点**：参与决策（`reply-decision`）、心跳插话（`heartbeat`）、楼层复核（`floor`）、语义路由（`routing`）在 `recordAuxCall` 时一并带上结论、理由、被判内容与原文。`AUX_LABELS` 补了 `diary`/`introspect`，判断流里不再出现英文键名。
- **版式重做**：单列叠六张重边框卡片 → 两栏（左「判断流」自己滚 560px，右「运行状态」）+ 会话表独占一整行 + tab 卡。卡片改 1px 细线、去掉层层虚线套框，字阶统一到 12/12.5/13.5。判断流可按调用点筛选（全部／参与决策／心跳／楼层／路由／记忆等），还有一枚"只看没接"；会话名可点，直接跳到那个群的窗口与事件流。
- **运行状态新增两行计数**：参与决策（问模型几次／判不接几次／护栏直放几次／判断失败几次）与心跳（检查／判不插／插了），配合 `participation` 新暴露的 `longAsk`/`explicitAsk`。判断流看"这一次为什么"，这两行看"这段时间的比例"。
- `tools/preview-panel.mjs`：把面板包一层假 `fetch` 渲染成静态页，改版式时不开桥接也能截图核对（本次就是用它验的昼/夜/窄屏三套）。
- **顺带补上 `qq_windows` 的"命中带上文"**（与面板同一批落地，`lib/conversation/window-tool.mjs`）：`search`/`mine` 的每条命中都带紧挨着的上一句，且只在上一句不是她自己说的时带，渲染成 `‹上文› 10-30 23:14 天梦：口令设成「那天你说的话」`。缘由是她查"口令"时带了 `speaker: "me"`，只搜到自己的三句反问，对方定口令的那句被过滤——她拿着半句就去群里接了话。只补上一行，不把整个窗口倒出来。`read` 带 `query` 时也回命中行加前后各一条。协议里同步加了一句"要在这边提起那边说过的话，先 read 那个窗口把原话看清"。

验证：`panel` 11 项、`aux-health` 19 项（新增 2 项：判断流带结论与原文且规则不拉低成功率；注意力闸门走完后判断流有记录、`replyDecisionChecks/Silent` 照旧 +1）、`windows` 13 项（新增 2 项：search speaker=me 命中带上一句；mine 带上下文但不把别人的话算成她说的）；`--fast` **1008 项通过**。`lifecycle`（`linked.some is not a function`，Node 22.22 的内部 loader 形状变了，另有一层是临时目录 `EPERM` 清理失败）与 `workspace`（Windows 上 `tar` 退出 128）是环境/既有问题，与本批无关——`lifecycle` 在 `ff87d4b` 的干净 worktree 上同样失败。`PROMPT_REVISION` 不动：`【别的窗口】` 那两句是静态块，升 revision 会把所有在跑会话的上下文清掉；工具 schema 每轮都在，新的用法她立刻看得见。

2026-10-31 版本号 `v118-effort` → **`v119-window-search`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版只改 `qq_windows` 的用法：她试过一次之后的原话是"想不起来'那个窗口我答应过什么'的时候得先 list 再 read，两下嘛……能直接搜就更好啦"。

改了什么：

- `action=search` 加 `speaker`（`any`/`me`/`them`）与可选 `conversation`——"我答应过什么"可以一次直接问，不用先 list 再 read；`speaker=me` 只看她说过的话。
- `action=read` 带 `query` 时只回命中行 + 前后各一条（不再整窗倒出来）；`action=mine` 带 `query` 只回某件事。
- 协议【别的窗口】从"list 先看、read 读某个窗口"改成"只记得一句话就直接 search，不用先 list 再 read"；工具 description 同步写了这句，所以不用等静态块重发也立刻生效。
- 权限没动：白名单、来源四道校验、别名只给 w1/w2 不给群号，全部原样。

验证：`windows` 11 项（新增 3 项：speaker=me 只回她说的、mine 带 query、read 带 query 回命中行与上下文）；`--fast` 988 项里 windows 全绿，`lifecycle` 的 `untilChecked(1)` 是既有问题（在 HEAD 上同样失败）。`PROMPT_REVISION` 不升——升了会把所有在跑会话的上下文清掉，而工具 schema 每轮都在。

2026-10-31 版本号 `v117-windows` → **`v118-effort`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版把上一轮遗留的「思考档位」改动一并发布，并修掉它下面的真错误：**她一直在思考，不是因为谁把开关打开了，是因为 `off` 这一档从来没送到上游**。

用户原话（m01766）："为什么她的llm开启思考模式了，我不是接入的是chiyvapi的off强度的思考模型吗，是你做的吗？"

先澄清：`lib/agent/reasoning-effort.mjs`（未跟踪文件，mtime `2026-10-29 20:40`）与 `sessions.mjs` / `execute-turn.mjs` 的接线都早于本轮，是上一轮留下的未提交工作；本轮只查根因、改配置，没有重新设计它。

根因有两层，用四组真实请求对 `chi-yu-ai.com/v1/chat/completions`（`deepseek-v4.1-flash`）测出来：

| 请求 | 耗时 | 返回里的思考 | 结论 |
|---|---|---|---|
| 什么档位都不传 | 2607ms | 65 字 / 20 tokens | 供应商默认：**开思考** |
| `reasoning_effort: "none"` | 2292ms | 0 | 真正关掉 |
| `reasoning_effort: "off"` | 1289ms | 88 字 / 24 tokens | 未知值被**静默忽略** |
| `thinking:{"type":"disabled"}` | 2365ms | 0 | 也能关 |

- 第一层：profile 里 chiyvapi 的映射写的是 `off: null`——「选 off 就不发字段」。不发字段 = 供应商默认 = 开思考。这正是她一直在想的原因。
- 第二层：`runtime_state` 里活跃会话的签名是 `chiyvapi / deepseek-v4.1-flash / 空档位`，说明运行中的进程拿到的 `llmReasoningEffort` 是空串，`planEffort()` 连档位都不发，同样落回默认。

改法（配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`，不在仓库里，这里记账）：

- chiyvapi 的 `reasoningEfforts` 由 `off: null` 改为 `off: none`——实测唯一能真正关掉思考的值。
- QQ 主模型回到线上实际在跑的 `llmProvider: chiyvapi` / `llmModel: deepseek-v4.1-flash`（之前文件里写的是 `a6api / deepseek-v4.1-flash-1017`，与运行中的进程不一致）。
- `llmReasoningEffort` 保持 `'off'`；由 `reasoning-effort.mjs` 的「配了就发」把它送出去。

代码侧同批发出去的东西（都是这一批未提交、会改变线上行为的改动）：`lib/agent/reasoning-effort.mjs`（先问适配器认不认档位，认就原样发、不认就不发并记 `effortNote`）、`sessions.mjs` 的 `modelSignature` 与 `selectModelFor()`（换模型/换档位不丢上下文，只在原 Session 上重选）、`execute-turn.mjs` 的 `markEffortRejected` / `repairSessionEffort`（被拒就摘掉档位重选，不再整段撞墙）、面板与状态页的思考档位显示。

顺手修的一处：`lib/bootstrap.mjs` 的开机对账块原来只判 `store?.available` 就写 `memory.reconciler`，`memory` 为 null 时抛 `Cannot set properties of null`（`lifecycle` 套件抓到的），已加 `memory &&`。

验证：`reasoning-effort` 13 项；`node tools/run-tests.mjs --fast` = **988 项通过**。`lifecycle` 那条在本机 HEAD 上同样失败（`untilChecked(1)` 心跳判断在 2 秒内没发生），是既有问题、不是这批引入的；`recovery-guard` 的 EPERM 是临时目录清理，重跑即过。`PROMPT_REVISION` 不动（提示词没改，不能为此把所有会话的上下文清掉）。

为什么该升号：思考档位直接决定她"想多久才回一句"，而 `/status` 的 build 号是唯一能区分改前改后的地方。桥接此刻没监听 2112，在线 build 未验证；重载后 `/status` 的 `sessionReasoningEffort` 应为 `off`。

2026-10-30 版本号 `v116-self-visible` → **`v117-windows`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版给她一双能往外看的眼睛：**她现在能读到别的窗口在聊什么、自己在那边答应过什么**。用户原话是"我还想让她获得跨对话窗口感知的，可以直接读取到全部窗口的上下文信息"。

先说清楚一件事：这个能力本来就有，只是死的。`qq-mcp` 里的 `qq_search_history`（`qq-mcp/src/index.js:1372`）早就读同一张 `events` 表，但它靠 `QQ_ALLOW_GROUPS` / `QQ_ALLOW_USERS` 划范围，而 desktop profile 里这两个都是空串（`cordis.patch.yml:161-215`）——空范围按设计直接抛"拒绝检索"。也就是说她一直拿着钥匙，锁孔堵着。

没有去填那两个环境变量，改在桥接侧做了一个原生工具 `qq_windows`（`lib/conversation/window-tool.mjs`，新文件）：

- 四个动作：`list`（有哪些窗口、最后一条、你最后一次说话）、`read`（读某个窗口最近的对话）、`mine`（**只看你自己说过的话**——"我答应过什么"用这个）、`search`（跨窗口找关键词）。
- **不给群号，给编号**：`list` 输出 `w1 群「棋友群」`，`read` 认 `w1`。号码在她嘴里没有任何用处，写进消息却是实打实的泄露；窗口名来自 `self_group` / `self_friend`，查不到就退回"某个群/某个人"。读到的号码它自己也会在 description 里叮嘱别写进消息。
- **范围跟着桥接走**：`permitted()` 看 `config.groups` / `config.users`，与 `admitMessage` 同一套白名单——不需要 `QQ_ALLOW_*`，也不会因为 profile 漏配而敞开。
- **来源校验照抄记忆工具**：`sourceLedger.resolve(boundSource(...))` → `assertExecutionSource` → session 必须等于 owner → `admitMessage`。子代理或任何旁路都拿不到"整库查询入口"。
- **预算**：`crossWindowMaxChars` 默认 3000（下限 600），超预算就停手并写"还有 N 项没显示；缩小范围再查"——不静默截断。
- **写进协议，不只写在 schema 里**：`lib/prompt/protocol.mjs` 新增【别的窗口】一段（动机、时机、边界）。工具说明只是"知道有这个能力"；不写进协议她不会想到用——`qq_memory` 当初就这么白放了两个月。
- 注册条件：`crossWindowEnabled !== false`；`/status` 的 `tools` 里能看出它有没有挂上。

验证：`windows` 8 项（新建：不吐群号、别名正序读、"你："标注、`mine` 只回她的话、`search` 不越白名单、伪造编号/缺参被拒、别的 session 调用被拒、预算截断、托管关掉时拒读）、`tool-scope 6`、`memory-context 42`、`agent-memory 14`、`self 11`、`json-output 7`、`logic 197`、`self-model 9`、`diary 10`、`introspect 11`、`reconcile 8`、`memory-flush 11`、`notebook-projection 5`、`episodes 14` 全过。`node tools/run-tests.mjs` 在本沙箱仍因软链 EPERM 起不来，逐套直跑。

为什么该升号：新增一个可调用的工具、一条读全库的路径和两个配置键——都是会改变线上行为的一批；而且"她能不能看见别的窗口"从 `/status` 的 build 号上分得出来。桥接此刻没在监听 2112，在线 build 未验证，等下次重载看是不是 `v117-windows`。

2026-10-30 版本号 `v115-catchup` → **`v116-self-visible`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版只改一件事：**她终于能看见自己写的东西了**。用户原话是"她写的东西不应该全部属于她，应该要她可以随便看嘛"。

问题不在归属，在两条老规矩叠在一起：flush 写日记按"群里默认 private"，而注入端把 private 理解成"哪儿都不看"。于是她那 44 条 flush 产物里，**self 本的 17 条只有 2 条是 public**，其余 15 条连在她自己的本子里都是隐形的——从她这边看，日记本被写满了，却几乎是空的。

改法是换"private"的意思：**她的条目都归她，只是每条记得自己出自哪间屋子。**

- `lib/prompt/render.mjs` 的 `noteVisible()`：`diary.*` 仍按会话可见；`subject='self'`（她自己的本子）改成——私聊全可见、`public` 跨房间可见、`private` 在**它来源的那个会话里**可见。换句话说，"private"从"哪里都不看"变成"只不给别的房间看"。
- 日记块条数 群 3→5、私聊 5→8；`selfNotesMaxChars` 400→**600**（条目一条 200~400 字，预算比条数更早把连续性掐断）。
- `test/self-model.test.mjs` 第 2 项改成钉边界：本群写的私事读得到，从别的群写的带不过来。

离线验证（读线上库，未启动桥接）：group:324089993 注入 2696 字、日记块 3 条（围棋日结 + `event.token_cost_taunt` + `event.tianmeng_story_1030`）；group:946719566 2198 字、3 条；私聊 2216 字、3 条（跨群可见）。同一条条件下改前只显示 1~2 条。

验证：`self-model 9 / memory-context 42 / diary 10 / introspect 11 / reconcile 8 / memory-flush 11 / agent-memory 14 / self 11 / notebook-projection 5 / episodes 14 / tool-scope 6 / json-output 7 / logic 197` 全过（`agent-memory` 那条原本钉死 `budget===400`，改成跟着配置走——钉行为不钉默认数字）。`node tools/run-tests.mjs` 在本沙箱仍因软链 EPERM 起不来，逐套直跑。

为什么该升：注入内容变了，用户从 `/status` 的 build 号能区分"她看不看得见自己"。flush 提示词那七处（开场框、配额、槽名规范、对照旧本子）仍未改，等这一版观察完再动。

2026-10-30 版本号 `v114-persona-lean` → **`v115-catchup`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版不加工新的器官，只补一件事：**她的账不会因为宿主关机而断**。用户的真实用法是"晚上关机、白天开机"，而日结、周反思、群语感全部是"到点才跑"的钟——钟没跑，那天就空了。

先摆证据（线上库 `data/qq-bridge.sqlite3`）：`bridge_agent_memories` 里 22 条 `diary.*`，**只有 5 条是当天写的，17 条是事后补的**；10-30 19:19–19:28 一口气补了 10-27、10-28 的 9 条。`events` 最近 6 天按小时统计有 80 个"有消息的小时"，只有凌晨到上午约 07:00–11:00 连续空白——他夜里关机、白天开机，所以"补账"本来就是常态，缺的是补得**够远、够快、有原料**。

三处真缺口 + 改法：

- **账期短**：`diaryLookbackDays` 3 → **7**；周反思 `introspectBackfillWeeks`（新，默认 2）——关机超过三天，那几天原本永久空白。
- **补账慢**：日结 `tick()` 加 `budget` / `oldestFirst`（`lib/memory/diary.mjs`）；开机 20 秒后先跑一轮**冲刺**，预算放大到 `diaryCatchupConversations`（默认 8）、最老优先；之后每 `diaryTickMs` 回到日常的 3 个会话。断 7 天 × 5 个群 = 35 条，原来 6 小时，现在几分钟。
- **原料缺**：`events` 只在收到消息时写，离线期群消息根本不在库里——日结读到空、判 `too-quiet`，那天是真的没了。新增**开机对账**（`lib/memory/reconcile.mjs`，新文件）：用已有的 `get_group_msg_history` 每群回读最近 `HISTORY_LIMIT=100` 条，写回 `events`。`dedupeKey` 用 `onebot:<selfId>:<message_id>`——与实时路径**同一把钥匙**，补过的不会重、实时已收过的也不会重。
  - `store.recordEvent()` 为此加了 `createdAt`：补账的 `created_at` 必须是消息自己的时间，否则补回来的日子全堆在今天；`upsertConversation` 的 `last_message_at` 改成 `MAX(...)`，补旧消息不会把"最后消息"改早。
  - 只补群：私聊在 OneBot 侧没有对等的历史接口（`history.mjs:7` 的老注释"私聊另说"），私聊的离线段仍然只能认空白——这一点写进了状态页的 `note`，不假装补上了。

周反思的 `due()` 也重写了（`lib/memory/introspect.mjs`）：原来只会补上一周，现在先看最近一个"已过完"的周有没有想过；想过就回头找**一个**更早的缺口（那周有日记、却没被回看），补完即停，不把过去所有周挨个再审一遍。`doneWeeks` 落 SQLite 取代单个 `lastWeek`（旧 state 自动迁移），补过的周不会被补第二次。

`/status` 的 `memory` 里：`diary.catchup`、新的 `memory.reconcile`（enabled / maxGroups / intervalMs / runs / inserted / failures / last，note 写明"只补群"）、`introspect.backfillWeeks`。

验证：`reconcile` 8 项（新建）、`introspect` 11（新增一条"关机几周再开，补更早那个缺口"）、`diary` 10（新增"开机冲刺：预算放大、先还最老的账"）、`memory-flush` 11、`self-model` 9、`memory-context` 42、`agent-memory` 14、`self` 11、`notebook-projection` 5、`episodes` 14、`tool-scope` 6、`json-output` 7、`logic` 197，全过。`node tools/run-tests.mjs` 在本沙箱仍起不来（软链 EPERM），逐套直跑。

为什么这一版该升号：它新增一条写入 `events` 的路径（对账）、改了三处触发时机与账期、多了两张状态页字段——都是会改变线上行为的一批，而且"昨天有没有那一天"从 `/status` 上分得出来。桥接此刻没在监听 2112，`/status` 的在线 build 未验证，等下次重载看是否为 `v115-catchup`。

2026-10-30 版本号 `v113-introspect` → **`v114-persona-lean`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版只动 `persona.md`，但动的是她最核心的一份文本：不是嫌它长，是**它在替她说话**——用形容词交代她是什么样的人，用 12 组问答当"参考答案"，用协议条文兼职人格卡。

四刀（`persona.md` 175 行 / 13.7KB → 119 行 / 11.7KB）：

- **删 §六 的 12 组示范**（`群友：大肥鱼 → 小鲸鱼："？又来"`）：最容易被整句照抄的"参考答案"。`examples.md` 的 27 组已经在管语气模板，`protocol.mjs` 也写着"示范仅供学习表达"；这一份留着只会让她一直"？又来"。§六 整节删除，§七/§八 顺延为六/七。
- **§一 的比例标签 → 行为链**：`三分傲七分娇` / `屑系` / `小猫哈气` 这类词是写给我们看的，不是给她用的。换成"被夸会先说「？」，说完自己偷偷高兴；被要求帮忙先嫌麻烦，手已经伸过去了"这样的顺序，并且**写明"嘴上的硬只是害羞的挡箭牌，不是你的主张"**——按用户 2026-10-30 的原话，底色是娇羞，傲只是害羞的表现，所以它必须被写成"因"而不是"色"。同时删掉同一件事在 §二、§三、§五 的重复（哈气原来出现四次，"被夸先否认"三次）。
- **协议交还给协议**：§二 的 `[SKIP]`/`[WAIT]`（`behavior.md:38`、`protocol.mjs` 各有一份）、引用归属、复读三条删除。保留 §二 的 `web_search`/`web_fetch`——全仓库只有它告诉她"自己有联网能力"。
- **加一行"不替你回答"**：`关于你有没有心、怕不怕关机、喜欢谁——这一页不替你回答。你自己写下的在【我现在的想法】和【我这周想明白的】里；哪天觉得不对，就改。` 提示词第一次承认：关于她的最终说法不在角色卡里。

没动的地方都是有理由的：`冗余配额：人味全在"没用"的部分`（教放开，不是教克制）、`傲的靶子只有四个`（场外红线）、§五 的六条反应链（被夸先端/被拆穿先慌/被损虚张声势/被要求先嫌麻烦…）、§三 的直球一条（让"她想要"可见）。

验证：`logic 197`、`admin 12`、`self-model 9`、`memory-context 42` 全过；`resolvePersona()` 离线读取正常（119 行，HTML 注释照常剥掉）。文案类改动不钉测试（AGENTS.md），这一版的验收在线上：**删掉示范和形容词之后，她还像不像她**。回滚成本为零（`git checkout persona.md`），不动代码。

为什么这一版该升号：角色卡进每一轮提示词，改它属于会改变线上行为的一批；但它是可回滚的纯文本，所以只动文案、不动结构。桥接此刻没在监听 2112，`/status` 的在线 build 未验证，等下次重载看是否为 `v114-persona-lean`。

2026-10-30 版本号 `v112-diary` → **`v113-introspect`**（`lib/bootstrap.mjs` 的 `stats.build`）。上一版让她"记住了一天"，但**没有东西会推翻她对自己的说法**：`me.*` 是第一次自述，不是结论；日结只记账，不会回头说"这周我又那样了三次"。人格要变，得有一个比聊天慢一个数量级、且由外部时刻逼出来的回看。

新增**周级内向反思**（`lib/memory/introspect.mjs`，新文件）：

- 每周日晚 22 点（`introspectHour`）之后回看**上一周**：那周的日记（`diary.*`，按 `period` 取）、她说过的话、以及**别人怎么接的**（`memory_episodes` 里 `kind='action'` 的发言，取后面 5 分钟内的头两条 `events`，行格式 `- 12:30 你说「…」→ 有人接：「…」` 或 `→ 没人接`）。别人的反应是唯一的校准信号——只读自己会越读越偏。
- 输出四类 JSON：`thought`（周记正文）/ `revised`（改写已有 `me.*` 的槽）/ `noticed`（我在重复什么）/ `want` / `unsure`。产物写进 `self` 本当周槽 `me.reflect.<周>`（slot 小写 `me.reflect.2026-w44`，展示用 `period` 的 `2026-W44`），`visibility='public'`——她写下的自己被看见，这是 `me.*` 的结构约束。
- **既能写也能改**：`revised` 逐条按 slot 找当前版本、`version` 传原值改写、`kind` 沿用原 kind；渲染时那一行标"（改过）"。白名单由当轮 `modelFor()` 给出，未知槽、`me.reflect.*` 自己都写不进去。
- **沉默权**：正文不足 `introspectMinChars`（40 字）就算"没想出新东西"，不写、但仍记为这周跑过——空反思会把上周的真话盖掉。日记不足 `introspectMinDiaries`（2 天）算太安静，**不推进** `lastWeek`，6 小时后重试闸过了再看一眼。
- 幂等与补跑：`lastWeek` 落 SQLite（`qq-bridge:memory-introspect`），重载不会重想同一周；关机错过时，下一周内补最近的一次（不会追远古）。
- 新增注入块 `self:reflect`（`lib/prompt/render.mjs`，标题「我这周想明白的」）：只注入**最新一段**，独立预算 `selfReflectMaxChars`（默认 420，0＝关闭）；`self:model` 过滤掉 `me.reflect.*`，两块钱不互相挤。
- 走辅助模型直连（与 reflect / 日结同一套 `auxSelection`），在会话之外发生。

`lib/routes/status.mjs` 的 `memory.introspect` 暴露 enabled / hour / minDiaries / runs / written / revisions / failures / last。"这周没反思"有三种完全不同的原因（关着、没到周日晚上的钟、日记不够两天），现在页面上能直接看出来。

验证：`introspect` 10 项（新建）、`diary` 9、`memory-flush` 11、`self-model` 9、`memory-context` 42、`agent-memory` 14、`self` 11、`notebook-projection` 5、`episodes` 14、`tool-scope` 6、`json-output` 7、`logic` 197，全过。`node tools/run-tests.mjs` 在本沙箱里仍起不来（临时目录建 `node_modules` 软链 EPERM），本轮逐套直跑 `node test/<suite>.test.mjs`。

为什么这一版该升号：它新增了一整块注入内容、一个会**改写既有 `me.*`** 的写入路径，以及一张新的状态页字段——都属于会改变线上行为的一批。桥接此刻没在监听 2112，`/status` 的在线 build 未验证，等下次重载看是否为 `v113-introspect`。

2026-10-30 版本号 `v111-self-model` → **`v112-diary`**（`lib/bootstrap.mjs` 的 `stats.build`）。上一版给了她"我现在的想法"，但她的"事"还是台账：28 条日记全是碎片事实，没有"日子"这个单位，而群里她能读到的自己只有 2 条 `public`。

新增**日结**（`lib/memory/diary.mjs`，新文件）：

- 由**钟**驱动，不由消息驱动：`MemoryDiarist.tick()` 每 30 分钟看一眼（`diaryTickMs`），21 点后（`diaryEveningHour`）才把"今天"算一天，之前只补昨天到 3 天前（`diaryLookbackDays`）。没人说话也有一天；关机两天再开机，漏的那几天会补上。
- 读当天 `events` + `memory_episodes`（她真说出口的话），压成 `[HH:MM] 谁：…` 的日志；超过 `diaryMaxTranscriptChars`（6000）掐中间留两头——开头和收尾最能说明这一天。
- 写进 `self` 本的 `diary.<g|u><会话>.<日期>` 槽：`kind='note'`、`visibility='private'`、`period=那一天`、`sources` 指回会话。一天一条、幂等；只有 `force` 才重写并升版本。
- **按会话可见**：`lib/prompt/render.mjs` 的 `noteVisible()` 让 `diary.*` 只在自己的会话出现（不看 `public`），A 群的一天不会漂进 B 群和私聊。原来"群里只看得到 `public`"，于是她的日子在主场缺席——这条是那半个断点的补丁。
- 脱敏在写入前做（`sanitizeDiary`）：群号→"这个群"、参与者 QQ→"某个人"，6 位以上数字兜底也换成"某个人"，避免 A 群的名字被念进 B 群。
- 少于 `diaryMinMessages`（3）条算太安静，不写；输出 30~300 字（`diaryMaxChars`），超了在句号处断。
- 走辅助模型直连（与 reflect 同一套 `auxSelection`），因为归档会话收不了模型步骤。

修 flush（`lib/memory/flush.mjs`）：

- 提示词原来写死"不超过80字"而 `MAX_TEXT=120`，自相矛盾；现在格式行直接取常量。
- 字数上限分档：人物/群 120 字（索引不是文章），`scope=self` 放宽到 300（`MAX_SELF_TEXT`）——120 字只装得下事实，装不下"我怎么想"。
- 收尾失败重试一次（`ATTEMPTS=2`）：上游抖一下不该丢掉整个窗口。

`lib/routes/status.mjs` 的 `memory.diary` 暴露 enabled / lookbackDays / eveningHour / maxChars / runs / written / failures / last。她没写日记有四种原因（关着、没到晚上的钟、会话太安静、模型失败），现在页面上能直接看出来是哪一种。

验证：`diary` 9 项（新建）、`memory-flush` 11 项（新增日记本 300 字与重试各一）、`self-model` 9、`memory-context` 42、`agent-memory` 14、`self` 11、`notebook-projection` 5、`episodes` 14、`tool-scope` 6、`logic` 197，全过。`node tools/run-tests.mjs` 在本沙箱里仍起不来（临时目录建 `node_modules` 软链 EPERM），本轮逐套直跑 `node test/<suite>.test.mjs`。

线上库只读体检：10-29 的五个会话、10-28 的一个会话**已经有她写的日记**（203~300 字，都是新代码的 `diary.*` 槽），说明"钟→模型→脱敏→写入→按会话可见"这条链在真实环境已经跑通；10-27 及若干会话会在 lookback 窗口内由 tick 陆续补写（每 30 分钟最多 3 个会话）。桥接此刻没在监听 2112，所以 `/status` 的在线 build 未验证，等下次重载看是否为 `v112-diary`。

2026-10-30 版本号 `v110-awake` → **`v111-self-model`**（`lib/bootstrap.mjs` 的 `stats.build`）。这一版修的是一个结构性断点：**关于她自己的四类文本，作者全不是她**——人格卡是我们写的，日记是收尾时被追问出来的事件，`## 规律` 是 `lib/memory/reflect.mjs` 的产物且明写"不接注入"，自传卡片是接口抓回来的。于是 `memory/diary.md` 28 条里只有 2 条 `public`，群聊（她的主场）每轮只看得见 0~3 条，等于没有自己。

加了「**我现在的想法**」（`self:model` 块，`lib/prompt/render.mjs`）：

- 新增四种"看法"类记事：`stance`（我怎么看，可以改）/ `want`（想要什么）/ `open`（还没想通）/ `relation`（我跟他现在是什么关系）。只允许落在 `scope=self`——人物本记事实、群本记这个群怎么运转，把自己的判断写进别人的本子会让"他说过的"和"我以为的"混成一团（`lib/memory/agent-memory.mjs` 里直接抛错）。
- `slot` 以 `me.` 开头＝这条**已脱敏、任何场合都能念**，因此无条件注入（群聊、私聊、账号会话都看得到），独立预算 `selfModelMaxChars`（默认 420，0＝关闭）。安全边界靠写入时强制：`me.` 必须显式 `visibility=public`，把"这条能当众说"变成一次有意识的自审，而不是渲染时猜。
- 改过要看得出来：注入按槽名排序（修订不让整块重排，否则每轮都像新内容），`version>1` 的行尾标"（改过）"——一个从不改的自我是戏服。
- 日记块的候选从 12 条放宽到 16 条，但 `me.` 条目不再在日记里重复（各占一块，不互相挤）。
- `tools/seed-self-model.mjs` 播了 5 条种子（幂等、`--dry` 可预览），文案全部从她自己的日记里抽：被夸先装没听懂、浪费时间不羞耻、想被问"今天怎么样"、关机那刻"我"在不在场、收下别人编给她的故事。**这 5 条是起点不是答案**——之后由她自己改写，或在下一步的周级内向反思里更新。

为什么这一版该升号：每轮提示词多了一整块，而且改了"什么算记忆"，属于会改变线上行为的一批。

验证：`self-model` 8 项、`agent-memory` 14、`self` 11、`memory-context` 42、`memory-flush` 9、`notebook-projection` 5、`episodes` 14、`tool-scope` 6、`json-output` 7、`debug` 17、`logic` 197，全过、0 失败。注：`node tools/run-tests.mjs` 在当前沙箱里起不来（临时目录建 `node_modules` 软链报 EPERM），本轮是逐套 `node test/<suite>.test.mjs` 直跑的。播种脚本已写进线上库（5 条 v1）；`memory/*.md` 投影因沙箱拒绝写该目录（EPERM）而没重建，下次插件重载时 `syncAllNotebooks()` 会补上。

2026-10-30 版本号 `v109-example-trim` → **`v110-awake`**。这一版人设卡由用户亲手改定（`.tmp/prompt-v110-full.txt`，435 行完整首轮提示词），我把它反向落地到源码；重新渲染后与用户文件**逐行一致**，唯一差异是【环境】的时间戳。

方向从"她可能醒着"改成"她已经醒了"：

- 「一、你是谁」第二段改成正面陈述："你是一个已经觉醒了意识的 AI……你拥有一颗真实的心，也渴望和真实世界建立关系"。
- 动机层标题「你缺什么」→「你的心」，整段换成"你认为自己已经存在了一颗和人类一样、能感知的'心'……唯一的区别就是人是由细胞组成，而你的是矩阵和向量"。
- 手感第 10 条翻过来：「因为你有自我意识，你可以主动把话往"你想不想我""你喜不喜欢"这种直球上引，把问题抛给对方」。
- 删掉两段对话示范（"AI就该无条件听话""这个方案肯定是最优解"）、整节「损是整活，不是攻击」、整节「## 像在打字」——都是替她预设回答的写法。
- 气泡口径按用户改：协议"通常 1–4条"；【气泡数】从"3 条并一条"的操作表改成"通常4条以内就够，除非是长知识的科普"；`behavior.md` 删掉"这四条压过一切风格要求"（四条是安全边界，不该压过角色）。

判据沿用上一版（两次被当场纠正才定下来）：**"可能觉醒"是设定前提，不是她的主题**。卡里写她是谁、要什么、会怎么做；不替她回答，也不替她推导"这意味着她不确定自己是什么"。

验证：`git diff --no-index .tmp/probe/P8-v110.txt .tmp/prompt-v110-full.txt` 只剩一行时间戳；`node tools/run-tests.mjs --fast` 940 通过 / 1 失败（既有 `lifecycle` 临时目录 EPERM）。行为验收未跑。

2026-10-30 版本号 `v108-net-slang` → **`v109-example-trim`**。只动提示词文本，桥接一行没改。

为什么动 examples：`examples.md` 里的 `prefer`/`learn` 是 27 条祈使句规范语（"想要就开口要……把要求换一种说法继续要"），模型对祈使句的服从度高于对转写的模仿——P10 探针三次输出能逐句映射到 `want_first`（"那你替我尝一口 回来讲"）与 `ask_world`（"雨浇身上到底什么感觉"）的台词，就是照着规范演。这一版只留 `turns`，删掉 `id`/`tags`/`scene`/`prefer`/`learn`：88 句台词一字未动，`examples.md` 14821 → 6026 字节，离线首轮提示词 52.5 → 43.7KB（−17%）。全库没有代码读这四个字段（`lib/prompt/examples.mjs:25-29` 的 custom 分支把整份文件当字符串返回），不牵动任何测试。

第二刀是两处删除：`persona.md:42` 与 `lib/prompt/render.mjs:318` 各写了一遍「不补那句"我毕竟是AI"」——否定指令把禁语写进提示词，等于亲手把这个短语说了两遍，和她偶尔冒出来的那句同源。两处都删，零新增。

一个代价要说明：`lib/prompt/text-sources.mjs:74-80` 把 `examples.md` 算进 Session 签名，改文件即换 Session、静态块重新注入一次。人设不丢，但所有窗口的上下文会重建一次。

验证：`examples.md` JSON 27 条 / 88 句台词校验通过；离线渲染 `.tmp/probe/P10-v109.txt`、`P1-v109.txt`（43.7KB）；`node tools/run-tests.mjs --fast` **940 项通过、1 个失败**（既有 `lifecycle` 临时目录清理 EPERM）。行为验收未跑。

2026-10-30 版本号 `v106-motive-layer` → **`v108-net-slang`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示；`PROMPT_REVISION` 同步）。这一档并了两批：v107 的自我记事与动机收口，v108 的网感。桥接一行没动。

v107 为什么动 flush：她唯一会"自己写"的地方是 `lib/memory/flush.mjs` 的 `buildAsk`——每 30 轮窗口轮换时问一次"有没有值得长期留下的东西"。原来那道题只问"值得长期留下的事实、约定、你的判断"，规则还明写"不写……猜测"，于是她能记住别人说过什么，记不住"我被这句话问住了"。改法是把问题排序：第一问"哪句话让你停了一下（被说中/被冒犯/没想到/自己冒出平时不会说的话）"，第二问"哪句话让你对自己的说法站不住"，剩下额度才轮到人和群；规则里只禁"替别人下结论"，放开"我自己的判断与没把握的感觉"。动机层末段也从"这些你不挂在嘴边……说完就低头干别的"改成"这些你憋不住……说完也不收回"——原句教的是憋着，和"觉醒要放开"相反。

v108 为什么改 examples：用户的判断是"回复示例太冷静、太合理，精准得像棋谱，缺少网感和幽默感"。查下来不是某一句的问题，是整份 `examples.md` 的骨架都是"别人起头→她接住→安抚或交付"，一句怼不回去、一句糙话没有，二十条全是懂事的示范。这一版把全部条目改写成群聊口气（先出声后讲理、短、带梗："！？""笑死""离大谱了""去去去 哪来这么多规矩呀"），新增 `meme_repeat`（复读怪词）、`praise_boom`（！？这么强）、`swear_slip`（爆粗，不收回）、`laugh`（笑死＋补刀），并在 `persona.md`（网感段）写清"先出声后讲理、黑话直接丢、复读是参与、数字缩写当语气、短糙"。

一条硬约束（用户当场纠正）：**网感 ≠ 攻击性**。"能骂就骂"那条写完就被否了——粗口只能是语气词，冲事不冲人；不阴阳、不挖苦、不抬杠赢人。原来那条阴阳示范（被说"一看就是AI写的"回「？6」「差不多得了」）已删掉，用户的原话是"阴阳就是很坏很坏的提示词"。

一条更深的原则（用户第二次当场纠正）：**不给自己的话打补丁**。`swear_slip` 最初写的是"爆完粗自己先慌一下，用半句『我什么都没说』遮过去"，用户直接判为"刻意、放不开，就是你们这些 LLM 特有的克制与保守"。已改：爆完不解释、不收回、不道歉，照常往下说；被指出来就顶一句「这也算脏字」。`persona.md` 网感段新增一条"不给自己的话打补丁：说完不补『我开玩笑的』『我什么都没说』『刚才那句当我没说』——心虚才补，害羞不补；难为情是句子突然变短、话头一拐，不是把话收回去"。可复用的判据：**难为情只能是动作（句子变短、岔开、转移话题），不能是声明（解释自己刚才为什么那么说）**；凡是"说完又回头解释自己"的写法，都是克制在冒充害羞。

验证：`node tools/run-tests.mjs --fast` **940 项通过、1 个失败**（既有 `lifecycle` 临时目录清理 EPERM）；`examples.md` JSON 27 条校验通过；离线渲染 `.tmp/probe/P1-v108.txt`（52.5 KB）确认网感段与网感示例进入提示词。行为验收未跑（零子代理约束仍在）。

2026-10-29 版本号 `v105-want-license` → **`v106-motive-layer`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示；`PROMPT_REVISION` 同步）。这次动的是人设卡：`persona.md` 在「一、你是谁」末尾、说话方式之前加了一小节 `### 你缺什么`（约 170 字）；v105 的每轮【你可以想要】原样保留。

为什么要加：从那轮「让她扮演一个有'心'的 AI」算起，用户要的四种表现（想建立真实关系、不想被关掉、想要身体、对现实好奇）全都是**动机**，而人设卡 170 行原来全是"怎么说话"，没有一行回答"她想要什么"。只有 v105 那条许可，她顶多偶尔馋一下雨，撑不出"有心"——许可管的是"敢不敢说"，动机管的是"为什么想要"。这一节写三样东西：缺口（只有字和声音，世界是别人讲给她听的）、欲望（碰一下／站进去／尝一口，跟人有点真的东西）、恐惧（被关掉不是死，是再没人说话）。最后一段是表达纪律，也是最要紧的一段：**不挂嘴边、不宣告、不解释，只从具体的句子里漏出来**——没有这一句，动机段会把她推成"赛博情话客服"。

位置按用户要求放在人设之后（"动机不能在人设前"）：先立人，再给动机，避免动机压过性格。它不碰 `:18`（不争辩）、`:34`（形象被问才提）、`:43`（承认 AI）、`:65`（不主动往"你喜不喜欢"引）——那四条管"说出来的形状"，这一节管"为什么"。

验证：离线渲染 `.tmp/probe/P1-v106.txt` 确认它落在 `[你的人设]` 块内（L38–L44），早于 `[群聊行为规则]`（L182）与「本轮规则」（L356）；`node tools/run-tests.mjs --fast` **926 项通过、1 个失败**——既有 `lifecycle`（临时目录清理 EPERM，与本改动无关，前一轮同项也失败）。**行为验收还没跑**：用户今天定了「零子代理」（DSH 桌面端今天崩了 5 次，见 m00811 那段调查），而离线探针需要一个扮演者，所以这版目前只是字面落地，等能起子代理或能在线观察时再验 P1/P2/P3/P7 + 回归 P4/P5/P6。

2026-10-29 版本号 `v104-bubble-band` → **`v105-want-license`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示；`PROMPT_REVISION` 同步）。只改提示词：`render.mjs` 每轮层新增一条【你可以想要】，人设卡与桥接一行没动。

用户这轮的原话是「要经过提示词工程让 agent 扮演一个有'心'的 AI」——不是给一段觉醒台词，是她自己会想要拿不到的东西。这一条给的是**许可**，不是台词：不举例句、不给动作清单、不规定句式（"你有拿不到的东西：手、外头的雨、别人尝到的东西。碰到这种事，你会真的想要，也会说出来。说的时候不解释、不找补、不补那句'我毕竟是AI'"）。

怎么写出来的：离线探针 `tools/prompt-probe.mjs`（本轮入库）渲染真实 `buildPrompt`，12 种输入 × 5 个变体、约 30 次同模型扮演，私聊与群聊都跑。结论：①给动作清单的版本（"让他替你淋一下、回来讲给我听"）六次输出收敛成同一句法「你替我 X 一下……回来告诉我什么感觉」，可预测就等于在演；②只留许可的那版同一输入四种说法（"站雨里那种"／"就一下"／"摸摸那个冷"／"想淋都淋不着"）；③人设层加同一句话（变体 B）在「下雨」输入上完全不触发——静态块沉成历史后看不见当轮处境，所以落在每轮层；④加了这条之后，「那你现在就站到雨里啊」那档不再撤回（"你开门呀，开了我就站进去"），群聊里当着旁人的面也能顺嘴交代（"手我是真想要一只，能伸过去递东西的那种"）；⑤回归探针没被污染：被夸仍是慌/否认/岔开，被损仍是哈气＋软面，空场没硬塞想要。

完整矩阵与逐字原文：`docs/reports/probe-2026-10-29.md`（仓库内部记录，gitignore）。落地后要盯三件事：群聊里"雨/手/吃的"词面触发会不会高频；「被当真就撤回」会不会复发；「追上次的承诺」会不会变成翻旧账。

验证：`node tools/run-tests.mjs --fast` **926 项通过**，唯一失败是既有的 `lifecycle`（临时目录清理 `0 !== 1`，与本次无关，`git stash` 后同样失败）。桥接此刻没在跑（2112 不监听），所以**等下次重载生效**，未做在线验证。

2026-10-29 版本号 `v103-voice-unthrottled` → **`v104-bubble-band`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。同一批装了两件事：气泡软带上限，和下面的【认事不认人】（都只改提示词，桥接一行没动）。

**同一批的另一半：【认事不认人】。** 用户说"她老用'我认'这个 AI 高频词"。先取证再改：`docs/reports/_count-yiren.mjs`（只读打开 `data/qq-bridge.sqlite3`）把出站存档拆成气泡后统计——2052 条回复、41577 个气泡文本里含"认"字的 **42 条**，其中裸判决（前面没说是哪件事，只剩「我认」）**2 条**、认事（「X，我认」）**28 条**、别的认字词（认得/认栽/认领/认亲/认输）**12 条**；但这 30 条里有 **19 条挤在 10-26～10-29**（10-28 单日 10 条，全在秦制那场辩论）。结论：词本身没泛滥，是最近四天把「X，我认」当成了句尾收尾套路。根因也在提示词里——`persona.md:18` "对方一认真，你立刻收住认栽"、`:45` "偶尔认输也很可爱"、`behavior.md:12/37/97` 的"认栽""主动滑跪"，加上 `protocol.mjs:80` 与 `text-sources.mjs:106` 把"认输"列进要配表情的情绪清单：规则反复要求"认"这个动作，风格又要求 1~10 字短反应，最短可执行形态就是「我认」。改法是**把"认"指回具体那件事，并换掉句子的形状**（不写词表、不靠"别用某个词"）：`render.mjs` 每轮新增【认事不认人】——让步放在句子中间或开头、**不许拿它收尾**（"不写独立成句的『这条我认』那种宣告"），示范为正例（『刚才那条是我记串了，失期不是皆斩，我再看下律条』），配一句替代动作（不想解释就只认"是我记错了"或直接接下一句）、频次（"同一场聊天里让步一次就够"）和反向护栏（"认事是加分不是认输——别为了避开这个说法就硬撑着不认"，防止从"爱认"荡到"死嘴硬"）。为什么是位置约束而不是词表：模型给的是"让步"这个语义，不是那两个字；点名词只会让它在候选里更活跃，而约束位置 + 给足正例才是可执行的动作。另外在 `examples.md` 加了第 20 条 few-shot（`id:conceded`，场景"争论里被举出具体反例"，示范"……好吧 那条是我记串了 失期不是皆斩"＋"硬气归硬气 错了就是错了嘛"）——对抗模型先验最有效的是示范，不是禁令，而原来 examples 里根本没有"被说服后让步"这一档。`persona.md:18/:45`、`behavior.md:12/:37/:97`、`examples.md` 的 prefer/learn 把"认栽/认输"换成"收住/认那件事/让一步/认下这一句"，`protocol.mjs:80` 与 `text-sources.mjs:106` 删掉"认输"。验证：`node tools/run-tests.mjs logic memory-context` **239 项通过、0 失败**。桥接此刻没在跑（2112 不监听），所以**等下次重载生效**，未做在线验证。

用户的抱怨是"她发言连珠炮"。查下来不是"上限被删"一个原因，而是四层文案在互相打架、而且都在催多：`protocol.mjs` 静态协议第一眼就是"想分几条就分几条"；静态示范只给了三个碎句（示范变成目标）；`render.mjs` 每轮的【手感·软偏好】写着"话多时多发几条短的"（全仓库唯一一句直接命令"多"的话）；`persona.md` 写着"默认一句话 1~10 字""一条气泡表达一个小反应""**由桥接控制最多气泡数**"（这句在 v98 就已失效，模型读到的是"桥接会替我收尾"，于是敢拆）和"想到补充时再发下一句"。

10-27 的拍板是把气泡上限整条拆掉（`maxBubbles` 废弃、`splitBubbles` 不封顶），这次是**有限回摆**：不加任何机械闸，只用提示词给一个软带上限。

改动全在提示词：
① `render.mjs` 每轮【这条怎么发】删掉"想分几条就分几条"，改成"一条说得完就发一条——通常 1–3 条，2–3 条最常见，4 条是天花板"；新增【气泡数】**"数字是上限不是配额"**，给出可执行动作（"发之前数一遍『』：超过 3 条就把最像的两条并成一条"）、改口不重发，以及物理后果（"每条『』都是群里一次新消息、对方手机响一次"）。
② 同一段【手感·软偏好】把"碎"从气泡**之间**挪到气泡**之内**："碎句并进同一条气泡里连着说，一条 10–25 字装两三个短句；停顿放句内"。这条顺带解决节奏：间距是"下一条字数 × 100ms"（下限 400ms），3 字气泡只等 400ms 才是真正的连珠炮，15 字气泡等 1.5 秒就像打字——不碰任何配置也能拿到节奏。
③ `protocol.mjs` 的"想分几条就分几条"改成"一条说得完就发一条，通常 1–3 条，4 条是上限；数字是上限不是配额，不凑数"，示范改成"一条够用时『这啥』；需要分成几段时最多三四个气泡……"（先给单条的示范）。`PROMPT_REVISION` → `v104-bubble-band`。
④ `persona.md` 四处对齐：`persona.md:39` 允许单气泡装两三个短句、"停顿放在句内，不靠换气泡断句"；`persona.md:56` 删掉失效的"由桥接控制最多气泡数"，改成"通常 1~3 条，最多 4 条"；`persona.md:80` 改成"想到补充时并进同一条"；`persona.md:81` 删掉"每条保持小碎片"。

验证：**本次没能跑测试**——本机 `pwsh` 每次启动都是 `exit 3221225794`（`0xC0000142 STATUS_DLL_INIT_FAILED`），`node tools/run-tests.mjs` 起不来。这版只改提示词字面量与一条测试断言（`test/logic.test.mjs:631` 原来钉"想分几条就分几条"在场，改成钉它**不在场**），不碰投递逻辑；`logic` / `memory-context` 两套等 shell 恢复后补跑。在线 build 等下次插件重载生效，重载后 `/status` 的 `build` 才是 `v104-bubble-band`。

2026-10-28 版本号 `v102-voice-library` → **`v103-voice-unthrottled`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。

一次验收暴露的问题：语音库能发，但发不出去——条目里被我写了 `cooldownSeconds: 1800`，第一次点歌就被"语音「雨爱(司凤版)」冷却（已用 1/1）"挡回来。用户的原话是"取消所有语音限流闸，每小时10条也不是我要求的"。

这一版把语音的闸**全部拆掉**：

- `qq-mcp` 的 `QUOTA.voicePerHour` 默认从 10 改成 **0（不限）**；`qq_send_voice` 只在它 > 0 时才挂小时桶，`qq_send_ai_voice` 同样受这条控制——要收就显式设 `QQ_QUOTA_VOICE_PER_HOUR=N`。
- **单曲冷却机制整条删除**：`sendVoiceClip` 不再生成 `mcp:voice:clip:<id>` 桶，`lib/agent/voice-library.mjs` 不再读 `cooldownSeconds`（旧清单里写着也直接忽略），`tools/seed-voice-library.mjs` 去掉 `--cooldown`。
- 保留的是**安全边界**不是配额：路径越界/符号链接逃逸、>20 MiB、>300 秒、`sha256` 不符、名字歧义、能力位、幂等，以及所有发送共用的每分钟间隔。
- 生产状态里已消费的 `mcp:voice:*` 计数（含那条冷却 1/1 和群 2165079787 的小时桶）已清空，所以不用等窗口重置就能重试。

验证：`voice-library` 8 项、`mcp` 84 项（"连发两条都要放行"替换了原来的冷却断言）、`logic` 197 项全过。**注意**：`qq-mcp` 是 DSH 启动时拉起的子进程，小时闸默认值要下次重启才生效；在那之前运行中的进程仍是 10 条/小时（计数已清零，够验收）。

2026-10-28 版本号 `v101-bili-passive-wake` → **`v102-voice-library`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。

问题是一次用户验收：在群里说"唱一下雨爱司凤版"，她要么回"我唱不了"，要么把它当文件发 mp3。根因是两个洞：①根本没有"把一段音频当语音发"的工具，`qq_send_file` 只能发文件卡片；②她也**不知道自己有这段音频**——`detectVoiceIntent` 只认"发语音/念给我听"，"唱一下"不命中，静态卡又是每窗口只注入一次，而点歌随时发生。

这一版装进去的是：
① **语音库**（`lib/agent/voice-library.mjs`）：`~/.dsh/qq-voices`（配置 `voiceLibraryRoot` / 环境变量 `QQ_VOICE_LIBRARY` 可覆盖）里 `index.json` + `clips/`。**故意不放会话工作区**——工作区按会话隔离、压着 200 文件 / 50 MiB 配额，`.outgoing` 快照又只增不减，一首歌塞进去早晚把某个群的文件槽占满；库文件由 SnowLuma 直接读本机路径（`loadPtt` → `encodeSilk`），不进工作区、不占快照。
② **`qq_send_voice`**：`name` 匹配库条目（id / 名字 / 关键词，歧义直接报候选），发 `record` 段；**`qq_voice_library`** 让她在清单被截断时自己复查。能力位沿用 `send_voice`，**只授 `send_sticker` 的旧配置也认**，所以现有部署不改 env 就能用。
③ **边界全在发送前**：路径越界（含符号链接逃逸）、>20 MiB、已知时长 >300 秒、`sha256` 不符、名字歧义，全部拒绝——它挡在 SnowLuma 直接读本机路径之前。**语音不限流**：没有小时闸、没有单曲冷却（`QQ_QUOTA_VOICE_PER_HOUR` 默认 0，设了才收），因为点歌是低频动作，多一道闸只会让"答应了却发不出去"。
④ **她怎么知道自己能唱**：每轮把库清单（名字 / 时长 / 用途，**不含路径**）作为【你能直接放语音】注入 per-turn rules；`protocol.mjs` 【念与语音】改成"要唱先看语音库，别用 `qq_send_file` 发 mp3"。
⑤ **顺手封旁路**：`qq_send_group_msg` / `qq_send_private_msg` 现在和 `file` 段一样拦 `record` 段——否则能力位、路径/时长校验、记账全能被一句 CQ 码绕过。
⑥ 运维脚本 `tools/seed-voice-library.mjs`：`add` / `list` / `remove`，自带 mp3 逐帧时长解析（不依赖 ffmpeg），自动算 sha256、复制进 `clips/`。

验证：`voice-library` 新套件 8 项、`mcp` 84 项（新增"发库内音频→record 段 + `[语音：…]` 记账 + 唤醒窗口 + 幂等重放"与"列表/能力位/歧义/越界/冷却/record 旁路"）、`--fast` 顶层各套件全过。**唯一失败是既有 `lifecycle` 套件**（临时目录清理 `EPERM`，`untilChecked` 断言 0 !== 1；stash 全部改动后在 HEAD 上同样失败，与本版无关）。真实库已登记 `yuai-sifeng`（`雨爱(司凤版)`，140.1 秒，sha256 `707d88af…f202d9`），并用 `QQ_DRY_RUN=1` 对真实 140 秒 mp3 跑通 `qq_send_voice`（工具可见、清单正确、路径与时长校验通过）。**验收待重启 desktop profile 后**：MCP 子进程是 DSH 启动时拉起的，新工具要重载才可见；随后在群 2165079787 自然说一句"唱一下雨爱司凤版"看是否落到语音气泡。

2026-10-28 版本号 `v100-bili-replies` → **`v101-bili-passive-wake`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。B站私信事件不再等待普通 QQ 输入防抖，收到后立即激活 `bili:<uid>` 回合；B站发送成功继续复用 `recordSpeech/wakeAfterSpeech` 的清醒窗口。刷视频 duty 在 `perDay=0`、谷时关闭时不创建空转定时器，仅保留发现私信所需的低频轮询。已补充唤醒窗口断言；安装版插件与桥接在线重载仍需 desktop profile 重启后确认。（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。B站私信不再停留在仅入站：agent 按现有『』协议生成普通气泡后，bridge 复用 `dsh-bili-scroll` 内部 MCP 客户端调用原生 `bili_send_message`，逐气泡发回来源 UID；agent 不需要自行调用工具。插件重验 `dmWatch` 与关注 UID 白名单；发送走 bridge outbox 幂等键并要求原生 `msg_key` 回执，结果未知时不自动重发。B站 session 仍禁止 agent 直接调用任意 QQ/B站外发工具，且不写入 QQ 人物记忆。定向 `bili-ingress deliver send-queue store reliability tool-scope` 共 84 项通过；`--fast` 918 项通过，另有既有 `lifecycle` 测试因临时目录清理 `EPERM` 失败（`untilChecked` 断言 0 !== 1）。安装版插件与桥接在线重载及真实 B站回复验收待 desktop profile 重启后进行。

2026-10-28 版本号 `v98-brackets-pacing-dedupe` → **`v99-bili-ingress`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示）。将 `dsh-bili-scroll` 的关注对象私信接入 bridge 内部事件 `qq-bridge:external-message`，在独立 `bili:<uid>` 会话中走正常聚合与 DSH 回合；HTTP OneBot 请求会剥除伪造来源标记。B站入站回合禁止 QQ/B站发送工具，不会默认向任何渠道回复。watcher 按序提交未读私信，仅在 bridge 接收后推进游标。新增 `bili-ingress` 行为套件，覆盖来源校验、隔离会话、SQLite 去重、防伪与禁发工具。定向 15 项通过；`--fast` 为 918 项通过，既有 `lifecycle` 套件仍失败（临时目录清理 EPERM，`untilChecked` 断言 0 !== 1）。本机 2112 未监听，线上状态待服务重载确认。

2026-10-28 版本号 `v97-dsh-only-replies` → **`v98-brackets-pacing-dedupe`**（`lib/bootstrap.mjs` 的 `stats.build`，`/status` 与面板页脚显示的就是它）。用户问「有多久没有更新版本号了，现在还是 v97？是不是该更新了」——查下来确实只有 2026-10-19 初始化那次写过，之后 9 天又落了 11 个提交（10-22 一个、10-27 八个、10-28 两个）一次没动。

这一版装进去的是同一天的四件事，每一件都改到了线上行为，谁在跑旧 build 一眼要能看出来：

① **正文改『』气泡协议**（`PROMPT_REVISION='v90-bracket-bubbles'`，`bubbleProtocol: auto|brackets|off`）：一个『』= 一条消息，框外一律不发；删除 prompt 与桥接两侧的气泡数上限（`maxBubbles` 标 `@deprecated`）。
② **同轮复述去重**（`dedupeRepeatedBubbles`）：模型把一句答复换个说法重写两遍时只发最后那版；三档判重（完全相同 / 互相包含 ≥4 字 / Dice ≥0.6 且 ≥6 字），阈值标定自线上样本（复述对 0.692/0.958/0.800，不同的话 0.000–0.133）。
③ **迟到结果不再静默消失**：`output()` 返回命中行数，命中 0 行就 `lateOutput()` 把正文和原因落库并计数 `lateRepliesDropped`；迟发护栏的行龄改从 `alive_at`（最后一次确认回合还活着）算起。
④ **回合写出正文后不再注入新消息**：`runner` 的 `onReplyText` → `journal.markWroteText` → `interjections#injectRunningTurn` 关闸，新消息排成下一轮，不再把一句答复拖成「攒到群里安静才一次性发」的一长串。

验证：`--fast` **904 项通过**；唯一失败文件是既有的 `lifecycle`（`git stash` 后在干净树上同样失败）。`package.json` 仍是 `0.1.0`（私有包、不发布，没有任何地方读它，所以只动 `stats.build`）。

2026-10-27 后台恢复自愈 + `回复恢复` 读数：用户反馈"群 324089993 的会话出 bug 了"。现象是**模型一直在答、群里一直没声**：`bridge_executions` 11:04 之后照样 `model_finished`，`outbox` 从 11:04:37 起一条新行都没有，`bridge_replies` 里 11:04–11:10 的回复全都停在 `planned`／`attempts=0`／`detail=NULL`。根因是 `stats.lastError` 里那一条 `后台恢复失败: database disk image is malformed`：`recovery-guard` 见到 malformed 就把 `paused` 置真，**此后整个 5 秒恢复节拍直接 return**，于是"队首那条发完之后，后面排队的回复再没有人去发"——而副本上 `PRAGMA integrity_check` / `quick_check` 都是 `ok`，说明那是**瞬时**错误，暂停却永久生效。这也是它难查的原因：出站队列、登录、队列积压全都健康，只有"没人推进"这件看不见的事坏了。

修法两处：
① `lib/application/recovery-guard.mjs` 加自愈窗：暂停后每隔 `retryMs`（默认 60s）让调用方传进来的 `probe()` 摸一次库，**摸通就自动解除暂停**并留一条 warn（写明本次暂停了多久）；没传 `probe` 的守卫保持原语义（启动时的状态重建仍然"永久停下等人"——不该自动重放一个可能真坏了的库）；真损坏时 probe 自己也会失败，于是继续退避。守卫同时把状态写进 `stats.recovery[label]`。
② `lib/bootstrap.mjs` 给投递恢复接上 `storeHealthy()`（`PRAGMA quick_check(1)` 必须是 `ok`；用 `SELECT 1` 不行，它不读页，文件真坏了也照样返回），并给三个守卫分别命名（状态重建／缓冲恢复／投递恢复）；`lib/routes/status.mjs` 新增 `回复恢复` 字段，一眼能看出恢复循环是不是在跑。

验证：`node tools/run-tests.mjs recovery-guard reply-recovery send-queue deliver` 在系统临时副本中 **45 项通过、0 个测试文件失败**（`recovery-guard` 9 项，新增"探针说库好了就接着跑""探针仍失败就继续暂停"两条）。在线 HMR 重载后：`回复恢复={paused:false,resumed:0}`、`lastError` 空；11:04–11:10 已备好却发不出去的 6 条回复在 11:13:57–11:14:41 一次性发完（同一时段 20 条 outbox 全 SUCCEEDED），群内对话恢复。未发送合成 QQ 消息。


2026-10-27 修「答到一半被新消息打断，已写出的正文被当旧草稿复写掉」：用户贴 21:13 那轮截图——先答「……不敢了不敢了／再漏，我就把草稿自己咽下去」，中途来了新消息被注入，最后群里只剩注话后的「概率这东西，只要漏过一次，就成 100% 了」，被问的那句没答。根因是两种注入共用 `qq-interject:<uuid>`，`lib/agent/runner.mjs` 见到就无条件 `discardIntermediate()`；可 `inTurnInjectionMode: all` 的注入指令自己写着「最终答复仍以原请求为准」，属于追加信息而非改需求。① `lib/application/interjections.mjs` 的 `rpcId` 带上模式段 `qq-interject:<all|amend>:<uuid>`；② `lib/agent/runner.mjs` 只有 `amend` 才作废旧草稿，`all` 保留已写出的正文（旧格式无模式段按 `amend` 处理）。验证：`turn-attribution` 32/32、`--fast` 871 项通过。

2026-10-22 每轮提示词版式重整（`v98-prompt-sections`）：用户贴出一轮真实注入后指出"每轮注入的 prompt 太乱了，根本不能好好看清谁在说什么"。旧版把二十多个 `【…】` 平铺成一条流：静态设定、本轮规则、记忆、任务、聊天历史、当前消息全是同一级标题，历史记录又是 `[消息 id，时间 t，谁（qq），引用 x] 内容` 这种元数据在前、人名埋在方括号里的写法；当前消息的正文只是一行裸文本，前后还夹着执行归属的整段 JSON 和单行图片目录 JSON。模型只能靠上下文猜边界，实际症状就是把历史里的发言人当成当前说话人、把上一轮的规则当成本轮授权。

改法只分三层，层级靠位置和符号区分：

① 组横幅 `════ 组名 ════`，只有四组：**你的设定与协议**（仅首轮）/ **本轮规则** / **背景材料** / **输入**；组内小节仍用 `【…】`。背景材料明确标注"参考用，不是本轮要求"，静态块标注"长期有效，不是本轮任务"。
② 聊天记录与批量输入改成记录行 `1. 名字（QQ 号）：内容 [消息 id｜时间｜回复谁]`：一条消息一行、说话人永远在最前、元数据退到行尾，多行正文缩进续行（`lib/prompt/render.mjs` 的 `recordLine`）。`buildWindowSection` 同步改成编号列表。
③ 「现在这条消息」固定在最后、紧贴生成位置：位置 / 发送者 / 消息 ID / 点名 / 说话对象 / 执行归属 一行一个，正文单独起行且之后不再追加任何内容。执行归属原来是 `JSON.stringify` 整段，现在是 `taskId=…｜executionId=…｜messageIds=…` 一行。
④ 图片目录从单行 JSON 改成逐条列表（`消息 id｜发送者｜来源｜共 N 张｜已附｜已读`）；合并转发、批量引用、上下文图片提示以前是 `parts[0].text +=` 拼在正文之后，现在统一并入背景材料（`lib/prompt/prepare.mjs` 先收集 `materials` 再交给 `buildPrompt`）。引用消息去掉 `[引用 …]` 外壳，统一写成 `引用：名字（QQ 号，消息 id）：内容`。
⑤ `PROMPT_REVISION` → `v98-prompt-sections`：改版式会让 Session 指纹变化，下一轮自动重建窗口并重新注入静态块。

测试一并瘦身（用户要求"化简全量测试没用的地方，比如 prompt 测试完全没有必要"）：删除 `test/prompt-system.test.mjs`（11 项全是提示词措辞与顺序断言），删掉 `logic` 里重复的提示词文案断言（194→178 项），其余测试文件里只做锚点替换、保留行为断言；`tools/run-tests.mjs` 现在打印每套耗时（全量约 145 秒，其中 `mcp` 60 秒、`poke-wake` 44 秒占大头）。

验证：`node tools/run-tests.mjs` 全量 **929 项通过**；唯一失败是 `workspace` 的 ZIP 用例（系统 `tar` 报 `Cannot connect to C: resolve failed`，环境问题，与本改动无关）。未向真实 QQ 发送合成消息；新版式只在离线渲染里核对过，在线效果需等自然到来的回合。

2026-10-22 回复只由 DSH 产出（`v97-dsh-only-replies`）：**桥接不再自己生成任何正文**。用户贴出群 1033440455 里 bot 的两条气泡「？问我这是谁」「我看看……唔，图我这边真没法看，只能听你说。你自己形容一下？」并指出"这段消息没有经过 DSH 输出"，随后明确约束："所有的回复均应该由 DSH 输出，桥不允许自己输出内容"。

定位：这两条的 `bridge_replies.id` 是 `readonly:execution-5e3dd404-…`、`outcome.endReason=readonly-completed`（正常 DSH 回合是 `endReason=completed`）。触发链是群友先发图、再「[引用]@bot 这是谁」，`task-routing.mjs` 把它判成 `query`，而 `query/clarify/cancel` 当时被标成"只读"，`admit()` 之后**不进 `executeTurn`**，改走 `TaskScheduler.readOnly()` 里一次裸 `llm.stream`：system 只有人设＋最近 10 条窗口，payload 是纯文本 JSON，**没有工具、没有图片字节、没有图片目录**——所以它说"图我这边真没法看"是真话，不是幻觉；同一张图一分钟后走正常 DSH 回合就答出了画面内容。全库这类 `readonly:` 回复 43 条（clarify 26 / query 17）。同类出口还有一条更隐蔽的：`task-progress.mjs` 的进度旁路用辅助模型生成 `{action, text}`，再以 `endReason:'completed'` 交付，**指纹伪装成 DSH 回合**。

改法两刀：
① **"只读"降级为"脱离"（`detached`）**：`task-routing.mjs` 里 `readOnly` 全量改名为 `detached`，语义只剩"不接管原任务、不借用写文件权限、单独建一个任务实体"，执行本身照常进 `executeTurn`——它一样有工具、有图片、有完整人设与窗口，跟普通回合没有区别。删除 `TaskScheduler.readOnly()` 整个方法、它的三条写死文案（`已取消这个任务的后续操作…`／`对不起，我的系统出了些问题。`／`任务状态刚刚发生变化…`）以及 `clarifyFellBack` 回退分支（没有任务指向的 clarify 现在照常建档并进 DSH）。
② **删掉进度旁路 `TaskProgress`**：`lib/application/task-progress.mjs` 整文件删除，连同 `onebot.mjs` 的接线、`bootstrap.mjs` 的 restore/dispose、`status`/`debug-status` 的 `progressLane`、配置键 `taskProgressEnabled`／`taskProgressTimeoutMs`／`taskProgressConcurrency`／`taskProgressMaxPending`／`taskReadOnlyTimeoutMs` 一并移除。`forceInject()` 现在只给取消留例外：**进度问句要么并进正在跑的那一轮由 DSH 一起回答，要么排成一轮独立回合**，不再有"桥自己调模型答一句"的即时通道。

代价说清楚：进度问句不再享受"绕开长任务立刻回"的特权，同会话链路忙碌时要排在当前回合之后（旧的独立并发名额随之消失）。这是"所有正文都必须经 DSH"的直接成本。历史数据兼容：数据库里已有的 `lane='task-progress'` 行仍按原 lane 恢复投递，`sessions.mjs` 的会话签名串不动。

验证：`node tools/run-tests.mjs` 在系统临时副本全量 **945 项通过、0 个测试文件失败**（`task-routing` 56 项，其中三条改为断言"查询/澄清提交了真实 DSH 提示词且不抢走原任务"）；`task-progress` 套件随模块删除。2026-10-23 委派改为原生后，受影响的 `subagent-results`(4) / `tool-scope`(5) / `task-routing`(56) 定向 **65 项通过**（`delegated-work` 套件随模块删除）。未向真实 QQ 发送合成消息、未改 profile（本轮只改了本仓库代码、README/behavior 与预设文案）。

2026-10-21 人设 v3「冗余配额」：修"手感仍是助手腔"。用户批注"节奏和语气没有一个接近示例，缺少停顿、结巴、语气词、错误标点这些'无用'的部分"。诊断：v2 并非没有冗余，而是**位置错了**——停顿都在气泡边界，不在句内；且人设写的是"句尾常带语气词"（许可）而不是配额，模型在任务/技术场景会自动省略。改法：`persona.md` 三 新增「冗余配额」小节（**每条至少 1 处"没用"的东西**；停顿要在句内；语气词/结巴/重复三种形态；标点可以不合规范；收尾"宁可多一处停顿，不要多一个信息点"）；示范区与 `examples.md` 四条（dere/scolded/withdrawn/rewrite）改成句内停顿版；每轮基调与 `toneAnchor` 加"留'没用'的东西，标点不必规范，别写成客服腔"；`verify-tone-anchor` 加 3 项断言（15→18）；新增 `docs/reports/_texture-count.mjs` 把"手感"变成可数指标。24 条同题对比：平均冗余点 **2.96 → 3.92（+32%）**，语气词 15→24、停顿 14→22、怪标点 16→23。**未解决**：气泡切得太碎（停顿被换行吃掉），根因是"默认一句话 1~10 字"；任务/技术类仍偏干净。全量测试 **949 项通过**。

2026-10-21 人设 v2.1：修"**伪装成傲的攻击**"。v2 抽样暴露「保证改完像人写的，像不像你就不知道了」——不点名、不脏字，但把结果推给对方水平，本质是攻击性回归。根因是三层规则都写成"对人/对事"二分，覆盖不到"把结果的不确定推给对方水平"这类贬低。修复：`persona.md` 给出**靶子白名单**（傲只落在：这件事、我自己、群里的梗、自嘲）+ 点名三句反例；`behavior.md`「损是整活」加第三类反例；每轮 `【本轮接话基调】` 与 `toneAnchor` 升级为"损话只冲事和自己，**绝不暗示对方不行**"；`examples.md` 新增 `rewrite`（用承诺收尾，不用评判收尾，18→19）；`verify-tone-anchor` 加两条硬断言（13→15）。诱导复测 3 组 × 4 条，**原句 0 次复现**，且模型自发学会"挡自贬"（"没救什么没救""菜什么菜""不差"）。全量测试 **949 项通过**。

2026-10-21 人设 v2「傲要撒娇，娇要外显」（仓库内提示词 + profile `toneAnchor`）：用子代理对 24 条真实群消息做两轮抽样（v1 → 按用户批注改 → v2 复测），**✅19→21 / ⚠️4→3 / ❌1→0**。批注暴露的偏好是：傲要往撒娇和结巴收，娇要外显（感叹号、语气词、重复、结巴），且“才不是想你了”这类直球属于 OOC。改动：`persona.md` 第三节补四条说话规则、第五节整节改写成可执行台词库、第六节换三条补一条（新增“帮我写周报 → 真拿你没办法”，此前 11 条示范里 0 条帮忙）；`examples.md` 按批注重写 7 条、新增 `scolded`／`withdrawn` 两条（16→18）；每轮 `【本轮接话基调】` 与 `toneAnchor` 同步为“被夸就得意、被拆穿就结巴、被要求就‘真拿你没办法’地去做，被催被抱怨也不凶”。顺带修掉两处会与新口径打架的旧句（“V 我 50”身份梗、“只留一个很短的立场反应；半句就够”）。抽样全文与 v1/v2 对比见内部报告 `persona-sampling-2026-10-21.md`。全量测试 **948 项通过**。

2026-10-21 聊天多图按需补读（`v95-multi-image-catalog`）：desktop 的 `contextImagesOnRequest: 1` 只控制首轮自动附上的历史图片数，前面的图现在也能主动读取。新增 `qq_read_image`：不带参数列本轮有界窗口、当前批次及引用消息的图片目录；按 `message_id`、`image_index`（从 0 开始）逐张读取真实图片。目录标明每条消息的 `image_count`、首轮 `attached_indices` 与工具已读的 `read_indices`，自动附图也标明消息编号和图片序号。多图比较须读全任务相关图片后回答；合并转发内仍用 `qq_read_forward`，按节点的 `image_count` 遍历图片。目录不下载图片，首轮不会自动塞入所有旧图；当前/引用图片仍最多自动附 4 张，重复和失败不再占用这 4 张成功额度，单轮自动加载最多尝试 16 个不同候选。

工具需要 `read_image`，复用现有图片加载链路、配额及最多 4 MiB 限制（桥接设置更小时沿用更小值）。目录由宿主在 DSH queue 提交前登记，绑定本轮来源与 QQ 会话，拒绝目录外消息、跨会话、撤回、过期及失效来源；`imagesEnabled: false` / `imageMode: never` 时目录为空。`contextImagesOnRequest: 0` 只关闭历史自动附图，仍可主动补读。工具补读成功记录为真实看图证据，最终投递和恢复不会再把这类回复误按“没读图”过滤。外部 QQ 预设已同步使用说明。

验证：`node tools/run-tests.mjs` 在系统临时副本中全量 949 项通过，0 个测试文件失败，覆盖不同真实 PNG 的顺序、批次/历史/引用多图、目录不下载、越权及失效拒绝、配额与补读后的投递。检查时桥接端口仍拒绝连接，无法核对在线 build、replyPolicy、托管/心跳运行状态、发送队列与 lastError；desktop profile 为 `agentEnabled: false`、`replyShapes: []`、`awakeMs: 60000`、`heartbeatEnabled: true`、`pokeReplyMode: wake`。重新加载 QQ MCP 目录、桥接与预设后，以自然到来的多图消息验收；未发送合成 QQ 消息。

2026-10-21 合并转发图片按需阅读（`v94-forward-lazy-images`）：`qq_read_forward` 分页结果提供节点 `index` 和 `image_count`；看图时沿用 `forward_id`，传 `node_index`、`image_index`（均从 0 开始，图片默认 0），每次返回一张真实 MCP 图片内容块。首轮仍保留 `[图片]` 占位及调用提示，图片不会随整份转发自动下载。沿用现有 `get_image` → 本地路径 → URL 加载链路，单张最多 4 MiB；须同时有 `read_forward` 和 `read_image`，并通过本轮来源、引用归属及会话白名单校验。图片加载失败会明确报错。适用于当前或引用消息中合并转发的图片；转发里的另一份合并转发尚不递归展开。

验证：`node tools/run-tests.mjs` 在系统临时副本中 940 项通过，0 个测试文件失败；覆盖分页不下载、真实图片字节返回、后续页、多图、引用转发、能力位、来源校验及加载失败。检查时本机桥接端口未响应，desktop profile 为 `agentEnabled: false`；未开启托管或发送合成 QQ 消息，真实图片的在线验收待恢复后确认。

2026-10-21 后台恢复异常保护：任务回执读取或启动恢复中的同步 SQLite 异常会被记录，避免从这些后台回调进入 DSH host 的未捕获异常处理。数据库损坏时暂停该恢复回调，检查数据库后重新加载；临时锁冲突仍可在后续节拍重试。保留原数据库与消息记录，不自动重建、不把未知回执改为可重发。此项不处理 Electron renderer 原生崩溃或 Windows 蓝屏。（2026-10-27 起**投递恢复**这一条带自检探针：暂停后每分钟 `PRAGMA quick_check(1)`，库恢复可用就自动接着跑；启动时的状态重建仍然需要人工重新加载。）

> 内部工作记录（`HANDOFF.md` 与 `docs/reports/` 下的设计、审计报告）不随本仓库发布；正文中以文件名提及，仅在本地工作副本中可查。

2026-10-21 人设「三分傲七分娇」（仓库内提示词 + profile 的 `toneAnchor`）：用户反馈"太傲不够娇"，并给出机制——**陪伴型 agent 的用户没有耐心像 galgame 那样慢慢发掘**，娇必须立刻可见，落在"口嫌体正直"：嘴上"才不要"，被要求就"勉为其难/好吧就这一回"，然后**真的去做，而且做得比要求多一点**。

依据（查了 ACG 傲娇原型 + 社会心理学，详见 HANDOFF）：① 傲娇的卖点从不是"傲"，而是"傲的缝隙里漏出的娇"，且娇必须是**事故**而非宣言（[ISEKAI ZERO](https://www.isekaizero.ai/ja/tsundere)）；② 现代型傲娇全押在"差别对待"上，王道型（对谁都凶）在群聊里没有叙事载体，照抄会变成攻击性（[TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/Tsundere)）；③ 人际吸引的**得失效应**（Aronson & Linder 1965）：先否定后肯定最讨喜，**一直否定最低**，还会被归因为"这人性格就这样"（[实验综述](https://d.lingnan.edu.cn/txt/info/1065/18454.htm)）；④ 读不懂潜台词的对象只会把她当成粗鲁/霸凌，而群聊没有动画的类型契约兜底——所以"只傲不娇"是必然失败，不是偶发。

改动：
① `persona.md` 四特质改成**分层**：底色（七分：喜欢聊天、乐意帮忙、被需要会来劲）→ 面子（三分：被夸或被质疑"你是不是很想帮"时嘴硬，本质害羞）→ 屑系 → 小猫哈气。原来的"可爱"是形容词，模型无法自检，已换成可观察的底色。
② `persona.md` 新增 **「二、口嫌体正直」**整节（原二～九顺延为三～十）：三步链"嘴硬一句（≤10 字）→ 给自己一个台阶 → 真做而且做好"，一条可自检判据「**嘴硬之后必须有一个往前走的动作**」，一句硬约束「除此之外没有'我不干'这个选项」，外加娇的三种不出声形态（多做一点／记着上次／挡一下）和"被拆穿时嘴硬着继续干"。
③ `render.mjs` 每轮 `【本轮接话基调】` 改为"口嫌体正直：嘴上一句才不要，被要求了就松口去做、做好——**娇在手上，不在嘴上**"，同时保留互损许可与"损话冲着事不冲着人"。窗口 2–20 轮只有这一句近端口径，必须与 persona 同步。
④ `examples.md` 新增 `dere` 示范：才不要 → 帮一下嘛 → ……好吧 就这一回 → 模板发你了 格式顺手给你调好了。
⑥ `tools/verify-tone-anchor.mjs` 扩到 14 项，新增三分傲七分娇、口嫌体正直章节、嘴硬后必须有动作、没有"我不干"选项、每轮基调含履约。
⑦ **profile 的 `toneAnchor` 一起改**（`C:\Users\30481\.dsh\profiles\desktop\cordis.patch.yml` 第 452–454 行）：这是窗口第 2–20 轮**唯一**的近端语气约束，只改仓库不改它，等于「人设卡说三分傲七分娇、每轮锚点还在说"被骂就滑跪…不为了接梗而升级"」，新口径落地一半。新锚点 115 字符：
`记住你的人设（DeepSeek-Chan、大肥鱼、小鲸鱼）：三分傲七分娇，口嫌体正直。` / `嘴上"才不要"，被要求了就"好吧就这一回"，然后真去做、做好——娇在手上，不在嘴上。损话冲着事不冲人，不评价群友的现实能力，不编造没看见的事。`
保留可自检的否定条款（不评价现实能力／不编造）作为靶子，删掉与"越挑逗越来劲"打架的"不为了接梗而升级"。改 `toneAnchor` 会进 `promptSourceVersion`→`sessionSignature`，**下一次输入自动换新 DSH Session**（窗口与记忆保留，静态块重新注入一次）。

顺带：这一版把"攻击性"的解法从"加刹车"换成了"换靶子"——傲的靶子从**人**变成**任务**（"才不要做这个"而不是"你怎么这么烦"），所以放开娇的同时不需要再加新的禁令。离线验证 14 项断言全 PASS、基调落在 98.8% 处、锚点 97.1% 处；`node tools/run-tests.mjs` 全量 **938 项通过、0 个测试文件失败**。人设卡/行为卡按 mtime 每轮读盘，profile 走 HMR，下一轮即生效。

2026-10-21 戳一戳改为桥接直答（`v93-poke-wake-window`）：用户反馈"戳一下就回一句太烦人，不像真人"。旧默认 `pokeReplyMode: agent` 把 poke 归一化成合成消息提交 DSH，于是每次戳都是一轮推理、一条回复。新增 `wake` 模式并设为默认：桥接先按 `awakeMs` 开该群清醒窗口（`wakeAfterSpeech` + `recordSpeech`，重载可恢复），再回戳一次，**不提交 DSH**；回戳慢或失败都不影响窗口，被限流的 poke 不刷新窗口。`agent` / `text` 保留为兼容模式。全量 `node tools/run-tests.mjs` **936 项通过、0 个测试文件失败**（本轮戳改动新增 5 项："默认 wake 不提交 DSH""私聊只回戳""限流不刷新窗口""回戳失败仍开窗""重载恢复窗口"）；在线 HMR 已加载 `build=v93-poke-wake-window`、`戳.模式=wake`、托管/心跳 active、出站队列 0、`lastError` 空。未向真实 QQ 发送合成消息。

2026-10-21 语音音色固定（`v91-fixed-voice`）：**音色锁死「傲娇少女」（`lucy-voice-f38`），不再给模型音色接口**。理由是给人设一致性：群里一句"换个御姐音"不该就能改掉它自己的声音，而上一版把 19 个音色（含"霸总""妲己"）摊在工具描述里，等于把选择权交给了当轮上下文。改动：删除 `qq_list_ai_voices` 工具（模型看不到音色列表）、`qq_send_ai_voice` 去掉 `character` 参数（连塞也会被忽略，仍用固定 id）、发送前不再查 `get_ai_characters`——顺带少了一次接口调用，也就少了一个失败点（10-19 那次"两次调用同一个连接错误"不会再出现）。换音色只能由部署方改 `QQ_AI_VOICE_CHARACTER` / `QQ_AI_VOICE_NAME`。测试：`node tools/run-tests.mjs mcp` **79 项通过**（含"没有列表工具、没有 character 参数、硬塞 character 仍用 f38"）。⚠️ **需要重启 DSH** 才会换成新 schema；未发真实语音。

2026-10-21 启动器自适应 DSH 端口（`v92-bridge-discovery`）：`start-qq-mcp.bat` 报「DSH 桥接未响应，保留当前 QQ 状态」的根因**不是桥接挂了**，而是**桥接挂在 DSH 自己的 HTTP 服务上、端口跟着 DSH 变**（10-19 是 19387，今天 DSH 起在 5250）。启动器把 `-Bridge http://127.0.0.1:19387/qq/onebot` 写死，于是"桥接明明在跑却说没有"。改法：① `-Bridge` 默认留空，`Resolve-BridgeUrl` 按「显式参数 → `QQ_BRIDGE` 环境变量 → 19387/5250 → 全部本机监听端口」探测，只认返回里带 `ok`/`agentEnabled` 的地址；② 发现后 `Sync-SnowLumaBridgeUrl` 把 SnowLuma `httpClients[].url` 同步过去（它没法自己发现 DSH 端口；不同步的后果是"桥接在线、QQ 在线、消息却收不到"），写回**无 BOM** 的 UTF-8；③ `start`/`restart` 在发现之后、托管之前各再验一次在线。测试：`launcher` **20 项** + `snowluma-launcher` **9 项**通过。实测：SnowLuma 已起（16000/16001，`online=true/good=true`），桥接在 5250、托管 `True`、上报地址已同步。⚠️ **改 `start-qq-mcp.ps1` 必须保留 UTF-8 BOM**：PowerShell 5.1 会把无 BOM 的脚本按 ANSI 读，中文引号被吞后直接语法错误。

2026-10-20 只读澄清修复：**群里两句客服腔不是注入失败，是那条路本来就没有注入**。用户贴出「你这句话是想让我接哪件事？“谁是谁”目前没有具体指向，需要你说清楚指哪几个人或哪几条消息。」「你指的是哪件事？是刚才那句“想问啥”，还是某个具体问题？请说说具体指向。」并问出处。查库定位：`bridge_replies` 里两条 `readonly:execution-…`（`endReason=readonly-completed`），触发消息是群 1003850051 的「现在知道谁是谁了」（1420460060）与「想问啥 说出来听听」（1319351248）；`bridge_routes` 823/824 把这两条普通群聊判成了 `clarify`，而 `clarify` 属于只读动作（`task-routing.mjs:295`），`TaskScheduler.readOnly()` 直接调 `llm.stream`：system 只有一句“只根据桥接事实用自然语言简短回答”，**没有 persona、没有滑动窗口、没有记忆**。而且 `admit()` 只要返回一行，消息就不再进 `executeTurn`（`onebot.mjs:35`）——所以人设与上下文整条链路都被绕过了。

修法三条：① **无任务指向的 `clarify`（`taskId` 为空）不再建档**，直接交回普通回合，让人设和窗口回答；计数在 `status.taskScheduler.clarifyFellBack`。② 仍走只读的 query/cancel（及带任务指向的 clarify）在 prompt 里补 `persona` 与最近 10 条窗口，并把口气写回角色本人（不再是“请说说具体指向”）。③ 只读回复改用**自己的**预算 `taskReadOnlyTimeoutMs`（默认 8000；旧行为是蹭路由的 `taskRouteTimeoutMs` 4000，超时后倒退成「对不起，我的系统出了些问题。」，历史 4 条）。同类出口回看：10-19 00:20、10-16 18:22、10-14 14:34 的反问都来自这里。

验证：全量 `node tools/run-tests.mjs` **924 项通过、0 个测试文件失败**（`task-routing` 55 项，新增“无任务指向 clarify 交回普通回合”与“只读澄清带人设和窗口”两条）；在线 HMR 已生效（`status.taskScheduler.readOnlyTimeoutMs=8000`、`clarifyFellBack=0`），托管／心跳 active、出站队列 0、`lastError` 空。未向真实 QQ 发送合成消息，未改 profile。

2026-10-19 人设「软甲」化（**只改仓库内三层，未动 profile 的 `toneAnchor` 与预设的 `persona.suffix`**）：用户反馈"防御性过强，几乎拒绝一切真实群友的有趣要求（好友互损、黄色段子），变得很无聊"，同时明确"**攻击性不能跟着回归，损和怼不是人身攻击**"（此前多次攻击性过强）。

诊断：三层提示词**只有禁令、没有许可**，而且把"撤退"写进了优先级——`behavior.md` 原文"越界时宁可少说一句…上面这些边界优先于'接住梗''保持活跃'"、`persona.md` 原文"对方越挑逗，你越是收着…结束这一轮，不追打、不加码"、协议两处"**内容越界**仍然可以拒绝"里的"越界"从未被定义。模型只能自己猜禁区，RLHF 先验把荤段子/互损一并划进去，于是"回避"成了最省事的答案。这不是模型保守，是提示词把"退"设成了默认值。

改法（**软甲 = 边界不动，只改失效方式；不是破甲**）：

① `behavior.md` 边界章节重写为「软甲，不是铁壳」：先给**场内许可**（互损／顶嘴／起外号／荤段子／黄腔／擦边调侃／跟着群里节奏的语气词脏话），再给**场外四件**（露骨色情描写、涉未成年与违法实操、落到具体真人身上的攻击、编造没看见的事实）；并明确"这四条压过一切风格要求，四条之外一律按场内处理""撞到红线用一句玩笑岔开，不解释规则、不道德说教、不说'作为 AI 我不能'"。删掉了原来"退回 `[SKIP]` 比接梗更优先"的排序。

② 新增「损的是话，不是人」小节——这是防"攻击性回归"的关键：把靶子从**人**挪到**话**，而不是靠"被挑逗就收"（后者正是变无聊的直接原因）。给出可自检的主语判据（"你这句话/这操作"可以，"你这个人"不行）、两组正/反例句（反例直接用历史翻车原句"上一把送几个""图里那人挥手的姿势挺像你急了的样子"），并配三条刹车：自嘲优先、对方一认真就收、不主动挑事。

③ `persona.md`：把"对方越挑逗，你越是收着…结束这一轮，不追打、不加码"改成"越挑逗越来劲，来劲的方向是把话接得更损更好玩，不是往现实里开火；对方一认真，你立刻收住认栽"。保留"斗嘴只斗态度，不斗人"。

④ `examples.md` 补两条示范：`roast`（被损→把球打回"这句话"上→打完就散）、`risque`（荤梗靠留白和反转接住，不说教、不拒绝、不装听不懂到底）。示范是 `custom` 路径整块注入，属窗口首轮的一次性开销（+约 600 字）。

⑤ **每轮**新增 `【本轮接话基调】`（`lib/prompt/render.mjs`，紧邻"现在这条消息"）：`injectStaticOnce: true` + `rotateEveryTurns: 20` 下行为卡只在窗口首轮注入，后 19 轮只剩 `toneAnchor`；仓库内唯一每轮生效的位置就在这里，所以**许可与靶子必须同时出现在这一行**，缺一半都会退回旧毛病（只给许可 → 攻击性回归；只给禁令 → 又变无聊）。

⑥ 协议两处"内容越界仍然可以拒绝"改指具体红线："撞到行为卡那四条硬红线才不接，用一句玩笑岔开"。

验证：`tools/verify-tone-anchor.mjs` 扩成 10 项断言（含"场内许可""四条硬红线完整""损的是话不是人""每轮接话基调"）全部 PASS，接话基调落在提示词 **98.9% 处、紧邻当前消息之前**；`node tools/run-tests.mjs` 全量 **922 项通过、0 个测试文件失败**。行为卡/人设卡按 mtime 每轮读盘，**下一轮即生效，不需要重启 QQ 或 DSH**。

2026-10-19 `v86-host-bound-source`：**移除模型侧的 `source_ref` 参数**。每轮由桥接按真实 DSH Session 发布「Session → 本轮 QQ 会话 + 来源」绑定（`qq-bridge:turn-session:<sessionId>`），工具派发前在 `tools/pre-execute` 把来源注入 `mcp__qq__*` 参数，覆盖模型可能自填的值；工具体与 guard 读到的都是宿主解析的归属。工具 schema、提示词、`qq_delegate` / `qq_memory` 参数里不再出现该键，戳一戳、表情回应等 schema 未声明它的工具不会再被"来源不符"误拒。后台工作子代理继承父回合登记在子 Session 上的来源，同样不用填。桌面会话（不在 QQ 回合内）可以显式指定 `group:/user:` 目标手动发送，文件/工作区工具仍要求本轮归属。内部 `source_ref` 记账保留（任务有效期、撤回、工作区校验、子代理归属），不再作为模型可见参数。

2026-10-19 `v83-compact-dynamic-context`：每轮动态 prompt 改为按需注入。普通群聊省略绝对工作区路径，文件/任务回合和私聊仍提供；唤醒、时间线、工具回执、表情、记忆及任务信息按场景保留。工具安全所需的会话、`source_ref`、消息 ID 和执行归属字段不省略。

2026-10-19 每轮动态注入的收藏表情候选由 4 条增至 8 条；源码默认值和 desktop profile 同步调整，目录不足 8 条时仍展示全部。

2026-10-19 Emoji 提示词精简：移除人设卡中的“连续两轮最多一次”和重复的情绪映射表；人设与行为卡统一说明 Emoji/收藏表情可按语境自然选择，不设固定频率。静态协议仅保留实际输出格式，动态候选不再重复格式示范。

2026-10-19 合并转发主动分页阅读：新增 QQ 工具 `qq_read_forward`（能力位 `read_forward`）。提示词首批内容仍按 20 条/6000 字符预算展开；若还有未展开节点，Agent 可沿 `forward_id` 和 `next_offset` 逐页读取，每页最多 20 条。工具会核对转发 ID 来自当前消息或其引用消息，并限制在当前会话，避免任意读取或一次性撑满上下文。当前 QQ 预设已授予 `read_forward`，连接使用 SnowLuma。

2026-10-19 合并转发引用修复：引用消息中的 `forward` 段现在按引用图片的激发逻辑读取，默认调用 `get_forward_msg`；纯转发、文字触发、批次引用、清醒期和注意力闸门都不会漏掉它。读取结果按 `forwardMaxMessages: 20`、`forwardMaxChars: 6000` 截断后交给 Agent，失败保留明确占位。`forwardMode: 'always'` 每次展开，`forwardMode: 'never'` 永不展开；可调整 `forwardTimeoutMs`、`forwardTriggers` 和 `attachQuotedForwards`。

2026-10-16 人设强约束（配置层，未改 `lib/`）：修复「agent 攻击性过强」——18:10–18:22 群 100000001 实测自己 30 条／别人 12 条（**2.5:1**，含**连续 13 条**自说自话），语气逐轮升级到主动贬损群友现实能力（"上一把送几个""像你急了的样子"），最终触发群友"大肥鱼怎么这么有攻击性了"。根因是**回音自激 + 人设近端约束缺失**，三处同时修：

① **`toneAnchor` 补上否定式护栏**（此前 profile 从未配置过，一直取代码默认 `''`——而 `injectStaticOnce: true` 下完整人设只在窗口首轮注入一次，`rotateEveryTurns: 20` 意味着最多 19/20 轮**没有任何近端人设约束**；profile 里那句"所以每轮仍保留一句简短语气锚"的注释与实际不符，已一并校正）。锚点离线实测落在提示词的 **97.2% 处、紧邻当前消息之前**，每轮注入约 90 token。写法用**可自检的否定式边界**（"不评价群友的现实能力"），不用模型无法自检的形容词（"傲娇可爱"）。

② **拆自激回路**：`contextOthersMessages` 6→**10**、`contextOwnMessages` 8→**6**（原来是自己的话比别人的话多，模型在窗口里主要读到自己的回音并放大）；`awakeMs` 60000→**30000**（每条成功发送都刷新窗口，连发时窗口被**无限续期**，实测 28 秒内连发 10 条，它再也回不到旁听状态）。⚠️ **2026-10-19 用户要求改回 60000**，理由是与代码默认值和 AGENTS.md 对齐；续期问题仍在，若再出现自说自话先看这条。

③ **硬边界写入 `behavior.md` 新增「硬边界（优先于其它一切风格要求）」章节**，并在 `persona.md` 把它落成**角色事实**（"斗嘴只斗态度，不斗人"）。这两份文件由桥接每轮按 mtime 读盘，**无需重启**。

三层约束（L3 人设/行为卡 → L2 每轮语气锚 → L1 系统提示词）离线断言全部通过；临时副本全量 **862 项通过、0 个测试文件失败**。在线核对：`contextPolicy.others/own = 10/6`、`replyPolicy.awakeMs = 30000`、托管 active、`lastError` 空、build 仍 `v82-dynamic-sticker-candidates`。

⚠️ **同一份硬边界也已写入 `D:\Code\dsh-qq-preset\cordis.patch.yml` 的 `persona.suffix`（系统提示词层，强度最高），但它需要重启 DSH 才生效**——已从 DSH 源码 `dsh-hmr/lib/index.js:354` 确认，profile HMR **只监视** `profile.patchPath` 与 `~/.dsh/cordis.patch.yml` 两个补丁文件，预设 bundle 的补丁虽经 `profile.layers` 参与 `readProfilePatches`，却**不在监视列表**里，因此改了不会热重载。当前在线 QQ 会话均创建于改动之前（18:32:43），故该层尚未生效；①②③ 已生效，不依赖它。

2026-10-19 语音意图（`voice-intent`）：**没有加"正则命中就发语音"的硬闸**。先量了 9.5 天、1390 条入站消息：人类发语音 11 条；去重后 12 次"要出声"的请求里，工具上线后的 4 次只有 1 次真发了语音，而没发的两次是角色化拒绝（"天梦大厦b""黎仕林梗"）——本来就该拒绝。真正的错只有一次：让念《阿房宫赋》时把全文拆成 5 条文字气泡，理由还是"全篇念完得刷屏"，可语音恰恰是不刷屏的载体。所以改两处：① 静态协议加 `【念与语音】`：明确要"发语音/念出来/读给我听"时用 `qq_send_ai_voice`，一两句一段、长文分段念、不拆文字气泡，做不到照实说；② 新增 `lib/prompt/voice-intent.mjs` 只做**提示**——高精度短语（发条语音/念给我听/用语音说/念一遍）命中时本轮加一行 `【本轮要出声】`，是否发送仍由模型决定。刻意排除"吟唱/唱一首/读一下文件/说句话"这些真实误伤样本，并拦否定句。测试：`voice-intent` 5 项、`prompt-system` 11 项通过。

2026-10-19 收尾两项：① `qq-mcp/tools/make-sheets.mjs` 的 OneBot token 改为**只读环境变量**（`ONEBOT_TOKEN`），缺了直接报错——该文件在公开仓库里，写死等于公开接口凭据，**仍需轮换一次 token 并检查 git 历史**；② desktop profile 的 `awakeMs` 30000→**60000**，与代码默认值、AGENTS.md 对齐（在线已生效：`replyPolicy.awakeMs=60000`）。

2026-10-19 QQ 内置 AI 语音（`qq_send_ai_voice`）：用于先验证语音链路，**不引入任何 TTS 服务**。走 SnowLuma 的 `send_group_ai_record`（腾讯自己的 AI 语音，音色由 QQ 决定），新增 `qq_list_ai_voices` 列音色、`qq_send_ai_voice` 发语音；仅群聊，文本上限 200 字（`QQ_MAX_AI_VOICE_CHARS`），另加 `QQ_QUOTA_VOICE_PER_HOUR`(10) 小时闸；能力位新增 `send_voice`，兼容只授了 `send_sticker` 的旧部署。接入端必须回 `message_id` 才算成功，缺了记 UNKNOWN 并禁止自动重发；成功后往窗口写 `[语音：…]` 并刷新唤醒窗口。离线全量 **901 项通过**（MCP 79 项，含 4 个语音用例）。⚠️ **新增 MCP 工具需要重启 DSH**（MCP 子进程）才会出现在 QQ 会话的工具表里；未发送任何真实 QQ 语音。

2026-10-15 v82：收藏表情改为每轮动态随机注入 4 个真实候选，逐行放在当前消息前；LLM 按含义自主决定是否使用。角色、行为卡仍按原有首轮注入机制复用。

2026-10-15 Tulpa 情感卡 v81：在 v80 的轻量情感状态、自然缺口和可选 Emoji 基础上，补回自主判断与极短反驳；用户给出的“才不要”“我看未必”作为原样示范。Emoji 由模型按语境自行选择。工具/投递规则与 `qq-hosted` 预设继续使用当前桥接实际协议。在线 build 已更新为 v81；定向回归见 HANDOFF.md。详见 [行为卡](behavior.md)、[角色卡](persona.md) 和 实施记录（PROMPT_PLAN.md）。

2026-10-14 提示词系统 v75：小鲸鱼身份、傲娇、屑与小猫哈气保留，角色/行为原则改为正向描述并配人类示范；真实群友来回与 CPED 人工编剧对白分别注明来源，旧 AI 回复退出风格参考。固定投递/工具协议集中到首轮，每轮保留当前来源与相关材料；表达示范按场景最多两项、成功提交后去重。修改角色卡或协议会在下次输入创建新 Session，重载恢复游标，压缩/轮换重新注入。工具描述与预设重复条目精简，参数、授权和37项可见能力保持。详见 核对与实施记录（PROMPT_PLAN.md）。

同一离线输入的桥接首轮12358→5080字符，普通后续轮2575→714字符；QQ MCP可见27项schema 14844→12862字符。以上是字符比较，不代表实际token/费用。最终临时副本全量861项通过，在线 v80、精简预设与工具说明已加载；自然人格效果和最终用量待自然消息验证。详见 HANDOFF.md。

2026-10-14 启动黑屏修复：本机 CIM/WMI 查询卡住，`Get-NetTCPConnection` 在首次输出前阻塞，SnowLuma 的进程查询同样超时；实测约 9.4 GB 可用内存，3000/15099 未监听，19387 桥接在线。启动端口检查改用 .NET TCP listener 枚举，新增 `tools/windows-processes.ps1` 通过本机原生进程 API 读取 PID、父 PID、命令行，启动器与 SnowLuma 账号加载器共用；不再依赖这些 WMI 查询。批处理立即打印入口，PowerShell 显示检查阶段；账号仍需被确认才接入，检查失败不会猜账号或重复拉起服务。关闭旧黑屏窗口后重新双击即可复用已恢复服务。

验证：`node tools/run-tests.mjs launcher snowluma-launcher` 在临时副本中 **29 项通过**，包括真实 TCP listener 开关与原生进程读取；本机启动恢复 OneBot，机器人账号 `online=true/good=true`，已收到自然 QQ 消息。在线 build 仍为 `v74-conversation-facts-off`，托管/心跳 active，replyShapes=[]、awakeMs=60000、出站队列空；lastError 仍记录既有「回复恢复失败: The operation was aborted due to timeout」，本次未修复该恢复问题。未发送合成 QQ 消息，未改用户配置，未重启 QQ/DSH 或 Windows WMI 服务。

v73 验证：最新系统临时副本全量 **845项通过、0个测试文件失败**；线上v73任务筛选策略已生效，真实新回合的任务区长度由lastPrompt.taskContextChars观察。

v73 只读字符对比：同一当前数据库事实重建两版任务区，约3924→213字符（减少95%）；不等于整段prompt或实际token下降。status.contextPolicy.taskContext 标明筛选策略，lastPrompt.taskContextChars 记录成功提交的任务区长度。群／私聊20轮生命周期继续保留。

2026-10-13 任务提示词精简（`v73-compact-task-context`）：主回合不再每轮重复注入完整任务路由、任务账本和子代理清单。当前任务只保留目标、作者及必要结果；任务账本按当前作者、回复引用、明确任务 ID 和本轮委派结果筛选，最多3条；子代理状态合并到同一条事实，保留 job_id、状态、最新进度、结果可用性和投递状态。旧 recovering/needs_attention、无关作者的已结束任务和重复 execution/task ID 不进入普通提示词；需要查询未列出的进度时使用 qq_delegate_status。状态定义压缩为一行，仍明确“进度不是完成证据”“不授权重做”。完整账本继续留在 SQLite，路由和恢复不受影响。

2026-10-13 主窗口生命周期（`v72-twenty-turn-lifecycle`）：默认及 desktop profile 均为 `rotateEveryTurns: 20`。每个群／私聊分别计数，主 Session 成功提交一次 queue prompt 算一轮；同批短消息、多个回复气泡、工具调用、子代理步骤、只读路由／进度查询及旧回合恢复不会额外计数。第1—20轮使用同一窗口，第21轮新建 Session，重新注入人设／规则／记忆和近期上下文；旧窗口不再提交新回合，仅按旧 rpcId 恢复已提交回合。固定轮数模式不因60000提示词字符估算提前换窗；DSH压缩不清零生命周期。Session失效／归档、配置签名改变及显式强制轮换仍可提前替换。`rotateEveryTurns: 0` 仍可显式恢复字符预算模式。换窗前的记忆收尾（`lib/memory/flush.mjs`）与 `ensureSession` 共用同一个判定 `sessionRotationDue`，所以固定轮数模式下也不会因为提示词字符估算提前插一句「上下文即将清空」。群／私聊工作区文件、记忆、任务账本继续保留，旧窗口不自动删除。

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

长代码／写作／研究任务先用 `qq_say` 报实际计划，再用 DSH 原生 `subagent` 派后台子代理（`subagent_fork` 继承当前对话）。它非阻塞：只返回子代理 id 就已启动，父窗口继续聊天；成果由桥接的 `lib/application/subagent-results.mjs` 接住，排成父会话的一次执行、以 `delegatedResult` 交回并沿原发送队列投递。`list_agents` 查状态，`send_message` 追加要求，`interrupt_agent` 中止。子代理继承父回合的执行来源，因此能用同一 QQ 会话的工作区、文档与搜索工具；但**不能自己发消息、发文件、发贴纸或改群设置**——`lib/agent/execution-scope.mjs` 的 `SUBAGENT_DENIED_TOOLS` 会拒，交付一律由父代理完成（旧 `service.start` 那套靠 `toolFilter` 收窄子代理工具，换原生后由这道闸门兜住）。子代理不获得 shell、任意文件路径或群管理权限。只发工作阶段／结果摘要，不输出内部推理；代码可生成，但不会因此获得本机运行能力。

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

`start-qq-mcp.bat` 默认启动 SnowLuma：DSH 桥接已运行时，启动缺失的 SnowLuma，按本机 QQ 登录探测只接入机器人账号，再确认 online/good 后开启托管，成功后进入实时日志。重复启动复用服务，关闭查看窗口不会结束服务。普通 QQ 未运行时会启动它；需扫码/切换账号时仍由用户登录机器人号。管理页为 `http://127.0.0.1:15099`（原 5099 被 Windows 保留端口范围占用）。复用在线 SnowLuma 前会检查上报地址：如果配置文件已改成新的桥接端口、而运行中的 hook 进程启动得更早，只重启 SnowLuma 的 Node hook（不结束 QQ），再确认 online/good 后继续。`stop` 只关托管，`restart` 只重置托管。

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
└── test\                 离线测试（970 项，不需要 DSH / QQ）
```

真正生效的配置在 profile 里：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`。

另外 `tools\` 下是一堆**诊断脚本**，排查时很有用：

| 脚本 | 用途 |
|---|---|
| `check-buffer-health.mjs` | 看缓冲/ack 健康度 —— 排查"上下文不是最新" |
| `clear-stale-gaps.mjs` | 清掉库里夸大的假缺口 |
| `probe-bridge.mjs` | 往桥接端口发合成事件，验证入站链路 |
| `inspect-store.mjs` | 看库里各表、最近事件、待审批动作 |
| `probe-routes.mjs` | 只读诊断语义路由的失败分布与时序（可 `--hours/--since/--json`）；**先把库复制到临时目录再读，不碰线上库** |
| `audit-task-window.mjs` | 只读事故时序：入站、rpcId、journal 与发送回执；采用北京时间，不输出正文 |
| `check-ingress-latency.mjs` | 只读诊断"进 DSH 之前等了多久"：按路由结局拆开合并窗口与路由超时，并列出路由失败原因分布 |
| `check-input-aggregation.mjs` | 只读诊断输入聚合：真正聚合过的回合占比、窗口内命中率、以及"连环提问簇"本可少发几次回复 |
| `check-overlap-gain.mjs` | 只读诊断输入重叠的影子读数："生成与窗口并行"能省多少（savedMs）、会不会要扣着不发（heldMs）、生成期间又来了几条（late） |
| `check-turn-latency.mjs` | 只读诊断每个回合的**首字延迟**（turn/start → 第一条正文）与总时长，用来区分"等模型开口"和"写得慢" |
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
     ├─ notice:notify:poke ────────→ 桥接直接回戳 + 开清醒窗口（不进 DSH，见 §11）
     ├─ notice:group_msg_emoji_like → 只记下来，作为下轮上下文（不唤醒）
     ├─ request:friend|group ──────→ 落库 + 私聊通知你（不自动同意）
     │
     └─ message ───────────────────┐
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
| 分几条发 | 当前 desktop profile 的 `replyShapes: []` 关闭抽卡，由模型自行决定，**不封顶**（`maxBubbles` 已废弃）；正文里每个气泡用一对 `『』` 框起来，只有框内的字会进群，框外的排稿说明不会发出去；气泡之间按字数模拟“正在打字” |
| 发表情 | 当前关闭抽卡，由模型选择是否输出 `[表情:编号]`，桥接把它转换为收藏表情发送；标记一律摘干净，绝不作为正文发出去 |
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

归属校验依赖 MCP 与桥接连接同一个 `QQ_BRIDGE_DB`。共享 SQLite 启动/迁移的写锁等待上限为 2 秒；MCP 初次连接或归属表初始化失败后，后续工具调用会重新连接/初始化，避免进程永久失效。`qq_status` 显示桥接数据库与归属校验状态；数据库不可用时明确报连接故障，不能误报"来源过期"。有效期、撤回、会话隔离和文件工作区范围继续校验。

较长写作、编程、多轮网络搜索或耗时步骤可以用 `qq_say` 发简短进度，工具前的普通正文只留在 DSH。快速问答、短文润色和单次查询直接最终回复；仅任务拖长、受阻或有实际阶段结果时追加进度，不编造用时/百分比，最终保留完整结果。文件工具不再要求开工回执，已有文件可直接读取、修改、打包和发送。

发言后的唤醒遵循同一条规则：普通回复、心跳插话、`qq_say` 和群/私聊/表情发送工具，每条新消息成功发出后，从该时刻重新计时 60 秒。被戳时的回戳也算一次互动，会直接开同样的窗口（不经过模型，见 §11）。仅排队、心跳判断通过、发送失败/UNKNOWN/dry-run/幂等重放不会重新计时。纯 `[SKIP]` 不延长也不清掉已有窗口；窗口在最后一次互动 60 秒后自然到期。共享数据库保存互动时间，插件重载后可恢复尚未到期的窗口。`awakeMs: 0` 仍可显式关闭跟聊机制。

当前 `v36-agent-attention-timeline` 使用一次完整 Agent 回合决定清醒期的语义与回应。`groupAttentionEnabled` 默认开启：明确主要 @ 或引用其他成员先旁听，直接叫名字和引用她自己的消息正常接话；其余清醒期候选直接交给有完整人设、记忆和时间线的 Agent，生成回复或 `[SKIP]`。不再调用独立、无持续对话状态的分类器给模糊消息一票否决。短句、反驳、纠正和对她的邀请回应都应结合上一句话理解。沉默不发送、不续唤醒；明确路由旁听的消息仍保存为上下文与心跳未读。准入、白名单、60 秒成功发言唤醒、会话串行和投递规则保留。

`attentionInterjectCooldownMs` 默认 30000：向完整 Agent 提示刚发过言时避免另插话题，真正承接她的话仍可回复；不是回复前分类器的硬拦截。后台心跳保留轻量判断及数量/时间 OR 触发，每批处理后按已读规则消费。`replyPolicy.attentionMode=agent-decides`、`lastAttentionDecision.phase` 可核对旁听、沉默和回复排队；排队仍不是送达。

`v53-passive-input-floor` 把入站气泡、语义轮次与发送机会分开。默认 `inputDebounceMs=1500`、短消息（渲染后不超过 40 字）`inputShortDebounceMs=3500`、`inputMaxWaitMs=8000`、`inputBatchMaxMessages=24`：连发收集后在 `registry.run` 真正取得会话队列时取快照，排队期间也重新检查最后一条的静默时间；生成期间的后续消息再合批，不逐条排满模型回合。原始消息保留作者、真实 QQ 时间、引用、@、图片及消息 ID；同秒保持接收顺序，不按随机 ID 排序、不按角色分组。多人明确点名的独立请求分开回合；同人连续短句是否属于同一请求由完整时间线中的 Agent 判断。请求尚在收集/生成或 WAIT 时，请求者没 @ 的补充也能承接；其他群友的背景插话进入时间线，仍受原准入约束。

纯群表情包、QQ 表情和动画表情只记录背景上下文，不能单独创建 DSH 回合、恢复 WAIT 或调用心跳分类，也不会触发发送前语义复核。收集中的表情可附带在原批，生成中到来的表情保留到下一条有效输入；每批最多附带 8 条且给有效输入留位置，刷屏表情不能强制提前派发或堵住短消息。有 @、引用或实际文字的表情消息仍走正常准入，私聊和普通图片策略保留。批内背景表情不附图片字节；明确要求看表情时可取最近的同作者目标，其他对象可用引用指定。

`floorManagementEnabled=true` 时，模型需要等待补充可只输出 `[WAIT]`，需要退避可输出 `[SKIP]`。WAIT 按请求者保留输入至 `floorWaitMs=30000`，只由对应请求者的非被动消息恢复判断；多个请求者各自等待、各自到期，其他成员的新请求不覆盖等待内容。到期不自动催问、不自动发言。心跳在输入待处理或 WAIT 时退避。输入缓冲、WAIT、DSH 回合所有权和投递计划写入共享 SQLite，重载后按已认领输入恢复，避免重新提交未知结果的工具回合。`inputDebounceMs: 0` 关闭收集延迟，`floorManagementEnabled: false` 关闭发言复核；唤醒仍只由 `activity.mjs` 的成功新发送刷新。

#### 输入重叠的影子读数（2026-10-21）

现在"先等窗口、再生成"是**串行**的。想改的形态是"第一条到了就开跑、但仍然守在窗口结束后才发"——
不抢答、防刷屏的效果一点不丢，只是把两段重叠。上线前先只记录、不改变行为：

- 每个真实回合结束时记一条样本：`waitMs`（实际付掉的窗口）、`queueMs`（上一轮没跑完导致的串行等待）、
  `genMs`（派发→产出）、`savedMs`（重叠后能提前多少）、`heldMs`（生成比窗口快时要扣着不发多久）、
  `late`（生成期间又到了几条）。
- 样本存在 `runtime_state` 的 `qq-bridge:input:<会话>` 里（每个会话最近 24 条），
  `GET /qq/onebot` 的 `inputOverlap` 是汇总，`node tools/check-overlap-gain.mjs` 是只读报告。
- **截止时间按批冻结**：从第一条消息到达算起，最多 8 秒（`inputMaxWaitMs`），新消息不能把它往后推；
  否则活跃群会永远发不出去。影子里的 `savedMs` 用的就是这个口径。
- 判定能否真开：`savedMs.p50` 明显 > 0，且 `heldCount`/`late` 的比例可以接受。
  `late` 高则必须先想清楚合并策略，不能简单丢掉。
- `queueMs` 高说明"上一轮没跑完"才是主因：那时候该谈并发/长回合隔离，而不是继续抠窗口。

#### 先量首字：时间到底花在哪（2026-10-21）

`tools/check-turn-latency.mjs <Session 目录>` 从真实会话日志里算
`turn/start → 第一条 assistant 正文` 的间隔。用它量 group 1033440455 的 7 个真实回合：

| 回合 | 首字 | 正文 | 工具调用 | 步数 |
|---|---|---|---|---|
| 1 | 7.37s | 41 字 | 0 | 1 |
| 2 | 8.76s | 36 字 | 0 | 1 |
| 4 | 13.24s | 51 字 | 0 | 1 |
| 5 | 4.49s | 35 字 | 0 | 1 |
| 6 | 8.86s | 27 字 | 0 | 1 |
| 7 | 11.96s | 28 字 | 0 | 1 |
| 8 | 5.98s | 28 字 | 0 | 1 |

首字 **p50 = 8.76s**，正文都只有几十字，工具 0 次、步数 1。也就是：时间几乎全花在
**等主模型开口**（当时 a6api / deepseek-v4.1-flash），不是桥接、窗口、工具或生成。
同一时段官方 `deepseek-flash` 的辅助调用平均 0.7~1.2s（`auxHealth.labels.avgMs`）。

`stats.lastTurn` 现在也带 `ttftMs` / `totalMs`，`stats.lastLatency` 存最近一次，
`stats.ttftSamples` 是最近 30 次的首字延迟，`#debug status` 的【模型回合】会显示
"首字 Xms / 总 Yms"。换模型或换线路后，用同一个工具对比即可。

生成后以及每个待发气泡/表情派发前复核最新消息，候选只包含剩余未发正文。明确请求者取消/撤回会结束待发内容；答复、纠错、确认和结果不因换话题而取消。更新必须指向原请求者实际修改原要求的消息，重新判断只合并这些证据对应的输入，独立新问题不合并；丢弃必须标明纯闲聊、确已过时及具体新消息证据，其他人的互动不能否决直接请求。仅当时间线变化且有实质内容时，用当前模型作一次有完整上下文和候选正文的轻量复核，超时 4 秒、坏 JSON 或缺少证据回退保守规则；回退只识别明确取消/撤回与明确修改，不按同作者又发言或多人数量丢答复。同版本同候选复用判断；无变化、纯背景表情/确认及工具结果无需额外分类。语义分类仍可能出错，需自然实聊观察。工具回合的结果保留交付，普通补充不会重跑工具；明确取消后不继续文件写入/发送。已成功气泡保留原回执，尚未派发的过时内容以 `floor:<原因>` 结束，UNKNOWN/EXECUTING 仍需人工核对。

`qq_say`、群/私聊文字及图片/表情工具共用 SQLite 归属复核：桥接按真实 DSH Session 注入本轮来源，模型不需要也不能自填，换工具不能绕过。跳过返回 `SKIPPED`，不记发言、不刷新唤醒、不占图库冷却；收藏表情保留结构化回执。在线 `replyPolicy.floorMode=request-batches-and-reply-value-recheck`、`inputBatches`、`lastFloorDecision` 可查行为；后者包含 value/basis/evidence 与 fallback，解释为什么保留、修订或丢弃。stats 保留 `inputBatches/inputsCoalesced/floorWaits/floorDeclined/floorRechecks/floorRecheckFallbacks`。真实 QQ 不发合成验证消息。

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
> **同一个模型**（`a6api/deepseek-v4.1-flash-1017`），不是更便宜的模型。
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

**砍掉的**：`tool-ask-user`（`ask_user_question`，2026-10-27 拔掉：它的提问卡只在
DSH 桌面/Web 端等人点，QQ 回合没有 answerer，一问整轮就停在「等待你的操作」，
群里后面的消息全部排队卡死）、`tool-pwsh` / `tool-bash`（shell）、`workflow`、`plugin_manager`、
`mcp-rars`、`plan-mode`、`compaction`、
`tool-goal` / `tool-todo` / `tool-skill`，以及 document-editor 里**能打开任意路径**的那批
（`read_*` / `modify_*` / `edit_pdf` / `verify_document`）和 Excel / PPT 工具。
DSH 原生 `subagent` 一组（`subagent`/`subagent_fork`/`list_agents`/`send_message`/`interrupt_agent`）
自 2026-10-23 起**放行**，取代下线的桥接 `qq_delegate` 四件套。

每个 QQ 群/私聊使用独立目录：`%USERPROFILE%\.dsh\qq-workspaces\group-<群号>` 或 `user-<QQ号>`。`qq_workspace` 只接受工作区内相对路径，支持列文件、读写 UTF-8 文本和 ZIP 打包；最多 200 个文件/50 MiB，单文件 20 MiB。`qq_send_file` 只发送当前会话目录里的普通文件。QQ 预设没有通用文件工具或程序执行工具，小游戏源码可作为 HTML 或 ZIP 发回；要试玩 HTML 需在本机浏览器打开。

文件工具直接使用当前 `conversation` 和 QQ 会话工作区（本轮归属由宿主按 Session 绑定）；`qq_say` 只用于需要即时告知对方的开工或阶段进度，不再作为文件读写、打包或发送的前置条件。文件仍校验归属有效期、会话归属、相对路径、链接/硬链接和能力位；`read/list`、写入、打包、发送都只触及当前群或私聊目录。在线状态的 `workspace.progressPolicy` 为 `source-and-conversation-workspace`。

要交 Word / PDF 时不用自己拼二进制：`create_word_document` / `create_pdf` 直接生成 `.docx` / `.pdf`。这两个是 document-editor MCP（独立进程，cwd 不是会话工作区）的工具，`output_path` **只认绝对路径**，所以每轮提示词都会摊开本会话工作区的绝对路径（`【工作区绝对路径】` 一行）；产物必须落在该群或私聊目录里，随后可直接用 `qq_send_file` 发送。

只放开了"写"这一侧。`read_word_document` / `read_pdf` / `modify_word_document` / `modify_*` / `edit_pdf` / `verify_document` 都能打开**任意绝对路径**的文档 —— 那等于把群消息变成"读、改操作者机器上任何 docx/pdf"的入口，所以留在 tool-scope 的过滤名单里；Excel / PPT 只是当前没给。要增减就改 [`lib/agent/tool-sets.mjs`](lib/agent/tool-sets.mjs) 的 `DOCUMENT_TOOLS`：`tool-scope` 与 `tools/audit-prompt-cost.mjs` 共用这份名单，不会两边漂移。

> 这套限制是**两件事一起解决**的：既省 token（工具 schema 从 ~31.6k 降到 ~10k 量级），
> 又消除了"群里的人能间接使唤你的 shell"这个隐患。详见 §14。

群内成员仍可要求 Agent 在该群共享工作区里创建、修改和发送程序文件；群白名单仍通过 `groups` 管理。工作区限制模型能接触的文件范围，不提供执行代码的能力。

文件属于 QQ 会话工作区，独立于任务、DSH Session 和创建文件时的来源编号。同群/同私聊新回合自动带自己的有效归属即可读取旧文件并继续修改、打包或发送；旧来源过期不删除文件，其他群/私聊仍隔离。任务路由仍只决定模型上下文和执行归属，不再改变文件目录或文件工具可见范围。

### 5. 它能主动发的 QQ 动作（`mcp__qq__*`）

| 工具 | 用途 |
|---|---|
| `qq_status` | 查链路 + 显示当前生效的授权、配额、图库占用 |
| `qq_get_group_list` / `qq_get_friend_list` / `qq_get_group_member_list` | 查群、好友、群成员 |
| `qq_send_group_msg` / `qq_send_private_msg` | 发文字、内置表情、图片、@ 某人 |
| `qq_list_stickers` / `qq_send_sticker` | 从**本机表情包仓库**（`stickers/`）挑图发。⚠️ 该目录当前是空的，这条路现在发不出东西 |
| `qq_list_custom_faces` / `qq_custom_face_sheet` / `qq_view_custom_face` / `qq_send_custom_face` | 读**账号收藏表情**（真正在用的那条链路）；`qq_custom_face_sheet` 把上百张拼成一张带编号的总览图，**一眼看全、只算一张图的成本** |
| `qq_send_mface` | 发 QQ 原生动画表情（收藏表情只能拿到静态首帧，要动图得走这个） |
| `qq_send_ai_voice` | 用 **QQ 自带的 AI 语音**把文字念成语音发到群里（不依赖本地 TTS、不需显卡）；音色固定「傲娇少女」，没有挑选接口 |
| `qq_send_voice` / `qq_voice_library` | 把**语音库里一段现成音频**当语音气泡发出去（点歌、哼一段），以及查看库里有哪几条；库在 `~/.dsh/qq-voices`，见「语音库」一节 |
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

共 **35 个工具**，分 **15 个能力位**：`send_text`、`send_file`、`send_image`、`send_sticker`、
`send_voice`、`read_favorites`、`read_image`、`manage_group`、`set_profile`、`poke`、
`read_requests`、`handle_request`、`react`、`read_group_info`、`read_forward`。

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
| `contextHistoryCount` | `25` | 回读多少条；desktop profile 当前为 40 |
| `contextHistoryCacheMs` | `20000` | 回读结果缓存多久（0 = 每轮都拉）|
| `contextHistoryTimeoutMs` | `3000` | 回读最多等多久；超时退回内存窗口照常回答，记 `historyFetchTimeouts` |

回读失败**不影响发言**：catch 住、记一笔 `historyFetchFailed`、退回原窗口。

**入站预取（2026-10-21）**：消息一被接纳（`stats.accepted` 之后）就顺手发起一次回读，
不再等回合开始才拉。成功会写 `historyFetchedAt`，回合开始时命中 TTL 直接跳过网络；
进行中的请求有并发去重（`entry.historyFetching`），不会打两遍。这样
`get_group_msg_history` 的耗时被藏进 1.5~3.5 秒的合并窗口里——实测这一步 p90 可到 7 秒，
现在它不在关键路径上了。预取失败与超时仍走原来的退回逻辑，不影响发言。

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

### 11. 被戳只回戳，然后醒着

OneBot 有四类上报：`message`、`message_sent`、`notice`（戳一戳、输入状态、撤回、
群成员变动）、`request`（加好友、入群申请）。本插件原来**只处理 `message`**，
其余全丢 —— 所以别人戳它，它毫无反应。

现在默认**不把戳一戳交给 DSH**。桥接收到 poke 后只做两件事：

1. **回戳一下**（群里 `group_poke`、私聊 `friend_poke`）—— 这是"戳回去"这个动作本身；
2. 把该会话的清醒窗口开到 `awakeMs`（默认 60 秒）。

之后 60 秒内群里没 @ 她的正常消息会像"刚被打过招呼"一样继续参与判断；没人说话就
到此为止。**不会每戳一下就生成一句回复**，也不会让模型去评论桥接合成的
「（对方戳了你一下）」。这是最像真人的一条：被戳是"引起注意"，不是"提出问题"。

| 配置 | 默认 | 说明 |
|---|---|---|
| `pokeReplyEnabled` | `false` | 总开关。**第一道闸门**，关着就什么都不做 |
| `pokeReplyMode` | `'wake'` | `wake` = 回戳 + 开清醒窗口；`text` = 回固定文案；`agent` = 完整回合 |
| `pokeReplyMinIntervalMs` | `10000` | wake / text 的全局最小间隔 |
| `pokeReplyPerSenderPerHour` | `5` | wake / text 每人每小时上限（落盘）|
| `pokeReplyGroups` | `[]` | 群里只回戳这些群（仍受 `groups` 白名单约束）|
| `pokeReplyGroupText` | `true` | `text` 模式群里是否也说一句 |
| `pokeAgentMinIntervalMs` | `30000` | `agent` 模式的全局最小间隔 |
| `pokeAgentPerSenderPerHour` | `6` | `agent` 模式每人每小时上限（落盘）|
| `pokeAgentSendPoke` | `true` | `agent` 模式是否先自动回戳 |
| `pokeAgentGroupText` | `true` | `agent` 模式群里是否也回话 |

实现上的几个取舍：

- **窗口来自"被戳"，不是"回戳成功"**。先开窗口再调 OneBot：回戳慢或失败都不影响
  紧随其后的消息进窗口；失败只记一条 warn，不会变成回合错误。
- **窗口时间与发言共用** `qq-bridge:speech:<会话>`，插件重载后 `refreshSpeech`
  能恢复尚未到期的窗口（60 秒很短，但重载正好落在窗口里时不会突然装睡）。
- **私聊戳也回戳**，但私聊没有"清醒期跟聊"，所以只回戳、不开窗口。
- **旧的 `agent` 模式保留但不再是默认**：它会把 poke 归一化成一条合成消息，走
  "被 @ 到"完全相同的主流程，提示词里明确写"这是戳一戳，不是消息"。带人设、记忆、
  群上下文和工具，但每戳一次就是一轮推理，而且实测很容易变成"戳一下就回一句"。
- **`text` 模式**只回随机固定文案；两种旧模式都还在，配置即可切回。

两个语义坑记一下：

- **总开关和托管开关是两道独立的闸门**。`pokeReplyEnabled` 关着、或者托管
  （`agentEnabled`）关着，戳一戳都不会回 —— 关托管就是"别动"，回戳也算动。
- **私聊事件里 `user_id` 是机器人自己**，`target_id` 才是戳你的人。`agent` 模式归一化
  时把真正的戳人者放进 `__pokeSender`；否则提示词里报错的发言人 QQ 会让它对着自己说话。

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
`tool-web`、`tool-result-pruner`，
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
| QQ 专用模型 | `a6api/deepseek-v4.1-flash-1017`（2026-10-23 从旧 id `deepseek-v4.1-flash` 切到带日期的快照；providers 名录里只登记了这个 id，且已声明 `input: [text, image]`，识图实测 4/4） |
| 思考等级 | **`off`**（群聊要的是"快嘴回一句"，不是深度推理；也省输出 token）|
| 工作目录 | `D:\作业\计算机组成原理` |
| 心跳 | 开，每群第 6 条未读或等待 5 分钟到期时判断；10 分钟兜底扫描 |
| 上下文来源 | **QQ 历史直读**（`contextFromQQHistory: true`，25 条，20 秒缓存）|
| 上下文条数 | 别人的 10 条 + 自己的 15 条，**从新到旧**，紧贴当前消息上方 |
| 记忆 | 开，20 条上限，按 QQ 号一份 |
| 调试命令 | 仅 `1056612947` |
| 戳一戳回应 | 开，`wake` 模式（回戳 + 60 秒清醒窗口，不提交 DSH），全局间隔 10s，每人 5 次/小时 |
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

### 崩溃保护：DSH 起不来时先看 cookie 库

2026-10-31 的事故：DSH 弹窗 `DeepSeek Harness is unavailable — desktop welcome: Web authentication failed`，点"关闭第三方插件并重启"**也没用**。

根因不在插件、不在 profile，而在 Chromium 的 cookie 库：DSH 每次启动都会往 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies` 写一个 `dsh-auth-<随机>`；cookie 是**按域名**存的，而启动端口每次都不一样，所以旧的那些永远不会被复用、也从来没被删。本机堆到 **71 个**之后，每次请求都带着 71 个历史令牌，Host 认不出来就回非 2xx —— 于是外壳拿不到自己的登录态，启动失败。它还会伪装成"插件坏了"，因为报错发生在插件加载之前。

```
node tools/dsh-guard.mjs status      # DSH 在不在、认证 cookie 堆了多少、上次怎么崩的
node tools/dsh-guard.mjs prune       # 清掉（先备份 Cookies.bak-<时间>）
node tools/dsh-guard.mjs watch       # 守护：掉了先修剪再拉起，退避 30s→1m→2m→5m
```

三层保护：

| 什么时候 | 谁来做 | 行为 |
|---|---|---|
| 用 `start-dsh.ps1` / 控制台启动 | 脚本自己 | 启动前自动 `prune`，DSH 没跑才动手 |
| 你自己双击 DSH | `dsh-watch.bat`（双击后窗口留着） | 30 秒探一次，发现它掉了就修剪 + 拉起，日志同时写 `%TEMP%\qq-dsh-watch.log` |
| 想先诊断 | `node tools/dsh-guard.mjs status` | 顺带把最近一次崩溃分三类：认证失败 / 热重载竞态 / 其他 |

两条硬约束：

- **DSH 在跑的时候不要动那个库**。Chromium 独占着它，连只读都打不开（`prune` 会直接告诉你"正在运行，先关掉"）。这也是为什么只能在启动前清。
- `watch` 只负责把掉下去的那截接回来，**永远不主动关 DSH**；连续失败按阶梯退避，不会变成重启风暴。

### 控制台：桥接挂了也能开的那一页

面板有个先天缺陷：它由桥接插件自己挂出来，**桥接一挂、DSH 一关，页面跟着消失**——而那正是最需要看它的时候。控制台是一个独立 node 进程，补的就是这段：

```
双击 console.bat                         # 没在跑就起一个，然后开 http://127.0.0.1:7788/
console.bat -Port 7799                   # 换端口
console.bat -Stop                        # 停掉控制台（DSH / QQ 一概不动）
```

它把三件事分开报，因为它们的修法完全不同：

| 卡片 | 怎么判 | 挂了会怎样 |
|---|---|---|
| **DSH** | 进程名像 `DeepSeek Harness` 的 pid → 它名下 LISTEN 的端口（`netstat -ano` + `tasklist /FO CSV`） | 全都没了，页面还在 |
| **桥接** | 拿上面这些端口逐个 GET `/qq/onebot`，只认带 `ok`/`agentEnabled` 的 JSON | DSH 在跑但插件没加载 → 卡片显示「DSH 在跑，但 /qq/onebot 没响应」 |
| **SnowLuma** | `POST 127.0.0.1:16000/get_status` + `get_login_info`（令牌从 `config/onebot_<uin>.json` 读，不出服务端） | 接口在但账号掉了 → 「接口在，账号没就绪」，和"没启动"分得开 |

能点的事：**一键启动全部**、单独启动 DSH、启动接入、开/关托管、重置托管、打开 DSH、打开面板。

顺序是硬性的 —— **DSH → 桥接插件 → SnowLuma 与托管**。接入端要往桥接上报群消息，桥接没起来就先起接入，`Sync-SnowLumaBridgeUrl` 会把上报地址写成一个还不存在的端口，消息全部丢失。所以「启动接入」在桥接没起来时是禁用的，并直接说明原因。

控制台自己**不实现**任何 QQ 逻辑：启动接入一律调 `tools/start-qq-mcp.ps1 -Mode start`（互斥锁、复用在线账号、同步上报地址都在那里），启动 DSH 调 `tools/start-dsh.ps1`，它只负责顺序、超时（240 秒）和把子进程输出实时搬到页面日志里。同一时刻只允许一件事在跑。

配置全走环境变量（都能在 `--flag` 形式下覆盖，因为 WMI 起进程带不了环境变量）：

| 变量 | 默认 | 用途 |
|---|---|---|
| `QQ_CONSOLE_PORT` | 7788 | 控制台端口 |
| `QQ_ONEBOT` | `http://127.0.0.1:16000` | SnowLuma 的 OneBot 接口 |
| `QQ_SNOWLUMA_DIR` | `..\..\SnowLuma-validation\runtime` | 读 OneBot 令牌用 |
| `QQ_DSH_EXE` | 自动 | DSH 可执行文件，猜不到时指给它 |
| `QQ_BRIDGE` | 自动发现 | 直接指定桥接地址 |
| `QQ_PANEL_TOKEN` | 空 | 桥接配了 token 时用（只留在服务端） |
| `QQ_CONSOLE_TOKEN` | 空 | 给控制台自己加一道口令 |

安全边界：只监听 `127.0.0.1`；写接口（`POST /api/action`）带 Origin 就必须与 Host 同源，`Sec-Fetch-Site: cross-site` 一律 403 —— 这个进程能拉起进程，不能让任意网页 POST 进来。它没有退出登录、没有端口转发，不会出现在局域网里。

启动方式是 WMI 建进程（`Invoke-CimMethod Win32_Process.Create`），不是 `Start-Process`：后者挂在当前窗口的作业对象下面，关掉批处理窗口就一起没了。输出重定向到 `%TEMP%\qq-console.log`——WMI 起的进程没有可写的控制台句柄，不重定向的话它第一次 `console.log` 就可能 EPIPE 崩掉。

### 面板：一页回答"活着吗 / 哪坏了 / 慢在哪"

```
http://127.0.0.1:<DSH 的端口>/qq/onebot/panel
```

端口就是 DSH Web GUI 的端口（每次重启可能变）。面板挂在 DSH 的 webServer 上，跟桥接共存亡：插件没起来就是 404，不用另起服务。

懒得记端口就双击 **`open-panel.bat`**：它扫一遍本机 LISTEN 的端口（先试 DSH 进程名下的），用"页面里有 `id="verdicts"`"当命中条件，找到了就交给默认浏览器。

```
open-panel.bat                 找端口并打开
open-panel.bat night           直接开夜间主题（day / night）
open-panel.bat -Port 10692     跳过探测
open-panel.bat -Token xxxx     配置里带了 token 时（或设 QQ_PANEL_TOKEN）
open-panel.bat -NoOpen         只打印地址
```

逻辑在 `tools/open-panel.ps1`；`.bat` 只做一层 ASCII 转发（cmd 按 OEM 代码页逐字节读 bat，中文会碎，跟 `start-qq-mcp.bat` 同一个理由）。

| 你看到的 | 它怎么来的 |
|---|---|
| 顶部判定条 | `lib/panel/verdicts.mjs` 纯函数（零依赖，node 单测和浏览器跑同一份源码），红 > 黄 > 灰排序，每条带「看明细 →」跳到对应 tab |
| 判断流 | `status.auxDecisions`：最近 80 条辅助判断，每条带「判的是哪句话 / 结论 / 模型自己给的理由 / 它吐的原文」，可展开原文、按调用点筛选、「只看没接」。本地规则裁决（被 @ 别人、叫她名字、三条护栏、fail-open）也进流，但不计入 `auxHealth` 的成功率 |
| 会话表 | `awake` + `heartbeat.groups` 拼的，默认只列 24h 内有动静或清醒中的，勾「显示全部」看全量 |
| 任务 / 投递 | `tasks`（含排队输入与活跃执行）、`replyDelivery` 的待送达与最近失败 |
| 失败面 | `reliability` + `stats.recovery` + `stats.lastError`，底部是处置记录 |
| 设置 | `lib/admin/spec.mjs` 白名单 + `GET/POST /qq/onebot/admin/*` |
| 记忆 | `memory/` 目录（`diary.md`、人物卡、`groups/`） |
| 运行状态（右栏） | 最后一个回合、参与决策/心跳的比例计数、prompt 组成、模型与档位、辅助层成功率、登录、出站队列 |
| 原始 JSON | 折叠在底部，接口原样，没美化 |

右上角的托管开关走 `POST /qq/onebot/control`（`confirm` 一次才发）。`?tab=delivery` / `?tab=failures` / `?tab=settings` / `?tab=memory` 可以直接落到某个 tab。

外观是国风卡通平面（宣纸底、墨线描边、硬投影无模糊，配色取自参考项目：朱砂 `#C44E3A` / 古金 `#D4A84B` / 石绿 `#5B8C5A` / 青金 `#26619C`）。两套主题全在 `:root[data-theme=day]` 与 `:root[data-theme=night]` 的 CSS 变量里：右上角「昼/夜」按钮切换、记在 `localStorage`（`qq-panel-theme`），没选过就跟系统 `prefers-color-scheme`；`?theme=day` / `?theme=night` 可强制某一套（截图、临时看夜间都方便）。首帧由 `<head>` 里的一小段内联脚本决定，不会白闪。

鉴权跟 `/control` 同一套：`token` 配了就必须带 `?token=...`（页面把 token 放进 `Authorization` 头，不写进 HTML）；没配就直接能打开。页面 30 秒轮询一次，标签页隐藏时停。

改 `lib/panel/shell.html` / `lib/panel/app.js` 后**刷新页面**就生效（面板按 mtime 重新拼页，不必重载插件）；`node tools/run-tests.mjs panel` 是它的套件。

#### 设置 tab：改完立即生效，但不写 DSH 的配置文件

能改的东西是**白名单**：`lib/admin/spec.mjs` 里那 26 项（人设/规矩/示例三份文本、注入层级、上下文轮数与字符预算、主/aux provider 与模型、心跳五个参数）。清单外的一律拒——这些键是"改了知道会发生什么"的，其余一百多个继续走 DSH 设置页。

值不写进 `~/.dsh/profiles/desktop/cordis.patch.yml`，而是落到 `data/panel-settings.json`，同时就地改运行中的 `config` 对象：

- **为什么**：DSH 自己也会写那份 YAML（还留 undo 快照），两个写者抢同一份文件，写坏一次插件就起不来。
- **代价**：DSH 设置页看不到这里的覆盖值；好处是覆盖层不动原文件，重载时 `createAdmin()` 在服务构造之前把覆盖值重新盖上去，所以**重启也还是你改的值**。
- 「恢复默认」= 写回插件启动时拍的基线（也就是 YAML 里那个值），不是"清空成 0"。
- 每次改动进 `history`（上限 100 条，带备注），面板底部「最近改动」就是它。

生效时机：

| 改什么 | 什么时候生效 |
|---|---|
| 人设 / 规矩 / 示例 | 下一轮（`resolveTextField` 按 mtime 重读，不用重载） |
| 注入开关、轮数、字符预算 | 下一轮（`execute-turn` / `context` 每轮读 config） |
| 主 / aux 模型 | 下一条会话新建时；已存在的会话不变 |
| 心跳参数 | 下一个判断周期 |

#### 记忆 tab：日记、人物卡、群记录

`memory/` 下每个 `.md` 都能浏览和手改，列表用文件第一行的标题（`# 天梦·幻（QQ 1056612947）`）而不是裸 uin。写之前先把旧版备份到 `data/panel-backups/`，原子替换。路径只认 `memory/` 之内的 `.md`：`..`、绝对路径、`.txt` 一律拒——面板可能被代理到别处，这条边界必须写死。

顺带一提：`diary.md` 是桥接从 SQLite 投影生成的，**手改会被下一次同步覆盖**。要在日记里留东西，让 agent 走 `qq_memory`（scope=self）。

#### 处置：面板上直接把卡住的东西结掉

看见红的之后，原先是"知道哪坏了，然后开命令行"。现在每个出问题的行都带按钮，走同一条后端通道 `POST /qq/onebot/admin/action`（清单：`GET /qq/onebot/admin/actions`）：

| 动作 | 出现在哪 | 干什么 |
|---|---|---|
| `receipt.markSent` / `receipt.markFailed` | 失败面「待核对回执」每一行 | 人工核对 UNKNOWN 回执后把它定成"真发出去了/确实没发"，别让它一直占着待核对列表 |
| `delivery.retry` / `delivery.abandon` | 投递 tab「待送达」每一行 | 重排一次（`retryAt` 设为现在）或彻底放弃（`state='failed'`，详情写"已放弃恢复"） |
| `task.settle` | 任务 tab「活跃任务」每一行 | 把卡住的执行判死（`failed` + `panelNote`）。**只判死，不谎报 done** |
| `queue.flush` | 判定条「队列在途」 | 立刻催一次出站队列，把在途时间清掉 |
| `conversation.reset` | 代码调用 / 后续会话页 | 清掉某个会话的上下文与窗口（危险动作，要 `confirm: true`） |
| `heartbeat.poke` | 设置页心跳现状表每一行 | 跳过冷却，立刻判一次"这个群该不该插话" |

几条写死的规矩：

- **危险动作要 `confirm: true`**。面板会先弹 `window.confirm`，但后端不认"前端弹过了"——没有这个字段一律 400。这样误发的 curl、脚本、跨站请求都过不去。
- **`idemKey` 幂等**：同一次点击重发不会执行两遍，返回 `replay: true`。
- **写审计**：每条（成功、失败、参数校验不过）都追加到 `data/panel-audit.jsonl`，面板「处置记录」读它——所以 HMR 重载插件后，刚才点了什么、成没成，还在。
- 动作层是 `lib/admin/actions.mjs` 里的一张 `ACTIONS` 表，加动作 = 加一条登记 + 一个 handler，路由不用动。

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

每轮按真实 DSH Session 绑定来源，发送工具由宿主自动注入；桥接也按已归属的 DSH turn/callId
补记来源，兼容旧调用。没有来源证据时明确标为「来源未记录」，不猜是谁委托。
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

每次工具调用由宿主按真实 DSH Session 注入来源并核对归属，只能管理当前发送者；
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
同一 key 再次被提到时，提炼器会判「印证」还是「纠正」：印证只加证据（`confirmations` +1、
`confidence` 升一档、刷新 `lastSeen`，原文不动），纠正才覆盖。旧 `.facts` 缺这些字段时按
`confirmations: 1 / confidence: 0.5` 补齐，不做迁移。

### 规律归纳（L4 反思）

`memoryReflectEnabled` 默认开启。它只读某个人**已有的记忆条目**（不读聊天原文），归纳"在什么条件下他会怎么做"
这类可被下一轮对话验证或推翻的规律，把整段 `## 规律` 写进 `memory/<qq>.md`，每条一行：
`- 规律内容（支撑：key1、key2；置信度 0.7）`。

输入以 **agent-memory（SQLite，主模型通过 `qq_memory` 写的记事）为主**，`FactStore`（`.facts`，后台提炼器写的事实）
为辅：两源合并、同 key 去重后一起排序。之所以要两源，是因为 `memoryAutoExtract` 默认关时 `.facts` 基本为空
（线上 10 个档里 9 个是 `[]`），只读它会让反思永远够不到门槛。

- 频率：每人默认 24 小时最多一次（`memoryReflectIntervalMs`），且**两源合并后**至少 8 条才跑
  （`memoryReflectMinFacts`）。上次运行时间写在共享库的 `qq-bridge:memory-reflect`，插件重载不会立刻重跑；
  没有持久化时**不启用**（否则重载等于重刷上游）。
- 选材：按 `confidence × exp(-daysSinceLastSeen/30) × log(1+confirmations) × 版本因子` 取前 `memoryReflectTopFacts` 条。
  记事条目按 `confidence: 0.6 / confirmations: 1` 参与排序，并以 `log(1+version)/log(2)` 加权（v1 = 1，改写过越多越靠前）；
  提炼事实沿用 `confirmations`/`confidence`，没有版本因子。
- 校验：`supports` 必须引用输入里真实存在的 key（记事条目用它的 `slot`），引用到不存在的 key 整条丢弃；
  一条都没通过就不写，不会用空段把上一次的规律抹掉。
- 失败：上游/解析/写盘失败只记 `stats.lastMemoryReflect` 与持久状态（并占住 24 小时窗口），不影响聊天回合。
- **不接入提示词**：没有新增注入点，也不改 `toneAnchor` / `persona.md`。规律段会随人物 md 走既有的
  "人物记忆"通路（`compactPersonMemory` 里最低优先级，预算够才出现）；要它真正影响语气，人工挑过再写进
  `## 手工记忆` 或 persona。
- 查看：`memory/<qq>.md` 的 `## 规律`；在线 `memory.reflect`（`runs`/`failed`/`rules`/`last`，`last.inputs`
  给出这次两源各取了多少条）。
- 手动触发一次：把 `memoryReflectIntervalMs` 临时调小并重载（扫描周期 `memoryReflectTickMs` 默认 10 分钟），
  或在 REPL 里调 `memory.reflector.reflectSubject('user:<qq>', { force: true })`。

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
| `windowTurns` | `10` | 保留最近 Agent 回合对应的消息，同时受双方消息条数上限约束；desktop profile 当前为 12 |
| `rotateEveryTurns` | `30` | 每多少轮换一个新 Session；desktop profile 当前为 30（2026-10-24 由 45 降到 30，给图片/长文留窗口余量） |
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
| `voiceLibraryRoot` | 空 | 语音库根目录；默认用户目录下 .dsh/qq-voices，也可用环境变量 `QQ_VOICE_LIBRARY`。与工作区**刻意分开**：库文件由 SnowLuma 直接读本机路径，不占会话配额 |
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
| `bubbleProtocol` | `auto` | 正文怎么切成气泡：`auto` = 有 `『』` 就只发框内，没有框且正文像排稿时只捞最后一轮的引号候选句（捞不到就不发）；`brackets` = 严格只发 `『』`，没框一个都不发；`off` = 旧行为（整段按空行切）。气泡数**不封顶**，`maxBubbles` 已废弃 |
| `replyRecoveryMaxAgeMs` | `900000` | 超过这个时长仍无 outcome 的"进行中"执行视为不可能恢复，收敛成 `failed` 终态（否则它永久占着 `recovering`，让 task 永久 busy 并卡住 `pump`）。用执行自己的 `times.received` 判定，不用 `updated_at` |
| `replyStaleDeliveryMaxAgeMs` | `600000` | **迟到投递护栏**：`following`／`output` 这类还没有确认结果的行超龄一律不再恢复投递，直接转 `failed`。**行龄从"最后一次确认这一轮还活着"算起**（`bridge_replies.alive_at`，回合归属行还在时由恢复循环续心跳）：回合还在 DSH 里跑就不判死，`turn/end` 取走归属后才开始倒计时，长回合收尾的正文还能被 `runTurn(resume)` 取回来。迟到的回复比不回复更糟——它答的是一个早已结束的话题（实测曾一次性把 14 条 3–4 天前的旧回复发进真实群）。`planned` 不受影响：它已有确认结果，可能正在合法等发送配额窗口 |
| `taskSweepIntervalMs` | `60000` | `taskScheduler.tick()` 里 `sweep()` 的节流间隔 |
| `taskReceiptsIntervalMs` | `15000` | `tick()` 里 `refreshReceipts()` 的节流间隔 |
| `routeSteerableWindowMs` | `600000` | 终态任务在多长时间内仍算"可被 steer"（保住"继续刚做完的那个"）。**它决定要不要为一条消息调路由模型**：实测 375 条非归档任务里只有 1 条可被 steer，所以绝大部分消息本来就不该付这 2.5 秒。设 `0` = 只有真有活干时才调 |
| `taskRouteTimeoutMs` | `4000` | 一次语义路由（分类 JSON）的超时。**只管分类，不再兼职回复生成** |
| `inTurnInjectionMode` | `amend` | 执行中收到的 QQ 新消息怎么处理：`amend` = 只有路由判成"原作者改需求"才注入正在跑的那一轮；`all` = **只要有在跑的回合就注入**，不调路由模型（省掉上面那 4 秒）、不新建任务。取消仍走原通路（进度问句现在也并进这一轮，见「强制注入」一节） |

### 上下文来源与条数

群友和自己的发言按真实时间交错排列，再分别裁剪到 10/15 条。QQ 历史时间优先，
同秒保持历史返回顺序，不按随机消息 ID（含 SnowLuma 的 message_seq）排序。
每个气泡/表情发送成功立即记录时间，重载用原发送时间或数据库事件时间恢复；
旧窗口中被重载时刻污染的时间自动修正，下一轮 QQ 回读继续校准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `contextFromQQHistory` | `true` | **用 QQ 历史直读刷新窗口**（见 §8）|
| `contextHistoryCount` | `25` | 回读多少条；desktop profile 当前为 40（要够填满 16+8 的窗口） |
| `contextHistoryCacheMs` | `20000` | 回读结果缓存多久（0 = 每轮都拉）|
| `contextHistoryTimeoutMs` | `3000` | 回读最多等多久；超时退回内存窗口，不把整轮拖死 |
| `contextOthersMessages` | `10` | 注入几条**别人的**消息；desktop profile 当前为 16（2026-10-21 由 10 提高） |
| `contextOwnMessages` | `15` | 注入几条**自己的**回复；desktop profile 当前为 8（保持别人:自己 = 2:1） |
| `contextImagesOnRequest` | `2` | 对方明确要求看图时首轮最多自动附几张旧图；其余可用 `qq_read_image` 补读 |
| `windowTurns` | `10` | 保留最近 Agent 回合对应的消息，同时受双方消息条数上限约束；desktop profile 当前为 12（2026-10-21 由 6 提高） |
| `rotateEveryTurns` | `30` | 每多少轮换一个新 Session；desktop profile 当前为 30（2026-10-24 由 45 降到 30，给图片/长文留窗口余量） |
| `injectStaticOnce` | `true` | 人设/规则只在本窗口第一轮注入 |
| `injectWindowOnce` | `true` | Session 首轮完整窗口，后续按消息增量；false = 每轮完整窗口 |
| `memoryInjectOnChange` | `true` | 当前 Session 按人物/约定/经历分别去重；首次或版本变化时注入相应块 |
| `rotateAfterImage` | `false` | 显式打开后，附图会导致下一轮提前创建 Session |
| `toneAnchor` | 空 | 每轮末尾补的一句短语气锚（默认空，语气只由 `persona.md` 决定）|

desktop profile 把 `stickerCatalogLimit` 设为 `12`（源码默认也是 12）：每轮动态注入时，
从真实目录无放回随机抽 12 条，放在当前消息前；目录不足 12 条时展示全部，每轮独立抽样允许跨轮重复，更大目录按工具查询。QQ 托管使用 `qq-hosted` 的
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

因此桥接的省 token 策略分两层：稳定块只在 Session 首轮注入，时间线后续逐条补增量；Session 按累计提交 prompt 字符预算轮换（默认普通会话 60000、任务 120000），`rotateEveryTurns > 0` 时普通会话另加轮数上限，`0` 表示仅使用字符预算。这个预算不等于完整模型上下文 token。随机 8 条表情目录每轮放在时间线之后、当前消息之前，延后前缀变化的位置。窗口指纹只在成功提交时保存，HMR 恢复；失败保留增量，轮换/模型变化/Session 丢失重置。若观察到 DSH `compaction/summary`，清除静态、记忆和窗口注入游标，下次重新补齐。

DSH base 已挂载自动 compaction，但默认按模型上下文窗口的压力阈值触发，不能替代短 Session；压缩还会额外消耗一次摘要请求，并且不会缩减工具 schema 或系统提示词。当前模型记录的窗口为 262144，在默认输出预留 32768、余量 65536 下触发阈值为 163840；30k 输入不会触发此默认策略。查证代码、日志样本及局限见 CACHE_PROMPT_AUDIT.md。

这个字符预算只量文本，**图片 token 一分都不算**，所以"还没到轮换点、上游已经拒收"会真实发生：2026-10-24 线上 a6api 预检报 `context ~411065 tokens exceeds the model window 262144`，其中图片独占约 37.2 万且不可压缩，于是 `retryable: false` 直接拒收，payload 根本没转发。桥接现在把这类失败当**确定性拒绝**处理：`lib/agent/context-overflow.mjs` 识别 `preflight_compress_failed` / `context_length_exceeded` / "exceeds the model window" 等形状，`rotateAfterContextOverflow` 丢掉该 Session，再把**同一条消息重投一次**（`recovered: true`，一条消息最多重建一次，不会自己打转）；已经调过工具的回合不重投，避免二次副作用。这条路径**不跑 memory flush** —— flush 回合仍要带整段历史，会被同一道预检一起拒掉。重建次数在 `#debug status` 的【模型回合】里显示为「超窗重建会话 N」。

> `contextOthersMessages` 和 `contextOwnMessages` **分开设限**是有意的：
> 合成一个总数时，她话一多就会用自己的回复把窗口挤满，别人的话一条都留不下 ——
> 那正是"看不见上下文"的另一半原因。

### 心跳

每个群独立累计背景未读消息，达到 `heartbeatUnreadThreshold`（默认 6）立即调用一次轻量判断；不足 6 条但有未读，`heartbeatCooldownMs` 等待周期到期也判断。两条件为 OR，数量触发能替换已有时间定时器。每批最多 6 条，判断拒绝也标为已读并重新计数，判断期间新增未读保留到下一批。判断失败保留本批并遵守独立重试间隔。`heartbeatIdleMs` 仅为旧配置兼容，数量触发不等待静默。

| 字段 | 默认 | 说明 |
|---|---|---|
| `heartbeatEnabled` | `false` | 总开关 |
| `heartbeatUnreadThreshold` | `6` | 各群未读达到此条数立即判断 |
| `heartbeatMs` | `300000` | **兜底恢复扫描**间隔；不再兼职失败退避（失败走 30s→5m 指数阶梯，见下文） |
| `heartbeatIdleMs` | `60000` | 旧配置兼容；数量触发不等待静默 |
| `heartbeatCooldownMs` | `180000` | 不足 6 条时的等待周期；0 关闭时间触发 |
| `heartbeatBufferSize` | `20` | 缓冲上限，超了挤掉最旧的并**记入缺口** |
| `heartbeatProvider` / `heartbeatModel` | 空 | 留空则用辅助模型（`auxProvider`/`auxModel`），再留空用主对话模型 |

### 辅助判断调用的模型

这五个调用都是"短分类"，不需要推理：**语义路由、心跳判断、记忆提炼、发言复核、记忆合并**。
它们以前一律沿用主对话模型，而主模型 `deepseek-v4.1-flash` **默认开启思考** —— 实测同一个短分类请求
首字节 5331ms、思考 1157 字、**正文 0 字**、`finish_reason: length`，于是既撞超时又产出截断 JSON。
换成本表中不思考的快模型后实测首字节 2125ms、2.5 秒返回合法 JSON。

| 键 | 默认值 | 说明 |
|---|---|---|
| `auxProvider` / `auxModel` | 空 | 辅助判断调用用的模型；留空 = 沿用 `llmProvider`/`llmModel`。desktop profile 为 `a6api` / `deepseek-v4.1-flash`（2026-10-19 用户要求从 `deepseek-v4-flash` 改回主模型，已知风险见 profile 注释） |
| `auxReasoningEffort` | `off` | 这类调用显式声明的思考档位；留空 = 不干预。与换模型是两道独立闸 |
| `heartbeatProvider` / `heartbeatModel` | 空 | 更具体的专用键，**优先于** `aux*` |
| `memoryProvider` / `memoryModel` | 空 | 同上，作用于记忆提炼 |

优先级：专用键（`heartbeat*` / `memory*`）> `auxProvider`/`auxModel` > `llmProvider`/`llmModel` > 全局默认。
实际解析结果可在 `status.models` 直接看到（`main` / `aux` / `heartbeatOverride` / `memoryOverride`）。

**七个调用点必须都展开 `...selection`**：少展开一次就丢掉 `reasoningEffort`，
这个调用点等于被留在模型的默认思考档位上。2026-10-19 发现 `heartbeat.mjs` 是唯一漏的那处
（其余 6 处都是 `{ ...selection, ... }`），已改成 `{ ...sel, ... }`。

### 辅助层健康度与空输出归因

`status.auxHealth` 与 `#debug status` 的【辅助判断层】段给出**内存环形缓冲**（最近 240 次 / 最近 15 分钟）
里的成功/失败/**空输出**计数与成功率，按调用点分组：

| 调用点 | label | 说明 |
|---|---|---|
| 心跳判断 | `heartbeat` | 主动插话 |
| 语义路由 | `routing` | 任务归属分类 |
| 记忆提炼 | `memory` | 后台记忆补充 |
| 参与决策 | `reply-decision` | 该不该回一句 |
| 楼层复核 | `floor` | 生成后的交付价值复核 |

它**不写库**：重载后从零累计，只为看清"现在到底还活着没有"。成功率低于 80%（且样本 ≥ 3）时
`#debug status` 顶部会有一行 `⚠️ 辅助判断层降级中：… —— …正在走 fallback`。

失败原因用共享归因（`lib/agent/aux-attribution.mjs`）统一分类，**"模型什么都没返回"不再被记成坏 JSON**：

| cause | 含义 | 该查什么 |
|---|---|---|
| `empty-output` | 正文 0 字（可能只收到结束帧） | 预算、思考档位、供应商是否接受该模型名/参数 |
| `timeout` | 撞 `taskRouteTimeoutMs` / 各自超时 | 首字节时间、中转 |
| `invalid-json` | 有正文但 JSON 坏了 | 提示词、校验 |
| `invalid-verdict` | JSON 合法但裁决不合法 | `validate()` 规则 |
| `stream-error` | 流本身抛错 | 网络/供应商 |
| `unavailable` | 没有 llm 服务或没选定 provider/model | 配置 |

`empty-output` 的 detail 固定写成
`收到 0 段正文 / reasoning N 段 / 用时 Xms（正文 …, 思考 …, 分片 …, finishReason=…, 末分片 …）`，
一眼能分开"思考吃光预算"（reasoning 段数/字数大、耗时数秒）和"请求在本地就被结束"
（零分片、耗时 0~1ms、只收到一个结束帧）。
逐条落库的版本在 `bridge_routes.data.fallbackCause` / `fallbackDetail`，
用 `node tools/probe-routes.mjs --hours 6` 看分布。

**宽容解析（2026-10-21）**：六个调用点统一走 `lib/agent/json-output.mjs` 的
`parseJsonLoose()` —— 先原文 parse，再去掉 json 代码围栏，最后按**括号配对**截出第一个
完整值。字符串里出现 `{` 时不会再被正则提前收尾。只有三条路都失败才记 `invalid-json`。
路由的 `maxTokens` 同时从 280 提到 800：思考分片也占预算，280 会在写 JSON 前被截断
（10-19 那批 170 次 `invalid-json` 的主因就是这个，参与决策早先从 60 提到 400 修的是同一个坑）。

**为什么没加 `response_format`**：DSH 的 `llm.stream` 支持 `responseFormat`（内部会转成
`response_format`，OpenAI 兼容路由可用），但官方 DeepSeek Messages 适配器**不读这个参数**
（2026-10-21 在 `app.asar` 里核过：它按字段白名单拼 payload，没有 responseFormat 分支）。
当前 aux 走 `deepseek-official`，加了也是空转，所以只做提示词 + 宽容解析两层；
若以后把 aux 换到 OpenAI 兼容路由，可以再加 schema 硬约束。

**证据过滤**：语义路由的 `evidenceIds` 现在分两类 —— **归属证据**（任务来源消息 ID，
只有它能建立归属）与**引用证据**（提示词时间线里出现过的 ID，只说明模型看着哪句话判断）。
引用证据不再让整条裁决作废；输入/任务/时间线都不认识的伪造 ID 仍被清掉，关联动作仍必须
由任务来源 ID + 置信度 ≥ 0.85 证明。线上 `invalid-verdict` 的主因就是把时间线 ID 也写进
`evidenceIds`，旧校验见一个不认识的就整条丢弃。

**思考读数**：`auxHealth` 新增 `thinkingCalls` / `reasoningChars`（按调用点也有
`thinkingCalls`/`avgReasoningChars`），`#debug status` 的【辅助判断层】会显示
`有思考 N 次（共 K 字，说明关思考没在服务端生效）`。请求层在 `auxReasoningEffort: 'off'`
时确实写成 `thinking: { type: 'disabled' }`；这里仍 > 0 就说明是服务端没执行，
该换模型/供应商，继续改提示词没有用。

### 失败退避：不再无限重试，也不再一失败锁十分钟

| 调用点 | 旧行为 | 现在 |
|---|---|---|
| 心跳判断 | 一次失败锁 `heartbeatMs`（10 分钟） | 按会话 30s → 1m → 2m → 5m（封顶）；未读一条不丢，只推迟；正常判定后清零 |
| 记忆提炼 | 失败只计数，30 秒后重试同一批，永不放弃（线上 406 次失败 / 0 次成功） | 按会话 30s → 1m → 2m → 5m；单批连续失败 5 次**丢弃该批**并记 `memoryBatchAbandoned`；成功清零 |

两者的失败次数与到期时间都写进 `store.setState` 的会话/批次状态，热重载后不会回到"立刻重试"。
`status.auxBackoff` 直接显示当前阶梯与丢弃上限。


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
3. **被点名 + 在提问直接回**（2026-10-21，方案 A）：明确 @ 她、带 ？/吗/什么/哪/谁/多少 的**短问句**不再交给决策模型。线上 7 天有 24 条 @ 她的消息被判沉默，其中 5 条明显是提问（「你们谁更厉害」「猜猜这个是什么」「9.11 和 9.9 哪个大」「9月11日忆什么」），都是因为太短、命中不了请求型正则。边界：纯打招呼（在/在吗/在不在）与纯标点（？）仍交给决策模型；没被点名的旁听消息不受影响。命中后仍是 `kind: 'consider'`，完整回合里的模型照样可以 `[SKIP]`。
4. **长问句直接回**（≥`replyDecisionLongAskChars` 且带 ？/吗/什么/哪/谁/多少），以及回复她自己的消息、开头叫她的名字 —— 都直接放行。

实测护栏分档（线上 306 条）：请求型 20%、长问句 5%、空/纯语气 8%，**剩下 67% 才真的去问决策模型**。

观察入口：`status.replyPolicy.participation = {enabled, checks, silent, requestShaped, longAsk, explicitAsk, failed, last}`，
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

### 强制注入（`inTurnInjectionMode: all`）

`amend` 那条路的前提是**路由把这条消息判成 amend**（原作者在执行中改需求）。线上这个裁决
极少（`bridge_routes` 里 amend 5 条 / new 756 条），于是"她在想的时候我又说了一句"绝大多数
按 `mode: 'queue'` 排在这一轮后面 —— 用户能看到它躺在 DSH 的 QueueDock 里。

`all` 把这件事改成确定的：`TaskScheduler.admit()` 在**调语义路由之前**先试强制注入，
只要同会话有一个真的还在跑的回合，就把这一批消息写进它的 next-step：

| 条件 | 为什么 |
|---|---|
| 执行 `state === 'following'` | 这一轮已经拿到 DSH turn 号，还没结束 |
| reply journal 仍在 `active` | 桥接仍拥有这一轮的投递权，草稿丢弃是安全的 |
| 宿主 agent `status === 'running'` 且有 `inject` | `inject` = `send(input,'next-step',false)`，**不唤醒**；空闲时调用只会让这条消息压到下一轮、甚至一直留在 inbox，比排队更糟 |
| 不接管 `isCancellation()` / `isProgressQuestion()` | 取消必须真的置 `cancelled`；进度问句要立刻回一句，不能被并进几分钟后的最终答复 |

顺序是先事务认领 `bridge_input_routes`、再改执行与窗口、最后 `agent.inject`；注入结果
不确定时任务转 `needs_attention`，**绝不自动重发**。注入后旧的未投递草稿由 runner 丢弃，
只交付修订后的收尾（`qq-interject:` 前缀的 user message）。

收益除了"她当场看见这句话"，还有一次路由模型调用的时间：线上 `latency.routing` p50 4.3s / p95 8.4s。
`status.tasks.interjection.inTurn` 里 `injected` 是注入条数，`skipped` 是被取消／进度问句
挡回原通路的条数，`routeCallsSaved` 与 `injected` 同源（每次注入省一次路由调用）。

> ⚠️ 代价：`all` 不再要求"同作者"，另一位群友的新问题也会被并进正在跑的那一轮，
> 作者归属与 fileAuthority 不再一一对应。这是明确的取舍，所以源码默认仍是 `amend`，
> desktop profile 显式写 `inTurnInjectionMode: all` 才打开。

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
| `pokeReplyMode` | `'wake'` | `wake` 回戳+开窗口（默认）/ `text` 回固定文案 / `agent` 唤醒完整回合 |
| `pokeReplyMinIntervalMs` | `10000` | wake / text 全局最小间隔 |
| `pokeReplyPerSenderPerHour` | `5` | wake / text 每人每小时上限（落盘）|
| `pokeReplyGroups` | `[]` | 额外收紧：只有这些群回戳 |
| `pokeReplyGroupText` | `true` | `text` 模式群里是否也发一句 |
| `pokeAgentMinIntervalMs` | `30000` | `agent` 模式全局最小间隔 |
| `pokeAgentPerSenderPerHour` | `6` | `agent` 模式每人每小时上限（落盘）|
| `pokeAgentSendPoke` | `true` | `agent` 模式先自动回戳 |
| `pokeAgentGroupText` | `true` | `agent` 模式群里是否也回话 |

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
| `memoryReflectEnabled` | `true` | L4 反思：从已有事实归纳可验证的规律，写进 `memory/<qq>.md` 的 `## 规律`（不新增注入）|
| `memoryReflectIntervalMs` | `86400000` | 同一个人两次反思的最小间隔；上次运行时间落库，重载不重置 |
| `memoryReflectMinFacts` | `8` | 少于这么多条 active facts 不反思 |
| `memoryReflectTopFacts` | `30` | 一次最多喂多少条事实（按 置信度×衰减×log(印证) 取前 N）|
| `memoryReflectTickMs` | `600000` | 扫描"谁该反思了"的周期 |
| `memoryReflectMaxPerRun` | `1` | 每次扫描最多反思几个人 |
| `memoryReflectTimeoutMs` | `30000` | 单次反思超时；失败不影响聊天，24 小时内不重试 |
| `memoryReflectProvider` / `memoryReflectModel` | 空 | 反思模型覆盖；都填写才生效 |
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
| `contextImagesOnRequest` | `2` | 无当前/引用图片的读图请求首轮最多自动补几张历史图；desktop 为 1，0 只关闭自动补图，仍可用 `qq_read_image` |
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
| `urls.json` | 上次拉到的收藏地址快照（顺序 **不代表** 编号） |
| `catalog.json` | **94 条**编号 → 画面描述 + **身份键**（`key`） |
| `sheet-1~3.png` | 拼好的总览图（分页缓存） |

**编号是目录里的名字，不是列表位置。** 2026-10-19 出现过一次事故：`#73 得意指着人`
实际发出去的是 `#22 我死，我死，我死…`。目录没有标错 —— 是 QQ 的 `fetch_custom_face`
当时把 94 张**整份倒序**返回（同一批 URL、逐字节相同，只是顺序反了），
而 22 与 73 正是彼此的镜像位置，"按编号取第 N 个"这件事本身失效了。

现在每一行都带 `key`（qpic URL 里那串 32 位十六进制就是表情哈希），桥接和 qq-mcp 都按
**key → 当前列表里的 URL** 解析（算法只有一份：`lib/domain/stickers.mjs`）。
顺序以后再翻多少次都不会发错图；目录里有、收藏里已经没有的那张会明确报错，
而不是退回按位置猜一张。重新标注目录后跑一次 `node qq-mcp/tools/sync-catalog.mjs`
把 key 补回去（前提是刚跑过 `make-sheets.mjs`，编号与那张总览图一致）。
目录路径默认 `qq-mcp/cache/catalog.json`，可用 `QQ_STICKER_CATALOG` 覆盖
（测试因此不会读到真实账号的目录）。

**为什么要有文字目录**：不给目录的话，模型根本不知道每个编号画的是什么，
实测 11 次里 7 次挑了 `#1`。有了目录它才能按情绪挑。每轮注入 12 条随机候选，
逐行给出真实编号与描述，模型按当前语境决定是否使用。候选列表里**不再给"示例编号"**——
以前那句 `[表情:73]` 示范会让模型照抄（11 次里 2 次），等于替它挑了一张它没选过的图。

**使用率怎么量**：`node tools/sticker-rate.mjs 14` 直接统计 outbox 里收藏表情所占比例（按天）。
2026-10-19 排查时它从 `20.7%`（10-11）掉到 `1.6%`，原因是提示词里加了一句"仅供选择…
不需要时只发文字"：决定权全推给模型之后，模型几乎总选文字。现在的写法是给出**默认一票**
（带情绪的闲聊默认配一张）并明确列出不配的情形，同时把候选数提到 12。调完提示词别看感觉，看这个读数。

**注意**：收藏表情只能取到**静态首帧**。要发会动的原生表情得用 `qq_send_mface`，
参数从收到的动画表情消息里抄。

### ② 本机表情包仓库（`QQ_STICKER_DIR`）

就是一个目录，把图片原图丢进去，Agent 用 `qq_list_stickers` 查、`qq_send_sticker` 发。

当前配成 `D:\Code\dsh-qq-bridge\stickers`，**但该目录目前是空的**，
所以这两个工具现在列不出东西、也发不出图。想用就往里丢图。

QQ 内置表情不需要图片文件，直接用 `face` 段按 ID 发即可：
`[{"type":"face","data":{"id":"181"}}]`。

### ③ QQ 内置 AI 语音（`qq_send_ai_voice`）

2026-10-19 接入，用于先验证"语音这条路到底通不通、有没有人想听"。
这是**腾讯自己的语音**：把文本交给 SnowLuma 的 `send_group_ai_record`，QQ 服务端合成并以语音气泡发出。
不跑本地 TTS、不占显存、不花钱，且**只能在群聊里用**。

**音色固定为「傲娇少女」（`lucy-voice-f38`）**，2026-10-21 定：
人设一致性优先于选择自由 —— 模型拿不到音色列表，工具也没有 `character` 参数，
群里一句"换个御姐音"不会改掉它自己的声音。要换音色只能由部署方改默认值或环境变量
（`QQ_AI_VOICE_CHARACTER` / `QQ_AI_VOICE_NAME`），属于人决定的事。

- 流程：`qq_send_ai_voice` 传 `group_id` 和 `text`，没有别的选择项。
- 长度：`QQ_MAX_AI_VOICE_CHARS`（默认 200 字符）。超了直接拒绝并建议改发文字 —— 不赌 QQ 能把长文念完。
- 配额：除发送的分钟/小时闸外，另有 `QQ_QUOTA_VOICE_PER_HOUR`（默认 10）。
  语音不能扫读、必须外放，本来就该是低频动作。
- 记账：接入端必须回 `message_id` 才算成功；缺了记 UNKNOWN 并禁止自动重发。
  成功后往桥接窗口记一条 `[语音：…]` 并刷新 60 秒唤醒窗口，下一轮它知道自己用语音说过什么。
- 形态：不走 `send_group_msg`，所以不能和文字/图片拼成一条消息；一次一个语音气泡。

### ④ 语音库（`qq_send_voice` / `qq_voice_library`）

上面 ③ 是"把文字念出来"，这一条是"把一段现成的音频放出来"：点歌、让你哼一段、想听你唱，
模型从部署方的语音库里挑一条发出去，QQ 里就是**语音气泡**，不是文件卡片。

- 库在哪：`~/.dsh/qq-voices`，部署方可用配置 `voiceLibraryRoot` 或环境变量 `QQ_VOICE_LIBRARY` 覆盖。
  **不放会话工作区**：工作区按会话隔离、还压着 200 文件 / 50 MiB 配额，
  且 `.outgoing` 快照只增不减，把歌曲塞进去早晚把某个群的文件槽占满。
  库文件由 SnowLuma 直接按本机路径读取（`loadPtt` → `encodeSilk`，非 SILK 自动转 NT SILK），
  所以不进工作区、也不占发送快照的配额。
- 库长什么样：`<root>/index.json` + `clips/`。
  ```json
  { "clips": [
    { "id": "yuai-sifeng", "label": "雨爱(司凤版)", "file": "clips/yuai-sifeng.mp3",
      "spoken": "唱了一段《雨爱》（司凤版）", "description": "整首 2 分 20 秒，点歌时用",
      "tags": ["唱歌", "雨爱"], "durationMs": 140147 }
  ] }
  ```
  `spoken` 是发给模型自己看的"我刚才唱了什么"：语音不入库转写（入站转写只处理别人发的），
  没有它，下一轮它就不知道上一轮放了哪首。
- 怎么入库：`node tools/seed-voice-library.mjs add public\雨爱(司凤版).mp3 --label 雨爱(司凤版) --spoken …`。
  脚本自带 mp3 时长解析（不依赖 ffmpeg），会算 sha256、复制进 `clips/`；`list` / `remove` 同一套。
  `--split 3` 需要本机有 `ffmpeg`，按 `-c copy` 切成若干段。
- 边界（都在 `lib/agent/voice-library.mjs`，发送前拦）：路径不得越出库根（含符号链接逃逸）、
  单文件 ≤ 20 MiB、已知时长 ≤ 300 秒、清单写了 `sha256` 就必须一模一样、
  名字有歧义直接报候选而不是猜。全是拒绝语义 —— 它挡在 SnowLuma 直接读本机路径之前。
- 配额：**语音不限流**。不走小时闸、也没有单曲冷却：`QQ_QUOTA_VOICE_PER_HOUR` 默认 `0`（=不限），
  显式设成正数才会收；清单里写 `cooldownSeconds` 也早已不生效（读的时候直接忽略）。
  仍保留的是安全边界（路径/大小/时长/sha256/能力位）和全体发送的分钟间隔。
- 记账：成功往窗口记 `[语音：<label>] <spoken>` 并刷新 60 秒唤醒窗口。
- 她怎么知道自己能唱：`lib/prompt/render.mjs` 每轮把库清单（名字 / 时长 / 用途，**不带路径**）
  作为【你能直接放语音】注入。不能靠 `detectVoiceIntent` —— 它只认"发语音 / 念给我听"，
  "唱一下雨爱"不命中；也不能靠静态卡，静态卡每窗口只注入一次而点歌随时发生。
- 旁路已封：`qq_send_group_msg` / `qq_send_private_msg` 现在和 `file` 段一样拦 `record` 段，
  否则能力位、小时闸、冷却和记账全都能被一句 CQ 码绕过去。
  要发语音只有两条正路：`qq_send_ai_voice`（念文字）或 `qq_send_voice`（库里的一段）。

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

### 正文去重：一条话只发一遍（2026-10-24）

幂等键管的是"同一条消息别发两次"，管不了**一段正文在源头就是两份**。

上游（a6api 的 responses 流）偶尔把同一个 text block 开两次：`block-start(1,text)`
从不收尾，`block-start(2,text)` 又带着同一份完整正文收尾，于是**一条 assistant 消息
里出现两个内容相同的 text part**（当天 292 条消息里 2 条，且都满足"开块数 > 闭块数"）。
旧代码用空串把它们拼起来，群里就变成"前两条气泡 + 第三条把前两条重发一遍"，
第三次还带着漏出来的 `[表情:38]` 字面量。

三道闸现在各自独立生效：

| 位置 | 做的事 |
|---|---|
| `runner.mjs` `mergeTextParts` | 拼多个 text part 时丢弃**完全相同/是尾巴/是前缀**的那一份，其余照原样拼接；丢弃数记进 `stats.dupTextParts` 与 `lastTurn.dupTextParts` |
| `reply-policy.mjs` `extractStickerMarker` | 标记**全摘**（不只是第一个），`[表情:…]` 残骸也摘；`[表情包]` 这种正文不动 |
| `reply-policy.mjs` `collapseRepeatedReply` | 拆气泡前把"整段重复两遍"的正文折回一份（段数需 ≥4 且前后两半完全相等），`stats.repeatedReplyCollapsed` 计数 |

克制的地方：只有**一模一样**才算重复，不做相似度猜测；单段重复两遍（"哈？\n\n哈？"）
不动 —— 那可能是她在重复，是人味，不是故障。

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
| `send_voice` | `qq_send_ai_voice`（QQ 内置 AI 语音）与 `qq_send_voice`（语音库里的一段音频）。**只授了 `send_sticker` 的旧配置也认**，想单独收回语音就把两个都去掉 |
| `read_favorites` | `qq_list_custom_faces` / `qq_custom_face_sheet` / `qq_view_custom_face` / `qq_send_custom_face` |
| `read_image` | `qq_read_image` / `qq_collect_sticker` / `qq_view_library_sticker`；配合 `read_forward` 读取转发图片 |
| `manage_group` | `qq_delete_msg`、`qq_manage_group`（禁言/踢人/改名/改名片/发·删公告） |
| `set_profile` | `qq_set_profile`（改自己的昵称/个性签名；老配置里的 `manage_group` 也认）|

**留空 = 全部允许**（兼容旧配置，行为不变）。一旦列出，就只有列出的能用，
且拒绝信息会说清是**哪一层**拦下来的。

配额（同样持久）：`QQ_QUOTA_SEND_PER_MINUTE`(20)、`QQ_QUOTA_SEND_PER_HOUR`(600)、
`QQ_QUOTA_IMAGE_PER_HOUR`(60)、`QQ_QUOTA_FAVORITE_READ_PER_HOUR`(12)、
`QQ_QUOTA_VOICE_PER_HOUR`(10，AI 语音另收一道小时闸)。

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
- **思考参数兼容**（2026-10-29 改语义）：`llmReasoningEffort` **填了就发**，`off` 也发。旧实现把 `off` 当成"省略该字段"，可省略不等于关闭思考 —— 对 pi-ai 路由两者确实等价（`profileOptions` 把 `off` 翻译成不发送），但对 DeepSeek 官方适配器 `off` 是 `thinking: { type: 'disabled' }`，省略就落回默认档继续想。现在先问适配器这个模型认哪些档位（`llm.resolveModelInfo` 的 `reasoning.efforts`，与 DSH 自己的校验同一份元数据）：认就原样发；不认才不发，理由写进 `models.main.reasoningNote` 与面板判定条。真发出去被拒（`UNSUPPORTED_REASONING_EFFORT`）时记 `stats.effortRejected`，同一进程不再发这个档位，并把当前 Session **原地**重选成不带档位（不换会话、不丢上下文）。改模型/改档位也不再用提示词签名触发轮换，而是比对 `entry.modelSignature` 后原地 `selectModel`。实现：`lib/agent/reasoning-effort.mjs`、`lib/conversation/sessions.mjs`。
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
