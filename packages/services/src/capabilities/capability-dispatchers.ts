import type {
  CapabilityRequestRecord,
  RuntimeAppCatalogItemRecord,
  RuntimeAppCatalogSource,
} from "@dofe-agent/db";
import {
  createRuntimeAppOperationSync,
  findCapabilityRequestByLinkedRuntimeAppOperationIdSync,
  getDatabase,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  readAgentRuntimeSync,
  readCapabilityRequestSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemSync,
  readRuntimeAppOperationSync,
  readWorkspaceRuntimeAppReleaseSync,
  transitionCapabilityRequestSync,
  withTransaction,
} from "@dofe-agent/db";
import type { RuntimeAppInstallPlan } from "@dofe-agent/domain";
import { requestMcpConnectionSync } from "../mcp-center/connections.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { buildRuntimeAppInstallPlan } from "../clihub/install-plan.ts";
import { listWorkspaceRuntimeAppCatalogItemsSync } from "../clihub/private-releases.ts";
import { readCliHubReadinessForRuntimeSync } from "../clihub/runtime-apps.ts";
import { isManagedServiceProvisioningEnabled, isRuntimeBaselineRolloutEnabled } from "./capability-config.ts";
import type { CapabilityNextAction } from "./capability-projection.ts";
import {
  autoConnectManagedMcpAfterProvisionSync,
  queueCapabilityManagedServiceProvisionSync,
} from "./capability-service-driver.ts";
import { resolveBaselineRelease, type BaselineRelease, type BaselineTool } from "./baseline-releases.ts";

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
    // Prefer the plan pinned at submission (metadata.cliPlan) so an approved
    // dispatch cannot drift to a newer catalog version/integrity (Sp5). Fall back
    // to rebuilding from the current catalog item for legacy unpinned requests.
    const pinnedPlan = readPinnedCliPlan(request.metadataJson);
    const plan = pinnedPlan ?? safeBuildInstallPlan(item);
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
    // Runtime baseline rollout (docs Phase 7): when the plan requires a base
    // tool the runtime lacks AND RUNTIME_BASELINE_ROLLOUT_ENABLED is on, queue a
    // baseline op to install the tool first. The daemon runs the baseline plan,
    // and chainCapabilityRuntimeBaselineSync creates the CLI op once the tool is
    // present. Tools that are image-level (npm/python) have no baseline plan and
    // fall through to the normal CLI op (which the daemon fails closed if the
    // tool is genuinely missing).
    const requiredTool = requiredBaselineToolForStrategy(plan.strategy);
    if (requiredTool && isRuntimeBaselineRolloutEnabled()) {
      const readiness = readCliHubReadinessForRuntimeSync({
        workspaceId: input.workspaceId,
        runtimeId: request.runtimeId,
        runtimeMetadataJson: readAgentRuntimeSync(request.runtimeId)?.metadataJson,
      });
      const toolReady = readiness[requiredToolKey(requiredTool)]?.available;
      const baselinePlan = toolReady === false ? buildRuntimeBaselineInstallPlan(requiredTool) : null;
      if (baselinePlan) {
        const baselineOp = createRuntimeAppOperationSync({
          workspaceId: input.workspaceId,
          runtimeId: request.runtimeId,
          appSource: "clihub_harness" as RuntimeAppCatalogSource,
          // Reserved app_name namespace: runtime_app_operation.app_source must be
          // a real catalog source (the record mapper rejects unknown sources), so
          // the baseline identity lives in the name prefix. The CLI active-op
          // matcher compares op.appName === request.packageSlug, so a baseline op
          // can never be mis-linked as a CLI install.
          appName: `runtime-baseline:${requiredTool}`,
          operation: "install",
          requestedByUserId: input.actorUserId,
          commandPlanJson: JSON.stringify(baselinePlan),
        });
        const baselineMetadata = {
          ...parseRequestMetadata(request.metadataJson),
          pendingCliPlan: JSON.stringify(plan),
          baselineActorUserId: input.actorUserId,
        };
        const baselineLinked = transitionCapabilityRequestSync({
          requestId: request.id,
          workspaceId: input.workspaceId,
          status: "running",
          linkedRuntimeAppOperationId: baselineOp.id,
          metadataJson: JSON.stringify(baselineMetadata),
        });
        const baselineFinal = baselineLinked ?? request;
        return {
          request: baselineFinal,
          capabilityRequest: baselineFinal,
          operationId: baselineOp.id,
          nextAction: "wait_for_operation",
        };
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

  // Spec (P0): a managed_stdio MCP (Chrome DevTools, MiniMax) is NOT a Docker
  // service — it installs a pinned Runtime CLI dependency and runs a stdio
  // worker. If the dependency CLI isn't installed on the runtime, queue its
  // install first and defer the connection to a chaining hook (mcpPendingConnect
  // marker); the connection is only created once the CLI is present. Without the
  // install, the connection layer would throw mcp.runtime_app_required.
  const requiredApp = catalog.requiredRuntimeApp;
  if (requiredApp && request.runtimeId) {
    const installed = listRuntimeInstalledAppsSync({ workspaceId: input.workspaceId, runtimeId: request.runtimeId })
      .find((app) => app.source === requiredApp.source && app.name === requiredApp.name);
    // The connection layer requires the EXACT required version (Spec P0): an
    // older installed CLI would pass a source/name-only precheck and then fail at
    // connection time with mcp.runtime_app_required. Any version mismatch
    // re-queues the install (the plan is pinned to requiredApp.version).
    if (!installed || installed.status !== "installed" || !installed.enabled || installed.version !== requiredApp.version) {
      const depItem = findCliCatalogItem(input.workspaceId, requiredApp.source, requiredApp.name);
      const depPlan = depItem ? safeBuildInstallPlan(depItem) : null;
      if (!depPlan) {
        const failed = transitionCapabilityRequestSync({
          requestId: request.id,
          workspaceId: input.workspaceId,
          status: "failed",
          lastErrorCode: "mcp.runtime_app_required",
          lastErrorMessage: `依赖 CLI ${requiredApp.name}@${requiredApp.version} 无法安装（目录条目缺失）。`,
        });
        const final = failed ?? request;
        return { request: final, capabilityRequest: final, nextAction: "repair" };
      }
      // Use the REAL catalog identity (requiredApp.source/name) so the
      // installed-app lands under the same key the connection layer's
      // isRequiredRuntimeAppReady checks (Standard P0). The intermediate-step
      // marker is the request's mcpPendingConnect metadata — convergence and the
      // chaining hook key off that, not a synthetic app-name namespace.
      const depOp = createRuntimeAppOperationSync({
        workspaceId: input.workspaceId,
        runtimeId: request.runtimeId,
        appSource: requiredApp.source,
        appName: requiredApp.name,
        operation: "install",
        requestedByUserId: input.actorUserId,
        commandPlanJson: JSON.stringify(depPlan),
      });
      const depMetadata = {
        ...parseRequestMetadata(request.metadataJson),
        mcpPendingConnect: {
          actorUserId: input.actorUserId,
          catalogItemId: catalog.id,
          endpoint: catalog.endpointTemplate ?? "",
          approvedTools: safeParseJsonArray(catalog.defaultApprovedToolsJson),
        },
      };
      const depLinked = transitionCapabilityRequestSync({
        requestId: request.id,
        workspaceId: input.workspaceId,
        status: "running",
        linkedRuntimeAppOperationId: depOp.id,
        metadataJson: JSON.stringify(depMetadata),
      });
      const depFinal = depLinked ?? request;
      return {
        request: depFinal,
        capabilityRequest: depFinal,
        operationId: depOp.id,
        nextAction: "wait_for_operation",
      };
    }
  }

  // Spec: a managed_service-mode MCP whose catalog transport is genuinely a
  // CONTAINER (e.g. OpenMontage) must be deployed as a container FIRST — the MCP
  // connection is only materialized once the service instance is ready. A
  // managed_stdio MCP (Chrome DevTools, MiniMax) is NOT a Docker service: it
  // installs a Runtime CLI dependency and runs a stdio worker, so it skips the
  // container driver and goes straight to the connection lifecycle below.
  const isContainerManagedMcp = request.deploymentMode === "managed_service"
    && catalog.transport === "managed_service";
  if (isContainerManagedMcp) {
    const provision = queueCapabilityManagedServiceProvisionSync({
      workspaceId: input.workspaceId,
      request,
      mcpAutoConnect: isZeroConfigMcp(catalog) && catalog.endpointTemplate
        ? {
          actorUserId: input.actorUserId,
          catalogItemId: catalog.id,
          endpoint: catalog.endpointTemplate,
          approvedTools: safeParseJsonArray(catalog.defaultApprovedToolsJson),
        }
        : undefined,
    });
    if (provision.code === "provision_queued" || provision.code === "provision_in_flight") {
      // Container provisioning is in flight; the daemon provisions it and the
      // convergence hook auto-connects the MCP afterwards (mcpAutoConnect marker).
      const running = readCapabilityRequestSync(request.id, input.workspaceId) ?? request;
      return {
        request: running,
        capabilityRequest: running,
        operationId: provision.operationId,
        nextAction: "wait_for_operation",
      };
    }
    if (provision.code === "template_not_admitted") {
      // No digest-pinned template: fail closed — never fabricate a connection
      // against a container that cannot exist. Stay approved with an audit.
      tryRecordWorkspaceAuditEventSync({
        workspaceId: input.workspaceId,
        title: "Managed MCP template not admitted",
        note: `${request.packageDisplayName} 需要容器部署，但目录未接纳 digest-pinned 模板；请求保持 approved。`,
        code: "capability_request.managed_mcp_template_not_admitted",
        data: { resourceType: "capability_request", resourceId: request.id },
      });
      return { request, capabilityRequest: request, nextAction: "wait_for_operation" };
    }
    if (provision.code === "no_runtime") {
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
    // service_ready: the container is already provisioned — fall through to the
    // connection logic below.
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
 * Phase 5 dispatch for managed_service / external_service capabilities.
 *
 * Fail-closed by default: when MANAGED_SERVICE_PROVISIONING_ENABLED is off the
 * approved request is left in place (not failed, not phantom-running) so the
 * "turning the flag off only stops new operations" contract holds — the request
 * stays visible in the active queue and can be dispatched when ops enables it.
 * When the flag is on, we create a REAL service instance + provision operation
 * through the skill-service container lifecycle (digest-pinned template →
 * managed_skill_service → operation the remote managed node claims). Requests
 * without an admitted template stay approved with an explicit audit trail —
 * we never fabricate an image reference.
 */
function dispatchManagedServiceCapabilityRequestSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
}): DispatchResult {
  const { request } = input;
  const provisioningEnabled = isManagedServiceProvisioningEnabled();
  if (!provisioningEnabled) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Managed service provisioning gated",
      note: `${request.packageDisplayName} (${request.deploymentMode}) approved but MANAGED_SERVICE_PROVISIONING_ENABLED=0; request queued.`,
      code: "capability_request.managed_service_gated",
      data: {
        resourceType: "capability_request",
        resourceId: request.id,
        deploymentMode: request.deploymentMode,
        packageKind: request.packageKind,
        packageSource: request.packageSource,
        packageSlug: request.packageSlug,
      },
    });
    return { request, capabilityRequest: request, nextAction: "wait_for_operation" };
  }

  const queued = queueCapabilityManagedServiceProvisionSync({
    workspaceId: input.workspaceId,
    request,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: queued.code === "service_ready"
      ? "Managed service already provisioned"
      : queued.queued
        ? "Managed service provisioning queued"
        : "Managed service template not admitted",
    note: queued.code === "service_ready"
      ? `${request.packageDisplayName} (${request.deploymentMode}) 已有就绪服务实例 ${queued.serviceId}，无需重复部署。`
      : queued.queued
        ? `${request.packageDisplayName} (${request.deploymentMode}) provision operation ${queued.operationId} queued.`
        : `${request.packageDisplayName} (${request.deploymentMode}) has no admitted digest-pinned template; request stays approved.`,
    code: queued.code === "service_ready"
      ? "capability_request.managed_service_already_ready"
      : queued.queued
        ? "capability_request.managed_service_provisioning_queued"
        : "capability_request.managed_service_template_not_admitted",
    data: {
      resourceType: "capability_request",
      resourceId: request.id,
      deploymentMode: request.deploymentMode,
      packageKind: request.packageKind,
      packageSlug: request.packageSlug,
      serviceId: queued.serviceId,
      operationId: queued.operationId,
    },
  });
  if (queued.code === "service_ready") {
    // S3: the service is already provisioned and healthy — converge the request
    // to completed instead of re-provisioning or leaving it approved forever.
    const completed = transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "completed",
      metadataJson: JSON.stringify({
        ...parseRequestMetadata(request.metadataJson),
        managedServiceCatalogId: readManagedServiceCatalogId(request),
        serviceId: queued.serviceId,
      }),
    });
    const final = completed ?? request;
    return { request: final, capabilityRequest: final, nextAction: "none" };
  }
  if (!queued.queued) {
    // No template / no runtime: keep the request approved and audited rather
    // than failing it — a template may be admitted later.
    return { request, capabilityRequest: request, nextAction: "wait_for_operation" };
  }
  const running = readCapabilityRequestSync(request.id, input.workspaceId) ?? request;
  return {
    request: running,
    capabilityRequest: running,
    operationId: queued.operationId,
    nextAction: "wait_for_operation",
  };
}

function parseRequestMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readManagedServiceCatalogId(request: CapabilityRequestRecord): string | undefined {
  const metadata = parseRequestMetadata(request.metadataJson);
  const id = metadata.managedServiceCatalogId;
  return typeof id === "string" ? id : undefined;
}

function safeBuildInstallPlan(item: RuntimeAppCatalogItemRecord): RuntimeAppInstallPlan | null {
  try {
    return buildRuntimeAppInstallPlan({ item, operation: "install" });
  } catch {
    return null;
  }
}

function readPinnedCliPlan(metadataJson: string): RuntimeAppInstallPlan | null {
  try {
    const metadata = parseRequestMetadata(metadataJson);
    const raw = metadata.cliPlan;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const parsed = JSON.parse(raw) as RuntimeAppInstallPlan;
    return parsed && typeof parsed.app === "object" && Array.isArray(parsed.commands)
      ? parsed
      : null;
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

/**
 * Runtime baseline (docs Phase 7): the base tool a CLI install strategy needs.
 * Image-level tools (npm/python) have no installable baseline — they return
 * undefined and the normal CLI op proceeds (the daemon fails closed if missing).
 */
function requiredBaselineToolForStrategy(
  strategy: RuntimeAppInstallPlan["strategy"],
): "npm" | "pip" | "uv" | "cli_hub" | undefined {
  switch (strategy) {
    case "npm": return "npm";
    case "pip": return "pip";
    case "uv": return "uv";
    case "cli_hub": return "cli_hub";
    default: return undefined;
  }
}

function requiredToolKey(tool: "npm" | "pip" | "uv" | "cli_hub" | "python"): "npm" | "pip" | "uv" | "cliHub" | "python" {
  return tool === "cli_hub" ? "cliHub" : tool;
}

/**
 * Builds a governed baseline install plan the runtime-app executor can run to
 * install a missing base tool into the Runtime HOME. Every installable tool
 * (npm/python/uv/cli-hub) MUST have a pinned artifact — no un-governed package
 * manager install is allowed (immutable-release gate, docs Phase 7). Returns
 * null when no pin is configured; the caller then lets the normal CLI op fail
 * closed instead of fabricating an unverifiable plan.
 */
export function buildRuntimeBaselineInstallPlan(
  tool: "npm" | "pip" | "uv" | "cli_hub" | "python",
): RuntimeAppInstallPlan | null {
  // The plan's app.source must be `workspace_private` so the daemon's
  // parseRuntimeAppInstallPlan accepts the pinned-artifact contract (docs
  // Phase 7). The baseline op identity lives in the runtime_app_operation
  // app_name prefix (runtime-baseline:), not in the plan metadata.
  const base = { source: "workspace_private" as const, version: "1", entryPoint: tool };
  switch (tool) {
    case "pip":
      return {
        app: { ...base, name: "pip" },
        strategy: "pip",
        commands: [{ executable: "python3", args: ["-m", "ensurepip", "--upgrade"] }],
        verifyCommands: [{ executable: "python3", args: ["-m", "pip", "--version"] }],
        risk: "low",
        requiresApproval: false,
        notes: ["Runtime baseline: ensure pip via ensurepip."],
      };
    case "uv":
      return buildBaselinePlanForTool("uv");
    case "cli_hub":
      return buildBaselinePlanForTool("cli_hub");
    case "npm":
      return buildBaselinePlanForTool("npm");
    case "python":
      return buildBaselinePlanForTool("python");
    default:
      return null;
  }
}

function buildBaselinePlanForTool(tool: BaselineTool): RuntimeAppInstallPlan | null {
  const release = resolveBaselineRelease(tool);
  if (!release) return null;
  // Governed pinned-artifact plan (immutable-release gate): the daemon
  // downloads, verifies integrity (and cosign when signatureRequired),
  // extracts and verifies the binary.
  return buildPinnedArtifactBaselinePlan({
    tool,
    release,
    verify: baselineVerifyPath(tool),
    verifyArgs: ["--version"],
  });
}

function baselineVerifyPath(tool: BaselineTool): string {
  switch (tool) {
    case "npm": return ".baseline/bin/node";
    case "python": return ".baseline/bin/python3";
    case "uv": return ".baseline/bin/uv";
    case "cli_hub": return ".baseline/bin/cli-hub";
  }
}

function buildPinnedArtifactBaselinePlan(input: {
  tool: BaselineTool;
  release: BaselineRelease;
  verify: string;
  verifyArgs: string[];
}): RuntimeAppInstallPlan | null {
  // Daemon execution contract (docs Phase 7): pinned artifacts must declare
  // source workspace_private, land under .runtime-app-artifacts/, and carry an
  // integrityLock equal to the artifact integrity — otherwise the daemon's
  // parseRuntimeAppInstallPlan rejects the plan before execution. The artifact
  // URL host must be in the daemon allowlist (npm/pypi, nodejs.org, python.org).
  const localPath = `.runtime-app-artifacts/${input.release.tool}.tgz`;
  const plan: RuntimeAppInstallPlan = {
    app: { source: "workspace_private" as const, name: input.release.tool, version: input.release.version, entryPoint: input.release.tool },
    strategy: "system",
    commands: [{ executable: "tar", args: ["-xzf", localPath, "-C", ".baseline"] }],
    verifyCommands: [{ executable: input.verify, args: input.verifyArgs }],
    risk: "medium",
    requiresApproval: true,
    notes: [`Runtime baseline: pinned ${input.release.tool}@${input.release.version} artifact${input.release.signatureRequired ? " (cosign signature required)" : ""}.`],
    artifactLock: {
      url: input.release.artifactUrl,
      integrity: input.release.integrity,
      localPath,
    },
    integrityLock: input.release.integrity,
  };
  if (input.release.signatureRequired) {
    plan.notes.push("Signature verification is enforced by the managed node before pull.");
  }
  return plan;
}

/**
 * Chaining half of the Runtime baseline (docs Phase 7): when a baseline op
 * (app_source = 'runtime_baseline') referenced by a capability_request reaches a
 * terminal state, create the pending CLI op and re-link the request (baseline
 * success), or fail the request (baseline failure). Called from the daemon
 * runtime-app complete/fail routes after the operation is stamped.
 */
export function chainCapabilityRuntimeBaselineSync(input: {
  workspaceId: string;
  operationId: string;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): void {
  const op = readRuntimeAppOperationSync(input.operationId, input.workspaceId);
  if (!op || !op.appName.startsWith("runtime-baseline:")) return;
  const request = findCapabilityRequestByLinkedRuntimeAppOperationIdSync(input.workspaceId, input.operationId);
  if (!request || !request.runtimeId) return;
  // A cancelled (or otherwise terminal) request must NOT be chained onward —
  // otherwise a late baseline-completion callback would re-create the CLI op and
  // flip the cancelled request back to running (P1).
  if (request.status !== "running") return;
  if (input.outcome !== "succeeded") {
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: input.errorCode ?? "runtime_app.baseline_failed",
      lastErrorMessage: input.errorMessage ?? "Runtime 基础工具补装失败。",
    });
    return;
  }
  const metadata = parseRequestMetadata(request.metadataJson);
  const cliPlan = metadata.pendingCliPlan;
  const runtimeId = request.runtimeId;
  if (typeof cliPlan !== "string" || !cliPlan.trim() || !runtimeId) return;
  // Create the CLI op and re-link the request in ONE transaction so a process
  // crash between the two steps cannot leave an orphan CLI op (P2). On retry the
  // request is still linked to the baseline op (transaction rolled back), so it
  // chains exactly once.
  withTransaction(getDatabase(), () => {
    const cliOp = createRuntimeAppOperationSync({
      workspaceId: input.workspaceId,
      runtimeId,
      appSource: request.packageSource as RuntimeAppCatalogSource,
      appName: request.packageSlug,
      operation: "install",
      requestedByUserId: typeof metadata.baselineActorUserId === "string"
        ? metadata.baselineActorUserId
        : "system",
      commandPlanJson: cliPlan,
    });
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "running",
      linkedRuntimeAppOperationId: cliOp.id,
    });
  });
}

/**
 * Dependency half of the managed_stdio MCP flow (P0): when a runtime-app op
 * linked to a capability_request that carries the mcpPendingConnect marker
 * reaches a terminal state, create the MCP connection once the dependency CLI is
 * installed (success), or fail the request closed (failure). The op uses the
 * REAL catalog identity (source/name), so the marker — not an app-name prefix —
 * identifies the intermediate dependency step. Called from the daemon
 * runtime-app complete/fail routes.
 */
export function chainCapabilityMcpDependencySync(input: {
  workspaceId: string;
  operationId: string;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): void {
  const op = readRuntimeAppOperationSync(input.operationId, input.workspaceId);
  if (!op) return;
  const request = findCapabilityRequestByLinkedRuntimeAppOperationIdSync(input.workspaceId, input.operationId);
  if (!request || !request.runtimeId) return;
  // A cancelled (or otherwise terminal) request must NOT be connected onward —
  // a late dependency-completion callback must not flip a cancelled request back
  // to running (P1).
  if (request.status !== "running") return;
  const metadata = parseRequestMetadata(request.metadataJson);
  const marker = metadata.mcpPendingConnect as { actorUserId?: string; catalogItemId?: string; endpoint?: string; approvedTools?: string[] } | undefined;
  // Only a request the dispatcher marked as pending-connect chains here. A plain
  // CLI op (no marker) must never re-create the connection.
  if (!marker || typeof marker.catalogItemId !== "string") return;
  if (input.outcome !== "succeeded") {
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: input.errorCode ?? "mcp.dependency_install_failed",
      lastErrorMessage: input.errorMessage ?? "依赖 CLI 安装失败，MCP 未连接。",
    });
    return;
  }
  if (!marker || typeof marker.catalogItemId !== "string") return;
  const catalog = readMcpCatalogItemSync(marker.catalogItemId, input.workspaceId);
  if (!catalog || !catalog.endpointTemplate) {
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: "mcp.connection_dispatch_failed",
      lastErrorMessage: "依赖 CLI 已就绪但 MCP 连接无法创建（目录条目缺失）。",
    });
    return;
  }
  try {
    requestMcpConnectionSync({
      workspaceId: input.workspaceId,
      actorUserId: typeof marker.actorUserId === "string" ? marker.actorUserId : "system",
      runtimeId: request.runtimeId,
      catalogItemId: catalog.id,
      endpoint: marker.endpoint || catalog.endpointTemplate,
      approvedTools: Array.isArray(marker.approvedTools) ? marker.approvedTools : safeParseJsonArray(catalog.defaultApprovedToolsJson),
      confirmHighRisk: catalog.risk === "high",
    });
  } catch (error) {
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId: input.workspaceId,
      status: "failed",
      lastErrorCode: "mcp.connection_dispatch_failed",
      lastErrorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}
