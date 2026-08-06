import {
  appendWorkflowRunEventSync,
  listWorkflowNodeRunsSync,
  readWorkflowRunSync,
  transitionWorkflowNodeRunSync,
  type WorkflowRunRecord,
} from "@dofe-agent/db";
import type { ApprovalRequest } from "@dofe-agent/domain/workspace";
import { createApprovalRequestSync } from "../approvals/approvals.ts";
import { completeWorkflowApprovalNodeSync } from "./coordinator.ts";

export interface CreateWorkflowApprovalInput {
  workspaceId: string;
  runId: string;
  nodeId: string;
  agentId: string;
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
  const state = createApprovalRequestSync({
    type: "task_output",
    sourceId: node.id,
    agentId: input.agentId,
    channelName: input.channelName,
    contentPreview: input.contentPreview,
    metadata: { kind: "workflow_node", workflowRunId: run.id, workflowNodeRunId: node.id, workflowNodeId: node.nodeId },
  }, input.workspaceId);
  const approval = state.approvals[0];
  if (!approval) throw new Error("workflow_approval_create_failed");
  const updated = transitionWorkflowNodeRunSync({ workspaceId: input.workspaceId, nodeRunId: node.id, from: ["pending", "ready"], to: "waiting_approval", approvalId: approval.id, now: input.now });
  if (!updated) throw new Error("workflow_approval_node_conflict");
  appendWorkflowRunEventSync({ workspaceId: input.workspaceId, runId: run.id, nodeRunId: node.id, type: "approval.requested", actorType: "system", dataJson: JSON.stringify({ approvalId: approval.id }), now: input.now });
  return approval;
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
