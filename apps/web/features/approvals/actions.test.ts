import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockApproveAgentAccessRequestForActorSync,
  mockApproveChannelAccessRequestForActorSync,
  mockApproveDocumentPermissionRequestSync,
  mockApproveKnowledgeProposalForActorSync,
  mockCreateApprovalRequestSync,
  mockListApprovalsSync,
  mockRejectAgentAccessRequestForActorSync,
  mockRejectChannelAccessRequestForActorSync,
  mockRejectDocumentPermissionRequestSync,
  mockRejectKnowledgeProposalForActorSync,
  mockReviewFeishuDataOperationApproval,
  mockReviewApprovalSync,
  mockReviewApprovalWithWorkflowSync,
  mockReviewWorkflowApprovalSync,
  mockRequireCurrentWorkspaceContext,
  mockRevalidateWorkspacePaths,
} = vi.hoisted(() => ({
  mockApproveAgentAccessRequestForActorSync: vi.fn(),
  mockApproveChannelAccessRequestForActorSync: vi.fn(),
  mockApproveDocumentPermissionRequestSync: vi.fn(),
  mockApproveKnowledgeProposalForActorSync: vi.fn(),
  mockCreateApprovalRequestSync: vi.fn(),
  mockListApprovalsSync: vi.fn(),
  mockRejectAgentAccessRequestForActorSync: vi.fn(),
  mockRejectChannelAccessRequestForActorSync: vi.fn(),
  mockRejectDocumentPermissionRequestSync: vi.fn(),
  mockRejectKnowledgeProposalForActorSync: vi.fn(),
  mockReviewFeishuDataOperationApproval: vi.fn(),
  mockReviewApprovalSync: vi.fn(),
  mockReviewApprovalWithWorkflowSync: vi.fn(),
  mockReviewWorkflowApprovalSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  approveAgentAccessRequestForActorSync: mockApproveAgentAccessRequestForActorSync,
  approveChannelAccessRequestForActorSync: mockApproveChannelAccessRequestForActorSync,
  approveDocumentPermissionRequestSync: mockApproveDocumentPermissionRequestSync,
  approveKnowledgeProposalForActorSync: mockApproveKnowledgeProposalForActorSync,
  createApprovalRequestSync: mockCreateApprovalRequestSync,
  listApprovalsSync: mockListApprovalsSync,
  rejectAgentAccessRequestForActorSync: mockRejectAgentAccessRequestForActorSync,
  rejectChannelAccessRequestForActorSync: mockRejectChannelAccessRequestForActorSync,
  rejectDocumentPermissionRequestSync: mockRejectDocumentPermissionRequestSync,
  rejectKnowledgeProposalForActorSync: mockRejectKnowledgeProposalForActorSync,
  reviewFeishuDataOperationApproval: mockReviewFeishuDataOperationApproval,
  reviewApprovalSync: mockReviewApprovalSync,
  reviewApprovalWithWorkflowSync: mockReviewApprovalWithWorkflowSync,
  reviewWorkflowApprovalSync: mockReviewWorkflowApprovalSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

import { createApprovalAction, reviewApprovalAction, reviewApprovalQueueItemAction } from "./actions";

describe("approval actions", () => {
  beforeEach(() => {
    mockApproveAgentAccessRequestForActorSync.mockReset();
    mockApproveChannelAccessRequestForActorSync.mockReset();
    mockApproveDocumentPermissionRequestSync.mockReset();
    mockApproveKnowledgeProposalForActorSync.mockReset();
    mockCreateApprovalRequestSync.mockReset();
    mockListApprovalsSync.mockReset();
    mockListApprovalsSync.mockReturnValue([]);
    mockRejectAgentAccessRequestForActorSync.mockReset();
    mockRejectChannelAccessRequestForActorSync.mockReset();
    mockRejectDocumentPermissionRequestSync.mockReset();
    mockRejectKnowledgeProposalForActorSync.mockReset();
    mockReviewFeishuDataOperationApproval.mockReset();
    mockReviewApprovalSync.mockReset();
    mockReviewApprovalWithWorkflowSync.mockReset();
    mockReviewWorkflowApprovalSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
  });

  it("allows members to create approval requests", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await createApprovalAction({
      type: "message_draft",
      sourceId: "task-1",
      agentId: "atlas",
      channelName: "tour-visit",
      contentPreview: "Need approval",
    });

    expect(mockCreateApprovalRequestSync).toHaveBeenCalledWith({
      type: "message_draft",
      sourceId: "task-1",
      agentId: "atlas",
      channelName: "tour-visit",
      contentPreview: "Need approval",
    }, "workspace-1");
  });

  it("rejects members when reviewing approvals", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(reviewApprovalAction("approval-1", "approved")).rejects.toThrow("Forbidden.");
    expect(mockReviewApprovalSync).not.toHaveBeenCalled();
  });

  it("allows admins to review approvals", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    const result = await reviewApprovalAction("approval-1", "approved", "Ship it");

    expect(mockReviewApprovalWithWorkflowSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      approvalId: "approval-1",
      decision: "approved",
      actorUserId: "user-1",
      comment: "Ship it",
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", [
      "/approvals",
      "/inbox",
      "/agents",
      "/im",
      "/settings/permissions",
      "/settings/permissions",
      "/knowledge",
    ]);
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["approvals", "inbox", "agents", "im", "settings"],
      resources: [{ type: "approval", id: "approval-1" }],
      shell: "counters",
    });
  });

  it("uses the atomic workflow review service for workflow approvals", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    mockListApprovalsSync.mockReturnValue([{
      id: "approval-workflow-1",
      type: "task_output",
      sourceId: "node-run-1",
      agentId: "Atlas",
      channelName: "tour-visit",
      status: "pending",
      contentPreview: "Review workflow output",
      metadata: { kind: "workflow_node" },
      createdAt: "2026-08-06T00:00:00.000Z",
    }]);

    await reviewApprovalAction("approval-workflow-1", "rejected", "Needs changes");

    expect(mockReviewApprovalWithWorkflowSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      approvalId: "approval-workflow-1",
      decision: "rejected",
      actorUserId: "user-1",
      comment: "Needs changes",
    });
    expect(mockReviewApprovalSync).not.toHaveBeenCalled();
  });

  it("allows a designated reviewer to review a workflow approval even as a member", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockListApprovalsSync.mockReturnValue([{
      id: "approval-designated",
      type: "task_output",
      sourceId: "node-run-1",
      agentId: "Atlas",
      channelName: "tour-visit",
      status: "pending",
      contentPreview: "Review workflow output",
      metadata: { kind: "workflow_node", reviewerUserId: "user-1", risk: "medium" },
      createdAt: "2026-08-06T00:00:00.000Z",
    }]);

    await reviewApprovalAction("approval-designated", "approved", "Looks good");

    expect(mockReviewApprovalWithWorkflowSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      approvalId: "approval-designated",
      decision: "approved",
      actorUserId: "user-1",
      comment: "Looks good",
    });
  });

  it("blocks a member who is not the designated reviewer of a workflow approval", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockListApprovalsSync.mockReturnValue([{
      id: "approval-designated",
      type: "task_output",
      sourceId: "node-run-1",
      agentId: "Atlas",
      channelName: "tour-visit",
      status: "pending",
      contentPreview: "Review workflow output",
      metadata: { kind: "workflow_node", reviewerUserId: "someone-else" },
      createdAt: "2026-08-06T00:00:00.000Z",
    }]);

    await expect(reviewApprovalAction("approval-designated", "approved")).rejects.toThrow("Forbidden.");
    expect(mockReviewApprovalWithWorkflowSync).not.toHaveBeenCalled();
  });

  it("executes Feishu data operation approvals from the merged approval queue", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    mockListApprovalsSync.mockReturnValue([{
      id: "approval-feishu-1",
      type: "external_data_operation",
      sourceId: "external-data-operation-1",
      agentId: "Atlas",
      channelName: "tour-visit",
      status: "pending",
      contentPreview: "Atlas requested a Feishu Sheet update.",
      metadata: {
        provider: "feishu",
        operationRunId: "external-data-operation-1",
      },
      createdAt: "2026-06-24T00:00:00.000Z",
    }]);

    const result = await reviewApprovalQueueItemAction("workspace_approval", "approval-feishu-1", "approved", "Looks good");

    expect(mockReviewFeishuDataOperationApproval).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      approvalId: "approval-feishu-1",
      decision: "approved",
      reviewerComment: "Looks good",
    });
    expect(mockReviewApprovalSync).not.toHaveBeenCalled();
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["approvals", "inbox", "agents", "im", "settings"],
      resources: [{ type: "approval", id: "approval-feishu-1" }],
      shell: "counters",
    });
  });

  it("reviews channel access requests from the merged approval queue", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    const result = await reviewApprovalQueueItemAction("channel_access", "request-1", "approved");

    expect(mockApproveChannelAccessRequestForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      requestId: "request-1",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "admin",
      },
    });
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["approvals", "inbox", "agents", "im", "settings"],
      resources: [
        { type: "approval", id: "request-1" },
        { type: "channel" },
      ],
      shell: "counters",
    });
  });

  it("reviews document permission requests from the merged approval queue", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await reviewApprovalQueueItemAction("document_permission", "document-request-1", "rejected", "No");

    expect(mockRejectDocumentPermissionRequestSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      requestId: "document-request-1",
      decidedByUserId: "user-1",
      decisionNote: "No",
    });
  });

  it("reviews agent access requests from the merged approval queue", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    const result = await reviewApprovalQueueItemAction("agent_access", "agent-request-1", "approved");

    expect(mockApproveAgentAccessRequestForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      requestId: "agent-request-1",
      actorUserId: "user-1",
    });
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["approvals", "inbox", "agents", "im", "settings"],
      resources: [
        { type: "approval", id: "agent-request-1" },
        { type: "agent" },
      ],
      shell: "counters",
    });
  });

  it("reviews knowledge proposals from the merged approval queue", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("owner"));
    mockApproveKnowledgeProposalForActorSync.mockReturnValue({ knowledgePage: { id: "knowledge-page-1" } });

    const result = await reviewApprovalQueueItemAction(
      "knowledge_proposal",
      "knowledge-proposal-1",
      "approved",
      "Keep it",
      {
        title: "Edited title",
        assignmentMode: "selected_agents",
        assignedEmployeeNames: ["Atlas"],
      },
    );

    expect(mockApproveKnowledgeProposalForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      proposalId: "knowledge-proposal-1",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "owner",
      },
      reviewerComment: "Keep it",
      title: "Edited title",
      assignmentMode: "selected_agents",
      assignedEmployeeNames: ["Atlas"],
    });
    expect(result.data).toEqual({ knowledgePageId: "knowledge-page-1" });
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["approvals", "inbox", "agents", "im", "settings", "knowledge"],
      resources: [
        { type: "approval", id: "knowledge-proposal-1" },
        { type: "document", id: "knowledge-page-1" },
      ],
      shell: "counters",
    });
  });
});

function buildWorkspaceContext(role: "owner" | "admin" | "member") {
  return {
    currentUser: {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "techwu",
      role: "owner",
      email: "techwu@example.com",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-1",
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}
