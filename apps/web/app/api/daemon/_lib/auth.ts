import {
  readAgentRuntimeSync,
  readDaemonConnectionSync,
  readQueuedTaskSync,
  readRuntimeAppOperationSync,
  validateDaemonApiTokenSync,
  type AgentRuntimeRecord,
  type DaemonApiTokenRecord,
  type DaemonConnectionRecord,
  type QueuedTaskRecord,
} from "@dofe-agent/db";
import { resolveAgentRuntimeMode, tryRecordWorkspaceAuditEventSync } from "@dofe-agent/services";

export interface DaemonAuthContext {
  token: DaemonApiTokenRecord;
  workspaceId: string;
}

export function requireDaemonAuth(request: Request): DaemonAuthContext | Response {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header.startsWith("Bearer ")) {
    return Response.json({ error: "Missing daemon bearer token." }, { status: 401 });
  }

  const tokenValue = header.slice("Bearer ".length).trim();
  const token = validateDaemonApiTokenSync(tokenValue);
  if (!token) {
    return Response.json({ error: "Invalid daemon token." }, { status: 403 });
  }

  return {
    token,
    workspaceId: token.workspaceId,
  };
}

/** Managed provisioning is a deployment capability, never a daemon-selected mode. */
export function requireRemoteManagedRuntimeMode(): Response | null {
  if (resolveAgentRuntimeMode() === "remote") {
    return null;
  }
  return Response.json(
    { error: "Managed runtime operations are unavailable in local mode." },
    { status: 409 },
  );
}

export function requireManagedNodeBootstrapToken(auth: DaemonAuthContext): Response | null {
  if (auth.token.purpose === "managed_node_bootstrap") {
    return null;
  }
  return Response.json(
    { error: "Managed node registration requires a managed bootstrap token." },
    { status: 403 },
  );
}

export function readDaemonConnectionForDaemon(
  daemonKey: string,
  auth: DaemonAuthContext,
): DaemonConnectionRecord | Response {
  const daemon = readDaemonConnectionSync(daemonKey);
  if (!daemon) {
    return Response.json({ error: `Daemon "${daemonKey}" does not exist.` }, { status: 404 });
  }
  if (daemon.workspaceId !== auth.workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId: auth.workspaceId,
      resourceType: "daemon",
      resourceId: daemonKey,
      targetWorkspaceId: daemon.workspaceId,
    });
    return Response.json({ error: "Daemon does not belong to this workspace." }, { status: 403 });
  }
  if (auth.token.daemonConnectionId !== daemon.id) {
    return daemonBindingDenied(auth, "daemon", daemonKey);
  }
  return daemon;
}

export function readRuntimeForDaemon(
  runtimeId: string,
  auth: DaemonAuthContext,
  options: { requireOnline?: boolean } = {},
): AgentRuntimeRecord | Response {
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime) {
    return Response.json({ error: `Runtime "${runtimeId}" does not exist.` }, { status: 404 });
  }
  if (runtime.workspaceId !== auth.workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId: auth.workspaceId,
      resourceType: "runtime",
      resourceId: runtimeId,
      targetWorkspaceId: runtime.workspaceId,
    });
    return Response.json({ error: "Runtime does not belong to this workspace." }, { status: 403 });
  }
  if (!runtime.daemonConnectionId || runtime.daemonConnectionId !== auth.token.daemonConnectionId) {
    return daemonBindingDenied(auth, "runtime", runtimeId);
  }
  if (
    resolveAgentRuntimeMode() === "remote" &&
    (!runtime.managedCredentialId ||
      runtime.provisioningState !== "managed" ||
      (options.requireOnline && runtime.status !== "online"))
  ) {
    return Response.json({ error: "Remote mode requires a managed, online runtime." }, { status: 409 });
  }
  if (
    resolveAgentRuntimeMode() === "remote" &&
    auth.token.purpose !== "managed_node_bootstrap"
  ) {
    return Response.json(
      { error: "Managed runtime execution requires a managed bootstrap token." },
      { status: 403 },
    );
  }
  return runtime;
}

export function readTaskForDaemon(taskId: string, auth: DaemonAuthContext): QueuedTaskRecord | Response {
  const task = readQueuedTaskSync(taskId);
  if (!task) {
    return Response.json({ error: `Task "${taskId}" does not exist.` }, { status: 404 });
  }
  if (task.workspaceId !== auth.workspaceId) {
    recordDaemonWorkspaceAccessDenied({
      workspaceId: auth.workspaceId,
      resourceType: "task",
      resourceId: taskId,
      targetWorkspaceId: task.workspaceId,
    });
    return Response.json({ error: "Task does not belong to this workspace." }, { status: 403 });
  }
  const runtime = readRuntimeForDaemon(task.runtimeId, auth);
  if (runtime instanceof Response) {
    return runtime;
  }
  return task;
}

export function readRuntimeAppOperationForDaemon(
  operationId: string,
  auth: DaemonAuthContext,
) {
  const operation = readRuntimeAppOperationSync(operationId, auth.workspaceId);
  if (!operation) {
    return Response.json({ error: `Runtime app operation "${operationId}" does not exist.` }, { status: 404 });
  }
  const runtime = readRuntimeForDaemon(operation.runtimeId, auth);
  if (runtime instanceof Response) {
    return runtime;
  }
  return operation;
}

function daemonBindingDenied(
  auth: DaemonAuthContext,
  resourceType: "daemon" | "runtime",
  resourceId: string,
): Response {
  tryRecordWorkspaceAuditEventSync({
    workspaceId: auth.workspaceId,
    title: "Daemon binding access denied",
    note: `Daemon token "${auth.token.id}" is not bound to ${resourceType} "${resourceId}".`,
    code: "workspace.daemon_binding_access_denied",
    data: {
      actorType: "daemon_token",
      resourceType,
      resourceId,
      daemonTokenId: auth.token.id,
    },
  });
  return Response.json({ error: "Daemon token is not bound to this resource. Re-register the daemon with this token." }, { status: 403 });
}

function recordDaemonWorkspaceAccessDenied(input: {
  workspaceId: string;
  resourceType: "daemon" | "runtime" | "task";
  resourceId: string;
  targetWorkspaceId: string;
}): void {
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Cross-workspace daemon access denied",
    note:
      `Daemon token for workspace "${input.workspaceId}" was denied access to `
      + `${input.resourceType} "${input.resourceId}" in workspace "${input.targetWorkspaceId}".`,
    code: "workspace.cross_workspace_access_denied",
    data: {
      actorType: "daemon_token",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestedWorkspaceId: input.targetWorkspaceId,
    },
  });
}
