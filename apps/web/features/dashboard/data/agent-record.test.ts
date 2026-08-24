import { describe, expect, it } from "vitest";
import type { AgentWorkAreaRecord } from "../data-types";
import type { ApprovalRequest, TaskRecord } from "@dofe-agent/domain/workspace";
import { statusForWorkspaceAgent } from "./agent-record";

const employeeName = "Codex";

function task(status: TaskRecord["status"]): TaskRecord {
  return { id: `task-${status}`, title: "Test", channel: "direct", assignee: employeeName, priority: "low", status };
}

function workArea(input: Pick<AgentWorkAreaRecord, "queueStatus" | "taskStatus" | "updatedAtEpochMs">): AgentWorkAreaRecord {
  return {
    id: "work-area",
    queueId: "queue",
    title: "Direct conversation",
    queueStatus: input.queueStatus,
    taskStatus: input.taskStatus,
    updatedAt: "2026-08-24 21:19:12",
    updatedAtEpochMs: input.updatedAtEpochMs,
  };
}

function pendingApproval(): ApprovalRequest {
  return {
    id: "approval-1",
    type: "runtime_tool",
    sourceId: "queue-1",
    agentId: employeeName,
    channelName: "direct",
    status: "pending",
    contentPreview: "Approve the next action",
    createdAt: "2026-08-24T13:19:12.000Z",
  };
}

describe("statusForWorkspaceAgent", () => {
  it("does not let an old blocked task override a later completed conversation", () => {
    expect(statusForWorkspaceAgent(
      [task("blocked"), task("done")],
      [
        workArea({ queueStatus: "failed", taskStatus: "blocked", updatedAtEpochMs: 100 }),
        workArea({ queueStatus: "completed", taskStatus: "done", updatedAtEpochMs: 200 }),
      ],
      [],
      employeeName,
      "linked",
    )).toBe("online");
  });

  it("keeps the employee blocked when its latest execution remains blocked", () => {
    expect(statusForWorkspaceAgent(
      [task("blocked")],
      [workArea({ queueStatus: "failed", taskStatus: "blocked", updatedAtEpochMs: 200 })],
      [],
      employeeName,
      "linked",
    )).toBe("blocked");
  });

  it("keeps a latest queue failure visible even when no legacy task is linked", () => {
    expect(statusForWorkspaceAgent(
      [],
      [workArea({ queueStatus: "failed", updatedAtEpochMs: 200 })],
      [],
      employeeName,
      "linked",
    )).toBe("blocked");
  });

  it("reports a persisted approval as awaiting confirmation", () => {
    expect(statusForWorkspaceAgent(
      [task("done")],
      [workArea({ queueStatus: "completed", taskStatus: "done", updatedAtEpochMs: 200 })],
      [pendingApproval()],
      employeeName,
      "linked",
    )).toBe("awaiting_confirmation");
  });
});
