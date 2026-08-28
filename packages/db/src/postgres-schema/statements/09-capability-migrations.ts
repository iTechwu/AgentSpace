// 源自 postgres-schema.ts 源行 2583-3325（capability_request + 主体迁移间隙（ALTER/索引/回填））。
// 仅按迁移阶段机械切分，元素顺序与原数组完全一致；禁止在此重排。
export const capabilityMigrationStatements: string[] = [
    `
      CREATE TABLE IF NOT EXISTS capability_request (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        runtime_id TEXT REFERENCES agent_runtime(id) ON DELETE SET NULL,
        package_kind TEXT NOT NULL,
        package_source TEXT NOT NULL,
        package_slug TEXT NOT NULL,
        package_display_name TEXT NOT NULL,
        deployment_mode TEXT NOT NULL,
        requested_action TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        decision_reason TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        linked_runtime_app_operation_id TEXT REFERENCES runtime_app_operation(id) ON DELETE SET NULL,
        linked_runtime_installed_app_id TEXT REFERENCES runtime_installed_app(id) ON DELETE SET NULL,
        linked_mcp_connection_id TEXT REFERENCES runtime_mcp_connection(id) ON DELETE SET NULL,
        linked_runtime_provisioning_task_id TEXT REFERENCES runtime_provisioning_task(id) ON DELETE SET NULL,
        linked_knowledge_page_id TEXT,
        release_id TEXT REFERENCES runtime_app_release(id) ON DELETE SET NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        UNIQUE(workspace_id, runtime_id, package_kind, package_source, package_slug, requested_action)
      )
    `,
    `ALTER TABLE capability_request ADD COLUMN IF NOT EXISTS linked_knowledge_page_id TEXT`,
    `ALTER TABLE capability_request ADD COLUMN IF NOT EXISTS release_id TEXT REFERENCES runtime_app_release(id) ON DELETE SET NULL`,
    `
      CREATE INDEX IF NOT EXISTS idx_capability_request_workspace_status
        ON capability_request(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_capability_request_runtime_status
        ON capability_request(workspace_id, runtime_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_capability_request_requester
        ON capability_request(workspace_id, requested_by_user_id, created_at DESC)
    `,
    // Phase 5: managed-service provision convergence looks requests up by the
    // JSONB field metadata_json->>'skillServiceOperationId' — an expression
    // index keeps that lookup from degrading into a workspace scan as requests
    // grow (docs/0811/cli-install Phase 5).
    `
      CREATE INDEX IF NOT EXISTS idx_capability_request_skill_service_operation
        ON capability_request ((metadata_json->>'skillServiceOperationId'))
        WHERE metadata_json->>'skillServiceOperationId' IS NOT NULL
    `,
    ...[
      "channelDocumentVersions",
      "channelDocumentBlocks",
      "channelDocumentAccesses",
      "channelDocumentChangeSets",
      "channelDocumentConflicts",
      "channelDocumentPresences",
      "channelDocumentRuns",
    ].map((fieldName) => `
      UPDATE workspace_snapshot
      SET state_json = jsonb_set(
        state_json,
        '{${fieldName}}',
        COALESCE((
          SELECT jsonb_agg(item)
          FROM jsonb_array_elements(COALESCE(state_json->'${fieldName}', '[]'::jsonb)) AS item
          WHERE EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(state_json->'channelDocuments', '[]'::jsonb)) AS document
            WHERE document->>'id' = item->>'documentId'
          )
        ), '[]'::jsonb)
      )
    `),
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_slug
        ON workspace(slug)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_membership_user
        ON workspace_membership(user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_membership_workspace
        ON workspace_membership(workspace_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_channel_workspace
        ON workspace_channel(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_participant_channel_status
        ON channel_participant(workspace_id, channel_name, status, joined_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_participant_user_status
        ON channel_participant(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_access_request_channel_status
        ON channel_access_request(workspace_id, channel_name, status, requested_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_access_request_user_status
        ON channel_access_request(workspace_id, user_id, status)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_access_request_pending_user
        ON channel_access_request(workspace_id, channel_name, user_id)
        WHERE status = 'pending'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_channel_status
        ON channel_invitation(workspace_id, channel_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_user_status
        ON channel_invitation(workspace_id, invitee_user_id, status)
        WHERE invitee_user_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_invitation_pending_user
        ON channel_invitation(workspace_id, channel_name, invitee_user_id)
        WHERE status = 'pending' AND invitee_user_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_channel_invitation_email_status
        ON channel_invitation(workspace_id, invitee_email, status)
        WHERE invitee_email IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_invitation_pending_email
        ON channel_invitation(workspace_id, channel_name, invitee_email)
        WHERE status = 'pending' AND invitee_email IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_employee_workspace
        ON workspace_employee(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_target_status
        ON agent_fork_invitation(workspace_id, target_user_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_source_status
        ON agent_fork_invitation(workspace_id, source_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_fork_invitation_creator_status
        ON agent_fork_invitation(workspace_id, created_by_user_id, status, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_fork_invitation_pending_unique
        ON agent_fork_invitation(workspace_id, source_agent_name, target_user_id)
        WHERE status = 'pending'
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_fork_snapshot_invitation
        ON agent_fork_snapshot(workspace_id, invitation_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_task_workspace
        ON workspace_task(workspace_id, status, updated_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_auth_identity_user
        ON auth_identity(user_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_session_user
        ON session(user_id)
    `,
    `
      DROP INDEX IF EXISTS idx_agent_runtime_workspace_daemon_provider
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runtime_workspace_daemon_provider
        ON agent_runtime(workspace_id, daemon_connection_id, provider)
        WHERE managed_credential_id IS NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_status
        ON agent_runtime(workspace_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_runtime_managed_credential
        ON agent_runtime(workspace_id, managed_credential_id)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_team_unique
        ON workspace_sso_binding(team_id)
        WHERE team_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sso_binding_tenant_unique
        ON workspace_sso_binding(tenant_id)
        WHERE source = 'tenant'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_workspace_status
        ON runtime_provisioning_task(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_runtime
        ON runtime_provisioning_task(runtime_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_provisioning_task_event_task
        ON runtime_provisioning_task_event(task_id, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_credential_recovery_runtime_status
        ON runtime_credential_recovery_task(runtime_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_daemon_api_token_workspace
        ON daemon_api_token(workspace_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_runtime_grant_user
        ON workspace_runtime_grant(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_runtime_grant_runtime
        ON workspace_runtime_grant(workspace_id, runtime_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_agent_access_subject
        ON document_agent_access(workspace_id, subject_type, subject_id, revoked_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_agent_access_document
        ON document_agent_access(workspace_id, document_id, revoked_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_permission_request_workspace_status
        ON document_permission_request(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_document_permission_request_agent
        ON document_permission_request(workspace_id, requested_by_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_access_request_source_status
        ON agent_access_request(workspace_id, source_agent_name, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_access_request_requester_status
        ON agent_access_request(workspace_id, requester_user_id, status, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_access_request_pending_unique
        ON agent_access_request(workspace_id, source_agent_name, requester_user_id, request_type, COALESCE(target_channel_name, ''))
        WHERE status = 'pending'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_notification_recipient_status_created
        ON workspace_notification(workspace_id, recipient_type, recipient_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_workspace_notification_resource
        ON workspace_notification(workspace_id, resource_type, resource_id, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_notification_dedupe
        ON workspace_notification(workspace_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_permission_request_pending_agent_document
        ON document_permission_request(workspace_id, requested_by_agent_name, requested_role, document_id, requested_for_channel_name)
        WHERE status = 'pending' AND document_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_document_permission_request_pending_agent_external
        ON document_permission_request(workspace_id, requested_by_agent_name, requested_role, external_provider, external_file_id, requested_for_channel_name)
        WHERE status = 'pending' AND external_file_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_employee_runtime_binding_runtime
        ON employee_runtime_binding(runtime_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_catalog_category
        ON runtime_app_catalog_item(source, category, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_installed_app_runtime
        ON runtime_installed_app(workspace_id, runtime_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_operation_runtime_status
        ON runtime_app_operation(workspace_id, runtime_id, status, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_operation_app
        ON runtime_app_operation(workspace_id, app_source, app_name, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_app_skill_binding_skill
        ON runtime_app_skill_binding(workspace_id, skill_id)
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
      CREATE INDEX IF NOT EXISTS idx_mcp_catalog_item_workspace
        ON mcp_catalog_item(workspace_id, slug)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_connection_runtime_status
        ON runtime_mcp_connection(workspace_id, runtime_id, status)
    `,
    `
      ALTER TABLE runtime_mcp_tool_audit
        ADD COLUMN IF NOT EXISTS event_id TEXT
    `,
    `
      ALTER TABLE runtime_mcp_tool_audit
        DROP CONSTRAINT IF EXISTS runtime_mcp_tool_audit_connection_id_fkey
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_mcp_tool_audit_event
        ON runtime_mcp_tool_audit(workspace_id, event_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_connection_health_due
        ON runtime_mcp_connection(workspace_id, status, next_health_check_at)
        WHERE status = 'ready'
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_operation_runtime_status
        ON runtime_mcp_operation(workspace_id, runtime_id, status, source, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_operation_connection
        ON runtime_mcp_operation(workspace_id, connection_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_discovery_snapshot_connection
        ON runtime_mcp_discovery_snapshot(connection_id, discovered_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_tool_audit_connection
        ON runtime_mcp_tool_audit(workspace_id, connection_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_runtime_mcp_tool_audit_created
        ON runtime_mcp_tool_audit(created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_mcp_task_audit_authorization_expiry
        ON mcp_task_audit_authorization(expires_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_workspace_name
        ON skill(workspace_id, name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_file_skill
        ON skill_file(skill_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_skill_import_event_workspace_imported
        ON skill_import_event(workspace_id, imported_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_skill_employee
        ON agent_skill(workspace_id, employee_name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_skill_requirement_config_employee
        ON agent_skill_requirement_config(workspace_id, employee_name, skill_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_assignment_policy_page
        ON knowledge_page_assignment_policy(workspace_id, knowledge_page_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_knowledge_page_employee
        ON agent_knowledge_page(workspace_id, employee_name)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_knowledge_page_page
        ON agent_knowledge_page(workspace_id, knowledge_page_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_workspace_status_created
        ON knowledge_proposal(workspace_id, status, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_source_task
        ON knowledge_proposal(workspace_id, source_task_queue_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_knowledge_proposal_approval
        ON knowledge_proposal(workspace_id, approval_id)
        WHERE approval_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_router_session_conversation
        ON agent_router_session(workspace_id, agent_id, conversation_key)
        WHERE conversation_key IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_session_agent_updated
        ON agent_router_session(workspace_id, agent_id, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_provider_session_router
        ON agent_router_provider_session(workspace_id, router_session_id, status, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_attempt_task_created
        ON agent_task_attempt(task_queue_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_attempt_router_created
        ON agent_task_attempt(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_event_router_created
        ON agent_router_event(workspace_id, router_session_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_event_task_created
        ON agent_router_event(task_queue_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_router_context_snapshot_router_created
        ON agent_router_context_snapshot(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_runtime_status_priority
        ON agent_task_queue(runtime_id, status, priority DESC, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_router_session
        ON agent_task_queue(workspace_id, router_session_id, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_message_task_seq
        ON task_message(task_id, seq)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_workspace_created
        ON task_execution_event(workspace_id, created_at DESC, id DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_task_created
        ON task_execution_event(task_id, created_at ASC, id ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_runtime_created
        ON task_execution_event(workspace_id, runtime_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_task_execution_event_channel_created
        ON task_execution_event(workspace_id, channel_name, created_at DESC)
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_workspace_scope
        ON budget(workspace_id, scope, scope_id)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_created
        ON token_usage(workspace_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent
        ON token_usage(workspace_id, agent_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_runtime_credential
        ON token_usage(workspace_id, runtime_credential_id, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_billing_status
        ON token_usage(workspace_id, billing_status, created_at)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_gateway_request
        ON token_usage(gateway_request_id)
        WHERE gateway_request_id IS NOT NULL
    `,
    `
      WITH ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_usage_id
            ORDER BY
              CASE WHEN task_queue_id IS NOT NULL THEN 0 ELSE 1 END,
              created_at,
              id
          ) AS duplicate_rank
        FROM token_usage
        WHERE gateway_usage_id IS NOT NULL
      )
      UPDATE token_usage
      SET gateway_usage_id = NULL
      FROM ranked
      WHERE token_usage.id = ranked.id
        AND ranked.duplicate_rank > 1
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_workspace_gateway_usage_unique
        ON token_usage(workspace_id, gateway_usage_id)
        WHERE gateway_usage_id IS NOT NULL
    `,
    `
      WITH ranked AS (
        SELECT id, workspace_id, gateway_request_id, runtime_credential_id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_request_id
            ORDER BY
              CASE
                WHEN task_queue_id IS NOT NULL THEN 0
                WHEN billing_status = 'reconciled' THEN 1
                WHEN billing_status = 'estimated' THEN 2
                ELSE 3
              END,
              created_at,
              id
          ) AS duplicate_rank
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL
      ),
      keepers AS (
        SELECT workspace_id, gateway_request_id, runtime_credential_id
        FROM ranked
        WHERE duplicate_rank = 1
      ),
      conflicts AS (
        SELECT ranked.id
        FROM ranked
        JOIN keepers
          ON keepers.workspace_id = ranked.workspace_id
         AND keepers.gateway_request_id = ranked.gateway_request_id
        WHERE ranked.duplicate_rank > 1
          AND ranked.runtime_credential_id IS NOT NULL
          AND keepers.runtime_credential_id IS NOT NULL
          AND ranked.runtime_credential_id <> keepers.runtime_credential_id
      )
      UPDATE token_usage AS conflicting
      SET gateway_request_id = NULL
      FROM conflicts
      WHERE conflicting.id = conflicts.id
    `,
    `
      WITH ranked AS (
        SELECT id, workspace_id, gateway_request_id,
          ROW_NUMBER() OVER (
            PARTITION BY workspace_id, gateway_request_id
            ORDER BY
              CASE
                WHEN task_queue_id IS NOT NULL THEN 0
                WHEN billing_status = 'reconciled' THEN 1
                WHEN billing_status = 'estimated' THEN 2
                ELSE 3
              END,
              created_at,
              id
          ) AS duplicate_rank,
          COUNT(*) OVER (PARTITION BY workspace_id, gateway_request_id) AS duplicate_count
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL
      ),
      keepers AS (
        SELECT id, workspace_id, gateway_request_id
        FROM ranked
        WHERE duplicate_rank = 1 AND duplicate_count > 1
      ),
      actuals AS (
        SELECT DISTINCT ON (workspace_id, gateway_request_id)
          workspace_id, gateway_request_id, runtime_credential_id, model_id,
          input_tokens, output_tokens, actual_cost_usd, currency, reconciled_at
        FROM token_usage
        WHERE gateway_request_id IS NOT NULL AND actual_cost_usd IS NOT NULL
        ORDER BY workspace_id, gateway_request_id,
          CASE billing_status WHEN 'reconciled' THEN 0 WHEN 'unallocated' THEN 1 ELSE 2 END,
          created_at,
          id
      )
      UPDATE token_usage AS keeper
      SET actual_cost_usd = COALESCE(actuals.actual_cost_usd, keeper.actual_cost_usd),
          currency = COALESCE(actuals.currency, keeper.currency),
          runtime_credential_id = COALESCE(keeper.runtime_credential_id, actuals.runtime_credential_id),
          model_id = actuals.model_id,
          input_tokens = CASE
            WHEN actuals.input_tokens + actuals.output_tokens > 0 THEN actuals.input_tokens
            ELSE keeper.input_tokens
          END,
          output_tokens = CASE
            WHEN actuals.input_tokens + actuals.output_tokens > 0 THEN actuals.output_tokens
            ELSE keeper.output_tokens
          END,
          billing_status = CASE WHEN actuals.actual_cost_usd IS NOT NULL THEN 'reconciled' ELSE keeper.billing_status END,
          reconciled_at = CASE
            WHEN actuals.actual_cost_usd IS NOT NULL THEN COALESCE(actuals.reconciled_at, keeper.reconciled_at, NOW())
            ELSE keeper.reconciled_at
          END
      FROM keepers
      JOIN actuals
        ON actuals.workspace_id = keepers.workspace_id
       AND actuals.gateway_request_id = keepers.gateway_request_id
      WHERE keeper.id = keepers.id
       AND (
         actuals.runtime_credential_id IS NULL
         OR keeper.runtime_credential_id IS NULL
         OR actuals.runtime_credential_id = keeper.runtime_credential_id
       )
    `,
    `
      DELETE FROM token_usage
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY workspace_id, gateway_request_id
              ORDER BY
                CASE
                  WHEN task_queue_id IS NOT NULL THEN 0
                  WHEN billing_status = 'reconciled' THEN 1
                  WHEN billing_status = 'estimated' THEN 2
                  ELSE 3
                END,
                created_at,
                id
            ) AS duplicate_rank
          FROM token_usage
          WHERE gateway_request_id IS NOT NULL
        ) ranked
        WHERE duplicate_rank > 1
      )
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_workspace_gateway_request_unique
        ON token_usage(workspace_id, gateway_request_id)
        WHERE gateway_request_id IS NOT NULL
    `,
    `CREATE INDEX IF NOT EXISTS idx_provider_account_workspace ON provider_account(workspace_id, provider, status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_provision_request_workspace ON runtime_provision_request(workspace_id, status, created_at DESC)`,
    `
      CREATE INDEX IF NOT EXISTS idx_attachment_workspace_message
        ON attachment(workspace_id, message_id, source_message_index)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_attachment_storage_key
        ON attachment(storage_provider, storage_bucket, storage_key)
        WHERE storage_key IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created
        ON audit_log(workspace_id, created_at DESC, source_index DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_audit_log_code_created
        ON audit_log(workspace_id, code, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_workspace_provider
        ON external_integration(workspace_id, provider, status, updated_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_agent
        ON external_integration(workspace_id, provider, agent_id, status, updated_at DESC)
        WHERE agent_id IS NOT NULL
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_integration_active_agent
        ON external_integration(workspace_id, provider, agent_id)
        WHERE agent_id IS NOT NULL AND status <> 'disabled'
    `,
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_integration_provider_app_tenant
        ON external_integration(workspace_id, provider, app_id, COALESCE(tenant_key, ''))
        WHERE app_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_user_binding_user
        ON external_user_binding(workspace_id, user_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_user_binding_external_open
        ON external_user_binding(integration_id, external_open_id)
        WHERE external_open_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_channel_binding_workspace_channel
        ON external_channel_binding(workspace_id, channel_name, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_resource_binding_workspace_resource
        ON external_resource_binding(workspace_id, dofe_agent_resource_type, dofe_agent_resource_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_resource_binding_channel
        ON external_resource_binding(workspace_id, channel_name, status)
        WHERE channel_name IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_message_mapping_task
        ON external_message_mapping(workspace_id, task_queue_id)
        WHERE task_queue_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_thread_binding_lookup
        ON external_thread_binding(workspace_id, provider, tenant_key, external_chat_id, external_thread_id, status)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_thread_binding_task
        ON external_thread_binding(workspace_id, task_queue_id)
        WHERE task_queue_id IS NOT NULL
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_message_outbox_due
        ON external_message_outbox(status, next_attempt_at, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_token_usage_retry_due
        ON token_usage_retry(status, next_attempt_at, created_at ASC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_data_operation_run_resource_created
        ON external_data_operation_run(workspace_id, resource_binding_id, created_at DESC)
    `,
    `
      CREATE INDEX IF NOT EXISTS idx_external_integration_event_status
        ON external_integration_event(workspace_id, provider, status, received_at ASC)
    `,
    // ----- Employee data durability (EAD-001 .. EAD-005) -----
];
