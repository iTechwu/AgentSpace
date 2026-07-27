import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { getDaemonChannelWorkDirPath, getDaemonTaskWorkDirPath } from "@dofe-agent/db";
import { getStringFlag, parseArgs } from "./args.ts";
import type { ClaimedDaemonTask, ClaimedRuntimeAppOperation, DaemonTaskInputBundle, HeartbeatDaemonResponse, ManagedProvisioningTask, ManagedRuntimeCleanupRequest, RegisterDaemonResponse } from "./daemon-api.ts";
import { collectRuntimeOutputBundle, clearTaskOutputArtifacts, materializeInputBundle } from "./bundle.ts";
import { DaemonAuthError, DaemonResourceGoneError, HttpDaemonClient } from "./daemon-client.ts";
import { prepareSkillImportOperationArtifacts } from "./skill-imports.ts";
import {
  type DetectedProvider,
  detectProviders,
  normalizeProviderTaskErrorCategory,
  type ProviderApprovalRequest,
  type ProviderApprovalDecision,
  buildProviderRuntimeMetadata,
  readProviderTaskFailureMetadata,
  readNodeMetadata,
  runProviderTask,
  type RemoteRuntimeRecord,
} from "./provider-runtime.ts";
import {
  cleanupStalePidFile,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_LOG_LINES,
  DEFAULT_TASK_POLL_INTERVAL_MS,
  getDaemonLogFilePath,
  getDaemonPidFilePath,
  getStandaloneCliEntryPath,
  openDaemonLogFile,
  readLastLines,
  readPidIfRunning,
  renderDaemonSummary,
  resolveDefaultDaemonStateDir,
} from "./state.ts";
import { parseTaskInputJson, resolveConversationThreadId } from "./task-context.ts";
import { executeRuntimeAppPlan, parseRuntimeAppInstallPlan, tailAndRedact } from "./runtime-apps.ts";
import { applyProviderCredentialProfile, resolveProviderCredentialProfile } from "./provider-credentials.ts";
import { createManagedCredentialResolver } from "./managed-provider-credentials.ts";
import { createManagedProvisioningExecutor } from "./managed-runtime-provisioning.ts";

export interface RemoteDaemonConfig {
  stateDir: string;
  daemonKey: string;
  deviceName: string;
  runtimeName: string;
  heartbeatIntervalMs: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
  serverUrl?: string;
  daemonToken?: string;
  managedNode: boolean;
}

export interface RemoteDaemonRelaunchCommand {
  command: string;
  args: string[];
}

interface ManagedRuntimeEntry {
  id: string;
  provider: string;
  runtimeCredentialId: string;
  status: "online" | "offline";
}

export interface RemoteDaemonRelaunchCommand {
  command: string;
  args: string[];
}

interface DaemonStatusSummary {
  running: boolean;
  pid: number | "";
  pidFile: string;
  logFile: string;
  stateDir: string;
}

/**
 * How the remote daemon loop should react to a given error. Extracted as a pure
 * function so the decision is unit-testable without driving real timers/exit.
 *
 * - `shutdown`:   fatal auth failure (401/403) — token is invalid/revoked; stop.
 * - `skip-runtime`: the targeted runtime is gone (404) — drop it, keep polling.
 * - `log`:        transient / unknown — log and let the next tick retry.
 */
export type RemoteLoopErrorAction = "shutdown" | "skip-runtime" | "log";

export function classifyRemoteLoopError(error: unknown): RemoteLoopErrorAction {
  if (error instanceof DaemonAuthError) {
    return "shutdown";
  }
  if (error instanceof DaemonResourceGoneError) {
    return "skip-runtime";
  }
  return "log";
}

/** Shared, actionable message used wherever the daemon's token is rejected. */
export const DAEMON_AUTH_REJECTED_MESSAGE =
  "Daemon token rejected by server (HTTP 401/403 — invalid or revoked). "
  + "Re-register the daemon with a valid --daemon-token / DOFE_AGENT_DAEMON_TOKEN.";

export async function runRemoteDaemonCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  if (subcommand === "start") {
    return runRemoteDaemonStart(args);
  }

  if (subcommand === "stop") {
    return runRemoteDaemonStop(args);
  }

  if (subcommand === "status") {
    return runRemoteDaemonStatus(args);
  }

  if (subcommand === "logs") {
    return runRemoteDaemonLogs(args);
  }

  printRemoteDaemonHelp();
  return subcommand ? 1 : 0;
}

export async function runRemoteDaemonForeground(config: RemoteDaemonConfig): Promise<number> {
  if (!config.serverUrl || !config.daemonToken) {
    console.error("Remote daemon mode requires --server-url and --daemon-token.");
    return 1;
  }

  if (!config.managedNode) {
    try {
      const credentialProfile = resolveProviderCredentialProfile({ stateDir: config.stateDir });
      if (credentialProfile) {
        applyProviderCredentialProfile(credentialProfile);
        console.log(`Provider credential profile ready: ${credentialProfile.accountId}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Provider credential profile setup failed: ${message}`);
      return 1;
    }
  }

  const pidPath = getDaemonPidFilePath(config.stateDir);
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");

  const detected = detectProviders();
  if (!config.managedNode && detected.length === 0) {
    rmSync(pidPath, { force: true });
    const configuredProvider = process.env.DOFE_AGENT_RUNTIME_PROVIDER?.trim();
    const providerScope = configuredProvider
      ? ` for DOFE_AGENT_RUNTIME_PROVIDER=${configuredProvider}`
      : "";
    console.error(
      `No supported provider CLI found${providerScope}. Install the configured provider and ensure it is on PATH.`,
    );
    return 1;
  }

  const client = new HttpDaemonClient(config.serverUrl, config.daemonToken);
  let registered: RegisterDaemonResponse;
  try {
    registered = await client.register({
      daemonKey: config.daemonKey,
      deviceName: config.deviceName,
      metadata: readNodeMetadata(config.serverUrl, config.runtimeName, undefined, config.managedNode),
      runtimes: config.managedNode
        ? []
        : detected.map((provider) => ({
            provider: provider.provider,
            providerAccountId: process.env.DOFE_AGENT_PROVIDER_ACCOUNT_ID?.trim() || undefined,
            name: `${config.runtimeName} · ${provider.label}`,
            version: provider.version,
            deviceInfo: config.deviceName,
            metadata: buildProviderRuntimeMetadata({
              provider: provider.provider,
              metadata: {
                executablePath: provider.executablePath,
                mode: "remote",
              },
            }),
          })),
    });
  } catch (error) {
    rmSync(pidPath, { force: true });
    if (error instanceof DaemonAuthError) {
      console.error(`\n[FATAL] ${DAEMON_AUTH_REJECTED_MESSAGE}\n`);
      return 1;
    }
    throw error;
  }

  let runtimes = buildRemoteRuntimeRecords(config, registered, detected);
  if (!config.managedNode && runtimes.length === 0) {
    rmSync(pidPath, { force: true });
    console.error("Remote daemon registration returned no runnable runtimes.");
    return 1;
  }

  console.log(`Remote daemon online: ${config.daemonKey}`);
  if (!config.managedNode) {
    console.log(`Providers: ${runtimes.map((runtime) => runtime.provider).join(", ")}`);
  } else {
    console.log("Managed node: no local provider CLIs required.");
  }

  const managedRuntimes = new Map<string, ManagedRuntimeEntry>();
  const credentialResolver = createManagedCredentialResolver(config.stateDir, (runtimeId) =>
    client.getManagedCredentialBundle(runtimeId)
  );
  const provisioningExecutor = createManagedProvisioningExecutor(config.stateDir, credentialResolver);

  const activeRuntimes = new Set<string>();
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const metadata = readNodeMetadata(
          config.serverUrl ?? "",
          config.runtimeName,
          runtimes,
          config.managedNode,
        );
        const managedRuntimeMetadata = buildManagedRuntimeHeartbeatMetadata(managedRuntimes);
        const heartbeat = await client.sendHeartbeatWithMetadata(
          config.daemonKey,
          { ...metadata, managedRuntimes: managedRuntimeMetadata },
          buildRemoteRuntimeHeartbeatMetadata(runtimes),
        );
        runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, heartbeat);
        if (!config.managedNode && runtimes.some(hasPendingProviderVerification)) {
          const verificationHeartbeat = await client.sendHeartbeatWithMetadata(
            config.daemonKey,
            metadata,
            buildRemoteRuntimeHeartbeatMetadata(runtimes),
          );
          runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, verificationHeartbeat);
        }
        for (const runtimeId of activeRuntimes) {
          if (!runtimes.some((runtime) => runtime.id === runtimeId)) {
            activeRuntimes.delete(runtimeId);
          }
        }
        await executeManagedCleanupRequests(client, provisioningExecutor, heartbeat.managedRuntimeCleanupRequests);
      } catch (error) {
        if (classifyRemoteLoopError(error) === "shutdown") {
          fatalShutdown(DAEMON_AUTH_REJECTED_MESSAGE);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Heartbeat failed: ${message}`);
      }
    })();
  }, config.heartbeatIntervalMs);

  let polling = false;
  const taskPollTimer = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;
    void pollRemoteTasks(client, config, runtimes, activeRuntimes)
      .catch((error) => {
        if (classifyRemoteLoopError(error) === "shutdown") {
          fatalShutdown(DAEMON_AUTH_REJECTED_MESSAGE);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Remote task polling failed: ${message}`);
      })
      .finally(() => {
        polling = false;
      });
  }, config.taskPollIntervalMs);

  let managedProvisioningPolling = false;
  const managedProvisioningPollTimer = config.managedNode
    ? setInterval(() => {
        if (managedProvisioningPolling) {
          return;
        }
        managedProvisioningPolling = true;
        void pollManagedProvisioningTasks(client, provisioningExecutor, managedRuntimes)
          .catch((error) => {
            if (classifyRemoteLoopError(error) === "shutdown") {
              fatalShutdown(DAEMON_AUTH_REJECTED_MESSAGE);
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Managed provisioning polling failed: ${message}`);
          })
          .finally(() => {
            managedProvisioningPolling = false;
          });
      }, config.taskPollIntervalMs)
    : undefined;

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void (async () => {
      clearInterval(heartbeatTimer);
      clearInterval(taskPollTimer);
      if (managedProvisioningPollTimer) {
        clearInterval(managedProvisioningPollTimer);
      }
      rmSync(pidPath, { force: true });
      try {
        await client.deregister(config.daemonKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to deregister remote daemon: ${message}`);
      }
      console.log(`Remote daemon stopped (${signal}).`);
      process.exit(0);
    })();
  };

  /**
   * Fatal, non-recoverable exit. Used when the daemon's token is rejected: there is
   * no point retrying, so we stop the loops, deregister best-effort, and exit with a
   * loud, actionable message instead of spamming the server with doomed requests.
   */
  const fatalShutdown = (reason: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(heartbeatTimer);
    clearInterval(taskPollTimer);
    rmSync(pidPath, { force: true });
    void (async () => {
      try {
        await client.deregister(config.daemonKey, reason);
      } catch {
        // Best effort — we are exiting regardless.
      }
      console.error(`\n[FATAL] ${reason}\n`);
      process.exit(1);
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {
    // Keep the daemon alive until it receives a signal.
  });
  return 0;
}

export function buildRemoteDaemonConfig(
  flags: Record<string, string | boolean>,
  options?: { environment?: NodeJS.ProcessEnv; defaultStateDir?: string },
): RemoteDaemonConfig {
  const environment = options?.environment ?? process.env;
  const hostname = environment.HOSTNAME || environment.COMPUTERNAME || "remote-daemon";

  return {
    stateDir:
      getStringFlag(flags, "state-dir")?.trim()
      || environment.DOFE_AGENT_DAEMON_STATE_DIR?.trim()
      || options?.defaultStateDir
      || resolveDefaultDaemonStateDir(environment),
    daemonKey: getStringFlag(flags, "daemon-id")?.trim() || environment.DOFE_AGENT_DAEMON_ID?.trim() || hostname,
    deviceName: getStringFlag(flags, "device-name")?.trim() || environment.DOFE_AGENT_DEVICE_NAME?.trim() || hostname,
    runtimeName: getStringFlag(flags, "runtime-name")?.trim() || environment.DOFE_AGENT_RUNTIME_NAME?.trim() || "Remote Agent",
    heartbeatIntervalMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "heartbeat-interval")
          ?? environment.DOFE_AGENT_HEARTBEAT_INTERVAL
          ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      ),
    ),
    taskPollIntervalMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "poll-interval")
          ?? environment.DOFE_AGENT_TASK_POLL_INTERVAL
          ?? DEFAULT_TASK_POLL_INTERVAL_MS,
      ),
    ),
    taskTimeoutMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "task-timeout")
          ?? environment.DOFE_AGENT_TASK_TIMEOUT_MS
          ?? 12 * 60 * 60 * 1000,
      ),
    ),
    serverUrl: getStringFlag(flags, "server-url")?.trim() || environment.DOFE_AGENT_SERVER_URL?.trim(),
    daemonToken: getStringFlag(flags, "daemon-token")?.trim() || environment.DOFE_AGENT_DAEMON_TOKEN?.trim(),
    managedNode: parsed.flags["managed-node"] === true || environment.DOFE_AGENT_MANAGED_NODE === "1" || environment.DOFE_AGENT_MANAGED_NODE === "true",
  };
}

export function printRemoteDaemonHelp(): void {
  console.log(`dofe-agent-daemon

Usage:
  dofe-agent-daemon start [--foreground] [--server-url <url>] [--daemon-token <token>] [--daemon-id <id>] [--device-name <name>] [--runtime-name <label>] [--heartbeat-interval <ms>] [--poll-interval <ms>] [--task-timeout <ms>] [--state-dir <dir>]
  dofe-agent-daemon stop [--state-dir <dir>]
  dofe-agent-daemon status [--json] [--state-dir <dir>]
  dofe-agent-daemon logs [--lines <n>] [--follow] [--state-dir <dir>]

Environment:
  DOFE_AGENT_SERVER_URL
  DOFE_AGENT_DAEMON_TOKEN
  DOFE_AGENT_DAEMON_ID
  DOFE_AGENT_DEVICE_NAME
  DOFE_AGENT_RUNTIME_NAME
  DOFE_AGENT_PROVIDER_ACCOUNT_ID
  DOFE_AGENT_DAEMON_STATE_DIR
  DOFE_AGENT_HEARTBEAT_INTERVAL
  DOFE_AGENT_TASK_POLL_INTERVAL
  DOFE_AGENT_TASK_TIMEOUT_MS

Examples:
  dofe-agent-daemon start --foreground --server-url https://dofe-agent.example --daemon-token adt_xxx
  dofe-agent-daemon status --json
  dofe-agent-daemon logs --follow`);
}

async function runRemoteDaemonStart(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const config = buildRemoteDaemonConfig(parsed.flags);

  if (parsed.flags.foreground === true) {
    return runRemoteDaemonForeground(config);
  }

  const pidPath = getDaemonPidFilePath(config.stateDir);
  const logPath = getDaemonLogFilePath(config.stateDir);
  const existingPid = readPidIfRunning(pidPath);
  if (existingPid) {
    console.error(`Remote daemon is already running (pid ${existingPid}).`);
    return 1;
  }

  const logFd = openDaemonLogFile(logPath);
  const relaunch = buildRemoteDaemonRelaunchCommand(config);
  const child = spawn(relaunch.command, relaunch.args, {
    cwd: config.stateDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  child.unref();

  if (!child.pid) {
    console.error("Failed to start remote daemon process.");
    return 1;
  }

  writeFileSync(pidPath, `${child.pid}\n`, "utf8");
  await sleep(750);
  if (!readPidIfRunning(pidPath)) {
    rmSync(pidPath, { force: true });
    console.error("Remote daemon process exited immediately. Check logs:");
    console.error(`  ${logPath}`);
    return 1;
  }

  console.log(`Remote daemon started (pid ${child.pid}).`);
  console.log(`State: ${config.stateDir}`);
  console.log(`Logs: ${logPath}`);
  return 0;
}

export function buildRemoteDaemonRelaunchCommand(
  config: RemoteDaemonConfig,
  options?: {
    argv?: string[];
    execPath?: string;
  },
): RemoteDaemonRelaunchCommand {
  const entryPath = resolveRemoteDaemonRelaunchEntryPath(options?.argv ?? process.argv);
  const args = [
    ...buildNodeEntryArgs(entryPath),
    "start",
    "--foreground",
    "--state-dir",
    config.stateDir,
    "--daemon-id",
    config.daemonKey,
    "--device-name",
    config.deviceName,
    "--runtime-name",
    config.runtimeName,
    "--heartbeat-interval",
    String(config.heartbeatIntervalMs),
    "--poll-interval",
    String(config.taskPollIntervalMs),
    "--task-timeout",
    String(config.taskTimeoutMs),
  ];

  if (config.serverUrl) {
    args.push("--server-url", config.serverUrl);
  }
  if (config.daemonToken) {
    args.push("--daemon-token", config.daemonToken);
  }

  return {
    command: options?.execPath ?? process.execPath,
    args,
  };
}

function buildNodeEntryArgs(entryPath: string): string[] {
  return entryPath.endsWith(".ts") ? ["--experimental-strip-types", entryPath] : [entryPath];
}

function resolveRemoteDaemonRelaunchEntryPath(argv: string[]): string {
  const invokedPath = argv[1]?.trim();
  if (invokedPath) {
    return resolve(invokedPath);
  }
  return getStandaloneCliEntryPath();
}

async function runRemoteDaemonStop(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const stateDir = resolveStateDir(parsed.flags);
  const pidPath = getDaemonPidFilePath(stateDir);
  const pid = readPidIfRunning(pidPath);

  if (!pid) {
    cleanupStalePidFile(pidPath);
    console.error("Remote daemon is not running.");
    return 1;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!readPidIfRunning(pidPath)) {
      rmSync(pidPath, { force: true });
      console.log(`Remote daemon stopped (pid ${pid}).`);
      return 0;
    }
    await sleep(100);
  }

  console.error(`Timed out waiting for remote daemon ${pid} to stop.`);
  return 1;
}

function runRemoteDaemonStatus(args: string[]): number {
  const parsed = parseArgs(args);
  const stateDir = resolveStateDir(parsed.flags);
  const summary = buildDaemonStatusSummary(stateDir);

  if (parsed.flags.json === true) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }

  console.log(renderDaemonSummary(summary));
  return 0;
}

async function runRemoteDaemonLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const follow = parsed.flags.follow === true;
  const stateDir = resolveStateDir(parsed.flags);
  const linesRaw = getStringFlag(parsed.flags, "lines");
  const lines = linesRaw ? Number(linesRaw) : DEFAULT_LOG_LINES;
  const logPath = getDaemonLogFilePath(stateDir);

  if (!existsSync(logPath)) {
    console.error(`No daemon log file at ${logPath}.`);
    return 1;
  }

  const initial = readLastLines(logPath, Number.isFinite(lines) && lines > 0 ? lines : DEFAULT_LOG_LINES);
  if (initial.length > 0) {
    process.stdout.write(`${initial.join("\n")}\n`);
  }

  if (!follow) {
    return 0;
  }

  let position = statSync(logPath).size;
  const poll = setInterval(() => {
    const size = statSync(logPath).size;
    if (size <= position) {
      return;
    }

    const next = createReadStream(logPath, { encoding: "utf8", start: position, end: size - 1 });
    next.on("data", (chunk) => {
      position += Buffer.byteLength(chunk);
      process.stdout.write(chunk);
    });
  }, 1000);

  await new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(poll);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

async function pollRemoteTasks(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtimes: RemoteRuntimeRecord[],
  activeRuntimes: Set<string>,
): Promise<void> {
  for (const runtime of runtimes) {
    if (activeRuntimes.has(runtime.id)) {
      continue;
    }

    try {
      const appOperation = await client.claimRuntimeAppOperation(runtime.id);
      if (appOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeRemoteRuntimeAppOperation(client, appOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Runtime app operation ${appOperation.operation?.id ?? "unknown"} crashed: ${message}`);
          })
          .finally(() => {
            activeRuntimes.delete(runtime.id);
          });
        continue;
      }

      const claimed = await client.claimTask(runtime.id);
      if (!claimed.task) {
        continue;
      }

      activeRuntimes.add(runtime.id);
      void executeRemoteTask(client, config, runtime, claimed.task)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Remote task ${claimed.task?.id ?? "unknown"} crashed: ${message}`);
        })
        .finally(() => {
          activeRuntimes.delete(runtime.id);
        });
    } catch (error) {
      if (classifyRemoteLoopError(error) === "skip-runtime") {
        // Runtime was deleted server-side. The next successful heartbeat reconciles
        // (prunes) it from `runtimes`, so this surfaces at most once per deletion.
        console.warn(
          `Runtime ${runtime.id} no longer exists on the server; skipping until heartbeat reconciles.`,
        );
        continue;
      }
      throw error;
    }
  }
}

async function executeRemoteRuntimeAppOperation(
  client: HttpDaemonClient,
  operation: ClaimedRuntimeAppOperation,
): Promise<void> {
  await client.startRuntimeAppOperation(operation.id);
  const plan = parseRuntimeAppInstallPlan(operation.commandPlan);
  if (!plan) {
    await client.failRuntimeAppOperation(operation.id, {
      errorCode: "runtime_app.invalid_plan",
      errorMessage: "Runtime app operation command plan is invalid.",
    });
    return;
  }
  try {
    const result = await executeRuntimeAppPlan(plan);
    await client.completeRuntimeAppOperation(operation.id, {
      safeStdoutTail: result.safeStdoutTail,
      safeStderrTail: result.safeStderrTail,
      installedApp: {
        displayName: plan.app.name,
        version: plan.app.version,
        entryPoint: plan.app.entryPoint,
        installStrategy: plan.strategy,
        metadataJson: JSON.stringify({
          verifiedAt: new Date().toISOString(),
          strategy: plan.strategy,
        }),
      },
    });
  } catch (error) {
    await client.failRuntimeAppOperation(operation.id, {
      safeStdoutTail: readErrorTail(error, "stdout"),
      safeStderrTail: readErrorTail(error, "stderr"),
      errorCode: "runtime_app.command_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeRemoteTask(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
  task: ClaimedDaemonTask,
): Promise<void> {
  const workDir = resolveRemoteTaskWorkDir(config, task);
  const isPersistentConversationWorkspace = isConversationScopedRemoteTask(task);
  if (!isPersistentConversationWorkspace) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });

  try {
    await client.startTask(task.id);
    const bundle = await client.getInputBundle(task.id);
    materializeInputBundle(workDir, bundle);

    const result = await runProviderTask(
      runtime,
      bundle.prompt,
      workDir,
      {
        sessionId: bundle.metadata.routerSession?.providerSessionId ?? resolveRemoteTaskProviderSessionId(task.inputJson),
        taskTimeoutMs: config.taskTimeoutMs,
        contextEnv: {
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_AGENT_NAME: readRemoteTaskAgentName(task),
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
        },
        runtimeApps: bundle.metadata.runtimeApps?.apps ?? [],
        runtimeToolCapabilities: bundle.metadata.runtimeToolCapabilities?.capabilities ?? [],
        onEvent: (event) => {
          void client.reportMessages(task.id, { messages: [event] }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to report remote task message for ${task.id}: ${message}`);
          });
        },
        onApprovalRequest: (request) => waitForRuntimeApproval(client, task.id, request),
      },
    );

    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    for (const warning of preparedSkillImports.warnings) {
      await client.reportMessages(task.id, { messages: [{ type: "status", content: warning }] }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to report skill import warning for ${task.id}: ${message}`);
      });
    }

    const outputBundle = collectRuntimeOutputBundle(workDir);
    if (outputBundle) {
      await client.uploadOutputBundle(task.id, outputBundle);
    }

    await client.completeTask(task.id, {
      outputText: result.output,
      sessionId: result.sessionId,
      workDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError;
    await client.failTask(task.id, {
      errorText: message,
      errorCode: providerError?.code,
      errorCategory: normalizeProviderTaskErrorCategory(providerError?.category),
      provider: providerError?.provider,
      rawProviderMessage: providerError?.rawProviderMessage,
      sessionId: failureMetadata?.sessionId,
      workDir: failureMetadata?.workDir ?? workDir,
    });
  } finally {
    clearTaskOutputArtifacts(workDir);
    if (!isPersistentConversationWorkspace) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function buildRemoteRuntimeRecords(
  config: RemoteDaemonConfig,
  registered: RegisterDaemonResponse,
  detected: DetectedProvider[],
): RemoteRuntimeRecord[] {
  return registered.runtimes.flatMap((runtime) => {
    const detectedProvider = detected.find((provider) => provider.provider === runtime.provider);
    if (!detectedProvider) {
      return [];
    }

    return [{
      id: runtime.id,
      workspaceId: registered.daemon.workspaceId,
      provider: detectedProvider.provider,
      name: runtime.name,
      version: detectedProvider.version,
      status: runtime.status,
      deviceInfo: config.deviceName,
      metadata: {
        executablePath: detectedProvider.executablePath,
        mode: "remote",
        ...buildProviderRuntimeMetadata({
          provider: detectedProvider.provider,
          metadata: {
            executablePath: detectedProvider.executablePath,
            mode: "remote",
          },
        }),
      },
    } satisfies RemoteRuntimeRecord];
  });
}

function reconcileRemoteRuntimesWithHeartbeat(
  current: RemoteRuntimeRecord[],
  heartbeat: HeartbeatDaemonResponse,
): RemoteRuntimeRecord[] {
  const heartbeatRuntimeById = new Map(heartbeat.runtimes.map((runtime) => [runtime.id, runtime]));
  return current.flatMap((runtime) => {
    const heartbeatRuntime = heartbeatRuntimeById.get(runtime.id);
    if (!heartbeatRuntime) {
      return [];
    }
    return [{
      ...runtime,
      status: heartbeatRuntime.status,
      metadata: {
        ...runtime.metadata,
        ...(heartbeatRuntime.metadata ?? {}),
      },
    }];
  });
}

function buildRemoteRuntimeHeartbeatMetadata(runtimes: RemoteRuntimeRecord[]): Array<{
  id: string;
  provider: RemoteRuntimeRecord["provider"];
  metadata: Record<string, unknown>;
}> {
  return runtimes.map((runtime) => ({
    id: runtime.id,
    provider: runtime.provider,
    metadata: buildProviderRuntimeMetadata(runtime),
  }));
}

function hasPendingProviderVerification(runtime: RemoteRuntimeRecord): boolean {
  const requestedAt = runtime.metadata.providerVerificationRequestedAt;
  if (!requestedAt) {
    return false;
  }
  const health = runtime.metadata.providerHealth as { checkedAt?: unknown } | undefined;
  if (typeof health?.checkedAt !== "string") {
    return true;
  }
  return new Date(health.checkedAt).getTime() < new Date(requestedAt).getTime();
}

function resolveStateDir(flags: Record<string, string | boolean>): string {
  return buildRemoteDaemonConfig(flags).stateDir;
}

function buildDaemonStatusSummary(stateDir: string): DaemonStatusSummary {
  const pidPath = getDaemonPidFilePath(stateDir);
  const logPath = getDaemonLogFilePath(stateDir);
  const pid = readPidIfRunning(pidPath);

  return {
    running: Boolean(pid),
    pid: pid ?? "",
    pidFile: pidPath,
    logFile: logPath,
    stateDir,
  };
}

async function waitForRuntimeApproval(
  client: HttpDaemonClient,
  taskId: string,
  request: ProviderApprovalRequest,
): Promise<ProviderApprovalDecision> {
  const created = await client.createRuntimeApproval(taskId, {
    provider: request.provider,
    runtimeId: request.runtimeId,
    sessionId: request.sessionId,
    toolName: request.toolName,
    toolInput: request.toolInput,
    contentPreview: request.contentPreview,
  });
  await client.reportMessages(taskId, {
    messages: [{
      type: "status",
      content: `等待前端审批工具调用：${request.contentPreview}`,
    }],
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to report approval wait message for ${taskId}: ${message}`);
  });

  while (true) {
    const current = await client.getRuntimeApproval(taskId, created.approval.approvalId);
    if (current.approval.status === "approved") {
      return {
        decision: "approved",
        comment: current.approval.reviewerComment,
      };
    }
    if (current.approval.status === "rejected") {
      return {
        decision: "rejected",
        comment: current.approval.reviewerComment,
      };
    }
    await sleep(1_000);
  }
}

async function pollManagedProvisioningTasks(
  client: HttpDaemonClient,
  executor: ReturnType<typeof createManagedProvisioningExecutor>,
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Promise<void> {
  const claimed = await client.claimManagedProvisioningTask();
  if (!claimed.task) {
    return;
  }
  const task = claimed.task;
  console.log(`Managed provisioning: ${task.stage} for ${task.runtimeId}`);
  try {
    const result = await executor.execute(task);
    if (!result.success) {
      await client.failManagedProvisioningStage(task.taskId, task.stage, {
        runtimeId: task.runtimeId,
        errorCode: result.errorCode ?? "managed_runtime.stage_failed",
        errorMessage: result.errorMessage ?? "Unknown stage failure",
      });
      return;
    }
    await client.completeManagedProvisioningStage(task.taskId, task.stage, { runtimeId: task.runtimeId });
    if (task.stage === "health_check") {
      managedRuntimes.set(task.runtimeId, {
        id: task.runtimeId,
        provider: task.runtimeType,
        runtimeCredentialId: task.runtimeCredentialId,
        status: "online",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.failManagedProvisioningStage(task.taskId, task.stage, {
      runtimeId: task.runtimeId,
      errorCode: "managed_runtime.unhandled_error",
      errorMessage: message,
    });
  }
}

async function executeManagedCleanupRequests(
  client: HttpDaemonClient,
  executor: ReturnType<typeof createManagedProvisioningExecutor>,
  requests: ManagedRuntimeCleanupRequest[],
): Promise<void> {
  for (const request of requests) {
    console.log(`Managed cleanup: ${request.runtimeId}`);
    try {
      const result = await executor.executeCleanup(request.runtimeId, request.commands);
      await client.completeManagedRuntimeCleanupRequest(request.requestId, {
        result: {
          success: result.success,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          safeStdoutTail: result.safeStdoutTail,
          safeStderrTail: result.safeStderrTail,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.completeManagedRuntimeCleanupRequest(request.requestId, {
        result: { success: false, errorMessage: message },
      });
    }
  }
}

function buildManagedRuntimeHeartbeatMetadata(
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Array<{ id: string; provider: string; status: string; managedCredentialId: string }> {
  return Array.from(managedRuntimes.values()).map((runtime) => ({
    id: runtime.id,
    provider: runtime.provider,
    status: runtime.status,
    managedCredentialId: runtime.runtimeCredentialId,
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readErrorTail(error: unknown, key: "stdout" | "stderr"): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? tailAndRedact(value) : undefined;
}

function resolveRemoteTaskWorkDir(config: RemoteDaemonConfig, task: ClaimedDaemonTask): string {
  const payload = parseTaskInputJson(task.inputJson);
  const channelThreadId = resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  });
  if (channelThreadId) {
    return getDaemonChannelWorkDirPath(config.stateDir, {
      workspaceId: task.workspaceId,
      threadId: channelThreadId,
      agentId: task.agentId,
    });
  }

  return getDaemonTaskWorkDirPath(config.stateDir, {
    workspaceId: task.workspaceId,
    taskId: task.id,
  });
}

function isConversationScopedRemoteTask(task: ClaimedDaemonTask): boolean {
  const payload = parseTaskInputJson(task.inputJson);
  return Boolean(resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  }));
}

export function resolveRemoteTaskProviderSessionId(inputJson: string): string | undefined {
  const sessionId = parseTaskInputJson(inputJson).channelSessionId?.trim();
  return sessionId || undefined;
}

function readRemoteTaskAgentName(task: ClaimedDaemonTask): string {
  return parseTaskInputJson(task.inputJson).assignee?.trim() || task.agentId;
}
