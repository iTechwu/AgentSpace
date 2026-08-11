import type {
  CapabilityDeploymentMode,
  CapabilityPackageKind,
  McpConnectionOperationStage,
  McpConnectionOperationStatus,
  McpConnectionStatus,
  RuntimeAppCatalogItemRecord,
  RuntimeAppOperationStage,
  RuntimeAppOperationStatus,
  RuntimeInstalledAppRecord,
} from "@dofe-agent/db";
import { assessRuntimeAppInstallability } from "../clihub/install-plan.ts";
import { isRuntimeBaselineRolloutEnabled } from "./capability-config.ts";

/**
 * Capability availability projection (docs/0811/cli-install §3, Phase 1).
 *
 * The page never decides "what to do next" from multiple independent flags.
 * The server projects a single `nextAction` for the (workspace, runtime, package)
 * tuple. Underlying persistence — runtime_app_operation, runtime_mcp_connection,
 * runtime_provisioning_task — is still mode-specific; this projection is the
 * user-facing unification.
 *
 * This module is the projection half of the capability stack; the request
 * workflow and dispatch live in capability-workflow.ts / capability-dispatchers.ts.
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
  /**
   * Runtime execution profile (docs/0811/cli-install Phase 2 / §4.5). Optional
   * boolean flags; a missing flag (older daemon, unasserted profile) is treated
   * as "unknown" and never degrades the projection — only an explicit `false`
   * (or `true`) assertion changes negotiation:
   *   writableHome            — false ⇒ the runtime cannot install CLI
   *   runtimePackageExecutor  — false ⇒ the runtime cannot run package installs
   *   mcpGateway              — false ⇒ the runtime cannot host MCP connections
   */
  profile?: {
    writableHome?: boolean;
    persistentHome?: boolean;
    runtimePackageExecutor?: boolean;
    mcpGateway?: boolean;
    managedServiceReachable?: boolean;
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
    // RUNTIME_BASELINE_ROLLOUT_ENABLED: the system auto-rolls-out missing base
    // tools as part of capability installation, so the button stays installable
    // instead of blocking on an admin request (docs Phase 7).
    const baselineEnabled = isRuntimeBaselineRolloutEnabled();
    return {
      ...baseProjection,
      userState: "available",
      nextAction: baselineEnabled || workspace.canManage ? "install" : "request_deployment",
      reasonCode: finalStatus.code,
      reasonText: baselineEnabled
        ? "Runtime 将自动补装缺失的基础工具后安装。"
        : "Runtime 缺少基础工具，请先准备 Runtime。",
    };
  }

  // Execution profile negotiation (docs/0811/cli-install Phase 2): an explicit
  // `writableHome=false` or `runtimePackageExecutor=false` means the runtime
  // cannot install CLI at all, so we never offer an install button — the
  // projection degrades to a governed repair/request path.
  if (
    workspace.profile?.writableHome === false
    || workspace.profile?.runtimePackageExecutor === false
  ) {
    const reasonCode = workspace.profile?.writableHome === false
      ? "runtime.profile_home_not_writable"
      : "runtime.profile_executor_unavailable";
    return {
      ...baseProjection,
      infrastructureState: "not_ready",
      userState: "blocked",
      nextAction: "request_deployment",
      reasonCode,
      reasonText: "该 Runtime 无法落盘安装 CLI，请申请管理员处理。",
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
  // Execution profile negotiation (docs/0811/cli-install Phase 2 / §4.5): an
  // explicit `mcpGateway=false` means the runtime cannot host MCP connections —
  // the projection must not misreport MCP as available (Local Runtime without a
  // Gateway no longer fakes MCP readiness). Unknown (older daemon) keeps the
  // legacy behavior.
  if (workspace.profile?.mcpGateway === false && !connectionStatus) {
    return {
      ...baseProjection,
      infrastructureState: "not_ready",
      userState: "blocked",
      nextAction: "request_deployment",
      reasonCode: "runtime.profile_mcp_gateway_unavailable",
      reasonText: "该 Runtime 未连接 MCP Gateway，请申请管理员处理。",
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

export interface RuntimeAppOperationLike {
  id: string;
  status: RuntimeAppOperationStatus | string;
  stage?: RuntimeAppOperationStage | string;
  errorCode?: string;
  errorMessage?: string;
  failedStage?: string;
}

export interface RuntimeMcpOperationLike {
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

export function classifyCliDeploymentMode(
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
