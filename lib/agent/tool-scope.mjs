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
  'qq_delegate', 'qq_delegate_status', 'qq_delegate_control', 'qq_job_progress',
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
