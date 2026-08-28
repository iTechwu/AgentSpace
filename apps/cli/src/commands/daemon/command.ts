// daemon CLI 的daemon 命令分发与子命令编排（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { getStringFlag, parseArgs } from "../../lib/args.ts";
import { writeData } from "../../lib/format.ts";
import type { OutputFormat } from "../../lib/format.ts";
import { createDaemonApiTokenSync, heartbeatDaemonSync, listDaemonApiTokensSync, listDaemonSnapshotsSync, markDaemonOfflineSync, pruneOfflineDaemonsSync, registerDaemonRuntimesSync, revokeDaemonApiTokenSync } from "@dofe-agent/db";
import { isDaemonProvider } from "@dofe-agent/domain";
import type { DaemonProvider } from "@dofe-agent/domain";
import { resolveAgentRuntimeMode } from "@dofe-agent/services/runtime";
import { startFeishuWebSocketWorkerSupervisor } from "@dofe-agent/services/integrations";
import type { FeishuWebSocketWorkerSupervisorHandle } from "@dofe-agent/services/integrations";
import { applyProviderCredentialProfile, buildProviderRuntimeMetadata, resolveProviderCredentialProfile, runRemoteDaemonForeground as runStandaloneRemoteDaemonForeground } from "dofe-agent-daemon";
import type { DetectedProvider as SharedDetectedProvider } from "dofe-agent-daemon";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { arch, version as nodeVersion, platform } from "node:process";
import { DEFAULT_LOG_LINES, DEFAULT_OFFLINE_PRUNE_MS, buildDaemonConfig, detectProviders } from "./config.ts";
import { cleanupStalePidFile, ensureDaemonStateDir, getDaemonLogFilePath, getDaemonPidFilePath, isProcessRunning, readLastLines, readPidIfRunning, renderDaemonSummary, resolveCliEntryPath, resolveRepositoryRoot, sleep } from "./lifecycle.ts";
import { listLocalRuntimeHeartbeatMetadata } from "./runtime.ts";
import { pollQueuedTasks } from "./task-runner.ts";
import type { DaemonConfig } from "./config.ts";

export async function runDaemonCommand(
  subcommand: string | undefined,
  args: string[],
  format: OutputFormat,
): Promise<number> {
  if (subcommand === "start") {
    return await runDaemonStart(args);
  }

  if (subcommand === "stop") {
    return await runDaemonStop();
  }

  if (subcommand === "status") {
    return runDaemonStatus(format);
  }

  if (subcommand === "logs") {
    return await runDaemonLogs(args);
  }

  if (subcommand === "token") {
    return runDaemonTokenCommand(args, format);
  }

  console.error(
    "Usage: dofe-agent daemon start [--foreground] [--workspace-id <id>] [--daemon-id <id>] [--device-name <name>] [--runtime-name <label>] [--heartbeat-interval <ms>] [--task-timeout <ms>]",
  );
  console.error("   or: dofe-agent daemon stop");
  console.error("   or: dofe-agent daemon status [--json]");
  console.error("   or: dofe-agent daemon logs [--lines <n>] [--follow]");
  console.error("   or: dofe-agent daemon token create --label <label> [--created-by <name>] [--json]");
  console.error("   or: dofe-agent daemon token list [--json]");
  console.error("   or: dofe-agent daemon token revoke --id <token-id> [--json]");
  return 1;
}
export async function runDaemonStart(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const foreground = parsed.flags.foreground === true;
  const config = buildDaemonConfig(parsed.flags);

  if (foreground) {
    return await runDaemonForeground(config);
  }

  const stateDir = ensureDaemonStateDir();
  const pidPath = getDaemonPidFilePath();
  const logPath = getDaemonLogFilePath();
  const existingPid = readPidIfRunning(pidPath);
  if (existingPid) {
    console.error(`Daemon is already running (pid ${existingPid}).`);
    return 1;
  }

  pruneOfflineDaemonsSync(DEFAULT_OFFLINE_PRUNE_MS);

  const logFd = openSync(logPath, "a");
  const entryPath = resolveCliEntryPath();
  const childArgs = [
    "--experimental-strip-types",
    entryPath,
    "daemon",
    "start",
    "--foreground",
    "--mode",
    config.mode,
    "--daemon-id",
    config.daemonKey,
    "--device-name",
    config.deviceName,
    "--runtime-name",
    config.runtimeName,
    "--heartbeat-interval",
    String(config.heartbeatIntervalMs),
    "--task-timeout",
    String(config.taskTimeoutMs),
  ];
  if (config.workspaceId) {
    childArgs.push("--workspace-id", config.workspaceId);
  }
  if (config.serverUrl) {
    childArgs.push("--server-url", config.serverUrl);
  }
  if (config.daemonToken) {
    childArgs.push("--daemon-token", config.daemonToken);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: resolveRepositoryRoot(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  if (!child.pid) {
    console.error("Failed to start daemon process.");
    return 1;
  }
  writeFileSync(pidPath, `${child.pid}\n`, "utf8");

  await sleep(750);
  if (!isProcessRunning(child.pid)) {
    rmSync(pidPath, { force: true });
    console.error("Daemon process exited immediately. Check logs:");
    console.error(`  ${logPath}`);
    return 1;
  }

  console.log(`Daemon started (pid ${child.pid}).`);
  console.log(`State: ${stateDir}`);
  console.log(`Logs: ${logPath}`);
  return 0;
}
export async function runDaemonForeground(config: DaemonConfig): Promise<number> {
  if (config.mode === "remote") {
    return runRemoteDaemonForeground(config);
  }
  return runLocalDaemonForeground(config);
}
export async function runLocalDaemonForeground(config: DaemonConfig): Promise<number> {
  try {
    const credentialProfile = resolveProviderCredentialProfile({ stateDir: ensureDaemonStateDir() });
    if (credentialProfile) {
      applyProviderCredentialProfile(credentialProfile);
      console.log(`Provider credential profile ready: ${credentialProfile.accountId}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Provider credential profile setup failed: ${message}`);
    return 1;
  }

  const pidPath = getDaemonPidFilePath();
  writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  process.env.DOFE_AGENT_TASK_TIMEOUT_MS = String(config.taskTimeoutMs);

  const detected = detectProviders();
  if (detected.length === 0) {
    rmSync(pidPath, { force: true });
    console.error(
      "No supported provider CLI found. Install `codex`, `claude`, `agy`, `gemini`, `opencode`, `openclaw`, `nanobot`, or `hermes` and ensure it is on PATH.",
    );
    return 1;
  }

  const requiredProviders = resolveRequiredLocalProviders();
  const missingProviders = requiredProviders.filter(
    (provider) => !detected.some((candidate) => candidate.provider === provider),
  );
  if (missingProviders.length > 0) {
    rmSync(pidPath, { force: true });
    console.error(
      `Required local runtime provider(s) unavailable: ${missingProviders.join(", ")}. `
      + "Install the provider CLI and ensure it is on PATH.",
    );
    return 1;
  }

  const registerLocalRuntimes = () => registerLocalDaemonRuntimes(config, detected);
  const snapshot = registerLocalRuntimes();

  console.log(`Daemon online: ${snapshot.daemon.daemonKey}`);
  console.log(`Providers: ${snapshot.runtimes.map((runtime) => runtime.provider).join(", ")}`);

  let feishuWorker: FeishuWebSocketWorkerSupervisorHandle | undefined;
  if (config.manageFeishuWorker) {
    try {
      feishuWorker = await startManagedFeishuWorker({
        workspaceId: config.workspaceId,
        daemonKey: config.daemonKey,
      });
      if (feishuWorker) {
        console.log(
          `Feishu worker managed: ${feishuWorker.summary.startedCount}/${feishuWorker.summary.integrationCount} active binding(s).`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Feishu worker startup failed: ${message}`);
    }
  }

  const heartbeatTimer = setInterval(() => {
    try {
      heartbeatDaemonSync(config.daemonKey, {
        metadata: buildLocalDaemonMetadata(config),
        runtimes: listLocalRuntimeHeartbeatMetadata(config.daemonKey),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingDaemonRegistrationError(error, config.daemonKey)) {
        try {
          registerLocalRuntimes();
          console.log(`Daemon re-registered: ${config.daemonKey}`);
          return;
        } catch (recoveryError) {
          const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          console.error(`Daemon re-registration failed: ${recoveryMessage}`);
          return;
        }
      }
      console.error(`Heartbeat failed: ${message}`);
    }
  }, config.heartbeatIntervalMs);

  const activeRuntimes = new Set<string>();
  let polling = false;
  const taskPollTimer = setInterval(() => {
    if (polling) {
      return;
    }
    polling = true;

    void pollQueuedTasks(config, activeRuntimes)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Task polling failed: ${message}`);
      })
      .finally(() => {
        polling = false;
      });
  }, config.taskPollIntervalMs);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(heartbeatTimer);
    clearInterval(taskPollTimer);
    feishuWorker?.close();
    rmSync(pidPath, { force: true });

    try {
      markDaemonOfflineSync(config.daemonKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to mark daemon offline: ${message}`);
    }

    console.log(`Daemon stopped (${signal}).`);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>(() => {
    // Keep the foreground daemon alive until it receives a signal.
  });
  return 0;
}
export async function startManagedFeishuWorker(input: {
  workspaceId?: string;
  daemonKey: string;
  startWorker?: typeof startFeishuWebSocketWorkerSupervisor;
}): Promise<FeishuWebSocketWorkerSupervisorHandle | undefined> {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) {
    return undefined;
  }
  const startWorker = input.startWorker ?? startFeishuWebSocketWorkerSupervisor;
  return startWorker({
    workspaceId,
    lockedBy: `daemon:${input.daemonKey}:feishu-worker`,
  });
}
export function buildLocalDaemonMetadata(config: DaemonConfig): Record<string, unknown> {
  return {
    mode: "local",
    pid: String(process.pid),
    runtimeName: config.runtimeName,
    nodeVersion,
    platform,
    arch,
  };
}
export function registerLocalDaemonRuntimes(
  config: DaemonConfig,
  detected: SharedDetectedProvider[],
) {
  return registerDaemonRuntimesSync({
    daemonKey: config.daemonKey,
    deviceName: config.deviceName,
    workspaceId: config.workspaceId,
    metadata: buildLocalDaemonMetadata(config),
    runtimes: detected.map((provider) => ({
      provider: provider.provider,
      providerAccountId: process.env.DOFE_AGENT_PROVIDER_ACCOUNT_ID?.trim() || undefined,
      name: `${config.runtimeName} · ${provider.label}`,
      version: provider.version,
      deviceInfo: config.deviceName,
      metadata: buildProviderRuntimeMetadata({
        provider: provider.provider,
        metadata: {
          executablePath: provider.executablePath,
          mode: "local",
        },
      }),
    })),
  });
}
export function isMissingDaemonRegistrationError(error: unknown, daemonKey: string): boolean {
  return error instanceof Error && error.message === `Daemon "${daemonKey}" does not exist.`;
}
export function resolveRequiredLocalProviders(): DaemonProvider[] {
  const configured = process.env.DOFE_AGENT_REQUIRED_RUNTIME_PROVIDERS?.trim();
  if (!configured) {
    return [];
  }

  return [...new Set(
    configured
      .split(",")
      .map((provider) => provider.trim())
      .filter(isDaemonProvider),
  )];
}
export async function runRemoteDaemonForeground(config: DaemonConfig): Promise<number> {
  return runStandaloneRemoteDaemonForeground({
    stateDir: ensureDaemonStateDir(),
    daemonKey: config.daemonKey,
    deviceName: config.deviceName,
    runtimeName: config.runtimeName,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    taskPollIntervalMs: config.taskPollIntervalMs,
    operationClaimIntervalMs: config.operationClaimIntervalMs,
    taskTimeoutMs: config.taskTimeoutMs,
    serverUrl: config.serverUrl,
    daemonToken: config.daemonToken,
    managedNode: false,
    codexMcpExperimentalEnabled: process.env.MCP_CODEX_EXPERIMENTAL_ENABLED === "1",
  });
}
export async function runDaemonStop(): Promise<number> {
  const pidPath = getDaemonPidFilePath();
  const pid = readPidIfRunning(pidPath);

  if (!pid) {
    cleanupStalePidFile(pidPath);
    const snapshots = listDaemonSnapshotsSync().filter((snapshot) => snapshot.daemon.status === "online");
    for (const snapshot of snapshots) {
      markDaemonOfflineSync(snapshot.daemon.daemonKey, { lastError: "Stopped without active PID." });
    }
    if (snapshots.length > 0) {
      console.log(`Marked ${snapshots.length} daemon registration(s) offline.`);
      return 0;
    }
    console.error("Daemon is not running.");
    return 1;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      rmSync(pidPath, { force: true });
      console.log(`Daemon stopped (pid ${pid}).`);
      return 0;
    }
    await sleep(100);
  }

  console.error(`Timed out waiting for daemon ${pid} to stop.`);
  return 1;
}
export function runDaemonStatus(format: OutputFormat): number {
  const pidPath = getDaemonPidFilePath();
  const pid = readPidIfRunning(pidPath);
  const snapshots = listDaemonSnapshotsSync();

  const summary = {
    running: Boolean(pid),
    pid: pid ?? "",
    pidFile: pidPath,
    logFile: getDaemonLogFilePath(),
    daemons: snapshots.length,
    onlineDaemons: snapshots.filter((snapshot) => snapshot.daemon.status === "online").length,
    runtimes: snapshots.reduce((sum, snapshot) => sum + snapshot.runtimes.length, 0),
  };

  if (format === "json") {
    writeData(format, {
      summary,
      daemons: snapshots.map((snapshot) => ({
        daemon: snapshot.daemon,
        runtimes: snapshot.runtimes,
      })),
    });
    return 0;
  }

  console.log(renderDaemonSummary(summary));
  if (snapshots.length === 0) {
    console.log("\nNo daemon registrations found.");
    return 0;
  }

  const rows = snapshots.flatMap((snapshot) =>
    snapshot.runtimes.map((runtime) => ({
      daemon: snapshot.daemon.daemonKey,
      device: snapshot.daemon.deviceName,
      daemonStatus: snapshot.daemon.status,
      provider: runtime.provider,
      runtime: runtime.name,
      runtimeStatus: runtime.status,
      version: runtime.version || "-",
      heartbeat: runtime.lastHeartbeatAt ?? snapshot.daemon.lastHeartbeatAt ?? "-",
    })),
  );
  console.log("");
  writeData("text", rows);
  return 0;
}
export async function runDaemonLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const follow = parsed.flags.follow === true;
  const linesRaw = getStringFlag(parsed.flags, "lines");
  const lines = linesRaw ? Number(linesRaw) : DEFAULT_LOG_LINES;
  const logPath = getDaemonLogFilePath();

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
export function runDaemonTokenCommand(args: string[], format: OutputFormat): number {
  const parsed = parseArgs(args);
  const action = parsed.positionals[0];

  if (action === "create") {
    if (resolveAgentRuntimeMode() === "remote") {
      console.error("Daemon token creation is unavailable in remote mode. Managed runtime nodes are provisioned by the service.");
      return 1;
    }
    const label = getStringFlag(parsed.flags, "label")?.trim() ?? "";
    const createdBy = getStringFlag(parsed.flags, "created-by")?.trim() ?? "system";
    if (!label) {
      console.error("Usage: dofe-agent daemon token create --label <label> [--created-by <name>] [--json]");
      return 1;
    }

    const created = createDaemonApiTokenSync({
      label,
      createdBy,
    });
    writeData(format, created);
    return 0;
  }

  if (action === "list") {
    writeData(format, listDaemonApiTokensSync().map((token) => ({
      id: token.id,
      workspaceId: token.workspaceId,
      label: token.label,
      status: token.status,
      createdBy: token.createdBy,
      lastUsedAt: token.lastUsedAt ?? "",
      createdAt: token.createdAt,
      revokedAt: token.revokedAt ?? "",
    })));
    return 0;
  }

  if (action === "revoke") {
    const id = getStringFlag(parsed.flags, "id")?.trim() ?? "";
    if (!id) {
      console.error("Usage: dofe-agent daemon token revoke --id <token-id> [--json]");
      return 1;
    }

    writeData(format, revokeDaemonApiTokenSync(id));
    return 0;
  }

  console.error(
    "Usage: dofe-agent daemon token create --label <label> [--created-by <name>] [--json]\n"
      + "       dofe-agent daemon token list [--json]\n"
      + "       dofe-agent daemon token revoke --id <token-id> [--json]",
  );
  return 1;
}
