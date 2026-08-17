import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import { createWorkspaceSync } from "../workspaces.ts";
import { PrismaCutoverSloWindow } from "./cutover-slo.ts";
import { flushPrismaCutoverSloSnapshotsSync } from "./cutover-observability.ts";

let testWorkspaceId = "";
import {
  aggregatePrismaCutoverSloSnapshots,
  listPersistedPrismaCutoverSloSnapshotsSync,
  persistPrismaCutoverSloSnapshotsSync,
  PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
} from "./cutover-slo-store.ts";

before(() => {
  getDatabase();
});

after(() => {
  resetDatabaseForTests();
});

test("SLO snapshot persists centrally with retry-safe idempotency and pager state", () => {
  const db = getDatabase();
  const workspaceId = (db.prepare("SELECT id FROM workspace ORDER BY id LIMIT 1").get() as { id: string } | undefined)?.id
    ?? createWorkspaceSync({ id: "slo-store-test", slug: "slo-store-test", name: "SLO store test", createdBy: "test" }).id;
  testWorkspaceId = workspaceId;
  db.prepare("DELETE FROM audit_log WHERE code = ? AND workspace_id = ?").run(PRISMA_CUTOVER_SLO_SNAPSHOT_CODE, workspaceId);
  db.prepare("DELETE FROM pager_alert_state WHERE alert_key = ? AND workspace_id = ?").run("prisma-cutover-slo:test-domain", workspaceId);
  const snapshot = {
    domain: "test-domain",
    sampleCount: 10,
    mismatchRate: 0.2,
    fallbackRate: 0,
    errorRate: 0,
    p95DurationMs: 10,
    deadlockRate: 0,
    p2034Rate: 0,
    burnRate: 2,
    rollbackRecommended: true,
    rollbackReasons: ["mismatch_rate"] as const,
    flagVersion: "flags-v2",
    lastKnownGoodFlagVersion: "flags-v1",
  };
  persistPrismaCutoverSloSnapshotsSync({
    instanceId: "instance-a",
    workspaceId: testWorkspaceId,
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [snapshot],
  });
  persistPrismaCutoverSloSnapshotsSync({
    instanceId: "instance-a",
    workspaceId: testWorkspaceId,
    now: "2026-08-17T00:00:00.000Z",
    snapshots: [snapshot],
  });
  const rows = listPersistedPrismaCutoverSloSnapshotsSync({ workspaceId, limit: 10 }).filter((row) => row.domain === "test-domain");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.instanceId, "instance-a");
  assert.equal(rows[0]?.lastKnownGoodFlagVersion, "flags-v1");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM pager_alert_state WHERE alert_key = ? AND workspace_id = ? AND status = 'active'").get("prisma-cutover-slo:test-domain", workspaceId)?.count,
    1,
  );
});

test("cross-instance SLO aggregation is sample-weighted", () => {
  const [snapshot] = aggregatePrismaCutoverSloSnapshots([
    {
      domain: "notifications",
      sampleCount: 1,
      mismatchRate: 1,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 10,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 2,
      rollbackRecommended: true,
      rollbackReasons: ["mismatch_rate"],
    },
    {
      domain: "notifications",
      sampleCount: 3,
      mismatchRate: 0,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 20,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 0,
      rollbackRecommended: false,
      rollbackReasons: [],
    },
  ]);
  assert.equal(snapshot?.sampleCount, 4);
  assert.equal(snapshot?.mismatchRate, 0.25);
  assert.equal(snapshot?.p95DurationMs, 20);
  assert.equal(snapshot?.rollbackRecommended, true);
});

test("scheduled flush persists and resets the bounded window by default", () => {
  const window = new PrismaCutoverSloWindow(10);
  window.record({ domain: "flush-domain" }, { source: "primary", mismatch: 0, durationMs: 12 });
  const persisted = flushPrismaCutoverSloSnapshotsSync({
    sloWindow: window,
    instanceId: "instance-flush",
    workspaceId: testWorkspaceId,
    now: "2026-08-17T00:01:00.000Z",
    thresholds: {
      minimumSamples: 1,
      maximumMismatchRate: 1,
      maximumFallbackRate: 1,
      maximumErrorRate: 1,
      maximumP95DurationMs: 1000,
    },
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.domain, "flush-domain");
  assert.deepEqual(window.snapshots({
    thresholds: {
      minimumSamples: 1,
      maximumMismatchRate: 1,
      maximumFallbackRate: 1,
      maximumErrorRate: 1,
      maximumP95DurationMs: 1000,
    },
  }), []);
});
