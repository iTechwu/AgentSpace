import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManagedContainerHealthCheckCommand,
  buildManagedAttributionProxyHealthCheckCommand,
  buildManagedProviderLauncherHealthCheckCommand,
  createManagedProvisioningExecutor,
  probeManagedGateway,
} from "./managed-runtime-provisioning.ts";

process.env.MANAGED_RUNTIME_DOCKER_NETWORK = "dofe-models-egress";

test("managed health check runs from the provider container with a read-only credential mount", () => {
  const command = buildManagedContainerHealthCheckCommand({
    accountId: "runtime-1",
    profileDir: "/srv/managed/runtime-1/current",
    environment: {
      OPENAI_API_KEY: "must-not-appear",
      OPENAI_BASE_URL: "https://model.example/v1",
    },
  }, "codex");

  assert.equal(command.executable, "docker");
  assert.ok(command.args.includes("dofe/agent-runtime-codex:latest"));
  assert.ok(command.args.includes("dofe-models-egress"));
  assert.ok(command.args.includes("type=bind,src=/srv/managed/runtime-1/current,dst=/dofe-profile,readonly"));
  assert.ok(command.args.includes("https://model.example/v1/models"));
  assert.equal(command.args.join(" ").includes("must-not-appear"), false);
});

test("managed readiness starts the generated launcher, attribution proxy, and provider CLI", () => {
  const command = buildManagedProviderLauncherHealthCheckCommand({
    accountId: "runtime-1",
    profileDir: "/srv/managed/runtime-1/current",
    environment: {
      OPENAI_API_KEY: "must-not-appear-in-args",
      OPENAI_BASE_URL: "https://model.example/v1",
    },
  }, "/srv/managed/runtime-1/run-codex");

  assert.equal(command.executable, "sh");
  assert.deepEqual(command.args, ["/srv/managed/runtime-1/run-codex", "--version"]);
  assert.equal(command.args.join(" ").includes("must-not-appear-in-args"), false);
  assert.equal(command.env?.OPENAI_BASE_URL, "https://model.example/v1");
  assert.equal(command.env?.OPENAI_API_KEY, undefined);
});

test("managed readiness probes the gateway through the attribution proxy", () => {
  const command = buildManagedAttributionProxyHealthCheckCommand({
    accountId: "runtime-1",
    profileDir: "/srv/managed/runtime-1/current",
    environment: { OPENAI_BASE_URL: "https://model.example/v1" },
  }, "/srv/managed/runtime-1/run-codex", {
    runtimeId: "runtime-1",
    runtimeCredentialId: "credential-1",
    provider: "codex",
  });

  assert.equal(command.env?.DOFE_AGENT_MANAGED_PROXY_HEALTHCHECK, "1");
  assert.equal(command.env?.DOFE_AGENT_RUNTIME_CREDENTIAL_ID, "credential-1");
  assert.equal(command.env?.DOFE_AGENT_GATEWAY_HEALTHCHECK_PATH, "/models");
});

test("managed gateway health probe preserves the configured protocol path", async () => {
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

test("managed gateway health probe uses provider-specific model endpoints", async () => {
  const observed: Array<{ provider: string; url: string; headers: Record<string, string> }> = [];
  const cases = [
    {
      provider: "claude" as const,
      environment: {
        ANTHROPIC_API_KEY: "claude-secret",
        ANTHROPIC_BASE_URL: "https://models.example/anthropic",
      },
      expectedUrl: "https://models.example/anthropic/v1/models",
    },
    {
      provider: "gemini" as const,
      environment: {
        GEMINI_API_KEY: "gemini-secret",
        GEMINI_BASE_URL: "https://models.example/gemini",
      },
      expectedUrl: "https://models.example/gemini/v1beta/models",
    },
  ];

  for (const item of cases) {
    await probeManagedGateway(
      { accountId: item.provider, profileDir: "/tmp/profile", environment: item.environment as unknown as Record<string, string> },
      item.provider,
      async (url, init) => {
        observed.push({ provider: item.provider, url, headers: init.headers });
        return { ok: true, status: 200 };
      },
    );
  }

  assert.equal(observed[0]?.url, cases[0].expectedUrl);
  assert.equal(observed[0]?.headers["x-api-key"], "claude-secret");
  assert.equal(observed[1]?.url, cases[1].expectedUrl);
  assert.equal(observed[1]?.headers["x-goog-api-key"], "gemini-secret");
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
