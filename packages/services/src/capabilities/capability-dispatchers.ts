import type {
  CapabilityRequestRecord,
  RuntimeAppCatalogItemRecord,
  RuntimeAppCatalogSource,
} from "@dofe-agent/db";
import {
  createRuntimeAppOperationSync,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  readCapabilityRequestSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemSync,
  readWorkspaceRuntimeAppReleaseSync,
  transitionCapabilityRequestSync,
} from "@dofe-agent/db";
import type { RuntimeAppInstallPlan } from "@dofe-agent/domain";
import { requestMcpConnectionSync } from "../mcp-center/connections.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { buildRuntimeAppInstallPlan } from "../clihub/install-plan.ts";
import { listWorkspaceRuntimeAppCatalogItemsSync } from "../clihub/private-releases.ts";
import { isManagedServiceProvisioningEnabled } from "./capability-config.ts";
import type { CapabilityNextAction } from "./capability-projection.ts";

/**
 * Dispatch of an approved capability_request into the underlying subsystem
 * (CLI install / MCP connect / managed-service lifecycle).
 *
 * This module is the dispatch half of the capability stack; the request
 * workflow lives in capability-workflow.ts and the projection in
 * capability-projection.ts. Split out of capability-availability.ts (P2).
 */

export interface DispatchResult {
  request: CapabilityRequestRecord;
  capabilityRequest: CapabilityRequestRecord;
  operationId?: string;
  nextAction: CapabilityNextAction;
}

export function dispatchApprovedCapabilityRequestSync(input: {
  workspaceId: string;
  requestId: string;
  actorUserId: string;
}): DispatchResult {
  const request = readCapabilityRequestSync(input.requestId, input.workspaceId);
  if (!request) throw new Error("capability_request.not_found");
  if (request.requestedAction === "install" && request.packageKind === "cli" && request.runtimeId) {
    const cliOps = listRuntimeAppOperationsSync({
      workspaceId: input.workspaceId,
      runtimeId: request.runtimeId,
      limit: 5,
    });
    // Match the in-flight operation to THIS request's package — appSource +
    // appName must line up with the requested catalog item, not just any active
    // op on the runtime (otherwise a concurrent install of a different CLI
    // would be mis-linked to this request).
    const activeOp = cliOps.find(
      (op) =>
        isActiveRuntimeAppOperation(op) &&
        op.appSource === request.packageSource &&
        op.appName === request.packageSlug,
    );
    if (activeOp) {
      const linked = transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "running",
        linkedRuntimeAppOperationId: activeOp.id,
      });
      const final = linked ?? request;
      return {
        request: final,
        capabilityRequest: final,
        operationId: activeOp.id,
        nextAction: "wait_for_operation",
      };
    }
    const item = findCliCatalogItem(input.workspaceId, request.packageSource, request.packageSlug);
    if (!item) {
      const failed = transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: "runtime_app.catalog_item_not_found",
        lastErrorMessage: "目录条目已下线或被撤回。",
      });
      const final = failed ?? request;
      return { request: final, capabilityRequest: final, nextAction: "repair" };
    }
    const plan = safeBuildInstallPlan(item);
    if (!plan) {
      const failed = transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: "runtime_app.not_installable",
        lastErrorMessage: "目录条目未通过受控安装预检。",
      });
      const final = failed ?? request;
      return { request: final, capabilityRequest: final, nextAction: "govern_release" };
    }
    // Verify the pinned release still exists and is not yanked. workspace-private
    // requests captured a `release_id` at submission time; if a maintainer
    // yanked it between submit and approve, fail closed.
    if (request.releaseId) {
      const pinned = readWorkspaceRuntimeAppReleaseSync(request.releaseId, input.workspaceId);
      if (!pinned || pinned.yankedAt) {
        const failed = transitionCapabilityRequestSync({
          requestId: request.id,
          workspaceId: input.workspaceId,
          status: "failed",
          lastErrorCode: "runtime_app.release_yanked",
          lastErrorMessage: "请求绑定的 release 已被撤回或下线。",
        });
        const final = failed ?? request;
        return { request: final, capabilityRequest: final, nextAction: "govern_release" };
      }
    }
    const operation = createRuntimeAppOperationSync({
      workspaceId: input.workspaceId,
      runtimeId: request.runtimeId,
      appSource: request.packageSource as RuntimeAppCatalogSource,
      appName: request.packageSlug,
      operation: "install",
      requestedByUserId: input.actorUserId,
      commandPlanJson: JSON.stringify(plan),
    });
    const linked = transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "running",
      linkedRuntimeAppOperationId: operation.id,
    });
    const final = linked ?? request;
    return {
      request: final,
      capabilityRequest: final,
      operationId: operation.id,
      nextAction: "wait_for_operation",
    };
  }
  // MCP capability dispatch (docs/0811/cli-install §6, P1-1). Both MCP
  // deployment modes — external_service (streamable_http) and managed_service
  // (managed_stdio) — provision through the MCP-center connection lifecycle
  // (create connection → queue verify → daemon claims → complete/fail), NOT the
  // skill_service container pipeline. This branch unifies the two halves the
  // user explicitly asked to connect ("两个半边都接"): zero-config MCPs are
  // auto-connected on approval; credential/endpoint-bearing MCPs stay approved
  // and surface configure_credentials so the applicant finishes them.
  if (request.packageKind === "mcp" && request.runtimeId) {
    return dispatchMcpCapabilityRequestSync({
      workspaceId: input.workspaceId,
      request,
      actorUserId: input.actorUserId,
    });
  }
  // Managed / external service deployment (docs/0811/cli-install §8, Phase 5).
  // These requests cannot be executed as a shell install on the runtime; they
  // require the managed-service container lifecycle (image cache, signature
  // verify, provision, health, retire). The seam is fail-closed behind
  // MANAGED_SERVICE_PROVISIONING_ENABLED (see the container driver in
  // capability-service-driver.ts once it lands).
  if (
    request.packageKind === "service"
    && (request.deploymentMode === "managed_service"
      || request.deploymentMode === "external_service")
  ) {
    return dispatchManagedServiceCapabilityRequestSync({
      workspaceId: input.workspaceId,
      request,
    });
  }
  return { request, capabilityRequest: request, nextAction: "wait_for_operation" };
}

/**
 * MCP dispatch (P1-1). Resolves the catalog item by the request's pinned
 * catalogItemId (falling back to slug), then either auto-connects (zero-config)
 * or surfaces configure_credentials for the applicant to finish. The actual
 * connection create + verify-op queue happens in
 * {@link requestMcpConnectionSync}, whose link-back binds this approved request
 * to the new connection and transitions it to running; the verify op then
 * drives it to completed/failed via convergeCapabilityRequestFromMcpConnectionSync.
 *
 * Admin approval is the high-risk authorization, so a high-risk catalog item is
 * auto-confirmed here (the approver already accepted the risk).
 */
function dispatchMcpCapabilityRequestSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
  actorUserId: string;
}): DispatchResult {
  const { request } = input;
  const runtimeId = request.runtimeId;
  if (!runtimeId) {
    // Caller guards on runtimeId, but defend in depth.
    const failed = transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: "capability_request.no_runtime",
      lastErrorMessage: "MCP 请求未绑定运行时。",
    });
    const final = failed ?? request;
    return { request: final, capabilityRequest: final, nextAction: "repair" };
  }

  const catalogItemId = resolveMcpCatalogItemIdFromRequest(request);
  const catalog = catalogItemId
    ? readMcpCatalogItemSync(catalogItemId, input.workspaceId)
    : readMcpCatalogItemBySlugSync(request.packageSlug, input.workspaceId);
  if (!catalog) {
    const failed = transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: "mcp_catalog.not_found",
      lastErrorMessage: "MCP 目录条目已下线或被撤回。",
    });
    const final = failed ?? request;
    return { request: final, capabilityRequest: final, nextAction: "repair" };
  }

  if (isZeroConfigMcp(catalog)) {
    const approvedTools = safeParseJsonArray(catalog.defaultApprovedToolsJson);
    try {
      // requestMcpConnectionSync is admin-gated; actorUserId is the approver.
      // The link-back inside it binds THIS request to the new connection and
      // transitions it to running, so read the updated request back afterwards.
      if (!catalog.endpointTemplate) {
        // Defensive: isZeroConfigMcp already checked this, but narrow the type.
        throw new Error("mcp.endpoint_template_missing");
      }
      requestMcpConnectionSync({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        runtimeId,
        catalogItemId: catalog.id,
        endpoint: catalog.endpointTemplate,
        approvedTools,
        confirmHighRisk: catalog.risk === "high",
      });
      const updated = readCapabilityRequestSync(request.id, input.workspaceId) ?? request;
      return {
        request: updated,
        capabilityRequest: updated,
        nextAction: "wait_for_operation",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: "mcp.connection_dispatch_failed",
        lastErrorMessage: message,
      });
      const final = failed ?? request;
      return { request: final, capabilityRequest: final, nextAction: "repair" };
    }
  }

  // Credential-bearing / endpoint-bearing / configuration-required MCP: leave
  // approved and surface configure_credentials. The applicant completes the
  // connection via the "配置并连接" flow; the link-back then binds + runs this
  // request.
  const secretFields = safeParseJsonArray(catalog.secretFieldsJson);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "MCP 能力待申请人补全配置",
    note:
      secretFields.length > 0
        ? `${request.packageDisplayName} 已批准，但需要申请人补全凭据（${secretFields.length} 个密钥字段）。`
        : `${request.packageDisplayName} 已批准，但需要申请人补全连接配置。`,
    code: "capability_request.mcp_awaiting_configuration",
    data: {
      resourceType: "capability_request",
      resourceId: request.id,
      packageSlug: request.packageSlug,
      secretFieldCount: secretFields.length,
    },
  });
  return { request, capabilityRequest: request, nextAction: "configure_credentials" };
}

export function resolveMcpCatalogItemIdFromRequest(request: CapabilityRequestRecord): string | undefined {
  try {
    const metadata = JSON.parse(request.metadataJson) as unknown;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const catalogItemId = (metadata as Record<string, unknown>).catalogItemId;
      if (typeof catalogItemId === "string" && catalogItemId.trim()) return catalogItemId;
    }
  } catch {
    // ignore malformed metadata
  }
  return undefined;
}

function isZeroConfigMcp(catalog: { secretFieldsJson: string; endpointTemplate?: string; configurationSchemaJson: string }): boolean {
  const secretFields = safeParseJsonArray(catalog.secretFieldsJson);
  if (secretFields.length > 0) return false;
  if (!catalog.endpointTemplate) return false;
  const schema = safeParseJsonObject(catalog.configurationSchemaJson);
  if (!schema || schema.type !== "object") return true;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return !required.some((name) => typeof name === "string" && name.trim() && !secretFields.includes(name));
}

function safeParseJsonObject(value: string | undefined | null): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function safeParseJsonArray(value: string | undefined | null): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Phase 5 dispatch seam for managed_service / external_service capabilities.
 *
 * Fail-closed by default: when MANAGED_SERVICE_PROVISIONING_ENABLED is off the
 * approved request is left in place (not failed, not phantom-running) so the
 * "turning the flag off only stops new operations" contract holds — the request
 * stays visible in the active queue and can be dispatched when ops enables it.
 * Either way we record an audit event so platform operations can see which
 * requests are gated and why no container was provisioned.
 */
function dispatchManagedServiceCapabilityRequestSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
}): DispatchResult {
  const { request } = input;
  const provisioningEnabled = isManagedServiceProvisioningEnabled();
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: provisioningEnabled
      ? "Managed service provisioning accepted (pending driver)"
      : "Managed service provisioning gated",
    note: provisioningEnabled
      ? `${request.packageDisplayName} (${request.deploymentMode}) approved; container lifecycle driver not yet connected.`
      : `${request.packageDisplayName} (${request.deploymentMode}) approved but MANAGED_SERVICE_PROVISIONING_ENABLED=0; request queued.`,
    code: provisioningEnabled
      ? "capability_request.managed_service_pending_driver"
      : "capability_request.managed_service_gated",
    data: {
      resourceType: "capability_request",
      resourceId: request.id,
      deploymentMode: request.deploymentMode,
      packageKind: request.packageKind,
      packageSource: request.packageSource,
      packageSlug: request.packageSlug,
    },
  });
  // The request stays in its `approved` state. The actual
  // `linked_runtime_provisioning_task_id` binding is written by the managed
  // service container driver when it lands (Phase 5 continuation).
  return { request, capabilityRequest: request, nextAction: "wait_for_operation" };
}

function safeBuildInstallPlan(item: RuntimeAppCatalogItemRecord): RuntimeAppInstallPlan | null {
  try {
    return buildRuntimeAppInstallPlan({ item, operation: "install" });
  } catch {
    return null;
  }
}

export function findCliCatalogItem(workspaceId: string, source: string, slug: string) {
  const allItems = [
    ...listRuntimeAppCatalogItemsSync({ limit: 1000 }),
    ...listWorkspaceRuntimeAppCatalogItemsSync(workspaceId),
  ];
  return allItems.find((item) => item.source === (source as RuntimeAppCatalogSource) && item.name === slug) ?? null;
}

export function isActiveRuntimeAppOperation(op: { status: string }): boolean {
  return op.status === "pending" || op.status === "claimed" || op.status === "running";
}
