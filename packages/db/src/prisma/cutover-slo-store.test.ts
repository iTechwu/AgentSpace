import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { getDatabase, resetDatabaseForTests } from "../database.ts";
import { createWorkspaceSync } from "../workspaces.ts";
import { PrismaCutoverSloWindow } from "./cutover-slo.ts";
import { flushPrismaCutoverSloSnapshotsSync } from "./cutover-observability.ts";

let testWorkspaceId = "";
import {
  aggregatePrismaCutoverSloSnapshots,
  archivePrismaCutoverSloSnapshotsToFileSync,
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

test("SLO retention archives before pruning expired ledger rows", () => {
  const oldSnapshot = {
    domain: "retention-domain",
    sampleCount: 1,
    mismatchRate: 0,
    fallbackRate: 0,
    errorRate: 0,
    p95DurationMs: 1,
    deadlockRate: 0,
    p2034Rate: 0,
    burnRate: 0,
    rollbackRecommended: false,
    rollbackReasons: [] as const,
  };
  persistPrismaCutoverSloSnapshotsSync({
    workspaceId: testWorkspaceId,
    instanceId: "retention-instance",
    now: "2026-08-15T00:00:00.000Z",
    snapshots: [oldSnapshot],
  });
  const archiveDir = mkdtempSync(join(tmpdir(), "dofe-slo-archive-"));
  try {
    const result = archivePrismaCutoverSloSnapshotsToFileSync({
      archiveDir,
      workspaceId: testWorkspaceId,
      retentionDays: 1,
      now: "2026-08-17T00:00:00.000Z",
    });
    assert.equal(result.status, "archived");
    assert.equal(result.selected, 1);
    assert.equal(result.deleted, 1);
    assert.ok(result.archiveFile && existsSync(result.archiveFile));
    assert.match(readFileSync(result.archiveFile!, "utf8"), /retention-domain/);
    assert.equal(
      getDatabase().prepare(
        "SELECT COUNT(*) AS count FROM audit_log WHERE code = ? AND data_json ->> 'instanceId' = ? AND data_json ->> 'domain' = ?",
      ).get(PRISMA_CUTOVER_SLO_SNAPSHOT_CODE, "retention-instance", "retention-domain")?.count,
      0,
    );
  } finally {
    rmSync(archiveDir, { recursive: true, force: true });
  }
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

test("scheduled flush resets per domain so partial failure never double-writes", () => {
  // 多域 flush 部分失败：已落账域样本立即清空（下次不会带新 windowEnd 重复写入
  // 与重复计数），失败域样本保留在窗口内等待下一周期重写。
  const window = new PrismaCutoverSloWindow(10);
  window.record({ domain: "domain-a" }, { source: "primary", mismatch: 0, durationMs: 10 });
  window.record({ domain: "domain-b" }, { source: "primary", mismatch: 0, durationMs: 10 });
  const thresholds = {
    minimumSamples: 1,
    maximumMismatchRate: 1,
    maximumFallbackRate: 1,
    maximumErrorRate: 1,
    maximumP95DurationMs: 1000,
  };
  const persistedDomains: string[] = [];
  assert.throws(() => flushPrismaCutoverSloSnapshotsSync({
    sloWindow: window,
    instanceId: "instance-partial",
    workspaceId: testWorkspaceId,
    now: "2026-08-17T00:02:00.000Z",
    thresholds,
    persist: (input) => {
      const domain = input.snapshots[0]?.domain ?? "";
      persistedDomains.push(domain);
      if (domain === "domain-b") throw new Error("ledger write failed");
      return persistPrismaCutoverSloSnapshotsSync(input);
    },
  }), /ledger write failed/);
  assert.deepEqual(persistedDomains, ["domain-a", "domain-b"]);
  // domain-a 已落账并被清空；窗口里只剩 domain-b。
  assert.deepEqual(window.snapshots({ thresholds }).map((snapshot) => snapshot.domain), ["domain-b"]);
  // 重试成功后窗口清空。
  const persisted = flushPrismaCutoverSloSnapshotsSync({
    sloWindow: window,
    instanceId: "instance-partial",
    workspaceId: testWorkspaceId,
    now: "2026-08-17T00:03:00.000Z",
    thresholds,
  });
  assert.deepEqual(persisted.map((row) => row.domain), ["domain-b"]);
  assert.deepEqual(window.snapshots({ thresholds }), []);
});

test("central snapshot listing supports a bounded persistence window", () => {
  persistPrismaCutoverSloSnapshotsSync({
    workspaceId: testWorkspaceId,
    instanceId: "old-instance",
    now: "2026-08-16T23:00:00.000Z",
    snapshots: [{
      domain: "old-domain",
      sampleCount: 1,
      mismatchRate: 0,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 1,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 0,
      rollbackRecommended: false,
      rollbackReasons: [],
    }],
  });
  const recent = listPersistedPrismaCutoverSloSnapshotsSync({
    workspaceId: testWorkspaceId,
    createdFrom: "2026-08-17T00:00:00.000Z",
    createdTo: "2026-08-17T01:00:00.000Z",
  });
  assert.equal(recent.some((snapshot) => snapshot.domain === "old-domain"), false);
});
