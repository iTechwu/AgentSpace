import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import {
  readActiveAgentGoogleWorkspaceDelegationSync,
  readActiveGoogleOAuthCredentialSync,
  readUserSync,
  upsertGoogleOAuthCredentialSync,
  type StoredAgentGoogleWorkspaceDelegationRecord,
  type StoredGoogleOAuthCredentialRecord,
} from "@dofe-agent/db";
import { readServerEnvValue } from "@/features/auth/server-env";
import {
  appendGoogleDocTextViaCli,
  appendGoogleSheetRowsViaCli,
  batchUpdateGoogleDocViaCli,
  batchUpdateGoogleSheetViaCli,
  createGoogleDocViaCli,
  createGoogleDriveFilePermissionViaCli,
  createGoogleDriveFileViaCli,
  deleteGoogleDriveFilePermissionViaCli,
  listGoogleDriveFilePermissionsViaCli,
  readGoogleDriveFileMetadataViaCli,
  readGoogleSheetValuesViaCli,
  updateGoogleDriveFilePermissionViaCli,
  updateGoogleSheetValuesViaCli,
} from "./google-workspace-cli";
import { GoogleWorkspaceApiError } from "./google-workspace-errors";

export { GoogleWorkspaceApiError } from "./google-workspace-errors";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_SHEETS_SPREADSHEETS_ENDPOINT = "https://sheets.googleapis.com/v4/spreadsheets";
const GOOGLE_WORKSPACE_STATE_COOKIE = "dofe_agent_google_workspace_oauth_state";
const GOOGLE_WORKSPACE_STATE_MAX_AGE_SECONDS = 10 * 60;
const TOKEN_ENCRYPTION_VERSION = "v1";

export const GOOGLE_SHEETS_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";
export const GOOGLE_WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
  "profile",
] as const;

interface GoogleWorkspaceOAuthStatePayload {
  csrf: string;
  workspaceId: string;
  userId: string;
  agentName?: string;
  redirectAfter?: string;
  intent: "google_sheets" | "agent_google_workspace_delegation";
  createdAt: number;
}

interface GoogleWorkspaceTokenPayload {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string;
}

export interface GoogleWorkspaceOAuthConfig {
  appUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
  driveParentFolderId?: string;
}

export interface GoogleWorkspaceProfile {
  googleSubject?: string;
  googleEmail?: string;
}

export interface GoogleWorkspaceSheetFile {
  id: string;
  name: string;
  webViewLink: string;
  mimeType: string;
  modifiedTime?: string;
}

export interface GoogleWorkspaceDocFile {
  id: string;
  name: string;
  webViewLink: string;
  mimeType: string;
  modifiedTime?: string;
}

export interface GoogleDriveFilePermission {
  id: string;
  type: "user";
  role: "owner" | "reader" | "writer";
  emailAddress: string;
}

export interface GoogleSheetsValuesResponse {
  range?: string;
  values?: unknown[][];
}

export interface GoogleSheetsWriteResponse {
  updatedRange?: string;
  updatedRows?: number;
  updatedCells?: number;
  replyCount?: number;
}

export function readGoogleWorkspaceOAuthConfig(): GoogleWorkspaceOAuthConfig {
  const appUrl = readRequiredGoogleWorkspaceEnv("DOFE_AGENT_APP_URL");
  const clientId = readRequiredGoogleWorkspaceEnv("DOFE_AGENT_GOOGLE_WORKSPACE_CLIENT_ID");
  const clientSecret = readRequiredGoogleWorkspaceEnv("DOFE_AGENT_GOOGLE_WORKSPACE_CLIENT_SECRET");
  const callbackUrl =
    readServerEnvValue("DOFE_AGENT_GOOGLE_WORKSPACE_CALLBACK_URL")?.trim()
    || `${appUrl}/api/integrations/google/callback`;
  const stateSecret = readRequiredGoogleWorkspaceEnv("DOFE_AGENT_OAUTH_STATE_SECRET");
  const driveParentFolderId = readServerEnvValue("DOFE_AGENT_GOOGLE_DRIVE_PARENT_FOLDER_ID")?.trim() || undefined;

  return {
    appUrl,
    clientId,
    clientSecret,
    callbackUrl,
    stateSecret,
    driveParentFolderId,
  };
}

export function readGoogleWorkspaceExecutor(): "cli" | "api" {
  return readServerEnvValue("DOFE_AGENT_GOOGLE_WORKSPACE_EXECUTOR")?.trim().toLowerCase() === "api"
    ? "api"
    : "cli";
}

export async function createGoogleWorkspaceAuthorizationUrl(input: {
  workspaceId: string;
  userId: string;
  agentName?: string;
  redirectAfter?: string;
}): Promise<string> {
  const config = readGoogleWorkspaceOAuthConfig();
  const agentName = input.agentName?.trim();
  const statePayload: GoogleWorkspaceOAuthStatePayload = {
    csrf: randomBytes(16).toString("hex"),
    workspaceId: input.workspaceId,
    userId: input.userId,
    agentName: agentName || undefined,
    redirectAfter: normalizeRedirectAfter(input.redirectAfter),
    intent: agentName ? "agent_google_workspace_delegation" : "google_sheets",
    createdAt: Date.now(),
  };
  const state = signGoogleWorkspaceOAuthState(statePayload, config.stateSecret);

  const cookieStore = await cookies();
  cookieStore.set(GOOGLE_WORKSPACE_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: GOOGLE_WORKSPACE_STATE_MAX_AGE_SECONDS,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: GOOGLE_WORKSPACE_SCOPES.join(" "),
    state,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  });

  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function verifyGoogleWorkspaceOAuthCallbackState(state: string): Promise<{
  workspaceId: string;
  userId: string;
  agentName?: string;
  redirectAfter?: string;
}> {
  const config = readGoogleWorkspaceOAuthConfig();
  const cookieStore = await cookies();
  const cookieState = cookieStore.get(GOOGLE_WORKSPACE_STATE_COOKIE)?.value?.trim();
  cookieStore.set(GOOGLE_WORKSPACE_STATE_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });

  if (!cookieState || cookieState !== state.trim()) {
    throw new Error("google_workspace.state_invalid");
  }

  const payload = readAndVerifyGoogleWorkspaceOAuthState(cookieState, config.stateSecret);
  if (
    (payload.intent !== "google_sheets" && payload.intent !== "agent_google_workspace_delegation") ||
    (payload.intent === "agent_google_workspace_delegation" && !payload.agentName?.trim()) ||
    Date.now() - payload.createdAt > GOOGLE_WORKSPACE_STATE_MAX_AGE_SECONDS * 1000
  ) {
    throw new Error("google_workspace.state_invalid");
  }

  return {
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    agentName: payload.agentName,
    redirectAfter: payload.redirectAfter,
  };
}

export async function saveGoogleWorkspaceCredentialFromAuthorizationCode(input: {
  workspaceId: string;
  userId: string;
  code: string;
}): Promise<StoredGoogleOAuthCredentialRecord> {
  const tokenPayload = await exchangeGoogleWorkspaceAuthorizationCode(input.code);
  const profile = await readGoogleWorkspaceProfile(tokenPayload.accessToken);
  return upsertGoogleOAuthCredentialSync({
    workspaceId: input.workspaceId,
    userId: input.userId,
    googleSubject: profile.googleSubject,
    googleEmail: profile.googleEmail,
    scopes: tokenPayload.scopes,
    accessTokenEncrypted: encryptGoogleWorkspaceToken(tokenPayload.accessToken),
    refreshTokenEncrypted: tokenPayload.refreshToken
      ? encryptGoogleWorkspaceToken(tokenPayload.refreshToken)
      : undefined,
    expiresAt: tokenPayload.expiresAt,
  });
}

export async function getGoogleWorkspaceAccessTokenForUser(input: {
  workspaceId: string;
  userId: string;
}): Promise<{ accessToken: string; credential: StoredGoogleOAuthCredentialRecord }> {
  const credential = readActiveGoogleOAuthCredentialSync(input);
  if (!credential) {
    throw new Error("google_workspace.not_connected");
  }

  if (credential.accessTokenEncrypted && !isExpiringSoon(credential.expiresAt)) {
    return {
      accessToken: decryptGoogleWorkspaceToken(credential.accessTokenEncrypted),
      credential,
    };
  }

  if (!credential.refreshTokenEncrypted) {
    throw new Error("google_workspace.reconnect_required");
  }

  const refreshToken = decryptGoogleWorkspaceToken(credential.refreshTokenEncrypted);
  const refreshed = await refreshGoogleWorkspaceAccessToken(refreshToken);
  const updated = upsertGoogleOAuthCredentialSync({
    workspaceId: input.workspaceId,
    userId: input.userId,
    googleSubject: credential.googleSubject,
    googleEmail: credential.googleEmail,
    scopes: refreshed.scopes || credential.scopes,
    accessTokenEncrypted: encryptGoogleWorkspaceToken(refreshed.accessToken),
    expiresAt: refreshed.expiresAt,
  });

  return {
    accessToken: refreshed.accessToken,
    credential: updated,
  };
}

export async function getGoogleWorkspaceAccessTokenForAgent(input: {
  workspaceId: string;
  employeeName: string;
}): Promise<{
  accessToken: string;
  credential: StoredGoogleOAuthCredentialRecord;
  delegation: StoredAgentGoogleWorkspaceDelegationRecord;
  delegatedUserDisplayName?: string;
}> {
  const delegation = readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId: input.workspaceId,
    employeeName: input.employeeName,
  });
  if (!delegation) {
    throw new Error("google_workspace.agent_not_delegated");
  }

  const credential = readActiveGoogleOAuthCredentialSync({
    workspaceId: input.workspaceId,
    userId: delegation.userId,
  });
  if (!credential || credential.id !== delegation.googleOAuthCredentialId) {
    throw new Error("google_workspace.agent_delegation_reconnect_required");
  }

  try {
    const result = await getGoogleWorkspaceAccessTokenForUser({
      workspaceId: input.workspaceId,
      userId: delegation.userId,
    });
    return {
      ...result,
      delegation,
      delegatedUserDisplayName: readUserSync(delegation.userId)?.displayName,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "google_workspace.not_connected" || message === "google_workspace.reconnect_required") {
      throw new Error("google_workspace.agent_delegation_reconnect_required");
    }
    throw error;
  }
}

export async function createGoogleWorkspaceSheet(input: {
  accessToken: string;
  name: string;
  parentFolderId?: string;
}): Promise<GoogleWorkspaceSheetFile> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Google Sheet name is required.");
  }
  if (readGoogleWorkspaceExecutor() === "cli") {
    return createGoogleDriveFileViaCli({
      accessToken: input.accessToken,
      name,
      mimeType: GOOGLE_SHEETS_MIME_TYPE,
      parentFolderId: input.parentFolderId,
      fallbackWebViewLink: (fileId) => `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
    });
  }

  const body: { name: string; mimeType: string; parents?: string[] } = {
    name,
    mimeType: GOOGLE_SHEETS_MIME_TYPE,
  };
  if (input.parentFolderId?.trim()) {
    body.parents = [input.parentFolderId.trim()];
  }

  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}?fields=id,name,webViewLink,mimeType,modifiedTime`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Drive file create failed."),
      { status: response.status, code: "google_workspace.drive_create_failed" },
    );
  }

  const payload = await response.json() as {
    id?: string;
    name?: string;
    webViewLink?: string;
    mimeType?: string;
    modifiedTime?: string;
  };
  if (!payload.id) {
    throw new GoogleWorkspaceApiError("Google Drive did not return a file id.", {
      status: 502,
      code: "google_workspace.drive_create_invalid_response",
    });
  }

  return {
    id: payload.id,
    name: payload.name?.trim() || name,
    webViewLink: payload.webViewLink?.trim() || `https://docs.google.com/spreadsheets/d/${payload.id}/edit`,
    mimeType: payload.mimeType?.trim() || GOOGLE_SHEETS_MIME_TYPE,
    modifiedTime: payload.modifiedTime,
  };
}

export async function createGoogleDriveFilePermission(input: {
  accessToken: string;
  fileId: string;
  emailAddress: string;
  role: "reader" | "writer";
  sendNotificationEmail?: boolean;
}): Promise<GoogleDriveFilePermission> {
  const fileId = input.fileId.trim();
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (!emailAddress) {
    throw new Error("Google Drive permission email is required.");
  }
  if (readGoogleWorkspaceExecutor() === "cli") {
    return createGoogleDriveFilePermissionViaCli({
      accessToken: input.accessToken,
      fileId,
      emailAddress,
      role: input.role,
      sendNotificationEmail: input.sendNotificationEmail,
    });
  }

  const searchParams = new URLSearchParams({
    fields: "id,type,role,emailAddress",
    sendNotificationEmail: input.sendNotificationEmail === true ? "true" : "false",
  });
  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/permissions?${searchParams.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "user",
        role: input.role,
        emailAddress,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Drive permission create failed."),
      { status: response.status, code: "google_workspace.drive_permission_failed" },
    );
  }

  const payload = await response.json() as {
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
  };
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

export async function listGoogleDriveFilePermissions(input: {
  accessToken: string;
  fileId: string;
}): Promise<GoogleDriveFilePermission[]> {
  const fileId = input.fileId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (readGoogleWorkspaceExecutor() === "cli") {
    return listGoogleDriveFilePermissionsViaCli({
      accessToken: input.accessToken,
      fileId,
    });
  }

  const searchParams = new URLSearchParams({
    fields: "permissions(id,type,role,emailAddress)",
  });
  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/permissions?${searchParams.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Drive permissions list failed."),
      { status: response.status, code: "google_workspace.drive_permission_list_failed" },
    );
  }

  const payload = await response.json() as {
    permissions?: Array<{
      id?: string;
      type?: string;
      role?: string;
      emailAddress?: string;
    }>;
  };

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

export async function updateGoogleDriveFilePermission(input: {
  accessToken: string;
  fileId: string;
  permissionId: string;
  role: "reader" | "writer";
}): Promise<GoogleDriveFilePermission> {
  const fileId = input.fileId.trim();
  const permissionId = input.permissionId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (!permissionId) {
    throw new Error("Google Drive permission id is required.");
  }
  if (readGoogleWorkspaceExecutor() === "cli") {
    return updateGoogleDriveFilePermissionViaCli({
      accessToken: input.accessToken,
      fileId,
      permissionId,
      role: input.role,
    });
  }

  const searchParams = new URLSearchParams({
    fields: "id,type,role,emailAddress",
  });
  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?${searchParams.toString()}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: input.role }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Drive permission update failed."),
      { status: response.status, code: "google_workspace.drive_permission_update_failed" },
    );
  }

  const payload = await response.json() as {
    id?: string;
    type?: string;
    role?: string;
    emailAddress?: string;
  };
  return {
    id: payload.id?.trim() || permissionId,
    type: "user",
    role: normalizeGoogleDrivePermissionRole(payload.role, input.role),
    emailAddress: payload.emailAddress?.trim().toLowerCase() || "",
  };
}

export async function deleteGoogleDriveFilePermission(input: {
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
  if (readGoogleWorkspaceExecutor() === "cli") {
    await deleteGoogleDriveFilePermissionViaCli({
      accessToken: input.accessToken,
      fileId,
      permissionId,
    });
    return;
  }

  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Drive permission delete failed."),
      { status: response.status, code: "google_workspace.drive_permission_delete_failed" },
    );
  }
}

export async function readGoogleDriveFileMetadata(input: {
  accessToken: string;
  fileId: string;
}): Promise<GoogleWorkspaceSheetFile> {
  const fileId = input.fileId.trim();
  if (!fileId) {
    throw new Error("Google Drive file id is required.");
  }
  if (readGoogleWorkspaceExecutor() === "cli") {
    return readGoogleDriveFileMetadataViaCli({
      accessToken: input.accessToken,
      fileId,
      fallbackWebViewLink: (googleFileId) => `https://docs.google.com/spreadsheets/d/${googleFileId}/edit`,
      fallbackMimeType: GOOGLE_SHEETS_MIME_TYPE,
    });
  }

  const response = await fetch(
    `${GOOGLE_DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?fields=id,name,webViewLink,mimeType,modifiedTime,trashed`,
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleDriveFileMetadataErrorMessage(response),
      { status: response.status, code: "google_workspace.drive_metadata_failed" },
    );
  }

  const payload = await response.json() as {
    id?: string;
    name?: string;
    webViewLink?: string;
    mimeType?: string;
    modifiedTime?: string;
    trashed?: boolean;
  };
  if (!payload.id || payload.trashed === true) {
    throw new GoogleWorkspaceApiError("Google Drive file is missing or trashed.", {
      status: 404,
      code: "google_workspace.drive_file_missing",
    });
  }

  return {
    id: payload.id,
    name: payload.name?.trim() || payload.id,
    webViewLink: payload.webViewLink?.trim() || `https://docs.google.com/spreadsheets/d/${payload.id}/edit`,
    mimeType: payload.mimeType?.trim() || GOOGLE_SHEETS_MIME_TYPE,
    modifiedTime: payload.modifiedTime,
  };
}

export async function readGoogleSheetValues(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
}): Promise<GoogleSheetsValuesResponse> {
  if (readGoogleWorkspaceExecutor() === "cli") {
    return readGoogleSheetValuesViaCli(input);
  }

  const response = await fetch(
    `${GOOGLE_SHEETS_SPREADSHEETS_ENDPOINT}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.rangeA1)}`,
    {
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Sheets values read failed."),
      { status: response.status, code: "google_workspace.sheets_read_failed" },
    );
  }

  const payload = await response.json() as {
    range?: string;
    values?: unknown[][];
  };
  return {
    range: payload.range,
    values: Array.isArray(payload.values) ? payload.values : [],
  };
}

export async function appendGoogleSheetRows(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
  values: unknown[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
  insertDataOption?: "OVERWRITE" | "INSERT_ROWS";
}): Promise<GoogleSheetsWriteResponse> {
  if (readGoogleWorkspaceExecutor() === "cli") {
    return appendGoogleSheetRowsViaCli(input);
  }

  const searchParams = new URLSearchParams({
    valueInputOption: input.valueInputOption ?? "USER_ENTERED",
    insertDataOption: input.insertDataOption ?? "INSERT_ROWS",
  });
  const response = await fetch(
    `${GOOGLE_SHEETS_SPREADSHEETS_ENDPOINT}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.rangeA1)}:append?${searchParams.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: input.values }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Sheets values append failed."),
      { status: response.status, code: "google_workspace.sheets_append_failed" },
    );
  }

  const payload = await response.json() as {
    updates?: {
      updatedRange?: string;
      updatedRows?: number;
      updatedCells?: number;
    };
  };
  return {
    updatedRange: payload.updates?.updatedRange,
    updatedRows: payload.updates?.updatedRows,
    updatedCells: payload.updates?.updatedCells,
  };
}

export async function updateGoogleSheetValues(input: {
  accessToken: string;
  spreadsheetId: string;
  rangeA1: string;
  values: unknown[][];
  valueInputOption?: "RAW" | "USER_ENTERED";
}): Promise<GoogleSheetsWriteResponse> {
  if (readGoogleWorkspaceExecutor() === "cli") {
    return updateGoogleSheetValuesViaCli(input);
  }

  const searchParams = new URLSearchParams({
    valueInputOption: input.valueInputOption ?? "USER_ENTERED",
  });
  const response = await fetch(
    `${GOOGLE_SHEETS_SPREADSHEETS_ENDPOINT}/${encodeURIComponent(input.spreadsheetId)}/values/${encodeURIComponent(input.rangeA1)}?${searchParams.toString()}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: input.values }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Sheets values update failed."),
      { status: response.status, code: "google_workspace.sheets_update_failed" },
    );
  }

  const payload = await response.json() as {
    updatedRange?: string;
    updatedRows?: number;
    updatedCells?: number;
  };
  return {
    updatedRange: payload.updatedRange,
    updatedRows: payload.updatedRows,
    updatedCells: payload.updatedCells,
  };
}

export async function batchUpdateGoogleSheet(input: {
  accessToken: string;
  spreadsheetId: string;
  requests: Array<Record<string, unknown>>;
}): Promise<GoogleSheetsWriteResponse> {
  if (readGoogleWorkspaceExecutor() === "cli") {
    return batchUpdateGoogleSheetViaCli(input);
  }

  const response = await fetch(
    `${GOOGLE_SHEETS_SPREADSHEETS_ENDPOINT}/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests: input.requests }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google Sheets batch update failed."),
      { status: response.status, code: "google_workspace.sheets_batch_update_failed" },
    );
  }

  const payload = await response.json() as {
    replies?: unknown[];
  };
  return {
    replyCount: Array.isArray(payload.replies) ? payload.replies.length : 0,
  };
}

export async function createGoogleWorkspaceDoc(input: {
  accessToken: string;
  title: string;
}): Promise<GoogleWorkspaceDocFile> {
  const result = await createGoogleDocViaCli({
    accessToken: input.accessToken,
    title: input.title,
  });
  return {
    id: result.documentId,
    name: result.title,
    webViewLink: `https://docs.google.com/document/d/${result.documentId}/edit`,
    mimeType: GOOGLE_DOCS_MIME_TYPE,
  };
}

export async function appendGoogleDocText(input: {
  accessToken: string;
  documentId: string;
  text: string;
}): Promise<{ replyCount: number }> {
  return appendGoogleDocTextViaCli(input);
}

export async function batchUpdateGoogleDoc(input: {
  accessToken: string;
  documentId: string;
  requests: Array<Record<string, unknown>>;
}): Promise<{ replyCount: number }> {
  return batchUpdateGoogleDocViaCli(input);
}

async function exchangeGoogleWorkspaceAuthorizationCode(code: string): Promise<GoogleWorkspaceTokenPayload> {
  const config = readGoogleWorkspaceOAuthConfig();
  const tokenParams = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.callbackUrl,
    grant_type: "authorization_code",
  });

  return exchangeGoogleWorkspaceToken(tokenParams);
}

async function refreshGoogleWorkspaceAccessToken(refreshToken: string): Promise<GoogleWorkspaceTokenPayload> {
  const config = readGoogleWorkspaceOAuthConfig();
  const tokenParams = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
  });

  return exchangeGoogleWorkspaceToken(tokenParams);
}

async function exchangeGoogleWorkspaceToken(tokenParams: URLSearchParams): Promise<GoogleWorkspaceTokenPayload> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new GoogleWorkspaceApiError(
      await readGoogleApiErrorMessage(response, "Google OAuth token exchange failed."),
      { status: response.status, code: "google_workspace.token_exchange_failed" },
    );
  }

  const payload = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!payload.access_token) {
    throw new GoogleWorkspaceApiError("Google OAuth response did not include an access token.", {
      status: 502,
      code: "google_workspace.token_response_invalid",
    });
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt:
      typeof payload.expires_in === "number"
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : undefined,
    scopes: payload.scope?.trim() || GOOGLE_WORKSPACE_SCOPES.join(" "),
  };
}

async function readGoogleWorkspaceProfile(accessToken: string): Promise<GoogleWorkspaceProfile> {
  const response = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    return {};
  }

  const payload = await response.json() as {
    sub?: string;
    email?: string;
  };
  return {
    googleSubject: payload.sub?.trim() || undefined,
    googleEmail: payload.email?.trim().toLowerCase() || undefined,
  };
}

async function readGoogleApiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as {
      error?: {
        message?: string;
        status?: string;
      };
    };
    const detail = payload.error?.message?.trim() || payload.error?.status?.trim();
    return detail ? `${fallback} ${detail}` : fallback;
  } catch {
    return fallback;
  }
}

async function readGoogleDriveFileMetadataErrorMessage(response: Response): Promise<string> {
  const message = await readGoogleApiErrorMessage(response, "Google Drive file metadata read failed.");
  if (response.status !== 404) {
    return message;
  }
  const usesDriveFileScope = GOOGLE_WORKSPACE_SCOPES.includes("https://www.googleapis.com/auth/drive.file");
  const scopeHint = usesDriveFileScope
    ? " Current OAuth scope is drive.file; the file must be created by agent.dofe, explicitly opened/authorized through Picker, or the deployment must adopt a reviewed broader Drive scope."
    : "";
  return `${message} The current OAuth client/scope cannot see this file. This does not prove the Google account lacks browser access.${scopeHint}`;
}

function encryptGoogleWorkspaceToken(value: string): string {
  const key = readGoogleWorkspaceTokenEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    TOKEN_ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptGoogleWorkspaceToken(value: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(":");
  if (
    version !== TOKEN_ENCRYPTION_VERSION ||
    !encodedIv ||
    !encodedTag ||
    !encodedCiphertext
  ) {
    throw new Error("google_workspace.token_encryption_invalid");
  }

  const key = readGoogleWorkspaceTokenEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function readGoogleWorkspaceTokenEncryptionKey(): Buffer {
  const value = readRequiredGoogleWorkspaceEnv("DOFE_AGENT_GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("DOFE_AGENT_GOOGLE_WORKSPACE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

function signGoogleWorkspaceOAuthState(payload: GoogleWorkspaceOAuthStatePayload, secret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function readAndVerifyGoogleWorkspaceOAuthState(state: string, secret: string): GoogleWorkspaceOAuthStatePayload {
  const [encodedPayload, signature] = state.split(".");
  if (!encodedPayload || !signature) {
    throw new Error("google_workspace.state_invalid");
  }

  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  if (signature !== expectedSignature) {
    throw new Error("google_workspace.state_invalid");
  }

  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as GoogleWorkspaceOAuthStatePayload;
}

function normalizeRedirectAfter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }
  return trimmed;
}

function isExpiringSoon(expiresAt: string | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  return new Date(expiresAt).getTime() <= Date.now() + 60_000;
}

function normalizeGoogleDrivePermissionRole(value: string | undefined, fallback: "reader" | "writer"): "owner" | "reader" | "writer" {
  if (value === "owner" || value === "writer" || value === "reader") {
    return value;
  }
  return fallback;
}

function readRequiredGoogleWorkspaceEnv(name: string): string {
  const value = readServerEnvValue(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
