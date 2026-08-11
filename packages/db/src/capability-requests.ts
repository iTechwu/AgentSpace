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

export function createCapabilityRequestSync(
  input: CreateCapabilityRequestInput,
): CapabilityRequestRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `capability-request-${randomLikeId()}`;
  // Predicate that selects terminal requests so a re-submission of the same
  // idempotency key reopens them instead of silently staying rejected/failed.
  const terminal = "capability_request.status IN ('rejected','failed','completed','cancelled')";
  // Each terminal-only reset: clear the column when reopening, otherwise keep
  // the existing value. Repeated predicate is intentional — ON CONFLICT SET
  // cannot reference an aliased expression across columns.
  const reopen = (column: string) =>
    `CASE WHEN ${terminal} THEN NULL ELSE capability_request.${column} END`;
  const row = withTransaction(getDatabase(), () =>
    getDatabase()
      .prepare(
        `INSERT INTO capability_request (
          id, workspace_id, requested_by_user_id, runtime_id,
          package_kind, package_source, package_slug, package_display_name,
          deployment_mode, requested_action, priority, message,
          status, release_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        ON CONFLICT(workspace_id, runtime_id, package_kind, package_source, package_slug, requested_action)
        DO UPDATE SET
          package_display_name = excluded.package_display_name,
          deployment_mode = excluded.deployment_mode,
          priority = excluded.priority,
          message = excluded.message,
          release_id = excluded.release_id,
          metadata_json = excluded.metadata_json,
          status = CASE WHEN ${terminal} THEN 'pending' ELSE capability_request.status END,
          decided_by_user_id = ${reopen("decided_by_user_id")},
          decision_reason = ${reopen("decision_reason")},
          decided_at = ${reopen("decided_at")},
          completed_at = ${reopen("completed_at")},
          last_error_code = ${reopen("last_error_code")},
          last_error_message = ${reopen("last_error_message")},
          linked_runtime_app_operation_id = ${reopen("linked_runtime_app_operation_id")},
          linked_runtime_installed_app_id = ${reopen("linked_runtime_installed_app_id")},
          linked_mcp_connection_id = ${reopen("linked_mcp_connection_id")},
          linked_runtime_provisioning_task_id = ${reopen("linked_runtime_provisioning_task_id")},
          linked_knowledge_page_id = ${reopen("linked_knowledge_page_id")},
          updated_at = excluded.updated_at
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
      ) as { id: string } | undefined,
  );
  // ON CONFLICT returns the persisted id (existing row on conflict, new row
  // otherwise). Read back with THAT id — using the locally-generated `id`
  // would miss on conflict and throw a spurious create_failed.
  const persistedId = row?.id;
  if (!persistedId) throw new Error("capability_request.create_failed");
  const record = readCapabilityRequestSync(persistedId, workspaceId);
  if (!record) throw new Error("capability_request.create_failed");
  return record;
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
): CapabilityRequestRecord | null {
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
  if (result.changes === 0) return readCapabilityRequestSync(input.requestId, workspaceId);
  return readCapabilityRequestSync(input.requestId, workspaceId);
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