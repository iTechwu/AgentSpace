import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonAuthError, DaemonResourceGoneError, HttpDaemonClient } from "./daemon-client.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));

test("HttpDaemonClient retries retryable requests after transient server failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response(JSON.stringify({ error: "temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ task: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    const result = await client.claimTask("runtime-1");
    assert.equal(result.task, null);
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient reads the lightweight task status endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      task: { id: "task-1", status: "cancelled", updatedAt: "2026-08-04T00:00:00.000Z" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test");
    const result = await client.getTaskStatus("task-1");
    assert.equal(result.task.status, "cancelled");
    assert.equal(requestedUrl, "http://localhost:1455/api/daemon/tasks/task-1/status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient reports idempotent usage while a task is running", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: unknown;
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ accepted: 1, pendingReconciliation: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test");
    const result = await client.reportTaskUsages("task/1", {
      usages: [{
        modelId: "gpt-5",
        runtimeCredentialId: "credential-1",
        gatewayRequestId: "gateway-1",
        inputTokens: 10,
        outputTokens: 2,
      }],
    });
    assert.equal(requestedUrl, "http://localhost:1455/api/daemon/tasks/task%2F1/usage");
    assert.deepEqual(requestedBody, {
      usages: [{
        modelId: "gpt-5",
        runtimeCredentialId: "credential-1",
        gatewayRequestId: "gateway-1",
        inputTokens: 10,
        outputTokens: 2,
      }],
    });
    assert.deepEqual(result, { accepted: 1, pendingReconciliation: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient reports a created OpenMontage Job through the daemon task endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: unknown;
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jobId: "om_job_1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test");
    const response = await client.reportOpenMontageJob("task/1", {
      connectionId: "connection-1",
      snapshot: { jobId: "om_job_1" },
    });
    assert.equal(response.jobId, "om_job_1");
    assert.equal(requestedUrl, "http://localhost:1455/api/daemon/tasks/task%2F1/openmontage/jobs");
    assert.deepEqual(requestedBody, {
      connectionId: "connection-1",
      snapshot: { jobId: "om_job_1" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient does not retry non-retryable task completion requests", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    await assert.rejects(
      () => client.completeTask("task-1", { outputText: "done" }),
      /boom/,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient raises DaemonAuthError on 403 without retrying", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: "Invalid daemon token." }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_bad", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    await assert.rejects(
      () => client.sendHeartbeat("daemon-1"),
      (error: unknown) => {
        assert.ok(error instanceof DaemonAuthError, "expected DaemonAuthError for 403");
        assert.equal((error as DaemonAuthError).status, 403);
        assert.match((error as Error).message, /Invalid daemon token/);
        return true;
      },
    );
    // Auth failures must not be retried — that is what prevents the 403 storm.
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient raises DaemonAuthError on 401", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Missing daemon bearer token." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    await assert.rejects(
      () => client.sendHeartbeat("daemon-1"),
      (error: unknown) => error instanceof DaemonAuthError && error.status === 401,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient raises DaemonResourceGoneError on 404", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: 'Runtime "runtime-gone" does not exist.' }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 3,
    });
    await assert.rejects(
      () => client.claimTask("runtime-gone"),
      (error: unknown) => {
        assert.ok(error instanceof DaemonResourceGoneError, "expected DaemonResourceGoneError for 404");
        assert.equal((error as DaemonResourceGoneError).status, 404);
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HttpDaemonClient claims and fails a skill installation operation", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url.endsWith("/skill-operations/claim")) {
      return new Response(
        JSON.stringify({
          operation: {
            operationId: "op-1",
            claimGeneration: 1,
            workspaceId: "ws-1",
            runtimeId: "runtime-1",
            installationId: "inst-1",
            operation: "prepare",
            artifactDigest: "sha256:abc",
            artifactName: "find-skills",
            files: [],
            components: [],
            createdAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", { retryDelayMs: 0, maxRetryAttempts: 1 });
    const claimed = await client.claimSkillInstallationOperation("runtime-1");
    assert.ok(claimed.operation);
    assert.equal(claimed.operation.operationId, "op-1");
    await client.startSkillInstallationOperation("op-1", { claimGeneration: 1 });
    await client.failSkillInstallationOperation("op-1", { claimGeneration: 1, errorCode: "test", errorMessage: "not ready" });
    assert.ok(calls.some((url) => url.includes("/skill-operations/claim")));
    assert.ok(calls.some((url) => url.includes("/skill-operations/op-1/start")));
    assert.ok(calls.some((url) => url.includes("/skill-operations/op-1/fail")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("built library surface exports HttpDaemonClient", async (t) => {
  const builtIndexPath = resolve(sourceDir, "../dist/index.js");
  const builtClientPath = resolve(sourceDir, "../dist/daemon-client.js");

  if (!existsSync(builtIndexPath) || !existsSync(builtClientPath)) {
    t.skip("Run `pnpm --filter dofe-agent-daemon run build` to verify the built daemon client surface.");
    return;
  }

  const indexModule = (await import(pathToFileURL(builtIndexPath).href)) as {
    HttpDaemonClient?: unknown;
  };
  const clientModule = (await import(pathToFileURL(builtClientPath).href)) as {
    HttpDaemonClient?: unknown;
  };

  assert.equal(typeof indexModule.HttpDaemonClient, "function");
  assert.equal(typeof clientModule.HttpDaemonClient, "function");
});

test("reportMcpToolAudits rejects a success response that does not acknowledge every event", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ recorded: 0, acceptedEventIds: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const client = new HttpDaemonClient("http://localhost:1455", "adt_test", {
      retryDelayMs: 0,
      maxRetryAttempts: 1,
    });
    await assert.rejects(
      () => client.reportMcpToolAudits("task-1", [{
        taskId: "task-1",
        connectionId: "connection-1",
        toolName: "search",
        outcome: "succeeded",
        eventId: "event-1",
      }]),
      /did not acknowledge event-1/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
