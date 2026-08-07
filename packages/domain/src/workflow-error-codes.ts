import { WORKFLOW_GRAPH_ERROR_CODES } from "./workflows.ts";

/**
 * Single source of truth for workflow error codes.
 *
 * Every code the workflow subsystem can emit — graph validation, governance,
 * dependency preflight, run/node lifecycle, approval, schedule/trigger, and the
 * run-timeline display labels — lives in {@link WORKFLOW_ERROR_CODES}. New
 * codes must be added here first; the action-layer whitelist and the i18n
 * translation table are both derived from this list so they can no longer
 * drift (a code added here without a translation becomes a compile error).
 */
export const WORKFLOW_ERROR_CODES = [
  ...WORKFLOW_GRAPH_ERROR_CODES,

  // Definition lifecycle & control
  "workflow_version_conflict",
  "workflow_version_not_found",
  "workflow_version_node_missing",
  "workflow_definition_not_found",
  "workflow_definition_archived",
  "workflow_definition_not_published",
  "workflow_definition_not_runnable",
  "workflow_definition_conflict",
  "workflow_definition_control_conflict",
  "workflow_draft_version_conflict",
  "workflow_manual_trigger_required",
  "workflow_active_version_missing",
  "workflow_graph_invalid",
  "workflow_operation_failed",
  "workflow_unknown_error",

  // Actor, employee readiness & governance preflight
  "workflow_actor_forbidden",
  "workflow_employee_not_ready",
  "workflow_skill_not_ready",
  "workflow_channel_not_ready",
  "workflow_channel_not_found",
  "workflow_budget_exceeded",
  "workflow_budget_invalid",
  "workflow_concurrency_invalid",
  "workflow_retry_policy_invalid",

  // Input / output contract
  "workflow_input_reference_missing",
  "workflow_input_reference_invalid",
  "workflow_input_reference_not_upstream",
  "workflow_join_reference_missing",
  "workflow_output_invalid",
  "workflow_output_too_large",
  "workflow_output_field_invalid",
  "workflow_output_field_unsupported",

  // Approval
  "workflow_approval_employee_not_ready",
  "workflow_approval_channel_not_ready",
  "workflow_approval_risk_invalid",
  "workflow_approval_reviewer_not_ready",
  "workflow_approval_already_created",
  "workflow_approval_deadline_invalid",
  "workflow_approval_create_failed",
  "workflow_approval_node_conflict",
  "workflow_approval_node_not_found",
  "workflow_approval_not_linked",
  "workflow_approval_rejected",
  "workflow_approval_deadline_exceeded",

  // Schedule, event & trigger
  "workflow_schedule_invalid",
  "workflow_schedule_in_past",
  "workflow_schedule_timezone_invalid",
  "workflow_misfire_policy_invalid",
  "workflow_event_invalid",
  "workflow_event_payload_too_large",
  "workflow_trigger_cross_workspace_conflict",
  "workflow_trigger_duplicate",
  "workflow_trigger_owner_conflict",
  "workflow_trigger_not_active",
  "workflow_trigger_stale_snapshot",
  "workflow_trigger_lease_conflict",
  "workflow_workspace_mismatch",
  "workflow_cross_workspace_reference",

  // Run & node lifecycle
  "workflow_run_not_found",
  "workflow_run_control_conflict",
  "workflow_run_commit_in_progress",
  "workflow_run_not_startable",
  "workflow_run_create_failed",
  "workflow_run_event_create_failed",
  "workflow_run_materialization_conflict",
  "workflow_task_commit_conflict",
  "workflow_task_queue_mismatch",
  "workflow_completion_effect_uncertain",
  "workflow_commit_abort_conflict",
  "workflow_commit_finalization_conflict",
  "workflow_commit_snapshot_missing",
  "workflow_completion_feishu_outbox_failed",
  "workflow_node_manual_compensation_required",
  "workflow_node_run_not_found",
  "workflow_node_not_retryable",
  "workflow_node_retry_exhausted",
  "workflow_node_retry_conflict",
  "workflow_node_queue_link_conflict",
  "workflow_node_queue_retry_conflict",

  // Outbox
  "workflow_outbox_lease_conflict",
  "workflow_outbox_payload_invalid",

  // Run-timeline display labels (not thrown by actions, but rendered in the UI)
  "workflow_run_events_unavailable",
  "workflow_event_sequence_gap",
  "workflow_node_execution_failed",
  "workflow_task_failed",
  "workflow_task_setup_failed",
  "workflow_runtime_offline",
] as const;

export type WorkflowErrorCode = typeof WORKFLOW_ERROR_CODES[number];

/** Membership check backed by {@link WORKFLOW_ERROR_CODES}. */
export const WORKFLOW_ERROR_CODE_SET: ReadonlySet<string> = new Set(WORKFLOW_ERROR_CODES);

/** Generic fallback shown when a code has no specific copy. */
export const WORKFLOW_ERROR_FALLBACK_ZH = "工作流操作未完成，请稍后重试。";

/**
 * Canonical Simplified-Chinese operational copy for every workflow error code.
 * Drives the server action layer; the web i18n layer keeps its own display
 * strings but shares the same code key set via {@link WORKFLOW_ERROR_CODES}.
 */
export const WORKFLOW_ERROR_MESSAGE_ZH: Record<WorkflowErrorCode, string> = {
  // Graph validation
  workflow_graph_duplicate_node_id: "步骤 ID 不能重复。",
  workflow_graph_edge_endpoint_missing: "连接线引用了不存在的步骤。",
  workflow_node_type_unsupported: "该步骤类型不在首期支持范围内。",
  workflow_employee_task_requires_employee_id: "请选择执行此步骤的 AI 员工。",
  workflow_join_requires_multiple_inputs: "汇聚步骤至少需要两个并行输入。",
  workflow_join_requires_downstream: "汇聚步骤后需要添加汇总员工。",
  workflow_graph_requires_employee_task: "至少添加一个 AI 员工步骤。",
  workflow_graph_requires_single_entry_node: "流程只能有一个起点。",
  workflow_graph_requires_single_terminal_node: "流程只能有一个终点。",
  workflow_graph_isolated_node: "存在未连接到主流程的步骤。",
  workflow_node_unreachable: "存在无法从起点到达的步骤。",
  workflow_graph_cycle: "流程中不能存在循环连接。",

  // Definition lifecycle & control
  workflow_version_conflict: "草稿已被其他编辑者更新，请刷新后重试。",
  workflow_version_not_found: "未找到对应的工作流版本。",
  workflow_version_node_missing: "版本缺少引用的步骤定义。",
  workflow_definition_not_found: "未找到工作流。",
  workflow_definition_archived: "已归档的工作流不能编辑。",
  workflow_definition_not_published: "请先发布工作流。",
  workflow_definition_not_runnable: "工作流已暂停或归档，无法发起新的运行。",
  workflow_definition_conflict: "工作流状态冲突，请刷新后重试。",
  workflow_definition_control_conflict: "工作流状态已变化，请刷新后重试。",
  workflow_draft_version_conflict: "草稿已被其他编辑者更新，请刷新后重试。",
  workflow_manual_trigger_required: "只有已发布的手动触发工作流可以立即运行。",
  workflow_active_version_missing: "工作流缺少可运行的发布版本。",
  workflow_graph_invalid: "流程结构无效，请检查步骤连接。",
  workflow_operation_failed: "工作流操作失败，请稍后重试。",
  workflow_unknown_error: "工作流发生未知错误，请稍后重试。",

  // Actor, employee readiness & governance preflight
  workflow_actor_forbidden: "当前成员没有执行此操作的权限。",
  workflow_employee_not_ready: "工作流中的 AI 员工尚未就绪。",
  workflow_skill_not_ready: "AI 员工尚未配置此步骤所需技能。",
  workflow_channel_not_ready: "AI 员工尚未加入此步骤的协作频道。",
  workflow_channel_not_found: "所选频道不存在或不在当前工作空间内。",
  workflow_budget_exceeded: "工作流预算不足，请调整预算或流程。",
  workflow_budget_invalid: "预算必须是大于零的有效金额。",
  workflow_concurrency_invalid: "最大并发数必须是 1 到 20 之间的整数。",
  workflow_retry_policy_invalid: "最大尝试次数必须是 1 到 10 之间的整数。",

  // Input / output contract
  workflow_input_reference_missing: "步骤缺少必需的上游输入。",
  workflow_input_reference_invalid: "输入映射包含无效引用。",
  workflow_input_reference_not_upstream: "输入映射只能引用当前步骤的上游输出。",
  workflow_join_reference_missing: "使用汇聚输出前需要连接汇聚步骤。",
  workflow_output_invalid: "AI 员工未返回步骤声明的输出字段，请检查输出字段或任务说明。",
  workflow_output_too_large: "步骤输出超过 256 KiB，请缩小摘要或改用产物引用。",
  workflow_output_field_invalid: "输出字段名称无效、重复或数量超限。",
  workflow_output_field_unsupported: "输入映射引用了上游未声明的输出字段。",

  // Approval
  workflow_approval_employee_not_ready: "请选择提交审批的 AI 员工。",
  workflow_approval_channel_not_ready: "提交审批的 AI 员工尚未加入审批频道。",
  workflow_approval_risk_invalid: "审批风险等级无效，请重新选择。",
  workflow_approval_reviewer_not_ready: "指定的审批人不在当前工作空间内。",
  workflow_approval_already_created: "该步骤的审批请求已经存在。",
  workflow_approval_deadline_invalid: "审批限时必须为 1 秒至 30 天之间的正整数。",
  workflow_approval_create_failed: "审批请求创建失败，请稍后重试。",
  workflow_approval_node_conflict: "审批步骤状态冲突，请刷新后重试。",
  workflow_approval_node_not_found: "未找到对应的审批步骤。",
  workflow_approval_not_linked: "审批请求未关联到运行步骤。",
  workflow_approval_rejected: "审批已被驳回。",
  workflow_approval_deadline_exceeded: "审批限时已到，未在规定时间内完成审批。",

  // Schedule, event & trigger
  workflow_schedule_invalid: "定时配置无效，请检查时间或 Cron 表达式。",
  workflow_schedule_in_past: "一次性执行时间必须晚于当前时间。",
  workflow_schedule_timezone_invalid: "时区无效，请填写标准 IANA 时区。",
  workflow_misfire_policy_invalid: "错过执行策略无效，请重新选择。",
  workflow_event_invalid: "事件名称无效，请检查后重试。",
  workflow_event_payload_too_large: "事件载荷过大，请减小后重试。",
  workflow_trigger_cross_workspace_conflict: "触发器不能引用其他工作空间。",
  workflow_trigger_duplicate: "相同触发器已经绑定到其他工作流。",
  workflow_trigger_owner_conflict: "当前切流阶段不允许从此入口修改触发器。",
  workflow_trigger_not_active: "触发器未激活。",
  workflow_trigger_stale_snapshot: "触发器快照已过期，请刷新后重试。",
  workflow_trigger_lease_conflict: "触发器已被其他进程领取。",
  workflow_workspace_mismatch: "工作流引用的资源归属不一致，请刷新后重试。",
  workflow_cross_workspace_reference: "工作流不能引用其他工作空间的资源。",

  // Run & node lifecycle
  workflow_run_not_found: "未找到运行记录。",
  workflow_run_control_conflict: "运行状态已变化，请刷新后重试。",
  workflow_run_commit_in_progress: "步骤结果正在提交，请稍后再取消运行。",
  workflow_run_not_startable: "运行已暂停或结束，当前步骤不能开始执行。",
  workflow_run_create_failed: "运行创建失败，请稍后重试。",
  workflow_run_event_create_failed: "运行事件创建失败，请稍后重试。",
  workflow_run_materialization_conflict: "运行物化状态冲突，请刷新后重试。",
  workflow_task_commit_conflict: "步骤提交状态已变化，请刷新后重试。",
  workflow_task_queue_mismatch: "任务队列不匹配，请刷新后重试。",
  workflow_completion_effect_uncertain: "外部操作状态不确定，请先检查并补偿。",
  workflow_commit_abort_conflict: "步骤提交中止失败，状态已变化，请刷新后重试。",
  workflow_commit_finalization_conflict: "步骤提交终结失败，状态已变化，请刷新后重试。",
  workflow_commit_snapshot_missing: "缺少完成提交快照，请重试任务完成流程。",
  workflow_completion_feishu_outbox_failed: "飞书通知投递失败，请稍后重试。",
  workflow_node_manual_compensation_required: "请先检查并补偿外部操作，再处理此步骤。",
  workflow_node_run_not_found: "未找到步骤运行记录。",
  workflow_node_not_retryable: "当前步骤不能重试。",
  workflow_node_retry_exhausted: "该步骤已达到最大重试次数。",
  workflow_node_retry_conflict: "步骤状态已变化，请刷新后重试。",
  workflow_node_queue_link_conflict: "步骤队列关联冲突，请刷新后重试。",
  workflow_node_queue_retry_conflict: "步骤队列重试冲突，请刷新后重试。",

  // Outbox
  workflow_outbox_lease_conflict: "出库事件已被其他进程领取。",
  workflow_outbox_payload_invalid: "出库事件载荷无效。",

  // Run-timeline display labels
  workflow_run_events_unavailable: "运行状态同步失败，将自动重试。",
  workflow_event_sequence_gap: "正在同步缺失事件。",
  workflow_node_execution_failed: "步骤执行失败。",
  workflow_task_failed: "步骤执行失败。",
  workflow_task_setup_failed: "AI 员工执行环境准备失败。",
  workflow_runtime_offline: "AI 员工运行时离线，任务已由恢复流程收敛。",
};

/** Resolve the Simplified-Chinese operational copy for a code, with a safe fallback. */
export function workflowErrorMessageZh(code: string): string {
  return WORKFLOW_ERROR_MESSAGE_ZH[code as WorkflowErrorCode] ?? WORKFLOW_ERROR_FALLBACK_ZH;
}
