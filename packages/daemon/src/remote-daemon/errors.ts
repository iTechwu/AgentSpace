// 3.5-4：自 remote-daemon.ts 拆出——远端轮询错误的处置分类（纯函数）。
import { DaemonAuthError, DaemonResourceGoneError, DaemonRuntimeUnavailableError } from "../daemon-client.ts";

/**
 * How the remote daemon loop should react to a given error. Extracted as a pure
 * function so the decision is unit-testable without driving real timers/exit.
 *
 * - `shutdown`:   fatal auth failure (401/403) — token is invalid/revoked; stop.
 * - `skip-runtime`: the targeted runtime is gone (404) or offline (409) — keep polling.
 * - `log`:        transient / unknown — log and let the next tick retry.
 */
export type RemoteLoopErrorAction = "shutdown" | "skip-runtime" | "log";

export function classifyRemoteLoopError(error: unknown): RemoteLoopErrorAction {
  if (error instanceof DaemonAuthError) {
    return "shutdown";
  }
  if (error instanceof DaemonResourceGoneError) {
    return "skip-runtime";
  }
  if (error instanceof DaemonRuntimeUnavailableError) {
    return "skip-runtime";
  }
  return "log";
}
