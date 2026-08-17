// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：failures。
import type { ExternalDataOperationRunRecord, ExternalMessageOutboxRecord } from "@dofe-agent/db";
import { FEISHU_PROVIDER_ID } from "@dofe-agent/services/integrations";
import { readFeishuGovernanceContext, hasFeishuSafeDataOperationResultSummary, hasNonEmptyString, readJsonRecord, readStringMetadata } from "./core.ts";
import { hasNoFeishuUnsafeSerializedEvidenceContext } from "./interactions.ts";
import { containsFeishuSecretLikeEvidence, containsRawFeishuOpenApiEvidenceIdentifier } from "./proofs.ts";

export function countFeishuFailedOutboxAgentBotEvidence(
  outbox: readonly ExternalMessageOutboxRecord[],
): number {
  return outbox.filter((item) => {
    if (item.status !== "failed" && !(item.status === "pending" && Boolean(item.lastError))) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      hasNonEmptyString(metadata.agentId) &&
      hasNonEmptyString(metadata.botBindingId) &&
      metadata.botBindingId.trim() === item.integrationId &&
      hasNonEmptyString(metadata.externalChatReference) &&
      !hasNonEmptyString(metadata.externalChatId) &&
      !hasNonEmptyString(metadata.external_chat_id) &&
      !hasNonEmptyString(metadata.externalThreadId) &&
      !hasNonEmptyString(metadata.external_thread_id) &&
      !hasNonEmptyString(metadata.targetExternalChatId) &&
      !hasNonEmptyString(metadata.target_external_chat_id) &&
      !hasNonEmptyString(metadata.targetExternalThreadId) &&
      !hasNonEmptyString(metadata.target_external_thread_id) &&
      hasNoFeishuUnsafeSerializedEvidenceContext(metadata) &&
      hasNoFeishuRawFailureText(item.lastError) &&
      hasFeishuFailureOutboxSource(metadata);
  }).length;
}

export function hasFeishuFailureOutboxSource(metadata: Record<string, unknown>): boolean {
  return metadata.outboxSource === "direct_outbound_message" ||
    metadata.outboxSource === "agent_reply" ||
    metadata.outboxSource === "agent_status_card" ||
    metadata.noticeType === "identity_binding_required";
}

export function countFeishuFailedDataOperationAgentBotEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) => {
    if (operation.status !== "failed") {
      return false;
    }
    const governanceContext = readFeishuGovernanceContext(operation);
    return hasFeishuAgentBotDataOperationContext(operation, governanceContext) &&
      hasNonEmptyString(operation.resourceBindingId) &&
      hasNonEmptyString(operation.operationType) &&
      hasNonEmptyString(operation.providerResourceType) &&
      hasFeishuSafeDataOperationResultSummary(operation) &&
      hasNoFeishuRawFailureText(operation.errorMessage);
  }).length;
}

export function hasNoFeishuRawFailureText(value: unknown): boolean {
  if (!hasNonEmptyString(value)) {
    return true;
  }
  return !containsFeishuSecretLikeEvidence(value) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(value);
}

export function hasFeishuAgentBotDataOperationContext(
  operation: ExternalDataOperationRunRecord,
  governanceContext: Record<string, unknown> | undefined,
): governanceContext is Record<string, unknown> {
  const botBindingId = readStringMetadata(governanceContext?.botBindingId);
  return governanceContext?.provider === FEISHU_PROVIDER_ID &&
    hasNonEmptyString(governanceContext.agentId) &&
    botBindingId === operation.integrationId &&
    hasFeishuSafeDataOperationResourceContext(governanceContext);
}

export function hasFeishuSafeDataOperationResourceContext(governanceContext: Record<string, unknown>): boolean {
  return hasNonEmptyString(governanceContext.resourceReference) &&
    governanceContext.resourceIdRedacted === true &&
    hasNoFeishuRawExternalLocationContext(governanceContext) &&
    hasNoFeishuRawProviderIdentityContext(governanceContext) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(governanceContext);
}

export function hasNoFeishuRawProviderIdentityContext(metadata: Record<string, unknown>): boolean {
  const rawIdentityFields = [
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

export function hasNoFeishuRawExternalLocationContext(metadata: Record<string, unknown>): boolean {
  const rawLocationFields = [
    "chatId",
    "externalChatId",
    "sourceChatId",
    "targetExternalChatId",
    "threadId",
    "externalThreadId",
    "sourceThreadId",
    "targetExternalThreadId",
    "chat_id",
    "external_chat_id",
    "source_chat_id",
    "target_external_chat_id",
    "thread_id",
    "external_thread_id",
    "source_thread_id",
    "target_external_thread_id",
  ];
  return rawLocationFields.every((field) => !hasNonEmptyString(metadata[field]));
}

export function hasNoFeishuRawDataOperationResourceContext(metadata: Record<string, unknown>): boolean {
  const rawResourceFields = [
    "providerResourceToken",
    "externalResourceId",
    "externalResourceToken",
    "resourceId",
    "resourceToken",
    "rawResourceToken",
    "docToken",
    "documentId",
    "sheetToken",
    "spreadsheetToken",
    "baseToken",
    "appToken",
    "tableId",
    "viewId",
    "provider_resource_token",
    "external_resource_id",
    "external_resource_token",
    "resource_id",
    "resource_token",
    "raw_resource_token",
    "doc_token",
    "document_id",
    "sheet_token",
    "spreadsheet_token",
    "base_token",
    "app_token",
    "table_id",
    "view_id",
  ];
  return rawResourceFields.every((field) => !hasNonEmptyString(metadata[field]));
}
