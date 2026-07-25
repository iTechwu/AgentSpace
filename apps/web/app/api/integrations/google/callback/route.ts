import { NextResponse } from "next/server";
import { readWorkspaceMembershipSync, upsertAgentGoogleWorkspaceDelegationSync } from "@dofe-agent/db";
import { assertCanManageEmployeeForActorSync } from "@dofe-agent/services";
import { buildPublicAppUrl } from "@/features/auth/public-app-url";
import { getCurrentUser } from "@/features/auth/server-auth";
import {
  readGoogleWorkspaceOAuthConfig,
  saveGoogleWorkspaceCredentialFromAuthorizationCode,
  verifyGoogleWorkspaceOAuthCallbackState,
} from "@/features/integrations/google-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const { appUrl } = readGoogleWorkspaceOAuthConfig();
  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();
  const error = url.searchParams.get("error")?.trim();

  if (error) {
    return NextResponse.redirect(
      buildPublicAppUrl(`/auth/error?code=${encodeURIComponent(error)}`, appUrl),
    );
  }
  if (!code || !state) {
    return NextResponse.redirect(
      buildPublicAppUrl("/auth/error?code=google_workspace.exchange_failed", appUrl),
    );
  }

  let redirectAfter: string | undefined;
  try {
    const verifiedState = await verifyGoogleWorkspaceOAuthCallbackState(state);
    redirectAfter = verifiedState.redirectAfter;
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.id !== verifiedState.userId) {
      throw new Error("google_workspace.unauthorized");
    }

    const membership = readWorkspaceMembershipSync(verifiedState.workspaceId, currentUser.id);
    if (!membership || membership.status !== "active") {
      throw new Error("google_workspace.workspace_forbidden");
    }

    const credential = await saveGoogleWorkspaceCredentialFromAuthorizationCode({
      workspaceId: verifiedState.workspaceId,
      userId: currentUser.id,
      code,
    });
    if (verifiedState.agentName) {
      assertCanManageEmployeeForActorSync({
        workspaceId: verifiedState.workspaceId,
        employeeName: verifiedState.agentName,
        actorUserId: currentUser.id,
      });
      upsertAgentGoogleWorkspaceDelegationSync({
        workspaceId: verifiedState.workspaceId,
        employeeName: verifiedState.agentName,
        userId: currentUser.id,
        googleOAuthCredentialId: credential.id,
        scopes: credential.scopes,
        googleEmail: credential.googleEmail,
        grantedByUserId: currentUser.id,
      });
    }

    const redirectPath = appendStatusParam(
      redirectAfter || "/",
      verifiedState.agentName ? "agentGoogleWorkspace" : "googleWorkspace",
      "connected",
    );
    return NextResponse.redirect(buildPublicAppUrl(redirectPath, appUrl));
  } catch (callbackError) {
    const codeValue = callbackError instanceof Error ? callbackError.message : "google_workspace.exchange_failed";
    const target = redirectAfter
      ? appendStatusParam(redirectAfter, "googleWorkspaceError", codeValue)
      : `/auth/error?code=${encodeURIComponent(codeValue)}`;
    return NextResponse.redirect(buildPublicAppUrl(target, appUrl));
  }
}

function appendStatusParam(path: string, key: string, value: string): string {
  const url = new URL(path, "http://dofe-agent.local");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}${url.hash}`;
}
