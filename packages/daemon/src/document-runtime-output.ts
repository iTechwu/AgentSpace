import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getWorkspaceDataDirPath } from "@dofe-agent/db";
import {
  createDocumentPermissionRequestSync,
  createExternalGoogleSheetChannelDocumentSync,
  recordExternalSheetOperationRunSync,
  readChannelDocumentSync,
  readWorkspaceStateSync,
  assertAgentDocumentActionAllowedSync,
  AgentDocumentPermissionError,
  type DocumentPermissionRequestExternalProvider,
  type DocumentPermissionRequestRecord,
} from "@dofe-agent/services";
import type { ChannelDocument } from "@dofe-agent/domain/workspace";
import {
  readActiveAgentGoogleWorkspaceDelegationSync,
  readUserSync,
} from "@dofe-agent/db";
import {
  readDocumentPermissionRequestsManifest,
  readExternalDocumentsManifest,
  type DocumentPermissionRequestManifestEntry,
  type ExternalDocumentCreateGoogleSheetManifestEntry,
  type ExternalDocumentLinkManifestEntry,
  type ExternalDocumentManifestEntry,
} from "./runtime-output-manifests.ts";
import {
  getRuntimeOutputExternalDocumentsPath,
  getRuntimeOutputPermissionRequestsPath,
  RUNTIME_OUTPUT_EXTERNAL_DOCUMENTS_RELATIVE_PATH,
  RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH,
} from "./runtime-output.ts";

const RUNTIME_OUTPUT_ARTIFACTS_PREFIX = "runtime-output/artifacts/";
const GOOGLE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const RESULT_MEDIA_TYPE = "application/json";

export interface AppliedExternalDocumentLinkOperation {
  operationType: "link_google_sheet" | "create_google_sheet";
  status: "succeeded" | "failed";
  sourceDocumentId?: string;
  documentId?: string;
  targetChannel: string;
  externalFileId?: string;
  externalUrl?: string;
  title?: string;
  message: string;
  permissionSync?: {
    documentId: string;
    externalFileId?: string;
    delegatedUserId?: string;
    delegatedGoogleEmail?: string;
  };
}

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
  externalDocumentLinks: AppliedExternalDocumentLinkOperation[];
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
  const externalDocumentLinks: AppliedExternalDocumentLinkOperation[] = [];
  const permissionRequests: AppliedDocumentPermissionRequest[] = [];

  const provenanceWarnings = assertControlledDocumentRuntimeOutputManifests(input.workDir);
  warnings.push(...provenanceWarnings);
  statusMessages.push(...provenanceWarnings);
  if (provenanceWarnings.length > 0) {
    return {
      warnings,
      statusMessages,
      externalDocumentLinks,
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

  for (const operation of readExternalDocumentsManifest(input.workDir).operations) {
    const result = applyExternalDocumentManifestEntry(input, operation);
    externalDocumentLinks.push(result);
    statusMessages.push(result.message);
    if (result.status === "failed") {
      warnings.push(result.message);
    }
  }

  return {
    warnings,
    statusMessages,
    externalDocumentLinks,
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
    assertControlledDocumentRuntimeOutputManifest(
      getRuntimeOutputExternalDocumentsPath(workDir),
      RUNTIME_OUTPUT_EXTERNAL_DOCUMENTS_RELATIVE_PATH,
      "dofe-agent output external-document link-google-sheet/create-google-sheet",
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
  try {
    const documentId = normalizeOptional(entry.documentId);
    const externalFileId = normalizeOptional(entry.externalFileId) ?? extractGoogleWorkspaceFileId(entry.externalUrl);
    const externalUrl = normalizeOptional(entry.externalUrl);
    const request = createDocumentPermissionRequestSync({
      workspaceId: context.workspaceId,
      documentId,
      externalProvider: normalizeExternalProvider(entry.externalProvider ?? (externalFileId || externalUrl ? "google_workspace" : undefined)),
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
      documentId: normalizeOptional(entry.documentId),
      externalFileId: normalizeOptional(entry.externalFileId),
      externalUrl: normalizeOptional(entry.externalUrl),
      targetChannel: normalizeOptional(entry.targetChannel),
      message: `${RUNTIME_OUTPUT_PERMISSION_REQUESTS_RELATIVE_PATH} 权限申请回收失败：${errorMessage(error)}`,
    };
  }
}

function applyExternalDocumentLinkManifestEntry(
  context: {
    workspaceId: string;
    actorName: string;
    sourceTaskQueueId: string;
    sourceChannelName?: string;
    requestedByUserId?: string;
    requestedByDisplayName?: string;
  },
  entry: ExternalDocumentLinkManifestEntry,
): AppliedExternalDocumentLinkOperation {
  const targetChannel = entry.targetChannel.trim();
  try {
    assertTargetChannelAllowed({
      workspaceId: context.workspaceId,
      actorName: context.actorName,
      targetChannel,
      requestedByUserId: context.requestedByUserId,
      requestedByDisplayName: context.requestedByDisplayName,
    });
    const source = resolveExternalGoogleSheetLinkSource({
      workspaceId: context.workspaceId,
      actorName: context.actorName,
      sourceChannelName: context.sourceChannelName,
      operation: entry,
    });
    assertGoogleWorkspaceDelegationAvailable({
      workspaceId: context.workspaceId,
      actorName: context.actorName,
      externalFileId: source.externalFileId,
    });
    assertExternalDocumentNotAlreadyLinked({
      workspaceId: context.workspaceId,
      targetChannel,
      externalFileId: source.externalFileId,
    });
    const created = createExternalGoogleSheetChannelDocumentSync({
      channelName: targetChannel,
      title: entry.title,
      externalFileId: source.externalFileId,
      externalUrl: source.externalUrl,
      externalMimeType: source.externalMimeType,
      externalRevisionId: source.externalRevisionId,
      externalUpdatedAt: source.externalUpdatedAt,
      summary: entry.summary ?? source.summary,
      createdBy: context.actorName,
      createdByType: "agent",
    }, context.workspaceId);
    recordExternalSheetOperationRunSync({
      channelDocumentId: source.document?.id ?? created.document.id,
      externalFileId: source.externalFileId,
      actorType: "agent",
      actorId: context.actorName,
      delegatedUserId: source.delegatedUserId,
      delegatedUserDisplayName: source.delegatedUserDisplayName,
      delegatedGoogleEmail: source.delegatedGoogleEmail,
      credentialDelegationId: source.credentialDelegationId,
      status: "succeeded",
      intent: `Forward Google Sheet to ${targetChannel}`,
      operationType: "metadata_refresh",
      requestSummary: `Forwarded Google Sheet ${source.externalFileId} to ${targetChannel}.`,
      responseSummary: "External sheet channel binding created by controlled runtime output.",
      startedAt: created.version.createdAt,
      finishedAt: created.version.createdAt,
    }, context.workspaceId);
    return {
      operationType: "link_google_sheet",
      status: "succeeded",
      sourceDocumentId: source.document?.id,
      documentId: created.document.id,
      targetChannel,
      externalFileId: source.externalFileId,
      externalUrl: source.externalUrl,
      title: created.document.title,
      message: `Google Sheet 已转发到 ${targetChannel}：${created.document.title}`,
    };
  } catch (error) {
    if (error instanceof AgentDocumentPermissionError) {
      throw error;
    }
    return {
      operationType: "link_google_sheet",
      status: "failed",
      sourceDocumentId: normalizeOptional(entry.sourceDocumentId),
      targetChannel,
      externalFileId: normalizeOptional(entry.externalFileId),
      externalUrl: normalizeOptional(entry.externalUrl),
      title: normalizeOptional(entry.title),
      message: `${RUNTIME_OUTPUT_EXTERNAL_DOCUMENTS_RELATIVE_PATH} 转发回收失败：${errorMessage(error)}`,
    };
  }
}

function applyExternalDocumentManifestEntry(
  context: {
    workDir: string;
    workspaceId: string;
    actorName: string;
    sourceTaskQueueId: string;
    sourceChannelName?: string;
    requestedByUserId?: string;
    requestedByDisplayName?: string;
  },
  entry: ExternalDocumentManifestEntry,
): AppliedExternalDocumentLinkOperation {
  if (entry.operationType === "create_google_sheet") {
    return applyExternalDocumentCreateGoogleSheetManifestEntry(context, entry);
  }
  return applyExternalDocumentLinkManifestEntry(context, entry);
}

function applyExternalDocumentCreateGoogleSheetManifestEntry(
  context: {
    workDir: string;
    workspaceId: string;
    actorName: string;
    sourceTaskQueueId: string;
    requestedByUserId?: string;
    requestedByDisplayName?: string;
  },
  entry: ExternalDocumentCreateGoogleSheetManifestEntry,
): AppliedExternalDocumentLinkOperation {
  const targetChannel = entry.targetChannel.trim();
  try {
    if (process.env.DOFE_AGENT_AGENT_GOOGLE_SHEET_CREATE_ENABLED === "false") {
      throw new Error("agent-created Google Sheet creation is disabled.");
    }
    assertTargetChannelAllowed({
      workspaceId: context.workspaceId,
      actorName: context.actorName,
      targetChannel,
      requestedByUserId: context.requestedByUserId,
      requestedByDisplayName: context.requestedByDisplayName,
    });
    assertGoogleWorkspaceDelegationAvailable({
      workspaceId: context.workspaceId,
      actorName: context.actorName,
      externalFileId: entry.externalFileId,
      action: "edit",
    });
    assertExternalDocumentNotAlreadyLinked({
      workspaceId: context.workspaceId,
      targetChannel,
      externalFileId: entry.externalFileId,
    });
    const artifact = readAndPersistCreateResultArtifact({
      workDir: context.workDir,
      workspaceId: context.workspaceId,
      taskId: context.sourceTaskQueueId,
      resultPath: entry.resultPath,
      externalFileId: entry.externalFileId,
      externalUrl: entry.externalUrl,
    });
    const delegationAudit = resolveDelegationAudit(context.workspaceId, context.actorName);
    const created = createExternalGoogleSheetChannelDocumentSync({
      channelName: targetChannel,
      title: entry.title,
      externalFileId: entry.externalFileId,
      externalUrl: entry.externalUrl,
      externalMimeType: entry.externalMimeType ?? artifact.mimeType,
      externalRevisionId: entry.externalRevisionId,
      externalUpdatedAt: entry.externalUpdatedAt ?? artifact.modifiedTime,
      summary: entry.summary,
      createdBy: context.actorName,
      createdByType: "agent",
      triggerType: "agent",
      sourceTaskQueueId: context.sourceTaskQueueId,
      recordMetadataRun: false,
    }, context.workspaceId);
    recordExternalSheetOperationRunSync({
      channelDocumentId: created.document.id,
      externalFileId: entry.externalFileId,
      actorType: "agent",
      actorId: context.actorName,
      delegatedUserId: delegationAudit.delegatedUserId,
      delegatedUserDisplayName: delegationAudit.delegatedUserDisplayName,
      delegatedGoogleEmail: delegationAudit.delegatedGoogleEmail,
      credentialDelegationId: delegationAudit.credentialDelegationId,
      status: "succeeded",
      intent: `Create Google Sheet in ${targetChannel}`,
      operationType: "create",
      requestSummary: `Created Google Sheet ${entry.externalFileId} and registered it in channel ${targetChannel}.`,
      responseSummary: "Agent-created Google Sheet channel binding created by controlled runtime output.",
      resultArtifactPath: artifact.storedPath,
      resultArtifactFileName: artifact.fileName,
      resultArtifactMediaType: RESULT_MEDIA_TYPE,
      resultArtifactSizeBytes: artifact.sizeBytes,
      startedAt: created.version.createdAt,
      finishedAt: created.version.createdAt,
    }, context.workspaceId);
    return {
      operationType: "create_google_sheet",
      status: "succeeded",
      documentId: created.document.id,
      targetChannel,
      externalFileId: entry.externalFileId,
      externalUrl: entry.externalUrl,
      title: created.document.title,
      message: `Google Sheet 已创建并添加到 ${targetChannel}：${created.document.title}`,
      permissionSync: {
        documentId: created.document.id,
        externalFileId: entry.externalFileId,
        delegatedUserId: delegationAudit.delegatedUserId,
        delegatedGoogleEmail: delegationAudit.delegatedGoogleEmail,
      },
    };
  } catch (error) {
    if (error instanceof AgentDocumentPermissionError) {
      throw error;
    }
    return {
      operationType: "create_google_sheet",
      status: "failed",
      targetChannel,
      externalFileId: normalizeOptional(entry.externalFileId),
      externalUrl: normalizeOptional(entry.externalUrl),
      title: normalizeOptional(entry.title),
      message: `${RUNTIME_OUTPUT_EXTERNAL_DOCUMENTS_RELATIVE_PATH} 新建 Google Sheet 回收失败：${errorMessage(error)}`,
    };
  }
}

function resolveExternalGoogleSheetLinkSource(input: {
  workspaceId: string;
  actorName: string;
  sourceChannelName?: string;
  operation: ExternalDocumentLinkManifestEntry;
}): {
  document?: ChannelDocument;
  externalFileId: string;
  externalUrl: string;
  externalMimeType?: string;
  externalRevisionId?: string;
  externalUpdatedAt?: string;
  summary?: string;
  credentialDelegationId?: string;
  delegatedUserId?: string;
  delegatedUserDisplayName?: string;
  delegatedGoogleEmail?: string;
} {
  const sourceDocumentId = normalizeOptional(input.operation.sourceDocumentId);
  if (sourceDocumentId) {
    assertAgentDocumentActionAllowedSync({
      workspaceId: input.workspaceId,
      agentName: input.actorName,
      action: "forward",
      documentId: sourceDocumentId,
      channelName: input.sourceChannelName,
    });
    const { document } = readChannelDocumentSync(sourceDocumentId, input.workspaceId);
    if (
      document.kind !== "sheet" ||
      document.storageMode !== "external" ||
      document.externalProvider !== "google_workspace" ||
      !document.externalFileId ||
      !document.externalUrl
    ) {
      throw new Error(`Source document "${document.title}" is not an external Google Sheet.`);
    }
    return {
      document,
      externalFileId: document.externalFileId,
      externalUrl: document.externalUrl,
      externalMimeType: document.externalMimeType,
      externalRevisionId: document.externalRevisionId,
      externalUpdatedAt: document.externalUpdatedAt,
      summary: input.operation.summary ?? document.summary,
      ...resolveDelegationAudit(input.workspaceId, input.actorName),
    };
  }

  const externalFileId = normalizeOptional(input.operation.externalFileId) ?? extractGoogleWorkspaceFileId(input.operation.externalUrl);
  const externalUrl = normalizeOptional(input.operation.externalUrl) ?? (externalFileId ? `https://docs.google.com/spreadsheets/d/${externalFileId}/edit` : undefined);
  if (!externalFileId || !externalUrl) {
    throw new Error("link-google-sheet requires sourceDocumentId, externalFileId, or a Google Sheets URL.");
  }
  assertAgentDocumentActionAllowedSync({
    workspaceId: input.workspaceId,
    agentName: input.actorName,
    action: "forward",
    externalProvider: "google_workspace",
    externalFileId,
    channelName: input.sourceChannelName,
  });
  return {
    externalFileId,
    externalUrl,
    externalMimeType: "application/vnd.google-apps.spreadsheet",
    summary: input.operation.summary,
    ...resolveDelegationAudit(input.workspaceId, input.actorName),
  };
}

function assertTargetChannelAllowed(input: {
  workspaceId: string;
  actorName: string;
  targetChannel: string;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
}): void {
  const state = readWorkspaceStateSync(input.workspaceId);
  const targetChannel = state.channels.find((channel) => sameValue(channel.name, input.targetChannel));
  if (!targetChannel) {
    throw new Error(`Target channel "${input.targetChannel}" does not exist.`);
  }
  const agent = state.activeEmployees.find((employee) => sameValue(employee.name, input.actorName));
  if (!agent?.channels.some((channelName) => sameValue(channelName, targetChannel.name))) {
    throw new Error(`Agent "${input.actorName}" cannot post or forward documents in channel "${targetChannel.name}".`);
  }
  if (!input.requestedByUserId) {
    return;
  }
  const requester = readUserSync(input.requestedByUserId);
  const requesterLabel = input.requestedByDisplayName?.trim() || requester?.displayName || input.requestedByUserId;
  const requesterCanReadChannel = (targetChannel.humanMemberNames ?? []).some((name) => sameValue(name, requesterLabel));
  if (!requesterCanReadChannel) {
    throw new Error(`Triggering user "${requesterLabel}" cannot access target channel "${targetChannel.name}".`);
  }
}

function assertExternalDocumentNotAlreadyLinked(input: {
  workspaceId: string;
  targetChannel: string;
  externalFileId: string;
}): void {
  const state = readWorkspaceStateSync(input.workspaceId);
  const existing = state.channelDocuments.find((document) =>
    document.status === "active" &&
    sameValue(document.channelName, input.targetChannel) &&
    document.storageMode === "external" &&
    document.externalProvider === "google_workspace" &&
    document.externalFileId === input.externalFileId,
  );
  if (existing) {
    throw new Error(`Google Sheet "${input.externalFileId}" is already linked in channel "${input.targetChannel}" as "${existing.title}".`);
  }
}

function assertGoogleWorkspaceDelegationAvailable(input: {
  workspaceId: string;
  actorName: string;
  externalFileId: string;
  action?: "edit" | "forward";
}): void {
  const delegation = readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId: input.workspaceId,
    employeeName: input.actorName,
  });
  if (!delegation) {
    throw new AgentDocumentPermissionError({
      code: "provider.document_external_auth_unavailable",
      agentName: input.actorName,
      action: input.action ?? "forward",
      documentId: input.externalFileId,
      message: `provider.document_external_auth_unavailable: Agent "${input.actorName}" has no active Google Workspace delegation for document "${input.externalFileId}".`,
    });
  }
}

function readAndPersistCreateResultArtifact(input: {
  workDir: string;
  workspaceId: string;
  taskId: string;
  resultPath: string;
  externalFileId: string;
  externalUrl: string;
}): {
  storedPath: string;
  fileName: string;
  sizeBytes: number;
  mimeType?: string;
  modifiedTime?: string;
} {
  const normalized = normalizeRuntimeArtifactPath(input.resultPath);
  if (!normalized) {
    throw new Error(`resultPath must be under ${RUNTIME_OUTPUT_ARTIFACTS_PREFIX}: ${input.resultPath}`);
  }
  const sourcePath = resolve(input.workDir, normalized);
  if (!existsSync(sourcePath)) {
    throw new Error(`create result artifact does not exist: ${normalized}`);
  }
  const stats = statSync(sourcePath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`create result artifact must be a non-empty JSON file: ${normalized}`);
  }
  const raw = readFileSync(sourcePath, "utf8");
  const parsed = parseCreateGoogleSheetResult(raw);
  assertCreateGoogleSheetResultMatches(parsed, input);

  const fileName = basename(normalized);
  const artifactDir = join(
    getWorkspaceDataDirPath(input.workspaceId),
    "external-sheet-results",
    sanitizeStorageSegment(input.taskId),
  );
  mkdirSync(artifactDir, { recursive: true });
  const storedPath = join(artifactDir, `create-${sanitizeStorageSegment(fileName)}`);
  copyFileSync(sourcePath, storedPath);
  return {
    storedPath,
    fileName,
    sizeBytes: stats.size,
    mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : undefined,
    modifiedTime: typeof parsed.modifiedTime === "string" ? parsed.modifiedTime : undefined,
  };
}

function parseCreateGoogleSheetResult(raw: string): Record<string, unknown> {
  if (containsSensitiveTokenMaterial(raw)) {
    throw new Error("create result artifact contains suspected token material.");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("create result artifact must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function assertCreateGoogleSheetResultMatches(
  parsed: Record<string, unknown>,
  input: {
    externalFileId: string;
    externalUrl: string;
  },
): void {
  if (parsed.id !== undefined && parsed.id !== input.externalFileId) {
    throw new Error("create result artifact id does not match externalFileId.");
  }
  if (parsed.mimeType !== undefined && parsed.mimeType !== GOOGLE_SHEET_MIME_TYPE) {
    throw new Error(`create result artifact mimeType must be ${GOOGLE_SHEET_MIME_TYPE}.`);
  }
  const urlFileId = extractGoogleWorkspaceFileId(input.externalUrl);
  if (!urlFileId || urlFileId !== input.externalFileId) {
    throw new Error("externalUrl must be a Google Sheets URL for externalFileId.");
  }
  const artifactUrlFileId = extractGoogleWorkspaceFileId(typeof parsed.webViewLink === "string" ? parsed.webViewLink : undefined);
  if (artifactUrlFileId && artifactUrlFileId !== input.externalFileId) {
    throw new Error("create result artifact webViewLink does not match externalFileId.");
  }
}

function normalizeRuntimeArtifactPath(value: string): string | null {
  const relativePath = value.replace(/\\/g, "/").trim();
  if (!relativePath || relativePath.includes("\0") || relativePath.startsWith("/") || /^[A-Za-z]:\//.test(relativePath)) {
    return null;
  }
  if (!relativePath.startsWith(RUNTIME_OUTPUT_ARTIFACTS_PREFIX)) {
    return null;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === ".." || part === ".")) {
    return null;
  }
  return relativePath;
}

function containsSensitiveTokenMaterial(raw: string): boolean {
  return [
    /GOOGLE_WORKSPACE_CLI_TOKEN/i,
    /"refresh_token"\s*:/i,
    /"access_token"\s*:/i,
    /"client_secret"\s*:/i,
    /["']?authorization["']?\s*:\s*["']?(Bearer|Basic|ya29\.)/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
    /\bya29\.[A-Za-z0-9._-]{20,}/i,
  ].some((pattern) => pattern.test(raw));
}

function sanitizeStorageSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
}

function resolveDelegationAudit(
  workspaceId: string,
  actorName: string,
): {
  credentialDelegationId?: string;
  delegatedUserId?: string;
  delegatedUserDisplayName?: string;
  delegatedGoogleEmail?: string;
} {
  const delegation = readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId,
    employeeName: actorName,
  });
  if (!delegation) {
    return {};
  }
  return {
    credentialDelegationId: delegation.id,
    delegatedUserId: delegation.userId,
    delegatedUserDisplayName: readUserSync(delegation.userId)?.displayName,
    delegatedGoogleEmail: delegation.googleEmail,
  };
}

function extractGoogleWorkspaceFileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /\/(?:spreadsheets|document)\/d\/([^/?#]+)/.exec(trimmed);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function normalizeExternalProvider(
  value: DocumentPermissionRequestManifestEntry["externalProvider"] | undefined,
): DocumentPermissionRequestExternalProvider | undefined {
  if (value === "google_workspace" || value === "notion" || value === "microsoft_365") {
    return value;
  }
  return undefined;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sameValue(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
