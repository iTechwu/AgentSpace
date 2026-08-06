import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(),
  readDefinition: vi.fn(),
  readRun: vi.fn(),
  updateDraft: vi.fn(),
  manualRun: vi.fn(),
  publish: vi.fn(),
  readTrigger: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({ requireCurrentWorkspaceContext: mocks.requireContext }));
vi.mock("@/features/auth/workspace-revalidation", () => ({ revalidateWorkspacePaths: mocks.revalidate }));
vi.mock("@dofe-agent/db", () => ({
  createWorkflowDefinitionSync: vi.fn(),
  readWorkflowDefinitionSync: mocks.readDefinition,
  readWorkflowRunSync: mocks.readRun,
  readWorkflowTriggerForWorkflowSync: mocks.readTrigger,
  updateWorkflowDraftSync: mocks.updateDraft,
}));
vi.mock("@dofe-agent/services", () => ({
  assertTriggerWriteOwnerSync: vi.fn(),
  cancelWorkflowRunSync: vi.fn(),
  materializeManualWorkflowRunSync: mocks.manualRun,
  pauseWorkflowRunSync: vi.fn(),
  publishWorkflowSync: mocks.publish,
  resumeWorkflowRunSync: vi.fn(),
  retryWorkflowNodeSync: vi.fn(),
  validateWorkflowForPublishSync: vi.fn(),
}));

import { controlWorkflowRunAction, publishWorkflowAction, runWorkflowAction, updateWorkflowDraftAction } from "./workflow-actions";

const graph = {
  schemaVersion: 1 as const,
  nodes: [{ id: "a", type: "employee_task" as const, employeeId: "emp-a", config: {} }],
  edges: [],
};

function mockContext(role: "owner" | "admin" | "member") {
  mocks.requireContext.mockResolvedValue({
    currentWorkspace: { id: "workspace-1", slug: "default" },
    currentUser: { id: "user-1", displayName: "User" },
    currentMembership: { role },
  });
}

describe("workflow actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDefinition.mockReturnValue({
      id: "wf-1",
      workspaceId: "workspace-1",
      ownerUserId: "user-1",
      status: "published",
      draftVersion: 2,
      draftGraphJson: JSON.stringify(graph),
    });
    mocks.manualRun.mockReturnValue({ runId: "run-1", created: true });
    mocks.readRun.mockReturnValue({ id: "run-1", workflowId: "wf-1", status: "running" });
    mocks.readTrigger.mockReturnValue(null);
    mocks.publish.mockReturnValue({ version: { id: "version-1" } });
  });

  it("requires admin to publish but lets members run published workflows", async () => {
    mockContext("member");
    await expect(publishWorkflowAction({ workflowId: "wf-1", expectedDraftVersion: 2 })).rejects.toThrow(/workspace role/i);
    await expect(runWorkflowAction({ workflowId: "wf-1", idempotencyKey: "manual:u1:1", input: {} }))
      .resolves.toMatchObject({ ok: true, data: { runId: "run-1" } });
  });

  it("returns a stable conflict code for stale drafts", async () => {
    mockContext("admin");
    mocks.updateDraft.mockImplementation(() => { throw new Error("workflow_draft_version_conflict"); });
    const result = await updateWorkflowDraftAction({
      workflowId: "wf-1",
      expectedDraftVersion: 1,
      patch: { name: "Changed" },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "workflow_version_conflict" } });
  });

  it("never forwards an untrusted draft owner reassignment", async () => {
    mockContext("member");
    mocks.updateDraft.mockReturnValue({ draftVersion: 3, draftGraphJson: JSON.stringify(graph) });

    const result = await updateWorkflowDraftAction({
      workflowId: "wf-1",
      expectedDraftVersion: 2,
      patch: { name: "Changed", ownerUserId: "attacker-selected-owner" },
    } as never);

    expect(result).toMatchObject({ ok: true });
    expect(mocks.updateDraft).toHaveBeenCalledWith(expect.not.objectContaining({ ownerUserId: expect.anything() }));
  });

  it("prevents members from editing or controlling another owner's workflow", async () => {
    mockContext("member");
    mocks.readDefinition.mockReturnValue({
      id: "wf-1",
      workspaceId: "workspace-1",
      ownerUserId: "user-2",
      status: "published",
      draftVersion: 2,
      draftGraphJson: JSON.stringify(graph),
    });

    const update = await updateWorkflowDraftAction({
      workflowId: "wf-1",
      expectedDraftVersion: 2,
      patch: { name: "Unauthorized" },
    });
    const control = await controlWorkflowRunAction({ runId: "run-1", action: "cancel" });

    expect(update).toMatchObject({ ok: false, error: { code: "workflow_actor_forbidden" } });
    expect(control).toMatchObject({ ok: false, error: { code: "workflow_actor_forbidden" } });
    expect(mocks.updateDraft).not.toHaveBeenCalled();
  });

  it("reuses the current trigger when republishing", async () => {
    mockContext("admin");
    mocks.readTrigger.mockReturnValue({ id: "trigger-1" });

    const result = await publishWorkflowAction({
      workflowId: "wf-1",
      expectedDraftVersion: 2,
      trigger: { type: "schedule", config: { cron: "0 9 * * 1-5" }, timezone: "Asia/Shanghai" },
    });

    expect(result).toMatchObject({ ok: true, data: { versionId: "version-1" } });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({
      trigger: expect.objectContaining({ id: "trigger-1", type: "schedule" }),
    }));
  });
});
