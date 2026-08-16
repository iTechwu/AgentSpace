// 源自 postgres-schema.ts 源行 141-494（workspace 基座 + workflow 全家桶定义）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const workspaceWorkflowStatements: string[] = [
    `
      CREATE EXTENSION IF NOT EXISTS "pgcrypto"
    `,
    `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `,
    // schema_version 单调保护（DB 级硬约束）：任何写入尝试把 schema_version 改成更小的数字都
    // 会被拒绝。这是应用层前向守卫的兜底——滚动升级中仍存活的旧版本二进制没有前向守卫逻辑，
    // 会在重启时跑旧迁移并试图把版本写回更低值；触发器让这种降级在数据库层失败（事务回滚），
    // 而非静默覆盖一个已被更高版本迁移过的库。仅对 key='schema_version' 生效；非数字值放行，
    // 避免历史脏值或非版本元数据导致每次写入崩溃。
    `
      CREATE OR REPLACE FUNCTION guard_schema_version_monotonic() RETURNS trigger AS $$
      DECLARE old_int bigint; new_int bigint;
      BEGIN
        IF NEW.key IS DISTINCT FROM 'schema_version' THEN
          RETURN NEW;
        END IF;
        BEGIN
          new_int := NEW.value::bigint;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN NEW;
        END;
        IF TG_OP = 'UPDATE' AND OLD IS NOT NULL THEN
          BEGIN
            old_int := OLD.value::bigint;
          EXCEPTION WHEN invalid_text_representation THEN
            RETURN NEW;
          END;
          IF new_int < old_int THEN
            RAISE EXCEPTION 'schema_version cannot be downgraded from % to %',
              OLD.value, NEW.value USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
    `DROP TRIGGER IF EXISTS app_metadata_schema_version_monotonic ON app_metadata`,
    `
      CREATE TRIGGER app_metadata_schema_version_monotonic
        BEFORE INSERT OR UPDATE OF value ON app_metadata
        FOR EACH ROW EXECUTE FUNCTION guard_schema_version_monotonic()
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        workflow_run_sequence BIGINT NOT NULL DEFAULT 0,
        archived_at TIMESTAMPTZ
      )
    `,
    `ALTER TABLE workspace ADD COLUMN IF NOT EXISTS workflow_run_sequence BIGINT NOT NULL DEFAULT 0`,
    `
      CREATE TABLE IF NOT EXISTS workflow_definition (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        owner_user_id TEXT NOT NULL,
        channel_name TEXT,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'published', 'paused', 'archived')),
        draft_graph_json JSONB NOT NULL DEFAULT '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb,
        draft_version INTEGER NOT NULL DEFAULT 1,
        active_version_id TEXT,
        legacy_source_type TEXT,
        legacy_source_id TEXT,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        archived_at TIMESTAMPTZ,
        UNIQUE(workspace_id, id)
      )
    `,
    `
      ALTER TABLE workflow_definition
        ADD COLUMN IF NOT EXISTS draft_graph_json JSONB NOT NULL
        DEFAULT '{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb
    `,
    `
      ALTER TABLE workflow_definition
        ADD COLUMN IF NOT EXISTS draft_version INTEGER NOT NULL DEFAULT 1
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_version (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL REFERENCES workflow_definition(id),
        version_number INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        graph_json JSONB NOT NULL,
        input_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        output_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        governance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        content_hash TEXT NOT NULL,
        published_by TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workflow_id, version_number),
        UNIQUE(workflow_id, content_hash)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_trigger (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL REFERENCES workflow_definition(id),
        type TEXT NOT NULL CHECK (type IN ('manual', 'schedule', 'event')),
        config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        timezone TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        next_fire_at TIMESTAMPTZ,
        last_fire_at TIMESTAMPTZ,
        misfire_policy TEXT NOT NULL DEFAULT 'skip'
          CHECK (misfire_policy IN ('skip', 'fire_once')),
        dedupe_window_seconds INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `ALTER TABLE workflow_trigger DROP CONSTRAINT IF EXISTS workflow_trigger_misfire_policy_check`,
    `ALTER TABLE workflow_trigger ADD CONSTRAINT workflow_trigger_misfire_policy_check CHECK (misfire_policy IN ('skip', 'fire_once'))`,
    // 归一化历史枚举列为 TEXT：早期 schema（≤115）把一批列建成枚举类型（workflow_trigger_type、
    // workflow_trigger_misfire_policy、workflow_definition_status、openmontage_* 等），后续版本
    // 改为 TEXT 但从未 ALTER 既有列。116→118 迁移的去重/去误链语句会把 workflow_trigger.type 与
    // workflow_run.trigger_type（TEXT）比较——PostgreSQL 不允许枚举与 text 之间隐式比较，报
    // `operator does not exist: workflow_trigger_type <> text`；运行时 INSERT 也会报
    // `column ... is of type <enum> but expression is of type text`。
    // 这里幂等地把所有历史枚举列归一为 TEXT：已是 TEXT 的列是 no-op；枚举列用 ::text 转换
    // （枚举标签即当前 CHECK/DEFAULT 允许值）。`ALTER TABLE IF EXISTS` 兼容表尚未创建的位置；
    // 若表不存在则跳过——后续 CREATE TABLE IF NOT EXISTS 会按 TEXT 新建。须位于任何枚举↔text
    // 比较语句之前。
    `
      CREATE OR REPLACE FUNCTION column_is_enum(table_name text, column_name text)
      RETURNS boolean AS $$
      DECLARE result boolean;
      BEGIN
        SELECT EXISTS (
          SELECT 1
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_type t ON t.oid = a.atttypid
          WHERE c.relname = table_name AND a.attname = column_name AND t.typtype = 'e'
        ) INTO result;
        RETURN COALESCE(result, false);
      END;
      $$ LANGUAGE plpgsql;
    `,
    `
      DO $$
      BEGIN
        ALTER TABLE IF EXISTS workflow_trigger ALTER COLUMN type TYPE TEXT USING type::text;
        -- misfire_policy 的 CHECK 在本迁移靠前被重建为 misfire_policy = ANY(ARRAY[...'::workflow_trigger_misfire_policy])
        -- （列仍为枚举时字面量被强转成枚举，text = enum 无法校验）。ALTER 前先删 CHECK，ALTER 后再以
        -- 纯字面量重建（此时列已是 TEXT，字面量落为 text），否则 ALTER COLUMN ... TYPE 重新校验会报
        -- operator does not exist: text = workflow_trigger_misfire_policy。
        ALTER TABLE IF EXISTS workflow_trigger DROP CONSTRAINT IF EXISTS workflow_trigger_misfire_policy_check;
        ALTER TABLE IF EXISTS workflow_trigger ALTER COLUMN misfire_policy TYPE TEXT USING misfire_policy::text;
        ALTER TABLE IF EXISTS workflow_trigger ADD CONSTRAINT workflow_trigger_misfire_policy_check
          CHECK (misfire_policy IN ('skip', 'fire_once'));
        ALTER TABLE IF EXISTS workflow_definition ALTER COLUMN status TYPE TEXT USING status::text;
        -- 这三列有部分索引，其 WHERE 谓词被存储为显式枚举强转（status = 'pending'::enum），ALTER 时
        -- 重新校验谓词会报 text = enum。仅在列仍为枚举时删索引（P2: 避免常规启动对已 TEXT 的大表
        -- 反复 DROP/重建索引的 DDL 锁）；本迁移后续的 CREATE INDEX IF NOT EXISTS 会在 TEXT 列上
        -- 用纯字面量重建（schema 已含对应索引定义）。
        IF column_is_enum('openmontage_delegation_intent', 'status') THEN
          DROP INDEX IF EXISTS idx_openmontage_delegation_intent_recovery;
        END IF;
        ALTER TABLE IF EXISTS openmontage_delegation_intent ALTER COLUMN status TYPE TEXT USING status::text;
        ALTER TABLE IF EXISTS openmontage_job_projection ALTER COLUMN sync_status TYPE TEXT USING sync_status::text;
        IF column_is_enum('openmontage_job_event', 'application_status') THEN
          DROP INDEX IF EXISTS idx_openmontage_job_event_pending;
        END IF;
        ALTER TABLE IF EXISTS openmontage_job_event ALTER COLUMN application_status TYPE TEXT USING application_status::text;
        IF column_is_enum('openmontage_notification_outbox', 'status') THEN
          DROP INDEX IF EXISTS idx_openmontage_notification_outbox_due;
        END IF;
        ALTER TABLE IF EXISTS openmontage_notification_outbox ALTER COLUMN status TYPE TEXT USING status::text;
        -- openmontage_artifact_grant.operation 的两条 CHECK 被存储为显式枚举强转（operation = 'READ'::enum），
        -- text = enum 无法在 ALTER 时重新校验。先删两条 CHECK，ALTER 为 TEXT 后再以纯字面量重建。
        ALTER TABLE IF EXISTS openmontage_artifact_grant DROP CONSTRAINT IF EXISTS openmontage_artifact_grant_operation_check;
        ALTER TABLE IF EXISTS openmontage_artifact_grant DROP CONSTRAINT IF EXISTS openmontage_artifact_grant_shape_check;
        ALTER TABLE IF EXISTS openmontage_artifact_grant ALTER COLUMN operation TYPE TEXT USING operation::text;
        ALTER TABLE IF EXISTS openmontage_artifact_grant ADD CONSTRAINT openmontage_artifact_grant_operation_check
          CHECK (operation IN ('READ', 'WRITE'));
        ALTER TABLE IF EXISTS openmontage_artifact_grant ADD CONSTRAINT openmontage_artifact_grant_shape_check
          CHECK (
            (operation = 'READ' AND attachment_id IS NOT NULL AND artifact_role IS NULL AND file_name IS NULL
             AND media_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL)
            OR
            (operation = 'WRITE' AND attachment_id IS NULL AND artifact_role IS NOT NULL AND file_name IS NOT NULL
             AND media_type IS NOT NULL AND size_bytes > 0 AND sha256 IS NOT NULL)
          );
        ALTER TABLE IF EXISTS employee_data_legal_hold ALTER COLUMN resource_type TYPE TEXT USING resource_type::text;
      END $$;
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_run (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workflow_id TEXT NOT NULL REFERENCES workflow_definition(id),
        version_id TEXT NOT NULL REFERENCES workflow_version(id),
        root_task_id TEXT,
        trigger_id TEXT REFERENCES workflow_trigger(id) ON DELETE SET NULL,
        trigger_type TEXT NOT NULL,
        trigger_key TEXT NOT NULL,
        history_sequence BIGINT NOT NULL,
        input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'created',
        current_sequence INTEGER NOT NULL DEFAULT 0,
        budget_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, trigger_key)
      )
    `,
    `ALTER TABLE workflow_run ADD COLUMN IF NOT EXISTS history_sequence BIGINT`,
    `ALTER TABLE workflow_run ALTER COLUMN history_sequence DROP IDENTITY IF EXISTS`,
    `
      CREATE OR REPLACE FUNCTION assign_workflow_run_history_sequence()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.history_sequence IS NULL THEN
          UPDATE workspace
             SET workflow_run_sequence = workflow_run_sequence + 1
           WHERE id = NEW.workspace_id
           RETURNING workflow_run_sequence INTO NEW.history_sequence;
        END IF;
        RETURN NEW;
      END;
      $$
    `,
    `DROP TRIGGER IF EXISTS workflow_run_assign_history_sequence ON workflow_run`,
    `
      CREATE TRIGGER workflow_run_assign_history_sequence
      BEFORE INSERT ON workflow_run
      FOR EACH ROW
      EXECUTE FUNCTION assign_workflow_run_history_sequence()
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_node_run (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        node_type TEXT NOT NULL,
        employee_id TEXT,
        employee_name_snapshot TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        available_at TIMESTAMPTZ,
        task_queue_id TEXT,
        approval_id TEXT,
        approval_deadline TIMESTAMPTZ,
        approval_scan_after TIMESTAMPTZ,
        input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        output_json JSONB,
        artifact_manifest_json JSONB,
        error_code TEXT,
        error_message TEXT,
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(run_id, node_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_run_event (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
        node_run_id TEXT REFERENCES workflow_node_run(id) ON DELETE SET NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        data_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(run_id, sequence)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS workflow_outbox (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        aggregate_type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TIMESTAMPTZ NOT NULL,
        locked_at TIMESTAMPTZ,
        locked_by TEXT,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_definition_legacy_source
        ON workflow_definition(workspace_id, legacy_source_type, legacy_source_id)
        WHERE legacy_source_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_trigger_key
        ON workflow_run(workspace_id, trigger_key)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_trigger_due
        ON workflow_trigger(status, next_fire_at)
        WHERE status = 'active'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_node_run_ready
        ON workflow_node_run(status, available_at)
        WHERE status IN ('ready', 'retry_wait')
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_run_workspace_created
        ON workflow_run(workspace_id, created_at DESC, id DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_run_event_run_sequence
        ON workflow_run_event(run_id, sequence ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_node_run_task_queue
        ON workflow_node_run(workspace_id, task_queue_id)
        WHERE task_queue_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_outbox_due
        ON workflow_outbox(status, available_at)
        WHERE status = 'pending'
    `,
];

