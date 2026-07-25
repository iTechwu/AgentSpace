import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readActiveAgentGoogleWorkspaceDelegationSync,
  readUserSync,
} from "@dofe-agent/db";
import type { ExternalDocumentSyncStatus, ExternalSheetOperationRun, ExternalSheetOperationType } from "@dofe-agent/domain/workspace";
import {
  assertAgentDocumentActionAllowedSync,
  AgentDocumentPermissionError,
  readChannelDocumentSync,
  recordExternalSheetOperationRunSync,
  sameValue,
  updateExternalChannelDocumentMetadataSync,
  updateExternalSheetOperationRunSync,
} from "@dofe-agent/services";
import {
  appendGoogleDocText,
  batchUpdateGoogleDoc,
  getGoogleWorkspaceAccessTokenForAgent,
  getGoogleWorkspaceAccessTokenForUser,
  GoogleWorkspaceApiError,
  GOOGLE_DOCS_MIME_TYPE,
} from "@/features/integrations/google-workspace";

export const RUNTIME_OUTPUT_EXTERNAL_GOOGLE_DOCS_RELATIVE_PATH = "runtime-output/external-google-docs.json";

type ExternalGoogleDocCredentialSource =
  | { type: "agent_delegation"; employeeName: string }
  | { type: "user"; userId: string };

type ExternalGoogleDocManifestOperation =
  | {
      documentId: string;
      operationType: "append_text";
      intent: string;
      text: string;
      requestSummary?: string;
    }
  | {
      documentId: string;
      operationType: "batch_update";
      intent: string;
      requests: Array<Record<string, unknown>>;
      requestSummary?: string;
    };

export interface ExternalGoogleDocOperationResult {
  runId?: string;
  documentId?: string;
  operationType?: ExternalSheetOperationType;
  status: "succeeded" | "failed";
  message: string;
}

export async function applyExternalGoogleDocOperations(input: {
  workDir: string;
  workspaceId: string;
  actorId: string;
  credentialSource?: ExternalGoogleDocCredentialSource;
  channelName?: string;
}): Promise<{
  warnings: string[];
  statusMessages: string[];
  operations: ExternalGoogleDocOperationResult[];
}> {
  const manifestPath = join(input.workDir, RUNTIME_OUTPUT_EXTERNAL_GOOGLE_DOCS_RELATIVE_PATH);
  if (!existsSync(manifestPath)) {
    return { warnings: [], statusMessages: [], operations: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      warnings: [
        `检测到 ${RUNTIME_OUTPUT_EXTERNAL_GOOGLE_DOCS_RELATIVE_PATH}，但 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      ],
      statusMessages: [],
      operations: [],
    };
  }

  const rawOperations = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { operations?: unknown }).operations)
      ? (parsed as { operations: unknown[] }).operations
      : null;

  if (!rawOperations) {
    return {
      warnings: [`${RUNTIME_OUTPUT_EXTERNAL_GOOGLE_DOCS_RELATIVE_PATH} 必须是数组，或包含 operations 数组。`],
      statusMessages: [],
      operations: [],
    };
  }

  const getAccessToken = createAccessTokenResolver(input.workspaceId, input.credentialSource);
  const operations: ExternalGoogleDocOperationResult[] = [];
  const statusMessages: string[] = [];
  const warnings: string[] = [];
  if (rawOperations.some(isLegacyExternalGoogleDocOperation)) {
    warnings.push(
      `${RUNTIME_OUTPUT_EXTERNAL_GOOGLE_DOCS_RELATIVE_PATH} legacy hand-written operations are deprecated: Agents must use dofe-agent output google-docs ... instead of editing this JSON directly.`,
    );
  }

  for (const rawOperation of rawOperations) {
    const normalized = normalizeExternalGoogleDocOperation(rawOperation);
    if ("error" in normalized) {
      warnings.push(normalized.error);
      continue;
    }

    const result = await executeExternalGoogleDocOperation({
      workspaceId: input.workspaceId,
      channelName: input.channelName,
      actorId: input.actorId,
      getAccessToken,
      credentialSource: input.credentialSource,
      operation: normalized,
    });
    operations.push(result);
    statusMessages.push(result.message);
    if (result.status === "failed") {
      warnings.push(result.message);
    }
  }

  return { warnings, statusMessages, operations };
}

async function executeExternalGoogleDocOperation(input: {
  workspaceId: string;
  channelName?: string;
  actorId: string;
  getAccessToken: () => Promise<string>;
  credentialSource?: ExternalGoogleDocCredentialSource;
  operation: ExternalGoogleDocManifestOperation;
}): Promise<ExternalGoogleDocOperationResult> {
  let run: ExternalSheetOperationRun | undefined;
  let externalDocument: { id: string; title: string } | undefined;

  try {
    const { document } = readChannelDocumentSync(input.operation.documentId, input.workspaceId);
    externalDocument = { id: document.id, title: document.title };
    if (input.channelName && !sameValue(document.channelName, input.channelName)) {
      throw new Error(`External Google Doc "${document.title}" is not in channel "${input.channelName}".`);
    }
    if (
      document.storageMode !== "external" ||
      document.externalProvider !== "google_workspace" ||
      document.externalMimeType !== GOOGLE_DOCS_MIME_TYPE ||
      !document.externalFileId
    ) {
      throw new Error(`Channel document "${document.title}" is not an external Google Doc.`);
    }
    assertAgentDocumentActionAllowedSync({
      workspaceId: input.workspaceId,
      agentName: input.actorId,
      action: "edit",
      documentId: document.id,
      channelName: input.channelName,
    });

    const delegationAudit = resolveDelegationAudit(input.workspaceId, input.credentialSource);
    run = recordExternalSheetOperationRunSync({
      channelDocumentId: document.id,
      actorType: "agent",
      actorId: input.actorId,
      delegatedUserId: delegationAudit?.delegatedUserId,
      delegatedUserDisplayName: delegationAudit?.delegatedUserDisplayName,
      delegatedGoogleEmail: delegationAudit?.delegatedGoogleEmail,
      credentialDelegationId: delegationAudit?.credentialDelegationId,
      status: "running",
      intent: input.operation.intent,
      operationType: input.operation.operationType,
      requestSummary: input.operation.requestSummary ?? buildRequestSummary(input.operation),
    }, input.workspaceId);

    const accessToken = await input.getAccessToken();
    const response = await callGoogleDocOperation({
      accessToken,
      documentId: document.externalFileId,
      operation: input.operation,
    });

    const updated = updateExternalSheetOperationRunSync({
      runId: run.id,
      status: "succeeded",
      affectedRows: response.affectedRows,
      responseSummary: response.responseSummary,
    }, input.workspaceId);
    return {
      runId: updated.id,
      documentId: document.id,
      operationType: input.operation.operationType,
      status: "succeeded",
      message: `Google Doc 操作成功：${document.title} · ${input.operation.operationType} · ${response.responseSummary}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (run) {
      const nextSyncStatus = resolveExternalDocumentSyncStatusFromError(error);
      if (externalDocument && nextSyncStatus) {
        updateExternalChannelDocumentMetadataSync({
          documentId: externalDocument.id,
          externalSyncStatus: nextSyncStatus,
          updatedBy: "系统提示",
        }, input.workspaceId);
      }
      updateExternalSheetOperationRunSync({
        runId: run.id,
        status: "failed",
        errorCode: error instanceof GoogleWorkspaceApiError
          ? error.code
          : error instanceof Error
            ? error.name
            : "Error",
        errorMessage: message,
      }, input.workspaceId);
    }
    if (error instanceof AgentDocumentPermissionError) {
      throw error;
    }
    return {
      runId: run?.id,
      documentId: input.operation.documentId,
      operationType: input.operation.operationType,
      status: "failed",
      message: `Google Doc 操作失败：${input.operation.documentId} · ${input.operation.operationType} · ${message}`,
    };
  }
}

async function callGoogleDocOperation(input: {
  accessToken: string;
  documentId: string;
  operation: ExternalGoogleDocManifestOperation;
}): Promise<{
  affectedRows?: number;
  responseSummary: string;
}> {
  if (input.operation.operationType === "append_text") {
    const response = await appendGoogleDocText({
      accessToken: input.accessToken,
      documentId: input.documentId,
      text: input.operation.text,
    });
    return {
      affectedRows: 1,
      responseSummary: `Appended text with ${response.replyCount} batch update replies.`,
    };
  }

  const response = await batchUpdateGoogleDoc({
    accessToken: input.accessToken,
    documentId: input.documentId,
    requests: input.operation.requests,
  });
  return {
    responseSummary: `Applied ${response.replyCount ?? input.operation.requests.length} Docs batch update replies.`,
  };
}

function normalizeExternalGoogleDocOperation(entry: unknown): ExternalGoogleDocManifestOperation | { error: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { error: "external-google-docs[] 的每一项都必须是对象。" };
  }

  const value = entry as Record<string, unknown>;
  const documentId = typeof value.documentId === "string" ? value.documentId.trim() : "";
  const intent = typeof value.intent === "string" ? value.intent.trim() : "";
  const operationType = normalizeOperationType(value.operationType);
  if (!documentId) {
    return { error: "external-google-docs[].documentId 不能为空。" };
  }
  if (!intent) {
    return { error: `external-google-docs[${documentId}].intent 不能为空。` };
  }
  if (!operationType) {
    return { error: `external-google-docs[${documentId}].operationType 不受支持。` };
  }

  if (operationType === "append_text") {
    const text = typeof value.text === "string" ? value.text : "";
    if (!text) {
      return { error: `external-google-docs[${documentId}].text 不能为空。` };
    }
    return {
      documentId,
      operationType,
      intent,
      text,
      requestSummary: normalizeOptionalString(value.requestSummary),
    };
  }

  const requests = normalizeBatchRequests(value.requests);
  if ("error" in requests) {
    return requests;
  }
  return {
    documentId,
    operationType,
    intent,
    requests,
    requestSummary: normalizeOptionalString(value.requestSummary),
  };
}

function isLegacyExternalGoogleDocOperation(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const value = entry as Record<string, unknown>;
  if (value.operationType === "append_text") {
    return typeof value.textPath !== "string" || value.textPath.trim().length === 0;
  }
  if (value.operationType === "batch_update") {
    return typeof value.requestsPath !== "string" || value.requestsPath.trim().length === 0;
  }
  return false;
}

function normalizeOperationType(value: unknown): ExternalGoogleDocManifestOperation["operationType"] | null {
  if (value === "append_text" || value === "batch_update") {
    return value;
  }
  return null;
}

function normalizeBatchRequests(value: unknown): Array<Record<string, unknown>> | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "external-google-docs[].requests 必须是非空数组。" };
  }
  const requests: Array<Record<string, unknown>> = [];
  for (const request of value) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      return { error: "external-google-docs[].requests 每一项都必须是对象。" };
    }
    requests.push(request as Record<string, unknown>);
  }
  return requests;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildRequestSummary(operation: ExternalGoogleDocManifestOperation): string {
  if (operation.operationType === "append_text") {
    return `append_text ${operation.text.length} character(s).`;
  }
  return `batch_update ${operation.requests.length} request(s).`;
}

function createAccessTokenResolver(workspaceId: string, credentialSource: ExternalGoogleDocCredentialSource | undefined): () => Promise<string> {
  let accessTokenPromise: Promise<string> | undefined;
  return async () => {
    if (!credentialSource) {
      throw new Error("Google Workspace credential user is missing for this task.");
    }
    accessTokenPromise ??= credentialSource.type === "agent_delegation"
      ? getGoogleWorkspaceAccessTokenForAgent({
          workspaceId,
          employeeName: credentialSource.employeeName,
        }).then((result) => result.accessToken)
      : getGoogleWorkspaceAccessTokenForUser({
          workspaceId,
          userId: credentialSource.userId,
        }).then((result) => result.accessToken);
    return accessTokenPromise;
  };
}

function resolveDelegationAudit(
  workspaceId: string,
  credentialSource: ExternalGoogleDocCredentialSource | undefined,
): {
  delegatedUserId?: string;
  delegatedUserDisplayName?: string;
  delegatedGoogleEmail?: string;
  credentialDelegationId?: string;
} | undefined {
  if (credentialSource?.type !== "agent_delegation") {
    return undefined;
  }
  const delegation = readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId,
    employeeName: credentialSource.employeeName,
  });
  if (!delegation) {
    return undefined;
  }
  return {
    delegatedUserId: delegation.userId,
    delegatedUserDisplayName: readUserSync(delegation.userId)?.displayName,
    delegatedGoogleEmail: delegation.googleEmail,
    credentialDelegationId: delegation.id,
  };
}

function resolveExternalDocumentSyncStatusFromError(error: unknown): ExternalDocumentSyncStatus | undefined {
  if (error instanceof GoogleWorkspaceApiError) {
    if (error.status === 401 || error.status === 403) {
      return "permission_error";
    }
    if (error.status === 404) {
      return "missing";
    }
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    message === "google_workspace.not_connected" ||
    message === "google_workspace.reconnect_required" ||
    message === "google_workspace.agent_not_delegated" ||
    message === "google_workspace.agent_delegation_reconnect_required" ||
    message === "Google Workspace credential user is missing for this task."
  ) {
    return "permission_error";
  }
  return undefined;
}
