import assert from "node:assert/strict";
import test from "node:test";
import {
  readExternalPagerConfigFromEnv,
  sendExternalPagerAlert,
  type ExternalPagerConfig,
} from "./external-pager.ts";

test("readExternalPagerConfigFromEnv defaults to error severity", () => {
  const config = readExternalPagerConfigFromEnv({});
  assert.equal(config.webhookUrl, undefined);
  assert.equal(config.token, undefined);
  assert.deepEqual(Array.from(config.severityFilter), ["error"]);
});

test("readExternalPagerConfigFromEnv parses comma-separated severity filter", () => {
  const config = readExternalPagerConfigFromEnv({
    EXTERNAL_PAGER_SEVERITY_FILTER: "warning,error",
    EXTERNAL_PAGER_WEBHOOK_URL: "https://pager.example/hook",
    EXTERNAL_PAGER_TOKEN: "secret",
  });
  assert.equal(config.webhookUrl, "https://pager.example/hook");
  assert.equal(config.token, "secret");
  assert.deepEqual(Array.from(config.severityFilter).sort(), ["error", "warning"]);
});

test("sendExternalPagerAlert returns false when no webhook is configured", async () => {
  const result = await sendExternalPagerAlert({
    alerts: [{ code: "x", severity: "error", message: "boom" }],
    checkedAt: "2026-08-03T00:00:00Z",
    config: { severityFilter: new Set(["error"]) },
  });
  assert.equal(result.sent, false);
});

test("sendExternalPagerAlert skips alerts outside the severity filter", async () => {
  const result = await sendExternalPagerAlert({
    alerts: [{ code: "x", severity: "info", message: "fyi" }],
    checkedAt: "2026-08-03T00:00:00Z",
    config: {
      webhookUrl: "https://pager.example/hook",
      severityFilter: new Set(["error"]),
    },
  });
  assert.equal(result.sent, false);
  assert.ok(result.reason?.includes("severity filter"));
});

test("sendExternalPagerAlert posts deduplicated error alerts", async () => {
  let posted: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    posted = JSON.parse(init?.body as string);
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendExternalPagerAlert({
      workspaceId: "ws-1",
      alerts: [
        { code: "a", severity: "error", message: "first", employeeName: "bob", metric: "m", value: 1 },
        { code: "a", severity: "error", message: "dup", employeeName: "bob", metric: "m", value: 1 },
        { code: "b", severity: "warning", message: "warn" },
      ],
      checkedAt: "2026-08-03T00:00:00Z",
      config: {
        webhookUrl: "https://pager.example/hook",
        token: "tok",
        severityFilter: new Set(["error", "warning"]),
      },
    });
    assert.equal(result.sent, true);
    const payload = posted as { source: string; workspaceId: string; alerts: unknown[] };
    assert.equal(payload.source, "dofe-agent-data-protection");
    assert.equal(payload.workspaceId, "ws-1");
    assert.equal(payload.alerts.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendExternalPagerAlert surfaces HTTP errors as reason", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad", { status: 500, statusText: "Internal Server Error" });
  try {
    const result = await sendExternalPagerAlert({
      alerts: [{ code: "a", severity: "error", message: "boom" }],
      checkedAt: "2026-08-03T00:00:00Z",
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
    });
    assert.equal(result.sent, false);
    assert.ok(result.reason?.includes("500"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repeated alerts escalate after the threshold and cleared alerts page a recovery", async () => {
  const { getDatabase } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('default', 'default', 'Dofe Agent', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
  db.exec("DELETE FROM pager_alert_state");

  let payloads: Array<{ alerts: unknown[]; recovered: unknown[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body as string));
    return new Response("ok", { status: 200 });
  };
  const alert = { code: "recovery.failed", severity: "error" as const, message: "backup failed", employeeName: "alice", metric: "rpo" };

  try {
    const config: ExternalPagerConfig = {
      webhookUrl: "https://pager.example/hook",
      severityFilter: new Set(["error"]),
      escalateAfter: 3,
    };

    // Two occurrences → no escalation yet.
    await sendExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config });
    const second = await sendExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config });
    assert.equal(second.escalatedCount, 0);
    assert.equal(payloads[1]?.alerts[0]?.escalated, false);

    // Third occurrence → escalates to critical.
    const third = await sendExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config });
    assert.equal(third.escalatedCount, 1);
    assert.equal(payloads[2]?.alerts[0]?.severity, "critical");
    assert.match(payloads[2]?.alerts[0]?.message as string, /ESCALATED/);

    // The alert clears → the next dispatched payload carries a recovery notice.
    const recovered = await sendExternalPagerAlert({
      workspaceId: "default",
      alerts: [{ code: "other.ok", severity: "info", message: "ok" }],
      checkedAt: now,
      config: { ...config, severityFilter: new Set(["error", "info"]) },
    });
    assert.equal(recovered.recoveredCount, 1);
    const lastPayload = payloads[payloads.length - 1]!;
    assert.equal(lastPayload.recovered[0]?.code, "recovery.failed");
    assert.ok(lastPayload.recovered[0]?.clearedAt);

    // An empty cycle never loses a pending recovery: re-send the info alert again.
    const again = await sendExternalPagerAlert({
      workspaceId: "default",
      alerts: [{ code: "other.ok", severity: "info", message: "ok" }],
      checkedAt: now,
      config: { ...config, severityFilter: new Set(["error", "info"]) },
    });
    assert.equal(again.recoveredCount, 0, "recovery was consumed once on the previous dispatch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
