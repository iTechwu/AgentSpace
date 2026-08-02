import { randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import {
  getDaemonChannelWorkDirPath,
  getDaemonRuntimeAppDepsRootPath,
  getDaemonTaskWorkDirPath,
} from "@dofe-agent/db";
import {
  isDaemonProvider,
  resolveProviderProtocols,
  type DaemonProvider,
  type DaemonTaskUsage,
} from "@dofe-agent/domain";
import { getStringFlag, parseArgs } from "./args.ts";
import type { ClaimedDaemonTask, ClaimedManagedSkillServiceOperation, ClaimedRuntimeAppOperation, ClaimedSkillInstallationOperation, DaemonTaskInputBundle, HeartbeatDaemonResponse, ManagedProvisioningTask, ManagedRuntimeCleanupRequest, RegisterDaemonResponse } from "./daemon-api.ts";
import {
  clearTaskOutputArtifacts,
  materializeRemoteInputBundle,
  prepareRemoteOutputBundle,
  readWorkspaceBlobUploadBytes,
} from "./bundle.ts";
import { readEmployeeHeadManifestSync } from "./workdir-capture.ts";
import { DaemonAuthError, DaemonResourceGoneError, DaemonRuntimeUnavailableError, HttpDaemonClient } from "./daemon-client.ts";
import { prepareSkillImportOperationArtifacts } from "./skill-imports.ts";
import { buildSkillDependencyTaskEnvironment } from "./skill-install/task-environment.ts";
import { executeSkillInstallationOperation } from "./skill-install/operation-worker.ts";
import { partitionSkillEnvironment } from "./skill-environment.ts";
import { startSkillRunnerBroker, type SkillRunnerBroker } from "./skill-runner.ts";
import { executeSkillServiceOperation } from "./skill-service/service-operation-worker.ts";
import { executeWorkspaceMountOperation } from "./workspace-mount-operation-worker.ts";
import {
  type DetectedProvider,
  detectProviders,
  normalizeProviderTaskErrorCategory,
  type ProviderApprovalRequest,
  type ProviderApprovalDecision,
  type ProviderTaskEvent,
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
import { executeMcpConnectionOperation } from "./mcp/verify-executor.ts";
import { McpGateway } from "./mcp/gateway.ts";
import { McpAuditOutbox } from "./mcp/audit-outbox.ts";
import { applyProviderCredentialProfile, resolveProviderCredentialProfile, type ProviderCredentialProfile } from "./provider-credentials.ts";
import { createManagedCredentialResolver, type ManagedCredentialResolver } from "./managed-provider-credentials.ts";
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

export interface ManagedRuntimeEntry {
  id: string;
  provider: DaemonProvider;
  runtimeCredentialId: string;
  executablePath: string;
  status: "online" | "offline";
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
 * - `skip-runtime`: the targeted runtime is gone (404) or offline (409) — keep polling.
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
  if (error instanceof DaemonRuntimeUnavailableError) {
    return "skip-runtime";
  }
  return "log";
}

export function resolveRemoteTaskExecutionModel(bundle: DaemonTaskInputBundle): string | undefined {
  return bundle.metadata.effectiveModel?.modelId.trim() || undefined;
}

type RemoteTaskUsageEntry = DaemonTaskUsage;

interface RemoteGatewayUsageEntry {
  requestId: string;
  gatewayUsageId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  protocol?: string;
  requestStartedAt?: string;
  requestEndedAt?: string;
}

export function mergeRemoteGatewayUsages(
  providerUsages: RemoteTaskUsageEntry[],
  gatewayUsages: RemoteGatewayUsageEntry[],
  context: Pick<RemoteTaskUsageEntry, "modelId" | "runtimeCredentialId" | "routerSessionId">,
): RemoteTaskUsageEntry[] {
  const usagesByRequestId = new Map<string, RemoteTaskUsageEntry>();
  for (const usage of providerUsages) {
    if (usage.gatewayRequestId) usagesByRequestId.set(usage.gatewayRequestId, usage);
  }
  for (const usage of gatewayUsages) {
    usagesByRequestId.set(usage.requestId, {
      ...context,
      gatewayRequestId: usage.requestId,
      gatewayUsageId: usage.gatewayUsageId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheTokens: usage.cacheTokens,
      protocol: usage.protocol,
      requestStartedAt: usage.requestStartedAt,
      requestEndedAt: usage.requestEndedAt,
    });
  }
  return [...usagesByRequestId.values()];
}

/** Shared, actionable message used wherever the daemon's token is rejected. */
export const DAEMON_AUTH_REJECTED_MESSAGE =
  "Daemon token rejected by server (HTTP 401/403 — invalid or revoked). "
  + "Re-register the daemon with a valid --daemon-token / DOFE_AGENT_DAEMON_TOKEN.";

const RUNTIME_APPROVAL_TIMEOUT_MS = 15 * 60 * 1_000;

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
  const mcpAuditOutbox = new McpAuditOutbox(config.stateDir);
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
  let auditOutboxFlushing = false;
  const flushMcpAuditOutbox = (): void => {
    if (auditOutboxFlushing) return;
    auditOutboxFlushing = true;
    void mcpAuditOutbox.flush(client)
      .then((result) => {
        if (result.failed > 0 || result.deadLettered > 0) {
          console.error(
            `MCP audit outbox: delivered=${result.delivered}, failed=${result.failed}, deadLettered=${result.deadLettered}`,
          );
        }
      })
      .finally(() => {
        auditOutboxFlushing = false;
      });
  };
  flushMcpAuditOutbox();
  const mcpAuditOutboxTimer = setInterval(flushMcpAuditOutbox, 5_000);
  mcpAuditOutboxTimer.unref();
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
        const verificationEnvironments = await resolveManagedProviderVerificationEnvironments(runtimes, credentialResolver);
        const heartbeat = await client.sendHeartbeatWithMetadata(
          config.daemonKey,
          { ...metadata, managedRuntimes: managedRuntimeMetadata },
          buildRemoteRuntimeHeartbeatMetadata(runtimes, managedRuntimes, verificationEnvironments),
        );
        runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, heartbeat, registered.daemon.workspaceId, config.deviceName);
        await restoreManagedRuntimesFromHeartbeat(heartbeat, managedRuntimes, credentialResolver);
        if (runtimes.some(hasPendingProviderVerification)) {
          const verificationEnvironments = await resolveManagedProviderVerificationEnvironments(runtimes, credentialResolver);
          const verificationHeartbeat = await client.sendHeartbeatWithMetadata(
            config.daemonKey,
            metadata,
            buildRemoteRuntimeHeartbeatMetadata(runtimes, managedRuntimes, verificationEnvironments),
          );
          runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, verificationHeartbeat, registered.daemon.workspaceId, config.deviceName);
        }
        for (const runtimeId of activeRuntimes) {
          if (!runtimes.some((runtime) => runtime.id === runtimeId)) {
            activeRuntimes.delete(runtimeId);
          }
        }
        await executeManagedCleanupRequests(client, provisioningExecutor, managedRuntimes, heartbeat.managedRuntimeCleanupRequests);
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
    void pollRemoteTasks(client, config, runtimes, activeRuntimes, credentialResolver, mcpAuditOutbox)
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
      clearInterval(mcpAuditOutboxTimer);
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
    clearInterval(mcpAuditOutboxTimer);
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
    managedNode: flags["managed-node"] === true || environment.DOFE_AGENT_MANAGED_NODE === "1" || environment.DOFE_AGENT_MANAGED_NODE === "true",
  };
}

export function printRemoteDaemonHelp(): void {
  console.log(`dofe-agent-daemon

Usage:
  dofe-agent-daemon start [--foreground] [--managed-node] [--server-url <url>] [--daemon-token <token>] [--daemon-id <id>] [--device-name <name>] [--runtime-name <label>] [--heartbeat-interval <ms>] [--poll-interval <ms>] [--task-timeout <ms>] [--state-dir <dir>]
  dofe-agent-daemon stop [--state-dir <dir>]
  dofe-agent-daemon status [--json] [--state-dir <dir>]
  dofe-agent-daemon logs [--lines <n>] [--follow] [--state-dir <dir>]

Environment:
  DOFE_AGENT_SERVER_URL
  DOFE_AGENT_DAEMON_TOKEN
  DOFE_AGENT_DAEMON_ID
  DOFE_AGENT_DEVICE_NAME
  DOFE_AGENT_RUNTIME_NAME
  DOFE_AGENT_MANAGED_NODE
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
  if (config.managedNode) {
    args.push("--managed-node");
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
  credentialResolver: ManagedCredentialResolver,
  mcpAuditOutbox: McpAuditOutbox,
): Promise<void> {
  for (const runtime of runtimes) {
    if (activeRuntimes.has(runtime.id)) {
      continue;
    }
    try {
      const appOperation = await client.claimRuntimeAppOperation(runtime.id);
      if (appOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeRemoteRuntimeAppOperation(client, config, appOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Runtime app operation ${appOperation.operation?.id ?? "unknown"} crashed: ${message}`);
          })
          .finally(() => {
            activeRuntimes.delete(runtime.id);
          });
        continue;
      }

      const mcpOperation = await client.claimMcpConnectionOperation(runtime.id);
      if (mcpOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeMcpConnectionOperation(client, mcpOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`MCP operation ${mcpOperation.operation?.id ?? "unknown"} crashed: ${message}`);
          })
          .finally(() => {
            activeRuntimes.delete(runtime.id);
          });
        continue;
      }

      const skillOperation = await client.claimSkillInstallationOperation(runtime.id);
      if (skillOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeRemoteSkillInstallationOperation(client, config, skillOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Skill installation operation ${skillOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
          })
          .finally(() => {
            activeRuntimes.delete(runtime.id);
          });
        continue;
      }

      const serviceOperation = await client.claimSkillServiceOperation(runtime.id);
      if (serviceOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeRemoteSkillServiceOperation(client, config, serviceOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Skill service operation ${serviceOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
          })
          .finally(() => {
            activeRuntimes.delete(runtime.id);
          });
        continue;
      }

      const mountOperation = await client.claimWorkspaceMountOperation(runtime.id);
      if (mountOperation.operation) {
        activeRuntimes.add(runtime.id);
        void executeWorkspaceMountOperation(client, config, mountOperation.operation)
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Workspace mount operation ${mountOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
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
      void executeRemoteTask(client, config, runtime, claimed.task, credentialResolver, mcpAuditOutbox)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Remote task ${claimed.task?.id ?? "unknown"} crashed: ${message}`);
        })
        .finally(() => {
          activeRuntimes.delete(runtime.id);
        });
    } catch (error) {
      if (classifyRemoteLoopError(error) === "skip-runtime") {
        if (error instanceof DaemonResourceGoneError) {
          // The next successful heartbeat prunes a server-deleted runtime.
          console.warn(
            `Runtime ${runtime.id} no longer exists on the server; skipping until heartbeat reconciles.`,
          );
        } else {
          // A newly provisioned managed runtime can briefly be ineligible to
          // claim work before the next heartbeat reports it online.
          console.debug(
            `Runtime ${runtime.id} is temporarily unavailable; waiting for heartbeat reconciliation.`,
          );
        }
        continue;
      }
      throw error;
    }
  }
}

async function executeRemoteRuntimeAppOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
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
    // GitHub-skill dependency plans install into relative deps/<manager> dirs;
    // the runtime app deps root is the executor cwd so they stay isolated from
    // Provider HOME/global package paths.
    const depsRoot = getDaemonRuntimeAppDepsRootPath(config.stateDir, {
      workspaceId: operation.workspaceId,
    });
    const result = await executeRuntimeAppPlan(plan, { cwd: depsRoot });
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

async function executeRemoteSkillInstallationOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedSkillInstallationOperation,
): Promise<void> {
  await executeSkillInstallationOperation(client, config, operation);
}

async function executeRemoteSkillServiceOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedManagedSkillServiceOperation,
): Promise<void> {
  await executeSkillServiceOperation(client, config, operation);
}

async function resolveManagedCredentialProfile(
  runtime: RemoteRuntimeRecord,
  credentialResolver?: ManagedCredentialResolver,
): Promise<ProviderCredentialProfile | null> {
  if (!runtime.metadata.managedCredentialId || !credentialResolver) {
    return null;
  }
  return credentialResolver.resolve(runtime.id, runtime.metadata.managedCredentialId);
}

async function executeRemoteTask(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
  task: ClaimedDaemonTask,
  credentialResolver?: ManagedCredentialResolver,
  mcpAuditOutbox?: McpAuditOutbox,
): Promise<void> {
  const workDir = resolveRemoteTaskWorkDir(config, task);
  const isPersistentConversationWorkspace = isConversationScopedRemoteTask(task);
  if (!isPersistentConversationWorkspace) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });

  // Task-scoped MCP session: the daemon claims resolved connection bundles
  // through its authenticated channel and hosts a loopback gateway. The
  // Provider's own MCP config only ever receives the gateway URL.
  let mcpSession: { url: string; revoke: () => void } | undefined;
  let skillRunner: SkillRunnerBroker | undefined;

  try {
    await client.startTask(task.id);
    const bundle = await client.getInputBundle(task.id);
    await materializeRemoteInputBundle({
      workDir,
      stateDir: config.stateDir,
      bundle,
      fetchWorkspaceBlob: (taskId, revisionId, sha256) => client.getWorkspaceBlob(taskId, revisionId, sha256),
    });
    const runnerEntrypoints = bundle.metadata.skillRunnerEntrypoints ?? [];
    const skillEnvironment = partitionSkillEnvironment(bundle.metadata.skillEnv, runnerEntrypoints);
    skillRunner = await startSkillRunnerBroker({
      stateDir: config.stateDir,
      workspaceId: task.workspaceId,
      workDir,
      entrypoints: runnerEntrypoints,
      dependencyEnvironments: bundle.metadata.skillDependencyEnvironments,
      skillEnv: skillEnvironment.runnerEnv,
    });

    if (bundle.metadata.mcpConnections?.status === "available") {
      // One attempt id per task execution makes the claim idempotent under
      // HTTP retry: a lost response retries with the same id and the server
      // replays the persisted grant instead of returning "no MCP".
      const claimAttemptId = randomUUID();
      const claimed = await client.claimMcpTaskSession(task.id, claimAttemptId);
      if (claimed.connections.length === 0) {
        // Fail closed: the task expects MCP connections but the claim returned
        // none (connections were dropped/reconfigured mid-flight). Running the
        // task without MCP would silently lose the authorized capability.
        throw new Error("mcp.session_claim_failed: task expects MCP connections but claim returned none");
      }
      const gateway = await getMcpGatewayForTask(client, mcpAuditOutbox ?? new McpAuditOutbox(config.stateDir));
      mcpSession = gateway.createTaskSession({
        taskId: task.id,
        runtimeId: runtime.id,
        workspaceId: task.workspaceId,
        connections: claimed.connections,
      });
    }

    const managedProfile = await resolveManagedCredentialProfile(runtime, credentialResolver);
    const managedCredentialEnv = managedProfile?.environment ?? {};
    if (bundle.metadata.skillEnvConflicts && bundle.metadata.skillEnvConflicts.length > 0) {
      throw new Error(
        `Skill environment variable conflicts detected: ${bundle.metadata.skillEnvConflicts.join(", ")}. ` +
          "Resolve by using the same value across skills or uninstalling conflicting skills.",
      );
    }
    if (bundle.metadata.skillReadinessBlockers?.length) {
      throw new Error(
        `Skill requirements not satisfied for this task: ${bundle.metadata.skillReadinessBlockers.join("; ")}.`,
      );
    }
    const skillDependencyEnv = buildSkillDependencyTaskEnvironment({
      stateDir: config.stateDir,
      workspaceId: task.workspaceId,
      environments: bundle.metadata.skillDependencyEnvironments ?? [],
      baseEnv: {
        ...process.env,
        ...skillEnvironment.providerEnv,
        ...managedCredentialEnv,
      },
    });
    const managedCredentialId = typeof runtime.metadata.managedCredentialId === "string"
      ? runtime.metadata.managedCredentialId
      : undefined;
    const taskRuntime = managedProfile && credentialResolver
      ? {
          ...runtime,
          metadata: {
            ...runtime.metadata,
            executablePath: credentialResolver.getExecutablePath(runtime.id, runtime.provider),
          },
        }
      : runtime;
    const effectiveModelId = resolveRemoteTaskExecutionModel(bundle);
    let usages: RemoteTaskUsageEntry[] = [];
    let queuedMessageReports = Promise.resolve();
    const reportTaskMessage = (message: ProviderTaskEvent): void => {
      queuedMessageReports = queuedMessageReports
        .then(() => client.reportMessages(task.id, { messages: [message] }))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`Failed to report remote task message for ${task.id}: ${detail}`);
        });
    };
    reportTaskMessage({ type: "status", content: "正在准备执行环境" });
    const gatewayRequestLogPath = join(workDir, ".dofe-gateway-requests.jsonl");
    rmSync(gatewayRequestLogPath, { force: true });

    const result = await runProviderTask(
      taskRuntime,
      bundle.prompt,
      workDir,
      {
        sessionId: bundle.metadata.routerSession?.providerSessionId ?? resolveRemoteTaskProviderSessionId(task.inputJson),
        modelId: effectiveModelId,
        executionPolicy: bundle.metadata.executionPolicy,
        skillEnvKeys: Object.keys(skillEnvironment.providerEnv),
        taskTimeoutMs: config.taskTimeoutMs,
        contextEnv: {
          ...skillEnvironment.providerEnv,
          ...managedCredentialEnv,
          ...skillDependencyEnv,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_AGENT_NAME: readRemoteTaskAgentName(task),
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
          ...(managedCredentialId ? {
            DOFE_AGENT_RUNTIME_CREDENTIAL_ID: managedCredentialId,
            DOFE_AGENT_RUNTIME_ID: runtime.id,
            DOFE_AGENT_ATTRIBUTION_EMPLOYEE_ID: task.agentId,
            DOFE_AGENT_ATTRIBUTION_CONVERSATION_ID: task.routerSessionId ?? task.id,
            DOFE_AGENT_GATEWAY_REQUEST_LOG: "/workspace/.dofe-gateway-requests.jsonl",
            DOFE_AGENT_GATEWAY_PROTOCOL: resolveProviderProtocols(runtime.provider)[0] ?? "",
          } : {}),
        },
        runtimeApps: bundle.metadata.runtimeApps?.apps ?? [],
        runtimeToolCapabilities: [
          ...(bundle.metadata.runtimeToolCapabilities?.capabilities ?? []),
          ...skillRunner.capabilities,
        ],
        mcpGatewayUrl: mcpSession?.url,
        onEvent: (event) => {
          if (event.type === "usage" && event.inputJson) {
            const inputTokens = readFiniteNumber(event.inputJson.input_tokens);
            const outputTokens = readFiniteNumber(event.inputJson.output_tokens);
            if (effectiveModelId && managedCredentialId && (inputTokens > 0 || outputTokens > 0)) {
              usages.push({
                modelId: effectiveModelId,
                runtimeCredentialId: managedCredentialId,
                routerSessionId: task.routerSessionId,
                gatewayRequestId: typeof event.inputJson.gateway_request_id === "string"
                  ? event.inputJson.gateway_request_id.trim() || undefined
                  : undefined,
                inputTokens,
                outputTokens,
              });
            }
          }
          reportTaskMessage(event);
        },
        onApprovalRequest: (request) => waitForRuntimeApproval(client, task.id, request),
      },
    );

    if (effectiveModelId && managedCredentialId) {
      usages = mergeRemoteGatewayUsages(usages, readRemoteGatewayUsages(gatewayRequestLogPath), {
        modelId: effectiveModelId,
        runtimeCredentialId: managedCredentialId,
        routerSessionId: task.routerSessionId,
      });
    }
    rmSync(gatewayRequestLogPath, { force: true });

    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    for (const warning of preparedSkillImports.warnings) {
      reportTaskMessage({ type: "status", content: warning });
    }

    const preparedOutput = prepareRemoteOutputBundle(
      workDir,
      readEmployeeHeadManifestSync(task.workspaceId, task.agentId),
    );
    for (const upload of preparedOutput.uploads) {
      await client.uploadWorkspaceBlob(task.id, upload.sha256, readWorkspaceBlobUploadBytes(upload));
    }
    if (preparedOutput.bundle) {
      await client.uploadOutputBundle(task.id, preparedOutput.bundle);
    }

    await queuedMessageReports;
    await client.completeTask(task.id, {
      outputText: result.output,
      sessionId: result.sessionId,
      workDir,
      usages: usages.length > 0 ? usages : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError;
    await client.failTask(task.id, {
      errorText: message,
      runtimeCredentialId: runtime.metadata.managedCredentialId,
      errorCode: providerError?.code,
      errorCategory: normalizeProviderTaskErrorCategory(providerError?.category),
      provider: providerError?.provider,
      rawProviderMessage: providerError?.rawProviderMessage,
      sessionId: failureMetadata?.sessionId,
      workDir: failureMetadata?.workDir ?? workDir,
    });
  } finally {
    // Revoke the MCP session. Tool audits are now flushed per-call by the
    // gateway's onAudit handler, so a daemon crash loses at most the in-flight
    // call rather than the entire task's audit trail.
    mcpSession?.revoke();
    await skillRunner?.close();
    clearTaskOutputArtifacts(workDir);
    if (!isPersistentConversationWorkspace) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

let sharedMcpGateway: McpGateway | null = null;

async function getMcpGatewayForTask(client: HttpDaemonClient, auditOutbox: McpAuditOutbox): Promise<McpGateway> {
  if (!sharedMcpGateway) {
    const gateway = new McpGateway(
      async (audit) => {
        const report = {
          taskId: audit.taskId,
          connectionId: audit.connectionId,
          toolName: audit.toolName,
          outcome: audit.outcome,
          latencyMs: audit.latencyMs,
          safeSummary: audit.safeSummary,
          eventId: audit.eventId,
        };
        auditOutbox.enqueue(report);
        await auditOutbox.flush(client).then((result) => {
          if (result.failed === 0) return;
          console.error(`MCP audit outbox retained ${result.failed} event(s) for retry.`);
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`MCP audit outbox flush failed for task ${audit.taskId}: ${detail}`);
        });
      },
      undefined,
      async (input) => {
        try {
          const response = await client.validateMcpConnectionForTask(input.taskId, input.connectionId, {
            toolName: input.toolName,
          });
          return response.ok ? { ok: true, approvedTools: response.approvedTools ?? [] } : { ok: false };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`MCP connection validation failed for task ${input.taskId}: ${detail}`);
          return { ok: false };
        }
      },
    );
    await gateway.start();
    sharedMcpGateway = gateway;
  }
  return sharedMcpGateway;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readRemoteGatewayUsages(path: string): RemoteGatewayUsageEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const value = JSON.parse(line) as {
          requestId?: unknown;
          gatewayUsageId?: unknown;
          protocol?: unknown;
          inputTokens?: unknown;
          outputTokens?: unknown;
          cacheTokens?: unknown;
          requestStartedAt?: unknown;
          requestEndedAt?: unknown;
        };
        const requestId = typeof value.requestId === "string" ? value.requestId.trim() : "";
        const inputTokens = readFiniteNumber(value.inputTokens);
        const outputTokens = readFiniteNumber(value.outputTokens);
        const cacheTokens = readFiniteNumber(value.cacheTokens);
        return requestId && (inputTokens > 0 || outputTokens > 0)
          ? [{
              requestId,
              gatewayUsageId: typeof value.gatewayUsageId === "string" ? value.gatewayUsageId : undefined,
              inputTokens,
              outputTokens,
              cacheTokens,
              protocol: typeof value.protocol === "string" ? value.protocol : undefined,
              requestStartedAt: typeof value.requestStartedAt === "string" ? value.requestStartedAt : undefined,
              requestEndedAt: typeof value.requestEndedAt === "string" ? value.requestEndedAt : undefined,
            }]
          : [];
      } catch {
        return [];
      }
    });
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

export function reconcileRemoteRuntimesWithHeartbeat(
  current: RemoteRuntimeRecord[],
  heartbeat: HeartbeatDaemonResponse,
  workspaceId: string,
  deviceName: string,
): RemoteRuntimeRecord[] {
  const currentById = new Map(current.map((runtime) => [runtime.id, runtime]));
  const heartbeatById = new Map(heartbeat.runtimes.map((runtime) => [runtime.id, runtime]));
  const result: RemoteRuntimeRecord[] = [];

  for (const runtime of current) {
    const heartbeatRuntime = heartbeatById.get(runtime.id);
    if (!heartbeatRuntime) {
      continue;
    }
    result.push({
      ...runtime,
      status: heartbeatRuntime.status,
      metadata: {
        ...runtime.metadata,
        ...(heartbeatRuntime.metadata ?? {}),
      },
    });
  }

  for (const heartbeatRuntime of heartbeat.runtimes) {
    if (currentById.has(heartbeatRuntime.id)) {
      continue;
    }
    if (!isDaemonProvider(heartbeatRuntime.provider)) {
      continue;
    }
    const metadata = heartbeatRuntime.metadata ?? {};
    const executablePath = typeof metadata.executablePath === "string" ? metadata.executablePath : "";
    result.push({
      id: heartbeatRuntime.id,
      workspaceId,
      provider: heartbeatRuntime.provider,
      name: typeof metadata.name === "string" ? metadata.name : heartbeatRuntime.id,
      version: typeof metadata.version === "string" ? metadata.version : undefined,
      status: heartbeatRuntime.status,
      deviceInfo: deviceName,
      metadata: {
        executablePath,
        mode: "remote",
        managedCredentialId: typeof metadata.managedCredentialId === "string" ? metadata.managedCredentialId : undefined,
        provisioningState: typeof metadata.provisioningState === "string" ? metadata.provisioningState : undefined,
        ...metadata,
      },
    });
  }

  return result;
}

/**
 * A managed daemon keeps executable profiles only in memory. After it restarts,
 * the control plane still reports its completed managed runtimes in the
 * heartbeat response. Rehydrate their credential profiles before accepting
 * work so that an "online" runtime is actually executable.
 */
export async function restoreManagedRuntimesFromHeartbeat(
  heartbeat: HeartbeatDaemonResponse,
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
  credentialResolver: ManagedCredentialResolver,
): Promise<void> {
  for (const runtime of heartbeat.runtimes) {
    if (!isDaemonProvider(runtime.provider) || managedRuntimes.has(runtime.id)) {
      continue;
    }
    const metadata = runtime.metadata ?? {};
    if (metadata.provisioningState !== "managed" || typeof metadata.managedCredentialId !== "string") {
      continue;
    }
    const profile = await credentialResolver.resolve(runtime.id, metadata.managedCredentialId);
    if (!profile) {
      continue;
    }
    managedRuntimes.set(runtime.id, {
      id: runtime.id,
      provider: runtime.provider,
      runtimeCredentialId: metadata.managedCredentialId,
      executablePath: credentialResolver.getExecutablePath(runtime.id, runtime.provider),
      status: "online",
    });
  }
}

export function buildRemoteRuntimeHeartbeatMetadata(
  runtimes: RemoteRuntimeRecord[],
  managedRuntimes?: Map<string, ManagedRuntimeEntry>,
  verificationEnvironments?: Map<string, Record<string, string>>,
): Array<{
  id: string;
  provider: RemoteRuntimeRecord["provider"];
  metadata: Record<string, unknown>;
}> {
  const records = runtimes.map((runtime) => {
    const managedRuntime = managedRuntimes?.get(runtime.id);
    const heartbeatRuntime = managedRuntime
      ? {
        ...runtime,
        status: managedRuntime.status,
        metadata: {
          ...runtime.metadata,
          executablePath: managedRuntime.executablePath,
          mode: "remote" as const,
          managedCredentialId: managedRuntime.runtimeCredentialId,
          provisioningState: "managed",
        },
      }
      : runtime;
    return {
      id: heartbeatRuntime.id,
      provider: heartbeatRuntime.provider,
      metadata: buildProviderRuntimeMetadata(heartbeatRuntime, {
        environment: verificationEnvironments?.get(runtime.id),
      }),
    };
  });
  const knownRuntimeIds = new Set(records.map((runtime) => runtime.id));
  for (const runtime of managedRuntimes?.values() ?? []) {
    if (knownRuntimeIds.has(runtime.id)) {
      continue;
    }
    records.push({
      id: runtime.id,
      provider: runtime.provider,
      metadata: {
        executablePath: runtime.executablePath,
        mode: "remote",
        managedCredentialId: runtime.runtimeCredentialId,
        provisioningState: "managed",
      },
    });
  }
  return records;
}

export async function resolveManagedProviderVerificationEnvironments(
  runtimes: RemoteRuntimeRecord[],
  credentialResolver: Pick<ManagedCredentialResolver, "resolve">,
): Promise<Map<string, Record<string, string>>> {
  const environments = new Map<string, Record<string, string>>();
  await Promise.all(runtimes.map(async (runtime) => {
    if (
      !runtime.metadata.managedCredentialId
      || (!hasPendingProviderVerification(runtime) && runtime.provider !== "openclaw")
    ) {
      return;
    }
    const profile = await credentialResolver.resolve(runtime.id, runtime.metadata.managedCredentialId);
    if (profile) {
      environments.set(runtime.id, profile.environment);
    }
  }));
  return environments;
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
      content: "等待你的工具审批，任务已暂停。",
    }],
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to report approval wait message for ${taskId}: ${message}`);
  });

  const deadline = Date.now() + RUNTIME_APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
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

  throw new Error("Runtime approval timed out after 15 minutes.");
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
        executablePath: executor.credentialResolver.getExecutablePath(task.runtimeId, task.runtimeType),
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
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
  requests: ManagedRuntimeCleanupRequest[],
): Promise<void> {
  for (const request of requests) {
    console.log(`Managed cleanup: ${request.runtimeId}`);
    try {
      const result = await executor.executeCleanup(request.runtimeId, request.commands);
      if (result.success) {
        await client.completeManagedRuntimeCleanupRequest(request.requestId, {
          result: { success: true, safeStdoutTail: result.safeStdoutTail, safeStderrTail: result.safeStderrTail },
        });
      } else {
        await client.failManagedRuntimeCleanupRequest(request.requestId, {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      }
      if (result.success) {
        managedRuntimes.delete(request.runtimeId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.failManagedRuntimeCleanupRequest(request.requestId, { errorMessage: message });
    }
  }
}

function buildManagedRuntimeHeartbeatMetadata(
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Array<{ id: string; provider: string; status: string; managedCredentialId: string; executablePath: string }> {
  return Array.from(managedRuntimes.values()).map((runtime) => ({
    id: runtime.id,
    provider: runtime.provider,
    status: runtime.status,
    managedCredentialId: runtime.runtimeCredentialId,
    executablePath: runtime.executablePath,
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
