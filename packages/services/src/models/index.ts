// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/models` 子路径与根 re-export 使用。

export {
  buildModelsInternalAuthorization,
  getModelsInternalClient,
  getModelsTenantBillingReportAsync,
  isModelsInternalConfigured,
  resetModelsInternalClientForTests,
  resolveModelsInternalConfig,
  type ModelsInternalConfig,
  type ModelsBillingAggregate,
  type ModelsBillingDimensionAggregate,
  type ModelsBillingLifecycleStatus,
  type ModelsTenantBillingReport,
  type ModelsTenantBillingReportInput,
} from "./client.ts";

export { isExecutionLanguageModel } from "./execution-models.ts";

export {
  resolveEffectiveModelForBoundEmployeeAsync,
  resolveEffectiveModelForTaskAsync,
  type EffectiveModelResolution,
  type ResolveEffectiveModelInput,
} from "./model-resolution.ts";

export {
  syncRuntimeCredentialUsageAsync,
  reconcileAllManagedRuntimeUsageAsync,
  type ReconcileAllManagedRuntimeUsageResult,
  type SyncRuntimeCredentialUsageInput,
  type SyncRuntimeCredentialUsageResult,
} from "./usage-sync.ts";

export {
  drainTokenUsageRetriesSync,
  type DrainTokenUsageRetriesResult,
} from "./usage-retry.ts";
