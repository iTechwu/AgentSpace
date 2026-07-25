import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  getWorkspaceDataDirPath,
  readActiveAgentGoogleWorkspaceDelegationSync,
  readUserSync,
} from "@dofe-agent/db";
import type {
  ExternalSheetOperationType,
  ExternalSheetResultPreview,
} from "@dofe-agent/domain/workspace";
import {
  assertAgentDocumentActionAllowedSync,
  AgentDocumentPermissionError,
  readChannelDocumentSync,
  recordExternalSheetOperationRunSync,
  sameValue,
} from "@dofe-agent/services";

export const RUNTIME_OUTPUT_EXTERNAL_SHEETS_RELATIVE_PATH = "runtime-output/external-sheets.json";
export const RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH = "runtime-output/external-sheets-results.json";
const RUNTIME_OUTPUT_ARTIFACTS_PREFIX = "runtime-output/artifacts/";
const RESULT_MEDIA_TYPE = "application/json";

type ExternalSheetCredentialSource =
  | { type: "agent_delegation"; employeeName: string }
  | { type: "user"; userId: string };

type ExternalSheetResultManifestEntry = {
  documentId: string;
  operation: ExternalSheetOperationType;
  range?: string;
  resultPath: string;
  summary: string;
  requestSummary?: string;
  rowCount?: number;
  cellCount?: number;
  headers?: string[];
  rowsPreview?: unknown[][];
  truncated?: boolean;
  preview?: ExternalSheetResultPreview;
  status?: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
};

export interface ExternalSheetOperationResult {
  runId?: string;
  documentId?: string;
  operationType?: ExternalSheetOperationType;
  status: "succeeded" | "failed";
  message: string;
  resultPath?: string;
  resultArtifactPath?: string;
  preview?: ExternalSheetResultPreview;
}

export async function applyExternalSheetOperations(input: {
  workDir: string;
  workspaceId: string;
  actorId: string;
  credentialSource?: ExternalSheetCredentialSource;
  channelName?: string;
  taskId?: string;
}): Promise<{
  warnings: string[];
  statusMessages: string[];
  operations: ExternalSheetOperationResult[];
}> {
  const warnings: string[] = [];
  const statusMessages: string[] = [];
  const operations: ExternalSheetOperationResult[] = [];

  const legacyPath = join(input.workDir, RUNTIME_OUTPUT_EXTERNAL_SHEETS_RELATIVE_PATH);
  if (existsSync(/*turbopackIgnore: true*/ legacyPath)) {
    warnings.push(
      `${RUNTIME_OUTPUT_EXTERNAL_SHEETS_RELATIVE_PATH} 已弃用：Web 后端不再代执行 gws。请在 Agent runtime 直接运行 gws，并用 dofe-agent output sheets-result add 生成 ${RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH}。`,
    );
  }

  const manifestPath = join(input.workDir, RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH);
  if (!existsSync(/*turbopackIgnore: true*/ manifestPath)) {
    return { warnings, statusMessages, operations };
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(/*turbopackIgnore: true*/ manifestPath, "utf8");
    if (containsSensitiveTokenMaterial(raw)) {
      return {
        warnings: [`${RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH} 含有疑似 Google Workspace token，已拒绝回收。`, ...warnings],
        statusMessages,
        operations,
      };
    }
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      warnings: [
        `检测到 ${RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH}，但 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
        ...warnings,
      ],
      statusMessages,
      operations,
    };
  }

  const rawResults = parsed && typeof parsed === "object" && Array.isArray((parsed as { results?: unknown }).results)
    ? (parsed as { results: unknown[] }).results
    : null;
  if (!rawResults) {
    return {
      warnings: [`${RUNTIME_OUTPUT_EXTERNAL_SHEETS_RESULTS_RELATIVE_PATH} 必须是包含 results 数组的对象。`, ...warnings],
      statusMessages,
      operations,
    };
  }

  for (const [index, rawResult] of rawResults.entries()) {
    const normalized = normalizeExternalSheetResult(rawResult);
    if ("error" in normalized) {
      warnings.push(normalized.error);
      continue;
    }

    const result = ingestExternalSheetResult({
      workDir: input.workDir,
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      credentialSource: input.credentialSource,
      channelName: input.channelName,
      taskId: input.taskId,
      result: normalized,
      index,
    });
    operations.push(result);
    statusMessages.push(result.message);
    if (result.status === "failed") {
      warnings.push(result.message);
    }
  }

  return { warnings, statusMessages, operations };
}

function ingestExternalSheetResult(input: {
  workDir: string;
  workspaceId: string;
  actorId: string;
  credentialSource?: ExternalSheetCredentialSource;
  channelName?: string;
  taskId?: string;
  result: ExternalSheetResultManifestEntry;
  index: number;
}): ExternalSheetOperationResult {
  try {
    const { document } = readChannelDocumentSync(input.result.documentId, input.workspaceId);
    if (input.channelName && !sameValue(document.channelName, input.channelName)) {
      throw new Error(`External sheet document "${document.title}" is not in channel "${input.channelName}".`);
    }
    if (
      document.kind !== "sheet" ||
      document.storageMode !== "external" ||
      document.externalProvider !== "google_workspace"
    ) {
      throw new Error(`Channel document "${document.title}" is not an external Google Sheet.`);
    }
    assertAgentDocumentActionAllowedSync({
      workspaceId: input.workspaceId,
      agentName: input.actorId,
      action: input.result.operation === "read" ? "view" : "edit",
      documentId: document.id,
      channelName: input.channelName,
    });

    const delegationAudit = resolveDelegationAudit(input.workspaceId, input.credentialSource);
    if (input.credentialSource?.type === "agent_delegation" && !delegationAudit) {
      throw new Error("google_workspace.agent_not_delegated");
    }

    const artifact = persistResultArtifact({
      workDir: input.workDir,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      resultPath: input.result.resultPath,
      index: input.index,
    });
    const responseSummary = input.result.summary;
    const run = recordExternalSheetOperationRunSync({
      channelDocumentId: document.id,
      actorType: "agent",
      actorId: input.actorId,
      delegatedUserId: delegationAudit?.delegatedUserId,
      delegatedUserDisplayName: delegationAudit?.delegatedUserDisplayName,
      delegatedGoogleEmail: delegationAudit?.delegatedGoogleEmail,
      credentialDelegationId: delegationAudit?.credentialDelegationId,
      status: input.result.status ?? "succeeded",
      intent: input.result.requestSummary ?? responseSummary,
      operationType: input.result.operation,
      rangeA1: input.result.range,
      affectedRows: input.result.rowCount,
      affectedCells: input.result.cellCount,
      requestSummary: input.result.requestSummary ?? buildRequestSummary(input.result),
      responseSummary,
      resultArtifactPath: artifact.storedPath,
      resultArtifactFileName: artifact.fileName,
      resultArtifactMediaType: RESULT_MEDIA_TYPE,
      resultArtifactSizeBytes: artifact.sizeBytes,
      resultPreview: buildResultPreview(input.result),
      errorCode: input.result.errorCode,
      errorMessage: input.result.errorMessage,
      startedAt: input.result.startedAt,
      finishedAt: input.result.finishedAt ?? new Date().toISOString(),
    }, input.workspaceId);

    return {
      runId: run.id,
      documentId: document.id,
      operationType: run.operationType,
      status: run.status === "failed" ? "failed" : "succeeded",
      message: `Google Sheet 结果已回收：${document.title} · ${run.operationType} · ${responseSummary}`,
      resultPath: input.result.resultPath,
      resultArtifactPath: artifact.storedPath,
      preview: run.resultPreview,
    };
  } catch (error) {
    if (error instanceof AgentDocumentPermissionError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      documentId: input.result.documentId,
      operationType: input.result.operation,
      status: "failed",
      message: `Google Sheet 结果回收失败：${input.result.documentId} · ${input.result.operation} · ${message}`,
    };
  }
}

function normalizeExternalSheetResult(entry: unknown): ExternalSheetResultManifestEntry | { error: string } {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { error: "external-sheets-results[].results 的每一项都必须是对象。" };
  }

  const value = entry as Record<string, unknown>;
  const documentId = typeof value.documentId === "string" ? value.documentId.trim() : "";
  const operation = normalizeOperationType(value.operation ?? value.operationType);
  const range = typeof value.range === "string"
    ? value.range.trim()
    : typeof value.rangeA1 === "string"
      ? value.rangeA1.trim()
      : undefined;
  const resultPath = typeof value.resultPath === "string" ? value.resultPath.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";

  if (!documentId) {
    return { error: "external-sheets-results[].documentId 不能为空。" };
  }
  if (!operation) {
    return { error: `external-sheets-results[${documentId}].operation 不受支持。` };
  }
  if (!resultPath) {
    return { error: `external-sheets-results[${documentId}].resultPath 不能为空。` };
  }
  if (!summary) {
    return { error: `external-sheets-results[${documentId}].summary 不能为空。` };
  }

  return {
    documentId,
    operation,
    range,
    resultPath,
    summary,
    requestSummary: normalizeOptionalString(value.requestSummary),
    rowCount: normalizeOptionalCount(value.rowCount),
    cellCount: normalizeOptionalCount(value.cellCount),
    headers: normalizeStringArray(value.headers),
    rowsPreview: normalizeRowsPreview(value.rowsPreview),
    truncated: typeof value.truncated === "boolean" ? value.truncated : undefined,
    preview: normalizePreview(value.preview),
    status: value.status === "failed" ? "failed" : "succeeded",
    errorCode: normalizeOptionalString(value.errorCode),
    errorMessage: normalizeOptionalString(value.errorMessage),
    startedAt: normalizeOptionalString(value.startedAt),
    finishedAt: normalizeOptionalString(value.finishedAt),
    durationMs: normalizeOptionalCount(value.durationMs),
  };
}

function persistResultArtifact(input: {
  workDir: string;
  workspaceId: string;
  taskId?: string;
  resultPath: string;
  index: number;
}): { storedPath: string; fileName: string; sizeBytes: number } {
  const normalized = normalizeRuntimeArtifactPath(input.resultPath);
  if (!normalized) {
    throw new Error(`resultPath must be under ${RUNTIME_OUTPUT_ARTIFACTS_PREFIX}: ${input.resultPath}`);
  }
  const sourcePath = resolve(input.workDir, normalized);
  if (!existsSync(/*turbopackIgnore: true*/ sourcePath)) {
    throw new Error(`result artifact does not exist: ${normalized}`);
  }
  const raw = readFileSync(/*turbopackIgnore: true*/ sourcePath, "utf8");
  if (containsSensitiveTokenMaterial(raw)) {
    throw new Error(`result artifact contains suspected token material: ${normalized}`);
  }
  JSON.parse(raw);

  const stats = statSync(/*turbopackIgnore: true*/ sourcePath);
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error(`result artifact must be a non-empty JSON file: ${normalized}`);
  }

  const fileName = basename(normalized);
  const artifactDir = join(
    getWorkspaceDataDirPath(input.workspaceId),
    "external-sheet-results",
    sanitizeStorageSegment(input.taskId ?? "manual"),
  );
  mkdirSync(/*turbopackIgnore: true*/ artifactDir, { recursive: true });
  const storedPath = join(artifactDir, `${String(input.index + 1).padStart(2, "0")}-${sanitizeStorageSegment(fileName)}`);
  copyFileSync(/*turbopackIgnore: true*/ sourcePath, /*turbopackIgnore: true*/ storedPath);
  return { storedPath, fileName, sizeBytes: stats.size };
}

function resolveDelegationAudit(
  workspaceId: string,
  credentialSource: ExternalSheetCredentialSource | undefined,
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

function normalizeRuntimeArtifactPath(value: string): string | null {
  const relativePath = value.replace(/\\/g, "/").trim();
  if (!relativePath || isAbsolute(relativePath)) {
    return null;
  }
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  const normalized = segments.join("/");
  if (!normalized.startsWith(RUNTIME_OUTPUT_ARTIFACTS_PREFIX)) {
    return null;
  }
  if (!normalized.toLocaleLowerCase("en-US").endsWith(".json")) {
    return null;
  }
  return normalized;
}

function buildResultPreview(result: ExternalSheetResultManifestEntry): ExternalSheetResultPreview {
  return {
    rowCount: result.preview?.rowCount ?? result.rowCount,
    cellCount: result.preview?.cellCount ?? result.cellCount,
    headers: result.preview?.headers ?? result.headers,
    rowsPreview: result.preview?.rowsPreview ?? result.rowsPreview,
    truncated: result.preview?.truncated ?? result.truncated,
  };
}

function buildRequestSummary(result: ExternalSheetResultManifestEntry): string {
  if (result.operation === "batch_update") {
    return "Batch update executed by Agent runtime gws.";
  }
  return `${result.operation} ${result.range ? `range ${result.range}` : "Google Sheet"} via Agent runtime gws.`;
}

function normalizeOperationType(value: unknown): ExternalSheetOperationType | null {
  if (value === "read" || value === "append_rows" || value === "update_values" || value === "batch_update") {
    return value;
  }
  return null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function normalizeRowsPreview(value: unknown): unknown[][] | undefined {
  return Array.isArray(value) ? value.filter((row): row is unknown[] => Array.isArray(row)) : undefined;
}

function normalizePreview(value: unknown): ExternalSheetResultPreview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as ExternalSheetResultPreview;
  return {
    rowCount: normalizeOptionalCount(candidate.rowCount),
    cellCount: normalizeOptionalCount(candidate.cellCount),
    headers: normalizeStringArray(candidate.headers),
    rowsPreview: normalizeRowsPreview(candidate.rowsPreview),
    truncated: typeof candidate.truncated === "boolean" ? candidate.truncated : undefined,
  };
}

function containsSensitiveTokenMaterial(value: string): boolean {
  return [
    /GOOGLE_WORKSPACE_CLI_TOKEN/i,
    /"refresh_token"\s*:/i,
    /"access_token"\s*:/i,
    /"client_secret"\s*:/i,
    /"private_key"\s*:/i,
    /"credentials?"\s*:/i,
    /["']?authorization["']?\s*:\s*["']?(Bearer|Basic|ya29\.)/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
    /\bya29\.[A-Za-z0-9._-]{20,}/i,
  ].some((pattern) => pattern.test(value));
}

function sanitizeStorageSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "result";
}
