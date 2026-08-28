// 源自 postgres-schema.ts 源行 1491-1804（skill_import/agent_skill + knowledge + openmontage_*）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const skillKnowledgeOpenmontageStatements: string[] = [
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
        agent_id TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, employee_id, skill_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS agent_skill_requirement_config (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        encrypted_secrets_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, employee_id, skill_id)
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
        agent_id TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        knowledge_page_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, employee_id, knowledge_page_id)
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
        runtime_credential_id TEXT,
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
      ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS runtime_credential_id TEXT
    `,
    `
      ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      ALTER TABLE agent_task_queue ADD COLUMN IF NOT EXISTS employee_name TEXT
    `,
    `
      UPDATE agent_task_queue queue
         SET employee_id = employee.id,
             employee_name = COALESCE(queue.employee_name, employee.name)
        FROM workspace_employee employee
       WHERE queue.workspace_id = employee.workspace_id
         AND queue.employee_id IS NULL
         AND (queue.agent_id = employee.id OR LOWER(queue.agent_id) = LOWER(employee.name))
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_employee
        ON agent_task_queue(workspace_id, employee_id, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_delegation_intent (
        idempotency_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
        runtime_id TEXT NOT NULL,
        mcp_connection_id TEXT NOT NULL,
        runtime_credential_id TEXT NOT NULL,
        models_tenant_id TEXT NOT NULL,
        models_team_id TEXT NOT NULL,
        external_job_id TEXT NOT NULL,
        request_json JSONB NOT NULL,
        delegation_id TEXT,
        secret_ref TEXT,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT openmontage_delegation_intent_status_check
          CHECK (status IN ('creating', 'provisioned', 'drain_pending', 'drained', 'bound'))
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_delegation_intent_recovery
        ON openmontage_delegation_intent(status, next_attempt_at)
        WHERE status IN ('creating', 'provisioned', 'drain_pending')
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_openmontage_delegation_intent_remote_unique
        ON openmontage_delegation_intent(delegation_id)
        WHERE delegation_id IS NOT NULL
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_job_link (
        job_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        runtime_credential_id TEXT NOT NULL,
        root_task_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_invocation_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, source_invocation_id)
      )
    `,
    `ALTER TABLE openmontage_job_link ADD COLUMN IF NOT EXISTS runtime_credential_id TEXT`,
    `
      CREATE TABLE IF NOT EXISTS openmontage_model_delegation (
        job_id TEXT PRIMARY KEY REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        delegation_id TEXT NOT NULL UNIQUE,
        runtime_credential_id TEXT NOT NULL,
        models_tenant_id TEXT NOT NULL,
        models_team_id TEXT NOT NULL,
        mcp_connection_id TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        spend_limit TEXT NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_model_delegation_credential
        ON openmontage_model_delegation(runtime_credential_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_job_link_workspace_conversation
        ON openmontage_job_link(workspace_id, conversation_id, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_job_projection (
        job_id TEXT PRIMARY KEY REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        current_stage TEXT,
        snapshot_json JSONB NOT NULL,
        last_applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_applied_sequence >= 0),
        sync_status TEXT NOT NULL DEFAULT 'CURRENT' CHECK (sync_status IN ('CURRENT', 'SYNCING')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_job_projection_workspace_updated
        ON openmontage_job_projection(workspace_id, updated_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_job_event (
        event_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        event_type TEXT NOT NULL,
        event_json JSONB NOT NULL,
        application_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (application_status IN ('pending', 'applied', 'ignored_terminal')),
        received_at TIMESTAMPTZ NOT NULL,
        applied_at TIMESTAMPTZ,
        failure_reason TEXT,
        UNIQUE(job_id, sequence)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_job_event_pending
        ON openmontage_job_event(job_id, sequence)
        WHERE application_status = 'pending'
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_chat_binding (
        job_id TEXT PRIMARY KEY REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        channel_name TEXT NOT NULL,
        conversation_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_chat_binding_workspace_channel
        ON openmontage_chat_binding(workspace_id, channel_name, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_event_nonce (
        nonce TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_event_nonce_expiry
        ON openmontage_event_nonce(expires_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS openmontage_notification_outbox (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES openmontage_job_link(job_id) ON DELETE RESTRICT,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        channel_name TEXT NOT NULL,
        event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
        event_type TEXT NOT NULL DEFAULT 'openmontage.job.changed',
        payload_json JSONB NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
        delivery_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        delivered_at TIMESTAMPTZ,
        UNIQUE(job_id, event_sequence, event_type)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_openmontage_notification_outbox_due
        ON openmontage_notification_outbox(status, next_attempt_at, created_at)
        WHERE status IN ('pending', 'failed')
    `,
];

