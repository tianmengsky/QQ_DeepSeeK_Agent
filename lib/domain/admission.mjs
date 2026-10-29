import { renderMessage, mentionsBot, mentionsName } from './events.mjs';
export function isAllowed(list = [], id) {
  return list.length === 0 || list.map(String).includes(String(id));
}
export function admitMessage(config, event) {
  if (!event || !event.user_id || !['group', 'private'].includes(event.message_type)) return false;
  const sender = String(event.user_id);
  const selfIds = [event.self_id, ...(config.selfIds ?? [])].filter((x) => x != null).map(String);
  if (selfIds.includes(sender)) return false;
  if (event.__bridgeSource === 'bili') return true;
  return event.message_type === 'group'
    ? config.groupEnabled && event.group_id != null && isAllowed(config.groups, event.group_id)
    : config.privateEnabled && isAllowed(config.users, event.user_id);
}
export function shouldRespond(config, event) {
  if (!admitMessage(config, event)) return false;
  if (event.__poke || event.message_type === 'private') return true;
  if (config.groupTrigger === 'all') return true;
  if (config.groupTrigger === 'prefix')
    return (
      Boolean(config.groupPrefix) &&
      renderMessage(event.message).trimStart().startsWith(config.groupPrefix)
    );
  return (
    mentionsBot(
      event.message,
      config.selfIds?.length ? config.selfIds.map(String) : [String(event.self_id)],
    ) || mentionsName(event.message, config.nameTriggers)
  );
}
