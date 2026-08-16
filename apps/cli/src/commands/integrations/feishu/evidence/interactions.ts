// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：interactions。
import type { ExternalChannelBindingRecord, ExternalMessageMappingRecord, ExternalMessageOutboxRecord, ExternalThreadBindingRecord } from "@dofe-agent/db";
import { FEISHU_PROVIDER_ID } from "@dofe-agent/services";
import { hasNonEmptyString, hasFeishuExternalGuestNoWorkspaceMemberEvidence, hasFeishuSafeInboundMessageContext, hasFeishuMessageMappingAgentBotContext, readJsonRecord, readStringMetadata, readStringArrayMetadata, buildFeishuShortHash } from "./core.ts";
import { hasNoFeishuRawProviderIdentityContext, hasNoFeishuRawExternalLocationContext, hasNoFeishuRawDataOperationResourceContext } from "./failures.ts";
import { containsFeishuSecretLikeEvidence, containsRawFeishuOpenApiEvidenceIdentifier, isRecord } from "./proofs.ts";

export function countCorrelatedFeishuReplyMappings(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const inboundMappings = mappings.filter((mapping) => mapping.direction === "inbound");
  return mappings.filter((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const inbound = inboundMappings.find((candidate) =>
      candidate.externalMessageId === mapping.externalThreadId ||
      candidate.externalThreadId === mapping.externalThreadId
    );
    return Boolean(inbound && hasMatchingFeishuBotReplyMetadata(inbound, mapping));
  }).length;
}

export function countFeishuNativeBotReplyEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const inboundMappings = mappings.filter((mapping) => mapping.direction === "inbound");
  return mappings.filter((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const inbound = inboundMappings.find((candidate) =>
      candidate.externalMessageId === mapping.externalThreadId ||
      candidate.externalThreadId === mapping.externalThreadId
    );
    if (
      !inbound ||
      (inbound.channelBindingId && mapping.channelBindingId && inbound.channelBindingId !== mapping.channelBindingId)
    ) {
      return false;
    }
    if (!hasMatchingFeishuBotReplyMetadata(inbound, mapping)) {
      return false;
    }
    const outboundMetadata = readJsonRecord(mapping.metadataJson);
    if (!outboundMetadata) {
      return false;
    }
    const policyInput = isRecord(outboundMetadata.agentActionPolicyInput)
      ? outboundMetadata.agentActionPolicyInput
      : undefined;
    const action = isRecord(policyInput?.action) ? policyInput.action : undefined;
    return hasFeishuSafeBotReplyActionContext(action) &&
      hasNoFeishuRawExternalLocationContext(outboundMetadata) &&
      hasNoFeishuRawProviderIdentityContext(outboundMetadata);
  }).length;
}

export function hasFeishuSafeBotReplyActionContext(action: Record<string, unknown> | undefined): boolean {
  if (!action) {
    return false;
  }
  const serialized = JSON.stringify(action);
  return hasNonEmptyString(action.resourceReference) &&
    action.resourceIdRedacted === true &&
    !hasNonEmptyString(action.resourceId) &&
    hasNoFeishuRawDataOperationResourceContext(action) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}

export function hasMatchingFeishuBotReplyMetadata(
  inbound: ExternalMessageMappingRecord,
  outbound: ExternalMessageMappingRecord,
): boolean {
  if (outbound.direction !== "outbound" || !outbound.externalThreadId) {
    return false;
  }
  if (inbound.direction !== "inbound") {
    return false;
  }
  if (
    inbound.externalMessageId !== outbound.externalThreadId &&
    inbound.externalThreadId !== outbound.externalThreadId
  ) {
    return false;
  }
  if (inbound.channelBindingId && outbound.channelBindingId && inbound.channelBindingId !== outbound.channelBindingId) {
    return false;
  }
  const inboundMetadata = readJsonRecord(inbound.metadataJson);
  const outboundMetadata = readJsonRecord(outbound.metadataJson);
  return inboundMetadata?.provider === FEISHU_PROVIDER_ID &&
    outboundMetadata?.provider === FEISHU_PROVIDER_ID &&
    hasFeishuMessageMappingAgentBotContext(inbound, inboundMetadata) &&
    hasFeishuMessageMappingAgentBotContext(outbound, outboundMetadata) &&
    hasFeishuSafeBotReplyMappingContext(inboundMetadata) &&
    outboundMetadata.agentId === inboundMetadata.agentId &&
    outboundMetadata.botBindingId === inboundMetadata.botBindingId &&
    hasFeishuSafeBotReplyMappingContext(outboundMetadata);
}

export function hasFeishuSafeBotReplyMappingContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return hasFeishuSafeBotReplyMetadataContext(metadata);
}

export function hasFeishuSafeBotReplyMetadataContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  if (!hasFeishuSafeInboundMessageContext(metadata)) {
    return false;
  }
  const serialized = JSON.stringify(metadata);
  return hasNoFeishuRawDataOperationResourceContext(metadata) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}

export function hasNoFeishuUnsafeSerializedEvidenceContext(metadata: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(metadata);
  return hasNoFeishuRawDataOperationResourceContext(metadata) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}

export function countFeishuAgentBotRouteEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "sent" &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      metadata.agentBotMentioned === true &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata);
  }).length;
}

export function countFeishuNativeActorMentionEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  actorType: "user" | "external_guest",
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.dispatchStatus !== "sent" ||
      !hasFeishuSafeInboundMessageContext(metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      metadata.agentBotMentioned !== true ||
      metadata.actorType !== actorType ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata)
    ) {
      return false;
    }
    if (actorType === "external_guest") {
      return typeof metadata.externalGuestReference === "string" &&
        metadata.externalGuestReference.trim().length > 0 &&
        metadata.externalGuestPermissionProfile === "channel_context_only" &&
        hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata);
    }
    return typeof metadata.actorUserId === "string" &&
      metadata.actorUserId.trim().length > 0 &&
      hasNoFeishuRawProviderIdentityContext(metadata);
  }).length;
}

export function countFeishuAgentChannelPolicyDeniedEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const policyDenialReasonCodes = new Set([
    "feishu_agent_not_enabled_in_channel",
    "feishu_agent_channel_member_access_disabled",
    "feishu_agent_unavailable_to_actor",
    "feishu_agent_runtime_unavailable",
    "feishu_agent_runtime_unavailable_to_actor",
  ]);
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode : undefined;
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "ignored" &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      metadata.agentBotMentioned === true &&
      Boolean(reasonCode && policyDenialReasonCodes.has(reasonCode)) &&
      !hasFeishuCorrelatedOutboundReply(mappings, mapping);
  }).length;
}

export function hasFeishuCorrelatedOutboundReply(
  mappings: readonly ExternalMessageMappingRecord[],
  inbound: ExternalMessageMappingRecord,
): boolean {
  return mappings.some((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const matchesInboundMessage = mapping.externalThreadId === inbound.externalMessageId;
    const matchesInboundThread = Boolean(inbound.externalThreadId) &&
      mapping.externalThreadId === inbound.externalThreadId;
    if (!matchesInboundMessage && !matchesInboundThread) {
      return false;
    }
    return !inbound.channelBindingId ||
      !mapping.channelBindingId ||
      inbound.channelBindingId === mapping.channelBindingId;
  });
}

export function hasNoFeishuDofeAgentCommandRoute(metadata: Record<string, unknown>): boolean {
  if (
    metadata.dofeAgentCommandUsed === true ||
    metadata.routeCommandUsed === true ||
    metadata.slashCommandUsed === true ||
    metadata.agentCommandUsed === true
  ) {
    return false;
  }
  return !containsFeishuDofeAgentCommandSummary(metadata);
}

export function containsFeishuDofeAgentCommandSummary(metadata: Record<string, unknown>): boolean {
  const textFields = [
    "text",
    "messageText",
    "messageSummary",
    "textSummary",
    "textPreview",
    "contentPreview",
    "safeText",
    "safeTextPreview",
    "normalizedText",
  ];
  return textFields.some((field) => {
    const value = metadata[field];
    return typeof value === "string" && /(^|\s)\/agent(?:\s|$)/i.test(value.trim());
  });
}

export function countFeishuBotSenderLoopGuardEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "ignored" &&
      metadata.reasonCode === "feishu_bot_sender_ignored" &&
      metadata.agentBotMentioned === false &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      !hasFeishuCorrelatedOutboundReply(mappings, mapping);
  }).length;
}

export function countFeishuExternalGuestPolicyEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  input: {
    decision: "allow" | "ignore" | "require_identity";
    dispatchStatus: "sent" | "ignored";
    reasonCode?: string;
    unboundUserMode?: string;
    expectedPermissionProfile?: string;
    agentBotMentioned?: boolean;
    requireDispatchEvidence?: boolean;
    requireNoDispatchEvidence?: boolean;
    requireNoOutboundReply?: boolean;
  },
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound") {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.actorType !== "external_guest" ||
      metadata.dispatchStatus !== input.dispatchStatus ||
      metadata.externalGuestPolicyDecision !== input.decision ||
      typeof metadata.externalGuestReference !== "string" ||
      metadata.externalGuestReference.trim().length === 0 ||
      !hasFeishuSafeInboundMessageContext(metadata) ||
      typeof metadata.externalGuestPermissionProfile !== "string" ||
      metadata.externalGuestPermissionProfile.trim().length === 0 ||
      !hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata)
    ) {
      return false;
    }
    if (input.requireDispatchEvidence && (!mapping.taskQueueId || !mapping.dofeAgentMessageId)) {
      return false;
    }
    if (input.requireNoDispatchEvidence && (mapping.taskQueueId || mapping.dofeAgentMessageId)) {
      return false;
    }
    if (input.requireNoOutboundReply && hasFeishuCorrelatedOutboundReply(mappings, mapping)) {
      return false;
    }
    if (input.reasonCode && metadata.externalGuestPolicyReasonCode !== input.reasonCode) {
      return false;
    }
    if (input.unboundUserMode && metadata.externalGuestUnboundUserMode !== input.unboundUserMode) {
      return false;
    }
    if (input.expectedPermissionProfile && metadata.externalGuestPermissionProfile !== input.expectedPermissionProfile) {
      return false;
    }
    if (input.agentBotMentioned !== undefined && metadata.agentBotMentioned !== input.agentBotMentioned) {
      return false;
    }
    return true;
  }).length;
}

export function countFeishuExternalGuestReplyAllEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.actorType === "external_guest" &&
      metadata.dispatchStatus === "sent" &&
      metadata.externalGuestPolicyDecision === "allow" &&
      metadata.externalGuestPolicyReasonCode === "feishu_external_guest_allowed" &&
      metadata.externalGuestUnboundUserMode === "reply_all" &&
      metadata.agentBotMentioned === false &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      typeof metadata.externalGuestReference === "string" &&
      metadata.externalGuestReference.trim().length > 0 &&
      metadata.externalGuestPermissionProfile === "channel_context_only" &&
      hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata);
  }).length;
}

export function countFeishuIdentityBindingNoticeEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  outbox: readonly ExternalMessageOutboxRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.actorType !== "external_guest" ||
      metadata.dispatchStatus !== "ignored" ||
      metadata.externalGuestPolicyDecision !== "require_identity" ||
      metadata.externalGuestPolicyReasonCode !== "feishu_external_guest_identity_required" ||
      metadata.externalGuestUnboundUserMode !== "require_identity" ||
      metadata.agentBotMentioned !== true ||
      !hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      !hasFeishuSafeInboundMessageContext(metadata)
    ) {
      return false;
    }
    return outbox.some((item) => hasMatchingFeishuIdentityBindingNotice(item, mapping, metadata));
  }).length;
}

export function hasMatchingFeishuIdentityBindingNotice(
  item: ExternalMessageOutboxRecord,
  mapping: ExternalMessageMappingRecord,
  inboundMetadata: Record<string, unknown>,
): boolean {
  if (item.status !== "sent" || item.integrationId !== mapping.integrationId || !hasNonEmptyString(item.sentAt)) {
    return false;
  }
  if (!mapping.channelBindingId || item.channelBindingId !== mapping.channelBindingId) {
    return false;
  }
  const replyTargetExternalId = mapping.externalThreadId || mapping.externalMessageId;
  if (!hasNonEmptyString(replyTargetExternalId) || item.targetExternalThreadId !== replyTargetExternalId) {
    return false;
  }
  const metadata = readJsonRecord(item.metadataJson);
  const replyTargetReference = buildFeishuShortHash(replyTargetExternalId);
  return metadata?.provider === FEISHU_PROVIDER_ID &&
    metadata.noticeType === "identity_binding_required" &&
    metadata.noticeSource === "external_guest_policy" &&
    metadata.reasonCode === "feishu_external_guest_identity_required" &&
    metadata.actorType === "external_guest" &&
    metadata.agentId === inboundMetadata.agentId &&
    metadata.botBindingId === inboundMetadata.botBindingId &&
    metadata.externalGuestReference === inboundMetadata.externalGuestReference &&
    metadata.externalGuestPermissionProfile === "none" &&
    metadata.externalChatReference === inboundMetadata.externalChatReference &&
    metadata.externalThreadReference === replyTargetReference &&
    hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}

export function countFeishuAutoProvisionedChannelBindings(
  bindings: readonly ExternalChannelBindingRecord[],
  provisionSource?: "bot_added" | "first_message",
): number {
  return bindings.filter((binding) => {
    if (binding.status !== "active") {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const source = typeof metadata?.provisionSource === "string" ? metadata.provisionSource : undefined;
    if (provisionSource ? source !== provisionSource : source !== "bot_added" && source !== "first_message") {
      return false;
    }
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      hasFeishuAutoProvisionedChannelIdentity(binding, metadata);
  }).length;
}

export function countFeishuReusedProviderChannelBindings(
  bindings: readonly ExternalChannelBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.status !== "active") {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const bindingId = binding.id.trim();
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    const linkedFromAgentId = hasNonEmptyString(metadata?.linkedFromAgentId)
      ? metadata.linkedFromAgentId.trim()
      : "";
    const linkedFromBotBindingId = hasNonEmptyString(metadata?.linkedFromBotBindingId)
      ? metadata.linkedFromBotBindingId.trim()
      : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.provisionSource === "bot_added" &&
      hasFeishuAutoProvisionedChannelIdentity(binding, metadata) &&
      typeof metadata.linkedFromBindingId === "string" &&
      metadata.linkedFromBindingId.trim().length > 0 &&
      metadata.linkedFromBindingId.trim() !== bindingId &&
      agentId.length > 0 &&
      botBindingId === binding.integrationId &&
      linkedFromAgentId.length > 0 &&
      linkedFromAgentId !== agentId &&
      linkedFromBotBindingId.length > 0 &&
      linkedFromBotBindingId !== botBindingId &&
      typeof metadata.externalChatReference === "string" &&
      metadata.externalChatReference.trim().length > 0;
  }).length;
}

export function hasFeishuAutoProvisionedChannelIdentity(
  binding: ExternalChannelBindingRecord,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return hasNonEmptyString(binding.id) &&
    hasNonEmptyString(binding.integrationId) &&
    hasNonEmptyString(binding.channelName) &&
    hasNonEmptyString(binding.externalChatId) &&
    hasFeishuSafeAutoProvisionMetadata(metadata) &&
    hasFeishuAutoProvisionedAgentBotContext(binding, metadata);
}

export function hasFeishuSafeAutoProvisionMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    isFeishuAutoProvisionReviewStatus(metadata.reviewStatus) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}

export function hasFeishuAutoProvisionedAgentBotContext(
  binding: ExternalChannelBindingRecord,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return hasNonEmptyString(metadata?.agentId) &&
    readStringMetadata(metadata?.botBindingId) === binding.integrationId;
}

export function isFeishuAutoProvisionReviewStatus(value: unknown): boolean {
  return value === "approved" ||
    value === "pending_admin_review" ||
    value === "needs_identity_binding";
}

export function countFeishuThreadTaskBindingEvidence(
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.provider !== FEISHU_PROVIDER_ID || binding.status !== "active") {
      return false;
    }
    if (!binding.taskQueueId || !binding.dofeAgentMessageId || !binding.agentId) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      agentId.length > 0 &&
      binding.agentId.trim() === agentId &&
      botBindingId.length > 0 &&
      botBindingId === binding.integrationId &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  }).length;
}

export function countFeishuThreadContinuationEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.dispatchStatus !== "sent" ||
      metadata.threadContinuation !== true ||
      metadata.agentBotMentioned !== false ||
      typeof metadata.threadBindingId !== "string" ||
      metadata.threadBindingId.trim().length === 0 ||
      typeof metadata.agentId !== "string" ||
      metadata.agentId.trim().length === 0 ||
      typeof metadata.botBindingId !== "string" ||
      metadata.botBindingId.trim().length === 0 ||
      !hasFeishuSafeThreadEvidenceContext(metadata)
    ) {
      return false;
    }
    return hasMatchingFeishuThreadContinuationBinding(mapping, bindings, {
      threadBindingId: metadata.threadBindingId.trim(),
      agentId: metadata.agentId.trim(),
      botBindingId: metadata.botBindingId.trim(),
    });
  }).length;
}

export function hasMatchingFeishuThreadContinuationBinding(
  mapping: ExternalMessageMappingRecord,
  bindings: readonly ExternalThreadBindingRecord[],
  expected: {
    threadBindingId: string;
    agentId: string;
    botBindingId: string;
  },
): boolean {
  return bindings.some((binding) => {
    if (
      binding.id !== expected.threadBindingId ||
      binding.provider !== FEISHU_PROVIDER_ID ||
      binding.status !== "active" ||
      binding.integrationId !== mapping.integrationId ||
      binding.channelBindingId !== mapping.channelBindingId ||
      binding.taskQueueId !== mapping.taskQueueId ||
      binding.dofeAgentMessageId !== mapping.dofeAgentMessageId ||
      expected.botBindingId !== binding.integrationId ||
      !binding.agentId ||
      binding.agentId.trim() !== expected.agentId
    ) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.agentId === expected.agentId &&
      metadata.botBindingId === expected.botBindingId &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  });
}

export function countFeishuThreadCollaborationEvidence(
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.provider !== FEISHU_PROVIDER_ID || binding.status !== "active") {
      return false;
    }
    if (!binding.taskQueueId || !binding.dofeAgentMessageId || !binding.agentId) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.threadCollaboration === true &&
      agentId.length > 0 &&
      binding.agentId.trim() === agentId &&
      botBindingId.length > 0 &&
      botBindingId === binding.integrationId &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingAgentIds, agentId) &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingBotBindingIds, botBindingId) &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  }).length;
}

export function countFeishuThreadCollaborationCardEvidence(
  outbox: readonly ExternalMessageOutboxRecord[],
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return outbox.filter((item) => {
    if (item.status !== "sent" || !hasNonEmptyString(item.sentAt)) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    const externalChatReference = readStringMetadata(metadata?.externalChatReference);
    const externalThreadReference = readStringMetadata(metadata?.externalThreadReference);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.noticeType === "thread_collaboration" &&
      metadata.noticeSource === "native_agent_bot" &&
      agentId.length > 0 &&
      botBindingId.length > 0 &&
      botBindingId === item.integrationId &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingAgentIds, agentId) &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingBotBindingIds, botBindingId) &&
      externalChatReference !== undefined &&
      externalThreadReference !== undefined &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      hasNoFeishuUnsafeSerializedEvidenceContext(metadata) &&
      hasMatchingFeishuThreadCollaborationBindingForCard(bindings, {
        integrationId: item.integrationId,
        agentId,
        botBindingId,
        externalChatReference,
        externalThreadReference,
        collaboratingAgentIds: metadata.collaboratingAgentIds,
        collaboratingBotBindingIds: metadata.collaboratingBotBindingIds,
      });
  }).length;
}

export function hasMatchingFeishuThreadCollaborationBindingForCard(
  bindings: readonly ExternalThreadBindingRecord[],
  expected: {
    integrationId: string;
    agentId: string;
    botBindingId: string;
    externalChatReference: string;
    externalThreadReference: string;
    collaboratingAgentIds: unknown;
    collaboratingBotBindingIds: unknown;
  },
): boolean {
  const expectedCollaboratingAgentIds = readStringArrayMetadata(expected.collaboratingAgentIds)
    .filter((agentId) => agentId !== expected.agentId);
  const expectedCollaboratingBotBindingIds = readStringArrayMetadata(expected.collaboratingBotBindingIds)
    .filter((botBindingId) => botBindingId !== expected.botBindingId);
  if (expectedCollaboratingAgentIds.length === 0 || expectedCollaboratingBotBindingIds.length === 0) {
    return false;
  }

  return bindings.some((binding) => {
    if (
      binding.provider !== FEISHU_PROVIDER_ID ||
      binding.status !== "active" ||
      binding.integrationId !== expected.integrationId ||
      !binding.taskQueueId ||
      !binding.dofeAgentMessageId ||
      !binding.agentId ||
      binding.agentId.trim() !== expected.agentId
    ) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.threadCollaboration !== true ||
      agentId !== expected.agentId ||
      botBindingId !== expected.botBindingId ||
      botBindingId !== binding.integrationId ||
      metadata.externalChatReference !== expected.externalChatReference ||
      metadata.externalThreadReference !== expected.externalThreadReference ||
      !hasFeishuSafeThreadEvidenceContext(metadata)
    ) {
      return false;
    }

    return hasFeishuCollaboratingIdIntersection(metadata.collaboratingAgentIds, expectedCollaboratingAgentIds) &&
      hasFeishuCollaboratingIdIntersection(metadata.collaboratingBotBindingIds, expectedCollaboratingBotBindingIds);
  });
}

export function hasFeishuSafeThreadEvidenceContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    hasNonEmptyString(metadata.externalThreadReference) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}

export function hasFeishuCollaboratingIdIntersection(value: unknown, expectedIds: readonly string[]): boolean {
  const ids = readStringArrayMetadata(value);
  return expectedIds.some((expectedId) => ids.includes(expectedId));
}

export function hasDifferentFeishuCollaboratingId(value: unknown, currentId: string): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((id) =>
    typeof id === "string" &&
    id.trim().length > 0 &&
    id.trim() !== currentId
  );
}
