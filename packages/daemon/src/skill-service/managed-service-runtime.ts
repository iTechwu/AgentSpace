import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  buildManagedRuntimeDockerConnectivityArgs,
  resolveManagedRuntimeDockerNetwork,
} from "../managed-provider-credentials.ts";

/** Executes a `docker` invocation; injectable so tests never need a real daemon. */
export type ManagedContainerExec = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

/** Container lifecycle the worker consumes. Provision returns the reachable endpoint. */
export interface ManagedServiceContainerRuntime {
  provision(input: {
    serviceId: string;
    workspaceId: string;
    imageDigest: string;
    networkJson?: string;
    healthJson?: string;
    resourcesJson?: string;
    /** Hardening from the admitted catalog template. */
    runAsNonRoot?: boolean;
    readOnlyRootfs?: boolean;
    capDrop?: string[];
    /** Decrypted values for the catalog's declared secret fields (injected as env). */
    secrets?: Record<string, string>;
  }): Promise<{ endpointRef: string; healthRevision: string; containerName: string }>;
  retire(input: { serviceId: string; workspaceId: string }): Promise<void>;
}

export class DockerContainerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DockerContainerError";
    this.code = code;
  }
}

export const SKILL_SERVICE_HEALTH_POLL_INTERVAL_MS = 3_000;
export const SKILL_SERVICE_HEALTH_WAIT_MS = 90_000;
const DOCKER_PULL_TIMEOUT_MS = 10 * 60_000;
const DOCKER_CONTAINER_TIMEOUT_MS = 60_000;

/** Deterministic container name so a stateless daemon can address the container again on retire. */
export function buildManagedServiceContainerName(serviceId: string): string {
  const sanitized = serviceId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48);
  return `dofe-svc-${sanitized}`;
}

/**
 * Pure command builder for `docker create`. Pins the image by digest (no tag
 * drift), joins the isolated managed-runtime network, applies the catalog
 * resource limits + healthcheck, and honors the admitted hardening profile:
 * read-only rootfs (default on), all caps dropped by default (or the catalog
 * cap-drop list), no-new-privileges, and an explicit non-root user when the
 * template declares `runAsNonRoot`. Network policy beyond the isolated network
 * (egress allow-lists from networkJson) is enforced separately.
 */
export function buildManagedServiceContainerCreateArgs(input: {
  containerName: string;
  serviceId: string;
  workspaceId: string;
  imageDigest: string;
  network: string;
  networkJson?: string;
  healthJson?: string;
  resourcesJson?: string;
  runAsNonRoot?: boolean;
  readOnlyRootfs?: boolean;
  capDrop?: string[];
  secrets?: Record<string, string>;
}): string[] {
  const args = [
    "create",
    "--name", input.containerName,
    "--restart", "unless-stopped",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec",
    "--security-opt", "no-new-privileges",
    "--network", input.network,
    "--label", `dofe.agent.serviceId=${input.serviceId}`,
    "--label", `dofe.agent.workspaceId=${input.workspaceId}`,
  ];
  for (const [name, value] of Object.entries(input.secrets ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  if (input.readOnlyRootfs !== false) {
    args.push("--read-only");
  }
  for (const cap of input.capDrop?.length ? input.capDrop : ["ALL"]) {
    args.push("--cap-drop", cap);
  }
  if (input.runAsNonRoot) {
    // UID/GID 65532:65532 (nobody) — the runtime refuses to guess a root user.
    args.push("--user", "65532:65532");
  }
  args.push(
    ...buildManagedRuntimeDockerConnectivityArgs(),
    ...buildManagedServiceResourceArgs(input.resourcesJson),
    ...buildManagedServiceHealthcheckArgs(input.healthJson),
    input.imageDigest,
  );
  return args;
}

/** Pure: `--memory`/`--cpus`/`--memory-swap` from the catalog resourcesJson. */
export function buildManagedServiceResourceArgs(resourcesJson?: string): string[] {
  if (!resourcesJson) {
    return [];
  }
  let resources: Record<string, unknown>;
  try {
    resources = JSON.parse(resourcesJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const args: string[] = [];
  for (const [flag, key] of [["--memory", "memory"], ["--cpus", "cpu"], ["--memory-swap", "memorySwap"]] as const) {
    const value = resources[key];
    if (typeof value === "string" || typeof value === "number") {
      args.push(flag, String(value));
    }
  }
  return args;
}

/**
 * Pure: maps the catalog healthJson to docker healthcheck flags. Accepts an
 * explicit `cmd`, or builds a default HTTP probe from `path` (+ optional `port`).
 * No healthJson → no healthcheck (falls back to a running-state wait).
 */
export function buildManagedServiceHealthcheckArgs(healthJson?: string): string[] {
  if (!healthJson) {
    return [];
  }
  let health: Record<string, unknown>;
  try {
    health = JSON.parse(healthJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const cmd = typeof health.cmd === "string" ? health.cmd : undefined;
  const path = typeof health.path === "string" ? health.path : undefined;
  const healthCmd = cmd ?? (path
    ? `wget -q -O /dev/null http://127.0.0.1:${typeof health.port === "number" ? health.port : 8080}${path}`
    : undefined);
  if (!healthCmd) {
    return [];
  }
  return [
    "--health-cmd", healthCmd,
    "--health-interval", typeof health.interval === "string" ? health.interval : "10s",
    "--health-retries", typeof health.retries === "number" ? String(health.retries) : "3",
    "--health-start-period", typeof health.startPeriod === "string" ? health.startPeriod : "10s",
  ];
}

export function buildManagedServiceInspectArgs(containerName: string, format: string): string[] {
  return ["inspect", "--format", format, containerName];
}

/** sha256 of the health config (or "running") — a stable per-config revision. */
export function computeManagedServiceHealthRevision(healthJson?: string, state?: string): string {
  return createHash("sha256").update(`${healthJson ?? "running"}|${state ?? ""}`).digest("hex").slice(0, 16);
}

/** Real runtime: shells out to the local `docker` CLI (same spawn pattern as managed provisioning). */
export function createDockerManagedServiceContainerRuntime(
  exec: ManagedContainerExec = defaultDockerExec,
  options?: { healthWaitMs?: number; healthPollIntervalMs?: number },
): ManagedServiceContainerRuntime {
  const healthWaitMs = options?.healthWaitMs ?? SKILL_SERVICE_HEALTH_WAIT_MS;
  const healthPollIntervalMs = options?.healthPollIntervalMs ?? SKILL_SERVICE_HEALTH_POLL_INTERVAL_MS;
  return {
    async provision(input) {
      const network = resolveManagedRuntimeDockerNetwork();
      const containerName = buildManagedServiceContainerName(input.serviceId);

      await runChecked(exec, ["pull", input.imageDigest], { timeoutMs: DOCKER_PULL_TIMEOUT_MS }, "skill_service.image_pull_failed");

      const createArgs = buildManagedServiceContainerCreateArgs({
        containerName,
        serviceId: input.serviceId,
        workspaceId: input.workspaceId,
        imageDigest: input.imageDigest,
        network,
        networkJson: input.networkJson,
        healthJson: input.healthJson,
        resourcesJson: input.resourcesJson,
        runAsNonRoot: input.runAsNonRoot,
        readOnlyRootfs: input.readOnlyRootfs,
        capDrop: input.capDrop,
        secrets: input.secrets,
      });
      const create = await exec(createArgs, { timeoutMs: DOCKER_CONTAINER_TIMEOUT_MS });
      let createResult = create;
      if (create.exitCode !== 0) {
        // Deterministic name → a stale container from a crashed run may exist; clear and retry once.
        if (/already in use|already exists/i.test(create.stderr)) {
          await runChecked(exec, ["rm", "-f", containerName], { timeoutMs: 30_000 }, "skill_service.container_remove_failed");
          createResult = await runChecked(exec, createArgs, { timeoutMs: DOCKER_CONTAINER_TIMEOUT_MS }, "skill_service.container_create_failed");
        } else {
          throw new DockerContainerError("skill_service.container_create_failed", (create.stderr || create.stdout).trim());
        }
      }
      const containerId = createResult.stdout.trim().split(/\s+/).pop() ?? containerName;

      await runChecked(exec, ["start", containerId], { timeoutMs: DOCKER_CONTAINER_TIMEOUT_MS }, "skill_service.container_start_failed");

      const state = await waitForHealthy(exec, containerId, input.healthJson, healthWaitMs, healthPollIntervalMs);
      return {
        endpointRef: `runtime-private://${containerName}`,
        healthRevision: computeManagedServiceHealthRevision(input.healthJson, state),
        containerName,
      };
    },

    async retire(input) {
      const containerName = buildManagedServiceContainerName(input.serviceId);
      const removed = await exec(["rm", "-f", containerName], { timeoutMs: 30_000 });
      if (removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) {
        throw new DockerContainerError("skill_service.container_remove_failed", (removed.stderr || removed.stdout).trim());
      }
    },
  };
}

async function waitForHealthy(
  exec: ManagedContainerExec,
  containerId: string,
  healthJson: string | undefined,
  healthWaitMs: number,
  healthPollIntervalMs: number,
): Promise<string> {
  const hasHealthcheck = buildManagedServiceHealthcheckArgs(healthJson).length > 0;
  const format = hasHealthcheck ? "{{.State.Health.Status}}" : "{{.State.Running}}";
  const expected = hasHealthcheck ? "healthy" : "true";
  const deadline = Date.now() + healthWaitMs;
  let last = "";
  while (Date.now() < deadline) {
    const inspect = await exec(buildManagedServiceInspectArgs(containerId, format), { timeoutMs: 15_000 });
    if (inspect.exitCode === 0) {
      last = inspect.stdout.trim();
      if (last === expected) {
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, healthPollIntervalMs));
  }
  throw new DockerContainerError(
    "skill_service.container_health_timeout",
    `Container ${containerId} did not reach "${expected}" within ${healthWaitMs}ms (last state: "${last}")`,
  );
}

async function runChecked(
  exec: ManagedContainerExec,
  args: string[],
  options: { timeoutMs?: number },
  errorCode: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await exec(args, options);
  if (result.exitCode !== 0) {
    throw new DockerContainerError(errorCode, (result.stderr || result.stdout).trim());
  }
  return result;
}

function defaultDockerExec(args: string[], options?: { timeoutMs?: number }): ReturnType<ManagedContainerExec> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const timer = options?.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
