import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  bindEmployeeRuntimeSync,
  createWorkspaceSync,
  createUserSync,
  createWorkspaceMembershipSync,
  enqueueNativeTaskSync,
  loadRepositoryEnvIntoProcess,
  listTaskExecutionEventsSync,
  listWorkspaceNotificationsForRecipientSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  approveKnowledgeProposalForActorSync,
  createEmployeeSync,
  createKnowledgePageSync,
  createKnowledgeProposalFromAgentSync,
  listEmployeeKnowledgePageIdsSync,
  readWorkspaceStateSync,
  rejectKnowledgeProposalForActorSync,
  readKnowledgeProposalSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-knowledge-proposals-"));
const repositoryRoot = existsSync(join(originalCwd, "Target.md")) ? originalCwd : join(originalCwd, "..", "..");

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = repositoryRoot;
  loadRepositoryEnvIntoProcess({ startDir: repositoryRoot, override: false });
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  const packagesLink = join(tempRoot, "packages");
  if (!existsSync(packagesLink)) {
    symlinkSync(join(repositoryRoot, "packages"), packagesLink, "dir");
  }
  process.chdir(tempRoot);
});

test("agent knowledge proposal creates pending approval without writing a knowledge page", () => {
  const { owner, queued, workspaceId } = seedProposalWorkspace("create-pending");

  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Approval checklist",
    contentMarkdown: "# Approval checklist\n\n- Notify admins",
    reason: "Reusable workflow",
  });

  const state = readWorkspaceStateSync(workspaceId);
  const notifications = listWorkspaceNotificationsForRecipientSync({
    workspaceId,
    recipientType: "human",
    recipientId: owner.id,
  });

  assert.equal(proposal.status, "pending");
  assert.equal(state.knowledgePages.length, 0);
  assert.equal(state.approvals[0]?.type, "knowledge_proposal");
  assert.equal(state.approvals[0]?.metadata?.proposalId, proposal.id);
  assert.equal(notifications.some((notification) => notification.type === "knowledge.proposal_requested"), true);
});

test("approving create proposal writes knowledge page and selected assignment", () => {
  const { owner, queued, workspaceId } = seedProposalWorkspace("approve-create");
  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Approval checklist",
    contentMarkdown: "# Approval checklist\n\n- Notify admins",
    assignmentMode: "selected_agents",
  });

  const result = approveKnowledgeProposalForActorSync({
    workspaceId,
    proposalId: proposal.id,
    actor: { userId: owner.id, displayName: owner.displayName, role: "owner" },
    reviewerComment: "Good",
  });

  const state = readWorkspaceStateSync(workspaceId);
  assert.equal(result.proposal.status, "approved");
  assert.equal(result.knowledgePage?.title, "Approval checklist");
  assert.equal(result.knowledgePage?.sourceKnowledgeProposalId, proposal.id);
  assert.equal(result.knowledgePage?.sourceApprovalId, proposal.approvalId);
  assert.equal(result.knowledgePage?.sourceTaskQueueId, queued.id);
  assert.equal(result.knowledgePage?.sourceAgentName, "Atlas");
  assert.equal(state.approvals[0]?.status, "approved");
  assert.deepEqual(listEmployeeKnowledgePageIdsSync("Atlas", workspaceId), [result.knowledgePage!.id]);
  assert.equal(listTaskExecutionEventsSync({ taskId: queued.id }).some((event) => event.type === "approval_reviewed"), true);
});

test("create proposal can opt out of assigning to the source agent", () => {
  const { queued, workspaceId } = seedProposalWorkspace("assign-opt-out");

  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Team-wide note",
    contentMarkdown: "# Team-wide note",
    assignmentMode: "selected_agents",
    assignedEmployeeNames: [],
    assignToSelf: false,
  });

  assert.deepEqual(proposal.assignedEmployeeNames, []);
});

test("proposal text fields reject credential material before approval creation", () => {
  const { queued, workspaceId } = seedProposalWorkspace("secret-reason");

  assert.throws(
    () => createKnowledgeProposalFromAgentSync({
      workspaceId,
      sourceTaskQueueId: queued.id,
      sourceChannelName: "general",
      sourceAgentName: "Atlas",
      operation: "create",
      title: "Approval checklist",
      contentMarkdown: "# Approval checklist",
      reason: "Reusable workflow with Bearer ya29.secret-token-material-1234567890",
    }),
    /credential|token/i,
  );
  assert.equal(readWorkspaceStateSync(workspaceId).approvals.length, 0);
});

test("update proposal becomes stale when target page changed", () => {
  const { owner, queued, workspaceId } = seedProposalWorkspace("stale-update");
  createKnowledgePageSync({
    title: "Existing",
    contentMarkdown: "Old",
  }, workspaceId);
  const page = readWorkspaceStateSync(workspaceId).knowledgePages[0]!;
  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "update",
    title: "Existing",
    contentMarkdown: "New",
    targetKnowledgePageId: page.id,
    baseUpdatedAt: page.updatedAt,
  });
  createKnowledgePageSync({ title: "Other", contentMarkdown: "Drift" }, workspaceId);
  const driftedState = readWorkspaceStateSync(workspaceId);
  const current = driftedState.knowledgePages.find((item) => item.id === page.id)!;
  current.updatedAt = new Date(Date.now() + 1000).toISOString();
  writeWorkspaceStateSync(driftedState, workspaceId);

  assert.throws(
    () => approveKnowledgeProposalForActorSync({
      workspaceId,
      proposalId: proposal.id,
      actor: { userId: owner.id, displayName: owner.displayName, role: "owner" },
    }),
    /stale/i,
  );
  assert.equal(readKnowledgeProposalSync(proposal.id, workspaceId)?.status, "stale");
});

test("rejecting proposal does not create knowledge page", () => {
  const { owner, queued, workspaceId } = seedProposalWorkspace("reject");
  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Approval checklist",
    contentMarkdown: "# Approval checklist",
  });

  const rejected = rejectKnowledgeProposalForActorSync({
    workspaceId,
    proposalId: proposal.id,
    actor: { userId: owner.id, displayName: owner.displayName, role: "owner" },
    reviewerComment: "Too narrow",
  });

  assert.equal(rejected.status, "rejected");
  assert.equal(readWorkspaceStateSync(workspaceId).knowledgePages.length, 0);
});

test("approving update proposal writes page content, assignments, and source metadata", () => {
  const { owner, queued, workspaceId } = seedProposalWorkspace("approve-update");
  createEmployeeSync({ name: "Beacon", role: "Analyst" }, workspaceId);
  createKnowledgePageSync({
    title: "Existing",
    contentMarkdown: "Old",
  }, workspaceId);
  const page = readWorkspaceStateSync(workspaceId).knowledgePages[0]!;
  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "update",
    title: "Existing updated",
    contentMarkdown: "New",
    assignmentMode: "selected_agents",
    assignedEmployeeNames: ["Beacon"],
    assignToSelf: false,
    targetKnowledgePageId: page.id,
    baseUpdatedAt: page.updatedAt,
  });

  const result = approveKnowledgeProposalForActorSync({
    workspaceId,
    proposalId: proposal.id,
    actor: { userId: owner.id, displayName: owner.displayName, role: "owner" },
  });

  assert.equal(result.knowledgePage?.id, page.id);
  assert.equal(result.knowledgePage?.title, "Existing updated");
  assert.equal(result.knowledgePage?.contentMarkdown, "New");
  assert.equal(result.knowledgePage?.sourceKnowledgeProposalId, proposal.id);
  assert.equal(result.knowledgePage?.sourceTaskQueueId, queued.id);
  assert.deepEqual(listEmployeeKnowledgePageIdsSync("Beacon", workspaceId), [page.id]);
  assert.deepEqual(listEmployeeKnowledgePageIdsSync("Atlas", workspaceId), []);
});

test("non-manager and cross-workspace actors cannot review knowledge proposals", () => {
  const { queued, workspaceId } = seedProposalWorkspace("review-guards");
  const member = createUserSync({
    displayName: "Member",
    primaryEmail: `member-${Math.random().toString(36).slice(2)}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: member.id, role: "member" });
  const proposal = createKnowledgeProposalFromAgentSync({
    workspaceId,
    sourceTaskQueueId: queued.id,
    sourceChannelName: "general",
    sourceAgentName: "Atlas",
    operation: "create",
    title: "Approval checklist",
    contentMarkdown: "# Approval checklist",
  });

  assert.throws(
    () => approveKnowledgeProposalForActorSync({
      workspaceId,
      proposalId: proposal.id,
      actor: { userId: member.id, displayName: member.displayName, role: "member" },
    }),
    /Only workspace owners and admins/,
  );
  assert.throws(
    () => rejectKnowledgeProposalForActorSync({
      workspaceId: "other-workspace",
      proposalId: proposal.id,
      actor: { userId: member.id, displayName: member.displayName, role: "owner" },
    }),
    /does not exist/,
  );
  assert.equal(readKnowledgeProposalSync(proposal.id, workspaceId)?.status, "pending");
});

test.after(() => {
  process.chdir(originalCwd);
});

function seedProposalWorkspace(label: string) {
  const workspaceId = `knowledge-proposals-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: `Knowledge proposals ${label}`,
    createdBy: "test",
  });
  resetWorkspaceStateSync(workspaceId);
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(workspaceId),
    organizationName: "Northstar Labs",
    channels: [
      {
        name: "general",
        kind: "group",
        humanMemberNames: ["Owner"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
    ],
  }, workspaceId);
  const owner = createUserSync({
    displayName: "Owner",
    primaryEmail: `owner-${Math.random().toString(36).slice(2)}@example.com`,
  });
  createWorkspaceMembershipSync({ workspaceId, userId: owner.id, role: "owner" });
  createEmployeeSync({ name: "Atlas", role: "Planner" }, workspaceId);
  const snapshot = registerDaemonRuntimesSync({
    workspaceId,
    daemonKey: `daemon-${Math.random().toString(36).slice(2)}`,
    deviceName: "Build Box",
    runtimes: [{ provider: "codex", name: "Codex", version: "test" }],
  });
  bindEmployeeRuntimeSync({ workspaceId, employeeName: "Atlas", runtimeId: snapshot.runtimes[0]!.id });
  const queued = enqueueNativeTaskSync({
    workspaceId,
    assignee: "Atlas",
    title: "Draft checklist",
    channel: "general",
    priority: "medium",
  });
  assert.ok(queued);
  return { owner, queued, workspaceId };
}
