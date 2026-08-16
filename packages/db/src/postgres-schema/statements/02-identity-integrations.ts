// 源自 postgres-schema.ts 源行 495-809（users/auth/session/membership + external_* 集成绑定）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const identityIntegrationStatements: string[] = [
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
          WHERE table_schema = current_schema()
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
          WHERE table_schema = current_schema()
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
];

