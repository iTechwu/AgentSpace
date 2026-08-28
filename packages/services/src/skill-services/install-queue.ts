import {
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceBindingsForServiceSync,
  readSkillServiceCatalogSync,
  setManagedSkillServiceUnreferencedSinceSync,
} from "@dofe-agent/db";

/**
 * Provision-queue entrypoint kept in its own module (depending only on the DB
 * layer) so skills/installations.ts can queue managed services without the
 * skills ↔ skill-services import cycle through bindings.ts.
 */

export const ACTIVE_OPERATION_STATUSES = new Set(["pending", "claimed", "running"]);

/**
 * Queues a `provision` operation for a required service on a runtime. Dedupes
 * the managed service per (workspace, runtime, catalog) so re-plans reuse the
 * instance (createManagedSkillServiceSync is idempotent on the 3-tuple), and
 * skips creating a NEW operation while the service already has an active
 * (pending/claimed/running) provision operation — so a re-plan does not stack
 * duplicate container-lifecycle requests. The operation records the triggering
 * installation so the control plane can bind it on completion.
 */
export function queueManagedSkillServiceForInstallationSync(input: {
  workspaceId?: string;
  runtimeId: string;
  installationId: string;
  catalogSlug: string;
  templateVersion: string;
}): { serviceId: string; queued: boolean } {
  const workspaceId = input.workspaceId ?? "default";
  const catalog = readSkillServiceCatalogSync(input.catalogSlug, input.templateVersion, workspaceId);
  if (!catalog) {
    throw new Error(`Skill service catalog entry "${input.catalogSlug}@${input.templateVersion}" does not exist.`);
  }
  if (catalog.deploymentType !== "managed_service") {
    throw new Error(
      `skill_service.deployment_type_not_executable: "${catalog.deploymentType}" cannot create a managed-node Docker operation.`,
    );
  }
  const service = createManagedSkillServiceSync({
    workspaceId,
    runtimeId: input.runtimeId,
    catalogId: catalog.id,
    status: "provisioning",
  });
  const existingBinding = listSkillServiceBindingsForServiceSync(service.id)
    .find((binding) => binding.endpointRef.startsWith("runtime-private://"));
  createSkillServiceBindingSync({
    installationId: input.installationId,
    serviceId: service.id,
    catalogTemplateVersion: catalog.templateVersion,
    serviceImageDigest: catalog.imageDigest,
    endpointRef: existingBinding?.endpointRef ?? "",
    healthRevision: existingBinding?.healthRevision ?? "",
    configSchemaVersion: catalog.configSchemaVersion,
  });
  if (service.status === "ready" && existingBinding) {
    setManagedSkillServiceUnreferencedSinceSync({ serviceId: service.id, workspaceId });
    return { serviceId: service.id, queued: false };
  }
  const hasActiveProvisionOperation = listManagedSkillServiceOperationsSync({
    workspaceId,
    serviceId: service.id,
  }).some((operation) => operation.operation === "provision" && ACTIVE_OPERATION_STATUSES.has(operation.status));
  if (hasActiveProvisionOperation) {
    return { serviceId: service.id, queued: false };
  }
  createManagedSkillServiceOperationSync({
    workspaceId,
    runtimeId: input.runtimeId,
    serviceId: service.id,
    installationId: input.installationId,
    operation: "provision",
  });
  return { serviceId: service.id, queued: true };
}
