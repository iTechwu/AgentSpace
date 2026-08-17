import {
  aggregatePrismaCutoverSloSnapshots,
  listPersistedPrismaCutoverSloSnapshotsSync,
  publishPrismaCutoverRollback,
  type PrismaCutoverRollbackPublication,
  type PrismaCutoverRollbackRequest,
} from "@dofe-agent/db";

export interface PrismaCutoverRollbackHttpConfig {
  webhookUrl: string;
  token?: string;
  timeoutMs?: number;
}

export function readPrismaCutoverRollbackHttpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PrismaCutoverRollbackHttpConfig | undefined {
  const webhookUrl = env.PRISMA_CUTOVER_ROLLBACK_WEBHOOK_URL?.trim();
  if (!webhookUrl) return undefined;
  return {
    webhookUrl,
    token: env.PRISMA_CUTOVER_ROLLBACK_TOKEN?.trim() || undefined,
    timeoutMs: readTimeout(env.PRISMA_CUTOVER_ROLLBACK_TIMEOUT_MS),
  };
}

export function createPrismaCutoverRollbackHttpPublisher(
  config: PrismaCutoverRollbackHttpConfig,
  fetchImpl: typeof fetch = fetch,
): { publish(request: PrismaCutoverRollbackRequest): Promise<PrismaCutoverRollbackPublication> } {
  const webhookUrl = config.webhookUrl.trim();
  if (!webhookUrl) throw new Error("PRISMA_CUTOVER_ROLLBACK_WEBHOOK_URL is required.");
  return {
    async publish(request) {
      const idempotencyKey = [
        "prisma-cutover-rollback",
        request.releaseId,
        request.domain,
        request.currentFlagVersion,
        request.targetFlagVersion,
      ].join(":");
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          action: "prisma_cutover.rollback",
          idempotencyKey,
          ...request,
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });
      if (!response.ok) throw new Error(`Rollback publisher returned HTTP ${response.status}.`);
      const body = await readJson(response);
      const publicationId = typeof body.publicationId === "string" ? body.publicationId.trim() : "";
      if (!publicationId) throw new Error("Rollback publisher response is missing publicationId.");
      const status = body.status === "published" ? "published" : "queued";
      return { publicationId, status };
    },
  };
}

/**
 * Publishes every rollback recommendation in the recent central SLO window.
 * Auto rollback is opt-in and fails closed when release/LKG configuration is
 * incomplete; the normal maintenance cycle still pages without publishing.
 */
export async function publishPrismaCutoverRollbacksFromEnv(input?: {
  workspaceId?: string;
  checkedAt?: string;
  windowSeconds?: number;
}): Promise<{ status: "published" | "skipped"; published: number; reason?: string; publications?: string[] }> {
  if (process.env.PRISMA_CUTOVER_AUTO_ROLLBACK_ENABLED !== "1") {
    return { status: "skipped", published: 0, reason: "PRISMA_CUTOVER_AUTO_ROLLBACK_ENABLED is not enabled." };
  }
  const config = readPrismaCutoverRollbackHttpConfigFromEnv();
  const releaseId = process.env.PRISMA_CUTOVER_RELEASE_ID?.trim();
  if (!config || !releaseId) {
    throw new Error("Rollback requires webhook and PRISMA_CUTOVER_RELEASE_ID configuration.");
  }
  const checkedAt = input?.checkedAt ?? new Date().toISOString();
  const windowSeconds = Math.min(Math.max(Math.trunc(input?.windowSeconds ?? 900), 60), 86_400);
  const createdFrom = new Date(Date.parse(checkedAt) - windowSeconds * 1000).toISOString();
  const snapshots = aggregatePrismaCutoverSloSnapshots(listPersistedPrismaCutoverSloSnapshotsSync({
    workspaceId: input?.workspaceId,
    createdFrom,
    createdTo: checkedAt,
  })).filter((snapshot) => snapshot.rollbackRecommended);
  const publisher = createPrismaCutoverRollbackHttpPublisher(config);
  const publications: string[] = [];
  for (const snapshot of snapshots) {
    const publication = await publishPrismaCutoverRollback({
      snapshot,
      releaseId,
      publisher,
      workspaceId: input?.workspaceId,
    });
    publications.push(publication.publicationId);
  }
  return { status: "published", published: publications.length, publications };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json() as unknown;
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readTimeout(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 120_000 ? Math.trunc(parsed) : undefined;
}
