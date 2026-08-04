import { DEFAULT_WORKSPACE_ID, getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  RuntimeAppCatalogItemRecord,
  RuntimeAppCatalogSource,
  RuntimeAppOperationRecord,
  RuntimeAppOperationStage,
  RuntimeAppOperationStatus,
  RuntimeAppOperationType,
  RuntimeAppSkillBindingRecord,
  RuntimeInstalledAppRecord,
} from "./types.ts";

export interface UpsertRuntimeAppCatalogItemInput {
  source: RuntimeAppCatalogSource;
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  category?: string;
  entryPoint?: string;
  installStrategy?: RuntimeAppCatalogItemRecord["installStrategy"];
  installCmd?: string;
  uninstallCmd?: string;
  updateCmd?: string;
  skillMd?: string;
  requiresText?: string;
  homepage?: string;
  registryJson?: string;
  syncedAt?: string;
}

export interface CreateRuntimeAppOperationInput {
  workspaceId?: string;
  runtimeId: string;
  appSource: RuntimeAppCatalogSource;
  appName: string;
  operation: RuntimeAppOperationType;
  requestedByUserId?: string;
  commandPlanJson: string;
}

export interface CompleteRuntimeAppOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  installedApp?: {
    displayName: string;
    version?: string;
    entryPoint?: string;
    installStrategy?: RuntimeInstalledAppRecord["installStrategy"];
    metadataJson?: string;
  };
}

export interface FailRuntimeAppOperationInput {
  operationId: string;
  workspaceId?: string;
  safeStdoutTail?: string;
  safeStderrTail?: string;
  errorCode?: string;
  errorMessage: string;
}

export function upsertRuntimeAppCatalogItemsSync(items: UpsertRuntimeAppCatalogItemInput[]): number {
  if (items.length === 0) {
    return 0;
  }
  const db = getDatabase();
  let changed = 0;
  withTransaction(db, () => {
    for (const item of items) {
      const source = normalizeSource(item.source);
      const name = item.name.trim();
      const displayName = item.displayName.trim() || name;
      if (!source || !name) {
        continue;
      }
      const result = db.prepare(
        `INSERT INTO runtime_app_catalog_item (
          source,
          name,
          display_name,
          description,
          version,
          category,
          entry_point,
          install_strategy,
          install_cmd,
          uninstall_cmd,
          update_cmd,
          skill_md,
          requires_text,
          homepage,
          registry_json,
          synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, name) DO UPDATE SET
          display_name = excluded.display_name,
          description = excluded.description,
          version = excluded.version,
          category = excluded.category,
          entry_point = excluded.entry_point,
          install_strategy = excluded.install_strategy,
          install_cmd = excluded.install_cmd,
          uninstall_cmd = excluded.uninstall_cmd,
          update_cmd = excluded.update_cmd,
          skill_md = excluded.skill_md,
          requires_text = excluded.requires_text,
          homepage = excluded.homepage,
          registry_json = excluded.registry_json,
          synced_at = excluded.synced_at`,
      ).run(
        source,
        name,
        displayName,
        item.description?.trim() ?? "",
        item.version?.trim() ?? "",
        item.category?.trim() ?? "",
        item.entryPoint?.trim() ?? "",
        item.installStrategy ?? "",
        normalizeOptionalText(item.installCmd),
        normalizeOptionalText(item.uninstallCmd),
        normalizeOptionalText(item.updateCmd),
        normalizeOptionalText(item.skillMd),
        normalizeOptionalText(item.requiresText),
        normalizeOptionalText(item.homepage),
        item.registryJson ?? "{}",
        item.syncedAt ?? new Date().toISOString(),
      );
      changed += result.changes;
    }
  });
  return changed;
}

export function listRuntimeAppCatalogItemsSync(options?: {
  source?: RuntimeAppCatalogSource;
  query?: string;
  category?: string;
  limit?: number;
}): RuntimeAppCatalogItemRecord[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options?.source) {
    where.push("source = ?");
    params.push(options.source);
  }
  if (options?.category?.trim()) {
    where.push("category = ?");
    params.push(options.category.trim());
  }
  if (options?.query?.trim()) {
    const query = `%${options.query.trim().toLocaleLowerCase("en-US")}%`;
    where.push("(LOWER(name) LIKE ? OR LOWER(display_name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(query, query, query);
  }
  const limit = Math.max(1, Math.min(options?.limit ?? 500, 1000));
  const rows = db.prepare(
    `SELECT
      source,
      name,
      display_name AS displayName,
      description,
      version,
      category,
      entry_point AS entryPoint,
      install_strategy AS installStrategy,
      install_cmd AS installCmd,
      uninstall_cmd AS uninstallCmd,
      update_cmd AS updateCmd,
      skill_md AS skillMd,
      requires_text AS requiresText,
      homepage,
      registry_json AS registryJson,
      synced_at AS syncedAt
     FROM runtime_app_catalog_item
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY category ASC, display_name ASC, source ASC, name ASC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeAppCatalogItemRecord).filter((row): row is RuntimeAppCatalogItemRecord => row !== null);
}

export function readRuntimeAppCatalogItemSync(
  source: RuntimeAppCatalogSource,
  name: string,
): RuntimeAppCatalogItemRecord | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT
      source,
      name,
      display_name AS displayName,
      description,
      version,
      category,
      entry_point AS entryPoint,
      install_strategy AS installStrategy,
      install_cmd AS installCmd,
      uninstall_cmd AS uninstallCmd,
      update_cmd AS updateCmd,
      skill_md AS skillMd,
      requires_text AS requiresText,
      homepage,
      registry_json AS registryJson,
      synced_at AS syncedAt
     FROM runtime_app_catalog_item
     WHERE source = ? AND name = ?`,
  ).get(source, name.trim()) as Record<string, unknown> | undefined;
  return row ? mapRuntimeAppCatalogItemRecord(row) : null;
}

export function readRuntimeAppCatalogHealthSync(): {
  itemCount: number;
  lastSyncedAt?: string;
  stale: boolean;
} {
  const row = getDatabase().prepare(
    `SELECT COUNT(*)::int AS itemCount, MAX(synced_at) AS lastSyncedAt
     FROM runtime_app_catalog_item`,
  ).get() as Record<string, unknown> | undefined;
  const itemCount = typeof row?.itemCount === "number" ? row.itemCount : 0;
  const lastSyncedAt = typeof row?.lastSyncedAt === "string" ? row.lastSyncedAt : undefined;
  const ageMs = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() : Number.POSITIVE_INFINITY;
  return {
    itemCount,
    lastSyncedAt,
    stale: itemCount === 0 || !Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000,
  };
}

export function listRuntimeInstalledAppsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  enabledOnly?: boolean;
} = {}): RuntimeInstalledAppRecord[] {
  const db = getDatabase();
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.enabledOnly) {
    where.push("enabled = 1");
    where.push("status = 'installed'");
  }
  const rows = db.prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      runtime_id AS runtimeId,
      source,
      name,
      display_name AS displayName,
      version,
      entry_point AS entryPoint,
      status,
      install_strategy AS installStrategy,
      enabled,
      installed_by_user_id AS installedByUserId,
      installed_at AS installedAt,
      updated_at AS updatedAt,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      metadata_json AS metadataJson
     FROM runtime_installed_app
     WHERE ${where.join(" AND ")}
     ORDER BY display_name ASC, name ASC`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeInstalledAppRecord).filter((row): row is RuntimeInstalledAppRecord => row !== null);
}

export function readRuntimeInstalledAppSync(input: {
  workspaceId?: string;
  runtimeId: string;
  source: RuntimeAppCatalogSource;
  name: string;
}): RuntimeInstalledAppRecord | null {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      runtime_id AS runtimeId,
      source,
      name,
      display_name AS displayName,
      version,
      entry_point AS entryPoint,
      status,
      install_strategy AS installStrategy,
      enabled,
      installed_by_user_id AS installedByUserId,
      installed_at AS installedAt,
      updated_at AS updatedAt,
      last_checked_at AS lastCheckedAt,
      last_error AS lastError,
      metadata_json AS metadataJson
     FROM runtime_installed_app
     WHERE workspace_id = ? AND runtime_id = ? AND source = ? AND name = ?`,
  ).get(workspaceId, input.runtimeId, input.source, input.name.trim()) as Record<string, unknown> | undefined;
  return row ? mapRuntimeInstalledAppRecord(row) : null;
}

export function createRuntimeAppOperationSync(input: CreateRuntimeAppOperationInput): RuntimeAppOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const id = `runtime-app-op-${randomLikeId()}`;
  const runtime = db.prepare(
    `SELECT id FROM agent_runtime WHERE id = ? AND workspace_id = ?`,
  ).get(input.runtimeId, workspaceId);
  if (!runtime) {
    throw new Error(`Runtime "${input.runtimeId}" does not exist.`);
  }
  db.prepare(
    `INSERT INTO runtime_app_operation (
      id,
      workspace_id,
      runtime_id,
      app_source,
      app_name,
      operation,
      status,
      requested_by_user_id,
      command_plan_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    workspaceId,
    input.runtimeId,
    input.appSource,
    input.appName.trim(),
    input.operation,
    input.requestedByUserId ?? null,
    input.commandPlanJson,
    now,
  );
  const operation = readRuntimeAppOperationSync(id, workspaceId);
  if (!operation) {
    throw new Error("Failed to create runtime app operation.");
  }
  return operation;
}

export function readRuntimeAppOperationSync(
  operationId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): RuntimeAppOperationRecord | null {
  const row = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      runtime_id AS runtimeId,
      app_source AS appSource,
      app_name AS appName,
      operation,
      status,
      stage,
      failed_stage AS failedStage,
      stage_updated_at AS stageUpdatedAt,
      requested_by_user_id AS requestedByUserId,
      command_plan_json AS commandPlanJson,
      safe_stdout_tail AS safeStdoutTail,
      safe_stderr_tail AS safeStderrTail,
      error_code AS errorCode,
      error_message AS errorMessage,
      created_at AS createdAt,
      started_at AS startedAt,
      completed_at AS completedAt
     FROM runtime_app_operation
     WHERE id = ? AND workspace_id = ?`,
  ).get(operationId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRuntimeAppOperationRecord(row) : null;
}

export function listRuntimeAppOperationsSync(options: {
  workspaceId?: string;
  runtimeId?: string;
  status?: RuntimeAppOperationStatus;
  limit?: number;
} = {}): RuntimeAppOperationRecord[] {
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const where = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (options.runtimeId) {
    where.push("runtime_id = ?");
    params.push(options.runtimeId);
  }
  if (options.status) {
    where.push("status = ?");
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = getDatabase().prepare(
    `SELECT
      id,
      workspace_id AS workspaceId,
      runtime_id AS runtimeId,
      app_source AS appSource,
      app_name AS appName,
      operation,
      status,
      stage,
      failed_stage AS failedStage,
      stage_updated_at AS stageUpdatedAt,
      requested_by_user_id AS requestedByUserId,
      command_plan_json AS commandPlanJson,
      safe_stdout_tail AS safeStdoutTail,
      safe_stderr_tail AS safeStderrTail,
      error_code AS errorCode,
      error_message AS errorMessage,
      created_at AS createdAt,
      started_at AS startedAt,
      completed_at AS completedAt
     FROM runtime_app_operation
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeAppOperationRecord).filter((row): row is RuntimeAppOperationRecord => row !== null);
}

export function claimNextRuntimeAppOperationForRuntimeSync(input: {
  workspaceId?: string;
  runtimeId: string;
}): RuntimeAppOperationRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let claimedId: string | null = null;
  withTransaction(db, () => {
    const row = db.prepare(
      `SELECT id
       FROM runtime_app_operation
       WHERE workspace_id = ? AND runtime_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    ).get(workspaceId, input.runtimeId) as Record<string, unknown> | undefined;
    if (typeof row?.id !== "string") {
      return;
    }
    const result = db.prepare(
      `UPDATE runtime_app_operation
       SET status = 'claimed'
       WHERE id = ? AND status = 'pending'`,
    ).run(row.id);
    if (result.changes > 0) {
      claimedId = row.id;
    }
  });
  if (!claimedId) {
    return null;
  }
  const claimed = readRuntimeAppOperationSync(claimedId, workspaceId);
  if (claimed) {
    upsertRuntimeInstalledAppFromOperationSync(claimed, {
      status: claimed.operation === "uninstall" ? "installing" : "installing",
      updatedAt: now,
    });
  }
  return claimed;
}

export function startRuntimeAppOperationSync(operationId: string, workspaceId = DEFAULT_WORKSPACE_ID): RuntimeAppOperationRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE runtime_app_operation
     SET status = 'running',
         stage = 'installing',
         stage_updated_at = ?,
         started_at = COALESCE(started_at, ?)
     WHERE id = ? AND workspace_id = ? AND status IN ('pending', 'claimed')`,
  ).run(now, now, operationId, workspaceId);
  const operation = readRuntimeAppOperationSync(operationId, workspaceId);
  if (!operation) {
    throw new Error(`Runtime app operation "${operationId}" does not exist.`);
  }
  return operation;
}

export function updateRuntimeAppOperationStageSync(input: {
  operationId: string;
  workspaceId?: string;
  stage: Exclude<RuntimeAppOperationStage, "queued" | "completed">;
}): RuntimeAppOperationRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  const allowedCurrentStages: Record<typeof input.stage, RuntimeAppOperationStage[]> = {
    installing: ["installing"],
    verifying: ["installing", "verifying"],
    finalizing: ["installing", "verifying", "finalizing"],
  };
  const currentStages = allowedCurrentStages[input.stage];
  const placeholders = currentStages.map(() => "?").join(", ");
  const result = getDatabase().prepare(
    `UPDATE runtime_app_operation
     SET stage = ?, stage_updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'running' AND stage IN (${placeholders})`,
  ).run(input.stage, now, input.operationId, workspaceId, ...currentStages);
  const operation = readRuntimeAppOperationSync(input.operationId, workspaceId);
  if (!operation) {
    throw new Error(`Runtime app operation "${input.operationId}" does not exist.`);
  }
  if (result.changes === 0 && operation.stage !== input.stage) {
    throw new Error("runtime_app.stage_transition_invalid");
  }
  return operation;
}

export function completeRuntimeAppOperationSync(input: CompleteRuntimeAppOperationInput): RuntimeAppOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let completed: RuntimeAppOperationRecord | null = null;
  withTransaction(db, () => {
    db.prepare(
      `UPDATE runtime_app_operation
       SET status = 'succeeded',
           stage = 'completed',
           failed_stage = NULL,
           stage_updated_at = ?,
           safe_stdout_tail = ?,
           safe_stderr_tail = ?,
           completed_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      now,
      input.safeStdoutTail ?? null,
      input.safeStderrTail ?? null,
      now,
      input.operationId,
      workspaceId,
    );
    completed = readRuntimeAppOperationSync(input.operationId, workspaceId);
    if (!completed) {
      throw new Error(`Runtime app operation "${input.operationId}" does not exist.`);
    }
    if (completed.operation === "uninstall") {
      markRuntimeInstalledAppStatusFromOperationSync(completed, {
        status: "missing",
        enabled: false,
        lastError: undefined,
        updatedAt: now,
        lastCheckedAt: now,
      });
    } else if (completed.operation === "disable") {
      markRuntimeInstalledAppStatusFromOperationSync(completed, {
        status: "disabled",
        enabled: false,
        lastError: undefined,
        updatedAt: now,
        lastCheckedAt: now,
      });
    } else if (completed.operation === "enable") {
      markRuntimeInstalledAppStatusFromOperationSync(completed, {
        status: "installed",
        enabled: true,
        lastError: undefined,
        updatedAt: now,
        lastCheckedAt: now,
      });
    } else {
      upsertRuntimeInstalledAppFromOperationSync(completed, {
        displayName: input.installedApp?.displayName,
        version: input.installedApp?.version,
        entryPoint: input.installedApp?.entryPoint,
        installStrategy: input.installedApp?.installStrategy,
        status: "installed",
        enabled: true,
        installedAt: completed.operation === "install" ? now : undefined,
        updatedAt: now,
        lastCheckedAt: now,
        lastError: undefined,
        metadataJson: input.installedApp?.metadataJson,
      });
    }
  });
  return completed!;
}

export function failRuntimeAppOperationSync(input: FailRuntimeAppOperationInput): RuntimeAppOperationRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  let failed: RuntimeAppOperationRecord | null = null;
  withTransaction(db, () => {
    db.prepare(
      `UPDATE runtime_app_operation
       SET status = 'failed',
           failed_stage = stage,
           stage_updated_at = ?,
           safe_stdout_tail = ?,
           safe_stderr_tail = ?,
           error_code = ?,
           error_message = ?,
           completed_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      now,
      input.safeStdoutTail ?? null,
      input.safeStderrTail ?? null,
      input.errorCode ?? null,
      input.errorMessage,
      now,
      input.operationId,
      workspaceId,
    );
    failed = readRuntimeAppOperationSync(input.operationId, workspaceId);
    if (!failed) {
      throw new Error(`Runtime app operation "${input.operationId}" does not exist.`);
    }
    markRuntimeInstalledAppStatusFromOperationSync(failed, {
      status: "failed",
      lastError: input.errorMessage,
      updatedAt: now,
      lastCheckedAt: now,
    });
  });
  return failed!;
}

export function upsertRuntimeAppSkillBindingSync(input: {
  workspaceId?: string;
  runtimeAppId: string;
  skillId: string;
  source: RuntimeAppCatalogSource;
  name: string;
}): RuntimeAppSkillBindingRecord {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runtime_app_skill_binding (
      workspace_id,
      runtime_app_id,
      skill_id,
      source,
      name,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, runtime_app_id, skill_id) DO UPDATE SET
      source = excluded.source,
      name = excluded.name`,
  ).run(workspaceId, input.runtimeAppId, input.skillId, input.source, input.name.trim(), now);
  const row = db.prepare(
    `SELECT
      workspace_id AS workspaceId,
      runtime_app_id AS runtimeAppId,
      skill_id AS skillId,
      source,
      name,
      created_at AS createdAt
     FROM runtime_app_skill_binding
     WHERE workspace_id = ? AND runtime_app_id = ? AND skill_id = ?`,
  ).get(workspaceId, input.runtimeAppId, input.skillId) as Record<string, unknown> | undefined;
  const binding = row ? mapRuntimeAppSkillBindingRecord(row) : null;
  if (!binding) {
    throw new Error("Failed to upsert runtime app skill binding.");
  }
  return binding;
}

export function listRuntimeAppSkillBindingsSync(workspaceId = DEFAULT_WORKSPACE_ID): RuntimeAppSkillBindingRecord[] {
  const rows = getDatabase().prepare(
    `SELECT
      workspace_id AS workspaceId,
      runtime_app_id AS runtimeAppId,
      skill_id AS skillId,
      source,
      name,
      created_at AS createdAt
     FROM runtime_app_skill_binding
     WHERE workspace_id = ?
     ORDER BY created_at DESC`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapRuntimeAppSkillBindingRecord).filter((row): row is RuntimeAppSkillBindingRecord => row !== null);
}

function upsertRuntimeInstalledAppFromOperationSync(
  operation: RuntimeAppOperationRecord,
  input: {
    displayName?: string;
    version?: string;
    entryPoint?: string;
    installStrategy?: RuntimeInstalledAppRecord["installStrategy"];
    status: RuntimeInstalledAppRecord["status"];
    enabled?: boolean;
    installedAt?: string;
    updatedAt: string;
    lastCheckedAt?: string;
    lastError?: string;
    metadataJson?: string;
  },
): void {
  const db = getDatabase();
  const existing = readRuntimeInstalledAppSync({
    workspaceId: operation.workspaceId,
    runtimeId: operation.runtimeId,
    source: operation.appSource,
    name: operation.appName,
  });
  const catalog = readRuntimeAppCatalogItemSync(operation.appSource, operation.appName);
  const id = existing?.id ?? `runtime-app-${randomLikeId()}`;
  const displayName = input.displayName?.trim() || existing?.displayName || catalog?.displayName || operation.appName;
  const version = input.version?.trim() ?? existing?.version ?? catalog?.version ?? "";
  const entryPoint = input.entryPoint?.trim() ?? existing?.entryPoint ?? catalog?.entryPoint ?? "";
  const installStrategy = input.installStrategy ?? existing?.installStrategy ?? catalog?.installStrategy ?? "";
  db.prepare(
    `INSERT INTO runtime_installed_app (
      id,
      workspace_id,
      runtime_id,
      source,
      name,
      display_name,
      version,
      entry_point,
      status,
      install_strategy,
      enabled,
      installed_by_user_id,
      installed_at,
      updated_at,
      last_checked_at,
      last_error,
      metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, runtime_id, source, name) DO UPDATE SET
      display_name = excluded.display_name,
      version = excluded.version,
      entry_point = excluded.entry_point,
      status = excluded.status,
      install_strategy = excluded.install_strategy,
      enabled = excluded.enabled,
      installed_at = COALESCE(excluded.installed_at, runtime_installed_app.installed_at),
      updated_at = excluded.updated_at,
      last_checked_at = excluded.last_checked_at,
      last_error = excluded.last_error,
      metadata_json = excluded.metadata_json`,
  ).run(
    id,
    operation.workspaceId,
    operation.runtimeId,
    operation.appSource,
    operation.appName,
    displayName,
    version,
    entryPoint,
    input.status,
    installStrategy,
    input.enabled === false ? 0 : 1,
    operation.requestedByUserId ?? null,
    input.installedAt ?? null,
    input.updatedAt,
    input.lastCheckedAt ?? null,
    input.lastError ?? null,
    input.metadataJson ?? existing?.metadataJson ?? "{}",
  );
}

function markRuntimeInstalledAppStatusFromOperationSync(
  operation: RuntimeAppOperationRecord,
  input: {
    status: RuntimeInstalledAppRecord["status"];
    enabled?: boolean;
    lastError?: string;
    updatedAt: string;
    lastCheckedAt?: string;
  },
): void {
  const existing = readRuntimeInstalledAppSync({
    workspaceId: operation.workspaceId,
    runtimeId: operation.runtimeId,
    source: operation.appSource,
    name: operation.appName,
  });
  if (!existing) {
    upsertRuntimeInstalledAppFromOperationSync(operation, {
      status: input.status,
      enabled: input.enabled,
      updatedAt: input.updatedAt,
      lastCheckedAt: input.lastCheckedAt,
      lastError: input.lastError,
    });
    return;
  }
  getDatabase().prepare(
    `UPDATE runtime_installed_app
     SET status = ?,
         enabled = COALESCE(?, enabled),
         last_error = ?,
         updated_at = ?,
         last_checked_at = COALESCE(?, last_checked_at)
     WHERE id = ?`,
  ).run(
    input.status,
    typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : null,
    input.lastError ?? null,
    input.updatedAt,
    input.lastCheckedAt ?? null,
    existing.id,
  );
}

function mapRuntimeAppCatalogItemRecord(value: Record<string, unknown>): RuntimeAppCatalogItemRecord | null {
  if (
    !isRuntimeAppCatalogSource(value.source) ||
    typeof value.name !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.version !== "string" ||
    typeof value.category !== "string" ||
    typeof value.entryPoint !== "string" ||
    typeof value.installStrategy !== "string" ||
    typeof value.registryJson !== "string" ||
    typeof value.syncedAt !== "string"
  ) {
    return null;
  }
  return {
    source: value.source,
    name: value.name,
    displayName: value.displayName,
    description: value.description,
    version: value.version,
    category: value.category,
    entryPoint: value.entryPoint,
    installStrategy: isRuntimeAppInstallStrategy(value.installStrategy) ? value.installStrategy : "",
    installCmd: readOptionalString(value.installCmd),
    uninstallCmd: readOptionalString(value.uninstallCmd),
    updateCmd: readOptionalString(value.updateCmd),
    skillMd: readOptionalString(value.skillMd),
    requiresText: readOptionalString(value.requiresText),
    homepage: readOptionalString(value.homepage),
    registryJson: value.registryJson,
    syncedAt: value.syncedAt,
  };
}

function mapRuntimeInstalledAppRecord(value: Record<string, unknown>): RuntimeInstalledAppRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    !isRuntimeAppCatalogSource(value.source) ||
    typeof value.name !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.version !== "string" ||
    typeof value.entryPoint !== "string" ||
    !isRuntimeInstalledAppStatus(value.status) ||
    typeof value.installStrategy !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.metadataJson !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    source: value.source,
    name: value.name,
    displayName: value.displayName,
    version: value.version,
    entryPoint: value.entryPoint,
    status: value.status,
    installStrategy: isRuntimeAppInstallStrategy(value.installStrategy) ? value.installStrategy : "",
    enabled: value.enabled === true || value.enabled === 1 || value.enabled === "1",
    installedByUserId: readOptionalString(value.installedByUserId),
    installedAt: readOptionalString(value.installedAt),
    updatedAt: value.updatedAt,
    lastCheckedAt: readOptionalString(value.lastCheckedAt),
    lastError: readOptionalString(value.lastError),
    metadataJson: value.metadataJson,
  };
}

function mapRuntimeAppOperationRecord(value: Record<string, unknown>): RuntimeAppOperationRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeId !== "string" ||
    !isRuntimeAppCatalogSource(value.appSource) ||
    typeof value.appName !== "string" ||
    !isRuntimeAppOperationType(value.operation) ||
    !isRuntimeAppOperationStatus(value.status) ||
    typeof value.commandPlanJson !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    runtimeId: value.runtimeId,
    appSource: value.appSource,
    appName: value.appName,
    operation: value.operation,
    status: value.status,
    stage: isRuntimeAppOperationStage(value.stage) ? value.stage : "queued",
    failedStage: isRuntimeAppOperationStage(value.failedStage) ? value.failedStage : undefined,
    stageUpdatedAt: readOptionalString(value.stageUpdatedAt) ?? value.createdAt,
    requestedByUserId: readOptionalString(value.requestedByUserId),
    commandPlanJson: value.commandPlanJson,
    safeStdoutTail: readOptionalString(value.safeStdoutTail),
    safeStderrTail: readOptionalString(value.safeStderrTail),
    errorCode: readOptionalString(value.errorCode),
    errorMessage: readOptionalString(value.errorMessage),
    createdAt: value.createdAt,
    startedAt: readOptionalString(value.startedAt),
    completedAt: readOptionalString(value.completedAt),
  };
}

function mapRuntimeAppSkillBindingRecord(value: Record<string, unknown>): RuntimeAppSkillBindingRecord | null {
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.runtimeAppId !== "string" ||
    typeof value.skillId !== "string" ||
    !isRuntimeAppCatalogSource(value.source) ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  return {
    workspaceId: value.workspaceId,
    runtimeAppId: value.runtimeAppId,
    skillId: value.skillId,
    source: value.source,
    name: value.name,
    createdAt: value.createdAt,
  };
}

function isRuntimeAppCatalogSource(value: unknown): value is RuntimeAppCatalogSource {
  return value === "clihub_harness" || value === "clihub_public" || value === "skill_dependency";
}

function normalizeSource(value: RuntimeAppCatalogSource): RuntimeAppCatalogSource | null {
  return isRuntimeAppCatalogSource(value) ? value : null;
}

function isRuntimeAppInstallStrategy(value: unknown): value is RuntimeInstalledAppRecord["installStrategy"] {
  return value === "cli_hub" || value === "pip" || value === "npm" || value === "uv" || value === "bundled" || value === "manual";
}

function isRuntimeInstalledAppStatus(value: unknown): value is RuntimeInstalledAppRecord["status"] {
  return value === "installed" || value === "installing" || value === "failed" || value === "disabled" || value === "missing";
}

function isRuntimeAppOperationType(value: unknown): value is RuntimeAppOperationRecord["operation"] {
  return value === "install" || value === "update" || value === "uninstall" || value === "verify" || value === "disable" || value === "enable";
}

function isRuntimeAppOperationStatus(value: unknown): value is RuntimeAppOperationRecord["status"] {
  return value === "pending" || value === "claimed" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isRuntimeAppOperationStage(value: unknown): value is RuntimeAppOperationStage {
  return value === "queued" || value === "installing" || value === "verifying" || value === "finalizing" || value === "completed";
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
