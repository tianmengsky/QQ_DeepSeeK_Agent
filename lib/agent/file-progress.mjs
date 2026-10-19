/** Keep actual qq_say progress receipts for the floor and diagnostics. File access is independent. */
const prefix = 'qq-bridge:file-progress:';

export function recordFileProgress(bridgeStore, sendStore, origin, receipt) {
  if (!origin || receipt?.status !== 'SUCCEEDED' || receipt.dryRun || receipt.replayed) return false;
  const sent = sendStore?.getReceipt?.(receipt.id);
  if (sent?.status !== 'SUCCEEDED' || sent.conversation !== origin.conversation
    || !Number.isFinite(receipt.sentAt) || receipt.sentAt < origin.created_at) return false;
  return bridgeStore?.setState(prefix + origin.ref, JSON.stringify({
    conversation: origin.conversation, id: receipt.id, at: receipt.sentAt,
  })) ?? false;
}

