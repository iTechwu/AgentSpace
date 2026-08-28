/**
 * Capability feature flags (docs/0811/cli-install Phase 7 rollback switches).
 *
 * Split out of capability-availability.ts (P2: module split) so workflow and
 * dispatch modules can gate behavior without importing the projection.
 */

/**
 * Feature flag: when disabled, all capability-request entry points return
 * "temporarily unavailable" without persisting or dispatching. The page
 * keeps its UI but every action becomes a no-op. Fail-closed: missing env
 * var defaults to the legacy CLI/MCP path being still available, so a
 * freshly deployed instance does not surprise users.
 */
export function isCapabilityRequestEnabled(): boolean {
  const flag = process.env.CAPABILITY_REQUESTS_ENABLED;
  return flag !== "0";
}

/**
 * Feature flag for the new server-side projection endpoint. When disabled,
 * the loader falls back to the legacy client-side `installability` flag
 * (see `projectRuntimeAppInstallability` in market-page-client). The page
 * keeps rendering — only the unified `nextAction` source of truth is
 * removed.
 */
export function isCapabilityProjectionEnabled(): boolean {
  const flag = process.env.CAPABILITY_AVAILABILITY_PROJECTION_V2;
  return flag !== "0";
}

/**
 * Feature flag for the managed-service container lifecycle (docs Phase 5/§8).
 * Fail-closed: defaults to disabled. While off, approved managed_service /
 * external_service capability requests are recorded and queued but not
 * provisioned — the dispatch seam leaves them in their approved state with an
 * audit trail. Flipping this on only unblocks dispatch.
 */
export function isManagedServiceProvisioningEnabled(): boolean {
  return process.env.MANAGED_SERVICE_PROVISIONING_ENABLED === "1";
}

/**
 * Feature flag for the Runtime baseline rollout (docs Phase 7). Fail-closed:
 * defaults to disabled. Controls whether missing base tools (npm/pip/uv) are
 * auto-rolled-out to a runtime as part of capability installation, rather than
 * surfacing a manual "repair" nextAction. While off, the projection keeps
 * pointing users at the governed repair path.
 */
export function isRuntimeBaselineRolloutEnabled(): boolean {
  return process.env.RUNTIME_BASELINE_ROLLOUT_ENABLED === "1";
}
