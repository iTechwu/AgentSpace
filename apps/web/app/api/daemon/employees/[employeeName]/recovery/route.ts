import {
  listRecoveryOperationsSync,
  readEmployeeRuntimeBindingSync,
} from "@dofe-agent/db";
import {
  createEmployeeRecoveryOperationSync,
  readEmployeeDataProtectionSnapshotSync,
} from "@dofe-agent/services";
import { requireDaemonAuth } from "../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recovery orchestration endpoint (EAD-005). The daemon reports a runtime
 * offline; the control plane reads the employee's expected state and rebuilds
 * the binding through the recovery phase machine (allocate → mount_workspace →
 * install_skills → resolve_secrets → health_check → activate).
 *
 * NOTE (docs/0801/employee-data-durability/02 §7): the admin permission model
 * for recovery/export/delete/rebind is still pending confirmation. This route
 * is workspace-scoped via the daemon token and audited by the recovery
 * operation rows; tighten authorization once the §7 model is decided.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ employeeName: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }
  const { employeeName } = await context.params;
  const binding = readEmployeeRuntimeBindingSync(employeeName, auth.workspaceId);
  if (!binding) {
    return Response.json({ error: `Employee "${employeeName}" has no runtime binding.` }, { status: 404 });
  }
  const snapshot = readEmployeeDataProtectionSnapshotSync({
    workspaceId: auth.workspaceId,
    employeeName,
  });
  const recoveryOperations = listRecoveryOperationsSync({
    workspaceId: auth.workspaceId,
    employeeName,
    limit: 10,
  });
  return Response.json({
    employeeName,
    binding: {
      runtimeId: binding.runtimeId,
      provider: binding.provider,
      status: binding.status,
      generation: binding.generation,
      desiredProvider: binding.desiredProvider,
    },
    dataProtection: {
      workspace: snapshot.workspace,
      headRevision: snapshot.headRevision
        ? { id: snapshot.headRevision.id, manifestDigest: snapshot.headRevision.manifestDigest, status: snapshot.headRevision.status }
        : null,
      recentArtifactCount: snapshot.recentArtifacts.length,
    },
    recoveryOperations: recoveryOperations.map((op) => ({
      id: op.id,
      phase: op.phase,
      fromGeneration: op.fromGeneration,
      toGeneration: op.toGeneration,
      errorMessage: op.errorMessage,
      createdAt: op.createdAt,
    })),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ employeeName: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }
  const { employeeName } = await context.params;
  const parsedBody = await request.json().catch(() => null) as unknown;
  const body = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? parsedBody as { action?: unknown; runtimeId?: unknown }
    : null;
  const action = body?.action ?? "rebuild";
  if (action !== "rebuild" && action !== "rebind") {
    return Response.json({ error: "action must be rebuild or rebind." }, { status: 400 });
  }
  const targetRuntimeId = typeof body?.runtimeId === "string" ? body.runtimeId.trim() : "";
  if (action === "rebind" && !targetRuntimeId) {
    return Response.json({ error: "runtimeId is required when action is rebind." }, { status: 400 });
  }

  const current = readEmployeeRuntimeBindingSync(employeeName, auth.workspaceId);
  if (!current) {
    return Response.json({ error: `Employee "${employeeName}" has no runtime binding to recover.` }, { status: 404 });
  }

  // Async recovery: create the operation (phase = allocate) and return 202; the
  // runtime-maintenance worker advances it phase-by-phase (provisioning, mount,
  // skill install, health probe, activate) across ticks. Poll the GET route for
  // progress.
  const operation = createEmployeeRecoveryOperationSync({
    workspaceId: auth.workspaceId,
    employeeName,
    requestedByUserId: auth.token?.createdBy,
    actorUserId: auth.token?.createdBy,
    requireApproval: action === "rebuild",
    requiredApprovals: action === "rebuild" ? 2 : 1,
    targetRuntimeId: action === "rebind" ? targetRuntimeId : undefined,
  });

  return Response.json(
    {
      employeeName,
      action,
      phase: operation.phase,
      toGeneration: operation.toGeneration,
      recoveryOperationId: operation.id,
      scheduled: true,
    },
    { status: 202 },
  );
}
