import { contextMessage } from './context.mjs';

export const busyExecutionStates = ['queued', 'starting', 'following', 'recovering', 'needs_attention'];
export function requestText(events, owner) {
  return events.filter((e) => !e.__inputPassive && String(e.user_id) === String(owner)).map((e) =>
    Array.isArray(e.message) ? e.message.filter((p) => p.type === 'text').map((p) => p.data?.text ?? '').join('').trim()
      : contextMessage(e).text).join('\n');
}
export function requestKey(text) {
  return String(text).normalize('NFKC').toLowerCase().replace(/[\s，。！？、,.!?]+/gu, '');
}
// File authority comes from owned inputs, never from the shared QQ history.
export function fileAuthority(events, owner, task, action) {
  const text = requestText(events, owner);
  const output = /(?:文档|文件|程序|代码|源码|小游戏|游戏|网页|网站|脚本|压缩包|报告|论文|简历|表格|word|docs?|pdf|html|zip|docx|ppt|excel)/iu;
  const intent = /(?:写|做|制作|生成|创建|开发|编写|整理|导出|保存|打包|发|发送|交付|给|来|要)/u;
  const explicit = output.test(text) && intent.test(text);
  const inherited = ['amend', 'continue'].includes(action) && task?.data?.fileAuthorized === true &&
    /(?:改|补|继续|接着|重做|重新|导出|发|发送|打包)/u.test(text);
  return { files: explicit || inherited, basis: explicit ? 'owned-file-request' : inherited ? 'owned-task-followup' : 'no-owned-file-request' };
}
