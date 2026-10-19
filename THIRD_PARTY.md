# 第三方来源声明

本项目部分提示词设计借鉴下列项目。Tulpa / qq-bridge 使用 MIT；CPED 使用 Apache-2.0。来源、使用范围及修改说明分别列出。

---

## Tulpa

- 仓库：https://github.com/fumingyang2004/Tulpa
- 许可：MIT，原文保留在 [LICENSE.Tulpa.txt](LICENSE.Tulpa.txt)
- 借用内容：
  - **分层提示词架构** —— 行为规则（`behavior.md`）、角色卡（`persona.md`）、
    表达参考（`examples.md`）拆成独立文件，各自可替换
  - 先听再接、像在打字、留出空隙和群文化适应等设计思路
  - 早期版本使用过其正反例；v75 已替换为人类对话参考与正向原则，保留历史来源声明
  - **角色卡结构** —— 见下；v80 在 v79 基础上增加轻量情感状态、转场、自然缺口和可选 Emoji 语境参考。v79 在 v78 原文基础上将负向指令和反例改为正向行为，复用身份、短句/碎句、语气句、节奏、梗和群文化适应的设计，性格收敛为傲娇、屑系、小猫哈气和可爱。宿主工具、来源字段和投递规则按当前桥接实际能力替换，表达示范继续注明来源。

Tulpa 在文档中指出，其群聊行为与提示词设计参考了 `qq-bridge`（见下），
小鲸鱼角色卡亦改编自该项目。

## qq-bridge（Derpyu520）

- 仓库：https://github.com/Derpyu520/qq-bridge
- 许可：MIT
- 借用内容（经由 Tulpa 转手，本项目未直接使用其代码）：
  - **小鲸鱼（DeepSeek 娘）角色卡** —— Tulpa 的 `little_whale.md` 即改编自此项目
    的 `roles/小鲸鱼.md`；本项目的 `persona.md` 又改编自 Tulpa 那一版
  - 群聊行为设计参考其 `qq-chat-v2`

---

## CPED

- 仓库：https://github.com/scutcyr/CPED
- 许可：Apache-2.0，原文保留在 [LICENSE.CPED.txt](LICENSE.CPED.txt)
- 使用内容：测试集中的少量人工编剧影视对白，补充得意、反弹、认栽、装无辜和关心的表达。它是人类创作的剧本语料，区别于自然群聊。
- 修改：去人物标识、添加标点、选取短片段并附学法；线下陪伴在 QQ 中按实际能力理解。来源 utterance ID 见 PROMPT_PLAN.md。
- 本项目未引入其数据全量、代码、模型或训练流程。

## 本项目与上述项目的关系

**仅借鉴提示词的设计与文本，没有使用它们的任何代码。**

本项目的实现（Cordis 插件 + OneBot 桥接 + MCP 工具服务器）是独立编写的，
架构与 Tulpa 差异很大：

| | Tulpa | 本项目 |
|---|---|---|
| 形态 | Python 桌面程序 + MCP 服务器 | DSH Cordis 插件 + MCP 工具服务器 |
| 驱动方式 | Agent 主动轮询（`wait_chat_messages`）| 桥接推送事件 + 唤醒 Agent 会话 |
| 发言决策 | Planner / Replyer 两段式 | agent判断 + 会话唤醒 + 心跳机会；desktop关闭形态抽签 |
| 表情 | 工具调用（`read_chat_sticker` 等）| 文本标记（`[表情:N]`）|
| 静默 | 不调用发送工具 | 输出 `[SKIP]` 暗号 |

所以**没有引入其 Planner/Replyer、工具协议、授权模型或 Python 依赖**。

---

## 如果你要二次分发本项目

按对应许可保留版权、许可及修改说明。请确保：

1. 保留 `persona.md` / `behavior.md` / `examples.md` 三个文件头部的来源注释
2. 保留本文件
3. 如果修改了上述提示词文本，注明"已修改"
4. 保留 CPED 的来源说明和 LICENSE.CPED.txt；其他要求以 Apache-2.0 原文为准

具体条款以各项目仓库中的 `LICENSE` 原文为准。
