import { listWorkspacesSync } from "@dofe-agent/db";
import { runBackupRestoreDrillRunSync, notifyWorkspaceAdminsSync } from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Periodic backup/restore drill hook (docs/0801/employee-data-durability/02 §6).
 * Runs a metadata-level drill that samples employees and verifies their workspace
 * head manifest digest and bound skill artifact digests recompute identically —
 * across every active workspace. Persists the run records for audit and UI
 * history; returns 503 when any workspace fails so the scheduler can page.
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

  const workspaces = listWorkspacesSync();
  const runs = workspaces.map((workspace) => {
    const workspaceId = workspace.id;
    const run = runBackupRestoreDrillRunSync({ workspaceId, trigger: "cron", sampleLimit: 5 });

    if (run.status === "failed") {
      notifyWorkspaceAdminsSync({
        workspaceId,
        title: "备份恢复演练失败",
        body: run.errorMessage ?? "备份/恢复演练未通过，请检查数据保护状态。",
        type: "data_protection",
        severity: "critical",
        resourceType: "data_protection",
        resourceId: run.id,
        actionHref: `/w/${workspaceId}/agents?tab=data-protection`,
        dedupeKey: `backup-restore-drill-failed-${workspaceId}`,
      });
    }

    return { workspaceId, workspaceName: workspace.name, ok: run.status === "completed", run };
  });

  const anyFailure = runs.some((result) => !result.ok);
  return Response.json(
    {
      ok: !anyFailure,
      checkedAt: new Date().toISOString(),
      workspaceCount: runs.length,
      runs,
    },
    { status: anyFailure ? 503 : 200 },
  );
}
