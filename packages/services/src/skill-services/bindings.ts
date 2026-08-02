import {
  completeManagedSkillServiceOperationSync as completeOperationDbSync,
  completeManagedSkillServiceProvisioningSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceCatalogSync,
  readManagedSkillServiceOperationSync,
  readManagedSkillServiceSync,
  readSkillServiceCatalogSync,
  retireManagedSkillServiceSync,
  type ManagedSkillServiceOperationRecord,
} from "@dofe-agent/db";
import type { ClaimedManagedSkillServiceOperation } from "@dofe-agent/domain";
import { evaluateSkillInstallationReadinessSync } from "../skills/installations.ts";

/** Builds the one-time authenticated payload delivered to the managed node on claim. */
export function resolveClaimedManagedSkillServiceOperation(
  operation: ManagedSkillServiceOperationRecord,
): ClaimedManagedSkillServiceOperation | null {
  const managed = readManagedSkillServiceSync(operation.serviceId, operation.workspaceId);
  if (!managed) {
    return null;
  }
  const catalog = listSkillServiceCatalogSync(operation.workspaceId).find((entry) => entry.id === managed.catalogId);
  if (!catalog) {
    return null;
  }
  return {
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    runtimeId: operation.runtimeId,
    serviceId: operation.serviceId,
    installationId: operation.installationId,
    operation: operation.operation,
    status: operation.status,
    catalog: {
      imageDigest: catalog.imageDigest,
      protocol: catalog.protocol,
      networkJson: catalog.networkJson,
      healthJson: catalog.healthJson,
      resourcesJson: catalog.resourcesJson,
    },
  };
}

/**
 * Control-plane service lifecycle (02-架构设计.md §4.3): the managed node
 * creates/retires the `managed_skill_service` container; the CONTROL PLANE
 * creates the `skill_service_binding` after the daemon reports the service
 * healthy, then re-evaluates the dependent installation.
 */

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
  const service = createManagedSkillServiceSync({
    workspaceId,
    runtimeId: input.runtimeId,
    catalogId: catalog.id,
    status: "provisioning",
  });
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

const ACTIVE_OPERATION_STATUSES = new Set(["pending", "claimed", "running"]);

/**
 * Completes a managed service provision operation reported by the daemon:
 * marks the service ready, creates the installation binding (the control-plane
 * artifact), and re-evaluates the installation so its service component can
 * reach ready. Rejects an operation without a verifiable endpointRef.
 */
export function completeManagedSkillServiceProvisionOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  endpointRef: string;
  healthRevision?: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  if (!input.endpointRef.trim() || !input.endpointRef.startsWith("runtime-private://")) {
    return { ok: false, code: "invalid_endpoint", reason: "endpointRef must be a runtime-private:// reference." };
  }
  const operation = readManagedSkillServiceOperationSync(input.operationId, workspaceId);
  if (!operation) {
    return { ok: false, code: "operation_not_found", reason: "Service operation does not exist." };
  }
  const done = completeOperationDbSync({ operationId: input.operationId, workspaceId });
  if (!done) {
    return { ok: false, code: "not_completable", reason: "Operation is no longer completable." };
  }
  completeManagedSkillServiceProvisioningSync({ serviceId: operation.serviceId, workspaceId });
  if (operation.installationId) {
    createSkillServiceBindingSync({
      installationId: operation.installationId,
      serviceId: operation.serviceId,
      catalogTemplateVersion: "1",
      serviceImageDigest: "managed",
      endpointRef: input.endpointRef.trim(),
      healthRevision: input.healthRevision ?? "1",
      configSchemaVersion: 1,
    });
    evaluateSkillInstallationReadinessSync(operation.installationId, workspaceId);
  }
  return { ok: true };
}

/**
 * Completes a managed service RETIRE operation reported by the daemon: marks
 * the service retired and re-evaluates the dependent installation (its service
 * component goes blocked again — resolveServiceComponentStatus requires a ready
 * managed service). No endpointRef is involved; a retire has nothing to bind.
 */
export function completeManagedSkillServiceRetireOperationSync(input: {
  operationId: string;
  workspaceId?: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const operation = readManagedSkillServiceOperationSync(input.operationId, workspaceId);
  if (!operation) {
    return { ok: false, code: "operation_not_found", reason: "Service operation does not exist." };
  }
  const done = completeOperationDbSync({ operationId: input.operationId, workspaceId });
  if (!done) {
    return { ok: false, code: "not_completable", reason: "Operation is no longer completable." };
  }
  retireManagedSkillServiceSync({ serviceId: operation.serviceId, workspaceId });
  if (operation.installationId) {
    evaluateSkillInstallationReadinessSync(operation.installationId, workspaceId);
  }
  return { ok: true };
}
