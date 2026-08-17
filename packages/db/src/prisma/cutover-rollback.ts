import { recordAuditLogSync } from "../audit-log.ts";
import { DEFAULT_WORKSPACE_ID } from "../database.ts";
import type { PrismaCutoverSloSnapshot } from "./cutover-slo.ts";

export interface PrismaCutoverRollbackRequest {
  domain: string;
  releaseId: string;
  currentFlagVersion: string;
  targetFlagVersion: string;
  rollbackReasons: PrismaCutoverSloSnapshot["rollbackReasons"];
  burnRate: number;
}

export interface PrismaCutoverRollbackPublication {
  publicationId: string;
  status: "queued" | "published";
}

export interface PrismaCutoverRollbackPublisher {
  publish(request: PrismaCutoverRollbackRequest): PrismaCutoverRollbackPublication;
}

/**
 * Publishes an SLO-triggered rollback to the deployment adapter and records the
 * exact last-known-good flag version selected for replay.
 */
export function publishPrismaCutoverRollbackSync(input: {
  snapshot: PrismaCutoverSloSnapshot;
  releaseId: string;
  publisher: PrismaCutoverRollbackPublisher;
  workspaceId?: string;
}): PrismaCutoverRollbackPublication {
  const releaseId = input.releaseId.trim();
  if (!releaseId) throw new Error("releaseId is required for Prisma cutover rollback.");
  if (!input.snapshot.rollbackRecommended || input.snapshot.rollbackReasons.length === 0) {
    throw new Error(`Prisma cutover rollback is not recommended for ${input.snapshot.domain}.`);
  }
  const currentFlagVersion = input.snapshot.flagVersion?.trim();
  const targetFlagVersion = input.snapshot.lastKnownGoodFlagVersion?.trim();
  if (!currentFlagVersion || !targetFlagVersion) {
    throw new Error("Both current and last-known-good flag versions are required for rollback publication.");
  }
  if (currentFlagVersion === targetFlagVersion) {
    throw new Error("Rollback target must differ from the current flag version.");
  }
  const request: PrismaCutoverRollbackRequest = {
    domain: input.snapshot.domain,
    releaseId,
    currentFlagVersion,
    targetFlagVersion,
    rollbackReasons: [...input.snapshot.rollbackReasons],
    burnRate: input.snapshot.burnRate,
  };
  const publication = input.publisher.publish(request);
  if (!publication.publicationId.trim()) throw new Error("Rollback publisher returned an empty publicationId.");
  recordAuditLogSync({
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    idempotencyKey: `prisma.cutover.rollback:${releaseId}:${input.snapshot.domain}:${currentFlagVersion}:${targetFlagVersion}`,
    title: "Prisma cutover rollback published",
    note: `${input.snapshot.domain} rollback published to ${targetFlagVersion}`,
    code: "prisma.cutover.rollback.published",
    source: "platform_admin",
    data: {
      ...request,
      publicationId: publication.publicationId,
      publicationStatus: publication.status,
    },
  });
  return publication;
}
