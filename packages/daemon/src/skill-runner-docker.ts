import { spawn } from "node:child_process";

/**
 * Skill Runner docker process primitives.
 *
 * Split out of skill-runner.ts so the broker module owns Runner lifecycle and
 * HTTP, while this module owns the ONLY ways the daemon shells out to docker
 * for a run: the direct `docker run` executor and the forced container
 * removal used by timeout/cleanup paths. The egress firewall executor
 * (skill-runner-egress.ts) composes these per phase.
 */

/** Stdout+stderr cap for a single run; exceeding it force-stops the container. */
export const SKILL_RUNNER_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Docker label carried by every Skill Runner container that runs behind an L3/L4
 * egress policy. The value is the policy `serviceId` (the per-run lease), so a
 * persisted policy can be matched back to its owning container. The crash-recovery
 * sweep uses this label to keep the firewall of a still-running Runner in place
 * across a daemon restart instead of blindly revoking every persisted chain.
 */
export const SKILL_RUNNER_EGRESS_POLICY_LABEL = "dofe.skill-runner.egress.policy";

export interface SkillRunnerExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class SkillRunnerContainerCleanupError extends Error {
  constructor(message: string) {
    super(`skill_runner.container_cleanup_failed: ${message}`);
    this.name = "SkillRunnerContainerCleanupError";
  }
}

/** The docker CLI only needs PATH/HOME/DOCKER_HOST — never the full daemon env. */
export function minimalRunnerHostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    DOCKER_HOST: env.DOCKER_HOST,
  };
}

export async function executeDockerSkillRunner(
  args: string[],
  timeoutMs: number,
  containerName?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SkillRunnerExecutionResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(/*turbopackIgnore: true*/ environment.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalRunnerHostEnvironment(environment),
    });
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let timedOut = false;
    let settled = false;
    let cleanupPromise: Promise<void> | undefined;
    const forceStop = (): void => {
      child.kill("SIGKILL");
      if (containerName) {
        cleanupPromise ??= forceRemoveDockerSkillRunnerContainer(containerName, environment);
      }
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > SKILL_RUNNER_MAX_OUTPUT_BYTES) {
        forceStop();
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      forceStop();
    }, timeoutMs);
    child.once("close", async (exitCode) => {
      if (settled) return;
      clearTimeout(timer);
      try {
        if (cleanupPromise) await cleanupPromise;
        if (totalBytes > SKILL_RUNNER_MAX_OUTPUT_BYTES) {
          stderr = "skill_runner.output_limit_exceeded";
        }
        settled = true;
        resolvePromise({ exitCode, stdout, stderr, timedOut });
      } catch (error) {
        settled = true;
        rejectPromise(error instanceof SkillRunnerContainerCleanupError
          ? error
          : new SkillRunnerContainerCleanupError(error instanceof Error ? error.message : String(error)));
      }
    });
  });
}

export function forceRemoveDockerSkillRunnerContainer(containerName: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(/*turbopackIgnore: true*/ environment.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", ["rm", "-f", containerName], {
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalRunnerHostEnvironment(environment),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        rejectPromise(new SkillRunnerContainerCleanupError(`Timed out removing ${containerName}.`));
      }
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectPromise(new SkillRunnerContainerCleanupError(error.message));
      }
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (exitCode === 0 || /no such container/i.test(`${stderr}\n${stdout}`)) {
        resolvePromise();
      } else {
        rejectPromise(new SkillRunnerContainerCleanupError(
          (stderr || stdout).trim() || `docker rm exited with code ${String(exitCode)}`,
        ));
      }
    });
  });
}

/**
 * Returns the set of egress-policy serviceIds whose Runner container is STILL
 * RUNNING. Used by the crash-recovery sweep: a policy whose owner is live must
 * be kept (removing its DOCKER-USER chain would re-open the container's network),
 * so only policies whose serviceId is absent here are safe to revoke.
 *
 * Queries RUNNING containers only (`docker ps`): a stopped leftover has no live
 * egress to protect and is force-removed by the next run's create-retry, so its
 * stale chain can be swept. Rejects on any docker failure so the caller can fall
 * back to the safe "keep everything" direction.
 */
export async function listLiveSkillRunnerEgressPolicyServiceIds(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Set<string>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(/*turbopackIgnore: true*/ environment.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", [
      "ps",
      "--filter", `label=${SKILL_RUNNER_EGRESS_POLICY_LABEL}`,
      "--format", "{{json .Labels}}",
    ], { stdio: ["ignore", "pipe", "pipe"], env: minimalRunnerHostEnvironment(environment) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        rejectPromise(new Error(`docker ps exited with code ${String(exitCode)}: ${(stderr || stdout).trim()}`));
        return;
      }
      const live = new Set<string>();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const labels = JSON.parse(trimmed) as Record<string, string>;
          const serviceId = labels[SKILL_RUNNER_EGRESS_POLICY_LABEL];
          if (serviceId) live.add(serviceId);
        } catch {
          // Skip an unparseable label line rather than failing enumeration.
        }
      }
      resolvePromise(live);
    });
  });
}
