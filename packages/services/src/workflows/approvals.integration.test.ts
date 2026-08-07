import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkflowDefinitionSync,
  createWorkflowRunSync,
  getDatabase,
  materializeWorkflowNodeRunsSync,
  publishWorkflowVersionSync,
  readWorkflowRunSync,
  upsertWorkspaceMembershipSync,
} from "@dofe-agent/db";
import { createWorkflowApprovalSync, reviewWorkflowApprovalSync } from "./approvals.ts";
// 审批闭环走的是遗留 workspace-state 快照（workspace_snapshot.state_json），
// createApprovalRequestSync 会校验 agentId∈activeEmployees、channel∈channels，
// 因此必须在快照里写入员工与渠道，而不是只写 workspace_employee 表。
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";

const hasTestDatabase = Boolean(
  process.env.DOFE_AGENT_TEST_DATABASE_URL_OVERRIDE
  || process.env.DOFE_AGENT_TEST_DATABASE_URL
  || process.env.DOFE_AGENT_PG_TEST_URL,
);

const REVIEWER = "approval-reviewer";
const ADMIN = "approval-admin";
const MEMBER = "approval-member";
const EMPLOYEE_ID = "approval-employee";

interface Fixture {
  workspaceId: string;
  workflowId: string;
  versionId: string;
}

/** 种入工作区、成员（指定审批人=member、管理员、普通成员）、审批员工与单审批节点工作流版本。 */
function seedFixture(): Fixture {
  const suffix = Math.random().toString(36).slice(2, 8);
  const workspaceId = `workflow-approval-auth-${suffix}`;
  const workflowId = `wf-approval-${suffix}`;
  const versionId = `wv-approval-${suffix}`;
  const now = "2026-08-07T01:00:00.000Z";
  const db = getDatabase();
  db.prepare(
    `INSERT INTO workspace (id, slug, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, workspaceId, workspaceId, REVIEWER, now, now);
  for (const userId of [REVIEWER, ADMIN, MEMBER]) {
    db.prepare(
      `INSERT INTO users (id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).run(userId, userId, now, now);
  }
  // 指定审批人本身是普通成员；管理员用于越权放行；另一名普通成员用于证明「成员但不被指定」会被拦。
  upsertWorkspaceMembershipSync({ workspaceId, userId: REVIEWER, role: "member" });
  upsertWorkspaceMembershipSync({ workspaceId, userId: ADMIN, role: "admin" });
  upsertWorkspaceMembershipSync({ workspaceId, userId: MEMBER, role: "member" });
  // 把审批挂载员工与渠道写入工作区状态快照；writeWorkspaceStateSync 同时落
  // workspace_employee 表与 state_json，使 createApprovalRequestSync 的校验通过，
  // 并以 EMPLOYEE_ID 作为员工主键供 createWorkflowApprovalSync 取用。
  const base = ensureWorkspaceStateSync(workspaceId);
  writeWorkspaceStateSync(
    {
      ...base,
      activeEmployees: [
        {
          id: EMPLOYEE_ID,
          name: "审批员工",
          role: "Agent",
          remarkName: "审批员工",
          ownerUserId: REVIEWER,
          origin: "manual",
          summary: "审批节点挂载员工",
          traits: [],
          fit: "Ready",
          skillIds: [],
          channels: ["审批群"],
          status: "active",
        },
      ],
      channels: [
        {
          name: "审批群",
          kind: "group",
          humanMemberNames: [],
          humanMembers: 0,
          employeeNames: ["审批员工"],
        },
      ],
    },
    workspaceId,
    { skipVersionCheck: true },
  );
  createWorkflowDefinitionSync({ id: workflowId, workspaceId, name: "Approval auth", ownerUserId: REVIEWER, createdBy: REVIEWER, now });
  publishWorkflowVersionSync({
    id: versionId,
    workspaceId,
    workflowId,
    graphJson: '{"schemaVersion":1,"nodes":[{"id":"approval","type":"approval","config":{"policy":"all_success"}}],"edges":[]}',
    contentHash: `sha256:${suffix}`,
    publishedBy: REVIEWER,
    now,
  });
  return { workspaceId, workflowId, versionId };
}

/** 创建一条运行并把审批节点推进到 waiting_approval，绑定指定审批人。返回审批 id。 */
function createPendingApproval(fixture: Fixture): { runId: string; approvalId: string } {
  const now = "2026-08-07T01:00:00.000Z";
  const run = createWorkflowRunSync({
    workspaceId: fixture.workspaceId,
    workflowId: fixture.workflowId,
    versionId: fixture.versionId,
    triggerType: "manual",
    triggerKey: `approval-auth:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
    inputJson: "{}",
  });
  materializeWorkflowNodeRunsSync({
    workspaceId: fixture.workspaceId,
    runId: run.id,
    nodes: [{ nodeId: "approval", nodeType: "approval" }],
  });
  const approval = createWorkflowApprovalSync({
    workspaceId: fixture.workspaceId,
    runId: run.id,
    nodeId: "approval",
    employeeId: EMPLOYEE_ID,
    channelName: "审批群",
    contentPreview: "请审批发布内容。",
    reviewerUserId: REVIEWER,
    now,
  });
  return { runId: run.id, approvalId: approval.id };
}

function cleanup(fixture: Fixture): void {
  const db = getDatabase();
  for (const userId of [REVIEWER, ADMIN, MEMBER]) {
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }
  db.prepare("DELETE FROM workspace WHERE id = ?").run(fixture.workspaceId);
}

test("approval auth closure blocks non-designated members and admits the designated reviewer and managers", {
  skip: !hasTestDatabase,
}, () => {
  const fixture = seedFixture();
  try {
    // 1) 普通成员（非指定、非管理员）审批被拒绝，审批仍处于 pending。
    const first = createPendingApproval(fixture);
    assert.throws(
      () => reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: first.approvalId, decision: "approved", actorUserId: MEMBER }),
      /workflow_approval_reviewer_unauthorized/,
    );
    assert.equal(readWorkflowRunSync(first.runId, fixture.workspaceId)?.status, "waiting_approval");

    // 2) 指定审批人放行，运行推进到终态 succeeded。
    const firstRun = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: first.approvalId, decision: "approved", actorUserId: REVIEWER });
    assert.equal(firstRun.status, "succeeded");

    // 3) 管理员（非指定）越权放行同样成功。
    const second = createPendingApproval(fixture);
    const secondRun = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: second.approvalId, decision: "approved", actorUserId: ADMIN });
    assert.equal(secondRun.status, "succeeded");
  } finally {
    cleanup(fixture);
  }
});

test("approval without a designated reviewer is open to any member", {
  skip: !hasTestDatabase,
}, () => {
  const fixture = seedFixture();
  try {
    const now = "2026-08-07T01:00:00.000Z";
    const run = createWorkflowRunSync({
      workspaceId: fixture.workspaceId,
      workflowId: fixture.workflowId,
      versionId: fixture.versionId,
      triggerType: "manual",
      triggerKey: `approval-open:${fixture.workspaceId}:${Math.random().toString(36).slice(2, 8)}`,
      inputJson: "{}",
    });
    materializeWorkflowNodeRunsSync({ workspaceId: fixture.workspaceId, runId: run.id, nodes: [{ nodeId: "approval", nodeType: "approval" }] });
    const approval = createWorkflowApprovalSync({
      workspaceId: fixture.workspaceId,
      runId: run.id,
      nodeId: "approval",
      employeeId: EMPLOYEE_ID,
      channelName: "审批群",
      contentPreview: "请审批发布内容。",
      now,
    });
    // 未指定审批人时，任意普通成员都可审批（闭环仅在设置 reviewerUserId 时生效）。
    const result = reviewWorkflowApprovalSync({ workspaceId: fixture.workspaceId, approvalId: approval.id, decision: "approved", actorUserId: MEMBER });
    assert.equal(result.status, "succeeded");
  } finally {
    cleanup(fixture);
  }
});
