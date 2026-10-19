/** Read the opening history back to the saved pre-prompt cursor; never guess a turn. */
export async function replayFrames(controller, snapshot, address, baseSeq, signal) {
  let records = snapshot.records ?? [];
  let hasMore = snapshot.hasMore;
  while (hasMore && (!records.length || records[0].event.seq > baseSeq + 1)) {
    if (!controller.page || !records.length) throw new Error('DSH reply recovery: history gap');
    const beforeSeq = records[0].event.seq;
    const page = await controller.page({ address, throughSeq: snapshot.cursor,
      beforeSeq, maxMessages: 100 }, signal);
    if (!page.records?.length || page.records[0].event.seq >= beforeSeq)
      throw new Error('DSH reply recovery: history pagination did not advance');
    records = [...page.records, ...records];
    hasMore = page.hasMore;
  }
  const frames = records.filter((r) => r.type === 'event' && r.event.seq > baseSeq);
  let next = baseSeq + 1;
  for (const frame of frames) {
    if (frame.event.seq !== next++) throw new Error('DSH reply recovery: non-contiguous history');
  }
  if (next - 1 !== snapshot.cursor) throw new Error('DSH reply recovery: incomplete snapshot');
  return frames;
}
