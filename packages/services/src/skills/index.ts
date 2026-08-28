// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/skills` 子路径与根 re-export 使用。

export {
  hasSkillDependenciesSync,
  hasGitHubSkillDependenciesSync,
  queueSkillDependenciesForAgentSync,
  queueGitHubSkillDependenciesForAgentSync,
  readSkillDependencyInstallStatusSync,
  resolveDependencyIntegrityLock,
  type SkillDependencyInstallStatus,
} from "./dependency-install.ts";

export { parseSkillDependencyDeclaration, parseSkillSkillDependencies } from "./dependencies.ts";

export type { SkillDependencyDeclaration } from "./dependencies.ts";

export {
  resolveSystemDependencySync,
  listSystemDependencyCatalogSync,
  type SystemDependencyResolution,
} from "./system-dependency-catalog.ts";

export {
  saveSkillDraftSync,
  saveSkillDraftAsync,
  readSkillDraftSync,
  hasSkillDraftSync,
  publishSkillDraftSync,
  publishSkillDraftAsync,
  discardSkillDraftSync,
  discardSkillDraftAsync,
  type SkillDraftView,
} from "./drafts.ts";

export {
  setWorkspaceGitCredentialSync,
  listWorkspaceGitCredentialsSync,
  resolveWorkspaceGitCredentialSecretSync,
  revokeWorkspaceGitCredentialSync,
  isGitCredentialConfiguredSync,
  gitAuthHeadersSync,
  type GitCredentialSafeView,
  type GitCredentialType,
} from "./git-credentials.ts";

export {
  buildSkillRequirementRuntimeContext,
  getSkillRequirementBlockers,
  normalizeSkillRequirementConfiguration,
  parseSkillRequirementDeclarations,
  readInvalidSkillRequirementDeclarations,
  readSkillRequirementConfiguration,
  readSkillRequirementDeclarations,
  serializeSkillRequirementConfiguration,
} from "./requirements.ts";

export type {
  SkillRequirementConfiguration,
  SkillRequirementDeclaration,
  SkillRequirementKind,
} from "./requirements.ts";

export {
  assertAgentSkillRequirementsReadySync,
  deleteAgentSkillRequirementKeySync,
  readAgentSkillRequirementConfigurationSync,
  readAgentSkillRequirementEnvSync,
  readAgentSkillRequirementSummarySync,
  requestSkillRequirementConfigurationSync,
  resolveSkillProjectWorkDirSync,
  rotateAgentSkillRequirementSecretSync,
  setAgentSkillAssignmentsWithRequirementsValidationSync,
  upsertAgentSkillRequirementsSync,
} from "./agent-skill-requirements.ts";

export type { AgentSkillRequirementSummary, AgentSkillRequirementStatusCode } from "./agent-skill-requirements.ts";

export {
  CLIHUB_HARNESS_REGISTRY_URL,
  CLIHUB_PUBLIC_REGISTRY_FALLBACK_URL,
  CLIHUB_PUBLIC_REGISTRY_URL,
  listCliHubCatalogItems,
  normalizeCliHubRegistryPayload,
  readCliHubCatalogHealth,
  readCliHubCatalogItem,
  syncCliHubCatalog,
  type CliHubCatalogSyncResult,
} from "../clihub/catalog.ts";

export {
  assessRuntimeAppInstallability,
  assessRuntimeAppRisk,
  buildRuntimeAppInstallPlan,
  type RuntimeAppInstallability,
  type RuntimeAppInstallabilityStatus,
  type RuntimeAppRequiredTool,
} from "../clihub/install-plan.ts";

export {
  assertCanManageRuntimeAppsSync,
  listRuntimeAppContextEntriesForRuntimeSync,
  listRuntimeAppOperationsForRuntimeSync,
  listRuntimeAppsForRuntimeSync,
  normalizeCliHubReadiness,
  readCliHubReadinessForRuntimeSync,
  readCliHubReadinessFromRuntimeMetadata,
  readRuntimeAppAvailabilityForSkillSync,
  requestRuntimeAppOperationSync,
  type CliHubReadinessView,
  type RuntimeAppOperationRequestResult,
} from "../clihub/runtime-apps.ts";

export {
  syncRuntimeAppSkill,
  type RuntimeAppSkillSyncResult,
} from "../clihub/skill-sync.ts";

export {
  createWorkspaceRuntimeAppRelease,
  listWorkspaceRuntimeAppCatalogItemsSync,
  projectPrivateCliRelease,
  readWorkspaceRuntimeAppCatalogItemSync,
  resolveRuntimeAppArtifactMetadata,
  type CreateWorkspaceRuntimeAppReleaseInput,
  type WorkspaceRuntimeAppReleaseResult,
} from "../clihub/private-releases.ts";

export {
  BUILTIN_RETURN_OUTPUT_FILES_SKILL_NAME,
  BUILTIN_WORKSPACE_CONTEXT_SKILL_NAME,
  BUILTIN_UPDATE_CHANNEL_DOCUMENTS_SKILL_NAME,
  listWorkspaceSkillsSync,
  reconcileWorkspaceSkillStorageSync,
  type WorkspaceSkillStorageReconciliation,
  readWorkspaceSkillSync,
  createWorkspaceSkillSync,
  updateWorkspaceSkillSync,
  deleteWorkspaceSkillSync,
  upsertWorkspaceSkillFileSync,
  deleteWorkspaceSkillFileSync,
  isBuiltinSkill,
  isSystemSkillName,
} from "./skills.ts";

export {
  materializeWorkspaceSkillsForProvider,
  type MaterializedSkillDirectories,
} from "./injection.ts";

export {
  exportWorkspaceSkillsArchiveSync,
  type ExportedSkillsArchive,
  type SkillExportManifestEntry,
} from "./export.ts";

export {
  importWorkspaceSkillFromZipUpload,
  importWorkspaceSkillFromUrl,
  inspectWorkspaceSkillSourceUpdate,
  checkSkillSourceUpdatesForWorkspaceSync,
  SkillGitHubImportError,
  type SkillGitHubImportErrorCode,
  type SkillImportConflict,
  type SkillImportResult,
  type SkillSourceUpdateCheckSummary,
  type SkillSourceUpdateInspection,
  type SkillSourceUpdateStatus,
} from "./import.ts";

export {
  buildAndPersistSkillArtifactSync,
  buildLegacyArtifactFromSkillSync,
  verifySkillArtifactIntegritySync,
  materializeSkillArtifactFilesSync,
  computeArtifactDigest,
  mediaTypeForPath,
  isTextMediaType,
  type SkillArtifactManifest,
  type SkillArtifactManifestFile,
  type ArtifactFileInput,
  type BuildArtifactResult,
  type ArtifactIntegrityResult,
} from "./skill-artifacts.ts";

export {
  migrateLegacySkillArtifactsSync,
  migrateAllWorkspaceLegacySkillsSync,
  type LegacySkillMigrationFailure,
  type LegacySkillMigrationResult,
} from "./legacy-migration.ts";

export { recordSkillLifecycleAuditSync } from "./audit.ts";

export {
  buildSkillInstallationComponentsSync,
  createSkillInstallationPlanSync,
  resolveClaimedSkillInstallationOperation,
  completeSkillInstallationOperationSync,
  failSkillInstallationOperationSync,
  evaluateSkillInstallationReadinessSync,
  reconcileSkillInstallationsForRuntimeSync,
  buildSkillRunnerEntrypointsForSnapshotSync,
  assertSkillInstallationReadyForTaskSync,
  readHighestRevisionSkillInstallationSync,
  resolveTaskSkillExecutionSnapshotSync,
  resolveOrLoadTaskSkillExecutionSnapshotSync,
  type SkillInstallationOperationCompletionResult,
} from "./installations.ts";

export {
  buildSkillOperationRequestSnapshotJson,
  parseCompleteSkillInstallationOperationPayload,
  parseFailSkillInstallationOperationPayload,
} from "./installations-protocol.ts";

export {
  SKILL_INSTALL_POLICY_VERSION,
  buildSkillInstallRiskItemsSync,
  computeSkillInstallRiskDecisionDigestSync,
  approveSkillInstallSync,
} from "./install-approval.ts";

export {
  SKILL_ROLLOUT_POLICY_VERSION,
  planSkillRollout,
  resolveSkillDependencyClosureSync,
  resolveSkillDependencyClosureDetailedSync,
  lockSkillDependencyDigestSync,
  computeSkillRolloutTargetRuntimesSync,
  resolveSkillRolloutRootRuntimeIdsSync,
  deriveSkillRolloutRuntimeRequirementsSync,
  isRuntimeCompatibleWithRequirements,
  computeSkillRolloutItemsSync,
  aggregateSkillRolloutRiskSync,
  computeSkillRolloutPlanDigestSync,
  recomputeSkillRolloutPlanDigestSync,
  finalizeSkillRolloutPlanSync,
  versionSatisfies,
  type SkillRolloutTargetScope,
  type SkillRolloutPlan,
  type SkillRolloutPersistedPlan,
  type SkillRolloutClosureEntry,
  type SkillRolloutSkippedDependency,
  type SkillRolloutItem,
  type SkillRolloutRiskSummary,
  type SkillRolloutRuntimeRequirements,
  type RuntimeCapabilitySnapshot,
} from "./rollout.ts";

export {
  installSkillRolloutSync,
  reconcileSkillRolloutPlanSync,
  SkillRolloutDispatchError,
  type SkillRolloutDispatchResult,
  type SkillRolloutReconcileResult,
} from "./rollout-dispatch.ts";

export {
  attributeShotFailure,
  attributeBatchFailures,
  type ShotFailure,
  type AssetGap,
  type BatchFailureAttribution,
  type ShotGenerationFailureKind,
  type VideoModelAdapter,
  type ShotGenerationBatch,
} from "./shot-generation.ts";

export {
  NOVEL_PRODUCTION_COORDINATES,
  NOVEL_PRODUCTION_ENTRY_SKILL_MD,
} from "./novel-production-entry.ts";

export {
  resolveSkillMcpCapabilitySync,
  resolveSkillCliCapabilitySync,
  evaluateSkillInstallationCapabilitiesSync,
  type SkillCapabilityResolution,
} from "./capabilities.ts";

export {
  assertSkillServiceCatalogAdmissionSync,
  createSkillServiceCatalogEntrySync,
  type SkillServiceCatalogAdmissionInput,
} from "../skill-services/catalog.ts";

export {
  queueManagedSkillServiceForInstallationSync,
  queueManagedSkillServiceRetireSync,
  upgradeManagedSkillServiceSync,
  completeManagedSkillServiceProvisionOperationSync,
  completeManagedSkillServiceRetireOperationSync,
  resolveClaimedManagedSkillServiceOperation,
  retireUnreferencedManagedSkillServicesSync,
} from "../skill-services/bindings.ts";

export {
  setWorkspaceServiceSecretSync,
  resolveWorkspaceServiceSecretsSync,
  deleteWorkspaceServiceSecretSync,
} from "../skill-services/secrets.ts";

export {
  uninstallSkillInstallationSync,
  uninstallSkillFromRuntimeSync,
} from "./uninstall.ts";

export {
  computeSkillReleaseLockSync,
  diffSkillArtifactsSync,
  isSkillUpgradeApprovalRequiredSync,
  createSkillUpgradePlanSync,
  promoteSkillUpgradeSync,
  rollbackSkillInstallationSync,
  readSkillInstallationLockSync,
  verifySkillInstallationLockReconstructableSync,
  approveSkillUpgradeSync,
  computeSkillUpgradeDiffHashSync,
  listSkillUpgradeReviewCandidatesSync,
  approveSkillUpgradeCandidateSync,
  type ResolvedSkillReleaseLock,
  type SkillRollbackPreflightIssue,
  type SkillReleaseDiff,
  type SkillDiffCategory,
  type SkillUpgradeReviewCandidate,
} from "./release.ts";

export { selectCliHubReadiness } from "../clihub/runtime-apps.ts";
