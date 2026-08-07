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

test("extracts designated reviewer and risk level from the node config", () => {
  assert.deepEqual(workflowApprovalInputFromNodeConfig({
    employeeId: "emp-1",
    channelName: "项目审批群",
    reviewerUserId: " user-9 ",
    risk: "high",
  }), {
    employeeId: "emp-1",
    channelName: "项目审批群",
    contentPreview: "请审批此工作流步骤的上游交付结果。",
    reviewerUserId: "user-9",
    risk: "high",
  });
});

test("ignores invalid risk values in the approval node config", () => {
  assert.equal(workflowApprovalInputFromNodeConfig({
    employeeId: "emp-1",
    channelName: "项目审批群",
    risk: "critical",
  }).risk, undefined);
});

test("parses the approval deadline from number or string seconds", () => {
  assert.equal(workflowApprovalInputFromNodeConfig({
    employeeId: "emp-1",
    channelName: "项目审批群",
    deadlineSeconds: 3600,
  }).deadlineSeconds, 3600);
  assert.equal(workflowApprovalInputFromNodeConfig({
    employeeId: "emp-1",
    channelName: "项目审批群",
    deadlineSeconds: "7200",
  }).deadlineSeconds, 7200);
});

test("rejects out-of-range or non-finite approval deadlines", () => {
  for (const invalid of [0, -1, 30 * 24 * 60 * 60 + 1, NaN, "", "abc", null]) {
    assert.equal(workflowApprovalInputFromNodeConfig({
      employeeId: "emp-1",
      channelName: "项目审批群",
      deadlineSeconds: invalid as unknown as number,
    }).deadlineSeconds, undefined);
  }
});
