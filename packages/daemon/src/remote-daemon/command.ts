// 3.5-4：自 remote-daemon.ts 拆出——CLI 子命令（start/stop/status/logs）、
// 配置解析入口与前台守护主循环（注册、心跳、轮询、关停）。
import { createReadStream, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { getStringFlag, parseArgs } from "../args.ts";
import type { RegisterDaemonResponse } from "../daemon-api.ts";
import { DaemonAuthError, HttpDaemonClient } from "../daemon-client.ts";
import {
  buildProviderRuntimeMetadata,
  detectProviders,
  readNodeMetadata,
  type RemoteRuntimeRecord,
} from "../provider-runtime.ts";
import {
  cleanupStalePidFile,
  DEFAULT_LOG_LINES,
  getDaemonLogFilePath,
  getDaemonPidFilePath,
  getStandaloneCliEntryPath,
  openDaemonLogFile,
  readLastLines,
  readPidIfRunning,
  renderDaemonSummary,
} from "../state.ts";
import type { CliHubReadiness } from "../runtime-apps.ts";
import { McpAuditOutbox } from "../mcp/audit-outbox.ts";
import {
  applyProviderCredentialProfile,
  resolveProviderCredentialProfile,
} from "../provider-credentials.ts";
import { createManagedCredentialResolver } from "../managed-provider-credentials.ts";
import { createManagedProvisioningExecutor } from "../managed-runtime-provisioning.ts";
import { buildRemoteDaemonConfig, printRemoteDaemonHelp, type RemoteDaemonConfig } from "./config.ts";
import { createRemoteRuntimeActivity } from "./activity.ts";
import { classifyRemoteLoopError } from "./errors.ts";
import {
  buildManagedRuntimeHeartbeatMetadata,
  buildRemoteRuntimeHeartbeatMetadata,
  buildRemoteRuntimeRecords,
  hasPendingProviderVerification,
  reconcileRemoteRuntimesWithHeartbeat,
  resolveManagedProviderVerificationEnvironments,
  resolveRemoteRuntimeCliHubReadiness,
  restoreManagedRuntimesFromHeartbeat,
  type ManagedRuntimeEntry,
} from "./heartbeat.ts";
import { executeManagedCleanupRequests, pollManagedProvisioningTasks } from "./operations.ts";
import { pollRemoteTasks } from "./poll.ts";
import { sleep } from "./internal.ts";

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

  const runtimeActivity = createRemoteRuntimeActivity();
  let runtimeCliHubReadiness = new Map<string, CliHubReadiness>();
  let runtimeCliHubReadinessExpiresAt = 0;
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
  let heartbeatInFlight = false;
  const runHeartbeat = (): void => {
    if (heartbeatInFlight) {
      return;
    }
    heartbeatInFlight = true;
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
        const readinessRuntimeIds = new Set([
          ...runtimes.map((runtime) => runtime.id),
          ...managedRuntimes.keys(),
        ]);
        if (
          Date.now() >= runtimeCliHubReadinessExpiresAt
          || runtimeCliHubReadiness.size !== readinessRuntimeIds.size
          || [...readinessRuntimeIds].some((runtimeId) => !runtimeCliHubReadiness.has(runtimeId))
        ) {
          runtimeCliHubReadiness = resolveRemoteRuntimeCliHubReadiness(config, runtimes, managedRuntimes);
          runtimeCliHubReadinessExpiresAt = Date.now() + 60_000;
        }
        const heartbeat = await client.sendHeartbeatWithMetadata(
          config.daemonKey,
          { ...metadata, managedRuntimes: managedRuntimeMetadata },
          buildRemoteRuntimeHeartbeatMetadata(runtimes, managedRuntimes, verificationEnvironments, runtimeCliHubReadiness),
        );
        runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, heartbeat, registered.daemon.workspaceId, config.deviceName);
        await restoreManagedRuntimesFromHeartbeat(heartbeat, managedRuntimes, credentialResolver);
        if (runtimes.some(hasPendingProviderVerification)) {
          const verificationEnvironments = await resolveManagedProviderVerificationEnvironments(runtimes, credentialResolver);
          const verificationHeartbeat = await client.sendHeartbeatWithMetadata(
            config.daemonKey,
            metadata,
            buildRemoteRuntimeHeartbeatMetadata(runtimes, managedRuntimes, verificationEnvironments, runtimeCliHubReadiness),
          );
          runtimes = reconcileRemoteRuntimesWithHeartbeat(runtimes, verificationHeartbeat, registered.daemon.workspaceId, config.deviceName);
        }
        await executeManagedCleanupRequests(client, provisioningExecutor, managedRuntimes, heartbeat.managedRuntimeCleanupRequests);
      } catch (error) {
        if (classifyRemoteLoopError(error) === "shutdown") {
          fatalShutdown(DAEMON_AUTH_REJECTED_MESSAGE);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Heartbeat failed: ${message}`);
      } finally {
        heartbeatInFlight = false;
      }
    })();
  };
  runHeartbeat();
  const heartbeatTimer = setInterval(runHeartbeat, config.heartbeatIntervalMs);

  let polling = false;
  const taskPollTimer = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;
    void pollRemoteTasks(client, config, runtimes, runtimeActivity, credentialResolver, mcpAuditOutbox)
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
    "--operation-claim-interval",
    String(config.operationClaimIntervalMs),
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
    return summary.running ? 0 : 1;
  }

  console.log(renderDaemonSummary(summary));
  return summary.running ? 0 : 1;
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

