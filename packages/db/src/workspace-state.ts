import { createDefaultWorkspaceState, type DofeAgentState } from "@dofe-agent/domain/workspace";
import { getDatabase, getDatabaseConnectionLabel, countRows, readMetadataValue, DEFAULT_WORKSPACE_ID } from "./database.ts";

export const WORKSPACE_STATE_VERSION = Symbol("dofe_agent.workspace_state_version");

export class WorkspaceStateConflictError extends Error {
  readonly workspaceId: string;
  readonly expectedVersion?: number;
  readonly currentVersion: number;
  readonly code: string;

  constructor(input: { workspaceId: string; expectedVersion?: number; currentVersion: number }) {
    super(
      typeof input.expectedVersion === "number"
        ? `Workspace "${input.workspaceId}" state version conflict (expected ${input.expectedVersion}, current ${input.currentVersion}).`
        : `Workspace "${input.workspaceId}" state version conflict (current ${input.currentVersion}).`,
    );
    this.name = "WorkspaceStateConflictError";
    this.workspaceId = input.workspaceId;
    this.expectedVersion = input.expectedVersion;
    this.currentVersion = input.currentVersion;
    this.code = "workspace.state_conflict";
  }
}

type WorkspaceStateWriteOptions = {
  expectedVersion?: number;
  skipVersionCheck?: boolean;
};

export function ensureWorkspaceStateRecordSync(
  defaultState: DofeAgentState = createDefaultWorkspaceState(),
  workspaceId = DEFAULT_WORKSPACE_ID,
): DofeAgentState {
  const state = readWorkspaceStateRecordSync(workspaceId);
  if (state) {
    return state;
  }

  return writeWorkspaceStateRecordSync(defaultState, workspaceId, {
    skipVersionCheck: true,
  });
}

export function readWorkspaceStateRecordSync(workspaceId = DEFAULT_WORKSPACE_ID): DofeAgentState | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT state_json, state_version FROM workspace_snapshot WHERE id = ?")
    .get(workspaceId) as { state_json: string; state_version: number } | undefined;

  if (!row) {
    return null;
  }

  return attachWorkspaceStateVersion(JSON.parse(row.state_json) as DofeAgentState, row.state_version);
}

export function writeWorkspaceStateRecordSync(
  state: DofeAgentState,
  workspaceId = DEFAULT_WORKSPACE_ID,
  options?: WorkspaceStateWriteOptions,
): DofeAgentState {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id, state_version FROM workspace_snapshot WHERE id = ?")
    .get(workspaceId) as { id: string; state_version: number } | undefined;
  const expectedVersion = options?.expectedVersion ?? readWorkspaceStateVersion(state);

  if (!existing) {
    db.prepare(
      `INSERT INTO workspace_snapshot (
        id,
        organization_name,
        pending_handoffs,
        state_json,
        state_version,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      workspaceId,
      state.organizationName,
      state.pendingHandoffs,
      JSON.stringify(state),
      now,
      now,
    );
    return attachWorkspaceStateVersion(state, 1);
  }

  if (!options?.skipVersionCheck && typeof expectedVersion === "number") {
    const result = db.prepare(
      `UPDATE workspace_snapshot
       SET organization_name = ?,
           pending_handoffs = ?,
           state_json = ?,
           state_version = state_version + 1,
           updated_at = ?
       WHERE id = ? AND state_version = ?`,
    ).run(
      state.organizationName,
      state.pendingHandoffs,
      JSON.stringify(state),
      now,
      workspaceId,
      expectedVersion,
    );

    if (result.changes === 0) {
      const currentVersion = readWorkspaceStateCurrentVersionSync(workspaceId) ?? existing.state_version;
      throw new WorkspaceStateConflictError({
        workspaceId,
        expectedVersion,
        currentVersion,
      });
    }

    return attachWorkspaceStateVersion(state, expectedVersion + 1);
  }

  db.prepare(
    `UPDATE workspace_snapshot
     SET organization_name = ?,
         pending_handoffs = ?,
         state_json = ?,
         state_version = state_version + 1,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    state.organizationName,
    state.pendingHandoffs,
    JSON.stringify(state),
    now,
    workspaceId,
  );

  return attachWorkspaceStateVersion(state, existing.state_version + 1);
}

export function getDatabaseStatusSync(): Record<string, string | number> {
  const db = getDatabase();

  return {
    engine: "postgres",
    databaseUrl: getDatabaseConnectionLabel(),
    schemaVersion: readMetadataValue(db, "schema_version") ?? "unknown",
    workspaces: countRows(db, "workspace"),
    skills: countRows(db, "skill"),
    skillFiles: countRows(db, "skill_file"),
    agentSkills: countRows(db, "agent_skill"),
    users: countRows(db, "users"),
    authIdentities: countRows(db, "auth_identity"),
    sessions: countRows(db, "session"),
    workspaceSnapshots: countRows(db, "workspace_snapshot"),
    daemons: countRows(db, "daemon_connection"),
    runtimes: countRows(db, "agent_runtime"),
    documentAgentAccess: countRows(db, "document_agent_access"),
    documentPermissionRequests: countRows(db, "document_permission_request"),
    agentAccessRequests: countRows(db, "agent_access_request"),
    knowledgeProposals: countRows(db, "knowledge_proposal"),
    agentRouterSessions: countRows(db, "agent_router_session"),
    agentRouterProviderSessions: countRows(db, "agent_router_provider_session"),
    agentTaskAttempts: countRows(db, "agent_task_attempt"),
    agentRouterEvents: countRows(db, "agent_router_event"),
    agentRouterContextSnapshots: countRows(db, "agent_router_context_snapshot"),
    queuedTasks: countRows(db, "agent_task_queue"),
    taskExecutionEvents: countRows(db, "task_execution_event"),
    taskMessages: countRows(db, "task_message"),
  };
}

export function resetWorkspaceExecutionStateSync(workspaceId = DEFAULT_WORKSPACE_ID): {
  removedDocumentAgentAccessRows: number;
  removedDocumentPermissionRequestRows: number;
  removedAgentAccessRequestRows: number;
  removedKnowledgeProposalRows: number;
  removedAgentRouterProviderSessionRows: number;
  removedAgentTaskAttemptRows: number;
  removedAgentRouterEventRows: number;
  removedAgentRouterContextSnapshotRows: number;
  removedAgentRouterSessionRows: number;
  removedBindings: number;
  removedQueuedTasks: number;
  removedTaskMessages: number;
  removedRuntimes: number;
  removedDaemons: number;
  removedTasks: number;
  removedChannels: number;
  removedEmployees: number;
} {
  const db = getDatabase();
  let removedDocumentAgentAccessRows = 0;
  let removedDocumentPermissionRequestRows = 0;
  let removedAgentAccessRequestRows = 0;
  let removedKnowledgeProposalRows = 0;
  let removedAgentRouterProviderSessionRows = 0;
  let removedAgentTaskAttemptRows = 0;
  let removedAgentRouterEventRows = 0;
  let removedAgentRouterContextSnapshotRows = 0;
  let removedAgentRouterSessionRows = 0;
  let removedBindings = 0;
  let removedQueuedTasks = 0;
  let removedTaskMessages = 0;
  let removedRuntimes = 0;
  let removedDaemons = 0;
  let removedTasks = 0;
  let removedChannels = 0;
  let removedEmployees = 0;

  db.exec("BEGIN");
  try {
    const documentAgentAccessResult = db
      .prepare(
        `DELETE FROM document_agent_access
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedDocumentAgentAccessRows = Number(documentAgentAccessResult.changes);

    const documentPermissionRequestResult = db
      .prepare(
        `DELETE FROM document_permission_request
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedDocumentPermissionRequestRows = Number(documentPermissionRequestResult.changes);

    const agentAccessRequestResult = db
      .prepare(
        `DELETE FROM agent_access_request
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentAccessRequestRows = Number(agentAccessRequestResult.changes);

    const knowledgeProposalResult = db
      .prepare(
        `DELETE FROM knowledge_proposal
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedKnowledgeProposalRows = Number(knowledgeProposalResult.changes);

    const taskMessageResult = db
      .prepare(
        `DELETE FROM task_message
         WHERE task_id IN (
           SELECT id
           FROM agent_task_queue
           WHERE workspace_id = ?
         )`,
      )
      .run(workspaceId);
    removedTaskMessages = Number(taskMessageResult.changes);

    const routerEventResult = db
      .prepare(
        `DELETE FROM agent_router_event
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentRouterEventRows = Number(routerEventResult.changes);

    const routerContextSnapshotResult = db
      .prepare(
        `DELETE FROM agent_router_context_snapshot
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentRouterContextSnapshotRows = Number(routerContextSnapshotResult.changes);

    const taskAttemptResult = db
      .prepare(
        `DELETE FROM agent_task_attempt
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentTaskAttemptRows = Number(taskAttemptResult.changes);

    const routerProviderSessionResult = db
      .prepare(
        `DELETE FROM agent_router_provider_session
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentRouterProviderSessionRows = Number(routerProviderSessionResult.changes);

    const queueResult = db
      .prepare(
        `DELETE FROM agent_task_queue
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedQueuedTasks = Number(queueResult.changes);

    const routerSessionResult = db
      .prepare(
        `DELETE FROM agent_router_session
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedAgentRouterSessionRows = Number(routerSessionResult.changes);

    const bindingResult = db
      .prepare(
        `DELETE FROM employee_runtime_binding
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedBindings = Number(bindingResult.changes);

    const runtimeResult = db
      .prepare(
        `DELETE FROM agent_runtime
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedRuntimes = Number(runtimeResult.changes);

    const daemonResult = db
      .prepare(
        `DELETE FROM daemon_connection
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedDaemons = Number(daemonResult.changes);

    const workspaceTaskResult = db
      .prepare(
        `DELETE FROM workspace_task
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedTasks = Number(workspaceTaskResult.changes);

    const workspaceChannelResult = db
      .prepare(
        `DELETE FROM workspace_channel
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedChannels = Number(workspaceChannelResult.changes);

    const workspaceEmployeeResult = db
      .prepare(
        `DELETE FROM workspace_employee
         WHERE workspace_id = ?`,
      )
      .run(workspaceId);
    removedEmployees = Number(workspaceEmployeeResult.changes);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    removedDocumentAgentAccessRows,
    removedDocumentPermissionRequestRows,
    removedAgentAccessRequestRows,
    removedKnowledgeProposalRows,
    removedAgentRouterProviderSessionRows,
    removedAgentTaskAttemptRows,
    removedAgentRouterEventRows,
    removedAgentRouterContextSnapshotRows,
    removedAgentRouterSessionRows,
    removedBindings,
    removedQueuedTasks,
    removedTaskMessages,
    removedRuntimes,
    removedDaemons,
    removedTasks,
    removedChannels,
    removedEmployees,
  };
}

export function readWorkspaceStateVersion(state: DofeAgentState): number | undefined {
  const candidate = state as DofeAgentState & { [WORKSPACE_STATE_VERSION]?: unknown };
  return typeof candidate[WORKSPACE_STATE_VERSION] === "number" ? candidate[WORKSPACE_STATE_VERSION] : undefined;
}

export function readWorkspaceStateCurrentVersionSync(workspaceId = DEFAULT_WORKSPACE_ID): number | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT state_version FROM workspace_snapshot WHERE id = ?")
    .get(workspaceId) as { state_version: number } | undefined;

  return typeof row?.state_version === "number" ? row.state_version : null;
}

function attachWorkspaceStateVersion<T extends DofeAgentState>(state: T, version: number): T {
  Object.defineProperty(state, WORKSPACE_STATE_VERSION, {
    value: version,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return state;
}
