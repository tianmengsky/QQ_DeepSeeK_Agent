import {
  renderMessage,
  mentionsBot,
  mentionsName,
  stripLeadingMention,
  atTargets,
  stripLeadingSelfMentions,
  decorateAtTokens,
} from './domain/events.mjs';
import { shouldRespond, isAllowed } from './domain/admission.mjs';
import { buildPrompt, buildMemorySection, fingerprint } from './prompt/render.mjs';
import {
  splitBubbles,
  bubbleDelayFor,
  parseShape,
  pickShape,
  extractStickerMarker,
  collapseRepeatedReply,
  extractRemember,
  extractAtMentions,
  atMarkerTokens,
  stripImageHallucination,
  isSilence,
  stripSilence,
  stripSyntheticPromptEcho,
  stripBridgeTags,
  extractMarkedBubbles,
  stripPlanningReply,
  resolveReplyBubbles,
  dedupeRepeatedBubbles,
} from './domain/reply-policy.mjs';
import { asksToLook, hasImageSegment } from './prompt/prepare.mjs';
import { localStamp, nowLine } from './domain/time.mjs';
import { MemoryStore } from './memory/memory-store.mjs';
import { ConversationRegistry } from './conversation/registry.mjs';
import { deliverReply, queueReply, planDelivery, mentionResolver } from './delivery/reply-delivery.mjs';
import { ConversationSendQueue } from './delivery/send-queue.mjs';
import { sendOnebotIdempotent } from './delivery/outbox.mjs';
import { loadStoreModule } from './transport/persistence.mjs';
import { handlePokeNotice, handleReactionNotice } from './application/notices.mjs';
import { handleAddRequest } from './application/requests.mjs';
import { gapNoticeFor } from './conversation/gaps.mjs';
import { buildNameMap, clearNameCache } from './conversation/names.mjs';
import {
  LoginWatch,
  classifyLoginProbe,
  loginIncidentReason,
  summarizeLoginHistory,
  loginSnapshot,
  probeLogin,
  readLoginEnvironment,
  readQqntVersion,
  findLoginCredential,
  describeEnvironment,
  compareEnvironment,
} from './application/login-watch.mjs';

const __test = {
  renderMessage,
  mentionsBot,
  mentionsName,
  stripLeadingMention,
  atTargets,
  stripLeadingSelfMentions,
  decorateAtTokens,
  shouldRespond,
  buildPrompt,
  buildMemorySection,
  isAllowed,
  splitBubbles,
  bubbleDelayFor,
  parseShape,
  pickShape,
  asksToLook,
  hasImageSegment,
  extractStickerMarker,
  collapseRepeatedReply,
  extractRemember,
  extractAtMentions,
  atMarkerTokens,
  stripImageHallucination,
  isSilence,
  stripSilence,
  stripSyntheticPromptEcho,
  stripBridgeTags,
  extractMarkedBubbles,
  stripPlanningReply,
  resolveReplyBubbles,
  dedupeRepeatedBubbles,
  fingerprint,
  localStamp,
  nowLine,
  MemoryStore,
  ConversationRegistry,
  deliverReply,
  queueReply,
  planDelivery,
  mentionResolver,
  ConversationSendQueue,
  sendOnebotIdempotent,
  loadStoreModule,
  handlePokeNotice,
  handleAddRequest,
  handleReactionNotice,
  gapNoticeFor,
  buildNameMap,
  clearNameCache,
  LoginWatch,
  classifyLoginProbe,
  loginIncidentReason,
  summarizeLoginHistory,
  loginSnapshot,
  probeLogin,
  readLoginEnvironment,
  readQqntVersion,
  findLoginCredential,
  describeEnvironment,
  compareEnvironment,
};

export { __test };
