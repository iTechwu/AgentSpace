// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：core。
import { createHash } from "node:crypto";
import type { ExternalChannelBindingRecord, ExternalDataOperationRunRecord, ExternalIntegrationEventRecord, ExternalIntegrationRecord, ExternalMessageMappingRecord, ExternalMessageOutboxRecord, ExternalThreadBindingRecord } from "@dofe-agent/db";
import { FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH, FEISHU_PROVIDER_ID } from "@dofe-agent/services";
import { uniqueStrings } from "../cli-shared.ts";
import { FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS } from "../types.ts";
import type { FeishuExpectedBotAddedPayloadIdentityProof, FeishuIntegrationEvidence, FeishuLocalEvidenceFreshnessSummary } from "../types.ts";
import { buildFeishuEvidenceIssues, buildFeishuIntegrationEvidenceRemediationSteps } from "./issues.ts";
import { countCorrelatedFeishuReplyMappings, countFeishuNativeBotReplyEvidence, hasFeishuSafeBotReplyMetadataContext, hasNoFeishuUnsafeSerializedEvidenceContext, countFeishuAgentBotRouteEvidence, countFeishuNativeActorMentionEvidence, countFeishuAgentChannelPolicyDeniedEvidence, countFeishuBotSenderLoopGuardEvidence, countFeishuExternalGuestPolicyEvidence, countFeishuExternalGuestReplyAllEvidence, countFeishuIdentityBindingNoticeEvidence, countFeishuAutoProvisionedChannelBindings, countFeishuReusedProviderChannelBindings, countFeishuThreadTaskBindingEvidence, countFeishuThreadContinuationEvidence, countFeishuThreadCollaborationEvidence, countFeishuThreadCollaborationCardEvidence } from "./interactions.ts";
import { countFeishuFailedOutboxAgentBotEvidence, countFeishuFailedDataOperationAgentBotEvidence, hasFeishuAgentBotDataOperationContext, hasNoFeishuRawProviderIdentityContext, hasNoFeishuRawExternalLocationContext, hasNoFeishuRawDataOperationResourceContext } from "./failures.ts";
import { containsFeishuSecretLikeEvidence, containsRawFeishuOpenApiEvidenceIdentifier, isRecord } from "./proofs.ts";

export function buildFeishuIntegrationEvidence(input: {
  workspaceId: string;
  integration: ExternalIntegrationRecord;
  events: ExternalIntegrationEventRecord[];
  messageMappings: ExternalMessageMappingRecord[];
  outbox: ExternalMessageOutboxRecord[];
  channelBindings: ExternalChannelBindingRecord[];
  threadBindings: ExternalThreadBindingRecord[];
  dataOperations: ExternalDataOperationRunRecord[];
  localEvidenceFreshness?: FeishuLocalEvidenceFreshnessSummary;
}): FeishuIntegrationEvidence {
  const processedInboundEvents = countFeishuProcessedInboundMessageEvents(input.events);
  const processedApprovalCardActions = countFeishuProcessedApprovalCardActionEvents(input.events);
  const failedEvents = input.events.filter((event) => event.status === "failed").length;
  const inboundMessageMappings = input.messageMappings.filter((mapping) => mapping.direction === "inbound").length;
  const outboundMessageMappings = input.messageMappings.filter((mapping) => mapping.direction === "outbound").length;
  const correlatedReplyMappings = countCorrelatedFeishuReplyMappings(input.messageMappings);
  const nativeBotReplyEvidence = countFeishuNativeBotReplyEvidence(input.messageMappings);
  const agentBotRouteEvidence = countFeishuAgentBotRouteEvidence(input.messageMappings);
  const boundUserMentionEvidence = countFeishuNativeActorMentionEvidence(input.messageMappings, "user");
  const externalGuestMentionEvidence = countFeishuNativeActorMentionEvidence(input.messageMappings, "external_guest");
  const agentChannelPolicyDeniedEvidence = countFeishuAgentChannelPolicyDeniedEvidence(input.messageMappings);
  const botSenderLoopGuardEvidence = countFeishuBotSenderLoopGuardEvidence(input.messageMappings);
  const externalGuestAllowedEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "allow",
    dispatchStatus: "sent",
    reasonCode: "feishu_external_guest_allowed",
    unboundUserMode: "reply_on_mention",
    expectedPermissionProfile: "channel_context_only",
    agentBotMentioned: true,
    requireDispatchEvidence: true,
  });
  const externalGuestReplyAllEvidence = countFeishuExternalGuestReplyAllEvidence(input.messageMappings);
  const externalGuestRequireIdentityEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "require_identity",
    reasonCode: "feishu_external_guest_identity_required",
    dispatchStatus: "ignored",
    unboundUserMode: "require_identity",
    expectedPermissionProfile: "none",
    agentBotMentioned: true,
    requireNoDispatchEvidence: true,
  });
  const externalGuestIdentityBindingNoticeEvidence = countFeishuIdentityBindingNoticeEvidence(
    input.messageMappings,
    input.outbox,
  );
  const externalGuestIgnoreEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "ignore",
    reasonCode: "feishu_external_guest_ignored",
    unboundUserMode: "ignore",
    dispatchStatus: "ignored",
    expectedPermissionProfile: "none",
    agentBotMentioned: true,
    requireNoDispatchEvidence: true,
    requireNoOutboundReply: true,
  });
  const externalGuestMentionRequiredEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "ignore",
    reasonCode: "feishu_external_guest_bot_mention_required",
    unboundUserMode: "reply_on_mention",
    dispatchStatus: "ignored",
    expectedPermissionProfile: "channel_context_only",
    agentBotMentioned: false,
    requireNoDispatchEvidence: true,
    requireNoOutboundReply: true,
  });
  const autoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(input.channelBindings);
  const botAddedAutoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(
    input.channelBindings,
    "bot_added",
  );
  const firstMessageAutoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(
    input.channelBindings,
    "first_message",
  );
  const reusedProviderChannelBindings = countFeishuReusedProviderChannelBindings(input.channelBindings);
  const threadTaskBindings = countFeishuThreadTaskBindingEvidence(input.threadBindings);
  const threadContinuationEvidence = countFeishuThreadContinuationEvidence(input.messageMappings, input.threadBindings);
  const threadCollaborationEvidence = countFeishuThreadCollaborationEvidence(input.threadBindings);
  const threadCollaborationCardEvidence = countFeishuThreadCollaborationCardEvidence(
    input.outbox,
    input.threadBindings,
  );
  const sentOutboxItems = countFeishuSentAgentBotReplyOutboxEvidence(input.outbox);
  const failedOutboxItems = input.outbox.filter((item) =>
    item.status === "failed" || (item.status === "pending" && Boolean(item.lastError))
  ).length;
  const failedOutboxAgentBotEvidence = countFeishuFailedOutboxAgentBotEvidence(input.outbox);
  const healthStatus = input.integration.lastHealthStatus ?? "unknown";
  const healthFailureVisible = healthStatus === "degraded" || healthStatus === "error";
  const docReadSucceeded = countNonRuntimeFeishuDocReadOperations(input.dataOperations);
  const agentDocReadSucceeded = countAgentRuntimeFeishuDocReadOperations(input.dataOperations);
  const docWriteSucceeded = countSucceededFeishuOperations(input.dataOperations, [
    "docs.create_document",
    "docs.update_document",
  ]);
  const docApprovedWritesSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "docs.create_document",
    "docs.update_document",
  ]);
  const sheetReadSucceeded = countBoundGovernedFeishuReadOperations(input.dataOperations, ["sheets.read_range"]);
  const sheetWriteSucceeded = countSucceededFeishuOperations(input.dataOperations, ["sheets.update_range"]);
  const sheetApprovedWritesSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "sheets.update_range",
  ]);
  const sheetApprovedWriteSyncSucceeded = countApprovedSyncedFeishuDataTableWriteOperations(input.dataOperations, [
    "sheets.update_range",
  ]);
  const baseReadSucceeded = countBoundGovernedFeishuReadOperations(input.dataOperations, ["base.query_records"]);
  const baseMutateSucceeded = countSucceededFeishuOperations(input.dataOperations, ["base.mutate_records"]);
  const baseApprovedMutationsSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "base.mutate_records",
  ]);
  const baseApprovedMutationSyncSucceeded = countApprovedSyncedFeishuDataTableWriteOperations(input.dataOperations, [
    "base.mutate_records",
  ]);
  const userActorEvidence = countFeishuGovernanceActorEvidence(input.dataOperations, "user");
  const externalGuestActorEvidence = countFeishuGovernanceActorEvidence(input.dataOperations, "external_guest");
  const externalGuestReadSucceeded = countFeishuExternalGuestReadEvidence(input.dataOperations);
  const externalGuestWriteDeniedEvidence = countFeishuExternalGuestWriteDeniedEvidence(input.dataOperations);
  const failedDataOperations = input.dataOperations.filter((operation) => operation.status === "failed").length;
  const failedDataOperationAgentBotEvidence = countFeishuFailedDataOperationAgentBotEvidence(input.dataOperations);
  const agentBotFailureEvidence = failedOutboxAgentBotEvidence + failedDataOperationAgentBotEvidence;
  const integrationActive = input.integration.status === "active";
  const integrationAgentScoped = hasNonEmptyString(input.integration.agentId);
  const integrationReadyForAgentBotEvidence = integrationActive && integrationAgentScoped;
  const botSatisfied = integrationReadyForAgentBotEvidence &&
    processedInboundEvents > 0 &&
    sentOutboxItems > 0 &&
    inboundMessageMappings > 0 &&
    outboundMessageMappings > 0 &&
    correlatedReplyMappings > 0;
  const nativeExperienceSatisfied = integrationReadyForAgentBotEvidence &&
    agentBotRouteEvidence > 0 &&
    nativeBotReplyEvidence > 0 &&
    boundUserMentionEvidence > 0 &&
    externalGuestMentionEvidence > 0 &&
    agentChannelPolicyDeniedEvidence > 0 &&
    botSenderLoopGuardEvidence > 0 &&
    autoProvisionedChannelBindings > 0 &&
    botAddedAutoProvisionedChannelBindings > 0 &&
    firstMessageAutoProvisionedChannelBindings > 0 &&
    reusedProviderChannelBindings > 0 &&
    threadTaskBindings > 0 &&
    threadContinuationEvidence > 0 &&
    threadCollaborationEvidence > 0 &&
    threadCollaborationCardEvidence > 0;
  const guestPolicySatisfied = integrationReadyForAgentBotEvidence &&
    externalGuestAllowedEvidence > 0 &&
    externalGuestReplyAllEvidence > 0 &&
    externalGuestRequireIdentityEvidence > 0 &&
    externalGuestIdentityBindingNoticeEvidence > 0 &&
    externalGuestIgnoreEvidence > 0 &&
    externalGuestMentionRequiredEvidence > 0;
  const dataPlaneSatisfied = integrationReadyForAgentBotEvidence &&
    docReadSucceeded > 0 &&
    agentDocReadSucceeded > 0 &&
    docApprovedWritesSucceeded > 0 &&
    sheetReadSucceeded > 0 &&
    sheetApprovedWriteSyncSucceeded > 0 &&
    baseReadSucceeded > 0 &&
    baseApprovedMutationSyncSucceeded > 0 &&
    userActorEvidence > 0 &&
    externalGuestActorEvidence > 0 &&
    externalGuestReadSucceeded > 0 &&
    externalGuestWriteDeniedEvidence > 0;
  const requiredWorkerCorrelatedReplies = input.integration.transportMode === "websocket_worker" ? 2 : 0;
  const workerRestartRecoverySatisfied = correlatedReplyMappings >= requiredWorkerCorrelatedReplies;
  const workerApprovalCardActionSatisfied = input.integration.transportMode !== "websocket_worker" ||
    processedApprovalCardActions > 0;
  const workerSatisfied = integrationReadyForAgentBotEvidence &&
    input.integration.transportMode === "websocket_worker" &&
    botSatisfied &&
    workerRestartRecoverySatisfied &&
    workerApprovalCardActionSatisfied;
  const providerFailureVisible = failedOutboxItems > 0 || failedDataOperations > 0;
  const failureSatisfied = integrationReadyForAgentBotEvidence &&
    providerFailureVisible &&
    healthFailureVisible &&
    agentBotFailureEvidence > 0;
  const localEvidenceFreshness = input.localEvidenceFreshness ?? {
    totalRows: input.events.length +
      input.messageMappings.length +
      input.outbox.length +
      input.channelBindings.length +
      input.threadBindings.length +
      input.dataOperations.length,
    freshRows: input.events.length +
      input.messageMappings.length +
      input.outbox.length +
      input.channelBindings.length +
      input.threadBindings.length +
      input.dataOperations.length,
    staleRows: 0,
    maxAgeHours: FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS / (60 * 60 * 1000),
  };
  const issues = buildFeishuEvidenceIssues({
    integration: input.integration,
    localEvidenceFreshness,
    botSatisfied,
    nativeExperienceSatisfied,
    guestPolicySatisfied,
    dataPlaneSatisfied,
    workerSatisfied,
    failureSatisfied,
    processedInboundEvents,
    inboundMessageMappings,
    sentOutboxItems,
    outboundMessageMappings,
    correlatedReplyMappings,
    agentBotRouteEvidence,
    nativeBotReplyEvidence,
    boundUserMentionEvidence,
    externalGuestMentionEvidence,
    agentChannelPolicyDeniedEvidence,
    botSenderLoopGuardEvidence,
    externalGuestAllowedEvidence,
    externalGuestReplyAllEvidence,
    externalGuestRequireIdentityEvidence,
    externalGuestIdentityBindingNoticeEvidence,
    externalGuestIgnoreEvidence,
    externalGuestMentionRequiredEvidence,
    autoProvisionedChannelBindings,
    botAddedAutoProvisionedChannelBindings,
    firstMessageAutoProvisionedChannelBindings,
    reusedProviderChannelBindings,
    threadTaskBindings,
    threadContinuationEvidence,
    threadCollaborationEvidence,
    threadCollaborationCardEvidence,
    docReadSucceeded,
    agentDocReadSucceeded,
    docWriteSucceeded,
    docApprovedWritesSucceeded,
    sheetReadSucceeded,
    sheetWriteSucceeded,
    sheetApprovedWritesSucceeded,
    sheetApprovedWriteSyncSucceeded,
    baseReadSucceeded,
    baseMutateSucceeded,
    baseApprovedMutationsSucceeded,
    baseApprovedMutationSyncSucceeded,
    userActorEvidence,
    externalGuestActorEvidence,
    externalGuestReadSucceeded,
    externalGuestWriteDeniedEvidence,
    workerRestartRecoverySatisfied,
    workerApprovalCardActionSatisfied,
    providerFailureVisible,
    healthFailureVisible,
    agentBotFailureEvidence,
  });
  const remediationSteps = buildFeishuIntegrationEvidenceRemediationSteps({
    workspaceId: input.workspaceId,
    integration: input.integration,
    issues,
  });

  return {
    id: input.integration.id,
    displayName: input.integration.displayName,
    ...(input.integration.agentId ? { agentId: input.integration.agentId } : {}),
    status: input.integration.status,
    transportMode: input.integration.transportMode,
    localEvidenceFreshness,
    bot: {
      processedInboundEvents,
      inboundMessageMappings,
      sentOutboxItems,
      outboundMessageMappings,
      correlatedReplyMappings,
      satisfied: botSatisfied,
    },
    nativeExperience: {
      agentBotRouteEvidence,
      nativeBotReplyEvidence,
      boundUserMentionEvidence,
      externalGuestMentionEvidence,
      agentChannelPolicyDeniedEvidence,
      botSenderLoopGuardEvidence,
      autoProvisionedChannelBindings,
      botAddedAutoProvisionedChannelBindings,
      firstMessageAutoProvisionedChannelBindings,
      reusedProviderChannelBindings,
      threadTaskBindings,
      threadContinuationEvidence,
      threadCollaborationEvidence,
      threadCollaborationCardEvidence,
      satisfied: nativeExperienceSatisfied,
    },
    guestPolicy: {
      externalGuestAllowedEvidence,
      externalGuestReplyAllEvidence,
      externalGuestRequireIdentityEvidence,
      externalGuestIdentityBindingNoticeEvidence,
      externalGuestIgnoreEvidence,
      externalGuestMentionRequiredEvidence,
      satisfied: guestPolicySatisfied,
    },
    dataPlane: {
      docReadSucceeded,
      agentDocReadSucceeded,
      docWriteSucceeded,
      docApprovedWritesSucceeded,
      sheetReadSucceeded,
      sheetWriteSucceeded,
      sheetApprovedWritesSucceeded,
      sheetApprovedWriteSyncSucceeded,
      baseReadSucceeded,
      baseMutateSucceeded,
      baseApprovedMutationsSucceeded,
      baseApprovedMutationSyncSucceeded,
      userActorEvidence,
      externalGuestActorEvidence,
      externalGuestReadSucceeded,
      externalGuestWriteDeniedEvidence,
      satisfied: dataPlaneSatisfied,
    },
    worker: {
      correlatedReplyMappings,
      requiredCorrelatedReplies: requiredWorkerCorrelatedReplies,
      restartRecoverySatisfied: workerRestartRecoverySatisfied,
      processedApprovalCardActions,
      approvalCardActionSatisfied: workerApprovalCardActionSatisfied,
      satisfied: workerSatisfied,
    },
    failureVisibility: {
      healthStatus,
      healthFailureVisible,
      providerFailureVisible,
      agentBotFailureEvidence,
      failedEvents,
      failedOutboxItems,
      failedDataOperations,
      satisfied: failureSatisfied,
    },
    issues,
    remediationSteps,
  };
}

export function countSucceededFeishuOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" && allowed.has(operation.operationType)
  ).length;
}

export function countNonRuntimeFeishuDocReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    operation.operationType === "docs.read_document" &&
    hasBoundFeishuGovernedReadContext(operation) &&
    !hasFeishuAgentRuntimeDocReadEvidence(operation)
  ).length;
}

export function countBoundGovernedFeishuReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasBoundFeishuGovernedReadContext(operation)
  ).length;
}

export function countApprovedSucceededFeishuOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasFeishuApprovedWriteEvidence(operation)
  ).length;
}

export function countApprovedSyncedFeishuDataTableWriteOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasFeishuApprovedWriteEvidence(operation) &&
    hasFeishuApprovedDataTableWriteSyncEvidence(operation)
  ).length;
}

export function countAgentRuntimeFeishuDocReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    operation.operationType === "docs.read_document" &&
    operation.actorType === "agent" &&
    hasBoundFeishuGovernedReadContext(operation) &&
    hasFeishuAgentRuntimeDocReadEvidence(operation)
  ).length;
}

export function hasFeishuAgentRuntimeDocReadEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const request = readJsonRecord(operation.requestJson);
  const result = readJsonRecord(operation.resultJson);
  const runtimeResultManifest = isRecord(result?.runtimeResultManifest)
    ? result.runtimeResultManifest
    : undefined;
  return request?.source === "lark-cli-result-manifest" &&
    request.resultManifestPath === FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH &&
    runtimeResultManifest?.path === FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH;
}

export function hasFeishuApprovedWriteEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  return result?.policyDecision === "approved" &&
    typeof result.approvalId === "string" &&
    result.approvalId.trim().length > 0 &&
    hasFeishuPayloadHashEvidence(result.payloadHash) &&
    hasNonEmptyString(operation.resourceBindingId) &&
    hasFeishuSafeDataOperationResultSummary(operation) &&
    hasFeishuAgentBotGovernedWriteContext(operation);
}

export function hasFeishuPayloadHashEvidence(value: unknown): boolean {
  if (!hasNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return /^[a-f0-9]{64}$/i.test(normalized) ||
    /^sha256:[a-f0-9]{64}$/i.test(normalized);
}

export function hasFeishuSha256HashEvidence(value: unknown): value is string {
  return hasNonEmptyString(value) && /^[a-f0-9]{64}$/i.test(value.trim());
}

export function matchFeishuExpectedIdentityProof(
  proofs: readonly FeishuExpectedBotAddedPayloadIdentityProof[],
  evidence: Record<string, unknown>,
): {
  appMatchedProof?: FeishuExpectedBotAddedPayloadIdentityProof;
  fullMatchedProof?: FeishuExpectedBotAddedPayloadIdentityProof;
  tenantIssue?: "tenant_key_hash_missing" | "tenant_key_mismatch" | "tenant_key_unexpected";
} {
  if (!hasFeishuSha256HashEvidence(evidence.appIdHash)) {
    return {};
  }
  const appMatchedProofs = proofs.filter((proof) => proof.appIdHash === evidence.appIdHash);
  if (appMatchedProofs.length === 0) {
    return {};
  }
  const fullMatchedProof = appMatchedProofs.find((proof) =>
    readFeishuMatchedIdentityIntegrationId(proof, evidence) === proof.integrationId
  );
  if (fullMatchedProof) {
    return {
      appMatchedProof: fullMatchedProof,
      fullMatchedProof,
    };
  }

  const evidenceTenantPresent = evidence.tenantKeyPresent === true ||
    hasFeishuSha256HashEvidence(evidence.tenantKeyHash);
  if (!evidenceTenantPresent && appMatchedProofs.some((proof) => proof.tenantKeyHash)) {
    return {
      appMatchedProof: appMatchedProofs[0],
      tenantIssue: "tenant_key_hash_missing",
    };
  }
  if (evidenceTenantPresent && appMatchedProofs.every((proof) => !proof.tenantKeyHash)) {
    return {
      appMatchedProof: appMatchedProofs[0],
      tenantIssue: "tenant_key_unexpected",
    };
  }
  return {
    appMatchedProof: appMatchedProofs[0],
    tenantIssue: "tenant_key_mismatch",
  };
}

export function readFeishuMatchedIdentityIntegrationId(
  proof: FeishuExpectedBotAddedPayloadIdentityProof | undefined,
  evidence: unknown,
): string | undefined {
  if (!proof || !isRecord(evidence)) {
    return undefined;
  }
  if (proof.tenantKeyHash) {
    return evidence.tenantKeyHash === proof.tenantKeyHash ? proof.integrationId : undefined;
  }
  return evidence.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(evidence.tenantKeyHash)
    ? proof.integrationId
    : undefined;
}

export function hasFeishuApprovedDataTableWriteSyncEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  const dofeAgentSync = isRecord(result?.dofeAgentSync) ? result.dofeAgentSync : undefined;
  return dofeAgentSync?.dataTableLastApprovedWriteSynced === true;
}

export function hasFeishuAgentBotGovernedWriteContext(operation: ExternalDataOperationRunRecord): boolean {
  const governanceContext = readFeishuGovernanceContext(operation);
  if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
    return false;
  }
  const actorType = readFeishuGovernanceActorType(operation);
  if (actorType === "agent") {
    return true;
  }
  if (actorType === "user") {
    return hasNonEmptyString(governanceContext.actorUserId);
  }
  return false;
}

export function hasBoundFeishuGovernedReadContext(operation: ExternalDataOperationRunRecord): boolean {
  const governanceContext = readFeishuGovernanceContext(operation);
  if (!hasNonEmptyString(operation.resourceBindingId)) {
    return false;
  }
  if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
    return false;
  }
  if (!hasFeishuSafeDataOperationResultSummary(operation)) {
    return false;
  }
  const actorType = readFeishuGovernanceActorType(operation);
  if (actorType === "agent") {
    return true;
  }
  if (actorType === "user") {
    return hasNonEmptyString(governanceContext.actorUserId);
  }
  if (actorType === "external_guest") {
    return countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
      governanceContext.externalGuestPermissionProfile === "channel_context_only" &&
      governanceContext.externalGuestResourceAccess === "guest_readable_current_channel" &&
      hasNonEmptyString(governanceContext.channelName);
  }
  return false;
}

export function countFeishuGovernanceActorEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
  actorType: "user" | "external_guest",
): number {
  return operations.filter((operation) => {
    const governanceContext = readFeishuGovernanceContext(operation);
    if (governanceContext?.actorType !== actorType) {
      return false;
    }
    if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
      return false;
    }
    if (actorType === "user") {
      return hasNonEmptyString(governanceContext.actorUserId);
    }
    return hasNonEmptyString(governanceContext.externalActorReference) &&
      isFeishuAcceptedExternalGuestDataPlanePermissionProfile(governanceContext.externalGuestPermissionProfile) &&
      hasFeishuExternalGuestNoWorkspaceMemberEvidence(governanceContext);
  }).length;
}

export function isFeishuAcceptedExternalGuestDataPlanePermissionProfile(value: unknown): boolean {
  return value === "channel_context_only" || value === "none";
}

export function countFeishuExternalGuestWriteDeniedEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  const writeOperations = new Set([
    "docs.create_document",
    "docs.update_document",
    "sheets.update_range",
    "base.mutate_records",
  ]);
  return operations.filter((operation) =>
    readFeishuGovernanceActorType(operation) === "external_guest" &&
    countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
    operation.status === "failed" &&
    operation.errorCode === "feishu.data_operation_external_guest_requires_identity" &&
    writeOperations.has(operation.operationType) &&
    hasNonEmptyString(operation.resourceBindingId) &&
    hasFeishuSafeDataOperationResultSummary(operation)
  ).length;
}

export function countFeishuExternalGuestReadEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  const readOperations = new Set(["docs.read_document", "sheets.read_range", "base.query_records"]);
  return operations.filter((operation) => {
    const governanceContext = readFeishuGovernanceContext(operation);
    return operation.status === "succeeded" &&
      readOperations.has(operation.operationType) &&
      hasBoundFeishuGovernedReadContext(operation) &&
      countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
      governanceContext?.externalGuestPermissionProfile === "channel_context_only" &&
      governanceContext?.externalGuestResourceAccess === "guest_readable_current_channel" &&
      hasNonEmptyString(governanceContext.channelName);
  }).length;
}

export function readFeishuGovernanceActorType(
  operation: ExternalDataOperationRunRecord,
): "user" | "external_guest" | "agent" | "system" | undefined {
  const governanceContext = readFeishuGovernanceContext(operation);
  const actorType = typeof governanceContext?.actorType === "string"
    ? governanceContext.actorType
    : undefined;
  return actorType === "user" ||
    actorType === "external_guest" ||
    actorType === "agent" ||
    actorType === "system"
    ? actorType
    : undefined;
}

export function readFeishuGovernanceContext(operation: ExternalDataOperationRunRecord): Record<string, unknown> | undefined {
  const request = readJsonRecord(operation.requestJson);
  return isRecord(request?.governanceContext)
    ? request.governanceContext
    : isRecord(request?.feishuGovernance)
      ? request.feishuGovernance
      : undefined;
}

export function hasFeishuSafeDataOperationResultSummary(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  if (!result) {
    return false;
  }
  const serialized = JSON.stringify(result);
  return hasNoFeishuRawDataOperationResourceContext(result) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasNoFeishuUserIdentity(metadata: Record<string, unknown>): boolean {
  const rawIdentityFields = [
    "userId",
    "actorUserId",
    "externalUserId",
    "externalOpenId",
    "externalUnionId",
    "feishuOpenId",
    "feishuUnionId",
    "openId",
    "unionId",
    "providerUserId",
    "providerOpenId",
    "providerUnionId",
    "senderOpenId",
    "senderUnionId",
    "user_id",
    "open_id",
    "union_id",
    "external_user_id",
    "external_open_id",
    "external_union_id",
    "provider_user_id",
    "provider_open_id",
    "provider_union_id",
  ];
  return rawIdentityFields.every((field) => !hasNonEmptyString(metadata[field]));
}

export function hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata: Record<string, unknown>): boolean {
  return metadata.workspaceMemberCreated === false && hasNoFeishuUserIdentity(metadata);
}

export function hasFeishuSafeInboundMessageContext(metadata: Record<string, unknown> | undefined): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    hasNonEmptyString(metadata.externalThreadReference) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}

export function hasFeishuMessageMappingAgentBotContext(
  mapping: ExternalMessageMappingRecord,
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return hasNonEmptyString(metadata?.agentId) &&
    readStringMetadata(metadata?.botBindingId) === mapping.integrationId;
}

export function countFeishuSentAgentBotReplyOutboxEvidence(outbox: readonly ExternalMessageOutboxRecord[]): number {
  return outbox.filter((item) => {
    if (item.status !== "sent" || !hasNonEmptyString(item.sentAt)) {
      return false;
    }
    if (
      !hasNonEmptyString(item.channelBindingId) ||
      !hasNonEmptyString(item.dofeAgentMessageId) ||
      !hasNonEmptyString(item.targetExternalThreadId)
    ) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    if (metadata?.provider !== FEISHU_PROVIDER_ID || metadata.outboxSource !== "agent_reply") {
      return false;
    }
    if (
      !hasNonEmptyString(metadata.agentId) ||
      !hasNonEmptyString(metadata.botBindingId) ||
      metadata.botBindingId.trim() !== item.integrationId ||
      !hasFeishuSafeBotReplyMetadataContext(metadata)
    ) {
      return false;
    }
    return true;
  }).length;
}

export function countFeishuProcessedInboundMessageEvents(events: ExternalIntegrationEventRecord[]): number {
  return events.filter((event) => {
    if (event.eventType !== "im.message.receive_v1" || event.status !== "processed") {
      return false;
    }
    const payload = readJsonRecord(event.payloadJson);
    if (
      payload?.provider !== FEISHU_PROVIDER_ID ||
      payload.rawPayloadStored !== false ||
      !hasNonEmptyString(payload.payloadHash) ||
      !hasNonEmptyString(payload.externalEventReference) ||
      payload.externalEventIdRedacted !== true ||
      !hasNoFeishuUnsafeSerializedEvidenceContext(payload)
    ) {
      return false;
    }
    const message = isRecord(payload.message) ? payload.message : undefined;
    const sender = isRecord(payload.sender) ? payload.sender : undefined;
    return hasNonEmptyString(message?.messageReference) &&
      message?.messageIdRedacted === true &&
      !hasNonEmptyString(message?.messageId) &&
      !hasNonEmptyString(message?.message_id) &&
      hasNonEmptyString(message?.chatReference) &&
      message?.chatIdRedacted === true &&
      !hasNonEmptyString(message?.chatId) &&
      !hasNonEmptyString(message?.chat_id) &&
      hasNonEmptyString(message?.threadReference) &&
      message?.threadIdRedacted === true &&
      !hasNonEmptyString(message?.threadId) &&
      !hasNonEmptyString(message?.thread_id) &&
      hasNonEmptyString(sender?.openIdReference) &&
      sender?.openIdRedacted === true &&
      !hasNonEmptyString(sender?.openId) &&
      !hasNonEmptyString(sender?.open_id) &&
      !hasNonEmptyString(sender?.unionId) &&
      !hasNonEmptyString(sender?.union_id) &&
      !hasNonEmptyString(sender?.userId) &&
      !hasNonEmptyString(sender?.user_id);
  }).length;
}

export function isFeishuApprovalCardActionEventType(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase();
  return normalized === "card.action.trigger" ||
    normalized === "im.message.message_card.action_v1" ||
    normalized === "message_card.action";
}

export function countFeishuProcessedApprovalCardActionEvents(events: ExternalIntegrationEventRecord[]): number {
  return events.filter((event) => {
    if (!isFeishuApprovalCardActionEventType(event.eventType) || event.status !== "processed") {
      return false;
    }
    const payload = readJsonRecord(event.payloadJson);
    if (
      !payload ||
      readStringMetadata(payload.provider) !== FEISHU_PROVIDER_ID ||
      payload.rawPayloadStored !== false ||
      !hasNoFeishuUnsafeSerializedEvidenceContext(payload)
    ) {
      return false;
    }
    const approvalCardAction = isRecord(payload.approvalCardAction) ? payload.approvalCardAction : undefined;
    const decision = readStringMetadata(approvalCardAction?.decision)?.toLowerCase();
    return readStringMetadata(approvalCardAction?.provider) === FEISHU_PROVIDER_ID &&
      readStringMetadata(approvalCardAction?.kind) === "data_operation_approval" &&
      hasNonEmptyString(approvalCardAction?.approvalId) &&
      hasFeishuPayloadHashEvidence(approvalCardAction?.payloadHash) &&
      (decision === "approved" || decision === "rejected") &&
      approvalCardAction?.tokenStored === false &&
      approvalCardAction?.rawActionPayloadStored === false &&
      hasFeishuSafeApprovalCardActionContext(approvalCardAction) &&
      hasNoFeishuUserIdentity(approvalCardAction);
  }).length;
}

export function hasFeishuSafeApprovalCardActionContext(action: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(action);
  return hasNoFeishuRawApprovalCardActionData(action) &&
    hasNoFeishuRawDataOperationResourceContext(action) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}

export function hasNoFeishuRawApprovalCardActionData(action: Record<string, unknown>): boolean {
  const rawActionFields = [
    "token",
    "actionToken",
    "action_token",
    "tenantAccessToken",
    "tenant_access_token",
    "rawActionPayload",
    "raw_action_payload",
    "actionPayload",
    "action_payload",
    "rawPayload",
    "raw_payload",
  ];
  return rawActionFields.every((field) => action[field] === undefined || action[field] === null);
}

export function readJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readStringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readStringArrayMetadata(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter(hasNonEmptyString).map((item) => item.trim()));
}

export function buildFeishuCliExternalReference(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex").slice(0, 16)}`;
}

export function buildFeishuShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
