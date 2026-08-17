// 容器内 runtime 维护轮询（自旋兜底 cron）。
// P1 治理（见 docs/optimization-suggestions.md §145）：fetch 增加 AbortSignal 超时，
// 连续失败按指数退避（封顶 10 分钟），成功即复位；SIGTERM/SIGINT 优雅退出；
// 周期性输出结构化心跳（含成功/失败计数），供容器日志告警接入。
const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || "http://web:1455";
const cronSecret = process.env.CRON_SECRET?.trim();
const intervalMs = Math.max(5_000, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_INTERVAL_MS || 30_000));
const requestTimeoutMs = Math.max(1_000, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_TIMEOUT_MS || 30_000));
const maxBackoffMs = Math.max(intervalMs, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_MAX_BACKOFF_MS || 600_000));
const statsEveryCycles = Math.max(1, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_STATS_EVERY || 20));
const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() || "local";
const openMontageEnabled = Boolean(
  process.env.OPENMONTAGE_BASE_URL?.trim()
  && process.env.OPENMONTAGE_SERVICE_TOKEN?.trim(),
);

if (!cronSecret) {
  throw new Error("CRON_SECRET is required by the runtime maintenance worker.");
}

let timer = null;
let stopping = false;
let consecutiveFailures = 0;
let cycle = 0;
const counters = { ok: 0, httpError: 0, requestError: 0 };

function schedule(delayMs) {
  if (stopping) return;
  // 注意不要 unref：本进程是容器主进程，维护定时器须保活事件循环
  timer = setTimeout(runMaintenance, delayMs);
}

async function runMaintenance() {
  if (stopping) return;
  cycle += 1;
  const failuresBefore = counters.httpError + counters.requestError;
  await runEndpoint("Task commit reconciliation", "/api/cron/task-commit-reconcile");
  if (runtimeMode === "remote") {
    await runEndpoint("Runtime maintenance", "/api/cron/runtime-provisioning");
  }
  if (openMontageEnabled) {
    await runEndpoint("OpenMontage reconciliation", "/api/cron/openmontage-reconcile");
  }
  const failed = counters.httpError + counters.requestError > failuresBefore;

  if (failed) {
    consecutiveFailures += 1;
    const backoffMs = Math.min(intervalMs * 2 ** consecutiveFailures, maxBackoffMs);
    console.error(
      `[runtime-maintenance] cycle ${cycle} failed (${consecutiveFailures} consecutive), backing off ${Math.round(backoffMs / 1000)}s`,
    );
    schedule(backoffMs);
    return;
  }
  if (consecutiveFailures > 0) {
    console.log(`[runtime-maintenance] recovered after ${consecutiveFailures} failed cycle(s)`);
    consecutiveFailures = 0;
  }
  if (cycle % statsEveryCycles === 0) {
    console.log(
      `[runtime-maintenance] heartbeat cycle=${cycle} ok=${counters.ok} httpError=${counters.httpError} requestError=${counters.requestError}`,
    );
  }
  schedule(intervalMs);
}

async function runEndpoint(label, path) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      counters.httpError += 1;
      console.error(`${label} failed with HTTP ${response.status}.`);
      return;
    }
    counters.ok += 1;
  } catch (error) {
    counters.requestError += 1;
    console.error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  console.log(`[runtime-maintenance] received ${signal}, stopping (cycle=${cycle})`);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

schedule(0);
