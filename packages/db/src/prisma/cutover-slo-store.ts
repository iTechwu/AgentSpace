import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  deleteAuditLogsByIdsSync,
  listAuditLogsSync,
  recordAuditLogSync,
} from "../audit-log.ts";
import {
  markPagerAlertClearedSync,
  upsertPagerAlertStateSync,
} from "../pager-alert-state.ts";
import { DEFAULT_WORKSPACE_ID } from "../database.ts";
import type { PrismaCutoverSloSnapshot } from "./cutover-slo.ts";

export const PRISMA_CUTOVER_SLO_SNAPSHOT_CODE = "prisma.cutover.slo.snapshot";

export interface PersistPrismaCutoverSloSnapshotsInput {
  snapshots: readonly PrismaCutoverSloSnapshot[];
  instanceId: string;
  workspaceId?: string;
  now?: string;
}

export interface PersistedPrismaCutoverSloSnapshot extends PrismaCutoverSloSnapshot {
  workspaceId: string;
  persistedAt: string;
}

export interface PrismaCutoverSloArchiveResult {
  status: "archived" | "skipped";
  archiveFile?: string;
  selected: number;
  deleted: number;
  cutoff: string;
}

/**
 * Archives and prunes old SLO ledger rows. The append is completed before any
 * delete, so an unavailable archive path preserves the immutable audit rows.
 * Deployments should point archiveDir at durable object-storage sync storage.
 */
export function archivePrismaCutoverSloSnapshotsToFileSync(input: {
  archiveDir?: string;
  workspaceId?: string;
  retentionDays?: number;
  maxRows?: number;
  now?: string;
}): PrismaCutoverSloArchiveResult {
  const retentionDays = Math.min(Math.max(Math.trunc(input.retentionDays ?? 30), 1), 3_650);
  const now = input.now ?? new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
  const selected = listAuditLogsSync(input.workspaceId, {
    code: PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
    limit: Math.min(Math.max(Math.trunc(input.maxRows ?? 1_000), 1), 10_000),
  }).filter((row) => {
    try {
      const data = JSON.parse(row.dataJson) as { windowEnd?: unknown };
      return typeof data.windowEnd === "string" ? data.windowEnd <= cutoff : row.createdAt <= cutoff;
    } catch {
      return row.createdAt <= cutoff;
    }
  });
  if (selected.length === 0) return { status: "skipped", selected: 0, deleted: 0, cutoff };
  const archiveDir = input.archiveDir?.trim();
  if (!archiveDir) return { status: "skipped", selected: selected.length, deleted: 0, cutoff };
  mkdirSync(archiveDir, { recursive: true });
  const month = cutoff.slice(0, 7);
  const archiveFile = join(archiveDir, `prisma-cutover-slo-${month}.jsonl`);
  appendFileSync(
    archiveFile,
    selected.map((row) => JSON.stringify({ archivedAt: now, audit: row })).join("\n") + "\n",
    { encoding: "utf8" },
  );
  const deleted = deleteAuditLogsByIdsSync({ workspaceId: input.workspaceId, ids: selected.map((row) => row.id) });
  return { status: "archived", archiveFile, selected: selected.length, deleted, cutoff };
}

/**
 * Writes one immutable snapshot per domain/window to the central PostgreSQL
 * audit ledger. The idempotency key makes retries safe across instances while
 * keeping the existing schema migration contract (no ad-hoc table creation).
 */
export function persistPrismaCutoverSloSnapshotsSync(
  input: PersistPrismaCutoverSloSnapshotsInput,
): PersistedPrismaCutoverSloSnapshot[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const instanceId = input.instanceId.trim();
  if (!instanceId) throw new Error("instanceId is required for SLO persistence.");
  const persistedAt = input.now ?? new Date().toISOString();
  return input.snapshots.map((snapshot) => {
    const windowEnd = snapshot.windowEnd ?? persistedAt;
    const windowStart = snapshot.windowStart ?? windowEnd;
    const persisted: PersistedPrismaCutoverSloSnapshot = {
      ...snapshot,
      instanceId,
      windowStart,
      windowEnd,
      workspaceId,
      persistedAt,
    };
    recordAuditLogSync({
      workspaceId,
      idempotencyKey: `${PRISMA_CUTOVER_SLO_SNAPSHOT_CODE}:${instanceId}:${snapshot.domain}:${windowEnd}`,
      title: "Prisma cutover SLO snapshot",
      note: `${snapshot.domain} SLO snapshot from ${instanceId}`,
      code: PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
      source: "platform_admin",
      data: { ...persisted } as Record<string, unknown>,
    });
    syncSloAlertState(persisted);
    return persisted;
  });
}

export function listPersistedPrismaCutoverSloSnapshotsSync(input?: {
  workspaceId?: string;
  limit?: number;
  createdFrom?: string;
  createdTo?: string;
}): PersistedPrismaCutoverSloSnapshot[] {
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  return listAuditLogsSync(workspaceId, {
    code: PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
    limit: Math.min(Math.max(input?.limit ?? 500, 1), 500),
  }).flatMap((row) => {
    try {
      const parsed = JSON.parse(row.dataJson) as Partial<PersistedPrismaCutoverSloSnapshot>;
      if (
        typeof parsed.domain !== "string" ||
        typeof parsed.sampleCount !== "number" ||
        typeof parsed.instanceId !== "string" ||
        typeof parsed.windowEnd !== "string"
      ) return [];
      if (input?.createdFrom && parsed.windowEnd < input.createdFrom) return [];
      if (input?.createdTo && parsed.windowEnd > input.createdTo) return [];
      return [{ ...parsed, workspaceId } as PersistedPrismaCutoverSloSnapshot];
    } catch {
      return [];
    }
  });
}

/** Weighted aggregation across snapshots written by different instances. */
export function aggregatePrismaCutoverSloSnapshots(
  snapshots: readonly PrismaCutoverSloSnapshot[],
): PrismaCutoverSloSnapshot[] {
  const byDomain = new Map<string, PrismaCutoverSloSnapshot[]>();
  for (const snapshot of snapshots) {
    const rows = byDomain.get(snapshot.domain) ?? [];
    rows.push(snapshot);
    byDomain.set(snapshot.domain, rows);
  }
  return [...byDomain.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([domain, rows]) => {
    const sampleCount = rows.reduce((sum, row) => sum + row.sampleCount, 0);
    const weighted = (field: "mismatchRate" | "fallbackRate" | "errorRate" | "deadlockRate" | "p2034Rate") =>
      sampleCount === 0 ? 0 : rows.reduce((sum, row) => sum + row[field] * row.sampleCount, 0) / sampleCount;
    const p95DurationMs = Math.max(0, ...rows.map((row) => row.p95DurationMs));
    const burnRate = Math.max(0, ...rows.map((row) => row.burnRate));
    const rollbackReasons = [...new Set(rows.flatMap((row) => row.rollbackReasons))] as PrismaCutoverSloSnapshot["rollbackReasons"];
    return {
      domain,
      sampleCount,
      mismatchRate: weighted("mismatchRate"),
      fallbackRate: weighted("fallbackRate"),
      errorRate: weighted("errorRate"),
      p95DurationMs,
      deadlockRate: weighted("deadlockRate"),
      p2034Rate: weighted("p2034Rate"),
      burnRate,
      rollbackRecommended: rows.some((row) => row.rollbackRecommended),
      rollbackReasons,
      flagVersion: rows.find((row) => row.flagVersion)?.flagVersion,
      lastKnownGoodFlagVersion: rows.find((row) => row.lastKnownGoodFlagVersion)?.lastKnownGoodFlagVersion,
      windowStart: rows.map((row) => row.windowStart).filter(Boolean).sort()[0],
      windowEnd: rows.map((row) => row.windowEnd).filter(Boolean).sort().at(-1),
    };
  });
}

function syncSloAlertState(snapshot: PersistedPrismaCutoverSloSnapshot): void {
  const alertKey = `prisma-cutover-slo:${snapshot.domain}`;
  const reasons = snapshot.rollbackReasons;
  if (snapshot.rollbackRecommended || reasons.length > 0) {
    upsertPagerAlertStateSync({
      workspaceId: snapshot.workspaceId,
      alertKey,
      code: "prisma.cutover.slo.burn_rate",
      metric: JSON.stringify({
        domain: snapshot.domain,
        burnRate: snapshot.burnRate,
        rollbackReasons: reasons,
        deadlockRate: snapshot.deadlockRate,
        p2034Rate: snapshot.p2034Rate,
      }),
      severity: snapshot.deadlockRate > 0 || snapshot.p2034Rate > 0 ? "critical" : "warning",
      now: snapshot.persistedAt,
    });
    return;
  }
  markPagerAlertClearedSync({ workspaceId: snapshot.workspaceId, alertKey, now: snapshot.persistedAt });
}
