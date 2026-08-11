import type {
  CapabilityDeploymentMode,
  CapabilityPackageKind,
  CapabilityRequestRecord,
  McpConnectionOperationStage,
  McpConnectionOperationStatus,
  McpConnectionStatus,
  RuntimeAppCatalogItemRecord,
  RuntimeAppCatalogSource,
  RuntimeAppOperationStage,
  RuntimeAppOperationStatus,
  RuntimeInstalledAppRecord,
} from "@dofe-agent/db";
import {
  createCapabilityRequestSync,
  createRuntimeAppOperationSync,
  decideCapabilityRequestSync,
  listCapabilityRequestsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listRuntimeAppCatalogItemsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  readAgentRuntimeSync,
  readCapabilityRequestSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemSync,
  transitionCapabilityRequestSync,
  readWorkspaceRuntimeAppReleaseByVersionSync,
  readWorkspaceRuntimeAppReleaseSync,
} from "@dofe-agent/db";
import { requestMcpConnectionSync } from "../mcp-center/connections.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { createNotificationSync, notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { assessRuntimeAppInstallability, buildRuntimeAppInstallPlan } from "../clihub/install-plan.ts";
import { listMcpCatalogItemsForWorkspaceSync } from "../mcp-center/catalog.ts";
import { resolveMcpRuntimeAppRequirement } from "../mcp-center/official-catalog.ts";
import { listWorkspaceRuntimeAppCatalogItemsSync } from "../clihub/private-releases.ts";
import { selectCliHubReadiness } from "../clihub/runtime-apps.ts";
import type { RuntimeAppInstallPlan } from "@dofe-agent/domain";

/**
 * Capability availability projection (docs/0811/cli-install §3, Phase 1).
 *
 * The page never decides "what to do next" from multiple independent flags.
 * The server projects a single `nextAction` for the (workspace, runtime, package)
 * tuple. Underlying persistence — runtime_app_operation, runtime_mcp_connection,
 * runtime_provisioning_task — is still mode-specific; this projection is the
 * user-facing unification.
 */

export type CapabilityNextAction =
  | "install"
  | "connect"
  | "configure_credentials"
  | "request_deployment"
  | "wait_for_approval"
  | "wait_for_operation"
  | "repair"
  | "govern_release"
  | "none";

export type CapabilityCatalogState = "approved" | "pending" | "rejected" | "yanked";
export type CapabilityInfrastructureState =
  | "ready"
  | "not_ready"
  | "deploying"
  | "degraded"
  | "unknown";
export type CapabilityUserState =
  | "available"
  | "installed"
  | "connected"
  | "requested"
  | "blocked";

export interface CapabilityAvailabilityProjection {
  packageId: string;
  releaseId?: string;
  runtimeId: string;
  kind: CapabilityPackageKind;
  deploymentMode: CapabilityDeploymentMode;
  catalogState: CapabilityCatalogState;
  infrastructureState: CapabilityInfrastructureState;
  userState: CapabilityUserState;
  nextAction: CapabilityNextAction;
  reasonCode?: string;
  reasonText: string;
  canManage: boolean;
  /** When a capability_request covers this (runtime, package, action) tuple,
   *  we attach its id so the UI can deep-link to "我的请求". */
  capabilityRequestId?: string;
  operationId?: string;
}

interface ProjectCapabilityInput {
  workspaceId: string;
  runtimeId: string;
  runtimeStatus: "online" | "offline" | "unknown";
  canManage: boolean;
  readiness: {
    npm: boolean;
    python: boolean;
    pip: boolean;
    cliHub: boolean;
  };
}

export function projectCliCapabilityAvailability(input: {
  workspace: ProjectCapabilityInput;
  item: RuntimeAppCatalogItemRecord;
  installed?: RuntimeInstalledAppRecord | null;
  activeOperations: RuntimeAppOperationLike[];
}): CapabilityAvailabilityProjection {
  const { workspace, item, installed, activeOperations } = input;
  const installability = assessRuntimeAppInstallability(item);
  const readinessProjection = {
    npm: workspace.readiness.npm,
    python: workspace.readiness.python,
    pip: workspace.readiness.pip,
    cliHub: workspace.readiness.cliHub,
  };
  const finalStatus = composeInstallability(
    installability.status,
    installability.requiredTools,
    readinessProjection,
    installability.code,
  );

  const packageId = `${item.source}:${item.name}`;
  const baseProjection = {
    packageId,
    runtimeId: workspace.runtimeId,
    kind: "cli" as const,
    deploymentMode: classifyCliDeploymentMode(item),
    catalogState: installability.status === "unsupported" ? ("rejected" as const) : ("approved" as const),
    infrastructureState: workspace.runtimeStatus === "online"
      ? ("ready" as const)
      : workspace.runtimeStatus === "offline"
      ? ("not_ready" as const)
      : ("unknown" as const),
    canManage: workspace.canManage,
  };

  if (installed && installed.status === "installed" && installed.enabled) {
    return {
      ...baseProjection,
      userState: "installed",
      nextAction: "none",
      reasonText: "已安装到目标 Runtime。",
      operationId: activeOperations[0]?.id,
    };
  }

  if (activeOperations.length > 0) {
    return {
      ...baseProjection,
      userState: "requested",
      nextAction: "wait_for_operation",
      reasonText: reasonForRuntimeAppOperation(activeOperations[0]),
      operationId: activeOperations[0].id,
    };
  }

  if (finalStatus.status === "unsupported" && finalStatus.code === "runtime_app.release_unpinned") {
    return {
      ...baseProjection,
      catalogState: "pending",
      userState: "blocked",
      nextAction: "govern_release",
      reasonCode: finalStatus.code,
      reasonText: "目录尚未发布不可变 release，平台管理员需要先审核。",
    };
  }

  if (finalStatus.status === "unsupported") {
    return {
      ...baseProjection,
      userState: "blocked",
      nextAction: "govern_release",
      reasonCode: finalStatus.code,
      reasonText: "目录条目暂不可用，可申请管理员处理。",
    };
  }

  if (finalStatus.status === "needs_configuration") {
    if (workspace.runtimeStatus === "offline") {
      return {
        ...baseProjection,
        infrastructureState: "not_ready",
        userState: "blocked",
        nextAction: "request_deployment",
        reasonCode: finalStatus.code,
        reasonText: "目标 Runtime 当前离线，请等待恢复或申请管理员处理。",
      };
    }
    return {
      ...baseProjection,
      userState: "available",
      nextAction: workspace.canManage ? "install" : "request_deployment",
      reasonCode: finalStatus.code,
      reasonText: "Runtime 缺少基础工具，请先准备 Runtime。",
    };
  }

  if (workspace.runtimeStatus !== "online") {
    return {
      ...baseProjection,
      infrastructureState: "not_ready",
      userState: "blocked",
      nextAction: "request_deployment",
      reasonCode: "runtime.offline",
      reasonText: "没有可用的在线 Runtime。",
    };
  }
  // Infra is ready and the CLI has a valid install plan — the button is enabled
  // for everyone (docs §6 "安装：系统可以自动完成"). Members' clicks submit a
  // capability request that goes through admin approval; admins execute the
  // install directly. Only the infra-not-ready cases surface `request_deployment`.
  return {
    ...baseProjection,
    userState: "available",
    nextAction: "install",
    reasonCode: installability.code,
    reasonText: "可通过 Runtime 按需安装。",
  };
}

export function projectMcpCapabilityAvailability(input: {
  workspace: ProjectCapabilityInput;
  catalogItem: {
    id: string;
    transport: "streamable_http" | "stdio" | "managed_stdio";
    slug: string;
    displayName: string;
    risk: string;
    declaredToolsJson: string;
    requiredRuntimeCapabilitiesJson: string;
  };
  connectionStatus?: McpConnectionStatus | null;
  activeOperations: RuntimeMcpOperationLike[];
}): CapabilityAvailabilityProjection {
  const { workspace, catalogItem, connectionStatus, activeOperations } = input;
  const baseProjection = {
    packageId: catalogItem.id,
    runtimeId: workspace.runtimeId,
    kind: "mcp" as const,
    deploymentMode: catalogItem.transport === "streamable_http"
      ? ("external_service" as const)
      : ("managed_service" as const),
    catalogState: "approved" as const,
    infrastructureState: workspace.runtimeStatus === "online" ? ("ready" as const) : ("unknown" as const),
    canManage: workspace.canManage,
  };

  if (connectionStatus === "ready") {
    return {
      ...baseProjection,
      userState: "connected",
      nextAction: "none",
      reasonText: "已连接并完成工具发现。",
      operationId: activeOperations[0]?.id,
    };
  }
  if (connectionStatus === "degraded") {
    return {
      ...baseProjection,
      infrastructureState: "degraded",
      userState: "connected",
      nextAction: "repair",
      reasonText: "健康检查失败，请稍后重试或重新验证。",
      operationId: activeOperations[0]?.id,
    };
  }
  if (activeOperations.length > 0) {
    return {
      ...baseProjection,
      userState: "requested",
      nextAction: "wait_for_operation",
      reasonText: reasonForMcpOperation(activeOperations[0]),
      operationId: activeOperations[0].id,
    };
  }
  if (catalogItem.transport === "streamable_http") {
    return {
      ...baseProjection,
      userState: "available",
      nextAction: "configure_credentials",
      reasonText: "请填写已声明的连接参数。",
    };
  }
  return {
    ...baseProjection,
    userState: "blocked",
    nextAction: "request_deployment",
    reasonText: "服务尚未部署，请申请管理员准备。",
  };
}

interface RuntimeAppOperationLike {
  id: string;
  status: RuntimeAppOperationStatus | string;
  stage?: RuntimeAppOperationStage | string;
  errorCode?: string;
  errorMessage?: string;
  failedStage?: string;
}

interface RuntimeMcpOperationLike {
  id: string;
  status: McpConnectionOperationStatus | string;
  stage?: McpConnectionOperationStage | string;
  errorCode?: string;
  errorMessage?: string;
  failedStage?: string;
}

function composeInstallability(
  baseStatus: "installable" | "needs_configuration" | "unsupported",
  requiredTools: Array<"npm" | "python" | "pip" | "cli_hub">,
  readiness: { npm: boolean; python: boolean; pip: boolean; cliHub: boolean },
  code: string | undefined,
): {
  status: "installable" | "needs_configuration" | "unsupported";
  code?: string;
  requiredTools: Array<"npm" | "python" | "pip" | "cli_hub">;
} {
  if (baseStatus !== "installable") return { status: baseStatus, code, requiredTools };
  for (const tool of requiredTools) {
    const key = tool === "cli_hub" ? "cliHub" : tool;
    if (!readiness[key as keyof typeof readiness]) {
      return {
        status: "needs_configuration",
        code: `runtime_app.runtime_${tool}_unavailable`,
        requiredTools,
      };
    }
  }
  return { status: "installable", code, requiredTools };
}

function classifyCliDeploymentMode(
  item: RuntimeAppCatalogItemRecord,
): CapabilityDeploymentMode {
  // Treat CLI-Hub and bundled strategies as runtime-bound (they reuse the
  // Runtime PATH rather than pulling a fresh package). npm/pip/uv go through
  // the per-Runtime HOME. Anything else falls back to per-Runtime package.
  if (item.installStrategy === "cli_hub" || item.installStrategy === "bundled") {
    return "runtime_builtin";
  }
  return "runtime_package";
}

function reasonForRuntimeAppOperation(op: RuntimeAppOperationLike): string {
  if (op.status === "running") return "Runtime 正在安装或验证该 CLI。";
  if (op.status === "claimed") return "Runtime 已认领该安装任务，正在执行。";
  if (op.status === "pending") return "已记录安装任务，等待 Runtime 认领。";
  if (op.status === "failed") return `Runtime 安装失败：${op.errorMessage ?? op.errorCode ?? "未知错误"}`;
  if (op.status === "completed") return "Runtime 安装已完成。";
  return "Runtime 安装任务进行中。";
}

function reasonForMcpOperation(op: RuntimeMcpOperationLike): string {
  if (op.status === "running") return "正在执行 MCP 握手或工具发现。";
  if (op.status === "claimed") return "MCP 任务已被认领。";
  if (op.status === "pending") return "MCP 任务等待执行。";
  if (op.status === "failed") return `MCP 连接失败：${op.errorMessage ?? op.errorCode ?? "未知错误"}`;
  if (op.status === "completed") return "MCP 连接已完成。";
  return "MCP 任务进行中。";
}

/**
 * Server-side deployment-plan boundary (P1-7). The browser only submits
 * identifiers; the server must reject a (packageKind, deploymentMode,
 * requestedAction) triple that the catalog model could never produce. This
 * stops a crafted request from pinning, say, a CLI install to a managed
 * service lifecycle or an MCP connect to a runtime package install.
 */
function assertCapabilityDeploymentPlan(
  packageKind: CapabilityPackageKind,
  deploymentMode: CapabilityDeploymentMode,
  requestedAction: "install" | "deploy" | "connect" | "upgrade",
): void {
  const allowedDeploymentModes: Record<CapabilityPackageKind, CapabilityDeploymentMode[]> = {
    cli: ["runtime_builtin", "runtime_package"],
    mcp: ["managed_service", "external_service"],
    service: ["managed_service", "external_service"],
  };
  const allowedActions: Record<CapabilityPackageKind, string[]> = {
    cli: ["install", "upgrade"],
    mcp: ["connect", "deploy", "upgrade"],
    service: ["deploy", "upgrade"],
  };
  if (!allowedDeploymentModes[packageKind].includes(deploymentMode)) {
    throw new Error(`capability_request.deployment_mode_mismatch:${packageKind}:${deploymentMode}`);
  }
  if (!allowedActions[packageKind].includes(requestedAction)) {
    throw new Error(`capability_request.requested_action_mismatch:${packageKind}:${requestedAction}`);
  }
}

/**
 * Submit a unified capability request. Underlying execution (CLI install,
 * MCP connect, managed service provision) is still dispatched to the
 * corresponding lower-level subsystem — this entry point only persists the
 * user-visible task envelope and idempotency key.
 */
export interface SubmitCapabilityRequestInput {
  workspaceId: string;
  runtimeId: string;
  actorUserId: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  deploymentMode: CapabilityDeploymentMode;
  requestedAction: "install" | "deploy" | "connect" | "upgrade";
  priority?: "normal" | "urgent";
  message?: string;
}

export interface SubmitCapabilityRequestResult {
  capabilityRequest: CapabilityRequestRecord;
  dispatchedOperationId?: string;
  nextAction: CapabilityNextAction;
}

export function submitCapabilityRequestSync(
  input: SubmitCapabilityRequestInput,
): SubmitCapabilityRequestResult {
  const workspaceId = input.workspaceId;
  if (!isCapabilityRequestEnabled()) {
    throw new Error("Capability request channel is disabled (CAPABILITY_REQUESTS_ENABLED=0).");
  }
  // P1-7: never trust the browser's deployment decision. The server re-derives
  // the deployment mode from the actual catalog entry (transport / install
  // strategy / release), so a browser cannot claim `runtime_package` for an MCP
  // service or `external_service` for a CLI tool. The generic kind matrix is a
  // first line of defense; the catalog re-derivation is authoritative.
  const catalogPlan = resolveCapabilityDeploymentPlan(input, workspaceId);
  const deploymentMode = catalogPlan?.deploymentMode ?? input.deploymentMode;
  assertCapabilityDeploymentPlan(input.packageKind, deploymentMode, input.requestedAction);
  // P1-7: the runtime must belong to the target workspace. Without this a
  // member could submit a request pinned to another workspace's runtime id.
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId });
  // For MCP/service requests we pin the exact catalog item id in metadata so
  // dispatch cannot silently drift to a newer release with the same slug
  // (docs/0811/cli-install P1-3).
  const metadataJson = buildCapabilityRequestMetadataJson(input.packageKind, input.packageSlug, workspaceId, catalogPlan?.catalogItemId);
  // CAS idempotency: createCapabilityRequestSync atomically inserts a new row,
  // reopens a terminal request, or returns an in-flight request unchanged. Only
  // the created/reopened cases record an audit event and notify admins, so a
  // concurrent double-submit writes exactly one audit row. The DB CAS is the
  // single source of truth — the previous read-before-create guard is gone.
  const { record: request, outcome } = createCapabilityRequestSync({
    workspaceId,
    requestedByUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    packageKind: input.packageKind,
    packageSource: input.packageSource,
    packageSlug: input.packageSlug,
    packageDisplayName: catalogPlan?.displayName ?? input.packageDisplayName,
    deploymentMode,
    requestedAction: input.requestedAction,
    priority: input.priority ?? "normal",
    message: input.message ?? "",
    // Pin workspace-private CLI installs to the exact release id so the
    // approved install plan cannot drift to a yanked release.
    releaseId: resolveCliReleaseId(input.workspaceId, input.packageSource, input.packageSlug),
    metadataJson,
  });
  if (outcome === "in_flight") {
    return {
      capabilityRequest: request,
      nextAction: request.status === "running" ? "wait_for_operation" : "wait_for_approval",
    };
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Capability request submitted",
    note: `${request.packageDisplayName} (${deploymentMode}/${input.requestedAction}) requested.`,
    code: "capability_request.submitted",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "capability_request",
      resourceId: request.id,
      deploymentMode,
      requestedAction: input.requestedAction,
    },
  });
  // Notify admins whenever a non-admin submits a request — every non-admin
  // request needs an admin decision (approval or dispatch), including a
  // runtime_package install, which only auto-approves when an admin submits it.
  // Admins who submit their own requests already have access to the same panel.
  if (!isAdmin) {
    notifyWorkspaceAdminsSync({
      workspaceId,
      title: `能力申请待批准：${request.packageDisplayName}`,
      body: `${request.packageDisplayName} (${deploymentMode}) 需要管理员处理。`,
      type: "capability_request_pending",
      severity: "info",
      resourceType: "capability_request",
      resourceId: request.id,
      actionHref: "/market",
      // Round-scoped key: a reopened terminal request reuses the same request
      // id, so including updatedAt gives each round its own unread notification
      // instead of silently updating the previous round's row.
      dedupeKey: `capability_request.submitted:${request.id}:${request.updatedAt}`,
    });
  }
  if (isAdmin) {
    const { record: approved, changed } = decideCapabilityRequestSync({
      requestId: request.id,
      workspaceId,
      decidedByUserId: input.actorUserId,
      decision: "approved",
      decisionReason: "auto-approved by workspace admin",
    });
    if (approved && changed) {
      const dispatched = dispatchApprovedCapabilityRequestSync({
        workspaceId,
        requestId: approved.id,
        actorUserId: input.actorUserId,
      });
      return {
        capabilityRequest: dispatched.request,
        dispatchedOperationId: dispatched.operationId,
        nextAction: dispatched.nextAction,
      };
    }
  }
  return {
    capabilityRequest: request,
    nextAction: "wait_for_approval",
  };
}

interface ResolvedCapabilityCatalogPlan {
  deploymentMode: CapabilityDeploymentMode;
  catalogItemId?: string;
  displayName?: string;
}

/**
 * Authoritative server-side deployment re-derivation (docs/0811/cli-install
 * P1-7). The browser submits identifiers only; the server looks up the real
 * catalog entry and derives the deployment mode from it:
 *   - CLI:   install strategy (cli_hub/bundled → runtime_builtin, else
 *            runtime_package)
 *   - MCP:   transport (streamable_http → external_service, else
 *            managed_service)
 *   - service: same MCP catalog resolution.
 * When the entry cannot be found (e.g. a yanked/removed item), we fall back to
 * the browser's declared mode so the generic kind matrix still bounds it, but
 * dispatch will fail closed on the missing entry.
 */
function resolveCapabilityDeploymentPlan(
  input: SubmitCapabilityRequestInput,
  workspaceId: string,
): ResolvedCapabilityCatalogPlan | null {
  if (input.packageKind === "cli") {
    const item = findCliCatalogItem(workspaceId, input.packageSource, input.packageSlug);
    if (!item) return null;
    return {
      deploymentMode: classifyCliDeploymentMode(item),
      displayName: item.displayName,
    };
  }
  // MCP / service — resolve the workspace catalog item by slug, pin the exact
  // catalogItemId so dispatch cannot drift to a newer same-slug release.
  const catalog = readMcpCatalogItemBySlugSync(input.packageSlug, workspaceId);
  if (!catalog) return null;
  return {
    deploymentMode: catalog.transport === "streamable_http" ? "external_service" : "managed_service",
    catalogItemId: catalog.id,
    displayName: catalog.displayName,
  };
}

function buildCapabilityRequestMetadataJson(
  packageKind: CapabilityPackageKind,
  packageSlug: string,
  workspaceId: string,
  resolvedCatalogItemId?: string,
): string {
  if (packageKind !== "mcp") return "{}";
  const catalogItemId = resolvedCatalogItemId
    ?? readMcpCatalogItemBySlugSync(packageSlug, workspaceId)?.id;
  if (!catalogItemId) return "{}";
  return JSON.stringify({ catalogItemId });
}

export function approveCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  decisionReason?: string;
}): SubmitCapabilityRequestResult {
  if (!isCapabilityRequestEnabled()) {
    throw new Error("Capability request channel is disabled (CAPABILITY_REQUESTS_ENABLED=0).");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin) {
    throw new Error("Only workspace owners and admins can approve capability requests.");
  }
  const { record: decided, changed } = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "approved",
    decisionReason: input.decisionReason,
  });
  if (!decided) throw new Error("capability_request.not_found");
  // Only dispatch when the approval actually changed the row. A repeated
  // approval, an approval of an already-terminal request, or a lost race with
  // another admin must not spawn a second operation (docs/0811/cli-install P1).
  if (!changed) {
    const request = readCapabilityRequestSync(input.requestId, input.workspaceId);
    if (!request) throw new Error("capability_request.not_found");
    return {
      capabilityRequest: request,
      dispatchedOperationId: request.linkedRuntimeAppOperationId ?? request.linkedMcpConnectionId ?? undefined,
      nextAction: request.status === "running" ? "wait_for_operation" : "wait_for_approval",
    };
  }
  const dispatched = dispatchApprovedCapabilityRequestSync({
    workspaceId: input.workspaceId,
    requestId: decided.id,
    actorUserId: input.actorUserId,
  });
  // Notify the original requester that their submission has been approved.
  notifyCapabilityRequestOwnerSync({
    workspaceId: input.workspaceId,
    request: dispatched.capabilityRequest,
    title: `能力申请已批准：${dispatched.capabilityRequest.packageDisplayName}`,
    body: dispatched.nextAction === "wait_for_operation"
      ? `已批准并开始执行（${dispatched.capabilityRequest.deploymentMode}）。`
      : `已批准，等待下一步执行（${dispatched.capabilityRequest.deploymentMode}）。`,
    severity: "info",
    type: "capability_request_approved",
  });
  return dispatched;
}

export function rejectCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  decisionReason: string;
}): CapabilityRequestRecord | null {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    throw new Error("Only workspace owners and admins can reject capability requests.");
  }
  if (!input.decisionReason.trim()) {
    throw new Error("Rejection requires a user-facing reason.");
  }
  const { record: result, changed } = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "rejected",
    decisionReason: input.decisionReason,
  });
  if (!result) throw new Error("capability_request.not_found");
  // Rejecting an already-terminal or non-pending request is a CAS no-op —
  // the status did not change, so we must not write a fresh "rejected" audit
  // or notify the owner as if the rejection landed (docs/0811/cli-install P1).
  if (!changed) {
    return result;
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Capability request rejected",
    note: `${input.decisionReason}`,
    code: "capability_request.rejected",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "capability_request",
      resourceId: input.requestId,
    },
  });
  notifyCapabilityRequestOwnerSync({
    workspaceId: input.workspaceId,
    request: result,
    title: `能力申请被拒绝：${result.packageDisplayName}`,
    body: `原因：${input.decisionReason}`,
    severity: "warning",
    type: "capability_request_rejected",
  });
  return result;
}

interface DispatchResult {
  request: CapabilityRequestRecord;
  capabilityRequest: CapabilityRequestRecord;
  operationId?: string;
  nextAction: CapabilityNextAction;
}

function dispatchApprovedCapabilityRequestSync(input: {
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
  // verify, provision, health, retire) which is rolled out behind
  // MANAGED_SERVICE_PROVISIONING_ENABLED. We deliberately do NOT fabricate a
  // runtime_provisioning_task row here: that table's runtimeType is a model
  // DaemonProvider (claude/codex/gemini…), so writing an MCP managed-service
  // request into it would mis-drive the model-runtime pipeline (billing
  // preflight, credential issuance). Instead we record an explicit, audited,
  // fail-closed seam and leave the request in its approved state so it can be
  // dispatched once the container driver lands and the flag is on.
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
 * MCP dispatch (P1-1). Resolves the catalog item by the request's packageSlug,
 * then either auto-connects (zero-config: no secret fields + deterministic
 * endpoint template) or surfaces configure_credentials for the applicant to
 * finish. The actual connection create + verify-op queue happens in
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

export interface CompleteCapabilityRequestMcpConnectionInput {
  workspaceId: string;
  actorUserId: string;
  runtimeId: string;
  catalogItemId: string;
  endpoint: string;
  nonSecretParams?: Record<string, unknown>;
  secrets?: Record<string, string>;
  approvedTools?: string[];
  confirmHighRisk?: boolean;
}

export interface CompleteCapabilityRequestMcpConnectionResult {
  connectionId: string;
  operationId: string;
}

/**
 * Member completion of an approved credential-bearing MCP connection
 * (docs/0811/cli-install P0). After an admin approves a request whose catalog
 * item needs secrets/endpoint/config, the projection surfaces
 * `configure_credentials`. The applicant (or an admin) fills the form and calls
 * this — it verifies an `approved` capability_request covers the exact
 * (workspace, runtime, catalog item) tuple and that the actor is the request
 * owner (or an admin), then materializes the connection via
 * {@link requestMcpConnectionSync} with the admin-gate bypass. The link-back
 * inside that call binds the approved request to the new connection and drives
 * it to running; the verify op then converges it to completed/failed.
 */
export function completeCapabilityRequestMcpConnectionSync(
  input: CompleteCapabilityRequestMcpConnectionInput,
): CompleteCapabilityRequestMcpConnectionResult {
  const catalog = readMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  if (!catalog) throw new Error("mcp_catalog.not_found");

  // Only the request owner (or an admin) may complete the connection. We find
  // the approved request by its catalog item identity so a same-slug newer
  // release can never hijack the approval.
  const requests = listCapabilityRequestsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    packageKind: "mcp",
    packageSlug: catalog.slug,
    statuses: ["approved"],
    limit: 10,
  });
  const approvedRequest = requests.find((request) => {
    const pinned = resolveMcpCatalogItemIdFromRequest(request);
    return request.packageSource === catalog.source && (!pinned || pinned === catalog.id);
  });
  if (!approvedRequest) {
    throw new Error("capability_request.not_approved");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin && approvedRequest.requestedByUserId !== input.actorUserId) {
    throw new Error("capability_request.not_owner");
  }

  const result = requestMcpConnectionSync({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    catalogItemId: catalog.id,
    endpoint: input.endpoint,
    nonSecretParams: input.nonSecretParams,
    secrets: input.secrets,
    approvedTools: input.approvedTools,
    confirmHighRisk: input.confirmHighRisk,
    // Authorization was verified above via the approved request ownership.
    requireManage: false,
  });
  return { connectionId: result.connection.id, operationId: result.operation.id };
}

function resolveMcpCatalogItemIdFromRequest(request: CapabilityRequestRecord): string | undefined {
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

function findCliCatalogItem(workspaceId: string, source: string, slug: string) {
  const allItems = [
    ...listRuntimeAppCatalogItemsSync({ limit: 1000 }),
    ...listWorkspaceRuntimeAppCatalogItemsSync(workspaceId),
  ];
  return allItems.find((item) => item.source === (source as RuntimeAppCatalogSource) && item.name === slug) ?? null;
}

function isActiveRuntimeAppOperation(op: { status: string }): boolean {
  return op.status === "pending" || op.status === "claimed" || op.status === "running";
}

/**
 * Aggregate capability requests for the (workspace, runtime) tuple so the page
 * can deep-link to "我的请求" without re-querying the request store itself.
 */
export function listActiveCapabilityRequestsForRuntime(input: {
  workspaceId: string;
  runtimeId: string;
}): CapabilityRequestRecord[] {
  return listCapabilityRequestsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    statuses: ["pending", "approved", "running"],
    limit: 200,
  });
}

/**
 * Re-export the lower-level catalog / connection helpers for API routes that
 * want a single import surface for capability work.
 */
export {
  listRuntimeInstalledAppsSync,
  listRuntimeAppOperationsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listMcpCatalogItemsForWorkspaceSync,
  selectCliHubReadiness,
  resolveMcpRuntimeAppRequirement,
};

/**
 * Feature flag: when disabled, all capability-request entry points return
 * "temporarily unavailable" without persisting or dispatching. The page
 * keeps its UI but every action becomes a no-op. Fail-closed: missing env
 * var defaults to the legacy CLI/MCP path being still available, so a
 * freshly deployed instance does not surprise users.
 */
export function isCapabilityRequestEnabled(): boolean {
  const flag = process.env.CAPABILITY_REQUESTS_ENABLED;
  return flag !== "0";
}

/**
 * For workspace-private CLI installs, pin the request to a specific release.
 * For non-workspace sources we deliberately leave it null — the runtime
 * already fetches the exact (source, name) pair, and a release row only
 * exists for private artifacts. Public catalog items continue to flow
 * through the runtime-side resolution path.
 */
function resolveCliReleaseId(
  workspaceId: string,
  packageSource: string,
  packageSlug: string,
): string | undefined {
  if (packageSource !== "workspace_private") return undefined;
  const catalogItem = findCliCatalogItem(workspaceId, packageSource, packageSlug);
  if (!catalogItem?.version) return undefined;
  const release = readWorkspaceRuntimeAppReleaseByVersionSync({
    workspaceId,
    slug: packageSlug,
    version: catalogItem.version,
  });
  return release?.id;
}

/**
 * Feature flag for the new server-side projection endpoint. When disabled,
 * the loader falls back to the legacy client-side `installability` flag
 * (see `projectRuntimeAppInstallability` in market-page-client). The page
 * keeps rendering — only the unified `nextAction` source of truth is
 * removed.
 */
export function isCapabilityProjectionEnabled(): boolean {
  const flag = process.env.CAPABILITY_AVAILABILITY_PROJECTION_V2;
  return flag !== "0";
}

/**
 * Feature flag for the managed-service container lifecycle (docs Phase 5/§8).
 * Fail-closed: defaults to disabled. While off, approved managed_service /
 * external_service capability requests are recorded and queued but not
 * provisioned — the dispatch seam (see dispatchManagedServiceCapabilityRequestSync)
 * leaves them in their approved state with an audit trail. Flipping this on is
 * a no-op until the container driver is connected; it only unblocks dispatch.
 */
export function isManagedServiceProvisioningEnabled(): boolean {
  return process.env.MANAGED_SERVICE_PROVISIONING_ENABLED === "1";
}

/**
 * Feature flag for the Runtime baseline rollout (docs Phase 7). Fail-closed:
 * defaults to disabled. Controls whether missing base tools (npm/pip/uv) are
 * auto-rolled-out to a runtime as part of capability installation, rather than
 * surfacing a manual "repair" nextAction. While off, the projection keeps
 * pointing users at the governed repair path.
 */
export function isRuntimeBaselineRolloutEnabled(): boolean {
  return process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED === "1";
}

/**
 * Send a workspace notification to the user who originally requested the
 * capability (the applicant), so they learn the outcome of their request
 * without polling the page. We dedupe per request id + notification type +
 * round (updatedAt) so admin retries within a round don't flood the inbox,
 * while a reopened terminal request gets a fresh unread row instead of silently
 * updating the previous round's row.
 */
function notifyCapabilityRequestOwnerSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  type: string;
}): void {
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: input.request.requestedByUserId,
    title: input.title,
    body: input.body,
    type: input.type,
    severity: input.severity,
    resourceType: "capability_request",
    resourceId: input.request.id,
    actionHref: "/market",
    dedupeKey: `${input.type}:${input.request.id}:${input.request.updatedAt}`,
  });
}