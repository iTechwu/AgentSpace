// 多会话拆分（docs/0820/session-split）：Conversation / Participant / Execution Lane / Provider Session
// 四个领域对象解耦 + agent_task_queue 会话身份列与按 Lane 领取索引。
// 附加迁移阶段（additive schema），元素顺序为新表在前、ALTER 与索引在后；禁止在此重排。
export const conversationStatements: string[] = [
    `
      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        kind TEXT NOT NULL DEFAULT 'direct',
        channel_id TEXT,
        created_by_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        title TEXT,
        summary TEXT,
        summary_source TEXT NOT NULL DEFAULT 'fallback',
        last_message_at TIMESTAMPTZ,
        last_activity_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ,
        version INTEGER NOT NULL DEFAULT 0
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_participant (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        participant_type TEXT NOT NULL,
        user_id TEXT,
        employee_id TEXT,
        display_name_snapshot TEXT,
        joined_at TIMESTAMPTZ NOT NULL,
        left_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_execution_lane (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL,
        router_session_id TEXT REFERENCES agent_router_session(id) ON DELETE SET NULL,
        active_provider_session_id TEXT,
        work_dir TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        active_task_queue_id TEXT,
        last_error_code TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, conversation_id, employee_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_provider_session (
        id TEXT PRIMARY KEY,
        execution_lane_id TEXT NOT NULL REFERENCES conversation_execution_lane(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        runtime_id TEXT REFERENCES agent_runtime(id) ON DELETE SET NULL,
        provider_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        invalidated_at TIMESTAMPTZ,
        invalid_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS conversation_id TEXT
    `,
    `
      ALTER TABLE agent_task_queue
        ADD COLUMN IF NOT EXISTS execution_lane_id TEXT
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_conversation_workspace_activity
        ON conversation(workspace_id, last_activity_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_conversation_participant_employee
        ON conversation_participant(employee_id, conversation_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_conversation_provider_session_lane
        ON conversation_provider_session(execution_lane_id, status, last_used_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_queue_lane_claim
        ON agent_task_queue(runtime_id, status, execution_lane_id, priority, created_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_task_capacity (
        runtime_id TEXT PRIMARY KEY REFERENCES agent_runtime(id) ON DELETE CASCADE,
        max_concurrent_tasks INTEGER NOT NULL,
        max_concurrent_tasks_per_provider_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        source TEXT NOT NULL DEFAULT 'default',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS conversation_message (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
        channel TEXT,
        speaker TEXT NOT NULL,
        speaker_user_id TEXT,
        role TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        kind TEXT,
        process_type TEXT,
        tool TEXT,
        code TEXT,
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        time TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_conversation_message_conversation
        ON conversation_message(conversation_id, created_at)
    `,
];
