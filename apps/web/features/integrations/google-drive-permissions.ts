import { listWorkspaceMemberUsersSync } from "@dofe-agent/db";
import type { ChannelDocumentAccessRole } from "@dofe-agent/domain";
import {
  listChannelDocumentAccessesSync,
  readChannelDocumentSync,
  recordExternalSheetOperationRunSync,
  updateExternalSheetOperationRunSync,
} from "@dofe-agent/services";
import {
  createGoogleDriveFilePermission,
  deleteGoogleDriveFilePermission,
  listGoogleDriveFilePermissions,
  updateGoogleDriveFilePermission,
  type GoogleDriveFilePermission,
} from "@/features/integrations/google-workspace";

interface GoogleDrivePermissionTarget {
  emailAddress: string;
  driveRole: "reader" | "writer";
  actorId: string;
  documentRole: ChannelDocumentAccessRole;
}

export interface GoogleDrivePermissionSyncResult {
  runId?: string;
  status: "succeeded" | "failed";
  sharedCount: number;
  updatedCount: number;
  revokedCount: number;
  skippedCount: number;
  failedCount: number;
  message: string;
}

export async function syncGoogleSheetDocumentDrivePermissions(input: {
  accessToken: string;
  workspaceId: string;
  documentId: string;
  actorId: string;
  actorType?: "human" | "agent" | "system";
  skipEmails?: string[];
}): Promise<GoogleDrivePermissionSyncResult> {
  const { document } = readChannelDocumentSync(input.documentId, input.workspaceId);
  const plan = resolveGoogleDrivePermissionTargets({
    workspaceId: input.workspaceId,
    documentId: document.id,
    skipEmails: input.skipEmails,
  });
  const run = recordExternalSheetOperationRunSync({
    channelDocumentId: document.id,
    actorType: input.actorType ?? "system",
    actorId: input.actorId,
    status: "running",
    intent: "Sync Google Drive permissions for external sheet",
    operationType: "share",
    requestSummary: `Sync Drive permissions for ${plan.targets.length} collaborator(s); skipped ${plan.skippedCount}.`,
  }, input.workspaceId);

  const failures: string[] = [];
  let sharedCount = 0;
  let updatedCount = 0;
  let revokedCount = 0;
  let existingPermissions: GoogleDriveFilePermission[] = [];
  try {
    existingPermissions = await listGoogleDriveFilePermissions({
      accessToken: input.accessToken,
      fileId: document.externalFileId ?? "",
    });
  } catch (error) {
    failures.push(`list: ${error instanceof Error ? error.message : String(error)}`);
  }
  const permissionByEmail = new Map(existingPermissions.map((permission) => [permission.emailAddress, permission]));
  const desiredByEmail = new Map(plan.targets.map((target) => [target.emailAddress, target]));

  for (const target of plan.targets) {
    const existing = permissionByEmail.get(target.emailAddress);
    try {
      if (!existing) {
        await createGoogleDriveFilePermission({
          accessToken: input.accessToken,
          fileId: document.externalFileId ?? "",
          emailAddress: target.emailAddress,
          role: target.driveRole,
          sendNotificationEmail: false,
        });
        sharedCount += 1;
      } else if (existing.role !== "owner" && existing.role !== target.driveRole) {
        await updateGoogleDriveFilePermission({
          accessToken: input.accessToken,
          fileId: document.externalFileId ?? "",
          permissionId: existing.id,
          role: target.driveRole,
        });
        updatedCount += 1;
      }
    } catch (error) {
      failures.push(`${target.emailAddress}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const permission of existingPermissions) {
    if (
      permission.role === "owner" ||
      !plan.workspaceMemberEmails.has(permission.emailAddress) ||
      desiredByEmail.has(permission.emailAddress) ||
      plan.skipEmails.has(permission.emailAddress)
    ) {
      continue;
    }
    try {
      await deleteGoogleDriveFilePermission({
        accessToken: input.accessToken,
        fileId: document.externalFileId ?? "",
        permissionId: permission.id,
      });
      revokedCount += 1;
    } catch (error) {
      failures.push(`${permission.emailAddress}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    const updated = updateExternalSheetOperationRunSync({
      runId: run.id,
      status: "failed",
      responseSummary: buildPermissionSyncSummary({
        sharedCount,
        updatedCount,
        revokedCount,
        skippedCount: plan.skippedCount,
        failedCount: failures.length,
      }),
      errorCode: "google_workspace.permission_sync_failed",
      errorMessage: failures.join("; "),
    }, input.workspaceId);
    return {
      runId: updated.id,
      status: "failed",
      sharedCount,
      updatedCount,
      revokedCount,
      skippedCount: plan.skippedCount,
      failedCount: failures.length,
      message: updated.errorMessage ?? "Google Drive permission sync failed.",
    };
  }

  const responseSummary = buildPermissionSyncSummary({
    sharedCount,
    updatedCount,
    revokedCount,
    skippedCount: plan.skippedCount,
    failedCount: 0,
  });
  const updated = updateExternalSheetOperationRunSync({
    runId: run.id,
    status: "succeeded",
    responseSummary,
  }, input.workspaceId);
  return {
    runId: updated.id,
    status: "succeeded",
    sharedCount,
    updatedCount,
    revokedCount,
    skippedCount: plan.skippedCount,
    failedCount: 0,
    message: responseSummary,
  };
}

function resolveGoogleDrivePermissionTargets(input: {
  workspaceId: string;
  documentId: string;
  skipEmails?: string[];
}): {
  targets: GoogleDrivePermissionTarget[];
  workspaceMemberEmails: Set<string>;
  skipEmails: Set<string>;
  skippedCount: number;
} {
  const skipEmails = new Set((input.skipEmails ?? []).map((email) => normalizeEmail(email)).filter(Boolean));
  const members = listWorkspaceMemberUsersSync(input.workspaceId);
  const memberByDisplayName = new Map(
    members.map((member) => [normalizeDisplayName(member.displayName), member]),
  );
  const workspaceMemberEmails = new Set(members.map((member) => normalizeEmail(member.primaryEmail)).filter(Boolean));
  const seenEmails = new Set(skipEmails);
  let skippedCount = 0;
  const targets: GoogleDrivePermissionTarget[] = [];

  for (const access of listChannelDocumentAccessesSync(input.documentId, input.workspaceId)) {
    if (access.actorType !== "human") {
      skippedCount += 1;
      continue;
    }
    const member = memberByDisplayName.get(normalizeDisplayName(access.actorId));
    const emailAddress = normalizeEmail(member?.primaryEmail);
    if (!emailAddress || seenEmails.has(emailAddress)) {
      skippedCount += 1;
      continue;
    }
    seenEmails.add(emailAddress);
    targets.push({
      emailAddress,
      driveRole: access.role === "viewer" ? "reader" : "writer",
      actorId: access.actorId,
      documentRole: access.role,
    });
  }

  return { targets, workspaceMemberEmails, skipEmails, skippedCount };
}

function buildPermissionSyncSummary(input: {
  sharedCount: number;
  updatedCount: number;
  revokedCount: number;
  skippedCount: number;
  failedCount: number;
}): string {
  const changedCount = input.sharedCount + input.updatedCount + input.revokedCount;
  if (changedCount === 0 && input.failedCount === 0) {
    return `No Drive permission changes needed; skipped ${input.skippedCount}.`;
  }
  return [
    `Shared ${input.sharedCount}`,
    `updated ${input.updatedCount}`,
    `revoked ${input.revokedCount}`,
    `skipped ${input.skippedCount}`,
    `failed ${input.failedCount}`,
  ].join("; ") + ".";
}

function normalizeEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}
