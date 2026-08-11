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
  readCapabilityRequestSync,
  transitionCapabilityRequestSync,
} from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
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
      reasonText: finalStatus.code ?? "目录条目未通过治理。",
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
  return {
    ...baseProjection,
    userState: "available",
    nextAction: workspace.canManage ? "install" : "request_deployment",
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
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId });
  const existing = listCapabilityRequestsSync({
    workspaceId,
    runtimeId: input.runtimeId,
    packageKind: input.packageKind,
    packageSlug: input.packageSlug,
    statuses: ["pending", "approved", "running"],
    limit: 1,
  })[0];
  if (existing) {
    return {
      capabilityRequest: existing,
      nextAction: existing.status === "running" ? "wait_for_operation" : "wait_for_approval",
    };
  }
  const request = createCapabilityRequestSync({
    workspaceId,
    requestedByUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    packageKind: input.packageKind,
    packageSource: input.packageSource,
    packageSlug: input.packageSlug,
    packageDisplayName: input.packageDisplayName,
    deploymentMode: input.deploymentMode,
    requestedAction: input.requestedAction,
    priority: input.priority ?? "normal",
    message: input.message ?? "",
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Capability request submitted",
    note: `${input.packageDisplayName} (${input.deploymentMode}/${input.requestedAction}) requested.`,
    code: "capability_request.submitted",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "capability_request",
      resourceId: request.id,
      deploymentMode: input.deploymentMode,
      requestedAction: input.requestedAction,
    },
  });
  if (
    isAdmin
    && input.deploymentMode === "runtime_package"
    && input.requestedAction === "install"
  ) {
    const approved = decideCapabilityRequestSync({
      requestId: request.id,
      workspaceId,
      decidedByUserId: input.actorUserId,
      decision: "approved",
      decisionReason: "auto-approved by workspace admin",
    });
    if (approved) {
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
    nextAction: isAdmin && input.deploymentMode !== "runtime_package"
      ? "wait_for_operation"
      : "wait_for_approval",
  };
}

export function approveCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  decisionReason?: string;
}): SubmitCapabilityRequestResult {
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin) {
    throw new Error("Only workspace owners and admins can approve capability requests.");
  }
  const decided = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "approved",
    decisionReason: input.decisionReason,
  });
  if (!decided) throw new Error("capability_request.not_found");
  return dispatchApprovedCapabilityRequestSync({
    workspaceId: input.workspaceId,
    requestId: decided.id,
    actorUserId: input.actorUserId,
  });
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
  const result = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "rejected",
    decisionReason: input.decisionReason,
  });
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
    const activeOp = cliOps.find((op) => isActiveRuntimeAppOperation(op));
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