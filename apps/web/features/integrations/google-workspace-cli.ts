import { execFile } from "node:child_process";
import { readServerEnvValue } from "@/features/auth/server-env";
import { GoogleWorkspaceApiError } from "./google-workspace-errors";

const DEFAULT_GOOGLE_WORKSPACE_CLI_BINARY = "gws";
const DEFAULT_GOOGLE_WORKSPACE_CLI_TIMEOUT_MS = 30_000;
export const GOOGLE_WORKSPACE_CLI_TOKEN_ENV = "GOOGLE_WORKSPACE_CLI_TOKEN";
const GOOGLE_WORKSPACE_CLI_FORMAT_ARGS = ["--format", "json"] as const;
export const GOOGLE_WORKSPACE_EXECUTOR_ENV = "AGENT_SPACE_GOOGLE_WORKSPACE_EXECUTOR";
export const DEFAULT_GOOGLE_WORKSPACE_EXECUTOR = "gws";

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
type ExecFileLike = (
  file: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
  callback: ExecFileCallback,
) => void;

export interface GoogleWorkspaceCliRunOptions {
  binaryPath?: string;
  timeoutMs?: number;
  failureCode?: string;
  execFileImpl?: ExecFileLike;
}

export interface GoogleWorkspaceCliSchemaOptions extends Omit<GoogleWorkspaceCliRunOptions, "failureCode"> {
  schemaPath: string[];
}

export interface GoogleWorkspaceCliFile {
  id: string;
  name: string;
  webViewLink: string;
  mimeType: string;
  modifiedTime?: string;
}

export interface GoogleWorkspaceCliPermission {
  id: string;
  type: "user";
  role: "owner" | "reader" | "writer";
  emailAddress: string;
}

export interface GoogleWorkspaceCliValuesResponse {
  range?: string;
  values?: unknown[][];
}

export interface GoogleWorkspaceCliWriteResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedCells?: number;
  replyCount?: number;
}

export type GoogleWorkspaceCliErrorCode =
  | "google_workspace.cli_not_found"
  | "google_workspace.cli_timeout"
  | "google_workspace.cli_invalid_json"
  | "google_workspace.sheets_read_failed"
  | "google_workspace.sheets_update_failed";

export type GoogleWorkspaceCliSheetOperation =
  | {
      operationType: "read";
      rangeA1: string;
    }
  | {
      operationType: "append_rows";
      rangeA1: string;
      values: unknown[][];
      valueInputOption?: "RAW" | "USER_ENTERED";
      insertDataOption?: "OVERWRITE" | "INSERT_ROWS";
    }
  | {
      operationType: "update_values";
      rangeA1: string;
      values: unknown[][];
      valueInputOption?: "RAW" | "USER_ENTERED";
    }
  | {
      operationType: "batch_update";
      requests: Array<Record<string, unknown>>;
    };

export interface GoogleWorkspaceCliSheetResponse {
  rangeA1?: string;
  values?: unknown[][];
  updatedRange?: string;
  updatedRows?: number;
  updatedCells?: number;
  replyCount?: number;
}

export class GoogleWorkspaceCliError extends Error {
  readonly code: GoogleWorkspaceCliErrorCode;
  readonly status?: number;
  readonly reason?: string;

  constructor(
    message: string,
    input: {
      code: GoogleWorkspaceCliErrorCode;
      status?: number;
      reason?: string;
    },
  ) {
    super(message);
    this.name = "GoogleWorkspaceCliError";
    this.code = input.code;
    this.status = input.status;
    this.reason = input.reason;
  }
}

export function readGoogleWorkspaceCliBinaryPath(): string {
  return readServerEnvValue(GOOGLE_WORKSPACE_EXECUTOR_ENV)?.trim()
    || readServerEnvValue("AGENT_SPACE_GOOGLE_WORKSPACE_CLI_PATH")?.trim()
    || DEFAULT_GOOGLE_WORKSPACE_CLI_BINARY;
}

export function resolveGoogleWorkspaceExecutor(): string {
  return readGoogleWorkspaceCliBinaryPath();
}

export function readGoogleWorkspaceCliTimeoutMs(): number {
  const raw = readServerEnvValue("AGENT_SPACE_GOOGLE_WORKSPACE_CLI_TIMEOUT_MS")?.trim();
  if (!raw) {
    return DEFAULT_GOOGLE_WORKSPACE_CLI_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GOOGLE_WORKSPACE_CLI_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(parsed), 300_000);
}

export async function runGoogleWorkspaceCliJson<T = unknown>(
  args: string[],
  accessToken: string,
  options: GoogleWorkspaceCliRunOptions = {},
): Promise<T> {
  const normalizedArgs = normalizeGoogleWorkspaceCliArgs(args);
  const binaryPath = options.binaryPath?.trim() || readGoogleWorkspaceCliBinaryPath();
  const timeout = options.timeoutMs ?? readGoogleWorkspaceCliTimeoutMs();
  const runner = options.execFileImpl ?? execFile;
  const env = {
    ...process.env,
    [GOOGLE_WORKSPACE_CLI_TOKEN_ENV]: accessToken,
  };

  let stdout = "";
  try {
    stdout = await execFileText(runner, binaryPath, normalizedArgs, {
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    throw normalizeGoogleWorkspaceCliExecutionError(error, {
      binaryPath,
      token: accessToken,
      fallbackCode: options.failureCode ?? "google_workspace.cli_failed",
    });
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new GoogleWorkspaceApiError("Google Workspace CLI returned invalid JSON.", {
      status: 502,
      code: "google_workspace.cli_invalid_json",
    });
  }
}

export async function readGoogleWorkspaceCliSchema(input: GoogleWorkspaceCliSchemaOptions): Promise<unknown> {
  const schemaPath = input.schemaPath.map((part) => part.trim()).filter(Boolean);
  if (schemaPath.length === 0) {
    throw new Error("Google Workspace CLI schema path is required.");
  }
  return runGoogleWorkspaceCliJson(
    ["schema", ...schemaPath, ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS],
    "",
    {
      binaryPath: input.binaryPath,
      timeoutMs: input.timeoutMs,
      execFileImpl: input.execFileImpl,
    },
  );
}

export async function createGoogleDriveFileViaCli(input: {
  accessToken: string;
  name: string;
  mimeType: string;
  parentFolderId?: string;
  fallbackWebViewLink: (fileId: string) => string;
}): Promise<GoogleWorkspaceCliFile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Google Drive file name is required.");
  }

  const body: { name: string; mimeType: string; parents?: string[] } = {
    name,
    mimeType: input.mimeType,
  };
  if (input.parentFolderId?.trim()) {
    body.parents = [input.parentFolderId.trim()];
  }

  const payload = await runGoogleWorkspaceCliJson<{
    id?: string;
    name?: string;
    webViewLink?: string;
    mimeType?: string;
    modifiedTime?: string;
  }>(
    [
      "drive",
      "files",
      "create",
      "--params",
      JSON.stringify({ fields: "id,name,webViewLink,mimeType,modifiedTime" }),
      "--json",
      JSON.stringify(body),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_create_failed" },
  );

  if (!payload.id) {
    throw new GoogleWorkspaceApiError("Google Drive did not return a file id.", {
      status: 502,
      code: "google_workspace.drive_create_invalid_response",
    });
  }

  return {
    id: payload.id,
    name: payload.name?.trim() || name,
    webViewLink: payload.webViewLink?.trim() || input.fallbackWebViewLink(payload.id),
    mimeType: payload.mimeType?.trim() || input.mimeType,
    modifiedTime: payload.modifiedTime,
  };
}

export async function readGoogleDriveFileMetadataViaCli(input: {
  accessToken: string;
  fileId: string;
  fallbackWebViewLink: (fileId: string) => string;
  fallbackMimeType: string;
}): Promise<GoogleWorkspaceCliFile> {
  const fileId = input.fileId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }

  const payload = await runGoogleWorkspaceCliJson<{
    id?: string;
    name?: string;
    webViewLink?: string;
    mimeType?: string;
    modifiedTime?: string;
    trashed?: boolean;
  }>(
    [
      "drive",
      "files",
      "get",
      "--params",
      JSON.stringify({ fileId, fields: "id,name,webViewLink,mimeType,modifiedTime,trashed" }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_metadata_failed" },
  );

  if (!payload.id || payload.trashed === true) {
    throw new GoogleWorkspaceApiError("Google Drive file is missing or trashed.", {
      status: 404,
      code: "google_workspace.drive_file_missing",
    });
  }

  return {
    id: payload.id,
    name: payload.name?.trim() || payload.id,
    webViewLink: payload.webViewLink?.trim() || input.fallbackWebViewLink(payload.id),
    mimeType: payload.mimeType?.trim() || input.fallbackMimeType,
    modifiedTime: payload.modifiedTime,
  };
}

export async function createGoogleDriveFilePermissionViaCli(input: {
  accessToken: string;
  fileId: string;
  emailAddress: string;
  role: "reader" | "writer";
  sendNotificationEmail?: boolean;
}): Promise<GoogleWorkspaceCliPermission> {
  const fileId = input.fileId.trim();
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (!emailAddress) {
    throw new Error("Google Drive permission email is required.");
  }

  const payload = await runGoogleWorkspaceCliJson<{
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
  }>(
    [
      "drive",
      "permissions",
      "create",
      "--params",
      JSON.stringify({
        fileId,
        fields: "id,type,role,emailAddress",
        sendNotificationEmail: input.sendNotificationEmail === true,
      }),
      "--json",
      JSON.stringify({
        type: "user",
        role: input.role,
        emailAddress,
      }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_permission_failed" },
  );

  if (!payload.id) {
    throw new GoogleWorkspaceApiError("Google Drive did not return a permission id.", {
      status: 502,
      code: "google_workspace.drive_permission_invalid_response",
    });
  }

  return {
    id: payload.id,
    type: "user",
    role: normalizeGoogleDrivePermissionRole(payload.role, input.role),
    emailAddress: payload.emailAddress?.trim().toLowerCase() || emailAddress,
  };
}

export async function listGoogleDriveFilePermissionsViaCli(input: {
  accessToken: string;
  fileId: string;
}): Promise<GoogleWorkspaceCliPermission[]> {
  const fileId = input.fileId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }

  const payload = await runGoogleWorkspaceCliJson<{
    permissions?: Array<{
      id?: string;
      type?: string;
      role?: string;
      emailAddress?: string;
    }>;
  }>(
    [
      "drive",
      "permissions",
      "list",
      "--params",
      JSON.stringify({ fileId, fields: "permissions(id,type,role,emailAddress)" }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_permission_list_failed" },
  );

  return (payload.permissions ?? []).flatMap((permission) => {
    const id = permission.id?.trim();
    const emailAddress = permission.emailAddress?.trim().toLowerCase();
    if (!id || permission.type !== "user" || !emailAddress) {
      return [];
    }
    return [{
      id,
      type: "user" as const,
      role: normalizeGoogleDrivePermissionRole(permission.role, "reader"),
      emailAddress,
    }];
  });
}

export async function updateGoogleDriveFilePermissionViaCli(input: {
  accessToken: string;
  fileId: string;
  permissionId: string;
  role: "reader" | "writer";
}): Promise<GoogleWorkspaceCliPermission> {
  const fileId = input.fileId.trim();
  const permissionId = input.permissionId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (!permissionId) {
    throw new Error("Google Drive permission id is required.");
  }

  const payload = await runGoogleWorkspaceCliJson<{
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
  }>(
    [
      "drive",
      "permissions",
      "update",
      "--params",
      JSON.stringify({ fileId, permissionId, fields: "id,type,role,emailAddress" }),
      "--json",
      JSON.stringify({ role: input.role }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_permission_update_failed" },
  );

  return {
    id: payload.id?.trim() || permissionId,
    type: "user",
    role: normalizeGoogleDrivePermissionRole(payload.role, input.role),
    emailAddress: payload.emailAddress?.trim().toLowerCase() || "",
  };
}

export async function deleteGoogleDriveFilePermissionViaCli(input: {
  accessToken: string;
  fileId: string;
  permissionId: string;
}): Promise<void> {
  const fileId = input.fileId.trim();
  const permissionId = input.permissionId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (!permissionId) {
    throw new Error("Google Drive permission id is required.");
  }

  await runGoogleWorkspaceCliJson(
    [
      "drive",
      "permissions",
      "delete",
      "--params",
      JSON.stringify({ fileId, permissionId }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.drive_permission_delete_failed" },
  );
}

export async function readGoogleSheetValuesViaCli(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
  options?: GoogleWorkspaceCliRunOptions;
}): Promise<GoogleWorkspaceCliValuesResponse> {
  const payload = await runGoogleWorkspaceCliJson<{
    range?: string;
    values?: unknown[][];
  }>(
    [
      "sheets",
      "spreadsheets",
      "values",
      "get",
      "--params",
      JSON.stringify({ spreadsheetId: input.spreadsheetId, range: input.rangeA1 }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { ...input.options, failureCode: "google_workspace.sheets_read_failed" },
  );

  return {
    range: payload.range,
    values: Array.isArray(payload.values) ? payload.values : [],
  };
}

export async function appendGoogleSheetRowsViaCli(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
  values: unknown[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
  insertDataOption?: "OVERWRITE" | "INSERT_ROWS";
  options?: GoogleWorkspaceCliRunOptions;
}): Promise<GoogleWorkspaceCliWriteResponse> {
  const payload = await runGoogleWorkspaceCliJson<{
    updates?: {
      updatedRange?: string;
      updatedRows?: number;
      updatedCells?: number;
    };
  }>(
    [
      "sheets",
      "spreadsheets",
      "values",
      "append",
      "--params",
      JSON.stringify({
        spreadsheetId: input.spreadsheetId,
        range: input.rangeA1,
        valueInputOption: input.valueInputOption ?? "USER_ENTERED",
        insertDataOption: input.insertDataOption ?? "INSERT_ROWS",
      }),
      "--json",
      JSON.stringify({ values: input.values }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { ...input.options, failureCode: "google_workspace.sheets_append_failed" },
  );

  return {
    updatedRange: payload.updates?.updatedRange,
    updatedRows: payload.updates?.updatedRows,
    updatedCells: payload.updates?.updatedCells,
  };
}

export async function updateGoogleSheetValuesViaCli(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
  values: unknown[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
  options?: GoogleWorkspaceCliRunOptions;
}): Promise<GoogleWorkspaceCliWriteResponse> {
  const payload = await runGoogleWorkspaceCliJson<{
    updatedRange?: string;
    updatedRows?: number;
    updatedCells?: number;
  }>(
    [
      "sheets",
      "spreadsheets",
      "values",
      "update",
      "--params",
      JSON.stringify({
        spreadsheetId: input.spreadsheetId,
        range: input.rangeA1,
        valueInputOption: input.valueInputOption ?? "USER_ENTERED",
      }),
      "--json",
      JSON.stringify({ values: input.values }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { ...input.options, failureCode: "google_workspace.sheets_update_failed" },
  );

  return {
    updatedRange: payload.updatedRange,
    updatedRows: payload.updatedRows,
    updatedCells: payload.updatedCells,
  };
}

export async function batchUpdateGoogleSheetViaCli(input: {
  accessToken: string;
  spreadsheetId: string;
  requests: Array<Record<string, unknown>>;
  options?: GoogleWorkspaceCliRunOptions;
}): Promise<GoogleWorkspaceCliWriteResponse> {
  const payload = await runGoogleWorkspaceCliJson<{
    replies?: unknown[];
  }>(
    [
      "sheets",
      "spreadsheets",
      "batchUpdate",
      "--params",
      JSON.stringify({ spreadsheetId: input.spreadsheetId }),
      "--json",
      JSON.stringify({ requests: input.requests }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { ...input.options, failureCode: "google_workspace.sheets_batch_update_failed" },
  );

  return {
    replyCount: Array.isArray(payload.replies) ? payload.replies.length : 0,
  };
}

export async function executeGoogleWorkspaceCliSheetOperation(input: {
  accessToken: string;
  spreadsheetId: string;
  operation: GoogleWorkspaceCliSheetOperation;
  timeoutMs?: number;
  binaryPath?: string;
  execFileImpl?: ExecFileLike;
}): Promise<GoogleWorkspaceCliSheetResponse> {
  const spreadsheetId = input.spreadsheetId.trim();
  if (!spreadsheetId) {
    throw new GoogleWorkspaceCliError("Google Sheet external file id is missing.", {
      code: failureCodeForOperation(input.operation.operationType),
      status: 400,
      reason: "missingSpreadsheetId",
    });
  }
  const options: GoogleWorkspaceCliRunOptions = {
    binaryPath: input.binaryPath,
    timeoutMs: input.timeoutMs,
    execFileImpl: input.execFileImpl,
  };

  try {
    if (input.operation.operationType === "read") {
      const response = await readGoogleSheetValuesViaCli({
        accessToken: input.accessToken,
        spreadsheetId,
        rangeA1: input.operation.rangeA1,
        options,
      });
      return {
        rangeA1: response.range ?? input.operation.rangeA1,
        values: response.values ?? [],
      };
    }

    if (input.operation.operationType === "append_rows") {
      return await appendGoogleSheetRowsViaCli({
        accessToken: input.accessToken,
        spreadsheetId,
        rangeA1: input.operation.rangeA1,
        values: input.operation.values,
        valueInputOption: input.operation.valueInputOption,
        insertDataOption: input.operation.insertDataOption,
        options,
      });
    }

    if (input.operation.operationType === "update_values") {
      return await updateGoogleSheetValuesViaCli({
        accessToken: input.accessToken,
        spreadsheetId,
        rangeA1: input.operation.rangeA1,
        values: input.operation.values,
        valueInputOption: input.operation.valueInputOption,
        options,
      });
    }

    return await batchUpdateGoogleSheetViaCli({
      accessToken: input.accessToken,
      spreadsheetId,
      requests: input.operation.requests,
      options,
    });
  } catch (error) {
    throw normalizeSheetCliError(error, input.operation.operationType);
  }
}

export async function createGoogleDocViaCli(input: {
  accessToken: string;
  title: string;
}): Promise<{ documentId: string; title: string }> {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Google Doc title is required.");
  }
  const payload = await runGoogleWorkspaceCliJson<{
    documentId?: string;
    title?: string;
  }>(
    [
      "docs",
      "documents",
      "create",
      "--json",
      JSON.stringify({ title }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.docs_create_failed" },
  );
  if (!payload.documentId) {
    throw new GoogleWorkspaceApiError("Google Docs did not return a document id.", {
      status: 502,
      code: "google_workspace.docs_create_invalid_response",
    });
  }
  return {
    documentId: payload.documentId,
    title: payload.title?.trim() || title,
  };
}

export async function appendGoogleDocTextViaCli(input: {
  accessToken: string;
  documentId: string;
  text: string;
}): Promise<{ replyCount: number }> {
  const documentId = input.documentId.trim();
  if (!documentId) {
    throw new Error("Google Docs document id is required.");
  }
  if (!input.text) {
    throw new Error("Google Docs append text is required.");
  }
  return batchUpdateGoogleDocViaCli({
    accessToken: input.accessToken,
    documentId,
    requests: [
      {
        insertText: {
          text: input.text,
          endOfSegmentLocation: { segmentId: "" },
        },
      },
    ],
  });
}

export async function batchUpdateGoogleDocViaCli(input: {
  accessToken: string;
  documentId: string;
  requests: Array<Record<string, unknown>>;
}): Promise<{ replyCount: number }> {
  const documentId = input.documentId.trim();
  if (!documentId) {
    throw new Error("Google Docs document id is required.");
  }
  if (input.requests.length === 0) {
    throw new Error("Google Docs batchUpdate requests are required.");
  }

  const payload = await runGoogleWorkspaceCliJson<{
    replies?: unknown[];
  }>(
    [
      "docs",
      "documents",
      "batchUpdate",
      "--params",
      JSON.stringify({ documentId }),
      "--json",
      JSON.stringify({ requests: input.requests }),
      ...GOOGLE_WORKSPACE_CLI_FORMAT_ARGS,
    ],
    input.accessToken,
    { failureCode: "google_workspace.docs_batch_update_failed" },
  );

  return {
    replyCount: Array.isArray(payload.replies) ? payload.replies.length : 0,
  };
}

function normalizeGoogleWorkspaceCliArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    throw new Error("Google Workspace CLI args must be a non-empty string array.");
  }
  if (!isAllowedGoogleWorkspaceCliArgs(args)) {
    throw new Error("Google Workspace CLI operation is not allowed.");
  }
  return [...args];
}

function isAllowedGoogleWorkspaceCliArgs(args: string[]): boolean {
  const [service, resource, nestedResource, method] = args;
  if (service === "schema") {
    return args.length > 1;
  }
  if (service === "sheets" && resource === "spreadsheets") {
    return (
      nestedResource === "batchUpdate" ||
      (nestedResource === "values" && (
        method === "get" ||
        method === "append" ||
        method === "update"
      ))
    );
  }
  if (service === "docs" && resource === "documents") {
    return nestedResource === "create" || nestedResource === "batchUpdate";
  }
  if (service === "drive" && resource === "files") {
    return nestedResource === "get" || nestedResource === "create";
  }
  if (service === "drive" && resource === "permissions") {
    return nestedResource === "list" || nestedResource === "create" || nestedResource === "update" || nestedResource === "delete";
  }
  return false;
}

function normalizeSheetCliError(
  error: unknown,
  operationType: GoogleWorkspaceCliSheetOperation["operationType"],
): GoogleWorkspaceCliError {
  if (error instanceof GoogleWorkspaceCliError) {
    return error;
  }
  if (error instanceof GoogleWorkspaceApiError) {
    if (error.code === "google_workspace.cli_not_found") {
      return new GoogleWorkspaceCliError(`${resolveGoogleWorkspaceExecutor()} was not found on PATH. Install gws or set ${GOOGLE_WORKSPACE_EXECUTOR_ENV}.`, {
        code: "google_workspace.cli_not_found",
        status: error.status,
      });
    }
    if (error.code === "google_workspace.cli_timeout") {
      return new GoogleWorkspaceCliError(`${resolveGoogleWorkspaceExecutor()} timed out.`, {
        code: "google_workspace.cli_timeout",
        status: error.status,
      });
    }
    if (error.code === "google_workspace.cli_invalid_json") {
      return new GoogleWorkspaceCliError("gws returned non-JSON output.", {
        code: "google_workspace.cli_invalid_json",
        status: error.status,
      });
    }
    const reason = inferGoogleWorkspaceCliReason(error.message);
    return new GoogleWorkspaceCliError(buildGoogleSheetsFailureMessage(operationType, error.status, reason, error.message), {
      code: failureCodeForOperation(operationType),
      status: error.status,
      reason,
    });
  }
  return new GoogleWorkspaceCliError(error instanceof Error ? error.message : String(error), {
    code: failureCodeForOperation(operationType),
  });
}

function buildGoogleSheetsFailureMessage(
  operationType: GoogleWorkspaceCliSheetOperation["operationType"],
  status: number | undefined,
  reason: string | undefined,
  message: string,
): string {
  const statusText = status ? ` (${status}${reason ? ` ${reason}` : ""})` : "";
  const visibilityHint = status === 404
    ? " The current OAuth client/scope may be unable to see this file even if the Google account can open it in a browser. With drive.file scope, authorize the file through the app/Picker, create it through agent.dofe, or adopt a reviewed broader scope."
    : "";
  return `Google Sheets ${operationType} failed${statusText}. ${message}${visibilityHint}`;
}

function inferGoogleWorkspaceCliReason(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (normalized.includes("not found")) {
    return "notFound";
  }
  if (normalized.includes("permission") || normalized.includes("forbidden") || normalized.includes("insufficient")) {
    return "permissionDenied";
  }
  if (normalized.includes("unauthorized")) {
    return "unauthorized";
  }
  return undefined;
}

function failureCodeForOperation(operationType: GoogleWorkspaceCliSheetOperation["operationType"]): GoogleWorkspaceCliErrorCode {
  return operationType === "read" ? "google_workspace.sheets_read_failed" : "google_workspace.sheets_update_failed";
}

function execFileText(
  runner: ExecFileLike,
  file: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    runner(file, args, options, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, {
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
        reject(error);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function normalizeGoogleWorkspaceCliExecutionError(
  error: unknown,
  input: {
    binaryPath: string;
    token: string;
    fallbackCode: string;
  },
): GoogleWorkspaceApiError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  const signal = typeof record.signal === "string" ? record.signal : "";
  const killed = record.killed === true;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  const detail = sanitizeCliText(stderr || stdout || (error instanceof Error ? error.message : String(error)), input.token);

  if (code === "ENOENT") {
    return new GoogleWorkspaceApiError(`Google Workspace CLI is not available at "${input.binaryPath}".`, {
      status: 503,
      code: "google_workspace.cli_not_found",
    });
  }
  if (killed || signal === "SIGTERM" || code === "ETIMEDOUT") {
    return new GoogleWorkspaceApiError("Google Workspace CLI timed out.", {
      status: 504,
      code: "google_workspace.cli_timeout",
    });
  }

  return new GoogleWorkspaceApiError(
    detail ? `Google Workspace CLI failed. ${detail}` : "Google Workspace CLI failed.",
    {
      status: inferGoogleWorkspaceCliStatus(detail),
      code: input.fallbackCode,
    },
  );
}

function sanitizeCliText(value: string, token: string): string {
  let sanitized = value.trim();
  if (token) {
    sanitized = sanitized.split(token).join("[redacted]");
  }
  return sanitized
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/GOOGLE_WORKSPACE_CLI_TOKEN=[^\s]+/g, "GOOGLE_WORKSPACE_CLI_TOKEN=[redacted]");
}

function inferGoogleWorkspaceCliStatus(detail: string): number {
  const normalized = detail.toLowerCase();
  if (normalized.includes("401") || normalized.includes("unauthorized")) {
    return 401;
  }
  if (
    normalized.includes("403") ||
    normalized.includes("permission") ||
    normalized.includes("forbidden") ||
    normalized.includes("insufficient")
  ) {
    return 403;
  }
  if (normalized.includes("404") || normalized.includes("not found")) {
    return 404;
  }
  return 502;
}

function normalizeGoogleDrivePermissionRole(value: string | undefined, fallback: "reader" | "writer"): "owner" | "reader" | "writer" {
  if (value === "owner" || value === "writer" || value === "reader") {
    return value;
  }
  return fallback;
}
