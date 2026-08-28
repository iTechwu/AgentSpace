import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDatabase,
  mockListWorkflowDefinitionsSync,
  mockListWorkflowRunsSync,
  mockListWorkflowRunsPageSnapshotSync,
  mockListWorkflowRunsAfterCursorSync,
  mockListWorkspaceMemberUsersSync,
  mockReadCutoverMode,
  mockReadWorkspaceState,
} = vi.hoisted(() => ({
  mockGetDatabase: vi.fn(),
  mockListWorkflowDefinitionsSync: vi.fn(),
  mockListWorkflowRunsSync: vi.fn(),
  mockListWorkflowRunsPageSnapshotSync: vi.fn(),
  mockListWorkflowRunsAfterCursorSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockReadCutoverMode: vi.fn(),
  mockReadWorkspaceState: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  getDatabase: mockGetDatabase,
  listWorkflowDefinitionsSync: mockListWorkflowDefinitionsSync,
  listWorkflowRunsSync: mockListWorkflowRunsSync,
  listWorkflowRunsPageSnapshotSync: mockListWorkflowRunsPageSnapshotSync,
  listWorkflowRunsAfterCursorSync: mockListWorkflowRunsAfterCursorSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
}));
vi.mock("@dofe-agent/services", () => ({
  readWorkflowCutoverModeSync: mockReadCutoverMode,
  readWorkspaceStateSnapshotSync: mockReadWorkspaceState,
  shouldReadLegacyWorkflowSources: (mode: string) => mode === "legacy_only" || mode === "dual_read",
}));

import {
  decodeWorkflowRunCursor,
  encodeWorkflowRunCursor,
  getWorkflowCenterPageData,
  getWorkflowRunsPageSync,
} from "./workflow-data";

describe("getWorkflowCenterPageData", () => {
  beforeEach(() => {
    mockListWorkflowDefinitionsSync.mockReset();
    mockListWorkflowRunsSync.mockReset();
    mockListWorkflowRunsPageSnapshotSync.mockReset();
    mockListWorkflowRunsAfterCursorSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockGetDatabase.mockReset();
    mockReadCutoverMode.mockReset();
    mockReadWorkspaceState.mockReset();
    mockReadCutoverMode.mockReturnValue("legacy_archived");
    mockReadWorkspaceState.mockReturnValue({ automationRules: [] });
    mockListWorkflowRunsPageSnapshotSync.mockReturnValue({ runs: [], total: 0, snapshotSequence: "0" });
    mockListWorkflowRunsAfterCursorSync.mockReturnValue([]);
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
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => sql.includes("FROM workflow_trigger") ? [{
          workflowId: "workflow-daily",
          type: "manual",
          status: "active",
          updatedAt: "2026-08-06T00:00:00.000Z",
        }] : []),
      })),
    });
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

  it("projects the recent run history across workflows in recency order", () => {
    mockListWorkflowRunsSync.mockReturnValue([
      {
        id: "run-newer",
        workflowId: "workflow-daily",
        triggerType: "manual",
        status: "failed",
        createdAt: "2026-08-06T03:00:00.000Z",
        finishedAt: "2026-08-06T03:05:00.000Z",
      },
      {
        id: "run-daily",
        workflowId: "workflow-daily",
        triggerType: "schedule",
        status: "succeeded",
        createdAt: "2026-08-06T01:00:00.000Z",
        finishedAt: "2026-08-06T01:01:00.000Z",
      },
    ]);
    // recentRuns 首页由单条 SQL 的列表与总数快照产出。
    mockListWorkflowRunsPageSnapshotSync.mockReturnValue({
      runs: mockListWorkflowRunsSync(),
      total: 2,
      snapshotSequence: "20",
    });

    const { recentRuns } = getWorkflowCenterPageData("default");

    expect(recentRuns).toHaveLength(2);
    expect(recentRuns[0]).toMatchObject({ id: "run-newer", status: "failed", workflowName: "Daily brief" });
    expect(recentRuns[1]).toMatchObject({ id: "run-daily", status: "succeeded" });
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
        ] : sql.includes("FROM workflow_trigger") ? [{
          workflowId: "workflow-daily",
          type: "schedule",
          updatedAt: "2026-08-07T03:00:00.000Z",
        }] : []),
      })),
    });

    const data = getWorkflowCenterPageData("default");

    expect(data.workflows[0]?.lastTriggerOutcome).toEqual({
      code: "workflow.trigger.materialization_failed",
      createdAt: "2026-08-07T04:00:00.000Z",
    });
    expect(JSON.stringify(data)).not.toContain("sensitive-database-message");
  });

  it("hides an obsolete trigger failure after the trigger advances", () => {
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => sql.includes("FROM audit_log") ? [{
          workflowId: "workflow-daily",
          code: "workflow.trigger.materialization_failed",
          createdAt: "2026-08-07T04:00:00.000Z",
        }] : sql.includes("FROM workflow_trigger") ? [{
          workflowId: "workflow-daily",
          type: "schedule",
          updatedAt: "2026-08-07T05:00:00.000Z",
        }] : []),
      })),
    });

    expect(getWorkflowCenterPageData("default").workflows[0]?.lastTriggerOutcome).toBeUndefined();
  });

  it("limits trigger outcomes only after selecting the latest row per workflow", () => {
    const observedSql: string[] = [];
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        observedSql.push(sql);
        return { all: vi.fn(() => []) };
      }),
    });

    getWorkflowCenterPageData("default");

    const auditSql = observedSql.find((sql) => sql.includes("FROM audit_log"));
    expect(auditSql).toContain("PARTITION BY data_json ->> 'workflowId'");
    expect(auditSql).toMatch(/outcome_rank\s*=\s*1[\s\S]*LIMIT 1000/);
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
          updatedAt: "2026-08-07T00:00:00.000Z",
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

describe("getWorkflowRunsPageSync", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_SECRET = "workflow-run-cursor-test-secret";
    delete process.env.WORKFLOW_RUN_CURSOR_SECRET;
    delete process.env.WORKFLOW_RUN_CURSOR_PREVIOUS_SECRET;
    delete process.env.WORKFLOW_RUN_CURSOR_KEY_ID;
    delete process.env.WORKFLOW_RUN_CURSOR_PREVIOUS_KEY_ID;
    mockListWorkflowDefinitionsSync.mockReset();
    mockListWorkflowRunsPageSnapshotSync.mockReset();
    mockListWorkflowRunsAfterCursorSync.mockReset();
    mockListWorkflowRunsPageSnapshotSync.mockReturnValue({ runs: [], total: 0, snapshotSequence: "0" });
    mockListWorkflowDefinitionsSync.mockReturnValue([
      { id: "workflow-daily", name: "Daily brief" },
    ]);
  });

  it("paginates runs by keyset cursor and reports total/hasMore/nextCursor", () => {
    // 运行历史游标分页（UIUX:运行历史分页）：按 (created_at DESC, id DESC) keyset 推进；
    // 取 limit+1 判定 hasMore，nextCursor 指向本页最后一条。全集：run-c > run-b > run-a。
    const all = [
      { id: "run-c", workflowId: "workflow-daily", triggerType: "schedule", status: "succeeded", createdAt: "2026-08-06T03:00:00.000Z" },
      { id: "run-b", workflowId: "workflow-daily", triggerType: "schedule", status: "failed", createdAt: "2026-08-06T02:00:00.000Z" },
      { id: "run-a", workflowId: "workflow-daily", triggerType: "schedule", status: "succeeded", createdAt: "2026-08-06T01:00:00.000Z" },
    ];
    mockListWorkflowRunsPageSnapshotSync.mockImplementation((_ws: string, limit: number) => ({
      runs: all.slice(0, limit),
      total: 3,
      snapshotSequence: "30",
    }));
    mockListWorkflowRunsAfterCursorSync.mockImplementation((_ws: string, cursor: { createdAt: string; id: string; snapshotSequence?: string } | null, limit: number) => {
      if (!cursor) throw new Error("first page must use the atomic snapshot query");
      const idx = all.findIndex((run) => run.createdAt === cursor.createdAt && run.id === cursor.id);
      return idx < 0 ? [] : all.slice(idx + 1, idx + 1 + limit);
    });
    const first = getWorkflowRunsPageSync("default", { limit: 2 });
    // 取 limit+1=3 条 → hasMore=true，首页返回 run-c, run-b，nextCursor 指向 run-b。
    expect(mockListWorkflowRunsPageSnapshotSync).toHaveBeenCalledWith("default", 3);
    expect(first.runs.map((run) => run.id)).toEqual(["run-c", "run-b"]);
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);
    const firstCursor = decodeWorkflowRunCursor(first.nextCursor, "default");
    expect(firstCursor).toEqual({
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotSequence: "30",
      snapshotTotal: 3,
    });
    const wireCursor = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(wireCursor).toMatchObject({
      version: 3,
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotCount: 3,
    });
    expect(wireCursor).not.toHaveProperty("snapshotTotal");
    expect(typeof wireCursor.signature).toBe("string");
    const tamperedCursor = Buffer.from(JSON.stringify({
      ...wireCursor,
      snapshotCount: 999,
    }), "utf8").toString("base64url");
    expect(decodeWorkflowRunCursor(tamperedCursor, "default")).toBeNull();

    const next = getWorkflowRunsPageSync("default", { limit: 2, cursor: first.nextCursor });
    // 从 run-b 之后取 3 条 → 只剩 run-a（1 条）→ hasMore=false，无下一游标。
    expect(next.runs.map((run) => run.id)).toEqual(["run-a"]);
    expect(next.total).toBe(3);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
    expect(mockListWorkflowRunsPageSnapshotSync).toHaveBeenCalledTimes(1);
  });

  it("resets to the first page with cursorReset instead of trusting an unsigned 114 cursor", () => {
    const legacyCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotTotal: 3,
    }), "utf8").toString("base64url");
    const page = getWorkflowRunsPageSync("default", { limit: 1, cursor: legacyCursor });
    expect(page.cursorReset).toBe(true);
    // 旧协议游标回退首页：用原子快照重新取首页，且不沿旧游标续拉。
    expect(mockListWorkflowRunsAfterCursorSync).not.toHaveBeenCalled();
    expect(mockListWorkflowRunsPageSnapshotSync).toHaveBeenCalledWith("default", 2);
  });

  it("resets to the first page for an unsigned 115 sequence cursor", () => {
    const legacyCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotSequence: "30",
    }), "utf8").toString("base64url");

    expect(decodeWorkflowRunCursor(legacyCursor, "default")).toEqual({
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotSequence: "30",
    });
    const page = getWorkflowRunsPageSync("default", { limit: 1, cursor: legacyCursor });
    expect(page.cursorReset).toBe(true);
  });

  it("requires every snapshot boundary field when encoding a signed cursor", () => {
    // @ts-expect-error 编码 API 在编译期也必须拒绝缺少 snapshotSequence 的输入。
    expect(() => encodeWorkflowRunCursor({
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotTotal: 3,
    }, "default")).toThrow("workflow_run_cursor_snapshot_required");
  });

  it("accepts a v2 cursor signed with the configured previous cursor secret", () => {
    process.env.WORKFLOW_RUN_CURSOR_SECRET = "cursor-current-secret";
    process.env.WORKFLOW_RUN_CURSOR_PREVIOUS_SECRET = "cursor-previous-secret";
    const payload = {
      version: 2,
      workspaceId: "default",
      createdAt: "2026-08-06T02:00:00.000Z",
      id: "run-b",
      snapshotTotal: 3,
      snapshotSequence: "30",
    };
    const signature = createHmac("sha256", "cursor-previous-secret")
      .update(JSON.stringify(payload), "utf8")
      .digest("base64url");
    const cursor = Buffer.from(JSON.stringify({ ...payload, keyId: "previous", signature }), "utf8").toString("base64url");

    expect(decodeWorkflowRunCursor(cursor, "default")).toEqual({
      createdAt: payload.createdAt,
      id: payload.id,
      snapshotSequence: payload.snapshotSequence,
      snapshotTotal: payload.snapshotTotal,
    });
  });

  it("clamps limit into the supported range", () => {
    getWorkflowRunsPageSync("default", { limit: 9999 });
    // limit 被 clamp 到 200，取数按 limit+1=201。
    expect(mockListWorkflowRunsPageSnapshotSync).toHaveBeenCalledWith("default", 201);
  });

  it("treats malformed cursor input as the first page", () => {
    // 数据层对非法游标宽容（decode 返回 null → 视为首页）；route 层负责对非法游标返回 400。
    getWorkflowRunsPageSync("default", { limit: 10, cursor: "not-valid-base64" });
    expect(mockListWorkflowRunsPageSnapshotSync).toHaveBeenCalledWith("default", 11);

    const invalidTimestamp = Buffer.from(JSON.stringify({
      createdAt: "not-a-timestamp",
      id: "run-a",
      snapshotSequence: "1",
    }), "utf8").toString("base64url");
    const overflowingSequence = Buffer.from(JSON.stringify({
      createdAt: "2026-08-06T01:00:00.000Z",
      id: "run-a",
      snapshotSequence: "9223372036854775808",
    }), "utf8").toString("base64url");
    expect(decodeWorkflowRunCursor(invalidTimestamp)).toBeNull();
    expect(decodeWorkflowRunCursor(overflowingSequence)).toBeNull();
  });
});
