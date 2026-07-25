import { NextResponse } from "next/server";
import { revokeGoogleOAuthCredentialSync } from "@dofe-agent/db";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    revokeGoogleOAuthCredentialSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      userId: workspaceContext.currentUser.id,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Google OAuth credential does not exist.") {
      throw error;
    }
  }

  return NextResponse.json({ ok: true });
}
