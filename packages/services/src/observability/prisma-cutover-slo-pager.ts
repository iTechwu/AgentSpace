import {
  aggregatePrismaCutoverSloSnapshots,
  listPersistedPrismaCutoverSloSnapshotsSync,
  type PrismaCutoverSloThresholds,
} from "@dofe-agent/db";
import { sendExternalPagerAlert, type ExternalPagerConfig } from "./external-pager.ts";

/** SLO pager 的告警域 code：recovery 检测只清理该域状态，不动其他告警域。 */
export const PRISMA_CUTOVER_SLO_PAGER_CODE = "prisma.cutover.slo.burn_rate";

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
  windowSeconds?: number;
  config?: ExternalPagerConfig;
}): Promise<{ sent: boolean; reason?: string; escalatedCount?: number; recoveredCount?: number }> {
  const workspaceId = options.workspaceId ?? "default";
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  const windowSeconds = options.windowSeconds ?? 15 * 60;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("windowSeconds must be a positive integer.");
  }
  const createdFrom = new Date(Date.parse(checkedAt) - windowSeconds * 1000).toISOString();
  const snapshots = aggregatePrismaCutoverSloSnapshots(
    listPersistedPrismaCutoverSloSnapshotsSync({ workspaceId, limit: options.limit, createdFrom, createdTo: checkedAt }),
  );
  const alerts = snapshots
    .filter((snapshot) => snapshot.sampleCount >= options.thresholds.minimumSamples)
    .filter((snapshot) => snapshot.rollbackRecommended || snapshot.rollbackReasons.length > 0)
    .map((snapshot) => ({
      code: PRISMA_CUTOVER_SLO_PAGER_CODE,
      severity: snapshot.deadlockRate > 0 || snapshot.p2034Rate > 0 ? "error" as const : "warning" as const,
      message: `Prisma cutover ${snapshot.domain} exceeded SLO: ${snapshot.rollbackReasons.join(", ") || "burn_rate"}`,
      // 稳定 key：与 cutover-slo-store 的 syncSloAlertState 一致（按域一个 key）。
      // 若用含 metric JSON 的派生 key，burn rate 一变就生成新 key，旧 key 会被
      // 误判为已恢复，同一周期同时发出告警与 recovery（复审 P1）。
      alertKey: `prisma-cutover-slo:${snapshot.domain}`,
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
  return sendExternalPagerAlert({
    alerts,
    workspaceId,
    checkedAt,
    config: options.config,
    forceRecovery: alerts.length === 0,
    recoveryCodes: [PRISMA_CUTOVER_SLO_PAGER_CODE],
  });
}
