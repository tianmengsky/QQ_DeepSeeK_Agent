import { onebotCall } from '../transport/onebot-client.mjs';
import { localStamp } from '../domain/time.mjs';
import { sendOnebotIdempotent } from '../delivery/outbox.mjs';

async function handleAddRequest(ctx, config, event, stats, store) {
  const kind = event.request_type === 'group' ? 'group' : 'friend';
  const flag = String(event.flag ?? '');
  if (!flag) return false;

  const senderId = String(event.user_id ?? '');
  const nickname = event.sender?.nickname ?? '';
  const groupId =
    event.group_id === undefined || event.group_id === null ? '' : String(event.group_id);
  const comment = String(event.comment ?? '');

  const rec = store?.recordRequest({
    flag,
    kind,
    subType: event.sub_type ?? '',
    userId: senderId,
    groupId,
    comment,
    nickname,
  });

  // OneBot 会重推，重复的只记一次、也只通知一次
  if (rec?.duplicate) {
    stats.requestDuplicates = (stats.requestDuplicates ?? 0) + 1;
    return true;
  }
  stats.requestsReceived = (stats.requestsReceived ?? 0) + 1;

  const where = kind === 'group' ? `群 ${groupId}` : '加好友';
  const who = nickname ? `${nickname}(${senderId})` : senderId;
  ctx.logger.info(
    `qq-bridge: 收到${kind === 'group' ? '入群' : '加好友'}申请 —— ${who} ${where}` +
      `${comment ? ` 附言：${comment}` : ''}`,
  );

  // 自动处理：默认关。开了也只做 reject，除非显式选 approve。
  let autoNote = '';
  if (config.autoHandleRequests) {
    const approve = config.autoHandleRequestAction === 'approve';
    try {
      await onebotCall(
        config,
        kind === 'friend' ? 'set_friend_add_request' : 'set_group_add_request',
        { flag, approve },
      );
      store?.resolveRequest(flag, kind, approve ? 'approved:auto' : 'rejected:auto');
      autoNote = `\n（已按 autoHandleRequests 自动${approve ? '同意' : '拒绝'}）`;
      stats.requestsAutoHandled = (stats.requestsAutoHandled ?? 0) + 1;
    } catch (error) {
      autoNote = `\n（自动处理失败：${error?.message ?? error}）`;
      ctx.logger.warn(`qq-bridge: 自动处理申请失败 —— ${error?.message ?? error}`);
    }
  }

  // 通知名单里的人。只走私聊，且只认名单。
  const allowed = (config.notifyUsers ?? []).map(String).filter(Boolean);
  for (const uid of allowed) {
    const body =
      `【${kind === 'group' ? '入群申请' : '加好友申请'}】\n` +
      `来自：${who}\n` +
      (kind === 'group' ? `目标群：${groupId}\n` : '') +
      (comment ? `附言：${comment}\n` : '') +
      `flag：${flag}\n` +
      `时间：${localStamp()}` +
      autoNote +
      (config.autoHandleRequests
        ? ''
        : '\n\n要在电脑上处理，或让 Agent 用 qq_handle_add_request。\n' +
          '⚠️ 同意加好友 = 让一个陌生人之后能给你这个 QQ 会话发消息。');
    try {
      await sendOnebotIdempotent(ctx, config, store, {
        idemKey: `req:${kind}:${flag}:${uid}`,
        conversation: `user:${uid}`,
        action: 'send_private_msg',
        target: { user_id: Number(uid) },
        message: body,
      });
      store?.markRequestNotified(flag, kind);
      stats.requestsNotified = (stats.requestsNotified ?? 0) + 1;
    } catch (error) {
      ctx.logger.warn(`qq-bridge: 转发申请给 ${uid} 失败 —— ${error?.message ?? error}`);
    }
  }

  if (!allowed.length) {
    ctx.logger.info(
      'qq-bridge: 没有配置 notifyUsers，这条申请只记进了数据库（可用 qq_list_add_requests 查）',
    );
  }
  return true;
}

export { handleAddRequest };
