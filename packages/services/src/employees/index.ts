// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/employees` 子路径与根 re-export 使用。

export {
  listActiveEmployeesSync,
  listEmployeeSkillIdsMap,
  listEmployeeSkillIdsMapSync,
  listEmployeeSkillIdsSync,
  listEmployeeRuntimeBindingsForWorkspaceSync,
  listEmployeeRuntimeBindingsForWorkspaceAsync,
  assertRuntimeCanBindEmployeeSync,
  bindEmployeeRuntimeSync,
  unbindEmployeeRuntimeSync,
  deleteEmployeeSync,
  updateEmployeeDefaultModelSync,
  updateEmployeeExecutionPolicySync,
  updateEmployeeInstructionsSync,
  updateEmployeeRemarkNameSync,
  setEmployeeChannelMemberAccessSync,
  createEmployeeSync,
  buildLegacyAgentIdForEmployeeName,
  setEmployeeSkillIdsSync,
  listEmployeeSkillIdsByAgentIdMapSync,
  listEmployeeSkillIdsByAgentIdMap,
} from "./employees.ts";

export {
  promoteTaskOutputsToWorkspaceSync,
  promoteArtifactSync,
  reclaimOrphanContentBlobsSync,
  readEmployeeDataProtectionSnapshotSync,
  restoreValidatedWorkspaceRevisionSync,
  computeRevisionManifestDigest,
  softDeleteEmployeeArtifactSync,
  type TaskOutputFile,
  type PromoteTaskOutputsResult,
  type WorkspaceRevisionManifest,
  type WorkspaceRevisionFileEntry,
  type OrphanBlobScanResult,
  type EmployeeDataProtectionSnapshot,
} from "./persistent-workspace.ts";

export {
  createEmployeeRecoveryOperationSync,
  runRecoveryStepSync,
  runFullRecoverySync,
  assertBindingGenerationCurrentSync,
  RECOVERY_PHASE_ORDER,
  type RunRecoveryInput,
  type RecoveryStepResult,
} from "./recovery.ts";

export {
  evaluateDataProtectionHealthSync,
  runBackupRestoreDrillSync,
  runBackupRestoreDrillRunSync,
  DATA_PROTECTION_ALERT_CODES,
  type DataProtectionHealthResult,
  type DataProtectionAlert,
  type DataProtectionAlertSeverity,
  type BackupRestoreDrillResult,
  type DataProtectionHealthOptions,
} from "./data-protection-health.ts";

export { exportLegalHoldProofSync } from "./legal-holds.ts";

export {
  advanceRecoverableOperationsSync,
  type AdvanceRecoveriesResult,
} from "./recovery-worker.ts";

export {
  reconcileStaleCommitJournalsSync,
  type CommitReconciliationDerivedOutputs,
  type CommitReconciliationOutputDeriver,
  type ReconcileCommitJournalsOptions,
  type ReconcileCommitJournalsResult,
} from "./commit-reconciliation.ts";

export {
  runEmployeeLifecycleMaintenanceSync,
  readRetentionPolicy,
  type LifecycleMaintenanceOptions,
  type LifecycleMaintenanceResult,
  type EmployeeDataRetentionPolicy,
} from "./lifecycle-maintenance.ts";
