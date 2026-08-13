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
    const child = spawn(environment.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", args, {
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
    const child = spawn(environment.DOFE_SKILL_RUNNER_DOCKER_BIN?.trim() || "docker", ["rm", "-f", containerName], {
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
