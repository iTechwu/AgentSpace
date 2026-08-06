import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDatabase,
  mockListWorkflowDefinitionsSync,
  mockListWorkflowRunsSync,
  mockListWorkspaceMemberUsersSync,
} = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockListWorkflowDefinitionsSync: vi.fn(),
  mockListWorkflowRunsSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  getDatabase: mockGetDatabase,
  listWorkflowDefinitionsSync: mockListWorkflowDefinitionsSync,
  listWorkflowRunsSync: mockListWorkflowRunsSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
}));

import { getWorkflowCenterPageData } from "./workflow-data";

describe("getWorkflowCenterPageData", () => {
  beforeEach(() => {
    mockListWorkflowDefinitionsSync.mockReset();
    mockListWorkflowRunsSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockGetDatabase.mockReset();
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    });
    mockListWorkflowDefinitionsSync.mockImplementation((workspaceId: string) =>
      workspaceId === "default"
        ? [
            {
              id: "workflow-daily",
              workspaceId: "default",
              name: "Daily brief",
              ownerUserId: "owner-1",
              status: "published",
              draftGraphJson: JSON.stringify({
                schemaVersion: 1,
                nodes: [
                  { id: "start", type: "employee_task", employeeId: "employee-1", config: {} },
                  { id: "approval", type: "approval", config: {} },
                  { id: "join", type: "join", config: {} },
                ],
                edges: [],
              }),
              draftVersion: 1,
              createdBy: "owner-1",
              createdAt: "2026-08-06T00:00:00.000Z",
              updatedAt: "2026-08-06T00:00:00.000Z",
            },
          ]
        : [
            {
              id: "workflow-secret",
              workspaceId: "other",
              name: "Secret flow",
              ownerUserId: "owner-2",
              status: "published",
              draftGraphJson: '{"secretRef":"never-returned"}',
              draftVersion: 1,
              createdBy: "owner-2",
              createdAt: "2026-08-06T00:00:00.000Z",
              updatedAt: "2026-08-06T00:00:00.000Z",
            },
          ],
    );
    mockListWorkflowRunsSync.mockReturnValue([
      {
        id: "run-daily",
        workspaceId: "default",
        workflowId: "workflow-daily",
        versionId: "version-1",
        triggerType: "schedule",
        triggerKey: "daily:1",
        inputJson: '{"secret":"never-returned"}',
        status: "succeeded",
        currentSequence: 1,
        budgetJson: "{}",
        createdBy: "owner-1",
        createdAt: "2026-08-06T01:00:00.000Z",
        updatedAt: "2026-08-06T01:00:00.000Z",
        finishedAt: "2026-08-06T01:01:00.000Z",
      },
    ]);
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      { userId: "owner-1", displayName: "Owner One", primaryEmail: "owner@example.com", role: "owner" },
    ]);
  });

  it("returns workspace-scoped workflow summaries without graph or run payloads", () => {
    const data = getWorkflowCenterPageData("default");

    expect(mockListWorkflowDefinitionsSync).toHaveBeenCalledWith("default");
    expect(mockListWorkflowRunsSync).toHaveBeenCalledWith("default", 500);
    expect(data.workflows).toEqual([
      {
        id: "workflow-daily",
        name: "Daily brief",
        status: "published",
        ownerLabel: "Owner One",
        triggerLabelCode: "manual",
        topology: {
          employeeNodeCount: 1,
          parallelGroupCount: 1,
          hasApproval: true,
        },
        latestRun: {
          id: "run-daily",
          status: "succeeded",
          finishedAt: "2026-08-06T01:01:00.000Z",
        },
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("draftGraphJson");
    expect(JSON.stringify(data)).not.toContain("never-returned");
  });
});
