import {
  listRecoveryOperationsSync,
  readEmployeeRuntimeBindingSync,
} from "@dofe-agent/db";
import {
  readEmployeeDataProtectionSnapshotSync,
  runFullRecoverySync,
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
  const body = (await request.json().catch(() => null)) as
    | { action?: "rebuild" | "rebind"; runtimeId?: string }
    | null;
  const action = body?.action ?? "rebuild";

  const current = readEmployeeRuntimeBindingSync(employeeName, auth.workspaceId);
  if (!current) {
    return Response.json({ error: `Employee "${employeeName}" has no runtime binding to recover.` }, { status: 404 });
  }

  const result = runFullRecoverySync({
    workspaceId: auth.workspaceId,
    employeeName,
    targetRuntimeId: body?.runtimeId,
  });

  const success = result.phase === "completed";
  return Response.json(
    {
      employeeName,
      action,
      phase: result.phase,
      toGeneration: result.toGeneration,
      error: result.errorMessage ?? undefined,
      recoveryOperationId: result.id,
    },
    { status: success ? 200 : 409 },
  );
}
