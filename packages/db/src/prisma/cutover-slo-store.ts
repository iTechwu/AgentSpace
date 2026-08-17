import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  deleteAuditLogsByIdsSync,
  recordAuditLogSync,
} from "../audit-log.ts";
import { canonicalizeAuditLogDataJson } from "../audit-log-idempotency.ts";
import {
  markPagerAlertClearedSync,
  upsertPagerAlertStateSync,
} from "../pager-alert-state.ts";
import { DEFAULT_WORKSPACE_ID, getDatabase, withTransaction } from "../database.ts";
import { evaluateCutoverSloRollback, type PrismaCutoverSloSnapshot, type PrismaCutoverSloThresholds } from "./cutover-slo.ts";

export const PRISMA_CUTOVER_SLO_SNAPSHOT_CODE = "prisma.cutover.slo.snapshot";

export interface PersistPrismaCutoverSloSnapshotsInput {
  snapshots: readonly PrismaCutoverSloSnapshot[];
  instanceId: string;
  workspaceId?: string;
  now?: string;
  /** 测试注入：自定义 alert 状态同步；缺省写入真实 pager state。 */
  syncAlertState?: (snapshot: PersistedPrismaCutoverSloSnapshot) => void;
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
  const maxRows = Math.min(Math.max(Math.trunc(input.maxRows ?? 1_000), 1), 10_000);
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  // 过期侧游标扫描：不能直接复用 listAuditLogsSync（DESC + 500 上限）——持续
  // 写入时最新 500 行永远不含过期行，旧数据无法归档（复审 P1）。过期语义以
  // windowEnd（数据时间）为准，created_at（真实插入时间）兜底；SQL 侧同时下推
  // 两个条件，从最早开始 ASC 翻页，持续写入下过期行始终可达。
  const selected: Array<{ id: string; createdAt: string; dataJson: string; archive: Record<string, unknown> }> = [];
  const pageSize = Math.min(maxRows, 500);
  let cursorCreatedAt = new Date(0).toISOString();
  let cursorId = "";
  while (selected.length < maxRows) {
    const rows = getDatabase().prepare(
      `SELECT id, workspace_id AS "workspaceId", title, note, code,
              data_json AS "dataJson", source, source_index AS "sourceIndex",
              created_at AS "createdAt"
         FROM audit_log
        WHERE workspace_id = ? AND code = ?
          AND (created_at <= ? OR data_json ->> 'windowEnd' <= ?)
          AND (created_at, id) > (?, ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).all(
      workspaceId,
      PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
      cutoff,
      cutoff,
      cursorCreatedAt,
      cursorId,
      Math.min(pageSize, maxRows - selected.length),
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      cursorCreatedAt = row.createdAt as string;
      cursorId = row.id as string;
      const dataJson = typeof row.dataJson === "string" ? row.dataJson : JSON.stringify(row.dataJson);
      try {
        const data = JSON.parse(dataJson) as { windowEnd?: unknown };
        if (typeof data.windowEnd === "string" && data.windowEnd > cutoff) continue;
      } catch {
        // 无 windowEnd 时按 created_at 判定（SQL 已过滤）。
      }
      selected.push({
        id: row.id as string,
        createdAt: row.createdAt as string,
        dataJson,
        archive: {
          ...row,
          code: row.code ?? undefined,
          dataJson: canonicalizeAuditLogDataJson(dataJson),
        },
      });
    }
    if (rows.length < pageSize || rows.length === 0) break;
  }
  if (selected.length === 0) return { status: "skipped", selected: 0, deleted: 0, cutoff };
  const archiveDir = input.archiveDir?.trim();
  if (!archiveDir) return { status: "skipped", selected: selected.length, deleted: 0, cutoff };
  mkdirSync(archiveDir, { recursive: true });
  const month = cutoff.slice(0, 7);
  const archiveFile = join(archiveDir, `prisma-cutover-slo-${month}.jsonl`);
  appendFileSync(
    archiveFile,
    selected.map((row) => JSON.stringify({ archivedAt: now, audit: row.archive })).join("\n") + "\n",
    { encoding: "utf8" },
  );
  const deleted = deleteAuditLogsByIdsSync({ workspaceId: input.workspaceId, ids: selected.map((row) => row.id) });
  return { status: "archived", archiveFile, selected: selected.length, deleted, cutoff };
}

/**
 * Writes one immutable snapshot per domain/window to the central PostgreSQL
 * audit ledger. The idempotency key makes retries safe across instances while
 * keeping the existing schema migration contract (no ad-hoc table creation).
 *
 * 整个 per-snapshot 落账（audit row + pager state）包在同一事务内：
 * pager state 更新失败时 audit row 一起回滚，避免外部已计数而窗口未清空
 * 导致的下一周期重复落账（复审 P1）。
 */
export function persistPrismaCutoverSloSnapshotsSync(
  input: PersistPrismaCutoverSloSnapshotsInput,
): PersistedPrismaCutoverSloSnapshot[] {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const instanceId = input.instanceId.trim();
  if (!instanceId) throw new Error("instanceId is required for SLO persistence.");
  const persistedAt = input.now ?? new Date().toISOString();
  const syncAlert = input.syncAlertState ?? syncSloAlertState;
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
    withTransaction(getDatabase(), () => {
      recordAuditLogSync({
        workspaceId,
        idempotencyKey: `${PRISMA_CUTOVER_SLO_SNAPSHOT_CODE}:${instanceId}:${snapshot.domain}:${windowEnd}`,
        title: "Prisma cutover SLO snapshot",
        note: `${snapshot.domain} SLO snapshot from ${instanceId}`,
        code: PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
        source: "platform_admin",
        data: { ...persisted } as Record<string, unknown>,
      });
      syncAlert(persisted);
    });
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
  // 分页读取：跨实例或多域在 15 分钟窗口内很容易超过旧硬上限 500；
  // 用 (created_at, id) 游标翻页，同毫秒写入不重不漏。
  // createdFrom 下推 SQL：windowEnd <= created_at（真实落账时间）恒成立，
  // 因此 windowEnd >= createdFrom 的行必然满足 created_at >= createdFrom，
  // 短窗口查询不再从 epoch 扫描全部历史快照（复审 P2）。createdTo 不下推——
  // 迟到的 flush created_at 可能超过 createdTo 而 windowEnd 仍在窗口内。
  // MAXIMUM_SNAPSHOT_ROWS 按扫描行数计数，真正限制单次查询的扫描量。
  const pageSize = Math.min(Math.max(input?.limit ?? 5_000, 1), 10_000);
  const MAXIMUM_SNAPSHOT_ROWS = 200_000;
  const snapshots: PersistedPrismaCutoverSloSnapshot[] = [];
  let scanned = 0;
  let cursorCreatedAt: string | Date = input?.createdFrom ?? new Date(0).toISOString();
  let cursorId = "";
  for (;;) {
    const rows = getDatabase().prepare(
      `SELECT id, created_at AS "createdAt", data_json AS "dataJson"
         FROM audit_log
        WHERE workspace_id = ? AND code = ?
          AND (created_at, id) > (?, ?)
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).all(
      workspaceId,
      PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
      cursorCreatedAt,
      cursorId,
      pageSize,
    ) as Array<{ id: string; createdAt: string | Date; dataJson: unknown }>;
    scanned += rows.length;
    for (const row of rows) {
      cursorCreatedAt = row.createdAt;
      cursorId = row.id;
      let parsed: Partial<PersistedPrismaCutoverSloSnapshot>;
      try {
        parsed = typeof row.dataJson === "string" ? JSON.parse(row.dataJson) : (row.dataJson as Partial<PersistedPrismaCutoverSloSnapshot>);
      } catch {
        continue;
      }
      if (
        typeof parsed.domain !== "string" ||
        typeof parsed.sampleCount !== "number" ||
        typeof parsed.instanceId !== "string" ||
        typeof parsed.windowEnd !== "string"
      ) continue;
      if (input?.createdFrom && parsed.windowEnd < input.createdFrom) continue;
      if (input?.createdTo && parsed.windowEnd > input.createdTo) continue;
      snapshots.push({ ...parsed, workspaceId } as PersistedPrismaCutoverSloSnapshot);
    }
    if (rows.length < pageSize) break;
    if (scanned >= MAXIMUM_SNAPSHOT_ROWS) break;
  }
  return snapshots;
}

/** Weighted aggregation across snapshots written by different instances. */
export function aggregatePrismaCutoverSloSnapshots(
  snapshots: readonly PrismaCutoverSloSnapshot[],
  options?: { thresholds?: PrismaCutoverSloThresholds },
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
    const shadowComparisonRate = sampleCount === 0
      ? 0
      : rows.reduce((sum, row) => sum + (row.shadowComparisonRate ?? 0) * row.sampleCount, 0) / sampleCount;
    // 历史快照（2026-08 前）无 linkConflictRate 字段，按 0 参与加权。
    const linkConflictRate = sampleCount === 0
      ? 0
      : rows.reduce((sum, row) => sum + (row.linkConflictRate ?? 0) * row.sampleCount, 0) / sampleCount;
    const eventOrderComparedCount = rows.reduce(
      (sum, row) => sum + (row.eventOrderComparedCount ?? (row.eventOrderDriftRate === undefined ? 0 : row.sampleCount)),
      0,
    );
    const eventOrderDriftRate = eventOrderComparedCount === 0
      ? 0
      : rows.reduce((sum, row) => {
          const comparedCount = row.eventOrderComparedCount ?? (row.eventOrderDriftRate === undefined ? 0 : row.sampleCount);
          return sum + (row.eventOrderDriftRate ?? 0) * comparedCount;
        }, 0) / eventOrderComparedCount;
    const p95DurationMs = Math.max(0, ...rows.map((row) => row.p95DurationMs));
    const rates = {
      mismatchRate: weighted("mismatchRate"),
      fallbackRate: weighted("fallbackRate"),
      errorRate: weighted("errorRate"),
      p95DurationMs,
      deadlockRate: weighted("deadlockRate"),
      p2034Rate: weighted("p2034Rate"),
      linkConflictRate,
      eventOrderDriftRate,
    };
    // 提供 thresholds 时对聚合 rate 重跑阈值判定：直接并集实例级 reason 会漏报
    // （各实例不足最小样本、合计已超阈值）和误报（单个小实例异常）（复审 P1）。
    // 缺省保持实例级并集，兼容 shadow-readiness 等只读历史判定结果的调用方。
    const verdict = options?.thresholds
      ? evaluateCutoverSloRollback(rates, sampleCount, options.thresholds, { eventOrder: eventOrderComparedCount })
      : {
          burnRate: Math.max(0, ...rows.map((row) => row.burnRate)),
          rollbackRecommended: rows.some((row) => row.rollbackRecommended),
          rollbackReasons: [...new Set(rows.flatMap((row) => row.rollbackReasons))] as PrismaCutoverSloSnapshot["rollbackReasons"],
        };
    return {
      domain,
      sampleCount,
      mismatchRate: rates.mismatchRate,
      shadowComparisonRate,
      fallbackRate: rates.fallbackRate,
      errorRate: rates.errorRate,
      p95DurationMs,
      deadlockRate: rates.deadlockRate,
      p2034Rate: rates.p2034Rate,
      linkConflictRate,
      eventOrderDriftRate,
      eventOrderComparedCount,
      burnRate: verdict.burnRate,
      rollbackRecommended: verdict.rollbackRecommended,
      rollbackReasons: verdict.rollbackReasons,
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
  // 只负责“置活跃”：多实例场景下，一个实例的健康快照不得清除另一个实例
  // 仍活跃的异常状态。聚合 pager 阶段（sendExternalPagerAlert）会对比当前
  // 告警集合与历史活跃状态，统一发出 recovery 并清理。
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
  }
}
