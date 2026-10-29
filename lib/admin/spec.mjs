/**
 * 面板能改的配置项清单 —— 只有这一份。
 *
 * 为什么把清单从路由里拆出来：
 * ① 白名单必须显式。面板能改什么要一眼看全，而不是"读代码找分支"；
 * ② 校验规则跟键绑在一起，前端只负责渲染，不会出现"UI 改了、校验没改"；
 * ③ 测试可以直接照这份清单跑（每种 kind 的边界、每个 enum 的合法值）。
 *
 * 刻意不覆盖 config.mjs 里的全部键：面板只放"日常会调的那十几个"，
 * 投递节奏、配额、图片策略这些仍然回 DSH 设置页改 —— 两边各改一半最难查。
 */

/** 分组只影响渲染顺序与标题，不参与校验。 */
export const GROUPS = [
  {
    id: 'layers',
    label: '注入层级',
    note: '静态层（人设/规矩/示例）与窗口层（历史消息）每会话只注入一次，轮内层每轮都带。',
  },
  {
    id: 'context',
    label: '上下文与轮数',
    note: '决定每次请求带多少历史。改大更记得住，但首字更慢、更贵。',
  },
  {
    id: 'models',
    label: '模型',
    note: '主对话与辅助判断分开配。改完从下一轮开始生效，不动其它 DSH 会话。',
  },
  {
    id: 'heartbeat',
    label: '心跳',
    note: '未读攒够门槛立即判断，否则等冷却；插话前还要求群里安静一会儿。',
  },
];

/**
 * kind 语义：
 * - `bool` 开关；`int` 整数（min/max/unit）；`ms` 整数毫秒（UI 按秒输入）；
 * - `enum` 枚举（options 里有 value/label）；`text` 单行/多行短文本。
 */
export const ENTRIES = [
  // ---- 注入层级 ----------------------------------------------------------
  {
    key: 'injectStaticOnce',
    group: 'layers',
    label: '静态层只注入一次',
    help: '人设、规矩、示例这些固定内容，一个会话只在第一轮带一次；关掉则每轮都重发（更稳但贵）。',
    kind: 'bool',
  },
  {
    key: 'injectWindowOnce',
    group: 'layers',
    label: '窗口层只注入增量',
    help: '历史消息只发新出现的那些；关掉则每轮重发整个窗口。',
    kind: 'bool',
  },
  {
    key: 'inTurnInjectionMode',
    group: 'layers',
    label: '轮内注入方式',
    help: '回合还在跑的时候又来了新消息：amend = 追加到当前回合，all = 直接开新回合。',
    kind: 'enum',
    options: [
      { value: 'amend', label: 'amend（追加）' },
      { value: 'all', label: 'all（强制开新回合）' },
    ],
  },
  {
    key: 'memoryEnabled',
    group: 'layers',
    label: '记忆（人物卡）',
    help: '每轮把相关记忆注入上下文。关掉后模型看不到记忆文件，仍会照常写入。',
    kind: 'bool',
  },
  {
    key: 'memoryInjectOnChange',
    group: 'layers',
    label: '记忆内容变了才重注',
    help: '记忆没变就不重复发送，省 token；关掉则每轮都带。',
    kind: 'bool',
  },
  {
    key: 'memoryInjectRecent',
    group: 'layers',
    label: '注入最近几条记忆',
    help: '每轮带多少条最近的记忆条目。',
    kind: 'int',
    min: 0,
    max: 10,
    unit: '条',
  },
  {
    key: 'memoryInjectMaxChars',
    group: 'layers',
    label: '记忆注入上限',
    help: '记忆块最多占多少字，超了按优先级截。',
    kind: 'int',
    min: 0,
    max: 8000,
    unit: '字',
  },
  {
    key: 'episodeInjectLimit',
    group: 'layers',
    label: '注入情节条数',
    help: '每轮召回多少条"发生过的事"（情节记忆）。0 = 不注。',
    kind: 'int',
    min: 0,
    max: 10,
    unit: '条',
  },
  {
    key: 'toneAnchor',
    group: 'layers',
    label: '语气锚点',
    help: '一句压住语气的定调，跟着静态层走。留空 = 不额外定调。',
    kind: 'text',
    max: 400,
  },

  // ---- 上下文与轮数 ------------------------------------------------------
  {
    key: 'windowTurns',
    group: 'context',
    label: '每轮带多少轮对话',
    help: '窗口层的主体：每次请求带上最近多少轮。',
    kind: 'int',
    min: 1,
    max: 60,
    unit: '轮',
  },
  {
    key: 'rotateEveryTurns',
    group: 'context',
    label: '多少轮后重放静态层',
    help: '到了这个轮数就把静态层再注入一遍，防止长会话里设定被冲淡。',
    kind: 'int',
    min: 5,
    max: 200,
    unit: '轮',
  },
  {
    key: 'contextHistoryCount',
    group: 'context',
    label: '取多少条历史消息',
    help: '从会话里取最近多少条原始消息参与拼装（比"轮"更细）。',
    kind: 'int',
    min: 5,
    max: 200,
    unit: '条',
  },
  {
    key: 'contextOthersMessages',
    group: 'context',
    label: '群友消息条数',
    help: '拼装上下文时保留多少条别人的消息。',
    kind: 'int',
    min: 0,
    max: 50,
    unit: '条',
  },
  {
    key: 'contextOwnMessages',
    group: 'context',
    label: '自己消息条数',
    help: '拼装上下文时保留多少条自己说过的话（防止前后矛盾）。',
    kind: 'int',
    min: 0,
    max: 50,
    unit: '条',
  },
  {
    key: 'conversationContextMaxChars',
    group: 'context',
    label: '上下文总字数上限',
    help: '整段历史的安全阀，超了从最旧的开始丢。',
    kind: 'int',
    min: 1000,
    max: 200000,
    unit: '字',
  },

  // ---- 模型 --------------------------------------------------------------
  {
    key: 'llmProvider',
    group: 'models',
    label: '主对话 provider',
    help: '留空 = 沿用 DSH 全局默认。填错的话这一轮会直接失败，面板会报错。',
    kind: 'text',
    max: 80,
    placeholder: 'a6api',
  },
  {
    key: 'llmModel',
    group: 'models',
    label: '主对话模型',
    help: 'QQ 会话里真正说话的那个模型。',
    kind: 'text',
    max: 120,
    placeholder: 'deepseek-v4.1-flash-1017',
  },
  {
    key: 'llmReasoningEffort',
    group: 'models',
    label: '主对话思考档',
    help: '留空或 off = 不发送该字段（供应商可能默认开思考）。',
    kind: 'enum',
    options: [
      { value: '', label: '未指定' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
      { value: 'off', label: 'off（等同未指定）' },
    ],
  },
  {
    key: 'auxProvider',
    group: 'models',
    label: '辅助 provider',
    help: '语义路由、心跳判断、记忆提炼、发言复核都用它。留空 = 跟主模型同款。',
    kind: 'text',
    max: 80,
    placeholder: 'deepseek-official',
  },
  {
    key: 'auxModel',
    group: 'models',
    label: '辅助模型',
    help: '短分类任务，建议用不思考的小模型，否则 maxTokens 会被思考吃光。',
    kind: 'text',
    max: 120,
    placeholder: 'deepseek-flash',
  },
  {
    key: 'auxReasoningEffort',
    group: 'models',
    label: '辅助思考档',
    help: '默认 off = 显式声明不要思考。留空 = 不干预。',
    kind: 'enum',
    options: [
      { value: 'off', label: 'off（不要思考）' },
      { value: '', label: '未指定' },
      { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
  },

  // ---- 心跳 --------------------------------------------------------------
  {
    key: 'heartbeatEnabled',
    group: 'heartbeat',
    label: '心跳总开关',
    help: '关掉后群里没被 @ 的消息直接丢弃，不会攒着等插话。',
    kind: 'bool',
  },
  {
    key: 'heartbeatUnreadThreshold',
    group: 'heartbeat',
    label: '未读门槛',
    help: '攒够这么多条未读就立刻判断一次要不要插话。',
    kind: 'int',
    min: 1,
    max: 100,
    unit: '条',
  },
  {
    key: 'heartbeatCooldownMs',
    group: 'heartbeat',
    label: '判断冷却',
    help: '未读不够门槛时的等待时间，也是插话后的最少安静时长。0 = 只靠未读门槛。',
    kind: 'ms',
    min: 0,
    max: 3600000,
  },
  {
    key: 'heartbeatIdleMs',
    group: 'heartbeat',
    label: '群里安静多久才插话',
    help: '消息还在刷屏时不插嘴。',
    kind: 'ms',
    min: 0,
    max: 600000,
  },
  {
    key: 'heartbeatMs',
    group: 'heartbeat',
    label: '兜底扫描周期',
    help: '只决定多久扫一遍会话把定时器重新挂上，不是判断节奏。',
    kind: 'ms',
    min: 30000,
    max: 3600000,
  },
];

/** 一份 key → entry 的索引，校验时按 key 查。 */
export const BY_KEY = new Map(ENTRIES.map((entry) => [entry.key, entry]));

export const EDITABLE_KEYS = ENTRIES.map((entry) => entry.key);

/**
 * 校验并归一化一个值。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, error }`，不抛异常 ——
 * 路由层要能把"哪几项被拒"原样回给面板，而不是整批 500。
 */
export function coerce(entry, raw) {
  if (!entry) return { ok: false, error: '未知配置项' };
  switch (entry.kind) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
      return { ok: false, error: '需要 true / false' };
    }
    case 'int':
    case 'ms': {
      const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
      if (!Number.isFinite(value)) return { ok: false, error: '需要数字' };
      if (!Number.isInteger(value)) return { ok: false, error: '需要整数' };
      if (entry.min != null && value < entry.min) {
        return { ok: false, error: `不能小于 ${entry.min}${entry.unit ?? ''}` };
      }
      if (entry.max != null && value > entry.max) {
        return { ok: false, error: `不能大于 ${entry.max}${entry.unit ?? ''}` };
      }
      return { ok: true, value };
    }
    case 'enum': {
      const value = String(raw ?? '');
      if (!entry.options.some((option) => option.value === value)) {
        return { ok: false, error: '不在可选值里' };
      }
      return { ok: true, value };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, error: '需要字符串' };
      const value = raw.trim();
      if (entry.max != null && value.length > entry.max) {
        return { ok: false, error: `不能超过 ${entry.max} 字` };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, error: '未知类型' };
  }
}
