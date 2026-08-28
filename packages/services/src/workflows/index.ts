// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/workflows` 子路径与根 re-export 使用。

export {
  canonicalizeWorkflowGraph,
  canonicalizeJson,
  hashWorkflowGraph,
  validateWorkflowForPublishSync,
  validateWorkflowGovernance,
  validateWorkflowEmployeeReadiness,
  validateWorkflowNodeForDispatchSync,
  type ValidateWorkflowForPublishInput,
  type WorkflowActorRole,
  type WorkflowPublishBlocker,
  type WorkflowPublishValidation,
  type WorkflowRuntimeBindingInventory,
} from "./validation.ts";

export {
  buildNovelProductionWorkflowGraph,
  NOVEL_PRODUCTION_SKILL_IDS,
  type NovelProductionTemplateInput,
} from "./novel-production-template.ts";

export {
  publishWorkflowSync,
  type PublishWorkflowInput,
  type PublishWorkflowResult,
} from "./publishing.ts";

export {
  materializeWorkflowRunSync,
  materializeManualWorkflowRunSync,
  releaseWorkflowTriggerLeaseSync,
  rerunWorkflowRunSync,
  type MaterializeWorkflowRunInput,
  type MaterializeManualWorkflowRunInput,
  type RerunWorkflowRunInput,
} from "./materialization.ts";

export {
  isWorkflowMaterializationPrismaWriteEnabled,
  tickWorkflowSchedulerAuto,
  tickWorkflowSchedulerPrisma,
  tickWorkflowSchedulerSync,
  computeNextWorkflowFireAt,
  isOneTimeWorkflowTrigger,
  normalizeWorkflowTriggerForPublish,
  type WorkflowSchedulerTickResult,
} from "./scheduler.ts";

export {
  fireWorkflowEventSync,
  normalizeWorkflowEventInput,
  workflowTriggerMatchesEvent,
  type WorkflowEventInput,
  type WorkflowEventResult,
} from "./events.ts";

export {
  dispatchReadyWorkflowNodeSync,
  dispatchReadyWorkflowNodePrisma,
  resolveWorkflowMaxConcurrency,
  workflowNodeOutputSchema,
  type DispatchWorkflowNodeInput,
  type DispatchWorkflowNodeResult,
} from "./dispatcher.ts";

export {
  buildWorkflowNodeRuntimeContext,
  collectWorkflowArtifactRefs,
  mergeWorkflowArtifactManifests,
  resolveWorkflowNodeInput,
  validateWorkflowInputReferences,
  workflowNodeOutputFields,
} from "./inputs.ts";

export {
  completeWorkflowNodeSync,
  failWorkflowNodeSync,
  completeWorkflowApprovalNodeSync,
  expireWorkflowApprovalsSync,
  type CompleteWorkflowNodeInput,
  type WorkflowApprovalExpiryFailure,
} from "./coordinator.ts";

export {
  startQueuedTaskWithWorkflowSync,
  beginWorkflowTaskCommitSync,
  isWorkflowTaskInputAvailableSync,
  isWorkflowTaskStartBlocked,
  type StartQueuedTaskWithWorkflowResult,
  lockWorkflowRunForTaskIfLinkedSync,
  completeWorkflowTaskIfLinkedSync,
  prepareWorkflowTaskOutputSync,
  getWorkflowCompletionErrorCode,
  resolveWorkflowCompletionFailureCode,
  failWorkflowTaskIfLinkedSync,
} from "./completion.ts";

export {
  retryWorkflowNodeSync,
  pauseWorkflowRunSync,
  resumeWorkflowRunSync,
  cancelWorkflowRunSync,
  computeWorkflowRetryAvailableAt,
  type RetryWorkflowNodeInput,
  type ControlWorkflowRunInput,
} from "./retries.ts";

export {
  pauseWorkflowDefinitionSync,
  resumeWorkflowDefinitionSync,
  type ControlWorkflowDefinitionInput,
} from "./definition-control.ts";

export {
  createWorkflowApprovalSync,
  cancelPendingWorkflowApprovalsSync,
  continueWorkflowAfterApprovalSync,
  reviewWorkflowApprovalSync,
  reviewApprovalWithWorkflowSync,
  workflowApprovalInputFromNodeConfig,
  type CreateWorkflowApprovalInput,
} from "./approvals.ts";

export {
  recoverStaleWorkflowWorkSync,
  type WorkflowRecoveryResult,
} from "./recovery.ts";

export {
  dispatchWorkflowOutboxBatchSync,
  dispatchWorkflowOutboxBatchPrisma,
  dispatchWorkflowOutboxBatchAuto,
  type WorkflowOutboxDispatchResult,
} from "./outbox-dispatcher.ts";

export {
  flushWorkflowWorkerPrismaCutoverSloSync,
  observeWorkflowPrismaWrite,
  type WorkflowPrismaBatchSummary,
} from "./prisma-cutover-metrics.ts";

export {
  planLegacyMigration,
  applyLegacyMigrationSync,
  type LegacyMigrationAction,
  type LegacyMigrationInput,
  type LegacyMigrationPlan,
  type MigrationReport,
  projectLegacySchedulesForCutover,
  type CalendarWorkflowProjectionItem,
} from "./migration.ts";

export {
  resolveTriggerOwner,
  readWorkflowCutoverModeSync,
  assertTriggerWriteOwnerSync,
  shouldReadLegacyWorkflowSources,
  type WorkflowCutoverMode,
  type WorkflowTriggerOwner,
} from "./feature-flags.ts";

export {
  redactWorkflowDiagnostic,
  type WorkflowDiagnosticRedactionOptions,
} from "./security.ts";

export {
  buildWorkflowLogRecord,
  buildWorkflowMetricLabels,
  WORKFLOW_METRICS,
  type WorkflowLogInput,
  type WorkflowMetricLabelInput,
} from "./observability.ts";
