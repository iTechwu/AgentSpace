import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import type { RuntimeAppCommandPlanItem, RuntimeAppInstallPlan } from "@dofe-agent/domain";

const MAX_TAIL_CHARS = 8_000;
const MAX_CLI_HUB_REGISTRY_SNAPSHOT_CHARS = 256_000;
const SECRET_PATTERNS = [
  /(api[_-]?key|token|secret|password|authorization)(["'\s:=]+)([^\s"',;]+)/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
];

export interface RuntimeAppReadinessItem {
  available: boolean;
  version?: string;
  error?: string;
}

export interface CliHubReadiness {
  checkedAt: string;
  python: RuntimeAppReadinessItem;
  pip: RuntimeAppReadinessItem;
  cliHub: RuntimeAppReadinessItem;
  npm: RuntimeAppReadinessItem;
  uv: RuntimeAppReadinessItem;
}

export interface RuntimeAppExecutionResult {
  safeStdoutTail: string;
  safeStderrTail: string;
  /** sha256 over the installed deps dir (download artifact digest, P1-4). */
  downloadedDigest?: string;
}

export interface ManagedRuntimeAppPlanOptions {
  image: string;
  runtimeHomeDir: string;
  depsRoot: string;
  dockerNetwork: string;
  dockerConnectivityArgs?: string[];
  registryEnvironment?: Record<string, string>;
  user: string;
}

interface RuntimeAppExecutionEnvironment {
  path: string;
  pythonExecutable?: string;
  pythonUserBinDir?: string;
  installEnv?: Record<string, string>;
}

const RUNTIME_APP_CONTAINER_HOME = "/dofe-home";
const RUNTIME_APP_CONTAINER_DEPS_ROOT = "/runtime-app-deps";
const RUNTIME_APP_CONTAINER_PATH = [
  `${RUNTIME_APP_CONTAINER_HOME}/.local/bin`,
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
].join(":");

export function buildManagedRuntimeAppPlan(
  plan: RuntimeAppInstallPlan,
  options: ManagedRuntimeAppPlanOptions,
): RuntimeAppInstallPlan {
  const wrap = (command: RuntimeAppCommandPlanItem): RuntimeAppCommandPlanItem => ({
    executable: "docker",
    args: [
      "run", "--rm", "--init", "--pull", "never", "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec",
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
      ...(options.dockerConnectivityArgs ?? []),
      "--network", options.dockerNetwork,
      "--user", options.user,
      "--mount", `type=bind,src=${options.runtimeHomeDir},dst=${RUNTIME_APP_CONTAINER_HOME}`,
      "--mount", `type=bind,src=${options.depsRoot},dst=${RUNTIME_APP_CONTAINER_DEPS_ROOT}`,
      "--workdir", RUNTIME_APP_CONTAINER_DEPS_ROOT,
      ...Object.entries(command.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...Object.entries(options.registryEnvironment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--env", `HOME=${RUNTIME_APP_CONTAINER_HOME}`,
      "--env", `PYTHONUSERBASE=${RUNTIME_APP_CONTAINER_HOME}/.local`,
      "--env", `NPM_CONFIG_PREFIX=${RUNTIME_APP_CONTAINER_HOME}/.local`,
      "--env", `PATH=${RUNTIME_APP_CONTAINER_PATH}`,
      "--entrypoint", command.executable,
      options.image,
      ...command.args,
    ],
  });
  return {
    ...plan,
    commands: plan.commands.map(wrap),
    verifyCommands: plan.verifyCommands.map(wrap),
  };
}

/**
 * Deterministic sha256 over a directory tree (relative path + file bytes, sorted).
 * Returns undefined when the directory is missing or unreadable — the download
 * digest is an audit enrichment, never a hard blocker.
 */
export function computeDirectoryDigestSync(dirPath: string): string | undefined {
  const hash = createHash("sha256");
  const walk = (relative: string): boolean => {
    let entries;
    try {
      entries = readdirSync(join(dirPath, relative), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name, "en-US"))) {
      const rel = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!walk(rel)) return false;
      } else if (entry.isFile()) {
        hash.update(rel);
        hash.update("\0");
        try {
          hash.update(readFileSync(join(dirPath, rel)));
        } catch {
          return false;
        }
      }
    }
    return true;
  };
  if (!walk("")) {
    return undefined;
  }
  return hash.digest("hex");
}

export async function executeRuntimeAppPlan(
  plan: RuntimeAppInstallPlan,
  options?: {
    cwd?: string;
    runtimeHomeDir?: string;
    onStage?: (stage: "installing" | "verifying") => void | Promise<void>;
  },
): Promise<RuntimeAppExecutionResult> {
  let stdout = "";
  let stderr = "";
  if (options?.runtimeHomeDir) {
    seedCliHubRegistryCacheSync(plan, options.runtimeHomeDir);
  }
  const executionEnvironment = resolveRuntimeAppExecutionEnvironment(process.env, options?.runtimeHomeDir);
  if (plan.commands.length > 0) await options?.onStage?.("installing");
  for (const command of plan.commands) {
    const result = await execCommand(command, {
      cwd: options?.cwd,
      executionEnvironment,
    });
    stdout += `\n$ ${renderCommand(command)}\n${result.stdout}`;
    stderr += result.stderr ? `\n$ ${renderCommand(command)}\n${result.stderr}` : "";
  }
  if (plan.verifyCommands.length > 0) await options?.onStage?.("verifying");
  for (const command of plan.verifyCommands) {
    const result = await execCommand(command, {
      cwd: options?.cwd,
      executionEnvironment,
    });
    stdout += `\n$ ${renderCommand(command)}\n${result.stdout}`;
    stderr += result.stderr ? `\n$ ${renderCommand(command)}\n${result.stderr}` : "";
  }
  return {
    safeStdoutTail: tailAndRedact(stdout),
    safeStderrTail: tailAndRedact(stderr),
    // Download artifact digest over the isolated deps dir (P1-4). Best-effort:
    // a missing dir (e.g. no-op plan) simply yields no digest.
    downloadedDigest: plan.depsDir && options?.cwd
      ? computeDirectoryDigestSync(join(options.cwd, plan.depsDir))
      : undefined,
  };
}

export function readCliHubReadiness(options: {
  environment?: NodeJS.ProcessEnv;
  runtimeHomeDir?: string;
} = {}): CliHubReadiness {
  const environment = options.environment ?? process.env;
  const executionEnvironment = resolveRuntimeAppExecutionEnvironment(environment, options.runtimeHomeDir);
  const pythonExecutable = executionEnvironment.pythonExecutable ?? "python3";
  return {
    checkedAt: new Date().toISOString(),
    python: checkCommand(pythonExecutable, ["--version"], executionEnvironment.path, environment),
    pip: checkCommand(pythonExecutable, ["-m", "pip", "--version"], executionEnvironment.path, environment),
    cliHub: checkCommand("cli-hub", ["--version"], executionEnvironment.path, environment),
    npm: checkCommand("npm", ["--version"], executionEnvironment.path, environment),
    uv: checkCommand("uv", ["--version"], executionEnvironment.path, environment),
  };
}

export function readManagedCliHubReadiness(options: {
  image: string;
  runtimeHomeDir: string;
  user: string;
  environment?: NodeJS.ProcessEnv;
}): CliHubReadiness {
  const environment = options.environment ?? process.env;
  const result = spawnSync("docker", [
    "run", "--rm", "--pull", "never", "--read-only", "--network", "none",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec",
    "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--user", options.user,
    "--mount", `type=bind,src=${options.runtimeHomeDir},dst=${RUNTIME_APP_CONTAINER_HOME},readonly`,
    "--env", `HOME=${RUNTIME_APP_CONTAINER_HOME}`,
    "--env", `PATH=${RUNTIME_APP_CONTAINER_PATH}`,
    "--entrypoint", "node",
    options.image,
    "-e", MANAGED_READINESS_SCRIPT,
  ], {
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    return unavailableCliHubReadiness(tailAndRedact(result.error?.message || result.stderr || "Managed Runtime readiness probe failed."));
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as CliHubReadiness;
    if (!parsed.checkedAt || !parsed.python || !parsed.cliHub || !parsed.npm) throw new Error("invalid readiness response");
    return parsed;
  } catch {
    return unavailableCliHubReadiness("Managed Runtime readiness probe returned invalid output.");
  }
}

export function resolveRuntimeAppRegistryEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const npmRegistry = validateRegistryUrl(environment.DOFE_AGENT_NPM_REGISTRY, "runtime_app.npm_registry_invalid");
  const pypiIndex = validateRegistryUrl(environment.DOFE_AGENT_PYPI_INDEX_URL, "runtime_app.pypi_index_invalid");
  if (environment.MCP_EGRESS_ENFORCE === "true" && (!npmRegistry || !pypiIndex)) {
    throw new Error("runtime_app.controlled_registries_required");
  }
  return {
    ...(npmRegistry ? { NPM_CONFIG_REGISTRY: npmRegistry } : {}),
    ...(pypiIndex ? { PIP_INDEX_URL: pypiIndex, UV_DEFAULT_INDEX: pypiIndex } : {}),
  };
}

export function resolveRuntimeAppUserBinDir(): string | undefined {
  return resolveRuntimeAppExecutionEnvironment().pythonUserBinDir;
}

export function parseRuntimeAppInstallPlan(value: unknown): RuntimeAppInstallPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as RuntimeAppInstallPlan;
  if (
    !plan.app ||
    typeof plan.app.name !== "string" ||
    !Array.isArray(plan.commands) ||
    !Array.isArray(plan.verifyCommands)
  ) {
    return null;
  }
  if (![...plan.commands, ...plan.verifyCommands].every(isCommandPlanItem)) {
    return null;
  }
  if (plan.cliHubRegistrySnapshot && !isCliHubRegistrySnapshot(plan.cliHubRegistrySnapshot, plan.app.name)) {
    return null;
  }
  return plan;
}

export function seedCliHubRegistryCacheSync(plan: RuntimeAppInstallPlan, runtimeHomeDir: string): void {
  const snapshot = plan.cliHubRegistrySnapshot;
  if (!snapshot) return;
  if (!isCliHubRegistrySnapshot(snapshot, plan.app.name)) {
    throw new Error("runtime_app.cli_hub_registry_snapshot_invalid");
  }
  const entry = JSON.parse(snapshot.registryJson) as Record<string, unknown>;
  const cacheDir = join(runtimeHomeDir, ".cli-hub");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const harnessCachePath = join(cacheDir, "registry_cache.json");
  const publicCachePath = join(cacheDir, "public_registry_cache.json");
  writeCliHubCacheSync(harnessCachePath, snapshot.source === "clihub_harness" ? entry : undefined);
  writeCliHubCacheSync(publicCachePath, snapshot.source === "clihub_public" ? entry : undefined);
}

function writeCliHubCacheSync(cachePath: string, entry?: Record<string, unknown>): void {
  const entries = readCliHubCacheEntries(cachePath);
  if (entry && typeof entry.name === "string") {
    const normalizedName = entry.name.trim().toLocaleLowerCase("en-US");
    const existingIndex = entries.findIndex((candidate) =>
      typeof candidate.name === "string" && candidate.name.trim().toLocaleLowerCase("en-US") === normalizedName,
    );
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else entries.push(entry);
  }
  const temporaryPath = `${cachePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({
    _cached_at: Math.floor(Date.now() / 1_000),
    data: { clis: entries },
  }), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, cachePath);
}

function readCliHubCacheEntries(cachePath: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const data = (parsed as Record<string, unknown>).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const clis = (data as Record<string, unknown>).clis;
    return Array.isArray(clis)
      ? clis.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

function isCliHubRegistrySnapshot(value: unknown, appName: string): value is NonNullable<RuntimeAppInstallPlan["cliHubRegistrySnapshot"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.source !== "clihub_harness" && snapshot.source !== "clihub_public") return false;
  if (typeof snapshot.registryJson !== "string" || snapshot.registryJson.length > MAX_CLI_HUB_REGISTRY_SNAPSHOT_CHARS) return false;
  try {
    const entry = JSON.parse(snapshot.registryJson) as unknown;
    return Boolean(entry)
      && typeof entry === "object"
      && !Array.isArray(entry)
      && typeof (entry as Record<string, unknown>).name === "string"
      && (entry as Record<string, unknown>).name === appName;
  } catch {
    return false;
  }
}

function checkCommand(
  command: string,
  args: string[],
  pathValue = process.env.PATH ?? "",
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeAppReadinessItem {
  const result = spawnSync(command, args, {
    env: { ...environment, PATH: pathValue },
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) {
    return { available: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      available: false,
      error: tailAndRedact(`${result.stderr || result.stdout || `${command} exited with code ${result.status}`}`),
    };
  }
  const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0]?.trim();
  return {
    available: true,
    version: version || undefined,
  };
}

function validateRegistryUrl(value: string | undefined, errorCode: string): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(errorCode);
    return url.toString();
  } catch {
    throw new Error(errorCode);
  }
}

function unavailableCliHubReadiness(error: string): CliHubReadiness {
  const unavailable = (): RuntimeAppReadinessItem => ({ available: false, error });
  return {
    checkedAt: new Date().toISOString(),
    python: unavailable(),
    pip: unavailable(),
    cliHub: unavailable(),
    npm: unavailable(),
    uv: unavailable(),
  };
}

const MANAGED_READINESS_SCRIPT = `
const { spawnSync } = require("node:child_process");
const check = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000, env: process.env });
  if (result.error) return { available: false, error: result.error.message };
  if (result.status !== 0) return { available: false, error: String(result.stderr || result.stdout || command + " failed").slice(-8000) };
  const version = String(result.stdout + "\\n" + result.stderr).trim().split(/\\r?\\n/)[0];
  return { available: true, ...(version ? { version } : {}) };
};
const python = ["python3", "python"].find((candidate) => check(candidate, ["--version"]).available) || "python3";
process.stdout.write(JSON.stringify({
  checkedAt: new Date().toISOString(),
  python: check(python, ["--version"]),
  pip: check(python, ["-m", "pip", "--version"]),
  cliHub: check("cli-hub", ["--version"]),
  npm: check("npm", ["--version"]),
  uv: check("uv", ["--version"]),
}));
`;

const DEFAULT_RUNTIME_APP_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_RUNTIME_APP_COMMAND_TIMEOUT_MS = 30 * 1000;
const MAX_RUNTIME_APP_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

export function resolveRuntimeAppCommandTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const rawValue = environment.DOFE_AGENT_RUNTIME_APP_COMMAND_TIMEOUT_MS?.trim();
  if (!rawValue) return DEFAULT_RUNTIME_APP_COMMAND_TIMEOUT_MS;
  const configured = Number(rawValue);
  if (!Number.isFinite(configured)) return DEFAULT_RUNTIME_APP_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_RUNTIME_APP_COMMAND_TIMEOUT_MS, Math.max(MIN_RUNTIME_APP_COMMAND_TIMEOUT_MS, Math.floor(configured)));
}

function execCommand(
  command: RuntimeAppCommandPlanItem,
  options: { cwd?: string; executionEnvironment: RuntimeAppExecutionEnvironment },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const executable = command.executable === "python3"
      ? options.executionEnvironment.pythonExecutable ?? command.executable
      : command.executable;
    const commandPath = prependPath(
      command.env?.PATH ?? options.executionEnvironment.path,
      options.executionEnvironment.pythonUserBinDir,
    );
    const child = spawn(executable, command.args, {
      cwd: options?.cwd,
      // Minimal env: only PATH + the plan's own env — host secrets must not leak
      // into package-manager subprocesses.
      env: {
        ...(command.env ?? {}),
        ...(options.executionEnvironment.installEnv ?? {}),
        PATH: commandPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const commandTimeoutMs = resolveRuntimeAppCommandTimeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      stdout = stdout.slice(-MAX_TAIL_CHARS * 2);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      stderr = stderr.slice(-MAX_TAIL_CHARS * 2);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = tailAndRedact(stderr || stdout);
      const error = new Error(timedOut
        ? `Runtime application command timed out after ${Math.round(commandTimeoutMs / 1000)} seconds.${detail ? ` ${detail}` : ""}`
        : `Runtime application command failed (${basename(command.executable)}, exit code ${code ?? "unknown"}).${detail ? ` ${detail}` : ""}`);
      reject(Object.assign(error, {
        stdout: tailAndRedact(stdout),
        stderr: tailAndRedact(stderr),
      }));
    });
  });
}

function resolveRuntimeAppExecutionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeHomeDir?: string,
): RuntimeAppExecutionEnvironment {
  const basePath = environment.PATH ?? "";
  const runtimePrefix = runtimeHomeDir ? join(runtimeHomeDir, ".local") : undefined;
  const runtimeBinDir = runtimePrefix
    ? join(runtimePrefix, process.platform === "win32" ? "Scripts" : "bin")
    : undefined;
  const installEnv = runtimeHomeDir && runtimePrefix
    ? {
        HOME: runtimeHomeDir,
        PYTHONUSERBASE: runtimePrefix,
        NPM_CONFIG_PREFIX: runtimePrefix,
      }
    : undefined;
  for (const candidate of ["python3", "python"]) {
    const version = spawnSync(candidate, ["--version"], {
      env: environment,
      encoding: "utf8",
      timeout: 5_000,
    });
    if (version.error || version.status !== 0) continue;

    const userBase = spawnSync(candidate, ["-c", "import site; print(site.USER_BASE)"], {
      env: environment,
      encoding: "utf8",
      timeout: 5_000,
    });
    const pythonUserBase = userBase.status === 0 ? userBase.stdout.trim() : "";
    const pythonUserBinDir = runtimeBinDir ?? (pythonUserBase
      ? join(pythonUserBase, process.platform === "win32" ? "Scripts" : "bin")
      : undefined);
    return {
      pythonExecutable: candidate,
      pythonUserBinDir,
      path: prependPath(basePath, pythonUserBinDir),
      installEnv,
    };
  }
  return {
    pythonUserBinDir: runtimeBinDir,
    path: prependPath(basePath, runtimeBinDir),
    installEnv,
  };
}

function prependPath(pathValue: string, directory?: string): string {
  if (!directory) return pathValue;
  return [directory, ...pathValue.split(delimiter).filter((entry) => entry && entry !== directory)].join(delimiter);
}

function isCommandPlanItem(value: unknown): value is RuntimeAppCommandPlanItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as RuntimeAppCommandPlanItem;
  return (
    typeof record.executable === "string" &&
    record.executable.trim().length > 0 &&
    Array.isArray(record.args) &&
    record.args.every((arg) => typeof arg === "string")
  );
}

function renderCommand(command: RuntimeAppCommandPlanItem): string {
  if (command.executable === "docker") return "docker run [managed Runtime application command]";
  return [command.executable, ...command.args].join(" ");
}

export function tailAndRedact(value: string): string {
  let output = value.slice(-MAX_TAIL_CHARS);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix: string, separator?: string) =>
      separator ? `${prefix}${separator}[REDACTED]` : `${prefix}[REDACTED]`,
    );
  }
  return output;
}
