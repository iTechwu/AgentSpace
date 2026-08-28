// 源自 postgres-schema.ts 源行 2160-2582（runtime 凭据/维护/供给 + budget + attachment + audit + sso）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const provisioningAuditStatements: string[] = [
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
      CREATE TABLE IF NOT EXISTS openmontage_artifact_grant (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        attachment_id TEXT,
        operation TEXT NOT NULL,
        artifact_role TEXT,
        file_name TEXT,
        media_type TEXT,
        size_bytes BIGINT,
        sha256 TEXT,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (workspace_id, attachment_id)
          REFERENCES attachment(workspace_id, id) ON DELETE CASCADE
      )
    `,
    `ALTER TABLE openmontage_artifact_grant ADD COLUMN IF NOT EXISTS artifact_role TEXT`,
    `ALTER TABLE openmontage_artifact_grant ADD COLUMN IF NOT EXISTS file_name TEXT`,
    `ALTER TABLE openmontage_artifact_grant ADD COLUMN IF NOT EXISTS media_type TEXT`,
    `ALTER TABLE openmontage_artifact_grant ADD COLUMN IF NOT EXISTS size_bytes BIGINT`,
    `ALTER TABLE openmontage_artifact_grant ADD COLUMN IF NOT EXISTS sha256 TEXT`,
    `ALTER TABLE openmontage_artifact_grant ALTER COLUMN attachment_id DROP NOT NULL`,
    `ALTER TABLE openmontage_model_delegation DROP CONSTRAINT IF EXISTS openmontage_model_delegation_job_id_fkey`,
    `ALTER TABLE openmontage_model_delegation ADD CONSTRAINT openmontage_model_delegation_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `ALTER TABLE openmontage_job_projection DROP CONSTRAINT IF EXISTS openmontage_job_projection_job_id_fkey`,
    `ALTER TABLE openmontage_job_projection ADD CONSTRAINT openmontage_job_projection_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `ALTER TABLE openmontage_job_event DROP CONSTRAINT IF EXISTS openmontage_job_event_job_id_fkey`,
    `ALTER TABLE openmontage_job_event ADD CONSTRAINT openmontage_job_event_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `ALTER TABLE openmontage_chat_binding DROP CONSTRAINT IF EXISTS openmontage_chat_binding_job_id_fkey`,
    `ALTER TABLE openmontage_chat_binding ADD CONSTRAINT openmontage_chat_binding_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `ALTER TABLE openmontage_notification_outbox DROP CONSTRAINT IF EXISTS openmontage_notification_outbox_job_id_fkey`,
    `ALTER TABLE openmontage_notification_outbox ADD CONSTRAINT openmontage_notification_outbox_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `ALTER TABLE openmontage_artifact_grant DROP CONSTRAINT IF EXISTS openmontage_artifact_grant_job_id_fkey`,
    `ALTER TABLE openmontage_artifact_grant ADD CONSTRAINT openmontage_artifact_grant_job_id_fkey FOREIGN KEY (job_id) REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT`,
    `
      ALTER TABLE openmontage_artifact_grant
        DROP CONSTRAINT IF EXISTS openmontage_artifact_grant_operation_check
    `,
    `
      ALTER TABLE openmontage_artifact_grant
        DROP CONSTRAINT IF EXISTS openmontage_artifact_grant_shape_check
    `,
    `
      ALTER TABLE openmontage_artifact_grant
        ADD CONSTRAINT openmontage_artifact_grant_operation_check
        CHECK (operation IN ('READ', 'WRITE'))
    `,
    `
      ALTER TABLE openmontage_artifact_grant
        ADD CONSTRAINT openmontage_artifact_grant_shape_check
        CHECK (
          (
            operation = 'READ'
            AND attachment_id IS NOT NULL
            AND artifact_role IS NULL
            AND file_name IS NULL
            AND media_type IS NULL
            AND size_bytes IS NULL
            AND sha256 IS NULL
          )
          OR
          (
            operation = 'WRITE'
            AND attachment_id IS NULL
            AND artifact_role IS NOT NULL
            AND file_name IS NOT NULL
            AND media_type IS NOT NULL
            AND size_bytes > 0
            AND sha256 IS NOT NULL
          )
        )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_artifact_grant_expiry
        ON openmontage_artifact_grant(expires_at)
        WHERE consumed_at IS NULL
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
];

