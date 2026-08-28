// 3.5-4：自 remote-daemon.ts 拆出——控制平面子队列认领的限流告警封装。
import { DaemonAuthError, DaemonResourceGoneError, DaemonRuntimeUnavailableError } from "../daemon-client.ts";

const REMOTE_QUEUE_WARNING_INTERVAL_MS = 30_000;
const remoteQueueWarningAt = new Map<string, number>();

/**
 * Keeps an unavailable control-plane subqueue from starving unrelated work on
 * the same runtime. Authentication and runtime eligibility failures still
 * abort the runtime poll because later claims cannot safely succeed.
 */
export async function claimRemoteQueue<T>(input: {
  runtimeId: string;
  queue: string;
  claim: () => Promise<T>;
  now?: number;
}): Promise<T | undefined> {
  try {
    return await input.claim();
  } catch (error) {
    if (error instanceof DaemonAuthError || error instanceof DaemonRuntimeUnavailableError) {
      throw error;
    }

    const now = input.now ?? Date.now();
    const warningKey = `${input.runtimeId}:${input.queue}`;
    const lastWarningAt = remoteQueueWarningAt.get(warningKey) ?? 0;
    if (now - lastWarningAt >= REMOTE_QUEUE_WARNING_INTERVAL_MS) {
      remoteQueueWarningAt.set(warningKey, now);
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Runtime ${input.runtimeId} ${input.queue} claim failed; continuing other queues: ${message}`);
    }
    return undefined;
  }
}
