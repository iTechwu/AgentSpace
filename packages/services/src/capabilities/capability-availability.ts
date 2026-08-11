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
  transitionCapabilityRequestSync,
  readWorkspaceRuntimeAppReleaseByVersionSync,
  readWorkspaceRuntimeAppReleaseSync,
} from "@dofe-agent/db";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";
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
  // the allowed (packageKind, deploymentMode) pairing from the catalog model —
  // a browser cannot claim `runtime_package` for an MCP service or
  // `managed_service` for a CLI tool. requestedAction is validated against the
  // actions that make sense for the kind.
  assertCapabilityDeploymentPlan(input.packageKind, input.deploymentMode, input.requestedAction);
  // P1-7: the runtime must belong to the target workspace. Without this a
  // member could submit a request pinned to another workspace's runtime id.
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
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
    // Pin workspace-private CLI installs to the exact release id so the
    // approved install plan cannot drift to a yanked release.
    releaseId: resolveCliReleaseId(input.workspaceId, input.packageSource, input.packageSlug),
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
  // Notify admins when a non-admin member needs an admin decision; admins
  // who submit their own requests already have access to the same panel.
  if (!isAdmin && input.requestedAction !== "install" || (!isAdmin && input.requestedAction === "install" && input.deploymentMode !== "runtime_package")) {
    notifyWorkspaceAdminsSync({
      workspaceId,
      title: `能力申请待批准：${input.packageDisplayName}`,
      body: `${input.packageDisplayName} (${input.deploymentMode}) 需要管理员处理。`,
      type: "capability_request_pending",
      severity: "info",
      resourceType: "capability_request",
      resourceId: request.id,
      actionHref: "/market",
      dedupeKey: `capability_request.submitted:${request.id}`,
    });
  }
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
  if (!isCapabilityRequestEnabled()) {
    throw new Error("Capability request channel is disabled (CAPABILITY_REQUESTS_ENABLED=0).");
  }
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
  if (result) {
    notifyCapabilityRequestOwnerSync({
      workspaceId: input.workspaceId,
      request: result,
      title: `能力申请被拒绝：${result.packageDisplayName}`,
      body: `原因：${input.decisionReason}`,
      severity: "warning",
      type: "capability_request_rejected",
    });
  }
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
    (request.packageKind === "mcp" || request.packageKind === "service")
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
 * capability. We dedupe per request id + notification type so admin retries
 * don't flood the inbox.
 */
function notifyCapabilityRequestOwnerSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  type: string;
}): void {
  notifyWorkspaceAdminsSync({
    workspaceId: input.workspaceId,
    title: input.title,
    body: input.body,
    type: input.type,
    severity: input.severity,
    resourceType: "capability_request",
    resourceId: input.request.id,
    actionHref: "/market",
    dedupeKey: `${input.type}:${input.request.id}`,
  });
}