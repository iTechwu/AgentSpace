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
  onReady?: (controller: HarnessProcessController) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface HarnessProcessController extends ExecController {
  terminate(): void;
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

  let killTimer: NodeJS.Timeout | undefined;
  let protocolAbortTimer: NodeJS.Timeout | undefined;
  const terminateChild = (): void => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, KILL_GRACE_PERIOD_MS);
  };

  if (child.stdin) {
    child.stdin.on("error", () => {
      // The harness may exit before reading stdin. stderr/stdout still carry
      // the relevant diagnostic, so the runner should not fail separately here.
    });
    const stdinController: HarnessProcessController = {
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
      terminate: (): void => {
        terminateChild();
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

  return await new Promise<SubprocessRunResult>((resolve, reject) => {
    const abortHandler = (): void => {
      aborted = true;
      options.onAbort?.();
      // Give a protocol adapter a short, bounded window to flush its cancel
      // request before the subprocess termination ladder starts.
      if (options.onAbort) {
        protocolAbortTimer ??= setTimeout(() => {
          protocolAbortTimer = undefined;
          terminateChild();
        }, 50);
      } else {
        terminateChild();
      }
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
        terminateChild();
      }, plan.timeoutMs);
    }

    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(protocolAbortTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(protocolAbortTimer);
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
