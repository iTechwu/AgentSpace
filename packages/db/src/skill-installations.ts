import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  SkillInstallationComponentKind,
  SkillInstallationComponentStatus,
  SkillInstallationOperationStatus,
  SkillInstallationOperationType,
  StoredSkillInstallationComponentRecord,
  StoredSkillInstallationOperationRecord,
  StoredSkillInstallationRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* Input interfaces                                                    */
/* ------------------------------------------------------------------ */

export interface SkillInstallationComponentInput {
  kind: SkillInstallationComponentKind;
  key: string;
  status?: SkillInstallationComponentStatus;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateSkillInstallationInput {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
  status?: string;
  resolvedLockJson?: string;
  revision?: string;
  previousReadyRevision?: string;
  previousReadyArtifactDigest?: string;
  components: SkillInstallationComponentInput[];
  createdAt?: string;
}

export interface CreateSkillInstallationOperationInput {
  workspaceId?: string;
  runtimeId: string;
  installationId: string;
  operation: SkillInstallationOperationType;
  requestedByUserId?: string;
  requestSnapshotJson?: string;
}

/* ------------------------------------------------------------------ */
/* Column selectors                                                    */
/* ------------------------------------------------------------------ */

const SKILL_INSTALLATION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId,
  artifact_digest AS artifactDigest, status, resolved_lock_json AS resolvedLockJson,
  prepared_path AS preparedPath, prepared_digest AS preparedDigest, health,
  previous_ready_revision AS previousReadyRevision,
  previous_ready_artifact_digest AS previousReadyArtifactDigest,
  revision, installed_at AS installedAt, verified_at AS verifiedAt,
  created_at AS createdAt, updated_at AS updatedAt`;

const SKILL_INSTALLATION_COMPONENT_COLUMNS = `SELECT
  id, installation_id AS installationId, kind, key, status,
  error_code AS errorCode, error_message AS errorMessage,
  last_operation_id AS lastOperationId, verified_at AS verifiedAt,
  updated_at AS updatedAt`;

const SKILL_INSTALLATION_OPERATION_COLUMNS = `SELECT
  id, workspace_id AS workspaceId, runtime_id AS runtimeId,
  installation_id AS installationId, operation, status,
  request_snapshot_json AS requestSnapshotJson, safe_result_json AS safeResultJson,
  error_code AS errorCode, error_message AS errorMessage,
  claimed_at AS claimedAt, completed_at AS completedAt,
  lease_expires_at,
  requested_by_user_id AS requestedByUserId, created_at AS createdAt`;

/* ------------------------------------------------------------------ */
/* Installations                                                       */
/* ------------------------------------------------------------------ */

/**
 * Create an installation (artifact × runtime) together with its component
 * rows. Idempotent by the release lock: re-creating the same (workspace,
 * runtime, artifact, revision) returns the existing record.
 */
export function createSkillInstallationSync(input: CreateSkillInstallationInput): StoredSkillInstallationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const revision = input.revision?.trim() || "v1";
  const existing = readSkillInstallationByLockSync({
    workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
    revision,
  });
  if (existing) {
    return existing;
  }

  const artifact = db.prepare(
    `SELECT digest FROM skill_artifact WHERE workspace_id = ? AND digest = ?`,
  ).get(workspaceId, input.artifactDigest) as { digest?: string } | undefined;
  if (!artifact) {
    throw new Error(`Skill artifact "${input.artifactDigest}" does not exist in this workspace.`);
  }
  const runtime = db.prepare(
    `SELECT id FROM agent_runtime WHERE id = ? AND workspace_id = ?`,
  ).get(input.runtimeId, workspaceId) as { id?: string } | undefined;
  if (!runtime) {
    throw new Error(`Runtime "${input.runtimeId}" does not exist in this workspace.`);
  }

  const id = `skill-install-${randomLikeId()}`;
  const now = input.createdAt ?? new Date().toISOString();
  const status = input.status ?? "preparing";

  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO skill_installation (
        id, workspace_id, runtime_id, artifact_digest, status, resolved_lock_json,
        prepared_path, health, previous_ready_revision, previous_ready_artifact_digest,
        revision, installed_at, verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      workspaceId,
      input.runtimeId,
      input.artifactDigest,
      status,
      input.resolvedLockJson ?? "{}",
      input.previousReadyRevision?.trim() || null,
      input.previousReadyArtifactDigest?.trim() || null,
      revision,
      now,
      now,
    );

    for (const component of input.components) {
      db.prepare(
        `INSERT INTO skill_installation_component (
          id, installation_id, kind, key, status, error_code, error_message, last_operation_id, verified_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        `skill-install-comp-${randomLikeId()}`,
        id,
        component.kind,
        component.key,
        component.status ?? "pending",
        component.errorCode ?? null,
        component.errorMessage ?? null,
        now,
      );
    }
  });

  const record = readSkillInstallationSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to persist skill installation.");
  }
  return record;
}

export function readSkillInstallationSync(
  id: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredSkillInstallationRecord | null {
  const row = getDatabase().prepare(
    `${SKILL_INSTALLATION_COLUMNS} FROM skill_installation WHERE id = ? AND workspace_id = ?`,
  ).get(id, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapSkillInstallationRecord(row) : null;
}

export function readSkillInstallationByLockSync(input: {
  workspaceId?: string;
  runtimeId: string;
  artifactDigest: string;
  revision: string;
}): StoredSkillInstallationRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `${SKILL_INSTALLATION_COLUMNS} FROM skill_installation
     WHERE workspace_id = ? AND runtime_id = ? AND artifact_digest = ? AND revision = ?`,
  ).get(workspaceId, input.runtimeId, input.artifactDigest, input.revision) as Record<string, unknown> | undefined;
  return row ? mapSkillInstallationRecord(row) : null;
}

export function listSkillInstallationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  artifactDigest?: string;
  status?: string;
  limit?: number;
} = {}): StoredSkillInstallationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.artifactDigest) {
    where.push("artifact_digest = ?");
    params.push(options.artifactDigest);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${SKILL_INSTALLATION_COLUMNS} FROM skill_installation
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapSkillInstallationRecord).filter((r): r is StoredSkillInstallationRecord => r !== null);
}

export function setSkillInstallationStatusSync(input: {
  installationId: string;
  workspaceId?: string;
  status: string;
  health?: string;
  verifiedAt?: string;
  updatedAt?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const sets = ["status = ?"];
  const params: unknown[] = [input.status];
  if (input.health) {
    sets.push("health = ?");
    params.push(input.health);
  }
  if (input.verifiedAt) {
    sets.push("verified_at = ?");
    params.push(input.verifiedAt);
  }
  params.push(input.updatedAt ?? new Date().toISOString(), input.installationId, workspaceId);
  const result = db.prepare(
    `UPDATE skill_installation SET ${sets.join(", ")}, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(...params);
  return result.changes > 0;
}

export function setSkillInstallationPreparedPathSync(input: {
  installationId: string;
  workspaceId?: string;
  preparedPath?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = db.prepare(
    `UPDATE skill_installation SET prepared_path = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(input.preparedPath ?? null, new Date().toISOString(), input.installationId, workspaceId);
  return result.changes > 0;
}

export function setSkillInstallationPreparedDigestSync(input: {
  installationId: string;
  workspaceId?: string;
  preparedDigest?: string;
}): boolean {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = db.prepare(
    `UPDATE skill_installation SET prepared_digest = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(input.preparedDigest ?? null, new Date().toISOString(), input.installationId, workspaceId);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Installable runtimes                                                */
/* ------------------------------------------------------------------ */

export interface InstallableRuntimeRow {
  id: string;
  name: string;
  provider: string;
  status: string;
  provisioningState?: string;
}

/** Runtimes in a workspace that a skill installation may target. */
export function listInstallableRuntimesForWorkspaceSync(
  workspaceId = DEFAULT_WORKSPACE_ID,
): InstallableRuntimeRow[] {
  const rows = getDatabase().prepare(
    `SELECT id, name, provider, status, provisioning_state AS provisioningState
     FROM agent_runtime WHERE workspace_id = ? ORDER BY name ASC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows
    .filter((row) => typeof row.id === "string" && typeof row.name === "string" && typeof row.provider === "string" && typeof row.status === "string")
    .map((row) => ({
      id: row.id as string,
      name: row.name as string,
      provider: row.provider as string,
      status: row.status as string,
      provisioningState: typeof row.provisioningState === "string" ? (row.provisioningState as string) : undefined,
    }));
}

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export function readSkillInstallationComponentsSync(
  installationId: string,
): StoredSkillInstallationComponentRecord[] {
  const rows = getDatabase().prepare(
    `${SKILL_INSTALLATION_COMPONENT_COLUMNS} FROM skill_installation_component
     WHERE installation_id = ? ORDER BY kind ASC, key ASC`,
  ).all(installationId) as Array<Record<string, unknown>>;
  return rows.map(mapSkillInstallationComponentRecord).filter((r): r is StoredSkillInstallationComponentRecord => r !== null);
}

export function updateSkillInstallationComponentStatusSync(input: {
  installationId: string;
  kind: SkillInstallationComponentKind;
  key: string;
  status: SkillInstallationComponentStatus;
  errorCode?: string;
  errorMessage?: string;
  verifiedAt?: string;
  lastOperationId?: string;
}): boolean {
  const db = getDatabase();
  const sets = ["status = ?", "error_code = ?", "error_message = ?", "updated_at = ?"];
  const params: unknown[] = [
    input.status,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    new Date().toISOString(),
  ];
  if (input.verifiedAt) {
    sets.push("verified_at = ?");
    params.push(input.verifiedAt);
  }
  if (input.lastOperationId) {
    sets.push("last_operation_id = ?");
    params.push(input.lastOperationId);
  }
  params.push(input.installationId, input.kind, input.key);
  const result = db.prepare(
    `UPDATE skill_installation_component SET ${sets.join(", ")}
     WHERE installation_id = ? AND kind = ? AND key = ?`,
  ).run(...params);
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export function createSkillInstallationOperationSync(
  input: CreateSkillInstallationOperationInput,
): StoredSkillInstallationOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `skill-op-${randomLikeId()}`;
  const installation = db.prepare(
    `SELECT id FROM skill_installation WHERE id = ? AND workspace_id = ? AND runtime_id = ?`,
  ).get(input.installationId, workspaceId, input.runtimeId) as { id?: string } | undefined;
  if (!installation) {
    throw new Error(`Skill installation "${input.installationId}" does not exist on runtime "${input.runtimeId}" in this workspace.`);
  }
  db.prepare(
    `INSERT INTO skill_installation_operation (
      id, workspace_id, runtime_id, installation_id, operation, status,
      request_snapshot_json, safe_result_json, error_code, error_message,
      claimed_at, completed_at, requested_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '{}', NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.installationId,
    input.operation,
    input.requestSnapshotJson ?? "{}",
    input.requestedByUserId ?? null,
    now,
  );
  const record = readSkillInstallationOperationSync(id, workspaceId);
  if (!record) {
    throw new Error("Failed to create skill installation operation.");
  }
  return record;
}

export function readSkillInstallationOperationSync(
  operationId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): StoredSkillInstallationOperationRecord | null {
  const row = getDatabase().prepare(
    `${SKILL_INSTALLATION_OPERATION_COLUMNS} FROM skill_installation_operation WHERE id = ? AND workspace_id = ?`,
  ).get(operationId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapSkillInstallationOperationRecord(row) : null;
}

export function listSkillInstallationOperationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  installationId?: string;
  status?: SkillInstallationOperationStatus;
  limit?: number;
} = {}): StoredSkillInstallationOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.installationId) {
    where.push("installation_id = ?");
    params.push(options.installationId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `${SKILL_INSTALLATION_OPERATION_COLUMNS} FROM skill_installation_operation
     WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapSkillInstallationOperationRecord).filter((r): r is StoredSkillInstallationOperationRecord => r !== null);
}

/**
 * Fences unfinished operations for an installation (used on upgrade/rollback).
 */
export function cancelUnfinishedSkillInstallationOperationsSync(input: {
  installationId: string;
  workspaceId?: string;
}): number {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation
     SET status = 'cancelled', completed_at = COALESCE(completed_at, ?)
     WHERE installation_id = ? AND workspace_id = ? AND status IN ('pending', 'claimed', 'running')`,
  ).run(new Date().toISOString(), input.installationId, workspaceId);
  return result.changes;
}

/** Lease duration for a claimed skill installation operation; the daemon heartbeats to renew. */
export const SKILL_OPERATION_LEASE_SECONDS = 120;

function leaseExpiryIso(now: Date): string {
  return new Date(now.getTime() + SKILL_OPERATION_LEASE_SECONDS * 1000).toISOString();
}

export function claimNextSkillInstallationOperationForRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
  now?: Date;
}): StoredSkillInstallationOperationRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  let claimedId: string | null = null;
  withTransaction(db, () => {
    const row = db.prepare(
      `SELECT id FROM skill_installation_operation
       WHERE workspace_id = ? AND runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT 1`,
    ).get(workspaceId, input.runtimeId) as { id?: string } | undefined;
    if (typeof row?.id !== "string") {
      return;
    }
    const result = db.prepare(
      `UPDATE skill_installation_operation
       SET status = 'claimed', claimed_at = COALESCE(claimed_at, ?), lease_expires_at = ?
       WHERE id = ? AND status = 'pending'`,
    ).run(now.toISOString(), leaseExpiryIso(now), row.id);
    if (result.changes > 0) {
      claimedId = row.id;
    }
  });
  return claimedId ? readSkillInstallationOperationSync(claimedId, workspaceId) : null;
}

export function startSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation
     SET status = 'running', lease_expires_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'claimed' AND lease_expires_at > ?`,
  ).run(leaseExpiryIso(now), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

/**
 * Heartbeat: extends the lease while the daemon is still executing. Returns false
 * when the lease was already lost (expired + re-queued) — the daemon must abort.
 */
export function renewSkillInstallationOperationLeaseSync(input: {
  operationId: string;
  workspaceId?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation SET lease_expires_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(leaseExpiryIso(now), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

/**
 * Crash recovery: re-queues operations whose lease expired while claimed/running
 * (the daemon crashed without completing). Returns the number of re-queued ops.
 */
export function requeueExpiredSkillInstallationOperationLeasesSync(input?: {
  workspaceId?: string;
  now?: Date;
}): number {
  const now = (input?.now ?? new Date()).toISOString();
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation
     SET status = 'pending', claimed_at = NULL, lease_expires_at = NULL
     WHERE workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at < ?`,
  ).run(workspaceId, now);
  return result.changes;
}

export function completeSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  safeResultJson?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation
     SET status = 'succeeded', safe_result_json = ?, error_code = NULL, error_message = NULL,
         completed_at = ?, lease_expires_at = NULL
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(input.safeResultJson ?? "{}", now.toISOString(), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

export function failSkillInstallationOperationSync(input: {
  operationId: string;
  workspaceId?: string;
  errorCode?: string;
  errorMessage?: string;
  now?: Date;
}): boolean {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = input.now ?? new Date();
  const result = getDatabase().prepare(
    `UPDATE skill_installation_operation
     SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, lease_expires_at = NULL
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed', 'running') AND lease_expires_at > ?`,
  ).run(input.errorCode ?? null, input.errorMessage ?? null, now.toISOString(), input.operationId, workspaceId, now.toISOString());
  return result.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Mappers                                                             */
/* ------------------------------------------------------------------ */

function mapSkillInstallationRecord(value: Record<string, unknown>): StoredSkillInstallationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.artifactDigest !== "string" ||
    typeof value.status !== "string" ||
    typeof value.resolvedLockJson !== "string" ||
    typeof value.health !== "string" ||
    typeof value.revision !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    artifactDigest: value.artifactDigest,
    status: value.status,
    resolvedLockJson: value.resolvedLockJson,
    preparedPath: readOptionalString(value.preparedPath),
    preparedDigest: readOptionalString(value.preparedDigest),
    health: value.health,
    previousReadyRevision: readOptionalString(value.previousReadyRevision),
    previousReadyArtifactDigest: readOptionalString(value.previousReadyArtifactDigest),
    revision: value.revision,
    installedAt: readOptionalString(value.installedAt),
    verifiedAt: readOptionalString(value.verifiedAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapSkillInstallationComponentRecord(
  value: Record<string, unknown>,
): StoredSkillInstallationComponentRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.key !== "string" ||
    typeof value.status !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    installationId: value.installationId,
    kind: value.kind as StoredSkillInstallationComponentRecord["kind"],
    key: value.key,
    status: value.status as StoredSkillInstallationComponentRecord["status"],
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    lastOperationId: readOptionalString(value.lastOperationId),
    verifiedAt: readOptionalString(value.verifiedAt),
    updatedAt: value.updatedAt,
  };
}

function mapSkillInstallationOperationRecord(
  value: Record<string, unknown>,
): StoredSkillInstallationOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.status !== "string" ||
    typeof value.requestSnapshotJson !== "string" ||
    typeof value.safeResultJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    installationId: value.installationId,
    operation: value.operation as StoredSkillInstallationOperationRecord["operation"],
    status: value.status as StoredSkillInstallationOperationRecord["status"],
    requestSnapshotJson: value.requestSnapshotJson,
    safeResultJson: value.safeResultJson,
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    claimedAt: readOptionalString(value.claimedAt),
    completedAt: readOptionalString(value.completedAt),
    leaseExpiresAt: readOptionalString(value.leaseExpiresAt),
    requestedByUserId: readOptionalString(value.requestedByUserId),
    createdAt: value.createdAt,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
