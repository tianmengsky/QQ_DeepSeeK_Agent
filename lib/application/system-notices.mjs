import { isAllowed } from '../domain/admission.mjs';
import { qqTime } from '../conversation/context.mjs';

/**
 * 系统事件（notice）→ 会话窗口的一条「系统」条目。
 *
 * 背景：QQ 的禁言、头衔、进退群这类事件在 OneBot 上是
 * `post_type: 'notice'`，以前在 routes/onebot.mjs 里除了撤回、戳一戳、
 * 表情回应之外全部被 `return` 丢掉。后果是群里有人说"你被禁言了"
 * （纯文字玩笑），她没有任何依据判断真假——真实事件"你被群主禁言10分钟"
 * 根本进不了她的上下文。
 *
 * 设计取舍：
 * - **只进上下文，不触发回合。** 被禁言时本来就发不出话；头衔、精华这类
 *   事件也不值得打断别人聊天。它们在下一轮被接纳的消息里作为背景可见即可。
 * - 命名尽量用"你/她"：`user_id` 等于自己（selfIds）时说"你"，否则报 QQ 号。
 *   OneBot 的 notice 只有号码没有昵称，为一条背景信息不值得再打一次 API。
 * - `qq` 留空：recordContext 只在 `qq` 非空时更新 recentQqs，
 *   系统事件不算"最近说话的人"。
 * - 不进记忆抽取（extractor.observe 不调用）：禁言十分钟不是长期事实。
 */

const HONOR_NAMES = {
  talkative: '龙王',
  performer: '群聊之火',
  emotion: '快乐源泉',
};

function durationText(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n % 60 === 0 ? `${n / 60} 分钟` : `${n} 秒`;
}

/**
 * 把一条 notice 事件渲染成一句系统文案；不认识的事件返回 null。
 *
 * @param {object} event OneBot notice 事件
 * @param {string[]} selfIds 配置里的 selfIds（event.self_id 兜底）
 */
export function renderSystemNoticeText(event, selfIds = []) {
  if (!event || typeof event !== 'object') return null;
  const known = [event.self_id, ...selfIds].filter((x) => x != null).map(String);
  const isSelf = (id) => id != null && known.includes(String(id));
  const nameOf = (id) => (isSelf(id) ? '你' : `QQ ${id}`);
  switch (event.notice_type) {
    case 'group_ban': {
      const who = nameOf(event.user_id);
      if (event.sub_type === 'ban') {
        const dur = durationText(event.duration);
        return dur ? `${who}被禁言 ${dur}` : `${who}被禁言`;
      }
      if (event.sub_type === 'lift_ban') return `${who}被解除禁言`;
      return null;
    }
    case 'group_increase':
      if (['approve', 'invite'].includes(event.sub_type))
        return `${nameOf(event.user_id)}加入了群聊`;
      return null;
    case 'group_decrease':
      if (event.sub_type === 'leave') return `${nameOf(event.user_id)}退出了群聊`;
      if (event.sub_type === 'kick') return `${nameOf(event.user_id)}被移出了群聊`;
      if (event.sub_type === 'kick_me') return `你被移出了群聊`;
      return null;
    case 'group_admin':
      if (event.sub_type === 'set') return `${nameOf(event.user_id)}成为了管理员`;
      if (event.sub_type === 'unset') return `${nameOf(event.user_id)}不再是管理员`;
      return null;
    case 'honor': {
      if (!event.sub_type) return null;
      const title = HONOR_NAMES[event.sub_type] ?? event.sub_type;
      return `${nameOf(event.user_id)}获得了群荣誉「${title}」`;
    }
    case 'essence':
      if (event.sub_type === 'add') return `消息 ${event.message_id ?? '?'} 被设为精华`;
      if (event.sub_type === 'delete') return `消息 ${event.message_id ?? '?'} 被移出精华`;
      return null;
    case 'notify':
      if (event.sub_type === 'lucky_king') return `${nameOf(event.user_id)}成了红包运气王`;
      return null;
    default:
      return null;
  }
}

/**
 * 消费一条 notice 事件：白名单内的会话，把系统文案写进滑动窗口。
 *
 * 永不触发回合、不刷新唤醒窗口、不进记忆——只是让"下一轮"看得见。
 *
 * @returns 是否真的写了一条
 */
export async function handleSystemNotice(ctx, config, event, state, stats, store, registry) {
  if (config.systemNoticesEnabled === false) return false;
  if (!registry || state?.disposed) return false;
  const text = renderSystemNoticeText(event, config.selfIds ?? []);
  if (!text) return false;
  const key = event.group_id != null
    ? 'group:' + event.group_id
    : event.user_id != null ? 'user:' + event.user_id : null;
  if (!key) return false;
  const allowed = event.group_id != null
    ? config.groupEnabled && isAllowed(config.groups, event.group_id)
    : config.privateEnabled && isAllowed(config.users, event.user_id);
  if (!allowed) return false;
  const entry = registry.entry(key);
  registry.record(entry, {
    source: 'qq',
    qq: '',
    who: '系统',
    text,
    messageId: null,
    at: qqTime(event.time) || Date.now(),
    timeSource: 'qq',
    images: [],
    forwards: [],
  });
  registry.persist(key);
  stats.systemNotices = (stats.systemNotices ?? 0) + 1;
  ctx?.logger?.info?.(`qq-bridge: 系统事件入上下文 —— ${key} ${text}`);
  return true;
}
