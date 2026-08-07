import { describe, expect, it } from "vitest";
import { WORKFLOW_ERROR_CODES } from "@dofe-agent/domain";
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
    "workflow_approval_employee_not_ready",
    "workflow_approval_channel_not_ready",
    "workflow_schedule_invalid",
    "workflow_schedule_in_past",
    "workflow_schedule_timezone_invalid",
    "workflow_event_invalid",
    "workflow_version_conflict",
    "workflow_manual_trigger_required",
    "workflow_trigger_duplicate",
    "workflow_budget_exceeded",
    "workflow_budget_invalid",
    "workflow_concurrency_invalid",
    "workflow_input_reference_invalid",
    "workflow_input_reference_not_upstream",
    "workflow_join_reference_missing",
    "workflow_node_retry_exhausted",
    "workflow_event_sequence_gap",
    "workflow_cross_workspace_reference",
    "workflow_run_commit_in_progress",
    "workflow_run_not_startable",
    "workflow_task_commit_conflict",
    "workflow_output_invalid",
    "workflow_output_too_large",
    "workflow_output_field_invalid",
    "workflow_output_field_unsupported",
    "workflow_task_failed",
    "workflow_task_setup_failed",
    "workflow_runtime_offline",
    "workflow_completion_effect_uncertain",
    "workflow_node_manual_compensation_required",
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

describe("workflow error-code translations", () => {
  it.each(WORKFLOW_ERROR_CODES)("provides a non-generic translation for %s", (code) => {
    expect(translateWorkflowErrorCode(code)).not.toBe("工作流操作未完成，请稍后重试");
  });

  it.each([
    ["workflow_graph_requires_single_entry_node", "流程只能有一个起点"],
    ["workflow_graph_requires_single_terminal_node", "流程只能有一个终点"],
    ["workflow_graph_duplicate_node_id", "步骤 ID 不能重复"],
    ["workflow_graph_edge_endpoint_missing", "连接线引用了不存在的步骤"],
    ["workflow_graph_isolated_node", "存在未连接到主流程的步骤"],
    ["workflow_node_unreachable", "存在无法从起点到达的步骤"],
  ])("translates %s", (code, expected) => {
    expect(translateWorkflowErrorCode(code)).toBe(expected);
  });
});
