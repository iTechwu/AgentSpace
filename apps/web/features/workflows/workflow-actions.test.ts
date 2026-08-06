import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(),
  readDefinition: vi.fn(),
  updateDraft: vi.fn(),
  manualRun: vi.fn(),
  publish: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({ requireCurrentWorkspaceContext: mocks.requireContext }));
vi.mock("@/features/auth/workspace-revalidation", () => ({ revalidateWorkspacePaths: mocks.revalidate }));
vi.mock("@dofe-agent/db", () => ({
  createWorkflowDefinitionSync: vi.fn(),
  readWorkflowDefinitionSync: mocks.readDefinition,
  readWorkflowRunSync: vi.fn(),
  updateWorkflowDraftSync: mocks.updateDraft,
  upsertWorkflowTriggerSync: vi.fn(),
}));
vi.mock("@dofe-agent/services", () => ({
  cancelWorkflowRunSync: vi.fn(),
  materializeManualWorkflowRunSync: mocks.manualRun,
  pauseWorkflowRunSync: vi.fn(),
  publishWorkflowSync: mocks.publish,
  resumeWorkflowRunSync: vi.fn(),
  retryWorkflowNodeSync: vi.fn(),
  validateWorkflowForPublishSync: vi.fn(),
}));

import { publishWorkflowAction, runWorkflowAction, updateWorkflowDraftAction } from "./workflow-actions";

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
      status: "published",
      draftVersion: 2,
      draftGraphJson: JSON.stringify(graph),
    });
    mocks.manualRun.mockReturnValue({ runId: "run-1", created: true });
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
});
