import { boundSource } from './execution-scope.mjs';

/**
 * 派发前把本轮来源注入 QQ MCP 工具参数。
 *
 * 为什么不交给模型填：
 *   以前 `source_ref` 是提示词里的一行、也是工具 schema 里的一个必填参数。
 *   模型只要漏抄、抄错或在并发回合里抄到别人的值，调用就会被宿主判"来源不算
 *   当前 Session"，而纠正它需要的只是把同一串字符再抄一遍 —— 这既不构成安全
 *   边界，又让正确场景频繁失败。归属权应该在宿主：它知道当前 DSH Session 正在
 *   跑哪个 QQ 回合。
 *
 * 为什么换引用而不是原地改：
 *   DSH 在创建执行对象时就把 `arguments` 深冻结了（见 dsh-tools 的
 *   `createExecution`），原地赋值不会生效；`exec.arguments` 属性本身可写，
 *   替换成新对象后 guard 与工具体读到的都是注入后的版本。
 */
export function bindToolSource(store, exec) {
  const name = String(exec?.name ?? '');
  // 原生 qq_delegate / qq_memory 由工具体按 Session 解析来源，不读参数。
  if (!name.startsWith('mcp__qq__')) return;
  const bound = boundSource(store, exec?.agent?.session?.id);
  if (!bound?.sourceRef) return;
  const args = exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
    ? exec.arguments
    : {};
  exec.arguments = { ...args, source_ref: bound.sourceRef };
}
