import { evaluateDataProtectionHealthSync } from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Periodic data-protection alerting hook (docs/0801/employee-data-durability/02 §6).
 * Evaluates workspace head age, skill-artifact verification failures, recovery
 * conflicts, and the task-commit reconciliation backlog. Returns 503 when any
 * error-level alert is present so the scheduler/uptime monitor can page.
 */
export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ error: "CRON_SECRET is not configured." }, { status: 500 });
  }

  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ") || header.slice("Bearer ".length).trim() !== expected) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const health = evaluateDataProtectionHealthSync({ workspaceId: "default" });
  const errorAlerts = health.alerts.filter((alert) => alert.severity === "error");
  return Response.json(
    { ok: errorAlerts.length === 0, alerts: health.alerts, metrics: health.metrics, checkedAt: health.checkedAt },
    { status: errorAlerts.length === 0 ? 200 : 503 },
  );
}
