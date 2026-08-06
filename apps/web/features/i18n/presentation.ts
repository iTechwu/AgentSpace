import { formatCompactTimestamp } from "@/shared/lib/time-format";
import type { LedgerItem, WorkspaceMessage } from "@/shared/types/workspace";

export type TxFn = (zh: string, en: string) => string;

const zhTx: TxFn = (zh) => zh;

export function translateWorkflowRunStatus(value: string | undefined, tx: TxFn = zhTx): string {
  const labels: Record<string, [string, string]> = {
    created: ["已创建", "Created"],
    queued: ["排队中", "Queued"],
    running: ["运行中", "Running"],
    waiting_approval: ["等待审批", "Waiting approval"],
    paused: ["已暂停", "Paused"],
    succeeded: ["已完成", "Succeeded"],
    partially_succeeded: ["部分完成", "Partially succeeded"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
  };
  const label = value ? labels[value] : undefined;
  return label ? tx(label[0], label[1]) : tx("状态未知", "Unknown status");
}

export function translateWorkflowNodeStatus(value: string | undefined, tx: TxFn = zhTx): string {
  const labels: Record<string, [string, string]> = {
    pending: ["等待", "Pending"],
    ready: ["就绪", "Ready"],
    queued: ["排队", "Queued"],
    running: ["执行中", "Running"],
    waiting_approval: ["待审批", "Waiting approval"],
    retry_wait: ["待重试", "Waiting to retry"],
    succeeded: ["成功", "Succeeded"],
    failed: ["失败", "Failed"],
    skipped: ["已跳过", "Skipped"],
    cancelled: ["已取消", "Cancelled"],
  };
  const label = value ? labels[value] : undefined;
  return label ? tx(label[0], label[1]) : tx("未知", "Unknown");
}

export function translateWorkflowTriggerType(value: string | undefined, tx: TxFn = zhTx): string {
  if (value === "schedule") return tx("定时触发", "Scheduled trigger");
  if (value === "event") return tx("事件触发", "Event trigger");
  if (value === "manual") return tx("手动触发", "Manual trigger");
  return tx("未知触发方式", "Unknown trigger");
}

export function translateWorkflowErrorCode(code: string | undefined, tx: TxFn = zhTx): string {
  const labels: Record<string, [string, string]> = {
    workflow_actor_forbidden: ["当前成员没有执行此操作的权限", "You do not have permission to perform this operation"],
    workflow_version_conflict: ["草稿已被其他编辑者更新，请刷新后重试", "The draft was updated elsewhere. Refresh and try again"],
    workflow_definition_not_found: ["未找到工作流", "Workflow not found"],
    workflow_definition_archived: ["已归档的工作流不能编辑", "Archived workflows cannot be edited"],
    workflow_definition_not_published: ["请先发布工作流", "Publish the workflow first"],
    workflow_active_version_missing: ["工作流缺少可运行的发布版本", "The workflow has no runnable published version"],
    workflow_graph_invalid: ["流程结构无效，请检查步骤连接", "The workflow structure is invalid. Check its connections"],
    workflow_graph_requires_employee_task: ["至少添加一个 AI 员工步骤", "Add at least one AI employee step"],
    workflow_graph_cycle: ["流程中不能存在循环连接", "Workflow connections cannot contain a cycle"],
    workflow_graph_multiple_entry_nodes: ["流程只能有一个起点", "The workflow must have one entry step"],
    workflow_graph_multiple_terminal_nodes: ["流程只能有一个终点", "The workflow must have one terminal step"],
    workflow_graph_disconnected: ["所有步骤必须连接到主流程", "Every step must connect to the main workflow"],
    workflow_employee_task_requires_employee_id: ["请选择执行此步骤的 AI 员工", "Select an AI employee for this step"],
    workflow_employee_not_ready: ["AI 员工运行环境尚未就绪", "The AI employee runtime is not ready"],
    workflow_skill_not_ready: ["AI 员工尚未配置此步骤所需技能", "The AI employee does not have a skill required by this step"],
    workflow_channel_not_ready: ["AI 员工尚未加入此步骤的协作频道", "The AI employee is not a member of this step's collaboration channel"],
    workflow_approval_employee_not_ready: ["请选择提交审批的 AI 员工", "Select the AI employee submitting this approval"],
    workflow_approval_channel_not_ready: ["提交审批的 AI 员工尚未加入审批频道", "The submitting AI employee is not a member of the approval channel"],
    workflow_schedule_invalid: ["定时配置无效，请检查时间或 Cron 表达式", "The schedule is invalid. Check the time or cron expression"],
    workflow_schedule_in_past: ["一次性执行时间必须晚于当前时间", "The one-time schedule must be in the future"],
    workflow_schedule_timezone_invalid: ["时区无效，请填写标准 IANA 时区", "Enter a valid IANA timezone"],
    workflow_join_requires_multiple_inputs: ["汇聚步骤至少需要两个并行输入", "A join requires at least two parallel inputs"],
    workflow_join_requires_downstream: ["汇聚步骤后需要添加汇总员工", "Add a summarizing employee after the join"],
    workflow_trigger_duplicate: ["相同触发器已经绑定到其他工作流", "An identical trigger is already assigned to another workflow"],
    workflow_trigger_owner_conflict: ["当前切流阶段不允许从此入口修改触发器", "This cutover stage does not allow trigger changes from this entry point"],
    workflow_trigger_cross_workspace_conflict: ["触发器不能引用其他工作空间", "The trigger cannot reference another workspace"],
    workflow_cross_workspace_reference: ["工作流不能引用其他工作空间的资源", "The workflow cannot reference resources from another workspace"],
    workflow_budget_exceeded: ["工作流预算不足，请调整预算或流程", "The workflow budget is insufficient. Adjust the budget or workflow"],
    workflow_budget_invalid: ["预算必须是大于零的有效金额", "The budget must be a valid amount greater than zero"],
    workflow_input_reference_missing: ["步骤缺少必需的上游输入", "A step is missing required upstream input"],
    workflow_run_not_found: ["未找到运行记录", "Workflow run not found"],
    workflow_run_control_conflict: ["运行状态已变化，请刷新后重试", "The run state changed. Refresh and try again"],
    workflow_run_events_unavailable: ["运行状态同步失败，将自动重试", "Run synchronization failed and will retry automatically"],
    workflow_event_sequence_gap: ["正在同步缺失事件", "Synchronizing missing events"],
    workflow_node_run_not_found: ["未找到步骤运行记录", "Workflow step run not found"],
    workflow_node_not_retryable: ["当前步骤不能重试", "This step cannot be retried"],
    workflow_node_retry_conflict: ["步骤状态已变化，请刷新后重试", "The step state changed. Refresh and try again"],
    workflow_node_retry_exhausted: ["该步骤已达到最大重试次数", "This step reached its retry limit"],
    workflow_node_execution_failed: ["步骤执行失败", "Step execution failed"],
  };
  const label = code ? labels[code] : undefined;
  return label ? tx(label[0], label[1]) : tx("工作流操作未完成，请稍后重试", "The workflow operation did not complete. Try again later");
}

export function translateTaskStatus(value: string | undefined, tx: TxFn): string {
  if (value === "todo" || value === "待开始") return tx("待开始", "Todo");
  if (value === "in_progress" || value === "进行中") return tx("进行中", "In progress");
  if (value === "blocked" || value === "已阻塞") return tx("已阻塞", "Blocked");
  if (value === "done" || value === "已完成") return tx("已完成", "Done");
  return value ?? "";
}

export function translateQueueStatus(value: string | undefined, tx: TxFn): string {
  if (value === "not_queued" || value === "未入队") return tx("未入队", "Not queued");
  if (value === "queued" || value === "已入队") return tx("已入队", "Queued");
  if (value === "claimed" || value === "已认领") return tx("已认领", "Claimed");
  if (value === "running" || value === "执行中") return tx("执行中", "Running");
  if (value === "completed" || value === "已完成") return tx("已完成", "Completed");
  if (value === "failed" || value === "执行失败") return tx("执行失败", "Failed");
  if (value === "cancelled" || value === "已取消") return tx("已取消", "Cancelled");
  return value ?? "";
}

export function translatePriority(value: string | undefined, tx: TxFn): string {
  if (value === "high" || value === "高优先级") return tx("高优先级", "High");
  if (value === "medium" || value === "中优先级") return tx("中优先级", "Medium");
  if (value === "low" || value === "低优先级") return tx("低优先级", "Low");
  return value ?? "";
}

export function translateAgentStatus(value: string | undefined, tx: TxFn): string {
  if (value === "busy" || value === "处理中") return tx("处理中", "Working");
  if (value === "blocked" || value === "阻塞") return tx("阻塞", "Blocked");
  if (value === "linked" || value === "已连接") return tx("已连接", "Connected");
  if (value === "error" || value === "异常") return tx("异常", "Error");
  if (value === "online" || value === "在线") return tx("在线", "Online");
  return value ?? "";
}

export function translateKnowledgeAssignmentMode(value: string | undefined, tx: TxFn): string {
  if (value === "all_agents") return tx("全员共享", "All AI employees");
  if (value === "selected_agents") return tx("指定 AI员工", "Selected AI employees");
  return value ?? "";
}

export function translateContainerDescription(value: string | undefined, tx: TxFn): string {
  if (value === "容器已在线，可承载多个 AI员工 的独立工作区域。") {
    return tx("容器已在线，可承载多个 AI员工 的独立工作区域。", "The container is online and can host independent work areas for multiple AI employees.");
  }
  if (value === "容器当前离线。") {
    return tx("容器当前离线。", "The container is currently offline.");
  }
  return value ?? "";
}

function formatNoticeDateTime(value: string | undefined): string {
  return formatCompactTimestamp(value, { emptyFallback: "" });
}

export function translateSystemSpeaker(value: string | undefined, tx: TxFn): string {
  if (!value) return "";
  if (
    value === "系统提示" ||
    value === "Atlas · 运行时协调器" ||
    value === "Atlas · 任务分派器" ||
    value === "Atlas · 文档协调器"
  ) {
    return tx("系统提示", "System Notice");
  }
  if (value === "系统通知") return tx("系统通知", "System");
  return value;
}

export function translateMemberLabel(value: string | undefined, tx: TxFn): string {
  if (!value) return "";
  const match = value.match(/^(\d+)\s+人类\s+\/\s+(\d+)\s+(?:agent|AI员工)$/);
  if (!match) {
    return value;
  }
  return tx(`${match[1]} 人类 / ${match[2]} AI员工`, `${match[1]} humans / ${match[2]} AI employees`);
}

export function translateWorkspaceMessageSummary(
  message:
    | Pick<WorkspaceMessage, "summary" | "code" | "data">
    | {
        content: string;
        code?: string;
        data?: Record<string, string>;
      },
  tx: TxFn,
): string {
  const code = message.code;
  const data = message.data ?? {};
  if (!code) {
    return "summary" in message ? message.summary : message.content;
  }

  switch (code) {
    case "runtime.bound":
      return tx(`${data.employee_name ?? "AI员工"} 已绑定到执行引擎：${data.runtime_name ?? "执行引擎"}。`, `${data.employee_name ?? "AI employee"} is now bound to execution engine ${data.runtime_name ?? "execution engine"}.`);
    case "runtime.unbound":
      return tx(`${data.employee_name ?? "AI员工"} 已解除执行引擎绑定。`, `${data.employee_name ?? "AI employee"} was unbound from the execution engine.`);
    case "agent.deleted":
      return tx(`${data.employee_name ?? "AI员工"} 已删除，相关执行引擎绑定与工作区域已清理。`, `${data.employee_name ?? "AI employee"} was deleted together with its execution-engine binding and work area records.`);
    case "channel.created_notice":
      return tx(`新群组 ${data.channel_name ?? "group"} 已创建，可立即接入数字员工与协作流。`, `Group ${data.channel_name ?? "group"} was created and is ready for collaboration.`);
    case "channel.renamed_notice":
      return tx(`群组 ${data.previous_name ?? "group"} 已重命名为 ${data.next_name ?? "group"}。`, `Group ${data.previous_name ?? "group"} was renamed to ${data.next_name ?? "group"}.`);
    case "mention.unavailable":
      return tx(`${data.agent_names ?? "AI员工"} 当前没有绑定可执行引擎，无法响应这次 @。`, `${data.agent_names ?? "AI employee"} does not have an executable execution engine bound and cannot respond to this mention.`);
    case "task.assigned_notice":
      return tx(`新任务已分派给 ${data.assignee ?? "AI员工"}：${data.task_title ?? "task"}。`, `A new task was assigned to ${data.assignee ?? "AI employee"}: ${data.task_title ?? "task"}.`);
    case "task.queued_notice":
      return tx(`任务 ${data.task_title ?? "task"} 已进入执行队列，目标执行引擎：${data.runtime_name ?? "执行引擎"}。`, `Task ${data.task_title ?? "task"} entered the execution queue for engine ${data.runtime_name ?? "execution engine"}.`);
    case "task.status_notice":
      return tx(`任务 ${data.task_title ?? "task"} 当前状态已更新为 ${translateTaskStatus(data.status, tx)}。`, `Task ${data.task_title ?? "task"} status was updated to ${translateTaskStatus(data.status, tx)}.`);
    case "channel_document.created_notice":
      return tx(`群文档《${data.document_title ?? "文档"}》已创建。`, `Channel document "${data.document_title ?? "Document"}" was created.`);
    case "channel_document.updated_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》已更新。${data.summary ? ` 摘要：${data.summary}` : ""}`,
        `Channel document "${data.document_title ?? "Document"}" was updated.${data.summary ? ` Summary: ${data.summary}` : ""}`,
      );
    case "channel_document.archived_notice":
      return tx(`群文档《${data.document_title ?? "文档"}》已归档。`, `Channel document "${data.document_title ?? "Document"}" was archived.`);
    case "channel_document.restored_notice":
      return tx(`群文档《${data.document_title ?? "文档"}》已恢复。`, `Channel document "${data.document_title ?? "Document"}" was restored.`);
    case "channel_document.rolled_back_notice":
      return tx(`群文档《${data.document_title ?? "文档"}》已回滚。`, `Channel document "${data.document_title ?? "Document"}" was rolled back.`);
    case "channel_document.exported_notice":
      return tx(`群文档《${data.document_title ?? "文档"}》已导出为附件。`, `Channel document "${data.document_title ?? "Document"}" was exported as an attachment.`);
    case "channel_document.run_created_notice":
      return tx(
        `已创建一条群文档协作流程，共 ${data.step_count ?? "0"} 步。`,
        `A document workflow with ${data.step_count ?? "0"} step(s) was created.`,
      );
    case "channel_document.step_completed_notice":
      return tx(
        `${data.agent_label ?? "AI员工"} 已完成当前文档步骤。`,
        `${data.agent_label ?? "AI employee"} completed the current document step.`,
      );
    case "channel_document.step_completed_without_update_notice":
      return tx(
        `${data.agent_label ?? "AI员工"} 已结束当前步骤，但没有写入新的群文档版本。`,
        `${data.agent_label ?? "AI employee"} finished the step without writing a new document version.`,
      );
    case "channel_document.step_queued_notice":
      return tx(
        `流程已推进到 ${data.agent_label ?? "AI员工"}。`,
        `The workflow moved to ${data.agent_label ?? "AI employee"}.`,
      );
    case "channel_document.run_completed_notice":
      return tx("群文档协作流程已完成。", "The document workflow has completed.");
    case "channel_document.run_completed_with_warning_notice":
      return tx(
        "群文档协作流程已结束，但至少有一步没有写入新的文档版本。",
        "The document workflow finished, but at least one step did not write a new document version.",
      );
    case "channel_document.run_failed_notice":
      return tx(
        `群文档协作流程在 ${data.agent_label ?? "AI员工"} 处失败。`,
        `The document workflow failed at ${data.agent_label ?? "AI employee"}.`,
      );
    case "channel_document.plan_ambiguous_notice":
      return tx(
        "系统无法判断安全的协作顺序，请明确写出先后关系，例如“@A ... 然后 @B ...”。",
        'The system could not infer a safe collaboration order. Please rewrite it with explicit sequencing, for example "@A ... then @B ...".',
      );
    case "channel_document.conflict_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》的更新发生冲突，请基于最新版本重试。`,
        `Document "${data.document_title ?? "Document"}" has an update conflict. Please retry on top of the latest version.`,
      );
    case "channel_document.conflict_resolved_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》的冲突已标记为已处理。`,
        `Document "${data.document_title ?? "Document"}" conflict was marked as resolved.`,
      );
    case "channel_document.conflict_retried_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》的冲突改动已基于最新版本重新应用。`,
        `Document "${data.document_title ?? "Document"}" conflicted change was reapplied on top of the latest version.`,
      );
    case "channel_document.collaborator_added_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》已新增协作者 ${data.collaborator_name ?? "User"}，角色为 ${data.role ?? "editor"}。`,
        `Document "${data.document_title ?? "Document"}" added collaborator ${data.collaborator_name ?? "User"} as ${data.role ?? "editor"}.`,
      );
    case "channel_document.collaborator_removed_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》已移除协作者 ${data.collaborator_name ?? "User"}。`,
        `Document "${data.document_title ?? "Document"}" removed collaborator ${data.collaborator_name ?? "User"}.`,
      );
    case "channel_document.access_updated_notice":
      return tx(
        `群文档《${data.document_title ?? "文档"}》协作者 ${data.collaborator_name ?? "User"} 的角色已从 ${data.previous_role ?? "viewer"} 调整为 ${data.next_role ?? "editor"}。`,
        `Document "${data.document_title ?? "Document"}" changed collaborator ${data.collaborator_name ?? "User"} role from ${data.previous_role ?? "viewer"} to ${data.next_role ?? "editor"}.`,
      );
    case "auto_continuation.started_notice":
      return tx(
        `已开启自动续跑：${data.agent_name ?? "AI员工"} 将持续工作到 ${formatNoticeDateTime(data.until)}。`,
        `Auto continuation started: ${data.agent_name ?? "AI employee"} will keep working until ${formatNoticeDateTime(data.until)}.`,
      );
    case "auto_continuation.stopped_notice":
      return tx(
        `已停止自动续跑：${data.agent_name ?? "AI员工"} 不会再自动排队下一轮任务。`,
        `Auto continuation stopped: ${data.agent_name ?? "AI employee"} will not queue another follow-up task.`,
      );
    case "contact.unavailable":
      return tx(`${data.contact_name ?? "Contact"} 当前没有绑定可执行容器，无法处理这条私聊消息。`, `${data.contact_name ?? "Contact"} does not have an executable container bound and cannot process this direct message.`);
    case "approval.created":
      if (data.approval_type === "runtime_tool") {
        const toolName = data.tool_name ?? tx("工具", "tool");
        const preview = data.content_preview ? `：${data.content_preview}` : "";
        if (data.approval_status === "approved") {
          return tx(`${data.agent_id ?? "AI员工"} 的 ${toolName} 调用已批准${preview}`, `${data.agent_id ?? "AI employee"}'s ${toolName} call was approved${preview}`);
        }
        if (data.approval_status === "rejected") {
          return tx(`${data.agent_id ?? "AI员工"} 的 ${toolName} 调用已驳回${preview}`, `${data.agent_id ?? "AI employee"}'s ${toolName} call was rejected${preview}`);
        }
        return tx(`${data.agent_id ?? "AI员工"} 请求审批 ${toolName} 调用${preview}`, `${data.agent_id ?? "AI employee"} requested approval for a ${toolName} call${preview}`);
      }
      return tx(`${data.agent_id ?? "AI员工"} 提交了一条审批。`, `${data.agent_id ?? "AI employee"} submitted an approval.`);
    case "approval.approved":
      return tx(`${data.agent_id ?? "AI员工"} 的审批已批准。`, `${data.agent_id ?? "AI employee"}'s approval was approved.`);
    case "approval.rejected":
      return tx(`${data.agent_id ?? "AI员工"} 的审批已驳回。`, `${data.agent_id ?? "AI employee"}'s approval was rejected.`);
    case "agent.pending":
      return tx("思考中", "Thinking");
    default:
      return "summary" in message ? message.summary : message.content;
  }
}

export function translateLedgerTitle(entry: LedgerItem, tx: TxFn): string {
  switch (entry.code) {
    case "runtime.bound":
      return tx("Runtime 绑定", "Runtime bound");
    case "runtime.unbound":
      return tx("Runtime 解绑", "Runtime unbound");
    case "agent.deleted":
      return tx("AI员工 删除", "AI employee deleted");
    case "agent.instructions_updated":
      return tx("AI员工 指令更新", "AI employee instructions updated");
    case "skill.created":
      return tx("Skill 创建", "Skill created");
    case "skill.updated":
      return tx("Skill 更新", "Skill updated");
    case "skill.deleted":
      return tx("Skill 删除", "Skill deleted");
    case "skill.file_updated":
      return tx("Skill 文件更新", "Skill file updated");
    case "skill.file_created":
      return tx("Skill 文件创建", "Skill file created");
    case "skill.file_deleted":
      return tx("Skill 文件删除", "Skill file deleted");
    case "agent.skills_updated":
      return tx("AI员工 Skills 绑定更新", "AI employee skill assignments updated");
    case "knowledge.assignment_mode_updated":
      return tx("知识分配范围更新", "Knowledge assignment scope updated");
    case "knowledge.page_agents_updated":
      return tx("知识页 AI员工 绑定更新", "Knowledge page AI employee assignments updated");
    case "agent.knowledge_updated":
      return tx("AI员工 知识绑定更新", "AI employee knowledge assignments updated");
    case "contact.queued":
      return tx("联系人私聊入队", "Direct message queued");
    case "channel.created":
      return tx("群组创建", "Group created");
    case "channel.deleted":
      return tx("群组删除", "Group deleted");
    case "channel.renamed":
      return tx("群组重命名", "Group renamed");
    case "material.added":
      return tx("原料补充", "Material added");
    case "material.imported":
      return tx("文件导入", "File imported");
    case "material.parsed":
      return tx("原料解析", "Material parsed");
    case "channel.message":
      return tx("群组消息", "Group message");
    case "channel.mention_dispatched":
    case "channel.mention_unavailable":
      return tx("群组 mention", "Group mention");
    case "employee.created":
      return tx("员工直加入组", "Employee created");
    case "task.created":
      return tx("任务创建", "Task created");
    case "task.queued":
      return tx("任务入队", "Task queued");
    case "task.status_updated":
      return tx("任务状态更新", "Task status updated");
    case "channel_document.created":
      return tx("群文档创建", "Channel document created");
    case "channel_document.updated":
      return tx("群文档更新", "Channel document updated");
    case "channel_document.archived":
      return tx("群文档归档", "Channel document archived");
    case "channel_document.restored":
      return tx("群文档恢复", "Channel document restored");
    case "channel_document.rolled_back":
      return tx("群文档回滚", "Channel document rolled back");
    case "channel_document.exported":
      return tx("群文档导出", "Channel document exported");
    case "channel_document.run_created":
      return tx("群文档流程创建", "Channel document workflow created");
    case "channel_document.step_completed":
      return tx("群文档步骤完成", "Channel document step completed");
    case "channel_document.run_failed":
      return tx("群文档流程失败", "Channel document workflow failed");
    case "channel_document.run_ambiguous":
      return tx("群文档流程顺序不明确", "Channel document workflow order is ambiguous");
    case "channel_document.conflict":
      return tx("群文档冲突", "Channel document conflict");
    case "channel_document.conflict_resolved":
      return tx("群文档冲突已处理", "Channel document conflict resolved");
    case "channel_document.conflict_retried":
      return tx("群文档冲突重试", "Channel document conflict retried");
    case "channel_document.collaborator_added":
      return tx("群文档新增协作者", "Channel document collaborator added");
    case "channel_document.collaborator_removed":
      return tx("群文档移除协作者", "Channel document collaborator removed");
    case "channel_document.access_updated":
      return tx("群文档权限更新", "Channel document access updated");
    default:
      return entry.title;
  }
}

export function translateLedgerBody(entry: LedgerItem, tx: TxFn): string {
  const data = entry.data ?? {};
  switch (entry.code) {
    case "runtime.bound":
      return tx(`${data.employee_name ?? "AI员工"} 已绑定到 ${data.runtime_name ?? "执行引擎"}。`, `${data.employee_name ?? "AI employee"} is now bound to ${data.runtime_name ?? "execution engine"}.`);
    case "runtime.unbound":
      return tx(`${data.employee_name ?? "AI员工"} 已解绑执行引擎。`, `${data.employee_name ?? "AI employee"} was unbound from the execution engine.`);
    case "agent.deleted":
      return tx(`${data.employee_name ?? "AI员工"} 已从组织中移除，并清理绑定、任务和工作区域。`, `${data.employee_name ?? "AI employee"} was removed from the workspace along with bindings, tasks, and work areas.`);
    case "agent.instructions_updated":
      return tx(`${data.employee_name ?? "AI员工"} 的 instructions 已更新。`, `${data.employee_name ?? "AI employee"} instructions were updated.`);
    case "skill.created":
      return tx(`${data.skill_name ?? "Skill"} 已加入工作区技能库。`, `${data.skill_name ?? "Skill"} was added to the workspace library.`);
    case "skill.updated":
      return tx(`${data.skill_name ?? "Skill"} 的元信息已更新。`, `${data.skill_name ?? "Skill"} metadata was updated.`);
    case "skill.deleted":
      return tx(`${data.skill_name ?? "Skill"} 已从工作区技能库移除，并解除所有 AI员工 绑定。`, `${data.skill_name ?? "Skill"} was removed from the workspace library and all AI employee assignments were cleared.`);
    case "skill.file_updated":
      return tx(`${data.skill_name ?? "Skill"} 的 ${data.file_path ?? "file"} 已更新。`, `${data.skill_name ?? "Skill"} file ${data.file_path ?? "file"} was updated.`);
    case "skill.file_created":
      return tx(`${data.skill_name ?? "Skill"} 新增文件 ${data.file_path ?? "file"}。`, `${data.skill_name ?? "Skill"} added file ${data.file_path ?? "file"}.`);
    case "skill.file_deleted":
      return tx(`${data.skill_name ?? "Skill"} 的 ${data.file_path ?? "file"} 已删除。`, `${data.skill_name ?? "Skill"} file ${data.file_path ?? "file"} was deleted.`);
    case "agent.skills_updated":
      return tx(`${data.employee_name ?? "AI员工"} 的 skills 绑定已更新，共 ${data.skill_count ?? "0"} 项。`, `${data.employee_name ?? "AI employee"} skill assignments were updated with ${data.skill_count ?? "0"} item(s).`);
    case "knowledge.assignment_mode_updated":
      return tx(
        `知识页 ${data.knowledge_page_id ?? "page"} 的分配范围已更新为 ${translateKnowledgeAssignmentMode(data.assignment_mode, tx)}。`,
        `Knowledge page ${data.knowledge_page_id ?? "page"} assignment scope changed to ${translateKnowledgeAssignmentMode(data.assignment_mode, tx)}.`,
      );
    case "knowledge.page_agents_updated":
      return tx(
        `知识页 ${data.knowledge_page_id ?? "page"} 已绑定 ${data.agent_count ?? "0"} 个 AI员工。`,
        `Knowledge page ${data.knowledge_page_id ?? "page"} was assigned to ${data.agent_count ?? "0"} AI employee(s).`,
      );
    case "agent.knowledge_updated":
      return tx(
        `${data.employee_name ?? "AI员工"} 的知识绑定已更新，共 ${data.knowledge_page_count ?? "0"} 篇。`,
        `${data.employee_name ?? "AI employee"} knowledge assignments were updated with ${data.knowledge_page_count ?? "0"} page(s).`,
      );
    case "contact.queued":
      return tx(`你向 ${data.contact_name ?? "contact"} 发起了一条私聊，已转交 AI员工 执行。`, `You sent a direct message to ${data.contact_name ?? "contact"}, and it was queued for an AI employee.`);
    case "channel.created":
      return tx(`已创建群组 ${data.channel_name ?? "group"}，成员 ${data.human_count ?? "0"} 名人类 / ${data.agent_count ?? "0"} 名 AI员工。`, `Group ${data.channel_name ?? "group"} was created with ${data.human_count ?? "0"} human member(s) and ${data.agent_count ?? "0"} AI employee(s).`);
    case "channel.deleted":
      return tx(`群组 ${data.channel_name ?? "group"} 已删除，并清理相关消息、任务和成员绑定。`, `Group ${data.channel_name ?? "group"} was deleted along with related messages, tasks, and memberships.`);
    case "channel.renamed":
      return tx(`群组 ${data.previous_name ?? "group"} 已重命名为 ${data.next_name ?? "group"}。`, `Group ${data.previous_name ?? "group"} was renamed to ${data.next_name ?? "group"}.`);
    case "material.added":
      return tx(`新增原料来源 ${data.source ?? "source"}，当前状态：${data.status ?? "unknown"}。`, `Added material source ${data.source ?? "source"} with status ${data.status ?? "unknown"}.`);
    case "material.imported":
      return tx(`已导入文件 ${data.source ?? "file"}，落盘到 ${data.stored_name ?? "target"}，后续可用于切片和员工生成。`, `Imported file ${data.source ?? "file"} and stored it as ${data.stored_name ?? "target"} for downstream processing.`);
    case "material.parsed":
      return tx(`文件 ${data.source ?? "file"} 已完成首轮解析，可进入切片或员工生成流程。`, `File ${data.source ?? "file"} was parsed and is ready for downstream slicing or generation.`);
    case "channel.message":
      return tx(`${data.speaker ?? "Someone"} 在 ${data.channel_name ?? "channel"} 发送了一条普通消息，未触发任何 AI员工。`, `${data.speaker ?? "Someone"} sent a regular message in ${data.channel_name ?? "channel"} without triggering any AI employee.`);
    case "channel.mention_dispatched":
      return tx(`${data.speaker ?? "Someone"} 在 ${data.channel_name ?? "channel"} 定向 @了 ${data.mentions ?? "AI员工"}，已分发给 ${data.queued_count ?? "0"} 个 AI员工。`, `${data.speaker ?? "Someone"} directly mentioned ${data.mentions ?? "AI employees"} in ${data.channel_name ?? "channel"}, dispatching ${data.queued_count ?? "0"} AI employee(s).`);
    case "channel.mention_unavailable":
      return tx(`${data.speaker ?? "Someone"} 在 ${data.channel_name ?? "channel"} @了 ${data.mentions ?? "AI员工"}，但目标 AI员工 当前不可执行。`, `${data.speaker ?? "Someone"} mentioned ${data.mentions ?? "AI employees"} in ${data.channel_name ?? "channel"}, but the target AI employee is not executable right now.`);
    case "employee.created":
      return tx(`${data.employee_name ?? "AI员工"} 已直接入组，等待后续手动加入群组。`, `${data.employee_name ?? "AI employee"} joined the workspace directly and is waiting to be added to groups.`);
    case "task.created":
      return tx(`${data.assignee ?? "AI员工"} 已在 ${data.channel_name ?? "channel"} 接收任务：${data.task_title ?? "task"}。`, `${data.assignee ?? "AI employee"} received task ${data.task_title ?? "task"} in ${data.channel_name ?? "channel"}.`);
    case "task.queued":
      return tx(`${data.task_title ?? "Task"} 已进入执行队列，等待 ${data.runtime_name ?? "执行引擎"} 执行。`, `${data.task_title ?? "Task"} entered the execution queue and is waiting for ${data.runtime_name ?? "execution engine"} to execute it.`);
    case "task.status_updated":
      return tx(`任务 ${data.task_title ?? "task"} 已更新为 ${translateTaskStatus(data.status ?? "", tx)}。`, `Task ${data.task_title ?? "task"} was updated to ${translateTaskStatus(data.status ?? "", tx)}.`);
    case "channel_document.created":
      return tx(`群组 ${data.channel_name ?? "group"} 新建文档《${data.document_title ?? "文档"}》。`, `Document "${data.document_title ?? "Document"}" was created in ${data.channel_name ?? "group"}.`);
    case "channel_document.updated":
      return tx(`群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》已更新。`, `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} was updated.`);
    case "channel_document.archived":
      return tx(`群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》已归档。`, `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} was archived.`);
    case "channel_document.restored":
      return tx(`群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》已恢复。`, `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} was restored.`);
    case "channel_document.rolled_back":
      return tx(`群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》已回滚。`, `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} was rolled back.`);
    case "channel_document.exported":
      return tx(`群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》已导出为附件。`, `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} was exported as an attachment.`);
    case "channel_document.run_created":
      return tx(
        `群组 ${data.channel_name ?? "group"} 创建了一条 ${data.step_count ?? "0"} 步的群文档协作流程。`,
        `A ${data.step_count ?? "0"}-step document workflow was created in ${data.channel_name ?? "group"}.`,
      );
    case "channel_document.run_ambiguous":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的多 AI员工 协作顺序不明确，系统要求用户改写指令。`,
        `The multi-AI employee collaboration order in ${data.channel_name ?? "group"} was ambiguous, so the system asked the user to rewrite the instruction.`,
      );
    case "channel_document.conflict":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》发生并发更新冲突。`,
        `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} has a concurrent update conflict.`,
      );
    case "channel_document.conflict_resolved":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》冲突已被标记为已处理。`,
        `Document "${data.document_title ?? "Document"}" conflict in ${data.channel_name ?? "group"} was marked as resolved.`,
      );
    case "channel_document.conflict_retried":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》冲突改动已按最新版本重新应用。`,
        `Document "${data.document_title ?? "Document"}" conflicted change in ${data.channel_name ?? "group"} was reapplied on top of the latest version.`,
      );
    case "channel_document.collaborator_added":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》新增协作者 ${data.collaborator_name ?? "User"}，角色为 ${data.role ?? "editor"}。`,
        `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} added collaborator ${data.collaborator_name ?? "User"} as ${data.role ?? "editor"}.`,
      );
    case "channel_document.collaborator_removed":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》移除了协作者 ${data.collaborator_name ?? "User"}。`,
        `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} removed collaborator ${data.collaborator_name ?? "User"}.`,
      );
    case "channel_document.access_updated":
      return tx(
        `群组 ${data.channel_name ?? "group"} 的文档《${data.document_title ?? "文档"}》把 ${data.collaborator_name ?? "User"} 的角色从 ${data.previous_role ?? "viewer"} 调整为 ${data.next_role ?? "editor"}。`,
        `Document "${data.document_title ?? "Document"}" in ${data.channel_name ?? "group"} changed ${data.collaborator_name ?? "User"} role from ${data.previous_role ?? "viewer"} to ${data.next_role ?? "editor"}.`,
      );
    default:
      return entry.note;
  }
}
