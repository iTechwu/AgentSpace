export const POSTGRES_SCHEMA_VERSION = "76";

export const POSTGRES_TABLE_NAMES = [
  "app_metadata",
  "workspace",
  "users",
  "auth_identity",
  "session",
  "workspace_membership",
  "external_integration",
  "external_user_binding",
  "external_channel_binding",
  "external_resource_binding",
  "external_message_mapping",
  "external_message_outbox",
  "external_data_operation_run",
  "external_integration_event",
  "workspace_snapshot",
  "workspace_channel",
  "channel_participant",
  "channel_access_request",
  "channel_invitation",
  "workspace_employee",
  "agent_fork_invitation",
  "agent_fork_snapshot",
  "workspace_task",
  "daemon_connection",
  "daemon_api_token",
  "provider_account",
  "agent_runtime",
  "runtime_provision_request",
  "workspace_runtime_display_name",
  "workspace_runtime_grant",
  "document_agent_access",
  "document_permission_request",
  "agent_access_request",
  "workspace_notification",
  "employee_runtime_binding",
  "runtime_app_catalog_item",
  "runtime_installed_app",
  "runtime_app_operation",
  "skill",
  "skill_file",
  "runtime_app_skill_binding",
  "skill_import_event",
  "agent_skill",
  "agent_skill_requirement_config",
  "knowledge_page_assignment_policy",
  "agent_knowledge_page",
  "knowledge_proposal",
  "agent_router_session",
  "agent_router_provider_session",
  "agent_task_queue",
  "external_thread_binding",
  "agent_task_attempt",
  "agent_router_event",
  "agent_router_context_snapshot",
  "task_execution_event",
  "task_message",
  "model_pricing",
  "token_usage",
  "token_usage_billing_event",
  "token_usage_retry",
  "token_usage_reconciliation_cursor",
  "runtime_credential_reconciliation_target",
  "runtime_maintenance_run",
  "budget",
  "attachment",
  "audit_log",
  "workspace_sso_binding",
  "runtime_provisioning_task",
  "runtime_provisioning_task_event",
  "runtime_credential_recovery_task",
  "managed_runtime_cleanup_request",
  "mcp_catalog_item",
  "runtime_mcp_connection",
  "runtime_mcp_secret",
  "runtime_mcp_discovery_snapshot",
  "runtime_mcp_operation",
  "runtime_mcp_tool_audit",
  "mcp_task_session_grant",
  "content_blob",
  "skill_artifact",
  "skill_artifact_binding",
  "skill_artifact_file",
  "skill_installation",
  "skill_installation_operation",
  "skill_upgrade_approval",
  "skill_installation_component",
  "skill_service_catalog",
  "managed_skill_service",
  "skill_service_binding",
  "managed_skill_service_operation",
  "employee_persistent_workspace",
  "employee_workspace_revision",
  "employee_artifact",
  "task_commit_journal",
  "employee_recovery_operation",
] as const;

export type PostgresTableName = (typeof POSTGRES_TABLE_NAMES)[number];

export function getPostgresSchemaStatements(): string[] {
  return [
    `
      CREATE EXTENSION IF NOT EXISTS "pgcrypto"
    `,
    `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        primary_email TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_login_at TIMESTAMPTZ
      )
    `,
    `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0
    `,
    `
      CREATE TABLE IF NOT EXISTS auth_identity (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(provider, provider_subject)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS session (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        revoked_at TIMESTAMPTZ
      )
    `,
    `DELETE FROM session WHERE user_id NOT IN (SELECT user_id FROM auth_identity WHERE provider = 'sso')`,
    `DELETE FROM auth_identity WHERE provider <> 'sso'`,
    `ALTER TABLE auth_identity DROP CONSTRAINT IF EXISTS auth_identity_provider_check`,
    `ALTER TABLE auth_identity ADD CONSTRAINT auth_identity_provider_check CHECK (provider = 'sso')`,
    `
      CREATE TABLE IF NOT EXISTS workspace_membership (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        joined_at TIMESTAMPTZ NOT NULL,
        invited_by TEXT,
        UNIQUE(workspace_id, user_id)
      )
    `,
    // external_* bindings reference workspace_channel, so create it before those tables.
    `
      CREATE TABLE IF NOT EXISTS workspace_channel (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'group',
        human_member_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        human_member_count INTEGER NOT NULL DEFAULT 0,
        employee_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS external_integration (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        transport_mode TEXT NOT NULL,
        agent_id TEXT,
        app_id TEXT,
        tenant_key TEXT,
        encrypted_credentials_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        scopes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        disabled_at TIMESTAMPTZ,
        last_health_status TEXT,
        last_health_checked_at TIMESTAMPTZ,
        last_error TEXT,
        UNIQUE(workspace_id, provider, display_name)
      )
    `,
    `
      ALTER TABLE external_integration
        ADD COLUMN IF NOT EXISTS agent_id TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS external_user_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        external_user_id TEXT NOT NULL,
        external_union_id TEXT,
        external_open_id TEXT,
        external_email TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ,
        UNIQUE(integration_id, user_id),
        UNIQUE(integration_id, external_user_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS external_channel_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        channel_name TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        external_chat_type TEXT,
        external_chat_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sync_mode TEXT NOT NULL DEFAULT 'mirror',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        disabled_at TIMESTAMPTZ,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE,
        UNIQUE(integration_id, channel_name),
        UNIQUE(integration_id, external_chat_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS external_resource_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        provider_resource_type TEXT NOT NULL,
        provider_resource_token TEXT NOT NULL,
        provider_resource_url TEXT,
        dofe_agent_resource_type TEXT NOT NULL,
        dofe_agent_resource_id TEXT NOT NULL,
        channel_name TEXT,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE,
        UNIQUE(integration_id, provider_resource_type, provider_resource_token)
      )
    `,
    `
      ALTER TABLE external_resource_binding
        ADD COLUMN IF NOT EXISTS dofe_agent_resource_type TEXT
    `,
    `
      ALTER TABLE external_resource_binding
        ADD COLUMN IF NOT EXISTS dofe_agent_resource_id TEXT
    `,
    `ALTER TABLE external_resource_binding DROP COLUMN IF EXISTS agent_space_resource_type`,
    `ALTER TABLE external_resource_binding DROP COLUMN IF EXISTS agent_space_resource_id`,
    `
      CREATE TABLE IF NOT EXISTS external_message_mapping (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        channel_binding_id TEXT REFERENCES external_channel_binding(id) ON DELETE SET NULL,
        direction TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        external_thread_id TEXT,
        external_sender_id TEXT,
        external_event_id TEXT,
        dofe_agent_message_id TEXT,
        task_queue_id TEXT,
        router_session_id TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(integration_id, external_message_id),
        UNIQUE(integration_id, external_event_id)
      )
    `,
    `
      ALTER TABLE external_message_mapping
        ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT
    `,
    `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'external_message_mapping'
            AND column_name = 'agent_space_message_id'
        ) THEN
          UPDATE external_message_mapping
          SET dofe_agent_message_id = COALESCE(dofe_agent_message_id, agent_space_message_id);
        END IF;
      END $$
    `,
    `
      CREATE TABLE IF NOT EXISTS external_message_outbox (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        channel_binding_id TEXT REFERENCES external_channel_binding(id) ON DELETE SET NULL,
        target_external_chat_id TEXT NOT NULL,
        target_external_thread_id TEXT,
        dofe_agent_message_id TEXT,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ
      )
    `,
    `
      ALTER TABLE external_message_outbox
        ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
    `,
    `
      ALTER TABLE external_message_outbox
        ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT
    `,
    `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'external_message_outbox'
            AND column_name = 'agent_space_message_id'
        ) THEN
          UPDATE external_message_outbox
          SET dofe_agent_message_id = COALESCE(dofe_agent_message_id, agent_space_message_id);
        END IF;
      END $$
    `,
    `
      CREATE TABLE IF NOT EXISTS external_data_operation_run (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        resource_binding_id TEXT REFERENCES external_resource_binding(id) ON DELETE SET NULL,
        operation_type TEXT NOT NULL,
        provider_resource_type TEXT NOT NULL,
        provider_resource_token TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        request_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_code TEXT,
        error_message TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS external_integration_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT REFERENCES external_integration(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'received',
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        UNIQUE(workspace_id, provider, external_event_id)
      )
    `,
    `
      DO $$
      BEGIN
        IF to_regclass('public.legacy_workspace') IS NOT NULL
          AND to_regclass('public.workspace_snapshot') IS NULL THEN
          ALTER TABLE legacy_workspace RENAME TO workspace_snapshot;
        END IF;
      END $$;
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_snapshot (
        id TEXT PRIMARY KEY,
        organization_name TEXT NOT NULL,
        pending_handoffs INTEGER NOT NULL DEFAULT 0,
        state_json JSONB NOT NULL,
        state_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_channel (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'group',
        human_member_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        human_member_count INTEGER NOT NULL DEFAULT 0,
        employee_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS channel_participant (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        added_by TEXT,
        joined_at TIMESTAMPTZ NOT NULL,
        removed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE,
        UNIQUE(workspace_id, channel_name, user_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS channel_access_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        resolved_by TEXT,
        note TEXT,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS channel_invitation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        invitee_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        invitee_email TEXT,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        responded_at TIMESTAMPTZ,
        responded_by TEXT,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_employee (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Agent',
        remark_name TEXT,
        origin TEXT NOT NULL DEFAULT 'manual',
        summary TEXT NOT NULL DEFAULT '',
        traits_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        fit TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        instructions TEXT NOT NULL DEFAULT '',
        owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        channel_member_access TEXT NOT NULL DEFAULT 'disabled',
        default_model TEXT,
        execution_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, name)
      )
    `,
    `
      ALTER TABLE workspace_employee
        ADD COLUMN IF NOT EXISTS id TEXT NOT NULL DEFAULT gen_random_uuid()
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_employee_id
        ON workspace_employee(id)
    `,
    `
      UPDATE workspace_employee
        SET id = COALESCE(id, gen_random_uuid()::text)
        WHERE id IS NULL
    `,
    `
      ALTER TABLE workspace_employee
        ADD COLUMN IF NOT EXISTS default_model TEXT
    `,
    `
      ALTER TABLE workspace_employee
        ADD COLUMN IF NOT EXISTS execution_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_fork_invitation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        source_agent_name TEXT NOT NULL,
        target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        accepted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        accepted_agent_name TEXT,
        accepted_runtime_id TEXT
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_fork_snapshot (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        invitation_id TEXT NOT NULL REFERENCES agent_fork_invitation(id) ON DELETE CASCADE,
        source_agent_name TEXT NOT NULL,
        snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE workspace_employee
        ADD COLUMN IF NOT EXISTS owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    `,
    `
      ALTER TABLE workspace_employee
        ADD COLUMN IF NOT EXISTS channel_member_access TEXT NOT NULL DEFAULT 'disabled'
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_task (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        assignee TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_order INTEGER,
        labels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS daemon_connection (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        daemon_key TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'offline',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_heartbeat_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS daemon_api_token (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        daemon_connection_id TEXT REFERENCES daemon_connection(id) ON DELETE SET NULL,
        label TEXT NOT NULL DEFAULT '',
        token_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL DEFAULT '',
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ
      )
    `,
    `
      ALTER TABLE daemon_api_token
        ADD COLUMN IF NOT EXISTS daemon_connection_id TEXT REFERENCES daemon_connection(id) ON DELETE SET NULL
    `,
    `
      ALTER TABLE daemon_api_token
        ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'general'
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_daemon_api_token_active_connection
        ON daemon_api_token(daemon_connection_id)
        WHERE status = 'active' AND daemon_connection_id IS NOT NULL
    `,
    `
      CREATE TABLE IF NOT EXISTS provider_account (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        billing_account_id TEXT,
        secret_ref TEXT,
        config_ref TEXT,
        allowed_models_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_runtime (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        daemon_connection_id TEXT REFERENCES daemon_connection(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        provider_account_id TEXT REFERENCES provider_account(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'offline',
        device_info TEXT NOT NULL DEFAULT '',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        connected_at TIMESTAMPTZ,
        last_heartbeat_at TIMESTAMPTZ,
        last_error TEXT,
        allow_new_employee_sharing BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS provider_account_id TEXT REFERENCES provider_account(id) ON DELETE RESTRICT`,
    // Phase 2 managed-runtime columns. All nullable for backward compatibility
    // with legacy provider_account-backed runtimes.
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS runtime_type TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS protocols_json JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS default_model TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS provisioning_state TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS managed_credential_id TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS credential_secret_ref TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS credential_config_ref TEXT`,
    // Plain TEXT (no FK): runtime_provisioning_task is created later in this
    // migration and the link is logical; the forward task.runtime_id FK below
    // carries the relationship.
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS provisioning_task_id TEXT`,
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS managed_at TIMESTAMPTZ`,
    // When false, this managed runtime refuses to bind additional AI employees
    // (existing bindings are preserved). Defaults to true to keep the
    // one-runtime-many-employees model the baseline.
    `ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS allow_new_employee_sharing BOOLEAN NOT NULL DEFAULT TRUE`,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_managed_credential
        ON agent_runtime(workspace_id, managed_credential_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_runtime_display_name (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, runtime_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_runtime_grant (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'use',
        status TEXT NOT NULL DEFAULT 'active',
        granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE(workspace_id, runtime_id, user_id, permission)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS document_agent_access (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL,
        subject_type TEXT NOT NULL DEFAULT 'agent',
        subject_id TEXT NOT NULL,
        role TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'document',
        granted_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        UNIQUE(workspace_id, document_id, subject_type, subject_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS document_permission_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        document_id TEXT,
        external_provider TEXT,
        external_file_id TEXT,
        external_url TEXT,
        requested_role TEXT NOT NULL,
        requested_by_agent_name TEXT NOT NULL,
        requested_for_channel_name TEXT,
        triggered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        decision_note TEXT,
        source_task_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_access_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        source_agent_name TEXT NOT NULL,
        requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_type TEXT NOT NULL,
        target_channel_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT NOT NULL DEFAULT '',
        resolver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        fork_invitation_id TEXT REFERENCES agent_fork_invitation(id) ON DELETE SET NULL,
        audit_data_json JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_notification (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
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
        severity TEXT NOT NULL DEFAULT 'info',
        status TEXT NOT NULL DEFAULT 'unread',
        dedupe_key TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        read_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_runtime_binding (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, employee_name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_app_catalog_item (
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        entry_point TEXT NOT NULL DEFAULT '',
        install_strategy TEXT NOT NULL DEFAULT '',
        install_cmd TEXT,
        uninstall_cmd TEXT,
        update_cmd TEXT,
        skill_md TEXT,
        requires_text TEXT,
        homepage TEXT,
        registry_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        synced_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (source, name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_installed_app (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        entry_point TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        install_strategy TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        installed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        last_checked_at TIMESTAMPTZ,
        last_error TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE(workspace_id, runtime_id, source, name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_app_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        app_source TEXT NOT NULL,
        app_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        command_plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        safe_stdout_tail TEXT,
        safe_stderr_tail TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_file (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(skill_id, path)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_app_skill_binding (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_app_id TEXT NOT NULL REFERENCES runtime_installed_app(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, runtime_app_id, skill_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS mcp_catalog_item (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        source TEXT NOT NULL DEFAULT 'workspace_private',
        slug TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        transport TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        allowed_hosts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        configuration_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        declared_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        default_approved_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        secret_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_runtime_capabilities_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        data_domains_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        risk TEXT NOT NULL DEFAULT 'high',
        endpoint_template TEXT,
        documentation_url TEXT,
        synced_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, slug)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_connection (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        catalog_item_id TEXT NOT NULL REFERENCES mcp_catalog_item(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        approved_tools_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        endpoint TEXT NOT NULL,
        non_secret_params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        endpoint_fingerprint TEXT,
        last_verified_at TIMESTAMPTZ,
        next_health_check_at TIMESTAMPTZ,
        health_check_consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, runtime_id, catalog_item_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_secret (
        connection_id TEXT NOT NULL REFERENCES runtime_mcp_connection(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        key_version TEXT NOT NULL,
        rotated_at TIMESTAMPTZ NOT NULL,
        rotated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        PRIMARY KEY (connection_id, field_name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_discovery_snapshot (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES runtime_mcp_connection(id) ON DELETE CASCADE,
        protocol_version TEXT,
        tools_metadata_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        tools_fingerprint TEXT NOT NULL,
        discovered_at TIMESTAMPTZ NOT NULL,
        verification_latency_ms INTEGER
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES runtime_mcp_connection(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user_verify',
        status TEXT NOT NULL,
        request_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        safe_stdout_tail TEXT,
        safe_stderr_tail TEXT,
        error_code TEXT,
        error_message TEXT,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_tool_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES runtime_mcp_connection(id) ON DELETE CASCADE,
        task_id TEXT,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        latency_ms INTEGER,
        safe_summary TEXT,
        event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS mcp_task_session_grant (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        encrypted_bundle_json TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_import_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        skill_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_url TEXT,
        import_mode TEXT NOT NULL DEFAULT 'created',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        imported_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_skill (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        agent_id TEXT,
        employee_name TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, employee_name, skill_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_skill_requirement_config (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        encrypted_secrets_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, employee_name, skill_id)
      )
    `,
    `
      ALTER TABLE agent_skill
      ADD COLUMN IF NOT EXISTS agent_id TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS knowledge_page_assignment_policy (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        knowledge_page_id TEXT NOT NULL,
        assignment_mode TEXT NOT NULL DEFAULT 'all_agents',
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, knowledge_page_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_knowledge_page (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        agent_id TEXT,
        employee_name TEXT NOT NULL,
        knowledge_page_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, employee_name, knowledge_page_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS knowledge_proposal (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        source_task_queue_id TEXT NOT NULL,
        source_channel_name TEXT,
        source_agent_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        summary TEXT,
        reason TEXT,
        tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        parent_id TEXT,
        assignment_mode TEXT NOT NULL DEFAULT 'selected_agents',
        assigned_employee_names_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        target_knowledge_page_id TEXT,
        base_updated_at TIMESTAMPTZ,
        created_knowledge_page_id TEXT,
        approval_id TEXT,
        decided_by_user_id TEXT,
        decided_at TIMESTAMPTZ,
        reviewer_comment TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_task_queue (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        router_session_id TEXT,
        issue_id TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'manual',
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        requested_by_user_id TEXT,
        requested_by_display_name TEXT,
        result_json JSONB,
        error_text TEXT,
        session_id TEXT,
        work_dir TEXT,
        binding_generation INTEGER,
        queued_at TIMESTAMPTZ NOT NULL,
        claimed_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        mcp_session_claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS mcp_session_claimed_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS binding_generation INTEGER
    `,
    `
      CREATE TABLE IF NOT EXISTS external_thread_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        integration_id TEXT NOT NULL REFERENCES external_integration(id) ON DELETE CASCADE,
        channel_binding_id TEXT REFERENCES external_channel_binding(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        tenant_key TEXT NOT NULL DEFAULT '',
        external_chat_id TEXT NOT NULL,
        external_thread_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        task_queue_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        dofe_agent_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_message_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (workspace_id, channel_name)
          REFERENCES workspace_channel(workspace_id, name)
          ON DELETE CASCADE
          ON UPDATE CASCADE,
        UNIQUE(workspace_id, provider, tenant_key, external_chat_id, external_thread_id, agent_id)
      )
    `,
    `
      ALTER TABLE external_thread_binding
        ADD COLUMN IF NOT EXISTS dofe_agent_message_id TEXT
    `,
    `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'external_thread_binding'
            AND column_name = 'agent_space_message_id'
        ) THEN
          UPDATE external_thread_binding
          SET dofe_agent_message_id = COALESCE(dofe_agent_message_id, agent_space_message_id);
        END IF;
      END $$
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_router_session (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        conversation_key TEXT,
        source_type TEXT NOT NULL DEFAULT 'task',
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        summary TEXT,
        memory_summary TEXT,
        model_override TEXT,
        model_override_source TEXT,
        model_override_set_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        closed_at TIMESTAMPTZ,
        UNIQUE(workspace_id, agent_id, conversation_key)
      )
    `,
    `
      ALTER TABLE agent_router_session
        ADD COLUMN IF NOT EXISTS model_override TEXT
    `,
    `
      ALTER TABLE agent_router_session
        ADD COLUMN IF NOT EXISTS model_override_source TEXT
    `,
    `
      ALTER TABLE agent_router_session
        ADD COLUMN IF NOT EXISTS model_override_set_at TIMESTAMPTZ
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_router_provider_session (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        router_session_id TEXT NOT NULL REFERENCES agent_router_session(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_used_at TIMESTAMPTZ,
        last_error TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, router_session_id, runtime_id, provider)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_task_attempt (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        task_queue_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        router_session_id TEXT NOT NULL REFERENCES agent_router_session(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        error_text TEXT,
        handoff_snapshot_id TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_router_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        router_session_id TEXT NOT NULL REFERENCES agent_router_session(id) ON DELETE CASCADE,
        task_queue_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES agent_task_attempt(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        runtime_id TEXT,
        provider TEXT,
        summary TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_router_context_snapshot (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        router_session_id TEXT NOT NULL REFERENCES agent_router_session(id) ON DELETE CASCADE,
        task_queue_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        snapshot_type TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        source_event_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS requested_by_display_name TEXT
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS router_session_id TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS task_execution_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        channel_name TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL,
        runtime_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        status TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS task_message (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        content TEXT,
        input_json JSONB,
        output TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS model_pricing (
        model_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        input_per_1m DOUBLE PRECISION NOT NULL,
        output_per_1m DOUBLE PRECISION NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS token_usage (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        task_queue_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        agent_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_account_id TEXT REFERENCES provider_account(id) ON DELETE SET NULL,
        runtime_credential_id TEXT,
        router_session_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        billing_status TEXT NOT NULL DEFAULT 'estimated',
        gateway_request_id TEXT,
        gateway_usage_id TEXT,
        protocol TEXT,
        actual_cost_usd DOUBLE PRECISION,
        currency TEXT,
        cache_tokens INTEGER NOT NULL DEFAULT 0,
        request_started_at TIMESTAMPTZ,
        request_ended_at TIMESTAMPTZ,
        source_updated_at TIMESTAMPTZ,
        reconciled_at TIMESTAMPTZ,
        channel_name TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS token_usage_billing_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        token_usage_id TEXT REFERENCES token_usage(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        snapshot_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_billing_event_usage
        ON token_usage_billing_event(workspace_id, token_usage_id, created_at)
    `,
    `
      CREATE OR REPLACE FUNCTION append_token_usage_billing_event()
      RETURNS TRIGGER AS $$
      DECLARE
        billing_event_type TEXT;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          billing_event_type := CASE
            WHEN NEW.task_queue_id IS NULL AND NEW.billing_status IN ('pending_reconciliation', 'unallocated')
              THEN 'usage_discovered'
            ELSE 'usage_recorded'
          END;
        ELSIF OLD.task_queue_id IS NULL AND NEW.task_queue_id IS NOT NULL THEN
          billing_event_type := 'usage_attributed';
        ELSE
          billing_event_type := 'billing_state_changed';
        END IF;

        INSERT INTO token_usage_billing_event (
          id, workspace_id, token_usage_id, event_type, snapshot_json, created_at
        ) VALUES (
          'billing-event-' || md5(NEW.id || clock_timestamp()::text || random()::text),
          NEW.workspace_id,
          NEW.id,
          billing_event_type,
          to_jsonb(NEW),
          clock_timestamp()
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
    `DROP TRIGGER IF EXISTS trg_token_usage_billing_event ON token_usage`,
    `
      CREATE TRIGGER trg_token_usage_billing_event
      AFTER INSERT OR UPDATE ON token_usage
      FOR EACH ROW EXECUTE FUNCTION append_token_usage_billing_event()
    `,
    `
      INSERT INTO token_usage_billing_event (
        id, workspace_id, token_usage_id, event_type, snapshot_json, created_at
      )
      SELECT
        'billing-event-migration-' || id,
        workspace_id,
        id,
        'migration_snapshot',
        to_jsonb(token_usage),
        created_at
      FROM token_usage
      ON CONFLICT (id) DO NOTHING
    `,
    `
      CREATE TABLE IF NOT EXISTS token_usage_retry (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        task_queue_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        payload_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS token_usage_reconciliation_cursor (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_credential_id TEXT NOT NULL,
        last_remote_timestamp TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(workspace_id, runtime_credential_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_credential_reconciliation_target (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        runtime_credential_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        retire_after TIMESTAMPTZ,
        last_remote_timestamp TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(workspace_id, runtime_credential_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_credential_reconciliation_target_state
        ON runtime_credential_reconciliation_target(state, retire_after, updated_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_maintenance_run (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',
        stages_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `ALTER TABLE runtime_maintenance_run ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`,
    `UPDATE runtime_maintenance_run SET lease_expires_at = COALESCE(lease_expires_at, started_at)`,
    `ALTER TABLE runtime_maintenance_run ALTER COLUMN lease_expires_at SET NOT NULL`,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_maintenance_run_started
        ON runtime_maintenance_run(started_at DESC)
    `,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS runtime_credential_id TEXT
    `,
    `ALTER TABLE token_usage ALTER COLUMN task_queue_id DROP NOT NULL`,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS router_session_id TEXT
    `,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS provider_account_id TEXT REFERENCES provider_account(id) ON DELETE SET NULL`,
    `ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD'`,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'estimated'
    `,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS gateway_request_id TEXT
    `,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS actual_cost_usd DOUBLE PRECISION
    `,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS currency TEXT
    `,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS gateway_usage_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS protocol TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS cache_tokens INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS request_started_at TIMESTAMPTZ`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS request_ended_at TIMESTAMPTZ`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ`,
    `
      ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_provision_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL REFERENCES provider_account(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        runtime_name TEXT NOT NULL,
        target_server TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'requested',
        requested_by TEXT NOT NULL,
        approved_by TEXT,
        daemon_token_id TEXT REFERENCES daemon_api_token(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS budget (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        limit_usd DOUBLE PRECISION NOT NULL,
        period TEXT NOT NULL DEFAULT 'monthly',
        action TEXT NOT NULL DEFAULT 'warn',
        warning_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS attachment (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        message_id TEXT,
        channel_name TEXT,
        speaker TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        stored_path TEXT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'tos',
        storage_bucket TEXT,
        storage_region TEXT,
        storage_endpoint TEXT,
        storage_key TEXT,
        storage_url TEXT,
        sha256 TEXT,
        source_message_time TEXT,
        source_message_index INTEGER NOT NULL DEFAULT 0,
        source_summary TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, id)
      )
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_provider TEXT NOT NULL DEFAULT 'tos'
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_bucket TEXT
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_region TEXT
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_endpoint TEXT
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_key TEXT
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS storage_url TEXT
    `,
    `
      ALTER TABLE attachment
        ADD COLUMN IF NOT EXISTS sha256 TEXT
    `,
    `
      DELETE FROM attachment
      WHERE storage_provider <> 'tos' OR storage_key IS NULL
    `,
    `
      ALTER TABLE attachment
        ALTER COLUMN storage_provider SET DEFAULT 'tos',
        ALTER COLUMN storage_key SET NOT NULL
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'attachment_storage_provider_tos_check'
        ) THEN
          ALTER TABLE attachment
            ADD CONSTRAINT attachment_storage_provider_tos_check
            CHECK (storage_provider = 'tos');
        END IF;
      END
      $$
    `,
    `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        note TEXT NOT NULL,
        code TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        source TEXT NOT NULL DEFAULT 'workspace_snapshot_ledger',
        source_index INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_sso_binding (
        workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL,
        tenant_slug TEXT,
        tenant_name TEXT NOT NULL,
        team_id TEXT,
        team_slug TEXT,
        team_name TEXT,
        source TEXT NOT NULL,
        synced_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_provisioning_task (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT REFERENCES agent_runtime(id) ON DELETE SET NULL,
        requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        source_runtime_id TEXT,
        runtime_type TEXT NOT NULL,
        protocols_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        requested_name TEXT,
        requested_model TEXT,
        allowed_models_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        target_server TEXT,
        stage TEXT NOT NULL DEFAULT 'pending',
        stage_status TEXT NOT NULL DEFAULT 'pending',
        progress_percent INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        last_error_code TEXT,
        last_error_message TEXT,
        cleanup_status TEXT NOT NULL DEFAULT 'pending',
        cleanup_result_json JSONB,
        runtime_credential_id TEXT,
        secret_ref TEXT,
        config_ref TEXT,
        daemon_connection_id TEXT REFERENCES daemon_connection(id) ON DELETE SET NULL,
        stage_started_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'queued',
        timeouts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        task_timeout_ms INTEGER NOT NULL DEFAULT 1800000,
        next_retry_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_provisioning_task_event (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES runtime_provisioning_task(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_percent INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        summary TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        data_json JSONB,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS daemon_connection_id TEXT REFERENCES daemon_connection(id) ON DELETE SET NULL`,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS stage_started_at TIMESTAMPTZ`,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS requested_name TEXT`,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS allowed_models_json JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS task_timeout_ms INTEGER NOT NULL DEFAULT 1800000`,
    `ALTER TABLE runtime_provisioning_task ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ`,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_retry
        ON runtime_provisioning_task(status, next_retry_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_daemon_running
        ON runtime_provisioning_task(daemon_connection_id, status, stage_status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_stage_timeout
        ON runtime_provisioning_task(status, stage_status, stage_started_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_credential_recovery_task (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        source_task_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        cooldown_until TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_message TEXT,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, idempotency_key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_runtime_cleanup_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        daemon_connection_id TEXT NOT NULL REFERENCES daemon_connection(id) ON DELETE CASCADE,
        runtime_type TEXT NOT NULL,
        provisioning_task_id TEXT REFERENCES runtime_provisioning_task(id) ON DELETE SET NULL,
        delete_runtime_on_success BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_message TEXT,
        requested_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        result_json JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_managed_runtime_cleanup_request_daemon_status
        ON managed_runtime_cleanup_request(daemon_connection_id, status, requested_at)
    `,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS last_error_message TEXT`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS provisioning_task_id TEXT REFERENCES runtime_provisioning_task(id) ON DELETE SET NULL`,
    `ALTER TABLE managed_runtime_cleanup_request ADD COLUMN IF NOT EXISTS delete_runtime_on_success BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE managed_runtime_cleanup_request DROP CONSTRAINT IF EXISTS managed_runtime_cleanup_request_runtime_id_fkey`,
    `
      CREATE INDEX IF NOT EXISTS idx_managed_runtime_cleanup_request_due
        ON managed_runtime_cleanup_request(status, next_attempt_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_managed_runtime_cleanup_request_running_timeout
        ON managed_runtime_cleanup_request(status, claimed_at)
    `,
    ...[
      "channelDocumentVersions",
      "channelDocumentBlocks",
      "channelDocumentAccesses",
      "channelDocumentChangeSets",
      "channelDocumentConflicts",
      "channelDocumentPresences",
      "channelDocumentRuns",
    ].map((fieldName) => `
      UPDATE workspace_snapshot
      SET state_json = jsonb_set(
        state_json,
        '{${fieldName}}',
        COALESCE((
          SELECT jsonb_agg(item)
          FROM jsonb_array_elements(COALESCE(state_json->'${fieldName}', '[]'::jsonb)) AS item
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(state_json->'channelDocuments', '[]'::jsonb)) AS document
            WHERE document->>'id' = item->>'documentId'
          )
        ), '[]'::jsonb)
      )
    `),
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_slug
        ON workspace(slug)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_membership_user
        ON workspace_membership(user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_membership_workspace
        ON workspace_membership(workspace_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_channel_workspace
        ON workspace_channel(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_participant_channel_status
        ON channel_participant(workspace_id, channel_name, status, joined_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_participant_user_status
        ON channel_participant(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_access_request_channel_status
        ON channel_access_request(workspace_id, channel_name, status, requested_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_access_request_user_status
        ON channel_access_request(workspace_id, user_id, status)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_access_request_pending_user
        ON channel_access_request(workspace_id, channel_name, user_id)
        WHERE status = 'pending'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_channel_status
        ON channel_invitation(workspace_id, channel_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_user_status
        ON channel_invitation(workspace_id, invitee_user_id, status)
        WHERE invitee_user_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_invitation_pending_user
        ON channel_invitation(workspace_id, channel_name, invitee_user_id)
        WHERE status = 'pending' AND invitee_user_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_email_status
        ON channel_invitation(workspace_id, invitee_email, status)
        WHERE invitee_email IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_invitation_pending_email
        ON channel_invitation(workspace_id, channel_name, invitee_email)
        WHERE status = 'pending' AND invitee_email IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_employee_workspace
        ON workspace_employee(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_target_status
        ON agent_fork_invitation(workspace_id, target_user_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_source_status
        ON agent_fork_invitation(workspace_id, source_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_creator_status
        ON agent_fork_invitation(workspace_id, created_by_user_id, status, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_fork_invitation_pending_unique
        ON agent_fork_invitation(workspace_id, source_agent_name, target_user_id)
        WHERE status = 'pending'
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_fork_snapshot_invitation
        ON agent_fork_snapshot(workspace_id, invitation_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_task_workspace
        ON workspace_task(workspace_id, status, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_auth_identity_user
        ON auth_identity(user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_session_user
        ON session(user_id)
    `,
    `
      DROP INDEX IF EXISTS idx_agent_runtime_workspace_daemon_provider
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon_provider
        ON agent_runtime(workspace_id, daemon_connection_id, provider)
        WHERE managed_credential_id IS NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_status
        ON agent_runtime(workspace_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_managed_credential
        ON agent_runtime(workspace_id, managed_credential_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_sso_binding_team
        ON workspace_sso_binding(team_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_workspace_status
        ON runtime_provisioning_task(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_runtime
        ON runtime_provisioning_task(runtime_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_event_task
        ON runtime_provisioning_task_event(task_id, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_credential_recovery_runtime_status
        ON runtime_credential_recovery_task(runtime_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_daemon_api_token_workspace
        ON daemon_api_token(workspace_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_runtime_grant_user
        ON workspace_runtime_grant(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_runtime_grant_runtime
        ON workspace_runtime_grant(workspace_id, runtime_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_agent_access_subject
        ON document_agent_access(workspace_id, subject_type, subject_id, revoked_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_agent_access_document
        ON document_agent_access(workspace_id, document_id, revoked_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_permission_request_workspace_status
        ON document_permission_request(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_permission_request_agent
        ON document_permission_request(workspace_id, requested_by_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_access_request_source_status
        ON agent_access_request(workspace_id, source_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_access_request_requester_status
        ON agent_access_request(workspace_id, requester_user_id, status, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_access_request_pending_unique
        ON agent_access_request(workspace_id, source_agent_name, requester_user_id, request_type, COALESCE(target_channel_name, ''))
        WHERE status = 'pending'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_notification_recipient_status_created
        ON workspace_notification(workspace_id, recipient_type, recipient_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_notification_resource
        ON workspace_notification(workspace_id, resource_type, resource_id, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_notification_dedupe
        ON workspace_notification(workspace_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_permission_request_pending_agent_document
        ON document_permission_request(workspace_id, requested_by_agent_name, requested_role, document_id, requested_for_channel_name)
        WHERE status = 'pending' AND document_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_permission_request_pending_agent_external
        ON document_permission_request(workspace_id, requested_by_agent_name, requested_role, external_provider, external_file_id, requested_for_channel_name)
        WHERE status = 'pending' AND external_file_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_runtime_binding_runtime
        ON employee_runtime_binding(runtime_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_catalog_category
        ON runtime_app_catalog_item(source, category, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_installed_app_runtime
        ON runtime_installed_app(workspace_id, runtime_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_operation_runtime_status
        ON runtime_app_operation(workspace_id, runtime_id, status, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_operation_app
        ON runtime_app_operation(workspace_id, app_source, app_name, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_skill_binding_skill
        ON runtime_app_skill_binding(workspace_id, skill_id)
    `,
    `
      ALTER TABLE runtime_mcp_connection
        ADD COLUMN IF NOT EXISTS next_health_check_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE runtime_mcp_connection
        ADD COLUMN IF NOT EXISTS health_check_consecutive_failures INTEGER NOT NULL DEFAULT 0
    `,
    `
      ALTER TABLE runtime_mcp_operation
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user_verify'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mcp_catalog_item_workspace
        ON mcp_catalog_item(workspace_id, slug)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_connection_runtime_status
        ON runtime_mcp_connection(workspace_id, runtime_id, status)
    `,
    `
      ALTER TABLE runtime_mcp_tool_audit
        ADD COLUMN IF NOT EXISTS event_id TEXT
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_mcp_tool_audit_event
        ON runtime_mcp_tool_audit(workspace_id, event_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_connection_health_due
        ON runtime_mcp_connection(workspace_id, status, next_health_check_at)
        WHERE status = 'ready'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_operation_runtime_status
        ON runtime_mcp_operation(workspace_id, runtime_id, status, source, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_operation_connection
        ON runtime_mcp_operation(workspace_id, connection_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_discovery_snapshot_connection
        ON runtime_mcp_discovery_snapshot(connection_id, discovered_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_tool_audit_connection
        ON runtime_mcp_tool_audit(workspace_id, connection_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_workspace_name
        ON skill(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_file_skill
        ON skill_file(skill_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_import_event_workspace_imported
        ON skill_import_event(workspace_id, imported_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_skill_employee
        ON agent_skill(workspace_id, employee_name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_skill_requirement_config_employee
        ON agent_skill_requirement_config(workspace_id, employee_name, skill_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_assignment_policy_page
        ON knowledge_page_assignment_policy(workspace_id, knowledge_page_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_knowledge_page_employee
        ON agent_knowledge_page(workspace_id, employee_name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_knowledge_page_page
        ON agent_knowledge_page(workspace_id, knowledge_page_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_workspace_status_created
        ON knowledge_proposal(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_source_task
        ON knowledge_proposal(workspace_id, source_task_queue_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_approval
        ON knowledge_proposal(workspace_id, approval_id)
        WHERE approval_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_router_session_conversation
        ON agent_router_session(workspace_id, agent_id, conversation_key)
        WHERE conversation_key IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_session_agent_updated
        ON agent_router_session(workspace_id, agent_id, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_provider_session_router
        ON agent_router_provider_session(workspace_id, router_session_id, status, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_attempt_task_created
        ON agent_task_attempt(task_queue_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_attempt_router_created
        ON agent_task_attempt(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_event_router_created
        ON agent_router_event(workspace_id, router_session_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_event_task_created
        ON agent_router_event(task_queue_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_context_snapshot_router_created
        ON agent_router_context_snapshot(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_runtime_status_priority
        ON agent_task_queue(runtime_id, status, priority DESC, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_router_session
        ON agent_task_queue(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_message_task_seq
        ON task_message(task_id, seq)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_workspace_created
        ON task_execution_event(workspace_id, created_at DESC, id DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_task_created
        ON task_execution_event(task_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_runtime_created
        ON task_execution_event(workspace_id, runtime_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_channel_created
        ON task_execution_event(workspace_id, channel_name, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_workspace_scope
        ON budget(workspace_id, scope, scope_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_created
        ON token_usage(workspace_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent
        ON token_usage(workspace_id, agent_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_runtime_credential
        ON token_usage(workspace_id, runtime_credential_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_billing_status
        ON token_usage(workspace_id, billing_status, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_gateway_request
        ON token_usage(gateway_request_id)
        WHERE gateway_request_id IS NOT NULL
    `,
    `
      WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_usage_id
            ORDER BY
              CASE WHEN task_queue_id IS NOT NULL THEN 0 ELSE 1 END,
              created_at,
              id
          ) AS duplicate_rank
        FROM token_usage
        WHERE gateway_usage_id IS NOT NULL
      )
      UPDATE token_usage
      SET gateway_usage_id = NULL
      FROM ranked
      WHERE token_usage.id = ranked.id
        AND ranked.duplicate_rank > 1
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_workspace_gateway_usage_unique
        ON token_usage(workspace_id, gateway_usage_id)
        WHERE gateway_usage_id IS NOT NULL
    `,
    `
      WITH ranked AS (
        SELECT id, workspace_id, gateway_request_id, runtime_credential_id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_request_id
            ORDER BY
              CASE
                WHEN task_queue_id IS NOT NULL THEN 0
                WHEN billing_status = 'reconciled' THEN 1
                WHEN billing_status = 'estimated' THEN 2
                ELSE 3
              END,
              created_at,
              id
          ) AS duplicate_rank
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL
      ),
      keepers AS (
        SELECT workspace_id, gateway_request_id, runtime_credential_id
        FROM ranked
        WHERE duplicate_rank = 1
      ),
      conflicts AS (
        SELECT ranked.id
        FROM ranked
        JOIN keepers
          ON keepers.workspace_id = ranked.workspace_id
         AND keepers.gateway_request_id = ranked.gateway_request_id
        WHERE ranked.duplicate_rank > 1
          AND ranked.runtime_credential_id IS NOT NULL
          AND keepers.runtime_credential_id IS NOT NULL
          AND ranked.runtime_credential_id <> keepers.runtime_credential_id
      )
      UPDATE token_usage AS conflicting
      SET gateway_request_id = NULL
      FROM conflicts
      WHERE conflicting.id = conflicts.id
    `,
    `
      WITH ranked AS (
        SELECT id, workspace_id, gateway_request_id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_request_id
            ORDER BY
              CASE
                WHEN task_queue_id IS NOT NULL THEN 0
                WHEN billing_status = 'reconciled' THEN 1
                WHEN billing_status = 'estimated' THEN 2
                ELSE 3
              END,
              created_at,
              id
          ) AS duplicate_rank,
          COUNT(*) OVER (PARTITION BY workspace_id, gateway_request_id) AS duplicate_count
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL
      ),
      keepers AS (
        SELECT id, workspace_id, gateway_request_id
        FROM ranked
        WHERE duplicate_rank = 1 AND duplicate_count > 1
      ),
      actuals AS (
        SELECT DISTINCT ON (workspace_id, gateway_request_id)
          workspace_id, gateway_request_id, runtime_credential_id, model_id,
          input_tokens, output_tokens, actual_cost_usd, currency, reconciled_at
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL AND actual_cost_usd IS NOT NULL
        ORDER BY workspace_id, gateway_request_id,
          CASE billing_status WHEN 'reconciled' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
          created_at,
          id
      )
      UPDATE token_usage AS keeper
      SET actual_cost_usd = COALESCE(actuals.actual_cost_usd, keeper.actual_cost_usd),
          currency = COALESCE(actuals.currency, keeper.currency),
          runtime_credential_id = COALESCE(keeper.runtime_credential_id, actuals.runtime_credential_id),
          model_id = actuals.model_id,
          input_tokens = CASE
            WHEN actuals.input_tokens + actuals.output_tokens > 0 THEN actuals.input_tokens
            ELSE keeper.input_tokens
          END,
          output_tokens = CASE
            WHEN actuals.input_tokens + actuals.output_tokens > 0 THEN actuals.output_tokens
            ELSE keeper.output_tokens
          END,
          billing_status = CASE WHEN actuals.actual_cost_usd IS NOT NULL THEN 'reconciled' ELSE keeper.billing_status END,
          reconciled_at = CASE
            WHEN actuals.actual_cost_usd IS NOT NULL THEN COALESCE(actuals.reconciled_at, keeper.reconciled_at, NOW())
            ELSE keeper.reconciled_at
          END
      FROM keepers
      JOIN actuals
        ON actuals.workspace_id = keepers.workspace_id
       AND actuals.gateway_request_id = keepers.gateway_request_id
      WHERE keeper.id = keepers.id
       AND (
         actuals.runtime_credential_id IS NULL
         OR keeper.runtime_credential_id IS NULL
         OR actuals.runtime_credential_id = keeper.runtime_credential_id
       )
    `,
    `
      DELETE FROM token_usage
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY workspace_id, gateway_request_id
              ORDER BY
                CASE
                  WHEN task_queue_id IS NOT NULL THEN 0
                  WHEN billing_status = 'reconciled' THEN 1
                  WHEN billing_status = 'estimated' THEN 2
                  ELSE 3
                END,
                created_at,
                id
            ) AS duplicate_rank
          FROM token_usage
          WHERE gateway_request_id IS NOT NULL
        ) ranked
        WHERE duplicate_rank > 1
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_workspace_gateway_request_unique
        ON token_usage(workspace_id, gateway_request_id)
        WHERE gateway_request_id IS NOT NULL
    `,
    `CREATE INDEX IF NOT EXISTS idx_provider_account_workspace ON provider_account(workspace_id, provider, status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_provision_request_workspace ON runtime_provision_request(workspace_id, status, created_at DESC)`,
    `
      CREATE INDEX IF NOT EXISTS idx_attachment_workspace_message
        ON attachment(workspace_id, message_id, source_message_index)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_attachment_storage_key
        ON attachment(storage_provider, storage_bucket, storage_key)
        WHERE storage_key IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created
        ON audit_log(workspace_id, created_at DESC, source_index DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_workspace_provider
        ON external_integration(workspace_id, provider, status, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_agent
        ON external_integration(workspace_id, provider, agent_id, status, updated_at DESC)
        WHERE agent_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_integration_active_agent
        ON external_integration(workspace_id, provider, agent_id)
        WHERE agent_id IS NOT NULL AND status <> 'disabled'
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_integration_provider_app_tenant
        ON external_integration(workspace_id, provider, app_id, COALESCE(tenant_key, ''))
        WHERE app_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_user_binding_user
        ON external_user_binding(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_user_binding_external_open
        ON external_user_binding(integration_id, external_open_id)
        WHERE external_open_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_channel_binding_workspace_channel
        ON external_channel_binding(workspace_id, channel_name, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_resource_binding_workspace_resource
        ON external_resource_binding(workspace_id, dofe_agent_resource_type, dofe_agent_resource_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_resource_binding_channel
        ON external_resource_binding(workspace_id, channel_name, status)
        WHERE channel_name IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_message_mapping_task
        ON external_message_mapping(workspace_id, task_queue_id)
        WHERE task_queue_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_thread_binding_lookup
        ON external_thread_binding(workspace_id, provider, tenant_key, external_chat_id, external_thread_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_thread_binding_task
        ON external_thread_binding(workspace_id, task_queue_id)
        WHERE task_queue_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_message_outbox_due
        ON external_message_outbox(status, next_attempt_at, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_retry_due
        ON token_usage_retry(status, next_attempt_at, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_data_operation_run_resource_created
        ON external_data_operation_run(workspace_id, resource_binding_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_event_status
        ON external_integration_event(workspace_id, provider, status, received_at ASC)
    `,
    // ----- Employee data durability (EAD-001 .. EAD-005) -----
    `
      CREATE TABLE IF NOT EXISTS content_blob (
        sha256 TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        storage_provider TEXT NOT NULL DEFAULT 'tos',
        storage_bucket TEXT,
        storage_region TEXT,
        storage_endpoint TEXT,
        storage_key TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, sha256)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        digest TEXT NOT NULL,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        manifest_version INTEGER NOT NULL DEFAULT 1,
        manifest_json JSONB NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        file_count INTEGER NOT NULL DEFAULT 0,
        total_size_bytes BIGINT NOT NULL DEFAULT 0,
        legacy_incomplete INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        artifact_digest TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, skill_id, artifact_digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact_file (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES skill_artifact(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        media_type TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT '0644',
        is_text INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(artifact_id, path)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_upgrade_approval (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        from_digest TEXT NOT NULL,
        to_digest TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        policy_version TEXT NOT NULL DEFAULT 'v1',
        decision TEXT NOT NULL,
        reason TEXT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        UNIQUE(workspace_id, from_digest, to_digest, diff_hash)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        artifact_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_lock_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        prepared_path TEXT,
        health TEXT NOT NULL DEFAULT 'unknown',
        previous_ready_revision TEXT,
        revision TEXT NOT NULL,
        installed_at TIMESTAMPTZ,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        previous_ready_artifact_digest TEXT,
        prepared_digest TEXT,
        UNIQUE(workspace_id, runtime_id, artifact_digest, revision),
        FOREIGN KEY (workspace_id, artifact_digest)
          REFERENCES skill_artifact(workspace_id, digest) ON DELETE RESTRICT
      )
    `,
    `
      ALTER TABLE skill_installation
        ADD COLUMN IF NOT EXISTS prepared_digest TEXT
    `,
    `
      ALTER TABLE skill_installation ADD COLUMN IF NOT EXISTS previous_ready_artifact_digest TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        request_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        safe_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_code TEXT,
        error_message TEXT,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE skill_installation_operation ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation_component (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        last_operation_id TEXT,
        verified_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(installation_id, kind, key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_service_catalog (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        template_version TEXT NOT NULL,
        deployment_type TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'http',
        scope TEXT NOT NULL DEFAULT 'workspace_runtime',
        resources_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        network_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        config_schema_version INTEGER NOT NULL DEFAULT 1,
        config_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        secret_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        external_dependencies_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        rollback_class TEXT NOT NULL DEFAULT 'stateless',
        template_digest TEXT NOT NULL,
        risk TEXT NOT NULL DEFAULT 'high',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, slug, template_version)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_skill_service (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        catalog_id TEXT NOT NULL REFERENCES skill_service_catalog(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        network_identity TEXT,
        resource_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_health TEXT,
        last_health_at TIMESTAMPTZ,
        rollout_revision TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, runtime_id, catalog_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_service_binding (
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES managed_skill_service(id) ON DELETE CASCADE,
        catalog_template_version TEXT NOT NULL,
        service_image_digest TEXT NOT NULL,
        endpoint_ref TEXT NOT NULL,
        health_revision TEXT NOT NULL,
        config_schema_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (installation_id, service_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_skill_service_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES managed_skill_service(id) ON DELETE CASCADE,
        installation_id TEXT REFERENCES skill_installation(id) ON DELETE SET NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE skill ADD COLUMN IF NOT EXISTS active_artifact_digest TEXT
    `,
    `
      ALTER TABLE agent_skill ADD COLUMN IF NOT EXISTS skill_artifact_digest TEXT
    `,
    `
      ALTER TABLE agent_skill ADD COLUMN IF NOT EXISTS rollout_pin TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_persistent_workspace (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        head_revision_id TEXT,
        storage_ref TEXT,
        retention_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        storage_health TEXT NOT NULL DEFAULT 'unknown',
        last_snapshot_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, employee_name)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_workspace_revision (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workspace_id_ref TEXT NOT NULL REFERENCES employee_persistent_workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        parent_revision_id TEXT REFERENCES employee_workspace_revision(id) ON DELETE SET NULL,
        manifest_digest TEXT NOT NULL,
        manifest_json JSONB NOT NULL,
        source_task_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id_ref, manifest_digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_artifact (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workspace_id_ref TEXT NOT NULL REFERENCES employee_persistent_workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        media_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        source_task_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        published_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS task_commit_journal (
        task_id TEXT NOT NULL REFERENCES agent_task_queue(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT REFERENCES workspace_employee(id) ON DELETE SET NULL,
        employee_name TEXT,
        workspace_revision_id TEXT,
        artifact_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        commit_state TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (task_id)
      )
    `,
    `
      ALTER TABLE employee_runtime_binding
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'online'
    `,
    `
      ALTER TABLE employee_runtime_binding
        ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1
    `,
    `
      ALTER TABLE employee_runtime_binding
        ADD COLUMN IF NOT EXISTS desired_provider TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_recovery_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        from_generation INTEGER,
        to_generation INTEGER NOT NULL,
        phase TEXT NOT NULL DEFAULT 'allocate',
        target_revision_id TEXT,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        error_code TEXT,
        error_message TEXT,
        context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_artifact_workspace_digest
        ON skill_artifact(workspace_id, digest)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_artifact_skill
        ON skill_artifact(workspace_id, skill_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_artifact_file_sha256
        ON skill_artifact_file(workspace_id, sha256)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_workspace_revision_head
        ON employee_workspace_revision(workspace_id_ref, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_artifact_workspace
        ON employee_artifact(workspace_id_ref, deleted_at)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_artifact_publish_idempotent
        ON employee_artifact(workspace_id, source_task_id, content_digest, file_name)
        WHERE source_task_id IS NOT NULL AND deleted_at IS NULL
    `,
    `
      ALTER TABLE agent_skill
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE agent_skill AS asg
        SET employee_id = COALESCE(asg.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE asg.workspace_id = we.workspace_id
          AND LOWER(asg.employee_name) = LOWER(we.name)
          AND asg.employee_id IS NULL
    `,
    `
      DELETE FROM agent_skill
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE agent_skill
        DROP CONSTRAINT IF EXISTS fk_agent_skill_employee_id
    `,
    `
      ALTER TABLE agent_skill
        ADD CONSTRAINT fk_agent_skill_employee_id
        FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE agent_skill_requirement_config AS asrc
        SET employee_id = COALESCE(asrc.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE asrc.workspace_id = we.workspace_id
          AND LOWER(asrc.employee_name) = LOWER(we.name)
          AND asrc.employee_id IS NULL
    `,
    `
      DELETE FROM agent_skill_requirement_config
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        DROP CONSTRAINT IF EXISTS fk_agent_skill_requirement_config_employee_id
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        ADD CONSTRAINT fk_agent_skill_requirement_config_employee_id
        FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE
    `,
    `
      ALTER TABLE agent_knowledge_page
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE agent_knowledge_page AS akp
        SET employee_id = COALESCE(akp.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE akp.workspace_id = we.workspace_id
          AND LOWER(akp.employee_name) = LOWER(we.name)
          AND akp.employee_id IS NULL
    `,
    `
      DELETE FROM agent_knowledge_page
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE agent_knowledge_page
        DROP CONSTRAINT IF EXISTS fk_agent_knowledge_page_employee_id
    `,
    `
      ALTER TABLE agent_knowledge_page
        ADD CONSTRAINT fk_agent_knowledge_page_employee_id
        FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_commit_journal_state
        ON task_commit_journal(workspace_id, commit_state, updated_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_recovery_workspace
        ON employee_recovery_operation(workspace_id, employee_name, created_at DESC)
    `,
    `
      ALTER TABLE employee_persistent_workspace
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE employee_persistent_workspace AS epw
        SET employee_id = COALESCE(epw.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE epw.workspace_id = we.workspace_id
          AND LOWER(epw.employee_name) = LOWER(we.name)
          AND epw.employee_id IS NULL
    `,
    `
      DELETE FROM employee_persistent_workspace
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE employee_persistent_workspace
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE employee_persistent_workspace
        DROP CONSTRAINT IF EXISTS fk_employee_persistent_workspace_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_employee_persistent_workspace_employee_id'
            AND conrelid = 'employee_persistent_workspace'::regclass
        ) THEN
          ALTER TABLE employee_persistent_workspace
            ADD CONSTRAINT fk_employee_persistent_workspace_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE;
        END IF;
      END $$
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_persistent_workspace_employee_id
        ON employee_persistent_workspace(workspace_id, employee_id)
    `,
    `
      ALTER TABLE employee_workspace_revision
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE employee_workspace_revision AS ewr
        SET employee_id = COALESCE(ewr.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE ewr.workspace_id = we.workspace_id
          AND LOWER(ewr.employee_name) = LOWER(we.name)
          AND ewr.employee_id IS NULL
    `,
    `
      DELETE FROM employee_workspace_revision
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE employee_workspace_revision
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE employee_workspace_revision
        DROP CONSTRAINT IF EXISTS fk_employee_workspace_revision_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_employee_workspace_revision_employee_id'
            AND conrelid = 'employee_workspace_revision'::regclass
        ) THEN
          ALTER TABLE employee_workspace_revision
            ADD CONSTRAINT fk_employee_workspace_revision_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE;
        END IF;
      END $$
    `,
    `
      ALTER TABLE employee_workspace_revision
        ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'task_output'
    `,
    `
      ALTER TABLE employee_artifact
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE employee_artifact AS ea
        SET employee_id = COALESCE(ea.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE ea.workspace_id = we.workspace_id
          AND LOWER(ea.employee_name) = LOWER(we.name)
          AND ea.employee_id IS NULL
    `,
    `
      DELETE FROM employee_artifact
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE employee_artifact
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE employee_artifact
        DROP CONSTRAINT IF EXISTS fk_employee_artifact_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_employee_artifact_employee_id'
            AND conrelid = 'employee_artifact'::regclass
        ) THEN
          ALTER TABLE employee_artifact
            ADD CONSTRAINT fk_employee_artifact_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE;
        END IF;
      END $$
    `,
    `
      ALTER TABLE employee_runtime_binding
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE employee_runtime_binding AS erb
        SET employee_id = COALESCE(erb.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE erb.workspace_id = we.workspace_id
          AND LOWER(erb.employee_name) = LOWER(we.name)
          AND erb.employee_id IS NULL
    `,
    `
      DELETE FROM employee_runtime_binding
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE employee_runtime_binding
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE employee_runtime_binding
        DROP CONSTRAINT IF EXISTS fk_employee_runtime_binding_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_employee_runtime_binding_employee_id'
            AND conrelid = 'employee_runtime_binding'::regclass
        ) THEN
          ALTER TABLE employee_runtime_binding
            ADD CONSTRAINT fk_employee_runtime_binding_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE;
        END IF;
      END $$
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE employee_recovery_operation AS ero
        SET employee_id = COALESCE(ero.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE ero.workspace_id = we.workspace_id
          AND LOWER(ero.employee_name) = LOWER(we.name)
          AND ero.employee_id IS NULL
    `,
    `
      DELETE FROM employee_recovery_operation
        WHERE employee_id IS NULL
           OR employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      ALTER TABLE employee_recovery_operation
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE employee_recovery_operation
        DROP CONSTRAINT IF EXISTS fk_employee_recovery_operation_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_employee_recovery_operation_employee_id'
            AND conrelid = 'employee_recovery_operation'::regclass
        ) THEN
          ALTER TABLE employee_recovery_operation
            ADD CONSTRAINT fk_employee_recovery_operation_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE;
        END IF;
      END $$
    `,
    `
      ALTER TABLE task_commit_journal
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE task_commit_journal AS tcj
        SET employee_id = COALESCE(tcj.employee_id, we.id)
        FROM workspace_employee AS we
        WHERE tcj.workspace_id = we.workspace_id
          AND tcj.employee_name IS NOT NULL
          AND LOWER(tcj.employee_name) = LOWER(we.name)
          AND tcj.employee_id IS NULL
    `,
    `
      DELETE FROM task_commit_journal
        WHERE employee_id IS NOT NULL
          AND employee_id NOT IN (SELECT id FROM workspace_employee)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_commit_journal_employee_id
        ON task_commit_journal(workspace_id, employee_id)
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS provisioning_task_id TEXT
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS mount_operation_id TEXT
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS approval_state TEXT NOT NULL DEFAULT 'not_required'
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS approved_by_user_id TEXT
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS actor_user_id TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_workspace_mount_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        employee_name TEXT NOT NULL,
        head_revision_id TEXT,
        status TEXT NOT NULL,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_workspace_mount_claim
        ON runtime_workspace_mount_operation(workspace_id, runtime_id, status)
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD COLUMN IF NOT EXISTS materialized_files INTEGER
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD COLUMN IF NOT EXISTS mounted_path TEXT
    `,
    `
      ALTER TABLE task_commit_journal
        DROP CONSTRAINT IF EXISTS fk_task_commit_journal_employee_id
    `,
    `
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_task_commit_journal_employee_id'
            AND conrelid = 'task_commit_journal'::regclass
        ) THEN
          ALTER TABLE task_commit_journal
            ADD CONSTRAINT fk_task_commit_journal_employee_id
            FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE SET NULL;
        END IF;
      END $$
    `,
    `
      CREATE TABLE IF NOT EXISTS backup_restore_drill_run (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        drill_type TEXT NOT NULL DEFAULT 'metadata',
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        finished_at TIMESTAMPTZ,
        sample_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_backup_restore_drill_run_workspace
        ON backup_restore_drill_run(workspace_id, created_at DESC)
    `,
    `
      ALTER TABLE backup_restore_drill_run
        ADD COLUMN IF NOT EXISTS restore_point_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE backup_restore_drill_run
        ADD COLUMN IF NOT EXISTS source_snapshot TEXT
    `,
    `
      ALTER TABLE backup_restore_drill_run
        ADD COLUMN IF NOT EXISTS restore_environment TEXT
    `,
    `
      ALTER TABLE backup_restore_drill_run
        ADD COLUMN IF NOT EXISTS restore_duration_ms INTEGER
    `,
    `
      ALTER TABLE runtime_mcp_connection
        ADD COLUMN IF NOT EXISTS next_health_check_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE runtime_mcp_connection
        ADD COLUMN IF NOT EXISTS health_check_consecutive_failures INTEGER NOT NULL DEFAULT 0
    `,
    `
      ALTER TABLE runtime_mcp_operation
        ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user_verify'
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS skill_execution_snapshot_json JSONB
    `,
    `
      INSERT INTO app_metadata (key, value)
      VALUES ('schema_version', '${POSTGRES_SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `,
  ].map((statement) => statement.trim());
}
