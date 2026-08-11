import type { CapabilityRequestRecord } from "@dofe-agent/db";
import {
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  listCapabilityRequestsSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceCatalogSync,
  transitionCapabilityRequestSync,
} from "@dofe-agent/db";

/**
 * Managed-service container driver for capability requests (docs/0811/cli-install
 * Phase 5 / §8). Reuses the skill-service container lifecycle — a digest-pinned
 * template in `skill_service_catalog`, a `managed_skill_service` instance, and a
 * provision operation the remote managed node claims and executes (docker pull +
 * cosign verify + container run + health). This is the "create service instance
 * and operation" half of the dispatch; the container runtime itself already
 * exists in the daemon and its claim loop is live on remote managed nodes.
 *
 * Fail-closed: if the capability has no admitted digest-pinned template, we do
 * NOT fabricate an image reference — dispatch stays in its approved state with
 * an explicit audit trail.
 */

export interface QueueCapabilityManagedServiceProvisionResult {
  queued: boolean;
  code?: string;
  serviceId?: string;
  operationId?: string;
}

/**
 * Queues a real container-lifecycle provision for an approved managed_service /
 * external_service capability request. Idempotent per (workspace, runtime,
 * catalog): re-plans reuse the existing instance and an in-flight provision op
 * instead of stacking duplicate container requests.
 */
export function queueCapabilityManagedServiceProvisionSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
}): QueueCapabilityManagedServiceProvisionResult {
  const { request } = input;
  if (!request.runtimeId) {
    return { queued: false, code: "capability_request.no_runtime" };
  }
  // Resolve the latest digest-pinned managed_service template for this slug.
  const template = listSkillServiceCatalogSync(input.workspaceId)
    .filter((entry) => entry.slug === request.packageSlug && entry.deploymentType === "managed_service")
    .sort((left, right) => right.templateVersion.localeCompare(left.templateVersion))[0];
  if (!template) {
    return { queued: false, code: "capability_request.managed_service_template_not_admitted" };
  }

  // Idempotent per (workspace, runtime, catalog): re-plans reuse the instance.
  const service = createManagedSkillServiceSync({
    workspaceId: input.workspaceId,
    runtimeId: request.runtimeId,
    catalogId: template.id,
    status: "provisioning",
  });
  // Reuse an in-flight provision op for this service instead of stacking a
  // second container lifecycle request.
  const activeOperation = listManagedSkillServiceOperationsSync({
    workspaceId: input.workspaceId,
    serviceId: service.id,
    limit: 10,
  }).find((op) => op.status === "pending" || op.status === "claimed" || op.status === "running");
  const operationId = activeOperation?.id
    ?? createManagedSkillServiceOperationSync({
      workspaceId: input.workspaceId,
      runtimeId: request.runtimeId,
      serviceId: service.id,
      operation: "provision",
    }).id;

  // Persist the linkage in metadata_json so the operation completion path can
  // converge THIS request, and mark the request running.
  const metadata = parseCapabilityMetadata(request.metadataJson);
  metadata.skillServiceOperationId = operationId;
  metadata.managedServiceCatalogId = template.id;
  transitionCapabilityRequestSync({
    requestId: request.id,
    workspaceId: input.workspaceId,
    status: "running",
    metadataJson: JSON.stringify(metadata),
  });

  return { queued: true, serviceId: service.id, operationId };
}

/**
 * Operation→request convergence. When a skill-service provision operation
 * referenced by a capability_request reaches a terminal state, converge the
 * request (running → completed/failed). No-op when no request references the
 * operation or the request is already terminal. Called from the daemon
 * complete/fail API routes so convergence happens regardless of caller.
 */
export function convergeCapabilityRequestFromSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId: string;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): CapabilityRequestRecord | null {
  const request = listCapabilityRequestsSync({ workspaceId: input.workspaceId, limit: 200 })
    .find((candidate) => {
      const metadata = parseCapabilityMetadata(candidate.metadataJson);
      return metadata.skillServiceOperationId === input.operationId;
    });
  if (!request) return null;
  if (
    request.status === "completed"
    || request.status === "failed"
    || request.status === "cancelled"
  ) {
    return request;
  }
  return transitionCapabilityRequestSync({
    requestId: request.id,
    workspaceId: input.workspaceId,
    status: input.outcome === "succeeded" ? "completed" : "failed",
    lastErrorCode: input.outcome === "failed" ? input.errorCode : undefined,
    lastErrorMessage: input.outcome === "failed" ? input.errorMessage : undefined,
  });
}

function parseCapabilityMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
