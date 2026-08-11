import type { CapabilityRequestRecord, StoredSkillServiceCatalogRecord } from "@dofe-agent/db";
import {
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  findCapabilityRequestByServiceOperationIdSync,
  listManagedSkillServiceOperationsSync,
  listSkillServiceCatalogSync,
  readCapabilityRequestSync,
  readMcpCatalogItemSync,
  transitionCapabilityRequestSync,
} from "@dofe-agent/db";
import { requestMcpConnectionSync } from "../mcp-center/connections.ts";

/**
 * Managed-service container driver for capability requests (docs/0811/cli-install
 * Phase 5 / §8). Reuses the skill-service container lifecycle — a digest-pinned
 * template in `skill_service_catalog`, a `managed_skill_service` instance, and a
 * provision operation the remote managed node claims and executes (docker pull +
 * cosign verify + container run + health). This is the "create service instance
 * and operation" half of the dispatch; the container runtime itself already
 * exists in the daemon and its claim loop is live on remote managed nodes.
 *
 * Immutable template identity: a request pins `managedServiceCatalogId` in its
 * metadata_json at submission, and dispatch resolves ONLY that template — a
 * catalog version bump after approval cannot drift the deployed digest. Requests
 * created before pinning fall back to the latest managed_service template by
 * slug (the best available identity).
 *
 * Fail-closed: if the capability has no admitted digest-pinned template, we do
 * NOT fabricate an image reference — dispatch stays in its approved state with
 * an explicit audit trail.
 */

export interface QueueCapabilityManagedServiceProvisionResult {
  queued: boolean;
  code:
    | "provision_queued"
    | "provision_in_flight"
    | "service_ready"
    | "template_not_admitted"
    | "no_runtime";
  serviceId?: string;
  operationId?: string;
}

/**
 * Ensures a real container-lifecycle provision for an approved managed_service
 * capability request. Idempotent per (workspace, runtime, pinned catalog):
 * re-plans reuse the existing instance, an in-flight provision op is reused
 * (never stacked), and an ALREADY-READY instance is never re-provisioned.
 */
export interface McpAutoConnectMarker {
  actorUserId: string;
  catalogItemId: string;
  endpoint: string;
  approvedTools: string[];
}

export function queueCapabilityManagedServiceProvisionSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
  /** For managed-MCP dispatch: auto-connect the MCP once the container is ready. */
  mcpAutoConnect?: McpAutoConnectMarker;
}): QueueCapabilityManagedServiceProvisionResult {
  const { request } = input;
  if (!request.runtimeId) {
    return { queued: false, code: "no_runtime" };
  }
  const template = resolveManagedServiceTemplateSync(input.workspaceId, request);
  if (!template) {
    return { queued: false, code: "template_not_admitted" };
  }

  // Idempotent per (workspace, runtime, catalog): re-plans reuse the instance.
  const service = createManagedSkillServiceSync({
    workspaceId: input.workspaceId,
    runtimeId: request.runtimeId,
    catalogId: template.id,
    status: "provisioning",
  });
  // S3: an already-ready instance must NOT be re-provisioned. The caller
  // (dispatcher) decides what "ready" means for the request (complete a service
  // request, or proceed to connect a managed MCP).
  if (service.status === "ready") {
    return { queued: false, code: "service_ready", serviceId: service.id };
  }

  // Reuse an in-flight provision op for this service instead of stacking a
  // second container lifecycle request.
  const activeOperation = listManagedSkillServiceOperationsSync({
    workspaceId: input.workspaceId,
    serviceId: service.id,
    limit: 10,
  }).find((op) => op.status === "pending" || op.status === "claimed" || op.status === "running");
  if (activeOperation) {
    persistProvisionLinkage(input.workspaceId, request, template.id, activeOperation.id, input.mcpAutoConnect);
    return {
      queued: true,
      code: "provision_in_flight",
      serviceId: service.id,
      operationId: activeOperation.id,
    };
  }

  const operation = createManagedSkillServiceOperationSync({
    workspaceId: input.workspaceId,
    runtimeId: request.runtimeId,
    serviceId: service.id,
    operation: "provision",
  });
  persistProvisionLinkage(input.workspaceId, request, template.id, operation.id, input.mcpAutoConnect);
  return {
    queued: true,
    code: "provision_queued",
    serviceId: service.id,
    operationId: operation.id,
  };
}

/**
 * Immutable template resolution (S2): the request's pinned
 * `managedServiceCatalogId` wins; a pin that no longer resolves (template
 * withdrawn) fails closed. Historical unpinned requests fall back to the latest
 * managed_service template by slug.
 */
function resolveManagedServiceTemplateSync(
  workspaceId: string,
  request: CapabilityRequestRecord,
): StoredSkillServiceCatalogRecord | null {
  const metadata = parseCapabilityMetadata(request.metadataJson);
  const pinnedId = metadata.managedServiceCatalogId;
  if (typeof pinnedId === "string" && pinnedId) {
    const pinned = listSkillServiceCatalogSync(workspaceId).find((entry) => entry.id === pinnedId);
    return pinned && pinned.deploymentType === "managed_service" ? pinned : null;
  }
  return listSkillServiceCatalogSync(workspaceId)
    .filter((entry) => entry.slug === request.packageSlug && entry.deploymentType === "managed_service")
    .sort((left, right) => right.templateVersion.localeCompare(left.templateVersion))[0] ?? null;
}

function persistProvisionLinkage(
  workspaceId: string,
  request: CapabilityRequestRecord,
  catalogId: string,
  operationId: string,
  mcpAutoConnect?: McpAutoConnectMarker,
): void {
  const metadata = parseCapabilityMetadata(request.metadataJson);
  metadata.skillServiceOperationId = operationId;
  metadata.managedServiceCatalogId = catalogId;
  if (mcpAutoConnect) {
    metadata.mcpAutoConnect = mcpAutoConnect;
  }
  transitionCapabilityRequestSync({
    requestId: request.id,
    workspaceId,
    status: "running",
    metadataJson: JSON.stringify(metadata),
  });
}

/**
 * Managed-MCP completion (docs/0811/cli-install Phase 5): after the container
 * provision succeeds, materialize the MCP connection the request queued for.
 * The actor is the original approver (an admin), so the connection service's
 * admin gate passes. The link-back binds the running request to the connection,
 * which then drives it to completed/failed via the verify op — this function
 * does NOT stamp the request terminal itself.
 */
export function autoConnectManagedMcpAfterProvisionSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
}): boolean {
  const marker = readMcpAutoConnectMarker(input.request);
  if (!marker) return false;
  if (!input.request.runtimeId) return false;
  const catalog = readMcpCatalogItemSync(marker.catalogItemId, input.workspaceId);
  if (!catalog) return false;
  requestMcpConnectionSync({
    workspaceId: input.workspaceId,
    actorUserId: marker.actorUserId,
    runtimeId: input.request.runtimeId,
    catalogItemId: catalog.id,
    endpoint: marker.endpoint,
    approvedTools: marker.approvedTools,
    confirmHighRisk: catalog.risk === "high",
  });
  return true;
}

function readMcpAutoConnectMarker(request: CapabilityRequestRecord): McpAutoConnectMarker | null {
  const metadata = parseCapabilityMetadata(request.metadataJson);
  const marker = metadata.mcpAutoConnect;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  const record = marker as Record<string, unknown>;
  if (
    typeof record.actorUserId !== "string"
    || typeof record.catalogItemId !== "string"
    || typeof record.endpoint !== "string"
    || !Array.isArray(record.approvedTools)
  ) {
    return null;
  }
  return {
    actorUserId: record.actorUserId,
    catalogItemId: record.catalogItemId,
    endpoint: record.endpoint,
    approvedTools: record.approvedTools.filter((tool): tool is string => typeof tool === "string"),
  };
}

/**
 * Operation→request convergence. When a skill-service provision operation
 * referenced by a capability_request reaches a terminal state, converge the
 * request (running → completed/failed). No-op when no request references the
 * operation or the request is already terminal. Uses a JSONB-targeted lookup so
 * an old request (outside any recent-200 window) is still converged.
 */
export function convergeCapabilityRequestFromSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId: string;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): CapabilityRequestRecord | null {
  const request = findCapabilityRequestByServiceOperationIdSync(input.workspaceId, input.operationId);
  if (!request) return null;
  if (
    request.status === "completed"
    || request.status === "failed"
    || request.status === "cancelled"
  ) {
    return request;
  }

  // Managed-MCP request: the container is now provisioned (or failed). On
  // success, materialize the MCP connection — the link-back binds it to this
  // running request and the verify op drives completion, so we do NOT stamp the
  // request terminal here. On failure, converge to failed.
  if (readMcpAutoConnectMarker(request)) {
    if (input.outcome !== "succeeded") {
      return transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: input.errorCode ?? "capability_request.managed_mcp_provision_failed",
        lastErrorMessage: input.errorMessage ?? "容器部署失败，MCP 未连接。",
      });
    }
    try {
      const connected = autoConnectManagedMcpAfterProvisionSync({ workspaceId: input.workspaceId, request });
      if (!connected) {
        // The marker is present but the connection could not be materialized
        // (catalog withdrawn / missing runtime / invalid marker) — fail closed
        // rather than leave the request permanently running.
        return transitionCapabilityRequestSync({
          requestId: request.id,
          workspaceId: input.workspaceId,
          status: "failed",
          lastErrorCode: "mcp.connection_dispatch_failed",
          lastErrorMessage: "容器已就绪但 MCP 连接无法创建（目录条目或运行时缺失）。",
        });
      }
      return readCapabilityRequestSync(request.id, input.workspaceId) ?? request;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: "mcp.connection_dispatch_failed",
        lastErrorMessage: message,
      });
    }
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
