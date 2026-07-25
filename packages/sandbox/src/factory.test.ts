import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { connectSandbox } from "./factory.ts";
import { CubeSandbox } from "./cube/cube-sandbox.ts";
import {
  CUBE_EXPERIMENTAL_ENABLE_ENV,
  LEGACY_CUBE_API_KEY_ENV,
  LEGACY_CUBE_API_URL_ENV,
  LEGACY_CUBE_TEMPLATE_ID_ENV,
  LEGACY_SANDBOX_PROVIDER_ENV,
} from "./cube/cube-config.ts";
import { LocalSandbox } from "./local/local-sandbox.ts";

test("connectSandbox defaults to the local provider", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-sandbox-local-"));

  try {
    const sandbox = await connectSandbox({
      runtimeId: "runtime-local",
      workDir,
      env: {},
    });

    assert.ok(sandbox instanceof LocalSandbox);
    assert.equal(sandbox.status, "active");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("connectSandbox provisions a Cube sandbox when the provider env is cube", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "dofe-agent-sandbox-cube-"));
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method, body });

    if (method === "POST" && url === "http://cube.test/sandboxes") {
      return new Response(JSON.stringify({
        templateID: "tpl-demo",
        sandboxID: "sbx-demo",
        clientID: "client-demo",
        envdVersion: "test",
        domain: "cube.app",
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && url === "http://cube.test/sandboxes/sbx-demo/snapshots") {
      return new Response(JSON.stringify({
        snapshotID: "snap-demo",
        names: ["runtime-cube"],
      }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "POST" && url === "http://cube.test/sandboxes/sbx-demo/pause") {
      return new Response(null, { status: 204 });
    }

    if (method === "DELETE" && url === "http://cube.test/sandboxes/sbx-demo") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;

  try {
    const sandbox = await connectSandbox({
      runtimeId: "runtime-cube",
      workDir,
      env: {
        [LEGACY_SANDBOX_PROVIDER_ENV]: "cube",
        [CUBE_EXPERIMENTAL_ENABLE_ENV]: "true",
        [LEGACY_CUBE_API_URL_ENV]: "http://cube.test",
        [LEGACY_CUBE_API_KEY_ENV]: "dummy",
        [LEGACY_CUBE_TEMPLATE_ID_ENV]: "tpl-demo",
      },
    });

    assert.ok(sandbox instanceof CubeSandbox);
    assert.equal(sandbox.status, "active");
    assert.match(requests[0]?.body ?? "", /"templateID":"tpl-demo"/);

    const snapshotId = await sandbox.snapshot();
    assert.equal(snapshotId, "snap-demo");

    await sandbox.stop();
    assert.equal(sandbox.status, "hibernated");

    await sandbox.destroy();
    assert.equal(sandbox.status, "stopped");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workDir, { recursive: true, force: true });
  }
});
