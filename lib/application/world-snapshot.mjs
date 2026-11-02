/**
 * 世界快照——给她一个"不在任何房间里"的视角。
 *
 * 为什么需要这一层：她的每个回合都发生在某个窗口里，注入的上下文全是那个房间
 * 最近的消息。于是"要不要主动做点什么"这个决定，其实是被那间屋子的气氛推着
 * 做的：群 A 正热闹，她就想说话；群 B 冷清，她就以为世界冷清。
 *
 * 快照不是更多的记忆，是**一次换视角**：把各窗口的动静压成几行、加上她最近
 * 做过什么、手上有哪些想法，然后交给她自己判断。它只描述世界，
 * 不列任务、不写"你该做什么"。
 *
 * 数字在这里是允许的：这份文本只进脊柱（她自己的地方），不会被贴进任何群。
 * 注入房间的文本另有脱敏规矩。
 */
import { localStamp, WEEKDAYS } from '../domain/time.mjs';
import { isSelfModelSlot } from '../memory/agent-memory.mjs';

const DAY = 86400000;
const KIND_LABELS = { group: '群', user: '私聊' };
const ACTION_LABELS = { speak: '说了一句话', bili_share: '分享了一个视频', turn: '在自己时间里待了一会儿' };
/** 派遣（`qq_dispatch`）的状态怎么说。只报事实，不写"办得好不好"。 */
const DISPATCH_LABELS = {
  queued: '排在那个窗口的队列里，还没开始',
  running: '正在那边办',
  done: '已经去办了',
  silent: '那边看了看，没动手',
  failed: '没办成',
  needs_attention: '没办完；要不要重新派，由你定',
};

function labelOf(key) {
  const match = /^(group|user):([1-9]\d*)$/u.exec(String(key ?? ''));
  return match ? `${KIND_LABELS[match[1]]} ${match[2]}` : String(key ?? '某个窗口');
}

function agoLabel(at, now) {
  const ms = Math.max(0, Number(now) - Number(at || 0));
  if (!Number.isFinite(ms) || ms <= 0) return '刚刚';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/**
 * 拼一份世界快照。永不抛：快照坏了不该让她连醒都醒不过来。
 *
 * @param {object}  options
 * @param {object}  options.store   桥接库（会话、主动记录、天气都在这儿）
 * @param {object}  options.memory  记忆（`me.*` 想法）
 * @param {object}  [options.registry] 会话表（内存里才有"她最后一次说话"，库里那列是死的）
 * @param {number}  [options.now]   现在（测试用）
 * @param {number}  [options.maxWindows] 最多列几个窗口
 * @param {number}  [options.maxChars]   总预算，超了截断
 * @param {number}  [options.staleDays]  一件事放多久算"放久了"（默认 14 天）
 */
export function buildWorldSnapshot({ store, memory, registry = null, now = Date.now(), maxWindows = 6, maxChars = 900, staleDays = 14, learning = null } = {}) {
  const at = Number(now) || Date.now();
  const date = new Date(at);
  const lines = [];
  lines.push(`现在是 ${localStamp(date)}，周${WEEKDAYS[date.getDay()]}。你不在任何一个房间里——这是你自己的地方。`);

  // `conversations.last_spoke_at` 这一列从来没有写过，永远是 0；真值在会话表的内存条目里。
  // 先问内存，再退回库列——这样热重载之后也不会突然"从没在那间屋子说过话"。
  const spokeAtOf = (row) => {
    let live = 0;
    try {
      live = Number(registry?.byKey?.get?.(row.conversation)?.lastSpokeAt) || 0;
    } catch {
      live = 0;
    }
    if (live) return live;
    // 内存没有、库列又是死的 → 从 events 里回推。她说过的话一条都不会少，那才是真记录。
    const recorded = Number(store?.lastSelfMessageAt?.(row.conversation)) || 0;
    return recorded || Number(row.last_spoke_at) || 0;
  };

  const windows = (store?.listConversations?.({ since: at - 7 * DAY, limit: 20 }) ?? [])
    .filter((row) => row && row.last_message_at > 0)
    .slice(0, Math.max(1, Number(maxWindows) || 6));
  if (windows.length) {
    lines.push('', '【各窗口最近的动静】');
    for (const row of windows) {
      const quiet = agoLabel(row.last_message_at, at);
      const spokeAt = spokeAtOf(row);
      const spoke = spokeAt > 0
        ? `你最后一次说话是 ${agoLabel(spokeAt, at)}前`
        : '你还没在那边说过话';
      // 记性：只说"你在那儿开过几次口"，不说接没接。
      //
      // 2026-11-01（用户：「你不要想着操控她看见什么……最好也不要说有没有人接，
      // 这都会影响 LLM 的自由判断」）：原来这里写「最近 N 次你在这儿开口，没人接」，
      // 是一句替她下的结论——她读到就会收嘴，而她本来该自己去那个窗口看一眼再决定。
      // 学习照旧在后台算（`frequencyFactor` 决定候选权重），只是不再贴到她眼前。
      const learned = typeof learning === 'function' ? learning(row.conversation) : null;
      const memory = learned && learned.attempts >= 2
        ? `；你在那儿开口过 ${learned.attempts} 次`
        : '';
      lines.push(`- ${labelOf(row.conversation)}：${quiet}前有人说话；${spoke}${memory}`);
    }
  } else {
    lines.push('', '【各窗口最近的动静】', '- 这一周没有任何窗口在说话。');
  }

  const recent = store?.proactiveRecent?.({ limit: 12 }) ?? [];
  const actions = recent.filter((row) => row && String(row.status ?? '') === 'sent').slice(0, 4);
  if (actions.length) {
    lines.push('', '【你最近自己做过的事】');
    for (const row of actions) {
      // 只记"什么时候、在哪、做过什么"，不写"有没有人接"。
      // 有没有人接是她去那个窗口看一眼就能知道的事；我们替她判一个"没人接"，
      // 等于替她决定"下次别去了"。她要的是现场，不是评语。
      const ago = agoLabel(row.created_at, at);
      const when = ago === '刚刚' ? '刚刚' : `${ago}前`;
      lines.push(`- ${when}，在${labelOf(row.conversation)} ${ACTION_LABELS[row.kind] ?? '做了点什么'}`);
    }
  }

  // "什么都没做"也是她自己的时间，不该在账本上消失：连着几次没开口时说出来，
  // 让她知道自己这几回是安静地待着，而不是"我好像从没醒来过"。
  const quietTurns = recent.filter((row) => row && String(row.status ?? '') === 'skipped'
    && (at - (Number(row.created_at) || 0)) <= DAY && String(row.kind ?? '') === 'turn');
  if (quietTurns.length >= 3) {
    lines.push('', `【这几天你自己的时间】最近 ${quietTurns.length} 次醒来，你都只是看了看，没开口。`);
  }

  // 派遣回执：脊柱把"房间身份"类的念头派给对应窗口办，这里只报事实——
  // 什么时候起的念头、派到了哪、那边动没动手。要不要追问、要不要重新派，
  // 仍然是她自己看着办（`qq_windows` read / 再派一次）。
  const dispatches = (store?.recentDispatches?.({ limit: 4, since: at - DAY }) ?? [])
    .filter((row) => row && String(row.instruction ?? '').trim());
  if (dispatches.length) {
    lines.push('', '【你派出去的事】');
    for (const row of dispatches) {
      const ago = agoLabel(row.updated_at || row.created_at, at);
      const when = ago === '刚刚' ? '刚刚' : `${ago}前`;
      const want = String(row.instruction).replace(/\s+/gu, ' ').trim();
      const wantText = want.length > 60 ? `${want.slice(0, 59)}…` : want;
      const state = DISPATCH_LABELS[row.state] ?? '还没有动静';
      const detail = row.result && row.state === 'done' ? `（${String(row.result).replace(/\s+/gu, ' ').trim()}）` : '';
      lines.push(`- ${when}，你想在${labelOf(row.conversation)}：「${wantText}」——${state}${detail}`);
    }
  }

  // 将来：她欠着的事。放在"做过的事"后面，是因为"还没做"比"做过了"更该被想起。
  // 到期的排前面；没到期的不藏着，只是标明"几号之后"，让她自己判断要不要现在提。
  const intents = (store?.openIntents?.({ before: at + DAY, limit: 8 }) ?? [])
    .filter((row) => row && String(row.text ?? '').trim());
  if (intents.length) {
    lines.push('', '【你还欠着的事】');
    // 拖太久的不悄悄自动清掉，也不替她判"过期"：只把那件事已经放了多久说出来。
    // 是继续惦记、还是就此放自己一马，仍然是她自己的一句话（`qq_intent drop`）。
    //
    // 2026-11-01 补上"多久之前记的"与"记在哪一间"：13:26 那轮她把 `group:946719566`
    // 上午的一句"全紫"拿到 `group:1033440455` 去问，两个群的人都莫名其妙——
    // 快照当时只告诉她"你还欠着这件事"，没告诉她这条债是两小时前的、本来属于别的屋子。
    const staleAfter = Math.max(1, Number(staleDays) || 14) * DAY;
    for (const row of intents) {
      const due = Number(row.due_at) || 0;
      const madeAt = Number(row.created_at) || 0;
      const overdue = due > 0 && due <= at ? at - due : 0;
      const age = overdue || (due > 0 ? 0 : Math.max(0, at - madeAt));
      const made = madeAt ? `${agoLabel(madeAt, at)}前记的` : '';
      const when = !due
        ? ''
        : due <= at
          ? '到时间了'
          : `${new Date(due).getMonth() + 1} 月 ${new Date(due).getDate()} 日之后提`;
      const held = age >= staleAfter ? `已经放了 ${Math.round(age / DAY)} 天，还惦记吗？` : '';
      const where = row.conversation ? ` → ${labelOf(row.conversation)}` : '';
      const notes = [made, when, held].filter(Boolean).join('；');
      lines.push(`- #${row.id} ${String(row.text).replace(/\s+/gu, ' ').trim()}${notes ? `（${notes}）` : ''}${where}`);
    }
  }

  const thoughts = (memory?.agent?.latest?.('self') ?? [])
    .filter((r) => !r.deleted && r.visibility === 'public' && isSelfModelSlot(r.slot))
    .slice(-3);
  if (thoughts.length) {
    lines.push('', '【你自己写下过的想法】');
    for (const r of thoughts) lines.push(`- ${String(r.text ?? '').replace(/\s+/gu, ' ').trim()}`);
  }

  lines.push('', '没有人在等你回答。要不要开口、开在哪、说什么，还是什么都不做——你自己定。');
  const text = lines.join('\n');
  const budget = Number(maxChars) > 0 ? Number(maxChars) : 900;
  return text.length <= budget ? text : `${text.slice(0, budget - 1)}…`;
}
