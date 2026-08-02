import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform, version as nodeVersion } from "node:process";
import {
  detectProviders as detectSharedProviders,
  collectRuntimeOutputBundle,
  collectWorkDirChanges,
  readEmployeeHeadManifestSync,
  applyDocumentRuntimeOutputOperations,
  applyKnowledgeProposalOperations,
  buildDocumentRuntimeToolCapabilities,
  normalizeProviderTaskErrorCategory,
  buildProviderRuntimeMetadata,
  applyProviderCredentialProfile,
  readProviderTaskFailureMetadata,
  resolveProviderCredentialProfile,
  resolveModelId as resolveSharedModelId,
  runProviderTask as runSharedProviderTask,
  runRemoteDaemonForeground as runStandaloneRemoteDaemonForeground,
  type DetectedProvider as SharedDetectedProvider,
  type ProviderRuntimeRecord,
} from "dofe-agent-daemon";
import {
  appendTaskMessageSync,
  assertEmployeeBindingGenerationSync,
  chooseProviderSessionForTaskSync,
  claimNextQueuedTaskForRuntimeSync,
  completeCommittedTaskSync,
  createDaemonApiTokenSync,
  failQueuedTaskSync,
  markTaskCommittedSync,
  markTaskPreparingCommitSync,
  upsertTaskCommitJournalSync,
  getDaemonChannelWorkDirPath,
  getDaemonRemoteTaskWorkDirPath,
  getDaemonTaskWorkDirPath,
  getLocalDaemonStateDirPath,
  heartbeatDaemonSync,
  listDaemonApiTokensSync,
  listDaemonSnapshotsSync,
  listAgentRouterEventsSync,
  listAgentTaskAttemptsSync,
  markDaemonOfflineSync,
  pruneOfflineDaemonsSync,
  readAgentRouterSessionForTaskSync,
  readDaemonSnapshotSync,
  readLatestAgentRouterContextSnapshotSync,
  registerDaemonRuntimesSync,
  revokeDaemonApiTokenSync,
  startQueuedTaskSync,
  recordTokenUsageSync,
  type AgentRuntimeRecord,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import {
  buildContactAgentContext,
  checkAllBudgetsForAgentSync,
  completeAgentChannelReplySync,
  completeChannelDocumentRunStepSync,
  deleteWorkspaceAttachmentsSync,
  promoteTaskOutputsToWorkspaceSync,
  readWorkspaceAttachmentBytesSync,
  AgentDocumentPermissionError,
  failChannelDocumentRunStepSync,
  formatConversationFailureSummary,
  formatTaskFailureSummary,
  markChannelDocumentRunStepRunningSync,
  persistWorkspaceAttachmentFromFileSync,
  postMessageSync,
  queueFeishuAgentStatusCardOutboxSync,
  queueFeishuChannelReplyOutboxSync,
  readWorkspaceStateSync,
  replacePendingChannelMessageSync,
  resolveAgentDocumentContextSync,
  resolveAgentRuntimeMode,
  resolveEffectiveModelForTaskAsync,
  startFeishuWebSocketWorkerSupervisor,
  resolveCompatibleDirectChannelRecord,
  listFeishuLarkCliResourceGrantsForChannelSync,
  applyFeishuLarkCliResultManifestOperations,
  applyFeishuRuntimeDataOperationRequests,
  writeConversationExecutionWorkspaceStateSync,
  upsertDirectConversationStateSync,
  updateTaskStatusSync,
  writeWorkspaceStateSync,
  type FeishuAgentStatusCardStatus,
  type FeishuWebSocketWorkerSupervisorHandle,
} from "@dofe-agent/services";
import type { ActiveEmployee, MessageAttachment } from "@dofe-agent/domain/workspace";
import type { DaemonTaskInputBundle, RuntimeToolCapability } from "@dofe-agent/domain";
import { getStringFlag, parseArgs } from "../lib/args.ts";
import { writeData, type OutputFormat } from "../lib/format.ts";
import { HttpDaemonClient } from "../lib/daemon-client.ts";
import {
  applyChannelDocumentOperations,
} from "../lib/channel-documents.ts";
import {
  parseTaskPayload,
  prepareDaemonTaskContext,
} from "../lib/daemon-task-context.ts";
import {
  clearTaskOutputArtifacts,
  loadTaskOutputEnvelope,
} from "../lib/daemon-task-output.ts";
import { applySkillImportOperations, prepareSkillImportOperationArtifacts } from "../lib/skill-imports.ts";

export { buildTaskPrompt } from "../lib/daemon-task-context.ts";
export { clearTaskOutputArtifacts, loadTaskOutputEnvelope } from "../lib/daemon-task-output.ts";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 3_000;
const DEFAULT_OFFLINE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LOG_LINES = 50;
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

async function runDaemonStart(args: string[]): Promise<number> {
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

async function runDaemonForeground(config: DaemonConfig): Promise<number> {
  if (config.mode === "remote") {
    return runRemoteDaemonForeground(config);
  }
  return runLocalDaemonForeground(config);
}

async function runLocalDaemonForeground(config: DaemonConfig): Promise<number> {
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

function buildLocalDaemonMetadata(config: DaemonConfig): Record<string, unknown> {
  return {
    mode: "local",
    pid: String(process.pid),
    runtimeName: config.runtimeName,
    nodeVersion,
    platform,
    arch,
  };
}

function registerLocalDaemonRuntimes(
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

async function runRemoteDaemonForeground(config: DaemonConfig): Promise<number> {
  return runStandaloneRemoteDaemonForeground({
    stateDir: ensureDaemonStateDir(),
    daemonKey: config.daemonKey,
    deviceName: config.deviceName,
    runtimeName: config.runtimeName,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    taskPollIntervalMs: config.taskPollIntervalMs,
    taskTimeoutMs: config.taskTimeoutMs,
    serverUrl: config.serverUrl,
    daemonToken: config.daemonToken,
    managedNode: false,
  });
}

async function runDaemonStop(): Promise<number> {
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

function runDaemonStatus(format: OutputFormat): number {
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

async function runDaemonLogs(args: string[]): Promise<number> {
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

function runDaemonTokenCommand(args: string[], format: OutputFormat): number {
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

interface DaemonConfig {
  mode: "local" | "remote";
  daemonKey: string;
  deviceName: string;
  runtimeName: string;
  workspaceId?: string;
  heartbeatIntervalMs: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
  manageFeishuWorker: boolean;
  serverUrl?: string;
  daemonToken?: string;
}

type DetectedProvider = SharedDetectedProvider;

export function buildDaemonConfig(flags: Record<string, string | boolean>): DaemonConfig {
  const hostname = process.env.HOSTNAME || process.env.COMPUTERNAME || "local-machine";
  const mode = getStringFlag(flags, "mode")?.trim() === "remote" ? "remote" : "local";
  return {
    mode,
    daemonKey: getStringFlag(flags, "daemon-id")?.trim() || hostname,
    deviceName: getStringFlag(flags, "device-name")?.trim() || hostname,
    runtimeName: getStringFlag(flags, "runtime-name")?.trim() || "Local Agent",
    workspaceId: getStringFlag(flags, "workspace-id")?.trim() || process.env.DOFE_AGENT_WORKSPACE_ID?.trim() || undefined,
    heartbeatIntervalMs: Math.max(
      1_000,
      Number(getStringFlag(flags, "heartbeat-interval") ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    ),
    taskPollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS,
    taskTimeoutMs: Math.max(
      1_000,
      Number(
        getStringFlag(flags, "task-timeout")
          ?? process.env.DOFE_AGENT_TASK_TIMEOUT_MS
          ?? 12 * 60 * 60 * 1000,
      ),
    ),
    manageFeishuWorker: process.env.DOFE_AGENT_MANAGE_FEISHU_WORKER !== "0"
      && process.env.DOFE_AGENT_MANAGE_FEISHU_WORKER !== "false",
    serverUrl: getStringFlag(flags, "server-url")?.trim(),
    daemonToken: getStringFlag(flags, "daemon-token")?.trim(),
  };
}

function detectProviders(): DetectedProvider[] {
  return detectSharedProviders();
}

function ensureDaemonStateDir(): string {
  return getLocalDaemonStateDirPath();
}

function getDaemonPidFilePath(): string {
  return join(ensureDaemonStateDir(), "daemon.pid");
}

function getDaemonLogFilePath(): string {
  return join(ensureDaemonStateDir(), "daemon.log");
}

function readPidIfRunning(pidPath: string): number | null {
  if (!existsSync(pidPath)) {
    return null;
  }

  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  return isProcessRunning(pid) ? pid : null;
}

function cleanupStalePidFile(pidPath: string): void {
  if (!existsSync(pidPath)) {
    return;
  }
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessRunning(pid)) {
    rmSync(pidPath, { force: true });
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLastLines(filePath: string, lines: number): string[] {
  const content = readFileSync(filePath, "utf8");
  const chunks = content.split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ""));
  return chunks.slice(-lines);
}

function renderDaemonSummary(summary: Record<string, string | number | boolean>): string {
  return Object.entries(summary)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

function resolveCliEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  return join(dirname(currentFile), "..", "index.ts");
}

function resolveRepositoryRoot(): string {
  let currentDir = process.cwd();

  while (true) {
    if (existsSync(join(currentDir, "Target.md"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }

    currentDir = parentDir;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollQueuedTasks(config: DaemonConfig, activeRuntimes: Set<string>): Promise<void> {
  const snapshot = readDaemonSnapshotSync(config.daemonKey);
  for (const runtime of snapshot.runtimes) {
    if (runtime.status !== "online" || activeRuntimes.has(runtime.id)) {
      continue;
    }

    const queuedTask = claimNextQueuedTaskForRuntimeSync(runtime.id, runtime.workspaceId);
    if (!queuedTask) {
      continue;
    }

    activeRuntimes.add(runtime.id);
    void executeQueuedTask(runtime, queuedTask)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Task ${queuedTask.id} crashed: ${message}`);
      })
      .finally(() => {
        activeRuntimes.delete(runtime.id);
      });
  }
}

async function pollRemoteTasks(
  client: HttpDaemonClient,
  runtimes: AgentRuntimeRecord[],
  activeRuntimes: Set<string>,
): Promise<void> {
  for (const runtime of runtimes) {
    if (activeRuntimes.has(runtime.id)) {
      continue;
    }

    const claimed = await client.claimTask(runtime.id);
    if (!claimed.task) {
      continue;
    }

    activeRuntimes.add(runtime.id);
    void executeRemoteQueuedTask(client, runtime, toQueuedTaskRecord(claimed.task))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Remote task ${claimed.task?.id ?? "unknown"} crashed: ${message}`);
      })
      .finally(() => {
        activeRuntimes.delete(runtime.id);
      });
  }
}

interface TokenAccumulator {
  inputTokens: number;
  outputTokens: number;
  modelId?: string;
  gatewayRequestId?: string;
}

function enqueueFeishuReplyOutboxBestEffort(input: {
  workspaceId: string;
  channelName: string;
  agentId?: string;
  text: string;
  attachments?: MessageAttachment[];
  dofeAgentMessageId?: string;
  sourceDofeAgentMessageId?: string;
  statusCard?: {
    status: FeishuAgentStatusCardStatus;
    agentNames: string[];
    message?: string;
    taskId?: string;
  };
}): string[] {
  try {
    const statusCardItems = input.statusCard
      ? queueFeishuAgentStatusCardOutboxSync({
          workspaceId: input.workspaceId,
          channelName: input.channelName,
          agentId: input.agentId,
          status: input.statusCard.status,
          agentNames: input.statusCard.agentNames,
          message: input.statusCard.message,
          taskId: input.statusCard.taskId,
          dofeAgentMessageId: input.dofeAgentMessageId,
          sourceDofeAgentMessageId: input.sourceDofeAgentMessageId,
        })
      : [];
    const replyOutboxItems = queueFeishuChannelReplyOutboxSync(input);
    const queuedCount = statusCardItems.length + replyOutboxItems.length;
    return queuedCount > 0
      ? [`Feishu outbound queued: ${queuedCount} message(s).`]
      : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Feishu outbound enqueue failed: ${message}`];
  }
}

interface ProviderTaskEvent {
  type: string;
  content?: string;
  tool?: string;
  inputJson?: Record<string, unknown>;
  output?: string;
}

interface ProviderTaskOptions {
  sessionId?: string;
  modelId?: string;
  contextEnv?: Record<string, string>;
  /** Keys in `contextEnv` injected from per-employee Skill configuration; always redacted from logs. */
  skillEnvKeys?: string[];
  taskTimeoutMs?: number;
  runtimeToolCapabilities?: RuntimeToolCapability[];
  onEvent?: (event: ProviderTaskEvent) => void;
}

async function executeRemoteQueuedTask(
  client: HttpDaemonClient,
  runtime: AgentRuntimeRecord,
  task: QueuedTaskRecord,
): Promise<void> {
  const payload = parseTaskPayload(task);
  const channelThreadId = resolveConversationThreadId({
    triggerType: task.triggerType,
    payload,
  });
  const workDir = channelThreadId
    ? getDaemonChannelWorkDirPath(ensureDaemonStateDir(), {
      workspaceId: task.workspaceId,
      threadId: channelThreadId,
      agentId: task.agentId,
    })
    : getWorkspaceRemoteTaskWorkDir(task.workspaceId, task.id);
  const isPersistentConversationWorkspace = Boolean(channelThreadId);
  if (!isPersistentConversationWorkspace) {
    rmSync(workDir, { recursive: true, force: true });
  }
  mkdirSync(workDir, { recursive: true });

  try {
    await client.startTask(task.id);
    const bundle = await client.getInputBundle(task.id);
    if (bundle.metadata.skillEnvConflicts && bundle.metadata.skillEnvConflicts.length > 0) {
      throw new Error(
        `Skill environment variable conflicts detected: ${bundle.metadata.skillEnvConflicts.join(", ")}. ` +
          "Resolve by using the same value across skills or uninstalling conflicting skills.",
      );
    }
    materializeInputBundle(workDir, bundle);

    const result = await runProviderTask(
      runtime,
      bundle.prompt,
      workDir,
      {
        sessionId: (bundle.metadata.routerSession?.providerSessionId ?? payload.channelSessionId?.trim()) || undefined,
        contextEnv: {
          ...bundle.metadata.skillEnv,
          DOFE_AGENT_CONTEXT_AGENT_NAME: payload.assignee ?? task.agentId,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
        },
        runtimeToolCapabilities: bundle.metadata.runtimeToolCapabilities?.capabilities ?? [],
        onEvent: (event) => {
          void client.reportMessages(task.id, {
            messages: [
              {
                type: event.type,
              content: event.content,
              tool: event.tool,
              inputJson: event.inputJson,
              output: event.output,
            },
          ],
            }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Failed to report remote task message for ${task.id}: ${message}`);
            });
        },
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
    const providerError = failureMetadata?.providerError ?? (
      error instanceof AgentDocumentPermissionError
        ? {
            provider: runtime.provider,
            code: error.code,
            category: "provider" as const,
            message,
            rawProviderMessage: error.message,
          }
        : undefined
    );
    await client.failTask(task.id, {
      errorText: message,
      runtimeCredentialId: runtime.managedCredentialId,
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

async function executeQueuedTask(runtime: AgentRuntimeRecord, queuedTask: QueuedTaskRecord): Promise<void> {
  const task = startQueuedTaskSync(queuedTask.id);
  writeWorkspaceStateSync(markChannelDocumentRunStepRunningSync(task.id, task.workspaceId), task.workspaceId);
  const payload = parseTaskPayload(task);

  const budgetCheck = checkAllBudgetsForAgentSync(
    payload.assignee ?? task.agentId,
    payload.channelName ?? payload.channel,
    task.workspaceId,
  );
  if (budgetCheck.status === "exceeded" && budgetCheck.action === "pause") {
    const pct = Math.round(budgetCheck.percentUsed * 100);
    const msg = `Budget exceeded (${pct}% of $${budgetCheck.budget.limitUsd.toFixed(2)}). Task paused.`;
    appendTaskMessageSync({ taskId: task.id, type: "status", content: msg });
    failQueuedTaskSync({ taskId: task.id, errorText: msg });
    if (payload.taskId) updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    return;
  }
  const workspaceState = readWorkspaceStateSync(task.workspaceId);
  const agentProfile = workspaceState.activeEmployees.find((employee: ActiveEmployee) =>
    sameValue(employee.name, payload.assignee ?? task.agentId),
  );
  const compatibleDirectChannelName =
    payload.contactId && !payload.channelName
      ? resolveCompatibleDirectChannelRecord(workspaceState, payload.contactId)?.name
      : undefined;
  const effectiveChannelName = payload.channelName ?? compatibleDirectChannelName;
  const effectivePayload =
    effectiveChannelName && payload.contactId && !payload.channelName
      ? {
          ...payload,
          channelName: effectiveChannelName,
          channelMessage: payload.channelMessage,
        }
      : payload;
  const contactContext =
    payload.contactId ? buildContactAgentContext(workspaceState, payload.contactId) : undefined;
  const channelThreadId =
    resolveConversationThreadId({
      triggerType: task.triggerType,
      payload: {
        channel: payload.channel,
        channelName: effectiveChannelName,
        contactId: payload.contactId,
      },
    });
  appendTaskMessageSync({
    taskId: task.id,
    type: "status",
    content: `Task started on ${runtime.name}.`,
  });

  if (payload.taskId) {
    updateTaskStatusSync(payload.taskId, "in_progress", task.workspaceId);
  }

  const workDir = resolveWorkspaceTaskWorkDir({
    workspaceId: task.workspaceId,
    taskId: task.id,
    agentId: task.agentId,
    channelThreadId,
  });
  mkdirSync(workDir, { recursive: true });
  const agentName = effectivePayload.assignee ?? task.agentId;
  // EAD-005 write-lease gate: validate the claim-time binding generation before
  // any side effect (task context build, document/skill/feishu operations,
  // output promotion). A stale runtime must not commit after a rebind.
  if (typeof task.bindingGeneration !== "number") {
    throw new Error("Task has no claim-time binding generation; refusing to run.");
  }
  assertEmployeeBindingGenerationSync(agentName, task.bindingGeneration, task.workspaceId);
  const agentDocumentContexts = resolveAgentDocumentContextSync({
    workspaceId: task.workspaceId,
    agentName,
    channelName: effectiveChannelName,
  });
  const feishuLarkCliResourceGrants = listFeishuLarkCliResourceGrantsForChannelSync({
    workspaceId: task.workspaceId,
    channelName: effectiveChannelName,
  });
  const routerSessionContext = buildRouterSessionPromptContext(task);
  const preparedContext = prepareDaemonTaskContext({
    runtime,
    task,
    workDir,
    agentProfile,
    agentDocumentContexts,
    contactContext,
    payloadOverride: effectivePayload,
    routerSessionContext,
    feishuLarkCliResourceGrants,
  });

  if (preparedContext.skillEnvConflicts.length > 0) {
    throw new Error(
      `Skill environment variable conflicts detected: ${preparedContext.skillEnvConflicts.join(", ")}. ` +
        "Resolve by using the same value across skills or uninstalling conflicting skills.",
    );
  }

  if (preparedContext.skillReadinessBlockers.length > 0) {
    throw new Error(
      `Skill requirements not satisfied for this task: ${preparedContext.skillReadinessBlockers.join("; ")}.`,
    );
  }

  const isManagedRemoteRuntime = Boolean(
    runtime.managedCredentialId && resolveAgentRuntimeMode() === "remote",
  );
  const tokenAcc: TokenAccumulator = isManagedRemoteRuntime
    ? {
        inputTokens: 0,
        outputTokens: 0,
        modelId: "",
      }
    : {
        inputTokens: 0,
        outputTokens: 0,
        modelId: resolveModelId(runtime),
      };
  let runtimeCredentialId: string | undefined;
  if (isManagedRemoteRuntime) {
    const resolution = await resolveEffectiveModelForTaskAsync({
      workspaceId: task.workspaceId,
      employeeName: agentName,
      runtimeId: runtime.id,
      routerSessionId: task.routerSessionId,
    });
    tokenAcc.modelId = resolution.modelId;
    runtimeCredentialId = resolution.runtimeCredentialId;
  }
  let persistedOutputAttachments: MessageAttachment[] = [];

  try {
    const providerSession = chooseProviderSessionForTaskSync({ task });
    const result = await runProviderTaskWithModel(
      runtime,
      preparedContext.prompt,
      workDir,
      tokenAcc.modelId,
      {
        sessionId: providerSession?.providerSessionId ?? effectivePayload.channelSessionId,
        contextEnv: {
          ...preparedContext.skillEnv,
          DOFE_AGENT_CONTEXT_AGENT_NAME: agentName,
          DOFE_AGENT_CONTEXT_TASK_ID: task.id,
          DOFE_AGENT_CONTEXT_TRIGGER_TYPE: task.triggerType,
        },
        skillEnvKeys: preparedContext.skillEnv ? Object.keys(preparedContext.skillEnv) : undefined,
        runtimeToolCapabilities: buildDocumentRuntimeToolCapabilities(agentDocumentContexts, {
          feishuLarkCliResourceGrants,
        }),
        onEvent: (event) => {
          appendTaskMessageSync({
            taskId: task.id,
            type: event.type,
            content: event.content,
            tool: event.tool,
            inputJson: event.inputJson,
            output: event.output,
          });
          if (event.type === "usage" && event.inputJson) {
            const u = event.inputJson as { input_tokens?: number; output_tokens?: number; gateway_request_id?: string };
            tokenAcc.inputTokens += u.input_tokens ?? 0;
            tokenAcc.outputTokens += u.output_tokens ?? 0;
            if (u.gateway_request_id && !tokenAcc.gatewayRequestId) {
              tokenAcc.gatewayRequestId = u.gateway_request_id;
            }
          }
        },
      },
    );
    const documentOperations = channelThreadId
      ? applyChannelDocumentOperations(workDir, {
        channelName: channelThreadId,
        sourceMessageId: effectivePayload.sourceMessageId,
        sourceTaskQueueId: task.id,
          actorName: agentName,
        workspaceId: task.workspaceId,
      })
      : { warnings: [] as string[], documentUpdates: [] as Array<{ documentId: string; documentVersionId: string }> };
    const preparedSkillImports = prepareSkillImportOperationArtifacts(workDir);
    const skillImportOperations = await applySkillImportOperations(workDir, {
      workspaceId: task.workspaceId,
      agentName,
    });
    const documentRuntimeOutputOperations = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      requestedByUserId: task.requestedByUserId,
      requestedByDisplayName: task.requestedByDisplayName,
    });
    const feishuLarkCliResultOperations = applyFeishuLarkCliResultManifestOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const feishuRuntimeDataOperationRequests = await applyFeishuRuntimeDataOperationRequests({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
      sourceDofeAgentMessageId: effectivePayload.sourceMessageId,
      resourceGrants: feishuLarkCliResourceGrants,
    });
    const knowledgeProposalOperations = applyKnowledgeProposalOperations({
      workDir,
      workspaceId: task.workspaceId,
      actorName: agentName,
      sourceTaskQueueId: task.id,
      sourceChannelName: effectiveChannelName,
    });
    const outputEnvelope = loadTaskOutputEnvelope(workDir, result.output, task.workspaceId);
    persistedOutputAttachments = outputEnvelope.attachments;
    appendTaskMessageSync({
      taskId: task.id,
      type: "text",
      content: outputEnvelope.text,
    });
    for (const warning of outputEnvelope.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const warning of preparedSkillImports.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of skillImportOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of skillImportOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of documentRuntimeOutputOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const message of feishuLarkCliResultOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of feishuLarkCliResultOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of feishuRuntimeDataOperationRequests.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of feishuRuntimeDataOperationRequests.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    for (const message of knowledgeProposalOperations.statusMessages) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: message,
      });
    }
    for (const warning of documentOperations.warnings) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: warning,
      });
    }
    // Durability commit phases (EAD §7): preparing → promote to the employee's
    // persistent workspace → committed. A promotion failure keeps the task in
    // `preparing_commit` (result received but NOT durably committed) and the
    // task is NOT completed nor announced — the journal drives reconciliation.
    // The lease generation was captured at claim time.
    const bindingGeneration = task.bindingGeneration;
    let promotionError: string | undefined;
    try {
      markTaskPreparingCommitSync(task.id);
      let workspaceRevisionId: string | undefined;
      let committedArtifactIds: string[] = [];
      const workDirCapture = collectWorkDirChanges(
        workDir,
        readEmployeeHeadManifestSync(task.workspaceId, agentName),
      );
      if (workDirCapture.truncated) {
        // Fail closed: never commit a partial workspace snapshot. Until chunked
        // upload exists, any truncation aborts the promotion with an explicit
        // limit error instead of silently dropping files into the revision.
        throw new Error("output_limit_exceeded: workDir capture exceeded its file/size budget and was truncated");
      }
      const outputs = [
        ...workDirCapture.files.map((file) => ({ path: file.path, bytes: file.bytes, mode: file.mode })),
        ...outputEnvelope.attachments.map((attachment) => ({
          path: attachment.fileName,
          bytes: readWorkspaceAttachmentBytesSync(attachment),
          mediaType: attachment.mediaType,
        })),
      ];
      if (outputs.length > 0 || workDirCapture.deletedPaths.length > 0) {
        const promoted = promoteTaskOutputsToWorkspaceSync({
          workspaceId: task.workspaceId,
          taskId: task.id,
          employeeName: agentName,
          outputs,
          deletedPaths: workDirCapture.deletedPaths,
          publishArtifacts: true,
          expectedBindingGeneration: bindingGeneration,
        });
        workspaceRevisionId = promoted.revision.id;
        committedArtifactIds = promoted.artifactIds;
      }
      markTaskCommittedSync({
        taskId: task.id,
        employeeName: agentName,
        workspaceRevisionId,
        artifactIds: committedArtifactIds,
      });
    } catch (error) {
      promotionError = error instanceof Error ? error.message : String(error);
      upsertTaskCommitJournalSync({
        taskId: task.id,
        workspaceId: task.workspaceId,
        employeeName: agentName,
        commitState: "preparing",
        errorCode: "workspace_promotion_failed",
        errorMessage: promotionError,
      });
      console.error(`[daemon] task ${task.id} outputs NOT committed; keeping preparing_commit: ${promotionError}`);
    }

    if (!promotionError) {
      completeCommittedTaskSync({
      taskId: task.id,
      resultJson: {
        provider: runtime.provider,
        output: outputEnvelope.text,
        attachments: outputEnvelope.attachments.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          mediaType: attachment.mediaType,
          kind: attachment.kind,
          sizeBytes: attachment.sizeBytes,
        })),
        skillImports: skillImportOperations.imports,
        documentUpdates: documentOperations.documentUpdates,
        feishuLarkCliDataOperationRunIds: feishuLarkCliResultOperations.operationRunIds,
        feishuRuntimeDataOperationRunIds: feishuRuntimeDataOperationRequests.operationRunIds,
        feishuRuntimeDataOperationApprovalIds: feishuRuntimeDataOperationRequests.approvalIds,
        documentPermissionRequests: documentRuntimeOutputOperations.permissionRequests,
        knowledgeProposals: knowledgeProposalOperations.knowledgeProposals,
      },
      sessionId: result.sessionId,
      workDir,
      });
    }

    if (tokenAcc.modelId && (tokenAcc.inputTokens > 0 || tokenAcc.outputTokens > 0)) {
      recordTokenUsageSync({
        workspaceId: task.workspaceId,
        taskQueueId: task.id,
        agentId: agentName,
        modelId: tokenAcc.modelId,
        providerAccountId: runtime.providerAccountId,
        runtimeCredentialId,
        routerSessionId: task.routerSessionId,
        gatewayRequestId: tokenAcc.gatewayRequestId,
        inputTokens: tokenAcc.inputTokens,
        outputTokens: tokenAcc.outputTokens,
        channelName: payload.channelName ?? payload.channel,
      });
    }

    if (!promotionError && payload.taskId) {
      updateTaskStatusSync(payload.taskId, "done", task.workspaceId);
    }
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(
        completeChannelDocumentRunStepSync({
          queuedTaskId: task.id,
          documentUpdates: documentOperations.documentUpdates,
          warningText: documentOperations.warnings[0],
        }, task.workspaceId),
        task.workspaceId,
      );
    }
    if (!promotionError && channelThreadId && payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        pendingSpeaker: agentName,
        speaker: agentName,
        summary: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: result.sessionId,
        workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        agentId: agentName,
        text: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [agentName],
          message: outputEnvelope.text,
          taskId: task.id,
        },
      })) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      if (payload.contactId) {
        writeConversationExecutionWorkspaceStateSync({
          channelName: payload.channel,
          agentId: payload.contactId,
          contactId: payload.contactId,
          sessionId: result.sessionId,
          workDir,
          lastTaskQueueId: task.id,
          lastError: null,
        }, task.workspaceId);
        upsertDirectConversationStateSync(
          {
            contactId: payload.contactId,
            sessionId: result.sessionId,
            workDir,
          },
          task.workspaceId,
        );
      }
    } else if (!promotionError && payload.channel) {
      const replyResult = completeAgentChannelReplySync({
        channel: payload.channel,
        speaker: runtime.name,
        summary: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        sourceTaskQueueId: task.id,
        requestedByUserId: task.requestedByUserId,
        requestedByDisplayName: task.requestedByDisplayName,
        mentionCascadeDepth: payload.mentionCascadeDepth,
        mentionRootMessageId: payload.mentionRootMessageId ?? payload.sourceMessageId,
        sessionId: result.sessionId,
        workDir,
      }, task.workspaceId);
      for (const warning of replyResult.warnings) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: warning,
        });
      }
      for (const statusMessage of enqueueFeishuReplyOutboxBestEffort({
        workspaceId: task.workspaceId,
        channelName: payload.channel,
        agentId: agentName,
        text: outputEnvelope.text,
        attachments: outputEnvelope.attachments,
        dofeAgentMessageId: replyResult.message.id,
        sourceDofeAgentMessageId: payload.sourceMessageId,
        statusCard: {
          status: "complete",
          agentNames: [agentName],
          message: outputEnvelope.text,
          taskId: task.id,
        },
      })) {
        appendTaskMessageSync({
          taskId: task.id,
          type: "status",
          content: statusMessage,
        });
      }
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: agentName,
        sessionId: result.sessionId,
        workDir,
        lastTaskQueueId: task.id,
        lastError: null,
      }, task.workspaceId);
    }
  } catch (error) {
    if (persistedOutputAttachments.length > 0) {
      deleteWorkspaceAttachmentsSync(persistedOutputAttachments);
      persistedOutputAttachments = [];
    }
    const message = error instanceof Error ? error.message : String(error);
    appendTaskMessageSync({
      taskId: task.id,
      type: "error",
      content: message,
    });
    const failureMetadata = readProviderTaskFailureMetadata(error);
    const providerError = failureMetadata?.providerError;
    if (providerError) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `provider diagnostic: ${providerError.code}${providerError.rawProviderMessage ? ` · ${providerError.rawProviderMessage}` : ""}`,
      });
    }
    failQueuedTaskSync({
      taskId: task.id,
      errorText: message,
      errorCode: providerError?.code,
      errorCategory: providerError?.category,
      provider: providerError?.provider,
      rawProviderMessage: providerError?.rawProviderMessage,
      sessionId: failureMetadata?.sessionId ?? payload.channelSessionId,
      workDir: failureMetadata?.workDir ?? workDir,
    });

    if (payload.taskId) {
      updateTaskStatusSync(payload.taskId, "blocked", task.workspaceId);
    }
    if (payload.orchestrationStepId) {
      writeWorkspaceStateSync(
        failChannelDocumentRunStepSync({
          queuedTaskId: task.id,
          errorText: message,
        }, task.workspaceId),
        task.workspaceId,
      );
    }
    if (channelThreadId && payload.channel) {
      replacePendingChannelMessageSync({
        channel: payload.channel,
        pendingSpeaker: agentName,
        speaker: "系统提示",
        role: "agent",
        summary: formatConversationFailureSummary({
          agentName,
          channelName: payload.channel,
          errorText: message,
          isDirectConversation: Boolean(payload.contactId),
        }),
        status: "error",
      }, task.workspaceId);
      if (payload.contactId) {
        writeConversationExecutionWorkspaceStateSync({
          channelName: payload.channel,
          agentId: payload.contactId,
          contactId: payload.contactId,
          sessionId: payload.channelSessionId,
          workDir,
          lastTaskQueueId: task.id,
          lastError: message,
        }, task.workspaceId);
        upsertDirectConversationStateSync(
          {
            contactId: payload.contactId,
            sessionId: payload.channelSessionId,
            workDir,
          },
          task.workspaceId,
        );
      }
    } else if (payload.channel) {
      postMessageSync({
        channel: payload.channel,
        speaker: "系统提示",
        role: "agent",
        summary: formatTaskFailureSummary({
          title: payload.title || task.id,
          errorText: message,
        }),
        status: "error",
      }, task.workspaceId);
      writeConversationExecutionWorkspaceStateSync({
        channelName: payload.channel,
        agentId: agentName,
        sessionId: payload.channelSessionId,
        workDir,
        lastTaskQueueId: task.id,
        lastError: message,
      }, task.workspaceId);
    }
  } finally {
    try {
      clearTaskOutputArtifacts(workDir);
    } catch (cleanupError) {
      appendTaskMessageSync({
        taskId: task.id,
        type: "status",
        content: `清理任务产物时出现警告：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      });
    }
  }
}

async function runProviderTask(
  runtime: AgentRuntimeRecord,
  prompt: string,
  workDir: string,
  options: ProviderTaskOptions = {},
): Promise<{ output: string; sessionId?: string }> {
  return runSharedProviderTask(toProviderRuntimeRecord(runtime), prompt, workDir, options);
}

async function runProviderTaskWithModel(
  runtime: AgentRuntimeRecord,
  prompt: string,
  workDir: string,
  modelId: string | undefined,
  options: ProviderTaskOptions = {},
): Promise<{ output: string; sessionId?: string }> {
  return runProviderTask(runtime, prompt, workDir, {
    ...options,
    modelId,
  });
}

function resolveModelId(runtime: AgentRuntimeRecord): string | undefined {
  return resolveSharedModelId(toProviderRuntimeRecord(runtime));
}

function buildRouterSessionPromptContext(task: QueuedTaskRecord): Parameters<typeof prepareDaemonTaskContext>[0]["routerSessionContext"] {
  const routerSession = readAgentRouterSessionForTaskSync(task);
  if (!routerSession) {
    return undefined;
  }
  const providerSession = chooseProviderSessionForTaskSync({ task });
  const attempts = listAgentTaskAttemptsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    limit: 80,
  });
  const taskAttempts = attempts.filter((attempt) => attempt.taskQueueId === task.id);
  const previousAttempt = taskAttempts.length > 1 ? taskAttempts[taskAttempts.length - 2] : undefined;
  const latestAttempt = taskAttempts[taskAttempts.length - 1];
  const metadata = latestAttempt ? safeParseJsonObject(latestAttempt.metadataJson) : {};
  const fallbackReason = readStringValue(metadata.fallbackReason);
  const latestHandoff = readLatestAgentRouterContextSnapshotSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    snapshotType: "handoff",
  });
  const events = listAgentRouterEventsSync({
    workspaceId: task.workspaceId,
    routerSessionId: routerSession.id,
    order: "asc",
    limit: 80,
  });
  return {
    routerSessionId: routerSession.id,
    conversationKey: routerSession.conversationKey,
    sourceType: routerSession.sourceType,
    memorySummary: routerSession.memorySummary,
    providerSessionId: providerSession?.providerSessionId,
    continuationMode: fallbackReason ? "fallback" : providerSession ? "same_provider_resume" : "cold_rebuild",
    previousRuntimeId: previousAttempt?.runtimeId,
    selectedRuntimeId: task.runtimeId,
    fallbackReason,
    transcriptLines: events.map((event) => {
      const actor = event.actorId ? `${event.actorType}:${event.actorId}` : event.actorType;
      return `${event.createdAt} | ${event.type} | ${actor} | ${event.summary ?? ""}`;
    }),
    latestHandoffSnapshot: latestHandoff?.contentMarkdown,
    attemptCount: attempts.length,
  };
}

function toProviderRuntimeRecord(runtime: AgentRuntimeRecord): ProviderRuntimeRecord {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(runtime.metadataJson) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    id: runtime.id,
    workspaceId: runtime.workspaceId,
    provider: runtime.provider as ProviderRuntimeRecord["provider"],
    name: runtime.name,
    version: runtime.version,
    status: runtime.status,
    deviceInfo: runtime.deviceInfo,
    metadata: {
      executablePath: typeof metadata.executablePath === "string" ? metadata.executablePath : "",
      mode: metadata.mode === "remote" ? "remote" : "local",
      providerHealth: isRecord(metadata.providerHealth) ? metadata.providerHealth : undefined,
      providerVerificationRequestedAt: typeof metadata.providerVerificationRequestedAt === "string"
        ? metadata.providerVerificationRequestedAt
        : undefined,
      openClawProfile: typeof metadata.openClawProfile === "string" ? metadata.openClawProfile : undefined,
      openClawModel: typeof metadata.openClawModel === "string" ? metadata.openClawModel : undefined,
    },
  };
}

function listLocalRuntimeHeartbeatMetadata(daemonKey: string): Array<{
  id: string;
  provider: ProviderRuntimeRecord["provider"];
  metadata: Record<string, unknown>;
}> {
  return readDaemonSnapshotSync(daemonKey).runtimes.map((runtime) => {
    const providerRuntime = toProviderRuntimeRecord(runtime);
    return {
      id: runtime.id,
      provider: runtime.provider as ProviderRuntimeRecord["provider"],
      metadata: buildProviderRuntimeMetadata(providerRuntime),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function buildRemoteRuntimeRecords(
  config: DaemonConfig,
  registered: Awaited<ReturnType<HttpDaemonClient["register"]>>,
  detected: DetectedProvider[],
): AgentRuntimeRecord[] {
  const now = new Date().toISOString();
  const runtimes: AgentRuntimeRecord[] = [];

  for (const runtime of registered.runtimes) {
    const detectedProvider = detected.find((provider) => provider.provider === runtime.provider);
    if (!detectedProvider) {
      continue;
    }

    runtimes.push({
      id: runtime.id,
      workspaceId: registered.daemon.workspaceId,
      provider: detectedProvider.provider,
      name: runtime.name,
      version: detectedProvider.version,
      status: runtime.status,
      deviceInfo: config.deviceName,
      metadataJson: JSON.stringify(buildProviderRuntimeMetadata({
        provider: detectedProvider.provider,
        metadata: {
          executablePath: detectedProvider.executablePath,
          mode: "remote",
        },
      })),
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  return runtimes;
}

function toQueuedTaskRecord(task: Awaited<ReturnType<HttpDaemonClient["claimTask"]>>["task"]): QueuedTaskRecord {
  if (!task) {
    throw new Error("Cannot map an empty claimed task.");
  }

  return {
    id: task.id,
    workspaceId: task.workspaceId,
    agentId: task.agentId,
    runtimeId: task.runtimeId,
    routerSessionId: task.routerSessionId,
    triggerType: task.triggerType,
    priority: task.priority,
    status: task.status as QueuedTaskRecord["status"],
    inputJson: task.inputJson,
    queuedAt: task.queuedAt,
    createdAt: task.queuedAt,
    updatedAt: task.queuedAt,
  };
}

function materializeInputBundle(workDir: string, bundle: Awaited<ReturnType<HttpDaemonClient["getInputBundle"]>>): void {
  for (const file of bundle.files) {
    const targetPath = join(workDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, Buffer.from(file.contentBase64, "base64"));
  }
}

function sameValue(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

function normalizeSkillFilePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
}

function getWorkspaceRemoteTaskWorkDir(workspaceId: string, taskId: string): string {
  return getDaemonRemoteTaskWorkDirPath(ensureDaemonStateDir(), { workspaceId, taskId });
}

function resolveConversationThreadId(input: {
  triggerType: string;
  payload: {
    channel?: string;
    channelName?: string;
    contactId?: string;
  };
}): string | undefined {
  const isConversationTrigger = input.triggerType === "channel_chat" || input.triggerType === "mention_chat";
  if (!isConversationTrigger && !input.payload.contactId) {
    return undefined;
  }

  return input.payload.channelName ?? input.payload.channel;
}

function resolveWorkspaceTaskWorkDir(input: {
  workspaceId: string;
  taskId: string;
  agentId: string;
  channelThreadId?: string;
}): string {
  if (input.channelThreadId) {
    return getDaemonChannelWorkDirPath(ensureDaemonStateDir(), {
      workspaceId: input.workspaceId,
      threadId: input.channelThreadId,
      agentId: input.agentId,
    });
  }

  return getDaemonTaskWorkDirPath(ensureDaemonStateDir(), {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
  });
}
