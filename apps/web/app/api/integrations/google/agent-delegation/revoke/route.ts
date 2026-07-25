import { NextResponse } from "next/server";
import { revokeAgentGoogleWorkspaceDelegationSync } from "@dofe-agent/db";
import { assertCanManageEmployeeForActorSync } from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const body = (await request.json()) as Partial<{ employeeName: string }>;
  const employeeName = body.employeeName?.trim();
  if (!employeeName) {
    return NextResponse.json({ error: "employeeName is required." }, { status: 400 });
  }

  assertCanManageEmployeeForActorSync({
    workspaceId: workspaceContext.currentWorkspace.id,
    employeeName,
    actorUserId: workspaceContext.currentUser.id,
  });

  try {
    revokeAgentGoogleWorkspaceDelegationSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      employeeName,
      userId: workspaceContext.currentUser.id,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Agent Google Workspace delegation does not exist.") {
      throw error;
    }
  }

  return NextResponse.json({ ok: true });
}
