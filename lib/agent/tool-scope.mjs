import { QQ_SESSION_TOOLS, DOCUMENT_TOOLS } from './tool-sets.mjs';

/** QQ 预设继承全局工具，需要显式过滤模型可见目录。 */
export const inject = ['tools'];

/**
 * 这个作用域允许模型看到的全局工具名。
 *
 * 导出是为了让 `tools/audit-prompt-cost.mjs` 核对真实 request/header 时用同一份
 * 名单 —— 以前那边抄了一份，加工具时很容易只改一处、审计和线上对不上。
 */
export const allowedToolNames = () => [
  ...QQ_SESSION_TOOLS.map((name) => 'mcp__qq__' + name),
  ...DOCUMENT_TOOLS.map((name) => 'mcp__document-editor__' + name),
  'ask_user_question',
  'qq_memory',
  /**
   * 委派走 DSH 原生子代理（2026-10-23 起）。`qq_delegate` 那一套是桥接自己实现的
   * 后台工作子代理，DSH 0.2.1 起 `subagents.start()` 已经不存在，它每次调用都在
   * launch 阶段抛 `service.start is not a function`，所以整组下线，改放行原生工具。
   */
  'subagent', 'subagent_fork', 'list_agents', 'send_message', 'interrupt_agent',
  'web_fetch', 'web_search',
];

const allowed = new Set(allowedToolNames());

export function apply(ctx) {
  let signature = '', dispose = null;
  const sync = () => {
    // preset 是 Agent 的祖先作用域；allow: [] 也会屏蔽 Agent 继承的 preset
    // 工具。只 deny 不需要的全局名字，允许的名字无论从哪里继承都保留。
    const deny = ctx.root.tools.schemas().map((tool) => tool.name)
      .filter((name) => !allowed.has(name)).sort();
    const next = JSON.stringify(deny);
    if (signature === next) return;
    signature = next;
    dispose?.();
    dispose = deny.length ? ctx.tools.restrict({ deny }) : null;
  };
  ctx.on('tools/change', sync, { global: true });
  sync();
}
