import type { CapabilityRequestRecord, StoredSkillServiceCatalogRecord } from "@dofe-agent/db";
import {
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  listCapabilityRequestsByServiceOperationIdSync,
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
  const template = typeof pinnedId === "string" && pinnedId
    ? listSkillServiceCatalogSync(workspaceId).find((entry) => entry.id === pinnedId)
    : listSkillServiceCatalogSync(workspaceId)
        .filter((entry) => entry.slug === request.packageSlug && entry.deploymentType === "managed_service")
        .sort((left, right) => right.templateVersion.localeCompare(left.templateVersion))[0];
  if (!template || template.deploymentType !== "managed_service") return null;
  // Signature policy (docs/0811/cli-install §4.3, Phase 5): a template that
  // REQUIRES image signature verification but has no trusted key can never be
  // verified by the managed node — fail closed rather than provision an
  // unverifiable image.
  if (template.signatureRequired && !template.signatureKeyPem) return null;
  return template;
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
  /** Provisioned container endpoint (runtime-private://...) — preferred over the
   *  catalog's static template so the connection targets the JUST-provisioned
   *  container, not a pre-existing service. */
  endpointRef?: string;
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
    // Spec: the provisioned container endpoint is the real connection target; the
    // static catalog template ("managed-service://...") is only the fallback.
    endpoint: input.endpointRef?.trim() || marker.endpoint,
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
 * referenced by capability_requests reaches a terminal state, converge EVERY
 * linked request (multiple requests can share one in-flight provision op, so a
 * LIMIT-1 lookup would leave the rest permanently running). Uses a JSONB-targeted
 * lookup so an old request (outside any recent window) is still converged.
 *
 * Per-request terminal policy:
 *   - zero-config managed MCP (auto-connect marker) → create the connection
 *     (endpointRef from the provisioned container), do NOT stamp terminal;
 *   - credential/endpoint-bearing managed MCP (no marker) → container is ready,
 *     request returns to `approved` so configure_credentials surfaces for the
 *     applicant to finish;
 *   - plain service → completed/failed.
 */
export function convergeCapabilityRequestFromSkillServiceOperationSync(input: {
  operationId: string;
  workspaceId: string;
  outcome: "succeeded" | "failed";
  /** Provisioned container endpoint (runtime-private://...) the daemon reported. */
  endpointRef?: string;
  errorCode?: string;
  errorMessage?: string;
}): CapabilityRequestRecord | null {
  const requests = listCapabilityRequestsByServiceOperationIdSync(input.workspaceId, input.operationId);
  if (requests.length === 0) return null;
  let last: CapabilityRequestRecord | null = null;
  for (const request of requests) {
    if (
      request.status === "completed"
      || request.status === "failed"
      || request.status === "cancelled"
    ) {
      last = request;
      continue;
    }
    last = convergeSingleServiceProvisionedRequest(input, request);
  }
  return last;
}

function convergeSingleServiceProvisionedRequest(
  input: {
    workspaceId: string;
    operationId: string;
    outcome: "succeeded" | "failed";
    endpointRef?: string;
    errorCode?: string;
    errorMessage?: string;
  },
  request: CapabilityRequestRecord,
): CapabilityRequestRecord {
  // Zero-config managed MCP: container is now provisioned (or failed). On
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
      }) ?? request;
    }
    try {
      const connected = autoConnectManagedMcpAfterProvisionSync({
        workspaceId: input.workspaceId,
        request,
        endpointRef: input.endpointRef,
      });
      if (!connected) {
        return transitionCapabilityRequestSync({
          requestId: request.id,
          workspaceId: input.workspaceId,
          status: "failed",
          lastErrorCode: "mcp.connection_dispatch_failed",
          lastErrorMessage: "容器已就绪但 MCP 连接无法创建（目录条目或运行时缺失）。",
        }) ?? request;
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
      }) ?? request;
    }
  }

  // Credential/endpoint-bearing managed MCP: the container is provisioned but
  // the applicant must still supply secrets/endpoint. Return to `approved` so
  // configure_credentials surfaces (the overlay maps approved+mcp → that state);
  // the applicant completes via completeCapabilityRequestMcpConnectionSync.
  if (request.packageKind === "mcp" && request.deploymentMode === "managed_service") {
    if (input.outcome !== "succeeded") {
      return transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: input.errorCode ?? "capability_request.managed_mcp_provision_failed",
        lastErrorMessage: input.errorMessage ?? "容器部署失败。",
      }) ?? request;
    }
    return transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "approved",
    }) ?? request;
  }

  // Plain service request.
  return transitionCapabilityRequestSync({
    requestId: request.id,
    workspaceId: input.workspaceId,
    status: input.outcome === "succeeded" ? "completed" : "failed",
    lastErrorCode: input.outcome === "failed" ? input.errorCode : undefined,
    lastErrorMessage: input.outcome === "failed" ? input.errorMessage : undefined,
  }) ?? request;
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
