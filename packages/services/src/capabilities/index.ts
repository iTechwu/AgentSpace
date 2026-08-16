// 域 barrel：从 src/index.ts 拆出（3.7-7），供 `@dofe-agent/services/capabilities` 子路径与根 re-export 使用。

export {
  approveCapabilityRequestSync,
  cancelCapabilityRequestSync,
  completeCapabilityRequestMcpConnectionSync,
  isCapabilityProjectionEnabled,
  isCapabilityRequestEnabled,
  isManagedServiceProvisioningEnabled,
  isRuntimeBaselineRolloutEnabled,
  listActiveCapabilityRequestsForRuntime,
  projectCliCapabilityAvailability,
  projectMcpCapabilityAvailability,
  rejectCapabilityRequestSync,
  submitCapabilityRequestSync,
  switchCapabilityImplementationSync,
  type CapabilityAvailabilityProjection,
  type CapabilityCatalogState,
  type CapabilityImplementation,
  type CapabilityInfrastructureState,
  type CapabilityNextAction,
  type CapabilityUserState,
  type CompleteCapabilityRequestMcpConnectionInput,
  type CompleteCapabilityRequestMcpConnectionResult,
  type SubmitCapabilityRequestInput,
  type SubmitCapabilityRequestResult,
} from "./capability-availability.ts";

export {
  convergeCapabilityRequestFromSkillServiceOperationSync,
  queueCapabilityManagedServiceProvisionSync,
  type QueueCapabilityManagedServiceProvisionResult,
} from "./capability-service-driver.ts";

export {
  buildRuntimeBaselineInstallPlan,
  chainCapabilityMcpDependencySync,
  chainCapabilityRuntimeBaselineSync,
} from "./capability-dispatchers.ts";
