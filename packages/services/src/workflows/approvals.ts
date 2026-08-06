import {
  appendWorkflowRunEventSync,
  listWorkflowNodeRunsSync,
  readStoredEmployeeByIdSync,
  readWorkflowRunSync,
  transitionWorkflowNodeRunSync,
  transitionWorkflowRunSync,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { ApprovalRequest } from "@dofe-agent/domain/workspace";
import { createApprovalRequestSync, listApprovalsSync } from "../approvals/approvals.ts";
import { completeWorkflowApprovalNodeSync } from "./coordinator.ts";

export interface CreateWorkflowApprovalInput {
  workspaceId: string;
  runId: string;
  nodeId: string;
  employeeId: string;
  channelName: string;
  contentPreview: string;
  now?: string;
}

export function createWorkflowApprovalSync(input: CreateWorkflowApprovalInput): ApprovalRequest {
  const run = readWorkflowRunSync(input.runId, input.workspaceId);
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
      metadata: { kind: "workflow_node", workflowRunId: run.id, workflowNodeRunId: node.id, workflowNodeId: node.nodeId },
    }, input.workspaceId).approvals[0];
  if (!approval) throw new Error("workflow_approval_create_failed");
  const updated = transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: node.id, from: ["pending", "ready"], to: "waiting_approval", approvalId: approval.id, now: input.now });
  if (!updated) throw new Error("workflow_approval_node_conflict");
  transitionWorkflowRunSync({ workspaceId: input.workspaceId, runId: run.id, from: ["created", "queued", "running"], to: "waiting_approval", now: input.now });
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: node.id, type: "approval.requested", actorType: "system", dataJson: JSON.stringify({ approvalId: approval.id }), now: input.now });
  return approval;
}

export function workflowApprovalInputFromNodeConfig(config: Record<string, unknown>): {
  employeeId: string;
  channelName: string;
  contentPreview: string;
} {
  const employeeId = typeof config.employeeId === "string" ? config.employeeId.trim() : "";
  const channelName = typeof config.channelName === "string" ? config.channelName.trim() : "";
  const contentPreview = typeof config.instruction === "string" && config.instruction.trim()
    ? config.instruction.trim()
    : "请审批此工作流步骤的上游交付结果。";
  if (!employeeId) throw new Error("workflow_approval_employee_not_ready");
  if (!channelName) throw new Error("workflow_approval_channel_not_ready");
  return { employeeId, channelName, contentPreview };
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
