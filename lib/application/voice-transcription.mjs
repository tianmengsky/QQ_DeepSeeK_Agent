import { onebotCall } from '../transport/onebot-client.mjs';
import { renderMessage } from '../domain/events.mjs';

/** Start QQ-native transcription without delaying OneBot acknowledgement or input batching. */
export function transcribeIncomingVoice(config, event, registry, key, stats, logger, signal) {
  if (config.voiceTranscriptionEnabled === false || !Array.isArray(event.message) ||
      !event.message.some((s) => s?.type === 'record') || event.message_id == null) return;
  const id = String(event.message_id);
  const promise = (async () => {
    try {
      // SnowLuma waits for QQ's asynchronous recognition push (up to 20 seconds).
      const result = await onebotCall(config, 'fetch_ptt_text', { message_id: event.message_id }, 25000, signal);
      const text = typeof result?.text === 'string' ? result.text.trim().slice(0, 2000) : '';
      if (signal?.aborted) return;
      if (!text) throw new Error('QQ returned an empty voice transcript');
      const entry = registry.entry(key);
      if ((entry.recalledIds ?? []).includes(id)) return;
      for (const segment of event.message) {
        if (segment?.type === 'record') {
          segment.data = { ...segment.data, transcription: text };
          break;
        }
      }
      const rendered = renderMessage(event.message);
      for (const item of entry.window ?? [])
        if (!item.bot && String(item.messageId) === id) item.text = rendered;
      for (const item of [...(entry.pending ?? []), ...(entry.pendingContext ?? [])])
        if (String(item.messageId) === id) item.text = rendered;
      registry.persist(key);
      stats.voiceTranscribed = (stats.voiceTranscribed ?? 0) + 1;
    } catch (error) {
      if (!signal?.aborted) {
        const entry = registry.entry(key);
        if ((entry.recalledIds ?? []).includes(id)) return;
        for (const segment of event.message) {
          if (segment?.type === 'record') {
            segment.data = { ...segment.data, transcriptionStatus: 'failed' };
            delete segment.data.transcription;
          }
        }
        const rendered = renderMessage(event.message);
        for (const item of [...(entry.window ?? []), ...(entry.pending ?? []), ...(entry.pendingContext ?? [])])
          if (!item.bot && String(item.messageId) === id) item.text = rendered;
        registry.persist(key);
        stats.voiceTranscriptionFailed = (stats.voiceTranscriptionFailed ?? 0) + 1;
        stats.lastVoiceTranscriptionError = { conversation: key, messageId: id,
          detail: String(error?.message ?? error).slice(0, 500), at: Date.now() };
        logger.warn(`qq-bridge: 语音转写失败 (${key}, ${id}): ${error?.message ?? error}`);
      }
    }
  })();
  event.__voicePromise = promise;
}

export async function awaitIncomingVoices(events) {
  await Promise.all(events.map((event) => event.__voicePromise).filter(Boolean));
  for (const event of events) delete event.__voicePromise;
}
