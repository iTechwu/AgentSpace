// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/runtime` 子路径与根 re-export 使用。

export {
  defaultDependencies as defaultRuntimeMaintenanceDependencies,
  runRuntimeMaintenanceAsync,
  type RuntimeMaintenanceDependencies,
  type RuntimeMaintenanceResult,
  type RuntimeMaintenanceStageResult,
} from "../runtime-maintenance/runtime-maintenance.ts";

export {
  sendExternalPagerAlert,
  readExternalPagerConfigFromEnv,
  type ExternalPagerConfig,
  type PagerAlertPayload,
} from "../observability/external-pager.ts";

export {
  assertCanManageEmployeeForActorSync,
  assertCanManageRuntimeGrantsSync,
  assertCanUseBoundEmployeeRuntimeInChannelForActorSync,
  assertCanUseBoundEmployeeRuntimeForActorSync,
  assertCanUseEmployeeInChannelForActorSync,
  assertCanUseEmployeeForActorSync,
  assertCanUseEmployeeRuntimeInChannelForActorSync,
  assertCanUseEmployeeRuntimeForActorSync,
  assertCanUseRuntimeForActorSync,
  canUseEmployeeInChannelForActorSync,
  canManageEmployeeForActorSync,
  canManageRuntimeGrantsSync,
  canUseEmployeeForActorSync,
  canUseEmployeeRuntimeInChannelForActorSync,
  canUseEmployeeRuntimeForActorSync,
  canUseRuntimeForActorSync,
  grantRuntimeUseToUserForActorSync,
  isWorkspaceAdminOrOwnerSync,
  listRuntimeGrantsForActorSync,
  revokeRuntimeUseFromUserForActorSync,
  type RuntimeAccessActor,
} from "../runtime-access/runtime-access.ts";

export {
  normalizeRuntimeProviderHealth,
  type NormalizeRuntimeProviderHealthInput,
} from "../runtime-health/runtime-health.ts";

export {
  resolveDofeAgentRuntimeConfig,
  resolveAttachmentRuntimeConfig,
  type DofeAgentRuntimeConfig,
  type AttachmentRuntimeConfig,
} from "../config/deployment.ts";

export {
  resolveAgentRuntimeMode,
  type AgentRuntimeMode,
} from "../config/deployment.ts";

export {
  cancelRuntimeProvisioningTaskAsync,
  completeManagedRuntimeCleanupSync,
  deleteManagedRuntimeAsync,
  ensureManagedRuntimeCapacitySync,
  ensureManagedRuntimeModelAllowedAsync,
  failManagedRuntimeCleanupSync,
  finalizeManagedRuntimeProvisioningSync,
  getManagedRuntimeCredentialStatusAsync,
  handleManagedRuntimeProviderFailureAsync,
  getRuntimeProvisioningTaskDetailSync,
  listManagedRuntimeTasksSync,
  listManagedRuntimesForWorkspaceSync,
  listManagedExecutionNodesSync,
  preflightManagedRuntimeCreationAsync,
  requestManagedRuntimeProvisioningSync,
  resumePendingRuntimeCredentialRecoveriesAsync,
  resolveManagedRuntimeScopeSync,
  resumeManagedRuntimeCleanupRequestsAsync,
  resumePendingProvisioningTasksAsync,
  retryRuntimeProvisioningTaskSync,
  rotateManagedRuntimeCredentialAsync,
  runProvisioningPipeline,
  setManagedRuntimeDefaultModelAsync,
  stopManagedRuntimeAsync,
  type GetManagedRuntimeCredentialStatusInput,
  type HandleManagedRuntimeProviderFailureInput,
  type EnsureManagedRuntimeCapacityInput,
  type EnsureManagedRuntimeModelAllowedInput,
  type ManagedExecutionNode,
  type ManagedRuntimeCapacityResult,
  type ManagedRuntimeProviderFailureResult,
  type ManagedRuntimeListItem,
  type ManagedRuntimeCreationPreflightResult,
  type ManagedRuntimeActor,
  type PublicManagedRuntimeRecord,
  type PublicRuntimeProvisioningTaskRecord,
  type RequestManagedRuntimeInput,
  type RotateManagedRuntimeCredentialInput,
  type SetManagedRuntimeDefaultModelInput,
  type RuntimeProvisioningTaskDetail,
  type StopManagedRuntimeInput,
} from "../runtime-provisioning/runtime-provisioning.ts";

export {
  completeManagedProvisioningStageSync,
  failManagedProvisioningStageSync,
  readRuntimeProvisioningTaskSync,
  requestManagedRuntimeCleanupSync,
} from "@dofe-agent/db";

export {
  createRuntimeCredentialVaultFromEnvironment,
  buildRuntimeCredentialSecretRef,
  EncryptedFileRuntimeCredentialVault,
  getRuntimeCredentialVault,
  resetRuntimeCredentialVaultForTests,
  setRuntimeCredentialVault,
  type RuntimeCredentialScope,
  type RuntimeCredentialVault,
} from "../runtime-provisioning/credential-vault.ts";

export {
  buildManagedCleanupCommands,
  buildManagedCredentialBundleDocument,
  buildManagedProvisioningCommandContext,
  buildManagedProvisioningStageCommands,
  getManagedRuntimeCredentialEnvKey,
  getManagedRuntimeCredentialEnvKeys,
  type ManagedCredentialBundleDocument,
  type ManagedProvisioningCommand,
  type ManagedProvisioningCommandContext,
  type ManagedRuntimeProviderTemplate,
} from "../runtime-provisioning/provider-templates.ts";
