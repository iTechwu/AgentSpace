import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAddChannelEmployeesSync,
  mockAddWorkspaceMemberToChannelForActorSync,
  mockAcknowledgeMessageSync,
  mockAssertCanUseEmployeeForActorSync,
  mockDeleteChannelSync,
  mockListEmployeeSkillIdsSync,
  mockListWorkspaceSkillsSync,
  mockPersistFormAttachments,
  mockPinMessageSync,
  mockCanViewChannelDocumentSync,
  mockCanReadChannelForActorSync,
  mockDeleteChannelAttachmentSync,
  mockReadChannelDocumentSync,
  mockReadWorkspaceStateSync,
  mockRenameChannelSync,
  mockRequireCurrentWorkspaceContext,
  mockGetChannelDetailData,
  mockRequestChannelAccessForActorSync,
  mockRevalidateWorkspacePaths,
  mockReviewApprovalSync,
  mockReviewApprovalWithWorkflowSync,
  mockCancelWorkflowRunSync,
  mockReplacePendingChannelMessageSync,
  mockCancelQueuedTaskSync,
  mockReadQueuedTaskSync,
  mockReadWorkflowDefinitionSync,
  mockReadWorkflowNodeRunByTaskQueueIdSync,
  mockReadWorkflowRunSync,
  mockResolveChannelHumanMemberNames,
  mockResolveWorkspaceAccessForIdentifierSync,
  mockResolveAgentRuntimeMode,
  mockSetSessionModelOverrideForChatCommandSync,
  mockSameValue,
  mockSendChannelHumanMessageSync,
  mockSendHumanDirectMessageSync,
  mockUnpinMessageSync,
  mockValidateSessionModelOverrideForChatCommandAsync,
} = vi.hoisted(() => ({
  mockAddChannelEmployeesSync: vi.fn(),
  mockAddWorkspaceMemberToChannelForActorSync: vi.fn(),
  mockAcknowledgeMessageSync: vi.fn(),
  mockAssertCanUseEmployeeForActorSync: vi.fn(),
  mockDeleteChannelSync: vi.fn(),
  mockListEmployeeSkillIdsSync: vi.fn(),
  mockListWorkspaceSkillsSync: vi.fn(),
  mockPersistFormAttachments: vi.fn(),
  mockPinMessageSync: vi.fn(),
  mockCanViewChannelDocumentSync: vi.fn(),
  mockCanReadChannelForActorSync: vi.fn(),
  mockDeleteChannelAttachmentSync: vi.fn(),
  mockReadChannelDocumentSync: vi.fn(),
  mockReadWorkspaceStateSync: vi.fn(),
  mockRenameChannelSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockGetChannelDetailData: vi.fn(),
  mockRequestChannelAccessForActorSync: vi.fn(),
  mockRevalidateWorkspacePaths: vi.fn(),
  mockReviewApprovalSync: vi.fn(),
  mockReviewApprovalWithWorkflowSync: vi.fn(),
  mockCancelWorkflowRunSync: vi.fn(),
  mockReplacePendingChannelMessageSync: vi.fn(),
  mockCancelQueuedTaskSync: vi.fn(),
  mockReadQueuedTaskSync: vi.fn(),
  mockReadWorkflowDefinitionSync: vi.fn(),
  mockReadWorkflowNodeRunByTaskQueueIdSync: vi.fn(),
  mockReadWorkflowRunSync: vi.fn(),
  mockResolveChannelHumanMemberNames: vi.fn(),
  mockResolveWorkspaceAccessForIdentifierSync: vi.fn(),
  mockResolveAgentRuntimeMode: vi.fn(),
  mockSetSessionModelOverrideForChatCommandSync: vi.fn(),
  mockSameValue: vi.fn((left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()),
  mockSendChannelHumanMessageSync: vi.fn(),
  mockSendHumanDirectMessageSync: vi.fn(),
  mockUnpinMessageSync: vi.fn(),
  mockValidateSessionModelOverrideForChatCommandAsync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  addChannelEmployeesSync: mockAddChannelEmployeesSync,
  addWorkspaceMemberToChannelForActorSync: mockAddWorkspaceMemberToChannelForActorSync,
  acknowledgeMessageSync: mockAcknowledgeMessageSync,
  assertCanUseEmployeeForActorSync: mockAssertCanUseEmployeeForActorSync,
  deleteChannelSync: mockDeleteChannelSync,
  listEmployeeSkillIdsSync: mockListEmployeeSkillIdsSync,
  listWorkspaceSkillsSync: mockListWorkspaceSkillsSync,
  deleteChannelAttachmentSync: mockDeleteChannelAttachmentSync,
  renameChannelSync: mockRenameChannelSync,
  sendChannelHumanMessageSync: mockSendChannelHumanMessageSync,
  sendHumanDirectMessageSync: mockSendHumanDirectMessageSync,
  pinMessageSync: mockPinMessageSync,
  canReadChannelForActorSync: mockCanReadChannelForActorSync,
  canViewChannelDocumentSync: mockCanViewChannelDocumentSync,
  readChannelDocumentSync: mockReadChannelDocumentSync,
  unpinMessageSync: mockUnpinMessageSync,
  readWorkspaceStateSync: mockReadWorkspaceStateSync,
  resolveChannelHumanMemberNames: mockResolveChannelHumanMemberNames,
  resolveAgentRuntimeMode: mockResolveAgentRuntimeMode,
  sameValue: mockSameValue,
  setSessionModelOverrideForChatCommandSync: mockSetSessionModelOverrideForChatCommandSync,
  addChannelDocumentCollaboratorSync: vi.fn(),
  archiveChannelDocumentSync: vi.fn(),
  restoreChannelDocumentSync: vi.fn(),
  createChannelDocumentFromAttachmentSync: vi.fn(),
  createChannelDocumentSync: vi.fn(),
  exportChannelDocumentAsAttachmentSync: vi.fn(),
  removeChannelDocumentCollaboratorSync: vi.fn(),
  resolveChannelDocumentConflictSync: vi.fn(),
  retryChannelDocumentConflictSync: vi.fn(),
  rollbackChannelDocumentVersionSync: vi.fn(),
  updateChannelDocumentAccessRoleSync: vi.fn(),
  createChannelSync: vi.fn(),
  createChannelParticipantsForMembersSync: vi.fn(),
  requestChannelAccessForActorSync: mockRequestChannelAccessForActorSync,
  reviewApprovalSync: mockReviewApprovalSync,
  reviewApprovalWithWorkflowSync: mockReviewApprovalWithWorkflowSync,
  cancelWorkflowRunSync: mockCancelWorkflowRunSync,
  replacePendingChannelMessageSync: mockReplacePendingChannelMessageSync,
  listApprovalsSync: vi.fn(() => []),
  approveChannelAccessRequestForActorSync: vi.fn(),
  rejectChannelAccessRequestForActorSync: vi.fn(),
  inviteUserToChannelForActorSync: vi.fn(),
  revokeChannelInvitationForActorSync: vi.fn(),
  sendContactMessageForHumanWithAttachmentsSync: vi.fn(),
  upsertChannelDocumentPresenceSync: vi.fn(),
  updateChannelDocumentSync: vi.fn(),
  validateSessionModelOverrideForChatCommandAsync: mockValidateSessionModelOverrideForChatCommandAsync,
}));

vi.mock("@dofe-agent/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@dofe-agent/db")>(),
  cancelQueuedTaskSync: mockCancelQueuedTaskSync,
  readQueuedTaskSync: mockReadQueuedTaskSync,
  readWorkflowDefinitionSync: mockReadWorkflowDefinitionSync,
  readWorkflowNodeRunByTaskQueueIdSync: mockReadWorkflowNodeRunByTaskQueueIdSync,
  readWorkflowRunSync: mockReadWorkflowRunSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/server-workspace-resolver", () => ({
  resolveWorkspaceAccessForIdentifierSync: mockResolveWorkspaceAccessForIdentifierSync,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: mockRevalidateWorkspacePaths,
}));

vi.mock("@/features/chat/attachment-actions", () => ({
  persistFormAttachments: mockPersistFormAttachments,
}));

vi.mock("@/features/dashboard/data", () => ({
  getChannelDetailData: mockGetChannelDetailData,
}));

import {
  acknowledgeMessageAction,
  addWorkspaceMembersToChannelAction,
  deleteChannelAction,
  deleteChannelAttachmentAction,
  pinMessageAction,
  renameChannelAction,
  requestChannelAccessAction,
  reviewInlineApprovalAction,
  stopChannelTaskAction,
  saveChannelDocumentAction,
  sendChannelMessageAction,
  sendHumanDirectMessageAction,
  getChannelDetailDataAction,
} from "./actions";

describe("channel actions", () => {
  beforeEach(() => {
    mockAddChannelEmployeesSync.mockReset();
    mockAddWorkspaceMemberToChannelForActorSync.mockReset();
    mockDeleteChannelSync.mockReset();
    mockListEmployeeSkillIdsSync.mockReset();
    mockListWorkspaceSkillsSync.mockReset();
    mockDeleteChannelAttachmentSync.mockReset();
    mockPersistFormAttachments.mockReset();
    mockAcknowledgeMessageSync.mockReset();
    mockAssertCanUseEmployeeForActorSync.mockReset();
    mockPinMessageSync.mockReset();
    mockCanViewChannelDocumentSync.mockReset();
    mockCanReadChannelForActorSync.mockReset();
    mockReadChannelDocumentSync.mockReset();
    mockReadWorkspaceStateSync.mockReset();
    mockRenameChannelSync.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
    mockGetChannelDetailData.mockReset();
    mockRequestChannelAccessForActorSync.mockReset();
    mockRevalidateWorkspacePaths.mockReset();
    mockReviewApprovalSync.mockReset();
    mockReviewApprovalWithWorkflowSync.mockReset();
    mockCancelWorkflowRunSync.mockReset();
    mockReplacePendingChannelMessageSync.mockReset();
    mockCancelQueuedTaskSync.mockReset();
    mockReadQueuedTaskSync.mockReset();
    mockReadWorkflowDefinitionSync.mockReset();
    mockReadWorkflowNodeRunByTaskQueueIdSync.mockReset();
    mockReadWorkflowRunSync.mockReset();
    mockResolveChannelHumanMemberNames.mockReset();
    mockResolveWorkspaceAccessForIdentifierSync.mockReset();
    mockResolveAgentRuntimeMode.mockReset();
    mockSetSessionModelOverrideForChatCommandSync.mockReset();
    mockSameValue.mockClear();
    mockSendChannelHumanMessageSync.mockReset();
    mockSendHumanDirectMessageSync.mockReset();
    mockUnpinMessageSync.mockReset();
    mockValidateSessionModelOverrideForChatCommandAsync.mockReset();

    mockPersistFormAttachments.mockResolvedValue([]);
    mockListEmployeeSkillIdsSync.mockReturnValue([]);
    mockListWorkspaceSkillsSync.mockReturnValue([]);
    mockResolveAgentRuntimeMode.mockReturnValue("remote");
    mockValidateSessionModelOverrideForChatCommandAsync.mockResolvedValue({
      agentName: "Atlas",
      modelId: "catalog-model",
    });
    mockReadWorkspaceStateSync.mockReturnValue({
      channels: [
        {
          name: "general",
          humanMemberNames: ["techwu"],
          humanMembers: 1,
          employeeNames: [],
        },
        {
          name: "secret",
          humanMemberNames: ["Mina"],
          humanMembers: 1,
          employeeNames: [],
        },
      ],
      messages: [
        {
          id: "message-1",
          channel: "secret",
        },
      ],
    });
    mockResolveChannelHumanMemberNames.mockImplementation((_state, channel) => channel.humanMemberNames ?? []);
    mockReadChannelDocumentSync.mockImplementation((documentId: string) => ({
      document: {
        id: documentId,
        channelName: documentId === "doc-secret" ? "secret" : "general",
      },
      currentVersion: { id: "version-1" },
      versions: [],
    }));
    mockCanViewChannelDocumentSync.mockImplementation((documentId: string) => documentId !== "doc-secret");
    mockCanReadChannelForActorSync.mockImplementation(({ channelName }: { channelName?: string }) => channelName === "general");
    mockGetChannelDetailData.mockReturnValue({
      threads: [
        {
          channelName: "general",
          messages: [
            {
              id: "message-general",
              channel: "general",
            },
          ],
        },
      ],
      documents: [],
      documentRuns: [],
      documentConflicts: [],
      channelFiles: [],
      detailScope: ["general"],
    });
  });

  it("rejects members sending messages into channels they do not belong to", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    const formData = new FormData();
    formData.set("channelName", "secret");
    formData.set("content", "hello");

    await expect(sendChannelMessageAction(formData)).rejects.toThrow("Forbidden.");
    expect(mockSendChannelHumanMessageSync).not.toHaveBeenCalled();
  });

  it("allows members to send messages into channels they belong to", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "hello");

    await sendChannelMessageAction(formData);

    expect(mockSendChannelHumanMessageSync).toHaveBeenCalledWith(
      "general",
      "techwu",
      "hello",
      [],
      undefined,
      "workspace-1",
      "user-1",
    );
  });

  it("copies referenced channel files into the outgoing message with a distinct attachment id", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockReadWorkspaceStateSync.mockReturnValue({
      channels: [{ name: "general", kind: "group", humanMemberNames: ["techwu"], humanMembers: 1, employeeNames: ["Atlas"] }],
      messages: [{
        id: "message-source",
        channel: "general",
        attachments: [{
          id: "att-source",
          fileName: "quarterly.csv",
          mediaType: "text/csv",
          sizeBytes: 42,
          kind: "file",
          storedPath: "tos://bucket/quarterly.csv",
          storageKey: "workspaces/workspace-1/attachments/att-source/quarterly.csv",
        }],
      }],
    });

    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "analyze");
    formData.append("attachmentReferences", "att-source");

    await sendChannelMessageAction(formData);

    const attachments = mockSendChannelHumanMessageSync.mock.calls[0]?.[3];
    expect(attachments).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^att-ref-/),
        fileName: "quarterly.csv",
        storedPath: "tos://bucket/quarterly.csv",
      }),
    ]);
    expect(attachments[0]?.id).not.toBe("att-source");
  });

  it("accepts only skills assigned to a channel employee and adds a runtime directive", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockReadWorkspaceStateSync.mockReturnValue({
      channels: [{ name: "general", kind: "group", humanMemberNames: ["techwu"], humanMembers: 1, employeeNames: ["Atlas"] }],
      messages: [],
    });
    mockListEmployeeSkillIdsSync.mockReturnValue(["skill-finance"]);
    mockListWorkspaceSkillsSync.mockReturnValue([{ id: "skill-finance", name: "Finance review" }]);

    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "analyze");
    formData.append("skillReferences", "skill-finance");

    await sendChannelMessageAction(formData);

    expect(mockSendChannelHumanMessageSync).toHaveBeenCalledWith(
      "general",
      "techwu",
      "analyze\n\n[Use assigned skills: Finance review]",
      [],
      undefined,
      "workspace-1",
      "user-1",
    );
  });

  it("turns a group /resume command into a continued task for the selected employee", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockReadWorkspaceStateSync.mockReturnValue({
      channels: [{ name: "general", kind: "group", humanMemberNames: ["techwu"], humanMembers: 1, employeeNames: ["Atlas"] }],
      messages: [],
    });

    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "/resume @Atlas");

    await sendChannelMessageAction(formData);

    expect(mockSendChannelHumanMessageSync).toHaveBeenCalledWith(
      "general",
      "techwu",
      "@Atlas 请继续上一项任务。",
      [],
      undefined,
      "workspace-1",
      "user-1",
    );
  });

  it("validates an admin /model command before persisting its session override", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "/model provider-native-model @Atlas");

    await sendChannelMessageAction(formData);

    expect(mockValidateSessionModelOverrideForChatCommandAsync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channelName: "general",
      humanMemberName: "techwu",
      content: "@Atlas",
      modelId: "provider-native-model",
    });
    expect(mockSetSessionModelOverrideForChatCommandSync).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "catalog-model",
    }));
    expect(mockSendChannelHumanMessageSync).not.toHaveBeenCalled();
  });

  it("rejects a member /model command before it can mutate a session", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    const formData = new FormData();
    formData.set("channelName", "general");
    formData.set("content", "/model provider-native-model @Atlas");

    await expect(sendChannelMessageAction(formData)).rejects.toThrow("Forbidden.");
    expect(mockValidateSessionModelOverrideForChatCommandAsync).not.toHaveBeenCalled();
    expect(mockSetSessionModelOverrideForChatCommandSync).not.toHaveBeenCalled();
  });

  it("loads channel detail data only after channel read access is confirmed", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    const result = await getChannelDetailDataAction({
      channelName: "general",
      workspaceId: "workspace-1",
    });

    expect(mockGetChannelDetailData).toHaveBeenCalledWith({
      channelName: "general",
      currentUserDisplayName: "techwu",
      workspaceId: "workspace-1",
      currentUserId: "user-1",
      currentMembershipRole: "member",
    });
    expect(result.threads.map((thread) => thread.channelName)).toEqual(["general"]);
    expect(result.threads.flatMap((thread) => thread.messages).map((message) => message.id)).toEqual(["message-general"]);
    expect(result.detailScope).toEqual(["general"]);
  });

  it("rejects channel detail loads when the actor cannot access the channel", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(getChannelDetailDataAction({
      channelName: "secret",
      workspaceId: "workspace-1",
    })).rejects.toThrow("Forbidden.");

    expect(mockGetChannelDetailData).not.toHaveBeenCalled();
  });

  it("deletes channel attachments through the service and revalidates channel routes", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await deleteChannelAttachmentAction({
      channelName: "general",
      attachmentId: "att-1",
    });

    expect(mockDeleteChannelAttachmentSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channelName: "general",
      attachmentId: "att-1",
      actorUserId: "user-1",
      actorDisplayName: "techwu",
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/inbox", "/agents", "/contacts"]);
  });

  it("rejects attachment deletion when the actor cannot access the channel", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(deleteChannelAttachmentAction({
      channelName: "secret",
      attachmentId: "att-1",
    })).rejects.toThrow("Forbidden.");

    expect(mockDeleteChannelAttachmentSync).not.toHaveBeenCalled();
  });

  it("sends human direct messages as the current workspace user", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    const formData = new FormData();
    formData.set("targetUserId", "user-2");
    formData.set("content", "hello Mina");

    await sendHumanDirectMessageAction(formData);

    expect(mockSendHumanDirectMessageSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      actorUserId: "user-1",
      targetUserId: "user-2",
      content: "hello Mina",
      attachments: [],
      replyToMessageId: undefined,
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/contacts", "/im", "/inbox"]);
  });

  it("adds existing workspace members to a channel as the current actor", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await addWorkspaceMembersToChannelAction({
      channelName: "general",
      userIds: ["user-2", "user-2", " user-3 "],
    });

    expect(mockAddWorkspaceMemberToChannelForActorSync).toHaveBeenCalledTimes(2);
    expect(mockAddWorkspaceMemberToChannelForActorSync).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      channelName: "general",
      targetUserId: "user-2",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "admin",
      },
    });
    expect(mockAddWorkspaceMemberToChannelForActorSync).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      channelName: "general",
      targetUserId: "user-3",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "admin",
      },
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/settings/permissions"]);
  });

  it("reviews inline runtime approvals as admins", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    const result = await reviewInlineApprovalAction("approval-1", "approved");

    expect(mockReviewApprovalWithWorkflowSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      approvalId: "approval-1",
      decision: "approved",
      actorUserId: "user-1",
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/approvals", "/inbox", "/agents"]);
    expect(result.invalidation).toEqual({
      workspaceId: "workspace-1",
      modules: ["im", "approvals", "inbox", "agents"],
      resources: [{ type: "approval", id: "approval-1" }],
      shell: "counters",
    });
  });

  it("adds selected digital contacts to a channel as agents", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await addWorkspaceMembersToChannelAction({
      channelName: "general",
      userIds: [],
      agentIds: ["Atlas", "Atlas", " Vega "],
    });

    expect(mockAssertCanUseEmployeeForActorSync).toHaveBeenCalledTimes(2);
    expect(mockAssertCanUseEmployeeForActorSync).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      employeeName: "Atlas",
      actorUserId: "user-1",
    });
    expect(mockAssertCanUseEmployeeForActorSync).toHaveBeenNthCalledWith(2, {
      workspaceId: "workspace-1",
      employeeName: "Vega",
      actorUserId: "user-1",
    });
    expect(mockAddChannelEmployeesSync).toHaveBeenCalledWith({
      channelName: "general",
      employeeNames: ["Atlas", "Vega"],
    }, "workspace-1");
    expect(mockAddWorkspaceMemberToChannelForActorSync).not.toHaveBeenCalled();
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/settings/permissions"]);
  });

  it("uses the route workspace when adding members from a different selected workspace", async () => {
    const selectedContext = buildWorkspaceContext("admin", {
      workspaceId: "personal-workspace",
      workspaceSlug: "personal",
    });
    const routeContext = buildWorkspaceContext("admin", {
      workspaceId: "workspace-1",
      workspaceSlug: "workspace-1",
    });
    mockRequireCurrentWorkspaceContext.mockResolvedValue(selectedContext);
    mockResolveWorkspaceAccessForIdentifierSync.mockReturnValue({
      status: "ok",
      context: routeContext,
    });

    await addWorkspaceMembersToChannelAction({
      channelName: "general",
      workspaceId: "workspace-1",
      userIds: ["user-2"],
    });

    expect(mockResolveWorkspaceAccessForIdentifierSync).toHaveBeenCalledWith(
      selectedContext.currentUser,
      "workspace-1",
    );
    expect(mockAddWorkspaceMemberToChannelForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channelName: "general",
      targetUserId: "user-2",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "admin",
      },
    });
  });

  it("uses the route workspace when requesting channel access from a different selected workspace", async () => {
    const selectedContext = buildWorkspaceContext("member", {
      workspaceId: "personal-workspace",
      workspaceSlug: "personal",
    });
    const routeContext = buildWorkspaceContext("member", {
      workspaceId: "workspace-1",
      workspaceSlug: "workspace-1",
    });
    mockRequireCurrentWorkspaceContext.mockResolvedValue(selectedContext);
    mockResolveWorkspaceAccessForIdentifierSync.mockReturnValue({
      status: "ok",
      context: routeContext,
    });

    await requestChannelAccessAction("general", "workspace-1");

    expect(mockRequestChannelAccessForActorSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      channelName: "general",
      actor: {
        userId: "user-1",
        displayName: "techwu",
        role: "member",
      },
    });
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/approvals", "/settings/permissions", "/inbox"]);
  });

  it("rejects members deleting channels", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(deleteChannelAction("general")).rejects.toThrow("Forbidden.");
    expect(mockDeleteChannelSync).not.toHaveBeenCalled();
  });

  it("rejects a channel member stopping a linked workflow task they do not manage", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockReadQueuedTaskSync.mockReturnValue(workflowTask());
    mockReadWorkflowNodeRunByTaskQueueIdSync.mockReturnValue({ id: "node-run-1", runId: "run-1" });
    mockReadWorkflowRunSync.mockReturnValue({ id: "run-1", workflowId: "workflow-1" });
    mockReadWorkflowDefinitionSync.mockReturnValue({ id: "workflow-1", ownerUserId: "another-user" });

    await expect(stopChannelTaskAction("queue-1")).rejects.toThrow("Only the workflow owner or a workspace administrator");

    expect(mockCancelQueuedTaskSync).not.toHaveBeenCalled();
    expect(mockCancelWorkflowRunSync).not.toHaveBeenCalled();
  });

  it("stops a linked workflow task through Run-level cancellation", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));
    mockReadQueuedTaskSync.mockReturnValue(workflowTask());
    mockReadWorkflowNodeRunByTaskQueueIdSync.mockReturnValue({ id: "node-run-1", runId: "run-1" });
    mockReadWorkflowRunSync.mockReturnValue({ id: "run-1", workflowId: "workflow-1" });
    mockReadWorkflowDefinitionSync.mockReturnValue({ id: "workflow-1", ownerUserId: "another-user" });

    await stopChannelTaskAction("queue-1");

    expect(mockCancelWorkflowRunSync).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      runId: "run-1",
      actorUserId: "user-1",
    }));
    expect(mockCancelQueuedTaskSync).not.toHaveBeenCalled();
    expect(mockReplacePendingChannelMessageSync).toHaveBeenCalled();
  });

  it("allows members to rename channels they can access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await renameChannelAction({ channelName: "general", nextName: "ops" });

    expect(mockRenameChannelSync).toHaveBeenCalledWith("general", "ops", "workspace-1");
    expect(mockRevalidateWorkspacePaths).toHaveBeenCalledWith("workspace-1", ["/im", "/inbox", "/agents"]);
  });

  it("rejects members renaming channels they cannot access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(renameChannelAction({ channelName: "secret", nextName: "ops" })).rejects.toThrow("Forbidden.");
    expect(mockRenameChannelSync).not.toHaveBeenCalled();
  });

  it("rejects pinning messages from channels the current user cannot access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(pinMessageAction("message-1")).rejects.toThrow("Forbidden.");
    expect(mockPinMessageSync).not.toHaveBeenCalled();
  });

  it("allows members to acknowledge messages in channels they can access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));
    mockReadWorkspaceStateSync.mockReturnValue({
      channels: [
        {
          name: "general",
          humanMemberNames: ["techwu"],
          humanMembers: 1,
          employeeNames: [],
        },
      ],
      messages: [
        {
          id: "message-general",
          channel: "general",
        },
      ],
    });

    await acknowledgeMessageAction("message-general");

    expect(mockAcknowledgeMessageSync).toHaveBeenCalledWith(
      "message-general",
      "workspace-1",
      "techwu",
      "user-1",
    );
  });

  it("rejects acknowledging messages from channels the current user cannot access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(acknowledgeMessageAction("message-1")).rejects.toThrow("Forbidden.");
    expect(mockAcknowledgeMessageSync).not.toHaveBeenCalled();
  });

  it("rejects saving channel documents for channels the current user cannot access", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(saveChannelDocumentAction({
      documentId: "doc-secret",
      channelName: "secret",
      title: "Secret doc",
      contentMarkdown: "hidden",
    })).rejects.toThrow("Forbidden.");
  });

});

function buildWorkspaceContext(
  role: "owner" | "admin" | "member",
  options: { workspaceId?: string; workspaceSlug?: string } = {},
) {
  const workspaceId = options.workspaceId ?? "workspace-1";
  const workspaceSlug = options.workspaceSlug ?? workspaceId;
  return {
    currentUser: {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "techwu",
      role: "owner",
      email: "techwu@example.com",
    },
    currentWorkspace: {
      id: workspaceId,
      slug: workspaceSlug,
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId,
      userId: "user-1",
      role,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
    accessScope: "workspace" as const,
  };
}

function workflowTask() {
  return {
    id: "queue-1",
    workspaceId: "workspace-1",
    agentId: "Atlas",
    status: "running",
    inputJson: JSON.stringify({ channelName: "general" }),
  };
}
