import assert from "node:assert/strict";
import test from "node:test";
import { createPrismaCutoverRollbackHttpPublisher, readPrismaCutoverRollbackHttpConfigFromEnv } from "./prisma-cutover-rollback-publisher.ts";

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
