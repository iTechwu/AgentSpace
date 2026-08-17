import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { listAuditLogsSync } from "../audit-log.ts";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import { createWorkspaceSync } from "../workspaces.ts";
import { publishPrismaCutoverRollbackSync, type PrismaCutoverRollbackRequest } from "./cutover-rollback.ts";

let workspaceId = "";

before(() => {
  const db = getDatabase();
  workspaceId = (db.prepare("SELECT id FROM workspace ORDER BY id LIMIT 1").get() as { id: string } | undefined)?.id
    ?? createWorkspaceSync({ id: "cutover-rollback-test", slug: "cutover-rollback-test", name: "Cutover rollback test", createdBy: "test" }).id;
  db.prepare("DELETE FROM audit_log WHERE code = 'prisma.cutover.rollback.published' AND workspace_id = ?").run(workspaceId);
});

after(() => {
  resetDatabaseForTests();
});

test("rollback publication links reasons, release, and last-known-good flag version", () => {
  const published: PrismaCutoverRollbackRequest[] = [];
  const result = publishPrismaCutoverRollbackSync({
    workspaceId,
    releaseId: "release-42",
    snapshot: {
      domain: "notifications",
      sampleCount: 100,
      mismatchRate: 0.05,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 20,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 2,
      rollbackRecommended: true,
      rollbackReasons: ["mismatch_rate"],
      flagVersion: "flags-v2",
      lastKnownGoodFlagVersion: "flags-v1",
    },
    publisher: {
      publish: (request) => {
        published.push(request);
        return { publicationId: "publish-1", status: "queued" };
      },
    },
  });
  assert.deepEqual(result, { publicationId: "publish-1", status: "queued" });
  assert.equal(published[0]?.targetFlagVersion, "flags-v1");
  const [audit] = listAuditLogsSync(workspaceId, { code: "prisma.cutover.rollback.published" });
  assert.ok(audit?.dataJson.includes("release-42"));
  assert.ok(audit?.dataJson.includes("mismatch_rate"));
});

test("rollback publication rejects snapshots without last-known-good configuration", () => {
  assert.throws(() => publishPrismaCutoverRollbackSync({
    workspaceId,
    releaseId: "release-43",
    snapshot: {
      domain: "audit-log",
      sampleCount: 10,
      mismatchRate: 1,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 10,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 10,
      rollbackRecommended: true,
      rollbackReasons: ["mismatch_rate"],
      flagVersion: "flags-v2",
    },
    publisher: { publish: () => assert.fail("publisher must not be called") },
  }), /last-known-good/);
});
