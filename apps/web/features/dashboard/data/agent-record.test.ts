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
  it("does not let historical failed work mark a healthy employee as blocked", () => {
    expect(statusForWorkspaceAgent(
      [task("blocked")],
      [
        workArea({ queueStatus: "failed", taskStatus: "blocked", updatedAtEpochMs: 100 }),
      ],
      [],
      employeeName,
      "linked",
    )).toBe("online");
  });

  it("keeps a terminal queue failure in execution history without blocking the employee", () => {
    expect(statusForWorkspaceAgent(
      [],
      [workArea({ queueStatus: "failed", updatedAtEpochMs: 200 })],
      [],
      employeeName,
      "linked",
    )).toBe("online");
  });

  it("reports an active execution as busy", () => {
    expect(statusForWorkspaceAgent(
      [],
      [workArea({ queueStatus: "running", updatedAtEpochMs: 200 })],
      [],
      employeeName,
      "linked",
    )).toBe("busy");
  });

  it("reports an unavailable execution engine as an error", () => {
    expect(statusForWorkspaceAgent(
      [],
      [workArea({ queueStatus: "failed", updatedAtEpochMs: 200 })],
      [],
      employeeName,
      "error",
    )).toBe("error");
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
