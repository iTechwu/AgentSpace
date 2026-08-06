import { describe, expect, it } from "vitest";
import {
  translateWorkflowErrorCode,
  translateWorkflowNodeStatus,
  translateWorkflowRunStatus,
  translateWorkflowTriggerType,
} from "./presentation";

const en = (_zh: string, english: string): string => english;

describe("workflow presentation translations", () => {
  it.each([
    "workflow_graph_cycle",
    "workflow_employee_not_ready",
    "workflow_skill_not_ready",
    "workflow_channel_not_ready",
    "workflow_version_conflict",
    "workflow_trigger_duplicate",
    "workflow_budget_exceeded",
    "workflow_budget_invalid",
    "workflow_node_retry_exhausted",
    "workflow_event_sequence_gap",
    "workflow_cross_workspace_reference",
  ])("localizes the stable error code %s without exposing it", (code) => {
    const label = translateWorkflowErrorCode(code, en);
    expect(label).not.toBe(code);
    expect(label).not.toContain("workflow_");
  });

  it("uses safe fallback copy for unknown internal errors", () => {
    expect(translateWorkflowErrorCode("provider_secret_failure", en)).toBe(
      "The workflow operation did not complete. Try again later",
    );
  });

  it("localizes workflow statuses and trigger types", () => {
    expect(translateWorkflowRunStatus("waiting_approval", en)).toBe("Waiting approval");
    expect(translateWorkflowNodeStatus("retry_wait", en)).toBe("Waiting to retry");
    expect(translateWorkflowTriggerType("schedule", en)).toBe("Scheduled trigger");
  });
});
