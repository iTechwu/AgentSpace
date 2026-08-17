import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  getDatabase,
  persistPrismaCutoverSloSnapshotsSync,
  PRISMA_CUTOVER_SLO_SNAPSHOT_CODE,
} from "@dofe-agent/db";
import { sendPrismaCutoverSloPagerAlert } from "./prisma-cutover-slo-pager.ts";

const workspaceId = "default";

before(() => {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, "Pager test", now, now);
  db.prepare("DELETE FROM audit_log WHERE workspace_id = ? AND code = ?").run(workspaceId, PRISMA_CUTOVER_SLO_SNAPSHOT_CODE);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ? AND alert_key = ?").run(workspaceId, "prisma-cutover-slo:pager-domain");
});

after(() => {
  getDatabase().prepare("DELETE FROM audit_log WHERE workspace_id = ? AND code = ?").run(workspaceId, PRISMA_CUTOVER_SLO_SNAPSHOT_CODE);
  getDatabase().prepare("DELETE FROM pager_alert_state WHERE workspace_id = ? AND alert_key = ?").run(workspaceId, "prisma-cutover-slo:pager-domain");
});

test("scheduled SLO pager flush sends the centrally aggregated burn-rate alert", async () => {
  persistPrismaCutoverSloSnapshotsSync({
    workspaceId,
    instanceId: "pager-instance",
    now: "2026-08-17T00:02:00.000Z",
    snapshots: [{
      domain: "pager-domain",
      sampleCount: 10,
      mismatchRate: 0.5,
      fallbackRate: 0,
      errorRate: 0,
      p95DurationMs: 10,
      deadlockRate: 0,
      p2034Rate: 0,
      burnRate: 5,
      rollbackRecommended: true,
      rollbackReasons: ["mismatch_rate"],
      flagVersion: "flags-v2",
      lastKnownGoodFlagVersion: "flags-v1",
    }],
  });
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendPrismaCutoverSloPagerAlert({
      workspaceId,
      checkedAt: "2026-08-17T00:03:00.000Z",
      thresholds: {
        minimumSamples: 1,
        maximumMismatchRate: 0.1,
        maximumFallbackRate: 1,
        maximumErrorRate: 1,
        maximumP95DurationMs: 1000,
      },
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["warning", "error"]) },
    });
    assert.equal(result.sent, true);
    assert.equal((body?.alerts as Array<Record<string, unknown>>)[0]?.code, "prisma.cutover.slo.burn_rate");
    assert.equal((body?.alerts as Array<Record<string, unknown>>)[0]?.occurrences, 1, "pager must reuse the persisted observation count");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stable per-domain key survives burn-rate changes; recovery fires once when the domain turns healthy", async () => {
  const db = getDatabase();
  db.prepare("DELETE FROM audit_log WHERE workspace_id = ? AND code = ? AND data_json ->> 'domain' = ?")
    .run(workspaceId, PRISMA_CUTOVER_SLO_SNAPSHOT_CODE, "pager-domain");
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ? AND alert_key = ?")
    .run(workspaceId, "prisma-cutover-slo:pager-domain");
  const thresholds = {
    minimumSamples: 1,
    maximumMismatchRate: 0.1,
    maximumFallbackRate: 1,
    maximumErrorRate: 1,
    maximumP95DurationMs: 1000,
  };
  const snapshot = (burnRate: number, mismatchRate: number, windowEnd: string) => ({
    domain: "pager-domain",
    sampleCount: 10,
    mismatchRate,
    fallbackRate: 0,
    errorRate: 0,
    p95DurationMs: 10,
    deadlockRate: 0,
    p2034Rate: 0,
    burnRate,
    rollbackRecommended: true,
    rollbackReasons: ["mismatch_rate" as const],
  });
  persistPrismaCutoverSloSnapshotsSync({
    workspaceId,
    instanceId: "pager-instance",
    now: "2026-08-17T01:02:00.000Z",
    snapshots: [snapshot(2, 0.2, "2026-08-17T01:02:00.000Z")],
  });
  persistPrismaCutoverSloSnapshotsSync({
    workspaceId,
    instanceId: "pager-instance",
    now: "2026-08-17T01:04:00.000Z",
    snapshots: [snapshot(5, 0.5, "2026-08-17T01:04:00.000Z")],
  });

  const payloads: Array<{ alerts: unknown[]; recovered: Array<{ code: string }> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body as string));
    return new Response("ok", { status: 200 });
  };
  const config = { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["warning", "error"]) };
  try {
    // burn rate changed between flushes (2 → 5): the same stable key must keep
    // the alert active — no spurious recovery alongside the new alert.
    const alerting = await sendPrismaCutoverSloPagerAlert({
      workspaceId,
      checkedAt: "2026-08-17T01:05:00.000Z",
      thresholds,
      config,
    });
    assert.equal(alerting.sent, true);
    assert.equal(payloads.at(-1)?.recovered.length, 0, "no recovery while the domain is still alerting");
    assert.equal(payloads.at(-1)?.alerts[0]?.occurrences, 2, "two persisted windows count as two observations");

    // A retry of the latest persisted window after pager delivery must remain
    // idempotent even though pager metadata has a richer JSON shape.
    persistPrismaCutoverSloSnapshotsSync({
      workspaceId,
      instanceId: "pager-instance",
      now: "2026-08-17T01:04:00.000Z",
      snapshots: [snapshot(5, 0.5, "2026-08-17T01:04:00.000Z")],
    });
    const state = db.prepare(
      "SELECT occurrences FROM pager_alert_state WHERE workspace_id = ? AND alert_key = ?",
    ).get(workspaceId, "prisma-cutover-slo:pager-domain") as { occurrences?: number } | undefined;
    assert.equal(state?.occurrences, 2, "replaying a paged window must not increment occurrences");

    // Window slides past both snapshots → domain healthy → exactly one recovery.
    const recovered = await sendPrismaCutoverSloPagerAlert({
      workspaceId,
      checkedAt: "2026-08-17T02:00:00.000Z",
      thresholds,
      config,
    });
    assert.equal(recovered.sent, true);
    assert.equal(recovered.recoveredCount, 1);
    assert.equal(payloads.at(-1)?.recovered[0]?.code, "prisma.cutover.slo.burn_rate");

    // Next healthy cycle: state already cleared, no duplicate recovery.
    const quiet = await sendPrismaCutoverSloPagerAlert({
      workspaceId,
      checkedAt: "2026-08-17T03:00:00.000Z",
      thresholds,
      config,
    });
    assert.equal(quiet.sent, false, "recovery already consumed; nothing left to dispatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
