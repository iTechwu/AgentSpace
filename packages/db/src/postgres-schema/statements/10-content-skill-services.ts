// 源自 postgres-schema.ts 源行 3326-3822（content_blob + skill 制品/审批/安装/服务目录 + git 凭据 + pager）。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const contentSkillServiceStatements: string[] = [
    `
      CREATE TABLE IF NOT EXISTS content_blob (
        sha256 TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        storage_provider TEXT NOT NULL DEFAULT 'tos',
        storage_bucket TEXT,
        storage_region TEXT,
        storage_endpoint TEXT,
        storage_key TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, sha256)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        digest TEXT NOT NULL,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        manifest_version INTEGER NOT NULL DEFAULT 1,
        manifest_json JSONB NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        file_count INTEGER NOT NULL DEFAULT 0,
        total_size_bytes BIGINT NOT NULL DEFAULT 0,
        legacy_incomplete INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact_binding (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        artifact_digest TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, skill_id, artifact_digest)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_artifact_file (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES skill_artifact(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        media_type TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT '0644',
        is_text INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(artifact_id, path)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_upgrade_approval (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        from_digest TEXT NOT NULL,
        to_digest TEXT NOT NULL,
        diff_hash TEXT NOT NULL,
        policy_version TEXT NOT NULL DEFAULT 'v1',
        decision TEXT NOT NULL,
        reason TEXT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        UNIQUE(workspace_id, from_digest, to_digest, diff_hash, policy_version)
      )
    `,
    `ALTER TABLE skill_upgrade_approval DROP CONSTRAINT IF EXISTS skill_upgrade_approval_workspace_id_from_digest_to_digest_diff_hash_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_upgrade_approval_policy_lock ON skill_upgrade_approval(workspace_id, from_digest, to_digest, diff_hash, policy_version)`,
    `
      CREATE TABLE IF NOT EXISTS skill_install_approval (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT REFERENCES skill(id) ON DELETE SET NULL,
        artifact_digest TEXT NOT NULL,
        release_lock_digest TEXT NOT NULL,
        policy_version TEXT NOT NULL DEFAULT 'v1',
        risk_decision_digest TEXT NOT NULL,
        decision TEXT NOT NULL,
        risk_items_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        reason TEXT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      )
    `,
    `DROP INDEX IF EXISTS idx_skill_install_approval_lock_decision`,
    `DO $$
      DECLARE c record;
      BEGIN
        FOR c IN SELECT conname FROM pg_constraint
          WHERE conrelid = 'skill_install_approval'::regclass AND contype = 'u'
        LOOP
          EXECUTE format('ALTER TABLE skill_install_approval DROP CONSTRAINT %I', c.conname);
        END LOOP;
      END $$`,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_install_approval_lock
        ON skill_install_approval(workspace_id, artifact_digest, release_lock_digest, policy_version, risk_decision_digest)
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_runner_invocation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        task_id TEXT,
        runtime_id TEXT,
        installation_id TEXT,
        skill_id TEXT,
        skill_name TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        revision TEXT,
        entrypoint_id TEXT NOT NULL,
        entrypoint_key TEXT NOT NULL,
        entrypoint_path TEXT,
        entrypoint_runtime TEXT,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        result_code INTEGER NOT NULL,
        timed_out BOOLEAN NOT NULL DEFAULT false,
        duration_ms INTEGER,
        safe_summary TEXT,
        event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, event_id)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_runner_invocation_task
        ON skill_runner_invocation(workspace_id, task_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_runner_invocation_installation
        ON skill_runner_invocation(workspace_id, installation_id, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_git_credential (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        host TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        reference_name TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        rotated_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        UNIQUE(workspace_id, host)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS pager_alert_state (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        alert_key TEXT NOT NULL,
        code TEXT NOT NULL,
        employee_name TEXT,
        metric TEXT,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        first_seen_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        last_escalated_at TIMESTAMPTZ,
        cleared_at TIMESTAMPTZ,
        UNIQUE(workspace_id, alert_key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_draft (
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
        draft_json JSONB NOT NULL,
        updated_by_user_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (workspace_id, skill_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        artifact_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_lock_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        prepared_path TEXT,
        health TEXT NOT NULL DEFAULT 'unknown',
        previous_ready_revision TEXT,
        revision TEXT NOT NULL,
        installed_at TIMESTAMPTZ,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        previous_ready_artifact_digest TEXT,
        prepared_digest TEXT,
        UNIQUE(workspace_id, runtime_id, artifact_digest, revision),
        FOREIGN KEY (workspace_id, artifact_digest)
          REFERENCES skill_artifact(workspace_id, digest) ON DELETE RESTRICT
      )
    `,
    `
      ALTER TABLE skill_installation
        ADD COLUMN IF NOT EXISTS prepared_digest TEXT
    `,
    `
      ALTER TABLE skill_installation ADD COLUMN IF NOT EXISTS previous_ready_artifact_digest TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_rollout_plan (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        root_artifact_digest TEXT NOT NULL,
        plan_digest TEXT NOT NULL,
        policy_version TEXT NOT NULL DEFAULT 'v1',
        closure_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        target_runtimes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        risk_summary_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        decision TEXT NOT NULL DEFAULT 'pending',
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_rollout_plan_workspace
        ON skill_rollout_plan(workspace_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_rollout_plan_digest
        ON skill_rollout_plan(workspace_id, plan_digest, created_at DESC)
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_rollout_reconcile_item (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES skill_rollout_plan(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'created', 'failed')),
        installation_id TEXT,
        revision TEXT,
        error_code TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(plan_id, runtime_id, artifact_digest)
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_rollout_reconcile_plan_status
        ON skill_rollout_reconcile_item(plan_id, status, updated_at DESC)
    `,
    `
      ALTER TABLE skill_installation
        ADD COLUMN IF NOT EXISTS rollout_plan_id TEXT
          REFERENCES skill_rollout_plan(id) ON DELETE SET NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_installation_rollout_plan
        ON skill_installation(rollout_plan_id)
    `,
    `
      ALTER TABLE skill_artifact ADD COLUMN IF NOT EXISTS coordinate TEXT
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_artifact_coordinate
        ON skill_artifact(workspace_id, coordinate)
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        request_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        safe_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_code TEXT,
        error_message TEXT,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE skill_installation_operation ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `,
    `
      ALTER TABLE skill_installation_operation ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_installation_component (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        key TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        last_operation_id TEXT,
        verified_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(installation_id, kind, key)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_service_catalog (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        template_version TEXT NOT NULL,
        deployment_type TEXT NOT NULL,
        image_digest TEXT NOT NULL,
        protocol TEXT NOT NULL DEFAULT 'http',
        scope TEXT NOT NULL DEFAULT 'workspace_runtime',
        resources_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        health_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        network_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        config_schema_version INTEGER NOT NULL DEFAULT 1,
        config_schema_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        secret_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        external_dependencies_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        rollback_class TEXT NOT NULL DEFAULT 'stateless',
        template_digest TEXT NOT NULL,
        risk TEXT NOT NULL DEFAULT 'high',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, slug, template_version)
      )
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS sbom_digest TEXT
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS run_as_non_root BOOLEAN NOT NULL DEFAULT FALSE
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS read_only_rootfs BOOLEAN NOT NULL DEFAULT TRUE
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS cap_drop_json JSONB NOT NULL DEFAULT '["ALL"]'::jsonb
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS signature_key_pem TEXT
    `,
    `
      ALTER TABLE skill_service_catalog ADD COLUMN IF NOT EXISTS signature_required BOOLEAN NOT NULL DEFAULT FALSE
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_skill_service (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        catalog_id TEXT NOT NULL REFERENCES skill_service_catalog(id) ON DELETE RESTRICT,
        status TEXT NOT NULL,
        network_identity TEXT,
        resource_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_health TEXT,
        last_health_at TIMESTAMPTZ,
        rollout_revision TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, runtime_id, catalog_id)
      )
    `,
    `
      ALTER TABLE managed_skill_service ADD COLUMN IF NOT EXISTS unreferenced_since TIMESTAMPTZ
    `,
    `
      CREATE TABLE IF NOT EXISTS skill_service_binding (
        installation_id TEXT NOT NULL REFERENCES skill_installation(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES managed_skill_service(id) ON DELETE CASCADE,
        catalog_template_version TEXT NOT NULL,
        service_image_digest TEXT NOT NULL,
        endpoint_ref TEXT NOT NULL,
        health_revision TEXT NOT NULL,
        config_schema_version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (installation_id, service_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS managed_skill_service_operation (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        runtime_id TEXT NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
        service_id TEXT NOT NULL REFERENCES managed_skill_service(id) ON DELETE CASCADE,
        installation_id TEXT REFERENCES skill_installation(id) ON DELETE SET NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      ALTER TABLE managed_skill_service_operation ADD COLUMN IF NOT EXISTS replaces_service_id TEXT REFERENCES managed_skill_service(id) ON DELETE SET NULL
    `,
    `
      ALTER TABLE managed_skill_service_operation ADD COLUMN IF NOT EXISTS claim_generation INTEGER NOT NULL DEFAULT 0
    `,
    `
      CREATE TABLE IF NOT EXISTS workspace_service_secret (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        service_catalog_id TEXT NOT NULL REFERENCES skill_service_catalog(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, service_catalog_id, name)
      )
    `,
    `
      ALTER TABLE skill ADD COLUMN IF NOT EXISTS active_artifact_digest TEXT
    `,
    `
      ALTER TABLE agent_skill ADD COLUMN IF NOT EXISTS skill_artifact_digest TEXT
    `,
    `
      ALTER TABLE agent_skill ADD COLUMN IF NOT EXISTS rollout_pin TEXT
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_persistent_workspace (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        head_revision_id TEXT,
        storage_ref TEXT,
        retention_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        storage_health TEXT NOT NULL DEFAULT 'unknown',
        last_snapshot_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        UNIQUE(workspace_id, employee_id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_workspace_revision (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workspace_id_ref TEXT NOT NULL REFERENCES employee_persistent_workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        parent_revision_id TEXT REFERENCES employee_workspace_revision(id) ON DELETE SET NULL,
        manifest_digest TEXT NOT NULL,
        manifest_json JSONB NOT NULL,
        source_task_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        source_kind TEXT NOT NULL DEFAULT 'task_output',
        restored_from_revision_id TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_artifact (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        workspace_id_ref TEXT NOT NULL REFERENCES employee_persistent_workspace(id) ON DELETE CASCADE,
        employee_id TEXT NOT NULL REFERENCES workspace_employee(id) ON DELETE CASCADE,
        employee_name TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        media_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        source_task_id TEXT REFERENCES agent_task_queue(id) ON DELETE SET NULL,
        published_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS employee_data_legal_hold (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        employee_id TEXT,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('employee_workspace', 'artifact', 'revision', 'content_blob')),
        resource_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_by_user_id TEXT,
        created_by_display_name TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        released_at TIMESTAMPTZ,
        released_by_user_id TEXT,
        release_reason TEXT
      )
    `,
    `ALTER TABLE employee_data_legal_hold ADD COLUMN IF NOT EXISTS case_reference TEXT`,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_data_legal_hold_active_resource
        ON employee_data_legal_hold(workspace_id, resource_type, resource_id)
        WHERE released_at IS NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_data_legal_hold_employee_active
        ON employee_data_legal_hold(workspace_id, employee_id, created_at DESC)
        WHERE released_at IS NULL
    `,
];
