const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || "http://web:1455";
const cronSecret = process.env.CRON_SECRET?.trim();
const intervalMs = Math.max(5_000, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_INTERVAL_MS || 30_000));
const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() || "local";
const openMontageEnabled = Boolean(
  process.env.OPENMONTAGE_BASE_URL?.trim()
  && process.env.OPENMONTAGE_SERVICE_TOKEN?.trim(),
);

if (!cronSecret) {
  throw new Error("CRON_SECRET is required by the runtime maintenance worker.");
}

async function runMaintenance() {
  await runEndpoint("Task commit reconciliation", "/api/cron/task-commit-reconcile");
  if (runtimeMode === "remote") {
    await runEndpoint("Runtime maintenance", "/api/cron/runtime-provisioning");
  }
  if (openMontageEnabled) {
    await runEndpoint("OpenMontage reconciliation", "/api/cron/openmontage-reconcile");
  }
  setTimeout(runMaintenance, intervalMs);
}

async function runEndpoint(label, path) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    if (!response.ok) {
      console.error(`${label} failed with HTTP ${response.status}.`);
    }
  } catch (error) {
    console.error(`${label} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await runMaintenance();
