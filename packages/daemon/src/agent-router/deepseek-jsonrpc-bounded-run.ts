// Bounded-worker execution path for DeepSeek Harness JSON-RPC (feature-flag
// gated, default off). Reuses a persistent runtime process per (executable,
// model, cwd) via a pool; per-session cwd/environment are passed on
// `session/prompt`. This path reuses the simplified turn-completion of
// DeepSeekJsonRpcWorker until the one-shot StreamChunk/usage/retry state
// machine is factored into a shared module.
import type {
  AgentRouterEvent,
  AgentRouterObserver,
  AgentRouterRunRequest,
  AgentRouterRunResult,
} from "./types.ts";
import { DeepSeekJsonRpcWorkerPool, mintDeepSeekSessionId } from "./deepseek-jsonrpc-worker.ts";

function deepSeekJsonRpcPoolKey(request: AgentRouterRunRequest): string {
  return [request.executablePath ?? "", request.model ?? "", request.cwd].join("\u0000");
}

export async function runDeepSeekJsonRpcBoundedWorkerTask(
  pool: DeepSeekJsonRpcWorkerPool,
  request: AgentRouterRunRequest,
  observer: AgentRouterObserver,
): Promise<AgentRouterRunResult> {
  const sessionId = request.sessionId ?? mintDeepSeekSessionId();
  const startedAt = new Date().toISOString();
  const events: AgentRouterEvent[] = [];
  const worker = pool.acquire(deepSeekJsonRpcPoolKey(request), {
    executablePath: request.executablePath ?? "",
    cwd: request.cwd,
    env: request.env ?? {},
    model: request.model ?? "",
    maxSessions: 4,
  });

  try {
    observer.emit({ type: "harness_started", harness: "deepseek-harness", command: [request.executablePath ?? ""] });
    const outputText = await worker.runSession(sessionId, request.prompt, request.env, request.cwd, (event) => {
      events.push(event);
      observer.emit(event);
    });
    return {
      status: "completed",
      harness: "deepseek-harness",
      sessionId,
      outputText,
      events,
      diagnostics: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "failed",
      harness: "deepseek-harness",
      sessionId,
      events,
      diagnostics: [{
        code: "harness.unknown_failure",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      }],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
