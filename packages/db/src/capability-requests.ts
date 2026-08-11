import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  CapabilityDeploymentMode,
  CapabilityPackageKind,
  CapabilityRequestedAction,
  CapabilityRequestPriority,
  CapabilityRequestRecord,
  CapabilityRequestStatus,
} from "./types.ts";

export interface CreateCapabilityRequestInput {
  workspaceId?: string;
  requestedByUserId: string;
  runtimeId?: string;
  packageKind: CapabilityPackageKind;
  packageSource: string;
  packageSlug: string;
  packageDisplayName: string;
  deploymentMode: CapabilityDeploymentMode;
  requestedAction: CapabilityRequestedAction;
  priority?: CapabilityRequestPriority;
  message?: string;
  metadataJson?: string;
  linkedKnowledgePageId?: string;
  /** Pin the request to a specific immutable release id (CLI installs only). */
  releaseId?: string;
}

export interface DecideCapabilityRequestInput {
  requestId: string;
  workspaceId?: string;
  decidedByUserId: string;
  decision: "approved" | "rejected";
  decisionReason?: string;
}

export interface DecideCapabilityRequestResult {
  record: CapabilityRequestRecord | null;
  /** True when the row's status actually changed from `pending` to the decision. */
  changed: boolean;
}

export interface TransitionCapabilityRequestInput {
  requestId: string;
  workspaceId?: string;
  status: CapabilityRequestStatus;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  linkedRuntimeAppOperationId?: string;
  linkedRuntimeInstalledAppId?: string;
  linkedMcpConnectionId?: string;
  linkedRuntimeProvisioningTaskId?: string;
  linkedKnowledgePageId?: string;
  releaseId?: string;
  metadataJson?: string;
}

export interface ListCapabilityRequestsOptions {
  workspaceId?: string;
  statuses?: CapabilityRequestStatus[];
  requestedByUserId?: string;
  runtimeId?: string;
  packageKind?: CapabilityPackageKind;
  packageSlug?: string;
  limit?: number;
}

const SELECT_FIELDS = `
  id, workspace_id AS workspaceId, requested_by_user_id AS requestedByUserId,
  decided_by_user_id AS decidedByUserId, runtime_id AS runtimeId,
  package_kind AS packageKind, package_source AS packageSource, package_slug AS packageSlug,
  package_display_name AS packageDisplayName, deployment_mode AS deploymentMode,
  requested_action AS requestedAction, priority, message, status,
  decision_reason AS decisionReason,
  last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage,
  linked_runtime_app_operation_id AS linkedRuntimeAppOperationId,
  linked_runtime_installed_app_id AS linkedRuntimeInstalledAppId,
  linked_mcp_connection_id AS linkedMcpConnectionId,
  linked_runtime_provisioning_task_id AS linkedRuntimeProvisioningTaskId,
  linked_knowledge_page_id AS linkedKnowledgePageId,
  release_id AS releaseId,
  metadata_json AS metadataJson,
  created_at AS createdAt, updated_at AS updatedAt,
  decided_at AS decidedAt, completed_at AS completedAt
`;

export type CapabilityRequestCreateOutcome = "created" | "reopened" | "in_flight";

export interface CreateCapabilityRequestResult {
  record: CapabilityRequestRecord;
  /**
   * `created` = a new row was inserted.
   * `reopened` = an existing terminal row was reset to pending.
   * `in_flight` = an existing non-terminal row was returned unchanged (no-op);
   *   re-submission against a pending/approved/running request must not clobber
   *   server-side state. Callers gate side-effects (audit, notifications) on
   *   `outcome !== "in_flight"` so a concurrent double-submit writes exactly one
   *   audit event (docs/0811/cli-install §3.4 idempotency, CAS migration).
   */
  outcome: CapabilityRequestCreateOutcome;
}

export function createCapabilityRequestSync(
  input: CreateCapabilityRequestInput,
): CreateCapabilityRequestResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `capability-request-${randomLikeId()}`;
  const resolution = withTransaction(getDatabase(), () => {
    // CAS step 1 — insert only when no row owns this idempotency key. ON
    // CONFLICT DO NOTHING keeps the compare-and-set atomic; the classification
    // read below runs inside the same transaction so a concurrent inserter's
    // committed owner is visible by the time we look it up.
    const inserted = getDatabase()
      .prepare(
        `INSERT INTO capability_request (
           id, workspace_id, requested_by_user_id, runtime_id,
           package_kind, package_source, package_slug, package_display_name,
           deployment_mode, requested_action, priority, message,
           status, release_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(workspace_id, runtime_id, package_kind, package_source, package_slug, requested_action)
         DO NOTHING
         RETURNING id`,
      )
      .get(
        id,
        workspaceId,
        input.requestedByUserId,
        input.runtimeId ?? null,
        input.packageKind,
        input.packageSource,
        input.packageSlug,
        input.packageDisplayName,
        input.deploymentMode,
        input.requestedAction,
        input.priority ?? "normal",
        input.message ?? "",
        input.releaseId ?? null,
        input.metadataJson ?? "{}",
        now,
        now,
      ) as { id: string } | undefined;
    if (inserted) return { id: inserted.id, outcome: "created" as const };

    // CAS step 2 — a row already owns the key. Classify by status: terminal
    // rows reopen to pending; in-flight rows are immutable. The SELECT uses
    // `=` to mirror the unique constraint's NULL-distinct semantics — and this
    // branch is only reachable when the conflict fired, which requires a
    // non-NULL runtime_id match, so the equality lookup always finds the owner.
    const owner = getDatabase()
      .prepare(
        `SELECT id, status FROM capability_request
         WHERE workspace_id = ? AND runtime_id = ?
           AND package_kind = ? AND package_source = ? AND package_slug = ?
           AND requested_action = ?`,
      )
      .get(
        workspaceId,
        input.runtimeId ?? null,
        input.packageKind,
        input.packageSource,
        input.packageSlug,
        input.requestedAction,
      ) as { id: string; status: string } | undefined;
    // ON CONFLICT fired, so an owner must exist. If it vanished (e.g. a
    // concurrent cascade delete), surface a hard failure rather than silently
    // dropping the request.
    if (!owner) return null;

    const isTerminal =
      owner.status === "rejected"
      || owner.status === "failed"
      || owner.status === "completed"
      || owner.status === "cancelled";
    if (!isTerminal) {
      // In-flight (pending/approved/running): CAS no-op. Return the owner
      // unchanged — do NOT overwrite its fields, release pin, or metadata.
      return { id: owner.id, outcome: "in_flight" as const };
    }

    // Terminal → reopen to pending. Reset the decision/error/link columns,
    // refresh the request fields the requester is re-declaring, and transfer
    // ownership to the current requester so notifications/approvals are routed
    // to the right person (docs/0811/cli-install P1-4).
    getDatabase()
      .prepare(
        `UPDATE capability_request SET
           requested_by_user_id = ?, package_display_name = ?, deployment_mode = ?,
           priority = ?, message = ?, release_id = ?, metadata_json = ?,
           status = 'pending',
           decided_by_user_id = NULL, decision_reason = NULL, decided_at = NULL,
           completed_at = NULL, last_error_code = NULL, last_error_message = NULL,
           linked_runtime_app_operation_id = NULL, linked_runtime_installed_app_id = NULL,
           linked_mcp_connection_id = NULL, linked_runtime_provisioning_task_id = NULL,
           linked_knowledge_page_id = NULL,
           updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      )
      .run(
        input.requestedByUserId,
        input.packageDisplayName,
        input.deploymentMode,
        input.priority ?? "normal",
        input.message ?? "",
        input.releaseId ?? null,
        input.metadataJson ?? "{}",
        now,
        owner.id,
        workspaceId,
      );
    return { id: owner.id, outcome: "reopened" as const };
  });
  if (!resolution) throw new Error("capability_request.create_failed");
  const record = readCapabilityRequestSync(resolution.id, workspaceId);
  if (!record) throw new Error("capability_request.create_failed");
  return { record, outcome: resolution.outcome };
}

export function readCapabilityRequestSync(
  requestId: string,
  workspaceId?: string,
): CapabilityRequestRecord | null {
  const sql = workspaceId
    ? `SELECT ${SELECT_FIELDS} FROM capability_request WHERE id = ? AND workspace_id = ?`
    : `SELECT ${SELECT_FIELDS} FROM capability_request WHERE id = ?`;
  const row = (workspaceId
    ? getDatabase().prepare(sql).get(requestId, workspaceId)
    : getDatabase().prepare(sql).get(requestId)) as Record<string, unknown> | undefined;
  return row ? mapCapabilityRequest(row) : null;
}

/**
 * Finds the (at most one) capability_request whose metadata_json references the
 * given managed-skill-service operation id (docs/0811/cli-install Phase 5).
 * Indexed by the JSONB field rather than scanning the full request table, so an
 * old request that completed long ago is still found when its provision
 * operation converges.
 */
export function findCapabilityRequestByServiceOperationIdSync(
  workspaceId: string,
  operationId: string,
): CapabilityRequestRecord | null {
  const row = getDatabase()
    .prepare(
      `SELECT ${SELECT_FIELDS} FROM capability_request
       WHERE workspace_id = ? AND metadata_json->>'skillServiceOperationId' = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(workspaceId, operationId) as Record<string, unknown> | undefined;
  return row ? mapCapabilityRequest(row) : null;
}

/**
 * True when a capability_request still backs this managed service — either by
 * pinning its catalog template (metadata.managedServiceCatalogId) or by
 * recording the deployed instance (metadata.serviceId). Covers non-terminal AND
 * completed requests: a completed capability IS a live deployment, so its
 * container must not be swept as "unreferenced" the moment provisioning
 * finishes (the stateless retire default would otherwise kill a just-deployed
 * managed MCP). Only failed / rejected / cancelled requests release the service
 * to the retire sweep (explicit removal → idle TTL → retire).
 */
export function hasActiveCapabilityRequestForManagedServiceSync(input: {
  workspaceId: string;
  serviceId: string;
  catalogId: string;
}): boolean {
  const row = getDatabase()
    .prepare(
      `SELECT 1 AS present FROM capability_request
       WHERE workspace_id = ?
         AND status IN ('pending', 'approved', 'running', 'completed')
         AND (metadata_json->>'managedServiceCatalogId' = ? OR metadata_json->>'serviceId' = ?)
       LIMIT 1`,
    )
    .get(input.workspaceId, input.catalogId, input.serviceId) as { present?: number } | undefined;
  return row?.present === 1;
}

export function listCapabilityRequestsSync(
  options: ListCapabilityRequestsOptions = {},
): CapabilityRequestRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conditions = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.statuses && options.statuses.length > 0) {
    conditions.push(`status = ANY(?)`);
    params.push(options.statuses);
  }
  if (options.requestedByUserId) {
    conditions.push("requested_by_user_id = ?");
    params.push(options.requestedByUserId);
  }
  if (options.runtimeId) {
    conditions.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.packageKind) {
    conditions.push("package_kind = ?");
    params.push(options.packageKind);
  }
  if (options.packageSlug) {
    conditions.push("package_slug = ?");
    params.push(options.packageSlug);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const sql = `SELECT ${SELECT_FIELDS} FROM capability_request
               WHERE ${conditions.join(" AND ")}
               ORDER BY created_at DESC LIMIT ${limit}`;
  const rows = getDatabase().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows
    .map(mapCapabilityRequest)
    .filter((value): value is CapabilityRequestRecord => value !== null);
}

export function decideCapabilityRequestSync(
  input: DecideCapabilityRequestInput,
): DecideCapabilityRequestResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const result = getDatabase()
    .prepare(
      `UPDATE capability_request
       SET status = ?, decided_by_user_id = ?, decision_reason = ?,
           decided_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    )
    .run(
      input.decision,
      input.decidedByUserId,
      input.decisionReason ?? null,
      now,
      now,
      input.requestId,
      workspaceId,
    );
  const record = readCapabilityRequestSync(input.requestId, workspaceId);
  return { record, changed: result.changes > 0 };
}

export function transitionCapabilityRequestSync(
  input: TransitionCapabilityRequestInput,
): CapabilityRequestRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const fields = ["status = ?", "updated_at = ?"];
  const params: unknown[] = [input.status, now];
  if (input.lastErrorCode !== undefined) {
    fields.push("last_error_code = ?");
    params.push(input.lastErrorCode);
  }
  if (input.lastErrorMessage !== undefined) {
    fields.push("last_error_message = ?");
    params.push(input.lastErrorMessage);
  }
  if (input.linkedRuntimeAppOperationId !== undefined) {
    fields.push("linked_runtime_app_operation_id = ?");
    params.push(input.linkedRuntimeAppOperationId);
  }
  if (input.linkedRuntimeInstalledAppId !== undefined) {
    fields.push("linked_runtime_installed_app_id = ?");
    params.push(input.linkedRuntimeInstalledAppId);
  }
  if (input.linkedMcpConnectionId !== undefined) {
    fields.push("linked_mcp_connection_id = ?");
    params.push(input.linkedMcpConnectionId);
  }
  if (input.linkedRuntimeProvisioningTaskId !== undefined) {
    fields.push("linked_runtime_provisioning_task_id = ?");
    params.push(input.linkedRuntimeProvisioningTaskId);
  }
  if (input.linkedKnowledgePageId !== undefined) {
    fields.push("linked_knowledge_page_id = ?");
    params.push(input.linkedKnowledgePageId);
  }
  if (input.releaseId !== undefined) {
    fields.push("release_id = ?");
    params.push(input.releaseId);
  }
  if (input.metadataJson !== undefined) {
    fields.push("metadata_json = ?");
    params.push(input.metadataJson);
  }
  if (input.status === "completed" || input.status === "failed" || input.status === "cancelled") {
    fields.push("completed_at = ?");
    params.push(now);
  }
  params.push(input.requestId, workspaceId);
  getDatabase()
    .prepare(
      `UPDATE capability_request SET ${fields.join(", ")}
       WHERE id = ? AND workspace_id = ?`,
    )
    .run(...params);
  return readCapabilityRequestSync(input.requestId, workspaceId);
}

export function cancelCapabilityRequestSync(input: {
  requestId: string;
  workspaceId?: string;
  actorUserId: string;
  reason?: string;
}): CapabilityRequestRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = readCapabilityRequestSync(input.requestId, workspaceId);
  if (!existing) return null;
  if (existing.status !== "pending" && existing.status !== "approved" && existing.status !== "running") {
    return existing;
  }
  return transitionCapabilityRequestSync({
    requestId: input.requestId,
    workspaceId,
    status: "cancelled",
    lastErrorCode: "capability_request.cancelled_by_user",
    lastErrorMessage: input.reason ?? "Cancelled by user.",
  });
}

/**
 * Operation→request convergence (docs/0811/cli-install §6, P1-3).
 *
 * When a runtime_app_operation reaches a terminal state, find the (at most one)
 * capability_request linked to it via linked_runtime_app_operation_id and
 * converge its status. No-op when no request is linked or the request is
 * already terminal — the subsystem reaching terminal state must never reopen or
 * re-stamp an already-closed request. Called from the operation transition
 * functions so convergence happens regardless of which caller drove the op.
 */
export function convergeCapabilityRequestFromRuntimeAppOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  outcome: "succeeded" | "failed";
  installedAppId?: string;
  errorCode?: string;
  errorMessage?: string;
}): CapabilityRequestRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase()
    .prepare(
      `SELECT id FROM capability_request
       WHERE workspace_id = ? AND linked_runtime_app_operation_id = ?
       LIMIT 1`,
    )
    .get(workspaceId, input.operationId) as { id: string } | undefined;
  if (!row) return null;
  const request = readCapabilityRequestSync(row.id, workspaceId);
  if (!request) return null;
  if (
    request.status === "completed"
    || request.status === "failed"
    || request.status === "cancelled"
  ) {
    return request;
  }
  const status: CapabilityRequestStatus = input.outcome === "succeeded" ? "completed" : "failed";
  return transitionCapabilityRequestSync({
    requestId: row.id,
    workspaceId,
    status,
    linkedRuntimeInstalledAppId: input.installedAppId,
    lastErrorCode: input.outcome === "failed" ? input.errorCode : undefined,
    lastErrorMessage: input.outcome === "failed" ? input.errorMessage : undefined,
  });
}

/**
 * MCP operation→request convergence (docs/0811/cli-install §6, P1-1).
 *
 * Symmetric to the runtime-app convergence, but keyed by linked_mcp_connection_id
 * — the single connection that an MCP capability_request tracks. Called from the
 * MCP operation transition functions when a *verify* op reaches a terminal
 * state, so the request converges regardless of which caller drove the op.
 * Guarded upstream (only verify ops converge) so remove/health-check ops never
 * close a request. No-op when no request is linked or it is already terminal.
 */
export function convergeCapabilityRequestFromMcpConnectionSync(input: {
  connectionId: string;
  workspaceId?: string;
  outcome: "succeeded" | "failed";
  errorCode?: string;
  errorMessage?: string;
}): CapabilityRequestRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase()
    .prepare(
      `SELECT id FROM capability_request
       WHERE workspace_id = ? AND linked_mcp_connection_id = ?
       LIMIT 1`,
    )
    .get(workspaceId, input.connectionId) as { id: string } | undefined;
  if (!row) return null;
  const request = readCapabilityRequestSync(row.id, workspaceId);
  if (!request) return null;
  if (
    request.status === "completed"
    || request.status === "failed"
    || request.status === "cancelled"
  ) {
    return request;
  }
  const status: CapabilityRequestStatus = input.outcome === "succeeded" ? "completed" : "failed";
  return transitionCapabilityRequestSync({
    requestId: row.id,
    workspaceId,
    status,
    lastErrorCode: input.outcome === "failed" ? input.errorCode : undefined,
    lastErrorMessage: input.outcome === "failed" ? input.errorMessage : undefined,
  });
}

/**
 * Link-back binding (P1-1). When an MCP connection is materialized through the
 * approved dispatch path, find the matching approved capability_request and
 * converge it to running with linked_mcp_connection_id set. This is the single
 * convergence point: the verify op that follows will then drive it to
 * completed/failed via {@link convergeCapabilityRequestFromMcpConnectionSync}.
 *
 * Only post-approval states are eligible: `approved` (member finishes a
 * credential-type connection) or `running` (a managed-MCP request whose
 * container finished provisioning and is now auto-connecting). A `pending`
 * request must still go through the admin approval flow. No-op when no matching
 * request exists.
 */
export function bindApprovedCapabilityRequestToMcpConnectionSync(input: {
  workspaceId: string;
  runtimeId: string;
  packageSource: string;
  packageSlug: string;
  connectionId: string;
}): CapabilityRequestRecord | null {
  const row = getDatabase()
    .prepare(
      `SELECT id, status FROM capability_request
       WHERE workspace_id = ? AND runtime_id = ?
         AND package_kind = 'mcp'
         AND package_source = ? AND package_slug = ?
         AND status IN ('approved', 'running')
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(
      input.workspaceId,
      input.runtimeId,
      input.packageSource,
      input.packageSlug,
    ) as { id: string; status: string } | undefined;
  if (!row) return null;
  return transitionCapabilityRequestSync({
    requestId: row.id,
    workspaceId: input.workspaceId,
    status: "running",
    linkedMcpConnectionId: input.connectionId,
  });
}

function mapCapabilityRequest(value: Record<string, unknown>): CapabilityRequestRecord | null {
  const alias = (camel: string, lower: string): unknown => value[camel] ?? value[lower];
  const id = value.id;
  const workspaceId = alias("workspaceId", "workspaceid");
  const requestedByUserId = alias("requestedByUserId", "requestedbyuserid");
  const packageKind = alias("packageKind", "packagekind");
  const packageSource = alias("packageSource", "packagesource");
  const packageSlug = alias("packageSlug", "packageslug");
  const packageDisplayName = alias("packageDisplayName", "packagedisplayname");
  const deploymentMode = alias("deploymentMode", "deploymentmode");
  const requestedAction = alias("requestedAction", "requestedaction");
  const priority = value.priority;
  const message = value.message;
  const status = value.status;
  const metadataJson = alias("metadataJson", "metadatajson");
  const createdAt = alias("createdAt", "createdat");
  const updatedAt = alias("updatedAt", "updatedat");
  if (
    typeof id !== "string" ||
    typeof workspaceId !== "string" ||
    typeof requestedByUserId !== "string" ||
    typeof packageKind !== "string" ||
    typeof packageSource !== "string" ||
    typeof packageSlug !== "string" ||
    typeof packageDisplayName !== "string" ||
    typeof deploymentMode !== "string" ||
    typeof requestedAction !== "string" ||
    typeof priority !== "string" ||
    typeof message !== "string" ||
    typeof status !== "string" ||
    typeof metadataJson !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id,
    workspaceId,
    requestedByUserId,
    decidedByUserId: optionalString(alias("decidedByUserId", "decidedbyuserid")),
    runtimeId: optionalString(alias("runtimeId", "runtimeid")),
    packageKind: packageKind as CapabilityRequestRecord["packageKind"],
    packageSource,
    packageSlug,
    packageDisplayName,
    deploymentMode: deploymentMode as CapabilityRequestRecord["deploymentMode"],
    requestedAction: requestedAction as CapabilityRequestRecord["requestedAction"],
    priority: priority as CapabilityRequestPriority,
    message,
    status: status as CapabilityRequestStatus,
    decisionReason: optionalString(alias("decisionReason", "decisionreason")),
    lastErrorCode: optionalString(alias("lastErrorCode", "lasterrorcode")),
    lastErrorMessage: optionalString(alias("lastErrorMessage", "lasterrormessage")),
    linkedRuntimeAppOperationId: optionalString(alias("linkedRuntimeAppOperationId", "linkedruntimeappoperationid")),
    linkedRuntimeInstalledAppId: optionalString(alias("linkedRuntimeInstalledAppId", "linkedruntimeinstalledappid")),
    linkedMcpConnectionId: optionalString(alias("linkedMcpConnectionId", "linkedmcpconnectionid")),
    linkedRuntimeProvisioningTaskId: optionalString(alias("linkedRuntimeProvisioningTaskId", "linkedruntimeprovisioningtaskid")),
    linkedKnowledgePageId: optionalString(alias("linkedKnowledgePageId", "linkedknowledgepageid")),
    releaseId: optionalString(alias("releaseId", "releaseid")),
    metadataJson,
    createdAt,
    updatedAt,
    decidedAt: optionalString(alias("decidedAt", "decidedat")),
    completedAt: optionalString(alias("completedAt", "completedat")),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}