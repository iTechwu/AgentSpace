import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildRemoteDaemonConfig,
  buildRemoteDaemonRelaunchCommand,
  buildRemoteRuntimeHeartbeatMetadata,
  classifyRemoteLoopError,
  mergeRemoteGatewayUsages,
  reconcileRemoteRuntimesWithHeartbeat,
  resolveRemoteTaskExecutionModel,
  resolveRemoteTaskProviderSessionId,
} from "./remote-daemon.ts";
import { DaemonAuthError, DaemonResourceGoneError } from "./daemon-client.ts";

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

test("classifyRemoteLoopError routes auth failures to shutdown and 404 to skip-runtime", () => {
  // Fatal auth errors (invalid/revoked token) must stop the daemon — never loop.
  assert.equal(classifyRemoteLoopError(new DaemonAuthError("Invalid daemon token.", 403)), "shutdown");
  assert.equal(classifyRemoteLoopError(new DaemonAuthError("Missing bearer token.", 401)), "shutdown");
  // A deleted runtime is per-resource: drop it and keep polling the rest.
  assert.equal(
    classifyRemoteLoopError(new DaemonResourceGoneError('Runtime "x" does not exist.', 404)),
    "skip-runtime",
  );
  // Transient / unknown errors stay on the existing "log and retry next tick" path.
  assert.equal(classifyRemoteLoopError(new Error("connect ECONNREFUSED 127.0.0.1:5432")), "log");
  assert.equal(classifyRemoteLoopError(new Error("temporary failure")), "log");
  assert.equal(classifyRemoteLoopError("string error"), "log");
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
