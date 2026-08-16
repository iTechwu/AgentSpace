// 源自 postgres-schema.ts 源行 810-967（workspace_snapshot + channel 参与者/邀请/准入 + employee/agent fork）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const channelEmployeeStatements: string[] = [
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
];

