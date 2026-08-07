import { isDaemonProvider, type DaemonProvider } from "@dofe-agent/domain";
import { getDatabase, withTransaction, randomLikeId, DEFAULT_WORKSPACE_ID } from "./database.ts";
import { assertActiveProviderAccountSync, fulfillRuntimeProvisionRequestsForDaemonTokenSync } from "./provider-accounts.ts";
import { requeueProvisioningStagesForOfflineDaemonSync } from "./runtime-provisioning-tasks.ts";
import { requeueCleanupRequestsForOfflineDaemonSync } from "./managed-runtime-cleanup.ts";
import { DEFAULT_DAEMON_HEARTBEAT_STALE_MS } from "./daemon-constants.ts";
import type { DaemonConnectionRecord, AgentRuntimeRecord, RegisteredDaemonSnapshot, RuntimeRegistrationInput } from "./types.ts";

// Remote daemons report every 15 seconds by default. Keep a generous grace
// period so a missed heartbeat does not leave an unreachable server selectable.
export { DEFAULT_DAEMON_HEARTBEAT_STALE_MS } from "./daemon-constants.ts";

export function registerDaemonRuntimesSync(input: {
  daemonKey: string;
  deviceName: string;
  workspaceId?: string;
  daemonTokenId?: string;
  metadata?: Record<string, unknown>;
  runtimes: RuntimeRegistrationInput[];
}): RegisteredDaemonSnapshot {
  const db = getDatabase();
  const now = new Date().toISOString();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const daemonKey = input.daemonKey.trim();
  const deviceName = input.deviceName.trim();

  const managedNode = input.metadata?.managedNode === true;
  if (!daemonKey) {
    throw new Error("daemonKey is required.");
  }
  if (!deviceName) {
    throw new Error("deviceName is required.");
  }
  if (!managedNode && input.runtimes.length === 0) {
    throw new Error("At least one runtime is required.");
  }

  withTransaction(db, () => {
    const existingDaemon = db
      .prepare(
        `SELECT
          id,
          workspace_id AS workspaceId,
          daemon_key AS daemonKey,
          device_name AS deviceName,
          status,
          metadata_json AS metadataJson,
          last_heartbeat_at AS lastHeartbeatAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM daemon_connection
        WHERE daemon_key = ?`,
      )
      .get(daemonKey) as Record<string, unknown> | undefined;
    const daemonId =
      existingDaemon && typeof existingDaemon.id === "string" ? existingDaemon.id : `daemon-${randomLikeId()}`;
    if (existingDaemon && existingDaemon.workspaceId !== workspaceId) {
      throw new Error("daemon.key_workspace_mismatch");
    }
    const daemonMetadataJson = JSON.stringify(input.metadata ?? {});

    const registrationResult = db.prepare(
      `INSERT INTO daemon_connection (
        id,
        workspace_id,
        daemon_key,
        device_name,
        status,
        metadata_json,
        last_heartbeat_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'online', ?, ?, ?, ?)
      ON CONFLICT(daemon_key) DO UPDATE SET
        device_name = excluded.device_name,
        status = 'online',
        metadata_json = excluded.metadata_json,
        last_heartbeat_at = excluded.last_heartbeat_at,
        updated_at = excluded.updated_at
      WHERE daemon_connection.workspace_id = excluded.workspace_id`,
    ).run(
      daemonId,
      workspaceId,
      daemonKey,
      deviceName,
      daemonMetadataJson,
      now,
      existingDaemon && typeof existingDaemon.createdAt === "string" ? existingDaemon.createdAt : now,
      now,
    );
    if (registrationResult.changes !== 1) {
      throw new Error("daemon.key_workspace_mismatch");
    }

    if (input.daemonTokenId) {
      bindDaemonTokenToConnectionSync({
        daemonTokenId: input.daemonTokenId,
        daemonId,
        workspaceId,
      });
    }

    const seenProviders = new Set<string>();
    for (const runtime of input.runtimes) {
      const provider = runtime.provider.trim();
      if (!provider) {
        continue;
      }
      seenProviders.add(provider);

      const existingRuntime = db
        .prepare(
          `SELECT
            id,
            created_at AS createdAt
          FROM agent_runtime
          WHERE workspace_id = ?
            AND daemon_connection_id = ?
            AND provider = ?
            AND managed_credential_id IS NULL`,
        )
        .get(workspaceId, daemonId, provider) as Record<string, unknown> | undefined;
      const runtimeId =
        existingRuntime && typeof existingRuntime.id === "string"
          ? existingRuntime.id
          : `runtime-${provider}-${randomLikeId()}`;
      const version = runtime.version?.trim() ?? "";
      const providerAccount = managedNode
        ? null
        : assertActiveProviderAccountSync({
            id: runtime.providerAccountId,
            workspaceId,
            provider: provider as RuntimeRegistrationInput["provider"],
          });
      const deviceInfo = runtime.deviceInfo?.trim() ?? deviceName;
      const metadataJson = JSON.stringify(runtime.metadata ?? {});

      db.prepare(
        `INSERT INTO agent_runtime (
          id,
          workspace_id,
          daemon_connection_id,
          provider,
          provider_account_id,
          name,
          version,
          status,
          device_info,
          metadata_json,
          connected_at,
          last_heartbeat_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, daemon_connection_id, provider)
          WHERE managed_credential_id IS NULL
          DO UPDATE SET
          name = excluded.name,
          provider_account_id = excluded.provider_account_id,
          version = excluded.version,
          status = 'online',
          device_info = excluded.device_info,
          metadata_json = excluded.metadata_json,
          connected_at = COALESCE(agent_runtime.connected_at, excluded.connected_at),
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_error = NULL,
          updated_at = excluded.updated_at`,
      ).run(
        runtimeId,
        workspaceId,
        daemonId,
        provider,
        providerAccount?.id ?? null,
        runtime.name.trim(),
        version,
        deviceInfo,
        metadataJson,
        now,
        now,
        existingRuntime && typeof existingRuntime.createdAt === "string" ? existingRuntime.createdAt : now,
        now,
      );
      if (!managedNode && providerAccount) {
        fulfillRuntimeProvisionRequestsForDaemonTokenSync({
          workspaceId,
          daemonTokenId: input.daemonTokenId,
          provider: provider as RuntimeRegistrationInput["provider"],
          providerAccountId: providerAccount.id,
        });
      }
    }

    const runtimeRows = db
      .prepare(
        `SELECT id, provider
         FROM agent_runtime
         WHERE workspace_id = ? AND daemon_connection_id = ?`,
      )
      .all(workspaceId, daemonId) as Array<Record<string, unknown>>;
    for (const row of runtimeRows) {
      if (typeof row.provider !== "string") {
        continue;
      }
      if (seenProviders.has(row.provider)) {
        continue;
      }
      if (typeof row.id !== "string") {
        continue;
      }

      db.prepare(
        `UPDATE agent_runtime
         SET status = 'offline',
             updated_at = ?
         WHERE id = ?`,
      ).run(now, row.id);
    }
  });

  return readDaemonSnapshotSync(daemonKey);
}

function bindDaemonTokenToConnectionSync(input: {
  daemonTokenId: string;
  daemonId: string;
  workspaceId: string;
}): void {
  const db = getDatabase();
  const token = db.prepare(
    `SELECT id, daemon_connection_id AS daemonConnectionId
     FROM daemon_api_token
     WHERE id = ? AND workspace_id = ? AND status = 'active'`,
  ).get(input.daemonTokenId, input.workspaceId) as { id: string; daemonConnectionId: string | null } | undefined;
  if (!token) {
    throw new Error("daemon.token_not_active");
  }
  if (token.daemonConnectionId && token.daemonConnectionId !== input.daemonId) {
    throw new Error("daemon.token_binding_mismatch");
  }

  const activeToken = db.prepare(
    `SELECT id
     FROM daemon_api_token
     WHERE daemon_connection_id = ? AND status = 'active' AND id <> ?
     LIMIT 1`,
  ).get(input.daemonId, input.daemonTokenId) as { id: string } | undefined;
  if (activeToken) {
    throw new Error("daemon.connection_token_bound");
  }

  const result = db.prepare(
    `UPDATE daemon_api_token
     SET daemon_connection_id = ?
     WHERE id = ?
       AND workspace_id = ?
       AND status = 'active'
       AND (daemon_connection_id IS NULL OR daemon_connection_id = ?)`,
  ).run(input.daemonId, input.daemonTokenId, input.workspaceId, input.daemonId);
  if (result.changes !== 1) {
    throw new Error("daemon.token_binding_mismatch");
  }
}

export function heartbeatDaemonSync(daemonKey: string, options?: {
  metadata?: Record<string, unknown>;
  runtimes?: Array<{
    id?: string;
    provider?: string;
    metadata?: Record<string, unknown>;
  }>;
}): RegisteredDaemonSnapshot {
  const db = getDatabase();
  const now = new Date().toISOString();

  withTransaction(db, () => {
    const daemon = readDaemonConnectionRow(db, daemonKey);
    if (!daemon) {
      throw new Error(`Daemon "${daemonKey}" does not exist.`);
    }

    if (options?.metadata) {
      db.prepare(
        `UPDATE daemon_connection
         SET status = 'online',
             metadata_json = ?,
             last_heartbeat_at = ?,
             updated_at = ?
         WHERE daemon_key = ?`,
      ).run(JSON.stringify(options.metadata), now, now, daemonKey);
    } else {
      db.prepare(
        `UPDATE daemon_connection
         SET status = 'online',
             last_heartbeat_at = ?,
             updated_at = ?
         WHERE daemon_key = ?`,
      ).run(now, now, daemonKey);
    }

    for (const runtime of options?.runtimes ?? []) {
      const selectors: string[] = ["daemon_connection_id = ?"];
      const params: unknown[] = [daemon.id];
      if (runtime.id?.trim()) {
        selectors.push("id = ?");
        params.push(runtime.id.trim());
      } else if (runtime.provider?.trim()) {
        selectors.push("provider = ?");
        params.push(runtime.provider.trim());
      } else {
        continue;
      }

      db.prepare(
        `UPDATE agent_runtime
         SET status = 'online',
             last_heartbeat_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE ${selectors.join(" AND ")}`,
      ).run(now, now, ...params);

      if (!runtime.metadata || !isRecord(runtime.metadata)) {
        continue;
      }

      const row = db.prepare(
        `SELECT metadata_json AS metadataJson
         FROM agent_runtime
         WHERE ${selectors.join(" AND ")}
         LIMIT 1`,
      ).get(...params) as Record<string, unknown> | undefined;
      const existingMetadata = parseMetadataJson(row?.metadataJson);
      db.prepare(
        `UPDATE agent_runtime
         SET metadata_json = ?,
             updated_at = ?
         WHERE ${selectors.join(" AND ")}`,
      ).run(JSON.stringify({ ...existingMetadata, ...runtime.metadata }), now, ...params);
    }
  });

  return readDaemonSnapshotSync(daemonKey);
}

function parseMetadataJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function markDaemonOfflineSync(daemonKey: string, options?: { lastError?: string }): RegisteredDaemonSnapshot {
  const db = getDatabase();
  const now = new Date().toISOString();

  withTransaction(db, () => {
    const daemon = readDaemonConnectionRow(db, daemonKey);
    if (!daemon) {
      throw new Error(`Daemon "${daemonKey}" does not exist.`);
    }

    db.prepare(
      `UPDATE daemon_connection
       SET status = 'offline',
           updated_at = ?
       WHERE daemon_key = ?`,
    ).run(now, daemonKey);

    db.prepare(
      `UPDATE agent_runtime
       SET status = 'offline',
           last_error = COALESCE(?, last_error),
           updated_at = ?
       WHERE daemon_connection_id = ?`,
    ).run(options?.lastError ?? null, now, daemon.id);

    requeueProvisioningStagesForOfflineDaemonSync(daemon.id);
    requeueCleanupRequestsForOfflineDaemonSync(daemon.id);
  });

  return readDaemonSnapshotSync(daemonKey);
}

export function readDaemonSnapshotSync(daemonKey: string): RegisteredDaemonSnapshot {
  const db = getDatabase();
  const daemon = readDaemonConnectionRow(db, daemonKey);
  if (!daemon) {
    throw new Error(`Daemon "${daemonKey}" does not exist.`);
  }

  return {
    daemon,
    runtimes: listDaemonRuntimesSync(daemon.id),
  };
}

export function readDaemonConnectionSync(daemonKey: string): DaemonConnectionRecord | null {
  return readDaemonConnectionRow(getDatabase(), daemonKey);
}

export function readAgentRuntimeSync(runtimeId: string): AgentRuntimeRecord | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        provider,
        provider_account_id AS providerAccountId,
        name,
        version,
        status,
        device_info AS deviceInfo,
        metadata_json AS metadataJson,
        connected_at AS connectedAt,
        last_heartbeat_at AS lastHeartbeatAt,
        last_error AS lastError,
        runtime_type,
        protocols_json,
        default_model,
        provisioning_state,
        managed_credential_id,
        credential_secret_ref,
        credential_config_ref,
        provisioning_task_id,
        managed_at,
        allow_new_employee_sharing,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_runtime
      WHERE id = ?`,
    )
    .get(runtimeId) as Record<string, unknown> | undefined;

  return row ? mapAgentRuntimeRecord(row) : null;
}

export function listManagedAgentRuntimesSync(workspaceId: string): AgentRuntimeRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        provider,
        provider_account_id AS providerAccountId,
        name,
        version,
        status,
        device_info AS deviceInfo,
        metadata_json AS metadataJson,
        connected_at AS connectedAt,
        last_heartbeat_at AS lastHeartbeatAt,
        last_error AS lastError,
        protocols_json,
        default_model,
        provisioning_state,
        managed_credential_id,
        credential_secret_ref,
        credential_config_ref,
        provisioning_task_id,
        managed_at,
        allow_new_employee_sharing,
        created_at AS createdAt,
        updated_at AS updatedAt
       FROM agent_runtime
       WHERE workspace_id = ? AND managed_credential_id IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapAgentRuntimeRecord(row))
    .filter((row): row is AgentRuntimeRecord => row !== null);
}

export function listAllManagedAgentRuntimesSync(): AgentRuntimeRecord[] {
  const workspaceIds = getDatabase().prepare(
    `SELECT DISTINCT workspace_id FROM agent_runtime WHERE managed_credential_id IS NOT NULL`,
  ).all() as Array<{ workspace_id: string }>;
  return workspaceIds.flatMap((row) => listManagedAgentRuntimesSync(row.workspace_id));
}

export interface UpdateAgentRuntimeManagedFieldsInput {
  runtimeId: string;
  workspaceId?: string;
  provisioningState?: "managed" | "draining" | "legacy" | "credential_recovering" | "needs_attention";
  managedCredentialId?: string;
  credentialSecretRef?: string;
  credentialConfigRef?: string;
  protocols?: string[];
  defaultModel?: string;
  provisioningTaskId?: string;
  status?: "online" | "offline";
  allowNewEmployeeSharing?: boolean;
}

export interface CreateManagedAgentRuntimeInput {
  /** Pre-generated id (also used as the models.dofe.ai RuntimeCredential runtimeId). */
  id: string;
  workspaceId: string;
  provider: DaemonProvider;
  name: string;
  protocols: string[];
  defaultModel?: string;
  /** When false, the runtime refuses new employee binds (default true). */
  allowNewEmployeeSharing?: boolean;
  managedCredentialId: string;
  credentialSecretRef?: string;
  credentialConfigRef?: string;
  provisioningTaskId: string;
}

/**
 * Create a managed agent_runtime row (offline, no daemon connection, no
 * provider_account). Driven by the provisioning orchestrator's prepare_node
 * stage. The daemon later connects and brings it online (Phase 3 reconciles
 * the install); for Phase 2 the row is the durable managed-runtime record.
 */
export function createManagedAgentRuntimeSync(
  input: CreateManagedAgentRuntimeInput,
): AgentRuntimeRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_runtime (
       id, workspace_id, daemon_connection_id, provider, provider_account_id,
       name, version, status, device_info, metadata_json,
       runtime_type, protocols_json, default_model, provisioning_state,
       managed_credential_id, credential_secret_ref, credential_config_ref,
       provisioning_task_id, managed_at, allow_new_employee_sharing,
       created_at, updated_at
     ) VALUES (?, ?, NULL, ?, NULL, ?, '', 'offline', '', '{}'::jsonb,
       ?, ?, ?, 'managed', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.workspaceId,
    input.provider,
    input.name.trim(),
    input.provider,
    JSON.stringify(input.protocols),
    input.defaultModel?.trim() || null,
    input.managedCredentialId,
    input.credentialSecretRef ?? null,
    input.credentialConfigRef ?? null,
    input.provisioningTaskId,
    now,
    input.allowNewEmployeeSharing === false ? 0 : 1,
    now,
    now,
  );
  return readAgentRuntimeSync(input.id)!;
}

/**
 * Update the managed-runtime columns on an existing agent_runtime row. Used by
 * the provisioning orchestrator (write_credential / ready / stop / delete).
 * Only writes the supplied fields; plaintext keys are never stored.
 */
export function updateAgentRuntimeManagedFieldsSync(
  input: UpdateAgentRuntimeManagedFieldsInput,
): AgentRuntimeRecord | null {
  const db = getDatabase();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [new Date().toISOString()];
  if (input.provisioningState) {
    sets.push("provisioning_state = ?");
    params.push(input.provisioningState);
  }
  if (input.status) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.managedCredentialId !== undefined) {
    sets.push("managed_credential_id = ?");
    params.push(input.managedCredentialId || null);
  }
  if (input.credentialSecretRef !== undefined) {
    sets.push("credential_secret_ref = ?");
    params.push(input.credentialSecretRef || null);
  }
  if (input.credentialConfigRef !== undefined) {
    sets.push("credential_config_ref = ?");
    params.push(input.credentialConfigRef || null);
  }
  if (input.protocols) {
    sets.push("protocols_json = ?");
    params.push(JSON.stringify(input.protocols));
  }
  if (input.defaultModel !== undefined) {
    sets.push("default_model = ?");
    params.push(input.defaultModel || null);
  }
  if (input.allowNewEmployeeSharing !== undefined) {
    sets.push("allow_new_employee_sharing = ?");
    params.push(input.allowNewEmployeeSharing === false ? 0 : 1);
  }
  if (input.provisioningTaskId !== undefined) {
    sets.push("provisioning_task_id = ?");
    params.push(input.provisioningTaskId || null);
  }
  if (input.provisioningState === "managed") {
    sets.push("managed_at = COALESCE(managed_at, ?)");
    params.push(new Date().toISOString());
  }

  params.push(input.runtimeId);
  if (input.workspaceId) {
    params.push(input.workspaceId);
  }
  db.prepare(
    `UPDATE agent_runtime SET ${sets.join(", ")} WHERE id = ?${input.workspaceId ? " AND workspace_id = ?" : ""}`,
  ).run(...params);
  return readAgentRuntimeSync(input.runtimeId);
}

export function requestAgentRuntimeProviderVerificationSync(input: {
  runtimeId: string;
  workspaceId?: string;
}): AgentRuntimeRecord {
  const runtimeId = input.runtimeId.trim();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("runtime.not_found");
  }
  if (runtime.status !== "online") {
    throw new Error("runtime.offline");
  }

  const metadata = parseMetadataJson(runtime.metadataJson);
  getDatabase().prepare(
    `UPDATE agent_runtime
     SET metadata_json = ?,
         updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
  ).run(
    JSON.stringify({
      ...metadata,
      providerVerificationRequestedAt: new Date().toISOString(),
    }),
    new Date().toISOString(),
    runtimeId,
    workspaceId,
  );
  return readAgentRuntimeSync(runtimeId)!;
}

export function deleteAgentRuntimeSync(input: {
  runtimeId: string;
  workspaceId?: string;
}): AgentRuntimeRecord | null {
  const db = getDatabase();
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const runtimeId = input.runtimeId.trim();
  if (!runtimeId) {
    throw new Error("runtimeId is required.");
  }

  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    return null;
  }

  const result = db
    .prepare(
      `DELETE FROM agent_runtime
       WHERE id = ? AND workspace_id = ?`,
    )
    .run(runtimeId, workspaceId);

  return result.changes > 0 ? runtime : null;
}

export function listDaemonSnapshotsSync(workspaceId?: string): RegisteredDaemonSnapshot[] {
  const db = getDatabase();
  const hasWorkspaceId = typeof workspaceId === "string";
  markStaleDaemonsOfflineSync({ workspaceId });
  const daemons = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_key AS daemonKey,
        device_name AS deviceName,
        status,
        metadata_json AS metadataJson,
        last_heartbeat_at AS lastHeartbeatAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM daemon_connection
      ${hasWorkspaceId ? "WHERE workspace_id = ?" : ""}
      ORDER BY created_at ASC`,
    )
    .all(...(hasWorkspaceId ? [workspaceId] : [])) as Array<Record<string, unknown>>;
  const runtimes = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        provider,
        provider_account_id AS providerAccountId,
        name,
        version,
        status,
        device_info AS deviceInfo,
        metadata_json AS metadataJson,
        connected_at AS connectedAt,
        last_heartbeat_at AS lastHeartbeatAt,
        last_error AS lastError,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_runtime
      ${hasWorkspaceId ? "WHERE workspace_id = ?" : ""}
      ORDER BY daemon_connection_id ASC, provider ASC`,
    )
    .all(...(hasWorkspaceId ? [workspaceId] : [])) as Array<Record<string, unknown>>;
  const runtimesByDaemonId = new Map<string, AgentRuntimeRecord[]>();
  for (const runtime of runtimes
    .map((row) => mapAgentRuntimeRecord(row))
    .filter((row): row is AgentRuntimeRecord => row !== null)) {
    const daemonConnectionId = runtime.daemonConnectionId;
    if (!daemonConnectionId) {
      continue;
    }
    const next = runtimesByDaemonId.get(daemonConnectionId) ?? [];
    next.push(runtime);
    runtimesByDaemonId.set(daemonConnectionId, next);
  }

  return daemons
    .map((row) => mapDaemonConnectionRecord(row))
    .filter((row): row is DaemonConnectionRecord => row !== null)
    .map((daemon) => ({
      daemon,
      runtimes: runtimesByDaemonId.get(daemon.id) ?? [],
    }));
}

export function markStaleDaemonsOfflineSync(options?: {
  workspaceId?: string;
  maxHeartbeatAgeMs?: number;
  now?: Date;
}): number {
  const db = getDatabase();
  const workspaceId = options?.workspaceId;
  const maxHeartbeatAgeMs = options?.maxHeartbeatAgeMs ?? DEFAULT_DAEMON_HEARTBEAT_STALE_MS;
  const now = options?.now ?? new Date();
  const cutoff = now.getTime() - maxHeartbeatAgeMs;
  const candidates = db
    .prepare(
      `SELECT daemon_key AS daemonKey, last_heartbeat_at AS lastHeartbeatAt
       FROM daemon_connection
       WHERE status = 'online'
         ${typeof workspaceId === "string" ? "AND workspace_id = ?" : ""}`,
    )
    .all(...(typeof workspaceId === "string" ? [workspaceId] : [])) as Array<Record<string, unknown>>;
  const staleDaemonKeys = candidates
    .filter((daemon) => {
      const heartbeatAt = typeof daemon.lastHeartbeatAt === "string"
        ? new Date(daemon.lastHeartbeatAt).getTime()
        : Number.NaN;
      return !Number.isFinite(heartbeatAt) || heartbeatAt < cutoff;
    })
    .map((daemon) => daemon.daemonKey)
    .filter((daemonKey): daemonKey is string => typeof daemonKey === "string");

  if (staleDaemonKeys.length === 0) {
    return 0;
  }

  const updatedAt = now.toISOString();
  withTransaction(db, () => {
    for (const daemonKey of staleDaemonKeys) {
      const daemon = readDaemonConnectionRow(db, daemonKey);
      if (!daemon || daemon.status !== "online") {
        continue;
      }
      db.prepare(
        `UPDATE daemon_connection
         SET status = 'offline', updated_at = ?
         WHERE id = ?`,
      ).run(updatedAt, daemon.id);
      db.prepare(
        `UPDATE agent_runtime
         SET status = 'offline',
             last_error = COALESCE(last_error, 'Daemon heartbeat timed out.'),
             updated_at = ?
         WHERE daemon_connection_id = ?`,
      ).run(updatedAt, daemon.id);

      requeueProvisioningStagesForOfflineDaemonSync(daemon.id);
      requeueCleanupRequestsForOfflineDaemonSync(daemon.id);
    }
  });

  return staleDaemonKeys.length;
}

export function pruneOfflineDaemonsSync(maxOfflineAgeMs: number, options?: { workspaceId?: string }): number {
  const db = getDatabase();
  const cutoff = Date.now() - maxOfflineAgeMs;
  const daemons = listDaemonSnapshotsSync(options?.workspaceId);
  let removed = 0;

  withTransaction(db, () => {
    for (const snapshot of daemons) {
      if (snapshot.daemon.status !== "offline") {
        continue;
      }
      const lastTouched = snapshot.daemon.lastHeartbeatAt ?? snapshot.daemon.updatedAt;
      if (new Date(lastTouched).getTime() >= cutoff) {
        continue;
      }

      db.prepare("DELETE FROM agent_runtime WHERE daemon_connection_id = ?").run(snapshot.daemon.id);
      db.prepare("DELETE FROM daemon_connection WHERE id = ?").run(snapshot.daemon.id);
      removed += 1;
    }
  });

  return removed;
}

function readDaemonConnectionRow(db: ReturnType<typeof getDatabase>, daemonKey: string): DaemonConnectionRecord | null {
  const row = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_key AS daemonKey,
        device_name AS deviceName,
        status,
        metadata_json AS metadataJson,
        last_heartbeat_at AS lastHeartbeatAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM daemon_connection
      WHERE daemon_key = ?`,
    )
    .get(daemonKey) as Record<string, unknown> | undefined;

  return row ? mapDaemonConnectionRecord(row) : null;
}

function listDaemonRuntimesSync(daemonConnectionId: string): AgentRuntimeRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        id,
        workspace_id AS workspaceId,
        daemon_connection_id AS daemonConnectionId,
        provider,
        provider_account_id AS providerAccountId,
        name,
        version,
        status,
        device_info AS deviceInfo,
        metadata_json AS metadataJson,
        connected_at AS connectedAt,
        last_heartbeat_at AS lastHeartbeatAt,
        last_error AS lastError,
        runtime_type,
        protocols_json,
        default_model,
        provisioning_state,
        managed_credential_id,
        credential_secret_ref,
        credential_config_ref,
        provisioning_task_id,
        managed_at,
        allow_new_employee_sharing,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM agent_runtime
      WHERE daemon_connection_id = ?
      ORDER BY provider ASC`,
    )
    .all(daemonConnectionId) as Array<Record<string, unknown>>;

  return rows
    .map((row) => mapAgentRuntimeRecord(row))
    .filter((row): row is AgentRuntimeRecord => row !== null);
}

function mapDaemonConnectionRecord(value: Record<string, unknown>): DaemonConnectionRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.daemonKey !== "string" ||
    typeof value.deviceName !== "string" ||
    (value.status !== "online" && value.status !== "offline") ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    daemonKey: value.daemonKey,
    deviceName: value.deviceName,
    status: value.status,
    metadataJson: value.metadataJson,
    lastHeartbeatAt: typeof value.lastHeartbeatAt === "string" ? value.lastHeartbeatAt : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapAgentRuntimeRecord(value: Record<string, unknown>): AgentRuntimeRecord | null {
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !isDaemonProvider(value.provider as string) ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    (value.status !== "online" && value.status !== "offline") ||
    typeof value.deviceInfo !== "string" ||
    typeof value.metadataJson !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    daemonConnectionId: typeof value.daemonConnectionId === "string" ? value.daemonConnectionId : undefined,
    provider: value.provider as AgentRuntimeRecord["provider"],
    providerAccountId: typeof value.providerAccountId === "string" ? value.providerAccountId : undefined,
    name: value.name,
    version: value.version,
    status: value.status,
    deviceInfo: value.deviceInfo,
    metadataJson: value.metadataJson,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : undefined,
    lastHeartbeatAt: typeof value.lastHeartbeatAt === "string" ? value.lastHeartbeatAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    // Managed-runtime fields (Phase 2). Optional and absent on legacy reads.
    provisioningState: typeof value.provisioningState === "string"
      ? (value.provisioningState as AgentRuntimeRecord["provisioningState"])
      : undefined,
    managedCredentialId: typeof value.managedCredentialId === "string" ? value.managedCredentialId : undefined,
    credentialSecretRef: typeof value.credentialSecretRef === "string" ? value.credentialSecretRef : undefined,
    credentialConfigRef: typeof value.credentialConfigRef === "string" ? value.credentialConfigRef : undefined,
    protocols: parseProtocolsValue(value.protocolsJson),
    defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : undefined,
    allowNewEmployeeSharing: value.allowNewEmployeeSharing !== false && value.allowNewEmployeeSharing !== 0,
    provisioningTaskId: typeof value.provisioningTaskId === "string" ? value.provisioningTaskId : undefined,
    managedAt: typeof value.managedAt === "string" ? value.managedAt : undefined,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseProtocolsValue(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : undefined;
  } catch {
    return undefined;
  }
}
