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

export interface PrismaCutoverRollbackAsyncPublisher {
  publish(request: PrismaCutoverRollbackRequest): Promise<PrismaCutoverRollbackPublication>;
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
  const request = buildRollbackRequest(input);
  const publication = input.publisher.publish(request);
  recordRollbackPublication({ ...input, request, publication });
  return publication;
}

export async function publishPrismaCutoverRollback(input: {
  snapshot: PrismaCutoverSloSnapshot;
  releaseId: string;
  publisher: PrismaCutoverRollbackAsyncPublisher;
  workspaceId?: string;
}): Promise<PrismaCutoverRollbackPublication> {
  const request = buildRollbackRequest(input);
  const publication = await input.publisher.publish(request);
  recordRollbackPublication({ ...input, request, publication });
  return publication;
}

function buildRollbackRequest(input: {
  snapshot: PrismaCutoverSloSnapshot;
  releaseId: string;
}): PrismaCutoverRollbackRequest {
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
  return {
    domain: input.snapshot.domain,
    releaseId,
    currentFlagVersion,
    targetFlagVersion,
    rollbackReasons: [...input.snapshot.rollbackReasons],
    burnRate: input.snapshot.burnRate,
  };
}

function recordRollbackPublication(input: {
  snapshot: PrismaCutoverSloSnapshot;
  workspaceId?: string;
  request: PrismaCutoverRollbackRequest;
  publication: PrismaCutoverRollbackPublication;
}): void {
  if (!input.publication.publicationId.trim()) throw new Error("Rollback publisher returned an empty publicationId.");
  recordAuditLogSync({
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    idempotencyKey: `prisma.cutover.rollback:${input.request.releaseId}:${input.request.domain}:${input.request.currentFlagVersion}:${input.request.targetFlagVersion}`,
    title: "Prisma cutover rollback published",
    note: `${input.request.domain} rollback published to ${input.request.targetFlagVersion}`,
    code: "prisma.cutover.rollback.published",
    source: "platform_admin",
    data: {
      ...input.request,
      publicationId: input.publication.publicationId,
      publicationStatus: input.publication.status,
    },
  });
}
