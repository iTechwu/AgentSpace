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
