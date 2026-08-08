import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { DofeAgentState, LedgerItem, MessageAttachment, WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { getDataDirPath } from "./database.ts";
import {
  POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID,
  getPostgresHistoryBackfillStatements,
  getPostgresHistoryBackfillStatementsForWorkspaces,
  getPostgresPostCommitSchemaStatements,
  getPostgresSchemaStatements,
  POSTGRES_HISTORY_BACKFILL_BATCH_WORKSPACE_LIMIT,
  POSTGRES_HISTORY_BACKFILL_PENDING_WORKSPACES_QUERY,
  POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT,
  POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS,
  POSTGRES_POST_COMMIT_INDEX_NAMES,
  POSTGRES_SCHEMA_ADVISORY_LOCK_IDS,
  POSTGRES_SCHEMA_VERSION,
  POSTGRES_TABLE_NAMES,
  POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME,
  type PostgresTableName,
} from "./postgres-schema.ts";
import { redactPostgresDatabaseUrl, resolvePostgresDatabaseUrl, type PostgresConnectionInput } from "./postgres-config.ts";

type DatabaseSync = import("node:sqlite").DatabaseSync;

type JsonColumnName =
  | "human_member_names_json"
  | "employee_names_json"
  | "traits_json"
  | "labels_json"
  | "profile_json"
  | "state_json"
  | "metadata_json"
  | "config_json"
  | "encrypted_credentials_json"
  | "encrypted_secrets_json"
  | "capabilities_json"
  | "scopes_json"
  | "permissions_json"
  | "input_json"
  | "payload_json"
  | "request_json"
  | "result_json"
  | "registry_json"
  | "manifest_json"
  | "command_plan_json"
  | "options_json"
  | "snapshot_json"
  | "event_json"
  | "audit_data_json"
  | "data_json"
  | "source_event_ids_json";

interface TableMigrationPlan {
  tableName: Exclude<PostgresTableName, "app_metadata" | "attachment" | "audit_log">;
  sourceTableName?: string;
  conflictColumns: string[];
  jsonColumns?: JsonColumnName[];
  optionalWhenMissing?: boolean;
  orderBy?: string;
}

export type { PostgresConnectionInput } from "./postgres-config.ts";

export interface PostgresStatus {
  engine: "postgres";
  databaseUrl: string;
  schemaVersion: string;
  tables: Array<{ tableName: PostgresTableName; rowCount: number }>;
}

export interface MigrationTableReport {
  tableName: string;
  sourceCount: number;
  insertedCount: number;
  skippedCount: number;
}

/**
 * 迁移结果状态。`completed` = 正常执行（含 dryRun 预演）；
 * `skipped_incompatible_schema` = 目标库 schema_version 高于本实例，已跳过全部语句与数据导入——
 * 旧实现对此静默返回成功报告，令调用方误以为已迁入数据，故显式建模为可观测状态。
 */
export type MigrationStatus = "completed" | "skipped_incompatible_schema";

export interface SqliteToPostgresMigrationReport {
  sourceSqlitePath: string;
  targetDatabaseUrl?: string;
  sourceSchemaVersion: string;
  targetSchemaVersion: string;
  status: MigrationStatus;
  dryRun: boolean;
  reset: boolean;
  startedAt: string;
  finishedAt: string;
  warnings: string[];
  tables: MigrationTableReport[];
}

export interface SqliteToPostgresMigrationInput extends PostgresConnectionInput {
  sqlitePath?: string;
  dryRun?: boolean;
  reset?: boolean;
}

export interface PostgresToPostgresMigrationInput {
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  dryRun?: boolean;
  reset?: boolean;
}

export interface PostgresToPostgresMigrationReport {
  sourceDatabaseUrl: string;
  targetDatabaseUrl: string;
  status: MigrationStatus;
  dryRun: boolean;
  reset: boolean;
  startedAt: string;
  finishedAt: string;
  warnings: string[];
  tables: Array<{
    tableName: string;
    sourceCount: number;
    insertedCount: number;
    skippedCount: number;
  }>;
}

type MigrationRow = Record<string, unknown>;

interface TableMigrationSnapshot {
  tableName: string;
  conflictColumns: string[];
  jsonColumns: JsonColumnName[];
  rows: MigrationRow[];
}

interface LegacyWorkspaceRow {
  id: string;
  state_json: string | DofeAgentState;
  created_at: string;
  updated_at: string;
}

interface DerivedAttachmentRow extends MigrationRow {
  workspace_id: string;
  id: string;
}

interface DerivedAuditLogRow extends MigrationRow {
  id: string;
}

const TABLE_MIGRATION_PLANS: TableMigrationPlan[] = [
  { tableName: "workspace", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "users", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "auth_identity", conflictColumns: ["id"], jsonColumns: ["profile_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "session", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "workspace_membership", conflictColumns: ["id"], orderBy: "joined_at ASC, id ASC" },
  {
    tableName: "external_integration",
    conflictColumns: ["id"],
    jsonColumns: ["encrypted_credentials_json", "config_json", "capabilities_json", "scopes_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_user_binding",
    conflictColumns: ["id"],
    jsonColumns: ["metadata_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_channel_binding",
    conflictColumns: ["id"],
    jsonColumns: ["metadata_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_resource_binding",
    conflictColumns: ["id"],
    jsonColumns: ["permissions_json", "metadata_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_message_mapping",
    conflictColumns: ["id"],
    jsonColumns: ["metadata_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_message_outbox",
    conflictColumns: ["id"],
    jsonColumns: ["payload_json", "metadata_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_data_operation_run",
    conflictColumns: ["id"],
    jsonColumns: ["request_json", "result_json"],
    optionalWhenMissing: true,
    orderBy: "created_at ASC, id ASC",
  },
  {
    tableName: "external_integration_event",
    conflictColumns: ["id"],
    jsonColumns: ["payload_json"],
    optionalWhenMissing: true,
    orderBy: "received_at ASC, id ASC",
  },
  {
    tableName: "workspace_snapshot",
    sourceTableName: "legacy_workspace",
    conflictColumns: ["id"],
    jsonColumns: ["state_json"],
    orderBy: "created_at ASC, id ASC",
  },
  { tableName: "workspace_channel", conflictColumns: ["id"], jsonColumns: ["human_member_names_json", "employee_names_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "channel_participant", conflictColumns: ["workspace_id", "channel_name", "user_id"], orderBy: "joined_at ASC, id ASC" },
  { tableName: "channel_access_request", conflictColumns: ["id"], orderBy: "requested_at ASC, id ASC" },
  { tableName: "channel_invitation", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "workspace_employee", conflictColumns: ["workspace_id", "name"], jsonColumns: ["traits_json"], orderBy: "created_at ASC, workspace_id ASC, name ASC" },
  { tableName: "agent_fork_invitation", conflictColumns: ["id"], jsonColumns: ["options_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_fork_snapshot", conflictColumns: ["id"], jsonColumns: ["snapshot_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "workspace_task", conflictColumns: ["id"], jsonColumns: ["labels_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "daemon_connection", conflictColumns: ["id"], jsonColumns: ["metadata_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "daemon_api_token", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_runtime", conflictColumns: ["id"], jsonColumns: ["metadata_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "workspace_runtime_display_name", conflictColumns: ["workspace_id", "runtime_id"], orderBy: "created_at ASC, workspace_id ASC, runtime_id ASC" },
  { tableName: "workspace_runtime_grant", conflictColumns: ["workspace_id", "runtime_id", "user_id", "permission"], orderBy: "created_at ASC, id ASC" },
  { tableName: "document_agent_access", conflictColumns: ["workspace_id", "document_id", "subject_type", "subject_id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "document_permission_request", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_access_request", conflictColumns: ["id"], jsonColumns: ["audit_data_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "workspace_notification", conflictColumns: ["id"], jsonColumns: ["metadata_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "employee_runtime_binding", conflictColumns: ["workspace_id", "employee_id"], orderBy: "created_at ASC, workspace_id ASC, employee_name ASC" },
  { tableName: "runtime_app_catalog_item", conflictColumns: ["source", "name"], jsonColumns: ["registry_json"], orderBy: "synced_at ASC, source ASC, name ASC" },
  { tableName: "runtime_app_package", conflictColumns: ["id"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "runtime_app_release", conflictColumns: ["id"], jsonColumns: ["manifest_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "runtime_installed_app", conflictColumns: ["id"], jsonColumns: ["metadata_json"], orderBy: "updated_at ASC, id ASC" },
  { tableName: "runtime_app_operation", conflictColumns: ["id"], jsonColumns: ["command_plan_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "skill", conflictColumns: ["id"], jsonColumns: ["config_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "skill_file", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "runtime_app_skill_binding", conflictColumns: ["workspace_id", "runtime_app_id", "skill_id"], orderBy: "created_at ASC, workspace_id ASC, runtime_app_id ASC, skill_id ASC" },
  { tableName: "skill_import_event", conflictColumns: ["id"], jsonColumns: ["metadata_json"], orderBy: "imported_at ASC, id ASC" },
  { tableName: "agent_skill", conflictColumns: ["workspace_id", "employee_id", "skill_id"], orderBy: "created_at ASC, workspace_id ASC, employee_name ASC, skill_id ASC" },
  { tableName: "agent_skill_requirement_config", conflictColumns: ["workspace_id", "employee_id", "skill_id"], jsonColumns: ["config_json", "encrypted_secrets_json"], optionalWhenMissing: true, orderBy: "created_at ASC, workspace_id ASC, employee_name ASC, skill_id ASC" },
  { tableName: "knowledge_page_assignment_policy", conflictColumns: ["workspace_id", "knowledge_page_id"], orderBy: "updated_at ASC, workspace_id ASC, knowledge_page_id ASC" },
  { tableName: "agent_knowledge_page", conflictColumns: ["workspace_id", "employee_id", "knowledge_page_id"], orderBy: "created_at ASC, workspace_id ASC, employee_name ASC, knowledge_page_id ASC" },
  { tableName: "agent_router_session", conflictColumns: ["id"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_router_provider_session", conflictColumns: ["id"], jsonColumns: ["metadata_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_task_queue", conflictColumns: ["id"], jsonColumns: ["input_json", "result_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "external_thread_binding", conflictColumns: ["id"], jsonColumns: ["metadata_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_task_attempt", conflictColumns: ["id"], jsonColumns: ["metadata_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_router_event", conflictColumns: ["id"], jsonColumns: ["data_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "agent_router_context_snapshot", conflictColumns: ["id"], jsonColumns: ["source_event_ids_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "task_execution_event", conflictColumns: ["id"], jsonColumns: ["data_json"], orderBy: "created_at ASC, id ASC" },
  { tableName: "task_message", conflictColumns: ["id"], jsonColumns: ["input_json"], orderBy: "created_at ASC, task_id ASC, seq ASC" },
  { tableName: "openmontage_delegation_intent", conflictColumns: ["idempotency_key"], jsonColumns: ["request_json"], optionalWhenMissing: true, orderBy: "created_at ASC, idempotency_key ASC" },
  { tableName: "openmontage_job_link", conflictColumns: ["job_id"], optionalWhenMissing: true, orderBy: "created_at ASC, job_id ASC" },
  { tableName: "openmontage_model_delegation", conflictColumns: ["job_id"], optionalWhenMissing: true, orderBy: "created_at ASC, job_id ASC" },
  { tableName: "openmontage_job_event", conflictColumns: ["event_id"], jsonColumns: ["event_json"], optionalWhenMissing: true, orderBy: "received_at ASC, event_id ASC" },
  { tableName: "openmontage_job_projection", conflictColumns: ["job_id"], jsonColumns: ["snapshot_json"], optionalWhenMissing: true, orderBy: "created_at ASC, job_id ASC" },
  { tableName: "openmontage_chat_binding", conflictColumns: ["job_id"], optionalWhenMissing: true, orderBy: "created_at ASC, job_id ASC" },
  { tableName: "openmontage_event_nonce", conflictColumns: ["nonce"], optionalWhenMissing: true, orderBy: "received_at ASC, nonce ASC" },
  { tableName: "openmontage_notification_outbox", conflictColumns: ["id"], jsonColumns: ["payload_json"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "openmontage_artifact_grant", conflictColumns: ["id"], optionalWhenMissing: true, orderBy: "created_at ASC, id ASC" },
  { tableName: "model_pricing", conflictColumns: ["model_id"], orderBy: "model_id ASC" },
  { tableName: "token_usage", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
  { tableName: "budget", conflictColumns: ["id"], orderBy: "created_at ASC, id ASC" },
];

export { redactPostgresDatabaseUrl, resolvePostgresDatabaseUrl };

export async function ensurePostgresSchema(input?: PostgresConnectionInput): Promise<PostgresStatus> {
  const databaseUrl = resolvePostgresDatabaseUrl(input);
  const client = createPostgresClient(databaseUrl);

  await client.connect();
  try {
    return await withPostgresSchemaLock(client, async () => {
      // Forward-only guard: if a newer instance already advanced schema_version
      // beyond this instance, an older CLI must not run statements or write the
      // version down (prevents downgrading a database already migrated by a newer
      // binary during a rollout). 复检须在取锁后进行——锁外检查与取锁之间存在 TOCTOU 窗口，
      // 期间另一实例可能已推进版本。Mirrors the runtime guard in database.ts.
      if (await isPostgresSchemaNewerThanInstance(client)) {
        return await readPostgresStatusWithClient(client, databaseUrl);
      }
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        for (const statement of getPostgresSchemaStatements()) {
          await client.query(statement);
        }
        // 维护命令同步完成重型 history 回填 + 在线 NOT NULL（请求路径已把这些移到后台自愈）。
        for (const statement of getPostgresHistoryBackfillStatements()) {
          await client.query(statement);
        }
        for (const statement of POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS) {
          await client.query(statement);
        }
        await setAppMetadataFlag(client, "schema_116_history_backfill_complete", "true");
        await client.query("COMMIT");
        transactionStarted = false;
        await applyPostCommitSchemaStatements(client);
        return await readPostgresStatusWithClient(client, databaseUrl);
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        throw error;
      }
    });
  } finally {
    await client.end();
  }
}

export async function getPostgresStatus(input?: PostgresConnectionInput): Promise<PostgresStatus> {
  const databaseUrl = resolvePostgresDatabaseUrl(input);
  const client = createPostgresClient(databaseUrl);
  await client.connect();
  try {
    return await readPostgresStatusWithClient(client, databaseUrl);
  } finally {
    await client.end();
  }
}

export async function migrateSqliteToPostgres(
  input?: SqliteToPostgresMigrationInput,
): Promise<SqliteToPostgresMigrationReport> {
  const startedAt = new Date().toISOString();
  const sqlitePath = input?.sqlitePath?.trim() || getDefaultSqliteMigrationPath();
  const dryRun = input?.dryRun === true;
  const reset = input?.reset === true;

  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite source database does not exist: ${sqlitePath}`);
  }

  const sourceDb = await openSqliteDatabase(sqlitePath);
  try {
    const snapshot = collectSqliteMigrationSnapshotSync(sourceDb, startedAt);
    const report: SqliteToPostgresMigrationReport = {
      sourceSqlitePath: sqlitePath,
      targetDatabaseUrl: input?.databaseUrl ? redactPostgresDatabaseUrl(input.databaseUrl) : undefined,
      sourceSchemaVersion: readSqliteSchemaVersionSync(sourceDb),
      targetSchemaVersion: POSTGRES_SCHEMA_VERSION,
      status: "completed",
      dryRun,
      reset,
      startedAt,
      finishedAt: startedAt,
      warnings: [...snapshot.warnings],
      tables: snapshot.tables.map((table) => ({
        tableName: table.tableName,
        sourceCount: table.rows.length,
        insertedCount: 0,
        skippedCount: table.rows.length,
      })),
    };

    if (dryRun && !input?.databaseUrl && !(input?.env?.DOFE_AGENT_PG_URL || input?.env?.DATABASE_URL)) {
      report.finishedAt = new Date().toISOString();
      return report;
    }

    const databaseUrl = resolvePostgresDatabaseUrl(input);
    report.targetDatabaseUrl = redactPostgresDatabaseUrl(databaseUrl);
    const client = createPostgresClient(databaseUrl);
    await client.connect();
    try {
      await withPostgresSchemaLock(client, async () => {
        // Forward-only guard（锁内复检）：若库已被更新实例推进到更高版本，旧实例不得执行语句或降级版本。
        // 显式标记 skipped_incompatible_schema——旧实现静默返回后外层仍报成功，令调用方误以为已迁入数据。
        if (await isPostgresSchemaNewerThanInstance(client)) {
          report.status = "skipped_incompatible_schema";
          return;
        }
        let transactionStarted = false;
        try {
          await client.query("BEGIN");
          transactionStarted = true;
          for (const statement of getPostgresSchemaStatements()) {
            await client.query(statement);
          }
          if (reset) {
            await truncatePostgresTables(client);
            await client.query(
              `INSERT INTO app_metadata (key, value)
               VALUES ('schema_version', $1)
               ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
               WHERE EXCLUDED.value ~ '^\d+$'
                 AND (app_metadata.value !~ '^\d+$' OR app_metadata.value::bigint <= EXCLUDED.value::bigint)`,
              [POSTGRES_SCHEMA_VERSION],
            );
          }

          if (!dryRun) {
            for (const [index, table] of snapshot.tables.entries()) {
              const insertedCount = await migrateTableRows(client, table);
              report.tables[index] = {
                tableName: table.tableName,
                sourceCount: table.rows.length,
                insertedCount,
                skippedCount: Math.max(table.rows.length - insertedCount, 0),
              };
            }

            // 行已迁入：同步回填 history_sequence + 在线 NOT NULL（维护命令承担请求路径移出的重型 DDL）。
            for (const statement of getPostgresHistoryBackfillStatements()) {
              await client.query(statement);
            }
            for (const statement of POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS) {
              await client.query(statement);
            }
            await setAppMetadataFlag(client, "schema_116_history_backfill_complete", "true");

            await client.query(
              `INSERT INTO app_metadata (key, value)
               VALUES ('migrated_from_sqlite_at', $1)
               ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
              [new Date().toISOString()],
            );
          }

          await client.query("COMMIT");
          transactionStarted = false;
          await applyPostCommitSchemaStatements(client);
        } catch (error) {
          if (transactionStarted) await client.query("ROLLBACK");
          throw error;
        }
      });
    } finally {
      await client.end();
    }

    report.finishedAt = new Date().toISOString();
    if (report.status === "skipped_incompatible_schema") {
      // 目标库版本更高：未执行任何语句、未导入任何数据。所有表保持 0 inserted / 全部 skipped，
      // 并追加警告——尤其要挡住下方 dryRun 分支把 insertedCount 篡改为 sourceCount 的误报。
      report.warnings.push(
        `目标库 schema_version 高于本实例（${POSTGRES_SCHEMA_VERSION}），已跳过全部语句与数据导入（status=skipped_incompatible_schema）。`,
      );
      report.tables = report.tables.map((table) => ({
        ...table,
        insertedCount: 0,
        skippedCount: table.sourceCount,
      }));
      return report;
    }
    if (dryRun) {
      report.tables = report.tables.map((table) => ({
        ...table,
        insertedCount: table.sourceCount,
        skippedCount: 0,
      }));
    }
    return report;
  } finally {
    sourceDb.close();
  }
}

export async function migratePostgresToPostgres(
  input: PostgresToPostgresMigrationInput,
): Promise<PostgresToPostgresMigrationReport> {
  const startedAt = new Date().toISOString();
  const sourceDatabaseUrl = input.sourceDatabaseUrl.trim();
  const targetDatabaseUrl = input.targetDatabaseUrl.trim();
  if (!sourceDatabaseUrl) {
    throw new Error("Missing source PostgreSQL database URL.");
  }
  if (!targetDatabaseUrl) {
    throw new Error("Missing target PostgreSQL database URL.");
  }
  if (sourceDatabaseUrl === targetDatabaseUrl) {
    throw new Error("Source and target PostgreSQL database URLs must be different.");
  }

  const sourceClient = createPostgresClient(sourceDatabaseUrl);
  const targetClient = createPostgresClient(targetDatabaseUrl);
  await sourceClient.connect();
  await targetClient.connect();
  try {
    const snapshot = await collectPostgresMigrationSnapshot(sourceClient);
    const report: PostgresToPostgresMigrationReport = {
      sourceDatabaseUrl: redactPostgresDatabaseUrl(sourceDatabaseUrl),
      targetDatabaseUrl: redactPostgresDatabaseUrl(targetDatabaseUrl),
      status: "completed",
      dryRun: input.dryRun === true,
      reset: input.reset === true,
      startedAt,
      finishedAt: startedAt,
      warnings: [],
      tables: snapshot.map((table) => ({
        tableName: table.tableName,
        sourceCount: table.rows.length,
        insertedCount: 0,
        skippedCount: table.rows.length,
      })),
    };

    if (input.dryRun) {
      // Forward-only guard（锁内复检）：dry-run 也必须复核目标库版本。旧实现在此直接返回 completed
      // 并把 insertedCount 预置为 sourceCount——目标库版本更高时，正式迁移会整库跳过，dry-run 却误报
      //「全部可插入」。锁内复检与正式迁移一致；dry-run 不执行任何 DDL/数据导入。
      await withPostgresSchemaLock(targetClient, async () => {
        if (await isPostgresSchemaNewerThanInstance(targetClient)) {
          report.status = "skipped_incompatible_schema";
        }
      });
      if (report.status === "skipped_incompatible_schema") {
        report.tables = report.tables.map((table) => ({
          ...table,
          insertedCount: 0,
          skippedCount: table.sourceCount,
        }));
        report.warnings.push(
          `目标库 schema_version 高于本实例（${POSTGRES_SCHEMA_VERSION}），已跳过全部语句与数据导入（status=skipped_incompatible_schema）。`,
        );
      } else {
        report.tables = report.tables.map((table) => ({
          ...table,
          insertedCount: table.sourceCount,
          skippedCount: 0,
        }));
      }
      report.finishedAt = new Date().toISOString();
      return report;
    }

    await withPostgresSchemaLock(targetClient, async () => {
      // Forward-only guard（锁内复检）：若库已被更新实例推进到更高版本，旧实例不得执行语句或降级版本。
      // 显式标记 skipped_incompatible_schema——旧实现静默返回后外层仍报成功，令调用方误以为已迁入数据。
      if (await isPostgresSchemaNewerThanInstance(targetClient)) {
        report.status = "skipped_incompatible_schema";
        return;
      }
      let transactionStarted = false;
      try {
        await targetClient.query("BEGIN");
        transactionStarted = true;
        for (const statement of getPostgresSchemaStatements()) {
          await targetClient.query(statement);
        }
        if (input.reset) {
          await truncatePostgresTables(targetClient);
          await targetClient.query(
            `INSERT INTO app_metadata (key, value)
             VALUES ('schema_version', $1)
             ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
             WHERE EXCLUDED.value ~ '^\d+$'
               AND (app_metadata.value !~ '^\d+$' OR app_metadata.value::bigint <= EXCLUDED.value::bigint)`,
            [POSTGRES_SCHEMA_VERSION],
          );
        }
        for (const [index, table] of snapshot.entries()) {
          const insertedCount = await migrateTableRows(targetClient, table);
          report.tables[index] = {
            tableName: table.tableName,
            sourceCount: table.rows.length,
            insertedCount,
            skippedCount: Math.max(table.rows.length - insertedCount, 0),
          };
        }
        // 行已迁入：同步回填 history_sequence + 在线 NOT NULL（维护命令承担请求路径移出的重型 DDL）。
        for (const statement of getPostgresHistoryBackfillStatements()) {
          await targetClient.query(statement);
        }
        for (const statement of POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS) {
          await targetClient.query(statement);
        }
        await setAppMetadataFlag(targetClient, "schema_116_history_backfill_complete", "true");
        await targetClient.query(
          `INSERT INTO app_metadata (key, value)
           VALUES ('migrated_from_postgres_at', $1)
           ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
          [new Date().toISOString()],
        );
        await targetClient.query("COMMIT");
        transactionStarted = false;
        await applyPostCommitSchemaStatements(targetClient);
      } catch (error) {
        if (transactionStarted) await targetClient.query("ROLLBACK");
        throw error;
      }
    });

    report.finishedAt = new Date().toISOString();
    if (report.status === "skipped_incompatible_schema") {
      // 目标库版本更高：未执行任何语句、未导入任何数据。所有表保持 0 inserted / 全部 skipped。
      report.tables = report.tables.map((table) => ({
        ...table,
        insertedCount: 0,
        skippedCount: table.sourceCount,
      }));
    }
    return report;
  } finally {
    await sourceClient.end();
    await targetClient.end();
  }
}

async function withPostgresSchemaLock<T>(client: PostgresQueryClient, operation: () => Promise<T>): Promise<T> {
  const acquiredLockIds: number[] = [];
  try {
    for (const lockId of POSTGRES_SCHEMA_ADVISORY_LOCK_IDS) {
      await client.query("SELECT pg_advisory_lock($1)", [lockId]);
      acquiredLockIds.push(lockId);
    }
    return await operation();
  } finally {
    for (const lockId of acquiredLockIds.reverse()) {
      await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    }
  }
}

/**
 * 指定索引是否处于无效状态（失败的后台 CREATE INDEX CONCURRENTLY 遗留）。
 * 仅当索引存在但 indisvalid/indisready 为假时返回 true；索引不存在时返回 false，
 * 交由后续 CREATE 语句新建。
 */
async function isPostgresIndexInvalid(client: PostgresQueryClient, indexName: string): Promise<boolean> {
  const result = await client.query(
    `SELECT index_state.indisvalid AS valid, index_state.indisready AS ready
     FROM pg_class AS index_relation
     JOIN pg_namespace AS index_namespace
       ON index_namespace.oid = index_relation.relnamespace
     JOIN pg_index AS index_state
       ON index_state.indexrelid = index_relation.oid
     WHERE index_namespace.nspname = current_schema()
       AND index_relation.relname = $1`,
    [indexName],
  );
  const row = result.rows[0] as { valid?: boolean; ready?: boolean } | undefined;
  if (!row) {
    return false;
  }
  return row.valid !== true || row.ready !== true;
}

export type PostgresQueryClient = Pick<Client, "query">;

/**
 * 在事务外应用在线索引语句。对每个 post-commit 索引：若上次 CREATE INDEX CONCURRENTLY 失败
 * 留下无效索引，先用 DROP INDEX CONCURRENTLY 清理（不取 ACCESS EXCLUSIVE 锁、不阻塞
 * workflow_run 写入），否则 CREATE INDEX CONCURRENTLY IF NOT EXISTS 会因索引已存在而跳过、
 * 留下坏索引。所有语句都不允许在事务块内执行。
 */
async function applyPostCommitSchemaStatements(client: PostgresQueryClient): Promise<void> {
  for (const indexName of POSTGRES_POST_COMMIT_INDEX_NAMES) {
    if (await isPostgresIndexInvalid(client, indexName)) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`);
    }
  }
  for (const statement of getPostgresPostCommitSchemaStatements()) {
    await client.query(statement);
  }
}

export async function applyPostCommitSchemaStatementsForTests(client: PostgresQueryClient): Promise<void> {
  return applyPostCommitSchemaStatements(client);
}

/**
 * 后台自愈专用锁（POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID = 117）。刻意与 schema 迁移锁
 * [115,116] 解耦：长耗时的回填/SET NOT NULL/在线建索引不阻塞第二实例冷启动迁移锁，反之亦然。
 * 阻塞型 pg_advisory_lock 串行化跨实例；后台任务 fire-and-forget，非请求路径。
 */
async function withBackgroundMaintenanceLock<T>(
  client: PostgresQueryClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("SELECT pg_advisory_lock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);
  try {
    return await operation();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID]);
  }
}

/**
 * 在后台自愈锁（117）保护下应用在线索引（事务外）。供显式测试与仅需索引的路径复用。
 * 不再占用 schema 迁移锁 [115,116]，避免长建索引期间阻塞第二实例冷启动迁移。
 */
async function applyConcurrentIndexesWithClient(client: PostgresQueryClient): Promise<void> {
  await withBackgroundMaintenanceLock(client, async () => {
    await applyPostCommitSchemaStatements(client);
  });
}

export async function applyConcurrentIndexesWithClientForTests(client: PostgresQueryClient): Promise<void> {
  return applyConcurrentIndexesWithClient(client);
}

async function readAppMetadataFlag(client: PostgresQueryClient, key: string): Promise<string | undefined> {
  const result = await client.query<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = $1 LIMIT 1",
    [key],
  );
  return result.rows[0]?.value;
}

async function setAppMetadataFlag(client: PostgresQueryClient, key: string, value: string): Promise<void> {
  await client.query(
    `INSERT INTO app_metadata (key, value)
     VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

/**
 * history_sequence 列当前是否可空。后台自愈据此决定是否施加 SET NOT NULL——一旦已 NOT NULL
 * 即跳过，避免每次冷启动重复 AEL 全扫。列不存在（结构段未跑）时返回 false，安全跳过。
 */
async function isHistorySequenceNullable(client: PostgresQueryClient): Promise<boolean> {
  const result = await client.query<{ is_nullable: "YES" | "NO" }>(
    `SELECT is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'workflow_run'
       AND column_name = 'history_sequence'`,
  );
  return result.rows[0]?.is_nullable === "YES";
}

/**
 * 后台自愈主体（已在锁 117 内）：分批 history 回填 → 条件 SET NOT NULL → 置完成 flag → 在线索引。
 * 幂等：flag 已置则跳过回填段；回填 UPDATE 的 WHERE history_sequence IS NULL 使干净库 no-op；
 * 分配触发器保证回填后新写入行序号大于已回填最大值，SET NOT NULL 不会因新行失败。flag 最后写，
 * 保证走到那一步前已无 NULL 行。在线索引无论 flag 状态都确保存在（幂等 + 无效清理）。
 *
 * 分批提交（Issue 7）：回填按 workspace 受限批次逐批独立事务提交——每批 `ws ... FOR UPDATE` 只锁
 * 本批 workspace（持有至该批 COMMIT），避免一次性锁住所有待迁移 workspace、持锁经过全量回填与 NOT NULL
 * 长时间阻塞这些 workspace 的新 Run 创建。任一批失败 ROLLBACK 不影响已提交批，下次冷启动从剩余 NULL 行
 * 续跑（回填 UPDATE 幂等）。全部 NULL 行清完后，最终事务施加在线 NOT NULL + 置 flag。
 */
async function runBackgroundMaintenance(
  client: PostgresQueryClient,
  options?: { batchLimit?: number },
): Promise<void> {
  const BACKFILL_FLAG = "schema_116_history_backfill_complete";
  const batchLimit = options?.batchLimit ?? POSTGRES_HISTORY_BACKFILL_BATCH_WORKSPACE_LIMIT;
  if (await readAppMetadataFlag(client, BACKFILL_FLAG) !== "true") {
    const { backfill, advance } = getPostgresHistoryBackfillStatementsForWorkspaces();
    // 逐批回填：取一批「仍有 NULL 行」的 workspace → 单事务 backfill + 推进计数器 → 提交。每批提交即
    // 释放该批 workspace 行锁，新 Run 创建仅被阻塞秒级（本批时长），而非全量回填时长。
    for (;;) {
      const pending = await client.query<{ workspace_id: string }>(
        POSTGRES_HISTORY_BACKFILL_PENDING_WORKSPACES_QUERY,
        [batchLimit],
      );
      const workspaceIds = pending.rows.map((row) => row.workspace_id);
      if (workspaceIds.length === 0) break;
      await runBackfillBatchInTransaction(client, backfill, advance, workspaceIds);
    }
    // 全局计数器修复：分批 advance 只覆盖「曾有 NULL 行」而被分批的 workspace。旧版本可能已回填某些
    // workspace 的 history_sequence（无 NULL 行）却未推进其 workflow_run_sequence 计数器——这类
    // workspace 不会被 pending 查询选中、永不进批，计数器停滞会导致触发器后续分配的序号与既有高序号
    // 碰撞。对所有 workspace 做一次全局 GREATEST 推进（WHERE < max 使已正确者 no-op），须在置 flag
    // 前，使「已标记完成」的库计数器必然已修复；单条 UPDATE 自成原子，无需显式事务。
    await client.query(POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT);
    // 回填全部完成（无 NULL 行）：施加在线 NOT NULL（若列仍可空）+ 置 flag，原子提交。新写入行由
    // 分配触发器保证非空，故 VALIDATE 不会因新行失败。
    if (await isHistorySequenceNullable(client)) {
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        for (const statement of POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS) {
          await client.query(statement);
        }
        await setAppMetadataFlag(client, BACKFILL_FLAG, "true");
        await client.query("COMMIT");
        transactionStarted = false;
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* rollback 失败 best-effort 吞掉，原错误优先抛出 */
          }
        }
        throw error;
      }
    } else {
      // 列已 NOT NULL（干净库或已施加）：回填已完成，直接置 flag。
      await setAppMetadataFlag(client, BACKFILL_FLAG, "true");
    }
  }
  await applyPostCommitSchemaStatements(client);
}

/** 单批回填事务：backfill（FOR UPDATE 锁本批 workspace）+ 推进计数器，原子提交。失败 ROLLBACK 重抛。 */
async function runBackfillBatchInTransaction(
  client: PostgresQueryClient,
  backfill: string,
  advance: string,
  workspaceIds: string[],
): Promise<void> {
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(backfill, [workspaceIds]);
    await client.query(advance, [workspaceIds]);
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* rollback 失败 best-effort 吞掉，原错误优先抛出 */
      }
    }
    throw error;
  }
}

export async function runBackgroundMaintenanceForTests(
  client: PostgresQueryClient,
  options?: { batchLimit?: number },
): Promise<void> {
  return runBackgroundMaintenance(client, options);
}

/**
 * 后台自愈入口：用独立 pg 连接（无 worker 超时上限）在锁 117 内完成 history 回填 + SET NOT NULL
 * + 运行历史在线索引。与 schema 迁移锁 [115,116] 解耦，不阻塞冷启动迁移；幂等（flag + WHERE NULL
 * + IF NOT EXISTS + 无效索引清理），失败由调用方记录。回填窗口期分页由 OR history_sequence IS NULL
 * 谓词保证不丢行；完成后 keyset 自动恢复 history_sequence 语义。
 */
export async function ensurePostgresConcurrentIndexes(input?: PostgresConnectionInput): Promise<void> {
  const databaseUrl = resolvePostgresDatabaseUrl(input);
  const client = createPostgresClient(databaseUrl);
  await client.connect();
  try {
    // Forward-only guard 须与 schema 迁移锁 [115,116] 形成统一串行边界：所有 schema_version 推进
    // （CLI/runtime/migrate）都经 [115,116]，故在 [115,116] 内复检版本并贯穿整个后台维护。旧实现
    // 锁外复核（与取锁 117 之间）存在 TOCTOU——期间另一实例可能已推进版本，本（旧）实例仍对已
    // 推进的新库执行回填/NOT NULL/建索引 DDL。复检须在取锁后进行（与 ensurePostgresSchema 一致）。
    // 维护期间持有 [115,116] 会串行化并发冷启动迁移（滚动升级窗口的一次性代价），换取前向安全；
    // 取锁顺序 [115,116]→117 与既有路径一致，无死锁；advisory lock 为会话级、不开启事务，不影响
    // 内部 CREATE INDEX CONCURRENTLY 等事务外语句。
    await withPostgresSchemaLock(client, async () => {
      if (await isPostgresSchemaNewerThanInstance(client)) {
        return;
      }
      await withBackgroundMaintenanceLock(client, async () => {
        await runBackgroundMaintenance(client);
      });
    });
  } finally {
    await client.end();
  }
}

export function collectSqliteMigrationSnapshotSync(
  sourceDb: DatabaseSync,
  fallbackTimestamp = new Date().toISOString(),
): {
  tables: TableMigrationSnapshot[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const tables: TableMigrationSnapshot[] = TABLE_MIGRATION_PLANS.map((plan) => ({
    tableName: plan.tableName,
    conflictColumns: [...plan.conflictColumns],
    jsonColumns: [...(plan.jsonColumns ?? [])],
    rows: readSqliteTableRowsSync(sourceDb, plan, warnings),
  }));
  filterMigrationTablesToSsoIdentities(tables);
  backfillStableEmployeeIds(tables, warnings);

  const workspaceSnapshots = tables.find((table) => table.tableName === "workspace_snapshot")?.rows as LegacyWorkspaceRow[] | undefined;
  const derivedAttachments = workspaceSnapshots
    ? extractAttachmentRowsFromLegacyWorkspaces(workspaceSnapshots, warnings, fallbackTimestamp)
    : [];
  const derivedAuditLogs = workspaceSnapshots
    ? extractAuditLogRowsFromLegacyWorkspaces(workspaceSnapshots, warnings, fallbackTimestamp)
    : [];

  const artifactGrantIndex = tables.findIndex((table) => table.tableName === "openmontage_artifact_grant");
  tables.splice(artifactGrantIndex >= 0 ? artifactGrantIndex : tables.length, 0, {
    tableName: "attachment",
    conflictColumns: ["workspace_id", "id"],
    jsonColumns: [],
    rows: derivedAttachments,
  });
  tables.push({
    tableName: "audit_log",
    conflictColumns: ["id"],
    jsonColumns: ["data_json"],
    rows: derivedAuditLogs,
  });

  return { tables, warnings };
}

export function renderPostgresCutoverPlan(): string {
  return [
    "# PostgreSQL Cutover Plan",
    "",
    "1. Prepare the target database",
    "   - Start PostgreSQL locally or in test using deploy/postgres/docker-compose.yml",
    "   - Run `pnpm run db:pg:init -- --database-url <postgres-url>`",
    "",
    "2. Rehearse migration in dry-run mode",
    "   - Run `pnpm run db:pg:migrate -- --dry-run --sqlite-path <sqlite-path> --database-url <postgres-url> --json`",
    "   - Confirm source counts and derived attachment / audit_log counts look correct",
    "",
    "3. Rehearse a full import into a disposable target",
    "   - Run `pnpm run db:pg:migrate -- --reset --sqlite-path <sqlite-path> --database-url <postgres-url> --json`",
    "   - Run `pnpm run db:pg:status -- --database-url <postgres-url> --json`",
    "",
    "4. Production cutover window",
    "   - Freeze writes to the SQLite-backed app",
    "   - Snapshot `data/dofe-agent.sqlite` and `data/workspaces/`",
    "   - Run the PostgreSQL migration with `--reset` against the production target",
    "   - Verify row counts and critical paths: login, workspace access, tasks, skills, attachments",
    "",
    "5. Rollback",
    "   - If verification fails, keep PostgreSQL frozen",
    "   - Restore the SQLite snapshot and revert traffic to the SQLite-backed deployment",
    "   - Investigate with the JSON migration report before the next rehearsal",
    "",
    "6. Rolling schema upgrades (forward-only version guard)",
    "   - schema_version is monotonic at the DB level: a BEFORE INSERT OR UPDATE trigger on",
    "     app_metadata raises check_violation if a newer version is overwritten with a lower one.",
    "   - Consequence: once version N is written, a still-running older binary (version < N)",
    "     that restarts will detect db_version != instance_version, attempt its own migration,",
    "     try to write its lower version, hit the trigger, and fail ensureRuntimeSchema —",
    "     i.e. it cannot open a database connection and will crash-loop until replaced.",
    "   - During a rolling deploy, drain/replace older binaries BEFORE or ALONGSIDE advancing",
    "     schema_version. In surge or host-reclamation scenarios this can briefly reduce capacity.",
    "   - Newer binaries are unaffected: an older schema is migrated upward normally, and a",
    "     newer-than-instance database is detected and skipped (no statements run, no version write).",
  ].join("\n");
}

function createPostgresClient(databaseUrl: string): Client {
  return new Client({
    connectionString: databaseUrl,
    ssl: shouldUsePostgresSsl(databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });
}

/**
 * Forward-only guard (async client variant): true when the database's
 * schema_version is strictly newer than this instance's
 * POSTGRES_SCHEMA_VERSION. A missing app_metadata table (fresh database) or a
 * non-numeric version is treated as "not newer" so a normal upward migration
 * can proceed. Mirrors isDatabaseSchemaNewerThanInstanceForTests in database.ts
 * but operates on an async pg Client instead of the sync PostgresSyncDatabase.
 */
async function isPostgresSchemaNewerThanInstance(client: PostgresQueryClient): Promise<boolean> {
  const table = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public.app_metadata') AS exists`,
  );
  if (table.rows[0]?.exists !== "app_metadata") {
    return false;
  }
  const versionResult = await client.query<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = 'schema_version' LIMIT 1",
  );
  const databaseVersion = versionResult.rows[0]?.value;
  if (!databaseVersion) {
    return false;
  }
  const databaseNumeric = Number.parseInt(databaseVersion, 10);
  const instanceNumeric = Number.parseInt(POSTGRES_SCHEMA_VERSION, 10);
  if (!Number.isFinite(databaseNumeric) || !Number.isFinite(instanceNumeric)) {
    return false;
  }
  return databaseNumeric > instanceNumeric;
}

async function readPostgresStatusWithClient(client: Client, databaseUrl: string): Promise<PostgresStatus> {
  const appMetadataExists = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public.app_metadata') AS exists`,
  );
  const hasSchema = Boolean(appMetadataExists.rows[0]?.exists);
  if (!hasSchema) {
    return {
      engine: "postgres",
      databaseUrl: redactPostgresDatabaseUrl(databaseUrl),
      schemaVersion: "uninitialized",
      tables: POSTGRES_TABLE_NAMES.map((tableName) => ({ tableName, rowCount: 0 })),
    };
  }

  const schemaVersionResult = await client.query<{ value: string }>(
    "SELECT value FROM app_metadata WHERE key = 'schema_version' LIMIT 1",
  );
  const tables: Array<{ tableName: PostgresTableName; rowCount: number }> = [];
  for (const tableName of POSTGRES_TABLE_NAMES) {
    const countResult = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${tableName}`);
    tables.push({
      tableName,
      rowCount: Number(countResult.rows[0]?.count ?? "0"),
    });
  }

  return {
    engine: "postgres",
    databaseUrl: redactPostgresDatabaseUrl(databaseUrl),
    schemaVersion: schemaVersionResult.rows[0]?.value ?? "unknown",
    tables,
  };
}

function shouldUsePostgresSsl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get("sslmode")?.trim().toLowerCase();
    return sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
  } catch {
    return false;
  }
}

async function truncatePostgresTables(client: Client): Promise<void> {
  // 排除 app_metadata：保留 schema_version 行，使 reset 后的版本写入（INSERT ON CONFLICT）
  // 命中既有行并触发单调守卫 WHERE 子句，无法把更高版本降级（Standards #2）。
  // reset 仍清空所有业务数据表；对已更新库用旧二进制 reset，schema_version 不变且降级被守卫拦下。
  const tablesToTruncate = [...POSTGRES_TABLE_NAMES]
    .filter((table) => table !== "app_metadata")
    .reverse();
  await client.query(`TRUNCATE TABLE ${tablesToTruncate.join(", ")} CASCADE`);
}

/** 测试入口：直接验证 reset 截断逻辑排除 app_metadata（保留 schema_version 等元数据）。 */
export async function truncatePostgresTablesForTests(client: Client): Promise<void> {
  return truncatePostgresTables(client);
}

async function migrateTableRows(client: Client, table: TableMigrationSnapshot): Promise<number> {
  let insertedCount = 0;
  for (const row of table.rows) {
    if (Object.keys(row).length === 0) {
      continue;
    }

    const columns = Object.keys(row);
    const values = columns.map((column) => normalizePostgresValue(column as JsonColumnName | string, row[column]));
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const updateColumns = columns.filter((column) => !table.conflictColumns.includes(column));
    const queryText =
      updateColumns.length > 0
        ? `INSERT INTO ${table.tableName} (${columns.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT (${table.conflictColumns.join(", ")}) DO UPDATE SET
           ${updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")}`
        : `INSERT INTO ${table.tableName} (${columns.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT (${table.conflictColumns.join(", ")}) DO NOTHING`;

    await client.query(queryText, values);
    insertedCount += 1;
  }
  return insertedCount;
}

function readSqliteTableRowsSync(
  sourceDb: DatabaseSync,
  plan: TableMigrationPlan,
  warnings: string[],
): MigrationRow[] {
  const sourceTableName = plan.sourceTableName ?? plan.tableName;
  if (!sqliteTableExists(sourceDb, sourceTableName)) {
    if (!plan.optionalWhenMissing) {
      warnings.push(`SQLite source table "${sourceTableName}" does not exist and was skipped.`);
    }
    return [];
  }

  const rows = sourceDb.prepare(
    `SELECT * FROM ${sourceTableName}${plan.orderBy ? ` ORDER BY ${plan.orderBy}` : ""}`,
  ).all() as MigrationRow[];

  return rows.map((row) => normalizeSqliteRow(row, plan.jsonColumns ?? []));
}

function backfillStableEmployeeIds(tables: TableMigrationSnapshot[], warnings: string[]): void {
  const employeeRows = tables.find((table) => table.tableName === "workspace_employee")?.rows ?? [];
  const employeeIds = new Map<string, string>();
  for (const row of employeeRows) {
    if (typeof row.workspace_id === "string" && typeof row.name === "string") {
      const key = `${row.workspace_id}\u0000${row.name.trim().toLowerCase()}`;
      const employeeId = typeof row.id === "string" && row.id.trim()
        ? row.id.trim()
        : `employee-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
      row.id = employeeId;
      employeeIds.set(key, employeeId);
    }
  }

  for (const tableName of [
    "employee_runtime_binding",
    "agent_skill",
    "agent_skill_requirement_config",
    "agent_knowledge_page",
  ]) {
    const table = tables.find((candidate) => candidate.tableName === tableName);
    if (!table) continue;
    table.rows = table.rows.filter((row) => {
      const existingId = typeof row.employee_id === "string" ? row.employee_id.trim() : "";
      const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
      const employeeName = typeof row.employee_name === "string" ? row.employee_name.trim() : "";
      const employeeId = existingId || employeeIds.get(`${workspaceId}\u0000${employeeName.toLowerCase()}`);
      if (!employeeId) {
        warnings.push(
          `SQLite ${tableName} row for employee "${employeeName || "(missing)"}" in workspace "${workspaceId || "(missing)"}" was skipped because no stable employee id exists.`,
        );
        return false;
      }
      row.employee_id = employeeId;
      if (tableName === "agent_skill" || tableName === "agent_knowledge_page") {
        row.agent_id = employeeId;
      }
      return true;
    });
  }

  const taskQueue = tables.find((candidate) => candidate.tableName === "agent_task_queue");
  if (taskQueue) {
    for (const row of taskQueue.rows) {
      const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : "";
      const legacyAgentId = typeof row.agent_id === "string" ? row.agent_id.trim() : "";
      const employeeId = employeeIds.get(`${workspaceId}\u0000${legacyAgentId.toLowerCase()}`) ?? legacyAgentId;
      if (employeeId) row.employee_id = employeeId;
      const employee = employeeRows.find((candidate) => candidate.id === employeeId && candidate.workspace_id === workspaceId);
      if (typeof employee?.name === "string") row.employee_name = employee.name;
    }
  }
}

async function collectPostgresMigrationSnapshot(client: Client): Promise<TableMigrationSnapshot[]> {
  const tables: TableMigrationSnapshot[] = [];
  for (const tableName of POSTGRES_TABLE_NAMES) {
    if (tableName === "app_metadata") {
      tables.push({
        tableName,
        conflictColumns: ["key"],
        jsonColumns: [],
        rows: await readPostgresTableRows(client, tableName),
      });
      continue;
    }
    if (tableName === "attachment") {
      tables.push({
        tableName,
        conflictColumns: ["workspace_id", "id"],
        jsonColumns: [],
        rows: await readPostgresTableRows(client, tableName),
      });
      continue;
    }
    if (tableName === "audit_log") {
      tables.push({
        tableName,
        conflictColumns: ["id"],
        jsonColumns: ["data_json"],
        rows: await readPostgresTableRows(client, tableName),
      });
      continue;
    }

    const plan = TABLE_MIGRATION_PLANS.find((candidate) => candidate.tableName === tableName);
    if (!plan) {
      continue;
    }
    tables.push({
      tableName,
      conflictColumns: [...plan.conflictColumns],
      jsonColumns: [...(plan.jsonColumns ?? [])],
      rows: await readPostgresTableRows(client, tableName),
    });
  }
  filterMigrationTablesToSsoIdentities(tables);
  return tables;
}

function filterMigrationTablesToSsoIdentities(tables: TableMigrationSnapshot[]): void {
  const identityTable = tables.find((table) => table.tableName === "auth_identity");
  if (!identityTable) {
    return;
  }

  identityTable.rows = identityTable.rows.filter((row) => row.provider === "sso");
  const ssoUserIds = new Set(
    identityTable.rows
      .map((row) => row.user_id)
      .filter((userId): userId is string => typeof userId === "string" && userId.length > 0),
  );
  const sessionTable = tables.find((table) => table.tableName === "session");
  if (sessionTable) {
    sessionTable.rows = sessionTable.rows.filter((row) =>
      typeof row.user_id === "string" && ssoUserIds.has(row.user_id),
    );
  }
}

async function readPostgresTableRows(client: Client, tableName: PostgresTableName): Promise<MigrationRow[]> {
  const result = await client.query(`SELECT * FROM ${tableName}`);
  return result.rows.map((row) => {
    const next: MigrationRow = {};
    for (const [key, value] of Object.entries(row)) {
      next[camelToSnakeCase(key)] = value instanceof Date ? value.toISOString() : value;
    }
    return next;
  });
}

function camelToSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function sqliteTableExists(sourceDb: DatabaseSync, tableName: string): boolean {
  const row = sourceDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function normalizeSqliteRow(row: MigrationRow, jsonColumns: JsonColumnName[]): MigrationRow {
  const next: MigrationRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) {
      continue;
    }

    if (jsonColumns.includes(key as JsonColumnName)) {
      next[key] = parseJsonLikeValue(value);
      continue;
    }

    next[key] = value;
  }
  return next;
}

function parseJsonLikeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return trimmed;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return value;
}

function normalizePostgresValue(_column: string, value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

function extractAttachmentRowsFromLegacyWorkspaces(
  workspaces: LegacyWorkspaceRow[],
  warnings: string[],
  fallbackTimestamp: string,
): DerivedAttachmentRow[] {
  const rows: DerivedAttachmentRow[] = [];

  for (const workspace of workspaces) {
    const state = readLegacyWorkspaceStateJson(workspace, warnings);
    if (!state) {
      continue;
    }

    for (const [messageIndex, message] of state.messages.entries()) {
      for (const attachment of message.attachments ?? []) {
        if (attachment.deletedAt) {
          continue;
        }
        rows.push(buildAttachmentRow(workspace, message, attachment, messageIndex, fallbackTimestamp));
      }
    }
  }

  return rows;
}

function extractAuditLogRowsFromLegacyWorkspaces(
  workspaces: LegacyWorkspaceRow[],
  warnings: string[],
  fallbackTimestamp: string,
): DerivedAuditLogRow[] {
  const rows: DerivedAuditLogRow[] = [];

  for (const workspace of workspaces) {
    const state = readLegacyWorkspaceStateJson(workspace, warnings);
    if (!state) {
      continue;
    }

    for (const [index, entry] of state.ledger.entries()) {
      rows.push({
        id: `audit-${workspace.id}-${index + 1}`,
        workspace_id: workspace.id,
        title: entry.title,
        note: entry.note,
        code: entry.code ?? null,
        data_json: entry.data ?? {},
        source: "workspace_snapshot_ledger",
        source_index: index,
        created_at: workspace.updated_at || workspace.created_at || fallbackTimestamp,
      });
    }
  }

  return rows;
}

function buildAttachmentRow(
  workspace: LegacyWorkspaceRow,
  message: WorkspaceMessage,
  attachment: MessageAttachment,
  messageIndex: number,
  fallbackTimestamp: string,
): DerivedAttachmentRow {
  return {
    workspace_id: workspace.id,
    id: attachment.id,
    message_id: message.id,
    channel_name: message.channel ?? null,
    speaker: message.speaker,
    role: message.role,
    file_name: attachment.fileName,
    media_type: attachment.mediaType,
    kind: attachment.kind,
    size_bytes: attachment.sizeBytes,
    stored_path: attachment.storedPath,
    storage_provider: attachment.storageProvider ?? "tos",
    storage_bucket: attachment.storageBucket ?? null,
    storage_region: attachment.storageRegion ?? null,
    storage_endpoint: attachment.storageEndpoint ?? null,
    storage_key: attachment.storageKey ?? null,
    storage_url: attachment.storageUrl ?? null,
    sha256: attachment.sha256 ?? null,
    source_message_time: message.time,
    source_message_index: messageIndex,
    source_summary: message.summary,
    created_at: workspace.updated_at || workspace.created_at || fallbackTimestamp,
  };
}

function readLegacyWorkspaceStateJson(
  workspace: LegacyWorkspaceRow,
  warnings: string[],
): DofeAgentState | null {
  if (workspace.state_json && typeof workspace.state_json === "object") {
    return workspace.state_json as DofeAgentState;
  }

  try {
    return JSON.parse(workspace.state_json) as DofeAgentState;
  } catch (error) {
    warnings.push(
      `Could not parse migrated workspace snapshot JSON for workspace "${workspace.id}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function readSqliteSchemaVersionSync(sourceDb: DatabaseSync): string {
  if (!sqliteTableExists(sourceDb, "app_metadata")) {
    return "unknown";
  }

  const row = sourceDb.prepare(
    "SELECT value FROM app_metadata WHERE key = 'schema_version' LIMIT 1",
  ).get() as { value?: string } | undefined;
  return row?.value ?? "unknown";
}

async function openSqliteDatabase(sqlitePath: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(sqlitePath);
}

export function getDefaultSqliteMigrationPath(): string {
  return join(getDataDirPath(), "dofe-agent.sqlite");
}
