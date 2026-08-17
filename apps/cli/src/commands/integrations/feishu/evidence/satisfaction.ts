// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：satisfaction。
import { FEISHU_PROVIDER_ID } from "@dofe-agent/services/integrations";
import { uniqueStrings } from "../cli-shared.ts";
import type { FeishuEvidenceRequirement, FeishuIntegrationEvidence, FeishuIntegrationEvidenceSource } from "../types.ts";
import { hasNonEmptyString, readJsonRecord } from "./core.ts";
import { countFeishuNativeBotReplyEvidence, countFeishuAgentBotRouteEvidence, countFeishuNativeActorMentionEvidence, countFeishuAgentChannelPolicyDeniedEvidence, countFeishuBotSenderLoopGuardEvidence, countFeishuAutoProvisionedChannelBindings, countFeishuReusedProviderChannelBindings, countFeishuThreadTaskBindingEvidence, countFeishuThreadContinuationEvidence, countFeishuThreadCollaborationEvidence, countFeishuThreadCollaborationCardEvidence } from "./interactions.ts";

export interface FeishuWorkspaceEvidenceSatisfaction {
  botSatisfied: boolean;
  nativeExperienceSatisfied: boolean;
  guestPolicySatisfied: boolean;
  dataPlaneSatisfied: boolean;
  workerSatisfied: boolean;
  failureVisibilitySatisfied: boolean;
  allSatisfied: boolean;
}

export function buildFeishuWorkspaceEvidenceSatisfaction(
  items: readonly FeishuIntegrationEvidence[],
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredNativeIntegrationId?: string;
  } = {},
): FeishuWorkspaceEvidenceSatisfaction {
  const activeSources = sources.filter((source) => source.integration.status === "active");
  const activeIntegrationIds = new Set(activeSources.map((source) => source.integration.id));
  const activeItems = items.filter((item) => activeIntegrationIds.has(item.id));
  const botSatisfied = activeItems.some((item) => item.bot.satisfied);
  const nativeExperienceSatisfied = hasFeishuWorkspaceNativeExperienceEvidence(activeSources, {
    requiredIntegrationId: options.requiredNativeIntegrationId,
  });
  const guestPolicySatisfied = sumFeishuEvidenceCounts(activeItems, (item) =>
    item.guestPolicy.externalGuestAllowedEvidence
  ) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestReplyAllEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestRequireIdentityEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) =>
      item.guestPolicy.externalGuestIdentityBindingNoticeEvidence
    ) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestIgnoreEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestMentionRequiredEvidence) > 0;
  const dataPlaneSatisfied = sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.docReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.agentDocReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.docApprovedWritesSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.sheetReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.sheetApprovedWriteSyncSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.baseReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.baseApprovedMutationSyncSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.userActorEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestActorEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestWriteDeniedEvidence) > 0;
  const hasWebSocketWorkerIntegration = activeItems.some((item) => item.transportMode === "websocket_worker");
  const workerSatisfied = activeItems.length > 0 &&
    (hasWebSocketWorkerIntegration
      ? activeItems.some((item) => item.worker.satisfied)
      : true);
  const failureVisibilitySatisfied = activeItems.some((item) => item.failureVisibility.satisfied);
  const allSatisfied = activeItems.some((item) =>
    isFeishuEvidenceSatisfiedExceptNative(item) &&
    hasFeishuWorkspaceNativeExperienceEvidence(activeSources, {
      requiredIntegrationId: item.id,
    })
  );
  return {
    botSatisfied,
    nativeExperienceSatisfied,
    guestPolicySatisfied,
    dataPlaneSatisfied,
    workerSatisfied,
    failureVisibilitySatisfied,
    allSatisfied,
  };
}

export function hasFeishuWorkspaceNativeExperienceEvidence(
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredIntegrationId?: string;
    allowedIntegrationIds?: ReadonlySet<string>;
  } = {},
): boolean {
  return listFeishuWorkspaceNativeExperienceChatReferences(sources, options).length > 0;
}

export function listFeishuWorkspaceNativeExperienceChatReferences(
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredIntegrationId?: string;
    allowedIntegrationIds?: ReadonlySet<string>;
  } = {},
): string[] {
  const messageMappings = sources.flatMap((source) => source.messageMappings);
  const outbox = sources.flatMap((source) => source.outbox);
  const channelBindings = sources.flatMap((source) => source.channelBindings);
  const threadBindings = sources.flatMap((source) => source.threadBindings);
  const chatReferences = uniqueStrings([
    ...messageMappings.map((mapping) => readFeishuSafeChatReference(mapping.metadataJson)),
    ...outbox.map((item) => readFeishuSafeChatReference(item.metadataJson)),
    ...channelBindings.map((binding) => readFeishuSafeChatReference(binding.metadataJson)),
    ...threadBindings.map((binding) => readFeishuSafeChatReference(binding.metadataJson)),
  ].filter(hasNonEmptyString));

  return chatReferences.filter((chatReference) => {
    const scopedMappings = messageMappings.filter((mapping) =>
      readFeishuSafeChatReference(mapping.metadataJson) === chatReference
    );
    const scopedChannelBindings = channelBindings.filter((binding) =>
      readFeishuSafeChatReference(binding.metadataJson) === chatReference
    );
    const scopedOutbox = outbox.filter((item) =>
      readFeishuSafeChatReference(item.metadataJson) === chatReference
    );
    const scopedThreadBindings = threadBindings.filter((binding) =>
      readFeishuSafeChatReference(binding.metadataJson) === chatReference
    );
    const scopedIntegrationIds = new Set([
      ...scopedMappings.map((mapping) => mapping.integrationId),
      ...scopedOutbox.map((item) => item.integrationId),
      ...scopedChannelBindings.map((binding) => binding.integrationId),
      ...scopedThreadBindings.map((binding) => binding.integrationId),
    ].filter(hasNonEmptyString));
    if (options.requiredIntegrationId && !scopedIntegrationIds.has(options.requiredIntegrationId)) {
      return false;
    }
    if (
      options.allowedIntegrationIds &&
      ![...scopedIntegrationIds].some((integrationId) => options.allowedIntegrationIds?.has(integrationId))
    ) {
      return false;
    }
    if (!hasDistinctActiveFeishuAgentBotBindingsInScope(sources, scopedIntegrationIds)) {
      return false;
    }

    return countFeishuAgentBotRouteEvidence(scopedMappings) > 0 &&
      countFeishuNativeBotReplyEvidence(scopedMappings) > 0 &&
      countFeishuNativeActorMentionEvidence(scopedMappings, "user") > 0 &&
      countFeishuNativeActorMentionEvidence(scopedMappings, "external_guest") > 0 &&
      countFeishuAgentChannelPolicyDeniedEvidence(scopedMappings) > 0 &&
      countFeishuBotSenderLoopGuardEvidence(scopedMappings) > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings) > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings, "bot_added") > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings, "first_message") > 0 &&
      countFeishuReusedProviderChannelBindings(scopedChannelBindings) > 0 &&
      countFeishuThreadTaskBindingEvidence(scopedThreadBindings) > 0 &&
      countFeishuThreadContinuationEvidence(scopedMappings, scopedThreadBindings) > 0 &&
      countFeishuThreadCollaborationEvidence(scopedThreadBindings) > 0 &&
      countFeishuThreadCollaborationCardEvidence(scopedOutbox, scopedThreadBindings) > 0;
  });
}

export function listFeishuIntegrationIdsForSafeChatReference(
  sources: readonly FeishuIntegrationEvidenceSource[],
  chatReference: string,
): string[] {
  const matchingIds = sources.flatMap((source) => [
    ...source.messageMappings
      .filter((mapping) => readFeishuSafeChatReference(mapping.metadataJson) === chatReference)
      .map((mapping) => mapping.integrationId),
    ...source.outbox
      .filter((item) => readFeishuSafeChatReference(item.metadataJson) === chatReference)
      .map((item) => item.integrationId),
    ...source.channelBindings
      .filter((binding) => readFeishuSafeChatReference(binding.metadataJson) === chatReference)
      .map((binding) => binding.integrationId),
    ...source.threadBindings
      .filter((binding) => readFeishuSafeChatReference(binding.metadataJson) === chatReference)
      .map((binding) => binding.integrationId),
  ]);
  return uniqueStrings(matchingIds.filter(hasNonEmptyString)).sort();
}

export function doFeishuSafeReferencesMatch(left: unknown, right: unknown): boolean {
  const leftHash = readFeishuSafeReferenceComparableHash(left);
  const rightHash = readFeishuSafeReferenceComparableHash(right);
  if (!leftHash || !rightHash) {
    return false;
  }
  return leftHash === rightHash ||
    (leftHash.length >= rightHash.length && rightHash.length >= 8 && leftHash.startsWith(rightHash)) ||
    (rightHash.length >= leftHash.length && leftHash.length >= 8 && rightHash.startsWith(leftHash));
}

export function readFeishuSafeReferenceComparableHash(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const prefixed = /^(?:chat|event)[ :]([a-f0-9]{8,64})$/.exec(normalized);
  if (prefixed) {
    return prefixed[1];
  }
  const ref = /^ref_([a-f0-9]{8,64})$/.exec(normalized);
  if (ref) {
    return ref[1];
  }
  return /^[a-f0-9]{8,64}$/.test(normalized) ? normalized : undefined;
}

export interface FeishuAgentBotBindingIdentity {
  integrationId: string;
  agentId: string;
  appId: string;
  tenantKey?: string;
}

export function hasDistinctActiveFeishuAgentBotBindingsInScope(
  sources: readonly FeishuIntegrationEvidenceSource[],
  scopedIntegrationIds: ReadonlySet<string>,
): boolean {
  const identities = sources.flatMap((source): FeishuAgentBotBindingIdentity[] => {
    const integration = source.integration;
    if (
      !scopedIntegrationIds.has(integration.id) ||
      integration.status !== "active" ||
      integration.provider !== FEISHU_PROVIDER_ID ||
      !hasNonEmptyString(integration.agentId) ||
      !hasNonEmptyString(integration.appId)
    ) {
      return [];
    }
    return [{
      integrationId: integration.id.trim(),
      agentId: integration.agentId.trim(),
      appId: integration.appId.trim(),
      ...(hasNonEmptyString(integration.tenantKey) ? { tenantKey: integration.tenantKey.trim() } : {}),
    }];
  });
  const activeIntegrationIds = new Set(identities.map((identity) => identity.integrationId));
  const distinctAgentIds = new Set(identities.map((identity) => identity.agentId));
  const distinctAppIds = new Set(identities.map((identity) => identity.appId));
  const explicitTenantKeys = new Set(identities.map((identity) => identity.tenantKey).filter(hasNonEmptyString));
  return activeIntegrationIds.size >= 2 &&
    distinctAgentIds.size >= 2 &&
    distinctAppIds.size >= 2 &&
    explicitTenantKeys.size <= 1;
}

export function readFeishuSafeChatReference(metadataJson: string): string | undefined {
  const metadata = readJsonRecord(metadataJson);
  return hasNonEmptyString(metadata?.externalChatReference) ? metadata.externalChatReference.trim() : undefined;
}

export function sumFeishuEvidenceCounts(
  items: readonly FeishuIntegrationEvidence[],
  select: (item: FeishuIntegrationEvidence) => number,
): number {
  return items.reduce((total, item) => total + select(item), 0);
}

export function isFeishuEvidenceReportStrictSatisfied(input: {
  requiredEvidence: FeishuEvidenceRequirement;
  evidenceItems: readonly FeishuIntegrationEvidence[];
  workspaceEvidence: FeishuWorkspaceEvidenceSatisfaction;
  scopedIntegrationId?: string;
}): boolean {
  if (input.evidenceItems.length === 0) {
    return false;
  }
  if (input.requiredEvidence === "native") {
    return input.workspaceEvidence.nativeExperienceSatisfied;
  }
  if (input.requiredEvidence === "all") {
    return buildFeishuScopedAllEvidenceSatisfied(input);
  }
  return input.evidenceItems.some((item) => isFeishuEvidenceSatisfied(item, input.requiredEvidence));
}

export function buildFeishuScopedAllEvidenceSatisfied(input: {
  evidenceItems: readonly FeishuIntegrationEvidence[];
  workspaceEvidence: FeishuWorkspaceEvidenceSatisfaction;
  scopedIntegrationId?: string;
}): boolean {
  if (input.scopedIntegrationId) {
    return input.workspaceEvidence.nativeExperienceSatisfied &&
      input.evidenceItems.some((item) => isFeishuEvidenceSatisfiedExceptNative(item));
  }
  return input.workspaceEvidence.allSatisfied;
}

export function isFeishuEvidenceSatisfiedExceptNative(item: FeishuIntegrationEvidence): boolean {
  return item.bot.satisfied &&
    item.guestPolicy.satisfied &&
    item.dataPlane.satisfied &&
    item.failureVisibility.satisfied &&
    (item.transportMode !== "websocket_worker" || item.worker.satisfied);
}

export function isFeishuEvidenceSatisfied(
  item: FeishuIntegrationEvidence,
  requiredEvidence: FeishuEvidenceRequirement,
): boolean {
  if (requiredEvidence === "native") {
    return item.nativeExperience.satisfied;
  }
  if (requiredEvidence === "guest-policy") {
    return item.guestPolicy.satisfied;
  }
  if (requiredEvidence === "data-plane") {
    return item.dataPlane.satisfied;
  }
  if (requiredEvidence === "worker") {
    return item.worker.satisfied;
  }
  if (requiredEvidence === "failure") {
    return item.failureVisibility.satisfied;
  }
  if (requiredEvidence === "all") {
    return item.bot.satisfied &&
      item.nativeExperience.satisfied &&
      item.guestPolicy.satisfied &&
      item.dataPlane.satisfied &&
      item.failureVisibility.satisfied &&
      (item.transportMode !== "websocket_worker" || item.worker.satisfied);
  }
  return item.bot.satisfied;
}
