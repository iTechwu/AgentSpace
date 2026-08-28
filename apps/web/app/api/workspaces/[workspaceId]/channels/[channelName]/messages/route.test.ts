import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCanReadChannelForActorSync,
  mockGetWorkspaceAccessForIdentifier,
  mockListTaskMessagesForTasksSync,
  mockReadWorkspaceStateSnapshotSync,
} = vi.hoisted(() => ({
  mockCanReadChannelForActorSync: vi.fn(),
  mockGetWorkspaceAccessForIdentifier: vi.fn(),
  mockListTaskMessagesForTasksSync: vi.fn(),
  mockReadWorkspaceStateSnapshotSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceAccessForIdentifier: mockGetWorkspaceAccessForIdentifier,
}));

vi.mock("@dofe-agent/db", () => ({
  listTaskMessagesForTasksSync: mockListTaskMessagesForTasksSync,
}));

vi.mock("@dofe-agent/services", () => ({
  canReadChannelForActorSync: mockCanReadChannelForActorSync,
  readWorkspaceStateSnapshotSync: mockReadWorkspaceStateSnapshotSync,
}));

import { GET } from "./route";

describe("channel task messages route", () => {
  beforeEach(() => {
    mockCanReadChannelForActorSync.mockReset().mockReturnValue(true);
    mockGetWorkspaceAccessForIdentifier.mockReset().mockResolvedValue({
      status: "ok",
      context: {
        currentUser: { id: "user-1", displayName: "User" },
        currentWorkspace: { id: "workspace-1" },
        currentMembership: { role: "member" },
      },
    });
    mockReadWorkspaceStateSnapshotSync.mockReset().mockReturnValue({
      messages: [{
        id: "reply-1",
        channel: "tour visit",
        speaker: "Atlas",
        role: "agent",
        summary: "处理中",
        time: "2026-08-25T10:00:00.000Z",
        status: "pending",
        data: { source_task_queue_id: "task-1" },
      }],
    });
    mockListTaskMessagesForTasksSync.mockReset().mockReturnValue(new Map([
      ["task-1", [
        { id: "tm-1", taskId: "task-1", seq: 1, type: "text", content: "first", createdAt: "2026-08-25T10:00:00.000Z" },
        { id: "tm-2", taskId: "task-1", seq: 2, type: "text", content: "second", createdAt: "2026-08-25T10:00:01.000Z" },
      ]],
    ]));
  });

  it("returns newer task rows for an authorized unscoped channel task", async () => {
    const response = await GET(new Request("http://localhost/messages?taskId=task-1&afterSeq=1"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "tour visit" }),
    });

    const body = await response.json();
    expect(response.status, body.error).toBe(200);
    expect(body.messages).toHaveLength(1);
    expect(body.taskExecutions["task-1"].map((row: { id: string }) => row.id)).toEqual(["tm-2"]);
    expect(body.lastSeqByTask).toEqual({ "task-1": 2 });
  });

  it("rejects a task that is not bound to the readable channel", async () => {
    const response = await GET(new Request("http://localhost/messages?taskId=task-other&afterSeq=0"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "tour visit" }),
    });

    expect(response.status).toBe(400);
    expect(mockListTaskMessagesForTasksSync).not.toHaveBeenCalled();
  });
});
