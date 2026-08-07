import assert from "node:assert/strict";
import test from "node:test";
import { workflowApprovalInputFromNodeConfig } from "./approvals.ts";

test("normalizes approval node runtime input", () => {
  assert.deepEqual(workflowApprovalInputFromNodeConfig({
    employeeId: " emp-1 ",
    channelName: " 项目审批群 ",
    instruction: " 请确认发布内容。 ",
  }), {
    employeeId: "emp-1",
    channelName: "项目审批群",
    contentPreview: "请确认发布内容。",
  });
});

test("rejects an approval node without an employee or channel", () => {
  assert.throws(() => workflowApprovalInputFromNodeConfig({ channelName: "项目审批群" }), /workflow_approval_employee_not_ready/);
  assert.throws(() => workflowApprovalInputFromNodeConfig({ employeeId: "emp-1" }), /workflow_approval_channel_not_ready/);
});
