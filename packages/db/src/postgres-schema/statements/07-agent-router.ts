// 源自 postgres-schema.ts 源行 1805-2159（external_thread_binding + agent_router_* + 相邻迁移）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const agentRouterStatements: string[] = [
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
          WHERE table_schema = current_schema()
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
        ref_id TEXT,
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
        delegation_id TEXT,
        employee_id TEXT,
        runtime_id TEXT,
        job_id TEXT,
        pipeline_stage TEXT,
        source_invocation_id TEXT,
        model_invocation_id TEXT,
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
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS delegation_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS employee_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS runtime_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS job_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS pipeline_stage TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS source_invocation_id TEXT`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS model_invocation_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_token_usage_delegation_model_invocation
       ON token_usage(workspace_id, delegation_id, model_invocation_id)
       WHERE delegation_id IS NOT NULL AND model_invocation_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_token_usage_openmontage_job
       ON token_usage(workspace_id, job_id, pipeline_stage, created_at)`,
    `
      CREATE OR REPLACE FUNCTION validate_delegated_token_usage_snapshot()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.delegation_id IS NOT NULL AND (
          NEW.employee_id IS NULL OR NEW.runtime_id IS NULL OR NEW.job_id IS NULL
          OR NEW.pipeline_stage IS NULL OR NEW.source_invocation_id IS NULL
          OR NEW.model_invocation_id IS NULL
        ) THEN
          RAISE EXCEPTION 'token_usage.delegation_snapshot_required';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
    `DROP TRIGGER IF EXISTS trg_validate_delegated_token_usage_snapshot ON token_usage`,
    `
      CREATE TRIGGER trg_validate_delegated_token_usage_snapshot
      BEFORE INSERT OR UPDATE ON token_usage
      FOR EACH ROW EXECUTE FUNCTION validate_delegated_token_usage_snapshot()
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
];

