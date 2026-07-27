const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || "http://web:1455";
const cronSecret = process.env.CRON_SECRET?.trim();
const intervalMs = Math.max(5_000, Number(process.env.DOFE_AGENT_RUNTIME_MAINTENANCE_INTERVAL_MS || 30_000));
const runtimeMode = process.env.DOFE_AGENT_RUNTIME_MODE?.trim().toLowerCase() || "local";

if (runtimeMode === "remote" && !cronSecret) {
  throw new Error("CRON_SECRET is required by the runtime maintenance worker.");
}

async function runMaintenance() {
  try {
    const response = await fetch(`${baseUrl}/api/cron/runtime-provisioning`, {
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    if (!response.ok) {
      console.error(`Runtime maintenance failed with HTTP ${response.status}.`);
    }
  } catch (error) {
    console.error(`Runtime maintenance request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setTimeout(runMaintenance, intervalMs);
  }
}

if (runtimeMode === "remote") {
  await runMaintenance();
} else {
  console.log("Runtime maintenance is idle because DOFE_AGENT_RUNTIME_MODE is not remote.");
  setInterval(() => {}, 24 * 60 * 60 * 1000);
}
