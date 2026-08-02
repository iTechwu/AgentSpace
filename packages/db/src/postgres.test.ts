import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectSqliteMigrationSnapshotSync, redactPostgresDatabaseUrl, renderPostgresCutoverPlan } from "./postgres.ts";
import { getPostgresSchemaStatements, POSTGRES_SCHEMA_VERSION, POSTGRES_TABLE_NAMES } from "./postgres-schema.ts";

test("postgres schema includes the expected core and derived tables", () => {
  const statements = getPostgresSchemaStatements().join("\n");

  for (const tableName of POSTGRES_TABLE_NAMES) {
    assert.match(statements, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.doesNotMatch(statements, /CREATE TABLE IF NOT EXISTS legacy_workspace/);
  assert.match(statements, /ALTER TABLE legacy_workspace RENAME TO workspace_snapshot/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS attachment/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS audit_log/);
  assert.match(statements, /ALTER TABLE token_usage ALTER COLUMN task_queue_id DROP NOT NULL/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS token_usage_retry/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS token_usage_reconciliation_cursor/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS runtime_credential_reconciliation_target/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS runtime_maintenance_run/);
  assert.match(statements, /CREATE TABLE IF NOT EXISTS token_usage_billing_event/);
  assert.match(statements, /ADD COLUMN IF NOT EXISTS gateway_usage_id TEXT/);
  assert.match(statements, /CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_workspace_gateway_usage_unique/);
  assert.match(statements, /idx_agent_runtime_workspace_daemon_provider[\s\S]*WHERE managed_credential_id IS NULL/);
  assert.match(statements, /ADD COLUMN IF NOT EXISTS cache_tokens INTEGER NOT NULL DEFAULT 0/);
  assert.match(statements, /workspace_snapshot_ledger/);
  assert.match(statements, /CREATE UNIQUE INDEX IF NOT EXISTS idx_external_integration_provider_app_tenant/);
  assert.match(statements, /ON external_integration\(workspace_id, provider, app_id, COALESCE\(tenant_key, ''\)\)/);
  assert.match(statements, /ALTER TABLE external_resource_binding\s+ADD COLUMN IF NOT EXISTS dofe_agent_resource_type TEXT/);
  assert.match(statements, /ALTER TABLE external_resource_binding\s+ADD COLUMN IF NOT EXISTS dofe_agent_resource_id TEXT/);
  assert.match(statements, /DROP COLUMN IF EXISTS agent_space_resource_type/);
  assert.match(statements, /DROP COLUMN IF EXISTS agent_space_resource_id/);
  assert.match(statements, /ALTER TABLE external_message_mapping\s+ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT/);
  assert.match(statements, /ALTER TABLE external_message_outbox\s+ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT/);
  assert.match(statements, /ALTER TABLE external_thread_binding\s+ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT/);
});

test("postgres schema enforces SSO-only identities", () => {
  const statements = getPostgresSchemaStatements().join("\n");

  assert.equal(POSTGRES_SCHEMA_VERSION, "91");
  assert.match(statements, /ADD COLUMN IF NOT EXISTS worker_lease_token TEXT/);
  assert.match(statements, /ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ/);
  assert.match(statements, /runtime_workspace_mount_operation\s+ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ/);
  assert.match(statements, /runtime_workspace_mount_operation\s+ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(statements, /DROP CONSTRAINT IF EXISTS employee_workspace_revision_workspace_id_ref_manifest_diges_key/);
  assert.match(statements, /ADD COLUMN IF NOT EXISTS restored_from_revision_id TEXT/);
  assert.match(statements, /ALTER TABLE daemon_api_token\s+ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'general'/);
  assert.match(statements, /DELETE FROM session WHERE user_id NOT IN \(SELECT user_id FROM auth_identity WHERE provider = 'sso'\)/);
  assert.match(statements, /DELETE FROM auth_identity WHERE provider <> 'sso'/);
  assert.match(statements, /auth_identity_provider_check CHECK \(provider = 'sso'\)/);
  assert.match(statements, /idx_skill_upgrade_approval_policy_lock/);
});

test("token usage gateway usage uniqueness migration clears duplicate remote identifiers first", () => {
  const statements = getPostgresSchemaStatements();
  const deduplicateUsageIds = statements.findIndex((statement) =>
    statement.includes("PARTITION BY workspace_id, gateway_usage_id"),
  );
  const uniqueUsageIdIndex = statements.findIndex((statement) =>
    statement.includes("idx_token_usage_workspace_gateway_usage_unique"),
  );

  assert.ok(deduplicateUsageIds >= 0 && deduplicateUsageIds < uniqueUsageIdIndex);
});

test("postgres schema adds cleanup retry columns before creating dependent indexes", () => {
  const statements = getPostgresSchemaStatements();
  const nextAttemptColumn = statements.findIndex((statement) =>
    statement.includes("ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ"),
  );
  const claimedAtColumn = statements.findIndex((statement) =>
    statement.includes("ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ"),
  );
  const dueIndex = statements.findIndex((statement) =>
    statement.includes("idx_managed_runtime_cleanup_request_due"),
  );
  const timeoutIndex = statements.findIndex((statement) =>
    statement.includes("idx_managed_runtime_cleanup_request_running_timeout"),
  );

  assert.ok(nextAttemptColumn >= 0 && nextAttemptColumn < dueIndex);
  assert.ok(claimedAtColumn >= 0 && claimedAtColumn < timeoutIndex);
});

test("token usage uniqueness migration merges actual billing facts before deleting duplicates", () => {
  const statements = getPostgresSchemaStatements();
  const mergeIndex = statements.findIndex((statement) =>
    statement.includes("UPDATE token_usage AS keeper") && statement.includes("actual_cost_usd"),
  );
  const deleteIndex = statements.findIndex((statement) =>
    statement.includes("DELETE FROM token_usage") && statement.includes("duplicate_rank"),
  );
  const uniqueIndex = statements.findIndex((statement) =>
    statement.includes("idx_token_usage_workspace_gateway_request_unique"),
  );

  assert.ok(mergeIndex >= 0 && mergeIndex < deleteIndex);
  assert.ok(deleteIndex < uniqueIndex);
  assert.match(statements[mergeIndex]!, /WHEN task_queue_id IS NOT NULL THEN 0/);
  assert.match(statements[mergeIndex]!, /actuals\.runtime_credential_id IS NULL/);
  assert.ok(statements.some((statement) =>
    statement.includes("UPDATE token_usage AS conflicting")
      && statement.includes("SET gateway_request_id = NULL"),
  ));
});

test("collectSqliteMigrationSnapshotSync extracts relational rows and derived attachments/audit logs", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-pg-migration-"));
  const sqlitePath = join(tempRoot, "dofe-agent.sqlite");
  const db = new DatabaseSync(sqlitePath);

  try {
    db.exec(`
      CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO app_metadata (key, value) VALUES ('schema_version', '5');

      CREATE TABLE workspace (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        primary_email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE auth_identity (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        revoked_at TEXT
      );

      CREATE TABLE workspace_membership (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        invited_by TEXT
      );

      CREATE TABLE legacy_workspace (
        id TEXT PRIMARY KEY,
        organization_name TEXT NOT NULL,
        pending_handoffs INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workspace_channel (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        human_member_names_json TEXT NOT NULL,
        human_member_count INTEGER NOT NULL,
        employee_names_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE channel_participant (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        added_by TEXT,
        joined_at TEXT NOT NULL,
        removed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE channel_access_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        note TEXT
      );

      CREATE TABLE channel_invitation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        invitee_user_id TEXT,
        invitee_email TEXT,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        responded_at TEXT,
        responded_by TEXT
      );

      CREATE TABLE workspace_employee (
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        remark_name TEXT,
        origin TEXT NOT NULL,
        summary TEXT NOT NULL,
        traits_json TEXT NOT NULL,
        fit TEXT NOT NULL,
        status TEXT NOT NULL,
        instructions TEXT NOT NULL,
        owner_user_id TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_fork_invitation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_agent_name TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        accepted_agent_name TEXT,
        accepted_runtime_id TEXT
      );

      CREATE TABLE agent_fork_snapshot (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        invitation_id TEXT NOT NULL,
        source_agent_name TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE workspace_task (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        assignee TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_order INTEGER,
        labels_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE daemon_connection (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        daemon_key TEXT NOT NULL,
        device_name TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        last_heartbeat_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE daemon_api_token (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE agent_runtime (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        daemon_connection_id TEXT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        device_info TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        connected_at TEXT,
        last_heartbeat_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workspace_runtime_display_name (
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        updated_by_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE workspace_runtime_grant (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        status TEXT NOT NULL,
        granted_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE document_agent_access (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        role TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE document_permission_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        document_id TEXT,
        external_provider TEXT,
        external_file_id TEXT,
        external_url TEXT,
        requested_role TEXT NOT NULL,
        requested_by_agent_name TEXT NOT NULL,
        requested_for_channel_name TEXT,
        triggered_by_user_id TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by_user_id TEXT,
        decision_note TEXT,
        source_task_id TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE workspace_notification (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        recipient_type TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        actor_type TEXT,
        actor_id TEXT,
        type TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        channel_name TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        action_href TEXT,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        archived_at TEXT
      );

      CREATE TABLE employee_runtime_binding (
        workspace_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runtime_app_catalog_item (
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        version TEXT NOT NULL,
        category TEXT NOT NULL,
        entry_point TEXT NOT NULL,
        install_strategy TEXT NOT NULL,
        install_cmd TEXT,
        uninstall_cmd TEXT,
        update_cmd TEXT,
        skill_md TEXT,
        requires_text TEXT,
        homepage TEXT,
        registry_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE runtime_installed_app (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        version TEXT NOT NULL,
        entry_point TEXT NOT NULL,
        status TEXT NOT NULL,
        install_strategy TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        installed_by_user_id TEXT,
        installed_at TEXT,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_error TEXT,
        metadata_json TEXT NOT NULL
      );

      CREATE TABLE runtime_app_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        app_source TEXT NOT NULL,
        app_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_user_id TEXT,
        command_plan_json TEXT NOT NULL,
        safe_stdout_tail TEXT,
        safe_stderr_tail TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE skill (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE skill_file (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE runtime_app_skill_binding (
        workspace_id TEXT NOT NULL,
        runtime_app_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE skill_import_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        skill_id TEXT,
        skill_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        import_mode TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE agent_skill (
        workspace_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_page_assignment_policy (
        workspace_id TEXT NOT NULL,
        knowledge_page_id TEXT NOT NULL,
        assignment_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      CREATE TABLE agent_knowledge_page (
        workspace_id TEXT NOT NULL,
        agent_id TEXT,
        employee_name TEXT NOT NULL,
        knowledge_page_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL
      );

      CREATE TABLE agent_task_queue (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        issue_id TEXT,
        trigger_type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        requested_by_user_id TEXT,
        requested_by_display_name TEXT,
        result_json TEXT,
        error_text TEXT,
        session_id TEXT,
        work_dir TEXT,
        queued_at TEXT NOT NULL,
        claimed_at TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE task_execution_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runtime_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        severity TEXT NOT NULL,
        status TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE task_message (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        content TEXT,
        input_json TEXT,
        output TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE model_pricing (
        model_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        input_per_1m REAL NOT NULL,
        output_per_1m REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE token_usage (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_queue_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        channel_name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE budget (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        limit_usd REAL NOT NULL,
        period TEXT NOT NULL,
        action TEXT NOT NULL,
        warning_threshold REAL NOT NULL,
        enabled INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const timestamp = "2026-04-23T12:00:00.000Z";
    db.prepare(
      `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run("default", "default", "Northstar Labs", "", timestamp, timestamp);
    db.prepare(
      `INSERT INTO users (id, display_name, avatar_url, primary_email, created_at, updated_at, last_login_at)
       VALUES (?, ?, NULL, ?, ?, ?, NULL)`,
    ).run("user-1", "techwu", "techwu@example.com", timestamp, timestamp);
    db.prepare(
      `INSERT INTO auth_identity (id, user_id, provider, provider_subject, email, email_verified, profile_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("identity-1", "user-1", "legacy", "techwu@example.com", "techwu@example.com", 1, "{}", timestamp, timestamp);
    db.prepare(
      `INSERT INTO session (id, user_id, token_hash, expires_at, last_seen_at, created_at, ip_address, user_agent, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run("session-1", "user-1", "hash", timestamp, timestamp, timestamp);
    db.prepare(
      `INSERT INTO workspace_membership (id, workspace_id, user_id, role, status, joined_at, invited_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run("membership-1", "default", "user-1", "owner", "active", timestamp);

    const stateJson = JSON.stringify({
      organizationName: "Northstar Labs",
      pendingHandoffs: 0,
      humanMembers: [{ name: "techwu", role: "Founder" }],
      skills: [],
      activeEmployees: [],
      directConversations: [],
      channels: [],
      channelDocuments: [],
      channelDocumentVersions: [],
      channelDocumentBlocks: [],
      channelDocumentAccesses: [],
      channelDocumentChangeSets: [],
      channelDocumentConflicts: [],
      channelDocumentPresences: [],
      channelDocumentRuns: [],
      channelDocumentRunSteps: [],
      materials: [],
      knowledgePages: [],
      messages: [
        {
          id: "message-1",
          channel: "north-ops",
          speaker: "Atlas",
          role: "agent",
          time: "10:00",
          summary: "Attached itinerary",
          attachments: [
            {
              id: "att-1",
              fileName: "itinerary.md",
              mediaType: "text/markdown",
              sizeBytes: 42,
              kind: "file",
              storedPath: "tos://test-bucket/workspaces/default/attachments/att-1/itinerary.md",
              storageProvider: "tos",
              storageKey: "workspaces/default/attachments/att-1/itinerary.md",
            },
          ],
        },
      ],
      tasks: [],
      approvals: [],
      dataTables: [],
      automationRules: [],
      scheduledTasks: [],
      templates: [],
      ledger: [
        {
          title: "Workspace access denied",
          note: "Cross-workspace request blocked",
          code: "workspace.cross_workspace_access_denied",
          data: { actorType: "session_user" },
        },
      ],
    });
    db.prepare(
      `INSERT INTO legacy_workspace (id, organization_name, pending_handoffs, state_json, state_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("default", "Northstar Labs", 0, stateJson, 5, timestamp, timestamp);
    db.prepare(
      `INSERT INTO agent_fork_invitation (
        id, workspace_id, source_agent_name, target_user_id, status, options_json,
        created_by_user_id, created_at, updated_at, accepted_at, revoked_at,
        accepted_agent_name, accepted_runtime_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
      "fork-invite-1",
      "default",
      "Planner",
      "user-1",
      "pending",
      "{\"copyProfile\":true}",
      "user-1",
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO agent_fork_snapshot (
        id, workspace_id, invitation_id, source_agent_name, snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "fork-snapshot-1",
      "default",
      "fork-invite-1",
      "Planner",
      "{\"skillIds\":[],\"knowledgePageIds\":[]}",
      timestamp,
    );
  } finally {
    db.close();
  }

  try {
    const sourceDb = new DatabaseSync(sqlitePath);
    const snapshot = collectSqliteMigrationSnapshotSync(sourceDb, "2026-04-23T13:00:00.000Z");

    const workspaceRows = snapshot.tables.find((table) => table.tableName === "workspace")?.rows ?? [];
    const authIdentityRows = snapshot.tables.find((table) => table.tableName === "auth_identity")?.rows ?? [];
    const sessionRows = snapshot.tables.find((table) => table.tableName === "session")?.rows ?? [];
    const workspaceSnapshotRows = snapshot.tables.find((table) => table.tableName === "workspace_snapshot")?.rows ?? [];
    const forkInvitationRows = snapshot.tables.find((table) => table.tableName === "agent_fork_invitation")?.rows ?? [];
    const forkSnapshotRows = snapshot.tables.find((table) => table.tableName === "agent_fork_snapshot")?.rows ?? [];
    const attachmentRows = snapshot.tables.find((table) => table.tableName === "attachment")?.rows ?? [];
    const auditLogRows = snapshot.tables.find((table) => table.tableName === "audit_log")?.rows ?? [];

    assert.equal(workspaceRows.length, 1);
    assert.equal(authIdentityRows.length, 0);
    assert.equal(sessionRows.length, 0);
    assert.equal(workspaceSnapshotRows.length, 1);
    assert.equal(forkInvitationRows.length, 1);
    assert.equal(forkSnapshotRows.length, 1);
    assert.equal(attachmentRows.length, 1);
    assert.equal(auditLogRows.length, 1);
    assert.equal((attachmentRows[0] as { workspace_id?: string }).workspace_id, "default");
    assert.equal((auditLogRows[0] as { code?: string }).code, "workspace.cross_workspace_access_denied");
    assert.equal((auditLogRows[0] as { source?: string }).source, "workspace_snapshot_ledger");
    assert.deepEqual(snapshot.warnings, []);
    sourceDb.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("redactPostgresDatabaseUrl hides passwords and cutover plan references the new commands", () => {
  assert.equal(
    redactPostgresDatabaseUrl("postgres://agent:secret@example.com:5432/dofe_agent"),
    "postgres://agent:***@example.com:5432/dofe_agent",
  );
  assert.match(renderPostgresCutoverPlan(), /pnpm run db:pg:init/);
  assert.match(renderPostgresCutoverPlan(), /pnpm run db:pg:migrate/);
});
