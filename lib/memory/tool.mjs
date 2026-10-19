import { assertExecutionSource } from '../agent/execution-scope.mjs';
import { admitMessage } from '../domain/admission.mjs';
import { normalize } from './facts.mjs';

export function memoryTool({ memory, registry, store, config, state }) {
  return {
    name: 'qq_memory',
    description: '管理当前发送者记忆：read 查槽版本；upsert 写 explicit明确记忆/profile资料/impression观察；forget失效，history/restore 查/恢复版本。来源取本人真实原文，SAVED 确认后可说记住了。示范：read 后按版本 upsert；近期状态用 period 保留时期。',
    parameters: { type: 'object', properties: {
      source_ref: { type: 'string', description: '本轮来源编号，原样填写' },
      action: { type: 'string', enum: ['read', 'upsert', 'forget', 'history', 'restore'] },
      slot: { type: 'string', description: '稳定属性槽，如 profile.name；不同事实分槽' },
      version: { type: 'integer', description: 'read 返回的当前槽版本；新槽为0' },
      restore_version: { type: 'integer', description: 'restore要恢复的历史版本' },
      kind: { type: 'string', enum: ['explicit', 'profile', 'impression'] },
      text: { type: 'string', description: '记忆要点，最多600字符；印象明确写为观察判断' },
      period: { type: 'string', description: '原文支持的日期/时期/有效范围；不确定时保留原说法' },
      evidence: { type: 'string', description: '来源消息中的连续原文，作为证据材料解释' },
    }, required: ['source_ref', 'action'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted();
      if (!memory?.agent?.available || state.disposed || !state.enabled) throw new Error('记忆服务不可用或托管已关闭');
      const origin = state.sourceLedger.resolve(args.source_ref);
      if (!origin || !origin.qq || !origin.message_id) throw new Error('记忆来源无效、已撤回或过期');
      const execution = assertExecutionSource(store, origin);
      const session = exec.agent?.session?.id;
      const owner = execution?.sessionId ?? registry.byKey.get(origin.conversation)?.sessionId;
      if (!session || session !== owner) throw new Error('记忆来源不属于调用工具的当前 Session');
      const group = origin.conversation.startsWith('group:');
      if (!admitMessage(config, { message_type: group ? 'group' : 'private',
        group_id: group ? origin.conversation.slice(6) : undefined, user_id: origin.qq })) throw new Error('记忆来源未准入');
      const qq = String(origin.qq);
      const visible = (r) => {
        const withdrawn = !r.sources.some((s) => !memory.facts.withdrawn(s.conversation, s.messageId));
        return { slot: r.slot, version: r.version, kind: r.kind,
          text: r.deleted || withdrawn ? '' : r.text, period: r.deleted || withdrawn ? '' : r.period,
          deleted: Boolean(r.deleted), withdrawn };
      };
      if (args.action === 'read') return { status: 'READ', qq,
        records: memory.agent.latest(qq).map(visible),
        document: memory.read(qq) ?? '' };
      if (args.action === 'history') return { status: 'HISTORY', records: memory.agent.history(qq, args.slot).map(visible) };
      if (!['upsert', 'forget', 'restore'].includes(args.action)) throw new Error('未知记忆操作');
      const evidence = String(args.evidence ?? '').trim();
      const windowSource = registry.byKey.get(origin.conversation)?.window?.find((m) => !m.bot &&
        String(m.qq) === qq && String(m.messageId) === String(origin.message_id));
      const storedSource = store.readEvents?.(origin.conversation, { limit: 200, latest: true })?.messages?.find((m) =>
        m.kind === 'inbound' && String(m.payload?.qq) === qq && String(m.payload?.messageId) === String(origin.message_id))?.payload;
      const sourceText = windowSource?.text ?? storedSource?.text ?? origin.text;
      if (evidence.length < 2 || !normalize(sourceText).includes(normalize(evidence)))
        throw new Error('记忆证据必须来自本轮发送者的真实原文');
      let data = args;
      if (args.action === 'restore') {
        const old = memory.agent.history(qq, args.slot).find((r) => r.version === args.restore_version && !r.deleted &&
          r.sources.some((s) => !memory.facts.withdrawn(s.conversation, s.messageId)));
        if (!old) throw new Error('历史版本不存在、已忘记或来源已撤回');
        data = { ...args, kind: old.kind, text: old.text, period: old.period };
      }
      const current = memory.agent.latest(qq).find((r) => r.slot === args.slot);
      const result = memory.agent.write({ qq, slot: args.slot, version: args.version,
        kind: data.kind ?? current?.kind ?? 'profile', text: args.action === 'forget' ? '' : data.text,
        period: args.action === 'forget' ? '' : data.period ?? '', deleted: args.action === 'forget',
        sources: [{ conversation: origin.conversation, messageId: origin.message_id, evidence,
          qq, who: origin.who, at: windowSource?.at ?? storedSource?.at ?? origin.created_at }] });
      // SQLite 提交已完成；文档投影失败不能把成功写入报告为失败。
      try { memory.syncDocument(qq, origin.who); }
      catch { result.documentPending = true; }
      return result;
    },
  };
}
