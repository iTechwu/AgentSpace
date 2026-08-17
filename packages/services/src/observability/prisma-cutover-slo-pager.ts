import {
  aggregatePrismaCutoverSloSnapshots,
  listPersistedPrismaCutoverSloSnapshotsSync,
  type PrismaCutoverSloThresholds,
} from "@dofe-agent/db";
import { sendExternalPagerAlert, type ExternalPagerConfig } from "./external-pager.ts";

/**
 * Converts centrally persisted Prisma cutover snapshots into the existing
 * external pager contract. This is intended for a scheduled maintenance job;
 * it deliberately reads the central ledger instead of process-local memory.
 */
export async function sendPrismaCutoverSloPagerAlert(options: {
  thresholds: PrismaCutoverSloThresholds;
  workspaceId?: string;
  checkedAt?: string;
  limit?: number;
  config?: ExternalPagerConfig;
}): Promise<{ sent: boolean; reason?: string; escalatedCount?: number; recoveredCount?: number }> {
  const workspaceId = options.workspaceId ?? "default";
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const snapshots = aggregatePrismaCutoverSloSnapshots(
    listPersistedPrismaCutoverSloSnapshotsSync({ workspaceId, limit: options.limit }),
  );
  const alerts = snapshots
    .filter((snapshot) => snapshot.sampleCount >= options.thresholds.minimumSamples)
    .filter((snapshot) => snapshot.rollbackRecommended || snapshot.rollbackReasons.length > 0)
    .map((snapshot) => ({
      code: "prisma.cutover.slo.burn_rate",
      severity: snapshot.deadlockRate > 0 || snapshot.p2034Rate > 0 ? "error" as const : "warning" as const,
      message: `Prisma cutover ${snapshot.domain} exceeded SLO: ${snapshot.rollbackReasons.join(", ") || "burn_rate"}`,
      metric: JSON.stringify({
        domain: snapshot.domain,
        burnRate: snapshot.burnRate,
        deadlockRate: snapshot.deadlockRate,
        p2034Rate: snapshot.p2034Rate,
        flagVersion: snapshot.flagVersion,
        lastKnownGoodFlagVersion: snapshot.lastKnownGoodFlagVersion,
      }),
      value: snapshot.burnRate,
    }));
  return sendExternalPagerAlert({ alerts, workspaceId, checkedAt, config: options.config });
}
