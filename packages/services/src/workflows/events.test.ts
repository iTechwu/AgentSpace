import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkflowEventInput, workflowTriggerMatchesEvent } from "./events.ts";

test("normalizes a bounded workflow event envelope", () => {
  assert.deepEqual(normalizeWorkflowEventInput({
    workspaceId: " workspace-1 ",
    eventName: "task.completed",
    eventId: "event-123",
    input: { taskId: "task-1" },
  }), {
    workspaceId: "workspace-1",
    eventName: "task.completed",
    eventId: "event-123",
    input: { taskId: "task-1" },
  });
});

test("rejects malformed or oversized workflow events", () => {
  assert.throws(() => normalizeWorkflowEventInput({ workspaceId: "w", eventName: "contains spaces", eventId: "1" }), /workflow_event_invalid/);
  assert.throws(() => normalizeWorkflowEventInput({ workspaceId: "w", eventName: "task.created", eventId: "1" }), /workflow_event_invalid/);
  assert.throws(() => normalizeWorkflowEventInput({ workspaceId: "w", eventName: "task.completed", eventId: "x".repeat(201) }), /workflow_event_invalid/);
  assert.throws(() => normalizeWorkflowEventInput({ workspaceId: "w", eventName: "task.completed", eventId: "1", input: { data: "x".repeat(65_537) } }), /workflow_event_payload_too_large/);
});

test("matches only active event triggers with the exact configured name", () => {
  const trigger = {
    type: "event" as const,
    status: "active",
    configJson: '{"eventName":"task.completed"}',
  };
  assert.equal(workflowTriggerMatchesEvent(trigger, "task.completed"), true);
  assert.equal(workflowTriggerMatchesEvent(trigger, "task.created"), false);
  assert.equal(workflowTriggerMatchesEvent({ ...trigger, status: "paused" }, "task.completed"), false);
  assert.equal(workflowTriggerMatchesEvent({ ...trigger, configJson: "{" }, "task.completed"), false);
});
