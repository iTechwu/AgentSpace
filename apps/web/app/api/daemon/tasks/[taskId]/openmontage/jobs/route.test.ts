import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateJobLink,
  mockReadAuthorization,
  mockReadTaskForDaemon,
  mockRequireDaemonAuth,
} = vi.hoisted(() => ({
  mockCreateJobLink: vi.fn(),
  mockReadAuthorization: vi.fn(),
  mockReadTaskForDaemon: vi.fn(),
  mockRequireDaemonAuth: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  createOpenMontageJobLinkSync: mockCreateJobLink,
  OpenMontageJobBindingError: class OpenMontageJobBindingError extends Error {},
  readMcpTaskAuditAuthorizationSync: mockReadAuthorization,
}));

vi.mock("../../../../_lib/auth", () => ({
  readTaskForDaemon: mockReadTaskForDaemon,
  requireDaemonAuth: mockRequireDaemonAuth,
}));

import { POST } from "./route";

describe("daemon OpenMontage Job report route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireDaemonAuth.mockReturnValue({ workspaceId: "ws-1" });
    mockReadTaskForDaemon.mockReturnValue({
      id: "task-1",
      workspaceId: "ws-1",
      employeeId: "employee-1",
      agentId: "legacy-agent",
      runtimeId: "runtime-1",
      routerSessionId: "conversation-1",
      status: "running",
      inputJson: JSON.stringify({ channelName: "direct:employee-1" }),
    });
    mockReadAuthorization.mockReturnValue({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authorizationJson: JSON.stringify({
        connections: [{
          connectionId: "connection-1",
          catalogItemSlug: "official-openmontage",
          approvedTools: ["submit_video_job"],
        }],
      }),
    });
    mockCreateJobLink.mockImplementation((input) => ({
      jobId: input.snapshot.jobId,
      sourceInvocationId: input.sourceInvocationId,
    }));
  });

  it("creates an immutable chat-bound Job Link from trusted task attribution", async () => {
    const response = await post(submittedJob());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ jobId: "om_job_1" });
    expect(mockCreateJobLink).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1",
      employeeId: "employee-1",
      runtimeId: "runtime-1",
      rootTaskId: "task-1",
      conversationId: "conversation-1",
      sourceInvocationId: "invocation-1",
      traceId: "task-1",
      channelName: "direct:employee-1",
    }));
  });

  it("rejects a snapshot whose OpenMontage attribution differs from the task", async () => {
    const snapshot = submittedJob();
    snapshot.attribution.employeeId = "forged-employee";

    const response = await post(snapshot);

    expect(response.status).toBe(422);
    expect(mockCreateJobLink).not.toHaveBeenCalled();
  });

  it("rejects reports from connections not authorized for the official submit tool", async () => {
    mockReadAuthorization.mockReturnValue({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      authorizationJson: JSON.stringify({
        connections: [{
          connectionId: "connection-1",
          catalogItemSlug: "workspace-video-tool",
          approvedTools: ["submit_video_job"],
        }],
      }),
    });

    const response = await post(submittedJob());

    expect(response.status).toBe(422);
    expect(mockCreateJobLink).not.toHaveBeenCalled();
  });
});

function post(snapshot: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/daemon/tasks/task-1/openmontage/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "connection-1", snapshot }),
    }),
    { params: Promise.resolve({ taskId: "task-1" }) },
  );
}

function submittedJob() {
  return {
    schemaVersion: 1,
    jobId: "om_job_1",
    status: "QUEUED",
    workflow: {
      name: "animated-explainer",
      version: "2.0",
      stages: [{ code: "research", labelCode: "openmontage.stage.research", approvalRequired: false }],
    },
    attribution: {
      workspaceId: "ws-1",
      employeeId: "employee-1",
      runtimeId: "runtime-1",
      rootTaskId: "task-1",
      conversationId: "conversation-1",
      sourceInvocationId: "invocation-1",
      traceId: "task-1",
    },
    request: {
      schemaVersion: 1,
      clientRequestId: "client-request-1",
      workflow: "animated-explainer",
      input: {},
      brief: {},
      output: {},
      budget: {},
    },
    stages: [{
      code: "research",
      labelCode: "openmontage.stage.research",
      approvalRequired: false,
      approvalStatus: "NOT_REQUIRED",
      status: "PENDING",
      attempt: 0,
    }],
    lastSequence: 1,
    createdAt: "2026-08-05T10:00:01Z",
    updatedAt: "2026-08-05T10:00:01Z",
  };
}
