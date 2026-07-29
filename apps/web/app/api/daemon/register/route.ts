import {
  grantRuntimeUseToUserSync,
  readWorkspaceMembershipSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import { isDaemonProvider, type RegisterDaemonRequest, type RegisterDaemonResponse } from "@dofe-agent/domain";
import { resolveAgentRuntimeMode, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";
import { requireDaemonAuth, requireManagedNodeBootstrapToken } from "../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const body = (await request.json()) as Partial<RegisterDaemonRequest>;
  const isManagedNode = body.metadata?.managedNode === true;
  const runtimes = body.runtimes ?? [];
  const isRemoteMode = resolveAgentRuntimeMode() === "remote";
  if (isRemoteMode && (!isManagedNode || runtimes.length > 0)) {
    return Response.json({ error: "Remote mode only accepts managed runtime nodes." }, { status: 409 });
  }
  if (!isRemoteMode && isManagedNode) {
    return Response.json({ error: "Managed runtime nodes are unavailable in local mode." }, { status: 409 });
  }
  if (isRemoteMode && isManagedNode) {
    const tokenError = requireManagedNodeBootstrapToken(auth);
    if (tokenError) {
      return tokenError;
    }
  }
  if (!body.daemonKey || !body.deviceName || (!isManagedNode && (!Array.isArray(body.runtimes) || body.runtimes.length === 0))) {
    return Response.json({ error: "daemonKey, deviceName, and runtimes[] are required." }, { status: 400 });
  }
  if (runtimes.some((runtime) => !runtime?.provider || !isDaemonProvider(runtime.provider))) {
    return Response.json({ error: "runtimes[].provider contains an unsupported provider id." }, { status: 400 });
  }
  if (body.workspaceId && body.workspaceId !== auth.workspaceId) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: auth.workspaceId,
      title: "Cross-workspace daemon access denied",
      note:
        `Daemon register request declared workspace "${body.workspaceId}" while the daemon token `
        + `belongs to workspace "${auth.workspaceId}".`,
      code: "workspace.cross_workspace_access_denied",
      data: {
        actorType: "daemon_token",
        resourceType: "daemon_registration",
        requestedWorkspaceId: body.workspaceId,
      },
    });
    return Response.json({ error: "workspaceId does not match the daemon token." }, { status: 403 });
  }

  let snapshot;
  try {
    snapshot = registerDaemonRuntimesSync({
      daemonKey: body.daemonKey.trim(),
      deviceName: body.deviceName.trim(),
      workspaceId: auth.workspaceId,
      daemonTokenId: auth.token.id,
      metadata: body.metadata,
      runtimes: runtimes.map((runtime) => ({
        provider: runtime.provider,
        providerAccountId: runtime.providerAccountId?.trim() || undefined,
        name: runtime.name.trim(),
        version: runtime.version?.trim(),
        deviceInfo: runtime.deviceInfo?.trim(),
        metadata: runtime.metadata,
      })),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "daemon.registration_failed";
    if (code === "daemon.key_workspace_mismatch") {
      return Response.json({ error: "daemonKey is already registered to another workspace." }, { status: 403 });
    }
    if (code === "daemon.token_binding_mismatch" || code === "daemon.connection_token_bound") {
      return Response.json({ error: "Daemon token is already bound to a different daemon." }, { status: 403 });
    }
    if (code === "provider_account.required_for_runtime") {
      return Response.json({ error: "This workspace has a configured provider account. Set DOFE_AGENT_PROVIDER_ACCOUNT_ID before registering the runtime." }, { status: 403 });
    }
    if (code === "provider_account.invalid_for_runtime") {
      return Response.json({ error: "Provider account does not belong to this workspace, is inactive, or does not match the runtime provider." }, { status: 403 });
    }
    throw error;
  }
  grantRegisteredRuntimesToTokenCreator({
    workspaceId: auth.workspaceId,
    createdBy: auth.token.createdBy,
    runtimeIds: snapshot.runtimes.map((runtime) => runtime.id),
  });

  const response: RegisterDaemonResponse = {
    daemon: {
      daemonKey: snapshot.daemon.daemonKey,
      status: snapshot.daemon.status,
      workspaceId: snapshot.daemon.workspaceId,
    },
    runtimes: snapshot.runtimes.map((runtime) => ({
      id: runtime.id,
      provider: runtime.provider,
      name: runtime.name,
      status: runtime.status,
    })),
  };

  return Response.json(response);
}

function grantRegisteredRuntimesToTokenCreator(input: {
  workspaceId: string;
  createdBy: string;
  runtimeIds: string[];
}): void {
  const userId = input.createdBy.trim();
  const membership = userId ? readWorkspaceMembershipSync(input.workspaceId, userId) : null;
  if (membership?.role !== "member") {
    return;
  }

  for (const runtimeId of input.runtimeIds) {
    grantRuntimeUseToUserSync({
      workspaceId: input.workspaceId,
      runtimeId,
      userId,
      grantedByUserId: userId,
    });
  }
}
