import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceSync,
  hardDeleteWorkspaceSync,
  readWorkspaceSync,
} from "./workspaces.ts";
import {
  createKnowledgeProposalSync,
  decideKnowledgeProposalSync,
  listKnowledgeProposalsSync,
  readKnowledgeProposalSync,
  resetKnowledgeProposalsSync,
  updateKnowledgeProposalApprovalIdSync,
} from "./knowledge-proposals.ts";
import { resetWorkspaceExecutionStateSync } from "./workspace-state.ts";

test("knowledge proposal CRUD stays isolated by workspace", () => {
  const alpha = createTestWorkspace("knowledge-proposal-alpha");
  const beta = createTestWorkspace("knowledge-proposal-beta");
  const alphaProposal = createKnowledgeProposalSync({
    workspaceId: alpha.id,
    sourceTaskQueueId: "task-alpha",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Alpha checklist",
    contentMarkdown: "# Alpha",
    tags: ["ops", "review"],
    assignmentMode: "selected_agents",
    assignedEmployeeNames: ["Atlas"],
  });
  const betaProposal = createKnowledgeProposalSync({
    workspaceId: beta.id,
    sourceTaskQueueId: "task-beta",
    sourceAgentName: "Beacon",
    operation: "update",
    title: "Beta checklist",
    contentMarkdown: "# Beta",
    targetKnowledgePageId: "page-beta",
    baseUpdatedAt: "2026-05-14T00:00:00.000Z",
    approvalId: "approval-beta",
  });

  assert.equal(readKnowledgeProposalSync(alphaProposal.id, alpha.id)?.title, "Alpha checklist");
  assert.equal(readKnowledgeProposalSync(alphaProposal.id, beta.id), null);
  assert.deepEqual(listKnowledgeProposalsSync(alpha.id).map((proposal) => proposal.id), [alphaProposal.id]);
  assert.deepEqual(listKnowledgeProposalsSync(beta.id).map((proposal) => proposal.id), [betaProposal.id]);

  const linked = updateKnowledgeProposalApprovalIdSync({
    workspaceId: alpha.id,
    proposalId: alphaProposal.id,
    approvalId: "approval-alpha",
  });
  assert.equal(linked.approvalId, "approval-alpha");

  const decided = decideKnowledgeProposalSync({
    workspaceId: alpha.id,
    proposalId: alphaProposal.id,
    status: "approved",
    decidedByUserId: "owner-alpha",
    reviewerComment: "Looks reusable",
    createdKnowledgePageId: "page-alpha",
  });
  assert.equal(decided.status, "approved");
  assert.equal(decided.createdKnowledgePageId, "page-alpha");
  assert.equal(decided.reviewerComment, "Looks reusable");
  assert.equal(listKnowledgeProposalsSync(alpha.id, { statuses: ["pending"] }).length, 0);
});

test("knowledge proposals are reset with workspace execution state", () => {
  const workspace = createTestWorkspace("knowledge-proposal-reset");
  createKnowledgeProposalSync({
    workspaceId: workspace.id,
    sourceTaskQueueId: "task-reset",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Reset checklist",
    contentMarkdown: "# Reset",
  });

  const reset = resetWorkspaceExecutionStateSync(workspace.id);

  assert.equal(reset.removedKnowledgeProposalRows, 1);
  assert.deepEqual(listKnowledgeProposalsSync(workspace.id), []);
});

test("knowledge proposals are removed when a workspace is hard-deleted", () => {
  const workspace = createTestWorkspace("knowledge-proposal-delete");
  createKnowledgeProposalSync({
    workspaceId: workspace.id,
    sourceTaskQueueId: "task-delete",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Delete checklist",
    contentMarkdown: "# Delete",
  });

  const result = hardDeleteWorkspaceSync(workspace.id);

  assert.equal(result.removedKnowledgeProposalRows, 1);
  assert.equal(readWorkspaceSync(workspace.id), null);
});

test("knowledge proposal reset only removes the requested workspace", () => {
  const alpha = createTestWorkspace("knowledge-proposal-reset-alpha");
  const beta = createTestWorkspace("knowledge-proposal-reset-beta");
  createKnowledgeProposalSync({
    workspaceId: alpha.id,
    sourceTaskQueueId: "task-alpha",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Alpha",
    contentMarkdown: "# Alpha",
  });
  const betaProposal = createKnowledgeProposalSync({
    workspaceId: beta.id,
    sourceTaskQueueId: "task-beta",
    sourceAgentName: "Beacon",
    operation: "create",
    title: "Beta",
    contentMarkdown: "# Beta",
  });

  assert.equal(resetKnowledgeProposalsSync(alpha.id).removedKnowledgeProposalRows, 1);

  assert.deepEqual(listKnowledgeProposalsSync(alpha.id), []);
  assert.deepEqual(listKnowledgeProposalsSync(beta.id).map((proposal) => proposal.id), [betaProposal.id]);
});

function createTestWorkspace(prefix: string): ReturnType<typeof createWorkspaceSync> {
  const suffix = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  return createWorkspaceSync({
    id: `${prefix}-${suffix}`,
    slug: `${prefix}-${suffix}`,
    name: `${prefix} ${suffix}`,
    createdBy: "test",
  });
}
