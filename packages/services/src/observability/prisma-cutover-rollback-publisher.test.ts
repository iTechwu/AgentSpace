import assert from "node:assert/strict";
import test from "node:test";
import { getDatabase, persistPrismaCutoverSloSnapshotsSync } from "@dofe-agent/db";
import {
  createPrismaCutoverRollbackHttpPublisher,
  publishPrismaCutoverRollbacksFromEnv,
  readPrismaCutoverRollbackHttpConfigFromEnv,
} from "./prisma-cutover-rollback-publisher.ts";

const request = {
  domain: "task-queue",
  releaseId: "release-42",
  currentFlagVersion: "flags-v2",
  targetFlagVersion: "flags-v1",
  rollbackReasons: ["error_rate"] as const,
  burnRate: 3,
};

test("rollback HTTP publisher sends an idempotent last-known-good request", async () => {
  let received: { url?: string; init?: RequestInit } | undefined;
  const publisher = createPrismaCutoverRollbackHttpPublisher(
    { webhookUrl: "https://release.example/rollback", token: "secret" },
    async (url, init) => {
      received = { url, init };
      return new Response(JSON.stringify({ publicationId: "publication-1", status: "queued" }), { status: 202 });
    },
  );
  const publication = await publisher.publish(request);
  assert.deepEqual(publication, { publicationId: "publication-1", status: "queued" });
  assert.equal(received?.url, "https://release.example/rollback");
  assert.equal(received?.init?.headers && (received.init.headers as Record<string, string>)["authorization"], "Bearer secret");
  assert.match(String(received?.init?.body), /flags-v1/);
  assert.match(String(received?.init?.headers && (received.init.headers as Record<string, string>)["idempotency-key"]), /release-42/);
});

test("rollback config stays absent until a webhook is explicitly configured", () => {
  assert.equal(readPrismaCutoverRollbackHttpConfigFromEnv({}), undefined);
  assert.deepEqual(
    readPrismaCutoverRollbackHttpConfigFromEnv({
      PRISMA_CUTOVER_ROLLBACK_WEBHOOK_URL: " https://release.example/rollback ",
      PRISMA_CUTOVER_ROLLBACK_TOKEN: " token ",
      PRISMA_CUTOVER_ROLLBACK_TIMEOUT_MS: "15000",
    }),
    { webhookUrl: "https://release.example/rollback", token: "token", timeoutMs: 15000 },
  );
});

test("auto rollback re-evaluates thresholds across instances", async () => {
  const db = getDatabase();
  const workspaceId = "ws-rollback-aggregate";
  const now = new Date().toISOString();
  const checkedAt = new Date(Date.parse(now) + 1_000).toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'Rollback aggregate', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, now, now);
  db.prepare("DELETE FROM audit_log WHERE workspace_id = ?").run(workspaceId);

  const snapshot = (instanceId: string) => ({
    domain: "workflow-dispatcher",
    sampleCount: 6,
    mismatchRate: 0.5,
    shadowComparisonRate: 0,
    fallbackRate: 0,
    errorRate: 0,
    p95DurationMs: 10,
    deadlockRate: 0,
    p2034Rate: 0,
    burnRate: 0,
    rollbackRecommended: false,
    rollbackReasons: [] as const,
    flagVersion: "flags-v2",
    lastKnownGoodFlagVersion: "flags-v1",
    instanceId,
    windowStart: now,
    windowEnd: now,
  });
  persistPrismaCutoverSloSnapshotsSync({ instanceId: "rollback-a", workspaceId, now, snapshots: [snapshot("rollback-a")] });
  persistPrismaCutoverSloSnapshotsSync({ instanceId: "rollback-b", workspaceId, now, snapshots: [snapshot("rollback-b")] });

  const envKeys = [
    "PRISMA_CUTOVER_AUTO_ROLLBACK_ENABLED",
    "PRISMA_CUTOVER_ROLLBACK_WEBHOOK_URL",
    "PRISMA_CUTOVER_RELEASE_ID",
    "PRISMA_CUTOVER_SLO_MINIMUM_SAMPLES",
    "PRISMA_CUTOVER_SLO_MAX_MISMATCH_RATE",
    "PRISMA_CUTOVER_SLO_MAX_FALLBACK_RATE",
    "PRISMA_CUTOVER_SLO_MAX_ERROR_RATE",
    "PRISMA_CUTOVER_SLO_MAX_P95_MS",
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  process.env.PRISMA_CUTOVER_AUTO_ROLLBACK_ENABLED = "1";
  process.env.PRISMA_CUTOVER_ROLLBACK_WEBHOOK_URL = "https://release.example/rollback";
  process.env.PRISMA_CUTOVER_RELEASE_ID = "release-aggregate";
  process.env.PRISMA_CUTOVER_SLO_MINIMUM_SAMPLES = "10";
  process.env.PRISMA_CUTOVER_SLO_MAX_MISMATCH_RATE = "0.1";
  process.env.PRISMA_CUTOVER_SLO_MAX_FALLBACK_RATE = "1";
  process.env.PRISMA_CUTOVER_SLO_MAX_ERROR_RATE = "1";
  process.env.PRISMA_CUTOVER_SLO_MAX_P95_MS = "1000";
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ publicationId: "publication-aggregate", status: "queued" }), { status: 202 });
  };
  try {
    const result = await publishPrismaCutoverRollbacksFromEnv({ workspaceId, checkedAt, windowSeconds: 900 });
    assert.equal(result.status, "published");
    assert.equal(result.published, 1);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    db.prepare("DELETE FROM audit_log WHERE workspace_id = ?").run(workspaceId);
  }
});
