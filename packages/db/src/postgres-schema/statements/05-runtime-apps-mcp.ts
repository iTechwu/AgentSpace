// 源自 postgres-schema.ts 源行 1200-1490（runtime_app_* + skill/skill_file + mcp_* / runtime_mcp_*）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const runtimeAppMcpStatements: string[] = [
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
      CREATE TABLE IF NOT EXISTS runtime_app_package (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        homepage TEXT,
        created_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, slug)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_app_release (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        package_id TEXT NOT NULL REFERENCES runtime_app_package(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        artifact_name TEXT NOT NULL,
        artifact_url TEXT NOT NULL,
        artifact_integrity TEXT NOT NULL,
        entry_point TEXT NOT NULL,
        manifest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        risk TEXT NOT NULL DEFAULT 'high',
        created_by_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        yanked_at TIMESTAMPTZ,
        UNIQUE(package_id, version)
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
        stage TEXT NOT NULL DEFAULT 'queued',
        failed_stage TEXT,
        stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    `ALTER TABLE runtime_app_operation ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued'`,
    `ALTER TABLE runtime_app_operation ADD COLUMN IF NOT EXISTS failed_stage TEXT`,
    `ALTER TABLE runtime_app_operation ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`,
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
        version TEXT NOT NULL DEFAULT '1.0.0',
        category TEXT NOT NULL DEFAULT 'other',
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
        required_runtime_app_json JSONB,
        synced_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE mcp_catalog_item
        ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'
    `,
    `
      ALTER TABLE mcp_catalog_item
        ADD COLUMN IF NOT EXISTS required_runtime_app_json JSONB
    `,
    `
      UPDATE mcp_catalog_item SET version = '1.0.0' WHERE version = ''
    `,
    `
      ALTER TABLE mcp_catalog_item
        DROP CONSTRAINT IF EXISTS mcp_catalog_item_workspace_id_slug_key
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_catalog_item_release
        ON mcp_catalog_item(workspace_id, slug, version)
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
        stage TEXT NOT NULL DEFAULT 'queued',
        failed_stage TEXT,
        stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    `ALTER TABLE runtime_mcp_operation ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'queued'`,
    `ALTER TABLE runtime_mcp_operation ADD COLUMN IF NOT EXISTS failed_stage TEXT`,
    `ALTER TABLE runtime_mcp_operation ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `
      CREATE TABLE IF NOT EXISTS runtime_mcp_tool_audit (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS mcp_task_audit_authorization (
        task_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        authorization_json JSONB NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
];

