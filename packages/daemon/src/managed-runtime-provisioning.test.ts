import assert from "node:assert/strict";
import test from "node:test";
import { createManagedProvisioningExecutor, probeManagedGateway } from "./managed-runtime-provisioning.ts";

test("managed gateway health probe authenticates against the protocol-neutral model directory", async () => {
  let observedUrl = "";
  let observedHeaders: Record<string, string> | undefined;

  await probeManagedGateway(
    {
      accountId: "runtime-1",
      profileDir: "/tmp/profile",
      environment: {
        OPENAI_API_KEY: "runtime-secret",
        OPENAI_BASE_URL: "https://models.example/v1",
      },
    },
    "codex",
    async (url, init) => {
      observedUrl = url;
      observedHeaders = init.headers;
      return { ok: true, status: 200 };
    },
  );

  assert.equal(observedUrl, "https://models.example/v1/models");
  assert.equal(observedHeaders?.authorization, "Bearer runtime-secret");
});

test("managed gateway health probe rejects an unauthenticated gateway response", async () => {
  await assert.rejects(
    probeManagedGateway(
      {
        accountId: "runtime-1",
        profileDir: "/tmp/profile",
        environment: {
          ANTHROPIC_API_KEY: "runtime-secret",
          ANTHROPIC_BASE_URL: "https://models.example/anthropic",
        },
      },
      "claude",
      async () => ({ ok: false, status: 401 }),
    ),
    /managed_runtime\.gateway_health_http_401/,
  );
});

test("failed managed cleanup preserves the credential profile for retry", async () => {
  let cleanupCalls = 0;
  const executor = createManagedProvisioningExecutor("/tmp/managed-runtime-test", {
    async resolve() {
      return null;
    },
    getExecutablePath() {
      return "/tmp/run-provider";
    },
    cleanup() {
      cleanupCalls += 1;
    },
  });

  const result = await executor.executeCleanup("runtime-1", [
    { executable: "sh", args: ["-c", "exit 1"] },
  ]);

  assert.equal(result.success, false);
  assert.equal(cleanupCalls, 0);
});
