import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ExecController } from "@dofe-agent/sandbox";
import type { AgentRouterEvent, AgentRouterObserver, HarnessLaunchPlan } from "./types.ts";
import { normalizeSignal, redactText } from "./utils.ts";

const KILL_GRACE_PERIOD_MS = 5_000;

export interface SubprocessRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface SubprocessRunOptions {
  observer?: AgentRouterObserver;
  onReady?: (controller: ExecController) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export async function runLaunchPlan(
  harness: string,
  plan: HarnessLaunchPlan,
  options: SubprocessRunOptions = {},
): Promise<SubprocessRunResult> {
  let child: ChildProcess;
  try {
    child = spawn(plan.executable, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.reject(error);
  }

  options.observer?.emit({
    type: "harness_started",
    harness,
    pid: child.pid,
    command: [plan.executable, ...redactArgs(plan.args, plan)],
  } satisfies AgentRouterEvent);

  if (child.stdin) {
    child.stdin.on("error", () => {
      // The harness may exit before reading stdin. stderr/stdout still carry
      // the relevant diagnostic, so the runner should not fail separately here.
    });
    const stdinController: ExecController = {
      writeStdin: (data: string): void => {
        if (!child.stdin?.destroyed && child.stdin?.writable) {
          child.stdin.write(data);
        }
      },
      closeStdin: (): void => {
        if (!child.stdin?.destroyed && child.stdin?.writable) {
          child.stdin.end();
        }
      },
    };
    options.onReady?.(stdinController);
    if (plan.keepStdinOpen) {
      if (plan.stdin) {
        stdinController.writeStdin(plan.stdin);
      }
    } else {
      child.stdin.end(plan.stdin ?? "");
    }
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let timeout: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  return await new Promise<SubprocessRunResult>((resolve, reject) => {
    const terminate = (): void => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_PERIOD_MS);
    };
    const abortHandler = (): void => {
      aborted = true;
      terminate();
    };
    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", (chunk) => {
      const value = redactText(String(chunk), plan.redactions);
      stdout += value;
      options.onStdout?.(value);
    });

    child.stderr?.on("data", (chunk) => {
      const value = redactText(String(chunk), plan.redactions);
      stderr += value;
      options.onStderr?.(value);
    });

    if (plan.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, plan.timeoutMs);
    }

    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      const normalizedSignal = normalizeSignal(signal);
      options.observer?.emit({
        type: "harness_exited",
        exitCode,
        signal: normalizedSignal,
      } satisfies AgentRouterEvent);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: normalizedSignal,
        timedOut,
        aborted,
      });
    });
  });
}

function redactArgs(args: string[], plan: HarnessLaunchPlan): string[] {
  return args.map((arg) => redactText(arg, plan.redactions));
}
