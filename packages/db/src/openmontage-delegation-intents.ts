import { getDatabase } from "./database.ts";

export type OpenMontageDelegationIntentStatus =
  | "creating"
  | "provisioned"
  | "drain_pending"
  | "drained"
  | "bound";

export interface OpenMontageDelegationIntentRecord {
  idempotencyKey: string;
  workspaceId: string;
  runtimeId: string;
  mcpConnectionId: string;
  runtimeCredentialId: string;
  modelsTenantId: string;
  modelsTeamId: string;
  externalJobId: string;
  request: Record<string, unknown>;
  delegationId?: string;
  secretRef?: string;
  status: OpenMontageDelegationIntentStatus;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOpenMontageDelegationIntentInput {
  idempotencyKey: string;
  workspaceId: string;
  runtimeId: string;
  mcpConnectionId: string;
  runtimeCredentialId: string;
  modelsTenantId: string;
  modelsTeamId: string;
  externalJobId: string;
  request: Record<string, unknown>;
  recoveryAfter?: string;
  now?: string;
}

export function createOpenMontageDelegationIntentSync(
  input: CreateOpenMontageDelegationIntentInput,
): OpenMontageDelegationIntentRecord {
  assertRequestScope(input.request, input);
  assertNoSecrets(input.request);
  const now = input.now ?? new Date().toISOString();
  const recoveryAfter = input.recoveryAfter ?? new Date(Date.parse(now) + 5 * 60_000).toISOString();
  const db = getDatabase();
  db.prepare(
    `INSERT INTO openmontage_delegation_intent (
       idempotency_key, workspace_id, runtime_id, mcp_connection_id,
       runtime_credential_id, models_tenant_id, models_team_id, external_job_id,
       request_json, status, attempt_count, next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', 0, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
  ).run(
    input.idempotencyKey,
    input.workspaceId,
    input.runtimeId,
    input.mcpConnectionId,
    input.runtimeCredentialId,
    input.modelsTenantId,
    input.modelsTeamId,
    input.externalJobId,
    JSON.stringify(input.request),
    recoveryAfter,
    now,
    now,
  );
  const record = readOpenMontageDelegationIntentSync(input.idempotencyKey);
  if (!record) throw new Error("openmontage.delegation_intent_not_persisted");
  assertIntentMatches(record, input);
  return record;
}

export function readOpenMontageDelegationIntentSync(
  idempotencyKey: string,
): OpenMontageDelegationIntentRecord | null {
  const row = getDatabase().prepare(
    `${intentSelect()} WHERE idempotency_key = ?`,
  ).get(idempotencyKey) as Record<string, unknown> | undefined;
  return row ? mapIntent(row) : null;
}

export function listDueOpenMontageDelegationIntentsSync(input: {
  limit?: number;
  now?: string;
} = {}): OpenMontageDelegationIntentRecord[] {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  const now = input.now ?? new Date().toISOString();
  const rows = getDatabase().prepare(
    `${intentSelect()}
      WHERE status IN ('creating', 'provisioned', 'drain_pending')
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, created_at ASC
      LIMIT ?`,
  ).all(now, limit) as Array<Record<string, unknown>>;
  return rows.map(mapIntent);
}

export function markOpenMontageDelegationIntentProvisionedSync(input: {
  idempotencyKey: string;
  delegationId: string;
  secretRef?: string;
  recoveryAfter?: string;
  now?: string;
}): OpenMontageDelegationIntentRecord {
  const now = input.now ?? new Date().toISOString();
  const recoveryAfter = input.recoveryAfter ?? new Date(Date.parse(now) + 5 * 60_000).toISOString();
  return updateIntent(input.idempotencyKey, {
    status: "provisioned",
    delegationId: input.delegationId,
    secretRef: input.secretRef,
    nextAttemptAt: recoveryAfter,
    lastError: null,
    now,
  });
}

export function markOpenMontageDelegationIntentBoundSync(
  idempotencyKey: string,
  now = new Date().toISOString(),
): OpenMontageDelegationIntentRecord {
  return updateIntent(idempotencyKey, {
    status: "bound",
    nextAttemptAt: null,
    lastError: null,
    now,
  });
}

export function markOpenMontageDelegationIntentDrainPendingSync(input: {
  idempotencyKey: string;
  error?: string;
  now?: string;
}): OpenMontageDelegationIntentRecord {
  const now = input.now ?? new Date().toISOString();
  return updateIntent(input.idempotencyKey, {
    status: "drain_pending",
    nextAttemptAt: now,
    lastError: input.error ?? null,
    now,
  });
}

export function markOpenMontageDelegationIntentDrainFailedSync(input: {
  idempotencyKey: string;
  error: string;
  retryAt?: string;
  now?: string;
}): OpenMontageDelegationIntentRecord {
  const now = input.now ?? new Date().toISOString();
  const retryAt = input.retryAt ?? new Date(Date.parse(now) + 60_000).toISOString();
  const db = getDatabase();
  db.prepare(
    `UPDATE openmontage_delegation_intent
        SET status = 'drain_pending', attempt_count = attempt_count + 1,
            next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE idempotency_key = ? AND status NOT IN ('bound', 'drained')`,
  ).run(retryAt, input.error, now, input.idempotencyKey);
  return requireIntent(input.idempotencyKey);
}

export function markOpenMontageDelegationIntentDrainedSync(
  idempotencyKey: string,
  now = new Date().toISOString(),
): OpenMontageDelegationIntentRecord {
  return updateIntent(idempotencyKey, {
    status: "drained",
    nextAttemptAt: null,
    lastError: null,
    now,
  });
}

export function listUnresolvedOpenMontageDelegationIntentIdsSync(input: {
  workspaceId: string;
  targetType: "runtime" | "mcp_connection";
  targetId: string;
}): string[] {
  const column = input.targetType === "runtime" ? "runtime_id" : "mcp_connection_id";
  const rows = getDatabase().prepare(
    `SELECT idempotency_key AS "idempotencyKey"
       FROM openmontage_delegation_intent
      WHERE workspace_id = ? AND ${column} = ?
        AND status NOT IN ('bound', 'drained')
      ORDER BY created_at ASC`,
  ).all(input.workspaceId, input.targetId) as Array<{ idempotencyKey?: unknown }>;
  return rows.map((row) => String(row.idempotencyKey));
}

function updateIntent(
  idempotencyKey: string,
  input: {
    status: OpenMontageDelegationIntentStatus;
    delegationId?: string;
    secretRef?: string;
    nextAttemptAt: string | null;
    lastError: string | null;
    now: string;
  },
): OpenMontageDelegationIntentRecord {
  getDatabase().prepare(
    `UPDATE openmontage_delegation_intent
        SET status = ?, delegation_id = COALESCE(?, delegation_id),
            secret_ref = COALESCE(?, secret_ref), next_attempt_at = ?,
            last_error = ?, updated_at = ?
      WHERE idempotency_key = ?
        AND CASE
          WHEN ? IN ('provisioned', 'drain_pending') THEN status NOT IN ('bound', 'drained')
          WHEN ? = 'bound' THEN status <> 'drained'
          WHEN ? = 'drained' THEN status <> 'bound'
          ELSE TRUE
        END`,
  ).run(
    input.status,
    input.delegationId ?? null,
    input.secretRef ?? null,
    input.nextAttemptAt,
    input.lastError,
    input.now,
    idempotencyKey,
    input.status,
    input.status,
    input.status,
  );
  return requireIntent(idempotencyKey);
}

function requireIntent(idempotencyKey: string): OpenMontageDelegationIntentRecord {
  const record = readOpenMontageDelegationIntentSync(idempotencyKey);
  if (!record) throw new Error("openmontage.delegation_intent_not_found");
  return record;
}

function assertIntentMatches(
  existing: OpenMontageDelegationIntentRecord,
  input: CreateOpenMontageDelegationIntentInput,
): void {
  const actual = canonicalJson([
    existing.workspaceId,
    existing.runtimeId,
    existing.mcpConnectionId,
    existing.runtimeCredentialId,
    existing.modelsTenantId,
    existing.modelsTeamId,
    existing.externalJobId,
    existing.request,
  ]);
  const expected = canonicalJson([
    input.workspaceId,
    input.runtimeId,
    input.mcpConnectionId,
    input.runtimeCredentialId,
    input.modelsTenantId,
    input.modelsTeamId,
    input.externalJobId,
    input.request,
  ]);
  if (actual !== expected) throw new Error("openmontage.delegation_intent_conflict");
}

function assertRequestScope(
  request: Record<string, unknown>,
  input: CreateOpenMontageDelegationIntentInput,
): void {
  const matches =
    request.idempotencyKey === input.idempotencyKey
    && request.runtimeCredentialId === input.runtimeCredentialId
    && request.tenantId === input.modelsTenantId
    && request.teamId === input.modelsTeamId
    && request.externalJobId === input.externalJobId
    && request.sourceService === "openmontage";
  if (!matches) throw new Error("openmontage.delegation_intent_request_scope_mismatch");
}

function assertNoSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSecrets);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (["apikey", "authorization", "secret", "secretkey", "token"].includes(key.toLowerCase())) {
      throw new Error("openmontage.delegation_intent_contains_secret");
    }
    assertNoSecrets(child);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function intentSelect(): string {
  return `SELECT idempotency_key AS "idempotencyKey", workspace_id AS "workspaceId",
    runtime_id AS "runtimeId", mcp_connection_id AS "mcpConnectionId",
    runtime_credential_id AS "runtimeCredentialId", models_tenant_id AS "modelsTenantId",
    models_team_id AS "modelsTeamId", external_job_id AS "externalJobId",
    request_json AS "requestJson", delegation_id AS "delegationId", secret_ref AS "secretRef",
    status, attempt_count AS "attemptCount", next_attempt_at AS "nextAttemptAt",
    last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM openmontage_delegation_intent`;
}

function mapIntent(row: Record<string, unknown>): OpenMontageDelegationIntentRecord {
  const requestValue = row.requestJson;
  return {
    idempotencyKey: String(row.idempotencyKey),
    workspaceId: String(row.workspaceId),
    runtimeId: String(row.runtimeId),
    mcpConnectionId: String(row.mcpConnectionId),
    runtimeCredentialId: String(row.runtimeCredentialId),
    modelsTenantId: String(row.modelsTenantId),
    modelsTeamId: String(row.modelsTeamId),
    externalJobId: String(row.externalJobId),
    request: typeof requestValue === "string"
      ? JSON.parse(requestValue) as Record<string, unknown>
      : requestValue as Record<string, unknown>,
    delegationId: typeof row.delegationId === "string" ? row.delegationId : undefined,
    secretRef: typeof row.secretRef === "string" ? row.secretRef : undefined,
    status: String(row.status) as OpenMontageDelegationIntentStatus,
    attemptCount: Number(row.attemptCount),
    nextAttemptAt: typeof row.nextAttemptAt === "string" ? row.nextAttemptAt : undefined,
    lastError: typeof row.lastError === "string" ? row.lastError : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}
