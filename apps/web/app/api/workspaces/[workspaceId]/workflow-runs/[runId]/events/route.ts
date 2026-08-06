import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { getWorkflowRunEventsPage, getWorkflowRunPageData } from "@/features/workflows/workflow-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { workspaceId, runId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }
  if (workspaceContext.accessScope === "channel") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const rawAfter = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(rawAfter)) {
    return NextResponse.json({ error: "Invalid event sequence." }, { status: 400 });
  }
  const after = Number(rawAfter);
  if (!Number.isSafeInteger(after) || after < 0) {
    return NextResponse.json({ error: "Invalid event sequence." }, { status: 400 });
  }

  const page = getWorkflowRunEventsPage(workspaceId, runId, after);
  if (!page) return NextResponse.json({ error: "Workflow run not found." }, { status: 404 });
  const projection = getWorkflowRunPageData(workspaceId, runId);
  return NextResponse.json({ ...page, projection: projection ? { ...projection, events: [] } : null });
}
