import { describe, expect, it } from "vitest";
import type { TaskMessageRecord } from "@dofe-agent/db";
import { buildExecutionTimeline } from "@/features/chat/task-execution-timeline";

const LABELS = { thinking: "思考过程" };

function taskMessage(overrides: Partial<TaskMessageRecord> & { seq: number; type: string }): TaskMessageRecord {
  return {
    id: `task-msg-${overrides.seq}`,
    taskId: "task-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildExecutionTimeline", () => {
  it("maps status rows to plain status items and skips empty ones", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "status", content: "正在准备执行环境" }),
        taskMessage({ seq: 2, type: "status", content: "  " }),
      ],
      LABELS,
    );

    expect(items).toEqual([
      { id: "task-msg-1", kind: "status", title: "正在准备执行环境", status: "done" },
    ]);
  });

  it("keeps each thinking event as its own item and marks only the trailing one running", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "thinking", content: "先搜索相关代码" }),
        taskMessage({ seq: 2, type: "thinking", content: "定位问题根源" }),
        taskMessage({ seq: 3, type: "tool_use", tool: "Grep", inputJson: JSON.stringify({ pattern: "seedance" }) }),
        taskMessage({ seq: 4, type: "thinking", content: "再确认路由层" }),
      ],
      LABELS,
    );

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "thinking", detail: "先搜索相关代码", status: "done" });
    expect(items[1]).toMatchObject({ kind: "thinking", detail: "定位问题根源", status: "done" });
    expect(items[2]).toMatchObject({ kind: "tool", title: "Grep", subtitle: "seedance", status: "running" });
    expect(items[3]).toMatchObject({ kind: "thinking", detail: "再确认路由层", status: "running" });
  });

  it("pairs tool_result with the matching open tool_use and appends the output", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({
          seq: 1,
          type: "tool_use",
          tool: "Shell",
          inputJson: JSON.stringify({ command: 'grep -n "seedance" database/model.sql' }),
        }),
        taskMessage({ seq: 2, type: "tool_use", tool: "Grep", inputJson: JSON.stringify({ pattern: "seedance" }) }),
        taskMessage({ seq: 3, type: "tool_result", tool: "Shell", output: "12 rows matched" }),
        taskMessage({ seq: 4, type: "tool_result", tool: "Grep", output: "src/a.ts:3" }),
      ],
      LABELS,
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "tool",
      title: "Shell",
      subtitle: 'grep -n "seedance" database/model.sql',
      status: "done",
    });
    expect(items[0].detail).toBe('grep -n "seedance" database/model.sql\n\n12 rows matched');
    expect(items[1]).toMatchObject({ kind: "tool", title: "Grep", status: "done" });
    expect(items[1].detail).toContain("src/a.ts:3");
  });

  it("keeps a tool running when its result has not arrived and surfaces orphan results as finished items", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "tool_result", tool: "Grep", output: "orphan" }),
        taskMessage({ seq: 2, type: "tool_use", tool: "Read", inputJson: JSON.stringify({ file_path: "video-capability-presets.ts" }) }),
      ],
      LABELS,
    );

    expect(items).toEqual([
      { id: "task-msg-1", kind: "tool", title: "Grep", detail: "orphan", status: "done" },
      {
        id: "task-msg-2",
        kind: "tool",
        title: "Read",
        subtitle: "video-capability-presets.ts",
        detail: JSON.stringify({ file_path: "video-capability-presets.ts" }, null, 2),
        status: "running",
      },
    ]);
  });

  it("settles leftover running items when the task is no longer running", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "tool_use", tool: "Shell", inputJson: JSON.stringify({ command: "ls" }) }),
        taskMessage({ seq: 2, type: "thinking", content: "收尾" }),
      ],
      LABELS,
      { taskRunning: false },
    );

    expect(items.every((item) => item.status !== "running")).toBe(true);
    expect(items[1]).toMatchObject({ kind: "thinking", status: "done" });
  });

  it("pairs a tool_result with the most recent open call when names drift", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "tool_use", tool: "Read", inputJson: JSON.stringify({ file_path: "a.ts" }) }),
        taskMessage({ seq: 2, type: "tool_result", tool: "tool", output: "file body" }),
      ],
      LABELS,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Read", status: "done" });
    expect(items[0].detail).toContain("file body");
  });

  it("renders narration rows as plain visible items, distinct from thinking", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "narration", content: "我先搜索相关代码，定位问题根源。" }),
        taskMessage({ seq: 2, type: "thinking", content: "真正的推理过程" }),
      ],
      LABELS,
    );

    expect(items).toEqual([
      { id: "task-msg-1", kind: "narration", title: "我先搜索相关代码，定位问题根源。", status: "done" },
      { id: "task-msg-2", kind: "thinking", title: "思考过程", detail: "真正的推理过程", status: "running" },
    ]);
  });

  it("pairs tool results by refId before falling back to tool name", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "tool_use", tool: "exec_command", refId: "cmd-1", inputJson: JSON.stringify({ command: "ls /tmp" }) }),
        taskMessage({ seq: 2, type: "tool_use", tool: "exec_command", refId: "cmd-2", inputJson: JSON.stringify({ command: "ls /var" }) }),
        taskMessage({ seq: 3, type: "tool_result", tool: "exec_command", refId: "cmd-2", output: "var listing" }),
        taskMessage({ seq: 4, type: "tool_result", tool: "exec_command", refId: "cmd-1", output: "tmp listing" }),
      ],
      LABELS,
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ refId: "cmd-1", subtitle: "ls /tmp", status: "done" });
    expect(items[0].detail).toContain("tmp listing");
    expect(items[1]).toMatchObject({ refId: "cmd-2", subtitle: "ls /var", status: "done" });
    expect(items[1].detail).toContain("var listing");
  });

  it("skips text rows (final reply) and surfaces error rows as error items", () => {
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "text", content: "CODEX-0801-OK" }),
        taskMessage({ seq: 2, type: "error", content: "provider.empty_response" }),
      ],
      LABELS,
    );

    expect(items).toEqual([
      { id: "task-msg-2", kind: "error", title: "provider.empty_response", status: "error" },
    ]);
  });

  it("truncates long subtitles and falls back to content when input has no known field", () => {
    const longCommand = `run ${"x".repeat(200)}`;
    const items = buildExecutionTimeline(
      [
        taskMessage({ seq: 1, type: "tool_use", tool: "Shell", inputJson: JSON.stringify({ command: longCommand }) }),
        taskMessage({ seq: 2, type: "tool_use", tool: "Custom", inputJson: JSON.stringify({ foo: 1 }), content: "do the thing" }),
      ],
      LABELS,
    );

    expect(items[0].subtitle).toHaveLength(80);
    expect(items[0].subtitle?.endsWith("…")).toBe(true);
    expect(items[1].subtitle).toBe("do the thing");
    expect(items[1].detail).toBe(JSON.stringify({ foo: 1 }, null, 2));
  });
});
