import { approveCapabilityRequestSync, rejectCapabilityRequestSync } from "@dofe-agent/services/capabilities";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/:workspaceId/capability-requests/:requestId/decision
 *
 * Admin-only endpoint to approve or reject a pending capability request.
 * Approve dispatches to the underlying install/deploy/connect subsystem.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; requestId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId, requestId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!workspaceContext.currentUser) {
    return Response.json({ error: "Session is missing user identity." }, { status: 401 });
  }
  if (
    workspaceContext.currentMembership.role !== "owner"
    && workspaceContext.currentMembership.role !== "admin"
  ) {
    return Response.json({ error: "Only workspace owners and admins can decide capability requests." }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Body must be valid JSON." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const body = payload as Record<string, unknown>;
  const decision = body.decision === "approved" || body.decision === "rejected"
    ? body.decision
    : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 1024) : "";

  if (decision === null) {
    return Response.json({ error: "Field `decision` must be 'approved' or 'rejected'." }, { status: 400 });
  }

  try {
    if (decision === "approved") {
      const result = approveCapabilityRequestSync({
        requestId,
        workspaceId,
        actorUserId: workspaceContext.currentUser.id,
        decisionReason: reason || undefined,
      });
      return Response.json(
        {
          capabilityRequest: result.capabilityRequest,
          nextAction: result.nextAction,
          dispatchedOperationId: result.dispatchedOperationId ?? null,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (!reason.trim()) {
      return Response.json({ error: "Rejection requires a user-facing reason." }, { status: 400 });
    }
    const rejected = rejectCapabilityRequestSync({
      requestId,
      workspaceId,
      actorUserId: workspaceContext.currentUser.id,
      decisionReason: reason,
    });
    return Response.json(
      { capabilityRequest: rejected },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    return Response.json({ error: message }, { status: 400 });
  }
}