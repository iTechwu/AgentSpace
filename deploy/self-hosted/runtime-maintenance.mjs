const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || "http://web:1455";
const cronSecret = process.env.CRON_SECRET?.trim();
const intervalMs = Math.max(5_000, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_INTERVAL_MS || 30_000));
const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() || "local";
const openMontageEnabled = Boolean(
  process.env.OPENMONTAGE_BASE_URL?.trim()
  && process.env.OPENMONTAGE_SERVICE_TOKEN?.trim(),
);

if ((runtimeMode === "remote" || openMontageEnabled) && !cronSecret) {
  throw new Error("CRON_SECRET is required by the runtime maintenance worker.");
}

async function runMaintenance() {
  try {
    if (runtimeMode === "remote") {
      await runEndpoint("Runtime maintenance", "/api/cron/runtime-provisioning");
    }
    if (openMontageEnabled) {
      await runEndpoint("OpenMontage reconciliation", "/api/cron/openmontage-reconcile");
    }
  } catch (error) {
    console.error(`Runtime maintenance request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setTimeout(runMaintenance, intervalMs);
  }
}

async function runEndpoint(label, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  if (!response.ok) {
    console.error(`${label} failed with HTTP ${response.status}.`);
  }
}

if (runtimeMode === "remote" || openMontageEnabled) {
  await runMaintenance();
} else {
  console.log("Runtime maintenance is idle because no remote Runtime or OpenMontage integration is configured.");
  setInterval(() => {}, 24 * 60 * 60 * 1000);
}
