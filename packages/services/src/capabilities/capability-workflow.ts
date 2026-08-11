import type {
  CapabilityDeploymentMode,
  CapabilityPackageKind,
  CapabilityRequestedAction,
  CapabilityRequestRecord,
} from "@dofe-agent/db";
import {
  cancelCapabilityRequestSync as dbCancelCapabilityRequestSync,
  createCapabilityRequestSync,
  decideCapabilityRequestSync,
  getDatabase,
  listCapabilityRequestsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listRuntimeAppOperationsSync,
  listRuntimeInstalledAppsSync,
  listSkillServiceCatalogSync,
  readAgentRuntimeSync,
  readCapabilityRequestSync,
  readMcpCatalogItemBySlugSync,
  readMcpCatalogItemSync,
  readWorkspaceRuntimeAppReleaseByVersionSync,
} from "@dofe-agent/db";
import { materializeMcpConnectionSync } from "../mcp-center/connections.ts";
import { buildRuntimeAppInstallPlan } from "../clihub/install-plan.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { createNotificationSync, notifyWorkspaceAdminsSync } from "../notifications/notifications.ts";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { listMcpCatalogItemsForWorkspaceSync } from "../mcp-center/catalog.ts";
import { resolveMcpRuntimeAppRequirement } from "../mcp-center/official-catalog.ts";
import { selectCliHubReadiness } from "../clihub/runtime-apps.ts";
import { isCapabilityRequestEnabled } from "./capability-config.ts";
import { classifyCliDeploymentMode, type CapabilityNextAction } from "./capability-projection.ts";
import {
  dispatchApprovedCapabilityRequestSync,
  findCliCatalogItem,
  resolveMcpCatalogItemIdFromRequest,
} from "./capability-dispatchers.ts";

/**
 * Capability request workflow (docs/0811/cli-install §3.4, Phase 4/6).
 *
 * User-facing submit / admin approve / reject / owner-complete of the unified
 * install/deploy/connect task envelope. Dispatch of an approved request lives
 * in capability-dispatchers.ts; the projection in capability-projection.ts.
 * Split out of capability-availability.ts (P2).
 */

/**
 * Server-side deployment-plan boundary (P1-7). The browser only submits
 * identifiers; the server must reject a (packageKind, deploymentMode,
 * requestedAction) triple that the catalog model could never produce. This
 * stops a crafted request from pinning, say, a CLI install to a managed
 * service lifecycle or an MCP connect to a runtime package install.
 */
function assertCapabilityDeploymentPlan(
  packageKind: CapabilityPackageKind,
  deploymentMode: CapabilityDeploymentMode,
  requestedAction: "install" | "deploy" | "connect" | "upgrade",
): void {
  const allowedDeploymentModes: Record<CapabilityPackageKind, CapabilityDeploymentMode[]> = {
    cli: ["runtime_builtin", "runtime_package"],
    mcp: ["managed_service", "external_service"],
    // A `service` is a heavyweight container deployed on the managed node; there
    // is no external-connection lifecycle for it, so external_service is not an
    // allowed combination (docs/0811/cli-install §4.3).
    service: ["managed_service"],
  };
  const allowedActions: Record<CapabilityPackageKind, string[]> = {
    cli: ["install", "upgrade"],
    mcp: ["connect", "deploy", "upgrade"],
    service: ["deploy", "upgrade"],
  };
  if (!allowedDeploymentModes[packageKind].includes(deploymentMode)) {
    throw new Error(`capability_request.deployment_mode_mismatch:${packageKind}:${deploymentMode}`);
  }
  if (!allowedActions[packageKind].includes(requestedAction)) {
    throw new Error(`capability_request.requested_action_mismatch:${packageKind}:${requestedAction}`);
  }
}

export interface SubmitCapabilityRequestInput {
  workspaceId: string;
  runtimeId: string;
  actorUserId: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  deploymentMode: CapabilityDeploymentMode;
  requestedAction: "install" | "deploy" | "connect" | "upgrade";
  priority?: "normal" | "urgent";
  message?: string;
}

export interface SubmitCapabilityRequestResult {
  capabilityRequest: CapabilityRequestRecord;
  dispatchedOperationId?: string;
  nextAction: CapabilityNextAction;
}

export function submitCapabilityRequestSync(
  input: SubmitCapabilityRequestInput,
): SubmitCapabilityRequestResult {
  const workspaceId = input.workspaceId;
  if (!isCapabilityRequestEnabled()) {
    throw new Error("Capability request channel is disabled (CAPABILITY_REQUESTS_ENABLED=0).");
  }
  // P1-7: never trust the browser's deployment decision. The server re-derives
  // the deployment mode from the actual catalog entry (transport / install
  // strategy / release), so a browser cannot claim `runtime_package` for an MCP
  // service or `external_service` for a CLI tool. The generic kind matrix is a
  // first line of defense; the catalog re-derivation is authoritative.
  const catalogPlan = resolveCapabilityDeploymentPlan(input, workspaceId);
  // P1: a catalog entry that cannot be resolved (yanked / removed / wrong
  // source) must REJECT the submission — never fall back to the browser's
  // declared deployment mode, or we would persist a request for an arbitrary
  // slug/source the server cannot back with a real release.
  if (!catalogPlan) {
    throw new Error("capability_request.catalog_not_found");
  }
  const deploymentMode = catalogPlan.deploymentMode;
  // P1: the catalog entry is the authoritative source — a same-slug multi-source
  // catalog must not let the client pick the source.
  const packageSource = catalogPlan.packageSource ?? input.packageSource;
  assertCapabilityDeploymentPlan(input.packageKind, deploymentMode, input.requestedAction);
  // P1-7: the runtime must belong to the target workspace. Without this a
  // member could submit a request pinned to another workspace's runtime id.
  const runtime = readAgentRuntimeSync(input.runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: input.actorUserId });
  // For MCP/service requests we pin the exact catalog item / template id in
  // metadata so dispatch cannot silently drift to a newer same-slug release
  // (docs/0811/cli-install P1-3, S2).
  const metadataJson = buildCapabilityRequestMetadataJson(input.packageKind, input.packageSlug, workspaceId, catalogPlan);
  // CAS idempotency: createCapabilityRequestSync atomically inserts a new row,
  // reopens a terminal request, or returns an in-flight request unchanged. Only
  // the created/reopened cases record an audit event and notify admins, so a
  // concurrent double-submit writes exactly one audit row. The DB CAS is the
  // single source of truth — the previous read-before-create guard is gone.
  const { record: request, outcome } = createCapabilityRequestSync({
    workspaceId,
    requestedByUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    packageKind: input.packageKind,
    packageSource,
    packageSlug: input.packageSlug,
    packageDisplayName: catalogPlan.displayName ?? input.packageDisplayName,
    deploymentMode,
    requestedAction: input.requestedAction,
    priority: input.priority ?? "normal",
    message: input.message ?? "",
    // Pin workspace-private CLI installs to the exact release id so the
    // approved install plan cannot drift to a yanked release.
    releaseId: resolveCliReleaseId(input.workspaceId, packageSource, input.packageSlug),
    metadataJson,
  });
  if (outcome === "in_flight") {
    return {
      capabilityRequest: request,
      nextAction: request.status === "running" ? "wait_for_operation" : "wait_for_approval",
    };
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Capability request submitted",
    note: `${request.packageDisplayName} (${deploymentMode}/${input.requestedAction}) requested.`,
    code: "capability_request.submitted",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "capability_request",
      resourceId: request.id,
      deploymentMode,
      requestedAction: input.requestedAction,
    },
  });
  // Notify admins whenever a non-admin submits a request — every non-admin
  // request needs an admin decision (approval or dispatch), including a
  // runtime_package install, which only auto-approves when an admin submits it.
  // Admins who submit their own requests already have access to the same panel.
  if (!isAdmin) {
    notifyWorkspaceAdminsSync({
      workspaceId,
      title: `能力申请待批准：${request.packageDisplayName}`,
      body: `${request.packageDisplayName} (${deploymentMode}) 需要管理员处理。`,
      type: "capability_request_pending",
      severity: "info",
      resourceType: "capability_request",
      resourceId: request.id,
      actionHref: "/market",
      // Round-scoped key: a reopened terminal request reuses the same request
      // id, so including updatedAt gives each round its own unread notification
      // instead of silently updating the previous round's row.
      dedupeKey: `capability_request.submitted:${request.id}:${request.updatedAt}`,
    });
  }
  if (isAdmin) {
    const { record: approved, changed } = decideCapabilityRequestSync({
      requestId: request.id,
      workspaceId,
      decidedByUserId: input.actorUserId,
      decision: "approved",
      decisionReason: "auto-approved by workspace admin",
    });
    if (approved && changed) {
      const dispatched = dispatchApprovedCapabilityRequestSync({
        workspaceId,
        requestId: approved.id,
        actorUserId: input.actorUserId,
      });
      return {
        capabilityRequest: dispatched.request,
        dispatchedOperationId: dispatched.operationId,
        nextAction: dispatched.nextAction,
      };
    }
  }
  return {
    capabilityRequest: request,
    nextAction: "wait_for_approval",
  };
}

interface ResolvedCapabilityCatalogPlan {
  deploymentMode: CapabilityDeploymentMode;
  /** Authoritative source from the catalog entry (SP4) — overrides the client. */
  packageSource?: string;
  /** Immutable MCP catalog item id (mcp kind). */
  catalogItemId?: string;
  /** Immutable managed-service template id (service kind / container MCP, S2/Sp3). */
  managedServiceCatalogId?: string;
  /** Pinned CLI install plan JSON (cli kind, Sp5) — dispatch uses this exact plan. */
  cliPlan?: string;
  displayName?: string;
}

/**
 * Authoritative server-side deployment re-derivation (docs/0811/cli-install
 * P1-7). The browser submits identifiers only; the server looks up the real
 * catalog entry and derives the deployment mode from it:
 *   - CLI:   install strategy (cli_hub/bundled → runtime_builtin, else
 *            runtime_package); source must match the catalog item.
 *   - MCP:   transport (streamable_http → external_service, else
 *            managed_service); the catalog's source is authoritative.
 *   - service: heavyweight container → the skill_service_catalog managed_service
 *            template; its immutable id is pinned.
 * Returns null when the entry cannot be resolved — the caller MUST reject.
 */
function resolveCapabilityDeploymentPlan(
  input: SubmitCapabilityRequestInput,
  workspaceId: string,
): ResolvedCapabilityCatalogPlan | null {
  if (input.packageKind === "cli") {
    const item = findCliCatalogItem(workspaceId, input.packageSource, input.packageSlug);
    if (!item) return null;
    // Pin the exact install plan at submission so the approved dispatch cannot
    // drift to a newer catalog version / integrity (Sp5). Runtime_builtin
    // (cli_hub/bundled) tools have no package plan to pin.
    let cliPlan: string | undefined;
    if (classifyCliDeploymentMode(item) === "runtime_package") {
      try {
        const plan = buildRuntimeAppInstallPlan({ item, operation: "install" });
        cliPlan = JSON.stringify(plan);
      } catch {
        cliPlan = undefined;
      }
    }
    return {
      deploymentMode: classifyCliDeploymentMode(item),
      packageSource: item.source,
      displayName: item.displayName,
      cliPlan,
    };
  }
  if (input.packageKind === "service") {
    const template = listSkillServiceCatalogSync(workspaceId)
      .filter((entry) => entry.slug === input.packageSlug && entry.deploymentType === "managed_service")
      .sort((left, right) => right.templateVersion.localeCompare(left.templateVersion))[0];
    if (!template) return null;
    return {
      deploymentMode: "managed_service",
      managedServiceCatalogId: template.id,
      displayName: template.slug,
    };
  }
  // MCP — resolve the workspace catalog item by slug, pin the exact
  // catalogItemId so dispatch cannot drift to a newer same-slug release, and
  // make the catalog's source authoritative. A container MCP (transport
  // managed_service) also pins its skill_service template id so the deployed
  // image cannot drift after approval (Sp3).
  const catalog = readMcpCatalogItemBySlugSync(input.packageSlug, workspaceId);
  if (!catalog) return null;
  const isContainer = catalog.transport === "managed_service";
  const template = isContainer
    ? listSkillServiceCatalogSync(workspaceId)
        .filter((entry) => entry.slug === input.packageSlug && entry.deploymentType === "managed_service")
        .sort((left, right) => right.templateVersion.localeCompare(left.templateVersion))[0]
    : undefined;
  return {
    deploymentMode: catalog.transport === "streamable_http" ? "external_service" : "managed_service",
    packageSource: catalog.source,
    catalogItemId: catalog.id,
    managedServiceCatalogId: template?.id,
    displayName: catalog.displayName,
  };
}

function buildCapabilityRequestMetadataJson(
  packageKind: CapabilityPackageKind,
  packageSlug: string,
  workspaceId: string,
  plan: ResolvedCapabilityCatalogPlan | null,
): string {
  const metadata: Record<string, unknown> = {};
  if (packageKind === "cli") {
    // Pin the exact install plan so dispatch cannot drift (Sp5).
    if (plan?.cliPlan) metadata.cliPlan = plan.cliPlan;
  }
  if (packageKind === "mcp") {
    const catalogItemId = plan?.catalogItemId
      ?? readMcpCatalogItemBySlugSync(packageSlug, workspaceId)?.id;
    if (catalogItemId) metadata.catalogItemId = catalogItemId;
    // Container MCP also pins the skill_service template (Sp3).
    if (plan?.managedServiceCatalogId) metadata.managedServiceCatalogId = plan.managedServiceCatalogId;
  }
  if (packageKind === "service") {
    const templateId = plan?.managedServiceCatalogId;
    if (templateId) metadata.managedServiceCatalogId = templateId;
  }
  return JSON.stringify(metadata);
}

export function approveCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  decisionReason?: string;
}): SubmitCapabilityRequestResult {
  if (!isCapabilityRequestEnabled()) {
    throw new Error("Capability request channel is disabled (CAPABILITY_REQUESTS_ENABLED=0).");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin) {
    throw new Error("Only workspace owners and admins can approve capability requests.");
  }
  const { record: decided, changed } = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "approved",
    decisionReason: input.decisionReason,
  });
  if (!decided) throw new Error("capability_request.not_found");
  // Only dispatch when the approval actually changed the row. A repeated
  // approval, an approval of an already-terminal request, or a lost race with
  // another admin must not spawn a second operation (docs/0811/cli-install P1).
  if (!changed) {
    const request = readCapabilityRequestSync(input.requestId, input.workspaceId);
    if (!request) throw new Error("capability_request.not_found");
    // Reconciler (Sp4): an `approved` request that was blocked at dispatch time
    // (feature flag off / template not yet admitted) has no linked operation. A
    // re-approval after ops enables the flag / admits the template re-dispatches
    // it instead of leaving it stuck — dispatch is idempotent, so a request that
    // already has an in-flight operation is a no-op.
    if (request.status === "approved" && !request.linkedRuntimeAppOperationId && !request.linkedMcpConnectionId) {
      const recovered = dispatchApprovedCapabilityRequestSync({
        workspaceId: input.workspaceId,
        requestId: request.id,
        actorUserId: input.actorUserId,
      });
      return {
        capabilityRequest: recovered.request,
        dispatchedOperationId: recovered.operationId,
        nextAction: recovered.nextAction,
      };
    }
    return {
      capabilityRequest: request,
      dispatchedOperationId: request.linkedRuntimeAppOperationId ?? request.linkedMcpConnectionId ?? undefined,
      nextAction: request.status === "running" ? "wait_for_operation" : "wait_for_approval",
    };
  }
  const dispatched = dispatchApprovedCapabilityRequestSync({
    workspaceId: input.workspaceId,
    requestId: decided.id,
    actorUserId: input.actorUserId,
  });
  // Notify the original requester that their submission has been approved.
  notifyCapabilityRequestOwnerSync({
    workspaceId: input.workspaceId,
    request: dispatched.capabilityRequest,
    title: `能力申请已批准：${dispatched.capabilityRequest.packageDisplayName}`,
    body: dispatched.nextAction === "wait_for_operation"
      ? `已批准并开始执行（${dispatched.capabilityRequest.deploymentMode}）。`
      : `已批准，等待下一步执行（${dispatched.capabilityRequest.deploymentMode}）。`,
    severity: "info",
    type: "capability_request_approved",
  });
  return dispatched;
}

export function rejectCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  decisionReason: string;
}): CapabilityRequestRecord | null {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId })) {
    throw new Error("Only workspace owners and admins can reject capability requests.");
  }
  if (!input.decisionReason.trim()) {
    throw new Error("Rejection requires a user-facing reason.");
  }
  const { record: result, changed } = decideCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    decidedByUserId: input.actorUserId,
    decision: "rejected",
    decisionReason: input.decisionReason,
  });
  if (!result) throw new Error("capability_request.not_found");
  // Rejecting an already-terminal or non-pending request is a CAS no-op —
  // the status did not change, so we must not write a fresh "rejected" audit
  // or notify the owner as if the rejection landed (docs/0811/cli-install P1).
  if (!changed) {
    return result;
  }
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Capability request rejected",
    note: `${input.decisionReason}`,
    code: "capability_request.rejected",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "capability_request",
      resourceId: input.requestId,
    },
  });
  notifyCapabilityRequestOwnerSync({
    workspaceId: input.workspaceId,
    request: result,
    title: `能力申请被拒绝：${result.packageDisplayName}`,
    body: `原因：${input.decisionReason}`,
    severity: "warning",
    type: "capability_request_rejected",
  });
  return result;
}

export function cancelCapabilityRequestSync(input: {
  requestId: string;
  workspaceId: string;
  actorUserId: string;
  reason?: string;
}): CapabilityRequestRecord | null {
  const request = readCapabilityRequestSync(input.requestId, input.workspaceId);
  if (!request) return null;
  // Only the applicant (or an admin) may cancel their own request.
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin && request.requestedByUserId !== input.actorUserId) {
    throw new Error("capability_request.not_owner");
  }
  const result = dbCancelCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    reason: input.reason,
  });
  if (result && result.status === "cancelled") {
    // Spec: cancelling the envelope must also stop the in-flight work — the
    // linked CLI/baseline op, the skill-service provision op, and the MCP
    // connection (Sp6). Otherwise the page shows "cancelled" while the daemon
    // still installs or creates the container.
    cancelLinkedCapabilityOperationsSync(input.workspaceId, result);
    // A cancelled managed-service capability releases its container to the retire
    // sweep; the sweep now protects pending/approved/running/completed references
    // but treats cancelled as removable (idle TTL → retire).
    tryRecordWorkspaceAuditEventSync({
      workspaceId: input.workspaceId,
      title: "Capability request cancelled",
      note: `${result.packageDisplayName} (${result.deploymentMode}) cancelled.`,
      code: "capability_request.cancelled",
      data: {
        actorType: "session_user",
        actorUserId: input.actorUserId,
        resourceType: "capability_request",
        resourceId: input.requestId,
      },
    });
  }
  return result;
}

function cancelLinkedCapabilityOperationsSync(
  workspaceId: string,
  request: CapabilityRequestRecord,
): void {
  if (request.linkedRuntimeAppOperationId) {
    getDatabase().prepare(
      `UPDATE runtime_app_operation SET status = 'cancelled', completed_at = COALESCE(completed_at, NOW())
       WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'claimed', 'running')`,
    ).run(request.linkedRuntimeAppOperationId, workspaceId);
  }
  if (request.linkedMcpConnectionId) {
    getDatabase().prepare(
      `UPDATE runtime_mcp_connection SET status = 'removed'
       WHERE id = ? AND workspace_id = ?`,
    ).run(request.linkedMcpConnectionId, workspaceId);
  }
  try {
    const metadata = JSON.parse(request.metadataJson) as Record<string, unknown>;
    const skillOpId = metadata.skillServiceOperationId;
    if (typeof skillOpId === "string" && skillOpId) {
      getDatabase().prepare(
        `UPDATE managed_skill_service_operation SET status = 'cancelled', completed_at = COALESCE(completed_at, NOW())
         WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'claimed', 'running')`,
      ).run(skillOpId, workspaceId);
    }
  } catch {
    // malformed metadata — nothing further to cancel
  }
}

export interface CompleteCapabilityRequestMcpConnectionInput {
  workspaceId: string;
  actorUserId: string;
  runtimeId: string;
  catalogItemId: string;
  endpoint: string;
  nonSecretParams?: Record<string, unknown>;
  secrets?: Record<string, string>;
  approvedTools?: string[];
  confirmHighRisk?: boolean;
}

export interface CompleteCapabilityRequestMcpConnectionResult {
  connectionId: string;
  operationId: string;
}

/**
 * Member completion of an approved credential-bearing MCP connection
 * (docs/0811/cli-install P0). After an admin approves a request whose catalog
 * item needs secrets/endpoint/config, the projection surfaces
 * `configure_credentials`. The applicant (or an admin) fills the form and calls
 * this — it verifies an `approved` capability_request covering the exact
 * (workspace, runtime, catalog item) tuple AND whose requestedAction is
 * `connect`, and that the actor is the request owner (or an admin), then
 * materializes the connection via the ungated internal path. The link-back
 * inside that call binds the approved request to the new connection and drives
 * it to running; the verify op then converges it to completed/failed.
 */
export function completeCapabilityRequestMcpConnectionSync(
  input: CompleteCapabilityRequestMcpConnectionInput,
): CompleteCapabilityRequestMcpConnectionResult {
  const catalog = readMcpCatalogItemSync(input.catalogItemId, input.workspaceId);
  if (!catalog) throw new Error("mcp_catalog.not_found");

  // Only the request owner (or an admin) may complete the connection, and only
  // a `connect` request is consumable — a `deploy`/`upgrade` approval must not
  // be spent on the connect-completion path. We find the approved request by
  // its catalog item identity so a same-slug newer release can never hijack the
  // approval.
  const requests = listCapabilityRequestsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    packageKind: "mcp",
    packageSlug: catalog.slug,
    statuses: ["approved"],
    limit: 10,
  });
  const approvedRequest = requests.find((request) => {
    const pinned = resolveMcpCatalogItemIdFromRequest(request);
    return request.requestedAction === "connect"
      && request.packageSource === catalog.source
      && (!pinned || pinned === catalog.id);
  });
  if (!approvedRequest) {
    throw new Error("capability_request.not_approved");
  }
  const isAdmin = isWorkspaceAdminOrOwnerSync({ workspaceId: input.workspaceId, userId: input.actorUserId });
  if (!isAdmin && approvedRequest.requestedByUserId !== input.actorUserId) {
    throw new Error("capability_request.not_owner");
  }

  // Ungated materialization — authorization was verified above via the owned
  // approved request. There is no caller-forgeable bypass boolean.
  const result = materializeMcpConnectionSync({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    catalogItemId: catalog.id,
    endpoint: input.endpoint,
    nonSecretParams: input.nonSecretParams,
    secrets: input.secrets,
    approvedTools: input.approvedTools,
    confirmHighRisk: input.confirmHighRisk,
  });
  return { connectionId: result.connection.id, operationId: result.operation.id };
}

/**
 * Aggregate capability requests for the (workspace, runtime) tuple so the page
 * can deep-link to "我的请求" without re-querying the request store itself.
 */
export function listActiveCapabilityRequestsForRuntime(input: {
  workspaceId: string;
  runtimeId: string;
}): CapabilityRequestRecord[] {
  return listCapabilityRequestsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    statuses: ["pending", "approved", "running"],
    limit: 200,
  });
}

/**
 * Re-export the lower-level catalog / connection helpers for API routes that
 * want a single import surface for capability work.
 */
export {
  listRuntimeInstalledAppsSync,
  listRuntimeAppOperationsSync,
  listMcpConnectionsSync,
  listMcpOperationsSync,
  listMcpCatalogItemsForWorkspaceSync,
  selectCliHubReadiness,
  resolveMcpRuntimeAppRequirement,
};

/**
 * For workspace-private CLI installs, pin the request to a specific release.
 * For non-workspace sources we deliberately leave it null — the runtime
 * already fetches the exact (source, name) pair, and a release row only
 * exists for private artifacts. Public catalog items continue to flow
 * through the runtime-side resolution path.
 */
function resolveCliReleaseId(
  workspaceId: string,
  packageSource: string,
  packageSlug: string,
): string | undefined {
  if (packageSource !== "workspace_private") return undefined;
  const catalogItem = findCliCatalogItem(workspaceId, packageSource, packageSlug);
  if (!catalogItem?.version) return undefined;
  const release = readWorkspaceRuntimeAppReleaseByVersionSync({
    workspaceId,
    slug: packageSlug,
    version: catalogItem.version,
  });
  return release?.id;
}

/**
 * Send a workspace notification to the user who originally requested the
 * capability (the applicant), so they learn the outcome of their request
 * without polling the page. We dedupe per request id + notification type +
 * round (updatedAt) so admin retries within a round don't flood the inbox,
 * while a reopened terminal request gets a fresh unread row instead of silently
 * updating the previous round's row.
 */
function notifyCapabilityRequestOwnerSync(input: {
  workspaceId: string;
  request: CapabilityRequestRecord;
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  type: string;
}): void {
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: input.request.requestedByUserId,
    title: input.title,
    body: input.body,
    type: input.type,
    severity: input.severity,
    resourceType: "capability_request",
    resourceId: input.request.id,
    actionHref: "/market",
    dedupeKey: `${input.type}:${input.request.id}:${input.request.updatedAt}`,
  });
}
