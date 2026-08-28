import assert from "node:assert/strict";
import test from "node:test";
import {
  readExternalPagerConfigFromEnv,
  sendExternalPagerAlert,
  type ExternalPagerConfig,
} from "./external-pager.ts";

const sendTestExternalPagerAlert = (
  options: Omit<Parameters<typeof sendExternalPagerAlert>[0], "source">,
) => sendExternalPagerAlert({ source: "dofe-agent-data-protection", ...options });

test("readExternalPagerConfigFromEnv defaults to error severity", () => {
  const config = readExternalPagerConfigFromEnv({});
  assert.equal(config.webhookUrl, undefined);
  assert.equal(config.token, undefined);
  assert.deepEqual(Array.from(config.severityFilter), ["error"]);
});

test("readExternalPagerConfigFromEnv parses comma-separated severity filter", () => {
  const config = readExternalPagerConfigFromEnv({
    EXTERNAL_PAGER_SEVERITY_FILTER: "warning,invalid,error",
    EXTERNAL_PAGER_WEBHOOK_URL: "https://pager.example/hook",
    EXTERNAL_PAGER_TOKEN: "secret",
    EXTERNAL_PAGER_ESCALATE_AFTER: "4",
    EXTERNAL_PAGER_TIMEOUT_MS: "15000",
  });
  assert.equal(config.webhookUrl, "https://pager.example/hook");
  assert.equal(config.token, "secret");
  assert.equal(config.escalateAfter, 4);
  assert.equal(config.timeoutMs, 15_000);
  assert.deepEqual(Array.from(config.severityFilter).sort(), ["error", "warning"]);
});

test("readExternalPagerConfigFromEnv falls back to error when all severities are invalid", () => {
  const config = readExternalPagerConfigFromEnv({
    EXTERNAL_PAGER_SEVERITY_FILTER: "errors,critical",
  });
  assert.deepEqual(Array.from(config.severityFilter), ["error"]);
});

test("sendExternalPagerAlert returns false when no webhook is configured", async () => {
  const result = await sendTestExternalPagerAlert({
    alerts: [{ code: "x", severity: "error", message: "boom" }],
    checkedAt: "2026-08-03T00:00:00Z",
    config: { severityFilter: new Set(["error"]) },
    recoveryCodes: ["x"],
  });
  assert.equal(result.sent, false);
});

test("sendExternalPagerAlert skips alerts outside the severity filter", async () => {
  const result = await sendTestExternalPagerAlert({
    alerts: [{ code: "x", severity: "info", message: "fyi" }],
    checkedAt: "2026-08-03T00:00:00Z",
    config: {
      webhookUrl: "https://pager.example/hook",
      severityFilter: new Set(["error"]),
    },
    recoveryCodes: ["x"],
  });
  assert.equal(result.sent, false);
  assert.ok(result.reason?.includes("severity filter"));
});

test("an alert that drops below the severity filter emits recovery", async () => {
  const { getDatabase, upsertPagerAlertStateSync, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceId = "ws-severity-recovery";
  const alertKey = "workspace_head_age:_:workspace_head_age";
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'Severity recovery', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  upsertPagerAlertStateSync({
    workspaceId,
    alertKey,
    code: "workspace_head_age",
    employeeName: undefined,
    metric: "workspace_head_age",
    severity: "error",
    now,
  });

  let payload: { alerts: unknown[]; recovered: Array<{ code: string }> } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init?.body as string);
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendTestExternalPagerAlert({
      workspaceId,
      alerts: [{
        code: "workspace_head_age",
        severity: "warning",
        message: "head age is improving",
        metric: "workspace_head_age",
      }],
      checkedAt: now,
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
      recoveryCodes: ["workspace_head_age"],
    });
    assert.equal(result.sent, true);
    assert.equal(result.recoveredCount, 1);
    assert.equal(payload?.alerts.length, 0);
    assert.equal(payload?.recovered[0]?.code, "workspace_head_age");
    assert.equal(readPagerAlertStateByKeySync(alertKey, workspaceId)?.status, "cleared");
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  }
});

test("sendExternalPagerAlert posts deduplicated error alerts", async () => {
  let posted: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    posted = JSON.parse(init?.body as string);
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendTestExternalPagerAlert({
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
      recoveryCodes: ["a", "b"],
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
    const result = await sendTestExternalPagerAlert({
      alerts: [{ code: "a", severity: "error", message: "boom" }],
      checkedAt: "2026-08-03T00:00:00Z",
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
      recoveryCodes: ["a"],
    });
    assert.equal(result.sent, false);
    assert.ok(result.reason?.includes("500"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendExternalPagerAlert bounds a stalled webhook request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return reject(new Error("missing abort signal"));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    const result = await sendTestExternalPagerAlert({
      workspaceId: "default",
      alerts: [{ code: "pager.timeout", severity: "error", message: "stalled" }],
      checkedAt: "2026-08-03T00:00:00Z",
      config: {
        webhookUrl: "https://pager.example/hook",
        severityFilter: new Set(["error"]),
        timeoutMs: 10,
      },
      recoveryCodes: ["pager.timeout"],
    });
    assert.equal(result.sent, false);
    assert.match(result.reason ?? "", /timeout|aborted/i);
  } finally {
    globalThis.fetch = originalFetch;
    const { getDatabase } = await import("@dofe-agent/db");
    getDatabase().prepare("DELETE FROM pager_alert_state WHERE workspace_id = ? AND code = ?")
      .run("default", "pager.timeout");
  }
});

test("repeated alerts escalate after the threshold and cleared alerts page a recovery", async () => {
  const { getDatabase, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  const reopenedAt = new Date(new Date(now).getTime() + 60_000).toISOString();
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
    await sendTestExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config, recoveryCodes: ["recovery.failed", "other.ok"] });
    const second = await sendTestExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config, recoveryCodes: ["recovery.failed", "other.ok"] });
    assert.equal(second.escalatedCount, 0);
    assert.equal(payloads[1]?.alerts[0]?.escalated, false);

    // Third occurrence → escalates to critical.
    const third = await sendTestExternalPagerAlert({ workspaceId: "default", alerts: [alert], checkedAt: now, config, recoveryCodes: ["recovery.failed", "other.ok"] });
    assert.equal(third.escalatedCount, 1);
    assert.equal(payloads[2]?.alerts[0]?.severity, "critical");
    assert.match(payloads[2]?.alerts[0]?.message as string, /ESCALATED/);
    const escalatedState = readPagerAlertStateByKeySync("recovery.failed:alice:rpo", "default");
    assert.equal(escalatedState?.occurrences, 3);

    // The alert clears → the next dispatched payload carries a recovery notice.
    const recovered = await sendTestExternalPagerAlert({
      workspaceId: "default",
      alerts: [{ code: "other.ok", severity: "info", message: "ok" }],
      checkedAt: now,
      config: { ...config, severityFilter: new Set(["error", "info"]) },
      recoveryCodes: ["recovery.failed", "other.ok"],
    });
    assert.equal(recovered.recoveredCount, 1);
    const lastPayload = payloads[payloads.length - 1]!;
    assert.equal(lastPayload.recovered[0]?.code, "recovery.failed");
    assert.ok(lastPayload.recovered[0]?.clearedAt);

    // An empty cycle never loses a pending recovery: re-send the info alert again.
    const again = await sendTestExternalPagerAlert({
      workspaceId: "default",
      alerts: [{ code: "other.ok", severity: "info", message: "ok" }],
      checkedAt: now,
      config: { ...config, severityFilter: new Set(["error", "info"]) },
      recoveryCodes: ["recovery.failed", "other.ok"],
    });
    assert.equal(again.recoveredCount, 0, "recovery was consumed once on the previous dispatch");

    // A later incident starts a fresh escalation window instead of inheriting
    // the previous incident's occurrence count.
    await sendTestExternalPagerAlert({
      workspaceId: "default",
      alerts: [alert],
      checkedAt: reopenedAt,
      config,
      recoveryCodes: ["recovery.failed", "other.ok"],
    });
    assert.equal(payloads.at(-1)?.alerts[0]?.occurrences, 1);
    assert.equal(payloads.at(-1)?.alerts[0]?.escalated, false);
    const reopenedState = readPagerAlertStateByKeySync("recovery.failed:alice:rpo", "default");
    assert.equal(reopenedState?.id, escalatedState?.id, "reopening reuses the unique alert state row");
    assert.equal(reopenedState?.firstSeenAt, reopenedAt, "a reopened incident gets a fresh first-seen time");
    assert.equal(reopenedState?.clearedAt, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recovery detection never clears active states from other alert domains", async () => {
  const { getDatabase, upsertPagerAlertStateSync, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('ws-scope', 'ws-scope', 'Scope test', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-scope");

  // A foreign-domain alert (e.g. data-protection) is active in the same workspace.
  upsertPagerAlertStateSync({
    workspaceId: "ws-scope",
    alertKey: "workspace_head_age:_:workspace_head_age",
    code: "workspace_head_age",
    severity: "warning",
    now,
  });

  const payloads: Array<{ recovered: Array<{ code: string }> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body as string));
    return new Response("ok", { status: 200 });
  };
  try {
    // SLO-style caller with zero alerts forces recovery detection — it must not
    // touch the data-protection state.
    const result = await sendTestExternalPagerAlert({
      workspaceId: "ws-scope",
      alerts: [],
      checkedAt: now,
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
      recoveryCodes: ["prisma.cutover.slo.burn_rate"],
    });
    assert.equal(result.sent, false, "no in-scope recovery and no alerts → nothing dispatched");
    const foreign = readPagerAlertStateByKeySync("workspace_head_age:_:workspace_head_age", "ws-scope");
    assert.equal(foreign?.status, "active", "foreign-domain state stays active");
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-scope");
  }
});

test("failed webhook delivery keeps recovery state active and re-sends next cycle", async () => {
  const { getDatabase, upsertPagerAlertStateSync, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('ws-retry', 'ws-retry', 'Retry test', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-retry");

  upsertPagerAlertStateSync({
    workspaceId: "ws-retry",
    alertKey: "flaky.key",
    code: "flaky.alert",
    severity: "error",
    now,
  });

  const payloads: Array<{ recovered: Array<{ code: string }> }> = [];
  const originalFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body as string));
    return fail ? new Response("bad", { status: 500 }) : new Response("ok", { status: 200 });
  };
  const config = { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) };
  try {
    const failed = await sendTestExternalPagerAlert({
      workspaceId: "ws-retry",
      alerts: [],
      checkedAt: now,
      config,
      recoveryCodes: ["flaky.alert"],
    });
    assert.equal(failed.sent, false);
    assert.equal(readPagerAlertStateByKeySync("flaky.key", "ws-retry")?.status, "active", "state stays active after failed delivery");

    fail = false;
    const retried = await sendTestExternalPagerAlert({
      workspaceId: "ws-retry",
      alerts: [],
      checkedAt: now,
      config,
      recoveryCodes: ["flaky.alert"],
    });
    assert.equal(retried.sent, true);
    assert.equal(retried.recoveredCount, 1, "recovery is re-sent on the next cycle");
    assert.equal(payloads[1]?.recovered[0]?.code, "flaky.alert");
    assert.equal(readPagerAlertStateByKeySync("flaky.key", "ws-retry")?.status, "cleared", "state cleared after successful delivery");
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-retry");
  }
});

test("stale recovery delivery cannot clear a newer alert occurrence", async () => {
  const { getDatabase, upsertPagerAlertStateSync, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceId = "ws-recovery-race";
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'Recovery race', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  upsertPagerAlertStateSync({
    workspaceId,
    alertKey: "race.key",
    code: "race.alert",
    severity: "error",
    now,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // A newer evaluation completes while the recovery webhook is in flight.
    upsertPagerAlertStateSync({
      workspaceId,
      alertKey: "race.key",
      code: "race.alert",
      severity: "error",
      now: new Date(new Date(now).getTime() + 1_000).toISOString(),
    });
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendTestExternalPagerAlert({
      workspaceId,
      alerts: [],
      checkedAt: now,
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
      recoveryCodes: ["race.alert"],
    });
    assert.equal(result.recoveredCount, 1);
    const state = readPagerAlertStateByKeySync("race.key", workspaceId);
    assert.equal(state?.status, "active", "a stale recovery must not clear a newer occurrence");
    assert.equal(state?.occurrences, 2);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  }
});

test("stale recovery delivery cannot clear a refreshed alert state", async () => {
  const { getDatabase, upsertPagerAlertStateSync, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  const refreshedAt = new Date(new Date(now).getTime() + 1_000).toISOString();
  const workspaceId = "ws-recovery-refresh";
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'Recovery refresh', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  upsertPagerAlertStateSync({ workspaceId, alertKey: "refresh.key", code: "refresh.alert", severity: "error", now });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upsertPagerAlertStateSync({
      workspaceId,
      alertKey: "refresh.key",
      code: "refresh.alert",
      severity: "error",
      now: refreshedAt,
      incrementOccurrence: false,
    });
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendTestExternalPagerAlert({
      workspaceId,
      alerts: [],
      checkedAt: now,
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error"]) },
      recoveryCodes: ["refresh.alert"],
    });
    assert.equal(result.recoveredCount, 1);
    const state = readPagerAlertStateByKeySync("refresh.key", workspaceId);
    assert.equal(state?.status, "active", "a refreshed state must survive a stale recovery");
    assert.equal(state?.occurrences, 1);
    assert.equal(state?.lastSeenAt, refreshedAt);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  }
});

test("alertKey override keeps a stable dedup key when the metric payload changes", async () => {
  const { getDatabase, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES ('ws-key', 'ws-key', 'Key test', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-key");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  const config = { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["error", "warning"]) };
  try {
    for (const burnRate of [1.5, 2.5]) {
      await sendTestExternalPagerAlert({
        workspaceId: "ws-key",
        alerts: [{
          code: "prisma.cutover.slo.burn_rate",
          severity: "warning",
          message: "burn",
          alertKey: "prisma-cutover-slo:orders",
          metric: JSON.stringify({ domain: "orders", burnRate }),
          value: burnRate,
        }],
        checkedAt: now,
        config,
        recoveryCodes: ["prisma.cutover.slo.burn_rate"],
      });
    }
    const state = readPagerAlertStateByKeySync("prisma-cutover-slo:orders", "ws-key");
    assert.equal(state?.occurrences, 2, "same alertKey accumulates occurrences despite changing metric JSON");
    assert.equal(
      state?.metric,
      JSON.stringify({ domain: "orders", burnRate: 2.5 }),
      "recovery metadata tracks the most recent occurrence",
    );
    const { listActivePagerAlertStatesSync } = await import("@dofe-agent/db");
    assert.equal(
      listActivePagerAlertStatesSync("ws-key").length,
      1,
      "no derived-key state was created alongside the stable key",
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run("ws-key");
  }
});

test("stable alertKey deduplicates metric updates within one dispatch", async () => {
  const { getDatabase, readPagerAlertStateByKeySync } = await import("@dofe-agent/db");
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceId = "ws-batch-key";
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, 'Batch key', '', ?, ?) ON CONFLICT (id) DO NOTHING`,
  ).run(workspaceId, workspaceId, now, now);
  db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  const payloads: Array<{ alerts: unknown[] }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init?.body as string));
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await sendTestExternalPagerAlert({
      workspaceId,
      alerts: [
        {
          code: "prisma.cutover.slo.burn_rate",
          severity: "warning",
          message: "first",
          alertKey: "prisma-cutover-slo:orders",
          metric: JSON.stringify({ domain: "orders", burnRate: 1.5 }),
          value: 1.5,
        },
        {
          code: "prisma.cutover.slo.burn_rate",
          severity: "warning",
          message: "latest",
          alertKey: "prisma-cutover-slo:orders",
          metric: JSON.stringify({ domain: "orders", burnRate: 2.5 }),
          value: 2.5,
        },
      ],
      checkedAt: now,
      config: { webhookUrl: "https://pager.example/hook", severityFilter: new Set(["warning"]) },
      recoveryCodes: ["prisma.cutover.slo.burn_rate"],
    });
    assert.equal(result.sent, true);
    assert.equal(payloads[0]?.alerts.length, 1);
    assert.equal(payloads[0]?.alerts[0]?.message, "latest");
    assert.equal(readPagerAlertStateByKeySync("prisma-cutover-slo:orders", workspaceId)?.metric, JSON.stringify({ domain: "orders", burnRate: 2.5 }));
    assert.equal(readPagerAlertStateByKeySync("prisma-cutover-slo:orders", workspaceId)?.occurrences, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.prepare("DELETE FROM pager_alert_state WHERE workspace_id = ?").run(workspaceId);
  }
});
