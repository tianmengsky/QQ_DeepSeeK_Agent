/**
 * 世界快照——给她一个"不在任何房间里"的视角。
 *
 * 为什么需要这一层：她的每个回合都发生在某个窗口里，注入的上下文全是那个房间
 * 最近的消息。于是"要不要主动做点什么"这个决定，其实是被那间屋子的气氛推着
 * 做的：群 A 正热闹，她就想说话；群 B 冷清，她就以为世界冷清。
 *
 * 快照不是更多的记忆，是**一次换视角**：把各窗口的动静压成几行、加上她最近
 * 做过什么、现在什么心情、手上有哪些想法，然后交给她自己判断。它只描述世界，
 * 不列任务、不写"你该做什么"。
 *
 * 数字在这里是允许的：这份文本只进脊柱（她自己的地方），不会被贴进任何群。
 * 注入房间的文本另有脱敏规矩。
 */
import { localStamp, WEEKDAYS } from '../domain/time.mjs';
import { readMood } from '../memory/mood.mjs';
import { isSelfModelSlot } from '../memory/agent-memory.mjs';

const DAY = 86400000;
const KIND_LABELS = { group: '群', user: '私聊' };
const ACTION_LABELS = { speak: '说了一句话', bili_share: '分享了一个视频', turn: '在自己时间里待了一会儿' };

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
 * @param {number}  [options.now]   现在（测试用）
 * @param {number}  [options.maxWindows] 最多列几个窗口
 * @param {number}  [options.maxChars]   总预算，超了截断
 */
export function buildWorldSnapshot({ store, memory, now = Date.now(), maxWindows = 6, maxChars = 900 } = {}) {
  const at = Number(now) || Date.now();
  const date = new Date(at);
  const lines = [];
  lines.push(`现在是 ${localStamp(date)}，周${WEEKDAYS[date.getDay()]}。你不在任何一个房间里——这是你自己的地方。`);

  const windows = (store?.listConversations?.({ since: at - 7 * DAY, limit: 20 }) ?? [])
    .filter((row) => row && row.last_message_at > 0)
    .slice(0, Math.max(1, Number(maxWindows) || 6));
  if (windows.length) {
    lines.push('', '【各窗口最近的动静】');
    for (const row of windows) {
      const quiet = agoLabel(row.last_message_at, at);
      const spoke = Number(row.last_spoke_at) > 0
        ? `你最后一次说话是 ${agoLabel(row.last_spoke_at, at)}前`
        : '你还没在那边说过话';
      lines.push(`- ${labelOf(row.conversation)}：${quiet}前有人说话；${spoke}`);
    }
  } else {
    lines.push('', '【各窗口最近的动静】', '- 这一周没有任何窗口在说话。');
  }

  const actions = (store?.proactiveRecent?.({ limit: 5 }) ?? [])
    .filter((row) => row && String(row.status ?? '') === 'sent')
    .slice(0, 4);
  if (actions.length) {
    lines.push('', '【你最近自己做过的事】');
    for (const row of actions) {
      const outcome = row.outcome === 'replied' ? '有人接了' : row.outcome === 'quiet' ? '没人接' : '还没回音';
      lines.push(`- ${agoLabel(row.created_at, at)}前，在${labelOf(row.conversation)}${ACTION_LABELS[row.kind] ?? '做了点什么'}（${outcome}）`);
    }
  }

  const mood = readMood(store);
  if (mood?.text) lines.push('', `【你此刻的心情】${mood.text}`);

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
