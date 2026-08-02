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
    artifactsHeld: number;
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
 * Blobs freed by step 1 flow into step 2's unreferenced scan. Active legal
 * holds are enforced again in the database delete paths, including direct
 * blob deletion, so a worker bug cannot bypass them.
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
    const employeeWorkspaces = listEmployeePersistentWorkspacesSync(workspace.id);
    let artifactsHardDeleted = 0;
    let artifactsHeld = 0;
    const freedDigests = new Set<string>();
    let workspaceOrphanRetainSeconds = orphanBlobRetainSeconds;
    for (const employeeWorkspace of employeeWorkspaces) {
      const policy = readRetentionPolicy(employeeWorkspace.retentionPolicyJson);
      const retentionSeconds = policy.softDeleteDays
        ? policy.softDeleteDays * 24 * 3600
        : softDeleteRetentionSeconds;
      workspaceOrphanRetainSeconds = Math.max(
        workspaceOrphanRetainSeconds,
        (policy.orphanBlobRetainDays ?? 0) * 24 * 3600,
      );
      const cutoff = new Date(nowMs - retentionSeconds * 1000).toISOString();
      const hardDeleted = hardDeleteExpiredSoftDeletedArtifactsSync(
        workspace.id,
        cutoff,
        employeeWorkspace.employeeId,
      );
      artifactsHardDeleted += hardDeleted.removed;
      artifactsHeld += hardDeleted.held;
      for (const digest of hardDeleted.digests) freedDigests.add(digest);
    }

    const orphanScan = reclaimOrphanContentBlobsSync({
      workspaceId: workspace.id,
      retainRecentSeconds: workspaceOrphanRetainSeconds,
      now,
      delete: true,
      limit: blobDeleteLimit,
    });

    totalArtifactsHardDeleted += artifactsHardDeleted;
    totalOrphanBlobsReclaimed += orphanScan.reclaimedCount ?? 0;
    results.push({
      workspaceId: workspace.id,
      artifactsHardDeleted,
      artifactsHeld,
      freedDigests: freedDigests.size,
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

export interface EmployeeDataRetentionPolicy {
  softDeleteDays?: number;
  orphanBlobRetainDays?: number;
  quotaBytes?: number;
}

export function readRetentionPolicy(value: string): EmployeeDataRetentionPolicy {
  try {
    const parsed = JSON.parse(value || "{}") as Record<string, unknown>;
    return {
      softDeleteDays: positiveFiniteNumber(parsed.softDeleteDays),
      orphanBlobRetainDays: positiveFiniteNumber(parsed.orphanBlobRetainDays),
      quotaBytes: positiveFiniteNumber(parsed.quotaBytes),
    };
  } catch {
    return {};
  }
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
