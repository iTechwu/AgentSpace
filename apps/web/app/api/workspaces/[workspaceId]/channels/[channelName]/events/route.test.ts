import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRealtimeEvent } from "@dofe-agent/services";

const {
  mockCanReadChannelForActorSync,
  mockGetWorkspaceAccessForIdentifier,
  mockListOpenMontageChannelProjectionVersionsSync,
  mockReadWorkspaceStateSnapshotSync,
  mockSubscribeWorkspaceRealtimeEvents,
} = vi.hoisted(() => ({
  mockCanReadChannelForActorSync: vi.fn(),
  mockGetWorkspaceAccessForIdentifier: vi.fn(),
  mockListOpenMontageChannelProjectionVersionsSync: vi.fn(),
  mockReadWorkspaceStateSnapshotSync: vi.fn(),
  mockSubscribeWorkspaceRealtimeEvents: vi.fn(),
}));

vi.mock("@dofe-agent/services", () => ({
  canReadChannelForActorSync: mockCanReadChannelForActorSync,
  listOpenMontageChannelProjectionVersionsSync: mockListOpenMontageChannelProjectionVersionsSync,
  readWorkspaceStateSnapshotSync: mockReadWorkspaceStateSnapshotSync,
  subscribeWorkspaceRealtimeEvents: mockSubscribeWorkspaceRealtimeEvents,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceAccessForIdentifier: mockGetWorkspaceAccessForIdentifier,
}));

import { GET } from "./route";

describe("channel realtime events route", () => {
  beforeEach(() => {
    mockCanReadChannelForActorSync.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockReset();
    mockListOpenMontageChannelProjectionVersionsSync.mockReset();
    mockReadWorkspaceStateSnapshotSync.mockReset();
    mockSubscribeWorkspaceRealtimeEvents.mockReset();
    mockCanReadChannelForActorSync.mockReturnValue(true);
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({
      status: "ok",
      context: buildWorkspaceContext(),
    });
    mockReadWorkspaceStateSnapshotSync.mockReturnValue({ messages: [] });
    mockListOpenMontageChannelProjectionVersionsSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects unauthenticated requests", async () => {
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({ status: "unauthenticated" });

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "general" }),
    });

    expect(response.status).toBe(401);
    expect(mockSubscribeWorkspaceRealtimeEvents).not.toHaveBeenCalled();
  });

  it("rejects requests without channel read access", async () => {
    mockCanReadChannelForActorSync.mockReturnValue(false);

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "secret" }),
    });

    expect(response.status).toBe(403);
    expect(mockSubscribeWorkspaceRealtimeEvents).not.toHaveBeenCalled();
  });

  it("streams matching channel events without leaking other channels", async () => {
    let listener: ((event: WorkspaceRealtimeEvent) => void) | null = null;
    mockSubscribeWorkspaceRealtimeEvents.mockImplementation((_workspaceId, nextListener) => {
      listener = nextListener;
      return vi.fn();
    });

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "general" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const retryChunk = await reader.read();
    expect(decoder.decode(retryChunk.value)).toContain("retry: 2000");

    expect(listener).not.toBeNull();
    const emit = listener!;
    emit({
      type: "channel.message.created",
      workspaceId: "workspace-1",
      channelName: "other",
      messageId: "message-hidden",
      sequence: 1,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    emit({
      type: "channel.message.created",
      workspaceId: "workspace-1",
      channelName: "general",
      messageId: "message-visible",
      sequence: 2,
      createdAt: "2026-05-01T00:00:01.000Z",
    });

    const eventChunk = await reader.read();
    const eventText = decoder.decode(eventChunk.value);
    expect(eventText).toContain("event: channel.message.created");
    expect(eventText).toContain("message-visible");
    expect(eventText).not.toContain("message-hidden");
    await reader.cancel();
  });

  it("streams OpenMontage invalidation metadata without a full Job payload", async () => {
    let listener: ((event: WorkspaceRealtimeEvent) => void) | null = null;
    mockSubscribeWorkspaceRealtimeEvents.mockImplementation((_workspaceId, nextListener) => {
      listener = nextListener;
      return vi.fn();
    });

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "general" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    listener!({
      type: "openmontage.job.changed",
      workspaceId: "workspace-1",
      channelName: "general",
      jobId: "om_job_1",
      lastAppliedSequence: 7,
      sequence: 3,
      changedAt: "2026-08-05T10:00:07Z",
    });

    const chunk = decoder.decode((await reader.read()).value);
    expect(chunk).toContain("event: openmontage.job.changed");
    expect(chunk).toContain('"jobId":"om_job_1"');
    expect(chunk).toContain('"lastAppliedSequence":7');
    expect(chunk).not.toContain("payload");
    await reader.cancel();
  });

  it("notifies the client when shared persisted state changes without an in-process event", async () => {
    vi.useFakeTimers();
    let snapshot = {
      messages: [{
        id: "pending-1",
        channel: "general",
        status: "pending",
        time: "2026-05-01T00:00:00.000Z",
        summary: "Thinking",
      }],
    };
    mockReadWorkspaceStateSnapshotSync.mockImplementation(() => snapshot);

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "general" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    snapshot = {
      messages: [{
        ...snapshot.messages[0],
        status: "completed",
        summary: "已完成回复。",
      }],
    };
    await vi.advanceTimersByTimeAsync(750);

    const eventChunk = await reader.read();
    const eventText = decoder.decode(eventChunk.value);
    expect(eventText).toContain("event: channel.thread.changed");
    expect(eventText).toContain('"source":"persisted_state"');
    await reader.cancel();
  });

  it("recovers OpenMontage invalidations from persisted projections across web processes", async () => {
    vi.useFakeTimers();
    let versions = [{
      jobId: "om_job_1",
      lastAppliedSequence: 1,
      changedAt: "2026-08-05T10:00:01Z",
    }];
    mockListOpenMontageChannelProjectionVersionsSync.mockImplementation(() => versions);

    const response = await GET(new Request("http://localhost/events"), {
      params: Promise.resolve({ workspaceId: "workspace-1", channelName: "general" }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    versions = [{
      jobId: "om_job_1",
      lastAppliedSequence: 2,
      changedAt: "2026-08-05T10:00:02Z",
    }];
    await vi.advanceTimersByTimeAsync(750);

    const chunk = decoder.decode((await reader.read()).value);
    expect(chunk).toContain("event: openmontage.job.changed");
    expect(chunk).toContain('"lastAppliedSequence":2');
    expect(chunk).toContain('"source":"persisted_projection"');
    await reader.cancel();
  });
});

function buildWorkspaceContext() {
  return {
    currentUser: {
      id: "user-1",
      displayName: "techwu",
      email: "techwu@example.com",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-1",
      name: "Northstar Labs",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "member",
      status: "active",
      joinedAt: "2026-01-01T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
    accessScope: "workspace",
  };
}
