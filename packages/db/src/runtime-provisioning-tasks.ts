import type { DaemonProvider } from "@dofe-agent/domain";
import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import { DEFAULT_DAEMON_HEARTBEAT_STALE_MS } from "./daemon-constants.ts";
import type {
  RuntimeProvisioningTaskCleanupStatus,
  RuntimeProvisioningTaskEventRecord,
  RuntimeProvisioningTaskEventSeverity,
  RuntimeProvisioningTaskRecord,
  RuntimeProvisioningTaskStage,
  RuntimeProvisioningTaskStageStatus,
  RuntimeProvisioningTaskStatus,
} from "./types.ts";

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;

function resolveStageTimeoutMs(
  stage: RuntimeProvisioningTaskStage,
  timeoutsJson?: string,
): number {
  if (!timeoutsJson) {
    return DEFAULT_STAGE_TIMEOUT_MS;
  }
  try {
    const parsed = JSON.parse(timeoutsJson) as Record<string, unknown>;
    const value = parsed[stage];
    if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
      return value;
    }
  } catch {
    // fall through
  }
  return DEFAULT_STAGE_TIMEOUT_MS;
}

function resolveTaskTimeoutMs(timeoutsJson?: string, taskTimeoutMs?: number): number {
  if (typeof taskTimeoutMs === "number" && taskTimeoutMs > 0 && Number.isFinite(taskTimeoutMs)) {
    return taskTimeoutMs;
  }
  if (!timeoutsJson) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }
  try {
    const parsed = JSON.parse(timeoutsJson) as Record<string, unknown>;
    const value = parsed.task;
    if (typeof value === "number" && value > 0 && Number.isFinite(value)) {
      return value;
    }
  } catch {
    // fall through
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

function computeRetryAfterMs(retryCount: number, baseMs = 15_000, maxMs = 5 * 60 * 1000): number {
  const jitter = Math.random() * 0.4 + 0.8;
  return Math.min(maxMs, baseMs * 2 ** retryCount) * jitter;
}

export interface CreateRuntimeProvisioningTaskInput {
  workspaceId?: string;
  requestedByUserId: string;
  idempotencyKey: string;
  sourceRuntimeId?: string;
  runtimeType: DaemonProvider;
  protocols: string[];
  requestedName?: string;
  requestedModel?: string;
  allowedModels?: string[];
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
  daemonConnectionId?: string;
  stageStartedAt?: string;
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
       source_runtime_id, runtime_type, protocols_json, requested_name, requested_model,
       allowed_models_json, target_server,
       stage, stage_status, progress_percent, retry_count, max_retries,
       cleanup_status, status, timeouts_json, task_timeout_ms, next_retry_at, started_at, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', 0, 0, ?, 'pending', 'queued', ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.requestedByUserId,
    input.idempotencyKey,
    optional(input.sourceRuntimeId),
    input.runtimeType,
    JSON.stringify(normalizeProtocols(input.protocols)),
    optional(input.requestedName),
    optional(input.requestedModel),
    JSON.stringify(normalizeModels(input.allowedModels ?? [])),
    optional(input.targetServer),
    input.maxRetries ?? 3,
    JSON.stringify(input.timeouts ?? {}),
    DEFAULT_TASK_TIMEOUT_MS,
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
           daemon_connection_id = COALESCE(?, daemon_connection_id),
           stage_started_at = COALESCE(?, stage_started_at),
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
      optional(input.daemonConnectionId),
      optional(input.stageStartedAt),
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
  allowRetry?: boolean;
  retryAfterMs?: number;
  metadata?: Record<string, unknown>;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const task = readRuntimeProvisioningTaskSync(input.id, workspaceId);
  if (!task) {
    return null;
  }

  const allowRetry = input.allowRetry !== false;
  const hasRetriesRemaining = task.retryCount < task.maxRetries;
  if (allowRetry && hasRetriesRemaining) {
    return scheduleRuntimeProvisioningTaskRetrySync({
      id: input.id,
      workspaceId,
      stage: input.stage,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      retryAfterMs: input.retryAfterMs,
    });
  }

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
      data: {
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.metadata ?? {}),
      },
    });
  });
  return readRuntimeProvisioningTaskSync(input.id, workspaceId);
}

export function scheduleRuntimeProvisioningTaskRetrySync(input: {
  id: string;
  workspaceId?: string;
  stage: RuntimeProvisioningTaskStage;
  errorCode?: string;
  errorMessage: string;
  retryAfterMs?: number;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  const retryAfterMs = input.retryAfterMs ?? computeRetryAfterMs(0);
  const nextRetryAt = new Date(Date.now() + retryAfterMs).toISOString();
  withTransaction(db, () => {
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage = ?, stage_status = 'failed', status = 'retrying',
           last_error_code = ?, last_error_message = ?,
           next_retry_at = ?, completed_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.stage,
      optional(input.errorCode),
      input.errorMessage,
      nextRetryAt,
      now,
      input.id,
      workspaceId,
    );
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.id,
      stage: input.stage,
      status: "pending",
      progressPercent: readProgressSync(db, input.id),
      title: "Retry scheduled",
      summary: `Retry at ${nextRetryAt}`,
      severity: "warning",
      data: { errorCode: input.errorCode, nextRetryAt },
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
           daemon_connection_id = NULL, stage_started_at = NULL,
           next_retry_at = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND status IN ('failed', 'retrying')`,
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
     SET status = 'cancelling', cleanup_status = 'running', next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'failed', 'retrying')`,
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

const NODE_PROVISIONING_STAGES: RuntimeProvisioningTaskStage[] = [
  "pull_image",
  "install_cli",
  "write_credential",
  "health_check",
];

export interface ClaimManagedProvisioningStageInput {
  daemonConnectionId: string;
  workspaceId?: string;
  deviceName?: string;
}

export function claimManagedProvisioningStageSync(
  input: ClaimManagedProvisioningStageInput,
): RuntimeProvisioningTaskRecord | null {
  const db = getDatabase();
  const now = new Date().toISOString();

  return withTransaction(db, () => {
    const daemon = db.prepare(
      `SELECT workspace_id AS workspaceId, device_name AS deviceName, status AS "daemonStatus",
              last_heartbeat_at AS lastHeartbeatAt, metadata_json AS metadataJson
       FROM daemon_connection WHERE id = ?`,
    ).get(input.daemonConnectionId) as {
      workspaceId?: unknown;
      deviceName?: unknown;
      daemonStatus?: unknown;
      lastHeartbeatAt?: unknown;
      metadataJson?: unknown;
    } | undefined;
    if (
      !daemon ||
      typeof daemon.workspaceId !== "string" ||
      typeof daemon.deviceName !== "string" ||
      daemon.daemonStatus !== "online" ||
      typeof daemon.lastHeartbeatAt !== "string" ||
      new Date(daemon.lastHeartbeatAt).getTime() < Date.now() - DEFAULT_DAEMON_HEARTBEAT_STALE_MS ||
      !isManagedNodeMetadata(daemon.metadataJson)
    ) {
      return null;
    }
    const workspaceId = input.workspaceId ?? daemon.workspaceId;
    if (workspaceId !== daemon.workspaceId) {
      return null;
    }
    const deviceName = input.deviceName ?? daemon.deviceName;
    const targetServerClause = deviceName
      ? "AND (target_server IS NULL OR target_server = ?)"
      : "AND target_server IS NULL";
    const params: unknown[] = [
      workspaceId,
      NODE_PROVISIONING_STAGES,
      input.daemonConnectionId,
    ];
    if (deviceName) params.push(deviceName);

    const row = db
      .prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ?
           AND status = 'running'
           AND stage = ANY(?)
           AND stage_status = 'pending'
           AND (daemon_connection_id IS NULL OR daemon_connection_id = ?)
           ${targetServerClause}
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(...params) as RawRuntimeProvisioningTask | undefined;

    if (!row) return null;
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET daemon_connection_id = ?,
           stage_status = 'running',
           stage_started_at = ?,
           updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(input.daemonConnectionId, now, now, row.id, workspaceId);

    if (row.runtime_id) {
      db.prepare(
        `UPDATE agent_runtime
         SET daemon_connection_id = ?,
             updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(input.daemonConnectionId, now, row.runtime_id, workspaceId);
    }

    return readRuntimeProvisioningTaskSync(row.id, workspaceId);
  });
}

export function completeManagedProvisioningStageSync(input: {
  taskId: string;
  stage: RuntimeProvisioningTaskStage;
  workspaceId?: string;
  nextStage?: RuntimeProvisioningTaskStage;
  metadata?: Record<string, unknown>;
}): RuntimeProvisioningTaskRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const db = getDatabase();
  return withTransaction(db, () => {
    const task = readRuntimeProvisioningTaskSync(input.taskId, workspaceId);
    if (!task || task.status === "cancelling" || task.status === "cancelled" || task.status === "succeeded" || task.status === "failed") {
      return task;
    }
    const now = new Date().toISOString();
    if (input.nextStage) {
      db.prepare(
        `UPDATE runtime_provisioning_task
         SET stage = ?, stage_status = 'pending', progress_percent = progress_percent + 5,
             stage_started_at = NULL, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(input.nextStage, now, input.taskId, workspaceId);
    } else {
      db.prepare(
        `UPDATE runtime_provisioning_task
         SET stage_status = 'succeeded', updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      ).run(now, input.taskId, workspaceId);
    }
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: input.taskId,
      stage: input.stage,
      status: "succeeded",
      progressPercent: readProgressSync(db, input.taskId),
      title: `Stage ${input.stage} succeeded`,
      data: input.metadata,
    });
    return readRuntimeProvisioningTaskSync(input.taskId, workspaceId);
  });
}

export function failManagedProvisioningStageSync(input: {
  taskId: string;
  stage: RuntimeProvisioningTaskStage;
  workspaceId?: string;
  errorCode?: string;
  errorMessage: string;
  metadata?: Record<string, unknown>;
}): RuntimeProvisioningTaskRecord | null {
  return markRuntimeProvisioningTaskFailedSync({
    id: input.taskId,
    workspaceId: input.workspaceId,
    stage: input.stage,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    metadata: input.metadata,
  });
}

export function readRuntimeProvisioningTaskStatusSync(
  id: string,
  workspaceId?: string,
): RuntimeProvisioningTaskStatus | null {
  const row = (workspaceId
    ? getDatabase().prepare(
        "SELECT status FROM runtime_provisioning_task WHERE id = ? AND workspace_id = ?",
      ).get(id, workspaceId)
    : getDatabase().prepare(
        "SELECT status FROM runtime_provisioning_task WHERE id = ?",
      ).get(id)) as { status?: RuntimeProvisioningTaskStatus } | undefined;
  return row?.status ?? null;
}

export function listRetryingRuntimeProvisioningTasksReadySync(
  workspaceId?: string,
): RuntimeProvisioningTaskRecord[] {
  const now = new Date().toISOString();
  const rows = (typeof workspaceId === "string"
    ? getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ? AND status = 'retrying' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC`,
      ).all(workspaceId, now)
    : getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE status = 'retrying' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC`,
      ).all(now)) as RawRuntimeProvisioningTask[];
  return rows.map(mapRuntimeProvisioningTask);
}

export function listRunningProvisioningTasksTimedOutSync(
  workspaceId?: string,
): RuntimeProvisioningTaskRecord[] {
  const rows = (typeof workspaceId === "string"
    ? getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ? AND status = 'running'
           AND started_at IS NOT NULL`,
      ).all(workspaceId)
    : getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE status = 'running'
           AND started_at IS NOT NULL`,
      ).all()) as RawRuntimeProvisioningTask[];
  const now = Date.now();
  return rows.filter((row) => {
    const timeoutMs = resolveTaskTimeoutMs(row.timeouts_json, row.task_timeout_ms);
    const startedAt = new Date(row.started_at!).getTime();
    return now - startedAt > timeoutMs;
  }).map(mapRuntimeProvisioningTask);
}

export function listRunningNodeStagesForTimeoutSync(
  workspaceId?: string,
): RuntimeProvisioningTaskRecord[] {
  const rows = (typeof workspaceId === "string"
    ? getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE workspace_id = ? AND status = 'running'
           AND stage = ANY(?)
           AND stage_status = 'running'
           AND stage_started_at IS NOT NULL`,
      ).all(workspaceId, NODE_PROVISIONING_STAGES)
    : getDatabase().prepare(
        `SELECT * FROM runtime_provisioning_task
         WHERE status = 'running'
           AND stage = ANY(?)
           AND stage_status = 'running'
           AND stage_started_at IS NOT NULL`,
      ).all(NODE_PROVISIONING_STAGES)) as RawRuntimeProvisioningTask[];
  const now = Date.now();
  return rows.filter((row) => {
    const timeoutMs = resolveStageTimeoutMs(row.stage, row.timeouts_json);
    const startedAt = row.stage_started_at ? new Date(row.stage_started_at).getTime() : Number.NaN;
    return Number.isFinite(startedAt) && now - startedAt > timeoutMs;
  }).map(mapRuntimeProvisioningTask);
}

export function timeoutRunningNodeStagesSync(): {
  timedOut: number;
  retried: number;
  failed: number;
} {
  const tasks = listRunningNodeStagesForTimeoutSync();
  let retried = 0;
  let failed = 0;
  for (const task of tasks) {
    const next = failManagedProvisioningStageSync({
      taskId: task.id,
      stage: task.stage,
      workspaceId: task.workspaceId,
      errorCode: "provisioning.stage_timeout",
      errorMessage: `Stage ${task.stage} timed out after ${resolveStageTimeoutMs(task.stage, task.timeoutsJson)}ms`,
    });
    if (!next) {
      continue;
    }
    if (next.status === "retrying") {
      retried += 1;
    } else if (next.status === "failed") {
      failed += 1;
    }
  }
  return { timedOut: tasks.length, retried, failed };
}

export function requeueProvisioningStagesForOfflineDaemonSync(
  daemonConnectionId: string,
): { reclaimed: number; retried: number; failed: number } {
  const db = getDatabase();
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM runtime_provisioning_task
       WHERE daemon_connection_id = ?
         AND status IN ('running', 'retrying')
         AND stage = ANY(?)
         AND stage_status = 'running'`,
    )
    .all(daemonConnectionId, NODE_PROVISIONING_STAGES) as RawRuntimeProvisioningTask[];

  let reclaimed = 0;
  let retried = 0;
  let failed = 0;

  for (const row of rows) {
    db.prepare(
      `UPDATE runtime_provisioning_task
       SET stage_status = 'pending',
           daemon_connection_id = NULL,
           stage_started_at = NULL,
           updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(now, row.id, row.workspace_id);
    appendRuntimeProvisioningEventRowSync(db, {
      taskId: row.id,
      stage: row.stage,
      status: "pending",
      progressPercent: readProgressSync(db, row.id),
      title: "Daemon offline: stage reclaimed",
      summary: `Stage ${row.stage} reclaimed because daemon ${daemonConnectionId} went offline`,
      severity: "warning",
      data: { daemonConnectionId, stage: row.stage },
    });
    reclaimed += 1;

    const hasRetriesRemaining = row.retry_count < row.max_retries;
    if (hasRetriesRemaining) {
      scheduleRuntimeProvisioningTaskRetrySync({
        id: row.id,
        workspaceId: row.workspace_id,
        stage: row.stage,
        errorCode: "provisioning.daemon_offline",
        errorMessage: `Daemon ${daemonConnectionId} went offline; retry scheduled`,
      });
      retried += 1;
    } else {
      markRuntimeProvisioningTaskFailedSync({
        id: row.id,
        workspaceId: row.workspace_id,
        stage: row.stage,
        errorCode: "provisioning.daemon_offline",
        errorMessage: `Daemon ${daemonConnectionId} went offline and no retries remain`,
        allowRetry: false,
      });
      failed += 1;
    }
  }

  return { reclaimed, retried, failed };
}

export function readRuntimeProvisioningTaskForDaemonSync(
  taskId: string,
  daemonConnectionId: string,
): RuntimeProvisioningTaskRecord | null {
  const row = getDatabase()
    .prepare(
      "SELECT * FROM runtime_provisioning_task WHERE id = ? AND daemon_connection_id = ?",
    )
    .get(taskId, daemonConnectionId) as RawRuntimeProvisioningTask | undefined;
  return row ? mapRuntimeProvisioningTask(row) : null;
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
  requested_name: string | null;
  requested_model: string | null;
  allowed_models_json: string;
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
  daemon_connection_id: string | null;
  stage_started_at: string | null;
  status: RuntimeProvisioningTaskStatus;
  timeouts_json: string;
  task_timeout_ms: number;
  next_retry_at: string | null;
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
    requestedName: row.requested_name ?? undefined,
    requestedModel: row.requested_model ?? undefined,
    allowedModels: normalizeModels(parseJsonArray(row.allowed_models_json)),
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
    daemonConnectionId: row.daemon_connection_id ?? undefined,
    stageStartedAt: row.stage_started_at ?? undefined,
    status: row.status,
    timeoutsJson: row.timeouts_json,
    taskTimeoutMs: row.task_timeout_ms,
    nextRetryAt: row.next_retry_at ?? undefined,
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

function normalizeModels(values: unknown[]): string[] {
  return normalizeProtocols(values);
}

function isManagedNodeMetadata(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).managedNode === true,
    );
  } catch {
    return false;
  }
}
