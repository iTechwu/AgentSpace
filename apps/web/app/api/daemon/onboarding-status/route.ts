import { listDaemonSnapshotsSync } from "@dofe-agent/db";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { hasWorkspaceRole } from "@/features/auth/workspace-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!hasWorkspaceRole(workspaceContext.currentMembership.role, "admin")) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const url = new URL(request.url);
  const daemonKey = url.searchParams.get("daemonKey")?.trim() ?? "";
  if (!daemonKey) {
    return Response.json({ error: "daemonKey is required." }, { status: 400 });
  }

  const snapshot = listDaemonSnapshotsSync(workspaceContext.currentWorkspace.id)
    .find((item) => item.daemon.daemonKey === daemonKey);
  if (!snapshot) {
    return Response.json({
      status: "pending",
      daemonKey,
      runtimeCount: 0,
      runtimes: [],
    });
  }

  return Response.json({
    status: snapshot.daemon.status === "online" ? "online" : "offline",
    daemonKey: snapshot.daemon.daemonKey,
    runtimeCount: snapshot.runtimes.length,
    runtimes: snapshot.runtimes.map((runtime) => ({
      id: runtime.id,
      provider: runtime.provider,
      name: runtime.name,
      status: runtime.status,
    })),
  });
}
