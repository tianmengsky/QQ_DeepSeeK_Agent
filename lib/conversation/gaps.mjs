function gapNoticeFor(store, conversation) {
  if (!store?.available || !conversation) return '';
  const state = store.getConversation(conversation);
  if (!state || !state.gapCount) return '';
  return (
    `这个会话（${conversation}）有约 ${state.gapCount} 条消息没被我接住` +
    `（原因：${state.gapNote || '未知'}）。\n` +
    '所以你对"刚才具体聊到哪"的记忆可能不连续 —— 别假装知道，' +
    '不确定就顺着当前这条说，或者直接问一句。'
  );
}

export { gapNoticeFor };
