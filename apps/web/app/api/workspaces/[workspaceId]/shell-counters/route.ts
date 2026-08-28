import { NextResponse } from "next/server";
import { getWorkspaceContextForIdentifier } from "@/features/auth/server-workspace";
import { deriveWorkspaceShellCounters } from "@/features/dashboard/workspace-shell-counters";
import { getWorkspaceShellCounterData } from "@/features/dashboard/workspace-shell-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const { workspaceId: workspaceIdentifier } = await context.params;
  const workspaceContext = await getWorkspaceContextForIdentifier(workspaceIdentifier);
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (
    workspaceContext.currentWorkspace.id !== workspaceIdentifier &&
    workspaceContext.currentWorkspace.slug !== workspaceIdentifier
  ) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const startedAt = performance.now();
  const counters = getWorkspaceShellCounterData(
    workspaceContext.currentUser.displayName,
    workspaceContext.currentWorkspace.id,
    workspaceContext.currentUser.id,
    workspaceContext.currentMembership.role,
    workspaceContext.accessScope === "channel"
      ? { channelNames: workspaceContext.channelNames ?? [] }
      : undefined,
  );
  const durationMs = Math.round(performance.now() - startedAt);

  return NextResponse.json({
    data: deriveWorkspaceShellCounters(counters),
    meta: {
      durationMs,
      workspaceId: workspaceContext.currentWorkspace.id,
      workspaceSlug: workspaceContext.currentWorkspace.slug,
    },
  });
}
