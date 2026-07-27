import { formatCompactTimestamp } from "@/shared/lib/time-format";
import type { LedgerItem, WorkspaceMessage } from "@/shared/types/workspace";

export type TxFn = (zh: string, en: string) => string;

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
