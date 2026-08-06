import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDatabase,
  mockListWorkflowDefinitionsSync,
  mockListWorkflowRunsSync,
  mockListWorkspaceMemberUsersSync,
  mockReadCutoverMode,
  mockReadWorkspaceState,
} = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockListWorkflowDefinitionsSync: vi.fn(),
  mockListWorkflowRunsSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockReadCutoverMode: vi.fn(),
  mockReadWorkspaceState: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  getDatabase: mockGetDatabase,
  listWorkflowDefinitionsSync: mockListWorkflowDefinitionsSync,
  listWorkflowRunsSync: mockListWorkflowRunsSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
}));
vi.mock("@dofe-agent/services", () => ({
  readWorkflowCutoverModeSync: mockReadCutoverMode,
  readWorkspaceStateSnapshotSync: mockReadWorkspaceState,
  shouldReadLegacyWorkflowSources: (mode: string) => mode === "legacy_only" || mode === "dual_read",
}));

import { getWorkflowCenterPageData } from "./workflow-data";

describe("getWorkflowCenterPageData", () => {
  beforeEach(() => {
    mockListWorkflowDefinitionsSync.mockReset();
    mockListWorkflowRunsSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockGetDatabase.mockReset();
    mockReadCutoverMode.mockReset();
    mockReadWorkspaceState.mockReset();
    mockReadCutoverMode.mockReturnValue("legacy_archived");
    mockReadWorkspaceState.mockReturnValue({ automationRules: [] });
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
        sourceKind: "workflow",
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

  it("adds one sanitized migration row for an unmapped legacy automation in dual-read mode", () => {
    mockReadCutoverMode.mockReturnValue("dual_read");
    mockReadWorkspaceState.mockReturnValue({
      automationRules: [{
        id: "legacy-rule-1",
        name: "Legacy webhook",
        enabled: true,
        trigger: { type: "message_received", config: { token: "never-returned" } },
        actions: [{ type: "webhook", config: { secret: "never-returned" } }],
        createdBy: "owner-1",
      }],
    });

    const data = getWorkflowCenterPageData("default");
    const legacy = data.workflows.find((item) => item.legacySourceId === "legacy-rule-1");
    expect(legacy).toMatchObject({
      name: "Legacy webhook",
      sourceKind: "legacy",
      migrationStatus: "needs_migration",
      triggerLabelCode: "event",
    });
    expect(JSON.stringify(legacy)).not.toContain("never-returned");
  });

  it("projects only stable trigger outcome codes into workflow summaries", () => {
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => sql.includes("FROM audit_log") ? [
          {
            workflowId: "workflow-daily",
            code: "workflow.trigger.materialization_failed",
            createdAt: "2026-08-07T04:00:00.000Z",
            reasonCode: "sensitive-database-message",
          },
          { workflowId: "workflow-daily", code: "unrecognized.code", createdAt: "2026-08-07T05:00:00.000Z" },
        ] : []),
      })),
    });

    const data = getWorkflowCenterPageData("default");

    expect(data.workflows[0]?.lastTriggerOutcome).toEqual({
      code: "workflow.trigger.materialization_failed",
      createdAt: "2026-08-07T04:00:00.000Z",
    });
    expect(JSON.stringify(data)).not.toContain("sensitive-database-message");
  });

  it("preserves a suspended schedule trigger when the workflow is paused", () => {
    mockListWorkflowDefinitionsSync.mockImplementation(() => [{
      id: "workflow-daily",
      workspaceId: "default",
      name: "Daily brief",
      ownerUserId: "owner-1",
      status: "paused",
      draftGraphJson: '{"schemaVersion":1,"nodes":[],"edges":[]}',
      draftVersion: 1,
      createdBy: "owner-1",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    }]);
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => sql.includes("FROM workflow_trigger") ? [{
          workflowId: "workflow-daily",
          type: "schedule",
          nextFireAt: "2026-08-08T01:00:00.000Z",
        }] : []),
      })),
    });

    const workflow = getWorkflowCenterPageData("default").workflows[0];

    expect(workflow).toMatchObject({
      status: "paused",
      triggerLabelCode: "schedule",
      nextFireAt: "2026-08-08T01:00:00.000Z",
    });
  });
});
