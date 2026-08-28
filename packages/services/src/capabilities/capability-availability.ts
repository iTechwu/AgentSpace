/**
 * Capability availability facade (docs/0811/cli-install).
 *
 * The capability stack was split (P2) so each concern lives in its own module
 * while keeping this file as the single public import surface for
 * index.ts / the API layer:
 *   - capability-projection.ts    → the 9-state nextAction projection
 *   - capability-workflow.ts      → submit / approve / reject / owner-complete
 *   - capability-dispatchers.ts   → dispatch approved requests into subsystems
 *   - capability-config.ts        → feature flags (Phase 7 rollback switches)
 */

export {
  projectCliCapabilityAvailability,
  projectMcpCapabilityAvailability,
  type CapabilityAvailabilityProjection,
  type CapabilityCatalogState,
  type CapabilityImplementation,
  type CapabilityInfrastructureState,
  type CapabilityNextAction,
  type CapabilityUserState,
} from "./capability-projection.ts";

export {
  approveCapabilityRequestSync,
  cancelCapabilityRequestSync,
  completeCapabilityRequestMcpConnectionSync,
  listActiveCapabilityRequestsForRuntime,
  rejectCapabilityRequestSync,
  submitCapabilityRequestSync,
  switchCapabilityImplementationSync,
  type CompleteCapabilityRequestMcpConnectionInput,
  type CompleteCapabilityRequestMcpConnectionResult,
  type SubmitCapabilityRequestInput,
  type SubmitCapabilityRequestResult,
} from "./capability-workflow.ts";

export {
  isCapabilityProjectionEnabled,
  isCapabilityRequestEnabled,
  isManagedServiceProvisioningEnabled,
  isRuntimeBaselineRolloutEnabled,
} from "./capability-config.ts";

// Lower-level catalog / connection helpers re-exported for API routes that
// want a single import surface for capability work.
export {
  listMcpCatalogItemsForWorkspaceSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  resolveMcpRuntimeAppRequirement,
  selectCliHubReadiness,
} from "./capability-workflow.ts";
