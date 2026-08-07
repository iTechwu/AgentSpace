import assert from "node:assert/strict";
import test from "node:test";
import { HttpDaemonClient } from "./daemon-client.ts";

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

test("HttpDaemonClient retries task completion after transient server failures", async () => {
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
      () =>
        client.completeTask("task-1", {
          outputText: "done",
        }),
      /boom/,
    );
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
