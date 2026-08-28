// 源自 postgres-schema.ts 源行 968-1199（task + daemon/agent_runtime + document 授权 + notification + employee binding）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const runtimeDocumentStatements: string[] = [
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
        PRIMARY KEY (workspace_id, employee_id)
      )
    `,
];

