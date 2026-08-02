import {
  hardDeleteExpiredSoftDeletedArtifactsSync,
  listEmployeePersistentWorkspacesSync,
  listWorkspacesSync,
} from "@dofe-agent/db";
import { reclaimOrphanContentBlobsSync } from "./persistent-workspace.ts";

export interface LifecycleMaintenanceOptions {
  workspaceId?: string;
  /** Default soft-delete recovery window before an artifact is hard-deleted. */
  softDeleteRetentionSeconds?: number;
  /** Orphan blobs younger than this are kept (recent uploads may still be in flight). */
  orphanBlobRetainSeconds?: number;
  blobDeleteLimit?: number;
  now?: string;
}

export interface LifecycleMaintenanceResult {
  workspaces: Array<{
    workspaceId: string;
    artifactsHardDeleted: number;
    freedDigests: number;
    orphanBlobsReclaimed: number;
  }>;
  totalArtifactsHardDeleted: number;
  totalOrphanBlobsReclaimed: number;
  checkedAt: string;
}

/**
 * Lifecycle policy worker (P2-1): enforced on the maintenance cron.
 *   1. Hard-deletes soft-deleted artifacts whose recovery window expired
 *      (default 30 days; per-employee retention_policy_json.softDeleteDays
 *      overrides when present).
 *   2. Reclaims orphan content blobs (controlled GC) — blobs referenced by no
 *      revision/artifact and older than the retain window are deleted from
 *      object storage.
 * Blobs freed by step 1 flow into step 2's unreferenced scan. Legal-hold /
 * quota enforcement are deliberately NOT part of this worker: legal hold is
 * expressed by NOT soft-deleting (or by a retention policy that keeps rows);
 * quota is a read-only monitoring concern for the dashboard.
 */
export function runEmployeeLifecycleMaintenanceSync(
  options: LifecycleMaintenanceOptions = {},
): LifecycleMaintenanceResult {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const softDeleteRetentionSeconds = options.softDeleteRetentionSeconds ?? 30 * 24 * 3600;
  const orphanBlobRetainSeconds = options.orphanBlobRetainSeconds ?? 7 * 24 * 3600;
  const blobDeleteLimit = options.blobDeleteLimit ?? 500;

  const workspaces = options.workspaceId
    ? listWorkspacesSync().filter((workspace) => workspace.id === options.workspaceId)
    : listWorkspacesSync();

  const results: LifecycleMaintenanceResult["workspaces"] = [];
  let totalArtifactsHardDeleted = 0;
  let totalOrphanBlobsReclaimed = 0;

  for (const workspace of workspaces) {
    const retentionSeconds = resolveWorkspaceSoftDeleteRetention(workspace.id, softDeleteRetentionSeconds);
    const cutoff = new Date(nowMs - retentionSeconds * 1000).toISOString();
    const hardDeleted = hardDeleteExpiredSoftDeletedArtifactsSync(workspace.id, cutoff);

    const orphanScan = reclaimOrphanContentBlobsSync({
      workspaceId: workspace.id,
      retainRecentSeconds: orphanBlobRetainSeconds,
      now,
      delete: true,
      limit: blobDeleteLimit,
    });

    totalArtifactsHardDeleted += hardDeleted.removed;
    totalOrphanBlobsReclaimed += orphanScan.reclaimedCount ?? 0;
    results.push({
      workspaceId: workspace.id,
      artifactsHardDeleted: hardDeleted.removed,
      freedDigests: hardDeleted.digests.length,
      orphanBlobsReclaimed: orphanScan.reclaimedCount ?? 0,
    });
  }

  return {
    workspaces: results,
    totalArtifactsHardDeleted,
    totalOrphanBlobsReclaimed,
    checkedAt: now,
  };
}

/** Per-employee retention policy override: retention_policy_json.softDeleteDays. */
function resolveWorkspaceSoftDeleteRetention(workspaceId: string, fallbackSeconds: number): number {
  try {
    const workspaces = listEmployeePersistentWorkspacesSync(workspaceId);
    const days = Math.max(
      0,
      ...workspaces.map((workspace) => {
        try {
          const policy = JSON.parse(workspace.retentionPolicyJson ?? "{}") as {
            softDeleteDays?: unknown;
          };
          return typeof policy.softDeleteDays === "number" && policy.softDeleteDays > 0
            ? policy.softDeleteDays * 24 * 3600
            : 0;
        } catch {
          return 0;
        }
      }),
    );
    return days > 0 ? days : fallbackSeconds;
  } catch {
    return fallbackSeconds;
  }
}
