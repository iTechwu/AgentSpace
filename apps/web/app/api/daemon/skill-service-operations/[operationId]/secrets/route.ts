import { readManagedSkillServiceSync } from "@dofe-agent/db";
import { resolveWorkspaceServiceSecretsSync } from "@dofe-agent/services";
import { readManagedSkillServiceOperationForDaemon, requireDaemonAuth } from "../../../_lib/auth";
import { parseClaimGenerationQuery } from "../../../_lib/claim-generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Delivers the decrypted secret values for a claimed PROVISION operation so the
 * managed node can inject them as container env. Secrets never travel in the
 * (audited) claim payload — they are fetched over the daemon's authenticated
 * channel only after the operation is claimed. Retire operations carry none.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ operationId: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const { operationId } = await context.params;
  const operation = readManagedSkillServiceOperationForDaemon(operationId, auth);
  if (operation instanceof Response) {
    return operation;
  }
  const claimGeneration = parseClaimGenerationQuery(request);
  if (!claimGeneration.ok) {
    return claimGeneration.response;
  }
  const leaseExpiresAt = operation.leaseExpiresAt ? Date.parse(operation.leaseExpiresAt) : Number.NaN;
  if (
    operation.claimGeneration !== claimGeneration.value
    || !["claimed", "running"].includes(operation.status)
    || !Number.isFinite(leaseExpiresAt)
    || leaseExpiresAt <= Date.now()
  ) {
    return Response.json({ error: "skill_service.operation_lease_lost" }, { status: 409 });
  }
  if (operation.operation !== "provision") {
    return Response.json({ secrets: {} });
  }

  const managed = readManagedSkillServiceSync(operation.serviceId, auth.workspaceId);
  if (!managed) {
    return Response.json({ error: "Managed service does not exist." }, { status: 404 });
  }
  const secrets = resolveWorkspaceServiceSecretsSync({
    workspaceId: auth.workspaceId,
    serviceCatalogId: managed.catalogId,
  });
  return Response.json({ secrets });
}
