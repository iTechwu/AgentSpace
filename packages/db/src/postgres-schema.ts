// 版本/锁常量拆至 ./postgres-schema/version.ts，此处 re-export 保持对外导出面不变。
export {
  POSTGRES_SCHEMA_VERSION,
  POSTGRES_SCHEMA_ADVISORY_LOCK_ID,
  POSTGRES_SCHEMA_ADVISORY_LOCK_IDS,
  POSTGRES_BACKGROUND_MAINTENANCE_LOCK_ID,
} from "./postgres-schema/version.ts";

export const POSTGRES_TABLE_NAMES = [
  "app_metadata",
  "workspace",
  "workflow_definition",
  "workflow_version",
  "workflow_trigger",
  "workflow_run",
  "workflow_node_run",
  "workflow_run_event",
  "workflow_outbox",
  "users",
  "auth_identity",
  "session",
  "workspace_membership",
  "external_integration",
  "external_user_binding",
  "external_channel_binding",
  "external_resource_binding",
  "external_message_mapping",
  "external_message_outbox",
  "external_data_operation_run",
  "external_integration_event",
  "workspace_snapshot",
  "workspace_channel",
  "channel_participant",
  "channel_access_request",
  "channel_invitation",
  "workspace_employee",
  "agent_fork_invitation",
  "agent_fork_snapshot",
  "workspace_task",
  "daemon_connection",
  "daemon_api_token",
  "provider_account",
  "agent_runtime",
  "runtime_provision_request",
  "workspace_runtime_display_name",
  "workspace_runtime_grant",
  "document_agent_access",
  "document_permission_request",
  "agent_access_request",
  "workspace_notification",
  "employee_runtime_binding",
  "runtime_app_catalog_item",
  "runtime_app_package",
  "runtime_app_release",
  "runtime_installed_app",
  "runtime_app_operation",
  "skill",
  "skill_file",
  "runtime_app_skill_binding",
  "skill_import_event",
  "agent_skill",
  "agent_skill_requirement_config",
  "knowledge_page_assignment_policy",
  "agent_knowledge_page",
  "knowledge_proposal",
  "agent_router_session",
  "agent_router_provider_session",
  "agent_task_queue",
  "external_thread_binding",
  "agent_task_attempt",
  "agent_router_event",
  "agent_router_context_snapshot",
  "task_execution_event",
  "task_message",
  "openmontage_delegation_intent",
  "openmontage_job_link",
  "openmontage_model_delegation",
  "openmontage_job_event",
  "openmontage_job_projection",
  "openmontage_chat_binding",
  "openmontage_event_nonce",
  "openmontage_notification_outbox",
  "attachment",
  "openmontage_artifact_grant",
  "model_pricing",
  "token_usage",
  "token_usage_billing_event",
  "token_usage_retry",
  "token_usage_reconciliation_cursor",
  "runtime_credential_reconciliation_target",
  "runtime_maintenance_run",
  "budget",
  "audit_log",
  "workspace_sso_binding",
  "runtime_provisioning_task",
  "runtime_provisioning_task_event",
  "runtime_credential_recovery_task",
  "managed_runtime_cleanup_request",
  "capability_request",
  "mcp_catalog_item",
  "runtime_mcp_connection",
  "runtime_mcp_secret",
  "runtime_mcp_discovery_snapshot",
  "runtime_mcp_operation",
  "runtime_mcp_tool_audit",
  "mcp_task_session_grant",
  "mcp_task_audit_authorization",
  "content_blob",
  "skill_artifact",
  "skill_artifact_binding",
  "skill_artifact_file",
  "skill_installation",
  "skill_installation_operation",
  "skill_upgrade_approval",
  "skill_install_approval",
  "skill_installation_component",
  "skill_runner_invocation",
  "skill_rollout_plan",
  "skill_rollout_reconcile_item",
  "workspace_git_credential",
  "pager_alert_state",
  "skill_draft",
  "skill_service_catalog",
  "managed_skill_service",
  "skill_service_binding",
  "managed_skill_service_operation",
  "employee_persistent_workspace",
  "employee_workspace_revision",
  "employee_artifact",
  "employee_data_legal_hold",
  "task_commit_journal",
  "employee_recovery_operation",
] as const;

export type PostgresTableName = (typeof POSTGRES_TABLE_NAMES)[number];

import { workspaceWorkflowStatements } from "./postgres-schema/statements/01-workspace-workflow.ts";
import { identityIntegrationStatements } from "./postgres-schema/statements/02-identity-integrations.ts";
import { channelEmployeeStatements } from "./postgres-schema/statements/03-channels-employees.ts";
import { runtimeDocumentStatements } from "./postgres-schema/statements/04-runtime-documents.ts";
import { runtimeAppMcpStatements } from "./postgres-schema/statements/05-runtime-apps-mcp.ts";
import { skillKnowledgeOpenmontageStatements } from "./postgres-schema/statements/06-skills-knowledge-openmontage.ts";
import { agentRouterStatements } from "./postgres-schema/statements/07-agent-router.ts";
import { provisioningAuditStatements } from "./postgres-schema/statements/08-provisioning-audit.ts";
import { capabilityMigrationStatements } from "./postgres-schema/statements/09-capability-migrations.ts";
import { contentSkillServiceStatements } from "./postgres-schema/statements/10-content-skill-services.ts";
import { durabilityTailStatements } from "./postgres-schema/statements/11-durability-tail.ts";

/**
 * 全量 schema 语句（严格按迁移阶段顺序）。语句体按阶段切分在
 * ./postgres-schema/statements/01-11；本函数仅按原顺序拼接展开——
 * 元素顺序必须与切分前完全一致（FK/触发器依赖顺序，禁止重排）。
 */
export function getPostgresSchemaStatements(): string[] {
  return [
    ...workspaceWorkflowStatements,
    ...identityIntegrationStatements,
    ...channelEmployeeStatements,
    ...runtimeDocumentStatements,
    ...runtimeAppMcpStatements,
    ...skillKnowledgeOpenmontageStatements,
    ...agentRouterStatements,
    ...provisioningAuditStatements,
    ...capabilityMigrationStatements,
    ...contentSkillServiceStatements,
    ...durabilityTailStatements,
  ].map((statement) => statement.trim());
}

// history 回填 / 计数器自愈 / post-commit 在线索引：按关注点拆至同目录模块，
// 此处 re-export 保持 ./postgres-schema 对外导出面不变。
export {
  getPostgresHistoryBackfillStatements,
  POSTGRES_HISTORY_BACKFILL_BATCH_WORKSPACE_LIMIT,
  POSTGRES_HISTORY_BACKFILL_PENDING_WORKSPACES_QUERY,
  getPostgresHistoryBackfillStatementsForWorkspaces,
} from "./postgres-schema/history-backfill.ts";
export {
  POSTGRES_HISTORY_SEQUENCE_COUNTER_REPAIR_STATEMENT,
  POSTGRES_HISTORY_SEQUENCE_SET_NOT_NULL_STATEMENT,
  POSTGRES_HISTORY_SEQUENCE_ONLINE_NOT_NULL_STATEMENTS,
} from "./postgres-schema/sequence-repair.ts";
export {
  POSTGRES_WORKFLOW_RUN_HISTORY_INDEX_NAME,
  POSTGRES_WORKFLOW_RUN_HISTORY_SEQUENCE_INDEX_NAME,
  POSTGRES_POST_COMMIT_INDEX_NAMES,
  getPostgresPostCommitSchemaStatements,
} from "./postgres-schema/post-commit.ts";
