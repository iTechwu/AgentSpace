import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  MockOpenMontageJobActionError,
  mockCallAction,
  mockCanWriteChannel,
  mockGetWorkspaceAccessForIdentifier,
  mockReadBinding,
  mockRecordAudit,
} = vi.hoisted(() => ({
  MockOpenMontageJobActionError: class OpenMontageJobActionError extends Error {
    downstreamStatus: number;
    downstreamCode?: string;
    traceId?: string;

    constructor(downstreamStatus: number, downstreamCode?: string, traceId?: string) {
      super("safe downstream failure");
      this.downstreamStatus = downstreamStatus;
      this.downstreamCode = downstreamCode;
      this.traceId = traceId;
    }
  },
  mockCallAction: vi.fn(),
  mockCanWriteChannel: vi.fn(),
  mockGetWorkspaceAccessForIdentifier: vi.fn(),
  mockReadBinding: vi.fn(),
  mockRecordAudit: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getWorkspaceAccessForIdentifier: mockGetWorkspaceAccessForIdentifier,
}));

vi.mock("@dofe-agent/db", () => ({
  readOpenMontageChatBindingSync: mockReadBinding,
  recordAuditLogSync: mockRecordAudit,
}));

vi.mock("@dofe-agent/services", () => ({
  OpenMontageJobActionError: MockOpenMontageJobActionError,
  callOpenMontageJobActionAsync: mockCallAction,
  canWriteChannelForActorSync: mockCanWriteChannel,
}));

import { POST } from "./route";

describe("OpenMontage Job actions route", () => {
  beforeEach(() => {
    mockCallAction.mockReset();
    mockCanWriteChannel.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockReset();
    mockReadBinding.mockReset();
    mockRecordAudit.mockReset();
    mockGetWorkspaceAccessForIdentifier.mockResolvedValue({ status: "ok", context: workspaceContext() });
    mockReadBinding.mockReturnValue({ workspaceId: "workspace-1", jobId: "om_job_1", channelName: "video team" });
    mockCanWriteChannel.mockReturnValue(true);
    mockCallAction.mockResolvedValue({ accepted: true });
  });

  it("submits a sequence-fenced approval and records the actor audit", async () => {
    const response = await POST(request({ action: "approve", stage: "proposal", expectedSequence: 4 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(202);
    expect(mockCallAction).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "om_job_1",
      action: "approve",
      stage: "proposal",
      expectedSequence: 4,
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      code: "openmontage_job_action_accepted",
      data: expect.objectContaining({ actorUserId: "user-1", jobId: "om_job_1", action: "approve" }),
    }));
  });

  it("rejects actors without channel write access and audits the denial", async () => {
    mockCanWriteChannel.mockReturnValue(false);

    const response = await POST(request({ action: "cancel", expectedSequence: 4 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(403);
    expect(mockCallAction).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      code: "openmontage_job_action_denied",
    }));
  });

  it("maps a stale projection to conflict without exposing internal details", async () => {
    mockCallAction.mockRejectedValue(new Error("OpenMontage Job changed since the action was requested. Refresh and try again."));

    const response = await POST(request({ action: "cancel", expectedSequence: 3 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "openmontage_job_changed",
      message: "The video job changed. Refresh and try again.",
    });
  });

  it("maps a downstream conflict and records its safe diagnostics in the audit", async () => {
    mockCallAction.mockRejectedValue(new MockOpenMontageJobActionError(
      409,
      "OPENMONTAGE_JOB_CONFLICT",
      "om-trace-409",
    ));

    const response = await POST(request({ action: "cancel", expectedSequence: 4 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "openmontage_job_action_conflict",
      message: "This action is no longer available.",
    });
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({
      code: "openmontage_job_action_failed",
      data: expect.objectContaining({
        downstreamStatus: 409,
        downstreamCode: "OPENMONTAGE_JOB_CONFLICT",
        traceId: "om-trace-409",
      }),
    }));
  });

  it("validates the action contract before calling OpenMontage", async () => {
    const response = await POST(request({ action: "approve", expectedSequence: 4 }), {
      params: Promise.resolve({ workspaceId: "workspace-1", jobId: "om_job_1" }),
    });

    expect(response.status).toBe(400);
    expect(mockCallAction).not.toHaveBeenCalled();
  });
});

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workspaceContext() {
  return {
    currentUser: { id: "user-1", displayName: "Tech Wu" },
    currentWorkspace: { id: "workspace-1", slug: "workspace-1", name: "Workspace" },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role: "member",
      status: "active",
      joinedAt: "2026-01-01T00:00:00Z",
    },
    memberships: [],
    workspaces: [],
    accessScope: "workspace",
  };
}
