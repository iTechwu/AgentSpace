import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getDaemonSkillInstallCachePath, getDaemonSkillInstallEnvsDirPath } from "@dofe-agent/db";
import {
  buildSkillRunnerCommandName,
  type DaemonSkillDependencyEnvironment,
  type DaemonSkillRunnerEntrypoint,
  type RuntimeToolCapability,
  type SkillEntrypointRuntime,
} from "@dofe-agent/domain";
import { buildSkillDependencyTaskEnvironment } from "./skill-install/task-environment.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 8 * 1024;
const MAX_OUTPUT_FILES = 1_000;
const MAX_OUTPUT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_TOTAL_BYTES = 64 * 1024 * 1024;

export interface SkillRunnerDockerPlanInput {
  image: string;
  runtime: SkillEntrypointRuntime;
  artifactDir: string;
  workspaceDir: string;
  outputDir: string;
  configFile?: string;
  dependencyDir?: string;
  entrypointPath: string;
  argv: string[];
}

export function buildSkillRunnerDockerArgs(input: SkillRunnerDockerPlanInput): string[] {
  if (!/@sha256:[a-f0-9]{64}$/i.test(input.image)) {
    throw new Error("Skill Runner image must be pinned by an immutable digest.");
  }
  const entrypointPath = normalizeEntrypointPath(input.entrypointPath);
  for (const hostPath of [input.artifactDir, input.workspaceDir, input.outputDir, input.configFile, input.dependencyDir].filter(
    (value): value is string => Boolean(value),
  )) {
    if (!isAbsolute(hostPath) || /[\r\n,]/.test(hostPath)) {
      throw new Error(`Skill Runner host path is unsafe: ${hostPath}`);
    }
  }
  if (input.argv.length > MAX_ARGUMENTS || input.argv.some((argument) => Buffer.byteLength(argument) > MAX_ARGUMENT_BYTES)) {
    throw new Error("Skill Runner arguments exceed the configured budget.");
  }
  return [
    "run", "--rm", "--init", "--pull", "never",
    "--read-only",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "65532:65532",
    "--pids-limit", "64",
    "--memory", "256m",
    "--memory-swap", "256m",
    "--cpus", "0.5",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--mount", `type=bind,src=${input.artifactDir},dst=/skill,readonly`,
    "--mount", `type=bind,src=${input.workspaceDir},dst=/workspace,readonly`,
    "--mount", `type=bind,src=${input.outputDir},dst=/output`,
    ...(input.configFile ? [
      "--mount", `type=bind,src=${input.configFile},dst=/run/secrets/dofe-skill-config.json,readonly`,
      "--env", "DOFE_SKILL_CONFIG_FILE=/run/secrets/dofe-skill-config.json",
    ] : []),
    ...(input.dependencyDir ? [
      "--mount", `type=bind,src=${input.dependencyDir},dst=/deps,readonly`,
      "--env", "NODE_PATH=/deps/node_modules",
      "--env", "PYTHONPATH=/deps",
      "--env", "PYTHONNOUSERSITE=1",
      "--env", "PATH=/deps/node_modules/.bin:/deps/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ] : []),
    "--workdir", "/workspace",
    "--env", "DOFE_SKILL_OUTPUT_DIR=/output",
    input.image,
    interpreterForRuntime(input.runtime),
    `/skill/${entrypointPath}`,
    ...input.argv,
  ];
}

export interface SkillRunnerExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SkillRunnerBroker {
  capabilities: RuntimeToolCapability[];
  close(): Promise<void>;
}

export async function startSkillRunnerBroker(input: {
  stateDir: string;
  workspaceId: string;
  workDir: string;
  entrypoints: DaemonSkillRunnerEntrypoint[];
  dependencyEnvironments?: readonly DaemonSkillDependencyEnvironment[];
  skillEnv?: Readonly<Record<string, string>>;
  environment?: NodeJS.ProcessEnv;
  inspectImage?: (image: string, environment: NodeJS.ProcessEnv) => boolean;
  execute?: (args: string[], timeoutMs: number) => Promise<SkillRunnerExecutionResult>;
}): Promise<SkillRunnerBroker> {
  if (input.entrypoints.length === 0) {
    return { capabilities: [], close: async () => {} };
  }
  const byKey = new Map<string, DaemonSkillRunnerEntrypoint>();
  const commandOwners = new Map<string, string>();
  for (const entrypoint of input.entrypoints) {
    if (byKey.has(entrypoint.key)) {
      throw new Error(`skill_runner.duplicate_entrypoint_key: ${entrypoint.key}`);
    }
    const command = buildLauncherCommand(entrypoint);
    const existingOwner = commandOwners.get(command);
    if (existingOwner) {
      throw new Error(`skill_runner.duplicate_launcher_command: ${existingOwner}, ${entrypoint.key}`);
    }
    byKey.set(entrypoint.key, entrypoint);
    commandOwners.set(command, entrypoint.key);
  }
  const launcherDir = join(input.workDir, ".dofe-runtime", "skill-runner-bin");
  rmSync(launcherDir, { recursive: true, force: true });
  mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
  const socketPath = join(input.workDir, ".dofe-sr.sock");
  rmSync(socketPath, { force: true });
  const token = randomBytes(32).toString("hex");
  const environment = input.environment ?? process.env;
  const runnerTimeoutMs = resolveRunnerTimeout(environment);
  const inspectImage = input.inspectImage ?? isSkillRunnerImageAvailableLocally;
  const configuredImages = new Map<SkillEntrypointRuntime, string>();
  const runnerImages = new Map<SkillEntrypointRuntime, string>();
  for (const runtime of new Set(input.entrypoints.map((entrypoint) => entrypoint.runtime))) {
    const image = resolveSkillRunnerImage(runtime, environment);
    if (!image) continue;
    configuredImages.set(runtime, image);
    if (inspectImage(image, environment)) runnerImages.set(runtime, image);
  }
  const execute = input.execute ?? executeDockerSkillRunner;
  const server = createServer((request, response) => {
    void handleBrokerRequest(request, response, { ...input, token, byKey, runnerImages, runnerTimeoutMs, execute });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(socketPath, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  chmodSync(socketPath, 0o600);

  const capabilities = input.entrypoints.map((entrypoint): RuntimeToolCapability => {
    const command = buildLauncherCommand(entrypoint);
    const launcherPath = join(launcherDir, command);
    writeFileSync(launcherPath, buildLauncherSource({
      token,
      key: entrypoint.key,
    }), { encoding: "utf8", mode: 0o500 });
    chmodSync(launcherPath, 0o500);
    const image = runnerImages.get(entrypoint.runtime);
    const configuredImage = configuredImages.get(entrypoint.runtime);
    return {
      id: `skill-runner:${entrypoint.key}`,
      command,
      displayName: `${entrypoint.skillName}: ${entrypoint.id}`,
      binPath: launcherPath,
      binDir: launcherDir,
      allowedShellPatterns: [`${command} *`, command],
      diagnosticCommands: image ? [`test -x ${shellQuote(launcherPath)}`] : [],
      source: "runtime",
      status: image ? "available" : "missing",
      denialReason: image
        ? undefined
        : configuredImage
          ? `Immutable ${entrypoint.runtime} Skill Runner image is not available locally.`
          : `No immutable ${entrypoint.runtime} Skill Runner image is configured.`,
    };
  });
  return {
    capabilities,
    close: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      rmSync(socketPath, { force: true });
      rmSync(launcherDir, { recursive: true, force: true });
    },
  };
}

async function handleBrokerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: {
    stateDir: string;
    workspaceId: string;
    workDir: string;
    dependencyEnvironments?: readonly DaemonSkillDependencyEnvironment[];
    skillEnv?: Readonly<Record<string, string>>;
    token: string;
    byKey: Map<string, DaemonSkillRunnerEntrypoint>;
    runnerImages: Map<SkillEntrypointRuntime, string>;
    runnerTimeoutMs: number;
    execute: (args: string[], timeoutMs: number) => Promise<SkillRunnerExecutionResult>;
  },
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/run" || request.headers.authorization !== `Bearer ${context.token}`) {
      sendJson(response, 403, { error: "skill_runner.unauthorized" });
      return;
    }
    const payload = await readJsonBody(request) as { key?: unknown; argv?: unknown };
    const entrypoint = typeof payload.key === "string" ? context.byKey.get(payload.key) : undefined;
    const argv = Array.isArray(payload.argv) && payload.argv.every((value) => typeof value === "string")
      ? payload.argv as string[]
      : null;
    if (!entrypoint || !argv) {
      sendJson(response, 400, { error: "skill_runner.invalid_request" });
      return;
    }
    const image = context.runnerImages.get(entrypoint.runtime);
    if (!image) {
      sendJson(response, 424, { error: "skill_runner.image_not_configured" });
      return;
    }
    const artifactDir = getDaemonSkillInstallCachePath(context.stateDir, {
      workspaceId: context.workspaceId,
      artifactDigest: entrypoint.artifactDigest,
    });
    assertSkillRunnerCacheEntry(artifactDir, entrypoint);
    const publishedOutputDir = preparePublishedOutputDir(context.workDir, entrypoint.key);
    const outputDir = createPrivateRunnerOutputDir(context.stateDir, entrypoint.key);
    let privateConfig: { dir: string; file: string } | undefined;
    try {
      const dependencyReference = context.dependencyEnvironments?.find(
        (candidate) => candidate.installationId === entrypoint.installationId,
      );
      let dependencyDir: string | undefined;
      if (dependencyReference) {
        buildSkillDependencyTaskEnvironment({
          stateDir: context.stateDir,
          workspaceId: context.workspaceId,
          environments: [dependencyReference],
          baseEnv: {},
        });
        dependencyDir = getDaemonSkillInstallEnvsDirPath(context.stateDir, {
          workspaceId: context.workspaceId,
          installationId: entrypoint.installationId,
        });
      }
      privateConfig = createPrivateRunnerConfig(context.stateDir, entrypoint, context.skillEnv ?? {});
      const args = buildSkillRunnerDockerArgs({
        image,
        runtime: entrypoint.runtime,
        artifactDir,
        workspaceDir: resolve(context.workDir),
        outputDir,
        configFile: privateConfig?.file,
        dependencyDir,
        entrypointPath: entrypoint.path,
        argv,
      });
      const result = await context.execute(args, context.runnerTimeoutMs);
      assertPublishedOutputDirTrusted(context.workDir, publishedOutputDir);
      publishRunnerOutput(outputDir, publishedOutputDir);
      sendJson(response, result.exitCode === 0 && !result.timedOut ? 200 : 422, result);
    } finally {
      if (privateConfig) rmSync(privateConfig.dir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  } catch (error) {
    sendJson(response, 500, {
      error: "skill_runner.execution_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeDockerSkillRunner(args: string[], timeoutMs: number): Promise<SkillRunnerExecutionResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalRunnerHostEnvironment(process.env),
    });
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let timedOut = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", rejectPromise);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (totalBytes > MAX_OUTPUT_BYTES) {
        stderr = "skill_runner.output_limit_exceeded";
      }
      resolvePromise({ exitCode, stdout, stderr, timedOut });
    });
  });
}

function buildLauncherSource(input: { token: string; key: string }): string {
  return `#!/usr/bin/env node
import { request } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
const requestBody = JSON.stringify({ key: ${JSON.stringify(input.key)}, argv: process.argv.slice(2) });
const response = await new Promise((resolve, reject) => {
  const req = request({
    socketPath: resolvePath(dirname(fileURLToPath(import.meta.url)), "../..", ".dofe-sr.sock"),
    path: "/run",
    method: "POST",
    headers: {
      authorization: ${JSON.stringify(`Bearer ${input.token}`)},
      "content-type": "application/json",
      "content-length": Buffer.byteLength(requestBody),
    },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      try { resolve({ ok: (res.statusCode ?? 500) < 400, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch (error) { reject(error); }
    });
  });
  req.on("error", reject);
  req.end(requestBody);
});
const body = response.body;
if (body.stdout) process.stdout.write(String(body.stdout));
if (body.stderr) process.stderr.write(String(body.stderr));
if (!response.ok) { if (body.message) process.stderr.write(String(body.message) + "\\n"); process.exit(1); }
process.exit(Number.isInteger(body.exitCode) ? body.exitCode : 0);
`;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("skill_runner.request_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function resolveSkillRunnerImage(runtime: SkillEntrypointRuntime, env: NodeJS.ProcessEnv): string | undefined {
  const key = runtime === "node"
    ? "DOFE_SKILL_RUNNER_NODE_IMAGE"
    : runtime === "python"
      ? "DOFE_SKILL_RUNNER_PYTHON_IMAGE"
      : "DOFE_SKILL_RUNNER_BASH_IMAGE";
  const value = env[key]?.trim();
  return value && /@sha256:[a-f0-9]{64}$/i.test(value) ? value : undefined;
}

export function isSkillRunnerImageAvailableLocally(image: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const result = spawnSync(env.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", ["image", "inspect", image], {
    env: minimalRunnerHostEnvironment(env),
    encoding: "utf8",
    timeout: 10_000,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function resolveRunnerTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.DOFE_SKILL_RUNNER_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function interpreterForRuntime(runtime: SkillEntrypointRuntime): string {
  return runtime === "python" ? "python3" : runtime === "bash" ? "bash" : "node";
}

function normalizeEntrypointPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Skill Runner entrypoint path must be a safe relative path.");
  }
  return normalized;
}

function buildLauncherCommand(entrypoint: DaemonSkillRunnerEntrypoint): string {
  return buildSkillRunnerCommandName(entrypoint.skillName, entrypoint.skillId, entrypoint.id);
}

function sanitizeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "entrypoint";
}

function assertInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Skill Runner output path escapes the task workspace.");
  }
}

function preparePublishedOutputDir(workDir: string, entrypointKey: string): string {
  const resolvedWorkDir = resolve(workDir);
  const workDirStat = lstatSync(resolvedWorkDir);
  if (!workDirStat.isDirectory() || workDirStat.isSymbolicLink()) {
    throw new Error("skill_runner.output_symlink_forbidden: task workspace must be a real directory");
  }
  let current = resolvedWorkDir;
  for (const segment of ["runtime-output", "skill-runs", sanitizeSegment(entrypointKey)]) {
    current = join(current, segment);
    if (existsSync(current)) {
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`skill_runner.output_symlink_forbidden: ${relative(resolvedWorkDir, current)}`);
      }
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
    assertInside(realpathSync(resolvedWorkDir), realpathSync(current));
  }
  return current;
}

function assertPublishedOutputDirTrusted(workDir: string, outputDir: string): void {
  const resolvedWorkDir = resolve(workDir);
  assertInside(resolvedWorkDir, outputDir);
  let current = outputDir;
  while (current !== resolvedWorkDir) {
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`skill_runner.output_symlink_forbidden: ${relative(resolvedWorkDir, current)}`);
    }
    current = resolve(current, "..");
  }
  if (realpathSync(outputDir) !== resolve(realpathSync(resolvedWorkDir), relative(resolvedWorkDir, outputDir))) {
    throw new Error("skill_runner.output_symlink_forbidden: output directory resolution changed");
  }
}

function createPrivateRunnerOutputDir(stateDir: string, entrypointKey: string): string {
  const root = resolve(stateDir, "skill-runner-output");
  if (existsSync(root)) {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("skill_runner.private_output_untrusted");
    }
  } else {
    mkdirSync(root, { mode: 0o700 });
  }
  const outputDir = mkdtempSync(join(root, `${sanitizeSegment(entrypointKey)}-`));
  chmodSync(outputDir, 0o777);
  return outputDir;
}

function createPrivateRunnerConfig(
  stateDir: string,
  entrypoint: Pick<DaemonSkillRunnerEntrypoint, "key" | "configKeys">,
  skillEnv: Readonly<Record<string, string>>,
): { dir: string; file: string } | undefined {
  const keys = entrypoint.configKeys ?? [];
  if (keys.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const key of keys) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
      throw new Error(`skill_runner.config_key_invalid: ${key}`);
    }
    if (!Object.prototype.hasOwnProperty.call(skillEnv, key) || typeof skillEnv[key] !== "string") {
      throw new Error(`skill_runner.config_missing: ${key}`);
    }
    values[key] = skillEnv[key]!;
  }
  const root = resolve(stateDir, "skill-runner-config");
  if (existsSync(root)) {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("skill_runner.private_config_untrusted");
    }
  } else {
    mkdirSync(root, { mode: 0o700 });
  }
  const dir = mkdtempSync(join(root, `${sanitizeSegment(entrypoint.key)}-`));
  const file = join(dir, "config.json");
  try {
    writeFileSync(file, JSON.stringify(values), { encoding: "utf8", mode: 0o400 });
    chmodSync(file, 0o444);
    return { dir, file };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function publishRunnerOutput(sourceDir: string, targetDir: string): void {
  let fileCount = 0;
  let totalBytes = 0;
  const copyDirectory = (source: string, target: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`skill_runner.output_symlink_forbidden: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        if (existsSync(targetPath)) {
          const targetStats = lstatSync(targetPath);
          if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
            throw new Error(`skill_runner.output_symlink_forbidden: ${entry.name}`);
          }
        } else {
          mkdirSync(targetPath, { mode: 0o700 });
        }
        copyDirectory(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`skill_runner.output_file_type_forbidden: ${entry.name}`);
      }
      const stats = statSync(sourcePath);
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > MAX_OUTPUT_FILES || stats.size > MAX_OUTPUT_FILE_BYTES || totalBytes > MAX_OUTPUT_TOTAL_BYTES) {
        throw new Error("skill_runner.output_budget_exceeded");
      }
      if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
        throw new Error(`skill_runner.output_symlink_forbidden: ${entry.name}`);
      }
      copyFileSync(sourcePath, targetPath);
      chmodSync(targetPath, stats.mode & 0o777);
    }
  };
  copyDirectory(sourceDir, targetDir);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function minimalRunnerHostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    DOCKER_HOST: env.DOCKER_HOST,
  };
}

function assertSkillRunnerCacheEntry(
  artifactDir: string,
  entrypoint: Pick<DaemonSkillRunnerEntrypoint, "path" | "sha256">,
): void {
  const rootStat = lstatSync(artifactDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o222) !== 0) {
    throw new Error("skill_runner.artifact_cache_untrusted");
  }
  if (!existsSync(join(artifactDir, ".cache-complete"))) {
    throw new Error("skill_runner.artifact_cache_incomplete");
  }
  const relativePath = normalizeEntrypointPath(entrypoint.path);
  const filePath = resolve(artifactDir, relativePath);
  assertInside(artifactDir, filePath);
  const fileStat = lstatSync(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o222) !== 0) {
    throw new Error("skill_runner.entrypoint_untrusted");
  }
  const actualDigest = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (actualDigest !== entrypoint.sha256.toLowerCase()) {
    throw new Error("skill_runner.entrypoint_digest_mismatch");
  }
}
