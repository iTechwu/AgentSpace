// 能力部署与请求（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


export type CapabilityDeploymentMode =
  | "runtime_builtin"
  | "runtime_package"
  | "managed_service"
  | "external_service";

export type CapabilityPackageKind = "cli" | "mcp" | "service";

export type CapabilityRequestedAction = "install" | "deploy" | "connect" | "upgrade" | "parse";

export type CapabilityRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CapabilityRequestPriority = "normal" | "urgent";

export interface CapabilityRequestRecord {
  id: string;
  workspaceId: string;
  requestedByUserId: string;
  decidedByUserId?: string;
  runtimeId?: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  deploymentMode: CapabilityDeploymentMode;
  requestedAction: CapabilityRequestedAction;
  priority: CapabilityRequestPriority;
  message: string;
  status: CapabilityRequestStatus;
  decisionReason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  linkedRuntimeAppOperationId?: string;
  linkedRuntimeInstalledAppId?: string;
  linkedMcpConnectionId?: string;
  linkedRuntimeProvisioningTaskId?: string;
  linkedKnowledgePageId?: string;
  /** When the package has an immutable release (e.g. workspace-private CLI),
   *  the request pins the release id so the underlying install plan cannot
   *  drift after the request is approved. */
  releaseId?: string;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  completedAt?: string;
}

export function isCapabilityDeploymentMode(value: unknown): value is CapabilityDeploymentMode {
  return (
    value === "runtime_builtin" ||
    value === "runtime_package" ||
    value === "managed_service" ||
    value === "external_service"
  );
}

export function isCapabilityPackageKind(value: unknown): value is CapabilityPackageKind {
  return value === "cli" || value === "mcp" || value === "service";
}

export function isCapabilityRequestedAction(value: unknown): value is CapabilityRequestedAction {
  return (
    value === "install" ||
    value === "deploy" ||
    value === "connect" ||
    value === "upgrade" ||
    value === "parse"
  );
}

export function isCapabilityRequestStatus(value: unknown): value is CapabilityRequestStatus {
  return (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export function isCapabilityRequestPriority(value: unknown): value is CapabilityRequestPriority {
  return value === "normal" || value === "urgent";
}
