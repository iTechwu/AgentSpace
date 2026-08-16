// Runtime App 目录 / 安装 / 操作（3.2-4 自 types.ts 按域拆分；types.ts 保留为 re-export barrel）。


export type RuntimeAppCatalogSource = "clihub_harness" | "clihub_public" | "skill_dependency" | "workspace_private";
export type RuntimeAppInstallStrategy = "cli_hub" | "pip" | "npm" | "uv" | "system" | "bundled" | "manual";
export type RuntimeInstalledAppStatus = "installed" | "installing" | "failed" | "disabled" | "missing";
export type RuntimeAppOperationType = "install" | "update" | "uninstall" | "verify" | "disable" | "enable";
export type RuntimeAppOperationStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeAppOperationStage = "queued" | "installing" | "verifying" | "finalizing" | "completed";
export type RuntimeAppRiskLevel = "low" | "medium" | "high";
export type RuntimeAppArtifactKind = "npm" | "pypi";

export interface WorkspaceRuntimeAppPackageRecord {
  id: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  description: string;
  category: string;
  homepage?: string;
  createdByUserId?: string;
  createdAt: string;
}

export interface WorkspaceRuntimeAppReleaseRecord {
  id: string;
  workspaceId: string;
  packageId: string;
  packageSlug: string;
  displayName: string;
  description: string;
  category: string;
  homepage?: string;
  version: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  artifactUrl: string;
  artifactIntegrity: string;
  entryPoint: string;
  manifestJson: string;
  risk: RuntimeAppRiskLevel;
  createdByUserId?: string;
  createdAt: string;
  yankedAt?: string;
}

export interface RuntimeAppCatalogItemRecord {
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  entryPoint: string;
  installStrategy: RuntimeAppInstallStrategy | "";
  installCmd?: string;
  uninstallCmd?: string;
  updateCmd?: string;
  skillMd?: string;
  requiresText?: string;
  homepage?: string;
  registryJson: string;
  syncedAt: string;
}

export interface RuntimeInstalledAppRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  version: string;
  entryPoint: string;
  status: RuntimeInstalledAppStatus;
  installStrategy: RuntimeAppInstallStrategy | "";
  enabled: boolean;
  installedByUserId?: string;
  installedAt?: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastError?: string;
  metadataJson: string;
}

export interface RuntimeAppOperationRecord {
  id: string;
  workspaceId: string;
  runtimeId: string;
  appSource: RuntimeAppCatalogSource;
  appName: string;
  operation: RuntimeAppOperationType;
  status: RuntimeAppOperationStatus;
  stage: RuntimeAppOperationStage;
  failedStage?: RuntimeAppOperationStage;
  stageUpdatedAt: string;
  requestedByUserId?: string;
  commandPlanJson: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RuntimeAppSkillBindingRecord {
  workspaceId: string;
  runtimeAppId: string;
  skillId: string;
  source: RuntimeAppCatalogSource;
  name: string;
  createdAt: string;
}
