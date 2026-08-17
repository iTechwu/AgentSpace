import { isCapabilityDeploymentMode, isCapabilityPackageKind, isCapabilityRequestedAction } from "@dofe-agent/db";
import { submitCapabilityRequestSync } from "@dofe-agent/services/capabilities";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/workspaces/:workspaceId/capability-requests
 *
 * User-facing entry point for the unified install/deploy/connect task.
 * The browser submits only safe identifiers; the server decides the
 * `deploymentMode`, dispatches to the underlying subsystem (CLI install,
 * MCP connect, managed service provision) and returns the persisted task
 * envelope.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  if (!workspaceContext.currentUser) {
    return Response.json({ error: "Session is missing user identity." }, { status: 401 });
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
  const runtimeId = typeof body.runtimeId === "string" ? body.runtimeId.trim() : "";
  const packageKind = body.packageKind;
  const packageSource = typeof body.packageSource === "string" ? body.packageSource.trim() : "";
  const packageSlug = typeof body.packageSlug === "string" ? body.packageSlug.trim() : "";
  const packageDisplayName = typeof body.packageDisplayName === "string" ? body.packageDisplayName.trim() : packageSlug;
  const deploymentMode = body.deploymentMode;
  const requestedAction = body.requestedAction;
  const priority = body.priority === "urgent" ? "urgent" : "normal";
  const message = typeof body.message === "string" ? body.message.slice(0, 1024) : "";

  if (!runtimeId) {
    return Response.json({ error: "Field `runtimeId` is required." }, { status: 400 });
  }
  if (!isCapabilityPackageKind(packageKind)) {
    return Response.json({ error: "Field `packageKind` must be one of cli | mcp | service." }, { status: 400 });
  }
  if (!packageSource || !/^[a-z][a-z0-9_]{0,63}$/.test(packageSource)) {
    return Response.json({ error: "Field `packageSource` must be a snake_case identifier." }, { status: 400 });
  }
  if (!packageSlug || packageSlug.length > 128) {
    return Response.json({ error: "Field `packageSlug` must be a non-empty string ≤128 chars." }, { status: 400 });
  }
  if (!isCapabilityDeploymentMode(deploymentMode)) {
    return Response.json({ error: "Field `deploymentMode` must be one of runtime_builtin | runtime_package | managed_service | external_service." }, { status: 400 });
  }
  if (!isCapabilityRequestedAction(requestedAction)) {
    return Response.json({ error: "Field `requestedAction` must be one of install | deploy | connect | upgrade." }, { status: 400 });
  }
  // parse 走独立的 /knowledge/upload 路由
  if (requestedAction === "parse") {
    return Response.json({ error: "Field `requestedAction` cannot be `parse` here; use POST /knowledge/upload." }, { status: 400 });
  }

  try {
    const result = submitCapabilityRequestSync({
      workspaceId,
      runtimeId,
      actorUserId: workspaceContext.currentUser.id,
      packageKind,
      packageSource,
      packageSlug,
      packageDisplayName,
      deploymentMode,
      requestedAction,
      priority,
      message,
    });
    return Response.json(
      {
        capabilityRequest: result.capabilityRequest,
        nextAction: result.nextAction,
        dispatchedOperationId: result.dispatchedOperationId ?? null,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { workspaceId } = await context.params;
  if (workspaceId !== workspaceContext.currentWorkspace.id) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }
  const url = new URL(request.url);
  const requestedByMe = url.searchParams.get("mine") === "1";
  const statusFilter = url.searchParams.get("statuses")?.split(",") ?? null;
  const { listCapabilityRequestsSync, isCapabilityRequestStatus } = await import("@dofe-agent/db");
  const statuses = statusFilter?.filter(isCapabilityRequestStatus) ?? undefined;
  // Permission boundary: owners/admins can list all workspace requests (so they
  // can work the approval queue); everyone else is forced to their own requests
  // regardless of the `mine` param — a non-admin can never enumerate others.
  const role = workspaceContext.currentMembership?.role;
  const isAdmin = role === "owner" || role === "admin";
  const records = listCapabilityRequestsSync({
    workspaceId,
    statuses,
    requestedByUserId: isAdmin ? (requestedByMe ? workspaceContext.currentUser?.id : undefined) : workspaceContext.currentUser?.id,
    limit: 200,
  });
  return Response.json({ requests: records }, { headers: { "Cache-Control": "private, no-store" } });
}