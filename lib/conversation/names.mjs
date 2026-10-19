import { onebotCall } from '../transport/onebot-client.mjs';

/**
 * QQ 号 → 昵称。
 *
 * 为什么需要它：OneBot 的 at 段通常只有 QQ 号，没有可靠的昵称，
 * 所以光靠事件本身无法确定“@ 的是谁”。这也是判断
 * 「这句话是说给我听的，还是说给天梦听、我只是被顺带 @ 到」的唯一依据。
 *
 * 三个来源，按便宜到贵：
 *   ① 滑动窗口里说过的每个人（免费，已经带着 who）
 *   ② 当前发言人（事件里就有昵称/群名片）
 *   ③ get_group_member_list（一次 HTTP，按群缓存 TTL）
 *
 * ③ 失败不影响发言：昵称退化成 QQ 号，提示词照样能拼出来。
 */
const cache = new Map();

function pickName(member) {
  return String(member?.card ?? '').trim() || String(member?.nickname ?? '').trim() || '';
}

function clearNameCache() {
  cache.clear();
}

/**
 * 最近一次 `get_group_member_list` 的结果（QQ 号 → 昵称），用来回答
 * "这个人到底在不在群里"。
 *
 * 为什么需要：OneBot 对解析不出 UID 的 at 段会**整条消息退回**
 * （实测 `retcode=100 failed to resolve UID for UIN …`），群里连正文都看不到，
 * 而且这条计划还会每 30 秒重试、把该会话后面的回复一起挡住。
 *
 * 返回 `null` = 不知道 —— 调用方必须放行。宁可漏拦，也不能凭一份旧名单
 * 拦掉真成员。超过 `maxAgeMs` 的名单一律当不知道（默认 30 分钟）。
 */
const MEMBER_LIST_MAX_AGE_MS = 30 * 60 * 1000;

function cachedGroupMembers(groupId, maxAgeMs = MEMBER_LIST_MAX_AGE_MS) {
  if (groupId == null) return null;
  const hit = cache.get(String(groupId));
  if (!hit?.ids?.size) return null;
  if (maxAgeMs > 0 && Date.now() - hit.at > maxAgeMs) return null;
  return hit.ids;
}

/**
 * 同一份缓存里的"昵称 → QQ 号"（`[@昵称]` 解析用）。
 *
 * 和 `cachedGroupMembers` 分开返回：那个回答"在不在群里"，这个回答"叫这个名字的是谁"。
 * 有昵称的成员才在里面 —— 重名由调用方判断，本函数只给事实。
 */
function cachedGroupMemberNames(groupId, maxAgeMs = MEMBER_LIST_MAX_AGE_MS) {
  if (groupId == null) return null;
  const hit = cache.get(String(groupId));
  if (!hit?.names?.size) return null;
  if (maxAgeMs > 0 && Date.now() - hit.at > maxAgeMs) return null;
  return hit.names;
}

async function buildNameMap(config, event, { ctx, stats, windowMessages } = {}) {
  const names = new Map();
  const add = (qq, name) => {
    const key = String(qq ?? '').trim();
    const value = String(name ?? '').trim();
    if (key && value && !names.has(key)) names.set(key, value);
  };

  for (const message of windowMessages ?? []) {
    if (message?.qq && !message.bot) add(message.qq, message.who);
  }
  const speaker = event?.sender?.card || event?.sender?.nickname;
  if (speaker) add(event?.user_id, speaker);

  if (config?.resolveAtNames === false) return names;
  if (event?.message_type !== 'group' || event.group_id == null) return names;

  const groupId = String(event.group_id);
  const ttl = Math.max(0, Number(config?.groupMemberCacheMs) || 0);
  const hit = cache.get(groupId);
  if (hit && Date.now() - hit.at < ttl) {
    for (const [qq, name] of hit.names) if (!names.has(qq)) names.set(qq, name);
    return names;
  }

  const fresh = await refreshGroupMembers(config, groupId, { ctx, stats });
  for (const [qq, name] of fresh) if (!names.has(qq)) names.set(qq, name);
  return names;
}

/**
 * 拉一次群成员表并进缓存，返回 QQ 号 → 昵称。
 *
 * 抽出来是为了让**重试路径**也能拿到名单：一条已经落库、正在重试的回复
 * 发现不了"@ 的人不在群里"（缓存早被重载清空），就会一直重试失败、
 * 把这个会话后面的回复一起挡住。恢复流程在重试前调它一次即可自愈。
 * 失败返回空 Map，调用方（`cachedGroupMembers` 返回 null）自然放行。
 */
async function refreshGroupMembers(config, groupId, { ctx, stats } = {}) {
  const fresh = new Map();
  try {
    const list = await onebotCall(config, 'get_group_member_list', {
      group_id: Number(groupId),
    });
    /**
     * 成员号单独存一份，**不要求有昵称**：`[@:QQ号]` 的校验只关心"在不在群里"，
     * 而昵称为空的成员（没设昵称、或用的是别的字段）也可能是真成员 ——
     * 拿昵称表当成员表用会把这类人误判成"不在群里"，从而白白丢掉一个有效的 @。
     */
    const ids = new Set();
    for (const member of Array.isArray(list) ? list : []) {
      if (member?.user_id == null) continue;
      ids.add(String(member.user_id));
      const name = pickName(member);
      if (name) fresh.set(String(member.user_id), name);
    }
    if (ids.size) cache.set(String(groupId), { at: Date.now(), names: fresh, ids });
  } catch (error) {
    if (stats) stats.nameLookupFailed = (stats.nameLookupFailed ?? 0) + 1;
    ctx?.logger?.warn?.(
      `qq-bridge: 取群 ${groupId} 成员昵称失败，@ 只能显示 QQ 号 —— ${error?.message ?? error}`,
    );
  }
  return fresh;
}

export {
  buildNameMap,
  clearNameCache,
  cachedGroupMembers,
  cachedGroupMemberNames,
  refreshGroupMembers,
  pickName,
};
