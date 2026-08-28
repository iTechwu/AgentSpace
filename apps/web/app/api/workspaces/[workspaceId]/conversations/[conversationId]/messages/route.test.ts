import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetCurrentWorkspaceContext,
  mockListTaskMessagesForTasksSync,
  mockReadConversationForUserSync,
  mockReadWorkspaceStateSync,
} = vi.hoisted(() => ({
  mockGetCurrentWorkspaceContext: vi.fn(),
  mockListTaskMessagesForTasksSync: vi.fn(),
  mockReadConversationForUserSync: vi.fn(),
  mockReadWorkspaceStateSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

vi.mock("@dofe-agent/db", () => ({
  listConversationParticipantsSync: vi.fn(),
  listTaskMessagesForTasksSync: mockListTaskMessagesForTasksSync,
  readConversationSync: vi.fn(),
  readStoredChannelSync: vi.fn(),
  readStoredEmployeeByIdSync: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  readConversationForUserSync: mockReadConversationForUserSync,
  recordConversationMessageActivitySync: vi.fn(),
  resolveConversationLaneForSendSync: vi.fn(),
  readWorkspaceStateSync: mockReadWorkspaceStateSync,
  sendContactMessageForHumanWithAttachmentsSync: vi.fn(),
  sendChannelHumanMessageSync: vi.fn(),
}));

vi.mock("@/features/chat/attachment-actions", () => ({
  persistFormAttachments: vi.fn(),
}));

vi.mock("@/features/chat/message-composition", () => ({
  appendReferencedSkillDirective: vi.fn(),
  mergeMessageAttachments: vi.fn(),
  resolveReferencedAttachments: vi.fn(),
  resolveResumeCommand: vi.fn(),
}));

import { GET } from "./route";

describe("conversation messages route", () => {
  beforeEach(() => {
    mockGetCurrentWorkspaceContext.mockReset();
    mockListTaskMessagesForTasksSync.mockReset();
    mockReadConversationForUserSync.mockReset();
    mockReadWorkspaceStateSync.mockReset();
    mockGetCurrentWorkspaceContext.mockResolvedValue({
      currentUser: { id: "user-1", displayName: "User", email: "user@example.com" },
      currentWorkspace: { id: "workspace-1" },
    });
    mockReadConversationForUserSync.mockReturnValue({ id: "conversation-1", kind: "direct" });
    mockReadWorkspaceStateSync.mockReturnValue({
      messages: [{
        id: "message-1",
        conversationId: "conversation-1",
        channel: "contact:Atlas",
        speaker: "Atlas",
        role: "agent",
        summary: "reply",
        time: "2026-08-25T10:00:00.000Z",
        data: { source_task_queue_id: "task-1" },
      }],
    });
    mockListTaskMessagesForTasksSync.mockReturnValue(new Map([
      ["task-1", [
        { id: "tm-1", taskId: "task-1", seq: 1, type: "text", content: "first", createdAt: "2026-08-25T10:00:00.000Z" },
        { id: "tm-2", taskId: "task-1", seq: 2, type: "text", content: "second", createdAt: "2026-08-25T10:00:01.000Z" },
      ]],
    ]));
  });

  it("returns durable task streams and task-local sequence cursors", async () => {
    const response = await GET(new Request("http://localhost/messages"), {
      params: Promise.resolve({ workspaceId: "workspace-1", conversationId: "conversation-1" }),
    });

    const body = await response.json();
    expect(response.status, body.error).toBe(200);
    expect(body.lastSeqByTask).toEqual({ "task-1": 2 });
    expect(body.taskExecutions["task-1"].map((message: { id: string }) => message.id)).toEqual(["tm-1", "tm-2"]);
  });

  it("returns only newer rows for a task-local afterSeq request", async () => {
    const response = await GET(new Request("http://localhost/messages?taskId=task-1&afterSeq=1"), {
      params: Promise.resolve({ workspaceId: "workspace-1", conversationId: "conversation-1" }),
    });

    const body = await response.json();
    expect(body.lastSeqByTask).toEqual({ "task-1": 2 });
    expect(body.taskExecutions["task-1"].map((message: { id: string }) => message.id)).toEqual(["tm-2"]);
  });

  it("rejects a task cursor that does not belong to the conversation", async () => {
    const response = await GET(new Request("http://localhost/messages?taskId=task-other&afterSeq=1"), {
      params: Promise.resolve({ workspaceId: "workspace-1", conversationId: "conversation-1" }),
    });

    expect(response.status).toBe(400);
  });
});
