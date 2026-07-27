import type { DaemonProvider } from "@dofe-agent/domain";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  RuntimeProvisioningTaskCleanupStatus,
  RuntimeProvisioningTaskEventRecord,
  RuntimeProvisioningTaskEventSeverity,
  RuntimeProvisioningTaskRecord,
  RuntimeProvisioningTaskStage,
  RuntimeProvisioningTaskStageStatus,
  RuntimeProvisioningTaskStatus,
} from "./types.ts";

export interface CreateRuntimeProvisioningTaskInput {
  workspaceId?: string;
  requestedByUserId: string;
  idempotencyKey: string;
  sourceRuntimeId?: string;
  runtimeType: DaemonProvider;
  protocols: string[];
  requestedModel?: string;
  targetServer?: string;
  maxRetries?: number;
  timeouts?: Partial<Record<RuntimeProvisioningTaskStage, number>>;
}

export interface AdvanceRuntimeProvisioningStageInput {
  id: string;
  workspaceId?: string;
  stage: RuntimeProvisioningTaskStage;
  status: RuntimeProvisioningTaskStageStatus;
  progressPercent: number;
  runtimeId?: string;
  runtimeCredentialId?: string;
  secretRef?: string;
  configRef?: string;
}

export interface AppendRuntimeProvisioningEventInput {
  taskId: string;
  stage: RuntimeProvisioningTaskStage;
  status: RuntimeProvisioningTaskStageStatus;
  progressPercent: number;
  title: string;
  summary?: string;
  severity?: RuntimeProvisioningTaskEventSeverity;
  data?: Record<string, unknown>;
}

const ORDERED_STAGES: RuntimeProvisioningTaskStage[] = [
  "pending",
  "request_credential",
  "prepare_node",
  "pull_image",
  "install_cli",
  "write_credential",
  "health_check",
  "ready",
];

const SKIPPED_STAGES_IN_PHASE_2: RuntimeProvisioningTaskStage[] = [
  "pull_image",
  "install_cli",
];

/**
 * Create a provisioning task, honoring the (workspace, idempotency_key) unique
 * constraint: re-submitting the same key returns the existing task instead of
 * creating a duplicate (so retries never double-provision a Runtime Key).
 */
export function createRuntimeProvisioningTaskSync(
  input: CreateRuntimeProvisioningTaskInput,
): RuntimeProvisioningTaskRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const existing = readRuntimeProvisioningTaskByIdempotencyKeySync(
    workspaceId,
    input.idempotencyKey,
  );
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const id = `runtime-provisioning-${randomLikeId()}`;
  getDatabase().prepare(
    `INSERT INTO runtime_provisioning_task (
       id, workspace_id, runtime_id, requested_by_user_id, idempotency_key,
       source_runtime_id, runtime_type, protocols_json, requested_model, target_server,
       stage, stage_status, progress_percent, retry_count, max_retries,
       cleanup_status, status, timeouts_json, started_at, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 0, 0, ?, 'pending', 'queued', ?, NULL, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.requestedByUserId,
    input.idempotencyKey,
    optional(input.sourceRuntimeId),
    input.runtimeType,
    JSON.stringify(normalizeProtocols(input.protocols)),
    optional(input.requestedModel),
    optional(input.targetServer),
    input.maxRetries ?? 3,
    JSON.stringify(input.timeouts ?? {}),
    now,
    now,
  );
  return readRuntimeProvisioningTaskSync(id, workspaceId)!;
}

export function readRuntimeProvisioningTaskSync(
  id: string,
  workspaceId?: string,
): RuntimeProvisioningTaskRecord | null {
  const row = (workspaceId
    ? getDatabase().prepare(
        "SELECT * FROM runtime_provisioning_task WHERE id = ? AND workspace_id = ?",
      ).get(id, workspaceId)
    : getDatabase().prepare(
        "SELECT * FROM runtime_provisioning_task WHERE id = ?",
      ).get(id)) as RawRuntimeProvisioningTask | undefined;
  return row ? mapRuntimeProvisioningTask(row) : null;
}

export function readRuntimeProvisioningTaskByIdempotencyKeySync(
  workspaceId: string,
  idempotencyKey: string,
): RuntimeProvisioningTaskRecord | null {
  const row = getDatabase().prepare(
    "SELECT * FROM runtime_provisioning_task WHERE workspace_id = ? AND idempotency_key = ?",
  ).get(workspaceId, idempotencyKey) as RawRuntimeProvisioningTask | undefined;
  return row ? mapRuntimeProvisioningTask(row) : null;
}

export function listRuntimeProvisioningTasksSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  options?: { statuses?: RuntimeProvisioningTaskStatus[]; limit?: number },
): RuntimeProvisioningTaskRecord[] {
  const statuses = options?.statuses;
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);
  const rows = (statuses && statuses.length > 0
    ? getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ? AND status = ANY(?)
         ORDER BY created_at DESC LIMIT ?`,
      ).all(workspaceId, statuses, limit)
    : getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(workspaceId, limit)) as RawRuntimeProvisioningTask[];
  return rows.map(mapRuntimeProvisioningTask);
}

/**
 * Mark a task running and advance to a stage. In Phase 2 the Docker/CLI stages
 * (`pull_image`, `install_cli`) are auto-marked `skipped` — they are realised
 * in Phase 3. Appends a readable event row for each stage transition.
 */
export function advanceRuntimeProvisioningTaskStageSync(
  input: AdvanceRuntimeProvisioningStageInput,
): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage = ?, stage_status = ?, progress_percent = ?,
           runtime_id = COALESCE(?, runtime_id),
           runtime_credential_id = COALESCE(?, runtime_credential_id),
           secret_ref = COALESCE(?, secret_ref),
           config_ref = COALESCE(?, config_ref),
           status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.stage,
      input.status,
      input.progressPercent,
      optional(input.runtimeId),
      optional(input.runtimeCredentialId),
      optional(input.secretRef),
      optional(input.configRef),
      now,
      now,
      input.id,
      workspaceId,
    );
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: input.stage,
      status: input.status,
      progressPercent: input.progressPercent,
      title: `Stage ${input.stage} ${input.status}`,
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function markRuntimeProvisioningTaskFailedSync(input: {
  id: string;
  workspaceId?: string;
  stage: RuntimeProvisioningTaskStage;
  errorCode?: string;
  errorMessage: string;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage = ?, stage_status = 'failed', status = 'failed',
           last_error_code = ?, last_error_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.stage,
      optional(input.errorCode),
      input.errorMessage,
      now,
      now,
      input.id,
      workspaceId,
    );
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: input.stage,
      status: "failed",
      progressPercent: readProgressSync(db, input.id),
      title: `Stage ${input.stage} failed`,
      summary: input.errorMessage,
      severity: "error",
      data: input.errorCode ? { errorCode: input.errorCode } : undefined,
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function markRuntimeProvisioningTaskReadySync(input: {
  id: string;
  workspaceId?: string;
  runtimeId: string;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage = 'ready', stage_status = 'succeeded', progress_percent = 100,
           runtime_id = COALESCE(?, runtime_id), status = 'succeeded',
           completed_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(input.runtimeId, now, now, input.id, workspaceId);
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: "ready",
      status: "succeeded",
      progressPercent: 100,
      title: "Runtime ready",
      summary: "Managed runtime is online and credential-bound.",
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

/**
 * Reset a failed task to pending for a retry. Bounded by max_retries; the
 * orchestrator checks the bound before calling. Credential create is itself
 * idempotent on models.dofe.ai, so a retry never re-issues a second key when
 * the credential stage already succeeded.
 */
export function resetRuntimeProvisioningTaskForRetrySync(input: {
  id: string;
  workspaceId?: string;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage = 'pending', stage_status = 'pending', progress_percent = 0,
           retry_count = retry_count + 1, status = 'queued',
           last_error_code = NULL, last_error_message = NULL,
           completed_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'failed'`,
    ).run(now, input.id, workspaceId);
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: "pending",
      status: "pending",
      progressPercent: 0,
      title: "Retry queued",
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function markRuntimeProvisioningTaskCancellingSync(input: {
  id: string;
  workspaceId?: string;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `UPDATE runtime_provisioning_task
     SET status = 'cancelled', cleanup_status = 'running', updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'failed')`,
  ).run(now, input.id, workspaceId);
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function completeRuntimeProvisioningCancellationSync(input: {
  id: string;
  workspaceId?: string;
  cleanupStatus: Exclude<RuntimeProvisioningTaskCleanupStatus, "pending" | "running">;
  cleanupResult?: Record<string, unknown>;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET status = 'cancelled', cleanup_status = ?, cleanup_result_json = COALESCE(?, cleanup_result_json),
           completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.cleanupStatus,
      input.cleanupResult ? JSON.stringify(input.cleanupResult) : null,
      now,
      now,
      input.id,
      workspaceId,
    );
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: "ready",
      status: "skipped",
      progressPercent: 0,
      title: "Provisioning cancelled",
      summary: `Cleanup ${input.cleanupStatus}`,
      severity: input.cleanupStatus === "failed" ? "warning" : "info",
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function appendRuntimeProvisioningEventSync(
  input: AppendRuntimeProvisioningEventInput,
): void {
  appendRuntimeProvisioningEventRowSync(getDatabase(), input);
}

export function listRuntimeProvisioningTaskEventsSync(
  taskId: string,
): RuntimeProvisioningTaskEventRecord[] {
  const rows = getDatabase().prepare(
    "SELECT * FROM runtime_provisioning_task_event WHERE task_id = ? ORDER BY created_at ASC",
  ).all(taskId) as RawRuntimeProvisioningTaskEvent[];
  return rows.map(mapRuntimeProvisioningTaskEvent);
}

export function stageIsSkippedInPhase2(
  stage: RuntimeProvisioningTaskStage,
): boolean {
  return SKIPPED_STAGES_IN_PHASE_2.includes(stage);
}

export function stageOrder(stage: RuntimeProvisioningTaskStage): number {
  return ORDERED_STAGES.indexOf(stage);
}

function appendRuntimeProvisioningEventRowSync(
  db: ReturnType<typeof getDatabase>,
  input: AppendRuntimeProvisioningEventInput,
): void {
  const id = `runtime-provisioning-event-${randomLikeId()}`;
  db.prepare(
    `INSERT INTO runtime_provisioning_task_event (
       id, task_id, stage, status, progress_percent, title, summary, severity, data_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.stage,
    input.status,
    input.progressPercent,
    input.title,
    optional(input.summary),
    input.severity ?? "info",
    input.data ? JSON.stringify(input.data) : null,
    new Date().toISOString(),
  );
}

function readProgressSync(
  db: ReturnType<typeof getDatabase>,
  id: string,
): number {
  const row = db.prepare(
    "SELECT progress_percent FROM runtime_provisioning_task WHERE id = ?",
  ).get(id) as { progress_percent?: number } | undefined;
  return row?.progress_percent ?? 0;
}

type RawRuntimeProvisioningTask = {
  id: string;
  workspace_id: string;
  runtime_id: string | null;
  requested_by_user_id: string;
  idempotency_key: string;
  source_runtime_id: string | null;
  runtime_type: string;
  protocols_json: string;
  requested_model: string | null;
  target_server: string | null;
  stage: RuntimeProvisioningTaskStage;
  stage_status: RuntimeProvisioningTaskStageStatus;
  progress_percent: number;
  retry_count: number;
  max_retries: number;
  last_error_code: string | null;
  last_error_message: string | null;
  cleanup_status: RuntimeProvisioningTaskCleanupStatus;
  cleanup_result_json: string | null;
  runtime_credential_id: string | null;
  secret_ref: string | null;
  config_ref: string | null;
  status: RuntimeProvisioningTaskStatus;
  timeouts_json: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawRuntimeProvisioningTaskEvent = {
  id: string;
  task_id: string;
  stage: RuntimeProvisioningTaskStage;
  status: RuntimeProvisioningTaskStageStatus;
  progress_percent: number;
  title: string;
  summary: string | null;
  severity: RuntimeProvisioningTaskEventSeverity;
  data_json: string | null;
  created_at: string;
};

function mapRuntimeProvisioningTask(
  row: RawRuntimeProvisioningTask,
): RuntimeProvisioningTaskRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runtimeId: row.runtime_id ?? undefined,
    requestedByUserId: row.requested_by_user_id,
    idempotencyKey: row.idempotency_key,
    sourceRuntimeId: row.source_runtime_id ?? undefined,
    runtimeType: row.runtime_type as DaemonProvider,
    protocols: normalizeProtocols(parseJsonArray(row.protocols_json)),
    requestedModel: row.requested_model ?? undefined,
    targetServer: row.target_server ?? undefined,
    stage: row.stage,
    stageStatus: row.stage_status,
    progressPercent: row.progress_percent,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    cleanupStatus: row.cleanup_status,
    cleanupResultJson: row.cleanup_result_json ?? undefined,
    runtimeCredentialId: row.runtime_credential_id ?? undefined,
    secretRef: row.secret_ref ?? undefined,
    configRef: row.config_ref ?? undefined,
    status: row.status,
    timeoutsJson: row.timeouts_json,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRuntimeProvisioningTaskEvent(
  row: RawRuntimeProvisioningTaskEvent,
): RuntimeProvisioningTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    stage: row.stage,
    status: row.status,
    progressPercent: row.progress_percent,
    title: row.title,
    summary: row.summary ?? undefined,
    severity: row.severity,
    dataJson: row.data_json ?? undefined,
    createdAt: row.created_at,
  };
}

function optional(value: string | undefined): string | null {
  const result = value?.trim();
  return result || null;
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeProtocols(values: unknown[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ).map((value) => value.trim()),
    ),
  ];
}
