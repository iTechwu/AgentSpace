import { listWorkspacesSync } from "@dofe-agent/db";
import { evaluateDataProtectionHealthSync, DATA_PROTECTION_ALERT_CODES } from "@dofe-agent/services/employees";
import { sendExternalPagerAlert } from "@dofe-agent/services/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Periodic data-protection alerting hook (docs/0801/employee-data-durability/02 §6).
 * Evaluates workspace head age, skill-artifact verification failures, recovery
 * conflicts, and the task-commit reconciliation backlog across every active
 * workspace. Returns 503 when any workspace has an error-level alert so the
 * scheduler/uptime monitor can page.
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

  const checkedAt = new Date().toISOString();
  const workspaces = listWorkspacesSync();
  const perWorkspace = workspaces.map((workspace) => {
    const health = evaluateDataProtectionHealthSync({ workspaceId: workspace.id });
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ok: !health.alerts.some((alert) => alert.severity === "error"),
      alerts: health.alerts,
      metrics: health.metrics,
      checkedAt: health.checkedAt,
    };
  });

  const anyError = perWorkspace.some((result) => !result.ok);
  // Run pager state reconciliation for every workspace on every cycle. Healthy
  // workspaces pass an empty alert set so previously active alerts can emit a
  // recovery and be cleared; restricting this to error cycles leaves recovery
  // state active forever after the workspace becomes healthy.
  await Promise.all(
    perWorkspace.map((result) => sendExternalPagerAlert({
      workspaceId: result.workspaceId,
      alerts: result.alerts,
      checkedAt,
      recoveryCodes: DATA_PROTECTION_ALERT_CODES,
    })),
  );

  return Response.json(
    {
      ok: !anyError,
      checkedAt,
      workspaceCount: perWorkspace.length,
      workspaces: perWorkspace,
    },
    { status: anyError ? 503 : 200 },
  );
}
