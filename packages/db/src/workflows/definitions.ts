import { getDatabase, randomLikeId, withTransaction, type PostgresSyncDatabase } from "../database.ts";
import type {
  WorkflowDefinitionRecord,
  WorkflowTriggerRecord,
  WorkflowVersionRecord,
} from "../types.ts";

export interface CreateWorkflowDefinitionInput {
  workspaceId: string;
  name: string;
  description?: string;
  ownerUserId: string;
  channelName?: string;
  createdBy: string;
  legacySourceType?: string;
  legacySourceId?: string;
  draftGraphJson?: string;
  id?: string;
  now?: string;
}

export interface UpdateWorkflowDraftInput {
  id: string;
  workspaceId: string;
  name?: string;
  description?: string | null;
  ownerUserId?: string;
  channelName?: string | null;
  graphJson?: string;
  expectedDraftVersion?: number;
  updatedAt?: string;
}

export interface PublishWorkflowVersionInput {
  workspaceId: string;
  workflowId: string;
  graphJson: string;
  contentHash: string;
  publishedBy: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  governanceJson?: string;
  schemaVersion?: number;
  versionNumber?: number;
  id?: string;
  publishedAt?: string;
  trigger?: Omit<UpsertWorkflowTriggerInput, "workspaceId" | "workflowId">;
}

export interface UpsertWorkflowTriggerInput {
  id?: string;
  workspaceId: string;
  workflowId: string;
  type: "manual" | "schedule" | "event";
  configJson: string;
  timezone?: string;
  status?: string;
  nextFireAt?: string;
  lastFireAt?: string;
  misfirePolicy?: string;
  dedupeWindowSeconds?: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  now?: string;
}

export function createWorkflowDefinitionSync(
  input: CreateWorkflowDefinitionInput,
): WorkflowDefinitionRecord {
  const db = getDatabase();
  const id = input.id ?? `workflow-${randomLikeId()}`;
  const now = input.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_definition (
       id, workspace_id, name, description, owner_user_id, channel_name, status, draft_graph_json,
       legacy_source_type, legacy_source_id, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.name,
    input.description ?? null,
    input.ownerUserId,
    input.channelName ?? null,
    input.draftGraphJson ?? '{"schemaVersion":1,"nodes":[],"edges":[]}',
    input.legacySourceType ?? null,
    input.legacySourceId ?? null,
    input.createdBy,
    now,
    now,
  );
  return readWorkflowDefinitionSync(id, input.workspaceId)!;
}

export function updateWorkflowDraftSync(input: UpdateWorkflowDraftInput): WorkflowDefinitionRecord {
  const current = readWorkflowDefinitionSync(input.id, input.workspaceId);
  if (!current) throw new Error("workflow_definition_not_found");
  if (current.status === "archived") throw new Error("workflow_definition_archived");
  if (
    input.expectedDraftVersion !== undefined &&
    input.expectedDraftVersion !== current.draftVersion
  ) {
    throw new Error("workflow_draft_version_conflict");
  }
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const result = getDatabase().prepare(
    `UPDATE workflow_definition
        SET name = ?, description = ?, owner_user_id = ?, channel_name = ?,
            draft_graph_json = ?, draft_version = draft_version + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status <> 'archived' AND draft_version = ?`,
  ).run(
    input.name ?? current.name,
    input.description === undefined ? current.description ?? null : input.description,
    input.ownerUserId ?? current.ownerUserId,
    input.channelName === undefined ? current.channelName ?? null : input.channelName,
    input.graphJson ?? current.draftGraphJson,
    updatedAt,
    input.id,
    input.workspaceId,
    current.draftVersion,
  );
  if (result.changes !== 1) throw new Error("workflow_definition_conflict");
  return readWorkflowDefinitionSync(input.id, input.workspaceId)!;
}

export function readWorkflowDefinitionSync(
  id: string,
  workspaceId: string,
): WorkflowDefinitionRecord | null {
  const row = getDatabase().prepare(`${DEFINITION_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapDefinition(row) : null;
}

export function listWorkflowDefinitionsSync(workspaceId: string): WorkflowDefinitionRecord[] {
  return (getDatabase().prepare(
    `${DEFINITION_SELECT} WHERE workspace_id = ? ORDER BY updated_at DESC, id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>).map(mapDefinition);
}

export function publishWorkflowVersionSync(
  input: PublishWorkflowVersionInput,
): WorkflowVersionRecord {
  const db = getDatabase();
  return withTransaction(db, () => {
    const definition = db.prepare(
      `SELECT id, status, active_version_id AS "activeVersionId" FROM workflow_definition
       WHERE id = ? AND workspace_id = ? FOR UPDATE`,
    ).get(input.workflowId, input.workspaceId) as { id?: string; status?: string; activeVersionId?: string } | undefined;
    if (!definition?.id) throw new Error("workflow_definition_not_found");
    if (definition.status === "archived") throw new Error("workflow_definition_archived");

    const identical = readWorkflowVersionByHashWithDatabase(
      db,
      input.workflowId,
      input.workspaceId,
      input.contentHash,
    );
    if (identical) {
      const now = input.publishedAt ?? new Date().toISOString();
      if (definition.activeVersionId !== identical.id) {
        activateWorkflowVersionWithDatabase(db, {
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          versionId: identical.id,
          versionNumber: identical.versionNumber,
          now,
        });
      }
      if (input.trigger) {
        upsertWorkflowTriggerWithDatabase(db, {
          ...input.trigger,
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          now: input.trigger.now ?? now,
        });
      }
      return identical;
    }

    const nextRow = db.prepare(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS "versionNumber"
       FROM workflow_version WHERE workflow_id = ? AND workspace_id = ?`,
    ).get(input.workflowId, input.workspaceId) as { versionNumber?: number } | undefined;
    const versionNumber = input.versionNumber ?? nextRow?.versionNumber ?? 1;
    const conflict = db.prepare(
      `SELECT 1 FROM workflow_version
       WHERE workflow_id = ? AND workspace_id = ? AND version_number = ?`,
    ).get(input.workflowId, input.workspaceId, versionNumber);
    if (conflict) throw new Error("workflow_version_conflict");

    const id = input.id ?? `workflow-version-${randomLikeId()}`;
    const now = input.publishedAt ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO workflow_version (
         id, workspace_id, workflow_id, version_number, schema_version, graph_json,
         input_schema_json, output_schema_json, governance_json, content_hash,
         published_by, published_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workspaceId,
      input.workflowId,
      versionNumber,
      input.schemaVersion ?? 1,
      input.graphJson,
      input.inputSchemaJson ?? "{}",
      input.outputSchemaJson ?? "{}",
      input.governanceJson ?? "{}",
      input.contentHash,
      input.publishedBy,
      now,
      now,
    );
    activateWorkflowVersionWithDatabase(db, {
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      versionId: id,
      versionNumber,
      now,
    });

    if (input.trigger) {
      upsertWorkflowTriggerWithDatabase(db, {
        ...input.trigger,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        now: input.trigger.now ?? now,
      });
    }

    return readWorkflowVersionWithDatabase(db, id, input.workspaceId)!;
  });
}

function activateWorkflowVersionWithDatabase(
  db: PostgresSyncDatabase,
  input: { workspaceId: string; workflowId: string; versionId: string; versionNumber: number; now: string },
): void {
  const updated = db.prepare(
    `UPDATE workflow_definition
        SET active_version_id = ?, status = 'published', updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
  ).run(input.versionId, input.now, input.workflowId, input.workspaceId);
  if (updated.changes !== 1) throw new Error("workflow_definition_conflict");

  const dataJson = JSON.stringify({
    workflowId: input.workflowId,
    versionId: input.versionId,
    versionNumber: input.versionNumber,
  });
  db.prepare(
    `INSERT INTO workflow_outbox (
       id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json,
       status, attempts, available_at, created_at
     ) VALUES (?, ?, 'workflow_definition', ?, 'workflow.version.published', ?, 'pending', 0, ?, ?)`,
  ).run(
    `workflow-outbox-${randomLikeId()}`,
    input.workspaceId,
    input.workflowId,
    dataJson,
    input.now,
    input.now,
  );
  db.prepare(
    `INSERT INTO audit_log (
       id, workspace_id, title, note, code, data_json, source, source_index, created_at
     ) VALUES (?, ?, ?, ?, 'workflow.version.published', ?, 'runtime_lifecycle', 0, ?)`,
  ).run(
    `audit-${randomLikeId()}`,
    input.workspaceId,
    "工作流版本已发布",
    input.workflowId,
    dataJson,
    input.now,
  );
}

export function readWorkflowVersionSync(id: string, workspaceId: string): WorkflowVersionRecord | null {
  return readWorkflowVersionWithDatabase(getDatabase(), id, workspaceId);
}

export function listWorkflowVersionsSync(
  workflowId: string,
  workspaceId: string,
): WorkflowVersionRecord[] {
  return (getDatabase().prepare(
    `${VERSION_SELECT} WHERE workflow_id = ? AND workspace_id = ? ORDER BY version_number DESC`,
  ).all(workflowId, workspaceId) as Array<Record<string, unknown>>).map(mapVersion);
}

export function upsertWorkflowTriggerSync(input: UpsertWorkflowTriggerInput): WorkflowTriggerRecord {
  return upsertWorkflowTriggerWithDatabase(getDatabase(), input);
}

function upsertWorkflowTriggerWithDatabase(
  db: PostgresSyncDatabase,
  input: UpsertWorkflowTriggerInput,
): WorkflowTriggerRecord {
  const workflow = db.prepare(
    "SELECT 1 FROM workflow_definition WHERE id = ? AND workspace_id = ?",
  ).get(input.workflowId, input.workspaceId);
  if (!workflow) throw new Error("workflow_definition_not_found");
  const id = input.id ?? `workflow-trigger-${randomLikeId()}`;
  const now = input.now ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO workflow_trigger (
       id, workspace_id, workflow_id, type, config_json, timezone, status,
       next_fire_at, last_fire_at, misfire_policy, dedupe_window_seconds,
       lease_owner, lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       workflow_id = EXCLUDED.workflow_id,
       type = EXCLUDED.type,
       config_json = EXCLUDED.config_json,
       timezone = EXCLUDED.timezone,
       status = EXCLUDED.status,
       next_fire_at = EXCLUDED.next_fire_at,
       last_fire_at = EXCLUDED.last_fire_at,
       misfire_policy = EXCLUDED.misfire_policy,
       dedupe_window_seconds = EXCLUDED.dedupe_window_seconds,
       lease_owner = EXCLUDED.lease_owner,
       lease_expires_at = EXCLUDED.lease_expires_at,
       updated_at = EXCLUDED.updated_at
     WHERE workflow_trigger.workspace_id = EXCLUDED.workspace_id`,
  ).run(
    id,
    input.workspaceId,
    input.workflowId,
    input.type,
    input.configJson,
    input.timezone ?? null,
    input.status ?? "active",
    input.nextFireAt ?? null,
    input.lastFireAt ?? null,
    input.misfirePolicy ?? "skip",
    input.dedupeWindowSeconds ?? 0,
    input.leaseOwner ?? null,
    input.leaseExpiresAt ?? null,
    now,
    now,
  );
  const trigger = readWorkflowTriggerWithDatabase(db, id, input.workspaceId);
  if (!trigger) throw new Error("workflow_trigger_cross_workspace_conflict");
  return trigger;
}

export function readWorkflowTriggerSync(id: string, workspaceId: string): WorkflowTriggerRecord | null {
  return readWorkflowTriggerWithDatabase(getDatabase(), id, workspaceId);
}

export function readWorkflowTriggerForWorkflowSync(
  workflowId: string,
  workspaceId: string,
): WorkflowTriggerRecord | null {
  const row = getDatabase().prepare(
    `${TRIGGER_SELECT}
     WHERE workflow_id = ? AND workspace_id = ?
     ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, updated_at DESC, id ASC
     LIMIT 1`,
  ).get(workflowId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapTrigger(row) : null;
}

export function listActiveWorkflowEventTriggersSync(workspaceId: string): WorkflowTriggerRecord[] {
  return (getDatabase().prepare(
    `${TRIGGER_SELECT}
     WHERE workspace_id = ? AND type = 'event' AND status = 'active'
     ORDER BY workflow_id ASC, id ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>).map(mapTrigger);
}

export function claimDueWorkflowTriggersSync(input: {
  workerId: string;
  now: string;
  limit: number;
  leaseSeconds: number;
  workspaceId?: string;
}): WorkflowTriggerRecord[] {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(input.limit, 100));
  const workspaceClause = input.workspaceId ? " AND workspace_id = ?" : "";
  const params = input.workspaceId ? [input.now, input.now, input.workspaceId, limit] : [input.now, input.now, limit];
  const rows = db.prepare(
    `SELECT id, workspace_id AS "workspaceId" FROM workflow_trigger
     WHERE status = 'active' AND next_fire_at IS NOT NULL AND next_fire_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at < ?) ${workspaceClause}
     ORDER BY next_fire_at ASC, id ASC LIMIT ?`,
  ).all(...params) as Array<{ id?: string; workspaceId?: string }>;
  const leaseExpiresAt = new Date(Date.parse(input.now) + Math.max(1, input.leaseSeconds) * 1000).toISOString();
  const claimed: WorkflowTriggerRecord[] = [];
  for (const row of rows) {
    if (!row.id || !row.workspaceId) continue;
    const result = db.prepare(
      `UPDATE workflow_trigger SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'active'
         AND next_fire_at IS NOT NULL AND next_fire_at <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
       RETURNING id`,
    ).get(input.workerId, leaseExpiresAt, input.now, row.id, row.workspaceId, input.now, input.now) as { id?: string } | undefined;
    if (result?.id) {
      const trigger = readWorkflowTriggerWithDatabase(db, row.id, row.workspaceId);
      if (trigger) claimed.push(trigger);
    }
  }
  return claimed;
}

export function advanceWorkflowTriggerSync(input: {
  id: string;
  workspaceId: string;
  workerId: string;
  nextFireAt?: string | null;
  lastFireAt?: string | null;
  status?: string;
  now: string;
}): WorkflowTriggerRecord | null {
  const result = getDatabase().prepare(
    `UPDATE workflow_trigger
        SET next_fire_at = ?, last_fire_at = COALESCE(?, last_fire_at), status = COALESCE(?, status),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND lease_owner = ?`,
  ).run(
    input.nextFireAt ?? null,
    input.lastFireAt ?? null,
    input.status ?? null,
    input.now,
    input.id,
    input.workspaceId,
    input.workerId,
  );
  return result.changes === 1 ? readWorkflowTriggerSync(input.id, input.workspaceId) : null;
}

const DEFINITION_SELECT = `SELECT
  id, workspace_id AS "workspaceId", name, description, owner_user_id AS "ownerUserId",
  channel_name AS "channelName", status, active_version_id AS "activeVersionId",
  draft_graph_json AS "draftGraphJson", draft_version AS "draftVersion",
  legacy_source_type AS "legacySourceType", legacy_source_id AS "legacySourceId",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt",
  archived_at AS "archivedAt"
FROM workflow_definition`;

const VERSION_SELECT = `SELECT
  id, workspace_id AS "workspaceId", workflow_id AS "workflowId",
  version_number AS "versionNumber", schema_version AS "schemaVersion", graph_json AS "graphJson",
  input_schema_json AS "inputSchemaJson", output_schema_json AS "outputSchemaJson",
  governance_json AS "governanceJson", content_hash AS "contentHash",
  published_by AS "publishedBy", published_at AS "publishedAt", created_at AS "createdAt"
FROM workflow_version`;

const TRIGGER_SELECT = `SELECT
  id, workspace_id AS "workspaceId", workflow_id AS "workflowId", type,
  config_json AS "configJson", timezone, status, next_fire_at AS "nextFireAt",
  last_fire_at AS "lastFireAt", misfire_policy AS "misfirePolicy",
  dedupe_window_seconds AS "dedupeWindowSeconds", lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt", created_at AS "createdAt", updated_at AS "updatedAt"
FROM workflow_trigger`;

function readWorkflowVersionWithDatabase(
  db: PostgresSyncDatabase,
  id: string,
  workspaceId: string,
): WorkflowVersionRecord | null {
  const row = db.prepare(`${VERSION_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapVersion(row) : null;
}

function readWorkflowVersionByHashWithDatabase(
  db: PostgresSyncDatabase,
  workflowId: string,
  workspaceId: string,
  contentHash: string,
): WorkflowVersionRecord | null {
  const row = db.prepare(
    `${VERSION_SELECT} WHERE workflow_id = ? AND workspace_id = ? AND content_hash = ?`,
  ).get(workflowId, workspaceId, contentHash) as Record<string, unknown> | undefined;
  return row ? mapVersion(row) : null;
}

function readWorkflowTriggerWithDatabase(
  db: PostgresSyncDatabase,
  id: string,
  workspaceId: string,
): WorkflowTriggerRecord | null {
  const row = db.prepare(`${TRIGGER_SELECT} WHERE id = ? AND workspace_id = ?`)
    .get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapTrigger(row) : null;
}

function mapDefinition(row: Record<string, unknown>): WorkflowDefinitionRecord {
  return compactOptional(row) as unknown as WorkflowDefinitionRecord;
}

function mapVersion(row: Record<string, unknown>): WorkflowVersionRecord {
  return compactOptional(row) as unknown as WorkflowVersionRecord;
}

function mapTrigger(row: Record<string, unknown>): WorkflowTriggerRecord {
  return compactOptional(row) as unknown as WorkflowTriggerRecord;
}

function compactOptional(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
}
