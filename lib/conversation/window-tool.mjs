import { assertExecutionSource, boundSource } from '../agent/execution-scope.mjs';
import { admitMessage } from '../domain/admission.mjs';
/**
 * 窗口名册（名字/白名单/最近动静/别名）在 `window-index.mjs`：
 * `qq_dispatch` 认的是同一份 `w?` 编号、同一套白名单——抄两份一定会烂。
 */
import {
  windowNames, permittedConversation, listRecentWindows, conversationLabel,
  aliasOf, conversationOf, splitConversation,
} from './window-index.mjs';

/**
 * 跨窗口视角：读"别的窗口"里发生过什么，以及她自己在那儿说过什么。
 *
 * 为什么需要它：她同时活在几个群和私聊里，但每个窗口的上下文是隔离的 ——
 * 在 A 群答应的事，到了 B 群她不知道；A 群昨天吵的那一架，她也接不上。
 * 桥接本来就有一份全量记录（`events` 表，进出都写），只是从来没有给她一个
 * 读它的方式。
 *
 * 为什么不做成"每轮注入全部窗口"：几个群 × 几十条 = 上万字，把眼前的对话挤没了。
 * 这里只在**她主动想知道**时读，读多少由参数决定，返回有字数上限。
 *
 * 为什么输出不带 QQ 号、只带显示的称呼：这是她的记忆，不是别人的资料库。
 * 号码在她嘴里没有任何用处，漏出去却是实打实的代价。
 */

/**
 * 一次 `read` 给多少条。
 *
 * 2026-11-01：原来 40 条，短了——热闹的群 40 条只覆盖一两个小时，她 16:24 想核对
 * 「全紫」是哪来的，那条在 `group:946719566` 11:12，默认 40 条只回到 13:16，
 * 她压根读不到原话，只能凭记忆里的名字猜一个群。先从 40 提到 100；
 * 用户随后拍板「真人也不会一次性看 99 条消息的，改成 50 条就够了」——现在 50。
 * 再往前翻用 `search`（按关键词，7 天）。
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
/**
 * read 的字数预算。
 *
 * 原来所有动作共用 `crossWindowMaxChars`（默认 3000）。50 行对话光排版就五六千字，
 * 3000 字预算读到三十来行就断了，结尾只写"还有 N 项没显示"——等于"读 50 条"名不副实。
 * read 单独给足预算，别的动作仍按配置走。
 */
const READ_BUDGET_CHARS = 10000;
const SEARCH_DEFAULT_DAYS = 7;
const MAX_SEARCH_DAYS = 30;
const LINES_PER_WINDOW = 6;

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间 `MM-DD HH:MM`。跨天读历史时，只给 `HH:MM` 会让人分不清是哪天。 */
function stamp(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

/** `conversation` 拆成 {kind, id}；认不出来返回 null。已挪到 window-index.mjs 共享。 */

/**
 * 一次调用的输出容器：所有分支共用，超上限就停手并在末尾说清还剩多少。
 *
 * 为什么在上限处就停：工具结果会整段进上下文，她自己也不知道"读到第几行会失控"。
 */
function budgeted(max) {
  const lines = [];
  let used = 0;
  let dropped = 0;
  return {
    push(line) {
      const cost = String(line).length + 1;
      if (used + cost > max) {
        dropped += 1;
        return false;
      }
      lines.push(line);
      used += cost;
      return true;
    },
    get dropped() {
      return dropped;
    },
    text(tail = '') {
      const body = lines.join('\n');
      return dropped ? `${body}\n（还有 ${dropped} 项没显示；缩小范围再查）` : body + tail;
    },
    get empty() {
      return lines.length === 0;
    },
  };
}

export function windowsTool({ store, config, state, registry, send = null }) {
  // 名册都在 window-index.mjs；这里只绑住本工具的 store/config，调用点保持原样。
  const names = () => windowNames(store);
  const permitted = (key) => permittedConversation(config, key);
  const listWindows = (limit) => listRecentWindows(store, config, { limit });
  const label = (key, map) => conversationLabel(key, map);

  /**
   * 窗口别名：`list` 只给 `w1/w2…`，不给群号。账本在 window-index.mjs——
   * `qq_dispatch` 认的是同一份编号，两个工具给她的指向永远一致。
   */

  /** 一条事件变成一行。"她说的"用「你」，别人用当时的群名片/昵称。 */
  const lineOf = (message, map) => {
    const payload = message.payload ?? {};
    const at = Number(payload.at ?? message.createdAt) || 0;
    const mine = message.kind === 'self_message' || message.kind === 'action';
    const who = mine ? '你' : clip(payload.who || payload.qq || '有人', 16);
    const text = clip(payload.text ?? payload.summary ?? '', 160);
    return text ? `${stamp(at)} ${who}：${text}` : '';
  };

  const windowLines = (key, limit, map) => {
    const { messages } = store.readEvents(key, { limit, latest: true });
    const rows = messages.filter((m) => m.kind === 'inbound' || m.kind === 'self_message' || m.kind === 'action');
    /**
     * 同一条消息在库里可能有两份：发送时记一份（`who='你'`），OneBot 把回显再报一次时
     * 又记一份（`who` 是她自己的昵称，`dedupe_key` 是 `onebot:<self>:<mid>`）。
     * 两个键不一样，写的时候拦不住；不在这里去重，她读自己的历史就是一句顶两句——
     * 2026-11-01 线上 `1033440455` 最近 40 条里 24 条是 self_message，实际只有十二三句。
     */
    const seen = new Set();
    const lines = [];
    for (const m of rows) {
      const mid = m.payload?.messageId;
      if (mid != null && mid !== '') {
        const tag = 'mid:' + mid;
        if (seen.has(tag)) continue;
        seen.add(tag);
      }
      const line = lineOf(m, map);
      if (line) lines.push(line);
    }
    return lines;
  };

  /**
   * 这一行是不是"她说的"。
   *
   * 不能看 kind 之外的东西：`lineOf` 已经把她统一标成「你：」，所以这里就认这个记号。
   * 用"你"而不是 QQ 号，是因为号码本来就不该进这个工具的视野。
   */
  const isMine = (line) => line.includes(' 你：');

  /**
   * 这一行前面那句话，如果是别人说的就带出来。
   *
   * 为什么要有它：她问"我在那边答应过什么"，答案常常在两行里 —— 别人问的条件 + 她的答复。
   * 只给她自己那半句，她会照着半句接话（线上就是这样：搜到"我答应过"却答不上答应的是什么）。
   * 只补**紧挨着的上一行**、且只在它不是她说的时补，避免把整段对话又倒一遍。
   */
  const contextOf = (lines, index) => {
    if (index <= 0) return '';
    const prev = lines[index - 1];
    if (!prev || isMine(prev)) return '';
    return `‹上文› ${prev}`;
  };

  return {
    name: 'qq_windows',
    description:
      '看别的窗口。你同时在几个群和私聊里，每个窗口的上下文是分开的；这个工具能读' +
      '「别的窗口最近发生了什么」和「你自己在那边说过什么、答应过什么」。' +
      'action=list 看有哪些窗口（名字、最后一条、你最后一次说话）；' +
      'action=read 读某个窗口最近的对话（默认最近 100 条，需要 conversation，从 list 里拿；给 query 就只回命中那几行和上下文）；' +
      'action=mine 只看你自己在各窗口说过的话（想知道"我答应过什么"用它，可加 query 只找某件事）；' +
      'action=search 在所有窗口里找关键词，speaker=me 只看你说的（命中会带上紧挨着的上一句，' +
      '方便看清"当时问的是什么"）。' +
      '**想不起是哪个窗口、只记得一句话时，直接用 search，不用先 list 再 read。**' +
      'action=say 往某个窗口说一句话（to=编号，text=要说的话）——只对房间里的你开放：' +
      '你在某个群/私聊里醒来时，可以给别的窗口留一句话；不能对着当前窗口用（那走 qq_say 或最终正文）；' +
      '你自己的时间里没有嘴，想说的话用 qq_dispatch 派过去。' +
      '一句话就是一条气泡：想连着说两句，用空行把 text 分成两段，桥接会按气泡一条条发（中间有停顿）；' +
      '不要用空行在一条消息里堆两段话——那在对方那里是一个大气泡里两截，不像在说话。' +
      '用法约定：别的窗口的事只当背景，别在这个窗口里复述原话或点名"某某群有人说过"；' +
      '读到的号码一律不要写进消息里。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'read', 'mine', 'search', 'say'],
        description: 'list=有哪些窗口；read=读某个窗口；mine=你自己说过的话；search=关键词检索；say=往某个窗口说话' },
      conversation: { type: 'string', description: 'list 里给的编号，如 w2（也可以直接写 group:<群号>）；search/read 可选' },
      limit: { type: 'integer', description: `读多少条，默认 ${DEFAULT_LIMIT}（最近 ${DEFAULT_LIMIT} 条），最多 ${MAX_LIMIT}` },
      query: { type: 'string', description: 'search/mine 的关键词；给 read 时只回命中行和上下文' },
      speaker: { type: 'string', enum: ['any', 'me', 'them'],
        description: 'search 的发言人过滤：any=都看（默认），me=只看你说过的，them=只看别人说的' },
      days: { type: 'integer', description: 'search 往回找几天，默认 7' },
      to: { type: 'string', description: 'say 的目标窗口编号，如 w2（也可以直接写 group:<群号> / user:<号>）' },
      text: { type: 'string', description: 'say 要说的话（一两句，别写成公告）' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      exec.signal?.throwIfAborted();
      if (!store?.available || state.disposed || !state.enabled) throw new Error('窗口历史不可用或托管已关闭');
      /**
       * 来源校验和记忆工具同一套：调用必须来自某个真实的 QQ 回合，
       * 而且必须是当前 Session 的主人。没有这一层，子代理或任何旁路都能拿它当
       * "读整个聊天库"的入口。
       */
      const origin = state.sourceLedger?.resolve?.(boundSource(store, exec.agent?.session?.id)?.sourceRef);
      if (!origin || !origin.qq || !origin.message_id) throw new Error('窗口历史来源无效、已撤回或过期');
      const execution = assertExecutionSource(store, origin);
      const session = exec.agent?.session?.id;
      const owner = execution?.sessionId ?? registry?.byKey?.get(origin.conversation)?.sessionId;
      if (!session || session !== owner) throw new Error('窗口历史来源不属于调用工具的当前 Session');
      const here = origin.conversation;
      // `self:account` 是"她自己的时间"，不属于任何房间：这里没有群、没有私聊，
      // 也就没有"消息准入"可判。以前这一行会用私聊准入去校验她自己的号，
      // 结果是——**她在外面醒来时 qq_windows 整个工具都调不通**（list 都报"来源未准入"）。
      const isSelfTurn = here.startsWith('self:');
      const group = here.startsWith('group:');
      if (!isSelfTurn && !admitMessage(config, { message_type: group ? 'group' : 'private',
        group_id: group ? here.slice(6) : undefined, user_id: origin.qq })) throw new Error('窗口历史来源未准入');

      const map = names();
      const baseChars = Math.max(600, Number(config.crossWindowMaxChars ?? 3000) || 3000);
      const action = String(args.action ?? 'list');
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args.limit) || DEFAULT_LIMIT));
      const out = budgeted(action === 'read' ? Math.max(baseChars, READ_BUDGET_CHARS) : baseChars);

      if (action === 'list') {
        const rows = listWindows(limit);
        out.push(isSelfTurn ? '你此刻不在任何房间里——这是你自己的时间。' : `你此刻在这个窗口：${label(here, map)}`);
        out.push(isSelfTurn ? '你可以去的窗口（用编号 w? 去读，用 say 说话）：' : '你的其他窗口（用编号 w? 去读）：');
        for (const row of rows) {
          if (!isSelfTurn && row.conversation === here) continue;
          const tail = windowLines(row.conversation, 1, map).pop() ?? '';
          // 库里的 `last_spoke_at` 从来没人写过；真值在会话表的内存条目里。
          const liveSpoke = Number(registry?.byKey?.get?.(row.conversation)?.lastSpokeAt) || Number(row.last_spoke_at) || 0;
          const spoke = liveSpoke > 0 ? `你最后一次说话 ${stamp(liveSpoke)}` : '你还没在那儿说过话';
          const alias = aliasOf(session, row.conversation, store);
          if (!out.push(`- ${alias} ${label(row.conversation, map)}｜${spoke}${tail ? '｜最近：' + tail : ''}`)) break;
        }
        if (out.empty) return { status: 'EMPTY', note: isSelfTurn ? '这一周没有任何窗口有记录。' : '除了这个窗口，没有别的窗口有记录。' };
        return { status: 'WINDOWS', current: isSelfTurn ? '自己的时间' : label(here, map), text: out.text() };
      }

      if (action === 'read') {
        const key = conversationOf(session, args.conversation, store);
        if (!key) throw new Error('conversation 传 list 里的编号（如 w2）');
        if (!permitted(key)) throw new Error('这个窗口不在可读范围里');
        const query = String(args.query ?? '').trim();
        if (query) {
          // 带 query 时不整窗倒给她，只回命中行 + 前后各一条：她自己说的"两下嘛"就是这一步。
          const lines = windowLines(key, MAX_LIMIT, map);
          const picked = [];
          lines.forEach((line, index) => {
            if (!line.includes(query)) return;
            for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i += 1)
              if (!picked.includes(i)) picked.push(i);
          });
          if (!picked.length)
            return { status: 'EMPTY', name: label(key, map), note: `这个窗口最近的记录里没有「${query}」。` };
          picked.sort((a, b) => a - b);
          for (const i of picked) if (!out.push(lines[i])) break;
          return { status: 'READ', name: label(key, map), query, lines: picked.length, text: out.text() };
        }
        const lines = windowLines(key, limit, map);
        if (!lines.length) return { status: 'EMPTY', name: label(key, map), note: '这个窗口最近没有可读的记录。' };
        for (const line of lines) if (!out.push(line)) break;
        /**
         * 说清边界。
         *
         * 读到 N 条就停，她看不出"再往前是有的，只是没给你"，容易把"我读到的这些"
         * 当成"这群全部"——16:24 那次就是拿半截信息拼了一句话。这里明写一句，
         * 更早的去 `search`（按关键词，7 天）。
         */
        const tail = `\n（这是最近的 ${lines.length} 条；再往前用 action=search 加 query 按关键词找）`;
        return { status: 'READ', name: label(key, map), lines: lines.length, text: out.text(tail) };
      }

      if (action === 'mine') {
        // 不看 `last_spoke_at`：那是桥接记录的"最后发言"，补账/回填的旧消息不会更新它；
        // 直接扫每个窗口的对话行里她自己说的那几句更准。
        const query = String(args.query ?? '').trim();
        const rows = listWindows(50);
        for (const row of rows) {
          const lines = windowLines(row.conversation, LINES_PER_WINDOW * 3, map);
          const mine = [];
          lines.forEach((line, index) => {
            if (!isMine(line)) return;
            if (query && !line.includes(query)) return;
            mine.push({ line, ctx: contextOf(lines, index) });
          });
          const tail = mine.slice(-LINES_PER_WINDOW);
          if (!tail.length) continue;
          if (!out.push(`${label(row.conversation, map)}`)) break;
          for (const item of tail) {
            if (!out.push('  ' + item.line)) break;
            if (item.ctx) out.push('    ' + item.ctx);
          }
        }
        if (out.empty)
          return { status: 'EMPTY', note: query ? `你最近没有在任何窗口提过「${query}」。` : '你最近没有在任何窗口说过话。' };
        // 2026-11-01：原来写 `query: query || undefined`——字段带着 undefined 值，
        // 过不了 DSH 的无损 JSON 校验，不带 query 的 mine 调用必挂（线上 19:32 实测）。
        return { status: 'MINE', ...(query ? { query } : {}), text: out.text() };
      }

      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        if (query.length < 1) throw new Error('search 需要 query');
        const speaker = ['any', 'me', 'them'].includes(String(args.speaker ?? '')) ? String(args.speaker) : 'any';
        const days = Math.max(1, Math.min(MAX_SEARCH_DAYS, Number(args.days) || SEARCH_DEFAULT_DAYS));
        let keys = [...new Set([here, ...listWindows(50).map((row) => row.conversation)])].filter(permitted);
        if (args.conversation) {
          const only = conversationOf(session, args.conversation, store);
          if (!only) throw new Error('conversation 传 list 里的编号（如 w2）');
          if (!permitted(only)) throw new Error('这个窗口不在可读范围里');
          keys = [only];
        }
        const hits = [];
        for (const key of keys) {
          const lines = windowLines(key, MAX_LIMIT, map);
          lines.forEach((line, index) => {
            if (speaker === 'me' && !isMine(line)) return;
            if (speaker === 'them' && isMine(line)) return;
            if (!line.includes(query)) return;
            // 只看她说过的话时，"上一句是谁问的"就是答案的另一半。
            const ctx = speaker === 'me' ? contextOf(lines, index) : '';
            hits.push({ text: `${label(key, map)} ${line}`, ctx });
          });
        }
        if (!hits.length)
          return { status: 'EMPTY', note: `最近 ${days} 天没有窗口提到「${query}」${speaker === 'me' ? '（只看你说的）' : ''}。` };
        for (const hit of hits.slice(-40)) {
          if (!out.push(hit.text)) break;
          if (hit.ctx) out.push('  ' + hit.ctx);
        }
        return { status: 'SEARCH', query, speaker, days, hits: hits.length, text: out.text() };
      }

      /**
       * 往别处说一句话。
       *
       * 这是"她是谁"这件事上缺的那一半：读得到别处（list/read/search）只让她知道
       * 房间长什么样，不能让她走进另一个房间说话。回合的最终正文只能发回当前窗口，
       * 所以没有这个动作时，群 A 里醒着的她永远没法完成"给私聊里的 A 留一句"。
       */
      if (action === 'say') {
        // 脊柱（她自己的时间）没有嘴：隔空 say 是"没根的话"——不经过房间里的她，
        // 接不住现场（2026-11-01 派遣架构）。提示词已经这么教了，工具必须认账，
        // 否则她两次碰壁就退回老路（v157 的教训反过来也一样：拦要拦得住）。
        if (isSelfTurn) throw new Error('你自己的时间里没有嘴：想说的话用 qq_dispatch 派到那个窗口，让在那儿的你说');
        if (!send) throw new Error('发送通道未就绪');
        const key = conversationOf(session, args.to ?? args.conversation, store);
        if (!key) throw new Error('to 传 list 里的编号（如 w2）');
        if (!permitted(key)) throw new Error('这个窗口不在可发送范围里');
        // 对着眼前说话不走这里：qq_say 是"本轮会话"的通道（绑定归属、走 outbox 记账），
        // 转道 windows say 会同一句话走两套账（sendSelfMessage 另记一份 self_message）。
        // 这也是它和 qq_say 唯一的重叠处——切掉，分工就干净了：qq_say=眼前，say=别处。
        if (key === here) throw new Error('对着当前窗口说话不用转 windows：即时的话用 qq_say，要说的正事交最终正文');
        const body = String(args.text ?? '').trim();
        if (!body) throw new Error('say 需要 text');
        const cap = Math.max(40, Number(config.crossWindowSayChars ?? 200) || 200);
        if (body.length > cap) throw new Error(`一句话最多 ${cap} 字，长了就不像在说话了`);
        const idemKey = `say:${session}:${key}:${Date.now()}`;
        const result = await send({ conversation: key, text: body, idemKey });
        if (!result?.sent) {
          // HELD 不是失败，是"学到的记性"：如实回给她，别让她以为自己发出去了。
          return {
            status: String(result?.status ?? 'FAILED'),
            name: label(key, map),
            note: result?.note ? String(result.note) : String(result?.status ?? '发送失败'),
          };
        }
        return { status: 'SENT', to: aliasOf(session, key, store), name: label(key, map), text: body };
      }

      throw new Error('未知窗口操作');
    },
  };
}
