import {
  appendWorkflowRunEventSync,
  getDatabase,
  listWorkspaceMembershipsSync,
  listWorkflowNodeRunsSync,
  lockWorkflowRunForUpdateSync,
  readStoredEmployeeByIdSync,
  readWorkflowNodeRunByApprovalIdSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  withTransaction,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { ApprovalRequest } from "@dofe-agent/domain/workspace";
import { createApprovalRequestSync, listApprovalsSync, reviewApprovalSync } from "../approvals/approvals.ts";
import { completeWorkflowApprovalNodeSync } from "./coordinator.ts";

export interface CreateWorkflowApprovalInput {
  workspaceId: string;
  runId: string;
  nodeId: string;
  employeeId: string;
  channelName: string;
  contentPreview: string;
  // 指定审批人与风险等级（UIUX:82）：可选，落地到审批记录 metadata 供鉴权与展示。
  reviewerUserId?: string;
  risk?: "low" | "medium" | "high";
  now?: string;
}

export function createWorkflowApprovalSync(input: CreateWorkflowApprovalInput): ApprovalRequest {
  return withTransaction(getDatabase(), () => {
    const run = lockWorkflowRunForUpdateSync(input.runId, input.workspaceId);
    if (!run) throw new Error("workflow_run_not_found");
    const node = listWorkflowNodeRunsSync(input.workspaceId, input.runId).find((item) => item.nodeId === input.nodeId);
    if (!node || node.nodeType !== "approval") throw new Error("workflow_approval_node_not_found");
    if (node.approvalId) throw new Error("workflow_approval_already_created");
    const employee = readStoredEmployeeByIdSync(input.employeeId, input.workspaceId);
    if (!employee) throw new Error("workflow_approval_employee_not_ready");
    const approval = listApprovalsSync(input.workspaceId).find((item) => (
      item.sourceId === node.id && item.status === "pending" && item.metadata?.kind === "workflow_node"
    )) ?? createApprovalRequestSync({
        type: "task_output",
        sourceId: node.id,
        agentId: employee.name,
        channelName: input.channelName,
        contentPreview: input.contentPreview,
        metadata: {
        kind: "workflow_node",
        workflowRunId: run.id,
        workflowNodeRunId: node.id,
        workflowNodeId: node.nodeId,
        ...(input.reviewerUserId ? { reviewerUserId: input.reviewerUserId } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
      },
      }, input.workspaceId).approvals[0];
    if (!approval) throw new Error("workflow_approval_create_failed");
    const updated = transitionWorkflowNodeRunSync({
      workspaceId: input.workspaceId,
      nodeRunId: node.id,
      from: ["pending", "ready"],
      to: "waiting_approval",
      approvalId: approval.id,
      clearError: true,
      now: input.now,
    });
    if (!updated) throw new Error("workflow_approval_node_conflict");
    transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["created", "queued", "running"], to: "waiting_approval", now: input.now });
    appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: node.id, type: "approval.requested", actorType: "system", dataJson: JSON.stringify({ approvalId: approval.id }), now: input.now });
    return approval;
  });
}

export function workflowApprovalInputFromNodeConfig(config: Record<string, unknown>): {
  employeeId: string;
  channelName: string;
  contentPreview: string;
  reviewerUserId?: string;
  risk?: "low" | "medium" | "high";
} {
  const employeeId = typeof config.employeeId === "string" ? config.employeeId.trim() : "";
  const channelName = typeof config.channelName === "string" ? config.channelName.trim() : "";
  const contentPreview = typeof config.instruction === "string" && config.instruction.trim()
    ? config.instruction.trim()
    : "请审批此工作流步骤的上游交付结果。";
  if (!employeeId) throw new Error("workflow_approval_employee_not_ready");
  if (!channelName) throw new Error("workflow_approval_channel_not_ready");
  // 风险等级：仅接受合法枚举，其余忽略（校验已在 publishing 阶段完成）。
  const risk = config.risk === "low" || config.risk === "medium" || config.risk === "high" ? config.risk : undefined;
  const reviewerUserId = typeof config.reviewerUserId === "string" ? config.reviewerUserId.trim() : "";
  return {
    employeeId,
    channelName,
    contentPreview,
    ...(reviewerUserId ? { reviewerUserId } : {}),
    ...(risk ? { risk } : {}),
  };
}

export function continueWorkflowAfterApprovalSync(input: {
  workspaceId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  actorUserId: string;
}): WorkflowRunRecord {
  return completeWorkflowApprovalNodeSync({
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    actorUserId: input.actorUserId,
    approved: input.decision === "approved",
  });
}

export function reviewWorkflowApprovalSync(input: {
  workspaceId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  actorUserId: string;
  comment?: string;
}): WorkflowRunRecord {
  return withTransaction(getDatabase(), () => {
    const approval = listApprovalsSync(input.workspaceId).find((item) => item.id === input.approvalId);
    if (!approval || approval.metadata?.kind !== "workflow_node") throw new Error("workflow_approval_not_linked");
    // 指定审批人闭环（UIUX:82）：若设置了 reviewerUserId，仅该成员或工作区管理员可审批；
    // 其他成员（含未指定的管理员以外角色）一律拒绝，避免「被指定者无法审批、未指定者反可审批」。
    const reviewerUserId = typeof approval.metadata?.reviewerUserId === "string" ? approval.metadata.reviewerUserId.trim() : "";
    if (reviewerUserId && reviewerUserId !== input.actorUserId) {
      const actorIsManager = listWorkspaceMembershipsSync(input.workspaceId).some((membership) =>
        membership.userId === input.actorUserId && (membership.role === "owner" || membership.role === "admin"));
      if (!actorIsManager) throw new Error("workflow_approval_reviewer_unauthorized");
    }
    const nodeRun = readWorkflowNodeRunByApprovalIdSync(input.approvalId, input.workspaceId);
    if (!nodeRun) throw new Error("workflow_approval_not_linked");
    if (!lockWorkflowRunForUpdateSync(nodeRun.runId, input.workspaceId)) throw new Error("workflow_run_not_found");
    reviewApprovalSync(input.approvalId, input.decision, input.comment, input.workspaceId);
    const run = continueWorkflowAfterApprovalSync(input);
    if (input.decision === "rejected") {
      cancelPendingWorkflowApprovalsSync({
        workspaceId: input.workspaceId,
        runId: run.id,
        reason: "workflow_approval_rejected",
      });
    }
    return run;
  });
}

export function reviewApprovalWithWorkflowSync(input: {
  workspaceId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  actorUserId: string;
  comment?: string;
}): void {
  withTransaction(getDatabase(), () => {
    const approval = listApprovalsSync(input.workspaceId).find((item) => item.id === input.approvalId);
    if (approval?.metadata?.kind === "workflow_node") {
      reviewWorkflowApprovalSync(input);
      return;
    }
    reviewApprovalSync(input.approvalId, input.decision, input.comment, input.workspaceId);
  });
}

export function cancelPendingWorkflowApprovalsSync(input: {
  workspaceId: string;
  runId: string;
  reason: string;
}): string[] {
  const approvalIds = new Set(
    listWorkflowNodeRunsSync(input.workspaceId, input.runId)
      .map((node) => node.approvalId)
      .filter((approvalId): approvalId is string => Boolean(approvalId)),
  );
  const cancelled: string[] = [];
  for (const approval of listApprovalsSync(input.workspaceId)) {
    if (!approvalIds.has(approval.id) || approval.status !== "pending") continue;
    reviewApprovalSync(approval.id, "rejected", input.reason, input.workspaceId, { suppressConversationMessage: true });
    cancelled.push(approval.id);
  }
  return cancelled;
}
