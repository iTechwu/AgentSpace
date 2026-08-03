import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeAppCommandPlanItem, RuntimeAppInstallPlan } from "@dofe-agent/domain";

const MAX_TAIL_CHARS = 8_000;
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
  options?: { cwd?: string; runtimeHomeDir?: string },
): Promise<RuntimeAppExecutionResult> {
  let stdout = "";
  let stderr = "";
  const executionEnvironment = resolveRuntimeAppExecutionEnvironment(process.env, options?.runtimeHomeDir);
  for (const command of [...plan.commands, ...plan.verifyCommands]) {
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

export function readCliHubReadiness(): CliHubReadiness {
  const executionEnvironment = resolveRuntimeAppExecutionEnvironment();
  const pythonExecutable = executionEnvironment.pythonExecutable ?? "python3";
  return {
    checkedAt: new Date().toISOString(),
    python: checkCommand(pythonExecutable, ["--version"], executionEnvironment.path),
    pip: checkCommand(pythonExecutable, ["-m", "pip", "--version"], executionEnvironment.path),
    cliHub: checkCommand("cli-hub", ["--version"], executionEnvironment.path),
    npm: checkCommand("npm", ["--version"], executionEnvironment.path),
    uv: checkCommand("uv", ["--version"], executionEnvironment.path),
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
  return plan;
}

function checkCommand(command: string, args: string[], pathValue = process.env.PATH ?? ""): RuntimeAppReadinessItem {
  const result = spawnSync(command, args, {
    env: { ...process.env, PATH: pathValue },
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

const RUNTIME_APP_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5_000;

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
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, RUNTIME_APP_COMMAND_TIMEOUT_MS);
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
      const error = new Error(`${renderCommand(command)} exited with code ${code}. ${tailAndRedact(stderr || stdout)}`);
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
