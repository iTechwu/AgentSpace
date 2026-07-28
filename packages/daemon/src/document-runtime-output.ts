import { readFileSync } from "node:fs";
import {
  createDocumentPermissionRequestSync,
  type DocumentPermissionRequestExternalProvider,
} from "@dofe-agent/services";
import {
  readDocumentPermissionRequestsManifest,
  type DocumentPermissionRequestManifestEntry,
} from "./runtime-output-manifests.ts";
import {
  getRuntimeOutputPermissionRequestsPath,
  RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH,
} from "./runtime-output.ts";

export interface AppliedDocumentPermissionRequest {
  status: "created" | "failed";
  requestId?: string;
  requestedRole?: "viewer" | "editor" | "forwarder";
  documentId?: string;
  externalFileId?: string;
  externalUrl?: string;
  targetChannel?: string;
  message: string;
}

export interface DocumentRuntimeOutputResult {
  warnings: string[];
  statusMessages: string[];
  permissionRequests: AppliedDocumentPermissionRequest[];
}

export function applyDocumentRuntimeOutputOperations(input: {
  workDir: string;
  workspaceId: string;
  actorName: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
}): DocumentRuntimeOutputResult {
  const warnings: string[] = [];
  const statusMessages: string[] = [];
  const permissionRequests: AppliedDocumentPermissionRequest[] = [];

  const provenanceWarnings = assertControlledDocumentRuntimeOutputManifests(input.workDir);
  warnings.push(...provenanceWarnings);
  statusMessages.push(...provenanceWarnings);
  if (provenanceWarnings.length > 0) {
    return {
      warnings,
      statusMessages,
      permissionRequests,
    };
  }

  for (const request of readDocumentPermissionRequestsManifest(input.workDir).requests) {
    const result = applyDocumentPermissionRequestManifestEntry(input, request);
    permissionRequests.push(result);
    statusMessages.push(result.message);
    if (result.status === "failed") {
      warnings.push(result.message);
    }
  }

  return {
    warnings,
    statusMessages,
    permissionRequests,
  };
}

function assertControlledDocumentRuntimeOutputManifests(workDir: string): string[] {
  return [
    assertControlledDocumentRuntimeOutputManifest(
      getRuntimeOutputPermissionRequestsPath(workDir),
      RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH,
      "dofe-agent output permission request-document",
    ),
  ].filter((message): message is string => Boolean(message));
}

function assertControlledDocumentRuntimeOutputManifest(
  path: string,
  relativePath: string,
  command: string,
): string | undefined {
  try {
    const raw = readFileIfExists(path);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    if ((parsed as { generatedBy?: unknown }).generatedBy === "dofe-agent-cli") {
      return undefined;
    }
    return `${relativePath} 已被拒绝：请使用 ${command} 生成受控 manifest，不要手写 JSON。`;
  } catch (error) {
    return `${relativePath} 已被拒绝：manifest 无法验证来源（${errorMessage(error)}）。`;
  }
}

function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function applyDocumentPermissionRequestManifestEntry(
  context: {
    workspaceId: string;
    actorName: string;
    sourceTaskQueueId: string;
    requestedByUserId?: string;
  },
  entry: DocumentPermissionRequestManifestEntry,
): AppliedDocumentPermissionRequest {
  const documentId = normalizeOptional(entry.documentId);
  const externalProvider = normalizeExternalProvider(entry.externalProvider);
  const externalFileId = normalizeOptional(entry.externalFileId);
  const externalUrl = normalizeOptional(entry.externalUrl);
  try {
    const request = createDocumentPermissionRequestSync({
      workspaceId: context.workspaceId,
      documentId,
      externalProvider,
      externalFileId,
      externalUrl,
      requestedRole: entry.requestedRole,
      requestedByAgentName: context.actorName,
      requestedForChannelName: normalizeOptional(entry.targetChannel),
      triggeredByUserId: context.requestedByUserId,
      reason: entry.reason,
      sourceTaskId: context.sourceTaskQueueId,
    });
    return {
      status: "created",
      requestId: request.id,
      requestedRole: request.requestedRole,
      documentId: request.documentId,
      externalFileId: request.externalFileId,
      externalUrl: request.externalUrl,
      targetChannel: request.requestedForChannelName,
      message: `文档权限申请已创建：${request.requestedByAgentName} -> ${request.requestedRole}${request.documentId ? ` · ${request.documentId}` : ""}`,
    };
  } catch (error) {
    return {
      status: "failed",
      requestedRole: entry.requestedRole,
      documentId,
      externalFileId,
      externalUrl,
      targetChannel: normalizeOptional(entry.targetChannel),
      message: `${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH} 权限申请回收失败：${errorMessage(error)}`,
    };
  }
}

function normalizeExternalProvider(
  value: DocumentPermissionRequestManifestEntry["externalProvider"] | undefined,
): DocumentPermissionRequestExternalProvider | undefined {
  if (value === "notion" || value === "microsoft_365") {
    return value;
  }
  return undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
