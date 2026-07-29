import { readManagedRuntimeCleanupRequestSync } from "@dofe-agent/db";
import { completeManagedRuntimeCleanupSync } from "@dofe-agent/services";
import { requireDaemonAuth, requireManagedNodeBootstrapToken, requireRemoteManagedRuntimeMode } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }
  const modeError = requireRemoteManagedRuntimeMode();
  if (modeError) {
    return modeError;
  }
  const tokenError = requireManagedNodeBootstrapToken(auth);
  if (tokenError) {
    return tokenError;
  }

  const { requestId } = await context.params;
  const requestRecord = readManagedRuntimeCleanupRequestSync(requestId);
  if (!requestRecord) {
    return Response.json({ error: "Cleanup request not found." }, { status: 404 });
  }
  if (requestRecord.workspaceId !== auth.workspaceId) {
    return Response.json({ error: "Cleanup request does not belong to this workspace." }, { status: 403 });
  }
  if (requestRecord.daemonConnectionId !== auth.token.daemonConnectionId) {
    return Response.json({ error: "Cleanup request is not assigned to this daemon." }, { status: 403 });
  }

  const body = (await request.json()) as { result?: Record<string, unknown> } | undefined;

  const completed = completeManagedRuntimeCleanupSync(requestId, body?.result);
  if (!completed) {
    return Response.json({ error: "Cleanup request not found." }, { status: 404 });
  }
  if (completed.status !== "succeeded") {
    return Response.json(
      { error: `Cleanup request is ${completed.status}, not running.` },
      { status: 409 },
    );
  }

  return Response.json({ requestId, status: "succeeded" });
}
