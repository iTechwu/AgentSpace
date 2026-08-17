import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { maybeFlushWorkflowWorkerSloSync, runWorkflowWorkerTick, type WorkflowWorkerSloFlushState } from "./worker.ts";

export async function runWorkflowWorker(): Promise<void> {
  const pollMs = readBoundedInteger("WORKFLOW_WORKER_POLL_MS", 1000, 100, 60_000);
  const batchSize = readBoundedInteger("WORKFLOW_WORKER_BATCH_SIZE", 20, 1, 100);
  const tickTimeoutMs = readBoundedInteger("WORKFLOW_WORKER_TICK_TIMEOUT_MS", 30_000, 1000, 300_000);
  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  // SLO 窗口节流落账状态：worker 进程的指标样本由本进程自行 flush 到集中 ledger。
  const sloFlushState: WorkflowWorkerSloFlushState = {};
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!stopping) {
      try {
        const result = await withTimeout(runWorkflowWorkerTick({ workerId, batchSize }), tickTimeoutMs);
        console.log(JSON.stringify({ level: "info", event: "workflow_worker_tick", workerId, ...result }));
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "workflow_worker_tick_failed", workerId, message: error instanceof Error ? error.message : String(error) }));
      }
      flushSloWindowBestEffort(workerId, sloFlushState);
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

function flushSloWindowBestEffort(workerId: string, state: WorkflowWorkerSloFlushState): void {
  try {
    maybeFlushWorkflowWorkerSloSync({ workerId, state, nowMs: Date.now() });
  } catch (error) {
    // SLO 落账失败不阻断工作循环；样本保留在窗口内，下个周期重试。
    console.error(JSON.stringify({
      level: "error",
      event: "workflow_worker_slo_flush_failed",
      workerId,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function readBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("workflow_worker_tick_timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runWorkflowWorker();
}
