import {
  completeManagedSkillServiceOperationSync as completeOperationDbSync,
  completeManagedSkillServiceProvisioningSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  createSkillServiceBindingSync,
  getDatabase,
  listManagedSkillServiceOperationsSync,
  listManagedSkillServicesSync,
  listSkillServiceBindingsForServiceSync,
  listSkillServiceCatalogSync,
  readManagedSkillServiceOperationSync,
  readManagedSkillServiceSync,
  readSkillServiceCatalogSync,
  retireManagedSkillServiceSync,
  setManagedSkillServiceUnreferencedSinceSync,
  switchSkillServiceBindingsSync,
  withTransaction,
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
    claimGeneration: operation.claimGeneration,
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
      runAsNonRoot: catalog.runAsNonRoot,
      readOnlyRootfs: catalog.readOnlyRootfs,
      capDrop: parseCapDropJson(catalog.capDropJson),
      signatureKeyPem: catalog.signatureKeyPem ?? undefined,
      signatureRequired: catalog.signatureRequired === true,
    },
  };
}

function parseCapDropJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : ["ALL"];
  } catch {
    return ["ALL"];
  }
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

const ACTIVE_OPERATION_STATUSES = new Set(["pending", "claimed", "running"]);

/**
 * Completes a managed service provision operation reported by the daemon:
 * marks the service ready, creates the installation binding (the control-plane
 * artifact), and re-evaluates the installation so its service component can
 * reach ready. Rejects an operation without a verifiable endpointRef.
 */
export function completeManagedSkillServiceProvisionOperationSync(input: {
  operationId: string;
  claimGeneration: number;
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
  // Resolve catalog BEFORE marking anything ready so a missing context cannot
  // leave a succeeded operation or ready-but-unbound service.
  const service = readManagedSkillServiceSync(operation.serviceId, workspaceId);
  const catalog = service
    ? listSkillServiceCatalogSync(workspaceId).find((entry) => entry.id === service.catalogId)
    : undefined;
  if (!service || !catalog) {
    return { ok: false, code: "upgrade_context_missing", reason: "Canary upgrade context (service/catalog) is missing." };
  }
  return withTransaction(getDatabase(), () => {
    const done = completeOperationDbSync({
      operationId: input.operationId,
      claimGeneration: input.claimGeneration,
      workspaceId,
    });
    if (!done) {
      return { ok: false, code: "not_completable", reason: "Operation is no longer completable." };
    }
    completeManagedSkillServiceProvisioningSync({ serviceId: operation.serviceId, workspaceId });
    if (operation.replacesServiceId) {
      // Blue-green: switch every green binding onto this instance, re-stamped
      // with the new catalog + live endpoint in the same transaction.
      const switched = switchSkillServiceBindingsSync({
        workspaceId,
        fromServiceId: operation.replacesServiceId,
        toServiceId: operation.serviceId,
        toCatalogTemplateVersion: catalog.templateVersion,
        toServiceImageDigest: catalog.imageDigest,
        endpointRef: input.endpointRef.trim(),
        healthRevision: input.healthRevision,
        configSchemaVersion: catalog.configSchemaVersion,
      });
      for (const installationId of switched.installationIds) {
        evaluateSkillInstallationReadinessSync(installationId, workspaceId);
      }
      return { ok: true };
    }

    const waitingInstallationIds = new Set(
      listSkillServiceBindingsForServiceSync(operation.serviceId).map((binding) => binding.installationId),
    );
    if (operation.installationId) {
      waitingInstallationIds.add(operation.installationId);
    }
    for (const installationId of waitingInstallationIds) {
      createSkillServiceBindingSync({
        installationId,
        serviceId: operation.serviceId,
        catalogTemplateVersion: catalog.templateVersion,
        serviceImageDigest: catalog.imageDigest,
        endpointRef: input.endpointRef.trim(),
        healthRevision: input.healthRevision ?? "1",
        configSchemaVersion: catalog.configSchemaVersion,
      });
      evaluateSkillInstallationReadinessSync(installationId, workspaceId);
    }
    return { ok: true };
  });
}

/**
 * Completes a managed service RETIRE operation reported by the daemon: marks
 * the service retired and re-evaluates the dependent installation (its service
 * component goes blocked again — resolveServiceComponentStatus requires a ready
 * managed service). No endpointRef is involved; a retire has nothing to bind.
 */
export function completeManagedSkillServiceRetireOperationSync(input: {
  operationId: string;
  claimGeneration: number;
  workspaceId?: string;
}): { ok: true } | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const operation = readManagedSkillServiceOperationSync(input.operationId, workspaceId);
  if (!operation) {
    return { ok: false, code: "operation_not_found", reason: "Service operation does not exist." };
  }
  return withTransaction(getDatabase(), () => {
    const done = completeOperationDbSync({
      operationId: input.operationId,
      claimGeneration: input.claimGeneration,
      workspaceId,
    });
    if (!done) {
      return { ok: false, code: "not_completable", reason: "Operation is no longer completable." };
    }
    retireManagedSkillServiceSync({ serviceId: operation.serviceId, workspaceId });
    if (operation.installationId) {
      evaluateSkillInstallationReadinessSync(operation.installationId, workspaceId);
    }
    return { ok: true };
  });
}

/**
 * Retire producer: queues a `retire` operation for a managed service so the
 * managed node tears the container down. Dedupes against an already-active
 * (pending/claimed/running) retire operation and refuses services that are still
 * provisioning or already retired. This is the explicit trigger any caller
 * (future uninstall flow, ops tooling, or the maintenance sweep) uses — nothing
 * else in the system produces retire operations.
 */
export function queueManagedSkillServiceRetireSync(input: {
  workspaceId?: string;
  serviceId: string;
}): { queued: true; operationId: string } | { queued: false; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const service = readManagedSkillServiceSync(input.serviceId, workspaceId);
  if (!service) {
    return { queued: false, reason: "service_not_found" };
  }
  if (service.status === "retired") {
    return { queued: false, reason: "already_retired" };
  }
  if (service.status === "provisioning") {
    return { queued: false, reason: "still_provisioning" };
  }
  const hasActiveRetire = listManagedSkillServiceOperationsSync({
    workspaceId,
    serviceId: input.serviceId,
  }).some((operation) => operation.operation === "retire" && ACTIVE_OPERATION_STATUSES.has(operation.status));
  if (hasActiveRetire) {
    return { queued: false, reason: "already_queued" };
  }
  const operation = createManagedSkillServiceOperationSync({
    workspaceId,
    runtimeId: service.runtimeId,
    serviceId: input.serviceId,
    operation: "retire",
  });
  return { queued: true, operationId: operation.id };
}

/**
 * Canary upgrade orchestration (explicit, 05-运维服务与版本治理.md §升级): provisions
 * a NEW catalog instance (blue) alongside the currently-bound instance (green)
 * on the same runtime, and records which service it replaces on the provision
 * operation. When the daemon reports blue healthy, the control plane switches
 * every green binding onto blue (blue-green) — the switch, not the provision,
 * is the cutover. Green then becomes unreferenced and the rollback_class-aware
 * retire sweep tears it down after its cooldown window, so a failed canary can
 * be rolled back to green within that window.
 */
export function upgradeManagedSkillServiceSync(input: {
  workspaceId?: string;
  serviceId: string;
  catalogSlug: string;
  templateVersion: string;
}):
  | { ok: true; blueServiceId: string; operationId: string; queued: boolean }
  | { ok: false; code: string; reason: string } {
  const workspaceId = input.workspaceId ?? "default";
  const green = readManagedSkillServiceSync(input.serviceId, workspaceId);
  if (!green) {
    return { ok: false, code: "service_not_found", reason: "Managed service does not exist." };
  }
  if (green.status === "retired") {
    return { ok: false, code: "already_retired", reason: "The service is already retired." };
  }
  if (green.status === "provisioning") {
    return { ok: false, code: "still_provisioning", reason: "The service is still provisioning." };
  }
  const greenCatalog = listSkillServiceCatalogSync(workspaceId).find((entry) => entry.id === green.catalogId);
  if (!greenCatalog) {
    return { ok: false, code: "catalog_not_found", reason: "The green service's catalog entry is missing." };
  }
  const blueCatalog = readSkillServiceCatalogSync(input.catalogSlug, input.templateVersion, workspaceId);
  if (!blueCatalog) {
    return {
      ok: false,
      code: "catalog_not_found",
      reason: `Catalog "${input.catalogSlug}@${input.templateVersion}" does not exist.`,
    };
  }
  if (blueCatalog.slug !== greenCatalog.slug) {
    return { ok: false, code: "catalog_lineage_mismatch", reason: "Upgrade must stay on the same catalog lineage (slug)." };
  }
  if (blueCatalog.id === greenCatalog.id) {
    return { ok: false, code: "already_current", reason: "The service already runs the target template version." };
  }
  if (listSkillServiceBindingsForServiceSync(green.id).length === 0) {
    return { ok: false, code: "no_bindings", reason: "Nothing references this service; there is nothing to canary." };
  }

  // Blue instance is idempotent on (workspace, runtime, catalog) — re-running an
  // upgrade reuses the half-created instance instead of stacking a new one.
  const blue = createManagedSkillServiceSync({
    workspaceId,
    runtimeId: green.runtimeId,
    catalogId: blueCatalog.id,
    status: "provisioning",
  });
  const activeProvision = listManagedSkillServiceOperationsSync({ workspaceId, serviceId: blue.id })
    .find((operation) => operation.operation === "provision" && ACTIVE_OPERATION_STATUSES.has(operation.status));
  if (activeProvision) {
    return { ok: true, blueServiceId: blue.id, operationId: activeProvision.id, queued: false };
  }
  const operation = createManagedSkillServiceOperationSync({
    workspaceId,
    runtimeId: green.runtimeId,
    serviceId: blue.id,
    replacesServiceId: green.id,
    operation: "provision",
  });
  return { ok: true, blueServiceId: blue.id, operationId: operation.id, queued: true };
}

/**
 * Default cooldown before a `backward_compatible` service is auto-retired after
 * it stops being referenced — an upgrade window in which a rollback can re-bind
 * the same instance instead of re-provisioning. Env-overridable.
 */
export const SERVICE_RETIRE_COOLDOWN_MS = Number(
  process.env.DOFE_AGENT_SERVICE_RETIRE_COOLDOWN_MS ?? 24 * 60 * 60 * 1000,
);

/**
 * Service lifecycle sweep. A service is unreferenced when it has no remaining
 * `skill_service_binding` (the last referencing installation is gone — bindings
 * cascade-delete with their installation). Retirement honors the catalog
 * `rollback_class`:
 *  - `stateless` (default): queue the retire operation immediately.
 *  - `backward_compatible`: keep the instance for a cooldown window after it
 *    first becomes unreferenced, so an upgrade rollback can re-bind it; only
 *    retire once the window elapses.
 *  - `irreversible_migration`: never auto-retire (manual ops only).
 * A re-reference resets the cooldown window. Returns the newly-queued ids.
 */
export function retireUnreferencedManagedSkillServicesSync(
  options?: { workspaceId?: string; now?: Date; cooldownMs?: number },
): string[] {
  const workspaceId = options?.workspaceId ?? "default";
  const now = options?.now ?? new Date();
  const cooldownMs = options?.cooldownMs ?? SERVICE_RETIRE_COOLDOWN_MS;
  const catalogByRollbackClass = new Map(
    listSkillServiceCatalogSync(workspaceId).map((catalog) => [catalog.id, catalog.rollbackClass]),
  );
  const retired: string[] = [];

  for (const service of listManagedSkillServicesSync(workspaceId)) {
    if (service.status !== "ready" && service.status !== "degraded") {
      continue;
    }
    const referenced = listSkillServiceBindingsForServiceSync(service.id).length > 0;
    if (referenced) {
      if (service.unreferencedSince) {
        setManagedSkillServiceUnreferencedSinceSync({ serviceId: service.id, workspaceId });
      }
      continue;
    }

    const rollbackClass = catalogByRollbackClass.get(service.catalogId) ?? "stateless";
    if (rollbackClass === "irreversible_migration") {
      continue;
    }
    if (rollbackClass === "backward_compatible") {
      if (!service.unreferencedSince) {
        setManagedSkillServiceUnreferencedSinceSync({ serviceId: service.id, workspaceId, since: now.toISOString() });
        continue;
      }
      if (Date.parse(service.unreferencedSince) + cooldownMs > now.getTime()) {
        continue;
      }
    }

    const result = queueManagedSkillServiceRetireSync({ workspaceId, serviceId: service.id });
    if (result.queued) {
      retired.push(service.id);
    }
  }
  return retired;
}
