import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildRemoteDaemonConfig,
  buildRemoteDaemonRelaunchCommand,
  buildRemoteRuntimeHeartbeatMetadata,
  buildManagedStdioLaunch,
  claimRemoteQueue,
  classifyRemoteLoopError,
  createRemoteGatewayUsageReporter,
  createRemoteRuntimeActivity,
  mergeRemoteGatewayUsages,
  reconcileRemoteRuntimesWithHeartbeat,
  restoreManagedRuntimesFromHeartbeat,
  resolveManagedProviderVerificationEnvironments,
  resolveManagedServiceConnection,
  resolveRemoteTaskExecutionSessionId,
  resolveRemoteTaskExecutionModel,
  resolveRemoteTaskProviderSessionId,
  runRemoteDaemonCommand,
  watchRemoteTaskCancellation,
} from "./remote-daemon.ts";
import type { ResolvedMcpConnection } from "@dofe-agent/domain";

test("resolveManagedServiceConnection binds only the official OpenMontage service from daemon environment", () => {
  const connection = {
    connectionId: "connection-1",
    runtimeId: "runtime-1",
    workspaceId: "workspace-1",
    transport: "managed_service",
    endpoint: "managed-service://openmontage",
    allowedHosts: [],
    approvedTools: ["submit_video_job"],
    secrets: {},
    nonSecretParams: {},
  } satisfies ResolvedMcpConnection;

  const resolved = resolveManagedServiceConnection(connection, {
    OPENMONTAGE_MCP_URL: "http://openmontage:8080/mcp",
    OPENMONTAGE_SERVICE_TOKEN: "service-token",
  });

  assert.equal(resolved.managedServiceEndpoint, "http://openmontage:8080/mcp");
  assert.deepEqual(resolved.secrets, { Authorization: "Bearer service-token" });
  assert.throws(() => resolveManagedServiceConnection(connection, {}), /OPENMONTAGE_MCP_URL/);
  assert.throws(() => resolveManagedServiceConnection(
    { ...connection, endpoint: "managed-service://other" },
    { OPENMONTAGE_MCP_URL: "http://openmontage:8080/mcp", OPENMONTAGE_SERVICE_TOKEN: "service-token" },
  ), /reference/);
});
import { DaemonAuthError, DaemonResourceGoneError, DaemonRuntimeUnavailableError } from "./daemon-client.ts";
import { isProcessRunning } from "./state.ts";

test("isProcessRunning treats an inaccessible existing process as running", () => {
  assert.equal(isProcessRunning(1), true);
});

test("watchRemoteTaskCancellation aborts after the control plane cancels a task", async () => {
  const controller = new AbortController();
  let reads = 0;
  const stop = watchRemoteTaskCancellation({
    getTaskStatus: async () => ({
      task: {
        id: "task-1",
        status: ++reads >= 2 ? "cancelled" : "running",
        updatedAt: new Date().toISOString(),
      },
    }),
  }, "task-1", controller, { pollIntervalMs: 10 });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("cancellation watcher timed out")), 500);
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
    assert.equal(controller.signal.aborted, true);
    assert.equal(reads, 2);
  } finally {
    stop();
  }
});

test("daemon status exits non-zero when no daemon is running", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-agent-daemon-status-"));
  const originalLog = console.log;
  let output = "";

  try {
    console.log = (...values: unknown[]) => {
      output += values.join(" ");
    };
    const exitCode = await runRemoteDaemonCommand("status", ["--json", "--state-dir", stateDir]);
    assert.equal(exitCode, 1);
    assert.equal((JSON.parse(output) as { running: boolean }).running, false);
  } finally {
    console.log = originalLog;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("buildRemoteDaemonConfig reads env-backed defaults without repository state", () => {
  const config = buildRemoteDaemonConfig(
    {},
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        DOFE_AGENT_SERVER_URL: "https://dofe-agent.example",
        DOFE_AGENT_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, join("/tmp/daemon-home", ".dofe-agent-daemon"));
  assert.equal(config.daemonKey, "daemon-box");
  assert.equal(config.deviceName, "daemon-box");
  assert.equal(config.runtimeName, "Remote Agent");
  assert.equal(config.serverUrl, "https://dofe-agent.example");
  assert.equal(config.daemonToken, "adt_test");
  assert.equal(config.taskTimeoutMs, 12 * 60 * 60 * 1000);
  assert.equal(config.codexMcpExperimentalEnabled, false);
});

test("buildRemoteDaemonConfig only enables Codex MCP for an explicit experiment", () => {
  const disabled = buildRemoteDaemonConfig({}, {
    environment: { HOME: "/tmp/daemon-home", MCP_CODEX_EXPERIMENTAL_ENABLED: "true" },
  });
  const enabled = buildRemoteDaemonConfig({}, {
    environment: { HOME: "/tmp/daemon-home", MCP_CODEX_EXPERIMENTAL_ENABLED: "1" },
  });

  assert.equal(disabled.codexMcpExperimentalEnabled, false);
  assert.equal(enabled.codexMcpExperimentalEnabled, true);
});

test("buildRemoteDaemonConfig prefers explicit flags over env", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://override.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
        HOSTNAME: "daemon-box",
        DOFE_AGENT_SERVER_URL: "https://dofe-agent.example",
        DOFE_AGENT_DAEMON_TOKEN: "adt_test",
      },
    },
  );

  assert.equal(config.stateDir, "/srv/daemon-state");
  assert.equal(config.daemonKey, "daemon-prod-01");
  assert.equal(config.deviceName, "gpu-box-1");
  assert.equal(config.runtimeName, "GPU Agent");
  assert.equal(config.serverUrl, "https://override.example");
  assert.equal(config.daemonToken, "adt_override");
  assert.equal(config.heartbeatIntervalMs, 20000);
  assert.equal(config.taskPollIntervalMs, 5000);
  assert.equal(config.taskTimeoutMs, 28800000);
});

test("runtime activity allows unbounded tasks while maintenance remains exclusive", async () => {
  const daemonModule = await import("./remote-daemon.ts") as unknown as Record<string, unknown>;
  assert.equal(typeof daemonModule.createRemoteRuntimeActivity, "function");
  assert.equal(typeof daemonModule.beginRemoteRuntimeTask, "function");
  assert.equal(typeof daemonModule.endRemoteRuntimeTask, "function");
  assert.equal(typeof daemonModule.reserveRemoteRuntimeExclusiveSlot, "function");
  assert.equal(typeof daemonModule.releaseRemoteRuntimeExclusiveSlot, "function");

  const createActivity = daemonModule.createRemoteRuntimeActivity as () => unknown;
  const beginTask = daemonModule.beginRemoteRuntimeTask as (activity: unknown, runtimeId: string) => boolean;
  const endTask = daemonModule.endRemoteRuntimeTask as (activity: unknown, runtimeId: string) => void;
  const reserveExclusive = daemonModule.reserveRemoteRuntimeExclusiveSlot as (activity: unknown, runtimeId: string) => boolean;
  const releaseExclusive = daemonModule.releaseRemoteRuntimeExclusiveSlot as (activity: unknown, runtimeId: string) => void;
  const activity = createActivity();

  for (let index = 0; index < 100; index += 1) {
    assert.equal(beginTask(activity, "runtime-1"), true);
  }
  assert.equal(reserveExclusive(activity, "runtime-1"), false);

  for (let index = 0; index < 100; index += 1) {
    endTask(activity, "runtime-1");
  }
  assert.equal(reserveExclusive(activity, "runtime-1"), true);
  assert.equal(beginTask(activity, "runtime-1"), false);
  releaseExclusive(activity, "runtime-1");
  assert.equal(beginTask(activity, "runtime-1"), true);
});

test("remote conversation workdirs are isolated by router session", async () => {
  const daemonModule = await import("./remote-daemon.ts") as unknown as Record<string, unknown>;
  assert.equal(typeof daemonModule.resolveRemoteTaskWorkDir, "function");
  const resolveWorkDir = daemonModule.resolveRemoteTaskWorkDir as (
    config: { stateDir: string },
    task: Record<string, unknown>,
  ) => string;
  const task = {
    id: "task-1",
    workspaceId: "workspace-1",
    agentId: "employee-1",
    runtimeId: "runtime-1",
    triggerType: "channel_chat",
    priority: 1,
    status: "claimed",
    inputJson: JSON.stringify({ channel: "shared-channel" }),
    queuedAt: "2026-08-10T00:00:00.000Z",
  };

  const first = resolveWorkDir({ stateDir: "/tmp/daemon" }, { ...task, routerSessionId: "router-user-a" });
  const second = resolveWorkDir({ stateDir: "/tmp/daemon" }, { ...task, id: "task-2", routerSessionId: "router-user-b" });
  const resumed = resolveWorkDir({ stateDir: "/tmp/daemon" }, { ...task, id: "task-3", routerSessionId: "router-user-a" });

  assert.notEqual(first, second);
  assert.equal(first, resumed);
});

test("managed stdio MCP launches the installed entrypoint inside the target Runtime image", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-managed-stdio-"));
  try {
    const launch = buildManagedStdioLaunch({
      endpoint: "stdio://internal-mcp",
      nonSecretParams: { TENANT_ID: "tenant-1" },
      secrets: { API_TOKEN: "secret-value" },
    }, { stateDir, managedNode: true }, { id: "runtime-1", provider: "codex" });

    assert.equal(launch.command, "docker");
    assert.equal(launch.args.includes("--interactive"), true);
    assert.equal(launch.args.includes("none"), true);
    assert.equal(launch.args.includes("/dofe-home/.local/bin/internal-mcp"), true);
    assert.equal(launch.args.some((value) => value.includes("/dofe-home")), true);
    assert.equal(launch.args.includes("TENANT_ID=tenant-1"), true);
    assert.equal(launch.args.includes("API_TOKEN=secret-value"), true);
    assert.equal(launch.args.at(-1), "dofe/agent-runtime-codex:latest");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("official managed stdio profiles add browser flags without accepting them from user configuration", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-managed-browser-"));
  try {
    const profile = {
      args: ["--headless", "--isolated"],
      managedArgs: ["--executable-path=/usr/bin/chromium", "--chrome-arg=--no-sandbox"],
      env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" },
    };
    const managed = buildManagedStdioLaunch({
      endpoint: "stdio://chrome-devtools-mcp",
      nonSecretParams: {},
      secrets: {},
      managedStdioProfile: profile,
    }, { stateDir, managedNode: true }, { id: "runtime-browser", provider: "codex" });
    assert.deepEqual(managed.args.slice(-5), [
      "dofe/agent-runtime-codex:latest",
      "--headless",
      "--isolated",
      "--executable-path=/usr/bin/chromium",
      "--chrome-arg=--no-sandbox",
    ]);
    assert.equal(managed.args.includes("/dev/shm:rw,nosuid,nodev,noexec,size=256m"), true);
    assert.equal(managed.args.includes("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1"), true);

    const host = buildManagedStdioLaunch({
      endpoint: "stdio://chrome-devtools-mcp",
      nonSecretParams: {},
      secrets: {},
      managedStdioProfile: profile,
    }, { stateDir, managedNode: false }, { id: "runtime-browser", provider: "codex" });
    assert.deepEqual(host.args, ["--headless", "--isolated"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("trusted managed stdio profiles can use the Runtime network only when egress enforcement is disabled", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-managed-network-"));
  try {
    const connection = {
      endpoint: "stdio://minimax-coding-plan-mcp",
      nonSecretParams: {},
      secrets: { MINIMAX_API_KEY: "secret-value" },
      managedStdioProfile: {
        args: [],
        env: { MINIMAX_API_HOST: "https://api.minimaxi.com" },
        networkAccess: "runtime" as const,
      },
    };
    const launch = buildManagedStdioLaunch(
      connection,
      { stateDir, managedNode: true },
      { id: "runtime-minimax", provider: "codex" },
    );
    assert.equal(launch.args[launch.args.indexOf("--network") + 1], "dofe-managed-egress");
    assert.equal(launch.args.includes("none"), false);

    const original = process.env.MCP_EGRESS_ENFORCE;
    process.env.MCP_EGRESS_ENFORCE = "true";
    try {
      assert.throws(
        () => buildManagedStdioLaunch(
          connection,
          { stateDir, managedNode: true },
          { id: "runtime-minimax", provider: "codex" },
        ),
        /managed_stdio_network_requires_supported_egress/,
      );
    } finally {
      if (original === undefined) delete process.env.MCP_EGRESS_ENFORCE;
      else process.env.MCP_EGRESS_ENFORCE = original;
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("managed stdio MCP rejects shell syntax and reserved environment variables", () => {
  assert.throws(() => buildManagedStdioLaunch({
    endpoint: "stdio://server/path",
    nonSecretParams: {},
    secrets: {},
  }, { stateDir: "/tmp/dofe-test", managedNode: false }, { id: "runtime-1", provider: "codex" }), /endpoint_invalid/);
  assert.throws(() => buildManagedStdioLaunch({
    endpoint: "stdio://server",
    nonSecretParams: { PATH: "/untrusted" },
    secrets: {},
  }, { stateDir: "/tmp/dofe-test", managedNode: false }, { id: "runtime-1", provider: "codex" }), /environment_invalid/);
});

test("buildRemoteDaemonConfig resolves the operation claim backpressure interval", () => {
  const defaults = buildRemoteDaemonConfig({}, {
    environment: { HOME: "/tmp/daemon-home" },
  });
  assert.equal(defaults.operationClaimIntervalMs, 15_000);

  const fromEnv = buildRemoteDaemonConfig({}, {
    environment: { HOME: "/tmp/daemon-home", DOFE_AGENT_OPERATION_CLAIM_INTERVAL: "30000" },
  });
  assert.equal(fromEnv.operationClaimIntervalMs, 30_000);

  const fromFlag = buildRemoteDaemonConfig(
    { "operation-claim-interval": "45000" },
    { environment: { HOME: "/tmp/daemon-home", DOFE_AGENT_OPERATION_CLAIM_INTERVAL: "30000" } },
  );
  assert.equal(fromFlag.operationClaimIntervalMs, 45_000);

  const floored = buildRemoteDaemonConfig(
    { "operation-claim-interval": "10" },
    { environment: { HOME: "/tmp/daemon-home" } },
  );
  assert.equal(floored.operationClaimIntervalMs, 1_000);
});

test("remote runtime activity tracks per-runtime operation claim backpressure", () => {
  const activity = createRemoteRuntimeActivity();
  assert.ok(activity.nextOperationClaimAt instanceof Map);
  activity.nextOperationClaimAt.set("runtime-1", Date.now() + 10_000);
  assert.equal(activity.nextOperationClaimAt.get("runtime-1")! > Date.now(), true);
});

test("buildRemoteDaemonRelaunchCommand reuses the installed daemon bin without strip-types", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
      "device-name": "gpu-box-1",
      "runtime-name": "GPU Agent",
      "server-url": "https://dofe-agent.example",
      "daemon-token": "adt_override",
      "heartbeat-interval": "20000",
      "poll-interval": "5000",
      "task-timeout": "28800000",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "/opt/dofe-agent/bin/dofe-agent-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.command, "/usr/bin/node");
  assert.equal(command.args[0], "/opt/dofe-agent/bin/dofe-agent-daemon.js");
  assert.equal(command.args.includes("--experimental-strip-types"), false);
  assert.deepEqual(command.args.slice(1, 8), [
    "start",
    "--foreground",
    "--state-dir",
    "/srv/daemon-state",
    "--daemon-id",
    "daemon-prod-01",
    "--device-name",
  ]);
  assert.equal(command.args.includes("--server-url"), true);
  assert.equal(command.args.includes("https://dofe-agent.example"), true);
  assert.equal(command.args.includes("--daemon-token"), true);
  assert.equal(command.args.includes("adt_override"), true);
});

test("buildRemoteDaemonRelaunchCommand resolves relative daemon bin paths before changing cwd", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "runtime/bin/dofe-agent-daemon.js"],
    execPath: "/usr/bin/node",
  });

  assert.equal(command.args[0], resolve("runtime/bin/dofe-agent-daemon.js"));
});

test("buildRemoteDaemonRelaunchCommand preserves strip-types only for source TypeScript entrypoints", () => {
  const config = buildRemoteDaemonConfig(
    {
      "state-dir": "/srv/daemon-state",
      "daemon-id": "daemon-prod-01",
    },
    {
      environment: {
        HOME: "/tmp/daemon-home",
      },
    },
  );

  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "packages/daemon/src/cli.ts"],
    execPath: "/usr/bin/node",
  });

  assert.deepEqual(command.args.slice(0, 4), [
    "--experimental-strip-types",
    resolve("packages/daemon/src/cli.ts"),
    "start",
    "--foreground",
  ]);
});

test("buildRemoteDaemonRelaunchCommand preserves managed-node mode", () => {
  const config = buildRemoteDaemonConfig({
    "state-dir": "/srv/daemon-state",
    "daemon-id": "managed-node-1",
    "managed-node": true,
  });
  const command = buildRemoteDaemonRelaunchCommand(config, {
    argv: ["node", "/opt/dofe-agent/bin/dofe-agent-daemon.js"],
    execPath: "/usr/bin/node",
  });
  assert.equal(config.managedNode, true);
  assert.equal(command.args.includes("--managed-node"), true);
});

test("resolveRemoteTaskProviderSessionId reads channel session from task payload", () => {
  assert.equal(
    resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: " session-1 " })),
    "session-1",
  );
  assert.equal(resolveRemoteTaskProviderSessionId(JSON.stringify({ channelSessionId: "" })), undefined);
  assert.equal(resolveRemoteTaskProviderSessionId("{not-json"), undefined);
});

test("router session cold rebuild overrides the legacy channel session fallback", () => {
  const legacyInput = JSON.stringify({ channelSessionId: "stale-session" });
  assert.equal(resolveRemoteTaskExecutionSessionId(undefined, legacyInput), "stale-session");
  assert.equal(resolveRemoteTaskExecutionSessionId({
    routerSessionId: "router-1",
    continuationMode: "cold_rebuild",
    selectedRuntimeId: "runtime-1",
    attemptCount: 2,
  }, legacyInput), undefined);
  assert.equal(resolveRemoteTaskExecutionSessionId({
    routerSessionId: "router-1",
    providerSessionId: " active-session ",
    continuationMode: "same_provider_resume",
    selectedRuntimeId: "runtime-1",
    attemptCount: 2,
  }, legacyInput), "active-session");
});

test("managed task execution uses the effective model from the server bundle", () => {
  assert.equal(
    resolveRemoteTaskExecutionModel({
      version: 1,
      format: "json-inline-v1",
      taskId: "task-1",
      runtimeId: "runtime-1",
      prompt: "hello",
      metadata: {
        taskTriggerType: "manual",
        effectiveModel: {
          modelId: "claude-opus",
          source: "session_override",
          runtimeCredentialId: "credential-1",
        },
      },
      files: [],
    }),
    "claude-opus",
  );
});

test("managed task usage is driven by billable gateway responses, not provider event position", () => {
  const usages = mergeRemoteGatewayUsages(
    [
      { modelId: "gpt-5", runtimeCredentialId: "credential-1", inputTokens: 30, outputTokens: 6 },
      { modelId: "gpt-5", runtimeCredentialId: "credential-1", gatewayRequestId: "gateway-explicit", inputTokens: 5, outputTokens: 1 },
    ],
    [
      { requestId: "gateway-1", inputTokens: 10, outputTokens: 2 },
      { requestId: "gateway-2", inputTokens: 20, outputTokens: 4 },
    ],
    {
      modelId: "gpt-5",
      runtimeCredentialId: "credential-1",
      routerSessionId: "session-1",
    },
  );

  assert.deepEqual(usages.map((usage) => [usage.gatewayRequestId, usage.inputTokens, usage.outputTokens]), [
    ["gateway-explicit", 5, 1],
    ["gateway-1", 10, 2],
    ["gateway-2", 20, 4],
  ]);
});

test("incremental gateway usage reporter retries failed delivery and acknowledges each request once", async () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-agent-usage-reporter-"));
  const usagePath = join(root, "usage.jsonl");
  writeFileSync(usagePath, `${JSON.stringify({ requestId: "gateway-1", inputTokens: 10, outputTokens: 2 })}\n`);
  let attempts = 0;
  const batches: string[][] = [];
  const reporter = createRemoteGatewayUsageReporter({
    path: usagePath,
    pollIntervalMs: 0,
    context: {
      modelId: "gpt-5",
      runtimeCredentialId: "credential-1",
      routerSessionId: "session-1",
    },
    report: async (usages) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      batches.push(usages.map((usage) => usage.gatewayRequestId!));
    },
  });

  try {
    await assert.rejects(() => reporter.flush(), /temporary network failure/);
    await reporter.flush();
    appendFileSync(usagePath, `${JSON.stringify({ requestId: "gateway-2", inputTokens: 20, outputTokens: 4 })}\n`);
    await reporter.flush();
    await reporter.flush();
    assert.equal(attempts, 3);
    assert.deepEqual(batches, [["gateway-1"], ["gateway-2"]]);
  } finally {
    await reporter.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifyRemoteLoopError routes auth failures to shutdown and 404 to skip-runtime", () => {
  // Fatal auth errors (invalid/revoked token) must stop the daemon — never loop.
  assert.equal(classifyRemoteLoopError(new DaemonAuthError("Invalid daemon token.", 403)), "shutdown");
  assert.equal(classifyRemoteLoopError(new DaemonAuthError("Missing bearer token.", 401)), "shutdown");
  // A deleted runtime is per-resource: drop it and keep polling the rest.
  assert.equal(
    classifyRemoteLoopError(new DaemonResourceGoneError('Runtime "x" does not exist.', 404)),
    "skip-runtime",
  );
  assert.equal(
    classifyRemoteLoopError(new DaemonRuntimeUnavailableError("Remote mode requires a managed, online runtime.", 409)),
    "skip-runtime",
  );
  // Transient / unknown errors stay on the existing "log and retry next tick" path.
  assert.equal(classifyRemoteLoopError(new Error("connect ECONNREFUSED 127.0.0.1:5432")), "log");
  assert.equal(classifyRemoteLoopError(new Error("temporary failure")), "log");
  assert.equal(classifyRemoteLoopError("string error"), "log");
});

test("claimRemoteQueue contains one subqueue failure so later work can still be claimed", async () => {
  const originalWarn = console.warn;
  const calls: string[] = [];
  console.warn = () => {};

  try {
    const unavailable = await claimRemoteQueue({
      runtimeId: "runtime-1",
      queue: "skill service operation",
      now: 30_000,
      claim: async () => {
        calls.push("skill-service");
        throw new Error("405 Method Not Allowed");
      },
    });
    const task = await claimRemoteQueue({
      runtimeId: "runtime-1",
      queue: "task",
      now: 30_000,
      claim: async () => {
        calls.push("task");
        return { task: { id: "task-1" } };
      },
    });

    assert.equal(unavailable, undefined);
    assert.equal(task?.task.id, "task-1");
    assert.deepEqual(calls, ["skill-service", "task"]);
  } finally {
    console.warn = originalWarn;
  }
});

test("claimRemoteQueue keeps auth and runtime eligibility failures fail-fast", async () => {
  await assert.rejects(
    () => claimRemoteQueue({
      runtimeId: "runtime-1",
      queue: "task",
      claim: async () => { throw new DaemonAuthError("Invalid daemon token.", 403); },
    }),
    DaemonAuthError,
  );
  await assert.rejects(
    () => claimRemoteQueue({
      runtimeId: "runtime-1",
      queue: "task",
      claim: async () => { throw new DaemonRuntimeUnavailableError("Runtime is offline.", 409); },
    }),
    DaemonRuntimeUnavailableError,
  );
});

test("reconcileRemoteRuntimesWithHeartbeat adds managed runtimes from heartbeat", () => {
  const existing = [{
    id: "runtime-local-1",
    workspaceId: "ws-1",
    provider: "codex" as const,
    name: "Local Codex",
    version: "1.0.0",
    status: "online" as const,
    deviceInfo: "gpu-box",
    metadata: {
      executablePath: "/usr/bin/codex",
      mode: "remote" as const,
    },
  }];

  const heartbeat = {
    daemon: {
      daemonKey: "daemon-1",
      status: "online" as const,
      workspaceId: "ws-1",
    },
    runtimes: [
      {
        id: "runtime-local-1",
        provider: "codex" as const,
        status: "online" as const,
        metadata: { executablePath: "/usr/bin/codex" },
      },
      {
        id: "runtime-managed-1",
        provider: "claude" as const,
        status: "online" as const,
        metadata: {
          managedCredentialId: "cred-managed-1",
          provisioningState: "managed",
        },
      },
    ],
    managedRuntimeCleanupRequests: [],
  };

  const result = reconcileRemoteRuntimesWithHeartbeat(existing, heartbeat, "ws-1", "managed-node");

  assert.equal(result.length, 2);
  const managed = result.find((runtime) => runtime.id === "runtime-managed-1");
  assert.ok(managed);
  assert.equal(managed?.provider, "claude");
  assert.equal(managed?.workspaceId, "ws-1");
  assert.equal(managed?.metadata.managedCredentialId, "cred-managed-1");
  assert.equal(managed?.metadata.provisioningState, "managed");
  assert.equal(managed?.metadata.mode, "remote");
});

test("heartbeat publishes newly healthy managed runtimes for server-side scheduling", () => {
  const records = buildRemoteRuntimeHeartbeatMetadata([], new Map([
    ["runtime-managed-1", {
      id: "runtime-managed-1",
      provider: "codex",
      runtimeCredentialId: "credential-1",
      executablePath: "/var/lib/dofe/managed-runtimes/runtime-managed-1/run-provider",
      status: "online",
    }],
  ]));

  assert.deepEqual(records, [{
    id: "runtime-managed-1",
    provider: "codex",
    metadata: {
      executablePath: "/var/lib/dofe/managed-runtimes/runtime-managed-1/run-provider",
      mode: "remote",
      managedCredentialId: "credential-1",
      provisioningState: "managed",
    },
  }]);
});

test("managed runtime metadata overrides a stale empty executable path", () => {
  const records = buildRemoteRuntimeHeartbeatMetadata([{
    id: "runtime-managed-1",
    workspaceId: "ws-1",
    provider: "claude" as const,
    name: "Managed Claude",
    status: "offline" as const,
    metadata: {
      executablePath: "",
      mode: "remote" as const,
      managedCredentialId: "credential-1",
      provisioningState: "managed",
      providerVerificationRequestedAt: new Date().toISOString(),
    },
  }], new Map([[
    "runtime-managed-1",
    {
      id: "runtime-managed-1",
      provider: "claude" as const,
      runtimeCredentialId: "credential-1",
      executablePath: "/managed/runtime-managed-1/run-provider",
      status: "online" as const,
    },
  ]]));

  assert.equal(records[0]?.metadata.executablePath, "/managed/runtime-managed-1/run-provider");
});

test("heartbeat publishes CLI readiness on the target Runtime instead of only the daemon", () => {
  const readiness = {
    checkedAt: "2026-08-03T00:00:00.000Z",
    python: { available: true, version: "Python 3.12" },
    pip: { available: true, version: "pip 25" },
    cliHub: { available: true, version: "cli-hub 1" },
    npm: { available: true, version: "10" },
    uv: { available: false, error: "not installed" },
  };
  const records = buildRemoteRuntimeHeartbeatMetadata([{
    id: "runtime-1",
    workspaceId: "ws-1",
    provider: "codex",
    name: "Runtime 1",
    status: "online",
    metadata: { executablePath: "codex", mode: "remote" },
  }], undefined, undefined, new Map([["runtime-1", readiness]]));

  assert.deepEqual(records[0]?.metadata.cliHubReadiness, readiness);
});

test("managed runtime profiles are restored after a daemon restart", async () => {
  const restored = new Map();
  const resolved: Array<{ runtimeId: string; credentialId?: string }> = [];
  const heartbeat = {
    daemon: { daemonKey: "daemon-1", status: "online" as const, workspaceId: "ws-1" },
    runtimes: [{
      id: "runtime-managed-1",
      provider: "codex" as const,
      status: "online" as const,
      metadata: { managedCredentialId: "credential-1", provisioningState: "managed" },
    }],
    managedRuntimeCleanupRequests: [],
  };

  await restoreManagedRuntimesFromHeartbeat(heartbeat, restored, {
    resolve: async (runtimeId, credentialId) => {
      resolved.push({ runtimeId, credentialId });
      return { provider: "codex" } as never;
    },
    getExecutablePath: () => "/managed/runtime-managed-1/codex",
    cleanup: () => undefined,
  });

  assert.deepEqual(resolved, [{ runtimeId: "runtime-managed-1", credentialId: "credential-1" }]);
  assert.deepEqual(restored.get("runtime-managed-1"), {
    id: "runtime-managed-1",
    provider: "codex",
    runtimeCredentialId: "credential-1",
    executablePath: "/managed/runtime-managed-1/codex",
    status: "online",
  });
});

test("managed runtime profiles are restored when the control plane marked them offline", async () => {
  const restored = new Map();
  const heartbeat = {
    daemon: { daemonKey: "daemon-1", status: "online" as const, workspaceId: "ws-1" },
    runtimes: [{
      id: "runtime-managed-1",
      provider: "claude" as const,
      status: "offline" as const,
      metadata: { managedCredentialId: "credential-1", provisioningState: "managed" },
    }],
    managedRuntimeCleanupRequests: [],
  };

  await restoreManagedRuntimesFromHeartbeat(heartbeat, restored, {
    resolve: async () => ({ provider: "claude" }) as never,
    getExecutablePath: () => "/managed/runtime-managed-1/claude",
    cleanup: () => undefined,
  });

  assert.equal(restored.get("runtime-managed-1")?.status, "online");
});

test("heartbeat stops publishing a managed runtime after successful cleanup", () => {
  const managedRuntimes = new Map([[
    "runtime-managed-1",
    {
      id: "runtime-managed-1",
      provider: "codex" as const,
      runtimeCredentialId: "credential-1",
      executablePath: "/var/lib/dofe/managed-runtimes/runtime-managed-1/run-provider",
      status: "online" as const,
    },
  ]]);

  managedRuntimes.delete("runtime-managed-1");

  assert.deepEqual(buildRemoteRuntimeHeartbeatMetadata([], managedRuntimes), []);
});

test("managed provider verification resolves its credential environment without publishing it", async () => {
  const runtimes = [{
    id: "runtime-managed-1",
    workspaceId: "ws-1",
    provider: "claude" as const,
    name: "Managed Claude",
    status: "online" as const,
    metadata: {
      executablePath: "/var/lib/dofe/managed-runtimes/runtime-managed-1/run-provider",
      mode: "remote" as const,
      managedCredentialId: "credential-1",
      providerVerificationRequestedAt: new Date().toISOString(),
    },
  }];
  const environments = await resolveManagedProviderVerificationEnvironments(runtimes, {
    resolve: async (runtimeId, credentialId) => {
      assert.equal(runtimeId, "runtime-managed-1");
      assert.equal(credentialId, "credential-1");
      return {
        accountId: runtimeId,
        profileDir: "/var/lib/dofe/managed-runtimes/runtime-managed-1",
        environment: { ANTHROPIC_BASE_URL: "http://gateway.internal/v1" },
      };
    },
  });

  assert.deepEqual(environments, new Map([
    ["runtime-managed-1", { ANTHROPIC_BASE_URL: "http://gateway.internal/v1" }],
  ]));
  const records = buildRemoteRuntimeHeartbeatMetadata(runtimes, undefined, environments);
  assert.equal("ANTHROPIC_BASE_URL" in records[0]!.metadata, false);
});

test("managed OpenClaw health uses its gateway credential without a separate verification request", async () => {
  const runtimes = [{
    id: "runtime-managed-openclaw-1",
    workspaceId: "ws-1",
    provider: "openclaw" as const,
    name: "Managed OpenClaw",
    status: "online" as const,
    metadata: {
      executablePath: "/var/lib/dofe/managed-runtimes/runtime-managed-openclaw-1/run-provider",
      mode: "remote" as const,
      managedCredentialId: "credential-openclaw-1",
      provisioningState: "managed",
    },
  }];

  const environments = await resolveManagedProviderVerificationEnvironments(runtimes, {
    resolve: async (runtimeId, credentialId) => {
      assert.equal(runtimeId, "runtime-managed-openclaw-1");
      assert.equal(credentialId, "credential-openclaw-1");
      return {
        accountId: runtimeId,
        profileDir: "/var/lib/dofe/managed-runtimes/runtime-managed-openclaw-1",
        environment: {
          OPENAI_API_KEY: "managed-openclaw-key",
          OPENAI_BASE_URL: "http://gateway.internal/v1",
        },
      };
    },
  });

  const records = buildRemoteRuntimeHeartbeatMetadata(runtimes, undefined, environments);
  const health = records[0]!.metadata.providerHealth as { status?: unknown; error?: unknown } | undefined;
  assert.equal(health?.status, "healthy");
  assert.equal(health?.error, undefined);
  assert.equal("OPENAI_API_KEY" in records[0]!.metadata, false);
});
