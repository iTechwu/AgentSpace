// 源自 postgres-schema.ts 源行 3823-4667（task_commit_journal + employee 持久化/恢复 + mount + backup drill + 尾部迁移）。
import { POSTGRES_SCHEMA_VERSION } from "../version.ts";
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const durabilityTailStatements: string[] = [
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
      ALTER TABLE employee_workspace_revision
        DROP CONSTRAINT IF EXISTS employee_workspace_revision_workspace_id_ref_manifest_digest_key
    `,
    `
      ALTER TABLE employee_workspace_revision
        ADD COLUMN IF NOT EXISTS restored_from_revision_id TEXT
    `,
    `
      UPDATE employee_workspace_revision AS restored
         SET restored_from_revision_id = split_part(restored.source_kind, ':', 2),
             source_kind = 'history_restore'
       WHERE restored.source_kind LIKE 'history_restore:%'
         AND EXISTS (
           SELECT 1 FROM employee_workspace_revision AS source
            WHERE source.id = split_part(restored.source_kind, ':', 2)
              AND source.workspace_id_ref = restored.workspace_id_ref
         )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_workspace_revision_restore_source
        ON employee_workspace_revision(workspace_id_ref, restored_from_revision_id, parent_revision_id)
        WHERE restored_from_revision_id IS NOT NULL
    `,
    `
      ALTER TABLE employee_workspace_revision
        DROP CONSTRAINT IF EXISTS employee_workspace_revision_workspace_id_ref_manifest_diges_key
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_workspace_revision_task_digest
        ON employee_workspace_revision(workspace_id_ref, source_task_id, manifest_digest)
        WHERE source_task_id IS NOT NULL
    `,
    `
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY workspace_id, employee_id ORDER BY created_at DESC, id DESC
        ) AS position
        FROM employee_recovery_operation
        WHERE phase NOT IN ('completed', 'failed')
      )
      UPDATE employee_recovery_operation AS operation
         SET phase = 'failed', error_code = 'duplicate_active_recovery',
             error_message = 'Superseded while enforcing one active recovery per employee.',
             updated_at = NOW()
        FROM ranked
       WHERE operation.id = ranked.id AND ranked.position > 1
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_recovery_one_active
        ON employee_recovery_operation(workspace_id, employee_id)
        WHERE phase NOT IN ('completed', 'failed')
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
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS worker_lease_token TEXT
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS worker_lease_expires_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS worker_attempt INTEGER NOT NULL DEFAULT 0
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_recovery_worker_lease
        ON employee_recovery_operation(phase, approval_state, worker_lease_expires_at, created_at)
    `,
    `
      CREATE TABLE IF NOT EXISTS runtime_workspace_mount_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        head_revision_id TEXT,
        status TEXT NOT NULL,
        claimed_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        claim_generation INTEGER NOT NULL DEFAULT 0,
        completed_at TIMESTAMPTZ,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_workspace_mount_claim
        ON runtime_workspace_mount_operation(workspace_id, runtime_id, status, lease_expires_at)
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
      ALTER TABLE task_message
        ADD COLUMN IF NOT EXISTS ref_id TEXT
    `,
    `
      ALTER TABLE agent_skill
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      UPDATE agent_skill SET agent_id = employee_id
    `,
    `
      ALTER TABLE agent_skill
        ALTER COLUMN agent_id SET NOT NULL
    `,
    `
      ALTER TABLE agent_skill
        DROP CONSTRAINT IF EXISTS agent_skill_pkey
    `,
    `
      ALTER TABLE agent_skill
        ADD CONSTRAINT agent_skill_pkey PRIMARY KEY (workspace_id, employee_id, skill_id)
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        DROP CONSTRAINT IF EXISTS agent_skill_requirement_config_pkey
    `,
    `
      ALTER TABLE agent_skill_requirement_config
        ADD CONSTRAINT agent_skill_requirement_config_pkey PRIMARY KEY (workspace_id, employee_id, skill_id)
    `,
    `
      ALTER TABLE agent_knowledge_page
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      UPDATE agent_knowledge_page SET agent_id = employee_id
    `,
    `
      ALTER TABLE agent_knowledge_page
        ALTER COLUMN agent_id SET NOT NULL
    `,
    `
      ALTER TABLE agent_knowledge_page
        DROP CONSTRAINT IF EXISTS agent_knowledge_page_pkey
    `,
    `
      ALTER TABLE agent_knowledge_page
        ADD CONSTRAINT agent_knowledge_page_pkey PRIMARY KEY (workspace_id, employee_id, knowledge_page_id)
    `,
    `
      ALTER TABLE employee_runtime_binding
        DROP CONSTRAINT IF EXISTS employee_runtime_binding_pkey
    `,
    `
      ALTER TABLE employee_runtime_binding
        ADD CONSTRAINT employee_runtime_binding_pkey PRIMARY KEY (workspace_id, employee_id)
    `,
    `
      ALTER TABLE employee_persistent_workspace
        DROP CONSTRAINT IF EXISTS employee_persistent_workspace_workspace_id_employee_name_key
    `,
    `
      ALTER TABLE employee_persistent_workspace
        DROP CONSTRAINT IF EXISTS employee_persistent_workspace_workspace_id_employee_id_key
    `,
    `
      ALTER TABLE employee_persistent_workspace
        ADD CONSTRAINT employee_persistent_workspace_workspace_id_employee_id_key UNIQUE (workspace_id, employee_id)
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD COLUMN IF NOT EXISTS employee_id TEXT
    `,
    `
      UPDATE runtime_workspace_mount_operation AS mount
         SET employee_id = recovery.employee_id
        FROM employee_recovery_operation AS recovery
       WHERE recovery.mount_operation_id = mount.id
         AND recovery.workspace_id = mount.workspace_id
         AND mount.employee_id IS NULL
    `,
    `
      UPDATE runtime_workspace_mount_operation AS mount
         SET employee_id = we.id
        FROM workspace_employee AS we
       WHERE mount.workspace_id = we.workspace_id
         AND LOWER(mount.employee_name) = LOWER(we.name)
         AND mount.employee_id IS NULL
    `,
    `
      DELETE FROM runtime_workspace_mount_operation
       WHERE employee_id IS NULL
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ALTER COLUMN employee_id SET NOT NULL
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        DROP CONSTRAINT IF EXISTS fk_runtime_workspace_mount_employee_id
    `,
    `
      ALTER TABLE runtime_workspace_mount_operation
        ADD CONSTRAINT fk_runtime_workspace_mount_employee_id
        FOREIGN KEY (employee_id) REFERENCES workspace_employee(id) ON DELETE CASCADE
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_workspace_mount_employee_id
        ON runtime_workspace_mount_operation(workspace_id, employee_id, created_at DESC)
    `,
    `
      CREATE OR REPLACE FUNCTION sync_employee_display_name()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.name IS DISTINCT FROM OLD.name THEN
          UPDATE agent_skill SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE agent_skill_requirement_config SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE agent_knowledge_page SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE employee_persistent_workspace SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE employee_workspace_revision SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE employee_artifact SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE employee_runtime_binding SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE employee_recovery_operation SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE task_commit_journal SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
          UPDATE runtime_workspace_mount_operation SET employee_name = NEW.name
           WHERE workspace_id = NEW.workspace_id AND employee_id = NEW.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
    `
      DROP TRIGGER IF EXISTS trg_workspace_employee_sync_display_name ON workspace_employee
    `,
    `
      CREATE TRIGGER trg_workspace_employee_sync_display_name
      AFTER UPDATE OF name ON workspace_employee
      FOR EACH ROW EXECUTE FUNCTION sync_employee_display_name()
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS required_approvals INTEGER NOT NULL DEFAULT 1
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS approval_count INTEGER NOT NULL DEFAULT 0
    `,
    `
      ALTER TABLE employee_recovery_operation
        ADD COLUMN IF NOT EXISTS approvers_json JSONB NOT NULL DEFAULT '[]'::jsonb
    `,
    // 单实例触发器去重：每个工作流只保留一个触发器（按读取优先级保留最优的一条），
    // 再加上 (workspace_id, workflow_id) 唯一约束作为兜底，防止历史重复数据或绕过逻辑的写入。
    // 不重新指向历史 workflow_run：外键已声明 ON DELETE SET NULL，删除重复触发器时
    // trigger_id 会自动置空，trigger_type 列保留历史事实。若把运行改挂到保留下来的
    // 另一条触发器，手动运行可能指向 schedule 触发器，破坏审计与复现语义。
    `
      WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, workflow_id
            ORDER BY CASE
              WHEN type <> 'manual' AND status = 'active' THEN 0
              WHEN type <> 'manual' AND status = 'suspended' THEN 1
              WHEN type <> 'manual' THEN 2
              WHEN status = 'active' THEN 3
              WHEN status = 'suspended' THEN 4
              ELSE 5
            END, id
          ) AS rn
        FROM workflow_trigger
      )
      DELETE FROM workflow_trigger WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    `,
    `ALTER TABLE workflow_trigger DROP CONSTRAINT IF EXISTS workflow_trigger_workspace_workflow_unique`,
    `ALTER TABLE workflow_trigger ADD CONSTRAINT workflow_trigger_workspace_workflow_unique UNIQUE (workspace_id, workflow_id)`,
    // schema 111/112 数据修复：早期 110 迁移（f7bda25d）在去重时错误地把待删除触发器上的
    // workflow_run.trigger_id 改挂到保留下来的触发器（不分类型），后续修正（edebde49）
    // 移除了该 reparent 但未升版本号，导致已在 buggy 窗口内升级到 110 的库不会重跑修正版，
    // 手动运行可能指向定时/事件触发器。trigger_id 外键为 ON DELETE SET NULL，仅用于溯源，
    // 真正去重键是 trigger_key。这里把两种误链都置空——置空后 trigger_type 仍保留历史事实：
    //   1) 类型不符：trigger_id 指向的触发器类型与 run.trigger_type 不一致（跨类型 reparent）。
    //   2) 同类型但指向错误实例：trigger_key 形如 `${workflowId}:${trigger.id}:${scheduledAt}`，
    //      其第二段就是真正触发该次运行的触发器 id；若 trigger_id 与之不符即为 reparent 误链
    //      （含被删触发器与幸存触发器同类型的情形）。split_part 对非标准 trigger_key 返回空串，
    //      故不会误伤无第二段的旧数据。
    // 幂等：干净或已正确的库无匹配行，整体为 no-op。
    `
      UPDATE workflow_run
      SET trigger_id = NULL, updated_at = NOW()
      WHERE trigger_id IS NOT NULL
        AND (
          EXISTS (
            SELECT 1 FROM workflow_trigger t
            WHERE t.id = workflow_run.trigger_id
              AND t.type <> workflow_run.trigger_type
          )
          OR (
            split_part(trigger_key, ':', 2) <> ''
            AND split_part(trigger_key, ':', 2) <> trigger_id
          )
        )
    `,
    // schema 113：为 workflow_node_run 增加审批限时截止时间列与部分索引，使审批限时扫描能直接
    // 按 (status='waiting_approval', approval_deadline <= now) 索引命中已到期候选，消除「非到期
    // 候选挤占 LIMIT 窗口导致到期审批饥饿」的缺陷。列可空（无限时的审批为 NULL，被扫描查询的
    // NULL 安全分支覆盖）。部分索引只覆盖 waiting_approval 行，避免污染其它状态。
    `ALTER TABLE workflow_node_run ADD COLUMN IF NOT EXISTS approval_deadline TIMESTAMPTZ`,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_node_run_approval_deadline
        ON workflow_node_run (approval_deadline)
        WHERE status = 'waiting_approval' AND approval_deadline IS NOT NULL
    `,
    // schema 114：无法推进的审批候选必须让出有界扫描窗口，否则最早的一批损坏记录会在每轮
    // LIMIT 查询中重复出现并永久饿死后续正常审批。approval_scan_after 持久化下一次扫描时间，
    // 调度键取 scan_after（已延后候选）或 deadline（正常候选），到期重试后再次延后，既释放
    // 当前窗口，也避免曾瞬时失败的正常审批被持续到来的新候选永久饿死。
    `ALTER TABLE workflow_node_run ADD COLUMN IF NOT EXISTS approval_scan_after TIMESTAMPTZ`,
    `
      CREATE INDEX IF NOT EXISTS idx_workflow_node_run_approval_scan
        ON workflow_node_run (
          COALESCE(approval_scan_after, approval_deadline) ASC NULLS LAST,
          approval_deadline ASC NULLS LAST,
          id ASC
        )
        WHERE status = 'waiting_approval' AND approval_id IS NOT NULL
    `,
    // schema 115/116：运行历史分页使用每工作区事务计数器分配的不可变写入序号作为快照上界。
    // 结构段在此结束：history_sequence 列（升级库可空）+ 分配触发器已在前置 DDL 就位，新写入行
    // 即时获得非空序号。回填旧行 UPDATE + SET NOT NULL + history_sequence 在线索引属重型/
    // 阻塞操作，已移出请求路径：维护/迁移命令同步执行（见 getPostgresHistoryBackfillStatements），
    // 运行时由后台自愈（ensurePostgresConcurrentIndexes，独立锁 117）异步完成。回填窗口期分页
    // 由 OR history_sequence IS NULL 谓词保证不丢行。版本写留在结构段末尾。
    `
      INSERT INTO app_metadata (key, value)
      VALUES ('schema_version', '${POSTGRES_SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
      WHERE EXCLUDED.value ~ '^\\d+$'
        AND (app_metadata.value !~ '^\\d+$' OR app_metadata.value::bigint <= EXCLUDED.value::bigint)
    `,
];
