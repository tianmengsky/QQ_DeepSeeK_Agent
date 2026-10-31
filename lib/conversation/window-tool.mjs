import { assertExecutionSource, boundSource } from '../agent/execution-scope.mjs';
import { admitMessage } from '../domain/admission.mjs';

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

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
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

/** `conversation` 拆成 {kind, id}；认不出来返回 null。 */
function splitConversation(key) {
  const m = /^(group|user):([1-9]\d*)$/u.exec(String(key ?? ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

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
  /**
   * 窗口名。群名来自 `self_group`，好友备注来自 `self_friend`；
   * 都查不到时退回"某个群/某个人"——宁可她不知道是谁，也不把号码交出去。
   */
  const names = () => {
    const map = new Map();
    if (!store?.available) return map;
    try {
      for (const row of store.db.prepare('SELECT group_id, name FROM self_group').all())
        if (row?.group_id) map.set('group:' + row.group_id, clip(row.name, 24) || '某个群');
    } catch {}
    try {
      for (const row of store.db.prepare('SELECT user_id, nickname, remark FROM self_friend').all()) {
        if (!row?.user_id) continue;
        map.set('user:' + row.user_id, clip(row.remark || row.nickname, 24) || '某个人');
      }
    } catch {}
    return map;
  };

  /** 这本书只能翻她本来就在的那些窗口：白名单之外的一律不出现。 */
  const permitted = (key) => {
    const parts = splitConversation(key);
    if (!parts) return false;
    return parts.kind === 'group'
      ? Boolean(config.groupEnabled) && isAllowed(config.groups, parts.id)
      : Boolean(config.privateEnabled) && isAllowed(config.users, parts.id);
  };

  const listWindows = (limit) => {
    if (!store?.available) return [];
    const rows = store.db
      .prepare(`SELECT conversation, last_message_at, last_spoke_at FROM conversations
                WHERE last_message_at > 0 ORDER BY last_message_at DESC LIMIT ?`)
      .all(Math.max(1, Math.min(50, limit)));
    return rows.filter((row) => permitted(row.conversation));
  };

  const label = (key, map) => {
    const parts = splitConversation(key);
    if (!parts) return key;
    const name = map.get(key);
    return `${parts.kind === 'group' ? '群' : '私聊'}「${name || (parts.kind === 'group' ? '某个群' : '某个人')}」`;
  };

  /**
   * 窗口别名：`list` 只给 `w1/w2…`，不给群号。
   *
   * 号码在她嘴里没有任何用处，写进消息却是实打实的泄露；而 `read` 又必须有个
   * 指代目标的东西。别名按会话固定（同一个窗口一直是 w3），重载后重新 list 即可。
   */
  const aliasMaps = new Map();
  const aliasState = (session) => {
    let entry = aliasMaps.get(session);
    if (!entry) aliasMaps.set(session, (entry = { byConv: new Map(), byAlias: new Map(), next: 0 }));
    return entry;
  };
  const aliasOf = (session, key) => {
    const entry = aliasState(session);
    let alias = entry.byConv.get(key);
    if (!alias) {
      alias = 'w' + ++entry.next;
      entry.byConv.set(key, alias);
      entry.byAlias.set(alias, key);
    }
    return alias;
  };
  const conversationOf = (session, token) => {
    const value = String(token ?? '').trim();
    if (/^w\d+$/u.test(value)) return aliasState(session).byAlias.get(value) ?? null;
    return splitConversation(value) ? value : null;
  };

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
    return rows.map((m) => lineOf(m, map)).filter(Boolean);
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
      'action=read 读某个窗口最近的对话（需要 conversation，从 list 里拿；给 query 就只回命中那几行和上下文）；' +
      'action=mine 只看你自己在各窗口说过的话（想知道"我答应过什么"用它，可加 query 只找某件事）；' +
      'action=search 在所有窗口里找关键词，speaker=me 只看你说的（命中会带上紧挨着的上一句，' +
      '方便看清"当时问的是什么"）。' +
      '**想不起是哪个窗口、只记得一句话时，直接用 search，不用先 list 再 read。**' +
      'action=say 往某个窗口说一句话（to=编号，text=要说的话）——你不在那个房间也能说话，' +
      '说完这句会记进那边的对话，下次你在那儿醒来会认得出是自己说的。' +
      '用法约定：别的窗口的事只当背景，别在这个窗口里复述原话或点名"某某群有人说过"；' +
      '读到的号码一律不要写进消息里。',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['list', 'read', 'mine', 'search', 'say'],
        description: 'list=有哪些窗口；read=读某个窗口；mine=你自己说过的话；search=关键词检索；say=往某个窗口说话' },
      conversation: { type: 'string', description: 'list 里给的编号，如 w2（也可以直接写 group:<群号>）；search/read 可选' },
      limit: { type: 'integer', description: `读多少条，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}` },
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
      const group = here.startsWith('group:');
      if (!admitMessage(config, { message_type: group ? 'group' : 'private',
        group_id: group ? here.slice(6) : undefined, user_id: origin.qq })) throw new Error('窗口历史来源未准入');

      const map = names();
      const maxChars = Math.max(600, Number(config.crossWindowMaxChars ?? 3000) || 3000);
      const action = String(args.action ?? 'list');
      const limit = Math.max(1, Math.min(MAX_LIMIT, Number(args.limit) || DEFAULT_LIMIT));
      const out = budgeted(maxChars);

      if (action === 'list') {
        const rows = listWindows(limit);
        out.push(`你此刻在这个窗口：${label(here, map)}`);
        out.push('你的其他窗口（用编号 w? 去读）：');
        for (const row of rows) {
          if (row.conversation === here) continue;
          const tail = windowLines(row.conversation, 1, map).pop() ?? '';
          // 库里的 `last_spoke_at` 从来没人写过；真值在会话表的内存条目里。
          const liveSpoke = Number(registry?.byKey?.get?.(row.conversation)?.lastSpokeAt) || Number(row.last_spoke_at) || 0;
          const spoke = liveSpoke > 0 ? `你最后一次说话 ${stamp(liveSpoke)}` : '你还没在那儿说过话';
          const alias = aliasOf(session, row.conversation);
          if (!out.push(`- ${alias} ${label(row.conversation, map)}｜${spoke}${tail ? '｜最近：' + tail : ''}`)) break;
        }
        if (out.empty) return { status: 'EMPTY', note: '除了这个窗口，没有别的窗口有记录。' };
        return { status: 'WINDOWS', current: label(here, map), text: out.text() };
      }

      if (action === 'read') {
        const key = conversationOf(session, args.conversation);
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
        return { status: 'READ', name: label(key, map), lines: lines.length, text: out.text() };
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
        return { status: 'MINE', query: query || undefined, text: out.text() };
      }

      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        if (query.length < 1) throw new Error('search 需要 query');
        const speaker = ['any', 'me', 'them'].includes(String(args.speaker ?? '')) ? String(args.speaker) : 'any';
        const days = Math.max(1, Math.min(MAX_SEARCH_DAYS, Number(args.days) || SEARCH_DEFAULT_DAYS));
        let keys = [...new Set([here, ...listWindows(50).map((row) => row.conversation)])].filter(permitted);
        if (args.conversation) {
          const only = conversationOf(session, args.conversation);
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
        if (!send) throw new Error('发送通道未就绪');
        const key = conversationOf(session, args.to ?? args.conversation);
        if (!key) throw new Error('to 传 list 里的编号（如 w2）');
        if (!permitted(key)) throw new Error('这个窗口不在可发送范围里');
        const body = String(args.text ?? '').trim();
        if (!body) throw new Error('say 需要 text');
        const cap = Math.max(40, Number(config.crossWindowSayChars ?? 200) || 200);
        if (body.length > cap) throw new Error(`一句话最多 ${cap} 字，长了就不像在说话了`);
        const idemKey = `say:${session}:${key}:${Date.now()}`;
        const result = await send({ conversation: key, text: body, idemKey });
        if (!result?.sent) return { status: 'FAILED', name: label(key, map), note: String(result?.status ?? '发送失败') };
        return { status: 'SENT', to: aliasOf(session, key), name: label(key, map), text: body };
      }

      throw new Error('未知窗口操作');
    },
  };
}

/** 白名单空 = 不限制（与 `admitMessage` 的语义一致）。 */
function isAllowed(list = [], id) {
  return !Array.isArray(list) || list.length === 0 || list.map(String).includes(String(id));
}
