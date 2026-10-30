import { assertExecutionSource, boundSource } from '../agent/execution-scope.mjs';
import { admitMessage } from '../domain/admission.mjs';
import { normalize } from './facts.mjs';
import { memorySubject } from './agent-memory.mjs';

/** 不指定 kind 时的默认类别：人物本按资料，群本与通用本按记事。 */
const MEMORY_KIND_FALLBACK = { user: 'profile', group: 'note', self: 'note' };

/**
 * 三层记事本共用一个工具。
 *
 * 为什么不是三个工具：schema 会进每一次请求。三份几乎相同的参数
 * （slot/version/kind/text/evidence）会让每轮多背约 600 token，
 * 而它们唯一的差别只是 `scope` 一个枚举值。
 *
 * 为什么把"什么时候写"塞进 description：实测线上模型几乎不主动调用记忆工具，
 * 原因不是工具不好用，而是描述里只有语法（read/upsert/forget）没有任何触发条件。
 * 模型看到 `qq_memory` 只会当成"一种可选能力"，不会当成"每轮该考虑的动作"。
 * 所以这里必须写清触发场景与禁写场景 —— 描述本身就是提示词。
 */
export function memoryTool({ memory, registry, store, config, state }) {
  return {
    name: 'qq_memory',
    description:
      '三层记事本，你唯一的长期记忆。scope=user 只记人不记事（他是谁：称呼、身份、关系、习惯、忌讳）；' +
      'scope=group 只记事不记人（这个群怎么运转：称呼习惯、黑话、气氛、群级约定）；' +
      'scope=self 是日记本，想写什么写什么，由你自己决定（事件、承诺、心情、判断）。' +
      '口诀：描述一个人→user；描述一个群→group；其余全进日记本。事件与承诺不进人物本。' +
      '不要写：寒暄、玩笑、猜测、第三人传闻、任务进度。' +
      'scope=self 除了事件，还能写四种想法：kind=stance 我怎么看这件事（可以改）、want 我想要什么、' +
      'open 我还没想通什么、relation 我跟他现在是什么关系；它们比事件更像"我"，改主意了就写新版本。' +
      'slot 以 me. 开头＝这条已脱敏、能当众说，会注入所有场合（必须带 visibility=public）；' +
      '其余 self 条目默认 private，只进私聊。' +
      '先 read 取 version 再 upsert；note 与想法类可不引用原文但要基于本轮消息；profile/explicit 必须附原文证据；SAVED 回执才能说“记住了”。',
    parameters: { type: 'object', properties: {
      scope: { type: 'string', enum: ['user', 'group', 'self'],
        description: '写哪一本；默认 user。user=只记人，group=只记事，self=日记本（随便记）' },
      action: { type: 'string', enum: ['read', 'upsert', 'forget', 'history', 'restore'] },
      slot: { type: 'string', description: '稳定属性槽，如 profile.name 或 rhythm.wednesday；不同事实分槽。me.xxx 表示能当众说的自我看法' },
      version: { type: 'integer', description: 'read 返回的当前槽版本；新槽为0' },
      restore_version: { type: 'integer', description: 'restore要恢复的历史版本' },
      kind: { type: 'string', enum: ['explicit', 'profile', 'impression', 'note', 'stance', 'want', 'open', 'relation'],
        description: 'explicit/profile 需原文证据；impression 是可修订观察；note 是自由记事；stance/want/open/relation 是看法（只用于 self）' },
      visibility: { type: 'string', enum: ['private', 'public'],
        description: '仅 scope=self 有效。me.* 槽必须 public（它进所有场合）；其余条目 public 才进群聊，且须自审不含群号、人名、别处的事；默认 private' },
      text: { type: 'string', description: '记忆要点，最多600字符；印象明确写为观察判断' },
      period: { type: 'string', description: '原文支持的日期/时期/有效范围；不确定时保留原说法' },
      evidence: { type: 'string', description: '来源消息中的连续原文，作为证据材料解释；note 可省略' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(args, exec) {
      exec.signal?.throwIfAborted();
      if (!memory?.agent?.available || state.disposed || !state.enabled) throw new Error('记忆服务不可用或托管已关闭');
      // 发送者身份来自宿主按 Session 解析的本轮来源，不再由模型填写。
      const origin = state.sourceLedger.resolve(boundSource(store, exec.agent?.session?.id)?.sourceRef);
      if (!origin || !origin.qq || !origin.message_id) throw new Error('记忆来源无效、已撤回或过期');
      const execution = assertExecutionSource(store, origin);
      const session = exec.agent?.session?.id;
      const owner = execution?.sessionId ?? registry.byKey.get(origin.conversation)?.sessionId;
      if (!session || session !== owner) throw new Error('记忆来源不属于调用工具的当前 Session');
      const group = origin.conversation.startsWith('group:');
      if (!admitMessage(config, { message_type: group ? 'group' : 'private',
        group_id: group ? origin.conversation.slice(6) : undefined, user_id: origin.qq })) throw new Error('记忆来源未准入');
      const qq = String(origin.qq);
      /**
       * 主体由宿主按 scope 解析，不接受模型直接填 subject。
       *
       * 理由与 source_ref 相同：让模型自己拼 `group:xxx` 只会多一种填错的方式，
       * 而"当前在哪个群"宿主本来就知道。群本只能落到当前群，跨群写入被直接拒绝
       * —— 这是跨群隐私的边界，不能靠提示词。
       */
      const scope = ['user', 'group', 'self'].includes(args.scope) ? args.scope : 'user';
      const subject = memorySubject(scope, { qq, conversation: origin.conversation });
      const visible = (r) => {
        const withdrawn = !r.sources.some((s) => !memory.facts.withdrawn(s.conversation, s.messageId));
        return { scope, slot: r.slot, version: r.version, kind: r.kind, visibility: r.visibility ?? 'private',
          text: r.deleted || withdrawn ? '' : r.text, period: r.deleted || withdrawn ? '' : r.period,
          deleted: Boolean(r.deleted), withdrawn };
      };
      if (args.action === 'read') {
        const records = memory.agent.latest(subject).map(visible);
        /**
         * 有效条目数与占用字符。
         *
         * 为什么给模型看这个：它没有"这本有多满"的直觉，而整本都会被注入 ——
         * 堆到二十条时它仍以为自己只是"多记了几条"。给出 chars/budget 和
         * 明确的 hint，比在提示词里写"你自己感觉一下"可靠得多。
         *
         * 预算取的是**注入预算**（群本 600 / 日记 400 / 人物池 1800），
         * 不是数据库容量：真正会出问题的是"注不进去"，不是"存不下"。
         */
        const live = records.filter((r) => !r.deleted && !r.withdrawn);
        const chars = live.reduce((n, r) => n + String(r.text ?? '').length, 0);
        const budget = Number(scope === 'group' ? config.groupNotesMaxChars
          : scope === 'self' ? config.selfNotesMaxChars : config.memoryInjectMaxChars) || 0;
        const result = { status: 'READ', scope, subject, count: live.length, chars, budget, records,
          // 只有人物本有 Markdown 投影，群本与通用本没有对应文件。
          ...(scope === 'user' ? { document: memory.read(qq) ?? '' } : {}) };
        if (budget > 0 && chars > budget * 0.8)
          result.hint = `这本已占 ${chars}/${budget} 字的注入预算；先清掉不再成立的条目，再写新的。`;
        return result;
      }
      if (args.action === 'history') return { status: 'HISTORY', scope,
        records: memory.agent.history(subject, args.slot).map(visible) };
      if (!['upsert', 'forget', 'restore'].includes(args.action)) throw new Error('未知记忆操作');
      const evidence = String(args.evidence ?? '').trim();
      const windowSource = registry.byKey.get(origin.conversation)?.window?.find((m) => !m.bot &&
        String(m.qq) === qq && String(m.messageId) === String(origin.message_id));
      const storedSource = store.readEvents?.(origin.conversation, { limit: 200, latest: true })?.messages?.find((m) =>
        m.kind === 'inbound' && String(m.payload?.qq) === qq && String(m.payload?.messageId) === String(origin.message_id))?.payload;
      const sourceText = windowSource?.text ?? storedSource?.text ?? origin.text;
      const kind = args.kind ?? MEMORY_KIND_FALLBACK[scope];
      // 只有 self 本有可见范围；其余两本的可见性由主体本身决定，这里固定 private 不参与判断。
      const visibility = scope === 'self' && args.visibility === 'public' ? 'public' : 'private';
      /**
       * 证据要求按类别分级，而不是按 scope 一刀切。
       *
       *   profile / explicit —— 关于**别人**的稳定事实，必须能指回对方原话，
       *                        否则就会出现"她记得一件从没发生过的事"。
       *   impression / note  —— 我的判断与笔记，允许没有原文（原文是别人的话，
       *                        装不下我自己的观察），但仍然绑定本轮消息作依据；
       *                        消息被撤回时这些条目会随级联一起失效。
       */
      const strict = kind === 'explicit' || kind === 'profile';
      if (strict && (evidence.length < 2 || !normalize(sourceText).includes(normalize(evidence))))
        throw new Error('人物资料与明确记忆必须引用本轮发送者的真实原文；自由记事请用 note');
      if (!strict && !String(args.text ?? '').trim() && args.action !== 'forget') throw new Error('记忆要点不能为空');
      let data = args;
      if (args.action === 'restore') {
        const old = memory.agent.history(subject, args.slot).find((r) => r.version === args.restore_version && !r.deleted &&
          r.sources.some((s) => !memory.facts.withdrawn(s.conversation, s.messageId)));
        if (!old) throw new Error('历史版本不存在、已忘记或来源已撤回');
        data = { ...args, kind: old.kind, text: old.text, period: old.period };
      }
      const current = memory.agent.latest(subject).find((r) => r.slot === args.slot);
      const result = memory.agent.write({ subject, slot: args.slot, version: args.version,
        kind: data.kind ?? current?.kind ?? (scope === 'user' ? 'profile' : 'note'),
        visibility,
        text: args.action === 'forget' ? '' : data.text,
        period: args.action === 'forget' ? '' : data.period ?? '', deleted: args.action === 'forget',
        sources: [{ conversation: origin.conversation, messageId: origin.message_id, evidence,
          qq, who: origin.who, at: windowSource?.at ?? storedSource?.at ?? origin.created_at }] });
      /**
       * SQLite 提交已完成；文档投影失败不能把成功写入报告为失败。
       *
       * 三本都有投影：人物本是 `memory/<qq>.md`（含手工段落，不能覆盖），
       * 群本与日记本是 `memory/groups/<群号>.md` / `memory/diary.md`（纯投影）。
       * 统一走 `syncNotebook`，它对人物本会转回原来的 `syncDocument`。
       */
      try { memory.syncNotebook(subject); }
      catch { result.documentPending = true; }
      return result;
    },
  };
}
